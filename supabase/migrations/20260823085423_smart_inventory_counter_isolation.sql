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
-- Why verify-or-skip (not draft DDL)
-- ----------------------------------
-- The superseded draft updates auth.users and deletes auth.sessions, then
-- loops CREATE POLICY across every RLS table and GRANTs other smart_inventory_*
-- RPCs. Re-running it against a live database would be unsafe, and inventing
-- partial DDL would misrepresent production schema.
--
-- Production already applied this version; CLI skips on Stage 2. Fresh DB /
-- CI replay has no active-migration definition of
-- smart_inventory_set_counter_auth_role(uuid) (only the non-applied superseded
-- draft defines it; supabase/smart-inventory.sql does not). Raising on absence
-- aborted clean replay before 20260830141802 bootstrap (Codex P1 on PR #228).
-- Therefore: verify landmark when present; no-op with NOTICE when absent
-- (fresh / out-of-band feature path). Operator bootstrap for smart inventory
-- remains via supabase/smart-inventory.sql — not this stamp's job.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regprocedure('public.smart_inventory_set_counter_auth_role(uuid)') is not null then
    raise notice 'smart_inventory_counter_isolation (20260823085423): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
  else
    raise notice 'smart_inventory_counter_isolation (20260823085423): landmark absent — treating as fresh-DB / out-of-band feature path; history placeholder no-op (will not invent DDL; draft re-apply unsafe: auth.users/sessions).';
  end if;
end;
$$;
