# ============================================================
# push-item-costs.ps1
# يقرأ "متوسط التكلفة" (AvgPrice) لكل مادة من قاعدة الأمين
# ويرفعها إلى Supabase (جدول item_costs المحمي — يقرأه المدير فقط).
# يطابقها الموقع داخل بطاقة كل مادة في صفحة التسعير (للمدير فقط).
# ============================================================
# تجربة بدون رفع:  .\tools\push-item-costs.ps1 -DryRun
# تشغيل فعلي:      .\tools\push-item-costs.ps1
# مصدر بديل:       .\tools\push-item-costs.ps1 -SourceView vwMtPrices
# ============================================================
param(
    [switch]$DryRun,
    [string]$SourceView = "vwMaterials",
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\item-costs-push.log"
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
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "khata: AMEEN_SQL_CONNECTION_STRING ghyr mwjwd."; exit 1 }
if (-not $DryRun) {
    if (-not $apiKey) { Write-Log "khata: TOBACCO_SUPABASE_PUBLIC_KEY ghyr mwjwd."; exit 1 }
    if (-not $syncEmail -or -not $syncPassword) { Write-Log "khata: TOBACCO_SYNC_EMAIL / TOBACCO_SYNC_PASSWORD ghyr mwjwdyn."; exit 1 }
}

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # discover columns of the chosen materials view
    $discover = $conn.CreateCommand()
    $discover.CommandText = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '$SourceView'"
    $dr = $discover.ExecuteReader()
    $cols = @()
    while ($dr.Read()) { $cols += [string]$dr["COLUMN_NAME"] }
    $dr.Close()
    if ($cols.Count -eq 0) { Write-Log "khata: al-view '$SourceView' ghyr mwjwd."; $conn.Close(); exit 1 }

    function Pick($cands) { $cands | Where-Object { $cols -contains $_ } | Select-Object -First 1 }
    $avgCol  = Pick @("AvgPrice","mtAvgPrice","AverageCost","AvgCost","AvgCostPrice")
    $nameCol = Pick @("Name","MaterialName","MatName","ArabicName","Name1")
    $codeCol = Pick @("Code","MaterialCode","ItemCode","Barcode")
    $guidCol = Pick @("GUID","MaterialGUID","mtGUID","MatGUID","ItemGUID")

    if (-not $avgCol)  { Write-Log "khata: la ywjd 3mwd AvgPrice fi $SourceView. al-a3mda: $($cols -join ', ')"; $conn.Close(); exit 1 }
    if (-not $nameCol) { Write-Log "khata: la ywjd 3mwd Name fi $SourceView. al-a3mda: $($cols -join ', ')"; $conn.Close(); exit 1 }
    Write-Log "al-masdar: $SourceView | tklfa=$avgCol | ism=$nameCol | code=$(if($codeCol){$codeCol}else{'-'}) | guid=$(if($guidCol){$guidCol}else{'-'})"

    $guidExpr = if ($guidCol) { "CONVERT(varchar(36), m.$guidCol)" } else { "NULL" }
    $codeExpr = if ($codeCol) { "LTRIM(RTRIM(CAST(m.$codeCol AS nvarchar(80))))" } else { "''" }

    $query = @"
SELECT
    $guidExpr                                       AS item_guid,
    LTRIM(RTRIM(m.$nameCol))                        AS item_name,
    $codeExpr                                       AS item_code,
    CAST(COALESCE(m.$avgCol, 0) AS decimal(18,3))   AS avg_cost
FROM $SourceView m
WHERE LTRIM(RTRIM(COALESCE(m.$nameCol,''))) <> ''
"@
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $query
    $cmd.CommandTimeout = 60

    $seen = @{}
    $rows = New-Object System.Collections.Generic.List[object]
    $reader = $cmd.ExecuteReader()
    while ($reader.Read()) {
        $guid = if ($reader["item_guid"] -is [DBNull]) { $null } else { ([string]$reader["item_guid"]).Trim() }
        $name = ([string]$reader["item_name"]).Trim()
        $code = ([string]$reader["item_code"]).Trim()
        $cost = [double]$reader["avg_cost"]
        # match_key = mfta7 mn3 tkrar 3nd al-raf3 (GUID aw code aw ism) - laysa lazman GUID 7aqiqi.
        # item_guid = GUID al-Amin al-7aqiqi faqat aw NULL - hwa al-3mwd aldy yatbaq m3 approved_price_items.item_guid.
        $key = if ($guid) { $guid } elseif ($code) { $code } else { $name }
        if (-not $key) { continue }
        if ($seen.ContainsKey($key)) { continue }   # mfta7 farid wa7id likl mada
        $seen[$key] = $true
        $rows.Add(@{
            match_key  = $key
            item_guid  = $guid
            item_name  = $name
            avg_cost   = [math]::Round($cost, 3)
            currency   = "$"
            updated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        })
    }
    $reader.Close()
    $conn.Close()

    Write-Log "thm tjhyz tklfa $($rows.Count) mada. 3yna:"
    $rows | Where-Object { $_.avg_cost -gt 0 } | Select-Object -First 10 | ForEach-Object {
        Write-Host ("  {0,-34} = {1}" -f $_.item_name, $_.avg_cost)
    }

    if ($DryRun) { Write-Log "wad3 al-tjruba (DryRun): lm ytm al-raf3." ; exit 0 }
    if ($rows.Count -eq 0) { Write-Log "la twjd byanat lil-raf3."; exit 0 }

    # login to Supabase as owner
    $loginBody = (@{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress)
    $session = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" -TimeoutSec 30 `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($loginBody))

    $authHeaders = @{
        apikey            = $apiKey
        Authorization     = "Bearer $($session.access_token)"
        Prefer            = "resolution=merge-duplicates,return=minimal"
        "Accept-Profile"  = "public"
        "Content-Profile" = "public"
    }

    # upsert in one batch on match_key (dedupe key - GUID or code or name fallback)
    $json = $rows.ToArray() | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/item_costs?on_conflict=match_key" `
        -Headers $authHeaders -ContentType "application/json; charset=utf-8" -TimeoutSec 60 `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) | Out-Null

    Write-Log "thm raf3 al-tklfa bnja7 ($($rows.Count) mada)"
    exit 0
} catch {
    Write-Log "khata (str $($_.InvocationInfo.ScriptLineNumber)): $($_.Exception.Message)"
    if ($_.ErrorDetails.Message) { Write-Log ("tfsyl: " + $_.ErrorDetails.Message) }
    elseif ($_.Exception.InnerException) { Write-Log ("tfsyl: " + $_.Exception.InnerException.Message) }
    exit 1
}
