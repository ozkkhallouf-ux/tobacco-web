// ============================================================================
// حارس ذكاء الزبائن — كل قاعدة تجارية في src/customer-intelligence.js مغطّاة
// بحالة انحدار صريحة. هذه الحسابات تُقرأ كقرارات تجارية (من VIP؟ من متوقف؟ من
// قارب حد ائتمانه؟)، فخطأ صامت فيها أسوأ من شاشة لا تفتح.
//
// يعمل بلا شبكة وبلا متصفح: الملف نقي ويُشغَّل داخل vm، فتُثبَّت القواعد محلياً.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const here = fileURLToPath(import.meta.url);

function loadEngine() {
  const source = readFileSync(new URL("../src/customer-intelligence.js", import.meta.url), "utf8");
  const context = vm.createContext({ window: {}, Date, Number, String, Math, Object, Array, Map, Set, JSON, Infinity, isNaN, console });
  vm.runInContext(source, context, { filename: "src/customer-intelligence.js" });
  const engine = context.window.ozkCustomerIntelligence;
  assert.ok(engine, "customer-intelligence.js did not expose window.ozkCustomerIntelligence");
  return engine;
}

const engine = loadEngine();

// ---------------------------------------------------------------------------
// أدوات بناء تركيبة اختبار
// ---------------------------------------------------------------------------
const REFERENCE_ISO = "2026-09-02T04:00:00.000Z";  // لحظة صلاحية تقرير الفواتير
const FROM_DATE = "2026-07-04";                     // بداية تغطية التقرير
// النافذة الناتجة: الحالية 2026-08-04..2026-09-02، السابقة 2026-07-05..2026-08-03.

const line = (material, qty, lineTotal, extra = {}) => ({ material, qty, qtyUnits: qty, lineTotal, ...extra });

function invoice(date, total, extra = {}) {
  return {
    date,
    number: extra.number ?? "1",
    guid: extra.guid ?? `bill-${date}-${total}`,
    total,
    discount: extra.discount ?? 0,
    payment: extra.payment ?? 0,
    isReturn: extra.isReturn ?? false,
    lines: extra.lines ?? [line(extra.material ?? "صنف افتراضي", 1, total)],
    ...(extra.currency ? { currency: extra.currency } : {})
  };
}

const customers = [];
function customer(id, name, options = {}) {
  const entry = {
    id,
    name,
    guid: options.guid ?? `00000000-0000-4000-8000-${String(customers.length + 1).padStart(12, "0")}`,
    balance: options.balance ?? 0,
    creditLimit: options.creditLimit ?? 0,
    isSupplier: options.isSupplier ?? false,
    invoices: options.invoices ?? [],
    skipBalanceRow: options.skipBalanceRow ?? false
  };
  customers.push(entry);
  return entry;
}

// عدة فواتير متساوية على تواريخ محددة
const series = (dates, amount, material = "صنف متكرر") =>
  dates.map((date, index) => invoice(date, amount, { number: String(index + 1), material }));

// ── الزبائن ────────────────────────────────────────────────────────────────
const decline30 = customer("decline30", "زبون التراجع", {
  invoices: [invoice("2026-07-20", 400), invoice("2026-08-01", 600), invoice("2026-08-20", 400), invoice("2026-09-01", 300)]
});
const brandNew = customer("brandNew", "زبون جديد", {
  invoices: [invoice("2026-08-10", 250), invoice("2026-08-25", 250)]
});
const withReturns = customer("withReturns", "زبون المرتجعات", {
  invoices: [
    invoice("2026-07-20", 400),
    invoice("2026-08-15", 500, { lines: [line("دخان أ", 10, 500)] }),
    invoice("2026-08-16", 200, { isReturn: true, lines: [line("دخان أ", 4, 200)] })
  ]
});
const noLimit = customer("noLimit", "زبون بلا حد", { balance: 5000, creditLimit: 0 });
const nearLimit = customer("nearLimit", "زبون قريب من الحد", {
  balance: 900,
  creditLimit: 1000,
  invoices: [invoice("2026-07-20", 400), invoice("2026-08-20", 400)]
});
const overLimit = customer("overLimit", "زبون تجاوز الحد", {
  balance: 1200,
  creditLimit: 1000,
  invoices: [invoice("2026-07-22", 450), invoice("2026-08-22", 450)]
});
const noPurchases = customer("noPurchases", "زبون بلا مشتريات", { balance: 0, creditLimit: 0 });
const vipDeclining = customer("vipDeclining", "زبون كبير متراجع", {
  invoices: [
    ...series(["2026-07-06", "2026-07-15", "2026-07-25", "2026-08-01"], 5000, "دخان فاخر"),
    ...series(["2026-08-10", "2026-08-28"], 3000, "دخان فاخر")
  ]
});
const vipGrowing = customer("vipGrowing", "زبون كبير نامٍ", {
  invoices: [
    ...series(["2026-07-10", "2026-07-28"], 2000, "دخان ممتاز"),
    ...series(["2026-08-06", "2026-08-16", "2026-08-27"], 3000, "دخان ممتاز")
  ]
});
const dirtyNumbers = customer("dirtyNumbers", "زبون بأرقام تالفة", {
  invoices: [
    { date: "2026-08-12", number: "9", guid: "dirty-1", total: null, discount: "abc", payment: undefined, isReturn: false, lines: [{ material: "صنف تالف", qty: undefined, lineTotal: "س" }] },
    invoice("2026-08-18", 350)
  ]
});
const returnsExceed = customer("returnsExceed", "زبون مرتجعه أكبر", {
  invoices: [
    invoice("2026-08-10", 100, { lines: [line("دخان ب", 2, 100)] }),
    invoice("2026-08-20", 500, { isReturn: true, lines: [line("دخان ب", 10, 500)] })
  ]
});
const mixedCurrency = customer("mixedCurrency", "زبون بعملتين", {
  invoices: [invoice("2026-08-10", 500, { currency: "USD" }), invoice("2026-08-20", 3000000, { currency: "SYP" })]
});
const boundary = customer("boundary", "زبون على الحدود", {
  invoices: [invoice("2026-08-03T00:00:00.0000000", 300), invoice("2026-08-04", 300)]
});
const fastCadenceInactive = customer("fastCadenceInactive", "زبون سريع توقف", {
  invoices: series(["2026-07-06", "2026-07-11", "2026-07-16", "2026-07-21", "2026-07-26", "2026-07-31", "2026-08-05", "2026-08-13"], 100)
});
const slowCadenceActive = customer("slowCadenceActive", "زبون بطيء لكنه مستمر", {
  invoices: series(["2026-07-06", "2026-07-21", "2026-08-05"], 200)
});
const unknownCadence = customer("unknownCadence", "زبون بلا نمط كافٍ", {
  invoices: series(["2026-07-15", "2026-08-13"], 300)
});
const reactivated = customer("reactivated", "زبون عاد للنشاط", {
  invoices: series(["2026-07-06", "2026-07-09", "2026-07-12", "2026-08-30"], 150)
});
// اسمان مختلفان يتطابقان بعد التطبيع، بمعرّفين مختلفين — ممنوع الدمج.
const twinA = customer("twinA", "مؤسسة النور", { balance: 700 });
const twinB = customer("twinB", "مؤسسه النور", { balance: 300 });
const supplierAccount = customer("supplierAccount", "مورد لا يُحسب", { balance: 900, isSupplier: true });

// فواتير باسم التوأمين (بلا GUID) — يجب ألا تُنسب لأيٍّ منهما.
const AMBIGUOUS_INVOICES = 2;

function buildReports({ fromDate = FROM_DATE, syncedAt = REFERENCE_ISO } = {}) {
  const invoiceItems = customers
    .filter((entry) => entry.invoices.length)
    .map((entry) => ({ name: entry.name, invoices: entry.invoices, truncated: false }));
  invoiceItems.push({
    name: "مؤسسة النور",
    invoices: [invoice("2026-08-10", 800), invoice("2026-07-15", 600)],
    truncated: false
  });

  const balanceItems = customers.filter((entry) => !entry.skipBalanceRow).map((entry) => ({
    key: engine.normalizeName(entry.name),
    name: entry.name,
    balance: entry.balance,
    creditLimit: entry.creditLimit,
    remainingLimit: entry.creditLimit - entry.balance,
    status: "clear",
    customerGuid: entry.guid,
    customerAccountGuid: entry.guid,
    isSupplier: entry.isSupplier,
    recentPayments: [],
    recentMovements: []
  }));

  return {
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: syncedAt,
      summary: { periodDays: 60, fromDate, customers: invoiceItems.length, bills: 0, syncedAt },
      items: invoiceItems
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: syncedAt,
      summary: { source: "ameen_customer_balances", syncedAt, totalCustomers: balanceItems.length },
      items: balanceItems
    },
    movementsReport: {
      source: "ameen_customer_movements",
      created_at: syncedAt,
      summary: { syncedAt },
      items: []
    },
    creditLimits: []
  };
}

const NOW = new Date("2026-09-02T04:05:00.000Z"); // بعد المزامنة بخمس دقائق ⇒ كل المصادر حديثة
const reports = buildReports();
const result = engine.build({ ...reports, now: NOW });
const byId = new Map(result.customers.map((row) => [row.customerName, row]));
const find = (entry) => {
  const row = byId.get(entry.name);
  assert.ok(row, `لم يُبنَ سجل للزبون: ${entry.name}`);
  return row;
};

// ---------------------------------------------------------------------------
// 0) النافذة الزمنية مشتقة من صلاحية التقرير لا من ساعة الجهاز
// ---------------------------------------------------------------------------
assert.equal(result.window.referenceDate, "2026-09-02", "نقطة الإسناد يجب أن تكون تاريخ صلاحية تقرير الفواتير");
assert.equal(result.window.currentStartDate, "2026-08-04");
assert.equal(result.window.previousStartDate, "2026-07-05");
assert.equal(result.window.previousEndDate, "2026-08-03");
assert.equal(result.window.previousWindowCovered, true);
assert.equal(result.dataAvailability.coverageDays, 61);

// ---------------------------------------------------------------------------
// 1) 1000 ← 700 يساوي تراجعاً 30% بالضبط
// ---------------------------------------------------------------------------
{
  const row = find(decline30);
  assert.equal(row.netSalesPrevious30d, 1000);
  assert.equal(row.netSales30d, 700);
  assert.equal(row.purchaseTrend.state, "measured");
  assert.equal(row.purchaseTrend.percent, -30, "1000 ← 700 يجب أن تعطي -30% تماماً");
  assert.ok(row.flags.includes("declining"), "تراجع 30% مع نشاط سابق كافٍ يجب أن يُعلَّم declining");
  assert.ok(row.explanation.some((textLine) => textLine.includes("30") && textLine.includes("تراجع")),
    "التفسير يجب أن يذكر نسبة التراجع صراحةً");
}

// ---------------------------------------------------------------------------
// 2) الفترة السابقة صفر والحالية موجبة — لا قسمة على صفر
// ---------------------------------------------------------------------------
{
  const row = find(brandNew);
  assert.equal(row.netSalesPrevious30d, 0);
  assert.ok(row.netSales30d > 0);
  assert.equal(row.purchaseTrend.percent, null, "لا نسبة عند أساس صفري");
  assert.equal(row.purchaseTrend.state, "new_activity");
  assert.ok(!row.flags.includes("declining"));
}

// ---------------------------------------------------------------------------
// 3) صافي المبيعات = المبيعات − المرتجعات، والمرتجع لا يُحسب مبيعاً موجباً
// ---------------------------------------------------------------------------
{
  const row = find(withReturns);
  assert.equal(row.sales30d, 500);
  assert.equal(row.returns30d, 200);
  assert.equal(row.netSales30d, 300, "صافي المبيعات يجب أن يطرح المرتجع");
  assert.equal(row.invoiceCount30d, 1, "المرتجع ليس فاتورة بيع");
  assert.equal(row.averageInvoice30d, 500, "متوسط الفاتورة يُحسب على فواتير البيع فقط");
  const topItem = row.topItems.find((item) => item.itemName === "دخان أ");
  assert.ok(topItem, "الصنف يجب أن يظهر في أهم الأصناف");
  assert.equal(topItem.netQty, 6, "صافي الكمية = 10 − 4");
  assert.equal(topItem.netValue, 300, "صافي قيمة الصنف = 500 − 200");
}

// ---------------------------------------------------------------------------
// 4) زبون بلا حد ائتمان — لا يُعامل الحد كصفر ولا يظهر تجاوزاً
// ---------------------------------------------------------------------------
{
  const row = find(noLimit);
  assert.equal(row.creditLimit, null, "غياب الحد ليس صفراً");
  assert.equal(row.creditLimitSource, "missing");
  assert.equal(row.creditUsagePercent, null);
  assert.equal(row.creditStatus, "unknown_limit");
  assert.ok(!row.flags.includes("over_credit_limit"), "زبون بلا حد لا يجوز أن يظهر متجاوزاً");
  assert.ok(row.flags.includes("credit_limit_unknown"));
}

// ---------------------------------------------------------------------------
// 5) قريب من الحد (90%) — نفس عتبة business-snapshot.js القائمة
// ---------------------------------------------------------------------------
{
  const row = find(nearLimit);
  assert.equal(row.creditUsagePercent, 90);
  assert.equal(row.creditStatus, "near_limit");
  assert.ok(row.flags.includes("near_credit_limit"));
  assert.ok(!row.flags.includes("over_credit_limit"));
}

// ---------------------------------------------------------------------------
// 6) تجاوز الحد
// ---------------------------------------------------------------------------
{
  const row = find(overLimit);
  assert.equal(row.creditUsagePercent, 120);
  assert.equal(row.creditStatus, "over_limit");
  assert.ok(row.flags.includes("over_credit_limit"));
  assert.equal(row.riskScore, 100);
}

// ---------------------------------------------------------------------------
// 7) زبون لم يشترِ إطلاقاً ضمن النافذة
// ---------------------------------------------------------------------------
{
  const row = find(noPurchases);
  assert.equal(row.lastPurchaseAt, null);
  assert.equal(row.daysSinceLastPurchase, null);
  assert.ok(row.flags.includes("no_purchases_in_window"));
  assert.ok(!row.flags.includes("cadence_unknown"),
    "من لا مشتريات له لا يحتاج تنبيهين يقولان الشيء نفسه");
  assert.equal(row.primarySegment, "insufficient_data", "غياب أي فاتورة لا يبرّر ادعاء تصنيف تجاري");
}

// ---------------------------------------------------------------------------
// 8) زبون جديد بتاريخ كافٍ يميّزه عن حافة النافذة
// ---------------------------------------------------------------------------
{
  const row = find(brandNew);
  assert.equal(row.firstPurchaseAt, "2026-08-10");
  assert.ok(row.flags.includes("new"), "أول ظهور بعد حافة النافذة يعني زبوناً جديداً فعلاً");
  assert.ok(!row.flags.includes("possibly_new"));

  assert.equal(row.primarySegment, "new", "من ظهر داخل الفترة الحالية تصنيفه الأساسي جديد");

  // من ظهر على حافة النافذة تماماً لا يجوز ادّعاء أنه جديد
  const edgeRow = find(fastCadenceInactive);
  assert.equal(edgeRow.firstPurchaseAt, "2026-07-06");
  assert.ok(!edgeRow.flags.includes("new"), "الظهور على حافة النافذة لا يثبت أنه زبون جديد");

  // ومن بدأ قبل الفترة الحالية يبقى flagه «جديد» (أول ظهوره داخل النافذة
  // المرصودة فعلاً) لكنه لا يعود تصنيفاً أساسياً: عاش فترة مقارنة كاملة، فواقعه
  // التجاري المقيس عليها أولى بالعنوان.
  const older = find(decline30);
  assert.equal(older.firstPurchaseAt, "2026-07-20");
  assert.ok(older.firstPurchaseAt < result.window.currentStartDate, "بدأ قبل الفترة الحالية");
  assert.ok(older.flags.includes("new"));
  assert.ok(older.flags.includes("declining"));
  assert.notEqual(older.primarySegment, "new", "«جديد» لا يجوز أن يحجب واقعاً مقيساً على فترة مقارنة كاملة");
}

// ---------------------------------------------------------------------------
// 9) تاريخ غير كافٍ ⇒ insufficient_data بدل نسبة مخترعة
// ---------------------------------------------------------------------------
{
  const shortReports = buildReports({ fromDate: "2026-08-20" });
  const shortResult = engine.build({ ...shortReports, now: NOW });
  assert.equal(shortResult.window.previousWindowCovered, false);
  const row = shortResult.customers.find((entry) => entry.customerName === decline30.name);
  assert.equal(row.purchaseTrend.state, "insufficient_data");
  assert.equal(row.purchaseTrend.percent, null);
  assert.ok(row.flags.includes("insufficient_history"));
  assert.ok(!row.flags.includes("declining"), "لا يجوز ادّعاء تراجع فوق نافذة ناقصة");
}

// ---------------------------------------------------------------------------
// 10) VIP بالترتيب النسبي لا برقم ثابت
// ---------------------------------------------------------------------------
{
  assert.equal(result.dataAvailability.vipRankingReliable, true);
  const big = find(vipDeclining);
  const second = find(vipGrowing);
  assert.equal(big.vipRank, 1, "أعلى قيمة وتكرار يجب أن يحتل المرتبة الأولى");
  assert.equal(second.vipRank, 2);
  assert.ok(big.flags.includes("vip"));
  assert.ok(second.flags.includes("vip"));
  assert.ok(!find(withReturns).flags.includes("vip"), "زبون صغير لا يصبح VIP");
  const expectedVipCount = Math.max(1, Math.ceil(engine.CONFIG.vipTopShare * result.dataAvailability.vipPopulation));
  assert.equal(result.customers.filter((row) => row.flags.includes("vip")).length, expectedVipCount,
    "عدد VIP يجب أن يساوي النسبة المئوية المعلنة من المرشحين");

  // عيّنة أصغر من الحد الأدنى ⇒ لا ترتيب نسبي موثوق ⇒ لا VIP
  const tiny = engine.build({
    invoicesReport: {
      created_at: REFERENCE_ISO,
      summary: { periodDays: 60, fromDate: FROM_DATE, syncedAt: REFERENCE_ISO },
      items: [{ name: "زبون وحيد", invoices: [invoice("2026-08-10", 9999), invoice("2026-08-20", 9999)] }]
    },
    balancesReport: { created_at: REFERENCE_ISO, summary: { syncedAt: REFERENCE_ISO }, items: [] },
    now: NOW
  });
  assert.equal(tiny.dataAvailability.vipRankingReliable, false);
  assert.equal(tiny.summary.vipCount, 0, "عيّنة صغيرة لا تنتج VIP");
  assert.ok(tiny.customers[0].flags.includes("vip_ranking_unreliable"));
}

// ---------------------------------------------------------------------------
// 11) زبون VIP متراجع يبقى VIP مع flag تراجع
// ---------------------------------------------------------------------------
{
  const row = find(vipDeclining);
  assert.equal(row.purchaseTrend.percent, -70);
  assert.ok(row.flags.includes("declining"));
  assert.equal(row.primarySegment, "vip", "التصنيف الأساسي لا يجوز أن يفقد VIP بسبب تراجع");
  assert.ok(!row.flags.includes("inactive"));
}

// ---------------------------------------------------------------------------
// 12) اسمان متطابقان بعد التطبيع بمعرّفين مختلفين — ممنوع الدمج
// ---------------------------------------------------------------------------
{
  const a = find(twinA);
  const b = find(twinB);
  assert.notEqual(a.customerId, b.customerId, "المعرّفان يجب أن يبقيا منفصلين");
  assert.equal(a.customerGuid, twinA.guid);
  assert.equal(b.customerGuid, twinB.guid);
  for (const row of [a, b]) {
    assert.ok(row.flags.includes("ambiguous_identity"));
    assert.equal(row.primarySegment, "insufficient_data");
    assert.equal(row.netSales30d, null, "لا يجوز نسب مبيعات إلى اسم ملتبس");
    assert.equal(row.netSales60d, null);
  }
  assert.equal(result.dataAvailability.unresolvedAmbiguousInvoiceRows, AMBIGUOUS_INVOICES,
    "فواتير الاسم الملتبس يجب أن تُحصى غير منسوبة، لا أن تُدمج");
  assert.equal(result.summary.ambiguousIdentityCount, 2);
}

// ---------------------------------------------------------------------------
// 13) مصدر قديم ⇒ staleData ظاهر ولا يُخفى
// ---------------------------------------------------------------------------
{
  const staleResult = engine.build({ ...buildReports(), now: new Date("2026-09-12T04:00:00.000Z") });
  assert.equal(staleResult.staleData, true);
  assert.equal(staleResult.sourcesFreshness.invoices.state, "stale");
  assert.equal(staleResult.sourcesFreshness.balances.state, "stale");
  assert.ok(staleResult.customers.every((row) => row.flags.includes("stale_data")));
  // النافذة لا تتحرك بتقادم المصدر — التقادم يُعلَن ولا يُعوَّض بتزوير التواريخ.
  assert.equal(staleResult.window.referenceDate, "2026-09-02");
  assert.equal(result.staleData, false, "التركيبة الأساسية يجب أن تكون حديثة");
}

// ---------------------------------------------------------------------------
// 14) قيم رقمية فارغة/غير صالحة لا تنتج NaN ولا null متسللاً في الحسابات
// ---------------------------------------------------------------------------
{
  const row = find(dirtyNumbers);
  assert.equal(row.netSales30d, 350, "الفاتورة التالفة تُقرأ صفراً ولا تُفسد المجموع");
  assert.equal(row.invoiceCount30d, 2);

  const scan = (value, path = "$") => {
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value), `قيمة غير منتهية في ${path}: ${value}`);
      return;
    }
    if (Array.isArray(value)) { value.forEach((entry, index) => scan(entry, `${path}[${index}]`)); return; }
    if (value && typeof value === "object") { for (const [key, entry] of Object.entries(value)) scan(entry, `${path}.${key}`); }
  };
  scan(result);
}

// ---------------------------------------------------------------------------
// 15) مرتجع أكبر من المبيعات ضمن الفترة
// ---------------------------------------------------------------------------
{
  const row = find(returnsExceed);
  assert.equal(row.sales30d, 100);
  assert.equal(row.returns30d, 500);
  assert.equal(row.netSales30d, -400, "الصافي السالب حقيقة تجارية ولا يُقصّ إلى صفر");
  assert.ok(row.flags.includes("returns_exceed_sales"));
}

// ---------------------------------------------------------------------------
// 16) عملات متعددة — ممنوع جمع USD مع SYP
// ---------------------------------------------------------------------------
{
  const row = find(mixedCurrency);
  assert.equal(row.currencyMixed, true);
  assert.ok(row.flags.includes("mixed_currency"));
  assert.equal(row.netSales30d, null, "جمع عملتين مختلفتين ممنوع، والمخرج يجب أن يكون null لا رقماً مضلِّلاً");
  assert.equal(row.primarySegment, "insufficient_data");

  const single = find(decline30);
  assert.equal(single.currencyMixed, false);
  assert.equal(single.currency, "USD", "غياب العملة يعني عملة الأساس الموثّقة");
}

// ---------------------------------------------------------------------------
// 17) حدود التاريخ والمنطقة الزمنية
// ---------------------------------------------------------------------------
{
  const row = find(boundary);
  assert.equal(row.invoiceCountPrevious30d, 1, "فاتورة 2026-08-03 تخص الفترة السابقة");
  assert.equal(row.invoiceCount30d, 1, "فاتورة 2026-08-04 تخص الفترة الحالية");
  assert.equal(row.lastPurchaseAt, "2026-08-04");
  assert.equal(row.firstPurchaseAt, "2026-08-03");
}

// ---------------------------------------------------------------------------
// 18) الخمول يقاس على نمط الزبون لا بعتبة موحّدة
// ---------------------------------------------------------------------------
{
  const fast = find(fastCadenceInactive);
  assert.equal(fast.typicalGapDays, 5);
  assert.equal(fast.cadenceTrusted, true);
  assert.equal(fast.inactiveThresholdDays, 14);
  assert.equal(fast.daysSinceLastPurchase, 20);
  assert.ok(fast.flags.includes("inactive"), "من يشتري كل 5 أيام وغاب 20 يوماً متوقف فعلاً");
  assert.equal(fast.primarySegment, "inactive");

  const slow = find(slowCadenceActive);
  assert.equal(slow.typicalGapDays, 15);
  assert.equal(slow.inactiveThresholdDays, 30);
  assert.equal(slow.daysSinceLastPurchase, 28);
  assert.ok(!slow.flags.includes("inactive"), "من فجوته المعتادة 15 يوماً وغاب 28 ليس متوقفاً");
  assert.ok(slow.flags.includes("at_risk_churn"), "لكنه يتجاوز 1.5 ضعف نمطه ⇒ تحذير مبكر");

  const unknown = find(unknownCadence);
  assert.equal(unknown.cadenceTrusted, false, "شراءان فقط لا يكفيان لنمط");
  assert.equal(unknown.inactiveThresholdDays, engine.CONFIG.inactiveFallbackDays);
  assert.equal(unknown.daysSinceLastPurchase, 20);
  assert.ok(!unknown.flags.includes("inactive"), "الحد الاحتياطي 30 يوماً يمنع اتهاماً مبكراً");
  assert.ok(unknown.flags.includes("cadence_unknown"), "ويجب الإفصاح أن النمط غير محسوب");
}

// ---------------------------------------------------------------------------
// 19) العودة للنشاط بعد انقطاع أطول من النمط
// ---------------------------------------------------------------------------
{
  const row = find(reactivated);
  assert.ok(row.flags.includes("reactivated"));
  assert.equal(row.primarySegment, "reactivated");
  assert.ok(!row.flags.includes("inactive"));
  assert.ok(row.explanation.some((entry) => entry.includes("عاد للشراء")));
}

// ---------------------------------------------------------------------------
// 20) حسابات الموردين لا تُخلط بإحصاءات الزبائن
// ---------------------------------------------------------------------------
{
  const row = find(supplierAccount);
  assert.ok(row.flags.includes("supplier_account"));
  assert.equal(result.summary.totalCustomers, result.customers.filter((entry) => !entry.isSupplier).length);
  assert.ok(result.summary.totalCustomers < result.customers.length);
}

// ---------------------------------------------------------------------------
// 21) الحساب حتمي بالكامل: نفس المدخلات ⇒ نفس المخرجات حرفياً
// ---------------------------------------------------------------------------
{
  const again = engine.build({ ...buildReports(), now: NOW });
  assert.deepEqual(
    JSON.parse(JSON.stringify({ ...again, generatedAt: null })),
    JSON.parse(JSON.stringify({ ...result, generatedAt: null })),
    "الحساب يجب أن يكون deterministic بالكامل"
  );

  // وترتيب المدخلات لا يغيّر النتيجة
  const shuffled = buildReports();
  shuffled.invoicesReport.items = shuffled.invoicesReport.items.slice().reverse();
  shuffled.balancesReport.items = shuffled.balancesReport.items.slice().reverse();
  const reversed = engine.build({ ...shuffled, now: NOW });
  const key = (row) => `${row.customerId}|${row.primarySegment}|${row.netSales30d}|${row.riskScore}|${row.vipRank}`;
  assert.deepEqual(
    reversed.customers.map(key).sort(),
    result.customers.map(key).sort(),
    "عكس ترتيب المدخلات يجب ألا يغيّر أي تصنيف أو درجة"
  );
}

// ---------------------------------------------------------------------------
// 22) لا مصادر بيانات إطلاقاً ⇒ لا انهيار ولا ادّعاء
// ---------------------------------------------------------------------------
{
  const empty = engine.build({ now: NOW });
  assert.equal(empty.customers.length, 0);
  assert.equal(empty.summary.totalCustomers, 0);
  assert.equal(empty.dataAvailability.invoicesAvailable, false);
  assert.equal(empty.staleData, true, "غياب المصدر يعني عدم ثقة، لا ثقة كاملة");
}

// ---------------------------------------------------------------------------
// 23) المخرج الآلي (Cowork) ثابت الشكل ولا يسرّب حسابات الموردين
// ---------------------------------------------------------------------------
{
  const payload = engine.buildCoworkPayload(result);
  for (const field of ["schemaVersion", "generatedAt", "window", "sourcesFreshness", "staleData", "summary",
    "customersNeedingAttention", "vipDeclining", "inactiveCustomers", "debtRisks", "reactivatedCustomers"]) {
    assert.ok(field in payload, `مخرج Cowork ينقصه الحقل ${field}`);
  }
  const names = new Set([
    ...payload.customersNeedingAttention, ...payload.vipDeclining, ...payload.inactiveCustomers,
    ...payload.debtRisks, ...payload.reactivatedCustomers
  ].map((row) => row.customerName));
  assert.ok(!names.has(supplierAccount.name), "المخرج الآلي يجب أن يستبعد حسابات الموردين");
  assert.ok(payload.vipDeclining.some((row) => row.customerName === vipDeclining.name));
  assert.ok(payload.inactiveCustomers.some((row) => row.customerName === fastCadenceInactive.name));
  assert.ok(payload.debtRisks.some((row) => row.customerName === overLimit.name));
  assert.ok(payload.reactivatedCustomers.some((row) => row.customerName === reactivated.name));
  const attentionIds = payload.customersNeedingAttention.map((row) => row.customerId);
  assert.equal(new Set(attentionIds).size, attentionIds.length, "لا تكرار في قائمة من يحتاج متابعة");
}

// ---------------------------------------------------------------------------
// 24) مسودات التنبيهات تحمل مفتاح منع تكرار وفترة تهدئة، ولا ترسل شيئاً
// ---------------------------------------------------------------------------
{
  const drafts = engine.buildAlertDrafts(result);
  assert.ok(drafts.length > 0);
  for (const draft of drafts) {
    assert.ok(draft.dedupeKey && draft.dedupeKey.startsWith("customer-intel:"), "كل تنبيه يحتاج dedupeKey");
    assert.ok(Number.isInteger(draft.cooldownMinutes) && draft.cooldownMinutes > 0, "كل تنبيه يحتاج فترة تهدئة");
    assert.ok(draft.message && draft.message.length > 5);
  }
  assert.equal(new Set(drafts.map((draft) => draft.dedupeKey)).size, drafts.length, "مفاتيح منع التكرار يجب أن تكون فريدة");
  const source = readFileSync(new URL("../src/customer-intelligence.js", import.meta.url), "utf8");
  for (const name of ["fetch(", "XMLHttpRequest", "document.", "localStorage"]) {
    assert.ok(!source.includes(name), `طبقة الحساب يجب أن تبقى نقية بلا أثر جانبي: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 25) نفس النتائج تحت مناطق زمنية متطرفة (حدود التاريخ لا تنزلق بيوم)
// ---------------------------------------------------------------------------
if (!process.env.OZK_CI_TZ_CHILD) {
  const fingerprint = result.customers
    .map((row) => `${row.customerName}|${row.firstPurchaseAt}|${row.lastPurchaseAt}|${row.invoiceCount30d}|${row.invoiceCountPrevious30d}|${row.primarySegment}`)
    .join("\n");
  for (const timezone of ["Pacific/Kiritimati", "Pacific/Niue", "Asia/Damascus", "UTC"]) {
    const child = spawnSync(process.execPath, [here], {
      env: { ...process.env, TZ: timezone, OZK_CI_TZ_CHILD: "1", OZK_CI_TZ_PRINT: "1" },
      encoding: "utf8"
    });
    assert.equal(child.status, 0, `فشل الفحص تحت المنطقة الزمنية ${timezone}:\n${child.stderr}`);
    assert.equal(child.stdout.trim(), fingerprint, `تغيّرت النتائج تحت المنطقة الزمنية ${timezone}`);
  }
} else if (process.env.OZK_CI_TZ_PRINT) {
  process.stdout.write(result.customers
    .map((row) => `${row.customerName}|${row.firstPurchaseAt}|${row.lastPurchaseAt}|${row.invoiceCount30d}|${row.invoiceCountPrevious30d}|${row.primarySegment}`)
    .join("\n"));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 26) Codex P1 regression — عملة null بجانب SYP تُكشَف كتنوع لا تختفي
// (Fix #2: تطبيع العملة قبل Set بدلاً من filter(Boolean))
// ---------------------------------------------------------------------------
{
  // بناء معزول بزبون واحد: فاتورة بلا حقل currency + فاتورة صريحة SYP.
  // قبل الإصلاح: filter(Boolean) يحذف null، تبقى {"SYP"} وحيدة، currencyMixed=false
  // وتُضاف مبالغ "USD" الوهمية إلى SYP خطأً.
  // بعد الإصلاح: null → CONFIG.baseCurrency (USD)، الـSet = {"USD","SYP"}، currencyMixed=true.
  function buildIsolated(invoiceList, name = "isolated") {
    return engine.build({
      invoicesReport: {
        source: "ameen_customer_invoices",
        created_at: REFERENCE_ISO,
        summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 0, syncedAt: REFERENCE_ISO },
        items: [{ name, invoices: invoiceList, truncated: false }]
      },
      balancesReport: {
        source: "ameen_customer_balances",
        created_at: REFERENCE_ISO,
        summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
        items: [{ key: engine.normalizeName(name), name, balance: 0, creditLimit: 0, remainingLimit: 0, status: "clear", customerGuid: "0000-26", customerAccountGuid: "0000-26", isSupplier: false, recentPayments: [], recentMovements: [] }]
      },
      movementsReport: null,
      creditLimits: [],
      now: NOW
    });
  }

  const nullPlusSyp = buildIsolated([
    invoice("2026-08-10", 500, {}),                           // بلا currency → يُطبَّع USD
    invoice("2026-08-20", 3000000, { currency: "SYP" })
  ]);
  const row26 = nullPlusSyp.customers.find((r) => !r.isSupplier);
  assert.ok(row26, "test 26: يجب أن يُبنى سجل للزبون");
  assert.equal(row26.currencyMixed, true,  "test 26: null+SYP يجب أن يُكشَف كتنوع عملة (currencyMixed=true)");
  assert.equal(row26.netSales30d,   null,  "test 26: لا يجوز جمع مبالغ بعملتين مختلفتين");
  assert.ok(row26.flags.includes("mixed_currency"), "test 26: flag mixed_currency يجب أن يُرفع");

  // تأكيد عكسي: فاتورة بلا currency وحدها = عملة الأساس (USD)، لا تنوع.
  const nullOnly = buildIsolated([invoice("2026-08-10", 500, {}), invoice("2026-08-20", 800, {})], "nullOnly");
  const row26b = nullOnly.customers.find((r) => !r.isSupplier);
  assert.equal(row26b.currencyMixed, false, "test 26b: فواتير بلا عملة وحدها = USD، لا تنوع");
  assert.equal(row26b.currency,      "USD", "test 26b: العملة الافتراضية يجب أن تكون CONFIG.baseCurrency");
}

// ---------------------------------------------------------------------------
// 27) Codex P1 regression — الإجمالي في summary لا يخلط عملات مختلفة
// (Fix #3: تصفية active بعملة الأساس فقط لـnetSales30d/netSalesPrevious30d)
// ---------------------------------------------------------------------------
{
  // زبون USD (100$) + زبون SYP (1,000,000 ل.س): الإجمالي يجب أن يعكس 100 فقط.
  function buildTwoCurrencies() {
    const mkCustomer = (name, guid, invoiceList) => ({
      name,
      guid,
      balance: 0,
      creditLimit: 0,
      remainingLimit: 0,
      status: "clear",
      customerGuid: guid,
      customerAccountGuid: guid,
      isSupplier: false,
      recentPayments: [],
      recentMovements: []
    });
    return engine.build({
      invoicesReport: {
        source: "ameen_customer_invoices",
        created_at: REFERENCE_ISO,
        summary: { periodDays: 60, fromDate: FROM_DATE, customers: 2, bills: 0, syncedAt: REFERENCE_ISO },
        items: [
          { name: "زبون دولار",  invoices: [invoice("2026-08-10", 100, { currency: "USD" })],     truncated: false },
          { name: "زبون ليرة",   invoices: [invoice("2026-08-10", 1000000, { currency: "SYP" })], truncated: false }
        ]
      },
      balancesReport: {
        source: "ameen_customer_balances",
        created_at: REFERENCE_ISO,
        summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 2 },
        items: [
          mkCustomer("زبون دولار", "0000-27a"),
          mkCustomer("زبون ليرة",  "0000-27b")
        ]
      },
      movementsReport: null,
      creditLimits: [],
      now: NOW
    });
  }

  const r27 = buildTwoCurrencies();
  assert.equal(r27.summary.netSales30d, 100,
    "test 27: الإجمالي يجب أن يعكس USD فقط (100)، لا مزجاً مع SYP (1,100,100 خطأ)");
  assert.equal(r27.summary.currency, "USD", "test 27: عملة الإجمالي يجب أن تبقى USD");
}

// ---------------------------------------------------------------------------
// 28) Codex P1 regression — money() في الواجهة يمرّر row.currency لا $ ثابت
// (Fix #1: تحقق بنيوي أن الـformatter يستقبل معامل العملة ويُستخدم صح)
// ---------------------------------------------------------------------------
{
  const viewSrc = readFileSync(new URL("../src/customer-intelligence-view.js", import.meta.url), "utf8");
  assert.ok(
    /const money = \(value, currency/.test(viewSrc),
    "test 28: money() يجب أن يقبل معامل currency — لا عملة ثابتة مُلصَقة"
  );
  assert.ok(
    /money\(row\.netSales30d, row\.currency\)/.test(viewSrc),
    "test 28: مبيعات 30 يوم في الجدول يجب أن تمرّر row.currency إلى money()"
  );
  assert.ok(
    /money\(row\.netSalesPrevious30d, row\.currency\)/.test(viewSrc),
    "test 28: مبيعات الفترة السابقة في الجدول يجب أن تمرّر row.currency إلى money()"
  );
  assert.ok(
    !/money\(row\.netSales30d\)/.test(viewSrc),
    "test 28: لا يجوز استدعاء money(row.netSales30d) بدون تمرير العملة"
  );
}

console.log(`ذكاء الزبائن: 28 عقداً محسوماً — ${result.customers.length} سجل زبون، ${result.summary.vipCount} VIP، ${result.summary.decliningCount} متراجع، ${result.summary.inactiveCount} متوقف.`);
