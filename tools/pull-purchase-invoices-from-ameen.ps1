# ============================================================
# pull-purchase-invoices-from-ameen.ps1
# سكربت قراءة فقط: يقرأ فواتير المشتريات الحقيقية من الأمين (بلا أي تعديل أو كتابة
# على الأمين) ويرفع تقريراً جاهزاً إلى Supabase — جدول مستقل ومحمي
# ameen_purchase_invoice_reports (وليس inventory_reports العام) ليعرضه تبويب
# «فواتير المشتريات» في الموقع عبر poAmeenPanelHtml() في src/app.js.
#
# ⚠️ الجدول محمي بـRLS: قراءة فقط للمالك (purchase_invoices_is_owner())، وكتابة
# فقط لحساب المزامنة الموثوق (ameen_purchase_invoice_reports_is_sync_writer()) —
# راجع supabase/ameen-purchase-invoice-reports.sql. لا تعتمد أبداً على إخفاء
# الواجهة وحده لحماية بيانات الموردين/الأسعار/التكاليف/الدفعات الحساسة.
#
# ✅ فُعّلت مرحلة القراءة اليدوية بعد مراجعات مستقلة وموافقة المالك.
# يقرأ السكربت من الأمين فقط ويرفع تقرير العرض إلى الجدول المحمي في Supabase.
# لا يسجّل مهمة مجدولة ولا يكتب أي فاتورة أو حركة أو قيمة داخل الأمين.
#
# مصدر الحقائق المستخدمة هنا: reports/ameen-purchase-schema-discovery.md
# (اكتشاف قرائي فقط، منفّذ فعلياً ضد AmnDb002، الجولة الخامسة).
#
# التصنيف يعتمد حصراً على TypeGUID الحرفي (u.TypeGUID) — وليس عبر ربط bt000
# ولا عبر BillType/bIsInput الخام، لأن bIsInput=1 وحده يشمل أيضاً مرتجعات
# المبيعات وأنواع فتح المدة، وحتى BillType=0 وحده مشترك مع أنواع تحويل أخرى:
#   91377a56-ebfc-48c0-b79e-72063e1d7e3a = فاتورة مشتريات
#   c9aca8fe-f50e-46eb-91ac-29ee32acbb3e = مرتجع مشتريات (لا بيانات فعلية بعد)
#
# سكيما الأمين المؤكدة (من تقرير الاكتشاف، لا تخمين):
#   bu000 = رأس الفاتورة (GUID, Date, Cust_Name, Total, TypeGUID, CurrencyGUID, IsPosted)
#   bi000 = أسطر الفاتورة (ParentGUID->bu000.GUID, MatGUID->mt000.GUID, Qty, Unity,
#           Price, UnitCostPrice) — Unity هنا رقم الوحدة المُستخدمة فعلياً بالسطر
#           (1/2/3)، وليس اسمها؛ يُطابَق باسم mt000.Unity/Unit2/Unit3 حسب القيمة.
#   mt000 = المواد (Code, Name, Unity, Unit2, Unit3, Unit2Fact, Unit3Fact)
#   my000 = جدول العملات المرجعي (GUID, CurrencyISO, LatinName) — لا تخمين على GUID خام
#
# نقاط غير محسومة عمداً (موثّقة في تقرير الاكتشاف، لا تُخمَّن هنا):
#   - دلالة PayType/FirstPay (نقدي/آجل) — التقرير لم يحسمها؛ نعرضها "غير محدد" حتى
#     تُؤكَّد يدوياً بفاتورة نقدية وأخرى آجلة معروفتين في واجهة الأمين.
#   - لا يوجد عمود "آخر سعر شراء"/"سعر وسطي" مؤكَّد على mt000. بدلاً من التخمين،
#     يُحسَب آخر سعر ومتوسط السعر هنا مباشرة من أسطر الفواتير المسحوبة نفسها
#     (bi000.UnitCostPrice إن وُجد، وإلا bi000.Price). هذا الأساس هو تكلفة/سعر
#     "الوحدة الأساسية" للمادة (وليس سعر الوحدة المختارة بسطر الفاتورة bi.Unity) —
#     لذلك تُحفظ القيم بالكروز، والواجهة تحوّلها للكرتونة عبر mt000.Unit2Fact.
#     الإحصاء بمفتاح MatGUID (لا رقم/كود المادة) ويستبعد فواتير مرتجع المشتريات من المتوسط.
#
# التشغيل اليدوي:
#   .\tools\pull-purchase-invoices-from-ameen.ps1 -Discover     # طباعة الأعمدة وعيّنة بدون رفع
#   .\tools\pull-purchase-invoices-from-ameen.ps1               # الرفع الفعلي (آخر 60 يوماً)
#   .\tools\pull-purchase-invoices-from-ameen.ps1 -PeriodDays 90
# ============================================================
param(
    [int]$PeriodDays = 60,
    [int]$MaxInvoicesPerSupplier = 200,
    [switch]$Discover,
    [string]$EnvFile = "",
    [string]$LogFile = "$PSScriptRoot\logs\purchase-invoices-pull.log"
)

$ErrorActionPreference = "Stop"

# التصنيفات المؤكدة لأنواع فواتير المشتريات في الأمين (bu000.TypeGUID الحرفي)
$PURCHASE_TYPE_GUID = "91377a56-ebfc-48c0-b79e-72063e1d7e3a"
$PURCHASE_RETURN_TYPE_GUID = "c9aca8fe-f50e-46eb-91ac-29ee32acbb3e"

if ($EnvFile -and (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
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

# ملاحظة: هذا السكربت يقرأ فقط — يكفي مستخدم القراءة (tobacco_sync_reader)،
# لا حاجة لمتغيّر AMEEN_SQL_WRITE_CONNECTION_STRING إطلاقاً.
$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "خطأ: AMEEN_SQL_CONNECTION_STRING غير موجود."; exit 1 }

$fromDate = (Get-Date).Date.AddDays(-$PeriodDays)
$fromIso = $fromDate.ToString("yyyy-MM-dd")

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # --- اكتشاف أسماء الأعمدة المتغيّرة (تختلف بين نسخ الأمين) ---
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
    $currencyCol = Pick $buCols @("CurrencyGUID", "Currency", "CurGUID") $null
    $payMethodCol = Pick $buCols @("PayType", "PayMethod", "IsCash", "Cash") $null
    $paidCol = Pick $buCols @("Paid", "PaidAmount", "CashAmount", "PaidValue") $null
    $postedCol = Pick $buCols @("IsPosted") $null
    if (-not $typeCol) { Write-Log "خطأ: ما لقيت عمود نوع الفاتورة على bu000. شغّل -Discover وابعتلي الأعمدة."; exit 1 }
    $numSel = if ($numCol) { "u.[$numCol]" } else { "CAST(u.GUID AS varchar(40))" }
    $postedFilter = if ($postedCol) { "AND u.[$postedCol] = 1" } else { "" }
    Write-Log "اكتشاف: نوع الفاتورة = u.$typeCol | رقم الفاتورة = $(if($numCol){$numCol}else{'(GUID)'}) | عملة = $(if($currencyCol){$currencyCol}else{'(غير موجود)'}) | طريقة الدفع (خام، غير مفسَّرة) = $(if($payMethodCol){$payMethodCol}else{'(غير موجود)'}) | المدفوع = $(if($paidCol){$paidCol}else{'(غير موجود)'}) | ترحيل = $(if($postedCol){$postedCol}else{'(غير موجود)'})"

    # اكتشاف أعمدة السعر/التكلفة على bi000 — UnitCostPrice هو المرشَّح الأفضل
    # للمطابقة مع bu.Total (0.32% انحراف مقابل ~4273% لـPrice الخام، حسب تقرير
    # الاكتشاف)، نستخدمه هنا للقراءة/العرض فقط وليس للكتابة.
    $biCols = Get-Columns "bi000"
    $priceCol = Pick $biCols @("Price", "UnitPrice", "BuyPrice", "PriceUnit") $null
    $costCol = Pick $biCols @("UnitCostPrice") $null
    $totalCol = Pick $biCols @("TotalPrice", "Total", "Net", "NetTotal", "NetValue", "Value", "Amount", "SubTotal", "LineTotal") $null
    $priceSel = if ($priceCol) { "COALESCE(bi.[$priceCol],0)" } else { "0" }
    $costSel = if ($costCol) { "COALESCE(bi.[$costCol],0)" } else { $priceSel }
    $totalSel = if ($totalCol) { "COALESCE(bi.[$totalCol],0)" } elseif ($priceCol) { "(COALESCE(bi.Qty,0)*COALESCE(bi.[$priceCol],0))" } else { "0" }

    # اكتشاف أعمدة رقم المادة على mt000 — Code/Name مؤكَّدان من تقرير الاكتشاف
    $mtCols = Get-Columns "mt000"
    $itemNumCol = Pick $mtCols @("Code", "Number", "MatNumber", "MatCode") $null
    $itemNumSel = if ($itemNumCol) { "LTRIM(RTRIM(COALESCE(CAST(m.[$itemNumCol] AS nvarchar(50)),'')))" } else { "CAST(m.GUID AS varchar(40))" }
    Write-Log "اكتشاف: رقم المادة = $(if($itemNumCol){$itemNumCol}else{'(GUID)'}) | عمود التكلفة للسطر = $(if($costCol){$costCol}else{'(غير موجود، استُخدم Price بدلاً منه)'})"

    # اكتشاف أسماء وحدات المادة على mt000 — Unity هي الوحدة الأولى (مؤكَّدة)،
    # Unit2/Unit3 مؤكَّدتان من تقرير الاكتشاف (وليستا عمودَي تحويل، تلك
    # Unit2Fact/Unit3Fact). bi.Unity يحدّد أياً منها استُخدمت فعلياً بسطر الفاتورة.
    $unit1Col = Pick $mtCols @("Unity") $null
    $unit2Col = Pick $mtCols @("Unit2") $null
    $unit3Col = Pick $mtCols @("Unit3") $null
    $unit2FactCol = Pick $mtCols @("Unit2Fact") $null
    $unitCaseParts = New-Object System.Collections.Generic.List[string]
    if ($unit1Col) { $unitCaseParts.Add("WHEN 1 THEN LTRIM(RTRIM(COALESCE(m.[$unit1Col],'')))") }
    if ($unit2Col) { $unitCaseParts.Add("WHEN 2 THEN LTRIM(RTRIM(COALESCE(m.[$unit2Col],'')))") }
    if ($unit3Col) { $unitCaseParts.Add("WHEN 3 THEN LTRIM(RTRIM(COALESCE(m.[$unit3Col],'')))") }
    $unitSel = if ($unitCaseParts.Count -gt 0) { "(CASE bi.Unity $($unitCaseParts -join ' ') ELSE NULL END)" } else { "NULL" }
    $unit2FactSel = if ($unit2FactCol) { "CAST(COALESCE(m.[$unit2FactCol],0) AS decimal(18,3))" } else { "CAST(0 AS decimal(18,3))" }
    Write-Log "اكتشاف: وحدات المادة = $(if($unit1Col){$unit1Col}else{'—'})/$(if($unit2Col){$unit2Col}else{'—'})/$(if($unit3Col){$unit3Col}else{'—'}) | الاختيار حسب bi.Unity | معامل الكرتونة = $(if($unit2FactCol){$unit2FactCol}else{'—'})"

    # جدول العملات المرجعي (my000) — مؤكَّد من تقرير الاكتشاف: GUID + CurrencyISO
    $myCols = Get-Columns "my000"
    $currencyIsoCol = Pick $myCols @("CurrencyISO") $null
    $currencyJoin = if ($currencyCol -and $currencyIsoCol) { "LEFT JOIN my000 cur ON cur.GUID = u.[$currencyCol]" } else { "" }
    $currencyIsoSel = if ($currencyCol -and $currencyIsoCol) { "cur.[$currencyIsoCol]" } else { "NULL" }

    if ($Discover) {
        Write-Host "=== وضع الاكتشاف: عيّنة أحدث فاتورة مشتريات مع محتوياتها ==="
        Write-Host ("أعمدة bu000: " + (($buCols.Keys | Sort-Object) -join ", "))
        Write-Host ("أعمدة bi000: " + (($biCols.Keys | Sort-Object) -join ", "))
        Write-Host ("أعمدة mt000: " + (($mtCols.Keys | Sort-Object) -join ", "))
        Write-Host ("أعمدة my000: " + (($myCols.Keys | Sort-Object) -join ", "))
        $c = $conn.CreateCommand()
        $c.CommandTimeout = 180
        $c.CommandText = @"
SELECT TOP 15 $numSel AS bill_number, u.Date AS bill_date,
       LTRIM(RTRIM(COALESCE(u.Cust_Name,''))) AS supplier,
       CAST(st.GUID AS varchar(40)) AS warehouse_guid,
       LTRIM(RTRIM(COALESCE(st.Name,''))) AS warehouse_name,
       $itemNumSel AS item_number,
       LTRIM(RTRIM(COALESCE(m.Name,''))) AS material,
       bi.Qty AS qty, bi.Unity AS unity, $unitSel AS unit_name,
       $unit2FactSel AS unit2_factor,
       $priceSel AS price, $costSel AS unit_cost, $totalSel AS line_total,
       u.[$typeCol] AS type_guid, $currencyIsoSel AS currency_iso
FROM bu000 u
JOIN bi000 bi ON bi.ParentGUID = u.GUID
JOIN mt000 m  ON m.GUID = bi.MatGUID
LEFT JOIN st000 st ON st.GUID = COALESCE(bi.StoreGUID, u.StoreGUID)
$currencyJoin
WHERE u.[$typeCol] IN (@purchaseType, @purchaseReturnType) AND u.Date >= @fromDate $postedFilter
ORDER BY u.Date DESC
"@
        $c.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null
        $c.Parameters.AddWithValue("@purchaseType", $PURCHASE_TYPE_GUID) | Out-Null
        $c.Parameters.AddWithValue("@purchaseReturnType", $PURCHASE_RETURN_TYPE_GUID) | Out-Null
        $rd = $c.ExecuteReader()
        $n = 0
        while ($rd.Read()) {
            $n++
            $retTag = if ([string]$rd["type_guid"] -eq $PURCHASE_RETURN_TYPE_GUID) { " [مرتجع مشتريات]" } else { "" }
            Write-Host ("  [{0}] {1} | {2} | {3} — {4} | كمية {5} وحدة {6}({7}) × سعر {8} (تكلفة {9}) = {10} | معامل كرتونة {11} | عملة {12}{13}" -f `
                $rd["bill_number"], ([datetime]$rd["bill_date"]).ToString("yyyy-MM-dd"), `
                (([string]$rd["supplier"]) + " — مستودع: " + ([string]$rd["warehouse_name"])), $rd["item_number"], $rd["material"], $rd["qty"], $rd["unity"], $rd["unit_name"], $rd["price"], $rd["unit_cost"], $rd["line_total"], $rd["unit2_factor"], $rd["currency_iso"], $retTag)
        }
        $rd.Close(); $conn.Close()
        Write-Host "الاكتشاف انتهى — $n سطر عيّنة. إذا الأسماء/القيم تبيّن صح، شغّل السكربت بدون -Discover."
        exit 0
    }

    # --- جلب كل أسطر فواتير المشتريات ومرتجعات المشتريات للفترة ---
    # الفلترة على u.TypeGUID مباشرة (لا عبر ربط bt000) — bIsInput/BillType الخام
    # مشتركان مع أنواع فواتير أخرى (مرتجعات مبيعات، تحويلات، فتح مدة)، وTypeGUID
    # الحرفي هو المعيار الآمن الوحيد حسب تقرير الاكتشاف.
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 300
    $cmd.CommandText = @"
SELECT CAST(u.GUID AS varchar(40)) AS bill_guid,
       $numSel AS bill_number,
       u.Date AS bill_date,
       LTRIM(RTRIM(COALESCE(u.Cust_Name,''))) AS supplier,
       CAST(st.GUID AS varchar(40)) AS warehouse_guid,
       LTRIM(RTRIM(COALESCE(st.Name,''))) AS warehouse_name,
       CAST(COALESCE(u.Total,0) AS decimal(18,3)) AS bill_total,
       u.[$typeCol] AS type_guid,
       $itemNumSel AS item_number,
       CAST(bi.MatGUID AS varchar(40)) AS mat_guid,
       LTRIM(RTRIM(COALESCE(m.Name,''))) AS material,
       CAST(COALESCE(bi.Qty,0) AS decimal(18,3)) AS qty,
       $unitSel AS unit1,
       $unit2FactSel AS unit2_factor,
       CAST($priceSel AS decimal(18,3)) AS price,
       CAST($costSel AS decimal(18,3)) AS unit_cost,
       CAST($totalSel AS decimal(18,3)) AS line_total,
       $currencyIsoSel AS currency_iso
       $(if ($payMethodCol) { ", u.[$payMethodCol] AS pay_method_raw" } else { "" })
       $(if ($paidCol) { ", CAST(COALESCE(u.[$paidCol],0) AS decimal(18,3)) AS paid_amount" } else { "" })
FROM bu000 u
JOIN bi000 bi ON bi.ParentGUID = u.GUID
JOIN mt000 m  ON m.GUID = bi.MatGUID
LEFT JOIN st000 st ON st.GUID = COALESCE(bi.StoreGUID, u.StoreGUID)
$currencyJoin
WHERE u.[$typeCol] IN (@purchaseType, @purchaseReturnType)
  AND u.Date >= @fromDate
  AND LTRIM(RTRIM(COALESCE(u.Cust_Name,''))) <> ''
  $postedFilter
ORDER BY u.Date DESC, u.GUID
"@
    $cmd.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null
    $cmd.Parameters.AddWithValue("@purchaseType", $PURCHASE_TYPE_GUID) | Out-Null
    $cmd.Parameters.AddWithValue("@purchaseReturnType", $PURCHASE_RETURN_TYPE_GUID) | Out-Null

    # bills[guid] = @{ number,date,supplier,total,currency,payMethod,paidAmount,isReturn, items = List }
    $bills = [ordered]@{}
    $billOrder = New-Object System.Collections.Generic.List[string]
    # آخر تكلفة/متوسط تكلفة لكل مادة، مُحسَبان من أسطر الفواتير المسحوبة نفسها
    # (لا من عمود مخمَّن على mt000) — الصف الأول لكل مادة هو "الأحدث" لأن
    # الاستعلام مرتَّب u.Date DESC.
    $itemStats = @{}
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $g = [string]$r["bill_guid"]
        if (-not $bills.Contains($g)) {
            $billOrder.Add($g)
            $currencyIso = if ($r["currency_iso"] -is [DBNull] -or -not $r["currency_iso"]) { $null } else { [string]$r["currency_iso"] }
            $currency = if ($currencyIso) { $currencyIso.Trim().ToUpper() } else { "unknown" }
            # ⚠️ دلالة PayType/FirstPay غير محسومة عمداً (تقرير الاكتشاف، البند 4) —
            # لا نخمّن نقدي/آجل من القيمة الخام، نتركها "unknown" حتى تُؤكَّد يدوياً.
            $payMethod = "unknown"
            $paidAmount = if ($paidCol) { [double]$r["paid_amount"] } else { $null }
            $bills[$g] = @{
                number     = [string]$r["bill_number"]
                date       = ([datetime]$r["bill_date"]).ToString("yyyy-MM-dd")
                supplier   = [string]$r["supplier"]
                total      = [double]$r["bill_total"]
                currency   = $currency
                payMethod  = $payMethod
                paidAmount = $paidAmount
                isReturn   = ([string]$r["type_guid"] -eq $PURCHASE_RETURN_TYPE_GUID)
                warehouses = @{}
                items      = New-Object System.Collections.Generic.List[object]
            }
        }
        $warehouseGuid = if ($r["warehouse_guid"] -is [DBNull]) { "" } else { ([string]$r["warehouse_guid"]).ToLowerInvariant() }
        $warehouseName = if ($r["warehouse_name"] -is [DBNull]) { "" } else { [string]$r["warehouse_name"] }
        if ($warehouseGuid -and $warehouseName) { $bills[$g].warehouses[$warehouseGuid] = $warehouseName }
        $itemNum = [string]$r["item_number"]
        $matGuid = [string]$r["mat_guid"]
        $unitCost = [double]$r["unit_cost"]
        $unitName = if ($r["unit1"] -is [DBNull] -or -not $r["unit1"]) { "غير معروفة" } else { [string]$r["unit1"] }
        $unit2Factor = if ($r["unit2_factor"] -is [DBNull]) { 0.0 } else { [double]$r["unit2_factor"] }
        # إحصاء آخر تكلفة/متوسط تكلفة يُحسَب بمفتاح MatGUID (لا رقم/كود المادة)،
        # ويستبعد فواتير مرتجع المشتريات كي لا يشوّه المتوسط.
        if (-not $bills[$g].isReturn) {
            if (-not $itemStats.ContainsKey($matGuid)) {
                $itemStats[$matGuid] = @{ lastCost = $unitCost; sum = 0.0; count = 0 }
            }
            $itemStats[$matGuid].sum += $unitCost
            $itemStats[$matGuid].count += 1
        }
        $bills[$g].items.Add(@{
            itemNumber = $itemNum
            matGuid    = $matGuid
            itemName   = [string]$r["material"]
            qty        = [double]$r["qty"]
            unit       = $unitName
            unit2Factor = $unit2Factor
            price      = [double]$r["price"]
            unitCost   = $unitCost
            lineTotal  = [double]$r["line_total"]
        })
    }
    $r.Close(); $conn.Close()

    # --- تجميع الفواتير حسب المورد، وإرفاق آخر تكلفة/متوسط تكلفة محسوبَين من
    #     الأسطر المسحوبة نفسها (لا من mt000) مع وسم صريح لأساس الحساب ---
    # ⚠️ الأساس المخزَّن يبقى UnitCostPrice (تكلفة الوحدة الأساسية/الكروز)، وليس سعر
    # الوحدة المختارة بسطر الفاتورة (bi.Unity). الواجهة تحوّل العرض إلى كرتونة بضرب
    # التكلفة وقسمة الكمية على unit2Factor (mt000.Unit2Fact) — بلا تخمين للمعامل.
    # الإحصاء بمفتاح MatGUID ويستبعد مرتجعات المشتريات (راجع حلقة القراءة أعلاه).
    $priceBasis = if ($costCol) { "unit_cost_price_base_unit" } else { "price_raw_base_unit" }
    $bySupplier = @{}
    foreach ($g in $billOrder) {
        $b = $bills[$g]
        $name = $b.supplier
        if (-not $bySupplier.ContainsKey($name)) { $bySupplier[$name] = New-Object System.Collections.Generic.List[object] }
        $itemsOut = New-Object System.Collections.Generic.List[object]
        foreach ($it in $b.items) {
            $stats = $itemStats[$it.matGuid]
            $lastPrice = if ($stats) { [math]::Round($stats.lastCost, 3) } else { $null }
            $avg = if ($stats -and $stats.count -gt 0) { [math]::Round($stats.sum / $stats.count, 3) } else { $null }
            $itemsOut.Add(@{
                itemNumber = $it.itemNumber
                itemName   = $it.itemName
                qty        = $it.qty
                unit       = $it.unit
                unit2Factor = $it.unit2Factor
                price      = $it.price
                lineTotal  = $it.lineTotal
                lastPrice  = $lastPrice
                avgPrice   = $avg
                priceBasis = $priceBasis
            })
        }
        $bySupplier[$name].Add(@{
            number     = $b.number
            date       = $b.date
            guid       = $g.ToLower()
            total      = [math]::Round($b.total, 3)
            currency   = $b.currency
            payMethod  = $b.payMethod
            paidAmount = $b.paidAmount
            isReturn   = $b.isReturn
            warehouseGuid = if ($b.warehouses.Count -eq 1) { [string]@($b.warehouses.Keys)[0] } else { "" }
            warehouseName = if ($b.warehouses.Count -eq 1) { [string]$b.warehouses[@($b.warehouses.Keys)[0]] } elseif ($b.warehouses.Count -gt 1) { "متعدد" } else { "غير محدد" }
            warehouseCount = $b.warehouses.Count
            items      = $itemsOut.ToArray()
        })
    }

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($name in @($bySupplier.Keys)) {
        $list = $bySupplier[$name].ToArray()
        $truncated = $false
        if ($list.Count -gt $MaxInvoicesPerSupplier) {
            $list = @($list | Select-Object -First $MaxInvoicesPerSupplier)
            $truncated = $true
        }
        $items.Add(@{
            name      = $name
            invoices  = $list
            truncated = $truncated
        })
    }

    Write-Log "تم تجهيز فواتير $($items.Count) مورد / $($billOrder.Count) فاتورة (من $fromIso) — أساس السعر: $priceBasis"

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

    # --- رفع التقرير إلى الجدول المستقل المحمي (لا inventory_reports العام) ---
    $payload = @{
        report_date = (Get-Date).ToString("yyyy-MM-dd")
        created_by  = $session.user.id
        summary     = @{
            periodDays = $PeriodDays
            fromDate   = $fromIso
            suppliers  = $items.Count
            bills      = $billOrder.Count
            priceBasis = $priceBasis
            syncedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        items       = $items
    }
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    Write-Log ("حجم البيانات: {0:N0} حرف" -f $json.Length)
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/ameen_purchase_invoice_reports" `
        -Headers $authHeaders -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) | Out-Null

    Write-Log "تم رفع تقرير فواتير المشتريات بنجاح ✓"

    # --- حذف التقارير القديمة (أقدم من يومين) ---
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    try {
        Invoke-RestMethod -Method Delete `
            -Uri "$supabaseUrl/rest/v1/ameen_purchase_invoice_reports?created_at=lt.$cutoff" `
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
