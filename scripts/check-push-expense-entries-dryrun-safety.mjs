import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// tools/push-expense-entries.ps1's -DryRun mode must prove Supabase auth +
// connectivity actually work (read-only) using the SAME credentials the
// real upload path uses, WITHOUT ever writing data — and must fail loudly
// (non-zero exit + a failure notification) if that check fails, rather
// than silently reporting "DryRun succeeded" while auth/connectivity is
// actually broken. This was discovered missing during a live SSH
// verification: the old -DryRun exited before reaching any Supabase call
// at all.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'tools', 'push-expense-entries.ps1');
const rawBytes = await readFile(scriptPath);
const hasBom = rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf;
const ps1 = rawBytes.toString('utf8');

// 1) The file must carry a UTF-8 BOM. Windows PowerShell (5.1, used by the
// scheduled tasks on the Windows box) reads a BOM-less script file using
// the system's ANSI code page, not UTF-8 — which corrupts every Arabic
// string literal in this file and can break parsing entirely (observed
// live: "The string is missing the terminator" on an Arabic string when
// invoked over SSH). A BOM makes PowerShell parse it as UTF-8 regardless
// of the invoking session's code page.
assert.ok(hasBom, 'push-expense-entries.ps1 must start with a UTF-8 BOM (EF BB BF) for correct parsing on Windows PowerShell 5.1');

// 2) Console output must be forced to UTF-8 so Arabic Write-Host/
// Format-Table output renders correctly in non-UTF8 console sessions
// (e.g. SSH), not as "?" placeholders.
assert.match(
  ps1,
  /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/,
  'must force [Console]::OutputEncoding to UTF8 for correct Arabic display',
);

// 3) Extract the `if ($DryRun) { ... }` block by balanced-brace matching
// (not a naive regex) so later assertions inspect exactly and only that
// block's contents.
function extractBracedBlock(source, openMarker) {
  const start = source.indexOf(openMarker);
  assert.notEqual(start, -1, `must find "${openMarker}"`);
  const braceStart = source.indexOf('{', start);
  assert.notEqual(braceStart, -1, `must find opening brace after "${openMarker}"`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error(`unbalanced braces starting at "${openMarker}"`);
}

const dryRunBlock = extractBracedBlock(ps1, 'if ($DryRun) {');

// 4) The DryRun block must actually authenticate against Supabase (same
// mechanism as the real upload path) and perform a read-only GET probe.
assert.match(
  dryRunBlock,
  /Get-SupabaseAuthToken/,
  'DryRun block must call Get-SupabaseAuthToken to prove auth actually works',
);
assert.match(
  dryRunBlock,
  /-Method Get[\s\S]{0,200}\/rest\/v1\/expense_entries/i,
  'DryRun block must perform a read-only GET probe against expense_entries',
);

// 5) The DryRun block must NEVER contain a write verb against the REST
// API — this is the core safety guarantee the task requires.
assert.doesNotMatch(
  dryRunBlock,
  /-Method\s+(Post|Delete|Put|Patch)/i,
  'DryRun block must not contain any write HTTP verb (Post/Delete/Put/Patch) — it must stay strictly read-only',
);

// 6) On a failed Supabase probe, the script must exit non-zero and raise
// a failure notification — not swallow the error and report DryRun as
// clean.
const probeFailureBlock = dryRunBlock.slice(dryRunBlock.indexOf('} catch {'));
assert.match(probeFailureBlock, /Notify-Failure/, 'a failed DryRun Supabase probe must call Notify-Failure');
assert.match(probeFailureBlock, /exit 1/, 'a failed DryRun Supabase probe must exit 1');

// 6b) Codex P1 regression guard (PR #141, second round): the DryRun
// Supabase probe must be reachable on every invocation — no early exit
// may stand between the Ameen read and the `if ($DryRun) { ... }` block.
// Originally an `if ($rows.Count -eq 0)` early-exit ran first, so a
// DryRun against a window with zero expense rows (e.g. -Days 0) exited 0
// without ever reaching the probe: invalid credentials silently reported
// success in exactly that case.
//
// That early-exit is now gone entirely (PR #205): it also left the
// previous window's rows in Supabase, unrefreshed and unmarked, whenever
// Ameen returned nothing — so an emptied week kept showing stale
// expenses. An empty window is now replaced and sealed like any other.
// The ordering hazard is therefore guarded at its root: nothing between
// the read and the probe may exit at all.
assert.doesNotMatch(
  ps1,
  /if \(\$rows\.Count -eq 0\) \{/,
  'the zero-row early-exit must stay removed — it left an emptied window stale and unmarked',
);
const dryRunIfIndex = ps1.indexOf('if ($DryRun) {');
assert.notEqual(dryRunIfIndex, -1, 'must find "if ($DryRun) {"');
const readEndIndex = ps1.indexOf('$reader.Close()');
assert.notEqual(readEndIndex, -1, 'must find the end of the Ameen read');
assert.ok(readEndIndex < dryRunIfIndex, 'the Ameen read must precede the DryRun block');
assert.doesNotMatch(
  ps1.slice(readEndIndex, dryRunIfIndex),
  /\bexit\b/,
  'no early exit may stand between the Ameen read and the DryRun probe',
);

// 7) DryRun must still exit before ever reaching the real write path: the
// unconditional real-upload auth call and the atomic replacement RPC must
// appear strictly AFTER the entire `if ($DryRun) { ... }` block ends in
// the source, so a DryRun invocation can never fall through into them.
//
// The write path is now a single RPC call. The former DELETE + batched
// POST pair is gone (PR #205): it left a window that was briefly empty
// and recorded no verified boundary, so no later reader could tell what
// had actually been refreshed.
const dryRunBlockEnd = ps1.indexOf('if ($DryRun) {') + ps1.slice(ps1.indexOf('if ($DryRun) {')).indexOf(dryRunBlock) + dryRunBlock.length;
const realUploadAuthIndex = ps1.indexOf('$token = Get-SupabaseAuthToken');
const realRpcIndex = ps1.indexOf('rest/v1/rpc/replace_expense_entries_window');
assert.ok(realUploadAuthIndex > dryRunBlockEnd, 'real-upload auth call must be located after the DryRun block, never reachable from it');
assert.notEqual(realRpcIndex, -1, 'must find the atomic replacement RPC call');
assert.ok(realRpcIndex > dryRunBlockEnd, 'the atomic replacement RPC call must be located after the DryRun block');
assert.doesNotMatch(
  ps1,
  /-Method\s+(Delete|Put|Patch)\s+-Uri "\$supabaseUrl\/rest\/v1\/expense_entries/i,
  'direct writes against the expense_entries table must stay replaced by the atomic RPC',
);

console.log('push-expense-entries.ps1 DryRun safety contract checks passed.');
