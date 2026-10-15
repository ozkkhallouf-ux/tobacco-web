#Requires -Version 5.1
# ============================================================
# ozk-ameen-backup-monitor.ps1 — مراقب مستقل لنظام «OZK Ameen Verified Backup»
#
# يحلّ محل TOBACCO Ameen Backup Pull + Monitor القديمين (يراقبان مساراً لم يعد
# يُكتب فيه). يقرأ status.json الذي يكتبه ozk-ameen-backup.ps1، ويتحقق مستقلاً
# من الملفات على C: والقرص الخارجي، ومن Task Scheduler، ثم يصنّف النتيجة:
#
#   SUCCESS  آخر تشغيل مجدول متوقَّع نجح، والملفات سليمة، والمساحة كافية.
#   WARNING  النسخة محلية فقط (local-only)، أو الفلاشة غير موصولة الآن، أو مساحة منخفضة.
#   FAILURE  لم تعمل المهمة، أو النسخة قديمة/مفقودة/فاشلة، أو SHA256 لا يطابق،
#            أو قرص خارجي غير الصحيح، أو تجاوز التشغيل المهلة الآمنة.
#   PENDING  المهمة ما زالت تعمل ضمن المهلة الآمنة: لا حكم ولا تنبيه بعد.
#
# قراءة فقط تجاه النسخ: لا يحذف ولا ينقل ولا يعدّل أي ملف نسخ، ولا يتصل بـSQL.
# يكتب فقط ملفّي حالته (monitor-state.json) وسجله الشهري في -StateDir.
#
# التنبيه (Telegram عبر -NotifyScript) يُعدّ واصلاً فقط بسطر «TELEGRAM-NOTIFY OK».
# منع التكرار: تنبيه عند تغيّر الحالة أو تغيّر الأسباب، أو استمرار WARNING/FAILURE
# أطول من -RepeatHours، أو إعادة محاولة تنبيه سابق لم يصل.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\ozk-ameen-backup-monitor.ps1
#   (بلا -NotifyScript: يقيّم ويسجّل فقط، ولا يرسل ولا يغيّر حالة التنبيهات)
#
# رموز الخروج: 0 SUCCESS أو PENDING · 1 FAILURE · 2 WARNING · 3 خطأ في المراقب نفسه.
# ============================================================
[CmdletBinding()]
param(
    [string]$StateDir = 'C:\ProgramData\OZK-TOBACCO\Backup',
    [string]$BackupTaskName = 'OZK Ameen Verified Backup',
    [string]$ScheduleTime = '23:00',
    [int]$GraceMinutes = 90,
    [int]$MaxAgeHours = 26,
    [string]$ExpectedDriveSerial = '34AD-2E92',
    [int]$FailFreeGB = 20,
    [int]$WarnFreeGB = 40,
    [int]$RepeatHours = 12,
    [string]$NotifyScript = '',
    [string]$ExpectedHost = 'OZK2026'
)

$ErrorActionPreference = 'Stop'

$script:RequiredDatabases = @('AmnDb002', 'AmnDb001', 'AmnConfig')
$script:ExternalMarker = 'OZK-BACKUP-DRIVE.marker'

# ---------- نقاط حقن للاختبارات (كلها قراءة) ----------

# حالة مهمة النسخ في Task Scheduler.
$script:TaskInfoReader = {
    param([string]$Name)
    $t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $t) { return $null }
    $i = Get-ScheduledTaskInfo -TaskName $Name
    return [pscustomobject]@{ State = [string]$t.State; LastRunTime = $i.LastRunTime; LastTaskResult = [int64]$i.LastTaskResult }
}

# رقم وحدة القرص (مثل 34AD-2E92) لجذر مسار، أو '' إن لم يكن موجوداً.
$script:VolumeSerialReader = {
    param([string]$Root)
    $letter = $Root.Substring(0, 2)
    $d = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='{0}'" -f $letter) -ErrorAction SilentlyContinue
    if (-not $d -or -not $d.VolumeSerialNumber) { return '' }
    $s = [string]$d.VolumeSerialNumber
    return ($s.Substring(0, 4) + '-' + $s.Substring(4)).ToUpperInvariant()
}

# المساحة الحرة بالبايت لجذر مسار، أو -1 إن تعذّر.
$script:FreeSpaceReader = {
    param([string]$Path)
    try {
        return [int64](New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($Path))).AvailableFreeSpace
    } catch {
        return [int64]-1
    }
}

$script:HostNameReader = { return $env:COMPUTERNAME }

# هل ملف العلامة موجود على جذر القرص؟
$script:MarkerChecker = {
    param([string]$Root)
    return (Test-Path -LiteralPath ([System.IO.Path]::Combine($Root, $script:ExternalMarker)) -PathType Leaf)
}

# يكتب JSON (ملفات المراقب فقط).
$script:JsonWriter = {
    param([string]$Path, $Object)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- دوال صرفة ----------

function Join-OzkMonPath([string]$Parent, [string]$Child) { return [System.IO.Path]::Combine($Parent, $Child) }

function Get-OzkMonSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# آخر موعد مجدول قبل اللحظة (اليوم أو أمس عند ScheduleTime).
function Get-OzkExpectedRun([datetime]$Now, [string]$ScheduleTime) {
    if ($ScheduleTime -notmatch '^([01]\d|2[0-3]):([0-5]\d)$') { throw ('وقت جدولة غير صالح: ' + $ScheduleTime) }
    $today = $Now.Date.AddHours([int]$Matches[1]).AddMinutes([int]$Matches[2])
    if ($Now -ge $today) { return $today }
    return $today.AddDays(-1)
}

# يحوّل طابع التشغيل yyyy-MM-dd_HHmmss إلى وقت، أو $null.
function ConvertFrom-OzkStamp([string]$Stamp) {
    $out = [datetime]::MinValue
    if ([datetime]::TryParseExact($Stamp, 'yyyy-MM-dd_HHmmss', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$out)) { return $out }
    return $null
}

# ConvertFrom-Json في PowerShell 7 يحوّل نصوص ISO إلى DateTime، و5.1 يتركها نصاً.
function ConvertTo-OzkDate($Value) {
    if ($null -eq $Value -or '' -eq $Value) { return $null }
    if ($Value -is [datetime]) { return [datetime]$Value }
    $out = [datetime]::MinValue
    if ([datetime]::TryParse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$out)) { return $out }
    return $null
}

function Read-OzkJsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return ([System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json)
}

# ---------- التقييم (قراءة فقط) ----------

function Get-OzkBackupHealth {
    [CmdletBinding()]
    param(
        [string]$StateDir, [string]$BackupTaskName, [string]$ScheduleTime, [int]$GraceMinutes, [int]$MaxAgeHours,
        [string]$ExpectedDriveSerial, [int]$FailFreeGB, [int]$WarnFreeGB, [datetime]$Now
    )
    $failures = New-Object System.Collections.ArrayList
    $warnings = New-Object System.Collections.ArrayList
    $info = [ordered]@{}

    $expected = Get-OzkExpectedRun $Now $ScheduleTime
    $info.expectedRun = $expected.ToString('yyyy-MM-dd HH:mm')
    $deadline = $expected.AddMinutes($GraceMinutes)
    # إن لم تبدأ المهمة خلال 15 دقيقة من موعدها فهي لم تعمل (لا انتظار حتى نهاية المهلة).
    $startDeadline = $expected.AddMinutes(15)
    # هامش صغير: المهمة قد تبدأ قبل الموعد بثوانٍ أو تتأخر بدقائق.
    $windowStart = $expected.AddMinutes(-10)

    $task = & $script:TaskInfoReader $BackupTaskName
    if (-not $task) {
        [void]$failures.Add('مهمة النسخ غير مسجّلة: ' + $BackupTaskName)
    } else {
        $info.taskState = $task.State
        $info.taskLastRun = $(if ($task.LastRunTime) { ([datetime]$task.LastRunTime).ToString('yyyy-MM-dd HH:mm') } else { '' })
        if ($task.State -eq 'Disabled') { [void]$failures.Add('مهمة النسخ معطّلة') }
        if ($task.State -eq 'Running') {
            if ($Now -lt $deadline) {
                return [pscustomobject]@{ level = 'PENDING'; failures = @(); warnings = @(); info = $info; reasons = @('النسخ ما زال يعمل ضمن المهلة الآمنة حتى ' + $deadline.ToString('HH:mm')) }
            }
            [void]$failures.Add(('النسخ ما زال يعمل بعد المهلة الآمنة ({0} دقيقة من الموعد)' -f $GraceMinutes))
        }
    }

    $status = $null
    try { $status = Read-OzkJsonFile (Join-OzkMonPath $StateDir 'status.json') } catch { [void]$failures.Add('status.json غير صالح: ' + $_.Exception.Message) }
    if (-not $status -and $failures.Count -eq 0) { [void]$failures.Add('status.json غير موجود') }

    if ($status) {
        $runAt = ConvertFrom-OzkStamp ([string]$status.stamp)
        $info.lastStamp = [string]$status.stamp
        $info.lastStatus = [string]$status.status
        if (-not $runAt) {
            [void]$failures.Add('طابع التشغيل في status.json غير صالح')
        } else {
            $ranThisWindow = ($runAt -ge $windowStart)
            if (-not $ranThisWindow) {
                $taskRan = ($task -and $task.LastRunTime -and ([datetime]$task.LastRunTime) -ge $windowStart)
                if ($Now -lt $startDeadline -and -not $taskRan) {
                    # الموعد حلّ حديثاً ولم تبدأ المهمة بعد (مثلاً StartWhenAvailable بعد إقلاع).
                    return [pscustomobject]@{ level = 'PENDING'; failures = @(); warnings = @(); info = $info; reasons = @('لم يبدأ تشغيل ' + $expected.ToString('yyyy-MM-dd HH:mm') + ' بعد؛ ضمن المهلة') }
                }
                if ($taskRan) {
                    [void]$failures.Add('المهمة عملت ' + ([datetime]$task.LastRunTime).ToString('yyyy-MM-dd HH:mm') + ' لكن status.json لم يُحدَّث (آخر طابع ' + $status.stamp + ')')
                } else {
                    [void]$failures.Add('لم يعمل النسخ المجدول ' + $expected.ToString('yyyy-MM-dd HH:mm') + ' (آخر نسخة ' + $status.stamp + ')')
                }
            }
            if (($Now - $runAt).TotalHours -gt $MaxAgeHours) {
                [void]$failures.Add(('آخر نسخة أقدم من {0} ساعة ({1})' -f $MaxAgeHours, $status.stamp))
            }
        }

        switch ([string]$status.status) {
            'ok' { }
            'local-only' { [void]$warnings.Add('النسخة محفوظة على C: فقط؛ القرص الخارجي لم يكن موصولاً') }
            default { [void]$failures.Add('حالة آخر نسخة: ' + $status.status + ' — ' + (@($status.errors) -join ' | ')) }
        }
        if ($status.local -ne 'ok' -and [string]$status.status -ne 'failed') { [void]$failures.Add('local=' + $status.local) }

        $dbs = @($status.files | ForEach-Object { $_.database })
        foreach ($db in $script:RequiredDatabases) {
            $f = @($status.files | Where-Object { $_.database -ceq $db })
            if ($f.Count -ne 1) { [void]$failures.Add('نسخة القاعدة مفقودة: ' + $db); continue }
            if ($f[0].verified -notmatch 'VERIFYONLY') { [void]$failures.Add('القاعدة لم تُتحقَّق: ' + $db) }
        }
        $info.databases = ($dbs -join ',')

        # الملفات على C:
        $zipC = $null; $manC = $null
        if ($status.runDir) {
            $manC = Join-OzkMonPath ([string]$status.runDir) 'manifest.json'
            if (-not (Test-Path -LiteralPath $manC -PathType Leaf)) { [void]$failures.Add('manifest.json مفقود على C:'); $manC = $null }
            if ($status.compressed -and (-not $status.zip -or -not $status.zip.zip -or -not $status.zip.sha256)) {
                # مضغوطة بلا بيانات ZIP: الحمولة الوحيدة غير قابلة للتحقق، فلا يُعدّ ذلك نجاحاً.
                [void]$failures.Add('status.json يقول compressed=true بلا بيانات ZIP (اسم/بصمة)')
            } elseif ($status.compressed -and $status.zip) {
                $zipC = Join-OzkMonPath ([string]$status.runDir) ([string]$status.zip.zip)
                if (-not (Test-Path -LiteralPath $zipC -PathType Leaf)) { [void]$failures.Add('ZIP مفقود على C:'); $zipC = $null }
                elseif ((Get-OzkMonSha256 $zipC) -ne ([string]$status.zip.sha256).ToLowerInvariant()) { [void]$failures.Add('SHA256 للـZIP على C: لا يطابق status.json') }
                if ($manC) {
                    try {
                        $m = Read-OzkJsonFile $manC
                        if (-not $m.zip -or ([string]$m.zip.sha256).ToLowerInvariant() -ne ([string]$status.zip.sha256).ToLowerInvariant()) { [void]$failures.Add('manifest.json لا يطابق ZIP في status.json') }
                    } catch { [void]$failures.Add('manifest.json غير صالح على C:') }
                }
            } elseif (-not $status.compressed) {
                # بلا ضغط: الملفات الخام هي النسخة نفسها، فيُتحقَّق من كل واحد ببصمته.
                [void]$warnings.Add('النسخة غير مضغوطة (-NoCompress)')
                foreach ($f in @($status.files)) {
                    $raw = Join-OzkMonPath ([string]$status.runDir) ([string]$f.file)
                    if (-not (Test-Path -LiteralPath $raw -PathType Leaf)) { [void]$failures.Add('ملف خام مفقود على C: ' + $f.file) }
                    elseif ((Get-OzkMonSha256 $raw) -ne ([string]$f.sha256).ToLowerInvariant()) { [void]$failures.Add('SHA256 لا يطابق على C: ' + $f.file) }
                }
            }
        } else {
            [void]$failures.Add('runDir غير محدد في status.json')
        }

        # القرص الخارجي
        if ([string]$status.external -eq 'ok' -and $status.externalDir) {
            $root = [System.IO.Path]::GetPathRoot([string]$status.externalDir)
            $serial = & $script:VolumeSerialReader $root
            $info.externalSerial = $serial
            if (-not $serial) {
                [void]$warnings.Add('القرص الخارجي غير موصول الآن (' + $root + '): لم يُتحقَّق من نسخة D:')
            } elseif ($serial -ne $ExpectedDriveSerial) {
                [void]$failures.Add(('القرص الخارجي {0} رقمه {1} وليس {2}' -f $root, $serial, $ExpectedDriveSerial))
            } else {
                if (-not (& $script:MarkerChecker $root)) { [void]$failures.Add('ملف العلامة مفقود على القرص الخارجي') }
                if (-not $status.compressed) {
                    foreach ($f in @($status.files)) {
                        $rawD = Join-OzkMonPath ([string]$status.externalDir) ([string]$f.file)
                        if (-not (Test-Path -LiteralPath $rawD -PathType Leaf)) { [void]$failures.Add('ملف خام مفقود على القرص الخارجي: ' + $f.file) }
                        elseif ((Get-OzkMonSha256 $rawD) -ne ([string]$f.sha256).ToLowerInvariant()) { [void]$failures.Add('SHA256 لا يطابق على القرص الخارجي: ' + $f.file) }
                    }
                }
                if ($status.compressed -and $status.zip -and $status.zip.zip -and $status.zip.sha256) {
                    $zipD = Join-OzkMonPath ([string]$status.externalDir) ([string]$status.zip.zip)
                    if (-not (Test-Path -LiteralPath $zipD -PathType Leaf)) { [void]$failures.Add('ZIP مفقود على القرص الخارجي') }
                    elseif ((Get-OzkMonSha256 $zipD) -ne ([string]$status.zip.sha256).ToLowerInvariant()) { [void]$failures.Add('SHA256 للـZIP على القرص الخارجي لا يطابق') }
                }
                $manD = Join-OzkMonPath ([string]$status.externalDir) 'manifest.json'
                if (-not (Test-Path -LiteralPath $manD -PathType Leaf)) { [void]$failures.Add('manifest.json مفقود على القرص الخارجي') }
                elseif ($manC -and (Get-OzkMonSha256 $manD) -ne (Get-OzkMonSha256 $manC)) { [void]$failures.Add('manifest.json على القرص الخارجي لا يطابق C:') }
            }
        } elseif ([string]$status.external -eq 'missing') {
            # يغطيه تحذير local-only أعلاه.
        } elseif ([string]$status.status -eq 'ok') {
            [void]$failures.Add('external=' + $status.external + ' رغم status=ok')
        }

        # المساحة
        $spaceRoots = @([System.IO.Path]::GetPathRoot([string]$status.runDir))
        if ($status.externalDir) { $spaceRoots += [System.IO.Path]::GetPathRoot([string]$status.externalDir) }
        $space = @()
        foreach ($r in ($spaceRoots | Where-Object { $_ } | Select-Object -Unique)) {
            $free = [int64](& $script:FreeSpaceReader $r)
            if ($free -lt 0) { continue }
            $gb = [math]::Round($free / 1GB, 1)
            $space += ('{0} {1} GB' -f $r, $gb)
            if ($free -lt [int64]$FailFreeGB * 1GB) { [void]$failures.Add(('مساحة {0} {1} GB أقل من {2} GB: النسخ القادم سيتوقف' -f $r, $gb, $FailFreeGB)) }
            elseif ($free -lt [int64]$WarnFreeGB * 1GB) { [void]$warnings.Add(('مساحة {0} منخفضة: {1} GB' -f $r, $gb)) }
        }
        $info.space = ($space -join ' · ')
    }

    $level = $(if ($failures.Count -gt 0) { 'FAILURE' } elseif ($warnings.Count -gt 0) { 'WARNING' } else { 'SUCCESS' })
    return [pscustomobject]@{ level = $level; failures = @($failures); warnings = @($warnings); info = $info; reasons = @(@($failures) + @($warnings)) }
}

# ---------- التنبيه ومنع التكرار ----------

function Get-OzkFingerprint($Health) {
    $text = $Health.level + '|' + ((@($Health.reasons) | Sort-Object) -join '|')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text)) } finally { $sha.Dispose() }
    return ((($h | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16))
}

# يقرر هل يُرسل تنبيه الآن. يعيد سبب الإرسال أو ''.
function Get-OzkAlertDecision($Health, $State, [datetime]$Now, [int]$RepeatHours) {
    if ($Health.level -eq 'PENDING') { return '' }
    $fp = Get-OzkFingerprint $Health
    if (-not $State) { return 'first-run' }
    if ($State.pending -and $State.pending.delivered -eq $false) { return 'retry-undelivered' }
    if ($State.lastLevel -ne $Health.level) { return 'level-changed' }
    if ($Health.level -eq 'SUCCESS') { return '' }
    if ($State.lastFingerprint -ne $fp) { return 'reasons-changed' }
    $lastAt = ConvertTo-OzkDate $State.lastAlertAt
    if ($lastAt) {
        if (($Now - $lastAt).TotalHours -ge $RepeatHours) { return 'still-failing' }
        return ''
    }
    return 'no-previous-alert'
}

function Format-OzkMonitorAlert($Health, [string]$Reason) {
    $icon = switch ($Health.level) { 'SUCCESS' { '✅' } 'WARNING' { '⚠️' } default { '🚨' } }
    $lines = New-Object System.Collections.ArrayList
    $title = $(if ($Reason -eq 'level-changed' -and $Health.level -eq 'SUCCESS') { 'عادت سليمة' } else { $Health.level })
    [void]$lines.Add(('{0} مراقب النسخ الاحتياطي للأمين: {1}' -f $icon, $title))
    if ($Health.info.lastStamp) { [void]$lines.Add(('آخر نسخة: {0} ({1})' -f $Health.info.lastStamp, $Health.info.lastStatus)) }
    [void]$lines.Add(('الموعد المتوقع: {0}' -f $Health.info.expectedRun))
    if ($Health.info.space) { [void]$lines.Add(('المساحة: ' + $Health.info.space)) }
    foreach ($r in @($Health.failures)) { [void]$lines.Add('✗ ' + $r) }
    foreach ($r in @($Health.warnings)) { [void]$lines.Add('! ' + $r) }
    return ($lines -join "`n")
}

# يعيد $true فقط إن ظهر «TELEGRAM-NOTIFY OK».
function Send-OzkMonitorTelegram([string]$NotifyScript, [string]$Text, [string]$Key) {
    if (-not $NotifyScript -or -not (Test-Path -LiteralPath $NotifyScript)) { return [pscustomobject]@{ delivered = $false; detail = 'no-notify-script' } }
    try {
        $out = (& $NotifyScript -Message $Text -EventType 'windows' -DedupeKey $Key -DedupeMinutes 5 2>&1 6>&1 | Out-String)
        if ($out -match 'TELEGRAM-NOTIFY OK') { return [pscustomobject]@{ delivered = $true; detail = 'ok' } }
        return [pscustomobject]@{ delivered = $false; detail = ($out.Trim() -replace '\s+', ' ') }
    } catch {
        return [pscustomobject]@{ delivered = $false; detail = $_.Exception.Message }
    }
}

function Write-OzkMonitorLog([string]$StateDir, [string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        $logDir = Join-OzkMonPath $StateDir 'logs'
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        Add-Content -LiteralPath (Join-OzkMonPath $logDir ('monitor-' + (Get-Date -Format 'yyyy-MM') + '.log')) -Value $line -Encoding UTF8
    } catch {
        Write-Host ('LOG WRITE FAIL: ' + $_.Exception.Message)
    }
}

function Invoke-OzkBackupMonitor {
    [CmdletBinding()]
    param(
        [string]$StateDir = 'C:\ProgramData\OZK-TOBACCO\Backup',
        [string]$BackupTaskName = 'OZK Ameen Verified Backup',
        [string]$ScheduleTime = '23:00',
        [int]$GraceMinutes = 90,
        [int]$MaxAgeHours = 26,
        [string]$ExpectedDriveSerial = '34AD-2E92',
        [int]$FailFreeGB = 20,
        [int]$WarnFreeGB = 40,
        [int]$RepeatHours = 12,
        [string]$NotifyScript = '',
        [string]$ExpectedHost = 'OZK2026',
        [datetime]$Now = (Get-Date)
    )
    $hostName = & $script:HostNameReader
    $health = $null
    try {
        if ($hostName -ne $ExpectedHost) { throw ("الجهاز '{0}' ليس '{1}'" -f $hostName, $ExpectedHost) }
        $health = Get-OzkBackupHealth -StateDir $StateDir -BackupTaskName $BackupTaskName -ScheduleTime $ScheduleTime -GraceMinutes $GraceMinutes `
            -MaxAgeHours $MaxAgeHours -ExpectedDriveSerial $ExpectedDriveSerial -FailFreeGB $FailFreeGB -WarnFreeGB $WarnFreeGB -Now $Now
    } catch {
        $health = [pscustomobject]@{ level = 'FAILURE'; failures = @('عطل في المراقب: ' + $_.Exception.Message); warnings = @(); info = [ordered]@{ expectedRun = '' }; reasons = @('عطل في المراقب: ' + $_.Exception.Message) }
    }

    $statePath = Join-OzkMonPath $StateDir 'monitor-state.json'
    $state = $null
    try { $state = Read-OzkJsonFile $statePath } catch { $state = $null }

    $reason = Get-OzkAlertDecision $health $state $Now $RepeatHours
    $fp = Get-OzkFingerprint $health
    $delivery = $null
    $evaluateOnly = (-not $NotifyScript)
    if ($reason -and -not $evaluateOnly) {
        $text = Format-OzkMonitorAlert $health $reason
        $delivery = Send-OzkMonitorTelegram $NotifyScript $text ('ozk-backup-monitor-' + $health.level.ToLowerInvariant() + '-' + $fp)
    }
    if ($evaluateOnly) {
        # بلا -NotifyScript: تقييم وسجل فقط. لا تُحدَّث حالة التنبيهات كي لا يبتلع فحصٌ يدوي تنبيهاً.
        Write-OzkMonitorLog $StateDir ('CHECK {0} (evaluate-only, would-alert={1}) :: {2}' -f $health.level, $(if ($reason) { $reason } else { 'none' }), (@($health.reasons) -join ' | '))
        return [pscustomobject]@{ level = $health.level; health = $health; alertReason = $reason; delivery = $null; state = $state; evaluateOnly = $true }
    }

    $newState = [ordered]@{
        checkedAt       = $Now.ToString('o')
        lastLevel       = $(if ($health.level -eq 'PENDING' -and $state) { $state.lastLevel } else { $health.level })
        lastFingerprint = $(if ($health.level -eq 'PENDING' -and $state) { $state.lastFingerprint } else { $fp })
        lastAlertAt     = $(if ($state) { $state.lastAlertAt } else { $null })
        lastAlertReason = $(if ($state) { $state.lastAlertReason } else { $null })
        lastCheckLevel  = $health.level
        lastReasons     = @($health.reasons)
        pending         = $(if ($state) { $state.pending } else { $null })
    }
    if ($reason) {
        if ($delivery.delivered) {
            $newState.lastAlertAt = $Now.ToString('o')
            $newState.lastAlertReason = $reason
            $newState.pending = $null
        } else {
            # التنبيه لم يصل: تُحفظ الحادثة، ويُعاد الإرسال في الفحص القادم مهما كانت الحالة.
            $newState.pending = [ordered]@{ level = $health.level; reason = $reason; firstAttemptAt = $(if ($state -and $state.pending -and $state.pending.firstAttemptAt) { $state.pending.firstAttemptAt } else { $Now.ToString('o') }); lastAttemptAt = $Now.ToString('o'); attempts = $(if ($state -and $state.pending -and $state.pending.attempts) { [int]$state.pending.attempts + 1 } else { 1 }); delivered = $false; detail = $delivery.detail }
        }
    }
    try { & $script:JsonWriter $statePath $newState } catch { Write-Host ('STATE WRITE FAIL: ' + $_.Exception.Message) }
    Write-OzkMonitorLog $StateDir ('CHECK {0} alert={1} delivered={2} :: {3}' -f $health.level, $(if ($reason) { $reason } else { 'none' }), $(if ($delivery) { $delivery.delivered } else { 'n/a' }), (@($health.reasons) -join ' | '))

    return [pscustomobject]@{ level = $health.level; health = $health; alertReason = $reason; delivery = $delivery; state = [pscustomobject]$newState; evaluateOnly = $false }
}

function Invoke-OzkBackupMonitorMain([hashtable]$Arguments) {
    try {
        $r = Invoke-OzkBackupMonitor @Arguments
        switch ($r.level) { 'SUCCESS' { return 0 } 'PENDING' { return 0 } 'WARNING' { return 2 } default { return 1 } }
    } catch {
        Write-Host ('MONITOR FAIL: ' + $_.Exception.Message)
        return 3
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $code = Invoke-OzkBackupMonitorMain @{
        StateDir = $StateDir; BackupTaskName = $BackupTaskName; ScheduleTime = $ScheduleTime; GraceMinutes = $GraceMinutes
        MaxAgeHours = $MaxAgeHours; ExpectedDriveSerial = $ExpectedDriveSerial; FailFreeGB = $FailFreeGB; WarnFreeGB = $WarnFreeGB
        RepeatHours = $RepeatHours; NotifyScript = $NotifyScript; ExpectedHost = $ExpectedHost
    }
    exit $code
}
