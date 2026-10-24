# يحفظ سرّاً لعامل أرشفة Google Drive مشفّراً (DPAPI على مستوى الجهاز + entropy باسم السر)
# في ProgramData\OZK\DriveArchive\<Name>.secret مع ACL يقصر قراءتها على SYSTEM والمدراء
# والمستخدم الذي تعمل به المهمة. القيمة تُقرأ من stdin ولا تُطبع إطلاقاً.
#
#   Get-Content conn.txt | powershell -File set-secret.ps1 -Name sql -User loq
#   (authorize.js يستدعيه بنفسه لسرّ google-oauth)
#
# sql: يرفض حساب sa وأي سلسلة بلا User Id، ويفرض ApplicationIntent=ReadOnly.
param(
    [Parameter(Mandatory = $true)][ValidateSet('sql', 'google-oauth', 'notify')][string]$Name,
    [Parameter(Mandatory = $true)][string]$User
)
$ErrorActionPreference = 'Stop'

$value = [Console]::In.ReadToEnd().Trim()
if (-not $value) { throw 'لا توجد قيمة على stdin.' }

if ($Name -eq 'sql') {
    $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $value
    if (-not $b.UserID) { throw 'السلسلة بلا User Id.' }
    if ($b.UserID -ieq 'sa') { throw 'مرفوض: حساب sa لا يُستعمل للأرشفة. استعمل حساب القراءة.' }
    if (-not $b.InitialCatalog) { $b.InitialCatalog = 'AmnDb002' }
    $b.ApplicationIntent = 'ReadOnly'
    $value = $b.ConnectionString
}
if ($Name -eq 'google-oauth') {
    $o = $value | ConvertFrom-Json
    foreach ($k in @('client_id', 'client_secret', 'refresh_token', 'account_email')) {
        if (-not $o.$k) { throw "google-oauth بلا الحقل $k" }
    }
}
if ($Name -eq 'notify' -and $value.Length -lt 32) { throw 'سرّ الإشعار أقصر من 32 محرفاً.' }

$dir = Join-Path $env:ProgramData 'OZK\DriveArchive'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$file = Join-Path $dir "$Name.secret"

Add-Type -AssemblyName System.Security
$enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),
    [Text.Encoding]::UTF8.GetBytes("OZK-DriveArchive-$Name"), [Security.Cryptography.DataProtectionScope]::LocalMachine)
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
"SECRET_SAVED: $file (name=$Name)"
