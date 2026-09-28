import { readFileSync } from "node:fs";
import vm from "node:vm";

let failed = false;
function assert(condition, message) { if (!condition) { failed = true; console.error(message); } }
function section(source, start, end) {
  const from = source.indexOf(start); const to = source.indexOf(end, from + start.length);
  return from >= 0 ? source.slice(from, to >= 0 ? to : source.length) : "";
}

const sql = readFileSync("supabase/smart-inventory.sql", "utf8");
const selfCorrectionMigration = readFileSync("supabase/migrations/20260928183000_smart_inventory_counter_self_correction.sql", "utf8");
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
assert(/if not public\.smart_inventory_is_counter\(\)/.test(saveRpc), "Save stays behind smart_inventory_is_counter().");
const claimRpc = section(sql, "create or replace function public.smart_inventory_claim_item", "create or replace function public.smart_inventory_save_item");
const ownOpenGuard = "v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by is distinct from auth.uid()";
assert(saveRpc.includes(ownOpenGuard), "Save must reject another counter's row and allow the original counter.");
assert(claimRpc.includes(ownOpenGuard), "Claim must reject another counter's row and allow the original counter to reopen it.");
assert(/v_session\.status<>'in_progress'/.test(saveRpc) && /v_session\.status<>'in_progress'/.test(claimRpc), "A completed session still blocks claim and save.");
assert(saveRpc.includes("self_correction") && /v_kind in \('primary','self_correction'\)/.test(saveRpc), "Own correction must update the stored quantity as attempt_kind self_correction.");
assert(/item_self_corrected/.test(saveRpc), "Own correction must keep an audit row distinct from the first count.");
assert(/smart_inventory_participants/.test(saveRpc) && /p\.user_id=auth\.uid\(\)/.test(saveRpc), "Own correction requires the counter to be a participant of that session.");
assert(counterPayload.includes("'countedByMe',coalesce(i.counted_by = auth.uid(), false)"), "Counter payload must expose countedByMe without another user's id.");
assert(!/'countedBy'\s*,\s*i\.counted_by/.test(counterPayload), "Counter payload must not return the counted_by uuid.");
assert(sql.includes("'primary','recount','owner_correction','self_correction'"), "attempt_kind check must include self_correction.");
assert(selfCorrectionMigration.includes(ownOpenGuard) && selfCorrectionMigration.includes("self_correction"), "Pending migration must carry the same own-correction guard.");
assert(!/grant execute on function public\.smart_inventory_owner_/i.test(selfCorrectionMigration), "Self-correction migration must not grant owner RPCs.");
assert(/revoke all on function public\.smart_inventory_owner_dashboard\(date\)/i.test(selfCorrectionMigration), "Self-correction migration must keep owner RPCs revoked from anon.");
assert(/to anon,\s*authenticated/.test(selfCorrectionMigration) && /smart_inventory_save_item\(uuid,uuid,text,numeric,numeric,numeric,bigint\)/.test(selfCorrectionMigration), "Counter save RPC stays executable by anon.");

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

// Deterministic model of the database first-save-wins rule: two counters on
// one item cannot both commit, while two different items can commit.
function atomicStore() {
  const rows = new Map();
  return async function save(itemId, actor, options = {}) {
    const sessionStatus = options.sessionStatus || "in_progress";
    const participant = options.participant !== false;
    await Promise.resolve();
    if (sessionStatus !== "in_progress") return { ok: false, code: "session_closed" };
    const existing = rows.get(itemId);
    if (existing) {
      const own = existing.actor === actor && participant;
      if (!own) return { ok: false, code: "already_counted", actor: existing.actor };
      existing.kind = "self_correction";
      return { ok: true, code: "self_correction", actor };
    }
    rows.set(itemId, { actor, kind: "primary" });
    return { ok: true, code: "primary", actor };
  };
}
const saveSame = atomicStore();
const same = await Promise.all([saveSame("A", "موظف 1"), saveSame("A", "موظف 2")]);
assert(same.filter((x) => x.ok).length === 1 && same.filter((x) => x.code === "already_counted").length === 1, "Concurrent same-item saves must have one winner and one already_counted result.");
const saveDifferent = atomicStore();
const different = await Promise.all([saveDifferent("A", "موظف 1"), saveDifferent("B", "موظف 2")]);
assert(different.every((x) => x.ok), "Different items must be countable concurrently.");
const correctOwn = atomicStore();
assert((await correctOwn("A", "موظف 1")).code === "primary", "First save stays a primary count.");
const edited = await correctOwn("A", "موظف 1");
assert(edited.ok && edited.code === "self_correction", "The same counter can correct their own open count.");
assert((await correctOwn("A", "موظف 2")).code === "already_counted", "A different counter still cannot overwrite a saved count.");
assert((await correctOwn("A", "موظف 1", { participant: false })).code === "already_counted", "A counter who is not a participant of the session cannot correct the row.");
const closed = atomicStore();
assert((await closed("A", "موظف 1", { sessionStatus: "completed" })).code === "session_closed", "A completed session rejects a new count.");
assert((await correctOwn("A", "موظف 1", { sessionStatus: "completed" })).code === "session_closed", "A completed session rejects correcting an already counted row.");

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
assert(typeof context.window.SmartInventory?.canCounterCorrect === "function", "Counter correction rule must be testable.");
const rule = context.window.SmartInventory.canCounterCorrect;
assert(rule({ countedByMe: true, countState: "counted", recountRequested: false }, "in_progress") === true, "Own open count can be corrected.");
assert(rule({ countedByMe: false, countState: "counted", recountRequested: false }, "in_progress") === false, "Another counter's row cannot be corrected.");
assert(rule({ countedByMe: true, countState: "counted", recountRequested: false }, "completed") === false, "A completed session cannot be corrected from the counter screen.");
assert(rule({ countedByMe: true, countState: "not_found", recountRequested: true }, "in_progress") === false, "An owner recount still requires the other-counter path.");
assert(rule({ countedByMe: true, countState: "uncounted" }, "in_progress") === false, "An uncounted row is a first save, not a correction.");

const si = context.window.SmartInventory;
si.state.session = {
  id: "s", status: "in_progress", warehouseName: "مستودع الاختبار", cutoffAt: "2026-09-28T05:00:00.000Z",
  items: [
    { id: "own", itemCode: "11", itemName: "صنف الموظف", unit1Name: "كروز", unit2Factor: 1, countState: "counted", unit1Qty: 4, unit2Qty: 0, damagedUnit1Qty: 0, countedByMe: true, countedByDisplayName: "أمين", countedAt: "2026-09-28T06:00:00.000Z", recountRequested: false, rowVersion: 3 },
    { id: "other", itemCode: "22", itemName: "صنف الزميل", unit1Name: "كروز", unit2Factor: 1, countState: "damaged", unit1Qty: 9, unit2Qty: 0, damagedUnit1Qty: 1, countedByMe: false, countedByDisplayName: "عثمان", recountRequested: false, rowVersion: 1 },
    { id: "fresh", itemCode: "33", itemName: "صنف جديد", unit1Name: "كروز", unit2Factor: 1, countState: "uncounted", countedByMe: false, rowVersion: 0 }
  ]
};
const counterSessionArg = { accessRole: "inventory_counter", name: "أمين" };
const lockedHtml = si.render(counterSessionArg);
assert(lockedHtml.includes('data-smart-edit="own"'), "Own counted item must offer تعديل الصنف.");
assert(!lockedHtml.includes('data-smart-edit="other"'), "Another counter's item must not offer edit.");
assert(/data-item-id="own"[^>]*disabled/.test(lockedHtml), "Own item stays read-only until it is opened.");
assert(/data-item-id="other"[^>]*disabled/.test(lockedHtml), "Another counter's item stays disabled.");
assert(!/data-smart-qty="unit1Qty" data-item-id="fresh"[^>]*disabled/.test(lockedHtml), "An uncounted item stays editable.");
assert(lockedHtml.includes("يمكنك تعديله قبل إغلاق الجرد"), "Own item explains that correction is possible before close.");
assert(lockedHtml.includes("عثمان"), "Another counter's lock names who counted it.");
si.state.editingItemId = "own";
const openHtml = si.render(counterSessionArg);
assert(openHtml.includes("حفظ التعديل"), "Opening an own item shows a correction save.");
assert(openHtml.includes("غير موجود في موقعه") && openHtml.includes("تالف"), "Correction can change state to not-found or damaged.");
assert(!/data-smart-qty="unit1Qty" data-item-id="own"[^>]*disabled/.test(openHtml), "Opened own item inputs must accept a new quantity.");
si.state.session.status = "completed";
si.state.editingItemId = "";
const closedHtml = si.render(counterSessionArg);
assert(!closedHtml.includes("data-smart-edit"), "A completed session removes the correction control.");
assert(/data-item-id="own"[^>]*disabled/.test(closedHtml), "A completed session keeps the quantity locked.");

if (failed) process.exit(1);
console.log("Smart inventory security, route isolation, concurrency and cache contracts passed.");
