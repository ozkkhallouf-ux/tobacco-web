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
//   • نقطة استقبال Rollbar محجوبة كلياً: تشغيلة CI لا يجوز أن تولّد بلاغات
//     أخطاء اصطناعية في بيانات الإنتاج.
//   • لا مصادقة ولا جلسة ولا حساب: كل ما يُفحص هو ما يراه زائر مجهول.
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

const REQUIRED_ASSETS = [
  "/src/app.js", "/src/styles.css", "/src/config.js", "/src/supabase-client.js",
  "/src/error-monitoring.js", "/public/manifest.webmanifest", "/service-worker.js",
  "/public/service-worker.js", "/public/icons/ozk-logo.png",
  "/privacy-policy.html", "/terms-of-use.html", "/robots.txt",
];
const missingAssets = [];
for (const path of REQUIRED_ASSETS) {
  const result = await fetchOnce(`${BASE}${path}`);
  if (!result.ok) missingAssets.push(`${path} → ${result.status}`);
}
check("كل الأصول الأساسية تُحمَّل", missingAssets.length === 0, missingAssets.join(" | "));

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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const pageErrors = [];
const blockedWrites = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));

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
check("لم تُحاول الصفحة أي كتابة (الفحص قراءة فقط بالبنية)",
  blockedWrites.length === 0,
  `طلبات كتابة أُجهضت: ${blockedWrites.join(" | ")}`);

// النشرة المنشورة تُفتح في متصفح حقيقي أيضاً — لا ترميز وحده.
const bulletinPage = await context.newPage();
const bulletinErrors = [];
bulletinPage.on("pageerror", (error) => bulletinErrors.push(String(error?.message || error)));
let bulletinRows = 0;
try {
  await bulletinPage.goto(`${BASE}/public/downloads/price-list-usd.html`, { waitUntil: "domcontentloaded", timeout: 45000 });
  bulletinRows = await bulletinPage.locator("tbody tr").count();
} catch (error) {
  bulletinErrors.push(String(error?.message || error));
}
check("نشرة الدولار تُعرض بصفوف أصناف فعلية", bulletinRows > 5, `عدد الصفوف ${bulletinRows}`);
check("نشرة الدولار بلا أخطاء JavaScript", bulletinErrors.length === 0, bulletinErrors.join(" | "));

await browser.close();

if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً في دخان ما بعد النشر — إنذار فقط، بلا rollback ولا إصلاح تلقائي.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص دخان ما بعد النشر نجحت.");
