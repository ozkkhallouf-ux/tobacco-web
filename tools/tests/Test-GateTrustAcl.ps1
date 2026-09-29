#Requires -Version 5.1
# ============================================================
# Test-GateTrustAcl.ps1
#
# Codex P1 (#285): gateDirWriters في الإعداد ليس دليلاً. Test-GateTrustAcl يقرأ ACL الفعلية
# (Get-Acl، قراءة فقط) على gateDir وملفات الثقة، ويحجب أي مالك أو ACE يمنح كتابة/تعديلاً/
# تحكماً كاملاً (أو ما يكافئه، ومنه الحقوق العامة والموروثة) لغير هوية البوابة المخصّصة.
# الاختبار ينشئ gateDir مؤقتاً بملفاته ويستبدل قراءة ACL فقط (بلا تعديل صلاحيات حقيقية).
# الهدف إثبات أن ACL الحالية لا تمنح كود المستودع المؤتمت كتابة مباشرة، لا منع مدير بشري.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-GateTrustAcl.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$preflight = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'migration-preflight.ps1')
$exampleConfig = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'gate-config.example.json')

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }

. $preflight

# جدول SID وهمي (ترجمة NTAccount → SID) واسم الجهاز: المقارنة بالـSID لا بالاسم.
$script:SidTable = @{
    'ozk2026\ozk-deploygate' = 'S-1-5-21-111-1001'; 'domain\ozk-deploygate' = 'S-1-5-21-999-1001'
    'ozk2026\loq' = 'S-1-5-21-111-1002'; 'loq' = 'S-1-5-21-111-1002'
    'ozk2026\ozksync' = 'S-1-5-21-111-1003'; 'ozksync' = 'S-1-5-21-111-1003'
    'ozk2026\administrator' = 'S-1-5-21-111-500'
    'ozk-autoprint' = 'S-1-5-21-111-1004'; 'ozk2026\ozk-autoprint' = 'S-1-5-21-111-1004'
    'ozk-readworker' = 'S-1-5-21-111-1005'; 'ozk2026\ozk-readworker' = 'S-1-5-21-111-1005'
}
function Invoke-NtAccountTranslate([string]$Name) { $k = $Name.ToLowerInvariant(); if ($script:SidTable.ContainsKey($k)) { return $script:SidTable[$k] } return $null }
function Get-PreflightMachineName { return 'OZK2026' }

$gateDir = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-gate-acl-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $gateDir | Out-Null
$config = [System.IO.File]::ReadAllText($exampleConfig) | ConvertFrom-Json
$config.gateDir = $gateDir
$sep = [IO.Path]::DirectorySeparatorChar
function Join-Gate([string]$Name) { return ($gateDir.TrimEnd('\', '/') + $sep + $Name) }
# مرسى الثقة في الاختبار: جد gateDir المؤقت (الأب المباشر مستوى صارم، والجد مستوى أسلاف).
$gdTrim = $gateDir.TrimEnd('\', '/')
$parentPath = $gdTrim.Substring(0, $gdTrim.LastIndexOf($sep))
$grandPath = $parentPath.Substring(0, $parentPath.LastIndexOf($sep))
$config.trust | Add-Member -NotePropertyName trustAnchor -NotePropertyValue $grandPath -Force
# أعضاء Administrators المحليين (SID): LOQ وAdministrator. $null = تعذّر التحديد.
$script:Admins = @('S-1-5-21-111-1002', 'S-1-5-21-111-500')
function Get-PreflightAdminMembers { if ($null -eq $script:Admins) { return $null } return @($script:Admins) }
foreach ($f in @($config.trust.requiredTrustFiles) + @('state.json', 'writer-allowlist.json')) { [System.IO.File]::WriteAllText((Join-Gate $f), 'x') }

# ACL وهمية لكل مسار: الافتراضي آمن (الهوية المخصّصة مالكةً وكاتبةً وحيدة، والقرّاء قراءة فقط).
function New-Ace([string]$Identity, [string]$Rights, [string]$Type = 'Allow', [bool]$Inherited = $false, [bool]$InheritOnly = $false) { return [pscustomobject]@{ identity = $Identity; rights = $Rights; type = $Type; inherited = $Inherited; inheritOnly = $InheritOnly } }
function New-SafeAcl { return [pscustomobject]@{ owner = 'OZK2026\OZK-DeployGate'; access = @(
    (New-Ace 'OZK2026\OZK-DeployGate' 'FullControl'),
    (New-Ace 'OZK2026\OZKSync' 'ReadAndExecute, Synchronize' 'Allow' $true),
    (New-Ace 'OZK2026\LOQ' 'ReadAndExecute, Synchronize' 'Allow' $true),
    (New-Ace 'NT AUTHORITY\SYSTEM' 'ReadAndExecute, Synchronize' 'Allow' $true)) } }
$script:Acls = @{}
$script:AclErrors = @{}
function Reset-Acls { $script:Acls = @{}; $script:AclErrors = @{} }
function Get-PreflightAcl([string]$Path) {
    if ($script:AclErrors.ContainsKey($Path)) { throw $script:AclErrors[$Path] }
    if ($script:Acls.ContainsKey($Path)) { return $script:Acls[$Path] }
    return New-SafeAcl
}
function Set-DirAcl($Acl) { $script:Acls[$gateDir.TrimEnd('\', '/')] = $Acl }
function Add-DirAce($Ace) { $a = New-SafeAcl; $a.access = @($a.access) + @($Ace); Set-DirAcl $a }
function Test-Blocked($Report, [string]$Pattern) { return (-not $Report.ok -and @($Report.results | Where-Object { $_.verdict -eq 'BLOCK' -and ($_.task + ' ' + $_.reason) -like $Pattern }).Count -gt 0) }

try {
    Write-Host '== Safe layout'
    Reset-Acls
    $r = Test-GateTrustAcl $config
    Assert-True ($r.ok) 'dedicated gate identity as the only owner and writer => PASS'
    Add-DirAce (New-Ace 'OZK2026\OZKSync' 'Write' 'Deny')
    Assert-True ((Test-GateTrustAcl $config).ok) 'a Deny ACE is not a grant (does not block by itself)'

    Write-Host '== Extra writers block (explicit or inherited)'
    $cases = @(
        @{ label = 'OZKSync Modify inherited => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'Modify, Synchronize' 'Allow' $true); pattern = '*inherited write access for OZK2026\OZKSync*' },
        @{ label = 'LOQ Modify => BLOCK'; ace = (New-Ace 'OZK2026\LOQ' 'Modify, Synchronize'); pattern = '*explicit write access for OZK2026\LOQ*' },
        @{ label = 'Users Modify => BLOCK'; ace = (New-Ace 'BUILTIN\Users' 'Modify'); pattern = '*BUILTIN\Users*' },
        @{ label = 'SYSTEM write => BLOCK (current trust model)'; ace = (New-Ace 'NT AUTHORITY\SYSTEM' 'Write'); pattern = '*NT AUTHORITY\SYSTEM*' },
        @{ label = 'Administrators FullControl => BLOCK (current trust model)'; ace = (New-Ace 'BUILTIN\Administrators' 'FullControl' 'Allow' $true); pattern = '*BUILTIN\Administrators*' },
        @{ label = 'unexpected inherited writer (CREATOR OWNER) => BLOCK'; ace = (New-Ace 'CREATOR OWNER' 'FullControl' 'Allow' $true); pattern = '*CREATOR OWNER*' },
        @{ label = 'GENERIC_WRITE numeric right => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' '1073741824' 'Allow' $true); pattern = '*OZKSync*' },
        @{ label = 'GENERIC_ALL numeric right => BLOCK'; ace = (New-Ace 'Everyone' '268435456' 'Allow' $true); pattern = '*Everyone*' },
        @{ label = 'directory create-files right (WriteData) => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'CreateFiles, Synchronize'); pattern = '*OZKSync*' },
        @{ label = 'ChangePermissions only => BLOCK'; ace = (New-Ace 'OZK2026\LOQ' 'ChangePermissions'); pattern = '*LOQ*' },
        @{ label = 'TakeOwnership only => BLOCK'; ace = (New-Ace 'OZK2026\LOQ' 'TakeOwnership'); pattern = '*LOQ*' },
        @{ label = 'Delete only => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'Delete'); pattern = '*OZKSync*' }
    )
    foreach ($c in $cases) {
        Reset-Acls
        Add-DirAce $c.ace
        Assert-True (Test-Blocked (Test-GateTrustAcl $config) $c.pattern) $c.label
    }
    Reset-Acls
    Add-DirAce (New-Ace 'OZK2026\OZKSync' 'ReadAndExecute, Synchronize' 'Allow' $true)
    Assert-True ((Test-GateTrustAcl $config).ok) 'read-only access for a repo workload identity => allowed'

    Write-Host '== Parent container ACL is part of the trust boundary (Codex P1)'
    $gd = $gateDir.TrimEnd('\', '/')
    $parentPath = $gd.Substring(0, $gd.LastIndexOf($sep))
    function Set-ParentAcl($Acl) { $script:Acls[$parentPath] = $Acl }
    function Add-ParentAce($Ace) { $a = New-SafeAcl; $a.access = @($a.access) + @($Ace); Set-ParentAcl $a }
    Reset-Acls
    $r = Test-GateTrustAcl $config
    Assert-True ($r.ok -and (@($r.results | Where-Object { $_.verdict -eq 'PASS' -and $_.reason -like '*parent container*' }).Count -eq 1)) 'safe parent + safe gateDir + safe trust files => PASS'
    $parentCases = @(
        @{ label = 'parent grants OZKSync Modify => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'Modify, Synchronize') },
        @{ label = 'parent grants LOQ Modify => BLOCK'; ace = (New-Ace 'OZK2026\LOQ' 'Modify, Synchronize') },
        @{ label = 'parent grants Users Modify => BLOCK'; ace = (New-Ace 'BUILTIN\Users' 'Modify') },
        @{ label = 'parent grants create-child (CreateDirectories) => BLOCK'; ace = (New-Ace 'BUILTIN\Users' 'CreateDirectories, Synchronize') },
        @{ label = 'parent grants create-child (CreateFiles/WriteData) => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'CreateFiles') },
        @{ label = 'parent grants delete-child (DeleteSubdirectoriesAndFiles) => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'DeleteSubdirectoriesAndFiles') },
        @{ label = 'parent grants Delete (rename/replace the container) => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'Delete') },
        @{ label = 'parent grants ChangePermissions => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'ChangePermissions') },
        @{ label = 'parent grants TakeOwnership => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'TakeOwnership') },
        @{ label = 'parent grants FullControl => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'FullControl') },
        @{ label = 'parent grants GENERIC_WRITE (numeric) => BLOCK'; ace = (New-Ace 'BUILTIN\Users' '1073741824') },
        @{ label = 'unsafe inherited parent ACE (e.g. from ProgramData) => BLOCK'; ace = (New-Ace 'BUILTIN\Users' 'Write, Synchronize' 'Allow' $true) }
    )
    foreach ($c in $parentCases) {
        Reset-Acls
        Add-ParentAce $c.ace
        Assert-True (Test-Blocked (Test-GateTrustAcl $config) ('*acl parent *' + $c.ace.identity + '*')) $c.label
    }
    Reset-Acls
    Add-ParentAce (New-Ace 'OZK2026\OZKSync' 'ReadAndExecute, Synchronize' 'Allow' $true)
    Assert-True ((Test-GateTrustAcl $config).ok) 'parent read-only access for a repo identity => allowed'
    Reset-Acls
    $a = New-SafeAcl; $a.owner = 'BUILTIN\Administrators'; Set-ParentAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl parent *owner is BUILTIN\Administrators*') 'parent owned by another principal (implicit WRITE_DAC) => BLOCK'
    Reset-Acls
    $script:AclErrors[$parentPath] = 'Attempted to perform an unauthorized operation.'
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl parent *cannot read ACL*') 'parent Get-Acl failure => BLOCK'
    Reset-Acls
    $script:Acls[$parentPath] = $null
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl parent *empty or unreadable*') 'parent ACL empty/unreadable => BLOCK'
    Reset-Acls
    Add-ParentAce (New-Ace 'GHOST\unknown' 'Modify')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl parent *cannot be resolved to a SID*') 'parent write ACE whose identity cannot be resolved => BLOCK'
    Reset-Acls
    Add-ParentAce (New-Ace 'OZK2026\OZKSync' 'NotARight')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl parent *rights cannot be interpreted*') 'parent ACE with uninterpretable rights => BLOCK'
    Reset-Acls
    Add-ParentAce (New-Ace 'OZK2026\OZKSync' 'Modify' 'Audit')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl parent *unrecognised ACE type*') 'parent ACE of an ambiguous type => BLOCK'
    Reset-Acls
    Add-ParentAce (New-Ace 'OZK2026\OZKSync' 'Modify, Synchronize')
    $r = Test-GateTrustAcl $config
    Assert-True (-not $r.ok -and @($r.results | Where-Object { $_.verdict -eq 'BLOCK' -and $_.task -notlike 'acl parent*' }).Count -eq 0) 'safe gateDir and trust files but unsafe parent => BLOCK (inner ACL is not enough)'
    Reset-Acls
    $script:Acls[(Join-Gate 'writer-allowlist.json')] = & { $a = New-SafeAcl; $a.access = @($a.access) + @(New-Ace 'OZK2026\OZKSync' 'Modify'); $a }
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*writer-allowlist.json*OZKSync*') 'unsafe trust file with a safe parent => still BLOCK'
    $cRoot = $config | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $cRoot.gateDir = 'DeployGate'
    Assert-True (Test-Blocked (Test-GateTrustAcl $cRoot) '*no parent container*') 'gateDir without a verifiable parent container => BLOCK'
    Reset-Acls

    Write-Host '== Ancestor chain up to the trust anchor: replacement capability, not exclusivity (Codex P1)'
    # ACL الافتراضية لـC:\ProgramData في Windows: SYSTEM وAdministrators تحكم كامل، CREATOR OWNER للأبناء فقط
    # (InheritOnly)، وUsers قراءة وإنشاء ملفات/مجلدات. المالك SYSTEM.
    function New-ProgramDataAcl { return [pscustomobject]@{ owner = 'S-1-5-18'; access = @(
        (New-Ace 'S-1-5-18' 'FullControl'),
        (New-Ace 'S-1-5-32-544' 'FullControl'),
        (New-Ace 'S-1-3-0' 'FullControl' 'Allow' $false $true),
        (New-Ace 'S-1-5-32-545' 'ReadAndExecute, Synchronize'),
        (New-Ace 'S-1-5-32-545' 'CreateFiles, CreateDirectories, Synchronize')) } }
    function Set-AncestorAcl($Acl) { $script:Acls[$grandPath] = $Acl }
    function Add-AncestorAce($Ace) { $a = New-ProgramDataAcl; $a.access = @($a.access) + @($Ace); Set-AncestorAcl $a }
    Reset-Acls; Set-AncestorAcl (New-ProgramDataAcl)
    $r = Test-GateTrustAcl $config
    Assert-True ($r.ok -and (@($r.results | Where-Object { $_.verdict -eq 'PASS' -and $_.reason -like '*trust anchor*' }).Count -eq 1)) 'normal ProgramData ancestor ACL + protected OZK parent + gateDir => PASS'
    Reset-Acls; Add-AncestorAce (New-Ace 'S-1-5-18' 'FullControl' 'Allow' $true)
    Assert-True ((Test-GateTrustAcl $config).ok) 'normal SYSTEM rights on ProgramData alone => not automatically BLOCK'
    Reset-Acls; Add-AncestorAce (New-Ace 'BUILTIN\Administrators' 'FullControl' 'Allow' $true)
    Assert-True ((Test-GateTrustAcl $config).ok) 'normal Administrators rights alone => not automatically BLOCK (privileged-workload guard stays independent)'
    Reset-Acls; Add-AncestorAce (New-Ace $script:TrustedInstallerSid 'FullControl')
    Assert-True ((Test-GateTrustAcl $config).ok) 'TrustedInstaller rights on the anchor => OS-administrative trust'
    Reset-Acls; Add-AncestorAce (New-Ace 'OZK2026\LOQ' 'FullControl')
    Assert-True ((Test-GateTrustAcl $config).ok) 'a local Administrators member (by SID) on the anchor => OS-administrative trust (its repo workloads are blocked separately)'
    $script:Admins = $null
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*replacement capability for OZK2026\LOQ*') 'Administrators membership undetermined => a member-looking account is not trusted => BLOCK'
    $script:Admins = @('S-1-5-21-111-1002', 'S-1-5-21-111-500')
    Reset-Acls; Add-AncestorAce (New-Ace 'S-1-5-32-545' 'DeleteSubdirectoriesAndFiles')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*replacement capability for S-1-5-32-545*') 'Users can delete/rename children of ProgramData (replace OZK-TOBACCO) => BLOCK'
    $ancCases = @(
        @{ label = 'OZKSync DeleteSubdirectoriesAndFiles on the ancestor => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'DeleteSubdirectoriesAndFiles, Synchronize') },
        @{ label = 'OZKSync Modify on the ancestor (includes Delete: the level itself can be renamed away) => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'Modify, Synchronize') },
        @{ label = 'ordinary non-admin (OZK-ReadWorker) Delete => BLOCK'; ace = (New-Ace 'OZK-ReadWorker' 'Delete') },
        @{ label = 'ordinary non-admin ChangePermissions (WRITE_DAC) => BLOCK'; ace = (New-Ace 'OZK-ReadWorker' 'ChangePermissions') },
        @{ label = 'ordinary non-admin TakeOwnership (WRITE_OWNER) => BLOCK'; ace = (New-Ace 'OZK-ReadWorker' 'TakeOwnership') },
        @{ label = 'ordinary non-admin FullControl => BLOCK'; ace = (New-Ace 'OZK2026\OZKSync' 'FullControl') },
        @{ label = 'GENERIC_ALL (numeric) for Everyone => BLOCK'; ace = (New-Ace 'S-1-1-0' '268435456') },
        @{ label = 'inherited unsafe ancestor ACE => BLOCK'; ace = (New-Ace 'S-1-5-11' 'DeleteSubdirectoriesAndFiles' 'Allow' $true) },
        @{ label = 'effective (not inherit-only) CREATOR OWNER FullControl => BLOCK (fail closed)'; ace = (New-Ace 'S-1-3-0' 'FullControl') }
    )
    foreach ($c in $ancCases) {
        Reset-Acls; Add-AncestorAce $c.ace
        Assert-True (Test-Blocked (Test-GateTrustAcl $config) ('*acl ancestor*' + $c.ace.identity + '*')) $c.label
    }
    Reset-Acls; Add-AncestorAce (New-Ace 'S-1-5-32-545' 'CreateDirectories, CreateFiles, WriteAttributes, Synchronize')
    Assert-True ((Test-GateTrustAcl $config).ok) 'create-only / WriteAttributes on the ancestor cannot replace an existing non-empty container => not a replacement capability'
    Reset-Acls; Add-AncestorAce (New-Ace 'S-1-5-32-545' '1073741824')
    Assert-True ((Test-GateTrustAcl $config).ok) 'GENERIC_WRITE (maps to create/write data, no delete/WRITE_DAC) on the ancestor => not a replacement capability'
    Reset-Acls; Add-AncestorAce (New-Ace 'OZK2026\OZKSync' 'FullControl' 'Allow' $true $true)
    Assert-True ((Test-GateTrustAcl $config).ok) 'inherit-only ACE does not apply to the ancestor itself (its children are checked with their own actual ACLs)'
    Reset-Acls; Add-AncestorAce (New-Ace 'OZK2026\OZKSync' 'DeleteSubdirectoriesAndFiles' 'Deny')
    Assert-True ((Test-GateTrustAcl $config).ok) 'a Deny ACE is not a grant'
    Reset-Acls; $a = New-ProgramDataAcl; $a.owner = 'OZK2026\OZKSync'; Set-AncestorAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*owner is OZK2026\OZKSync*') 'ancestor owned by an untrusted principal (implicit WRITE_DAC) => BLOCK'
    Reset-Acls; $a = New-ProgramDataAcl; $a.owner = 'GHOST\owner'; Set-AncestorAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*owner cannot be resolved*') 'ancestor owner that cannot be resolved => BLOCK'
    Reset-Acls; $script:AclErrors[$grandPath] = 'Attempted to perform an unauthorized operation.'
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*cannot read ACL*') 'unreadable ancestor ACL => BLOCK'
    Reset-Acls; $script:Acls[$grandPath] = $null
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*empty or unreadable*') 'empty ancestor ACL => BLOCK'
    Reset-Acls; Add-AncestorAce (New-Ace 'GHOST\someone' 'DeleteSubdirectoriesAndFiles')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*cannot be resolved to a SID*') 'replacement-capable ACE with an unresolvable identity => BLOCK'
    Reset-Acls; Add-AncestorAce (New-Ace 'GHOST\someone' 'ReadAndExecute')
    Assert-True ((Test-GateTrustAcl $config).ok) 'unresolvable identity with read-only rights is irrelevant to replacement'
    Reset-Acls; Add-AncestorAce (New-Ace 'S-1-5-32-545' 'NotARight')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*rights cannot be interpreted*') 'malformed ancestor rights => BLOCK'
    Reset-Acls; Add-AncestorAce (New-Ace 'S-1-5-32-545' 'FullControl' 'Audit')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*acl ancestor*unrecognised ACE type*') 'ambiguous ancestor ACE type => BLOCK'
    # سلسلة من مستويين: المرسى جدّ الجد، والمستوى الوسيط يُفحص أيضاً.
    $greatPath = $grandPath.Substring(0, $grandPath.LastIndexOf($sep))
    $c2 = $config | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $c2.trust.trustAnchor = $greatPath
    Reset-Acls; $script:Acls[$greatPath] = New-ProgramDataAcl
    Assert-True ((Test-GateTrustAcl $c2).ok) 'two ancestor levels, both safe => PASS'
    Reset-Acls; $a = New-ProgramDataAcl; $a.access = @($a.access) + @(New-Ace 'OZK2026\OZKSync' 'DeleteSubdirectoriesAndFiles'); $script:Acls[$greatPath] = $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $c2) ('*acl ancestor ' + $greatPath + '*OZKSync*')) 'unsafe ACE on the upper ancestor (anchor) => BLOCK'
    Reset-Acls; $a = New-ProgramDataAcl; $a.access = @($a.access) + @(New-Ace 'OZK2026\OZKSync' 'Delete'); $script:Acls[$grandPath] = $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $c2) ('*acl ancestor ' + $grandPath + '*OZKSync*')) 'unsafe ACE on the intermediate ancestor => BLOCK'
    # حدود المرسى.
    $c3 = $config | ConvertTo-Json -Depth 10 | ConvertFrom-Json; $c3.trust.trustAnchor = ''
    Assert-True (Test-Blocked (Test-GateTrustAcl $c3) '*no trust anchor configured*') 'no trust anchor configured => BLOCK'
    $c3.trust.trustAnchor = ($sep + 'elsewhere' + $sep + 'root')
    Assert-True (Test-Blocked (Test-GateTrustAcl $c3) '*is not an ancestor above the immediate parent*') 'trust anchor that is not an ancestor => BLOCK'
    $c3.trust.trustAnchor = $parentPath
    Assert-True (Test-Blocked (Test-GateTrustAcl $c3) '*is not an ancestor above the immediate parent*') 'trust anchor equal to the immediate parent => BLOCK (the parent stays exclusive)'
    Reset-Acls

    Write-Host '== Owner, unreadable and malformed ACLs fail closed'
    Reset-Acls
    $a = New-SafeAcl; $a.owner = 'BUILTIN\Administrators'; Set-DirAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*owner is BUILTIN\Administrators*') 'owner other than the dedicated identity (implicit permission rights) => BLOCK'
    Reset-Acls
    $a = New-SafeAcl; $a.owner = ''; Set-DirAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*owner cannot be determined*') 'undeterminable owner => BLOCK'
    Reset-Acls
    $script:AclErrors[$gateDir.TrimEnd('\', '/')] = 'Attempted to perform an unauthorized operation.'
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*cannot read ACL*') 'Get-Acl failure => BLOCK'
    Reset-Acls
    Add-DirAce (New-Ace 'OZK2026\OZKSync' 'SomethingNew')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*rights cannot be interpreted*') 'malformed rights value => BLOCK'
    Reset-Acls
    Add-DirAce (New-Ace 'OZK2026\OZKSync' 'Modify' 'Audit')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*unrecognised ACE type*') 'unrecognised ACE type => BLOCK'
    Reset-Acls
    Add-DirAce (New-Ace 'S-1-5-21-1099337571-2624187221-2671595926-1012' 'Modify')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*S-1-5-21-*') 'unresolved SID with write rights => BLOCK'
    Reset-Acls
    Add-DirAce (New-Ace '' 'Modify')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*unresolvable identity*') 'write ACE with an empty identity => BLOCK'
    Reset-Acls
    $script:Acls[$gateDir.TrimEnd('\', '/')] = $null
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*empty or unreadable*') 'empty ACL object => BLOCK'

    Write-Host '== Trust files are checked individually'
    Reset-Acls
    $f = New-SafeAcl; $f.access = @($f.access) + @(New-Ace 'OZK2026\OZKSync' 'Write'); $script:Acls[(Join-Gate 'writer-allowlist.json')] = $f
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*writer-allowlist.json*OZKSync*') 'trust file more permissive than gateDir => BLOCK'
    Reset-Acls
    $f = New-SafeAcl; $f.owner = 'OZK2026\LOQ'; $script:Acls[(Join-Gate 'deploy-gate.ps1')] = $f
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*deploy-gate.ps1*owner is OZK2026\LOQ*') 'gateDir safe but one trust file unsafe (owner) => BLOCK'
    Reset-Acls
    $script:AclErrors[(Join-Gate 'state.json')] = 'Access is denied'
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*state.json*cannot read ACL*') 'Get-Acl failure on one trust file => BLOCK'
    Reset-Acls
    Remove-Item -LiteralPath (Join-Gate 'notify.ps1')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*trust file notify.ps1*missing*') 'a required trust file missing => BLOCK'
    [System.IO.File]::WriteAllText((Join-Gate 'notify.ps1'), 'x')
    Remove-Item -LiteralPath (Join-Gate 'state.json')
    Assert-True ((Test-GateTrustAcl $config).ok) 'state files not created yet (before Initialize) => governed by the gateDir ACL'

    Write-Host '== SID comparison, not account names (Codex P1)'
    Reset-Acls
    $a = New-SafeAcl; $a.owner = 'DOMAIN\OZK-DeployGate'; Set-DirAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*owner is DOMAIN\OZK-DeployGate*S-1-5-21-999-1001*') 'owner DOMAIN\OZK-DeployGate (different SID from OZK2026\OZK-DeployGate) => BLOCK'
    Reset-Acls
    Add-DirAce (New-Ace 'DOMAIN\OZK-DeployGate' 'Modify')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*write access for DOMAIN\OZK-DeployGate*') 'write ACE for DOMAIN\OZK-DeployGate (same basename, different SID) => BLOCK'
    Reset-Acls
    $a = New-SafeAcl; $a.owner = 'S-1-5-21-111-1001'; $a.access = @((New-Ace 'ozk2026\ozk-deploygate' 'FullControl'), (New-Ace 'OZK2026\OZKSync' 'ReadAndExecute, Synchronize' 'Allow' $true)); Set-DirAcl $a
    Assert-True ((Test-GateTrustAcl $config).ok) 'same gate SID in different forms (SID owner, lowercase qualified ACE) => PASS'
    Reset-Acls
    Add-DirAce (New-Ace 'GHOST\nobody' 'Write')
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*cannot be resolved to a SID: GHOST\nobody*') 'write ACE whose principal cannot be resolved to a SID => BLOCK'
    Reset-Acls
    $a = New-SafeAcl; $a.owner = 'GHOST\nobody'; Set-DirAcl $a
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*owner cannot be resolved to a SID*') 'owner that cannot be resolved to a SID => BLOCK'
    Reset-Acls
    $saved = $config.trust.gateAccount
    $config.trust.gateAccount = 'OZK2026\missing-gate'
    Assert-True (Test-Blocked (Test-GateTrustAcl $config) '*gate identity cannot be resolved to a SID*') 'gate identity that cannot be resolved to a SID => BLOCK'
    $config.trust.gateAccount = $saved

    Write-Host '== Install preflight includes the ACL check'
    function Invoke-MigrationPreflight($Config) { return [pscustomobject]@{ ok = $true; results = @() } }
    function Invoke-GateIdentityPreflight($Config) { return [pscustomobject]@{ ok = $true; results = @() } }; function Test-GitHookSafety($Config) { return [pscustomobject]@{ ok = $true; results = @() } }
    Reset-Acls
    Assert-True ((Invoke-InstallPreflight $config).ok) 'install preflight passes with a safe ACL'
    Add-DirAce (New-Ace 'OZK2026\OZKSync' 'Modify' 'Allow' $true)
    Assert-True (-not (Invoke-InstallPreflight $config).ok) 'install preflight (Initialize) blocked by an unsafe actual ACL even when config declares the dedicated writer only'
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
} finally {
    Remove-Item -LiteralPath $gateDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    Write-Host ("Gate trust ACL: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Gate trust ACL: all checks passed' -ForegroundColor Green
exit 0
