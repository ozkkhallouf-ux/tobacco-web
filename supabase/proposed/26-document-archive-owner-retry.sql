-- إعادة محاولة إشعار أرشفة «غير محسوم» يدوياً — للمالك وحده، من Supabase SQL Editor.
-- ليست هجرة: لا تُطبَّق ولا تُسجَّل. تُستعمل فقط بعد أن يتحقق المالك من محادثة البوت أن المستند
-- لم يصل (إن وصل فلا يُفعل شيء).
--
-- لماذا لا يكفي `select public.request_document_archive_retry('<job_id>');` وحده في SQL Editor:
-- الدالة تشترط is_owner() من رمز جلسة (JWT)، وSQL Editor يعمل بلا جلسة، فترفض بـ«owner only».
-- هذا الملف يمرّ بالدالة الرسمية نفسها (بشروطها: المهمة فاشلة، وطلب مفتوح واحد) بهوية حساب المالك
-- كما هي في auth.users، داخل معاملة واحدة وبإعداد محلي ينتهي معها. حساب غير مالك ⇒ ترفض الدالة.
--
-- ما يحدث بعده: تقرير العامل التالي (≤ 5 دقائق) يستهلك الطلب، فتحرّر الدالة حجز الإشعار «غير المحسوم»
-- وحده (لا المُرسَل ولا الجاري)، وترسل الدورة التالية المستند مرة واحدة بحجز جديد. إن صارت المحاولة
-- الجديدة غير محسومة أيضاً وصل تنبيه جديد واحد لها.
--
-- الاستعمال: استبدل <job_id> برقم المهمة كاملاً (32 حرفاً) من التنبيه أو من سجل الأرشفة.
begin;
select set_config('request.jwt.claims', (
  select json_build_object('sub', u.id, 'role', 'authenticated', 'app_metadata', u.raw_app_meta_data)::text
    from auth.users u
   where u.email = 'ozkkhallouf@gmail.com'), true);
select public.request_document_archive_retry('<job_id>');
commit;
