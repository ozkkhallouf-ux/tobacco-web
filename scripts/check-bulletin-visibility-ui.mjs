// ============================================================================
// فحص متصفح لتحكّم ظهور الأصناف في «مركز النشرة» (تسعير الأصناف العامة).
// بيانات اصطناعية بالكامل، والشبكة الخارجية مقطوعة. يثبت أن:
//   • المالك وحده يرى سطر الظهور وفلتر الظهور وعدّاداته؛ الموظف لا يرى أياً منها.
//   • الحالة المحفوظة (مخفي/ظاهر) تُعرض بدقة، وزرّا الإظهار/الإخفاء يتبادلان التعطيل.
//   • فلتر «الأصناف المخفية»/«الأصناف الظاهرة» يُظهر الصنف الصحيح وحده؛ «الكل» يُرجعهما معاً.
//   • فشل قراءة إعدادات الإخفاء يُعرض كتنبيه صريح، وكل الأصناف تبقى ظاهرة احتياطاً (لا إخفاء صامت).
//   • لا كتابة عند الفتح، ولا فيض أفقي على عرض iPhone.
// ============================================================================
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SHOTS = process.env.BULLETIN_VIS_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
const { server } = await import("./serve.mjs");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

const NOW_ISO = new Date().toISOString();
const GUID_HIDDEN = "aaaaaaaa-1111-2222-3333-444444444444";
const GUID_SHOWN = "bbbbbbbb-1111-2222-3333-444444444444";
const item = (key, name, groupName, itemGuid, stockQty, unit2Factor = 50) =>
  ({ key, name, groupName, itemGuid, stockQty, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor });
const ITEMS = [
  item("صنف مخفي", "صنف مخفي", "اليغانس", GUID_HIDDEN, 100),
  item("صنف ظاهر", "صنف ظاهر", "اليغانس", GUID_SHOWN, 80)
];
const price = (key, wholesale, retail) => ({
  itemKey: key, itemName: key, unit2Factor: 50, unit2Price: wholesale,
  pricePayload: retail == null ? {} : { retail: { price: retail } },
  rawPrice: { unit2Price: wholesale, unit1Price: null, unit2Factor: 50 }, updatedAt: NOW_ISO
});
const PRICES = [price("صنف مخفي", 300, 305), price("صنف ظاهر", 200, 205)];
const VISIBILITY_ROWS = [{
  item_guid: GUID_HIDDEN.toUpperCase(), item_key: "صنف مخفي", item_name: "صنف مخفي",
  reason: "طلب اختبار", updated_by_email: "owner@example.invalid", updated_at: NOW_ISO
}];
const OWNER = { id: "bv-owner", name: "مالك اختبار", email: "owner@example.invalid", accessRole: "owner" };
const STAFF = { id: "bv-staff", name: "موظف اختبار", email: "staff@example.invalid", accessRole: "staff" };

const failures = [];
let passed = 0;
const check = (condition, message) => { if (condition) passed += 1; else failures.push(message); };

const browser = await chromium.launch();
async function openPricing({ session, viewport, visibility = [], visibilityStatus = "ok", visibilityError = null }) {
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
  await page.evaluate(({ session, items, prices, now, visibility, visibilityStatus, visibilityError }) => {
    const state = (0, eval)("state");
    state.session = session;
    window.__ozkSession = session;
    Object.assign(state, {
      inventoryReports: [{ items, summary: { syncedAt: now } }],
      approvedPriceItems: prices,
      approvedPriceError: null,
      itemCosts: [],
      itemCostsStatus: "ok",
      bulletinClassifications: [],
      bulletinClassificationsStatus: "ok",
      bulletinVisibility: visibility,
      bulletinVisibilityStatus: visibilityStatus,
      bulletinVisibilityError: visibilityError,
      pricingVisibilityFilter: "all",
      priceMode: "mufrak"
    });
    (0, eval)("setRoute")("pricing");
  }, { session, items: ITEMS, prices: PRICES, now: NOW_ISO, visibility, visibilityStatus, visibilityError });
  await page.waitForSelector('[data-pricing-section="wazari"]');
  await page.evaluate(() => document.querySelectorAll("details.acc-group").forEach((d) => { d.open = true; }));
  return { context, page, errors, writes };
}
const cardLine = (page, name) => page.locator('[data-pricing-results] .pricing-card', { hasText: name }).locator(".bulletin-visibility-line");

// ---- المالك على الكمبيوتر: الحالة المحفوظة دقيقة، والأزرار تتبادل التعطيل ----
{
  const { context, page, errors, writes } = await openPricing({
    session: OWNER, viewport: { width: 1440, height: 900 }, visibility: VISIBILITY_ROWS
  });
  const filterRow = page.locator('[data-visibility-filter]');
  check(await filterRow.count() === 3, `أزرار الفلتر الثلاثة ظاهرة للمالك: ${await filterRow.count()}`);
  const allBtn = page.locator('[data-visibility-filter="all"]');
  const shownBtn = page.locator('[data-visibility-filter="shown"]');
  const hiddenBtn = page.locator('[data-visibility-filter="hidden"]');
  check(/\(2\)/.test(await allBtn.innerText()), `عدّاد الكل: ${await allBtn.innerText()}`);
  check(/\(1\)/.test(await shownBtn.innerText()), `عدّاد الظاهرة: ${await shownBtn.innerText()}`);
  check(/\(1\)/.test(await hiddenBtn.innerText()), `عدّاد المخفية: ${await hiddenBtn.innerText()}`);

  const hiddenLine = await cardLine(page, "صنف مخفي").innerText();
  check(/مخفي عن الزبائن/.test(hiddenLine), `سطر الصنف المخفي: ${hiddenLine}`);
  const shownLine = await cardLine(page, "صنف ظاهر").innerText();
  check(/ظاهر للزبائن/.test(shownLine), `سطر الصنف الظاهر: ${shownLine}`);

  const hiddenCard = page.locator('[data-pricing-results] .pricing-card', { hasText: "صنف مخفي" });
  check(await hiddenCard.locator('[data-action="show-bulletin-item"]').isEnabled(), "زر الإظهار مفعّل للصنف المخفي");
  check(await hiddenCard.locator('[data-action="hide-bulletin-item"]').isDisabled(), "زر الإخفاء معطّل للصنف المخفي (مخفي أصلاً)");
  const shownCard = page.locator('[data-pricing-results] .pricing-card', { hasText: "صنف ظاهر" });
  check(await shownCard.locator('[data-action="hide-bulletin-item"]').isEnabled(), "زر الإخفاء مفعّل للصنف الظاهر");
  check(await shownCard.locator('[data-action="show-bulletin-item"]').isDisabled(), "زر الإظهار معطّل للصنف الظاهر (ظاهر أصلاً)");

  await hiddenBtn.click();
  await page.waitForTimeout(50);
  let names = await page.locator('[data-pricing-results] .pricing-card-head strong').allInnerTexts();
  check(names.includes("صنف مخفي") && !names.includes("صنف ظاهر"), `فلتر المخفية: ${names.join(" | ")}`);

  await shownBtn.click();
  await page.waitForTimeout(50);
  names = await page.locator('[data-pricing-results] .pricing-card-head strong').allInnerTexts();
  check(!names.includes("صنف مخفي") && names.includes("صنف ظاهر"), `فلتر الظاهرة: ${names.join(" | ")}`);

  await allBtn.click();
  await page.waitForTimeout(50);
  names = await page.locator('[data-pricing-results] .pricing-card-head strong').allInnerTexts();
  check(names.includes("صنف مخفي") && names.includes("صنف ظاهر"), `فلتر الكل يُرجع الجميع: ${names.join(" | ")}`);

  check(writes.length === 0, `لا كتابة عند الفتح والتصفية: ${writes.join(", ")}`);
  check(errors.length === 0, `أخطاء الصفحة: ${errors.join(" | ")}`);
  if (SHOTS) await page.locator('.newsletter-pricing-panel:not([data-pricing-section])').screenshot({ path: join(SHOTS, "owner-visibility.png") });
  await context.close();
}

// ---- فشل قراءة إعدادات الإخفاء: تنبيه صريح، وكل الأصناف تبقى ظاهرة احتياطاً ----
{
  const { context, page, errors } = await openPricing({
    session: OWNER, viewport: { width: 1280, height: 900 },
    visibility: [], visibilityStatus: "error", visibilityError: "تعذّر الاتصال بقاعدة البيانات"
  });
  const warning = await page.locator(".newsletter-pricing-panel:not([data-pricing-section])").innerText();
  check(/تنبيه الظهور: تعذّر الاتصال بقاعدة البيانات/.test(warning), "تنبيه فشل القراءة ظاهر صراحة");
  const hiddenLine = await cardLine(page, "صنف مخفي").innerText();
  check(/ظاهر للزبائن/.test(hiddenLine), `فشل القراءة لا يُخفي شيئاً صامتاً — الصنف المخفي يُعرض ظاهراً احتياطاً: ${hiddenLine}`);
  check(await page.locator('[data-visibility-filter="hidden"]').innerText().then((t) => /\(0\)/.test(t)), "عدّاد المخفية 0 عند فشل القراءة (لا إخفاء وهمي)");
  check(errors.length === 0, `أخطاء الصفحة: ${errors.join(" | ")}`);
  await context.close();
}

// ---- الموظف على iPhone: لا سطر ظهور ولا فلتر إطلاقاً ----
{
  const { context, page, errors, writes } = await openPricing({
    session: STAFF, viewport: { width: 390, height: 844 }, visibility: VISIBILITY_ROWS
  });
  check(await page.locator(".bulletin-visibility-line").count() === 0, "الموظف لا يرى سطر الظهور إطلاقاً");
  check(await page.locator('[data-visibility-filter]').count() === 0, "الموظف لا يرى فلتر الظهور إطلاقاً");
  check(await page.locator('[data-action="show-bulletin-item"], [data-action="hide-bulletin-item"]').count() === 0, "الموظف لا يرى أي زر إظهار/إخفاء");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `فيض أفقي على iPhone: ${overflow}px`);
  check(writes.length === 0, `لا كتابة عند الفتح: ${writes.join(", ")}`);
  check(errors.length === 0, `أخطاء الصفحة: ${errors.join(" | ")}`);
  if (SHOTS) await page.locator('.newsletter-pricing-panel:not([data-pricing-section])').screenshot({ path: join(SHOTS, "staff-phone-visibility.png") });
  await context.close();
}

await browser.close();
server.close();
console.log("check-bulletin-visibility-ui:");
if (failures.length) {
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error(`check-bulletin-visibility-ui: فشل ${failures.length}، نجح ${passed}`);
  process.exit(1);
}
console.log(`check-bulletin-visibility-ui: اجتاز ${passed} فحصاً.`);
