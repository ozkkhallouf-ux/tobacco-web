// ============================================================================
// فحص تدقيق النشرة مقابل التكلفة (src/price-cost-audit.js) وربطه بالصفحة.
// كل الأصناف والأرقام مصطنعة؛ لا بيانات إنتاج ولا شبكة.
// القاعدة المحمية: لا حكم «تحت التكلفة» بلا إثبات قابلية المقارنة، ولا «غير مسعّر»
// لمجرد فشل تحميل مصدر.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../src/price-cost-audit.js";

const engine = globalThis.ozkPriceCostAudit;
assert.ok(engine, "src/price-cost-audit.js لم يعرّف ozkPriceCostAudit");
const { auditPriceCost, classifyPrice, filterRows, sortRows } = engine;

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error?.stack || error}`); }
}

const NOW = "2026-10-25T01:00:00.000Z";
const FRESH = "2026-10-25T00:45:00.000Z";

function cost(guid, avg, extra = {}) {
  return { item_guid: guid, item_name: `cost-${guid}`, avg_cost: avg, currency: "$", updated_at: FRESH, ...extra };
}

function item(guid, { wholesale = 300, retail = 310, factor = 50, qty = 100, approvedFactor, approved = true, bulletin = "general", name, ...rest } = {}) {
  return {
    key: `k-${guid}`,
    name: name || `صنف ${guid}`,
    code: `C${guid}`,
    groupName: "مجموعة",
    itemGuid: guid,
    stockQty: qty,
    unit1Name: "كروز",
    unit2Name: "كرتونة",
    unit2Factor: factor,
    fullUnit2: qty / factor >= 1,
    bulletin,
    approved: approved
      ? { unit2Price: wholesale, unit1Price: null, unit2Factor: approvedFactor ?? factor, retailPrice: retail }
      : null,
    ...rest
  };
}

function run({ items, costs, costsStatus = "ok", pricesStatus = "ok", stock = true, now = NOW }) {
  return auditPriceCost({
    now,
    stock: { available: stock, syncedAt: FRESH },
    prices: { status: pricesStatus, error: pricesStatus === "error" ? "انقطاع" : "" },
    costs: { status: costsStatus, error: "", rows: costs },
    items
  });
}

test("classifyPrice يميّز المفقود والصفري وغير الصالح والصالح", () => {
  assert.equal(classifyPrice(undefined).state, "missing");
  assert.equal(classifyPrice(null).state, "missing");
  assert.equal(classifyPrice("").state, "missing");
  assert.equal(classifyPrice(0).state, "zero");
  assert.equal(classifyPrice("0").state, "zero");
  assert.equal(classifyPrice(-5).state, "invalid");
  assert.equal(classifyPrice("abc").state, "invalid");
  assert.equal(classifyPrice(Number.NaN).state, "invalid");
  assert.equal(classifyPrice("12.5").state, "valid");
  assert.equal(classifyPrice("12.5").value, 12.5);
});

test("تحت التكلفة: التكلفة = avg_cost × عامل الوحدة الثانية، والخسارة والنسبة صحيحتان", () => {
  const audit = run({ items: [item("A", { wholesale: 325, retail: 325, factor: 25 })], costs: [cost("A", 17.382)] });
  assert.equal(audit.belowCost.status, "ok");
  assert.equal(audit.belowCost.rows.length, 2);
  const w = audit.belowCost.rows.find((r) => r.priceType === "wholesale");
  assert.equal(w.cartonCost, 434.55);
  assert.equal(w.salePrice, 325);
  assert.equal(w.lossPerUnit2, 109.55);
  assert.equal(w.lossPercent, 25.2);
  assert.equal(audit.belowCost.itemCount, 1, "الصنف يُعدّ مرة واحدة ولو خسر بالجملة والمفرق");
  assert.deepEqual(audit.belowCost.byPriceType, { wholesale: 1, retail: 1 });
});

test("الترتيب الافتراضي من أكبر نسبة خسارة إلى أصغرها", () => {
  const audit = run({
    items: [item("A", { wholesale: 95, retail: 200 }), item("B", { wholesale: 70, retail: 200 }), item("C", { wholesale: 90, retail: 200 })],
    costs: [cost("A", 2), cost("B", 2), cost("C", 2)]
  });
  assert.deepEqual(audit.belowCost.rows.map((r) => r.itemGuid || r.code), ["CB", "CC", "CA"]);
});

test("سعر يساوي التكلفة أو يقل عنها بفرق تقريب avg_cost فقط لا يُعدّ خسارة", () => {
  // 8.003 × 50 = 400.15؛ التقريب لثلاث منازل يسمح بـ 0.025 + 0.005
  const equal = run({ items: [item("A", { wholesale: 400.15, retail: 401 })], costs: [cost("A", 8.003)] });
  assert.equal(equal.belowCost.rows.length, 0);
  const rounding = run({ items: [item("A", { wholesale: 400.13, retail: 401 })], costs: [cost("A", 8.003)] });
  assert.equal(rounding.belowCost.rows.length, 0);
  const real = run({ items: [item("A", { wholesale: 400, retail: 401 })], costs: [cost("A", 8.003)] });
  assert.equal(real.belowCost.rows.length, 1, "فرق 0.15 أكبر من هامش التقريب فهو خسارة حقيقية");
});

test("تكلفة مفقودة أو صفرية أو سالبة أو بعملة أخرى ⇒ تعذّر الحكم لا خسارة ولا ربح", () => {
  const audit = run({
    items: [item("A", { wholesale: 1 }), item("B", { wholesale: 1 }), item("C", { wholesale: 1 }), item("D", { wholesale: 1 })],
    costs: [cost("B", 0), cost("C", -3), cost("D", 5, { currency: "SYP" })]
  });
  assert.equal(audit.belowCost.rows.length, 0);
  const reasons = new Map(audit.belowCost.unverifiable.filter((r) => r.priceType === "wholesale").map((r) => [r.code, r.reason]));
  assert.equal(reasons.get("CA"), "cost_missing");
  assert.equal(reasons.get("CB"), "cost_zero");
  assert.equal(reasons.get("CC"), "cost_invalid");
  assert.equal(reasons.get("CD"), "cost_currency");
  assert.equal(audit.belowCost.unverifiableItemCount, 4);
});

test("لا مطابقة بالاسم: صنف بلا GUID لا يُقارن بتكلفة تحمل اسمه", () => {
  const audit = run({ items: [item("", { wholesale: 1, name: "cost-X" })], costs: [cost("X", 50)] });
  assert.equal(audit.belowCost.rows.length, 0);
  assert.equal(audit.belowCost.unverifiable[0].reason, "no_guid");
});

test("GUID غير حساس لحالة الأحرف", () => {
  const audit = run({ items: [item("abc-1", { wholesale: 40, retail: 100 })], costs: [cost("ABC-1", 1)] });
  assert.equal(audit.belowCost.rows.length, 1);
});

test("عامل وحدة غير صالح أو مخالف للسعر المحفوظ ⇒ تعذّر الحكم", () => {
  const bad = run({ items: [item("A", { factor: 0, wholesale: 1 })], costs: [cost("A", 5)] });
  assert.equal(bad.belowCost.unverifiable[0].reason, "factor_invalid");
  const mismatch = run({ items: [item("A", { factor: 50, approvedFactor: 10, wholesale: 100 })], costs: [cost("A", 5)] });
  assert.equal(mismatch.belowCost.rows.length, 0);
  assert.equal(mismatch.belowCost.unverifiable[0].reason, "factor_mismatch");
});

test("نسبة سعر/تكلفة غير منطقية (اختلاف وحدة مرجّح) ⇒ تعذّر الحكم في الاتجاهين", () => {
  const high = run({ items: [item("A", { factor: 24, wholesale: 120, retail: 125 })], costs: [cost("A", 1.327)] });
  assert.equal(high.belowCost.rows.length, 0);
  assert.ok(high.belowCost.unverifiable.every((r) => r.reason === "ratio_implausible"));
  const low = run({ items: [item("A", { factor: 50, wholesale: 100, retail: 100 })], costs: [cost("A", 20)] });
  assert.equal(low.belowCost.rows.length, 0, "سعر ثلث التكلفة لا يُعلن خسارة 90% بلا تحقق من الوحدة");
  assert.ok(low.belowCost.unverifiable.every((r) => r.reason === "ratio_implausible"));
});

test("صف تكلفة لم يُحدَّث مع آخر رفع ⇒ تعذّر الحكم لذلك الصنف وحده", () => {
  const audit = run({
    items: [item("A", { wholesale: 1, retail: 1000 }), item("B", { wholesale: 90, retail: 1000 })],
    costs: [cost("A", 5, { updated_at: "2026-09-30T22:00:00Z" }), cost("B", 2)]
  });
  assert.equal(audit.belowCost.status, "ok");
  assert.ok(audit.belowCost.unverifiable.some((r) => r.code === "CA" && r.reason === "cost_row_stale"));
  assert.ok(audit.belowCost.rows.some((r) => r.code === "CB"));
});

test("تغذية التكلفة كلها قديمة أو فاشلة أو مخفية ⇒ الستارة معلّقة بلا أحكام", () => {
  const items = [item("A", { wholesale: 1 })];
  const stale = run({ items, costs: [cost("A", 5, { updated_at: "2026-10-23T00:00:00Z" })] });
  assert.equal(stale.belowCost.status, "unavailable");
  assert.match(stale.belowCost.reason, /قديمة/);
  assert.equal(stale.belowCost.rows.length, 0);
  const failedLoad = run({ items, costs: [], costsStatus: "error" });
  assert.equal(failedLoad.belowCost.status, "unavailable");
  assert.equal(failedLoad.belowCost.unverifiable.length, 0);
  const notOwner = run({ items, costs: [cost("A", 5)], costsStatus: "not_owner" });
  assert.equal(notOwner.belowCost.status, "unavailable");
  const empty = run({ items, costs: [] });
  assert.equal(empty.belowCost.status, "unavailable");
  const future = run({ items, costs: [cost("A", 5, { updated_at: "2026-10-26T00:00:00Z" })] });
  assert.equal(future.belowCost.status, "unavailable");
});

test("غير مسعّر: بلا صف سعر ⇒ مفقود للنوعين، ومعه التكلفة إن توفرت", () => {
  const audit = run({ items: [item("A", { approved: false })], costs: [cost("A", 4)] });
  assert.equal(audit.unpriced.status, "ok");
  assert.equal(audit.unpriced.itemCount, 1);
  const row = audit.unpriced.rows[0];
  assert.equal(row.wholesaleState, "missing");
  assert.equal(row.retailState, "missing");
  assert.equal(row.cartonCost, 200);
  assert.equal(row.hasApprovedRow, false);
});

test("غير مسعّر: يميّز الصفري وغير الصالح، والمفرق الناقص وحده يكفي", () => {
  const audit = run({
    items: [
      item("A", { wholesale: 0, retail: 0 }),
      item("B", { wholesale: -1, retail: "x" }),
      item("C", { wholesale: 300, retail: null }),
      item("D", { wholesale: 300, retail: 310 })
    ],
    costs: [cost("A", 5), cost("B", 5), cost("C", 5), cost("D", 5)]
  });
  const states = new Map(audit.unpriced.rows.map((r) => [r.code, [r.wholesaleState, r.retailState]]));
  assert.deepEqual(states.get("CA"), ["zero", "zero"]);
  assert.deepEqual(states.get("CB"), ["invalid", "invalid"]);
  assert.deepEqual(states.get("CC"), ["valid", "missing"]);
  assert.equal(states.has("CD"), false);
  assert.deepEqual(audit.unpriced.byState, { zero: 2, invalid: 2, missing: 1 });
});

test("سعر الوحدة الأولى القديم يُعدّ سعر جملة كما تقرؤه النشرة", () => {
  const legacy = item("A", { wholesale: 0, retail: 300 });
  legacy.approved.unit1Price = 6;
  const audit = run({ items: [legacy], costs: [cost("A", 5)] });
  assert.equal(audit.unpriced.itemCount, 0);
  assert.equal(audit.belowCost.rows.length, 0);
});

test("فشل تحميل الأسعار أو غياب الجرد لا يجعل أي مادة «غير مسعّرة»", () => {
  const items = [item("A", { approved: false })];
  const priceFail = run({ items, costs: [cost("A", 5)], pricesStatus: "error" });
  assert.equal(priceFail.unpriced.status, "unavailable");
  assert.equal(priceFail.unpriced.rows.length, 0);
  assert.equal(priceFail.belowCost.status, "unavailable");
  assert.match(priceFail.unpriced.reason, /تعذّر تحميل الأسعار/);
  const noLogin = run({ items, costs: [], pricesStatus: "unauthenticated" });
  assert.equal(noLogin.unpriced.status, "unavailable");
  const noStock = run({ items, costs: [cost("A", 5)], stock: false });
  assert.equal(noStock.unpriced.status, "unavailable");
  assert.equal(noStock.scopeCount, 0);
});

test("مخزون صفري أو سالب خارج النطاق", () => {
  const audit = run({ items: [item("A", { approved: false, qty: 0 }), item("B", { approved: false, qty: -3 })], costs: [cost("A", 5)] });
  assert.equal(audit.unpriced.itemCount, 0);
  assert.equal(audit.scopeCount, 0);
});

test("ظهور الصنف في النشرة: الجملة تشترط وحدة ثانية كاملة، والمفرق أي مخزون", () => {
  const audit = run({ items: [item("A", { qty: 10, factor: 50, wholesale: 90, retail: 90 })], costs: [cost("A", 2)] });
  const byType = new Map(audit.belowCost.rows.map((r) => [r.priceType, r.inBulletin]));
  assert.equal(byType.get("wholesale"), false);
  assert.equal(byType.get("retail"), true);
});

test("البحث يتسامح مع الهمزة والتاء المربوطة ويشمل الرمز والمجموعة، والفرز لا يغيّر الأصل", () => {
  const rows = [
    { name: "نخلة صلاحية", code: "11", groupName: "معسل", lossPercent: 5, lossPerUnit2: 50 },
    { name: "أليغانس", code: "22", groupName: "سجائر", lossPercent: 9, lossPerUnit2: 10 }
  ];
  assert.equal(filterRows(rows, "نخله").length, 1);
  assert.equal(filterRows(rows, "اليغانس").length, 1);
  assert.equal(filterRows(rows, "22").length, 1);
  assert.equal(filterRows(rows, "سجائر").length, 1);
  assert.equal(filterRows(rows, "").length, 2);
  assert.equal(sortRows(rows, "belowCost", "lossValueDesc")[0].code, "11");
  assert.equal(sortRows(rows, "belowCost", "lossPercentDesc")[0].code, "22");
  assert.equal(rows[0].code, "11");
});

test("الأداء: 5000 صنف تُدقَّق في أقل من ثانية", () => {
  const items = [];
  const costs = [];
  for (let i = 0; i < 5000; i += 1) {
    items.push(item(`G${i}`, { wholesale: 90 + (i % 30), retail: i % 7 ? 120 : null }));
    costs.push(cost(`G${i}`, 2));
  }
  const started = performance.now();
  const audit = run({ items, costs });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `استغرق ${elapsed.toFixed(0)}ms`);
  assert.ok(audit.belowCost.rows.length > 0 && audit.unpriced.itemCount > 0);
});

test("أسعار التصفية لا تُستبعد: صنف «صلاحية» تحت التكلفة يظهر موسوماً، وغيره بلا وسم", () => {
  const audit = run({
    items: [item("A", { name: "نخلة صلاحية شهر 10", wholesale: 325, retail: 325, factor: 25 }), item("B", { wholesale: 90, retail: 200 })],
    costs: [cost("A", 17.382), cost("B", 2)]
  });
  const a = audit.belowCost.rows.filter((r) => r.code === "CA");
  assert.equal(a.length, 2, "التصفية المحتملة تبقى في القائمة بنوعي السعر");
  assert.ok(a.every((r) => r.clearanceHint === true));
  assert.ok(audit.belowCost.rows.filter((r) => r.code === "CB").every((r) => r.clearanceHint === false));
  assert.equal(audit.belowCost.itemCount, 2);
});

test("أصناف المزايا تُدقَّق كلٌّ بسعره: لا سعر احتياطي ثابت (132/135) يخفي غير المسعّر", () => {
  const audit = run({
    items: [item("M1", { name: "معسل مزايا تفاحتين", approved: false, factor: 12 }), item("M2", { name: "معسل مزايا عنب", wholesale: 145, retail: 150, factor: 12 })],
    costs: [cost("M1", 11), cost("M2", 11)]
  });
  assert.deepEqual(audit.unpriced.rows.map((r) => r.code), ["CM1"]);
  assert.equal(audit.unpriced.rows[0].wholesaleState, "missing");
  const app = readFileSync("src/app.js", "utf8");
  const input = app.slice(app.indexOf("function priceAuditInput()"), app.indexOf("// يُعاد الحساب فقط عند تغيّر"));
  assert.match(input, /pricingWorklistItems\(\{ ignoreSearch: true \}\)/, "المدخلات أصناف أصلية قبل الدمج");
  assert.doesNotMatch(input, /mergeMazayaPriceItems|consolidateGeneralPriceItems|mergeBulletinNamedGroups|customerPriceListItems|MAZAYA_/,
    "التدقيق لا يمرّ بأي دمج أو سعر احتياطي");
});

test("الوحدة نقية: لا شبكة ولا كتابة ولا DOM", () => {
  const source = readFileSync("src/price-cost-audit.js", "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|dataStore|supabase|\.from\(|upsert|insert|update\(|delete|document\.|localStorage/i);
});

test("ربط الصفحة: السكربت قبل app.js، ومخزَّن في عامل الخدمة، والستارتان مغلقتان افتراضياً", () => {
  const html = readFileSync("index.html", "utf8");
  const pos = (name) => html.indexOf(`src/${name}?v=tobacco-`);
  assert.ok(pos("price-cost-audit.js") > 0 && pos("price-cost-audit.js") < pos("app.js"), "price-cost-audit.js يجب أن يُحمَّل قبل app.js وبمعامل النسخة");
  assert.match(readFileSync("public/service-worker.js", "utf8"), /"src\/price-cost-audit\.js"/);
  const app = readFileSync("src/app.js", "utf8");
  assert.match(app, /priceAudit: \{\n\s+belowOpen: false,\n\s+unpricedOpen: false,/);
  assert.match(app, /\$\{priceAuditPanels\(\)\}\s*\n\s*<section class="panel wide inventory-browser newsletter-pricing-panel">/);
  const panelsBody = app.slice(app.indexOf("function priceAuditPanels()"), app.indexOf("function updatePriceAuditResults("));
  assert.match(panelsBody, /const belowPanel = isOwner\(\)/, "ستارة التكلفة للمدير وحده");
  const block = app.slice(app.indexOf("// ===== تدقيق النشرة"), app.indexOf("function pricing() {"));
  assert.doesNotMatch(block, /upsert|saveApproved|dataStore\.(?!isConfigured)/, "التدقيق لا يكتب أي سعر");
});

test("listItemCosts يرمي عند الخطأ ويقرأ بصفحات، وloadItemCosts يسجّل الحالة", () => {
  const client = readFileSync("src/supabase-client.js", "utf8");
  const body = client.slice(client.indexOf("async listItemCosts()"), client.indexOf("async getCustomerMovementsReport()"));
  assert.match(body, /if \(error\) throw new Error/);
  assert.match(body, /\.range\(from, from \+ 999\)/);
  assert.doesNotMatch(body, /catch \{\s*return \[\];/);
  const app = readFileSync("src/app.js", "utf8");
  const load = app.slice(app.indexOf("async function loadItemCosts()"), app.indexOf("let _costIndexRef"));
  assert.match(load, /state\.itemCostsStatus = "ok"/);
  assert.match(load, /state\.itemCostsStatus = "error"/);
});

console.log("check-price-cost-audit:");
console.log(results.join("\n"));
if (failed) {
  console.error(`check-price-cost-audit: فشل ${failed} من ${results.length}`);
  process.exit(1);
}
console.log(`check-price-cost-audit: اجتاز ${results.length} فحصاً.`);
