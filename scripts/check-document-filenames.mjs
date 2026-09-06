// فحص انحدار لاسم ملف PDF المقترح لكل نوع مستند.
//
// العطل المُثبت (2026-09-06): اسم الملف اختفى من كل المستندات — النشرة خرجت
// باسم «نشرة الجملة (دولار)» أو باسم التبويب، والفواتير والسندات بلا اسم الزبون.
//
// ثلاثة أسباب متراكبة، كلها مغطّاة هنا:
//
//   1) **المتصفح لا يقرأ عنوان الإطار المطبوع.** قياس فعلي بكروميوم: مستند
//      داخل iframe عنوانه «فاتورة - حسن عباس - …» أخرج PDF حقلُ /Title فيه
//      عنوانَ **المستند الأعلى**. اسم «حفظ بصيغة PDF» في كروميوم يأتي من
//      `WebContents::GetTitle()` أي عنوان التبويب. فإصلاح 4a4af7f الذي فرض
//      العنوان داخل الإطار وحده لم يصل إلى المستخدم إطلاقاً.
//   2) **النشرة كانت تحسب اسم ملفها ثم ترميه:** `bulletinDocumentFilename`
//      يُمرَّر إلى `template.printDocument`، ثم يدهسه `printHtmlDocument` بـ
//      `bulletinDocumentTitle` («نشرة الجملة (دولار)») عبر `withDocumentTitle`.
//   3) **مسار الهاتف كان يستعمل اسماً مبنيّاً يدوياً** في كل موضع استدعاء
//      («سند-قبض-حسن_عباس-2026-09-06.pdf») لا الاسم المركزي — بشرطات سفلية
//      وبتاريخ اليوم بدل تاريخ المستند، ومختلف عن نسخة الأرشيف.
//
// الفحص سلوكي: الطبقة الأولى تشغّل دوال التسمية الحقيقية من `src/app.js`،
// والثانية تشغّل التطبيق كاملاً في كروميوم وترصد العنوان الذي حمله **المستند
// الأعلى** فعلاً أثناء الطباعة، وتقرأ /Title من PDF أخرجه محرك الطباعة نفسه.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import vm from "node:vm";
import { chromium } from "playwright";
import { buildFileName } from "../tools/mac-archive-bridge/lib/naming.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appJs = readFileSync(resolve(root, "src/app.js"), "utf8");

let failed = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); }
};

// ===========================================================================
// 1) القاعدة المركزية: الصيغ الستّ المطلوبة، بالكود الحقيقي
// ===========================================================================

const PATTERNS = {
  DOC_TYPE_LABELS: /const DOC_TYPE_LABELS = \{[\s\S]*?\n\};/,
  sanitizeDocumentTitle: /function sanitizeDocumentTitle\(value\) \{[\s\S]*?\n\}\n/,
  fileDateLabel: /function fileDateLabel\(isoDate\) \{[\s\S]*?\n\}\n/,
  NUMBERLESS_FILE_DOC_TYPES: /const NUMBERLESS_FILE_DOC_TYPES = [^\n]*\n/,
  archiveDocumentTitle: /function archiveDocumentTitle\(docType, meta\) \{[\s\S]*?\n\}\n/,
  documentFileName: /function documentFileName\(docType, meta\) \{[\s\S]*?\n\}\n/,
  bulletinCurrencyCode: /function bulletinCurrencyCode\(dataset\) \{[\s\S]*?\n\}\n/,
  bulletinDocumentFilename: /function bulletinDocumentFilename\(dataset\) \{[\s\S]*?\n\}\n/
};

const pieces = [];
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const found = appJs.match(pattern);
  if (!found) { failed += 1; console.error(`  ❌ استخراج ${name} من src/app.js`); continue; }
  pieces.push(found[0]);
}

const DATE = "2026-09-06";
const sandbox = { console, todayIsoDate: () => DATE };
vm.createContext(sandbox);
vm.runInContext(pieces.join("\n"), sandbox);
const { archiveDocumentTitle, documentFileName, bulletinDocumentFilename } = sandbox;

// الصيغ المطلوبة حرفياً — أي انحراف عنها هو العطل نفسه عائداً.
const CASES = [
  ["bulletin USD", bulletinDocumentFilename({ useSyria: false }) + ".pdf",
    `نشرة-الأسعار-USD-${DATE}.pdf`],
  ["bulletin SYP", bulletinDocumentFilename({ useSyria: true }) + ".pdf",
    `نشرة-الأسعار-SYP-${DATE}.pdf`],
  ["customer invoice (اسم عربي)",
    documentFileName("invoice", { party: "حسن عباس", number: "562", date: DATE }),
    `فاتورة - حسن عباس - رقم 562 - ${DATE}.pdf`],
  ["receipt / سند قبض",
    documentFileName("receipt", { party: "حسن عباس", number: "R-20260906-4821", date: DATE }),
    `سند قبض - حسن عباس - ${DATE}.pdf`],
  ["payment / سند صرف",
    documentFileName("payment", { party: "أبو زياد للنقل", number: "PV-20260906-1122", date: DATE }),
    `سند صرف - أبو زياد للنقل - ${DATE}.pdf`],
  ["return invoice / فاتورة مرتجع",
    documentFileName("return_invoice", { party: "سامر الأحمد", number: "44", date: DATE }),
    `فاتورة مرتجع - سامر الأحمد - رقم 44 - ${DATE}.pdf`]
];

console.log("١) القاعدة المركزية لاسم الملف:");
for (const [label, actual, expected] of CASES) {
  check(`${label} → ${expected}`, actual === expected, `الناتج: ${actual}`);
}

// الأسماء العربية تصل كما هي: لا شرطة سفلية ولا حذف فراغات (عطل الاسم القديم).
check("لا شرطات سفلية في أي اسم", CASES.every(([, a]) => !a.includes("_")),
  CASES.map(([, a]) => a).join(" | "));
// التاريخ بصيغة ISO في كل الأنواع = نفس صيغة اسم النسخة المؤرشفة.
check("التاريخ ISO في كل الأنواع", CASES.every(([, a]) => a.includes(DATE)),
  CASES.map(([, a]) => a).join(" | "));
// رقم السند العشوائي لا يدخل الاسم، ورقم الفاتورة الحقيقي يدخله.
check("رقم السند المولَّد محلياً لا يظهر في اسم السند",
  !CASES[3][1].includes("R-2026") && !CASES[4][1].includes("PV-2026"),
  `${CASES[3][1]} | ${CASES[4][1]}`);
check("رقم الفاتورة يبقى في اسم الفاتورة والمرتجع",
  CASES[2][1].includes("رقم 562") && CASES[5][1].includes("رقم 44"),
  `${CASES[2][1]} | ${CASES[5][1]}`);
// بيانات ناقصة لا تُنتج حشواً ولا اسماً مكسوراً.
check("طرف بلا تاريخ صالح: الاسم يبقى نظيفاً",
  archiveDocumentTitle("receipt", { party: "حسن عباس" }) === "سند قبض - حسن عباس",
  archiveDocumentTitle("receipt", { party: "حسن عباس" }));
check("نشرة بلا عملة لا تُخرج شرطة مزدوجة",
  archiveDocumentTitle("price_list", { date: DATE }) === `نشرة-الأسعار-${DATE}`,
  archiveDocumentTitle("price_list", { date: DATE }));

// ===========================================================================
// 1ب) تطابق التنفيذين: اسم الملف المنزَّل === اسم النسخة المؤرشفة
// ===========================================================================
//
// قاعدة التسمية مكتوبة مرّتين بالضرورة: مرة في `src/app.js` (سكربت متصفح
// كلاسيكي بلا build step) ومرة في `tools/mac-archive-bridge/lib/naming.mjs`
// (عملية Node على الماك، وهي **السلطة الوحيدة** على اسم الأرشيف لأن الموقع لا
// يرسل اسم ملف ولا مساراً — قرار أمني). لا يمكن مشاركة وحدة واحدة بينهما،
// فالضمان الوحيد المتاح هو مقارنة **ناتج التنفيذين** لكل نوع مستند هنا.
// أي انحراف بينهما يعني أن المالك يرى اسمين مختلفين لنفس المستند.

console.log("\n١ب) اسم الملف المنزَّل مقابل اسم النسخة في iCloud:");
const TODAY = new Date(`${DATE}T00:00:00Z`);
const PARITY = [
  ["invoice", { party: "حسن عباس", number: "562", date: DATE }],
  ["return_invoice", { party: "سامر الأحمد", number: "44", date: DATE }],
  ["receipt", { party: "حسن عباس", number: "R-20260906-4821", date: DATE }],
  ["payment", { party: "أبو زياد للنقل", number: "PV-20260906-1122", date: DATE }],
  ["price_list", { currency: "USD", date: DATE }],
  ["price_list", { currency: "SYP", date: DATE }],
  ["account_statement", { party: "حسن عباس", date: DATE }],
  ["stock_report", { date: DATE }],
  ["receivables_report", { date: DATE }],
  ["purchase_invoice", { party: "مورد الشام", number: "31", date: DATE }],
  ["other_report", { title: "تقرير المواد الراكدة", date: DATE }]
];
for (const [docType, meta] of PARITY) {
  const downloaded = documentFileName(docType, meta);
  const archived = buildFileName(docType, meta, TODAY).name;
  check(`${docType}: الاسمان متطابقان (${downloaded})`, downloaded === archived,
    `المنزَّل: ${downloaded}\n     المؤرشف: ${archived}`);
}

// ===========================================================================
// 2) داخل متصفح حقيقي: هل يصل الاسم إلى محرك الطباعة؟
// ===========================================================================

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8"
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

/** يقرأ /Title من بايتات PDF أخرجها محرك الطباعة (نص حرفي أو UTF-16BE). */
function pdfTitle(buffer) {
  const raw = buffer.toString("latin1");
  const m = raw.match(/\/Title\s*(\(([^)]*)\)|<([0-9A-Fa-f\s]+)>)/);
  if (!m) return null;
  if (m[2] !== undefined) return m[2];
  const bytes = Buffer.from(m[3].replace(/\s/g, "").match(/../g).map((h) => parseInt(h, 16)));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const be = Buffer.from(bytes.subarray(2));
    for (let i = 0; i + 1 < be.length; i += 2) { const t = be[i]; be[i] = be[i + 1]; be[i + 1] = t; }
    return be.toString("utf16le");
  }
  return bytes.toString("utf8");
}

const browser = await chromium.launch();

// --- 2أ) الحارس البنيوي: عنوان الإطار وحده لا يكفي، وعنوان المستند الأعلى يكفي
console.log("\n٢) محرك الطباعة الحقيقي — أي عنوان يلتقطه؟");
{
  const page = await browser.newPage();
  const PARENT = "OZK TOBACCO | خدمة العملاء";
  const FRAME = "فاتورة - حسن عباس - رقم 562 - 2026-09-06";
  await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">`
    + `<title>${PARENT}</title></head><body><p>واجهة</p></body></html>`);
  await page.evaluate((t) => {
    const f = document.createElement("iframe");
    f.setAttribute("data-probe-frame", "");
    f.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;height:1123px;opacity:0;border:0";
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body><h1>x</h1></body></html>`;
    document.body.appendChild(f);
  }, FRAME);
  await page.waitForTimeout(300);

  const withFrameTitleOnly = pdfTitle(await page.pdf({ format: "A4" }));
  check("عنوان الإطار المطبوع وحده لا يصل إلى محرك الطباعة (سبب العطل الجذري)",
    withFrameTitleOnly !== FRAME,
    `/Title = ${JSON.stringify(withFrameTitleOnly)} — لو صار يساوي عنوان الإطار فقد تغيّر سلوك المتصفح وتجب مراجعة الإصلاح`);

  await page.evaluate((t) => { document.title = t; }, FRAME);
  const withTopTitle = pdfTitle(await page.pdf({ format: "A4" }));
  check("عنوان المستند الأعلى هو ما يلتقطه محرك الطباعة (أساس الإصلاح)",
    withTopTitle === FRAME, `/Title = ${JSON.stringify(withTopTitle)}`);
  await page.close();
}

// --- 2ب) التطبيق نفسه: ما العنوان الذي حمله المستند الأعلى أثناء كل تصدير؟
console.log("\n٣) مسارات التصدير الحقيقية داخل التطبيق:");

const ITEMS = [
  { key: "m1", name: "ماستر طويل أزرق", groupName: "ماستر", stockQty: 400, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "g1", name: "غلواز أزرق", groupName: "غلواز", stockQty: 300, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 }
];
const PRICES = ITEMS.map((item, i) => ({
  itemKey: item.key, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50,
  unit2Price: 300 + i, pricePayload: { retail: { price: 320 + i } },
  updatedAt: "2026-09-01T00:00:00.000Z"
}));

const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
await page.route("**://*.supabase.co/**", (route) => route.abort());
await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.buildBulletinDataset === "function", null, { timeout: 20000 });
await page.waitForFunction(() => { try { return (0, eval)("state").loading === false; } catch { return false; } }, null, { timeout: 30000 });
await page.evaluate(({ items, prices }) => {
  const state = (0, eval)("state");
  state.inventoryReports = [{ items, summary: { syncedAt: "2026-09-01T00:00:00.000Z" } }];
  state.approvedPriceItems = prices;
  state.syriaExchangeRate = 14050;
  state.syriaRateConfirmed = true;
  // نرصد كل قيمة يأخذها عنوان المستند الأعلى — هو ما يقرأه المتصفح.
  window.__titles = [];
  new MutationObserver(() => window.__titles.push(document.title))
    .observe(document.head, { childList: true, subtree: true, characterData: true });
}, { items: ITEMS, prices: PRICES });

const today = await page.evaluate(() => window.todayIsoDate());
const BASE_TITLE = await page.title();

/** يشغّل مسار تصدير حقيقياً ويعيد العناوين التي حملها المستند الأعلى أثناءه. */
async function titlesDuring(trigger) {
  await page.evaluate(() => { window.__titles = []; });
  await page.evaluate(trigger);
  await page.waitForTimeout(400);
  return page.evaluate(() => window.__titles.slice());
}

const VOUCHER_DATE = "2026-09-06";
const EXPECTED = [
  ["bulletin USD", `نشرة-الأسعار-USD-${today}`,
    () => window.exportBulletinPdf(window.buildBulletinDataset(false, "dark").dataset)],
  ["bulletin SYP", `نشرة-الأسعار-SYP-${today}`,
    () => window.exportBulletinPdf(window.buildBulletinDataset(true, "dark").dataset)],
  ["customer invoice", `فاتورة - حسن عباس - رقم 562 - ${VOUCHER_DATE}`,
    () => window.exportVoucherPdf({ type: "invoice", name: "حسن عباس", no: "562", date: "2026-09-06", cur: "$", amount: 200, balance: 0, lines: [] })],
  ["receipt", `سند قبض - حسن عباس - ${VOUCHER_DATE}`,
    () => window.exportVoucherPdf({ type: "receipt", name: "حسن عباس", no: "R-20260906-4821", date: "2026-09-06", cur: "$", amount: 50, balance: 0 })],
  ["payment", `سند صرف - أبو زياد للنقل - ${VOUCHER_DATE}`,
    () => window.exportVoucherPdf({ type: "payment", name: "أبو زياد للنقل", no: "PV-20260906-1122", date: "2026-09-06", cur: "ل.س", amount: 90000, balance: 0 })],
  ["return invoice", `فاتورة مرتجع - سامر الأحمد - رقم 44 - ${VOUCHER_DATE}`,
    () => window.exportVoucherPdf({ type: "return", name: "سامر الأحمد", no: "44", date: "2026-09-06", cur: "$", amount: 30, balance: 0, lines: [] })]
];

for (const [label, expected, trigger] of EXPECTED) {
  const titles = await titlesDuring(trigger);
  check(`${label}: عنوان المستند الأعلى أثناء الطباعة = ${expected}`,
    titles.includes(expected),
    `العناوين المرصودة: ${JSON.stringify(titles)}`);
}

// العنوان يُعاد بعد الطباعة: تبويب يبقى باسم فاتورة زبون بعد إغلاق ورقة الطباعة عطل بذاته.
await page.evaluate(() => {
  const frame = document.querySelector("iframe[data-print-frame]");
  if (frame && frame.contentWindow) frame.contentWindow.dispatchEvent(new Event("afterprint"));
});
await page.waitForTimeout(200);
check("عنوان التبويب يعود إلى أصله بعد انتهاء الطباعة",
  (await page.title()) === BASE_TITLE,
  `العنوان الآن: ${await page.title()} — المتوقع: ${BASE_TITLE}`);

check("لا أخطاء صفحة أثناء مسارات التصدير", pageErrors.length === 0, pageErrors.join(" | "));

// --- 2ج) مسار الهاتف: نفس الاسم يصل إلى التنزيل/المشاركة
console.log("\n٤) مسار الهاتف (تنزيل / مشاركة في الملفات):");
{
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    bypassCSP: true, serviceWorkers: "block"
  });
  const mp = await mobile.newPage();
  await mp.route("**://*.supabase.co/**", (route) => route.abort());
  await mp.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await mp.waitForFunction(() => typeof window.exportVoucherPdf === "function", null, { timeout: 20000 });
  await mp.waitForFunction(() => { try { return (0, eval)("state").loading === false; } catch { return false; } }, null, { timeout: 30000 });

  const handheld = await mp.evaluate(() => window.isHandheldDevice());
  check("سياق الهاتف يسلك مسار الهاتف فعلاً", handheld === true, `isHandheldDevice() = ${handheld}`);

  // نستبدل توليد الـPDF وحده (مكلف وخارج نطاق هذا الفحص) ونرصد الاسم المسلَّم.
  const captured = await mp.evaluate(async () => {
    const realBlob = window.createPortablePdfBlob;
    const realPresent = window.presentPortablePdf;
    const seen = [];
    window.createPortablePdfBlob = async () => new Blob(["%PDF-1.4"], { type: "application/pdf" });
    window.presentPortablePdf = (blob, filename, title) => { seen.push({ filename, title }); };
    try {
      await window.exportVoucherPdf({ type: "receipt", name: "حسن عباس", no: "R-20260906-4821", date: "2026-09-06", cur: "$", amount: 50, balance: 0 });
      await window.exportVoucherPdf({ type: "invoice", name: "حسن عباس", no: "562", date: "2026-09-06", cur: "$", amount: 200, balance: 0, lines: [] });
    } finally {
      window.createPortablePdfBlob = realBlob;
      window.presentPortablePdf = realPresent;
    }
    return seen;
  });

  check("سند قبض على الهاتف: اسم التنزيل/المشاركة صحيح",
    captured[0] && captured[0].filename === `سند قبض - حسن عباس - ${VOUCHER_DATE}.pdf`,
    JSON.stringify(captured[0]));
  check("فاتورة زبون على الهاتف: اسم التنزيل/المشاركة صحيح",
    captured[1] && captured[1].filename === `فاتورة - حسن عباس - رقم 562 - ${VOUCHER_DATE}.pdf`,
    JSON.stringify(captured[1]));
  check("لا شرطات سفلية في أسماء الهاتف (عطل الاسم المبنيّ يدوياً)",
    captured.every((c) => !String(c.filename).includes("_")),
    JSON.stringify(captured));
  await mobile.close();
}

// ===========================================================================
// 3) حارس المصدر الواحد: لا قاعدة تسمية ثانية
// ===========================================================================
console.log("\n٥) حارس المصدر الواحد:");
check("`exportReportPdf` لا يقبل اسم ملف من المستدعي",
  /async function exportReportPdf\(bodyHtml, archive\)/.test(appJs),
  "توقيع الدالة عاد يقبل اسم ملف مبنيّاً في موضع الاستدعاء");
check("`printHtmlDocument` يرفع العنوان إلى المستند الأعلى",
  appJs.includes("const releasePrintTitle = holdPrintDocumentTitle(options.title);")
  && appJs.includes("releasePrintTitle();"),
  "العنوان لم يعد يُرفع/يُعاد — يعود العطل الجذري");
check("النشرة تمرّر اسم الملف لا التسمية البشرية إلى الطباعة",
  /printHtmlDocument\(documentHtml, \{\s*\n\s*title: fileTitle,/.test(appJs),
  "عاد `title` البشري يدهس اسم ملف النشرة");
check("صيغة تسمية النشرة تُبنى داخل القاعدة المركزية وحدها",
  (appJs.match(/نشرة-الأسعار/g) || []).length === 1,
  "صيغة اسم النشرة مكرّرة في أكثر من موضع");
// إطار الطباعة يجب أن يُملأ قبل إدراجه، وإلا التقط معالجُ load مستندَ
// about:blank الأولي: فلا يصل afterprint ولا يُعاد عنوان التبويب أبداً.
check("srcdoc يُضبط قبل إدراج إطار الطباعة",
  appJs.indexOf("frame.srcdoc = withDocumentTitle(html, options.title);")
    < appJs.indexOf("document.body.appendChild(frame);"),
  "عاد الإطار يُدرَج قبل ملئه، فيلتقط load مستند about:blank الأولي");

await context.close();
await browser.close();
server.close();

if (failed) { console.error(`\n✗ فشل ${failed} فحصاً لاسم ملف المستندات.`); process.exit(1); }
console.log("\n✓ كل فحوص اسم ملف المستندات نجحت.");
