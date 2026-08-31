// حارس تجربة «حفظ / مشاركة PDF» على الهاتف.
//
// مكمّل لـ`check-price-bulletin-export-integrity.mjs` ولا يكرّره: ذاك يغطّي وجود
// زرَّي الإغلاق والتصدير داخل الشاشة، وأهداف اللمس 44px، وثبات شريط الإجراءات،
// وغياب الفيض الأفقي، وEscape، وزر رجوع المتصفح. هذا الملف يغطّي ما بعده:
//
//   1) **الشرح**: الحفظ والمشاركة يجريان في نافذة النظام لا داخل الصفحة. بلا
//      هذا الشرح تبدو النقرة على الهاتف وكأنها لم تفعل شيئاً.
//   2) **الحجب**: حين يمنع المتصفح فتح نافذة الطباعة تبقى المعاينة مفتوحة ويظهر
//      سبب صريح وزر إعادة محاولة يعمل فعلاً — بدل شاشة صامتة بلا مخرج.
//   3) **التنظيف**: إطار الطباعة المخفي يُسقَط عند الإغلاق بدل انتظار afterprint
//      (لا يصل كثيراً على iOS) أو مهلة الستين ثانية.
//   4) **لا ادّعاء كاذب**: لا Blob ولا navigator.share({files}) ولا تنزيل مباشر
//      في مسار النشرة — مسار الـBlob القديم هو نفسه سبب عطل PDF على الهاتف.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8"
};
const server = createServer((req, res) => {
  const clean = decodeURIComponent(String(req.url || "/").split("?")[0]);
  let target = normalize(join(root, clean === "/" ? "/index.html" : clean));
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) target = join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(target)] || "application/octet-stream");
  createReadStream(target).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); }
};

// ===== 0) حارس المصدر: مسار النشرة لا يدّعي مشاركة أصلية ولا تنزيلاً =====
{
  const appJs = readFileSync(resolve(root, "src/app.js"), "utf8");
  const exportFn = appJs.match(/function exportBulletinPdf\([\s\S]*?\n\}/)?.[0] || "";
  // نفحص **الكود** لا التعليقات: التعليق الذي يشرح لماذا لا نستعمل هذه المسارات
  // يذكر أسماءها بالضرورة، فمطابقته تجعل الحارس يفشل على توثيقه نفسه.
  const exportCode = exportFn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of ["navigator.share", "createPortablePdfBlob", "presentPortablePdf", "new Blob"]) {
    check(`مسار تصدير النشرة لا يستعمل ${forbidden}`, !exportCode.includes(forbidden),
      `وُجد ${forbidden} داخل exportBulletinPdf — الحفظ والمشاركة يجب أن يبقيا عبر نافذة النظام`);
  }
  check("زر التصدير يحمل تسمية «حفظ / مشاركة PDF»", appJs.includes("حفظ / مشاركة PDF"),
    "التسمية القديمة «تصدير PDF» لا تشرح أن الحفظ يجري في نافذة النظام");
}

const raw = JSON.parse(readFileSync(resolve(root, "scripts/price-data.json"), "utf8"));
const ITEMS = raw.map((r) => ({
  key: r.item_key, name: r.name, groupName: r.group,
  stockQty: (r.unitFactor || 50) * 8,
  unit1Name: r.unit1 || "كروز", unit2Name: r.unit || "كرتونة", unit2Factor: r.unitFactor || 50
}));
const PRICES = raw.map((r) => ({
  itemKey: r.item_key, unit1Name: r.unit1 || "كروز", unit2Name: r.unit || "كرتونة",
  unit2Factor: r.unitFactor || 50, unit2Price: r.usd,
  pricePayload: { retail: { price: r.usd } }, updatedAt: "2026-08-31T00:00:00.000Z"
}));

const browser = await chromium.launch();
// مقاس هاتف حقيقي: هذه التجربة كلها موجّهة إليه.
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, bypassCSP: true, serviceWorkers: "block",
  deviceScaleFactor: 2, isMobile: true, hasTouch: true
});
const page = await ctx.newPage();
await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.buildBulletinDataset === "function", null, { timeout: 20000 });
await page.evaluate(({ items, prices }) => {
  const state = (0, eval)("state");
  const reports = [{ items, summary: { syncedAt: "2026-08-31T00:00:00.000Z" } }];
  window.tobaccoData.isConfigured = () => false;
  window.tobaccoData.listInventoryReports = async () => reports;
  window.tobaccoData.listApprovedPriceItems = async () => prices;
  window.tobaccoData.getSyriaExchangeRate = async () => 14050;
  window.tobaccoData.setSyriaExchangeRate = async (v) => Number(v);
  state.inventoryReports = reports;
  state.approvedPriceItems = prices;
  state.syriaExchangeRate = 14050;
  state.syriaRateConfirmed = true;
}, { items: ITEMS, prices: PRICES });

const boxOf = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), left: +r.left.toFixed(1),
           right: +r.right.toFixed(1), h: +r.height.toFixed(1) };
}, sel);
const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
const onScreen = (b) => b && b.top >= 0 && b.bottom <= view.h + 0.5 && b.left >= 0 && b.right <= view.w + 0.5;

// ===== 1) الشرح ظاهر قبل أي ضغط =====
await page.evaluate(() => window.openPricePreview(false, "dark"));
await page.waitForSelector("[data-action='export-price-preview']", { timeout: 10000 });
{
  const hint = await page.evaluate(() => {
    const el = document.querySelector(".price-preview-hint");
    return el ? { text: el.textContent.trim(), position: getComputedStyle(el).position } : null;
  });
  check("شريط الشرح ظاهر داخل المعاينة قبل الضغط", Boolean(hint), "لا شريط شرح");
  check("الشرح يذكر أن الحفظ/المشاركة يجريان في نافذة النظام",
    Boolean(hint) && /نافذة الطباعة في نظامك|نافذة النظام/.test(hint.text) && /حفظ بصيغة PDF/.test(hint.text),
    `النص = ${hint?.text?.slice(0, 90)}`);
  check("الشرح يوضّح أن التنزيل لا يجري داخل الصفحة",
    Boolean(hint) && /لا يجري التنزيل داخل الصفحة/.test(hint.text),
    `النص = ${hint?.text?.slice(0, 90)}`);
  check("شريط الشرح ملتصق فلا يختفي بالتمرير", hint?.position === "sticky", `position = ${hint?.position}`);
  check("زر التصدير يعرض «حفظ / مشاركة PDF» على الشاشة",
    (await page.evaluate(() => document.querySelector("[data-action='export-price-preview']")?.textContent.trim() || ""))
      .includes("حفظ / مشاركة PDF"), "تسمية الزر لا تطابق");
}

// ===== 2) بعد الضغط: حالة «فُتحت نافذة النظام» والمعاينة تبقى مفتوحة =====
{
  await page.evaluate(() => { window.__printCalls = 0; window.printHtmlDocument = () => { window.__printCalls += 1; }; });
  await page.click("[data-action='export-price-preview']");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    calls: window.__printCalls,
    hint: document.querySelector(".price-preview-hint")?.textContent.trim() || "",
    open: Boolean((0, eval)("state").pricePreview)
  }));
  check("النقرة تفتح مستند طباعة واحداً", after.calls === 1, `عدد الاستدعاءات = ${after.calls}`);
  check("بعد الضغط يظهر أن نافذة النظام فُتحت", /فُتحت نافذة النظام/.test(after.hint), after.hint.slice(0, 90));
  check("المعاينة تبقى مفتوحة بعد التصدير (وإلا استحالت إعادة المحاولة)", after.open === true, "أُغلقت");
}

// ===== 3) الحجب: سبب صريح + زر إعادة محاولة يعمل =====
{
  await page.evaluate(() => {
    window.__retryCalls = 0;
    window.printHtmlDocument = (html, options) => {
      window.__retryCalls += 1;
      if (options && typeof options.onError === "function") options.onError();
    };
  });
  await page.click("[data-action='export-price-preview']");
  await page.waitForTimeout(400);
  const blocked = await page.evaluate(() => ({
    hint: document.querySelector(".price-preview-hint")?.textContent.trim() || "",
    blockedClass: Boolean(document.querySelector(".price-preview-hint.is-blocked")),
    open: Boolean((0, eval)("state").pricePreview)
  }));
  check("الحجب يعرض سبباً صريحاً", /منع فتح نافذة الطباعة/.test(blocked.hint), blocked.hint.slice(0, 90));
  check("شريط الحجب يحمل صنفه البصري", blocked.blockedClass, "لا is-blocked");
  check("المعاينة تبقى مفتوحة بعد الحجب", blocked.open === true, "أُغلقت فلا مخرج ولا إعادة محاولة");

  const retry = await boxOf("[data-action='retry-price-print']");
  check("زر إعادة المحاولة ظاهر بالكامل على الشاشة", onScreen(retry), JSON.stringify(retry));
  check("زر إعادة المحاولة هدف لمس 44px على الأقل", Boolean(retry) && retry.h >= 44, `الارتفاع = ${retry?.h}`);

  const before = await page.evaluate(() => window.__retryCalls);
  await page.click("[data-action='retry-price-print']");
  await page.waitForTimeout(400);
  const afterRetry = await page.evaluate(() => window.__retryCalls);
  check("زر إعادة المحاولة يعيد تشغيل التصدير فعلاً", afterRetry === before + 1,
    `قبل=${before} بعد=${afterRetry}`);
}

// ===== 4) التنظيف: إطار الطباعة يُسقَط عند الإغلاق =====
{
  await page.evaluate(() => {
    // نعيد الدالة الحقيقية ثم نزرع إطاراً كما تفعل هي، ونتحقق أن الإغلاق يسقطه.
    const frame = document.createElement("iframe");
    frame.setAttribute("data-print-frame", "");
    document.body.appendChild(frame);
  });
  const beforeClose = await page.evaluate(() => document.querySelectorAll("iframe[data-print-frame]").length);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const afterClose = await page.evaluate(() => ({
    frames: document.querySelectorAll("iframe[data-print-frame]").length,
    open: Boolean((0, eval)("state").pricePreview)
  }));
  check("إطار طباعة موجود قبل الإغلاق (شرط صحة الفحص)", beforeClose >= 1, `العدد = ${beforeClose}`);
  check("Escape يغلق المعاينة", afterClose.open === false, "بقيت مفتوحة");
  check("إطار الطباعة المخفي يُسقَط عند الإغلاق", afterClose.frames === 0, `بقي ${afterClose.frames} إطاراً`);
}

await browser.close();
server.close();

if (failed > 0) {
  console.error(`\n✗ فشل ${failed} فحصاً في تجربة حفظ/مشاركة النشرة.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص تجربة «حفظ / مشاركة PDF» نجحت.");
