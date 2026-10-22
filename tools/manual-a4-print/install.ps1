# تثبيت/إزالة اختصار «OZK - طباعة فواتير A4» على سطح المكتب.
# لا يلمس مهمة الطباعة التلقائية ولا جسر الكاشير ولا الطابعات.
#
#   powershell -File install.ps1 -DesktopUser LOQ          اختصار على سطح مكتب مستخدم واحد
#   powershell -File install.ps1 -DesktopUser LOQ -Remove   إزالة الاختصار
param(
    [Parameter(Mandatory = $true)][string]$DesktopUser,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Name = 'OZK - طباعة فواتير A4'

$profileDir = (Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -match ('\\' + [regex]::Escape($DesktopUser) + '$') } |
    Select-Object -First 1).LocalPath
if (-not $profileDir) { throw "لم يُعثر على ملف تعريف المستخدم $DesktopUser" }
# سطح المكتب قد يكون محوَّلاً إلى OneDrive.
$desktop = @((Join-Path $profileDir 'OneDrive\Desktop'), (Join-Path $profileDir 'Desktop')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $desktop) { throw "لا يوجد مجلد سطح مكتب للمستخدم $DesktopUser" }
$lnk = Join-Path $desktop "$Name.lnk"

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk; "SHORTCUT_REMOVED: $lnk" } else { "SHORTCUT_ABSENT: $lnk" }
    return
}

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $AppDir 'launch.ps1')`""
$s.WorkingDirectory = $AppDir
$icon = Join-Path $AppDir 'ui\ozk.ico'
$s.IconLocation = if (Test-Path $icon) { $icon } else { "$env:SystemRoot\System32\imageres.dll,46" }
$s.Description = 'طباعة فاتورة جملة A4 يدوياً على Canon (قراءة فقط من الأمين)'
$s.Save()
"SHORTCUT_CREATED: $lnk"
