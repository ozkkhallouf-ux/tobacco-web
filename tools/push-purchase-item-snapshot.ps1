# ============================================================================
# Supabase-only producer for public.ameen_item_snapshot.
# It never connects to Ameen. Dry run is the default; -Apply is required to write.
#
# 2026-09-06: the snapshot silently stopped regenerating for six days while the
# decision dashboard kept presenting its scores as current. The producer itself
# was healthy — it exits non-zero when the sales freshness guard rejects the
# run, and nothing was listening. Two changes close that gap:
#   * every outcome is logged with its exit code;
#   * a failure raises a Telegram alert instead of dying in a console nobody
#     reads. The alert is best-effort and never masks the real exit code.
# ============================================================================
param(
    [switch]$Apply,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$WindowEnd,
    [string]$LogFile = "$PSScriptRoot\logs\purchase-item-snapshot.log",
    [switch]$NoAlert
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$producer = Join-Path $repoRoot "scripts\refresh-ameen-item-snapshot.mjs"

function Write-SnapshotLog($Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    try {
        $dir = Split-Path $LogFile -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    } catch {
        # التسجيل مساعد ولا يجوز أن يُسقط الإنتاج.
    }
}

# التنبيه best-effort: لا يرمي استثناءً أبداً كي لا يبتلع رمز الخروج الحقيقي.
function Send-SnapshotAlert($Message, $DedupeKey) {
    if ($NoAlert) { return }
    try {
        $notifier = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
        if (-not (Test-Path -LiteralPath $notifier)) { return }
        & $notifier -Message $Message -EventType "windows" -DedupeKey $DedupeKey -DedupeMinutes 60 | Out-Null
    } catch {
        Write-SnapshotLog "Alert delivery failed: $($_.Exception.Message)"
    }
}

if (Test-Path -LiteralPath $EnvFile) {
    Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
    }
}

$node = Get-Command node.exe -ErrorAction Stop
if (-not (Test-Path -LiteralPath $producer)) {
    $missing = "Snapshot producer not found: $producer"
    Write-SnapshotLog $missing
    Send-SnapshotAlert "🚨 تعذّر تحديث لقطة الأصناف: ملف المولّد مفقود على جهاز المزامنة." "snapshot-producer-missing"
    throw $missing
}

$producerArgs = @($producer)
if ($Apply) { $producerArgs += '--apply' }
if ($WindowEnd) { $producerArgs += "--window-end=$WindowEnd" }

Write-SnapshotLog ("Starting snapshot refresh (Apply={0})." -f [bool]$Apply)
# refresh-ameen-item-snapshot.mjs يكتب كل رفض من بوابة حداثة المبيعات وكل عطل
# مصادقة أو شبكة عبر console.error (stderr). ومع $ErrorActionPreference = "Stop"
# أعلى هذا الملف، يحوّل Windows PowerShell 5.1 أي سطر stderr من أمر native إلى
# NativeCommandError **منهٍ** — فيموت السكربت هنا قبل الوصول لالتقاط رمز الخروج
# أو لفرع التسجيل/التنبيه بالأسفل. نفس السلوك المعالَج في auto-sync-price-lists.ps1:
# نخفّض التفضيل حول نداء node وحده، ونحكم برمز الخروج فقط، ثم نعيد التفضيل كما كان.
$previousErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & $node.Source @producerArgs 2>&1 | ForEach-Object {
        $line = "$_"
        Write-SnapshotLog $line
    }
    $exitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorAction
}

if ($exitCode -ne 0) {
    Write-SnapshotLog "Snapshot refresh FAILED with exit code $exitCode."
    # مفتاح منع التكرار ثابت لنوع العطل: تنبيه واحد كل ساعة لا تنبيه كل محاولة.
    Send-SnapshotAlert `
        "🚨 فشل تحديث لقطة الأصناف على جهاز المزامنة (رمز الخروج $exitCode). أولوية الشراء في لوحة القرار ستُعرض كبيانات قديمة حتى ينجح التحديث." `
        "snapshot-refresh-failed"
    exit $exitCode
}

Write-SnapshotLog "Snapshot refresh completed successfully."
exit 0
