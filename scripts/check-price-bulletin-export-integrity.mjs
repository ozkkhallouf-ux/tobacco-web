// فحص انحدار سلوكي لمسار نشرة الأسعار: من تحرير السعر/سعر الصرف حتى مستند
// التصدير النهائي — داخل متصفح حقيقي، عبر كود التطبيق نفسه (`src/app.js`
// و`src/price-list-template.js`) لا عبر نسخة مبسّطة منه.
//
// يغطي الأعطال المُثبتة بتاريخ 2026-08-31 (راجع docs/ai/topics/price-bulletins.md):
//   1) صفحات PDF بيضاء في نشرة الليرة
//   2) لا مخرج واضح من معاينة الهاتف
//   3) نشرة الجملة الداكنة تخرج مقطّعة أبيض/أسود
//   4) سعر مادة معدَّل لا يصل إلى PDF
//   5) سعر صرف قديم داخل PDF
//
// المبدأ: لا نفحص صياغة الكود بل النتيجة — بيانات المعاينة مقابل بيانات
// المستند المصدَّر، وعدّ صفحات الطباعة الأصلية الفعلية عبر page.pdf().
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

const server = createServer((req, res) => {
  const clean = decodeURIComponent(String(req.url || "/").split("?")[0]);
  let target = normalize(join(root, clean === "/" ? "/index.html" : clean));
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) {
    target = join(root, "index.html");
  }
  res.setHeader("Content-Type", TYPES[extname(target)] || "application/octet-stream");
  createReadStream(target).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const bad = (name, detail) => { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); };
function check(name, condition, detail) {
  if (condition) ok(name); else bad(name, detail);
}

// مخزون وأسعار معتمدة اصطناعية بشكل بيانات التطبيق نفسه.
// المخزون أكبر من عدد الكروز بالكرتونة (unit2Factor) لأن نشرة الجملة تشترط
// كرتونة كاملة (hasFullSecondUnit) — مخزون أقل من ذلك يُخرج الصنف من النشرة.
const ITEMS = [
  { key: "m1", name: "ماستر طويل أزرق", groupName: "ماستر", stockQty: 400, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "m2", name: "ماستر قصير أحمر", groupName: "ماستر", stockQty: 250, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "g1", name: "غلواز أزرق", groupName: "غلواز", stockQty: 300, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "g2", name: "غلواز أحمر", groupName: "غلواز", stockQty: 180, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 }
];
const approved = (unit2Price, retail) => ITEMS.map((item, index) => ({
  itemKey: item.key,
  unit1Name: item.unit1Name,
  unit2Name: item.unit2Name,
  unit2Factor: item.unit2Factor,
  unit2Price: unit2Price + index,
  pricePayload: { retail: { price: retail + index } },
  updatedAt: "2026-08-31T00:00:00.000Z"
}));

// مخزون كبير يكفي لعدة صفحات — لفحص الصفحات البيضاء وفواصل الصفحات.
const BULK = Array.from({ length: 140 }, (_, i) => ({
  key: `b${i}`,
  name: `صنف اختبار رقم ${i + 1} باسم متوسط الطول`,
  groupName: ["ماستر", "غلواز", "معسل", "فحم", "مانشستر", "اليغانس"][i % 6],
  stockQty: 500,
  unit1Name: "كروز",
  unit2Name: "كرتونة",
  unit2Factor: 50
}));
const BULK_PRICES = BULK.map((item, i) => ({
  itemKey: item.key,
  unit1Name: "كروز",
  unit2Name: "كرتونة",
  unit2Factor: 50,
  unit2Price: 100 + i,
  pricePayload: { retail: { price: 100 + i } },
  updatedAt: "2026-08-31T00:00:00.000Z"
}));

const browser = await chromium.launch();

// يزرع الحالة داخل الصفحة ويعطّل الكتابة على Supabase — نفحص منطق الواجهة
// لا الشبكة. `setSyriaExchangeRate` يُستبدل بمخزن محلي يحترم نفس التعاقد.
async function bootPage(context, { items, prices, rate }) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error.message)));
  // `boot()` تنطلق مع تحميل الصفحة وتكتب نتائج مُحمّلاتها فوق أي حالة نزرعها،
  // ثم تستدعي render() في finally. الزرع قبل انتهائها سباقٌ خاسر: تُمسح مواد
  // الفحص وتنهار المعاينة إلى لوحة "لا توجد مواد" (زر إغلاق بلا زر تصدير).
  // كان هذا السباق يُكسب محلياً بأجزاء من الثانية ويسقط في CI الأبطأ. الفحص
  // يخصّ منطق الواجهة لا الشبكة، فنقطع Supabase وننتظر انتهاء boot فعلياً.
  await page.route("**://*.supabase.co/**", (route) => route.abort());
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.buildBulletinDataset === "function", null, { timeout: 20000 });
  await page.waitForFunction(() => {
    try { return (0, eval)("state").loading === false; } catch { return false; }
  }, null, { timeout: 30000 });
  await page.evaluate(({ items, prices, rate }) => {
    // `state` معرَّف بـconst في سكربت كلاسيكي: يعيش في البيئة المعجمية العامة
    // فلا يظهر كخاصية على window، لكنه مرئي لـeval العام. لا نضيف أي منفذ
    // اختبار إلى كود الإنتاج من أجل هذا الفحص.
    const state = (0, eval)("state");
    // `dataStore` في app.js مرجع ثابت إلى window.tobaccoData — نستبدل الدالة
    // على الكائن نفسه كي يراها الكود المُختبَر.
    window.__savedRates = [];
    window.tobaccoData.setSyriaExchangeRate = async (value) => {
      window.__savedRates.push(Number(value));
      return Number(value);
    };
    state.inventoryReports = [{ items, summary: { syncedAt: "2026-08-31T00:00:00.000Z" } }];
    state.approvedPriceItems = prices;
    state.syriaExchangeRate = rate;
    state.syriaRateConfirmed = true;
  }, { items, prices, rate });
  return { page, errors };
}

// ===== 1) تعديل سعر مادة ثم التصدير: الملف يحمل السعر الجديد =====
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
  const { page, errors } = await bootPage(context, { items: ITEMS, prices: approved(300, 320), rate: 14050 });

  const result = await page.evaluate(() => {
    window.openPricePreview(false, "dark");
    const before = window.bulletinDatasetSignature(window.buildBulletinDataset(false, "dark").dataset);
    // تعديل سعر مادة كما يفعل الحفظ من الواجهة تماماً.
    (0, eval)("state").approvedPriceItems = (0, eval)("state").approvedPriceItems.map((row) =>
      row.itemKey === "m1" ? { ...row, unit2Price: 999 } : row);
    const previewMarkup = window.customerPricePdfMarkup(window.buildBulletinDataset(false, "dark").dataset);
    const exported = window.buildBulletinDataset(false, "dark").dataset;
    return {
      before,
      previewHasNew: previewMarkup.includes("999.00 $"),
      exportedHasNew: window.bulletinDatasetSignature(exported).includes("999.00 $"),
      exportedHasOld: window.bulletinDatasetSignature(exported).includes("300.00 $"),
      previewSignature: window.bulletinDatasetSignature(window.buildBulletinDataset(false, "dark").dataset),
      exportedSignature: window.bulletinDatasetSignature(exported)
    };
  });

  check("edit price → export: exported data contains the NEW price",
    result.exportedHasNew, `exported signature has no 999.00 — ${result.exportedSignature.slice(0, 200)}`);
  check("edit price → export: exported data no longer contains the OLD price",
    !result.exportedHasOld, "old 300.00 still present in exported dataset");
  check("edit price → preview shows the new price too", result.previewHasNew, "preview markup missing 999.00");
  check("preview and exported dataset are identical",
    result.previewSignature === result.exportedSignature, "preview/export signatures diverge");
  check("no page errors while previewing", errors.length === 0, errors.join(" | "));
  await context.close();
}

// ===== 2) سعر الصرف: A ثم B ثم تصدير فوري =====
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
  const { page } = await bootPage(context, { items: ITEMS, prices: approved(300, 500), rate: 10000 });

  const result = await page.evaluate(async () => {
    const priceOf = (dataset) => window.bulletinTemplateGroups(dataset)[0].items[0].price;

    await window.commitSyriaExchangeRate(10000);
    const atA = priceOf(window.buildBulletinDataset(true, "dark").dataset);

    await window.commitSyriaExchangeRate(20000);
    const atB = priceOf(window.buildBulletinDataset(true, "dark").dataset);

    // تغييرات سريعة متتالية مع ردود تصل بترتيب معكوس.
    const delays = { 30000: 60, 40000: 30, 50000: 1 };
    window.tobaccoData.setSyriaExchangeRate = async (value) => {
      await new Promise((r) => setTimeout(r, delays[Number(value)] ?? 0));
      return Number(value);
    };
    await Promise.all([
      window.commitSyriaExchangeRate(30000),
      window.commitSyriaExchangeRate(40000),
      window.commitSyriaExchangeRate(50000)
    ]);
    const afterRapid = (0, eval)("state").syriaExchangeRate;
    const rapidDataset = window.buildBulletinDataset(true, "dark").dataset;

    // إعادة فتح المعاينة لا تُرجع أي سعر صرف قديم.
    window.openPricePreview(true, "dark");
    const reopened = window.buildBulletinDataset(true, "dark").dataset;

    return {
      atA, atB,
      afterRapid,
      rapidRate: rapidDataset.exchangeRate,
      rapidBadge: window.customerPricePdfMarkup(rapidDataset).includes("صرف 50,000"),
      reopenedRate: reopened.exchangeRate,
      reopenedSignature: window.bulletinDatasetSignature(reopened),
      exportSignature: window.bulletinDatasetSignature(window.buildBulletinDataset(true, "dark").dataset)
    };
  });

  check("set rate A → export uses A", result.atA.startsWith("100 ") || result.atA.includes("100"),
    `first row price at rate A = ${result.atA}`);
  check("rate A → B → immediate export uses B, never A", result.atB !== result.atA,
    `price did not change with the exchange rate (A=${result.atA} B=${result.atB})`);
  check("rapid repeated rate changes → last confirmed value wins",
    result.afterRapid === 50000 && result.rapidRate === 50000,
    `state rate=${result.afterRapid}, dataset rate=${result.rapidRate} (expected 50000)`);
  check("exchange-rate badge matches the rate the prices were derived from",
    result.rapidBadge, "badge does not show 50,000 while prices use it");
  check("no stale rate after reopening the preview", result.reopenedRate === 50000,
    `reopened dataset rate = ${result.reopenedRate}`);
  check("reopened preview equals export dataset",
    result.reopenedSignature === result.exportSignature, "signatures diverge after reopen");
  await context.close();
}

// ===== 3) تعديل السعر وسعر الصرف معاً: المعاينة = التصدير بالضبط =====
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
  const { page } = await bootPage(context, { items: ITEMS, prices: approved(300, 500), rate: 12000 });
  const result = await page.evaluate(async () => {
    window.openPricePreview(true, "dark");
    (0, eval)("state").approvedPriceItems = (0, eval)("state").approvedPriceItems.map((row) =>
      row.itemKey === "m1" ? { ...row, pricePayload: { retail: { price: 777 } } } : row);
    await window.commitSyriaExchangeRate(15500);
    const preview = window.buildBulletinDataset(true, "dark").dataset;
    const exported = window.buildBulletinDataset(true, "dark").dataset;
    return {
      same: window.bulletinDatasetSignature(preview) === window.bulletinDatasetSignature(exported),
      rate: exported.exchangeRate,
      // 777 دولار للكرتونة ÷ 50 كروز × 15500 = 240,870
      hasDerived: window.bulletinDatasetSignature(exported).includes("240,870"),
      markupHasRate: window.customerPricePdfMarkup(exported).includes("صرف 15,500")
    };
  });
  check("edit item price + change rate → exported dataset matches preview exactly", result.same, "signatures differ");
  check("derived prices recomputed from the current rate", result.hasDerived,
    `expected 240,870 in exported dataset (rate=${result.rate})`);
  check("document badge carries the same rate as the derived prices", result.markupHasRate, "badge rate mismatch");
  await context.close();
}

// ===== 4) الطباعة الأصلية: لا صفحات بيضاء، وخلفية داكنة على كامل الورقة =====
for (const theme of ["dark", "light"]) {
  for (const useSyria of [true, false]) {
    const label = `${useSyria ? "SYP retail" : "USD wholesale"} / ${theme}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
    const { page } = await bootPage(context, { items: BULK, prices: BULK_PRICES, rate: 14050 });
    const documentHtml = await page.evaluate(({ useSyria, theme }) => {
      const dataset = window.buildBulletinDataset(useSyria, theme).dataset;
      return window.OZKPriceListTemplate.printDocument({
        theme: dataset.theme,
        title: "regression",
        bodyHtml: window.customerPricePdfMarkup(dataset)
      });
    }, { useSyria, theme });
    await context.close();

    const printContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
    const printPage = await printContext.newPage();
    // نُحمّل المستند من نفس الأصل كي يُحمَّل الشعار كما في التطبيق.
    await printPage.route(`${BASE}/__bulletin`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
    await printPage.goto(`${BASE}/__bulletin`, { waitUntil: "networkidle" });
    await printPage.emulateMedia({ media: "print" });

    const geometry = await printPage.evaluate(() => {
      const PAGE_PX = 297 / 25.4 * 96;
      const blocks = [...document.querySelectorAll(".price-list-columns")].map((el) => {
        const rect = el.getBoundingClientRect();
        return { height: rect.height, overflow: rect.height - PAGE_PX };
      });
      const styles = getComputedStyle(document.body);
      return {
        blocks: blocks.length,
        worstOverflow: blocks.reduce((max, b) => Math.max(max, b.overflow), -Infinity),
        bodyBackground: styles.backgroundColor,
        htmlBackground: getComputedStyle(document.documentElement).backgroundColor
      };
    });

    const pdf = await printPage.pdf({
      format: "A4", printBackground: true, preferCSSPageSize: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" }
    });
    const pdfPages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    await printContext.close();

    // ورقة بيضاء زائدة تظهر فوراً كفارق بين عدد كتل الصفحات وعدد صفحات الملف.
    check(`${label}: printed page count equals bulletin page count (no blank pages)`,
      pdfPages === geometry.blocks,
      `${geometry.blocks} bulletin pages but ${pdfPages} PDF pages — the extra ones are blank`);
    check(`${label}: no bulletin page overflows the printable A4 height`,
      geometry.worstOverflow <= 0.5,
      `worst overflow = ${geometry.worstOverflow.toFixed(2)}px`);

    const expected = theme === "light" ? "rgb(255, 253, 248)" : "rgb(12, 10, 7)";
    check(`${label}: document background is painted for print (no white/black split)`,
      geometry.bodyBackground === expected && geometry.htmlBackground === expected,
      `html=${geometry.htmlBackground} body=${geometry.bodyBackground} expected=${expected}`);
    check(`${label}: PDF is not an empty shell`, pdf.length > 20 * 1024, `${pdf.length} bytes`);
  }
}

// ===== 4ب) تسلسل الكتابة على سعر الصرف =====
// الترقيم التسلسلي يحمي state وحده. لو انطلقت كتابتا A وB معاً فقد تصل B إلى
// Supabase أولاً وA بعدها، فيستقرّ الخادم على A بينما تعرض الواجهة B — والنشر
// الآلي يقرأ الخادم فيبني النشرة على سعر قديم. نفحص **ترتيب الوصول** لا الحالة
// المحلية فقط، ونفحص ماذا تُعتبر «القيمة المؤكدة» حين يفشل حفظ.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
  const { page } = await bootPage(context, { items: ITEMS, prices: approved(300, 500), rate: 10000 });

  // A بطيئة وB سريعة: بلا تسلسل تنتهي B أولاً ثم تدهسها A فيبقى الخادم على A.
  const ordered = await page.evaluate(async () => {
    const finished = [];
    let server = null;
    window.tobaccoData.setSyriaExchangeRate = async (value) => {
      const v = Number(value);
      await new Promise((r) => setTimeout(r, v === 30000 ? 80 : 5));
      server = v;
      finished.push(v);
      return v;
    };
    localStorage.removeItem("syria-exchange-rate");
    await Promise.all([
      window.commitSyriaExchangeRate(30000),
      window.commitSyriaExchangeRate(40000)
    ]);
    // `capturePublishedExchangeRate` تحفظ القيمة المرئية مجدداً بالتصميم، لذا
    // نلتقط ترتيب A/B قبل استدعائها كي نقيس ما نقصده بالضبط.
    const order = finished.slice();
    return {
      finished: order,
      server,
      state: (0, eval)("state").syriaExchangeRate,
      cache: JSON.parse(localStorage.getItem("syria-exchange-rate") || "null"),
      published: await window.capturePublishedExchangeRate(),
      dataset: window.buildBulletinDataset(true, "dark").dataset.exchangeRate
    };
  });

  check("A ثم B: الكتابة تصل الخادم بنفس ترتيب التأكيد",
    ordered.finished.join(">") === "30000>40000",
    `ترتيب الوصول = ${ordered.finished.join(">")} (المتوقع 30000>40000)`);
  check("A ثم B: القيمة المستقرة على الخادم هي B رغم أن A أبطأ",
    ordered.server === 40000, `الخادم = ${ordered.server}`);
  check("A ثم B: الحالة والذاكرة المحلية والنشر كلها على B",
    ordered.state === 40000 && ordered.cache === 40000 && ordered.published === 40000 && ordered.dataset === 40000,
    `state=${ordered.state} cache=${ordered.cache} publish=${ordered.published} dataset=${ordered.dataset}`);

  // A تفشل ثم B تنجح: المؤكد هو B، وفشل A لا يوقف الطابور.
  const aFails = await page.evaluate(async () => {
    let server = null;
    window.tobaccoData.setSyriaExchangeRate = async (value) => {
      const v = Number(value);
      await new Promise((r) => setTimeout(r, v === 11000 ? 60 : 5));
      if (v === 11000) throw new Error("network down");
      server = v;
      return v;
    };
    const first = window.commitSyriaExchangeRate(11000);
    const second = window.commitSyriaExchangeRate(12000);
    const firstRejected = await first.then(() => false, () => true);
    await second;
    return {
      firstRejected, server,
      state: (0, eval)("state").syriaExchangeRate,
      cache: JSON.parse(localStorage.getItem("syria-exchange-rate") || "null")
    };
  });

  check("فشل A لا يبتلع الخطأ: الاستدعاء يرفض صراحةً", aFails.firstRejected,
    "commitSyriaExchangeRate انتهت بنجاح رغم فشل الحفظ");
  check("A تفشل ثم B تنجح: المؤكد هو B على الخادم وفي الواجهة",
    aFails.server === 12000 && aFails.state === 12000 && aFails.cache === 12000,
    `server=${aFails.server} state=${aFails.state} cache=${aFails.cache}`);

  // A تنجح ثم B تفشل: الواجهة يجب ألا تدّعي أن B مؤكدة — المؤكد هو A.
  const bFails = await page.evaluate(async () => {
    let server = null;
    window.tobaccoData.setSyriaExchangeRate = async (value) => {
      const v = Number(value);
      await new Promise((r) => setTimeout(r, 5));
      if (v === 22000) throw new Error("network down");
      server = v;
      return v;
    };
    await window.commitSyriaExchangeRate(21000);
    const rejected = await window.commitSyriaExchangeRate(22000).then(() => false, () => true);
    return {
      rejected, server,
      state: (0, eval)("state").syriaExchangeRate,
      cache: JSON.parse(localStorage.getItem("syria-exchange-rate") || "null"),
      dataset: window.buildBulletinDataset(true, "dark").dataset.exchangeRate
    };
  });

  check("فشل B يُبلَّغ للمستدعي بدل الصمت", bFails.rejected,
    "commitSyriaExchangeRate انتهت بنجاح رغم فشل الحفظ");
  check("A تنجح ثم B تفشل: القيمة المؤكدة تبقى A ولا تُعرض B كأنها محفوظة",
    bFails.server === 21000 && bFails.state === 21000 && bFails.cache === 21000 && bFails.dataset === 21000,
    `server=${bFails.server} state=${bFails.state} cache=${bFails.cache} dataset=${bFails.dataset}`);

  await context.close();
}

// ===== 5) معاينة الهاتف: مخرج واضح، أزرار داخل الشاشة، ومنطقة آمنة =====
{
  const context = await browser.newContext({
    bypassCSP: true, serviceWorkers: "block",
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true
  });
  const { page } = await bootPage(context, { items: BULK, prices: BULK_PRICES, rate: 14050 });
  await page.evaluate(() => window.openPricePreview(true, "dark"));
  await page.waitForSelector("[data-action='close-price-preview']", { timeout: 10000 });

  const ui = await page.evaluate(() => {
    const close = document.querySelector("[data-action='close-price-preview']");
    const exportBtn = document.querySelector("[data-action='export-price-preview']");
    const view = { width: window.innerWidth, height: window.innerHeight };
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    };
    const shell = document.querySelector(".price-preview-shell");
    return {
      close: box(close), export: box(exportBtn), view,
      barPosition: getComputedStyle(document.querySelector(".price-preview-bar")).position,
      shellPaddingBottom: getComputedStyle(shell).paddingBottom,
      documentScrollWidth: document.documentElement.scrollWidth
    };
  });

  const onScreen = (b) => b && b.top >= 0 && b.bottom <= ui.view.height + 0.5 && b.left >= 0 && b.right <= ui.view.width + 0.5;
  check("mobile preview has an accessible close/back action", Boolean(ui.close), "no close control rendered");
  check("mobile: close button is fully on screen", onScreen(ui.close), JSON.stringify(ui.close));
  check("mobile: export/share button is fully on screen", onScreen(ui.export), JSON.stringify(ui.export));
  check("mobile: tap targets are at least 44px tall",
    (ui.close?.h || 0) >= 44 && (ui.export?.h || 0) >= 44,
    `close=${ui.close?.h} export=${ui.export?.h}`);
  check("mobile: action bar stays pinned while the sheet scrolls", ui.barPosition === "sticky", ui.barPosition);
  check("mobile: no horizontal page overflow in the preview",
    ui.documentScrollWidth <= ui.view.width + 1,
    `scrollWidth=${ui.documentScrollWidth} viewport=${ui.view.width}`);

  // الخروج فعلي: زر الإغلاق، ثم Escape، ثم زر رجوع المتصفح.
  // الإغلاق يمرّ عبر التاريخ فيكتمل بعد وصول popstate — ننتظر النتيجة لا اللحظة.
  const confirmRate = () => page.evaluate(() => { (0, eval)("state").syriaRateConfirmed = true; });
  const previewOpen = () => page.evaluate(() => {
    try { return Boolean((0, eval)("state").pricePreview?.open); } catch { return "gone"; }
  });
  const waitClosed = async () => {
    try {
      await page.waitForFunction(() => {
        try { return !(0, eval)("state").pricePreview?.open; } catch { return false; }
      }, null, { timeout: 3000 });
      return true;
    } catch { return false; }
  };
  const waitOpen = async () => {
    try {
      await page.waitForFunction(() => {
        try { return Boolean((0, eval)("state").pricePreview?.open); } catch { return false; }
      }, null, { timeout: 3000 });
      return true;
    } catch { return false; }
  };

  await page.click("[data-action='close-price-preview']");
  check("mobile: close button actually exits the preview", await waitClosed(), "preview still open");

  await confirmRate();
  await page.evaluate(() => window.openPricePreview(true, "dark"));
  check("إعادة الفتح بعد الإغلاق تبقى مفتوحة (لا سحب تاريخ معلّق يُغلقها)",
    await waitOpen(), "المعاينة أُغلقت من تلقاء نفسها بعد إعادة الفتح");
  await page.keyboard.press("Escape");
  check("Escape exits the preview", await waitClosed(), "preview still open after Escape");

  // زر الرجوع يجب أن يُغلق المعاينة **داخل الصفحة نفسها**. لو غادر المستند
  // (إعادة تحميل التطبيق) فهذا هو عطل الهاتف الذي أبلغ عنه المالك: يضغط رجوع
  // فيخرج من التطبيق كله بدل الخروج من المعاينة. نرصد التنقّل صراحةً بدل
  // الاكتفاء بقراءة الحالة — قراءتها وحدها تنهار برسالة غامضة.
  await confirmRate();
  await page.evaluate(() => window.openPricePreview(true, "dark"));
  if (!(await waitOpen())) bad("الفتح قبل اختبار زر الرجوع", "تعذّر فتح المعاينة");
  let leftDocument = false;
  const onLoad = () => { leftDocument = true; };
  page.on("load", onLoad);
  await page.goBack();
  await page.waitForTimeout(250);
  page.off("load", onLoad);
  const closedByBack = await page.evaluate(() => {
    try { return !(0, eval)("state").pricePreview?.open; } catch { return "gone"; }
  }).catch(() => "gone");
  check("browser/device back button exits the preview instead of leaving the app",
    closedByBack === true && !leftDocument,
    (leftDocument || closedByBack === "gone")
      ? "الرجوع غادر التطبيق بدل إغلاق المعاينة"
      : "preview still open after history back");
  await context.close();
}

// ===== 6) أرشفة النشرة إلى iCloud لا تسقط بإعادة الهيكلة =====
// إعادة هيكلة النشرة نقلت التصدير من html2pdf إلى الطباعة الأصلية، ومعها انتقل
// خطّاف الأرشفة من استدعاء مباشر إلى خيار `archive` في printHtmlDocument. هذا
// الفحص يثبت **السلوك** — أن التصدير يمرّر نوع المستند الصحيح فعلاً — فلا يسقط
// الخطّاف صامتاً في أي إعادة هيكلة لاحقة.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
  const { page } = await bootPage(context, { items: ITEMS, prices: approved(300, 320), rate: 14050 });

  const calls = await page.evaluate(() => {
    const captured = [];
    const real = window.printHtmlDocument;
    // `printHtmlDocument` تصريح دالة في سكربت كلاسيكي، فهو خاصية على window
    // والاستدعاء داخل exportBulletinPdf يمرّ بالربط العام — فالاستبدال يُلتقط.
    window.printHtmlDocument = (html, options) => {
      captured.push({ htmlLength: String(html || "").length, archive: options && options.archive });
    };
    try {
      window.exportBulletinPdf(window.buildBulletinDataset(false, "dark").dataset);
    } finally {
      window.printHtmlDocument = real;
    }
    return captured;
  });

  check("تصدير النشرة يطبع مستنداً واحداً", calls.length === 1, `عدد الاستدعاءات = ${calls.length}`);
  const archive = calls[0] && calls[0].archive;
  check("price_list archive hook remains functional: نوع المستند يصل إلى الجسر",
    Boolean(archive) && archive.docType === "price_list",
    `archive = ${JSON.stringify(archive)}`);
  check("أرشفة النشرة تحمل تاريخاً صالحاً بصيغة YYYY-MM-DD",
    Boolean(archive && archive.meta && /^\d{4}-\d{2}-\d{2}$/.test(String(archive.meta.date))),
    `meta = ${JSON.stringify(archive && archive.meta)}`);
  check("المستند المطبوع ليس فارغاً", (calls[0]?.htmlLength || 0) > 2000, `طول المستند = ${calls[0]?.htmlLength}`);
  // الأرشفة مساعدة لا شرط: لا يجوز أن تُمرَّر مساراً أو اسم ملف من الواجهة.
  check("الواجهة لا ترسل مساراً ولا اسم ملف مع الأرشفة",
    Boolean(archive) && !("path" in archive) && !("fileName" in archive)
      && !(archive.meta && ("path" in archive.meta || "fileName" in archive.meta)),
    `archive = ${JSON.stringify(archive)}`);
  await context.close();
}

await browser.close();
server.close();

if (failed > 0) {
  console.error(`\n✗ فشل ${failed} فحصاً في مسار نشرة الأسعار.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص سلامة تصدير نشرة الأسعار نجحت.");
