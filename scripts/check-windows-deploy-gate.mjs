// ============================================================================
// check-windows-deploy-gate.mjs — عقود بوابة نشر Windows
//
// القرار (2026-09-28): الدمج إلى main لا يصل تلقائياً إلى سكربتات الإنتاج على
// OZK2026. الجهاز يتبع windows-production وحده، ويتقدّم Fast-Forward بعد موافقة
// المالك (Environment) وCI أخضر على نفس الـSHA. هذا الفحص يثبت:
//   1. منطق التصنيف وحكم CI في scripts/windows-release-verify.mjs (وحدات).
//   2. الـworkflow يدوي فقط، وموافقة البيئة تسبق الدفع، والدفع بلا --force.
//   3. البوابة لا تمرّر pull ولا rebase ولا --hard إلى git، وتحدّث بـmerge --ff-only،
//      ولا تقبل Deployment إلا بحمولة الإصدار نفسها.
//   4. قائمة سكربتات الكتابة تغطي كل ما يستدعيه مسار كتابة الأسعار إلى الأمين.
//   5. اختبارا PowerShell 5.1 مسجّلان في CI، وملفات البوابة تحمل BOM.
// السلوك الفعلي (git حقيقي، عَلَم الإيقاف، البصمات، الرجوع) في
// tools/tests/Test-DeployGate.ps1 وTest-RunRepoTask.ps1 على عدّاء Windows 5.1.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyChanges, evaluateCi, loadGateConfig, RELEASE_KIND } from "./windows-release-verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

// 1) الوحدات
const writers = ["tools/sync-approved-prices-to-ameen.ps1"];
const change = classifyChanges("M\ttools/reader.ps1\nA\tqueries/x.sql\nD\ttools\\sync-approved-prices-to-ameen.ps1\nM\tsrc/app.js\n", writers);
assert.equal(change.files.length, 4);
assert.equal(change.ps1Changed, true);
assert.equal(change.sqlChanged, true);
assert.equal(change.mjsChanged, true);
assert.deepEqual(change.writerScriptsChanged, ["tools/sync-approved-prices-to-ameen.ps1"]);
assert.deepEqual(classifyChanges("M\tdocs/a.md\n", writers).writerScriptsChanged, []);
ok("classifyChanges يصنّف PS1/SQL/JS ويلتقط سكربت الكتابة ولو بشرطة عكسية");

const green = { status: "completed", conclusion: "success" };
const base = {
  runs: [{ name: "Deploy TOBACCO Web", created_at: "2026-09-28T01:00:00Z", ...green }],
  requiredMainWorkflows: ["Deploy TOBACCO Web"],
  pullRequest: { number: 279 },
  prCheckRuns: [{ name: "check", ...green }],
  requiredPrChecks: ["check"]
};
assert.equal(evaluateCi(base).ok, true);
assert.equal(evaluateCi({ ...base, pullRequest: null }).ok, false, "commit بلا PR مدموج مرفوض");
assert.equal(evaluateCi({ ...base, prCheckRuns: [] }).ok, false, "فحص PR مطلوب مفقود مرفوض");
assert.equal(evaluateCi({ ...base, runs: [
  { name: "Deploy TOBACCO Web", created_at: "2026-09-28T01:00:00Z", ...green },
  { name: "Deploy TOBACCO Web", created_at: "2026-09-28T02:00:00Z", status: "completed", conclusion: "failure" }
] }).ok, false, "أحدث تشغيل هو الحَكَم");
assert.equal(evaluateCi({ ...base, runs: [{ name: "Deploy TOBACCO Web", created_at: "x", status: "in_progress", conclusion: null }] }).ok, false);
ok("evaluateCi: الأحدث يحكم، والمعلّق/المفقود/بلا PR = غير أخضر");

// 2) الـworkflow
const wf = read(".github/workflows/windows-release.yml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const onBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
assert.match(onBlock, /workflow_dispatch:/);
assert.doesNotMatch(onBlock, /\bpush:|\bpull_request|\bschedule:|workflow_run/, "لا تشغيل تلقائي");
const releaseJob = wf.slice(wf.indexOf("\n  release:"));
assert.match(releaseJob, /environment: windows-production/);
assert.match(releaseJob, /needs: verify/);
assert.doesNotMatch(wf, /--force|push -f\b|\+refs\/heads|:\+/);
assert.match(releaseJob, /git merge-base --is-ancestor "\$current" "\$sha"/);
assert.match(releaseJob, /windows-production moved since verification/);
assert.match(releaseJob, /kind: v\.kind/);
assert.doesNotMatch(wf, /run:[^\n]*\$\{\{\s*inputs\./, "المدخلات عبر env لا داخل run");
ok("الـworkflow يدوي، الموافقة تسبق الدفع، Fast-Forward بلا --force، والمدخلات عبر env");

// 3) البوابة
const gate = read("tools/deploy-gate/deploy-gate.ps1");
for (const token of ["'pull'", "'rebase'", "'--hard'"]) assert.ok(!gate.includes(token), `البوابة لا تمرّر ${token}`);
assert.ok(gate.includes("'merge', '--ff-only'"));
assert.ok(gate.includes("'reset', '--keep'"), "الرجوع اليدوي بـreset --keep");
assert.ok(gate.includes(`'${RELEASE_KIND}'`), "حمولة الإصدار نفسها شرط للموافقة");
assert.match(gate, /HEAD drift/);
assert.match(gate, /target is not on main/);
assert.match(gate, /writer scripts changed without writeScriptsApproved/);
assert.match(gate, /ROLLED_BACK_PINNED/);
assert.doesNotMatch(gate, /Join-Path \$Config\.repoPath 'tools\\[^']*\.ps1'\)\s*\n?\s*&|& \(Join-Path \$Config\.repoPath/, "البوابة لا تشغّل سكربتات المستودع");
const launcher = read("tools/deploy-gate/run-repo-task.ps1");
assert.match(launcher, /deploying\.flag/);
assert.match(launcher, /writer-allowlist\.json/);
assert.match(launcher, /StartsWith\(\$repoFull/);
ok("البوابة: ff-only، لا pull/rebase/--hard، موافقة بالحمولة، انحراف/تثبيت؛ والمشغّل يحترم العَلَم والبصمات");

// 4) سكربتات الكتابة
const config = loadGateConfig();
for (const w of config.writerScripts) assert.ok(existsSync(path.join(root, w)), `سكربت الكتابة موجود: ${w}`);
const writerSet = new Set(config.writerScripts);
const pending = ["tools/sync-approved-prices-to-ameen.ps1"];
const seen = new Set();
while (pending.length) {
  const rel = pending.pop();
  if (seen.has(rel)) continue;
  seen.add(rel);
  assert.ok(writerSet.has(rel), `مسار كتابة الأسعار يستدعي ${rel} وهو خارج writerScripts`);
  for (const m of read(rel).matchAll(/\$PSScriptRoot\\([A-Za-z0-9_.-]+\.ps1)/g)) pending.push(`tools/${m[1]}`);
}
for (const sql of ["tools/apply-approved-prices-to-ameen.ps1", "tools/sync-purchase-invoices-to-ameen.ps1"]) assert.ok(writerSet.has(sql));
assert.ok(config.pauseTasks.includes("TOBACCO Approved Prices Pull") && config.pauseTasks.includes("TOBACCO Ameen Sync"));
ok(`writerScripts تغطي كل مسار كتابة الأسعار (${seen.size} ملفات) وكتّاب الأمين الآخرين`);

// 5) CI و BOM
const checkWf = read(".github/workflows/check.yml");
assert.match(checkWf, /tools\\tests\\Test-DeployGate\.ps1/);
assert.match(checkWf, /tools\\tests\\Test-RunRepoTask\.ps1/);
for (const f of ["tools/deploy-gate/deploy-gate.ps1", "tools/deploy-gate/run-repo-task.ps1", "tools/deploy-gate/notify.ps1", "tools/tests/Test-DeployGate.ps1", "tools/tests/Test-RunRepoTask.ps1"]) {
  const bytes = readFileSync(path.join(root, f));
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, `${f} يحمل BOM (5.1 يقرأ غيره ANSI)`);
}
ok("اختبارا 5.1 مسجّلان في CI وملفات البوابة تحمل BOM");

console.log(`check-windows-deploy-gate: اجتاز ${passed} عقود.`);
