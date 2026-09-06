<#
.SYNOPSIS
  يولّد wrapper VBS محمول (غير مرتبط بأي مسار مستخدم ثابت) لتشغيل PrintBridge
  عبر Scheduled Task، ويطبعه فقط — لا يُنشئ ولا يُعدّل أي Scheduled Task.

.DESCRIPTION
  المصدر الأصلي الحيّ (ozk-print-bridge-hidden.vbs) يحتوي مسارات مطلقة مبنية
  على اسم مستخدم محدد (C:\Users\<user>\...) ولذلك صُنّف "machine-specific" ولم
  يُدخل حرفياً إلى Git. هذا السكربت يمثّل نفس المنطق بشكل محمول: يشتق BridgeRoot
  من %LOCALAPPDATA% في وقت التوليد على أي جهاز، بدلاً من تضمين مسار ثابت.

.PARAMETER OutputPath
  مسار ملف الـVBS الناتج. لا يُنفَّذ ولا يُثبَّت تلقائياً.

.NOTES
  لا يُشغّل أي عملية طباعة فعلية، ولا ينشئ/يُعدّل Scheduled Task.
  -IncludeWholesale غير ممرر عمداً — الكاشير فقط ضمن هذا الـwrapper.
#>
[CmdletBinding()]
param(
    [string]$OutputPath = (Join-Path $PSScriptRoot "ozk-print-bridge-hidden.generated.vbs"),
    [string]$PrinterName = "XPRINTER XP-T80Q 80MM",
    [int]$PollMilliseconds = 150
)

function VbsEscape([string]$s) {
    # يضاعف علامات الاقتباس لتظل صالحة داخل سلسلة VBScript الحرفية
    return $s -replace '"', '""'
}

$q = '"'  # علامة اقتباس مفردة، لتفادي أي تعقيد في تركيب سلاسل PowerShell

# BridgeRoot محمول: يُشتق من %LOCALAPPDATA% في وقت التوليد/التثبيت على أي جهاز —
# لا يوجد أي "C:\Users\<اسم-ثابت>" مضمّن في هذا الملف المصدري.
$bridgeRootEnvExpr = '%LOCALAPPDATA%\OZK-TOBACCO\PrintBridge'

$psExe       = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$watchdogRel = 'ozk-print-bridge-watchdog.ps1'
$stateRel    = 'state.json'
$logRel      = 'logs\events.jsonl'
$printerEsc  = VbsEscape $PrinterName

# نبني سطر VBScript المسؤول عن تركيب سطر أوامر PowerShell بالكامل داخل VBScript
# نفسه وقت التشغيل (concatenation بـ &)، بدل تضمين مسار ثابت هنا.
# ملاحظة: لا -IncludeWholesale هنا افتراضياً — الكاشير فقط.
# ملاحظة: -ConfirmPhysicalPrint دائماً ممرّر — لا طباعة صامتة بدون تأكيد فيزيائي.
$cmdBuilderLine =
    'cmd = ' + $q + $q + $psExe + $q + $q + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $q + $q + '" & bridgeRoot & "\' + $watchdogRel + '" & "' + $q + $q +
    ' -BridgeRoot ' + $q + $q + '" & bridgeRoot & "' + $q + $q +
    ' -PollMilliseconds ' + $PollMilliseconds +
    ' -PrinterName ' + $q + $q + $printerEsc + $q + $q +
    ' -ConfirmPhysicalPrint' +
    ' -StatePath ' + $q + $q + '" & bridgeRoot & "\' + $stateRel + '" & "' + $q + $q +
    ' -LogPath ' + $q + $q + '" & bridgeRoot & "\' + $logRel + '" & "' + $q + $q

$vbsLines = @(
    'Set shell = CreateObject("WScript.Shell")'
    ('bridgeRoot = shell.ExpandEnvironmentStrings("{0}")' -f $bridgeRootEnvExpr)
    'shell.CurrentDirectory = bridgeRoot'
    $cmdBuilderLine
    'exitCode = shell.Run(cmd, 0, True)'
    'WScript.Quit exitCode'
)

$vbsLines -join "`r`n" | Set-Content -LiteralPath $OutputPath -Encoding Unicode -NoNewline
Write-Host "تم توليد wrapper محمول (بدون تنفيذ/تثبيت): $OutputPath"
Write-Host "لتثبيته يدوياً لاحقاً: انسخه إلى TaskWrappers، وأشّر Scheduled Task الحالية إليه فقط بعد مراجعة يدوية."
