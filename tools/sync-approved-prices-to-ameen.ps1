# ============================================================
# sync-approved-prices-to-ameen.ps1
# يسحب الأسعار من Supabase ويطبّقها على قاعدة بيانات الأمين
# ============================================================

param(
    [switch]$Apply,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$CsvFile = "$PSScriptRoot\..\reports\prices\tobacco-approved-prices.csv",
    [string]$LogFile = "$PSScriptRoot\logs\approved-prices-sync.log"
)

# نبضة كل محاولة (نجاح أو فشل) في price_sync_heartbeat — supabase/proposed/16-price-sync-heartbeat.sql.
# بلاها يبقى الفشل والتوقف بلا أثر ويبدو آخر «ok» حديثاً. best-effort: لا تغيّر رمز الخروج.
$attemptStartedAt = (Get-Date).ToUniversalTime().ToString("o")
$heartbeat = @{ AttemptStartedAt = $attemptStartedAt; EnvFile = $EnvFile }

function Publish-Heartbeat([hashtable]$Fields) {
    $arguments = $heartbeat.Clone()
    foreach ($key in $Fields.Keys) { $arguments[$key] = $Fields[$key] }
    try { & "$PSScriptRoot\publish-price-sync-heartbeat.ps1" @arguments } catch { }
}

function Read-MachineLine($Lines, [string]$Pattern) {
    foreach ($line in @($Lines)) {
        $match = [regex]::Match([string]$line, $Pattern)
        if ($match.Success) { return $match }
    }
    return $null
}

# الخطوة 1: سحب الأسعار من Supabase
Write-Host "الخطوة 1: سحب الأسعار من Supabase..." -ForegroundColor Cyan
$pullOutput = & "$PSScriptRoot\pull-approved-prices.ps1" -EnvFile $EnvFile -OutputCsv $CsvFile -LogFile $LogFile
$pullExit = $LASTEXITCODE
$pullOutput | ForEach-Object { Write-Output $_ }
if ($pullExit -ne 0) {
    Write-Host "فشل سحب الأسعار!" -ForegroundColor Red
    if ($Apply) { Publish-Heartbeat @{ Status = "pull_failed"; Stage = "pull"; Message = "فشل سحب الأسعار من Supabase" } }
    exit 1
}
$pull = Read-MachineLine $pullOutput 'PRICE_PULL count=(\d+) max_updated_at=(\S+)'
if ($pull) {
    $heartbeat.PulledCount = [int]$pull.Groups[1].Value
    if ($pull.Groups[2].Value -ne "none") { $heartbeat.FeedMaxUpdatedAt = $pull.Groups[2].Value }
}

if (-not $Apply) {
    # المعاينة لا تكتب في الأمين، فلا تُنشر نبضة: لا تُحسب محاولة مزامنة.
    Write-Host "وضع المعاينة — لم يتم التطبيق على الأمين. استخدم -Apply للتطبيق الفعلي." -ForegroundColor Yellow
    exit 0
}

# الخطوة 2: تطبيق الأسعار على الأمين
Write-Host "الخطوة 2: تطبيق الأسعار على الأمين..." -ForegroundColor Cyan
$applyOutput = & "$PSScriptRoot\apply-approved-prices-to-ameen.ps1" -CsvFile $CsvFile -EnvFile $EnvFile -LogFile $LogFile
$applyExit = $LASTEXITCODE
$applyOutput | ForEach-Object { Write-Output $_ }
if ($applyExit -ne 0) {
    Write-Host "فشل تطبيق الأسعار على الأمين!" -ForegroundColor Red
    Publish-Heartbeat @{ Status = "apply_failed"; Stage = "apply"; Message = "فشل تطبيق الأسعار على قاعدة الأمين" }
    # إشعار تيليغرام عند الفشل (مرة كل ساعة كحد أقصى لنفس العطل)
    try {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message "🚨 فشل تطبيق الأسعار على قاعدة الأمين (sync-approved-prices-to-ameen)" `
            -EventType "sync_failure" -DedupeKey "winfail:apply-to-ameen" -DedupeMinutes 60 `
            -EnvFile $EnvFile
    } catch { }
    exit 1
}
$heartbeat.Applied = $true
$heartbeat.AmeenConnected = $true
$applied = Read-MachineLine $applyOutput 'PRICE_APPLY jumla=(\d+) retail=(\d+) skipped=(\d+) notfound=(\d+) conflict=(\d+)'
if ($applied) {
    $heartbeat.AppliedWholesale = [int]$applied.Groups[1].Value
    $heartbeat.AppliedRetail = [int]$applied.Groups[2].Value
    $heartbeat.SkippedCount = [int]$applied.Groups[3].Value
    $heartbeat.NotFoundCount = [int]$applied.Groups[4].Value
    $heartbeat.ConflictCount = [int]$applied.Groups[5].Value
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
    & "$PSScriptRoot\publish-price-sync-status.ps1" -Status $status `
        -WholesaleMatched $wholesaleMatched -RetailMatched $retailMatched `
        -MismatchCount $mismatchCount -MissingCount $missingCount
    Publish-Heartbeat @{
        Status = $status; Stage = "done"
        VerifiedWholesale = $wholesaleMatched; VerifiedRetail = $retailMatched
        MismatchCount = $mismatchCount; MissingCount = $missingCount
    }
    if ($status -ne "ok") {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message "⚠️ مزامنة الأسعار ليست مكتملة`nفروقات: $mismatchCount — مواد ناقصة: $missingCount" `
            -EventType "price_sync_mismatch" -DedupeKey "price-sync:mismatch" -DedupeMinutes 30 -EnvFile $EnvFile
        exit 2
    }
    # صريح: رمز خروج آخر سكربت مُستدعى (النبضة قبل تطبيق 16 مثلاً) لا يصير نتيجة المهمة.
    exit 0
} else {
    & "$PSScriptRoot\publish-price-sync-status.ps1" -Status "error" -Message "تعذر تحليل نتيجة فحص الأسعار"
    Publish-Heartbeat @{ Status = "verify_failed"; Stage = "verify"; Message = "تعذر تحليل نتيجة فحص الأسعار" }
    & "$PSScriptRoot\send-telegram-notification.ps1" `
        -Message "🚨 تعذر التحقق من مزامنة الأسعار مع الأمين" `
        -EventType "price_sync_failure" -DedupeKey "price-sync:verify-failed" -DedupeMinutes 60 -EnvFile $EnvFile
    exit 3
}
