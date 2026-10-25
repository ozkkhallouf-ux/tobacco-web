// ============================================================================
// حارس واجهة جدول «ذكاء الزبائن» المضغوط (طلب المالك 2026-10-25):
//   1. العرض الافتراضي ثمانية أعمدة بالترتيب المطلوب، بلا «الحالة» ولا «التصنيف».
//   2. لا تناقض ولا رقم تقديري: الحد الصفر بلا قسمة («بلا آجل» والتجاوز كامل الرصيد)،
//      البيانات غير الكافية «يحتاج مراجعة» بلا أرقام، الرصيد الدائن والأرقام الكبيرة سليمة،
//      وعلامة «معتمد» حين يُقاس على الحد المعتمد يدوياً.
//   3. لا خلط عملات: رمز العملة بجانب أرقام غير الدولار فقط، والترتيب بعمود مبالغ
//      يجمع كل عملة وحدها.
//   4. الفرز (التغير % تصاعدياً وتنازلياً) والبحث والفلاتر وفتح التفاصيل.
//   5. تخصيص الأعمدة: يُحفظ لكل مستخدم (مفاتيح أعمدة فقط بلا بيانات)، ويُستعاد الافتراضي
//      بضغطة، ويصمد أمام تخزين محجوب.
//   6. يتسع على MacBook (1280px) بلا تمرير أفقي، والهاتف بلا فيض للصفحة.
//   7. غير المالك لا يرى أي رقم.
// متصفح حقيقي ومحرك وهمي يعيد صفوفاً اصطناعية — الواجهة تعرض فقط، فلا بيانات حقيقية.
// ============================================================================
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const FILES = {
  "/src/styles.css": ["text/css", read("src/styles.css")],
  "/src/customer-intelligence.css": ["text/css", read("src/customer-intelligence.css")],
  "/src/customer-intelligence-view.js": ["application/javascript", read("src/customer-intelligence-view.js")]
};

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const PAGE = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/customer-intelligence.css"><title>حارس جدول ذكاء الزبائن</title></head>
<body><div id="app"></div></body></html>`;
const server = http.createServer((req, res) => {
  const file = FILES[String(req.url || "/").split("?")[0]];
  if (file) { res.writeHead(200, { "Content-Type": `${file[0]}; charset=utf-8` }); return res.end(file[1]); }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  return res.end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// صف اصطناعي بكل ما تقرؤه الواجهة؛ الحالات الحدية تتجاوز ما يلزم فقط.
const baseRow = (id, name, extra = {}) => ({
  customerId: id, customerName: name, customerKey: name.toLowerCase(), customerGuid: `guid-${id}`,
  isSupplier: false, flags: [], primarySegment: "regular", currency: "USD",
  netSales30d: 1000, netSalesPrevious30d: 900, purchaseTrend: { percent: 11.1, state: "ok" },
  lastPurchaseAt: "2026-10-20", daysSinceLastPurchase: 5, firstPurchaseAt: "2026-08-01",
  sales30d: 1000, returns30d: 0, invoiceCount30d: 4, invoiceCountPrevious30d: 3, averageInvoice30d: 250,
  cadenceTrusted: true, typicalGapDays: 7, inactiveThresholdDays: 14, activityScore: 50, valueScore: 50, riskScore: 20,
  creditLimitSource: "auto", creditLimit: 2000, creditLimitDisplay: 2000, creditCurrency: "USD",
  currentBalance: 500, balanceDisplay: 500, balanceCurrency: "USD",
  availableCredit: 1500, creditUsagePercent: 25, overLimitAmount: 0, creditStatus: "normal",
  limitBasis: "auto", effectiveLimit: 2000, approvedCredit: null, ameenCreditLimit: null,
  creditHistory: null, autoCredit: null, explanation: ["سطر تفسير"], topItems: [], topItemsIdentity: "item_guid",
  ...extra
});

const ROWS = [
  baseRow("a", "زبون معتمد قريب", {
    netSales30d: 5000, purchaseTrend: { percent: 12.5, state: "ok" }, currentBalance: 900, balanceDisplay: 900,
    limitBasis: "approved", effectiveLimit: 1000, availableCredit: 100, creditUsagePercent: 90, creditStatus: "near_limit", flags: ["near_credit_limit"],
    approvedCredit: { limit: 1000, usagePercent: 90, availableCredit: 100, overLimitAmount: 0, proposedMinusApproved: 1000 }
  }),
  baseRow("b", "زبون حد معتمد صفر", {
    netSales30d: 300, purchaseTrend: { percent: -40, state: "ok" }, currentBalance: 500, balanceDisplay: 500,
    limitBasis: "approved", effectiveLimit: 0, availableCredit: 0, creditUsagePercent: null, overLimitAmount: 500, creditStatus: "over_limit", flags: ["over_credit_limit"],
    approvedCredit: { limit: 0, usagePercent: null, availableCredit: 0, overLimitAmount: 500, proposedMinusApproved: 2000 }
  }),
  baseRow("c", "زبون بيانات غير كافية", {
    netSales30d: 200, purchaseTrend: { percent: null, state: "new_activity" }, creditLimit: null, creditLimitDisplay: null,
    availableCredit: null, creditUsagePercent: null, overLimitAmount: null, creditStatus: "insufficient_data",
    limitBasis: null, effectiveLimit: null, flags: ["credit_insufficient_data"]
  }),
  baseRow("d", "زبون رصيد دائن", {
    netSales30d: 150, purchaseTrend: { percent: 0, state: "ok" }, currentBalance: -250, balanceDisplay: -250,
    availableCredit: null, creditUsagePercent: null, overLimitAmount: null, creditStatus: "prepaid", limitBasis: null, effectiveLimit: null
  }),
  baseRow("e", "زبون بالليرة", {
    currency: "SYP", netSales30d: 48072377, netSalesPrevious30d: 44000000, purchaseTrend: { percent: 9.3, state: "ok" },
    creditCurrency: "SYP", creditLimit: 1000, creditLimitDisplay: 14000000, balanceCurrency: "SYP", currentBalance: 624, balanceDisplay: 8737500,
    availableCredit: 5262500, creditUsagePercent: 62, effectiveLimit: 14000000
  }),
  baseRow("f", "زبون أرقام كبيرة باسم طويل جداً لمركز تجاري في منطقة بعيدة", {
    netSales30d: 1234567, purchaseTrend: { percent: 250.4, state: "ok" }, currentBalance: 987654, balanceDisplay: 987654,
    creditLimit: 900000, creditLimitDisplay: 900000, effectiveLimit: 900000, availableCredit: 0, creditUsagePercent: 109.74,
    overLimitAmount: 87654, creditStatus: "over_limit", flags: ["over_credit_limit"]
  }),
  baseRow("g", "مورد مخفي", { isSupplier: true, flags: ["supplier_account"] })
];

const INTEL = {
  customers: ROWS,
  summary: { activeCustomers: 6, totalCustomers: 7, vipCount: 0, decliningCount: 1, inactiveCount: 0, reactivatedCount: 0, overCreditLimitCount: 2, nearCreditLimitCount: 1, delinquentCreditCount: 0, ambiguousIdentityCount: 0 },
  dataAvailability: { vipRankingReliable: false, coverageDays: 90, unresolvedAmbiguousInvoiceRows: 0 },
  config: { vipTopShare: 0.2, declineTrendPercent: -25 },
  window: { currentStartDate: "2026-09-25", referenceDate: "2026-10-24", previousStartDate: "2026-08-26", previousEndDate: "2026-09-24", previousWindowCovered: true },
  sourcesFreshness: {},
  staleData: false
};

const DEFAULT_HEADERS = ["الزبون", "مبيعات 30 يوماً", "التغير %", "الرصيد", "الحد المقترح", "المتاح", "الاستخدام", "التجاوز"];

async function open({ width = 1280, height = 800, owner = true, userId = "owner-1", storage = "ok", page: existing } = {}) {
  const page = existing || await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(ORIGIN + "/");
  await page.evaluate(({ intel, owner, userId, storage }) => {
    if (storage === "blocked") {
      Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
    }
    window.state = { session: { id: userId }, route: "customerIntel" };
    window.app = document.getElementById("app");
    window.shell = (html) => `<div class="app-shell route-customerIntel"><aside class="sidebar"><nav><button class="nav-link" data-route="overview">الرئيسية</button></nav></aside><main class="main">${html}</main></div>`;
    window.render = () => {};
    window.allowedRoutes = new Set();
    window.setRoute = () => {};
    window.applyTheme = () => {};
    window.installApp = () => {};
    window.logout = () => {};
    window.ozkCanAccessRoute = () => owner;
    window.ozkCustomerIntelligence = {
      CONFIG: { creditHistory: { lookbackDays: 30 } },
      normalizeName: (value) => String(value || "").trim().toLowerCase(),
      build: () => intel
    };
    window.tobaccoData = {
      getCustomerInvoicesReport: async () => ({}), listCustomerBalanceReports: async () => [],
      getCustomerMovementsReport: async () => ({}), listCustomerCreditLimits: async () => [],
      listCustomerCreditHistory: async () => [], upsertCustomerCreditLimit: async () => ({})
    };
  }, { intel: INTEL, owner, userId, storage });
  await page.addScriptTag({ url: "/src/customer-intelligence-view.js" });
  if (owner) await page.evaluate(() => window.ozkCustomerIntelligenceView.refresh());
  return { page, errors };
}

const headers = (page) => page.$$eval(".ci-table thead th", (cells) => cells.map((cell) => cell.textContent.replace(/[▲▼]/g, "").trim()));
const rowNames = (page) => page.$$eval("tr.ci-row .ci-name-link", (cells) => cells.map((cell) => cell.textContent.trim()));
const rowCells = (page, name) => page.$$eval("tr.ci-row", (rows, wanted) => {
  const row = rows.find((entry) => entry.querySelector(".ci-name-link")?.textContent.trim() === wanted);
  const head = [...document.querySelectorAll(".ci-table thead th")].map((cell) => cell.textContent.replace(/[▲▼]/g, "").trim());
  return row ? Object.fromEntries([...row.children].map((cell, index) => [head[index], { text: cell.textContent.replace(/\s+/g, " ").trim(), cls: cell.className }])) : null;
}, name);

await test("العرض الافتراضي: ثمانية أعمدة بالترتيب المطلوب، بلا الحالة والتصنيف، والمورد مخفي", async () => {
  const { page, errors } = await open();
  assert.deepEqual(await headers(page), DEFAULT_HEADERS);
  const names = await rowNames(page);
  assert.equal(names.length, 6);
  assert.ok(!names.includes("مورد مخفي"));
  assert.equal(await page.locator(".ci-table .ci-segment").count(), 0, "التصنيف ظاهر في الجدول الافتراضي");
  assert.deepEqual(errors, []);
  await page.close();
});

await test("لا نص معطوب في أي خلية (NaN/undefined/null/Infinity/‎-0)", async () => {
  const { page } = await open();
  const text = await page.$eval(".ci-table", (table) => table.textContent);
  for (const bad of ["NaN", "undefined", "null", "Infinity", "-0 "]) assert.ok(!text.includes(bad), `وُجد «${bad}» في الجدول`);
  await page.close();
});

await test("الحد المعتمد صفر: «بلا آجل» بلا نسبة، والتجاوز كامل الرصيد بلون التجاوز، وعلامة «معتمد»", async () => {
  const { page } = await open();
  const cells = await rowCells(page, "زبون حد معتمد صفر");
  assert.match(cells["الاستخدام"].text, /^بلا آجل/);
  assert.ok(cells["الاستخدام"].text.includes("معتمد"));
  assert.ok(!cells["الاستخدام"].text.includes("%"));
  assert.equal(cells["التجاوز"].text, "500");
  assert.match(cells["التجاوز"].cls, /\bbad\b/);
  assert.equal(cells["المتاح"].text, "0");
  await page.close();
});

await test("حد معتمد موجب: النسبة والمتاح منه، و«معتمد» بجانب النسبة، والقرب بلون التنبيه", async () => {
  const { page } = await open();
  const cells = await rowCells(page, "زبون معتمد قريب");
  assert.equal(cells["الاستخدام"].text, "90% معتمد");
  assert.match(cells["الاستخدام"].cls, /\bwarn\b/);
  assert.equal(cells["المتاح"].text, "100");
  assert.equal(cells["التجاوز"].text, "0");
  await page.close();
});

await test("بيانات غير كافية: «يحتاج مراجعة» بدل الحد والنسبة، ولا أرقام للمتاح والتجاوز", async () => {
  const { page } = await open();
  const cells = await rowCells(page, "زبون بيانات غير كافية");
  assert.equal(cells["الحد المقترح"].text, "يحتاج مراجعة");
  assert.equal(cells["الاستخدام"].text, "يحتاج مراجعة");
  assert.equal(cells["المتاح"].text, "—");
  assert.equal(cells["التجاوز"].text, "—");
  assert.equal(cells["التغير %"].text, "نشاط جديد");
  await page.close();
});

await test("رصيد دائن وأرقام كبيرة: الإشارة والفواصل سليمة، والتجاوز الكبير بلون التجاوز", async () => {
  const { page } = await open();
  const prepaid = await rowCells(page, "زبون رصيد دائن");
  assert.equal(prepaid["الرصيد"].text, "-250");
  assert.equal(prepaid["الاستخدام"].text, "رصيد دائن");
  const big = await rowCells(page, "زبون أرقام كبيرة باسم طويل جداً لمركز تجاري في منطقة بعيدة");
  assert.equal(big["مبيعات 30 يوماً"].text, "1,234,567");
  assert.equal(big["الرصيد"].text, "987,654");
  assert.equal(big["الاستخدام"].text, "110%");
  assert.equal(big["التجاوز"].text, "87,654");
  assert.match(big["التجاوز"].cls, /\bbad\b/);
  await page.close();
});

await test("العملات: رمز SYP بجانب أرقام الليرة وحدها، ولا «USD» مكرر في الجدول", async () => {
  const { page } = await open();
  const syp = await rowCells(page, "زبون بالليرة");
  for (const column of ["مبيعات 30 يوماً", "الرصيد", "الحد المقترح", "المتاح"]) assert.ok(syp[column].text.includes("SYP"), `${column} بلا رمز الليرة`);
  assert.equal(syp["التجاوز"].text, "0");
  const usd = await rowCells(page, "زبون معتمد قريب");
  assert.ok(!Object.values(usd).some((cell) => cell.text.includes("SYP")));
  assert.ok(!(await page.$eval(".ci-table tbody", (body) => body.textContent)).includes("USD"));
  await page.close();
});

await test("الترتيب بالمبيعات يجمع الدولار أولاً ثم فوج الليرة بفاصل، ولا يضع الليرة فوق الدولار", async () => {
  const { page } = await open();
  const names = await rowNames(page);
  assert.equal(names[0], "زبون أرقام كبيرة باسم طويل جداً لمركز تجاري في منطقة بعيدة");
  assert.equal(names[names.length - 1], "زبون بالليرة");
  assert.match(await page.$eval("tr.ci-group", (row) => row.textContent), /SYP/);
  await page.close();
});

await test("الفرز بنسبة التغير تنازلياً ثم تصاعدياً، وغير المحسوب في الأسفل دائماً", async () => {
  const { page } = await open();
  await page.click('[data-ci-sort="trendPercent"]');
  let names = await rowNames(page);
  assert.deepEqual(names.slice(0, 2), ["زبون أرقام كبيرة باسم طويل جداً لمركز تجاري في منطقة بعيدة", "زبون معتمد قريب"]);
  assert.equal(names[names.length - 1], "زبون بيانات غير كافية");
  assert.equal(await page.$eval('th[aria-sort]', (th) => th.getAttribute("aria-sort")), "descending");
  await page.click('[data-ci-sort="trendPercent"]');
  names = await rowNames(page);
  assert.equal(names[0], "زبون حد معتمد صفر");
  assert.equal(names[names.length - 1], "زبون بيانات غير كافية");
  assert.equal(await page.$$eval("tr.ci-group", (rows) => rows.length), 0, "نسبة التغير لا تُفصل بالعملة");
  await page.close();
});

await test("البحث والفلاتر وإظهار الموردين تعمل كما كانت", async () => {
  const { page } = await open();
  await page.fill("[data-ci-search]", "بالليرة");
  assert.deepEqual(await rowNames(page), ["زبون بالليرة"]);
  await page.fill("[data-ci-search]", "");
  await page.click('[data-ci-filter="credit"]');
  const credit = await rowNames(page);
  assert.ok(credit.includes("زبون حد معتمد صفر") && credit.includes("زبون معتمد قريب"));
  assert.ok(!credit.includes("زبون رصيد دائن"));
  await page.click('[data-ci-filter="all"]');
  await page.check("[data-ci-suppliers]");
  assert.ok((await rowNames(page)).includes("مورد مخفي"));
  await page.close();
});

await test("فتح التفاصيل بالاسم: الحد المعتمد بقيمته، والحد الفعّال، والأقسام المنقولة من الجدول", async () => {
  const { page, errors } = await open();
  await page.click('.ci-name-link[data-ci-open="b"]');
  const detail = await page.$eval(".ci-detail", (section) => section.textContent.replace(/\s+/g, " "));
  assert.match(detail, /زبون حد معتمد صفر/);
  assert.match(detail, /قرار صريح: بلا آجل/);
  assert.match(detail, /الحد الفعّال\s*صفر \(بلا آجل\)/);
  for (const section of ["المبيعات والنشاط", "الائتمان", "التصنيف والمخاطر", "صافي الفترة السابقة", "درجة الخطر", "حالة الحد"]) {
    assert.ok(detail.includes(section), `التفاصيل تنقصها «${section}»`);
  }
  assert.equal(await page.$eval('.ci-name-link[data-ci-open="b"]', (button) => button.getAttribute("aria-expanded")), "true");
  assert.deepEqual(errors, []);
  await page.close();
});

await test("تخصيص الأعمدة: إخفاء وإظهار، حفظ لكل مستخدم بمفاتيح فقط، واستعادة الافتراضي", async () => {
  const { page } = await open({ userId: "owner-1" });
  await page.click("[data-ci-columns] summary");
  await page.uncheck('[data-ci-column="overLimitAmount"]');
  await page.check('[data-ci-column="primarySegment"]');
  const custom = await headers(page);
  assert.ok(!custom.includes("التجاوز") && custom.includes("التصنيف"));
  const stored = await page.evaluate(() => localStorage.getItem("ozk_customer_intel_columns:v1:owner-1"));
  assert.ok(stored, "التفضيل لم يُحفظ");
  assert.deepEqual(Object.keys(JSON.parse(stored)), ["columns"]);
  assert.ok(!/زبون|\d{3}/.test(stored), "التخزين المحلي يحمل بيانات زبائن");

  await open({ page, userId: "owner-1" });
  assert.deepEqual(await headers(page), custom, "التفضيل لم يصمد بعد إعادة التحميل");
  await open({ page, userId: "other-user" });
  assert.deepEqual(await headers(page), DEFAULT_HEADERS, "مستخدم آخر ورث تفضيل غيره");

  await open({ page, userId: "owner-1" });
  await page.click("[data-ci-columns] summary");
  await page.click("[data-ci-columns-reset]");
  assert.deepEqual(await headers(page), DEFAULT_HEADERS);
  assert.equal(await page.evaluate(() => localStorage.getItem("ozk_customer_intel_columns:v1:owner-1")), null);
  await page.close();
});

await test("تخزين محجوب (تصفّح خاص): العرض الافتراضي يعمل والتخصيص لا يرمي خطأ", async () => {
  const { page, errors } = await open({ storage: "blocked" });
  assert.deepEqual(await headers(page), DEFAULT_HEADERS);
  await page.click("[data-ci-columns] summary");
  await page.uncheck('[data-ci-column="availableCredit"]');
  assert.ok(!(await headers(page)).includes("المتاح"));
  assert.deepEqual(errors, []);
  await page.close();
});

await test("MacBook (1280px): الأعمدة الثمانية بلا تمرير أفقي ولا فيض للصفحة، والاسم الطويل يلتف كاملاً", async () => {
  const { page } = await open({ width: 1280, height: 800 });
  const layout = await page.evaluate(() => {
    const wrap = document.querySelector(".ci-table-wrap");
    const link = document.querySelector('.ci-name-link[data-ci-open="f"]');
    return {
      table: wrap.scrollWidth - wrap.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
      nameClipped: link.scrollWidth > link.clientWidth + 1
    };
  });
  assert.ok(layout.table <= 1, `الجدول يتمرّر أفقياً ${layout.table}px`);
  assert.ok(layout.page <= 0, `الصفحة تفيض ${layout.page}px`);
  assert.equal(layout.nameClipped, false, "اسم الزبون مقصوص");
  await page.close();
});

await test("الهاتف (390px): الصفحة لا تفيض، والجدول يتمرّر داخل حاويته وعمود الاسم ثابت", async () => {
  const { page } = await open({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    sticky: getComputedStyle(document.querySelector("td.ci-name")).position
  }));
  assert.ok(layout.page <= 0, `الصفحة تفيض ${layout.page}px على الهاتف`);
  assert.equal(layout.sticky, "sticky");
  await page.close();
});

await test("غير المالك: لا جدول ولا أي رقم أو اسم زبون في الصفحة", async () => {
  const { page } = await open({ owner: false });
  await page.evaluate(() => { window.state.route = "customerIntel"; });
  const text = await page.evaluate(() => document.body.textContent);
  assert.equal(await page.locator(".ci-table").count(), 0);
  assert.ok(!text.includes("زبون معتمد قريب"));
  await page.close();
});

await browser.close();
server.close();
console.log("حارس جدول ذكاء الزبائن:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n${failed} فحص فشل.`);
  process.exit(1);
}
console.log(`\nاجتاز ${results.length} فحصاً.`);
