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

-- سجل الإشعارات: بديل telegram_outbox داخل الاختبار. نسجّل قرار الإرسال كما
-- تتخذه الدالة، لا الإرسال نفسه.
create temporary table notify_probe (
  seq bigserial primary key,
  event_type text not null,
  task_key text not null,
  detail text
);

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
  cron_grace interval := interval '10 minutes';
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
   select is_healthy,last_alert_at into previous_healthy,previous_alert_at
    from pg_temp.health_probe where task_key=p_key;
   if previous_healthy is distinct from false or previous_alert_at is null
      or (terminal_status='failed' and terminal_at>previous_alert_at)
      or previous_alert_at<p_now-interval '60 minutes' then
    insert into notify_probe(event_type,task_key,detail) values('project_task_failure',p_key,detail_text);
    previous_alert_at:=p_now;
   end if;
   insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_alert_at,last_detail)
    values(p_key,false,p_now,previous_alert_at,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=p_now,last_alert_at=excluded.last_alert_at,last_detail=excluded.last_detail;
  elsif job_health = 'ok' then
   select is_healthy into previous_healthy from pg_temp.health_probe where task_key=p_key;
   if previous_healthy=false then
    insert into notify_probe(event_type,task_key,detail) values('project_task_recovered',p_key,null);
   end if;
   insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail)
    values(p_key,true,p_now,terminal_at,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=p_now,last_success_at=excluded.last_success_at,last_alert_at=null,last_detail='يعمل';
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

  insert into runs_probe values (j,'failed',t0-interval '15 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '14 minutes');
  assert v='failed', '12: الفشل الثاني'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=2,
    '13: فشل نهائي جديد بعد آخر إنذار ⇒ إشعار جديد، لا يبتلعه is_healthy'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=0,
    '14: لا تعافٍ إطلاقاً في هذا التسلسل'; n:=n+1;

  -- =====================================================================
  -- ٣) failed → running → succeeded   ⇒ التعافي بعد succeeded فقط
  -- =====================================================================
  k:='cron:seq3'; j:=3;
  insert into runs_probe values (j,'failed',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=0,
    '15: لا تعافٍ أثناء المحاولة'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false,
    '16: تبقى unhealthy حتى نرى succeeded فعلياً'; n:=n+1;

  insert into runs_probe values (j,'succeeded',t0-interval '15 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '14 minutes');
  assert v='ok', '17: نجاح نهائي ⇒ ok'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered')=1,
    '18: التعافي خرج عند النجاح الفعلي'; n:=n+1;
  assert (select last_success_at from health_probe where task_key=k) = t0-interval '15 minutes',
    '19: last_success_at = زمن التشغيل الناجح، لا زمن محاولة جارية'; n:=n+1;

  -- =====================================================================
  -- ٤) healthy → running → succeeded   ⇒ صفر رسائل (رفرفة prune بعينها)
  -- =====================================================================
  k:='cron:seq4'; j:=4;
  insert into runs_probe values (j,'succeeded',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes' - interval '58 seconds');
  assert v='ok', '20: محاولة جارية فوق نجاح ⇒ ok لا إنذار'; n:=n+1;
  insert into runs_probe values (j,'succeeded',t0-interval '19 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '18 minutes');
  assert v='ok', '21: نجاح تالٍ'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0,
    '22: صفر إشعارات في تسلسل سليم بالكامل'; n:=n+1;

  -- =====================================================================
  -- ٥) healthy → running → failed   ⇒ الإنذار عند النتيجة النهائية
  -- =====================================================================
  k:='cron:seq5'; j:=5;
  insert into runs_probe values (j,'succeeded',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  insert into runs_probe values (j,'running',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes' - interval '58 seconds');
  assert (select count(*) from notify_probe where task_key=k)=0, '23: لا إشعار أثناء المحاولة'; n:=n+1;
  insert into runs_probe values (j,'failed',t0-interval '19 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '18 minutes');
  assert v='failed', '24: الفشل يظهر عند النتيجة النهائية'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '25: إشعار الفشل خرج'; n:=n+1;

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
    '26: حادثة 09:14 — الفشل المكتمل يُكتشف رغم بدء المحاولة التالية فوقه'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '27: حادثة 09:14 — الإنذار الذي لم يخرج آنذاك يخرج الآن'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false,
    '28: حادثة 09:14 — الحالة unhealthy لا healthy'; n:=n+1;

  -- =====================================================================
  -- ٧) نفس الفشل النهائي عبر عدة دورات ⇒ لا يُعامل كفشل جديد كل مرة
  -- =====================================================================
  k:='cron:seq7'; j:=7;
  insert into runs_probe values (j,'failed',t0-interval '50 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '49 minutes');
  assert (select count(*) from notify_probe where task_key=k)=1, '29: إنذار أول'; n:=n+1;
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '44 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '39 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '34 minutes');
  assert (select count(*) from notify_probe where task_key=k)=1,
    '30: ثلاث دورات إضافية على نفس الفشل ⇒ لا إنذار مكرر'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k)=false, '31: تبقى unhealthy'; n:=n+1;

  insert into runs_probe values (j,'failed',t0-interval '30 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '29 minutes');
  assert (select count(*) from notify_probe where task_key=k)=2,
    '32: فشل نهائي جديد ⇒ إنذار جديد رغم أن الحالة كانت unhealthy أصلاً'; n:=n+1;

  -- =====================================================================
  -- ٨) محاولة جارية تتجاوز المهلة ⇒ stuck
  -- =====================================================================
  k:='cron:seq8'; j:=8;
  insert into runs_probe values (j,'succeeded',t0-interval '40 minutes');
  insert into runs_probe values (j,'running',  t0-interval '15 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='stuck', '33: محاولة جارية منذ 15 دقيقة ⇒ stuck'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure')=1,
    '34: الجمود يُنذَر عنه'; n:=n+1;
  assert (select last_detail from health_probe where task_key=k) like 'عالقة%', '35: نص الجمود'; n:=n+1;

  -- =====================================================================
  -- ٩) الحالات المحايدة: never_run بلا تاريخ، وinflight لأول محاولة
  -- =====================================================================
  k:='cron:seq9'; j:=9;
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='never_run', '36: لا تشغيل قط ⇒ never_run'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k) is null,
    '37: is_healthy=null — لا شهادة نجاح بلا نجاح'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0, '38: لا إشعار'; n:=n+1;

  insert into runs_probe values (j,'running',t0-interval '1 minute');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  assert v='inflight', '39: محاولة أولى جارية بلا نتيجة مكتملة ⇒ inflight'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k)=0, '40: inflight لا تُشعر'; n:=n+1;

  k:='cron:seq10'; j:=10;
  insert into runs_probe values (j,'failed',t0-interval '20 minutes');
  v:=pg_temp.monitor_cycle(k,j,true,t0-interval '19 minutes');
  select * into before_row from health_probe where task_key=k;
  delete from runs_probe where jobid=j;
  insert into runs_probe values (j,'running',t0-interval '1 minute');
  v:=pg_temp.monitor_cycle(k,j,true,t0);
  select * into after_row from health_probe where task_key=k;
  assert v='inflight', '41: بلا نتيجة مكتملة ومحاولة جارية ⇒ inflight'; n:=n+1;
  assert after_row.is_healthy=false, '42: المحايدة لم تدهس حكم الفشل القائم'; n:=n+1;
  assert after_row.last_alert_at is not distinct from before_row.last_alert_at,
    '43: المحايدة لم تمسّ last_alert_at'; n:=n+1;
  assert after_row.last_detail is not distinct from before_row.last_detail,
    '44: المحايدة لم تدهس last_detail'; n:=n+1;
  assert after_row.last_observed_at > before_row.last_observed_at,
    '45: المحايدة أثبتت أن المراقب شاهد المهمة'; n:=n+1;

  -- =====================================================================
  -- ١٠) المهمة المعطّلة
  -- =====================================================================
  k:='cron:seq11'; j:=11;
  insert into runs_probe values (j,'succeeded',t0-interval '1 minute');
  v:=pg_temp.monitor_cycle(k,j,false,t0);
  assert v='disabled', '46: active=false ⇒ disabled'; n:=n+1;
  assert (select last_detail from health_probe where task_key=k)='المهمة معطلة', '47: نص التعطيل'; n:=n+1;

  assert n >= 47, format('عدد التأكيدات المنفَّذة %s أقل من 47 — حُذف تأكيد؟', n);
  raise notice 'cron state transitions: % تأكيداً — كلها نجحت ✓', n;
end $$;
