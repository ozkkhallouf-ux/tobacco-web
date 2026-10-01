set local lock_timeout = '3s';
set local statement_timeout = '60s';
do $guard$
begin
  if md5(pg_get_viewdef('public.available_price_sync_feed'::regclass, true)) <> 'd1a6f656b0c4a154fcc5e788c5052778'
     or md5(pg_get_viewdef('public.approved_price_sync_feed'::regclass, true)) <> 'b9921c686f2215006808678cdfca508f' then
    raise exception 'GUARD: view definitions drifted from tested state';
  end if;
  if to_regnamespace('price_feed_private') is not null then
    raise exception 'GUARD: price_feed_private already exists';
  end if;
  if (select count(*) from pg_attribute where attrelid = 'public.available_price_sync_feed'::regclass and attnum > 0 and not attisdropped) <> 14 then
    raise exception 'GUARD: available_price_sync_feed column set changed';
  end if;
end $guard$;
create temp table _pf_snap on commit drop as
select md5(coalesce(string_agg(t::text, '|' order by item_key), '')) avail_md5, count(*) avail_n
  from public.available_price_sync_feed t;
alter table _pf_snap add column appr_md5 text, add column appr_n bigint;
update _pf_snap set (appr_md5, appr_n) =
  (select md5(coalesce(string_agg(t::text, '|' order by item_key), '')), count(*) from public.approved_price_sync_feed t);
grant select on _pf_snap to anon, service_role;
create schema if not exists price_feed_private;
revoke all on schema price_feed_private from public;
grant usage on schema price_feed_private to anon, authenticated, service_role;
create or replace function price_feed_private.available_price_rows()
returns table (
  item_key text, item_name text, sale_price numeric, unit1_price numeric,
  unit1_name text, unit2_name text, unit2_factor numeric, unit2_price numeric,
  retail_carton_usd numeric, updated_at timestamptz, bulletin_note text,
  stock_qty numeric, stock_status text, source_synced_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.item_key, p.item_name, p.sale_price, p.unit1_price,
         p.unit1_name, p.unit2_name, p.unit2_factor, p.unit2_price,
         ((p.price_payload -> 'retail') ->> 'price')::numeric,
         p.updated_at, p.notes,
         p.stock_qty, p.stock_status, p.source_synced_at
  from public.approved_price_items as p
  where coalesce(p.stock_qty, 0) > 0
$fn$;
revoke all on function price_feed_private.available_price_rows() from public;
grant execute on function price_feed_private.available_price_rows() to anon, authenticated, service_role;
create or replace view public.available_price_sync_feed
with (security_invoker = on) as
select * from price_feed_private.available_price_rows();
revoke all on public.available_price_sync_feed from anon, authenticated;
grant select on public.available_price_sync_feed to anon, authenticated;
alter view public.approved_price_sync_feed set (security_invoker = on);
revoke all on public.approved_price_sync_feed from anon, authenticated;
comment on view public.available_price_sync_feed is
  'نشرة أسعار عامة (المخزون الموجب فقط). security_invoker=on؛ البيانات من price_feed_private.available_price_rows() فقط، ولا صلاحية لـanon على approved_price_items.';
comment on view public.approved_price_sync_feed is
  'مصدر أنبوب الأسعار إلى الأمين (pull-approved-prices.ps1 بـservice_role). security_invoker=on، بلا قراءة لـanon/authenticated.';
do $verify$
declare
  s record; v_md5 text; v_n bigint; v_err text;
begin
  select * into s from _pf_snap;
  if (select coalesce(array_to_string(reloptions, ','), '') from pg_class where oid = 'public.available_price_sync_feed'::regclass) <> 'security_invoker=on'
     or (select coalesce(array_to_string(reloptions, ','), '') from pg_class where oid = 'public.approved_price_sync_feed'::regclass) <> 'security_invoker=on' then
    raise exception 'VERIFY: security_invoker not set on both views';
  end if;
  if has_table_privilege('anon', 'public.approved_price_sync_feed', 'select')
     or has_table_privilege('authenticated', 'public.approved_price_sync_feed', 'select')
     or not has_table_privilege('anon', 'public.available_price_sync_feed', 'select')
     or not has_table_privilege('authenticated', 'public.available_price_sync_feed', 'select')
     or has_table_privilege('anon', 'public.available_price_sync_feed', 'insert,update,delete,truncate,references,trigger')
     or has_table_privilege('authenticated', 'public.available_price_sync_feed', 'insert,update,delete,truncate,references,trigger')
     or not has_table_privilege('service_role', 'public.approved_price_sync_feed', 'select') then
    raise exception 'VERIFY: view grants not as designed';
  end if;
  if not exists (select 1 from pg_proc p
                  where p.oid = 'price_feed_private.available_price_rows()'::regprocedure
                    and p.prosecdef and p.provolatile = 's' and p.pronargs = 0
                    and p.proowner = 'postgres'::regrole
                    and p.proconfig = array['search_path=""'])
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = 'price_feed_private.available_price_rows()'::regprocedure and a.grantee = 0)
     or has_schema_privilege('anon', 'price_feed_private', 'create')
     or (select count(*) from pg_class where relnamespace = 'price_feed_private'::regnamespace) <> 0
     or (select count(*) from pg_proc where pronamespace = 'price_feed_private'::regnamespace) <> 1 then
    raise exception 'VERIFY: private function/schema not as designed';
  end if;
  if (select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum)
        from pg_attribute where attrelid = 'public.available_price_sync_feed'::regclass and attnum > 0 and not attisdropped)
     <> 'item_key:text,item_name:text,sale_price:numeric,unit1_price:numeric,unit1_name:text,unit2_name:text,unit2_factor:numeric,unit2_price:numeric,retail_carton_usd:numeric,updated_at:timestamp with time zone,bulletin_note:text,stock_qty:numeric,stock_status:text,source_synced_at:timestamp with time zone'
     or (select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum)
        from pg_attribute where attrelid = 'public.approved_price_sync_feed'::regclass and attnum > 0 and not attisdropped)
     <> 'item_key:text,item_name:text,sale_price:numeric,unit1_price:numeric,unit1_name:text,unit2_name:text,unit2_factor:numeric,unit2_price:numeric,retail_carton_usd:numeric,updated_at:timestamp with time zone,bulletin_note:text' then
    raise exception 'VERIFY: column contract changed';
  end if;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
  select md5(coalesce(string_agg(t::text, '|' order by item_key), '')), count(*) into v_md5, v_n from public.available_price_sync_feed t;
  if v_md5 <> s.avail_md5 or v_n <> s.avail_n then
    perform set_config('role', 'none', true);
    raise exception 'VERIFY: anon available parity failed (% vs %)', v_n, s.avail_n;
  end if;
  begin
    perform 1 from public.approved_price_sync_feed limit 1;
    v_err := 'allowed';
  exception when insufficient_privilege then v_err := 'denied';
  end;
  if v_err <> 'denied' then
    perform set_config('role', 'none', true);
    raise exception 'VERIFY: anon can still read approved_price_sync_feed';
  end if;
  select count(*) into v_n from public.approved_price_items;
  if v_n <> 0 then
    perform set_config('role', 'none', true);
    raise exception 'VERIFY: anon sees % base rows', v_n;
  end if;
  perform set_config('role', 'service_role', true);
  select md5(coalesce(string_agg(t::text, '|' order by item_key), '')), count(*) into v_md5, v_n from public.approved_price_sync_feed t;
  if v_md5 <> s.appr_md5 or v_n <> s.appr_n then
    perform set_config('role', 'none', true);
    raise exception 'VERIFY: service_role approved parity failed (% vs %)', v_n, s.appr_n;
  end if;
  select md5(coalesce(string_agg(t::text, '|' order by item_key), '')), count(*) into v_md5, v_n from public.available_price_sync_feed t;
  if v_md5 <> s.avail_md5 or v_n <> s.avail_n then
    perform set_config('role', 'none', true);
    raise exception 'VERIFY: service_role available parity failed';
  end if;
  perform set_config('role', 'none', true);
end $verify$;