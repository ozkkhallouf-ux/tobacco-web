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
        # نوع الـprincipal صراحة من تعريف المهمة (Codex P1): UserId ⇒ USER، GroupId ⇒ GROUP (تعمل ضمن جلسة أي
        # عضو، وقد يكون مديراً)، وغير ذلك (كلاهما أو لا شيء أو LogonType=Group مع UserId) ⇒ UNKNOWN.
        $uid = ([string]$t.Principal.UserId).Trim()
        $gid = ([string]$t.Principal.GroupId).Trim()
        $ptype = 'UNKNOWN'
        if ($uid -and -not $gid -and ([string]$t.Principal.LogonType) -ne 'Group') { $ptype = 'USER' }
        elseif ($gid -and -not $uid) { $ptype = 'GROUP' }
        $id = $uid
        if ($ptype -eq 'GROUP') { $id = $gid }
        $rl = 'UNKNOWN'
        switch ([string]$t.Principal.RunLevel) { 'Limited' { $rl = 'LeastPrivilege' } 'Highest' { $rl = 'HighestAvailable' } }
        # الحقول تبقى منفصلة (Codex P1): لا دمج Execute/Arguments/WorkingDirectory في سطر واحد.
        $acts = @($t.Actions | ForEach-Object {
            $cls = if ($_.PSObject.Properties['ClassId']) { [string]$_.ClassId } else { '' }
            if ($cls) { [pscustomobject]@{ execute = (Get-PreflightComHandlerPath $cls); arguments = ''; workingDirectory = ''; classId = $cls } }
            else { [pscustomobject]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory } }
        })
        $out += [pscustomobject]@{ name = [string]$t.TaskName; path = [string]$t.TaskPath; identity = $id; principalType = $ptype; userId = $uid; groupId = $gid; runLevel = $rl; state = [string]$t.State; actions = $acts }
    }
    return $out
}

# ------------------------------------------------------------
# جرد Startup/Logon (Codex P1): مجلدات Startup ومفاتيح Run/RunOnce للجهاز ولكل ملف تعريف مستخدم.
# كل عنصر يُصنَّف بحقول Action منظّمة وبالهوية التي سيعمل تحتها فعلياً:
#   - مصادر الجهاز (Startup العام، HKLM Run/RunOnce) تعمل عند دخول أي مستخدم، ومنهم المدراء ⇒
#     هوية Administrators (S-1-5-32-544) لقرار الصلاحية.
#   - مصادر المستخدم (Startup الخاص، HKU\<SID> Run/RunOnce) تعمل بهوية ذلك المستخدم (SID).
# مصدر مطلوب لا يُقرأ يصير عنصراً بلا Actions ⇒ UNKNOWN (لا «لا شيء»)؛ فشل الجرد كله ⇒ حجب.
# قراءة فقط: لا تحميل hive ولا تعديل سجل ولا تشغيل أي عنصر.
# ------------------------------------------------------------
$script:AnyLogonSid = 'S-1-5-32-544'
$script:AnyLogonIdentity = 'any interactive user at logon (incl. Administrators)'

function New-StartupItem([string]$Source, [string]$Name, [string]$Sid, [string]$Identity, $Actions, [string]$Unreadable = '') {
    return [pscustomobject]@{ kind = 'startup'; name = $Name; path = ($Source + ': '); identity = $Identity; sid = $Sid; actions = @($Actions); unreadable = $Unreadable }
}

# سطر أوامر (قيمة Run أو مسار خدمة) ⇒ Action منظّم: البرنامج (مقتبس، أو حتى .exe، أو أول رمز) ثم الوسائط.
function ConvertTo-CommandAction([string]$Line) {
    $t = ([string]$Line).Trim()
    $m = [regex]::Match($t, '^"([^"]+)"\s*(.*)$', 'Singleline')
    if (-not $m.Success) { $m = [regex]::Match($t, '^(.+?\.(?:exe|com))(?:\s+(.*))?$', 'IgnoreCase, Singleline') }
    if (-not $m.Success) { $m = [regex]::Match($t, '^(\S+)(?:\s+(.*))?$', 'Singleline') }
    return [pscustomobject]@{ execute = $m.Groups[1].Value; arguments = $m.Groups[2].Value; workingDirectory = '' }
}

# عناصر مجلد Startup: .lnk بهدفه ووسائطه ومجلد عمله (قراءة فقط عبر WScript.Shell)، وغيره كملف يُفتح.
function Get-StartupFolderItems([string]$Folder, [string]$Source, [string]$Sid, [string]$Identity) {
    if (-not (Test-Path -LiteralPath $Folder)) { return @() }
    try { $files = @(Get-ChildItem -LiteralPath $Folder -Force -File -ErrorAction Stop) } catch { return @(New-StartupItem $Source $Folder $Sid $Identity @() ('startup folder cannot be read: ' + $_.Exception.Message)) }
    $items = @()
    foreach ($f in $files) {
        if ($f.Name -ieq 'desktop.ini') { continue }
        if ($f.Extension -ieq '.lnk') {
            try {
                $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($f.FullName)
                $act = [pscustomobject]@{ execute = [string]$sc.TargetPath; arguments = [string]$sc.Arguments; workingDirectory = [string]$sc.WorkingDirectory }
                if (-not $act.execute) { $items += New-StartupItem $Source $f.Name $Sid $Identity @() 'shortcut target cannot be resolved'; continue }
                $items += New-StartupItem $Source $f.Name $Sid $Identity @($act)
            } catch { $items += New-StartupItem $Source $f.Name $Sid $Identity @() ('shortcut cannot be read: ' + $_.Exception.Message) }
        } elseif ($f.Extension -match '^\.(exe|com|bat|cmd|vbs|vbe|js|jse|wsf|ps1)$') {
            $items += New-StartupItem $Source $f.Name $Sid $Identity @([pscustomobject]@{ execute = $f.FullName; arguments = ''; workingDirectory = $Folder })
        } else {
            # يُفتح عبر ارتباط نوع الملف (مثل .url أو .jar): البرنامج الفعلي غير مثبت ساكناً.
            $items += New-StartupItem $Source $f.Name $Sid $Identity @() ('startup file is opened via a file association that cannot be resolved statically: ' + $f.Name)
        }
    }
    return $items
}

function Get-RunKeyItems([string]$Key, [string]$Source, [string]$Sid, [string]$Identity) {
    if (-not (Test-Path -LiteralPath $Key)) { return @() }
    try { $k = Get-Item -LiteralPath $Key -ErrorAction Stop } catch { return @(New-StartupItem $Source $Key $Sid $Identity @() ('Run key cannot be read: ' + $_.Exception.Message)) }
    $items = @()
    foreach ($n in @($k.GetValueNames())) {
        $v = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
        if (-not $v) { $items += New-StartupItem $Source $n $Sid $Identity @() 'Run value is empty or unreadable'; continue }
        $items += New-StartupItem $Source $n $Sid $Identity @(ConvertTo-CommandAction $v)
    }
    return $items
}

function Get-PreflightStartupInventory {
    $out = @()
    $runKeys = @('Microsoft\Windows\CurrentVersion\Run', 'Microsoft\Windows\CurrentVersion\RunOnce')
    $common = [Environment]::GetFolderPath('CommonStartup')
    if (-not $common) { throw 'the all-users Startup folder path is not available' }
    $out += @(Get-StartupFolderItems $common 'Startup (all users)' $script:AnyLogonSid $script:AnyLogonIdentity)
    foreach ($rk in $runKeys) {
        foreach ($hive in @('HKLM:\SOFTWARE\', 'HKLM:\SOFTWARE\WOW6432Node\')) { $out += @(Get-RunKeyItems ($hive + $rk) ('HKLM ' + $rk) $script:AnyLogonSid $script:AnyLogonIdentity) }
    }
    # ملفات تعريف المستخدمين المحليين/المجال (S-1-5-21-*): مجلد Startup الخاص وRun/RunOnce من HKU.
    foreach ($p in @(Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' -ErrorAction Stop)) {
        $sid = [string]$p.PSChildName
        if ($sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { continue }
        $img = [Environment]::ExpandEnvironmentVariables([string]$p.GetValue('ProfileImagePath'))
        if (-not $img) { $out += New-StartupItem ('profile ' + $sid) $sid $sid $sid @() 'profile path cannot be read'; continue }
        $out += @(Get-StartupFolderItems (Join-Path $img 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup') ('Startup (' + $sid + ')') $sid $sid)
        $hku = 'Registry::HKEY_USERS\' + $sid
        if (-not (Test-Path -LiteralPath $hku)) {
            # الـhive غير محمّل (المستخدم غير متصل): لا نحمّله (تعديل)، ولا نفترض أنه فارغ.
            $out += New-StartupItem ('HKU ' + $sid) 'Run/RunOnce' $sid $sid @() 'user registry hive is not loaded; per-user Run/RunOnce cannot be inventoried'
            continue
        }
        foreach ($rk in $runKeys) { $out += @(Get-RunKeyItems ($hku + '\Software\' + $rk) ('HKU ' + $sid + ' ' + $rk) $sid $sid) }
    }
    return $out
}

# ------------------------------------------------------------
# هوية المسار في نظام الملفات (Codex P1): قرار REPO/NOT_REPO لا يُتخذ بالنص وحده. junction وsymlink
# واسم 8.3 القصير قد تجعل C:\runner هو جذر المستودع فعلياً. نقطة تماس واحدة تحلّ المسار إلى مساره
# النهائي عبر Windows نفسه: CreateFileW (بلا FILE_FLAG_OPEN_REPARSE_POINT، فيتبع كل reparse point) ثم
# GetFinalPathNameByHandleW (FILE_NAME_NORMALIZED: أسماء طويلة وحالة أحرف فعلية). .NET Framework في
# PowerShell 5.1 لا يوفّر ذلك، فالاستدعاء native محدود ومركزي هنا فقط. قراءة فقط: لا يُفتح الملف
# للقراءة أو الكتابة (access = 0) ولا يُمشى أي مجلد.
# النتيجة: OK (موجود؛ path نهائي)، أو MISSING (غير موجود؛ path = المسار النهائي لأقرب سلف موجود + الباقي)،
# أو ERROR (reparse لا يُحلّ، رفض وصول، خطأ آخر) ⇒ UNKNOWN عند المستدعي، لا NOT_REPO أبداً.
# ------------------------------------------------------------
$script:GateFsSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace OzkGateFs {
    public static class FinalPath {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFileAttributesW(string name);
        public const uint Invalid = 0xFFFFFFFF;
        public static uint Attributes(string path, out int error) {
            uint a = GetFileAttributesW(path);
            error = (a == Invalid) ? Marshal.GetLastWin32Error() : 0;
            return a;
        }
        public static string Resolve(string path, out int error) {
            error = 0;
            // 0 = بلا حق قراءة/كتابة؛ مشاركة كاملة؛ OPEN_EXISTING؛ FILE_FLAG_BACKUP_SEMANTICS (للمجلدات).
            using (SafeFileHandle h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
                if (h.IsInvalid) { error = Marshal.GetLastWin32Error(); return null; }
                StringBuilder sb = new StringBuilder(1024);
                uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
                if (n == 0) { error = Marshal.GetLastWin32Error(); return null; }
                if (n >= sb.Capacity) {
                    sb = new StringBuilder((int)n + 2);
                    n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
                    if (n == 0 || n >= sb.Capacity) { error = (n == 0) ? Marshal.GetLastWin32Error() : 122; return null; }
                }
                return sb.ToString();
            }
        }
    }
}
'@

function New-PathResolution([string]$Status, [string]$Path, [string]$Reason = '') { return [pscustomobject]@{ status = $Status; path = $Path; reason = $Reason } }

# \\?\C:\x ⇒ C:\x، و\\?\UNC\srv\share ⇒ \\srv\share؛ غير ذلك (مثل \\?\Volume{...}) يبقى كما هو.
function ConvertFrom-Win32FinalPath([string]$Path) {
    if ($Path.StartsWith('\\?\UNC\')) { return '\\' + $Path.Substring(8) }
    if ($Path -match '^\\\\\?\\[A-Za-z]:\\') { return $Path.Substring(4) }
    return $Path
}

function Resolve-PreflightFinalPath([string]$Path) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return (New-PathResolution 'ERROR' '' 'filesystem identity can only be resolved on Windows') }
    if (-not ('OzkGateFs.FinalPath' -as [type])) {
        try { Add-Type -TypeDefinition $script:GateFsSource -Language CSharp -ErrorAction Stop } catch { return (New-PathResolution 'ERROR' '' ('native path resolver unavailable: ' + $_.Exception.Message)) }
    }
    $p = (([string]$Path).Trim() -replace '/', '\')
    if (-not (Test-AbsoluteTracePath $p)) { return (New-PathResolution 'ERROR' '' ('not an absolute path: ' + $Path)) }
    $cur = $p.TrimEnd('\')
    if ($cur -match '^[A-Za-z]:$') { $cur += '\' }
    $rest = @()
    for ($i = 0; $i -lt 64; $i++) {
        $e = 0
        $attrs = [OzkGateFs.FinalPath]::Attributes($cur, [ref]$e)
        if ($attrs -ne [OzkGateFs.FinalPath]::Invalid) {
            # المدخل موجود (قد يكون reparse point): مساره النهائي عبر Windows، وإلا ERROR (مكسور/مرفوض).
            $e2 = 0
            $final = [OzkGateFs.FinalPath]::Resolve($cur, [ref]$e2)
            if (-not $final) {
                $kind = 'entry'
                if (($attrs -band 0x400) -ne 0) { $kind = 'reparse point (junction/symlink)' }
                return (New-PathResolution 'ERROR' '' ('the final path of ' + $kind + ' ' + $cur + ' cannot be resolved (Win32 error ' + $e2 + ')'))
            }
            $final = ConvertFrom-Win32FinalPath $final
            if ($rest.Count -eq 0) { return (New-PathResolution 'OK' $final) }
            return (New-PathResolution 'MISSING' ($final.TrimEnd('\') + '\' + ($rest -join '\')) ('does not exist: ' + $p))
        }
        if ($e -ne 2 -and $e -ne 3) { return (New-PathResolution 'ERROR' '' ('cannot read ' + $cur + ' (Win32 error ' + $e + ')')) }
        $cut = $cur.TrimEnd('\').LastIndexOf('\')
        if ($cut -le 1) { return (New-PathResolution 'ERROR' '' ('no existing ancestor for ' + $p)) }
        $rest = @($cur.TrimEnd('\').Substring($cut + 1)) + $rest
        $cur = $cur.Substring(0, $cut)
        if ($cur -match '^[A-Za-z]:$') { $cur += '\' }
    }
    return (New-PathResolution 'ERROR' '' ('path too deep to resolve: ' + $p))
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
        access = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { [pscustomobject]@{ identity = [string]$_.IdentityReference.Value; rights = [string]$_.FileSystemRights; type = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited; inheritOnly = (($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) } })
    }
}

# نص غلاف: '' إن لم يوجد؛ يرمي إن وُجد وتعذّرت قراءته (⇒ «غير محدد» لدى المستدعي).
# نص غلاف: $null إن لم يوجد كملف (مفقود، أو مجلد، أو اختفى)، ويرمي عند فشل القراءة. فشل القراءة لا
# يتحوّل أبداً إلى نص فارغ صالح (Codex P1)؛ النص الفارغ يعني ملفاً موجوداً طوله صفر فعلاً.
function Read-PreflightWrapperText([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
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
    # هوية بلا اسم حساب (SID غير SYSTEM، أو «أي مستخدم عند الدخول») ⇒ ملف التعريف غير مثبت ⇒ غير محدد.
    if ($Identity -eq $script:AnyLogonIdentity -or ($Identity -match '^[Ss]-1(-\d+)+$' -and $Identity -ne 'S-1-5-18')) { return $null }
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

# جذور المستودع بصيغتيها: النصية والنهائية في نظام الملفات. جذر لا يُحلّ إلى مسار نهائي موجود ⇒
# rootErrors (لا يسقط بصمت)، وكل قرار احتواء بعدها UNKNOWN.
function New-ReachContext($Config, [string]$Identity) {
    $roots = @()
    $finalRoots = @()
    $rootErrors = @()
    foreach ($root in @(@($Config.repoPath) + @($Config.trust.repositoryRoots) | Where-Object { $_ })) {
        $roots += ConvertTo-CanonicalTracePath ([string]$root)
        $rr = Resolve-PreflightFinalPath ([string]$root)
        if ($rr.status -eq 'OK') { $finalRoots += ConvertTo-CanonicalTracePath ([string]$rr.path) }
        else { $rootErrors += ([string]$root + ' (' + $rr.status + ': ' + $rr.reason + ')') }
    }
    return [pscustomobject]@{ roots = $roots; finalRoots = $finalRoots; rootErrors = $rootErrors; identity = $Identity; seen = @{} }
}

# احتواء مسار مطبَّع في قائمة جذور بحدود المسار (C:\repo2 ليس داخل C:\repo)، بلا حساسية حالة الأحرف.
function Test-KeyInRoots([string]$Key, [string[]]$Roots) {
    if (-not $Key) { return $false }
    foreach ($root in @($Roots)) { if ($root -and ($Key -eq $root -or $Key.StartsWith($root + '\'))) { return $true } }
    return $false
}

# قرار الاحتواء الوحيد: IN / OUT / UNKNOWN بعد حلّ المسار في نظام الملفات (المرشّح والجذور معاً).
# تطابق نصي مع جذر = IN (دليل إيجابي). غير ذلك يُحلّ المسار النهائي: OK ⇒ IN/OUT؛ MISSING ⇒ IN إن وقع
# سلفه النهائي داخل جذر، وإلا UNKNOWN حين يلزم الوجود (قد يظهر لاحقاً في المسار نفسه) أو OUT لمسار بيانات؛
# ERROR (reparse مكسور/وصول مرفوض) ⇒ UNKNOWN. الفشل لا يصير OUT أبداً.
function Get-PathContainment($Ctx, [string]$Path, [bool]$MustExist) {
    $t = ConvertTo-CanonicalTracePath $Path
    if (-not $t) { return [pscustomobject]@{ state = 'UNKNOWN'; final = ''; reason = 'empty path' } }
    if (Test-KeyInRoots $t $Ctx.roots) { return [pscustomobject]@{ state = 'IN'; final = $Path; reason = '' } }
    if (@($Ctx.rootErrors).Count -gt 0) { return [pscustomobject]@{ state = 'UNKNOWN'; final = ''; reason = ('repository root cannot be canonicalized: ' + (@($Ctx.rootErrors) -join '; ')) } }
    $r = Resolve-PreflightFinalPath $Path
    $all = @(@($Ctx.roots) + @($Ctx.finalRoots))
    if ($r.status -eq 'OK') {
        if (Test-KeyInRoots (ConvertTo-CanonicalTracePath ([string]$r.path)) $all) { return [pscustomobject]@{ state = 'IN'; final = [string]$r.path; reason = '' } }
        return [pscustomobject]@{ state = 'OUT'; final = [string]$r.path; reason = '' }
    }
    if ($r.status -eq 'MISSING') {
        if (Test-KeyInRoots (ConvertTo-CanonicalTracePath ([string]$r.path)) $all) { return [pscustomobject]@{ state = 'IN'; final = [string]$r.path; reason = '' } }
        if ($MustExist) { return [pscustomobject]@{ state = 'UNKNOWN'; final = ''; reason = ('does not exist: ' + $Path + ' (it may appear later at this path)') } }
        return [pscustomobject]@{ state = 'OUT'; final = [string]$r.path; reason = '' }
    }
    return [pscustomobject]@{ state = 'UNKNOWN'; final = ''; reason = ('filesystem identity cannot be resolved: ' + $r.reason) }
}

# مسارات مطلقة داخل حقل واحد (وسائط، أو سطر غلاف): تطابق نصي مع جذر ⇒ REPO، ثم كل مسار مطلق (رمزاً أو
# نصاً مقتبساً) يُحلّ في نظام الملفات: داخل جذر ⇒ REPO، وتعذّر الحل ⇒ UNKNOWN.
function Get-FieldReach($Ctx, [string]$Field) {
    foreach ($m in [regex]::Matches([string]$Field, '(?:[A-Za-z]:\\|\\\\[^\\"\s]+\\)[^"''\r\n<>|]*')) {
        if (Test-KeyInRoots (ConvertTo-CanonicalTracePath ($m.Value.Trim())) $Ctx.roots) { return (New-Reach 'REPO' 'repository path in field') }
    }
    $cands = @()
    foreach ($tk in @(Split-CommandTokens $Field)) { if ($tk -and (Test-AbsoluteTracePath $tk.value)) { $cands += [string]$tk.value } }
    foreach ($m in [regex]::Matches([string]$Field, '"((?:[A-Za-z]:\\|\\\\)[^"]*)"')) { $cands += $m.Groups[1].Value }
    foreach ($m in [regex]::Matches([string]$Field, '(?<![\w"''])[A-Za-z]:\\[^\s"''<>|]*')) { $cands += $m.Value }
    $r = New-Reach 'NOT_REPO'
    foreach ($c in @($cands | Select-Object -Unique)) {
        $pc = Get-PathContainment $Ctx $c $false
        if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('path resolves into a repository root: ' + $c)) }
        if ($pc.state -eq 'UNKNOWN') { $r = Join-Reach $r (New-Reach 'UNKNOWN' ($c + ': ' + $pc.reason)) }
    }
    return $r
}

# ------------------------------------------------------------
# أهداف تنفيذ ديناميكية داخل الأغلفة (Codex P1): أي أداة تنفيذ لا يُثبَت هدفها نصاً ثابتاً ⇒ UNKNOWN.
# تحليل ساكن فقط: شجرة PowerShell (Parser::ParseInput وStaticParameterBinder، بلا تنفيذ) وقواعد VBS/JS
# وCMD/BAT. لا تُقيَّم المتغيرات ولا تُقرأ ملفات البيانات؛ المتغير العادي لا يُحتسب إلا إذا صار هدف تنفيذ.
# ------------------------------------------------------------
$script:InterpreterLeaves = '^(powershell|pwsh|cmd|wscript|cscript|mshta|node|nodejs|python\d*(\.\d+)?|pythonw|py|pyw|bash|sh|rundll32|regsvr32|msbuild)(\.exe|\.com)?$'

function Test-PsLiteralAst($Ast) {
    if ($Ast -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $true }
    if ($Ast -is [System.Management.Automation.Language.ConstantExpressionAst]) { return $true }
    if ($Ast -is [System.Management.Automation.Language.ArrayLiteralAst]) { return (@($Ast.Elements | Where-Object { -not (Test-PsLiteralAst $_) }).Count -eq 0) }
    if ($Ast -is [System.Management.Automation.Language.ArrayExpressionAst]) {
        foreach ($st in @($Ast.SubExpression.Statements)) { $e = $null; if ($st -is [System.Management.Automation.Language.PipelineAst]) { $e = $st.GetPureExpression() }; if (-not $e -or -not (Test-PsLiteralAst $e)) { return $false } }
        return $true
    }
    if ($Ast -is [System.Management.Automation.Language.HashtableAst]) {
        # @{ CommandLine = '...' }: كل قيمة حرفية.
        foreach ($kv in @($Ast.KeyValuePairs)) { $e = $null; if ($kv.Item2 -is [System.Management.Automation.Language.PipelineAst]) { $e = $kv.Item2.GetPureExpression() }; if (-not $e -or -not (Test-PsLiteralAst $e)) { return $false } }
        return $true
    }
    return $false
}

# سبب الديناميكية في نص PowerShell، أو $null إن كانت كل أهداف التنفيذ ثابتة.
function Get-PsDynamicExecution([string]$Text) {
    $tokens = $null
    $errs = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$Text, [ref]$tokens, [ref]$errs)
    if (@($errs).Count -gt 0) { return ('PowerShell cannot be parsed statically: ' + $errs[0].Message) }
    foreach ($c in @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))) {
        $first = $c.CommandElements[0]
        $op = [string]$c.InvocationOperator
        if ($op -eq 'Ampersand' -or $op -eq 'Dot') {
            if (-not (Test-PsLiteralAst $first)) { return ('dynamic ' + $(if ($op -eq 'Dot') { 'dot-source' } else { 'call operator' }) + ' target: ' + $first.Extent.Text) }
        }
        $name = $c.GetCommandName()
        if (-not $name) { return ('dynamic command name: ' + $first.Extent.Text) }
        # مفسّر ثابت (powershell/node/cmd/wscript/...) بوسيط محسوب: الهدف الذي سيشغّله غير ثابت ⇒ UNKNOWN.
        $leafName = (([string]$name) -replace '/', '\' -split '\\')[-1]
        if ($leafName -match $script:InterpreterLeaves) {
            foreach ($el in @($c.CommandElements | Select-Object -Skip 1)) {
                $v = $el
                if ($el -is [System.Management.Automation.Language.CommandParameterAst]) { if ($null -eq $el.Argument) { continue }; $v = $el.Argument }
                if (-not (Test-PsLiteralAst $v)) { return ('interpreter ' + $leafName + ' with a computed argument: ' + $el.Extent.Text) }
            }
        }
        # & Invoke-WmiMethod / iwmi / Module\Invoke-WmiMethod لا تُتخطى: الوسائط تُفحص كالأمر المباشر.
        $n = $name.ToLowerInvariant()
        if ($n.Contains('\')) { $n = $n.Substring($n.LastIndexOf('\') + 1) }
        if ($n -eq 'iwmi') { $n = 'invoke-wmimethod' }
        $bound = $null
        if (@('start-process', 'saps', 'start', 'invoke-command', 'icm', 'invoke-item', 'ii', 'start-job', 'sajb', 'start-threadjob', 'invoke-wmimethod', 'invoke-cimmethod') -contains $n) {
            try { $bound = [System.Management.Automation.Language.StaticParameterBinder]::BindCommand($c, $true).BoundParameters } catch { return ('parameters of ' + $name + ' cannot be bound statically') }
        }
        switch -regex ($n) {
            '^(start-process|saps|start)$' {
                if (-not $bound.ContainsKey('FilePath')) { return ($name + ' without a static -FilePath') }
                $fp = $bound['FilePath'].Value
                if (-not (Test-PsLiteralAst $fp)) { return ($name + ' with a dynamic target: ' + $fp.Extent.Text) }
                $leaf = (([string]$fp.Value) -replace '/', '\' -split '\\')[-1]
                if ($bound.ContainsKey('ArgumentList') -and -not (Test-PsLiteralAst $bound['ArgumentList'].Value) -and $leaf -match $script:InterpreterLeaves) { return ($name + ' runs interpreter ' + $leaf + ' with dynamic arguments: ' + $bound['ArgumentList'].Value.Extent.Text) }
            }
            '^(invoke-command|icm|start-job|sajb|start-threadjob)$' {
                if ($bound.ContainsKey('FilePath') -and -not (Test-PsLiteralAst $bound['FilePath'].Value)) { return ($name + ' with a dynamic -FilePath: ' + $bound['FilePath'].Value.Extent.Text) }
                if ($bound.ContainsKey('ScriptBlock') -and -not ($bound['ScriptBlock'].Value -is [System.Management.Automation.Language.ScriptBlockExpressionAst])) { return ($name + ' with a computed script block: ' + $bound['ScriptBlock'].Value.Extent.Text) }
                if (-not $bound.ContainsKey('FilePath') -and -not $bound.ContainsKey('ScriptBlock')) { return ($name + ' without a static script block or file') }
            }
            '^(invoke-item|ii)$' {
                foreach ($k in @('Path', 'LiteralPath')) { if ($bound.ContainsKey($k) -and -not (Test-PsLiteralAst $bound[$k].Value)) { return ($name + ' with a dynamic path: ' + $bound[$k].Value.Extent.Text) } }
            }
            '^(invoke-wmimethod|invoke-cimmethod)$' {
                # WMI/CIM (مثل Win32_Process.Create): اسم الطريقة ووسائطها حرفية وإلا ⇒ UNKNOWN.
                foreach ($k in @('Name', 'MethodName')) { if ($bound.ContainsKey($k) -and -not (Test-PsLiteralAst $bound[$k].Value)) { return ($name + ' with a computed method name: ' + $bound[$k].Value.Extent.Text) } }
                if (-not $bound.ContainsKey('Name') -and -not $bound.ContainsKey('MethodName')) { return ($name + ' without a static method name') }
                foreach ($k in @('ArgumentList', 'Arguments')) { if ($bound.ContainsKey($k) -and -not (Test-PsLiteralAst $bound[$k].Value)) { return ($name + ' with computed arguments (process creation from data): ' + $bound[$k].Value.Extent.Text) } }
            }
        }
    }
    foreach ($m in @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true))) {
        # $p.$m($cmd) / $p."$m"(...) : اسم الطريقة غير ثابت، فقد يكون Create/Run ⇒ UNKNOWN.
        if (-not (Test-PsLiteralAst $m.Member)) { return ('dynamic member invocation: ' + $m.Extent.Text) }
        $member = ([string]$m.Member.Extent.Text).Trim("'", '"').ToLowerInvariant()
        $target = [string]$m.Expression.Extent.Text
        if (@('invoke', 'invokereturnasis', 'invokescript', 'newscriptblock', 'invokeasync', 'begininvoke') -contains $member) { return ('dynamic invocation: ' + $m.Extent.Text) }
        if ($member -eq 'create' -and $target -match '(?i)scriptblock') { return ('script block created from a computed string: ' + $m.Extent.Text) }
        # إنشاء عملية عبر COM/WMI/.NET بأمر محسوب (WScript.Shell.Run/Exec، Shell.Application.ShellExecute،
        # MMC20 ExecuteShellCommand، Win32_Process.Create، ManagementClass.InvokeMethod) ⇒ UNKNOWN.
        $margs = @($m.Arguments)
        if (@('run', 'exec', 'shellexecute', 'shellexecuteex', 'executeshellcommand', 'createprocess') -contains $member) {
            if ($margs.Count -eq 0 -or -not (Test-PsLiteralAst $margs[0])) { return ('COM process launch .' + $m.Member.Extent.Text + ' with a computed command: ' + $m.Extent.Text) }
        }
        if ($member -eq 'invokemethod' -and @($margs | Where-Object { -not (Test-PsLiteralAst $_) }).Count -gt 0) { return ('WMI InvokeMethod with computed arguments: ' + $m.Extent.Text) }
        if ($member -eq 'create' -and $target -notmatch '(?i)scriptblock') {
            # [IO.File]::Create وأمثاله (نوع ساكن لا علاقة له بالعمليات) لا يُحتسب؛ أي مستقبِل آخر قد يكون Win32_Process.
            $staticSafe = ($m.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) -and ($target -notmatch '(?i)wmi|cim|management|process|activator')
            if (-not $staticSafe -and @($margs | Where-Object { -not (Test-PsLiteralAst $_) }).Count -gt 0) { return ('process creation (WMI/COM .Create) with a computed argument: ' + $m.Extent.Text) }
        }
        if ($member -eq 'start' -and $target -match '(?i)process') {
            if (@($m.Arguments | Where-Object { -not (Test-PsLiteralAst $_) }).Count -gt 0) { return ('process started with a computed target: ' + $m.Extent.Text) }
        }
    }
    return $null
}

# أول وسيط لاستدعاء VBS/JS (حتى أول فاصلة أو قوس إغلاق على المستوى الأعلى خارج النصوص).
function Get-ScriptFirstArgument([string]$Text) {
    $depth = 0; $q = [char]0
    for ($i = 0; $i -lt $Text.Length; $i++) {
        $ch = $Text[$i]
        if ($q -ne [char]0) { if ($ch -eq $q) { $q = [char]0 }; continue }
        if ($ch -eq '"' -or $ch -eq "'") { $q = $ch; continue }
        if ($ch -eq '(') { $depth++; continue }
        if ($ch -eq ')') { if ($depth -eq 0) { return $Text.Substring(0, $i) }; $depth--; continue }
        if ($ch -eq ',' -and $depth -eq 0) { return $Text.Substring(0, $i) }
    }
    return $Text
}

# سبب الديناميكية في غلاف VBS/JS/CMD/BAT، أو $null.
function Get-ScriptDynamicExecution([string]$Ext, [string]$Text) {
    $e = $Ext.ToLowerInvariant()
    if ($e -eq '.vbe' -or $e -eq '.jse') { return ('encoded script host file (' + $e + ') cannot be inspected') }
    if ($e -eq '.vbs' -or $e -eq '.js' -or $e -eq '.wsf') {
        $lit = if ($e -eq '.vbs') { '^\s*(("(?:[^"]|"")*"|Chr\(\s*\d+\s*\)|vbCrLf|vbTab)\s*(&\s*(?=\S)|$))+\s*$' } else { '^\s*(("(?:[^"\\]|\\.)*"|''(?:[^''\\]|\\.)*'')\s*(\+\s*(?=\S)|$))+\s*$' }
        foreach ($line in ($Text -split "`r?`n")) {
            $l = $line.Trim()
            if (-not $l -or $l.StartsWith("'") -or $l -match '^(?i)rem\s' -or $l.StartsWith('//')) { continue }
            if ($l -match '(?i)(^|:)\s*(Execute|ExecuteGlobal)\b|\b(Execute|ExecuteGlobal|Eval)\s*\(|\bnew\s+Function\s*\(') { return ('dynamic code execution: ' + $l) }
            if ($l -match '(?i)\.ExecMethod_\b') { return ('WMI ExecMethod_ with a computed parameters object: ' + $l) }
            foreach ($m in [regex]::Matches($l, '(?i)\.(Run|Exec|ShellExecute|ExecuteShellCommand|Create)\b[ \t]*\(?[ \t]*(.*)$')) {
                $arg = Get-ScriptFirstArgument $m.Groups[2].Value
                if ($arg -notmatch $lit) { return ('.' + $m.Groups[1].Value + ' with a computed command: ' + $arg.Trim()) }
            }
        }
        return $null
    }
    if ($e -eq '.cmd' -or $e -eq '.bat') {
        foreach ($line in ($Text -split "`r?`n")) {
            $l = $line.Trim()
            if (-not $l -or $l -match '^(?i)(@?rem\b|::)') { continue }
            if ($l -match '(?i)\bcall\s+set\b') { return ('call set (double expansion builds the command at run time): ' + $l) }
            if ($l -match '(?im)^@?\s*(call\s+|start\s+(?:"[^"]*"\s+)?(?:/\w+(?::\S+)?\s+)*)?"?(%%~?[a-z]|%[0-9*~]|[%!][A-Za-z_])') { return ('command taken from a variable/argument: ' + $l) }
            if ($l -match '(?i)\bdo\s+\(?\s*@?(call\s+|start\s+(?:"[^"]*"\s+)?(?:/\w+(?::\S+)?\s+)*)?"?(%%~?[a-z]|%[0-9*~]|[%!][A-Za-z_])') { return ('for-loop runs a command taken from data: ' + $l) }
            if ($l -match '(?i)\b(call|start)\s+(?:"[^"]*"\s+)?(?:/\w+(?::\S+)?\s+)*"?(%%~?[a-z]|%[0-9*~]|[%!][A-Za-z_])') { return ('call/start with a variable target: ' + $l) }
            if ($l -match '(?i)\b(powershell|pwsh|cmd|wscript|cscript|mshta|node|python\d*|pythonw|py|bash|rundll32|regsvr32|wmic)(\.exe)?"?\s[^\r\n]*(%%~?[a-z]|%[0-9*])') { return ('interpreter with an argument taken from a loop variable or batch argument: ' + $l) }
        }
        return $null
    }
    return $null
}

# أدوات التنفيذ في جسم غلاف حسب نوعه؛ PowerShell -Command داخل غلاف CMD يخضع لقاعدة الـAction نفسها.
function Get-WrapperDynamicReach($Ctx, [string]$Path, [string]$Text, [int]$depth) {
    $slashPath = ([string]$Path) -replace '\\', '/'
    $ext = [IO.Path]::GetExtension($slashPath)
    $why = $null
    if ($ext -match '^\.(ps1|psm1)$') { $why = Get-PsDynamicExecution $Text }
    else { $why = Get-ScriptDynamicExecution $ext $Text }
    if ($why) { return (New-Reach 'UNKNOWN' ('dynamic execution target in wrapper ' + $Path + ': ' + $why)) }
    $r = New-Reach 'NOT_REPO'
    if ($ext -match '^\.(cmd|bat)$') {
        foreach ($m in [regex]::Matches($Text, '(?im)\b(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\S+\s+)*?-(?:c|command)\s+("([^"]*)"|([^\r\n]+))')) {
            $cmd = if ($m.Groups[2].Success) { $m.Groups[2].Value } else { $m.Groups[3].Value }
            $r = Join-Reach $r (Get-PsCommandReach $Ctx $cmd '' ($depth + 1))
            if ($r.status -eq 'REPO') { return $r }
        }
    }
    return $r
}

# غلاف (vbs/cmd/bat/ps1/psm1، أو هدف مضيف سكربت) خارج المستودع: يُقرأ نصه ولا يُنفَّذ، حتى 3 مستويات.
function Get-WrapperReach($Ctx, [string]$Path, [int]$depth) {
    # الغلاف يُحلّ في نظام الملفات قبل قراءته وقبل قرار احتوائه (alias/junction إلى المستودع ⇒ REPO).
    $pc = Get-PathContainment $Ctx $Path $true
    if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('script inside a repository root: ' + $Path)) }
    if ($pc.state -ne 'OUT') {
        if ($pc.reason -like 'does not exist*') { return (New-Reach 'UNKNOWN' ('wrapper is missing: ' + $Path + ' (it may appear later and run repository code)')) }
        return (New-Reach 'UNKNOWN' ('wrapper path cannot be resolved: ' + $Path + ' (' + $pc.reason + ')'))
    }
    $k = ConvertTo-CanonicalTracePath ([string]$pc.final)
    if ($Ctx.seen.ContainsKey($k)) { return (New-Reach 'NOT_REPO') }
    $Ctx.seen[$k] = $true
    if ($depth -ge 3) { return (New-Reach 'UNKNOWN' ('wrapper chain deeper than 3 levels at ' + $Path)) }
    # غلاف مفقود أو غير مقروء أو فارغ: لا يُثبت ما سيشغّله لاحقاً ⇒ UNKNOWN، لا NOT_REPO (Codex P1).
    try { $inner = Read-PreflightWrapperText ([string]$pc.final) } catch { return (New-Reach 'UNKNOWN' ('wrapper cannot be read: ' + $Path + ' (' + $_.Exception.Message + ')')) }
    if ($null -eq $inner) { return (New-Reach 'UNKNOWN' ('wrapper is missing: ' + $Path + ' (it may appear later and run repository code)')) }
    if ($inner.Length -eq 0) { return (New-Reach 'UNKNOWN' ('wrapper is empty (zero bytes): ' + $Path + ' (what it will run cannot be proven)')) }
    $r = New-Reach 'NOT_REPO'
    $xi = Expand-TraceText ([string]$inner) $Ctx.identity $Path
    if ($xi.undetermined) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('unresolved environment reference in wrapper ' + $Path)) }
    $inner = $xi.text
    # حمولة مشفّرة أو تنفيذ نص ديناميكي داخل الغلاف: لا يمكن إثبات هدفها.
    if ($inner -match '(?i)\s[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+[A-Za-z0-9+/=]{8,}|FromBase64String|Invoke-Expression|(?<![\w-])iex(?![\w-])') {
        $r = Join-Reach $r (New-Reach 'UNKNOWN' ('opaque/dynamic command in wrapper ' + $Path))
    }
    # هدف تنفيذ محسوب (متغير، أو ملف بيانات، أو تعبير) ⇒ UNKNOWN؛ لا يُقيَّم ولا يُنفَّذ (Codex P1).
    $dr = Get-WrapperDynamicReach $Ctx ([string]$pc.final) $inner $depth
    if ($dr.status -eq 'REPO') { return $dr }
    $r = Join-Reach $r $dr
    foreach ($line in ($inner -split "`r?`n")) {
        $lr = Get-FieldReach $Ctx $line
        if ($lr.status -eq 'REPO') { return (New-Reach 'REPO' ('wrapper ' + $Path + ' references a repository path: ' + $lr.why)) }
        if ($lr.status -eq 'UNKNOWN') { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('wrapper ' + $Path + ': ' + $lr.why)) }
    }
    # مرجع سكربت نسبي داخل الغلاف (مثل node scripts/serve.mjs): مجلد العمل وقت التشغيل غير مثبت ⇒ UNKNOWN.
    if ($inner -match '(?<![\w\\/:.%~$-])(?:\.{1,2}[\\/])?[\w-]+(?:[\\/][\w.-]+)+\.(?:ps1|psm1|mjs|cjs|js|py|bat|cmd|vbs)\b' -or $inner -match '(?i)\b(node|python\d*|py|pwsh|powershell|wscript|cscript|deno|bun)(\.exe)?"?\s+(?:-\S+\s+)*"?[\w.-]+\.(?:ps1|mjs|cjs|js|py|vbs|ts)\b') {
        $r = Join-Reach $r (New-Reach 'UNKNOWN' ('relative script reference in wrapper ' + $Path + ' cannot be resolved statically'))
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
    $pc = Get-PathContainment $Ctx $p $true
    if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ($Kind + ' target inside a repository root: ' + $p)) }
    if ($pc.state -ne 'OUT') { return (New-Reach 'UNKNOWN' ($Kind + ' target ' + $p + ': ' + $pc.reason)) }
    if (([string]$pc.final) -match '\.(vbs|cmd|bat|ps1|psm1|js|wsf|jse|vbe)$' -or $p -match '\.(vbs|cmd|bat|ps1|psm1|js|wsf|jse|vbe)$') { return (Get-WrapperReach $Ctx $p $Depth) }
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
                $pc = Get-PathContainment $Ctx $wdp $true
                if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('PowerShell working directory inside a repository root: ' + $wdp)) }
                if ($pc.state -ne 'OUT') { return (New-Reach 'UNKNOWN' ('PowerShell -WorkingDirectory ' + $wdp + ': ' + $pc.reason)) }
                $wd = ConvertTo-CanonicalTracePath ([string]$pc.final)
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
                $pc = Get-PathContainment $Ctx $wdp $true
                if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('cmd changes directory into a repository root: ' + $wdp)) }
                if ($pc.state -ne 'OUT') { return (Join-Reach $r (New-Reach 'UNKNOWN' ('cmd directory change ' + $wdp + ': ' + $pc.reason))) }
                $wd = ConvertTo-CanonicalTracePath ([string]$pc.final)
                continue
            }
            if ($head -eq 'call') { $tokens = @($tokens | Select-Object -Skip 1) }
            elseif ($head -eq 'start') {
                $tokens = @($tokens | Select-Object -Skip 1)
                while ($tokens.Count -gt 0 -and -not $tokens[0].quoted -and $tokens[0].value.StartsWith('/')) {
                    if ($tokens[0].value -match '^/[dD]$' -and $tokens.Count -gt 1) {
                        $wdp = Resolve-TracePath $tokens[1].value $wd
                        if (-not $wdp) { return (Join-Reach $r (New-Reach 'UNKNOWN' 'start /D cannot be resolved')) }
                        $pc = Get-PathContainment $Ctx $wdp $true
                        if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('start /D inside a repository root: ' + $wdp)) }
                        if ($pc.state -ne 'OUT') { return (Join-Reach $r (New-Reach 'UNKNOWN' ('start /D ' + $wdp + ': ' + $pc.reason))) }
                        $wd = ConvertTo-CanonicalTracePath ([string]$pc.final)
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
        else {
            # مجلد العمل يُحلّ في نظام الملفات قبل حلّ الأهداف النسبية بالنسبة إليه (junction ⇒ المستودع).
            $pc = Get-PathContainment $Ctx $wd $true
            if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('working directory inside a repository root: ' + $wd)) }
            if ($pc.state -ne 'OUT') { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('working directory ' + $wd + ': ' + $pc.reason)); $wd = '' }
            else { $wd = ConvertTo-CanonicalTracePath ([string]$pc.final) }
        }
    }
    foreach ($f in @('execute', 'arguments')) {
        $fr = Get-FieldReach $Ctx $fx[$f]
        if ($fr.status -eq 'REPO') { return (New-Reach 'REPO' ('repository path in action ' + $f + ': ' + $fr.why)) }
        if ($fr.status -eq 'UNKNOWN') { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('action ' + $f + ': ' + $fr.why)) }
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
            if (-not (Test-AbsoluteTracePath $p)) { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('COM handler binary path is not absolute: ' + $p)); continue }
            $pc = Get-PathContainment $ctx $p $true
            if ($pc.state -eq 'IN') { return (New-Reach 'REPO' ('COM handler binary inside a repository root: ' + $p)) }
            if ($pc.state -ne 'OUT') { $r = Join-Reach $r (New-Reach 'UNKNOWN' ('COM handler binary ' + $p + ': ' + $pc.reason)) }
            continue
        }
        $r = Join-Reach $r (Get-ActionReach $ctx ([string]$a.execute) ([string]$a.arguments) ([string]$a.workingDirectory) 0)
        if ($r.status -eq 'REPO') { return $r }
    }
    return $r
}

# سطر أوامر واحد (مسار خدمة): البرنامج أولاً (مقتبس، أو حتى .exe، أو أول رمز) ثم الوسائط.
function Resolve-WorkloadReach($Config, [string]$ActionText, [string]$Identity = '') {
    if (-not ([string]$ActionText).Trim()) { return (New-Reach 'UNKNOWN' 'empty command line') }
    $a = ConvertTo-CommandAction $ActionText
    return (Get-ActionReach (New-ReachContext $Config $Identity) $a.execute $a.arguments '' 0)
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
    # أثناء bootstrap/Initialize: -Mode DryRun حرفياً ومرة واحدة (Codex P1). غياب Mode يعني Deploy
    # (القيمة الافتراضية للسكربت)، وDeploy لا يُقبل إلا بانتقال منفصل مثبت بعد 24 ساعة DryRun.
    $modes = @()
    while ($i -lt $tokens.Count) {
        $tk = ([string]$tokens[$i]).ToLowerInvariant()
        if ($tk -eq '-mode' -and $i + 1 -lt $tokens.Count) { $modes += ([string]$tokens[$i + 1]); $i += 2; continue }
        return ('disallowed script argument: ' + $tokens[$i])
    }
    if ($modes.Count -eq 0) { return 'missing -Mode (script default is Deploy); the gate task must be registered with exactly -Mode DryRun' }
    if ($modes.Count -gt 1) { return ('-Mode given more than once: ' + ($modes -join ', ')) }
    if ($modes[0] -cne 'DryRun' -and $modes[0].ToLowerInvariant() -ne 'dryrun') { return ('the gate task must be registered with exactly -Mode DryRun, found -Mode ' + $modes[0]) }
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

# ------------------------------------------------------------
# سلسلة الأسلاف حتى مرسى الثقة (Codex P1): فوق الأب المباشر لا يُشترط أن تكون المجلدات حصرية
# للبوابة (مثل C:\ProgramData)، بل تُحلَّل قدرة الاستبدال الفعلية وفق دلالات ACL في Windows:
#   - حذف/إعادة تسمية ابن: DeleteSubdirectoriesAndFiles على المستوى، أو Delete على الابن نفسه
#     (والابن مستوى في السلسلة أيضاً، فـDelete على أي مستوى يعني أنه قابل للإزاحة).
#   - السيطرة: ChangePermissions (WRITE_DAC)، أو TakeOwnership (WRITE_OWNER)، أو GENERIC_ALL، أو الملكية
#     (للمالك WRITE_DAC ضمنياً).
#   - الإنشاء وحده (CreateDirectories/CreateFiles/WriteData، أو GENERIC_WRITE)، وWriteAttributes، لا تستبدل
#     مجلداً قائماً غير فارغ ⇒ لا تُعد قدرة استبدال.
#   - ACE بعلَم InheritOnly لا تنطبق على المستوى نفسه (تُقرأ على الأبناء، وهم مستويات مفحوصة بـACL الفعلية).
#   - Deny لا يُحتسب حماية (تحفّظاً).
# الموثوق على هذه المستويات: هوية البوابة، وثقة إدارة النظام (SYSTEM، Administrators، TrustedInstaller،
# وأعضاء Administrators المحليين بالـSID). هذه الثقة مقبولة لأن أي repo workload مؤتمت بإحداها
# يحجبه حارس الصلاحيات مستقلاً. أي principal آخر بقدرة استبدال ⇒ حجب؛ ACL لازمة لا تُقرأ/تُفسَّر ⇒ حجب.
# ------------------------------------------------------------
$script:TrustedInstallerSid = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$script:ReplaceRightsMask = 64 -bor 65536 -bor 262144 -bor 524288

function Get-AncestorReplacementFindings([string]$Level, $Acl, [string[]]$Approved) {
    $out = @()
    $subject = 'acl ancestor ' + $Level + ' (replacement of the protected chain)'
    if (-not $Acl) { return @(@{ subject = $subject; reason = 'ACL is empty or unreadable' }) }
    $ownerText = ([string]$Acl.owner).Trim()
    $ownerSid = Resolve-PrincipalSid $ownerText
    if (-not $ownerText) { $out += @{ subject = $subject; reason = 'owner cannot be determined' } }
    elseif (-not $ownerSid) { $out += @{ subject = $subject; reason = ('owner cannot be resolved to a SID: ' + $ownerText) } }
    elseif ($Approved -notcontains $ownerSid) { $out += @{ subject = $subject; reason = ('owner is ' + $ownerText + ' (' + $ownerSid + '): an owner holds implicit WRITE_DAC and can grant itself delete/rename rights') } }
    foreach ($ace in @($Acl.access)) {
        $type = ([string]$ace.type).Trim()
        if ($type -eq 'Deny') { continue }
        if ($type -ne 'Allow') { $out += @{ subject = $subject; reason = ('unrecognised ACE type: ' + $ace.type) }; continue }
        if ($ace.PSObject.Properties['inheritOnly'] -and [bool]$ace.inheritOnly) { continue }
        $value = ConvertTo-RightsValue ([string]$ace.rights)
        if ($null -eq $value) { $out += @{ subject = $subject; reason = ('rights cannot be interpreted for ' + $ace.identity + ': ' + $ace.rights) }; continue }
        if ((($value -band $script:ReplaceRightsMask) -eq 0) -and (($value -band 0x10000000) -eq 0)) { continue }
        $aceText = ([string]$ace.identity).Trim()
        if (-not $aceText) { $out += @{ subject = $subject; reason = 'replacement-capable ACE with an unresolvable identity' }; continue }
        $aceSid = Resolve-PrincipalSid $aceText
        if (-not $aceSid) { $out += @{ subject = $subject; reason = ('replacement-capable ACE whose identity cannot be resolved to a SID: ' + $aceText) }; continue }
        if ($Approved -contains $aceSid) { continue }
        $origin = 'explicit'
        if ([bool]$ace.inherited) { $origin = 'inherited' }
        $out += @{ subject = $subject; reason = ($origin + ' replacement capability for ' + $aceText + ' (' + $ace.rights + '): can delete/rename or take control of a container in the protected chain') }
    }
    return $out
}

# مستويات الأسلاف فوق الأب المباشر حتى مرسى الثقة (شاملاً). $null إن لم يكن المرسى سلفاً صالحاً.
function Get-GateAncestorLevels([string]$Parent, [string]$Anchor, [string]$Sep) {
    $key = { param([string]$p) (([string]$p).TrimEnd('\', '/')).ToLowerInvariant() }
    $anchorKey = & $key $Anchor
    if (-not $anchorKey -or (& $key $Parent) -eq $anchorKey) { return $null }
    $levels = @()
    $cur = $Parent
    for ($i = 0; $i -lt 32; $i++) {
        $up = Get-GateParentPath (([string]$cur).TrimEnd('\', '/')) $Sep
        if (-not $up) { return $null }
        $levels += $up
        if ((& $key $up) -eq $anchorKey) { return , $levels }
        $cur = $up
    }
    return $null
}

# المجلد الأب المباشر لمسار (مسار لا اسم حساب)؛ '' إن لم يوجد أب قابل للفحص.
function Get-GateParentPath([string]$Dir, [string]$Sep) {
    $cut = $Dir.LastIndexOf($Sep)
    if ($cut -le 0) { return '' }
    $parent = $Dir.Substring(0, $cut)
    if ($parent -match '^[A-Za-z]:$') { $parent += '\' }
    return $parent
}

function Test-GateTrustAcl($Config) {
    $results = @()
    $block = { param([string]$Subject, [string]$Reason) [pscustomobject]@{ task = $Subject; verdict = 'BLOCK'; reason = $Reason } }
    $gateSid = Resolve-PrincipalSid ([string]$Config.trust.gateAccount)
    if (-not $gateSid) { return [pscustomobject]@{ ok = $false; results = @(& $block 'gate identity' ('gate identity cannot be resolved to a SID: ' + $Config.trust.gateAccount)) } }
    $dir = ([string]$Config.gateDir).TrimEnd('\', '/')
    $sep = '\'
    if ($dir.StartsWith('/')) { $sep = '/' }
    # المجلد الأب المباشر جزء إلزامي من حدود الثقة (Codex P1): من يملك عليه حذف/إنشاء/إعادة تسمية
    # الأبناء (DeleteSubdirectoriesAndFiles، CreateDirectories/Write، Modify/FullControl) أو تغيير
    # الصلاحيات/الملكية يستطيع استبدال gateDir كله مهما كانت ACL الداخلية سليمة.
    $parent = Get-GateParentPath $dir $sep
    $targets = @()
    if (-not $parent) { $results += & $block ('acl parent of ' + $dir) 'gateDir has no parent container whose ACL can be verified' }
    else { $targets += $parent }
    $targets += $dir
    foreach ($f in @($Config.trust.trustFiles)) {
        $p = $dir + $sep + [string]$f
        if (Test-Path -LiteralPath $p) { $targets += $p }
        elseif (@($Config.trust.requiredTrustFiles) -contains [string]$f) { $results += & $block ('trust file ' + $f) 'required trust file is missing' }
    }
    foreach ($path in $targets) {
        $subject = 'acl ' + $path
        if ($path -eq $parent) { $subject = 'acl parent ' + $path + ' (replacement of gateDir)' }
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
    # الأسلاف فوق الأب المباشر حتى مرسى الثقة: تحليل قدرة الاستبدال (لا حصرية).
    $anchor = ''
    if ($Config.trust.PSObject.Properties['trustAnchor']) { $anchor = ([string]$Config.trust.trustAnchor).Trim() }
    if (-not $anchor) { $results += & $block 'acl ancestors' 'no trust anchor configured (trust.trustAnchor); the ancestor chain cannot be bounded' }
    elseif ($parent) {
        $levels = Get-GateAncestorLevels $parent $anchor $sep
        if ($null -eq $levels) { $results += & $block 'acl ancestors' ('trust anchor ' + $anchor + ' is not an ancestor above the immediate parent ' + $parent) }
        else {
            $approved = @($gateSid, 'S-1-5-18', 'S-1-5-32-544', $script:TrustedInstallerSid)
            $members = Get-PreflightAdminMembers
            if ($null -ne $members) {
                $memberSids = @(@($members) | ForEach-Object { Resolve-PrincipalSid ([string]$_) })
                # عضو لا يُحلّ ⇒ لا يُعتمد أحد بالعضوية (تحفّظاً)؛ المجموعات المبنية تبقى معتمدة.
                if (@($memberSids | Where-Object { -not $_ }).Count -eq 0) { $approved += $memberSids }
            }
            foreach ($lv in @($levels)) {
                try { $lacl = Get-PreflightAcl $lv } catch { $results += & $block ('acl ancestor ' + $lv) ('cannot read ACL: ' + $_.Exception.Message); continue }
                foreach ($f in @(Get-AncestorReplacementFindings $lv $lacl $approved)) { $results += & $block $f.subject $f.reason }
            }
        }
    }
    if (@($results).Count -eq 0) { $results += [pscustomobject]@{ task = 'gate trust ACL'; verdict = 'PASS'; reason = 'only the dedicated gate identity owns and can write the parent container, gateDir and the trust files; no untrusted principal can replace a container up to the trust anchor' } }
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
    # جذور المستودع نفسها تُحلّ إلى مسار نهائي موجود في نظام الملفات؛ جذر لا يُحلّ لا يسقط بصمت ⇒ حجب.
    foreach ($root in @(@($Config.repoPath) + @($Config.trust.repositoryRoots) | Where-Object { $_ })) {
        $rr = Resolve-PreflightFinalPath ([string]$root)
        if ($rr.status -ne 'OK') { $results += & $block ('repository root ' + $root) ('cannot be canonicalized to an existing final filesystem path (' + $rr.status + ': ' + $rr.reason + '); containment decisions would not be provable') }
    }
    # Startup/Logon جزء من الجرد نفسه (Codex P1): لا يقتصر على المهام والخدمات.
    try {
        $inventory += @(Get-PreflightStartupInventory | ForEach-Object { $_ | Add-Member -NotePropertyName kind -NotePropertyValue 'startup' -PassThru -Force })
    } catch {
        return [pscustomobject]@{ ok = $false; results = @($results + (& $block 'inventory' ('cannot enumerate startup/logon sources: ' + $_.Exception.Message))) }
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
            # مهمة البوابة: هوية USER مخصّصة حصراً؛ GroupId (أو نوع غير محسوم) غير مقبول إطلاقاً.
            $gptype = if ($gateTaskItem.PSObject.Properties['principalType']) { [string]$gateTaskItem.principalType } else { '' }
            if ($gptype -ne 'USER') { $results += & $block $gsub ('gate task principal must be the dedicated USER identity; principal type is ' + $(if ($gptype) { $gptype } else { 'UNKNOWN' }) + ' (GroupId is never accepted for the gate)') }
            $gid = ([string]$gateTaskItem.identity).Trim()
            $gidSid = Resolve-PrincipalSid $gid
            if (-not $gid -or -not $gidSid) { $results += & $block $gsub ('gate task identity not verifiable: ' + $gid) }
            elseif ($gidSid -ne $gate) { $results += & $block $gsub ('gate task must run as the dedicated gate identity ' + $gateName + '; found ' + $gid) }
            $why = Test-ExactGateAction $Config $gateTaskItem
            if ($why) { $results += & $block $gsub ('the gate task must run only the gate scripts in gateDir: ' + $why) }
            # bootstrap ⇒ Initialize: المهمة معطّلة؛ تُفعَّل (DryRun) بعد نجاح Initialize فقط.
            $gstate = if ($gateTaskItem.PSObject.Properties['state']) { ([string]$gateTaskItem.state).Trim() } else { '' }
            if (-not $gstate) { $results += & $block $gsub 'gate task enabled/disabled state cannot be read' }
            elseif ($gstate -ne 'Disabled') { $results += & $block $gsub ('gate task must be Disabled during Initialize (bootstrap state); found ' + $gstate) }
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

    # سجل تدقيق لكل عنصر: نوع الـprincipal، والـSID، وUserId/GroupId، وRunLevel، والتصنيف، والنتيجة.
    $workloads = New-Object System.Collections.ArrayList
    foreach ($item in $inventory) {
      $before = @($results).Count
      $key = $null
      $reach = $null
      $ptype = 'USER'
      if ($item.kind -eq 'task') { $ptype = if ($item.PSObject.Properties['principalType'] -and $item.principalType) { [string]$item.principalType } else { 'UNKNOWN' } }
      $runLevel = if ($item.PSObject.Properties['runLevel'] -and $item.runLevel) { [string]$item.runLevel } else { 'UNKNOWN' }
      try {
        $subject = $item.kind + ' ' + ([string]$item.path) + $item.name
        $identityText = ([string]$item.identity).Trim()
        $key = if ($item.PSObject.Properties['sid'] -and $item.sid) { [string]$item.sid } else { Resolve-PrincipalSid $identityText }
        if ($identityText -and -not $key) {
            # هوية مذكورة لا تُحلّ إلى SID: لا يمكن إثبات أنها ليست هوية البوابة أو حساباً ذا صلاحية.
            $results += & $block $subject ('identity cannot be resolved to a SID: ' + $identityText)
            continue
        }
        # مهمة البوابة الوحيدة لا تُصنَّف بالوصول: تشغّل سكربت البوابة من gateDir (يعمل على المستودع بالتصميم)
        # وقد تحقق منها أعلاه Test-ExactGateAction حرفياً، وسكربتاتها ملفات ثقة تحميها ACL.
        if ([object]::ReferenceEquals($item, $gateTaskItem)) { continue }
        # المهام بحقولها المنظّمة؛ الخدمات بسطر أوامرها (PathName). ثلاثي الحالة، وUNKNOWN لا يصير NOT_REPO.
        if ($item.kind -eq 'task' -or $item.kind -eq 'startup') {
            $reach = Resolve-TaskReach $Config $item.actions ([string]$item.identity)
            if ($item.PSObject.Properties['unreadable'] -and $item.unreadable) { $reach = New-Reach 'UNKNOWN' ([string]$item.unreadable) }
        }
        else { $reach = Resolve-WorkloadReach $Config ([string]$item.action) ([string]$item.identity) }
        $isRepo = $reach.status -eq 'REPO'
        # GROUP principal (Codex P1): SID المجموعة ليس هوية التنفيذ؛ المهمة تعمل ضمن جلسة أي عضو، وقد يكون
        # مديراً (خصوصاً مع HighestAvailable). لا يُختار عضو افتراضي ولا يُحكم بامتياز المجموعة نفسها:
        # REPO أو UNKNOWN ⇒ حجب، حتى مع LeastPrivilege. NOT_REPO ⇒ لا حجب بهذه القاعدة وحدها.
        if ($item.kind -eq 'task' -and $ptype -eq 'GROUP') {
            $rlText = ' (RunLevel ' + $runLevel + $(if ($runLevel -eq 'HighestAvailable') { ': a member administrator runs elevated' } else { '' }) + ')'
            if ($runLevel -ne 'LeastPrivilege' -and $runLevel -ne 'HighestAvailable') { $results += & $block $subject ('group principal ' + $identityText + ' with an unreadable RunLevel: the execution context cannot be bounded') }
            elseif ($reach.status -eq 'REPO') { $results += & $block $subject ('group principal ' + $identityText + ' runs a repository workload as whichever member is logged on, possibly an administrator' + $rlText) }
            elseif ($reach.status -eq 'UNKNOWN') { $results += & $block $subject ('group principal ' + $identityText + ': cannot prove the task does not reach a repository workload' + $rlText + ': ' + $reach.why) }
            continue
        }
        # نوع principal غير محسوم (UserId وGroupId معاً، أو لا شيء، أو غير مقروء): REPO/UNKNOWN ⇒ حجب.
        if ($item.kind -eq 'task' -and $ptype -ne 'USER') {
            if ($reach.status -ne 'NOT_REPO') { $results += & $block $subject ('principal type cannot be determined (UserId ' + $item.userId + ', GroupId ' + $item.groupId + ') and the workload is ' + $reach.status + ': ' + $reach.why) }
            continue
        }
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
      } finally {
        $added = @(@($results) | Select-Object -Skip $before)
        $decision = 'OK'
        if ($added.Count -gt 0) { $decision = 'BLOCK: ' + (@($added | ForEach-Object { $_.reason }) -join '; ') }
        $wl = $null
        if ($reach) { $wl = $reach.status }
        if ([object]::ReferenceEquals($item, $gateTaskItem)) { $wl = 'GATE_TASK (validated exactly)' }
        [void]$workloads.Add([pscustomobject]@{
            kind = [string]$item.kind; name = ([string]$item.path) + [string]$item.name; principalType = $ptype
            userId = $(if ($item.PSObject.Properties['userId']) { [string]$item.userId } else { '' })
            groupId = $(if ($item.PSObject.Properties['groupId']) { [string]$item.groupId } else { '' })
            identity = [string]$item.identity; sid = [string]$key; runLevel = $runLevel; workload = [string]$wl; decision = $decision })
      }
    }
    $blocked = @($results | Where-Object { $_.verdict -ne 'PASS' })
    if ($blocked.Count -eq 0) { $results += [pscustomobject]@{ task = 'gate identity'; verdict = 'PASS'; reason = ('dedicated identity ' + $trust.gateAccount + ' is not used by any repository workload') } }
    return [pscustomobject]@{ ok = ($blocked.Count -eq 0); results = $results; workloads = @($workloads) }
}

# فحص التثبيت الكامل: نشرات الأسعار (main) + هوية البوابة + ACL الفعلية. يستدعيه -Mode Initialize.
function Invoke-InstallPreflight($Config) {
    $a = Invoke-MigrationPreflight $Config
    $b = Invoke-GateIdentityPreflight $Config
    $c = Test-GateTrustAcl $Config
    return [pscustomobject]@{ ok = ($a.ok -and $b.ok -and $c.ok); results = @(@($a.results) + @($b.results) + @($c.results)); workloads = @($b.workloads) }
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($PreflightConfigPath)) { $PreflightConfigPath = Join-Path $PSScriptRoot 'gate-config.json' }
    $config = [System.IO.File]::ReadAllText($PreflightConfigPath) | ConvertFrom-Json
    $report = Invoke-InstallPreflight $config
    foreach ($w in @($report.workloads)) { Write-Host ('AUDIT ' + $w.kind + ' ' + $w.name + ' | principal=' + $w.principalType + ' userId=' + $w.userId + ' groupId=' + $w.groupId + ' sid=' + $w.sid + ' runLevel=' + $w.runLevel + ' | workload=' + $w.workload + ' | ' + $w.decision) }
    foreach ($r in $report.results) { Write-Host ($r.verdict + ' ' + $r.task + ': ' + $r.reason) }
    if ($report.ok) { Write-Host 'PREFLIGHT PASS'; exit 0 }
    Write-Host 'PREFLIGHT BLOCKED: do not switch the operational repository to windows-production'
    exit 1
}
