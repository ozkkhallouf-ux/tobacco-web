import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [producer, sql] = await Promise.all([
  readFile(path.join(repoRoot, 'tools', 'push-sales-line-items.ps1'), 'utf8'),
  readFile(path.join(repoRoot, 'supabase', 'sales-line-items-atomic-refresh.sql'), 'utf8'),
]);

const ameenSql = producer.match(/\$sql\s*=\s*@"([\s\S]*?)"@/)?.[1];
assert.ok(ameenSql, 'Ameen SQL here-string must exist');
const ameenSqlWithoutComments = ameenSql.replace(/--.*$/gm, ' ');
assert.match(ameenSqlWithoutComments, /^\s*select\b/i);
assert.doesNotMatch(
  ameenSqlWithoutComments,
  /\b(insert|update|delete|merge|drop|alter|create|truncate|exec(?:ute)?|grant|revoke|deny|backup|restore|dbcc|kill|use)\b/i,
  'Ameen SQL must remain SELECT-only',
);
assert.match(ameenSql, /convert\(nvarchar\(36\),\s*bi\.GUID\)\s+AS source_key/i);
assert.match(ameenSql, /u\.TypeGUID IN \('\$RETAIL_TYPE_GUID', '\$WHOLESALE_TYPE_GUID', '\$SALES_TYPE_GUID'\)/);
assert.match(ameenSql, /THEN 'retail'\s+ELSE 'wholesale' END/i);

assert.match(producer, /\[ValidateRange\(1, 31\)\]\[int\]\$Days = 7/);
assert.match(producer, /p_window_start\s*=\s*\$windowStart/);
assert.match(producer, /p_window_end\s*=\s*\$windowEnd/);
assert.match(producer, /p_rows\s*=\s*@\(\$rows\.ToArray\(\)\)/);
assert.match(producer, /rest\/v1\/rpc\/replace_sales_line_items_window/);
assert.doesNotMatch(producer, /-Method\s+Delete/i);
assert.doesNotMatch(producer, /rest\/v1\/sales_line_items(?:\?|"|')/i);
assert.doesNotMatch(producer, /\$batchSize|\$batch\b|for\s*\(\$i\s*=\s*0/i);
assert.match(producer, /resultRow\.row_count\s*-ne\s*\$rows\.Count/i);
assert.match(producer, /sync_run_id/);
assert.match(producer, /completed_at/);

const rpc = sql.match(
  /create or replace function public\.replace_sales_line_items_window\([\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(rpc, 'atomic replacement RPC must exist');
assert.match(rpc, /security invoker/i);
assert.doesNotMatch(rpc, /security definer/i);
assert.match(rpc, /set search_path = ''/i);
assert.match(rpc, /set statement_timeout = '15s'/i);
assert.doesNotMatch(rpc, /\btruncate\b/i);
assert.match(rpc, /create temporary table staged_sales_line_items on commit drop as/i);
assert.match(rpc, /pg_advisory_xact_lock/i);
assert.match(rpc, /duplicate source_key in payload/i);
assert.match(rpc, /unsupported bill_type in payload/i);
assert.match(rpc, /s\.bill_type not in \('retail', 'wholesale'\)/i);
assert.match(rpc, /Negative qty values are deliberately preserved/i);
assert.doesNotMatch(rpc, /s\.qty\s*[<>]=?\s*0/i);

const deletePosition = rpc.search(/delete from public\.sales_line_items s/i);
const stagePosition = rpc.search(/create temporary table staged_sales_line_items/i);
const validationPosition = rpc.search(/unsupported bill_type in payload/i);
const insertPosition = rpc.search(/insert into public\.sales_line_items\s*\(/i);
const metadataPosition = rpc.search(/insert into public\.sales_line_items_sync_state/i);
assert.ok(stagePosition >= 0 && stagePosition < validationPosition);
assert.ok(validationPosition < deletePosition, 'all validation must finish before DELETE');
assert.ok(deletePosition < insertPosition && insertPosition < metadataPosition);
assert.match(rpc, /get diagnostics v_inserted = row_count/i);
assert.match(rpc, /if v_inserted <> v_count then\s+raise exception 'inserted row count mismatch'/i);

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('non-empty payload required');
  const keys = new Set();
  for (const row of rows) {
    if (!row.source_key) throw new Error('source key required');
    if (keys.has(row.source_key)) throw new Error('duplicate source key');
    keys.add(row.source_key);
    if (!['retail', 'wholesale'].includes(row.bill_type)) throw new Error('unsupported bill type');
    if (!Number.isFinite(row.qty)) throw new Error('invalid quantity');
  }
}

function simulateTransaction(currentRows, replacementRows, failBeforeCommit = false) {
  validateRows(replacementRows);
  const stagedState = replacementRows.map((row) => ({ ...row }));
  if (failBeforeCommit) throw new Error('simulated failure before commit');
  return stagedState;
}

const oldWindow = [{ source_key: 'old', bill_type: 'retail', qty: 4 }];
assert.throws(() => simulateTransaction(oldWindow, [
  { source_key: 'new', bill_type: 'wholesale', qty: -2 },
], true), /simulated failure/);
assert.deepEqual(oldWindow, [{ source_key: 'old', bill_type: 'retail', qty: 4 }]);
assert.equal(simulateTransaction(oldWindow, [
  { source_key: 'return-sign', bill_type: 'retail', qty: -2 },
])[0].qty, -2, 'negative quantities retain their current signed-value contract');
assert.throws(() => simulateTransaction(oldWindow, [
  { source_key: 'same', bill_type: 'retail', qty: 1 },
  { source_key: 'same', bill_type: 'retail', qty: 1 },
]), /duplicate/);
assert.throws(() => simulateTransaction(oldWindow, [
  { source_key: 'bad-type', bill_type: 'return', qty: -1 },
]), /unsupported/);

console.log('Sales line items atomic pipeline contract checks passed.');
