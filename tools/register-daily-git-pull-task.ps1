# يسجّل مهمة مجدولة تسحب آخر نسخة من GitHub يومياً (عندما يكون المستودع نظيفاً فقط).
# التشغيل: .\tools\register-daily-git-pull-task.ps1
param(
  [string]$TaskName = "TOBACCO Daily Git Pull",
  [string]$StartTime = "07:30"
)

$ErrorActionPreference = "Stop"

$pullScriptPath = Join-Path $PSScriptRoot "daily-git-pull.ps1"
if (-not (Test-Path -LiteralPath $pullScriptPath)) {
  throw "Pull script not found: $pullScriptPath"
}

# مجلد الأغلفة الفعلي على جهاز الإنتاج. كان هذا السكربت يكتب في C:\tmp بينما
# المهمة المسجَّلة على الجهاز تشغّل غلافاً في ProgramData — فبقي ما يولّده هنا
# معطَّلاً، وعاش المنطق الحقيقي في ملف غير متعقَّب هناك.
$wrapperDirectory = "C:\ProgramData\OZK-TOBACCO\TaskWrappers"
$launcherPath = Join-Path $wrapperDirectory "tobacco-daily-git-pull-launcher.ps1"
$hiddenLauncherPath = Join-Path $wrapperDirectory "tobacco-daily-git-pull-hidden.vbs"
if (-not (Test-Path -LiteralPath $wrapperDirectory)) {
  New-Item -ItemType Directory -Force -Path $wrapperDirectory | Out-Null
}

# الغلاف **shim رفيع** لا أكثر: يستدعي سكربت المستودع ويعيد رمز خروجه.
# ممنوع أن يحمل أي منطق (حارس القفل، الاتساخ، السحب) — نسخة ثانية من المنطق
# تعني أن كل إصلاح في المستودع يبقى بلا أثر على الإنتاج. وهذا ما وقع فعلاً:
# غلاف ProgramData كان يعيد تنفيذ حارس القفل بنفسه، فظلّ يقرأ القفل من نسخة
# العمل قبل الجلب حتى بعد إصلاح سكربت المستودع (2026-09-05).
$launcherContent = @"
# مولَّد من tools/register-daily-git-pull-task.ps1 — لا تحرّره يدوياً.
# shim رفيع: كل المنطق في tools/daily-git-pull.ps1 داخل المستودع.
& "`$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$pullScriptPath"
exit `$LASTEXITCODE
"@
Set-Content -LiteralPath $launcherPath -Value $launcherContent -Encoding UTF8

# VBScript لا يوسّع %SystemRoot% (تلك صيغة cmd) — يُحقن المسار كاملاً هنا.
$powershellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$hiddenLauncherContent = @"
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run("""$powershellExe"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""$launcherPath""", 0, True)
WScript.Quit exitCode
"@
Set-Content -LiteralPath $hiddenLauncherPath -Value $hiddenLauncherContent -Encoding ASCII

$taskCommand = "wscript.exe `"$hiddenLauncherPath`""
$result = & schtasks.exe /Create /TN $TaskName /SC DAILY /ST $StartTime /TR $taskCommand /F 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Failed to register scheduled task. schtasks.exe output: $result"
}

Write-Host "Scheduled task registered: $TaskName"
Write-Host "It will pull from GitHub daily at $StartTime (only when the repo is clean)."
