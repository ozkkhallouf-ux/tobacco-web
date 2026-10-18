// ============================================================================
// شريط حالة مزامنة الأسعار في صفحة الأسعار (src/price-sync-status.js) — المرحلة الثانية.
// وظيفي: ربط الحالة الخماسية بالشريط، والتوقيت بدمشق، والأعداد، وآخر فشل، وتحذير الحفظ.
// أمني: قراءة فقط، بلا writer_id ولا host، وفشل القراءة = UNKNOWN لا نجاح وهمي، وتهريب HTML.
// كل البيانات مصطنعة؛ لا شبكة ولا إنتاج.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../src/price-sync-health.js";
import "../src/price-sync-status.js";

const engine = globalThis.ozkPriceSyncHealth;
const ui = globalThis.ozkPriceSyncStatus;
assert.ok(engine && ui, "price-sync-health.js وprice-sync-status.js يجب أن يعرّفا واجهتيهما");

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error?.stack || error}`); }
}

// 14:40 دمشق = 11:40 UTC
const NOW = new Date("2026-10-18T11:40:00.000Z");
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();

function attempt(minutesAgo, outcome, extra = {}) {
  const proven = ["applied", "no_changes"].includes(outcome);
  return {
    received_at: ago(minutesAgo),
    kind: "attempt",
    outcome,
    last_success_at: proven ? ago(minutesAgo) : null,
    last_ameen_contact_at: ago(minutesAgo),
    summary: Object.assign({
      schema: engine.SCHEMA, kind: "attempt", host: "OZK2026",
      attempt_started_at: ago(minutesAgo + 0.3), attempt_finished_at: ago(minutesAgo), outcome,
      ameen_contact_at: ["pull_failed", "ameen_unreachable"].includes(outcome) ? null : ago(minutesAgo),
      sent_count: 321, applied_wholesale: 321, applied_retail: 317, not_in_ameen: 0, conflict_count: 0,
      verify: { wholesale_matched: 321, retail_matched: 317, mismatches: 0, missing: 0 }
    }, extra)
  };
}
function probe(minutesAgo, task = {}) {
  return {
    received_at: ago(minutesAgo), kind: "task_probe", outcome: null,
    summary: { schema: engine.SCHEMA, kind: "task_probe", host: "OZK2026", probed_at: ago(minutesAgo),
      task: Object.assign({ name: "TOBACCO Approved Prices Pull", exists: true, enabled: true, state: "Ready" }, task) }
  };
}
const fact = (model, label) => (model.facts.find((f) => f.label === label) || {}).value;

// عميل supabase-js مزيّف يسجّل كل نداء، ويرمي إن طُلبت أي كتابة.
function fakeClient({ rows = [], error = null, session = { user: { id: "x" } }, throwOnSelect = false } = {}) {
  const calls = [];
  const forbidden = (name) => () => { throw new Error(`write method called: ${name}`); };
  const query = {
    select(columns) { calls.push(["select", columns]); if (throwOnSelect) throw new Error("network down"); return query; },
    order(column, options) { calls.push(["order", column, options]); return query; },
    limit(n) { calls.push(["limit", n]); return Promise.resolve({ data: error ? null : rows, error }); },
    insert: forbidden("insert"), update: forbidden("update"), upsert: forbidden("upsert"), delete: forbidden("delete")
  };
  return {
    calls,
    auth: { getSession: async () => ({ data: { session } }) },
    from(table) { calls.push(["from", table]); return query; },
    rpc: forbidden("rpc")
  };
}

await test("نجاح حديث ⇒ HEALTHY مع آخر نجاح مثبت وآخر محاولة بتوقيت دمشق والأعداد", () => {
  const model = ui.buildModel(engine, [attempt(2, "applied"), probe(3)], { now: NOW });
  assert.equal(model.state, "HEALTHY");
  assert.equal(model.level, "ok");
  assert.equal(fact(model, "آخر نجاح مثبت"), "14:38");
  assert.equal(fact(model, "آخر محاولة"), "14:38");
  assert.equal(fact(model, "المطبَّق"), "جملة 321 — مفرق 317");
  assert.equal(fact(model, "التعارضات"), "0 تعارض — 0 غير موجود بالأمين");
  assert.equal(fact(model, "لم تصل للأمين (مثبت بالفحص)"), undefined, "لا عدد معلّق بلا فروق مثبتة");
});

await test("نجاح قديم (20 دقيقة) ⇒ STALE لا HEALTHY", () => {
  const model = ui.buildModel(engine, [attempt(20, "applied"), probe(2)], { now: NOW });
  assert.equal(model.state, "STALE");
  assert.notEqual(model.level, "ok");
  assert.match(model.title, /المزامنة متوقفة منذ 14:20/);
});

await test("فشل الاتصال بالأمين ⇒ FAILED مع سبب آخر فشل ووقته", () => {
  const model = ui.buildModel(engine, [attempt(1, "ameen_unreachable"), attempt(6, "applied")], { now: NOW });
  assert.equal(model.state, "FAILED");
  assert.equal(model.level, "error");
  assert.equal(fact(model, "آخر فشل"), "تعذّر الاتصال بقاعدة الأمين — 14:39");
  assert.equal(fact(model, "آخر نجاح مثبت"), "14:34");
});

await test("سليمة الآن بعد فشل سابق ⇒ HEALTHY مع إظهار آخر فشل", () => {
  const model = ui.buildModel(engine, [attempt(1, "applied"), attempt(6, "pull_failed")], { now: NOW });
  assert.equal(model.state, "HEALTHY");
  assert.equal(fact(model, "آخر فشل"), "تعذّر سحب الأسعار من الموقع — 14:34");
});

await test("فروق مثبتة بالفحص ⇒ FAILED ويُعرض عدد ما لم يصل للأمين", () => {
  const model = ui.buildModel(engine, [attempt(1, "verify_mismatch", { verify: { mismatches: 3, missing: 1 } })], { now: NOW });
  assert.equal(model.state, "FAILED");
  assert.equal(fact(model, "لم تصل للأمين (مثبت بالفحص)"), "4 سعر");
});

await test("تعارضات ⇒ FAILED مع عدد التعارضات", () => {
  const model = ui.buildModel(engine, [attempt(1, "applied_with_conflicts", { conflict_count: 2, not_in_ameen: 1 })], { now: NOW });
  assert.equal(model.state, "FAILED");
  assert.equal(fact(model, "التعارضات"), "2 تعارض — 1 غير موجود بالأمين");
});

await test("المهمة معطّلة ⇒ DISABLED حتى مع نجاح حديث", () => {
  const model = ui.buildModel(engine, [attempt(1, "applied"), probe(2, { enabled: false, state: "Disabled" })], { now: NOW });
  assert.equal(model.state, "DISABLED");
  assert.equal(model.level, "error");
});

await test("لا صفوف (غير موظف بحكم RLS، أو لا نبض بعد) ⇒ UNKNOWN", () => {
  const model = ui.buildModel(engine, [], { now: NOW });
  assert.equal(model.state, "UNKNOWN");
  assert.equal(model.level, "unknown");
});

await test("نجاح بلا إثبات ⇒ ليس HEALTHY", () => {
  const model = ui.buildModel(engine, [attempt(1, "applied", { ameen_contact_at: null })], { now: NOW });
  assert.notEqual(model.state, "HEALTHY");
});

await test("القراءة: جدول price_sync_heartbeats، أعمدة العرض فقط بلا writer_id ولا host، الأحدث أولاً، 20 صفاً", async () => {
  const client = fakeClient({ rows: [attempt(1, "applied")] });
  const model = await ui.loadModel({ engine, client, now: NOW });
  assert.equal(model.state, "HEALTHY");
  assert.deepEqual(client.calls[0], ["from", "price_sync_heartbeats"]);
  const columns = client.calls.find((c) => c[0] === "select")[1];
  assert.doesNotMatch(columns, /writer_id|host|\*/);
  assert.deepEqual(client.calls.find((c) => c[0] === "order"), ["order", "received_at", { ascending: false }]);
  assert.deepEqual(client.calls.find((c) => c[0] === "limit"), ["limit", 20]);
});

for (const [name, options] of [
  ["خطأ صلاحية/RLS من Supabase", { client: fakeClient({ error: { message: "permission denied for table price_sync_heartbeats" } }) }],
  ["خطأ شبكة", { client: fakeClient({ throwOnSelect: true }) }],
  ["بلا جلسة", { client: fakeClient({ session: null, rows: [attempt(1, "applied")] }) }],
  ["بلا عميل Supabase", { client: null }]
]) {
  await test(`فشل القراءة (${name}) ⇒ UNKNOWN «تعذّر قراءة حالة المزامنة» لا نجاح وهمي`, async () => {
    const model = await ui.loadModel({ engine, now: NOW, ...options, client: options.client || { nope: true } });
    assert.equal(model.state, "UNKNOWN");
    assert.equal(model.title, ui.READ_FAILED_TEXT);
    assert.equal(ui.saveWarningFor(model).length > 0, true);
  });
}

await test("الشريط يهرّب كل النصوص (لا حقن HTML)", () => {
  const html = ui.renderHtml({ state: "FAILED", level: "error", icon: "❌", title: "<img src=x onerror=alert(1)>", detail: "\"'&", facts: [{ label: "<b>", value: "<script>x</script>" }] });
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /role="status"/);
  assert.match(html, /data-state="FAILED"/);
  assert.match(html, /class="price-sync-status is-failed"/);
});

await test("كل حالة تأخذ صنفها البصري", () => {
  const map = { ok: "is-healthy", warn: "is-stale", error: "is-failed", unknown: "is-unknown" };
  for (const [level, cls] of Object.entries(map)) {
    assert.match(ui.renderHtml({ state: "X", level, icon: "", title: "t", detail: "", facts: [] }), new RegExp(cls));
  }
});

await test("تحذير الحفظ: لا شيء إن كانت سليمة، ونص صريح لغير ذلك", () => {
  assert.equal(ui.saveWarningFor({ state: "HEALTHY", title: "x" }), "");
  assert.match(ui.saveWarningFor({ state: "STALE", title: "المزامنة متوقفة منذ 14:20" }), /لن يصل للأمين/);
  assert.match(ui.saveWarningFor(null), /غير معروفة/);
});

await test("حارس المصدر: قراءة فقط ولا هوية حساب", () => {
  const code = readFileSync("src/price-sync-status.js", "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.(insert|update|upsert|delete|rpc)\s*\(/);
  assert.doesNotMatch(code, /writer_id|SERVICE_KEY|service_role|localStorage\.setItem/);
  assert.doesNotMatch(code, /console\.error/, "فشل القراءة متوقَّع (غير موظف/بلا شبكة) ولا يُطبع خطأً");
});

await test("الربط: index.html يحمّل المصنِّف قبل app.js والشريط بعده، والـService Worker يخزّنهما", () => {
  const html = readFileSync("index.html", "utf8");
  const pos = (name) => html.indexOf(`src="src/${name}?v=`);
  assert.ok(pos("price-sync-health.js") > 0 && pos("price-sync-health.js") < pos("app.js"));
  assert.ok(pos("price-sync-status.js") > pos("app.js"));
  const sw = readFileSync("public/service-worker.js", "utf8");
  assert.match(sw, /"src\/price-sync-health\.js"/);
  assert.match(sw, /"src\/price-sync-status\.js"/);
});

await test("app.js: الحفظ يُلحق التحذير ولا يُمنع", () => {
  const app = readFileSync("src/app.js", "utf8");
  const fn = app.match(/async function savePricingItem\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(fn, /window\.ozkPriceSyncStatus\?\.saveWarning\?\.\(\)/);
  const warnIndex = fn.indexOf("saveWarning");
  const upsertIndex = fn.indexOf("upsertApprovedPriceItems");
  assert.ok(upsertIndex > 0 && warnIndex > upsertIndex, "التحذير بعد الحفظ الفعلي لا قبله");
});

console.log(results.join("\n"));
if (failed) {
  console.error(`check-price-sync-status: ${failed} فحص فاشل.`);
  process.exit(1);
}
console.log(`check-price-sync-status: اجتاز ${results.length} فحصاً.`);
