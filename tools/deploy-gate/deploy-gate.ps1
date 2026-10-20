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
#   -Mode AckRestart -Components <أسماء>   تسجيل أن المالك أعاد تشغيل عملية طويلة يدوياً
#   -Mode Recover     استعادة الملفات من نسخة ما قبل النشر بعد تبديل انقطع في منتصفه
#                     (HEAD لم يتقدّم والشجرة متّسخة). بلا أي أمر git كاتب.
#
# البوابة لا تعيد تشغيل أي مهمة ولا توقف أي عملية أبداً: إصدار يمسّ ملفات عملية
# طويلة (longRunningComponents) يُسجَّل DEPLOYED_PENDING_RESTART مع تنبيه يسمّيها.
#
# حمايات تدقيق 2026-10-20:
#   - deviceBaselineSha: لا هدف لا يحوي ما يشغّله الجهاز فعلاً (لا رجوع بإصدار أقدم)،
#     وInitialize يرفض فرعاً متأخراً عن الجهاز بدل التبديل إليه.
#   - مهمة غير مرئية لحساب البوابة = STOP (شغّلها كـSYSTEM). مهمة غير موجَّهة عبر
#     run-repo-task.ps1 = STOP في Deploy، ومهمة معفاة يقترب موعدها = SKIP.
#   - إصدار يحذف سكربتاً تشغّله مهمة = STOP.
#   - نسخة احتياطية مع SHA256 لكل ملف متغيّر قبل أي تبديل، ثم تحقق من كل ملف بعده،
#     وinflight.json يمنع أي نشر جديد بعد انقطاع حتى -Mode Recover.
#   - قفل حصري للبوابة، وفحص عملية git جارية (index.lock وغيره) قبل التبديل.
# ============================================================
[CmdletBinding()]
param(
    [ValidateSet('Deploy', 'DryRun', 'Initialize', 'Rollback', 'Unpin', 'AckRestart', 'Recover')]
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
    $baseline = [string]$cfg.deviceBaselineSha
    if ($baseline -and $baseline -notmatch '^[0-9a-f]{40}$') { throw 'gate config: deviceBaselineSha must be a full 40-character SHA' }
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
        Inflight  = Join-Path $Config.gateDir 'inflight.json'
        Backups   = Join-Path $Config.gateDir 'backups'
    }
}

# قفل حصري: نسختان من البوابة (مهمة + تشغيل يدوي، أو وكيلان) لا تعملان معاً أبداً.
# المقبض يبقى مفتوحاً حتى نهاية العملية؛ يُغلق تلقائياً إن انتهت العملية بأي شكل.
function Enter-GateLock($Paths) {
    try { $stream = [System.IO.File]::Open($Paths.Lock, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { return $null }
    try {
        $info = [System.Text.Encoding]::UTF8.GetBytes(('pid=' + $PID + ' since=' + (Get-Date).ToUniversalTime().ToString('o')))
        $stream.SetLength(0); $stream.Write($info, 0, $info.Length); $stream.Flush()
    } catch { Write-Verbose 'lock owner info not written' }
    return $stream
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

# تعريف المهام كما يراه حساب البوابة: الظهور، الحالة، الموعد التالي، ونص الـAction.
# مهمة لا يراها الحساب (مثل Read Worker لـOZKSync) تُعاد visible=$false ولا تُعدّ «متوقفة».
function Get-GateTaskInfo($Config, [string[]]$TaskNames) {
    $out = @()
    foreach ($name in @($TaskNames | Where-Object { $_ } | Select-Object -Unique)) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) { $out += [pscustomobject]@{ name = $name; visible = $false; state = ''; nextRunUtc = $null; actionText = '' }; continue }
        $next = $null
        try {
            $info = $task | Get-ScheduledTaskInfo -ErrorAction Stop
            if ($info.NextRunTime) { $next = ([datetime]$info.NextRunTime).ToUniversalTime() }
        } catch { Write-Verbose ('no schedule info: ' + $name) }
        $action = (@($task.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments + ' ' + [string]$_.WorkingDirectory }) -join "`n")
        $out += [pscustomobject]@{ name = $name; visible = $true; state = [string]$task.State; nextRunUtc = $next; actionText = $action }
    }
    return $out
}

# عملية git جارية في المستودع (وكيل آخر، أو دمج/rebase عالق) = لا تبديل الآن.
function Get-GitOperationMarkers($Config) {
    $gitDir = Join-Path $Config.repoPath '.git'
    return @(@('index.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply') | Where-Object { Test-Path -LiteralPath (Join-Path $gitDir $_) })
}

# التراجع نفسه — نقطة تماس كي تحاكي الاختبارات انقطاعه في منتصفه.
function Invoke-GateReset($Config, [string]$Target) {
    return Invoke-GateGit $Config @('reset', '--keep', $Target)
}

# التبديل نفسه — نقطة تماس كي تحاكي الاختبارات انقطاعاً في منتصفه.
function Invoke-GateMerge($Config, [string]$Target) {
    return Invoke-GateGit $Config @('merge', '--ff-only', $Target)
}

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

# ------------------------------------------------------------
# حارس المهام (تدقيق 2026-10-20: الثغرات e وf، وسكربت مهمة محذوف)
# ------------------------------------------------------------
function Get-GateTaskNames($Config) {
    $names = @($Config.pauseTasks) + @($Config.longRunningComponents | ForEach-Object { $_.taskName })
    return @($names | Where-Object { $_ } | ForEach-Object { [string]$_ } | Select-Object -Unique)
}

# السكربتات داخل المستودع التي تشغّلها المهمة (مسار مطلق في الـAction أو غلافه، أو -Script نسبي
# عبر run-repo-task.ps1)، بمسارها النسبي بحالة أحرفها الأصلية (git يميّز حالة الأحرف).
function Get-TaskRepoScripts($Config, [string]$ActionText) {
    $repoKey = ConvertTo-PreflightPath $Config.repoPath
    $rels = @()
    foreach ($ref in @(Get-TaskScriptReferences $ActionText)) {
        $n = ([string]$ref -replace '/', '\').TrimEnd('\')
        if ($n.ToLowerInvariant().StartsWith($repoKey + '\')) { $rels += ($n.Substring($repoKey.Length + 1) -replace '\\', '/') }
    }
    foreach ($m in [regex]::Matches([string]$ActionText, '-Script\s+"?([^"\s]+)')) { $rels += (([string]$m.Groups[1].Value -replace '\\', '/').TrimStart('/')) }
    return @($rels | Select-Object -Unique)
}

function Test-TaskRouted($Config, [string]$ActionText) {
    $launcher = ConvertTo-PreflightPath (Join-Path $Config.gateDir 'run-repo-task.ps1')
    return [bool](@(Get-TaskScriptReferences $ActionText | Where-Object { (ConvertTo-PreflightPath $_) -eq $launcher }).Count)
}

# حكم ساكن على المهام: غير مرئية، غير موجَّهة، أو معفاة/غير موجَّهة يقترب موعدها.
function Get-TaskGuard($Config, $Infos, [datetime]$NowUtc) {
    $exempt = @($Config.routingExempt | ForEach-Object { [string]$_ })
    $pause = @($Config.pauseTasks | ForEach-Object { [string]$_ })
    $guardSeconds = 120
    if ($null -ne $Config.startGuardSeconds) { $guardSeconds = [int]$Config.startGuardSeconds }
    $g = [ordered]@{ invisible = @(); unrouted = @(); imminent = @(); scripts = [ordered]@{} }
    foreach ($i in @($Infos)) {
        if (-not $i.visible) { $g.invisible += [string]$i.name; continue }
        if ([string]$i.state -eq 'Disabled') { continue }
        $g.scripts[[string]$i.name] = @(Get-TaskRepoScripts $Config ([string]$i.actionText))
        if ($pause -notcontains [string]$i.name) { continue }
        $routed = Test-TaskRouted $Config ([string]$i.actionText)
        if (-not $routed -and $exempt -notcontains [string]$i.name) { $g.unrouted += [string]$i.name }
        if (-not $routed -and $i.nextRunUtc) {
            $delta = (([datetime]$i.nextRunUtc) - $NowUtc).TotalSeconds
            if ($delta -ge -5 -and $delta -le $guardSeconds) { $g.imminent += ([string]$i.name + ' in ' + [int]$delta + 's') }
        }
    }
    return [pscustomobject]$g
}

# سكربت تشغّله مهمة ولا يوجد في الهدف: موجود في HEAD = الإصدار يكسر المهمة (STOP)،
# ومفقود في HEAD أصلاً = عطل سابق لا يسبّبه الإصدار (تحذير مسجَّل، مثل Invoice Watcher).
function Get-TaskScriptFindings($Config, $Guard, [string]$Head, [string]$Target) {
    $broken = @(); $preexisting = @()
    foreach ($task in @($Guard.scripts.Keys)) {
        foreach ($rel in @($Guard.scripts[$task])) {
            if ((Invoke-GateGit $Config @('cat-file', '-e', ($Target + ':' + $rel))).Code -eq 0) { continue }
            if ((Invoke-GateGit $Config @('cat-file', '-e', ($Head + ':' + $rel))).Code -eq 0) { $broken += ($task + ': ' + $rel) }
            else { $preexisting += ($task + ': ' + $rel) }
        }
    }
    return [pscustomobject]@{ broken = $broken; preexisting = $preexisting }
}

# ------------------------------------------------------------
# النسخة الاحتياطية والتحقق بعد التبديل
# ------------------------------------------------------------
function Get-FileSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Get-RepoFullPath($Config, [string]$Rel) { return (Join-Path $Config.repoPath ((ConvertTo-RepoRelative $Rel) -replace '/', [IO.Path]::DirectorySeparatorChar)) }

# نسخة من كل ملف سيتغيّر، كما هو على القرص، مع SHA256 قبل، والـblob المتوقَّع بعد.
# تُنشأ وتُتحقَّق قبل أي تعديل على المستودع؛ أي فشل هنا = لا تبديل إطلاقاً.
function New-DeployBackup($Config, $Paths, [string]$From, [string]$To, $Files) {
    $id = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + $From.Substring(0, 7) + '-' + $To.Substring(0, 7)
    $dir = Join-Path $Paths.Backups $id
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'files') | Out-Null
    $entries = @()
    foreach ($f in @($Files)) {
        $full = Get-RepoFullPath $Config $f.path
        $existed = Test-Path -LiteralPath $full -PathType Leaf
        $pre = $null
        if ($existed) {
            $pre = Get-FileSha256 $full
            $copy = Join-Path (Join-Path $dir 'files') (($f.path) -replace '/', [IO.Path]::DirectorySeparatorChar)
            $copyDir = Split-Path -Parent $copy
            if (-not (Test-Path -LiteralPath $copyDir)) { New-Item -ItemType Directory -Force -Path $copyDir | Out-Null }
            Copy-Item -LiteralPath $full -Destination $copy -Force
            if ((Get-FileSha256 $copy) -ne $pre) { throw ('backup copy does not match the original: ' + $f.path) }
        }
        $blob = 'deleted'
        if ($f.status -ne 'D') { $blob = Get-GitValue $Config @('rev-parse', ($To + ':' + $f.path)) }
        $entries += [pscustomobject]@{ path = $f.path; status = $f.status; existed = [bool]$existed; preSha256 = $pre; targetBlob = $blob; postSha256 = $null }
    }
    $manifest = [pscustomobject]@{ id = $id; from = $From; to = $To; created_utc = (Get-Date).ToUniversalTime().ToString('o'); files = $entries }
    Write-JsonFile (Join-Path $dir 'manifest.json') $manifest
    return [pscustomobject]@{ dir = $dir; manifest = $manifest }
}

# بعد التبديل: كل ملف متغيّر يطابق blob الهدف (بفلاتر git نفسها)، والمحذوف غير موجود.
function Test-DeployedFiles($Config, $Manifest) {
    $bad = @()
    foreach ($e in @($Manifest.files)) {
        $full = Get-RepoFullPath $Config $e.path
        if ([string]$e.targetBlob -eq 'deleted') {
            if (Test-Path -LiteralPath $full) { $bad += ($e.path + ' (should be deleted)') }
            continue
        }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $bad += ($e.path + ' (missing)'); continue }
        $actual = Invoke-GateGit $Config @('hash-object', '--', $e.path)
        if ($actual.Code -ne 0 -or $actual.Text -ne [string]$e.targetBlob) { $bad += ($e.path + ' (content differs from target)'); continue }
        $e.postSha256 = Get-FileSha256 $full
    }
    return $bad
}

# سجل العملية الجارية: يُكتب قبل أي أمر git يغيّر الشجرة، ويُزال فقط بعد تحقق كامل.
function Write-InflightRecord($Paths, [string]$Mode, [string]$From, [string]$To, [string]$BackupDir, [string]$Branch, [string[]]$Pending) {
    Write-JsonFile $Paths.Inflight ([pscustomobject]@{
        schema = 1; mode = $Mode; from = $From; to = $To; backupDir = $BackupDir; branch = $Branch
        pendingRestart = @(@($Pending) | Where-Object { $_ }); started_utc = (Get-Date).ToUniversalTime().ToString('o')
    })
}

# قراءة inflight.json والتحقق منه بلا تخمين: أي حقل مفقود أو تالف، أو نسخة خارج مجلد
# backups، أو manifest لا يطابق السجل = $null مع السبب (Recover يتوقف ولا يلمس شيئاً).
function Read-InflightRecord($Config, $Paths) {
    $r = [pscustomobject]@{ ok = $false; reason = ''; record = $null; manifest = $null }
    try { $raw = [System.IO.File]::ReadAllText($Paths.Inflight) } catch { $r.reason = 'inflight.json unreadable'; return $r }
    try { $rec = $raw | ConvertFrom-Json } catch { $r.reason = 'inflight.json is not valid JSON'; return $r }
    if (-not $rec) { $r.reason = 'inflight.json is empty'; return $r }
    if (@('Deploy', 'Rollback') -cnotcontains [string]$rec.mode) { $r.reason = ('inflight.json has an unknown mode: ' + [string]$rec.mode); return $r }
    foreach ($k in 'from', 'to') { if ([string]$rec.$k -notmatch '^[0-9a-f]{40}$') { $r.reason = ('inflight.json has an invalid ' + $k); return $r } }
    $dir = [string]$rec.backupDir
    $root = [System.IO.Path]::GetFullPath($Paths.Backups).TrimEnd('\', '/')
    if (-not $dir) { $r.reason = 'inflight.json has no backupDir'; return $r }
    $full = [System.IO.Path]::GetFullPath($dir).TrimEnd('\', '/')
    if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { $r.reason = 'inflight.json backupDir is outside the gate backups folder'; return $r }
    try { $man = Read-JsonFile (Join-Path $full 'manifest.json') } catch { $man = $null }
    if (-not $man) { $r.reason = 'backup manifest missing or unreadable'; return $r }
    if ([string]$man.from -ne [string]$rec.from -or [string]$man.to -ne [string]$rec.to) { $r.reason = 'backup manifest does not match inflight.json'; return $r }
    $r.ok = $true; $r.record = $rec; $r.manifest = $man
    return $r
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
        tasks_unrouted = @(); tasks_invisible = @(); warnings = @(); live_served_changed = @()
        backup_dir = $null; post_verify = $null
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

    $baseline = [string]$Config.deviceBaselineSha

    if ($GateMode -eq 'Initialize') {
        if ($state) { return Complete-Gate $paths $record 'STOP' 'already initialized' $false }
        $pre = Invoke-MigrationPreflight $Config
        $record.preflight = @($pre.results | ForEach-Object { $_.verdict + ' ' + $_.task + ': ' + $_.reason })
        if (-not $pre.ok) {
            return Complete-Gate $paths $record 'STOP' ('migration preflight blocked: ' + (@($pre.results | Where-Object { $_.verdict -ne 'PASS' } | ForEach-Object { $_.task + ' (' + $_.reason + ')' }) -join '; ')) $true
        }
        $invisible = @(Get-GateTaskInfo $Config (Get-GateTaskNames $Config) | Where-Object { -not $_.visible } | ForEach-Object { $_.name })
        if ($invisible.Count -gt 0) { return Complete-Gate $paths $record 'STOP' ('tasks not visible to the gate account (run as SYSTEM): ' + ($invisible -join ', ')) $true }
        # الجلب يحدّث مراجع origin فقط، ولا يمسّ الشجرة. نقارن الجهاز بالفرع قبل أي حكم آخر:
        # فرع متأخر عن الجهاز يعني أن التبديل إليه رجوع صامت بالإنتاج إلى الوراء.
        $fetch = Invoke-GateGit $Config @('fetch', 'origin', $Config.windowsBranch)
        if ($fetch.Code -ne 0) { return Complete-Gate $paths $record 'FAIL' ('fetch failed: ' + $fetch.Text) $true }
        $remote = Get-GitValue $Config @('rev-parse', ('origin/' + $Config.windowsBranch))
        if ($baseline -and -not (Test-GitAncestor $Config $baseline $head)) {
            return Complete-Gate $paths $record 'STOP' ('device HEAD ' + $head.Substring(0, 7) + ' does not contain deviceBaselineSha ' + $baseline.Substring(0, 7) + ' (configuration does not describe this device)') $true
        }
        if ($remote -ne $head) {
            if (Test-GitAncestor $Config $remote $head) {
                $behind = [int](Get-GitValue $Config @('rev-list', '--count', ($remote + '..' + $head)))
                return Complete-Gate $paths $record 'STOP' ($Config.windowsBranch + ' (' + $remote.Substring(0, 7) + ') is behind the device (' + $head.Substring(0, 7) + ') by ' + $behind + ' commits; switching would roll production back. Publish a release that contains HEAD first.') $true
            }
            if (Test-GitAncestor $Config $head $remote) {
                return Complete-Gate $paths $record 'STOP' ('device (' + $head.Substring(0, 7) + ') is behind ' + $Config.windowsBranch + ' (' + $remote.Substring(0, 7) + '); initialize only where HEAD equals the published release') $true
            }
            return Complete-Gate $paths $record 'STOP' ('device HEAD and ' + $Config.windowsBranch + ' have diverged; manual review required') $true
        }
        if ($branch -ne [string]$Config.windowsBranch) { return Complete-Gate $paths $record 'STOP' ('expected branch ' + $Config.windowsBranch + ', found ' + $branch) $true }
        if (@(Get-DirtyEntries $Config).Count -gt 0) { return Complete-Gate $paths $record 'STOP' 'worktree not clean' $true }
        $record.writer_hashes_after = Save-WriterAllowlist $Config $paths $head
        Save-GateState $paths $head $branch '' '' @()
        $record.new_sha = $head
        return Complete-Gate $paths $record 'OK' 'initialized' $false
    }

    if (-not $state) { return Complete-Gate $paths $record 'STOP' 'gate not initialized (run -Mode Initialize)' $true }
    if ($branch -ne [string]$state.branch -or $branch -ne [string]$Config.windowsBranch) {
        return Complete-Gate $paths $record 'STOP' ('unexpected branch: ' + $branch) $true
    }

    if ($GateMode -eq 'Recover') { return Invoke-GateRecover $Config $paths $record $head }
    # تبديل سابق انقطع ولم يُستعَد بعد: لا نشر ولا رجوع فوق شجرة غير مؤكَّدة.
    if (Test-Path -LiteralPath $paths.Inflight) { return Complete-Gate $paths $record 'STOP' 'a previous switch was interrupted (inflight.json present); run -Mode Recover first' $true }

    if ($GateMode -eq 'Rollback') { return Invoke-GateRollback $Config $paths $record $state $head $RollbackTo }
    if ($GateMode -eq 'Unpin') { return Invoke-GateUnpin $Config $paths $record $state $head }
    if ($GateMode -eq 'AckRestart') { return Invoke-GateAckRestart $paths $record $state $head $AckComponents }

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
    # لا إصدار أقدم مما يشغّله الجهاز فعلاً، ولو كان Fast-Forward من الفرع (تدقيق 2026-10-20).
    if ($baseline -and -not (Test-GitAncestor $Config $baseline $target)) {
        return Complete-Gate $paths $record 'STOP' ('target ' + $target.Substring(0, 7) + ' does not contain deviceBaselineSha ' + $baseline.Substring(0, 7) + ': it is older than what the device runs') $true
    }
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

    # المهام (الثغرات e وf): غير مرئية = STOP دائماً؛ غير موجَّهة = STOP في Deploy وتحذير في DryRun.
    # وإصدار يحذف سكربتاً تشغّله مهمة = STOP.
    $guard = Get-TaskGuard $Config @(Get-GateTaskInfo $Config (Get-GateTaskNames $Config)) ((Get-Date).ToUniversalTime())
    $record.tasks_invisible = @($guard.invisible)
    $record.tasks_unrouted = @($guard.unrouted)
    if (@($guard.invisible).Count -gt 0) { return Complete-Gate $paths $record 'STOP' ('tasks not visible to the gate account (run as SYSTEM): ' + (@($guard.invisible) -join ', ')) $true }
    $scriptFindings = Get-TaskScriptFindings $Config $guard $head $target
    if (@($scriptFindings.broken).Count -gt 0) { return Complete-Gate $paths $record 'STOP' ('release removes scripts that scheduled tasks run: ' + (@($scriptFindings.broken) -join '; ')) $true }
    foreach ($p in @($scriptFindings.preexisting)) { $record.warnings += ('task points at a script missing from the repository (pre-existing): ' + $p) }
    $liveRoots = @($Config.liveServedFromRepo.paths | ForEach-Object { [string]$_ })
    $record.live_served_changed = @($files | Where-Object { $p = $_.path; @($liveRoots | Where-Object { $p -eq $_ -or ($_.EndsWith('/') -and $p.StartsWith($_)) }).Count -gt 0 } | ForEach-Object { $_.path })
    if (@($guard.unrouted).Count -gt 0) {
        if ($GateMode -eq 'Deploy') { return Complete-Gate $paths $record 'STOP' ('tasks not routed through run-repo-task.ps1 (they would ignore deploying.flag): ' + (@($guard.unrouted) -join ', ')) $true }
        $record.warnings += ('Deploy would STOP: tasks not routed through run-repo-task.ps1: ' + (@($guard.unrouted) -join ', '))
    }

    $record.writer_hashes_before = Get-WriterDiskHashes $Config
    if ($GateMode -eq 'DryRun') {
        $note = 'all checks passed; no change made'
        if (@($record.warnings).Count -gt 0) { $note = 'checks evaluated; no change made; warnings: ' + (@($record.warnings) -join ' | ') }
        return Complete-Gate $paths $record 'DRYRUN' $note $false
    }

    # نسخة احتياطية + SHA256 قبل أي مساس بالمستودع. أي فشل هنا = لا تبديل.
    try { $backup = New-DeployBackup $Config $paths $head $target $files }
    catch { return Complete-Gate $paths $record 'FAIL' ('backup failed before any change: ' + $_.Exception.Message) $true }
    $record.backup_dir = $backup.dir

    # الإيقاف المؤقت ثم إعادة التحقق ثم التبديل
    $started = Get-Date
    Set-DeployFlag $paths $target
    $stillRunning = @(Wait-TasksIdle $Config)
    if ($stillRunning.Count -gt 0) {
        Clear-DeployFlag $paths
        return Complete-Gate $paths $record 'SKIP' ('tasks still running: ' + ($stillRunning -join ', ')) $true
    }
    # الشروط قد تتغيّر أثناء الانتظار: نعيد فحصها قبل التبديل مباشرة (لا TOCTOU).
    $late = Get-TaskGuard $Config @(Get-GateTaskInfo $Config (Get-GateTaskNames $Config)) ((Get-Date).ToUniversalTime())
    $reasons = @()
    if (@($late.invisible).Count -gt 0) { $reasons += ('tasks became invisible: ' + (@($late.invisible) -join ', ')) }
    if (@($late.imminent).Count -gt 0) { $reasons += ('unrouted tasks about to start: ' + (@($late.imminent) -join ', ')) }
    $markers = @(Get-GitOperationMarkers $Config)
    if ($markers.Count -gt 0) { $reasons += ('git operation in progress: ' + ($markers -join ', ')) }
    if ((Get-GitValue $Config @('rev-parse', 'HEAD')) -ne $head) { $reasons += 'HEAD moved during the pause' }
    if (@(Get-DirtyEntries $Config).Count -gt 0) { $reasons += 'worktree changed during the pause' }
    if ($reasons.Count -gt 0) {
        Clear-DeployFlag $paths
        return Complete-Gate $paths $record 'SKIP' ('not switching: ' + ($reasons -join '; ')) $true
    }

    Write-InflightRecord $paths 'Deploy' $head $target $backup.dir $branch @($record.pending_restart)
    $merge = Invoke-GateMerge $Config $target
    $record.pause_ms = [int]((Get-Date) - $started).TotalMilliseconds
    $newHead = Get-GitValue $Config @('rev-parse', 'HEAD')
    $dirtyAfter = @(Get-DirtyEntries $Config)
    $record.stash_count_after = Get-StashCount $Config

    if ($merge.Code -ne 0 -or $newHead -ne $target) {
        $consistent = ($dirtyAfter.Count -eq 0 -and ($newHead -eq $head -or $newHead -eq $target))
        if ($consistent) {
            if ($newHead -eq $target) { Save-GateState $paths $target $branch '' '' $record.pending_restart }
            Remove-Item -LiteralPath $paths.Inflight -Force
            Clear-DeployFlag $paths
            return Complete-Gate $paths $record 'FAIL' ('ff-merge failed, tree consistent: ' + $merge.Text) $true
        }
        # غير متسق: تبقى العلامة وinflight.json (القرّاء يعودون بعد انتهاء عمرها، والكتّاب متوقفون).
        return Complete-Gate $paths $record 'FAIL' ('ff-merge failed, tree INCONSISTENT; deploy flag kept; run -Mode Recover (backup ' + $backup.dir + '): ' + $merge.Text) $true
    }
    if ($dirtyAfter.Count -gt 0 -or $record.stash_count_after -ne $record.stash_count_before) {
        return Complete-Gate $paths $record 'FAIL' 'post-update verification failed (dirty tree or stash change); deploy flag kept' $true
    }
    $badFiles = @(Test-DeployedFiles $Config $backup.manifest)
    $record.post_verify = if ($badFiles.Count -eq 0) { 'ok' } else { $badFiles }
    Write-JsonFile (Join-Path $backup.dir 'manifest.json') $backup.manifest
    if ($badFiles.Count -gt 0) {
        return Complete-Gate $paths $record 'FAIL' ('post-deploy file verification failed; deploy flag kept: ' + ($badFiles -join '; ')) $true
    }
    Remove-Item -LiteralPath $paths.Inflight -Force

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
    $markers = @(Get-GitOperationMarkers $Config)
    if ($markers.Count -gt 0) { return Complete-Gate $Paths $Record 'STOP' ('git operation in progress: ' + ($markers -join ', ')) $true }
    try { $backup = New-DeployBackup $Config $Paths $Head $toSha @(Get-ChangedFiles $Config $Head $toSha) }
    catch { return Complete-Gate $Paths $Record 'FAIL' ('backup failed before any change: ' + $_.Exception.Message) $true }
    $Record.backup_dir = $backup.dir
    $started = Get-Date
    Set-DeployFlag $Paths $toSha
    $stillRunning = @(Wait-TasksIdle $Config)
    if ($stillRunning.Count -gt 0) { Clear-DeployFlag $Paths; return Complete-Gate $Paths $Record 'SKIP' ('tasks still running: ' + ($stillRunning -join ', ')) $true }
    $Record.writer_hashes_before = Get-WriterDiskHashes $Config
    # Codex P1 (#337): يُسجَّل التراجع في inflight.json قبل reset --keep، فانقطاعه في منتصفه
    # (HEAD بقي والشجرة متّسخة، أو HEAD تحرّك قبل التحقق) يُستعاد بـ-Mode Recover لا بالتخمين.
    # pendingRestart وbranch محفوظان لإكمال التثبيت (ROLLED_BACK_PINNED) من Recover إن لزم.
    $changedBack = @(Get-ChangedFiles $Config $toSha $Head | ForEach-Object { $_.path })
    $pendingAfter = @(@(Get-StatePending $State) + @(Get-AffectedLongRunning $Config $changedBack) | Select-Object -Unique)
    Write-InflightRecord $Paths 'Rollback' $Head $toSha $backup.dir ([string]$State.branch) $pendingAfter
    # reset --keep يرفض إن كان سيُضيع تعديلاً محلياً — ليس --hard
    $reset = Invoke-GateReset $Config $toSha
    $Record.pause_ms = [int]((Get-Date) - $started).TotalMilliseconds
    $newHead = Get-GitValue $Config @('rev-parse', 'HEAD')
    $Record.stash_count_after = Get-StashCount $Config
    if ($reset.Code -ne 0 -or $newHead -ne $toSha) {
        if ($newHead -eq $Head -and @(Get-DirtyEntries $Config).Count -eq 0) {
            # رفض نظيف من git (لم يُكتب شيء): لا شيء يُستعاد.
            Remove-Item -LiteralPath $Paths.Inflight -Force
            Clear-DeployFlag $Paths
            return Complete-Gate $Paths $Record 'FAIL' ('rollback refused, tree unchanged: ' + $reset.Text) $true
        }
        return Complete-Gate $Paths $Record 'FAIL' ('rollback interrupted; deploy flag and inflight.json kept; run -Mode Recover (backup ' + $backup.dir + '): ' + $reset.Text) $true
    }
    $badFiles = @(Test-DeployedFiles $Config $backup.manifest)
    $Record.post_verify = if ($badFiles.Count -eq 0) { 'ok' } else { $badFiles }
    Write-JsonFile (Join-Path $backup.dir 'manifest.json') $backup.manifest
    if ($badFiles.Count -gt 0) { return Complete-Gate $Paths $Record 'FAIL' ('rollback file verification failed; deploy flag kept: ' + ($badFiles -join '; ')) $true }
    $Record.changed_files = $changedBack
    $Record.pending_restart = $pendingAfter
    $Record.writer_hashes_after = Complete-RollbackState $Config $Paths $Head $toSha ([string]$State.branch) $pendingAfter
    return Complete-Gate $Paths $Record 'OK' ('rolled back ' + $Head.Substring(0, 7) + ' -> ' + $toSha.Substring(0, 7) + '; pinned') $true
}

# الخطوة الأخيرة المشتركة بين التراجع الناجح وإكماله من Recover: بصمات الكتّاب، التثبيت،
# ثم إزالة inflight والعلم — بهذا الترتيب، كي لا تُزال علامة الانقطاع قبل تسجيل الحالة.
function Complete-RollbackState($Config, $Paths, [string]$From, [string]$To, [string]$Branch, [string[]]$Pending) {
    $hashes = Save-WriterAllowlist $Config $Paths $To
    Save-GateState $Paths $To $Branch $To $From $Pending
    if (Test-Path -LiteralPath $Paths.Inflight) { Remove-Item -LiteralPath $Paths.Inflight -Force }
    Clear-DeployFlag $Paths
    return $hashes
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

# استعادة بعد نشر أو تراجع انقطع في منتصفه (inflight.json قائم). القرار من السجل وحده، بلا تخمين:
#   HEAD = from (لم يتقدّم): يُعاد كل ملف من النسخة الاحتياطية مع التحقق من SHA256، والملفات التي
#     أضافها التبديل الناقص تُنقل إلى quarantine داخل النسخة (لا حذف)، ثم شجرة نظيفة شرط.
#   HEAD = to في تراجع (Rollback): reset --keep حرّك HEAD ثم انقطع قبل التحقق. يُكمَل التراجع
#     فقط إن طابق كل ملف blob الهدف والشجرة نظيفة؛ وإلا مراجعة يدوية.
#   أي حالة أخرى، أو inflight.json مفقود/تالف/لا يطابق النسخة = STOP بلا أي مساس.
# لا أمر git كاتب إطلاقاً. وبعد استعادة ناجحة يُنقل السجل إلى النسخة نفسها، فتكرار Recover لا يفعل شيئاً.
function Invoke-GateRecover($Config, $Paths, $Record, [string]$Head) {
    if (-not (Test-Path -LiteralPath $Paths.Inflight)) {
        $dirty = @(Get-DirtyEntries $Config)
        if ((Test-Path -LiteralPath $Paths.Flag) -or $dirty.Count -gt 0) {
            return Complete-Gate $Paths $Record 'STOP' 'inflight.json is missing but the deploy flag or uncommitted changes are present; refusing to guess the state. Manual review required.' $true
        }
        return Complete-Gate $Paths $Record 'NOOP' 'nothing to recover (no inflight.json, no deploy flag, tree clean)' $false
    }
    $read = Read-InflightRecord $Config $Paths
    if (-not $read.ok) { return Complete-Gate $Paths $Record 'STOP' ($read.reason + '; nothing changed. Manual review required.') $true }
    $inflight = $read.record
    $manifest = $read.manifest
    $backupDir = [string]$inflight.backupDir
    $Record.backup_dir = $backupDir
    $Record.old_sha = $Head

    if ($Head -eq [string]$inflight.to -and [string]$inflight.mode -ceq 'Rollback') {
        $dirty = @(Get-DirtyEntries $Config)
        $bad = @(Test-DeployedFiles $Config $manifest)
        if ($dirty.Count -gt 0 -or $bad.Count -gt 0) {
            return Complete-Gate $Paths $Record 'STOP' ('rollback moved HEAD but the tree does not match the target (' + ((@($dirty) + @($bad)) -join '; ') + '); nothing changed. Manual review required.') $true
        }
        Write-JsonFile (Join-Path $backupDir 'manifest.json') $manifest
        Move-Item -LiteralPath $Paths.Inflight -Destination (Join-Path $backupDir 'inflight.recovered.json') -Force
        [void](Complete-RollbackState $Config $Paths ([string]$inflight.from) ([string]$inflight.to) ([string]$inflight.branch) @($inflight.pendingRestart))
        $Record.new_sha = $Head
        $Record.pending_restart = @($inflight.pendingRestart)
        return Complete-Gate $Paths $Record 'RECOVERED' ('interrupted rollback completed: HEAD ' + $Head.Substring(0, 7) + ' verified against the backup manifest; pinned') $true
    }
    if ($Head -ne [string]$inflight.from) {
        return Complete-Gate $Paths $Record 'STOP' ('HEAD is ' + $Head.Substring(0, 7) + ', neither the pre-switch ' + ([string]$inflight.from).Substring(0, 7) + ' nor a completed rollback; nothing changed. Manual review required.') $true
    }

    # HEAD لم يتقدّم: تحقق كل نسخة احتياطية أولاً، ثم الاستعادة (لا استعادة جزئية من نسخة ناقصة).
    foreach ($e in @($manifest.files | Where-Object { [bool]$_.existed })) {
        $copy = Join-Path (Join-Path $backupDir 'files') (([string]$e.path) -replace '/', [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path -LiteralPath $copy) -or (Get-FileSha256 $copy) -ne [string]$e.preSha256) { return Complete-Gate $Paths $Record 'STOP' ('backup copy missing or altered: ' + $e.path + '; nothing changed. Manual review required.') $true }
    }
    $quarantine = Join-Path $backupDir 'quarantine'
    $restored = 0; $moved = 0
    foreach ($e in @($manifest.files)) {
        $full = Get-RepoFullPath $Config $e.path
        if ([bool]$e.existed) {
            if ((Test-Path -LiteralPath $full -PathType Leaf) -and (Get-FileSha256 $full) -eq [string]$e.preSha256) { continue }
            $copy = Join-Path (Join-Path $backupDir 'files') (([string]$e.path) -replace '/', [IO.Path]::DirectorySeparatorChar)
            $dir = Split-Path -Parent $full
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            Copy-Item -LiteralPath $copy -Destination $full -Force
            if ((Get-FileSha256 $full) -ne [string]$e.preSha256) { return Complete-Gate $Paths $Record 'FAIL' ('restore verification failed: ' + $e.path) $true }
            $restored++
        } elseif (Test-Path -LiteralPath $full) {
            $dest = Join-Path $quarantine (([string]$e.path) -replace '/', [IO.Path]::DirectorySeparatorChar)
            $dir = Split-Path -Parent $dest
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
            Move-Item -LiteralPath $full -Destination $dest -Force
            $moved++
        }
    }
    $dirty = @(Get-DirtyEntries $Config)
    if ($dirty.Count -gt 0) { return Complete-Gate $Paths $Record 'FAIL' ('tree still not clean after restore; deploy flag kept: ' + ($dirty -join ', ')) $true }
    Move-Item -LiteralPath $Paths.Inflight -Destination (Join-Path $backupDir 'inflight.recovered.json') -Force
    Clear-DeployFlag $Paths
    $Record.new_sha = $Head
    return Complete-Gate $Paths $Record 'RECOVERED' ('interrupted ' + [string]$inflight.mode + ' undone: restored ' + $restored + ' file(s), quarantined ' + $moved + '; HEAD ' + $Head.Substring(0, 7) + ' and tree clean') $true
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
    $lock = Enter-GateLock $paths
    if (-not $lock) {
        Write-Host 'deploy gate already running'
        try { Write-GateLog $paths 'SKIP: another gate instance holds the lock' } catch { Write-Verbose 'log unavailable' }
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
