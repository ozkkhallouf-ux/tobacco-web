#Requires -Version 5.1
# ============================================================
# ameen-invoice-agent-monitor.ps1 — مراقب مستقل لوكيل «أحداث فواتير الأمين»
#
# ⚠️ غير مفعَّل: لا مهمة مجدولة تشغّله، ولا يسجّل نفسه.
#
# لماذا (فجوة 2026-10-26): بعد #398 لا يخرج الوكيل عند انقطاع SQL، بل يسجّل DISCONNECTED ثم
# RECONNECTING بتراجع أسّي حتى RECOVERED أو GAVE_UP (~24 ساعة). العملية حيّة طوال ذلك، فمراقب
# «توقف الوكيل» لا يرى شيئاً، ويبقى الانقطاع صامتاً لساعات.
#
# ما يفعله (قراءة فقط تجاه الوكيل): يقرأ ذيل سجل الوكيل، ويستعلم اختيارياً عن وجود عمليته، ولا يتصل
# بـSQL ولا بالأمين ولا يلمس صندوق الأحداث. يعمل في عملية منفصلة (مهمة كل 5 دقائق)، فيكتشف التوقف
# حتى لو مات الوكيل أو تعلّق. يكتب فقط حالته (monitor-state.json) وسجله الشهري في -StateDir.
#
# التنبيهات (Telegram عبر -NotifyScript، النوع invoice_agent):
#   sql-down   انقطاع SQL مفتوح منذ -ThresholdMinutes (10) والوكيل حيّ — مرة واحدة لكل انقطاع.
#   sql-up     عودة الاتصال مع مدة الانقطاع — مرة واحدة، وفقط إن سبقه تنبيه عن الانقطاع نفسه.
#              انقطاع ≥ العتبة فات تنبيهه (المراقب لم يعمل) ⇒ رسالة واحدة «انقطع ثم عاد».
#   stopped    GAVE_UP أو FATAL أو انتهاء التشغيل أو رفض الإقلاع ⇒ فوراً. اختفاء العملية أو توقف
#              السجل بلا سطر نهاية ⇒ بعد تأكيده في فحصين متتاليين (-ConfirmMinutes)، كي لا يُبلَّغ
#              عن توقف وهمي لحظة الاستيقاظ من الإسبات. انقطاع SQL المفتوح يُذكر داخله، لا برسالة ثانية.
#   back       عودة الوكيل بعد تنبيه توقف — مرة واحدة؛ ويضم عودة SQL إن عاد معه.
#
# منع التكرار: لكل تنبيه مفتاح ثابت مشتق من وقت بداية الحادثة في السجل (لا من وقت الفحص)، فإعادة
# تشغيل المراقب تعيد حساب المفتاح نفسه. التنبيه يُعلَّم مُرسلاً فقط بسطر «TELEGRAM-NOTIFY OK»، والحالة
# تُحفظ ذرّياً بعد كل تنبيه واصل؛ ما لم يصل يُعاد في الفحص التالي بالمفتاح نفسه، والخادم يبتلع
# أي تكرار بنفس المفتاح خلال 24 ساعة (لو وصل الطلب وضاع الرد).
#
# الإرسال داخل العملية نفسها (&): تمرير نص عربي لعملية powershell.exe فرعية يكسر الوسائط على 5.1.
#
# الخصوصية: نص التنبيه نصوص ثابتة وأوقات ومدد واسم الجهاز ونوع الخطأ فقط — لا يُنقل أي نص من
# رسائل السجل (قد تحمل تفاصيل اتصال)، ولا يقرأ المراقب tools\.env إطلاقاً.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\ameen-invoice-agent-monitor.ps1 `
#       -AgentLogFile <سجل الوكيل> -NotifyScript tools\send-telegram-notification.ps1
#   (بلا -NotifyScript: يقيّم ويسجّل فقط، ولا يرسل ولا يغيّر حالة التنبيهات)
#
# رموز الخروج: 0 سليم · 1 الوكيل متوقف · 2 انقطاع SQL مفتوح · 3 خطأ في المراقب نفسه.
# ============================================================
[CmdletBinding()]
param(
    [string]$AgentLogFile = "$PSScriptRoot\logs\ameen-invoice-events.log",
    [string]$StateDir = 'C:\ProgramData\OZK-TOBACCO\invoice-agent-monitor',
    [int]$ThresholdMinutes = 10,
    [int]$LiveWindowMinutes = 12,
    [int]$ConfirmMinutes = 4,
    [int]$FlapMinutes = 6,
    [int]$LateRecoveryMinutes = 60,
    [int]$TailBytes = 4194304,
    [string]$NotifyScript = '',
    [string]$ExpectedHost = 'OZK2026'
)

$ErrorActionPreference = 'Stop'

$script:EventType = 'invoice_agent'
$script:KeyPrefix = 'invoice-agent:'
$script:DedupeMinutes = 1440
$script:MaxSentKeys = 300

# ---------- نقاط حقن للاختبارات (كلها قراءة) ----------

$script:HostNameReader = { return $env:COMPUTERNAME }

# هل عملية الوكيل موجودة؟ $true/$false، أو $null إن تعذّر الحكم (لا صلاحية لقراءة سطر الأوامر).
$script:AgentProcessProbe = {
    try {
        $procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop)
    } catch { return $null }
    $unknown = $false
    foreach ($p in $procs) {
        if ($null -eq $p.CommandLine) { $unknown = $true; continue }
        if ($p.CommandLine -match 'ameen-invoice-event-agent\.ps1' -and $p.CommandLine -notmatch '-ListDeadLetter|-RepairDeadLetterSeq') { return $true }
    }
    if ($unknown) { return $null }
    return $false
}

# حفظ ذرّي: ملف مؤقت ثم استبدال، فانقطاع الكهرباء أثناء الحفظ لا يترك حالة نصف مكتوبة.
$script:JsonWriter = {
    param([string]$Path, $Object)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $tmp = $Path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, ($Object | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [System.IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $Path) }
}

# ---------- قراءة السجل ----------

# ذيل السجل (آخر TailBytes) بمشاركة كاملة: الوكيل يكتب فيه أثناء القراءة.
function Read-AgentLogTail([string]$Path, [int]$TailBytes) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $fs = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    try {
        $offset = [math]::Max([int64]0, $fs.Length - $TailBytes)
        [void]$fs.Seek($offset, [System.IO.SeekOrigin]::Begin)
        $buf = New-Object byte[] ([int]($fs.Length - $offset))
        $read = 0
        while ($read -lt $buf.Length) { $n = $fs.Read($buf, $read, $buf.Length - $read); if ($n -le 0) { break }; $read += $n }
    } finally { $fs.Dispose() }
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read).TrimStart([char]0xFEFF)
    $lines = @($text -split "`r?`n")
    if ($offset -gt 0 -and $lines.Count -gt 0) { $lines = @($lines | Select-Object -Skip 1) }
    return ,$lines
}

# سطر السجل ⇐ {ts; kind; type}. kind: disconnected/reconnecting/recovered/start/gaveup/fatal/end/config
# /ignore/other. النص نفسه لا يُحفظ: لا يخرج من هنا إلا الوقت والنوع ورمز نوع الخطأ.
function ConvertFrom-AgentLogLine([string]$Line) {
    if ($Line -notmatch '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$') { return $null }
    $ts = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$ts)) { return $null }
    $msg = $Matches[2]
    $kind = 'other'; $type = $null
    if ($msg.StartsWith('DISCONNECTED:')) { $kind = 'disconnected' }
    elseif ($msg.StartsWith('RECONNECTING:')) { $kind = 'reconnecting' }
    elseif ($msg.StartsWith('RECOVERED:')) { $kind = 'recovered' }
    elseif ($msg.StartsWith('GAVE_UP:')) { $kind = 'gaveup' }
    elseif ($msg.StartsWith('FATAL:')) {
        $kind = 'fatal'
        if ($msg -match '^FATAL:[^(]*\(([A-Za-z][A-Za-z0-9_.]{0,80})(?: (\d{1,6}))?\)') { $type = $Matches[1]; if ($Matches[2]) { $type += ' ' + $Matches[2] } }
    }
    elseif ($msg.StartsWith('بدء الوكيل:')) { $kind = 'start' }
    elseif ($msg.StartsWith('انتهى الوكيل:')) { $kind = 'end' }
    # مثيل ثانٍ رُفض (رمز 5) يكتب في السجل نفسه بينما الأول يعمل: ليس حدثاً عن الوكيل العامل.
    elseif ($msg.StartsWith('رفض: مثيل آخر')) { $kind = 'ignore' }
    elseif ($msg.StartsWith('رفض:') -or $msg.StartsWith('خطأ: AMEEN_SQL_CONNECTION_STRING')) { $kind = 'config' }
    return [pscustomobject]@{ ts = $ts; kind = $kind; type = $type }
}

function Format-AgentId([datetime]$Ts) { return $Ts.ToString('yyyyMMdd\THHmmss', [System.Globalization.CultureInfo]::InvariantCulture) }

# مفتاح داخلي (لا يُرسل): «أُبلغ عن عودة الحادثة عند هذا الإغلاق».
function Get-UpClosureKey($Incident) { return ($script:KeyPrefix + 'sql-up-closed:' + $Incident.id + '@' + (Format-AgentId $Incident.closedAt)) }

function Test-SentKey($State, [string]$Key) {
    if ($null -eq $State -or $null -eq $State.sentKeys) { return $false }
    return (@($State.sentKeys) -contains $Key)
}

# يطوي أحداث السجل زمنياً: حوادث انقطاع SQL، وآخر سطر نهاية، وآخر إقلاع.
# العودة (RECOVERED أو إقلاع جديد) إغلاق مبدئي: انقطاع جديد خلال -FlapMinutes يُكمل الحادثة نفسها
# (اتصال يتأرجح) ما لم يكن تنبيه عودتها قد أُرسل عن هذا الإغلاق بعينه. الإغلاق يتأكد بمرور -FlapMinutes بلا انقطاع.
# المنع مربوط بوقت الإغلاق الذي أُبلغ عنه لا بالحادثة كلها، فإعادة طيّ السجل نفسه بعد الإرسال تعطي
# التجميع نفسه (Codex P2 على cf82cff3: عودة قصيرة داخل انقطاع أُبلغ عن نهايته كانت تشطره حادثتين).
function Get-AgentTimeline($Lines, $State, [int]$FlapMinutes) {
    $events = @()
    foreach ($l in @($Lines)) { $e = ConvertFrom-AgentLogLine $l; if ($e) { $events += $e } }
    $incidents = New-Object System.Collections.ArrayList
    $current = $null; $terminal = $null; $lastStart = $null; $lastLine = $null
    # الذيل قُصّ بعد بداية حادثة مفتوحة محفوظة في الحالة: تُستأنف بمعرّفها الأصلي.
    if ($State -and $State.openSql -and $events.Count -gt 0) {
        $seedStart = ConvertTo-MonDate $State.openSql.start
        if ($seedStart -and $events[0].ts -gt $seedStart) {
            $current = [pscustomobject]@{ id = [string]$State.openSql.id; start = $seedStart; closedAt = $null }
            [void]$incidents.Add($current)
        }
    }
    foreach ($e in $events) {
        if ($e.kind -eq 'ignore') { continue }
        $lastLine = $e.ts
        if ($terminal -and @('gaveup', 'fatal', 'end', 'config') -notcontains $e.kind) { $terminal = $null }
        switch ($e.kind) {
            { $_ -eq 'disconnected' -or $_ -eq 'reconnecting' } {
                $reopen = ($current -and $current.closedAt -and (($e.ts - $current.closedAt).TotalMinutes -lt $FlapMinutes) -and -not (Test-SentKey $State (Get-UpClosureKey $current)))
                if ($current -and -not $current.closedAt) { }
                elseif ($reopen) { $current.closedAt = $null }
                else {
                    $current = [pscustomobject]@{ id = (Format-AgentId $e.ts); start = $e.ts; closedAt = $null }
                    [void]$incidents.Add($current)
                }
            }
            'recovered' { if ($current -and -not $current.closedAt) { $current.closedAt = $e.ts } }
            'start' {
                if ($current -and -not $current.closedAt) { $current.closedAt = $e.ts }
                $lastStart = $e.ts
            }
            { @('gaveup', 'fatal', 'end', 'config') -contains $_ } { $terminal = $e }
        }
    }
    return [pscustomobject]@{ incidents = @($incidents); terminal = $terminal; lastStart = $lastStart; lastLine = $lastLine; hasLog = ($null -ne $Lines) }
}

function ConvertTo-MonDate($Value) {
    if ($null -eq $Value -or '' -eq $Value) { return $null }
    if ($Value -is [datetime]) { return [datetime]$Value }
    $out = [datetime]::MinValue
    if ([datetime]::TryParse([string]$Value, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind, [ref]$out)) { return $out }
    return $null
}

# ---------- الحكم ----------

function Format-MonDuration([timespan]$Span) {
    $mins = [int][math]::Floor($Span.TotalMinutes)
    if ($mins -lt 1) { return 'أقل من دقيقة' }
    $h = [int][math]::Floor($mins / 60); $m = $mins % 60
    if ($h -eq 0) { return ('{0} دقيقة' -f $m) }
    if ($m -eq 0) { return ('{0} ساعة' -f $h) }
    return ('{0} ساعة و{1} دقيقة' -f $h, $m)
}

function Format-MonTime([datetime]$Ts) { return $Ts.ToString('yyyy-MM-dd HH:mm', [System.Globalization.CultureInfo]::InvariantCulture) }

# حالة الوكيل الآن: alive أو suspect (توقف غير مؤكد بعد) أو stopped، مع السبب ومعرّف ثابت للتوقف.
function Get-AgentStatus($Timeline, $ProcessAlive, $State, [datetime]$Now, [int]$LiveWindowMinutes, [int]$ConfirmMinutes) {
    if (-not $Timeline.hasLog -or $null -eq $Timeline.lastLine) {
        if ($ProcessAlive -eq $true) { return [pscustomobject]@{ status = 'alive'; reason = $null; id = $null; type = $null } }
        return [pscustomobject]@{ status = 'stopped'; reason = 'no-log'; id = 'no-log'; type = $null }
    }
    if ($Timeline.terminal) {
        $t = $Timeline.terminal
        return [pscustomobject]@{ status = 'stopped'; reason = $t.kind; id = ((Format-AgentId $t.ts) + '-' + $t.kind); type = $t.type }
    }
    $age = ($Now - $Timeline.lastLine).TotalMinutes
    $reason = $null
    if ($ProcessAlive -eq $false) { $reason = 'process-missing' }
    elseif ($age -ge $LiveWindowMinutes) { if ($ProcessAlive -eq $true) { $reason = 'hung' } else { $reason = 'stale' } }
    if (-not $reason) { return [pscustomobject]@{ status = 'alive'; reason = $null; id = $null; type = $null } }
    # بلا سطر نهاية: يتأكد التوقف بفحصين متتاليين بينهما ConfirmMinutes على الأقل (الاستيقاظ من الإسبات
    # يشغّل المراقب قبل أن يكتب الوكيل أول سطر له).
    $id = (Format-AgentId $Timeline.lastLine) + '-silent'
    $first = $null
    if ($State -and $State.suspect -and [string]$State.suspect.id -eq $id) { $first = ConvertTo-MonDate $State.suspect.firstSeen }
    if ($first -and ($Now - $first).TotalMinutes -ge $ConfirmMinutes) { return [pscustomobject]@{ status = 'stopped'; reason = $reason; id = $id; type = $null; ageMinutes = $age } }
    return [pscustomobject]@{ status = 'suspect'; reason = $reason; id = $id; type = $null; ageMinutes = $age }
}

function Get-StopReasonText($Status) {
    switch ($Status.reason) {
        'gaveup' { return 'استنفد محاولات إعادة اتصال SQL (GAVE_UP) وخرج' }
        'fatal' { if ($Status.type) { return ('خطأ غير متوقع أوقفه (FATAL: {0})' -f $Status.type) } return 'خطأ غير متوقع أوقفه (FATAL)' }
        'end' { return 'انتهى تشغيله' }
        'config' { return 'رفض الإقلاع (إعداد أو قاعدة بيانات غير صحيحة)' }
        'process-missing' { return 'عمليته غير موجودة' }
        'hung' { return ('عمليته موجودة لكن سجله متوقف منذ {0} دقيقة' -f [int]$Status.ageMinutes) }
        'stale' { return ('لا جديد في سجله منذ {0} دقيقة' -f [int]$Status.ageMinutes) }
        'no-log' { return 'لا يوجد سجل للوكيل' }
    }
    return 'سبب غير معروف'
}

# قائمة التنبيهات المستحقة الآن بترتيبها الزمني. كل تنبيه: key ونص وما يُعلَّم عند وصوله.
function Get-AgentMonitorAlerts($Timeline, $Status, $State, [datetime]$Now, [string]$HostName, [int]$ThresholdMinutes, [int]$FlapMinutes, [int]$LateRecoveryMinutes) {
    $alerts = New-Object System.Collections.ArrayList
    $p = $script:KeyPrefix
    # الاسم والرمزان ⛔/✅ كما في تنبيهات المراقب التجريبي (DRY RUN 2026-10-25) كي لا تختلف الرسائل.
    $who = ('وكيل أحداث الفواتير على {0}' -f $HostName)
    $alive = ($Status.status -eq 'alive')
    $open = $null
    $notified = @(); if ($State -and $State.notifiedIncidents) { $notified = @($State.notifiedIncidents) }
    $backDue = ($alive -and $State -and $State.stop -and -not (Test-SentKey $State ($p + 'back:' + $State.stop.id)))
    $mergedUp = $null
    foreach ($inc in $Timeline.incidents) {
        $upKey = $p + 'sql-up:' + $inc.id; $downKey = $p + 'sql-down:' + $inc.id
        if (-not $inc.closedAt) {
            $open = $inc
            if ($alive -and ($Now - $inc.start).TotalMinutes -ge $ThresholdMinutes -and -not (Test-SentKey $State $downKey)) {
                $text = "🔴 {0}: اتصال SQL منقطع منذ {1} (من {2}).`nالوكيل يعيد المحاولة تلقائياً، ولا يُفقد أي حدث." -f $who, (Format-MonDuration ($Now - $inc.start)), (Format-MonTime $inc.start)
                [void]$alerts.Add([pscustomobject]@{ key = $downKey; kind = 'sql-down'; text = $text; marks = @($downKey); incident = $inc.id; stopId = $null })
            }
            continue
        }
        if (Test-SentKey $State $upKey) { continue }
        $dur = Format-MonDuration ($inc.closedAt - $inc.start)
        # انقطاع ذُكر في تنبيه التوقف ثم عاد مع عودة الوكيل: يُضم إلى رسالة «عاد الوكيل» بدل رسالتين.
        if ($backDue -and ($notified -contains $inc.id)) { $mergedUp = [pscustomobject]@{ key = $upKey; dur = $dur; closure = (Get-UpClosureKey $inc) }; continue }
        if (($Now - $inc.closedAt).TotalMinutes -lt $FlapMinutes) { continue }
        if ((Test-SentKey $State $downKey) -or ($notified -contains $inc.id)) {
            $text = "🟢 {0}: عاد اتصال SQL بعد انقطاع دام {1} (من {2} حتى {3})." -f $who, $dur, (Format-MonTime $inc.start), (Format-MonTime $inc.closedAt)
            [void]$alerts.Add([pscustomobject]@{ key = $upKey; kind = 'sql-up'; text = $text; marks = @($upKey, (Get-UpClosureKey $inc)); incident = $inc.id; stopId = $null })
        } elseif (($inc.closedAt - $inc.start).TotalMinutes -ge $ThresholdMinutes -and ($Now - $inc.closedAt).TotalMinutes -le $LateRecoveryMinutes) {
            $text = "🟢 {0}: انقطع اتصال SQL {1} (من {2} حتى {3}) ثم عاد.`nلم يُرسل تنبيه الانقطاع في حينه (المراقب لم يعمل خلاله)." -f $who, $dur, (Format-MonTime $inc.start), (Format-MonTime $inc.closedAt)
            [void]$alerts.Add([pscustomobject]@{ key = $upKey; kind = 'sql-up'; text = $text; marks = @($upKey, (Get-UpClosureKey $inc)); incident = $inc.id; stopId = $null })
        }
    }
    if ($Status.status -eq 'stopped') {
        $stopKey = $p + 'stopped:' + $Status.id
        if (-not (Test-SentKey $State $stopKey)) {
            $lines = @(('⛔ {0} توقف.' -f $who), ('السبب: {0}.' -f (Get-StopReasonText $Status)))
            if ($Timeline.lastLine) { $lines += ('آخر سطر في سجله: {0}.' -f (Format-MonTime $Timeline.lastLine)) }
            if ($open) { $lines += ('اتصال SQL كان منقطعاً منذ {0} ({1}).' -f (Format-MonTime $open.start), (Format-MonDuration ($Now - $open.start))) }
            $lines += 'الأحداث المحفوظة في الصندوق المحلي لا تضيع.'
            [void]$alerts.Add([pscustomobject]@{ key = $stopKey; kind = 'stopped'; text = ($lines -join "`n"); marks = @($stopKey); incident = $(if ($open) { $open.id } else { $null }); stopId = $Status.id })
        }
    } elseif ($backDue) {
        $backKey = $p + 'back:' + $State.stop.id
        $lines = @(('✅ {0} رجع شغّال.' -f $who))
        if ($Timeline.lastStart) { $lines += ('أقلع: {0}.' -f (Format-MonTime $Timeline.lastStart)) }
        $marks = @($backKey)
        if ($mergedUp) { $lines += ('واتصال SQL عاد بعد انقطاع دام {0}.' -f $mergedUp.dur); $marks += $mergedUp.key; $marks += $mergedUp.closure }
        [void]$alerts.Add([pscustomobject]@{ key = $backKey; kind = 'back'; text = ($lines -join "`n"); marks = $marks; incident = $null; stopId = $null })
    }
    return [pscustomobject]@{ alerts = @($alerts); open = $open }
}

# ---------- الإرسال والسجل ----------

# يعيد delivered=$true فقط إن ظهر «TELEGRAM-NOTIFY OK».
function Send-AgentMonitorTelegram([string]$NotifyScript, [string]$Text, [string]$Key) {
    if (-not $NotifyScript -or -not (Test-Path -LiteralPath $NotifyScript)) { return [pscustomobject]@{ delivered = $false; detail = 'no-notify-script' } }
    try {
        $out = (& $NotifyScript -Message $Text -EventType $script:EventType -DedupeKey $Key -DedupeMinutes $script:DedupeMinutes 2>&1 6>&1 | Out-String)
        if ($out -match 'TELEGRAM-NOTIFY OK') { return [pscustomobject]@{ delivered = $true; detail = 'ok' } }
        return [pscustomobject]@{ delivered = $false; detail = ($out.Trim() -replace '\s+', ' ') }
    } catch {
        return [pscustomobject]@{ delivered = $false; detail = $_.Exception.GetType().Name }
    }
}

function Write-AgentMonitorLog([string]$StateDir, [string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    try {
        $logDir = [System.IO.Path]::Combine($StateDir, 'logs')
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        Add-Content -LiteralPath ([System.IO.Path]::Combine($logDir, ('monitor-' + (Get-Date -Format 'yyyy-MM') + '.log'))) -Value $line -Encoding UTF8
    } catch {
        Write-Host ('LOG WRITE FAIL: ' + $_.Exception.GetType().Name)
    }
}

function ConvertTo-MonStateObject($State) {
    $o = [ordered]@{ checkedAt = $null; sentKeys = @(); notifiedIncidents = @(); openSql = $null; stop = $null; suspect = $null; lastStatus = $null }
    if ($State) {
        if ($State.sentKeys) { $o.sentKeys = @($State.sentKeys) }
        if ($State.notifiedIncidents) { $o.notifiedIncidents = @($State.notifiedIncidents) }
        $o.openSql = $State.openSql; $o.stop = $State.stop; $o.suspect = $State.suspect; $o.lastStatus = $State.lastStatus
    }
    return $o
}

function Invoke-AgentMonitor {
    [CmdletBinding()]
    param(
        [string]$AgentLogFile,
        [string]$StateDir = 'C:\ProgramData\OZK-TOBACCO\invoice-agent-monitor',
        [int]$ThresholdMinutes = 10,
        [int]$LiveWindowMinutes = 12,
        [int]$ConfirmMinutes = 4,
        [int]$FlapMinutes = 6,
        [int]$LateRecoveryMinutes = 60,
        [int]$TailBytes = 4194304,
        [string]$NotifyScript = '',
        [string]$ExpectedHost = 'OZK2026',
        [datetime]$Now = (Get-Date)
    )
    $hostName = [string](& $script:HostNameReader)
    if ($hostName -ne $ExpectedHost) { throw ("الجهاز '{0}' ليس '{1}'" -f $hostName, $ExpectedHost) }

    $statePath = [System.IO.Path]::Combine($StateDir, 'monitor-state.json')
    $state = $null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        try { $state = [System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $state = $null; Write-AgentMonitorLog $StateDir 'STATE UNREADABLE: تُعاد من الصفر (مفاتيح الخادم تمنع التكرار 24 ساعة)' }
    }

    $lines = Read-AgentLogTail $AgentLogFile $TailBytes
    $timeline = Get-AgentTimeline $lines $state $FlapMinutes
    $proc = & $script:AgentProcessProbe
    $status = Get-AgentStatus $timeline $proc $state $Now $LiveWindowMinutes $ConfirmMinutes
    $plan = Get-AgentMonitorAlerts $timeline $status $state $Now $hostName $ThresholdMinutes $FlapMinutes $LateRecoveryMinutes
    $summary = 'agent={0}{1} sql={2} alerts={3}' -f $status.status, $(if ($status.reason) { '(' + $status.reason + ')' } else { '' }), $(if ($plan.open) { 'down-since-' + $plan.open.id } else { 'ok' }), (@($plan.alerts | ForEach-Object { $_.kind }) -join ',')

    if (-not $NotifyScript) {
        # بلا -NotifyScript: تقييم وسجل فقط. لا تُحدَّث الحالة كي لا يبتلع فحصٌ يدوي تنبيهاً.
        Write-AgentMonitorLog $StateDir ('CHECK (evaluate-only) ' + $summary)
        return [pscustomobject]@{ status = $status; open = $plan.open; alerts = $plan.alerts; delivered = @(); evaluateOnly = $true }
    }

    $newState = ConvertTo-MonStateObject $state
    $newState.checkedAt = $Now.ToString('o')
    $newState.lastStatus = $status.status
    $newState.openSql = $(if ($plan.open) { [ordered]@{ id = $plan.open.id; start = $plan.open.start.ToString('o') } } else { $null })
    if ($status.status -eq 'suspect') {
        if (-not ($state -and $state.suspect -and [string]$state.suspect.id -eq $status.id)) { $newState.suspect = [ordered]@{ id = $status.id; firstSeen = $Now.ToString('o') } }
    } elseif ($status.status -eq 'alive') { $newState.suspect = $null }

    $delivered = @()
    $failed = $null
    foreach ($a in $plan.alerts) {
        $r = Send-AgentMonitorTelegram $NotifyScript $a.text $a.key
        if (-not $r.delivered) { $failed = [pscustomobject]@{ key = $a.key; detail = $r.detail }; break }
        $delivered += $a.key
        $newState.sentKeys = @(@($newState.sentKeys) + @($a.marks) | Select-Object -Last $script:MaxSentKeys)
        if ($a.kind -eq 'stopped') {
            $newState.stop = [ordered]@{ id = $a.stopId; at = $Now.ToString('o') }
            if ($a.incident) { $newState.notifiedIncidents = @(@($newState.notifiedIncidents) + $a.incident | Select-Object -Last 50) }
        }
        if ($a.kind -eq 'back') { $newState.stop = $null }
        # يُحفظ بعد كل تنبيه واصل: لو مات المراقب بعده لا يُعاد إرساله.
        try { & $script:JsonWriter $statePath $newState } catch { Write-AgentMonitorLog $StateDir ('STATE WRITE FAIL: ' + $_.Exception.GetType().Name) }
    }
    try { & $script:JsonWriter $statePath $newState } catch { Write-AgentMonitorLog $StateDir ('STATE WRITE FAIL: ' + $_.Exception.GetType().Name) }
    Write-AgentMonitorLog $StateDir ('CHECK ' + $summary + ' delivered=' + ($delivered -join ',') + $(if ($failed) { ' FAILED=' + $failed.key + ' (' + $failed.detail + ') — يعاد في الفحص التالي' } else { '' }))
    return [pscustomobject]@{ status = $status; open = $plan.open; alerts = $plan.alerts; delivered = $delivered; failed = $failed; evaluateOnly = $false }
}

function Invoke-AgentMonitorMain([hashtable]$Arguments) {
    try {
        $r = Invoke-AgentMonitor @Arguments
        if ($r.status.status -eq 'stopped') { return 1 }
        if ($r.open) { return 2 }
        return 0
    } catch {
        Write-Host ('MONITOR FAIL: ' + $_.Exception.Message)
        return 3
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $code = Invoke-AgentMonitorMain @{
        AgentLogFile = $AgentLogFile; StateDir = $StateDir; ThresholdMinutes = $ThresholdMinutes; LiveWindowMinutes = $LiveWindowMinutes
        ConfirmMinutes = $ConfirmMinutes; FlapMinutes = $FlapMinutes; LateRecoveryMinutes = $LateRecoveryMinutes; TailBytes = $TailBytes
        NotifyScript = $NotifyScript; ExpectedHost = $ExpectedHost
    }
    exit $code
}
