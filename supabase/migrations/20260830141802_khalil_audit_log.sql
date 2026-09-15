-- History reconciliation placeholder — NOT the original production DDL.
--
-- Production already records this exact version + name:
--   version: 20260830141802
--   name:    khalil_audit_log
-- confirmed via `supabase migration list` (read-only audit 2026-09-14).
--
-- Why this file exists
-- --------------------
-- The original SQL was applied to production directly (e.g. SQL Editor) and was
-- never committed under this timestamp. Without a matching local file, Supabase
-- CLI treats `20260830141802` as a remote-only history entry and STOPS on
-- remote/local history mismatch. `supabase db push --include-all` does NOT fix
-- that case — it only includes local migrations missing from the remote history
-- table (see supabase db push docs). Closing this gap is a prerequisite before
-- Stage 2 / `--include-all` can run for the still-pending 09-02 migrations.
--
-- What this file is NOT
-- ---------------------
-- - NOT a recreation of the unknown production DDL.
-- - NOT a copy of superseded/20260830140000_khalil_audit_log.sql (that local
--   draft is unproven as equivalent — see superseded/README.md).
-- - NOT permission to invent CREATE TABLE / policies / grants for objects that
--   already exist on production.
--
-- Attribution (do not expand)
-- ---------------------------
-- The live migration named khalil_audit_log created only the BASE objects
-- (commit e2a81a6): khalil_audit_events, khalil_audit_cursor, and
-- record_khalil_audit_event. Later tables khalil_audit_sync_heartbeat
-- (bf3e26d) and khalil_audit_notify_failures (77e9f47) are independent and are
-- NOT claimed as part of this version.
--
-- Apply behavior
-- --------------
-- On production, CLI should see the version as already applied and skip this
-- file. The DO block below is intentionally read-only (catalog lookups only):
-- no DDL, DML, GRANT/REVOKE, policy changes, or FORCE ROW LEVEL SECURITY.
-- If this file is ever applied against a database that lacks the base objects,
-- it raises rather than inventing schema.

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

  -- Non-ambiguous existence check: to_regproc() on a bare overloaded name
  -- raises "function ... is not unique" instead of returning NULL. Confirm at
  -- least one public.record_khalil_audit_event overload via catalog read.
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'record_khalil_audit_event'
  ) then
    v_missing := array_append(v_missing, 'function public.record_khalil_audit_event');
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'khalil_audit_log history placeholder (20260830141802): expected base objects are missing: %',
      array_to_string(v_missing, ', ');
  end if;

  raise notice 'khalil_audit_log history placeholder (20260830141802): base khalil_audit objects verified present (read-only, no state changed).';
end;
$$;
