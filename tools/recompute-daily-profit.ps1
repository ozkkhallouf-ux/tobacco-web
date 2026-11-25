# ============================================================
# recompute-daily-profit.ps1  (ASCII only: Windows PowerShell 5.1 reads BOM-less files as ANSI)
#
# Root-cause fix for frozen ameen_daily_profit history (reconciliation 2026-11-25):
# push-daily-profit.ps1 only ever computes the current day, so every past day
# kept the snapshot of its last sync. Later recosting, bill edits/deletes and
# back-dated expense entries in Ameen never reached Supabase.
#
# This script re-reads PAST days from Ameen (SELECT only, same formula through
# daily-profit-lib.ps1) and sends each day to rpc/recompute_ameen_daily_profit,
# which writes only when the financial content changed, keeps created_at, and
# records every change in private.ameen_daily_profit_revisions (rollback source).
#
# The current day is never touched here: it stays with push-daily-profit.ps1.
#
# Modes (exactly one):
#   -Days N        the N days before the server's today (nightly: 30)
#   -FullYear      from the first sales/return bill or expense in this Ameen
#                  database up to yesterday (weekly)
#   -From/-To      explicit range (yyyy-MM-dd), e.g. one-off rebuild from 2026-08-01
#
# -DryRun computes and writes -OutJson only: no Supabase sign-in, no write.
# An exclusive lock file prevents two recompute runs from overlapping.
# ============================================================
param(
    [int]$Days = 0,
    [switch]$FullYear,
    [string]$From = "",
    [string]$To = "",
    [switch]$DryRun,
    [string]$OutJson = "",
    [int]$MaxDays = 400,
    [int]$QueryTimeoutSeconds = 600,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\daily-profit-recompute.log"
)

$ErrorActionPreference = "Stop"
$inv = [Globalization.CultureInfo]::InvariantCulture

function Write-Log($Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

function Notify-Failure($Message) {
    if ($DryRun) { return }
    try {
        # Arabic text through \u escapes: this file must stay ASCII for PowerShell 5.1.
        $title = [regex]::Unescape("\u26a0\ufe0f \u0641\u0634\u0644 \u0625\u0639\u0627\u062f\u0629 \u0627\u062d\u062a\u0633\u0627\u0628 \u0627\u0644\u0623\u0631\u0628\u0627\u062d \u0627\u0644\u064a\u0648\u0645\u064a\u0629")
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message ($title + "`n" + $Message) -EventType "sync_failure" -DedupeKey "winfail:recompute-daily-profit" `
            -DedupeMinutes 360 -EnvFile $EnvFile
    } catch { }
}

$modeCount = 0
if ($Days -gt 0) { $modeCount++ }
if ($FullYear) { $modeCount++ }
if ($From -or $To) { $modeCount++ }
if ($modeCount -ne 1) { Write-Log "ERROR: choose exactly one of -Days N, -FullYear, or -From/-To."; exit 2 }
if (($From -and -not $To) -or ($To -and -not $From)) { Write-Log "ERROR: -From and -To go together."; exit 2 }
foreach ($d in @($From, $To)) {
    if ($d -and $d -notmatch '^\d{4}-\d{2}-\d{2}$') { Write-Log "ERROR: dates must be yyyy-MM-dd."; exit 2 }
}

# --- overlap guard: one recompute at a time on this machine -----------------
# An exclusive file handle (not a Global\ mutex: a non-elevated S4U task may
# lack SeCreateGlobalPrivilege). Windows releases it if the process dies.
$lockDir = Split-Path $LogFile -Parent
if (-not (Test-Path $lockDir)) { New-Item -ItemType Directory -Force -Path $lockDir | Out-Null }
$lockPath = Join-Path $lockDir "daily-profit-recompute.lock"
$lock = $null
try {
    $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch [System.IO.IOException] {
    Write-Log "SKIP: another recompute run is active."
    exit 0
}

try {
    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
            $parts = $_ -split '=', 2
            [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
        }
    }
    . "$PSScriptRoot\daily-profit-lib.ps1"

    $connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
    if (-not $connStr) { throw "AMEEN_SQL_CONNECTION_STRING is missing." }

    $started = Get-Date
    $conn = New-AmeenReadOnlyConnection -ConnectionString $connStr -ApplicationName "ozk-daily-profit-recompute"
    try {
        $serverToday = [datetime]::ParseExact((Get-DailyProfitServerToday $conn), "yyyy-MM-dd", $inv)
        $yesterday = $serverToday.AddDays(-1)

        if ($Days -gt 0) {
            $fromDate = $serverToday.AddDays(-$Days); $toDate = $yesterday
        } elseif ($FullYear) {
            $cmd = $conn.CreateCommand()
            $cmd.CommandTimeout = 120
            $cmd.CommandText = @"
SELECT CONVERT(char(10), MIN(d), 23) FROM (
  SELECT MIN(CAST(u.Date AS date)) AS d FROM bu000 u JOIN bt000 bt ON bt.GUID = u.TypeGUID WHERE bt.BillType IN (1, 3)
  UNION ALL
  SELECT MIN(CAST(en.Date AS date)) FROM en000 en JOIN ac000 a ON a.GUID = en.AccountGUID
  WHERE a.ParentGUID = '$($script:DailyProfitExpenseParentGuid)'
) x
"@
            $first = $cmd.ExecuteScalar()
            if ($first -is [DBNull] -or -not $first) { throw "no sales, returns or expenses found in this Ameen database." }
            $fromDate = [datetime]::ParseExact([string]$first, "yyyy-MM-dd", $inv); $toDate = $yesterday
        } else {
            $fromDate = [datetime]::ParseExact($From, "yyyy-MM-dd", $inv)
            $toDate = [datetime]::ParseExact($To, "yyyy-MM-dd", $inv)
        }
        # Never the current day (push-daily-profit.ps1 owns it) or the future.
        if ($toDate -gt $yesterday) { $toDate = $yesterday }
        if ($toDate -lt $fromDate) { Write-Log "SKIP: nothing to recompute (range ends before it starts)."; exit 0 }
        $span = ($toDate - $fromDate).Days + 1
        if ($span -gt $MaxDays) { throw "range of $span days exceeds -MaxDays $MaxDays." }

        $fromText = $fromDate.ToString("yyyy-MM-dd", $inv)
        $toText = $toDate.ToString("yyyy-MM-dd", $inv)
        $qStart = Get-Date
        $rows = Get-DailyProfitRows -Connection $conn -From $fromText -To $toText -TimeoutSeconds $QueryTimeoutSeconds
        $queryMs = [int]((Get-Date) - $qStart).TotalMilliseconds
    } finally { $conn.Close() }

    $syncedAt = (Get-Date).ToUniversalTime().ToString("o")
    $summaries = New-Object System.Collections.ArrayList
    foreach ($r in $rows) { [void]$summaries.Add((New-DailyProfitSummary -Row $r -SyncMode "recompute" -SyncedAt $syncedAt)) }
    Write-Log ("Computed {0} days {1}..{2} from Ameen in {3} ms (SELECT only)." -f $summaries.Count, $fromText, $toText, $queryMs)

    if ($OutJson) {
        $outDir = Split-Path $OutJson -Parent
        if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
        [ordered]@{ from = $fromText; to = $toText; server_today = $serverToday.ToString("yyyy-MM-dd", $inv); query_ms = $queryMs; host = $env:COMPUTERNAME; days = $summaries } |
            ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $OutJson -Encoding UTF8
        Write-Log "Wrote $OutJson"
    }
    if ($DryRun) { Write-Log "DRY RUN: no Supabase write."; exit 0 }

    $supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
    if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
    $supabaseUrl = $supabaseUrl.TrimEnd("/")
    $apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
    if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
    $syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
    $syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"
    if (-not $apiKey -or -not $syncEmail -or -not $syncPassword) { throw "Supabase sync settings are missing." }

    $authBody = @{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress
    $auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($authBody)) -TimeoutSec 20
    if (-not $auth.access_token) { throw "sync user sign-in failed." }
    $headers = @{
        apikey = $apiKey
        Authorization = "Bearer $($auth.access_token)"
        "Accept-Profile" = "public"
        "Content-Profile" = "public"
    }

    $tally = @{ inserted = 0; updated = 0; unchanged = 0 }
    $changedDays = New-Object System.Collections.ArrayList
    foreach ($s in $summaries) {
        $payload = @{ p_report_date = $s.report_date; p_summary = $s } | ConvertTo-Json -Depth 6 -Compress
        $result = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/recompute_ameen_daily_profit" `
            -Headers $headers -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 30
        $action = [string]$result
        if (-not $tally.ContainsKey($action)) { throw "unexpected RPC result '$action' for $($s.report_date)." }
        $tally[$action]++
        if ($action -ne "unchanged") { [void]$changedDays.Add("$($s.report_date):$action") }
    }
    $seconds = [int]((Get-Date) - $started).TotalSeconds
    Write-Log ("Done {0}..{1}: inserted={2} updated={3} unchanged={4} in {5}s. {6}" -f $fromText, $toText, $tally.inserted, $tally.updated, $tally.unchanged, $seconds, ($changedDays -join " "))
    exit 0
} catch {
    Write-Log ("ERROR: " + $_.Exception.Message)
    Notify-Failure $_.Exception.Message
    exit 1
} finally {
    if ($lock) { $lock.Dispose() }
}
