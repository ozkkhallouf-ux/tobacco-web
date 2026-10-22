-- 20261022034858_is_staff_replay_prerequisite.sql
--
-- شرط مسبق لإعادة تشغيل سلسلة الهجرات على قاعدة جديدة (Codex P1 على #344، 75a7fc37).
--
-- لماذا: 20261022034859_ameen_invoice_events (نسخة حرفية من proposed/18 كما طُبّقت على الإنتاج — لا تُعدَّل)
-- تتطلب public.is_staff() وتتوقف بدونها. هذه الدالة تُثبَّت على الإنتاج خارج السلسلة (staff_allowlist)،
-- وقد وثّقت هجرات سابقة ذلك (20260830141802_khalil_audit_log). فإعادة التشغيل على قاعدة جديدة (reset محلي،
-- فرع معاينة) كانت تقف عند 18.
--
-- ما يفعله: إن لم تكن public.is_staff() موجودة فقط، يُنشئ بديلاً «رفض افتراضي» يعيد false دائماً — فتُنشأ
-- سياسات القراءة ولا يقرأ أحدٌ الجداول إلى أن تُثبَّت الدالة الحقيقية خارج السلسلة (create or replace).
-- على الإنتاج is_staff() موجودة ⇒ لا شيء يتغيّر إطلاقاً (لا جسم ولا صلاحية). لا جداول ولا بيانات ولا cron.
--
-- الإصدار قبل 20261022034859 بثانية كي يسبقه في الترتيب. لا يُطبَّق على الإنتاج إلا بموافقة المالك، وتطبيقه
-- هناك no-op.

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
      'بديل رفض افتراضي لإعادة تشغيل السلسلة (20261022034858). الإنتاج يستعمل تعريفه الخاص خارج السلسلة.';
  end if;
end
$stub$;
