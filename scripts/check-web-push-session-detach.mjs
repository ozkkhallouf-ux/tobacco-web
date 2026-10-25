#!/usr/bin/env node
// ============================================================================
// حارس فصل اشتراك Push عن الجلسة (تدقيق الأجهزة المشتركة 2026-10-25).
//
// الثغرة: logout() كان يستدعي signOut() وحده، فيبقى اشتراك المتصفح وصفّه في
// الخادم مفعّلين باسم المالك، ويعرض الجهاز إشعاراته المالية بعد الخروج ولمن
// يدخل بعده. الإصلاح:
//   • الخروج يلغي اشتراك المتصفح ويعطّل صف هذا الجهاز في الخادم قبل signOut،
//     بمهلة، ولا يمنع الخروج أبداً. وما لم يكتمل يُستكمل عند الفتح التالي.
//   • زر «إعادة تفعيل الإشعارات» للمالك حين الإذن ممنوح ولا اشتراك.
//   • تنظيف اشتراك المالك عند فتح الموقع بحساب غير مالك مطفأ افتراضياً
//     (appConfig.webPush.detachNonOwnerSessions) احتراماً لاستثناء OZKUSER.
//
// التطبيق الحقيقي في Chromium عبر scripts/serve.mjs. Supabase مُحاكى بالكامل
// (لا طلب يغادر الجهاز، ولا حساب حقيقي)، وكذلك Service Worker وPushManager
// وNotification: الاشتراك الوهمي حالته في localStorage فتبقى بعد إعادة الفتح.
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
const PENDING_KEY = "ozk-push-detach-pending";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/detach-guard-test-endpoint";
const DETACH_TIMEOUT_MS = 3000;

const launchOptions = {};
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch(launchOptions);

const USERS = {
  owner: { id: "00000000-0000-4000-8000-0000000000a1", email: "owner-guard@example.invalid", app_metadata: { role: "owner" } },
  employee: { id: "00000000-0000-4000-8000-0000000000a2", email: "employee-guard@example.invalid", app_metadata: { role: "employee" } }
};

function fakeSession(kind) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: `test-access-token-${kind}`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `test-refresh-token-${kind}`,
    user: { aud: "authenticated", role: "authenticated", user_metadata: {}, ...USERS[kind] }
  };
}

// push: ok | 500 | down — ردّ دالة web-push وحدها؛ بقية Supabase سليمة.
async function installRoutes(context, ctl) {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === BASE) return route.continue();
    if (url.hostname !== SUPABASE_HOST) return route.abort("blockedbyclient");
    if (url.pathname === "/functions/v1/web-push") {
      ctl.pushCalls.push(JSON.parse(request.postData() || "{}"));
      if (ctl.push === "down") return route.abort("internetdisconnected");
      if (ctl.push === "500") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unsubscribe_failed" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    if (url.pathname.startsWith("/auth/v1/logout")) {
      ctl.logouts += 1;
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.pathname.startsWith("/auth/v1/user")) {
      const token = String(request.headers().authorization || "");
      const kind = token.includes("employee") ? "employee" : "owner";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fakeSession(kind).user) });
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (String(request.headers().accept || "").includes("vnd.pgrst.object")) {
        return route.fulfill({ status: 406, contentType: "application/json", body: JSON.stringify({ code: "PGRST116", message: "no rows" }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "0-0/0" }, body: "[]" });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

// unsubscribe: ok | hang | reject. registration: ok | hang.
async function openApp({ session = "owner", subscribed = true, permission = "granted", unsubscribe = "ok", registration = "ok", push = "ok", pending = false, detachNonOwner = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const ctl = { push, pushCalls: [], logouts: 0 };
  await installRoutes(context, ctl);
  await context.addInitScript((cfg) => {
    if (!sessionStorage.getItem("__seeded")) {
      sessionStorage.setItem("__seeded", "1");
      localStorage.setItem("__fakeSubActive", cfg.subscribed ? "1" : "0");
      localStorage.setItem("__pushMode", JSON.stringify({ unsubscribe: cfg.unsubscribe, registration: cfg.registration }));
      if (cfg.session) localStorage.setItem(cfg.storageKey, JSON.stringify(cfg.session));
      if (cfg.pending) localStorage.setItem(cfg.pendingKey, "1");
    }
    const mode = () => JSON.parse(localStorage.getItem("__pushMode") || "{}");
    window.__push = { events: [], enable: 0 };
    const subscription = {
      endpoint: cfg.endpoint,
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "test", auth: "test" } }; },
      unsubscribe() {
        window.__push.events.push("browser-unsubscribe");
        if (mode().unsubscribe === "hang") return new Promise(() => {});
        if (mode().unsubscribe === "reject") return Promise.reject(new Error("offline"));
        localStorage.setItem("__fakeSubActive", "0");
        return Promise.resolve(true);
      }
    };
    const registration = {
      scope: `${location.origin}/`,
      pushManager: {
        getSubscription: () => Promise.resolve(localStorage.getItem("__fakeSubActive") === "1" ? subscription : null),
        subscribe: () => { localStorage.setItem("__fakeSubActive", "1"); return Promise.resolve(subscription); }
      },
      showNotification: () => Promise.resolve(),
      unregister: () => Promise.resolve(true)
    };
    const container = {
      getRegistration: () => (mode().registration === "hang" ? new Promise(() => {}) : Promise.resolve(registration)),
      getRegistrations: () => Promise.resolve([registration]),
      register: () => Promise.resolve(registration),
      ready: Promise.resolve(registration),
      addEventListener() {},
      controller: null
    };
    Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => container, configurable: true });
    class FakeNotification {
      static get permission() { return cfg.permission; }
      static requestPermission() { return Promise.resolve(cfg.permission); }
    }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true, writable: true });
    // تسلسل واحد مرتّب: نداءات web-push وخروج Supabase وإلغاء المتصفح.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = String(input?.url || input);
      if (url.includes("/functions/v1/web-push")) {
        let action = "";
        try { action = JSON.parse(init?.body || "{}").action; } catch {}
        window.__push.events.push(`server-${action}`);
      }
      if (url.includes("/auth/v1/logout")) window.__push.events.push("signout");
      return nativeFetch(input, init);
    };
    window.__setDetachNonOwner = cfg.detachNonOwner;
  }, {
    session: session ? fakeSession(session) : null, storageKey: STORAGE_KEY, pendingKey: PENDING_KEY,
    subscribed, permission, unsubscribe, registration, pending, detachNonOwner, endpoint: ENDPOINT
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
  // appConfig يُكتب في config.js؛ الإعداد يُضبط فور تحميله وقبل الإقلاع.
  await page.addInitScript(() => {
    let value;
    Object.defineProperty(window, "appConfig", {
      configurable: true,
      get: () => value,
      set: (next) => {
        value = next;
        if (value) value.webPush = { ...value.webPush, detachNonOwnerSessions: window.__setDetachNonOwner === true };
      }
    });
  });
  await page.goto(`${BASE}/index.html`);
  return { context, page, ctl, pageErrors };
}

const waitBooted = (page) => page.waitForFunction(() => typeof state !== "undefined" && state.loading === false, null, { timeout: 30000 });
const settle = (page) => page.waitForTimeout(400);
const events = (page) => page.evaluate(() => window.__push.events.slice());
const subActive = (page) => page.evaluate(() => localStorage.getItem("__fakeSubActive") === "1");
const pendingFlag = (page) => page.evaluate((key) => localStorage.getItem(key), PENDING_KEY);
const reenableBanner = (page) => page.locator("[data-owner-push-missing]").count();

async function logoutAndTime(page) {
  const started = Date.now();
  await page.evaluate(() => logout());
  return Date.now() - started;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  let opened = null;
  try {
    await fn((options) => openApp(options).then((value) => (opened = value)));
    if (opened?.pageErrors.length) throw new Error(`أخطاء صفحة: ${opened.pageErrors.join(" | ")}`);
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
async function assertLoggedOut(page) {
  assert(await page.evaluate(() => state.session === null), "الجلسة لم تُمسح: فشل الفصل منع الخروج");
  assert((await page.locator(".message-panel").innerText()).includes("تم تسجيل الخروج"), "لا رسالة «تم تسجيل الخروج»");
}

console.log("check-web-push-session-detach: فصل اشتراك Push عند الخروج وتبديل الحساب");

await test("خروج المالك: إلغاء المتصفح وصف هذا الجهاز في الخادم قبل signOut", async (open) => {
  const { page, ctl } = await open();
  await waitBooted(page);
  await settle(page);
  assert(await subActive(page), "الاشتراك أُلغي عند الإقلاع بجلسة المالك");
  await logoutAndTime(page);
  const seq = await events(page);
  const signout = seq.indexOf("signout");
  assert(signout > -1, `لا signOut: ${seq}`);
  assert(seq.indexOf("browser-unsubscribe") > -1 && seq.indexOf("browser-unsubscribe") < signout, `إلغاء المتصفح ليس قبل signOut: ${seq}`);
  assert(seq.indexOf("server-unsubscribe") > -1 && seq.indexOf("server-unsubscribe") < signout, `نداء الخادم ليس قبل signOut: ${seq}`);
  const calls = ctl.pushCalls.filter((call) => call.action === "unsubscribe");
  assert(calls.length === 1 && calls[0].endpoint === ENDPOINT, `الخادم لم يُطلب منه إلا endpoint هذا الجهاز: ${JSON.stringify(calls)}`);
  assert(!(await subActive(page)), "اشتراك المتصفح باقٍ بعد الخروج");
  assert((await pendingFlag(page)) === null, "علامة الفصل المعلّق بقيت بعد فصل ناجح");
  await assertLoggedOut(page);
});

await test("فشل الخادم (500): إلغاء المتصفح يكفي والخروج يكتمل", async (open) => {
  const { page } = await open({ push: "500" });
  await waitBooted(page);
  await logoutAndTime(page);
  assert(!(await subActive(page)), "اشتراك المتصفح باقٍ رغم أن إلغاءه لا يحتاج الخادم");
  assert((await pendingFlag(page)) === null, "علامة الفصل المعلّق بقيت وإلغاء المتصفح نجح");
  await assertLoggedOut(page);
});

await test("انقطاع الشبكة عن الدالة: إلغاء المتصفح والخروج يكتملان", async (open) => {
  const { page } = await open({ push: "down" });
  await waitBooted(page);
  await logoutAndTime(page);
  assert(!(await subActive(page)), "اشتراك المتصفح باقٍ بعد انقطاع الشبكة");
  await assertLoggedOut(page);
});

await test("إلغاء المتصفح يعلق: الخروج يكتمل بالمهلة، ويُستكمل الفصل عند الفتح التالي", async (open) => {
  const { page } = await open({ unsubscribe: "hang" });
  await waitBooted(page);
  const elapsed = await logoutAndTime(page);
  assert(elapsed < DETACH_TIMEOUT_MS + 1500, `الخروج استغرق ${elapsed}ms فوق المهلة`);
  await assertLoggedOut(page);
  assert((await pendingFlag(page)) === "1", "لا علامة فصل معلّق بعد إلغاء لم يكتمل");
  assert(await subActive(page), "تجهيز الاختبار: الاشتراك يجب أن يبقى بعد التعليق");
  // الفتح التالي بلا جلسة والمتصفح متاح الآن: يُستكمل الفصل دون نداء للخادم.
  await page.evaluate(() => localStorage.setItem("__pushMode", JSON.stringify({ unsubscribe: "ok", registration: "ok" })));
  await page.reload();
  await waitBooted(page);
  await settle(page);
  assert(!(await subActive(page)), "الفصل المعلّق لم يُستكمل عند الفتح التالي");
  assert((await pendingFlag(page)) === null, "علامة الفصل المعلّق بقيت بعد استكماله");
});

await test("إلغاء المتصفح يُرفض (بلا شبكة): الخروج يكتمل والعلامة تبقى للاستكمال", async (open) => {
  const { page } = await open({ unsubscribe: "reject", push: "down" });
  await waitBooted(page);
  await logoutAndTime(page);
  await assertLoggedOut(page);
  assert((await pendingFlag(page)) === "1", "لا علامة فصل معلّق بعد رفض الإلغاء");
});

await test("getRegistration لا يُحسم: الخروج لا يعلق", async (open) => {
  const { page } = await open({ registration: "hang" });
  await waitBooted(page);
  const elapsed = await logoutAndTime(page);
  assert(elapsed < DETACH_TIMEOUT_MS + 1500, `الخروج استغرق ${elapsed}ms فوق المهلة`);
  await assertLoggedOut(page);
});

await test("لا اشتراك على الجهاز: خروج طبيعي بلا أي نداء Push", async (open) => {
  const { page, ctl } = await open({ subscribed: false });
  await waitBooted(page);
  await logoutAndTime(page);
  assert(ctl.pushCalls.length === 0, `نداء Push بلا اشتراك: ${JSON.stringify(ctl.pushCalls)}`);
  await assertLoggedOut(page);
});

await test("علامة فصل معلّق ثم دخول المالك: الاشتراك يُترك والعلامة تُمسح", async (open) => {
  const { page } = await open({ pending: true });
  await waitBooted(page);
  await settle(page);
  assert(await subActive(page), "أُلغي اشتراك المالك وجلسته حاضرة");
  assert((await pendingFlag(page)) === null, "العلامة بقيت مع جلسة المالك");
});

await test("المالك بإذن ممنوح بلا اشتراك: زر «إعادة التفعيل» ونقرته تستدعي enable مرة واحدة", async (open) => {
  const { page } = await open({ subscribed: false });
  await waitBooted(page);
  await page.waitForSelector("[data-owner-push-missing]", { timeout: 5000 });
  assert((await page.locator("[data-action='enable-notif']").count()) === 0, "ظهر زر «تفعيل» القديم مع الإذن الممنوح");
  await page.evaluate(() => {
    window.ozkWebPush.enable = async () => {
      window.__push.enable += 1;
      localStorage.setItem("__fakeSubActive", "1");
      return {};
    };
  });
  await page.evaluate(() => {
    const button = document.querySelector("[data-action='reenable-push']");
    button.click();
    button.click();
  });
  await page.waitForFunction(() => state.ownerPushMissing === false, null, { timeout: 5000 });
  assert((await page.evaluate(() => window.__push.enable)) === 1, "نقرتان أطلقتا enable مرتين");
  assert((await reenableBanner(page)) === 0, "بقي زر «إعادة التفعيل» بعد النجاح");
  assert((await page.locator(".message-panel").innerText()).includes("أُعيد تفعيل الإشعارات"), "لا رسالة نجاح");
});

await test("الخروج ثم دخول المالك مجدداً على الجهاز نفسه: يظهر زر «إعادة التفعيل»", async (open) => {
  const { page } = await open();
  await waitBooted(page);
  await settle(page);
  assert((await reenableBanner(page)) === 0, "الزر ظاهر والاشتراك قائم");
  await logoutAndTime(page);
  // دخول جديد بالجلسة نفسها (محاكاة signIn): الاشتراك أُلغي والإذن ما زال ممنوحاً.
  await page.evaluate((cfg) => localStorage.setItem(cfg.key, JSON.stringify(cfg.session)), { key: STORAGE_KEY, session: fakeSession("owner") });
  await page.reload();
  await waitBooted(page);
  await page.waitForSelector("[data-owner-push-missing]", { timeout: 5000 });
});

await test("الموظف بإذن ممنوح بلا اشتراك: لا زر «إعادة التفعيل»", async (open) => {
  const { page } = await open({ session: "employee", subscribed: false });
  await waitBooted(page);
  await settle(page);
  assert((await reenableBanner(page)) === 0, "زر إعادة تفعيل إشعارات المالك ظهر لموظف");
});

await test("استثناء OZKUSER (الافتراضي): جلسة موظف لا تلغي اشتراك المالك القائم", async (open) => {
  const { page, ctl } = await open({ session: "employee", detachNonOwner: false });
  await waitBooted(page);
  await settle(page);
  assert(await page.evaluate(() => appConfig.webPush.detachNonOwnerSessions === false), "الإعداد ليس مطفأً");
  assert(await subActive(page), "أُلغي اشتراك قائم رغم أن التنظيف التلقائي مطفأ");
  assert(ctl.pushCalls.length === 0, "نداء Push بجلسة الموظف");
});

await test("تنظيف حساب غير مالك (عند تفعيله بقرار المالك): المتصفح وحده، بلا نداء للخادم", async (open) => {
  const { page, ctl } = await open({ session: "employee", detachNonOwner: true });
  await waitBooted(page);
  await settle(page);
  assert(!(await subActive(page)), "اشتراك المالك بقي على جهاز بجلسة موظف رغم التفعيل");
  assert(ctl.pushCalls.length === 0, `جلسة الموظف نادت الخادم: ${JSON.stringify(ctl.pushCalls)}`);
});

await test("تنظيف حساب غير مالك مفعّل: جلسة المالك لا تتأثر", async (open) => {
  const { page } = await open({ session: "owner", detachNonOwner: true });
  await waitBooted(page);
  await settle(page);
  assert(await subActive(page), "أُلغي اشتراك المالك بجلسته");
});

await browser.close();
server.close();

console.log(`\nنجح ${passed} وفشل ${failures.length}`);
if (failures.length) {
  console.error(`check-web-push-session-detach: فشل ${failures.length}`);
  process.exit(1);
}
console.log("check-web-push-session-detach: OK");
