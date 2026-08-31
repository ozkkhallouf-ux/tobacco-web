#!/usr/bin/env node
// فحص انحدار لدورة تحديث الـService Worker.
//
// العطل الذي يحرسه: `service-worker.js` في الجذر مجرّد غلاف من أربعة أسطر
// يستورد `public/service-worker.js`، فهو **لا يتغيّر بين النشرات أبداً**. القيمة
// الافتراضية لـ`updateViaCache` هي "imports"، أي أن الملف المستورَد — الذي يحمل
// CACHE_NAME وكل المنطق — يُجلب عبر كاش HTTP. وGitHub Pages يرسل max-age=600،
// فيقارن المتصفح غلافاً ثابتاً بنسخة مخبّأة من المنطق ويستنتج «لا جديد»: لا
// install ولا activate ولا تحديث للكاش طوال عشر دقائق بعد كل نشر.
//
// قياس فعلي قبل الإصلاح: تحديث دوري كل ٣ ثوانٍ طلب الغلاف خمس مرات ولم يطلب
// الملف المستورَد ولا مرة. وبعد إعادة تحميل الصفحة لم يُطلب `src/app.js` إطلاقاً.
//
// الإصلاح شقّان، وكلاهما ضروري — والفحص يثبت ذلك باختبار سلبي لكل شقّ:
//   ١) التسجيل بـ`updateViaCache:"none"` ليُعاد التحقق من الملف المستورَد.
//   ٢) التحميل المسبق بـ`cache:"reload"` كي لا يملأ الـSW الجديد كاشه بملفات
//      قديمة؛ و"reload" يحدّث كاش HTTP أيضاً فيصير ما بعده طازجاً.
//
// معالج `fetch` لم يُمَسّ عمداً: سلوك offline يبقى كما هو، ويُفحص هنا صراحةً.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SW_LOGIC = readFileSync(resolve(root, "public/service-worker.js"), "utf8");
const SW_SHIM = readFileSync(resolve(root, "service-worker.js"), "utf8");
const APP_JS = readFileSync(resolve(root, "src/app.js"), "utf8");

let failed = 0;
const ok = (name) => console.log(`  ✅ ${name}`);
const bad = (name, detail) => { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); };
const check = (name, condition, detail = "") => (condition ? ok(name) : bad(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("فحص دورة تحديث الـService Worker:");

// ===== ١) حرّاس المصدر =====
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

const appCode = stripComments(APP_JS);
const swCode = stripComments(SW_LOGIC);

const registerCall = appCode.match(/navigator\.serviceWorker\.register\([^;]*\)/);
check("التسجيل يمرّر updateViaCache:\"none\"",
  !!registerCall && /updateViaCache\s*:\s*["']none["']/.test(registerCall[0]),
  `الاستدعاء الحالي: ${registerCall ? registerCall[0].slice(0, 120) : "غير موجود"}`);

const swTight = swCode.replace(/\s+/g, "");
check("التحميل المسبق يتجاوز كاش HTTP بـcache:\"reload\"",
  swTight.includes("cache.addAll(ASSETS.map(") && /newRequest\([^)]*\{cache:["']reload["']\}\)/.test(swTight),
  "install ما زال يستدعي cache.addAll(ASSETS) مباشرة — سيملأ الكاش الجديد بملفات مخبّأة قديمة");

check("ملف الجذر ما زال غلافاً يستورد منطق public/ (أساس هذا العطل)",
  /importScripts\(\s*["']public\/service-worker\.js["']\s*\)/.test(SW_SHIM),
  "تغيّرت البنية — راجع ما إذا كان updateViaCache ما زال ضرورياً");

check("معالج fetch ما زال network-first مع ارتداد إلى الكاش (سلوك offline)",
  /fetch\(event\.request\)/.test(swCode) && /catch\(\(\)=>caches\.match\(event\.request\)/.test(swCode.replace(/\s+/g, "")),
  "تغيّر معالج fetch — أعد التحقق من سلوك offline");

// ===== المختبر: خادم يحاكي GitHub Pages (max-age=600) ونشرتان =====
const MAXAGE = 600;

function makeLab({ updateViaCache, precacheReload }) {
  let deploy = { cacheName: "swlab-v1", appJs: 'window.__APP_VERSION="v1";' };
  const hits = [];
  const swBody = () => {
    let body = SW_LOGIC
      .replace(/^const CACHE_NAME = "[^"]*";/m, `const CACHE_NAME = "${deploy.cacheName}";`)
      .replace(/^const ASSETS = \[[\s\S]*?\];/m, `const ASSETS = ["./","index.html","src/app.js"];`);
    if (!precacheReload) {
      // نسخة «ما قبل الإصلاح» لإثبات أن الفحص يرصد الرجوع فعلاً
      body = body.replace(/cache\.addAll\(ASSETS\.map\([^;]*?\)\)\)/, "cache.addAll(ASSETS))");
    }
    return body;
  };
  const regOpts = updateViaCache ? `, {updateViaCache:"${updateViaCache}"}` : "";
  const index = `<!doctype html><html><head><meta charset="utf-8"><title>swlab</title></head><body>
<script src="src/app.js"></script>
<script>if("serviceWorker" in navigator){window.addEventListener("load",()=>{
navigator.serviceWorker.register("service-worker.js"${regOpts}).catch(()=>{});});}</script></body></html>`;

  const server = createServer((req, res) => {
    const url = String(req.url || "/").split("?")[0];
    hits.push(url);
    const send = (body, type) => {
      res.writeHead(200, { "content-type": type, "cache-control": `max-age=${MAXAGE}` });
      res.end(body);
    };
    if (url === "/" || url === "/index.html") return send(index, "text/html; charset=utf-8");
    if (url === "/service-worker.js") return send(SW_SHIM, "text/javascript");
    if (url === "/public/service-worker.js") return send(swBody(), "text/javascript");
    if (url === "/src/app.js") return send(deploy.appJs, "text/javascript");
    res.writeHead(404); res.end("nf");
  });
  return {
    server, hits,
    publish: () => { deploy = { cacheName: "swlab-v2", appJs: 'window.__APP_VERSION="v2";' }; }
  };
}

// `client.navigate()` في activate يهدم سياق الصفحة أثناء القياس، لذلك نقرأ
// بإعادة محاولة بدل افتراض بقاء السياق.
async function readVersion(page) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await Promise.race([
        page.evaluate(() => window.__APP_VERSION ?? null),
        sleep(4000).then(() => { throw new Error("timeout"); })
      ]);
    } catch { await sleep(1200); }
  }
  return "تعذّرت القراءة";
}

const browser = await chromium.launch();

// ===== ٢) السيناريو الفعلي: نشر ثم إعادة تحميل =====
async function deployThenReload(options) {
  const lab = makeLab(options);
  await new Promise((done) => lab.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  // بلا انتظار: activate يعيد تنقيل الصفحة فيُجهض goto المنتظِر
  page.goto(`${base}/index.html`).catch(() => {});
  await sleep(4000);
  lab.publish();
  const mark = lab.hits.length;
  page.reload().catch(() => {});
  await sleep(6000);
  const requested = lab.hits.slice(mark);
  const version = await readVersion(page);
  await context.close();
  lab.server.close();
  return { requested, version };
}

{
  const fixed = await deployThenReload({ updateViaCache: "none", precacheReload: true });
  check("بعد النشر: إعادة التحميل تجلب المنطق المستورَد من الشبكة",
    fixed.requested.includes("/public/service-worker.js"),
    `الطلبات: ${JSON.stringify(fixed.requested)}`);
  check("بعد النشر: إعادة التحميل تجلب src/app.js الجديد فعلياً",
    fixed.requested.includes("/src/app.js"),
    `الطلبات: ${JSON.stringify(fixed.requested)} — بقي التطبيق على النسخة القديمة`);
}

// ===== ٣) اختبارات سلبية: كل شقّ من الإصلاح ضروري =====
{
  const noUvc = await deployThenReload({ updateViaCache: "", precacheReload: true });
  check("سلبي: بلا updateViaCache لا يُكتشف المنطق الجديد إطلاقاً",
    !noUvc.requested.includes("/public/service-worker.js"),
    `طُلب رغم غيابه — لم يعد الفحص يرصد العطل: ${JSON.stringify(noUvc.requested)}`);
}
{
  const noReload = await deployThenReload({ updateViaCache: "none", precacheReload: false });
  check("سلبي: بلا cache:\"reload\" يُكتشف الـSW لكن لا تصل ملفات جديدة",
    noReload.requested.includes("/public/service-worker.js") && !noReload.requested.includes("/src/app.js"),
    `الطلبات: ${JSON.stringify(noReload.requested)}`);
}

// ===== ٤) offline لم ينكسر =====
{
  const lab = makeLab({ updateViaCache: "none", precacheReload: true });
  await new Promise((done) => lab.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const context = await browser.newContext();

  // الصفحة الأولى تُنصّب الـservice worker وتملأ الكاش. لا نقرأ منها: activate
  // يستدعي client.navigate() فيهدم سياقها. نقرأ من صفحات جديدة تشارك نفس
  // التسجيل والكاش — وهي أيضاً محاكاة أصدق لفتح تبويب جديد.
  const installer = await context.newPage();
  installer.goto(`${base}/index.html`).catch(() => {});
  await sleep(6000);
  await installer.close().catch(() => {});

  const onlinePage = await context.newPage();
  await onlinePage.goto(`${base}/index.html`, { waitUntil: "load", timeout: 20000 }).catch(() => {});
  const online = await readVersion(onlinePage);
  check("قبل قطع الشبكة: التطبيق يعمل", online === "v1", `القيمة: ${online}`);
  await onlinePage.close().catch(() => {});

  await new Promise((done) => lab.server.close(done));   // «انقطع الإنترنت»

  const offlinePage = await context.newPage();
  await offlinePage.goto(`${base}/index.html`, { waitUntil: "load", timeout: 20000 }).catch(() => {});
  const offline = await readVersion(offlinePage);
  check("بعد قطع الشبكة: الصفحة ما زالت تُفتح من Cache Storage (offline سليم)",
    offline === "v1",
    `القيمة بعد القطع: ${offline} — التحميل المسبق لم يعد يخدم offline`);
  await context.close();
}

await browser.close();

if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً في دورة تحديث الـService Worker.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص دورة تحديث الـService Worker نجحت.");
