-- Run only in a disposable Supabase test project after smart-inventory.sql.
-- These assertions document the required REST/RPC authorization contract.
begin;

do $$
begin
  if has_table_privilege('authenticated','public.smart_inventory_expectations','select') then
    raise exception 'authenticated must not SELECT expected quantities directly';
  end if;
  if has_table_privilege('authenticated','public.smart_inventory_items','update') then
    raise exception 'authenticated must not overwrite count rows through REST';
  end if;
  if has_table_privilege('authenticated','public.inventory_counter_accounts','select') then
    raise exception 'counter account mapping must not be readable through REST';
  end if;
  if has_table_privilege('anon','public.smart_inventory_sessions','select') then
    raise exception 'anonymous users must not read inventory sessions';
  end if;
end $$;

-- Runtime integration cases to execute with two real Auth test users:
-- 1. inventory_counter A and B claim the same item; expired claim may be replaced.
-- 2. A and B save the same uncounted row concurrently; exactly one returns saved,
--    the other returns already_counted and never overwrites counted_by/count.
-- 3. A and B save different rows concurrently; both succeed.
-- 4. A cannot update smart_inventory_items through REST or send counted_by.
-- 5. A cannot call smart_inventory_owner_report/open_recount/reopen_session.
-- 6. Owner can open recount with a reason; primary counter cannot perform it,
--    B can save a blind recount, and both attempts remain in count_attempts.
-- 7. Delete auth.sessions for A; A's unexpired JWT is rejected by every counter RPC.
-- 8. Disable A in inventory_counter_accounts; A's current session is rejected.
-- 9. Empty quantity is not persisted as zero; explicit state=zero with qty=0 is.
rollback;
