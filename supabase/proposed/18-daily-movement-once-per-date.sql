-- ============================================================================
-- 18: تقرير الحركة اليومية — رسالة واحدة لكل تاريخ تقرير (2026-10-21)
--
-- السبب الجذري: trigger على public.daily_movement_reports (لقطة متجددة ~240 مرة يومياً) يستدعي
-- notify_telegram بالمفتاح movement:<date> ونافذة 720 دقيقة، فأول لقطة بعد 12 ساعة تُرسل الرسالة ثانيةً
-- (00:00 ثم ~12:02 دمشق؛ 11 من 13 تاريخاً في السجل).
--
-- الإصلاح (هذه الدالة وحدها، وبقية جسمها — تنبيه الدفعات — حرفياً كما هو):
--   • سجلّ دائم private.daily_report_notifications بمفتاح أساسي (report_kind, report_date): المطالبة بالتاريخ
--     insert … on conflict do nothing ذرّية، فلقطتان متزامنتان لا تُنشئان رسالتين، ومرور الوقت لا يعيد الإرسال.
--   • لا يُحفظ التاريخ «مُرسَلاً» إلا إذا وُجد له صف في telegram_outbox؛ وإن لم يُنشأ صف يُحذف الادعاء فتحاول
--     اللقطة التالية. الصف الفاشل يبقى في outbox ويعيد dispatch_telegram_outbox محاولته كما هو.
--   • تاريخ أقدم من 14 يوماً (مدة الاحتفاظ بـtelegram_outbox) لا يُعلن: لا سجل موثوقاً لما أُرسل قبله.
--   • الاحتياط عند غياب report_date: تاريخ دمشق لا تاريخ الجلسة.
--   • بذر السجل من telegram_outbox الحالية كي لا يُعاد إعلان تاريخ أُرسل قبل التطبيق.
-- لا يمسّ: notify_telegram وnotify_telegram_dispatch وdispatch_telegram_outbox وأي Cron، ولا مفاتيح الدفعات
-- (ameen-payments بنافذة 1440) ولا التكاليف ولا النفاد. مستقل عن 19 (يشتركان في جدول السجل فقط).
-- التراجع: 18-daily-movement-once-per-date-rollback.sql. الاختبار: scripts/check-daily-report-once-per-date.mjs
-- ============================================================================
begin;
set local lock_timeout = '20s';

do $pre$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_daily_movement()'))) is distinct from 'feb6663e6fcebe7ca17248960e0ec8d8' then
    raise exception 'PRE 18: tg_notify_daily_movement() is not the audited production body (feb6663e)';
  end if;
end
$pre$;

create table if not exists private.daily_report_notifications (
  report_kind text not null check (report_kind in ('daily_movement', 'inventory_report')),
  report_date date not null,
  outbox_id   bigint,
  claimed_at  timestamptz not null default now(),
  primary key (report_kind, report_date)
);
revoke all on table private.daily_report_notifications from public;
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table private.daily_report_notifications from anon, authenticated';
  end if;
end
$grants$;

insert into private.daily_report_notifications (report_kind, report_date, outbox_id, claimed_at)
select 'daily_movement', substr(dedupe_key, 10)::date, min(id), min(created_at)
from public.telegram_outbox
where event_type = 'daily_movement' and dedupe_key ~ '^movement:\d{4}-\d{2}-\d{2}$'
group by substr(dedupe_key, 10)::date
on conflict do nothing;

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
  v_date date := coalesce(new.report_date, (now() at time zone 'Asia/Damascus')::date);
  v_key text := 'movement:' || coalesce(new.report_date, (now() at time zone 'Asia/Damascus')::date)::text;
  v_claimed integer := 0;
  v_outbox bigint;
begin
  -- once-per-date:v1 (proposed/18) — رسالة واحدة لكل تاريخ تقرير
  if v_date >= (now() at time zone 'Asia/Damascus')::date - 14 then
    insert into private.daily_report_notifications (report_kind, report_date)
    values ('daily_movement', v_date)
    on conflict do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed = 1 then
      perform public.notify_telegram(
        'daily_movement',
        '📈 وصل تقرير الحركة اليومية — ' || coalesce(to_char(new.report_date, 'YYYY-MM-DD'), 'بدون تاريخ'),
        v_key,
        20160
      );
      select o.id into v_outbox from public.telegram_outbox o where o.dedupe_key = v_key order by o.id desc limit 1;
      if v_outbox is null then
        delete from private.daily_report_notifications where report_kind = 'daily_movement' and report_date = v_date;
      else
        update private.daily_report_notifications set outbox_id = v_outbox
        where report_kind = 'daily_movement' and report_date = v_date;
      end if;
    end if;
  end if;

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

do $post$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_daily_movement()'))) is distinct from '0626eaaa998300717c3584108ade03e6' then
    raise exception 'POST 18: tg_notify_daily_movement() body is not the tested version';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_notify_daily_movement'
                 and tgrelid = 'public.daily_movement_reports'::regclass and not tgisinternal) then
    raise exception 'POST 18: trigger trg_notify_daily_movement missing';
  end if;
end
$post$;
commit;
