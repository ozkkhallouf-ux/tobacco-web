import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATION_FILE = '20260830144330_expense_entries_owner_only_rls.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = await readFile(
  path.join(repoRoot, 'supabase', 'migrations', MIGRATION_FILE),
  'utf8',
);

// The header/rollback-reference comments intentionally quote the OLD
// wide-open policy text verbatim (documentation convention also used in
// shared-documents-anon-lockdown.sql), so a naive text search over the
// whole file would false-positive on those quotes. Strip full-line "--"
// comments before checking for the dangerous patterns so only live SQL
// is inspected.
const codeOnly = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

// The whole point of this fix is that no *live* policy on expense_entries
// may be wide open (using(true) / with check(true)) any more.
assert.doesNotMatch(
  codeOnly,
  /for (?:select|delete)[\s\S]{0,120}using\s*\(\s*true\s*\)/i,
  'no select/delete policy may use using(true)',
);
assert.doesNotMatch(
  codeOnly,
  /for insert[\s\S]{0,120}with check\s*\(\s*true\s*\)/i,
  'no insert policy may use with check(true)',
);

// The three replacement policies must exist and each must gate on
// is_owner() specifically — not is_staff(), which does not distinguish
// owner/accountant/employee (verified live: it only checks staff_allowlist
// membership).
const selectPolicy = sql.match(/create policy "expense_entries_owner_select"[\s\S]*?;/i)?.[0];
const insertPolicy = sql.match(/create policy "expense_entries_owner_insert"[\s\S]*?;/i)?.[0];
const deletePolicy = sql.match(/create policy "expense_entries_owner_delete"[\s\S]*?;/i)?.[0];
assert.ok(selectPolicy, 'expense_entries_owner_select policy must exist');
assert.ok(insertPolicy, 'expense_entries_owner_insert policy must exist');
assert.ok(deletePolicy, 'expense_entries_owner_delete policy must exist');
assert.match(selectPolicy, /for select to authenticated using \(public\.is_owner\(\)\)/i);
assert.match(insertPolicy, /for insert to authenticated with check \(public\.is_owner\(\)\)/i);
assert.match(deletePolicy, /for delete to authenticated using \(public\.is_owner\(\)\)/i);
assert.doesNotMatch(codeOnly, /is_staff\(\)/i, 'must not fall back to is_staff() — owner-only by design');

// The old wide-open policy names must be dropped, not left dangling.
assert.match(sql, /drop policy if exists "expense_entries_select_authenticated" on public\.expense_entries;/i);
assert.match(sql, /drop policy if exists "expense_entries_insert_authenticated" on public\.expense_entries;/i);
assert.match(sql, /drop policy if exists "expense_entries_delete_authenticated" on public\.expense_entries;/i);

// Defense in depth: table privileges must be revoked from anon/public, and
// authenticated re-granted only what the policies actually allow (no
// UPDATE — no update policy exists on this table).
assert.match(sql, /revoke all privileges on table public\.expense_entries from anon;/i);
assert.match(sql, /revoke all privileges on table public\.expense_entries from public;/i);
assert.match(sql, /revoke all privileges on table public\.expense_entries from authenticated;/i);
assert.match(sql, /grant select, insert, delete on table public\.expense_entries to authenticated;/i);
assert.doesNotMatch(codeOnly, /grant[^;]*update[^;]*on table public\.expense_entries/i);

// RLS must stay enabled, and must NOT be forced (forcing binds the table
// owner too, which would make the verification block below false-pass when
// run as owner).
assert.match(sql, /alter table public\.expense_entries enable row level security;/i);
assert.doesNotMatch(codeOnly, /force row level security/i);

// The self-verification block must use pg_policies / has_table_privilege —
// never a nonexistent function like has_policy().
assert.match(sql, /from pg_policies\b/i);
assert.match(sql, /has_table_privilege\('anon', 'public\.expense_entries'/i);
assert.match(sql, /has_table_privilege\('authenticated', 'public\.expense_entries', 'UPDATE'\)/i);
assert.doesNotMatch(codeOnly, /has_policy\s*\(/i, 'has_policy() is not a real PostgreSQL/Supabase function');

console.log('Expense entries owner-only RLS migration contract checks passed.');
