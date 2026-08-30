import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Codex P1 finding on PR #140: the canonical schema file
// (expense-entries-table.sql) and the live-fix migration must never be
// allowed to drift — if the canonical file still created open policies
// under different names, PostgreSQL would OR them together with the
// is_owner() policies and silently reopen full access. This check reads
// BOTH files and enforces that they converge on the exact same secure
// policy names and predicates, not just that each one individually looks
// safe in isolation.
const MIGRATION_FILE = '20260830144330_expense_entries_owner_only_rls.sql';
const CANONICAL_FILE = 'expense-entries-table.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationSql = await readFile(
  path.join(repoRoot, 'supabase', 'migrations', MIGRATION_FILE),
  'utf8',
);
const canonicalSql = await readFile(
  path.join(repoRoot, 'supabase', CANONICAL_FILE),
  'utf8',
);

// Both header/rollback-reference comments intentionally quote the OLD
// wide-open policy text verbatim for documentation (convention also used
// in shared-documents-anon-lockdown.sql), so a naive text search over the
// whole file would false-positive on those quotes. Strip full-line "--"
// comments before checking for dangerous patterns so only live SQL is
// inspected.
const codeOnly = (sql) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const files = [
  { name: MIGRATION_FILE, sql: migrationSql, code: codeOnly(migrationSql) },
  { name: CANONICAL_FILE, sql: canonicalSql, code: codeOnly(canonicalSql) },
];

for (const { name, code } of files) {
  // No *live* policy on expense_entries may ever be wide open again, in
  // either file.
  assert.doesNotMatch(
    code,
    /for (?:select|delete)[\s\S]{0,120}using\s*\(\s*true\s*\)/i,
    `${name}: no select/delete policy may use using(true)`,
  );
  assert.doesNotMatch(
    code,
    /for insert[\s\S]{0,120}with check\s*\(\s*true\s*\)/i,
    `${name}: no insert policy may use with check(true)`,
  );
  // Neither file may fall back to is_staff() — owner-only by design (see
  // migration header for the live-evidence justification).
  assert.doesNotMatch(code, /is_staff\(\)/i, `${name}: must not use is_staff() — owner-only by design`);
  // has_policy() is not a real PostgreSQL/Supabase function.
  assert.doesNotMatch(code, /has_policy\s*\(/i, `${name}: has_policy() is not a real function`);
  // Neither file may grant UPDATE on this table (no update policy exists).
  assert.doesNotMatch(
    code,
    /grant[^;]*update[^;]*on table public\.expense_entries/i,
    `${name}: must not grant UPDATE on expense_entries`,
  );
  // RLS must stay enabled and never forced (forcing binds the table owner
  // too, which would make a self-verification block false-pass as owner).
  assert.doesNotMatch(code, /force row level security/i, `${name}: must not FORCE row level security`);
}

// The three is_owner() policies must exist with the EXACT SAME names and
// predicates in both files. This is the direct fix for the Codex finding:
// same name ⇒ `create policy` on a fresh run errors instead of silently
// coexisting, and a `drop policy if exists` for that same name in either
// file cleanly supersedes the other file's version — no OR-combination of
// a stale open policy is possible because no open policy exists in either
// file at all.
const POLICY_SPECS = [
  { name: 'expense_entries_owner_select', re: /for select to authenticated using \(public\.is_owner\(\)\)/i },
  { name: 'expense_entries_owner_insert', re: /for insert to authenticated with check \(public\.is_owner\(\)\)/i },
  { name: 'expense_entries_owner_delete', re: /for delete to authenticated using \(public\.is_owner\(\)\)/i },
];

for (const { name: policyName, re } of POLICY_SPECS) {
  for (const { name: fileName, sql } of files) {
    const block = sql.match(new RegExp(`create policy "${policyName}"[\\s\\S]*?;`, 'i'))?.[0];
    assert.ok(block, `${fileName}: policy "${policyName}" must exist`);
    assert.match(block, re, `${fileName}: policy "${policyName}" must gate on is_owner() exactly`);
  }
}

// The canonical file must be safely re-runnable regardless of ordering
// relative to the migration: it must drop both the historical open policy
// names AND its own new owner policy names before (re)creating them.
for (const oldName of [
  'expense_entries_select_authenticated',
  'expense_entries_insert_authenticated',
  'expense_entries_delete_authenticated',
]) {
  assert.match(
    canonicalSql,
    new RegExp(`drop policy if exists "${oldName}" on public\\.expense_entries;`, 'i'),
    `${CANONICAL_FILE}: must drop legacy open policy "${oldName}" for idempotent re-runs`,
  );
}
for (const { name: policyName } of POLICY_SPECS) {
  assert.match(
    canonicalSql,
    new RegExp(`drop policy if exists "${policyName}" on public\\.expense_entries;`, 'i'),
    `${CANONICAL_FILE}: must drop its own policy "${policyName}" before recreating it (idempotency)`,
  );
}

// Defense in depth: both files must revoke anon/public table privileges and
// grant authenticated only select/insert/delete.
for (const { name, sql } of files) {
  assert.match(sql, /revoke all privileges on table public\.expense_entries from anon;/i, `${name}: must revoke anon`);
  assert.match(sql, /revoke all privileges on table public\.expense_entries from public;/i, `${name}: must revoke public`);
  assert.match(
    sql,
    /grant select, insert, delete on table public\.expense_entries to authenticated;/i,
    `${name}: must grant select/insert/delete to authenticated`,
  );
}

// The migration's self-verification block must use pg_policies /
// has_table_privilege — never a nonexistent function.
assert.match(migrationSql, /from pg_policies\b/i);
assert.match(migrationSql, /has_table_privilege\('anon', 'public\.expense_entries'/i);
assert.match(migrationSql, /has_table_privilege\('authenticated', 'public\.expense_entries', 'UPDATE'\)/i);

console.log('Expense entries owner-only RLS contract checks passed (migration + canonical schema, no drift).');
