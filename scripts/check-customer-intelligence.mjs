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

const coreEngine = loadEngine();

// قرار المالك (2026-09-27): بلا lineKinds:v1 الحد الآلي مغلق. عقود المحرك السابقة (1..76)
// تُبنى على دفتر موسوم يطابق تصنيفها القديم حرفياً: مدين = sale (والافتتاحي opening)،
// دائن = sale_payment (وbillGuid ⇒ return، والافتتاحي opening). `untyped: true` يمرّر
// التقرير كما هو لاختبار المصدر غير الموسوم نفسه (77..80).
const OPENING_NOTE = /افتتاح/u;
const rawBuild = coreEngine.build;
function typedMovements(report) {
  if (!report || !Array.isArray(report.items) || report.summary?.lineKinds) return report;
  const kindOf = (m) => {
    if (m.lineKind) return m.lineKind;
    if (OPENING_NOTE.test(m.notes || "")) return "opening";
    if (Number(m.debit) > 0) return "sale";
    return m.billGuid ? "return" : "sale_payment";
  };
  return {
    ...report,
    summary: { ...report.summary, lineKinds: "v1" },
    items: report.items.map((item) => ({ ...item, movements: (item.movements || []).map((m) => ({ ...m, lineKind: kindOf(m) })) }))
  };
}
const engine = Object.freeze({
  ...coreEngine,
  build: (input = {}) => {
    const { untyped, ...rest } = input;
    return rawBuild(untyped ? rest : { ...rest, movementsReport: typedMovements(rest.movementsReport) });
  }
});

// ---------------------------------------------------------------------------
// أدوات بناء تركيبة اختبار
// ---------------------------------------------------------------------------
const REFERENCE_ISO = "2026-09-02T04:00:00.000Z";  // لحظة صلاحية تقرير الفواتير
// يوم المحاسبة المحلي للمصادر الثلاثة (`report_date` بتوقيت جهاز الأمين، 07:00 دمشق).
const REFERENCE_LOCAL_DAY = "2026-09-02";
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
    ...(extra.currency ? { currency: extra.currency } : {}),
    ...(extra.currencyVal != null ? { currencyVal: extra.currencyVal } : {})
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
  invoices: [
    invoice("2026-08-10", 500, { currency: "USD", currencyVal: 1 }),
    invoice("2026-08-20", 3000000, { currency: "SYP", currencyVal: 1 })
  ]
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
      created_at: syncedAt, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate, customers: invoiceItems.length, bills: 0, syncedAt },
      items: invoiceItems
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: syncedAt, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt, totalCustomers: balanceItems.length },
      items: balanceItems
    },
    movementsReport: {
      source: "ameen_customer_movements",
      created_at: syncedAt, report_date: REFERENCE_LOCAL_DAY,
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
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, syncedAt: REFERENCE_ISO },
      items: [{ name: "زبون وحيد", invoices: [invoice("2026-08-10", 9999), invoice("2026-08-20", 9999)] }]
    },
    balancesReport: { created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY, summary: { syncedAt: REFERENCE_ISO }, items: [] },
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
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
        summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 0, syncedAt: REFERENCE_ISO },
        items: [{ name, invoices: invoiceList, truncated: false }]
      },
      balancesReport: {
        source: "ameen_customer_balances",
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
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
    invoice("2026-08-20", 3000000, { currency: "SYP", currencyVal: 1 })
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
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
        summary: { periodDays: 60, fromDate: FROM_DATE, customers: 2, bills: 0, syncedAt: REFERENCE_ISO },
        items: [
          { name: "زبون دولار",  invoices: [invoice("2026-08-10", 100, { currency: "USD" })],     truncated: false },
          { name: "زبون ليرة",   invoices: [invoice("2026-08-10", 1000000, { currency: "SYP", currencyVal: 1 })], truncated: false }
        ]
      },
      balancesReport: {
        source: "ameen_customer_balances",
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
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

// ---------------------------------------------------------------------------
// 29) Codex P1 regression — topItems لا يجمع lineTotals بعملات مختلفة
// (Fix P1-B: currencyMixed → items: [], لا قيمة خيالية بعملتين مدمجتين)
// ---------------------------------------------------------------------------
{
  function buildMixedForItems() {
    const mkB = (name, guid, currentBalance = 0) => ({
      name, key: name, customerGuid: guid, currentBalance, isSupplier: false,
      recentPayments: [], recentMovements: []
    });
    return engine.build({
      invoicesReport: {
        source: "ameen_customer_invoices",
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
        summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 0, syncedAt: REFERENCE_ISO },
        items: [{
          name: "زبون مختلط",
          truncated: false,
          invoices: [
            { date: "2026-08-10", number: "1", guid: "g1", total: 100, discount: 0, payment: 0, isReturn: false,
              currency: "USD", currencyVal: 1, lines: [line("صنف أ", 1, 100)] },
            { date: "2026-08-11", number: "2", guid: "g2", total: 1000000, discount: 0, payment: 0, isReturn: false,
              currency: "SYP", currencyVal: 1, lines: [line("صنف أ", 1, 1000000)] }
          ]
        }]
      },
      balancesReport: {
        source: "ameen_customer_balances",
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
        summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
        items: [mkB("زبون مختلط", "0000-29a")]
      },
      movementsReport: null, creditLimits: [], now: NOW
    });
  }
  const r29 = buildMixedForItems();
  const cust29 = r29.customers.find((c) => c.customerName === "زبون مختلط");
  assert.ok(cust29, "test 29: الزبون المختلط يجب أن يوجد في النتيجة");
  assert.equal(cust29.topItems.length, 0,
    "test 29: topItems يجب أن يكون فارغاً للزبون المختلط (لا جمع USD+SYP)");
  assert.equal(cust29.currencyMixed, true, "test 29: currencyMixed=true للزبون المختلط");
  assert.equal(cust29.primarySegment, "insufficient_data", "test 29: مقطع insufficient_data للزبون المختلط");
}

// ---------------------------------------------------------------------------
// 30) Codex P1 regression — truncated group تُعطّل usableSales
// (Fix P1-C: group.truncated=true → usableSales=false + truncated=true في الصف)
// ---------------------------------------------------------------------------
{
  function buildTruncated() {
    const mkB = (name, guid, currentBalance = 0) => ({
      name, key: name, customerGuid: guid, currentBalance, isSupplier: false,
      recentPayments: [], recentMovements: []
    });
    return engine.build({
      invoicesReport: {
        source: "ameen_customer_invoices",
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
        summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 0, syncedAt: REFERENCE_ISO },
        items: [{
          name: "زبون مقتطع",
          truncated: true,
          invoices: [invoice("2026-08-10", 500, { currency: "USD" })]
        }]
      },
      balancesReport: {
        source: "ameen_customer_balances",
        created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
        summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
        items: [mkB("زبون مقتطع", "0000-30a")]
      },
      movementsReport: null, creditLimits: [], now: NOW
    });
  }
  const r30 = buildTruncated();
  const cust30 = r30.customers.find((c) => c.customerName === "زبون مقتطع");
  assert.ok(cust30, "test 30: الزبون المقتطع يجب أن يوجد في النتيجة");
  assert.equal(cust30.truncated, true, "test 30: truncated=true يجب أن يُنقَل إلى صف الزبون");
  assert.equal(cust30.primarySegment, "insufficient_data", "test 30: primarySegment=insufficient_data للزبون المقتطع");
  assert.equal(cust30.netSales30d, null, "test 30: مبيعات المقتطع يجب أن تكون null لا قيمة وهمية");
}

// ---------------------------------------------------------------------------
// 31) Codex P1 regression — view clears intel on sign-out + accessors gated
// (Fix P1-A: syncTimer clears intel when !session; snapshot/coworkPayload gate on canAccess)
// ---------------------------------------------------------------------------
{
  const viewSrc = readFileSync(new URL("../src/customer-intelligence-view.js", import.meta.url), "utf8");
  assert.ok(
    /if \(!state\?\.session\) intel = null/.test(viewSrc),
    "test 31: syncTimer يجب أن يمسح intel عند تسجيل الخروج (!state.session)"
  );
  assert.ok(
    /snapshot.*ozkCanAccessRoute/.test(viewSrc),
    "test 31: snapshot() يجب أن يتحقق من ozkCanAccessRoute قبل إرجاع البيانات"
  );
  assert.ok(
    /coworkPayload.*ozkCanAccessRoute/.test(viewSrc),
    "test 31: coworkPayload() يجب أن يتحقق من ozkCanAccessRoute قبل إرجاع البيانات"
  );
}

// ---------------------------------------------------------------------------
// 32) حد ائتمان محفوظ بالمعرّف يبقى بعد إعادة تسمية الحساب، ولا يُورَّث بالاسم
// ---------------------------------------------------------------------------
{
  const GUID = "500d8ef6-3563-48a3-b65b-713f0ee57e80";
  const OTHER = "aaaaaaaa-0000-4000-8000-000000000099";
  const mkB = (name, guid, balance) => ({
    key: engine.normalizeName(name),
    name,
    balance,
    creditLimit: 0,
    remainingLimit: 0,
    status: "clear",
    customerGuid: guid,
    customerAccountGuid: guid,
    isSupplier: false,
    recentPayments: [],
    recentMovements: []
  });
  const r32 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 0, syncedAt: REFERENCE_ISO },
      items: [{
        name: "لؤي خلوف المحترم / الضاحية",
        customerGuid: GUID,
        truncated: false,
        invoices: [invoice("2026-08-10", 400, { currency: "USD" })]
      }]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 2 },
      items: [
        mkB("لؤي خلوف المحترم / الضاحية", GUID, 4000),
        mkB("لؤي زهية الضاحية", OTHER, 100)
      ]
    },
    movementsReport: null,
    creditLimits: [{
      customerKey: engine.normalizeName("لؤي زهية الضاحية"),
      customerName: "لؤي زهية الضاحية",
      customerGuid: GUID,
      credit_limit: 5000
    }],
    now: NOW
  });
  const renamed = r32.customers.find((row) => row.customerGuid === GUID);
  assert.ok(renamed, "test 32: الزبون المعاد تسميته يجب أن يظهر");
  // حد customer_credit_limits القديم مرجع تشخيصي فقط (قرار 2026-09-27: حد آلي
  // واحد) — لا يصير حداً فعلياً، لكنه يبقى مربوطاً بالمعرّف لا بالاسم.
  assert.equal(renamed.legacyCreditLimit, 5000, "test 32: الحد القديم يبقى مربوطاً بالمعرّف بعد تغيير الاسم");
  assert.equal(renamed.creditLimit, null, "test 32: الحد القديم لا يصير حداً فعلياً");
  assert.equal(renamed.creditLimitSource, "missing", "test 32: بلا دفتر ولا حد أمين = غير محدد");
  const namesake = r32.customers.find((row) => row.customerGuid === OTHER);
  assert.ok(namesake, "test 32: الحساب الآخر يجب أن يظهر");
  assert.equal(namesake.legacyCreditLimit, null, "test 32: حساب بمعرّف مختلف لا يرث الحد القديم بالاسم");
  assert.equal(namesake.creditLimit, null);
  assert.equal(namesake.creditLimitSource, "missing");
}

// ---------------------------------------------------------------------------
// 33) Codex P1 — مورد بمبيعات كبيرة لا يفعّل ترتيب VIP ولا يأخذ مقعداً
// ---------------------------------------------------------------------------
{
  function guidFor(n) {
    return `500d8ef6-3563-48a3-b65b-${String(n).padStart(12, "0")}`;
  }
  function party(name, guid, isSupplier, invoices) {
    return {
      invoices: { name, customerGuid: guid, truncated: false, invoices },
      balance: {
        key: engine.normalizeName(name),
        name,
        balance: 0,
        creditLimit: 0,
        remainingLimit: 0,
        status: "clear",
        customerGuid: guid,
        customerAccountGuid: guid,
        isSupplier,
        recentPayments: [],
        recentMovements: []
      }
    };
  }
  const modest = [invoice("2026-07-20", 100), invoice("2026-08-20", 100)];
  const huge = [invoice("2026-07-06", 20000), invoice("2026-07-20", 20000), invoice("2026-08-10", 20000), invoice("2026-08-28", 20000)];
  const parties = [
    party("زبون أ", guidFor(1), false, modest),
    party("زبون ب", guidFor(2), false, modest),
    party("زبون ج", guidFor(3), false, modest),
    party("زبون د", guidFor(4), false, modest),
    party("مورد جملة", guidFor(5), true, huge)
  ];
  const r33 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: parties.length, bills: 0, syncedAt: REFERENCE_ISO },
      items: parties.map((entry) => entry.invoices)
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: parties.length },
      items: parties.map((entry) => entry.balance)
    },
    movementsReport: null,
    creditLimits: [],
    now: NOW
  });
  const supplier33 = r33.customers.find((row) => row.customerName === "مورد جملة");
  const customers33 = r33.customers.filter((row) => !row.isSupplier);
  assert.ok(supplier33, "test 33: المورد يجب أن يظهر في السجلات");
  assert.ok(supplier33.flags.includes("supplier_account"));
  assert.ok(!supplier33.flags.includes("vip"), "test 33: المورد لا يأخذ مقعد VIP");
  assert.equal(supplier33.vipRank, null, "test 33: المورد خارج ترتيب VIP");
  assert.equal(r33.summary.vipCount, 0, "test 33: أربعة زبائن لا يكفيان لترتيب VIP موثوق");
  assert.ok(customers33.every((row) => row.flags.includes("vip_ranking_unreliable")),
    "test 33: الزبائن يُعلَّمون أن الترتيب غير موثوق");
  assert.ok(!supplier33.flags.includes("vip_ranking_unreliable"),
    "test 33: علم الترتيب غير الموثوق لا يُلصق بالمورد");
}

// ---------------------------------------------------------------------------
// 34) Codex P1 — مورد ضخم لا يرفع أرضية التراجع فيحجب زبون متراجع
// ---------------------------------------------------------------------------
{
  const CUST = "500d8ef6-3563-48a3-b65b-000000000021";
  const SUP = "500d8ef6-3563-48a3-b65b-000000000022";
  const mkB = (name, guid, isSupplier) => ({
    key: engine.normalizeName(name),
    name,
    balance: 0,
    creditLimit: 0,
    remainingLimit: 0,
    status: "clear",
    customerGuid: guid,
    customerAccountGuid: guid,
    isSupplier,
    recentPayments: [],
    recentMovements: []
  });
  const r34 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 2, bills: 0, syncedAt: REFERENCE_ISO },
      items: [
        {
          name: "زبون تراجع حقيقي",
          customerGuid: CUST,
          truncated: false,
          invoices: [
            invoice("2026-07-10", 50),
            invoice("2026-07-20", 50),
            invoice("2026-08-10", 35),
            invoice("2026-08-20", 35)
          ]
        },
        {
          name: "مورد ضخم",
          customerGuid: SUP,
          truncated: false,
          invoices: [
            invoice("2026-07-10", 20000),
            invoice("2026-07-20", 20000),
            invoice("2026-08-10", 20000),
            invoice("2026-08-20", 20000)
          ]
        }
      ]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 2 },
      items: [mkB("زبون تراجع حقيقي", CUST, false), mkB("مورد ضخم", SUP, true)]
    },
    movementsReport: null,
    creditLimits: [],
    now: NOW
  });
  const declined = r34.customers.find((row) => row.customerName === "زبون تراجع حقيقي");
  assert.ok(declined, "test 34: الزبون المتراجع يجب أن يظهر");
  assert.equal(declined.purchaseTrend.percent, -30, "test 34: 100 ← 70 يجب أن تبقى -30%");
  assert.ok(declined.flags.includes("declining"), "test 34: وسيط المورد لا يجوز أن يرفع أرضية التراجع فيحجب الزبون");
}

// ---------------------------------------------------------------------------
// 35) Codex P1 — زبون ليرة بمبلغ ضخم لا يأخذ مقعد VIP من عيّنة الدولار
// ---------------------------------------------------------------------------
{
  function guidFor(n) {
    return `611e8ef6-3563-48a3-b65b-${String(n).padStart(12, "0")}`;
  }
  function party(name, guid, invoices) {
    return {
      invoices: { name, customerGuid: guid, truncated: false, invoices },
      balance: {
        key: engine.normalizeName(name),
        name,
        balance: 0,
        creditLimit: 0,
        remainingLimit: 0,
        status: "clear",
        customerGuid: guid,
        customerAccountGuid: guid,
        isSupplier: false,
        recentPayments: [],
        recentMovements: []
      }
    };
  }
  const usdInvoices = [invoice("2026-07-20", 100, { currency: "USD", currencyVal: 1 }), invoice("2026-08-20", 100, { currency: "USD", currencyVal: 1 })];
  const sypInvoices = [
    invoice("2026-07-06", 2000000, { currency: "SYP", currencyVal: 1 }),
    invoice("2026-07-20", 2000000, { currency: "SYP", currencyVal: 1 }),
    invoice("2026-08-10", 2000000, { currency: "SYP", currencyVal: 1 }),
    invoice("2026-08-28", 2000000, { currency: "SYP", currencyVal: 1 })
  ];
  const parties = [
    party("زبون دولار أ", guidFor(1), usdInvoices),
    party("زبون دولار ب", guidFor(2), usdInvoices),
    party("زبون دولار ج", guidFor(3), usdInvoices),
    party("زبون دولار د", guidFor(4), usdInvoices),
    party("زبون دولار هـ", guidFor(5), usdInvoices),
    party("زبون ليرة ضخم", guidFor(6), sypInvoices)
  ];
  const r35 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: parties.length, bills: 0, syncedAt: REFERENCE_ISO },
      items: parties.map((entry) => entry.invoices)
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: parties.length },
      items: parties.map((entry) => entry.balance)
    },
    movementsReport: null,
    creditLimits: [],
    now: NOW
  });
  const sypRow = r35.customers.find((row) => row.customerName === "زبون ليرة ضخم");
  const usdVip = r35.customers.filter((row) => row.currency === "USD" && row.flags.includes("vip"));
  assert.ok(sypRow, "test 35: زبون الليرة يجب أن يظهر");
  assert.ok(!sypRow.flags.includes("vip"), "test 35: مبلغ ليرة لا يجوز أن يأخذ مقعد VIP من عيّنة الدولار");
  assert.ok(sypRow.flags.includes("vip_ranking_unreliable"), "test 35: زبون ليرة وحيد ⇒ ترتيب غير موثوق داخل عملته");
  assert.equal(r35.dataAvailability.vipRankingReliable, true, "test 35: خمسة زبائن دولار تكفي لترتيب موثوق");
  assert.equal(usdVip.length, 1, "test 35: أعلى 20% من خمسة زبائن دولار = مقعد واحد");
}

// ---------------------------------------------------------------------------
// 36) Codex P1 — وسيط ليرة لا يرفع أرضية التراجع فيحجب تراجع دولار
// ---------------------------------------------------------------------------
{
  const USD = "611e8ef6-3563-48a3-b65b-000000000031";
  const SYP_A = "611e8ef6-3563-48a3-b65b-000000000032";
  const SYP_B = "611e8ef6-3563-48a3-b65b-000000000033";
  const mkB = (name, guid) => ({
    key: engine.normalizeName(name),
    name,
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
  const r36 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 3, bills: 0, syncedAt: REFERENCE_ISO },
      items: [
        {
          name: "زبون دولار متراجع",
          customerGuid: USD,
          truncated: false,
          invoices: [
            invoice("2026-07-10", 50, { currency: "USD", currencyVal: 1 }),
            invoice("2026-07-20", 50, { currency: "USD", currencyVal: 1 }),
            invoice("2026-08-10", 35, { currency: "USD", currencyVal: 1 }),
            invoice("2026-08-20", 35, { currency: "USD", currencyVal: 1 })
          ]
        },
        {
          name: "زبون ليرة أ",
          customerGuid: SYP_A,
          truncated: false,
          invoices: [
            invoice("2026-07-10", 2000000, { currency: "SYP", currencyVal: 1 }),
            invoice("2026-07-20", 2000000, { currency: "SYP", currencyVal: 1 }),
            invoice("2026-08-10", 2000000, { currency: "SYP", currencyVal: 1 }),
            invoice("2026-08-20", 2000000, { currency: "SYP", currencyVal: 1 })
          ]
        },
        {
          name: "زبون ليرة ب",
          customerGuid: SYP_B,
          truncated: false,
          invoices: [
            invoice("2026-07-10", 2000000, { currency: "SYP", currencyVal: 1 }),
            invoice("2026-07-20", 2000000, { currency: "SYP", currencyVal: 1 }),
            invoice("2026-08-10", 2000000, { currency: "SYP", currencyVal: 1 }),
            invoice("2026-08-20", 2000000, { currency: "SYP", currencyVal: 1 })
          ]
        }
      ]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 3 },
      items: [mkB("زبون دولار متراجع", USD), mkB("زبون ليرة أ", SYP_A), mkB("زبون ليرة ب", SYP_B)]
    },
    movementsReport: null,
    creditLimits: [],
    now: NOW
  });
  const declinedUsd = r36.customers.find((row) => row.customerName === "زبون دولار متراجع");
  assert.ok(declinedUsd, "test 36: الزبون الدولاري يجب أن يظهر");
  assert.equal(declinedUsd.purchaseTrend.percent, -30, "test 36: 100 ← 70 يجب أن تبقى -30%");
  assert.ok(declinedUsd.flags.includes("declining"), "test 36: وسيط الليرة لا يجوز أن يحجب تراجع الدولار");
}

// ---------------------------------------------------------------------------
// 37) Codex P1 — مسار ذكاء الزبائن يتجاوز baseRender() فيجب أن يربط خروج الغلاف
// ---------------------------------------------------------------------------
{
  const viewSrc = readFileSync(new URL("../src/customer-intelligence-view.js", import.meta.url), "utf8");
  const bindBlock = viewSrc.match(/function bind\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(bindBlock, "test 37: تعذّر استخراج bind() من واجهة ذكاء الزبائن");
  assert.ok(
    /data-action=['"]logout['"]/.test(bindBlock[1]) && /\blogout\b/.test(bindBlock[1]),
    "test 37: bind() يجب أن يربط [data-action='logout'] بدالة logout لأن الشاشة تتجاوز baseRender()"
  );
  for (const action of ["toggle-theme", "retry-startup", "install"]) {
    assert.ok(
      bindBlock[1].includes(`data-action='${action}'`) || bindBlock[1].includes(`data-action="${action}"`),
      `test 37: bind() يجب أن يربط زر الغلاف ${action}`
    );
  }
}

// ---------------------------------------------------------------------------
// 38) Codex P1 — قيم الأمين بالدولار تُحوَّل بـCurrencyVal قبل وسمها ليرة
// ---------------------------------------------------------------------------
{
  const GUID = "611e8ef6-3563-48a3-b65b-000000000038";
  const r38 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 1, syncedAt: REFERENCE_ISO },
      items: [{
        name: "زبون فاتورة ليرة",
        customerGuid: GUID,
        truncated: false,
        invoices: [invoice("2026-08-20", 100, {
          currency: "SYP",
          currencyVal: 0.01,
          discount: 10,
          payment: 5,
          lines: [line("صنف ليرة", 1, 100)]
        })]
      }]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
      items: [{
        key: engine.normalizeName("زبون فاتورة ليرة"),
        name: "زبون فاتورة ليرة",
        balance: 0,
        creditLimit: 0,
        remainingLimit: 0,
        status: "clear",
        customerGuid: GUID,
        customerAccountGuid: GUID,
        isSupplier: false,
        recentPayments: [],
        recentMovements: []
      }]
    },
    movementsReport: null,
    creditLimits: [],
    now: NOW
  });
  const row38 = r38.customers.find((row) => row.customerName === "زبون فاتورة ليرة");
  assert.ok(row38, "test 38: زبون فاتورة الليرة يجب أن يظهر");
  assert.equal(row38.currency, "SYP", "test 38: بعد التحويل تُوسم الفاتورة بالليرة");
  assert.equal(row38.netSales30d, 9000, "test 38: (100−10)÷0.01 = 9000 ل.س لا 90 دولاراً بوسم ليرة");
  assert.equal(r38.summary.netSales30d, 0, "test 38: المبلغ المحوَّل لا يدخل إجمالي الدولار");
}

// ---------------------------------------------------------------------------
// 39) Codex P1 — وسم ليرة بلا CurrencyVal يبقى عملة أساس لأن الأرقام دولار
// ---------------------------------------------------------------------------
{
  const GUID = "611e8ef6-3563-48a3-b65b-000000000039";
  const r39 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: 1, syncedAt: REFERENCE_ISO },
      items: [{
        name: "زبون ليرة بلا معدّل",
        customerGuid: GUID,
        truncated: false,
        invoices: [invoice("2026-08-20", 80, { currency: "SYP" })]
      }]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
      items: [{
        key: engine.normalizeName("زبون ليرة بلا معدّل"),
        name: "زبون ليرة بلا معدّل",
        balance: 0,
        creditLimit: 0,
        remainingLimit: 0,
        status: "clear",
        customerGuid: GUID,
        customerAccountGuid: GUID,
        isSupplier: false,
        recentPayments: [],
        recentMovements: []
      }]
    },
    movementsReport: null,
    creditLimits: [],
    now: NOW
  });
  const row39 = r39.customers.find((row) => row.customerName === "زبون ليرة بلا معدّل");
  assert.ok(row39, "test 39: الزبون يجب أن يظهر");
  assert.equal(row39.currency, "USD", "test 39: بلا معدّل لا تُوسم الأرقام الدولارية ليرة");
  assert.equal(row39.netSales30d, 80, "test 39: المبلغ يبقى كما خُزِّن في الأساس");
  assert.equal(r39.summary.netSales30d, 80, "test 39: يدخل إجمالي الدولار لأنه أصلاً دولار");
}

// ---------------------------------------------------------------------------
// 40) Codex P1 — غياب صف الرصيد ليس صفراً ولا يُدخل الذمم ولا يُعدّ ائتماناً طبيعياً
// ---------------------------------------------------------------------------
{
  const KNOWN = "611e8ef6-3563-48a3-b65b-000000000040";
  const MISSING = "611e8ef6-3563-48a3-b65b-000000000041";
  const r40 = engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 2, bills: 2, syncedAt: REFERENCE_ISO },
      items: [
        {
          name: "زبون رصيده معروف",
          customerGuid: KNOWN,
          truncated: false,
          invoices: [invoice("2026-08-20", 40, { currency: "USD", currencyVal: 1 })]
        },
        {
          name: "زبون بلا صف رصيد",
          customerGuid: MISSING,
          truncated: false,
          invoices: [invoice("2026-08-20", 70, { currency: "USD", currencyVal: 1 })]
        }
      ]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
      items: [{
        key: engine.normalizeName("زبون رصيده معروف"),
        name: "زبون رصيده معروف",
        balance: 250,
        creditLimit: 1000,
        remainingLimit: 750,
        status: "clear",
        customerGuid: KNOWN,
        customerAccountGuid: KNOWN,
        isSupplier: false,
        recentPayments: [],
        recentMovements: []
      }]
    },
    movementsReport: null,
    creditLimits: [{
      customerKey: engine.normalizeName("زبون بلا صف رصيد"),
      customerName: "زبون بلا صف رصيد",
      customerGuid: MISSING,
      credit_limit: 5000
    }],
    now: NOW
  });
  const known = r40.customers.find((row) => row.customerName === "زبون رصيده معروف");
  const missing = r40.customers.find((row) => row.customerName === "زبون بلا صف رصيد");
  assert.ok(known && missing, "test 40: الزبونان يجب أن يظهرا");
  assert.equal(known.currentBalance, 250, "test 40: الرصيد المصرَّح يبقى 250");
  assert.equal(known.creditStatus, "normal");
  assert.equal(missing.currentBalance, null, "test 40: غياب صف الرصيد = null لا صفر");
  assert.equal(missing.creditStatus, "unknown_balance", "test 40: الحالة unknown_balance لا normal");
  assert.ok(missing.flags.includes("credit_balance_unknown"));
  assert.ok(!missing.flags.includes("over_credit_limit"), "test 40: حد معتمد بلا رصيد لا يُنتج تجاوزاً");
  assert.equal(r40.summary.totalReceivables, 250, "test 40: الذمم من الأرصدة المعروفة فقط");
  assert.equal(r40.summary.unknownCreditBalanceCount, 1);
}

// ---------------------------------------------------------------------------
// 41–46) أهم الأصناف بوحدة إدخال السطر (bi000.Unity ⇐ inputUnit).
//
// العطل الحي: `lineTotal` في الحمولة `derived` = Qty(كروز) × Price(سعر وحدة الإدخال)
// بلا قسمة على المعامل، فسطر الكرتونة (معامل 50) نفخ قيمة الصنف 50 ضعفاً وظهرت
// أصناف بمئات الآلاف لزبون مجموع فواتيره عشرات الآلاف. القيمة الصحيحة
// Price × Qty ÷ factor، وهي تطابق إجمالي الفاتورة (مثبت 658/658 على الأمين الحي).
// ---------------------------------------------------------------------------
{
  const UNITS = { unit1: "كروز", unit2: "كرتونة", unit2Fact: 50, unit3: "طرد", unit3Fact: 500 };
  // سطر كما يرفعه push-customer-invoices.ps1 اليوم: lineTotal مشتق بلا قسمة.
  const amLine = (material, qty, price, inputUnit, extra = {}) => ({
    material, itemGuid: extra.itemGuid ?? "", qty, qtyUnits: qty / UNITS.unit2Fact, price,
    lineTotal: qty * price, lineTotalSource: "derived", inputUnit, ...UNITS, ...extra
  });
  const bill = (date, lines, extra = {}) => {
    const total = extra.total ?? lines.reduce((sum, l) => {
      const f = l.inputUnit === 2 ? l.unit2Fact : l.inputUnit === 3 ? l.unit3Fact : 1;
      return sum + (l.price * l.qty) / f;
    }, 0);
    return { date, number: extra.number ?? date, guid: extra.guid ?? `u-${date}-${total}`, total, discount: extra.discount ?? 0,
      payment: 0, isReturn: extra.isReturn ?? false, currency: extra.currency ?? "USD", currencyVal: extra.currencyVal ?? 1, lines };
  };
  const buildOne = (name, guid, invoices) => engine.build({
    invoicesReport: {
      source: "ameen_customer_invoices",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: 1, bills: invoices.length, syncedAt: REFERENCE_ISO, payloadVersion: 2 },
      items: [{ name, customerGuid: guid, truncated: false, invoices }]
    },
    balancesReport: {
      source: "ameen_customer_balances",
      created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: 1 },
      items: [{ name, key: engine.normalizeName(name), customerGuid: guid, balance: 0, isSupplier: false, recentPayments: [], recentMovements: [] }]
    },
    movementsReport: null, creditLimits: [], now: NOW
  }).customers.find((row) => row.customerName === name);
  const itemOf = (row, name) => row.topItems.find((item) => item.itemName === name);

  // 41) سطر بالكرتونة: كرتونتان بسعر 250 = 500، لا 100 كروز × 250 = 25,000.
  const r41 = buildOne("زبون كرتونة", "00000000-0000-4000-8000-000000000041", [
    bill("2026-08-20", [amLine("دخان كرتونة", 100, 250, 2)])
  ]);
  const i41 = itemOf(r41, "دخان كرتونة");
  assert.equal(i41.netValue, 500, "test 41: قيمة سطر الكرتونة = السعر × الكمية ÷ 50");
  assert.notEqual(i41.netValue, 25000, "test 41: القيمة الخام المضخّمة ممنوعة");
  assert.equal(i41.valueVerified, true);
  assert.equal(i41.netQty, 100, "test 41: الكمية تبقى بالوحدة الأولى (كروز)");
  assert.equal(i41.netQtyUnit2, 2, "test 41: وما يعادلها بالكرتونة");
  assert.equal(i41.unit1, "كروز");
  assert.equal(i41.unit2, "كرتونة");

  // 42) فاتورة تخلط الوحدات الثلاث — مجموع الأصناف يطابق إجمالي الفاتورة.
  const lines42 = [
    amLine("صنف كرتونة", 150, 240, 2),   // 3 كراتين × 240 = 720
    amLine("صنف كروز", 30, 5.2, 1),      // 30 × 5.2 = 156
    amLine("صنف طرد", 1000, 2300, 3)     // 2 طرد × 2300 = 4600
  ];
  const r42 = buildOne("زبون وحدات مختلطة", "00000000-0000-4000-8000-000000000042", [bill("2026-08-21", lines42)]);
  assert.equal(itemOf(r42, "صنف كرتونة").netValue, 720);
  assert.equal(itemOf(r42, "صنف كروز").netValue, 156);
  assert.equal(itemOf(r42, "صنف طرد").netValue, 4600);
  const sum42 = r42.topItems.reduce((sum, item) => sum + item.netValue, 0);
  assert.equal(Math.round(sum42 * 1000) / 1000, 5476, "test 42: Σ أهم الأصناف = إجمالي الفاتورة (مصالحة)");
  assert.equal(Math.round(sum42 * 1000) / 1000, r42.netSales30d, "test 42: Σ الأصناف = صافي مبيعات الفترة بلا حسم");
  assert.equal(r42.topItems[0].itemName, "صنف طرد", "test 42: الترتيب بالقيمة الحقيقية لا الخام");

  // 43) مرتجع بالكرتونة يُطرح بنفس القاعدة، والمرتجع لا يُحسب مبيعاً موجباً.
  const r43 = buildOne("زبون مرتجع كرتونة", "00000000-0000-4000-8000-000000000043", [
    bill("2026-08-10", [amLine("دخان مرتجع", 100, 250, 2)]),
    bill("2026-08-12", [amLine("دخان مرتجع", 50, 250, 2)], { isReturn: true })
  ]);
  const i43 = itemOf(r43, "دخان مرتجع");
  assert.equal(i43.netValue, 250, "test 43: 500 − 250");
  assert.equal(i43.netQty, 50);
  assert.equal(i43.netQtyUnit2, 1);

  // 44) فاتورة ليرة: السعر بعملة الأساس، القسمة على المعامل ثم ÷ CurrencyVal مرة واحدة.
  const r44 = buildOne("زبون ليرة كرتونة", "00000000-0000-4000-8000-000000000044", [
    bill("2026-08-15", [amLine("دخان ليرة", 100, 250, 2)], { currency: "SYP", currencyVal: 1 / 14000 })
  ]);
  const i44 = itemOf(r44, "دخان ليرة");
  assert.equal(r44.currency, "SYP");
  assert.equal(i44.netValue, 7000000, "test 44: 500 أساس ÷ (1/14000) = 7,000,000 ل.س، بلا ضرب مزدوج");
  assert.equal(r44.netSales30d, 7000000, "test 44: الصنف والفاتورة بنفس العملة");

  // 45) سطر مشتق بلا وحدة إدخال (حمولة أقدم): لا قيمة مضخّمة تُعرض كحقيقة.
  const legacy = amLine("صنف بلا وحدة", 100, 250, undefined);
  delete legacy.inputUnit;
  const r45 = buildOne("زبون حمولة قديمة", "00000000-0000-4000-8000-000000000045", [
    bill("2026-08-18", [legacy, amLine("صنف مؤكد", 10, 5, 1)], { total: 550 })
  ]);
  const i45 = itemOf(r45, "صنف بلا وحدة");
  assert.equal(i45.netValue, null, "test 45: derived بلا inputUnit ⇒ قيمة null");
  assert.equal(i45.valueVerified, false);
  assert.equal(r45.topItems[0].itemName, "صنف مؤكد", "test 45: غير المؤكد لا يتقدّم على المؤكد");

  // 46) عمود إجمالي حقيقي من الأمين (lineTotalSource = "ameen") بلا inputUnit يُعتمد كما هو.
  const stored = { material: "صنف إجمالي حقيقي", qty: 100, price: 250, lineTotal: 500, lineTotalSource: "ameen" };
  const r46 = buildOne("زبون إجمالي حقيقي", "00000000-0000-4000-8000-000000000046", [bill("2026-08-19", [stored], { total: 500 })]);
  assert.equal(itemOf(r46, "صنف إجمالي حقيقي").netValue, 500, "test 46: الإجمالي الحقيقي يُعتمد");
}

// ---------------------------------------------------------------------------
// 47–72) حد الائتمان الآلي (STEP 1): الحد المحسوب من دفتر حساب الزبون.
// كل الأرقام تركيبية. التاريخ المرجعي = REFERENCE_ISO (2026-09-02)، وd(n) = قبله بـn يوماً.
// ---------------------------------------------------------------------------
{
  const REF_DAY = Date.UTC(2026, 8, 2);
  const d = (n) => new Date(REF_DAY - n * 86400000).toISOString().slice(0, 10);
  const debit = (n, amount) => ({ date: d(n), debit: amount, credit: 0, notes: "", billGuid: "" });
  const pay = (n, amount) => ({ date: d(n), debit: 0, credit: amount, notes: "", billGuid: "" });
  const opening = (amount) => ({ date: d(62), debit: amount, credit: 0, notes: "القيد الافتتاحي", billGuid: "" });
  const gid = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
  // فواتير كل `every` يوماً من اليوم `from` حتى `to`، وكل واحدة تُسدَّد بعد `lag` يوماً.
  const regular = ({ from, to = 1, every, amount, lag }) => {
    const rows = [];
    for (let n = from; n >= to; n -= every) {
      rows.push(debit(n, amount));
      if (lag !== null && n - lag >= 0) rows.push(pay(n - lag, amount));
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  };
  const ledgerBalance = (rows) => rows.reduce((sum, row) => sum + row.debit - row.credit, 0);

  const accounts = [];
  const account = (id, name, movements, extra = {}) => {
    accounts.push({ guid: gid(id), name, movements, balance: extra.balance ?? ledgerBalance(movements), ...extra });
    return gid(id);
  };

  const G_STEADY = account(1, "ائتمان منتظم", regular({ from: 59, every: 6, amount: 600, lag: 6 }));
  const G_SLOW = account(2, "ائتمان بطيء يدفع", regular({ from: 59, every: 5, amount: 400, lag: 40 }));
  const G_DELINQ = account(3, "ائتمان متعثّر", [debit(58, 1500), debit(50, 1500), pay(49, 200), debit(10, 300)]);
  const G_IDLE = account(4, "ائتمان خامل بلا دين", [opening(0), pay(70, 0.01)]);
  const G_RESIDUE = account(5, "ائتمان خامل ببقية صغيرة", [opening(20)]);
  const G_PREPAID = account(6, "ائتمان دفع مسبق", [pay(40, 1000), debit(38, 500), pay(20, 800), debit(18, 600), debit(5, 400)]);
  const G_NEW = account(7, "ائتمان جديد", [debit(12, 800), pay(10, 800), debit(3, 1000)]);
  const G_LARGE = account(8, "ائتمان فاتورة شاذة", [
    ...regular({ from: 56, every: 8, amount: 300, lag: 4 }),
    debit(20, 6000), pay(16, 6000)
  ]);
  const G_GROWWEAK = account(9, "ائتمان نمو بتحصيل ضعيف", [
    ...regular({ from: 58, to: 31, every: 7, amount: 200, lag: 5 }),
    ...regular({ from: 28, every: 4, amount: 900, lag: null }),
    pay(20, 900), pay(12, 900), pay(4, 900)
  ]);
  const G_GROWHIGHBAL = account(10, "ائتمان نمو برصيد متراكم", [
    ...regular({ from: 58, to: 31, every: 7, amount: 300, lag: 3 }),
    ...regular({ from: 24, to: 9, every: 5, amount: 600, lag: 3 }),
    debit(1, 2000)
  ]);
  const G_SYP = account(11, "ائتمان حساب ليرة", regular({ from: 59, every: 6, amount: 700, lag: 5 }), {
    balance: 740.25, accountCurrencyIsBase: false, accountCurrency: "ل.س.", balanceAccountCcy: 9800000
  });
  const G_TRUNC = account(12, "ائتمان دفتر مقتطع", regular({ from: 59, every: 6, amount: 600, lag: 6 }), { truncated: true, creditLimit: 777 });
  const G_LEGACY = account(13, "ائتمان حد قديم", regular({ from: 59, every: 6, amount: 600, lag: 6 }));
  // حساب سحبه في الدفتر بلا فواتير مبيع: شذوذ يحتاج مراجعة، لا تصنيف «ليس زبوناً».
  const G_NOTCUST = account(14, "حساب داخلي بلا فواتير", regular({ from: 58, every: 7, amount: 900, lag: 50 }), { noInvoices: true });
  // زبون حقيقي بفرق صغير غير مفوتر (دون حد الأهمية): يبقى زبوناً.
  const G_SMALLGAP = account(15, "ائتمان بفرق تسوية صغير", [...regular({ from: 59, every: 6, amount: 600, lag: 6 }), debit(30, 40), pay(28, 40)],
    { uninvoiced: new Set([d(30)]) });
  // خامل مدين بدين قديم لم يُدفع منه شيء: متعثّر لا غير نشط.
  const G_DORMANT = account(16, "ائتمان خامل مدين", [debit(80, 3000), pay(75, 100)]);

  // فواتير المبيع = سحب الدفتر في النافذة (حساب الليرة بعملته)، إلا للحسابات غير الزبائن.
  const salesInvoicesOf = (a) => a.movements
    .filter((m) => m.debit > 0 && !m.notes && !(a.uninvoiced?.has(m.date)) && m.date >= FROM_DATE)
    .map((m, index) => invoice(m.date, m.debit, {
      guid: `bill-${a.guid}-${index}`,
      ...(a.accountCurrencyIsBase === false ? { currency: "SYP", currencyVal: 1 / 14000 } : {})
    }));
  const invoicesReportFor = (list, fromDate = FROM_DATE) => ({
    source: "ameen_customer_invoices", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
    summary: { periodDays: 60, fromDate, customers: list.length, syncedAt: REFERENCE_ISO },
    items: list.filter((a) => !a.noInvoices).map((a) => ({ name: a.name, customerGuid: a.guid, truncated: false, invoices: salesInvoicesOf(a) }))
      .filter((group) => group.invoices.length > 0)
  });

  const reports = {
    invoicesReport: invoicesReportFor(accounts),
    balancesReport: {
      source: "ameen_customer_balances", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: accounts.length },
      items: accounts.map((a) => ({
        key: engine.normalizeName(a.name), name: a.name, balance: a.balance, creditLimit: a.creditLimit ?? 0,
        remainingLimit: 0, status: "clear", customerGuid: a.guid, customerAccountGuid: a.guid, isSupplier: false,
        recentPayments: [], recentMovements: [],
        accountCurrencyIsBase: a.accountCurrencyIsBase ?? true, accountCurrency: a.accountCurrency ?? "$",
        balanceAccountCcy: a.balanceAccountCcy ?? a.balance
      }))
    },
    movementsReport: {
      source: "ameen_customer_movements", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { syncedAt: REFERENCE_ISO, periodDays: 92 },
      items: accounts.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: a.truncated === true, movements: a.movements }))
    },
    creditLimits: [{ customerGuid: G_LEGACY, customerKey: "legacy", credit_limit: 99999 }],
    now: NOW
  };
  const rc = engine.build(reports);
  const row = (guid) => {
    const found = rc.customers.find((entry) => entry.customerGuid === guid);
    assert.ok(found, `سجل الائتمان مفقود: ${guid}`);
    return found;
  };
  const stepOf = (value, currency) => (currency === "USD"
    ? (value < 1000 ? 100 : value < 10000 ? 250 : 500)
    : (value < 10000000 ? 100000 : value < 100000000 ? 500000 : 1000000));

  // 47) دورة السداد من تسوية FIFO: كل فاتورة تُسدَّد بعد 6 أيام ⇒ الدورة 6 أيام.
  const steady = row(G_STEADY);
  assert.equal(steady.creditLimitSource, "auto", "test 47: الحد آلي");
  assert.equal(steady.autoCredit.status, "normal");
  assert.equal(steady.autoCredit.cycleBasis, "fifo_median");
  assert.equal(steady.autoCredit.cycleRawDays, 6, "test 47: وسيط أيام السداد = 6");
  assert.ok(steady.creditLimit > 0, "test 47: زبون منتظم يحصل على حد");
  assert.equal(steady.creditLimit % stepOf(steady.creditLimit, "USD"), 0, "test 47: تقريب تجاري");
  assert.ok(steady.autoCredit.coverage >= 0.9 && steady.autoCredit.punctuality === 1 && steady.autoCredit.risk === 1, "test 47: منتظم = انضباط كامل بلا مخاطر رصيد");
  assert.equal(steady.creditLimit, engine.commercialRound(steady.autoCredit.limitBase, "USD"), "test 47: التقريب للأسفل");

  // 48) الدورة محصورة بين P10 وP90 للمحفظة الحية، والبطيء الذي يدفع باستمرار ليس متعثراً.
  const cycle = rc.dataAvailability.creditCycle;
  const slow = row(G_SLOW);
  assert.equal(cycle.basis, "portfolio");
  assert.ok(cycle.floorDays >= 1 && cycle.floorDays <= cycle.medianDays && cycle.medianDays <= cycle.capDays, "test 48: P10 ≤ الوسيط ≤ P90");
  assert.ok(slow.autoCredit.cycleRawDays > cycle.capDays, "test 48: وسيط أيام السداد الخام فوق السقف");
  assert.equal(slow.autoCredit.cycleDays, cycle.capDays, "test 48: الدورة = سقف المحفظة (P90)");
  assert.notEqual(slow.creditStatus, "delinquent", "test 48: بطيء يدفع ليس متعثراً");
  assert.ok(slow.autoCredit.trend <= 1 && slow.creditLimit < slow.autoCredit.expectedExposure,
    "test 48: التحصيل الضعيف لا يرفع الحد فوق التعرض المعتاد");

  // 49) متعثّر: رصيد قائم + دين أقدم من دورته بهامش واضح + دفعات المدة لا تغطيه.
  const delinquent = row(G_DELINQ);
  assert.equal(delinquent.creditStatus, "delinquent", "test 49: متعثّر");
  assert.equal(delinquent.creditLimit, 0, "test 49: الحد صفر");
  assert.ok(delinquent.flags.includes("credit_delinquent"));
  assert.equal(delinquent.riskScore, 100);
  assert.ok(delinquent.autoCredit.overdueAmount >= 2500, "test 49: المتأخر يُقاس من الفواتير المفتوحة");

  // 50) خامل بلا دين = غير نشط، لا متعثّر.
  const idle = row(G_IDLE);
  assert.equal(idle.creditStatus, "inactive_no_limit", "test 50: غير نشط");
  assert.equal(idle.creditLimit, 0);
  assert.ok(idle.flags.includes("credit_inactive") && !idle.flags.includes("credit_delinquent"), "test 50: لا وسم تعثّر");

  // 51) خامل ببقية كسور صغيرة (دون حد الأهمية) = غير نشط، لا متعثّر.
  const residue = row(G_RESIDUE);
  assert.equal(residue.creditStatus, "inactive_no_limit", "test 51: بقية صغيرة ليست تعثّراً");
  assert.ok(!residue.flags.includes("credit_delinquent"));

  // 52) دفع مسبق ورصيد دائن: لا تعرّض ولا حد.
  const prepaid = row(G_PREPAID);
  assert.equal(prepaid.autoCredit.status, "prepaid", "test 52: دفع مسبق");
  assert.equal(prepaid.creditLimit, null);
  assert.equal(prepaid.creditStatus, "prepaid");

  // 53) زبون جديد/بيانات قليلة: حد آلي محافظ ≤ نصف سحبه و≤ ضعف وسيط فاتورته، مع وسم واضح.
  const fresh = row(G_NEW);
  assert.equal(fresh.autoCredit.status, "low_data", "test 53: بيانات قليلة");
  assert.ok(fresh.flags.includes("credit_low_data"));
  assert.equal(fresh.creditLimitSource, "auto", "test 53: يبقى آلياً");
  assert.ok(fresh.creditLimit <= Math.min(0.5 * 1800, 2 * 900), "test 53: السقف المحافظ");

  // 54) حارس الفاتورة الشاذة: فاتورة 6000 بين فواتير 300 لا تنفخ سرعة السحب.
  const large = row(G_LARGE);
  assert.ok(large.autoCredit.notes.some((note) => note.includes("الفاتورة الشاذة")), "test 54: الحارس فُعّل");
  const naiveRecent = 6000 + 300 * 3;
  assert.ok(large.autoCredit.velocity < (0.6 * naiveRecent + 0.4 * 300 * 4) / 30, "test 54: السرعة أقل من الحساب الساذج");

  // 55) نمو مع تحصيل ضعيف: الاتجاه لا يرفع الحد، وسقف التغطية يطبَّق.
  const growWeak = row(G_GROWWEAK);
  assert.ok(growWeak.autoCredit.coverage < 0.9, "test 55: التحصيل أقل من 90%");
  assert.equal(growWeak.autoCredit.trend, 1, "test 55: لا مكافأة نمو");
  assert.ok(growWeak.creditLimit <= growWeak.autoCredit.expectedExposure * growWeak.autoCredit.coverage * growWeak.autoCredit.quality + 1,
    "test 55: الحد ≤ التعرض × التغطية × الجودة");

  // 56) نمو مع رصيد متراكم غير معتاد: الرصيد يمنع مكافأة النمو ويخفض الحد.
  const growBal = row(G_GROWHIGHBAL);
  assert.ok(growBal.autoCredit.risk < 1, "test 56: الرصيد عامل مخاطر داخل جودة السداد");
  assert.equal(growBal.autoCredit.trend, 1, "test 56: الرصيد المرتفع يمنع مكافأة النمو");
  assert.ok(growBal.autoCredit.quality < steady.autoCredit.quality, "test 56: الجودة أقل من المنتظم");

  // 57) حساب ليرة: الحساب داخلياً بالأساس، والعرض بعملة الحساب بلا خلط.
  const syp = row(G_SYP);
  assert.equal(syp.creditCurrency, "SYP", "test 57: حد حساب الليرة بالليرة");
  assert.equal(syp.balanceDisplay, 9800000, "test 57: الرصيد برصيد الحساب بعملته لا بالدولار المشوّه");
  assert.equal(syp.creditLimitDisplay % stepOf(syp.creditLimitDisplay, "SYP"), 0, "test 57: تقريب بالليرة");
  assert.equal(syp.creditLimit, Math.round(syp.creditLimitDisplay / 14000 * 1000) / 1000, "test 57: المكافئ بالأساس = الحد × المعدّل");
  assert.equal(syp.creditUsagePercent, Math.round(9800000 / syp.creditLimitDisplay * 10000) / 100, "test 57: الاستخدام بعملة الحساب");

  // 58) دفتر مقتطع: لا حد آلي على بيانات ناقصة؛ حد الأمين احتياط فقط.
  const trunc = row(G_TRUNC);
  assert.equal(trunc.autoCredit.status, "unavailable", "test 58: دفتر مقتطع = غير متاح");
  assert.equal(trunc.creditLimitSource, "ameen");
  assert.equal(trunc.creditLimit, 777);

  // 59) الحد القديم في customer_credit_limits مرجع فقط ولا يغيّر الحد المحسوب.
  const legacyRow = row(G_LEGACY);
  assert.equal(legacyRow.legacyCreditLimit, 99999);
  assert.equal(legacyRow.creditLimit, steady.creditLimit, "test 59: نفس الدفتر = نفس الحد مهما كان الحد القديم");

  // 60) التقريب التجاري للأسفل حسب الحجم والعملة — بلا كسور ولا رفع.
  assert.equal(engine.commercialRound(0, "USD"), 0);
  assert.equal(engine.commercialRound(40, "USD"), 0);
  assert.equal(engine.commercialRound(690, "USD"), 600);
  assert.equal(engine.commercialRound(1120, "USD"), 1000);
  assert.equal(engine.commercialRound(12345, "USD"), 12000);
  assert.equal(engine.commercialRound(9960000, "SYP"), 9900000);
  assert.equal(engine.commercialRound(12345678, "SYP"), 12000000);
  assert.equal(engine.commercialRound(123456789, "SYP"), 123000000);

  // 61) عدم تطابق عام بين سحب الدفتر وفواتير المبيع: «يحتاج مراجعة» بلا حد آلي، لا «ليس زبوناً».
  const notCust = row(G_NOTCUST);
  assert.equal(notCust.autoCredit.status, "needs_review", "test 61: الشذوذ = يحتاج مراجعة");
  assert.equal(notCust.creditLimit, null, "test 61: لا حد آلي");
  assert.equal(notCust.creditLimitSource, "auto", "test 61: لا يُستبدل بحد الأمين");
  assert.equal(notCust.creditStatus, "needs_review");
  assert.ok(notCust.flags.includes("credit_needs_review") && !notCust.flags.includes("credit_not_customer"), "test 61: ليس «ليس زبون مبيعات»");
  assert.ok(notCust.autoCredit.notes[0].includes("يحتاج مراجعة"), "test 61: السبب ظاهر");

  // 62) الحساب المشكوك بحركته (يحتاج مراجعة) لا يلوّث عيّنة دورة المحفظة: حدودها كما لو لم يوجد.
  const withoutNotCust = accounts.filter((a) => a.guid !== G_NOTCUST);
  const rcWithout = engine.build({
    ...reports,
    invoicesReport: invoicesReportFor(withoutNotCust),
    balancesReport: { ...reports.balancesReport, items: reports.balancesReport.items.filter((item) => item.customerGuid !== G_NOTCUST) },
    movementsReport: { ...reports.movementsReport, items: reports.movementsReport.items.filter((item) => item.customerGuid !== G_NOTCUST) }
  });
  assert.deepEqual(rc.dataAvailability.creditCycle, rcWithout.dataAvailability.creditCycle, "test 62: حدود الدورة لا تتأثر بالحساب المشكوك");
  assert.equal(rcWithout.customers.find((c) => c.customerGuid === G_STEADY).creditLimit, steady.creditLimit);

  // 63) قائمتا المالك بالمعرّف لا بالاسم، ولو غطّت الفواتير السحب كاملاً:
  //     الاستبعاد الصريح (قناة داخلية، فروقات جرد، سلفة موظف) ⇒ «ليس زبون مبيعات»؛
  //     الحساب المختلط (مورد وزبون) ⇒ «يحتاج مراجعة» بلا حد آلي، لا «ليس زبوناً».
  const asOwnerListed = (guid, untyped = false) => engine.build({
    ...reports,
    untyped,
    invoicesReport: invoicesReportFor([{ ...accounts[0], guid, name: "اسم عادي" }]),
    balancesReport: { ...reports.balancesReport, items: [{ ...reports.balancesReport.items[0], customerGuid: guid, customerAccountGuid: guid, name: "اسم عادي", key: "اسم عادي" }] },
    movementsReport: { ...reports.movementsReport, items: [{ ...reports.movementsReport.items[0], customerGuid: guid, name: "اسم عادي" }] }
  }).customers.find((c) => c.customerGuid === guid);
  assert.equal(engine.CONFIG.autoCredit.excludedAccountGuids.length, 3, "test 63: ثلاثة حسابات مستبعدة صراحة");
  for (const ownerExcluded of engine.CONFIG.autoCredit.excludedAccountGuids) {
    const excluded = asOwnerListed(ownerExcluded);
    assert.equal(excluded.autoCredit.status, "non_customer", `test 63: قائمة المالك بالمعرّف ${ownerExcluded}`);
    assert.equal(excluded.creditLimit, null);
  }
  assert.ok(engine.CONFIG.autoCredit.excludedAccountGuids.includes("7a1f9a5a-00bc-445f-949a-e4ce8d306585"), "test 63: سلفة الموظف مستبعدة بالمعرّف");
  const mixedGuid = engine.CONFIG.autoCredit.reviewAccountGuids[0];
  const mixed = asOwnerListed(mixedGuid);
  assert.equal(mixed.autoCredit.status, "needs_review", "test 63: الحساب المختلط يحتاج مراجعة");
  assert.equal(mixed.creditLimit, null, "test 63: بلا حد آلي");
  assert.equal(mixed.creditStatus, "needs_review");
  assert.ok(!mixed.flags.includes("credit_not_customer"), "test 63: المختلط ليس «ليس زبون مبيعات»");
  assert.ok(mixed.autoCredit.notes[0].includes("مختلط"), "test 63: السبب ظاهر");
  // ‏… وحتى مع دفتر أو أرصدة غير حديثة: لا يظهر حد الأمين بديلاً لحساب في قائمتي المالك.
  const staleAt = new Date(NOW.getTime() - 3 * 3600000).toISOString();
  for (const [guid, status] of [[mixedGuid, "needs_review"], [engine.CONFIG.autoCredit.excludedAccountGuids[2], "non_customer"]]) {
    const staleOwner = engine.build({
      ...reports,
      invoicesReport: invoicesReportFor([{ ...accounts[0], guid, name: "اسم عادي" }]),
      balancesReport: { ...reports.balancesReport, created_at: staleAt, summary: { ...reports.balancesReport.summary, syncedAt: staleAt },
        items: [{ ...reports.balancesReport.items[0], customerGuid: guid, customerAccountGuid: guid, name: "اسم عادي", key: "اسم عادي", creditLimit: 5000 }] },
      movementsReport: { ...reports.movementsReport, created_at: staleAt, summary: { ...reports.movementsReport.summary, syncedAt: staleAt },
        items: [{ ...reports.movementsReport.items[0], customerGuid: guid, name: "اسم عادي" }] }
    }).customers.find((c) => c.customerGuid === guid);
    assert.equal(staleOwner.autoCredit.status, status, `test 63: قائمة المالك تسبق المصدر القديم (${status})`);
    assert.equal(staleOwner.creditLimit, null, "test 63: لا حد أمين بديلاً");
    assert.notEqual(staleOwner.creditLimitSource, "ameen");
  }

  // 64) فرق صغير غير مفوتر (دون حد الأهمية) لا يحوّل زبوناً حقيقياً إلى غير زبون،
  //     وتقرير فواتير لا يغطي النافذة لا يصنّف أحداً غير زبون (لا حكم بلا دليل).
  assert.ok(!["non_customer", "needs_review"].includes(row(G_SMALLGAP).autoCredit.status), "test 64: الفرق الصغير لا يشغّل المراجعة");
  const rcShort = engine.build({ ...reports, invoicesReport: invoicesReportFor(accounts, d(20)) });
  assert.ok(!rcShort.customers.some((c) => ["non_customer", "needs_review"].includes(c.autoCredit?.status)), "test 64: تغطية ناقصة = لا حكم سلوكي");

  // 65) خامل مدين بدين قديم لم يُسدَّد: متعثّر بحد صفر (لا «غير نشط»)؛ الخامل بلا دين غير نشط.
  const dormant = row(G_DORMANT);
  assert.equal(dormant.creditStatus, "delinquent", "test 65: الخامل المدين الذي لا يدفع متعثّر");
  assert.equal(dormant.creditLimit, 0);
  assert.equal(row(G_IDLE).creditStatus, "inactive_no_limit", "test 65: الخامل بلا دين ليس متعثّراً");

  // 67) دين أقدم من نافذة تقرير الحركات يصل openingBalance لا حركة: يدخل FIFO والتعثّر.
  //     زبون بسحب حديث قليل، وعليه دين قديم مرحَّل لم يُسدَّد منه شيء.
  const carriedRows = [debit(10, 200), debit(5, 200)];
  const carriedReports = (openingBalance) => ({
    ...reports,
    movementsReport: {
      ...reports.movementsReport,
      summary: { ...reports.movementsReport.summary, fromDate: d(60) },
      items: [{ customerGuid: G_STEADY, name: "ائتمان منتظم", truncated: false, openingBalance, movements: carriedRows }]
    }
  });
  const carried = engine.build(carriedReports(3000)).customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(carried.creditStatus, "delinquent", "test 67: الدين المرحَّل القديم غير المسدَّد = تعثّر");
  assert.ok(carried.autoCredit.oldestOpenDays > 60, "test 67: أقدم دين مفتوح هو المرحَّل");
  assert.ok(carried.autoCredit.overdueAmount >= 3000);
  const noCarry = engine.build(carriedReports(0)).customers.find((c) => c.customerGuid === G_STEADY);
  assert.notEqual(noCarry.creditStatus, "delinquent", "test 67: بلا رصيد مرحَّل لا تعثّر");

  // 68) دفتر حركات متوقف المزامنة: لا حد آلي ولا تعثّر من بيانات قديمة، ووسم المصدر غير الحديث.
  const staleIso = new Date(NOW.getTime() - 3 * 3600000).toISOString();
  const rcStale = engine.build({
    ...reports,
    movementsReport: { ...reports.movementsReport, created_at: staleIso, summary: { ...reports.movementsReport.summary, syncedAt: staleIso } }
  });
  const staleSteady = rcStale.customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(staleSteady.autoCredit.status, "unavailable", "test 68: دفتر قديم = غير متاح");
  assert.equal(staleSteady.creditLimit, null);
  assert.equal(rcStale.staleData, true, "test 68: تقادم الحركات وحدها يرفع التحذير العام");
  assert.equal(rcStale.sourcesFreshness.invoices.stale, false, "test 68: الفواتير حديثة");
  assert.equal(rcStale.sourcesFreshness.balances.stale, false, "test 68: الأرصدة حديثة");
  assert.equal(rcStale.sourcesFreshness.movements.stale, true);
  assert.ok(rcStale.customers.every((row) => row.flags.includes("stale_data")), "test 68: وسم المصدر غير الحديث على كل سجل");
  assert.ok(!rcStale.customers.some((c) => c.creditStatus === "delinquent"), "test 68: لا حكم تعثّر من دفتر قديم");

  const rcUnknown = engine.build({
    ...reports,
    movementsReport: { ...reports.movementsReport, created_at: undefined, summary: { ...reports.movementsReport.summary, syncedAt: undefined } }
  });
  const unknownSteady = rcUnknown.customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(unknownSteady.autoCredit.status, "unavailable", "test 68: بلا وقت مزامنة = غير متاح");
  assert.equal(rcUnknown.staleData, true, "test 68: وقت غير معروف يرفع التحذير العام");

  // 70) تقرير أرصدة متوقف المزامنة (والدفتر حديث): لا حد آلي من رصيد قديم.
  const rcStaleBal = engine.build({
    ...reports,
    balancesReport: { ...reports.balancesReport, created_at: staleIso, summary: { ...reports.balancesReport.summary, syncedAt: staleIso } }
  });
  assert.equal(rcStaleBal.sourcesFreshness.balances.stale, true);
  assert.equal(rcStaleBal.sourcesFreshness.movements.stale, false);
  const staleBalSteady = rcStaleBal.customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(staleBalSteady.autoCredit.status, "unavailable", "test 70: أرصدة قديمة = غير متاح");
  assert.ok(staleBalSteady.autoCredit.notes[0].includes("تقرير الأرصدة"), "test 70: الملاحظة تسمّي المصدر");
  assert.ok(staleBalSteady.flags.includes("stale_data"));
  assert.ok(!rcStaleBal.customers.some((c) => c.creditStatus === "delinquent"), "test 70: لا حكم تعثّر من أرصدة قديمة");

  // 71) تقرير فواتير متوقف المزامنة: لا يُستنتج «ليس زبوناً» سلوكياً (قائمة المالك تبقى).
  const rcStaleInv = engine.build({
    ...reports,
    invoicesReport: { ...reports.invoicesReport, created_at: staleIso, summary: { ...reports.invoicesReport.summary, syncedAt: staleIso } }
  });
  assert.equal(rcStaleInv.sourcesFreshness.invoices.stale, true);
  assert.ok(!["non_customer", "needs_review"].includes(rcStaleInv.customers.find((c) => c.customerGuid === G_NOTCUST).autoCredit.status),
    "test 71: فواتير قديمة لا تثبت غياب المبيع");

  // 69) حارس الفاتورة الشاذة يخصم من شهر الفاتورة الفعلي: فاتورة شاذة في الشهر السابق
  //     لا تُخصم من سحب آخر 30 يوماً (وزنه 0.6) لمجرد أنه يكفيها.
  const priorLarge = {
    guid: gid(69), name: "ائتمان فاتورة شاذة سابقة",
    movements: [
      ...regular({ from: 60, to: 32, every: 4, amount: 500, lag: 3 }),
      ...regular({ from: 28, every: 4, amount: 1500, lag: 3 }),
      debit(45, 10000), pay(40, 10000)
    ].sort((a, b) => a.date.localeCompare(b.date))
  };
  priorLarge.balance = ledgerBalance(priorLarge.movements);
  const rc69 = engine.build({
    ...reports,
    invoicesReport: invoicesReportFor([priorLarge]),
    balancesReport: { ...reports.balancesReport, items: [{ ...reports.balancesReport.items[0], key: engine.normalizeName(priorLarge.name), name: priorLarge.name,
      balance: priorLarge.balance, balanceAccountCcy: priorLarge.balance, creditLimit: 0, customerGuid: priorLarge.guid, customerAccountGuid: priorLarge.guid }] },
    movementsReport: { ...reports.movementsReport, items: [{ customerGuid: priorLarge.guid, name: priorLarge.name, truncated: false, movements: priorLarge.movements }] },
    creditLimits: []
  });
  const large69 = rc69.customers.find((c) => c.customerGuid === priorLarge.guid).autoCredit;
  assert.ok(large69.notes.some((note) => note.includes("الفاتورة الشاذة")), "test 69: الحارس فُعّل");
  assert.equal(large69.fullWindow, true, "test 69: نافذة كاملة (الوزنان 0.6/0.4 مطبّقان)");
  // الحديث 7 × 1500 = 10500؛ السابق 8 × 500 + 10000 = 14000؛ القص = 10000 − 0.35 × 24500 = 1425 من السابق.
  assert.equal(large69.velocity, Number(((0.6 * 10500 + 0.4 * (14000 - 1425)) / 30).toFixed(3)), "test 69: القص من الشهر السابق لا الحديث");

  // 72) نقل دين إلى حساب زبون حقيقي ليس مبيعاً، ولا يجعله «ليس زبوناً»:
  //     زبون بفواتير قليلة ودين منقول كبير ⇒ زبون يحتاج مراجعة بلا حد آلي؛
  //     زبون بلا فواتير في النافذة ودين منقول قديم لم يُسدَّد ⇒ متعثّر بدينه الحقيقي.
  const transferActive = {
    guid: gid(72), name: "زبون بدين منقول",
    movements: [debit(50, 100), pay(45, 100), debit(30, 900), debit(20, 100), pay(15, 100)],
    uninvoiced: new Set([d(30)])
  };
  const transferIdle = { guid: gid(73), name: "زبون خامل بدين منقول", movements: [debit(55, 400)], noInvoices: true };
  for (const a of [transferActive, transferIdle]) a.balance = ledgerBalance(a.movements);
  const withTransfers = [...accounts, transferActive, transferIdle];
  const rc72 = engine.build({
    ...reports,
    invoicesReport: invoicesReportFor(withTransfers),
    balancesReport: { ...reports.balancesReport, items: [...reports.balancesReport.items, ...[transferActive, transferIdle].map((a) => ({
      ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name, balance: a.balance, balanceAccountCcy: a.balance,
      creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid
    }))] },
    movementsReport: { ...reports.movementsReport, items: [...reports.movementsReport.items, ...[transferActive, transferIdle].map((a) => ({
      customerGuid: a.guid, name: a.name, truncated: false, movements: a.movements
    }))] }
  });
  const active72 = rc72.customers.find((c) => c.customerGuid === transferActive.guid);
  const idle72 = rc72.customers.find((c) => c.customerGuid === transferIdle.guid);
  assert.equal(active72.autoCredit.status, "needs_review", "test 72: دين منقول ⇒ يحتاج مراجعة");
  assert.equal(active72.creditLimit, null, "test 72: النقل لا يدخل سرعة السحب ولا يعطي حداً");
  assert.equal(idle72.autoCredit.status, "delinquent", "test 72: الدين المنقول غير المسدَّد تعثّر حقيقي");
  for (const c of [active72, idle72]) assert.ok(!c.flags.includes("credit_not_customer"), "test 72: زبون لا «ليس زبون مبيعات»");
  assert.deepEqual(rc72.dataAvailability.creditCycle, rc.dataAvailability.creditCycle, "test 72: لا تلوّث عيّنة المحفظة");

  // 73) Codex P1 — عملة الرصيد: حساب ليرة غاب رصيده بعملته (سطر بعملة أخرى أو معدّل
  //     غير صالح) لا يُقارن رصيده بالدولار مع حده بالليرة؛ المقارنة بعملة الأساس.
  const sypBase = row(G_SYP);
  assert.equal(sypBase.creditCurrency, "SYP", "test 73: الحد معروض بالليرة");
  assert.equal(sypBase.balanceCurrency, "SYP", "test 73: الرصيد بعملته حين يتوفر");
  assert.ok(sypBase.creditLimit > 0 && sypBase.creditLimitDisplay > sypBase.creditLimit, "test 73: حد آلي بالليرة ومكافئه بالدولار");
  const sypUsd = sypBase.creditLimit * 4;           // رصيد بالدولار يساوي أربعة أضعاف مكافئ الحد
  const rcSypNoLocal = engine.build({
    ...reports,
    balancesReport: { ...reports.balancesReport, items: reports.balancesReport.items.map((item) => (item.customerGuid === G_SYP
      ? { ...item, balance: sypUsd, balanceAccountCcy: null } : item)) }
  });
  const sypNoLocal = rcSypNoLocal.customers.find((c) => c.customerGuid === G_SYP);
  assert.equal(sypNoLocal.creditCurrency, "SYP", "test 73: الحد ما زال معروضاً بالليرة");
  assert.equal(sypNoLocal.balanceCurrency, "USD", "test 73: الرصيد البديل يُعرض بالدولار لا بالليرة");
  assert.equal(sypNoLocal.creditStatus, "over_limit", "test 73: التجاوز لا يختفي باختلاف الوحدات");
  assert.ok(Math.abs(sypNoLocal.creditUsagePercent - (sypUsd / sypNoLocal.creditLimit) * 100) < 0.01, "test 73: النسبة = دولار ÷ مكافئ الحد بالدولار");
  assert.ok(sypNoLocal.flags.includes("over_credit_limit"));

  // 74) Codex P1 — أرصدة غير حديثة: لا حد الأمين بديلاً، ولا نسبة استخدام ولا تجاوز ولا
  //     تعثّر من رصيد قديم؛ والتصنيفات المؤكدة (ليس زبوناً / يحتاج مراجعة) تبقى.
  const listedExcluded = engine.CONFIG.autoCredit.excludedAccountGuids[0];
  const listedReview = engine.CONFIG.autoCredit.reviewAccountGuids[0];
  const listedRows = [
    { guid: listedExcluded, name: "مستبعد بالمعرّف" },
    { guid: listedReview, name: "مختلط بالمعرّف" }
  ];
  const withListed = {
    ...reports,
    balancesReport: { ...reports.balancesReport, items: [
      ...reports.balancesReport.items.map((item) => ({ ...item, creditLimit: 5000 })),
      ...listedRows.map((a) => ({ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name, balance: 4000, balanceAccountCcy: 4000,
        creditLimit: 5000, customerGuid: a.guid, customerAccountGuid: a.guid }))
    ] },
    movementsReport: { ...reports.movementsReport, items: [
      ...reports.movementsReport.items,
      ...listedRows.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false, movements: regular({ from: 50, every: 7, amount: 800, lag: 3 }) }))
    ] }
  };
  const rcStaleBal74 = engine.build({ ...withListed, balancesReport: { ...withListed.balancesReport, created_at: staleIso,
    summary: { ...withListed.balancesReport.summary, syncedAt: staleIso } } });
  assert.equal(rcStaleBal74.sourcesFreshness.balances.stale, true);
  for (const c of rcStaleBal74.customers.filter((entry) => ![listedExcluded, listedReview, G_NOTCUST].includes(entry.customerGuid))) {
    assert.equal(c.creditLimit, null, `test 74: لا حد من أرصدة قديمة (${c.customerName})`);
    assert.notEqual(c.creditLimitSource, "ameen", `test 74: لا احتياط لحد الأمين (${c.customerName})`);
    assert.equal(c.creditUsagePercent, null, `test 74: لا نسبة استخدام (${c.customerName})`);
    assert.ok(!["over_limit", "near_limit", "delinquent"].includes(c.creditStatus), `test 74: لا حكم من رصيد قديم (${c.customerName})`);
  }
  const staleSteady74 = rcStaleBal74.customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(staleSteady74.creditStatus, "stale_balance", "test 74: الحالة معلنة غير حديثة");
  assert.equal(staleSteady74.creditLimitSource, "stale");
  assert.ok(staleSteady74.flags.includes("stale_data"));
  assert.ok(staleSteady74.explanation.some((reason) => reason.includes("غير حديث")), "test 74: السبب ظاهر");
  const staleExcluded = rcStaleBal74.customers.find((c) => c.customerGuid === listedExcluded);
  const staleReview = rcStaleBal74.customers.find((c) => c.customerGuid === listedReview);
  assert.equal(staleExcluded.creditStatus, "not_customer", "test 74: «ليس زبوناً» المؤكد يبقى");
  assert.equal(staleReview.creditStatus, "needs_review", "test 74: المختلط المؤكد يبقى «يحتاج مراجعة»");
  assert.equal(rcStaleBal74.customers.find((c) => c.customerGuid === G_NOTCUST).creditStatus, "needs_review", "test 74: الشذوذ السلوكي يبقى «يحتاج مراجعة»");
  for (const c of [staleExcluded, staleReview]) assert.equal(c.creditLimit, null);
  // الضبط: الأرصدة نفسها حديثة ⇒ تعود الأحكام (الاختبار يقيس القِدم لا غياب الحد).
  const freshSteady74 = engine.build(withListed).customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(freshSteady74.creditLimitSource, "auto");
  assert.ok(freshSteady74.creditLimit > 0);

  // 75) Codex P1 — عمر الدين المرحَّل: تاريخه الاصطناعي يتدحرج مع نافذة الحركات، فلا
  //     يصغر عمره في لقطة لاحقة ولا يفلت من «متأخر» حين يطول حد الدورة (> عمر النافذة).
  //     وتبقى بقية شروط التعثّر: دين مرحَّل مغطّى بدفعات كافية ليس تعثّراً.
  const longCycle = (id) => ({ guid: gid(id), name: `دورة طويلة ${id}`, truncated: false,
    movements: regular({ from: 90, every: 5, amount: 500, lag: 55 }) });
  const portfolio75 = [75, 76, 77, 78, 79, 80].map(longCycle);
  const G75 = gid(81);
  // سحب قديم غير مسدَّد يطيل دورة الزبون نفسه إلى سقف المحفظة (≈ 55 يوماً).
  const target75 = regular({ from: 90, to: 60, every: 6, amount: 300, lag: null });
  const snapshot75 = (fromDays, extraTarget = []) => {
    const all = [...portfolio75, { guid: G75, name: "دين مرحَّل قديم", truncated: false, openingBalance: 3000, movements: [...target75, ...extraTarget] }];
    return engine.build({
      now: NOW,
      invoicesReport: invoicesReportFor(all.map((a) => ({ ...a }))),
      balancesReport: { ...reports.balancesReport, items: all.map((a) => ({ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name,
        balance: (a.openingBalance ?? 0) + ledgerBalance(a.movements), balanceAccountCcy: (a.openingBalance ?? 0) + ledgerBalance(a.movements),
        creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid })) },
      movementsReport: { ...reports.movementsReport, summary: { ...reports.movementsReport.summary, fromDate: d(fromDays) },
        items: all.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false, openingBalance: a.openingBalance ?? 0, movements: a.movements })) },
      creditLimits: []
    }).customers.find((c) => c.customerGuid === G75);
  };
  // اللقطة الأولى (نافذة من 92 يوماً) ولقطة لاحقة بعد 30 يوماً: الدين نفسه يرحَّل من
  // بداية أحدث، فتاريخه الاصطناعي يصبح أحدث بـ30 يوماً.
  const early75 = snapshot75(92);
  const later75 = snapshot75(62);
  assert.ok(early75.autoCredit.overdueAfterDays > 93, "test 75: حد الدورة أطول من النافذة (السيناريو المقصود)");
  for (const [label, c] of [["الأولى", early75], ["اللاحقة", later75]]) {
    assert.ok(c.autoCredit.overdueAmount >= 3000, `test 75: الدين المرحَّل متأخر في اللقطة ${label}`);
    assert.equal(c.creditStatus, "delinquent", `test 75: رصيد قائم + متأخر + بلا دفعات = تعثّر (${label})`);
  }
  assert.ok(later75.autoCredit.overdueAmount >= early75.autoCredit.overdueAmount, "test 75: لا يصغر عمر الدين في لقطة لاحقة");
  // الحارس باقٍ: الدين المرحَّل نفسه مع دفعات تغطي أكثر من نصفه ليس تعثّراً.
  const paid75 = snapshot75(92, [pay(40, 1200), pay(20, 1200)]);
  assert.ok(paid75.autoCredit.overdueAmount > 0, "test 75: ما بقي من المرحَّل ما زال متأخراً");
  assert.notEqual(paid75.creditStatus, "delinquent", "test 75: المرحَّل وحده لا يصنع تعثّراً");

  // 76) Codex P1 — قائمتا المالك بلا أي حركة: حساب مدرج غاب عن تقرير الحركات (بلا
  //     حركة ولا رصيد مرحَّل في النافذة) يبقى مصنَّفاً، ولا يسقط إلى حد الأمين.
  const noMoveRows = [
    { guid: engine.CONFIG.autoCredit.excludedAccountGuids[1], name: "مستبعد بلا حركة", status: "non_customer", credit: "not_customer" },
    { guid: engine.CONFIG.autoCredit.reviewAccountGuids[0], name: "مختلط بلا حركة", status: "needs_review", credit: "needs_review" }
  ];
  const noMoveBalances = { ...reports.balancesReport, items: [...reports.balancesReport.items,
    ...noMoveRows.map((a) => ({ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name, balance: 3000,
      balanceAccountCcy: 3000, creditLimit: 5000, customerGuid: a.guid, customerAccountGuid: a.guid }))] };
  for (const [label, movementsReport] of [["دفتر بلا هذه الحسابات", reports.movementsReport], ["بلا تقرير حركات إطلاقاً", null]]) {
    const built = engine.build({ ...reports, balancesReport: noMoveBalances, movementsReport });
    for (const a of noMoveRows) {
      const c = built.customers.find((entry) => entry.customerGuid === a.guid);
      assert.ok(c, `test 76: السجل موجود (${a.name})`);
      assert.equal(c.autoCredit?.status, a.status, `test 76 (${label}): ${a.name} يبقى مصنَّفاً`);
      assert.equal(c.creditStatus, a.credit, `test 76 (${label}): ${a.name}`);
      assert.equal(c.creditLimit, null, `test 76 (${label}): لا حد`);
      assert.notEqual(c.creditLimitSource, "ameen", `test 76 (${label}): لا احتياط لحد الأمين`);
    }
  }

  // 77) Codex P1 / قرار المالك (2026-09-27) — نوع الدائن من `lineKind` الموسوم وحده.
  //     تحت summary.lineKinds = "v1": sale_payment (الاسم القانوني لدفعة البيع) و
  //     payment/receipt (توافق) دفعة زبون تدخل التغطية والجودة والانتظام وFIFO واختبار
  //     التعثّر. discount/debt_transfer/adjustment تُنقص الدين (FIFO) ولا تُعدّ دفعة.
  //     purchase/purchase_payment/unknown لا دفعة ولا تسوية. return مرتجع لا دفعة.
  //     بلا العلامة يُتجاهل الحقل ويبقى السلوك الحالي (الدائن دفعة) — لا نافذة انتقال.
  const portfolio77 = [82, 83, 84, 85, 86, 87].map((id) => ({
    guid: gid(id), name: `محفظة lineKind ${id}`, truncated: false,
    movements: regular({ from: 59, every: 6, amount: 500, lag: 6 }).map((m) => (m.credit > 0 ? { ...m, lineKind: "payment" } : { ...m, lineKind: "sale" }))
  }));
  const credit77 = (kind) => ({ date: d(5), debit: 0, credit: 1800, notes: "", billGuid: "", ...(kind ? { lineKind: kind } : {}) });
  const build77 = (cases, marker) => {
    const all = [...portfolio77, ...cases.map((c) => ({ guid: gid(c.id), name: c.name, truncated: false,
      movements: [{ ...debit(40, 2000), ...(marker ? { lineKind: "sale" } : {}) }, credit77(c.kind)] }))];
    return engine.build({
      untyped: !marker,
      now: NOW,
      invoicesReport: invoicesReportFor(all.map((a) => ({ ...a }))),
      balancesReport: { ...reports.balancesReport, items: all.map((a) => ({ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name,
        balance: ledgerBalance(a.movements), balanceAccountCcy: ledgerBalance(a.movements), creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid })) },
      movementsReport: { ...reports.movementsReport, summary: { ...reports.movementsReport.summary, ...(marker ? { lineKinds: marker } : {}) },
        items: all.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false, movements: a.movements })) },
      creditLimits: []
    });
  };
  // المتوقَّع لكل نوع: paid = ما دخل مقاييس السداد، overdue = ما بقي مفتوحاً متأخراً بعد FIFO.
  const PAY = { paid: 1800, overdue: 200, lastPayDays: 5, delinquent: false };
  const SETTLE = { paid: 0, overdue: 200, lastPayDays: null, delinquent: true };
  const NONE = { paid: 0, overdue: 2000, lastPayDays: null, delinquent: true };
  const cases77 = [
    { id: 88, kind: "sale_payment", ...PAY },     // 1) دفعة البيع الحقيقية
    { id: 89, kind: "payment", ...PAY },          // 2) الاسم القديم يبقى دفعة
    { id: 90, kind: "receipt", ...PAY },          // 3)
    { id: 91, kind: "discount", ...SETTLE },      // 4) يُنقص الفاتورة، ليس دفعة
    { id: 92, kind: "purchase", ...NONE },        // 5) مشترياتنا ليست سداداً
    { id: 93, kind: "purchase_payment", ...NONE },// 6) ليس دفعة زبون
    { id: 94, kind: "debt_transfer", ...SETTLE }, // 7) نقل الدين ليس دفعة
    { id: 96, kind: "adjustment", ...SETTLE },
    { id: 97, kind: "return", ...SETTLE },
    { id: 99, kind: "purchase_return", ...NONE }  //    جانب الشراء: لا دفعة ولا تسوية
    // 8) unknown: عقد 78 (دون حد الأهمية لا يحسّن السداد؛ فوقه «يحتاج مراجعة»).
  ].map((c) => ({ ...c, name: `lineKind ${c.kind}` }));
  const rc77 = build77(cases77, "v1");
  for (const c of cases77) {
    const r77 = rc77.customers.find((entry) => entry.customerGuid === gid(c.id));
    assert.ok(r77, `test 77: السجل موجود (${c.kind})`);
    assert.equal(r77.autoCredit.paidInOverdueSpan, c.paid, `test 77: ${c.kind} في مقاييس السداد`);
    assert.equal(r77.autoCredit.overdueAmount, c.overdue, `test 77: ${c.kind} وتسوية FIFO`);
    assert.equal(r77.autoCredit.daysSinceLastPayment, c.lastPayDays, `test 77: ${c.kind} آخر دفعة`);
    assert.equal(r77.creditStatus === "delinquent", c.delinquent, `test 77: ${c.kind} واختبار التعثّر`);
    if (c.paid === 0) assert.ok(!(r77.autoCredit.coverage > 0.5), `test 77: ${c.kind} لا يرفع التغطية`);
  }
  // 9–10) لا نافذة انتقال (قرار المالك 2026-09-27، Codex P1): تقرير بلا العلامة ⇒ الحد
  //       الآلي مغلق (fail-closed) لا حد من دفتر ملتبس؛ ومع v1 يعمل المحرك بالتصنيف الجديد.
  //       فلا وقت يرسل فيه المصدر أنواعاً لا يفهمها المحرك، ولا وقت يُصدر فيه حداً من مصدر قديم.
  const legacy77 = build77([{ id: 88, name: "lineKind sale_payment", kind: null }, { id: 91, name: "lineKind discount", kind: "discount" }], null);
  assert.ok(rc77.customers.find((c) => c.customerGuid === gid(88)).creditLimit > 0, "test 77: مع v1 حد آلي للدافع");
  for (const id of [88, 91]) {
    const old = legacy77.customers.find((c) => c.customerGuid === gid(id));
    assert.equal(old.creditLimit, null, `test 77: بلا علامة لا حد آلي (${id})`);
    assert.equal(old.creditStatus, "awaiting_typed_source", `test 77: بلا علامة الحالة معلنة (${id})`);
    assert.equal(old.creditUsagePercent, null, `test 77: بلا علامة لا نسبة استخدام (${id})`);
  }
  // عيّنة المحفظة بأنواع v1 (sale/payment) = المحفظة القديمة بلا حقل: الدورة لا تتغير.
  assert.deepEqual(rc77.dataAvailability.creditCycle, legacy77.dataAvailability.creditCycle, "test 77: دورة المحفظة لا تتغير بالانتقال");

  // 78) قرار المالك — جانب المدين وunknown المادّي تحت lineKinds:v1.
  //     Sales Velocity بقائمة سماح: sale وحده سحب. جانب الشراء (purchase_payment،
  //     payment_out، purchase_return) لا سحب ولا دين. debt_transfer/adjustment/unknown
  //     دين بلا سحب. unknown بقيمة ≥ حد الأهمية (delinquentMinAmount = 50، نفس حد شذوذ
  //     الدفتر) ⇒ «يحتاج مراجعة» يسبق التعثّر، بلا حد، وخارج عيّنة المحفظة. بلا العلامة لا شيء يتغير.
  const tag = (m, kind) => ({ ...m, lineKind: kind });
  const debitCases78 = [
    { id: 101, kind: "sale", draws: 3000 },
    { id: 102, kind: "purchase_payment", draws: 2000 },
    { id: 103, kind: "payment_out", draws: 2000 },
    { id: 104, kind: "purchase_return", draws: 2000 },
    { id: 105, kind: "debt_transfer", draws: 2000 },
    { id: 106, kind: "adjustment", draws: 2000 },
    { id: 107, kind: "unknown", draws: 2000, amount: 30 }  // دون حد الأهمية: لا مراجعة ولا سحب
  ].map((c) => ({ ...c, name: `مدين ${c.kind}`,
    movements: [tag(debit(40, 2000), "sale"), tag(debit(20, c.amount ?? 1000), c.kind), tag(pay(10, 2000), "sale_payment")] }));
  const materialUnknown = { id: 108, name: "مجهول مادّي", movements: [tag(debit(50, 2000), "sale"), tag(debit(45, 500), "unknown")] };
  const smallUnknownCredit = { id: 109, name: "دائن مجهول صغير", movements: [tag(debit(40, 2000), "sale"), tag(pay(10, 30), "unknown")] };
  const unknownInPortfolio = { id: 110, name: "محفظة بحركة مجهولة",
    movements: [...regular({ from: 59, every: 6, amount: 500, lag: 40 }).map((m) => tag(m, m.credit > 0 ? "payment" : "sale")), tag(pay(3, 100), "unknown")] };
  const build78 = (list, marker) => {
    const all = [...portfolio77.map((a) => ({ ...a, movements: marker ? a.movements : a.movements.map(({ lineKind, ...m }) => m) })),
      ...list.map((c) => ({ guid: gid(c.id), name: c.name, truncated: false, movements: marker ? c.movements : c.movements.map(({ lineKind, ...m }) => m) }))];
    return engine.build({
      now: NOW,
      invoicesReport: invoicesReportFor(all.map((a) => ({ ...a }))),
      balancesReport: { ...reports.balancesReport, items: all.map((a) => ({ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name,
        balance: ledgerBalance(a.movements), balanceAccountCcy: ledgerBalance(a.movements), creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid })) },
      movementsReport: { ...reports.movementsReport, summary: { ...reports.movementsReport.summary, ...(marker ? { lineKinds: marker } : {}) },
        items: all.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false, movements: a.movements })) },
      creditLimits: []
    });
  };
  const rc78 = build78([...debitCases78, materialUnknown, smallUnknownCredit, unknownInPortfolio], "v1");
  // «legacy78/79» = الدفتر نفسه موسوماً بقاعدة التصنيف القديمة (المدين sale والدائن
  // sale_payment) — ضبط يثبت أن الفرق من النوع المجهول وحده.
  const legacy78 = build78([...debitCases78, materialUnknown, smallUnknownCredit, unknownInPortfolio], null);
  const at78 = (built, id) => built.customers.find((c) => c.customerGuid === gid(id));
  const draws = (c) => c.autoCredit.salesRecent + c.autoCredit.salesPrior;
  for (const c of debitCases78) {
    const v1 = at78(rc78, c.id);
    assert.equal(draws(v1), c.draws, `test 78: مدين ${c.kind} ${c.draws === 3000 ? "يدخل" : "لا يدخل"} Sales Velocity`);
    assert.notEqual(v1.autoCredit.status, "needs_review", `test 78: ${c.kind} معروف لا «يحتاج مراجعة»`);
    // بلا العلامة: كل مدين غير افتتاحي سحب كما اليوم.
    assert.equal(draws(at78(legacy78, c.id)), 2000 + (c.amount ?? 1000), `test 78: بالتصنيف القديم ${c.kind} سحب كالسلوك القديم`);
  }
  // جانب الشراء لا يدخل FIFO: الدفعة 2000 تسدّد الفاتورة كلها فلا دين مفتوح.
  for (const id of [102, 103, 104]) assert.equal(at78(rc78, id).autoCredit.oldestOpenDays, null, `test 78: جانب الشراء ليس ديناً على الزبون (${id})`);
  // نقل الدين والتسوية دين حقيقي بلا سحب: يبقى مفتوحاً (عمره 20) بعد أن سدّدت الدفعة الفاتورة الأقدم.
  for (const id of [105, 106]) assert.equal(at78(rc78, id).autoCredit.oldestOpenDays, 20, `test 78: دين غير سحبي يبقى ديناً (${id})`);
  const mu = at78(rc78, 108);
  assert.equal(mu.autoCredit.status, "needs_review", "test 78: unknown مادّي ⇒ يحتاج مراجعة");
  assert.equal(mu.creditLimit, null, "test 78: unknown مادّي ⇒ لا حد");
  assert.equal(mu.creditStatus, "needs_review");
  assert.notEqual(at78(legacy78, 108).creditStatus, "needs_review", "test 78: بالتصنيف القديم لا مراجعة");
  assert.equal(at78(legacy78, 108).creditStatus, "delinquent", "test 78: الضبط — الدفتر نفسه متعثّر بلا الحارس");
  assert.ok(mu.explanation.some((reason) => reason.includes("غير مصنّفة")), "test 78: السبب ظاهر");
  const su = at78(rc78, 109);
  assert.notEqual(su.autoCredit.status, "needs_review", "test 78: unknown دون حد الأهمية لا يوقف الحساب");
  assert.equal(su.autoCredit.paidInOverdueSpan, 0, "test 78: unknown لا يُعدّ دفعة");
  assert.equal(su.autoCredit.daysSinceLastPayment, null);
  assert.equal(at78(rc78, 110).autoCredit.status, "needs_review", "test 78: حساب المحفظة بمجهول مادّي يحتاج مراجعة");
  const rcNoUnknownAcct = build78([...debitCases78, materialUnknown, smallUnknownCredit], "v1");
  assert.deepEqual(rc78.dataAvailability.creditCycle, rcNoUnknownAcct.dataAvailability.creditCycle, "test 78: الحساب الملتبس لا يلوّث معايرة المحفظة");
  assert.ok(engine.CONFIG.autoCredit.delinquentMinAmount === 50, "test 78: حد الأهمية نفسه");

  // 79) قرار المالك (2026-09-27) — lineKind = other (حساب مقابل لم يثبت نوعه) حركة غير
  //     محسومة كـunknown تماماً: لا سحب ولا دفعة ولا تسوية ولا دين؛ أثرها ≥ حد الأهمية (50)
  //     ⇒ «يحتاج مراجعة» يسبق التعثّر، بلا حد، وخارج عيّنة المحفظة؛ دونه لا يوقف الحساب.
  const otherMaterialDebit = { id: 111, name: "مدين other مادّي", movements: [tag(debit(50, 2000), "sale"), tag(debit(45, 500), "other")] };
  const otherMaterialCredit = { id: 112, name: "دائن other مادّي", movements: [tag(debit(80, 2000), "sale"), tag(pay(20, 1500), "other")] };
  const otherSmallDebit = { id: 113, name: "مدين other صغير", movements: [tag(debit(40, 2000), "sale"), tag(debit(20, 30), "other"), tag(pay(10, 2000), "sale_payment")] };
  const otherSmallCredit = { id: 114, name: "دائن other صغير", movements: [tag(debit(40, 2000), "sale"), tag(pay(10, 30), "other")] };
  const otherInPortfolio = { id: 115, name: "محفظة بحركة other",
    movements: [...regular({ from: 59, every: 6, amount: 500, lag: 40 }).map((m) => tag(m, m.credit > 0 ? "payment" : "sale")), tag(pay(3, 100), "other")] };
  const list79 = [otherMaterialDebit, otherMaterialCredit, otherSmallDebit, otherSmallCredit, otherInPortfolio];
  const rc79 = build78(list79, "v1");
  const legacy79 = build78(list79, null);
  // 1) و2) مادّي ⇒ مراجعة بلا حد، ولا تعثّر من الغموض (الدفتر نفسه بلا العلامة متعثّر).
  for (const id of [111, 112]) {
    const r = at78(rc79, id);
    assert.equal(r.creditStatus, "needs_review", `test 79: other مادّي ⇒ يحتاج مراجعة (${id})`);
    assert.equal(r.creditLimit, null, `test 79: other مادّي ⇒ لا حد (${id})`);
    assert.equal(r.autoCredit.overdueAmount, undefined, `test 79: other مادّي ⇒ لا حكم تعثّر (${id})`);
  }
  assert.equal(at78(legacy79, 111).creditStatus, "delinquent", "test 79: الضبط — الدفتر نفسه متعثّر بلا الحارس");
  // 3) حساب المحفظة بـother مادّي خارج المعايرة.
  assert.equal(at78(rc79, 115).creditStatus, "needs_review", "test 79: حساب المحفظة بـother مادّي يحتاج مراجعة");
  assert.deepEqual(rc79.dataAvailability.creditCycle, build78(list79.slice(0, 4), "v1").dataAvailability.creditCycle, "test 79: other لا يلوّث معايرة المحفظة");
  // 4) و6) مدين other صغير: لا سحب ولا دين، ولا يوقف الحساب.
  const osd = at78(rc79, 113);
  assert.notEqual(osd.creditStatus, "needs_review", "test 79: other دون حد الأهمية لا يوقف الحساب");
  assert.equal(draws(osd), 2000, "test 79: مدين other لا يرفع Sales Velocity");
  assert.equal(osd.autoCredit.oldestOpenDays, null, "test 79: مدين other ليس ديناً مؤكداً");
  // 5) و6) دائن other صغير: لا دفعة ولا تسوية، ولا يوقف الحساب.
  const osc = at78(rc79, 114);
  assert.notEqual(osc.creditStatus, "needs_review", "test 79: دائن other صغير لا يوقف الحساب");
  assert.equal(osc.autoCredit.paidInOverdueSpan, 0, "test 79: دائن other لا يُعدّ دفعة");
  assert.equal(osc.autoCredit.daysSinceLastPayment, null, "test 79: دائن other ليس آخر دفعة");
  assert.equal(osc.autoCredit.overdueAmount, 2000, "test 79: دائن other لا يسوّي الدين");
  // 7) بلا العلامة: السلوك القديم كما هو — المدين سحب والدائن دفعة ولا مراجعة.
  assert.equal(draws(at78(legacy79, 113)), 2030, "test 79: بالتصنيف القديم مدين other سحب كالسلوك القديم");
  assert.equal(at78(legacy79, 114).autoCredit.paidInOverdueSpan, 30, "test 79: بالتصنيف القديم دائن other دفعة كالسلوك القديم");
  for (const c of list79) assert.notEqual(at78(legacy79, c.id).creditStatus, "needs_review", `test 79: بالتصنيف القديم لا مراجعة (${c.id})`);

  // 80) قرار المالك (2026-09-27، Codex P1) — الحد الآلي fail-closed بلا lineKinds:v1: لا حد
  //     آلي ولا نسبة استخدام ولا تجاوز ولا تعثّر من دفتر يخلط الحسم والمشتريات بالدفعات،
  //     والتصنيفات المؤكدة (ليس زبوناً، مختلط، يحتاج مراجعة) تبقى. مع v1 حديث يعمل المحرك.
  const untyped80 = engine.build({ ...reports, untyped: true });
  assert.equal(untyped80.dataAvailability.autoCreditEnabled, false, "test 80: بلا علامة الحد الآلي مغلق");
  assert.equal(rc.dataAvailability.autoCreditEnabled, true, "test 80: مع v1 الحد الآلي يعمل");
  const byGuid80 = new Map(untyped80.customers.map((c) => [c.customerGuid, c]));
  let gated80 = 0;
  for (const typed of rc.customers) {
    if (typed.isSupplier || !typed.customerGuid) continue;
    const u = byGuid80.get(typed.customerGuid);
    assert.ok(u, `test 80: السجل موجود (${typed.customerGuid})`);
    assert.equal(u.creditLimit === null || u.creditLimitSource === "ameen", true, `test 80: لا حد آلي بلا علامة (${typed.customerGuid})`);
    // حد مُدخل يدوياً في الأمين (إن وُجد) يبقى بمصدره كمسار الدفتر غير الحديث — ليس حداً آلياً.
    if (u.creditLimitSource === "ameen") { assert.equal(typed.creditLimitSource, "ameen", "test 80: حد الأمين بمصدره"); continue; }
    assert.ok(!["delinquent", "over_limit", "near_limit", "normal", "inactive_no_limit", "prepaid"].includes(u.creditStatus), `test 80: لا حكم ائتمان بلا علامة (${typed.customerGuid}: ${u.creditStatus})`);
    assert.equal(u.creditUsagePercent, null, `test 80: لا نسبة استخدام بلا علامة (${typed.customerGuid})`);
    if (["not_customer", "needs_review"].includes(typed.creditStatus)) {
      assert.equal(u.creditStatus, typed.creditStatus, `test 80: التصنيف المؤكد يبقى (${typed.customerGuid})`);
    } else if (u.creditStatus === "awaiting_typed_source") {
      gated80 += 1;
      assert.equal(u.creditLimit, null);
      assert.ok(u.explanation.some((reason) => reason.includes("lineKinds:v1")), "test 80: السبب ظاهر");
    }
  }
  assert.ok(gated80 >= 5, "test 80: حسابات عادية ومتعثرة كلها مغلقة بلا علامة");
  for (const status of ["delinquent", "normal", "needs_review"]) {
    assert.ok(rc.customers.some((c) => c.creditStatus === status), `test 80: التركيبة تغطي ${status} مع v1`);
  }
  // قائمتا المالك (ليس زبوناً / مختلط) تبقيان بلا علامة أيضاً.
  assert.equal(asOwnerListed(engine.CONFIG.autoCredit.excludedAccountGuids[0], true).creditStatus, "not_customer", "test 80: ليس زبوناً يبقى بلا علامة");
  assert.equal(asOwnerListed(engine.CONFIG.autoCredit.reviewAccountGuids[0], true).creditStatus, "needs_review", "test 80: المختلط يبقى بلا علامة");
  assert.equal(untyped80.summary.delinquentCreditCount, 0, "test 80: لا متعثّر من مصدر ملتبس");

  // 81) قرار المالك (2026-09-27، Codex P1) — بوابة الحد الآلي تتطلب الفواتير حديثة أيضاً.
  //     يوم المرجع ونافذة السحب من لقطة الفواتير: قِدمها يُخرج مبيعات أحدث من النافذة بينما
  //     الرصيد وFIFO حاليان. مع v1 وحركات وأرصدة حديثة وفواتير قديمة: لا حد آلي ولا نسبة ولا
  //     تجاوز ولا تعثّر ولا «غير نشط»، والتصنيفات المؤكدة وحد الأمين اليدوي بمصدره يبقيان.
  const invoicesAt = (iso) => ({ ...reports.invoicesReport, created_at: iso, summary: { ...reports.invoicesReport.summary, syncedAt: iso } });
  const oldInvoicesIso = new Date(NOW.getTime() - 35 * 86400000).toISOString();   // لقطة من الشهر الماضي
  for (const [label, iso] of [["قبل 3 ساعات", staleIso], ["قبل 35 يوماً", oldInvoicesIso]]) {
    const staleInv81 = engine.build({ ...reports, invoicesReport: invoicesAt(iso) });
    assert.equal(staleInv81.sourcesFreshness.invoices.stale, true, `test 81 (${label}): الفواتير قديمة`);
    assert.equal(staleInv81.sourcesFreshness.movements.stale || staleInv81.sourcesFreshness.balances.stale, false, `test 81 (${label}): الحركات والأرصدة حديثة`);
    const byGuid81 = new Map(staleInv81.customers.map((c) => [c.customerGuid, c]));
    let gated81 = 0;
    for (const fresh of rc.customers) {
      if (fresh.isSupplier || !fresh.customerGuid) continue;
      const c = byGuid81.get(fresh.customerGuid);
      assert.ok(c, `test 81: السجل موجود (${fresh.customerGuid})`);
      if (fresh.creditStatus === "not_customer") {
        assert.equal(c.creditStatus, "not_customer", `test 81 (${label}): التصنيف المؤكد يبقى (${fresh.customerGuid})`);
        continue;
      }
      if (fresh.creditStatus === "needs_review") {
        // شذوذ الدفتر السلوكي يُحكم من فواتير حديثة وحدها (عقد 71)؛ بلاها يبقى مغلقاً بلا حد.
        assert.ok(["needs_review", "stale_invoices"].includes(c.creditStatus), `test 81 (${label}): المراجعة لا تنفتح (${fresh.customerGuid})`);
        assert.equal(c.creditLimit, null);
        continue;
      }
      if (c.creditLimitSource === "ameen") { assert.equal(fresh.creditLimitSource, "ameen", "test 81: حد الأمين بمصدره لا حداً آلياً"); continue; }
      assert.ok(!["delinquent", "over_limit", "near_limit", "normal", "inactive_no_limit", "prepaid"].includes(c.creditStatus),
        `test 81 (${label}): لا حكم ائتمان من فواتير قديمة (${fresh.customerGuid}: ${c.creditStatus})`);
      assert.equal(c.creditLimit, null, `test 81 (${label}): لا حد آلي (${fresh.customerGuid})`);
      assert.equal(c.creditUsagePercent, null, `test 81 (${label}): لا نسبة استخدام (${fresh.customerGuid})`);
      if (c.creditStatus === "stale_invoices") {
        gated81 += 1;
        assert.equal(c.creditLimitSource, "stale_invoices");
        assert.ok(c.explanation.some((reason) => reason.includes("الفواتير غير حديث")), "test 81: السبب ظاهر");
      }
    }
    assert.ok(gated81 >= 5, `test 81 (${label}): حسابات عادية ومتعثرة كلها مغلقة`);
    assert.equal(staleInv81.summary.delinquentCreditCount, 0, `test 81 (${label}): لا متعثّر`);
    // زبون سحب حديثاً (يوما 12 و3): بلقطة فواتير عمرها 35 يوماً كان يُحكم «غير نشط» بحد صفر.
    assert.notEqual(byGuid81.get(G_NEW).creditStatus, "inactive_no_limit", `test 81 (${label}): لا «غير نشط» من نافذة فواتير قديمة`);
    assert.equal(byGuid81.get(G_NEW).creditStatus, "stale_invoices");
    // قائمتا المالك تبقيان مع فواتير قديمة.
    for (const [guid, status] of [[engine.CONFIG.autoCredit.excludedAccountGuids[0], "not_customer"], [engine.CONFIG.autoCredit.reviewAccountGuids[0], "needs_review"]]) {
      const listed = engine.build({ ...reports, invoicesReport: invoicesAt(iso),
        balancesReport: { ...reports.balancesReport, items: [...reports.balancesReport.items, { ...reports.balancesReport.items[0], key: "مدرج", name: "مدرج", balance: 900, balanceAccountCcy: 900, creditLimit: 0, customerGuid: guid, customerAccountGuid: guid }] } })
        .customers.find((c) => c.customerGuid === guid);
      assert.equal(listed.creditStatus, status, `test 81 (${label}): قائمة المالك تبقى (${status})`);
    }
  }
  // الفواتير حديثة مع v1 وحركات وأرصدة حديثة: المحرك يعمل (عقد 47 وما بعده على rc نفسه).
  assert.equal(rc.sourcesFreshness.invoices.stale, false);
  assert.equal(row(G_STEADY).creditLimitSource, "auto", "test 81: بفواتير حديثة الحد آلي");
  assert.ok(row(G_STEADY).creditLimit > 0);
  assert.notEqual(row(G_NEW).creditStatus, "stale_invoices");
  // بلا v1 يبقى مغلقاً (عقد 80)، ومع فواتير قديمة أيضاً لا حد ولا حكم.
  const untypedStale81 = engine.build({ ...reports, untyped: true, invoicesReport: invoicesAt(staleIso) });
  assert.ok(untypedStale81.customers.every((c) => c.creditLimitSource !== "auto" && !["delinquent", "over_limit", "near_limit"].includes(c.creditStatus)),
    "test 81: بلا v1 وفواتير قديمة يبقى مغلقاً");

  // 82) Codex P1 / قرار المالك — حارس الفاتورة الشاذة يعدّ فواتير نافذة السحب (60 يوماً) وحدها.
  //     3 فواتير في الأيام 61–92 + فاتورة واحدة كبيرة داخل النافذة ⇒ windowDebitCount = 1 < 4:
  //     لا قصّ. والحالة المقابلة (عدة فواتير داخل النافذة وواحدة كبيرة) يعمل فيها الحارس كما كان.
  const build82 = (movements) => {
    const a = { guid: gid(82), name: "حارس الفاتورة الشاذة بالنافذة", movements };
    return engine.build({
      ...reports,
      invoicesReport: invoicesReportFor([a]),
      balancesReport: { ...reports.balancesReport, items: [{ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name,
        balance: ledgerBalance(movements), balanceAccountCcy: ledgerBalance(movements), creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid }] },
      movementsReport: { ...reports.movementsReport, items: [{ customerGuid: a.guid, name: a.name, truncated: false, movements }] },
      creditLimits: []
    }).customers.find((c) => c.customerGuid === a.guid).autoCredit;
  };
  const guardFired = (auto) => auto.notes.some((note) => note.includes("الفاتورة الشاذة"));
  const oldPlusOne = build82([debit(90, 400), pay(86, 400), debit(80, 400), pay(76, 400), debit(70, 400), pay(66, 400), debit(30, 3000), pay(25, 3000)]);
  assert.equal(guardFired(oldPlusOne), false, "test 82: فواتير الأيام 61–92 لا تجعل فاتورة النافذة الوحيدة شاذة");
  assert.equal(oldPlusOne.salesPrior, 3000, "test 82: سحب النافذة كاملاً بلا قصّ");
  const manyInWindow = build82([...regular({ from: 56, every: 8, amount: 300, lag: 4 }), debit(20, 6000), pay(16, 6000)]);
  assert.equal(guardFired(manyInWindow), true, "test 82: عدة فواتير داخل النافذة ⇒ الحارس يعمل كما كان");
  const fewInWindow = build82([debit(50, 300), pay(46, 300), debit(40, 300), pay(36, 300), debit(20, 6000), pay(16, 6000)]);
  assert.equal(guardFired(fewInWindow), false, "test 82: ثلاث فواتير فقط داخل النافذة (< 4) ⇒ لا قصّ");

  // 83) Codex P1 / قرار المالك — يوم المرجع هو يوم المحاسبة المحلي (`report_date`) لا تاريخ UTC
  //     من `syncedAt`. مزامنة الساعة 01:30 بتوقيت دمشق (22:30Z من اليوم السابق) وكل المصادر
  //     حديثة: زبون اشترى اليوم المحلي لا يُحكم «غير نشط»، وسحب اليوم داخل النافذة.
  const utcIso83 = new Date(REF_DAY - 90 * 60000).toISOString();   // 2026-09-01T22:30Z
  const now83 = new Date(REF_DAY - 85 * 60000);
  const today83 = { guid: gid(83), name: "مشترٍ بعد منتصف الليل المحلي", movements: [debit(0, 900)] };
  const build83 = (withReportDate) => {
    const at = ({ report_date: _fixtureDay, ...report }) => ({ ...report, created_at: utcIso83, ...(withReportDate ? { report_date: d(0) } : {}),
      summary: { ...report.summary, syncedAt: utcIso83 } });
    return engine.build({
      invoicesReport: at(invoicesReportFor([today83])),
      balancesReport: at({ ...reports.balancesReport, items: [{ ...reports.balancesReport.items[0], key: engine.normalizeName(today83.name), name: today83.name,
        balance: 900, balanceAccountCcy: 900, creditLimit: 0, customerGuid: today83.guid, customerAccountGuid: today83.guid }] }),
      movementsReport: at({ ...reports.movementsReport, items: [{ customerGuid: today83.guid, name: today83.name, truncated: false, movements: today83.movements }] }),
      creditLimits: [], now: now83
    });
  };
  const local83 = build83(true);
  assert.equal(local83.sourcesFreshness.invoices.stale || local83.sourcesFreshness.movements.stale || local83.sourcesFreshness.balances.stale, false,
    "test 83: كل المصادر حديثة");
  assert.equal(local83.window.referenceDate, d(0), "test 83: يوم المرجع = report_date المحلي");
  const c83 = local83.customers.find((c) => c.customerGuid === today83.guid);
  assert.notEqual(c83.autoCredit.status, "inactive", "test 83: مشترٍ اليوم لا يُحكم «غير نشط»");
  assert.notEqual(c83.creditStatus, "inactive_no_limit");
  assert.equal(c83.autoCredit.salesRecent, 900, "test 83: سحب اليوم داخل النافذة");
  // بلا report_date (تقارير قديمة) يبقى الاحتياط تاريخ syncedAt كما كان.
  assert.equal(build83(false).window.referenceDate, d(1), "test 83: بلا report_date الاحتياط syncedAt");

  // 84) Codex P1 / قرار المالك — المصادر الثلاثة على يوم المحاسبة المحلي نفسه (report_date، تعريف 8d33476).
  //     الساعة 00:30 بتوقيت دمشق (21:30Z): الفواتير مزامنة 23:50 وreport_date أمس، والحركات
  //     والأرصدة بعد منتصف الليل وreport_date اليوم، وكلها ضمن مهل الحداثة ⇒ لا حد آلي ولا
  //     «غير نشط» ولا تعثّر ولا تجاوز. وحين تتحدث الفواتير لليوم نفسه يعود المحرك طبيعياً.
  const localIso = (hh, mm, dayOffset = 0) => new Date(REF_DAY + dayOffset * 86400000 + ((hh - 3) * 60 + mm) * 60000).toISOString(); // دمشق = UTC+3
  const now84 = new Date(localIso(0, 30));
  const at84 = (report, iso, day) => ({ ...report, created_at: iso, report_date: day, summary: { ...report.summary, syncedAt: iso } });
  const build84 = (invoiceIso, invoiceDay) => engine.build({
    ...reports,
    invoicesReport: at84(reports.invoicesReport, invoiceIso, invoiceDay),
    movementsReport: at84(reports.movementsReport, localIso(0, 20), d(0)),
    balancesReport: at84(reports.balancesReport, localIso(0, 25), d(0)),
    now: now84
  });
  const midnight = build84(localIso(23, 50, -1), d(1));
  assert.deepEqual(Object.values(midnight.sourcesFreshness).map((f) => f.stale), [false, false, false], "test 84: كل المصادر ضمن مهلة الحداثة");
  assert.equal(midnight.dataAvailability.accountingDayAligned, false, "test 84: يوم المحاسبة غير متطابق");
  assert.deepEqual(midnight.dataAvailability.accountingDays, { invoices: d(1), movements: d(0), balances: d(0) });
  const byGuid84 = new Map(midnight.customers.map((c) => [c.customerGuid, c]));
  let gated84 = 0;
  for (const fresh of rc.customers) {
    if (fresh.isSupplier || !fresh.customerGuid) continue;
    const c = byGuid84.get(fresh.customerGuid);
    if (fresh.creditStatus === "not_customer") { assert.equal(c.creditStatus, "not_customer", "test 84: التصنيف المؤكد يبقى"); continue; }
    if (fresh.creditStatus === "needs_review") {
      // شذوذ الدفتر السلوكي يقارن الدفتر بالفواتير؛ عبر يومين لا يُحكم به، ويبقى مغلقاً بلا حد.
      assert.ok(["needs_review", "accounting_day_mismatch"].includes(c.creditStatus), "test 84: المراجعة لا تنفتح");
      assert.equal(c.creditLimit, null); continue;
    }
    if (c.creditLimitSource === "ameen") continue;
    assert.ok(!["delinquent", "over_limit", "near_limit", "normal", "inactive_no_limit", "prepaid"].includes(c.creditStatus),
      `test 84: لا حكم ائتمان عبر يومين (${fresh.customerGuid}: ${c.creditStatus})`);
    assert.equal(c.creditLimit, null);
    assert.equal(c.creditUsagePercent, null);
    if (c.creditStatus === "accounting_day_mismatch") {
      gated84 += 1;
      assert.equal(c.creditLimitSource, "day_mismatch");
      assert.ok(c.explanation.some((reason) => reason.includes("يوم المحاسبة")), "test 84: السبب ظاهر");
    }
  }
  assert.ok(gated84 >= 5, "test 84: حسابات عادية ومتعثرة كلها مغلقة");
  assert.equal(midnight.summary.delinquentCreditCount, 0, "test 84: لا متعثّر");
  assert.notEqual(byGuid84.get(G_NEW).creditStatus, "inactive_no_limit", "test 84: المشتري حديثاً لا يصبح «غير نشط»");
  for (const [guid, status] of [[engine.CONFIG.autoCredit.excludedAccountGuids[0], "not_customer"], [engine.CONFIG.autoCredit.reviewAccountGuids[0], "needs_review"]]) {
    const listed = engine.build({ ...reports, now: now84,
      invoicesReport: at84(reports.invoicesReport, localIso(23, 50, -1), d(1)), movementsReport: at84(reports.movementsReport, localIso(0, 20), d(0)),
      balancesReport: at84({ ...reports.balancesReport, items: [...reports.balancesReport.items, { ...reports.balancesReport.items[0], key: "مدرج", name: "مدرج", balance: 900, balanceAccountCcy: 900, creditLimit: 0, customerGuid: guid, customerAccountGuid: guid }] }, localIso(0, 25), d(0)) })
      .customers.find((c) => c.customerGuid === guid);
    assert.equal(listed.creditStatus, status, `test 84: قائمة المالك تبقى (${status})`);
  }
  // الفواتير تتحدث لليوم نفسه ⇒ المحرك يعمل.
  const aligned84 = build84(localIso(0, 28), d(0));
  assert.equal(aligned84.dataAvailability.accountingDayAligned, true, "test 84: يوم المحاسبة متطابق");
  const steady84 = aligned84.customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(steady84.creditLimitSource, "auto", "test 84: بيوم متطابق يعود الحد الآلي");
  assert.ok(steady84.creditLimit > 0);
  assert.ok(aligned84.customers.every((c) => c.creditStatus !== "accounting_day_mismatch"));
  // يوم مجهول لأي مصدر (بلا report_date) لا يُفترض تطابقه.
  const { report_date: _noDay, ...invoicesNoDay } = at84(reports.invoicesReport, localIso(0, 28), d(0));
  const unknownDay84 = engine.build({ ...reports, now: now84, invoicesReport: invoicesNoDay,
    movementsReport: at84(reports.movementsReport, localIso(0, 20), d(0)), balancesReport: at84(reports.balancesReport, localIso(0, 25), d(0)) });
  assert.equal(unknownDay84.dataAvailability.accountingDayAligned, false, "test 84: يوم غير معروف ⇒ غير متطابق");
  assert.equal(unknownDay84.customers.find((c) => c.customerGuid === G_STEADY).creditStatus, "accounting_day_mismatch");

  // 85) Codex P1 / قرار المالك — حد الأمين لحساب بعملة غير الأساس مع فواتير غير حديثة أو على يوم
  //     آخر: معدّل التحويل من تلك الفواتير، فالحد يُعرض بمصدره «ameen» بلا نسبة استخدام ولا تجاوز.
  //     حساب الأساس (دولار) بحد الأمين لا يحتاج معدّلاً فيبقى حكمه كما كان.
  const withAmeenLimit = (report, limits) => ({ ...report, items: report.items.map((item) => (item.customerGuid in limits ? { ...item, creditLimit: limits[item.customerGuid] } : item)) });
  const limits85 = { [G_SYP]: 100, [G_STEADY]: 100 };   // رصيد كل منهما أكبر بكثير من 100$ ⇒ «تجاوز» لو حُسب
  const cases85 = [
    ["فواتير غير حديثة", "stale_invoices", engine.build({ ...reports, balancesReport: withAmeenLimit(reports.balancesReport, limits85),
      invoicesReport: { ...reports.invoicesReport, created_at: staleIso, summary: { ...reports.invoicesReport.summary, syncedAt: staleIso } } })],
    ["يوم محاسبي آخر", "accounting_day_mismatch", engine.build({ ...reports, now: now84,
      invoicesReport: at84(reports.invoicesReport, localIso(23, 50, -1), d(1)), movementsReport: at84(reports.movementsReport, localIso(0, 20), d(0)),
      balancesReport: at84(withAmeenLimit(reports.balancesReport, limits85), localIso(0, 25), d(0)) })]
  ];
  for (const [label, status, built] of cases85) {
    const syp85 = built.customers.find((c) => c.customerGuid === G_SYP);
    assert.equal(syp85.creditLimitSource, "ameen", `test 85 (${label}): حد الأمين بمصدره`);
    assert.equal(syp85.creditLimit, 100, `test 85 (${label}): قيمة الحد تُعرض`);
    assert.equal(syp85.creditUsagePercent, null, `test 85 (${label}): لا نسبة استخدام بمعدّل قديم`);
    assert.equal(syp85.creditStatus, status, `test 85 (${label}): لا حكم تجاوز`);
    assert.ok(syp85.explanation.some((reason) => reason.includes("معدّل تحويله")), `test 85 (${label}): السبب ظاهر`);
    const usd85 = built.customers.find((c) => c.customerGuid === G_STEADY);
    assert.equal(usd85.creditLimitSource, "ameen");
    assert.equal(usd85.creditStatus, "over_limit", `test 85 (${label}): حساب الدولار بحد الأمين يبقى حكمه`);
  }

  // 86) Codex P1 / قرار المالك — حساب بعملة غير الأساس بلا أي معدّل في لقطة الفواتير كلها: لا
  //     يُعامَل كحساب دولار برصيد فيه فروقات صرف. الرصيد بعملته، بلا حد آلي ولا استخدام ولا تجاوز.
  const noRateInvoices = { ...reports.invoicesReport, items: reports.invoicesReport.items.map((group) => ({
    ...group, invoices: group.invoices.map(({ currency, currencyVal, ...rest }) => rest) })) };
  const rc86 = engine.build({ ...reports, invoicesReport: noRateInvoices });
  const syp86 = rc86.customers.find((c) => c.customerGuid === G_SYP);
  assert.equal(syp86.creditStatus, "missing_rate", "test 86: لا حكم بلا معدّل");
  assert.equal(syp86.creditUsagePercent, null, "test 86: لا نسبة استخدام بلا معدّل");
  assert.equal(syp86.creditLimit, null, "test 86: لا حد آلي بعملة الأساس لحساب ليرة");
  assert.equal(syp86.creditLimitSource, "missing_rate");
  assert.equal(syp86.balanceDisplay, 9800000, "test 86: الرصيد بعملة الحساب لا بالدولار المشوّه");
  assert.notEqual(syp86.balanceCurrency, "USD", "test 86: عملة الرصيد عملة الحساب المعلنة");
  assert.ok(syp86.explanation.some((reason) => reason.includes("سعر صرف")), "test 86: السبب ظاهر");
  assert.equal(rc86.customers.find((c) => c.customerGuid === G_STEADY).creditStatus, row(G_STEADY).creditStatus, "test 86: حساب الدولار لا يتأثر");

  // 87) قرار المالك (2026-09-27، Codex P1، الخيار A) — مطابقة الرصيد: دين متأخر مادّي في الدفتر
  //     لا يصنع «متعثّراً» إن كان الرصيد الحالي الموثوق لا يدعمه (دفعة فاتت لقطة الدفتر). حد
  //     الأهمية نفسه (50). الرصيد المادّي يُبقي الحكم كما كان، ولا تتحسّن الدفعات بالمطابقة.
  const build87 = (balance) => {
    const a = { guid: gid(87), name: "مطابقة الرصيد", movements: [debit(80, 3000), pay(75, 100)] };
    return engine.build({
      ...reports,
      invoicesReport: invoicesReportFor([a]),
      balancesReport: { ...reports.balancesReport, items: [{ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name,
        balance, balanceAccountCcy: balance, creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid }] },
      movementsReport: { ...reports.movementsReport, items: [{ customerGuid: a.guid, name: a.name, truncated: false, movements: a.movements }] },
      creditLimits: []
    }).customers.find((c) => c.customerGuid === a.guid);
  };
  const settled87 = build87(0.03);
  assert.ok(settled87.autoCredit.overdueAmount >= 2900, "test 87: الدفتر ما زال يرى ديناً متأخراً مادّياً");
  assert.equal(settled87.autoCredit.balanceSupportedOverdue, 0.03, "test 87: الرصيد الحالي لا يدعم منه إلا 0.03");
  assert.notEqual(settled87.creditStatus, "delinquent", "test 87: رصيد ≈ 0.03 ⇒ ليس متعثّراً");
  assert.notEqual(settled87.autoCredit.status, "delinquent");
  const small87 = build87(49);
  assert.notEqual(small87.creditStatus, "delinquent", "test 87: رصيد دون حد الأهمية لا يصنع تعثّراً");
  const material87 = build87(2900);
  assert.equal(material87.creditStatus, "delinquent", "test 87: رصيد يدعم الدين المادّي ⇒ متعثّر كما كان");
  assert.equal(material87.autoCredit.balanceSupportedOverdue, 2900);
  // المطابقة لا تصنع دفعات ولا تحسّن الجودة: مقاييس السداد نفسها في الحالتين.
  for (const key of ["paidInOverdueSpan", "punctuality", "coverage", "daysSinceLastPayment"]) {
    if (settled87.autoCredit[key] !== undefined && key !== "coverage") assert.equal(settled87.autoCredit[key], material87.autoCredit[key], `test 87: ${key} لا يتغير بالمطابقة`);
  }
  const partial87 = build87(400);
  assert.equal(partial87.creditStatus, "delinquent", "test 87: رصيد 400 ما زال يدعم ديناً مادّياً ⇒ الحكم كما كان");

  // 88) Codex P1 — حد الأمين لحساب بعملة غير الأساس مع اختلاف يوم المحاسبة، ومنتج الحركات الحالي
  //     غير الموسوم (بلا lineKinds:v1): معدّل التحويل من فواتير الأمس، فلا نسبة استخدام ولا تجاوز.
  const untyped88 = engine.build({ ...reports, now: now84, untyped: true,
    invoicesReport: at84(reports.invoicesReport, localIso(23, 50, -1), d(1)), movementsReport: at84(reports.movementsReport, localIso(0, 20), d(0)),
    balancesReport: at84(withAmeenLimit(reports.balancesReport, limits85), localIso(0, 25), d(0)) });
  const syp88 = untyped88.customers.find((c) => c.customerGuid === G_SYP);
  assert.equal(syp88.creditLimitSource, "ameen", "test 88: حد الأمين بمصدره");
  assert.equal(syp88.creditUsagePercent, null, "test 88: لا نسبة استخدام بمعدّل يوم آخر بلا v1");
  assert.equal(syp88.creditStatus, "accounting_day_mismatch", "test 88: لا حكم تجاوز");
  const usd88 = untyped88.customers.find((c) => c.customerGuid === G_STEADY);
  assert.equal(usd88.creditStatus, "over_limit", "test 88: حساب الدولار بحد الأمين لا يحتاج معدّلاً");
  const aligned88 = engine.build({ ...reports, untyped: true, balancesReport: withAmeenLimit(reports.balancesReport, limits85) })
    .customers.find((c) => c.customerGuid === G_SYP);
  assert.equal(aligned88.creditStatus, "over_limit", "test 88: الأيام متطابقة بلا v1 = حكم حد الأمين كما كان");

  // 89–91) قرارات المالك (2026-09-28) تحت lineKinds:v1: الدور المختلط، تحصيل الدين القديم،
  //         وتصنيف الحساب من شجرة دليل الحسابات. لا تغيير في الصيغة ولا Q ولا T ولا النافذة.
  const build89 = (list, { classes = false } = {}) => {
    const all = [...portfolio77.map((a) => ({ ...a, accountClass: "customer" })), ...list.map((c) => ({ ...c, guid: gid(c.id) }))];
    return engine.build({
      now: NOW,
      invoicesReport: invoicesReportFor(all.map((a) => ({ ...a }))),
      balancesReport: { ...reports.balancesReport, summary: { ...reports.balancesReport.summary, ...(classes ? { accountClasses: "v1" } : {}) },
        items: all.map((a) => ({ ...reports.balancesReport.items[0], key: engine.normalizeName(a.name), name: a.name,
          balance: a.balance ?? ((a.openingBalance ?? 0) + ledgerBalance(a.movements)), balanceAccountCcy: a.balance ?? ((a.openingBalance ?? 0) + ledgerBalance(a.movements)),
          creditLimit: 0, customerGuid: a.guid, customerAccountGuid: a.guid, isSupplier: a.isSupplier === true,
          ...(classes && a.accountClass !== undefined ? { accountClass: a.accountClass } : {}) })) },
      movementsReport: { ...reports.movementsReport, summary: { ...reports.movementsReport.summary, lineKinds: "v1" },
        items: all.filter((a) => a.movements.length || a.openingBalance).map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false,
          openingBalance: a.openingBalance ?? 0, movements: a.movements })) },
      creditLimits: []
    });
  };
  const at89 = (built, id) => built.customers.find((c) => c.customerGuid === gid(id));

  // 89) الدور المختلط: مشتريات ≥ 50 و≥ 5% من (المشتريات + المبيعات).
  const jasemSales = [debit(50, 3000), debit(40, 3000), debit(30, 3000), debit(20, 3000)].map((m) => tag(m, "sale"));
  const jasemPays = [pay(45, 2500), pay(35, 2500), pay(25, 2500), pay(15, 2500)].map((m) => tag(m, "payment"));
  const jasemPurchases = [pay(38, 1500), pay(28, 1200)].map((m) => tag(m, "purchase"));   // 2700 ÷ 14700 = 18.4%
  const mixed89 = [
    { id: 121, name: "شاهد ابو جاسم", accountClass: "customer", movements: [...jasemSales, ...jasemPays, ...jasemPurchases].sort((a, b) => a.date.localeCompare(b.date)) },
    { id: 122, name: "شاهد البيارق", accountClass: "customer", movements: [tag(debit(80, 3000), "sale"), tag(pay(60, 2068), "purchase")] },
    { id: 123, name: "شاهد الخيال", accountClass: "customer",
      movements: [...regular({ from: 58, every: 6, amount: 3000, lag: 4 }).map((m) => tag(m, m.credit > 0 ? "payment" : "sale")), tag(pay(20, 1000), "purchase")] },
    { id: 124, name: "مشتريات دون حد الأهمية", accountClass: "customer", movements: [tag(debit(30, 300), "sale"), tag(pay(20, 40), "purchase")] }
  ];
  const rc89 = build89(mixed89);
  const jasem = at89(rc89, 121);
  assert.equal(jasem.autoCredit.status, "needs_review", "test 89: ابو جاسم ⇒ دور مختلط يحتاج مراجعة");
  assert.equal(jasem.autoCredit.mixedRole, true);
  assert.equal(jasem.creditLimit, null, "test 89: ابو جاسم بلا حد آلي");
  assert.ok(jasem.flags.includes("credit_mixed_role"), "test 89: وسم الدور المختلط");
  assert.ok(jasem.explanation.some((reason) => reason.includes("دور مختلط")), "test 89: السبب ظاهر");
  const jasemNoPurchases = at89(build89([{ ...mixed89[0], movements: [...jasemSales, ...jasemPays].sort((a, b) => a.date.localeCompare(b.date)) }]), 121);
  assert.ok(jasemNoPurchases.creditLimit > 0, "test 89: الضبط — الدفتر نفسه بلا مشتريات ينال حداً آلياً (سقط بالمختلط)");
  const bayareq = at89(rc89, 122);
  assert.equal(bayareq.creditStatus, "delinquent", "test 89: البيارق ⇒ التعثّر الحقيقي يبقى ظاهراً");
  assert.ok(bayareq.flags.includes("credit_delinquent") && bayareq.flags.includes("credit_mixed_role"), "test 89: البيارق ⇒ MIXED_ROLE + DELINQUENT معاً");
  assert.equal(bayareq.autoCredit.mixedRole, true);
  const khayal = at89(rc89, 123);
  assert.ok(!khayal.flags.includes("credit_mixed_role"), "test 89: الخيال (3.x%) ليس دوراً مختلطاً");
  assert.notEqual(khayal.autoCredit.status, "needs_review");
  assert.ok(!at89(rc89, 124).flags.includes("credit_mixed_role"), "test 89: مشتريات 40 < 50 ليست مادية");
  assert.equal(rc89.summary.mixedRoleCreditCount, 2, "test 89: عدّاد الدور المختلط (ابو جاسم + البيارق)");
  assert.deepEqual(rc89.dataAvailability.creditCycle, build89(mixed89.filter((c) => ![121, 122].includes(c.id))).dataAvailability.creditCycle,
    "test 89: المختلط خارج معايرة المحفظة");

  // 90) تحصيل الدين القديم: ≥ 80% دين قديم، ≥ دفعتا قبض حقيقيتان في 60 يوماً، آخرهما ≤ 30 يوماً.
  const nazirMoves = [tag(debit(55, 230), "debt_transfer"), tag(debit(52, 53), "sale"),
    ...[45, 38, 31].map((n) => tag(pay(n, 40), "payment")), ...[17, 10, 4].map((n) => tag(pay(n, 80), "payment"))].sort((a, b) => a.date.localeCompare(b.date));
  const old90 = [
    { id: 131, name: "شاهد ابو نزير", accountClass: "customer", openingBalance: 400, movements: nazirMoves },
    { id: 132, name: "شاهد غيث", accountClass: "customer", openingBalance: 2153, movements: [tag(pay(56, 253), "payment"), tag(pay(25, 200), "payment")] },
    { id: 133, name: "دين قديم بلا سداد منتظم", accountClass: "customer", openingBalance: 900, movements: [tag(pay(50, 100), "payment")] },
    { id: 134, name: "مبيعات حديثة غالبة", accountClass: "customer", openingBalance: 100,
      movements: [tag(debit(20, 900), "sale"), tag(pay(15, 50), "payment"), tag(pay(5, 50), "payment")] }
  ];
  const rc90 = build89(old90);
  const nazir = at89(rc90, 131);
  assert.ok(nazir.autoCredit.oldDebtCollection, "test 90: ابو نزير ⇒ تحصيل دين قديم");
  assert.equal(nazir.creditStatus, "old_debt_collection", "test 90: ابو نزير لا «تجاوز حد» مضلل");
  assert.equal(nazir.creditUsagePercent, null, "test 90: بلا نسبة استخدام مضللة");
  assert.equal(nazir.currentBalance, 323, "test 90: الرصيد لا يُمسّ ولا يُعتبر مسدداً");
  assert.ok(nazir.flags.includes("old_debt_collection") && !nazir.flags.includes("over_credit_limit"));
  assert.ok(nazir.explanation.some((reason) => reason.includes("تحصيل دين قديم")), "test 90: السبب ظاهر");
  // الوسم وصفي: الحالة الآلية وحدها كما حسبتها الصيغة (لا تحسين لـQ ولا الدورة ولا الحد).
  assert.ok(["normal", "low_data"].includes(nazir.autoCredit.status), "test 90: الحالة الآلية لا تتغير بالوسم");
  assert.ok(nazir.creditLimit !== null && nazir.creditLimit < nazir.currentBalance, "test 90: الحد المبني على مبيعات حديثة صغيرة أقل من الدين القديم");
  const ghaith = at89(rc90, 132);
  assert.equal(ghaith.creditStatus, "delinquent", "test 90: غيث يبقى متعثّراً إن تحققت شروطه");
  assert.ok(ghaith.flags.includes("old_debt_collection") && ghaith.flags.includes("credit_delinquent"), "test 90: غيث ⇒ DELINQUENT + تحصيل دين قديم");
  assert.ok(!ghaith.flags.includes("credit_not_customer") && !ghaith.flags.includes("credit_mixed_role"), "test 90: غيث زبون لا غير");
  assert.ok(!at89(rc90, 133).autoCredit.oldDebtCollection, "test 90: دفعة واحدة ليست سداداً منتظماً");
  assert.ok(!at89(rc90, 134).autoCredit.oldDebtCollection, "test 90: الرصيد من مبيعات حديثة ليس ديناً قديماً");
  assert.equal(rc90.summary.oldDebtCollectionCount, 2, "test 90: عدّاد تحصيل الدين القديم");

  // 91) تصنيف الحساب من شجرة الدليل (accountClasses:v1). بلا العلامة لا شيء يتغير.
  const tree91 = [
    { id: 141, name: "شاهد طابعة ليزرية", accountClass: "asset", openingBalance: 125, movements: [] },
    { id: 142, name: "سلفة موظف", accountClass: "employee", openingBalance: 300, movements: [] },
    { id: 143, name: "مسار غامض", accountClass: "other", movements: [tag(debit(30, 500), "sale")] },
    { id: 144, name: "بلا تصنيف مع العلامة", movements: [tag(debit(30, 500), "sale")] },
    { id: 145, name: "مورد بالشجرة", accountClass: "supplier", movements: [tag(pay(20, 900), "purchase")] },
    { id: 146, name: "مورد بالاسم", accountClass: "supplier", isSupplier: true, movements: [tag(pay(20, 900), "purchase")] },
    { id: 147, name: "زبون بالشجرة", accountClass: "customer", movements: [tag(debit(30, 500), "sale"), tag(pay(20, 500), "payment")] }
  ];
  const rc91 = build89(tree91, { classes: true });
  const legacy91 = build89(tree91, { classes: false });
  assert.equal(rc91.dataAvailability.accountClassesTrusted, true);
  assert.equal(legacy91.dataAvailability.accountClassesTrusted, false);
  const printer = at89(rc91, 141);
  assert.equal(printer.creditStatus, "not_customer", "test 91: الطابعة ⇒ ليس زبوناً من مسارها");
  assert.ok(printer.autoCredit.notes[0].includes("موجودات"), "test 91: السبب من الشجرة لا الاسم");
  assert.notEqual(at89(legacy91, 141).creditStatus, "not_customer", "test 91: بلا العلامة لا إعادة تصنيف (السلوك الحالي، لا كسر للإنتاج)");
  assert.equal(at89(rc91, 142).creditStatus, "not_customer", "test 91: سلفة الموظف ليست زبوناً");
  assert.equal(at89(rc91, 143).creditStatus, "needs_review", "test 91: مسار غامض ⇒ يحتاج مراجعة لا تخمين");
  assert.equal(at89(rc91, 144).creditStatus, "needs_review", "test 91: تصنيف غائب مع العلامة ⇒ يحتاج مراجعة");
  assert.notEqual(at89(legacy91, 144).creditStatus, "needs_review", "test 91: وبلا العلامة لا مراجعة");
  for (const id of [145, 146]) {
    const supplier = at89(rc91, id);
    assert.equal(supplier.autoCredit, null, `test 91: المورد (${id}) لا يُعامل زبوناً ولا حد له`);
    assert.ok(!supplier.flags.includes("credit_not_customer") && !supplier.flags.includes("credit_needs_review"), `test 91: المورد (${id}) لا يُعاد تصنيفه`);
  }
  const cust147 = at89(rc91, 147);
  const cust147Legacy = at89(legacy91, 147);
  assert.equal(cust147.creditStatus, cust147Legacy.creditStatus, "test 91: الزبون بالشجرة كما هو");
  assert.equal(cust147.creditLimit, cust147Legacy.creditLimit);
  // المشتريات والحسم ليست دفعة زبون (عقد 77): تبقى كذلك مع هذه القواعد.
  assert.equal(rc77.customers.find((c) => c.customerGuid === gid(92)).autoCredit.paidInOverdueSpan, 0, "test 91: purchase ليس دفعة زبون");
  assert.equal(rc77.customers.find((c) => c.customerGuid === gid(91)).autoCredit.paidInOverdueSpan, 0, "test 91: discount ليس دفعة زبون");

  // 92) تعريف واحد للمورد (ملاحظة Codex P1): مع accountClasses:v1 صنف الشجرة هو المصدر في كل
  //     المحرك (الفوج، المعايرة، الحقل isSupplier، العدّادات)؛ بلا العلامة isSupplier القديم كما هو.
  const trade92 = () => regular({ from: 58, every: 6, amount: 3000, lag: 4 }).map((m) => tag(m, m.credit > 0 ? "payment" : "sale"));
  const sup92 = [
    { id: 151, name: "مورد بالشجرة وعلامته القديمة false", accountClass: "supplier", isSupplier: false, movements: trade92() },
    { id: 152, name: "مورد بالشجرة والعلامة", accountClass: "supplier", isSupplier: true, movements: trade92() },
    { id: 153, name: "زبون بالشجرة وعلامته القديمة مورد", accountClass: "customer", isSupplier: true, movements: trade92() }
  ];
  const rc92 = build89(sup92, { classes: true });
  const legacy92 = build89(sup92, { classes: false });
  const base92 = build89([], { classes: true });
  const treeSupplier = at89(rc92, 151);
  assert.equal(treeSupplier.isSupplier, true, "test 92: الشجرة supplier + isSupplier=false ⇒ مورد");
  assert.equal(treeSupplier.autoCredit, null, "test 92: المورد بالشجرة بلا حد آلي");
  assert.ok(treeSupplier.flags.includes("supplier_account"), "test 92: وسم المورد من الشجرة");
  assert.equal(at89(rc92, 152).isSupplier, true, "test 92: supplier + isSupplier=true يبقى مورداً");
  const treeCustomer = at89(rc92, 153);
  assert.equal(treeCustomer.isSupplier, false, "test 92: الشجرة customer تسبق العلامة القديمة المتعارضة");
  assert.ok(treeCustomer.autoCredit, "test 92: الزبون بالشجرة يُحسب له الائتمان");
  assert.equal(rc92.summary.totalCustomers, base92.summary.totalCustomers + 1, "test 92: المورد بالشجرة خارج عدّادات الزبائن");
  assert.deepEqual(rc92.dataAvailability.creditCycle, build89([sup92[2]], { classes: true }).dataAvailability.creditCycle,
    "test 92: المورد بالشجرة خارج معايرة المحفظة");
  // بلا العلامة: السلوك القديم حرفياً (العلامة القديمة وحدها).
  assert.equal(at89(legacy92, 151).isSupplier, false, "test 92: بلا v1 لا يُقرأ الصنف");
  assert.ok(at89(legacy92, 151).autoCredit, "test 92: بلا v1 يبقى زبوناً كما في الإنتاج");
  assert.equal(at89(legacy92, 152).isSupplier, true);
  assert.equal(at89(legacy92, 153).isSupplier, true, "test 92: بلا v1 العلامة القديمة وحدها");

  // 66) عدّادات الملخص؛ وتنبيه الحد يبقى مسودة داخلية: لا مسار تيليغرام في هذه المرحلة.
  assert.ok(rc.summary.delinquentCreditCount >= 2 && rc.summary.inactiveCreditCount >= 2 && rc.summary.lowDataCreditCount >= 1);
  assert.equal(rc.summary.nonCustomerCreditCount, 0, "test 66: لا «ليس زبوناً» بالسلوك");
  assert.equal(rc.summary.needsReviewCreditCount, 1, "test 66: الشذوذ يُعدّ «يحتاج مراجعة» منفصلاً");
}

// ---------------------------------------------------------------------------
// 93–107) تاريخ الحد (STEP 2): التنعيم الأسبوعي، تفسير التغيير، اتجاه الخطر، وصفوف اللقطة.
// كل الأرقام تركيبية. يوم المرجع 2026-09-02، وd(n) = قبله بـn يوماً.
// ---------------------------------------------------------------------------
{
  const REF_DAY = Date.UTC(2026, 8, 2);
  const d = (n) => new Date(REF_DAY - n * 86400000).toISOString().slice(0, 10);
  const debit = (n, amount) => ({ date: d(n), debit: amount, credit: 0, notes: "", billGuid: "" });
  const pay = (n, amount) => ({ date: d(n), debit: 0, credit: amount, notes: "", billGuid: "" });
  const gid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
  const regular = ({ from, to = 1, every, amount, lag }) => {
    const rows = [];
    for (let n = from; n >= to; n -= every) {
      rows.push(debit(n, amount));
      if (lag !== null && n - lag >= 0) rows.push(pay(n - lag, amount));
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  };
  const accounts = [
    { guid: gid(1), name: "تاريخ منتظم", movements: regular({ from: 59, every: 6, amount: 600, lag: 6 }) },
    { guid: gid(2), name: "تاريخ منتظم ثانٍ", movements: regular({ from: 58, every: 5, amount: 500, lag: 5 }) },
    { guid: gid(3), name: "تاريخ متعثّر", movements: [debit(85, 1500), debit(80, 1500), pay(75, 200), debit(10, 300)] },
    { guid: gid(4), name: "تاريخ بطيء", movements: regular({ from: 59, every: 5, amount: 400, lag: 40 }) },
    { guid: gid(5), name: "تاريخ منتظم ثالث", movements: regular({ from: 57, every: 4, amount: 300, lag: 3 }) },
    { guid: gid(6), name: "تاريخ مورد", movements: regular({ from: 57, every: 4, amount: 300, lag: 3 }), isSupplier: true }
  ].map((a) => ({ ...a, balance: a.movements.reduce((sum, m) => sum + m.debit - m.credit, 0) }));
  const [G_STEADY, G_STEADY2, G_DELINQ, , , G_SUPPLIER] = accounts.map((a) => a.guid);
  const reports = {
    invoicesReport: {
      source: "ameen_customer_invoices", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, customers: accounts.length, syncedAt: REFERENCE_ISO },
      items: accounts.map((a) => ({
        name: a.name, customerGuid: a.guid, truncated: false,
        invoices: a.movements.filter((m) => m.debit > 0 && m.date >= FROM_DATE).map((m, i) => invoice(m.date, m.debit, { guid: `hist-${a.guid}-${i}` }))
      }))
    },
    balancesReport: {
      source: "ameen_customer_balances", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { source: "ameen_customer_balances", syncedAt: REFERENCE_ISO, totalCustomers: accounts.length },
      items: accounts.map((a) => ({
        key: engine.normalizeName(a.name), name: a.name, balance: a.balance, creditLimit: 0, remainingLimit: 0, status: "clear",
        customerGuid: a.guid, customerAccountGuid: a.guid, isSupplier: a.isSupplier === true, recentPayments: [], recentMovements: [],
        accountCurrencyIsBase: true, accountCurrency: "$", balanceAccountCcy: a.balance
      }))
    },
    movementsReport: {
      source: "ameen_customer_movements", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { syncedAt: REFERENCE_ISO, periodDays: 92 },
      items: accounts.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false, movements: a.movements }))
    },
    creditLimits: [],
    now: NOW
  };
  const at = (result, guid) => {
    const found = result.customers.find((entry) => entry.customerGuid === guid);
    assert.ok(found, `سجل التاريخ مفقود: ${guid}`);
    return found;
  };
  // صف لقطة سابقة كما يقرؤه المالك من customer_credit_history (snake_case).
  const snap = (guid, daysAgo, fields = {}) => ({
    customer_guid: guid, snapshot_date: d(daysAgo), auto_status: "normal", credit_status: "normal",
    limit_base: 1000, credit_limit_display: 1000, credit_currency: "USD", risk_score: 0, factors: {}, ...fields
  });
  const withHistory = (creditHistory) => engine.build({ ...reports, creditHistory });

  // 93) بلا تاريخ = STEP 1 حرفياً؛ تاريخ فارغ = الحد نفسه بلا تنعيم ولا تفسير ولا اتجاه.
  const plain = engine.build(reports);
  const empty = withHistory([]);
  const steadyPlain = at(plain, G_STEADY);
  const raw = steadyPlain.autoCredit.limitBase;
  assert.equal(steadyPlain.autoCredit.status, "normal", "test 93: التركيبة تحتاج حداً رقمياً");
  assert.ok(raw > 0, "test 93: حد محسوب موجب");
  assert.ok(plain.customers.every((row) => row.creditHistory === null), "test 93: بلا مدخل تاريخ لا حقل تاريخ");
  assert.equal(steadyPlain.autoCredit.smoothing, undefined, "test 93: بلا تاريخ لا تنعيم");
  for (const row of plain.customers) {
    const twin = at(empty, row.customerGuid);
    assert.equal(twin.creditLimit, row.creditLimit, `test 93: تاريخ فارغ لا يغيّر الحد (${row.customerName})`);
    assert.equal(twin.creditStatus, row.creditStatus, "test 93: ولا الحالة");
    assert.equal(twin.riskScore, row.riskScore, "test 93: ولا درجة الخطر");
  }
  const steadyEmpty = at(empty, G_STEADY);
  assert.deepEqual({ ...steadyEmpty.autoCredit.smoothing }, { applied: false, reason: "no_history" }, "test 93: لا لقطات ⇒ لا أساس");
  assert.equal(steadyEmpty.creditHistory.change, null);
  assert.equal(steadyEmpty.creditHistory.riskTrend, null);
  assert.equal(steadyEmpty.creditHistory.previous, null);

  // 94) التنعيم صعوداً: الحد لا يرتفع أكثر من +25% عن لقطة عمرها أسبوع.
  const up = at(withHistory([snap(G_STEADY, 7, { limit_base: raw / 2, credit_limit_display: engine.commercialRound(raw / 2, "USD") })]), G_STEADY);
  assert.equal(up.autoCredit.smoothing.applied, true, "test 94: التنعيم مطبَّق");
  assert.equal(up.autoCredit.smoothing.reason, "capped_increase");
  assert.ok(Math.abs(up.autoCredit.limitBase - (raw / 2) * 1.25) < 1e-6, "test 94: الحد = الأساس × 1.25");
  assert.equal(up.autoCredit.limitBaseRaw, Math.round(raw * 1000) / 1000, "test 94: الحد المحسوب محفوظ كما هو");
  assert.equal(up.creditLimit, engine.commercialRound((raw / 2) * 1.25, "USD"), "test 94: المعروض هو المنعَّم بعد التقريب");
  assert.ok(up.flags.includes("credit_smoothed"), "test 94: وسم التنعيم");
  assert.equal(up.creditHistory.change.kind, "limit");
  assert.equal(up.creditHistory.change.direction, "up");
  assert.ok(up.creditHistory.change.text.startsWith("ارتفع الحد من "), "test 94: نص الارتفاع");
  assert.match(up.creditHistory.change.text, /التنعيم الأسبوعي/u, "test 94: التفسير يذكر حصر التنعيم");

  // 95) التنعيم نزولاً: الحد لا ينزل أكثر من −40% بالأسبوع.
  const down = at(withHistory([snap(G_STEADY, 7, { limit_base: raw * 3, credit_limit_display: engine.commercialRound(raw * 3, "USD") })]), G_STEADY);
  assert.equal(down.autoCredit.smoothing.reason, "capped_decrease", "test 95: حصر النزول");
  assert.ok(Math.abs(down.autoCredit.limitBase - raw * 3 * 0.6) < 1e-6, "test 95: الحد = الأساس × 0.6");
  assert.equal(down.creditLimit, engine.commercialRound(raw * 3 * 0.6, "USD"));
  assert.equal(down.creditHistory.change.direction, "down");
  assert.ok(down.creditHistory.change.text.startsWith("نزل الحد من "), "test 95: نص النزول");

  // 96) ضمن الحدود: لا تغيير.
  const within = at(withHistory([snap(G_STEADY, 7, { limit_base: raw * 1.1 })]), G_STEADY);
  assert.equal(within.autoCredit.smoothing.applied, false);
  assert.equal(within.autoCredit.smoothing.reason, "within_bounds");
  assert.equal(within.creditLimit, steadyPlain.creditLimit, "test 96: ضمن +25%/−40% الحد المحسوب كما هو");
  assert.ok(!within.flags.includes("credit_smoothed"));

  // 97) اختيار الأساس: أحدث لقطة عمرها ≥ 7 أيام؛ وإلا أقدم لقطة. لقطة فجوة بيانات، ولقطة
  //     اليوم أو المستقبل، وما قبل نافذة الـ21 يوماً — لا تدخل.
  const baselineOf = (history) => at(withHistory(history), G_STEADY).autoCredit.smoothing;
  assert.equal(baselineOf([snap(G_STEADY, 3, { limit_base: raw * 0.5 }), snap(G_STEADY, 9, { limit_base: raw })]).baselineDate, d(9),
    "test 97: الأساس أحدث لقطة عمرها ≥ 7 أيام لا الأحدث مطلقاً");
  assert.equal(baselineOf([snap(G_STEADY, 3, { limit_base: raw }), snap(G_STEADY, 5, { limit_base: raw * 0.5 })]).baselineDate, d(5),
    "test 97: بلا لقطة عمرها أسبوع ⇒ أقدم لقطة (حصر أشد)");
  assert.equal(baselineOf([snap(G_STEADY, 8, { limit_base: 1, credit_status: "stale_balance" }), snap(G_STEADY, 10, { limit_base: raw })]).baselineDate, d(10),
    "test 97: لقطة فجوة بيانات لا تصلح أساساً");
  assert.equal(baselineOf([snap(G_STEADY, 8, { limit_base: 1, auto_status: "unavailable" }), snap(G_STEADY, 10, { limit_base: raw })]).baselineDate, d(10),
    "test 97: حالة unavailable ليست أساساً");
  assert.deepEqual({ ...baselineOf([snap(G_STEADY, 0, { limit_base: 1 }), snap(G_STEADY, -1, { limit_base: 1 }), snap(G_STEADY, 30, { limit_base: 1 })]) },
    { applied: false, reason: "no_history" }, "test 97: لقطة اليوم والمستقبل وما قبل 21 يوماً خارج الحساب");
  assert.equal(baselineOf([snap(G_STEADY.toUpperCase(), 7, { limit_base: raw / 2 })]).applied, true, "test 97: المعرّف يُطبَّع قبل الربط");
  assert.deepEqual({ ...baselineOf([snap(G_STEADY2, 7, { limit_base: raw / 2 })]) }, { applied: false, reason: "no_history" },
    "test 97: لقطة زبون آخر لا تمسّ هذا الزبون (الربط بـcustomerGuid وحده)");

  // 98) التعثّر يصفّر الحد فوراً ويتجاوز التنعيم، والتفسير من أرقام التعثّر نفسها.
  const delinquent = at(withHistory([snap(G_DELINQ, 7, { limit_base: 5000, credit_limit_display: 5000 })]), G_DELINQ);
  assert.equal(delinquent.creditStatus, "delinquent", "test 98: متعثّر");
  assert.equal(delinquent.creditLimit, 0, "test 98: الحد صفر رغم أساس 5,000");
  assert.equal(delinquent.autoCredit.smoothing, undefined, "test 98: التعثّر لا يمرّ بالتنعيم");
  assert.equal(delinquent.creditHistory.change.kind, "status");
  assert.equal(delinquent.creditHistory.change.direction, "down");
  assert.ok(delinquent.creditHistory.change.text.startsWith("صار متعثّراً، فنزل الحد من 5,000$ إلى 0$"), `test 98: ${delinquent.creditHistory.change.text}`);
  assert.ok(delinquent.creditHistory.change.text.includes(`${Math.round(delinquent.autoCredit.overdueAmount).toLocaleString("en-US")}$`),
    "test 98: قيمة الدين المتأخر من المحرك");

  // 99) أساس غير رقمي (متعثّر الأسبوع الماضي) ⇒ لا تنعيم، والتفسير «خرج من التعثّر».
  const recovered = at(withHistory([snap(G_STEADY, 7, { auto_status: "delinquent", credit_status: "delinquent", limit_base: 0, credit_limit_display: 0, factors: { overdueAmount: 2800 } })]), G_STEADY);
  assert.equal(recovered.autoCredit.smoothing.reason, "no_numeric_baseline", "test 99: لا صعود تدريجي من صفر لا يُكسر");
  assert.equal(recovered.creditLimit, steadyPlain.creditLimit, "test 99: الحد المحسوب كما هو");
  assert.equal(recovered.creditHistory.change.kind, "status");
  assert.match(recovered.creditHistory.change.text, /^خرج من التعثّر فصار الحد .* بدل 0\$: الدين المتأخر صار .* بدل 2,800\$\.$/u, `test 99: ${recovered.creditHistory.change.text}`);

  // 100) تفسير تغيّر الحد: العامل الأكبر في الصيغة (وعامل ثانٍ إن كان معتبراً) بقيمتيه.
  const cur = at(empty, G_STEADY).autoCredit;
  const curFactors = { ...cur, limitBaseRaw: cur.limitBase };
  const higher = steadyPlain.creditLimitDisplay + 500;
  const prevQuality = at(withHistory([snap(G_STEADY, 1, {
    limit_base: raw, credit_limit_display: higher,
    factors: { ...curFactors, punctuality: curFactors.punctuality + 0.4, oldestOpenDays: 2, coverageScore: curFactors.coverageScore + 0.2, coverage: 0.99 }
  })]), G_STEADY).creditHistory.change;
  assert.equal(prevQuality.kind, "limit");
  assert.deepEqual([...prevQuality.factors], ["punctuality", "coverage"], "test 100: الانضباط أولاً ثم التغطية");
  assert.ok(prevQuality.text.startsWith(`نزل الحد من ${higher.toLocaleString("en-US")}$ إلى ${steadyPlain.creditLimitDisplay.toLocaleString("en-US")}$ لأن أقدم دين صار عمره `), `test 100: ${prevQuality.text}`);
  assert.ok(prevQuality.text.includes(`عمره ${curFactors.oldestOpenDays} يوماً بدل 2 يوماً، وتغطية الدفع نزلت من 99% إلى `), `test 100: ${prevQuality.text}`);
  const prevVelocity = at(withHistory([snap(G_STEADY, 1, {
    limit_base: raw, credit_limit_display: higher, factors: { ...curFactors, velocity: curFactors.velocity * 1.5, cycleDays: curFactors.cycleDays }
  })]), G_STEADY).creditHistory.change;
  assert.deepEqual([...prevVelocity.factors], ["velocity"], "test 100: السرعة وحدها حين لا عامل غيرها");
  assert.ok(prevVelocity.text.includes(`متوسط السحب الشهري صار ${Math.round(curFactors.velocity * 30).toLocaleString("en-US")}$ بدل ${Math.round(curFactors.velocity * 45).toLocaleString("en-US")}$`), `test 100: ${prevVelocity.text}`);
  // زوال سقف البيانات القليلة يرفع الحد فيُذكر سبباً للارتفاع، ولا يُذكر سبباً لنزول.
  const lower = steadyPlain.creditLimitDisplay - 100;
  const uncapUp = at(withHistory([snap(G_STEADY, 1, {
    limit_base: raw, credit_limit_display: lower, factors: { ...curFactors, cappedBy: "low_data" }
  })]), G_STEADY).creditHistory.change;
  assert.equal(uncapUp.direction, "up");
  assert.ok(uncapUp.factors.includes("uncap_low_data"), "test 100: زوال السقف سبب الارتفاع");
  assert.match(uncapUp.text, /صارت بياناته كافية فزال الحد المحافظ/u);
  const uncapDown = at(withHistory([snap(G_STEADY, 1, {
    limit_base: raw, credit_limit_display: higher, factors: { ...curFactors, cappedBy: "low_data" }
  })]), G_STEADY).creditHistory.change;
  assert.equal(uncapDown.direction, "down");
  assert.ok(!uncapDown.factors.includes("uncap_low_data"), "test 100: زوال السقف لا يفسّر نزولاً");

  // 101) لا تغيّر في الحد ولا الحالة ⇒ لا تفسير.
  const same = at(withHistory([snap(G_STEADY, 1, { limit_base: raw, credit_limit_display: steadyPlain.creditLimitDisplay, factors: curFactors })]), G_STEADY);
  assert.equal(same.creditHistory.change, null, "test 101: لا نص بلا تغيير");
  assert.equal(same.creditHistory.previous.date, d(1), "test 101: آخر لقطة معروضة");

  // 102) تغيّر الحالة إلى حالة بلا حد رقمي: النص من ملاحظة المحرك نفسها، لا صياغة جديدة.
  const toPrepaidLike = at(withHistory([snap(G_DELINQ, 1, { auto_status: "needs_review", credit_status: "needs_review", limit_base: null, credit_limit_display: null })]), G_DELINQ);
  assert.equal(toPrepaidLike.creditHistory.change.kind, "status");
  assert.ok(toPrepaidLike.creditHistory.change.text.startsWith("صار متعثّراً"), "test 102: التعثّر يُفسَّر بأرقامه أياً كانت الحالة السابقة");

  // 103) اتجاه الخطر من آخر 7 لقطات (اليوم + 6 سابقة).
  const riskOf = (guid, scores) => at(withHistory(scores.map((score, i) => snap(guid, scores.length - i, { risk_score: score }))), guid).creditHistory.riskTrend;
  const delinqRisk = at(plain, G_DELINQ).riskScore;
  assert.equal(delinqRisk, 100);
  const rising = riskOf(G_DELINQ, [10, 20, 30, 40, 50, 60]);
  assert.equal(rising.direction, "up", "test 103: خطر صاعد");
  assert.equal(rising.points, 7, "test 103: سبع نقاط");
  assert.equal(rising.fromDate, d(6));
  assert.equal(riskOf(G_DELINQ, [100, 100, 100, 100, 100, 100]).direction, "flat", "test 103: ثابت");
  const steadyRisk = steadyPlain.riskScore;
  assert.equal(riskOf(G_STEADY, [steadyRisk + 60, steadyRisk + 50, steadyRisk + 40, steadyRisk + 30, steadyRisk + 20, steadyRisk + 10]).direction, "down", "test 103: نازل");
  assert.equal(riskOf(G_DELINQ, [10, 20, 30, 40, 50, 60, 70, 80, 90]).points, 7, "test 103: الأقدم من آخر 7 لقطات لا يدخل");
  assert.equal(riskOf(G_DELINQ, [50]), null, "test 103: أقل من 3 نقاط ⇒ لا اتجاه");
  // اختبار مستقل للميل: نقاط على خط مستقيم y = 10x ⇒ التغيّر = 10 × 6 أيام = 60.
  assert.equal(riskOf(G_DELINQ, [40, 50, 60, 70, 80, 90]).delta, 60, "test 103: الميل بالمربعات الصغرى");

  // 104) صفوف اللقطة اليومية: من الدالة نفسها التي يقرأ منها المتصفح، بلا مورد ولا فجوة بيانات.
  const historyRun = withHistory([snap(G_STEADY, 7, { limit_base: raw / 2 })]);
  const batch = engine.buildCreditSnapshots(historyRun);
  assert.equal(batch.eligible, true, "test 104: بيانات حديثة موسومة ⇒ لقطة");
  assert.equal(batch.snapshotDate, REFERENCE_LOCAL_DAY, "test 104: تاريخ اللقطة يوم المحاسبة المحلي");
  assert.ok(batch.rows.every((row) => row.snapshot_date === REFERENCE_LOCAL_DAY));
  assert.ok(!batch.rows.some((row) => row.customer_guid === G_SUPPLIER), "test 104: لا لقطة لمورد");
  assert.ok(batch.rows.every((row) => /^[0-9a-f-]{36}$/.test(row.customer_guid)), "test 104: الربط بالمعرّف وحده");
  assert.equal(new Set(batch.rows.map((row) => row.customer_guid)).size, batch.rows.length, "test 104: صف واحد لكل زبون");
  const steadyRow = batch.rows.find((row) => row.customer_guid === G_STEADY);
  const steadyNow = at(historyRun, G_STEADY);
  assert.equal(steadyRow.credit_limit, steadyNow.creditLimit, "test 104: الحد المكتوب = المعروض (المنعَّم)");
  assert.equal(steadyRow.limit_base_raw, Math.round(raw * 1000) / 1000, "test 104: والمحسوب قبل التنعيم محفوظ");
  assert.equal(steadyRow.auto_status, "normal");
  assert.equal(steadyRow.utilization_percent, steadyNow.creditUsagePercent);
  assert.equal(steadyRow.risk_score, steadyNow.riskScore);
  assert.equal(steadyRow.coverage, steadyNow.autoCredit.coverage);
  assert.equal(steadyRow.punctuality, steadyNow.autoCredit.punctuality);
  assert.equal(steadyRow.balance, steadyNow.currentBalance);
  assert.ok(Number.isFinite(steadyRow.oldest_overdue_days), "test 104: أقدم دين متأخر بالأيام");
  assert.equal(steadyRow.factors.smoothing.applied, true, "test 104: تفاصيل التنعيم محفوظة");
  const delinqRow = batch.rows.find((row) => row.customer_guid === G_DELINQ);
  assert.equal(delinqRow.auto_status, "delinquent");
  assert.equal(delinqRow.credit_limit, 0);
  assert.ok(delinqRow.oldest_overdue_days > 0, "test 104: المتعثّر عليه دين متأخر");
  // اللقطة تعود فتصير تاريخاً يقرؤه المحرك غداً بلا فقد: صف الكاتب = صف القارئ.
  const tomorrow = engine.build({ ...reports, now: new Date(NOW.getTime()), creditHistory: batch.rows.map((row) => ({ ...row, snapshot_date: d(1) })) });
  assert.equal(at(tomorrow, G_STEADY).creditHistory.previous.date, d(1), "test 104: صف الكاتب يُقرأ تاريخاً");

  // 105) لا لقطة من بيانات لا تصف الزبون: مصدر قديم، أو بلا lineKinds:v1، أو يومان محاسبيان.
  const staleBatch = engine.buildCreditSnapshots(engine.build({ ...reports, now: new Date(NOW.getTime() + 86400000) }));
  assert.equal(staleBatch.eligible, false);
  assert.equal(staleBatch.reason, "stale_sources");
  assert.equal(staleBatch.rows.length, 0);
  const untypedBatch = engine.buildCreditSnapshots(engine.build({ ...reports, untyped: true }));
  assert.equal(untypedBatch.reason, "auto_credit_disabled", "test 105: بلا مصدر موسوم لا لقطة");
  const mismatchBatch = engine.buildCreditSnapshots(engine.build({ ...reports, movementsReport: { ...reports.movementsReport, report_date: d(1) } }));
  assert.equal(mismatchBatch.reason, "accounting_day_mismatch", "test 105: يومان محاسبيان ⇒ لا لقطة");
  assert.equal(engine.buildCreditSnapshots(null).reason, "no_result");

  // 106) حتمية: نفس المدخلات ⇒ نفس النتيجة، ولقطة اليوم نفسه (إعادة التشغيل) لا تغيّر شيئاً.
  const again = withHistory([snap(G_STEADY, 7, { limit_base: raw / 2 })]);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.buildCreditSnapshots(again).rows)), JSON.parse(JSON.stringify(batch.rows)), "test 106: حتمي");
  const rerun = withHistory([snap(G_STEADY, 7, { limit_base: raw / 2 }), ...batch.rows]);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.buildCreditSnapshots(rerun).rows)), JSON.parse(JSON.stringify(batch.rows)),
    "test 106: إعادة الكتابة في اليوم نفسه لا تعتمد على لقطة اليوم");

  // 107) المعمارية: الكاتب على الخادم يحمّل الملف نفسه، والجدول للمالك قراءةً وللخادم كتابةً،
  //      والواجهة تعرض ولا تحسب، ولا كتابة على الأمين.
  const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.equal(readText("supabase/functions/_shared/customer-intelligence.js"), readText("src/customer-intelligence.js"),
    "test 107: نسخة الخادم يجب أن تطابق src/customer-intelligence.js بايتاً ببايت — شغّل: cp src/customer-intelligence.js supabase/functions/_shared/");
  const fn = readText("supabase/functions/customer-credit-snapshot/index.ts");
  assert.match(fn, /import "\.\.\/_shared\/customer-intelligence\.js";/, "test 107: الدالة تحمّل المحرك نفسه");
  assert.match(fn, /buildCreditSnapshots\(/, "test 107: الصفوف من المحرك لا من حساب ثانٍ");
  assert.match(fn, /x-ozk-credit-snapshot-token/i, "test 107: الدالة محمية برمز الجدولة");
  assert.ok((fn.match(/\.upsert\(/g) || []).length === 1 && /from\("customer_credit_history"\)\s*\.upsert\(/.test(fn), "test 107: كتابة واحدة على جدول التاريخ وحده");
  assert.doesNotMatch(fn, /\.(insert|update|delete)\(/, "test 107: لا كتابة أخرى");
  assert.doesNotMatch(fn, /AmnDb00|AMEEN_SQL|mssql|tedious|sqlcmd/i, "test 107: لا وصول للأمين");
  const migrationName = "supabase/migrations/20261003010000_customer_credit_history.sql";
  const migration = readText(migrationName).toLowerCase();
  assert.match(migration, /alter table public\.customer_credit_history enable row level security/, "test 107: RLS مفعّل");
  assert.match(migration, /alter table public\.customer_credit_history force row level security/, "test 107: RLS مفروض");
  assert.match(migration, /primary key \(customer_guid, snapshot_date\)/, "test 107: لقطة واحدة لكل زبون باليوم");
  assert.match(migration, /for select\s+to authenticated\s+using \(\(select public\.is_owner\(\)\)\)/, "test 107: القراءة للمالك وحده");
  assert.doesNotMatch(migration, /for (insert|update|delete|all)/, "test 107: لا سياسة كتابة لأي دور من المتصفح");
  assert.match(migration, /revoke all on table public\.customer_credit_history from public, anon, authenticated/, "test 107: سحب صلاحيات المتصفح");
  assert.match(migration, /grant select on table public\.customer_credit_history to authenticated/, "test 107: قراءة فقط (تحت RLS)");
  assert.doesNotMatch(migration, /grant (insert|update|delete|all)[^;]*to (anon|authenticated)/, "test 107: لا كتابة للمتصفح");
  assert.doesNotMatch(migration, /amndb00/, "test 107: لا علاقة للمigration بالأمين");
  const view = readText("src/customer-intelligence-view.js");
  assert.ok(view.includes("row.creditHistory"), "test 107: الواجهة تعرض التاريخ من المحرك");
  assert.doesNotMatch(view, /\.(creditHistory|riskTrend|smoothing|change|limitBase|limitBaseRaw)\s*=(?!=)/, "test 107: الواجهة لا تُسنِد حقول التاريخ");
  assert.doesNotMatch(view, /Math\.log|least|slope/, "test 107: لا حساب اتجاه في الواجهة");
  assert.doesNotMatch(view, /\.upsert\(|\.insert\(/, "test 107: الواجهة لا تكتب");
  const client = readText("src/supabase-client.js");
  assert.match(client, /async listCustomerCreditHistory\(/, "test 107: قراءة التاريخ عبر دالة وصول");
  assert.doesNotMatch(client.slice(client.indexOf("async listCustomerCreditHistory(")).split(/\n    async /)[0], /\.(upsert|insert|update|delete)\(/, "test 107: دالة الوصول قراءة فقط");

  // 107ب) الواجهة ترسم التاريخ كما حسبه المحرك، وفشل قراءة الجدول (قبل تطبيق الـmigration)
  //       لا يُسقط الشاشة بل يعيد سلوك STEP 1.
  const renderView = async (listCustomerCreditHistory) => {
    const appNode = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
    const sandbox = {
      console, Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise, Infinity, isNaN, URLSearchParams,
      location: { search: "?route=customerIntel" },
      state: { session: { user: {} }, route: "customerIntel" },
      app: appNode,
      shell: (html) => html,
      render: () => {},
      allowedRoutes: new Set(),
      setRoute: () => {}, applyTheme: () => {}, installApp: () => {}, logout: () => {},
      document: { querySelectorAll: () => [], querySelector: () => null },
      setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {}, queueMicrotask: () => {},
      ozkCanAccessRoute: () => true,
      tobaccoData: {
        getCustomerInvoicesReport: async () => reports.invoicesReport,
        listCustomerBalanceReports: async () => [reports.balancesReport],
        getCustomerMovementsReport: async () => typedMovements(reports.movementsReport),
        listCustomerCreditLimits: async () => [],
        listCustomerCreditHistory
      }
    };
    sandbox.window = sandbox;
    const viewContext = vm.createContext(sandbox);
    // الواجهة تحسب «الآن» من ساعة الجهاز؛ نثبّتها على لحظة التركيبة كي تبقى المصادر حديثة.
    vm.runInContext(`Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(${NOW.getTime()}); } static now() { return ${NOW.getTime()}; } };`, viewContext);
    vm.runInContext(readText("src/customer-intelligence.js"), viewContext, { filename: "src/customer-intelligence.js" });
    vm.runInContext(readText("src/customer-intelligence-view.js"), viewContext, { filename: "src/customer-intelligence-view.js" });
    await sandbox.ozkCustomerIntelligenceView.refresh();
    return { html: appNode.innerHTML, intel: sandbox.ozkCustomerIntelligenceView.snapshot() };
  };
  const viewHistory = [snap(G_DELINQ, 7, { limit_base: 5000, credit_limit_display: 5000 }),
    ...[10, 20, 30, 40, 50, 60].map((score, i) => snap(G_DELINQ, 6 - i, { risk_score: score, limit_base: 5000, credit_limit_display: 5000 }))];
  let askedSince = null;
  const rendered = await renderView(async ({ sinceDate } = {}) => { askedSince = sinceDate; return viewHistory; });
  assert.equal(askedSince, new Date(NOW.getTime() - (21 + 2) * 86400000).toISOString().slice(0, 10), "test 107ب: نافذة الجلب من إعداد المحرك");
  const viewRow = rendered.intel.customers.find((row) => row.customerGuid === G_DELINQ);
  assert.ok(viewRow.creditHistory.change, "test 107ب: المحرك في المتصفح استلم التاريخ");
  assert.ok(rendered.html.includes(viewRow.creditHistory.change.text.replace(/&/g, "&amp;")), "test 107ب: نص السبب بجانب الزبون كما حسبه المحرك");
  assert.match(rendered.html, /class="ci-trend bad"[^>]*>↑</u, "test 107ب: سهم الخطر الصاعد");
  const broken = await renderView(async () => { throw new Error('relation "public.customer_credit_history" does not exist'); });
  assert.ok(broken.intel, "test 107ب: فشل التاريخ لا يُسقط الشاشة");
  assert.ok(broken.intel.customers.every((row) => row.creditHistory === null), "test 107ب: بلا تاريخ = سلوك STEP 1");
  assert.equal(broken.intel.customers.find((row) => row.customerGuid === G_STEADY).creditLimit, steadyPlain.creditLimit, "test 107ب: الحد المحسوب كما هو");
  assert.doesNotMatch(broken.html, /ci-change/, "test 107ب: لا نص تغيير بلا تاريخ");
}

// ---------------------------------------------------------------------------
// 108) سلوك كاتب اللقطة على الخادم (supabase/functions/customer-credit-snapshot) تحت عميل
//      Supabase وهمي: الرمز شرط، والصفوف المكتوبة هي صفوف المحرك حرفياً، ولا كتابة من
//      بيانات قديمة، والتاريخ يُقرأ صفحات.
// ---------------------------------------------------------------------------
{
  const ts = (await import("typescript")).default;
  const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(readText("supabase/functions/customer-credit-snapshot/index.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: "customer-credit-snapshot.ts"
  });
  assert.equal(diagnostics.length, 0, "test 108: الدالة تُترجم بلا أخطاء صياغة");
  const engineSource = readText("supabase/functions/_shared/customer-intelligence.js");

  const REF_DAY = Date.UTC(2026, 8, 2);
  const d = (n) => new Date(REF_DAY - n * 86400000).toISOString().slice(0, 10);
  const debit = (n, amount) => ({ date: d(n), debit: amount, credit: 0, notes: "", billGuid: "" });
  const pay = (n, amount) => ({ date: d(n), debit: 0, credit: amount, notes: "", billGuid: "" });
  const guid = (n) => `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`;
  const movements = [];
  for (let n = 59; n >= 1; n -= 6) { movements.push(debit(n, 600)); if (n - 6 >= 0) movements.push(pay(n - 6, 600)); }
  movements.sort((a, b) => a.date.localeCompare(b.date));
  const accountsList = [1, 2, 3, 4, 5].map((n) => ({ guid: guid(n), name: `كاتب ${n}`, movements, balance: movements.reduce((s, m) => s + m.debit - m.credit, 0) }));
  const reportsFor = () => ({
    ameen_customer_invoices: {
      id: 1, source: "ameen_customer_invoices", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, syncedAt: REFERENCE_ISO },
      items: accountsList.map((a) => ({ name: a.name, customerGuid: a.guid, truncated: false,
        invoices: a.movements.filter((m) => m.debit > 0 && m.date >= FROM_DATE).map((m, i) => invoice(m.date, m.debit, { guid: `w-${a.guid}-${i}` })) }))
    },
    ameen_customer_balances: {
      id: 2, source: "ameen_customer_balances", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { syncedAt: REFERENCE_ISO },
      items: accountsList.map((a) => ({ key: coreEngine.normalizeName(a.name), name: a.name, balance: a.balance, creditLimit: 0, customerGuid: a.guid,
        customerAccountGuid: a.guid, isSupplier: false, accountCurrencyIsBase: true, accountCurrency: "$", balanceAccountCcy: a.balance }))
    },
    ameen_customer_movements: typedMovements({
      id: 3, source: "ameen_customer_movements", created_at: REFERENCE_ISO, report_date: REFERENCE_LOCAL_DAY,
      summary: { syncedAt: REFERENCE_ISO, periodDays: 92 },
      items: accountsList.map((a) => ({ customerGuid: a.guid, name: a.name, truncated: false, movements: a.movements }))
    })
  });
  const filler = Array.from({ length: 1000 }, (_, i) => ({
    customer_guid: `00000000-0000-4000-c000-${String(i).padStart(12, "0")}`, snapshot_date: d(3), auto_status: "normal", credit_status: "normal",
    limit_base: 100, credit_limit_display: 100, credit_currency: "USD", risk_score: 0, factors: {}
  }));
  const ownHistory = [{ customer_guid: guid(1), snapshot_date: d(7), auto_status: "normal", credit_status: "normal",
    limit_base: 100, credit_limit_display: 100, credit_currency: "USD", risk_score: 40, factors: {} }];

  async function runFunction({ header = "tok-108", stored = "tok-108", now = NOW, method = "POST" } = {}) {
    const calls = { upserts: [], ranges: [], historyFilters: [], tables: [] };
    const reports = reportsFor();
    const history = [...ownHistory, ...filler];
    const from = (table) => {
      calls.tables.push(table);
      const state = { filters: {}, range: null };
      const result = () => {
        if (table === "app_secrets") return { data: stored === null ? null : { value: stored }, error: null };
        if (table === "inventory_reports") return { data: [reports[state.filters.source]].filter(Boolean), error: null };
        if (table === "customer_credit_history") {
          const [start, end] = state.range;
          calls.ranges.push([start, end]);
          return { data: history.slice(start, end + 1), error: null };
        }
        throw new Error(`test 108: جدول غير متوقع ${table}`);
      };
      const builder = {
        select: () => builder,
        eq: (column, value) => { state.filters[column] = value; return builder; },
        gte: (column, value) => { calls.historyFilters.push([column, value]); return builder; },
        order: () => builder,
        limit: () => builder,
        range: (start, end) => { state.range = [start, end]; return builder; },
        maybeSingle: async () => result(),
        upsert: async (rows, options) => { calls.upserts.push({ table, rows, options }); return { error: null }; },
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject)
      };
      return builder;
    };
    const HostDate = Date;
    class FixedDate extends HostDate {
      constructor(...args) { if (args.length) super(...args); else super(now.getTime()); }
      static now() { return now.getTime(); }
    }
    const context = vm.createContext({
      Response, Request, Headers, console, Promise, JSON, Math, Number, String, Object, Array, Map, Set, Infinity, isNaN,
      Date: FixedDate,
      Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://local.test", SUPABASE_SERVICE_ROLE_KEY: "service-test" }[name] || "") } },
      exports: {}
    });
    context.require = (specifier) => {
      if (specifier === "../_shared/customer-intelligence.js") { vm.runInContext(engineSource, context); return {}; }
      if (specifier.startsWith("npm:@supabase/supabase-js")) return { createClient: () => ({ from }) };
      throw new Error(`test 108: استيراد غير متوقع ${specifier}`);
    };
    context.module = { exports: context.exports };
    vm.runInContext(outputText, context, { filename: "customer-credit-snapshot.js" });
    const handler = context.exports.default;
    const headers = { "content-type": "application/json" };
    if (header !== null) headers["x-ozk-credit-snapshot-token"] = header;
    const response = await handler.fetch(new Request("https://local.test/functions/v1/customer-credit-snapshot", {
      method, headers, ...(method === "POST" ? { body: JSON.stringify({ action: "snapshot" }) } : {})
    }));
    return { status: response.status, body: await response.json(), calls, context };
  }

  const wrong = await runFunction({ header: "tok-other" });
  assert.equal(wrong.status, 401, "test 108: رمز خاطئ ⇒ 401");
  assert.equal(wrong.calls.upserts.length, 0, "test 108: لا كتابة برمز خاطئ");
  assert.deepEqual(wrong.calls.tables, ["app_secrets"], "test 108: لا قراءة تقارير قبل التحقق من الرمز");
  assert.equal((await runFunction({ header: null })).status, 401, "test 108: بلا رمز ⇒ 401");
  assert.equal((await runFunction({ stored: null, header: "" })).status, 401, "test 108: رمز غير مضبوط على الخادم ⇒ لا شيء");
  assert.equal((await runFunction({ method: "GET" })).status, 405);

  const ok = await runFunction();
  assert.equal(ok.status, 200, `test 108: ${JSON.stringify(ok.body)}`);
  assert.equal(ok.body.snapshotDate, REFERENCE_LOCAL_DAY);
  assert.equal(ok.calls.upserts.length, 1, "test 108: كتابة واحدة");
  const [write] = ok.calls.upserts;
  assert.equal(write.table, "customer_credit_history");
  assert.equal(write.options.onConflict, "customer_guid,snapshot_date", "test 108: upsert بمفتاح الزبون واليوم");
  assert.equal(ok.body.written, accountsList.length);
  assert.deepEqual(ok.calls.ranges, [[0, 999], [1000, 1999]], "test 108: التاريخ يُقرأ صفحات من 1000");
  assert.equal(ok.calls.historyFilters[0][0], "snapshot_date");
  // الصفوف المكتوبة = صفوف المحرك نفسه على المدخلات نفسها (عدا وقت الكتابة).
  const expected = coreEngine.buildCreditSnapshots(rawBuild({
    invoicesReport: reportsFor().ameen_customer_invoices,
    balancesReport: reportsFor().ameen_customer_balances,
    movementsReport: reportsFor().ameen_customer_movements,
    creditLimits: [],
    creditHistory: [...ownHistory, ...filler],
    now: NOW
  })).rows;
  const written = JSON.parse(JSON.stringify(write.rows)).map(({ written_at: writtenAt, ...row }) => { assert.ok(writtenAt); return row; });
  assert.deepEqual(written, JSON.parse(JSON.stringify(expected)), "test 108: الخادم يكتب صفوف المحرك حرفياً");
  const smoothed = written.find((row) => row.customer_guid === guid(1));
  assert.equal(smoothed.factors.smoothing.applied, true, "test 108: الخادم ينعّم من التاريخ نفسه");
  assert.ok(smoothed.limit_base <= 125 + 1e-6, "test 108: +25% من أساس 100");

  const stale = await runFunction({ now: new Date(NOW.getTime() + 86400000) });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.skipped, "stale_sources", "test 108: مصادر قديمة ⇒ تخطٍّ صريح");
  assert.equal(stale.calls.upserts.length, 0, "test 108: لا كتابة من بيانات قديمة");
}

// ---------------------------------------------------------------------------
// 109–117) تنبيه غياب الزبون المهم (CUSTOMER_INACTIVE_5D).
// تركيبة مستقلة: 15 زبون دولار في عيّنة القيمة (أعلى 20% = 3 مقاعد) + زبون منتظم صغير
// + مورد ضخم. يوم المرجع 2026-09-02، وk(n) = قبله بـn يوماً.
// ---------------------------------------------------------------------------
const KEY_REF = Date.UTC(2026, 8, 2);
const k = (n) => new Date(KEY_REF - n * 86400000).toISOString().slice(0, 10);
const kGuid = (n) => `00000000-0000-4000-d000-${String(n).padStart(12, "0")}`;
const KEY_ACCOUNTS = [
  // الأكبر قيمة: آخر بيع قبل 10 أيام، وبعده مرتجع فقط (المرتجع ليس شراء).
  { n: 1, name: "كبير بمرتجع", invoices: [invoice(k(30), 9000, { guid: "kb-1" }), invoice(k(10), 9000, { guid: "kb-2" }), invoice(k(1), 500, { guid: "kb-3", isReturn: true })] },
  // الثاني قيمة: غياب 5 أيام بالضبط.
  { n: 2, name: "كبير خمسة أيام", invoices: [invoice(k(40), 7000, { guid: "kc-1" }), invoice(k(5), 7000, { guid: "kc-2" })] },
  // الثالث قيمة: غياب 4 أيام — مهم لكن لم يبلغ العتبة.
  { n: 3, name: "كبير أربعة أيام", invoices: [invoice(k(35), 6000, { guid: "kd-1" }), invoice(k(4), 6000, { guid: "kd-2" })] },
  // منتظم صغير: 5 أيام شراء في آخر 30 يوماً، آخرها قبل 6 أيام.
  { n: 4, name: "منتظم صغير", invoices: series([k(22), k(18), k(14), k(10), k(6)], 40, "صنف منتظم").map((inv, i) => ({ ...inv, guid: `ke-${i}` })) },
  // مورد ضخم غائب: خارج «المهمين» كلياً.
  { n: 5, name: "مورد ضخم غائب", isSupplier: true, invoices: [invoice(k(50), 90000, { guid: "kf-1" }), invoice(k(20), 90000, { guid: "kf-2" })] },
  // صغار نشطون يملؤون العيّنة (2 فاتورتان، آخرها قريب).
  ...Array.from({ length: 11 }, (_, i) => ({
    n: 10 + i,
    name: `صغير ${i + 1}`,
    invoices: [invoice(k(25), 100 + i, { guid: `kg-${i}-1` }), invoice(k(2 + (i % 2)), 100 + i, { guid: `kg-${i}-2` })]
  }))
];
function keyReports({ syncedAt = REFERENCE_ISO, accounts = KEY_ACCOUNTS } = {}) {
  return {
    invoicesReport: {
      id: 91, source: "ameen_customer_invoices", created_at: syncedAt, report_date: REFERENCE_LOCAL_DAY,
      summary: { periodDays: 60, fromDate: FROM_DATE, syncedAt },
      items: accounts.map((a) => ({ name: a.name, customerGuid: kGuid(a.n), truncated: false, invoices: a.invoices }))
    },
    balancesReport: {
      id: 92, source: "ameen_customer_balances", created_at: syncedAt, report_date: REFERENCE_LOCAL_DAY,
      summary: { syncedAt },
      items: accounts.map((a) => ({ key: coreEngine.normalizeName(a.name), name: a.name, balance: 0, creditLimit: 0, customerGuid: kGuid(a.n),
        customerAccountGuid: kGuid(a.n), isSupplier: Boolean(a.isSupplier), accountCurrencyIsBase: true, accountCurrency: "$", balanceAccountCcy: 0 }))
    }
  };
}
const inactivityPlan = (...args) => JSON.parse(JSON.stringify(coreEngine.buildInactivityAlert(...args)));
const keyResult = engine.build({ ...keyReports(), creditLimits: [], now: NOW });
const keyRow = (n) => keyResult.customers.find((row) => row.customerGuid === kGuid(n));

// 109) من هو «المهم»: أعلى 20% بالقيمة لكل عملة، أو منتظم (≥ 4 أيام شراء في 30 يوماً).
{
  assert.equal(keyResult.dataAvailability.vipPopulation, 15, "test 109: العيّنة 15 زبوناً بلا المورد");
  for (const n of [1, 2, 3]) {
    assert.equal(keyRow(n).keyCustomer?.byValue, true, `test 109: الزبون ${n} ضمن أعلى 20% بالقيمة`);
    assert.ok(keyRow(n).flags.includes("key_customer"));
  }
  assert.deepEqual([1, 2, 3].map((n) => keyRow(n).keyCustomer.valueRank), [1, 2, 3], "test 109: ترتيب القيمة بصافي المشتريات");
  assert.equal(keyRow(4).keyCustomer?.byValue, false, "test 109: المنتظم الصغير ليس بالقيمة");
  assert.equal(keyRow(4).keyCustomer?.byRegularity, true, "test 109: لكنه منتظم");
  assert.equal(keyRow(4).keyCustomer.purchaseDays30, 5);
  for (let n = 10; n <= 20; n += 1) assert.equal(keyRow(n).keyCustomer, null, `test 109: الصغير ${n} ليس مهماً`);
  assert.equal(coreEngine.CONFIG.keyCustomerAlert.inactiveDays, 5, "test 109: العتبة 5 أيام في CONFIG");
}

// 110) المورد خارج «المهمين» وخارج التنبيه مهما كبرت مبيعاته وطال غيابه.
{
  const supplier = keyRow(5);
  assert.ok(supplier.isSupplier);
  assert.equal(supplier.keyCustomer, null, "test 110: مورد ⇒ ليس زبوناً مهماً");
  assert.ok(!supplier.flags.includes("key_customer_absent"));
}

// 111) 5 أيام بالضبط ⇒ غائب؛ 4 أيام ⇒ لا.
{
  assert.equal(keyRow(2).daysSinceLastPurchase, 5);
  assert.equal(keyRow(2).keyCustomer.absent, true, "test 111: 5 أيام بالضبط ⇒ تنبيه");
  assert.ok(keyRow(2).flags.includes("key_customer_absent"));
  assert.equal(keyRow(3).daysSinceLastPurchase, 4);
  assert.equal(keyRow(3).keyCustomer.absent, false, "test 111: 4 أيام ⇒ لا تنبيه");
}

// 112) المرتجع ليس شراء: مرتجع أمس لا يقطع غياب 10 أيام.
{
  assert.equal(keyRow(1).lastPurchaseAt, k(10), "test 112: آخر فاتورة بيع لا آخر مرتجع");
  assert.equal(keyRow(1).daysSinceLastPurchase, 10);
  assert.equal(keyRow(1).keyCustomer.absent, true, "test 112: مرتجع فقط ⇒ ما زال غائباً");
}

// 113) الرسالة اليومية: كل الغائبين في رسالة واحدة، من الأهم للأقل، بالحقول المطلوبة.
{
  const plan = inactivityPlan(keyResult, []);
  assert.equal(plan.status, "ok");
  assert.equal(plan.code, "CUSTOMER_INACTIVE_5D");
  assert.deepEqual(plan.absent.map((entry) => entry.customerGuid), [kGuid(1), kGuid(2), kGuid(4)], "test 113: الأهم أولاً، بلا المورد ولا من غاب 4 أيام");
  assert.equal(plan.messages.length, 1, "test 113: رسالة واحدة");
  const [message] = plan.messages;
  const lines = message.text.split("\n").slice(1);
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith("1. كبير بمرتجع"), "test 113: الترتيب");
  const [y, m, dd] = k(10).split("-");
  assert.ok(lines[0].includes(`آخر فاتورة ${dd}-${m}-${y}`), "test 113: التاريخ DD-MM-YYYY");
  assert.ok(lines[0].includes("10 يوماً بلا فاتورة"), "test 113: عدد أيام الغياب");
  assert.ok(lines[0].includes("مشترياته الشهرية 8,750$"), `test 113: المعدل الشهري = صافي 60 يوماً (بعد المرتجع) ÷ 2 (${lines[0]})`);
  assert.match(lines[0], /فجوته المعتادة (غير محسوبة|\d+ يوماً)/u, "test 113: الفجوة المعتادة");
  assert.ok(lines[2].includes("فجوته المعتادة 4 يوماً"), `test 113: فجوة المنتظم من نمطه (${lines[2]})`);
  assert.deepEqual(plan.insertRows.map((row) => row.dedupe_key), [
    `CUSTOMER_INACTIVE_5D:${kGuid(1)}:${k(10)}`,
    `CUSTOMER_INACTIVE_5D:${kGuid(2)}:${k(5)}`,
    `CUSTOMER_INACTIVE_5D:${kGuid(4)}:${k(6)}`
  ], "test 113: مفتاح منع التكرار = الزبون + تاريخ آخر فاتورة");
  assert.deepEqual(plan.deleteKeys, []);
  assert.deepEqual(inactivityPlan(keyResult, []), plan, "test 113: حتمي");
  // أكثر من 20 غائباً ⇒ رسائل من 20 زبوناً بالترتيب، ولكل رسالة زبائنها ومفتاحها.
  const many = {
    ...keyResult,
    customers: Array.from({ length: 25 }, (_, i) => ({
      customerId: `m${i}`, customerGuid: kGuid(100 + i), customerKey: `m${i}`, customerName: `غائب ${i + 1}`, currency: "USD",
      lastPurchaseAt: k(6), daysSinceLastPurchase: 6, typicalGapDays: 3, cadenceTrusted: true, netSales60d: 1000 - i, isSupplier: false,
      keyCustomer: { absent: true, valueRank: i + 1, monthlyPurchases: 500, byValue: true, byRegularity: false }
    }))
  };
  const split = inactivityPlan(many, []);
  assert.equal(split.messages.length, 2, "test 113: تقسيم كل 20 زبوناً");
  assert.deepEqual(split.messages.map((message) => message.customerKeys.length), [20, 5]);
  assert.match(split.messages[1].text, /\(2\/2\)\n21\. غائب 21 /u, "test 113: الترقيم يكمل في الرسالة الثانية");
  assert.notEqual(split.messages[0].dedupeKey, split.messages[1].dedupeKey);
}

// 114) عدم التكرار: من نُبِّه عنه لغيابه الحالي لا يُعاد في اليوم التالي.
{
  const first = inactivityPlan(keyResult, []);
  const again = inactivityPlan(keyResult, first.insertRows);
  assert.equal(again.status, "ok");
  assert.equal(again.messages.length, 0, "test 114: لا رسالة لغياب نُبِّه عنه");
  assert.equal(again.insertRows.length, 0);
  assert.deepEqual(again.deleteKeys, [], "test 114: الحالة تبقى ما دام الغياب مستمراً");
  const partial = inactivityPlan(keyResult, first.insertRows.slice(0, 1));
  assert.deepEqual(partial.insertRows.map((row) => row.customer_guid), [kGuid(2), kGuid(4)], "test 114: الجدد وحدهم");
  assert.ok(!partial.messages[0].text.includes("كبير بمرتجع"));
}

// 115) رجع واشترى ⇒ يخرج من القائمة وتُنظَّف حالته؛ وغيابه التالي مفتاح جديد.
{
  const accounts = KEY_ACCOUNTS.map((a) => a.n === 2 ? { ...a, invoices: [...a.invoices, invoice(k(1), 7000, { guid: "kc-3" })] } : a);
  const back = engine.build({ ...keyReports({ accounts }), creditLimits: [], now: NOW });
  const before = inactivityPlan(keyResult, []).insertRows;
  const aged = { dedupe_key: `CUSTOMER_INACTIVE_5D:${kGuid(30)}:${k(70)}`, customer_guid: kGuid(30), customer_key: null, last_purchase_date: k(70) };
  const plan = inactivityPlan(back, [...before, aged]);
  assert.ok(!plan.absent.some((entry) => entry.customerGuid === kGuid(2)), "test 115: من اشترى لا يظهر");
  assert.deepEqual(plan.deleteKeys, [`CUSTOMER_INACTIVE_5D:${kGuid(2)}:${k(5)}`, aged.dedupe_key].sort(), "test 115: حذف صف العائد وصف خرج من النافذة");
  assert.equal(plan.messages.length, 0, "test 115: لا رسالة جديدة");
}

// 116) تقرير فواتير قديم (> 90 دقيقة) ⇒ لا تنبيهات غياب، بلاغ «البيانات قديمة»، والحالة لا تُمسّ.
{
  const late = engine.build({ ...keyReports(), creditLimits: [], now: new Date(new Date(REFERENCE_ISO).getTime() + 91 * 60000) });
  const plan = inactivityPlan(late, inactivityPlan(keyResult, []).insertRows);
  assert.equal(plan.status, "stale_invoices", "test 116: فواتير عمرها 91 دقيقة ⇒ قديمة");
  assert.equal(plan.messages.length, 1);
  assert.match(plan.messages[0].text, /عمره 91 دقيقة/u);
  assert.match(plan.messages[0].text, /لا تنبيهات/u);
  assert.equal(plan.insertRows.length, 0);
  assert.equal(plan.deleteKeys.length, 0, "test 116: لا تنظيف من بيانات قديمة");
  const atLimit = engine.build({ ...keyReports(), creditLimits: [], now: new Date(new Date(REFERENCE_ISO).getTime() + 90 * 60000) });
  assert.equal(inactivityPlan(atLimit, []).status, "ok", "test 116: 90 دقيقة بالضبط ما زالت حديثة");
  const none = inactivityPlan(engine.build({ creditLimits: [], now: NOW }), []);
  assert.equal(none.status, "stale_invoices", "test 116: بلا تقرير فواتير ⇒ لا تنبيهات");
}

// 117) التنبيهات القائمة لم تتغيّر: لا كود جديد في buildAlertDrafts، والعقود 1..108 أعلاه خضراء.
{
  const codes = new Set(coreEngine.buildAlertDrafts(keyResult).map((draft) => draft.code));
  assert.ok(!codes.has("CUSTOMER_INACTIVE_5D"), "test 117: التنبيه الجديد بمسار الخادم وحده");
  const mainCodes = coreEngine.buildAlertDrafts(result).map((draft) => draft.code);
  assert.ok(mainCodes.includes("VIP_DECLINING"), "test 117: VIP_DECLINING باقٍ");
}

// ---------------------------------------------------------------------------
// 118) الدالة الطرفية customer-inactivity-alert تحت عميل Supabase وهمي: الرمز شرط، والإرسال
//      عبر notify_telegram بنص المحرك، والحالة تُكتب بعد الإرسال فقط، والبيانات القديمة بلاغ لا حالة.
// ---------------------------------------------------------------------------
{
  const ts = (await import("typescript")).default;
  const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { outputText, diagnostics } = ts.transpileModule(readText("supabase/functions/customer-inactivity-alert/index.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: "customer-inactivity-alert.ts"
  });
  assert.equal(diagnostics.length, 0, "test 118: الدالة تُترجم بلا أخطاء صياغة");
  const engineSource = readText("supabase/functions/_shared/customer-intelligence.js");
  const reports = keyReports();
  const bySource = { ameen_customer_invoices: reports.invoicesReport, ameen_customer_balances: reports.balancesReport };

  async function runAlert({ header = "tok-118", stored = "tok-118", now = NOW, state = [], notifyError = null, mode = "live" } = {}) {
    const calls = { rpc: [], upserts: [], deletes: [], tables: [] };
    const from = (table) => {
      calls.tables.push(table);
      const filters = {};
      let range = null;
      const result = () => {
        if (table === "app_secrets") return { data: stored === null ? null : { value: stored }, error: null };
        if (table === "inventory_reports") return { data: [bySource[filters.source]].filter(Boolean), error: null };
        if (table === "customer_inactivity_alerts") return { data: state.slice(range[0], range[1] + 1), error: null };
        if (table === "bot_config") return { data: mode === null ? null : { value: mode }, error: null };
        throw new Error(`test 118: جدول غير متوقع ${table}`);
      };
      const builder = {
        select: () => builder,
        eq: (column, value) => { filters[column] = value; return builder; },
        order: () => builder,
        limit: () => builder,
        range: (start, end) => { range = [start, end]; return builder; },
        maybeSingle: async () => result(),
        upsert: async (rows, options) => { calls.upserts.push({ table, rows, options }); return { error: null }; },
        delete: () => ({ in: async (column, values) => { calls.deletes.push({ table, column, values }); return { error: null }; } }),
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject)
      };
      return builder;
    };
    const rpc = async (name, args) => { calls.rpc.push({ name, args }); return { error: notifyError }; };
    const HostDate = Date;
    class FixedDate extends HostDate {
      constructor(...args) { if (args.length) super(...args); else super(now.getTime()); }
      static now() { return now.getTime(); }
    }
    const context = vm.createContext({
      Response, Request, Headers, console, Promise, JSON, Math, Number, String, Object, Array, Map, Set, Infinity, isNaN,
      Date: FixedDate,
      Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://local.test", SUPABASE_SERVICE_ROLE_KEY: "service-test" }[name] || "") } },
      exports: {}
    });
    context.require = (specifier) => {
      if (specifier === "../_shared/customer-intelligence.js") { vm.runInContext(engineSource, context); return {}; }
      if (specifier.startsWith("npm:@supabase/supabase-js")) return { createClient: () => ({ from, rpc }) };
      throw new Error(`test 118: استيراد غير متوقع ${specifier}`);
    };
    context.module = { exports: context.exports };
    vm.runInContext(outputText, context, { filename: "customer-inactivity-alert.js" });
    const headers = { "content-type": "application/json" };
    if (header !== null) headers["x-ozk-inactivity-alert-token"] = header;
    const response = await context.exports.default.fetch(new Request("https://local.test/functions/v1/customer-inactivity-alert", {
      method: "POST", headers, body: JSON.stringify({ action: "daily_check" })
    }));
    return { status: response.status, body: await response.json(), calls };
  }

  // الوضع التجريبي هو الافتراضي: بلا قيمة 'live' لا إرسال ولا كتابة حالة، والأعداد وحدها.
  for (const mode of [null, "", "dry_run", "LIVE "]) {
    const dry = await runAlert({ mode });
    assert.equal(dry.status, 200, `test 118: ${JSON.stringify(dry.body)}`);
    assert.equal(dry.body.mode, "dry_run", `test 118: الوضع ${JSON.stringify(mode)} تجريبي`);
    assert.equal(dry.body.wouldAlert, 3, "test 118: العدد الذي كان سيُنبَّه عنه");
    assert.equal(dry.body.wouldSendMessages, 1);
    assert.equal(dry.calls.rpc.length + dry.calls.upserts.length + dry.calls.deletes.length, 0, "test 118: تجريبي ⇒ لا إرسال ولا حالة");
  }
  const dryStale = await runAlert({ mode: null, now: new Date(new Date(REFERENCE_ISO).getTime() + 3 * 3600000) });
  assert.equal(dryStale.body.status, "stale_invoices");
  assert.equal(dryStale.calls.rpc.length, 0, "test 118: لا بلاغ تيليغرام في الوضع التجريبي");

  const wrong = await runAlert({ header: "tok-x" });
  assert.equal(wrong.status, 401, "test 118: رمز خاطئ ⇒ 401");
  assert.deepEqual(wrong.calls.tables, ["app_secrets"], "test 118: لا قراءة قبل التحقق من الرمز");
  assert.equal(wrong.calls.rpc.length, 0);
  assert.equal((await runAlert({ stored: null, header: "" })).status, 401, "test 118: رمز غير مضبوط ⇒ لا شيء");

  const expected = inactivityPlan(keyResult, []);
  const ok = await runAlert();
  assert.equal(ok.status, 200, `test 118: ${JSON.stringify(ok.body)}`);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls.rpc)), expected.messages.map((message) => ({
    name: "notify_telegram",
    args: { p_event_type: "CUSTOMER_INACTIVE_5D", p_message: message.text, p_dedupe_key: message.dedupeKey, p_dedupe_minutes: 1440 }
  })), "test 118: نص المحرك ومفتاحه حرفياً عبر notify_telegram");
  assert.equal(ok.calls.upserts.length, 1);
  assert.equal(ok.calls.upserts[0].table, "customer_inactivity_alerts");
  assert.equal(ok.calls.upserts[0].options.onConflict, "dedupe_key");
  assert.deepEqual(JSON.parse(JSON.stringify(ok.calls.upserts[0].rows)).map(({ alerted_at: at, ...row }) => { assert.ok(at); return row; }), JSON.parse(JSON.stringify(expected.insertRows)));
  assert.equal(ok.body.alerted, 3);

  const repeat = await runAlert({ state: expected.insertRows });
  assert.equal(repeat.calls.rpc.length, 0, "test 118: لا إرسال ثانٍ للغياب نفسه");
  assert.equal(repeat.calls.upserts.length, 0);

  const failed = await runAlert({ notifyError: { message: "boom" } });
  assert.equal(failed.status, 500);
  assert.equal(failed.calls.upserts.length, 0, "test 118: فشل الإرسال ⇒ لا تسجيل حالة");

  const stale = await runAlert({ now: new Date(new Date(REFERENCE_ISO).getTime() + 3 * 3600000), state: expected.insertRows });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.status, "stale_invoices");
  assert.equal(stale.calls.rpc.length, 1, "test 118: بلاغ واحد بأن البيانات قديمة");
  assert.match(stale.calls.rpc[0].args.p_message, /تقرير الفواتير عمره 180 دقيقة/u);
  assert.equal(stale.calls.upserts.length + stale.calls.deletes.length, 0, "test 118: لا مساس بالحالة من بيانات قديمة");

  const cleared = await runAlert({ state: [{ dedupe_key: `CUSTOMER_INACTIVE_5D:${kGuid(3)}:${k(20)}`, customer_guid: kGuid(3), customer_key: null, last_purchase_date: k(20) }] });
  assert.deepEqual(JSON.parse(JSON.stringify(cleared.calls.deletes)), [{ table: "customer_inactivity_alerts", column: "dedupe_key", values: [`CUSTOMER_INACTIVE_5D:${kGuid(3)}:${k(20)}`] }], "test 118: من عاد واشترى يُحذف صفّه");

  // البنية الثابتة: لا وصول للأمين، والجدول محمي، ولا تعديل على نظام تيليغرام القائم.
  const fn = readText("supabase/functions/customer-inactivity-alert/index.ts");
  assert.match(fn, /import "\.\.\/_shared\/customer-intelligence\.js";/, "test 118: الدالة تحمّل المحرك نفسه");
  assert.match(fn, /buildInactivityAlert\(/, "test 118: الخطة من المحرك لا من حساب ثانٍ");
  assert.ok(fn.indexOf('!== "live"') < fn.indexOf('admin.rpc("notify_telegram"'), "test 118: بوابة الوضع قبل أي إرسال");
  assert.doesNotMatch(fn, /AmnDb00|AMEEN_SQL|mssql|tedious|sqlcmd/i, "test 118: لا وصول للأمين");
  assert.doesNotMatch(fn, /from\("(?!app_secrets|inventory_reports|customer_inactivity_alerts|bot_config)/, "test 118: لا جداول أخرى");
  const migration = readText("supabase/migrations/20261003020000_customer_inactivity_alerts.sql").toLowerCase();
  assert.match(migration, /alter table public\.customer_inactivity_alerts enable row level security/, "test 118: RLS مفعّل");
  assert.match(migration, /alter table public\.customer_inactivity_alerts force row level security/, "test 118: RLS مفروض");
  assert.match(migration, /for select\s+to authenticated\s+using \(\(select public\.is_owner\(\)\)\)/, "test 118: القراءة للمالك وحده");
  assert.doesNotMatch(migration, /for (insert|update|delete|all)/, "test 118: لا سياسة كتابة من المتصفح");
  assert.match(migration, /revoke all on table public\.customer_inactivity_alerts from public, anon, authenticated/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all)[^;]*to (anon|authenticated)/, "test 118: لا كتابة للمتصفح");
  assert.doesNotMatch(migration, /amndb00|create or replace function public\.notify_telegram|telegram_outbox/, "test 118: لا أمين ولا تعديل لنظام تيليغرام");
  assert.match(migration, /cron\.schedule\('customer-inactivity-alert', '0 7 \* \* \*'/, "test 118: فحص يومي واحد");
  // pg_net لا يرسل JWT: الدالتان المجدولتان تتجاوزان تحقق البوابة، وحمايتهما الرمز في الكود.
  const supabaseConfig = readText("supabase/config.toml");
  for (const slug of ["customer-credit-snapshot", "customer-inactivity-alert"]) {
    assert.match(supabaseConfig, new RegExp(`\\[functions\\.${slug}\\]\\s*\\nverify_jwt = false`), `test 118: ${slug} بلا تحقق JWT من البوابة`);
  }
  assert.match(readText("supabase/functions/customer-credit-snapshot/index.ts"), /sameToken\(req\.headers\.get\("x-ozk-credit-snapshot-token"\)/, "test 118: الرمز شرط في كاتب اللقطة");
  assert.match(fn, /sameToken\(req\.headers\.get\("x-ozk-inactivity-alert-token"\)/, "test 118: الرمز شرط في التنبيه");
}

console.log(`ذكاء الزبائن: 118 عقداً محسوماً — ${result.customers.length} سجل زبون، ${result.summary.vipCount} VIP، ${result.summary.decliningCount} متراجع، ${result.summary.inactiveCount} متوقف.`);
