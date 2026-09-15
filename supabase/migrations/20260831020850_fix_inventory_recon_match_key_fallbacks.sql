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
-- Closes the remote-only history gap for Stage 2. Verify-only: the draft is a
-- CREATE OR REPLACE of inventory_recon_create_session_with_lines; re-applying
-- an unproven body against production would be unsafe. Fresh DB coverage for
-- this function also exists in supabase/inventory-reconciliation-table.sql.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regprocedure(
    'public.inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb)'
  ) is null then
    raise exception 'fix_inventory_recon_match_key_fallbacks (20260831020850): landmark function inventory_recon_create_session_with_lines(...) is missing — history placeholder will not invent DDL.';
  end if;

  raise notice 'fix_inventory_recon_match_key_fallbacks (20260831020850): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
end;
$$;
