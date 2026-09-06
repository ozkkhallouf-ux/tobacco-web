# Hardened expense entries pipeline

This change is migration and producer source only. Applying the SQL and running
the producer are separate production steps. Until both are done, the financial
assistant reports expense totals as unverified — see "Rollout" below.

## Why this exists

`tools/push-expense-entries.ps1` refreshes a short window only — `-Days 7` by
default, and `tools/register-expense-entries-task.ps1` passes no other value.
Rows dated before that window are never touched again: an expense entry edited
or deleted in Ameen after its date leaves the window never reaches Supabase.

The financial assistant nevertheless summed everything it found in the
requested range and presented it as `إجمالي`. So `مصاريف الشهر الماضي` could
silently omit whole dates, or include entries that no longer exist in Ameen,
with nothing in the answer to say so. Codex raised this on PR #205, as the
direct counterpart of the sales-line-items finding it had raised earlier.

No reader can know the boundary of what is verified unless that boundary is
recorded. `public.expense_entries_sync_state` records it.

## Baseline inspected on 2026-09-06

`public.expense_entries` has a bigserial `id`, plus `entry_date`,
`account_name`, `amount`, `notes`, and `created_at`. RLS is owner-only
(`public.is_owner()`, from
`supabase/migrations/20260830144330_expense_entries_owner_only_rls.sql`) and the
canonical schema in `supabase/expense-entries-table.sql` matches it. Indexes
covered the primary key and `entry_date desc`.

The producer authenticated as `TOBACCO_SYNC_EMAIL` — the same identity the
sales producer uses — then issued a REST `DELETE ?entry_date=gte.<cutoff>`
followed by `POST` batches of 500. Two defects followed from that shape:

1. **No verified boundary.** Nothing recorded which window had actually been
   replaced, so consumers could not distinguish refreshed rows from stale ones.
2. **A stale-data hole on empty windows.** The script exited early when Ameen
   returned zero rows, *before* the DELETE. If every expense in the window was
   removed in Ameen, its rows stayed in Supabase and kept being reported as
   current.

The delete/insert pair was also non-atomic: between the two calls the window
was empty, and a failure in the middle left it that way with no marker.

## What changed

- `supabase/expense-entries-atomic-refresh.sql` adds
  `public.expense_entries_sync_state` (one row, keyed `ameen_expense_entries`)
  and `public.replace_expense_entries_window(date, date, jsonb)`. The RPC
  stages and validates the whole payload, then DELETEs, INSERTs, and writes the
  completion marker in one transaction, under an advisory lock. It is
  `security invoker`, so the table's owner-only RLS still applies.
- The sync-writer identity is **delegated**, not duplicated:
  `public.expense_entries_is_sync_writer()` calls
  `public.sales_line_items_is_sync_writer()`. Both producers authenticate as the
  same account, and copying the UUID would create two sources of truth — one of
  which would eventually be left pointing at a retired account.
- Unlike its sales counterpart, the RPC **accepts an empty payload**. An empty
  week is legitimate here, and rejecting it would reproduce defect (2) from the
  database side. The early exit in the producer is gone for the same reason.
- The Ameen query gained an upper bound (`en.Date <= CAST(GETDATE() AS date)`)
  so the sealed window matches what is actually uploaded; `-Days` is capped at
  31 to match the RPC's window guard.
- `supabase/functions/financial-assistant/index.ts` reads the marker and
  appends an explicit coverage warning whenever the requested period is not
  fully inside the verified window — in the totals branch, in the zero-rows
  branch (a flat "no expenses in this period" is a hard negative, and absence
  outside the window may be absence of sync rather than absence of spending),
  and when no marker exists at all.

## Checks

- `scripts/check-expense-entries-pipeline.mjs` (in `npm run check`) pins the
  contract statically: Ameen SQL stays SELECT-only and bounded on both ends;
  the producer writes only through the RPC and verifies its result; the RPC
  keeps `security invoker`, its advisory lock, and the order
  stage → validate → delete → insert → seal; the writer identity stays
  delegated; and the assistant warns in both branches.
- `scripts/check-push-expense-entries-dryrun-safety.mjs` was updated to the new
  shape. Its original guarantee is unchanged — the DryRun probe stays read-only
  and unreachable from the write path — and its ordering guard is now stated at
  the root: no early exit may stand between the Ameen read and the probe.
- `scripts/check-assistant-routing.mjs` covers the assistant behaviour: inside
  the window no warning, extending before it warns and names the boundary,
  a missing marker is declared, and a warning never names the wrong source.

## Rollout

These are production steps, in order. None of them happen automatically.

1. Apply `supabase/expense-entries-atomic-refresh.sql` in Supabase → SQL Editor.
   It requires `expense-entries-table.sql` and `sales-line-items-atomic-refresh.sql`
   to have been applied first, and stops with a clear message otherwise.
2. Deploy the `financial-assistant` edge function.
3. Let the scheduled task run once (or run `.\tools\push-expense-entries.ps1`
   on the Windows machine) so the first marker is written.

Order matters less than it looks: step 2 before step 1 is safe. A missing
`expense_entries_sync_state` table makes PostgREST answer 404, and `syncWindow()`
treats that as "no verified marker" rather than a read failure — so the expenses
tool keeps answering and simply reports its figures as unverified, instead of
collapsing into "تعذّرت قراءة مصدر البيانات". `scripts/check-assistant-routing.mjs`
pins that behaviour for both the sales and the expense marker.

Between step 2 and step 3 the assistant will say that expense figures are
unverified, because at that point they genuinely are. That is the intended
direction of failure: it over-warns while the marker is missing rather than
claiming a total it cannot support.
