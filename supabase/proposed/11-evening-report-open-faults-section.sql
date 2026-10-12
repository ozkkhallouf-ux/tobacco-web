-- proposed/11-evening-report-open-faults-section.sql
--
-- **مقترح — غير مطبَّق على الإنتاج.** **لا يُطبَّق منفرداً**: يتطلب proposed/10 ويُطبَّق
-- فقط داخل الحزمة الذرّية proposed/12 (الحارس أدناه يرفض غير ذلك).
--
-- يضيف قسم «حالة الأنظمة والأعطال» إلى نهاية الرسالة الرئيسية للتقرير المسائي
-- القائم (send_evening_report، cron 20:00) — بلا تقرير جديد ولا رسالة Telegram
-- إضافية. الرسالة نفسها تحمل مفتاح dedupe القائم ('evening:<يوم>', 720 دقيقة)
-- فلا يتكرر الإرسال.
--
-- آلية التطبيق: رقعة نصية دقيقة على التعريف الحي (pg_get_functiondef) بدل نسخ
-- الدالة كاملة، فلا تُلغى أي تعديلات لاحقة على التقرير. الرقعة:
--   • تفشل بوضوح إن لم تجد المرساة (لا تغيير صامت)،
--   • idempotent: تتخطى إن كانت مطبَّقة،
--   • تحيط استدعاء القسم بمعالج استثناء كي لا يُسقط خطأ فيه التقرير المسائي.
-- التراجع: proposed/12-digest-only-rollback.sql (من لقطة الحزمة)، أو إعادة تطبيق
--   20260926234241_evening_report_supplier_purchases_from_bills.sql.
do $guard$ begin
  if coalesce(current_setting('app.digest_bundle', true), '') <> 'on' then
    raise exception 'proposed/11 must be applied only through proposed/12 (atomic bundle)';
  end if;
end $guard$;

do $patch$
declare
  def text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
  addition constant text := $b$begin
    msg := msg || chr(10) || chr(10) || coalesce(private.daily_open_faults_section(now(), greatest(3900 - length(msg) - 2, 200)), '');
  exception when others then
    msg := msg || chr(10) || chr(10) || '🛠 حالة الأنظمة والأعطال' || chr(10) || '⚠️ تعذّر إعداد هذا القسم.';
  end;
  $b$;
begin
  select pg_get_functiondef('public.send_evening_report()'::regprocedure) into def;
  if position('daily_open_faults_section' in def) > 0 then
    raise notice 'send_evening_report: already patched, skipping';
    return;
  end if;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'send_evening_report: anchor not found exactly once; aborting without change';
  end if;
  execute replace(def, anchor, addition || anchor);
end
$patch$;
