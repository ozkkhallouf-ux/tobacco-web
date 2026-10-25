// ============================================================================
// حارس خط PDF الهاتف — الفاتورة 1100 (2026-10-25).
//
// العطل: PDF الهاتف (createPortablePdfBlob وsaveSalesInvoicePdf عبر html2pdf)
// يصوّر الفاتورة صورة JPEG بـhtml2canvas، فالخط «يُضمَّن» برسمه قبل التصوير لا
// كملف خط. الكود كان ينتظر Cairo بـOZK_FONT.ready() بسقف 3 ثوانٍ ثم يكمل التصدير
// بالخط الاحتياطي بصمت، والوجه الذي فشل تحميله لا يُعاد طلبه طوال الجلسة. على
// شبكة هاتف بطيئة خرجت فاتورة 1100 بخط النظام القديم. ثبت على WebKit حقيقي:
// حجب ملفات الخط ⇐ PDF ناجح بلا أي تنبيه وكل نصه بخط النظام.
//
// ما يحرسه:
//   ثابتاً: مسارا PDF الهاتف يستدعيان OZK_FONT.assertReady لا ready()؛ فاتورة الكاشير 80mm لا تُلمس.
//   حيّاً (Chromium بهيئة هاتف، html2pdf الحقيقي من public/vendor):
//   · فاتورة قصيرة وبشكل 1100 وطويلة تُصدَّر، وCairo هو المرسوم فعلاً، وعدد
//     الأوراق لا يزيد (قصيرة و1100 ورقة واحدة).
//   · فشل عابر في تحميل الخط ⇐ إعادة المحاولة تنجح ويخرج PDF بـCairo.
//   · خط محجوب كلياً ⇐ لا PDF، ورسالة عربية واضحة بدل الخط القديم.
// ============================================================================

import { chromium, devices } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) console.log(`  ✅ ${label}`);
  else { failed += 1; console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ""}`); }
}

// ===== 1) ثابت =====
const app = read("src/app.js");
const body = (name) => (app.match(new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`)) || [""])[0];
for (const name of ["createPortablePdfBlob", "saveSalesInvoicePdf"]) {
  const fn = body(name);
  check(`${name}: ينتظر الخط بـOZK_FONT.assertReady (لا تصدير بخط احتياطي صامت)`,
    fn.includes("await OZK_FONT.assertReady()") && !/OZK_FONT\.ready\(/.test(fn));
  check(`${name}: انتظار الخط يسبق html2pdf`, fn.indexOf("assertReady") > 0 && fn.indexOf("assertReady") < fn.indexOf("html2pdf()"));
}
const fontJs = read("src/ozk-font.js");
check("ozk-font.js: assertReady يرمي رسالة عربية قصيرة (تمرّ من safeErrorMessage)", (() => {
  const m = fontJs.match(/async function assertReady[\s\S]*?new Error\("([^"]+)"\)/);
  return m && m[1].length <= 120 && /Cairo/.test(m[1]) && !/Error:|\.js:\d/.test(m[1]);
})());
const receipt = (app.match(/function salesReceiptDocument\(data\) \{[\s\S]*?\n\}\n/) || [""])[0];
check("فاتورة الكاشير 80mm (XPRINTER) لا تمرّ بمسار PDF الهاتف ولا بالخط الرسمي",
  receipt.length > 0 && !receipt.includes("--ozk-font") && !receipt.includes("OZK_FONT"));

// ===== 2) حيّ =====
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8" };
const server = createServer((req, res) => {
  const clean = decodeURIComponent(String(req.url || "/").split("?")[0]);
  let target = normalize(join(root, clean === "/" ? "/index.html" : clean));
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) target = join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(target)] || "application/octet-stream");
  createReadStream(target).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const NAMES = ["مالبورو سيلفر فتح", "نابوليا سيلفر", "1970 قصير أزرق", "مزايا لوف", "علكة مثلج", "غلواز أحمر", "كابتن بلاك"];
const linesOf = (count) => Array.from({ length: count }, (_, i) => {
  const units = (i % 3) + 1;
  const price = [55, 17.5, 40, 8][i % 4];
  return { material: `${NAMES[i % NAMES.length]} ${i + 1}`, qty: units * 50, qtyUnits: units, unit1: "كروز", unit2: "كرتونة",
    price, lineTotal: Math.round(units * price * 100) / 100, lineTotalSource: "derived" };
});

// failFirst: عدد طلبات ملفات الخط الأولى التي تُرفض (فشل شبكة عابر)؛ Infinity = حجب كامل.
async function boot(failFirst = 0) {
  const context = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block", bypassCSP: true });
  const page = await context.newPage();
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  let fontRequests = 0;
  await page.route(/\/public\/fonts\/cairo\//, (route) => (++fontRequests <= failFirst ? route.abort() : route.continue()));
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.voucherPdfMarkup === "function" && window.html2pdf && typeof OZK_FONT !== "undefined",
    null, { timeout: 20000 });
  return { context, page, fontRequests: () => fontRequests };
}

const exportInvoice = (page, lines, options) => page.evaluate(async ({ lines, options }) => {
  const total = Math.round(lines.reduce((n, l) => n + l.lineTotal, 0) * 100) / 100;
  const html = window.voucherPdfMarkup({ type: "invoice", name: "زبون اختبار", amount: total, cur: "$", date: "2026-10-25", no: "9001", lines });
  try {
    const blob = await createPortablePdfBlob(html, "t.pdf", { width: BULLETIN_PAGE_WIDTH_PX });
    const text = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    return { ok: true, pages: (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length, usable: OZK_FONT.usable() };
  } catch (error) {
    return { ok: false, message: String(error && error.message || error), usable: OZK_FONT.usable() };
  }
}, { lines, options });

{
  const { context, page } = await boot();
  for (const [label, count, maxPages] of [["قصيرة (سطر واحد)", 1, 1], ["بشكل الفاتورة 1100 (11 سطراً)", 11, 1], ["طويلة (72 سطراً)", 72, 5]]) {
    const r = await exportInvoice(page, linesOf(count));
    check(`فاتورة ${label}: PDF الهاتف يُنشأ وCairo مرسوم فعلاً`, r.ok && r.usable, JSON.stringify(r));
    check(`فاتورة ${label}: الأوراق ${r.pages} ≤ ${maxPages} بلا ورقة زائدة`, r.ok && r.pages >= 1 && r.pages <= maxPages, JSON.stringify(r));
  }
  await context.close();
}

{
  // كل وجه يُطلب أولاً بمقطعه (عربي/لاتيني × 400/700): أول 4 طلبات ترفض = كل الأوجه تفشل مرة.
  const { context, page, fontRequests } = await boot(4);
  const before = await page.evaluate(() => OZK_FONT.ready(1500));
  const r = await exportInvoice(page, linesOf(11));
  check("فشل عابر في تحميل الخط: إعادة المحاولة تحمّل Cairo ويخرج PDF به", before === false && r.ok && r.usable,
    JSON.stringify({ before, ...r, fontRequests: fontRequests() }));
  await context.close();
}

{
  const { context, page } = await boot(Infinity);
  const started = Date.now();
  const r = await page.evaluate(async () => {
    try { await OZK_FONT.assertReady({ attempts: 2, timeoutMs: 800 }); return { ok: true }; } catch (error) { return { ok: false, message: String(error.message) }; }
  });
  check("خط محجوب: لا PDF بالخط القديم، ورسالة عربية واضحة", !r.ok && /Cairo/.test(r.message || "") && /تعذّر/.test(r.message || ""),
    JSON.stringify(r));
  check("خط محجوب: الحكم بسقف زمني ولا يعلق التطبيق", Date.now() - started < 15000, `${Date.now() - started}ms`);
  const full = await exportInvoice(page, linesOf(3));
  check("خط محجوب: createPortablePdfBlob يرفض التصدير بنفس الرسالة", !full.ok && /Cairo/.test(full.message || ""), JSON.stringify(full));
  await context.close();
}

await browser.close();
server.close();
if (failed) { console.error(`\n❌ check-portable-pdf-official-font: ${failed} فشل`); process.exit(1); }
console.log("\n✅ check-portable-pdf-official-font: PDF الهاتف لا يخرج إلا بخط Cairo");
