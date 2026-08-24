import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [sql, producer] = await Promise.all([
  readFile(path.join(repoRoot, 'supabase', 'sales-line-items-atomic-refresh.sql'), 'utf8'),
  readFile(path.join(repoRoot, 'tools', 'push-sales-line-items.ps1'), 'utf8'),
]);

const helper = sql.match(
  /create or replace function public\.sales_line_items_is_sync_writer\(\)[\s\S]*?\$\$;/i,
)?.[0];
assert.ok(helper, 'sync-writer helper must exist');
assert.match(helper, /\bstable\b/i);
assert.match(helper, /\bsecurity invoker\b/i);
assert.doesNotMatch(helper, /auth\.jwt|email|security definer/i);
const syncUid = helper.match(/auth\.uid\(\)\)\s*=\s*'([0-9a-f-]{36})'::uuid/i)?.[1];
assert.ok(syncUid, 'helper must compare auth.uid() with one fixed UUID');

assert.match(sql, /alter table public\.sales_line_items enable row level security;/i);
assert.match(
  sql,
  /revoke all on table public\.sales_line_items from public, anon, authenticated;/i,
);
assert.match(
  sql,
  /grant select, insert, delete on table public\.sales_line_items to authenticated;/i,
);
const baseTableGrants = [...sql.matchAll(
  /grant[^;]*on table public\.sales_line_items(?!_)[^;]*;/gi,
)].map((match) => match[0]);
assert.equal(baseTableGrants.length, 1);
assert.doesNotMatch(baseTableGrants[0], /\b(?:update|truncate)\b/i);
assert.match(sql, /revoke all on sequence public\.sales_line_items_id_seq from public, anon, authenticated;/i);
assert.match(sql, /grant usage on sequence public\.sales_line_items_id_seq to authenticated;/i);

const selectPolicy = sql.match(
  /create policy "authenticated can select sales_line_items"[\s\S]*?;/i,
)?.[0];
const insertPolicy = sql.match(
  /create policy "sync writer can insert sales_line_items"[\s\S]*?;/i,
)?.[0];
const deletePolicy = sql.match(
  /create policy "sync writer can delete sales_line_items"[\s\S]*?;/i,
)?.[0];
assert.match(selectPolicy ?? '', /for select to authenticated\s+using \(true\)/i);
assert.match(insertPolicy ?? '', /for insert to authenticated[\s\S]*sales_line_items_is_sync_writer/i);
assert.match(deletePolicy ?? '', /for delete to authenticated[\s\S]*sales_line_items_is_sync_writer/i);
assert.doesNotMatch(`${insertPolicy}\n${deletePolicy}`, /auth\.role|using\s*\(true\)|with check\s*\(true\)/i);

assert.match(sql, /create table if not exists public\.sales_line_items_sync_state/i);
assert.match(sql, /alter table public\.sales_line_items_sync_state enable row level security/i);
assert.match(sql, /sync_run_id uuid not null/i);
assert.match(sql, /window_start date not null/i);
assert.match(sql, /window_end date not null/i);
assert.match(sql, /row_count integer not null/i);
assert.match(sql, /completed_at timestamptz not null/i);
assert.match(sql, /for update to authenticated[\s\S]*using \(\(select public\.sales_line_items_is_sync_writer\(\)\)\)[\s\S]*with check/i);

const rpc = sql.match(
  /create or replace function public\.replace_sales_line_items_window\([\s\S]*?\$\$;/i,
)?.[0];
assert.ok(rpc, 'replacement RPC must exist');
assert.match(rpc, /security invoker/i);
assert.doesNotMatch(rpc, /security definer/i);
assert.match(rpc, /set search_path = ''/i);
assert.match(rpc, /set statement_timeout = '15s'/i);
assert.doesNotMatch(rpc, /\btruncate\b/i);
assert.doesNotMatch(sql, /alter\s+role\s+(?:authenticated|authenticator)\b[^;]*\bstatement_timeout\b/i);
assert.doesNotMatch(sql, /alter\s+database\b[^;]*\bstatement_timeout\b/i);
assert.match(rpc, /if not \(select public\.sales_line_items_is_sync_writer\(\)\) then[\s\S]*sync writer required/i);
assert.match(
  sql,
  /revoke all on function public\.replace_sales_line_items_window\(date, date, jsonb\)[\s\S]*?from public, anon, service_role;/i,
);
assert.match(
  sql,
  /grant execute on function public\.replace_sales_line_items_window\(date, date, jsonb\)[\s\S]*?to authenticated;/i,
);
assert.doesNotMatch(sql, /grant execute[^;]*to (?:public|anon|service_role)/i);
assert.doesNotMatch(producer, /service[_-]?role|SUPABASE_SERVICE/i);

const normalUid = '00000000-0000-4000-8000-000000000001';
const permissionsFor = (role, uid) => {
  const trusted = role === 'authenticated' && uid === syncUid;
  return {
    select: role === 'authenticated',
    insert: trusted,
    delete: trusted,
    replaceRpc: trusted,
  };
};
assert.deepEqual(permissionsFor('authenticated', normalUid), {
  select: true, insert: false, delete: false, replaceRpc: false,
});
assert.deepEqual(permissionsFor('authenticated', syncUid), {
  select: true, insert: true, delete: true, replaceRpc: true,
});
assert.deepEqual(permissionsFor('anon', null), {
  select: false, insert: false, delete: false, replaceRpc: false,
});

console.log('Sales line items SQL security contract checks passed.');
