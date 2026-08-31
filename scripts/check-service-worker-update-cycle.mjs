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
const INDEX_HTML = readFileSync(resolve(root, "index.html"), "utf8");
const PAGES_YML = readFileSync(resolve(root, ".github/workflows/pages.yml"), "utf8");

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

// ===== معامل نسخة الأصول: خط الدفاع الأول ضد كاش HTTP =====
// أصول index.html تُحمَّل بـ`?v=tobacco-N`، ومفتاح كاش HTTP يشمل الاستعلام.
// فما لم يتغيّر هذا الرقم مع النشر يبقى العنوان نفسه ويخدمه المتصفح من كاشه
// حتى عشر دقائق (max-age=600 على GitHub Pages) — وهو ما وقع فعلاً: بقي الرقم
// 177 عبر #159 و#160 و#161، فوصل المستخدمين كود ما قبل الإصلاح.
// قِيس عملياً: بلا رفع الرقم لم يُطلب `src/app.js?v=...` بعد إعادة التحميل
// إطلاقاً؛ ومع رفعه طُلب العنوان الجديد من الشبكة فوراً.
const markers = [...INDEX_HTML.matchAll(/v=tobacco-(\d+)/g)].map((m) => m[1]);
check("index.html يحمل معامل نسخة للأصول",
  markers.length > 0, "لم يعد المعامل موجوداً — تغيّرت آلية إبطال الكاش");
check("كل معاملات النسخة في index.html متطابقة (لا رفع جزئي)",
  new Set(markers).size === 1,
  `قيم مختلفة: ${[...new Set(markers)].join(", ")} — رفع جزئي يترك بعض الأصول قديمة`);

const localAssets = [...INDEX_HTML.matchAll(/(?:src|href)="(src\/[^"]+)"/g)].map((m) => m[1]);
const unversioned = localAssets.filter((href) => !/\?v=tobacco-\d+/.test(href));
check("كل أصول src/ في index.html تحمل معامل النسخة",
  unversioned.length === 0,
  `بلا معامل: ${unversioned.join(", ")} — ستبقى مخبّأة بعد النشر`);

check("خط النشر يرفع معامل نسخة الأصول تلقائياً",
  /Bump asset version marker/.test(PAGES_YML) && /v=tobacco-\$\{CURRENT\}/.test(PAGES_YML),
  "بلا هذه الخطوة يعتمد إبطال الكاش على رفع يدوي — وقد نُسي ثلاث مرات متتالية");

// التحقق بعد sed لا بدّ أن يحمل حدّاً رقمياً. بلا حدّ يطابق البحثُ عن الرقم
// القديم داخلَ الجديد حين يكون سابقةً له (177 داخل 1770)، فيفشل النشر رغم نجاح
// الاستبدال — لعشر نشرات متتالية. أُعيد إنتاجه فعلياً قبل إضافة هذا الحارس.
const bumpStep = PAGES_YML.slice(PAGES_YML.indexOf("Bump asset version marker"));
const bumpBody = bumpStep.slice(0, bumpStep.indexOf("- name: Configure Pages"));
check("تحقّق رفع المعامل يستعمل حدّاً رقمياً (لا مطابقة سابقة)",
  (bumpBody.match(/\(\[\^0-9\]\|\$\)/g) || []).length >= 2,
  "التحققان بلا حدّ رقمي — سيفشل النشر حين يصير الرقم القديم سابقةً للجديد");

check("رفع المعامل يرفض معاملاً مفقوداً بدل الاستبدال الأعمى",
  /test -n "\$CURRENT"/.test(bumpBody),
  "CURRENT فارغ يجعل sed يطابق كل شيء");

check("خط النشر ما زال يرفع CACHE_NAME أيضاً",
  /Bump service worker cache version/.test(PAGES_YML),
  "اختفت خطوة رفع CACHE_NAME");

const activateHandler = (swCode.match(/self\.addEventListener\("activate"[\s\S]*?\n(?=self\.addEventListener|$)/) || [""])[0];
check("activate لا يعيد تنقيل أي تبويب مفتوح",
  !/\.navigate\s*\(/.test(activateHandler) && !/matchAll\s*\(/.test(activateHandler),
  "عاد التنقيل القسري — سيُعاد تحميل تبويبات المستخدم عند تفعيل SW جديد");
check("activate ما زال ينظّف الكاش القديم ويأخذ السيطرة",
  /caches\.delete/.test(activateHandler) && /clients\.claim/.test(activateHandler),
  "فقد activate تنظيف الكاش أو clients.claim");

const fetchHandler = (swCode.match(/self\.addEventListener\("fetch"[\s\S]*$/) || [""])[0];
const fallbackFn = (swCode.match(/function offlineFallback\([\s\S]*?\n\}/) || [""])[0];

check("مسار الشبكة ما زال network-first بلا تغيير",
  /fetch\(event\.request\)/.test(fetchHandler) && !/ignoreSearch/.test(fetchHandler),
  "تغيّر مسار الشبكة أو تسرّب ignoreSearch إليه");

check("ارتداد offline يجرّب المطابقة التامة أولاً",
  /caches\.match\(request\)\.then\(\(exact\)/.test(fallbackFn.replace(/\s+/g, "")) ||
  /caches\.match\(request\)/.test(fallbackFn),
  "لم تعد المطابقة التامة تسبق ignoreSearch");

check("ignoreSearch محصور في ارتداد offline وحده",
  (swCode.match(/ignoreSearch/g) || []).length === 1 && /ignoreSearch/.test(fallbackFn),
  "ignoreSearch ظهر خارج ارتداد offline — قد يُخفي اختلاف معاملات الطلبات الديناميكية");

check("ignoreSearch محصور بأصول ثابتة same-origin",
  /origin!==self\.location\.origin/.test(fallbackFn.replace(/\s+/g, "")) &&
  /STATIC_ASSET_PATH\.test/.test(fallbackFn),
  "لم يعد الارتداد المتساهل محصوراً بأصول التطبيق الثابتة على نفس الأصل");

check("الارتداد الأخير ما زال index.html (تشغيل offline للصفحة)",
  /caches\.match\("index\.html"\)/.test(fallbackFn),
  "فُقد ارتداد الصفحة");

// ===== المختبر: خادم يحاكي GitHub Pages (max-age=600) ونشرتان =====
const MAXAGE = 600;

// المختبر يحاكي الإنتاج: index.html يطلب الأصول بمعامل نسخة
// (`src/app.js?v=tobacco-N`) بينما ASSETS في الـservice worker عناوين مجرّدة —
// وهذا التفاوت بالضبط هو ما يجعل ارتداد offline يخطئ المطابقة. صفحة تركيبية
// بلا معامل كانت تُخفي العطل ولا تستطيع إعادة إنتاجه.
// `assetCacheControl` يسمح بإسقاط سند كاش HTTP (`no-store`) لعزل مسار
// Cache Storage وحده — وإلا نجح الاختبار زوراً بفضل كاش HTTP.
function makeLab({ updateViaCache, precacheReload, assetCacheControl = "max-age=600" }) {
  let deploy = { cacheName: "swlab-v1", appJs: 'window.__APP_VERSION="v1";', marker: "177" };
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
  const index = () => `<!doctype html><html><head><meta charset="utf-8"><title>swlab</title></head><body>
<script src="src/app.js?v=tobacco-${deploy.marker}"></script>
<script>if("serviceWorker" in navigator){window.addEventListener("load",()=>{
navigator.serviceWorker.register("service-worker.js"${regOpts}).catch(()=>{});});}</script></body></html>`;

  const server = createServer((req, res) => {
    const full = String(req.url || "/");
    const url = full.split("?")[0];
    // نسجّل العنوان **الكامل** كي نميّز طلب الصفحة (بمعامل) عن التحميل المسبق (مجرّد)
    hits.push(full);
    const send = (body, type, cacheControl = `max-age=${MAXAGE}`) => {
      res.writeHead(200, { "content-type": type, "cache-control": cacheControl });
      res.end(body);
    };
    if (url === "/" || url === "/index.html") return send(index(), "text/html; charset=utf-8");
    if (url === "/service-worker.js") return send(SW_SHIM, "text/javascript");
    if (url === "/public/service-worker.js") return send(swBody(), "text/javascript");
    if (url === "/src/app.js") return send(deploy.appJs, "text/javascript", assetCacheControl);
    res.writeHead(404); res.end("nf");
  });
  return {
    server, hits,
    publish: () => { deploy = { cacheName: "swlab-v2", appJs: 'window.__APP_VERSION="v2";', marker: "178" }; }
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
  check("بعد النشر: إعادة التحميل تجلب الأصل بمعامله الجديد من الشبكة",
    fixed.requested.includes("/src/app.js?v=tobacco-178"),
    `الطلبات: ${JSON.stringify(fixed.requested)} — بقي التطبيق على النسخة القديمة`);
  check("بعد النشر: التحميل المسبق يجلب الأصل المجرّد طازجاً (أثر cache:\"reload\")",
    fixed.requested.includes("/src/app.js"),
    `الطلبات: ${JSON.stringify(fixed.requested)}`);
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
  // العنوان المُعنون يصل دائماً لأنه مفتاح كاش جديد؛ الفارق الذي يصنعه
  // cache:"reload" هو في التحميل المسبق للعنوان **المجرّد**.
  check("سلبي: بلا cache:\"reload\" يُملأ الكاش الجديد من كاش HTTP لا من الشبكة",
    noReload.requested.includes("/public/service-worker.js") && !noReload.requested.includes("/src/app.js"),
    `الطلبات: ${JSON.stringify(noReload.requested)}`);
}

// ===== ٤) تبويبان: تفعيل SW جديد لا يمسّ تبويب المستخدم الآخر =====
// قبل الإصلاح: activate كان ينقّل كل نافذة في النطاق، فإعادة تحميل التبويب A
// كانت تعيد تحميل التبويب B أيضاً وتمحو إدخالاته غير المحفوظة (قِيس: تنقيل=1).
{
  const lab = makeLab({ updateViaCache: "none", precacheReload: true });
  await new Promise((done) => lab.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const context = await browser.newContext();

  const A = await context.newPage();
  A.goto(`${base}/index.html`).catch(() => {});
  await sleep(5000);
  const B = await context.newPage();
  B.goto(`${base}/index.html`).catch(() => {});
  await sleep(4000);

  // حالة غير محفوظة في تبويب المستخدم B — تختفي لو أُعيد تحميله
  await B.evaluate(() => {
    window.__UNSAVED = "إدخال المستخدم غير المحفوظ";
    document.body.insertAdjacentHTML("beforeend", '<input id="draft" value="مسودة">');
    document.getElementById("draft").value = "نص كتبه المستخدم";
  }).catch(() => {});

  let bNavs = 0;
  B.on("framenavigated", (frame) => { if (frame === B.mainFrame()) bNavs += 1; });

  lab.publish();                       // نشر جديد
  await sleep(500);
  await A.reload({ timeout: 20000 }).catch(() => {});   // المستخدم يعيد تحميل A وحده
  await sleep(8000);

  check("تفعيل SW جديد لا يعيد تحميل التبويب الآخر",
    bNavs === 0, `أُعيد تنقيل التبويب B ${bNavs} مرة`);

  const survived = await B.evaluate(() => ({
    unsaved: window.__UNSAVED ?? null,
    draft: document.getElementById("draft")?.value ?? null
  })).catch(() => ({ unsaved: null, draft: null }));
  check("حالة DOM والإدخال غير المحفوظ في التبويب الآخر لم تضع",
    survived.unsaved === "إدخال المستخدم غير المحفوظ" && survived.draft === "نص كتبه المستخدم",
    `القيم بعد التفعيل: ${JSON.stringify(survived)}`);

  // إعادة تحميل يدوية من المستخدم ⇒ يحصل على النسخة الجديدة
  const mark = lab.hits.length;
  await B.reload({ waitUntil: "load", timeout: 20000 }).catch(() => {});
  await sleep(4000);
  const afterManual = lab.hits.slice(mark);
  const versionB = await readVersion(B);
  check("بعد إعادة تحميل يدوية للتبويب الآخر يحصل على النسخة الجديدة",
    versionB === "v2",
    `النسخة بعد إعادة التحميل: ${versionB} — الطلبات: ${JSON.stringify(afterManual)}`);

  await context.close();
  lab.server.close();
}

// ===== ٥) offline بلا سند كاش HTTP: الأصل المُعنون يُخدَم من Cache Storage =====
// هذا هو السيناريو الذي أثبت العطل: الصفحة تطلب `src/app.js?v=tobacco-178`
// بينما الكاش يحمل `src/app.js` المجرّد. بترويسة no-store لا يستطيع كاش HTTP
// إنقاذ الموقف، فتنكشف صحّة ارتداد offline وحده. قبل ignoreSearch كانت النتيجة
// null — أي أن index.html عاد مكان السكربت فلم يُنفَّذ شيء.
{
  const lab = makeLab({ updateViaCache: "none", precacheReload: true, assetCacheControl: "no-store" });
  await new Promise((done) => lab.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${lab.server.address().port}`;
  const context = await browser.newContext();

  const installer = await context.newPage();
  installer.goto(`${base}/index.html`).catch(() => {});
  await sleep(5000);
  lab.publish();                                   // نشر يرفع المعامل إلى 178
  await installer.reload({ timeout: 20000 }).catch(() => {});
  await sleep(6000);

  const online = await readVersion(installer);
  check("online: الصفحة تحصل على النسخة الجديدة ذات المعامل الجديد",
    online === "v2", `القيمة: ${online}`);
  const cachedKeys = await installer.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    return (await cache.keys()).map((request) => new URL(request.url).pathname + new URL(request.url).search);
  }).catch(() => []);
  await installer.close().catch(() => {});

  await new Promise((done) => lab.server.close(done));   // «انقطع الإنترنت»

  const offlinePage = await context.newPage();
  await offlinePage.goto(`${base}/index.html`, { waitUntil: "load", timeout: 20000 }).catch(() => {});
  const offlineVersion = await readVersion(offlinePage);
  check("offline بلا كاش HTTP: الأصل المُعنون يُخدَم من Cache Storage",
    offlineVersion === "v2",
    `القيمة: ${offlineVersion} — مفاتيح الكاش: ${JSON.stringify(cachedKeys)}`);

  // إثبات صريح أن السكربت نُفِّذ ولم يُعَد index.html مكانه
  const servedHtmlInsteadOfJs = await offlinePage.evaluate(async () => {
    try {
      const response = await fetch("src/app.js?v=tobacco-178");
      const type = response.headers.get("content-type") || "";
      const body = await response.text();
      return /text\/html/i.test(type) || /<!doctype|<html/i.test(body);
    } catch { return "فشل الطلب"; }
  }).catch(() => "تعذّر القياس");
  check("offline: لا يُعاد index.html مكان الـJavaScript",
    servedHtmlInsteadOfJs === false,
    `النتيجة: ${servedHtmlInsteadOfJs}`);

  await context.close();
}

// ===== ٦) offline لم ينكسر =====
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
