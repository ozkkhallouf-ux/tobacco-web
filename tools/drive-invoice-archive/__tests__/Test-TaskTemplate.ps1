# اختبار قالب المهمة المجدولة OZK-DriveArchive-DryRun.task.xml تحت Windows PowerShell 5.1 (وPowerShell 7).
# قراءة فقط: لا يسجّل أي مهمة ولا يشغّل الغلاف أو العامل.
#
# التثبيت على OZK2026 ينسخ بنية المستودع تحت app، فالعامل في app\tools\drive-invoice-archive\.
# والغلاف يعدّ مجلده مجلد العامل (WorkerDir = $PSScriptRoot)، فيجب أن يشير -File إلى الغلاف
# بجوار worker.js. القالب الأول أشار إلى app\run-scheduled.ps1، فكانت كل دورة ستفشل برمز 12.

$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $toolDir)
$templatePath = Join-Path $toolDir 'scheduled-task\OZK-DriveArchive-DryRun.task.xml'
$installRoot = 'C:\ProgramData\OZK\DriveArchive\app'
$sep = [IO.Path]::DirectorySeparatorChar

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

# مسار Windows تحت جذر التثبيت ⇐ المسار المقابل في المستودع، أو $null إن كان خارجه.
function ConvertTo-RepoPath([string]$InstallPath) {
    $prefix = $installRoot + '\'
    if (-not $InstallPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $rel = $InstallPath.Substring($prefix.Length).Replace('\', [string]$sep)
    return Join-Path $repoRoot $rel
}

# يعيد قائمة المشكلات في مسارَي الغلاف ومجلد العمل؛ القائمة الفارغة تعني أن القالب سليم.
function Get-PathProblems([string]$Arguments, [string]$WorkingDirectory) {
    $problems = @()
    $m = [regex]::Match($Arguments, '-File\s+"([^"]+)"')
    if (-not $m.Success) { return @('لا توجد وسيطة -File مقتبسة') }
    $file = $m.Groups[1].Value
    if ([IO.Path]::GetFileName($file.Replace('\', [string]$sep)) -ne 'run-scheduled.ps1') { $problems += "-File ليس run-scheduled.ps1: $file" }
    $repoFile = ConvertTo-RepoPath $file
    $wrapper = Join-Path $toolDir 'run-scheduled.ps1'
    if (-not $repoFile) { $problems += "-File خارج $installRoot" }
    elseif ([IO.Path]::GetFullPath($repoFile) -ne [IO.Path]::GetFullPath($wrapper)) { $problems += "-File لا يقابل الغلاف في المستودع: $file" }
    $fileDir = $file.Substring(0, [Math]::Max(0, $file.LastIndexOf('\')))
    if (-not [string]::Equals($WorkingDirectory, $fileDir, [StringComparison]::OrdinalIgnoreCase)) { $problems += "WorkingDirectory ليس مجلد الغلاف: $WorkingDirectory" }
    $repoWorkDir = ConvertTo-RepoPath $WorkingDirectory
    if (-not $repoWorkDir) { $problems += "WorkingDirectory خارج $installRoot" }
    else {
        foreach ($f in @('worker.js', 'run-scheduled.ps1', (Join-Path 'lib' 'config.js'))) {
            if (-not (Test-Path -LiteralPath (Join-Path $repoWorkDir $f))) { $problems += "لا يوجد $f بجوار الغلاف" }
        }
    }
    return $problems
}

[xml]$xml = [IO.File]::ReadAllText($templatePath)
$exec = $xml.Task.Actions.Exec
$taskArgs = [string]$exec.Arguments
$workDir = [string]$exec.WorkingDirectory

$problems = @(Get-PathProblems $taskArgs $workDir)
foreach ($p in $problems) { Write-Host "  $p" }
Assert 'مسار الغلاف في القالب يقابل tools\drive-invoice-archive\run-scheduled.ps1 بجوار worker.js' ($problems.Count -eq 0)
Assert 'مسار الغلاف المتوقع حرفياً' ($taskArgs -match [regex]::Escape('-File "C:\ProgramData\OZK\DriveArchive\app\tools\drive-invoice-archive\run-scheduled.ps1"'))
Assert 'مجلد العمل المتوقع حرفياً' ($workDir -eq 'C:\ProgramData\OZK\DriveArchive\app\tools\drive-invoice-archive')

# ضبط سلبي: القالب الخاطئ الأول يجب أن يُرفض، وإلا فالفحص لا يحرس شيئاً.
$oldProblems = @(Get-PathProblems '-NoProfile -File "C:\ProgramData\OZK\DriveArchive\app\run-scheduled.ps1" -AllowedModes dry-run' 'C:\ProgramData\OZK\DriveArchive\app')
Assert 'المسار الخاطئ القديم (app\run-scheduled.ps1) مرفوض' ($oldProblems.Count -gt 0)
$mismatch = @(Get-PathProblems '-File "C:\ProgramData\OZK\DriveArchive\app\tools\drive-invoice-archive\run-scheduled.ps1"' 'C:\ProgramData\OZK\DriveArchive\app')
Assert 'مجلد عمل لا يطابق مجلد الغلاف مرفوض' ($mismatch.Count -gt 0)
$outside = @(Get-PathProblems '-File "D:\other\tools\drive-invoice-archive\run-scheduled.ps1"' 'D:\other\tools\drive-invoice-archive')
Assert 'مسار خارج جذر التثبيت مرفوض' ($outside.Count -gt 0)

# بقية ضمانات القالب بلا تغيير.
Assert 'الوضع dry-run وحده' ($taskArgs -match '-AllowedModes dry-run( |$)' -and $taskArgs -notmatch '(?i)live|drive,|,drive')
Assert 'المهمة معطّلة' ([string]$xml.Task.Settings.Enabled -eq 'false')
Assert 'IgnoreNew' ([string]$xml.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew')
Assert 'S4U' ([string]$xml.Task.Principals.Principal.LogonType -eq 'S4U')

Write-Host ''
Write-Host "Test-TaskTemplate: $($script:pass) PASS, $($script:fail) FAIL"
if ($script:fail -gt 0) { exit 1 }
exit 0
