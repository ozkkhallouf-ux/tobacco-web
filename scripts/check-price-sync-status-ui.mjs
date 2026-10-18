// شريط حالة مزامنة الأسعار داخل صفحة الأسعار الحقيقية (Playwright) — المرحلة الثانية.
//
// يفتح index.html كما هو بجلسة مالك اصطناعية، ويستبدل عميل Supabase بعميل مزيّف يعيد صفوف نبض
// اصطناعية، ثم يتحقق على الكمبيوتر (1280) والهاتف (390) وبالوضعين الفاتح والداكن من:
//   * ظهور الشريط أعلى صفحة الأسعار بالعربية (RTL) وبالحالة الصحيحة.
//   * التحديث في المكان: تغيّر البيانات يغيّر الشريط بلا render كامل (الجدول نفسه لا يُعاد بناؤه).
//   * فشل القراءة ⇒ UNKNOWN «تعذّر قراءة حالة المزامنة»، بلا console.error.
//   * لا فيض أفقي على الهاتف.
//   * لا أي طلب كتابة من الشريط.
// SCREENSHOT_DIR=… يحفظ لقطات للمراجعة البصرية (خارج المستودع).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8"
};
const server = createServer((req, res) => {
  const clean = decodeURIComponent(String(req.url || "/").split("?")[0]);
  let target = normalize(join(root, clean === "/" ? "/index.html" : clean));
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) target = join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(target)] || "application/octet-stream");
  createReadStream(target).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;
const SHOTS = process.env.SCREENSHOT_DIR || "";

let failed = 0;
const check = (name, condition, detail = "") => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); }
};

const SESSION = { id: "price-sync-ui-test", name: "حساب اختبار محلي", role: "المالك", email: "owner@example.invalid", accessRole: "owner" };

// صفوف نبض اصطناعية نسبةً إلى ساعة المتصفح.
function rowsScript(kind) {
  return `(() => {
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const attempt = (m, outcome, extra = {}) => ({ received_at: ago(m), kind: "attempt", outcome,
      last_success_at: ["applied","no_changes"].includes(outcome) ? ago(m) : null, last_ameen_contact_at: ago(m),
      summary: Object.assign({ schema: "price-sync-heartbeat/v1", kind: "attempt", host: "TEST", attempt_finished_at: ago(m), outcome,
        ameen_contact_at: outcome === "ameen_unreachable" ? null : ago(m), sent_count: 321, applied_wholesale: 321, applied_retail: 317,
        not_in_ameen: 0, conflict_count: 0, verify: { wholesale_matched: 321, retail_matched: 317, mismatches: 0, missing: 0 } }, extra) });
    const probe = (m) => ({ received_at: ago(m), kind: "task_probe", outcome: null, summary: { schema: "price-sync-heartbeat/v1", kind: "task_probe", host: "TEST", probed_at: ago(m), task: { exists: true, enabled: true, state: "Ready" } } });
    return ${JSON.stringify(kind)} === "healthy" ? [attempt(1, "applied"), attempt(6, "ameen_unreachable"), probe(2)]
         : ${JSON.stringify(kind)} === "stale" ? [attempt(40, "applied"), probe(2)]
         : [attempt(1, "ameen_unreachable"), attempt(6, "applied")];
  })()`;
}

async function installFakeClient(page, kind, { fail = false } = {}) {
  await page.evaluate(({ script, fail }) => {
    const rows = (0, eval)(script);
    window.__priceSyncWrites = [];
    const query = {
      select() { return query; }, order() { return query; },
      limit() { return Promise.resolve(fail ? { data: null, error: { message: "permission denied" } } : { data: rows, error: null }); },
      insert() { window.__priceSyncWrites.push("insert"); return query; }, update() { window.__priceSyncWrites.push("update"); return query; },
      upsert() { window.__priceSyncWrites.push("upsert"); return query; }, delete() { window.__priceSyncWrites.push("delete"); return query; }
    };
    window.ozkSupabaseClient = { auth: { getSession: async () => ({ data: { session: { user: { id: "t" } } } }) }, from: () => query, rpc() { window.__priceSyncWrites.push("rpc"); } };
  }, { script: rowsScript(kind), fail });
}

async function openPricing(page) {
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.ozkPriceSyncStatus && typeof window.ozkPriceSyncStatus.refresh === "function", null, { timeout: 20000 });
}

async function showPricing(page, theme) {
  await page.evaluate(({ session, theme }) => {
    const state = (0, eval)("state");
    state.session = session; window.__ozkSession = session;
    state.darkMode = theme === "dark";
    state.loading = false;
    state.route = "pricing";
    (0, eval)("render")();
  }, { session: SESSION, theme });
  await page.evaluate(() => window.ozkPriceSyncStatus.refresh());
  await page.waitForSelector("[data-price-sync-status]", { timeout: 10000 });
}

const bannerInfo = (page) => page.evaluate(() => {
  const el = document.querySelector("[data-price-sync-status]");
  const hub = document.querySelector(".newsletter-hub");
  return el ? {
    state: el.dataset.state, text: el.innerText, cls: el.className,
    first: hub && hub.firstElementChild === el,
    dir: getComputedStyle(el).direction,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    width: el.getBoundingClientRect().width
  } : null;
});

const browser = await chromium.launch();
for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "mobile", width: 390, height: 844, isMobile: true }]) {
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: Boolean(viewport.isMobile), hasTouch: Boolean(viewport.isMobile), serviceWorkers: "block", bypassCSP: true });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => { if (msg.type() === "error" && /price-sync|PriceSync/i.test(msg.text())) consoleErrors.push(msg.text()); });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));
    // لا شبكة خارجية: Supabase الحقيقي لا يُلمس.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
    await openPricing(page);
    const tag = `${viewport.name}/${theme}`;

    await installFakeClient(page, "healthy");
    await showPricing(page, theme);
    let info = await bannerInfo(page);
    check(`${tag}: HEALTHY أعلى صفحة الأسعار`, info && info.state === "HEALTHY" && info.first && /is-healthy/.test(info.cls), JSON.stringify(info));
    check(`${tag}: عربي RTL ونصوص الحقائق`, info && info.dir === "rtl" && /سليمة/.test(info.text) && /آخر نجاح مثبت/.test(info.text) && /آخر محاولة/.test(info.text) && /جملة 321/.test(info.text) && /آخر فشل/.test(info.text), info && info.text);
    check(`${tag}: لا فيض أفقي`, info && info.overflow <= 1, `overflow=${info && info.overflow}`);
    if (SHOTS) await page.locator("[data-price-sync-status]").screenshot({ path: `${SHOTS}/${viewport.name}-${theme}-healthy.png` });

    // تحديث في المكان: الجدول لا يُعاد بناؤه.
    await page.evaluate(() => { window.__tableMarker = document.querySelector("[data-pricing-results]"); });
    await installFakeClient(page, "stale");
    await page.evaluate(() => window.ozkPriceSyncStatus.refresh());
    info = await bannerInfo(page);
    const sameTable = await page.evaluate(() => window.__tableMarker === document.querySelector("[data-pricing-results]"));
    check(`${tag}: نجاح قديم ⇒ STALE، وتحديث في المكان بلا render كامل`, info && info.state === "STALE" && /is-stale/.test(info.cls) && sameTable, JSON.stringify({ info, sameTable }));
    if (SHOTS) await page.locator("[data-price-sync-status]").screenshot({ path: `${SHOTS}/${viewport.name}-${theme}-stale.png` });

    await installFakeClient(page, "failed");
    await page.evaluate(() => window.ozkPriceSyncStatus.refresh());
    info = await bannerInfo(page);
    check(`${tag}: فشل الاتصال ⇒ FAILED`, info && info.state === "FAILED" && /is-failed/.test(info.cls) && /تعذّر الاتصال بقاعدة الأمين/.test(info.text), info && info.text);
    if (SHOTS) await page.locator("[data-price-sync-status]").screenshot({ path: `${SHOTS}/${viewport.name}-${theme}-failed.png` });

    await installFakeClient(page, "healthy", { fail: true });
    await page.evaluate(() => window.ozkPriceSyncStatus.refresh());
    info = await bannerInfo(page);
    check(`${tag}: فشل القراءة ⇒ UNKNOWN لا نجاح وهمي`, info && info.state === "UNKNOWN" && /تعذّر قراءة حالة المزامنة/.test(info.text) && /is-unknown/.test(info.cls), info && info.text);
    if (SHOTS) await page.locator("[data-price-sync-status]").screenshot({ path: `${SHOTS}/${viewport.name}-${theme}-unknown.png` });

    // الشريط يبقى بعد render كامل (مثلاً بعد حفظ)، ولا يظهر في صفحة أخرى.
    await page.evaluate(() => (0, eval)("render")());
    check(`${tag}: الشريط يبقى بعد render كامل`, Boolean(await bannerInfo(page)));
    await page.evaluate(() => (0, eval)("setRoute")("overview"));
    check(`${tag}: لا شريط خارج صفحة الأسعار`, !(await page.$("[data-price-sync-status]")));

    const writes = await page.evaluate(() => window.__priceSyncWrites || []);
    check(`${tag}: لا أي كتابة`, writes.length === 0, writes.join(","));
    check(`${tag}: لا console.error ولا خطأ صفحة من الشريط`, consoleErrors.length === 0, consoleErrors.join(" | "));
    if (SHOTS && theme === "dark") {
      await page.evaluate(() => { const s = (0, eval)("state"); s.route = "pricing"; (0, eval)("render")(); });
      await page.screenshot({ path: `${SHOTS}/${viewport.name}-page.png` });
    }
    await ctx.close();
  }
}
await browser.close();
server.close();
if (failed) { console.error(`check-price-sync-status-ui: ${failed} فحص فاشل.`); process.exit(1); }
console.log("check-price-sync-status-ui: اجتاز الفحص.");
