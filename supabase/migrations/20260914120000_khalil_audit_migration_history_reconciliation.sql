-- Reconciliation / traceability note — NOT a functional migration.
--
-- Context: a read-only security audit (2026-09-14) found that the local git
-- migration history for the khalil_audit_* subsystem diverges from what is
-- actually applied on production, and that the existing tracking document
-- (supabase/migrations/superseded/README.md) contained two incorrect
-- timestamp mappings. This file documents the corrected facts. It does not
-- change any table, policy, grant, or data, and it does not attempt to
-- recreate or backfill the historical migration that is missing from git.
--
-- Findings (verified via `supabase migration list` and live catalog reads,
-- not assumed):
--
--   1. The production migration named `khalil_audit_log`, applied at
--      timestamp 20260830141802, created the khalil_audit_* tables that are
--      live today (khalil_audit_events, khalil_audit_cursor,
--      khalil_audit_notify_failures, khalil_audit_sync_heartbeat) and their
--      supporting functions. This migration was applied directly (e.g. via
--      SQL Editor) and was NEVER committed to this repository under that
--      timestamp or any other. It is not a rename or deletion of any git
--      file — it simply has no git-tracked counterpart.
--
--   2. `supabase/migrations/superseded/20260830140000_khalil_audit_log.sql`
--      is a separate local draft that was iterated on through many later
--      "Codex round N" commits but was never applied to production. Its SQL
--      content is NOT proven to match what actually ran as 20260830141802 —
--      the two should not be treated as the same migration under different
--      timestamps. The superseded README table has been corrected
--      accordingly (see that file's 2026-09-14 note).
--
--   3. The superseded README also incorrectly mapped the
--      `expense_entries_owner_only_rls.sql` draft to production timestamp
--      20260830144806 (actually `khalil_audit_notify_catch_query_canceled`,
--      unrelated). The correct production migration for that name is
--      20260830172655. Corrected in the same README update.
--
--   4. Two later, git-committed (non-superseded) migrations —
--      20260902050000_khalil_audit_tables_explicit_deny.sql and
--      20260902080000_p2_heartbeat_rls_initplan.sql — are still pending
--      application to production as of this reconciliation. They are
--      unchanged by this file and are expected to be applied through the
--      normal migration pipeline in a later, separate step.
--
-- This migration intentionally contains no DDL, DML, GRANT/REVOKE, or
-- policy changes, and does not set FORCE ROW LEVEL SECURITY on anything.
-- The DO block below only performs read-only catalog lookups (to_regclass /
-- to_regproc) to confirm, at apply time, that the objects this note refers
-- to still exist — it changes no state either way.

do $$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.khalil_audit_events') is null then
    v_missing := array_append(v_missing, 'table public.khalil_audit_events');
  end if;

  if to_regclass('public.khalil_audit_cursor') is null then
    v_missing := array_append(v_missing, 'table public.khalil_audit_cursor');
  end if;

  if to_regclass('public.khalil_audit_notify_failures') is null then
    v_missing := array_append(v_missing, 'table public.khalil_audit_notify_failures');
  end if;

  if to_regclass('public.khalil_audit_sync_heartbeat') is null then
    v_missing := array_append(v_missing, 'table public.khalil_audit_sync_heartbeat');
  end if;

  if to_regproc('public.record_khalil_audit_event') is null then
    v_missing := array_append(v_missing, 'function public.record_khalil_audit_event');
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'khalil_audit_migration_history_reconciliation: expected live objects are missing: %',
      array_to_string(v_missing, ', ');
  end if;

  raise notice 'khalil_audit_migration_history_reconciliation: all referenced khalil_audit_* objects verified present (read-only check, no state changed).';
end;
$$;
