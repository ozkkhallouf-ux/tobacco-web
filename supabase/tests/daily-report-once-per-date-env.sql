-- بيئة اختبار proposed/19 و20: نسخ حرفية من جسم الإنتاج (pg_get_functiondef، 2026-10-21) لـ notify_telegram
-- (6ca4caa8) وnotify_telegram_dispatch (c35b5c19) وtg_notify_daily_movement (feb6663e) وtg_notify_inventory_report
-- (775cf58c)، وجداول مصغّرة بأعمدة الإنتاج. مسارات الامتصاص (13/15) بدائل تعيد false: النوعان مصنّفان «فوري» في الإنتاج.
-- يُحمَّل عبر scripts/check-daily-report-once-per-date.mjs في قاعدة مؤقتة مستقلة. لا شبكة ولا تيليغرام حقيقي.
do $guard$
begin
  if current_database() not like 'ozk_daily_report_test%' then
    raise exception 'daily report test runs only in ozk_daily_report_test*';
  end if;
end
$guard$;

create schema if not exists private;
create table public.telegram_outbox (id bigserial primary key, event_type text, message text, dedupe_key text,
  status text not null default 'pending', attempts int not null default 0, created_at timestamptz not null default now(),
  sent_at timestamptz, reply_markup jsonb, net_request_id bigint);
create table public.daily_movement_reports (id bigserial primary key, report_date date, created_at timestamptz not null default now(), payload jsonb);
create table public.inventory_reports (id uuid primary key default gen_random_uuid(), report_date date, source text, summary jsonb,
  items jsonb, created_by uuid, created_at timestamptz not null default now());
create function public.is_staff() returns boolean language sql as $$ select false $$;
create function private.sync_outage_absorb_stock_stale(text, text) returns boolean language sql as $$ select false $$;
create function private.absorb_digest_alert(text, text, text) returns boolean language sql as $$ select false $$;
create function private.refine_immediate_alert(p_event_type text, p_message text, p_dedupe_key text, out msg text, out dkey text, out skip boolean)
  language sql as $$ select null::text, null::text, false $$;
CREATE OR REPLACE FUNCTION private.notify_telegram_dispatch(p_event_type text, p_message text, p_dedupe_key text DEFAULT NULL::text, p_dedupe_minutes integer DEFAULT 60, p_reply_markup jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare rf record; refined boolean := false;
begin
  -- ameen-outage:v1  (proposed/15) — تقادم المخزون أثناء انقطاع مزامنة مفتوح يُدمج في الحادثة؛ أي فشل ⇒ يُرسَل كالمعتاد
  if p_reply_markup is null and coalesce(p_dedupe_key, '') like 'stock-priority:stale:%'
     and p_message is not null and length(trim(p_message)) > 0 then
    begin
      if private.sync_outage_absorb_stock_stale(p_message, p_dedupe_key) then return; end if;
    exception when others then null;
    end;
  end if;
  -- digest-routing:v1  (proposed/13) — غير الحرج يذهب للسجلّ الموحَّد؛ أي فشل ⇒ يُرسَل كالمعتاد
  if p_message is not null and length(trim(p_message)) > 0 and p_reply_markup is null then
    begin
      if private.absorb_digest_alert(p_event_type, p_message, p_dedupe_key) then return; end if;
    exception when others then null;  -- عطل في آلية الملخص لا يمنع التنبيه (أمن/فشل التقرير المسائي مستقلان)
    end;
  end if;
  if p_message is null or length(trim(p_message)) = 0 then return; end if;
  if p_reply_markup is null and p_event_type in ('price_sync_mismatch','price_sync_failure') then
    begin
      select * into rf from private.refine_immediate_alert(p_event_type, p_message, p_dedupe_key);
      if rf.msg is not null and rf.skip then return; end if;
      if rf.msg is not null then
        p_message := rf.msg; p_dedupe_key := rf.dkey; refined := true; -- التكرار حُسم في refine (skip)؛ لا يحجب تبدّلَ الشدة صفٌّ أقدم
      end if;
    exception when others then null;  -- يفشل مفتوحاً: يُرسَل النص الأصلي
    end;
  end if;
  if not refined and p_dedupe_key is not null and exists (
    select 1 from public.telegram_outbox
    where dedupe_key = p_dedupe_key
      and created_at > now() - make_interval(mins => greatest(p_dedupe_minutes, 1))
  ) then
    return;
  end if;
  insert into public.telegram_outbox (event_type, message, dedupe_key, reply_markup)
  values (p_event_type, left(p_message, 3900), p_dedupe_key, p_reply_markup);
end;
$function$;

CREATE OR REPLACE FUNCTION public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text DEFAULT NULL::text, p_dedupe_minutes integer DEFAULT 60, p_reply_markup jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  if not (
    v_jwt_role is null
    or v_jwt_role = 'service_role'
    or pg_trigger_depth() > 0
    or public.is_staff()
  ) then
    raise exception 'notify_telegram: unauthorized direct call' using errcode = '42501';
  end if;

  perform private.notify_telegram_dispatch(p_event_type, p_message, p_dedupe_key, p_dedupe_minutes, p_reply_markup);
end;
$function$;

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

create trigger trg_notify_daily_movement after insert on public.daily_movement_reports
for each row execute function public.tg_notify_daily_movement();
create trigger trg_notify_inventory_report after insert on public.inventory_reports
for each row execute function public.tg_notify_inventory_report();
