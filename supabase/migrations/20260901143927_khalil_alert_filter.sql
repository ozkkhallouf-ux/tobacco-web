-- 2026-09-01 — khalil_alert_filter_2026_09_01
-- الهدف: إشعار تيليغرام فقط عند تعديل/حذف فاتورة أو سند فعلي.
-- لا إشعار عند فتح/عرض/إغلاق سجل (operation_type 1/9/12) ولا عند إدخال
-- سجل جديد (operation_type 2 = after بلا before).
-- كل الأحداث تبقى مسجّلة كاملةً في khalil_audit_events بلا استثناء —
-- هذا الفلتر يمسّ الإشعار فقط لا التدقيق.
--
-- كتلة معالجة الأخطاء أدناه منسوخة حرفياً من التعريف الحيّ السابق
-- (pg_get_functiondef، 2026-09-01) بلا أي تغيير، حفاظاً على ضمانة
-- «فشل Telegram لا يغيّر أو يحذف Audit Event».
--
-- ملاحظة: هذا Migration طُبِّق مباشرةً على الإنتاج (2026-09-01T14:39:27Z)
-- ثم استُبدل خلال نفس الجلسة بـ20260901151522 الذي يضيف فلتر المفرق
-- وتفاصيل الفاتورة. لم يُسجَّل في الـrepo أصلاً؛ أُضيف هنا
-- للتوثيق فقط (RECONSTRUCTED من pg_get_functiondef في الإنتاج).

CREATE OR REPLACE FUNCTION public.tg_notify_khalil_audit_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_message text;
begin
  -- Codex P1، 2026-08-30، جولة ٤: صفوف backfill (is_backfill=true، انظر
  -- تعليق العمود أعلاه) تبقى محفوظة بكامل تفاصيلها في khalil_audit_events —
  -- فقط لا تُطلِق إشعار تيليجرام فورياً هنا، لتفادي إغراق طابور الإرسال
  -- (20 رسالة/دقيقة) بمئات الأحداث التاريخية على حساب التنبيهات الحيّة.
  if new.is_backfill then
    return new;
  end if;

  -- 2026-09-01: فلتر نوع العملية. المطلوب من المالك: تنبيه عند تعديل أو حذف
  -- فاتورة/سند فقط. القياس الفعلي على log000 (موثَّق في
  -- tools/push-khalil-audit-log.ps1): OperationType 1/9/12 لا تحمل RecContent
  -- إطلاقاً — فتح/عرض/إغلاق سجل بلا حفظ. و2 = إدخال جديد (after بلا before).
  -- يبقى 3 و100 = تعديل/حذف بمحتوى فعلي.
  -- ملاحظة: نوع مجهول (null) يمرّ ويُشعِر — فشل مفتوح، كي لا يُبتلع تنبيه
  -- حقيقي بصمت لو ظهر نوع جديد من الأمين.
  if new.operation_type is not null and new.operation_type not in (3, 100) then
    return new;
  end if;

  v_message := format(
    E'🕵️ حدث خليل\nالعملية: %s\nالفاتورة: %s\nالوقت: %s\nالجهاز: %s%s',
    coalesce(new.operation, 'غير محدد'),
    coalesce(new.invoice_number, new.rec_num, 'غير معروفة'),
    to_char(new.ameen_log_time, 'YYYY-MM-DD HH24:MI:SS'),
    coalesce(new.device, 'غير معروف'),
    case when new.financial_delta is not null
      then format(E'\nالفرق المالي: %s', new.financial_delta)
      else ''
    end
  );

  -- dedupe_key = ameen_log_guid (فريد لكل حدث فعلياً) → إشعار واحد بالضبط
  -- لكل صف يُدرج فعلياً هنا (on conflict do nothing في الدالة أعلاه يمنع
  -- أي إعادة إدراج تُطلق هذا الـtrigger من جديد لنفس الحدث).
  --
  -- ملاحظة أمنية/موثوقية (Codex P1، 2026-08-30): هذا الـtrigger يعمل داخل
  -- نفس معاملة record_khalil_audit_event. أي استثناء غير مُلتقَط من
  -- notify_telegram (مثلاً عطل بجدول telegram_outbox أو دالة الإرسال) كان
  -- سيُسقط الـtransaction كاملةً، فيُحذف صفّ الـAudit وتراجع الـcursor —
  -- ما يخالف صراحةً «فشل Telegram لا يغير أو يحذف Audit Event». الحل: كتلة
  -- exception محلية تلتقط أي خطأ من مسار الإشعار فقط (savepoint ضمني من
  -- plpgsql) ولا تدع الفشل يتسرب خارج الـtrigger أبداً — صفّ الـAudit
  -- وتقدّم الـcursor يبقيان مضمونين بغضّ النظر عن نتيجة notify_telegram.
  begin
    perform public.notify_telegram(
      'khalil_audit_event',
      v_message,
      new.ameen_log_guid::text,
      1
    );
  exception
    when query_canceled then
      raise warning 'khalil_audit: notify_telegram canceled/timed out for ameen_log_guid=%',
        new.ameen_log_guid;
      begin
        if not exists (
          select 1 from public.telegram_outbox
          where dedupe_key = new.ameen_log_guid::text
            and created_at > now() - interval '1 minute'
        ) then
          insert into public.telegram_outbox (event_type, message, dedupe_key)
          values ('khalil_audit_event', left(v_message, 3900), new.ameen_log_guid::text);
        end if;
      exception
        when query_canceled then
          raise warning 'khalil_audit: fallback telegram_outbox insert canceled/timed out for ameen_log_guid=%',
            new.ameen_log_guid;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
        when others then
          raise warning 'khalil_audit: fallback telegram_outbox insert also failed for ameen_log_guid=%: %',
            new.ameen_log_guid, sqlerrm;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
      end;
    when others then
      raise warning 'khalil_audit: notify_telegram failed for ameen_log_guid=%: %',
        new.ameen_log_guid, sqlerrm;
      begin
        if not exists (
          select 1 from public.telegram_outbox
          where dedupe_key = new.ameen_log_guid::text
            and created_at > now() - interval '1 minute'
        ) then
          insert into public.telegram_outbox (event_type, message, dedupe_key)
          values ('khalil_audit_event', left(v_message, 3900), new.ameen_log_guid::text);
        end if;
      exception
        when query_canceled then
          raise warning 'khalil_audit: fallback telegram_outbox insert canceled/timed out for ameen_log_guid=%',
            new.ameen_log_guid;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
        when others then
          raise warning 'khalil_audit: fallback telegram_outbox insert also failed for ameen_log_guid=%: %',
            new.ameen_log_guid, sqlerrm;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
      end;
  end;

  return new;
end;
$function$;
