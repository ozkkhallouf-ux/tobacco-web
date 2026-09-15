-- History reconciliation for remote-only production version 20260826104745.
--
-- Production records this version (and a second related stamp 20260826133200).
-- Local draft: superseded/20260826094640_fix_ameen_read_requests_initplan_current_setting.sql
-- Exact production SQL for each stamp is NOT proven equal to that draft.
--
-- Name note: derived from the local draft basename. Confirm with
-- `supabase migration list` if the CLI reports a name mismatch.
--
-- Closes the remote-only history gap for Stage 2. Verify-or-skip (not draft
-- DDL): re-applying ALTER POLICY would require inventing which half of the
-- draft belonged to this stamp. Landmark when present; NOTICE no-op when
-- absent so fresh-DB replay is not aborted before later bootstrap stamps.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regclass('public.ameen_read_requests') is not null
     and exists (
       select 1 from pg_policies
       where schemaname = 'public'
         and tablename = 'ameen_read_requests'
         and policyname = 'ameen_read_worker_select'
     ) then
    raise notice 'fix_ameen_read_requests_initplan (20260826104745): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
  else
    raise notice 'fix_ameen_read_requests_initplan (20260826104745): landmark absent — treating as fresh-DB / out-of-band feature path; history placeholder no-op (will not invent DDL).';
  end if;
end;
$$;
