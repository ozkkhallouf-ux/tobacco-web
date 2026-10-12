-- proposed/11-evening-report-open-faults-section.sql
--
-- **مقترح — غير مطبَّق على الإنتاج.** يتطلب تطبيق proposed/10 أولاً، وتفويضاً صريحاً.
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
-- التراجع: أعد تطبيق آخر ترحيل يعرّف send_evening_report
--   (20260926234241_evening_report_supplier_purchases_from_bills.sql).
do $patch$
declare
  def text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
  addition constant text := $b$begin
    msg := msg || chr(10) || chr(10) || coalesce(private.daily_open_faults_section(), '');
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
