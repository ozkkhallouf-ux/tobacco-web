-- 2026-09-01 — تنبيهات خليل: جملة فقط + تفاصيل الفاتورة
--
-- مطبَّقة على القاعدة باسم khalil_wholesale_only_with_details_2026_09_01.
-- تجمع طبقتَي الفلترة النهائيتين على tg_notify_khalil_audit_event():
--   1) نوع العملية: إشعار فقط عند 3 و100 (تعديل/حذف) — لا عند الإدخال (2)
--      ولا عند الفتح/العرض/الإغلاق بلا حفظ (1/9/12/126).
--      (طُبِّقت أولاً كـ khalil_alert_filter_2026_09_01، ومضمّنة هنا كاملةً.)
--   2) نوع المستند: تصميت «مبيعات المركز» (المفرق) نهائياً، وإبقاء الجملة
--      والسندات على حالها.
-- وتضيف لنص الإشعار: اسم الزبون، الأصناف بالكميات، والمجموع.
--
-- منطق معالجة الأخطاء الأصلي منقول حرفياً بلا إعادة صياغة، واستخراج
-- التفاصيل معزول داخل كتلة exception خاصة — فشل التحليل أو تيليغرام
-- لا يُسقط معاملة record_khalil_audit_event ولا يحذف صفّ الـAudit.

create or replace function public.tg_notify_khalil_audit_event()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_message text;
  v_snap    text;
  v_cust    text;
  v_total   text;
  v_items   text;
  v_extra   text := '';
  v_op      text;
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

  -- 2026-09-01: فلتر المفرق. المطلوب من المالك: لا إشعار من «مبيعات المركز»
  -- (التجزئة) إطلاقاً، والإشعار فقط من تبويب المبيعات (الجملة) ومن السندات.
  -- تصنيف الأنواع مؤكَّد سابقاً باستعلام مباشر لجدول bt000 المرجعي بالأمين
  -- (موثَّق في tools/push-sales-line-items.ps1):
  --   cc1097b1 = «مبيعات مركز» (تجزئة)  → صامت
  --   7f5b0921 = «مبيعات» و4a827bee = «مبيعات ل.س» (جملة) → يُشعِر
  --   ce000 (سندات) وباقي الأنواع → تبقى تُشعِر كما هي.
  -- قائمة حظر لا قائمة سماح: أي نوع جديد يمرّ ويُشعِر (فشل مفتوح) كي لا
  -- يُبتلع تنبيه حقيقي بصمت.
  if lower(coalesce(new.type_guid::text, '')) = 'cc1097b1-662d-4d80-8e4e-3b493249591c' then
    return new;
  end if;

  -- 2026-09-01: تفاصيل الفاتورة (اسم الزبون، الأصناف والكميات، المجموع).
  -- كامل الاستخراج داخل كتلة exception محلية: أي عطل في التحليل أو في
  -- lookup الأسماء لا يجوز أن يُسقط معاملة record_khalil_audit_event
  -- ويحذف صفّ الـAudit. عند أي فشل يبقى v_extra فارغاً وتُرسل الرسالة
  -- المختصرة كما كانت. الاستخراج نصّي بـsubstring بلا cast إلى xml،
  -- كي لا يرمي XML مشوّه استثناءً أصلاً.
  begin
    v_snap := coalesce(new.after_snapshot->>'xml', '');
    if v_snap like '%<bu000>%' then
      v_cust  := nullif(btrim(substring(v_snap from '<Cust_Name>([^<]*)</Cust_Name>')), '');
      v_total := substring(v_snap from '<Total>([^<]*)</Total>');

      select string_agg(
               format('• %s × %s',
                      coalesce(s.item_name, 'صنف غير معروف'),
                      trim_scale(li.qty)),
               E'\n' order by li.ord)
        into v_items
      from (
        select t.ord,
               substring(t.x from '<Qty>([^<]*)</Qty>')::numeric as qty,
               substring(t.x from '<MatGUID>([^<]*)</MatGUID>')  as mat
        from regexp_split_to_table(v_snap, '<bi>') with ordinality as t(x, ord)
        where t.x like '%<MatGUID>%' and t.x like '%<Qty>%'
        limit 30
      ) li
      left join lateral (
        select sli.item_name
        from public.sales_line_items sli
        where lower(sli.item_key) = lower(li.mat)
        limit 1
      ) s on true;

      v_extra :=
        case when v_cust is not null then format(E'\nالزبون: %s', v_cust) else '' end ||
        case when v_items is not null then format(E'\nالأصناف:\n%s', v_items) else '' end ||
        case when v_total is not null
          then format(E'\nالمجموع: %s', to_char(v_total::numeric, 'FM999999990.00'))
          else '' end;
    end if;
  exception
    when others then
      raise warning 'khalil_audit: invoice detail extraction failed for ameen_log_guid=%: %',
        new.ameen_log_guid, sqlerrm;
      v_extra := '';
  end;

  v_op := case new.operation_type
            when 3   then 'تعديل'
            when 100 then 'تعديل/حذف'
            else coalesce(new.operation, 'غير محدد')
          end;

  v_message := format(
    E'🕵️ حدث خليل\nالعملية: %s\nالفاتورة: %s\nالوقت: %s\nالجهاز: %s%s%s',
    v_op,
    coalesce(new.invoice_number, new.rec_num, 'غير معروفة'),
    to_char(new.ameen_log_time, 'YYYY-MM-DD HH24:MI:SS'),
    coalesce(new.device, 'غير معروف'),
    v_extra,
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
  -- ما يخالف صراحةً "فشل Telegram لا يغير أو يحذف Audit Event". الحل: كتلة
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
