-- History reconciliation for remote-only production version 20260823085423.
--
-- Production records this version (superseded/README.md mapping from local draft
-- 20260823084956_smart_inventory_counter_isolation.sql). Exact production SQL
-- Editor content is NOT proven byte-for-byte equal to that draft and is NOT
-- claimed here.
--
-- Name note: local draft basename used as the migration name. Confirm with
-- `supabase migration list` if the CLI reports a name mismatch.
--
-- Why this stamp provisions the counter-role RPC (Codex P1, 2026-09-15)
-- --------------------------------------------------------------------
-- An earlier verify-or-skip placeholder recorded this version while leaving
-- `public.smart_inventory_set_counter_auth_role(uuid)` absent on fresh DBs.
-- `supabase/functions/inventory-auth/index.ts` calls that exact RPC during
-- counter create/enable and returns 500 (deleting the new account) when it
-- is missing. `supabase/smart-inventory.sql` historically did not define it
-- either (now also carries the same function-only baseline).
--
-- Safe baseline only (verbatim from superseded/20260823084956_…sql L5–36):
-- CREATE OR REPLACE the SECURITY DEFINER RPC + service_role-only EXECUTE.
-- Deliberately NOT re-applied from the draft: auth.users bulk rewrites for
-- every counter, restrictive policy loops across every RLS table, or GRANTs
-- on other smart_inventory_* RPCs — those remain unsafe / incomplete without
-- the rest of the feature bootstrap and must not be invented here.
--
-- Production Stage 2: CLI skips this file (version already recorded).
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

-- Counter auth-role RPC baseline (fresh path). Source: superseded draft L5–36.
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

do $$
begin
  if to_regprocedure('public.smart_inventory_set_counter_auth_role(uuid)') is not null then
    raise notice 'smart_inventory_counter_isolation (20260823085423): smart_inventory_set_counter_auth_role(uuid) baseline present — stamp complete (function-only from superseded draft; not a claim of byte-for-byte equivalence with original production SQL Editor apply; full counter isolation policies remain out-of-band via smart-inventory bootstrap).';
  else
    raise exception 'smart_inventory_counter_isolation (20260823085423): failed to provision smart_inventory_set_counter_auth_role(uuid)';
  end if;
end;
$$;
