// ============================================================================
// فحص متصفح لستارتي «مواد تحت سعر التكلفة» و«مواد غير مسعّرة» في مركز النشرة.
// بيانات اصطناعية بالكامل، والشبكة الخارجية مقطوعة. يثبت أن الستارتين مغلقتان
// افتراضياً، تفتحان بالضغط، تعرضان العدد والتاريخ، تبحثان وتفرزان بلا فقدان
// التركيز، تبقيان مفتوحتين بعد إعادة الرسم، لا ترسلان أي طلب كتابة، ولا تفيضان
// أفقياً على عرض iPhone. وأن ستارة التكلفة لا تظهر لغير المدير.
// ============================================================================
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.PRICE_AUDIT_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
const { server } = await import("./serve.mjs");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

const NOW_ISO = new Date().toISOString();
const ITEMS = [
  { key: "a1", name: "صنف تحت التكلفة ألف", groupName: "مجموعة أ", itemGuid: "guid-a1", stockQty: 500, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "a2", name: "صنف تحت التكلفة باء", groupName: "مجموعة ب", itemGuid: "guid-a2", stockQty: 120, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "a3", name: "صنف رابح", groupName: "مجموعة أ", itemGuid: "guid-a3", stockQty: 300, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "a4", name: "صنف بلا سعر", groupName: "مجموعة ب", itemGuid: "guid-a4", stockQty: 75, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "a5", name: "صنف بلا تكلفة", groupName: "مجموعة أ", itemGuid: "guid-a5", stockQty: 60, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "a6", name: "صنف مفرقه ناقص", groupName: "مجموعة ب", itemGuid: "guid-a6", stockQty: 90, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 }
];
const price = (key, wholesale, retail, extra = {}) => ({
  itemKey: key, itemName: key, itemCode: `C-${key}`, unit2Factor: 50, unit2Price: wholesale,
  pricePayload: retail == null ? {} : { retail: { price: retail } },
  rawPrice: { unit2Price: wholesale, unit1Price: null, unit2Factor: 50 },
  updatedAt: NOW_ISO, ...extra
});
const PRICES = [price("a1", 200, 210), price("a2", 270, 300), price("a3", 400, 420), price("a5", 300, 310), price("a6", 300, null)];
const COSTS = [
  { item_guid: "GUID-A1", item_name: "x", avg_cost: 5, currency: "$", updated_at: NOW_ISO },
  { item_guid: "guid-a2", item_name: "x", avg_cost: 6, currency: "$", updated_at: NOW_ISO },
  { item_guid: "guid-a3", item_name: "x", avg_cost: 6, currency: "$", updated_at: NOW_ISO },
  { item_guid: "guid-a4", item_name: "x", avg_cost: 4, currency: "$", updated_at: NOW_ISO },
  { item_guid: "guid-a6", item_name: "x", avg_cost: 5, currency: "$", updated_at: NOW_ISO }
];
const OWNER = { id: "price-audit-owner", name: "مالك اختبار", email: "owner@example.invalid", accessRole: "owner" };
const STAFF = { id: "price-audit-staff", name: "موظف اختبار", email: "staff@example.invalid", accessRole: "staff" };

const failures = [];
let passed = 0;
function check(condition, message) {
  if (condition) passed += 1; else failures.push(message);
}

const browser = await chromium.launch();
async function openPricing({ session, viewport }) {
  const context = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  const writes = [];
  page.on("pageerror", (error) => errors.push(String(error?.message || error)));
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  await page.route("**", (route) => route.request().url().startsWith(BASE)
    ? route.continue()
    : route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 200; i += 1) {
    const ready = await page.evaluate(() => { try { return (0, eval)("state").loading === false; } catch { return false; } });
    if (ready) break;
    await page.waitForTimeout(150);
  }
  await page.evaluate(({ session, items, prices, costs, now }) => {
    const state = (0, eval)("state");
    state.session = session;
    window.__ozkSession = session;
    Object.assign(state, {
      inventoryReports: [{ items, summary: { syncedAt: now } }],
      approvedPriceItems: prices,
      approvedPriceError: null,
      itemCosts: costs,
      itemCostsStatus: "ok",
      itemCostsError: null
    });
    (0, eval)("setRoute")("pricing");
  }, { session, items: ITEMS, prices: PRICES, costs: COSTS, now: NOW_ISO });
  await page.waitForSelector(".price-audit");
  return { context, page, errors, writes };
}

// ---- المدير على الكمبيوتر ----
{
  const { context, page, errors, writes } = await openPricing({ session: OWNER, viewport: { width: 1440, height: 900 } });
  const closed = await page.evaluate(() => [...document.querySelectorAll(".price-audit-panel")].map((d) => d.open));
  check(closed.length === 2 && closed.every((open) => !open), `الستارتان يجب أن تكونا مغلقتين افتراضياً: ${JSON.stringify(closed)}`);
  check(await page.locator('[data-price-audit-results="below"] tr').count() === 0, "لا تُرسم صفوف ستارة مغلقة (أداء)");
  const belowCount = (await page.locator('[data-price-audit-panel="below"] > summary .price-audit-count').innerText()).trim();
  check(belowCount === "2", `عدد المواد تحت التكلفة يجب أن يكون 2، ظهر ${belowCount}`);
  const unpricedCount = (await page.locator('[data-price-audit-panel="unpriced"] > summary .price-audit-count').innerText()).trim();
  check(unpricedCount === "2", `عدد غير المسعّرة يجب أن يكون 2، ظهر ${unpricedCount}`);
  const summaryText = await page.locator('[data-price-audit-panel="below"] > summary').innerText();
  check(/آخر جرد/.test(summaryText) && /آخر رفع للتكلفة/.test(summaryText), "عنوان الستارة يعرض تاريخ الجرد والتكلفة");

  await page.locator('[data-price-audit-panel="below"] > summary').click();
  await page.waitForSelector('[data-price-audit-results="below"] tbody tr');
  const names = await page.locator('[data-price-audit-results="below"] tbody tr .price-audit-item strong').allInnerTexts();
  check(names[0] === "صنف تحت التكلفة ألف", `الأكبر نسبة خسارة أولاً: ${names.join(" | ")}`);
  check(names.length === 3, `ألف بالجملة والمفرق + باء بالجملة = 3 صفوف، ظهر ${names.length}`);
  const redCell = await page.locator('[data-price-audit-results="below"] tbody tr').first().locator("td.price-audit-bad").first();
  const color = await redCell.evaluate((el) => getComputedStyle(el).color);
  check(/rgb\(2(55|5\d), 1[01]\d, 10\d\)|rgb\(184, 50, 40\)/.test(color), `السعر المخالف بالأحمر: ${color}`);
  if (SHOTS) await page.locator(".price-audit").screenshot({ path: join(SHOTS, "desktop-below.png") });

  const search = page.locator('[data-price-audit-search="below"]');
  await search.click();
  await search.pressSequentially("باء");
  const afterSearch = await page.locator('[data-price-audit-results="below"] tbody tr').count();
  check(afterSearch === 1, `البحث «باء» يجب أن يترك صفاً واحداً، ظهر ${afterSearch}`);
  check(await page.evaluate(() => document.activeElement?.dataset?.priceAuditSearch === "below"), "البحث لا يفقد التركيز أثناء الكتابة");
  await search.fill("");
  await page.selectOption('[data-price-audit-sort="below"]', "nameAsc");
  const sorted = await page.locator('[data-price-audit-results="below"] tbody tr .price-audit-item strong').allInnerTexts();
  check(sorted.join("|") === [...sorted].sort((a, b) => a.localeCompare(b, "ar")).join("|"), "الفرز بالاسم يعمل");

  await page.locator('[data-price-audit-panel="unverifiable"] > summary').click();
  const reasons = await page.locator('[data-price-audit-results="unverifiable"] tbody').innerText();
  check(/لا توجد تكلفة مسجّلة/.test(reasons), "الصنف بلا تكلفة يظهر في «تعذّر الحكم» مع السبب");

  await page.locator('[data-price-audit-panel="unpriced"] > summary').click();
  await page.waitForSelector('[data-price-audit-results="unpriced"] tbody tr');
  const unpricedText = await page.locator('[data-price-audit-results="unpriced"] tbody').innerText();
  check(/صنف بلا سعر/.test(unpricedText) && /سعر مفقود/.test(unpricedText), "المادة بلا صف سعر تظهر «سعر مفقود»");
  check(/صنف مفرقه ناقص/.test(unpricedText), "المادة بلا سعر مفرق تظهر في غير المسعّرة");
  check(/200/.test(unpricedText), "تكلفة المادة غير المسعّرة تظهر للمدير (4 × 50 = 200)");
  if (SHOTS) await page.locator(".price-audit").screenshot({ path: join(SHOTS, "desktop-unpriced.png") });

  await page.evaluate(() => (0, eval)("render")());
  const reopened = await page.evaluate(() => [...document.querySelectorAll(".price-audit-panel")].map((d) => d.open));
  check(reopened.every(Boolean), "الستارتان تبقيان مفتوحتين بعد إعادة رسم الصفحة");
  check(await page.locator('[data-price-audit-results="below"] tbody tr').count() === 3, "الجدول يُرسم من جديد بعد إعادة الرسم");

  // فشل تحميل التكلفة لا يُصدر أحكاماً، وفشل الأسعار لا يجعل أي مادة غير مسعّرة.
  await page.evaluate(() => {
    const state = (0, eval)("state");
    state.itemCosts = [];
    state.itemCostsStatus = "error";
    state.itemCostsError = "انقطاع";
    (0, eval)("render")();
  });
  check(await page.locator('[data-price-audit-panel="below"] .price-audit-count').first().innerText() === "؟", "فشل التكلفة ⇒ العدد «؟» لا صفر");
  check(/تعذّر تحميل التكاليف/.test(await page.locator('[data-price-audit-results="below"]').innerText()), "فشل التكلفة يظهر سببه");
  await page.evaluate(() => {
    const state = (0, eval)("state");
    state.approvedPriceItems = [];
    state.approvedPriceError = "انقطاع";
    (0, eval)("render")();
  });
  check(await page.locator('[data-price-audit-panel="unpriced"] .price-audit-count').innerText() === "؟", "فشل الأسعار ⇒ غير المسعّرة «؟» لا كل المواد");
  check(await page.locator('[data-price-audit-results="unpriced"] tbody tr').count() === 0, "فشل الأسعار لا يسرد أي مادة كغير مسعّرة");

  check(writes.length === 0, `لا طلبات كتابة: ${writes.join(" | ")}`);
  check(errors.length === 0, `لا أخطاء JavaScript: ${errors.join(" | ")}`);
  await context.close();
}

// ---- المدير على iPhone ----
{
  const { context, page, errors } = await openPricing({ session: OWNER, viewport: { width: 390, height: 844 } });
  await page.locator('[data-price-audit-panel="below"] > summary').click();
  await page.locator('[data-price-audit-panel="unpriced"] > summary').click();
  await page.waitForSelector('[data-price-audit-results="unpriced"] tbody tr');
  const overflow = await page.evaluate(() => {
    const audit = document.querySelector(".price-audit");
    const box = audit.getBoundingClientRect();
    const wide = [...audit.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 || el.getBoundingClientRect().left < -1);
    return { right: box.right, width: window.innerWidth, wide: wide.length, scroll: document.documentElement.scrollWidth };
  });
  check(overflow.wide === 0 && overflow.scroll <= overflow.width, `لا فيض أفقي على 390px: ${JSON.stringify(overflow)}`);
  const headHidden = await page.locator(".price-audit-table thead").first().evaluate((el) => getComputedStyle(el).display === "none");
  check(headHidden, "على الهاتف يتحول الجدول إلى بطاقات");
  if (SHOTS) await page.locator(".price-audit").screenshot({ path: join(SHOTS, "phone.png") });
  check(errors.length === 0, `لا أخطاء JavaScript على الهاتف: ${errors.join(" | ")}`);
  await context.close();
}

// ---- موظف: لا ستارة تكلفة ولا عمود تكلفة ----
{
  const { context, page } = await openPricing({ session: STAFF, viewport: { width: 1440, height: 900 } });
  check(await page.locator('[data-price-audit-panel="below"]').count() === 0, "ستارة التكلفة لا تظهر لغير المدير");
  await page.locator('[data-price-audit-panel="unpriced"] > summary').click();
  await page.waitForSelector('[data-price-audit-results="unpriced"] tbody tr');
  const head = await page.locator('[data-price-audit-results="unpriced"] thead').innerText();
  check(!/التكلفة/.test(head), "عمود التكلفة لا يظهر لغير المدير");
  await context.close();
}

await browser.close();
server.close();

console.log("check-price-cost-audit-ui:");
if (failures.length) {
  failures.forEach((message) => console.error(`  ❌ ${message}`));
  console.error(`check-price-cost-audit-ui: فشل ${failures.length}، نجح ${passed}`);
  process.exit(1);
}
console.log(`check-price-cost-audit-ui: اجتاز ${passed} فحصاً.`);
void root;
