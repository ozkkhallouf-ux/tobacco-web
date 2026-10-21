// ============================================================================
// check-supabase-ops-environment.mjs — حماية مفتاح Supabase (service role) في GitHub Actions
//
// القرار (2026-10-21): SUPABASE_SERVICE_ROLE_KEY يُنقل من أسرار المستودع (يقرأها أي workflow على
// أي فرع) إلى بيئة supabase-ops المحصورة بفرع main وحده، بلا مراجع مطلوب كي تبقى المهام الآلية
// تعمل. هذا الحارس يثبت أن:
//   1. كل job يستعمل المفتاح يعلن environment: supabase-ops، ولا يستعمله job آخر.
//   2. هذه الـworkflows لا تُطلق من pull_request/pull_request_target/push (لا كود PR أو فرع مع السرّ)،
//      وأن مُطلقاتها المعتمدة باقية كما هي (المجدول والآلي يستمران).
//   3. لا طباعة للمفتاح ولا set -x ولا كتابته إلى GITHUB_ENV/GITHUB_OUTPUT ولا إلى ملف.
//   4. checkout بلا اعتماد محفوظ، وصلاحيات GITHUB_TOKEN كما هي دون توسيع.
//   5. لا مفتاح Supabase سرّي مكتوب في أي workflow (sb_secret_ أو JWT service_role).
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wfDir = path.join(root, ".github/workflows");
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

const ENV = "supabase-ops";
const SECRET = "SUPABASE_SERVICE_ROLE_KEY";
const stripComments = (src) => src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

// تقسيم بسيط حسب المسافات البادئة (ملفات المستودع بمسافتين ثابتتين): jobs ثم كل job بمستوى 2.
function jobsOf(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return {};
  const jobs = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { current = m[1]; jobs[current] = []; continue; }
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join("\n")]));
}
const triggersOf = (src) => {
  const block = src.slice(src.indexOf("\non:") + 1).split(/\n(?=[a-z])/)[0];
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
};

const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
const users = {};
for (const f of files) {
  const src = stripComments(readFileSync(path.join(wfDir, f), "utf8"));
  for (const [job, body] of Object.entries(jobsOf(src))) {
    if (body.includes(`secrets.${SECRET}`)) (users[f] ||= []).push({ job, body, src });
  }
}

// 1) من يستعمل المفتاح، وكلهم خلف البيئة
assert.deepEqual(Object.keys(users).sort(), ["alert-on-automation-failure.yml", "health-check.yml", "stock-priority-alerts.yml"], "مستعملو المفتاح المعروفون فقط");
for (const [f, jobs] of Object.entries(users)) {
  for (const { job, body } of jobs) {
    assert.match(body, new RegExp(`\\n {4}environment: ${ENV}\\n`), `${f}#${job} يجب أن يعلن environment: ${ENV}`);
    assert.doesNotMatch(body, /\n {4}environment:\s*\n/, `${f}#${job}: البيئة بصيغة بسيطة لا كائن بلا اسم`);
  }
}
ok(`كل job يقرأ ${SECRET} يعلن environment: ${ENV} (3 workflows)، ولا مستعمل آخر`);

// 2) المُطلقات: لا كود PR ولا push، والمعتمد باقٍ
const expectedTriggers = {
  "health-check.yml": ["schedule", "workflow_dispatch"],
  "stock-priority-alerts.yml": ["workflow_dispatch"],
  "alert-on-automation-failure.yml": ["workflow_run"]
};
for (const [f, want] of Object.entries(expectedTriggers)) {
  const src = stripComments(readFileSync(path.join(wfDir, f), "utf8"));
  assert.deepEqual(triggersOf(src), want, `${f}: مُطلقات غير متوقعة`);
  assert.doesNotMatch(src, /pull_request|pull_request_target|^\s{2}push:/m, `${f}: لا مُطلق من PR أو push`);
}
ok("المُطلقات كما هي (مجدول/يدوي/workflow_run)، ولا pull_request ولا pull_request_target ولا push مع السرّ");

// 3) لا تسريب
for (const [f, jobs] of Object.entries(users)) {
  for (const { job, body } of jobs) {
    assert.doesNotMatch(body, /set -x|set -o xtrace/, `${f}#${job}: لا set -x`);
    assert.doesNotMatch(body, /(echo|printf|cat)[^\n]*\$\{?(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)\b/, `${f}#${job}: لا طباعة للمفتاح`);
    assert.doesNotMatch(body, /GITHUB_ENV|GITHUB_OUTPUT|::set-output|>\s*[^\n]*\.(env|key|txt)\b[^\n]*SUPABASE/i, `${f}#${job}: لا تمرير للمفتاح إلى خطوة أخرى أو ملف`);
    assert.doesNotMatch(body, /secrets\.SUPABASE_SERVICE_ROLE_KEY[^\n]*\n[^\n]*with:/, `${f}#${job}: لا تمرير للمفتاح إلى action طرف ثالث`);
  }
}
ok("لا set -x، ولا طباعة للمفتاح، ولا تمريره إلى GITHUB_ENV/GITHUB_OUTPUT أو ملف أو action طرف ثالث");

// 4) checkout بلا اعتماد محفوظ، وصلاحيات بلا توسيع
for (const f of Object.keys(users)) {
  const src = stripComments(readFileSync(path.join(wfDir, f), "utf8"));
  for (const step of src.split("\n      - ").filter((s) => /uses: actions\/checkout@/.test(s))) {
    assert.match(step, /persist-credentials: false/, `${f}: checkout بلا اعتماد محفوظ`);
  }
  assert.match(src, /\npermissions:\n/, `${f}: صلاحيات صريحة على مستوى الملف`);
  assert.doesNotMatch(src, /contents: write|administration:|id-token: write|secrets: write|actions: write/, `${f}: لا صلاحيات كتابة واسعة`);
}
ok("checkout بـpersist-credentials: false، وصلاحيات GITHUB_TOKEN صريحة بلا كتابة محتوى أو إدارة");

// 5) لا مفاتيح مكتوبة في أي workflow
for (const f of files) {
  const raw = readFileSync(path.join(wfDir, f), "utf8");
  assert.doesNotMatch(raw, /sb_secret_[A-Za-z0-9_-]{10,}/, `${f}: مفتاح sb_secret مكتوب`);
  assert.doesNotMatch(raw, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, `${f}: JWT مكتوب`);
}
ok("لا مفتاح sb_secret_ ولا JWT مكتوب في أي workflow");

console.log(`check-supabase-ops-environment: اجتاز ${passed} عقود.`);
