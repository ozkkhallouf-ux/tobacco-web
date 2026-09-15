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
--      timestamp 20260830141802, created only the BASE khalil_audit objects:
--      khalil_audit_events, khalil_audit_cursor, and
--      record_khalil_audit_event (per commit e2a81a6, "سجل تدقيق غير قابل
--      للتعديل لعمليات خليل"). This migration was applied directly (e.g. via
--      SQL Editor). The original SQL Editor DDL was never committed under this
--      timestamp. The repository now carries
--      `20260830141802_khalil_audit_log.sql` which:
--        (a) matches the production version/name so CLI history aligns; and
--        (b) provides *fresh-DB bootstrap* DDL derived from the local
--            superseded draft so clean migration replay does not abort here
--            (Codex P1). Byte-for-byte equivalence with the original production
--            apply is NOT proven and is NOT claimed. If somehow executed
--            against a DB that already has the base objects, a guard refuses
--            re-apply (history-safe).
--
--      khalil_audit_sync_heartbeat and khalil_audit_notify_failures are NOT
--      attributed to commit e2a81a6 — git history shows they were designed
--      later and independently, on the same local draft file
--      (superseded/20260830140000_khalil_audit_log.sql):
--        - khalil_audit_sync_heartbeat: added per commit bf3e26d ("heartbeat
--          مخصص"), moving khalil's heartbeat off the shared inventory_reports
--          table into its own table with sync-writer-only RLS.
--        - khalil_audit_notify_failures: added per commit 77e9f47 ("notify
--          failsafe table"), an independent failsafe table plus a
--          pg_cron-driven retry function.
--      Live catalog checks confirm both tables exist on production. Whether
--      they were applied as part of 20260830141802 or as separate, unrecorded
--      SQL Editor changes is NOT established. The fresh-bootstrap path of
--      `20260830141802_khalil_audit_log.sql` includes them so later active
--      migrations and the sync agent can run on a clean database — that is a
--      replay bootstrap choice, not a forensic claim about the original apply.
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
--   4. Two earlier, git-committed (non-superseded) migrations —
--      20260902050000_khalil_audit_tables_explicit_deny.sql and
--      20260902080000_p2_heartbeat_rls_initplan.sql — are still pending
--      application to production as of this reconciliation. They are
--      unchanged by this file.
--
--      IMPORTANT — migration ordering / operator warning (EN + AR):
--
--      PREREQUISITE (remote-only history): `--include-all` only includes
--      local migrations missing from the remote history table; it does NOT
--      reconcile the inverse (remote version missing locally) and the CLI
--      still stops on that mismatch. EVERY known remote-only version listed
--      in superseded/README.md now has a matching local file (verify-or-skip
--      landmarks for non-audit stamps — NOTICE no-op on fresh DB when the
--      landmark is absent, so clean replay is not aborted; bootstrap+
--      refuse-if-present for `20260830141802_khalil_audit_log.sql`). Confirm
--      with `supabase migration list` before Stage 2 / `--include-all`. If an
--      unconfirmed *name* mismatches, rename only the name segment.
--
--      This reconciliation file is timestamped 20260915140000, which is
--      chronologically AFTER both pending 09-02 files AND after
--      20260914120000 / 20260914130000 already on main (and typically
--      already recorded on production history).
--
--      When production ALREADY has a later stamp such as 20260914130000,
--      a plain `supabase db push` will NOT pull in the older pending
--      09-02 migrations merely because this 09-15 file sorts later.
--      Supabase CLI skips out-of-order pending migrations unless you pass
--      `--include-all` ("Include all migrations not found on remote
--      history table" — see supabase db push docs).
--
--      Therefore, AFTER the remote-only prerequisite above is satisfied,
--      operators MUST do ONE of the following before/when applying this
--      reconciliation to a remote that already has later stamps:
--        (A) Apply the separately approved 09-02 migrations first
--            (Stage 2 — explicit owner approval), then push this file; OR
--        (B) Use `supabase db push --include-all` so the pending 09-02
--            migrations are included alongside (or before) this file.
--
--      Arabic / تحذير للمشغّل:
--      شرط مسبق: العلم `--include-all` لا يغلق فجوات remote-only (يعالج
--      المهاجرات المحلية الناقصة من السجل البعيد فقط). كل طابع بعيد-فقط
--      معروف في superseded/README.md له الآن ملف محلي مطابق على هذا الفرع.
--      راجع `supabase migration list` قبل المرحلة ٢ / `--include-all`.
--      عند اختلاف الاسم فقط: أعد تسمية جزء الاسم مع الإبقاء على الإصدار.
--
--      بعد إغلاق فجوة remote-only: إذا كان الإنتاج يملك أصلاً طابعاً لاحقاً
--      مثل `20260914130000`، فإن `supabase db push` العادي لن يطبّق
--      مهاجرات 09-02 المعلّقة لمجرد أن ملف التسوية هذا (09-15) يرتّب
--      بعدهما زمنياً. يجب إما:
--        (أ) تطبيق مهاجرات 09-02 المعتمدة بشكل منفصل أولاً، ثم دفع هذا
--            الملف؛ أو
--        (ب) استخدام `supabase db push --include-all` لإدراج كل
--            المهاجرات غير الموجودة في سجل الإنتاج البعيد.
--
--      This note does not authorize, trigger, or assume that push —
--      applying the two 09-02 migrations to production remains a
--      separate, explicitly-approved step (Stage 2). It is called out
--      here only so no reader mistakes this file's later timestamp for
--      evidence that the pending migrations already ran, will run
--      "after" it, or will be picked up automatically by a plain push.
--
-- This migration intentionally contains no DDL, DML, GRANT/REVOKE, or
-- policy changes, and does not set FORCE ROW LEVEL SECURITY on anything.
-- The DO block below only performs read-only catalog lookups (to_regclass,
-- and a pg_proc/pg_namespace existence check instead of the ambiguous
-- to_regproc('public.record_khalil_audit_event') — that function has had
-- multiple historical overloads in the local draft history, and
-- to_regproc() raises a hard "not unique" error for an overloaded name
-- rather than resolving it) to confirm, at apply time, that the objects
-- this note refers to still exist — it changes no state either way.

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

  -- Non-ambiguous existence check: a plain to_regproc() on a bare name
  -- raises "function ... is not unique" (a hard error, not NULL) if more
  -- than one overload exists. This function has had several historical
  -- overloads in local draft history, so its exact live signature is not
  -- assumed here — we only confirm at least one overload named
  -- record_khalil_audit_event exists in public, via a direct catalog read.
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
    raise exception 'khalil_audit_migration_history_reconciliation: expected live objects are missing: %',
      array_to_string(v_missing, ', ');
  end if;

  raise notice 'khalil_audit_migration_history_reconciliation: all referenced khalil_audit_* objects verified present (read-only check, no state changed).';
end;
$$;
