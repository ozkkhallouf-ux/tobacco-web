-- History reconciliation for remote-only production version 20260831185634.
--
-- Production records this version (superseded/README.md mapping from local draft
-- 20260831120000_telegram_delivery_observability.sql). Exact production SQL is
-- NOT proven byte-for-byte equal to that draft and is NOT claimed here.
--
-- Name note: derived from the local draft basename. Confirm with
-- `supabase migration list` if the CLI reports a name mismatch.
--
-- Closes the remote-only history gap for Stage 2. Verify-only landmark:
-- telegram_outbox.net_request_id (also present in supabase/telegram-notifications.sql
-- and later 20260914120000). Re-applying the draft's CREATE OR REPLACE of
-- dispatch_telegram_outbox with an unproven body would be unsafe on production.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regclass('public.telegram_outbox') is null then
    raise exception 'telegram_delivery_observability (20260831185634): table public.telegram_outbox is missing — history placeholder will not invent DDL.';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'telegram_outbox'
      and column_name = 'net_request_id'
  ) then
    raise exception 'telegram_delivery_observability (20260831185634): column public.telegram_outbox.net_request_id is missing — history placeholder will not invent DDL.';
  end if;

  raise notice 'telegram_delivery_observability (20260831185634): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
end;
$$;
