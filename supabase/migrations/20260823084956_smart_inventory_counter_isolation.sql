-- Keep inventory counter sessions on the public/anonymous database role so
-- they do not inherit the broad authenticated grants used by administration.
-- Counter RPCs remain protected by app_metadata, auth.uid() and auth.sessions.

create or replace function public.smart_inventory_set_counter_auth_role(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'service_role_only' using errcode = '42501';
  end if;

  update auth.users u
     set role = 'anon', updated_at = now()
   where u.id = p_user_id
     and exists (
       select 1
       from public.inventory_counter_accounts a
       where a.user_id = u.id
     );

  if not found then
    raise exception 'counter_account_not_found';
  end if;

  delete from auth.sessions where user_id = p_user_id;
end;
$$;

revoke all on function public.smart_inventory_set_counter_auth_role(uuid)
  from public, anon, authenticated;
grant execute on function public.smart_inventory_set_counter_auth_role(uuid)
  to service_role;

-- Immediately block any already-issued authenticated counter token from all
-- RLS-protected public tables. Other authenticated users keep their policies.
do $$
declare
  target record;
begin
  for target in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
  loop
    execute format('drop policy if exists deny_inventory_counter_access on %I.%I', target.schema_name, target.table_name);
    execute format(
      'create policy deny_inventory_counter_access on %I.%I as restrictive for all to authenticated using ((select lower(coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', ''''))) <> ''inventory_counter'') with check ((select lower(coalesce(auth.jwt() -> ''app_metadata'' ->> ''role'', ''''))) <> ''inventory_counter'')',
      target.schema_name,
      target.table_name
    );
  end loop;
end;
$$;

-- Existing internal accounts receive the least-privilege database role and
-- all pre-change sessions are revoked so the next login gets the new claim.
update auth.users u
   set role = 'anon', updated_at = now()
  from public.inventory_counter_accounts a
 where a.user_id = u.id;

delete from auth.sessions s
using public.inventory_counter_accounts a
where a.user_id = s.user_id;

-- Only the blind counting workflow is exposed to the counter JWT role.
grant execute on function
  public.smart_inventory_available_warehouses(date),
  public.smart_inventory_start_or_join(text),
  public.smart_inventory_counter_session(uuid),
  public.smart_inventory_claim_item(uuid),
  public.smart_inventory_save_item(uuid, uuid, text, numeric, numeric, numeric, bigint),
  public.smart_inventory_complete_session(uuid)
to anon;

-- Internal helpers are called by SECURITY DEFINER RPCs, never by clients.
revoke execute on function
  public.smart_inventory_has_live_session(),
  public.smart_inventory_is_owner(),
  public.smart_inventory_is_counter(),
  public.smart_inventory_actor_name()
from anon, authenticated;
