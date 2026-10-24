// ============================================================================
// حارس واجهة أرشفة المستندات (قرار المالك 2026-10-24):
//   1. شارة iCloud وتنبيهاتها مخفية بالمفتاح documentArchive.icloudUi=false، والأرشفة
//      نفسها لم تتعطّل (الجسر ما يزال يُخاطَب) — إخفاء واجهة لا حذف ميزة.
//   2. شارة Google Drive: لا تظهر ولا تطلب شيئاً ما دام driveUi غير مفعَّل؛ «متصلة» فقط
//      بتقرير وتحقق حديثين؛ تقرير قديم = «العامل لا يردّ»؛ خطأ قراءة (غير المالك) = لا شارة؛
//      الروابط غير الخاصة لا تُعرض، والأسماء مُهرَّبة، وزر إعادة المحاولة يستدعي RPC المالك وحده.
// متصفح حقيقي وعميل Supabase وهمي بالذاكرة؛ لا شبكة ولا بيانات حقيقية.
// ============================================================================
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";

const ICLOUD = readFileSync(new URL("../src/icloud-archive.js", import.meta.url), "utf8");
const DRIVE = readFileSync(new URL("../src/drive-archive-status.js", import.meta.url), "utf8");
const BRIDGE_HOST = "127.0.0.1:8787";

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const fixture = (archiveCfg) => `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><title>حارس واجهة الأرشفة</title>
<script>window.appConfig = ${archiveCfg === undefined ? "{}" : JSON.stringify({ documentArchive: archiveCfg })};</script></head>
<body><script src="/src/icloud-archive.js"></script><script src="/src/drive-archive-status.js"></script></body></html>`;

let currentFixture = fixture(undefined);
const server = http.createServer((req, res) => {
  const path = String(req.url || "/").split("?")[0];
  const js = { "/src/icloud-archive.js": ICLOUD, "/src/drive-archive-status.js": DRIVE }[path];
  if (js) {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    return res.end(js);
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  return res.end(currentFixture);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

// عميل Supabase وهمي: يسجّل كل نداء، ويعيد ما يُزرع في window.__fake.
function installFakeClient(fake) {
  window.__calls = [];
  const builder = (table) => {
    const q = { table, filters: [] };
    const chain = {
      select() { return chain; }, order() { return chain; },
      eq(col, val) { q.filters.push([col, val]); return chain; },
      limit() {
        window.__calls.push({ kind: "from", ...q });
        if (fake.error) return Promise.resolve({ data: null, error: { message: "permission denied" } });
        return Promise.resolve({ data: fake[table] || [], error: null });
      },
    };
    return chain;
  };
  window.ozkSupabaseClient = {
    auth: { getSession: async () => ({ data: { session: fake.noSession ? null : { user: {} } } }) },
    from: builder,
    rpc: async (name, args) => { window.__calls.push({ kind: "rpc", name, args }); return { data: { ok: true }, error: null }; },
  };
  window.__bridgeCalls = [];
  const real = window.fetch;
  window.fetch = function (input) {
    const url = String(typeof input === "string" ? input : (input && input.url) || "");
    if (url.includes("127.0.0.1:8787")) window.__bridgeCalls.push(url);
    return real.apply(this, arguments);
  };
}

async function load(archiveCfg, fake = {}, act = null) {
  currentFixture = fixture(archiveCfg);
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(navigator, "userAgentData", { get: () => ({ platform: "macOS" }) });
  });
  await context.addInitScript(installFakeClient, fake);
  // اختبارات Drive معزولة عن جسر iCloud (إيقافه الصريح يمنع أي طلب له).
  if (archiveCfg && archiveCfg.driveUi === true) {
    await context.addInitScript(() => { try { localStorage.setItem("ozk.archive.enabled", "0"); } catch (e) { /* تجاهل */ } });
  }
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e && e.message}`));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); d.dismiss(); });
  await page.route(`http://${BRIDGE_HOST}/**`, (route) => route.abort());
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.ozkArchive && window.ozkDriveArchiveStatus), null, { timeout: 15000 });
  await page.waitForTimeout(2500);
  if (act) await act(page);
  const facts = await page.evaluate(() => ({
    icloudBadge: Boolean(document.querySelector("[data-ozk-archive-status]")),
    icloudToast: Boolean(document.querySelector("[data-ozk-archive-toast]")),
    bridgeCalls: window.__bridgeCalls.slice(),
    chip: (document.querySelector("[data-ozk-drive-archive-status]") || {}).textContent || null,
    panel: (document.querySelector("[data-ozk-drive-archive-panel]") || {}).innerHTML || null,
    calls: window.__calls.slice(),
    injected: window.__xss === true,
    archiveResult: window.__archiveResult || null,
  }));
  await context.close();
  return { errors, ...facts };
}

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const LINK = "https://drive.google.com/file/d/F000000000001xyz/view?usp=drivesdk";
const heartbeat = (over = {}) => ({
  host: "OZK2026", drive_state: "connected", drive_checked_at: iso(60_000), mode: "live",
  last_success_at: iso(120_000), pending_count: 1, failed_count: 1, reported_at: iso(60_000), ...over,
});
const ITEMS = [
  { job_id: "c".repeat(32), doc_number: "502", doc_date: "2026-10-24", customer_name: "زبون تجريبي", version: 1,
    status: "rendered", failed: true, drive_web_link: null, last_error: "upload:TRANSIENT", updated_at: iso(1000) },
  { job_id: "a".repeat(32), doc_number: "501", doc_date: "2026-10-24", customer_name: "<img src=x onerror=\"window.__xss=true\">",
    version: 2, status: "notified", failed: false, drive_web_link: LINK, last_error: null, updated_at: iso(2000) },
  { job_id: "b".repeat(32), doc_number: "500", doc_date: "2026-10-23", customer_name: "رابط عام", version: 1,
    status: "notified", failed: false, drive_web_link: "javascript:window.__xss=true", last_error: null, updated_at: iso(3000) },
];

// ── ١) iCloud ──
await test("iCloud بلا مفتاح: الشارة تظهر كما كانت (السلوك القائم لم يتغيّر)", async () => {
  const r = await load(undefined);
  assert.equal(r.icloudBadge, true, "الشارة اختفت بلا مفتاح");
  assert.ok(r.bridgeCalls.some((u) => u.endsWith("/health")));
});

await test("iCloud بـicloudUi=false: لا شارة ولا تنبيه، والجسر ما يزال يُخاطَب", async () => {
  const r = await load({ icloudUi: false, driveUi: false }, {}, (page) => page.evaluate(async () => {
    window.__archiveResult = await window.ozkArchive.archive({ docType: "invoice", pdfBlob: new Blob(["%PDF"]), meta: {} });
  }));
  assert.equal(r.icloudBadge, false, "الشارة ظاهرة رغم الإخفاء");
  assert.equal(r.icloudToast, false, "تنبيه iCloud ظاهر رغم الإخفاء");
  assert.ok(r.bridgeCalls.some((u) => u.endsWith("/health")), "الإخفاء عطّل الأرشفة نفسها");
  assert.equal(r.archiveResult && r.archiveResult.ok, false, "مسار الفشل (الذي يُطلق التنبيه) لم يُختبر");
  // الجسر مُجهَض عمداً فخطأ الشبكة متوقع؛ المرفوض استثناء برمجي.
  assert.deepEqual(r.errors.filter((e) => !/net::ERR_FAILED/.test(e)), []);
});

// ── ٢) Drive ──
await test("Drive بـdriveUi=false: لا شارة ولا أي قراءة من Supabase", async () => {
  const r = await load({ icloudUi: false, driveUi: false }, { document_archive_heartbeat: [heartbeat()] });
  assert.equal(r.chip, null);
  assert.deepEqual(r.calls, []);
});

await test("Drive: تقرير وتحقق حديثان = «متصلة» مع العدّادات", async () => {
  const r = await load({ icloudUi: false, driveUi: true }, { document_archive_heartbeat: [heartbeat()], document_archive_items: ITEMS });
  assert.match(r.chip || "", /أرشفة Google Drive: متصلة · معلّقة 1 · فاشلة 1/);
  assert.deepEqual(r.errors, []);
});

await test("Drive: تقرير قديم = «العامل لا يردّ» لا أخضر، وتحقق Drive قديم = «غير متصلة»", async () => {
  const stale = await load({ driveUi: true }, { document_archive_heartbeat: [heartbeat({ reported_at: iso(16 * 60_000) })] });
  assert.match(stale.chip || "", /العامل لا يردّ/);
  const unchecked = await load({ driveUi: true }, { document_archive_heartbeat: [heartbeat({ drive_checked_at: iso(16 * 60_000) })] });
  assert.match(unchecked.chip || "", /غير متصلة/);
  const reauth = await load({ driveUi: true }, { document_archive_heartbeat: [heartbeat({ drive_state: "needs_reauth" })] });
  assert.match(reauth.chip || "", /تحتاج إعادة مصادقة/);
});

await test("Drive: غير المالك (RLS بلا صفوف أو خطأ) وبلا جلسة = لا شارة", async () => {
  assert.equal((await load({ driveUi: true }, { document_archive_heartbeat: [] })).chip, null);
  assert.equal((await load({ driveUi: true }, { error: true })).chip, null);
  const noSession = await load({ driveUi: true }, { noSession: true, document_archive_heartbeat: [heartbeat()] });
  assert.equal(noSession.chip, null);
  assert.deepEqual(noSession.calls, [], "بلا جلسة لا قراءة");
});

await test("Drive: اللوحة تهرّب الأسماء، وتعرض رابط العرض الخاص وحده، وإعادة المحاولة RPC للمهمة الفاشلة", async () => {
  const r = await load({ driveUi: true }, { document_archive_heartbeat: [heartbeat()], document_archive_items: ITEMS }, async (page) => {
    await page.click("[data-ozk-drive-archive-status]");
    await page.click(`[data-retry="${"c".repeat(32)}"]`);
    await page.waitForTimeout(300);
  });
  assert.equal(r.injected, false, "حقن HTML من اسم الزبون");
  assert.ok(r.panel.includes(`href="${LINK.replace(/&/g, "&amp;")}"`), "رابط Drive الخاص غائب");
  assert.ok(!/href="javascript:/i.test(r.panel), "رابط غير خاص معروض");
  assert.ok(r.panel.includes("(نسخة 2)"));
  const rpc = r.calls.filter((c) => c.kind === "rpc");
  assert.deepEqual(rpc, [{ kind: "rpc", name: "request_document_archive_retry", args: { p_job_id: "c".repeat(32) } }]);
  assert.match(r.panel, /طُلبت إعادة المحاولة/);
  assert.deepEqual(r.errors, []);
});

await test("Drive: البحث برقم الفاتورة يقرأ بالرقم وحده ويرفض غير الأرقام", async () => {
  const r = await load({ driveUi: true }, { document_archive_heartbeat: [heartbeat()], document_archive_items: ITEMS }, async (page) => {
    await page.click("[data-ozk-drive-archive-status]");
    await page.fill("[data-ozk-drive-archive-panel] input[name=n]", "x' or 1=1");
    await page.click("[data-ozk-drive-archive-panel] [data-search] button");
    await page.fill("[data-ozk-drive-archive-panel] input[name=n]", "501");
    await page.click("[data-ozk-drive-archive-panel] [data-search] button");
    await page.waitForTimeout(300);
  });
  const searches = r.calls.filter((c) => c.kind === "from" && c.filters.length);
  assert.deepEqual(searches.map((c) => c.filters), [[["doc_number", "501"]]]);
});

await browser.close();
server.close();

console.log("حارس واجهة أرشفة المستندات (iCloud مخفية، Drive للمالك):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل الفحوص نجحت.");
