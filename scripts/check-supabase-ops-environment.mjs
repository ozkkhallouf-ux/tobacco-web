// ============================================================================
// check-supabase-ops-environment.mjs — حماية مفتاح خدمة Supabase في GitHub Actions
//
// يثبت بلا شبكة ولا أسرار حقيقية:
//   1. كل job يقرأ secrets.SUPABASE_SERVICE_ROLE_KEY خلف بيئة supabase-ops وشرط main،
//      وفي الـworkflows الثلاثة المعروفة وحدها.
//   2. لا زناد يشغّل كوداً غير موثوق بجانب السرّ: لا pull_request/pull_request_target/push.
//   3. الجدولة والزنادات الحالية باقية كما هي (التشغيل الآلي لا ينتظر موافقة بشرية).
//   4. صلاحيات GITHUB_TOKEN في حدها الأدنى، ولا قيمة سرّ داخل run: ولا طباعة لها.
//   5. لا سرّ جديد في أي workflow دون إضافته لقائمة الجرد هنا عمداً.
//   6. لا مفتاح حقيقي (sb_secret_ أو JWT) محفوظ في ملفات المستودع.
//   7. الترويسات تعمل مع المفتاح القديم (JWT) والجديد (sb_secret_) دون فجوة عند النقل.
// ============================================================================
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabaseServiceHeaders } from "./supabase-service-headers.mjs";
import { callLifecycle } from "./health-check.mjs";
import { run as runStockAlerts } from "./stock-priority-alerts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wfDir = path.join(root, ".github", "workflows");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

const ENV_NAME = "supabase-ops";
const MAIN_GUARD = "github.ref == 'refs/heads/main'";
const PROTECTED = {
  "health-check.yml": { job: "health-check", permissions: ["contents: read", "actions: read", "issues: write"] },
  "stock-priority-alerts.yml": { job: "stock-priority-alerts", permissions: ["contents: read"] },
  "alert-on-automation-failure.yml": { job: "notify", permissions: ["contents: read"] },
};
// جرد الأسرار المخزَّنة المسموح بها لكل workflow (GITHUB_TOKEN ليس سراً مخزَّناً فلا يُعدّ).
// سرّ جديد في أي ملف يُفشل الفحص حتى يُراجَع ويُضاف هنا.
const SECRET_INVENTORY = {
  "health-check.yml": ["SUPABASE_SERVICE_ROLE_KEY"],
  "stock-priority-alerts.yml": ["SUPABASE_SERVICE_ROLE_KEY"],
  "alert-on-automation-failure.yml": ["SUPABASE_SERVICE_ROLE_KEY"],
  "pages.yml": ["ROLLBAR_POST_CLIENT_ITEM_TOKEN"],
  "windows-release.yml": ["RELEASE_APP_ID", "RELEASE_APP_PRIVATE_KEY"],
};

const stripComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

// تقسيم jobs بالمسافة البادئة (لا محلّل YAML في المستودع): job = سطر «  name:» تحت jobs:.
function jobsOf(yml) {
  const lines = stripComments(yml).split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, "workflow بلا jobs:");
  const jobs = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { current = m[1]; jobs[current] = []; continue; }
    if (/^\S/.test(line)) break;
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join("\n")]));
}

function topBlock(yml, key) {
  const lines = stripComments(yml).split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return null;
  const out = [lines[i]];
  for (const l of lines.slice(i + 1)) { if (/^\S/.test(l)) break; out.push(l); }
  return out.join("\n");
}

const workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));

// --- 1) السرّ خلف البيئة وشرط main، وفي الملفات المعروفة وحدها ----------------------
for (const file of workflows) {
  const yml = readFileSync(path.join(wfDir, file), "utf8");
  const code = stripComments(yml);
  if (!/secrets\.SUPABASE_SERVICE_ROLE_KEY/.test(code)) continue;
  assert.ok(PROTECTED[file], `${file} يقرأ SUPABASE_SERVICE_ROLE_KEY خارج الـworkflows المحمية — اربطه ببيئة ${ENV_NAME} وأضفه للفحص`);
  for (const [job, body] of Object.entries(jobsOf(yml))) {
    if (!/secrets\.SUPABASE_SERVICE_ROLE_KEY/.test(body)) continue;
    assert.match(body, new RegExp(`^ {4}environment: ${ENV_NAME}\\s*$`, "m"), `${file}/${job}: يجب environment: ${ENV_NAME}`);
    assert.ok(body.includes(MAIN_GUARD), `${file}/${job}: يجب شرط ${MAIN_GUARD}`);
    assert.doesNotMatch(body, /deployment:\s*false/, `${file}/${job}: لا deployment: false قبل إثبات أن سياسة فروع البيئة تبقى مطبَّقة معه`);
  }
}
for (const [file, { job }] of Object.entries(PROTECTED)) {
  const body = jobsOf(read(`.github/workflows/${file}`))[job];
  assert.ok(body, `${file}: الـjob ${job} مفقود`);
  assert.match(body, /secrets\.SUPABASE_SERVICE_ROLE_KEY/, `${file}/${job}: يتوقع الفحص أن هذا الـjob يقرأ المفتاح`);
}
ok("كل job يقرأ مفتاح الخدمة خلف بيئة supabase-ops وشرط main، في 3 workflows معروفة فقط");

// --- 2) لا زناد يجلب كوداً غير موثوق ---------------------------------------------
for (const file of Object.keys(PROTECTED)) {
  const on = topBlock(read(`.github/workflows/${file}`), "on");
  assert.ok(on, `${file}: بلا on:`);
  assert.doesNotMatch(on, /^\s{2}(pull_request|pull_request_target|push|issue_comment|repository_dispatch)\s*:/m, `${file}: زناد يشغّل كوداً من فرع/PR غير موثوق`);
}
ok("لا pull_request ولا pull_request_target ولا push في الـworkflows الحاملة للمفتاح");

// --- 3) الزنادات الحالية باقية ------------------------------------------------------
const hc = topBlock(read(".github/workflows/health-check.yml"), "on");
assert.match(hc, /cron: '\*\/30 \* \* \* \*'/, "health-check: جدولة كل 30 دقيقة يجب أن تبقى");
assert.match(hc, /workflow_dispatch/, "health-check: التشغيل اليدوي يبقى");
assert.match(topBlock(read(".github/workflows/stock-priority-alerts.yml"), "on"), /workflow_dispatch/, "stock-priority-alerts: يدوي احتياطي يبقى");
const alertOn = topBlock(read(".github/workflows/alert-on-automation-failure.yml"), "on");
for (const wf of ["Deploy TOBACCO Web", "توليد نشرات الأسعار", "فحص المشروع", "فحص صحة المشروع", "دخان ما بعد النشر", "تنبيهات النفاد حسب أولوية المبيعات"]) {
  assert.ok(alertOn.includes(`"${wf}"`), `alert-on-automation-failure: يجب أن يبقى مراقباً «${wf}»`);
}
assert.match(alertOn, /types: \[completed\]/);
ok("الجدولة والزنادات والمراقَبات كما كانت");

// --- 4) أقل صلاحيات، ولا سرّ داخل run ولا طباعة له ----------------------------------
for (const [file, { permissions }] of Object.entries(PROTECTED)) {
  const yml = read(`.github/workflows/${file}`);
  const perms = topBlock(yml, "permissions");
  assert.ok(perms, `${file}: permissions صريحة مطلوبة`);
  const granted = perms.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(granted.sort(), [...permissions].sort(), `${file}: صلاحيات GITHUB_TOKEN تغيّرت`);
  assert.doesNotMatch(stripComments(yml), /write-all|read-all/, `${file}: لا صلاحيات شاملة`);
  const code = stripComments(yml);
  for (const block of code.split(/\n\s+run: \|?/).slice(1)) {
    const body = block.split(/\n\s{4,6}- (name|uses):/)[0];
    assert.doesNotMatch(body, /\$\{\{\s*secrets\./, `${file}: قيمة سرّ داخل run: — مرّرها عبر env`);
    assert.doesNotMatch(body, /(echo|printf|cat)\b[^\n]*\$\{?SUPABASE_SERVICE/, `${file}: طباعة مفتاح الخدمة`);
    assert.doesNotMatch(body, /set -x|env \|/, `${file}: تتبّع الأوامر أو تفريغ البيئة يكشف السرّ`);
  }
}
ok("صلاحيات GITHUB_TOKEN كما هي بأدناها، ولا سرّ داخل run: ولا طباعة له");

// --- 5) جرد الأسرار في كل workflows ------------------------------------------------
for (const file of workflows) {
  const used = [...new Set([...stripComments(readFileSync(path.join(wfDir, file), "utf8")).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((n) => n !== "GITHUB_TOKEN"))].sort();
  assert.deepEqual(used, [...(SECRET_INVENTORY[file] || [])].sort(), `${file}: أسرار خارج الجرد المراجَع (${used.join(",") || "لا شيء"})`);
}
for (const file of workflows) {
  const yml = stripComments(readFileSync(path.join(wfDir, file), "utf8"));
  if (/pull_request_target/.test(topBlock(yml, "on") || "")) {
    assert.doesNotMatch(yml, new RegExp(`environment:\\s*(name:\\s*)?${ENV_NAME}`), `${file}: pull_request_target لا يلمس بيئة ${ENV_NAME}`);
    assert.doesNotMatch(yml, /secrets\.(?!GITHUB_TOKEN)/, `${file}: pull_request_target بلا أسرار`);
  }
}
ok("جرد الأسرار مطابق لكل workflow، وpull_request_target بلا أسرار ولا بيئة");

// --- 6) لا مفتاح حقيقي في المستودع --------------------------------------------------
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)
  .filter((f) => !/\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|xlsx|zip)$/i.test(f));
const leaks = [];
for (const f of tracked) {
  let text;
  try { text = readFileSync(path.join(root, f), "utf8"); } catch { continue; }
  if (/sb_secret_[A-Za-z0-9_-]{16,}/.test(text) || /eyJhbGciOi[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(text)) leaks.push(f);
}
assert.deepEqual(leaks, [], `مفتاح Supabase محفوظ في ملفات المستودع: ${leaks.join(", ")}`);
ok("لا مفتاح sb_secret_ ولا JWT خدمة في ملفات المستودع");

// --- 7) الترويسات مع المفتاحين ------------------------------------------------------
const JWT = "eyJ.test.legacy";
const NEW = "sb_secret_TESTONLY";
assert.deepEqual(supabaseServiceHeaders(JWT), { apikey: JWT, Authorization: `Bearer ${JWT}` });
assert.deepEqual(supabaseServiceHeaders(NEW), { apikey: NEW });

for (const key of [JWT, NEW]) {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return new Response(JSON.stringify({ ok: true, op: "probe", ready: true }), { status: 200 }); };
  const res = await callLifecycle("probe", {}, { env: { SUPABASE_URL: "https://x.invalid", SUPABASE_SERVICE_KEY: key }, fetchImpl });
  assert.equal(res.kind, "ok");
  assert.equal(seen[0].apikey, key);
  assert.equal("Authorization" in seen[0], key === JWT, `health-check: Authorization ${key === JWT ? "مطلوبة للمفتاح القديم" : "ممنوعة مع sb_secret_"}`);

  const stockSeen = [];
  const stockFetch = async (url, init = {}) => {
    stockSeen.push(init.headers || {});
    return new Response(JSON.stringify([]), { status: 200 });
  };
  await runStockAlerts({ env: { SUPABASE_URL: "https://x.invalid", SUPABASE_SERVICE_ROLE_KEY: key }, argv: [], fetchImpl: stockFetch, log: () => {} });
  assert.ok(stockSeen.length > 0);
  for (const h of stockSeen) {
    assert.equal(h.apikey, key);
    assert.equal("Authorization" in h, key === JWT, "stock-priority-alerts: ترويسة Authorization حسب نوع المفتاح");
  }
}
const alertYml = read(".github/workflows/alert-on-automation-failure.yml");
assert.match(alertYml, /case "\$SUPABASE_SERVICE_ROLE_KEY" in\s*\n\s*sb_\*\) ;;\s*\n\s*\*\) AUTH_HEADER=\(-H "Authorization: Bearer \$\{SUPABASE_SERVICE_ROLE_KEY\}"\) ;;/, "alert: Authorization للمفتاح القديم وحده");
assert.match(alertYml, /"\$\{AUTH_HEADER\[@\]\}"/);
ok("المفتاح القديم يرسل الترويستين كما كان، وsb_secret_ في apikey وحدها (health-check وstock-alerts وalert)");

console.log(`check-supabase-ops-environment: ${passed} مجموعات ناجحة`);
