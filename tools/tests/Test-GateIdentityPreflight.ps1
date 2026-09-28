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
    return [pscustomobject]@{ name = $Name; identity = $Identity; action = $Action; actions = @($Actions) }
}
# مهمة البوابة بـAction منظَّم (المفسّر + الوسائط كما في Task Scheduler).
$approvedPs = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
function New-GateTask([string]$Execute, [string]$Arguments, [string]$Identity = 'OZK2026\OZK-DeployGate') {
    return New-Task 'TOBACCO Windows Deploy Gate' $Identity ($Execute + ' ' + $Arguments) @([pscustomobject]@{ execute = $Execute; arguments = $Arguments })
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
function Get-CleanLayout {
    return @(
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
    $script:Tasks = @(Get-CleanLayout) + @(New-GateTask $approvedPs ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $gateDir + '\deploy-gate.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
    Assert-True ($r.ok) 'the gate task itself under the dedicated identity running only gateDir scripts => eligible'
    $script:Tasks = @(Get-CleanLayout) + @(New-GateTask $approvedPs ('-File "' + $repo + '\tools\deploy-gate\deploy-gate.ps1"'))
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
        @{ ok = $true;  label = 'approved PowerShell + -File gateDir\deploy-gate.ps1 => PASS'; exe = $approvedPs; args = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $gatePath + '"') },
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
        $script:Tasks = @(Get-CleanLayout) + @(New-GateTask $c.exe $c.args)
        $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())
        Assert-True ($r.ok -eq $c.ok) $c.label
    }
    $twoActions = New-Task 'TOBACCO Windows Deploy Gate' 'OZK2026\OZK-DeployGate' 'x' @([pscustomobject]@{ execute = $approvedPs; arguments = ('-File "' + $gatePath + '"') }, [pscustomobject]@{ execute = 'C:\Tools\anything.exe'; arguments = '' })
    $script:Tasks = @(Get-CleanLayout) + @($twoActions)
    Assert-True (-not (Invoke-GateIdentityPreflight (New-Config 'OZK2026\OZK-DeployGate' @())).ok) 'a second action on the gate task => BLOCK'

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
