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
$script:ExampleConfig = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'gate-config.example.json')

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
$script:PrChecks = @{}
$script:RedCi = @{}
$script:UnkindOnly = @{}
$script:Running = @()
$script:Alerts = New-Object System.Collections.ArrayList

function Get-HostName { return 'TESTHOST' }
# منطق الفحص نفسه مُختبَر في Test-MigrationPreflight.ps1؛ هنا نتيجته فقط.
$script:Preflight = [pscustomobject]@{ ok = $true; results = @([pscustomobject]@{ task = 'OZK-PriceListSync'; verdict = 'PASS'; reason = 'stub' }) }
function Invoke-MigrationPreflight($Config) { return $script:Preflight }
function Send-GateAlert([string]$Message, [string]$DedupeKey) { [void]$script:Alerts.Add($Message) }
function Get-RunningTaskNames([string[]]$TaskNames) { return @($script:Running) }
# المهام كما يراها حساب البوابة: افتراضياً مرئية وموجَّهة عبر run-repo-task.ps1 وبلا موعد قريب.
$script:TaskInfoOverride = $null
$script:TaskInfoSequence = $null
function Get-GateTaskInfo($Config, [string[]]$TaskNames) {
    # تسلسل يتغيّر من نداء لآخر: يحاكي تغيّر حالة المهمة بين الفحص الأول وإعادة الفحص بعد الانتظار.
    if ($null -ne $script:TaskInfoSequence -and $script:TaskInfoSequence.Count -gt 0) {
        $next = $script:TaskInfoSequence[0]
        if ($script:TaskInfoSequence.Count -gt 1) { $script:TaskInfoSequence = @($script:TaskInfoSequence | Select-Object -Skip 1) }
        return @(& $next $Config $TaskNames)
    }
    if ($null -ne $script:TaskInfoOverride) { return @($script:TaskInfoOverride) }
    $launcher = Join-Path $Config.gateDir 'run-repo-task.ps1'
    return @($TaskNames | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Ready'; nextRunUtc = $null; actionText = ('powershell.exe -File "' + $launcher + '" -Script "tools/reader.ps1"') } })
}
# فشل مرة واحدة في كتابة الحالة: يحاكي انقطاعاً في منتصف إكمال التراجع.
$script:FailSaveStateOnce = $false
$script:OriginalSaveGateState = ${function:Save-GateState}
function Save-GateState {
    if ($script:FailSaveStateOnce) { $script:FailSaveStateOnce = $false; throw 'simulated crash while writing state.json' }
    & $script:OriginalSaveGateState @args
}
$script:ResetOverride = $null
function Invoke-GateReset($Config, [string]$Target) {
    if ($script:ResetOverride) { return (& $script:ResetOverride $Config $Target) }
    return Invoke-GateGit $Config @('reset', '--keep', $Target)
}
$script:MergeOverride = $null
function Invoke-GateMerge($Config, [string]$Target) {
    if ($script:MergeOverride) { return (& $script:MergeOverride $Config $Target) }
    return Invoke-GateGit $Config @('merge', '--ff-only', $Target)
}
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
    if ($RelativePath -match '^deployments\?environment=[^&]+&per_page=') {
        $all = @()
        foreach ($k in $script:Approved.Keys) { $all += [pscustomobject]@{ id = 42; sha = $k; creator = [pscustomobject]@{ login = 'github-actions[bot]' }; payload = $script:Approved[$k] } }
        return $all
    }
    if ($RelativePath -match '^deployments/\d+/statuses') { return @([pscustomobject]@{ state = 'success' }) }
    if ($RelativePath -match '^actions/runs\?head_sha=([0-9a-f]{40})') {
        $conclusion = 'success'
        if ($script:RedCi.ContainsKey($Matches[1])) { $conclusion = 'failure' }
        return [pscustomobject]@{ workflow_runs = @([pscustomobject]@{ name = 'Deploy TOBACCO Web'; status = 'completed'; conclusion = $conclusion; created_at = '2026-09-28T00:00:00Z' }) }
    }
    if ($RelativePath -match '^commits/([0-9a-f]{40})/pulls') {
        return @([pscustomobject]@{ number = 1; merge_commit_sha = $Matches[1]; merged_at = '2026-09-28T00:00:00Z'; head = [pscustomobject]@{ sha = ('prhead-' + $Matches[1]) } })
    }
    if ($RelativePath -match '^commits/prhead-([0-9a-f]{40})/check-runs') {
        if ($script:PrChecks.ContainsKey($Matches[1])) { return [pscustomobject]@{ check_runs = @($script:PrChecks[$Matches[1]]) } }
        return [pscustomobject]@{ check_runs = @([pscustomobject]@{ id = 1; name = 'check'; status = 'completed'; conclusion = 'success'; started_at = '2026-09-28T00:00:00Z' }) }
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
    # git يكتب تحذيرات عادية على stderr (مثل «cloned an empty repository») تصير في 5.1
    # أخطاء منهية مع Stop — كل النداءات عبر Invoke-TestGit الذي يحكم برمز الخروج وحده.
    Invoke-TestGit $base @('init', '-q', '--bare', $origin) | Out-Null
    Invoke-TestGit $base @('clone', '-q', $origin, $seed) | Out-Null
    Invoke-TestGit $seed @('checkout', '-q', '-b', 'main') | Out-Null
    Write-TestFile (Join-Path $seed 'tools/sync-approved-prices-to-ameen.ps1') "'writer v1'`n"
    Write-TestFile (Join-Path $seed 'tools/reader.ps1') "'reader v1'`n"
    Write-TestFile (Join-Path $seed 'AI_ACTIVE_TASK.json') '{"status":"idle"}'
    Invoke-TestGit $seed @('add', '-A') | Out-Null
    Invoke-TestGit $seed @('commit', '-q', '-m', 'initial') | Out-Null
    Invoke-TestGit $seed @('push', '-q', 'origin', 'main') | Out-Null
    Invoke-TestGit $seed @('push', '-q', 'origin', 'main:refs/heads/windows-production') | Out-Null
    Invoke-TestGit $base @('clone', '-q', $origin, $repo) | Out-Null
    Invoke-TestGit $repo @('checkout', '-q', '-B', 'windows-production', 'origin/windows-production') | Out-Null
    Invoke-TestGit $repo @('branch', '-q', '--set-upstream-to=origin/windows-production') | Out-Null
    # الإعداد الحقيقي (writeScan وlongRunningComponents وwriterScripts) مع مسارات مؤقتة.
    $config = [System.IO.File]::ReadAllText($script:ExampleConfig) | ConvertFrom-Json
    $config.expectedHost = 'TESTHOST'; $config.repoPath = $repo; $config.gateDir = $gate; $config.githubRepo = 'test/test'
    $config.requiredMainWorkflows = @('Deploy TOBACCO Web'); $config.requiredPrChecks = @('check')
    $config.drainTimeoutSeconds = 1; $config.pauseTasks = @('T1'); $config.routingExempt = @(); $config.deviceBaselineSha = ''
    $script:Approved = @{}; $script:PrChecks = @{}; $script:RedCi = @{}; $script:UnkindOnly = @{}; $script:Running = @(); $script:Alerts.Clear()
    $script:TaskInfoOverride = $null; $script:MergeOverride = $null; $script:ResetOverride = $null; $script:TaskInfoSequence = $null
    return [pscustomobject]@{ Base = $base; Seed = $seed; Repo = $repo; Gate = $gate; Config = $config }
}

# ينشر commit على main ثم يقدّم windows-production إليه (كما يفعل الـworkflow).
function Publish-TestRelease($T, [hashtable]$Files, [switch]$Approve, [switch]$WriteApproved, [switch]$OffMain, [string]$BlobOverride = '') {
    Invoke-TestGit $T.Seed @('fetch', '-q', 'origin') | Out-Null
    $previous = Invoke-TestGit $T.Seed @('rev-parse', 'origin/windows-production')
    if ($OffMain) { Invoke-TestGit $T.Seed @('checkout', '-q', '-B', 'side', 'origin/windows-production') | Out-Null }
    else { Invoke-TestGit $T.Seed @('checkout', '-q', 'main') | Out-Null }
    foreach ($k in $Files.Keys) { Write-TestFile (Join-Path $T.Seed $k) $Files[$k] }
    Invoke-TestGit $T.Seed @('add', '-A') | Out-Null
    Invoke-TestGit $T.Seed @('commit', '-q', '-m', ('release ' + [guid]::NewGuid().ToString('N').Substring(0, 6))) | Out-Null
    $sha = Invoke-TestGit $T.Seed @('rev-parse', 'HEAD')
    if (-not $OffMain) { Invoke-TestGit $T.Seed @('push', '-q', 'origin', 'main') | Out-Null }
    Invoke-TestGit $T.Seed @('push', '-q', '--force', 'origin', ($sha + ':refs/heads/windows-production')) | Out-Null
    if ($Approve) {
        # كما يفعل windows-release-verify.mjs: blob لكل ملف متغيّر منذ الإصدار السابق.
        $blobs = @{}
        foreach ($line in ((Invoke-TestGit $T.Seed @('diff', '--name-status', '--no-renames', $previous, $sha)) -split "`n")) {
            if ($line -notmatch '^([A-Z])\s+(.+)$') { continue }
            $k = $Matches[2].Trim()
            $blob = 'deleted'
            if ($Matches[1] -ne 'D') { $blob = Invoke-TestGit $T.Seed @('rev-parse', ($sha + ':' + $k)) }
            if ($BlobOverride) { $blob = $BlobOverride }
            $blobs[$k] = $blob
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
# بصمة كل ملف في الشجرة (خارج .git) مع وقت تعديله، وحالة البوابة: لإثبات «لا تغيير إضافي».
function Get-TreeSnapshot($T) {
    $repoFull = [System.IO.Path]::GetFullPath($T.Repo)
    $lines = @(Get-ChildItem -LiteralPath $T.Repo -Recurse -File -Force | Where-Object { $_.FullName -notlike ('*' + [IO.Path]::DirectorySeparatorChar + '.git' + [IO.Path]::DirectorySeparatorChar + '*') } | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($repoFull.Length) + '=' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash + '@' + $_.LastWriteTimeUtc.Ticks })
    foreach ($f in 'state.json', 'deploying.flag', 'inflight.json', 'writer-allowlist.json') {
        $p = Join-Path $T.Gate $f
        if (Test-Path -LiteralPath $p) { $lines += ($f + '=' + (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash) } else { $lines += ($f + '=absent') }
    }
    return ($lines -join "`n")
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
    Write-Host '== Migration preflight guards Initialize (Codex P1 #5)'
    $ep = New-GateTestEnv; [void]$environments.Add($ep)
    $script:Preflight = [pscustomobject]@{ ok = $false; results = @([pscustomobject]@{ task = 'OZK-PriceListSync'; verdict = 'BLOCK'; reason = 'still runs from the operational repository (needs main)' }) }
    $r = Invoke-DeployGate -Config $ep.Config -GateMode 'Initialize'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'migration preflight blocked*OZK-PriceListSync*') 'Initialize refused while a main-dependent task runs from the operational repo'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $ep.Gate 'state.json'))) 'no gate state recorded when the preflight blocks'
    $script:Preflight = [pscustomobject]@{ ok = $true; results = @([pscustomobject]@{ task = 'OZK-PriceListSync'; verdict = 'PASS'; reason = 'runs from the dedicated main worktree' }) }
    $r = Invoke-DeployGate -Config $ep.Config -GateMode 'Initialize'
    Assert-True ($r.result -eq 'OK' -and @($r.preflight).Count -eq 1) 'Initialize proceeds and records the preflight once it passes'

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
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'writer scripts changed*' -and (Get-TestHead $e5) -eq $before) 'approved blob mismatch => STOP'
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

    Write-Host '== CI: newest run per required check decides (Codex P1 #1)'
    $e7 = New-InitializedEnv
    $before = Get-TestHead $e7
    $sha = Publish-TestRelease $e7 @{ 'tools/reader.ps1' = "'rerun'`n" } -Approve
    $script:PrChecks[$sha] = @(
        [pscustomobject]@{ id = 10; name = 'check'; status = 'completed'; conclusion = 'success'; started_at = '2026-09-28T01:00:00Z' },
        [pscustomobject]@{ id = 11; name = 'check'; status = 'completed'; conclusion = 'failure'; started_at = '2026-09-28T02:00:00Z' })
    $r = Invoke-DeployGate -Config $e7.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'CI not green*' -and (Get-TestHead $e7) -eq $before) 'old success + newer failure => BLOCK'
    foreach ($bad in @(@('completed', 'cancelled'), @('completed', 'timed_out'), @('in_progress', ''), @('queued', ''))) {
        $script:PrChecks[$sha] = @(
            [pscustomobject]@{ id = 10; name = 'check'; status = 'completed'; conclusion = 'success'; started_at = '2026-09-28T01:00:00Z' },
            [pscustomobject]@{ id = 12; name = 'check'; status = $bad[0]; conclusion = $bad[1]; started_at = '2026-09-28T03:00:00Z' })
        $r = Invoke-DeployGate -Config $e7.Config -GateMode 'Deploy'
        Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e7) -eq $before) ('old success + newer ' + $bad[0] + '/' + $bad[1] + ' => BLOCK')
    }
    foreach ($pending in @('queued', 'in_progress', 'waiting')) {
        $script:PrChecks[$sha] = @(
            [pscustomobject]@{ id = 10; name = 'check'; status = 'completed'; conclusion = 'success'; started_at = '2026-09-28T01:00:00Z' },
            [pscustomobject]@{ id = 14; name = 'check'; status = $pending; conclusion = $null; started_at = $null })
        $r = Invoke-DeployGate -Config $e7.Config -GateMode 'Deploy'
        Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e7) -eq $before) ('old success + newer ' + $pending + ' without started_at => BLOCK')
    }
    $script:PrChecks[$sha] = @(
        [pscustomobject]@{ id = 11; name = 'check'; status = 'completed'; conclusion = 'failure'; started_at = '2026-09-28T02:00:00Z' },
        [pscustomobject]@{ id = 13; name = 'check'; status = 'completed'; conclusion = 'success'; started_at = '2026-09-28T04:00:00Z' })
    $r = Invoke-DeployGate -Config $e7.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e7) -eq $sha) 'old failure + newer success => PASS'

    Write-Host '== Newly introduced Ameen writer (Codex P1 #2)'
    $e8 = New-InitializedEnv
    $v0 = Publish-TestRelease $e8 @{ 'tools/push-customer-movements.ps1' = "`$q = 'SELECT 1 FROM cu000'`n" } -Approve
    $r = Invoke-DeployGate -Config $e8.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK') 'known reader (SELECT only) deploys without write approval'
    $before = Get-TestHead $e8
    [void](Publish-TestRelease $e8 @{ 'tools/push-customer-movements.ps1' = "`$cmd.CommandText = 'UPDATE bt000 SET Flag = 1'`n`$cmd.ExecuteNonQuery()`n" } -Approve)
    $r = Invoke-DeployGate -Config $e8.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like 'writer scripts changed*push-customer-movements*' -and (Get-TestHead $e8) -eq $before) 'reader turned writer (UPDATE/ExecuteNonQuery) blocked without write approval'
    Assert-True (@($r.write_capable_detected) -contains 'tools/push-customer-movements.ps1') 'audit names the newly write-capable file'
    [void](Publish-TestRelease $e8 @{ 'tools/push-customer-movements.ps1' = "`$cs = `$env:AMEEN_SQL_WRITE_CONNECTION_STRING`n" } -Approve)
    $r = Invoke-DeployGate -Config $e8.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e8) -eq $before) 'reader switched to the write connection blocked without write approval'
    [void](Publish-TestRelease $e8 @{ 'tools/ameen-new-writer.sql' = "INSERT INTO mt000 (Name) VALUES ('x')`n" } -Approve)
    $r = Invoke-DeployGate -Config $e8.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e8) -eq $before) 'new SQL file with INSERT blocked without write approval'
    $e8b = New-InitializedEnv
    $sha = Publish-TestRelease $e8b @{ 'tools/push-customer-movements.ps1' = "`$cmd.CommandText = 'DELETE FROM bt000'`n"; 'tools/ameen-new-writer.sql' = "INSERT INTO mt000 (Name) VALUES ('x')`n" } -Approve -WriteApproved
    $r = Invoke-DeployGate -Config $e8b.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e8b) -eq $sha) 'explicitly approved new writers deploy'
    $allow = [System.IO.File]::ReadAllText((Join-Path $e8b.Gate 'writer-allowlist.json')) | ConvertFrom-Json
    Assert-True ($null -ne $allow.files.'tools/push-customer-movements.ps1' -and $null -ne $allow.files.'tools/ameen-new-writer.sql') 'newly write-capable files join the pinned hash list'

    Write-Host '== Catch-up across several approved releases'
    $e8c = New-InitializedEnv
    [void](Publish-TestRelease $e8c @{ 'tools/push-invoice-series.ps1' = "`$cs = `$env:AMEEN_SQL_WRITE_CONNECTION_STRING`n" } -Approve -WriteApproved)
    $r2 = Publish-TestRelease $e8c @{ 'docs/after.md' = "z`n" } -Approve
    $r = Invoke-DeployGate -Config $e8c.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $e8c) -eq $r2) 'writer approved in an earlier release stays approved when catching up'
    $e8d = New-InitializedEnv
    $before = Get-TestHead $e8d
    [void](Publish-TestRelease $e8d @{ 'tools/push-invoice-series.ps1' = "`$cs = `$env:AMEEN_SQL_WRITE_CONNECTION_STRING`n" } -Approve)
    [void](Publish-TestRelease $e8d @{ 'docs/after.md' = "z`n" } -Approve -WriteApproved)
    $r = Invoke-DeployGate -Config $e8d.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $e8d) -eq $before) 'a later write approval does not cover an earlier unapproved writer blob'

    $e8e = New-InitializedEnv
    [void](Publish-TestRelease $e8e @{ 'tools/tests/Test-Fixture.ps1' = "'INSERT INTO t VALUES (1)'`n"; 'docs/notes.md' = "update x set y`n" } -Approve)
    $r = Invoke-DeployGate -Config $e8e.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK') 'tests and docs are outside the write scan scope'

    Write-Host '== Long-running components (Codex P1 #3)'
    $e9 = New-InitializedEnv
    $sha = Publish-TestRelease $e9 @{ 'docs/unrelated.md' = "x`n"; 'tools/reader.ps1' = "'v9'`n" } -Approve
    $r = Invoke-DeployGate -Config $e9.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and @($r.pending_restart).Count -eq 0 -and (Get-TestState $e9).status -eq 'ok') 'unrelated files only => OK, no pending restart'
    $cases = @(
        @{ file = 'tools/ameen-read-worker.ps1'; name = 'TOBACCO Ameen Read Worker' },
        @{ file = 'tools/ameen-read-gateway.ps1'; name = 'TOBACCO Ameen Read Worker' },
        @{ file = 'tools/ameen-autoprint/invoice-html.js'; name = 'OZK-AmeenAutoPrint' },
        @{ file = 'tools/ameen-autoprint/package.json'; name = 'OZK-AmeenAutoPrint' },
        @{ file = 'scripts/serve.mjs'; name = 'OZK-Tobacco-Server (scripts/serve.mjs)' })
    foreach ($c in $cases) {
        $ec = New-InitializedEnv
        $sha = Publish-TestRelease $ec @{ ($c.file) = ("// change " + [guid]::NewGuid().ToString('N') + "`n") } -Approve
        $r = Invoke-DeployGate -Config $ec.Config -GateMode 'Deploy'
        $st = Get-TestState $ec
        $a = @(Get-AuditLines $ec)[-1]
        Assert-True ($r.result -eq 'DEPLOYED_PENDING_RESTART' -and (Get-TestHead $ec) -eq $sha) ($c.file + ' => files deployed, DEPLOYED_PENDING_RESTART')
        Assert-True (@($st.pendingRestart) -contains $c.name -and $st.status -eq 'DEPLOYED_PENDING_RESTART' -and $st.lastDeployedSha -eq $sha) ('state names ' + $c.name)
        Assert-True ($a.result -eq 'DEPLOYED_PENDING_RESTART' -and $a.result -ne 'OK' -and @($a.pending_restart) -contains $c.name) ('audit records pending restart for ' + $c.name + ' and not OK')
        Assert-True (@($script:Alerts | Where-Object { $_ -like ('*' + $c.name + '*') }).Count -gt 0) ('alert names ' + $c.name)
    }
    $em = New-InitializedEnv
    $sha = Publish-TestRelease $em @{ 'tools/ameen-read-worker.ps1' = "'w2'`n"; 'tools/ameen-autoprint/watcher.js' = "// w2`n"; 'scripts/serve.mjs' = "// s2`n" } -Approve
    $r = Invoke-DeployGate -Config $em.Config -GateMode 'Deploy'
    $names = @('TOBACCO Ameen Read Worker', 'OZK-AmeenAutoPrint', 'OZK-Tobacco-Server (scripts/serve.mjs)')
    Assert-True ($r.result -eq 'DEPLOYED_PENDING_RESTART' -and @($names | Where-Object { @($r.pending_restart) -notcontains $_ }).Count -eq 0 -and @($r.pending_restart).Count -eq 3) 'multiple components => complete list, no name lost'
    $sha2 = Publish-TestRelease $em @{ 'docs/later.md' = "y`n" } -Approve
    $r = Invoke-DeployGate -Config $em.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'DEPLOYED_PENDING_RESTART' -and @($r.pending_restart).Count -eq 3) 'a later unrelated release keeps the pending list (old code still running)'
    $script:Alerts.Clear()
    $r = Invoke-DeployGate -Config $em.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'NOOP' -and @($script:Alerts | Where-Object { $_ -like '*OZK-AmeenAutoPrint*' }).Count -eq 1) 'NOOP while pending sends a reminder naming the components'
    $r = Invoke-DeployGate -Config $em.Config -GateMode 'AckRestart' -AckComponents @('Unknown Component')
    Assert-True ($r.result -eq 'STOP') 'acknowledging an unknown component is refused'
    $r = Invoke-DeployGate -Config $em.Config -GateMode 'AckRestart' -AckComponents @('TOBACCO Ameen Read Worker')
    $st = Get-TestState $em
    Assert-True ($r.result -eq 'OK' -and @($st.pendingRestart).Count -eq 2 -and $st.status -eq 'DEPLOYED_PENDING_RESTART') 'manual acknowledgement clears only the named component'
    $r = Invoke-DeployGate -Config $em.Config -GateMode 'AckRestart' -AckComponents @('OZK-AmeenAutoPrint', 'OZK-Tobacco-Server (scripts/serve.mjs)')
    Assert-True ($r.result -eq 'OK' -and (Get-TestState $em).status -eq 'ok') 'state returns to ok once every restart is acknowledged'

    Write-Host '== Rollback after DEPLOYED_PENDING_RESTART and result filtering (Codex P1 #6)'
    $er = New-InitializedEnv
    $v1 = Get-TestHead $er
    $v2 = Publish-TestRelease $er @{ 'tools/ameen-read-worker.ps1' = "'bad worker release'`n" } -Approve
    $r = Invoke-DeployGate -Config $er.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'DEPLOYED_PENDING_RESTART' -and (Get-TestHead $er) -eq $v2) 'bad release deployed with pending restart'
    $r = Invoke-DeployGate -Config $er.Config -GateMode 'Rollback' -RollbackTo $v1
    $st = Get-TestState $er
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $er) -eq $v1 -and $st.status -eq 'ROLLED_BACK_PINNED') 'rollback from a previous DEPLOYED_PENDING_RESTART deployment => allowed and pinned'
    Assert-True (@($st.pendingRestart) -contains 'TOBACCO Ameen Read Worker') 'rollback keeps the long-running restart pending (no automatic restart)'
    $eo = New-InitializedEnv
    $o1 = Get-TestHead $eo
    [void](Publish-TestRelease $eo @{ 'tools/reader.ps1' = "'ok release'`n" } -Approve)
    $r = Invoke-DeployGate -Config $eo.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK') 'release deployed OK'
    $auditPath = Join-Path $eo.Gate 'audit.jsonl'
    $original = [System.IO.File]::ReadAllText($auditPath)
    foreach ($bad in @('STOP', 'SKIP', 'FAIL', 'FAILED', 'DRYRUN', 'ok', 'WHATEVER', '')) {
        [System.IO.File]::WriteAllText($auditPath, ($original -replace '"result":"OK"', ('"result":"' + $bad + '"')))
        $r = Invoke-DeployGate -Config $eo.Config -GateMode 'Rollback' -RollbackTo $o1
        Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*not a previously deployed SHA*' -and (Get-TestHead $eo) -ne $o1) ("previous result '" + $bad + "' => rollback rejected")
    }
    [System.IO.File]::WriteAllText($auditPath, ('{not json' + "`n" + ($original -replace '"result":"OK"', '"result":"STOP"')))
    $r = Invoke-DeployGate -Config $eo.Config -GateMode 'Rollback' -RollbackTo $o1
    Assert-True ($r.result -eq 'STOP' -and (Get-TestHead $eo) -ne $o1) 'malformed audit line is skipped and does not authorise a rollback (fail closed)'
    [System.IO.File]::WriteAllText($auditPath, ('{not json' + "`n" + $original))
    $r = Invoke-DeployGate -Config $eo.Config -GateMode 'Rollback' -RollbackTo $o1
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $eo) -eq $o1) 'rollback from a previous OK deployment => allowed (a malformed line elsewhere is ignored)'

    Write-Host '== Never older than the device (audit 2026-10-20, gap 3)'
    $eb = New-GateTestEnv; [void]$environments.Add($eb)
    Invoke-TestGit $eb.Seed @('checkout', '-q', 'main') | Out-Null
    Write-TestFile (Join-Path $eb.Seed 'tools/reader.ps1') "'manual main merge on the device'`n"
    Invoke-TestGit $eb.Seed @('commit', '-q', '-am', 'main ahead of windows-production') | Out-Null
    Invoke-TestGit $eb.Seed @('push', '-q', 'origin', 'main') | Out-Null
    Invoke-TestGit $eb.Repo @('fetch', '-q', 'origin') | Out-Null
    Invoke-TestGit $eb.Repo @('checkout', '-q', '-B', 'main', 'origin/main') | Out-Null
    $devHead = Get-TestHead $eb
    $r = Invoke-DeployGate -Config $eb.Config -GateMode 'Initialize'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*behind the device*roll production back*' -and (Get-TestHead $eb) -eq $devHead) 'Initialize: windows-production behind the device => STOP, nothing switched'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $eb.Gate 'state.json'))) 'no state recorded when the branch is behind the device'
    $eb.Config.deviceBaselineSha = '0123456789012345678901234567890123456789'
    $r = Invoke-DeployGate -Config $eb.Config -GateMode 'Initialize'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*deviceBaselineSha*') 'Initialize: HEAD without the configured baseline => STOP'
    $ebl = New-InitializedEnv
    $before = Get-TestHead $ebl
    [void](Publish-TestRelease $ebl @{ 'tools/reader.ps1' = "'release r1'`n" } -Approve)
    Invoke-TestGit $ebl.Seed @('checkout', '-q', 'main') | Out-Null
    Write-TestFile (Join-Path $ebl.Seed 'docs/newer.md') "newer than the release`n"
    Invoke-TestGit $ebl.Seed @('add', '-A') | Out-Null
    Invoke-TestGit $ebl.Seed @('commit', '-q', '-m', 'device runs this') | Out-Null
    Invoke-TestGit $ebl.Seed @('push', '-q', 'origin', 'main') | Out-Null
    $ebl.Config.deviceBaselineSha = Invoke-TestGit $ebl.Seed @('rev-parse', 'HEAD')
    $r = Invoke-DeployGate -Config $ebl.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*older than what the device runs*' -and (Get-TestHead $ebl) -eq $before) 'Deploy: approved fast-forward target older than the baseline => STOP'

    Write-Host '== Task guard (gaps e/f, missing task script)'
    $et = New-InitializedEnv
    $before = Get-TestHead $et
    $sha = Publish-TestRelease $et @{ 'tools/reader.ps1' = "'guarded'`n" } -Approve
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $false; state = ''; nextRunUtc = $null; actionText = '' })
    $r = Invoke-DeployGate -Config $et.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*not visible*SYSTEM*' -and (Get-TestHead $et) -eq $before) 'task invisible to the gate account => STOP (never treated as idle)'
    $direct = 'powershell.exe -File "' + (Join-Path (Join-Path $et.Repo 'tools') 'reader.ps1') + '"'
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Ready'; nextRunUtc = $null; actionText = $direct })
    $r = Invoke-DeployGate -Config $et.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*not routed through run-repo-task*' -and (Get-TestHead $et) -eq $before) 'task not routed through run-repo-task.ps1 => Deploy STOP'
    $r = Invoke-DeployGate -Config $et.Config -GateMode 'DryRun'
    Assert-True ($r.result -eq 'DRYRUN' -and $r.reason -like '*Deploy would STOP*' -and (Get-TestHead $et) -eq $before) 'DryRun reports the unrouted task as a warning'
    $et.Config.routingExempt = @('T1')
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Ready'; nextRunUtc = (Get-Date).ToUniversalTime().AddSeconds(30); actionText = $direct })
    $r = Invoke-DeployGate -Config $et.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*about to start*' -and (Get-TestHead $et) -eq $before) 'exempt (unrouted) task due within startGuardSeconds => SKIP'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $et.Gate 'deploying.flag')) -and -not (Test-Path -LiteralPath (Join-Path $et.Gate 'inflight.json'))) 'imminent-start SKIP leaves no flag and no inflight marker'
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Disabled'; nextRunUtc = (Get-Date).ToUniversalTime().AddSeconds(30); actionText = $direct })
    $r = Invoke-DeployGate -Config $et.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $et) -eq $sha) 'a disabled task neither blocks nor needs routing'
    $et.Config.routingExempt = @()
    $launcherCmd = 'powershell.exe -File "' + (Join-Path $et.Gate 'run-repo-task.ps1') + '" -Script "tools/reader.ps1"'
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Ready'; nextRunUtc = $null; actionText = $launcherCmd })
    $before = Get-TestHead $et
    Invoke-TestGit $et.Seed @('fetch', '-q', 'origin') | Out-Null
    Invoke-TestGit $et.Seed @('checkout', '-q', 'main') | Out-Null
    Invoke-TestGit $et.Seed @('rm', '-q', 'tools/reader.ps1') | Out-Null
    Invoke-TestGit $et.Seed @('commit', '-q', '-m', 'remove a script a task runs') | Out-Null
    $del = Invoke-TestGit $et.Seed @('rev-parse', 'HEAD')
    Invoke-TestGit $et.Seed @('push', '-q', 'origin', 'main', ($del + ':refs/heads/windows-production')) | Out-Null
    $script:Approved[$del] = [pscustomobject]@{ kind = 'ozk-windows-release'; sha = $del; approver = 'owner'; runId = '9'; writeScriptsApproved = $false; writerBlobs = [pscustomobject]@{} }
    $r = Invoke-DeployGate -Config $et.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*removes scripts that scheduled tasks run*T1: tools/reader.ps1*' -and (Get-TestHead $et) -eq $before) 'release deleting a script a task runs => STOP'
    $ew = New-InitializedEnv
    $sha = Publish-TestRelease $ew @{ 'docs/w.md' = "w`n" } -Approve
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Ready'; nextRunUtc = $null; actionText = ('powershell.exe -File "' + (Join-Path $ew.Gate 'run-repo-task.ps1') + '" -Script "tools/watch-customer-invoices.ps1"') })
    $r = Invoke-DeployGate -Config $ew.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and @($r.warnings | Where-Object { $_ -like '*pre-existing*watch-customer-invoices*' }).Count -eq 1) 'task already pointing at a missing script (Invoice Watcher case) => deploy proceeds with a recorded warning'
    $script:TaskInfoOverride = $null

    Write-Host '== Concurrency'
    $ec = New-InitializedEnv
    $before = Get-TestHead $ec
    [void](Publish-TestRelease $ec @{ 'tools/reader.ps1' = "'concurrent'`n" } -Approve)
    $cfgFile = Join-Path $ec.Base 'gate-config.json'
    [System.IO.File]::WriteAllText($cfgFile, ($ec.Config | ConvertTo-Json -Depth 10))
    $held = Enter-GateLock (Get-GatePaths $ec.Config)
    Assert-True ($null -ne $held) 'first gate instance takes the exclusive lock'
    $second = Enter-GateLock (Get-GatePaths $ec.Config)
    Assert-True ($null -eq $second) 'a second instance in the same process cannot take the lock'
    $psExe = (Get-Process -Id $PID).Path
    # في 5.1 يصير stderr العملية الفرعية خطأً منهياً مع Stop — الحكم بالمخرجات ورمز الخروج.
    $oldPref = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $out = & $psExe -NoProfile -ExecutionPolicy Bypass -File $gateScript -Mode Deploy -ConfigPath $cfgFile 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPref }
    Assert-True ((($out -join ' ') -like '*already running*') -and $code -eq 0 -and (Get-TestHead $ec) -eq $before) 'a concurrent gate process exits without touching the repository'
    $held.Close()
    Write-TestFile (Join-Path $ec.Repo '.git/index.lock') ''
    $r = Invoke-DeployGate -Config $ec.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*git operation in progress*index.lock*' -and (Get-TestHead $ec) -eq $before) 'another git operation (index.lock) => SKIP before switching'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $ec.Gate 'deploying.flag'))) 'flag cleared after the git-operation SKIP'
    Remove-Item -LiteralPath (Join-Path $ec.Repo '.git/index.lock') -Force

    Write-Host '== Backup, SHA256 and post-deploy verification'
    $eh = New-InitializedEnv
    $oldHash = (Get-FileHash -LiteralPath (Join-Path $eh.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    $sha = Publish-TestRelease $eh @{ 'tools/reader.ps1' = "'hashed v2'`n"; 'tools/new-tool.ps1' = "'new'`n" } -Approve
    $r = Invoke-DeployGate -Config $eh.Config -GateMode 'Deploy'
    $man = [System.IO.File]::ReadAllText((Join-Path $r.backup_dir 'manifest.json')) | ConvertFrom-Json
    $rd = @($man.files | Where-Object { $_.path -eq 'tools/reader.ps1' })[0]
    $nt = @($man.files | Where-Object { $_.path -eq 'tools/new-tool.ps1' })[0]
    $newHash = (Get-FileHash -LiteralPath (Join-Path $eh.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($r.result -eq 'OK' -and $r.post_verify -eq 'ok') 'deploy verified every changed file against the target blob'
    Assert-True ($rd.existed -and $rd.preSha256 -eq $oldHash -and $rd.postSha256 -eq $newHash -and (Get-FileHash -LiteralPath (Join-Path (Join-Path $r.backup_dir 'files') (Join-Path 'tools' 'reader.ps1')) -Algorithm SHA256).Hash.ToLowerInvariant() -eq $oldHash) 'backup holds the old file with SHA256 before and after'
    Assert-True (-not $nt.existed -and $null -ne $nt.postSha256) 'added file recorded as new, with its post-deploy SHA256'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $eh.Gate 'inflight.json'))) 'inflight marker removed after a verified deploy'
    $bad = @(Test-DeployedFiles $eh.Config ([pscustomobject]@{ files = @([pscustomobject]@{ path = 'tools/reader.ps1'; targetBlob = '0000000000000000000000000000000000000000'; postSha256 = $null }) }))
    Assert-True ($bad.Count -eq 1 -and $bad[0] -like '*content differs*') 'Test-DeployedFiles flags content that differs from the target blob'

    $ebk = New-InitializedEnv
    $before = Get-TestHead $ebk
    [void](Publish-TestRelease $ebk @{ 'tools/reader.ps1' = "'no backup'`n" } -Approve)
    Write-TestFile (Join-Path $ebk.Gate 'backups') 'not a directory'
    $r = Invoke-DeployGate -Config $ebk.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'FAIL' -and $r.reason -like 'backup failed before any change*' -and (Get-TestHead $ebk) -eq $before -and -not (Test-Path -LiteralPath (Join-Path $ebk.Gate 'deploying.flag'))) 'backup failure => FAIL with no change and no flag'

    Write-Host '== Interrupted switch => Recover'
    $ei = New-InitializedEnv
    $before = Get-TestHead $ei
    $preReader = (Get-FileHash -LiteralPath (Join-Path $ei.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    $sha = Publish-TestRelease $ei @{ 'tools/reader.ps1' = "'interrupted v2'`n"; 'tools/added.ps1' = "'added'`n" } -Approve
    $script:MergeOverride = {
        param($Config, $Target)
        # انقطاع في منتصف التبديل: ملف كُتب بنسخة الهدف، وملف جديد ظهر، وHEAD لم يتقدّم.
        [System.IO.File]::WriteAllText((Join-Path $Config.repoPath 'tools/reader.ps1'), "'interrupted v2'`n")
        [System.IO.File]::WriteAllText((Join-Path $Config.repoPath 'tools/added.ps1'), "'added'`n")
        return [pscustomobject]@{ Code = 128; Out = @('error: unable to unlink old file'); Text = 'error: unable to unlink old file' }
    }
    $r = Invoke-DeployGate -Config $ei.Config -GateMode 'Deploy'
    $script:MergeOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and $r.reason -like '*INCONSISTENT*Recover*' -and (Get-TestHead $ei) -eq $before) 'interrupted switch => FAIL INCONSISTENT, HEAD unchanged'
    Assert-True ((Test-Path -LiteralPath (Join-Path $ei.Gate 'deploying.flag')) -and (Test-Path -LiteralPath (Join-Path $ei.Gate 'inflight.json'))) 'flag and inflight marker kept (writers stay paused)'
    $r = Invoke-DeployGate -Config $ei.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*interrupted*Recover*') 'no new deploy on top of an interrupted switch'
    $r = Invoke-DeployGate -Config $ei.Config -GateMode 'Recover'
    $postReader = (Get-FileHash -LiteralPath (Join-Path $ei.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($r.result -eq 'RECOVERED' -and $postReader -eq $preReader -and -not (Test-Path -LiteralPath (Join-Path $ei.Repo 'tools/added.ps1'))) 'Recover restores the old file (SHA256 verified) and removes the half-written new file'
    Assert-True ((Test-Path -LiteralPath (Join-Path (Join-Path $r.backup_dir 'quarantine') (Join-Path 'tools' 'added.ps1'))) -and @(Get-DirtyEntries $ei.Config).Count -eq 0) 'the half-written file is quarantined, not deleted, and the tree is clean'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $ei.Gate 'deploying.flag')) -and -not (Test-Path -LiteralPath (Join-Path $ei.Gate 'inflight.json'))) 'Recover clears the flag and the inflight marker'
    $r = Invoke-DeployGate -Config $ei.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $ei) -eq $sha) 'the same release deploys cleanly after recovery'

    Write-Host '== Verification failure after the switch'
    $ev = New-InitializedEnv
    $before = Get-TestHead $ev
    [void](Publish-TestRelease $ev @{ 'tools/reader.ps1' = "'verified v2'`n" } -Approve)
    $script:MergeOverride = {
        param($Config, $Target)
        $res = Invoke-GateGit $Config @('merge', '--ff-only', $Target)
        [System.IO.File]::WriteAllText((Join-Path $Config.repoPath 'tools/reader.ps1'), "'tampered during switch'`n")
        return $res
    }
    $r = Invoke-DeployGate -Config $ev.Config -GateMode 'Deploy'
    $script:MergeOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and $r.reason -like '*verification failed*flag kept*') 'content differing from the target after the switch => FAIL'
    Assert-True ((Get-TestState $ev).lastDeployedSha -eq $before -and (Test-Path -LiteralPath (Join-Path $ev.Gate 'deploying.flag'))) 'state not advanced and writers stay paused after a failed verification'
    $r = Invoke-DeployGate -Config $ev.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*Manual review*') 'Recover refuses when HEAD already moved (manual review, no guessing)'

    Write-Host '== Interrupted rollback (Codex P1 on #337)'
    $rb = New-InitializedEnv
    $r1 = Get-TestHead $rb
    $r2 = Publish-TestRelease $rb @{ 'tools/reader.ps1' = "'rollback source v2'`n"; 'tools/rb-added.ps1' = "'only in v2'`n" } -Approve
    $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $rb) -eq $r2) 'v2 deployed (rollback source)'
    $v2Reader = (Get-FileHash -LiteralPath (Join-Path $rb.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    $stateBefore = [System.IO.File]::ReadAllText((Join-Path $rb.Gate 'state.json'))
    $script:ResetOverride = {
        param($Config, $Target)
        # انقطاع reset --keep بعد بدء الكتابة: ملف رجع لنسخة v1، وملف v2 أُزيل، وHEAD لم يتحرّك.
        [System.IO.File]::WriteAllText((Join-Path $Config.repoPath 'tools/reader.ps1'), "'reader v1'`n")
        Remove-Item -LiteralPath (Join-Path $Config.repoPath 'tools/rb-added.ps1') -Force
        return [pscustomobject]@{ Code = 128; Out = @('fatal: Could not reset index file'); Text = 'fatal: Could not reset index file' }
    }
    $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Rollback' -RollbackTo $r1
    $script:ResetOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and $r.reason -like '*rollback interrupted*inflight.json kept*Recover*' -and (Get-TestHead $rb) -eq $r2) 'interrupted reset --keep => FAIL, HEAD unchanged'
    $inf = [System.IO.File]::ReadAllText((Join-Path $rb.Gate 'inflight.json')) | ConvertFrom-Json
    Assert-True ($inf.mode -eq 'Rollback' -and $inf.from -eq $r2 -and $inf.to -eq $r1 -and $inf.schema -eq 1 -and (Test-Path -LiteralPath (Join-Path $inf.backupDir 'manifest.json'))) 'inflight.json records the rollback (mode, from, to, backup) before reset --keep'
    Assert-True ((Test-Path -LiteralPath (Join-Path $rb.Gate 'deploying.flag')) -and [System.IO.File]::ReadAllText((Join-Path $rb.Gate 'state.json')) -eq $stateBefore) 'flag kept and state untouched after the interrupted rollback'
    $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*interrupted*Recover*') 'no deploy on top of an interrupted rollback'
    $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Rollback' -RollbackTo $r1
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*interrupted*Recover*') 'no second rollback on top of an interrupted one'
    $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Recover'
    $nowReader = (Get-FileHash -LiteralPath (Join-Path $rb.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($r.result -eq 'RECOVERED' -and $r.reason -like '*Rollback undone*' -and (Get-TestHead $rb) -eq $r2 -and $nowReader -eq $v2Reader -and (Test-Path -LiteralPath (Join-Path $rb.Repo 'tools/rb-added.ps1'))) 'Recover undoes the interrupted rollback: v2 files back with verified SHA256'
    Assert-True (@(Get-DirtyEntries $rb.Config).Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $rb.Gate 'deploying.flag')) -and -not (Test-Path -LiteralPath (Join-Path $rb.Gate 'inflight.json')) -and [System.IO.File]::ReadAllText((Join-Path $rb.Gate 'state.json')) -eq $stateBefore) 'tree clean, flag and inflight cleared, state exactly as before the rollback'

    Write-Host '== Recover is idempotent'
    $snap = Get-TreeSnapshot $rb
    $auditCount = @(Get-AuditLines $rb).Count
    foreach ($i in 1..2) {
        $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Recover'
        Assert-True ($r.result -eq 'NOOP' -and $r.reason -like 'nothing to recover*') ('Recover #' + ($i + 1) + ' after a completed recovery => NOOP')
        Assert-True ((Get-TreeSnapshot $rb) -eq $snap -and @(Get-AuditLines $rb).Count -eq $auditCount) ('Recover #' + ($i + 1) + ' changes no file, timestamp, gate state or audit')
    }
    $r = Invoke-DeployGate -Config $rb.Config -GateMode 'Rollback' -RollbackTo $r1
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $rb) -eq $r1 -and (Get-TestState $rb).status -eq 'ROLLED_BACK_PINNED' -and -not (Test-Path -LiteralPath (Join-Path $rb.Gate 'inflight.json'))) 'the real rollback then succeeds and leaves no inflight marker'

    Write-Host '== Rollback interrupted after HEAD moved => Recover completes it'
    $rc = New-InitializedEnv
    $c1 = Get-TestHead $rc
    $c2 = Publish-TestRelease $rc @{ 'tools/ameen-read-worker.ps1' = "'worker v2'`n" } -Approve
    [void](Invoke-DeployGate -Config $rc.Config -GateMode 'Deploy')
    $script:ResetOverride = {
        param($Config, $Target)
        $res = Invoke-GateGit $Config @('reset', '--keep', $Target)
        return [pscustomobject]@{ Code = 1; Out = @('simulated crash after reset'); Text = 'simulated crash after reset' }
    }
    $r = Invoke-DeployGate -Config $rc.Config -GateMode 'Rollback' -RollbackTo $c1
    $script:ResetOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and (Get-TestHead $rc) -eq $c1 -and (Get-TestState $rc).lastDeployedSha -eq $c2 -and (Test-Path -LiteralPath (Join-Path $rc.Gate 'inflight.json'))) 'HEAD moved but the rollback was not recorded => FAIL with inflight kept'
    $r = Invoke-DeployGate -Config $rc.Config -GateMode 'Recover'
    $st = Get-TestState $rc
    Assert-True ($r.result -eq 'RECOVERED' -and $r.reason -like '*rollback completed*' -and $st.status -eq 'ROLLED_BACK_PINNED' -and $st.pinnedSha -eq $c1 -and $st.rolledBackFrom -eq $c2) 'Recover verifies every file against the target and completes the rollback (pinned)'
    Assert-True (@($st.pendingRestart) -contains 'TOBACCO Ameen Read Worker' -and -not (Test-Path -LiteralPath (Join-Path $rc.Gate 'deploying.flag'))) 'completed rollback keeps the pending restart and clears the flag'
    $snap = Get-TreeSnapshot $rc
    $r = Invoke-DeployGate -Config $rc.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'NOOP' -and (Get-TreeSnapshot $rc) -eq $snap) 'second Recover after completing the rollback => NOOP, nothing changed'

    Write-Host '== Clean reset refusal leaves nothing to recover'
    $rr = New-InitializedEnv
    $q1 = Get-TestHead $rr
    $q2 = Publish-TestRelease $rr @{ 'tools/reader.ps1' = "'q2'`n" } -Approve
    [void](Invoke-DeployGate -Config $rr.Config -GateMode 'Deploy')
    $script:ResetOverride = { param($Config, $Target) return [pscustomobject]@{ Code = 128; Out = @('error: Entry would be overwritten'); Text = 'error: Entry would be overwritten' } }
    $r = Invoke-DeployGate -Config $rr.Config -GateMode 'Rollback' -RollbackTo $q1
    $script:ResetOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and $r.reason -like '*refused, tree unchanged*' -and (Get-TestHead $rr) -eq $q2 -and -not (Test-Path -LiteralPath (Join-Path $rr.Gate 'inflight.json')) -and -not (Test-Path -LiteralPath (Join-Path $rr.Gate 'deploying.flag'))) 'git refusing reset --keep cleanly => FAIL, no inflight, no flag'

    Write-Host '== Fail closed: damaged or missing inflight.json'
    $fc = New-InitializedEnv
    $f1 = Get-TestHead $fc
    $f2 = Publish-TestRelease $fc @{ 'tools/reader.ps1' = "'fc v2'`n" } -Approve
    [void](Invoke-DeployGate -Config $fc.Config -GateMode 'Deploy')
    $script:ResetOverride = {
        param($Config, $Target)
        [System.IO.File]::WriteAllText((Join-Path $Config.repoPath 'tools/reader.ps1'), "'half reset'`n")
        return [pscustomobject]@{ Code = 128; Out = @('interrupted'); Text = 'interrupted' }
    }
    $r = Invoke-DeployGate -Config $fc.Config -GateMode 'Rollback' -RollbackTo $f1
    $script:ResetOverride = $null
    $infPath = Join-Path $fc.Gate 'inflight.json'
    $goodInflight = [System.IO.File]::ReadAllText($infPath)
    $goodObj = $goodInflight | ConvertFrom-Json
    $altDir = Join-Path $fc.Base 'elsewhere'
    New-Item -ItemType Directory -Force -Path $altDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $goodObj.backupDir 'manifest.json') -Destination (Join-Path $altDir 'manifest.json')
    $cases = @(
        @{ name = 'truncated JSON'; text = '{"schema":1,"mode":"Rollb'; reason = '*not valid JSON*' },
        @{ name = 'empty file'; text = ''; reason = '*inflight.json is*' },
        @{ name = 'unknown mode'; text = ($goodInflight -replace '"Rollback"', '"Guess"'); reason = '*unknown mode*' },
        @{ name = 'invalid from'; text = ($goodInflight -replace $f2, 'not-a-sha'); reason = '*invalid from*' },
        @{ name = 'backup outside the gate folder'; text = ($goodInflight.Replace(($goodObj.backupDir | ConvertTo-Json).Trim('"'), ($altDir | ConvertTo-Json).Trim('"'))); reason = '*outside the gate backups folder*' },
        @{ name = 'manifest of another operation'; text = ($goodInflight -replace $f1, '1111111111111111111111111111111111111111'); reason = '*does not match inflight*' })
    foreach ($c in $cases) {
        [System.IO.File]::WriteAllText($infPath, $c.text)
        $snap = Get-TreeSnapshot $fc
        $r = Invoke-DeployGate -Config $fc.Config -GateMode 'Recover'
        Assert-True ($r.result -eq 'STOP' -and $r.reason -like $c.reason -and $r.reason -like '*Manual review*') ('inflight.json ' + $c.name + ' => Recover STOP (' + $r.reason + ')')
        Assert-True ((Get-TreeSnapshot $fc) -eq $snap -and (Get-TestHead $fc) -eq $f2) ('inflight.json ' + $c.name + ' => no file, flag or state touched')
        $r = Invoke-DeployGate -Config $fc.Config -GateMode 'Deploy'
        Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*interrupted*') ('inflight.json ' + $c.name + ' => Deploy still refused')
    }
    $copyPath = Join-Path (Join-Path $goodObj.backupDir 'files') (Join-Path 'tools' 'reader.ps1')
    $goodCopy = [System.IO.File]::ReadAllText($copyPath)
    [System.IO.File]::WriteAllText($infPath, $goodInflight)
    [System.IO.File]::WriteAllText($copyPath, "'tampered backup'`n")
    $snap = Get-TreeSnapshot $fc
    $r = Invoke-DeployGate -Config $fc.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*backup copy missing or altered*' -and (Get-TreeSnapshot $fc) -eq $snap) 'altered backup copy => STOP before restoring anything'
    [System.IO.File]::WriteAllText($copyPath, $goodCopy)
    Move-Item -LiteralPath $infPath -Destination (Join-Path $fc.Base 'inflight.moved.json')
    $snap = Get-TreeSnapshot $fc
    $r = Invoke-DeployGate -Config $fc.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*inflight.json is missing*refusing to guess*' -and (Get-TreeSnapshot $fc) -eq $snap) 'inflight.json missing while the flag/dirty tree remain => STOP, nothing changed'
    Move-Item -LiteralPath (Join-Path $fc.Base 'inflight.moved.json') -Destination $infPath
    $r = Invoke-DeployGate -Config $fc.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'RECOVERED' -and (Get-TestHead $fc) -eq $f2 -and @(Get-DirtyEntries $fc.Config).Count -eq 0) 'with the original inflight.json restored, Recover succeeds (fail-closed paths destroyed nothing)'

    Write-Host '== Rollback obeys the task guard (Codex P1 on #337, second finding)'
    $rg = New-InitializedEnv
    $g1 = Get-TestHead $rg
    $g2 = Publish-TestRelease $rg @{ 'tools/reader.ps1' = "'guarded rollback v2'`n" } -Approve
    [void](Invoke-DeployGate -Config $rg.Config -GateMode 'Deploy')
    $direct = 'powershell.exe -File "' + (Join-Path (Join-Path $rg.Repo 'tools') 'reader.ps1') + '"'
    $guardCases = @(
        @{ name = 'invisible task'; infos = @([pscustomobject]@{ name = 'T1'; visible = $false; state = ''; nextRunUtc = $null; actionText = '' }); result = 'STOP'; reason = '*not visible*SYSTEM*'; exempt = @() },
        @{ name = 'unrouted task'; infos = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Ready'; nextRunUtc = $null; actionText = $direct }); result = 'STOP'; reason = '*not routed through run-repo-task*'; exempt = @() },
        @{ name = 'exempt task about to start'; infos = @([pscustomobject]@{ name = 'T1'; visible = $true; state = 'Ready'; nextRunUtc = (Get-Date).ToUniversalTime().AddSeconds(20); actionText = $direct }); result = 'SKIP'; reason = '*not rolling back*about to start*'; exempt = @('T1') })
    foreach ($c in $guardCases) {
        $rg.Config.routingExempt = $c.exempt
        $script:TaskInfoOverride = $c.infos
        $snap = Get-TreeSnapshot $rg
        $r = Invoke-DeployGate -Config $rg.Config -GateMode 'Rollback' -RollbackTo $g1
        Assert-True ($r.result -eq $c.result -and $r.reason -like $c.reason -and (Get-TestHead $rg) -eq $g2) ('rollback with ' + $c.name + ' => ' + $c.result + ', no reset')
        Assert-True ((Get-TreeSnapshot $rg) -eq $snap) ('rollback with ' + $c.name + ' => no file, flag, inflight or state change')
    }
    $rg.Config.routingExempt = @()
    $script:TaskInfoOverride = $null
    Write-TestFile (Join-Path $rg.Repo '.git/index.lock') ''
    $r = Invoke-DeployGate -Config $rg.Config -GateMode 'Rollback' -RollbackTo $g1
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*git operation in progress*' -and (Get-TestHead $rg) -eq $g2) 'rollback during another git operation => STOP'
    Remove-Item -LiteralPath (Join-Path $rg.Repo '.git/index.lock') -Force
    $r = Invoke-DeployGate -Config $rg.Config -GateMode 'Rollback' -RollbackTo $g1
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $rg) -eq $g1) 'rollback proceeds once every task is visible and routed'
    $gateSrcText = [System.IO.File]::ReadAllText($gateScript)
    Assert-True ($gateSrcText -match "if \(-not \`$task\) \{ \`$running \+= \(\`$name \+ ' \(not visible\)'\)") 'Wait-TasksIdle never treats an invisible task as idle (real Get-RunningTaskNames)'

    Write-Host '== Rollback: active task, task starting during the wait, failed re-check'
    $ra = New-InitializedEnv
    $a1 = Get-TestHead $ra
    $a2 = Publish-TestRelease $ra @{ 'tools/reader.ps1' = "'active-task v2'`n" } -Approve
    [void](Invoke-DeployGate -Config $ra.Config -GateMode 'Deploy')
    $routed = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Ready'; nextRunUtc = $null; actionText = ('powershell.exe -File "' + (Join-Path $Config.gateDir 'run-repo-task.ps1') + '" -Script "tools/reader.ps1"') } }) }
    $hidden = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = ($_ -ne 'T1'); state = 'Ready'; nextRunUtc = $null; actionText = ('powershell.exe -File "' + (Join-Path $Config.gateDir 'run-repo-task.ps1') + '" -Script "tools/reader.ps1"') } }) }
    $direct = 'powershell.exe -File "' + (Join-Path (Join-Path $ra.Repo 'tools') 'reader.ps1') + '"'
    $dueSoon = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Ready'; nextRunUtc = (Get-Date).ToUniversalTime().AddSeconds(15); actionText = $direct } }) }
    $later = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Ready'; nextRunUtc = (Get-Date).ToUniversalTime().AddHours(1); actionText = $direct } }) }

    # مهمة إنتاجية نشطة (أو بدأت أثناء الانتظار ولم تنتهِ قبل المهلة) ⇒ لا reset.
    $script:Running = @('T1')
    $snap = Get-TreeSnapshot $ra
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*tasks still running*T1*' -and (Get-TestHead $ra) -eq $a2) 'rollback while a production task is running (or starts during the wait) => SKIP, no reset'
    Assert-True ((Get-TreeSnapshot $ra) -eq $snap) 'active task => no file, flag, inflight or state change'
    # مهمة لا يمكن إثبات خمولها (غير مرئية لـGet-ScheduledTask) ⇒ «مشغولة» في الانتظار الحقيقي.
    $script:Running = @('T1 (not visible)')
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*T1 (not visible)*' -and (Get-TreeSnapshot $ra) -eq $snap) 'idleness cannot be proven (invisible during the wait) => SKIP, nothing changed'
    $script:Running = @()

    # تغيّر الحالة أثناء الانتظار: الفحص الأول سليم، وإعادة الفحص بعد الانتظار تفشل ⇒ لا reset.
    $script:TaskInfoSequence = @($routed, $hidden)
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*not rolling back*tasks became invisible*T1*' -and (Get-TestHead $ra) -eq $a2) 'task becomes invisible during the wait => re-check fails, SKIP before reset'
    Assert-True ((Get-TreeSnapshot $ra) -eq $snap -and -not (Test-Path -LiteralPath (Join-Path $ra.Gate 'deploying.flag'))) 'failed re-check => no file or state change, flag cleared, no inflight'
    $ra.Config.routingExempt = @('T1')
    $script:TaskInfoSequence = @($later, $dueSoon)
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*not rolling back*about to start*' -and (Get-TreeSnapshot $ra) -eq $snap) 'exempt task becomes due during the wait => re-check fails, nothing changed'
    $ra.Config.routingExempt = @()
    $script:TaskInfoSequence = @($routed, { param($Config, $Names) Write-TestFile (Join-Path $Config.repoPath 'tools/late-edit.txt') 'x'; return @(& $routed $Config $Names) })
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*worktree changed during the pause*' -and (Get-TestHead $ra) -eq $a2) 'worktree changed during the wait => re-check fails, no reset'
    Remove-Item -LiteralPath (Join-Path $ra.Repo 'tools/late-edit.txt') -Force
    $script:TaskInfoSequence = $null

    # Deploy يستعمل إعادة الفحص نفسها.
    $a3 = Publish-TestRelease $ra @{ 'tools/reader.ps1' = "'active-task v3'`n" } -Approve
    $script:TaskInfoSequence = @($routed, $hidden)
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*tasks became invisible*' -and (Get-TestHead $ra) -eq $a2) 'deploy shares the same post-wait re-check'
    $script:TaskInfoSequence = $null

    # بعد زوال كل الموانع: تراجع منقطع (inflight قبل reset) ثم Recover ثم تراجع ناجح.
    $script:ResetOverride = {
        param($Config, $Target)
        [System.IO.File]::WriteAllText((Join-Path $Config.repoPath 'tools/reader.ps1'), "'half rollback'`n")
        return [pscustomobject]@{ Code = 128; Out = @('interrupted'); Text = 'interrupted' }
    }
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    $script:ResetOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and (Test-Path -LiteralPath (Join-Path $ra.Gate 'inflight.json'))) 'guarded rollback interrupted mid reset => inflight.json kept'
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'RECOVERED' -and (Get-TreeSnapshot $ra) -eq $snap) 'Recover returns the device exactly to its pre-rollback snapshot (files, flag, state)'
    $r = Invoke-DeployGate -Config $ra.Config -GateMode 'Rollback' -RollbackTo $a1
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $ra) -eq $a1) 'rollback succeeds once every guard passes'

    Write-Host '== Codex P1 (94c4c9e): task started after the wait; inflight kept until finalization'
    $rs = New-InitializedEnv
    $s1 = Get-TestHead $rs
    $s2 = Publish-TestRelease $rs @{ 'tools/reader.ps1' = "'restart v2'`n" } -Approve
    [void](Invoke-DeployGate -Config $rs.Config -GateMode 'Deploy')
    $directRs = 'powershell.exe -File "' + (Join-Path (Join-Path $rs.Repo 'tools') 'reader.ps1') + '"'
    $idleExempt = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Ready'; nextRunUtc = (Get-Date).ToUniversalTime().AddHours(1); actionText = ('powershell.exe -File "' + (Join-Path $Config.repoPath 'tools/reader.ps1') + '"') } }) }
    $runningExempt = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Running'; nextRunUtc = (Get-Date).ToUniversalTime().AddDays(1); actionText = ('powershell.exe -File "' + (Join-Path $Config.repoPath 'tools/reader.ps1') + '"') } }) }
    $rs.Config.routingExempt = @('T1')
    $snap = Get-TreeSnapshot $rs
    $script:TaskInfoSequence = @($idleExempt, $runningExempt)
    $r = Invoke-DeployGate -Config $rs.Config -GateMode 'Rollback' -RollbackTo $s1
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*tasks started after the idle wait*T1*' -and (Get-TreeSnapshot $rs) -eq $snap) 'exempt task starts after the idle wait (next run far away) => rollback SKIP, nothing changed'
    $s3 = Publish-TestRelease $rs @{ 'tools/reader.ps1' = "'restart v3'`n" } -Approve
    $script:TaskInfoSequence = @($idleExempt, $runningExempt)
    $r = Invoke-DeployGate -Config $rs.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*tasks started after the idle wait*' -and (Get-TestHead $rs) -eq $s2) 'same case on Deploy => SKIP before merge'
    $script:TaskInfoSequence = $null
    $rs.Config.routingExempt = @()

    $script:ResetOverride = {
        param($Config, $Target)
        $res = Invoke-GateGit $Config @('reset', '--keep', $Target)
        return [pscustomobject]@{ Code = 1; Out = @('crash after reset'); Text = 'crash after reset' }
    }
    $r = Invoke-DeployGate -Config $rs.Config -GateMode 'Rollback' -RollbackTo $s1
    $script:ResetOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and (Get-TestHead $rs) -eq $s1 -and (Test-Path -LiteralPath (Join-Path $rs.Gate 'inflight.json'))) 'rollback interrupted after HEAD moved => inflight kept'
    $script:FailSaveStateOnce = $true
    $crashed = $false
    try { [void](Invoke-DeployGate -Config $rs.Config -GateMode 'Recover') } catch { $crashed = $true }
    Assert-True ($crashed -and (Test-Path -LiteralPath (Join-Path $rs.Gate 'inflight.json')) -and (Get-TestState $rs).lastDeployedSha -eq $s2) 'crash while Recover finalizes the rollback => inflight.json still present, state not half-written'
    $r = Invoke-DeployGate -Config $rs.Config -GateMode 'Recover'
    $st = Get-TestState $rs
    Assert-True ($r.result -eq 'RECOVERED' -and $st.status -eq 'ROLLED_BACK_PINNED' -and $st.pinnedSha -eq $s1 -and -not (Test-Path -LiteralPath (Join-Path $rs.Gate 'inflight.json')) -and -not (Test-Path -LiteralPath (Join-Path $rs.Gate 'deploying.flag'))) 'the next Recover completes the rollback from the kept record'
    Assert-True ((Test-Path -LiteralPath (Join-Path $r.backup_dir 'inflight.recovered.json'))) 'the record is archived inside its backup only after finalization'
    $snap = Get-TreeSnapshot $rs
    $r = Invoke-DeployGate -Config $rs.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'NOOP' -and (Get-TreeSnapshot $rs) -eq $snap) 'Recover after completion => NOOP, nothing changed'

    Write-Host '== Codex P1 (231c878): Recover obeys the task guard; interrupted switch that wrote the index'
    $ix = New-InitializedEnv
    $x1 = Get-TestHead $ix
    $x1Reader = (Get-FileHash -LiteralPath (Join-Path $ix.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    $x2 = Publish-TestRelease $ix @{ 'tools/reader.ps1' = "'index v2'`n"; 'tools/index-added.ps1' = "'new in v2'`n" } -Approve
    # انقطاع بعد كتابة الفهرس والملفات على الهدف وقبل تحريك HEAD (read-tree -m -u بلا تحديث المرجع).
    $script:MergeOverride = {
        param($Config, $Target)
        [void](Invoke-GateGit $Config @('read-tree', '-m', '-u', 'HEAD', $Target))
        return [pscustomobject]@{ Code = 128; Out = @('fatal: interrupted after index write'); Text = 'fatal: interrupted after index write' }
    }
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Deploy'
    $script:MergeOverride = $null
    $staged = Invoke-TestGit $ix.Repo @('diff', '--cached', '--name-only')
    Assert-True ($r.result -eq 'FAIL' -and (Get-TestHead $ix) -eq $x1 -and $staged -like '*tools/reader.ps1*') 'interrupted switch left the index describing the target (staged changes), HEAD unchanged'
    $man = [System.IO.File]::ReadAllText((Join-Path $r.backup_dir 'manifest.json')) | ConvertFrom-Json
    Assert-True ($man.indexSha256 -match '^[0-9a-f]{64}$' -and (Test-Path -LiteralPath (Join-Path $r.backup_dir 'git-index'))) 'the pre-switch git index is backed up with its SHA256'

    # الحارس قبل أي إعادة كتابة: مهمة نشطة / غير مرئية / بدأت بعد الانتظار ⇒ لا مساس.
    $snap = Get-TreeSnapshot $ix
    $idxBefore = (Get-FileHash -LiteralPath (Join-Path $ix.Repo '.git/index') -Algorithm SHA256).Hash
    $script:Running = @('T1')
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*tasks still running*T1*nothing changed*') 'Recover while a production task runs => SKIP'
    $script:Running = @()
    $script:TaskInfoOverride = @([pscustomobject]@{ name = 'T1'; visible = $false; state = ''; nextRunUtc = $null; actionText = '' })
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*not visible*nothing changed*') 'Recover with an invisible task => STOP'
    $script:TaskInfoOverride = $null
    $ix.Config.routingExempt = @('T1')
    $exIdle = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Ready'; nextRunUtc = (Get-Date).ToUniversalTime().AddHours(1); actionText = ('powershell.exe -File "' + (Join-Path $Config.repoPath 'tools/reader.ps1') + '"') } }) }
    $exRunning = { param($Config, $Names) @($Names | ForEach-Object { [pscustomobject]@{ name = $_; visible = $true; state = 'Running'; nextRunUtc = (Get-Date).ToUniversalTime().AddDays(1); actionText = ('powershell.exe -File "' + (Join-Path $Config.repoPath 'tools/reader.ps1') + '"') } }) }
    $script:TaskInfoSequence = @($exIdle, $exRunning)
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    $script:TaskInfoSequence = $null
    $ix.Config.routingExempt = @()
    Assert-True ($r.result -eq 'SKIP' -and $r.reason -like '*tasks started after the idle wait*') 'Recover when an exempt task starts after the idle wait => SKIP'
    Assert-True ((Get-TreeSnapshot $ix) -eq $snap -and (Get-FileHash -LiteralPath (Join-Path $ix.Repo '.git/index') -Algorithm SHA256).Hash -eq $idxBefore -and (Test-Path -LiteralPath (Join-Path $ix.Gate 'inflight.json'))) 'guard failures during Recover => no file, index, flag or record change'

    $idxCopy = Join-Path (([System.IO.File]::ReadAllText((Join-Path $ix.Gate 'inflight.json')) | ConvertFrom-Json).backupDir) 'git-index'
    $idxBytes = [System.IO.File]::ReadAllBytes($idxCopy)
    [System.IO.File]::WriteAllBytes($idxCopy, [byte[]](1, 2, 3))
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*git index missing or altered*' -and (Get-TreeSnapshot $ix) -eq $snap) 'altered backup of the git index => STOP, nothing changed'
    [System.IO.File]::WriteAllBytes($idxCopy, $idxBytes)

    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    $nowReader = (Get-FileHash -LiteralPath (Join-Path $ix.Repo 'tools/reader.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-True ($r.result -eq 'RECOVERED' -and $r.reason -like '*git index restored: True*' -and (Get-TestHead $ix) -eq $x1 -and $nowReader -eq $x1Reader -and -not (Test-Path -LiteralPath (Join-Path $ix.Repo 'tools/index-added.ps1'))) 'Recover restores the git index and the files of an interrupted switch'
    Assert-True (@(Get-DirtyEntries $ix.Config).Count -eq 0 -and (Invoke-TestGit $ix.Repo @('diff', '--cached', '--name-only')) -eq '' -and -not (Test-Path -LiteralPath (Join-Path $ix.Gate 'inflight.json'))) 'nothing staged, tree clean, record closed'
    $snap = Get-TreeSnapshot $ix
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'NOOP' -and (Get-TreeSnapshot $ix) -eq $snap) 'second Recover => NOOP'
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'OK' -and (Get-TestHead $ix) -eq $x2) 'the release then deploys cleanly'

    $script:ResetOverride = {
        param($Config, $Target)
        [void](Invoke-GateGit $Config @('read-tree', '-m', '-u', 'HEAD', $Target))
        return [pscustomobject]@{ Code = 128; Out = @('interrupted reset after index write'); Text = 'interrupted reset after index write' }
    }
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Rollback' -RollbackTo $x1
    $script:ResetOverride = $null
    Assert-True ($r.result -eq 'FAIL' -and (Get-TestHead $ix) -eq $x2 -and (Invoke-TestGit $ix.Repo @('diff', '--cached', '--name-only')) -ne '') 'interrupted reset --keep left a staged index'
    $r = Invoke-DeployGate -Config $ix.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'RECOVERED' -and (Get-TestHead $ix) -eq $x2 -and @(Get-DirtyEntries $ix.Config).Count -eq 0 -and (Test-Path -LiteralPath (Join-Path $ix.Repo 'tools/index-added.ps1'))) 'Recover undoes the interrupted rollback including its index'

    Write-Host '== Codex P1 (c1050ce): deploy keeps inflight.json until finalization'
    $df = New-InitializedEnv
    $d1 = Get-TestHead $df
    $d2 = Publish-TestRelease $df @{ 'tools/ameen-read-worker.ps1' = "'worker d2'`n" } -Approve
    $script:FailSaveStateOnce = $true
    $crashed = $false
    try { [void](Invoke-DeployGate -Config $df.Config -GateMode 'Deploy') } catch { $crashed = $true }
    Assert-True ($crashed -and (Get-TestHead $df) -eq $d2 -and (Get-TestState $df).lastDeployedSha -eq $d1 -and (Test-Path -LiteralPath (Join-Path $df.Gate 'inflight.json')) -and (Test-Path -LiteralPath (Join-Path $df.Gate 'deploying.flag'))) 'crash while writing state after a verified switch => inflight.json and flag kept, state still old'
    $r = Invoke-DeployGate -Config $df.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'STOP' -and $r.reason -like '*interrupted*Recover*' -and (Get-TestHead $df) -eq $d2) 'next Deploy points at Recover (not at an unexplained HEAD drift)'
    $r = Invoke-DeployGate -Config $df.Config -GateMode 'Recover'
    $st = Get-TestState $df
    Assert-True ($r.result -eq 'RECOVERED' -and $r.reason -like '*interrupted deploy completed*' -and $st.lastDeployedSha -eq $d2 -and $st.status -eq 'DEPLOYED_PENDING_RESTART' -and @($st.pendingRestart) -contains 'TOBACCO Ameen Read Worker') 'Recover verifies the files and completes the deploy (state, pending restart)'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $df.Gate 'inflight.json')) -and -not (Test-Path -LiteralPath (Join-Path $df.Gate 'deploying.flag')) -and (Test-Path -LiteralPath (Join-Path $r.backup_dir 'inflight.recovered.json'))) 'record archived and removed last; flag cleared'
    $allow = [System.IO.File]::ReadAllText((Join-Path $df.Gate 'writer-allowlist.json')) | ConvertFrom-Json
    Assert-True ($allow.sha -eq $d2) 'writer allowlist finalized for the completed release'
    $snap = Get-TreeSnapshot $df
    $r = Invoke-DeployGate -Config $df.Config -GateMode 'Recover'
    Assert-True ($r.result -eq 'NOOP' -and (Get-TreeSnapshot $df) -eq $snap) 'Recover after completion => NOOP, nothing changed'
    $r = Invoke-DeployGate -Config $df.Config -GateMode 'Deploy'
    Assert-True ($r.result -eq 'NOOP' -and (Get-TestHead $df) -eq $d2) 'gate is consistent again (NOOP on the same release)'

    Write-Host '== Safety invariants in the source'
    $src = [System.IO.File]::ReadAllText($gateScript)
    Assert-True ($src -notmatch "'pull'" -and $src -notmatch "'rebase'" -and $src -notmatch "'--hard'") 'gate never passes pull, rebase or --hard to git'
    Assert-True ($src -match "'merge', '--ff-only'") 'gate updates with merge --ff-only'
    $forbidden = @('Stop-ScheduledTask', 'Start-ScheduledTask', 'Enable-ScheduledTask', 'Disable-ScheduledTask', 'Set-ScheduledTask', 'Register-ScheduledTask', 'Unregister-ScheduledTask', 'Stop-Process', 'Restart-Service', 'Stop-Service', 'taskkill', 'schtasks')
    Assert-True (@($forbidden | Where-Object { $src -match [regex]::Escape($_) }).Count -eq 0) 'gate never restarts, stops or mutates tasks/processes'
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
