-- إثبات تشغيلي لهجرة إعادة العد الجماعية على قاعدة مؤقتة محلية فقط.
-- يُنشئها scripts/check-smart-inventory-bulk-recount.mjs ويحذفها بعد الاختبار.
-- يرفض أي قاعدة غير ozk_bulk_recount_test، ويرفض شكل الإنتاج (وجود ameen_warehouse_stock_reports).

\set ON_ERROR_STOP on

do $$
begin
  if current_database() is distinct from 'ozk_bulk_recount_test' then
    raise exception 'bulk recount test refuses database %', current_database();
  end if;
  if to_regclass('public.ameen_warehouse_stock_reports') is not null then
    raise exception 'refusing: production shape detected';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;

-- نفس أعمدة الجداول المستخدمة من supabase/smart-inventory.sql (الأعمدة غير المستعملة محذوفة).
create table public.smart_inventory_sessions (
  id uuid primary key, inventory_date date not null, warehouse_key text not null, warehouse_name text not null,
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  reopened_by uuid references auth.users(id), reopened_at timestamptz, reopen_reason text,
  updated_at timestamptz not null default now(), unique (inventory_date, warehouse_key));
create table public.smart_inventory_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  item_key text not null, item_guid text, item_code text, item_name text not null,
  count_state text not null default 'uncounted' check (count_state in ('uncounted','counted','zero','not_found','damaged')),
  actual_qty_unit1 numeric(18,3), counted_by uuid references auth.users(id),
  recount_requested boolean not null default false, recount_requested_at timestamptz,
  recount_requested_by uuid references auth.users(id), recount_reason text,
  claimed_by uuid references auth.users(id), claimed_by_display_name text, claimed_at timestamptz, claim_expires_at timestamptz,
  row_version bigint not null default 0, updated_at timestamptz not null default now(), unique (session_id, item_key));
create table public.smart_inventory_audit_log (
  id bigint generated always as identity primary key,
  session_id uuid references public.smart_inventory_sessions(id) on delete cascade,
  item_id uuid references public.smart_inventory_items(id) on delete cascade,
  action text not null, actor_user_id uuid references auth.users(id), actor_display_name text not null,
  before_data jsonb, after_data jsonb, reason text, created_at timestamptz not null default now());

create or replace function public.smart_inventory_is_owner() returns boolean language sql stable as $$
  select lower(coalesce(auth.jwt()->'app_metadata'->>'role',''))='owner' $$;
create or replace function public.smart_inventory_actor_name() returns text language sql stable as $$
  select 'المالك' $$;

\ir ../migrations/20261031190000_smart_inventory_owner_bulk_recount.sql

insert into auth.users values ('00000000-0000-4000-8000-0000000000a1'),('00000000-0000-4000-8000-0000000000c1'),('00000000-0000-4000-8000-0000000000c2');
insert into public.smart_inventory_sessions(id,inventory_date,warehouse_key,warehouse_name,status) values
  ('10000000-0000-4000-8000-000000000001','2026-10-31','W1','مركز','completed'),
  ('10000000-0000-4000-8000-000000000002','2026-10-31','W2','دوما الاحتياطي','in_progress'),
  ('10000000-0000-4000-8000-000000000003','2026-10-31','W3','دوما الأساسي','completed'),
  ('10000000-0000-4000-8000-000000000004','2026-10-30','W1','مركز','completed');
-- G1 معدود بالأولى والثالثة، غير معدود بالثانية. G2 معدود بالأولى ومفتوح لإعادة العد سابقاً بالثانية.
-- G3 خارج القائمة. G1 بتاريخ آخر لا يُمس. الثالثة: G1 فيها معدود فتُفتح.
insert into public.smart_inventory_items(session_id,item_key,item_guid,item_code,item_name,count_state,actual_qty_unit1,counted_by,recount_requested,claimed_by) values
  ('10000000-0000-4000-8000-000000000001','A_G1','G1','001','غلواز','counted',10,'00000000-0000-4000-8000-0000000000c1',false,null),
  ('10000000-0000-4000-8000-000000000001','B_G2','G2','002','اوسكار','zero',0,'00000000-0000-4000-8000-0000000000c1',false,null),
  ('10000000-0000-4000-8000-000000000001','C_G3','G3','003','روز','counted',5,'00000000-0000-4000-8000-0000000000c1',false,null),
  ('10000000-0000-4000-8000-000000000002','A_G1','G1','001','غلواز','uncounted',null,null,false,'00000000-0000-4000-8000-0000000000c2'),
  ('10000000-0000-4000-8000-000000000002','B_G2','G2','002','اوسكار','counted',3,'00000000-0000-4000-8000-0000000000c2',true,null),
  ('10000000-0000-4000-8000-000000000003','A_G1','G1','001','غلواز','not_found',0,'00000000-0000-4000-8000-0000000000c2',false,'00000000-0000-4000-8000-0000000000c1'),
  ('10000000-0000-4000-8000-000000000004','A_G1','G1','001','غلواز','counted',7,'00000000-0000-4000-8000-0000000000c1',false,null);

-- غير المالك مرفوض.
select set_config('request.jwt.claims','{"app_metadata":{"role":"inventory_counter"}}',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000c1',false);
do $$ begin
  begin perform public.smart_inventory_owner_bulk_recount('2026-10-31',array['G1'],'سبب كاف'); raise exception 'counter must be rejected';
  exception when insufficient_privilege then null; end;
  begin perform public.smart_inventory_owner_day_items('2026-10-31'); raise exception 'counter must be rejected (day items)';
  exception when insufficient_privilege then null; end;
end $$;

select set_config('request.jwt.claims','{"app_metadata":{"role":"owner"}}',false);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000a1',false);

do $$ declare v jsonb; begin
  begin perform public.smart_inventory_owner_bulk_recount('2026-10-31',array['G1'],'  '); raise exception 'reason must be required';
  exception when others then if sqlerrm<>'reason_required' then raise; end if; end;
  begin perform public.smart_inventory_owner_bulk_recount('2026-10-31',array[' ',''],'سبب كاف'); raise exception 'items must be required';
  exception when others then if sqlerrm<>'items_required' then raise; end if; end;

  v:=public.smart_inventory_owner_day_items('2026-10-31');
  if jsonb_array_length(v->'items')<>3 then raise exception 'day items: expected 3 got %', v; end if;
  if (select (x->>'sessions')::int from jsonb_array_elements(v->'items') x where x->>'itemRef'='G1')<>3 then raise exception 'G1 sessions'; end if;

  v:=public.smart_inventory_owner_bulk_recount('2026-10-31',array['G1','G2','G1','MISSING'],'إعادة عد جماعية');
  if (v->>'opened')::int<>3 then raise exception 'opened: expected 3 got %', v; end if;
  if (v->>'reopenedSessions')::int<>2 then raise exception 'reopened: expected 2 got %', v; end if;
  if (v->>'notFound')::int<>1 then raise exception 'notFound: expected 1 got %', v; end if;
  if jsonb_array_length(v->'warehouses')<>3 then raise exception 'warehouses: %', v; end if;
end $$;

do $$ begin
  -- معدود ⇒ إعادة عد، ويُلغى الحجز، وتبقى الكمية والجارد الأصلي كما هما.
  if exists (select 1 from public.smart_inventory_items i join public.smart_inventory_sessions s on s.id=i.session_id
     where s.inventory_date='2026-10-31' and i.item_guid in ('G1','G2') and i.count_state<>'uncounted' and not i.recount_requested) then
    raise exception 'every counted selected item must be in recount'; end if;
  if (select actual_qty_unit1 from public.smart_inventory_items where session_id='10000000-0000-4000-8000-000000000001' and item_guid='G1')<>10 then
    raise exception 'quantity must stay'; end if;
  if (select counted_by from public.smart_inventory_items where session_id='10000000-0000-4000-8000-000000000001' and item_guid='G1')<>'00000000-0000-4000-8000-0000000000c1' then
    raise exception 'original counter must stay (blind recount by another counter)'; end if;
  if (select claimed_by from public.smart_inventory_items where session_id='10000000-0000-4000-8000-000000000003' and item_guid='G1') is not null then
    raise exception 'claim must be cleared'; end if;
  -- غير المعدود لا يُمس (يبقى غير معدود وحجزه باقٍ).
  if (select recount_requested or claimed_by is null from public.smart_inventory_items where session_id='10000000-0000-4000-8000-000000000002' and item_guid='G1') then
    raise exception 'uncounted row must be untouched'; end if;
  -- المفتوح سابقاً لا يُكتب فوقه.
  if (select row_version from public.smart_inventory_items where session_id='10000000-0000-4000-8000-000000000002' and item_guid='G2')<>0 then
    raise exception 'already-open recount must be untouched'; end if;
  -- خارج القائمة وتاريخ آخر لا يُمسّان.
  if (select recount_requested from public.smart_inventory_items where item_guid='G3') then raise exception 'G3 must be untouched'; end if;
  if (select recount_requested from public.smart_inventory_items where session_id='10000000-0000-4000-8000-000000000004') then raise exception 'other date must be untouched'; end if;
  if (select status from public.smart_inventory_sessions where id='10000000-0000-4000-8000-000000000004')<>'completed' then raise exception 'other date session must stay completed'; end if;
  -- الجلسات المكتملة التي فيها إعادة عد مختارة تُفتح بالسبب.
  if exists (select 1 from public.smart_inventory_sessions where inventory_date='2026-10-31' and status<>'in_progress') then
    raise exception 'completed sessions with selected recount must reopen'; end if;
  if (select reopen_reason from public.smart_inventory_sessions where id='10000000-0000-4000-8000-000000000001')<>'إعادة عد جماعية' then
    raise exception 'reopen reason must be recorded'; end if;
  if (select count(*) from public.smart_inventory_audit_log where action='recount_opened' and (after_data->>'bulk')::boolean)<>3 then
    raise exception 'one recount audit row per opened item'; end if;
  if (select count(*) from public.smart_inventory_audit_log where action='session_reopened')<>2 then
    raise exception 'one reopen audit row per reopened session'; end if;
end $$;

-- إعادة التشغيل بنفس القائمة لا تفتح شيئاً جديداً ولا تكرر التدقيق.
do $$ declare v jsonb; begin
  v:=public.smart_inventory_owner_bulk_recount('2026-10-31',array['G1','G2'],'إعادة عد جماعية');
  if (v->>'opened')::int<>0 or (v->>'reopenedSessions')::int<>0 then raise exception 'rerun must be a no-op: %', v; end if;
end $$;

-- إعادة عد عالقة بجلسة مغلقة (كما حدث 2026-10-31) تُفتح جلستها حين تُختار المادة.
update public.smart_inventory_sessions set status='completed' where id='10000000-0000-4000-8000-000000000002';
do $$ declare v jsonb; begin
  v:=public.smart_inventory_owner_bulk_recount('2026-10-31',array['G2'],'فك العالق');
  if (v->>'opened')::int<>0 or (v->>'reopenedSessions')::int<>1 then raise exception 'stuck recount must reopen its session: %', v; end if;
  if (select status from public.smart_inventory_sessions where id='10000000-0000-4000-8000-000000000002')<>'in_progress' then raise exception 'stuck session must reopen'; end if;
end $$;

-- صلاحيات: لا anon ولا PUBLIC على دوال المالك الجديدة.
do $$ begin
  if has_function_privilege('anon','public.smart_inventory_owner_bulk_recount(date,text[],text)','execute') then raise exception 'anon must not execute bulk recount'; end if;
  if has_function_privilege('anon','public.smart_inventory_owner_day_items(date)','execute') then raise exception 'anon must not execute day items'; end if;
  if not has_function_privilege('authenticated','public.smart_inventory_owner_bulk_recount(date,text[],text)','execute') then raise exception 'authenticated owner needs bulk recount'; end if;
end $$;

select 'BULK_RECOUNT_TEST_OK';
