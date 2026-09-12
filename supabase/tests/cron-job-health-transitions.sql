-- ============================================================================
-- انتقال حالة مهام cron داخل monitor_project_tasks — اختبار regression.
--
-- التشغيل (بعد تطبيق supabase/project-task-health-monitor.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cron-job-health-transitions.sql
-- كل ما يُنشأ هنا مؤقت في pg_temp ويختفي بانتهاء الجلسة. لا يُقرأ ولا يُكتب
-- أي صف من private.project_task_health_state ولا من cron.job_run_details —
-- يُستعمل اسم جدول الحالة كقالب مخطط فقط (LIKE)، كي يبقى الاختبار ملتصقاً
-- بالمخطط الحقيقي لا بنسخة متخيَّلة منه، وتاريخ التشغيلات يُبنى هنا بقيم
-- مكتوبة صراحةً فلا يعتمد الاختبار على أي بيانات إنتاج.
--
-- سبب وجوده: جدول حقيقة المصنِّف يثبت أن التصنيف صحيح، لكنه لا يلمس ما يحدث
-- قبله وبعده — أي كيف يُنتقى الصفّان اللذان يُغذّيانه، وماذا يُكتب في الحالة
-- بعده. وملاحظتا Codex P1 على PR #154 كانتا هناك تحديداً لا في المصنِّف:
--   الأولى : inflight كان يسقط في الفرع "السليم" فيُصدر تعافياً كاذباً.
--   الثانية: الاعتماد على الصف الأحدث وحده يُخفي فشلاً مكتملاً بمجرد أن
--            يبدأ التشغيل التالي فوقه (حادثة الإنتاج 2026-08-30 09:14).
-- لذلك يعيد هذا الملف بناء دورة المراقب كاملة: الاستعلامان، ثم المصنِّف، ثم
-- الفروع الثلاثة.
--
-- انحراف مقصود ومعلن: الدورة هنا تأخذ p_now وسيطاً وتستعمله حيث تستعمل
-- الدالة الحقيقية now()، لأن now() هي زمن بدء المعاملة وهذا الملف كله معاملة
-- واحدة — بينما كل دورة cron حقيقية معاملة مستقلة. المنطق مطابق فيما عدا ذلك.
-- ============================================================================

create temporary table health_probe (like private.project_task_health_state including all);

create temporary table runs_probe (
  jobid bigint not null,
  status text not null,
  start_time timestamptz not null
);

-- سجل الإشعارات: بديل telegram_outbox داخل الاختبار. يتضمن dedupe_key
-- وcreated_at لأن قرار "هل خرجت الرسالة فعلاً" في الإنتاج لا يُحسم في
-- monitor_project_tasks() نفسها بل في طبقة notify_telegram/telegram_outbox
-- المنفصلة (مفتاح + نافذة زمنية بحتة، بلا أي وعي بمحتوى الرسالة). إغفال هذه
-- الطبقة هنا كان يجعل اختبار "فشل B يُنذَر فوراً" (سيناريو ١١) يثق بقرار
-- should_alert وحده بلا إثبات أن الرسالة كانت ستصل فعلاً عبر outbox حقيقي —
-- وهذا بالضبط ما يُخفي عطل المفتاح الثابت الذي أصلحته 05.
create temporary table notify_probe (
  seq bigserial primary key,
  event_type text not null,
  task_key text not null,
  dedupe_key text,
  created_at timestamptz not null,
  detail text
);

-- محاكاة أمينة لطبقة dedupe الحقيقية في
-- private.notify_telegram_dispatch (supabase/telegram-notifications.sql):
-- مفتاح + نافذة زمنية فقط، بلا أي علم بمحتوى الرسالة أو هوية الحدث. أي
-- استدعاء بنفس dedupe_key خلال نافذة p_dedupe_minutes يُسقَط بصمت — تماماً
-- كما تفعل telegram_outbox في الإنتاج.
create function pg_temp.notify_probe_insert(
  p_event_type text, p_task_key text, p_dedupe_key text,
  p_dedupe_minutes int, p_detail text, p_now timestamptz
) returns void language plpgsql as $$
begin
  if p_dedupe_key is not null and exists (
    select 1 from pg_temp.notify_probe
    where dedupe_key = p_dedupe_key
      and created_at > p_now - make_interval(mins => greatest(p_dedupe_minutes, 1))
  ) then
    return;
  end if;
  insert into pg_temp.notify_probe(event_type, task_key, dedupe_key, created_at, detail)
    values (p_event_type, p_task_key, p_dedupe_key, p_now, p_detail);
end $$;

-- ---------------------------------------------------------------------------
-- دورة مراقب كاملة لمهمة واحدة — منسوخة عن حلقة cron في
-- monitor_project_tasks مع استبدال الجداول الحقيقية بجداول المِجَسّ.
-- ---------------------------------------------------------------------------
create function pg_temp.monitor_cycle(p_key text, p_jobid bigint, p_active boolean, p_now timestamptz)
returns text language plpgsql as $$
declare
  last_job_status text; last_job_at timestamptz;
  terminal_status text; terminal_at timestamptz;
  retry_running boolean; job_health text; detail_text text;
  previous_healthy boolean; previous_alert_at timestamptz;
  previous_alerted_terminal_at timestamptz; should_alert boolean;
  cron_grace interval := interval '10 minutes'; failure_dedupe_key text;
begin
  -- (١) أحدث تشغيل مطلقاً — هل هناك محاولة جارية الآن؟
  select status,start_time into last_job_status,last_job_at from pg_temp.runs_probe
   where jobid=p_jobid order by start_time desc limit 1;
  -- (٢) أحدث تشغيل نهائي — آخر نتيجة مكتملة، مهما علاها من محاولات.
  select status,start_time into terminal_status,terminal_at from pg_temp.runs_probe
   where jobid=p_jobid and status in ('succeeded','failed')
   order by start_time desc limit 1;
  retry_running:=last_job_status is not null and last_job_status not in ('succeeded','failed');

  job_health:=private.cron_job_health(p_active,last_job_status,last_job_at,
   terminal_status,terminal_at,cron_grace,p_now);

  if job_health in ('disabled','failed','stuck') then
   detail_text:=case job_health
    when 'disabled' then 'المهمة معطلة'
    when 'failed' then format('فشل آخر تشغيل مكتمل عند %s%s',
     coalesce(to_char(terminal_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),'وقت غير معروف'),
     case when retry_running then ' (ومحاولة جارية الآن — لم تُحسم بعد)' else '' end)
    else format('عالقة في حالة %s منذ %s',coalesce(last_job_status,'غير معروفة'),
     coalesce(round(extract(epoch from(p_now-last_job_at))/60.0,1)::text||' دقيقة','مدة غير معروفة'))
    end;
   select is_healthy,last_alert_at,last_alerted_terminal_at
    into previous_healthy,previous_alert_at,previous_alerted_terminal_at
    from pg_temp.health_probe where task_key=p_key;

   -- الإصلاح: 'failed' حادثة مكتملة — لا تُنذَر ثانية لمجرد مرور ساعة إن كانت
   -- terminal_at نفسها لم تتغيّر (لا محاولة جديدة). 'stuck'/'disabled' حالتان
   -- جاريتان فتبقيان على الحارس الزمني الأصلي (التذكير الدوري مقصود لهما).
   if job_health='failed' then
    should_alert:=previous_healthy is distinct from false
     or previous_alert_at is null
     or previous_alerted_terminal_at is distinct from terminal_at;
   else
    should_alert:=previous_healthy is distinct from false
     or previous_alert_at is null
     or previous_alert_at<p_now-interval '60 minutes';
   end if;

   if should_alert then
    -- 05: مفتاح dedupe لحالة 'failed' يتضمن terminal_at (هوية الحادثة)؛
    -- 'stuck'/'disabled' يبقيان على مفتاح ثابت باسم المهمة فقط — نفس منطق
    -- 05 حرفياً، كي يُثبت هذا الاختبار سلوك outbox الحقيقي بعد الإصلاح.
    if job_health='failed' then
     failure_dedupe_key:='failure:'||p_key||':'||to_char(terminal_at,'YYYYMMDDHH24MISS');
    else
     failure_dedupe_key:='failure:'||p_key;
    end if;
    perform pg_temp.notify_probe_insert('project_task_failure',p_key,failure_dedupe_key,60,detail_text,p_now);
    previous_alert_at:=p_now;
    if job_health='failed' then previous_alerted_terminal_at:=terminal_at; end if;
   end if;
   insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_alert_at,last_alerted_terminal_at,last_detail)
    values(p_key,false,p_now,previous_alert_at,previous_alerted_terminal_at,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=p_now,last_alert_at=excluded.last_alert_at,
     last_alerted_terminal_at=excluded.last_alerted_terminal_at,last_detail=excluded.last_detail;
  elsif job_health = 'ok' then
   select is_healthy into previous_healthy from pg_temp.health_probe where task_key=p_key;
   if previous_healthy=false then
    perform pg_temp.notify_probe_insert('project_task_recovered',p_key,
     'recovered:'||p_key||':'||to_char(p_now,'YYYYMMDDHH24MI'),1,null,p_now);
   end if;
   insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_alerted_terminal_at,last_detail)
    values(p_key,true,p_now,terminal_at,null,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=p_now,last_success_at=excluded.last_success_at,
     last_alert_at=null,last_alerted_terminal_at=null,last_detail='يعمل';
  else
   -- 'inflight' / 'never_run': محايدة — لا إشعار من أي نوع، ولا مساس بالحكم.
   insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_detail)
    values(p_key,null,p_now,
     case when job_health='never_run' then 'لم تُشغَّل بعد' else 'قيد التنفيذ' end)
    on conflict(task_key) do update set last_observed_at=p_now;
  end if;
  return job_health;
end $$;

do $$
declare
  t0 constant timestamptz := '2026-08-31 12:00:00+00';
  k text; j bigint; v text;
  before_row pg_temp.health_probe%rowtype; after_row pg_temp.health_probe%rowtype;
  n integer := 0;
begin
  -- =====================================================================
  -- ١) succeeded → failed → running   ⇒ الفشل لا يختفي تحت المحاولة الجارية
  --    هذه هي ملاحظة Codex P1 الثانية بعينها.
  -- =====================================================================
  k:='cron:seq1'; j:=1;
  insert into runs_probe values (j,'succeeded',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  assert v='ok', '1: نجاح نهائي ⇒ ok'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0, '2: لا إشعار على نجاح أول'; n:=n+1;

  insert into runs_probe values (j,'failed',t0-interval '10 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '9 minutes');
  assert v='failed', '3: فشل نهائي ⇒ failed'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '4: إشعار الفشل خرج'; n:=n+1;

  insert into runs_probe values (j,'running',t0-interval '30 seconds');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='failed',
    '5: محاولة جارية فوق فشل مكتمل ⇒ يبقى failed، الفشل لم يُبتلع'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false, '6: تبقى unhealthy'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=0,
    '7: لا تعافٍ كاذب تحت محاولة جارية'; n:=n+1;
  assert (select last_detail from health_probe where task_key=k) like '%محاولة جارية%',
    '8: الرسالة تذكر أن محاولة جارية فوق الفشل'; n:=n+1;

  -- =====================================================================
  -- ٢) failed → running → failed   ⇒ لا Recovery كاذب، والفشل الجديد يُرصد
  -- =====================================================================
  k:='cron:seq2'; j:=2;
  insert into runs_probe values (j,'failed',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  assert v='failed', '9: فشل أول'; n:=n+1;

  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  assert v='failed', '10: المحاولة الجارية لا تُلغي الفشل'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=0,
    '11: لا تعافٍ كاذب'; n:=n+1;

  select * into before_row from health_probe where task_key=k;
  insert into runs_probe values (j,'failed',t0-interval '15 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '14 minutes');
  select * into after_row from health_probe where task_key=k;
  assert v='failed', '12: الفشل الثاني'; n:=n+1;
  assert after_row.is_healthy=false, '13: تبقى unhealthy عند الفشل الثاني'; n:=n+1;
  assert after_row.last_detail is distinct from before_row.last_detail,
    '14: last_detail انتقل إلى الفشل الأحدث'; n:=n+1;
  -- terminal_at الفشل الثاني (t0-15د) يختلف فعلاً عن الأول (t0-30د) — فشل
  -- متكرر عبر تشغيلتين منفصلتين (سيناريو D)، لا نفس الحادثة المكتملة تتكرر
  -- ذكرها. يجب ألا يُخفى: last_alert_at يتقدّم وتخرج رسالة ثانية فوراً.
  assert after_row.last_alert_at = t0-interval '14 minutes',
    '15: last_alert_at يتقدّم لأن terminal_at فشل جديد فعلاً، لا إعادة نفس الحادثة'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=2,
    '15ب: فشل متكرر بterminal_at مختلف ⇒ إنذار ثانٍ فوري (لا إخفاء فشل حقيقي)'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=0,
    '16: لا تعافٍ إطلاقاً في هذا التسلسل'; n:=n+1;

  -- =====================================================================
  -- ٣) failed → running → succeeded   ⇒ التعافي بعد succeeded فقط
  -- =====================================================================
  k:='cron:seq3'; j:=3;
  insert into runs_probe values (j,'failed',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=0,
    '17: لا تعافٍ أثناء المحاولة'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false,
    '18: تبقى unhealthy حتى نرى succeeded فعلياً'; n:=n+1;

  insert into runs_probe values (j,'succeeded',t0-interval '15 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '14 minutes');
  assert v='ok', '19: نجاح نهائي ⇒ ok'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=1,
    '20: التعافي خرج عند النجاح الفعلي'; n:=n+1;
  assert (select last_success_at from health_probe where task_key=k) = t0-interval '15 minutes',
    '21: last_success_at = زمن التشغيل الناجح، لا زمن محاولة جارية'; n:=n+1;

  -- =====================================================================
  -- ٤) healthy → running → succeeded   ⇒ صفر رسائل (رفرفة prune بعينها)
  -- =====================================================================
  k:='cron:seq4'; j:=4;
  insert into runs_probe values (j,'succeeded',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes' - interval '58 seconds');
  assert v='ok', '22: محاولة جارية فوق نجاح ⇒ ok لا إنذار'; n:=n+1;
  insert into runs_probe values (j,'succeeded',t0-interval '19 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '18 minutes');
  assert v='ok', '23: نجاح تالٍ'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0,
    '24: صفر إشعارات في تسلسل سليم بالكامل'; n:=n+1;

  -- =====================================================================
  -- ٥) healthy → running → failed   ⇒ الإنذار عند النتيجة النهائية
  -- =====================================================================
  k:='cron:seq5'; j:=5;
  insert into runs_probe values (j,'succeeded',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes' - interval '58 seconds');
  assert (select count(*) from notify_probe where task_key=k)=0, '25: لا إشعار أثناء المحاولة'; n:=n+1;
  insert into runs_probe values (j,'failed',t0-interval '19 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '18 minutes');
  assert v='failed', '26: الفشل يظهر عند النتيجة النهائية'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '27: إشعار الفشل خرج'; n:=n+1;

  -- =====================================================================
  -- ٦) حادثة الإنتاج 2026-08-30 09:14 — قيم مكتوبة صراحةً، لا استعلام إنتاج.
  --    فشلت dispatch-due-reminders وdispatch-telegram-outbox
  --    وdispatch-web-push-outbox في 09:14:00.000956، وبدأ تشغيلها التالي
  --    09:15:00.13 قبل دورة المراقب 09:15 — فلم يخرج إنذار واحد آنذاك.
  -- =====================================================================
  k:='cron:seq6-incident-20260830'; j:=6;
  insert into runs_probe values (j,'succeeded','2026-08-30 09:13:00+00'::timestamptz);
  insert into runs_probe values (j,'failed',   '2026-08-30 09:14:00.000956+00'::timestamptz);
  insert into runs_probe values (j,'running',  '2026-08-30 09:15:00.137140+00'::timestamptz);
  v:=pg_temp.monitor_cycle(k,j,true,'2026-08-30 09:15:00.200000+00'::timestamptz);
  assert v='failed',
    '28: حادثة 09:14 — الفشل المكتمل يُكتشف رغم بدء المحاولة التالية فوقه'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '29: حادثة 09:14 — الإنذار الذي لم يخرج آنذاك يخرج الآن'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false,
    '30: حادثة 09:14 — الحالة unhealthy لا healthy'; n:=n+1;

  -- =====================================================================
  -- ٧) نفس الفشل النهائي عبر عدة دورات ⇒ لا يُعامل كفشل جديد كل مرة
  --    (سيناريو B: حادثة أُنذر عنها سابقاً وانتهت، بلا محاولة جديدة)
  -- =====================================================================
  k:='cron:seq7'; j:=7;
  insert into runs_probe values (j,'failed',t0-interval '50 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '49 minutes');
  assert (select count(*) from notify_probe where task_key=k)=1, '31: إنذار أول'; n:=n+1;
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '44 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '39 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '34 minutes');
  assert (select count(*) from notify_probe where task_key=k)=1,
    '32: ثلاث دورات إضافية على نفس الفشل ⇒ لا إنذار مكرر'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false, '33: تبقى unhealthy'; n:=n+1;

  -- الإصلاح المقصود بهذا الـPR: التذكير الدوري الساعي أُزيل عن حالة 'failed'
  -- تحديداً — نفس terminal_at، لا محاولة جديدة، فلا مبرر لتكرار الرسالة ولو
  -- بعد ستين دقيقة أو أكثر. هذا هو بالضبط العطل المُبلَّغ عنه إنتاجياً
  -- (ozk-collection-followups وsend-morning-report يُعاد إنذارهما كل ساعة
  -- طوال اليوم لمحاولة واحدة فشلت وانتهت).
  v:=pg_temp.monitor_cycle(k,j,true,t0+interval '12 minutes');
  assert (select count(*) from notify_probe where task_key=k)=1,
    '34: تجاوز الستين دقيقة بلا فشل جديد لا يُعيد الإنذار — العطل المُصلَح'; n:=n+1;
  v:=pg_temp.monitor_cycle(k,j,true,t0+interval '5 hours');
  assert (select count(*) from notify_probe where task_key=k)=1,
    '34ب: حتى بعد ساعات — طالما terminal_at نفسه، صفر تكرار'; n:=n+1;

  -- =====================================================================
  -- ٨) محاولة جارية تتجاوز المهلة ⇒ stuck
  -- =====================================================================
  k:='cron:seq8'; j:=8;
  insert into runs_probe values (j,'succeeded',t0-interval '40 minutes');
  insert into runs_probe values (j,'running',  t0-interval '15 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='stuck', '35: محاولة جارية منذ 15 دقيقة ⇒ stuck'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '36: الجمود يُنذَر عنه'; n:=n+1;
  assert (select last_detail from health_probe where task_key=k) like 'عالقة%', '37: نص الجمود'; n:=n+1;

  -- نفس الجمود لا يزال قائماً (المحاولة نفسها لم تُحسم بعد) بعد أقل من ساعة
  -- ⇒ لا تذكير مكرر بعد.
  v:=pg_temp.monitor_cycle(k,j,true,t0+interval '20 minutes');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '37ب: نفس الجمود خلال أقل من ساعة ⇒ لا تذكير مكرر بعد'; n:=n+1;

  -- دورة ثانية بعد تجاوز الستين دقيقة على التذكير السابق: 'stuck' حالة جارية
  -- لم "تنتهِ" فعلياً (لا terminal_at لها بعد) — التذكير الدوري لها مقصود لا
  -- عطل، ويجب أن يتكرر خلافاً لـ'failed'. هذا يثبت أن 05 لم يمسّ حارس
  -- stuck/disabled الزمني إطلاقاً رغم تعديله لمفتاح dedupe الخاص بـ'failed'.
  v:=pg_temp.monitor_cycle(k,j,true,t0+interval '75 minutes');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=2,
    '37ج: نفس الجمود بعد أكثر من ساعة على التذكير السابق ⇒ تذكير دوري ثانٍ يخرج'; n:=n+1;

  -- =====================================================================
  -- ٩) الحالات المحايدة: never_run بلا تاريخ، وinflight لأول محاولة
  -- =====================================================================
  k:='cron:seq9'; j:=9;
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='never_run', '38: لا تشغيل قط ⇒ never_run'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k) is null,
    '39: is_healthy=null — لا شهادة نجاح بلا نجاح'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0, '40: لا إشعار'; n:=n+1;

  insert into runs_probe values (j,'running',t0-interval '1 minute');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='inflight', '41: محاولة أولى جارية بلا نتيجة مكتملة ⇒ inflight'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0, '42: inflight لا تُشعر'; n:=n+1;

  k:='cron:seq10'; j:=10;
  insert into runs_probe values (j,'failed',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  select * into before_row from health_probe where task_key=k;
  delete from runs_probe where jobid=j;
  insert into runs_probe values (j,'running',t0-interval '1 minute');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  select * into after_row from health_probe where task_key=k;
  assert v='inflight', '43: بلا نتيجة مكتملة ومحاولة جارية ⇒ inflight'; n:=n+1;
  assert after_row.is_healthy=false, '44: المحايدة لم تدهس حكم الفشل القائم'; n:=n+1;
  assert after_row.last_alert_at is not distinct from before_row.last_alert_at,
    '45: المحايدة لم تمسّ last_alert_at'; n:=n+1;
  assert after_row.last_detail is not distinct from before_row.last_detail,
    '46: المحايدة لم تدهس last_detail'; n:=n+1;
  assert after_row.last_observed_at > before_row.last_observed_at,
    '47: المحايدة أثبتت أن المراقب شاهد المهمة'; n:=n+1;

  -- =====================================================================
  -- ١٠) المهمة المعطّلة
  -- =====================================================================
  k:='cron:seq11'; j:=11;
  insert into runs_probe values (j,'succeeded',t0-interval '1 minute');
  v:=pg_temp.monitor_cycle(k,j,false,t0);
  assert v='disabled', '48: active=false ⇒ disabled'; n:=n+1;
  assert (select last_detail from health_probe where task_key=k)='المهمة معطلة', '49: نص التعطيل'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '49ب: إنذار التعطيل الأول خرج'; n:=n+1;

  -- التذكير الدوري لـ'disabled': حالة جارية مقصودة، يجب أن تتكرر كل ساعة
  -- طالما المهمة ما زالت معطلة — بلا تغيير من 05 (الإصلاح خاص بـ'failed' فقط).
  v:=pg_temp.monitor_cycle(k,j,false,t0+interval '20 minutes');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '49ج: أقل من ساعة على تذكير التعطيل السابق ⇒ لا تكرار بعد'; n:=n+1;
  v:=pg_temp.monitor_cycle(k,j,false,t0+interval '75 minutes');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=2,
    '49د: بعد أكثر من ساعة والمهمة ما زالت معطلة ⇒ تذكير دوري ثانٍ يخرج'; n:=n+1;

  -- =====================================================================
  -- ١١) سياسة جديدة ومقصودة تحلّ محلّ ملاحظة Codex P1 الثالثة على PR #154:
  --   فشل A ⇒ إنذار، ثم فشل B *بterminal_at مختلف فعلياً* خلال نفس الساعة.
  --
  -- الفرق عن المحاولة المرفوضة سابقاً: تلك كانت تُقدِّم previous_alert_at
  -- بلا شرط مستقل عن الوقت، فتصطدم بمهلة dedupe الخاصة بطبقة
  -- telegram_outbox (project-cron-failure:<job>, 60 دقيقة) وتُصفِّر ساعة
  -- *التذكير الدوري نفسها* لرسالة قد تُكتَم دون وصول — فيتأجّل تذكير حالة لم
  -- تُبلَّغ. هنا last_alerted_terminal_at مستقل تماماً عن ساعة التذكير
  -- الدوري (لا وجود لتذكير دوري في فرع 'failed' أصلاً بعد هذا الإصلاح)،
  -- ويتقدّم فقط حين يتغيّر terminal_at بالفعل — أي حين تقع محاولة تشغيل
  -- منفصلة وتفشل، لا حين يمرّ الوقت فقط. فشل B هنا حادثة مكتملة جديدة
  -- (سيناريو D: فشل متكرر عبر تشغيلات متعددة) ويستحق إنذاره الخاص.
  -- =====================================================================
  k:='cron:seq12-alert-clock'; j:=12;
  insert into runs_probe values (j,'failed',t0-interval '50 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '49 minutes');
  select * into before_row from health_probe where task_key=k;
  assert before_row.last_alert_at = t0-interval '49 minutes',
    '50: إنذار الفشل A ضبط ساعة الإنذار'; n:=n+1;
  assert before_row.last_alerted_terminal_at = t0-interval '50 minutes',
    '50ب: last_alerted_terminal_at سُجِّل بزمن نهاية A'; n:=n+1;

  insert into runs_probe values (j,'failed',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  select * into after_row from health_probe where task_key=k;
  assert after_row.last_alert_at = t0-interval '19 minutes',
    '51: فشل B له terminal_at مختلف فعلياً ⇒ last_alert_at يتقدّم فوراً'; n:=n+1;
  assert after_row.last_alerted_terminal_at = t0-interval '20 minutes',
    '51ب: last_alerted_terminal_at يتحدّث إلى نهاية B'; n:=n+1;
  assert after_row.is_healthy = false, '52: الحالة تبقى unhealthy عند الفشل B'; n:=n+1;
  assert after_row.last_detail like '%'||to_char((t0-interval '20 minutes') at time zone 'Asia/Riyadh','HH24:MI')||'%',
    '53: last_detail يعكس الفشل الأحدث B'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=2,
    '54: فشل B الحقيقي يخرج إنذاراً ثانياً فوراً — لا يُخفى فشل متكرر (سيناريو D)'; n:=n+1;

  -- والآن، على نفس B، مرور الوقت وحده — بلا terminal_at جديد — لا يُعيد الإنذار.
  v:=pg_temp.monitor_cycle(k,j,true,t0+interval '12 minutes');
  assert (select count(*) from notify_probe where task_key=k)=2,
    '55: تجاوز الستين دقيقة على B نفسه بلا فشل جديد ⇒ لا إنذار ثالث'; n:=n+1;

  -- =====================================================================
  -- ١٢) الحالة الموروثة قبل تهيئة last_alerted_terminal_at (05، القسم ٣):
  --   مهمة كانت already-failed *قبل* تطبيق 04 (أي last_alerted_terminal_at
  --   لم تكن موجودة أصلاً وقتها فتُهيَّأ NULL افتراضياً عند إضافة العمود).
  --   هذا السيناريو يحاكي صفاً حقيقياً بهذه الصفة، ثم يطبّق بالضبط منطق
  --   الـUPDATE الآمن في 05 (لا يُخترع terminal_at، يُشتق من أحدث تشغيل نهائي
  --   فعلي، ومشروط بوجود last_alert_at كدليل إنذار سابق فعلي)، ثم يثبت أن
  --   دورة مراقبة تالية بلا فشل جديد لا تُصدر إنذاراً مكرراً.
  -- =====================================================================
  k:='cron:seq13-legacy-migration'; j:=13;
  -- فشل نهائي واحد سبق الترحيل، وأُنذر عنه فعلاً (last_alert_at موجود) —
  -- هذا بالضبط ما يميّزه عن حادثة لم تُنذَر عنها قط.
  insert into runs_probe values (j,'failed',t0-interval '100 minutes');
  insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_alert_at,last_alerted_terminal_at,last_detail)
    values (k,false,t0-interval '99 minutes',t0-interval '99 minutes',null,'فشل موروث قبل 04');
  assert (select count(*) from notify_probe where task_key=k)=0,
    '56: لا إنذار صادر بعد من هذا الاختبار نفسه — أي إنذار لاحق سيكون هو المكرر المحتمل'; n:=n+1;

  -- تطبيق منطق الـUPDATE الآمن في 05 (نفس الشروط: is_healthy=false،
  -- last_alerted_terminal_at is null، last_alert_at is not null، وterminal_at
  -- مُشتقة من أحدث نتيجة نهائية فعلية — هنا من runs_probe بدل cron.job_run_details).
  update pg_temp.health_probe s
  set last_alerted_terminal_at = t.terminal_at
  from (
    select jobid, max(start_time) filter (where status in ('succeeded','failed')) as terminal_at
    from pg_temp.runs_probe where jobid=j group by jobid
  ) t
  where s.task_key = k
    and s.is_healthy = false
    and s.last_alerted_terminal_at is null
    and s.last_alert_at is not null;

  assert (select last_alerted_terminal_at from health_probe where task_key=k) = t0-interval '100 minutes',
    '57: التهيئة الآمنة استعادت terminal_at الحادثة الموروثة نفسها بلا اختراع قيمة'; n:=n+1;

  -- دورة مراقبة تالية بلا أي محاولة تشغيل جديدة (terminal_at لم يتغيّر) —
  -- يجب ألا تُصدر إنذاراً إطلاقاً، خلافاً للعطل المؤكَّد بلا هذه التهيئة
  -- (previous_alerted_terminal_at NULL IS DISTINCT FROM terminal_at = TRUE
  -- كانت ستُطلق إنذاراً كاذباً واحداً هنا).
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '30 minutes');
  assert v='failed', '58: لا يزال failed — نفس الحادثة القديمة فقط'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0,
    '59: التهيئة الآمنة منعت الإنذار المكرر الكاذب بعد الترحيل'; n:=n+1;

  -- وفشل جديد فعلي لاحقاً (terminal_at مختلف) يجب أن يُنذَر كالمعتاد — التهيئة
  -- لا تُخفي فشلاً حقيقياً جديداً.
  insert into runs_probe values (j,'failed',t0-interval '5 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '4 minutes');
  assert (select count(*) from notify_probe where task_key=k)=1,
    '60: فشل جديد فعلي بعد التهيئة الآمنة ⇒ يُنذَر بلا إخفاء'; n:=n+1;

  assert n >= 60, format('عدد التأكيدات المنفَّذة %s أقل من 60 — حُذف تأكيد؟', n);
  raise notice 'cron state transitions: % تأكيداً — كلها نجحت ✓', n;
end $$;
