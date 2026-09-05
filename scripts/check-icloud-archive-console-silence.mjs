// ============================================================================
// حارس انحدار: عميل أرشفة iCloud لا يُلوّث وحدة تحكّم الإنتاج — ولا يتعطّل.
//
// العطل الذي وُجد هذا الحارس لأجله (قياس فعلي على https://ozktobacco.com،
// 2026-09-06، Chromium): كل تحميل للصفحة على الماك كان يُخرج خطأين:
//     Access to fetch at 'http://127.0.0.1:8787/health' from origin
//     'https://ozktobacco.com' has been blocked by CORS policy: Permission was
//     denied for this request to access the `loopback` address space.
//     Failed to load resource: net::ERR_FAILED
// كروم يحجب مخاطبة مجال العناوين المحلي من أصل عام (Private Network Access)
// ما لم يُمنح إذن صريح. الحجب إعداد ثابت لا عطل عابر، فتكرار المحاولة عند كل
// إقلاع وكل تصدير ضجيج يغرق الأخطاء الحقيقية — وهو ما كان يمنع الاعتماد على
// وحدة التحكّم كإشارة صحة أصلاً.
//
// **الخطر المقابل، وهو ما تحرسه أكثر الحالات هنا:** أن يُسكَت الضجيج بتعطيل
// الميزة. فثلاث من أربع حالات تُثبت أن الجسر ما يزال يُخاطَب حيث يجب. حارسٌ
// يمرّ بميزة معطّلة أسوأ من الضجيج نفسه.
//
// لا مطابقة نصية للكود: الملف يُحمَّل في متصفح حقيقي وتُقاس نداءات fetch
// الفعلية من داخل الصفحة.
// ============================================================================
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import http from "node:http";
import assert from "node:assert/strict";

const CLIENT = readFileSync(new URL("../src/icloud-archive.js", import.meta.url), "utf8");
const BRIDGE_HOST = "127.0.0.1:8787";
const PUBLIC_ORIGIN = "https://ozktobacco.test";

// صفحة الحدّ الأدنى: العميل وحده. عزلٌ مقصود — نظافة وحدة تحكّم التطبيق كاملاً
// تحرسها `check-critical-journeys.mjs` محلياً و`smoke-production.mjs` على الحيّ.
// أيقونة `data:` تمنع طلب /favicon.ico ومعه خطأ 404 لا علاقة له بالمقيس.
const FIXTURE = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><title>حارس صمت أرشفة iCloud</title></head>
<body><script src="/src/icloud-archive.js"></script></body></html>`;

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

// خادم محلي حقيقي: الحالة «أصل محلي» تحتاج أصلاً محلياً فعلياً لا محاكاة.
const server = http.createServer((req, res) => {
  const path = String(req.url || "/").split("?")[0];
  if (path === "/src/icloud-archive.js") {
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    return res.end(CLIENT);
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  return res.end(FIXTURE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const LOCAL_ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

async function load({ origin, storage = [] }) {
  const context = await browser.newContext({ serviceWorkers: "block" });

  // هوية ماك مفروضة صراحةً: الميزة محصورة بالماك في الكود، فبلا هذا يمرّ
  // الحارس على لينكس (CI) بلا أن يختبر شيئاً. تُؤكَّد أدناه بـ`supported`.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(navigator, "userAgentData", { get: () => ({ platform: "macOS" }) });
  });
  await context.addInitScript((entries) => {
    for (const [key, value] of entries) { try { localStorage.setItem(key, value); } catch (e) { /* تجاهل */ } }
  }, storage);
  // القياس من **داخل** الصفحة لا من طبقة الشبكة: اعتراض Playwright قد يقع بعد
  // حجب المتصفح للطلب، فيبدو أن محاولةً لم تقع وهي وقعت. تغليف fetch يقيس
  // النية الفعلية للكود مهما فعلت سياسات المتصفح.
  await context.addInitScript((host) => {
    window.__bridgeCalls = [];
    const real = window.fetch;
    window.fetch = function (input) {
      const url = String(typeof input === "string" ? input : (input && input.url) || "");
      if (url.includes(host)) window.__bridgeCalls.push(url);
      return real.apply(this, arguments);
    };
  }, BRIDGE_HOST);

  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error && error.message}`));

  // إجهاض حتمي للجسر: يجعل الفشل مطابقاً للإنتاج بصرف النظر عن كون المنفذ
  // 8787 مشغولاً على جهاز المطوّر أم لا.
  await page.route(`http://${BRIDGE_HOST}/**`, (route) => route.abort());
  if (origin === PUBLIC_ORIGIN) {
    await page.route(`${PUBLIC_ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      return path === "/src/icloud-archive.js"
        ? route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: CLIENT })
        : route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FIXTURE });
    });
  }

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.ozkArchive), null, { timeout: 15000 });
  await page.waitForTimeout(2500); // مهلة الفحص 1500ms — نتجاوزها كي تستقرّ النتيجة

  const facts = await page.evaluate(() => ({
    supported: window.ozkArchive.isSupportedPlatform(),
    // قراءة متسامحة عمداً: لو غابت الدالة لوجب أن تُفشِل الحارسَ **الحقائقُ
    // السلوكية** (نداءات الجسر وأخطاء وحدة التحكّم) لا استثناءُ برمجة. حارسٌ
    // يسقط على شكل الواجهة لا يُثبت شيئاً عن السلوك.
    mayReach: typeof window.ozkArchive.mayReachBridge === "function"
      ? window.ozkArchive.mayReachBridge() : null,
    origin: window.location.origin,
    bridgeCalls: window.__bridgeCalls.slice(),
    badge: (document.querySelector("[data-ozk-archive-status]") || {}).textContent || "",
  }));
  await context.close();
  return { consoleErrors, ...facts };
}

// ===== ١) العطل نفسه: أصل عام بلا تفعيل =====
await test("أصل عام: لا طلب إلى الجسر ولا خطأ واحد في وحدة التحكّم", async () => {
  const r = await load({ origin: PUBLIC_ORIGIN });
  assert.equal(r.supported, true, "الحارس لم يختبر مسار الماك أصلاً — هوية الماك لم تُفرض");
  assert.deepEqual(r.bridgeCalls, [], "لا يجوز أي نداء للجسر من أصل عام: " + r.bridgeCalls.join(","));
  assert.deepEqual(r.consoleErrors, [], "وحدة التحكّم يجب أن تكون نظيفة: " + r.consoleErrors.join(" | "));
  assert.equal(r.mayReach, false, "البوابة يجب أن تكون مغلقة على أصل عام بلا تفعيل");
});

await test("أصل عام: الشارة تقول «غير مفعّلة» لا «غير متصلة»", async () => {
  // الخلط بين الحالتين يرسل المالك خلف عطل في جسرٍ يعمل: لم نحاول أصلاً.
  const r = await load({ origin: PUBLIC_ORIGIN });
  assert.match(r.badge, /غير مفعّلة/, "نص الشارة: " + r.badge);
});

// ===== ٢) الحارس المقابل: الميزة لم تُعطَّل =====
await test("أصل محلي (مرافق الماك): الجسر يُخاطَب كما كان تماماً", async () => {
  const r = await load({ origin: LOCAL_ORIGIN });
  assert.equal(r.supported, true);
  assert.ok(r.bridgeCalls.some((u) => u.endsWith("/health")),
    "المسار المعتمد على الماك انكسر: لا نداء /health — " + r.bridgeCalls.join(","));
  assert.equal(r.mayReach, true, "الأصل المحلي هو المسار المعتمد — يجب ألا تُغلق بوابته");
});

await test("أصل عام + تفعيل صريح: الجسر يُخاطَب (مخرج المالك يعمل)", async () => {
  const r = await load({ origin: PUBLIC_ORIGIN, storage: [["ozk.archive.enabled", "1"]] });
  assert.ok(r.bridgeCalls.some((u) => u.endsWith("/health")),
    "ozkArchive.enable() لا يفتح البوابة — " + r.bridgeCalls.join(","));
  assert.equal(r.mayReach, true);
});

await test("أصل عام + رمز ربط محفوظ: الجسر يُخاطَب (إعداد قائم لا ينكسر)", async () => {
  const r = await load({ origin: PUBLIC_ORIGIN, storage: [["ozk.archive.token", "T".repeat(64)]] });
  assert.ok(r.bridgeCalls.some((u) => u.endsWith("/health")),
    "متصفّح كان يعمل عليه الجسر فُقد — " + r.bridgeCalls.join(","));
  assert.equal(r.mayReach, true, "ربط ناجح سابق دليل إيجابي كافٍ");
});

await test("إيقاف صريح يبقى إيقافاً على كل أصل", async () => {
  const r = await load({ origin: LOCAL_ORIGIN, storage: [["ozk.archive.enabled", "0"]] });
  assert.deepEqual(r.bridgeCalls, [], "الإيقاف يجب أن يمنع كل طلب حتى محلياً");
});

await browser.close();
server.close();

console.log("حارس صمت وحدة التحكّم لعميل أرشفة iCloud:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل الفحوص نجحت.");
