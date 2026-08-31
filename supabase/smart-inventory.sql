-- Smart inventory counting for OZK TOBACCO.
-- Reference migration only: do not apply automatically to production.
-- Ameen remains authoritative. This schema records blind physical counts and
-- comparisons only; it contains no path that writes stock adjustments to Ameen.

begin;

create extension if not exists pgcrypto;

create table if not exists public.inventory_counter_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username_normalized text not null unique,
  username_display text not null,
  display_name text not null,
  auth_email text not null unique,
  enabled boolean not null default true,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  device_lock_enabled boolean not null default false,
  registered_device_hash text,
  credential_version bigint not null default 1,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_by uuid references auth.users(id)
);

create table if not exists public.smart_inventory_settings (
  singleton boolean primary key default true check (singleton),
  daily_cutoff time not null default time '23:00',
  claim_minutes integer not null default 2 check (claim_minutes between 1 and 15),
  large_difference_threshold numeric(18,3) not null default 10 check (large_difference_threshold >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
insert into public.smart_inventory_settings(singleton) values (true) on conflict do nothing;

create table if not exists public.smart_inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  inventory_date date not null,
  warehouse_key text not null,
  warehouse_name text not null,
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  cutoff_at timestamptz not null,
  source_report_id uuid not null references public.ameen_warehouse_stock_reports(id),
  source_report_created_at timestamptz not null,
  total_items integer not null default 0 check (total_items >= 0),
  created_by uuid not null references auth.users(id),
  created_by_display_name text not null,
  created_at timestamptz not null default now(),
  completed_by uuid references auth.users(id),
  completed_by_display_name text,
  completed_at timestamptz,
  reopened_by uuid references auth.users(id),
  reopened_at timestamptz,
  reopen_reason text,
  updated_at timestamptz not null default now(),
  unique (inventory_date, warehouse_key)
);

create table if not exists public.smart_inventory_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  item_key text not null,
  item_guid text,
  item_code text,
  item_name text not null,
  shelf_location text,
  sort_index integer not null default 0,
  unit1_name text not null default 'الوحدة الأولى',
  unit2_name text,
  unit2_factor numeric(18,6) not null default 1 check (unit2_factor > 0),
  count_state text not null default 'uncounted' check (count_state in ('uncounted','counted','zero','not_found','damaged')),
  unit1_qty numeric(18,3),
  unit2_qty numeric(18,3),
  damaged_unit1_qty numeric(18,3),
  actual_qty_unit1 numeric(18,3),
  counted_by uuid references auth.users(id),
  counted_by_display_name text,
  counted_at timestamptz,
  recount_requested boolean not null default false,
  recount_requested_at timestamptz,
  recount_requested_by uuid references auth.users(id),
  recount_reason text,
  recount_completed_at timestamptz,
  recount_completed_by uuid references auth.users(id),
  claimed_by uuid references auth.users(id),
  claimed_by_display_name text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  row_version bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (session_id, item_key),
  check (unit1_qty is null or unit1_qty >= 0),
  check (unit2_qty is null or unit2_qty >= 0),
  check (damaged_unit1_qty is null or damaged_unit1_qty >= 0),
  check (actual_qty_unit1 is null or actual_qty_unit1 >= 0)
);

-- Expected quantities are structurally separated from the employee-readable
-- item table. No counter RPC ever joins or returns this table.
create table if not exists public.smart_inventory_expectations (
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  item_id uuid not null references public.smart_inventory_items(id) on delete cascade,
  expected_qty_unit1 numeric(18,3) not null default 0,
  primary key (session_id, item_id)
);

create table if not exists public.smart_inventory_count_attempts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  item_id uuid not null references public.smart_inventory_items(id) on delete cascade,
  attempt_no integer not null check (attempt_no > 0),
  attempt_kind text not null check (attempt_kind in ('primary','recount','owner_correction')),
  count_state text not null check (count_state in ('counted','zero','not_found','damaged')),
  unit1_qty numeric(18,3) not null default 0 check (unit1_qty >= 0),
  unit2_qty numeric(18,3) not null default 0 check (unit2_qty >= 0),
  damaged_unit1_qty numeric(18,3) not null default 0 check (damaged_unit1_qty >= 0),
  actual_qty_unit1 numeric(18,3) not null check (actual_qty_unit1 >= 0),
  counted_by uuid not null references auth.users(id),
  counted_by_display_name text not null,
  counted_at timestamptz not null default now(),
  reason text,
  unique (item_id, attempt_no)
);

create table if not exists public.smart_inventory_participants (
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  display_name text not null,
  joined_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create table if not exists public.smart_inventory_movement_adjustments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  item_id uuid not null references public.smart_inventory_items(id) on delete cascade,
  movement_type text not null check (movement_type in ('sale','purchase','transfer_in','transfer_out','return','other')),
  movement_at timestamptz not null,
  signed_qty_unit1 numeric(18,3) not null,
  ameen_reference text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, item_id, movement_type, movement_at, ameen_reference)
);

create table if not exists public.smart_inventory_evidence (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.smart_inventory_sessions(id) on delete cascade,
  item_id uuid references public.smart_inventory_items(id) on delete cascade,
  storage_path text not null,
  source_type text not null default 'photo' check (source_type in ('photo','ocr','manual')),
  original_value jsonb,
  corrected_value jsonb,
  ocr_confidence numeric(5,4) check (ocr_confidence between 0 and 1),
  uploaded_by uuid not null references auth.users(id),
  uploaded_at timestamptz not null default now()
);

create table if not exists public.smart_inventory_audit_log (
  id bigint generated always as identity primary key,
  session_id uuid references public.smart_inventory_sessions(id) on delete cascade,
  item_id uuid references public.smart_inventory_items(id) on delete cascade,
  action text not null,
  actor_user_id uuid references auth.users(id),
  actor_display_name text not null,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_auth_rate_limits (
  key_hash text primary key,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  last_attempt_at timestamptz not null default now()
);

create index if not exists smart_inventory_items_session_sort_idx on public.smart_inventory_items(session_id, sort_index, item_name);
create index if not exists smart_inventory_items_claim_idx on public.smart_inventory_items(session_id, claim_expires_at) where count_state = 'uncounted';
create index if not exists smart_inventory_attempts_item_idx on public.smart_inventory_count_attempts(item_id, attempt_no desc);
create index if not exists smart_inventory_audit_session_idx on public.smart_inventory_audit_log(session_id, created_at desc);
create index if not exists smart_inventory_movements_item_idx on public.smart_inventory_movement_adjustments(item_id, movement_at);

alter table public.inventory_counter_accounts enable row level security;
alter table public.smart_inventory_settings enable row level security;
alter table public.smart_inventory_sessions enable row level security;
alter table public.smart_inventory_items enable row level security;
alter table public.smart_inventory_expectations enable row level security;
alter table public.smart_inventory_count_attempts enable row level security;
alter table public.smart_inventory_participants enable row level security;
alter table public.smart_inventory_movement_adjustments enable row level security;
alter table public.smart_inventory_evidence enable row level security;
alter table public.smart_inventory_audit_log enable row level security;
alter table public.inventory_auth_rate_limits enable row level security;

-- Browser roles get no direct table privileges. All access is through narrow RPCs.
revoke all on table public.inventory_counter_accounts, public.smart_inventory_settings,
  public.smart_inventory_sessions, public.smart_inventory_items, public.smart_inventory_expectations,
  public.smart_inventory_count_attempts, public.smart_inventory_participants,
  public.smart_inventory_movement_adjustments, public.smart_inventory_evidence,
  public.smart_inventory_audit_log, public.inventory_auth_rate_limits
from public, anon, authenticated;

create or replace function public.smart_inventory_has_live_session()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.sessions s
    where s.id = nullif(auth.jwt() ->> 'session_id','')::uuid
      and s.user_id = auth.uid()
  );
$$;

create or replace function public.smart_inventory_is_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role','')) = 'owner'
    and public.smart_inventory_has_live_session();
$$;

create or replace function public.smart_inventory_is_counter()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role','')) = 'inventory_counter'
    and public.smart_inventory_has_live_session()
    and exists (
      select 1 from public.inventory_counter_accounts a
      where a.user_id = auth.uid() and a.enabled
        and (a.locked_until is null or a.locked_until <= now())
    );
$$;

create or replace function public.smart_inventory_actor_name()
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select a.display_name from public.inventory_counter_accounts a where a.user_id = auth.uid()),
    nullif(auth.jwt() -> 'app_metadata' ->> 'display_name',''),
    'مستخدم OZK'
  );
$$;

revoke all on function public.smart_inventory_has_live_session(), public.smart_inventory_is_owner(),
  public.smart_inventory_is_counter(), public.smart_inventory_actor_name() from public, anon;
grant execute on function public.smart_inventory_has_live_session(), public.smart_inventory_is_owner(),
  public.smart_inventory_is_counter(), public.smart_inventory_actor_name() to authenticated, service_role;

create or replace function public.smart_inventory_available_warehouses(p_date date default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_date date := coalesce(p_date, (now() at time zone 'Asia/Beirut')::date); v_result jsonb;
begin
  if not (public.smart_inventory_is_counter() or public.smart_inventory_is_owner()) then raise exception 'forbidden' using errcode='42501'; end if;
  with latest as (
    select distinct on (r.summary ->> 'warehouseKey')
      r.id, r.created_at, r.summary, r.items
    from public.ameen_warehouse_stock_reports r
    where nullif(r.summary ->> 'warehouseKey','') is not null
    order by r.summary ->> 'warehouseKey', r.created_at desc
  ), rows as (
    select l.summary ->> 'warehouseKey' warehouse_key,
      l.summary ->> 'warehouseName' warehouse_name,
      l.created_at source_created_at,
      coalesce(jsonb_array_length(l.items),0) source_item_count,
      s.id session_id, s.status, s.cutoff_at, s.created_at, s.completed_at,
      coalesce((select count(*) from public.smart_inventory_items i where i.session_id=s.id and i.count_state <> 'uncounted'),0) counted_items,
      coalesce((select jsonb_agg(distinct p.display_name) from public.smart_inventory_participants p where p.session_id=s.id),'[]'::jsonb) contributors
    from latest l
    left join public.smart_inventory_sessions s on s.inventory_date=v_date and s.warehouse_key=l.summary ->> 'warehouseKey'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'warehouseKey',warehouse_key,'warehouseName',warehouse_name,'sourceCreatedAt',source_created_at,
    'totalItems',coalesce((select total_items from public.smart_inventory_sessions where id=session_id),source_item_count),
    'sessionId',session_id,'status',coalesce(status,'not_started'),'countedItems',counted_items,
    'cutoffAt',cutoff_at,'startedAt',created_at,'completedAt',completed_at,'contributors',contributors
  ) order by warehouse_name),'[]'::jsonb) into v_result from rows;
  return v_result;
end;
$$;

create or replace function public.smart_inventory_start_or_join(p_warehouse_key text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_date date := (now() at time zone 'Asia/Beirut')::date;
  v_report public.ameen_warehouse_stock_reports%rowtype;
  v_session public.smart_inventory_sessions%rowtype;
  v_id uuid; v_actor text := public.smart_inventory_actor_name(); v_new boolean := false;
begin
  if not (public.smart_inventory_is_counter() or public.smart_inventory_is_owner()) then raise exception 'forbidden' using errcode='42501'; end if;
  if nullif(trim(p_warehouse_key),'') is null then raise exception 'warehouse_required'; end if;
  perform pg_advisory_xact_lock(hashtext(v_date::text || ':' || p_warehouse_key));
  select r.* into v_report from public.ameen_warehouse_stock_reports r
   where r.summary ->> 'warehouseKey'=p_warehouse_key order by r.created_at desc limit 1;
  if v_report.id is null then raise exception 'warehouse_not_found'; end if;

  insert into public.smart_inventory_sessions(
    inventory_date,warehouse_key,warehouse_name,status,cutoff_at,source_report_id,
    source_report_created_at,total_items,created_by,created_by_display_name)
  values (v_date,p_warehouse_key,coalesce(v_report.summary->>'warehouseName',p_warehouse_key),'in_progress',
    coalesce(nullif(v_report.summary->>'generated_at','')::timestamptz,v_report.created_at),v_report.id,v_report.created_at,
    jsonb_array_length(v_report.items),auth.uid(),v_actor)
  on conflict (inventory_date,warehouse_key) do nothing returning id into v_id;

  if v_id is not null then
    v_new := true;
    insert into public.smart_inventory_items(
      session_id,item_key,item_guid,item_code,item_name,shelf_location,sort_index,unit1_name,unit2_name,unit2_factor)
    select v_id,
      coalesce(nullif(x.item->>'itemKey',''),nullif(x.item->>'itemGuid',''),nullif(x.item->>'itemNumber','')),
      nullif(x.item->>'itemGuid',''),coalesce(nullif(x.item->>'itemCode',''),nullif(x.item->>'itemNumber','')),
      coalesce(nullif(x.item->>'itemName',''),'صنف غير مسمى'),nullif(x.item->>'shelfLocation',''),x.ord::integer,
      coalesce(nullif(x.item->>'unit1Name',''),nullif(x.item->>'unitName',''),'الوحدة الأولى'),
      nullif(x.item->>'unit2Name',''),greatest(coalesce(nullif(x.item->>'unit2Factor','')::numeric,1),0.000001)
    from jsonb_array_elements(v_report.items) with ordinality x(item,ord)
    where coalesce(nullif(x.item->>'itemKey',''),nullif(x.item->>'itemGuid',''),nullif(x.item->>'itemNumber','')) is not null
    on conflict (session_id,item_key) do nothing;

    insert into public.smart_inventory_expectations(session_id,item_id,expected_qty_unit1)
    select v_id,i.id,coalesce(nullif(x.item->>'qty','')::numeric,nullif(x.item->>'stockQty','')::numeric,0)
    from jsonb_array_elements(v_report.items) with ordinality x(item,ord)
    join public.smart_inventory_items i on i.session_id=v_id and i.item_key=
      coalesce(nullif(x.item->>'itemKey',''),nullif(x.item->>'itemGuid',''),nullif(x.item->>'itemNumber',''))
    on conflict (session_id,item_id) do nothing;
    update public.smart_inventory_sessions set total_items=(select count(*) from public.smart_inventory_items where session_id=v_id)
      where id=v_id;
  else
    select * into v_session from public.smart_inventory_sessions s where s.inventory_date=v_date and s.warehouse_key=p_warehouse_key for update;
    v_id := v_session.id;
  end if;

  insert into public.smart_inventory_participants(session_id,user_id,display_name)
  values(v_id,auth.uid(),v_actor)
  on conflict(session_id,user_id) do update set display_name=excluded.display_name,last_activity_at=now();
  insert into public.smart_inventory_audit_log(session_id,action,actor_user_id,actor_display_name,after_data)
  values(v_id,case when v_new then 'session_started' else 'session_joined' end,auth.uid(),v_actor,jsonb_build_object('warehouseKey',p_warehouse_key));
  return public.smart_inventory_counter_session(v_id);
end;
$$;

create or replace function public.smart_inventory_counter_session(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_session public.smart_inventory_sessions%rowtype; v_items jsonb;
begin
  if not (public.smart_inventory_is_counter() or public.smart_inventory_is_owner()) then raise exception 'forbidden' using errcode='42501'; end if;
  select * into v_session from public.smart_inventory_sessions where id=p_session_id;
  if v_session.id is null then raise exception 'session_not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'itemKey',i.item_key,'itemGuid',i.item_guid,'itemCode',i.item_code,'itemName',i.item_name,
    'shelfLocation',i.shelf_location,'unit1Name',i.unit1_name,'unit2Name',i.unit2_name,'unit2Factor',i.unit2_factor,
    'countState',i.count_state,
    'unit1Qty',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.unit1_qty end,
    'unit2Qty',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.unit2_qty end,
    'damagedUnit1Qty',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.damaged_unit1_qty end,
    'actualQtyUnit1',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.actual_qty_unit1 end,
    'countedByDisplayName',i.counted_by_display_name,'countedAt',i.counted_at,
    'recountRequested',i.recount_requested,'recountCompletedAt',i.recount_completed_at,
    'claimedByDisplayName',case when i.claim_expires_at>now() then i.claimed_by_display_name else null end,
    'claimedByMe',case when i.claim_expires_at>now() then i.claimed_by=auth.uid() else false end,
    'claimExpiresAt',case when i.claim_expires_at>now() then i.claim_expires_at else null end,'rowVersion',i.row_version
  ) order by i.sort_index,i.item_name),'[]'::jsonb) into v_items
  from public.smart_inventory_items i where i.session_id=p_session_id;
  return jsonb_build_object('id',v_session.id,'inventoryDate',v_session.inventory_date,'warehouseKey',v_session.warehouse_key,
    'warehouseName',v_session.warehouse_name,'status',v_session.status,'cutoffAt',v_session.cutoff_at,
    'startedAt',v_session.created_at,'completedAt',v_session.completed_at,'totalItems',v_session.total_items,'items',v_items);
end;
$$;

create or replace function public.smart_inventory_claim_item(p_item_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_item public.smart_inventory_items%rowtype; v_session public.smart_inventory_sessions%rowtype;
  v_actor text:=public.smart_inventory_actor_name(); v_minutes integer;
begin
  if not public.smart_inventory_is_counter() then raise exception 'forbidden' using errcode='42501'; end if;
  select * into v_item from public.smart_inventory_items where id=p_item_id for update;
  if v_item.id is null then raise exception 'item_not_found'; end if;
  select * into v_session from public.smart_inventory_sessions where id=v_item.session_id;
  if v_session.status<>'in_progress' then return jsonb_build_object('ok',false,'code','session_closed'); end if;
  if v_item.count_state<>'uncounted' and not v_item.recount_requested then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  if v_item.recount_requested and v_item.counted_by=auth.uid() then
    return jsonb_build_object('ok',false,'code','recount_requires_other_counter');
  end if;
  if v_item.claim_expires_at>now() and v_item.claimed_by<>auth.uid() then
    return jsonb_build_object('ok',false,'code','claimed','claimedByDisplayName',v_item.claimed_by_display_name,'claimExpiresAt',v_item.claim_expires_at);
  end if;
  select claim_minutes into v_minutes from public.smart_inventory_settings where singleton;
  update public.smart_inventory_items set claimed_by=auth.uid(),claimed_by_display_name=v_actor,claimed_at=now(),
    claim_expires_at=now()+make_interval(mins=>coalesce(v_minutes,2)),updated_at=now()
    where id=p_item_id returning * into v_item;
  insert into public.smart_inventory_participants(session_id,user_id,display_name) values(v_item.session_id,auth.uid(),v_actor)
    on conflict(session_id,user_id) do update set last_activity_at=now(),display_name=excluded.display_name;
  return jsonb_build_object('ok',true,'code','claimed','claimExpiresAt',v_item.claim_expires_at,'claimedByDisplayName',v_actor);
end;
$$;

create or replace function public.smart_inventory_save_item(
  p_item_id uuid,p_request_id uuid,p_count_state text,p_unit1_qty numeric default 0,
  p_unit2_qty numeric default 0,p_damaged_unit1_qty numeric default 0,p_expected_version bigint default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_item public.smart_inventory_items%rowtype; v_session public.smart_inventory_sessions%rowtype;
  v_attempt public.smart_inventory_count_attempts%rowtype; v_actor text:=public.smart_inventory_actor_name();
  v_actual numeric; v_no integer; v_kind text;
begin
  if not public.smart_inventory_is_counter() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'request_id_required'; end if;
  select * into v_attempt from public.smart_inventory_count_attempts where request_id=p_request_id;
  if v_attempt.id is not null then return jsonb_build_object('ok',true,'code','saved','idempotent',true,'countedAt',v_attempt.counted_at); end if;
  if p_count_state not in ('counted','zero','not_found','damaged') then raise exception 'invalid_count_state'; end if;
  if coalesce(p_unit1_qty,0)<0 or coalesce(p_unit2_qty,0)<0 or coalesce(p_damaged_unit1_qty,0)<0 then raise exception 'negative_quantity'; end if;
  select * into v_item from public.smart_inventory_items where id=p_item_id for update;
  if v_item.id is null then raise exception 'item_not_found'; end if;
  select * into v_session from public.smart_inventory_sessions where id=v_item.session_id for share;
  if v_session.status<>'in_progress' then return jsonb_build_object('ok',false,'code','session_closed'); end if;
  if v_item.count_state<>'uncounted' and not v_item.recount_requested then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  if p_expected_version is not null and v_item.row_version<>p_expected_version then
    return jsonb_build_object('ok',false,'code','version_conflict','rowVersion',v_item.row_version);
  end if;
  if v_item.recount_requested and v_item.counted_by=auth.uid() then return jsonb_build_object('ok',false,'code','recount_requires_other_counter'); end if;
  if v_item.claim_expires_at>now() and v_item.claimed_by<>auth.uid() then
    return jsonb_build_object('ok',false,'code','claimed','claimedByDisplayName',v_item.claimed_by_display_name,'claimExpiresAt',v_item.claim_expires_at);
  end if;
  v_actual:=round(coalesce(p_unit1_qty,0)+coalesce(p_unit2_qty,0)*v_item.unit2_factor,3);
  if p_count_state in ('zero','not_found') and v_actual<>0 then raise exception 'zero_state_requires_zero'; end if;
  select coalesce(max(attempt_no),0)+1 into v_no from public.smart_inventory_count_attempts where item_id=p_item_id;
  v_kind:=case when v_item.recount_requested then 'recount' else 'primary' end;
  insert into public.smart_inventory_count_attempts(request_id,session_id,item_id,attempt_no,attempt_kind,count_state,
    unit1_qty,unit2_qty,damaged_unit1_qty,actual_qty_unit1,counted_by,counted_by_display_name)
  values(p_request_id,v_item.session_id,p_item_id,v_no,v_kind,p_count_state,coalesce(p_unit1_qty,0),coalesce(p_unit2_qty,0),
    coalesce(p_damaged_unit1_qty,0),v_actual,auth.uid(),v_actor) returning * into v_attempt;
  if v_kind='primary' then
    update public.smart_inventory_items set count_state=p_count_state,unit1_qty=coalesce(p_unit1_qty,0),unit2_qty=coalesce(p_unit2_qty,0),
      damaged_unit1_qty=coalesce(p_damaged_unit1_qty,0),actual_qty_unit1=v_actual,counted_by=auth.uid(),counted_by_display_name=v_actor,
      counted_at=v_attempt.counted_at,claimed_by=null,claimed_by_display_name=null,claimed_at=null,claim_expires_at=null,
      row_version=row_version+1,updated_at=now() where id=p_item_id;
  else
    update public.smart_inventory_items set recount_requested=false,recount_completed_at=v_attempt.counted_at,recount_completed_by=auth.uid(),
      claimed_by=null,claimed_by_display_name=null,claimed_at=null,claim_expires_at=null,row_version=row_version+1,updated_at=now() where id=p_item_id;
  end if;
  insert into public.smart_inventory_participants(session_id,user_id,display_name) values(v_item.session_id,auth.uid(),v_actor)
    on conflict(session_id,user_id) do update set last_activity_at=now(),display_name=excluded.display_name;
  insert into public.smart_inventory_audit_log(session_id,item_id,action,actor_user_id,actor_display_name,before_data,after_data)
  values(v_item.session_id,p_item_id,case when v_kind='primary' then 'item_counted' else 'item_recounted' end,auth.uid(),v_actor,
    jsonb_build_object('countState',v_item.count_state,'rowVersion',v_item.row_version),
    jsonb_build_object('countState',p_count_state,'unit1Qty',coalesce(p_unit1_qty,0),'unit2Qty',coalesce(p_unit2_qty,0),'actualQtyUnit1',v_actual,'attemptNo',v_no));
  return jsonb_build_object('ok',true,'code','saved','attemptKind',v_kind,'countedByDisplayName',v_actor,'countedAt',v_attempt.counted_at,'actualQtyUnit1',v_actual,'rowVersion',v_item.row_version+1);
exception when unique_violation then
  select * into v_attempt from public.smart_inventory_count_attempts where request_id=p_request_id;
  if v_attempt.id is not null then return jsonb_build_object('ok',true,'code','saved','idempotent',true,'countedAt',v_attempt.counted_at); end if;
  raise;
end;
$$;

create or replace function public.smart_inventory_complete_session(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.smart_inventory_sessions%rowtype; v_actor text:=public.smart_inventory_actor_name(); v_remaining integer;
begin
  if not (public.smart_inventory_is_counter() or public.smart_inventory_is_owner()) then raise exception 'forbidden' using errcode='42501'; end if;
  select * into v_session from public.smart_inventory_sessions where id=p_session_id for update;
  if v_session.id is null then raise exception 'session_not_found'; end if;
  if v_session.status='completed' then return jsonb_build_object('ok',true,'code','already_completed'); end if;
  select count(*) into v_remaining from public.smart_inventory_items where session_id=p_session_id and (count_state='uncounted' or recount_requested);
  if v_remaining>0 then return jsonb_build_object('ok',false,'code','items_remaining','remaining',v_remaining); end if;
  update public.smart_inventory_sessions set status='completed',completed_by=auth.uid(),completed_by_display_name=v_actor,
    completed_at=now(),updated_at=now() where id=p_session_id;
  insert into public.smart_inventory_audit_log(session_id,action,actor_user_id,actor_display_name)
  values(p_session_id,'session_completed',auth.uid(),v_actor);
  -- ملاحظة أمنية: يُستدعى هذا المسار مباشرة عبر RPC من مستخدم "counter" غير staff
  -- (التفويض محسوم أعلاه بـis_counter()/is_owner())، لذا نتجاوز بوابة public.notify_telegram
  -- (التي ترفض الآن المستخدم authenticated غير staff) وننادي الدالة الداخلية مباشرة.
  if to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)') is not null then
    perform private.notify_telegram_dispatch('inventory_complete',
      '✅ اكتمل جرد مستودع '||v_session.warehouse_name||' بواسطة '||v_actor,
      'smart-inventory-complete:'||p_session_id::text,1440,null::jsonb);
  end if;
  return jsonb_build_object('ok',true,'code','completed','completedAt',now());
end; $$;

create or replace function public.smart_inventory_owner_dashboard(p_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_date date:=coalesce(p_date,(now() at time zone 'Asia/Beirut')::date); v_cutoff time; v_now timestamp:=now() at time zone 'Asia/Beirut'; v_result jsonb;
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  select daily_cutoff into v_cutoff from public.smart_inventory_settings where singleton;
  with latest as (
    select distinct on (r.summary->>'warehouseKey') r.summary,r.items from public.ameen_warehouse_stock_reports r
    where nullif(r.summary->>'warehouseKey','') is not null order by r.summary->>'warehouseKey',r.created_at desc
  ), rows as (
    select l.summary->>'warehouseKey' warehouse_key,l.summary->>'warehouseName' warehouse_name,
      s.id session_id,s.status session_status,s.total_items session_total_items,s.created_at session_created_at,
      s.completed_at session_completed_at,s.completed_by_display_name,s.cutoff_at,
      coalesce((select count(*) from public.smart_inventory_items i where i.session_id=s.id and i.count_state<>'uncounted'),0) counted_items,
      (select min(i.counted_at) from public.smart_inventory_items i where i.session_id=s.id) first_counted_at,
      (select max(greatest(i.counted_at,i.recount_completed_at)) from public.smart_inventory_items i where i.session_id=s.id) last_counted_at,
      coalesce((select jsonb_agg(jsonb_build_object('userId',p.user_id,'displayName',p.display_name,'joinedAt',p.joined_at,'lastActivityAt',p.last_activity_at) order by p.joined_at) from public.smart_inventory_participants p where p.session_id=s.id),'[]'::jsonb) contributors,
      coalesce(jsonb_array_length(l.items),0) report_total
    from latest l left join public.smart_inventory_sessions s on s.inventory_date=v_date and s.warehouse_key=l.summary->>'warehouseKey'
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'warehouseKey',warehouse_key,'warehouseName',warehouse_name,'sessionId',session_id,
    'status',case when session_id is null and v_date=(now() at time zone 'Asia/Beirut')::date and v_now::time>v_cutoff then 'late' when session_id is null then 'not_started'
      when session_status='completed' then 'completed' when v_date=(now() at time zone 'Asia/Beirut')::date and v_now::time>v_cutoff then 'late' else 'in_progress' end,
    'countedItems',counted_items,'totalItems',coalesce(session_total_items,report_total),'firstCountedAt',first_counted_at,
    'lastCountedAt',last_counted_at,'startedAt',session_created_at,'completedAt',session_completed_at,'completedByDisplayName',completed_by_display_name,
    'cutoffAt',cutoff_at,'contributors',contributors
  ) order by warehouse_name),'[]'::jsonb) into v_result from rows;
  return v_result;
end; $$;

create or replace function public.smart_inventory_owner_report(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.smart_inventory_sessions%rowtype; v_lines jsonb; v_audit jsonb; v_threshold numeric;
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  select * into v_session from public.smart_inventory_sessions where id=p_session_id;
  if v_session.id is null then raise exception 'session_not_found'; end if;
  select large_difference_threshold into v_threshold from public.smart_inventory_settings where singleton;
  with attempt_latest as (
    select distinct on (a.item_id) a.* from public.smart_inventory_count_attempts a where a.session_id=p_session_id order by a.item_id,a.attempt_no desc
  ), movement as (
    select m.item_id,coalesce(sum(m.signed_qty_unit1),0) movement_qty,jsonb_agg(jsonb_build_object('type',m.movement_type,'qty',m.signed_qty_unit1,'at',m.movement_at,'reference',m.ameen_reference) order by m.movement_at) movements
    from public.smart_inventory_movement_adjustments m where m.session_id=p_session_id and m.movement_at>=v_session.cutoff_at group by m.item_id
  ) select coalesce(jsonb_agg(jsonb_build_object(
    'itemId',i.id,'itemKey',i.item_key,'itemCode',i.item_code,'itemName',i.item_name,'shelfLocation',i.shelf_location,
    'unit1Name',i.unit1_name,'unit2Name',i.unit2_name,'unit2Factor',i.unit2_factor,'countState',i.count_state,
    'primaryQtyUnit1',i.actual_qty_unit1,'primaryCountedBy',i.counted_by_display_name,'primaryCountedAt',i.counted_at,
    'latestQtyUnit1',a.actual_qty_unit1,'latestCountState',a.count_state,'latestCountedBy',a.counted_by_display_name,'latestCountedAt',a.counted_at,
    'expectedQtyUnit1',e.expected_qty_unit1,'movementQtyUnit1',coalesce(m.movement_qty,0),
    'adjustedExpectedQtyUnit1',e.expected_qty_unit1+coalesce(m.movement_qty,0),
    'differenceQtyUnit1',case when a.id is null then null else a.actual_qty_unit1-(e.expected_qty_unit1+coalesce(m.movement_qty,0)) end,
    'classification',case when a.id is null then 'uncounted' when a.actual_qty_unit1=(e.expected_qty_unit1+coalesce(m.movement_qty,0)) then 'matched'
      when a.actual_qty_unit1>(e.expected_qty_unit1+coalesce(m.movement_qty,0)) then 'increase' else 'shortage' end,
    'largeDifference',case when a.id is null then false else abs(a.actual_qty_unit1-(e.expected_qty_unit1+coalesce(m.movement_qty,0)))>=v_threshold end,
    'recountRequested',i.recount_requested,'movements',coalesce(m.movements,'[]'::jsonb)
  ) order by i.sort_index,i.item_name),'[]'::jsonb) into v_lines
  from public.smart_inventory_items i join public.smart_inventory_expectations e on e.item_id=i.id and e.session_id=i.session_id
  left join attempt_latest a on a.item_id=i.id left join movement m on m.item_id=i.id where i.session_id=p_session_id;
  select coalesce(jsonb_agg(jsonb_build_object('action',l.action,'actor',l.actor_display_name,'before',l.before_data,'after',l.after_data,'reason',l.reason,'at',l.created_at) order by l.created_at desc),'[]'::jsonb)
    into v_audit from public.smart_inventory_audit_log l where l.session_id=p_session_id;
  return jsonb_build_object('id',v_session.id,'inventoryDate',v_session.inventory_date,'warehouseKey',v_session.warehouse_key,
    'warehouseName',v_session.warehouse_name,'status',v_session.status,'cutoffAt',v_session.cutoff_at,'sourceReportCreatedAt',v_session.source_report_created_at,
    'startedAt',v_session.created_at,'completedAt',v_session.completed_at,'lines',v_lines,'audit',v_audit);
end; $$;

create or replace function public.smart_inventory_owner_open_recount(p_item_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_item public.smart_inventory_items%rowtype; v_actor text:=public.smart_inventory_actor_name();
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'reason_required'; end if;
  select * into v_item from public.smart_inventory_items where id=p_item_id for update;
  if v_item.id is null or v_item.count_state='uncounted' then raise exception 'count_required'; end if;
  update public.smart_inventory_items set recount_requested=true,recount_requested_at=now(),recount_requested_by=auth.uid(),recount_reason=trim(p_reason),
    claimed_by=null,claimed_by_display_name=null,claimed_at=null,claim_expires_at=null,row_version=row_version+1,updated_at=now() where id=p_item_id;
  insert into public.smart_inventory_audit_log(session_id,item_id,action,actor_user_id,actor_display_name,before_data,after_data,reason)
    values(v_item.session_id,p_item_id,'recount_opened',auth.uid(),v_actor,jsonb_build_object('recountRequested',v_item.recount_requested),jsonb_build_object('recountRequested',true),trim(p_reason));
  return jsonb_build_object('ok',true,'code','recount_opened');
end; $$;

create or replace function public.smart_inventory_owner_reopen_session(p_session_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.smart_inventory_sessions%rowtype; v_actor text:=public.smart_inventory_actor_name();
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'reason_required'; end if;
  select * into v_session from public.smart_inventory_sessions where id=p_session_id for update;
  if v_session.id is null then raise exception 'session_not_found'; end if;
  if v_session.status<>'completed' then raise exception 'session_not_completed'; end if;
  update public.smart_inventory_sessions set status='in_progress',reopened_by=auth.uid(),reopened_at=now(),reopen_reason=trim(p_reason),updated_at=now() where id=p_session_id;
  insert into public.smart_inventory_audit_log(session_id,action,actor_user_id,actor_display_name,before_data,after_data,reason)
    values(p_session_id,'session_reopened',auth.uid(),v_actor,jsonb_build_object('status','completed'),jsonb_build_object('status','in_progress'),trim(p_reason));
  return jsonb_build_object('ok',true,'code','reopened');
end; $$;

create or replace function public.smart_inventory_owner_correct_item(p_item_id uuid,p_actual_qty_unit1 numeric,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_item public.smart_inventory_items%rowtype; v_session public.smart_inventory_sessions%rowtype;
  v_actor text:=public.smart_inventory_actor_name(); v_no integer; v_attempt public.smart_inventory_count_attempts%rowtype;
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'reason_required'; end if;
  if p_actual_qty_unit1 is null or p_actual_qty_unit1<0 then raise exception 'invalid_quantity'; end if;
  select * into v_item from public.smart_inventory_items where id=p_item_id for update;
  if v_item.id is null or v_item.count_state='uncounted' then raise exception 'count_required'; end if;
  select * into v_session from public.smart_inventory_sessions where id=v_item.session_id;
  if v_session.status<>'in_progress' then raise exception 'reopen_session_first'; end if;
  select coalesce(max(attempt_no),0)+1 into v_no from public.smart_inventory_count_attempts where item_id=p_item_id;
  insert into public.smart_inventory_count_attempts(request_id,session_id,item_id,attempt_no,attempt_kind,count_state,
    unit1_qty,unit2_qty,damaged_unit1_qty,actual_qty_unit1,counted_by,counted_by_display_name,reason)
  values(gen_random_uuid(),v_item.session_id,p_item_id,v_no,'owner_correction',case when p_actual_qty_unit1=0 then 'zero' else 'counted' end,
    p_actual_qty_unit1,0,0,p_actual_qty_unit1,auth.uid(),v_actor,trim(p_reason)) returning * into v_attempt;
  update public.smart_inventory_items set recount_requested=false,recount_completed_at=v_attempt.counted_at,recount_completed_by=auth.uid(),
    row_version=row_version+1,updated_at=now() where id=p_item_id;
  insert into public.smart_inventory_audit_log(session_id,item_id,action,actor_user_id,actor_display_name,before_data,after_data,reason)
  values(v_item.session_id,p_item_id,'owner_correction',auth.uid(),v_actor,
    jsonb_build_object('primaryQtyUnit1',v_item.actual_qty_unit1),jsonb_build_object('correctedQtyUnit1',p_actual_qty_unit1,'attemptNo',v_no),trim(p_reason));
  return jsonb_build_object('ok',true,'code','corrected','attemptNo',v_no);
end; $$;

-- Service-role helpers used only by the inventory-auth Edge Function.
create or replace function public.smart_inventory_auth_preflight(p_key_hash text,p_username text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rate public.inventory_auth_rate_limits%rowtype; v_account public.inventory_counter_accounts%rowtype;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'service_role_only' using errcode='42501'; end if;
  insert into public.inventory_auth_rate_limits(key_hash) values(p_key_hash) on conflict do nothing;
  select * into v_rate from public.inventory_auth_rate_limits where key_hash=p_key_hash for update;
  select * into v_account from public.inventory_counter_accounts where username_normalized=p_username;
  return jsonb_build_object('allowed',coalesce(v_rate.locked_until<=now(),true) and coalesce(v_account.locked_until<=now(),true) and coalesce(v_account.enabled,false),
    'userId',v_account.user_id,'lockedUntil',greatest(v_rate.locked_until,v_account.locked_until),'deviceLockEnabled',coalesce(v_account.device_lock_enabled,false),
    'registeredDeviceHash',v_account.registered_device_hash);
end; $$;

-- Lock decision as a pure, side-effect-free function so every branch can be
-- asserted case by case (supabase/tests/inventory-auth-lockout-truth-table.sql).
-- An active lock is never extended: attempts made while locked verify no
-- credential, so counting them would turn the announced 15 minutes into an
-- unbounded lockout. An expired lock resets the counter, so waiting really does
-- restore a full attempt budget instead of re-locking on the next single typo.
do $$
begin
  if to_regtype('public.inventory_auth_lock_state') is null then
    create type public.inventory_auth_lock_state as (
      failed_attempts integer,
      locked_until timestamptz
    );
  end if;
end $$;

create or replace function public.smart_inventory_auth_lock_state(
  p_failed_attempts integer, p_locked_until timestamptz, p_now timestamptz)
returns public.inventory_auth_lock_state
language sql immutable parallel safe set search_path = '' as $$
  select row(
    case
      when p_locked_until is not null and p_locked_until >  p_now then coalesce(p_failed_attempts, 0)
      when p_locked_until is not null and p_locked_until <= p_now then 1
      else coalesce(p_failed_attempts, 0) + 1
    end,
    case
      when p_locked_until is not null and p_locked_until >  p_now then p_locked_until
      when p_locked_until is not null and p_locked_until <= p_now then null
      when coalesce(p_failed_attempts, 0) + 1 >= 5 then p_now + interval '15 minutes'
      else null
    end
  )::public.inventory_auth_lock_state;
$$;

create or replace function public.smart_inventory_auth_record(p_key_hash text,p_username text,p_success boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := now(); v_state public.inventory_auth_lock_state;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'service_role_only' using errcode='42501'; end if;
  if p_success then
    update public.inventory_auth_rate_limits set failed_attempts=0,locked_until=null,last_attempt_at=v_now where key_hash=p_key_hash;
    update public.inventory_counter_accounts set failed_attempts=0,locked_until=null,updated_at=v_now where username_normalized=p_username;
    return;
  end if;
  select public.smart_inventory_auth_lock_state(r.failed_attempts,r.locked_until,v_now) into v_state
    from public.inventory_auth_rate_limits r where r.key_hash=p_key_hash for update;
  if found then
    update public.inventory_auth_rate_limits set failed_attempts=v_state.failed_attempts,
      locked_until=v_state.locked_until,last_attempt_at=v_now where key_hash=p_key_hash;
  end if;
  select public.smart_inventory_auth_lock_state(a.failed_attempts,a.locked_until,v_now) into v_state
    from public.inventory_counter_accounts a where a.username_normalized=p_username for update;
  if found then
    update public.inventory_counter_accounts set failed_attempts=v_state.failed_attempts,
      locked_until=v_state.locked_until,updated_at=v_now where username_normalized=p_username;
  end if;
end; $$;
create or replace function public.smart_inventory_revoke_user_sessions(p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'service_role_only' using errcode='42501'; end if;
  delete from auth.sessions where user_id=p_user_id;
end; $$;

create or replace function public.smart_inventory_has_session_for_service(p_session_id uuid,p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'service_role_only' using errcode='42501'; end if;
  return exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p_user_id);
end; $$;

-- Safe hook for the existing notification runner. It is deliberately not
-- scheduled by this migration; production scheduling remains a separate,
-- explicitly approved operation. Dedupe keys make repeated calls harmless.
create or replace function public.smart_inventory_enqueue_daily_summary()
returns void language plpgsql security definer set search_path = '' as $$
declare v_date date:=(now() at time zone 'Asia/Beirut')::date; v_cutoff time; v_total integer; v_started integer; v_completed integer; v_names text;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'service_role_only' using errcode='42501'; end if;
  if to_regprocedure('public.notify_telegram(text,text,text,integer,jsonb)') is null then return; end if;
  select daily_cutoff into v_cutoff from public.smart_inventory_settings where singleton;
  select count(distinct r.summary->>'warehouseKey') into v_total from public.ameen_warehouse_stock_reports r where nullif(r.summary->>'warehouseKey','') is not null;
  select count(*),count(*) filter(where status='completed') into v_started,v_completed from public.smart_inventory_sessions where inventory_date=v_date;
  select string_agg(distinct p.display_name,'، ') into v_names from public.smart_inventory_participants p join public.smart_inventory_sessions s on s.id=p.session_id where s.inventory_date=v_date;
  if (now() at time zone 'Asia/Beirut')::time >= v_cutoff and v_started<v_total then
    perform public.notify_telegram('inventory_late','⚠️ تأخر جرد '||(v_total-v_started)::text||' مستودع لليوم',
      'smart-inventory-late:'||v_date::text,720,null::jsonb);
  end if;
  perform public.notify_telegram('inventory_daily_summary',
    '📋 ملخص الجرد اليومي: بدأ '||v_started::text||' من '||v_total::text||'، مكتمل '||v_completed::text||coalesce(' — الموظفون: '||v_names,''),
    'smart-inventory-summary:'||v_date::text,720,null::jsonb);
end; $$;

revoke all on function public.smart_inventory_auth_preflight(text,text), public.smart_inventory_auth_record(text,text,boolean),
  public.smart_inventory_auth_lock_state(integer,timestamptz,timestamptz),
  public.smart_inventory_revoke_user_sessions(uuid),public.smart_inventory_has_session_for_service(uuid,uuid),
  public.smart_inventory_enqueue_daily_summary() from public,anon,authenticated;
grant execute on function public.smart_inventory_auth_preflight(text,text), public.smart_inventory_auth_record(text,text,boolean),
  public.smart_inventory_auth_lock_state(integer,timestamptz,timestamptz),
  public.smart_inventory_revoke_user_sessions(uuid),public.smart_inventory_has_session_for_service(uuid,uuid),
  public.smart_inventory_enqueue_daily_summary() to service_role;

revoke all on function public.smart_inventory_available_warehouses(date),public.smart_inventory_start_or_join(text),
 public.smart_inventory_counter_session(uuid),public.smart_inventory_claim_item(uuid),
 public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint),public.smart_inventory_complete_session(uuid),
 public.smart_inventory_owner_dashboard(date),public.smart_inventory_owner_report(uuid),
 public.smart_inventory_owner_open_recount(uuid,text),public.smart_inventory_owner_reopen_session(uuid,text),
 public.smart_inventory_owner_correct_item(uuid,numeric,text)
from public;
-- Counter sessions carry the least-privilege database role 'anon' (see migration
-- 20260823084956), so the six counting RPCs MUST stay granted to anon. Revoking
-- them from anon here once broke every counter on production while login itself
-- kept succeeding: the Edge Function signs in with service_role, then the page
-- dies on the first RPC. The identity guard is inside each function
-- (smart_inventory_is_counter/_is_owner: app_metadata role + a live auth.sessions
-- row + an enabled, unlocked account), never the grant — an anonymous visitor
-- holding only the publishable key still gets 'forbidden'.
grant execute on function public.smart_inventory_available_warehouses(date),public.smart_inventory_start_or_join(text),
 public.smart_inventory_counter_session(uuid),public.smart_inventory_claim_item(uuid),
 public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint),public.smart_inventory_complete_session(uuid)
to anon,authenticated;
-- Owner-only RPCs stay off the counter role entirely.
revoke execute on function public.smart_inventory_owner_dashboard(date),public.smart_inventory_owner_report(uuid),
 public.smart_inventory_owner_open_recount(uuid,text),public.smart_inventory_owner_reopen_session(uuid,text),
 public.smart_inventory_owner_correct_item(uuid,numeric,text)
from anon;
grant execute on function public.smart_inventory_owner_dashboard(date),public.smart_inventory_owner_report(uuid),
 public.smart_inventory_owner_open_recount(uuid,text),public.smart_inventory_owner_reopen_session(uuid,text),
 public.smart_inventory_owner_correct_item(uuid,numeric,text)
to authenticated;

comment on table public.smart_inventory_expectations is 'Owner-only Ameen snapshot quantities. Never returned by counter RPCs.';
comment on function public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint) is 'Atomic first-save-wins count. Identity is always auth.uid(); browser cannot set counted_by.';
comment on table public.smart_inventory_movement_adjustments is 'Read-only import of signed Ameen movements after cutoff; never writes any adjustment back to Ameen.';

commit;
