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

$script:Tasks = @()
$script:Services = @()
function Get-PreflightTaskInventory { return @($script:Tasks) }
function Get-PreflightServiceInventory { return @($script:Services) }
function Read-PreflightWrapperText([string]$Path) { if ($script:Wrappers.ContainsKey($Path)) { return $script:Wrappers[$Path] } return '' }

$repo = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web'
$gateDir = 'C:\ProgramData\OZK-TOBACCO\DeployGate'
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$autoprintVbs = 'C:\ProgramData\OZK-TOBACCO\TaskWrappers\ozk-ameen-autoprint-hidden.vbs'
$script:Wrappers = @{ $autoprintVbs = ('shell.Run """' + $repo + '\tools\ameen-autoprint\run-watcher.bat""", 0, True') }

function New-Task([string]$Name, [string]$Identity, [string]$Action) { return [pscustomobject]@{ name = $Name; identity = $Identity; action = $Action } }
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
    $r = Invoke-GateIdentityPreflight (New-Config 'LOQ' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*') -and (Test-BlockLike $r '*Read Worker*reused*')) 'LOQ (admin running repo tasks) reused as gate identity => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK2026\LOQ' @())
    Assert-True (-not $r.ok) 'machine-qualified OZK2026\LOQ => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZKSync' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*') -and (Test-BlockLike $r '*Customer Movements*reused*')) 'OZKSync reused as gate identity => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'BUILTIN\Administrators' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*forbidden*')) 'Administrators as gate identity => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config '' @())
    Assert-True (-not $r.ok) 'no gate identity configured => BLOCK'

    Write-Host '== Dedicated identity'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True ($r.ok) 'dedicated identity unused by any repo workload => eligible'
    $script:Tasks = @(Get-CurrentLayout) + @(New-Task 'TOBACCO Windows Deploy Gate' 'OZK-DeployGate' ($ps + ' -File "' + $gateDir + '\deploy-gate.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True ($r.ok) 'the gate task itself under the dedicated identity running only gateDir scripts => eligible'
    $script:Tasks = @(Get-CurrentLayout) + @(New-Task 'TOBACCO Windows Deploy Gate' 'OZK-DeployGate' ($ps + ' -File "' + $repo + '\tools\deploy-gate\deploy-gate.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*gate task must run only*')) 'the gate task running the repository copy of the gate => BLOCK'
    $script:Tasks = @(Get-CurrentLayout) + @(New-Task 'TOBACCO Item Costs Push' 'OZK-DeployGate' ($ps + ' -File "' + $repo + '\tools\push-item-costs.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Item Costs*reused*')) 'dedicated identity also assigned to one repo task => BLOCK'
    $script:Tasks = @(Get-CurrentLayout) + @(New-Task 'Some Maintenance' 'OZK2026\OZK-DeployGate' 'C:\Tools\cleanup.exe')
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*reused*')) 'dedicated identity reused by any other task (even non-repo) => BLOCK'
    $script:Tasks = Get-CurrentLayout
    $script:Services = @([pscustomobject]@{ name = 'ozk-repo-svc'; identity = '.\OZK-DeployGate'; action = ('"C:\Program Files\nodejs\node.exe" "' + $repo + '\scripts\serve.mjs"') })
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*service ozk-repo-svc*')) 'a service running repo code under the dedicated identity => BLOCK'
    $script:Services = @()

    Write-Host '== Trust file writers and unverifiable identities'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @('OZK-DeployGate', 'BUILTIN\Administrators'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*writable by the dedicated gate identity only*')) 'Administrators as a trust-file writer is not an accepted boundary => BLOCK'
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @('OZK-DeployGate', 'OZKSync'))
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*Customer Movements*may write the gate trust files*')) 'a repo workload identity among trust-file writers => BLOCK'
    $script:Tasks = @(Get-CurrentLayout) + @(New-Task 'Unknown Principal' '' ($ps + ' -File "' + $repo + '\tools\x.ps1"'))
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*identity not verifiable*')) 'unknown/unverifiable task identity => fail closed'
    $script:Tasks = @()
    $r = Invoke-GateIdentityPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True (-not $r.ok -and (Test-BlockLike $r '*no scheduled tasks visible*')) 'no visible tasks (not run as administrator) => fail closed'

    Write-Host '== Install preflight combines price-list and identity checks'
    $script:Tasks = Get-CurrentLayout
    function Get-PreflightTaskActionText([string]$TaskName) { return $null }
    function Get-PreflightTaskState([string]$TaskName) { if ($TaskName -eq 'OZK-PriceListSync') { return 'Disabled' } return $null }
    function Get-PreflightTaskNames { return @() }
    $r = Invoke-InstallPreflight (New-Config 'OZK-DeployGate' @())
    Assert-True ($r.ok -and @($r.results | Where-Object { $_.verdict -eq 'OUT_OF_SCOPE_DISABLED' }).Count -eq 1) 'dedicated identity + disabled price-list task => install preflight PASS'
    $r = Invoke-InstallPreflight (New-Config 'SYSTEM' @())
    Assert-True (-not $r.ok) 'SYSTEM identity blocks the whole install preflight'

    Write-Host '== Configuration contract'
    Assert-True ($base.trust.gateAccount -eq 'OZK-DeployGate' -and @($base.trust.gateDirWriters).Count -eq 1 -and $base.trust.gateDirWriters[0] -eq 'OZK-DeployGate') 'example config: dedicated identity is the only trust-file writer'
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
