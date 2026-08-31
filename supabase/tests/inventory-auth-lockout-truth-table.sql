-- ============================================================================
-- جدول حقيقة public.smart_inventory_auth_lock_state — اختبار regression كامل.
--
-- التشغيل (بعد تطبيق migration 20260831131500):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/inventory-auth-lockout-truth-table.sql
-- لا يقرأ ولا يكتب أي جدول — تقييم دالة نقية فقط، فتشغيله آمن على الإنتاج.
--
-- العطل الذي يمنعه هذا الملف (إنتاج 2026-08-31): كانت كل محاولة فاشلة تُعيد
-- ضبط locked_until = now() + ١٥ دقيقة بلا شرط، والدالة تُستدعى أيضاً على
-- المحاولات التي رفضها preflight أصلاً. فمن يعيد المحاولة كل دقيقة يُجدّد قفله
-- إلى الأبد، ومن ينتظر ١٥ دقيقة يُقفل ثانيةً من أول خطأ واحد لأن العدّاد لم
-- يُصفَّر. الرسالة «انتظر ١٥ دقيقة» كانت وعداً لا يتحقق.
--
-- الفروع الثلاثة المقصودة، ومختبَرة أدناه حالةً حالة:
--   قفل سارٍ    ⇒ العدّاد ثابت، والقفل يبقى كما هو (لا تمديد أبداً)
--   قفل منتهٍ   ⇒ العدّاد = ١، والقفل = NULL (تعود الميزانية كاملة)
--   بلا قفل     ⇒ العدّاد + ١، ويُقفل ١٥ دقيقة عند بلوغ ٥
-- حدّ انتهاء القفل محسوم ولا يُترك لالتباس < مقابل <=:
--   locked_until >  now ⇒ سارٍ
--   locked_until <= now ⇒ منتهٍ (المساواة بالضبط = منتهٍ)
-- ============================================================================
do $$
declare
  -- لحظة مرجعية ثابتة: الدالة تأخذ p_now وسيطاً صريحاً تحديداً كي تكون هذه
  -- التأكيدات حتمية على الحدود بدل أن تعتمد على لحظة التنفيذ.
  t0    constant timestamptz := '2026-08-31 12:00:00+00';
  lock15 constant timestamptz := '2026-08-31 12:15:00+00';
  s     public.inventory_auth_lock_state;
  n     integer := 0;
begin
  -- ---------------------------------------------------------------------
  -- ١) بلا قفل: العدّاد يزيد ولا قفل قبل بلوغ الحد
  -- ---------------------------------------------------------------------
  s := public.smart_inventory_auth_lock_state(0, null, t0);
  assert s.failed_attempts = 1 and s.locked_until is null, '1: أول محاولة فاشلة ⇒ ١ بلا قفل'; n:=n+1;
  s := public.smart_inventory_auth_lock_state(3, null, t0);
  assert s.failed_attempts = 4 and s.locked_until is null, '2: المحاولة الرابعة ⇒ ٤ بلا قفل'; n:=n+1;
  s := public.smart_inventory_auth_lock_state(null, null, t0);
  assert s.failed_attempts = 1 and s.locked_until is null, '3: NULL في العدّاد يُعامل صفراً'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- ٢) بلوغ الحد بالضبط ⇒ قفل ١٥ دقيقة من اللحظة المُمرَّرة
  -- ---------------------------------------------------------------------
  s := public.smart_inventory_auth_lock_state(4, null, t0);
  assert s.failed_attempts = 5 and s.locked_until = lock15, '4: المحاولة الخامسة ⇒ قفل ١٥ دقيقة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- ٣) قفل سارٍ ⇒ لا تمديد ولا زيادة، مهما تكرّرت المحاولات (جوهر العطل)
  -- ---------------------------------------------------------------------
  s := public.smart_inventory_auth_lock_state(5, lock15, t0 + interval '1 minute');
  assert s.locked_until = lock15, '5: محاولة أثناء القفل يجب ألا تُمدّده'; n:=n+1;
  assert s.failed_attempts = 5, '6: محاولة أثناء القفل يجب ألا تزيد العدّاد'; n:=n+1;
  s := public.smart_inventory_auth_lock_state(5, lock15, t0 + interval '14 minutes 59 seconds');
  assert s.locked_until = lock15 and s.failed_attempts = 5, '7: القفل سارٍ حتى الثانية الأخيرة'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- ٤) انتهاء القفل ⇒ العدّاد يعود إلى ١ والقفل يُرفع (الوعد يتحقق)
  -- ---------------------------------------------------------------------
  s := public.smart_inventory_auth_lock_state(5, lock15, lock15);
  assert s.failed_attempts = 1 and s.locked_until is null,
    '8: المساواة بالضبط = انتهاء القفل، والعدّاد يُصفَّر'; n:=n+1;
  s := public.smart_inventory_auth_lock_state(9, lock15, lock15 + interval '1 second');
  assert s.failed_attempts = 1 and s.locked_until is null,
    '9: بعد انتهاء القفل، خطأ واحد لا يُعيد القفل مهما كان العدّاد القديم'; n:=n+1;

  -- ---------------------------------------------------------------------
  -- ٥) لا سقّاطة: أربع محاولات بعد انتهاء القفل تبقى بلا قفل، والخامسة تقفل
  -- ---------------------------------------------------------------------
  s := public.smart_inventory_auth_lock_state(1, null, lock15);
  assert s.failed_attempts = 2 and s.locked_until is null, '10: الميزانية الجديدة تُستهلك تدريجياً'; n:=n+1;
  s := public.smart_inventory_auth_lock_state(4, null, lock15);
  assert s.failed_attempts = 5 and s.locked_until = lock15 + interval '15 minutes',
    '11: الخامسة في النافذة الجديدة تقفل من جديد'; n:=n+1;

  raise notice 'inventory-auth-lockout truth table: % حالة ناجحة', n;
end $$;
