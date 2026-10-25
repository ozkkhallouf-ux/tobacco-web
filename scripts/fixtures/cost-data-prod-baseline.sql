-- ============================================================================
-- نسخة بنية محلية لكائنات Production التي تمسّها Migration 24 (تسرّب التكلفة).
-- لا بيانات حقيقية إطلاقاً: كل الصفوف اصطناعية.
--
-- المصدر: قراءة فقط من Production بتاريخ 2026-10-25 عبر pg_policy وrelacl و
-- pg_get_functiondef. السياسات والصلاحيات (ACL) والدوال أدناه منسوخة حرفياً،
-- لأن الاختبار يقارن بصمتها قبل الهجرة وبعد التراجع.
--
-- يُستعمل حصراً من scripts/check-cost-data-owner-only.mjs على Postgres محلي.
-- ============================================================================

-- أدوار Supabase: postgres هناك ليس superuser لكنه BYPASSRLS ومالك الجداول.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supa_owner') then create role supa_owner nologin nosuperuser bypassrls; end if;
end $$;
grant anon, authenticated, service_role to supa_owner;

create schema auth authorization supa_owner;
alter schema public owner to supa_owner;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;

set role supa_owner;

create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as
$$ select coalesce(auth.jwt() ->> 'role', current_user::text) $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- --- هوية المالك والطاقم والمزامنة (حرفياً من Production) -------------------
create table public.staff_allowlist(email text primary key);

create function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $function$
  select exists (
    select 1
    from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
      ''
    ))
  );
$function$;

create function public.is_owner() returns boolean language sql stable
set search_path to 'public', 'pg_temp' as $function$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$function$;

-- معرّف هوية المزامنة الحقيقي في Production هو 9724dbe4-…؛ هنا معرّف اصطناعي ثابت.
create function public.sales_line_items_is_sync_writer() returns boolean language sql stable
set search_path to '' as $function$
  select (select auth.uid()) = '00000000-0000-0000-0000-00000000aaaa'::uuid;
$function$;
create function public.ameen_item_snapshot_is_sync_writer() returns boolean language sql stable
set search_path to '' as $function$
  select (select auth.uid()) = '00000000-0000-0000-0000-00000000aaaa'::uuid;
$function$;
create function public.ameen_daily_profit_is_sync_writer() returns boolean language sql stable
set search_path to '' as $function$
  select (select auth.uid()) = '00000000-0000-0000-0000-00000000aaaa'::uuid;
$function$;

-- --- الجداول -----------------------------------------------------------------
create table public.sales_line_items (
  id bigserial primary key, bill_no text not null, bill_type text not null, sale_date date not null,
  item_key text, item_name text not null, qty numeric not null default 0, unit_price numeric not null default 0,
  line_total numeric not null default 0, unit_cost numeric, net_profit numeric, customer_name text,
  created_at timestamptz default now(), unit2_name text, unit2_factor numeric, source_key uuid);
create unique index sales_line_items_source_key_unique on public.sales_line_items(source_key) where source_key is not null;

create table public.sales_line_items_sync_state (
  source text primary key, sync_run_id uuid not null, window_start date not null, window_end date not null,
  row_count integer not null, completed_at timestamptz not null, completed_by uuid not null);

create table public.ameen_item_snapshot (
  id uuid primary key default gen_random_uuid(), item_key text not null unique, item_guid text, item_number text,
  item_name text not null default '', unit1_name text default '', unit2_name text default '', unit2_factor numeric default 1,
  stock_unit1 numeric default 0, stock_unit2 numeric default 0, last_purchase_price numeric, last_purchase_currency text,
  last_purchase_date date, last_purchase_unit text, average_cost numeric, average_cost_currency text,
  average_cost_basis text default '', last_supplier_name text, last_supplier_guid text, units_sold_30d numeric,
  movement_rank integer, generated_at timestamptz not null default now());

create table public.inventory_reports (
  id uuid primary key default gen_random_uuid(), report_date date not null default current_date,
  source text not null default 'ameen_excel', summary jsonb not null default '{}', items jsonb not null default '[]',
  created_by uuid not null, created_at timestamptz not null default now());
create unique index inventory_reports_ameen_daily_profit_date_uidx on public.inventory_reports(report_date)
  where source = 'ameen_daily_profit';

create table public.item_costs (
  match_key text primary key, item_name text, avg_cost numeric, currency text default 'SYP',
  updated_at timestamptz not null default now(), item_guid text);

create table public.supplier_item_offers (
  id uuid primary key default gen_random_uuid(), supplier_key text not null, supplier_name text not null,
  item_key text not null, item_name text not null default '', unit_name text not null default '', price numeric not null,
  currency text not null default 'USD', payment_terms_days integer not null default 0, min_qty numeric not null default 0,
  available_qty numeric, is_active boolean not null default true, quoted_at timestamptz not null default now(), notes text);

create view public.v_item_supplier_comparison with (security_invoker = true) as
  select item_key, max(item_name) as item_name, currency,
         min(price) filter (where is_active) as best_price,
         count(*) filter (where is_active) as active_supplier_count
  from public.supplier_item_offers group by item_key, currency;

create table public.app_secrets (name text primary key, value text not null);
create table public.bot_config (key text primary key, value text, updated_at timestamptz not null default now());

alter table public.sales_line_items enable row level security;
alter table public.sales_line_items_sync_state enable row level security;
alter table public.ameen_item_snapshot enable row level security;
alter table public.inventory_reports enable row level security;
alter table public.item_costs enable row level security;
alter table public.supplier_item_offers enable row level security;
alter table public.app_secrets enable row level security;
alter table public.bot_config enable row level security;

-- --- السياسات (حرفياً من Production) ----------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sales_line_items','sales_line_items_sync_state','ameen_item_snapshot','inventory_reports',
                           'item_costs','supplier_item_offers','app_secrets','bot_config'] loop
    execute format($p$create policy deny_inventory_counter_access on public.%I as restrictive for all to authenticated
      using ((( SELECT lower(COALESCE(((( SELECT auth.jwt() AS jwt) -> 'app_metadata'::text) ->> 'role'::text), ''::text)) AS lower) <> 'inventory_counter'::text))
      with check ((( SELECT lower(COALESCE(((( SELECT auth.jwt() AS jwt) -> 'app_metadata'::text) ->> 'role'::text), ''::text)) AS lower) <> 'inventory_counter'::text))$p$, t);
  end loop;
end $$;

create policy "authenticated can select sales_line_items" on public.sales_line_items as permissive for select to authenticated using (true);
create policy "sync writer can delete sales_line_items" on public.sales_line_items as permissive for delete to authenticated using (( SELECT sales_line_items_is_sync_writer() AS sales_line_items_is_sync_writer));
create policy "sync writer can insert sales_line_items" on public.sales_line_items as permissive for insert to authenticated with check (( SELECT sales_line_items_is_sync_writer() AS sales_line_items_is_sync_writer));

create policy "authenticated can select sales line item sync state" on public.sales_line_items_sync_state as permissive for select to authenticated using (true);
create policy "sync writer can insert sales line item sync state" on public.sales_line_items_sync_state as permissive for insert to authenticated with check (( SELECT sales_line_items_is_sync_writer() AS sales_line_items_is_sync_writer));
create policy "sync writer can update sales line item sync state" on public.sales_line_items_sync_state as permissive for update to authenticated using (( SELECT sales_line_items_is_sync_writer() AS sales_line_items_is_sync_writer)) with check (( SELECT sales_line_items_is_sync_writer() AS sales_line_items_is_sync_writer));

create policy "authenticated can select ameen_item_snapshot" on public.ameen_item_snapshot as permissive for select to authenticated using (true);
create policy "sync writer can delete ameen_item_snapshot" on public.ameen_item_snapshot as permissive for delete to authenticated using (( SELECT ameen_item_snapshot_is_sync_writer() AS ameen_item_snapshot_is_sync_writer));
create policy "sync writer can insert ameen_item_snapshot" on public.ameen_item_snapshot as permissive for insert to authenticated with check (( SELECT ameen_item_snapshot_is_sync_writer() AS ameen_item_snapshot_is_sync_writer));

create policy inventory_reports_staff_delete on public.inventory_reports as permissive for delete to authenticated using (is_staff());
create policy inventory_reports_staff_insert on public.inventory_reports as permissive for insert to authenticated with check (is_staff());
create policy inventory_reports_staff_select on public.inventory_reports as permissive for select to authenticated using (is_staff());
create policy inventory_reports_staff_update on public.inventory_reports as permissive for update to authenticated using (is_staff()) with check (is_staff());

create policy item_costs_delete_owner on public.item_costs as permissive for delete to authenticated using (is_owner());
create policy item_costs_insert_owner on public.item_costs as permissive for insert to authenticated with check (is_owner());
create policy item_costs_select_owner on public.item_costs as permissive for select to authenticated using (is_owner());
create policy item_costs_update_owner on public.item_costs as permissive for update to authenticated using (is_owner()) with check (is_owner());

create policy supplier_item_offers_read on public.supplier_item_offers as permissive for select to authenticated using (true);

-- --- الصلاحيات (relacl حرفياً من Production) --------------------------------
revoke all on all tables in schema public from public, anon, authenticated, service_role;
grant select, insert, delete on public.sales_line_items to authenticated;
grant all on public.sales_line_items to service_role;
grant select, insert, update on public.sales_line_items_sync_state to authenticated;
grant all on public.sales_line_items_sync_state to service_role;
grant select, insert, delete on public.ameen_item_snapshot to authenticated;
grant all on public.ameen_item_snapshot to service_role;
grant all on public.inventory_reports to anon, authenticated, service_role;
grant all on public.item_costs to anon, authenticated, service_role;
grant all on public.supplier_item_offers to authenticated, service_role;
grant all on public.v_item_supplier_comparison to anon, authenticated, service_role;
grant all on public.app_secrets to anon, authenticated, service_role;
grant all on public.bot_config to anon, authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- --- دوال الكتابة (منسوخة حرفياً؛ تُختبر أن الكاتب ما زال يعمل بعد الهجرة) ----
create function public.replace_sales_line_items_window(p_window_start date, p_window_end date, p_rows jsonb)
 returns table(sync_run_id uuid, row_count integer, window_start date, window_end date, completed_at timestamp with time zone)
 language plpgsql set search_path to '' set statement_timeout to '15s'
as $function$
declare
  v_count integer; v_inserted integer; v_sync_run_id uuid := gen_random_uuid();
  v_refreshed_at timestamptz; v_completed_at timestamptz;
begin
  if not (select public.sales_line_items_is_sync_writer()) then raise exception 'sync writer required'; end if;
  if p_window_start is null or p_window_end is null or p_window_end < p_window_start then raise exception 'invalid replacement window'; end if;
  if (p_window_end - p_window_start) > 31 then raise exception 'replacement window exceeds 31 days'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'sales line payload must be a non-empty array'; end if;
  perform pg_advisory_xact_lock(hashtextextended('public.sales_line_items.atomic_refresh', 0));
  create temporary table staged_sales_line_items on commit drop as
  select * from jsonb_to_recordset(p_rows) as x(source_key uuid, bill_no text, bill_type text, sale_date date,
    item_key text, item_name text, qty numeric, unit_price numeric, line_total numeric, unit_cost numeric,
    net_profit numeric, customer_name text, unit2_name text, unit2_factor numeric);
  select count(*) into v_count from pg_temp.staged_sales_line_items;
  v_refreshed_at := clock_timestamp();
  delete from public.sales_line_items s where s.sale_date >= p_window_start and s.sale_date <= p_window_end;
  insert into public.sales_line_items (source_key, bill_no, bill_type, sale_date, item_key, item_name, qty,
    unit_price, line_total, unit_cost, net_profit, customer_name, created_at, unit2_name, unit2_factor)
  select s.source_key, s.bill_no, s.bill_type, s.sale_date, s.item_key, s.item_name, s.qty, s.unit_price,
    s.line_total, s.unit_cost, s.net_profit, s.customer_name, v_refreshed_at, s.unit2_name, s.unit2_factor
  from pg_temp.staged_sales_line_items s;
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_count then raise exception 'inserted row count mismatch'; end if;
  v_completed_at := clock_timestamp();
  insert into public.sales_line_items_sync_state (source, sync_run_id, window_start, window_end, row_count, completed_at, completed_by)
  values ('ameen_sales_line_items', v_sync_run_id, p_window_start, p_window_end, v_count, v_completed_at, (select auth.uid()))
  on conflict (source) do update set sync_run_id = excluded.sync_run_id, window_start = excluded.window_start,
    window_end = excluded.window_end, row_count = excluded.row_count, completed_at = excluded.completed_at,
    completed_by = excluded.completed_by;
  return query select v_sync_run_id, v_count, p_window_start, p_window_end, v_completed_at;
end;
$function$;

-- مقتطف من replace_ameen_item_snapshot يحمل الجزء الحساس للصلاحيات وحده:
-- قراءة sales_line_items وsync_state ثم delete … where item_key is not null ثم insert،
-- كلها بصلاحية المستدعي (INVOKER) كما في Production.
create function public.replace_ameen_item_snapshot_probe(p_rows jsonb)
 returns integer language plpgsql set search_path to '' as $function$
declare v_count integer; v_sales integer;
begin
  if not (select public.ameen_item_snapshot_is_sync_writer()) then raise exception 'sync writer required'; end if;
  perform 1 from public.sales_line_items_sync_state s where s.source = 'ameen_sales_line_items';
  if not found then raise exception 'trusted sales completion marker is missing'; end if;
  select count(*)::integer into v_sales from public.sales_line_items s;
  if v_sales = 0 then raise exception 'sales rows not visible to sync writer'; end if;
  delete from public.ameen_item_snapshot s where s.item_key is not null;
  insert into public.ameen_item_snapshot (item_key, item_name, average_cost, last_purchase_price, generated_at)
  select x.item_key, x.item_name, x.average_cost, x.last_purchase_price, now()
  from jsonb_to_recordset(p_rows) as x(item_key text, item_name text, average_cost numeric, last_purchase_price numeric);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create function public.upsert_ameen_daily_profit(p_report_date date, p_summary jsonb, p_items jsonb)
 returns public.inventory_reports language plpgsql security definer set search_path to 'public'
as $function$
declare v_row public.inventory_reports; v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'upsert_ameen_daily_profit requires an authenticated caller'; end if;
  if not public.ameen_daily_profit_is_sync_writer() then
    raise exception 'upsert_ameen_daily_profit is restricted to the trusted sync identity'; end if;
  insert into public.inventory_reports (source, report_date, summary, items, created_by)
  values ('ameen_daily_profit', p_report_date, p_summary, p_items, v_uid)
  on conflict (report_date) where source = 'ameen_daily_profit'
  do update set summary = excluded.summary, items = excluded.items, created_by = excluded.created_by, created_at = now()
  returning * into v_row;
  return v_row;
end;
$function$;

revoke all on function public.replace_sales_line_items_window(date, date, jsonb) from public;
revoke all on function public.replace_ameen_item_snapshot_probe(jsonb) from public;
revoke all on function public.upsert_ameen_daily_profit(date, jsonb, jsonb) from public;
grant execute on function public.replace_sales_line_items_window(date, date, jsonb) to authenticated;
grant execute on function public.replace_ameen_item_snapshot_probe(jsonb) to authenticated;
grant execute on function public.upsert_ameen_daily_profit(date, jsonb, jsonb) to authenticated;

-- --- بيانات اصطناعية ---------------------------------------------------------
insert into public.staff_allowlist values ('owner@test.local'), ('sync@test.local'), ('employee@test.local'), ('norole@test.local');

insert into public.sales_line_items (bill_no, bill_type, sale_date, item_key, item_name, qty, unit_price, line_total, unit_cost, net_profit, source_key)
select 'B'||g, 'wholesale', current_date - (g % 5), 'k'||g, 'صنف '||g, 1, 10, 10, 7, 3, gen_random_uuid()
from generate_series(1, 6) g;
insert into public.sales_line_items_sync_state values ('ameen_sales_line_items', gen_random_uuid(), current_date - 30, current_date, 6, now(), '00000000-0000-0000-0000-00000000aaaa');

insert into public.ameen_item_snapshot (item_key, item_name, stock_unit1, last_purchase_price, last_purchase_currency, last_purchase_unit,
  last_purchase_date, average_cost, average_cost_currency, average_cost_basis, last_supplier_name, units_sold_30d, movement_rank)
select 'k'||g, 'صنف '||g, g*10, 5.5, 'USD', 'كروز', current_date, 6.25, 'USD', 'ameen', 'مورد '||g, g, g
from generate_series(1, 4) g;

insert into public.inventory_reports (source, report_date, summary, created_by) values
  ('ameen_daily_profit', current_date, '{"net_profit": 123.45, "sales_cost": 900}', '00000000-0000-0000-0000-00000000aaaa'),
  ('ameen_purchase_invoices', current_date, '{"bills": 1}', '00000000-0000-0000-0000-00000000aaaa'),
  ('ameen_sql_agent', current_date, '{"totalStockItems": 4}', '00000000-0000-0000-0000-00000000aaaa'),
  ('ameen_customer_balances', current_date, '{"customers": 2}', '00000000-0000-0000-0000-00000000aaaa');

insert into public.item_costs (match_key, item_name, avg_cost, currency) values ('k1', 'صنف 1', 6.25, 'USD');
insert into public.supplier_item_offers (supplier_key, supplier_name, item_key, price) values ('s1', 'مورد 1', 'k1', 5.1);
insert into public.app_secrets values ('telegram_bot_token', 'synthetic-not-a-real-token');
insert into public.bot_config (key, value) values ('owner_chat_id', '0');

reset role;
