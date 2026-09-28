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

# حالة المهمة الفعلية من Task Scheduler (Ready/Running/Disabled/...)، أو $null إن لم تكن مرئية.
function Get-PreflightTaskState([string]$TaskName) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return $null }
    return [string]$task.State
}

# جرد الهويات: كل مهمة (غير تابعة لـMicrosoft) باسمها وحسابها ونص الـAction، وكل خدمة
# بحسابها ومسار تنفيذها. هوية غير مقروءة تبقى فارغة ⇒ يحكم الفحص عليها fail-closed.
function Get-PreflightTaskInventory {
    $out = @()
    # ErrorAction Stop: تعذّر الجرد يصل إلى المستدعي فيحجب (لا قائمة فارغة صامتة).
    foreach ($t in @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskPath -notlike '\Microsoft\*' })) {
        $id = [string]$t.Principal.UserId
        if (-not $id) { $id = [string]$t.Principal.GroupId }
        $acts = @($t.Actions | ForEach-Object { [pscustomobject]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments } })
        $out += [pscustomobject]@{ name = [string]$t.TaskName; identity = $id; action = (@($acts | ForEach-Object { $_.execute + ' ' + $_.arguments }) -join "`n"); actions = $acts }
    }
    return $out
}

# أعضاء مجموعة Administrators المحلية (S-1-5-32-544) كأسماء. $null إن تعذّر التحديد ⇒ fail-closed.
function Get-PreflightAdminMembers {
    try { return @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | ForEach-Object { [string]$_.Name }) }
    catch { return $null }
}

# ErrorAction Stop (Codex P1): فشل WMI/CIM أو رفض الوصول يرمي استثناء فيحجب الفحص؛ وقائمة
# فارغة على خادم Windows حقيقي لا تُعدّ دليلاً على غياب الخدمات (يحجبها المستدعي).
function Get-PreflightServiceInventory {
    return @(Get-CimInstance -ClassName Win32_Service -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; identity = [string]$_.StartName; action = [string]$_.PathName } })
}

# ACL الفعلية لمسار (قراءة فقط). ترمي عند الفشل ⇒ يحجب المستدعي.
function Get-PreflightAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    return [pscustomobject]@{
        owner  = [string]$acl.Owner
        access = @($acl.Access | ForEach-Object { [pscustomobject]@{ identity = [string]$_.IdentityReference; rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited } })
    }
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
        # مهمة معطّلة فعلاً (حالتها من Task Scheduler نفسه، لا من الإعداد) لا تعمل من أي checkout،
        # فلا تحجب التحويل: OUT_OF_SCOPE_DISABLED. إن فُعّلت لاحقاً يعود كل شرط أدناه (fail-closed):
        # checkout مستقل معتمد على main بالـremote الرسمي. أي حالة أخرى أو غير مرئية تُفحص كاملاً.
        $taskState = Get-PreflightTaskState $name
        if ($taskState -ceq 'Disabled') { $results += [pscustomobject]@{ task = $name; verdict = 'OUT_OF_SCOPE_DISABLED'; reason = 'task is Disabled in Task Scheduler; enabling it requires a PASS from an approved independent main checkout' }; continue }
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

    $blocked = @($results | Where-Object { $_.verdict -ne 'PASS' -and $_.verdict -ne 'OUT_OF_SCOPE_DISABLED' })
    return [pscustomobject]@{ ok = ($blocked.Count -eq 0); results = $results }
}

# ------------------------------------------------------------
# هوية البوابة (Codex P1 على #285): حساب مخصّص لا يشغّل أي كود من أي مستودع.
# ------------------------------------------------------------
# مفتاح موحّد للهوية: بلا بادئة الجهاز/المجال، وأسماء SYSTEM وAdministrators بصيغة واحدة.
function ConvertTo-IdentityKey([string]$Identity) {
    $k = ([string]$Identity).Trim().ToLowerInvariant()
    if (-not $k) { return '' }
    if ($k.Contains('\')) { $k = $k.Substring($k.LastIndexOf('\') + 1) }
    if ($k.StartsWith('.\')) { $k = $k.Substring(2) }
    switch ($k) {
        'localsystem' { return 'system' }
        's-1-5-18' { return 'system' }
        's-1-5-32-544' { return 'administrators' }
        default { return $k }
    }
}

# هل تشغّل هذه المهمة/الخدمة كوداً من مستودع؟ (مستوى واحد من الأغلفة)
function Test-RepoWorkload($Config, [string]$ActionText) {
    $roots = @(@($Config.repoPath) + @($Config.trust.repositoryRoots) | Where-Object { $_ } | ForEach-Object { ConvertTo-PreflightPath ([string]$_) })
    $refs = @(Get-TaskScriptReferences $ActionText)
    $refs += @([regex]::Matches([string]$ActionText, '(?:[A-Za-z]:\\|/)[^"''\r\n<>|]+?\.(exe|bat|cmd|js|mjs|ps1|vbs)\b') | ForEach-Object { $_.Value })
    foreach ($r in $refs) {
        $n = ConvertTo-PreflightPath $r
        foreach ($root in $roots) { if ($n -eq $root -or $n.StartsWith($root + '\')) { return $true } }
    }
    return $false
}

# تقسيم وسائط سطر الأوامر مع علامات الاقتباس؛ $null إن لم يمكن تفسيرها بلا لبس.
function Split-GateArguments([string]$Text) {
    if (([regex]::Matches([string]$Text, '"')).Count % 2 -ne 0) { return $null }
    $tokens = @()
    foreach ($m in [regex]::Matches([string]$Text, '"([^"]*)"|(\S+)')) {
        if ($m.Groups[1].Success) { $tokens += $m.Groups[1].Value } else { $tokens += $m.Groups[2].Value }
    }
    return , $tokens
}

# مهمة البوابة يجب أن تشغّل بالضبط: المفسّر المعتمد + -File <gateDir>\deploy-gate.ps1
# (مع مفاتيح PowerShell آمنة محددة، و-Mode Deploy|DryRun فقط). $null = مطابق؛ وإلا السبب.
function Test-ExactGateAction($Config, $Task) {
    $acts = @($Task.actions)
    if ($acts.Count -ne 1) { return ('expected exactly one action, found ' + $acts.Count) }
    $exe = ([string]$acts[0].execute).Trim().Trim('"')
    $allowedExe = ConvertTo-PreflightPath ([string]$Config.trust.gateInterpreter)
    if (-not $allowedExe -or (ConvertTo-PreflightPath $exe) -ne $allowedExe) { return ('interpreter is not the approved PowerShell: ' + $exe) }
    $tokens = Split-GateArguments ([string]$acts[0].arguments)
    if ($null -eq $tokens) { return 'arguments cannot be parsed unambiguously' }
    $expected = ConvertTo-PreflightPath (([string]$Config.gateDir).TrimEnd('\', '/') + '\' + [string]$Config.trust.gateScript)
    $flags = @('-noprofile', '-noninteractive', '-nologo')
    $i = 0
    $file = $null
    while ($i -lt $tokens.Count) {
        $tk = [string]$tokens[$i]
        $lower = $tk.ToLowerInvariant()
        if ($flags -contains $lower) { $i++; continue }
        if ($lower -eq '-executionpolicy' -and $i + 1 -lt $tokens.Count -and @('bypass', 'remotesigned', 'allsigned') -contains ([string]$tokens[$i + 1]).ToLowerInvariant()) { $i += 2; continue }
        if ($lower -eq '-windowstyle' -and $i + 1 -lt $tokens.Count -and ([string]$tokens[$i + 1]).ToLowerInvariant() -eq 'hidden') { $i += 2; continue }
        if ($lower -eq '-file' -and $i + 1 -lt $tokens.Count) { $file = [string]$tokens[$i + 1]; $i += 2; break }
        return ('disallowed PowerShell argument: ' + $tk)
    }
    if (-not $file) { return 'no -File <gateDir>\deploy-gate.ps1' }
    if ($file -notmatch '^[A-Za-z]:\\' -or $file -match '(^|[\\/])\.{1,2}([\\/]|$)|[%$`]') { return ('script path is not an absolute canonical path: ' + $file) }
    if ((ConvertTo-PreflightPath $file) -ne $expected) { return ('script is not ' + $expected + ': ' + $file) }
    while ($i -lt $tokens.Count) {
        $tk = ([string]$tokens[$i]).ToLowerInvariant()
        if ($tk -eq '-mode' -and $i + 1 -lt $tokens.Count -and @('deploy', 'dryrun') -contains ([string]$tokens[$i + 1]).ToLowerInvariant()) { $i += 2; continue }
        return ('disallowed script argument: ' + $tokens[$i])
    }
    return $null
}

# ------------------------------------------------------------
# ACL الفعلية لملفات الثقة (Codex P1): لا ثقة بالإعداد المعلن.
# ------------------------------------------------------------
$script:FileSystemRightNames = @{
    'readdata' = 1; 'listdirectory' = 1; 'writedata' = 2; 'createfiles' = 2; 'appenddata' = 4; 'createdirectories' = 4
    'readextendedattributes' = 8; 'writeextendedattributes' = 16; 'executefile' = 32; 'traverse' = 32
    'deletesubdirectoriesandfiles' = 64; 'readattributes' = 128; 'writeattributes' = 256; 'write' = 278
    'delete' = 65536; 'readpermissions' = 131072; 'read' = 131209; 'readandexecute' = 131241; 'modify' = 197055
    'changepermissions' = 262144; 'takeownership' = 524288; 'synchronize' = 1048576; 'fullcontrol' = 2032127
}
# كل حق يسمح بتغيير المحتوى أو الصلاحيات أو الملكية (ملفاً أو مجلداً)، والحقوق العامة.
$script:WriteRightsMask = 2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288

# قيمة الحقوق رقماً؛ $null إن تعذّر تفسيرها.
function ConvertTo-RightsValue([string]$Rights) {
    $t = ([string]$Rights).Trim()
    if (-not $t) { return $null }
    $num = 0L
    if ([long]::TryParse($t, [ref]$num)) { return $num }
    $total = 0L
    foreach ($part in ($t -split ',')) {
        $name = $part.Trim().ToLowerInvariant()
        if (-not $script:FileSystemRightNames.ContainsKey($name)) { return $null }
        $total = $total -bor [long]$script:FileSystemRightNames[$name]
    }
    return $total
}

function Test-RightsGrantWrite([long]$Value) {
    # GENERIC_ALL (0x10000000) وGENERIC_WRITE (0x40000000) تُحسب كتابة.
    return ((($Value -band $script:WriteRightsMask) -ne 0) -or (($Value -band 0x10000000) -ne 0) -or (($Value -band 0x40000000) -ne 0))
}

function Test-GateTrustAcl($Config) {
    $results = @()
    $block = { param([string]$Subject, [string]$Reason) [pscustomobject]@{ task = $Subject; verdict = 'BLOCK'; reason = $Reason } }
    $gate = ConvertTo-IdentityKey ([string]$Config.trust.gateAccount)
    $dir = ([string]$Config.gateDir).TrimEnd('\', '/')
    $sep = '\'
    if ($dir.StartsWith('/')) { $sep = '/' }
    $targets = @($dir)
    foreach ($f in @($Config.trust.trustFiles)) {
        $p = $dir + $sep + [string]$f
        if (Test-Path -LiteralPath $p) { $targets += $p }
        elseif (@($Config.trust.requiredTrustFiles) -contains [string]$f) { $results += & $block ('trust file ' + $f) 'required trust file is missing' }
    }
    foreach ($path in $targets) {
        $subject = 'acl ' + $path
        try { $acl = Get-PreflightAcl $path } catch { $results += & $block $subject ('cannot read ACL: ' + $_.Exception.Message); continue }
        if (-not $acl) { $results += & $block $subject 'ACL is empty or unreadable'; continue }
        $ownerKey = ConvertTo-IdentityKey ([string]$acl.owner)
        if (-not $ownerKey) { $results += & $block $subject 'owner cannot be determined' }
        elseif ($ownerKey -ne $gate) { $results += & $block $subject ('owner is ' + $acl.owner + ' (implicit permission rights); only the dedicated gate identity may own trust state') }
        foreach ($ace in @($acl.access)) {
            $type = ([string]$ace.type).Trim()
            if ($type -eq 'Deny') { continue }
            if ($type -ne 'Allow') { $results += & $block $subject ('unrecognised ACE type: ' + $ace.type); continue }
            $value = ConvertTo-RightsValue ([string]$ace.rights)
            if ($null -eq $value) { $results += & $block $subject ('rights cannot be interpreted for ' + $ace.identity + ': ' + $ace.rights); continue }
            if (-not (Test-RightsGrantWrite $value)) { continue }
            $key = ConvertTo-IdentityKey ([string]$ace.identity)
            if (-not $key) { $results += & $block $subject 'write-granting ACE with an unresolvable identity'; continue }
            if ($key -ne $gate) {
                $origin = 'explicit'
                if ([bool]$ace.inherited) { $origin = 'inherited' }
                $results += & $block $subject ($origin + ' write access for ' + $ace.identity + ' (' + $ace.rights + ')')
            }
        }
    }
    if (@($results).Count -eq 0) { $results += [pscustomobject]@{ task = 'gate trust ACL'; verdict = 'PASS'; reason = 'only the dedicated gate identity owns and can write gateDir and the trust files' } }
    $blocked = @($results | Where-Object { $_.verdict -ne 'PASS' })
    return [pscustomobject]@{ ok = ($blocked.Count -eq 0); results = $results }
}

function Invoke-GateIdentityPreflight($Config) {
    $results = @()
    $block = { param([string]$Subject, [string]$Reason) [pscustomobject]@{ task = $Subject; verdict = 'BLOCK'; reason = $Reason } }
    $trust = $Config.trust
    $gate = ConvertTo-IdentityKey ([string]$trust.gateAccount)
    if (-not $gate) { return [pscustomobject]@{ ok = $false; results = @(& $block 'gate identity' 'no dedicated gate identity configured') } }
    $forbidden = @(@($trust.forbiddenGateIdentities) + @('system', 'administrators', 'ozksync', 'loq') | ForEach-Object { ConvertTo-IdentityKey ([string]$_) } | Select-Object -Unique)
    if ($forbidden -contains $gate) { $results += & $block 'gate identity' ('forbidden gate identity: ' + $trust.gateAccount + ' (repository code runs as or can override this identity)') }
    $writers = @(@($trust.gateDirWriters) | ForEach-Object { ConvertTo-IdentityKey ([string]$_) } | Where-Object { $_ } | Select-Object -Unique)
    if ($writers.Count -ne 1 -or $writers[0] -ne $gate) { $results += & $block 'gate trust files' ('trust files must be writable by the dedicated gate identity only; configured writers: ' + (@($trust.gateDirWriters) -join ', ')) }
    $gateTask = [string]$trust.gateTaskName

    $inventory = @()
    try {
        $inventory += @(Get-PreflightTaskInventory | ForEach-Object { $_ | Add-Member -NotePropertyName kind -NotePropertyValue 'task' -PassThru -Force })
    } catch {
        return [pscustomobject]@{ ok = $false; results = @($results + (& $block 'inventory' ('cannot enumerate tasks/services: scheduled tasks: ' + $_.Exception.Message))) }
    }
    try {
        $inventory += @(Get-PreflightServiceInventory | ForEach-Object { $_ | Add-Member -NotePropertyName kind -NotePropertyValue 'service' -PassThru -Force })
    } catch {
        return [pscustomobject]@{ ok = $false; results = @($results + (& $block 'inventory' ('cannot enumerate tasks/services: services: ' + $_.Exception.Message))) }
    }
    if (@($inventory | Where-Object { $_.kind -eq 'task' }).Count -eq 0) { $results += & $block 'inventory' 'no scheduled tasks visible; run the preflight as an administrator' }
    if (@($inventory | Where-Object { $_.kind -eq 'service' }).Count -eq 0) { $results += & $block 'inventory' 'service inventory is empty; an empty list is not evidence that no services exist' }

    # قرار أمني: repo workload مؤتمت بصلاحية تتجاوز ACL (SYSTEM، أو حساب مدير محلي، أو عضو
    # Administrators، أو هوية البوابة نفسها) يحجب التثبيت بغض النظر عن قائمة كتّاب ملفات الثقة.
    $adminMembers = Get-PreflightAdminMembers
    $adminKeys = $null
    if ($null -ne $adminMembers) { $adminKeys = @(@($adminMembers) | ForEach-Object { ConvertTo-IdentityKey ([string]$_) } | Where-Object { $_ }) }

    foreach ($item in $inventory) {
        $subject = $item.kind + ' ' + $item.name
        $key = ConvertTo-IdentityKey ([string]$item.identity)
        $isRepo = Test-RepoWorkload $Config ([string]$item.action)
        if ($isRepo -and $key) {
            if ($key -eq 'system' -or $key -eq 'administrators') {
                $results += & $block $subject ('privileged repository workload: runs repo code as ' + $item.identity + ' (can override the gate trust files regardless of ACL)')
            } elseif ($null -eq $adminKeys) {
                $results += & $block $subject ('cannot determine whether ' + $item.identity + ' is a local administrator (repository workload)')
            } elseif ($adminKeys -contains $key) {
                $results += & $block $subject ('privileged repository workload: runs repo code as ' + $item.identity + ', a member of local Administrators')
            }
        }
        if (-not $key) {
            # هوية غير مقروءة: لمهمة دائماً حجب؛ لخدمة فقط إن كانت تشغّل كود مستودع.
            if ($item.kind -eq 'task' -or $isRepo) { $results += & $block $subject 'identity not verifiable' }
            continue
        }
        if ($key -eq $gate) {
            if ($item.kind -eq 'task' -and $item.name -eq $gateTask) {
                $why = Test-ExactGateAction $Config $item
                if ($isRepo -or $why) { $results += & $block $subject ('the gate task must run only the gate scripts in gateDir: ' + $why) }
            } else {
                $results += & $block $subject ('dedicated gate identity is reused by ' + $item.kind + ' ' + $item.name)
            }
            continue
        }
        if ($isRepo -and $writers -contains $key) { $results += & $block $subject ('repository workload runs as ' + $item.identity + ', which may write the gate trust files') }
    }
    $blocked = @($results | Where-Object { $_.verdict -ne 'PASS' })
    if ($blocked.Count -eq 0) { $results += [pscustomobject]@{ task = 'gate identity'; verdict = 'PASS'; reason = ('dedicated identity ' + $trust.gateAccount + ' is not used by any repository workload') } }
    return [pscustomobject]@{ ok = ($blocked.Count -eq 0); results = $results }
}

# فحص التثبيت الكامل: نشرات الأسعار (main) + هوية البوابة + ACL الفعلية. يستدعيه -Mode Initialize.
function Invoke-InstallPreflight($Config) {
    $a = Invoke-MigrationPreflight $Config
    $b = Invoke-GateIdentityPreflight $Config
    $c = Test-GateTrustAcl $Config
    return [pscustomobject]@{ ok = ($a.ok -and $b.ok -and $c.ok); results = @(@($a.results) + @($b.results) + @($c.results)) }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($PreflightConfigPath)) { $PreflightConfigPath = Join-Path $PSScriptRoot 'gate-config.json' }
    $config = [System.IO.File]::ReadAllText($PreflightConfigPath) | ConvertFrom-Json
    $report = Invoke-InstallPreflight $config
    foreach ($r in $report.results) { Write-Host ($r.verdict + ' ' + $r.task + ': ' + $r.reason) }
    if ($report.ok) { Write-Host 'PREFLIGHT PASS'; exit 0 }
    Write-Host 'PREFLIGHT BLOCKED: do not switch the operational repository to windows-production'
    exit 1
}
