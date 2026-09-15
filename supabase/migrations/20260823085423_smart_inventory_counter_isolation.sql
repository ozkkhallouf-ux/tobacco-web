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
-- Why verify-only (not draft DDL)
-- -------------------------------
-- The superseded draft updates auth.users and deletes auth.sessions. Re-running
-- it against a live database would be unsafe. Production already applied this
-- version; CLI skips on Stage 2. This file only closes the remote-only history
-- gap and verifies a landmark. Fresh DB bootstrap for smart inventory remains
-- via supabase/smart-inventory.sql / operator process — not this stamp's job.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regprocedure('public.smart_inventory_set_counter_auth_role(uuid)') is null then
    raise exception 'smart_inventory_counter_isolation (20260823085423): landmark function public.smart_inventory_set_counter_auth_role(uuid) is missing — history placeholder will not invent DDL (draft re-apply unsafe: auth.users/sessions).';
  end if;

  raise notice 'smart_inventory_counter_isolation (20260823085423): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
end;
$$;
