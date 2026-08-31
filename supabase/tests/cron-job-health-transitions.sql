-- ============================================================================
-- انتقال حالة مهام cron داخل monitor_project_tasks — اختبار regression.
--
-- التشغيل (بعد تطبيق supabase/project-task-health-monitor.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cron-job-health-transitions.sql
-- كل ما يُنشأ هنا مؤقت في pg_temp ويختفي بانتهاء الجلسة. لا يُقرأ ولا يُكتب
-- أي صف من private.project_task_health_state — يُستعمل اسم الجدول كقالب مخطط
-- فقط (LIKE)، كي يبقى الاختبار ملتصقاً بالمخطط الحقيقي لا بنسخة متخيَّلة منه.
--
-- سبب وجوده: جدول حقيقة المصنِّف (cron-job-health-truth-table.sql) يثبت أن
-- التصنيف صحيح، لكنه لا يلمس ما يحدث *بعد* التصنيف. وملاحظة Codex P1 على
-- PR #154 لم تكن في المصنِّف إطلاقاً بل في انتقال الحالة: كان inflight يسقط
-- في فرع "سليم" فيُصدر تعافياً كاذباً ويمسح last_alert_at ويسجّل بدء محاولة
-- لم تنجح في last_success_at — ثم يُكتم إشعار الفشل التالي بمفتاح الـdedupe
-- ذي الستين دقيقة، فتبقى "عادت للعمل" آخر ما يراه المشغّل والمهمة فاشلة.
-- لذلك هذا الملف هو حارس الإصلاح، لا ذاك.
-- ============================================================================

create temporary table health_probe (like private.project_task_health_state including all);

-- سجل الإشعارات: بديل telegram_outbox داخل الاختبار. نسجّل *قرار* الإرسال
-- كما تتخذه الدالة، لا الإرسال نفسه.
create temporary table notify_probe (
  seq bigserial primary key,
  event_type text not null,
  task_key text not null
);

-- ---------------------------------------------------------------------------
-- الفروع الثلاثة، منسوخة حرفياً عن monitor_project_tasks مع استبدال الجدول
-- الحقيقي بجدول المِجَسّ. الفحص الساكن
-- (scripts/check-cron-job-health-classifier.mjs) يثبّت تطابق جملة الفرع
-- المحايد بين الملفّين كي لا ينحرف هذا الاختبار عن الكود الذي يحرسه.
-- ---------------------------------------------------------------------------
create function pg_temp.step_failure(p_key text, p_detail text) returns void language plpgsql as $$
declare previous_healthy boolean; previous_alert_at timestamptz;
begin
  select is_healthy,last_alert_at into previous_healthy,previous_alert_at
    from pg_temp.health_probe where task_key=p_key;
  if previous_healthy is distinct from false or previous_alert_at is null or previous_alert_at<now()-interval '60 minutes' then
    insert into notify_probe(event_type,task_key) values('project_task_failure',p_key);
    previous_alert_at:=now();
  end if;
  insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_alert_at,last_detail)
   values(p_key,false,now(),previous_alert_at,p_detail)
   on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_alert_at=excluded.last_alert_at,last_detail=excluded.last_detail;
end $$;

create function pg_temp.step_ok(p_key text, p_last_job_at timestamptz) returns void language plpgsql as $$
declare previous_healthy boolean;
begin
  select is_healthy into previous_healthy from pg_temp.health_probe where task_key=p_key;
  if previous_healthy=false then
    insert into notify_probe(event_type,task_key) values('project_task_recovered',p_key);
  end if;
  insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail)
   values(p_key,true,now(),p_last_job_at,null,'يعمل')
   on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,last_alert_at=null,last_detail='يعمل';
end $$;

create function pg_temp.step_neutral(p_key text, p_verdict text) returns void language plpgsql as $$
begin
  -- لا إشعار من أي نوع في هذا الفرع — لا سطر إرسال هنا إطلاقاً، بالتصميم.
  insert into pg_temp.health_probe(task_key,is_healthy,last_observed_at,last_detail)
   values(p_key,null,now(),
    case when p_verdict='never_run' then 'لم تُشغَّل بعد' else 'قيد التنفيذ' end)
   on conflict(task_key) do update set last_observed_at=now();
end $$;

do $$
declare
  k text; before_row pg_temp.health_probe%rowtype; after_row pg_temp.health_probe%rowtype;
  n integer := 0;
begin
  -- =====================================================================
  -- التسلسل ١: failed → inflight → failed
  -- المحك الأول: لا شهادة نجاح لمحاولة ما زالت في غرفة العمليات.
  -- =====================================================================
  k := 'cron:seq1';
  perform pg_temp.step_failure(k,'فشل آخر تشغيل عند 2026-08-31 12:00');
  assert (select is_healthy from health_probe where task_key=k) = false, 'seq1: الفشل الأول لم يُسجَّل'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure') = 1,
    'seq1: إشعار الفشل الأول لم يخرج'; n:=n+1;

  -- now() هي زمن بدء المعاملة، وهذا الملف كله معاملة واحدة — فلا تتقدّم
  -- الساعة بين الخطوات كما تتقدّم بين دورات cron الحقيقية (كل دورة معاملة
  -- مستقلة). لذلك نُرجِع last_observed_at صراحةً إلى الوراء لمحاكاة دورة
  -- سابقة، بدل بناء التأكيد على تقدّم زمني لا يحدث هنا.
  update health_probe set last_observed_at = now() - interval '5 minutes' where task_key=k;
  select * into before_row from health_probe where task_key=k;
  perform pg_temp.step_neutral(k,'inflight');
  select * into after_row from health_probe where task_key=k;

  assert after_row.is_healthy = false, 'seq1: inflight غيّر is_healthy — المهمة ما زالت فاشلة'; n:=n+1;
  assert after_row.last_alert_at is not distinct from before_row.last_alert_at,
    'seq1: inflight مسح/غيّر last_alert_at'; n:=n+1;
  assert after_row.last_success_at is not distinct from before_row.last_success_at,
    'seq1: inflight كتب last_success_at لمحاولة لم تنجح'; n:=n+1;
  assert after_row.last_detail is not distinct from before_row.last_detail,
    'seq1: inflight دهس سبب الفشل في last_detail'; n:=n+1;
  assert after_row.last_observed_at > before_row.last_observed_at,
    'seq1: inflight لم يُثبت أن المراقب شاهد المهمة'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k) = 1,
    'seq1: inflight أرسل إشعاراً — الفرع المحايد يجب أن يصمت تماماً'; n:=n+1;

  perform pg_temp.step_failure(k,'فشل آخر تشغيل عند 2026-08-31 12:10');
  assert (select is_healthy from health_probe where task_key=k) = false, 'seq1: الفشل الثاني'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered') = 0,
    'seq1: خرج تعافٍ كاذب في تسلسل فشل→محاولة→فشل (هذا هو عطل Codex P1 بعينه)'; n:=n+1;

  -- =====================================================================
  -- التسلسل ٢: failed → inflight → succeeded
  -- التعافي يخرج عند النجاح الفعلي، ولا يخرج قبله.
  -- =====================================================================
  k := 'cron:seq2';
  perform pg_temp.step_failure(k,'فشل');
  perform pg_temp.step_neutral(k,'inflight');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered') = 0,
    'seq2: تعافٍ خرج أثناء inflight'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k) = false,
    'seq2: يجب أن تبقى unhealthy حتى نرى succeeded فعلياً'; n:=n+1;

  perform pg_temp.step_ok(k, now());
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered') = 1,
    'seq2: التعافي لم يخرج عند النجاح الفعلي'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k) = true, 'seq2: is_healthy بعد النجاح'; n:=n+1;
  assert (select last_alert_at from health_probe where task_key=k) is null,
    'seq2: last_alert_at يجب أن يُمسح عند النجاح الفعلي وحده'; n:=n+1;

  -- =====================================================================
  -- التسلسل ٣: healthy → inflight → succeeded
  -- لا فشل كاذب ولا تعافٍ كاذب على مهمة سليمة أصلاً — سيناريو prune نفسه.
  -- =====================================================================
  k := 'cron:seq3';
  perform pg_temp.step_ok(k, now());
  assert (select count(*) from notify_probe where task_key=k) = 0,
    'seq3: نجاح أول على مهمة بلا حالة سابقة يجب ألا يُصدر أي إشعار'; n:=n+1;

  select * into before_row from health_probe where task_key=k;
  perform pg_temp.step_neutral(k,'inflight');
  select * into after_row from health_probe where task_key=k;
  assert after_row.is_healthy = true, 'seq3: inflight أسقط مهمة سليمة'; n:=n+1;
  assert after_row.last_success_at is not distinct from before_row.last_success_at,
    'seq3: inflight غيّر last_success_at'; n:=n+1;

  perform pg_temp.step_ok(k, now());
  assert (select count(*) from notify_probe where task_key=k) = 0,
    'seq3: خرج إشعار في تسلسل سليم بالكامل — هذه هي رفرفة prune بعينها'; n:=n+1;

  -- =====================================================================
  -- التسلسل ٤: never_run بلا حالة سابقة
  -- الصف يُنشأ بـis_healthy=null: لا تُخترع شهادة نجاح لمهمة لم تعمل قط.
  -- =====================================================================
  k := 'cron:seq4';
  perform pg_temp.step_neutral(k,'never_run');
  assert (select count(*) from health_probe where task_key=k) = 1,
    'seq4: الصف لم يُنشأ — المراقب يجب أن يثبت أنه شاهد المهمة'; n:=n+1;
  assert (select is_healthy from health_probe where task_key=k) is null,
    'seq4: is_healthy يجب أن تكون null لا true — لا شهادة نجاح بلا نجاح'; n:=n+1;
  assert (select last_success_at from health_probe where task_key=k) is null, 'seq4: last_success_at'; n:=n+1;
  assert (select last_alert_at from health_probe where task_key=k) is null, 'seq4: last_alert_at'; n:=n+1;
  assert (select count(*) from notify_probe where task_key=k) = 0, 'seq4: لا إشعار'; n:=n+1;

  -- is_healthy=null آمنة في الفرعين الآخرين: الإنذار يمرّ لاحقاً…
  perform pg_temp.step_failure(k,'فشل بعد أول تشغيل');
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_failure') = 1,
    'seq4: null منعت إشعار الفشل — null is distinct from false يجب أن تمرّ'; n:=n+1;

  -- =====================================================================
  -- التسلسل ٥: never_run بحالة سابقة — لا يدهس حكماً قائماً
  -- =====================================================================
  k := 'cron:seq5';
  perform pg_temp.step_failure(k,'فشل قائم');
  select * into before_row from health_probe where task_key=k;
  perform pg_temp.step_neutral(k,'never_run');
  select * into after_row from health_probe where task_key=k;
  assert after_row.is_healthy = false, 'seq5: never_run دهس حكم فشل قائم'; n:=n+1;
  assert after_row.last_detail is not distinct from before_row.last_detail, 'seq5: never_run دهس last_detail'; n:=n+1;
  assert after_row.last_alert_at is not distinct from before_row.last_alert_at, 'seq5: never_run دهس last_alert_at'; n:=n+1;

  -- …و«لا تعافٍ من حالة مجهولة»: صف is_healthy=null ثم نجاح ⇒ لا رسالة تعافٍ.
  k := 'cron:seq6';
  perform pg_temp.step_neutral(k,'inflight');
  perform pg_temp.step_ok(k, now());
  assert (select count(*) from notify_probe where task_key=k and event_type='project_task_recovered') = 0,
    'seq6: تعافٍ خرج من حالة مجهولة (null) — يجب أن يخرج فقط بعد فشل معروف'; n:=n+1;

  assert n >= 29, format('عدد التأكيدات المنفَّذة %s أقل من 29 — حُذف تأكيد؟', n);
  raise notice 'cron state transitions: % تأكيداً — كلها نجحت ✓', n;
end $$;
