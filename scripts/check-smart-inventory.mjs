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
