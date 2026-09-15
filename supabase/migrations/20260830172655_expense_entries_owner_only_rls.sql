-- History reconciliation for remote-only production version 20260830172655.
--
-- Production records:
--   version: 20260830172655
--   name:    expense_entries_owner_only_rls
-- (corrected mapping in superseded/README.md; local draft was
-- 20260830144330_expense_entries_owner_only_rls.sql).
-- Exact production SQL Editor content is NOT proven byte-for-byte equal to
-- that draft and is NOT claimed here.
--
-- Closes the remote-only history gap for Stage 2. Verify-or-skip: re-applying
-- the draft's DROP/CREATE policy sequence is unnecessary on production
-- (version already applied). Fresh DB owner RLS for expense_entries is also
-- covered by supabase/expense-entries-table.sql outside this stamp. Absent
-- landmark → NOTICE no-op so clean replay is not aborted.
--
-- No FORCE ROW LEVEL SECURITY. No migration repair. No production apply authorized.

do $$
begin
  if to_regclass('public.expense_entries') is not null
     and exists (
       select 1 from pg_policies
       where schemaname = 'public'
         and tablename = 'expense_entries'
         and policyname = 'expense_entries_owner_select'
     ) then
    raise notice 'expense_entries_owner_only_rls (20260830172655): landmark verified — history-safe no-op (not a claim of byte-for-byte equivalence with production apply).';
  else
    raise notice 'expense_entries_owner_only_rls (20260830172655): landmark absent — treating as fresh-DB / out-of-band feature path; history placeholder no-op (will not invent DDL).';
  end if;
end;
$$;
