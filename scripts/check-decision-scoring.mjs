// ============================================================================
// فحوص انحدار لنواة تقييم لوحة «قرار اليوم» (src/decision-scoring.js).
//
// كل حالة هنا مأخوذة من عطل مثبت في تدقيق 2026-09-06، لا من افتراض. الحالات
// مرقّمة كما وردت في طلب الإصلاح كي يبقى الأثر قابلاً للتتبّع.
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/decision-scoring.js", import.meta.url), "utf8");
const sandbox = { console, Date, Math, Number, String, Array, Object, Map, Set, JSON, Infinity, isNaN };
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "decision-scoring.js" });

const S = sandbox.ozkDecisionScoring;
assert.ok(S, "نواة التقييم لم تُصدَّر");

const NOW = new Date("2026-09-06T12:00:00.000Z");
const guid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);

function item(n, name, extra = {}) {
  return { itemKey: name, itemGuid: guid(n), itemName: name, salePrice: 100, ...extra };
}
function snap(n, name, extra = {}) {
  return {
    itemKey: guid(n), itemGuid: guid(n), itemName: name,
    generatedAt: NOW.toISOString(), ...extra
  };
}
const run = (items, snapshots, tunables) =>
  S.scoreItems({ items, snapshots, now: NOW, tunables });
const byName = (result, name) => result.items.find((row) => row.name === name);

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------- الأصناف
console.log("الأصناف:");

check("1) نافد ومبيعه قطعة واحدة في 30 يوماً ليس عاجلاً ولا يقارب 100", () => {
  const result = run(
    [item(1, "بطيء نافد")],
    [snap(1, "بطيء نافد", { stockUnit1: 0, unitsSold30d: 1, lastSaleDate: daysAgo(7) })]
  );
  const row = byName(result, "بطيء نافد");
  assert.equal(row.priority, "dormant", "صنف شبه ميت صُنّف عاجلاً");
  assert.ok(row.score <= S.TUNABLES.PURCHASE_DORMANT_MAX_SCORE,
    `درجة الراكد ${row.score} تجاوزت السقف`);
  assert.ok(row.score < 85, "الراكد بلغ عتبة العاجل");
});

check("2) نافد ومبيعه 3000 في 30 يوماً = عاجل جداً", () => {
  const result = run(
    [item(2, "سريع نافد"), item(3, "عادي")],
    [
      snap(2, "سريع نافد", { stockUnit1: 0, unitsSold30d: 3000, lastSaleDate: daysAgo(0) }),
      snap(3, "عادي", { stockUnit1: 500, unitsSold30d: 300, lastSaleDate: daysAgo(1) })
    ]
  );
  const row = byName(result, "سريع نافد");
  assert.equal(row.priority, "urgent");
  assert.ok(row.score >= 85, `درجة الصنف السريع النافد ${row.score} دون عتبة العاجل`);
});

check("3) صنف بمخزون وتغطيته أقل من يوم يسبق نافداً بطيء الحركة", () => {
  const result = run(
    [item(4, "سريع بمخزون"), item(5, "نافد بطيء")],
    [
      snap(4, "سريع بمخزون", { stockUnit1: 123, unitsSold30d: 29000, lastSaleDate: daysAgo(0) }),
      snap(5, "نافد بطيء", { stockUnit1: 0, unitsSold30d: 1, lastSaleDate: daysAgo(7) })
    ]
  );
  const fast = result.items.findIndex((row) => row.name === "سريع بمخزون");
  const slow = result.items.findIndex((row) => row.name === "نافد بطيء");
  assert.ok(fast < slow, "الانقلاب ما زال قائماً: النافد البطيء يسبق السريع");
  assert.ok(byName(result, "سريع بمخزون").coverageDays < 1);
});

check("4) بلا بيع منذ أكثر من 21 يوماً = راكد حتى لو المخزون صفر", () => {
  const result = run(
    [item(6, "مهجور")],
    // معدّل يومي فوق الحد الأدنى، فالاستبعاد هنا سببه الركود الزمني وحده
    [snap(6, "مهجور", { stockUnit1: 0, unitsSold30d: 60, lastSaleDate: daysAgo(30) })]
  );
  const row = byName(result, "مهجور");
  assert.ok(row.dailySales >= S.TUNABLES.PURCHASE_MIN_DAILY_SALES, "العيّنة لا تختبر بوابة الزمن");
  assert.equal(row.priority, "dormant");
  assert.ok(row.score <= S.TUNABLES.PURCHASE_DORMANT_MAX_SCORE);
});

check("5) تكرار المعرّف يظهر مرة واحدة فقط", () => {
  const result = run(
    [item(7, "مكرر"), item(7, "مكرر"), item(7, "مكرر بصياغة أخرى")],
    [snap(7, "مكرر", { stockUnit1: 0, unitsSold30d: 300, lastSaleDate: daysAgo(0) })]
  );
  assert.equal(result.items.length, 1, "الصنف المكرر ظهر أكثر من مرة");
  assert.equal(result.duplicateCount, 2);
});

check("6) المطابقة تنجح بالمعرّف حتى لو اختلف الاسم العربي", () => {
  const result = run(
    [item(8, "مانشستر كوين أزرق")],
    [snap(8, "مانشستر كوين ازرق", { stockUnit1: 0, unitsSold30d: 900, lastSaleDate: daysAgo(0) })]
  );
  const row = byName(result, "مانشستر كوين أزرق");
  assert.equal(row.matchedSnapshot, true, "المعرّف لم يُستعمل للمطابقة");
  assert.equal(row.identityBasis, "guid");
  assert.equal(row.sold30d, 900);
});

check("6ب) اسم مكرر في اللقطة لا يُنسب لصنف بلا معرّف", () => {
  const index = S.buildSnapshotIndex([
    { itemName: "اسم مشترك", itemGuid: guid(90), stockUnit1: 1 },
    { itemName: "اسم مشترك", itemGuid: guid(91), stockUnit1: 2 }
  ]);
  assert.equal(S.findSnapshot(index, { itemName: "اسم مشترك" }), null,
    "نُسبت حركة لصنف عبر اسم مكرر");
});

check("7) لقطة قديمة = حالة غير موثوقة مع سبب صريح", () => {
  const stale = S.snapshotFreshness(
    [{ generatedAt: new Date(NOW.getTime() - 6 * 86400000).toISOString() }],
    { now: NOW }
  );
  assert.equal(stale.state, "stale");
  assert.equal(stale.trusted, false);
  assert.match(stale.reason, /قديمة/);

  const fresh = S.snapshotFreshness([{ generatedAt: NOW.toISOString() }], { now: NOW });
  assert.equal(fresh.trusted, true);
  assert.equal(fresh.state, "fresh");

  const missing = S.snapshotFreshness([], { now: NOW });
  assert.equal(missing.state, "missing");
  assert.equal(missing.trusted, false);
});

check("8) عند تساوي الدرجة يفصل التغطية ثم السرعة، لا الأبجدية", () => {
  // «ي» يسبق «أ» أبجدياً بالعكس؛ لو عاد الترتيب الأبجدي لظهر الاسم الأول أولاً.
  const result = run(
    [item(10, "أبجدية أولاً"), item(11, "يائية أخيراً")],
    [
      snap(10, "أبجدية أولاً", { stockUnit1: 300, unitsSold30d: 300, lastSaleDate: daysAgo(0) }),
      snap(11, "يائية أخيراً", { stockUnit1: 30, unitsSold30d: 300, lastSaleDate: daysAgo(0) })
    ]
  );
  const first = result.items[0];
  assert.equal(first.name, "يائية أخيراً", "الترتيب الأبجدي عاد عاملاً فعلياً");
  assert.ok(first.coverageDays < result.items[1].coverageDays);
});

check("8ب) درجة متساوية تماماً تُفصل بالتغطية", () => {
  const rows = [
    { score: 50, coverageDays: 9, dailySales: 5, name: "ب" },
    { score: 50, coverageDays: 2, dailySales: 5, name: "أ" }
  ].sort((a, b) => b.score - a.score
    || (a.coverageDays ?? Infinity) - (b.coverageDays ?? Infinity)
    || (b.dailySales ?? -1) - (a.dailySales ?? -1)
    || a.name.localeCompare(b.name, "ar"));
  assert.equal(rows[0].coverageDays, 2);
});

check("9ب) صنف بلا حركة مسجّلة لا يُصنّف عاجلاً بحكم النفاد", () => {
  const result = run([item(12, "بلا حركة")], []);
  const row = byName(result, "بلا حركة");
  assert.equal(row.priority, "unknown");
  assert.equal(row.score, 0);
});

check("الكمية المقترحة تحترم التغطية الهدف ولا تخترع تحويل عبوة", () => {
  const withFactor = run(
    [item(13, "بعبوة", { unit2Factor: 10 })],
    [snap(13, "بعبوة", { stockUnit1: 0, unitsSold30d: 300, lastSaleDate: daysAgo(0) })]
  );
  const a = byName(withFactor, "بعبوة");
  // 10 يومياً × 14 يوم تغطية = 140 وحدة → 14 كرتونة
  assert.equal(a.suggested.cartons, 14);
  assert.equal(a.suggested.units, 140);

  const noFactor = run(
    [item(14, "بلا عبوة")],
    [snap(14, "بلا عبوة", { stockUnit1: 0, unitsSold30d: 300, lastSaleDate: daysAgo(0) })]
  );
  const b = byName(noFactor, "بلا عبوة");
  assert.equal(b.suggested.cartons, null, "اختُرع تحويل عبوة غير معروف");
  assert.equal(b.suggested.basis, "unit1");

  const dormantSuggestion = run(
    [item(15, "راكد")],
    [snap(15, "راكد", { stockUnit1: 0, unitsSold30d: 1, lastSaleDate: daysAgo(2) })]
  );
  assert.equal(byName(dormantSuggestion, "راكد").suggested.units, 0,
    "اقتُرحت كمية شراء لصنف راكد");
});

check("غياب سعر موثوق يعيد توزيع الوزن ولا يوقف النموذج", () => {
  const priced = run(
    [item(20, "أ"), item(21, "ب")],
    [
      snap(20, "أ", { stockUnit1: 0, unitsSold30d: 600, lastSaleDate: daysAgo(0) }),
      snap(21, "ب", { stockUnit1: 100, unitsSold30d: 600, lastSaleDate: daysAgo(0) })
    ]
  );
  assert.equal(priced.valueScaleUsed, true);

  const unpriced = run(
    [item(20, "أ", { salePrice: null }), item(21, "ب", { salePrice: null })],
    [
      snap(20, "أ", { stockUnit1: 0, unitsSold30d: 600, lastSaleDate: daysAgo(0) }),
      snap(21, "ب", { stockUnit1: 100, unitsSold30d: 600, lastSaleDate: daysAgo(0) })
    ]
  );
  assert.equal(unpriced.valueScaleUsed, false);
  assert.equal(byName(unpriced, "أ").valueScale, null);
  assert.ok(byName(unpriced, "أ").score > 0, "النموذج انهار بغياب السعر");
});

// ---------------------------------------------------------------- الموردون
console.log("الموردون:");

const supplierItems = run(
  [item(30, "صنف مورد ألف"), item(31, "صنف مورد باء")],
  [
    snap(30, "صنف مورد ألف", {
      stockUnit1: 0, unitsSold30d: 3000, lastSaleDate: daysAgo(0),
      lastSupplierGuid: guid(100), lastSupplierName: "مورد ألف",
      lastPurchaseDate: daysAgo(40)
    }),
    snap(31, "صنف مورد باء", {
      stockUnit1: 5000, unitsSold30d: 60, lastSaleDate: daysAgo(1),
      lastSupplierGuid: guid(101), lastSupplierName: "مورد باء",
      lastPurchaseDate: daysAgo(2)
    })
  ]
).items;

check("10) مورد رصيده صفر لكن لديه أصناف نافدة سريعة يظهر بأولوية شراء", () => {
  const result = S.scoreSuppliers({ items: supplierItems, obligations: [], now: NOW });
  const alpha = result.suppliers.find((row) => row.name === "مورد ألف");
  assert.ok(alpha, "المورد اختفى لأن رصيده صفر");
  assert.equal(alpha.obligationAmount, null);
  assert.ok(alpha.score > 0, "أولوية شراء صفرية رغم نواقص نشطة");
  assert.equal(result.suppliers[0].name, "مورد ألف");
});

check("11) مبلغ الالتزام لا يحدد أولوية الشراء", () => {
  const withoutObligation = S.scoreSuppliers({ items: supplierItems, obligations: [], now: NOW });
  const withHugeObligationOnWeakSupplier = S.scoreSuppliers({
    items: supplierItems,
    obligations: [{ supplierGuid: guid(101), supplierName: "مورد باء", amountDue: 999999, currency: "USD" }],
    now: NOW
  });
  assert.deepEqual(
    withoutObligation.suppliers.map((row) => [row.name, row.score]),
    withHugeObligationOnWeakSupplier.suppliers.map((row) => [row.name, row.score]),
    "الالتزام المالي غيّر ترتيب أولوية الشراء"
  );
  const weak = withHugeObligationOnWeakSupplier.suppliers.find((row) => row.name === "مورد باء");
  assert.equal(weak.obligationAmount, 999999, "الالتزام لم يُعرض في عموده المستقل");
});

check("10ب) أولوية المورد تقيس الطلب المعرَّض لا عدد النافد فقط", () => {
  // عيّنة الإنتاج: مورد بأربعة أصناف عاجلة و40٪ من المبيعات سقط دون مورد بصنف
  // واحد نافد، لأن المكوّن كان ثنائياً (نافد/غير نافد).
  const items = run(
    [item(40, "أ"), item(41, "ب"), item(42, "ج"), item(43, "نافد وحيد")],
    [
      snap(40, "أ", { stockUnit1: 60, unitsSold30d: 6000, lastSaleDate: daysAgo(0), lastSupplierGuid: guid(200), lastSupplierName: "مورد كبير", lastPurchaseDate: daysAgo(5) }),
      snap(41, "ب", { stockUnit1: 50, unitsSold30d: 5000, lastSaleDate: daysAgo(0), lastSupplierGuid: guid(200), lastSupplierName: "مورد كبير", lastPurchaseDate: daysAgo(5) }),
      snap(42, "ج", { stockUnit1: 40, unitsSold30d: 4000, lastSaleDate: daysAgo(0), lastSupplierGuid: guid(200), lastSupplierName: "مورد كبير", lastPurchaseDate: daysAgo(5) }),
      snap(43, "نافد وحيد", { stockUnit1: 0, unitsSold30d: 30, lastSaleDate: daysAgo(0), lastSupplierGuid: guid(201), lastSupplierName: "مورد صغير", lastPurchaseDate: daysAgo(5) })
    ]
  ).items;
  const result = S.scoreSuppliers({ items, obligations: [], now: NOW });
  assert.equal(result.suppliers[0].name, "مورد كبير",
    "المورد الأكبر طلباً معرَّضاً ما زال دون مورد بصنف نافد وحيد");
  assert.ok(result.suppliers[0].demandAtRisk > result.suppliers[1].demandAtRisk);
});

check("9) التزامات فارغة لا تمحو نتائج الموردين الصالحة", () => {
  const empty = S.scoreSuppliers({ items: supplierItems, obligations: [], now: NOW });
  assert.equal(empty.suppliers.length, 2, "فقدت نتائج الموردين عند غياب الالتزامات");
  assert.equal(empty.obligationCount, 0);

  const overlay = fs.readFileSync(new URL("../src/decision-supplier-overlay.js", import.meta.url), "utf8");
  assert.ok(!/tbody\.innerHTML\s*=/.test(overlay),
    "الطبقة الفوقية ما زالت تكتب في tbody مباشرة");
  assert.ok(!/thead\.innerHTML\s*=/.test(overlay),
    "الطبقة الفوقية ما زالت تكتب في thead مباشرة");
  assert.ok(/window\.ozkSupplierObligations\s*=/.test(overlay),
    "الطبقة الفوقية لا تنشر النتيجة للمحرّك");
});

// ---------------------------------------------------------------- الزبائن
console.log("الزبائن:");

const customerNow = NOW;
function customer(name, balance, extra = {}) {
  return { name, customerGuid: guid(200 + name.length), balance, ...extra };
}

check("12) رصيد كبير بلا حد ائتماني يبقى ظاهراً في ترتيب الخطر", () => {
  const result = S.scoreCustomers({
    balances: [
      customer("بلا حد", 13628, { lastPaymentDate: null, recentPayments: [] }),
      customer("صغير بحد", 200, {
        lastPaymentDate: daysAgo(1), recentPayments: [{ date: daysAgo(1), amount: 150 }]
      })
    ],
    creditLimits: [{ customerGuid: guid(200 + "صغير بحد".length), creditLimit: 1000 }],
    now: customerNow
  });
  const big = result.customers.find((row) => row.name === "بلا حد");
  assert.ok(big, "الزبون بلا حد اختفى من الترتيب");
  assert.equal(big.limitSource, "missing");
  assert.equal(result.customers[0].name, "بلا حد", "الرصيد الكبير لم يتصدّر");
  assert.ok(result.missingLimitReceivables >= 13628);
});

check("13) دفعة رمزية 1$ لا تُطفئ الخطر", () => {
  const base = {
    name: "مركز كبير", customerGuid: guid(300), balance: 31597,
    lastPaymentDate: daysAgo(1)
  };
  const symbolic = S.scoreCustomers({
    balances: [{ ...base, recentPayments: [{ date: daysAgo(1), amount: 1 }] }],
    creditLimits: [{ customerGuid: guid(300), creditLimit: 18500 }],
    now: customerNow
  }).customers[0];
  assert.ok(symbolic.score >= 60,
    `الدفعة الرمزية خفضت الخطر إلى ${symbolic.score}`);
  assert.ok(symbolic.momentum > 0.9, "زخم السداد لم يعكس ضآلة الدفعة");
  assert.match(symbolic.reason, /رمزية|تجاوز|رصيد/);
});

check("14) دفعة حقيقية حديثة تخفض الدرجة فعلاً", () => {
  const build = (payments) => S.scoreCustomers({
    balances: [{
      name: "زبون", customerGuid: guid(301), balance: 10000,
      lastPaymentDate: daysAgo(1), recentPayments: payments
    }],
    creditLimits: [{ customerGuid: guid(301), creditLimit: 10000 }],
    now: customerNow
  }).customers[0];
  const symbolic = build([{ date: daysAgo(1), amount: 1 }]);
  const meaningful = build([{ date: daysAgo(1), amount: 8000 }]);
  assert.ok(meaningful.score < symbolic.score,
    "الدفعة الجوهرية لم تؤثر في الدرجة");
  assert.ok(meaningful.momentum < 0.3);
});

check("15) غياب الحد الائتماني لا يُخفي الزبون ويُعامل بمكوّن محايد", () => {
  const result = S.scoreCustomers({
    balances: [customer("بلا حد", 5000, { lastPaymentDate: daysAgo(10), recentPayments: [] })],
    creditLimits: [],
    now: customerNow
  });
  assert.equal(result.customers.length, 1);
  const row = result.customers[0];
  assert.equal(row.utilization, S.TUNABLES.COLLECTION_NEUTRAL_UTILIZATION);
  assert.equal(row.ratio, null);
  assert.match(row.reason, /بلا حد معتمد/);
});

check("لا يرث حسابٌ حدَّ حسابٍ آخر يطابقه اسماً", () => {
  const result = S.scoreCustomers({
    balances: [{ name: "محمد", customerGuid: guid(400), balance: 5000 }],
    creditLimits: [{ customerGuid: guid(401), customerName: "محمد", creditLimit: 9999 }],
    now: customerNow
  });
  assert.equal(result.customers[0].limitSource, "missing",
    "حدّ حسابٍ آخر انتقل بمطابقة الاسم");
});

check("مدين صغير لا يتصدّر مديناً كبيراً بنفس السلوك", () => {
  // العطل الذي كشفته عيّنة الإنتاج: الجمع الوزني المباشر رفع مديناً بـ177$ لم
  // يدفع قط فوق مدين بـ16,796$، لأن المكوّنات السلوكية لا تعرف حجم المال.
  const shared = { lastPaymentDate: null, recentPayments: [] };
  const result = S.scoreCustomers({
    balances: [
      { name: "صغير", customerGuid: guid(500), balance: 177, ...shared },
      { name: "متوسط", customerGuid: guid(501), balance: 3000, ...shared },
      { name: "كبير", customerGuid: guid(502), balance: 16796, ...shared }
    ],
    creditLimits: [],
    now: customerNow
  });
  assert.deepEqual(result.customers.map((row) => row.name), ["كبير", "متوسط", "صغير"],
    "ترتيب التحصيل لا يتبع حجم المال المعرَّض");
  assert.ok(result.customers[0].score > result.customers[2].score);
});

check("زبون كبير متأخر لا يُدفن تحت تصنيف «مراقبة»", () => {
  // ابو علي اسعد في الإنتاج: 28,130$ بلا دفع 38 يوماً، نسبته 0.89 فصنّفه النموذج
  // القديم «مراقبة» ووضعه في المرتبة 110.
  const result = S.scoreCustomers({
    balances: [
      { name: "كبير متأخر", customerGuid: guid(510), balance: 28130,
        lastPaymentDate: daysAgo(38), recentPayments: [{ date: daysAgo(38), amount: 500 }] },
      { name: "صغير متجاوز", customerGuid: guid(511), balance: 900,
        lastPaymentDate: daysAgo(2), recentPayments: [{ date: daysAgo(2), amount: 800 }] }
    ],
    creditLimits: [
      { customerGuid: guid(510), creditLimit: 31500 },
      { customerGuid: guid(511), creditLimit: 300 }
    ],
    now: customerNow
  });
  assert.equal(result.customers[0].name, "كبير متأخر",
    "المدين الكبير المتأخر ما زال مدفوناً تحت مدين صغير متجاوز");
});

check("لم يدفع قط = أقصى مكوّن تأخير", () => {
  const row = S.scoreCustomers({
    balances: [{ name: "بلا سجل", customerGuid: guid(402), balance: 3800 }],
    creditLimits: [],
    now: customerNow
  }).customers[0];
  assert.equal(row.paymentDelay, 1);
  assert.equal(row.daysSincePayment, null);
  assert.match(row.reason, /لا دفعة مسجّلة/);
});

console.log(`\ncheck-decision-scoring: اجتاز ${passed} فحصاً.`);
