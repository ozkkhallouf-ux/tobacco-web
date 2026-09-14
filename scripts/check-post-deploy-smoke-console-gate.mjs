// ============================================================================
// حارس انحدار على بوابة `console.error` داخل `scripts/smoke-production.mjs`.
//
// الفجوة التي أُغلقت: الفحص كان يرصد `pageerror` (الاستثناءات غير الملتقَطة)
// و`response`/`requestfailed` من الأصل نفسه — ولا يرى وحدة التحكّم إطلاقاً.
// فصنفٌ كامل من الأعطال (مخالفة CSP، طلب يحجبه المتصفح قبل الشبكة، خطأ
// يلتقطه الكود ثم يسجّله) كان يمرّ «سليماً» على الإنتاج.
//
// الإثبات هنا **سلبي وإيجابي معاً**، وهو الشرط الوحيد لتصديق بوابة:
//   • موقع نظيف ⇒ الفحص يُقرّ البوابة (لا إنذار كاذب يدفع لتعطيلها لاحقاً).
//   • نفس الموقع + `console.error` واحد مصطنع ⇒ الفحص يسقط برمز غير صفري.
// بلا الشقّ السلبي تبقى البوابة ادّعاءً لا ضماناً.
//
// يُشغَّل الفحص الحقيقي كعملية مستقلة على موقع وهمي محلي — لا يلمس الإنتاج
// إطلاقاً (`SMOKE_BASE_URL` يُوجَّه إلى 127.0.0.1، و`EXPECTED_RELEASE` فارغ).
// ============================================================================
import { spawn } from "node:child_process";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

// موقع وهمي أدنى ما يُرضي كل فحوص الدخان: الهدف عزل بوابة وحدة التحكّم وحدها،
// فأي فشل آخر في المخرجات يعني أن الفحص انكسر لا أن البوابة عملت.
const ASSETS = Array.from({ length: 16 }, (_, i) => `/assets/mod-${i}.js`);
const PADDING = `<!-- ${"حشو لتجاوز حدّ الحجم الأدنى في فحص النشرات. ".repeat(60)} -->`;

const homeHtml = (poisoned) => `<!doctype html><html dir="rtl" lang="ar"><head>
<meta charset="utf-8"><link rel="icon" href="data:,"><title>OZK TOBACCO — موقع وهمي للفحص</title>
${ASSETS.map((a) => `<script src="${a}"></script>`).join("\n")}
</head><body><div id="app"><div class="app-shell">OZK TOBACCO</div></div>
<script>const state = { loading: false, route: "home" };</script>
${poisoned ? '<script>console.error("خطأ مصطنع من صفحة الاختبار");</script>' : ""}
</body></html>`;

const bulletinHtml = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><title>نشرة أسعار وهمية</title></head><body><table><tbody>
${Array.from({ length: 10 }, (_, i) => `<tr><td>صنف ${i}</td><td>${i * 100}</td></tr>`).join("")}
</tbody></table>${PADDING}</body></html>`;

function startFixture(poisoned) {
  const server = http.createServer((req, res) => {
    const path = String(req.url || "/").split("?")[0];
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(homeHtml(poisoned));
    }
    if (path.startsWith("/public/downloads/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(bulletinHtml);
    }
    if (path.endsWith(".js")) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      return res.end("/* وحدة فارغة */");
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runSmoke(base) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/smoke-production.mjs"], {
      // fileURLToPath لا .pathname: على ويندوز يعطي .pathname مساراً بشرطة
      // مائلة بادئة ("/C:/...") فيسقط spawn بخطأ ENOENT مضلِّل يشير إلى
      // الملف التنفيذي بدل مجلد العمل الفعلي.
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      // EXPECTED_RELEASE فارغ عمداً: مطابقة معرّف النشرة لا معنى لها على موقع وهمي.
      env: { ...process.env, SMOKE_BASE_URL: base, EXPECTED_RELEASE: "" },
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

const CONSOLE_CHECK = "لا خطأ في وحدة التحكّم أثناء تحميل التطبيق";
const lineFor = (out, name) => out.split("\n").find((l) => l.includes(name)) || "";

// ===== ١) الشقّ الإيجابي: لا إنذار كاذب =====
await test("موقع نظيف: بوابة وحدة التحكّم تمرّ ولا تُنذر كاذباً", async () => {
  const { server, base } = await startFixture(false);
  try {
    const { code, out } = await runSmoke(base);
    const line = lineFor(out, CONSOLE_CHECK);
    assert.ok(line, `فحص وحدة التحكّم غائب عن المخرجات أصلاً:\n${out}`);
    assert.ok(line.includes("✅"), `يجب أن يمرّ على موقع نظيف: ${line}`);
    assert.equal(code, 0, `موقع نظيف يجب ألا يُسقط الفحص:\n${out}`);
  } finally { server.close(); }
});

// ===== ٢) الشقّ السلبي: خطأ واحد مصطنع يُسقط الفحص =====
await test("console.error واحد مصطنع يُسقط فحص الدخان برمز غير صفري", async () => {
  const { server, base } = await startFixture(true);
  try {
    const { code, out } = await runSmoke(base);
    const line = lineFor(out, CONSOLE_CHECK);
    assert.ok(line.includes("❌"), `البوابة لم تلتقط الخطأ المصطنع: ${line || "(السطر غائب)"}`);
    assert.match(out, /خطأ مصطنع من صفحة الاختبار/, "يجب أن يُبلَّغ نص الخطأ لا أن يُبتلع");
    assert.equal(code, 1, `يجب الخروج برمز غير صفري:\n${out}`);
  } finally { server.close(); }
});

// ===== ٣) ضمانات PR #199 لم تُمَسّ =====
await test("ضمانات الفحص باقية: حجب SW، وصفر كتابة، واستثناء مشتقّ لا مكتوب", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../scripts/smoke-production.mjs", import.meta.url), "utf8"));
  assert.match(source, /serviceWorkers:\s*"block"/, "حجب الـService Worker إلزامي (ضمان PR #199)");
  assert.match(source, /blockedWrites\.push/, "ضمان صفر كتابة يجب أن يبقى");
  assert.match(source, /assetFailures\.length === 0/, "إخفاق أصل من الأصل نفسه يجب أن يبقى حاجباً");
  // الاستثناء الوحيد المسموح مشتقٌّ وقت التشغيل من إجهاض الفحص نفسه. أي قائمة
  // أنماط نصية هنا تكبر حتى تبتلع العطل الذي وُجدت البوابة لأجله.
  assert.match(source, /abortedByHarness/, "الاستثناء يجب أن يُشتقّ من إجهاض الفحص نفسه");
  assert.ok(!/ADVISORY|IGNORED_CONSOLE|ALLOWED_ERRORS/.test(source),
    "ممنوع إدخال قائمة استثناءات نصية إلى فحص الدخان");
});

console.log("حارس بوابة console.error في فحص ما بعد النشر:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل الفحوص نجحت.");
