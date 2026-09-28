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

# جرد الهويات: كل مهمة (أياً كان مكانها، ومنها \Microsoft\) باسمها وحسابها ونص الـAction، وكل خدمة
# بحسابها ومسار تنفيذها. هوية غير مقروءة تبقى فارغة ⇒ يحكم الفحص عليها fail-closed.
function Get-PreflightTaskInventory {
    $out = @()
    # ErrorAction Stop: تعذّر الجرد يصل إلى المستدعي فيحجب (لا قائمة فارغة صامتة).
    # كل المهام بلا استثناء لمكانها (TaskPath): مهمة تحت \Microsoft\ تشغّل كود مستودع تُفحص كغيرها.
    foreach ($t in @(Get-ScheduledTask -ErrorAction Stop)) {
        $id = [string]$t.Principal.UserId
        if (-not $id) { $id = [string]$t.Principal.GroupId }
        $acts = @($t.Actions | ForEach-Object { [pscustomobject]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory } })
        $out += [pscustomobject]@{ name = [string]$t.TaskName; path = [string]$t.TaskPath; identity = $id; action = (@($acts | ForEach-Object { $_.execute + ' ' + $_.arguments + ' ' + $_.workingDirectory }) -join "`n"); actions = $acts }
    }
    return $out
}

# أعضاء مجموعة Administrators المحلية (S-1-5-32-544) كـSIDs. $null إن تعذّر التحديد ⇒ fail-closed،
# ومنه وجود مجموعة متداخلة (لا يمكن تقييم عضويتها المتداخلة هنا).
function Get-PreflightAdminMembers {
    try {
        $members = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop)
        if (@($members | Where-Object { [string]$_.ObjectClass -eq 'Group' }).Count -gt 0) { return $null }
        return @($members | ForEach-Object { [string]$_.SID.Value })
    } catch { return $null }
}

function Get-PreflightMachineName { return [Environment]::MachineName }

# ترجمة اسم حساب إلى SID عبر Windows (نقطة تماس تُستبدل في الاختبارات). $null عند الفشل.
function Invoke-NtAccountTranslate([string]$Name) {
    try { return (New-Object System.Security.Principal.NTAccount($Name)).Translate([System.Security.Principal.SecurityIdentifier]).Value }
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
    # المالك وكل ACE بالـSID كما في الـACL نفسها (لا أسماء تُطابَق).
    $sidType = [System.Security.Principal.SecurityIdentifier]
    return [pscustomobject]@{
        owner  = [string]$acl.GetOwner($sidType).Value
        access = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { [pscustomobject]@{ identity = [string]$_.IdentityReference.Value; rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited } })
    }
}

# نص غلاف: '' إن لم يوجد؛ يرمي إن وُجد وتعذّرت قراءته (⇒ «غير محدد» لدى المستدعي).
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
# مقارنة الهويات بالـSID حصراً (Codex P1): الاسم بعد حذف بادئة الجهاز/المجال يخلط بين
# OZK2026\OZK-DeployGate وDOMAIN\OZK-DeployGate. كل اسم يُحلّ إلى SID قبل أي قرار ثقة،
# وما لا يُحلّ ⇒ $null ⇒ حجب لدى المستدعي.
$script:WellKnownSids = @{
    'system' = 'S-1-5-18'; 'localsystem' = 'S-1-5-18'; 'nt authority\system' = 'S-1-5-18'
    'administrators' = 'S-1-5-32-544'; 'builtin\administrators' = 'S-1-5-32-544'
    'users' = 'S-1-5-32-545'; 'builtin\users' = 'S-1-5-32-545'; 'everyone' = 'S-1-1-0'; 'creator owner' = 'S-1-3-0'
    'local service' = 'S-1-5-19'; 'localservice' = 'S-1-5-19'; 'nt authority\local service' = 'S-1-5-19'; 'nt authority\localservice' = 'S-1-5-19'
    'network service' = 'S-1-5-20'; 'networkservice' = 'S-1-5-20'; 'nt authority\network service' = 'S-1-5-20'; 'nt authority\networkservice' = 'S-1-5-20'
    'authenticated users' = 'S-1-5-11'; 'nt authority\authenticated users' = 'S-1-5-11'; 'interactive' = 'S-1-5-4'; 'nt authority\interactive' = 'S-1-5-4'
}

function Resolve-PrincipalSid([string]$Principal) {
    $p = ([string]$Principal).Trim()
    if (-not $p) { return $null }
    if ($p -match '^[Ss]-1(-\d+)+$') { return $p.ToUpperInvariant() }
    $k = $p.ToLowerInvariant()
    if ($script:WellKnownSids.ContainsKey($k)) { return $script:WellKnownSids[$k] }
    # «.\name» (حساب محلي في StartName للخدمات) = MACHINE\name.
    if ($p.StartsWith('.\')) { $p = (Get-PreflightMachineName) + $p.Substring(1) }
    $sid = Invoke-NtAccountTranslate $p
    if ($sid -and ([string]$sid) -match '^[Ss]-1(-\d+)+$') { return ([string]$sid).ToUpperInvariant() }
    return $null
}

# اسم الحساب الأخير — لمسار ملف التعريف فقط (توسيع متغيّرات البيئة)، لا لأي قرار ثقة.
function Get-AccountLeafName([string]$Identity) {
    $k = ([string]$Identity).Trim()
    if ($k.Contains('\')) { $k = $k.Substring($k.LastIndexOf('\') + 1) }
    return $k
}

# هل يصل هذا الـAction إلى كود مستودع؟ يتتبّع الأغلفة (vbs/cmd/bat/ps1/psm1) خارج المستودع
# حتى 3 مستويات. «undetermined» حين لا يمكن الإثبات: غلاف موجود لا يُقرأ، أو عمق أكبر، أو
# متغيّر بيئة خاص بالمستخدم أو غير معروف في المسار.
function Expand-UserProfileVariables([string]$Text, [string]$Identity) {
    $key = Get-AccountLeafName $Identity
    if (-not $key) { return $null }
    $userProfile = 'C:\Users\' + $key
    if ((Resolve-PrincipalSid $Identity) -eq 'S-1-5-18') { $userProfile = 'C:\Windows\System32\config\systemprofile' }
    $map = @{ 'userprofile' = $userProfile; 'homedrive' = 'C:'; 'homepath' = $userProfile.Substring(2); 'appdata' = ($userProfile + '\AppData\Roaming'); 'localappdata' = ($userProfile + '\AppData\Local'); 'temp' = ($userProfile + '\AppData\Local\Temp'); 'tmp' = ($userProfile + '\AppData\Local\Temp'); 'username' = $key; 'onedrive' = ($userProfile + '\OneDrive') }
    return [regex]::Replace($Text, '%(userprofile|homepath|homedrive|appdata|localappdata|temp|tmp|username|onedrive)%', { param($m) $map[$m.Groups[1].Value.ToLowerInvariant()] }, 'IgnoreCase')
}

# متغيّرات النظام المعروفة: قيمة العملية إن وُجدت، وإلا المسار القياسي (ثابتة لكل المستخدمين).
function Expand-MachineVariables([string]$Text) {
    $defaults = @{ 'windir' = 'C:\Windows'; 'systemroot' = 'C:\Windows'; 'systemdrive' = 'C:'; 'programfiles' = 'C:\Program Files'; 'programfiles(x86)' = 'C:\Program Files (x86)'; 'programw6432' = 'C:\Program Files'; 'programdata' = 'C:\ProgramData'; 'allusersprofile' = 'C:\ProgramData'; 'commonprogramfiles' = 'C:\Program Files\Common Files'; 'commonprogramfiles(x86)' = 'C:\Program Files (x86)\Common Files'; 'public' = 'C:\Users\Public' }
    return [regex]::Replace($Text, '%(windir|systemroot|systemdrive|programfiles\(x86\)|programfiles|programw6432|programdata|allusersprofile|commonprogramfiles\(x86\)|commonprogramfiles|public)%', {
        param($m)
        $name = $m.Groups[1].Value
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { return $value }
        return $defaults[$name.ToLowerInvariant()]
    }, 'IgnoreCase')
}

function Resolve-WorkloadReach($Config, [string]$ActionText, [string]$Identity = '') {
    $roots = @(@($Config.repoPath) + @($Config.trust.repositoryRoots) | Where-Object { $_ } | ForEach-Object { ConvertTo-PreflightPath ([string]$_) })
    $inRoot = {
        param([string]$Candidate)
        $n = ConvertTo-PreflightPath $Candidate
        foreach ($root in $roots) { if ($n -eq $root -or $n.StartsWith($root + '\')) { return $true } }
        return $false
    }
    $undetermined = $false
    $text = [string]$ActionText
    # متغيّرات المستخدم تُوسَّع بملف تعريف هوية المهمة نفسها (لا بحساب من يشغّل الفحص)؛ هوية مجهولة ⇒ غير محدد.
    if ($text -match '%(userprofile|homepath|homedrive|appdata|localappdata|temp|tmp|username|onedrive)%') {
        $expanded = Expand-UserProfileVariables $text $Identity
        if ($null -eq $expanded) { $undetermined = $true } else { $text = $expanded }
    }
    $text = Expand-MachineVariables $text
    if ($text -match '%[A-Za-z_][A-Za-z0-9_()]*%') { $undetermined = $true }
    $rx = '(?:[A-Za-z]:\\|/)[^"''\r\n<>|]+?\.(exe|bat|cmd|js|mjs|cjs|ps1|psm1|vbs|py)\b'
    $dirRx = '(?:[A-Za-z]:\\|/)[^"''\r\n<>|]+'
    foreach ($m in [regex]::Matches($text, $dirRx)) { if (& $inRoot ($m.Value.Trim())) { return [pscustomobject]@{ repo = $true; undetermined = $false } } }
    $queue = New-Object System.Collections.Queue
    foreach ($m in [regex]::Matches($text, $rx)) { $queue.Enqueue(@($m.Value, 0)) }
    $seen = @{}
    while ($queue.Count -gt 0) {
        $entry = $queue.Dequeue()
        $path = [string]$entry[0]
        $depth = [int]$entry[1]
        $k = ConvertTo-PreflightPath $path
        if ($seen.ContainsKey($k)) { continue }
        $seen[$k] = $true
        if (& $inRoot $path) { return [pscustomobject]@{ repo = $true; undetermined = $false } }
        if ($path -notmatch '\.(vbs|cmd|bat|ps1|psm1)$') { continue }
        if ($depth -ge 3) { $undetermined = $true; continue }
        try { $inner = Read-PreflightWrapperText $path } catch { $undetermined = $true; continue }
        if ($null -eq $inner) { $undetermined = $true; continue }
        if ($inner -match '%(userprofile|homepath|homedrive|appdata|localappdata|temp|tmp|username|onedrive)%') {
            $expandedInner = Expand-UserProfileVariables $inner $Identity
            if ($null -eq $expandedInner) { $undetermined = $true } else { $inner = $expandedInner }
        }
        $inner = Expand-MachineVariables ([string]$inner)
        foreach ($m in [regex]::Matches($inner, $dirRx)) { if (& $inRoot ($m.Value.Trim())) { return [pscustomobject]@{ repo = $true; undetermined = $false } } }
        foreach ($m in [regex]::Matches($inner, $rx)) { $queue.Enqueue(@($m.Value, $depth + 1)) }
    }
    return [pscustomobject]@{ repo = $false; undetermined = $undetermined }
}

function Test-RepoWorkload($Config, [string]$ActionText) { return (Resolve-WorkloadReach $Config $ActionText).repo }

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
    $gateSid = Resolve-PrincipalSid ([string]$Config.trust.gateAccount)
    if (-not $gateSid) { return [pscustomobject]@{ ok = $false; results = @(& $block 'gate identity' ('gate identity cannot be resolved to a SID: ' + $Config.trust.gateAccount)) } }
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
        $ownerSid = Resolve-PrincipalSid ([string]$acl.owner)
        if (-not ([string]$acl.owner).Trim()) { $results += & $block $subject 'owner cannot be determined' }
        elseif (-not $ownerSid) { $results += & $block $subject ('owner cannot be resolved to a SID: ' + $acl.owner) }
        elseif ($ownerSid -ne $gateSid) { $results += & $block $subject ('owner is ' + $acl.owner + ' (' + $ownerSid + ', implicit permission rights); only the dedicated gate identity SID may own trust state') }
        foreach ($ace in @($acl.access)) {
            $type = ([string]$ace.type).Trim()
            if ($type -eq 'Deny') { continue }
            if ($type -ne 'Allow') { $results += & $block $subject ('unrecognised ACE type: ' + $ace.type); continue }
            $value = ConvertTo-RightsValue ([string]$ace.rights)
            if ($null -eq $value) { $results += & $block $subject ('rights cannot be interpreted for ' + $ace.identity + ': ' + $ace.rights); continue }
            if (-not (Test-RightsGrantWrite $value)) { continue }
            if (-not ([string]$ace.identity).Trim()) { $results += & $block $subject 'write-granting ACE with an unresolvable identity'; continue }
            $aceSid = Resolve-PrincipalSid ([string]$ace.identity)
            if (-not $aceSid) { $results += & $block $subject ('write-granting ACE whose identity cannot be resolved to a SID: ' + $ace.identity); continue }
            if ($aceSid -ne $gateSid) {
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
    $gateName = ([string]$trust.gateAccount).Trim()
    if (-not $gateName) { return [pscustomobject]@{ ok = $false; results = @(& $block 'gate identity' 'no dedicated gate identity configured') } }
    # اسم بلا بادئة يُحلّ حسب ترتيب البحث (محلي/مجال) فلا يُقبل: MACHINE\name أو SID فقط.
    if ($gateName -notmatch '^[Ss]-1(-\d+)+$' -and -not $gateName.Contains('\') -and -not $script:WellKnownSids.ContainsKey($gateName.ToLowerInvariant())) { return [pscustomobject]@{ ok = $false; results = @(& $block 'gate identity' ('gate identity must be machine-qualified (MACHINE\name) or a SID: ' + $gateName)) } }
    $gate = Resolve-PrincipalSid $gateName
    if (-not $gate) { return [pscustomobject]@{ ok = $false; results = @(& $block 'gate identity' ('gate identity cannot be resolved to a SID: ' + $gateName)) } }
    $forbidden = @()
    foreach ($f in @(@($trust.forbiddenGateIdentities) + @('SYSTEM', 'Administrators'))) {
        $fs = Resolve-PrincipalSid ([string]$f)
        if (-not $fs) { $results += & $block 'gate identity' ('forbidden identity cannot be resolved to a SID for comparison: ' + $f); continue }
        $forbidden += $fs
    }
    if ($forbidden -contains $gate) { $results += & $block 'gate identity' ('forbidden gate identity: ' + $gateName + ' (' + $gate + '; repository code runs as or can override this identity)') }
    $writers = @()
    foreach ($w in @($trust.gateDirWriters)) {
        $ws = Resolve-PrincipalSid ([string]$w)
        if (-not $ws) { $results += & $block 'gate trust files' ('configured trust-file writer cannot be resolved to a SID: ' + $w); continue }
        $writers += $ws
    }
    $writers = @($writers | Select-Object -Unique)
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
    if ($null -ne $adminMembers) {
        $adminKeys = @()
        foreach ($m in @($adminMembers)) {
            $ms = Resolve-PrincipalSid ([string]$m)
            if (-not $ms) { $adminKeys = $null; break }
            $adminKeys += $ms
        }
    }
    if ($adminKeys -and ($adminKeys -contains $gate)) { $results += & $block 'gate identity' ('dedicated gate identity is a member of local Administrators: ' + $gateName) }

    foreach ($item in $inventory) {
        $subject = $item.kind + ' ' + ([string]$item.path) + $item.name
        $identityText = ([string]$item.identity).Trim()
        $key = Resolve-PrincipalSid $identityText
        if ($identityText -and -not $key) {
            # هوية مذكورة لا تُحلّ إلى SID: لا يمكن إثبات أنها ليست هوية البوابة أو حساباً ذا صلاحية.
            $results += & $block $subject ('identity cannot be resolved to a SID: ' + $identityText)
            continue
        }
        $reach = Resolve-WorkloadReach $Config ([string]$item.action) ([string]$item.identity)
        $isRepo = [bool]$reach.repo
        # لا يمكن إثبات أن الـAction لا يصل إلى المستودع، والهوية ذات صلاحية (أو غير معروفة) ⇒ حجب.
        $maybePrivileged = (-not $key) -or $key -eq 'S-1-5-18' -or $key -eq 'S-1-5-32-544' -or $key -eq $gate -or ($null -eq $adminKeys) -or ($adminKeys -contains $key)
        if (-not $isRepo -and $reach.undetermined -and $maybePrivileged) {
            $results += & $block $subject ('cannot determine whether this ' + $item.kind + ' reaches a repository workload (identity ' + $item.identity + ')')
            continue
        }
        if ($isRepo -and $key) {
            if ($key -eq 'S-1-5-18' -or $key -eq 'S-1-5-32-544') {
                $results += & $block $subject ('privileged repository workload: runs repo code as ' + $item.identity + ' (can override the gate trust files regardless of ACL)')
            } elseif ($null -eq $adminKeys) {
                $results += & $block $subject ('cannot determine whether ' + $item.identity + ' is a local administrator (repository workload)')
            } elseif ($adminKeys -contains $key) {
                $results += & $block $subject ('privileged repository workload: runs repo code as ' + $item.identity + ', a member of local Administrators')
            }
        }
        if (-not $key) {
            # هوية غير مقروءة: حجب إن كان العمل يشغّل كود مستودع أو كان مهمة البوابة. مهام Windows
            # الأصلية بلا مرجع مستودع لا تُحجب لمجرد وجودها أو مكانها.
            if ($isRepo -or ($item.kind -eq 'task' -and $item.name -eq $gateTask)) { $results += & $block $subject 'identity not verifiable' }
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
