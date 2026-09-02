# ============================================================
# push-customer-invoices.ps1
# يرفع تفاصيل فواتير المبيعات لكل زبون (آخر N يومًا) إلى Supabase
# (inventory_reports / source = ameen_customer_invoices)
# ليتمكّن الموقع من فتح فاتورة معيّنة وعرض محتوياتها (المواد/الكميات/الأسعار).
#
# سكيما الأمين المستخدمة:
#   bu000 = رأس الفاتورة (GUID, Date, Cust_Name, Total, نوع الفاتورة)
#   bi000 = أسطر الفاتورة (ParentGUID->الرأس, MatGUID->المادة, Qty, Qty2, Price, TotalPrice)
#   mt000 = المواد (Name, Unity, Unit2, Unit2Fact)
#   bt000 = أنواع الفواتير (BillType = 1 يعني فاتورة مبيعات)
#   my000 = العملات المرجعية (GUID, CurrencyISO)
#
# حمولة v2 (summary.payloadVersion = 2) تضيف ثلاثة حقول تحتاجها طبقة ذكاء
# الزبائن (src/customer-intelligence.js): customerGuid لكل فاتورة (= cu000.GUID،
# نفس معرّف تقرير الأرصدة) كي لا يُدمج زبونان يتطابق اسمهما بعد التطبيع،
# وcurrency لكل فاتورة كي لا تُجمع عملتان، وitemGuid لكل سطر لتجميع الأصناف
# بمعرّف موثوق بدل الاسم. كلها SELECT — لا كتابة على الأمين إطلاقاً.
#
# التشغيل:
#   .\tools\push-customer-invoices.ps1 -Discover     # يطبع الأعمدة وعيّنة بدون رفع (شغّله أول مرة)
#   .\tools\push-customer-invoices.ps1               # الرفع الفعلي (آخر 60 يومًا)
#   .\tools\push-customer-invoices.ps1 -PeriodDays 90
# ============================================================
param(
    [int]$PeriodDays = 60,
    [int]$MaxInvoicesPerCustomer = 200,
    [int]$MinimumIntervalMinutes = 60,
    [switch]$Discover,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\customer-invoices-push.log"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

function Write-Log($msg) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

$stateFile = Join-Path $PSScriptRoot "logs\customer-invoices-last-success.txt"
if (-not $Discover -and $MinimumIntervalMinutes -gt 0 -and (Test-Path -LiteralPath $stateFile)) {
    $lastSuccess = [datetime]::MinValue
    $stateText = (Get-Content -Raw -LiteralPath $stateFile -ErrorAction SilentlyContinue).Trim()
    if ([datetime]::TryParse($stateText, [ref]$lastSuccess)) {
        $ageMinutes = ((Get-Date).ToUniversalTime() - $lastSuccess.ToUniversalTime()).TotalMinutes
        if ($ageMinutes -ge 0 -and $ageMinutes -lt $MinimumIntervalMinutes) {
            Write-Log ("تخطي: آخر رفع ناجح منذ {0:N1} دقيقة؛ الموعد التالي بعد {1} دقيقة." -f $ageMinutes, $MinimumIntervalMinutes)
            exit 0
        }
    }
}

$connStr = Get-Setting "AMEEN_SQL_WRITE_CONNECTION_STRING"
if (-not $connStr) { $connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING" }
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "خطأ: AMEEN_SQL_WRITE_CONNECTION_STRING غير موجود."; exit 1 }

$fromDate = (Get-Date).Date.AddDays(-$PeriodDays)
$fromIso = $fromDate.ToString("yyyy-MM-dd")

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # --- اكتشاف أسماء الأعمدة المتغيّرة على bu000 (تختلف بين نسخ الأمين) ---
    function Get-Columns($table) {
        $c = $conn.CreateCommand()
        $c.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t"
        $c.Parameters.AddWithValue("@t", $table) | Out-Null
        $set = @{}
        $rd = $c.ExecuteReader()
        while ($rd.Read()) { $set[[string]$rd.GetValue(0)] = $true }
        $rd.Close()
        return $set
    }
    function Pick($set, [string[]]$names, $fallback) {
        foreach ($n in $names) { if ($set.ContainsKey($n)) { return $n } }
        return $fallback
    }

    $buCols = Get-Columns "bu000"
    $typeCol = Pick $buCols @("TypeGUID", "BillTypeGUID", "BType") $null
    $numCol  = Pick $buCols @("Number", "BillNumber", "Num", "Serial") $null
    if (-not $typeCol) { Write-Log "خطأ: ما لقيت عمود نوع الفاتورة على bu000. شغّل -Discover وابعتلي الأعمدة."; exit 1 }
    $numSel = if ($numCol) { "u.[$numCol]" } else { "CAST(u.GUID AS varchar(40))" }
    # معرّف الزبون على رأس الفاتورة: هو نفسه cu000.GUID الذي يرفعه تقرير الأرصدة
    # (ameen_customer_balances.customerGuid). بدونه كان الربط بين الفواتير
    # والأرصدة يجري بالاسم المطبَّع وحده، فزبونان يتطابق اسمهما بعد التطبيع
    # يندمجان خطأً. مرجع الربط: tools/push-supplier-obligations.ps1 (u.CustGUID = c.GUID).
    $custGuidCol = Pick $buCols @("CustGUID", "CustomerGUID", "CuGUID") $null
    $custGuidSel = if ($custGuidCol) { "LOWER(CAST(u.[$custGuidCol] AS varchar(40)))" } else { "NULL" }
    # عملة الفاتورة: مطلوبة كي لا يُجمَع دولار مع ليرة في أي تحليل لاحق.
    # my000 جدول العملات المرجعي (GUID + CurrencyISO) — لا تخمين على GUID خام.
    $currencyCol = Pick $buCols @("CurrencyGUID", "CurGUID", "MyGUID") $null
    $myCols = Get-Columns "my000"
    $currencyIsoCol = Pick $myCols @("CurrencyISO") $null
    $currencyJoin = if ($currencyCol -and $currencyIsoCol) { "LEFT JOIN my000 cur ON cur.GUID = u.[$currencyCol]" } else { "" }
    $currencyIsoSel = if ($currencyCol -and $currencyIsoCol) { "cur.[$currencyIsoCol]" } else { "NULL" }
    Write-Log "اكتشاف: نوع الفاتورة = u.$typeCol | رقم الفاتورة = $(if($numCol){$numCol}else{'(GUID)'}) | معرّف الزبون = $(if($custGuidCol){$custGuidCol}else{'(غير موجود)'}) | العملة = $(if($currencyCol -and $currencyIsoCol){$currencyCol}else{'(غير موجودة)'})"

    # اكتشاف أعمدة السعر/الإجمالي على bi000 (تختلف بين نسخ الأمين)
    $biCols = Get-Columns "bi000"
    $priceCol = Pick $biCols @("Price", "UnitPrice", "SellPrice", "PriceUnit") $null
    $totalCol = Pick $biCols @("TotalPrice", "Total", "Net", "NetTotal", "NetValue", "Value", "Amount", "SubTotal", "LineTotal") $null
    $priceSel = if ($priceCol) { "COALESCE(bi.[$priceCol],0)" } else { "0" }
    $totalSel = if ($totalCol) { "COALESCE(bi.[$totalCol],0)" } elseif ($priceCol) { "(COALESCE(bi.Qty,0)*COALESCE(bi.[$priceCol],0))" } else { "0" }
    Write-Log "اكتشاف: السعر = $(if($priceCol){$priceCol}else{'(غير موجود)'}) | إجمالي السطر = $(if($totalCol){$totalCol}else{'محسوب (كمية×سعر)'})"

    if ($Discover) {
        Write-Log "=== وضع الاكتشاف: عيّنة أحدث فاتورة مع محتوياتها ==="
        Write-Log ("أعمدة bi000: " + (($biCols.Keys | Sort-Object) -join ", "))
        $c = $conn.CreateCommand()
        $c.CommandTimeout = 180
        $c.CommandText = @"
SELECT TOP 15 $numSel AS bill_number, u.Date AS bill_date,
       LTRIM(RTRIM(COALESCE(u.Cust_Name,''))) AS customer,
       LTRIM(RTRIM(COALESCE(m.Name,''))) AS material,
       bi.Qty AS qty, $priceSel AS price, $totalSel AS line_total,
       bt.Name AS bill_type, bt.BillType AS bill_class
FROM bu000 u
JOIN bt000 bt ON bt.GUID = u.$typeCol
JOIN bi000 bi ON bi.ParentGUID = u.GUID
JOIN mt000 m  ON m.GUID = bi.MatGUID
WHERE bt.BillType IN (1, 3) AND u.Date >= @fromDate
ORDER BY u.Date DESC
"@
        $c.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null
        $rd = $c.ExecuteReader()
        $n = 0
        while ($rd.Read()) {
            $n++
            $retTag = if ([int]$rd["bill_class"] -eq 3) { " [مرتجع]" } else { "" }
            Write-Host ("  [{0}] {1} | {2} | {3} | كمية {4} × سعر {5} = {6}{7}" -f `
                $rd["bill_number"], ([datetime]$rd["bill_date"]).ToString("yyyy-MM-dd"), `
                $rd["customer"], $rd["material"], $rd["qty"], $rd["price"], $rd["line_total"], $retTag)
        }
        $rd.Close(); $conn.Close()
        Write-Log "الاكتشاف انتهى — $n سطر عيّنة. إذا الأسماء/القيم تبيّن صح، شغّل السكربت بدون -Discover."
        exit 0
    }

    # --- جلب كل أسطر فواتير المبيعات للفترة ---
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 300
    $cmd.CommandText = @"
SELECT CAST(u.GUID AS varchar(40)) AS bill_guid,
       $numSel AS bill_number,
       u.Date AS bill_date,
       LTRIM(RTRIM(COALESCE(u.Cust_Name,''))) AS customer,
       CAST(COALESCE(u.Total,0) AS decimal(18,3)) AS bill_total,
       -- الحسم والدفعة حقلان مستقلان على رأس الفاتورة، ولكلٍّ حسابه في الأمين
       -- (ItemsDiscAccGUID مقابل FPayAccGUID). TotalDisc **قيمة نقدية** لا نسبة،
       -- فلا تُضرب بالإجمالي. Total إجمالي قبل الحسم (مؤكَّد: Total = مجموع
       -- الأسطر بالضبط رغم وجود TotalDisc). أثر الفاتورة على حساب الزبون =
       -- Total − TotalDisc − FirstPay.
       CAST(COALESCE(u.TotalDisc,0) AS decimal(18,3)) AS bill_discount,
       CAST(COALESCE(u.FirstPay,0)  AS decimal(18,3)) AS bill_first_pay,
       bt.BillType AS bill_type,
       $custGuidSel AS customer_guid,
       $currencyIsoSel AS currency_iso,
       LOWER(CAST(m.GUID AS varchar(40))) AS item_guid,
       LTRIM(RTRIM(COALESCE(m.Name,''))) AS material,
       CAST(COALESCE(bi.Qty,0)  AS decimal(18,3)) AS qty,
       CAST(COALESCE(bi.Qty2,0) AS decimal(18,3)) AS qty2,
       CAST($priceSel AS decimal(18,3)) AS price,
       CAST($totalSel AS decimal(18,3)) AS line_total,
       LTRIM(RTRIM(COALESCE(m.Unity,''))) AS unit1,
       LTRIM(RTRIM(COALESCE(m.Unit2,''))) AS unit2,
       CAST(COALESCE(m.Unit2Fact,0) AS decimal(18,3)) AS unit2_fact
FROM bu000 u
JOIN bt000 bt ON bt.GUID = u.$typeCol
JOIN bi000 bi ON bi.ParentGUID = u.GUID
JOIN mt000 m  ON m.GUID = bi.MatGUID
$currencyJoin
WHERE bt.BillType IN (1, 3)
  AND u.Date >= @fromDate
  AND LTRIM(RTRIM(COALESCE(u.Cust_Name,''))) <> ''
ORDER BY u.Date DESC, u.GUID
"@
    $cmd.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null

    # bills[guid] = @{ number,date,customer,total, lines = List }
    $bills = [ordered]@{}
    $billOrder = New-Object System.Collections.Generic.List[string]
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $g = [string]$r["bill_guid"]
        if (-not $bills.Contains($g)) {
            $billOrder.Add($g)
            $bills[$g] = @{
                number   = [string]$r["bill_number"]
                date     = ([datetime]$r["bill_date"]).ToString("yyyy-MM-dd")
                customer = [string]$r["customer"]
                customerGuid = if ($r["customer_guid"] -is [DBNull]) { "" } else { [string]$r["customer_guid"] }
                currency = if ($r["currency_iso"] -is [DBNull] -or -not $r["currency_iso"]) { "" } else { ([string]$r["currency_iso"]).Trim().ToUpper() }
                total    = [double]$r["bill_total"]
                discount = [double]$r["bill_discount"]
                payment  = [double]$r["bill_first_pay"]
                # مرتجع مبيعات (BillType=3) — نميّزه عن فاتورة البيع العادية (BillType=1)
                # ليعرضه الموقع كمستند «فاتورة مرتجع» منفصل بدل دمجه كدفعة عامة.
                isReturn = ([int]$r["bill_type"] -eq 3)
                lines    = New-Object System.Collections.Generic.List[object]
            }
        }
        $f = [double]$r["unit2_fact"]
        $qtyUnits = if ($f -gt 0) { [math]::Round(([double]$r["qty"]) / $f, 3) } else { [double]$r["qty"] }
        $bills[$g].lines.Add(@{
            itemGuid  = if ($r["item_guid"] -is [DBNull]) { "" } else { [string]$r["item_guid"] }
            material  = [string]$r["material"]
            qty       = [double]$r["qty"]
            qtyUnits  = $qtyUnits
            price     = [double]$r["price"]
            lineTotal = [double]$r["line_total"]
            unit1     = [string]$r["unit1"]
            unit2     = [string]$r["unit2"]
        })
    }
    $r.Close(); $conn.Close()

    # --- تجميع الفواتير حسب الزبون ---
    $byCustomer = @{}
    foreach ($g in $billOrder) {
        $b = $bills[$g]
        $name = $b.customer
        if (-not $byCustomer.ContainsKey($name)) { $byCustomer[$name] = New-Object System.Collections.Generic.List[object] }
        $byCustomer[$name].Add(@{
            number   = $b.number
            date     = $b.date
            # معرّف الزبون من الأمين على مستوى الفاتورة: المستهلك يقدّمه على الاسم،
            # فلا يُدمج زبونان يتطابق اسمهما بعد التطبيع ويختلف معرّفهما.
            customerGuid = $b.customerGuid
            currency = $b.currency
            guid     = $g.ToLower()   # معرّف الفاتورة في الأمين — لربطها بقيدها في دفتر الحسابات
            total    = [math]::Round($b.total, 3)
            discount = [math]::Round($b.discount, 3)
            payment  = [math]::Round($b.payment, 3)
            isReturn = $b.isReturn
            lines    = $b.lines.ToArray()
        })
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($name in @($byCustomer.Keys)) {
        $list = $byCustomer[$name].ToArray()
        $truncated = $false
        if ($list.Count -gt $MaxInvoicesPerCustomer) {
            $list = @($list | Select-Object -First $MaxInvoicesPerCustomer)
            $truncated = $true
        }
        # معرّف على مستوى المجموعة فقط إذا اتفقت كل فواتيرها عليه. اختلافها يعني
        # زبونين مختلفين باسم واحد، فيبقى معرّف المجموعة فارغاً ويعتمد المستهلك
        # على معرّف كل فاتورة — لا دمج ضمنياً بالاسم.
        $groupGuids = @($list | ForEach-Object { $_.customerGuid } | Where-Object { $_ } | Sort-Object -Unique)
        $groupGuid = if ($groupGuids.Count -eq 1) { $groupGuids[0] } else { "" }
        $items.Add(@{
            name         = $name
            customerGuid = $groupGuid
            invoices     = $list
            truncated    = $truncated
        })
    }

    Write-Log "تم تجهيز فواتير $($items.Count) زبون / $($billOrder.Count) فاتورة (من $fromIso)"

    if (-not $apiKey) { Write-Log "خطأ: TOBACCO_SUPABASE_PUBLIC_KEY غير موجود."; exit 1 }
    if (-not $syncEmail -or -not $syncPassword) { Write-Log "خطأ: TOBACCO_SYNC_EMAIL / TOBACCO_SYNC_PASSWORD غير موجودين."; exit 1 }

    # --- تسجيل الدخول إلى Supabase ---
    $loginBody = (@{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress)
    $session = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($loginBody))

    $authHeaders = @{
        apikey            = $apiKey
        Authorization     = "Bearer $($session.access_token)"
        Prefer            = "return=minimal"
        "Accept-Profile"  = "public"
        "Content-Profile" = "public"
    }

    # --- رفع التقرير ---
    $payload = @{
        source      = "ameen_customer_invoices"
        report_date = (Get-Date).ToString("yyyy-MM-dd")
        created_by  = $session.user.id
        summary     = @{
            payloadVersion = 2   # v2 = يحمل customerGuid وcurrency وitemGuid
            periodDays = $PeriodDays
            fromDate   = $fromIso
            customers  = $items.Count
            bills      = $billOrder.Count
            syncedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        items       = $items
    }
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    Write-Log ("حجم البيانات: {0:N0} حرف" -f $json.Length)
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/inventory_reports" `
        -Headers $authHeaders -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) | Out-Null

    $stateDirectory = Split-Path -Parent $stateFile
    if (-not (Test-Path -LiteralPath $stateDirectory)) { New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null }
    Set-Content -LiteralPath $stateFile -Value ((Get-Date).ToUniversalTime().ToString("o")) -Encoding ASCII
    Write-Log "تم رفع تقرير الفواتير بنجاح ✓"

    # --- حذف التقارير القديمة (أقدم من يومين) ---
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    try {
        Invoke-RestMethod -Method Delete `
            -Uri "$supabaseUrl/rest/v1/inventory_reports?source=eq.ameen_customer_invoices&created_at=lt.$cutoff" `
            -Headers $authHeaders | Out-Null
    } catch { Write-Log "تنبيه: تعذّر حذف التقارير القديمة: $($_.Exception.Message)" }

    exit 0
} catch {
    Write-Log "خطأ (سطر $($_.InvocationInfo.ScriptLineNumber)): $($_.Exception.Message)"
    try {
        $resp = $_.Exception.Response
        if ($resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $bodyText = $reader.ReadToEnd()
            if ($bodyText) { Write-Log ("رد الخادم: " + $bodyText) }
        }
    } catch {}
    if ($_.Exception.InnerException) { Write-Log ("تفصيل: " + $_.Exception.InnerException.Message) }
    exit 1
}
