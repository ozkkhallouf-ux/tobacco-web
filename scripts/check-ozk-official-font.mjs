// ============================================================================
// حارس الخط الرسمي الموحّد (Cairo 3.130) — src/ozk-font.js.
//
// المرجع: «فاتورة-البسطة-OZK.pdf» (2026-10-22): pdffonts وجدول name في الخطوط
// المضمّنة = Cairo 3.130، Regular 400 وBold 700، fsType=0، ترخيص SIL OFL 1.1.
//
// ما يحرسه:
//   ثابتاً: ملفات woff2 الأربعة ببصمتها، الترخيص، تحميل ozk-font.js متزامناً
//   قبل كل سكربت defer، تخزينها في Service Worker، ولا سلسلة خط حرفية
//   (Tahoma/Segoe/Almarai/Google Fonts) خارج المصدر المركزي — باستثناء فاتورة
//   الكاشير 80mm المجمَّدة بقرار المالك (2026-10-22).
//   حيّاً (Chromium): الخط يجهز فعلاً بوزنيه وبالعربية والأرقام، فاتورة طويلة
//   متعددة الصفحات تُطبع PDF يضمّن Cairo-Regular وCairo-Bold وحدهما وتحمل كل
//   الأصناف والمبالغ، لا خلية مقصوصة، وصفوف لا تنقسم بين ورقتين، والاحتياط
//   يعمل حين يُحجب الخط.
// ============================================================================

import { chromium } from "playwright";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { pdfPageLines, normalizeArabic } from "./lib/price-bulletin-pdf-text.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) console.log(`  ✅ ${label}`);
  else { failed += 1; console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ""}`); }
}

// ===== 1) ثابت =====
await import("../src/ozk-font.js");
const FONT = globalThis.OZK_FONT;
check("OZK_FONT: Cairo 3.130 بوزنين 400/700 واحتياط Tahoma", FONT && FONT.FAMILY === "Cairo" && FONT.VERSION === "3.130"
  && JSON.stringify(FONT.WEIGHTS) === "[400,700]" && FONT.STACK === "Cairo,Tahoma,Arial,sans-serif");

const PINNED = {
  "public/fonts/cairo/cairo-3.130-arabic-400.woff2": "1b36945f5f6a3d1fed3783999b887d0c56cfd66a41a04212a28aa79abbdff0e1",
  "public/fonts/cairo/cairo-3.130-arabic-700.woff2": "673212b4908a9a6366ad6beb8a8a58c91bc3cb7e6cc4802b315a240c2dd80eb9",
  "public/fonts/cairo/cairo-3.130-latin-400.woff2": "1e12ba8a71e04bed2e7d75c3bb3f147b8650888a6a4ccd56c12931601ec3afe6",
  "public/fonts/cairo/cairo-3.130-latin-700.woff2": "c174069a5fe05b9a60a058a4d35553fbba7c5207ae979e8fcde5ebc4dacce5a0"
};
const declared = FONT.WEIGHTS.flatMap((w) => Object.keys(FONT.RANGES).map((s) => FONT.FILE(s, w))).sort();
check("الملفات المعلنة في ozk-font.js = الملفات المثبّتة", JSON.stringify(declared) === JSON.stringify(Object.keys(PINNED).sort()),
  declared.join(", "));
for (const [rel, sum] of Object.entries(PINNED)) {
  const bytes = existsSync(join(root, rel)) ? readFileSync(join(root, rel)) : null;
  check(`بصمة ${rel}`, bytes && bytes.subarray(0, 4).toString("latin1") === "wOF2"
    && createHash("sha256").update(bytes).digest("hex") === sum);
}
check("ترخيص SIL OFL 1.1 مرافق للخط", /SIL Open Font License, Version 1\.1/.test(read("public/fonts/cairo/OFL.txt")));

const indexHtml = read("index.html");
const fontTag = indexHtml.indexOf('<script src="src/ozk-font.js?v=tobacco-');
const firstDefer = indexHtml.search(/<script [^>]*\bdefer\b/);
check("index.html: ozk-font.js متزامن ويسبق كل سكربت defer", fontTag > 0 && firstDefer > fontTag
  && !/<script src="src\/ozk-font\.js[^>]*defer/.test(indexHtml));
const sw = read("public/service-worker.js");
check("Service Worker يخزّن ozk-font.js وملفات الخط", ["src/ozk-font.js", ...declared].every((a) => sw.includes(`"${a}"`)));

// لا سلسلة خط حرفية خارج المصدر المركزي. الاحتياط داخل var(--ozk-font, …) مسموح.
const LITERAL = /font-family\s*:(?!\s*(?:var\(--ozk-font|inherit|monospace))[^;"}]*(Tahoma|Segoe|Almarai|Arial)/gi;
const salesReceipt = (read("src/app.js").match(/function salesReceiptDocument\(data\) \{[\s\S]*?\n\}\n/) || [""])[0];
const SCANNED = ["src/app.js", "src/styles.css", "src/documents/invoice/ozk-invoice.js", "src/smart-inventory.js",
  "src/price-list-template.js", "receipt.html", "privacy-policy.html", "terms-of-use.html", "tech-support/styles.css",
  "scripts/generate-price-lists.mjs", "tools/ameen-autoprint/invoice-html.js"];
for (const rel of SCANNED) {
  // فاتورة الكاشير 80mm مستثناة حرفياً بقرار المالك: لا تُلمس.
  const source = rel === "src/app.js" ? read(rel).replace(salesReceipt, "") : read(rel);
  const hits = [...source.matchAll(LITERAL)].map((m) => m[0]);
  check(`${rel}: لا سلسلة خط حرفية خارج --ozk-font`, hits.length === 0, hits.join(" | "));
  check(`${rel}: لا Google Fonts`, !/fonts\.googleapis\.com/.test(source));
}
check("فاتورة الكاشير 80mm على خطها الأصلي (مجمَّدة)", /font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; line-height: 1\.5;/.test(salesReceipt));
check("فاتورة الكاشير 80mm لا تقرأ --ozk-font", salesReceipt.length > 0 && !salesReceipt.includes("--ozk-font"));
check("printHtmlDocument لا يحقن الخط إلا في مستند يقرأ --ozk-font (الكاشير 80mm تُطبع كما كانت)",
  /String\(html\)\.includes\("--ozk-font"\)\) html = OZK_FONT\.withFaces\(html\)/.test(read("src/app.js")));

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

const NAMES = ["نابوليا سيلفر", "1970 قصير أزرق", "مالبورو سيلفر فتح", "مزايا لوف", "علكة مثلج", "مالبورو غولد محزز",
  "عنب ونعنع", "الصفوة", "معسل الأسطورة", "بارما طويل أزرق", "سيدرز طويل فضي", "كورسير سليم", "روز طويل أزرق",
  "أفخم سليم", "فاخر أحمر", "اليننش طويل أسود", "ونستون فضي محفظ", "بلاتينيوم قصير طقتين", "مانشستر طويل أحمر",
  "حمرا قديمة", "ريد أحمر", "روز نكهات", "رويال طويل أزرق", "شرق قصير"];
const LINES = Array.from({ length: 72 }, (_, i) => {
  const qty = (i % 9) + 1;
  const price = [8, 55, 17.5, 10, 40, 80, 12, 7.5][i % 8];
  return { material: `${NAMES[i % NAMES.length]} ${i + 1}`, qty: qty * 50, qtyUnits: qty, unit1: "كروز", unit2: "كرتونة",
    price, lineTotal: Math.round(qty * price * 100) / 100, lineTotalSource: "derived" };
});
const TOTAL = Math.round(LINES.reduce((n, l) => n + l.lineTotal, 0) * 100) / 100;

async function boot({ blockFont = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**://*.supabase.co/**", (route) => route.abort());
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  if (blockFont) await page.route(/\/public\/fonts\/cairo\//, (route) => route.abort());
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.voucherPdfMarkup === "function" && typeof OZK_INVOICE !== "undefined", null, { timeout: 20000 });
  return { context, page };
}

const PROBE = () => {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;white-space:pre;font-size:40px;line-height:1";
  document.body.appendChild(probe);
  const width = (family, weight, text) => { probe.style.fontFamily = family; probe.style.fontWeight = String(weight); probe.textContent = text; return probe.getBoundingClientRect().width; };
  const out = [400, 700].every((w) => ["فاتورة البسطة", "0123456789"].every((t) =>
    Math.abs(width('"Cairo",monospace', w, t) - width("monospace", w, t)) > 0.5));
  probe.remove();
  return out;
};

{
  const { context, page } = await boot();
  const loaded = await page.evaluate(() => OZK_FONT.ready(10000));
  check("التطبيق: الأوجه الأربعة تُحمَّل (OZK_FONT.ready)", loaded === true);
  check("التطبيق: Cairo مستعمل فعلاً بالوزنين للعربية والأرقام", await page.evaluate(PROBE));
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  check("التطبيق: خط الواجهة يبدأ بـCairo", /^"?Cairo"?,/.test(bodyFont), bodyFont);

  // فاتورة مبيعات طويلة بالقالب الرئيسي الحقيقي، مستند مستقل كما يطبعه printHtmlDocument.
  const docHtml = await page.evaluate(({ lines, total }) => OZK_FONT.withFaces(
    `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>t</title></head><body>${window.voucherPdfMarkup({
      type: "invoice", name: "زبون اختبار", amount: total, cur: "$", date: "2026-10-22", no: "900", lines
    })}</body></html>`), { lines: LINES, total: TOTAL });
  await context.close();

  const ctx = await browser.newContext({ viewport: { width: 794, height: 1123 }, serviceWorkers: "block" });
  const p = await ctx.newPage();
  await p.route(`${BASE}/__ozk-font-doc`, (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: docHtml }));
  await p.goto(`${BASE}/__ozk-font-doc`, { waitUntil: "load" });
  await p.evaluate(() => document.fonts.ready);
  check("المستند المستقل: Cairo مستعمل فعلاً (عبر withFaces)", await p.evaluate(PROBE));
  await p.emulateMedia({ media: "print" });
  // القصّ يقع فقط في صندوق overflow غير visible (‎.qg يحتوي العائمَين بـoverflow:hidden).
  // مقاييس Cairo تُخرج مساحة محتوى السطر (1.874em) عن السطر نفسه، فبلا هامش
  // الحشوة في .qg تُقصّ ذيول «كروز/كرتونة» سفلياً.
  const clipped = await p.evaluate(() => [...document.querySelectorAll(".ozk-inv *")]
    .filter((el) => getComputedStyle(el).overflow !== "visible")
    .filter((el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
    .map((el) => el.textContent.trim().slice(0, 30)));
  check("لا خلية مقصوصة في جدول الأصناف", clipped.length === 0, clipped.slice(0, 5).join(" | "));
  const pdf = await p.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
  await ctx.close();

  const raw = pdf.toString("latin1");
  const fonts = [...new Set([...raw.matchAll(/\/FontName\s*\/[A-Z]{6}\+([A-Za-z0-9-]+)/g)].map((m) => m[1]))].sort();
  check("PDF: Cairo-Regular وCairo-Bold مضمَّنان ولا خط غيرهما", JSON.stringify(fonts) === '["Cairo-Bold","Cairo-Regular"]', fonts.join(", "));
  const pages = pdfPageLines(pdf);
  check("PDF: الفاتورة الطويلة متعددة الصفحات", pages.length >= 2, `صفحات=${pages.length}`);
  const text = pages.flat(Infinity).join("");
  const missing = LINES.filter((l) => !text.includes(normalizeArabic(l.material))).map((l) => l.material);
  check("PDF: كل أسماء الأصناف الـ72 مطبوعة كاملة", missing.length === 0, missing.slice(0, 5).join(" | "));
  check("PDF: إجمالي الفاتورة مطبوع بأرقامه", text.includes(normalizeArabic(TOTAL.toLocaleString("en-US"))), String(TOTAL));
}

{
  const { context, page } = await boot({ blockFont: true });
  const loaded = await page.evaluate(() => OZK_FONT.ready(4000));
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  check("الاحتياط: حجب الخط لا يكسر التطبيق، والسلسلة تبقى Cairo ثم Tahoma", loaded === false && /Tahoma/.test(bodyFont), `${loaded} ${bodyFont}`);
  await context.close();
}

await browser.close();
server.close();
if (failed) { console.error(`\n❌ check-ozk-official-font: ${failed} فشل`); process.exit(1); }
console.log("\n✅ check-ozk-official-font: الخط الرسمي Cairo سليم");
