#!/usr/bin/env node
// ============================================================================
// حارس إقلاع الواجهة: تحذير «تعذر الاتصال بقاعدة البيانات» وشريط إذن الإشعارات.
//
// العطلان المثبتان (تدقيق 2026-10-24):
//   • P2: التحذير كان يظهر بمجرد تجاوز 12 ثانية، أو عند أي استثناء في boot()،
//     دون أي فحص للاتصال. وكل دوال التحميل تبتلع أخطاءها، فلا علاقة للتحذير
//     بفشل اتصال فعلي. ومن الاستثناءات المثبتة `new Notification` الذي يرمي
//     TypeError على Chrome أندرويد داخل try الإقلاع.
//   • P3: إذن الإشعارات كان يُقرأ في آخر boot() فقط، فظهر الشريط طوال
//     الإقلاع لمن منح الإذن أو رفضه؛ ولا «لاحقاً»؛ وطلبان للإذن في نقرة واحدة.
//
// يشغّل التطبيق الحقيقي في Chromium عبر scripts/serve.mjs. Supabase مُحاكى
// بالكامل بـroute: لا طلب يغادر الجهاز، ولا حساب حقيقي — الجلسة رمز وهمي في
// localStorage بالمفتاح الذي يقرؤه supabase-js، فتمرّ الطلبات بمسار fetch
// الحقيقي (وهو ما يرصده عدّاد الاتصال الجديد). Notification وSentry مُحاكيان.
// ============================================================================
import { chromium } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
const { server } = await import("./serve.mjs");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;
const SUPABASE_HOST = "dyxbirfpxeocqffnfdeb.supabase.co";
const STORAGE_KEY = "sb-dyxbirfpxeocqffnfdeb-auth-token";
const SNOOZE_KEY = "notif-prompt-snoozed-until";
const STARTUP_TIMEOUT_MS = 12000;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch(launchOptions);

const TEST_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "startup-guard@example.invalid",
  app_metadata: { role: "employee" },
  user_metadata: {}
};

function fakeSession() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: "test-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: "test-refresh-token",
    user: TEST_USER
  };
}

// زبون وهمي مدين بلا دفعة منذ عشرة أيام — يكفي لإطلاق تنبيه الديون.
const OVERDUE_BALANCES_REPORT = {
  id: "00000000-0000-4000-8000-0000000000b1",
  report_date: new Date().toISOString().slice(0, 10),
  source: "ameen_customer_balances",
  summary: {},
  items: [{ key: "test-customer", name: "زبون اختبار", balance: 100, lastPaymentDate: new Date(Date.now() - 10 * 86400000).toISOString() }],
  created_at: new Date().toISOString()
};

// mode: ok | down | 5xx. delayBalancesMs يؤخّر تقرير الأرصدة وحده (البطء الحقيقي).
async function installRoutes(context, { mode = "ok", delayBalancesMs = 0, balancesReport = null, log }) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === BASE) return route.continue();
    if (url.hostname !== SUPABASE_HOST) return route.abort("blockedbyclient");
    log.push({ path: url.pathname, search: url.search });
    if (mode === "down") return route.abort("internetdisconnected");
    if (mode === "5xx") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "unavailable" }) });
    if (url.pathname.startsWith("/auth/v1/user")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(TEST_USER) });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const isBalances = url.pathname === "/rest/v1/inventory_reports" && url.search.includes("source=eq.ameen_customer_balances");
      if (isBalances && delayBalancesMs) await new Promise((done) => setTimeout(done, delayBalancesMs));
      if (String(request.headers().accept || "").includes("vnd.pgrst.object")) {
        return route.fulfill({ status: 406, contentType: "application/json", body: JSON.stringify({ code: "PGRST116", message: "no rows" }) });
      }
      const rows = isBalances && balancesReport ? [balancesReport] : [];
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": `0-${Math.max(rows.length - 1, 0)}/${rows.length}` }, body: JSON.stringify(rows) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

async function openApp({ session = true, permission = "default", answer = "default", constructorThrows = false, snoozeUntil = 0, routes = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const log = [];
  await installRoutes(context, { ...routes, log });
  await context.addInitScript((cfg) => {
    window.__notif = { request: 0, constructed: 0 };
    let permission = cfg.permission;
    class FakeNotification {
      constructor() {
        window.__notif.constructed += 1;
        if (cfg.constructorThrows) {
          throw new TypeError("Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
        }
      }
      static get permission() { return permission; }
      static requestPermission() {
        window.__notif.request += 1;
        return new Promise((done) => setTimeout(() => {
          if (cfg.answer !== "default") permission = cfg.answer;
          done(permission);
        }, 150));
      }
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true, writable: true });
    window.__sentry = [];
    window.Sentry = {
      captureMessage: (message, options) => window.__sentry.push({ message, options }),
      captureException: (error) => window.__sentry.push({ exception: String(error?.name || "") })
    };
    if (!sessionStorage.getItem("__seeded")) {
      sessionStorage.setItem("__seeded", "1");
      if (cfg.session) localStorage.setItem(cfg.storageKey, JSON.stringify(cfg.session));
      if (cfg.snoozeUntil) localStorage.setItem(cfg.snoozeKey, String(cfg.snoozeUntil));
    }
  }, { permission, answer, constructorThrows, snoozeUntil, session: session ? fakeSession() : null, storageKey: STORAGE_KEY, snoozeKey: SNOOZE_KEY });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
  await page.goto(`${BASE}/index.html`);
  return { context, page, log, pageErrors };
}

const count = (page, selector) => page.locator(selector).count();
const panels = async (page) => ({
  degraded: await count(page, "[data-startup-degraded]"),
  slow: await count(page, "[data-startup-slow]"),
  appError: await count(page, "[data-startup-app-error]"),
  banner: await count(page, ".notif-banner")
});
const waitBooted = (page) => page.waitForFunction(() => typeof state !== "undefined" && state.loading === false, null, { timeout: 30000 });
const startupReports = (page) => page.evaluate(() => window.__sentry.filter((entry) => String(entry.message || "").startsWith("startup:")));

let passed = 0;
const failures = [];
async function test(name, fn) {
  let opened = null;
  try {
    await fn((options) => openApp(options).then((value) => (opened = value)));
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ❌ ${name}\n     ${String(error?.message || error)}`);
  } finally {
    if (opened) await opened.context.close();
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function assertSafeMetrics(reports) {
  for (const report of reports) {
    for (const [key, value] of Object.entries(report.options?.extra || {})) {
      assert(/^[A-Za-z]{1,32}$/.test(key) && Number.isFinite(value), `قياس Sentry يحمل قيمة غير رقمية أو مفتاحاً غير ثابت: ${key}=${value}`);
    }
    for (const value of Object.values(report.options?.tags || {})) {
      assert(/^[A-Za-z:-]{1,40}$/.test(String(value)), `وسم Sentry ليس قيمة ثابتة: ${value}`);
    }
  }
}

console.log("\n١) تحذير الاتصال لا يظهر إلا بدليل فشل اتصال");

await test("اتصال سليم: لا تحذير ولا قياس، وتقرير أرصدة واحد بدل 12", async (open) => {
  const { page, log, pageErrors } = await open({ permission: "granted" });
  await waitBooted(page);
  const shown = await panels(page);
  assert(!shown.degraded && !shown.slow && !shown.appError, `ظهرت لوحة إقلاع بلا سبب: ${JSON.stringify(shown)}`);
  const balances = log.filter((entry) => entry.search.includes("source=eq.ameen_customer_balances"));
  assert(balances.length >= 1, "لم يُطلب تقرير الأرصدة أصلاً");
  assert(balances.every((entry) => /(?:^|&|\?)limit=1(?:&|$)/.test(entry.search)), `تقرير الأرصدة لا يُطلب بـlimit=1: ${balances.map((e) => e.search).join(" | ")}`);
  assert((await startupReports(page)).length === 0, "أُرسل قياس إقلاع رغم إقلاع سليم");
  assert(pageErrors.length === 0, `استثناءات في الصفحة: ${pageErrors.join(" | ")}`);
});

await test("بطء بلا فشل (أرصدة بعد 13.5 ثانية): «يستغرق أطول» لا «تعذر الاتصال»، ثم يختفي", async (open) => {
  const { page } = await open({ permission: "granted", routes: { delayBalancesMs: 13500 } });
  await page.waitForSelector("[data-startup-slow]", { timeout: STARTUP_TIMEOUT_MS + 4000 });
  let shown = await panels(page);
  assert(!shown.degraded, "ظهر «تعذر الاتصال» لمجرد البطء");
  const slowText = await page.locator("[data-startup-slow]").innerText();
  assert(!slowText.includes("تعذر الاتصال"), "نص البطء يدّعي فشل الاتصال");
  await page.waitForSelector("[data-startup-slow]", { state: "detached", timeout: 10000 });
  shown = await panels(page);
  assert(!shown.degraded && !shown.appError, `بقيت لوحة بعد اكتمال التحميل: ${JSON.stringify(shown)}`);
  const reports = await startupReports(page);
  const outcomes = reports.map((r) => r.options?.tags?.startup_outcome);
  assert(outcomes.includes("slow") && outcomes.includes("late"), `القياس لم يسجّل البطء ثم الاكتمال المتأخر: ${outcomes.join(",")}`);
  assert(reports.every((r) => r.options?.level === "warning"), "البطء أُرسل بمستوى خطأ");
  const late = reports.find((r) => r.options?.tags?.startup_outcome === "late");
  assert(late.options.extra.balances >= 13000, `مدة مرحلة الأرصدة لم تُقَس: ${JSON.stringify(late.options.extra)}`);
  assertSafeMetrics(reports);
});

await test("انقطاع حقيقي (رفض كل طلبات Supabase): تحذير الاتصال يظهر ويُقاس", async (open) => {
  const { page } = await open({ permission: "granted", routes: { mode: "down" } });
  await waitBooted(page);
  const shown = await panels(page);
  assert(shown.degraded === 1, "لم يظهر تحذير الاتصال رغم انقطاع فعلي");
  assert(!shown.slow && !shown.appError, `لوحة إضافية مع الانقطاع: ${JSON.stringify(shown)}`);
  const reports = await startupReports(page);
  const connection = reports.find((r) => r.options?.tags?.startup_outcome === "connection");
  assert(connection && connection.options.extra.networkFailures > 0, `قياس الانقطاع لا يحمل عدد الطلبات المرفوضة: ${JSON.stringify(reports)}`);
  assertSafeMetrics(reports);
});

await test("خادم Supabase يرد 503: تحذير الاتصال يظهر", async (open) => {
  const { page } = await open({ permission: "granted", routes: { mode: "5xx" } });
  await waitBooted(page);
  assert((await panels(page)).degraded === 1, "لم يظهر التحذير مع 503");
});

await test("زائر بلا جلسة مع انقطاع: التحذير يظهر (طلب سعر الصرف فشل فعلاً)", async (open) => {
  const { page } = await open({ session: false, routes: { mode: "down" } });
  await waitBooted(page);
  assert((await panels(page)).degraded === 1, "لم يظهر التحذير لزائر مع انقطاع");
});

await test("زائر بلا جلسة واتصال سليم: لا تحذير", async (open) => {
  const { page } = await open({ session: false });
  await waitBooted(page);
  const shown = await panels(page);
  assert(!shown.degraded && !shown.slow && !shown.appError, `ظهرت لوحة لزائر: ${JSON.stringify(shown)}`);
});

await test("Chrome أندرويد: new Notification يرمي وتنبيه الديون يُطلق — لا تحذير ولا استثناء", async (open) => {
  const { page, pageErrors } = await open({ permission: "granted", constructorThrows: true, routes: { balancesReport: OVERDUE_BALANCES_REPORT } });
  await waitBooted(page);
  await page.waitForFunction(() => window.__notif.constructed > 0, null, { timeout: 5000 });
  const shown = await panels(page);
  assert(!shown.degraded && !shown.appError && !shown.slow, `خطأ الإشعار أظهر لوحة إقلاع: ${JSON.stringify(shown)}`);
  assert(pageErrors.length === 0, `استثناء غير ملتقَط: ${pageErrors.join(" | ")}`);
});

await test("استثناء JavaScript لا علاقة له بالقاعدة: لوحة خطأ واجهة لا «تعذر الاتصال»، ويُرسَل الاستثناء", async (open) => {
  const { page } = await open({ permission: "granted" });
  await waitBooted(page);
  await page.evaluate(async () => {
    window.loadCustomerProfiles = async () => { throw new TypeError("simulated render bug"); };
    await boot();
  });
  const shown = await panels(page);
  assert(shown.appError === 1, "لم تظهر لوحة خطأ الواجهة");
  assert(!shown.degraded, "استثناء الواجهة عُرض كفشل اتصال");
  const appErrorText = await page.locator("[data-startup-app-error]").innerText();
  assert(appErrorText.includes("الاتصال بقاعدة البيانات يعمل"), "نص خطأ الواجهة لا يفصله عن الاتصال");
  const sentry = await page.evaluate(() => window.__sentry);
  assert(sentry.some((e) => e.options?.tags?.startup_outcome === "app-error" && e.options.tags.startup_error_type === "TypeError"), "قياس app-error ناقص");
  assert(sentry.some((e) => e.exception === "TypeError"), "الاستثناء الحقيقي لم يُرسَل إلى Sentry");
  assertSafeMetrics(sentry.filter((e) => e.message));
});

await test("إعادة الفتح بعد عودة الاتصال: لا يبقى أي تحذير", async (open) => {
  const { page, context } = await open({ permission: "granted", routes: { mode: "down" } });
  await waitBooted(page);
  assert((await panels(page)).degraded === 1, "التحذير لم يظهر في الفتح الأول");
  await context.unroute("**/*");
  await installRoutes(context, { mode: "ok", log: [] });
  await page.reload();
  await waitBooted(page);
  const shown = await panels(page);
  assert(!shown.degraded && !shown.slow && !shown.appError, `بقي تحذير بعد عودة الاتصال: ${JSON.stringify(shown)}`);
});

console.log("\n٢) شريط إذن الإشعارات");

await test("الإذن ممنوح: لا شريط حتى حين تُفتح الواجهة قبل اكتمال تحميل بطيء", async (open) => {
  // بعد المهلة تُفتح الواجهة والتحميل ما زال جارياً — هنا كان الشريط يظهر.
  const { page } = await open({ permission: "granted", routes: { delayBalancesMs: 13500 } });
  await page.waitForSelector("[data-startup-slow]", { timeout: STARTUP_TIMEOUT_MS + 4000 });
  assert(await page.evaluate(() => state.loading === false && state.session !== null), "الواجهة لم تُفتح بجلسة قبل اكتمال التحميل — لا يثبت شيئاً");
  assert((await panels(page)).banner === 0, "ظهر الشريط أثناء التحميل رغم الإذن الممنوح");
  await waitBooted(page);
  assert((await panels(page)).banner === 0, "ظهر الشريط بعد التحميل رغم الإذن الممنوح");
});

await test("الإذن مرفوض: لا شريط قبل اكتمال التحميل ولا بعده، ولا طلب إذن", async (open) => {
  // بعد المهلة تُفتح الواجهة والتحميل ما زال جارياً — هنا كان الشريط يظهر.
  const { page } = await open({ permission: "denied", routes: { delayBalancesMs: 13500 } });
  await page.waitForSelector("[data-startup-slow]", { timeout: STARTUP_TIMEOUT_MS + 4000 });
  assert(await page.evaluate(() => state.loading === false && state.session !== null), "الواجهة لم تُفتح بجلسة قبل اكتمال التحميل — لا يثبت شيئاً");
  assert((await panels(page)).banner === 0, "ظهر الشريط أثناء التحميل رغم الرفض");
  await waitBooted(page);
  assert((await panels(page)).banner === 0, "ظهر الشريط بعد التحميل رغم الرفض");
  assert((await page.evaluate(() => window.__notif.request)) === 0, "طُلب الإذن تلقائياً");
});

await test("الإذن غير محدد: الشريط يظهر، ولا طلب إذن بلا نقرة", async (open) => {
  const { page } = await open({ permission: "default" });
  await waitBooted(page);
  assert((await panels(page)).banner === 1, "لم يظهر الشريط والإذن غير محدد");
  assert(await count(page, "[data-action='snooze-notif']") === 1, "لا زر «لاحقاً»");
  assert((await page.evaluate(() => window.__notif.request)) === 0, "طُلب الإذن تلقائياً دون تفاعل");
});

await test("«لاحقاً» يخفي الشريط ويبقى مخفياً عند إعادة الفتح (14 يوماً)", async (open) => {
  const { page } = await open({ permission: "default" });
  await waitBooted(page);
  await page.click("[data-action='snooze-notif']");
  assert((await panels(page)).banner === 0, "لم يختفِ الشريط بعد «لاحقاً»");
  const until = Number(await page.evaluate((key) => localStorage.getItem(key), SNOOZE_KEY));
  const days = (until - Date.now()) / 86400000;
  assert(days > 13.9 && days <= 14.01, `مدة التأجيل غير صحيحة: ${days}`);
  await page.reload();
  await waitBooted(page);
  assert((await panels(page)).banner === 0, "عاد الشريط بعد إعادة الفتح رغم «لاحقاً»");
  assert((await page.evaluate(() => window.__notif.request)) === 0, "«لاحقاً» طلب الإذن");
});

await test("انتهاء مدة «لاحقاً»: يعود الشريط", async (open) => {
  const { page } = await open({ permission: "default", snoozeUntil: Date.now() - 1000 });
  await waitBooted(page);
  assert((await panels(page)).banner === 1, "لم يعد الشريط بعد انتهاء التأجيل");
});

await test("نقرتان سريعتان على «تفعيل»: طلب إذن واحد فقط، والرفض يُبلَّغ", async (open) => {
  const { page } = await open({ permission: "default", answer: "denied" });
  await waitBooted(page);
  await page.evaluate(() => {
    const button = document.querySelector("[data-action='enable-notif']");
    button.click();
    button.click();
    document.querySelector("[data-action='enable-notif']")?.click();
  });
  await page.waitForFunction(() => state.notifPermission === "denied", null, { timeout: 5000 });
  assert((await page.evaluate(() => window.__notif.request)) === 1, `عدد طلبات الإذن ${await page.evaluate(() => window.__notif.request)} لا 1`);
  assert((await panels(page)).banner === 0, "بقي الشريط بعد الرفض");
  const notice = await page.locator(".message-panel").innerText();
  assert(notice.includes("رُفض إذن الإشعارات"), `لم يُبلَّغ الرفض: ${notice}`);
});

await test("المنح عبر ozkWebPush.enable: طلب واحد ورسالة نجاح", async (open) => {
  const { page } = await open({ permission: "default", answer: "granted" });
  await waitBooted(page);
  await page.evaluate(() => {
    window.__pushEnable = 0;
    window.ozkWebPush = {
      supported: () => true,
      enable: async () => {
        window.__pushEnable += 1;
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("لم يتم السماح بالإشعارات.");
        return {};
      }
    };
  });
  await page.click("[data-action='enable-notif']");
  await page.waitForFunction(() => state.notifPermission === "granted", null, { timeout: 5000 });
  assert((await page.evaluate(() => [window.__notif.request, window.__pushEnable].join(","))) === "1,1", "المسار ليس طلباً واحداً عبر enable");
  assert((await panels(page)).banner === 0, "بقي الشريط بعد المنح");
  assert((await page.locator(".message-panel").innerText()).includes("تم تفعيل الإشعارات"), "لا رسالة نجاح");
});

await browser.close();
server.close();

console.log(`\nنجح ${passed} وفشل ${failures.length}`);
if (failures.length) {
  console.error(`check-startup-connection-notice: فشل ${failures.length}`);
  process.exit(1);
}
console.log("check-startup-connection-notice: OK");
