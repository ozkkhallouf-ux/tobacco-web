# يحفظ سلسلة اتصال القراءة لأداة «إعادة طباعة فاتورة كاشير» مشفّرة (DPAPI على مستوى الجهاز)
# في ProgramData\OZK\CashierReprint\sql.secret، مع ACL يقصر قراءتها على SYSTEM والمدراء والمستخدم المحدَّد.
# لا تُطبع السلسلة إطلاقاً.
#
#   Get-Content conn.txt | powershell -File set-sql-secret.ps1 -User OZKKH
#   powershell -File set-sql-secret.ps1 -User OZKKH -FromManualA4Print
#
# الخيار الثاني ينسخ سلسلة حساب القراءة المحفوظة مسبقاً لأداة طباعة A4 على الجهاز نفسه
# (يقرأ ملفها فقط ولا يعدّله)، فلا حاجة لكتابة كلمة سر أو نقلها بين الأجهزة.
# يرفض sa وأي سلسلة بلا User Id.
param(
    [Parameter(Mandatory = $true)][string]$User,
    [switch]$FromManualA4Print
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Data

if ($FromManualA4Print) {
    $source = Join-Path $env:ProgramData 'OZK\ManualA4Print\sql.secret'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "لا يوجد سرّ أداة A4 على هذا الجهاز: $source" }
    $cs = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($source),
        [Text.Encoding]::UTF8.GetBytes('OZK-ManualA4Print'), [Security.Cryptography.DataProtectionScope]::LocalMachine))
} else {
    $cs = [Console]::In.ReadToEnd().Trim()
}
if (-not $cs) { throw 'لا توجد سلسلة اتصال.' }
$b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $cs
if (-not $b.UserID) { throw 'السلسلة بلا User Id.' }
if ($b.UserID -ieq 'sa') { throw 'مرفوض: حساب sa لا يُستعمل لإعادة الطباعة. استعمل حساب القراءة.' }
if (-not $b.InitialCatalog) { $b.InitialCatalog = 'AmnDb002' }
$b.ApplicationIntent = 'ReadOnly'

$dir = Join-Path $env:ProgramData 'OZK\CashierReprint'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir 'sql.secret'
$enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($b.ConnectionString),
    [Text.Encoding]::UTF8.GetBytes('OZK-CashierReprint'), [Security.Cryptography.DataProtectionScope]::LocalMachine)
$tmp = "$file.tmp"
[IO.File]::WriteAllBytes($tmp, $enc)
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($id in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators', $User)) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id, 'Read', 'Allow')))
}
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators', 'FullControl', 'Allow')))
Set-Acl -Path $tmp -AclObject $acl
Move-Item -Force $tmp $file
"SECRET_SAVED: $file (user=$($b.UserID); server=$($b.DataSource); db=$($b.InitialCatalog))"
