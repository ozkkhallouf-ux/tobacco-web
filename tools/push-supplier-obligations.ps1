param(
    [switch]$Apply,
    # الكتابة الحالية delete-then-insert بلا قيد فريد في الجدول، فصفر صفوف يعني
    # مسح كل الالتزامات. قراءة فارغة من الأمين قد تكون حقيقة (كل الموردين
    # مسدَّدون) وقد تكون عطلاً في الاستعلام — والفرق لا يُخمَّن. المسح على صفر
    # صفوف يحتاج إذناً صريحاً.
    [switch]$AllowEmpty,
    [int]$MinimumIntervalMinutes = 0,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\supplier-obligations-push.log",
    [string]$MarkerPath = "$PSScriptRoot\logs\supplier-obligations-last-success.txt"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

function Write-Log($Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
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

if (-not $connStr) { throw "AMEEN_SQL_CONNECTION_STRING is missing." }
if ($Apply -and (-not $apiKey -or -not $syncEmail -or -not $syncPassword)) {
    throw "Supabase sync credentials are missing."
}

$PURCHASE_TYPE_GUID = "91377a56-ebfc-48c0-b79e-72063e1d7e3a"
$SOURCE = "ameen_ac000_credit_minus_debit"
$LEGACY_SOURCE = "ameen_cu000_credit_minus_debit"

if ($Apply -and $MinimumIntervalMinutes -gt 0 -and (Test-Path -LiteralPath $MarkerPath)) {
    $lastSuccess = (Get-Item -LiteralPath $MarkerPath).LastWriteTimeUtc
    if ($lastSuccess -gt (Get-Date).ToUniversalTime().AddMinutes(-$MinimumIntervalMinutes)) {
        Write-Log "Skipped: supplier balances are still fresh."
        exit 0
    }
}

$sql = @"
SELECT
    CONVERT(nvarchar(36), c.GUID) AS supplier_key,
    c.CustomerName AS supplier_name,
    CAST(a.Debit AS float) AS debit_total,
    CAST(a.Credit AS float) AS credit_total,
    CAST(a.Credit - a.Debit AS float) AS net_supplier_balance,
    MAX(CAST(u.Date AS date)) AS last_purchase_date
FROM cu000 c
JOIN ac000 a
  ON a.GUID = c.AccountGUID
JOIN bu000 u
  ON u.CustGUID = c.GUID
 AND u.TypeGUID = '$PURCHASE_TYPE_GUID'
WHERE ISNULL(c.bHide, 0) = 0
  AND NULLIF(LTRIM(RTRIM(c.CustomerName)), N'') IS NOT NULL
GROUP BY c.GUID, c.CustomerName, a.Debit, a.Credit
ORDER BY net_supplier_balance DESC, c.CustomerName;
"@

Write-Log "Reading supplier balances from Ameen ac000 base-currency accounts..."

Add-Type -AssemblyName "System.Data"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = $sql
$cmd.CommandTimeout = 120
$reader = $cmd.ExecuteReader()

$allRows = @()
while ($reader.Read()) {
    $net = [double]$reader["net_supplier_balance"]
    $allRows += [PSCustomObject]@{
        supplier_key = "$($reader['supplier_key'])"
        supplier_name = "$($reader['supplier_name'])"
        debit_total = [double]$reader["debit_total"]
        credit_total = [double]$reader["credit_total"]
        amount_due = [Math]::Max(0, $net)
        last_purchase_date = if ($reader["last_purchase_date"] -is [DBNull]) { $null } else { ([datetime]$reader["last_purchase_date"]).ToString("yyyy-MM-dd") }
    }
}
$reader.Close()
$conn.Close()

$rows = @($allRows | Where-Object { $_.amount_due -gt 0 })
Write-Log "Found $($allRows.Count) purchase-linked suppliers; $($rows.Count) have a positive payable balance."

# قراءة لم تُرجع أي مورد مرتبط بفواتير شراء = استعلام مشبوه لا حقيقة محاسبية.
if ($allRows.Count -eq 0) {
    Write-Log "ABORT: the Ameen read returned no purchase-linked suppliers at all. Refusing to touch Supabase."
    throw "Supplier read returned zero rows; existing Supabase data was left untouched."
}
if ($Apply -and $rows.Count -eq 0 -and -not $AllowEmpty) {
    Write-Log "ABORT: no supplier has a positive balance. Refusing to clear existing rows without -AllowEmpty."
    throw "Zero payable suppliers. Re-run with -AllowEmpty only if clearing the table is intended."
}

if (-not $Apply) {
    Write-Host "=== DRY RUN: top supplier obligations ===" -ForegroundColor Yellow
    $rows | Sort-Object amount_due -Descending | Select-Object -First 20 supplier_name, debit_total, credit_total, amount_due, last_purchase_date | Format-Table -AutoSize
    Write-Log "DryRun only. Re-run with -Apply to upload."
    exit 0
}

Write-Log "Authenticating sync user..."
$authBody = @{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json
$auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $apiKey; Accept = "application/json" } `
    -ContentType "application/json; charset=utf-8" -Body $authBody
$token = $auth.access_token
$headers = @{
    apikey = $apiKey
    Authorization = "Bearer $token"
    "Accept-Profile" = "public"
    "Content-Profile" = "public"
}

Write-Log "Replacing $($rows.Count) supplier obligation rows."
foreach ($sourceToReplace in @($SOURCE, $LEGACY_SOURCE)) {
    $encodedSource = [Uri]::EscapeDataString($sourceToReplace)
    Invoke-RestMethod -Method Delete `
        -Uri "$supabaseUrl/rest/v1/supplier_obligations?source=eq.$encodedSource" `
        -Headers ($headers + @{ Prefer = "return=minimal" }) `
        -TimeoutSec 60 | Out-Null
}

$generatedAt = (Get-Date).ToUniversalTime().ToString("o")
$payload = @($rows | ForEach-Object {
    [PSCustomObject]@{
        supplier_key = $_.supplier_key
        supplier_name = $_.supplier_name
        amount_due = [Math]::Round($_.amount_due, 3)
        currency = "USD"
        due_date = $null
        strategic_weight = 1.0
        supply_risk = "normal"
        notes = "Ameen ac000 base-currency balance: Credit - Debit; last purchase $($_.last_purchase_date); synced $generatedAt"
        source = $SOURCE
        updated_at = $generatedAt
    }
})

$batchSize = 200
for ($i = 0; $i -lt $payload.Count; $i += $batchSize) {
    $end = [Math]::Min($i + $batchSize - 1, $payload.Count - 1)
    $batch = $payload[$i..$end]
    $body = $batch | ConvertTo-Json -Depth 4 -Compress
    Invoke-RestMethod -Method Post `
        -Uri "$supabaseUrl/rest/v1/supplier_obligations" `
        -Headers ($headers + @{ Prefer = "return=minimal" }) `
        -ContentType "application/json; charset=utf-8" `
        -TimeoutSec 60 `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
    Write-Log "Uploaded rows $($i + 1)-$($end + 1)."
}

$markerDir = Split-Path -Parent $MarkerPath
if (-not (Test-Path -LiteralPath $markerDir)) { New-Item -ItemType Directory -Force -Path $markerDir | Out-Null }
(Get-Date).ToUniversalTime().ToString("o") | Set-Content -LiteralPath $MarkerPath -Encoding UTF8
Write-Log "Supplier obligations upload completed successfully: $($payload.Count) suppliers."
