-- ============================================================================
-- 19: تقرير الجرد اليومي — رسالة واحدة لكل تاريخ تقرير (2026-10-21)
--
-- السبب الجذري: trigger على public.inventory_reports (كل إدراج، من أي مصدر، عدة مرات بالدقيقة) يستدعي
-- notify_telegram بالمفتاح inventory:<date> ونافذة 1200 دقيقة (20 ساعة)، فيُرسل ثانيةً بعد 20 ساعة من
-- الأولى لنفس التاريخ (00:00 ثم 20:00 دمشق؛ 8 تواريخ في السجل).
--
-- الإصلاح مطابق لـ18 (مستقل عنه؛ يشتركان في جدول السجل فقط، وينشئه أيهما طُبّق أولاً):
--   مطالبة ذرّية بالتاريخ في private.daily_report_notifications، والادعاء يبقى فقط إن وُجد صف في
--   telegram_outbox، وتاريخ أقدم من 14 يوماً لا يُعلن، والاحتياط بتاريخ دمشق، وبذر السجل من outbox.
-- نص الرسالة وعدد المواد كما هما. لا يمسّ notify_telegram ولا dispatch ولا أي Cron.
-- التراجع: 19-inventory-report-once-per-date-rollback.sql. الاختبار: scripts/check-daily-report-once-per-date.mjs
-- ============================================================================
begin;
set local lock_timeout = '20s';

do $pre$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_inventory_report()'))) is distinct from '775cf58c60f4e147e94b760f3d95e540' then
    raise exception 'PRE 19: tg_notify_inventory_report() is not the audited production body (775cf58c)';
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
select 'inventory_report', substr(dedupe_key, 11)::date, min(id), min(created_at)
from public.telegram_outbox
where event_type = 'inventory_report' and dedupe_key ~ '^inventory:\d{4}-\d{2}-\d{2}$'
group by substr(dedupe_key, 11)::date
on conflict do nothing;

CREATE OR REPLACE FUNCTION public.tg_notify_inventory_report()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  item_count int := null;
  v_date date := coalesce(new.report_date, (now() at time zone 'Asia/Damascus')::date);
  v_key text := 'inventory:' || coalesce(new.report_date, (now() at time zone 'Asia/Damascus')::date)::text;
  v_claimed integer := 0;
  v_outbox bigint;
begin
  -- once-per-date:v1 (proposed/19) — رسالة واحدة لكل تاريخ تقرير
  if v_date < (now() at time zone 'Asia/Damascus')::date - 14 then
    return null;
  end if;
  insert into private.daily_report_notifications (report_kind, report_date)
  values ('inventory_report', v_date)
  on conflict do nothing;
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return null;
  end if;
  if jsonb_typeof(new.items) = 'array' then
    item_count := jsonb_array_length(new.items);
  end if;
  perform public.notify_telegram(
    'inventory_report',
    '📦 وصل تقرير الجرد اليومي من الأمين'
    || case when item_count is not null then chr(10) || 'عدد المواد: ' || item_count else '' end,
    v_key, 20160);
  select o.id into v_outbox from public.telegram_outbox o where o.dedupe_key = v_key order by o.id desc limit 1;
  if v_outbox is null then
    delete from private.daily_report_notifications where report_kind = 'inventory_report' and report_date = v_date;
  else
    update private.daily_report_notifications set outbox_id = v_outbox
    where report_kind = 'inventory_report' and report_date = v_date;
  end if;
  return null;
end;
$function$;

do $post$
begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('public.tg_notify_inventory_report()'))) is distinct from '397fd9a73944f4ca689640879dfe5707' then
    raise exception 'POST 19: tg_notify_inventory_report() body is not the tested version';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_notify_inventory_report'
                 and tgrelid = 'public.inventory_reports'::regclass and not tgisinternal) then
    raise exception 'POST 19: trigger trg_notify_inventory_report missing';
  end if;
end
$post$;
commit;
