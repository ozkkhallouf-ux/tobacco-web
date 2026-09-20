# ============================================================
# push-daily-expenses.ps1
# يرفع «المصاريف اليومية» (كل حسابات المصاريف، أكواد 5xx: كهرباء، أجور،
# وقود ومحروقات، طعام، نظافة، مصروف شخصي، متفرقة...) إلى Supabase
# (inventory_reports / source = ameen_expenses) ليعرضها الموقع يومياً.
#
# المصروف = صافي الحركة على حساب المصروف (مدين - دائن).
# سكيما الأمين: en000 (قيود) + vwExtended_AC (الحسابات) + my000 (العملات).
#
# التشغيل:
#   .\tools\push-daily-expenses.ps1 -Discover    # يطبع حسابات المصاريف وعيّنة بدون رفع
#   .\tools\push-daily-expenses.ps1              # الرفع الفعلي (آخر 60 يومًا)
#   .\tools\push-daily-expenses.ps1 -PeriodDays 90
# ============================================================
param(
    [int]$PeriodDays = 60,
    [string]$ExpenseCodePrefix = "5",
    [switch]$Discover,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\daily-expenses-push.log"
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

$fromDate = (Get-Date).Date.AddDays(-$PeriodDays)
$fromIso = $fromDate.ToString("yyyy-MM-dd")
$prefix = "$ExpenseCodePrefix%"

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    if ($Discover) {
        Write-Log "=== حسابات المصاريف المطابقة (Code LIKE '$prefix') ==="
        $c = $conn.CreateCommand(); $c.CommandTimeout = 120
        $c.CommandText = "SELECT Code, Name FROM vwExtended_AC WHERE Code LIKE @p AND (NSons IS NULL OR NSons = 0) ORDER BY Code"
        $c.Parameters.AddWithValue("@p", $prefix) | Out-Null
        $rd = $c.ExecuteReader()
        while ($rd.Read()) { Write-Host ("  " + $rd["Code"] + " | " + $rd["Name"]) }
        $rd.Close()

        Write-Log "=== عيّنة آخر مصاريف ==="
        $c = $conn.CreateCommand(); $c.CommandTimeout = 180
        $c.CommandText = @"
SELECT TOP 20 en.Date AS d, ac.Name AS category,
       CAST(COALESCE(en.Debit,0) AS decimal(18,2)) AS debit,
       CAST(COALESCE(en.Credit,0) AS decimal(18,2)) AS credit,
       cur.Code AS cur, LEFT(COALESCE(en.Notes,''),60) AS notes
FROM en000 en
JOIN vwExtended_AC ac ON ac.GUID = en.AccountGUID
LEFT JOIN my000 cur ON cur.GUID = en.CurrencyGUID
WHERE ac.Code LIKE @p AND en.Date >= @fromDate
  AND (COALESCE(en.Debit,0) <> 0 OR COALESCE(en.Credit,0) <> 0)
ORDER BY en.Date DESC
"@
        $c.Parameters.AddWithValue("@p", $prefix) | Out-Null
        $c.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null
        $rd = $c.ExecuteReader()
        $n = 0
        while ($rd.Read()) {
            $n++
            Write-Host ("  " + ([datetime]$rd["d"]).ToString("yyyy-MM-dd") + " | " + $rd["category"] + " | مدين " + $rd["debit"] + " | دائن " + $rd["credit"] + " | " + $rd["cur"] + " | " + $rd["notes"])
        }
        $rd.Close(); $conn.Close()
        Write-Log "الاكتشاف انتهى — $n سطر عيّنة. إذا الحسابات والقيم صح، شغّل السكربت بدون -Discover."
        exit 0
    }

    # --- جلب كل قيود المصاريف للفترة ---
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 300
    $cmd.CommandText = @"
SELECT CAST(en.Date AS date) AS d,
       LTRIM(RTRIM(COALESCE(ac.Name,''))) AS category,
       ac.Code AS code,
       CAST(COALESCE(en.Debit,0)  AS decimal(18,2)) AS debit,
       CAST(COALESCE(en.Credit,0) AS decimal(18,2)) AS credit,
       COALESCE(cur.Code,'') AS currency,
       LEFT(COALESCE(en.Notes,''),140) AS notes
FROM en000 en
JOIN vwExtended_AC ac ON ac.GUID = en.AccountGUID
LEFT JOIN my000 cur ON cur.GUID = en.CurrencyGUID
WHERE ac.Code LIKE @p
  AND en.Date >= @fromDate
  AND (COALESCE(en.Debit,0) <> 0 OR COALESCE(en.Credit,0) <> 0)
ORDER BY en.Date DESC, ac.Code
"@
    $cmd.Parameters.AddWithValue("@p", $prefix) | Out-Null
    $cmd.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null

    # days[date] = @{ date, total, lines = List }
    $days = [ordered]@{}
    $dayOrder = New-Object System.Collections.Generic.List[string]
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $d = ([datetime]$r["d"]).ToString("yyyy-MM-dd")
        if (-not $days.Contains($d)) {
            $dayOrder.Add($d)
            $days[$d] = @{ date = $d; total = 0.0; lines = New-Object System.Collections.Generic.List[object] }
        }
        $amount = [double]$r["debit"] - [double]$r["credit"]
        $days[$d].total += $amount
        $days[$d].lines.Add(@{
            category = [string]$r["category"]
            code     = [string]$r["code"]
            amount   = [math]::Round($amount, 2)
            currency = [string]$r["currency"]
            notes    = [string]$r["notes"]
        })
    }
    $r.Close(); $conn.Close()

    $items = New-Object System.Collections.Generic.List[object]
    foreach ($d in $dayOrder) {
        $day = $days[$d]
        $items.Add(@{
            date  = $day.date
            total = [math]::Round($day.total, 2)
            lines = $day.lines.ToArray()
        })
    }

    Write-Log "تم تجهيز مصاريف $($items.Count) يوم / $(($items | ForEach-Object { $_.lines.Count } | Measure-Object -Sum).Sum) حركة (من $fromIso)"

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
        source      = "ameen_expenses"
        report_date = (Get-Date).ToString("yyyy-MM-dd")
        created_by  = $session.user.id
        summary     = @{
            periodDays = $PeriodDays
            fromDate   = $fromIso
            days       = $items.Count
            syncedAt   = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        items       = $items
    }
    $json = $payload | ConvertTo-Json -Depth 10 -Compress
    Write-Log ("حجم البيانات: {0:N0} حرف" -f $json.Length)
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/inventory_reports" `
        -Headers $authHeaders -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) | Out-Null

    Write-Log "تم رفع تقرير المصاريف اليومية بنجاح ✓"

    # --- حذف التقارير القديمة (أقدم من يومين) ---
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    try {
        Invoke-RestMethod -Method Delete `
            -Uri "$supabaseUrl/rest/v1/inventory_reports?source=eq.ameen_expenses&created_at=lt.$cutoff" `
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
