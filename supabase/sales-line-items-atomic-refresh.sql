-- Review and apply separately. This file is not applied by the producer.
-- A complete replacement and its completion marker commit in one transaction.
begin;

alter table public.sales_line_items
  add column if not exists source_key uuid;

create unique index if not exists sales_line_items_source_key_unique
  on public.sales_line_items (source_key)
  where source_key is not null;

create index if not exists idx_sales_line_items_created_at
  on public.sales_line_items (created_at desc);

alter table public.sales_line_items enable row level security;

revoke all on table public.sales_line_items from public, anon, authenticated;
grant select, insert, delete on table public.sales_line_items to authenticated;
revoke all on sequence public.sales_line_items_id_seq from public, anon, authenticated;
grant usage on sequence public.sales_line_items_id_seq to authenticated;

create or replace function public.sales_line_items_is_sync_writer()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (select auth.uid()) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid;
$$;

revoke all on function public.sales_line_items_is_sync_writer()
  from public, anon, service_role;
grant execute on function public.sales_line_items_is_sync_writer()
  to authenticated;

drop policy if exists "authenticated can select sales_line_items"
  on public.sales_line_items;
drop policy if exists "authenticated can insert sales_line_items"
  on public.sales_line_items;
drop policy if exists "authenticated can delete sales_line_items"
  on public.sales_line_items;
drop policy if exists "sync writer can insert sales_line_items"
  on public.sales_line_items;
drop policy if exists "sync writer can delete sales_line_items"
  on public.sales_line_items;

create policy "authenticated can select sales_line_items"
  on public.sales_line_items
  for select to authenticated
  using (true);

create policy "sync writer can insert sales_line_items"
  on public.sales_line_items
  for insert to authenticated
  with check ((select public.sales_line_items_is_sync_writer()));

create policy "sync writer can delete sales_line_items"
  on public.sales_line_items
  for delete to authenticated
  using ((select public.sales_line_items_is_sync_writer()));

create table if not exists public.sales_line_items_sync_state (
  source text primary key,
  sync_run_id uuid not null,
  window_start date not null,
  window_end date not null,
  row_count integer not null check (row_count >= 0),
  completed_at timestamptz not null,
  completed_by uuid not null,
  constraint sales_line_items_sync_state_source_check
    check (source = 'ameen_sales_line_items'),
  constraint sales_line_items_sync_state_window_check
    check (window_end >= window_start)
);

alter table public.sales_line_items_sync_state enable row level security;
revoke all on table public.sales_line_items_sync_state
  from public, anon, authenticated;
grant select, insert, update on table public.sales_line_items_sync_state
  to authenticated;

drop policy if exists "authenticated can select sales line item sync state"
  on public.sales_line_items_sync_state;
drop policy if exists "sync writer can insert sales line item sync state"
  on public.sales_line_items_sync_state;
drop policy if exists "sync writer can update sales line item sync state"
  on public.sales_line_items_sync_state;

create policy "authenticated can select sales line item sync state"
  on public.sales_line_items_sync_state
  for select to authenticated
  using (true);

create policy "sync writer can insert sales line item sync state"
  on public.sales_line_items_sync_state
  for insert to authenticated
  with check ((select public.sales_line_items_is_sync_writer()));

create policy "sync writer can update sales line item sync state"
  on public.sales_line_items_sync_state
  for update to authenticated
  using ((select public.sales_line_items_is_sync_writer()))
  with check ((select public.sales_line_items_is_sync_writer()));

create or replace function public.replace_sales_line_items_window(
  p_window_start date,
  p_window_end date,
  p_rows jsonb
)
returns table(
  sync_run_id uuid,
  row_count integer,
  window_start date,
  window_end date,
  completed_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_count integer;
  v_inserted integer;
  v_sync_run_id uuid := gen_random_uuid();
  v_refreshed_at timestamptz;
  v_completed_at timestamptz;
begin
  if not (select public.sales_line_items_is_sync_writer()) then
    raise exception 'sync writer required';
  end if;
  if p_window_start is null or p_window_end is null or p_window_end < p_window_start then
    raise exception 'invalid replacement window';
  end if;
  if (p_window_end - p_window_start) > 31 then
    raise exception 'replacement window exceeds 31 days';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'sales line payload must be a non-empty array';
  end if;

  -- Concurrent calls are serialized before either transaction changes production rows.
  perform pg_advisory_xact_lock(hashtextextended('public.sales_line_items.atomic_refresh', 0));

  create temporary table staged_sales_line_items on commit drop as
  select * from jsonb_to_recordset(p_rows) as x(
    source_key uuid,
    bill_no text,
    bill_type text,
    sale_date date,
    item_key text,
    item_name text,
    qty numeric,
    unit_price numeric,
    line_total numeric,
    unit_cost numeric,
    net_profit numeric,
    customer_name text,
    unit2_name text,
    unit2_factor numeric
  );

  select count(*) into v_count from pg_temp.staged_sales_line_items;
  if v_count <> jsonb_array_length(p_rows) then
    raise exception 'payload row count mismatch';
  end if;
  if exists (
    select 1 from pg_temp.staged_sales_line_items s
    where s.source_key is null
       or nullif(btrim(s.bill_no), '') is null
       or nullif(btrim(s.item_key), '') is null
       or nullif(btrim(s.item_name), '') is null
       or s.sale_date is null
       or s.qty is null
       or s.unit_price is null
       or s.line_total is null
  ) then
    raise exception 'required sales line field is missing';
  end if;
  if exists (
    select s.source_key
    from pg_temp.staged_sales_line_items s
    group by s.source_key
    having count(*) > 1
  ) then
    raise exception 'duplicate source_key in payload';
  end if;
  if exists (
    select 1 from pg_temp.staged_sales_line_items s
    where s.bill_type not in ('retail', 'wholesale')
  ) then
    raise exception 'unsupported bill_type in payload';
  end if;
  if exists (
    select 1 from pg_temp.staged_sales_line_items s
    where s.sale_date < p_window_start or s.sale_date > p_window_end
  ) then
    raise exception 'sale_date is outside replacement window';
  end if;
  if exists (
    select 1 from pg_temp.staged_sales_line_items s
    where s.qty = 'NaN'::numeric
       or s.unit_price = 'NaN'::numeric
       or s.line_total = 'NaN'::numeric
       or s.unit_cost = 'NaN'::numeric
       or s.net_profit = 'NaN'::numeric
       or s.unit2_factor = 'NaN'::numeric
  ) then
    raise exception 'non-finite numeric value in payload';
  end if;

  -- Negative qty values are deliberately preserved: they are part of the
  -- existing signed-quantity contract and are not treated as invalid rows.
  v_refreshed_at := clock_timestamp();

  delete from public.sales_line_items s
  where s.sale_date >= p_window_start
    and s.sale_date <= p_window_end;

  insert into public.sales_line_items (
    source_key, bill_no, bill_type, sale_date, item_key, item_name, qty,
    unit_price, line_total, unit_cost, net_profit, customer_name,
    created_at, unit2_name, unit2_factor
  )
  select
    s.source_key, s.bill_no, s.bill_type, s.sale_date, s.item_key, s.item_name,
    s.qty, s.unit_price, s.line_total, s.unit_cost, s.net_profit,
    s.customer_name, v_refreshed_at, s.unit2_name, s.unit2_factor
  from pg_temp.staged_sales_line_items s;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_count then
    raise exception 'inserted row count mismatch';
  end if;

  v_completed_at := clock_timestamp();
  insert into public.sales_line_items_sync_state (
    source, sync_run_id, window_start, window_end, row_count,
    completed_at, completed_by
  ) values (
    'ameen_sales_line_items', v_sync_run_id, p_window_start, p_window_end,
    v_count, v_completed_at, (select auth.uid())
  )
  on conflict (source) do update set
    sync_run_id = excluded.sync_run_id,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    row_count = excluded.row_count,
    completed_at = excluded.completed_at,
    completed_by = excluded.completed_by;

  return query select
    v_sync_run_id, v_count, p_window_start, p_window_end, v_completed_at;
end;
$$;

revoke all on function public.replace_sales_line_items_window(date, date, jsonb)
  from public, anon, service_role;
grant execute on function public.replace_sales_line_items_window(date, date, jsonb)
  to authenticated;

commit;
