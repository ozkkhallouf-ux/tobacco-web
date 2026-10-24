# يحفظ سلسلة اتصال القراءة لأداة الطباعة اليدوية مشفّرة (DPAPI على مستوى الجهاز)
# في ProgramData\OZK\ManualA4Print\sql.secret مع ACL يقصر قراءتها على SYSTEM
# والمدراء والمستخدم المحدَّد. السلسلة تُقرأ من stdin ولا تُطبع إطلاقاً.
#
#   Get-Content conn.txt | powershell -File set-sql-secret.ps1 -User OZKKH
#
# يرفض حساب sa وأي سلسلة بلا User Id (لا Trusted/Windows auth هنا).
param([Parameter(Mandatory = $true)][string]$User)
$ErrorActionPreference = 'Stop'

$cs = [Console]::In.ReadToEnd().Trim()
if (-not $cs) { throw 'لا توجد سلسلة اتصال على stdin.' }
$b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $cs
if (-not $b.UserID) { throw 'السلسلة بلا User Id.' }
if ($b.UserID -ieq 'sa') { throw 'مرفوض: حساب sa لا يُستعمل لأداة الطباعة. استعمل حساب القراءة.' }
if (-not $b.InitialCatalog) { $b.InitialCatalog = 'AmnDb002' }
$b.ApplicationIntent = 'ReadOnly'

$dir = Join-Path $env:ProgramData 'OZK\ManualA4Print'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir 'sql.secret'

Add-Type -AssemblyName System.Security
$enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($b.ConnectionString),
    [Text.Encoding]::UTF8.GetBytes('OZK-ManualA4Print'), [Security.Cryptography.DataProtectionScope]::LocalMachine)
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
