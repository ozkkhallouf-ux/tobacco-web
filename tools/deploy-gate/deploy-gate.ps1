#Requires -Version 5.1
# ============================================================
# deploy-gate.ps1 — بوابة نشر Windows (نسخة مرجعية)
#
# النسخة المعتمدة تعيش في C:\ProgramData\OZK-TOBACCO\DeployGate\ (كتابة لـ
# هوية البوابة المخصّصة فقط) ولا تُستدعى من المستودع أبداً. هذا الملف في
# المستودع للمراجعة والاختبار فقط: الدمج إلى main لا يغيّر البوابة المثبّتة.
# تعمل بهوية مخصّصة (trust.gateAccount) لا تشغّل أي كود من أي مستودع.
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
#   -Mode AckRestart -Components <أسماء>   تسجيل أن المالك أعاد تشغيل عملية طويلة يدوياً
#
# البوابة لا تعيد تشغيل أي مهمة ولا توقف أي عملية أبداً: إصدار يمسّ ملفات عملية
# طويلة (longRunningComponents) يُسجَّل DEPLOYED_PENDING_RESTART مع تنبيه يسمّيها.
# ============================================================
[CmdletBinding()]
param(
    [ValidateSet('Deploy', 'DryRun', 'Initialize', 'Rollback', 'Unpin', 'AckRestart')]
    [string]$Mode = 'Deploy',
    [string]$To = '',
    [string[]]$Components = @(),
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
        Transition = Join-Path $Config.gateDir 'deploy-transition.json'
    }
}

# ------------------------------------------------------------
# انتقال Deploy (Codex P1): Initialize لا يسمح بـDeploy. Deploy يتطلب انتقالاً منفصلاً مثبتاً بعد
# DryRun كامل لـ24 ساعة على الأقل. الإثبات من ملف الثقة deploy-transition.json (يكتبه الانتقال
# المنفصل في المرحلة التالية، بموافقة المالك) ومن سجل التدقيق نفسه: تشغيلات DryRun ناجحة ومتصلة
# تغطي النافذة كلها، بلا أي نتيجة أخرى داخلها. مرور الوقت وحده لا يكفي. أي نقص ⇒ STOP (fail-closed).
# هذا الـPR لا ينشئ الملف ولا ينفّذ الانتقال.
# ------------------------------------------------------------
# وقت UTC من JSON: PowerShell 7 يحوّل نصوص ISO إلى DateTime تلقائياً و5.1 يتركها نصاً. $null إن تعذّر.
function ConvertTo-GateUtc($Value) {
    if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
    $d = [datetime]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal
    if ([datetime]::TryParse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$d)) { return $d }
    return $null
}

function Test-DeployTransition($Config, $Paths) {
    if (-not (Test-Path -LiteralPath $Paths.Transition)) { return 'deploy transition not established: Deploy requires a completed FULL 24-hour DryRun soak recorded by the separate transition step (deploy-transition.json)' }
    try { $t = [System.IO.File]::ReadAllText($Paths.Transition) | ConvertFrom-Json } catch { return 'deploy-transition.json cannot be read' }
    if ([string]$t.kind -ne 'ozk-deploy-transition') { return 'deploy-transition.json has an unexpected kind' }
    if (-not ([string]$t.approvedBy).Trim()) { return 'deploy transition has no recorded owner approval' }
    $hours = 24
    $gap = 30
    if ($Config.PSObject.Properties['dryRunSoak'] -and $Config.dryRunSoak) {
        if ($Config.dryRunSoak.hours) { $hours = [Math]::Max(24, [double]$Config.dryRunSoak.hours) }
        if ($Config.dryRunSoak.maxGapMinutes) { $gap = [double]$Config.dryRunSoak.maxGapMinutes }
    }
    $start = ConvertTo-GateUtc $t.soakStartUtc
    $end = ConvertTo-GateUtc $t.soakEndUtc
    if ($null -eq $start -or $null -eq $end) { return 'deploy transition soak window cannot be parsed' }
    if ($end -gt (Get-Date).ToUniversalTime()) { return 'deploy transition soak window ends in the future' }
    if (($end - $start).TotalHours -lt $hours) { return ('DryRun soak shorter than ' + $hours + ' hours: ' + [Math]::Round(($end - $start).TotalHours, 2)) }
    if (-not (Test-Path -LiteralPath $Paths.Audit)) { return 'no audit log to prove the DryRun soak' }
    $records = @()
    foreach ($line in [System.IO.File]::ReadAllLines($Paths.Audit)) {
        if (-not $line.Trim()) { continue }
        try { $rec = $line | ConvertFrom-Json } catch { return 'audit log cannot be parsed; DryRun soak not provable' }
        $ts = ConvertTo-GateUtc $rec.ts_utc
        if ($null -eq $ts) { return 'audit record without a parsable timestamp; DryRun soak not provable' }
        $records += [pscustomobject]@{ ts = $ts; mode = [string]$rec.mode; result = [string]$rec.result }
    }
    $init = @($records | Where-Object { $_.mode -eq 'Initialize' -and $_.result -eq 'OK' })
    if ($init.Count -eq 0 -or $init[0].ts -gt $start) { return 'DryRun soak must start after a successful Initialize' }
    $window = @($records | Where-Object { $_.ts -ge $start -and $_.ts -le $end } | Sort-Object ts)
    $bad = @($window | Where-Object { -not ($_.mode -eq 'DryRun' -and ($_.result -eq 'DRYRUN' -or $_.result -eq 'NOOP')) })
    if ($bad.Count -gt 0) { return ('DryRun soak window contains ' + $bad.Count + ' non-successful or non-DryRun gate run(s) (first: ' + $bad[0].mode + ' ' + $bad[0].result + ')') }
    if ($window.Count -eq 0) { return 'no successful DryRun runs inside the soak window' }
    $prev = $start
    foreach ($w in @($window) + @([pscustomobject]@{ ts = $end })) {
        if (($w.ts - $prev).TotalMinutes -gt $gap) { return ('DryRun soak has a gap of ' + [Math]::Round(($w.ts - $prev).TotalMinutes) + ' minutes (max ' + $gap + ') at ' + $prev.ToString('o')) }
        $prev = $w.ts
    }
    return $null
}

function Write-GateLog($Paths, [string]$Message) {
    $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
    [System.IO.File]::AppendAllText($Paths.Log, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-AuditRecord($Paths, $Record) {
    $line = $Record | ConvertTo-Json -Depth 10 -Compress
    [System.IO.File]::AppendAllText($Paths.Audit, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# فحص ما قبل التحويل (Codex P1 #5): مهام تحتاج main يجب أن تعمل من worktree مخصّص قبل تحويل
# المستودع التشغيلي. -Mode Initialize يرفض التسجيل ما لم ينجح.
. (Join-Path $PSScriptRoot 'migration-preflight.ps1')

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

# كشف قدرة الكتابة إلى الأمين (دفاع إضافي متحفّظ، نفس قواعد windows-release-verify.mjs).
# ليس بديلاً عن فصل صلاحيات SQL: كل السكربتات اليوم تتصل بحساب يملك الكتابة.
function Test-InWriteScanScope($Config, [string]$Path) {
    $p = ConvertTo-RepoRelative $Path
    if ($p -notmatch [string]$Config.writeScan.include) { return $false }
    foreach ($rx in @($Config.writeScan.exclude)) { if ($p -match [string]$rx) { return $false } }
    return $true
}

function Get-WriteIndicators($Config, [string]$Content) {
    return @(@($Config.writeScan.patterns) | Where-Object { $Content -match [string]$_ })
}

# الملفات القادرة على الكتابة في الشجرة الحالية على القرص (تدخل قائمة البصمات المحمية).
function Get-WriteCapableTrackedFiles($Config) {
    $found = @()
    foreach ($rel in @((Invoke-GateGit $Config @('ls-files')).Out)) {
        if (-not $rel -or -not (Test-InWriteScanScope $Config $rel)) { continue }
        $full = Join-Path $Config.repoPath ((ConvertTo-RepoRelative $rel) -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $full)) { continue }
        if (@(Get-WriteIndicators $Config ([System.IO.File]::ReadAllText($full))).Count -gt 0) { $found += (ConvertTo-RepoRelative $rel) }
    }
    return $found
}

# الملفات المتغيّرة القادرة على الكتابة في الهدف. تعذّر قراءة الملف = يُعامَل كاتباً (fail-closed).
function Get-WriteCapableChanged($Config, $Files, [string]$Target) {
    $detected = @()
    foreach ($f in @($Files | Where-Object { $_.status -ne 'D' -and (Test-InWriteScanScope $Config $_.path) })) {
        $show = Invoke-GateGit $Config @('show', ($Target + ':' + $f.path))
        if ($show.Code -ne 0 -or @(Get-WriteIndicators $Config $show.Text).Count -gt 0) { $detected += $f.path }
    }
    return $detected
}

# العمليات الطويلة التي يمسّ الإصدار ملفاتها — تبقى تشغّل الكود القديم حتى إعادة تشغيل يدوية.
function Get-AffectedLongRunning($Config, [string[]]$ChangedPaths) {
    $names = @()
    foreach ($c in @($Config.longRunningComponents)) {
        foreach ($f in @($c.files)) {
            if ($ChangedPaths -contains (ConvertTo-RepoRelative ([string]$f))) { $names += [string]$c.name; break }
        }
    }
    return $names
}

function Save-GateState($Paths, [string]$LastDeployedSha, [string]$Branch, [string]$PinnedSha, [string]$RolledBackFrom, [string[]]$PendingRestart) {
    $pending = @(@($PendingRestart) | Where-Object { $_ } | Select-Object -Unique)
    $status = 'ok'
    if ($PinnedSha) { $status = 'ROLLED_BACK_PINNED' } elseif ($pending.Count -gt 0) { $status = 'DEPLOYED_PENDING_RESTART' }
    $pinned = $null; if ($PinnedSha) { $pinned = $PinnedSha }
    $from = $null; if ($RolledBackFrom) { $from = $RolledBackFrom }
    Write-JsonFile $Paths.State ([pscustomobject]@{ status = $status; lastDeployedSha = $LastDeployedSha; branch = $Branch; pinnedSha = $pinned; rolledBackFrom = $from; pendingRestart = $pending })
}

function Get-StatePending($State) { return @(@($State.pendingRestart) | Where-Object { $_ }) }

function Get-WriterDiskHashes($Config) {
    $hashes = [ordered]@{}
    $all = @(@($Config.writerScripts | ForEach-Object { ConvertTo-RepoRelative ([string]$_) }) + @(Get-WriteCapableTrackedFiles $Config) | Select-Object -Unique)
    foreach ($relPath in $all) {
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

# أحدث تشغيل بالاسم هو الحَكَم وحده (Codex P1): نجاح قديم لا يغطّي إعادة تشغيل أحدث فشلت أو
# أُلغيت أو انتهت مهلتها أو ما زالت جارية. الترتيب: وقت البدء/الإنشاء ثم المعرّف.
# وقت فارغ (queued/in_progress بلا started_at من GitHub) = أحدث، وإلا يفوز النجاح القديم.
function Get-NewestVerdict($Items, [string]$Name, [string]$TimeField) {
    $newest = @($Items | Where-Object { [string]$_.name -eq $Name } |
        Sort-Object -Property @{
            Expression = {
                $t = [string]$_.$TimeField
                if ([string]::IsNullOrWhiteSpace($t)) { '9999-12-31T23:59:59Z' } else { $t }
            }
            Descending = $true
        }, @{ Expression = { [long]$_.id }; Descending = $true }) | Select-Object -First 1
    if (-not $newest) { return 'missing' }
    return ([string]$newest.status + '/' + [string]$newest.conclusion)
}

# هل محتوى ملف الكتابة (blob — بصمة المحتوى نفسه) معتمد صراحةً في أي إصدار ناجح؟ الجهاز قد
# يلحق عدة إصدارات معتمدة دفعة واحدة، وحمولة كل إصدار تغطي تغييراته هو فقط منذ الإصدار
# السابق؛ فيُقبل الـblob إن اعتمده الإصدار الهدف أو أي إصدار سابق بموافقة كتابة صريحة.
function Test-WriterBlobApproved($Config, $Approval, [string]$Path, [string]$Blob) {
    if ([bool]$Approval.payload.writeScriptsApproved -and [string]$Approval.payload.writerBlobs.$Path -eq $Blob) { return $true }
    $list = @(Get-GitHubJson $Config ('deployments?environment=' + [uri]::EscapeDataString($Config.deploymentEnvironment) + '&per_page=100'))
    foreach ($dep in $list) {
        if ($Config.deploymentCreator -and [string]$dep.creator.login -ne [string]$Config.deploymentCreator) { continue }
        $payload = $dep.payload
        if ($payload -is [string] -and $payload) { $payload = $payload | ConvertFrom-Json }
        if (-not $payload -or [string]$payload.kind -ne 'ozk-windows-release' -or [string]$payload.sha -ne [string]$dep.sha) { continue }
        if (-not [bool]$payload.writeScriptsApproved -or [string]$payload.writerBlobs.$Path -ne $Blob) { continue }
        $statuses = @(Get-GitHubJson $Config ('deployments/' + $dep.id + '/statuses?per_page=5'))
        if ($statuses.Count -gt 0 -and [string]$statuses[0].state -eq 'success') { return $true }
    }
    return $false
}

function Get-CiVerdict($Config, [string]$Sha) {
    $results = [ordered]@{}
    $runs = @((Get-GitHubJson $Config ('actions/runs?head_sha=' + $Sha + '&per_page=100')).workflow_runs)
    foreach ($name in $Config.requiredMainWorkflows) { $results[[string]$name] = Get-NewestVerdict $runs ([string]$name) 'created_at' }
    $pulls = @(Get-GitHubJson $Config ('commits/' + $Sha + '/pulls'))
    $pr = @($pulls | Where-Object { [string]$_.merge_commit_sha -eq $Sha -and $_.merged_at }) | Select-Object -First 1
    if (-not $pr) { $results['pull_request'] = 'missing' }
    else {
        $results['pull_request'] = '#' + $pr.number
        $checks = @((Get-GitHubJson $Config ('commits/' + $pr.head.sha + '/check-runs?per_page=100')).check_runs)
        foreach ($name in $Config.requiredPrChecks) { $results['pr:' + $name] = Get-NewestVerdict $checks ([string]$name) 'started_at' }
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
        writer_scripts_changed = @(); write_capable_detected = @(); writer_hashes_before = $null; writer_hashes_after = $null
        pending_restart = @(); preflight = @()
        pause_ms = 0; stash_count_before = $null; stash_count_after = $null
        result = $null; reason = $null
    }
}

function Complete-Gate($Paths, $Record, [string]$Result, [string]$Reason, [bool]$Alert) {
    $Record.result = $Result
    $Record.reason = $Reason
    # NOOP (لا إصدار جديد) يُسجَّل في السجل التشغيلي فقط كي يبقى سجل التدقيق للقرارات الفعلية،
    # إلا في DryRun: كل تشغيل DryRun (ومنه NOOP) يُدقَّق لأنه دليل اكتمال نافذة الـ24 ساعة.
    if ($Result -ne 'NOOP' -or $Record.mode -eq 'DryRun') { Write-AuditRecord $Paths ([pscustomobject]$Record) }
    Write-GateLog $Paths ($Result + ': ' + $Reason)
    if ($Alert) { Send-GateAlert ('بوابة نشر Windows: ' + $Result + ' — ' + $Reason) ('deploy-gate-' + $Result.ToLowerInvariant()) }
    return [pscustomobject]$Record
}

# تدقيق كل عنصر مُجرَد: نوع الـprincipal، والـSID، وRunLevel، والتصنيف، والنتيجة (بلا أسرار).
function Format-PreflightWorkloads($Pre) {
    return @(@($Pre.workloads) | Where-Object { $_ } | ForEach-Object { $_.kind + ' ' + $_.name + ' | principal=' + $_.principalType + ' sid=' + $_.sid + ' runLevel=' + $_.runLevel + ' | workload=' + $_.workload + ' | ' + $_.decision })
}

function Invoke-DeployGate {
    param($Config, [string]$GateMode = 'Deploy', [string]$RollbackTo = '', [string[]]$AckComponents = @())

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
        $pre = Invoke-InstallPreflight $Config
        $record.preflight = @($pre.results | ForEach-Object { $_.verdict + ' ' + $_.task + ': ' + $_.reason })
        $record['preflight_workloads'] = Format-PreflightWorkloads $pre
        if (-not $pre.ok) {
            return Complete-Gate $paths $record 'STOP' ('migration preflight blocked: ' + (@($pre.results | Where-Object { $_.verdict -ne 'PASS' -and $_.verdict -ne 'OUT_OF_SCOPE_DISABLED' } | ForEach-Object { $_.task + ' (' + $_.reason + ')' }) -join '; ')) $true
        }
        if ($branch -ne [string]$Config.windowsBranch) { return Complete-Gate $paths $record 'STOP' ('expected branch ' + $Config.windowsBranch + ', found ' + $branch) $true }
        if (@(Get-DirtyEntries $Config).Count -gt 0) { return Complete-Gate $paths $record 'STOP' 'worktree not clean' $true }
        $fetch = Invoke-GateGit $Config @('fetch', 'origin', $Config.windowsBranch)
        if ($fetch.Code -ne 0) { return Complete-Gate $paths $record 'FAIL' ('fetch failed: ' + $fetch.Text) $true }
        $remote = Get-GitValue $Config @('rev-parse', ('origin/' + $Config.windowsBranch))
        if ($remote -ne $head) { return Complete-Gate $paths $record 'STOP' 'HEAD differs from origin/windows-production' $true }
        $record.writer_hashes_after = Save-WriterAllowlist $Config $paths $head
        Save-GateState $paths $head $branch '' '' @()
        $record.new_sha = $head
        return Complete-Gate $paths $record 'OK' 'initialized' $false
    }

    if (-not $state) { return Complete-Gate $paths $record 'STOP' 'gate not initialized (run -Mode Initialize)' $true }
    if ($branch -ne [string]$state.branch -or $branch -ne [string]$Config.windowsBranch) {
        return Complete-Gate $paths $record 'STOP' ('unexpected branch: ' + $branch) $true
    }

    if ($GateMode -eq 'Rollback') { return Invoke-GateRollback $Config $paths $record $state $head $RollbackTo }
    if ($GateMode -eq 'Unpin') { return Invoke-GateUnpin $Config $paths $record $state $head }
    if ($GateMode -eq 'AckRestart') { return Invoke-GateAckRestart $paths $record $state $head $AckComponents }
    if ($GateMode -eq 'Deploy') {
        $notReady = Test-DeployTransition $Config $paths
        if ($notReady) { return Complete-Gate $paths $record 'STOP' ('deploy not permitted: ' + $notReady) $true }
    }

    if ([string]$state.status -eq 'ROLLED_BACK_PINNED') { return Complete-Gate $paths $record 'STOP' ('pinned after rollback at ' + $state.pinnedSha) $true }
    if ($head -ne [string]$state.lastDeployedSha) { return Complete-Gate $paths $record 'STOP' ('HEAD drift: expected ' + $state.lastDeployedSha + ', found ' + $head) $true }
    if (@(Get-DirtyEntries $Config).Count -gt 0) { return Complete-Gate $paths $record 'SKIP' 'uncommitted changes present' $true }

    $fetch = Invoke-GateGit $Config @('fetch', 'origin', $Config.windowsBranch, $Config.mainBranch)
    if ($fetch.Code -ne 0) { return Complete-Gate $paths $record 'FAIL' ('fetch failed: ' + $fetch.Text) $true }
    $target = Get-GitValue $Config @('rev-parse', ('origin/' + $Config.windowsBranch))
    $record.new_sha = $target
    $record.rollback_sha = $head
    if ($target -eq $head) {
        $record.new_sha = $head
        $stillPending = @(Get-StatePending $state)
        if ($stillPending.Count -gt 0) {
            Send-GateAlert ('تذكير: عمليات Windows طويلة ما زالت تشغّل كوداً قديماً وتحتاج إعادة تشغيل يدوية بموافقة: ' + ($stillPending -join '، ')) 'deploy-gate-pending-restart'
            return Complete-Gate $paths $record 'NOOP' ('up to date; pending restart: ' + ($stillPending -join ', ')) $false
        }
        return Complete-Gate $paths $record 'NOOP' 'up to date' $false
    }

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
    $detected = @(Get-WriteCapableChanged $Config $files $target)
    $writerChanged = @(@($summary.writer_scripts_changed) + $detected | Where-Object { $_ } | Select-Object -Unique)
    $record.write_capable_detected = $detected
    $record.writer_scripts_changed = $writerChanged
    $affected = @(Get-AffectedLongRunning $Config @($files | ForEach-Object { $_.path }))
    $record.pending_restart = @(@(Get-StatePending $state) + $affected | Select-Object -Unique)

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

    if ($writerChanged.Count -gt 0) {
        $unapproved = @()
        try {
            foreach ($f in @($files | Where-Object { $writerChanged -contains $_.path })) {
                $actualBlob = 'deleted'
                if ($f.status -ne 'D') { $actualBlob = Get-GitValue $Config @('rev-parse', ($target + ':' + $f.path)) }
                if (-not (Test-WriterBlobApproved $Config $approval $f.path $actualBlob)) { $unapproved += $f.path }
            }
        } catch {
            return Complete-Gate $paths $record 'FAIL' ('GitHub verification unavailable: ' + $_.Exception.Message) $true
        }
        if ($unapproved.Count -gt 0) {
            return Complete-Gate $paths $record 'STOP' ('writer scripts changed without writeScriptsApproved: ' + ($unapproved -join ', ')) $true
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
            if ($newHead -eq $target) { Save-GateState $paths $target $branch '' '' $record.pending_restart }
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
    Save-GateState $paths $target $branch '' '' $record.pending_restart
    Clear-DeployFlag $paths
    if (@($record.pending_restart).Count -gt 0) {
        # الملفات نُشرت، لكن الإصدار ليس مطبَّقاً بالكامل: لا إعادة تشغيل تلقائية ولا إيقاف عمليات.
        return Complete-Gate $paths $record 'DEPLOYED_PENDING_RESTART' ('deployed ' + $head.Substring(0, 7) + ' -> ' + $target.Substring(0, 7) + '; manual restart (owner approval) required for: ' + (@($record.pending_restart) -join ', ')) $true
    }
    $result = Complete-Gate $paths $record 'OK' ('deployed ' + $head.Substring(0, 7) + ' -> ' + $target.Substring(0, 7)) $false
    Send-GateAlert ('نُشر إصدار Windows: ' + $head.Substring(0, 7) + ' → ' + $target.Substring(0, 7) + ' (ملفات: ' + $files.Count + '، PS1: ' + $summary.ps1_changed + '، SQL: ' + $summary.sql_changed + '، كتّاب: ' + $summary.writer_scripts_changed.Count + ')') ('deploy-gate-ok-' + $target)
    return $result
}

function Invoke-GateRollback($Config, $Paths, $Record, $State, [string]$Head, [string]$RollbackTo) {
    if ([string]::IsNullOrWhiteSpace($RollbackTo)) { return Complete-Gate $Paths $Record 'STOP' 'rollback requires -To <sha>' $false }
    $resolved = Invoke-GateGit $Config @('rev-parse', '--verify', '--quiet', ($RollbackTo + '^{commit}'))
    if ($resolved.Code -ne 0 -or -not $resolved.Text) { return Complete-Gate $Paths $Record 'STOP' ('unknown rollback target: ' + $RollbackTo) $true }
    $toSha = $resolved.Text
    # الهدف يجب أن يكون الإصدار السابق لنشر ناجح مسجَّل (Codex P1 #6): OK أو
    # DEPLOYED_PENDING_RESTART (الملفات نُشرت فعلاً وعملية طويلة لم يُعَد تشغيلها بعد).
    # STOP/SKIP/FAIL/DRYRUN أو أي نتيجة غير معروفة أو سطر تالف = لا يُحتسب (fail-closed).
    $known = $false
    $deployedResults = @('OK', 'DEPLOYED_PENDING_RESTART')
    if (Test-Path -LiteralPath $Paths.Audit) {
        foreach ($line in [System.IO.File]::ReadAllLines($Paths.Audit)) {
            if (-not $line) { continue }
            try { $entry = $line | ConvertFrom-Json } catch { continue }
            if (-not $entry) { continue }
            if ($deployedResults -ccontains [string]$entry.result -and [string]$entry.mode -ceq 'Deploy' -and [string]$entry.old_sha -eq $toSha) { $known = $true }
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
    $changedBack = @(Get-ChangedFiles $Config $toSha $Head | ForEach-Object { $_.path })
    $Record.changed_files = $changedBack
    $Record.pending_restart = @(@(Get-StatePending $State) + @(Get-AffectedLongRunning $Config $changedBack) | Select-Object -Unique)
    Save-GateState $Paths $toSha $State.branch $toSha $Head $Record.pending_restart
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
    Save-GateState $Paths $Head $State.branch '' '' @(Get-StatePending $State)
    $Record.new_sha = $Head
    $Record.pending_restart = @(Get-StatePending $State)
    return Complete-Gate $Paths $Record 'OK' 'unpinned' $false
}

# تسجيل يدوي بعد أن يعيد المالك تشغيل عملية طويلة بنفسه. لا يمسّ أي مهمة ولا عملية.
function Invoke-GateAckRestart($Paths, $Record, $State, [string]$Head, [string[]]$Names) {
    $pending = @(Get-StatePending $State)
    $names = @(@($Names) | Where-Object { $_ })
    if ($names.Count -eq 0) { return Complete-Gate $Paths $Record 'STOP' 'AckRestart requires -Components' $false }
    $unknown = @($names | Where-Object { $pending -notcontains $_ })
    if ($unknown.Count -gt 0) { return Complete-Gate $Paths $Record 'STOP' ('not pending restart: ' + ($unknown -join ', ')) $false }
    $remaining = @($pending | Where-Object { $names -notcontains $_ })
    Save-GateState $Paths ([string]$State.lastDeployedSha) ([string]$State.branch) ([string]$State.pinnedSha) ([string]$State.rolledBackFrom) $remaining
    $Record.new_sha = $Head
    $Record.pending_restart = $remaining
    return Complete-Gate $Paths $Record 'OK' ('restart acknowledged: ' + ($names -join ', ')) $false
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
        $outcome = Invoke-DeployGate -Config $config -GateMode $Mode -RollbackTo $To -AckComponents $Components
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
