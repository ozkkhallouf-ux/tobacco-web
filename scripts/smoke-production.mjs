#!/usr/bin/env node
// ============================================================================
// فحص دخان بعد النشر (Post-Deploy Smoke) — قراءة فقط، بلا أي كتابة إطلاقاً.
//
// الفجوة التي يغلقه: بين لحظة «نجح النشر» في GitHub Actions ولحظة اكتشاف عطل
// حقيقي على الموقع الحيّ لم يكن هناك شيء. `health-check.yml` دوري كل 30 دقيقة
// ولا علاقة له بالنشر، وهو يفحص رمز HTTP لصفحتين فقط — فموقعٌ يعيد 200 بينما
// جافاسكربت فيه ينهار عند التحميل يمرّ عنده «سليماً».
//
// **ضمانات السلامة — مبنيّة لا موعودة:**
//   • كل طلب ليس GET/HEAD يُجهَض قبل مغادرته المتصفح. فحتى لو حاول الكود كتابة،
//     لا تصل. ويُبلَّغ عنها صراحةً بدل ابتلاعها.
//   • الـService Worker محجوب (`serviceWorkers: "block"`) — بدونه يتسرّب
//     الضمانان السابقان من تحت `page.route`، لأن Playwright لا يعترض طلبات
//     الـService Worker وهو يعترض كل GET ثم ينفّذ fetch بنفسه.
//   • نقطة استقبال Rollbar محجوبة كلياً: تشغيلة CI لا يجوز أن تولّد بلاغات
//     أخطاء اصطناعية في بيانات الإنتاج.
//   • لا مصادقة ولا جلسة ولا حساب: كل ما يُفحص هو ما يراه زائر مجهول.
//
// وقائمة الأصول تُشتقّ من `index.html` المخدوم نفسه لا من قائمة مكتوبة يدوياً:
// القائمة اليدوية تنحرف بصمت (كان `src/command-center.js` غائباً عنها فعلاً).
//
// عند الفشل: لا rollback ولا إصلاح تلقائي — إنذار فقط. يخرج برمز غير صفري،
// فتلتقطه `alert-on-automation-failure.yml` (تيليغرام بمفتاح تكرار لكل سير عمل)
// و`health-check.mjs` (Issue واحد لكل حادثة، يُغلق تلقائياً عند التعافي).
// فلا آلية تنبيه جديدة ولا Issues مكررة.
// ============================================================================
import { chromium } from "playwright";

const BASE = (process.env.SMOKE_BASE_URL || "https://ozktobacco.com").replace(/\/+$/, "");
// معرّف النشرة المتوقَّعة (github.sha). يُثبت أن ما تخدمه الشبكة هو النشرة
// الجديدة فعلاً لا نسخة مخبّأة — «نجح النشر» وحده لا يُثبت ذلك.
const EXPECTED_RELEASE = String(process.env.EXPECTED_RELEASE || "").trim();

let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}${detail ? `\n     ${detail}` : ""}`); }
};
const note = (text) => console.log(`  ℹ️  ${text}`);

// ---------------------------------------------------------------------------
// ١) طبقة HTTP: كل ما يحتاجه الزائر موجود ويُخدَم.
// ---------------------------------------------------------------------------
async function fetchOnce(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: "", error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

// GitHub Pages ينشر عبر CDN، وأول طلب بعد النشر قد يسبق الانتشار بثوانٍ.
// إعادة محاولة محدودة تمنع إنذاراً كاذباً بلا أن تُخفي انقطاعاً حقيقياً.
async function fetchWithRetry(url, { attempts = 5, waitMs = 15000 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await fetchOnce(url);
    if (last.ok) return last;
    if (attempt < attempts) {
      console.log(`     … المحاولة ${attempt}/${attempts} على ${url} أعادت ${last.status}؛ إعادة بعد ${waitMs / 1000}ث`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return last;
}

console.log(`فحص دخان بعد النشر — ${BASE}`);

const home = await fetchWithRetry(`${BASE}/`);
check("الصفحة الرئيسية تُعيد HTTP 200", home.ok, `status=${home.status}${home.error ? ` ${home.error}` : ""}`);
check("الصفحة الرئيسية ترجع صفحة التطبيق لا صفحة خطأ",
  home.body.includes('id="app"') && home.body.includes("OZK TOBACCO"),
  `طول الجسم ${home.body.length} حرفاً`);

// ⚠️ ملاحظة Codex P1 الثالثة على PR #199، وهي صحيحة: القائمة كانت مكتوبة يدوياً،
// و`src/command-center.js` **غائب عنها فعلاً** — فلو عاد 404 على الإنتاج لمرّ
// الفحص بنجاح بينما التطبيق ناقص. وهذا صنف العطل نفسه الذي أُغلق في طبقة
// المسارات الحرجة، تُرك مفتوحاً هنا حيث الوجهة إنتاجية.
//
// العلاج ليس إضافة السطر الناقص — بل إزالة القائمة اليدوية أصلاً: تُشتقّ الآن
// من `index.html` المخدوم نفسه، فأي أصل يُضاف إلى الصفحة يدخل الفحص تلقائياً
// ولا شيء يُنسى مرة أخرى.
function localAssetsFromHtml(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const raw = match[1].trim();
    if (!raw || /^(?:https?:|data:|mailto:|blob:|#)/i.test(raw)) continue;
    found.add(raw.startsWith("/") ? raw : `/${raw}`);
  }
  return [...found];
}

// أصول لا يشير إليها `index.html` لكنها جزء من العقد العام (الصفحات القانونية
// تُفتح من داخل التطبيق، والـSW من نطاق الجذر).
const EXTRA_ASSETS = [
  "/service-worker.js", "/public/service-worker.js",
  "/privacy-policy.html", "/terms-of-use.html", "/robots.txt",
];

const derivedAssets = localAssetsFromHtml(home.body);
// حارس على الحارس: تحليل فاشل يجعل القائمة فارغة فيمرّ الفحص بلا أن يفحص شيئاً.
check("اشتقاق قائمة الأصول من index.html نجح",
  derivedAssets.length >= 15,
  `اشتُقّ ${derivedAssets.length} أصلاً فقط — تغيّرت بنية index.html أو فشل التحليل`);

const missingAssets = [];
// Set قابلة للتكرار مباشرةً؛ نشرها في مصفوفة جديدة نسخٌ بلا فائدة.
for (const path of new Set([...derivedAssets, ...EXTRA_ASSETS])) {
  const result = await fetchOnce(`${BASE}${path}`);
  if (!result.ok) missingAssets.push(`${path} → ${result.status}`);
}
check(`كل أصول الصفحة تُحمَّل (${derivedAssets.length} مشتقّاً + ${EXTRA_ASSETS.length} إضافياً)`,
  missingAssets.length === 0, missingAssets.join(" | "));

const BULLETINS = [
  "/public/downloads/index.html",
  "/public/downloads/price-list-usd.html",
  "/public/downloads/price-list-syp-14050.html",
];
const bulletinProblems = [];
for (const path of BULLETINS) {
  const result = await fetchOnce(`${BASE}${path}`);
  if (!result.ok) { bulletinProblems.push(`${path} → ${result.status}`); continue; }
  // صفحة تُعيد 200 وهي شبه فارغة عطلٌ لا يلتقطه فحص رمز الحالة وحده.
  if (result.body.length < 2000) bulletinProblems.push(`${path} → 200 لكن الحجم ${result.body.length} حرفاً فقط`);
}
check("نشرات الأسعار المنشورة تُفتح وتحمل محتوى", bulletinProblems.length === 0, bulletinProblems.join(" | "));

// معرّف النشرة يُحقَن في خطوة النشر. غيابه يعني أن سرّ المراقبة غير مضبوط —
// وهي حالة مقصودة وموثَّقة، فلا تُفشِل الفحص بل تُسجَّل.
const releaseMatch = home.body.match(/data-release="([^"]*)"/);
const servedRelease = releaseMatch ? releaseMatch[1] : "";
if (!EXPECTED_RELEASE) {
  note("EXPECTED_RELEASE غير مُمرَّر — تخطّي مطابقة معرّف النشرة.");
} else if (!servedRelease || servedRelease.startsWith("__")) {
  note("الموقع يخدم النائب الحرفي لمعرّف النشرة (سرّ Rollbar غير مضبوط) — لا مطابقة ممكنة.");
} else {
  check("الشبكة تخدم النشرة الجديدة فعلاً (تطابق معرّف الإصدار)",
    servedRelease === EXPECTED_RELEASE,
    `المخدوم ${servedRelease} — المتوقَّع ${EXPECTED_RELEASE}`);
}

// ---------------------------------------------------------------------------
// ٢) طبقة المتصفح: الموقع لا ينهار عند التحميل.
// ---------------------------------------------------------------------------
const browser = await chromium.launch();
// ⚠️ `serviceWorkers: "block"` إلزامي هنا لسببين، وليس تفضيلاً:
//   ١) **سلامة:** `page.route` أدناه لا يعترض طلبات الـService Worker (قيد
//      معروف في Playwright)، و`public/service-worker.js` يعترض كل GET ثم
//      ينفّذ `fetch(event.request)`. فبدون الحجب كان ضمانا «صفر كتابة» و«حجب
//      Rollbar» يتسرّبان من تحت الحارس — **على الموقع الحيّ تحديداً**.
//      (نفس صنف ملاحظة Codex P1 على طبقة المسارات الحرجة، وينطبق هنا بأثر
//      أخطر لأن الوجهة إنتاجية لا محلية.)
//   ٢) **صحّة القياس:** غرض هذا الفحص إثبات أن **الشبكة** تخدم النشرة الجديدة.
//      Service Worker يخدم من كاشه، فيقيس الكاش لا النشر — وهو بالضبط العطل
//      الذي وُجد الفحص لرصده.
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  serviceWorkers: "block",
});
const page = await context.newPage();

const pageErrors = [];
const blockedWrites = [];
const assetFailures = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
// الاستثناء الذي رصده Codex: مورد ناقص يبلّغه المتصفح كفشل تحميل لا كاستثناء
// JavaScript، فـ`pageerror` وحده يراه سليماً. نرصد الاستجابات والإخفاقات من
// الأصل نفسه مباشرةً — وهو ما يمسك النقص أثناء التشغيل الحقيقي لا في قائمة.
const sameOrigin = (url) => { try { return new URL(url).origin === new URL(BASE).origin; } catch { return false; } };
page.on("response", (response) => {
  if (sameOrigin(response.url()) && response.status() >= 400) {
    assetFailures.push(`HTTP ${response.status()} ← ${response.url()}`);
  }
});
page.on("requestfailed", (request) => {
  if (sameOrigin(request.url())) {
    assetFailures.push(`${request.failure()?.errorText || "request failed"} ← ${request.url()}`);
  }
});

await page.route("**", (route) => {
  const request = route.request();
  const url = request.url();
  // بلاغات الأخطاء: محجوبة تماماً. تشغيلة آلية لا تُلوّث بيانات مراقبة الإنتاج.
  if (/(^|\.)rollbar\.com/i.test(new URL(url).hostname)) return route.abort();
  // ضمان «صفر كتابة» بالبنية لا بالنية.
  if (!["GET", "HEAD"].includes(request.method())) {
    blockedWrites.push(`${request.method()} ${url}`);
    return route.abort();
  }
  return route.continue();
});

let boot = { reached: false, shell: false, route: "" };
try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 40000) {
    const value = await page.evaluate(() => {
      try { return (0, eval)("state").loading === false; } catch { return false; }
    }).catch(() => false);
    if (value) { boot.reached = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  boot.shell = (await page.locator(".app-shell").count()) > 0;
  boot.route = await page.evaluate(() => {
    try { return (0, eval)("state").route; } catch { return ""; }
  }).catch(() => "");
} catch (error) {
  pageErrors.push(`تعذّر تحميل الصفحة: ${String(error?.message || error)}`);
}

check("التطبيق يُكمل إقلاعه في المتصفح", boot.reached, "بقي state.loading = true بعد 40 ثانية");
check("قشرة التطبيق تُرسم", boot.shell, `route=${boot.route || "؟"}`);
check("لا استثناء JavaScript غير ملتقَط عند التحميل", pageErrors.length === 0, pageErrors.join(" | "));
check("لا مورد من الأصل نفسه يخفق أثناء التحميل الفعلي",
  assetFailures.length === 0, assetFailures.join(" | "));
check("لم تُحاول الصفحة أي كتابة (الفحص قراءة فقط بالبنية)",
  blockedWrites.length === 0,
  `طلبات كتابة أُجهضت: ${blockedWrites.join(" | ")}`);

// النشرة المنشورة تُفتح في متصفح حقيقي أيضاً — لا ترميز وحده.
const bulletinPage = await context.newPage();
const bulletinErrors = [];
bulletinPage.on("pageerror", (error) => bulletinErrors.push(String(error?.message || error)));
bulletinPage.on("response", (response) => {
  if (sameOrigin(response.url()) && response.status() >= 400) {
    bulletinErrors.push(`HTTP ${response.status()} ← ${response.url()}`);
  }
});
bulletinPage.on("requestfailed", (request) => {
  if (sameOrigin(request.url())) {
    bulletinErrors.push(`${request.failure()?.errorText || "request failed"} ← ${request.url()}`);
  }
});
let bulletinRows = 0;
try {
  await bulletinPage.goto(`${BASE}/public/downloads/price-list-usd.html`, { waitUntil: "domcontentloaded", timeout: 45000 });
  bulletinRows = await bulletinPage.locator("tbody tr").count();
} catch (error) {
  bulletinErrors.push(String(error?.message || error));
}
check("نشرة الدولار تُعرض بصفوف أصناف فعلية", bulletinRows > 5, `عدد الصفوف ${bulletinRows}`);
check("نشرة الدولار بلا أخطاء JavaScript ولا موارد مخفقة", bulletinErrors.length === 0, bulletinErrors.join(" | "));

await browser.close();

if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً في دخان ما بعد النشر — إنذار فقط، بلا rollback ولا إصلاح تلقائي.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص دخان ما بعد النشر نجحت.");
