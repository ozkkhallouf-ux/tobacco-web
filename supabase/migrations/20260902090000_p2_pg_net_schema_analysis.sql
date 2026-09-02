-- P2-4: pg_net في public schema — تحليل وقرار
-- 2026-09-02
--
-- ════════════════════════════════════════════════════════════════════════════
-- السبب الجذري للتحذير
-- ════════════════════════════════════════════════════════════════════════════
-- Supabase Security Advisor يُعلِم على pg_net لأن:
--   pg_extension.extnamespace = 'public'
--
-- الفحص: extension_in_public — يطلب أن تكون الـextensions في schema مخصصة
--         (مثل extensions) لا في public.
--
-- ════════════════════════════════════════════════════════════════════════════
-- نتائج الفحص الكامل (2026-09-02)
-- ════════════════════════════════════════════════════════════════════════════
--
-- 1. موقع الكائنات الفعلية
--    ┌───────────────────────────────────┬─────────┐
--    │ الكائن                            │ Schema  │
--    ├───────────────────────────────────┼─────────┤
--    │ net.http_post / http_get / ...    │ net     │
--    │ net.http_request_queue            │ net     │
--    │ net._http_response                │ net     │
--    │ net.http_request_queue_id_seq     │ net     │
--    └───────────────────────────────────┴─────────┘
--    → عدد كائنات pg_net في public = ZERO (0)
--
-- 2. قابلية النقل
--    اختُبر ALTER EXTENSION pg_net SET SCHEMA extensions داخل DO block
--    محاط بـEXCEPTION — فشل واكتُشف: pg_net غير قابلة للنقل (relocatable=false).
--    هذا متوقع: pg_net تُنشئ schema خاص بها (net) بصرف النظر عن extnamespace.
--
-- 3. الدوال التي تعتمد على pg_net
--    ┌──────────────────────────────┬──────────────────────────────────────────┐
--    │ الدالة                       │ استدعاء pg_net                           │
--    ├──────────────────────────────┼──────────────────────────────────────────┤
--    │ dispatch_telegram_outbox     │ net.http_post(...)  ← مؤهَّل صريحاً ✓   │
--    │ dispatch_web_push_outbox     │ net.http_post(...)  ← مؤهَّل صريحاً ✓   │
--    │ dispatch_due_reminders       │ net.http_post(...)  ← مؤهَّل صريحاً ✓   │
--    └──────────────────────────────┴──────────────────────────────────────────┘
--    search_path الثلاث دوال تشمل 'net' صراحةً — لا اعتماد على public.
--
-- 4. هل يوجد خطر فعلي؟
--    لا — extnamespace=public لا يعني أن هناك كائنات pg_net في public.
--    التحذير false positive بالنسبة لتصميم هذا المشروع:
--      • كل الاستدعاءات schema-qualified (net.http_post)
--      • لا شيء غير مؤهَّل يمكن أن يلتقط دالة pg_net خطأً
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا لا يمكن نقل pg_net إلى extensions schema؟
-- ════════════════════════════════════════════════════════════════════════════
--
-- المسار الوحيد المتاح هو:
--   DROP EXTENSION pg_net CASCADE → CREATE EXTENSION pg_net SCHEMA extensions
--
-- هذا غير مقبول لأن:
--   1. DROP EXTENSION يحذف net.http_request_queue — يُضيع الرسائل المعلّقة
--      في طابور Telegram (pending rows تُفقد نهائياً)
--   2. pg_net تُنشئ net schema بصرف النظر عن SCHEMA المُحدَّدة — إعادة
--      التثبيت لن تُغيِّر شيئاً وظيفياً
--   3. هذا شأن البنية التحتية لـSupabase (managed extension) — على مشاريع
--      جديدة، Supabase تُثبِّت pg_net مع extnamespace=extensions تلقائياً.
--      المشاريع القديمة تُعالَج بتحديثات البنية التحتية، لا بـmigrations.
--
-- ════════════════════════════════════════════════════════════════════════════
-- القرار: لا تغيير — تحقق ذاتي فقط
-- ════════════════════════════════════════════════════════════════════════════

DO $$
declare
  v_pg_net_schema   text;
  v_objects_in_pub  int;
  v_dispatch_count  int;
begin
  -- 1. تأكد أن pg_net ما زالت مثبَّتة
  select n.nspname into v_pg_net_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_net';

  if v_pg_net_schema is null then
    raise exception 'pg_net: الـextension غير مثبَّتة — مسار Telegram معطَّل!';
  end if;

  -- 2. تأكد أن صفر كائنات pg_net في public (التحذير false positive)
  select count(*) into v_objects_in_pub
    from pg_depend d
    join pg_extension e on e.oid = d.refobjid
    join pg_class c on c.oid = d.objid
    join pg_namespace n on n.oid = c.relnamespace
   where e.extname = 'pg_net'
     and n.nspname = 'public';

  if v_objects_in_pub > 0 then
    raise exception
      'pg_net: وُجد % كائن في public — التحليل يحتاج مراجعة!',
      v_objects_in_pub;
  end if;

  -- 3. تأكد أن دوال الـdispatcher الثلاث موجودة وتستخدم schema net
  select count(*) into v_dispatch_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'dispatch_telegram_outbox',
       'dispatch_web_push_outbox',
       'dispatch_due_reminders'
     )
     and pg_get_functiondef(p.oid) ilike '%net.http_post%';

  if v_dispatch_count <> 3 then
    raise exception
      'dispatcher functions: توقَّعنا 3 دوال بـnet.http_post، وجدنا %',
      v_dispatch_count;
  end if;

  raise notice
    'P2-4 ✓: pg_net مثبَّتة في schema=% · 0 كائن في public · 3/3 dispatchers سليمة',
    v_pg_net_schema;

end $$;
