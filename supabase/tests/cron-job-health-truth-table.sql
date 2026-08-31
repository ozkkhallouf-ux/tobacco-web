-- ============================================================================
-- جدول حقيقة private.cron_job_health — اختبار regression كامل.
--
-- التشغيل (بعد تطبيق supabase/project-task-health-monitor.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cron-job-health-truth-table.sql
-- لا يكتب ولا يقرأ أي جدول — تقييم تعبير خالص فقط، فتشغيله آمن على أي بيئة.
--
-- سبب وجوده: الشرط القديم `last_job_status<>'succeeded'` كان قائمة حظر تعدّ
-- التشغيل الجاري فشلاً، فأغرق prune-inventory-reports بإنذارات كاذبة ست مرات
-- في الساعة. التصنيف الآن قائمة سماح صريحة، وهذا الملف يثبّتها حالةً حالة —
-- خصوصاً الحدّ الزمني بالضبط، كي لا يبقى < مقابل <= غامضاً في أي مراجعة لاحقة.
-- ============================================================================
do $$
declare
  -- لحظة مرجعية ثابتة: الدالة تأخذ p_now وسيطاً صريحاً تحديداً كي تكون هذه
  -- التأكيدات حتمية على الحدود بدل أن تعتمد على لحظة التنفيذ.
  t0 constant timestamptz := '2026-08-31 12:00:00+00';
  g  constant interval    := interval '10 minutes';
  n  integer := 0;
  procedure_note text;
begin
  -- ---------------------------------------------------------------------
  -- 1) التعطيل يسبق كل شيء
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(false,'succeeded',t0,g,t0) = 'disabled',
    '1: active=false يجب أن تكون disabled مهما كانت آخر حالة'; n:=n+1;
  assert private.cron_job_health(null,'succeeded',t0,g,t0) = 'disabled',
    '2: active=NULL تُعامل معاملة المعطّلة (تحفُّظ صريح)'; n:=n+1;
  assert private.cron_job_health(false,'failed',t0-interval '1 hour',g,t0) = 'disabled',
    '3: التعطيل يسبق الفشل في العنونة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 2) NULL status = لم تُشغَّل قط — سلوك صريح لا نتيجة عرضية لثلاثية SQL
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,null,null,g,t0) = 'never_run',
    '4: لا حالة ولا طابع زمني ⇒ never_run بلا إنذار'; n:=n+1;
  assert private.cron_job_health(true,null,t0-interval '5 days',g,t0) = 'never_run',
    '5: NULL status تحسم بصرف النظر عن الطابع الزمني'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 3) الحالتان النهائيتان — العمر لا يغيّرهما
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'succeeded',t0-interval '5 days',g,t0) = 'ok',
    '6: succeeded قديمة تبقى ok (قِدَم التشغيل ليس من مسؤولية هذا المصنِّف)'; n:=n+1;
  assert private.cron_job_health(true,'failed',t0-interval '1 second',g,t0) = 'failed',
    '7: failed حديثة ⇒ إنذار فوري'; n:=n+1;
  assert private.cron_job_health(true,'failed',t0-interval '5 days',g,t0) = 'failed',
    '8: failed قديمة تبقى failed'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 4) الحالات العابرة الأربع ضمن المهلة ⇒ inflight (قلب الإصلاح)
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '1 minute',g,t0) = 'inflight',
    '9: running حديثة لم تعد فشلاً'; n:=n+1;
  assert private.cron_job_health(true,'starting',t0-interval '1 minute',g,t0) = 'inflight',
    '10: starting حديثة'; n:=n+1;
  assert private.cron_job_health(true,'connecting',t0-interval '1 minute',g,t0) = 'inflight',
    '11: connecting حديثة'; n:=n+1;
  assert private.cron_job_health(true,'sending',t0-interval '1 minute',g,t0) = 'inflight',
    '12: sending حديثة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 5) الحالات الأربع نفسها بعد المهلة ⇒ stuck (تغطية جديدة لم تكن موجودة)
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '11 minutes',g,t0) = 'stuck',
    '13: running عالقة ⇒ إنذار'; n:=n+1;
  assert private.cron_job_health(true,'starting',t0-interval '11 minutes',g,t0) = 'stuck',
    '14: starting عالقة'; n:=n+1;
  assert private.cron_job_health(true,'connecting',t0-interval '11 minutes',g,t0) = 'stuck',
    '15: connecting عالقة'; n:=n+1;
  assert private.cron_job_health(true,'sending',t0-interval '11 minutes',g,t0) = 'stuck',
    '16: sending عالقة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 6) حالة مجهولة (لو أضاف pg_cron قيمة جديدة) — تحفُّظ لا صمت ولا صراخ
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'some-future-state',t0-interval '1 minute',g,t0) = 'inflight',
    '17: حالة مجهولة حديثة ⇒ صمت مؤقت لا إنذار فوري'; n:=n+1;
  assert private.cron_job_health(true,'some-future-state',t0-interval '11 minutes',g,t0) = 'stuck',
    '18: حالة مجهولة تجاوزت المهلة ⇒ إنذار (تأخير عشر دقائق، لا صمت أبدي)'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 7) الحدّ الزمني بالضبط — المقصد من هذا الملف أصلاً
  --    العمر <  grace ⇒ inflight   ·   العمر >= grace ⇒ stuck
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '10 minutes',g,t0) = 'stuck',
    '19: عشر دقائق بالضبط = stuck (الحدّ شامل من جهة stuck)'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-(interval '10 minutes' - interval '1 microsecond'),g,t0) = 'inflight',
    '20: أقل من الحدّ بميكروثانية واحدة ⇒ inflight'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-(interval '10 minutes' + interval '1 microsecond'),g,t0) = 'stuck',
    '21: أكثر من الحدّ بميكروثانية واحدة ⇒ stuck'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 8) عابرة بلا طابع زمني — لا يمكن إثبات حداثتها ⇒ الموقف المحافظ
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',null,g,t0) = 'stuck',
    '22: عابرة بلا طابع زمني ⇒ stuck لا inflight'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 9) المهلة وسيط فعلي لا رقم مثبت في الجسم
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '15 seconds',interval '30 seconds',t0) = 'inflight',
    '23: مهلة مخصّصة — ضمنها'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '45 seconds',interval '30 seconds',t0) = 'stuck',
    '24: مهلة مخصّصة — بعدها'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 10) الحادثة الإنتاجية الحقيقية (2026-08-31 08:50 UTC) بأرقامها الفعلية:
  --     المراقب now()=08:50:00.213408 · بدء prune=08:50:00.215132
  --     المراقب قرأ الصف وهو running بعد أقل من 400 ميلي‌ثانية.
  --     المنطق القديم أعلنها فشلاً؛ الجديد يمرّرها بصمت.
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(
           true,'running',
           '2026-08-31 08:50:00.215132+00'::timestamptz,
           g,
           '2026-08-31 08:50:00.601000+00'::timestamptz) = 'inflight',
    '25: حادثة prune-inventory-reports الفعلية لم تعد تُصنَّف فشلاً'; n:=n+1;

  -- الحارس الأخير: لو حُذف تأكيد بالخطأ في تعديل لاحق، يسقط الملف هنا.
  assert n >= 25, format('عدد التأكيدات المنفَّذة %s أقل من 25 — حُذف تأكيد؟', n);
  procedure_note := format('cron_job_health truth table: %s تأكيداً — كلها نجحت ✓', n);
  raise notice '%', procedure_note;
end $$;
