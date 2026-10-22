// ============================================================================
// check-supabase-auth-probe.mjs — فحص مصادقة Supabase في health-check (قراءة فقط)
//
// بلا شبكة ولا أسرار حقيقية: fetch وهمي يحاكي PostgREST. يثبت:
//   - الطلب الوحيد rpc/health_lifecycle بعملية probe وحقول null (لا كتابة، لا تيليغرام، لا حادثة).
//   - الترويسات نفسها التي يستعملها health-check: JWT القديم في apikey+Authorization، وsb_secret_ في apikey وحدها.
//   - التصنيف: 200 صالح = ok؛ 401/403 = auth؛ 200 بجسم غير مُثبِت أو 404/PGRST202 = unproven؛
//     429/5xx/timeout/شبكة = إعادة محاولة مرئية، واستمرارها = unavailable (لا auth).
//   - إغلاق الحوادث بدليل إيجابي فقط، ولا مشكلة ولا تيليغرام عند النجاح.
//   - لا يظهر المفتاح ولا جزء منه ولا «Bearer» في أي سجل أو مشكلة.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeSupabaseAuth, serviceKeyType, AUTH_PROBE_KEYS } from "./health-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

const LEGACY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXRlc3Q";
const NEW = "sb_secret_TESTONLY_abcdefghijklmnop";
const URL_ = "https://example.invalid";
const PROBE_OK = { ok: true, op: "probe", v: 1, ready: true };

const reply = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function harness(key, responders, extraEnv = {}) {
  const calls = [];
  const logs = [];
  const sleeps = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const r = responders[Math.min(i, responders.length - 1)];
    i += 1;
    return r(url, init);
  };
  return {
    calls, logs, sleeps,
    run: () => probeSupabaseAuth({
      env: { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: key, GITHUB_ACTIONS: "true", ...extraEnv },
      fetchImpl, log: (m) => logs.push(m), sleep: async (ms) => { sleeps.push(ms); }, retryDelaysMs: [2000, 5000]
    })
  };
}
// لا يظهر المفتاح ولا أي مقطع منه (≥ 8 محارف) ولا ترويسة Authorization في السجلات أو المشاكل.
function assertNoLeak(key, h, result) {
  const text = [...h.logs, JSON.stringify(result)].join("\n");
  assert.ok(!/Bearer|Authorization|apikey/i.test(text), "لا ترويسات في السجلات");
  for (let s = 0; s + 8 <= key.length; s += 1) {
    const part = key.slice(s, s + 8);
    if (/^(eyJhbGci|sb_secre|b_secret|_secret_|secret_T)/.test(part)) continue; // بادئات عامة معروفة لا تكشف شيئاً
    assert.ok(!text.includes(part), `مقطع من المفتاح ظهر في السجل: ${part}`);
  }
}

// 1) النجاح بالمفتاحين، والطلب قراءة فقط
for (const [key, type] of [[LEGACY, "legacy-jwt"], [NEW, "sb_secret"]]) {
  const h = harness(key, [reply(200, PROBE_OK)]);
  const r = await h.run();
  assert.equal(r.kind, "ok");
  assert.equal(r.keyType, type);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.healthy.sort(), [...AUTH_PROBE_KEYS].sort(), "النجاح دليل إيجابي يغلق حوادث المصادقة الثلاث");
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, `${URL_}/rest/v1/rpc/health_lifecycle`);
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { p_op: "probe", p_key: null, p_issue: null, p_label: null }, "probe بلا مفتاح حادثة ولا Issue: لا renew/resolve");
  assert.equal(init.headers.apikey, key);
  assert.equal("Authorization" in init.headers, key === LEGACY, "Authorization للـJWT القديم وحده");
  assert.ok(h.logs.some((l) => l.includes(`نوع المفتاح ${type}`)));
  assertNoLeak(key, h, r);
}
ok("200 بإقرار probe صالح = مصادقة service_role مُثبتة، بالمفتاح القديم والجديد، بطلب قراءة واحد وترويسات health-check نفسها");

// 2) 401 و403 = فشل مصادقة، بلا إعادة محاولة
for (const status of [401, 403]) {
  const h = harness(NEW, [reply(status, { code: status === 401 ? "PGRST301" : "42501", message: "denied" })]);
  const r = await h.run();
  assert.equal(r.kind, "auth");
  assert.equal(h.calls.length, 1, "لا إعادة محاولة لفشل المصادقة");
  assert.deepEqual(r.problems.map((p) => p.key), ["supabase-auth-failed"]);
  assert.deepEqual(r.healthy, []);
  assert.ok(h.logs.some((l) => l.startsWith("::error::")));
  assertNoLeak(NEW, h, r);
}
ok("401 و403 ⇒ «supabase-auth-failed» فوراً، بلا إعادة محاولة ولا إغلاق حوادث");

// 3) 429 و5xx وtimeout وشبكة: عابرة ثم تعافٍ، أو مستمرة = unavailable لا auth
const abort = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
const netErr = async () => { throw new TypeError("fetch failed"); };
for (const [label, flaky] of [["429", reply(429, "rate")], ["500", reply(500, "x")], ["503", reply(503, "x")], ["timeout", abort], ["network", netErr]]) {
  const recovered = harness(LEGACY, [flaky, reply(200, PROBE_OK)]);
  const r1 = await recovered.run();
  assert.equal(r1.kind, "ok", `${label} ثم 200 ⇒ ok`);
  assert.equal(r1.attempts, 2);
  assert.deepEqual(recovered.sleeps, [2000]);
  assert.ok(recovered.logs.some((l) => l.startsWith("::warning::")), `${label}: الخلل العابر مرئي`);

  const persistent = harness(LEGACY, [flaky]);
  const r2 = await persistent.run();
  assert.equal(r2.kind, "unavailable", `${label} مستمر ⇒ unavailable`);
  assert.equal(r2.attempts, 3);
  assert.deepEqual(persistent.sleeps, [2000, 5000]);
  assert.deepEqual(r2.problems.map((p) => p.key), ["supabase-api-unavailable"], `${label}: ليس فشل مصادقة`);
  assert.deepEqual(r2.healthy, [], `${label}: لا إغلاق حوادث بلا دليل`);
  assertNoLeak(LEGACY, persistent, r2);
}
ok("429/500/503/timeout/شبكة: إعادة محاولة مرئية (::warning::)، والتعافي = ok، والاستمرار = «supabase-api-unavailable» لا فشل مصادقة ولا إخفاء");

// 4) نجاح شكلي لا يثبت الصلاحية
for (const [label, resp] of [
  ["200 جسم فارغ", reply(200, "")],
  ["200 مصفوفة", reply(200, [])],
  ["200 op آخر", reply(200, { ok: true, op: "renew", v: 1, ready: true })],
  ["200 بلا v", reply(200, { ok: true, op: "probe", ready: true })],
  ["404 PGRST202", reply(404, { code: "PGRST202", message: "not found" })],
  ["400", reply(400, { code: "22023" })]
]) {
  const h = harness(NEW, [resp]);
  const r = await h.run();
  assert.equal(r.kind, "unproven", label);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(r.problems.map((p) => p.key), ["supabase-auth-unproven"], label);
  assert.deepEqual(r.healthy, [], label);
}
ok("200 بجسم لا يثبت probe، أو 404/PGRST202، أو 4xx أخرى ⇒ «supabase-auth-unproven» (ليس نجاحاً)");

// 5) مفتاح غير مضبوط
{
  const h = harness("", [reply(200, PROBE_OK)]);
  const r = await h.run();
  assert.equal(r.kind, "auth");
  assert.equal(h.calls.length, 0);
  assert.equal(r.problems[0].key, "supabase-auth-failed");
  const local = harness("", [reply(200, PROBE_OK)], { GITHUB_ACTIONS: "" });
  assert.equal((await local.run()).kind, "skipped", "خارج Actions بلا مفتاح ⇒ تخطٍّ");
}
ok("المفتاح غير مضبوط داخل Actions ⇒ فشل مصادقة مرئي؛ خارج Actions ⇒ تخطٍّ");

// 6) نوع المفتاح وحده
assert.equal(serviceKeyType(LEGACY), "legacy-jwt");
assert.equal(serviceKeyType(NEW), "sb_secret");
assert.equal(serviceKeyType("sb_publishable_x"), "sb_other");
assert.equal(serviceKeyType(""), "missing");
assert.equal(serviceKeyType("abc"), "unknown");
ok("نوع المفتاح يُصنَّف بلا كشف قيمته (legacy-jwt / sb_secret / sb_other / missing / unknown)");

// 7) الربط في main: بلا تيليغرام عند النجاح، والنتيجة تدخل المسار المعتاد
const src = readFileSync(path.join(root, "scripts/health-check.mjs"), "utf8");
const probeSrc = src.slice(src.indexOf("export async function probeSupabaseAuthOnce"), src.indexOf("export async function detectLifecycleMode"));
assert.doesNotMatch(probeSrc, /notifyTelegram|notify_telegram|reportProblem|"renew"|"resolve"|gh\(/, "الفحص لا يرسل ولا يكتب ولا يمسّ حادثة بنفسه");
assert.doesNotMatch(probeSrc, /serviceKey\}|SUPABASE_SERVICE_KEY\}|console\.log\([^)]*serviceKey/, "لا طباعة للمفتاح");
const mainSrc = src.slice(src.indexOf("async function main()"));
assert.match(mainSrc, /const supabaseAuth = await probeSupabaseAuth\(\);/);
assert.match(mainSrc, /\.\.\.supabaseAuth\.problems/);
assert.match(mainSrc, /\.\.\.supabaseAuth\.healthy/);
const wf = readFileSync(path.join(root, ".github/workflows/health-check.yml"), "utf8");
assert.match(wf, /cron: '\*\/30 \* \* \* \*'/, "الجدولة كل 30 دقيقة باقية");
ok("main يضمّ النتيجة إلى المسار المعتاد (Issue/تنبيه عند المشكلة فقط)، والفحص لا يرسل تيليغرام ولا يمسّ حادثة، والجدولة كل 30 دقيقة باقية");

console.log(`check-supabase-auth-probe: اجتاز ${passed} عقود.`);
