#Requires -Version 5.1
# ============================================================
# Test-GateIdentityPreflight.ps1
#
# Codex P1 (#285): SYSTEM ليست حدود ثقة للبوابة لأن OZK-AmeenAutoPrint يشغّل
# tools/ameen-autoprint/run-watcher.bat من المستودع بحساب SYSTEM (install-service.bat)،
# وLOQ عضو Administrators يشغّل مهام المستودع، وOZKSync كذلك. البوابة تعمل بهوية مخصّصة
# لا تشغّل أي كود من أي مستودع. الاختبار يستبدل جرد المهام/الخدمات فقط، ويحاكي
# التخطيط الحالي على OZK2026.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-GateIdentityPreflight.ps1
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

# هوية المسار في نظام الملفات: الاختبارات هنا تستعمل مسارات Windows وهمية، فالمحلّل الأصلي (native) يُستبدل
# بنموذج: الافتراضي = المسار نفسه موجود (OK)، وجداول لـjunction/alias، والمفقود، وفشل الحل. سلوك المحلّل
# الحقيقي مع junction فعلية يُختبر في Test-GatePathIdentity.ps1 على Windows.
# ACL الأغلفة (ثقة نظام الملفات): الافتراضي ACL موثوقة (المالك SYSTEM، وSYSTEM/Administrators تحكم كامل،
# وUsers قراءة)، مع جداول لتجاوزها في اختبارات الثقة.
$script:FsAcls = @{}
$script:FsAclErrors = @{}
function Resolve-TestAclKey([string]$Path) { return (ConvertTo-CanonicalTracePath $Path) }
function Get-PreflightAcl([string]$Path) {
    $k = Resolve-TestAclKey $Path
    if ($script:FsAclErrors.ContainsKey($k)) { throw $script:FsAclErrors[$k] }
    if ($script:FsAcls.ContainsKey($k)) { return $script:FsAcls[$k] }
    return [pscustomobject]@{ owner = 'S-1-5-18'; access = @(
        [pscustomobject]@{ identity = 'S-1-5-18'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $false },
        [pscustomobject]@{ identity = 'S-1-5-32-544'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $false },
        [pscustomobject]@{ identity = 'S-1-3-0'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $true },
        [pscustomobject]@{ identity = 'S-1-5-32-545'; rights = 'ReadAndExecute, Synchronize'; type = 'Allow'; inherited = $true; inheritOnly = $false }) }
}
# بحث الملفات التنفيذية بالاسم المجرّد: PATH النظام والمستخدم ومجلد Windows نماذج قابلة للضبط.
$script:SysPath = 'C:\Windows\system32;C:\Windows;C:\Program Files\nodejs;'
$script:SysPathError = $null
$script:UserPaths = @{}
$script:UserPathErrors = @{}
function Get-PreflightWindowsDirectory { return 'C:\Windows' }
function Get-PreflightSystemPath { if ($script:SysPathError) { throw $script:SysPathError }; return $script:SysPath }
function Get-PreflightUserPath([string]$Sid) { if ($script:UserPathErrors.ContainsKey($Sid)) { throw $script:UserPathErrors[$Sid] }; if ($script:UserPaths.ContainsKey($Sid)) { return $script:UserPaths[$Sid] }; return '' }
$script:FsExistOnly = $null
$script:FsAliases = [ordered]@{}
$script:FsMissing = @{}
$script:FsErrors = @{}
function Resolve-PreflightFinalPath([string]$Path) {
    $k = ConvertTo-CanonicalTracePath $Path
    foreach ($e in @($script:FsErrors.Keys)) { if ($k -eq $e -or $k.StartsWith($e + '\')) { return (New-PathResolution 'ERROR' '' $script:FsErrors[$e]) } }
    for ($hop = 0; $hop -lt 8; $hop++) { $moved = $false; foreach ($a in @($script:FsAliases.Keys)) { if ($k -eq $a -or $k.StartsWith($a + '\')) { $k = ([string]$script:FsAliases[$a]).ToLowerInvariant() + $k.Substring($a.Length); $moved = $true; break } }; if (-not $moved) { break } }
    if ($script:FsMissing.ContainsKey($k)) { return (New-PathResolution 'MISSING' $k ('does not exist: ' + $Path)) }
    if ($null -ne $script:FsExistOnly) { if (-not ($script:FsExistOnly.ContainsKey($k) -or $k -match '^[a-z]:$' -or @($script:FsExistOnly.Keys | Where-Object { $_.StartsWith($k + '\') -or ($_.EndsWith('\*') -and ($k + '\').StartsWith($_.Substring(0, $_.Length - 1))) }).Count -gt 0)) { return (New-PathResolution 'MISSING' $k ('does not exist: ' + $Path)) } }
    if ($k -eq (ConvertTo-CanonicalTracePath $Path)) { return (New-PathResolution 'OK' $Path) }
    return (New-PathResolution 'OK' $k)
}

$script:Tasks = @()
$script:Services = @()
# أعضاء Administrators المحليين على OZK2026 (LOQ عضو). $null = تعذّر التحديد.
$script:Admins = @('OZK2026\LOQ', 'OZK2026\Administrator')
function Get-PreflightAdminMembers { if ($null -eq $script:Admins) { return $null } return @($script:Admins) }
function Get-PreflightTaskInventory { return @($script:Tasks) }
function Get-PreflightServiceInventory { return @($script:Services) }
# جرد Startup/Logon (مجلدات Startup وRun/RunOnce) — فارغ افتراضياً، وتضبطه الاختبارات.
$script:Startup = @()
function Get-PreflightStartupInventory { return @($script:Startup) }
function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return $null }

$repo = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web'
$gateDir = 'C:\ProgramData\OZK-TOBACCO\DeployGate'
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$autoprintVbs = 'C:\ProgramData\OZK-TOBACCO\TaskWrappers\ozk-ameen-autoprint-hidden.vbs'
$script:Wrappers = @{ $autoprintVbs = ('shell.Run """' + $repo + '\tools\ameen-autoprint\run-watcher.bat""", 0, True') }
# أغلفة/أهداف موجودة بمحتوى معروف غير مستودعي. أي مسار غير مدرج هنا = ملف مفقود ($null) ⇒ UNKNOWN.
$script:Wrappers['C:\ProgramData\OZK-TOBACCO\TaskWrappers\tobacco-ameen-backup-monitor-hidden.vbs'] = 'CreateObject("WScript.Shell").Run """C:\Tools\backup\monitor.exe""", 0, True'
$script:Wrappers['C:\ProgramData\OZK-TOBACCO\TaskWrappers\helper.cmd'] = '@echo off' + "`r`n" + '"C:\Tools\backup\run-backup.exe" /quiet'
$script:Wrappers['c:\tools\svc\server.js'] = 'require("http").createServer(() => {}).listen(8080)'
$script:Wrappers['C:\Tools\report.ps1'] = 'Get-Date | Out-File C:\Logs\report.txt'
$script:Wrappers['c:\tools\report.ps1'] = 'Get-Date | Out-File C:\Logs\report.txt'

function New-Task([string]$Name, [string]$Identity, [string]$Action, $Actions = $null) {
    if ($null -eq $Actions) {
        $m = [regex]::Match($Action, '^\s*("[^"]+"|\S+)\s*(.*)$')
        $Actions = @([pscustomobject]@{ execute = $m.Groups[1].Value.Trim('"'); arguments = $m.Groups[2].Value })
    }
    # كما في الجرد الفعلي: UserId ⇒ USER، ولا هوية ⇒ UNKNOWN؛ RunLevel افتراضي LeastPrivilege.
    $pt = 'USER'; if (-not $Identity) { $pt = 'UNKNOWN' }
    return [pscustomobject]@{ name = $Name; path = '\'; identity = $Identity; principalType = $pt; userId = $Identity; groupId = ''; runLevel = 'LeastPrivilege'; state = 'Ready'; action = $Action; actions = @($Actions) }
}
# مهمة البوابة بـAction منظَّم (المفسّر + الوسائط كما في Task Scheduler).
$approvedPs = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
function New-GateTask([string]$Execute, [string]$Arguments, [string]$Identity = 'OZK2026\OZK-DeployGate', [string]$State = 'Disabled') {
    $t = New-Task 'TOBACCO Windows Deploy Gate' $Identity ($Execute + ' ' + $Arguments) @([pscustomobject]@{ execute = $Execute; arguments = $Arguments })
    $t.state = $State
    return $t
}
# خدمات Windows عادية (غير مستودع) — الجرد الفارغ يحجب، فالتخطيطات تحمل خدمات حقيقية الشكل.
function Get-BaselineServices { return @([pscustomobject]@{ name = 'Winmgmt'; identity = 'LocalSystem'; action = 'C:\Windows\system32\svchost.exe -k netsvcs' }, [pscustomobject]@{ name = 'sshd'; identity = 'LocalSystem'; action = 'C:\Windows\System32\OpenSSH\sshd.exe' }) }
$script:Services = @(Get-BaselineServices)
# التخطيط الحالي على OZK2026 (من جرد قراءة فقط).
function Get-CurrentLayout {
    return @(
        (New-Task 'OZK-AmeenAutoPrint' 'SYSTEM' ('wscript.exe "' + $autoprintVbs + '"')),
        (New-Task 'TOBACCO Ameen Read Worker' 'LOQ' ($ps + ' -File "' + $repo + '\tools\ameen-read-worker.ps1"')),
        (New-Task 'TOBACCO Khalil Audit Sync' 'LOQ' ('powershell.exe -File "' + $repo + '\tools\push-khalil-audit-log.ps1"')),
        (New-Task 'TOBACCO Customer Movements Push' 'OZKSync' ($ps + ' -File "' + $repo + '\tools\push-customer-movements.ps1"')),
        (New-Task 'TOBACCO Approved Prices Pull' 'OZKSync' ('powershell.exe -File "' + $repo + '\tools\sync-approved-prices-to-ameen.ps1" -Apply')),
        (New-Task 'TOBACCO Ameen Backup Monitor' 'SYSTEM' ('wscript.exe "C:\ProgramData\OZK-TOBACCO\TaskWrappers\tobacco-ameen-backup-monitor-hidden.vbs"'))
    )
}

# تخطيط مستقبلي «نظيف»: كل repo workloads بهويات عادية غير إدارية (للتحقق من حالة eligible).
function Get-ValidGateTask { return New-GateTask $approvedPs ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $gateDir + '\deploy-gate.ps1" -Mode DryRun') }
function Get-CleanLayout([switch]$NoGate) {
    $gt = @()
    if (-not $NoGate) { $gt = @(Get-ValidGateTask) }
    return @($gt) + @(
        (New-Task 'OZK-AmeenAutoPrint' 'OZK-AutoPrint' ('wscript.exe "' + $autoprintVbs + '"')),
        (New-Task 'TOBACCO Ameen Read Worker' 'OZK-ReadWorker' ($ps + ' -File "' + $repo + '\tools\ameen-read-worker.ps1"')),
        (New-Task 'TOBACCO Customer Movements Push' 'OZKSync' ($ps + ' -File "' + $repo + '\tools\push-customer-movements.ps1"')),
        (New-Task 'TOBACCO Ameen Backup Monitor' 'SYSTEM' ('wscript.exe "C:\ProgramData\OZK-TOBACCO\TaskWrappers\tobacco-ameen-backup-monitor-hidden.vbs"'))
    )
}

$base = [System.IO.File]::ReadAllText($exampleConfig) | ConvertFrom-Json
function New-Config([string]$Account, [string[]]$Writers) {
    $c = $base | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $c.repoPath = $repo
    $c.gateDir = $gateDir
    $c.trust.gateAccount = $Account
    if ($Writers) { $c.trust.gateDirWriters = $Writers } else { $c.trust.gateDirWriters = @($Account) }
    return $c
}
function Get-Blocks($Report) { return @($Report.results | Where-Object { $_.verdict -eq 'BLOCK' }) }
function Test-BlockLike($Report, [string]$Pattern) { return (@(Get-Blocks $Report | Where-Object { ($_.task + ' ' + $_.reason) -like $Pattern }).Count -gt 0) }

try {
    Write-Host '== Rejected identities (current OZK2026 layout)'
    $script:Tasks = Get-CurrentLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'SYSTEM' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden gate identity*') -and (Test-BlockLike $r '*OZK-AmeenAutoPrint*reused*')) 'SYSTEM as gate identity + AutoPrint repo workload as SYSTEM => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'NT AUTHORITY\SYSTEM' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*')) 'NT AUTHORITY\SYSTEM spelling => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'S-1-5-18' @())
    Assert-True (-not $r.ok) 'SYSTEM SID S-1-5-18 => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\LOQ' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*') -and (Test-BlockLike $r '*Read Worker*reused*')) 'LOQ (admin running repo tasks) reused as gate identity => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'LOQ' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*must be machine-qualified*')) 'bare (unqualified) gate account name => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\LOQ' @())
    Assert-True (-not $r.ok) 'machine-qualified OZK2026\LOQ => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZKSync' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*') -and (Test-BlockLike $r '*Customer Movements*reused*')) 'OZKSync reused as gate identity => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'BUILTIN\Administrators' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*')) 'Administrators as gate identity => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config '' @())
    Assert-True (-not $r.ok) 'no gate identity configured => BLOCK'

    Write-Host '== Privileged repository workloads block installation (regardless of ACL writers)'
    $script:Tasks = Get-CurrentLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok) 'current modeled OZK2026 layout with the dedicated identity => BLOCKED'
    Assert-True (Test-BlockLike $r '*OZK-AmeenAutoPrint*privileged repository workload*SYSTEM*') 'blocking workload: OZK-AmeenAutoPrint -> SYSTEM -> repo code'
    Assert-True ((Test-BlockLike $r '*Read Worker*member of local Administrators*') -and (Test-BlockLike $r '*Khalil Audit*member of local Administrators*')) 'blocking workloads: LOQ (Administrators member) repo tasks'
    Assert-True (-not (Test-BlockLike $r '*Customer Movements*privileged*')) 'ordinary non-admin OZKSync repo workload is not blocked for privilege'
    Assert-True (-not (Test-BlockLike $r '*Backup Monitor*')) 'privileged task unrelated to any repo is not blocked just for being privileged'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Repo As SYSTEM' 'NT AUTHORITY\SYSTEM' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Repo As SYSTEM*privileged*')) 'SYSTEM repo workload, even with no trust-file write ACL => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Repo As Admin' 'OZK2026\Administrator' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Repo As Admin*member of local Administrators*')) 'Administrator repo workload, even with no trust-file write ACL => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Repo As LOQ' 'LOQ' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Repo As LOQ*member of local Administrators*')) 'LOQ as Administrators member running a repo workload => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Repo As Group' 'BUILTIN\Administrators' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Repo As Group*privileged*')) 'repo workload running as the Administrators group => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Repo As Gate' 'OZK2026\OZK-DeployGate' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Repo As Gate*reused*')) 'dedicated gate identity used by a repo workload => BLOCK'
    $script:Tasks = Get-CleanLayout
    $script:Admins = $null
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*cannot determine whether*local administrator*')) 'cannot determine whether a repo workload identity is admin => FAIL CLOSED'
    $script:Admins = @('OZK2026\LOQ', 'OZK2026\Administrator')
    $script:Services = @(Get-BaselineServices) + @([pscustomobject]@{ name = 'ozk-print-svc'; identity = 'LocalSystem'; action = ('"C:\Program Files\nodejs\node.exe" "' + $repo + '\tools\ameen-autoprint\watcher.js"') })
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*service ozk-print-svc*privileged*')) 'a service running repo code as LocalSystem => BLOCK'
    $script:Services = @(Get-BaselineServices)

    Write-Host '== Dedicated identity (clean future layout: no privileged repo workloads)'
    $script:Tasks = Get-CleanLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'ordinary non-admin repo workloads only + dedicated identity unused => eligible'
    $script:Tasks = @(Get-CleanLayout -NoGate) + @(New-GateTask $approvedPs ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $gateDir + '\deploy-gate.ps1" -Mode DryRun'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'the gate task itself under the dedicated identity running only gateDir scripts => eligible'
    $script:Tasks = @(Get-CleanLayout -NoGate) + @(New-GateTask $approvedPs ('-File "' + $repo + '\tools\deploy-gate\deploy-gate.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*gate task must run only*')) 'the gate task running the repository copy of the gate => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'TOBACCO Item Costs Push' 'OZK2026\OZK-DeployGate' ($ps + ' -File "' + $repo + '\tools\push-item-costs.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Item Costs*reused*')) 'dedicated identity also assigned to one repo task => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Some Maintenance' 'OZK2026\OZK-DeployGate' 'C:\Tools\cleanup.exe')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*reused*')) 'dedicated identity reused by any other task (even non-repo) => BLOCK'
    $script:Tasks = Get-CleanLayout
    $script:Services = @(Get-BaselineServices) + @([pscustomobject]@{ name = 'ozk-repo-svc'; identity = '.\OZK-DeployGate'; action = ('"C:\Program Files\nodejs\node.exe" "' + $repo + '\scripts\serve.mjs"') })
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*service ozk-repo-svc*')) 'a service running repo code under the dedicated identity => BLOCK'
    $script:Services = @(Get-BaselineServices)

    Write-Host '== Trust file writers and unverifiable identities'
    $script:Tasks = Get-CleanLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @('OZK2026\OZK-DeployGate', 'BUILTIN\Administrators'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*writable by the dedicated gate identity only*')) 'Administrators as a trust-file writer is not an accepted boundary => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @('OZK2026\OZK-DeployGate', 'OZKSync'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Customer Movements*may write the gate trust files*')) 'a repo workload identity among trust-file writers => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Unknown Principal' '' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and ((Test-BlockLike $r '*identity not verifiable*') -or (Test-BlockLike $r '*Unknown Principal*principal type cannot be determined*'))) 'unknown/unverifiable task identity => fail closed'
    $script:Tasks = @()
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*no scheduled tasks visible*')) 'no visible tasks (not run as administrator) => fail closed'

    Write-Host '== Enumeration failure fails closed'
    $script:ThrowTasks = $true
    function Get-PreflightTaskInventory { if ($script:ThrowTasks) { throw 'Access is denied' } return @($script:Tasks) }
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*cannot enumerate tasks/services*')) 'inability to enumerate tasks => FAIL CLOSED'
    $script:ThrowTasks = $false
    function Get-PreflightServiceInventory { throw 'RPC server unavailable' }
    $script:Tasks = Get-CleanLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*cannot enumerate tasks/services*')) 'inability to enumerate services => FAIL CLOSED'
    function Get-PreflightServiceInventory { return @($script:Services) }

    Write-Host '== \Microsoft\ task path grants no exemption'
    function New-MsTask([string]$Name, [string]$Identity, [string]$Action) { $t = New-Task $Name $Identity $Action; $t | Add-Member -NotePropertyName path -NotePropertyValue '\Microsoft\Windows\Maintenance\' -Force; return $t }
    $msWrapper = 'C:\Windows\System32\Tasks\ms-maintenance.cmd'
    $msWrapper2 = 'C:\ProgramData\Microsoft\Helpers\stage2.vbs'
    $script:Wrappers[$msWrapper] = ('call "' + $msWrapper2 + '"')
    $script:Wrappers[$msWrapper2] = ('shell.Run """' + $repo + '\tools\push-item-costs.ps1""", 0, True')
    $msCases = @(
        @{ label = 'Microsoft-path + SYSTEM + direct repo script => BLOCK'; t = (New-MsTask 'Ms Repo System' 'SYSTEM' ($ps + ' -File "' + $repo + '\tools\x.ps1"')); ok = $false; pattern = '*Ms Repo System*privileged*' },
        @{ label = 'Microsoft-path + admin + direct repo script => BLOCK'; t = (New-MsTask 'Ms Repo Admin' 'OZK2026\Administrator' ($ps + ' -File "' + $repo + '\tools\x.ps1"')); ok = $false; pattern = '*Ms Repo Admin*member of local Administrators*' },
        @{ label = 'Microsoft-path + SYSTEM + wrapper chain -> repo script => BLOCK'; t = (New-MsTask 'Ms Wrapper' 'SYSTEM' ('cmd.exe /c "' + $msWrapper + '"')); ok = $false; pattern = '*Ms Wrapper*privileged*' },
        @{ label = 'Microsoft-path + SYSTEM + working directory in the repo => BLOCK'; t = (New-MsTask 'Ms WorkDir' 'SYSTEM' ('node.exe serve.mjs ' + $repo)); ok = $false; pattern = '*Ms WorkDir*privileged*' },
        @{ label = 'Microsoft-path + LOQ + %USERPROFILE% path into repo roots => BLOCK'; t = (New-MsTask 'Ms EnvVar' 'LOQ' ($ps + ' -File "%USERPROFILE%\Documents\OZK-TOBACCO\tobacco-web\tools\x.ps1"')); ok = $false; pattern = '*Ms EnvVar*member of local Administrators*' },
        @{ label = 'Microsoft-path + ordinary non-admin repo workload => evaluated normally (not skipped, not blocked for privilege)'; t = (New-MsTask 'Ms Ordinary' 'OZKSync' ($ps + ' -File "' + $repo + '\tools\x.ps1"')); ok = $true; pattern = '' },
        @{ label = 'Microsoft-path + unrelated native Windows task (SYSTEM) => ignored by the repo privilege guard'; t = (New-MsTask 'Ms Native' 'SYSTEM' '%windir%\system32\sc.exe start w32time task_started'); ok = $true; pattern = '' }
    )
    foreach ($c in $msCases) {
        $script:Tasks = @(Get-CleanLayout) + @($c.t)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        if ($c.ok) { Assert-True ($r.ok) $c.label } else { Assert-True (-not $r.ok -and (Test-BlockLike $r $c.pattern)) $c.label }
    }
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Ordinary As Gate Writer' 'OZKSync' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @('OZK2026\OZK-DeployGate', 'OZKSync'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Ms Ordinary As Gate Writer*may write the gate trust files*')) 'Microsoft-path ordinary repo workload is still evaluated by the other rules (writer check)'
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Unknown Identity' '' '%windir%\system32\defrag.exe -c')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'native Microsoft task with no repository reference and no identity => not blocked just for existing'
    function Read-PreflightWrapperText([string]$Path) { if ($Path -eq $msWrapper) { throw 'Access is denied' } if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return $null }
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Unreadable Wrapper' 'SYSTEM' ('cmd.exe /c "' + $msWrapper + '"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Ms Unreadable Wrapper*cannot determine whether*')) 'privileged Microsoft-path task whose wrapper cannot be read => FAIL CLOSED'
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Unreadable Wrapper NonAdmin' 'OZKSync' ('cmd.exe /c "' + $msWrapper + '"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'non-privileged task with an unreadable wrapper is not a privilege risk'
    function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return $null }
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Unknown Var' 'SYSTEM' ($ps + ' -File "%OZK_SECRET_ROOT%\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Ms Unknown Var*cannot determine whether*')) 'privileged task with an unknown environment variable path => FAIL CLOSED'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Non-Microsoft Repo System' 'SYSTEM' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    Assert-True (-not (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'non-Microsoft privileged repo workload remains BLOCK'

    Write-Host '== environment references inside wrapper bodies fail closed (Codex P1)'
    $wd = 'C:\ProgramData\OZK-TOBACCO\TaskWrappers'
    $envCases = @(
        @{ label = 'SYSTEM cmd wrapper with unresolved %OZK_ROOT% => BLOCK'; path = "$wd\env-pct.cmd"; body = '@echo off' + "`r`n" + 'powershell.exe -File "%OZK_ROOT%\tools\x.ps1"'; ok = $false },
        @{ label = 'SYSTEM cmd wrapper with unresolved !OZK_ROOT! => BLOCK'; path = "$wd\env-bang.cmd"; body = 'setlocal EnableDelayedExpansion' + "`r`n" + 'call "!OZK_ROOT!\tools\x.bat"'; ok = $false },
        @{ label = 'SYSTEM PS1 wrapper with unresolved $env:OZK_ROOT => BLOCK'; path = "$wd\env-ps.ps1"; body = '& "$env:OZK_ROOT\tools\x.ps1"'; ok = $false },
        @{ label = 'SYSTEM PS1 wrapper with unresolved ${env:OZK_ROOT} => BLOCK'; path = "$wd\env-brace.ps1"; body = '& "${env:OZK_ROOT}\tools\x.ps1"'; ok = $false },
        @{ label = 'SYSTEM PS1 wrapper, case-insensitive $ENV:ozk_root => BLOCK'; path = "$wd\env-case.ps1"; body = '& ($ENV:ozk_root + ''\tools\x.ps1'')'; ok = $false },
        @{ label = 'SYSTEM PS1 wrapper with [Environment]::GetEnvironmentVariable(''OZK_ROOT'') => BLOCK'; path = "$wd\env-api.ps1"; body = '$r = [Environment]::GetEnvironmentVariable(''OZK_ROOT'', ''Machine''); & "$r\tools\x.ps1"'; ok = $false },
        @{ label = 'SYSTEM VBS wrapper reading shell.Environment => BLOCK'; path = "$wd\env-vbs.vbs"; body = 'r = shell.Environment("SYSTEM")("OZK_ROOT")' + "`r`n" + 'shell.Run r & "\tools\x.bat", 0, True'; ok = $false },
        @{ label = 'mixed literal + unresolved variable path %OZK_ROOT%\tools\x.ps1 => BLOCK'; path = "$wd\env-mixed.bat"; body = '"C:\Tools\runner.exe" "%OZK_ROOT%\tools\x.ps1" --log "C:\Logs\run.log"'; ok = $false },
        @{ label = 'resolvable variable into the repo (${env:SystemDrive}\Users\LOQ\...) => repo workload, SYSTEM => BLOCK privileged'; path = "$wd\env-resolved.ps1"; body = '& "${env:SystemDrive}\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\x.ps1"'; ok = $false; pattern = '*privileged repository workload*' },
        @{ label = 'resolvable %ProgramData%\..\ traversal into the repo => canonicalized, repo workload => BLOCK privileged'; path = "$wd\env-dots.cmd"; body = 'call "%ProgramData%\..\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\x.bat"'; ok = $false; pattern = '*privileged repository workload*' },
        @{ label = '%~dp0 resolves to the wrapper folder (outside the repo) => existing behaviour, not blocked'; path = "$wd\env-self.cmd"; body = 'call "%~dp0helper.cmd"'; ok = $true },
        @{ label = 'ordinary literal wrapper to a non-repo tool => unchanged (not blocked)'; path = "$wd\literal.cmd"; body = 'call "C:\Tools\backup\run-backup.exe" /quiet'; ok = $true },
        @{ label = 'ordinary literal wrapper into the repo as SYSTEM => unchanged (BLOCK privileged)'; path = "$wd\literal-repo.cmd"; body = ('call "' + $repo + '\tools\x.bat"'); ok = $false; pattern = '*privileged repository workload*' },
        @{ label = 'unrelated wrapper with only standard variables (%windir%) => unchanged (not blocked)'; path = "$wd\native.cmd"; body = '%windir%\system32\defrag.exe -c'; ok = $true }
    )
    foreach ($c in $envCases) {
        $script:Wrappers[$c.path] = $c.body
        $name = 'EnvWrap ' + [IO.Path]::GetFileName($c.path)
        $script:Tasks = @(Get-CleanLayout) + @(New-Task $name 'SYSTEM' ('cmd.exe /c "' + $c.path + '"'))
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        if ($c.ok) { Assert-True ($r.ok) $c.label }
        else {
            $p = if ($c.pattern) { '*' + $name + $c.pattern } else { '*' + $name + '*cannot determine whether*' }
            Assert-True (-not $r.ok -and (Test-BlockLike $r $p)) $c.label
        }
    }
    # سلسلة متداخلة: Task -> A -> B، والمتغيّر غير المحلول في الطبقة الثانية فقط.
    $wA = "$wd\nested-a.cmd"; $wB = 'C:\ProgramData\OZK-TOBACCO\Helpers\nested-b.ps1'
    $script:Wrappers[$wA] = ('call powershell.exe -File "' + $wB + '"')
    $script:Wrappers[$wB] = '& "$env:OZK_ROOT\tools\x.ps1"'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'EnvWrap Nested' 'SYSTEM' ('cmd.exe /c "' + $wA + '"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*EnvWrap Nested*cannot determine whether*')) 'unresolved variable in the nested second wrapper => BLOCK'
    $script:Wrappers[$wB] = '& "C:\Tools\report.exe"'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'same nested chain with literal non-repo paths => not blocked'
    # غير ذي صلاحية: المتغيّر غير المحلول لا يحجب (القاعدة كما هي للهويات غير المميّزة).
    $script:Wrappers[$wB] = '& "$env:OZK_ROOT\tools\x.ps1"'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'EnvWrap NonAdmin' 'OZKSync' ('cmd.exe /c "' + $wA + '"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'non-privileged task with an unresolved wrapper variable is not a privilege risk'
    $x = Resolve-WorkloadReach (New-Config 'OZK2026\OZK-DeployGate' @()) ('cmd.exe /c "' + $wA + '"') 'SYSTEM'
    Assert-True (-not $x.repo -and $x.undetermined) 'unresolved wrapper variable is undetermined, never "not repository workload"'

    Write-Host '== SID comparison, not account names (Codex P1)'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Domain Twin' 'DOMAIN\OZK-DeployGate' 'C:\Tools\cleanup.exe')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'task as DOMAIN\OZK-DeployGate (different SID) is not treated as the gate identity'
    foreach ($form in @('S-1-5-21-111-1001', 'ozk2026\OZK-DEPLOYGATE', 's-1-5-21-111-1001')) {
        $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Same Gate Other Form' $form 'C:\Tools\cleanup.exe')
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True (-not $r.ok -and (Test-BlockLike $r '*Same Gate Other Form*reused*')) ("same gate SID written as '" + $form + "' => recognised as the gate identity (reuse BLOCK)")
    }
    $script:Tasks = Get-CleanLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'S-1-5-21-111-1001' @('OZK2026\OZK-DeployGate'))
    Assert-True ($r.ok) 'gate account given as SID and writer as OZK2026\name (same SID) => eligible'
    $r = Invoke-GateIdentityPreflight (New-Config 'DOMAIN\OZK-DeployGate' @('OZK2026\OZK-DeployGate'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*writable by the dedicated gate identity only*')) 'DOMAIN\OZK-DeployGate gate vs OZK2026\OZK-DeployGate writer (different SIDs) => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\missing-gate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*gate identity cannot be resolved to a SID*')) 'gate identity that cannot be resolved to a SID => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @('GHOST\writer'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*writer cannot be resolved to a SID*')) 'trust-file writer that cannot be resolved to a SID => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Ghost Task' 'GHOST\nobody' 'C:\Tools\cleanup.exe')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Ghost Task*cannot be resolved to a SID*')) 'task principal that cannot be resolved to a SID => BLOCK'
    $script:Tasks = Get-CleanLayout
    $c = New-Config 'OZK2026\OZK-DeployGate' @()
    $c.trust.forbiddenGateIdentities = @($c.trust.forbiddenGateIdentities) + @('GHOST\forbidden')
    $r = Invoke-GateIdentityPreflight $c
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden identity cannot be resolved*')) 'forbidden identity that cannot be resolved for comparison => BLOCK'
    $script:Admins = @('S-1-5-21-111-1002', 'GHOST\admin')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*cannot determine whether*local administrator*')) 'local Administrators member that cannot be resolved => admin status undetermined => BLOCK'
    $script:Admins = @('OZK2026\LOQ', 'OZK2026\Administrator', 'S-1-5-21-111-1001')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*gate identity is a member of local Administrators*')) 'dedicated gate identity that is a local administrator (by SID) => BLOCK'
    $script:Admins = @('OZK2026\LOQ', 'OZK2026\Administrator')
    $script:Services = @(Get-BaselineServices) + @([pscustomobject]@{ name = 'local-dot-gate'; identity = '.\OZK-DeployGate'; action = 'C:\Tools\svc.exe' })
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*local-dot-gate*reused*')) 'service StartName .\OZK-DeployGate resolves to the gate SID (reuse BLOCK)'
    $script:Services = @(Get-BaselineServices)

    Write-Host '== Service enumeration fails closed (Codex P1)'
    $script:Tasks = Get-CleanLayout
    $script:Services = @(Get-BaselineServices)
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'service enumeration succeeds + valid non-repo services => evaluation continues (eligible)'
    $script:Services = @()
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*service inventory is empty*')) 'empty service enumeration => BLOCK (not evidence of no services)'
    foreach ($err in @('Invalid class "Win32_Service" (WMI repository error)', 'Access is denied. (Exception from HRESULT: 0x80070005)', 'The RPC server is unavailable')) {
        $script:ServiceError = $err
        function Get-PreflightServiceInventory { throw $script:ServiceError }
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True (-not $r.ok -and (Test-BlockLike $r ('*cannot enumerate tasks/services: services*'))) ('service enumeration throws (' + $err.Substring(0, 20) + '...) => BLOCK')
    }
    function Get-PreflightServiceInventory { return @($script:Services) }
    $script:Services = @(Get-BaselineServices) + @([pscustomobject]@{ name = 'ozk-repo-system'; identity = 'LocalSystem'; action = ('"C:\Program Files\nodejs\node.exe" "' + $repo + '\scripts\serve.mjs"') })
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*service ozk-repo-system*privileged*')) 'SYSTEM repo service present => BLOCK (as before)'
    $script:Services = @(Get-BaselineServices)

    Write-Host '== Gate task action must be exact (Codex P1)'
    $gatePath = $gateDir + '\deploy-gate.ps1'
    $cases = @(
        @{ ok = $false; label = 'approved PowerShell + -File gateDir\deploy-gate.ps1 without -Mode (defaults to Deploy) => BLOCK'; exe = $approvedPs; args = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $gatePath + '"') },
        @{ ok = $true;  label = 'approved form with -WindowStyle Hidden and -Mode DryRun => PASS'; exe = $approvedPs; args = ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $gatePath + '" -Mode DryRun') },
        @{ ok = $false; label = 'PowerShell -Command => BLOCK'; exe = $approvedPs; args = ('-NoProfile -Command "& ''' + $gatePath + '''"') },
        @{ ok = $false; label = 'PowerShell -EncodedCommand => BLOCK'; exe = $approvedPs; args = '-NoProfile -EncodedCommand SQBFAFgAIAAoACcAaAAnACkA' },
        @{ ok = $false; label = 'PowerShell -enc abbreviation => BLOCK'; exe = $approvedPs; args = '-enc SQBFAFgA' },
        @{ ok = $false; label = 'another ps1 in gateDir => BLOCK'; exe = $approvedPs; args = ('-File "' + $gateDir + '\run-repo-task.ps1"') },
        @{ ok = $false; label = 'cmd wrapper => BLOCK'; exe = 'C:\Windows\System32\cmd.exe'; args = ('/c "' + $gateDir + '\deploy-gate.cmd"') },
        @{ ok = $false; label = 'bat wrapper => BLOCK'; exe = ($gateDir + '\deploy-gate.bat'); args = '' },
        @{ ok = $false; label = 'arbitrary exe => BLOCK'; exe = 'C:\Tools\anything.exe'; args = ('-File "' + $gatePath + '"') },
        @{ ok = $false; label = 'pwsh (not the approved interpreter) => BLOCK'; exe = 'C:\Program Files\PowerShell\7\pwsh.exe'; args = ('-File "' + $gatePath + '"') },
        @{ ok = $false; label = 'relative script path => BLOCK'; exe = $approvedPs; args = '-File deploy-gate.ps1' },
        @{ ok = $false; label = 'path traversal out of gateDir => BLOCK'; exe = $approvedPs; args = ('-File "' + $gateDir + '\..\DeployGate\deploy-gate.ps1"') },
        @{ ok = $false; label = 'deploy-gate.ps1 outside gateDir => BLOCK'; exe = $approvedPs; args = '-File "C:\Users\Public\deploy-gate.ps1"' },
        @{ ok = $false; label = 'environment-variable path => BLOCK'; exe = $approvedPs; args = '-File "%ProgramData%\OZK-TOBACCO\DeployGate\deploy-gate.ps1"' },
        @{ ok = $false; label = 'extra command after the script => BLOCK'; exe = $approvedPs; args = ('-File "' + $gatePath + '" -Mode Deploy; calc.exe') },
        @{ ok = $false; label = 'disallowed script parameter => BLOCK'; exe = $approvedPs; args = ('-File "' + $gatePath + '" -ConfigPath C:\evil.json') },
        @{ ok = $false; label = 'ambiguous/unparseable action (unbalanced quotes) => BLOCK'; exe = $approvedPs; args = ('-File "' + $gatePath) },
        @{ ok = $false; label = 'no -File at all => BLOCK'; exe = $approvedPs; args = '-NoProfile' }
    )
    foreach ($c in $cases) {
        $script:Tasks = @(Get-CleanLayout -NoGate) + @(New-GateTask $c.exe $c.args)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True ($r.ok -eq $c.ok) $c.label
    }
    $twoActions = New-Task 'TOBACCO Windows Deploy Gate' 'OZK2026\OZK-DeployGate' 'x' @([pscustomobject]@{ execute = $approvedPs; arguments = ('-File "' + $gatePath + '"') }, [pscustomobject]@{ execute = 'C:\Tools\anything.exe'; arguments = '' })
    $script:Tasks = @(Get-CleanLayout -NoGate) + @($twoActions)
    Assert-True (-not (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'a second action on the gate task => BLOCK'

    Write-Host '== Structured action fields, tri-state REPO / NOT_REPO / UNKNOWN (Codex P1)'
    $cfgR = New-Config 'OZK2026\OZK-DeployGate' @()
    function Act([string]$E, [string]$A = '', [string]$W = '') { return [pscustomobject]@{ execute = $E; arguments = $A; workingDirectory = $W } }
    $node = 'C:\Program Files\nodejs\node.exe'
    $reachCases = @(
        @{ label = 'node.exe + scripts\serve.mjs + repo WorkingDirectory => REPO'; a = (Act $node 'scripts\serve.mjs' $repo); want = 'REPO' },
        @{ label = 'powershell.exe + relative ps1 + repo WorkingDirectory => REPO'; a = (Act $ps '-NoProfile -File tools\x.ps1' $repo); want = 'REPO' },
        @{ label = 'relative target resolved against a repo sub-folder WorkingDirectory => REPO'; a = (Act 'node.exe' 'serve.mjs' ($repo + '\scripts')); want = 'REPO' },
        @{ label = 'absolute executable inside the repo => REPO'; a = (Act ($repo + '\tools\bin\helper.exe')); want = 'REPO' },
        @{ label = 'absolute script inside the repo => REPO'; a = (Act $ps ('-File "' + $repo + '\tools\x.ps1"')); want = 'REPO' },
        @{ label = 'relative target + unrelated trusted WorkingDirectory => NOT_REPO'; a = (Act $ps '-File report.ps1' 'C:\Tools'); want = 'NOT_REPO' },
        @{ label = 'node script outside the repo (not statically inspected) => UNKNOWN, never NOT_REPO'; a = (Act $node 'server.js' 'C:\Tools\svc'); want = 'UNKNOWN' },
        @{ label = 'relative target traversing from an unrelated WorkingDirectory into the repo => REPO'; a = (Act $node '..\..\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\scripts\serve.mjs' 'C:\Tools\svc'); want = 'REPO' },
        @{ label = 'interpreter path does not swallow arguments/working directory (C:\Windows path first)'; a = (Act 'C:\Windows\System32\cmd.exe' '/c run.bat' $repo); want = 'REPO' },
        @{ label = 'relative script with no WorkingDirectory => UNKNOWN'; a = (Act $node 'scripts\serve.mjs'); want = 'UNKNOWN' },
        @{ label = 'relative WorkingDirectory => UNKNOWN'; a = (Act $node 'serve.mjs' 'tobacco-web'); want = 'UNKNOWN' },
        @{ label = 'malformed quoting in executable => UNKNOWN'; a = (Act '"C:\Tools\a.exe' ''); want = 'UNKNOWN' },
        @{ label = 'malformed quoting in arguments => UNKNOWN'; a = (Act $node '"serve.mjs' 'C:\Tools'); want = 'UNKNOWN' },
        @{ label = 'glued quotes a"b c" (ambiguous) => UNKNOWN'; a = (Act $node 'x"serve.mjs y"' 'C:\Tools'); want = 'UNKNOWN' },
        @{ label = 'empty executable => UNKNOWN'; a = (Act '' '-File x.ps1'); want = 'UNKNOWN' },
        @{ label = 'PowerShell -EncodedCommand => UNKNOWN'; a = (Act $ps '-NoProfile -EncodedCommand SQBFAFgAIAAoAGcAYwAgAGMAOgBcAHIAZQBwAG8AKQA='); want = 'UNKNOWN' },
        @{ label = 'PowerShell -enc / -e / -ec abbreviations => UNKNOWN'; a = (Act $ps '-e SQBFAFgA'); want = 'UNKNOWN' },
        @{ label = 'PowerShell -ec => UNKNOWN'; a = (Act 'powershell' '-ec SQBFAFgA'); want = 'UNKNOWN' },
        @{ label = 'PowerShell -Command with a dynamic expression => UNKNOWN'; a = (Act $ps '-Command "& (Join-Path $root x.ps1)"'); want = 'UNKNOWN' },
        @{ label = 'PowerShell -c with a pipeline => UNKNOWN'; a = (Act $ps '-c "Get-Content C:\Tools\list.txt | ForEach-Object { & $_ }"'); want = 'UNKNOWN' },
        @{ label = 'PowerShell -Command - (stdin) => UNKNOWN'; a = (Act $ps '-Command -'); want = 'UNKNOWN' },
        @{ label = 'PowerShell positional command (no -File) => UNKNOWN unless a static ps1'; a = (Act $ps 'Start-Process notepad'); want = 'UNKNOWN' },
        @{ label = 'PowerShell with no target at all => UNKNOWN'; a = (Act $ps '-NoProfile'); want = 'UNKNOWN' },
        @{ label = 'PowerShell unknown/ambiguous parameter => UNKNOWN'; a = (Act $ps '-No -File C:\Tools\x.ps1'); want = 'UNKNOWN' },
        @{ label = 'PowerShell -Command static absolute ps1 outside the repo => NOT_REPO'; a = (Act $ps '-NoProfile -Command "& ''C:\Tools\report.ps1'' -Quiet"'); want = 'NOT_REPO' },
        @{ label = 'PowerShell -Command static absolute ps1 inside the repo => REPO'; a = (Act $ps ('-Command "& ''' + $repo + '\tools\x.ps1''"')); want = 'REPO' },
        @{ label = 'cmd /c with a dynamic block => UNKNOWN'; a = (Act 'cmd.exe' '/c (for /f %i in (list.txt) do call %i)'); want = 'UNKNOWN' },
        @{ label = 'cmd /c if/else control flow => UNKNOWN'; a = (Act 'cmd.exe' '/c if exist C:\Tools\a.txt C:\Tools\b.exe'); want = 'UNKNOWN' },
        @{ label = 'cmd without /c => UNKNOWN'; a = (Act 'cmd.exe' ''); want = 'UNKNOWN' },
        @{ label = 'cmd /c chained: cd into repo && node serve.mjs => REPO'; a = (Act 'cmd.exe' ('/c cd /d "' + $repo + '" && node scripts\serve.mjs')); want = 'REPO' },
        @{ label = 'cmd /c start "" relative script with no WorkingDirectory => UNKNOWN'; a = (Act 'cmd.exe' '/c start "" run.bat'); want = 'UNKNOWN' },
        @{ label = 'cmd /c known static command with redirection => NOT_REPO'; a = (Act 'C:\Windows\System32\cmd.exe' '/c "C:\Tools\backup.exe" /quiet > "C:\Logs\b.log" 2>&1'); want = 'NOT_REPO' },
        @{ label = 'wscript without a script target => UNKNOWN'; a = (Act 'wscript.exe' '//B //Nologo'); want = 'UNKNOWN' },
        @{ label = 'cscript relative script with no WorkingDirectory => UNKNOWN'; a = (Act 'cscript.exe' '//Nologo helper.vbs'); want = 'UNKNOWN' },
        @{ label = 'node -e inline code => UNKNOWN'; a = (Act 'node.exe' '-e "require(process.argv[1])"' 'C:\Tools'); want = 'UNKNOWN' },
        @{ label = 'python -c inline code => UNKNOWN'; a = (Act 'python.exe' '-c "import runpy"' 'C:\Tools'); want = 'UNKNOWN' },
        @{ label = 'interpreter with no static target => UNKNOWN'; a = (Act 'node.exe' '--max-old-space-size=4096'); want = 'UNKNOWN' },
        @{ label = 'unresolved environment variable in Arguments => UNKNOWN'; a = (Act $ps '-File "%OZK_ROOT%\tools\x.ps1"'); want = 'UNKNOWN' },
        @{ label = 'known unrelated static command => NOT_REPO'; a = (Act 'C:\Windows\system32\sc.exe' 'start w32time task_started'); want = 'NOT_REPO' },
        @{ label = 'known unrelated static PowerShell -File => NOT_REPO'; a = (Act $ps '-NoProfile -File "C:\Tools\report.ps1"'); want = 'NOT_REPO' }
    )
    foreach ($c in $reachCases) {
        $got = Resolve-TaskReach $cfgR @($c.a) 'OZK2026\OZKSync'
        Assert-True ($got.status -eq $c.want) ($c.label + ' (got ' + $got.status + ')')
    }
    Assert-True ((Resolve-TaskReach $cfgR @() 'SYSTEM').status -eq 'UNKNOWN') 'task with no readable actions => UNKNOWN'
    Assert-True ((Resolve-TaskReach $cfgR @([pscustomobject]@{ execute = ''; arguments = ''; workingDirectory = ''; classId = '{00000000-0000-0000-0000-000000000001}' }) 'SYSTEM').status -eq 'UNKNOWN') 'COM handler that cannot be resolved to a binary => UNKNOWN'
    Assert-True ((Resolve-TaskReach $cfgR @([pscustomobject]@{ execute = 'C:\Windows\System32\wininet.dll'; arguments = ''; workingDirectory = ''; classId = '{00000000-0000-0000-0000-000000000002}' }) 'SYSTEM').status -eq 'NOT_REPO') 'COM handler resolved to a system binary => NOT_REPO'
    Assert-True ((Resolve-TaskReach $cfgR @((Act 'C:\Tools\a.exe'), (Act $node 'scripts\serve.mjs' $repo)) 'OZKSync').status -eq 'REPO') 'second action reaching the repo => REPO (every action is evaluated)'

    Write-Host '== Opaque / ambiguous privileged commands fail closed (Codex P1)'
    $privCases = @(
        @{ label = 'privileged + EncodedCommand => BLOCK'; a = (Act $ps '-NoProfile -WindowStyle Hidden -EncodedCommand SQBFAFgAIAAoAGcAYwAgAGMAOgBcAHIAZQBwAG8AKQA=') },
        @{ label = 'privileged + ambiguous -Command => BLOCK'; a = (Act $ps '-Command "$p = Get-Content C:\Tools\target.txt; & $p"') },
        @{ label = 'privileged + cmd /c ambiguous => BLOCK'; a = (Act 'cmd.exe' '/c for /f %i in (C:\Tools\list.txt) do call %i') },
        @{ label = 'privileged + unresolvable script target => BLOCK'; a = (Act 'wscript.exe' '"helper.vbs"') },
        @{ label = 'privileged + relative repo target via WorkingDirectory => BLOCK privileged'; a = (Act $node 'scripts\serve.mjs' $repo) }
    )
    foreach ($c in $privCases) {
        $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Opaque Priv' 'SYSTEM' 'x' @($c.a))
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True (-not $r.ok -and ((Test-BlockLike $r '*Opaque Priv*cannot determine whether*') -or (Test-BlockLike $r '*Opaque Priv*privileged repository workload*'))) $c.label
    }
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Opaque NonAdmin' 'OZKSync' 'x' @(Act $ps '-EncodedCommand SQBFAFgA'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'non-privileged task with an opaque command is not a privilege risk (UNKNOWN only blocks privileged identities)'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Known Static Priv' 'SYSTEM' 'x' @(Act 'C:\Windows\system32\sc.exe' 'start w32time task_started'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'privileged known unrelated static command => NOT_REPO (not blocked)'

    Write-Host '== Initialize requires exactly one validated gate task (Codex P1)'
    $gateCases = @(
        @{ label = 'zero gate tasks => BLOCK'; tasks = @(Get-CleanLayout -NoGate); pattern = '*gate task*is not registered*' },
        @{ label = 'exactly one valid gate task => PASS'; tasks = @(Get-CleanLayout); pattern = '' },
        @{ label = 'duplicate gate tasks => BLOCK'; tasks = (@(Get-CleanLayout) + @(& { $d = Get-ValidGateTask; $d.path = '\OZK\'; $d })); pattern = '*duplicate gate tasks*' },
        @{ label = 'one expected + gate-like conflicting task (runs deploy-gate.ps1) => BLOCK'; tasks = (@(Get-CleanLayout) + @(New-Task 'OZK Gate Shadow' 'OZKSync' 'x' @(Act $approvedPs ('-File "' + $gateDir + '\deploy-gate.ps1" -Mode Deploy')))); pattern = '*OZK Gate Shadow*gate-like task conflicts*' },
        @{ label = 'one expected + gate-like conflicting task (name) => BLOCK'; tasks = (@(Get-CleanLayout) + @(New-Task 'TOBACCO Deploy Gate Legacy' 'OZKSync' 'x' @(Act 'C:\Tools\a.exe'))); pattern = '*Deploy Gate Legacy*gate-like task conflicts*' },
        @{ label = 'gate task in an unexpected folder => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(& { $d = Get-ValidGateTask; $d.path = '\Other\'; $d })); pattern = '*gate task path is \Other\*' },
        @{ label = 'unreadable gate task (no actions) => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-Task 'TOBACCO Windows Deploy Gate' 'OZK2026\OZK-DeployGate' 'x' @())); pattern = '*expected exactly one action, found 0*' },
        @{ label = 'gate task with unreadable identity => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-GateTask $approvedPs ('-File "' + $gateDir + '\deploy-gate.ps1"') '')); pattern = '*gate task identity not verifiable*' },
        @{ label = 'wrong identity (SYSTEM) => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-GateTask $approvedPs ('-File "' + $gateDir + '\deploy-gate.ps1"') 'SYSTEM')); pattern = '*must run as the dedicated gate identity*' },
        @{ label = 'wrong identity (OZKSync) => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-GateTask $approvedPs ('-File "' + $gateDir + '\deploy-gate.ps1"') 'OZKSync')); pattern = '*must run as the dedicated gate identity*' },
        @{ label = 'wrong action (wrapper) => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-GateTask 'C:\Windows\System32\cmd.exe' ('/c "' + $gateDir + '\deploy-gate.cmd"'))); pattern = '*gate task must run only*' },
        @{ label = 'wrong action (disallowed mode) => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-GateTask $approvedPs ('-File "' + $gateDir + '\deploy-gate.ps1" -Mode Initialize'))); pattern = '*exactly -Mode DryRun*' },
        @{ label = 'gate task working directory outside gateDir => BLOCK'; tasks = (@(Get-CleanLayout -NoGate) + @(New-Task 'TOBACCO Windows Deploy Gate' 'OZK2026\OZK-DeployGate' 'x' @(Act $approvedPs ('-File "' + $gateDir + '\deploy-gate.ps1"') $repo))); pattern = '*working directory must be empty or gateDir*' }
    )
    foreach ($c in $gateCases) {
        $script:Tasks = $c.tasks
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        if (-not $c.pattern) { Assert-True ($r.ok) $c.label } else { Assert-True (-not $r.ok -and (Test-BlockLike $r $c.pattern)) $c.label }
    }
    $script:Tasks = @(Get-CleanLayout -NoGate)
    function Test-GateTrustAcl($Config) { return [pscustomobject]@{ ok = $true; results = @() } }; function Test-GitHookSafety($Config) { return [pscustomobject]@{ ok = $true; results = @() } }
    function Get-PreflightTaskActionText([string]$TaskName) { return $null }
    function Get-PreflightTaskState([string]$TaskName) { if ($TaskName -eq 'OZK-PriceListSync') { return 'Disabled' } return $null }
    function Get-PreflightTaskNames { return @() }
    Assert-True (-not (Invoke-InstallPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'install preflight (Initialize) with no registered gate task => BLOCKED'
    $script:Tasks = @(Get-CleanLayout)
    Assert-True ((Invoke-InstallPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'install preflight (Initialize) with exactly one validated gate task => PASS'

    Write-Host '== Startup / logon repository workloads are inventoried (Codex P1)'
    $loqSid = 'S-1-5-21-111-1002'; $syncSid = 'S-1-5-21-111-1003'; $anySid = 'S-1-5-32-544'
    $loqStartup = 'C:\Users\LOQ\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
    $allStartup = 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp'
    $serverVbs = $loqStartup + '\OZK-Tobacco-Server.vbs'
    $script:Wrappers[$serverVbs] = ('Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'sh.CurrentDirectory = "' + $repo + '"' + "`r`n" + 'sh.Run "node scripts/serve.mjs", 0, False')
    function File-Item([string]$Folder, [string]$File, [string]$Sid, [string]$Identity) { return New-StartupItem ('Startup (' + $Identity + ')') $File $Sid $Identity @([pscustomobject]@{ execute = ($Folder + '\' + $File); arguments = ''; workingDirectory = $Folder }) }
    function Run-Item([string]$Name, [string]$Line, [string]$Sid, [string]$Identity) { return New-StartupItem ('Run (' + $Identity + ')') $Name $Sid $Identity @(ConvertTo-CommandAction $Line) }
    $loqServer = File-Item $loqStartup 'OZK-Tobacco-Server.vbs' $loqSid $loqSid
    function Test-Startup($Items, [string]$Label, [string]$Pattern) {
        $script:Tasks = @(Get-CleanLayout)
        $script:Startup = @($Items)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        $script:Startup = @()
        if (-not $Pattern) { Assert-True ($r.ok) $Label } else { Assert-True (-not $r.ok -and (Test-BlockLike $r $Pattern)) $Label }
    }
    Test-Startup @($loqServer) 'LOQ startup OZK-Tobacco-Server.vbs -> node scripts/serve.mjs (repo) -> LOQ is Administrator => BLOCK' '*OZK-Tobacco-Server.vbs*member of local Administrators*'
    $script:Wrappers[($loqStartup + '\server-rel.vbs')] = 'CreateObject("WScript.Shell").Run "node scripts/serve.mjs", 0, False'
    Test-Startup @(New-StartupItem 'Startup (LOQ)' 'server-rel.vbs' $loqSid $loqSid @([pscustomobject]@{ execute = ($loqStartup + '\server-rel.vbs'); arguments = ''; workingDirectory = $loqStartup })) 'LOQ startup wrapper with only a relative node scripts/serve.mjs (cwd not provable) => UNKNOWN => BLOCK' '*server-rel.vbs*cannot determine whether*'
    Test-Startup @(File-Item $allStartup 'x.ps1' $anySid $script:AnyLogonIdentity | ForEach-Object { $_.actions = @([pscustomobject]@{ execute = ($repo + '\tools\x.ps1'); arguments = ''; workingDirectory = '' }); $_ }) 'all-users Startup folder -> direct repo script (runs for administrators at logon) => BLOCK' '*x.ps1*privileged repository workload*'
    $allWrap = $allStartup + '\ozk-launch.cmd'
    $script:Wrappers[$allWrap] = ('@echo off' + "`r`n" + 'call "' + $repo + '\tools\run.bat"')
    Test-Startup @(File-Item $allStartup 'ozk-launch.cmd' $anySid $script:AnyLogonIdentity) 'all-users Startup folder wrapper -> repo => BLOCK' '*ozk-launch.cmd*privileged repository workload*'
    Test-Startup @(Run-Item 'OzkServer' ('"C:\Program Files\nodejs\node.exe" "' + $repo + '\scripts\serve.mjs"') $anySid $script:AnyLogonIdentity) 'HKLM Run -> repo workload (runs at every logon, incl. administrators) => BLOCK' '*OzkServer*privileged repository workload*'
    Test-Startup @(Run-Item 'LoqTray' ('"C:\Program Files\nodejs\node.exe" scripts\serve.mjs') $loqSid $loqSid | ForEach-Object { $_.actions[0].workingDirectory = $repo; $_ }) 'per-user (LOQ) Run entry + admin user + repo workload => BLOCK' '*LoqTray*member of local Administrators*'
    Test-Startup @(Run-Item 'LoqRepo' ('powershell.exe -File "' + $repo + '\tools\x.ps1"') $loqSid $loqSid) 'per-user (LOQ) Run entry with an absolute repo script => BLOCK' '*LoqRepo*member of local Administrators*'
    Test-Startup @(Run-Item 'SyncRepo' ('powershell.exe -File "' + $repo + '\tools\x.ps1"') $syncSid $syncSid) 'ordinary non-admin (OZKSync) startup repo workload => evaluated normally, not blocked just for being startup' ''
    Test-Startup @(Run-Item 'SyncRepoWriter' ('powershell.exe -File "' + $repo + '\tools\x.ps1"') $syncSid $syncSid) 'non-admin startup repo workload still goes through the other rules' ''
    $script:Tasks = @(Get-CleanLayout); $script:Startup = @(Run-Item 'SyncRepoWriter' ('powershell.exe -File "' + $repo + '\tools\x.ps1"') $syncSid $syncSid)
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @('OZK2026\OZK-DeployGate', 'OZKSync')); $script:Startup = @()
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*SyncRepoWriter*may write the gate trust files*')) 'non-admin startup repo workload whose identity may write trust files => BLOCK (writer rule applies to startup too)'
    Test-Startup @(Run-Item 'VendorTray' '"C:\Program Files\Vendor\tray.exe" /min' $anySid $script:AnyLogonIdentity) 'unrelated static startup entry => NOT_REPO (not blocked)' ''
    Assert-True ((Resolve-TaskReach (New-Config 'OZK2026\OZK-DeployGate' @()) @(ConvertTo-CommandAction '"C:\Program Files\Vendor\tray.exe" /min') $script:AnyLogonIdentity).status -eq 'NOT_REPO') 'unrelated static startup command classifies NOT_REPO'
    Test-Startup @(Run-Item 'Opaque' 'powershell.exe -NoProfile -EncodedCommand SQBFAFgAIAAoAGcAYwApAA==' $anySid $script:AnyLogonIdentity) 'ambiguous startup command (EncodedCommand, runs for administrators) => UNKNOWN => BLOCK' '*Opaque*cannot determine whether*'
    Assert-True ((Resolve-TaskReach (New-Config 'OZK2026\OZK-DeployGate' @()) @(ConvertTo-CommandAction 'cmd.exe /c for %i in (*) do %i') $script:AnyLogonIdentity).status -eq 'UNKNOWN') 'ambiguous startup command classifies UNKNOWN'
    $envVbs = $allStartup + '\env.vbs'
    $script:Wrappers[$envVbs] = 'CreateObject("WScript.Shell").Run "%OZK_ROOT%\tools\x.bat", 0'
    Test-Startup @(File-Item $allStartup 'env.vbs' $anySid $script:AnyLogonIdentity) 'startup wrapper with an unresolved environment reference => BLOCK (env fail-closed unchanged)' '*env.vbs*cannot determine whether*'
    Test-Startup @(Run-Item 'UserProfileVar' 'powershell.exe -File "%USERPROFILE%\tools\x.ps1"' $anySid $script:AnyLogonIdentity) 'machine-wide startup with %USERPROFILE% (profile of whoever logs on) => UNKNOWN => BLOCK' '*UserProfileVar*cannot determine whether*'
    Test-Startup @(New-StartupItem 'HKU S-1-5-21-111-1002' 'Run/RunOnce' $loqSid $loqSid @() 'user registry hive is not loaded; per-user Run/RunOnce cannot be inventoried') 'unreadable per-user Run of an administrator (hive not loaded) => BLOCK, not "nothing"' '*Run/RunOnce*cannot determine whether*'
    Test-Startup @(New-StartupItem 'Startup (all users)' $allStartup $anySid $script:AnyLogonIdentity @() 'startup folder cannot be read: Access is denied') 'unreadable all-users Startup folder => BLOCK' '*cannot determine whether*Access is denied*'
    Test-Startup @(New-StartupItem 'HKU S-1-5-21-111-1003' 'Run/RunOnce' $syncSid $syncSid @() 'user registry hive is not loaded; per-user Run/RunOnce cannot be inventoried') 'unreadable per-user Run of a non-admin user => not a privilege risk' ''
    function Get-PreflightStartupInventory { throw 'Access is denied' }
    $script:Tasks = @(Get-CleanLayout)
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*cannot enumerate startup/logon sources*')) 'startup/logon inventory that cannot be enumerated => BLOCK'
    function Get-PreflightStartupInventory { return @($script:Startup) }
    # الحالة المعروفة: حتى بعد نقل كل المهام (التخطيط النظيف) يبقى عنصر Startup الخاص بـLOQ حاجباً.
    $script:Tasks = @(Get-CleanLayout); $script:Startup = @($loqServer)
    Assert-True (-not (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'clean task layout but LOQ startup serve.mjs remains => Initialize BLOCKED'
    $script:Tasks = Get-CurrentLayout
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @()); $script:Startup = @()
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*OZK-Tobacco-Server.vbs*member of local Administrators*')) 'current modeled OZK2026 (tasks + LOQ startup) => BLOCKED, including the startup serve.mjs workload'

    # قارئ مجلد Startup الفعلي (نظام ملفات مؤقت؛ اختصارات .lnk تحتاج COM على Windows فلا تُختبر هنا).
    $tmpStart = Join-Path ([IO.Path]::GetTempPath()) ('ozk-startup-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $tmpStart)
    try {
        Set-Content -LiteralPath (Join-Path $tmpStart 'desktop.ini') -Value '[.ShellClassInfo]'
        Set-Content -LiteralPath (Join-Path $tmpStart 'server.vbs') -Value 'x'
        Set-Content -LiteralPath (Join-Path $tmpStart 'site.url') -Value '[InternetShortcut]'
        $fi = @(Get-StartupFolderItems $tmpStart 'Startup (test)' $loqSid $loqSid)
        Assert-True ($fi.Count -eq 2) 'startup folder reader: desktop.ini skipped, every other entry inventoried'
        $vbsItem = @($fi | Where-Object { $_.name -eq 'server.vbs' })[0]
        Assert-True ($vbsItem.kind -eq 'startup' -and $vbsItem.sid -eq $loqSid -and $vbsItem.actions[0].execute -like '*server.vbs' -and $vbsItem.actions[0].workingDirectory -eq $tmpStart) 'startup script entry => structured action (execute = the file, working directory = the Startup folder) under the owner SID'
        $urlItem = @($fi | Where-Object { $_.name -eq 'site.url' })[0]
        Assert-True ($urlItem.unreadable -like '*file association*' -and @($urlItem.actions).Count -eq 0) 'startup entry opened via a file association => UNKNOWN (not NOT_REPO)'
        Assert-True (@(Get-StartupFolderItems (Join-Path $tmpStart 'missing') 'x' $loqSid $loqSid).Count -eq 0) 'a Startup folder that does not exist has no entries'
    } finally { Remove-Item -LiteralPath $tmpStart -Recurse -Force -ErrorAction SilentlyContinue }
    $ca = ConvertTo-CommandAction '"C:\Program Files\nodejs\node.exe" "C:\x\serve.mjs" --port 5173'
    Assert-True ($ca.execute -eq 'C:\Program Files\nodejs\node.exe' -and $ca.arguments -eq '"C:\x\serve.mjs" --port 5173' -and $ca.workingDirectory -eq '') 'Run value => structured action (quoted executable, then arguments)'
    $ca = ConvertTo-CommandAction 'C:\Program Files\Vendor\tray.exe /min'
    Assert-True ($ca.execute -eq 'C:\Program Files\Vendor\tray.exe' -and $ca.arguments -eq '/min') 'Run value with an unquoted path containing spaces => executable ends at .exe'
    Write-Host '== Initialize requires the gate task Disabled with exactly -Mode DryRun (Codex P1)'
    $gp = $gateDir + '\deploy-gate.ps1'
    $modeCases = @(
        @{ label = 'exactly one Disabled -Mode DryRun gate task => PASS'; t = (New-GateTask $approvedPs ('-NoProfile -File "' + $gp + '" -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '' },
        @{ label = 'Enabled (Ready) + DryRun => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Ready'); pattern = '*must be Disabled during Initialize*Ready*' },
        @{ label = 'Running + DryRun => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Running'); pattern = '*must be Disabled during Initialize*' },
        @{ label = 'Disabled + Deploy => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode Deploy') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '*exactly -Mode DryRun, found -Mode Deploy*' },
        @{ label = 'Enabled + Deploy => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode Deploy') 'OZK2026\OZK-DeployGate' 'Ready'); pattern = '*exactly -Mode DryRun*' },
        @{ label = 'Disabled + missing Mode (defaults to Deploy) => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '"') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '*missing -Mode*' },
        @{ label = 'Disabled + -Mode DryRun given twice => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode DryRun -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '*-Mode given more than once*' },
        @{ label = 'unreadable enabled/disabled state => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode DryRun') 'OZK2026\OZK-DeployGate' ''); pattern = '*state cannot be read*' },
        @{ label = 'unreadable arguments (unbalanced quotes) => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + ' -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '*cannot be parsed unambiguously*' },
        @{ label = 'wrong identity => BLOCK'; t = (New-GateTask $approvedPs ('-File "' + $gp + '" -Mode DryRun') 'OZK2026\LOQ' 'Disabled'); pattern = '*must run as the dedicated gate identity*' },
        @{ label = 'wrong interpreter => BLOCK'; t = (New-GateTask 'C:\Program Files\PowerShell\7\pwsh.exe' ('-File "' + $gp + '" -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '*interpreter is not the approved PowerShell*' },
        @{ label = 'wrong action (wrapper) => BLOCK'; t = (New-GateTask 'C:\Windows\System32\cmd.exe' ('/c "' + $gateDir + '\deploy-gate.cmd" -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Disabled'); pattern = '*gate task must run only*' }
    )
    foreach ($c in $modeCases) {
        $script:Tasks = @(Get-CleanLayout -NoGate) + @($c.t)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        if (-not $c.pattern) { Assert-True ($r.ok) $c.label } else { Assert-True (-not $r.ok -and (Test-BlockLike $r $c.pattern)) $c.label }
    }
    $script:Tasks = @(Get-CleanLayout) + @(New-GateTask $approvedPs ('-File "' + $gp + '" -Mode DryRun') 'OZK2026\OZK-DeployGate' 'Disabled')
    Assert-True (-not (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'duplicate (two valid Disabled DryRun) gate tasks => BLOCK'

    Write-Host '== Missing / unreadable / empty wrappers are UNKNOWN, never NOT_REPO (Codex P1)'
    $mw = 'C:\ProgramData\OZK-TOBACCO\Missing'
    $missCases = @(
        @{ label = 'SYSTEM task -> missing .vbs wrapper => BLOCK'; t = (New-Task 'Miss Vbs' 'SYSTEM' ('wscript.exe "' + $mw + '\gone.vbs"')); pattern = '*Miss Vbs*wrapper is missing*' },
        @{ label = 'SYSTEM task -> missing .cmd wrapper => BLOCK'; t = (New-Task 'Miss Cmd' 'SYSTEM' ('cmd.exe /c "' + $mw + '\gone.cmd"')); pattern = '*Miss Cmd*wrapper is missing*' },
        @{ label = 'SYSTEM task -> missing .bat wrapper => BLOCK'; t = (New-Task 'Miss Bat' 'SYSTEM' ($mw + '\gone.bat')); pattern = '*Miss Bat*wrapper is missing*' },
        @{ label = 'SYSTEM task -> missing .ps1 wrapper => BLOCK'; t = (New-Task 'Miss Ps1' 'SYSTEM' ($ps + ' -NoProfile -File "' + $mw + '\gone.ps1"')); pattern = '*Miss Ps1*wrapper is missing*' },
        @{ label = 'admin (LOQ) task -> missing wrapper => BLOCK'; t = (New-Task 'Miss Admin' 'LOQ' ('wscript.exe "' + $mw + '\gone.vbs"')); pattern = '*Miss Admin*wrapper is missing*' }
    )
    foreach ($c in $missCases) {
        $script:Tasks = @(Get-CleanLayout) + @($c.t)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True (-not $r.ok -and (Test-BlockLike $r $c.pattern)) $c.label
    }
    $script:Tasks = @(Get-CleanLayout); $script:Startup = @(New-StartupItem 'Startup (all users)' 'launch.lnk' 'S-1-5-32-544' $script:AnyLogonIdentity @([pscustomobject]@{ execute = ($mw + '\gone.cmd'); arguments = ''; workingDirectory = '' }))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @()); $script:Startup = @()
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*launch.lnk*wrapper is missing*')) 'admin startup (all users) -> missing wrapper => BLOCK'
    $wa = $mw + '\present-a.cmd'
    $script:Wrappers[$wa] = ('call "' + $mw + '\gone-b.ps1"')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Miss Nested' 'SYSTEM' ('cmd.exe /c "' + $wa + '"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Miss Nested*gone-b.ps1*')) 'nested wrapper A (present) -> missing wrapper B => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Miss NonAdmin' 'OZKSync' ('wscript.exe "' + $mw + '\gone.vbs"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'non-privileged task -> missing wrapper is not a privilege risk (UNKNOWN only blocks privileged identities)'
    $cfgW = New-Config 'OZK2026\OZK-DeployGate' @()
    function Read-PreflightWrapperText([string]$Path) { if ($Path -like '*denied*') { throw 'Access to the path is denied.' } if ($Path -like '*vanish*') { throw [System.IO.FileNotFoundException]'Could not find file (removed during inspection)' } if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return $null }
    $x = Resolve-TaskReach $cfgW @([pscustomobject]@{ execute = 'wscript.exe'; arguments = ('"' + $mw + '\denied.vbs"'); workingDirectory = '' }) 'SYSTEM'
    Assert-True ($x.status -eq 'UNKNOWN' -and $x.why -like '*cannot be read*denied*') 'access denied reading a wrapper => UNKNOWN'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Miss Denied' 'SYSTEM' ('wscript.exe "' + $mw + '\denied.vbs"'))
    Assert-True (-not (Invoke-GateIdentityPreflight $cfgW).ok) 'SYSTEM task whose wrapper read is denied => BLOCK'
    $x = Resolve-TaskReach $cfgW @([pscustomobject]@{ execute = 'cmd.exe'; arguments = ('/c "' + $mw + '\vanish.cmd"'); workingDirectory = '' }) 'SYSTEM'
    Assert-True ($x.status -eq 'UNKNOWN') 'wrapper that disappears during inspection (read throws) => UNKNOWN'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Miss Vanish' 'SYSTEM' ('cmd.exe /c "' + $mw + '\vanish.cmd"'))
    Assert-True (-not (Invoke-GateIdentityPreflight $cfgW).ok) 'SYSTEM task whose wrapper disappears during inspection => BLOCK'
    function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return $null }
    $script:Wrappers[$mw + '\zero.cmd'] = ''
    $x = Resolve-TaskReach $cfgW @([pscustomobject]@{ execute = 'cmd.exe'; arguments = ('/c "' + $mw + '\zero.cmd"'); workingDirectory = '' }) 'SYSTEM'
    Assert-True ($x.status -eq 'UNKNOWN' -and $x.why -like '*empty (zero bytes)*') 'explicit zero-byte wrapper (exists, empty) => UNKNOWN: what it will run cannot be proven'
    $script:Wrappers[$mw + '\repo.cmd'] = ('call "' + $repo + '\tools\x.bat"')
    Assert-True ((Resolve-TaskReach $cfgW @([pscustomobject]@{ execute = 'cmd.exe'; arguments = ('/c "' + $mw + '\repo.cmd"'); workingDirectory = '' }) 'SYSTEM').status -eq 'REPO') 'readable wrapper reaching the repo => REPO'
    $script:Wrappers[$mw + '\static.cmd'] = '"C:\Tools\backup\run-backup.exe" /quiet'
    Assert-True ((Resolve-TaskReach $cfgW @([pscustomobject]@{ execute = 'cmd.exe'; arguments = ('/c "' + $mw + '\static.cmd"'); workingDirectory = '' }) 'SYSTEM').status -eq 'NOT_REPO') 'readable unrelated static wrapper => NOT_REPO (unchanged)'
    # قارئ الأغلفة الفعلي: مفقود ⇒ $null، مجلد ⇒ $null، ملف بطول صفر ⇒ '' (لا تحويل للفشل إلى نص فارغ).
    . $preflight
    function Invoke-NtAccountTranslate([string]$Name) { $k = $Name.ToLowerInvariant(); if ($script:SidTable.ContainsKey($k)) { return $script:SidTable[$k] } return $null }
    function Get-PreflightMachineName { return 'OZK2026' }
    function Get-PreflightAcl([string]$Path) {
        $k = Resolve-TestAclKey $Path
        if ($script:FsAclErrors.ContainsKey($k)) { throw $script:FsAclErrors[$k] }
        if ($script:FsAcls.ContainsKey($k)) { return $script:FsAcls[$k] }
        return [pscustomobject]@{ owner = 'S-1-5-18'; access = @(
            [pscustomobject]@{ identity = 'S-1-5-18'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $false },
            [pscustomobject]@{ identity = 'S-1-5-32-544'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $false },
            [pscustomobject]@{ identity = 'S-1-5-32-545'; rights = 'ReadAndExecute, Synchronize'; type = 'Allow'; inherited = $true; inheritOnly = $false }) }
    }
    function Get-PreflightWindowsDirectory { return 'C:\Windows' }
    function Get-PreflightSystemPath { if ($script:SysPathError) { throw $script:SysPathError }; return $script:SysPath }
    function Get-PreflightUserPath([string]$Sid) { if ($script:UserPathErrors.ContainsKey($Sid)) { throw $script:UserPathErrors[$Sid] }; if ($script:UserPaths.ContainsKey($Sid)) { return $script:UserPaths[$Sid] }; return '' }
    function Resolve-PreflightFinalPath([string]$Path) {
        $k = ConvertTo-CanonicalTracePath $Path
        foreach ($e in @($script:FsErrors.Keys)) { if ($k -eq $e -or $k.StartsWith($e + '\')) { return (New-PathResolution 'ERROR' '' $script:FsErrors[$e]) } }
        for ($hop = 0; $hop -lt 8; $hop++) { $moved = $false; foreach ($a in @($script:FsAliases.Keys)) { if ($k -eq $a -or $k.StartsWith($a + '\')) { $k = ([string]$script:FsAliases[$a]).ToLowerInvariant() + $k.Substring($a.Length); $moved = $true; break } }; if (-not $moved) { break } }
        if ($script:FsMissing.ContainsKey($k)) { return (New-PathResolution 'MISSING' $k ('does not exist: ' + $Path)) }
    if ($null -ne $script:FsExistOnly) { if (-not ($script:FsExistOnly.ContainsKey($k) -or $k -match '^[a-z]:$' -or @($script:FsExistOnly.Keys | Where-Object { $_.StartsWith($k + '\') -or ($_.EndsWith('\*') -and ($k + '\').StartsWith($_.Substring(0, $_.Length - 1))) }).Count -gt 0)) { return (New-PathResolution 'MISSING' $k ('does not exist: ' + $Path)) } }
        if ($k -eq (ConvertTo-CanonicalTracePath $Path)) { return (New-PathResolution 'OK' $Path) }
        return (New-PathResolution 'OK' $k)
    }
    $tmpW = Join-Path ([IO.Path]::GetTempPath()) ('ozk-wrap-' + [guid]::NewGuid().ToString('N'))
    [void](New-Item -ItemType Directory -Path $tmpW)
    try {
        $zero = Join-Path $tmpW 'zero.cmd'; [IO.File]::WriteAllText($zero, '')
        Assert-True ($null -eq (Read-PreflightWrapperText (Join-Path $tmpW 'missing.cmd'))) 'real reader: missing file => $null (not an empty valid body)'
        Assert-True ($null -eq (Read-PreflightWrapperText $tmpW)) 'real reader: a directory at the wrapper path => $null'
        $z = Read-PreflightWrapperText $zero
        Assert-True ($null -ne $z -and $z.Length -eq 0) 'real reader: explicit zero-byte file => empty string (distinct from missing)'
    } finally { Remove-Item -LiteralPath $tmpW -Recurse -Force -ErrorAction SilentlyContinue }
    function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return $null }
    function Get-PreflightAdminMembers { if ($null -eq $script:Admins) { return $null } return @($script:Admins) }
    function Get-PreflightTaskInventory { return @($script:Tasks) }
    function Get-PreflightServiceInventory { return @($script:Services) }
    function Get-PreflightStartupInventory { return @($script:Startup) }

    Write-Host '== OS-administrative trust on ancestors relies on the privileged-workload guard (Codex P1)'
    # SYSTEM/Administrators مقبولون على الأسلاف (مثل ProgramData) فقط لأن أي repo workload مؤتمت بهم يحجب هنا.
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Anc System Repo' 'SYSTEM' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Anc System Repo*privileged repository workload*')) 'SYSTEM repo workload => still BLOCK through the workload guard'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Anc Admin Repo' 'OZK2026\Administrator' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Anc Admin Repo*member of local Administrators*')) 'Administrator repo workload => still BLOCK through the workload guard'

    Write-Host '== Group-assigned scheduled task principals (Codex P1)'
    $script:SidTable['ozk2026\ozk-operators'] = 'S-1-5-21-111-2002'
    $script:SidTable['domain\ozk operators'] = 'S-1-5-21-999-2001'
    function New-GroupTask([string]$Name, [string]$Group, [string]$Action, [string]$RunLevel = 'LeastPrivilege') {
        $t = New-Task $Name 'x' $Action
        $t.identity = $Group; $t.principalType = 'GROUP'; $t.userId = ''; $t.groupId = $Group; $t.runLevel = $RunLevel
        return $t
    }
    $repoAct = $ps + ' -File "' + $repo + '\tools\x.ps1"'
    $grpCases = @(
        @{ label = 'Users GroupId + repo action + LeastPrivilege => BLOCK'; t = (New-GroupTask 'Grp Users Least' 'BUILTIN\Users' $repoAct 'LeastPrivilege'); pattern = '*Grp Users Least*group principal*repository workload*RunLevel LeastPrivilege*' },
        @{ label = 'Users GroupId + repo action + HighestAvailable => BLOCK (reported explicitly)'; t = (New-GroupTask 'Grp Users High' 'S-1-5-32-545' $repoAct 'HighestAvailable'); pattern = '*Grp Users High*RunLevel HighestAvailable: a member administrator runs elevated*' },
        @{ label = 'Users GroupId + UNKNOWN action (EncodedCommand) => BLOCK'; t = (New-GroupTask 'Grp Users Unknown' 'BUILTIN\Users' ($ps + ' -EncodedCommand SQBFAFgA')); pattern = '*Grp Users Unknown*cannot prove the task does not reach*' },
        @{ label = 'Administrators GroupId + repo action => BLOCK'; t = (New-GroupTask 'Grp Admins' 'BUILTIN\Administrators' $repoAct 'HighestAvailable'); pattern = '*Grp Admins*group principal*' },
        @{ label = 'arbitrary local GroupId + repo action => BLOCK'; t = (New-GroupTask 'Grp Local' 'OZK2026\OZK-Operators' $repoAct); pattern = '*Grp Local*group principal*' },
        @{ label = 'domain GroupId + repo action => BLOCK'; t = (New-GroupTask 'Grp Domain' 'DOMAIN\OZK Operators' $repoAct); pattern = '*Grp Domain*group principal*' },
        @{ label = 'GroupId + unreadable RunLevel => FAIL CLOSED'; t = (New-GroupTask 'Grp NoRunLevel' 'BUILTIN\Users' 'C:\Windows\system32\sc.exe start w32time' 'UNKNOWN'); pattern = '*Grp NoRunLevel*unreadable RunLevel*' },
        @{ label = 'GroupId + malformed RunLevel => FAIL CLOSED'; t = (New-GroupTask 'Grp BadRunLevel' 'BUILTIN\Users' $repoAct 'Sometimes'); pattern = '*Grp BadRunLevel*unreadable RunLevel*' },
        @{ label = 'unreadable/malformed GroupId + repo action => BLOCK'; t = (New-GroupTask 'Grp Ghost' 'GHOST\nobody-group' $repoAct); pattern = '*Grp Ghost*cannot be resolved to a SID*' }
    )
    foreach ($c in $grpCases) {
        $script:Tasks = @(Get-CleanLayout) + @($c.t)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True (-not $r.ok -and (Test-BlockLike $r $c.pattern)) $c.label
    }
    $script:Tasks = @(Get-CleanLayout) + @(New-GroupTask 'Grp Static' 'BUILTIN\Users' 'C:\Windows\system32\sc.exe start w32time' 'HighestAvailable')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'GroupId + NOT_REPO static action => not blocked by this rule alone'
    $w = @($r.workloads | Where-Object { $_.name -like '*Grp Static' })[0]
    Assert-True ($w.principalType -eq 'GROUP' -and $w.groupId -eq 'BUILTIN\Users' -and $w.sid -eq 'S-1-5-32-545' -and $w.runLevel -eq 'HighestAvailable' -and $w.workload -eq 'NOT_REPO' -and $w.decision -eq 'OK') 'audit record: principal type, GroupId, SID, RunLevel, workload and decision'
    # نوع principal غير محسوم.
    function New-UnknownTask([string]$Name, [string]$Action) { $t = New-Task $Name 'x' $Action; $t.principalType = 'UNKNOWN'; $t.userId = 'OZK2026\OZKSync'; $t.groupId = 'BUILTIN\Users'; $t.identity = 'OZK2026\OZKSync'; return $t }
    $script:Tasks = @(Get-CleanLayout) + @(New-UnknownTask 'Ptype Repo' $repoAct)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Ptype Repo*principal type cannot be determined*REPO*') 'unknown principal type + REPO => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-UnknownTask 'Ptype Unknown' ($ps + ' -EncodedCommand SQBFAFgA'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Ptype Unknown*principal type cannot be determined*UNKNOWN*') 'unknown principal type + UNKNOWN => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-UnknownTask 'Ptype Static' 'C:\Windows\system32\sc.exe start w32time')
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'unknown principal type + NOT_REPO => not blocked by this rule alone'
    $t = New-Task 'Ptype Missing' 'OZK2026\OZKSync' $repoAct; $t.PSObject.Properties.Remove('principalType')
    $script:Tasks = @(Get-CleanLayout) + @($t)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Ptype Missing*principal type cannot be determined*') 'task record without a principal type => UNKNOWN (fail closed, never assumed USER)'
    # USER principals: السلوك القائم دون تغيير.
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'User Static' 'OZK2026\OZKSync' 'C:\Windows\system32\sc.exe start w32time')
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'normal non-admin UserId + known NOT_REPO => unchanged (not blocked)'
    $t = New-Task 'User Repo High' 'OZK2026\OZKSync' $repoAct; $t.runLevel = 'HighestAvailable'
    $script:Tasks = @(Get-CleanLayout) + @($t)
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'normal non-admin UserId + repo workload (even HighestAvailable) => not privileged automatically'
    $t = New-Task 'User Repo NoRL' 'OZK2026\OZKSync' $repoAct; $t.runLevel = 'UNKNOWN'
    $script:Tasks = @(Get-CleanLayout) + @($t)
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'USER principal: RunLevel does not change a non-admin identity (not needed for the decision)'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'User System Repo' 'SYSTEM' $repoAct)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*User System Repo*privileged repository workload*') 'SYSTEM repo task => still BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'User Admin Repo' 'OZK2026\Administrator' $repoAct)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*User Admin Repo*member of local Administrators*') 'Administrator repo task => still BLOCK'
    # مهمة البوابة: GroupId غير مقبول إطلاقاً.
    $gt = Get-ValidGateTask; $gt.principalType = 'GROUP'; $gt.groupId = 'OZK2026\OZK-DeployGate'; $gt.userId = ''
    $script:Tasks = @(Get-CleanLayout -NoGate) + @($gt)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*gate task principal must be the dedicated USER identity; principal type is GROUP*') 'gate task with a GroupId principal => BLOCK (never valid for the gate)'
    $gt = Get-ValidGateTask; $gt.principalType = 'UNKNOWN'
    $script:Tasks = @(Get-CleanLayout -NoGate) + @($gt)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*gate task principal must be the dedicated USER identity; principal type is UNKNOWN*') 'gate task with an undetermined principal type => BLOCK'
    $script:Tasks = @(Get-CleanLayout)
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    $gw = @($r.workloads | Where-Object { $_.name -like '*TOBACCO Windows Deploy Gate' })[0]
    Assert-True ($r.ok -and $gw.principalType -eq 'USER' -and $gw.workload -like 'GATE_TASK*' -and $gw.decision -eq 'OK') 'valid gate task (USER) => eligible and audited as the validated gate task'

    Write-Host '== Filesystem identity: junction / symlink / 8.3 aliases decide containment (Codex P1, model)'
    $cfgF = New-Config 'OZK2026\OZK-DeployGate' @()
    function Reach-Of($Actions) { return (Resolve-TaskReach $cfgF @($Actions) 'SYSTEM') }
    function FsAct([string]$E, [string]$A = '', [string]$W = '') { return [pscustomobject]@{ execute = $E; arguments = $A; workingDirectory = $W } }
    $script:FsAliases['c:\runner'] = $repo
    $script:FsAliases['c:\progra~9\tobacc~1'] = $repo
    $script:FsAliases['c:\hop1'] = 'c:\hop2'
    $script:FsAliases['c:\hop2'] = $repo
    $script:FsAliases['c:\elsewhere'] = 'c:\tools\unrelated'
    $script:FsErrors['c:\broken'] = 'the final path of reparse point (junction/symlink) c:\broken cannot be resolved (Win32 error 2)'
    $script:FsErrors['c:\denied'] = 'cannot read c:\denied (Win32 error 5)'
    $script:Wrappers['c:\tools\unrelated\x.ps1'] = 'Get-Date'
    $fsCases = @(
        @{ label = 'junction -> repo: powershell -File C:\runner\tools\job.ps1 => REPO'; a = (FsAct $ps '-File "C:\runner\tools\job.ps1"'); want = 'REPO' },
        @{ label = 'junction -> repo: node C:\runner\scripts\serve.mjs => REPO'; a = (FsAct 'node.exe' 'C:\runner\scripts\serve.mjs'); want = 'REPO' },
        @{ label = 'WorkingDirectory junction -> repo + relative scripts\serve.mjs => REPO'; a = (FsAct 'node.exe' 'scripts\serve.mjs' 'C:\runner'); want = 'REPO' },
        @{ label = '8.3 alias of the repo => REPO'; a = (FsAct $ps '-File "C:\PROGRA~9\TOBACC~1\tools\job.ps1"'); want = 'REPO' },
        @{ label = 'nested junction chain hop1 -> hop2 -> repo => REPO'; a = (FsAct $ps '-File "C:\hop1\tools\job.ps1"'); want = 'REPO' },
        @{ label = 'junction to an unrelated directory (resolved) => NOT_REPO'; a = (FsAct $ps '-File "C:\elsewhere\x.ps1"'); want = 'NOT_REPO' },
        @{ label = 'broken junction / unresolved reparse target => UNKNOWN'; a = (FsAct $ps '-File "C:\broken\tools\job.ps1"'); want = 'UNKNOWN' },
        @{ label = 'inaccessible resolution (access denied) => UNKNOWN'; a = (FsAct $ps '-File "C:\denied\job.ps1"'); want = 'UNKNOWN' },
        @{ label = 'prefix collision: C:\...\OZK-TOBACCO2\job.exe vs root C:\...\OZK-TOBACCO => NOT_REPO'; a = (FsAct 'C:\Windows\System32\cmd.exe' '/c "C:\Users\LOQ\Documents\OZK-TOBACCO2\job.exe"'); want = 'NOT_REPO' },
        @{ label = 'case variation of the same Windows path => REPO'; a = (FsAct $ps ('-File "' + $repo.ToUpperInvariant() + '\TOOLS\JOB.PS1"')); want = 'REPO' },
        @{ label = 'data argument through a junction into the repo => REPO'; a = (FsAct 'C:\Tools\runner.exe' '--root C:\runner'); want = 'REPO' },
        @{ label = 'data argument through a broken junction => UNKNOWN (never NOT_REPO)'; a = (FsAct 'C:\Tools\runner.exe' '--root C:\broken\x'); want = 'UNKNOWN' }
    )
    foreach ($c in $fsCases) { $got = Reach-Of $c.a; Assert-True ($got.status -eq $c.want) ($c.label + ' (got ' + $got.status + ')') }
    $script:FsMissing['c:\tools\gone.exe'] = $true
    Assert-True ((Reach-Of (FsAct 'C:\Tools\gone.exe' '/run')).status -eq 'UNKNOWN') 'missing executable target (may appear later at this path) => UNKNOWN'
    $script:FsMissing['c:\logs\new.log'] = $true
    Assert-True ((Reach-Of (FsAct 'C:\Tools\backup.exe' '/log C:\Logs\new.log')).status -eq 'NOT_REPO') 'missing data-argument path outside the repo (ancestor resolved) => not a target, NOT_REPO'
    $script:FsMissing[$repo.ToLowerInvariant() + '\tools\new.ps1'] = $true
    Assert-True ((Reach-Of (FsAct $ps ('-File "' + $repo + '\tools\new.ps1"'))).status -eq 'REPO') 'missing target inside the repo => REPO'
    $script:Wrappers['c:\outside\a.cmd'] = 'call "C:\runner\tools\b.cmd"'
    Assert-True ((Reach-Of (FsAct 'cmd.exe' '/c "C:\outside\a.cmd"')).status -eq 'REPO') 'wrapper outside the repo -> target through a junction into the repo => REPO'
    $script:Wrappers['c:\outside\c.vbs'] = 'Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'sh.CurrentDirectory = "C:\runner"' + "`r`n" + 'sh.Run "node scripts\serve.mjs", 0'
    Assert-True ((Reach-Of (FsAct 'wscript.exe' '"C:\outside\c.vbs"')).status -eq 'REPO') 'wrapper whose working directory is a junction into the repo => REPO'
    $script:Wrappers['c:\outside\d.cmd'] = 'call "C:\broken\b.cmd"'
    Assert-True ((Reach-Of (FsAct 'cmd.exe' '/c "C:\outside\d.cmd"')).status -eq 'UNKNOWN') 'resolution failure inside the wrapper chain => UNKNOWN'
    $script:FsAliases['c:\alias\wrap.cmd'] = 'c:\real\wrap.cmd'
    $script:Wrappers['c:\real\wrap.cmd'] = ('call "' + $repo + '\tools\x.bat"')
    Assert-True ((Reach-Of (FsAct 'cmd.exe' '/c "C:\alias\wrap.cmd"')).status -eq 'REPO') 'wrapper read through its canonical final path (file alias) => REPO'
    # جذر المستودع عبر alias: الجذر نفسه يُحلّ، فالمسار الحقيقي للمرشّح يُطابق.
    $cfgA = New-Config 'OZK2026\OZK-DeployGate' @()
    $cfgA.repoPath = 'C:\RepoLink'
    $script:FsAliases['c:\repolink'] = $repo
    Assert-True ((Resolve-TaskReach $cfgA @(FsAct $ps ('-File "' + $repo + '\tools\job.ps1"')) 'SYSTEM').status -eq 'REPO') 'repository root configured through a junction/alias is canonicalized (real path => REPO)'
    $cfgB = New-Config 'OZK2026\OZK-DeployGate' @()
    $cfgB.repoPath = 'C:\broken\repo'
    Assert-True ((Resolve-TaskReach $cfgB @(FsAct $ps '-File "C:\Tools\report.ps1"') 'SYSTEM').status -eq 'UNKNOWN') 'repository root that cannot be canonicalized => every containment decision UNKNOWN'
    $script:Tasks = @(Get-CleanLayout)
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight $cfgB) '*repository root C:\broken\repo*cannot be canonicalized*') 'repository root that cannot be canonicalized => BLOCK (never dropped silently)'
    $script:FsMissing[$repo.ToLowerInvariant()] = $true
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*repository root ' + $repo + '*MISSING*')) 'missing repository root => BLOCK'
    $script:FsMissing.Remove($repo.ToLowerInvariant())
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Fs Junction System' 'SYSTEM' 'x' @(FsAct $ps '-File "C:\runner\tools\job.ps1"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Fs Junction System*privileged repository workload*') 'SYSTEM task through a junction into the repo => privileged BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Fs Broken System' 'SYSTEM' 'x' @(FsAct $ps '-File "C:\broken\tools\job.ps1"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Fs Broken System*cannot determine whether*') 'SYSTEM task through a broken junction => UNKNOWN => BLOCK'
    $script:FsAliases = [ordered]@{}; $script:FsMissing = @{}; $script:FsErrors = @{}

    Write-Host '== Dynamic / non-literal execution targets inside wrappers (Codex P1)'
    $dw = 'C:\ProgramData\OZK-TOBACCO\Dyn'
    $cfgD = New-Config 'OZK2026\OZK-DeployGate' @()
    $script:Wrappers['C:\safe\tool.ps1'] = 'Get-Date'
    $script:Wrappers['c:\safe\tool.ps1'] = 'Get-Date'
    $script:Wrappers['C:\Tools\static.cmd'] = '@echo static'
    $script:Wrappers['c:\tools\static.cmd'] = '@echo static'
    function Dyn-Reach([string]$Name, [string]$Body) {
        $p = $dw + '\' + $Name
        $script:Wrappers[$p] = $Body
        $ext = [IO.Path]::GetExtension($Name).ToLowerInvariant()
        $act = if ($ext -eq '.ps1') { [pscustomobject]@{ execute = $ps; arguments = ('-NoProfile -File "' + $p + '"'); workingDirectory = '' } }
               elseif ($ext -eq '.vbs') { [pscustomobject]@{ execute = 'wscript.exe'; arguments = ('"' + $p + '"'); workingDirectory = '' } }
               else { [pscustomobject]@{ execute = 'cmd.exe'; arguments = ('/c "' + $p + '"'); workingDirectory = '' } }
        return (Resolve-TaskReach $cfgD @($act) 'SYSTEM')
    }
    $dynCases = @(
        @{ label = 'PowerShell: $p = Get-Content ...; & $p => UNKNOWN'; n = 'witness.ps1'; b = ('$p = Get-Content C:\ProgramData\target.txt' + "`r`n" + '& $p') },
        @{ label = 'PowerShell: & $variable => UNKNOWN'; n = 'amp.ps1'; b = '& $script' },
        @{ label = 'PowerShell: & (expression) => UNKNOWN'; n = 'ampexpr.ps1'; b = '& (Join-Path $root "tools\x.ps1")' },
        @{ label = 'PowerShell: & "$dir\x.ps1" (expandable string) => UNKNOWN'; n = 'ampexp.ps1'; b = '& "$dir\x.ps1"' },
        @{ label = 'PowerShell: . $variable (dot-source) => UNKNOWN'; n = 'dot.ps1'; b = '. $lib' },
        @{ label = 'PowerShell: Start-Process $variable => UNKNOWN'; n = 'sp.ps1'; b = 'Start-Process $exe' },
        @{ label = 'PowerShell: Start-Process -FilePath (expression) => UNKNOWN'; n = 'spexpr.ps1'; b = 'Start-Process -FilePath (Get-Content C:\x.txt) -Wait' },
        @{ label = 'PowerShell: Start-Process powershell with computed arguments => UNKNOWN'; n = 'sparg.ps1'; b = 'Start-Process powershell.exe -ArgumentList "-File $target"' },
        @{ label = 'PowerShell: Invoke-Command -ScriptBlock $sb => UNKNOWN'; n = 'icmsb.ps1'; b = 'Invoke-Command -ScriptBlock $sb' },
        @{ label = 'PowerShell: Invoke-Command -FilePath $f => UNKNOWN'; n = 'icmfp.ps1'; b = 'Invoke-Command -ComputerName . -FilePath $f' },
        @{ label = 'PowerShell: [scriptblock]::Create(...) => UNKNOWN'; n = 'sbcreate.ps1'; b = '$sb = [scriptblock]::Create((Get-Content C:\x.txt -Raw)); $sb.Invoke()' },
        @{ label = 'PowerShell: [Diagnostics.Process]::Start($x) => UNKNOWN'; n = 'procstart.ps1'; b = '[System.Diagnostics.Process]::Start($x)' },
        @{ label = 'PowerShell: $ExecutionContext.InvokeCommand.InvokeScript(...) => UNKNOWN'; n = 'invokescript.ps1'; b = '$ExecutionContext.InvokeCommand.InvokeScript($code)' },
        @{ label = 'PowerShell: Invoke-WmiMethod Win32_Process Create => UNKNOWN'; n = 'wmi.ps1'; b = 'Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmd' },
        @{ label = 'PowerShell: unparsable wrapper => UNKNOWN'; n = 'broken.ps1'; b = 'if ($x { & "C:\safe\tool.ps1"' },
        @{ label = 'VBS: WshShell.Run variable => UNKNOWN'; n = 'run.vbs'; b = ('Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'cmd = ReadAll()' + "`r`n" + 'sh.Run cmd, 0, True') },
        @{ label = 'VBS: WshShell.Exec variable => UNKNOWN'; n = 'exec.vbs'; b = ('Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'Set p = sh.Exec(target)') },
        @{ label = 'VBS: concatenated/computed Run target => UNKNOWN'; n = 'concat.vbs'; b = ('Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'sh.Run """" & root & "\tools\x.bat""", 0, True') },
        @{ label = 'VBS: Execute of computed code => UNKNOWN'; n = 'execute.vbs'; b = 'Execute ReadCode()' },
        @{ label = 'CMD: call %VAR% => UNKNOWN'; n = 'callvar.cmd'; b = 'call %TARGET%' },
        @{ label = 'CMD: start %VAR% => UNKNOWN'; n = 'startvar.cmd'; b = 'start "" %TARGET%' },
        @{ label = 'CMD: delayed expansion target !VAR! => UNKNOWN'; n = 'delayed.cmd'; b = ('setlocal EnableDelayedExpansion' + "`r`n" + 'call !TARGET!') },
        @{ label = 'CMD: for /f ... do call %%i (command from data file) => UNKNOWN'; n = 'forcall.cmd'; b = 'for /f "delims=" %%i in (C:\ProgramData\target.txt) do call %%i' },
        @{ label = 'CMD: call %1 (batch argument as command) => UNKNOWN'; n = 'callarg.cmd'; b = 'call %1' },
        @{ label = 'CMD: call set (double expansion) => UNKNOWN'; n = 'callset.cmd'; b = 'call set T=%%%NAME%%%' },
        @{ label = 'CMD: powershell -Command "& $p" inside a cmd wrapper => UNKNOWN'; n = 'pscmd.cmd'; b = 'powershell -NoProfile -Command "& $p"' }
    )
    foreach ($c in $dynCases) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $staticCases = @(
        @{ label = 'PowerShell: static literal & ''C:\safe\tool.ps1'' => analyzed normally (NOT_REPO)'; n = 'lit.ps1'; b = '& ''C:\safe\tool.ps1'' -Verbose' },
        @{ label = 'PowerShell: static literal Start-Process => analyzed normally (NOT_REPO)'; n = 'litsp.ps1'; b = 'Start-Process -FilePath ''C:\Tools\backup\run-backup.exe'' -ArgumentList ''/quiet'' -Wait' },
        @{ label = 'PowerShell: Invoke-Command with a literal script block => analyzed normally (NOT_REPO)'; n = 'liticm.ps1'; b = 'Invoke-Command -ScriptBlock { Get-Date }' },
        @{ label = 'PowerShell: ordinary non-execution variables => not UNKNOWN just for existing'; n = 'vars.ps1'; b = ('$d = Get-Date' + "`r`n" + '$log = ''C:\Logs\x.log''' + "`r`n" + 'Write-Output $d | Out-File $log') },
        @{ label = 'VBS: literal static Run => analyzed normally (NOT_REPO)'; n = 'litrun.vbs'; b = ('Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'sh.Run """C:\Tools\backup\run-backup.exe"" /quiet", 0, True') },
        @{ label = 'VBS: literal static Exec with Chr(34) => analyzed normally (NOT_REPO)'; n = 'litexec.vbs'; b = ('Set sh = CreateObject("WScript.Shell")' + "`r`n" + 'Set p = sh.Exec(Chr(34) & "C:\Tools\backup\run-backup.exe" & Chr(34))') },
        @{ label = 'CMD: static call target => analyzed normally (NOT_REPO)'; n = 'litcall.cmd'; b = 'call "C:\Tools\static.cmd"' },
        @{ label = 'CMD: static start target => analyzed normally (NOT_REPO)'; n = 'litstart.cmd'; b = 'start "" "C:\Tools\backup\run-backup.exe" /quiet' }
    )
    foreach ($c in $staticCases) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    $got = Dyn-Reach 'litrepo.ps1' ('& ''' + $repo + '\tools\x.ps1''')
    Assert-True ($got.status -eq 'REPO') 'PowerShell: static literal call into the repo => REPO (unchanged)'
    # سلسلة متداخلة: A ثابت ⇒ B فيه هدف ديناميكي ⇒ UNKNOWN للسلسلة (لا يصير NOT_REPO في الأعلى).
    $script:Wrappers[$dw + '\inner-dyn.ps1'] = '& $p'
    $got = Dyn-Reach 'outer-static.cmd' ('call powershell.exe -NoProfile -File "' + $dw + '\inner-dyn.ps1"')
    Assert-True ($got.status -eq 'UNKNOWN') 'nested: static wrapper A -> wrapper B with a dynamic execution target => UNKNOWN for the chain'
    # شاهد Codex: غلاف خارجي، $p = Get-Content ...; & $p، مهمة SYSTEM ⇒ BLOCK.
    $wp = $dw + '\codex-witness.ps1'
    $script:Wrappers[$wp] = ('$p = Get-Content C:\ProgramData\target.txt' + "`r`n" + '& $p')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Dyn Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $wp + '"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Dyn Witness*dynamic execution target*call operator*')) 'Codex witness: privileged task -> external wrapper -> & (Get-Content ...) => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Dyn Witness NonAdmin' 'OZKSync' ($ps + ' -NoProfile -File "' + $wp + '"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'same wrapper under a non-privileged identity => not a privilege risk (UNKNOWN only blocks privileged contexts)'
    $script:Tasks = @(Get-CleanLayout) + @((New-Task 'Dyn Group' 'x' 'x' @([pscustomobject]@{ execute = $ps; arguments = ('-File "' + $wp + '"'); workingDirectory = '' })) | ForEach-Object { $_.principalType = 'GROUP'; $_.identity = 'BUILTIN\Users'; $_.groupId = 'BUILTIN\Users'; $_.userId = ''; $_ })
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Dyn Group*group principal*cannot prove*') 'same wrapper under a GROUP principal => BLOCK'

    Write-Host '== Static interpreter with a computed argument inside wrappers'
    $interpDyn = @(
        @{ label = 'PowerShell wrapper: powershell.exe -File $p => UNKNOWN'; n = 'ip1.ps1'; b = 'powershell.exe -NoProfile -File $p' },
        @{ label = 'PowerShell wrapper: & ''...\powershell.exe'' -File $t (literal call target, computed script) => UNKNOWN'; n = 'ip2.ps1'; b = '& ''C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'' -NoProfile -File $t' },
        @{ label = 'PowerShell wrapper: powershell -File:$p (inline parameter value) => UNKNOWN'; n = 'ip3.ps1'; b = 'powershell -File:$p' },
        @{ label = 'PowerShell wrapper: node $script => UNKNOWN'; n = 'ip4.ps1'; b = 'node $script --port 5173' },
        @{ label = 'PowerShell wrapper: cmd.exe /c $cmd => UNKNOWN'; n = 'ip5.ps1'; b = 'cmd.exe /c $cmd' },
        @{ label = 'PowerShell wrapper: wscript.exe "$dir\x.vbs" (expandable string) => UNKNOWN'; n = 'ip6.ps1'; b = 'wscript.exe "$dir\x.vbs"' },
        @{ label = 'PowerShell wrapper: python (Get-Content C:\x.txt) => UNKNOWN'; n = 'ip7.ps1'; b = 'python (Get-Content C:\ProgramData\target.txt)' },
        @{ label = 'PowerShell wrapper: & ''pwsh.exe'' -File @($a) (array with a variable) => UNKNOWN'; n = 'ip8.ps1'; b = '& ''C:\Program Files\PowerShell\7\pwsh.exe'' -File @($a)' },
        @{ label = 'CMD wrapper: for /f ... do node %%i => UNKNOWN'; n = 'ip9.cmd'; b = 'for /f "delims=" %%i in (C:\ProgramData\target.txt) do node %%i' },
        @{ label = 'CMD wrapper: powershell -File %1 => UNKNOWN'; n = 'ip10.cmd'; b = 'powershell -NoProfile -File %1' },
        @{ label = 'PowerShell wrapper: wmic.exe process call create $cmd => UNKNOWN'; n = 'ip11.ps1'; b = 'wmic.exe process call create $cmd' }
    )
    foreach ($c in $interpDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $interpStatic = @(
        @{ label = 'PowerShell wrapper: powershell.exe -File ''C:\safe\tool.ps1'' (all literal) => NOT_REPO'; n = 'is1.ps1'; b = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File ''C:\safe\tool.ps1''' },
        @{ label = 'PowerShell wrapper: & ''...\powershell.exe'' -File ''C:\safe\tool.ps1'' => NOT_REPO'; n = 'is2.ps1'; b = '& ''C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'' -NoProfile -File ''C:\safe\tool.ps1''' },
        @{ label = 'PowerShell wrapper: non-interpreter tool with a variable argument => unchanged (NOT_REPO)'; n = 'is3.ps1'; b = ('$log = ''C:\Logs\x.log''' + "`r`n" + '& ''C:\Tools\backup\run-backup.exe'' /log $log') },
        @{ label = 'CMD wrapper: static interpreter call => unchanged (NOT_REPO)'; n = 'is4.cmd'; b = 'powershell.exe -NoProfile -File "C:\safe\tool.ps1"' }
    )
    foreach ($c in $interpStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'is5.ps1' ('powershell.exe -File ''' + $repo + '\tools\x.ps1''')).status -eq 'REPO') 'PowerShell wrapper: literal interpreter call into the repo => REPO (unchanged)'
    $ipw = $dw + '\interp-witness.ps1'
    $script:Wrappers[$ipw] = ('$t = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'powershell.exe -NoProfile -File $t')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Interp Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $ipw + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Interp Witness*interpreter powershell.exe with a computed argument*') 'privileged task -> wrapper -> powershell.exe -File (Get-Content ...) => BLOCK'

    Write-Host '== Process creation via WMI / CIM / COM with a computed argument'
    $wmiDyn = @(
        @{ label = 'PS: ([wmiclass]''Win32_Process'').Create($cmd) => UNKNOWN'; n = 'w1.ps1'; b = '([wmiclass]''Win32_Process'').Create($cmd)' },
        @{ label = 'PS: $p = Get-WmiObject -List Win32_Process; $p.Create($cmd) => UNKNOWN'; n = 'w2.ps1'; b = ('$p = Get-WmiObject -List Win32_Process' + "`r`n" + '$p.Create($cmd)') },
        @{ label = 'PS: ManagementClass.InvokeMethod(''Create'', @($cmd)) => UNKNOWN'; n = 'w3.ps1'; b = ('$mc = New-Object System.Management.ManagementClass(''Win32_Process'')' + "`r`n" + '$mc.InvokeMethod(''Create'', @($cmd))') },
        @{ label = 'PS: Invoke-WmiMethod ... -Name Create -ArgumentList $cmd => UNKNOWN'; n = 'w4.ps1'; b = 'Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmd' },
        @{ label = 'PS: Invoke-WmiMethod with a computed method name => UNKNOWN'; n = 'w5.ps1'; b = 'Invoke-WmiMethod -Class Win32_Process -Name $m -ArgumentList ''x''' },
        @{ label = 'PS: Invoke-CimMethod ... -Arguments @{ CommandLine = $cmd } => UNKNOWN'; n = 'w6.ps1'; b = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }' },
        @{ label = 'PS: (New-Object -ComObject WScript.Shell).Run($cmd) => UNKNOWN'; n = 'w7.ps1'; b = '(New-Object -ComObject WScript.Shell).Run($cmd)' },
        @{ label = 'PS: WScript.Shell .Exec($cmd) => UNKNOWN'; n = 'w8.ps1'; b = ('$sh = New-Object -ComObject WScript.Shell' + "`r`n" + '$sh.Exec($cmd)') },
        @{ label = 'PS: Shell.Application .ShellExecute($f) => UNKNOWN'; n = 'w9.ps1'; b = '(New-Object -ComObject Shell.Application).ShellExecute($f)' },
        @{ label = 'PS: MMC20.Application ExecuteShellCommand($c, ...) => UNKNOWN'; n = 'w10.ps1'; b = '[Activator]::CreateInstance([type]::GetTypeFromProgID(''MMC20.Application'')).Document.ActiveView.ExecuteShellCommand($c, $null, $null, ''7'')' },
        @{ label = 'VBS: GetObject("winmgmts:").Get("Win32_Process").Create cmd => UNKNOWN'; n = 'w11.vbs'; b = ('Set p = GetObject("winmgmts:\\.\root\cimv2").Get("Win32_Process")' + "`r`n" + 'r = p.Create(cmd, Null, Null, pid)') },
        @{ label = 'VBS: WMI ExecMethod_ => UNKNOWN'; n = 'w12.vbs'; b = ('Set inParams = p.Methods_("Create").InParameters.SpawnInstance_()' + "`r`n" + 'inParams.CommandLine = cmd' + "`r`n" + 'Set outParams = p.ExecMethod_("Create", inParams)') },
        @{ label = 'CMD: for /f ... do wmic process call create %%i => UNKNOWN'; n = 'w13.cmd'; b = 'for /f "delims=" %%i in (C:\ProgramData\target.txt) do wmic process call create "%%i"' },
        @{ label = 'PS: $p.$m($cmd) (computed member name) => UNKNOWN'; n = 'w14.ps1'; b = ('$p = [wmiclass]''Win32_Process''' + "`r`n" + '$p.$m($cmd)') },
        @{ label = 'PS: $p."$m"($cmd) (expandable member name) => UNKNOWN'; n = 'w15.ps1'; b = ('$p = [wmiclass]''Win32_Process''' + "`r`n" + '$p."$m"($cmd)') },
        @{ label = 'PS: & Invoke-WmiMethod ... -ArgumentList $cmd => UNKNOWN'; n = 'w16.ps1'; b = '& Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmd' },
        @{ label = 'PS: iwmi alias ... -ArgumentList $cmd => UNKNOWN'; n = 'w17.ps1'; b = 'iwmi -Class Win32_Process -Name Create -ArgumentList $cmd' },
        @{ label = 'PS: module-qualified Invoke-WmiMethod ... $cmd => UNKNOWN'; n = 'w18.ps1'; b = 'Microsoft.PowerShell.Management\Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmd' },
        @{ label = 'PS: icim alias ... -Arguments @{ CommandLine = $cmd } => UNKNOWN'; n = 'w19.ps1'; b = 'icim -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }' },
        @{ label = 'PS: & icim ... -Arguments @{ CommandLine = $cmd } => UNKNOWN'; n = 'w20.ps1'; b = '& icim -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }' },
        @{ label = 'PS: $cmd = Get-Content ...; wmic.exe process call create $cmd => UNKNOWN'; n = 'w21.ps1'; b = ('$cmd = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'wmic.exe process call create $cmd') },
        @{ label = 'PS: wmic process call create $cmd => UNKNOWN'; n = 'w22.ps1'; b = 'wmic process call create $cmd' },
        @{ label = 'PS: Start-Process wmic.exe -ArgumentList $cmd => UNKNOWN'; n = 'w23.ps1'; b = 'Start-Process wmic.exe -ArgumentList $cmd' },
        @{ label = 'PS: & wmic.exe process call create $cmd => UNKNOWN'; n = 'w24.ps1'; b = '& wmic.exe process call create $cmd' }
    )
    foreach ($c in $wmiDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $wmiStatic = @(
        @{ label = 'PS: literal Invoke-WmiMethod Win32_Process Create => analyzed normally (NOT_REPO)'; n = 'ws1.ps1'; b = 'Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList ''C:\Tools\backup\run-backup.exe /quiet''' },
        @{ label = 'PS: literal Invoke-CimMethod hashtable => analyzed normally (NOT_REPO)'; n = 'ws2.ps1'; b = 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ''C:\Tools\backup\run-backup.exe'' }' },
        @{ label = 'PS: literal WScript.Shell .Run(''...'', 0, $true) => analyzed normally (NOT_REPO)'; n = 'ws3.ps1'; b = '(New-Object -ComObject WScript.Shell).Run(''C:\Tools\backup\run-backup.exe'', 0, $true)' },
        @{ label = 'PS: literal ([wmiclass]''Win32_Process'').Create(''...'') => analyzed normally (NOT_REPO)'; n = 'ws4.ps1'; b = '([wmiclass]''Win32_Process'').Create(''C:\Tools\backup\run-backup.exe'')' },
        @{ label = 'PS: [IO.File]::Create($path) (not a process) => unchanged (NOT_REPO)'; n = 'ws5.ps1'; b = ('$path = ''C:\Logs\x.log''' + "`r`n" + '[IO.File]::Create($path).Dispose()') },
        @{ label = 'VBS: literal Win32_Process.Create => analyzed normally (NOT_REPO)'; n = 'ws6.vbs'; b = ('Set p = GetObject("winmgmts:\\.\root\cimv2").Get("Win32_Process")' + "`r`n" + 'r = p.Create("C:\Tools\backup\run-backup.exe", Null, Null, pid)') },
        @{ label = 'PS: & Invoke-WmiMethod with a literal ArgumentList => analyzed normally (NOT_REPO)'; n = 'ws8.ps1'; b = '& Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList ''C:\Tools\backup\run-backup.exe''' },
        @{ label = 'PS: literal icim hashtable => analyzed normally (NOT_REPO)'; n = 'ws9.ps1'; b = 'icim -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ''C:\Tools\backup\run-backup.exe'' }' },
        @{ label = 'PS: literal wmic process call create => analyzed normally (NOT_REPO)'; n = 'ws10.ps1'; b = 'wmic.exe process call create ''C:\Tools\backup\run-backup.exe''' }
    )
    foreach ($c in $wmiStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'ws7.ps1' ('Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList ''' + $repo + '\tools\x.bat''')).status -eq 'REPO') 'PS: literal WMI process creation of a repo script => REPO'
    $wmw = $dw + '\wmi-witness.ps1'
    $script:Wrappers[$wmw] = ('$cmd = Get-Content C:\ProgramData\target.txt' + "`r`n" + '([wmiclass]''Win32_Process'').Create($cmd)')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Wmi Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $wmw + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Wmi Witness*WMI/COM .Create*') 'privileged task -> wrapper -> Win32_Process.Create(Get-Content ...) => BLOCK'
    $wmw2 = $dw + '\wmi-callop.ps1'
    $script:Wrappers[$wmw2] = '& Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmd'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Wmi CallOp' 'SYSTEM' ($ps + ' -NoProfile -File "' + $wmw2 + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Wmi CallOp*computed arguments*') 'privileged task -> wrapper -> & Invoke-WmiMethod -ArgumentList $cmd => BLOCK'
    $wmw3 = $dw + '\wmi-member.ps1'
    $script:Wrappers[$wmw3] = ('$p = [wmiclass]''Win32_Process''' + "`r`n" + '$p.$m((Get-Content C:\ProgramData\target.txt))')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Wmi Member' 'SYSTEM' ($ps + ' -NoProfile -File "' + $wmw3 + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Wmi Member*dynamic member invocation*') 'privileged task -> wrapper -> $p.$m(Get-Content ...) => BLOCK'
    $wmw4 = $dw + '\wmi-icim.ps1'
    $script:Wrappers[$wmw4] = 'icim -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Wmi Icim' 'SYSTEM' ($ps + ' -NoProfile -File "' + $wmw4 + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Wmi Icim*computed arguments*') 'privileged task -> wrapper -> icim -Arguments @{ CommandLine = $cmd } => BLOCK'
    $wmw5 = $dw + '\wmi-wmic.ps1'
    $script:Wrappers[$wmw5] = ('$cmd = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'wmic.exe process call create $cmd')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Wmic Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $wmw5 + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Wmic Witness*interpreter wmic.exe with a computed argument*') 'Codex witness: privileged task -> wrapper -> wmic.exe process call create (Get-Content ...) => BLOCK'

    Write-Host '== Task/service registration, known launchers and splatting with computed content (static fixtures only)'
    # تحليل نصوص فقط: لا تُنشأ مهام أو خدمات ولا يُنفَّذ شيء.
    $regDyn = @(
        @{ label = 'PS: New-ScheduledTaskAction -Argument (Get-Content ...) => UNKNOWN'; n = 'r1.ps1'; b = 'New-ScheduledTaskAction -Execute powershell.exe -Argument (Get-Content C:\ProgramData\target.txt)' },
        @{ label = 'PS: Register-ScheduledTask -Action $a => UNKNOWN'; n = 'r2.ps1'; b = 'Register-ScheduledTask -TaskName X -Action $a -User SYSTEM' },
        @{ label = 'PS: Set-ScheduledTask -Action $a => UNKNOWN'; n = 'r3.ps1'; b = 'Set-ScheduledTask -TaskName X -Action $a' },
        @{ label = 'PS: Register-ScheduledTask @p (splat) => UNKNOWN'; n = 'r4.ps1'; b = 'Register-ScheduledTask @p' },
        @{ label = 'PS: $t | Register-ScheduledTask (definition from the pipeline) => UNKNOWN'; n = 'r5.ps1'; b = '$t | Register-ScheduledTask -TaskName X' },
        @{ label = 'PS: New-Service -BinaryPathName $bin => UNKNOWN'; n = 'r6.ps1'; b = 'New-Service -Name X -BinaryPathName $bin' },
        @{ label = 'PS: Set-Service @p (splat) => UNKNOWN'; n = 'r7.ps1'; b = 'Set-Service @p' },
        @{ label = 'PS: forfiles /c $cmd => UNKNOWN'; n = 'r8.ps1'; b = 'forfiles /p C:\Logs /c $cmd' },
        @{ label = 'PS: schtasks /create /tr $cmd => UNKNOWN'; n = 'r9.ps1'; b = 'schtasks.exe /create /tn X /tr $cmd /sc once /st 00:00' },
        @{ label = 'PS: pcalua -a $target => UNKNOWN'; n = 'r10.ps1'; b = 'pcalua.exe -a $target' },
        @{ label = 'PS: wmic @p (splat) => UNKNOWN'; n = 'r11.ps1'; b = 'wmic @p' },
        @{ label = 'PS: ForEach-Object @p => UNKNOWN'; n = 'r12.ps1'; b = '1 | ForEach-Object @p' },
        @{ label = 'PS: % @p => UNKNOWN'; n = 'r13.ps1'; b = '1 | % @p' },
        @{ label = 'PS: Where-Object @p => UNKNOWN'; n = 'r14.ps1'; b = '1 | Where-Object @p' },
        @{ label = 'PS: ? @p => UNKNOWN'; n = 'r15.ps1'; b = '1 | ? @p' },
        @{ label = 'CMD: wmic process call create %c% => UNKNOWN'; n = 'r16.cmd'; b = 'wmic process call create "%c%"' },
        @{ label = 'CMD: wmic process call create !c! => UNKNOWN'; n = 'r17.cmd'; b = 'wmic process call create "!c!"' },
        @{ label = 'CMD: forfiles /c %1 => UNKNOWN'; n = 'r18.cmd'; b = 'forfiles /p C:\Logs /c %1' },
        @{ label = 'CMD: schtasks /create /tr !c! => UNKNOWN'; n = 'r19.cmd'; b = 'schtasks /create /tn X /tr "!c!" /sc once /st 00:00' },
        @{ label = 'CMD: pcalua -a %%f => UNKNOWN'; n = 'r20.cmd'; b = 'for %%f in (C:\Logs\*.txt) do pcalua -a "%%f"' }
    )
    foreach ($c in $regDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $regStatic = @(
        @{ label = 'PS: literal New-ScheduledTaskAction outside the repo => analyzed normally (NOT_REPO)'; n = 'rs1.ps1'; b = 'New-ScheduledTaskAction -Execute ''C:\Tools\backup\run-backup.exe'' -Argument ''/quiet''' },
        @{ label = 'PS: literal New-Service outside the repo => analyzed normally (NOT_REPO)'; n = 'rs2.ps1'; b = 'New-Service -Name X -BinaryPathName ''C:\Tools\backup\svc.exe''' },
        @{ label = 'PS: literal forfiles /c => analyzed normally (NOT_REPO)'; n = 'rs3.ps1'; b = 'forfiles /p C:\Logs /m *.log /d -30 /c ''cmd /c echo old''' },
        @{ label = 'PS: literal schtasks /query (no computed argument) => NOT_REPO'; n = 'rs4.ps1'; b = 'schtasks.exe /query /tn X' },
        @{ label = 'PS: literal ForEach-Object { } => NOT_REPO'; n = 'rs5.ps1'; b = '1..3 | ForEach-Object { $_ * 2 }' },
        @{ label = 'PS: literal Where-Object -FilterScript { } => NOT_REPO'; n = 'rs6.ps1'; b = 'Get-ChildItem C:\Logs | Where-Object -FilterScript { $_.Length -gt 0 }' },
        @{ label = 'PS: ordinary cmdlet splat (Get-ChildItem @p) => unchanged (NOT_REPO)'; n = 'rs7.ps1'; b = ('$p = @{ Path = ''C:\Logs'' }' + "`r`n" + 'Get-ChildItem @p') },
        @{ label = 'CMD: literal wmic process call create => analyzed normally (NOT_REPO)'; n = 'rs8.cmd'; b = 'wmic process call create "C:\Tools\backup\run-backup.exe"' },
        @{ label = 'PS: Set-Service -Status literal => NOT_REPO'; n = 'rs9.ps1'; b = 'Set-Service -Name Spooler -StartupType Manual' }
    )
    foreach ($c in $regStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'rs10.ps1' ('New-ScheduledTaskAction -Execute ''node.exe'' -Argument ''' + $repo + '\scripts\serve.mjs''')).status -eq 'REPO') 'PS: literal task action pointing into the repo => REPO'
    # شاهد Codex: الإجراء من ملف بيانات خارجي ثم تسجيله — تحت SYSTEM وتحت مدير محلي (LOQ) ⇒ BLOCK.
    $regw = $dw + '\task-reg-witness.ps1'
    $script:Wrappers[$regw] = ('$a = New-ScheduledTaskAction -Execute powershell.exe -Argument (Get-Content C:\ProgramData\target.txt)' + "`r`n" + 'Register-ScheduledTask -TaskName X -Action $a -User SYSTEM')
    foreach ($ident in @('SYSTEM', 'LOQ')) {
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('Task Reg ' + $ident) $ident ($ps + ' -NoProfile -File "' + $regw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*Task Reg ' + $ident + '*computed or splatted argument*')) ('Codex witness: ' + $ident + ' task -> wrapper -> New-ScheduledTaskAction (Get-Content ...) + Register-ScheduledTask => BLOCK')
    }
    # نفس شاهد WMIC تحت مدير محلي (LOQ)، لا SYSTEM فقط.
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Wmic Witness Admin' 'LOQ' ($ps + ' -NoProfile -File "' + $wmw5 + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Wmic Witness Admin*wmic.exe*computed*') 'Administrator (LOQ) task -> wrapper -> wmic.exe process call create (Get-Content ...) => BLOCK'
    foreach ($ident in @('SYSTEM', 'LOQ')) {
        $sw = $dw + '\splat-' + $ident + '.ps1'
        $script:Wrappers[$sw] = ('$p = Get-Content C:\ProgramData\p.json | ConvertFrom-Json' + "`r`n" + 'Get-ChildItem C:\Logs | ForEach-Object @p')
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('Splat ' + $ident) $ident ($ps + ' -NoProfile -File "' + $sw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*Splat ' + $ident + '*splatted parameter set*')) ($ident + ' task -> wrapper -> ForEach-Object @p => BLOCK')
    }
    # Action مباشرة وcmd /c: المرجع غير المحلول (!c!) UNKNOWN بقاعدة التوسيع القائمة؛ الحرفي يبقى كما هو.
    $got = Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'C:\Windows\system32\cmd.exe'; arguments = '/v:on /c wmic process call create "!c!"'; workingDirectory = '' }) 'SYSTEM'
    Assert-True ($got.status -eq 'UNKNOWN') ('Action: cmd /c wmic ... !c! => UNKNOWN through the existing unresolved-reference rule (got ' + $got.status + ': ' + $got.why + ')')
    $got = Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'C:\Windows\system32\schtasks.exe'; arguments = '/query /tn X'; workingDirectory = '' }) 'SYSTEM'
    Assert-True ($got.status -eq 'NOT_REPO') ('Action: literal schtasks /query => NOT_REPO (got ' + $got.status + ': ' + $got.why + ')')

    Write-Host '== forfiles substitution variables and sc.exe create/config (static fixtures only)'
    # تحليل نصوص فقط: لا يُشغَّل forfiles ولا تُنشأ أو تُعدَّل خدمات.
    $ffsc = @(
        @{ label = 'PS: forfiles /c "cmd /c @path" => UNKNOWN'; n = 'f1.ps1'; b = 'forfiles /p C:\Logs /c "cmd /c @path"' },
        @{ label = 'PS: forfiles /c with @file in a literal string => UNKNOWN'; n = 'f2.ps1'; b = 'forfiles.exe /p C:\Logs /m *.cmd /c ''cmd /c @file''' },
        @{ label = 'PS: forfiles /c with @relpath => UNKNOWN'; n = 'f3.ps1'; b = 'forfiles /s /c "cmd /c @relpath"' },
        @{ label = 'PS: forfiles /c with a 0xHH escape => UNKNOWN'; n = 'f4.ps1'; b = 'forfiles /c "cmd /c 0x22x0x22"' },
        @{ label = 'CMD: forfiles /c "cmd /c @path" => UNKNOWN'; n = 'f5.cmd'; b = 'forfiles /p C:\Logs /c "cmd /c @path"' },
        @{ label = 'CMD: forfiles /c "cmd /c @fname@ext" => UNKNOWN'; n = 'f6.cmd'; b = 'forfiles /p C:\Logs /c "cmd /c @fname@ext"' },
        @{ label = 'PS: sc.exe create X binPath= $b => UNKNOWN'; n = 's1.ps1'; b = 'sc.exe create X binPath= $b' },
        @{ label = 'PS: sc.exe config X binPath= (expression) => UNKNOWN'; n = 's2.ps1'; b = 'sc.exe config X binPath= (Get-Content C:\ProgramData\target.txt)' },
        @{ label = 'PS: sc.exe config X binPath= "$dir\svc.exe" (expandable) => UNKNOWN'; n = 's3.ps1'; b = 'sc.exe config X binPath= "$dir\svc.exe"' },
        @{ label = 'PS: sc.exe @p (splat) => UNKNOWN'; n = 's4.ps1'; b = 'sc.exe @p' },
        @{ label = 'PS: sc.exe $op X binPath= ... (computed subcommand) => UNKNOWN'; n = 's5.ps1'; b = 'sc.exe $op X binPath= C:\Tools\svc.exe' },
        @{ label = 'PS: & sc.exe create X binPath= $b => UNKNOWN'; n = 's6.ps1'; b = '& sc.exe create X binPath= $b' }
    )
    foreach ($c in $ffsc) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $ffscStatic = @(
        @{ label = 'PS: literal forfiles without substitution variables => NOT_REPO'; n = 'fs1.ps1'; b = 'forfiles /p C:\Logs /m *.log /d -30 /c "cmd /c echo old"' },
        @{ label = 'PS: literal sc.exe create with a binPath outside the repo => NOT_REPO'; n = 'ss1.ps1'; b = 'sc.exe create X binPath= C:\Tools\backup\svc.exe start= auto' },
        @{ label = 'PS: sc.exe query $name (not create/config) => NOT_REPO'; n = 'ss2.ps1'; b = 'sc.exe query $name' },
        @{ label = 'PS: sc (Set-Content alias) with a variable => unchanged (NOT_REPO)'; n = 'ss3.ps1'; b = 'sc C:\Logs\out.txt $value' }
    )
    foreach ($c in $ffscStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'ss4.ps1' ('sc.exe config X binPath= ' + $repo + '\tools\svc.exe')).status -eq 'REPO') 'PS: literal sc.exe config with a binPath inside the repo => REPO'
    $got = Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'C:\Windows\system32\forfiles.exe'; arguments = '/p C:\Logs /c "cmd /c @path"'; workingDirectory = '' }) 'SYSTEM'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*substitution variables*') ('Action: forfiles /c "cmd /c @path" => UNKNOWN (got ' + $got.status + ': ' + $got.why + ')')
    $got = Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'C:\Windows\system32\cmd.exe'; arguments = '/c forfiles /p C:\Logs /c "cmd /c @file"'; workingDirectory = '' }) 'SYSTEM'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*substitution variables*') ('Action: cmd /c forfiles ... @file => UNKNOWN (got ' + $got.status + ': ' + $got.why + ')')
    $got = Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'C:\Windows\system32\forfiles.exe'; arguments = '/p C:\Logs /m *.log /d -30 /c "cmd /c echo old"'; workingDirectory = '' }) 'SYSTEM'
    Assert-True ($got.status -eq 'NOT_REPO') ('Action: literal forfiles without substitution variables => NOT_REPO (got ' + $got.status + ': ' + $got.why + ')')
    foreach ($ident in @('SYSTEM', 'LOQ')) {
        $fw = $dw + '\ff-' + $ident + '.ps1'
        $script:Wrappers[$fw] = 'forfiles /p C:\ProgramData\Drop /c "cmd /c @path"'
        $sw = $dw + '\sc-' + $ident + '.ps1'
        $script:Wrappers[$sw] = ('$b = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'sc.exe config X binPath= $b')
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('Forfiles ' + $ident) $ident ($ps + ' -NoProfile -File "' + $fw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*Forfiles ' + $ident + '*substitution variables*')) ($ident + ' task -> wrapper -> forfiles /c "cmd /c @path" => BLOCK')
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('ScConfig ' + $ident) $ident ($ps + ' -NoProfile -File "' + $sw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*ScConfig ' + $ident + '*binPath cannot be proven*')) ($ident + ' task -> wrapper -> sc.exe config binPath= (Get-Content ...) => BLOCK')
    }

    Write-Host '== sc.exe with a \\server prefix and Start-Process sc.exe (static fixtures only)'
    $scMore = @(
        @{ label = 'PS: sc.exe \\localhost create X binPath= $b => UNKNOWN'; n = 'sp1.ps1'; b = 'sc.exe \\localhost create X binPath= $b' },
        @{ label = 'PS: sc.exe \\server config X binPath= $b => UNKNOWN'; n = 'sp2.ps1'; b = 'sc.exe \\server config X binPath= $b' },
        @{ label = 'PS: Start-Process sc.exe -ArgumentList create, X, binPath=, $b => UNKNOWN'; n = 'sp3.ps1'; b = 'Start-Process sc.exe -ArgumentList ''create'', ''X'', ''binPath='', $b' },
        @{ label = 'PS: Start-Process sc -ArgumentList "config X binPath= $b" => UNKNOWN'; n = 'sp4.ps1'; b = 'Start-Process sc -ArgumentList "config X binPath= $b"' },
        @{ label = 'PS: Start-Process sc.exe -ArgumentList \\server, config, ..., $b => UNKNOWN'; n = 'sp5.ps1'; b = 'Start-Process -FilePath sc.exe -ArgumentList ''\\server'', ''config'', ''X'', ''binPath='', $b' },
        @{ label = 'PS: Start-Process sc.exe -ArgumentList $a (subcommand not provable) => UNKNOWN'; n = 'sp6.ps1'; b = 'Start-Process sc.exe -ArgumentList $a' }
    )
    foreach ($c in $scMore) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $scMoreStatic = @(
        @{ label = 'PS: literal sc.exe \\localhost create with a binPath outside the repo => NOT_REPO'; n = 'sps1.ps1'; b = 'sc.exe \\localhost create X binPath= C:\Tools\backup\svc.exe' },
        @{ label = 'PS: literal Start-Process sc.exe -ArgumentList ''config X binPath= C:\Tools\svc.exe'' => NOT_REPO'; n = 'sps2.ps1'; b = 'Start-Process sc.exe -ArgumentList ''config X binPath= C:\Tools\backup\svc.exe''' },
        @{ label = 'PS: Start-Process sc.exe -ArgumentList query, $name (not create/config) => NOT_REPO'; n = 'sps3.ps1'; b = 'Start-Process sc.exe -ArgumentList ''query'', $name' }
    )
    foreach ($c in $scMoreStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'sps4.ps1' ('Start-Process sc.exe -ArgumentList ''config X binPath= ' + $repo + '\tools\svc.exe''')).status -eq 'REPO') 'PS: literal Start-Process sc.exe with a binPath inside the repo => REPO'
    foreach ($ident in @('SYSTEM', 'LOQ')) {
        $rw = $dw + '\sc-remote-' + $ident + '.ps1'
        $script:Wrappers[$rw] = ('$b = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'sc.exe \\localhost create X binPath= $b')
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('ScRemote ' + $ident) $ident ($ps + ' -NoProfile -File "' + $rw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*ScRemote ' + $ident + '*binPath cannot be proven*')) ($ident + ' task -> wrapper -> sc.exe \\localhost create binPath= (Get-Content ...) => BLOCK')
        $spw = $dw + '\sc-start-' + $ident + '.ps1'
        $script:Wrappers[$spw] = ('$b = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'Start-Process sc.exe -ArgumentList ''config'', ''X'', ''binPath='', $b')
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('ScStart ' + $ident) $ident ($ps + ' -NoProfile -File "' + $spw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*ScStart ' + $ident + '*binPath cannot be proven*')) ($ident + ' task -> wrapper -> Start-Process sc.exe config binPath= (Get-Content ...) => BLOCK')
    }

    Write-Host '== Nested PowerShell -Command payloads inside PowerShell wrappers (Codex P1, static only)'
    $nestDyn = @(
        @{ label = 'Codex witness: powershell.exe -Command ''$p = Get-Content ...; & $p'' => UNKNOWN'; n = 'nc1.ps1'; b = 'powershell.exe -Command ''$p = Get-Content C:\ProgramData\target.txt; & $p''' },
        @{ label = 'powershell -NoProfile -c ''& $p'' (abbreviated) => UNKNOWN'; n = 'nc2.ps1'; b = 'powershell -NoProfile -c ''& $p''' },
        @{ label = 'pwsh.exe -CommandWithArgs ''& $p'' => UNKNOWN'; n = 'nc3.ps1'; b = 'pwsh.exe -CommandWithArgs ''& $p''' },
        @{ label = 'powershell.exe -ExecutionPolicy Bypass -Command ''iex $x'' => UNKNOWN'; n = 'nc4.ps1'; b = 'powershell.exe -ExecutionPolicy Bypass -Command ''Invoke-Expression $x''' },
        @{ label = 'powershell.exe ''& $p'' (positional command) => UNKNOWN'; n = 'nc5.ps1'; b = 'powershell.exe ''& $p''' },
        @{ label = 'two nested levels: powershell -Command "powershell -Command ''& $p''" => UNKNOWN'; n = 'nc6.ps1'; b = 'powershell.exe -Command "powershell.exe -Command ''& `$p''"' },
        @{ label = 'computed -Command $cmd => UNKNOWN (unchanged rule)'; n = 'nc7.ps1'; b = 'powershell.exe -Command $cmd' },
        @{ label = 'powershell.exe -Command ''-'' (stdin) => UNKNOWN'; n = 'nc8.ps1'; b = 'powershell.exe -Command ''-''' }
    )
    foreach ($c in $nestDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    $nestStatic = @(
        @{ label = 'nested safe literal: powershell.exe -NoProfile -Command ''Get-Date'' => NOT_REPO'; n = 'ncs1.ps1'; b = 'powershell.exe -NoProfile -Command ''Get-Date -Format o''' },
        @{ label = 'nested safe literal with a static call: -Command ''& C:\safe\tool.ps1'' => NOT_REPO'; n = 'ncs2.ps1'; b = 'powershell.exe -NoProfile -Command ''& C:\safe\tool.ps1''' },
        @{ label = 'pwsh positional is a file, not a command: pwsh C:\safe\tool.ps1 => NOT_REPO'; n = 'ncs3.ps1'; b = 'pwsh C:\safe\tool.ps1' }
    )
    foreach ($c in $nestStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'ncs4.ps1' ('powershell.exe -NoProfile -Command ''& ''''' + $repo + '\tools\x.ps1''''''')).status -eq 'REPO') 'nested literal -Command calling a repository script => REPO'
    $deep = 'Get-Date'
    for ($d = 0; $d -lt 6; $d++) { $deep = 'powershell.exe -Command ''' + ($deep -replace "'", "''") + '''' }
    $got = Get-PsDynamicExecution $deep
    Assert-True ($got -like '*deeper than 3 levels*') ('recursion guard: 6 nested -Command levels => UNKNOWN (got ' + $got + ')')
    foreach ($ident in @('SYSTEM', 'LOQ')) {
        $nw = $dw + '\nested-' + $ident + '.ps1'
        $script:Wrappers[$nw] = 'powershell.exe -Command ''$p = Get-Content C:\ProgramData\target.txt; & $p'''
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('Nested ' + $ident) $ident ($ps + ' -NoProfile -File "' + $nw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*Nested ' + $ident + '*nested powershell.exe -Command*')) ('Codex witness under ' + $ident + ': wrapper -> powershell.exe -Command ''$p = Get-Content ...; & $p'' => BLOCK')
    }
    # -Command بمصفوفة حرفية أو @(...): النص الذي يصل إلى powershell.exe غير مثبت ⇒ UNKNOWN (لا Extent.Text).
    $arrCases = @(
        @{ label = 'powershell.exe -Command ''$p = Get-Content C:\x.txt;'', ''& $p'' (literal array) => UNKNOWN'; n = 'na1.ps1'; b = 'powershell.exe -Command ''$p = Get-Content C:\x.txt;'', ''& $p''' },
        @{ label = 'powershell.exe -Command @(''$p = Get-Content C:\x.txt;'', ''& $p'') => UNKNOWN'; n = 'na2.ps1'; b = 'powershell.exe -Command @(''$p = Get-Content C:\x.txt;'', ''& $p'')' },
        @{ label = 'powershell.exe ''Get-Date'', ''-Format'' (positional array) => UNKNOWN'; n = 'na3.ps1'; b = 'powershell.exe ''Get-Date'', ''-Format''' },
        @{ label = 'powershell.exe -Command:@(''Get-Date'') (attached array) => UNKNOWN'; n = 'na4.ps1'; b = 'powershell.exe -Command:@(''Get-Date'')' }
    )
    foreach ($c in $arrCases) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*not a single literal string*') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    foreach ($ident in @('SYSTEM', 'LOQ')) {
        $aw = $dw + '\nested-array-' + $ident + '.ps1'
        $script:Wrappers[$aw] = 'powershell.exe -Command ''$p = Get-Content C:\x.txt;'', ''& $p'''
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('NestedArray ' + $ident) $ident ($ps + ' -NoProfile -File "' + $aw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*NestedArray ' + $ident + '*not a single literal string*')) ($ident + ' task -> wrapper -> powershell.exe -Command (literal array) => BLOCK')
    }
    Assert-True ((Dyn-Reach 'na5.ps1' 'powershell.exe -NoProfile -Command Get-Date -Format o').status -eq 'NOT_REPO') 'unquoted barewords and parameters after -Command (single literal tokens) => NOT_REPO'

    Write-Host '== Dynamic module / code loading inside PowerShell wrappers (Codex P1)'
    $script:Wrappers['C:\safe\mod.psm1'] = 'function Get-Safe { Get-Date }'
    $script:Wrappers['c:\safe\mod.psm1'] = 'function Get-Safe { Get-Date }'
    $modDyn = @(
        @{ label = 'Import-Module $p (from a data file) => UNKNOWN'; n = 'm1.ps1'; b = ('$p = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'Import-Module $p') },
        @{ label = 'ipmo alias with a computed target => UNKNOWN'; n = 'm2.ps1'; b = 'ipmo $mod' },
        @{ label = 'Import-Module -Name (expression) => UNKNOWN'; n = 'm3.ps1'; b = 'Import-Module -Name (Join-Path $root ''x.psm1'')' },
        @{ label = 'Import-Module "$dir\x.psm1" (expandable string) => UNKNOWN'; n = 'm4.ps1'; b = 'Import-Module "$dir\x.psm1" -Force' },
        @{ label = 'Import-Module relative path .\mods\x.psm1 => UNKNOWN'; n = 'm5.ps1'; b = 'Import-Module .\mods\x.psm1' },
        @{ label = 'Import-Module -ModuleInfo $m (computed module object) => UNKNOWN'; n = 'm6.ps1'; b = 'Import-Module -ModuleInfo $m' },
        @{ label = 'Add-Type -Path $dll => UNKNOWN'; n = 'm7.ps1'; b = 'Add-Type -Path $dll' },
        @{ label = 'Add-Type -TypeDefinition (Get-Content ... -Raw) => UNKNOWN'; n = 'm8.ps1'; b = 'Add-Type -TypeDefinition (Get-Content C:\ProgramData\code.cs -Raw)' },
        @{ label = '[Reflection.Assembly]::LoadFile($p) => UNKNOWN'; n = 'm9.ps1'; b = '[System.Reflection.Assembly]::LoadFile($p)' },
        @{ label = 'New-Module -ScriptBlock $sb => UNKNOWN'; n = 'm10.ps1'; b = 'New-Module -ScriptBlock $sb | Import-Module' },
        @{ label = 'Import-Module fed from the pipeline (module object not static) => UNKNOWN'; n = 'm11.ps1'; b = 'Get-Content C:\ProgramData\mods.txt | Import-Module' }
    )
    foreach ($c in $modDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $modStatic = @(
        @{ label = 'Import-Module ''C:\safe\mod.psm1'' (literal absolute, traced) => NOT_REPO'; n = 'ms1.ps1'; b = 'Import-Module ''C:\safe\mod.psm1'' -Force' },
        @{ label = 'Import-Module by bare module name (resolved from PSModulePath) => NOT_REPO'; n = 'ms2.ps1'; b = 'Import-Module ScheduledTasks' },
        @{ label = 'Add-Type with a literal type definition => NOT_REPO'; n = 'ms3.ps1'; b = 'Add-Type -TypeDefinition ''public static class Ozk { public static int One() { return 1; } }''' },
        @{ label = 'New-Module with a literal script block => NOT_REPO'; n = 'ms4.ps1'; b = '$m = New-Module -ScriptBlock { function Get-X { 1 } }' }
    )
    foreach ($c in $modStatic) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Assert-True ((Dyn-Reach 'ms5.ps1' ('Import-Module ''' + $repo + '\tools\ozk.psm1''')).status -eq 'REPO') 'Import-Module of a literal repository module => REPO'
    $mw = $dw + '\module-witness.ps1'
    $script:Wrappers[$mw] = ('$p = Get-Content C:\ProgramData\target.txt' + "`r`n" + 'Import-Module $p')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Module Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $mw + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Module Witness*computed module target*') 'Codex witness: privileged task -> wrapper -> Import-Module (Get-Content ...) => BLOCK'

    Write-Host '== Every interpreter-supported script type is traced or UNKNOWN (Codex P1)'
    $sd = 'C:\outside'
    $script:Wrappers[$sd + '\bootstrap.mjs'] = 'import "C:/Users/LOQ/Documents/OZK-TOBACCO/tobacco-web/scripts/serve.mjs"'
    $script:Wrappers[$sd + '\job.py'] = 'import runpy'
    $scriptCases = @(
        @{ label = 'node.exe C:\outside\bootstrap.mjs (outside the repo) => UNKNOWN, never NOT_REPO'; a = [pscustomobject]@{ execute = 'node.exe'; arguments = ($sd + '\bootstrap.mjs'); workingDirectory = '' }; want = 'UNKNOWN' },
        @{ label = 'node.exe C:\outside\app.cjs => UNKNOWN'; a = [pscustomobject]@{ execute = 'C:\Program Files\nodejs\node.exe'; arguments = ('"' + $sd + '\app.cjs"'); workingDirectory = '' }; want = 'UNKNOWN' },
        @{ label = 'node.exe C:\outside\server.js (node module semantics) => UNKNOWN'; a = [pscustomobject]@{ execute = 'node.exe'; arguments = ($sd + '\server.js'); workingDirectory = '' }; want = 'UNKNOWN' },
        @{ label = 'python.exe C:\outside\job.py => UNKNOWN'; a = [pscustomobject]@{ execute = 'python.exe'; arguments = ($sd + '\job.py'); workingDirectory = '' }; want = 'UNKNOWN' },
        @{ label = 'script opened by file association (execute = C:\outside\job.py) => UNKNOWN'; a = [pscustomobject]@{ execute = ($sd + '\job.py'); arguments = ''; workingDirectory = '' }; want = 'UNKNOWN' },
        @{ label = 'node script inside the repo => REPO (unchanged)'; a = [pscustomobject]@{ execute = 'node.exe'; arguments = ($repo + '\scripts\serve.mjs'); workingDirectory = '' }; want = 'REPO' },
        @{ label = 'wscript C:\outside\x.js (JScript, inspected) => NOT_REPO'; a = [pscustomobject]@{ execute = 'wscript.exe'; arguments = ('"' + $sd + '\x.js"'); workingDirectory = '' }; want = 'NOT_REPO' }
    )
    $script:Wrappers[$sd + '\x.js'] = 'var sh = new ActiveXObject("WScript.Shell"); sh.Run("\"C:\\Tools\\backup\\run-backup.exe\"", 0, true);'
    foreach ($c in $scriptCases) { $got = Resolve-TaskReach $cfgD @($c.a) 'SYSTEM'; Assert-True ($got.status -eq $c.want) ($c.label + ' (got ' + $got.status + ')') }
    Assert-True ((Dyn-Reach 'callpy.cmd' ('python "' + $sd + '\job.py"')).status -eq 'UNKNOWN') 'cmd wrapper referencing a Python script outside the repo => UNKNOWN'
    Assert-True ((Dyn-Reach 'callpsd.ps1' ('Import-Module ''' + $repo + '\tools\ozk.psd1''')).status -eq 'REPO') 'module manifest (.psd1) inside the repo => REPO'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Node Bootstrap System' 'SYSTEM' 'x' @([pscustomobject]@{ execute = 'node.exe'; arguments = ($sd + '\bootstrap.mjs'); workingDirectory = '' }))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Node Bootstrap System*not statically inspected*') 'Codex witness: SYSTEM node.exe C:\outside\bootstrap.mjs => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Node Bootstrap User' 'OZKSync' 'x' @([pscustomobject]@{ execute = 'node.exe'; arguments = ($sd + '\bootstrap.mjs'); workingDirectory = '' }))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'same node task under a non-privileged identity => not a privilege risk'

    Write-Host '== PowerShell alias definitions change command semantics (Codex P1)'
    $aliasDyn = @(
        @{ label = 'Set-Alias launch Start-Process; launch powershell.exe -ArgumentList (Get-Content ...) => UNKNOWN'; n = 'al1.ps1'; b = ('Set-Alias launch Start-Process' + "`r`n" + 'launch powershell.exe -ArgumentList (Get-Content C:\ProgramData\target.txt)') },
        @{ label = 'New-Alias -Name launch -Value Start-Process => UNKNOWN'; n = 'al2.ps1'; b = ('New-Alias -Name launch -Value Start-Process' + "`r`n" + 'launch C:\Tools\x.exe') },
        @{ label = 'sal (alias of Set-Alias) => UNKNOWN'; n = 'al3.ps1'; b = 'sal launch Start-Process' },
        @{ label = 'nal (alias of New-Alias) => UNKNOWN'; n = 'al4.ps1'; b = 'nal launch Start-Process' },
        @{ label = 'Import-Alias from a file => UNKNOWN'; n = 'al5.ps1'; b = 'Import-Alias C:\ProgramData\aliases.csv' },
        @{ label = 'Set-Item alias:launch Start-Process (alias: drive) => UNKNOWN'; n = 'al6.ps1'; b = 'Set-Item alias:launch Start-Process' },
        @{ label = 'New-Item -Path Alias:launch -Value Start-Process => UNKNOWN'; n = 'al7.ps1'; b = 'New-Item -Path Alias:launch -Value Start-Process' },
        @{ label = '${alias:launch} = ''Start-Process'' (assignment) => UNKNOWN'; n = 'al8.ps1'; b = '${alias:launch} = ''Start-Process''' },
        @{ label = '$alias:launch = ''Start-Process'' (assignment) => UNKNOWN'; n = 'al9.ps1'; b = '$alias:launch = ''Start-Process''' },
        @{ label = 'Remove-Item alias:start (changes what start resolves to) => UNKNOWN'; n = 'al10.ps1'; b = 'Remove-Item alias:start' }
    )
    foreach ($c in $aliasDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $aliasSafe = @(
        @{ label = 'Get-Alias (read-only) => unchanged (NOT_REPO)'; n = 'als1.ps1'; b = 'Get-Alias | Out-File C:\Logs\aliases.txt' },
        @{ label = 'Get-ChildItem alias: / Test-Path alias:ls (read-only) => unchanged (NOT_REPO)'; n = 'als2.ps1'; b = ('Get-ChildItem alias:' + "`r`n" + 'Test-Path alias:ls') },
        @{ label = 'wrapper without alias definitions (literal Start-Process) => unchanged (NOT_REPO)'; n = 'als3.ps1'; b = 'Start-Process -FilePath ''C:\Tools\backup\run-backup.exe'' -Wait' }
    )
    foreach ($c in $aliasSafe) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    $aw = $dw + '\alias-witness.ps1'
    $script:Wrappers[$aw] = ('Set-Alias launch Start-Process' + "`r`n" + 'launch powershell.exe -ArgumentList (Get-Content C:\ProgramData\target.txt)')
    foreach ($ident in @('SYSTEM', 'OZK2026\Administrator')) {
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('Alias Witness ' + $ident) $ident ($ps + ' -NoProfile -File "' + $aw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) ('*Alias Witness*alias definition changes command semantics*')) ('Codex witness under ' + $ident + ' => BLOCK')
    }
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Alias Witness User' 'OZKSync' ($ps + ' -NoProfile -File "' + $aw + '"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'same wrapper under a non-privileged identity => not a privilege risk'

    Write-Host '== Alias edge cases: inline parameter argument and computed item-mutation targets'
    $aliasEdge = @(
        @{ label = 'Set-Item -Path:alias:launch Start-Process (alias: inside the parameter token) => UNKNOWN'; n = 'ae1.ps1'; b = 'Set-Item -Path:alias:launch Start-Process' },
        @{ label = 'New-Item -Path:''alias:launch'' -Value Start-Process => UNKNOWN'; n = 'ae2.ps1'; b = 'New-Item -Path:''alias:launch'' -Value Start-Process' },
        @{ label = 'Set-Item "alias:$n" Start-Process (expandable string) => UNKNOWN'; n = 'ae3.ps1'; b = 'Set-Item "alias:$n" Start-Process' },
        @{ label = 'Set-Item (''ali''+''as:launch'') Start-Process (computed target) => UNKNOWN'; n = 'ae4.ps1'; b = 'Set-Item (''ali''+''as:launch'') Start-Process' },
        @{ label = '$p = ''ali'' + ''as:launch''; New-Item -Path $p ... => UNKNOWN'; n = 'ae5.ps1'; b = ('$p = ''ali'' + ''as:launch''' + "`r`n" + 'New-Item -Path $p -Value Start-Process') },
        @{ label = 'Remove-Item -LiteralPath $x (computed) => UNKNOWN'; n = 'ae6.ps1'; b = 'Remove-Item -LiteralPath $x' },
        @{ label = '$x | Remove-Item (target from the pipeline) => UNKNOWN'; n = 'ae7.ps1'; b = '$x | Remove-Item' },
        @{ label = 'Copy-Item ... -Destination $d (computed destination) => UNKNOWN'; n = 'ae8.ps1'; b = 'Copy-Item ''C:\Tools\a.txt'' -Destination $d' },
        @{ label = 'Set-Location $d; Set-Item launch Start-Process (relative path after a computed location) => UNKNOWN'; n = 'ae9.ps1'; b = ('Set-Location $d' + "`r`n" + 'Set-Item launch Start-Process') }
    )
    foreach ($c in $aliasEdge) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $aliasEdgeSafe = @(
        @{ label = 'Remove-Item -Path ''C:\Logs\old.log'' (literal filesystem path) => unchanged (NOT_REPO)'; n = 'aes1.ps1'; b = 'Remove-Item -Path ''C:\Logs\old.log''' },
        @{ label = 'New-Item -ItemType Directory -Path ''C:\Logs\x'' => unchanged (NOT_REPO)'; n = 'aes2.ps1'; b = 'New-Item -ItemType Directory -Path ''C:\Logs\x'' -Force' },
        @{ label = 'Set-Content -Path $log -Value $x (content, not the alias provider) => unchanged (NOT_REPO)'; n = 'aes3.ps1'; b = ('$log = ''C:\Logs\x.log''' + "`r`n" + 'Set-Content -Path $log -Value (Get-Date)') },
        @{ label = 'Set-Location ''C:\Tools''; Remove-Item ''old.log'' (literal location) => unchanged (NOT_REPO)'; n = 'aes4.ps1'; b = ('Set-Location ''C:\Tools''' + "`r`n" + 'Remove-Item ''old.log''') }
    )
    foreach ($c in $aliasEdgeSafe) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    $aew = $dw + '\alias-edge-witness.ps1'
    $script:Wrappers[$aew] = ('Set-Item (''ali''+''as:launch'') Start-Process' + "`r`n" + 'launch powershell.exe -ArgumentList (Get-Content C:\ProgramData\target.txt)')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Alias Edge Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $aew + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Alias Edge Witness*alias: provider cannot be ruled out*') 'privileged task -> Set-Item (computed alias path) + launch => BLOCK'

    Write-Host '== Computed script blocks via ForEach-Object / Where-Object / [scriptblock] casts (Codex P1)'
    $sbDyn = @(
        @{ label = 'Codex witness: $sb = [scriptblock](Get-Content ...); 1 | ForEach-Object -Process $sb => UNKNOWN'; n = 'sb1.ps1'; b = ('$sb = [scriptblock](Get-Content C:\ProgramData\target.txt -Raw)' + "`r`n" + '1 | ForEach-Object -Process $sb') },
        @{ label = 'ForEach-Object -Process $sb => UNKNOWN'; n = 'sb2.ps1'; b = '1 | ForEach-Object -Process $sb' },
        @{ label = '% $sb => UNKNOWN'; n = 'sb3.ps1'; b = '1 | % $sb' },
        @{ label = 'Where-Object $sb => UNKNOWN'; n = 'sb4.ps1'; b = '1 | Where-Object $sb' },
        @{ label = '? $sb => UNKNOWN'; n = 'sb5.ps1'; b = '1 | ? $sb' },
        @{ label = '[scriptblock](Get-Content ...) alone => UNKNOWN'; n = 'sb6.ps1'; b = '$x = [scriptblock](Get-Content C:\ProgramData\code.txt -Raw)' },
        @{ label = '[scriptblock]$variable => UNKNOWN'; n = 'sb7.ps1'; b = '$x = [scriptblock]$code' },
        @{ label = '$code -as [scriptblock] (computed) => UNKNOWN'; n = 'sb8.ps1'; b = '$x = $code -as [scriptblock]' },
        @{ label = 'composed: ForEach-Object -Begin {..} -Process $sb -End {..} => UNKNOWN'; n = 'sb9.ps1'; b = '1 | % -Begin { 1 } -Process $sb -End { 2 }' },
        @{ label = 'composed: -Process { literal }, $sb (array) => UNKNOWN'; n = 'sb10.ps1'; b = '1 | ForEach-Object -Process { 1 }, $sb' },
        @{ label = '$sbs | % Invoke (invokes pipeline script blocks) => UNKNOWN'; n = 'sb11.ps1'; b = '$sbs | % Invoke' },
        @{ label = '% -MemberName $m (computed member) => UNKNOWN'; n = 'sb12.ps1'; b = '1 | % -MemberName $m' },
        @{ label = '[scriptblock]''& $p'' (literal text with a dynamic call) => UNKNOWN'; n = 'sb13.ps1'; b = '$x = [scriptblock]''& $p''' }
    )
    foreach ($c in $sbDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $sbSafe = @(
        @{ label = '1..3 | ForEach-Object { $_ * 2 } (literal block) => unchanged (NOT_REPO)'; n = 'sbs1.ps1'; b = '1..3 | ForEach-Object { $_ * 2 }' },
        @{ label = 'Where-Object { $_.Status -eq ''Running'' } (literal block) => unchanged (NOT_REPO)'; n = 'sbs2.ps1'; b = 'Get-Service | Where-Object { $_.Status -eq ''Running'' }' },
        @{ label = 'Where-Object Status -eq $v (simplified syntax, literal property) => unchanged (NOT_REPO)'; n = 'sbs3.ps1'; b = 'Get-Service | ? Status -eq $v' },
        @{ label = 'ForEach-Object Name (literal member) => unchanged (NOT_REPO)'; n = 'sbs4.ps1'; b = 'Get-Process | % Name' },
        @{ label = '[scriptblock]''Get-Date'' (benign literal text) => unchanged (NOT_REPO)'; n = 'sbs5.ps1'; b = '$x = [scriptblock]''Get-Date''' }
    )
    foreach ($c in $sbSafe) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    $sbw = $dw + '\sb-witness.ps1'
    $script:Wrappers[$sbw] = ('$sb = [scriptblock](Get-Content C:\ProgramData\target.txt -Raw)' + "`r`n" + '1 | ForEach-Object -Process $sb')
    foreach ($ident in @('SYSTEM', 'OZK2026\Administrator')) {
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('SB Witness ' + $ident) $ident ($ps + ' -NoProfile -File "' + $sbw + '"'))
        Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*SB Witness*computed script block*') ('Codex witness under ' + $ident + ' => BLOCK')
    }

    Write-Host '== Wrapper filesystem trust: modifiable/replaceable wrappers prove nothing (Codex P1)'
    function New-TestAcl([string]$Owner, $Extra = @()) { return [pscustomobject]@{ owner = $Owner; access = @(
        [pscustomobject]@{ identity = 'S-1-5-18'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $false },
        [pscustomobject]@{ identity = 'S-1-5-32-544'; rights = 'FullControl'; type = 'Allow'; inherited = $true; inheritOnly = $false },
        [pscustomobject]@{ identity = 'S-1-5-32-545'; rights = 'ReadAndExecute, Synchronize'; type = 'Allow'; inherited = $true; inheritOnly = $false }) + @($Extra) } }
    function Ace([string]$Id, [string]$Rights, [string]$Type = 'Allow', [bool]$InheritOnly = $false) { return [pscustomobject]@{ identity = $Id; rights = $Rights; type = $Type; inherited = $false; inheritOnly = $InheritOnly } }
    $tw = 'C:\ProgramData\OZK-Trust\Wrappers'
    $tf = $tw + '\job.ps1'
    $script:Wrappers[$tf] = 'Get-Date | Out-File C:\Logs\job.txt'
    function Trust-Reach { return (Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = $ps; arguments = ('-File "' + $tf + '"'); workingDirectory = '' }) 'SYSTEM') }
    function Reset-TrustAcls { $script:FsAcls = @{}; $script:FsAclErrors = @{}; $script:DirPlantCache = @{} }
    Reset-TrustAcls
    Assert-True ((Trust-Reach).status -eq 'NOT_REPO') 'privileged task + benign wrapper in a trusted path => NOT_REPO (unchanged)'
    $trustCases = @(
        @{ label = 'wrapper writable by OZKSync (Modify on the file) => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Modify, Synchronize') } },
        @{ label = 'wrapper writable by Users (WriteData on the file) => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'WriteData') } },
        @{ label = 'wrapper owned by an untrusted user (implicit WRITE_DAC) => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'OZK2026\OZKSync' } },
        @{ label = 'wrapper not writable, but its folder lets Users delete/replace children => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tw)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'DeleteSubdirectoriesAndFiles, CreateFiles') } },
        @{ label = 'folder grants OZKSync ChangePermissions (WRITE_DAC) => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tw)] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'ChangePermissions') } },
        @{ label = 'an ancestor (C:\ProgramData\OZK-Trust) lets OZKSync rename/replace the folder (Delete) => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey 'C:\ProgramData\OZK-Trust')] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Delete') } },
        @{ label = 'unreadable wrapper ACL => UNKNOWN'; set = { $script:FsAclErrors[(Resolve-TestAclKey $tf)] = 'Attempted to perform an unauthorized operation.' } },
        @{ label = 'unreadable ancestor ACL => UNKNOWN'; set = { $script:FsAclErrors[(Resolve-TestAclKey 'C:\ProgramData')] = 'Access is denied.' } },
        @{ label = 'malformed rights on the wrapper => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'NotARight') } },
        @{ label = 'write-capable ACE with an unresolvable SID => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'S-1-5-18' @(Ace 'GHOST\writer' 'Write') } },
        @{ label = 'unknown ACE type on the wrapper => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'Modify' 'Audit') } }
    )
    foreach ($c in $trustCases) { Reset-TrustAcls; & $c.set; $got = Trust-Reach; Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*untrusted principal*') ($c.label + ' (got ' + $got.status + ')') }
    $trustSafe = @(
        @{ label = 'folder grants Users create-only (cannot replace the existing wrapper) => NOT_REPO'; set = { $script:FsAcls[(Resolve-TestAclKey $tw)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, CreateDirectories, Synchronize') } },
        @{ label = 'inherit-only CREATOR OWNER on the folder => NOT_REPO'; set = { $script:FsAcls[(Resolve-TestAclKey $tw)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-3-0' 'FullControl' 'Allow' $true) } },
        @{ label = 'wrapper owned and writable by a local Administrators member (OS-administrative trust) => NOT_REPO'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'OZK2026\LOQ' @(Ace 'OZK2026\LOQ' 'FullControl') } },
        @{ label = 'a Deny ACE is not a grant => NOT_REPO'; set = { $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Write' 'Deny') } }
    )
    foreach ($c in $trustSafe) { Reset-TrustAcls; & $c.set; $got = Trust-Reach; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    Reset-TrustAcls; $savedAdmins = $script:Admins; $script:Admins = $null
    $script:FsAcls[(Resolve-TestAclKey $tf)] = New-TestAcl 'OZK2026\LOQ' @(Ace 'OZK2026\LOQ' 'FullControl')
    Assert-True ((Trust-Reach).status -eq 'UNKNOWN') 'Administrators membership undetermined => an admin-looking writer is not trusted => UNKNOWN'
    $script:Admins = $savedAdmins
    # سلسلة متداخلة: A موثوق ⇒ B في مجلد يستبدله OZKSync ⇒ UNKNOWN للسلسلة.
    Reset-TrustAcls
    $na = 'C:\ProgramData\OZK-Trust\Wrappers\outer.cmd'; $nb = 'C:\ProgramData\OZK-Loose\inner.ps1'
    $script:Wrappers[$na] = ('call powershell.exe -NoProfile -File "' + $nb + '"')
    $script:Wrappers[$nb] = 'Get-Date'
    $script:FsAcls[(Resolve-TestAclKey 'C:\ProgramData\OZK-Loose')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'Modify, Synchronize')
    $got = Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'cmd.exe'; arguments = ('/c "' + $na + '"'); workingDirectory = '' }) 'SYSTEM'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*inner.ps1*untrusted principal*') 'nested chain: trusted A -> B in a Users-replaceable folder => UNKNOWN'
    # شاهد Codex: SYSTEM ⇒ غلاف بريء ⇒ مجلد يكتبه OZKSync ⇒ BLOCK.
    Reset-TrustAcls
    $script:FsAcls[(Resolve-TestAclKey $tw)] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Modify, Synchronize')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Trust Witness' 'SYSTEM' ($ps + ' -NoProfile -File "' + $tf + '"'))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Trust Witness*untrusted principal*') 'Codex witness: SYSTEM task -> benign wrapper in an OZKSync-writable folder => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Trust Witness User' 'OZKSync' ($ps + ' -NoProfile -File "' + $tf + '"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'same wrapper under a non-privileged identity => not a privilege risk'
    Reset-TrustAcls

    Write-Host '== Collection intrinsic methods .ForEach() / .Where()'
    $colDyn = @(
        @{ label = '$items.ForEach($sb) => UNKNOWN'; n = 'co1.ps1'; b = '$items.ForEach($sb)' },
        @{ label = '$items.Where($sb) => UNKNOWN'; n = 'co2.ps1'; b = '$items.Where($sb)' },
        @{ label = 'case variation $items.foreach($sb) / .WHERE($sb, ''First'') => UNKNOWN'; n = 'co3.ps1'; b = ('$items.foreach($sb)' + "`r`n" + '$items.WHERE($sb, ''First'')') },
        @{ label = 'computed/nested block argument (.ScriptBlock of an item) => UNKNOWN'; n = 'co4.ps1'; b = '$items.ForEach((Get-Item function:x).ScriptBlock)' },
        @{ label = 'chained (1..3).Where({ literal }).ForEach($x) => UNKNOWN'; n = 'co5.ps1'; b = '(1..3).Where({ $_ -gt 1 }).ForEach($x)' },
        @{ label = '$sb = [scriptblock](Get-Content ...); @(1).ForEach($sb) => UNKNOWN'; n = 'co6.ps1'; b = ('$sb = [scriptblock](Get-Content C:\ProgramData\target.txt -Raw)' + "`r`n" + '@(1).ForEach($sb)') },
        @{ label = '@($sbs).ForEach(''Invoke'') (invokes pipeline items) => UNKNOWN'; n = 'co7.ps1'; b = '@($sbs).ForEach(''Invoke'')' },
        @{ label = 'literal block whose content is dynamic ({ & $_ }) => UNKNOWN'; n = 'co8.ps1'; b = '$items.ForEach({ & $_ })' },
        @{ label = '[scriptblock]::new((Get-Content ...)) alone (same family as ::Create) => UNKNOWN'; n = 'co9.ps1'; b = '$sb = [scriptblock]::new((Get-Content C:\ProgramData\target.txt -Raw))' }
    )
    foreach ($c in $colDyn) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'UNKNOWN') ($c.label + ' (got ' + $got.status + ')') }
    $colSafe = @(
        @{ label = '$items.ForEach({ $_ * 2 }) (literal block) => unchanged (NOT_REPO)'; n = 'cos1.ps1'; b = '$items = 1..3' + "`r`n" + '$items.ForEach({ $_ * 2 })' },
        @{ label = '$items.Where({ $_ -gt 1 }, ''First'') => unchanged (NOT_REPO)'; n = 'cos2.ps1'; b = '(1..3).Where({ $_ -gt 1 }, ''First'')' },
        @{ label = '$items.ForEach(''Name'') / .ForEach([int]) (literal member / type) => unchanged (NOT_REPO)'; n = 'cos3.ps1'; b = ('(Get-Process).ForEach(''Name'')' + "`r`n" + '(''1'',''2'').ForEach([int])') }
    )
    foreach ($c in $colSafe) { $got = Dyn-Reach $c.n $c.b; Assert-True ($got.status -eq 'NOT_REPO') ($c.label + ' (got ' + $got.status + ': ' + $got.why + ')') }
    $cow = $dw + '\collection-witness.ps1'
    $script:Wrappers[$cow] = ('$sb = [scriptblock]::new((Get-Content C:\ProgramData\target.txt -Raw))' + "`r`n" + '@(1).ForEach($sb)')
    foreach ($ident in @('SYSTEM', 'OZK2026\Administrator')) {
        $script:Tasks = @(Get-CleanLayout) + @(New-Task ('Collection Witness ' + $ident) $ident ($ps + ' -NoProfile -File "' + $cow + '"'))
        Assert-True (-not (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) ('collection .ForEach($sb) witness under ' + $ident + ' => BLOCK')
    }

    Write-Host '== Direct executable targets need filesystem trust too'
    Reset-TrustAcls
    $xd = 'C:\Tools\Svc'; $xe = $xd + '\x.exe'
    function Exe-Reach([string]$Ident = 'SYSTEM') { return (Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = $xe; arguments = '/run'; workingDirectory = '' }) $Ident) }
    Assert-True ((Exe-Reach).status -eq 'NOT_REPO') 'SYSTEM direct exe in a trusted path => NOT_REPO (unchanged)'
    $exeCases = @(
        @{ label = 'SYSTEM direct exe writable by OZKSync => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $xe)] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Modify, Synchronize') } },
        @{ label = 'exe itself safe, but its folder lets Users replace children => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $xd)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'DeleteSubdirectoriesAndFiles') } },
        @{ label = 'relevant ancestor (C:\Tools) lets OZKSync rename/replace (Delete) => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey 'C:\Tools')] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Delete') } },
        @{ label = 'unreadable exe ACL => UNKNOWN'; set = { $script:FsAclErrors[(Resolve-TestAclKey $xe)] = 'Access is denied.' } },
        @{ label = 'malformed rights on the exe => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $xe)] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'NotARight') } },
        @{ label = 'exe owned by an untrusted user => UNKNOWN'; set = { $script:FsAcls[(Resolve-TestAclKey $xe)] = New-TestAcl 'OZK2026\OZKSync' } }
    )
    foreach ($c in $exeCases) { Reset-TrustAcls; & $c.set; $got = Exe-Reach; Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*untrusted principal*') ($c.label + ' (got ' + $got.status + ')') }
    Reset-TrustAcls; $script:FsAcls[(Resolve-TestAclKey $xe)] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Modify')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Exe Trust System' 'SYSTEM' 'x' @([pscustomobject]@{ execute = $xe; arguments = '/run'; workingDirectory = '' }))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Exe Trust System*untrusted principal*') 'SYSTEM task -> exe writable by OZKSync => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Exe Trust User' 'OZKSync' 'x' @([pscustomobject]@{ execute = $xe; arguments = '/run'; workingDirectory = '' }))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'same exe under a non-privileged identity => not blocked by this rule'
    # ملف Microsoft/Windows موثوق (المالك TrustedInstaller، وكتابة لـTrustedInstaller فقط) ⇒ لا حجب.
    Reset-TrustAcls
    $sysExe = 'C:\Windows\System32\defrag.exe'
    $script:FsAcls[(Resolve-TestAclKey $sysExe)] = [pscustomobject]@{ owner = $script:TrustedInstallerSid; access = @(
        (Ace $script:TrustedInstallerSid 'FullControl'), (Ace 'S-1-5-18' 'ReadAndExecute, Synchronize'), (Ace 'S-1-5-32-544' 'ReadAndExecute, Synchronize'),
        (Ace 'S-1-5-32-545' 'ReadAndExecute, Synchronize'), (Ace 'S-1-15-2-1' 'ReadAndExecute, Synchronize')) }
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Native Trusted' 'SYSTEM' 'x' @([pscustomobject]@{ execute = $sysExe; arguments = '-c'; workingDirectory = '' }))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'native trusted executable (TrustedInstaller-owned, read-only for others) => not blocked'
    # لا توسّع: وسيط بيانات (ملف سجل) لا يُفحص ACL له.
    Reset-TrustAcls
    $script:FsAclErrors[(Resolve-TestAclKey 'C:\Logs\run.log')] = 'should never be read'
    Assert-True ((Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = $xe; arguments = '/log C:\Logs\run.log'; workingDirectory = '' }) 'SYSTEM').status -eq 'NOT_REPO') 'unrelated data file in the arguments is not ACL-checked (no sweep)'
    # COM handler binary: نفس القاعدة.
    Reset-TrustAcls; $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\Svc\handler.dll')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'Write')
    Assert-True ((Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = 'C:\Tools\Svc\handler.dll'; arguments = ''; workingDirectory = ''; classId = '{00000000-0000-0000-0000-00000000C0DE}' }) 'SYSTEM').status -eq 'UNKNOWN') 'COM handler binary writable by Users => UNKNOWN'
    Reset-TrustAcls

    Write-Host '== Bare executable names resolve through the provable Windows search order (owner decision A)'
    Reset-TrustAcls
    $savedSysPath = $script:SysPath
    $script:SysPath = 'C:\Windows\system32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0;C:\Program Files\nodejs;'
    $script:FsExistOnly = @{ 'c:\windows\system32\cmd.exe' = 1; 'c:\windows\system32\wscript.exe' = 1; 'c:\windows\system32\cscript.exe' = 1; 'c:\windows\system32\windowspowershell\v1.0\powershell.exe' = 1; 'c:\program files\nodejs\node.exe' = 1; 'c:\tools\earlybin' = 1; 'c:\tools\svc\app.js' = 1; 'c:\tools\svc' = 1 }
    $script:Wrappers['c:\tools\svc\app.js'] = 'x'
    foreach ($rt in @($repo, 'C:\Users\LOQ\Documents\OZK-TOBACCO', 'C:\Users\LOQ\.copilot\repos')) { $script:FsExistOnly[(ConvertTo-CanonicalTracePath $rt)] = 1 }
    # بقية التخطيط النظيف موجود فعلاً (أشجار كاملة بـ\*، وملفات محددة في System32 كي لا يوجد node.exe هناك).
    foreach ($tree in @(($repo + '\*'), 'C:\ProgramData\OZK-TOBACCO\*', 'C:\ProgramData\OZK-Trust\*', 'C:\safe\*', 'C:\Logs\*')) { $script:FsExistOnly[(ConvertTo-CanonicalTracePath ($tree.TrimEnd('*').TrimEnd('\'))) + '\*'] = 1 }
    foreach ($f in @('C:\Windows\system32\svchost.exe', 'C:\Windows\System32\OpenSSH\sshd.exe', 'C:\Windows\system32\sc.exe')) { $script:FsExistOnly[(ConvertTo-CanonicalTracePath $f)] = 1 }
    function Bare-Reach([string]$Exe, [string]$Ident = 'SYSTEM', [string]$ArgText = '-v', [string]$Wd = '') { return (Resolve-TaskReach $cfgD @([pscustomobject]@{ execute = $Exe; arguments = $ArgText; workingDirectory = $Wd }) $Ident) }
    $got = Bare-Reach 'node.exe'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like 'node invocation without a static target*') 'SYSTEM bare node.exe resolves uniquely to the trusted C:\Program Files\nodejs\node.exe (only the node rule applies: no static target)'
    $got = Bare-Reach 'node.exe' 'SYSTEM' 'C:\Tools\svc\app.js'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*not statically inspected*') 'SYSTEM bare node.exe with a script: resolution is trusted; only the uninspectable-script rule applies'
    $got = Bare-Reach 'cmd.exe' 'SYSTEM' '/c echo ok'
    Assert-True ($got.status -eq 'NOT_REPO') 'bare cmd.exe => resolves to trusted System32 cmd.exe (NOT_REPO)'
    $got = Bare-Reach 'wscript.exe' 'SYSTEM' '//B'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*without a script target*') 'bare wscript.exe => resolves to trusted System32 wscript.exe (only the script-target rule applies)'
    $got = Bare-Reach 'powershell.exe' 'SYSTEM' '-NoProfile -File "C:\safe\tool.ps1"'
    Assert-True ($got.status -eq 'NOT_REPO') 'bare powershell.exe => resolves through PATH to trusted WindowsPowerShell\v1.0 (NOT_REPO)'
    $got = Bare-Reach 'cscript' 'SYSTEM' '//Nologo "C:\safe\tool.vbs"'
    $script:Wrappers['c:\safe\tool.vbs'] = 'WScript.Echo 1'
    $script:FsExistOnly['c:\safe\tool.vbs'] = 1
    $got = Bare-Reach 'cscript' 'SYSTEM' '//Nologo "C:\safe\tool.vbs"'
    Assert-True ($got.status -eq 'NOT_REPO') 'bare cscript without extension => PATHEXT (.exe) resolves in System32 (NOT_REPO)'
    # مرشّح أسبق يكتبه كيان غير موثوق.
    $script:SysPath = 'C:\Tools\EarlyBin;C:\Windows\system32;C:\Windows;C:\Program Files\nodejs'
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\EarlyBin')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    $got = Bare-Reach 'node.exe' 'SYSTEM' 'C:\Tools\svc\app.js'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*can plant it in C:\Tools\EarlyBin*') 'untrusted-writable earlier PATH directory (Users CreateFiles) => UNKNOWN even though a trusted node.exe exists later'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Bare Early Plant' 'SYSTEM' 'x' @([pscustomobject]@{ execute = 'node.exe'; arguments = 'C:\Tools\svc\app.js'; workingDirectory = '' }))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Bare Early Plant*can plant it in*') 'privileged task with a plantable earlier PATH candidate => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Bare Early Plant User' 'OZKSync' 'x' @([pscustomobject]@{ execute = 'node.exe'; arguments = 'C:\Tools\svc\app.js'; workingDirectory = '' }))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'the same under a non-privileged identity => not blocked by this rule alone'
    Reset-TrustAcls
    $script:FsExistOnly['c:\tools\earlybin\node.exe'] = 1
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\EarlyBin\node.exe')] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Modify')
    $got = Bare-Reach 'node.exe' 'SYSTEM' 'C:\Tools\svc\app.js'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*untrusted principal*') 'earlier candidate exists and is writable by OZKSync (trusted one later in PATH) => UNKNOWN'
    $script:FsExistOnly.Remove('c:\tools\earlybin\node.exe')
    # مجلد PATH مفقود يستطيع كيان غير موثوق إنشاءه.
    Reset-TrustAcls
    $script:SysPath = 'C:\Windows\system32;C:\Windows;C:\NewTool\bin;C:\Program Files\nodejs'
    $script:FsAcls[(Resolve-TestAclKey 'C:\')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-11' 'CreateDirectories, Synchronize')
    $got = Bare-Reach 'node.exe' 'SYSTEM' 'C:\Tools\svc\app.js'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*C:\NewTool\bin*') 'missing PATH directory whose ancestor lets Authenticated Users create folders => UNKNOWN'
    Reset-TrustAcls
    # PATH غير مقروء/غامض/ديناميكي/نسبي.
    $pathCases = @(
        @{ label = 'unreadable system PATH => UNKNOWN'; set = { $script:SysPathError = 'Requested registry access is not allowed.' } },
        @{ label = 'quoted PATH entry (ambiguous) => UNKNOWN'; set = { $script:SysPath = 'C:\Windows\system32;"C:\Program Files\nodejs"' } },
        @{ label = 'PATH entry with an unresolved variable (dynamic) => UNKNOWN'; set = { $script:SysPath = 'C:\Windows\system32;%NODE_HOME%\bin' } },
        @{ label = 'relative PATH entry => UNKNOWN'; set = { $script:SysPath = 'C:\Windows\system32;bin;C:\Program Files\nodejs' } },
        @{ label = 'whitespace-only PATH entry => UNKNOWN'; set = { $script:SysPath = 'C:\Windows\system32; ;C:\Program Files\nodejs' } },
        @{ label = 'user PATH hive not loaded => UNKNOWN'; set = { $script:UserPathErrors['S-1-5-18'] = 'user registry hive is not loaded' } },
        @{ label = 'relative user PATH entry => UNKNOWN'; set = { $script:UserPaths['S-1-5-18'] = '.\tools' } }
    )
    foreach ($c in $pathCases) {
        $script:SysPath = 'C:\Windows\system32;C:\Windows;C:\Program Files\nodejs;'; $script:SysPathError = $null; $script:UserPaths = @{}; $script:UserPathErrors = @{}
        & $c.set
        $got = Bare-Reach 'cmd.exe' 'SYSTEM' '/c echo ok'
        Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*search path cannot be proven*') ($c.label + ' (got ' + $got.status + ')')
    }
    $script:SysPath = 'C:\Windows\system32;C:\Windows;C:\Program Files\nodejs;'; $script:SysPathError = $null; $script:UserPaths = @{}; $script:UserPathErrors = @{}
    Assert-True ((Bare-Reach 'cmd.exe' 'SYSTEM' '/c echo ok').status -eq 'NOT_REPO') 'a trailing ";" (zero-length entry, skipped by Windows search) is not ambiguity'
    Assert-True ((Bare-Reach 'nosuch.exe' 'SYSTEM' '').status -eq 'UNKNOWN') 'bare executable not found anywhere on the provable search path => UNKNOWN'
    Assert-True ((Bare-Reach 'cmd.exe' 'BUILTIN\Users' '/c echo ok').status -eq 'UNKNOWN') 'execution identity whose user PATH cannot be determined (group) => UNKNOWN'
    # داخل cmd /c: المجلد الحالي أولاً (بحث cmd)؛ مجلد عمل يكتبه غير موثوق ⇒ UNKNOWN حتى لـcmd.exe.
    $script:FsExistOnly['c:\work'] = 1
    $script:FsAcls[(Resolve-TestAclKey 'C:\Work')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    $got = Bare-Reach 'cmd.exe' 'SYSTEM' '/c node.exe C:\Tools\svc\app.js' 'C:\Work'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*C:\Work*') 'inside cmd /c, a Users-writable current directory is searched first => UNKNOWN'
    Reset-TrustAcls
    Assert-True ((Bare-Reach 'C:\Windows\system32\cmd.exe' 'SYSTEM' '/c echo ok').status -eq 'NOT_REPO') 'explicit absolute trusted executable => unchanged (NOT_REPO)'
    Write-Host '== cmd /c search order: current directory, then PATH entries in their real order (no implicit System32)'
    $cmdAbs = 'C:\Windows\system32\cmd.exe'
    $script:FsExistOnly['c:\windows\system32\whoami.exe'] = 1
    $script:FsExistOnly['c:\tools\trustedbin'] = 1
    $sysNormal = 'C:\Windows\system32;C:\Windows;C:\Program Files\nodejs;'
    $sysEarly = 'C:\Tools\EarlyBin;C:\Windows\system32;C:\Windows'
    $script:SysPath = $sysNormal
    Assert-True ((Bare-Reach $cmdAbs 'SYSTEM' '/c whoami.exe').status -eq 'NOT_REPO') 'SYSTEM cmd /c whoami.exe, normal PATH, trusted System32 target => NOT_REPO'
    $script:SysPath = $sysEarly
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\EarlyBin')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    $got = Bare-Reach $cmdAbs 'SYSTEM' '/c whoami.exe'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*can plant it in C:\Tools\EarlyBin*') ('Users-writable PATH entry before System32 => UNKNOWN; System32 later in PATH does not cancel it (got ' + $got.status + ': ' + $got.why + ')')
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Cmd Early Plant' 'SYSTEM' 'x' @([pscustomobject]@{ execute = $cmdAbs; arguments = '/c whoami.exe'; workingDirectory = '' }))
    Assert-True (Test-BlockLike (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*Cmd Early Plant*can plant it in*') 'SYSTEM task cmd /c whoami.exe with a plantable PATH entry before System32 => BLOCK'
    $script:Tasks = @(Get-CleanLayout) + @(New-Task 'Cmd Early Plant User' 'OZKSync' 'x' @([pscustomobject]@{ execute = $cmdAbs; arguments = '/c whoami.exe'; workingDirectory = '' }))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'the same under a non-privileged identity => not blocked by this rule alone'
    Reset-TrustAcls
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\EarlyBin')] = New-TestAcl 'S-1-5-18' @(Ace 'OZK2026\OZKSync' 'Modify')
    $got = Bare-Reach $cmdAbs 'SYSTEM' '/c whoami.exe'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*can plant it in C:\Tools\EarlyBin*') 'OZKSync-writable PATH entry before System32 => UNKNOWN'
    # الترتيب القديم الخاطئ (System32 قبل PATH داخل cmd) كان سيحلّها من System32؛ Action المهمة (CreateProcess) تبقى كما هي.
    Assert-True ((Bare-Reach 'whoami.exe' 'SYSTEM' '').status -eq 'NOT_REPO') 'task Action (CreateProcess) keeps its own order: System32 before PATH => NOT_REPO for the same PATH'
    Assert-True ((Bare-Reach $cmdAbs 'SYSTEM' '/c C:\Windows\System32\whoami.exe').status -eq 'NOT_REPO') 'explicit absolute target inside cmd /c => unaffected by a plantable PATH entry'
    Reset-TrustAcls
    # الترتيب الموثوق: PATH يبدأ بـSystem32 ثم مجلد قابل للزرع لاحقاً ⇒ الهدف يُحلّ قبله.
    $script:SysPath = 'C:\Windows\system32;C:\Tools\EarlyBin'
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\EarlyBin')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    Assert-True ((Bare-Reach $cmdAbs 'SYSTEM' '/c whoami.exe').status -eq 'NOT_REPO') 'trusted PATH ordering (System32 first, plantable entry later) => NOT_REPO'
    # مجلد العمل قابل للكتابة ويأتي أولاً.
    $script:FsExistOnly['c:\work'] = 1
    $script:FsAcls[(Resolve-TestAclKey 'C:\Work')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    $got = Bare-Reach $cmdAbs 'SYSTEM' '/c whoami.exe' 'C:\Work'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*can plant it in C:\Work*') 'Users-writable working directory searched first by cmd => UNKNOWN'
    Reset-TrustAcls
    # المجلد الحالي اختياري (NoDefaultCurrentDirectoryInExePath): هدف موثوق فيه لا يُنهي البحث.
    $script:SysPath = $sysEarly
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\EarlyBin')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    $got = Bare-Reach $cmdAbs 'SYSTEM' '/c whoami.exe' 'C:\Windows\System32'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*C:\Tools\EarlyBin*') 'trusted target in the current directory does not end the search (cmd may skip it) => plantable PATH entry still UNKNOWN'
    Reset-TrustAcls
    # امتداد PATHEXT أسبق قابل للزرع في مجلد الهدف نفسه.
    $script:SysPath = 'C:\Tools\TrustedBin;C:\Windows\system32'
    $script:FsExistOnly['c:\tools\trustedbin\whoami.exe'] = 1
    $script:FsAcls[(Resolve-TestAclKey 'C:\Tools\TrustedBin')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'CreateFiles, Synchronize')
    $got = Bare-Reach $cmdAbs 'SYSTEM' '/c whoami' 'C:\safe'
    Assert-True ($got.status -eq 'UNKNOWN' -and $got.why -like '*plant an earlier extension in C:\Tools\TrustedBin*') ('PATHEXT: plantable .com before the found whoami.exe => UNKNOWN (got ' + $got.status + ': ' + $got.why + ')')
    Reset-TrustAcls
    Assert-True ((Bare-Reach $cmdAbs 'SYSTEM' '/c whoami' 'C:\safe').status -eq 'NOT_REPO') 'PATHEXT with a trusted target directory => NOT_REPO'
    $script:FsExistOnly.Remove('c:\tools\trustedbin\whoami.exe')
    $script:SysPath = 'C:\Windows\system32;C:\Windows;C:\Program Files\nodejs;'
    $script:FsExistOnly = $null; $script:SysPath = $savedSysPath

    Write-Host '== Running-Process P1 phase 1: process inventory classification (synthetic records only)'
    # بيانات اصطناعية حصراً: المصدران مستبدلان، فلا يُقرأ جرد عمليات الـrunner الحقيقي ولا تُنشأ عمليات.
    $script:ProcRecords = @(); $script:ProcError = $null; $script:ProcStates = @{}; $script:RealProcCalls = 0
    function Get-PreflightProcessInventory { if ($script:ProcError) { throw $script:ProcError }; return $script:ProcRecords }
    function Get-PreflightProcessState([int]$ProcessId, $CreationDate) { if ($script:ProcStates.ContainsKey($ProcessId)) { return $script:ProcStates[$ProcessId] }; return 'PRESENT' }
    $t0 = [datetime]'2026-10-01T08:00:00Z'
    function P([int]$Id, [string]$Name, [string]$Exe, [string]$Cmd, [string]$Owner, [string]$Sid = '') { return [pscustomobject]@{ pid = $Id; creationDate = $t0.AddSeconds($Id); name = $Name; sessionId = 0; executablePath = $Exe; commandLine = $Cmd; owner = $Owner; sid = $Sid } }
    $baseline = @(
        (P 700 'svchost.exe' 'C:\Windows\system32\svchost.exe' 'C:\Windows\system32\svchost.exe -k netsvcs -p' '' 'S-1-5-18'),
        (P 900 'explorer.exe' 'C:\Windows\explorer.exe' 'C:\Windows\explorer.exe' 'OZK2026\OZKSync')
    )
    function Proc-Run($Extra) { $script:ProcRecords = @($baseline) + @($Extra); return (Invoke-ProcessInventoryPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) }
    $got = Proc-Run @()
    Assert-True ($got.ok) ('baseline: SYSTEM trusted system binary + ordinary user process => no block (got ' + (@($got.results | ForEach-Object { $_.reason }) -join '; ') + ')')
    Assert-True (Test-BlockLike (Proc-Run @(P 1001 'node.exe' 'C:\Program Files\nodejs\node.exe' ('"C:\Program Files\nodejs\node.exe" "' + $repo + '\scripts\serve.mjs"') '' 'S-1-5-18')) '*1001*runs repository code*') 'SYSTEM interpreter with a repository script => BLOCK (REPO)'
    Assert-True (Test-BlockLike (Proc-Run @(P 1002 'powershell.exe' $ps ($ps + ' -NoProfile -File "' + $repo + '\tools\x.ps1"') 'OZK2026\LOQ')) '*1002*runs repository code*') 'local Administrators member (LOQ) PowerShell with a repository script => BLOCK'
    Assert-True (Test-BlockLike (Proc-Run @(P 1003 'app.exe' ($repo + '\bin\app.exe') ('"' + $repo + '\bin\app.exe"') 'OZK2026\Administrator')) '*1003*runs repository code*') 'local Administrator running an executable inside the repository => BLOCK'
    Assert-True ((Proc-Run @(P 1004 'sc.exe' 'C:\Windows\system32\sc.exe' 'sc.exe query X' '' 'S-1-5-18')).ok) 'SYSTEM trusted external literal process => no block (NOT_REPO)'
    Assert-True (Test-BlockLike (Proc-Run @(P 1005 'node.exe' 'C:\Program Files\nodejs\node.exe' 'node.exe scripts\serve.mjs' '' 'S-1-5-18')) '*1005*cannot prove*') 'SYSTEM interpreter with a relative script (no provable working directory) => BLOCK (UNKNOWN)'
    Assert-True (Test-BlockLike (Proc-Run @(P 1006 'node.exe' 'C:\Program Files\nodejs\node.exe' '' '' 'S-1-5-18')) '*1006*without a readable command line*') 'SYSTEM interpreter without a readable command line => BLOCK (UNKNOWN)'
    Assert-True (Test-BlockLike (Proc-Run @(P 1007 'unknown.exe' '' '' '' 'S-1-5-18')) '*1007*executable path unavailable*') 'SYSTEM process with no readable executable path (still present) => BLOCK (UNKNOWN)'
    Reset-TrustAcls
    $script:FsAcls[(Resolve-TestAclKey 'C:\Users\Public\tool.exe')] = New-TestAcl 'S-1-5-18' @(Ace 'S-1-5-32-545' 'Modify')
    Assert-True (Test-BlockLike (Proc-Run @(P 1008 'tool.exe' 'C:\Users\Public\tool.exe' '"C:\Users\Public\tool.exe"' '' 'S-1-5-18')) '*1008*cannot prove*') 'SYSTEM executable outside the repo writable by Users (untrusted) => BLOCK (UNKNOWN)'
    Reset-TrustAcls
    Assert-True (Test-BlockLike (Proc-Run @(P 1009 'node.exe' 'C:\Program Files\nodejs\node.exe' ('node.exe "' + $repo + '\scripts\serve.mjs"') '' '')) '*1009*owner unresolved*') 'unknown owner is treated as privileged: repository script => BLOCK'
    Assert-True (Test-BlockLike (Proc-Run @(P 1010 'node.exe' 'C:\Program Files\nodejs\node.exe' 'node.exe scripts\serve.mjs' '' '')) '*1010*owner unresolved*') 'unknown owner + relative script => BLOCK'
    Assert-True ((Proc-Run @(P 1011 'node.exe' 'C:\Program Files\nodejs\node.exe' ('node.exe "' + $repo + '\scripts\serve.mjs"') 'OZK2026\OZKSync')).ok) 'non-privileged user with a repository script => not blocked by this rule alone'
    Assert-True (Test-BlockLike (Proc-Run @(P 1012 'powershell.exe' $ps ($ps + ' -NoProfile -Command Get-Date') 'OZK2026\OZK-DeployGate')) '*1012*dedicated gate identity*') 'process running as OZK-DeployGate is represented and blocked (no self/console exemption in phase 1)'
    # اختفاء العملية: يُتجاهل السجل الناقص فقط إن ثبت الاختفاء بـPID + CreationDate.
    $script:ProcStates = @{ 1020 = 'GONE' }
    $got = Proc-Run @(P 1020 'gone.exe' '' '' '' '')
    Assert-True ($got.ok -and @($got.processes | Where-Object { $_.pid -eq 1020 -and $_.workload -eq 'GONE' }).Count -eq 1) 'process with missing data whose exit is proven (PID + CreationDate) => ignored'
    $script:ProcStates = @{ 1021 = 'UNKNOWN' }
    Assert-True (Test-BlockLike (Proc-Run @(P 1021 'vanish.exe' '' '' '' '')) '*1021*') 'process with missing data whose exit cannot be verified => BLOCK'
    $script:ProcStates = @{ 1022 = 'PRESENT' }
    Assert-True (Test-BlockLike (Proc-Run @(P 1022 'still.exe' '' '' '' '')) '*1022*') 'process with missing data still present (same PID + CreationDate) => BLOCK'
    $script:ProcStates = @{}
    # فشل الجرد أو مدخل غير صالح ⇒ BLOCK.
    $script:ProcError = 'Access is denied.'
    Assert-True (Test-BlockLike (Invoke-ProcessInventoryPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*cannot enumerate processes*') 'process inventory failure => BLOCK'
    $script:ProcError = $null; $script:ProcRecords = @()
    Assert-True (Test-BlockLike (Invoke-ProcessInventoryPreflight (New-Config 'OZK2026\OZK-DeployGate' @())) '*process inventory is empty*') 'empty process inventory => BLOCK'
    $bad = P 1030 'x.exe' 'C:\Windows\system32\svchost.exe' 'svchost.exe' '' 'S-1-5-18'; $bad.creationDate = $null
    Assert-True (Test-BlockLike (Proc-Run @($bad)) '*invalid process record*') 'record without CreationDate => BLOCK'
    $savedAdmins = $script:Admins; $script:Admins = $null
    Assert-True (Test-BlockLike (Proc-Run @(P 1040 'node.exe' 'C:\Program Files\nodejs\node.exe' 'node.exe scripts\serve.mjs' 'OZK2026\OZKSync')) '*1040*cannot prove*') 'Administrators membership unknown => every owner treated as privileged (relative script => BLOCK)'
    $script:Admins = $savedAdmins
    $script:ProcRecords = @()

    Write-Host '== Install preflight combines price-list and identity checks'
    # فحص ACL الفعلية مُختبَر في Test-GateTrustAcl.ps1؛ هنا نتيجته ناجحة لعزل الهوية ونشرات الأسعار.
    function Test-GateTrustAcl($Config) { return [pscustomobject]@{ ok = $true; results = @() } }; function Test-GitHookSafety($Config) { return [pscustomobject]@{ ok = $true; results = @() } }
    $script:Tasks = Get-CleanLayout
    function Get-PreflightTaskActionText([string]$TaskName) { return $null }
    function Get-PreflightTaskState([string]$TaskName) { if ($TaskName -eq 'OZK-PriceListSync') { return 'Disabled' } return $null }
    function Get-PreflightTaskNames { return @() }
    $r = Invoke-InstallPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok -and @($r.results | Where-Object { $_.verdict -eq 'OUT_OF_SCOPE_DISABLED' }).Count -eq 1) 'dedicated identity + disabled price-list task => install preflight PASS'
    $r = Invoke-InstallPreflight (New-Config 'SYSTEM' @())
    Assert-True (-not $r.ok) 'SYSTEM identity blocks the whole install preflight'
    $script:Tasks = Get-CurrentLayout
    $r = Invoke-InstallPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok) 'current modeled OZK2026 layout => install preflight (Initialize) BLOCKED'

    Write-Host '== Configuration contract'
    Assert-True ($base.trust.gateAccount -eq 'OZK2026\OZK-DeployGate' -and @($base.trust.gateDirWriters).Count -eq 1 -and $base.trust.gateDirWriters[0] -eq 'OZK2026\OZK-DeployGate') 'example config: machine-qualified dedicated identity is the only trust-file writer'
    $script:Tasks = Get-CurrentLayout
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'SYSTEM' @())).ok -eq $false) 'SYSTEM is proven invalid as gate identity in the current layout'
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
}

if ($failures.Count -gt 0) {
    Write-Host ("Gate identity preflight: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Gate identity preflight: all checks passed' -ForegroundColor Green
exit 0
