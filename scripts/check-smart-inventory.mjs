import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let failed = false;
function assert(condition, message) { if (!condition) { failed = true; console.error(message); } }
function section(source, start, end) {
  const from = source.indexOf(start); const to = source.indexOf(end, from + start.length);
  return from >= 0 ? source.slice(from, to >= 0 ? to : source.length) : "";
}

const sql = readFileSync("supabase/smart-inventory.sql", "utf8");
const isolationSql = readFileSync("supabase/migrations/superseded/20260823084956_smart_inventory_counter_isolation.sql", "utf8");
const app = readFileSync("src/app.js", "utf8");
const client = readFileSync("src/supabase-client.js", "utf8");
const moduleSource = readFileSync("src/smart-inventory.js", "utf8");
const edge = readFileSync("supabase/functions/inventory-auth/index.ts", "utf8");
const securitySql = readFileSync("supabase/tests/smart-inventory-security.sql", "utf8");
const html = readFileSync("index.html", "utf8");
const worker = readFileSync("public/service-worker.js", "utf8");

for (const contract of [
  "smart_inventory_sessions", "unique (inventory_date, warehouse_key)", "smart_inventory_expectations",
  "smart_inventory_count_attempts", "for update", "claim_expires_at", "already_counted",
  "recount_requires_other_counter", "auth.sessions", "smart_inventory_owner_report",
  "smart_inventory_movement_adjustments", "smart_inventory_owner_correct_item", "smart_inventory_enqueue_daily_summary", "Asia/Beirut", "revoke all on table"
]) assert(sql.toLowerCase().includes(contract.toLowerCase()), `Smart inventory SQL contract missing: ${contract}`);

const counterPayload = section(sql, "create or replace function public.smart_inventory_counter_session", "create or replace function public.smart_inventory_claim_item");
assert(counterPayload && !/expected_qty|difference_qty|classification/.test(counterPayload), "Counter RPC must not return expected quantities, differences or classifications.");
const ownerPayload = section(sql, "create or replace function public.smart_inventory_owner_report", "create or replace function public.smart_inventory_owner_open_recount");
for (const contract of ["expectedQtyUnit1", "differenceQtyUnit1", "classification", "movementQtyUnit1"])
  assert(ownerPayload.includes(contract), `Owner report missing: ${contract}`);
const saveRpc = section(sql, "create or replace function public.smart_inventory_save_item", "create or replace function public.smart_inventory_complete_session");
assert(!/p_counted_by|p_counted_by_display_name/i.test(saveRpc), "Count RPC must never accept counter identity from the browser.");
assert(/counted_by=auth\.uid\(\)/.test(saveRpc) && /for update/.test(saveRpc), "Count RPC must stamp auth.uid() and lock the row atomically.");

for (const contract of [
  'if (isInventoryCounter()) return requested === "smartInventory"',
  "legacy loader that could place Ameen stock", "smartInventory: smartInventoryPage",
  "inventory-counter-login", "window.SmartInventory?.bind"
]) assert(app.includes(contract), `Counter route isolation missing: ${contract}`);
assert(client.includes('email: accessRole === "inventory_counter" ? ""'), "Synthetic counter email must not enter UI session state.");
assert(client.includes("signInInventoryCounter") && client.includes("client.auth.setSession"), "Counter username login must establish a Supabase Auth session.");
assert(!/localStorage\.setItem\([^\n]*(password|pin)/i.test(moduleSource + client), "Password/PIN must never be stored in localStorage.");
assert(edge.includes("Never return the synthetic Auth email") && !/return reply\([^\n]*authEmail/.test(edge), "Edge Function must not return internal Auth email.");
assert(edge.includes("smart_inventory_auth_preflight") && edge.includes("smart_inventory_auth_record"), "Login rate limiting contract missing.");
assert(edge.includes("smart_inventory_revoke_user_sessions"), "Reset/disable must revoke existing sessions.");
assert(edge.includes("smart_inventory_set_counter_auth_role"), "New and re-enabled counter accounts must receive the least-privilege database role.");
assert(sql.includes("smart_inventory_set_counter_auth_role"), "smart-inventory.sql must define smart_inventory_set_counter_auth_role for feature bootstrap.");
// After set_counter_auth_role, counter JWTs use DB role anon — bootstrap must
// grant the six counting RPCs to anon (not owner RPCs). Codex P1 on PR #228.
// Anon EXECUTE on those six is required, not drift: revoking it 401s every
// staff login. Owner RPCs must never be granted to anon.
const counterRpcGrant = section(
  sql,
  "grant execute on function public.smart_inventory_available_warehouses(date)",
  "grant execute on function public.smart_inventory_owner_dashboard(date)"
);
assert(/smart_inventory_available_warehouses\(date\)/.test(counterRpcGrant)
  && /smart_inventory_start_or_join\(text\)/.test(counterRpcGrant)
  && /smart_inventory_counter_session\(uuid\)/.test(counterRpcGrant)
  && /smart_inventory_claim_item\(uuid\)/.test(counterRpcGrant)
  && /smart_inventory_save_item\(uuid,uuid,text,numeric,numeric,numeric,bigint\)/.test(counterRpcGrant)
  && /smart_inventory_complete_session\(uuid\)/.test(counterRpcGrant),
  "smart-inventory.sql must list all six counter-facing RPCs in the anon grant block.");
assert(/\bto\s+anon\s*,\s*authenticated\s*;/i.test(counterRpcGrant) || /\bto\s+anon\b/i.test(counterRpcGrant),
  "smart-inventory.sql must GRANT the six counter RPCs to anon (counter JWT role).");
assert(!/smart_inventory_owner_dashboard/.test(counterRpcGrant)
  && !/smart_inventory_owner_report/.test(counterRpcGrant)
  && !/smart_inventory_owner_open_recount/.test(counterRpcGrant)
  && !/smart_inventory_owner_reopen_session/.test(counterRpcGrant)
  && !/smart_inventory_owner_correct_item/.test(counterRpcGrant),
  "Owner RPCs must not be included in the anon counter grant block.");
for (const contract of [
  "set role = 'anon'", "deny_inventory_counter_access", "as restrictive", "to anon",
  "smart_inventory_set_counter_auth_role", "delete from auth.sessions"
]) assert(isolationSql.toLowerCase().includes(contract.toLowerCase()), `Counter database isolation contract missing: ${contract}`);
assert(!/grant\s+(?:select|insert|update|delete|all)[\s\S]{0,120}\bto\s+anon/i.test(isolationSql), "Counter isolation migration must not grant anon direct table access.");
for (const contract of ["ameen_item_snapshot", "sales_line_items", "smart_inventory_owner_dashboard", "u.role <> 'anon'"])
  assert(securitySql.includes(contract), `Live counter REST isolation assertion missing: ${contract}`);
assert(edge.includes("password.length >= 8") && !edge.includes("password.length >= 10"), "Inventory counter passwords must accept the approved 8-character minimum.");
assert(edge.includes("liveError || live !== true"), "Owner operations must fail closed when live-session verification errors.");
assert(app.includes('data-form="inventory-counter-login"') && app.includes('minlength="8" maxlength="128"'), "Counter login must accept the approved 8-character password.");
assert(/src\/smart-inventory\.js\?v=tobacco-\d+/.test(html), "Published smart inventory module/version missing.");
assert(/CACHE_NAME = "web-platform-tobacco-v\d+"/.test(worker) && worker.includes('"src/smart-inventory.js"'), "Service worker cache must include the smart inventory module and a versioned cache name.");

const COUNTER_RPCS = [
  "smart_inventory_available_warehouses",
  "smart_inventory_start_or_join",
  "smart_inventory_counter_session",
  "smart_inventory_claim_item",
  "smart_inventory_save_item",
  "smart_inventory_complete_session",
];

function skipLineComment(source, i) {
  let end = i;
  while (end < source.length && source[end] !== "\n") end += 1;
  return { i: end, text: "\n" };
}

function skipBlockComment(source, i) {
  const end = source.indexOf("*/", i + 2);
  if (end < 0) throw new Error("unclosed block comment");
  return { i: end + 2, text: " " };
}

function skipQuoted(source, i) {
  let out = source[i];
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === "'" && source[j + 1] === "'") { out += "''"; j += 2; continue; }
    out += source[j];
    if (source[j] === "'") return { i: j + 1, text: out };
    j += 1;
  }
  return { i: j, text: out };
}

function skipDollarQuote(source, i) {
  const tag = source.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
  if (!tag) return null;
  const close = source.indexOf(tag[0], i + tag[0].length);
  if (close < 0) throw new Error("unclosed dollar quote");
  return { i: close + tag[0].length, text: " " };
}

function skipSqlToken(source, i) {
  const c = source[i];
  if (c === "-" && source[i + 1] === "-") return skipLineComment(source, i);
  if (c === "/" && source[i + 1] === "*") return skipBlockComment(source, i);
  if (c === "'") return skipQuoted(source, i);
  if (c === "$") return skipDollarQuote(source, i);
  return null;
}

function stripSqlNoise(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const skipped = skipSqlToken(source, i);
    if (skipped) {
      out += skipped.text;
      i = skipped.i;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function depth0Index(source, word) {
  let depth = 0;
  let quote = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "'" && source[i + 1] === "'") { i += 1; continue; }
      if (c === "'") quote = false;
      continue;
    }
    if (c === "'") { quote = true; continue; }
    if (c === "(") { depth += 1; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth !== 0) continue;
    const prev = i === 0 ? " " : source[i - 1];
    if (/[a-z0-9_]/.test(prev)) continue;
    if (source.slice(i, i + word.length) !== word) continue;
    const next = source[i + word.length] || " ";
    if (!/[a-z0-9_]/.test(next)) return i;
  }
  return -1;
}

function splitCommas(source) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "'" && source[i + 1] === "'") { i += 1; continue; }
      if (c === "'") quote = false;
      continue;
    }
    if (c === "'") { quote = true; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function splitStatements(source) {
  const parts = [];
  let quote = false;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "'" && source[i + 1] === "'") { i += 1; continue; }
      if (c === "'") quote = false;
      continue;
    }
    if (c === "'") { quote = true; continue; }
    if (c === ";") {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  if (source.slice(start).trim()) parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function functionNames(list) {
  const names = [];
  for (const part of splitCommas(list)) {
    const match = part.match(/(?:public\.)?(smart_inventory_[a-z0-9_]+)\s*(?:\(|$)/);
    if (match) names.push(match[1]);
  }
  return names;
}

function roleTokens(list) {
  return splitCommas(list)
    .map((part) => part.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);
}

// Net effect inside one file: a revoke of the six counter RPCs from anon is
// allowed only when a later statement in the same file grants them back.
// Any grant of smart_inventory_owner_* to anon (or PUBLIC, which includes
// anon) is rejected even if a later revoke tries to undo it.
function noteUnparsedGrant(statement, unparsed) {
  const mentionsAnon = /\banon\b/.test(statement);
  const mentionsInventory = /smart_inventory_(available_warehouses|start_or_join|counter_session|claim_item|save_item|complete_session|owner_)/.test(statement);
  if (mentionsAnon && mentionsInventory) unparsed.push(statement.slice(0, 160));
}

function recordRevokedCounters(names, targetsAnon, counterState) {
  if (!targetsAnon) return;
  for (const name of names) {
    if (COUNTER_RPCS.includes(name)) counterState.set(name, "revoked");
  }
}

function recordGrantedNames(names, roles, targetsAnon, counterState, ownerGranted) {
  if (!targetsAnon && !roles.includes("public")) return;
  for (const name of names) {
    if (targetsAnon && COUNTER_RPCS.includes(name)) counterState.set(name, "granted");
    if (name.startsWith("smart_inventory_owner_")) ownerGranted.add(name);
  }
}

function applyGrantStatement(statement, counterState, ownerGranted, unparsed) {
  const kind = statement.match(/^(grant|revoke)\s+(execute|all)(?:\s+privileges)?\s+on\s+function\b/);
  if (!kind) return;
  const verb = kind[1];
  const marker = statement.indexOf("on function");
  const after = marker + "on function".length;
  const roleWord = verb === "grant" ? "to" : "from";
  const roleAt = depth0Index(statement.slice(after), roleWord);
  if (roleAt < 0) {
    noteUnparsedGrant(statement, unparsed);
    return;
  }
  const names = functionNames(statement.slice(after, after + roleAt));
  const roles = roleTokens(statement.slice(after + roleAt + roleWord.length));
  const targetsAnon = roles.includes("anon");
  if (verb === "revoke") recordRevokedCounters(names, targetsAnon, counterState);
  if (verb === "grant") recordGrantedNames(names, roles, targetsAnon, counterState, ownerGranted);
}

export function auditSmartInventoryAnonGrants(source) {
  const statements = splitStatements(stripSqlNoise(source).toLowerCase());
  const counterState = new Map();
  const ownerGranted = new Set();
  const unparsed = [];
  for (const statement of statements) applyGrantStatement(statement, counterState, ownerGranted, unparsed);
  return {
    counterLeftRevoked: [...counterState.entries()].filter(([, state]) => state === "revoked").map(([name]) => name),
    ownerGrantedToAnon: [...ownerGranted],
    unparsed,
  };
}

function assertGrantAudit(source, expectation, label) {
  const audit = auditSmartInventoryAnonGrants(source);
  const revoked = [...audit.counterLeftRevoked].sort().join(",");
  const owners = [...audit.ownerGrantedToAnon].sort().join(",");
  assert(revoked === expectation.revoked && owners === expectation.owners && audit.unparsed.length === expectation.unparsed,
    `${label}: expected revoked=[${expectation.revoked}] owners=[${expectation.owners}] unparsed=${expectation.unparsed}, got revoked=[${revoked}] owners=[${owners}] unparsed=${audit.unparsed.length}`);
}

const drift20260914 = `
revoke all on function public.smart_inventory_available_warehouses(date),public.smart_inventory_start_or_join(text),
 public.smart_inventory_counter_session(uuid),public.smart_inventory_claim_item(uuid),
 public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint),public.smart_inventory_complete_session(uuid),
 public.smart_inventory_owner_dashboard(date),public.smart_inventory_owner_report(uuid),
 public.smart_inventory_owner_open_recount(uuid,text),public.smart_inventory_owner_reopen_session(uuid,text),
 public.smart_inventory_owner_correct_item(uuid,numeric,text)
from public,anon;
grant execute on function public.smart_inventory_available_warehouses(date),public.smart_inventory_start_or_join(text),
 public.smart_inventory_counter_session(uuid),public.smart_inventory_claim_item(uuid),
 public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint),public.smart_inventory_complete_session(uuid),
 public.smart_inventory_owner_dashboard(date),public.smart_inventory_owner_report(uuid),
 public.smart_inventory_owner_open_recount(uuid,text),public.smart_inventory_owner_reopen_session(uuid,text),
 public.smart_inventory_owner_correct_item(uuid,numeric,text)
to authenticated;
`;
assertGrantAudit(drift20260914, {
  revoked: [...COUNTER_RPCS].sort().join(","),
  owners: "",
  unparsed: 0,
}, "20260914061335 revoke-without-regrant must fail");

const revoke20260826 = `
revoke execute on function
  public.smart_inventory_available_warehouses(date),
  public.smart_inventory_claim_item(uuid),
  public.smart_inventory_complete_session(uuid),
  public.smart_inventory_counter_session(uuid),
  public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint),
  public.smart_inventory_start_or_join(text)
from anon;
`;
assertGrantAudit(revoke20260826, {
  revoked: [...COUNTER_RPCS].sort().join(","),
  owners: "",
  unparsed: 0,
}, "20260826081831 revoke-only must fail");

assertGrantAudit(`
-- revoke execute on function public.smart_inventory_available_warehouses(date) from anon;
grant execute on function public.smart_inventory_available_warehouses(date) to anon;
`, { revoked: "", owners: "", unparsed: 0 }, "a comment that mentions revoke must not count");

assertGrantAudit(`
grant execute on function public.smart_inventory_available_warehouses(date) to anon;
revoke execute on function public.smart_inventory_available_warehouses(date) from anon;
`, { revoked: "smart_inventory_available_warehouses", owners: "", unparsed: 0 }, "grant then revoke must stay revoked");

assertGrantAudit(`
revoke all on function public.smart_inventory_available_warehouses(date) from public,anon;
grant execute on function public.smart_inventory_available_warehouses(date) to anon, authenticated;
grant execute on function public.smart_inventory_owner_dashboard(date) to authenticated;
revoke execute on function public.smart_inventory_owner_report(uuid) from anon;
`, { revoked: "", owners: "", unparsed: 0 }, "revoke then re-grant to anon, owner stays off anon");

assertGrantAudit(`
grant execute on function public.smart_inventory_owner_dashboard(date) to anon;
revoke execute on function public.smart_inventory_owner_dashboard(date) from anon;
`, { revoked: "", owners: "smart_inventory_owner_dashboard", unparsed: 0 }, "owner grant to anon must fail even if later revoked");

assertGrantAudit(`
grant execute on function public.smart_inventory_owner_correct_item(uuid, numeric, text) to public;
`, { revoked: "", owners: "smart_inventory_owner_correct_item", unparsed: 0 }, "owner grant to PUBLIC includes anon");

const restorePath = "supabase/migrations/20260928170206_restore_counter_rpc_grants_to_anon_again.sql";
const restoreSql = readFileSync(restorePath, "utf8");
assert(restoreSql.includes("smart_inventory_is_counter"), "Restore migration must explain that each counter RPC checks smart_inventory_is_counter().");
assert(restoreSql.includes("counter RPC grants still missing for anon") && restoreSql.includes("owner RPCs must never be executable by anon"),
  "Restore migration must assert both the counter grants and the owner revoke.");
assertGrantAudit(restoreSql, { revoked: "", owners: "", unparsed: 0 }, "production restore migration");
assertGrantAudit(sql, { revoked: "", owners: "", unparsed: 0 }, "smart-inventory.sql bootstrap");

let sqlFiles = [];
try {
  sqlFiles = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "*.sql"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch (error) {
  failed = true;
  console.error(`Could not list tracked SQL files: ${error.message}`);
}
assert(sqlFiles.includes(restorePath), "Restore migration must be a tracked SQL file in the grant scan.");
for (const file of sqlFiles) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    failed = true;
    console.error(`${file}: ${error.message}`);
    continue;
  }
  let audit;
  try {
    audit = auditSmartInventoryAnonGrants(text);
  } catch (error) {
    failed = true;
    console.error(`${file}: SQL grant scan failed: ${error.message}`);
    continue;
  }
  if (audit.counterLeftRevoked.length) {
    failed = true;
    console.error(`${file}: EXECUTE on counter RPC(s) revoked from anon without a later re-grant: ${audit.counterLeftRevoked.join(", ")}`);
  }
  if (audit.ownerGrantedToAnon.length) {
    failed = true;
    console.error(`${file}: owner RPC(s) granted to anon or PUBLIC: ${audit.ownerGrantedToAnon.join(", ")}`);
  }
  if (audit.unparsed.length) {
    failed = true;
    console.error(`${file}: unparsed smart-inventory grant/revoke mentioning anon: ${audit.unparsed.join(" | ")}`);
  }
}

// Deterministic model of the database first-save-wins rule: two counters on
// one item cannot both commit, while two different items can commit.
function atomicStore() {
  const rows = new Map();
  return async function save(itemId, actor) {
    await Promise.resolve();
    if (rows.has(itemId)) return { ok: false, code: "already_counted", actor: rows.get(itemId) };
    rows.set(itemId, actor); return { ok: true, actor };
  };
}
const saveSame = atomicStore();
const same = await Promise.all([saveSame("A", "موظف 1"), saveSame("A", "موظف 2")]);
assert(same.filter((x) => x.ok).length === 1 && same.filter((x) => x.code === "already_counted").length === 1, "Concurrent same-item saves must have one winner and one already_counted result.");
const saveDifferent = atomicStore();
const different = await Promise.all([saveDifferent("A", "موظف 1"), saveDifferent("B", "موظف 2")]);
assert(different.every((x) => x.ok), "Different items must be countable concurrently.");

// Independent comparison samples, including a sale after cutoff and the
// required distinction between explicit zero and an untouched blank row.
function classify(expectedAtCutoff, signedMovements, actual, countState) {
  if (countState === "uncounted" || actual === null) return "uncounted";
  const adjusted = expectedAtCutoff + signedMovements.reduce((sum, qty) => sum + qty, 0);
  if (actual === adjusted) return "matched";
  return actual > adjusted ? "increase" : "shortage";
}
assert(classify(47, [], 47, "counted") === "matched", "Exact sample must match.");
assert(classify(30, [], 17, "counted") === "shortage", "Shortage sample failed.");
assert(classify(10, [-2], 8, "counted") === "matched", "Post-cutoff sale adjustment sample failed.");
assert(classify(0, [], 0, "zero") === "matched", "Explicit zero must compare as a counted zero.");
assert(classify(0, [], null, "uncounted") === "uncounted", "Blank must remain uncounted, never zero.");

// Parse the browser module in a minimal static-PWA environment.
const context = vm.createContext({
  window: { tobaccoData: {}, addEventListener() {} }, navigator: { onLine: true }, localStorage: { getItem() { return null; }, setItem() {} },
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" }, Intl, Date, Number, String, Math, JSON, Map, Set, CSS: { escape: (v) => v }, console, setInterval, clearInterval
});
vm.runInContext(moduleSource, context);
assert(typeof context.window.SmartInventory?.render === "function", "Smart inventory browser module failed to initialize.");

if (failed) process.exit(1);
console.log("Smart inventory security, route isolation, concurrency and cache contracts passed.");
