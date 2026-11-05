// ============================================================================
// فحص متصفح لقسمي «تسعير الأصناف العامة» و«تسعير أصناف الوزاري» في مركز النشرة.
// بيانات اصطناعية بالكامل، والشبكة الخارجية مقطوعة. يثبت أن:
//   • الوينستون المخصص (GUID مؤكد) في قسم العامة لا في الوزاري، ولا يتكرر.
//   • أصناف الوزاري الفعلية كلها في قسمها المستقل، وغير المسعّر ظاهر «غير مسعّر».
//   • قسم العامة لا يعرض أي صنف وزاري.
//   • نموذج تصحيح التصنيف للمالك وحده، والصفحة لا ترسل أي كتابة عند الفتح.
//   • تصحيح المالك المحفوظ ينقل الصنف بين القسمين فوراً، والأسعار كما هي.
//   • لا فيض أفقي على عرض iPhone.
// ============================================================================
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SHOTS = process.env.BULLETIN_CLASS_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
const { server } = await import("./serve.mjs");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

const NOW_ISO = new Date().toISOString();
const item = (key, name, groupName, itemGuid, stockQty, unit2Factor = 50) =>
  ({ key, name, groupName, itemGuid, stockQty, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor });
const ITEMS = [
  item("وينستون ازرق مخصص", "وينستون ازرق مخصص", "وينستون", "294a7dc9-9bb3-4bef-8791-f3c336afd727", 50),
  item("وينستون فضي مخصص", "وينستون فضي مخصص", "وينستون", "b29eb8c3-a1fe-4feb-a18a-30e26189fda2", 150),
  item("وينستون فضي", "وينستون فضي", "وينستون", "375ef607-3e41-491d-9546-e7bde8b1bdf0", 50),
  item("كينت ازرق", "كينت أزرق", "كينت", "34a7d4ed-488a-44d7-abd2-33b9590cae15", 38),
  item("نخله محزر لبناني", "نخلة محزر لبناني", "نخلة", "bce108ca-1fd5-46a3-b997-c5dfa6f25c99", 180, 25),
  item("وينستون احمر حره", "وينستون احمر حرة", "وينستون", "40ad185a-2951-44d7-bc16-a76caa298813", 348),
  item("صنف عام", "صنف عام", "اليغانس", "cccccccc-0000-0000-0000-000000000001", 100)
];
const price = (key, wholesale, retail) => ({
  itemKey: key, itemName: key, unit2Factor: 50, unit2Price: wholesale,
  pricePayload: retail == null ? {} : { retail: { price: retail } },
  rawPrice: { unit2Price: wholesale, unit1Price: null, unit2Factor: 50 }, updatedAt: NOW_ISO
});
const PRICES = [price("وينستون فضي", 700, 710), price("وينستون احمر حره", 675, 675), price("صنف عام", 300, 305)];
const OWNER = { id: "bc-owner", name: "مالك اختبار", email: "owner@example.invalid", accessRole: "owner" };
const STAFF = { id: "bc-staff", name: "موظف اختبار", email: "staff@example.invalid", accessRole: "staff" };

const failures = [];
let passed = 0;
const check = (condition, message) => { if (condition) passed += 1; else failures.push(message); };

const browser = await chromium.launch();
async function openPricing({ session, viewport, classifications = [] }) {
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
  await page.evaluate(({ session, items, prices, now, classifications }) => {
    const state = (0, eval)("state");
    state.session = session;
    window.__ozkSession = session;
    Object.assign(state, {
      inventoryReports: [{ items, summary: { syncedAt: now } }],
      approvedPriceItems: prices,
      approvedPriceError: null,
      itemCosts: [],
      itemCostsStatus: "ok",
      bulletinClassifications: classifications,
      bulletinClassificationsStatus: "ok",
      priceMode: "mufrak"
    });
    (0, eval)("setRoute")("pricing");
  }, { session, items: ITEMS, prices: PRICES, now: NOW_ISO, classifications });
  await page.waitForSelector('[data-pricing-section="wazari"]');
  await page.evaluate(() => document.querySelectorAll("details.acc-group").forEach((d) => { d.open = true; }));
  return { context, page, errors, writes };
}
const names = (page, selector) => page.locator(`${selector} .pricing-card-head strong`).allInnerTexts();

// ---- المالك على الكمبيوتر ----
{
  const { context, page, errors, writes } = await openPricing({ session: OWNER, viewport: { width: 1440, height: 900 } });
  const titles = await page.locator(".newsletter-pricing-panel h3").allInnerTexts();
  check(titles.includes("تسعير الأصناف العامة") && titles.includes("تسعير أصناف الوزاري"), `عنوانا القسمين: ${titles.join(" | ")}`);
  const general = await names(page, "[data-pricing-results]");
  const wazari = await names(page, "[data-wazari-pricing-results]");
  for (const n of ["وينستون ازرق مخصص", "وينستون فضي مخصص", "وينستون احمر حرة", "صنف عام"]) {
    check(general.filter((x) => x === n).length === 1, `«${n}» مرة واحدة في العامة: ${general.join(" | ")}`);
    check(!wazari.includes(n), `«${n}» ليس في الوزاري`);
  }
  for (const n of ["وينستون فضي", "كينت أزرق", "نخلة محزر لبناني"]) {
    check(wazari.includes(n), `«${n}» في قسم الوزاري: ${wazari.join(" | ")}`);
    check(!general.includes(n), `«${n}» ليس في العامة`);
  }
  const wazariText = await page.locator('[data-pricing-section="wazari"]').innerText();
  check(/غير مسعّر/.test(wazariText), "غير المسعّر ظاهر في قسم الوزاري");
  check(/1 مسعّر · 2 غير مسعّر/.test(wazariText), `عدّاد قسم الوزاري: ${wazariText.slice(0, 300)}`);
  check(await page.locator('[data-wazari-pricing-results] [data-form="pricing-item"] input[name="wholesalePrice"]').count() === 3, "كل صنف وزاري له حقل سعر");
  check(await page.locator('[data-form="bulletin-classification"]').count() >= 7, "المالك يرى نموذج تصحيح التصنيف");
  const blueLine = await page.locator('[data-pricing-results] .pricing-card', { hasText: "وينستون ازرق مخصص" }).locator(".bulletin-class-line").innerText();
  check(/النشرة العامة/.test(blueLine) && /تصحيح مؤكد بمعرّف الأمين/.test(blueLine), `سطر تصنيف الوينستون المخصص: ${blueLine}`);
  check(writes.length === 0, `لا كتابة عند الفتح: ${writes.join(", ")}`);
  check(errors.length === 0, `أخطاء الصفحة: ${errors.join(" | ")}`);
  if (SHOTS) {
    await page.locator('[data-pricing-section="wazari"]').screenshot({ path: join(SHOTS, "owner-wazari-section.png") });
  }
  await context.close();
}

// ---- تصحيح المالك المحفوظ ينقل الصنف بين القسمين ----
{
  const { context, page, errors } = await openPricing({
    session: OWNER,
    viewport: { width: 1280, height: 900 },
    classifications: [
      { item_guid: "375EF607-3E41-491D-9546-E7BDE8B1BDF0", item_key: "وينستون فضي", bulletin: "general" },
      { item_guid: "294A7DC9-9BB3-4BEF-8791-F3C336AFD727", item_key: "وينستون ازرق مخصص", bulletin: "wazari" }
    ]
  });
  const general = await names(page, "[data-pricing-results]");
  const wazari = await names(page, "[data-wazari-pricing-results]");
  check(general.includes("وينستون فضي") && !wazari.includes("وينستون فضي"), "تصحيح المالك نقل «وينستون فضي» إلى العامة");
  check(wazari.includes("وينستون ازرق مخصص") && !general.includes("وينستون ازرق مخصص"), "تصحيح المالك يغلب التصحيح المثبّت");
  const moved = await page.locator('[data-pricing-results] .pricing-card', { hasText: "وينستون فضي" }).first().innerText();
  check(/700/.test(moved) && /710/.test(moved), `السعر المحفوظ كما هو بعد النقل: ${moved.slice(0, 200)}`);
  check(errors.length === 0, `أخطاء الصفحة: ${errors.join(" | ")}`);
  await context.close();
}

// ---- الموظف على iPhone ----
{
  const { context, page, errors, writes } = await openPricing({ session: STAFF, viewport: { width: 390, height: 844 } });
  check(await page.locator('[data-form="bulletin-classification"]').count() === 0, "الموظف لا يرى نموذج تصحيح التصنيف");
  check(await page.locator('[data-wazari-pricing-results] [data-form="pricing-item"]').count() === 3, "الموظف المخوّل يسعّر الوزاري بالحقول نفسها");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `فيض أفقي على iPhone: ${overflow}px`);
  check(writes.length === 0, `لا كتابة عند الفتح: ${writes.join(", ")}`);
  check(errors.length === 0, `أخطاء الصفحة: ${errors.join(" | ")}`);
  if (SHOTS) await page.locator('[data-pricing-section="wazari"]').screenshot({ path: join(SHOTS, "staff-phone-wazari-section.png") });
  await context.close();
}

await browser.close();
server.close();
console.log("check-bulletin-classification-ui:");
if (failures.length) {
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error(`check-bulletin-classification-ui: فشل ${failures.length}، نجح ${passed}`);
  process.exit(1);
}
console.log(`check-bulletin-classification-ui: اجتاز ${passed} فحصاً.`);
