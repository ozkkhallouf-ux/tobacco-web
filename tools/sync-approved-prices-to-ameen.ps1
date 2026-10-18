# ============================================================
# sync-approved-prices-to-ameen.ps1
# يسحب الأسعار من Supabase ويطبّقها على قاعدة بيانات الأمين
#
# نبض المزامنة (2026-10-18): كل تشغيل ينشر صفاً ameen_price_sync_heartbeat عبر
# publish-price-sync-heartbeat.ps1 — نجاحاً أو فشلاً — كي لا يتقادم آخر «ok» بصمت.
# النبض best-effort: لا يغيّر رموز الخروج ولا تنبيهات تيليغرام ولا ameen_price_sync_status.
# التوثيق: docs/ai/topics/price-sync-heartbeat.md
# ============================================================

param(
    [switch]$Apply,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$CsvFile = "$PSScriptRoot\..\reports\prices\tobacco-approved-prices.csv",
    [string]$LogFile = "$PSScriptRoot\logs\approved-prices-sync.log"
)

$attemptStartedAt = (Get-Date).ToUniversalTime().ToString("o")
$heartbeat = @{
    AttemptStartedAt = $attemptStartedAt
    EnvFile = $EnvFile
}

function Send-PriceSyncHeartbeat([hashtable]$Fields) {
    try {
        $arguments = $heartbeat.Clone()
        foreach ($key in $Fields.Keys) { $arguments[$key] = $Fields[$key] }
        & "$PSScriptRoot\publish-price-sync-heartbeat.ps1" -Mode Attempt @arguments | ForEach-Object { Write-Host $_ }
    } catch {
        Write-Host "PRICE-SYNC-HEARTBEAT FAILED: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# عدد الأسعار المسحوبة وبصمتها السعرية (بلا updated_at، لأنه يتغيّر مع تحديث المخزون أيضاً).
function Get-PricesSnapshot([string]$Path) {
    try {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        $rows = @(Import-Csv -LiteralPath $Path -Encoding UTF8)
        $lines = @($rows | ForEach-Object {
            "{0}|{1}|{2}|{3}|{4}|{5}" -f $_.item_key, $_.sale_price, $_.unit1_price, $_.unit2_price, $_.unit2_factor, $_.retail_carton_usd
        } | Sort-Object)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
            $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
        } finally { $sha.Dispose() }
        return @{ Count = $rows.Count; Fingerprint = $hash }
    } catch { return $null }
}

# الخطوة 1: سحب الأسعار من Supabase
Write-Host "الخطوة 1: سحب الأسعار من Supabase..." -ForegroundColor Cyan
& "$PSScriptRoot\pull-approved-prices.ps1" -EnvFile $EnvFile -OutputCsv $CsvFile -LogFile $LogFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "فشل سحب الأسعار!" -ForegroundColor Red
    Send-PriceSyncHeartbeat @{ Outcome = "pull_failed"; StageFailed = "pull"; Message = "pull-approved-prices exit $LASTEXITCODE" }
    exit 1
}

$snapshot = Get-PricesSnapshot $CsvFile
if ($snapshot) {
    $heartbeat.SentCount = [int]$snapshot.Count
    $heartbeat.PricesFingerprint = [string]$snapshot.Fingerprint
}

if (-not $Apply) {
    Write-Host "وضع المعاينة — لم يتم التطبيق على الأمين. استخدم -Apply للتطبيق الفعلي." -ForegroundColor Yellow
    Send-PriceSyncHeartbeat @{ Outcome = "preview_only"; StageFailed = "apply"; Message = "registered without -Apply" }
    exit 0
}

# الخطوة 2: تطبيق الأسعار على الأمين
Write-Host "الخطوة 2: تطبيق الأسعار على الأمين..." -ForegroundColor Cyan
$applyOutput = @(& "$PSScriptRoot\apply-approved-prices-to-ameen.ps1" -CsvFile $CsvFile -EnvFile $EnvFile -LogFile $LogFile)
$applyExitCode = $LASTEXITCODE
$applyOutput | ForEach-Object { Write-Output $_ }
$applyResult = [regex]::Match(($applyOutput -join "`n"), 'PRICE_APPLY jumla=(\d+) retail=(\d+) skipped=(\d+) notfound=(\d+) conflict=(\d+)')
if ($applyResult.Success) {
    $heartbeat.AmeenContact = $true
    $heartbeat.AppliedWholesale = [int]$applyResult.Groups[1].Value
    $heartbeat.AppliedRetail = [int]$applyResult.Groups[2].Value
    $heartbeat.Skipped = [int]$applyResult.Groups[3].Value
    $heartbeat.NotInAmeen = [int]$applyResult.Groups[4].Value
    $heartbeat.ConflictCount = [int]$applyResult.Groups[5].Value
}
if ($applyExitCode -ne 0) {
    Write-Host "فشل تطبيق الأسعار على الأمين!" -ForegroundColor Red
    # نميّز تعذّر الاتصال بالأمين عن فشل التطبيق نفسه من آخر سطر AMEEN ERROR في السجل.
    $ameenError = ""
    try {
        if (Test-Path -LiteralPath $LogFile) {
            $ameenError = [string](Get-Content -LiteralPath $LogFile -Tail 20 -Encoding UTF8 | Where-Object { $_ -match 'AMEEN ERROR' } | Select-Object -Last 1)
        }
    } catch { }
    $unreachable = $ameenError -match '(?i)network-related|instance-specific|could not open a connection|login failed|server was not found|timeout expired|actively refused|transport-level'
    $failure = if ($unreachable) { "ameen_unreachable" } else { "apply_failed" }
    $stage = if ($unreachable) { "connect" } else { "apply" }
    Send-PriceSyncHeartbeat @{ Outcome = $failure; StageFailed = $stage; Message = ($ameenError -replace '^\[[^\]]*\]\s*', '') }
    # إشعار تيليغرام عند الفشل (مرة كل ساعة كحد أقصى لنفس العطل)
    try {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message "🚨 فشل تطبيق الأسعار على قاعدة الأمين (sync-approved-prices-to-ameen)" `
            -EventType "sync_failure" -DedupeKey "winfail:apply-to-ameen" -DedupeMinutes 60 `
            -EnvFile $EnvFile
    } catch { }
    exit 1
}

Write-Host "تمت المزامنة الكاملة بنجاح ✓" -ForegroundColor Green

# فحص مستقل بعد الكتابة، ثم نشر النتيجة للبوت. لا نكتفي بعدّ الصفوف التي حاولنا تحديثها.
$verificationFile = [IO.Path]::GetTempFileName()
& "$PSScriptRoot\verify-prices.ps1" -ResultFile $verificationFile *> $null
$verification = if (Test-Path $verificationFile) { [IO.File]::ReadAllText($verificationFile, [Text.Encoding]::ASCII) } else { "" }
Remove-Item -LiteralPath $verificationFile -Force -ErrorAction SilentlyContinue
$machineResult = [regex]::Match($verification, 'PRICE_VERIFY wholesale=(\d+) retail=(\d+) mismatches=(\d+) missing=(\d+)')
if ($machineResult.Success) {
    $wholesaleMatched = [int]$machineResult.Groups[1].Value
    $retailMatched = [int]$machineResult.Groups[2].Value
    $mismatchCount = [int]$machineResult.Groups[3].Value
    $missingCount = [int]$machineResult.Groups[4].Value
    $status = if (($mismatchCount + $missingCount) -eq 0) { "ok" } else { "mismatch" }
    $heartbeat.AmeenContact = $true   # الفحص قرأ القائمتين من الأمين فعلاً
    $heartbeat.WholesaleMatched = $wholesaleMatched
    $heartbeat.RetailMatched = $retailMatched
    $heartbeat.Mismatches = $mismatchCount
    $heartbeat.Missing = $missingCount
    $partial = ([int]$heartbeat['ConflictCount'] -gt 0) -or ([int]$heartbeat['NotInAmeen'] -gt 0)
    $heartbeatOutcome = if ($status -ne "ok") { "verify_mismatch" } elseif ($partial) { "applied_with_conflicts" } else { "applied" }
    Send-PriceSyncHeartbeat @{ Outcome = $heartbeatOutcome }
    & "$PSScriptRoot\publish-price-sync-status.ps1" -Status $status `
        -WholesaleMatched $wholesaleMatched -RetailMatched $retailMatched `
        -MismatchCount $mismatchCount -MissingCount $missingCount
    if ($status -ne "ok") {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message "⚠️ مزامنة الأسعار ليست مكتملة`nفروقات: $mismatchCount — مواد ناقصة: $missingCount" `
            -EventType "price_sync_mismatch" -DedupeKey "price-sync:mismatch" -DedupeMinutes 30 -EnvFile $EnvFile
        exit 2
    }
} else {
    Send-PriceSyncHeartbeat @{ Outcome = "verify_failed"; StageFailed = "verify"; Message = "PRICE_VERIFY line not found" }
    & "$PSScriptRoot\publish-price-sync-status.ps1" -Status "error" -Message "تعذر تحليل نتيجة فحص الأسعار"
    & "$PSScriptRoot\send-telegram-notification.ps1" `
        -Message "🚨 تعذر التحقق من مزامنة الأسعار مع الأمين" `
        -EventType "price_sync_failure" -DedupeKey "price-sync:verify-failed" -DedupeMinutes 60 -EnvFile $EnvFile
    exit 3
}
