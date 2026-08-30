# ============================================================
# push-khalil-audit-log.ps1
# يقرأ log000 في الأمين (event-driven، مصدر التدقيق الحقيقي عبر triggers
# داخل الأمين نفسه) مُصفّىً على UserGUID خليل فقط، ويرفع كل حدث إلى
# khalil_audit_events في Supabase عبر record_khalil_audit_event (idempotent،
# cursor آمن ضد تساوي LogTime). الإشعار إلى تيليجرام يتم تلقائياً من داخل
# قاعدة البيانات (trigger على khalil_audit_events) — هذا السكربت لا يستدعي
# notify_telegram مباشرة إطلاقاً.
#
# لا يكتب هذا السكربت أي شيء إلى قاعدة الأمين — قراءة فقط (SELECT). لا
# يُعدَّل هنا أي صلاحية لخليل داخل الأمين بأي شكل.
#
# ضمان "لا يتحرك cursor بعد آخر حدث غير مؤكد": التقدّم يتم داخل
# record_khalil_audit_event نفسها لكل صف على حدة (transactional)، والحلقة
# هنا تتوقف فوراً عند أول فشل استدعاء RPC دون معالجة أي صف لاحق — فتبقى
# القيمة الحيّة في khalil_audit_cursor عند آخر صف تم تأكيده فعلياً بالخادم.
# ============================================================
param(
    [switch]$DryRun,
    [int]$BatchSize = 200,
    # Codex P1، 2026-08-30، جولة ٧: معاملتان قد تتداخلان في الأمين — A
    # (LogTime أقدم) تبدأ قبل B (LogTime أحدث) لكنها تُنجَز/تُلتزَم (commit)
    # بعدها. لو استقرأ السكربت الصف بين commit B وcommit A، يتقدّم الـcursor
    # إلى LogTime الخاص بـB، فيصبح صف A (الأقدم زمنياً لكنه التزم لاحقاً)
    # مستبعداً للأبد بمجرد commit لأنه أقدم من الـcursor. نافذة الأمان هذه
    # تستبعد من القراءة كل صف أحدث من (الآن − هذه الثواني) كي يُمنَح أي
    # commit متأخر لمعاملة أقدم فرصة كافية للظهور قبل أن يتقدّم الـcursor
    # فوقه. مع idempotency عبر ameen_log_guid (on conflict do nothing) هذا
    # التأخير آمن تماماً لإعادة المعالجة.
    [int]$SafetyDelaySeconds = 30,
    # Codex P1، 2026-08-30، جولة ٨: SafetyDelaySeconds وحده حدّ زمني محدود —
    # لو بقيت معاملة A مفتوحة أطول من هذه الثواني بعد كتابة LogTime أقدم،
    # يتقدّم الـcursor فوقها بمعاملة B لاحقة تُلتزَم أولاً، وتُستبعد A للأبد
    # حين تُلتزم لاحقاً لأن LogTime > @CursorTime لن يتحقق بعدها أبداً.
    # الإصلاح: بالإضافة للنافذة الآمنة، كل تشغيل يعيد مسح نافذة زمنية محدودة
    # خلف الوقت الحالي (وليس خلف الـcursor) بحثاً عن أي صف بقي دون تسجيله،
    # بغض النظر عن أين وصل الـcursor. record_khalil_audit_event() نفسها لا
    # تُرجِع الـcursor للخلف أبداً (شرط >= الصف الحالي)، وON CONFLICT DO
    # NOTHING على ameen_log_guid يجعل إعادة فحص نفس الصفوف كل تشغيل آمنة
    # ورخيصة. هذا يلتقط أي تأخير commit مهما طال طالما حدث خلال هذه الدقائق.
    [int]$OverlapWindowMinutes = 20,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\khalil-audit-push.log"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

function Write-Log($Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Notify-Failure($Message) {
    try {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message $Message -EventType "sync_failure" -DedupeKey "winfail:push-khalil-audit-log" `
            -DedupeMinutes 60 -EnvFile $EnvFile
    } catch { }
}

# GUID خليل الحقيقي في us000 (Number=5, LoginName='خليل'). ثابت مقصود —
# الفلترة على SQL Server هنا + الحارس المطابق داخل record_khalil_audit_event
# في Supabase يمنعان معاً نسب أي حدث لمستخدم آخر لسجل خليل.
$KHALIL_USER_GUID = "9A5FE33A-720C-493B-8A13-CE33EE5A008E"
# ملاحظة موثوقية (Codex P1، 2026-08-30، جولة ٣): "نافذة خلفية بالساعات
# نسبةً لوقت أول تشغيل فعلي للسكربت" كانت تعني أن أي تأخير بتسجيل Scheduled
# Task عن لحظة تفعيل صلاحيات خليل (خطوة منفصلة يدوية) يُسقِط بصمت وللأبد كل
# الأحداث بينهما بمجرد استقرار الـcursor من أول صف مُحتفَظ به. بما أن القراءة
# مُصفّاة أصلاً على UserGUID خليل وحده (حجم متوقَّع صغير)، الافتراض الآن هو
# "بلا حد زمني" (0 = كامل تاريخ log000 لخليل) — القيمة تبقى قابلة للضبط عبر
# KHALIL_AUDIT_BACKFILL_HOURS لمن يريد عمداً تقييدها لسبب أدائي موثّق.
$backfillHours = Get-Setting "KHALIL_AUDIT_BACKFILL_HOURS"
if (-not $backfillHours) { $backfillHours = 0 }

$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "ERROR: AMEEN_SQL_CONNECTION_STRING missing."; exit 1 }
if (-not $apiKey -or -not $syncEmail -or -not $syncPassword) {
    Write-Log "ERROR: Supabase sync credentials missing."
    exit 1
}

# ملاحظة موثوقية (Codex P1، 2026-08-30، جولة ٣): لا يوجد أي heartbeat/تقرير
# صحة لهذه المهمة — لو توقفت المهمة المجدولة (عُطِّلت، حُذفت، الجهاز مطفأ،
# أو لم تُسجَّل أصلاً) فلا آلية تنبيه تكتشف ذلك، ويبقى خط تدقيق خليل ميتاً
# بصمت. الإصلاح: كتابة صفّ حالة دوري ضمن private.project_task_monitors
# (راجع supabase/project-task-health-monitor.sql) ليتحقق منه
# monitor_project_tasks() تلقائياً بنفس آلية بقية مهام المزامنة.
#
# Codex P1، 2026-08-30، جولة ٤ (findings b + d): سابقاً كانت الكتابة على
# public.inventory_reports المشترك — أي موظف مصادَق قادر على إرسال
# source='khalil_audit_sync_heartbeat' منتحلاً صفة هذا السكربت (b)، وأول
# إدراج يومي هناك يُشغِّل أيضاً trigger إشعار الجرد اليومي غير المشروط
# ويحجز dedupe_key الخاص به لمدة 1200 دقيقة، فيُسكِت إشعار الجرد الحقيقي (d).
# الإصلاح: جدول مخصّص khalil_audit_sync_heartbeat بصلاحية INSERT محصورة
# بهوية المزامنة الموثوقة فقط (نفس RLS المستخدَم لـkhalil_audit_events).
# Codex P1، 2026-08-30، جولة ٥: TOP(@BatchSize) بالضبط لا يميّز "انتهى
# الطابور فعلاً" عن "توجد مئات صفوف أخرى بالخلف بالضبط لأن الحد وصل". كان
# الـheartbeat يكتب status="ok" دوماً بلا فرق، فـmonitor_project_tasks()
# (يقرأ فقط حداثة created_at، لا found_count) كان يعتبر الخط "سليماً" رغم
# تراكم متزايد خلف الـcursor بلا أي تنبيه. الآن: إن كان عدد الصفوف المُعاد
# مساوياً تماماً BatchSize، الحالة "backlog" بدل "ok" — monitor_project_tasks
# (project-task-health-monitor.sql) يقرأ هذا الحقل صراحة الآن وينبّه عليه
# حتى لو كان الـheartbeat حديثاً زمنياً.
function Send-Heartbeat($ProcessedCount, $FoundCount, $Status = "ok") {
    try {
        $body = @{
            status          = $Status
            found_count     = $FoundCount
            processed_count = $ProcessedCount
            ran_at          = (Get-Date).ToString("o")
            computer        = $env:COMPUTERNAME
        } | ConvertTo-Json -Compress -Depth 5
        Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/khalil_audit_sync_heartbeat" -Headers $headers `
            -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) `
            -TimeoutSec 20 | Out-Null
    } catch {
        # best-effort — فشل الـheartbeat وحده لا يجب أن يُسقط تشغيلاً ناجحاً فعلياً
        Write-Log ("WARN: heartbeat write failed: " + $_.Exception.Message)
    }
}

function Get-XmlTotal([string]$xml) {
    if (-not $xml) { return $null }
    $m = [regex]::Match($xml, '<Total>\s*(-?[0-9]+(\.[0-9]+)?)\s*</Total>')
    if (-not $m.Success) { return $null }
    $v = 0.0
    if ([double]::TryParse($m.Groups[1].Value, [ref]$v)) { return $v }
    return $null
}

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # ---- المصادقة على Supabase كهوية المزامنة الموثوقة ----
    $authBody = @{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress
    $auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($authBody)) -TimeoutSec 20
    if (-not $auth.access_token) { throw "Sync user login failed." }

    $headers = @{
        apikey = $apiKey
        Authorization = "Bearer $($auth.access_token)"
        "Accept-Profile" = "public"
        "Content-Profile" = "public"
        Prefer = "return=representation"
    }

    # ---- قراءة الـcursor الحالي (last_log_time, last_log_guid) ----
    $cursorResp = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/get_khalil_audit_cursor" `
        -Headers $headers -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes("{}")) -TimeoutSec 20

    $cursorTime = $null
    $cursorGuid = $null
    $backfillBoundary = $null
    if ($cursorResp -and $cursorResp.Count -gt 0) {
        if ($cursorResp[0].last_log_time) { $cursorTime = [datetime]$cursorResp[0].last_log_time }
        if ($cursorResp[0].last_log_guid) { $cursorGuid = [string]$cursorResp[0].last_log_guid }
        if ($cursorResp[0].backfill_before) { $backfillBoundary = [datetime]$cursorResp[0].backfill_before }
    }

    # ملاحظة أمنية/موثوقية (Codex P1، 2026-08-30): ترتيب SQL Server الأصلي
    # لنوع uniqueidentifier (مقارنة GUID > GUID أو ORDER BY GUID) لا يطابق
    # ترتيب Postgres لنوع uuid — SQL Server يقارن مجموعات بايتات بترتيب غير
    # نصّي مختلف تماماً عن الشكل القانوني للنص، بينما Postgres يقارن uuid
    # بنفس ترتيب تمثيله النصي القانوني. لو تجاوز عدد الأحداث المتساوية
    # LogTime حجم الدفعة (BatchSize)، كان الـcursor المخزَّن في Postgres
    # (بترتيب uuid) يمكن أن يتوافق مع GUID مختلف عمّا يعتبره SQL Server
    # "الأحدث" بترتيبه الخاص — فيُستبعد صفوف لم تُعالَج فعلياً إلى الأبد، أو
    # يُعاد جلب نفس الدفعة بلا تقدّم. الإصلاح: تحويل GUID إلى نص قانوني
    # (lowercase) على جانب SQL Server قبل الترتيب/المقارنة، ليطابق تماماً
    # ترتيب Postgres النصي لعمود last_log_guid — بلا أي حاجة لتغيير منطق
    # الـcursor في الدالة نفسها.
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 60
    $cmd.CommandText = @"
SELECT TOP (@BatchSize)
    GUID, LogTime, UserGUID, Computer, Operation, OperationType,
    RecGUID, RecNum, TypeGUID, RecContent
FROM log000
WHERE UserGUID = @UserGuid
  AND (
        @CursorTime IS NULL
        OR LogTime > @CursorTime
        OR (LogTime = @CursorTime AND LOWER(CAST(GUID AS VARCHAR(36))) > @CursorGuid)
      )
  AND (@CursorTime IS NOT NULL OR @BackfillFrom IS NULL OR LogTime >= @BackfillFrom)
  AND LogTime <= @SafeUntil
ORDER BY LogTime ASC, LOWER(CAST(GUID AS VARCHAR(36))) ASC
"@
    $cmd.Parameters.AddWithValue("@BatchSize", $BatchSize) | Out-Null
    $cmd.Parameters.AddWithValue("@UserGuid", [guid]$KHALIL_USER_GUID) | Out-Null
    if ($cursorTime) { $cmd.Parameters.AddWithValue("@CursorTime", $cursorTime) | Out-Null }
    else { $cmd.Parameters.AddWithValue("@CursorTime", [DBNull]::Value) | Out-Null }
    if ($cursorGuid) { $cmd.Parameters.AddWithValue("@CursorGuid", [string]$cursorGuid.ToLowerInvariant()) | Out-Null }
    else { $cmd.Parameters.AddWithValue("@CursorGuid", [DBNull]::Value) | Out-Null }
    if ([double]$backfillHours -gt 0) {
        $cmd.Parameters.AddWithValue("@BackfillFrom", (Get-Date).AddHours(-1 * [double]$backfillHours)) | Out-Null
    } else {
        $cmd.Parameters.AddWithValue("@BackfillFrom", [DBNull]::Value) | Out-Null
    }
    $cmd.Parameters.AddWithValue("@SafeUntil", (Get-Date).AddSeconds(-1 * $SafetyDelaySeconds)) | Out-Null

    $reader = $cmd.ExecuteReader()
    $rows = @()
    while ($reader.Read()) {
        $rows += [PSCustomObject]@{
            Guid          = [string]$reader["GUID"]
            LogTime       = [datetime]$reader["LogTime"]
            UserGuid      = [string]$reader["UserGUID"]
            Computer      = if ($reader["Computer"] -is [DBNull]) { $null } else { [string]$reader["Computer"] }
            Operation     = if ($reader["Operation"] -is [DBNull]) { $null } else { [string]$reader["Operation"] }
            OperationType = if ($reader["OperationType"] -is [DBNull]) { $null } else { [int]$reader["OperationType"] }
            RecGuid       = if ($reader["RecGUID"] -is [DBNull]) { $null } else { [string]$reader["RecGUID"] }
            RecNum        = if ($reader["RecNum"] -is [DBNull]) { $null } else { [string]$reader["RecNum"] }
            TypeGuid      = if ($reader["TypeGUID"] -is [DBNull]) { $null } else { [string]$reader["TypeGUID"] }
            RecContent    = if ($reader["RecContent"] -is [DBNull]) { $null } else { [string]$reader["RecContent"] }
        }
    }
    $reader.Close()

    # Codex P1، 2026-08-30، جولة ٨ ("Replace the bounded delay with an
    # overlap scan"): بالإضافة للاستعلام الرئيسي أعلاه، أعِد مسح نافذة
    # محدودة خلف الـcursor الحالي بحثاً عن أي صف Khalil التزم متأخراً ولم
    # يُقرأ سابقاً (رغم أن LogTime أقدم من الـcursor الآن). لا يُنفَّذ إلا
    # عندما يوجد cursor فعلاً (أول تشغيل يغطيه استعلام الباك-فيل الرئيسي).
    $overlapRows = @()
    if ($cursorTime) {
        $overlapFrom = (Get-Date).AddMinutes(-1 * $OverlapWindowMinutes)
        $overlapCmd = $conn.CreateCommand()
        $overlapCmd.CommandTimeout = 60
        $overlapCmd.CommandText = @"
SELECT TOP (@BatchSize)
    GUID, LogTime, UserGUID, Computer, Operation, OperationType,
    RecGUID, RecNum, TypeGUID, RecContent
FROM log000
WHERE UserGUID = @UserGuid
  AND LogTime >= @OverlapFrom
  AND LogTime <= @CursorTime
ORDER BY LogTime ASC, LOWER(CAST(GUID AS VARCHAR(36))) ASC
"@
        $overlapCmd.Parameters.AddWithValue("@BatchSize", $BatchSize) | Out-Null
        $overlapCmd.Parameters.AddWithValue("@UserGuid", [guid]$KHALIL_USER_GUID) | Out-Null
        $overlapCmd.Parameters.AddWithValue("@OverlapFrom", $overlapFrom) | Out-Null
        $overlapCmd.Parameters.AddWithValue("@CursorTime", $cursorTime) | Out-Null
        $overlapReader = $overlapCmd.ExecuteReader()
        while ($overlapReader.Read()) {
            $overlapRows += [PSCustomObject]@{
                Guid          = [string]$overlapReader["GUID"]
                LogTime       = [datetime]$overlapReader["LogTime"]
                UserGuid      = [string]$overlapReader["UserGUID"]
                Computer      = if ($overlapReader["Computer"] -is [DBNull]) { $null } else { [string]$overlapReader["Computer"] }
                Operation     = if ($overlapReader["Operation"] -is [DBNull]) { $null } else { [string]$overlapReader["Operation"] }
                OperationType = if ($overlapReader["OperationType"] -is [DBNull]) { $null } else { [int]$overlapReader["OperationType"] }
                RecGuid       = if ($overlapReader["RecGUID"] -is [DBNull]) { $null } else { [string]$overlapReader["RecGUID"] }
                RecNum        = if ($overlapReader["RecNum"] -is [DBNull]) { $null } else { [string]$overlapReader["RecNum"] }
                TypeGuid      = if ($overlapReader["TypeGUID"] -is [DBNull]) { $null } else { [string]$overlapReader["TypeGUID"] }
                RecContent    = if ($overlapReader["RecContent"] -is [DBNull]) { $null } else { [string]$overlapReader["RecContent"] }
            }
        }
        $overlapReader.Close()
        if ($overlapRows.Count -gt 0) {
            Write-Log ("Overlap rescan recovered {0} previously-missed row(s)." -f $overlapRows.Count)
        }
    }

    # صفوف الـoverlap تُعالَج أولاً (id ثابت ameen_log_guid يجعل التكرار
    # آمناً عبر ON CONFLICT DO NOTHING)، ثم الصفحة الرئيسية بترتيبها الطبيعي.
    # لا تُخصَّم صفوف الـoverlap من كشف "دفعة كاملة = تراكم" أدناه لأنها ليست
    # جزءاً من الصفحة الرئيسية المحدودة بـBatchSize.
    $mainRowCount = $rows.Count
    $rows = @($overlapRows) + @($rows)

    Write-Log ("Found {0} new log000 row(s) for Khalil (+{1} overlap rescan)." -f $mainRowCount, $overlapRows.Count)
    if ($rows.Count -eq 0) { $conn.Close(); Send-Heartbeat 0 0; exit 0 }

    if ($DryRun) {
        $rows | Format-Table Guid, LogTime, Operation, RecNum -AutoSize
        $conn.Close()
        exit 0
    }

    # ملاحظة موثوقية (Codex P1، 2026-08-30، جولة ٣): المطابقة القديمة كانت
    # RecNum + TypeGUID + LogTime < فقط، متجاهلةً RecGUID رغم توفره على نفس
    # الصف. أرقام الفواتير (RecNum) في الأمين قابلة لإعادة الاستخدام لسجلّ
    # مختلف كلياً تحت نفس TypeGUID (مثلاً بعد إلغاء/حذف وإعادة ترقيم)، فكانت
    # هذه المطابقة قد تلتقط حالة "سابقة" لفاتورة أخرى غير ذات صلة إطلاقاً —
    # يُفسِد before_snapshot وfinancial_delta بصمت. الإصلاح: عند توفّر
    # RecGUID (المعرّف الفريد الحقيقي للسجل) نطابق عليه حصراً بدل RecNum؛
    # وللتعادل بنفس اللحظة (LogTime) نستخدم نفس ترتيب (LogTime, GUID) الذي
    # يعتمده الـcursor نفسه (نصّي lowercase) بدل الاكتفاء بـLogTime <، كي لا
    # يُفلِت أو يُخطئ صفّ سابق مباشر يتشارك اللحظة تماماً.
    # تشخيص مباشر على log000 الحقيقي (30/08/2026): OperationType هو المحدِّد
    # الوحيد الموثوق لكون الصف يحمل محتوى (RecContent) في الأمين، بصرف النظر
    # عن Operation. القياس الفعلي على كامل log000:
    #   OperationType 2/3/100  → يحمل محتوى في الغالبية العظمى (>99%) من الصفوف
    #   OperationType 1/9/12/126 → لا يحمل محتوى إطلاقاً (0 من آلاف الصفوف) —
    #     هذه فتح/إغلاق/قفل سجل (Operation=1 OperationType=1 مثلاً = مجرد فتح
    #     الفاتورة في الأمين بلا حفظ أي تعديل)، وليست تعديلاً/حذفاً حقيقياً.
    # لذلك Snapshot متوقَّع فقط لأنواع العمليات الثلاثة أدناه؛ غيرها يُسجَّل
    # بصراحة بلا snapshot مع سبب واضح في notes بدل NULL صامت.
    $ContentBearingOperationTypes = @(2, 3, 100)

    $beforeCmd = $conn.CreateCommand()
    $beforeCmd.CommandTimeout = 30
    $beforeCmd.CommandText = @"
SELECT TOP 1 RecContent
FROM log000
WHERE TypeGUID = @TypeGuid
  AND (
        (@RecGuid IS NOT NULL AND RecGUID = @RecGuid)
        OR (@RecGuid IS NULL AND RecNum = @RecNum)
      )
  AND OperationType IN (2, 3, 100)
  AND DATALENGTH(RecContent) > 0
  AND (
        LogTime < @LogTime
        OR (LogTime = @LogTime AND LOWER(CAST(GUID AS VARCHAR(36))) < @Guid)
      )
ORDER BY LogTime DESC, LOWER(CAST(GUID AS VARCHAR(36))) DESC
"@
    $pRecNum = $beforeCmd.Parameters.Add("@RecNum", [Data.SqlDbType]::NVarChar, 100)
    $pRecGuid = $beforeCmd.Parameters.Add("@RecGuid", [Data.SqlDbType]::UniqueIdentifier)
    $pTypeGuid = $beforeCmd.Parameters.Add("@TypeGuid", [Data.SqlDbType]::UniqueIdentifier)
    $pLogTime = $beforeCmd.Parameters.Add("@LogTime", [Data.SqlDbType]::DateTime)
    $pGuid = $beforeCmd.Parameters.Add("@Guid", [Data.SqlDbType]::VarChar, 36)

    $processed = 0
    foreach ($row in $rows) {
        $isContentBearingType = $ContentBearingOperationTypes -contains $row.OperationType
        $afterXml = $row.RecContent
        $notes = $null
        $beforeXml = $null

        if (-not $isContentBearingType) {
            # نوع عملية لا يحمل محتوى في الأمين أصلاً (فتح/إغلاق/عرض وغيرها) —
            # NULL هنا متوقَّع وليس عطلاً؛ سجّل السبب صراحة بدل ترك NULL صامت.
            $notes = "OperationType=$($row.OperationType) لا يحمل محتوى (RecContent) في الأمين — هذا فتح/عرض/إغلاق سجل وليس تعديلاً أو حذفاً فعلياً، فلا يوجد Snapshot متوقَّع لهذا الحدث."
            $afterXml = $null
        } elseif ([string]::IsNullOrEmpty($afterXml)) {
            # GUARD: نوع العملية يُفترض أن يحمل محتوى (تعديل/حذف/مرتجع) لكن
            # RecContent وصل فارغاً من الأمين — هذا غير متوقَّع. لا نعتبر
            # الحدث معالَجاً: لا نرسله إلى Supabase ولا يتقدّم الـcursor
            # فوقه، بل نتوقّف هنا فوراً كي تُعاد محاولته بالتشغيل القادم دون
            # فقدان أي تفصيل. باقي صفوف هذه الدفعة (إن وُجدت) تبقى غير
            # معالَجة أيضاً لأنها تالية لهذا الصف بالترتيب الزمني.
            Write-Log ("GUARD: GUID $($row.Guid) (RecNum=$($row.RecNum)) OperationType=$($row.OperationType) يُفترض أن يحمل RecContent لكنه وصل فارغاً من الأمين — إيقاف الدفعة دون تحريك الـcursor فوق هذا الصف.")
            $conn.Close()
            Notify-Failure ("⚠️ حدث تدقيق خليل بلا محتوى متوقَّع (RecContent فارغ رغم أن OperationType=$($row.OperationType) يعني تعديل/حذف)`nGUID: $($row.Guid)`nRecNum: $($row.RecNum)")
            exit 1
        }

        if ($isContentBearingType -and -not [string]::IsNullOrEmpty($afterXml)) {
            if (($row.RecNum -or $row.RecGuid) -and $row.TypeGuid) {
                if ($row.RecNum) { $pRecNum.Value = $row.RecNum } else { $pRecNum.Value = [DBNull]::Value }
                if ($row.RecGuid) { $pRecGuid.Value = [guid]$row.RecGuid } else { $pRecGuid.Value = [DBNull]::Value }
                $pTypeGuid.Value = [guid]$row.TypeGuid
                $pLogTime.Value = $row.LogTime
                $pGuid.Value = $row.Guid.ToLowerInvariant()
                $br = $beforeCmd.ExecuteReader()
                if ($br.Read() -and -not ($br["RecContent"] -is [DBNull]) -and -not [string]::IsNullOrEmpty([string]$br["RecContent"])) {
                    $beforeXml = [string]$br["RecContent"]
                }
                $br.Close()
            }
            if ([string]::IsNullOrEmpty($beforeXml)) {
                $notes = "لا يوجد Snapshot سابق (before) لهذا السجل — هذا أول حدث محتوى (OperationType=$($row.OperationType)) مسجَّل له في log000، فلا توجد حالة سابقة تُقارَن."
            }
        }

        $beforeTotal = Get-XmlTotal $beforeXml
        $afterTotal = Get-XmlTotal $afterXml
        $financialDelta = $null
        if ($isContentBearingType -and -not [string]::IsNullOrEmpty($beforeXml) -and -not [string]::IsNullOrEmpty($afterXml)) {
            if ($null -ne $beforeTotal -and $null -ne $afterTotal) {
                $financialDelta = [math]::Round($afterTotal - $beforeTotal, 4)
            } else {
                $reason = "تعذّر استخراج القيمة المالية (وسم <Total> غير موجود أو غير قابل للتحويل) من "
                $reason += if ($null -eq $beforeTotal -and $null -eq $afterTotal) { "before وafter معاً." }
                           elseif ($null -eq $beforeTotal) { "before فقط." } else { "after فقط." }
                $notes = if ($notes) { "$notes`n$reason" } else { $reason }
            }
        }

        # Codex P1، 2026-08-30، جولة ٤ (finding c) + جولة ٦ (تصحيح) + جولة ٧
        # (تصحيح نهائي): backfill حقيقي = LogTime الصف أقدم من backfill_before
        # المحفوظ في khalil_audit_cursor — حدّ ثابت يُضبَط مرة واحدة فقط عند
        # أول حدث يُسجَّل على الإطلاق (راجع الدالة record_khalil_audit_event
        # في migration) ولا يتغيّر بعدها أبداً. هذا يحل مشكلتين معاً:
        # 1) (جولة ٦) لا يُعاد تصنيف باقي التاريخ المتراكم كـ"حيّ" في التشغيلات
        #    التالية لمجرد أن الـcursor أصبح غير null بعد أول دفعة — الحدّ
        #    محفوظ في القاعدة نفسها، لا مُستنتَج من وجود الـcursor لحظياً،
        #    فيبقى ثابتاً عبر كل الدفعات مهما طال تفريغ الباك-فيل الأولي
        #    (Codex P1: "Keep initial backfill mode across every batch").
        # 2) (جولة ٦) حدث حيّ حقيقي متأخر بعد توقف الجهاز/المهمة (LogTime
        #    أحدث من backfill_before لكن أقدم من 15 دقيقة بسبب التوقف) يبقى
        #    غير مصنَّف backfill فتصل إشعاراته كاملة رغم تأخرها. الحدث نفسه
        #    يبقى مسجَّلاً بكامل تفاصيله في الـAudit دوماً بغض النظر عن قيمة
        #    is_backfill.
        # Codex P1، 2026-08-30، جولة ٨ ("Mark the initial page as backfill"):
        # بأول تشغيل على الإطلاق لا يوجد صف cursor بعد، فـget_khalil_audit_cursor()
        # يُرجِع لا شيء ويبقى backfillBoundary = null طوال هذا التشغيل كاملاً —
        # رغم أن أول استدعاء record_khalil_audit_event() سيضبط backfill_before
        # = now() في القاعدة فوراً. بما أن كل صفوف هذه الصفحة الأولى LogTime لها
        # <= SafeUntil (أقدم من الآن بلا شك)، فهي جميعها أقدم من backfill_before
        # الذي سيُخزَّن = now() — فتصنيفها كـbackfill هنا مطابق تماماً لما
        # سيُخزَّن، بدل انتظار التشغيل التالي (الذي كان يترك أول صفحة كاملة
        # كأحداث حيّة فيغرق طابور تيليجرام).
        $isFirstRunEver = ($null -eq $cursorTime)
        $isBackfill = $isFirstRunEver -or (($null -ne $backfillBoundary) -and ($row.LogTime -lt $backfillBoundary))

        $payload = @{
            p_ameen_log_guid     = $row.Guid
            p_ameen_log_time     = $row.LogTime.ToString("yyyy-MM-ddTHH:mm:ss.fffffff")
            p_ameen_user_guid    = $row.UserGuid
            p_ameen_user_login   = "خليل"
            p_device             = $row.Computer
            p_operation          = $row.Operation
            p_operation_type     = $row.OperationType
            p_rec_num            = $row.RecNum
            p_type_guid          = $row.TypeGuid
            p_invoice_number     = $row.RecNum
            p_invoice_guid       = $row.RecGuid
            p_before_snapshot    = if ($beforeXml) { @{ xml = $beforeXml } } else { $null }
            p_after_snapshot     = if ($afterXml) { @{ xml = $afterXml } } else { $null }
            p_financial_delta    = $financialDelta
            p_notes              = $notes
            p_is_backfill        = $isBackfill
        } | ConvertTo-Json -Depth 8 -Compress

        try {
            Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/record_khalil_audit_event" `
                -Headers $headers -ContentType "application/json; charset=utf-8" `
                -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 30 | Out-Null
            $processed++
        } catch {
            # توقف فوري عند أول فشل: الـcursor في Supabase يبقى عند آخر حدث
            # تم تأكيده فعلاً (record_khalil_audit_event لم تُقدِّمه لهذا
            # الصف الفاشل)، فالتشغيل التالي يعيد محاولة هذا الصف نفسه ولا
            # يخسر أي حدث لاحق أيضاً لأنه لم يُرسَل بعد.
            Write-Log ("ERROR on GUID $($row.Guid): " + $_.Exception.Message)
            $conn.Close()
            Notify-Failure ("🚨 فشل رفع حدث تدقيق خليل (GUID: $($row.Guid))`n" + $_.Exception.Message)
            exit 1
        }
    }

    $conn.Close()
    Write-Log ("Pushed $processed / $($rows.Count) Khalil audit event(s) successfully.")
    # دفعة كاملة (== BatchSize) تعني على الأرجح تراكماً متبقياً خلف الـcursor
    # لم يُعالَج بعد بهذا التشغيل — أبلِغ عنها بوضوح بدل "ok" الصامتة.
    $heartbeatStatus = if ($mainRowCount -eq $BatchSize) { "backlog" } else { "ok" }
    Send-Heartbeat $processed $rows.Count $heartbeatStatus
    exit 0
} catch {
    Write-Log ("ERROR: " + $_.Exception.Message)
    Notify-Failure ("🚨 فشل سكربت مزامنة تدقيق خليل`n" + $_.Exception.Message)
    exit 1
}
