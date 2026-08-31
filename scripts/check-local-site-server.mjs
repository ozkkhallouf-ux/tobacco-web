// فحص أمني سلوكي لخادم الموقع المحلي (`scripts/serve.mjs`).
//
// يشغّل الخادم فعلياً على منفذ عابر ويطلب منه ما يطلبه متصفح — ومهاجم.
// أُضيف بعد ملاحظة Codex P1 على PR #148: النسخة السابقة كانت تحوّل أي مسار
// URL إلى ملف تحت جذر المستودع، فتخدم `/.git/config` و`/tools/.env`
// و`/reports/...` رغم الربط على الاسترجاع — وصفحة إعادة ربط DNS تقرأها.
//
// المبدأ المفحوص: **allowlist لا denylist**. لا نكتفي بإثبات رفض أسماء بعينها،
// بل نثبت أن كل ما هو خارج الجذور العامة مرفوض بحكم البنية.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}
import assert from "node:assert/strict";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// نضمن وجود ملفات حساسة حقيقية أثناء الفحص كي لا ينجح الاختبار لمجرد غيابها.
const planted = [];
function plant(relative, content) {
  const full = path.join(repoRoot, relative);
  if (existsSync(full)) return;
  try {
    // في git worktree يكون `.git` ملفاً لا مجلداً — لا نزرع فوقه، والفحص
    // يبقى صالحاً لأن المسار موجود فعلاً ويجب أن يُرفض على أي حال.
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    planted.push(full);
  } catch { /* المسار موجود بشكل آخر — الرفض هو المطلوب وسيُفحص كما هو */ }
}
plant(".git/config", "[core]\n\trepositoryformatversion = 0\n");
plant("tools/.env", "SECRET=canary-must-never-be-served\n");
plant("reports/prices/canary.csv", "canary,must,not,leak\n");

process.env.HOST = "127.0.0.1";
process.env.PORT = "0";
const { server, resolvePublicPath, isHostAllowed, urlPathSegments } = await import("./serve.mjs");
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const PORT = server.address().port;

function request(urlPath, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: PORT, path: urlPath, method: "GET",
      headers: host === null ? {} : { Host: host || `127.0.0.1:${PORT}` }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ===== 1) أصول التطبيق العامة تعمل =====

await test("الأصول العامة المطلوبة لتشغيل الواجهة تُخدَم", async () => {
  const must = [
    "/", "/index.html", "/404.html",
    "/src/app.js", "/src/styles.css", "/src/icloud-archive.js", "/src/config.js",
    "/public/manifest.webmanifest", "/public/icons/ozk-logo.png",
    "/public/vendor/supabase.js", "/service-worker.js"
  ];
  for (const p of must) {
    const res = await request(p);
    assert.equal(res.status, 200, `${p} أعاد ${res.status}`);
    assert.ok(res.body.length > 0, `${p} فارغ`);
  }
});

await test("الصفحات العامة الأخرى تُخدَم", async () => {
  for (const p of ["/privacy-policy.html", "/terms-of-use.html", "/robots.txt", "/sitemap.xml"]) {
    assert.equal((await request(p)).status, 200, p);
  }
});

// ===== 2) المحتوى الحساس مرفوض =====

const MUST_REJECT = [
  "/.git/config", "/.git/HEAD", "/.env", "/.env.local", "/tools/.env",
  "/tools/.env.example", "/reports/prices/canary.csv", "/reports/",
  "/package.json", "/package-lock.json", "/CLAUDE.md", "/AGENTS.md",
  "/AI_HANDOFF.md", "/AI_WORK_SYNC.md",
  "/node_modules/playwright/package.json",
  "/scripts/serve.mjs", "/scripts/check.mjs",
  "/supabase/telegram-notifications.sql",
  "/tools/push-customer-invoices.ps1",
  "/tools/mac-archive-bridge/server.mjs",
  "/docs/ai/project-map.md", "/.github/workflows/pages.yml"
];

await test("كل مسار حساس مرفوض (لا 200 ولا تسريب محتوى)", async () => {
  for (const p of MUST_REJECT) {
    const res = await request(p);
    assert.notEqual(res.status, 200, `${p} خُدِم بـ200`);
    assert.ok(!res.body.includes("canary"), `${p} سرّب محتوى`);
    assert.ok(!res.body.includes("repositoryformatversion"), `${p} سرّب .git`);
  }
});

await test("الرفض لا يسقط إلى index.html (لا يُخفي الرفض)", async () => {
  const res = await request("/tools/.env");
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes("<html"), "أعاد صفحة بدل الرفض");
});

// ===== 3) traversal بكل صوره =====

await test("traversal و URL-encoded variants مرفوضة", async () => {
  const attacks = [
    "/../package.json", "/src/../package.json", "/src/../../etc/passwd",
    "/%2e%2e/package.json", "/%2e%2e%2fpackage.json",
    "/%252e%252e/package.json",
    "/..%2f..%2fetc/passwd",
    "/src/..%5cpackage.json",
    "/public/../tools/.env",
    "/./././tools/.env"
  ];
  for (const p of attacks) {
    const res = await request(p);
    assert.notEqual(res.status, 200, `${p} خُدِم`);
    assert.ok(!res.body.includes("canary") && !res.body.includes("\"scripts\""), `${p} سرّب`);
  }
});

await test("resolvePublicPath يرفض مباشرةً كل ما هو خارج الجذور العامة", () => {
  for (const p of ["/tools/.env", "/.git/config", "/package.json", "/scripts/serve.mjs", "/reports/x.csv"]) {
    assert.equal(resolvePublicPath(p), null, `${p} لم يُرفض`);
  }
  assert.ok(resolvePublicPath("/src/app.js"), "src/app.js يجب أن يُقبل");
  assert.ok(resolvePublicPath("/public/icons/ozk-logo.png"), "أصل عام يجب أن يُقبل");
  // امتداد غير مسموح داخل جذر عام يبقى مرفوضاً.
  assert.equal(resolvePublicPath("/src/anything.ps1"), null);
});

// ===== 3ب) دلالات ويندوز: التجزئة مستقلة عن نظام التشغيل =====

await test("تجزئة المسار لا تستعمل node:path فتتطابق على posix وwin32", async () => {
  // العطل الذي كان: `path.normalize("/src/app.js")` يعيد على ويندوز
  // `\\src\\app.js`، فيصير المسار كله مقطعاً واحداً ويُرفض — أي 404 لكل
  // `src/**` و`public/**` عند `npm run dev` على ويندوز، فتسقط واجهة ويندوز
  // والآيفون معاً. نثبت هنا التطابق دون الاعتماد على نظام المضيف.
  const pathMod = (await import("node:path")).default;
  const cases = [
    ["/src/app.js", ["src", "app.js"]],
    ["/src/styles.css", ["src", "styles.css"]],
    ["/public/icons/ozk-logo.png", ["public", "icons", "ozk-logo.png"]],
    ["/public/downloads/price-list-usd.pdf", ["public", "downloads", "price-list-usd.pdf"]],
    ["/index.html", ["index.html"]],
    ["/", ["index.html"]]
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(urlPathSegments(url), expected, `تجزئة ${url}`);
    // ونفس المقاطع تبني مساراً مكافئاً على كلا النظامين.
    const win = pathMod.win32.resolve("C:\\repo", ...expected).replace(/\\/g, "/").replace("C:/repo", "");
    const posix = pathMod.posix.resolve("/repo", ...expected).replace("/repo", "");
    assert.equal(win, posix, `اختلاف posix/win32 على ${url}`);
  }
});

await test("دلالات ويندوز: الرفض يبقى رفضاً على كلا النظامين", () => {
  // ما يجب رفضه يُرفض في طبقة URL نفسها — قبل أي لمس لنظام الملفات،
  // فالنتيجة واحدة على ويندوز وmacOS.
  for (const bad of ["/../package.json", "/src/../../etc/passwd", "/.git/config",
                     "/%2e%2e/package.json", "/%252e%252e/package.json",
                     "/src/..%5cpackage.json", "/public/../tools/.env"]) {
    assert.equal(urlPathSegments(bad), null, `${bad} لم يُرفض في طبقة URL`);
  }
  // والفاصل الخلفي يُوحَّد فلا يمرّ التفاف عبره.
  assert.deepEqual(urlPathSegments("/src\\app.js"), ["src", "app.js"]);
});

await test("serve.mjs لا يطبّق path.normalize على مسار الطلب", () => {
  const src = readFileSync(new URL("./serve.mjs", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.ok(!/normalize\(decoded\)/.test(src), "ما زال يطبّع مسار الطلب بـpath");
  assert.match(src, /export function urlPathSegments/, "التجزئة يجب أن تكون بدلالة URL");
});

// ===== 4) حارس ترويسة Host =====

await test("Host خارجي مرفوض (DNS rebinding)", async () => {
  for (const h of ["evil.example", "attacker.com:5173", "ozktobacco.com", "rebind.local.evil.example"]) {
    const res = await request("/index.html", { host: h });
    assert.equal(res.status, 403, `Host ${h} لم يُرفض (${res.status})`);
  }
});

await test("Host محلي صحيح يعمل", async () => {
  for (const h of [`127.0.0.1:${PORT}`, "127.0.0.1", `localhost:${PORT}`, "localhost"]) {
    assert.equal((await request("/index.html", { host: h })).status, 200, `Host ${h} رُفض`);
  }
});

await test("سلوك ويندوز/الآيفون محفوظ: IP الشبكة مقبول عند الربط على 0.0.0.0", () => {
  // الآيفون يتصل بـhttp://192.168.x.x:5173 — عنوان IP حرفي لا اسم نطاق.
  assert.equal(isHostAllowed("192.168.1.50:5173", "0.0.0.0"), true);
  assert.equal(isHostAllowed("10.0.0.7", "0.0.0.0"), true);
  assert.equal(isHostAllowed("ozk-pc.local:5173", "0.0.0.0"), true);
  // وأسماء النطاقات المسجّلة — أداة إعادة الربط — مرفوضة حتى على 0.0.0.0.
  assert.equal(isHostAllowed("evil.example", "0.0.0.0"), false);
  // وعلى الاسترجاع لا يُقبل إلا الاسترجاع.
  assert.equal(isHostAllowed("192.168.1.50", "127.0.0.1"), false);
  assert.equal(isHostAllowed("127.0.0.1:5173", "127.0.0.1"), true);
});

await test("Host مفقود مرفوض", async () => {
  assert.equal(isHostAllowed(undefined), false);
  assert.equal(isHostAllowed(""), false);
});

// ===== 5) الربط والمثبّت =====

await test("مرافق الماك يُثبَّت على الاسترجاع فقط", () => {
  const sh = readFileSync(new URL("../tools/mac-archive-bridge/install-launch-agent.sh", import.meta.url), "utf8");
  assert.match(sh, /<key>HOST<\/key>\s*\n\s*<string>127\.0\.0\.1<\/string>/,
    "مرافق الموقع المحلي يجب أن يُربط على 127.0.0.1");
  assert.ok(!/<string>0\.0\.0\.0<\/string>/.test(sh), "لا يجوز ربط 0.0.0.0 في مثبّت الماك");
});

await test("serve.mjs لا يحوي أي قائمة منع كأساس للحماية", () => {
  const src = readFileSync(new URL("./serve.mjs", import.meta.url), "utf8");
  assert.match(src, /const PUBLIC_DIRS = \[/, "الأساس يجب أن يكون جذوراً عامة");
  assert.match(src, /const PUBLIC_ROOT_FILES = new Set/, "ملفات الجذر يجب أن تكون قائمة صريحة");
  // لا سقوط إلى index.html عند مسار غير مسموح.
  assert.ok(!/join\(root, "index\.html"\)/.test(src), "بقي السقوط إلى index.html");
});

// ===== النتيجة =====

server.close();
for (const f of planted) { try { rmSync(f); } catch { /* تنظيف أفضل جهد */ } }

console.log("فحص أمان خادم الموقع المحلي:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص خادم الموقع المحلي نجحت.");
