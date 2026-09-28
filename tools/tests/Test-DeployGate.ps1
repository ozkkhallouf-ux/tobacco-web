#Requires -Version 5.1
# ============================================================
# Test-DeployGate.ps1
#
# اختبارات سلوكية لبوابة نشر Windows (tools/deploy-gate/deploy-gate.ps1).
# تبني مستودعات git حقيقية مؤقتة (origin عارٍ + نسخة تعمل على
# windows-production) بلا شبكة ولا بيانات إنتاج، وتستبدل نقاط التماس
# الخارجية فقط (GitHub API، اسم الجهاز، المهام المجدولة، التنبيه).
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-DeployGate.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$gateScript = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'deploy-gate.ps1')

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }

function Invoke-TestGit([string]$Dir, [string[]]$GitArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Dir -c user.name=gate-test -c user.email=gate-test@example.invalid -c commit.gpgsign=false @GitArgs 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    if ($code -ne 0) { throw ('git ' + ($GitArgs -join ' ') + ' failed: ' + ($out -join ' ')) }
    return ((@($out) -join "`n").Trim())
}

function Write-TestFile([string]$Path, [string]$Content) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

# ------------------------------------------------------------
# البيئة المؤقتة
# ------------------------------------------------------------
. $gateScript

$script:Approved = @{}
$script:RedCi = @{}
$script:UnkindOnly = @{}
$script:Running = @()
$script:Alerts = New-Object System.Collections.ArrayList

function Get-HostName { return 'TESTHOST' }
function Send-GateAlert([string]$Message, [string]$DedupeKey) { [void]$script:Alerts.Add($Message) }
function Get-RunningTaskNames([string[]]$TaskNames) { return @($script:Running) }
function Start-GateSleep([int]$Seconds) { Start-Sleep -Milliseconds 50 }
function Get-GitHubJson($Config, [string]$RelativePath) {
    if ($RelativePath -match '^deployments\?.*sha=([0-9a-f]{40})') {
        $sha = $Matches[1]
        if ($script:UnkindOnly.ContainsKey($sha)) {
            return @([pscustomobject]@{ id = 7; sha = $sha; creator = [pscustomobject]@{ login = 'github-actions[bot]' }; payload = '' })
        }
        if (-not $script:Approved.ContainsKey($sha)) { return @() }
        return @([pscustomobject]@{ id = 42; sha = $sha; creator = [pscustomobject]@{ login = 'github-actions[bot]' }; payload = $script:Approved[$sha] })
    }
    if ($RelativePath -match '^deployments/\d+/statuses') { return @([pscustomobject]@{ state = 'success' }) }
    if ($RelativePath -match '^actions/runs\?head_sha=([0-9a-f]{40})') {
        $conclusion = 'success'
        if ($script:RedCi.ContainsKey($Matches[1])) { $conclusion = 'failure' }
        return [pscustomobject]@{ workflow_runs = @([pscustomobject]@{ name = 'Deploy TOBACCO Web'; status = 'completed'; conclusion = $conclusion; created_at = '2026-09-28T00:00:00Z' }) }
    }
    if ($RelativePath -match '^commits/([0-9a-f]{40})/pulls') {
        return @([pscustomobject]@{ number = 1; merge_commit_sha = $Matches[1]; merged_at = '2026-09-28T00:00:00Z'; head = [pscustomobject]@{ sha = 'prhead' } })
    }
    if ($RelativePath -match '^commits/prhead/check-runs') {
        return [pscustomobject]@{ check_runs = @([pscustomobject]@{ name = 'check'; status = 'completed'; conclusion = 'success' }) }
    }
    throw "unexpected GitHub path: $RelativePath"
}

function New-GateTestEnv {
    $base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-gate-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $origin = Join-Path $base 'origin.git'
    $seed = Join-Path $base 'seed'
    $repo = Join-Path $base 'repo'
    $gate = Join-Path $base 'gate'
    New-Item -ItemType Directory -Force -Path $gate | Out-Null
    & git init -q --bare $origin 2>&1 | Out-Null
    & git clone -q $origin $seed 2>&1 | Out-Null
    Invoke-TestGit $seed @('checkout', '-q', '-b', 'main') | Out-Null
    Write-TestFile (Join-Path $seed 'tools/sync-approved-prices-to-ameen.ps1') "'writer v1'`n"
    Write-TestFile (Join-Path $seed 'tools/reader.ps1') "'reader v1'`n"
    Write-TestFile (Join-Path $seed 'AI_ACTIVE_TASK.json') '{"status":"idle"}'
    Invoke-TestGit $seed @('add', '-A') | Out-Null
    Invoke-TestGit $seed @('commit', '-q', '-m', 'initial') | Out-Null
    Invoke-TestGit $seed @('push', '-q', 'origin', 'main') | Out-Null
    Invoke-TestGit $seed @('push', '-q', 'origin', 'main:refs/heads/windows-production') | Out-Null
    & git clone -q $origin $repo 2>&1 | Out-Null
    Invoke-TestGit $repo @('checkout', '-q', '-B', 'windows-production', 'origin/windows-production') | Out-Null
    Invoke-TestGit $repo @('branch', '-q', '--set-upstream-to=origin/windows-production') | Out-Null
    $config = [pscustomobject]@{
        expectedHost = 'TESTHOST'; repoPath = $repo; gateDir = $gate; githubRepo = 'test/test'
        windowsBranch = 'windows-production'; mainBranch = 'main'; deploymentEnvironment = 'windows-production'
        deploymentCreator = 'github-actions[bot]'; requiredMainWorkflows = @('Deploy TOBACCO Web'); requiredPrChecks = @('check')
        drainTimeoutSeconds = 1; flagTtlMinutes = 15; pauseTasks = @('T1'); longRunningTasks = @()
        writerScripts = @('tools/sync-approved-prices-to-ameen.ps1')
    }
    $script:Approved = @{}; $script:RedCi = @{}; $script:UnkindOnly = @{}; $script:Running = @(); $script:Alerts.Clear()
    return [pscustomobject]@{ Base = $base; Seed = $seed; Repo = $repo; Gate = $gate; Config = $config }
}

# ينشر commit على main ثم يقدّم windows-production إليه (كما يفعل الـworkflow).
function Publish-TestRelease($T, [hashtable]$Files, [switch]$Approve, [switch]$WriteApproved, [switch]$OffMain, [string]$BlobOverride = '') {
    Invoke-TestGit $T.Seed @('fetch', '-q', 'origin') | Out-Null
    if ($OffMain) { Invoke-TestGit $T.Seed @('checkout', '-q', '-B', 'side', 'origin/windows-production') | Out-Null }
    else { Invoke-TestGit $T.Seed @('checkout', '-q', 'main') | Out-Null }
    foreach ($k in $Files.Keys) { Write-TestFile (Join-Path $T.Seed $k) $Files[$k] }
    Invoke-TestGit $T.Seed @('add', '-A') | Out-Null
    Invoke-TestGit $T.Seed @('commit', '-q', '-m', ('release ' + [guid]::NewGuid().ToString('N').Substring(0, 6))) | Out-Null
    $sha = Invoke-TestGit $T.Seed @('rev-parse', 'HEAD')
    if (-not $OffMain) { Invoke-TestGit $T.Seed @('push', '-q', 'origin', 'main') | Out-Null }
    Invoke-TestGit $T.Seed @('push', '-q', '--force', 'origin', ($sha + ':refs/heads/windows-production')) | Out-Null
    if ($Approve) {
        $blobs = @{}
        foreach ($k in $Files.Keys) {
            if ($T.Config.writerScripts -contains $k) {
                $blob = Invoke-TestGit $T.Seed @('rev-parse', ($sha + ':' + $k))
                if ($BlobOverride) { $blob = $BlobOverride }
                $blobs[$k] = $blob
            }
        }
        $script:Approved[$sha] = [pscustomobject]@{ kind = 'ozk-windows-release'; sha = $sha; approver = 'owner'; runId = '1'; writeScriptsApproved = [bool]$WriteApproved; writerBlobs = [pscustomobject]$blobs }
    }
    return $sha
}

function Get-TestHead($T) { return Invoke-TestGit $T.Repo @('rev-parse', 'HEAD') }
function Get-AuditLines($T) {
    $p = Join-Path $T.Gate 'audit.jsonl'
    if (-not (Test-Path -LiteralPath $p)) { return @() }
    return @([System.IO.File]::ReadAllLines($p) | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}
function Get-TestState($T) { return ([System.IO.File]::ReadAllText((Join-Path $T.Gate 'state.json')) | ConvertFrom-Json) }

$environments = New-Object System.Collections.ArrayList
function New-InitializedEnv {
    $e = New-GateTestEnv
    [void]$environments.Add($e)
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Initialize'
    if ($r.result -ne 'OK') { throw ('initialize failed: ' + $r.reason) }
    return $e
}

try {
    Write-Host '== Initialize'
    $e = New-GateTestEnv; [void]$environments.Add($e)
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*not initialized*') 'deploy before initialize stops'
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Initialize'
    Assert-True ($r.result -eq 'OK') 'initialize succeeds on windows-production at origin'
    $state = Get-TestState $e
    Assert-True ($state.lastDeployedSha -eq (Get-TestHead $e) -and $state.status -eq 'ok') 'state records current HEAD'
    $allow = [System.IO.File]::ReadAllText((Join-Path $e.Gate 'writer-allowlist.json')) | ConvertFrom-Json
    $diskHash = (Get-FileHash -LiteralPath (Join-Path $e.Repo 'tools/sync-approved-prices-to-ameen.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($allow.files.'tools/sync-approved-prices-to-ameen.ps1' -eq $diskHash) 'writer allowlist holds on-disk SHA256'
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Initialize'
    Assert-True ($r.result -eq 'STOP') 'second initialize refused'

    Write-Host '== NOOP'
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'NOOP') 'no new release => NOOP'
    Assert-True (@(Get-AuditLines $e | Where-Object { $_.result -eq 'NOOP' }).Count -eq 0) 'NOOP is not written to the audit log'

    Write-Host '== Happy path (reader change, approved, CI green)'
    $old = Get-TestHead $e
    $sha = Publish-TestRelease $e @{ 'tools/reader.ps1' = "'reader v2'`n"; 'queries/x.sql' = "select 1`n" } -Approve
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK') 'approved fast-forward deploys'
    Assert-True ((Get-TestHead $e) -eq $sha) 'HEAD moved to the approved SHA'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $e.Gate 'deploying.flag'))) 'deploy flag cleared'
    $a = @(Get-AuditLines $e | Where-Object { $_.result -eq 'OK' -and $_.mode -eq 'Deploy' })[-1]
    Assert-True ($a.old_sha -eq $old -and $a.new_sha -eq $sha -and $a.rollback_sha -eq $old) 'audit has old/new/rollback SHA'
    Assert-True ($a.windows_ref -eq 'origin/windows-production' -and $a.approver -eq 'owner' -and $a.deployment_id -eq 42) 'audit has reference, approver and deployment'
    Assert-True ($a.ps1_changed -and $a.sql_changed -and @($a.changed_files).Count -eq 2) 'audit classifies PS1/SQL changes'
    Assert-True ($null -ne $a.ci -and $null -ne $a.ts_utc -and $null -ne $a.stash_count_after) 'audit has CI results, timestamp and stash count'
    Assert-True ((Get-TestState $e).lastDeployedSha -eq $sha) 'state advanced'

    Write-Host '== Refusals'
    $before = Get-TestHead $e
    $sha = Publish-TestRelease $e @{ 'tools/reader.ps1' = "'reader v3'`n" }
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e) -eq $before) 'no owner approval => STOP, HEAD unchanged'
    $script:UnkindOnly[$sha] = $true
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e) -eq $before) 'auto environment deployment without release payload is not approval'
    $script:UnkindOnly.Remove($sha)
    $script:Approved[$sha] = [pscustomobject]@{ kind = 'ozk-windows-release'; sha = $sha; approver = 'owner'; runId = '2'; writeScriptsApproved = $false; writerBlobs = [pscustomobject]@{} }
    $script:RedCi[$sha] = $true
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'CI not green*' -and (Get-TestHead $e) -eq $before) 'red CI => STOP'
    $script:RedCi.Remove($sha)
    Write-TestFile (Join-Path $e.Repo 'untracked.txt') 'x'
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and (Get-TestHead $e) -eq $before) 'dirty worktree => SKIP'
    Remove-Item -LiteralPath (Join-Path $e.Repo 'untracked.txt')
    $script:Running = @('T1')
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and (Get-TestHead $e) -eq $before) 'tasks still running after drain timeout => SKIP'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $e.Gate 'deploying.flag'))) 'flag cleared after drain timeout'
    $script:Running = @()
    $old = $script:Alerts.Count
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'DryRun'
    Assert-True ($r.result -eq 'DRYRUN' -and (Get-TestHead $e) -eq $before) 'DryRun passes checks without changing HEAD'
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e) -eq $sha) 'same release deploys once every check passes'

    Write-Host '== AI lock'
    $before = Get-TestHead $e
    $sha = Publish-TestRelease $e @{ 'AI_ACTIVE_TASK.json' = '{"status":"active"}' } -Approve
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*AI task lock*' -and (Get-TestHead $e) -eq $before) 'active AI lock => SKIP'
    $sha = Publish-TestRelease $e @{ 'AI_ACTIVE_TASK.json' = '{"status":"idle"}' } -Approve
    $r = Invoke-DeployGate -Config $e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK') 'released lock => deploy'

    Write-Host '== Not on main / not fast-forward / local commit / wrong host'
    $e2 = New-InitializedEnv
    $before = Get-TestHead $e2
    $side = Publish-TestRelease $e2 @{ 'tools/reader.ps1' = "'side'`n" } -Approve -OffMain
    $r = Invoke-DeployGate -Config $e2.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*not on main*' -and (Get-TestHead $e2) -eq $before) 'target not on main => STOP'
    $e3 = New-InitializedEnv
    Write-TestFile (Join-Path $e3.Repo 'local.txt') 'local'
    Invoke-TestGit $e3.Repo @('add', '-A') | Out-Null
    Invoke-TestGit $e3.Repo @('commit', '-q', '-m', 'local commit') | Out-Null
    $local = Get-TestHead $e3
    [void](Publish-TestRelease $e3 @{ 'tools/reader.ps1' = "'v2'`n" } -Approve)
    $r = Invoke-DeployGate -Config $e3.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e3) -eq $local) 'local commit => STOP, never rebased'
    $e4 = New-InitializedEnv
    $before = Get-TestHead $e4
    [void](Publish-TestRelease $e4 @{ 'tools/reader.ps1' = "'v2'`n" } -Approve)
    Invoke-TestGit $e4.Seed @('checkout', '-q', '--orphan', 'rewrite') | Out-Null
    Write-TestFile (Join-Path $e4.Seed 'other.txt') 'x'
    Invoke-TestGit $e4.Seed @('add', '-A') | Out-Null
    Invoke-TestGit $e4.Seed @('commit', '-q', '-m', 'unrelated') | Out-Null
    $unrelated = Invoke-TestGit $e4.Seed @('rev-parse', 'HEAD')
    Invoke-TestGit $e4.Seed @('push', '-q', '--force', 'origin', ($unrelated + ':refs/heads/windows-production')) | Out-Null
    $script:Approved[$unrelated] = [pscustomobject]@{ kind = 'ozk-windows-release'; sha = $unrelated; approver = 'owner'; runId = '3'; writeScriptsApproved = $false; writerBlobs = [pscustomobject]@{} }
    $r = Invoke-DeployGate -Config $e4.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*fast-forward*' -and (Get-TestHead $e4) -eq $before) 'non fast-forward target => STOP'
    $e4.Config.expectedHost = 'OZK2026'
    $r = Invoke-DeployGate -Config $e4.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'unexpected host*') 'unexpected host => STOP'

    Write-Host '== Writer scripts'
    $e5 = New-InitializedEnv
    $before = Get-TestHead $e5
    [void](Publish-TestRelease $e5 @{ 'tools/sync-approved-prices-to-ameen.ps1' = "'writer v2'`n" } -Approve)
    $r = Invoke-DeployGate -Config $e5.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'writer scripts changed*' -and (Get-TestHead $e5) -eq $before) 'writer change without writeScriptsApproved => STOP'
    [void](Publish-TestRelease $e5 @{ 'tools/sync-approved-prices-to-ameen.ps1' = "'writer v3'`n" } -Approve -WriteApproved -BlobOverride '0000000000000000000000000000000000000000')
    $r = Invoke-DeployGate -Config $e5.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'writer blob not approved*' -and (Get-TestHead $e5) -eq $before) 'approved blob mismatch => STOP'
    $sha = Publish-TestRelease $e5 @{ 'tools/sync-approved-prices-to-ameen.ps1' = "'writer v4'`n" } -Approve -WriteApproved
    $r = Invoke-DeployGate -Config $e5.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e5) -eq $sha) 'explicitly approved writer change deploys'
    $allow = [System.IO.File]::ReadAllText((Join-Path $e5.Gate 'writer-allowlist.json')) | ConvertFrom-Json
    $diskHash = (Get-FileHash -LiteralPath (Join-Path $e5.Repo 'tools/sync-approved-prices-to-ameen.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($allow.files.'tools/sync-approved-prices-to-ameen.ps1' -eq $diskHash -and $allow.sha -eq $sha) 'writer allowlist refreshed to the approved release'

    Write-Host '== Rollback / pin / unpin'
    $e6 = New-InitializedEnv
    $v1 = Get-TestHead $e6
    $v2 = Publish-TestRelease $e6 @{ 'tools/reader.ps1' = "'bad release'`n" } -Approve
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK') 'release v2 deployed'
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Rollback' -RollbackTo '0123456789012345678901234567890123456789'
    Assert-True ($r.result -ne 'OK' -and (Get-TestHead $e6) -eq $v2) 'rollback to an unknown SHA refused'
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Rollback' -RollbackTo $v1
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e6) -eq $v1) 'rollback returns to the previous deployed SHA'
    $st = Get-TestState $e6
    Assert-True ($st.status -eq 'ROLLED_BACK_PINNED' -and $st.rolledBackFrom -eq $v2) 'state pinned after rollback'
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e6) -eq $v1) 'pinned => the bad release is not re-applied'
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Unpin'
    Assert-True ($r.result -eq 'STOP') 'unpin refused while windows-production still points at the rolled-back release'
    $v3 = Publish-TestRelease $e6 @{ 'tools/reader.ps1' = "'fixed release'`n" } -Approve
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Unpin'
    Assert-True ($r.result -eq 'OK') 'unpin after a fixed release is published'
    $r = Invoke-DeployGate -Config $e6.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e6) -eq $v3) 'fixed release deploys fast-forward after unpin'

    Write-Host '== Safety invariants in the source'
    $src = [System.IO.File]::ReadAllText($gateScript)
    Assert-True ($src -notmatch "'pull'" -and $src -notmatch "'rebase'" -and $src -notmatch "'--hard'") 'gate never passes pull, rebase or --hard to git'
    Assert-True ($src -match "'merge', '--ff-only'") 'gate updates with merge --ff-only'
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
} finally {
    foreach ($te in $environments) { Remove-Item -LiteralPath $te.Base -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failures.Count -gt 0) {
    Write-Host ("Deploy gate: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Deploy gate: all checks passed' -ForegroundColor Green
exit 0
