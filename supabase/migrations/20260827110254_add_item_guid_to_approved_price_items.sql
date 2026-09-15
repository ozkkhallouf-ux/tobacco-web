-- يضيف item_guid (GUID الأمين الحقيقي) إلى approved_price_items كي تحتفظ لائحة الأسعار
-- بمفتاح مطابقة متوسط التكلفة الحي (item_costs) دون انتظار مهمة الـsnapshot المجدولة.
--
-- ============================================================
-- Codex P1 (PR #228, 2026-09-15): fresh-DB prerequisite
-- ============================================================
-- On a genuinely fresh database that applies only supabase/migrations/,
-- this stamp previously ran ALTER TABLE against a relation that never
-- existed in active history — CREATE TABLE lived only in out-of-band
-- supabase/approved-prices-table.sql. That aborted clean replay before
-- audit bootstrap 20260830141802.
--
-- Fix: provision the baseline table (derived from approved-prices-table.sql,
-- columns + indexes + RLS enable; staff policies only when is_staff() exists)
-- with IF NOT EXISTS, then apply the original idempotent item_guid ADD.
-- Production Stage 2: this version is already recorded → CLI skips the file.
-- No DROP. No refuse-if-exists abort. No invented columns beyond that file.
-- ============================================================

-- Baseline from supabase/approved-prices-table.sql (fresh path / IF NOT EXISTS).
-- Omits that file's refuse-if-exists barrier (unsafe for migration replay) and
-- its hard is_staff() prerequisite exception — policies deferred when helper
-- absent (same pattern as heartbeat SELECT on 20260830141802).
create table if not exists public.approved_price_items (
  id                uuid          primary key default gen_random_uuid(),
  item_key          text          unique not null,
  item_name         text          not null,
  -- رقمان مختلفان من بطاقة صنف الأمين — انظر approved-prices-item-code.sql:
  --   item_code   = mt000.Code   (كود البطاقة الذي يقرأه المالك: 0000، 1111، 24007)
  --   item_number = mt000.Number (الترقيم الداخلي التسلسلي)
  item_code         text,
  item_number       text,
  sale_price        numeric       default 0,
  unit1_price       numeric       default 0,
  unit1_name        text          default '',
  unit2_name        text          default '',
  unit2_factor      numeric       default 1,
  unit2_price       numeric       default 0,
  stock_qty         numeric       default 0,
  stock_status      text          default 'active',
  source_report_id  text,
  source_synced_at  timestamptz,
  price_payload     jsonb         default '{}',
  notes             text          default '',
  approved_by       uuid,
  approved_at       timestamptz   default now(),
  updated_at        timestamptz   default now()
);

alter table public.approved_price_items enable row level security;

do $policies$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise notice
      'add_item_guid_to_approved_price_items (20260827110254): public.is_staff() absent — baseline table created; staff RLS policies deferred (RLS enabled = deny-by-default). Out-of-band staff_allowlist / is_staff() remains required for full price UI access.';
    return;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'approved_price_items'
      and policyname = 'approved_price_items_staff_select'
  ) then
    create policy "approved_price_items_staff_select" on public.approved_price_items
      for select to authenticated using (is_staff());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'approved_price_items'
      and policyname = 'approved_price_items_staff_insert'
  ) then
    create policy "approved_price_items_staff_insert" on public.approved_price_items
      for insert to authenticated with check (is_staff());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'approved_price_items'
      and policyname = 'approved_price_items_staff_update'
  ) then
    create policy "approved_price_items_staff_update" on public.approved_price_items
      for update to authenticated using (is_staff()) with check (is_staff());
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'approved_price_items'
      and policyname = 'approved_price_items_staff_delete'
  ) then
    create policy "approved_price_items_staff_delete" on public.approved_price_items
      for delete to authenticated using (is_staff());
  end if;
end;
$policies$;

create index if not exists idx_item_key on public.approved_price_items(item_key);
create index if not exists idx_item_name on public.approved_price_items(item_name);
create index if not exists idx_item_code on public.approved_price_items(item_code);

-- Original stamp body (idempotent column + partial index).
alter table public.approved_price_items add column if not exists item_guid text;
create index if not exists idx_approved_price_items_item_guid on public.approved_price_items(item_guid) where item_guid is not null;
