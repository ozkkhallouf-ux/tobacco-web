-- History reconciliation for remote-only production version 20260826104745.
--
-- Production records this version (and a second related stamp 20260826133200).
-- Local draft: superseded/20260826094640_fix_ameen_read_requests_initplan_current_setting.sql
-- Exact production SQL for each stamp is NOT proven equal to that draft.
--
-- Name note: derived from the local draft basename. Confirm with
-- `supabase migration list` if the CLI reports a name mismatch.
--
-- This file closes the remote-only history gap for Stage 2. It does not
-- re-apply ALTER POLICY (would require inventing which half of the draft
-- belonged to this stamp). Landmark: table + worker select policy exist.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regclass('public.ameen_read_requests') is null then
    raise exception 'fix_ameen_read_requests_initplan (20260826104745): table public.ameen_read_requests is missing — history placeholder will not invent DDL.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ameen_read_requests'
      and policyname = 'ameen_read_worker_select'
  ) then
    raise exception 'fix_ameen_read_requests_initplan (20260826104745): policy ameen_read_worker_select is missing — history placeholder will not invent DDL.';
  end if;

  raise notice 'fix_ameen_read_requests_initplan (20260826104745): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
end;
$$;
