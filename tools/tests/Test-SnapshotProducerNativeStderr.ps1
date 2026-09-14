#Requires -Version 5.1
# ============================================================================
# Test-SnapshotProducerNativeStderr.ps1
#
# اختبار انحدار لملاحظة Codex P1 على tools/push-purchase-item-snapshot.ps1:
#
#   scripts/refresh-ameen-item-snapshot.mjs يكتب كل رفض من بوابة حداثة المبيعات
#   وكل عطل مصادقة أو شبكة عبر console.error (stderr). ومع
#   $ErrorActionPreference = "Stop" أعلى الملف، يحوّل Windows PowerShell 5.1 أي
#   سطر stderr من أمر native إلى NativeCommandError **منهٍ** — فيموت السكربت
#   قبل التقاط رمز الخروج، ولا يصل أبداً إلى فرع التسجيل ولا إلى تنبيه تيليغرام.
#   أي أن العطل الذي جمّد اللقطة ستة أيام كان يبقى صامتاً رغم كل إصلاحات التنبيه.
#
# الإصلاح المعتمد (نفس سابقة tools/auto-sync-price-lists.ps1): تخفيض التفضيل حول
# نداء node وحده، والحكم برمز الخروج، ثم إعادة التفضيل كما كان.
#
# الاختبار يستخرج كتلة النداء من الملف الإنتاجي نفسه — لا نسخة موازية — وينفّذها
# مقابل أمر native حقيقي يكتب على stderr ويخرج برمز غير صفري، تحت
# $ErrorActionPreference = 'Stop' تماماً كما في الإنتاج.
#
# ضابط سالب: على Windows PowerShell 5.1 تحديداً تُنفَّذ الكتلة نفسها بلا تخفيض
# التفضيل، ويجب أن تسقط فعلاً — وإلا لما كان الاختبار يثبت شيئاً.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-SnapshotProducerNativeStderr.ps1
# ============================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$producerPath = Join-Path $repoRoot 'tools/push-purchase-item-snapshot.ps1'
$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }

if (-not (Test-Path -LiteralPath $producerPath)) {
    Write-Host "FAIL: cannot find $producerPath" -ForegroundColor Red
    exit 1
}
$producerText = Get-Content -LiteralPath $producerPath -Raw -Encoding UTF8

# ------------------------------------------------------------------
# استخرج كتلة النداء الحقيقية (من تخفيض التفضيل حتى نهاية finally).
# ------------------------------------------------------------------
$blockMatch = [regex]::Match(
    $producerText,
    '(?ms)^\$previousErrorAction\s*=\s*\$ErrorActionPreference.*?^\}\s*finally\s*\{.*?^\}')
if (-not $blockMatch.Success) {
    Write-Host "FAIL: could not extract the guarded node invocation block from the producer" -ForegroundColor Red
    exit 1
}
Add-Pass "extracted the guarded node invocation block from the production script"

# أمر native يكتب على stderr ثم يخرج برمز غير صفري — نفس شكل فشل المولّد.
$isWindowsHost = ($null -eq $IsWindows) -or $IsWindows
if ($isWindowsHost) {
    $fakeExe  = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $fakeArgs = @('/c', 'echo snapshot refresh rejected 1>&2 & exit 3')
} else {
    $fakeExe  = '/bin/sh'
    $fakeArgs = @('-c', 'echo snapshot refresh rejected >&2; exit 3')
}

$script:captured = New-Object System.Collections.ArrayList
function Write-SnapshotLog($Message) { [void]$script:captured.Add("$Message") }

# ------------------------------------------------------------------
# الحالة الموجبة: الكتلة الإنتاجية تنجو وتلتقط رمز الخروج.
# ------------------------------------------------------------------
Write-Host "== production block survives native stderr under ErrorActionPreference=Stop"
$node = [PSCustomObject]@{ Source = $fakeExe }
$producerArgs = $fakeArgs
$exitCode = $null
$ErrorActionPreference = 'Stop'
try {
    . ([scriptblock]::Create($blockMatch.Value))
    Add-Pass "the guarded block did not terminate on native stderr"
} catch {
    Add-Failure "the guarded block still dies on native stderr: $($_.Exception.GetType().Name): $($_.Exception.Message)"
}

if ($exitCode -ne 3) {
    Add-Failure "the real exit code must reach the failure branch; expected 3, got '$exitCode'"
} else {
    Add-Pass "the real exit code (3) reached the failure branch"
}
if (-not ($script:captured -join "`n").Contains('snapshot refresh rejected')) {
    Add-Failure "the producer's stderr output was not captured into the log"
} else {
    Add-Pass "stderr output was captured into the log"
}

# ------------------------------------------------------------------
# الضابط السالب: بلا تخفيض التفضيل يجب أن تسقط الكتلة على 5.1 فعلاً.
# ------------------------------------------------------------------
$isPs51Desktop = ($PSVersionTable.PSVersion.Major -eq 5) -and ($PSVersionTable.PSEdition -ne 'Core')
Write-Host "== negative control (meaningful on Windows PowerShell 5.1 only)"
if ($isPs51Desktop) {
    $threw = $false
    $ErrorActionPreference = 'Stop'
    try {
        & $fakeExe @fakeArgs 2>&1 | ForEach-Object { $null = "$_" }
    } catch {
        $threw = $true
    }
    if (-not $threw) {
        Add-Failure "negative control did not reproduce NativeCommandError on PowerShell 5.1; this test would prove nothing"
    } else {
        Add-Pass "negative control reproduced the terminating NativeCommandError on 5.1"
    }
} else {
    Write-Host "  skip: host is PowerShell $($PSVersionTable.PSVersion) ($($PSVersionTable.PSEdition)); the 5.1 stderr trap does not apply here"
}

$ErrorActionPreference = 'Stop'
Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "FAILED: $($failures.Count) assertion(s)." -ForegroundColor Red
    exit 1
}
Write-Host "PASSED: the snapshot producer reaches its alert handler on native failures." -ForegroundColor Green
exit 0
