-- ============================================================================
-- جدول حقيقة private.cron_job_health — اختبار regression كامل.
--
-- التشغيل (بعد تطبيق supabase/project-task-health-monitor.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/cron-job-health-truth-table.sql
-- لا يكتب ولا يقرأ أي جدول — تقييم تعبير خالص فقط، فتشغيله آمن على أي بيئة.
--
-- المصنِّف يأخذ مصدرين مستقلين:
--   latest_*   أحدث تشغيل مطلقاً    ⇒ هل هناك محاولة جارية الآن؟
--   terminal_* أحدث تشغيل نهائي      ⇒ آخر نتيجة مكتملة
-- الفصل بينهما هو جوهر ملاحظة Codex P1 الثانية: الاعتماد على الصف الأحدث
-- وحده يجعل فشلاً مكتملاً يختفي بمجرد أن يبدأ التشغيل التالي فوقه.
--
-- ترتيب الأسبقية المقصود، ومختبَر أدناه حالةً حالة:
--   disabled > failed > stuck > ok > inflight > never_run
-- 'failed' تسبق 'stuck' لأن الفشل حقيقة مكتملة والجمود استنتاج زمني.
--
-- حدّ المهلة محسوم ولا يُترك لالتباس < مقابل <=:
--   عمر المحاولة الجارية <  grace ⇒ لا جمود
--   عمر المحاولة الجارية >= grace ⇒ stuck      (عشر دقائق بالضبط = stuck)
-- ============================================================================
do $$
declare
  -- لحظة مرجعية ثابتة: الدالة تأخذ p_now وسيطاً صريحاً تحديداً كي تكون هذه
  -- التأكيدات حتمية على الحدود بدل أن تعتمد على لحظة التنفيذ.
  t0 constant timestamptz := '2026-08-31 12:00:00+00';
  g  constant interval    := interval '10 minutes';
  n  integer := 0;
begin
  -- ---------------------------------------------------------------------
  -- 1) التعطيل يسبق كل شيء
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(false,'succeeded',t0,'succeeded',t0,g,t0) = 'disabled',
    '1: active=false يجب أن تكون disabled مهما كانت الحالة'; n:=n+1;
  assert private.cron_job_health(null,'succeeded',t0,'succeeded',t0,g,t0) = 'disabled',
    '2: active=NULL تُعامل معاملة المعطّلة (تحفُّظ صريح)'; n:=n+1;
  assert private.cron_job_health(false,'failed',t0,'failed',t0,g,t0) = 'disabled',
    '3: التعطيل يسبق الفشل في العنونة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 2) لا تاريخ إطلاقاً / لا نتيجة مكتملة بعد
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,null,null,null,null,g,t0) = 'never_run',
    '4: لا تشغيل قط ⇒ never_run بلا إنذار'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '1 minute',null,null,g,t0) = 'inflight',
    '5: محاولة أولى جارية بلا نتيجة مكتملة ⇒ inflight محايدة'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '11 minutes',null,null,g,t0) = 'stuck',
    '6: محاولة أولى تجاوزت المهلة ⇒ stuck'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 3) الفشل النهائي لا يختفي تحت محاولة جارية — قلب إصلاح P1 الثانية
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'failed',t0,'failed',t0,g,t0) = 'failed',
    '7: فشل نهائي هو الأحدث'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '10 seconds','failed',t0-interval '1 minute',g,t0) = 'failed',
    '8: محاولة جارية فوق فشل نهائي ⇒ يبقى failed (الفشل لا يُبتلع)'; n:=n+1;
  assert private.cron_job_health(true,'starting',t0-interval '5 seconds','failed',t0-interval '30 minutes',g,t0) = 'failed',
    '9: فشل نهائي قديم تحت محاولة جديدة ⇒ ما زال failed'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '20 minutes','failed',t0-interval '25 minutes',g,t0) = 'failed',
    '10: الفشل يسبق الجمود في العنونة (كلاهما إنذار)'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 4) النجاح النهائي هو شهادة السلامة الوحيدة — ومحاولة جارية فوقه لا تُلغيه
  --    ولا تُنذر. هذه بالضبط حالة prune-inventory-reports التي فتحت البند.
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'succeeded',t0,'succeeded',t0,g,t0) = 'ok',
    '11: نجاح نهائي هو الأحدث'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '1 second','succeeded',t0-interval '10 minutes',g,t0) = 'ok',
    '12: محاولة جارية فوق نجاح نهائي ⇒ ok، لا إنذار كاذب (رفرفة prune)'; n:=n+1;
  assert private.cron_job_health(true,'starting',t0-interval '1 minute','succeeded',t0-interval '5 minutes',g,t0) = 'ok',
    '13: starting فوق نجاح'; n:=n+1;
  assert private.cron_job_health(true,'connecting',t0-interval '1 minute','succeeded',t0-interval '5 minutes',g,t0) = 'ok',
    '14: connecting فوق نجاح'; n:=n+1;
  assert private.cron_job_health(true,'sending',t0-interval '1 minute','succeeded',t0-interval '5 minutes',g,t0) = 'ok',
    '15: sending فوق نجاح'; n:=n+1;
  assert private.cron_job_health(true,'succeeded',t0-interval '5 days','succeeded',t0-interval '5 days',g,t0) = 'ok',
    '16: نجاح قديم يبقى ok (قِدَم التشغيل ليس من مسؤولية هذا المصنِّف)'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 5) الجمود: الحالات العابرة الأربع بعد المهلة، فوق نجاح نهائي
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '11 minutes','succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '17: running عالقة'; n:=n+1;
  assert private.cron_job_health(true,'starting',t0-interval '11 minutes','succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '18: starting عالقة'; n:=n+1;
  assert private.cron_job_health(true,'connecting',t0-interval '11 minutes','succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '19: connecting عالقة'; n:=n+1;
  assert private.cron_job_health(true,'sending',t0-interval '11 minutes','succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '20: sending عالقة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 6) حالة مجهولة (لو أضاف pg_cron قيمة جديدة) — تحفُّظ لا صمت ولا صراخ
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'some-future-state',t0-interval '1 minute','succeeded',t0-interval '5 minutes',g,t0) = 'ok',
    '21: حالة مجهولة حديثة فوق نجاح ⇒ لا إنذار فوري'; n:=n+1;
  assert private.cron_job_health(true,'some-future-state',t0-interval '11 minutes','succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '22: حالة مجهولة تجاوزت المهلة ⇒ إنذار (تأخير عشر دقائق، لا صمت أبدي)'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 7) الحدّ الزمني بالضبط
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '10 minutes','succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '23: عشر دقائق بالضبط = stuck (الحدّ شامل من جهة stuck)'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-(interval '10 minutes' - interval '1 microsecond'),'succeeded',t0-interval '20 minutes',g,t0) = 'ok',
    '24: أقل من الحدّ بميكروثانية ⇒ لا جمود، والحكم لآخر نتيجة مكتملة'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-(interval '10 minutes' + interval '1 microsecond'),'succeeded',t0-interval '20 minutes',g,t0) = 'stuck',
    '25: أكثر من الحدّ بميكروثانية ⇒ stuck'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 8) محاولة جارية بلا طابع زمني — لا يمكن إثبات حداثتها ⇒ الموقف المحافظ
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',null,'succeeded',t0-interval '1 minute',g,t0) = 'stuck',
    '26: محاولة جارية بلا طابع زمني ⇒ stuck لا ok'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 9) المهلة وسيط فعلي لا رقم مثبت في الجسم
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,'running',t0-interval '15 seconds','succeeded',t0-interval '1 minute',interval '30 seconds',t0) = 'ok',
    '27: مهلة مخصّصة — ضمنها'; n:=n+1;
  assert private.cron_job_health(true,'running',t0-interval '45 seconds','succeeded',t0-interval '2 minutes',interval '30 seconds',t0) = 'stuck',
    '28: مهلة مخصّصة — بعدها'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 10) حادثة الإنتاج 2026-08-30 09:14 بأرقامها الحقيقية (قيم ثابتة مكتوبة
  --     هنا، لا استعلام لأي بيانات إنتاج): فشلت ثلاث مهام «كل دقيقة» في
  --     09:14:00.000956، وبدأ تشغيلها التالي 09:15:00.13 قبل دورة المراقب
  --     09:15 — فلم يخرج إنذار واحد تحت المنطق القديم. هنا يجب أن تُكتشف.
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(
           true,
           'running',   '2026-08-30 09:15:00.137140+00'::timestamptz,
           'failed',    '2026-08-30 09:14:00.000956+00'::timestamptz,
           g,           '2026-08-30 09:15:00.200000+00'::timestamptz) = 'failed',
    '29: حادثة 2026-08-30 09:14 — الفشل المكتمل يُكتشف رغم بدء المحاولة التالية'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- 11) حالة دفاعية: نتيجة مكتملة بلا أحدث تشغيل (لا تحدث عملياً، لكن
  --     السلوك يجب أن يكون معرَّفاً لا عرضياً)
  -- ---------------------------------------------------------------------
  assert private.cron_job_health(true,null,null,'succeeded',t0-interval '1 minute',g,t0) = 'ok',
    '30: نجاح نهائي بلا أحدث تشغيل ⇒ ok'; n:=n+1;
  assert private.cron_job_health(true,null,null,'failed',t0-interval '1 minute',g,t0) = 'failed',
    '31: فشل نهائي بلا أحدث تشغيل ⇒ failed'; n:=n+1;

  assert n >= 31, format('عدد التأكيدات المنفَّذة %s أقل من 31 — حُذف تأكيد؟', n);
  raise notice 'cron_job_health truth table: % تأكيداً — كلها نجحت ✓', n;
end $$;
