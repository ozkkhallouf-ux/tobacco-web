# تثبيت «OZK - إعادة طباعة فاتورة كاشير» أو إزالته. يُشغَّل بصلاحية مدير بموافقة المالك.
# لا يلمس جسر الطباعة التلقائية ولا مهمته ولا state.json ولا الطابعات ولا أداة A4.
#
#   powershell -File install.ps1 -DesktopUser OZKKH                 جهاز الطابعة (OZKUSER): نسخ الملفات وإنشاء الاختصار
#   powershell -File install.ps1 -DesktopUser LOQ -Mode remote      جهاز بلا طابعة (OZK2026): يرسل الطلب إلى OZKUSER
#   powershell -File install.ps1 -DesktopUser OZKKH -Remove    إزالة الاختصار وحده (السجل والإعداد يبقيان)
param(
    [Parameter(Mandatory = $true)][string]$DesktopUser,
    [ValidateSet("local", "remote")][string]$Mode = "local",
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Join-Path $env:ProgramData 'OZK\CashierReprint'
$AppDir = Join-Path $Root 'app'
$Name = 'OZK - إعادة طباعة فاتورة كاشير'

$userProfile = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -match ('\\' + [regex]::Escape($DesktopUser) + '$') } |
    Select-Object -First 1
if (-not $userProfile) { throw "لم يُعثر على ملف تعريف المستخدم $DesktopUser" }
$profileDir = $userProfile.LocalPath
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
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk; "SHORTCUT_REMOVED: $lnk" } else { "SHORTCUT_ABSENT: $lnk" }
    return
}

New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
foreach ($file in @('cashier-reprint-lib.ps1', 'cashier-reprint.ps1', 'cashier-reprint-ui.ps1', 'set-sql-secret.ps1', 'config.example.json', 'config.remote.example.json', 'README.md')) {
    Copy-Item -Force -LiteralPath (Join-Path $SourceDir $file) -Destination (Join-Path $AppDir $file)
}
$configPath = Join-Path $Root 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $example = 'config.example.json'
    if ($Mode -eq 'remote') { $example = 'config.remote.example.json' }
    Copy-Item -LiteralPath (Join-Path $SourceDir $example) -Destination $configPath
    "CONFIG_CREATED: $configPath"
} else {
    "CONFIG_KEPT: $configPath"
}
# المستخدم يكتب السجل وملفات الطلبات والأقفال فقط؛ الإعداد والبرنامج للمدراء.
foreach ($sub in @('logs', 'requests', 'locks')) {
    $dir = Join-Path $Root $sub
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $acl = Get-Acl -LiteralPath $dir
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($DesktopUser, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $dir -AclObject $acl
}

$shell = New-Object -ComObject WScript.Shell
$tmpLnk = Join-Path $desktop ('ozk-cashier-reprint-' + [guid]::NewGuid().ToString('N') + '.lnk')
$s = $shell.CreateShortcut($tmpLnk)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $AppDir 'cashier-reprint-ui.ps1')`""
$s.WorkingDirectory = $AppDir
$s.IconLocation = "$env:SystemRoot\System32\imageres.dll,46"
$s.Description = 'إعادة طباعة فاتورة كاشير على XPRINTER (قراءة فقط من الأمين)'
$s.Save()
Move-Item -Force -LiteralPath $tmpLnk -Destination $lnk
"SHORTCUT_CREATED: $lnk"
