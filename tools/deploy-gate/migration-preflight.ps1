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
        # الحقول تبقى منفصلة (Codex P1): لا دمج Execute/Arguments/WorkingDirectory في سطر واحد.
        $acts = @($t.Actions | ForEach-Object {
            $cls = if ($_.PSObject.Properties['ClassId']) { [string]$_.ClassId } else { '' }
            if ($cls) { [pscustomobject]@{ execute = (Get-PreflightComHandlerPath $cls); arguments = ''; workingDirectory = ''; classId = $cls } }
            else { [pscustomobject]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory } }
        })
        $out += [pscustomobject]@{ name = [string]$t.TaskName; path = [string]$t.TaskPath; identity = $id; actions = $acts }
    }
    return $out
}

# ملف COM handler المسجَّل (InprocServer32/LocalServer32) قراءةً من السجل؛ '' إن تعذّر ⇒ UNKNOWN.
function Get-PreflightComHandlerPath([string]$ClassId) {
    foreach ($root in @('HKLM:\SOFTWARE\Classes\CLSID', 'HKLM:\SOFTWARE\WOW6432Node\Classes\CLSID')) {
        foreach ($server in @('InprocServer32', 'LocalServer32')) {
            $key = Get-Item -LiteralPath ($root + '\' + $ClassId + '\' + $server) -ErrorAction SilentlyContinue
            $v = if ($key) { $key.GetValue('') } else { $null }
            if ($v) { return ([Environment]::ExpandEnvironmentVariables([string]$v)).Trim('"') }
        }
    }
    return ''
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

# تطبيع مسار بلا نظام ملفات: شرطات، '.' و'..'، حالة الأحرف — كي لا يُفلت '..' من فحص الجذر.
function ConvertTo-CanonicalTracePath([string]$Path) {
    $n = ConvertTo-PreflightPath $Path
    if (-not $n) { return '' }
    $out = New-Object System.Collections.ArrayList
    foreach ($seg in ($n -split '\\')) {
        if ($seg -eq '.' -or ($seg -eq '' -and $out.Count -gt 0)) { continue }
        if ($seg -eq '..') { if ($out.Count -gt 1) { $out.RemoveAt($out.Count - 1) }; continue }
        [void]$out.Add($seg)
    }
    return ($out -join '\')
}

# توسيع مراجع البيئة في نص (Action أو جسم غلاف) بصيغ CMD وPowerShell وVBS، بلا تنفيذ.
# يُحلّ فقط ما يمكن إثباته: متغيّرات ملف تعريف هوية المهمة، ومتغيّرات النظام القياسية، ومجلد الغلاف
# نفسه (%~dp0 و$PSScriptRoot). أي مرجع بيئي أو ديناميكي آخر يبقى ⇒ undetermined (fail closed)،
# ولا يُعامل أبداً على أنه «ليس مستودعاً». يُطبَّق على الـAction وعلى كل غلاف في السلسلة بالتساوي.
function Expand-TraceText([string]$Text, [string]$Identity, [string]$SelfPath = '') {
    $undetermined = $false
    $t = [string]$Text
    if ($SelfPath) {
        $selfDir = ([string]$SelfPath -replace '/', '\')
        $selfDir = $selfDir.Substring(0, [Math]::Max(0, $selfDir.LastIndexOf('\')))
        $t = [regex]::Replace($t, '%~dp0', { param($m) $selfDir + '\' }, 'IgnoreCase')
        $t = [regex]::Replace($t, '\$PSScriptRoot\b', { param($m) $selfDir }, 'IgnoreCase')
    }
    # صيغ المرجع البيئي المختلفة ⇒ %NAME% موحّد (أسماء البيئة في Windows غير حسّاسة لحالة الأحرف).
    $t = [regex]::Replace($t, '\$\{env:([A-Za-z_][A-Za-z0-9_()]*)\}', '%$1%', 'IgnoreCase')
    $t = [regex]::Replace($t, '\$env:([A-Za-z_][A-Za-z0-9_]*(?:\(x86\))?)', '%$1%', 'IgnoreCase')
    $t = [regex]::Replace($t, '!([A-Za-z_][A-Za-z0-9_()]*)!', '%$1%')
    $t = [regex]::Replace($t, '\[(?:System\.)?Environment\]::GetEnvironmentVariable\(\s*[''"]([A-Za-z_][A-Za-z0-9_()]*)[''"]\s*(?:,[^)]*)?\)', '%$1%', 'IgnoreCase')
    # مراجع ديناميكية لا يمكن إثبات قيمتها ساكناً.
    if ($t -match '(?i)\[(?:System\.)?Environment\]::GetEnvironmentVariables?\(|\.Environment\s*\(|(?<![A-Za-z0-9_])env:') { $undetermined = $true }
    if ($t -match '(?i)%(userprofile|homepath|homedrive|appdata|localappdata|temp|tmp|username|onedrive)%') {
        $expanded = Expand-UserProfileVariables $t $Identity
        if ($null -eq $expanded) { $undetermined = $true } else { $t = $expanded }
    }
    $t = Expand-MachineVariables $t
    if ($t -match '%[A-Za-z_][A-Za-z0-9_()]*%') { $undetermined = $true }
    return [pscustomobject]@{ text = $t; undetermined = $undetermined }
}

# ------------------------------------------------------------
# تصنيف الوصول إلى المستودع — ثلاثي الحالة: REPO / NOT_REPO / UNKNOWN (Codex P1).
# UNKNOWN لا يسقط أبداً إلى NOT_REPO: مع هوية ذات صلاحية يعني حجباً. التحليل ساكن للقراءة فقط.
# حقول الـAction (Execute وArguments وWorkingDirectory) تُحلَّل منفصلة، ولا تُدمج في سطر واحد.
# ------------------------------------------------------------
function New-Reach([string]$Status, [string]$Why = '') {
    return [pscustomobject]@{ status = $Status; repo = ($Status -eq 'REPO'); undetermined = ($Status -eq 'UNKNOWN'); why = $Why }
}

# REPO يغلب، ثم UNKNOWN، ثم NOT_REPO.
function Join-Reach($A, $B) {
    foreach ($s in @('REPO', 'UNKNOWN')) {
        if ($A.status -eq $s) { return $A }
        if ($B.status -eq $s) { return $B }
    }
    return $A
}

# رموز سطر أوامر بعلامات اقتباس مزدوجة: {value, quoted}. $null إن كانت الاقتباسات غير متوازنة أو
# ملتصقة بنص آخر (a"b c") — تفسير ملتبس لا يُخمَّن.
function Split-CommandTokens([string]$Text) {
    $t = [string]$Text
    if (([regex]::Matches($t, '"')).Count % 2 -ne 0) { return $null }
    $tokens = @()
    foreach ($m in [regex]::Matches($t, '"([^"]*)"|([^\s"]+)')) {
        $before = if ($m.Index -gt 0) { $t[$m.Index - 1] } else { ' ' }
        $end = $m.Index + $m.Length
        $after = if ($end -lt $t.Length) { $t[$end] } else { ' ' }
        if (-not [char]::IsWhiteSpace($before) -or -not [char]::IsWhiteSpace($after)) { return $null }
        if ($m.Groups[1].Success) { $tokens += [pscustomobject]@{ value = $m.Groups[1].Value; quoted = $true } }
        else { $tokens += [pscustomobject]@{ value = $m.Groups[2].Value; quoted = $false } }
    }
    return , $tokens
}

function Join-CommandTokens($Tokens) {
    return (@($Tokens | ForEach-Object { if ($_.quoted) { '"' + $_.value + '"' } else { $_.value } }) -join ' ')
}

function Test-AbsoluteTracePath([string]$Path) { return ([string]$Path -match '^[A-Za-z]:\\|^\\\\[^\\]') }

# مسار هدف: مطلق كما هو، أو نسبي إلى مجلد عمل موثوق. $null = غير قابل للإثبات.
function Resolve-TracePath([string]$Value, [string]$WorkDir) {
    $v = ([string]$Value).Trim() -replace '/', '\'
    if (-not $v) { return $null }
    if (Test-AbsoluteTracePath $v) { return (ConvertTo-CanonicalTracePath $v) }
    if ($v -match ':' -or $v.StartsWith('\')) { return $null }
    if (-not $WorkDir) { return $null }
    return (ConvertTo-CanonicalTracePath ($WorkDir + '\' + $v))
}

function New-ReachContext($Config, [string]$Identity) {
    $roots = @(@($Config.repoPath) + @($Config.trust.repositoryRoots) | Where-Object { $_ } | ForEach-Object { ConvertTo-CanonicalTracePath ([string]$_) })
    return [pscustomobject]@{ roots = $roots; identity = $Identity; seen = @{} }
}

function Test-InRepoRoot($Ctx, [string]$Candidate) {
    $n = ConvertTo-CanonicalTracePath $Candidate
    if (-not $n) { return $false }
    foreach ($root in $Ctx.roots) { if ($n -eq $root -or $n.StartsWith($root + '\')) { return $true } }
    return $false
}

# أي مسار مطلق داخل حقل واحد (لا عبر الحقول) يقع في جذر مستودع.
function Test-FieldReachesRepo($Ctx, [string]$Field) {
    foreach ($m in [regex]::Matches([string]$Field, '(?:[A-Za-z]:\\|\\\\[^\\"\s]+\\)[^"''\r\n<>|]*')) {
        if (Test-InRepoRoot $Ctx ($m.Value.Trim())) { return $true }
    }
    foreach ($tk in @(Split-CommandTokens $Field)) { if ($tk -and (Test-AbsoluteTracePath $tk.value) -and (Test-InRepoRoot $Ctx $tk.value)) { return $true } }
    return $false
}

# غلاف (vbs/cmd/bat/ps1/psm1، أو هدف مضيف سكربت) خارج المستودع: يُقرأ نصه ولا يُنفَّذ، حتى 3 مستويات.
function Get-WrapperReach($Ctx, [string]$Path, [int]$depth) {
    $k = ConvertTo-CanonicalTracePath $Path
    if ($Ctx.seen.ContainsKey($k)) { return (New-Reach 'NOT_REPO') }
    $Ctx.seen[$k] = $true
    if (Test-InRepoRoot $Ctx $Path) { return (New-Reach 'REPO' ('script inside a repository root: ' + $Path)) }
    if ($depth -ge 3) { return (New-Reach 'UNKNOWN' ('wrapper chain deeper than 3 levels at ' + $Path)) }
    try { $inner = Read-PreflightWrapperText $Path } catch { return (New-Reach 'UNKNOWN' ('wrapper cannot be read: ' + $Path)) }
    if ($null -eq $inner) { return (New-Reach 'UNKNOWN' ('wrapper cannot be read: ' + $Path)) }
    $r = New-Reach 'NOT_REPO'
    $xi = Expand-TraceText ([string]$inner) $Ctx.identity $Path
    if ($xi.undetermined) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('unresolved environment reference in wrapper ' + $Path)) }
    $inner = $xi.text
    # حمولة مشفّرة أو تنفيذ نص ديناميكي داخل الغلاف: لا يمكن إثبات هدفها.
    if ($inner -match '(?i)\s[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+[A-Za-z0-9+/=]{8,}|FromBase64String|Invoke-Expression|(?<![\w-])iex(?![\w-])') {
        $r = Join-Reach $r (New-Reach 'UNKNOWN' ('opaque/dynamic command in wrapper ' + $Path))
    }
    foreach ($line in ($inner -split "`r?`n")) {
        if (Test-FieldReachesRepo $Ctx $line) { return (New-Reach 'REPO' ('wrapper ' + $Path + ' references a repository path')) }
    }
    foreach ($m in [regex]::Matches($inner, '(?:[A-Za-z]:\\|/)[^"''\r\n<>|]+?\.(vbs|cmd|bat|ps1|psm1)\b')) {
        $r = Join-Reach $r (Get-WrapperReach $Ctx $m.Value ($depth + 1))
        if ($r.status -eq 'REPO') { return $r }
    }
    return $r
}

# هدف ثابت لمفسّر: يُحلّ ويُفحص ويُتتبَّع إن كان غلافاً. $null/غير قابل للحل ⇒ UNKNOWN.
function Get-TargetReach($Ctx, [string]$Target, [string]$WorkDir, [int]$Depth, [string]$Kind) {
    $p = Resolve-TracePath $Target $WorkDir
    if (-not $p) { return (New-Reach 'UNKNOWN' ($Kind + ' target cannot be resolved statically: ' + $Target)) }
    if (Test-InRepoRoot $Ctx $p) { return (New-Reach 'REPO' ($Kind + ' target inside a repository root: ' + $p)) }
    if ($p -match '\.(vbs|cmd|bat|ps1|psm1|js|wsf|jse|vbe)$') { return (Get-WrapperReach $Ctx $p $Depth) }
    return (New-Reach 'NOT_REPO')
}

# معاملات powershell.exe/pwsh (أسماء كاملة؛ الاختصار يُقبل إن كان بادئة فريدة كما يفعل PowerShell).
$script:PsValueParams = @('psconsolefile', 'version', 'inputformat', 'outputformat', 'windowstyle', 'configurationname', 'executionpolicy', 'workingdirectory', 'settingsfile', 'custompipename')
$script:PsFlagParams = @('nologo', 'noexit', 'sta', 'mta', 'noprofile', 'noninteractive', 'noprofileloadtime', 'login', 'interactive', 'help')
$script:PsAllParams = @($script:PsValueParams + $script:PsFlagParams + @('encodedcommand', 'encodedarguments', 'file', 'command', 'commandwithargs'))

function Resolve-PsParamName([string]$Name) {
    $n = $Name.ToLowerInvariant()
    switch ($n) { 'e' { return 'encodedcommand' } 'ec' { return 'encodedcommand' } 'ea' { return 'encodedarguments' } 'c' { return 'command' } 'f' { return 'file' } 'ep' { return 'executionpolicy' } 'ex' { return 'executionpolicy' } 'cwa' { return 'commandwithargs' } 'wd' { return 'workingdirectory' } 'w' { return 'windowstyle' } }
    if ($script:PsAllParams -contains $n) { return $n }
    $c = @($script:PsAllParams | Where-Object { $_.StartsWith($n) })
    if ($c.Count -eq 1) { return $c[0] }
    return $null
}

# -Command: يُقبل فقط استدعاء سكربت ps1 بمسار مطلق ثابت بلا تعابير أخرى؛ غير ذلك غير قابل للإثبات.
function Get-PsCommandReach($Ctx, [string]$Command, [string]$WorkDir, [int]$Depth) {
    $m = [regex]::Match([string]$Command, '^\s*(?:&\s*)?([''"]?)([A-Za-z]:\\[^''"\r\n;|&`$(){}]+?\.ps1)\1(\s+[^;|&`$(){}@\r\n]*)?\s*$')
    if (-not $m.Success) { return (New-Reach 'UNKNOWN' 'PowerShell -Command without a provable static target') }
    return (Get-TargetReach $Ctx $m.Groups[2].Value $WorkDir $Depth 'PowerShell -Command')
}

function Get-PowerShellReach($Ctx, $Tokens, [string]$WorkDir, [int]$Depth, [bool]$IsPwsh) {
    $wd = $WorkDir
    $i = 0
    while ($i -lt $Tokens.Count) {
        $tk = $Tokens[$i]
        $v = [string]$tk.value
        if (-not $tk.quoted -and $v -match '^[-/]([A-Za-z]+)(?::(.*))?$') {
            $name = Resolve-PsParamName $Matches[1]
            $inline = $Matches[2]
            if (-not $name) { return (New-Reach 'UNKNOWN' ('unrecognised or ambiguous PowerShell parameter: ' + $v)) }
            if ($name -eq 'encodedcommand' -or $name -eq 'encodedarguments') { return (New-Reach 'UNKNOWN' 'PowerShell -EncodedCommand: payload cannot be inspected statically') }
            if ($script:PsFlagParams -contains $name) { $i++; continue }
            $value = $inline
            $step = 1
            if ($null -eq $value) { if ($i + 1 -ge $Tokens.Count) { return (New-Reach 'UNKNOWN' ('PowerShell parameter without a value: ' + $v)) }; $value = [string]$Tokens[$i + 1].value; $step = 2 }
            if ($name -eq 'file') { return (Get-TargetReach $Ctx $value $wd $Depth 'PowerShell -File') }
            if ($name -eq 'command' -or $name -eq 'commandwithargs') {
                $rest = if ($null -ne $inline) { @($Tokens | Select-Object -Skip ($i + 1)) } else { @($Tokens | Select-Object -Skip ($i + 2)) }
                $cmd = ($value + ' ' + (Join-CommandTokens $rest)).Trim()
                if ($cmd -eq '-') { return (New-Reach 'UNKNOWN' 'PowerShell -Command - reads the command from stdin') }
                return (Get-PsCommandReach $Ctx $cmd $wd $Depth)
            }
            if ($name -eq 'workingdirectory') {
                $wdp = Resolve-TracePath $value $wd
                if (-not $wdp) { return (New-Reach 'UNKNOWN' ('PowerShell -WorkingDirectory cannot be resolved: ' + $value)) }
                if (Test-InRepoRoot $Ctx $wdp) { return (New-Reach 'REPO' ('PowerShell working directory inside a repository root: ' + $wdp)) }
                $wd = $wdp
            }
            $i += $step
            continue
        }
        # أول وسيط موضعي: powershell.exe يعامله كـ-Command، وpwsh كـ-File.
        if ($IsPwsh) { return (Get-TargetReach $Ctx $v $wd $Depth 'pwsh positional -File') }
        return (Get-PsCommandReach $Ctx (Join-CommandTokens @($Tokens | Select-Object -Skip $i)) $wd $Depth)
    }
    return (New-Reach 'UNKNOWN' 'PowerShell invocation without a static -File/-Command target')
}

# سطر cmd بعد /c: يُقسَّم على & و&& و|| و| خارج الاقتباس، وكل مقطع يُصنَّف كـAction مستقل.
function Get-CmdLineReach($Ctx, [string]$Line, [string]$WorkDir, [int]$Depth) {
    $text = [string]$Line
    # cmd يزيل الاقتباس الخارجي إن بدأ السطر بـ" وانتهى بـ" واحتوى اقتباسات داخلية.
    if ($null -eq (Split-CommandTokens $text) -and $text -match '^\s*"(.*)"\s*$') { $text = $Matches[1] }
    $unquoted = [regex]::Replace($text, '"[^"]*"', '""')
    if ($unquoted -match '[\^()]') { return (New-Reach 'UNKNOWN' 'cmd command uses escapes/blocks that cannot be parsed statically') }
    # إعادة التوجيه ليست تنفيذاً: تُحذف قبل التقسيم (المسار المطلق فيها فُحص مسبقاً على مستوى الحقل).
    $text = [regex]::Replace($text, '\d?>>?&\d|\d?>>?\s*("[^"]*"|[^\s&|]+)|<\s*("[^"]*"|[^\s&|]+)', ' ')
    $segments = @()
    $cur = New-Object System.Text.StringBuilder
    $inQ = $false
    for ($j = 0; $j -lt $text.Length; $j++) {
        $ch = $text[$j]
        if ($ch -eq '"') { $inQ = -not $inQ }
        if (-not $inQ -and ($ch -eq '&' -or $ch -eq '|')) {
            $segments += $cur.ToString(); [void]$cur.Clear()
            if ($j + 1 -lt $text.Length -and $text[$j + 1] -eq $ch) { $j++ }
            continue
        }
        [void]$cur.Append($ch)
    }
    $segments += $cur.ToString()
    $wd = $WorkDir
    $r = New-Reach 'NOT_REPO'
    foreach ($seg in $segments) {
        $tokens = Split-CommandTokens $seg
        if ($null -eq $tokens) { return (Join-Reach $r (New-Reach 'UNKNOWN' ('cmd segment cannot be parsed unambiguously: ' + $seg.Trim()))) }
        $tokens = @($tokens)
        if ($tokens.Count -eq 0) { continue }
        $head = ([string]$tokens[0].value).ToLowerInvariant()
        if (-not $tokens[0].quoted) {
            if (@('echo', 'rem', 'exit', 'cls', 'ver', 'title', 'setlocal', 'endlocal', 'set', 'timeout') -contains $head) { continue }
            if (@('if', 'for', 'goto', 'call:', 'shift') -contains $head -or $head.StartsWith(':')) { return (Join-Reach $r (New-Reach 'UNKNOWN' ('cmd control flow cannot be evaluated statically: ' + $head))) }
            if ($head -eq 'cd' -or $head -eq 'chdir' -or $head -eq 'pushd') {
                $args2 = @($tokens | Select-Object -Skip 1 | Where-Object { -not ($_.value -match '^/[dD]$') })
                if ($args2.Count -ne 1) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'cmd directory change cannot be resolved')) }
                $wdp = Resolve-TracePath $args2[0].value $wd
                if (-not $wdp) { return (Join-Reach $r (New-Reach 'UNKNOWN' ('cmd directory change cannot be resolved: ' + $args2[0].value))) }
                if (Test-InRepoRoot $Ctx $wdp) { return (New-Reach 'REPO' ('cmd changes directory into a repository root: ' + $wdp)) }
                $wd = $wdp
                continue
            }
            if ($head -eq 'call') { $tokens = @($tokens | Select-Object -Skip 1) }
            elseif ($head -eq 'start') {
                $tokens = @($tokens | Select-Object -Skip 1)
                while ($tokens.Count -gt 0 -and -not $tokens[0].quoted -and $tokens[0].value.StartsWith('/')) {
                    if ($tokens[0].value -match '^/[dD]$' -and $tokens.Count -gt 1) {
                        $wdp = Resolve-TracePath $tokens[1].value $wd
                        if (-not $wdp) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'start /D cannot be resolved')) }
                        if (Test-InRepoRoot $Ctx $wdp) { return (New-Reach 'REPO' ('start /D inside a repository root: ' + $wdp)) }
                        $wd = $wdp
                        $tokens = @($tokens | Select-Object -Skip 2)
                        continue
                    }
                    $tokens = @($tokens | Select-Object -Skip 1)
                }
                if ($tokens.Count -ge 2 -and $tokens[0].quoted) { $tokens = @($tokens | Select-Object -Skip 1) }
            }
        }
        if ($tokens.Count -eq 0) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'cmd call/start without a target')) }
        $r = Join-Reach $r (Get-ActionReach $Ctx ([string]$tokens[0].value) (Join-CommandTokens @($tokens | Select-Object -Skip 1)) $wd ($Depth + 1))
        if ($r.status -eq 'REPO') { return $r }
    }
    return $r
}

$script:ScriptExtensions = 'ps1|psm1|vbs|vbe|js|jse|wsf|cmd|bat|mjs|cjs|py|pyw|rb|pl|php|sh|jar'

# Action واحد بحقول منفصلة. $Execute وحده هو البرنامج؛ لا يبتلع الوسائط ولا مجلد العمل.
function Get-ActionReach($Ctx, [string]$Execute, [string]$Arguments, [string]$WorkingDirectory, [int]$Depth) {
    if ($Depth -ge 4) { return (New-Reach 'UNKNOWN' 'command nesting deeper than 3 levels') }
    $r = New-Reach 'NOT_REPO'
    $fx = @{}
    foreach ($pair in @(@('execute', $Execute), @('arguments', $Arguments), @('workingDirectory', $WorkingDirectory))) {
        $x = Expand-TraceText ([string]$pair[1]) $Ctx.identity
        if ($x.undetermined) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('unresolved environment reference in ' + $pair[0])) }
        $fx[$pair[0]] = [string]$x.text
    }
    # مجلد العمل: مطلق فقط؛ داخل المستودع ⇒ REPO (الهدف النسبي يُحلّ بالنسبة إليه).
    $wd = $fx['workingDirectory'].Trim()
    if ($wd.StartsWith('"')) { if ($wd -notmatch '^"[^"]+"$') { return (Join-Reach $r (New-Reach 'UNKNOWN' 'malformed quoting in working directory')) }; $wd = $wd.Trim('"') }
    if ($wd) {
        if (-not (Test-AbsoluteTracePath $wd) -or $wd.Contains('"')) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('working directory is not an absolute path: ' + $wd)); $wd = '' }
        elseif (Test-InRepoRoot $Ctx $wd) { return (New-Reach 'REPO' ('working directory inside a repository root: ' + $wd)) }
        else { $wd = ConvertTo-CanonicalTracePath $wd }
    }
    foreach ($f in @('execute', 'arguments')) {
        if (Test-FieldReachesRepo $Ctx $fx[$f]) { return (New-Reach 'REPO' ('repository path in action ' + $f)) }
    }
    # البرنامج.
    $exe = $fx['execute'].Trim()
    if ($exe.StartsWith('"')) {
        if ($exe -notmatch '^"[^"]+"$') { return (Join-Reach $r (New-Reach 'UNKNOWN' 'malformed quoting in executable')) }
        $exe = $exe.Trim('"')
    } elseif ($exe.Contains('"')) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'malformed quoting in executable')) }
    if (-not $exe) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'action has no executable')) }
    $leaf = (($exe -replace '/', '\') -split '\\')[-1].ToLowerInvariant()
    if ($exe -match '[\\/]' -or $leaf -match ('\.(' + $script:ScriptExtensions + ')$')) {
        $r = Join-Reach $r (Get-TargetReach $Ctx $exe $wd $Depth 'executable')
        if ($r.status -eq 'REPO') { return $r }
    }
    $tokens = Split-CommandTokens $fx['arguments']
    if ($null -eq $tokens) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'arguments cannot be parsed unambiguously')) }
    $tokens = @($tokens)
    $name = $leaf -replace '\.(exe|com)$', ''
    switch -regex ($name) {
        '^(powershell|pwsh)$' { return (Join-Reach $r (Get-PowerShellReach $Ctx $tokens $wd $Depth ($name -eq 'pwsh'))) }
        '^cmd$' {
            $m = [regex]::Match($fx['arguments'], '^\s*(?:/(?:[dqasu]|[efv]:(?:on|off)|t:[0-9a-f]{1,2})\s+)*/[ckr]\s+(.*)$', 'IgnoreCase, Singleline')
            if (-not $m.Success) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'cmd invocation without a parsable /c command')) }
            return (Join-Reach $r (Get-CmdLineReach $Ctx $m.Groups[1].Value $wd $Depth))
        }
        '^(wscript|cscript)$' {
            $target = @($tokens | Where-Object { $_.quoted -or -not $_.value.StartsWith('//') }) | Select-Object -First 1
            if (-not $target) { return (Join-Reach $r (New-Reach 'UNKNOWN' ($name + ' without a script target'))) }
            return (Join-Reach $r (Get-TargetReach $Ctx $target.value $wd $Depth $name))
        }
        '^(node|nodejs|python\d*(\.\d+)?|pythonw|py|pyw|ruby|perl|php|bash|sh|java|javaw|deno|bun|mshta|rundll32|regsvr32|msbuild|dotnet|npm|npx|git|bash)$' {
            # مفسّر: شيفرة مضمّنة أو وحدة محمَّلة غير قابلة للإثبات؛ الهدف الموضعي الأول يجب أن يُحلّ.
            $inline = @('-e', '--eval', '-p', '--print', '-c', '-m', '-r', '--require', '--import', '--loader', '--experimental-loader', '-x', '--command', 'run', 'exec', 'x', '-i')
            foreach ($t in $tokens) { if (-not $t.quoted -and ($inline -contains $t.value.ToLowerInvariant() -or $t.value -match '^(javascript|vbscript):')) { return (Join-Reach $r (New-Reach 'UNKNOWN' ($name + ' inline code/module cannot be inspected statically: ' + $t.value))) } }
            $target = @($tokens | Where-Object { $_.quoted -or -not ($_.value.StartsWith('-') -or $_.value.StartsWith('/')) }) | Select-Object -First 1
            if (-not $target) { return (Join-Reach $r (New-Reach 'UNKNOWN' ($name + ' invocation without a static target'))) }
            $tv = ([string]$target.value) -replace ',[^\\/]*$', ''
            return (Join-Reach $r (Get-TargetReach $Ctx $tv $wd $Depth $name))
        }
        default {
            # برنامج عادي: كل وسيط يشبه سكربتاً يُحلّ؛ النسبي بلا مجلد عمل ⇒ غير قابل للإثبات.
            foreach ($t in $tokens) {
                if ($t.value -match ('\.(' + $script:ScriptExtensions + ')$')) {
                    $r = Join-Reach $r (Get-TargetReach $Ctx $t.value $wd $Depth ('argument of ' + $name))
                    if ($r.status -eq 'REPO') { return $r }
                }
            }
            return $r
        }
    }
}

# مهمة مجدولة: كل Action بحقوله المنظّمة. لا Actions مقروءة ⇒ UNKNOWN.
function Resolve-TaskReach($Config, $Actions, [string]$Identity = '') {
    $acts = @($Actions | Where-Object { $null -ne $_ })
    if ($acts.Count -eq 0) { return (New-Reach 'UNKNOWN' 'task actions are not readable') }
    $r = New-Reach 'NOT_REPO'
    foreach ($a in $acts) {
        $ctx = New-ReachContext $Config $Identity
        $classId = if ($a.PSObject.Properties['classId']) { [string]$a.classId } else { '' }
        if ($classId) {
            # COM handler: يُقيَّم ملفه المسجَّل؛ غير محلول ⇒ UNKNOWN.
            if (-not $a.execute) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('COM handler ' + $classId + ' cannot be resolved to a binary')); continue }
            $p = [string]$a.execute
            if (Test-InRepoRoot $ctx $p) { return (New-Reach 'REPO' ('COM handler binary inside a repository root: ' + $p)) }
            if (-not (Test-AbsoluteTracePath $p)) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('COM handler binary path is not absolute: ' + $p)) }
            continue
        }
        $r = Join-Reach $r (Get-ActionReach $ctx ([string]$a.execute) ([string]$a.arguments) ([string]$a.workingDirectory) 0)
        if ($r.status -eq 'REPO') { return $r }
    }
    return $r
}

# سطر أوامر واحد (مسار خدمة): البرنامج أولاً (مقتبس، أو حتى .exe، أو أول رمز) ثم الوسائط.
function Resolve-WorkloadReach($Config, [string]$ActionText, [string]$Identity = '') {
    $t = ([string]$ActionText).Trim()
    if (-not $t) { return (New-Reach 'UNKNOWN' 'empty command line') }
    $m = [regex]::Match($t, '^"([^"]+)"\s*(.*)$', 'Singleline')
    if (-not $m.Success) { $m = [regex]::Match($t, '^(.+?\.(?:exe|com))(?:\s+(.*))?$', 'IgnoreCase, Singleline') }
    if (-not $m.Success) { $m = [regex]::Match($t, '^(\S+)(?:\s+(.*))?$', 'Singleline') }
    return (Get-ActionReach (New-ReachContext $Config $Identity) $m.Groups[1].Value $m.Groups[2].Value '' 0)
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
    if ($acts[0].PSObject.Properties['classId'] -and $acts[0].classId) { return 'COM handler action is not the gate script' }
    $wdv = ([string]$acts[0].workingDirectory).Trim().Trim('"')
    if ($wdv -and (ConvertTo-CanonicalTracePath $wdv) -ne (ConvertTo-CanonicalTracePath ([string]$Config.gateDir))) { return ('working directory must be empty or gateDir: ' + $wdv) }
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
    $gateTaskPath = if ($trust.PSObject.Properties['gateTaskPath'] -and $trust.gateTaskPath) { [string]$trust.gateTaskPath } else { '\' }

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

    # Initialize يتطلب مهمة بوابة واحدة بالضبط، مسجّلة ومقروءة ومطابقة للعقد بالكامل (Codex P1).
    # غيابها لا يعني «لا شيء للفحص»: المهمة تُسجَّل في مرحلة bootstrap (معطّلة) قبل Initialize.
    $gateTaskItem = $null
    if (-not $gateTask) { $results += & $block 'gate task' 'no gateTaskName configured' }
    else {
        $named = @($inventory | Where-Object { $_.kind -eq 'task' -and ([string]$_.name) -eq $gateTask })
        if ($named.Count -eq 0) { $results += & $block 'gate task' ('gate task ' + $gateTask + ' is not registered: Initialize requires exactly one validated gate task (register it in the bootstrap phase, disabled, before Initialize)') }
        elseif ($named.Count -gt 1) { $results += & $block 'gate task' ('duplicate gate tasks: ' + $named.Count + ' tasks named ' + $gateTask + ' (' + (@($named | ForEach-Object { [string]$_.path }) -join ', ') + ')') }
        else {
            $gateTaskItem = $named[0]
            $gsub = 'task ' + ([string]$gateTaskItem.path) + $gateTask
            if (([string]$gateTaskItem.path) -ne $gateTaskPath) { $results += & $block $gsub ('gate task path is ' + $gateTaskItem.path + ', expected ' + $gateTaskPath) }
            $gid = ([string]$gateTaskItem.identity).Trim()
            $gidSid = Resolve-PrincipalSid $gid
            if (-not $gid -or -not $gidSid) { $results += & $block $gsub ('gate task identity not verifiable: ' + $gid) }
            elseif ($gidSid -ne $gate) { $results += & $block $gsub ('gate task must run as the dedicated gate identity ' + $gateName + '; found ' + $gid) }
            $why = Test-ExactGateAction $Config $gateTaskItem
            if ($why) { $results += & $block $gsub ('the gate task must run only the gate scripts in gateDir: ' + $why) }
        }
    }
    # أي مهمة أخرى تشبه البوابة (اسماً أو تشغّل سكربتاتها) تتعارض معها.
    $gateDirKey = ConvertTo-CanonicalTracePath ([string]$Config.gateDir)
    foreach ($t in @($inventory | Where-Object { $_.kind -eq 'task' -and -not [object]::ReferenceEquals($_, $gateTaskItem) -and ([string]$_.name) -ne $gateTask })) {
        $fields = @(@($t.actions) | ForEach-Object { if ($_) { [string]$_.execute; [string]$_.arguments; [string]$_.workingDirectory } })
        $touchesGate = @($fields | Where-Object { ($gateDirKey -and (ConvertTo-PreflightPath $_).Contains($gateDirKey)) -or $_ -match '(?i)deploy-gate\.ps1' }).Count -gt 0
        if ($touchesGate -or ([string]$t.name) -like '*Deploy*Gate*') { $results += & $block ('task ' + ([string]$t.path) + $t.name) ('gate-like task conflicts with the single gate task ' + $gateTask) }
    }

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
        # المهام بحقولها المنظّمة؛ الخدمات بسطر أوامرها (PathName). ثلاثي الحالة، وUNKNOWN لا يصير NOT_REPO.
        if ($item.kind -eq 'task') { $reach = Resolve-TaskReach $Config $item.actions ([string]$item.identity) }
        else { $reach = Resolve-WorkloadReach $Config ([string]$item.action) ([string]$item.identity) }
        $isRepo = $reach.status -eq 'REPO'
        # لا يمكن إثبات أن الـAction لا يصل إلى المستودع، والهوية ذات صلاحية (أو غير معروفة) ⇒ حجب.
        $maybePrivileged = (-not $key) -or $key -eq 'S-1-5-18' -or $key -eq 'S-1-5-32-544' -or $key -eq $gate -or ($null -eq $adminKeys) -or ($adminKeys -contains $key)
        if ($reach.status -eq 'UNKNOWN' -and $maybePrivileged) {
            $results += & $block $subject ('cannot determine whether this ' + $item.kind + ' reaches a repository workload (identity ' + $item.identity + '): ' + $reach.why)
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
            if ($item.kind -eq 'task' -and [object]::ReferenceEquals($item, $gateTaskItem)) {
                if ($isRepo) { $results += & $block $subject 'the gate task must run only the gate scripts in gateDir: reaches a repository root' }
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
