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

$userProfile = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -match ('\\' + [regex]::Escape($DesktopUser) + '$') } |
    Select-Object -First 1
if (-not $userProfile) { throw "لم يُعثر على ملف تعريف المستخدم $DesktopUser" }
$profileDir = $userProfile.LocalPath
# سطح المكتب الفعلي من User Shell Folders للمستخدم (قد يكون محوَّلاً إلى OneDrive)،
# لا من وجود مجلد OneDrive\Desktop الذي قد يبقى عنصراً سحابياً غير مستعمل.
$desktop = $null
$shellKey = "Registry::HKEY_USERS\$($userProfile.SID)\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
$raw = (Get-ItemProperty -LiteralPath $shellKey -Name Desktop -ErrorAction SilentlyContinue).Desktop
if ($raw) {
    $candidate = $raw -ireplace '%USERPROFILE%', $profileDir
    if (Test-Path -LiteralPath $candidate) { $desktop = $candidate }
}
if (-not $desktop) {
    $desktop = @((Join-Path $profileDir 'Desktop'), (Join-Path $profileDir 'OneDrive\Desktop')) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $desktop) { throw "لا يوجد مجلد سطح مكتب للمستخدم $DesktopUser" }
$lnk = Join-Path $desktop "$Name.lnk"

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk; "SHORTCUT_REMOVED: $lnk" } else { "SHORTCUT_ABSENT: $lnk" }
    return
}

$shell = New-Object -ComObject WScript.Shell
# WScript.Shell يحفظ بصفحة ترميز ANSI فيفشل مع الاسم العربي؛ نحفظ باسم ASCII ثم نعيد التسمية.
$tmpLnk = Join-Path $desktop ('ozk-manual-a4-print-' + [guid]::NewGuid().ToString('N') + '.lnk')
$s = $shell.CreateShortcut($tmpLnk)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $AppDir 'launch.ps1')`""
$s.WorkingDirectory = $AppDir
$icon = Join-Path $AppDir 'ui\ozk.ico'
$s.IconLocation = if (Test-Path $icon) { $icon } else { "$env:SystemRoot\System32\imageres.dll,46" }
$s.Description = 'طباعة فاتورة جملة A4 يدوياً على Canon (قراءة فقط من الأمين)'
$s.Save()
Move-Item -Force -LiteralPath $tmpLnk -Destination $lnk
"SHORTCUT_CREATED: $lnk"
