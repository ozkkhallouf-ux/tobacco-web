#!/usr/bin/env node
// ============================================================================
// طبقة المسارات الحرجة (Critical Journeys) — حارس انحدار سلوكي للواجهة نفسها.
//
// الفجوة التي يغلقها: كل الحرّاس القائمة (48 فحصاً) تفحص **وحداتٍ ومسارات
// بعينها** — نشرة الأسعار، الطباعة، الجرد، الأمان، سكربتات ويندوز. ولا واحد
// منها يفتح التطبيق ويتنقّل فيه كما يفعل المستخدم. النتيجة أن صنفاً كاملاً من
// الأعطال كان يمرّ إلى الإنتاج بلا أي إنذار:
//   • استثناء غير ملتقَط أثناء رسم صفحة → الشاشة تبقى على آخر محتوى، والمستخدم
//     يظن أن الزر لم يعمل. لا فحص ساكن يراه.
//   • مسار مسجَّل في `allowedRoutes` وغير مسجَّل في `pages` → 
//     `pages[state.route] is not a function`. يحرسه check-keyboard-shortcut-routes.mjs
//     نصّياً لاختصارات Alt+رقم وحدها؛ أما الرابط العميق `?route=` فبلا حارس.
//   • انكسار ربط الأحداث بعد تعديل render (وثلاث وحدات تلفّ `render` فعلاً:
//     app.js ثم decision-engine.js ثم command-center.js) → الصفحة تُرسم ولا
//     تستجيب لأي إدخال.
//
// **لا يمسّ الإنتاج إطلاقاً:** كل طلب خارج المضيف المحلي مقطوع بـroute واحدة
// شاملة (Supabase وRollbar وأي طرف ثالث). لا قراءة ولا كتابة على أي خدمة حيّة،
// ولا حساب اختبار حقيقي. الجلسة تُزرع في `state` مباشرةً — وهو نفس الأسلوب
// المعتمد في check-price-bulletin-export-integrity.mjs، فلا يُضاف أي منفذ
// اختبار إلى كود الإنتاج.
//
// **لماذا خارج بوابة `npm run check`:** البوابة تعمل ثلاث مرات على كل PR
// (check.yml وdecision-engine-check.yml وpages.yml)، وهذه الطبقة تشغّل متصفحاً
// عبر عشرات المسارات. لها وظيفة مستقلة `critical-journeys` في check.yml، وهي
// مسجَّلة في EXCLUDED داخل checks.manifest.mjs بهذا السبب — فلا تصير «فحصاً
// موجوداً ولا يعمل ولا أحد يدري».
//
// عند فشل أي مسار يُحفَظ trace وscreenshot تحت `.playwright/critical-journeys/`
// (مُتجاهَل في .gitignore أصلاً) لترفعهما وظيفة CI كـartifact.
// ============================================================================
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(root, ".playwright", "critical-journeys");
rmSync(ARTIFACTS, { recursive: true, force: true });
mkdirSync(ARTIFACTS, { recursive: true });

// نستعمل خادم الموقع الإنتاجي نفسه (`scripts/serve.mjs`) لا خادماً مبسّطاً:
// فما يُفحص هو ما يُخدَم فعلاً، بقيود الامتدادات والجذور العامة نفسها.
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
const { server } = await import("./serve.mjs");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// حدّ العزل الشبكي — طبقة الوكيل، خارج توجيه الصفحة تماماً.
//
// ⚠️ ملاحظة Codex P1 على PR #199، وهي صحيحة: `page.route` **لا يعترض طلبات
// الـService Worker** (قيد معروف في Playwright). و`public/service-worker.js`
// يعترض كل طلب GET بلا تمييز أصل ثم ينفّذ `fetch(event.request)`. فبعد
// activate و`clients.claim()` في المسار الأخير، كان يمكن لطلب مثل
// `loadPublishedExchangeRate()` أن يصل Supabase الحيّ فعلاً بدل 503 المصطنع —
// أي أن ادّعاء «صفر اتصال بأي خدمة حيّة» كان يسقط في آخر مسار بالضبط.
//
// الحلّ حدٌّ عند مستوى المتصفح لا الصفحة: كل حركة غير الاسترجاع تُوجَّه إلى
// وكيل محلي في هذه العملية نفسها. وهو ليس مجرّد سدّ — بل **شاهد**: يسجّل كل
// محاولة خروج، فنُحوّل الضمان من وعدٍ إلى تأكيدٍ يفشل إن اختُرق.
const escapeAttempts = [];
// المضيف يُستخرَج بمحلّل عناوين لا بمطابقة نصّية: اسم مضيف يُقارَن بلاحقة
// صريحة لا يُخدَع بسطر مصاغ صياغة أخرى.
function hostOf(target, viaConnect) {
  try {
    return viaConnect
      ? String(target).split(":")[0].toLowerCase()
      : new URL(target).hostname.toLowerCase();
  } catch {
    return String(target).toLowerCase();
  }
}
const proxySink = createServer((request, response) => {
  escapeAttempts.push({ kind: `HTTP ${request.method}`, host: hostOf(request.url, false), target: request.url });
  response.writeHead(503, { "Content-Type": "text/plain" });
  response.end("blocked by critical-journeys sink");
});
// HTTPS يمرّ عبر CONNECT: نسجّل المضيف ثم نقطع، فلا يُبنى نفق إلى أي خدمة.
proxySink.on("connect", (request, socket) => {
  escapeAttempts.push({ kind: "CONNECT", host: hostOf(request.url, true), target: request.url });
  socket.destroy();
});
await new Promise((done) => proxySink.listen(0, "127.0.0.1", done));
const PROXY = `http://127.0.0.1:${proxySink.address().port}`;

// ---------------------------------------------------------------------------
// عدّاء المسارات
// ---------------------------------------------------------------------------
const failures = [];
let passed = 0;

async function journey(id, name, fn, { serviceWorkers = "block" } = {}) {
  const context = await chromiumBrowser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers,
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  let page = null;
  try {
    page = await context.newPage();
    await fn(page, context);
    passed += 1;
    console.log(`  ✅ ${name}`);
    await context.tracing.stop();
  } catch (error) {
    const message = String(error?.message || error);
    failures.push({ id, name, message });
    console.error(`  ❌ ${name}\n     ${message}`);
    // الأثر واللقطة أفضل جهد: فشلهما لا يجوز أن يُخفي سبب الفشل الأصلي.
    try { await context.tracing.stop({ path: join(ARTIFACTS, `${id}-trace.zip`) }); } catch { /* لا شيء */ }
    try { if (page) await page.screenshot({ path: join(ARTIFACTS, `${id}.png`), fullPage: true }); } catch { /* لا شيء */ }
  } finally {
    await context.close();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ⚠️ لا نستعمل `page.waitForFunction` في هذا الملف إطلاقاً.
// قِيس فعلياً أثناء بناء هذا الحارس: مع `tracing.start({ snapshots: true })`
// تُقيَّم دالةُ الشرط **مرة واحدة فقط** عند الاستدعاء ثم تتوقف حلقة الاقتراع
// داخل الصفحة، فيبقى الانتظار معلّقاً حتى المهلة رغم تحقّق الشرط بعد ثوانٍ.
// (أُعيد إنتاجه: الشرط نفسه ينجح بلا تتبّع ويفشل معه، و`page.evaluate` يُرجع
// القيمة الصحيحة في اللحظة نفسها.) والتتبّع هو مصدر الأدلة عند الفشل، فلا
// يُضحّى به. الاقتراع من جهة Node عبر `page.evaluate` يتجاوز المسألة تماماً
// ويبقى حتمياً — و`waitForSelector`/`click` غير متأثرين فيُستعملان كما هما.
async function pollUntil(page, predicate, { timeout = 30000, interval = 150, message } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    let value = false;
    try { value = await page.evaluate(predicate); } catch { value = false; }
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(message || `انتهت المهلة (${timeout}ms) قبل تحقّق الشرط`);
}

// ---------------------------------------------------------------------------
// فتح التطبيق: عزل شبكي تام + انتظار انتهاء boot() فعلياً.
// ---------------------------------------------------------------------------

// ⚠️ ملاحظة Codex P1 الثانية على PR #199، وهي صحيحة: كانت القائمة تحمل
// `/Failed to load resource/` و`/net::ERR_/` مطلقتين، فتبتلع **إخفاق أي مورد
// من الأصل نفسه** أيضاً. مثال ملموس: لو ضاع `src/command-center.js` أو
// `src/decision-engine.js` بـ404، لبقي `state` و`.app-shell` وأكثرُ التنقّل
// عاملاً فتمرّ عدة مسارات — بينما الدليل الوحيد الذي يبلّغه المتصفح مُلقىً في
// سلة المهملات. أي أن بوابة الانحدار الأساسية كانت تقبل تطبيقاً ناقصاً بصمت.
//
// الآن الاستثناء **مقيَّد بالمصدر لا بالنصّ**: رسالة فشل تحميل مورد تُتجاهَل
// فقط إذا كان عنوانها خارج المضيف المحلي — أي أحد الطلبات المقطوعة عمداً.
// وأي إخفاق من الأصل نفسه يُحتسب خطأً.
const RESOURCE_FAILURE = /Failed to load resource|net::ERR_/i;

// إنذارات متصفح عن قرارات موثَّقة، لا أعطال — ولا تحمل عنوان مورد فاشل:
//   • `frame-ancestors` عبر meta: المعيار يستثنيها، والحماية الحقيقية تحتاج
//     ترويسة HTTP من CDN (موثَّق في CLAUDE.md).
//   • خط Almarai: قالب النشرة يستورده من fonts.googleapis.com وCSP
//     (`style-src 'self' 'unsafe-inline'`) يحجبه. الأثر محصور في **معاينة
//     النشرة داخل التطبيق**: خط بديل بدل Almarai. ملفات النشرة المنشورة تحت
//     public/downloads/ صفحات مستقلة بلا هذه الـmeta فتُحمّل الخط طبيعياً،
//     وملفات PDF تُولَّد منها لا من التطبيق. أُبلغ عنها ولم تُعالَج هنا:
//     علاجها تغييرٌ إنتاجي خارج نطاق هذه المهمة.
// النمطان محدّدان بدقة كي تبقى أي مخالفة CSP جديدة فشلاً.
const ADVISORY_CONSOLE = [
  /frame-ancestors' is ignored when delivered via a <meta> element/i,
  /fonts\.googleapis\.com[\s\S]*violates the following Content Security Policy/i,
];

const TEST_SESSION = {
  id: "critical-journeys-test-session",
  name: "حساب اختبار محلي",
  role: "المالك",
  email: "owner@example.invalid",
  accessRole: "owner",
};

async function openApp(page, { search = "", waitForBoot = true } = {}) {
  const pageErrors = [];
  const consoleErrors = [];
  const writeRequests = [];
  const assetFailures = [];

  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (ADVISORY_CONSOLE.some((pattern) => pattern.test(text))) return;
    const source = (typeof msg.location === "function" ? msg.location()?.url : "") || "";
    // فشل تحميل مورد يُغتفَر **فقط** إذا كان المورد خارجياً (وهو المقطوع عمداً).
    // فشل مورد من الأصل نفسه عطلٌ حقيقي مهما كان نصّ الرسالة.
    if (RESOURCE_FAILURE.test(text) && source && !source.startsWith(BASE)) return;
    consoleErrors.push(source ? `${text} [${source}]` : text);
  });
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      writeRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  // حارس إيجابي مستقل عن نصوص وحدة التحكم: كل مورد من الأصل نفسه يجب أن يصل
  // بحالة < 400. هذا ما يمسك «تطبيق ناقص يبدو سليماً» حتى لو تغيّرت صياغة
  // رسائل المتصفح أو صمتت تماماً.
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith(BASE) && response.status() >= 400) {
      assetFailures.push(`HTTP ${response.status()} ← ${url}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith(BASE)) {
      assetFailures.push(`${request.failure()?.errorText || "request failed"} ← ${url}`);
    }
  });

  // حاجز واحد شامل: كل ما ليس المضيف المحلي يُردّ عليه محلياً بـ503 ولا يغادر
  // الجهاز. الردّ (لا الإجهاض) مقصود: الإجهاض يولّد ضجيج `net::ERR_` في وحدة
  // التحكم فيخلط الحارس بين قطعٍ مقصود وخطأ حقيقي.
  await page.route("**", (route) => {
    if (route.request().url().startsWith(BASE)) return route.continue();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "external network blocked in critical-journeys test" }),
    });
  });

  await page.goto(`${BASE}/index.html${search}`, { waitUntil: "domcontentloaded" });
  if (waitForBoot) {
    // `state` مُعرَّف بـconst في سكربت كلاسيكي: لا يظهر على window لكنه مرئي
    // لـeval العام. نفس الحيلة المستعملة في حرّاس النشرة — بلا أي منفذ اختبار
    // في كود الإنتاج.
    await pollUntil(page, () => {
      try { return (0, eval)("state") !== undefined; } catch { return false; }
    }, { timeout: 20000, message: "لم يُعرَّف state — لم تُحمَّل src/app.js أصلاً" });
    await pollUntil(page, () => {
      try { return (0, eval)("state").loading === false; } catch { return false; }
    }, { timeout: 30000, message: "لم ينتهِ إقلاع التطبيق (state.loading بقي true)" });
  }

  return { pageErrors, consoleErrors, writeRequests, assetFailures };
}

async function seedSession(page, extra = {}) {
  await page.evaluate(({ session, data }) => {
    const state = (0, eval)("state");
    state.session = session;
    window.__ozkSession = session;
    Object.assign(state, data);
    (0, eval)("render")();
  }, { session: TEST_SESSION, data: extra });
}

const gotoRoute = (page, route) => page.evaluate((target) => {
  (0, eval)("setRoute")(target);
}, route);

const currentRoute = (page) => page.evaluate(() => (0, eval)("state").route);

function assertClean(name, { pageErrors, consoleErrors, assetFailures }) {
  assert(pageErrors.length === 0, `${name}: أخطاء JavaScript غير ملتقَطة — ${pageErrors.join(" | ")}`);
  assert(consoleErrors.length === 0, `${name}: console.error — ${consoleErrors.join(" | ")}`);
  assert(!assetFailures || assetFailures.length === 0,
    `${name}: أصول من الأصل نفسه أخفقت — ${(assetFailures || []).join(" | ")}`);
}

// ---------------------------------------------------------------------------
// بيانات اختبار اصطناعية — لا سطر واحد منها من الإنتاج.
// ---------------------------------------------------------------------------
const TEST_ITEMS = [
  { key: "t1", itemKey: "t1", name: "صنف اختبار ألف", itemName: "صنف اختبار ألف", groupName: "مجموعة اختبار",
    stockQty: 400, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
  { key: "t2", itemKey: "t2", name: "صنف اختبار باء", itemName: "صنف اختبار باء", groupName: "مجموعة اختبار",
    stockQty: 250, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50 },
];

const TEST_PRICES = TEST_ITEMS.map((item, index) => ({
  itemKey: item.itemKey,
  itemName: item.itemName,
  itemNumber: String(1000 + index),
  unit1Name: item.unit1Name,
  unit2Name: item.unit2Name,
  unit2Factor: item.unit2Factor,
  unit2Price: 300 + index,
  pricePayload: { retail: { price: 320 + index } },
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

const TEST_STOCK_REPORT = [{
  items: TEST_ITEMS,
  summary: { syncedAt: "2026-01-01T00:00:00.000Z", activeMovement: 1, staleMovement: 1, restocked: 0 },
}];

const TEST_BALANCE_REPORT = [{
  items: [
    { key: "c1", name: "زبون اختبار أول", balance: 1500, lastPaymentDate: "2026-01-01", lastPaymentAmount: 500 },
    { key: "c2", name: "زبون اختبار ثانٍ", balance: -200, lastPaymentDate: "2026-01-02", lastPaymentAmount: 800 },
  ],
  summary: { syncedAt: "2026-01-02T00:00:00.000Z" },
}];

// المسارات التي يفتحها رابط عميق بلا جلسة. المسارات المحصورة بالمالك
// (decision / command) خارج القائمة لأنها تُردّ عمداً بلا صلاحية.
const PUBLIC_DEEP_LINK_ROUTES = [
  "overview", "login", "requests", "ameen", "balances", "pricing", "remote",
  "monitoring", "payments", "sales", "purchases", "warehouses",
  "inventoryRecon", "staff", "search", "ai", "dashboard",
];

console.log("فحص المسارات الحرجة (Critical Journeys):");
// `bypass` يُبقي الاسترجاع مباشراً فيعمل خادمنا المحلي، وكل ما عداه يمرّ
// بالوكيل — بما فيه ما يصدر عن Service Worker، لأن الإعداد عند طبقة الشبكة
// لا عند طبقة التوجيه.
const chromiumBrowser = await chromium.launch({
  proxy: { server: PROXY, bypass: "127.0.0.1,localhost" },
});

// ===== ١) الإقلاع =====
await journey("boot", "الموقع يفتح ويُرسم بلا أي خطأ JavaScript عند التحميل", async (page) => {
  const collected = await openApp(page);
  assert(await page.locator(".app-shell").count() > 0, "لم تُرسم قشرة التطبيق (.app-shell)");
  assert(await page.locator("aside nav [data-route]").count() >= 3, "شريط التنقل فارغ أو ناقص");
  const title = (await page.locator(".topbar h1").first().innerText()).trim();
  assert(title.length > 0, "عنوان الصفحة فارغ");
  assertClean("الإقلاع", collected);
  // لا طلب كتابة واحد عند مجرد فتح الموقع.
  assert(collected.writeRequests.length === 0,
    `فتح الموقع أطلق طلبات كتابة: ${collected.writeRequests.join(" | ")}`);
});

// ===== ٢) الإقلاع المتدهور =====
await journey("degraded-boot", "تعذّر الاتصال بقاعدة البيانات يُظهر لوحة تدهور بدل انهيار", async (page) => {
  const collected = await openApp(page);
  // الشبكة مقطوعة أصلاً في كل هذه الفحوص: هذا بالضبط سيناريو «Supabase غير
  // متاح». المطلوب إثبات أن التطبيق يبقى قابلاً للاستعمال.
  assert(await page.locator(".app-shell").count() > 0, "انهارت الواجهة عند تعذّر الاتصال");
  const retryOrShell = await page.locator("[data-startup-degraded], .app-shell").count();
  assert(retryOrShell > 0, "لا لوحة تدهور ولا قشرة تطبيق");
  assertClean("الإقلاع المتدهور", collected);
});

// ===== ٣) تسجيل الدخول =====
await journey("login", "تسجيل الدخول ينشئ جلسة وينقل إلى الرئيسية (مزوّد مُحاكى، بلا مصادقة حقيقية)", async (page) => {
  const collected = await openApp(page, { search: "?route=login" });
  assert(await page.locator("[data-form='login']").count() === 1, "نموذج الدخول غير موجود");

  // نستبدل `signIn` على كائن dataStore نفسه (window.tobaccoData) — نفس أسلوب
  // حرّاس النشرة. المصادقة الحقيقية غير مسموحة هنا: لا حساب اختبار على
  // Supabase الإنتاجي، وإنشاء جلسة حقيقية كتابةٌ على نظام حيّ.
  await page.evaluate(() => {
    window.tobaccoData.signIn = async () => ({
      session: { id: "mock", name: "حساب اختبار محلي", role: "المالك",
                 email: "owner@example.invalid", accessRole: "owner" },
    });
  });

  await page.fill("[data-form='login'] input[name='email']", "owner@example.invalid");
  await page.fill("[data-form='login'] input[name='password']", "test-password-1234");
  await page.click("[data-form='login'] [data-auth-action='signin']");

  await pollUntil(page, () => {
    try { return !!(0, eval)("state").session; } catch { return false; }
  }, { timeout: 15000, message: "لم تُنشأ جلسة بعد إرسال نموذج الدخول" });
  // saveSession تُكمل بعد الجلسة سلسلةَ مُحمّلات (كلها مقطوعة الشبكة هنا فتُعالَج
  // بالتقاط الخطأ) ثم تنقل إلى الرئيسية. فالانتقال يقع بعد الجلسة لا معها.
  await pollUntil(page, () => {
    try { return (0, eval)("state").route === "overview"; } catch { return false; }
  }, { timeout: 15000, message: "الدخول لم ينقل المستخدم إلى الرئيسية" });
  assert(await page.locator(".app-shell [data-route='dashboard']").count() > 0,
    "شريط التنقل لم يعرض صفحات الجلسة بعد الدخول");
  assertClean("تسجيل الدخول", collected);
});

// ===== ٤) الروابط العميقة =====
await journey("deep-links", "كل مسار عام يفتح عبر ?route= ويصل إلى صفحته بلا انهيار", async (page, context) => {
  const problems = [];
  for (const route of PUBLIC_DEEP_LINK_ROUTES) {
    const routePage = await context.newPage();
    try {
      const collected = await openApp(routePage, { search: `?route=${route}` });
      const landed = await routePage.evaluate(() => (0, eval)("state").route);
      if (landed !== route) problems.push(`${route}: هبط على "${landed}"`);
      if (await routePage.locator(".app-shell").count() === 0) problems.push(`${route}: لم تُرسم القشرة`);
      const heading = (await routePage.locator(".topbar h1").first().innerText().catch(() => "")).trim();
      if (!heading) problems.push(`${route}: عنوان الصفحة فارغ (مسار غير مسجّل في pageTitle؟)`);
      if (collected.pageErrors.length) problems.push(`${route}: ${collected.pageErrors.join(" | ")}`);
      if (collected.consoleErrors.length) problems.push(`${route}: console.error — ${collected.consoleErrors.join(" | ")}`);
      if (collected.assetFailures.length) problems.push(`${route}: أصول أخفقت — ${collected.assetFailures.join(" | ")}`);
    } finally {
      await routePage.close();
    }
  }
  assert(problems.length === 0, problems.join("\n     "));
});

// ===== ٥) التنقل بالضغط + صفر أخطاء عبر كل المسارات =====
await journey("navigation", "التنقل بأزرار الشريط الجانبي بجلسة مالك: كل صفحة تُرسم بلا pageerror ولا console.error", async (page) => {
  const collected = await openApp(page);
  await seedSession(page, {
    inventoryReports: TEST_STOCK_REPORT,
    customerBalanceReports: TEST_BALANCE_REPORT,
    approvedPriceItems: TEST_PRICES,
  });

  const routes = await page.locator("aside nav [data-route]").evaluateAll(
    (nodes) => nodes.map((node) => node.dataset.route)
  );
  assert(routes.length >= 5, `شريط التنقل يعرض ${routes.length} مسارات فقط — يُتوقّع أكثر بجلسة مالك`);

  const problems = [];
  for (const route of routes) {
    // نعود إلى الرئيسية قبل كل نقرة كي يُعاد بناء الشريط كاملاً.
    // السبب سلوك إنتاجي مقصود لا عطل: `command-center.js` يلفّ `render` ويرسم
    // صفحته ثم **يعود مبكراً** بلا استدعاء الحلقة الأدنى، فلا تعمل
    // `addDecisionNav()` ويغيب زر «قرار اليوم» ما دمنا داخل مركز القيادة.
    // اختبار التنقّل يفحص أن كل صفحة تُفتح وتُرسم، لا ترتيبَ أزرارٍ عابراً.
    await gotoRoute(page, "overview");
    const button = page.locator(`aside nav [data-route='${route}']`).first();
    if (await button.count() === 0) { problems.push(`${route}: الزر غير موجود في الشريط بعد العودة للرئيسية`); continue; }
    await button.click();
    const landed = await currentRoute(page);
    if (landed !== route) problems.push(`${route}: النقر أوصل إلى "${landed}"`);
    if (await page.locator(".app-shell").count() === 0) problems.push(`${route}: لم تُرسم القشرة`);
    const heading = (await page.locator(".topbar h1").first().innerText().catch(() => "")).trim();
    if (!heading) problems.push(`${route}: عنوان الصفحة فارغ`);
  }
  assert(problems.length === 0, problems.join("\n     "));
  assertClean("التنقل", collected);
});

// ===== ٦) المخزون والجرد =====
await journey("inventory", "صفحات المخزون والجرد (الأمين · المستودعات · الجرد الشهري · الجرد الذكي) تُعرض ببياناتها", async (page) => {
  const collected = await openApp(page);
  await seedSession(page, { inventoryReports: TEST_STOCK_REPORT, approvedPriceItems: TEST_PRICES });

  await gotoRoute(page, "ameen");

  assert(await page.locator(".app-shell").count() > 0, "صفحة الأمين لم تُرسم");
  // المرشّح الافتراضي «تنبيهات» يعرض النواقص وحدها، فنختار «الكل» كما يفعل
  // المستخدم — بنقر الشريحة نفسها، فيُفحَص ربط المرشّحات لا الحالة وحدها.
  await page.locator("[data-ameen-filter='all']").click();
  const shown = (await page.locator("[data-ameen-count]").innerText()).trim();
  assert(/2/.test(shown), `عدّاد المواد لا يعكس الأصناف المزروعة: "${shown}"`);
  assert(await page.locator(".inventory-row").count() >= 2,
    "صفحة المخزون لا تعرض صفوف الأصناف — انكسر مسار عرض تقرير الأمين");
  // المجموعات تُعرض داخل <details> مطوية: نفتحها كما يفعل المستخدم ثم نطالب
  // بظهور الاسم فعلاً — لا بوجوده في الترميز وحده.
  await page.locator(".inventory-list .acc-summary").first().click();
  await page.locator(".inventory-row", { hasText: "صنف اختبار" }).first().waitFor({ state: "visible", timeout: 10000 });

  for (const route of ["warehouses", "inventoryRecon", "smartInventory"]) {
    await gotoRoute(page, route);
    assert(await currentRoute(page) === route, `${route}: لم يُفتح`);
    assert(await page.locator(".app-shell, .counter-shell").count() > 0, `${route}: لم تُرسم القشرة`);
    const heading = (await page.locator(".topbar h1").first().innerText().catch(() => "")).trim();
    assert(heading.length > 0, `${route}: عنوان الصفحة فارغ`);
  }
  assertClean("المخزون والجرد", collected);
});

// ===== ٧) الذمم =====
await journey("balances", "صفحة الذمم تعرض أرصدة الزبائن المزروعة بلا أخطاء", async (page) => {
  const collected = await openApp(page);
  await seedSession(page, { customerBalanceReports: TEST_BALANCE_REPORT });
  await gotoRoute(page, "balances");

  assert(await currentRoute(page) === "balances", "صفحة الذمم لم تُفتح");
  const text = await page.locator("body").innerText();
  assert(text.includes("زبون اختبار أول"), "اسم الزبون المزروع لا يظهر — انكسر عرض تقرير الأرصدة");
  assert(await page.locator(".customer-balances").count() > 0, "لوحة أرصدة الزبائن غير موجودة");
  assertClean("الذمم", collected);
});

// ===== ٨) الفاتورة =====
await journey("sales-invoice", "الفاتورة: بحث ← اختيار صنف ← كمية ← سعر، مع صفر كتابة على الشبكة", async (page) => {
  const collected = await openApp(page);
  await seedSession(page, { approvedPriceItems: TEST_PRICES, inventoryReports: TEST_STOCK_REPORT });
  await gotoRoute(page, "sales");
  assert(await currentRoute(page) === "sales", "صفحة الفاتورة لم تُفتح");

  const search = page.locator("[data-sales-field='q'][data-sales-index='0']");
  assert(await search.count() === 1, "حقل بحث الصنف غير موجود في الفاتورة");
  await search.fill("صنف اختبار ألف");
  await page.waitForSelector("[data-sales-suggest='0'] [data-sales-pick]", { timeout: 10000 });
  await search.press("Enter"); // يعتمد أول اقتراح — نفس ما يفعله المستخدم بلا ماوس

  await pollUntil(page, () => {
    try { return !!(0, eval)("state").salesRows[0].key; } catch { return false; }
  }, { timeout: 10000, message: "Enter في حقل البحث لم يعتمد أول اقتراح — انكسر ربط الاختصار" });

  await page.fill("[data-sales-field='qty'][data-sales-index='0']", "2");
  await page.fill("[data-sales-field='price'][data-sales-index='0']", "100");

  const lineTotal = (await page.locator("[data-sales-linetotal='0']").innerText()).trim();
  const grandTotal = (await page.locator("[data-sales-total]").first().innerText()).trim();
  assert(/200/.test(lineTotal), `إجمالي السطر لم يُحسب: "${lineTotal}"`);
  assert(/200/.test(grandTotal), `إجمالي الفاتورة لم يُحسب: "${grandTotal}"`);

  // العقد الأهم في هذا المسار: تجهيز فاتورة لا يكتب شيئاً في أي مكان.
  // زر «حفظ الفاتورة» لا يُضغط إطلاقاً هنا.
  assert(collected.writeRequests.length === 0,
    `تجهيز الفاتورة أطلق طلبات كتابة: ${collected.writeRequests.join(" | ")}`);
  assertClean("الفاتورة", collected);
});

// ===== ٩) نشرة الأسعار المنشورة =====
await journey("published-bulletin", "نشرة الأسعار المنشورة وصفحة اختيار النشرات تفتحان وتعرضان محتواهما", async (page, context) => {
  const bulletinErrors = [];
  page.on("pageerror", (error) => bulletinErrors.push(String(error?.message || error)));
  await page.goto(`${BASE}/public/downloads/price-list-usd.html`, { waitUntil: "domcontentloaded" });
  const bulletinText = await page.locator("body").innerText();
  assert(bulletinText.trim().length > 200, "نشرة الدولار المنشورة تكاد تكون فارغة");
  assert(await page.locator(".price-pdf-item, tr, li").count() > 5, "النشرة المنشورة بلا صفوف أصناف");

  const indexPage = await context.newPage();
  const indexErrors = [];
  indexPage.on("pageerror", (error) => indexErrors.push(String(error?.message || error)));
  await indexPage.goto(`${BASE}/public/downloads/index.html`, { waitUntil: "domcontentloaded" });
  assert(await indexPage.locator("a[href$='.pdf'], a[href$='.html']").count() > 0,
    "صفحة اختيار النشرات بلا روابط");
  await indexPage.close();

  assert(bulletinErrors.length === 0 && indexErrors.length === 0,
    `أخطاء JavaScript في النشرات: ${[...bulletinErrors, ...indexErrors].join(" | ")}`);
});

// ===== ١٠) معاينة/تصدير النشرة: لا صفحة عنوان منفصلة ولا صفحة فارغة =====
await journey("bulletin-preview", "معاينة النشرة: الرأس والأصناف على الورقة الأولى معاً، وكل ورقة تحمل أصنافاً", async (page) => {
  const collected = await openApp(page);
  await seedSession(page, {
    inventoryReports: TEST_STOCK_REPORT,
    approvedPriceItems: TEST_PRICES,
    syriaExchangeRate: 14050,
    syriaRateConfirmed: true,
  });

  await page.evaluate(() => { window.openPricePreview(false, "dark"); });
  await page.waitForSelector(".price-preview-shell .ozk-price-list", { timeout: 15000 });

  // بنية القالب: `.ozk-price-list` مستند واحد، ورأسه `.price-list-header` خارج
  // كتل الصفحات في أعلاه، وكل `.price-list-columns` ورقةٌ مطبوعة. وكل كتلة عدا
  // أولى المستند تحمل `price-list-secondary-page` أي فاصل صفحة قسري.
  // فإذا خرجت أولى الكتل فارغة أُسقطت من الترميز، وصارت أولُ كتلة مرسومة تحمل
  // فاصلاً قسرياً — أي أن الرأس يبقى وحده على الورقة الأولى: **صفحة عنوان
  // منفصلة** يستلمها الزبون. وكتلة بلا أي مجموعة = ورقة فارغة.
  const layout = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll(".price-preview-shell .price-list-columns")];
    return {
      documents: document.querySelectorAll(".price-preview-shell .ozk-price-list").length,
      headers: document.querySelectorAll(".price-preview-shell .price-list-header").length,
      blockCount: blocks.length,
      firstBlockForcesBreak: !!blocks[0]?.classList.contains("price-list-secondary-page"),
      groupsPerBlock: blocks.map((node) => node.querySelectorAll(".price-list-group").length),
      rowsPerBlock: blocks.map((node) => node.querySelectorAll("tbody tr").length),
    };
  });

  assert(layout.documents === 1, `عدد مستندات النشرة في المعاينة = ${layout.documents}`);
  assert(layout.headers === 1, `عدد رؤوس النشرة = ${layout.headers} (يُتوقّع رأس واحد)`);
  assert(layout.blockCount > 0, "المعاينة بلا أي ورقة");
  assert(!layout.firstBlockForcesBreak,
    "أول ورقة مرسومة تبدأ بفاصل قسري — الرأس وحده على الورقة الأولى (صفحة عنوان منفصلة)");
  const emptyBlock = layout.groupsPerBlock.findIndex((count) => count === 0);
  assert(emptyBlock === -1, `الورقة رقم ${emptyBlock + 1} بلا أي مجموعة — ورقة فارغة`);
  const rowlessBlock = layout.rowsPerBlock.findIndex((count) => count === 0);
  assert(rowlessBlock === -1, `الورقة رقم ${rowlessBlock + 1} بلا أي صنف — ورقة فارغة`);
  assertClean("معاينة النشرة", collected);
});

// ===== ١١) Service Worker =====
await journey("service-worker", "الـService Worker يُسجَّل ويسيطر، والتطبيق يبقى يعمل بعد إعادة التحميل", async (page) => {
  const collected = await openApp(page);
  const registered = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return { supported: false };
    const registration = await navigator.serviceWorker.getRegistration();
    return { supported: true, hasRegistration: !!registration, scope: registration?.scope || "" };
  });
  assert(registered.supported, "المتصفح بلا دعم Service Worker — تعذّر الفحص");
  assert(registered.hasRegistration, "لم يُسجَّل أي Service Worker عند تحميل الصفحة");
  // النطاق الجذري هو سبب وجود الغلاف في جذر المستودع أصلاً.
  assert(registered.scope.endsWith("/"), `نطاق التسجيل ليس جذرياً: ${registered.scope}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await pollUntil(page, () => {
    try { return (0, eval)("state").loading === false; } catch { return false; }
  }, { timeout: 30000, message: "التطبيق لم يُكمل الإقلاع بعد إعادة التحميل مع SW فعّال" });
  assert(await page.locator(".app-shell").count() > 0, "التطبيق لا يُرسم بعد إعادة التحميل مع SW فعّال");
  assertClean("Service Worker", collected);
}, { serviceWorkers: "allow" });

// ===== شهادة العزل الشبكي =====
// كل ما تجاوز توجيه الصفحة انتهى عند الوكيل المحلي في هذه العملية. نطبع ما
// حاول الخروج (دليلٌ لا ادّعاء)، ونُفشل الفحص إن قصد وجهةً غير متوقَّعة —
// فتسريبٌ جديد لا يمرّ لمجرد أنه صامت.
// مضيفات يقصدها التطبيق فعلاً وهي مقطوعة عمداً. المقارنة بلاحقة اسم المضيف
// المستخرَج، لا بمطابقة السطر — فلا تمرّ وجهة جديدة بحيلة صياغة.
const EXPECTED_ESCAPE_HOSTS = ["supabase.co", "rollbar.com", "fonts.googleapis.com", "fonts.gstatic.com"];
const isExpectedHost = (host) => EXPECTED_ESCAPE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
const unexpectedEscapes = escapeAttempts.filter((entry) => !isExpectedHost(entry.host));

if (escapeAttempts.length) {
  const counts = new Map();
  for (const entry of escapeAttempts) {
    const label = `${entry.kind} ${entry.target}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  console.log("\nطلبات تجاوزت توجيه الصفحة وانتهت عند الوكيل المحلي (لم تغادر الجهاز):");
  for (const [label, count] of counts) console.log(`   • ${label}${count > 1 ? ` ×${count}` : ""}`);
  console.log("   (هذه هي ثغرة Service Worker التي رصدها Codex — الوكيل هو ما يوقفها فعلياً.)");
}
if (unexpectedEscapes.length) {
  const detail = unexpectedEscapes.map((entry) => `${entry.kind} ${entry.target}`).join(" | ");
  failures.push({ id: "network-isolation", name: "العزل الشبكي: لا وجهة خارجية غير متوقَّعة", message: detail });
  console.error(`  ❌ العزل الشبكي: وجهات غير متوقَّعة — ${detail}`);
} else {
  passed += 1;
  console.log(`  ✅ العزل الشبكي: ${escapeAttempts.length} محاولة خروج، كلها انتهت عند الوكيل المحلي ولا وجهة غير متوقَّعة`);
}

// ===== النتيجة =====
await chromiumBrowser.close();
server.close();
proxySink.close();

if (failures.length) {
  console.error(`\n✗ فشل ${failures.length} من المسارات الحرجة:`);
  for (const failure of failures) console.error(`   • ${failure.name}`);
  console.error(`\nالآثار واللقطات: ${ARTIFACTS}`);
  process.exit(1);
}
console.log(`\n✓ كل المسارات الحرجة نجحت (${passed} مساراً).`);
