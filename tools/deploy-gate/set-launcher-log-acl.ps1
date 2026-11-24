#Requires -Version 5.1
# ============================================================
# set-launcher-log-acl.ps1 — تجهيز مجلد سجل المشغّل run-repo-task.ps1 بأقل صلاحية (الدفعة د0)
#
# يُشغَّل مرة واحدة بحساب مدير، وبموافقة المالك، على OZK2026. بلا -Apply لا يغيّر شيئاً: يطبع
# الخطة فقط (الصلاحيات الحالية إن وُجد المجلد، والمطلوبة). مع -Apply ينشئ المجلد إن غاب ويضع
# عليه قائمة صلاحيات محمية (بلا وراثة):
#   - SYSTEM وAdministrators: تحكم كامل، والمالك Administrators.
#   - حسابات التشغيل (-Writers، افتراضياً LOQ وOZKSync):
#       * على المجلد نفسه فقط: عرض المحتوى وإنشاء الملفات. لا إنشاء مجلدات، ولا حذف.
#       * على الملفات داخله: قراءة وكتابة وإلحاق. لا حذف، ولا تغيير صلاحيات، ولا امتلاك.
#   - OWNER RIGHTS على الملفات: قراءة الصلاحيات فقط. منشئ الملف يصير مالكه، والمالك يملك ضمنياً
#     تغيير الصلاحيات (WRITE_DAC)؛ هذا السطر يلغي ذلك، فلا يستطيع منح نفسه حق الحذف لاحقاً.
#
# التدوير بالاسم (launcher-YYYY-MM.log): لا حاجة لحذف أو إعادة تسمية. لا يمسّ مجلد البوابة
# ولا أي ملف خارج مجلد السجل، ويرفض مجلد سجل هو مجلد البوابة أو داخله أو أعلى منه.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\deploy-gate\set-launcher-log-acl.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\deploy-gate\set-launcher-log-acl.ps1 -Apply
# ============================================================
[CmdletBinding()]
param(
    [string]$LogDir = 'C:\ProgramData\OZK-TOBACCO\logs\run-repo-task',
    [string]$GateDir = 'C:\ProgramData\OZK-TOBACCO\DeployGate',
    [string[]]$Writers = @('LOQ', 'OZKSync'),
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$script:LogWriterDirRights = [System.Security.AccessControl.FileSystemRights]'ListDirectory, CreateFiles, ReadAttributes, ReadExtendedAttributes, ReadPermissions, Traverse, Synchronize'
# FileStream بوضع Append يطلب GENERIC_WRITE، أي WriteData وAppendData وWriteAttributes وWriteExtendedAttributes معاً.
$script:LogWriterFileRights = [System.Security.AccessControl.FileSystemRights]'ReadData, ReadAttributes, ReadExtendedAttributes, ReadPermissions, WriteData, AppendData, WriteAttributes, WriteExtendedAttributes, Synchronize'
$script:LogOwnerRightsFile = [System.Security.AccessControl.FileSystemRights]'ReadPermissions, Synchronize'
# ما يجب ألا يملكه حساب التشغيل في أي سطر من صلاحياته (المجلد والملفات).
$script:LogForbiddenRights = [System.Security.AccessControl.FileSystemRights]'Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership'
# وعلى المجلد وحده: لا مجلدات فرعية. CreateDirectories وAppendData البتّ نفسه (0x4)، فهذا الفحص
# لا يصحّ على سطر الملفات الذي يمنح AppendData عمداً.
$script:LogForbiddenDirRights = [System.Security.AccessControl.FileSystemRights]'CreateDirectories'

function Resolve-LogPrincipal([string]$Name) {
    if ($Name -match '^S-\d-') { return New-Object System.Security.Principal.SecurityIdentifier($Name) }
    $account = $Name
    if ($account -notmatch '\\') { $account = $env:COMPUTERNAME + '\' + $account }
    return (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier])
}

function Assert-LogDirOutsideGate([string]$Dir, [string]$Gate) {
    $sep = [IO.Path]::DirectorySeparatorChar
    $d = [System.IO.Path]::GetFullPath($Dir).TrimEnd('\', '/')
    $g = [System.IO.Path]::GetFullPath($Gate).TrimEnd('\', '/')
    if ($d.Equals($g, [StringComparison]::OrdinalIgnoreCase)) { throw 'launcher log dir must not be the gate dir' }
    if ($d.StartsWith($g + $sep, [StringComparison]::OrdinalIgnoreCase)) { throw 'launcher log dir must not be inside the gate dir' }
    if ($g.StartsWith($d + $sep, [StringComparison]::OrdinalIgnoreCase)) { throw 'launcher log dir must not contain the gate dir' }
    return $d
}

# قائمة الصلاحيات المطلوبة (كائن DirectorySecurity غير مطبَّق)، قابلة للفحص في الاختبار.
function New-LauncherLogDirectorySecurity([System.Security.Principal.SecurityIdentifier[]]$WriterSids) {
    $none = [System.Security.AccessControl.InheritanceFlags]::None
    $both = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $files = [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $noProp = [System.Security.AccessControl.PropagationFlags]::None
    $inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $admins = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $ownerRights = New-Object System.Security.Principal.SecurityIdentifier('S-1-3-4')

    $sec = New-Object System.Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    $sec.SetOwner($admins)
    foreach ($sid in @($system, $admins)) {
        $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $both, $noProp, $allow)))
    }
    foreach ($sid in @($WriterSids)) {
        $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $script:LogWriterDirRights, $none, $noProp, $allow)))
        $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $script:LogWriterFileRights, $files, $inheritOnly, $allow)))
    }
    $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($ownerRights, $script:LogOwnerRightsFile, $files, $inheritOnly, $allow)))
    return $sec
}

function Format-LogAcl($Security) {
    return @($Security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
        $who = $_.IdentityReference.Value
        try { $who = $_.IdentityReference.Translate([System.Security.Principal.NTAccount]).Value } catch { Write-Verbose ('unresolved sid ' + $who) }
        '{0} {1} {2} [{3}; {4}]{5}' -f $_.AccessControlType, $who, $_.FileSystemRights, $_.InheritanceFlags, $_.PropagationFlags, $(if ($_.IsInherited) { ' inherited' } else { '' })
    })
}

function Invoke-LauncherLogAcl([string]$Dir, [string]$Gate, [string[]]$WriterNames, [switch]$DoApply) {
    $full = Assert-LogDirOutsideGate $Dir $Gate
    $sids = @($WriterNames | ForEach-Object { Resolve-LogPrincipal $_ })
    $desired = New-LauncherLogDirectorySecurity $sids
    Write-Host ('launcher log dir: ' + $full)
    if (Test-Path -LiteralPath $full) {
        Write-Host 'current ACL:'
        Format-LogAcl (Get-Acl -LiteralPath $full) | ForEach-Object { Write-Host ('  ' + $_) }
    } else { Write-Host 'current ACL: (directory does not exist)' }
    Write-Host 'desired ACL (protected, owner BUILTIN\Administrators):'
    Format-LogAcl $desired | ForEach-Object { Write-Host ('  ' + $_) }
    if (-not $DoApply) { Write-Host 'PLAN ONLY: nothing changed (pass -Apply as Administrator to apply)'; return 'PLAN' }

    $principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'run -Apply as Administrator' }
    if (-not (Test-Path -LiteralPath $full)) { [void](New-Item -ItemType Directory -Path $full) }
    if (-not (Get-Item -LiteralPath $full).PSIsContainer) { throw ('not a directory: ' + $full) }
    Set-Acl -LiteralPath $full -AclObject $desired
    # الملفات الموجودة مسبقاً (إن وُجدت) تأخذ الصلاحيات الموروثة الجديدة نفسها.
    foreach ($f in @(Get-ChildItem -LiteralPath $full -File -Force)) {
        $fs = New-Object System.Security.AccessControl.FileSecurity
        $fs.SetAccessRuleProtection($false, $false)
        $fs.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
        Set-Acl -LiteralPath $f.FullName -AclObject $fs
    }
    Write-Host 'applied ACL:'
    Format-LogAcl (Get-Acl -LiteralPath $full) | ForEach-Object { Write-Host ('  ' + $_) }
    return 'APPLIED'
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-LauncherLogAcl -Dir $LogDir -Gate $GateDir -WriterNames $Writers -DoApply:$Apply
    Write-Host ('result: ' + $result)
    exit 0
}
