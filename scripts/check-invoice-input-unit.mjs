// ============================================================================
// فحص انحداري: **وحدة إدخال سطر الفاتورة من الأمين هي مصدر الحقيقة، لا التخمين.**
//
// العطل الحقيقي (فاتورة 830، 2026-09-27): «دفيدوف سليم غولد» بِيع 10 كروز بسعر 22$
// للكروز (قيمته 220)، وطُبع في PDF «0.333 كرتونة × 22 $ / كرتونة = 7.326». أداة الرفع لم
// تكن تنقل وحدة إدخال السطر، فكان الموقع يخمّن أساس السعر بمطابقة إجمالي الفاتورة.
//
// المُثبت قراءةً على AmnDb002 (2026-09-27): `bi000.Unity` رقم وحدة إدخال السطر
// (1 = mt000.Unity، 2 = Unit2، 3 = Unit3)، و`bi000.Qty` بالوحدة الأولى دائماً، و`bi000.Price`
// سعر الوحدة التي يحددها Unity. فالقيمة `Price × Qty ÷ factor(Unity)`، وطابقت `bu000.Total`
// في 200/200 فاتورة بيع حديثة (24 منها تخلط الوحدتين في الفاتورة نفسها).
//
// الأسطر هنا بأشكال شواهد 830 (أسماء أصناف وكميات وأسعار ومعاملات) بلا أي بيانات زبون.
// الفواتير الكاملة مصطنعة: بيانات الأمين الحية متغيرة فلا يُختبر بها ولا تُنسخ هنا.
//
// يشغّل الدوال الحقيقية من src/app.js داخل vm — لا نسخة مبسّطة.
// ============================================================================

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const psText = readFileSync(new URL("../tools/push-customer-invoices.ps1", import.meta.url), "utf8");

// ===== استخراج الدوال الحقيقية =====

const FUNCTIONS = [
  "roundPrice", "formatMoney", "invoicePriceBasis", "invoiceLineBasis", "invoiceBasisTolerance",
  "invoiceLineCandidates", "invoiceLineBasisPlan", "computeInvoiceLineBasisPlan",
  "invoiceLineInputUnit", "invoiceLineTotalValue", "invoiceLineValueText",
  "invoiceLineFractionalUnit1", "invoiceLineQtyParts", "invoiceLineQty",
  "invoiceLineUnitPrice", "invoiceLinePrice"
];
const source = [];
for (const name of FUNCTIONS) {
  const found = appJs.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
  if (!found) { failed += 1; results.push(`  ❌ استخراج ${name}\n     لم أجد التعريف في src/app.js`); continue; }
  source.push(found[0]);
}
const consts = appJs.match(/const INVOICE_BASIS_SEARCH_BUDGET = [^\n]*\n[\s\S]*?const INVOICE_BASIS_PLAN_CACHE = [^\n]*\n/);
if (consts) source.unshift(consts[0]);
else { failed += 1; results.push("  ❌ استخراج ثوابت البحث\n     لم أجدها في src/app.js"); }

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);
const {
  invoiceLineInputUnit, invoiceLineTotalValue, invoiceLineQtyParts, invoiceLineQty,
  invoiceLinePrice, invoiceLineUnitPrice
} = sandbox;

// ===== أشكال شواهد 830 كما ترفعها أداة الرفع الجديدة =====
// lineTotal مشتقّ (bi000 بلا عمود إجمالي) = qty × price، وqtyUnits = qty ÷ unit2Fact مدوّرة.

const line = (material, qty, price, inputUnit, unit2, unit2Fact, extra = {}) => ({
  material, qty, price, inputUnit,
  qtyUnits: unit2Fact > 0 ? Math.round((qty / unit2Fact) * 1000) / 1000 : qty,
  lineTotal: Math.round(qty * price * 1000) / 1000,
  lineTotalSource: "derived",
  unit1: "كروز", unit2, unit2Fact, unit3: "", unit3Fact: 0,
  ...extra
});

const DAVIDOFF = line("دفيدوف سليم غولد", 10, 22, 1, "كرتونة", 30);
const MAZAYA_BAHRAINI = line("معسل مزايا تفاحتين بحريني كروز", 23, 12.083, 1, "شرحة", 12);
const MAZAYA_GRAPE = line("معسل مزايا عنب", 6, 11, 1, "شرحة", 12);
const ROSE = line("روز سليم كومفورت كلاسيك", 25, 190, 2, "كرتونة", 50);
const WITNESSES = [DAVIDOFF, MAZAYA_BAHRAINI, MAZAYA_GRAPE, ROSE];
const witnessInv = { total: 658.909, lines: WITNESSES };

// ===== 1) الشواهد الأربعة =====

test("دفيدوف سليم غولد: 10 كروز × 22 $ / كروز = 220", () => {
  const parts = invoiceLineQtyParts(DAVIDOFF);
  assert.equal(parts.value, "10");
  assert.equal(parts.unit, "كروز");
  assert.equal(parts.detailValue, "");
  assert.equal(invoiceLinePrice(DAVIDOFF, witnessInv), "22 $ / كروز");
  assert.equal(invoiceLineTotalValue(DAVIDOFF, witnessInv), 220);
});

test("مزايا بحريني: 23 كروز × 12.083 $ / كروز = 277.909", () => {
  const parts = invoiceLineQtyParts(MAZAYA_BAHRAINI);
  assert.equal(parts.value, "23");
  assert.equal(parts.unit, "كروز");
  assert.equal(invoiceLinePrice(MAZAYA_BAHRAINI, witnessInv), "12.083 $ / كروز");
  assert.equal(invoiceLineTotalValue(MAZAYA_BAHRAINI, witnessInv), 277.909);
});

test("مزايا عنب: 6 كروز × 11 $ / كروز = 66", () => {
  const parts = invoiceLineQtyParts(MAZAYA_GRAPE);
  assert.equal(parts.value, "6");
  assert.equal(parts.unit, "كروز");
  assert.equal(invoiceLinePrice(MAZAYA_GRAPE, witnessInv), "11 $ / كروز");
  assert.equal(invoiceLineTotalValue(MAZAYA_GRAPE, witnessInv), 66);
});

test("روز سليم كومفورت كلاسيك: 0.5 كرتونة × 190 $ / كرتونة = 95 (والكروز توضيحاً)", () => {
  const parts = invoiceLineQtyParts(ROSE);
  assert.equal(parts.value, "0.5");
  assert.equal(parts.unit, "كرتونة");
  assert.equal(parts.detailValue, "25");
  assert.equal(parts.detailUnit, "كروز");
  assert.equal(invoiceLineQty(ROSE), "0.5 كرتونة (25 كروز)");
  assert.equal(invoiceLinePrice(ROSE, witnessInv), "190 $ / كرتونة");
  assert.equal(invoiceLineTotalValue(ROSE, witnessInv), 95);
});

test("السعر المعروض × الكمية المعروضة = قيمة السطر في كل شاهد", () => {
  for (const l of WITNESSES) {
    const u = invoiceLineInputUnit(l);
    const shownQty = Math.round((l.qty / u.factor) * 1000) / 1000;
    assert.equal(Math.round(shownQty * l.price * 1000) / 1000, invoiceLineTotalValue(l, witnessInv), l.material);
  }
});

test("العطل القديم: بلا inputUnit كان دفيدوف يُطبع 0.333 كرتونة × 22 = 7.326", () => {
  const legacy = { ...DAVIDOFF };
  delete legacy.inputUnit;
  // فاتورة لا تحسمها المطابقة (إجماليها لا يطابق أي توزيع) فيسقط السطر إلى التخمين العام.
  const bigCarton = { ...ROSE, inputUnit: undefined, qty: 500, qtyUnits: 10, price: 300, lineTotal: 150000 };
  const inv = { total: 3007.33, lines: [legacy, bigCarton] };
  assert.equal(invoiceLineQtyParts(legacy).unit, "كرتونة");
  assert.equal(invoiceLineTotalValue(legacy, inv), 7.326);
  // والسطر نفسه بوحدته الصريحة لا يتأثر بإجمالي الفاتورة ولا بجيرانه.
  assert.equal(invoiceLineTotalValue(DAVIDOFF, inv), 220);
});

// ===== 2) فاتورة مختلطة الوحدات: لا أساس سعر واحد للفاتورة =====

const MIXED = [
  line("1970 كوين اسود", 25, 265, 2, "كرتونة", 50),   // 0.5 كرتونة = 132.5
  line("1970 سليم أزرق", 5, 4, 1, "كرتونة", 50),      // 5 كروز = 20
  line("معسل مزايا بولو", 24, 145, 2, "شرحة", 12),    // 2 شرحة = 290
  line("كابتن بلاك سيغار", 5, 8.333, 1, "طرد", 30),   // 5 علب = 41.665
  line("وينستون ازرق علب", 5, 20, 1, "كرتونة", 20)    // 5 كروز = 100
];
const MIXED_TOTAL = 584.165;

test("مختلطة: كل سطر بوحدته، والمجموع = إجمالي الفاتورة", () => {
  const inv = { total: MIXED_TOTAL, lines: MIXED };
  const values = MIXED.map((l) => invoiceLineTotalValue(l, inv));
  assert.deepEqual(values, [132.5, 20, 290, 41.665, 100]);
  const sum = values.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - MIXED_TOTAL) <= 0.005, `المجموع ${sum} ≠ ${MIXED_TOTAL}`);
});

test("مختلطة: قيمة كل سطر مستقلة عن إجمالي الفاتورة (لا حسم عام للأساس)", () => {
  for (const total of [MIXED_TOTAL, 1, 999999, 0]) {
    const inv = { total, lines: MIXED };
    assert.deepEqual(MIXED.map((l) => invoiceLineTotalValue(l, inv)), [132.5, 20, 290, 41.665, 100], `total=${total}`);
    assert.deepEqual(MIXED.map((l) => invoiceLineUnitPrice(l, inv).unit), ["كرتونة", "كروز", "شرحة", "كروز", "كروز"]);
  }
});

test("مختلطة: السعر المعروض سعر وحدة الإدخال بلا تحويل", () => {
  const inv = { total: MIXED_TOTAL, lines: MIXED };
  assert.deepEqual(MIXED.map((l) => invoiceLinePrice(l, inv)), [
    "265 $ / كرتونة", "4 $ / كروز", "145 $ / شرحة", "8.333 $ / كروز", "20 $ / كروز"
  ]);
});

// ===== 3) معاملات مختلفة وكسور ووحدة ثالثة =====

test("معاملات وحدة مختلفة (6/10/12/20/24/30/50/70) وكميات كسرية", () => {
  const cases = [
    [line("أ", 3, 120, 2, "شرحة", 6), 0.5, 60],
    [line("ب", 25, 250, 2, "كرتونة", 10), 2.5, 625],
    [line("ج", 18, 145, 2, "شرحة", 12), 1.5, 217.5],
    [line("د", 5, 200, 2, "كرتونة", 20), 0.25, 50],
    [line("هـ", 6, 135, 2, "شرحة", 24), 0.25, 33.75],
    [line("و", 10, 660, 2, "كرتونة", 30), 0.333, 220],
    [line("ز", 5, 300, 2, "كرتونة", 50), 0.1, 30],
    [line("ح", 10, 280, 2, "كرتونة", 70), 0.143, 40]
  ];
  for (const [l, shownQty, value] of cases) {
    assert.equal(invoiceLineQtyParts(l).value, String(shownQty), l.material);
    assert.equal(invoiceLineTotalValue(l, { total: value, lines: [l] }), value, l.material);
  }
});

test("وحدة ثالثة (Unity = 3): الكمية ÷ Unit3Fact والسعر سعرها", () => {
  const l = line("صنف بثلاث وحدات", 1000, 2000, 3, "كرتونة", 50, { unit3: "طرد", unit3Fact: 500 });
  assert.equal(invoiceLineQtyParts(l).value, "2");
  assert.equal(invoiceLineQtyParts(l).unit, "طرد");
  assert.equal(invoiceLineQtyParts(l).detailValue, "1,000");
  assert.equal(invoiceLinePrice(l, { total: 4000, lines: [l] }), "2,000 $ / طرد");
  assert.equal(invoiceLineTotalValue(l, { total: 4000, lines: [l] }), 4000);
});

// ===== 4) الأسطر القديمة ووحدة غير صالحة: المنطق القديم كما هو =====

test("بلا inputUnit أو بقيمة غير صالحة: لا وحدة صريحة", () => {
  for (const bad of [undefined, null, 0, 4, "", "x", -1]) {
    assert.equal(invoiceLineInputUnit({ ...ROSE, inputUnit: bad }), null, `inputUnit=${bad}`);
  }
  assert.equal(invoiceLineInputUnit({ ...ROSE, unit2Fact: 0 }), null, "معامل صفري");
  assert.equal(invoiceLineInputUnit({ ...ROSE, unit2: "" }), null, "وحدة بلا اسم");
  assert.equal(invoiceLineInputUnit({ ...ROSE, inputUnit: 3 }), null, "وحدة ثالثة غير معرّفة");
});

test("السطر القديم ينتج بالضبط ما كان ينتجه قبل الإصلاح", () => {
  // خطة المطابقة القديمة تحسم هذه الفاتورة سطراً بسطر (الكرتونة كاملة والكروز كسراً).
  const oldFull = { material: "صنف", qty: 50, qtyUnits: 1, price: 286, lineTotal: 14300, lineTotalSource: "derived", unit1: "كروز", unit2: "كرتونة" };
  const oldLoose = { material: "صنف", qty: 15, qtyUnits: 0.3, price: 8.04, lineTotal: 120.6, lineTotalSource: "derived", unit1: "كروز", unit2: "كرتونة" };
  const inv = { total: 406.6, lines: [oldFull, oldLoose] };
  assert.equal(invoiceLineTotalValue(oldFull, inv), 286);
  assert.equal(invoiceLineTotalValue(oldLoose, inv), 120.6);
  assert.equal(invoiceLinePrice(oldFull, inv), "286 $ / كرتونة");
});

test("فاتورة تخلط أسطراً صريحة وقديمة: الصريح ثابت في المطابقة ولا يدخل البحث", () => {
  const oldLine = { material: "قديم", qty: 50, qtyUnits: 1, price: 286, lineTotal: 14300, lineTotalSource: "derived", unit1: "كروز", unit2: "كرتونة" };
  const inv = { total: 220 + 286, lines: [DAVIDOFF, oldLine] };
  assert.equal(invoiceLineTotalValue(DAVIDOFF, inv), 220);
  assert.equal(invoiceLineTotalValue(oldLine, inv), 286);
});

// ===== 5) أداة الرفع تنقل الوحدة =====

test("push-customer-invoices.ps1 يجلب bi000.Unity ومعاملات الوحدات ويرفعها لكل سطر", () => {
  assert.match(psText, /CAST\(COALESCE\(bi\.Unity,0\) AS int\)/);
  assert.match(psText, /\$unitySel AS input_unit/);
  assert.match(psText, /CAST\(COALESCE\(m\.Unit3Fact,0\) AS decimal\(18,3\)\) AS unit3_fact/);
  for (const field of ["inputUnit        = $inputUnit", "unit2Fact        = $f", "unit3            = [string]$r[\"unit3\"]", "unit3Fact        = [double]$r[\"unit3_fact\"]"]) {
    assert.ok(psText.includes(field), `الحقل مفقود من سطر الفاتورة: ${field}`);
  }
  // قيمة خارج 1/2/3 لا تُرفع وحدةً: تبقى فارغة فيعمل الموقع بالمنطق القديم.
  assert.match(psText, /if \(\$inputUnit -notin @\(1, 2, 3\)\) \{ \$inputUnit = \$null \}/);
});

// ===== النتيجة =====

console.log("فحص وحدة إدخال سطر الفاتورة (شاهد 830):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
