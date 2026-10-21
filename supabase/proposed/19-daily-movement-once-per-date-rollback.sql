-- تراجع 19: يعيد public.tg_notify_daily_movement() إلى جسم الإنتاج قبل 19 حرفياً (feb6663e…)، ويحذف صفوف
-- daily_movement من السجل. يُسقط private.daily_report_notifications فقط إذا لم تعد أي دالة تستعمله (20 غير مطبَّقة).
-- لا يمسّ telegram_outbox ولا الرسائل السابقة ولا أي Cron.
begin;
set local lock_timeout = '20s';

do $pre$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_daily_movement()'))) is distinct from '287872ff20674cf03adb840ec48e9722' then
    raise exception 'ROLLBACK 19 PRE: tg_notify_daily_movement() is not the 19 body';
  end if;
end
$pre$;

CREATE OR REPLACE FUNCTION public.tg_notify_daily_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  previous_payments jsonb := '[]'::jsonb;
  payment_count integer := 0;
  payment_total numeric := 0;
  payment_lines text := '';
begin
  perform public.notify_telegram(
    'daily_movement',
    '📈 وصل تقرير الحركة اليومية — ' || coalesce(to_char(new.report_date, 'YYYY-MM-DD'), 'بدون تاريخ'),
    'movement:' || coalesce(new.report_date::text, to_char(now(), 'YYYY-MM-DD')),
    720
  );

  select coalesce(r.payload->'payments', '[]'::jsonb)
    into previous_payments
  from public.daily_movement_reports r
  where r.report_date = new.report_date
    and r.id <> new.id
    and r.created_at < new.created_at
  order by r.created_at desc
  limit 1;

  previous_payments := coalesce(previous_payments, '[]'::jsonb);

  with new_payments as (
    select p
    from jsonb_array_elements(coalesce(new.payload->'payments', '[]'::jsonb)) p
    where not exists (
      select 1
      from jsonb_array_elements(previous_payments) old_p
      where old_p = p
    )
  )
  select
    count(*)::integer,
    coalesce(sum(coalesce(nullif(p->>'amount', '')::numeric, nullif(p->>'paid', '')::numeric, 0)), 0),
    coalesce(string_agg(
      '• ' || coalesce(nullif(trim(p->>'customer'), ''), 'زبون غير محدد')
      || ' — ' || to_char(coalesce(nullif(p->>'amount', '')::numeric, nullif(p->>'paid', '')::numeric, 0), 'FM999,999,990.00') || ' $'
      || case when nullif(trim(p->>'notes'), '') is not null then chr(10) || '  ' || left(trim(p->>'notes'), 120) else '' end,
      chr(10)
      order by coalesce(nullif(p->>'amount', '')::numeric, nullif(p->>'paid', '')::numeric, 0) desc
    ), '')
  into payment_count, payment_total, payment_lines
  from new_payments;

  if payment_count > 0 then
    perform public.notify_telegram(
      'ameen_payment',
      left(
        '💵 دفعات جديدة من الأمين — ' || coalesce(to_char(new.report_date, 'YYYY-MM-DD'), 'بدون تاريخ')
        || chr(10) || 'العدد: ' || payment_count
        || ' — الإجمالي: ' || to_char(payment_total, 'FM999,999,990.00') || ' $'
        || chr(10) || chr(10) || payment_lines,
        3900
      ),
      'ameen-payments:' || coalesce(new.report_date::text, to_char(now(), 'YYYY-MM-DD'))
        || ':' || md5(coalesce((new.payload->'payments')::text, '[]')),
      1440
    );
  end if;

  return null;
end;
$function$;

delete from private.daily_report_notifications where report_kind = 'daily_movement';

do $post$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_daily_movement()'))) is distinct from 'feb6663e6fcebe7ca17248960e0ec8d8' then
    raise exception 'ROLLBACK 19 POST: not back to feb6663e';
  end if;
  if not exists (select 1 from pg_proc where prosrc like '%private.daily_report_notifications%') then
    drop table private.daily_report_notifications;
  end if;
end
$post$;
commit;
