-- 20260914125959_is_staff_replay_prerequisite.sql
--
-- شرط مسبق لإعادة تشغيل سلسلة الهجرات على قاعدة جديدة (Codex P1 على #344 و#349).
--
-- لماذا: public.is_staff() تُثبَّت على الإنتاج خارج السلسلة (staff_allowlist)، كما وثّقت هجرات سابقة
-- (20260830141802_khalil_audit_log). ثلاث هجرات قبل هذه تحرس استعمالها (to_regprocedure ثم تأجيل السياسة)،
-- لكن أول استعمال غير محروس هو 20260914130000_bot_health_alerts_dispatched_and_failed_windows (عرض بشرط
-- is_staff())، ثم 20261022034859_ameen_invoice_events (نسخة حرفية من proposed/18 كما طُبّقت — لا تُعدَّل).
-- فإعادة التشغيل على قاعدة جديدة (reset محلي، فرع معاينة) كانت تقف عند أولهما.
--
-- الإصدار: قبل أول استعمال غير محروس بثانية (20260914130000)، وبعد الهجرات المحروسة فلا يتغيّر سلوك
-- تأجيلها. scripts/check-ameen-invoice-events-p1.mjs يفحص السلسلة كلها: لا استعمال غير محروس قبل هذا الإصدار.
--
-- ما يفعله: إن لم تكن public.is_staff() موجودة فقط، يُنشئ بديلاً «رفض افتراضي» يعيد false دائماً — فتُنشأ
-- العروض والسياسات ولا يقرأ أحدٌ عبرها إلى أن تُثبَّت الدالة الحقيقية خارج السلسلة (create or replace).
-- على الإنتاج is_staff() موجودة ⇒ لا شيء يتغيّر إطلاقاً (لا جسم ولا صلاحية). لا جداول ولا بيانات ولا cron.
-- لا يُطبَّق على الإنتاج إلا بموافقة المالك، وتطبيقه هناك no-op.
--
-- ⚠️ تحذير: البديل يعيد false دائماً. هو مخصّص فقط لتجاوز اعتماد مفقود أثناء تجهيز قاعدة جديدة (reset محلي،
-- فرع معاينة)، وليس بديلاً عن نظام صلاحيات الموظفين (staff_allowlist وis_staff() الحقيقية) ولا يُعتمد عليه
-- في أي بيئة يعمل عليها موظفون: كل ما يحرسه is_staff() يبقى مغلقاً على الجميع حتى تُثبَّت الدالة الحقيقية.
--
-- لماذا يبقى في migrations لا في proposed: هدفه إعادة تشغيل السلسلة نفسها (reset محلي، فرع معاينة Supabase)،
-- وهذه تقرأ migrations وحدها بترتيب الإصدار؛ في proposed لن يُرى أبداً.
--
-- لا يُخفي اعتماداً مفقوداً: حين يُنشئ البديل يرفع WARNING صريحاً في سجل الهجرات، فبيئة بلا الدالة الحقيقية
-- تُعلَن (لا تبدو سليمة بصمت)، وأثره رفض القراءة على الموظفين فيها — لا منح أي صلاحية. تثبيت الدالة الحقيقية
-- خارج السلسلة بـ create or replace يحلّ محله؛ وcreate function بلا replace يفشل صراحةً لا صامتاً.

do $stub$
begin
  if to_regprocedure('public.is_staff()') is null then
    execute $fn$
      create function public.is_staff()
      returns boolean
      language sql
      stable
      set search_path = ''
      as $body$ select false $body$
    $fn$;
    comment on function public.is_staff() is
      'بديل رفض افتراضي لإعادة تشغيل السلسلة (20260914125959). الإنتاج يستعمل تعريفه الخاص خارج السلسلة.';
    raise warning '20260914125959: public.is_staff() absent — created deny-by-default stub (returns false; staff reads blocked). Install the real is_staff()/staff_allowlist out of band with create or replace.'
      using detail = 'The stub ALWAYS returns false. It only unblocks migration replay on a fresh database; it is NOT a replacement for the staff permission system and must not be relied on where staff work.';
  end if;
end
$stub$;
