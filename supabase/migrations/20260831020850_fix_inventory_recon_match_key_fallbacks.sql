-- History reconciliation for remote-only production version 20260831020850.
--
-- Production records this version (applied before the local commit timestamp;
-- see superseded/README.md). Local draft:
-- superseded/20260831051500_fix_inventory_recon_match_key_fallbacks.sql
-- Exact production SQL is NOT proven byte-for-byte equal to that draft.
--
-- Name note: derived from the local draft basename. Confirm with
-- `supabase migration list` if the CLI reports a name mismatch.
--
-- Closes the remote-only history gap for Stage 2. Verify-or-skip: the draft is a
-- CREATE OR REPLACE of inventory_recon_create_session_with_lines; re-applying
-- an unproven body against production would be unsafe. Fresh DB coverage for
-- this function also exists in supabase/inventory-reconciliation-table.sql.
-- Absent landmark → NOTICE no-op so clean replay is not aborted.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regprocedure(
    'public.inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb)'
  ) is not null then
    raise notice 'fix_inventory_recon_match_key_fallbacks (20260831020850): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
  else
    raise notice 'fix_inventory_recon_match_key_fallbacks (20260831020850): landmark absent — treating as fresh-DB / out-of-band feature path; history placeholder no-op (will not invent DDL).';
  end if;
end;
$$;
