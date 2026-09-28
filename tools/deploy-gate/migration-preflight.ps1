#Requires -Version 5.1
# ============================================================
# migration-preflight.ps1 — فحص ما قبل تحويل المستودع التشغيلي إلى windows-production
# (نسخة مرجعية؛ قراءة فقط، لا يغيّر أي مهمة ولا ملفاً ولا فرعاً)
#
# Codex P1 #5: مهام تحتاج main صراحةً (mainDependentTasks، اليوم OZK-PriceListSync
# → tools/auto-sync-price-lists.ps1 الذي يرفض العمل على غير main) تتوقف كلها لو حُوِّل
# المستودع الذي تعمل منه إلى windows-production. لذلك التحويل محجوب حتى تعمل كل مهمة منها
# من worktree مخصّص لـmain (mainWorktree): موجود، ليس المستودع التشغيلي، على main، وبالـremote
# الرسمي، والسكربت ضمن allowedScripts. والـworktree المخصّص ليس باباً خلفياً: أي مهمة أخرى
# أو سكربت آخر يعمل منه = حجب.
#
# التشغيل المستقل (بحساب مدير):  powershell -File migration-preflight.ps1 [-PreflightConfigPath ...]
# وتستدعيه deploy-gate.ps1 -Mode Initialize قبل أي تسجيل للحالة.
# ============================================================
[CmdletBinding()]
# الاسم مميّز عمداً: deploy-gate.ps1 يستورد هذا الملف بـdot-source فلا يطغى على $ConfigPath فيه.
param([string]$PreflightConfigPath = '')

# ------------------------------------------------------------
# نقاط تماس خارجية — تُستبدل في الاختبارات
# ------------------------------------------------------------
function Get-PreflightTaskNames {
    return @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'TOBACCO*' -or $_.TaskName -like 'OZK*' } | ForEach-Object { $_.TaskName })
}

# نص الـAction كما هو (برنامج + وسائط + مجلد العمل)، أو $null إن لم تكن المهمة مسجّلة.
function Get-PreflightTaskActionText([string]$TaskName) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    return (@($task.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments + ' ' + [string]$_.WorkingDirectory }) -join "`n")
}

function Read-PreflightWrapperText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path)
}

function Invoke-PreflightGit([string]$Dir, [string[]]$GitArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Dir -c ('safe.directory=' + $Dir) @GitArgs 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    return [pscustomobject]@{ Code = $code; Text = ((@($out) -join "`n").Trim()) }
}

# ------------------------------------------------------------
# المنطق
# ------------------------------------------------------------
function ConvertTo-PreflightPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    return (($Path -replace '/', '\').TrimEnd('\')).ToLowerInvariant()
}

function ConvertTo-RemoteKey([string]$Url) {
    $u = ([string]$Url).Trim().ToLowerInvariant()
    $u = $u -replace '^git@github\.com:', 'github.com/' -replace '^https?://', '' -replace '^[^@/]+@', '' -replace '\.git$', ''
    return $u.TrimEnd('/')
}

# كل المسارات المطلقة لسكربتات يشير إليها الـAction، مع مستوى واحد من الأغلفة (vbs/cmd/bat/ps1).
function Get-TaskScriptReferences([string]$ActionText) {
    $rx = '(?:[A-Za-z]:\\|/)[^"''\r\n<>|]+?\.(ps1|vbs|cmd|bat|mjs|js)\b'
    $refs = @()
    foreach ($m in [regex]::Matches([string]$ActionText, $rx)) {
        $refs += $m.Value
        if ($m.Value -match '\.(vbs|cmd|bat|ps1)$') {
            foreach ($inner in [regex]::Matches((Read-PreflightWrapperText $m.Value), $rx)) { $refs += $inner.Value }
        }
    }
    return @($refs | Select-Object -Unique)
}

# جذر السكربت: المسار المطلق ناقص مساره النسبي داخل المستودع.
function Get-ScriptRoot([string[]]$References, [string]$RelativeScript) {
    $suffix = '\' + (ConvertTo-PreflightPath $RelativeScript)
    foreach ($r in $References) {
        $n = ConvertTo-PreflightPath $r
        if ($n.EndsWith($suffix)) { return $n.Substring(0, $n.Length - $suffix.Length) }
    }
    return $null
}

function Test-MainWorktree($Config) {
    $mw = $Config.mainWorktree
    $path = [string]$mw.path
    if ((ConvertTo-PreflightPath $path) -eq (ConvertTo-PreflightPath $Config.repoPath)) { return 'main worktree must not be the operational repository' }
    if (-not (Test-Path -LiteralPath $path)) { return ('main worktree not found: ' + $path) }
    # جذر worktree فعلاً: البادئة النسبية فارغة (بلا مقارنة نصية للمسارات: روابط رمزية/حالة أحرف).
    $prefix = Invoke-PreflightGit $path @('rev-parse', '--show-prefix')
    if ($prefix.Code -ne 0 -or $prefix.Text -ne '') { return ('not a git worktree root: ' + $path) }
    $branch = Invoke-PreflightGit $path @('rev-parse', '--abbrev-ref', 'HEAD')
    if ($branch.Code -ne 0 -or $branch.Text -ne [string]$mw.branch) { return ('main worktree is on ''' + $branch.Text + ''' not ''' + $mw.branch + '''') }
    $remote = Invoke-PreflightGit $path @('remote', 'get-url', 'origin')
    if ($remote.Code -ne 0 -or (ConvertTo-RemoteKey $remote.Text) -ne (ConvertTo-RemoteKey $mw.remote)) { return ('main worktree remote is ''' + $remote.Text + ''' not the official repository') }
    return $null
}

function Invoke-MigrationPreflight($Config) {
    $results = @()
    $mwKey = ConvertTo-PreflightPath $Config.mainWorktree.path
    $repoKey = ConvertTo-PreflightPath $Config.repoPath
    $allowed = @($Config.mainWorktree.allowedScripts | ForEach-Object { ([string]$_ -replace '\\', '/') })
    $dependent = @($Config.mainDependentTasks)
    $worktreeProblem = $null
    $worktreeChecked = $false

    foreach ($dep in $dependent) {
        $name = [string]$dep.task
        $action = Get-PreflightTaskActionText $name
        # مهمة غير مرئية (غير مسجّلة أو لا يملك الحساب الحالي صلاحية قراءتها) = لا يمكن التحقق ⇒ حجب.
        # شغّل الفحص بحساب مدير يرى كل المهام.
        if ($null -eq $action) { $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = 'task definition not visible (missing or no permission); run the preflight as an administrator' }; continue }
        $root = Get-ScriptRoot (Get-TaskScriptReferences $action) ([string]$dep.script)
        if (-not $root) { $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = ('cannot find ' + $dep.script + ' in the task action') }; continue }
        if ($root -eq $repoKey) { $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = 'still runs from the operational repository (needs main)' }; continue }
        if ($root -ne $mwKey) { $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = ('runs from an unapproved worktree: ' + $root) }; continue }
        if ($allowed -notcontains ([string]$dep.script -replace '\\', '/')) { $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = 'script not allowed in the main worktree' }; continue }
        if (-not $worktreeChecked) { $worktreeProblem = Test-MainWorktree $Config; $worktreeChecked = $true }
        if ($worktreeProblem) { $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = $worktreeProblem }; continue }
        $results += [pscustomobject]@{ task = $name; verdict = 'PASS'; reason = 'runs from the dedicated main worktree' }
    }

    # لا باب خلفي: أي مهمة أخرى أو سكربت غير مسموح يعمل من worktree الـmain = حجب.
    $dependentNames = @($dependent | ForEach-Object { [string]$_.task })
    foreach ($name in @(Get-PreflightTaskNames)) {
        $action = Get-PreflightTaskActionText $name
        if ($null -eq $action) { continue }
        foreach ($ref in (Get-TaskScriptReferences $action)) {
            $n = ConvertTo-PreflightPath $ref
            if (-not $n.StartsWith($mwKey + '\')) { continue }
            $rel = $n.Substring($mwKey.Length + 1) -replace '\\', '/'
            if ($dependentNames -notcontains $name -or $allowed -notcontains $rel) {
                $results += [pscustomobject]@{ task = $name; verdict = 'BLOCK'; reason = ('uses the main worktree outside its allow-list: ' + $rel) }
            }
        }
    }

    $blocked = @($results | Where-Object { $_.verdict -ne 'PASS' })
    return [pscustomobject]@{ ok = ($blocked.Count -eq 0); results = $results }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($PreflightConfigPath)) { $PreflightConfigPath = Join-Path $PSScriptRoot 'gate-config.json' }
    $config = [System.IO.File]::ReadAllText($PreflightConfigPath) | ConvertFrom-Json
    $report = Invoke-MigrationPreflight $config
    foreach ($r in $report.results) { Write-Host ($r.verdict + ' ' + $r.task + ': ' + $r.reason) }
    if ($report.ok) { Write-Host 'PREFLIGHT PASS'; exit 0 }
    Write-Host 'PREFLIGHT BLOCKED: do not switch the operational repository to windows-production'
    exit 1
}
