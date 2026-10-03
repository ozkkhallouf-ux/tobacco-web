# ============================================================
# push-item-sales.ps1
# يرفع صافي مبيع كل صنف في آخر 30 يوماً من **كل** فواتير البيع والمرتجع
# إلى Supabase (inventory_reports / source = ameen_item_sales)
# ليرتّب تنبيه النفاد الأصناف حسب أهميتها (src/stock-alert-priority.js).
#
# لماذا سكربت منفصل عن push-customer-invoices.ps1:
#   تقرير الفواتير يُسقِط كل فاتورة بلا اسم زبون (شرط Cust_Name <> '')، ومعظم
#   فواتير «مبيعات مركز» (الكاشير) بلا اسم — فصنف يُباع أساساً من الكاشير
#   يُحسب مبيعه ناقصاً أو صفراً. هنا لا شرط على الزبون إطلاقاً.
#   والتجميع داخل SQL (صنف واحد = صف واحد) فالحمولة صغيرة مهما كثرت الفواتير.
#
# سكيما الأمين المستخدمة (قراءة فقط — SELECT وحده، لا كتابة إطلاقاً):
#   bu000 = رأس الفاتورة (GUID, Date, نوع الفاتورة)
#   bi000 = أسطر الفاتورة (ParentGUID, MatGUID, Qty بالوحدة الأولى دائماً)
#   bt000 = أنواع الفواتير (BillType: 1 = مبيعات، 3 = مرتجع مبيعات)
#   mt000 = المواد (Name, Unity, Unit2, Unit2Fact)
#
# التشغيل:
#   .\tools\push-item-sales.ps1 -Discover   # يطبع أعداداً وعيّنة بلا رفع
#   .\tools\push-item-sales.ps1             # الرفع الفعلي
# ============================================================
param(
    [int]$WindowDays = 30,
    [switch]$Discover,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\item-sales-push.log"
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

$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
if (-not $connStr) { $connStr = Get-Setting "AMEEN_SQL_WRITE_CONNECTION_STRING" }
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "خطأ: AMEEN_SQL_CONNECTION_STRING غير موجود."; exit 1 }
if ($WindowDays -lt 1) { Write-Log "خطأ: WindowDays يجب أن يكون 1 أو أكثر."; exit 1 }

# النافذة: اليوم المحلي و(WindowDays - 1) يوماً قبله، شاملة. الحد الأعلى حصري
# (بداية الغد) كي تدخل فواتير اليوم كلها مهما كان وقتها.
$toDay = (Get-Date).Date
$fromDay = $toDay.AddDays(-($WindowDays - 1))
$toNext = $toDay.AddDays(1)

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # اسم عمود نوع الفاتورة يختلف بين نسخ الأمين — نكتشفه كما يفعل سكربت الفواتير.
    $cols = New-Object System.Collections.Generic.List[string]
    $c = $conn.CreateCommand()
    $c.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'bu000'"
    $rc = $c.ExecuteReader()
    while ($rc.Read()) { $cols.Add([string]$rc["COLUMN_NAME"]) }
    $rc.Close()

    $typeCol = $null
    foreach ($cand in @("TypeGUID", "BillTypeGUID", "BType")) {
        if ($cols -contains $cand) { $typeCol = $cand; break }
    }
    if (-not $typeCol) { Write-Log "خطأ: لم يُعثر على عمود نوع الفاتورة في bu000."; exit 1 }

    # COUNT(DISTINCT) على رأس الفاتورة: سطران للصنف نفسه في فاتورة واحدة = فاتورة واحدة.
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 300
    $cmd.CommandText = @"
SELECT LOWER(CAST(m.GUID AS varchar(40)))                AS item_guid,
       LTRIM(RTRIM(COALESCE(m.Name,'')))                 AS name,
       LTRIM(RTRIM(COALESCE(m.Unity,'')))                AS unit1,
       LTRIM(RTRIM(COALESCE(m.Unit2,'')))                AS unit2,
       CAST(COALESCE(m.Unit2Fact,0) AS decimal(18,3))    AS unit2_fact,
       CAST(SUM(CASE WHEN bt.BillType = 1 THEN COALESCE(bi.Qty,0) ELSE 0 END) AS decimal(18,3)) AS sale_qty,
       CAST(SUM(CASE WHEN bt.BillType = 3 THEN COALESCE(bi.Qty,0) ELSE 0 END) AS decimal(18,3)) AS return_qty,
       COUNT(DISTINCT CASE WHEN bt.BillType = 1 THEN u.GUID END) AS sale_invoices,
       COUNT(DISTINCT CASE WHEN bt.BillType = 3 THEN u.GUID END) AS return_invoices
FROM bu000 u
JOIN bt000 bt ON bt.GUID = u.$typeCol
JOIN bi000 bi ON bi.ParentGUID = u.GUID
JOIN mt000 m  ON m.GUID = bi.MatGUID
WHERE bt.BillType IN (1, 3)
  AND u.Date >= @fromDay
  AND u.Date <  @toNext
GROUP BY m.GUID, m.Name, m.Unity, m.Unit2, m.Unit2Fact
ORDER BY sale_qty DESC
"@
    $cmd.Parameters.AddWithValue("@fromDay", $fromDay) | Out-Null
    $cmd.Parameters.AddWithValue("@toNext", $toNext) | Out-Null

    $items = New-Object System.Collections.Generic.List[object]
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $items.Add([ordered]@{
            itemGuid         = [string]$r["item_guid"]
            name             = [string]$r["name"]
            unit1Name        = [string]$r["unit1"]
            unit2Name        = [string]$r["unit2"]
            unit2Factor      = [double]$r["unit2_fact"]
            saleQty          = [double]$r["sale_qty"]
            returnQty        = [double]$r["return_qty"]
            saleInvoiceCount = [int]$r["sale_invoices"]
            returnInvoiceCount = [int]$r["return_invoices"]
        })
    }
    $r.Close(); $conn.Close()

    $fromIso = $fromDay.ToString("yyyy-MM-dd")
    $toIso = $toDay.ToString("yyyy-MM-dd")
    Write-Log ("تم تجميع {0} صنف من فواتير البيع والمرتجع ({1} → {2})" -f $items.Count, $fromIso, $toIso)

    if ($Discover) {
        foreach ($it in ($items | Select-Object -First 10)) {
            Write-Host ("  {0} | بيع {1} | مرتجع {2} | فواتير بيع {3}" -f $it.name, $it.saleQty, $it.returnQty, $it.saleInvoiceCount)
        }
        Write-Log "وضع الاكتشاف — لم يُرفع شيء."
        exit 0
    }

    if (-not $apiKey) { Write-Log "خطأ: TOBACCO_SUPABASE_PUBLIC_KEY غير موجود."; exit 1 }
    if (-not $syncEmail -or -not $syncPassword) { Write-Log "خطأ: TOBACCO_SYNC_EMAIL / TOBACCO_SYNC_PASSWORD غير موجودين."; exit 1 }

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

    $payload = @{
        source      = "ameen_item_sales"
        report_date = $toIso
        created_by  = $session.user.id
        summary     = @{
            payloadVersion    = 1
            windowDays        = $WindowDays
            fromDate          = $fromIso
            toDate            = $toIso
            billTypes         = @(1, 3)
            includesAnonymous = $true
            itemCount         = $items.Count
            syncedAt          = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        items       = $items
    }
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/inventory_reports" `
        -Headers $authHeaders -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) | Out-Null

    Write-Log "تم رفع مبيعات الأصناف بنجاح ✓"

    # حذف التقارير القديمة (أقدم من يوم) — يكفي أحدث تقرير دائماً.
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
    try {
        Invoke-RestMethod -Method Delete `
            -Uri "$supabaseUrl/rest/v1/inventory_reports?source=eq.ameen_item_sales&created_at=lt.$cutoff" `
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
    } catch { Write-Log "تعذّرت قراءة رد الخادم: $($_.Exception.Message)" }
    exit 1
}
