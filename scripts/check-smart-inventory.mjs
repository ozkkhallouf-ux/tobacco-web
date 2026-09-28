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
assert(app.includes("clearNotice() { if (!state.notice) return; state.notice = null; render(); }"), "clearNotice must re-render only when a notice is already showing.");
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

// إغلاق الجرد: الفراغ يُحفظ صفراً فعلياً بنفس حمولة «صفر فعلي» اليدوية.
// الكمية المكتوبة، والصنف المحفوظ، والحجز، وإعادة العد لا تُمس.
const api = context.window.SmartInventory;
const now = Date.parse("2026-09-28T12:00:00Z");
const blank = { id: "blank", countState: "uncounted", recountRequested: false, rowVersion: 4 };
const typed = { id: "typed", countState: "uncounted", recountRequested: false, rowVersion: 2 };
const explicitZeroTyped = { id: "typed-zero", countState: "uncounted", recountRequested: false, rowVersion: 6 };
const saved = { id: "saved", countState: "counted", unit1Qty: 5, rowVersion: 9 };
const savedZero = { id: "saved-zero", countState: "zero", unit1Qty: 0, unit2Qty: 0, damagedUnit1Qty: 0, rowVersion: 3 };
const claimed = { id: "claimed", countState: "uncounted", claimedByDisplayName: "عثمان", claimedByMe: false, claimExpiresAt: "2026-09-28T12:05:00Z", rowVersion: 1 };
const expiredClaim = { id: "expired", countState: "uncounted", claimedByDisplayName: "عثمان", claimedByMe: false, claimExpiresAt: "2026-09-28T11:00:00Z", rowVersion: 8 };
const recount = { id: "recount", countState: "counted", recountRequested: true, rowVersion: 2 };
const notFound = { id: "missing", countState: "uncounted", rowVersion: 1 };
const damaged = { id: "damaged", countState: "uncounted", rowVersion: 1 };
const chosenZero = { id: "chosen-zero", countState: "uncounted", rowVersion: 11 };
const emptyQty = { unit1Qty: "", unit2Qty: "", damagedUnit1Qty: "", countState: "" };
const plan = api.planSessionFinish([
  blank, typed, explicitZeroTyped, saved, savedZero, claimed, expiredClaim, recount, notFound, damaged, chosenZero
], {
  blank: emptyQty,
  typed: { unit1Qty: "5", unit2Qty: "", damagedUnit1Qty: "", countState: "counted" },
  "typed-zero": { unit1Qty: "0", unit2Qty: "", damagedUnit1Qty: "", countState: "counted" },
  saved: emptyQty,
  "saved-zero": emptyQty,
  claimed: emptyQty,
  expired: emptyQty,
  recount: emptyQty,
  missing: { unit1Qty: "", unit2Qty: "", damagedUnit1Qty: "", countState: "not_found" },
  damaged: { unit1Qty: "", unit2Qty: "1", damagedUnit1Qty: "", countState: "damaged" },
  "chosen-zero": { unit1Qty: "", unit2Qty: "", damagedUnit1Qty: "", countState: "zero" }
}, { now, pendingItemIds: ["blank"] });
const zeroIds = plan.zeros.map((item) => item.id).sort();
assert(JSON.stringify(zeroIds) === JSON.stringify(["chosen-zero", "expired"]), `Blank lines eligible for zero were ${zeroIds.join(",")}`);
assert(plan.zeros.every((item) => item.id !== "typed" && item.id !== "typed-zero" && item.id !== "saved" && item.id !== "saved-zero"), "Typed or already saved quantities must stay out of the auto-zero list.");
const blocked = Object.fromEntries(plan.blockers.map((row) => [row.itemId, row.reason]));
assert(blocked.blank === "unsaved", "A line with a pending offline save must not be zeroed.");
assert(blocked.typed === "unsaved" && blocked["typed-zero"] === "unsaved", "A typed quantity, including an explicit 0, must block close instead of being rewritten.");
assert(blocked.claimed === "claimed", "A line claimed by another counter must not be zeroed.");
assert(blocked.recount === "recount", "A recount request must not be auto-zeroed.");
assert(blocked.missing === "unsaved" && blocked.damaged === "unsaved", "An explicit not-found or damaged line must not be collapsed to zero.");
assert(!("saved" in blocked) && !("saved-zero" in blocked), "Saved lines are untouched and are not blockers.");
const manualZero = api.parseCountInput("zero", "", "", "");
const autoZero = api.zeroCountPayload(expiredClaim);
assert(autoZero.countState === "zero" && autoZero.unit1Qty === 0 && autoZero.unit2Qty === 0 && autoZero.damagedUnit1Qty === 0, "Auto-zero payload must be an actual zero count.");
assert(autoZero.countState === manualZero.countState && autoZero.unit1Qty === manualZero.unit1Qty && autoZero.unit2Qty === manualZero.unit2Qty && autoZero.damagedUnit1Qty === manualZero.damagedUnit1Qty, "Auto-zero must match a manual «صفر فعلي» save.");
assert(autoZero.expectedVersion === 8, "Auto-zero must send the row version a manual save would send.");
let blankSaveRejected = false;
try { api.parseCountInput("counted", "", "", ""); } catch (error) { blankSaveRejected = /إغلاق الجرد/.test(error.message); }
assert(blankSaveRejected, "Saving one blank line from its own button must still refuse to treat that blank as zero.");
assert(api.finishZeroConfirmText(1) === "صنف واحد بلا كمية وسيُحتسب صفراً فعلياً. المتابعة وإغلاق الجرد؟", api.finishZeroConfirmText(1));
assert(api.finishZeroConfirmText(2) === "صنفان بلا كمية وسيُحتسبان صفراً فعلياً. المتابعة وإغلاق الجرد؟", api.finishZeroConfirmText(2));
assert(api.finishZeroConfirmText(3) === "3 أصناف بلا كمية وستُحتسب صفراً فعلياً. المتابعة وإغلاق الجرد؟", api.finishZeroConfirmText(3));
const confirmText = api.finishZeroConfirmText(12);
assert(confirmText === "12 صنفاً بلا كمية وسيُحتسب صفراً فعلياً. المتابعة وإغلاق الجرد؟", `Confirm text missing the count: ${confirmText}`);
assert(api.finishZeroSuccessText(1) === "تم إغلاق الجرد. صنف واحد فارغ حُسب صفراً فعلياً.", api.finishZeroSuccessText(1));
assert(api.finishZeroSuccessText(2) === "تم إغلاق الجرد. صنفان فارغان حُسبا صفراً فعلياً.", api.finishZeroSuccessText(2));
assert(api.finishZeroSuccessText(3) === "تم إغلاق الجرد. 3 أصناف فارغة حُسبت صفراً فعلياً.", api.finishZeroSuccessText(3));
assert(api.finishZeroSuccessText(12) === "تم إغلاق الجرد. 12 صنفاً فارغاً حُسب صفراً فعلياً.", api.finishZeroSuccessText(12));
assert(api.finishBlockedMessage([{ reason: "unsaved" }]).includes("صنف واحد كُتبت"), "Blocked text for one unsaved line");
assert(api.finishBlockedMessage([{ reason: "claimed" }, { reason: "claimed" }]).includes("صنفان يحجزهما"), "Blocked text for two claims");
assert(api.finishBlockedMessage([{ reason: "recount" }, { reason: "recount" }, { reason: "recount" }]).includes("3 أصناف بانتظار"), "Blocked text for three recounts");
assert(api.finishBlockedMessage(Array.from({ length: 11 }, () => ({ reason: "unsaved" }))).includes("11 صنفاً كُتبت"), "Blocked text for eleven unsaved lines");
const blockedText = api.finishBlockedMessage(plan.blockers);
assert(blockedText.includes("لم يُحتسب أي صنف فارغ صفراً") && blockedText.includes("يحجزه") && blockedText.includes("إعادة عد"), `Blocked close text incomplete: ${blockedText}`);
const openPlan = api.planSessionFinish([blank, saved], { blank: emptyQty, saved: { unit1Qty: "5", unit2Qty: "", damagedUnit1Qty: "", countState: "counted" } }, { now });
assert(openPlan.blockers.length === 0 && openPlan.zeros.length === 1 && openPlan.zeros[0].id === "blank", "A truly empty uncounted line is the only finish-time zero.");

// finishSession itself: a slow save must lock the row, a mid-loop claim or
// already_counted must not be counted as this client's zero, and a lost
// response must refresh the lines the server already stored.
context.setInterval = () => 0;
context.clearInterval = () => {};
const store = context.window.tobaccoData;
const counterUser = { accessRole: "inventory_counter", name: "موظف" };

function finishHarness(items) {
  api.reset();
  const inputs = new Map();
  api.state.session = {
    id: "sess-finish",
    status: "in_progress",
    warehouseName: "مستودع الاختبار",
    items: items.map((item) => ({ recountRequested: false, claimedByMe: false, countState: "uncounted", rowVersion: 1, unit1Name: "كروز", ...item }))
  };
  const cards = new Map(api.state.session.items.map((item) => {
    const fields = {
      unit1Qty: { value: "" },
      unit2Qty: { value: "" },
      damagedUnit1Qty: { value: "" }
    };
    inputs.set(item.id, fields);
    const status = { value: "" };
    return [item.id, {
      querySelector(selector) {
        const qty = /data-smart-qty="([^"]+)"/.exec(selector || "");
        if (qty) return fields[qty[1]] || { value: "" };
        if (selector === "[data-smart-state]") return status;
        return null;
      }
    }];
  }));
  const root = {
    querySelector(selector) {
      const id = /data-smart-item-card="([^"]+)"/.exec(selector || "");
      return id ? cards.get(id[1]) || null : null;
    },
    querySelectorAll() { return []; }
  };
  const hooks = { html: "", notices: [] };
  api.bind(root, counterUser, {
    render() { hooks.html = api.render(counterUser); },
    notice(type, text) { hooks.notices.push({ type, text }); },
    clearNotice() {}
  });
  return { root, hooks, inputs };
}

function rowControlsLocked(html, id) {
  const chunk = (html.split(`data-smart-item-card="${id}"`)[1] || "").split("data-smart-item-card")[0];
  return /data-smart-qty="unit1Qty"[^>]*disabled/.test(chunk)
    && /data-smart-state[^>]*disabled/.test(chunk)
    && new RegExp(`data-smart-save="${id}"[^>]*disabled`).test(chunk);
}

{
  const harness = finishHarness([
    { id: "a", itemName: "أول", rowVersion: 3 },
    { id: "b", itemName: "ثان", rowVersion: 4 }
  ]);
  const saves = [];
  let releaseFirst;
  store.saveSmartInventoryItem = (entry) => {
    saves.push(entry);
    if (saves.length === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, code: "saved" }); });
    return Promise.resolve({ ok: true, code: "saved" });
  };
  let completed = 0;
  store.completeSmartInventorySession = async () => { completed += 1; return { ok: true, code: "completed" }; };
  store.getSmartInventoryCounterSession = async () => api.state.session;
  context.window.confirm = () => true;
  const pending = api.finishSession(harness.root, counterUser);
  assert(api.state.finishing === true, "The zeroing loop must set finishing before the first save resolves.");
  assert(saves.length === 1 && saves[0].itemId === "a" && saves[0].countState === "zero" && saves[0].expectedVersion === 3, "The first blank line was not saved as zero.");
  assert(rowControlsLocked(harness.hooks.html, "a") && rowControlsLocked(harness.hooks.html, "b"), `Row controls stayed editable during finish: ${harness.hooks.html.slice(0, 500)}`);
  assert(/data-smart-back[^>]*disabled/.test(harness.hooks.html), "Back stayed enabled during the zeroing loop.");
  await api.saveItem("b", harness.root, counterUser);
  assert(saves.length === 1, "حفظ الصنف ran while the zeroing loop was in progress.");
  releaseFirst();
  await pending;
  assert(completed === 1 && saves.map((row) => row.itemId).join(",") === "a,b", `Slow finish saved ${saves.map((row) => row.itemId).join(",")} and completed ${completed} times.`);
  const success = harness.hooks.notices.filter((row) => row.type === "success").pop();
  assert(success?.text === api.finishZeroSuccessText(2), `Slow finish success text: ${success?.text}`);
  assert(api.state.finishing === false, "finishing stayed set after the loop.");
}

{
  const harness = finishHarness([
    { id: "a", itemName: "أول", rowVersion: 1 },
    { id: "b", itemName: "ثان", rowVersion: 2 }
  ]);
  const server = new Map([["a", "uncounted"], ["b", "uncounted"]]);
  let completed = 0;
  store.saveSmartInventoryItem = async (entry) => {
    if (entry.itemId === "b") return { ok: false, code: "claimed", claimedByDisplayName: "عثمان" };
    server.set(entry.itemId, "zero");
    return { ok: true, code: "saved" };
  };
  store.completeSmartInventorySession = async () => { completed += 1; return { ok: true }; };
  store.getSmartInventoryCounterSession = async () => ({
    id: "sess-finish", status: "in_progress", warehouseName: "مستودع الاختبار",
    items: [...server.entries()].map(([id, countState]) => ({ id, itemName: id === "a" ? "أول" : "ثان", countState, unit1Qty: countState === "zero" ? 0 : null, rowVersion: 2, recountRequested: false }))
  });
  context.window.confirm = () => true;
  await api.finishSession(harness.root, counterUser);
  const abort = harness.hooks.notices.filter((row) => row.type === "error").pop();
  assert(completed === 0, "A mid-loop claim still closed the session.");
  assert(abort?.text.includes("لم يُغلق الجرد") && abort.text.includes("صنف واحد حُفظ صفراً") && abort.text.includes("أول") && !abort.text.includes("ثان"), `Claim abort text: ${abort?.text}`);
  assert(api.state.session.items.find((row) => row.id === "a")?.countState === "zero", "The line already stored as zero did not show as counted after the claim refresh.");
}

{
  const harness = finishHarness([
    { id: "a", itemName: "أول" },
    { id: "b", itemName: "ثان" },
    { id: "c", itemName: "ثالث" }
  ]);
  const savedIds = [];
  store.saveSmartInventoryItem = async (entry) => {
    if (entry.itemId === "b") return { ok: false, code: "already_counted", countedByDisplayName: "عثمان" };
    savedIds.push(entry.itemId);
    return { ok: true, code: "saved" };
  };
  let completed = 0;
  store.completeSmartInventorySession = async () => { completed += 1; return { ok: true, code: "completed" }; };
  store.getSmartInventoryCounterSession = async () => api.state.session;
  context.window.confirm = () => true;
  await api.finishSession(harness.root, counterUser);
  const success = harness.hooks.notices.filter((row) => row.type === "success").pop();
  assert(completed === 1 && savedIds.join(",") === "a,c", `already_counted was treated as a zero save: ${savedIds.join(",")}`);
  assert(success?.text === api.finishZeroSuccessText(2), `already_counted inflated the success sentence: ${success?.text}`);
}

{
  const harness = finishHarness([
    { id: "a", itemName: "أول", rowVersion: 1 },
    { id: "b", itemName: "ثان", rowVersion: 2 }
  ]);
  const server = new Map([["a", "uncounted"], ["b", "uncounted"]]);
  let completed = 0;
  store.saveSmartInventoryItem = async (entry) => {
    server.set(entry.itemId, "zero");
    if (entry.itemId === "b") throw new Error("تعذر الاتصال بالخادم");
    return { ok: true, code: "saved" };
  };
  store.completeSmartInventorySession = async () => { completed += 1; return { ok: true }; };
  store.getSmartInventoryCounterSession = async () => ({
    id: "sess-finish", status: "in_progress", warehouseName: "مستودع الاختبار",
    items: [...server.entries()].map(([id, countState]) => ({ id, itemName: id === "a" ? "أول" : "ثان", countState, unit1Qty: 0, unit2Qty: 0, damagedUnit1Qty: 0, rowVersion: 3, recountRequested: false }))
  });
  context.window.confirm = () => true;
  await api.finishSession(harness.root, counterUser);
  const warning = harness.hooks.notices.filter((row) => row.type === "warning").pop();
  assert(completed === 0, "A lost response still closed the session.");
  assert(api.state.session.items.every((row) => row.countState === "zero"), "Lines the server stored as zero stayed uncounted after the lost response.");
  assert(warning?.text.includes("صنفان حُفظا صفراً") && warning.text.includes("أول") && warning.text.includes("ثان"), `Lost-response notice: ${warning?.text}`);
}

{
  const harness = finishHarness([{ id: "a", itemName: "أول" }]);
  let confirmed = false;
  let saves = 0;
  context.navigator.onLine = false;
  context.window.confirm = () => { confirmed = true; return true; };
  store.saveSmartInventoryItem = async () => { saves += 1; return { ok: true }; };
  await api.finishSession(harness.root, counterUser);
  context.navigator.onLine = true;
  assert(!confirmed && saves === 0, "Offline close asked for confirmation or wrote a zero.");
  assert(harness.hooks.notices.some((row) => row.type === "warning" && row.text.includes("دون اتصال")), "Offline close did not warn before confirmation.");
}

{
  const harness = finishHarness([
    { id: "a", itemName: "أول" },
    { id: "b", itemName: "ثان" }
  ]);
  let saves = 0;
  context.window.confirm = () => {
    harness.inputs.get("b").unit1Qty.value = "8";
    return true;
  };
  store.saveSmartInventoryItem = async () => { saves += 1; return { ok: true }; };
  store.completeSmartInventorySession = async () => { saves += 10; return { ok: true }; };
  await api.finishSession(harness.root, counterUser);
  assert(saves === 0, "A quantity typed before the writes were still zeroed.");
  assert(harness.hooks.notices.some((row) => row.type === "error" && row.text.includes("لم يُحتسب أي صنف فارغ صفراً")), "The refreshed plan did not stop the close.");
}

{
  const harness = finishHarness([{ id: "a", itemName: "أول" }]);
  store.saveSmartInventoryItem = async () => ({ ok: true, code: "saved" });
  store.completeSmartInventorySession = async () => ({ ok: true, code: "completed" });
  store.getSmartInventoryCounterSession = async () => { throw new Error("تعذر تحديث الجلسة"); };
  context.window.confirm = () => true;
  await api.finishSession(harness.root, counterUser);
  const success = harness.hooks.notices.filter((row) => row.type === "success").pop();
  assert(success?.text === api.finishZeroSuccessText(1), `Post-close refresh replaced the success notice: ${harness.hooks.notices.map((row) => row.text).join(" | ")}`);
  assert(!harness.hooks.notices.some((row) => row.text.includes("تعذر تحديث الجلسة")), "A failed refresh after close showed its own error.");
  assert(api.state.session.status === "completed", "The closed session flipped back to open when refresh failed.");
}

{
  const harness = finishHarness([
    { id: "a", itemName: "أول" },
    { id: "b", itemName: "ثان" }
  ]);
  const original = api.state.session;
  let completedId = null;
  let releaseFirst;
  store.saveSmartInventoryItem = () => {
    if (!releaseFirst) return new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, code: "saved" }); });
    return Promise.resolve({ ok: true, code: "saved" });
  };
  store.completeSmartInventorySession = async (sessionId) => {
    completedId = sessionId;
    return { ok: true, code: "completed" };
  };
  store.getSmartInventoryCounterSession = async (sessionId) => ({
    id: sessionId,
    status: sessionId === original.id ? "completed" : "in_progress",
    warehouseName: sessionId === original.id ? "مستودع الاختبار" : "مستودع آخر",
    items: []
  });
  store.listSmartInventoryWarehouses = async () => [];
  context.window.confirm = () => true;
  const pending = api.finishSession(harness.root, counterUser);
  api.state.session = { id: "sess-other", status: "in_progress", warehouseName: "مستودع آخر", items: [] };
  releaseFirst();
  await pending;
  assert(completedId === "sess-finish", `Finish followed the UI session instead of the pinned one: ${completedId}`);
  assert(original.status === "completed", "The original session was not marked completed after a mid-loop warehouse switch.");
}

{
  const harness = finishHarness([{ id: "a", itemName: "أول" }]);
  const original = api.state.session;
  let completedId = null;
  let releaseFirst;
  store.saveSmartInventoryItem = () => new Promise((resolve) => { releaseFirst = () => resolve({ ok: true, code: "saved" }); });
  store.completeSmartInventorySession = async (sessionId) => {
    completedId = sessionId;
    return { ok: true, code: "completed" };
  };
  store.getSmartInventoryCounterSession = async (sessionId) => ({ id: sessionId, status: "completed", items: [] });
  store.listSmartInventoryWarehouses = async () => [];
  context.window.confirm = () => true;
  const pending = api.finishSession(harness.root, counterUser);
  api.state.session = null;
  releaseFirst();
  await pending;
  assert(completedId === "sess-finish", `Finish threw or skipped complete after Back cleared the session: ${completedId}`);
  assert(original.status === "completed", "The original session was not marked completed after Back during zeroing.");
}

if (failed) process.exit(1);
console.log("Smart inventory security, route isolation, concurrency and cache contracts passed.");
