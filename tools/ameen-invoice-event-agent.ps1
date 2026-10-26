# ============================================================
# ameen-invoice-event-agent.ps1 — وكيل «أحداث فواتير الأمين» (المرحلة 2)
#
# ⚠️ غير مفعَّل: لا مهمة مجدولة تشغّله، ولا يسجّل نفسه، ولا يرسل شيئاً افتراضياً.
#
# ما يفعله:
#   ١) يرصد فواتير المبيع والمرتجع (BillType 1/3) في AmnDb002 كل ثانيتين، قراءة فقط:
#      log000 على فهرس LogTime (إنشاء/تعديل/حذف) وbu000 على CreateDate/LastUpdateDate احتياطاً.
#   ٢) مطابقة كاملة بالبصمة كل 10 دقائق تلتقط ما فات الرصد التزايدي.
#   ٣) لكل فاتورة تغيّر محتواها: لقطة كاملة (رأس + أسطر) وبصمة SHA-256 ⇒ حدث upsert واحد.
#      الحذف المؤكَّد (غياب الـGUID من bu000) ⇒ حدث delete. نفس النسخة لا تُصدر مرتين.
#   ٤) الأحداث تُكتب في صندوق إرسال محلي على القرص (Outbox) بتسلسل متزايد، فانقطاع الإنترنت
#      لا يُضيع شيئاً.
#   ٥) الإرسال إلى Supabase (الدالة apply_ameen_invoice_events من proposed/18) لا يحدث إلا
#      بشرطين معاً: المفتاح -Send، وملف تفعيل يضعه المالك يدوياً في مجلد الصندوق:
#         <OutboxDir>\send-enabled.flag   (محتواه: enabled-by-owner)
#
# حدود ثابتة:
#   * SQL قراءة فقط (Assert-AmeenReadOnlySql قبل كل تنفيذ)، بلا NOLOCK، مع LOCK_TIMEOUT 3000.
#   * لا يقرأ سلسلة اتصال الكتابة إطلاقاً — AMEEN_SQL_CONNECTION_STRING وحدها.
#   * يرفض العمل على قاعدة غير AmnDb002 إلا بـ -ExpectedDatabase صريح (لقاعدة الاختبار).
#   * حارس أداء: دورة أبطأ من 500ms أو مهلات أقفال ⇒ يبطّئ الإيقاع تلقائياً حتى 30 ثانية.
#   * تعافي الاتصال (2026-10-26): انقطاع SQL أو عودة الجهاز من الإسبات ⇒ سطر DISCONNECTED ثم إعادة فتح
#     بتراجع أسّي (2 ← 300 ث) مع RECONNECTING/RECOVERED، دون تقدّم العلامة المائية أو حفظ الحالة لتلك
#     الدورة؛ بعد العودة يُعاد التحقق من اسم القاعدة وتُستأنف الدورة من العلامة نفسها. استنفاد المحاولات
#     (-MaxReconnectAttempts) ⇒ FATAL وخروج برمز 6. أي خطأ قاتل آخر يُسجَّل قبل الخروج برمز 1.
#
# التشغيل اليدوي (للمراجعة فقط، بعد موافقة المالك):
#   .\tools\ameen-invoice-event-agent.ps1 -Once                 # دورة رصد واحدة، تكتب الصندوق المحلي فقط
#   .\tools\ameen-invoice-event-agent.ps1 -RunMinutes 30        # رصد لمدة 30 دقيقة بلا إرسال
#   .\tools\ameen-invoice-event-agent.ps1 -Send                 # يرسل فقط إن وُجد ملف التفعيل
#
# الأحداث المعزولة (Dead Letter) — محلياً فقط، بلا اتصال بالأمين ولا Supabase:
#   .\tools\ameen-invoice-event-agent.ps1 -ListDeadLetter                               # التسلسل والسبب والمعرّف
#   .\tools\ameen-invoice-event-agent.ps1 -RepairDeadLetterSeq <seq> -RepairMode Resnapshot
#       (المفضّل) لقطة جديدة من الأمين في المطابقة التالية بتسلسل أحدث — الحالة الحالية هي الحقيقة.
#   .\tools\ameen-invoice-event-agent.ps1 -RepairDeadLetterSeq <seq> -RepairMode Requeue
#       بعد تصحيح ملف deadletter\<seq>.json يدوياً: يُعاد إلى الصف بتسلسله الأصلي بعد التحقق؛
#       إن سبقه حدث أحدث للفاتورة فالخادم يعدّه stale ولا يكتب فوق الأحدث.
# ============================================================
param(
    [int]$PollSeconds = 2,
    [int]$ReconcileMinutes = 10,
    [int]$PeriodDays = 60,
    # أقصى لقطات في دورة مطابقة واحدة: أول تشغيل يرى ~2000 فاتورة غير معروفة، فتُقرأ على دفعات
    # متتالية بدل ضغطة واحدة على الأمين.
    [int]$ReconcileBatch = 150,
    [int]$RunMinutes = 0,
    # سطر أداء دوري في السجل: عدد الدورات ومتوسط زمنها وأقصاه، وعدد الحفظ الكامل وحفظ العلامة وحدها.
    [int]$PerfLogMinutes = 5,
    # تعافي الاتصال: حدّ المحاولات المتتالية (60 ≈ 4.5 ساعات عند سقف 300 ث) ثم خروج برمز 6.
    [int]$MaxReconnectAttempts = 60,
    [int]$ReconnectBaseSeconds = 2,
    [int]$ReconnectMaxSeconds = 300,
    [switch]$Once,
    [switch]$Send,
    [string]$OutboxDir = (Join-Path $env:ProgramData "OZK-TOBACCO\ameen-invoice-events"),
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\ameen-invoice-events.log",
    [string]$ExpectedDatabase = "AmnDb002",
    [switch]$ListDeadLetter,
    [long]$RepairDeadLetterSeq = 0,
    [ValidateSet("Resnapshot", "Requeue")][string]$RepairMode = "Resnapshot"
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "ameen-invoice-events-lib.ps1")

$RpcName = "apply_ameen_invoice_events"

function Write-AgentLog([string]$Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

# الإعدادات: المفاتيح المطلوبة وحدها من ملف .env (لا تُحمَّل بقية الأسرار في العملية).
$wanted = @("AMEEN_SQL_CONNECTION_STRING", "TOBACCO_SUPABASE_URL", "TOBACCO_SUPABASE_PUBLIC_KEY", "TOBACCO_SYNC_EMAIL", "TOBACCO_SYNC_PASSWORD")
$settings = @{}
if (Test-Path -LiteralPath $EnvFile) {
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
        if ($line -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+)$' -and $wanted -contains $Matches[1]) { $settings[$Matches[1]] = $Matches[2].Trim() }
    }
}
function Get-AgentSetting([string]$Name) {
    if ($settings.ContainsKey($Name)) { return $settings[$Name] }
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

# ---------------------------------------------------------------- الأحداث المعزولة (محلياً فقط)
# قفل مثيل واحد على مجلد الصندوق قبل قراءة الحالة أو تخصيص أي تسلسل (Codex P1). العرض وحده لا يكتب
# فلا يحتاجه؛ الإصلاح والرصد والإرسال يحتاجونه. مثيل ثانٍ يخرج فوراً برمز 5 بلا أي كتابة.
$outboxLock = $null
if (-not ($ListDeadLetter -and $RepairDeadLetterSeq -le 0)) {
    $outboxLock = Enter-AmeenOutboxLock -Dir $OutboxDir
    if ($null -eq $outboxLock) { Write-AgentLog ("رفض: مثيل آخر من الوكيل يعمل على الصندوق نفسه ({0}) — لا تشغيل متوازٍ." -f $OutboxDir); exit 5 }
}

if ($ListDeadLetter -or $RepairDeadLetterSeq -gt 0) {
    Initialize-AmeenInvoiceOutbox -Dir $OutboxDir
    if ($ListDeadLetter) {
        $items = @(Get-AmeenDeadLetters -Dir $OutboxDir)
        Write-Host ("أحداث معزولة: {0}" -f $items.Count)
        foreach ($i in $items) { Write-Host ("  seq={0} kind={1} bill={2} source={3} code={4} reason={5} at={6}" -f $i.source_seq, $i.kind, $i.bill_guid, $i.source, $i.reason_code, $i.reason, $i.at) }
    }
    if ($RepairDeadLetterSeq -gt 0) {
        $state = Read-AmeenInvoiceState -Dir $OutboxDir
        $mode = Repair-AmeenDeadLetter -Dir $OutboxDir -State $state -Seq $RepairDeadLetterSeq -Mode $RepairMode
        Save-AmeenInvoiceState -Dir $OutboxDir -State $state
        Write-AgentLog ("أُصلح الحدث المعزول seq={0} بوضع {1}" -f $RepairDeadLetterSeq, $mode)
    }
    Exit-AmeenOutboxLock $outboxLock
    exit 0
}

$connStr = Get-AgentSetting "AMEEN_SQL_CONNECTION_STRING"
if (-not $connStr) { Write-AgentLog "خطأ: AMEEN_SQL_CONNECTION_STRING غير موجود."; exit 1 }

# ---------------------------------------------------------------- SQL
Add-Type -AssemblyName "System.Data"
$csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder($connStr)
$csb["Application Name"] = "ozk-ameen-invoice-event-agent"
$conn = New-Object System.Data.SqlClient.SqlConnection($csb.ConnectionString)

function Invoke-AmeenRead([string]$Sql, [int]$TimeoutSeconds = 15) {
    Assert-AmeenReadOnlySql $Sql
    $c = $conn.CreateCommand()
    $c.CommandTimeout = $TimeoutSeconds
    $c.CommandText = "SET LOCK_TIMEOUT 3000; " + $Sql
    $da = New-Object System.Data.SqlClient.SqlDataAdapter($c)
    $t = New-Object System.Data.DataTable
    [void]$da.Fill($t)
    return ,$t
}

# إعادة فتح الاتصال: يُغلق المكسور ويُفرَّغ مجمّع الاتصالات (فلا يُعاد مقبض ميت من المجمّع) ثم يُفتح.
$sqlOpen = {
    if ($conn.State -ne [System.Data.ConnectionState]::Closed) { $conn.Close() }
    [System.Data.SqlClient.SqlConnection]::ClearPool($conn)
    $conn.Open()
}
# اختبار الاتصال: قراءة واحدة تعيد اسم القاعدة ووقت الخادم.
$sqlProbe = { (Invoke-AmeenRead "SELECT DB_NAME() d, GETDATE() t").Rows[0] }
function Restore-AgentSqlConnection([switch]$FirstAttemptNow) {
    return Invoke-AmeenSqlReconnect -Open $sqlOpen -Probe $sqlProbe -Log { param($m) Write-AgentLog $m } `
        -MaxAttempts $MaxReconnectAttempts -BaseSeconds $ReconnectBaseSeconds -MaxSeconds $ReconnectMaxSeconds -FirstAttemptNow:$FirstAttemptNow
}

function Get-AmeenBillObservation([string]$Guid, $Ops, [string]$DetectedAtUtc, [string]$Source) {
    $q = Get-AmeenInvoiceSnapshotSql -BillGuid $Guid
    $h = Invoke-AmeenRead $q.Header
    $snapshot = $null; $createUtc = $null; $updateUtc = $null
    if ($h.Rows.Count -gt 0) {
        $lines = Invoke-AmeenRead $q.Lines
        $row = $h.Rows[0]
        $snapshot = ConvertTo-AmeenInvoiceSnapshot -Header $row -Lines @($lines.Rows)
        $createUtc = ConvertTo-AmeenUtcIso $row.CreateDate
        if (Test-AmeenRealUpdateDate $row.LastUpdateDate) { $updateUtc = ConvertTo-AmeenUtcIso $row.LastUpdateDate }
    }
    return @{ guid = $Guid; snapshot = $snapshot; ops = @($Ops); detected_at_utc = $DetectedAtUtc; source = $Source; source_create_utc = $createUtc; source_update_utc = $updateUtc }
}

# قارئ طابور Resnapshot: الفاتورة بمعرّفها مباشرة (قراءة فقط)، أيّاً كان تاريخها — لا نافذة المطابقة.
# missing لا يُعلَن إلا حين ينجح الاستعلام ولا يجد الصف؛ أي خطأ = error ويبقى الطلب.
$resnapshotReader = {
    param($Guid)
    try {
        $nowSrvR = [datetime](Invoke-AmeenRead "SELECT GETDATE() t").Rows[0].t
        $o = Get-AmeenBillObservation ([string]$Guid) @() (ConvertTo-AmeenUtcIso $nowSrvR) "resnapshot"
        if ($null -ne $o.snapshot) { return @{ status = "found"; observation = $o } }
        return @{ status = "missing"; observation = $o }
    } catch {
        $ex = $_.Exception; $code = $ex.GetType().Name
        while ($null -ne $ex) { if ($ex -is [System.Data.SqlClient.SqlException]) { $code = "SqlException " + $ex.Number; break }; $ex = $ex.InnerException }
        return @{ status = "error"; error = $code }
    }
}

# ---------------------------------------------------------------- الإرسال
$session = $null
function Get-SupabaseSession {
    $url = Get-AgentSetting "TOBACCO_SUPABASE_URL"; if (-not $url) { $url = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
    $key = Get-AgentSetting "TOBACCO_SUPABASE_PUBLIC_KEY"
    $email = Get-AgentSetting "TOBACCO_SYNC_EMAIL"; $password = Get-AgentSetting "TOBACCO_SYNC_PASSWORD"
    if (-not $key -or -not $email -or -not $password) { throw "Supabase sync credentials are missing" }
    $body = [Text.Encoding]::UTF8.GetBytes((@{ email = $email; password = $password } | ConvertTo-Json -Compress))
    $auth = Invoke-RestMethod -Method Post -Uri ($url.TrimEnd("/") + "/auth/v1/token?grant_type=password") -Headers @{ apikey = $key } -ContentType "application/json; charset=utf-8" -Body $body
    return @{ url = $url.TrimEnd("/"); key = $key; token = $auth.access_token; expires = (Get-Date).AddSeconds([int]$auth.expires_in - 60) }
}

$transport = {
    param($Events)
    if ($null -eq $script:session -or (Get-Date) -ge $script:session.expires) { $script:session = Get-SupabaseSession }
    $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-AmeenCanonicalJson @{ p_events = @($Events) }))
    # Invoke-AmeenRpc يوحّد رسالة الفشل من جسم PostgREST، فيرى منطق تنصيف الدفعة «payload too large» على 5.1.
    $resp = Invoke-AmeenRpc -Url ($script:session.url + "/rest/v1/rpc/" + $RpcName) -Headers @{
        apikey = $script:session.key; Authorization = "Bearer " + $script:session.token
        "Accept-Profile" = "public"; "Content-Profile" = "public"
    } -Body $body -TimeoutSec 30
    return @($resp.results)
}


# ---------------------------------------------------------------- الحلقة
try {
    # الاتصال الأول نفسه عبر التعافي: الجهاز قد يقلع وخادم SQL لم يجهز بعد.
    $link = Restore-AgentSqlConnection -FirstAttemptNow
    if (-not $link.ok) { exit 6 }
    $db = [string]$link.probe.d
    if ($db -ne $ExpectedDatabase) { Write-AgentLog "رفض: القاعدة المتصلة $db لا تطابق $ExpectedDatabase."; exit 4 }

    Initialize-AmeenInvoiceOutbox -Dir $OutboxDir
    $state = Read-AmeenInvoiceState -Dir $OutboxDir
    $serverNow = [datetime]$link.probe.t
    if (-not $state.watermark) { $state.watermark = Format-AmeenSqlDate $serverNow.AddMinutes(-5) }
    $sendOn = Test-AmeenSendActivated -Dir $OutboxDir -SendRequested:$Send
    Write-AgentLog ("بدء الوكيل: db={0} outbox={1} send={2} last_seq={3} bills={4}" -f $db, $OutboxDir, $sendOn, $state.last_seq, $state.bills.Count)
    if ($Send -and -not $sendOn) { Write-AgentLog "الإرسال مطلوب لكن ملف التفعيل غير موجود — رصد فقط." }

    $start = Get-Date
    $lastReconcile = [datetime]::MinValue
    # الحالة الكاملة تُحفظ عند تغيّرها فقط (أداء، 2026-10-22): حفظها في كل دورة كان يكلّف ~6 ث على 5.1
    # فيُبطئ حارس الأداء الرصد إلى 30 ث. بلا تغيير تُحفظ العلامة المائية وحدها في ملف صغير.
    $lastFullSave = [datetime]::UtcNow
    $perf = @{ since = Get-Date; cycles = 0; total_ms = 0.0; max_ms = 0.0; full = 0; watermark = 0; watermark_failed = 0 }
    $interval = [math]::Max(1, $PollSeconds)
    $slowStreak = 0
    do {
        $cycleStart = Get-Date
        $stateDirty = $false
        $wm = [datetime]::ParseExact([string]$state.watermark, "yyyy-MM-ddTHH:mm:ss.fff", [Globalization.CultureInfo]::InvariantCulture)
        $q = Get-AmeenInvoiceDetectionSql -Watermark $wm
        $ops = @{}
        $lockErrors = 0
        $connectionLost = $false
        try {
            # وقت الخادم داخل المعالجة: أول استعلام بعد الإسبات هو الذي يرمي عادةً.
            $nowSrv = [datetime](Invoke-AmeenRead "SELECT GETDATE() t").Rows[0].t
            $detectedUtc = ConvertTo-AmeenUtcIso $nowSrv
            foreach ($r in (Invoke-AmeenRead $q.Log).Rows) {
                $g = ConvertTo-AmeenGuidText $r.RecGUID; if (-not $g) { continue }
                if (-not $ops.ContainsKey($g)) { $ops[$g] = New-Object System.Collections.Generic.List[object] }
                $ops[$g].Add(@{ op = [int]$r.OperationType; at_utc = (ConvertTo-AmeenUtcIso $r.LogTime) })
            }
            foreach ($r in (Invoke-AmeenRead $q.Bills).Rows) {
                $g = ConvertTo-AmeenGuidText $r.GUID; if (-not $g) { continue }
                if (-not $ops.ContainsKey($g)) { $ops[$g] = New-Object System.Collections.Generic.List[object] }
            }
            $observations = New-Object System.Collections.Generic.List[object]
            foreach ($g in @($ops.Keys | Sort-Object)) { $observations.Add((Get-AmeenBillObservation $g $ops[$g].ToArray() $detectedUtc "incremental")) }

            if (((Get-Date) - $lastReconcile).TotalMinutes -ge $ReconcileMinutes) {
                $fp = @{}
                foreach ($r in (Invoke-AmeenRead (Get-AmeenInvoiceFingerprintSql -PeriodDays $PeriodDays) 60).Rows) {
                    $fp[(ConvertTo-AmeenGuidText $r.GUID)] = ("{0}:{1}:{2}" -f $r.hh, $r.lh, $r.n)
                }
                $reconcileTruncated = $false; $taken = 0
                foreach ($g in @($fp.Keys | Sort-Object)) {
                    $known = $null; if ($state.bills.ContainsKey($g)) { $known = $state.bills[$g] }
                    if ($ops.ContainsKey($g)) { continue }
                    if ($null -eq $known -or $known.fp -ne $fp[$g]) {
                        if ($taken -ge $ReconcileBatch) { $reconcileTruncated = $true; break }
                        $observations.Add((Get-AmeenBillObservation $g @() $detectedUtc "reconcile"))
                        $taken++
                    }
                }
                # فواتير معروفة غابت عن المطابقة: إمّا حُذفت (تأكيد بالقراءة) وإمّا خرجت من النافذة.
                foreach ($g in @($state.bills.Keys)) {
                    if ($fp.ContainsKey($g) -or $ops.ContainsKey($g) -or $state.bills[$g].v -eq "deleted") { continue }
                    $exists = [int](Invoke-AmeenRead ("SELECT COUNT(*) c FROM dbo.bu000 WHERE GUID = '" + ([guid]$g).ToString() + "'")).Rows[0].c
                    if ($exists -eq 0) { $observations.Add(@{ guid = $g; snapshot = $null; ops = @(); detected_at_utc = $detectedUtc; source = "reconcile" }) }
                    else { $state.bills.Remove($g); $stateDirty = $true }
                }
                # دفعة ناقصة ⇒ تُكمَل في الدورة التالية بدل انتظار 10 دقائق.
                if (-not $reconcileTruncated) { $lastReconcile = Get-Date }
            }

            $events = Resolve-AmeenInvoiceChanges -State $state -Observations $observations.ToArray()
            foreach ($obs in $observations) {
                if ($fp -and $fp.ContainsKey($obs.guid) -and $state.bills.ContainsKey($obs.guid) -and $state.bills[$obs.guid].fp -ne $fp[$obs.guid]) {
                    $state.bills[$obs.guid].fp = $fp[$obs.guid]; $stateDirty = $true
                }
            }
            if ($events.Count -gt 0) {
                $stateDirty = $true
                Add-AmeenOutboxEvents -Dir $OutboxDir -Events $events
                foreach ($e in $events) { Write-AgentLog ("حدث {0} seq={1} {2} bill={3}" -f $e.kind, $e.source_seq, $e.change, $e.bill_guid) }
            }
            $state.watermark = Format-AmeenSqlDate $nowSrv
            # الأحداث في الصندوق أولاً، ثم الحالة (إن تغيّرت)، ثم العلامة — فلا تتقدّم العلامة على ما لم يُحفظ.
            if ((Get-AmeenStateSaveMode -Dirty $stateDirty -LastFullSaveUtc $lastFullSave) -eq "full") {
                Save-AmeenInvoiceState -Dir $OutboxDir -State $state; $lastFullSave = [datetime]::UtcNow; $perf.full++
            } else {
                if (Save-AmeenInvoiceWatermark -Dir $OutboxDir -State $state) { $perf.watermark++ } else { $perf.watermark_failed++ }
            }
        } catch {
            # أخطاء SQL تصل ملفوفة بـ MethodInvocationException؛ التصنيف يفحص السلسلة كلها مع حالة الاتصال.
            # كل قراءات الدورة تسبق Resolve-AmeenInvoiceChanges، فالخطأ هنا يعني: لا حدث ولا علامة ولا حفظ.
            $kind = Get-AmeenSqlFailureKind -Exception $_.Exception -ConnectionState ([string]$conn.State)
            if ($kind -eq "fatal") { throw }
            if ($kind -eq "connection") {
                $connectionLost = $true
                Write-AgentLog ("DISCONNECTED: انقطع الاتصال بالأمين (لا تقدّم للعلامة المائية {0}): {1}" -f $state.watermark, (Format-AmeenSafeError $_.Exception))
            } else {
                $lockErrors++
                Write-AgentLog ("تحذير SQL (لا تقدّم للعلامة المائية): " + (Format-AmeenSafeError $_.Exception))
            }
        }
        $fp = $null

        if ($connectionLost) {
            # يحجب الدورة حتى يعود الاتصال، والقفل باقٍ فلا يبدأ مثيل ثانٍ. الدورة التالية تبدأ من العلامة نفسها.
            $link = Restore-AgentSqlConnection
            if (-not $link.ok) { exit 6 }
            if ([string]$link.probe.d -ne $ExpectedDatabase) { Write-AgentLog ("رفض: القاعدة بعد إعادة الاتصال {0} لا تطابق {1}." -f $link.probe.d, $ExpectedDatabase); exit 4 }
        } else {
            # طابور Resnapshot الدائم (Codex P1-1): بعد الرصد وقبل الإرسال، فيلحق الحدث البديل بالدفعة.
            try {
                $rq = Invoke-AmeenResnapshotQueue -Dir $OutboxDir -State $state -Reader $resnapshotReader
                if ($rq.emitted -gt 0) { Write-AgentLog ("Resnapshot: صدر {0} حدث بديل وأُغلق طلبه" -f $rq.emitted) }
                if ($rq.failed -gt 0) { Write-AgentLog ("Resnapshot: تعذّرت قراءة {0} فاتورة — يبقى الطلب ويُعاد لاحقاً" -f $rq.failed) }
            } catch { Write-AgentLog ("Resnapshot: خطأ في معالجة الطابور (الطلبات باقية): " + $_.Exception.GetType().Name) }
        }

        # يُعاد فحص ملف التفعيل قبل كل دفعة: حذفه يوقف الإرسال من الدورة التالية (Codex P1 على 51783c90).
        $sendNow = Test-AmeenSendActivated -Dir $OutboxDir -SendRequested:$Send
        if ($sendNow -ne $sendOn) {
            if ($sendNow) { Write-AgentLog "ملف التفعيل موجود — استؤنف الإرسال." } else { Write-AgentLog "ملف التفعيل حُذف أو تغيّر — أُوقف الإرسال؛ الأحداث تبقى في الصندوق المحلي." }
            $sendOn = $sendNow
        }
        if ($sendOn) {
            $r = Send-AmeenInvoiceOutbox -Dir $OutboxDir -State $state -Transport $transport
            if ($r.deadlettered -gt 0) { Write-AgentLog ("عُزل {0} حدث معطوب في deadletter\ (راجع -ListDeadLetter)" -f $r.deadlettered) }
            if ($r.error) { Write-AgentLog ("فشل الإرسال (سيُعاد): " + $r.error) }
            elseif ($r.acked -gt 0) { Write-AgentLog ("أُكِّد {0} حدث" -f $r.acked) }
            # لا إرسال فعلي (الصندوق فارغ أو مهلة تراجع) ⇒ لا تغيير في الحالة ولا حفظ.
            if ($r.sent -gt 0 -or $r.error -or $r.deadlettered -gt 0) { Save-AmeenInvoiceState -Dir $OutboxDir -State $state; $lastFullSave = [datetime]::UtcNow; $perf.full++ }
        }

        # حارس الأداء: لا نضغط على الأمين. دورة بطيئة أو مهلة قفل ⇒ إيقاع أبطأ.
        $elapsedMs = ((Get-Date) - $cycleStart).TotalMilliseconds
        $perf.cycles++; $perf.total_ms += $elapsedMs; if ($elapsedMs -gt $perf.max_ms) { $perf.max_ms = $elapsedMs }
        if ($PerfLogMinutes -gt 0 -and ((Get-Date) - $perf.since).TotalMinutes -ge $PerfLogMinutes) {
            Write-AgentLog ("أداء: دورات={0} متوسط={1:n0}ms أقصى={2:n0}ms حفظ_كامل={3} حفظ_علامة={4} علامة_متعذرة={5} إيقاع={6}ث" -f $perf.cycles, ($perf.total_ms / [math]::Max(1, $perf.cycles)), $perf.max_ms, $perf.full, $perf.watermark, $perf.watermark_failed, $interval)
            $perf = @{ since = Get-Date; cycles = 0; total_ms = 0.0; max_ms = 0.0; full = 0; watermark = 0; watermark_failed = 0 }
        }
        if ($elapsedMs -gt 500 -or $lockErrors -gt 0) { $slowStreak++ } else { $slowStreak = 0; $interval = [math]::Max(1, $PollSeconds) }
        if ($slowStreak -ge 3) { $interval = [math]::Min(30, $interval * 2); $slowStreak = 0; Write-AgentLog "إبطاء الإيقاع إلى $interval ثانية (حارس الأداء)." }
        if ($Once) { break }
        if ($RunMinutes -gt 0 -and ((Get-Date) - $start).TotalMinutes -ge $RunMinutes) { break }
        Start-Sleep -Milliseconds ([math]::Max(200, ($interval * 1000) - [int]$elapsedMs))
    } while ($true)
    Write-AgentLog ("انتهى الوكيل: last_seq={0} pending={1}" -f $state.last_seq, @(Get-ChildItem -LiteralPath (Join-Path $OutboxDir "pending") -Filter "*.json").Count)
} catch {
    # كان الخروج برمز 1 صامتاً (لا catch خارجي). الآن يُسجَّل السبب أولاً، بلا كلمات مرور.
    Write-AgentLog ("FATAL: توقف الوكيل بخطأ غير متوقع: " + (Format-AmeenSafeError $_.Exception))
    exit 1
} finally {
    if ($conn.State -ne [System.Data.ConnectionState]::Closed) { $conn.Close() }
    Exit-AmeenOutboxLock $outboxLock
}
