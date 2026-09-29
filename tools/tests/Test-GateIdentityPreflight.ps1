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
function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return '' }

$repo = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web'
$gateDir = 'C:\ProgramData\OZK-TOBACCO\DeployGate'
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$autoprintVbs = 'C:\ProgramData\OZK-TOBACCO\TaskWrappers\ozk-ameen-autoprint-hidden.vbs'
$script:Wrappers = @{ $autoprintVbs = ('shell.Run """' + $repo + '\tools\ameen-autoprint\run-watcher.bat""", 0, True') }

function New-Task([string]$Name, [string]$Identity, [string]$Action, $Actions = $null) {
    if ($null -eq $Actions) {
        $m = [regex]::Match($Action, '^\s*("[^"]+"|\S+)\s*(.*)$')
        $Actions = @([pscustomobject]@{ execute = $m.Groups[1].Value.Trim('"'); arguments = $m.Groups[2].Value })
    }
    return [pscustomobject]@{ name = $Name; path = '\'; identity = $Identity; state = 'Ready'; action = $Action; actions = @($Actions) }
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
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*identity not verifiable*')) 'unknown/unverifiable task identity => fail closed'
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
    function Read-PreflightWrapperText([string]$Path) { if ($Path -eq $msWrapper) { throw 'Access is denied' } if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return '' }
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Unreadable Wrapper' 'SYSTEM' ('cmd.exe /c "' + $msWrapper + '"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Ms Unreadable Wrapper*cannot determine whether*')) 'privileged Microsoft-path task whose wrapper cannot be read => FAIL CLOSED'
    $script:Tasks = @(Get-CleanLayout) + @(New-MsTask 'Ms Unreadable Wrapper NonAdmin' 'OZKSync' ('cmd.exe /c "' + $msWrapper + '"'))
    Assert-True ((Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'non-privileged task with an unreadable wrapper is not a privilege risk'
    function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return '' }
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
        @{ label = 'relative target + unrelated trusted WorkingDirectory => NOT_REPO'; a = (Act $node 'server.js' 'C:\Tools\svc'); want = 'NOT_REPO' },
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
    function Test-GateTrustAcl($Config) { return [pscustomobject]@{ ok = $true; results = @() } }
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

    Write-Host '== Install preflight combines price-list and identity checks'
    # فحص ACL الفعلية مُختبَر في Test-GateTrustAcl.ps1؛ هنا نتيجته ناجحة لعزل الهوية ونشرات الأسعار.
    function Test-GateTrustAcl($Config) { return [pscustomobject]@{ ok = $true; results = @() } }
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
