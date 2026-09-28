#Requires -Version 5.1
# ============================================================
# deploy-gate.ps1 — بوابة نشر Windows (نسخة مرجعية)
#
# النسخة المعتمدة تعيش في C:\ProgramData\OZK-TOBACCO\DeployGate\ (كتابة لـ
# Administrators/SYSTEM فقط) ولا تُستدعى من المستودع أبداً. هذا الملف في
# المستودع للمراجعة والاختبار فقط: الدمج إلى main لا يغيّر البوابة المثبّتة.
#
# القاعدة: الجهاز يتبع فرع windows-production وحده، ويتقدّم Fast-Forward فقط
# إلى SHA له Deployment ناجح في بيئة windows-production (موافقة المالك) وCI
# أخضر على نفس الـSHA. لا pull، لا rebase، لا reset --hard. أي شك = لا تحديث.
#
# الأوضاع:
#   -Mode Deploy      التحديث المعتاد (تشغّله المهمة المجدولة كل 10 دقائق)
#   -Mode DryRun      كل الفحوص وتسجيل القرار بلا أي تغيير على المستودع
#   -Mode Initialize  أول تثبيت: يسجّل الحالة الحالية وبصمات ملفات الكتابة
#   -Mode Rollback -To <sha>   رجوع طارئ يدوي (reset --keep) ثم تثبيت الحالة
#   -Mode Unpin       فك التثبيت بعد نشر إصدار مصحَّح على windows-production
# ============================================================
[CmdletBinding()]
param(
    [ValidateSet('Deploy', 'DryRun', 'Initialize', 'Rollback', 'Unpin')]
    [string]$Mode = 'Deploy',
    [string]$To = '',
    [string]$ConfigPath = ''
)

$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------
# الإعداد والحالة
# ------------------------------------------------------------
function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Object) {
    $json = $Object | ConvertTo-Json -Depth 10
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-GateConfig([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { $Path = Join-Path $PSScriptRoot 'gate-config.json' }
    $cfg = Read-JsonFile $Path
    if (-not $cfg) { throw "gate config not found: $Path" }
    foreach ($key in 'expectedHost', 'repoPath', 'gateDir', 'githubRepo', 'windowsBranch', 'mainBranch', 'deploymentEnvironment') {
        if ([string]::IsNullOrWhiteSpace([string]$cfg.$key)) { throw "gate config missing: $key" }
    }
    return $cfg
}

function Get-GatePaths($Config) {
    return [pscustomobject]@{
        State     = Join-Path $Config.gateDir 'state.json'
        Audit     = Join-Path $Config.gateDir 'audit.jsonl'
        Flag      = Join-Path $Config.gateDir 'deploying.flag'
        Allowlist = Join-Path $Config.gateDir 'writer-allowlist.json'
        Log       = Join-Path $Config.gateDir 'deploy-gate.log'
        Lock      = Join-Path $Config.gateDir 'deploy-gate.lock'
    }
}

function Write-GateLog($Paths, [string]$Message) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
    [System.IO.File]::AppendAllText($Paths.Log, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-AuditRecord($Paths, $Record) {
    $line = $Record | ConvertTo-Json -Depth 10 -Compress
    [System.IO.File]::AppendAllText($Paths.Audit, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# ------------------------------------------------------------
# نقاط تماس خارجية — تُستبدل في الاختبارات
# ------------------------------------------------------------
function Get-HostName { return [Environment]::MachineName }

function Send-GateAlert([string]$Message, [string]$DedupeKey) {
    $notify = Join-Path $PSScriptRoot 'notify.ps1'
    if (Test-Path -LiteralPath $notify) {
        try { & $notify -Message $Message -DedupeKey $DedupeKey -ConfigPath $script:GateConfigPath | Out-Null }
        catch { Write-Verbose ('notify failed: ' + $_.Exception.Message) }
    }
}

function Get-GitHubJson($Config, [string]$RelativePath) {
    $uri = 'https://api.github.com/repos/' + $Config.githubRepo + '/' + $RelativePath
    $headers = @{ 'User-Agent' = 'ozk-deploy-gate'; 'Accept' = 'application/vnd.github+json' }
    # في 5.1 يُخرج Invoke-RestMethod مصفوفة JSON كعنصر واحد؛ الإسناد ثم return يفكّها.
    $response = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 20
    return $response
}

function Get-RunningTaskNames([string[]]$TaskNames) {
    $running = @()
    foreach ($name in $TaskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($task -and [string]$task.State -eq 'Running') { $running += $name }
    }
    return $running
}

function Start-GateSleep([int]$Seconds) { Start-Sleep -Seconds $Seconds }

# ------------------------------------------------------------
# git — الحكم برمز الخروج وحده (stderr في 5.1 يصير أخطاء)
# ------------------------------------------------------------
function Invoke-GateGit($Config, [string[]]$GitArgs) {
    $git = 'C:\Program Files\Git\cmd\git.exe'
    if (-not (Test-Path -LiteralPath $git)) { $git = 'git' }
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    $allArgs = @('-C', $Config.repoPath, '-c', 'credential.helper=', '-c', ('safe.directory=' + $Config.repoPath)) + $GitArgs
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $git @allArgs 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    return [pscustomobject]@{ Code = $code; Out = @($out); Text = (@($out) -join "`n").Trim() }
}

function Get-GitValue($Config, [string[]]$GitArgs) {
    $r = Invoke-GateGit $Config $GitArgs
    if ($r.Code -ne 0) { throw ('git ' + ($GitArgs -join ' ') + ' failed: ' + $r.Text) }
    return $r.Text
}

function Test-GitAncestor($Config, [string]$Ancestor, [string]$Descendant) {
    $r = Invoke-GateGit $Config @('merge-base', '--is-ancestor', $Ancestor, $Descendant)
    return ($r.Code -eq 0)
}

function Get-StashCount($Config) {
    $r = Invoke-GateGit $Config @('stash', 'list')
    return @($r.Out | Where-Object { $_ -ne '' }).Count
}

function Get-DirtyEntries($Config) {
    $r = Invoke-GateGit $Config @('status', '--porcelain')
    if ($r.Code -ne 0) { throw ('git status failed: ' + $r.Text) }
    return @($r.Out | Where-Object { $_ -ne '' })
}

function Test-AiLockActive($Config, [string]$Ref) {
    $r = Invoke-GateGit $Config @('show', ($Ref + ':AI_ACTIVE_TASK.json'))
    if ($r.Code -ne 0 -or -not $r.Text) { return $false }
    try { return ([string]($r.Text | ConvertFrom-Json).status -eq 'active') } catch { return $false }
}

# ------------------------------------------------------------
# تصنيف التغييرات وبصمات ملفات الكتابة
# ------------------------------------------------------------
function ConvertTo-RepoRelative([string]$Path) { return ($Path -replace '\\', '/').TrimStart('/') }

function Get-ChangedFiles($Config, [string]$From, [string]$ToSha) {
    $text = Get-GitValue $Config @('diff', '--name-status', '--no-renames', $From, $ToSha)
    $files = @()
    foreach ($line in ($text -split "`n")) {
        if ($line -match '^([A-Z])\s+(.+)$') { $files += [pscustomobject]@{ status = $Matches[1]; path = (ConvertTo-RepoRelative $Matches[2].Trim()) } }
    }
    return $files
}

function Get-ChangeSummary($Config, $Files) {
    $writers = @($Config.writerScripts | ForEach-Object { ConvertTo-RepoRelative ([string]$_) })
    $paths = @($Files | ForEach-Object { $_.path })
    return [pscustomobject]@{
        ps1_changed            = [bool](@($paths | Where-Object { $_ -like '*.ps1' -or $_ -like '*.psm1' }).Count)
        sql_changed            = [bool](@($paths | Where-Object { $_ -like '*.sql' }).Count)
        mjs_changed            = [bool](@($paths | Where-Object { $_ -like '*.mjs' -or $_ -like '*.js' }).Count)
        writer_scripts_changed = @($paths | Where-Object { $writers -contains $_ })
    }
}

function Get-WriterDiskHashes($Config) {
    $hashes = [ordered]@{}
    foreach ($rel in $Config.writerScripts) {
        $relPath = ConvertTo-RepoRelative ([string]$rel)
        $full = Join-Path $Config.repoPath ($relPath -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (Test-Path -LiteralPath $full) { $hashes[$relPath] = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    return $hashes
}

function Save-WriterAllowlist($Config, $Paths, [string]$Sha) {
    $hashes = Get-WriterDiskHashes $Config
    Write-JsonFile $Paths.Allowlist ([pscustomobject]@{ sha = $Sha; updated_utc = (Get-Date).ToUniversalTime().ToString('o'); files = $hashes })
    return $hashes
}

# ------------------------------------------------------------
# موافقة المالك وCI — من GitHub مباشرة، مستقلاً عن الـworkflow
# ------------------------------------------------------------
function Get-ReleaseApproval($Config, [string]$Sha) {
    $list = @(Get-GitHubJson $Config ('deployments?environment=' + [uri]::EscapeDataString($Config.deploymentEnvironment) + '&sha=' + $Sha + '&per_page=20'))
    foreach ($dep in $list) {
        if ([string]$dep.sha -ne $Sha) { continue }
        if ($Config.deploymentCreator -and [string]$dep.creator.login -ne [string]$Config.deploymentCreator) { continue }
        $statuses = @(Get-GitHubJson $Config ('deployments/' + $dep.id + '/statuses?per_page=5'))
        if ($statuses.Count -gt 0 -and [string]$statuses[0].state -eq 'success') {
            $payload = $dep.payload
            if ($payload -is [string] -and $payload) { $payload = $payload | ConvertFrom-Json }
            # GitHub ينشئ Deployment تلقائياً لكل job يعلن environment (على github.sha
            # لا على الـSHA المطلوب) — لا يُقبل إلا ما يحمل بصمة الإصدار ونفس الـSHA.
            if (-not $payload -or [string]$payload.kind -ne 'ozk-windows-release' -or [string]$payload.sha -ne $Sha) { continue }
            return [pscustomobject]@{ ok = $true; id = $dep.id; approver = [string]$payload.approver; runId = [string]$payload.runId; payload = $payload }
        }
    }
    return [pscustomobject]@{ ok = $false; reason = 'no successful windows-production deployment for this SHA' }
}

function Get-CiVerdict($Config, [string]$Sha) {
    $results = [ordered]@{}
    $runs = @((Get-GitHubJson $Config ('actions/runs?head_sha=' + $Sha + '&per_page=100')).workflow_runs)
    foreach ($name in $Config.requiredMainWorkflows) {
        $match = @($runs | Where-Object { [string]$_.name -eq [string]$name } | Sort-Object { [datetime]$_.created_at } -Descending)
        if ($match.Count -eq 0) { $results[[string]$name] = 'missing' } else { $results[[string]$name] = ([string]$match[0].status + '/' + [string]$match[0].conclusion) }
    }
    $pulls = @(Get-GitHubJson $Config ('commits/' + $Sha + '/pulls'))
    $pr = @($pulls | Where-Object { [string]$_.merge_commit_sha -eq $Sha -and $_.merged_at }) | Select-Object -First 1
    if (-not $pr) { $results['pull_request'] = 'missing' }
    else {
        $results['pull_request'] = '#' + $pr.number
        $checks = @((Get-GitHubJson $Config ('commits/' + $pr.head.sha + '/check-runs?per_page=100')).check_runs)
        foreach ($name in $Config.requiredPrChecks) {
            $match = @($checks | Where-Object { [string]$_.name -eq [string]$name })
            if ($match.Count -eq 0) { $results['pr:' + $name] = 'missing' }
            elseif (@($match | Where-Object { [string]$_.conclusion -eq 'success' }).Count -gt 0) { $results['pr:' + $name] = 'completed/success' }
            else { $results['pr:' + $name] = ([string]$match[0].status + '/' + [string]$match[0].conclusion) }
        }
    }
    $bad = @($results.Keys | Where-Object { $_ -ne 'pull_request' -and $results[$_] -ne 'completed/success' })
    if ($results['pull_request'] -eq 'missing') { $bad += 'pull_request' }
    return [pscustomobject]@{ ok = ($bad.Count -eq 0); results = $results; failing = $bad }
}

# ------------------------------------------------------------
# الإيقاف المؤقت للمهام
# ------------------------------------------------------------
function Set-DeployFlag($Paths, [string]$Target) {
    Write-JsonFile $Paths.Flag ([pscustomobject]@{ since_utc = (Get-Date).ToUniversalTime().ToString('o'); target = $Target; pid = $PID })
}

function Clear-DeployFlag($Paths) {
    if (Test-Path -LiteralPath $Paths.Flag) { Remove-Item -LiteralPath $Paths.Flag -Force }
}

function Wait-TasksIdle($Config) {
    $deadline = (Get-Date).AddSeconds([int]$Config.drainTimeoutSeconds)
    while ($true) {
        $running = @(Get-RunningTaskNames @($Config.pauseTasks))
        if ($running.Count -eq 0) { return @() }
        if ((Get-Date) -ge $deadline) { return $running }
        Start-GateSleep 5
    }
}

# ------------------------------------------------------------
# المحرك
# ------------------------------------------------------------
function New-GateRecord($Config, [string]$GateMode) {
    $now = Get-Date
    return [ordered]@{
        ts_utc = $now.ToUniversalTime().ToString('o'); ts_local = $now.ToString('yyyy-MM-ddTHH:mm:ss')
        host = (Get-HostName); mode = $GateMode
        windows_ref = ('origin/' + $Config.windowsBranch)
        old_sha = $null; new_sha = $null; rollback_sha = $null
        deployment_id = $null; approver = $null; run_id = $null
        ci = $null; changed_files = @(); ps1_changed = $false; sql_changed = $false; mjs_changed = $false
        writer_scripts_changed = @(); writer_hashes_before = $null; writer_hashes_after = $null
        pause_ms = 0; stash_count_before = $null; stash_count_after = $null
        result = $null; reason = $null
    }
}

function Complete-Gate($Paths, $Record, [string]$Result, [string]$Reason, [bool]$Alert) {
    $Record.result = $Result
    $Record.reason = $Reason
    # NOOP (لا إصدار جديد) يُسجَّل في السجل التشغيلي فقط كي يبقى سجل التدقيق للقرارات الفعلية.
    if ($Result -ne 'NOOP') { Write-AuditRecord $Paths ([pscustomobject]$Record) }
    Write-GateLog $Paths ($Result + ': ' + $Reason)
    if ($Alert) { Send-GateAlert ('بوابة نشر Windows: ' + $Result + ' — ' + $Reason) ('deploy-gate-' + $Result.ToLowerInvariant()) }
    return [pscustomobject]$Record
}

function Invoke-DeployGate {
    param($Config, [string]$GateMode = 'Deploy', [string]$RollbackTo = '')

    $paths = Get-GatePaths $Config
    $record = New-GateRecord $Config $GateMode

    if ((Get-HostName) -ne [string]$Config.expectedHost) {
        return Complete-Gate $paths $record 'STOP' ('unexpected host: ' + (Get-HostName)) $true
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Config.repoPath '.git'))) {
        return Complete-Gate $paths $record 'STOP' 'repository not found' $true
    }

    $state = Read-JsonFile $paths.State
    $head = Get-GitValue $Config @('rev-parse', 'HEAD')
    $branch = Get-GitValue $Config @('rev-parse', '--abbrev-ref', 'HEAD')
    $record.old_sha = $head
    $record.stash_count_before = Get-StashCount $Config

    if ($GateMode -eq 'Initialize') {
        if ($state) { return Complete-Gate $paths $record 'STOP' 'already initialized' $false }
        if ($branch -ne [string]$Config.windowsBranch) { return Complete-Gate $paths $record 'STOP' ('expected branch ' + $Config.windowsBranch + ', found ' + $branch) $true }
        if (@(Get-DirtyEntries $Config).Count -gt 0) { return Complete-Gate $paths $record 'STOP' 'worktree not clean' $true }
        $fetch = Invoke-GateGit $Config @('fetch', 'origin', $Config.windowsBranch)
        if ($fetch.Code -ne 0) { return Complete-Gate $paths $record 'FAIL' ('fetch failed: ' + $fetch.Text) $true }
        $remote = Get-GitValue $Config @('rev-parse', ('origin/' + $Config.windowsBranch))
        if ($remote -ne $head) { return Complete-Gate $paths $record 'STOP' 'HEAD differs from origin/windows-production' $true }
        $record.writer_hashes_after = Save-WriterAllowlist $Config $paths $head
        Write-JsonFile $paths.State ([pscustomobject]@{ status = 'ok'; lastDeployedSha = $head; branch = $branch; pinnedSha = $null; rolledBackFrom = $null })
        $record.new_sha = $head
        return Complete-Gate $paths $record 'OK' 'initialized' $false
    }

    if (-not $state) { return Complete-Gate $paths $record 'STOP' 'gate not initialized (run -Mode Initialize)' $true }
    if ($branch -ne [string]$state.branch -or $branch -ne [string]$Config.windowsBranch) {
        return Complete-Gate $paths $record 'STOP' ('unexpected branch: ' + $branch) $true
    }

    if ($GateMode -eq 'Rollback') { return Invoke-GateRollback $Config $paths $record $state $head $RollbackTo }
    if ($GateMode -eq 'Unpin') { return Invoke-GateUnpin $Config $paths $record $state $head }

    if ([string]$state.status -eq 'ROLLED_BACK_PINNED') { return Complete-Gate $paths $record 'STOP' ('pinned after rollback at ' + $state.pinnedSha) $true }
    if ($head -ne [string]$state.lastDeployedSha) { return Complete-Gate $paths $record 'STOP' ('HEAD drift: expected ' + $state.lastDeployedSha + ', found ' + $head) $true }
    if (@(Get-DirtyEntries $Config).Count -gt 0) { return Complete-Gate $paths $record 'SKIP' 'uncommitted changes present' $true }

    $fetch = Invoke-GateGit $Config @('fetch', 'origin', $Config.windowsBranch, $Config.mainBranch)
    if ($fetch.Code -ne 0) { return Complete-Gate $paths $record 'FAIL' ('fetch failed: ' + $fetch.Text) $true }
    $target = Get-GitValue $Config @('rev-parse', ('origin/' + $Config.windowsBranch))
    $record.new_sha = $target
    $record.rollback_sha = $head
    if ($target -eq $head) { $record.new_sha = $head; return Complete-Gate $paths $record 'NOOP' 'up to date' $false }

    # الـcommits المحلية يلتقطها فحص الانحراف أعلاه (HEAD يساوي آخر SHA منشور). هنا:
    # الهدف يجب أن يحوي HEAD كاملاً (Fast-Forward)، وإلا فتاريخه أُعيدت كتابته.
    if (-not (Test-GitAncestor $Config $head $target)) { return Complete-Gate $paths $record 'STOP' 'target is not a fast-forward of HEAD' $true }
    $localAhead = [int](Get-GitValue $Config @('rev-list', '--count', ($target + '..HEAD')))
    if ($localAhead -gt 0) { return Complete-Gate $paths $record 'STOP' ('local commits present: ' + $localAhead) $true }
    if (-not (Test-GitAncestor $Config $target ('origin/' + $Config.mainBranch))) { return Complete-Gate $paths $record 'STOP' 'target is not on main' $true }
    if ((Test-AiLockActive $Config $target) -or (Test-AiLockActive $Config ('origin/' + $Config.mainBranch))) {
        return Complete-Gate $paths $record 'SKIP' 'active AI task lock' $true
    }

    $files = @(Get-ChangedFiles $Config $head $target)
    $summary = Get-ChangeSummary $Config $files
    $record.changed_files = @($files | ForEach-Object { $_.status + ' ' + $_.path })
    $record.ps1_changed = $summary.ps1_changed
    $record.sql_changed = $summary.sql_changed
    $record.mjs_changed = $summary.mjs_changed
    $record.writer_scripts_changed = $summary.writer_scripts_changed

    try {
        $approval = Get-ReleaseApproval $Config $target
        $ci = Get-CiVerdict $Config $target
    } catch {
        return Complete-Gate $paths $record 'FAIL' ('GitHub verification unavailable: ' + $_.Exception.Message) $true
    }
    $record.ci = $ci.results
    if (-not $ci.ok) { return Complete-Gate $paths $record 'STOP' ('CI not green: ' + ($ci.failing -join ', ')) $true }
    if (-not $approval.ok) { return Complete-Gate $paths $record 'STOP' $approval.reason $true }
    $record.deployment_id = $approval.id
    $record.approver = $approval.approver
    $record.run_id = $approval.runId

    if ($summary.writer_scripts_changed.Count -gt 0) {
        if (-not [bool]$approval.payload.writeScriptsApproved) {
            return Complete-Gate $paths $record 'STOP' ('writer scripts changed without writeScriptsApproved: ' + ($summary.writer_scripts_changed -join ', ')) $true
        }
        foreach ($f in @($files | Where-Object { $summary.writer_scripts_changed -contains $_.path })) {
            $approvedBlob = [string]$approval.payload.writerBlobs.($f.path)
            $actualBlob = 'deleted'
            if ($f.status -ne 'D') { $actualBlob = Get-GitValue $Config @('rev-parse', ($target + ':' + $f.path)) }
            if ($approvedBlob -ne $actualBlob) { return Complete-Gate $paths $record 'STOP' ('writer blob not approved: ' + $f.path) $true }
        }
    }

    $record.writer_hashes_before = Get-WriterDiskHashes $Config
    if ($GateMode -eq 'DryRun') { return Complete-Gate $paths $record 'DRYRUN' 'all checks passed; no change made' $false }

    # الإيقاف المؤقت ثم التبديل
    $started = Get-Date
    Set-DeployFlag $paths $target
    $stillRunning = @(Wait-TasksIdle $Config)
    if ($stillRunning.Count -gt 0) {
        Clear-DeployFlag $paths
        return Complete-Gate $paths $record 'SKIP' ('tasks still running: ' + ($stillRunning -join ', ')) $true
    }
    $merge = Invoke-GateGit $Config @('merge', '--ff-only', $target)
    $record.pause_ms = [int]((Get-Date) - $started).TotalMilliseconds
    $newHead = Get-GitValue $Config @('rev-parse', 'HEAD')
    $dirtyAfter = @(Get-DirtyEntries $Config)
    $record.stash_count_after = Get-StashCount $Config

    if ($merge.Code -ne 0 -or $newHead -ne $target) {
        $consistent = ($dirtyAfter.Count -eq 0 -and ($newHead -eq $head -or $newHead -eq $target))
        if ($consistent) {
            if ($newHead -eq $target) { Write-JsonFile $paths.State ([pscustomobject]@{ status = 'ok'; lastDeployedSha = $target; branch = $branch; pinnedSha = $null; rolledBackFrom = $null }) }
            Clear-DeployFlag $paths
            return Complete-Gate $paths $record 'FAIL' ('ff-merge failed, tree consistent: ' + $merge.Text) $true
        }
        # غير متسق: تبقى العلامة (القرّاء يعودون بعد انتهاء عمرها، والكتّاب متوقفون)
        return Complete-Gate $paths $record 'FAIL' ('ff-merge failed, tree INCONSISTENT; deploy flag kept: ' + $merge.Text) $true
    }
    if ($dirtyAfter.Count -gt 0 -or $record.stash_count_after -ne $record.stash_count_before) {
        return Complete-Gate $paths $record 'FAIL' 'post-update verification failed (dirty tree or stash change); deploy flag kept' $true
    }

    $record.writer_hashes_after = Save-WriterAllowlist $Config $paths $target
    Write-JsonFile $paths.State ([pscustomobject]@{ status = 'ok'; lastDeployedSha = $target; branch = $branch; pinnedSha = $null; rolledBackFrom = $null })
    Clear-DeployFlag $paths
    $result = Complete-Gate $paths $record 'OK' ('deployed ' + $head.Substring(0, 7) + ' -> ' + $target.Substring(0, 7)) $false
    Send-GateAlert ('نُشر إصدار Windows: ' + $head.Substring(0, 7) + ' → ' + $target.Substring(0, 7) + ' (ملفات: ' + $files.Count + '، PS1: ' + $summary.ps1_changed + '، SQL: ' + $summary.sql_changed + '، كتّاب: ' + $summary.writer_scripts_changed.Count + ')') ('deploy-gate-ok-' + $target)
    return $result
}

function Invoke-GateRollback($Config, $Paths, $Record, $State, [string]$Head, [string]$RollbackTo) {
    if ([string]::IsNullOrWhiteSpace($RollbackTo)) { return Complete-Gate $Paths $Record 'STOP' 'rollback requires -To <sha>' $false }
    $resolved = Invoke-GateGit $Config @('rev-parse', '--verify', '--quiet', ($RollbackTo + '^{commit}'))
    if ($resolved.Code -ne 0 -or -not $resolved.Text) { return Complete-Gate $Paths $Record 'STOP' ('unknown rollback target: ' + $RollbackTo) $true }
    $toSha = $resolved.Text
    $known = $false
    if (Test-Path -LiteralPath $Paths.Audit) {
        foreach ($line in [System.IO.File]::ReadAllLines($Paths.Audit)) {
            if (-not $line) { continue }
            $entry = $line | ConvertFrom-Json
            if ([string]$entry.result -eq 'OK' -and [string]$entry.mode -eq 'Deploy' -and [string]$entry.old_sha -eq $toSha) { $known = $true }
        }
    }
    if (-not $known) { return Complete-Gate $Paths $Record 'STOP' 'rollback target is not a previously deployed SHA in the audit log' $true }
    if (-not (Test-GitAncestor $Config $toSha $Head)) { return Complete-Gate $Paths $Record 'STOP' 'rollback target is not an ancestor of HEAD' $true }
    if (@(Get-DirtyEntries $Config).Count -gt 0) { return Complete-Gate $Paths $Record 'STOP' 'worktree not clean' $true }

    $Record.new_sha = $toSha
    $Record.rollback_sha = $Head
    $started = Get-Date
    Set-DeployFlag $Paths $toSha
    $stillRunning = @(Wait-TasksIdle $Config)
    if ($stillRunning.Count -gt 0) { Clear-DeployFlag $Paths; return Complete-Gate $Paths $Record 'SKIP' ('tasks still running: ' + ($stillRunning -join ', ')) $true }
    $Record.writer_hashes_before = Get-WriterDiskHashes $Config
    # reset --keep يرفض إن كان سيُضيع تعديلاً محلياً — ليس --hard
    $reset = Invoke-GateGit $Config @('reset', '--keep', $toSha)
    $Record.pause_ms = [int]((Get-Date) - $started).TotalMilliseconds
    $newHead = Get-GitValue $Config @('rev-parse', 'HEAD')
    $Record.stash_count_after = Get-StashCount $Config
    if ($reset.Code -ne 0 -or $newHead -ne $toSha) { return Complete-Gate $Paths $Record 'FAIL' ('rollback failed; deploy flag kept: ' + $reset.Text) $true }
    $Record.writer_hashes_after = Save-WriterAllowlist $Config $Paths $toSha
    Write-JsonFile $Paths.State ([pscustomobject]@{ status = 'ROLLED_BACK_PINNED'; lastDeployedSha = $toSha; branch = $State.branch; pinnedSha = $toSha; rolledBackFrom = $Head })
    Clear-DeployFlag $Paths
    return Complete-Gate $Paths $Record 'OK' ('rolled back ' + $Head.Substring(0, 7) + ' -> ' + $toSha.Substring(0, 7) + '; pinned') $true
}

function Invoke-GateUnpin($Config, $Paths, $Record, $State, [string]$Head) {
    if ([string]$State.status -ne 'ROLLED_BACK_PINNED') { return Complete-Gate $Paths $Record 'STOP' 'not pinned' $false }
    if ($Head -ne [string]$State.pinnedSha) { return Complete-Gate $Paths $Record 'STOP' 'HEAD differs from pinned SHA' $true }
    $fetch = Invoke-GateGit $Config @('fetch', 'origin', $Config.windowsBranch)
    if ($fetch.Code -ne 0) { return Complete-Gate $Paths $Record 'FAIL' ('fetch failed: ' + $fetch.Text) $true }
    $remote = Get-GitValue $Config @('rev-parse', ('origin/' + $Config.windowsBranch))
    if ($remote -eq [string]$State.rolledBackFrom) {
        return Complete-Gate $Paths $Record 'STOP' 'windows-production still points at the rolled-back release; publish a fixed release first' $true
    }
    Write-JsonFile $Paths.State ([pscustomobject]@{ status = 'ok'; lastDeployedSha = $Head; branch = $State.branch; pinnedSha = $null; rolledBackFrom = $null })
    $Record.new_sha = $Head
    return Complete-Gate $Paths $Record 'OK' 'unpinned' $false
}

# ------------------------------------------------------------
# التشغيل (لا شيء عند dot-source في الاختبارات)
# ------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    $script:GateConfigPath = $ConfigPath
    $config = Get-GateConfig $ConfigPath
    $paths = Get-GatePaths $config
    $lock = $null
    try {
        $lock = [System.IO.File]::Open($paths.Lock, 'OpenOrCreate', 'ReadWrite', 'None')
    } catch {
        Write-Host 'deploy gate already running'
        exit 0
    }
    try {
        $outcome = Invoke-DeployGate -Config $config -GateMode $Mode -RollbackTo $To
        Write-Host ($outcome.result + ': ' + $outcome.reason)
        if ($outcome.result -eq 'FAIL') { exit 1 }
        exit 0
    } catch {
        $msg = 'deploy gate crashed: ' + $_.Exception.Message
        try { Write-GateLog $paths ('FAIL: ' + $msg) } catch { Write-Host $msg }
        Send-GateAlert ('بوابة نشر Windows: ' + $msg) 'deploy-gate-crash'
        exit 1
    } finally {
        if ($lock) { $lock.Close() }
    }
}
