-- History reconciliation for remote-only production version 20260826133200.
--
-- Production records this version as a second stamp related to the same local
-- draft superseded/20260826094640_fix_ameen_read_requests_initplan_current_setting.sql
-- (see superseded/README.md). The exact production name and SQL body for this
-- stamp alone are unknown — byte-for-byte equivalence is NOT claimed.
--
-- Name note: synthetic followup name used to match the version stamp only.
-- Confirm the live name with `supabase migration list`; rename the file's
-- name segment if the CLI reports a mismatch (version must stay 20260826133200).
--
-- Closes the remote-only history gap for Stage 2. Verify-or-skip landmark
-- shared with 20260826104745 (same feature surface). Absent landmark →
-- fresh-DB NOTICE no-op so clean replay continues.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regclass('public.ameen_read_requests') is not null
     and exists (
       select 1 from pg_policies
       where schemaname = 'public'
         and tablename = 'ameen_read_requests'
         and policyname = 'ameen_read_worker_update'
     ) then
    raise notice 'fix_ameen_read_requests_initplan_followup (20260826133200): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
  else
    raise notice 'fix_ameen_read_requests_initplan_followup (20260826133200): landmark absent — treating as fresh-DB / out-of-band feature path; history placeholder no-op (will not invent DDL).';
  end if;
end;
$$;
