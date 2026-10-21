-- تراجع 19: يعيد public.tg_notify_inventory_report() إلى جسم الإنتاج قبل 19 حرفياً (775cf58c…)، ويحذف صفوف
-- inventory_report من السجل. يُسقط private.daily_report_notifications فقط إذا لم تعد أي دالة تستعمله (18 غير مطبَّقة).
-- لا يمسّ telegram_outbox ولا الرسائل السابقة ولا أي Cron.
begin;
set local lock_timeout = '20s';

do $pre$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_inventory_report()'))) is distinct from '397fd9a73944f4ca689640879dfe5707' then
    raise exception 'ROLLBACK 19 PRE: tg_notify_inventory_report() is not the 19 body';
  end if;
end
$pre$;

CREATE OR REPLACE FUNCTION public.tg_notify_inventory_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  item_count int := null;
begin
  if jsonb_typeof(new.items) = 'array' then
    item_count := jsonb_array_length(new.items);
  end if;
  perform public.notify_telegram(
    'inventory_report',
    '📦 وصل تقرير الجرد اليومي من الأمين'
    || case when item_count is not null then chr(10) || 'عدد المواد: ' || item_count else '' end,
    'inventory:' || coalesce(new.report_date::text, to_char(now(), 'YYYY-MM-DD')), 1200);
  return null;
end;
$function$;

delete from private.daily_report_notifications where report_kind = 'inventory_report';

do $post$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_inventory_report()'))) is distinct from '775cf58c60f4e147e94b760f3d95e540' then
    raise exception 'ROLLBACK 19 POST: not back to 775cf58c';
  end if;
  if not exists (select 1 from pg_proc where prosrc like '%private.daily_report_notifications%') then
    drop table private.daily_report_notifications;
  end if;
end
$post$;
commit;
