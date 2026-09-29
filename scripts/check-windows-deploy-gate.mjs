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
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyChanges, evaluateCi, loadGateConfig, RELEASE_KIND, inWriteScanScope, writeIndicators, affectedLongRunning, newestByName } from "./windows-release-verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
let passed = 0;
const checkWfRaw = () => readFileSync(path.join(root, ".github/workflows/check.yml"), "utf8");
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

// Codex P1 #1: فحوص الـPR أيضاً بأحدث تشغيل وحده.
const pr = (conclusion, status, started_at, id) => ({ name: "check", status, conclusion, started_at, id });
assert.equal(evaluateCi({ ...base, prCheckRuns: [pr("success", "completed", "2026-09-28T01:00:00Z", 1), pr("failure", "completed", "2026-09-28T02:00:00Z", 2)] }).ok, false, "old success + newer failure = BLOCK");
assert.equal(evaluateCi({ ...base, prCheckRuns: [pr("failure", "completed", "2026-09-28T01:00:00Z", 1), pr("success", "completed", "2026-09-28T02:00:00Z", 2)] }).ok, true, "old failure + newer success = PASS");
for (const [status, conclusion] of [["completed", "cancelled"], ["completed", "timed_out"], ["in_progress", null], ["queued", null]]) {
  assert.equal(evaluateCi({ ...base, prCheckRuns: [pr("success", "completed", "2026-09-28T01:00:00Z", 1), pr(conclusion, status, "2026-09-28T03:00:00Z", 3)] }).ok, false, `newer ${status}/${conclusion} = BLOCK`);
}
assert.equal(evaluateCi({ ...base, prCheckRuns: [pr("failure", "completed", "2026-09-28T01:00:00Z", 1), pr("success", "completed", "2026-09-28T01:00:00Z", 2)] }).ok, true, "same start time: higher id is newer");
for (const [status, conclusion, startedAt] of [["queued", null, null], ["queued", null, ""], ["in_progress", null, null], ["waiting", null, null]]) {
  assert.equal(evaluateCi({ ...base, prCheckRuns: [pr("success", "completed", "2026-09-28T01:00:00Z", 1), pr(conclusion, status, startedAt, 9)] }).ok, false, `newer ${status} without started_at = BLOCK`);
}
assert.equal(newestByName([pr("success", "completed", "2026-09-28T01:00:00Z", 1), pr(null, "queued", null, 9)], "check", "started_at").id, 9);
assert.match(read("tools/deploy-gate/deploy-gate.ps1"), /9999-12-31T23:59:59Z/, "Get-NewestVerdict: وقت فارغ = أحدث");
ok("فحوص الـPR بأحدث تشغيل: نجاح قديم لا يغطّي فشلاً/إلغاءً/مهلة/تشغيلاً جارياً أحدث (Codex P1 #1)");

// Codex P1 #2: كشف قدرة الكتابة لا يعتمد على أسماء الملفات.
const cfg0 = loadGateConfig();
const scan = cfg0.writeScan;
assert.ok(inWriteScanScope("tools/ameen-sync-agent.ps1", scan) && inWriteScanScope("tools/x/y.sql", scan) && inWriteScanScope("scripts/serve.mjs", scan));
assert.ok(!inWriteScanScope("tools/tests/Test-X.ps1", scan) && !inWriteScanScope("scripts/check-x.mjs", scan) && !inWriteScanScope("docs/a.md", scan) && !inWriteScanScope("tools/ameen-autoprint/__tests__/a.js", scan));
const agentBefore = read("tools/ameen-sync-agent.ps1");
assert.deepEqual(writeIndicators(agentBefore, scan), [], "ameen-sync-agent اليوم قارئ لا كاتب");
for (const mutation of ["$cmd.CommandText = 'UPDATE bt000 SET Flag = 1'", "insert into mt000 (x) values (1)", "DELETE FROM en000", "MERGE INTO x USING y", "$c = $env:AMEEN_SQL_WRITE_CONNECTION_STRING", "$cmd.ExecuteNonQuery()", "EXEC sp_executesql @q", "Invoke-Sqlcmd -Query $q", "BEGIN TRAN", "TRUNCATE TABLE t", "ALTER TABLE t ADD c int"]) {
  assert.ok(writeIndicators(agentBefore + "\n" + mutation, scan).length > 0, `قارئ صار كاتباً يُكشف: ${mutation}`);
}
assert.deepEqual(writeIndicators("SELECT Name FROM cu000 WHERE Balance > 0 -- updated set of rows", scan), []);
const known = ["tools/apply-approved-prices-to-ameen.ps1", "tools/setup-ameen-retail-pricelist.ps1", "tools/push-customer-movements.ps1"];
for (const f of known) assert.ok(writeIndicators(read(f), scan).length > 0, `كاتب/حامل اتصال كتابة معروف يُكشف: ${f}`);
const gateSrc = read("tools/deploy-gate/deploy-gate.ps1");
assert.match(gateSrc, /\$Config\.writeScan\.patterns/, "البوابة تقرأ نفس الأنماط من الإعداد");
assert.match(gateSrc, /\$show\.Code -ne 0 -or/, "تعذّر قراءة الملف = كاتب (fail-closed)");
ok("كشف الكتابة: قارئ يصير كاتباً يُحجب بلا موافقة، ونطاق الفحص يستثني الاختبارات والوثائق (Codex P1 #2)");

// Codex P1 #3: عمليات طويلة — خريطة تبعيات صريحة، لا إعادة تشغيل تلقائية.
const comps = cfg0.longRunningComponents;
assert.deepEqual(comps.map((c) => c.name), ["TOBACCO Ameen Read Worker", "OZK-AmeenAutoPrint", "OZK-Tobacco-Server (scripts/serve.mjs)"]);
for (const c of comps) for (const f of c.files) assert.ok(existsSync(path.join(root, f)), `ملف مُدرج موجود: ${f}`);
const byName = Object.fromEntries(comps.map((c) => [c.name, new Set(c.files)]));
const need = (name, rel) => assert.ok(byName[name].has(rel), `${name} يعتمد على ${rel} وهو خارج خريطة التبعيات`);
for (const m of read("tools/ameen-read-worker.ps1").matchAll(/\$PSScriptRoot\\([A-Za-z0-9_.-]+\.(ps1|sql))/g)) need("TOBACCO Ameen Read Worker", `tools/${m[1]}`);
for (const m of read("tools/ameen-read-gateway.ps1").matchAll(/\.\\tools\\([A-Za-z0-9_.-]+\.(ps1|sql))/g)) need("TOBACCO Ameen Read Worker", `tools/${m[1]}`);
for (const f of ["watcher.js", "config.js", "invoice-html.js"]) {
  const src = read(`tools/ameen-autoprint/${f}`);
  need("OZK-AmeenAutoPrint", `tools/ameen-autoprint/${f}`);
  for (const m of src.matchAll(/require\(["']\.\/([A-Za-z0-9_.-]+)["']\)/g)) need("OZK-AmeenAutoPrint", `tools/ameen-autoprint/${m[1].endsWith(".js") ? m[1] : m[1] + ".js"}`);
  for (const m of src.matchAll(/path\.join\(__dirname,\s*["']([A-Za-z0-9_.-]+)["']\)/g)) need("OZK-AmeenAutoPrint", `tools/ameen-autoprint/${m[1]}`);
}
for (const m of read("scripts/serve.mjs").matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) need("OZK-Tobacco-Server (scripts/serve.mjs)", path.posix.join("scripts", m[1]));
assert.deepEqual(affectedLongRunning(["docs/a.md", "tools/reader.ps1"], comps), []);
assert.deepEqual(affectedLongRunning(["tools/ameen-read-gateway.ps1"], comps), ["TOBACCO Ameen Read Worker"]);
assert.deepEqual(affectedLongRunning(["tools/ameen-autoprint/invoice-html.js", "scripts/serve.mjs", "tools/ameen-read-worker.ps1"], comps).length, 3);
for (const forbidden of ["Stop-ScheduledTask", "Start-ScheduledTask", "Enable-ScheduledTask", "Disable-ScheduledTask", "Set-ScheduledTask", "Register-ScheduledTask", "Stop-Process", "Restart-Service", "Stop-Service", "taskkill", "schtasks"]) {
  assert.ok(!gateSrc.includes(forbidden), `البوابة لا تستعمل ${forbidden}`);
}
assert.match(gateSrc, /DEPLOYED_PENDING_RESTART/);
ok("عمليات طويلة: خريطة تبعيات تغطي الاستدعاءات الفعلية، والبوابة تسجّل DEPLOYED_PENDING_RESTART بلا أي إعادة تشغيل (Codex P1 #3)");

// Codex P1 #5: المهام التي تحتاج main تنتقل إلى worktree مخصّص قبل تحويل المستودع التشغيلي.
const mw = cfg0.mainWorktree;
assert.equal(mw.branch, "main");
assert.match(mw.remote, /github\.com[/:]ozkkhallouf-ux\/tobacco-web(\.git)?$/);
assert.notEqual(mw.path.toLowerCase(), cfg0.repoPath.toLowerCase(), "الـworktree المخصّص ليس المستودع التشغيلي");
assert.deepEqual(mw.allowedScripts, ["tools/auto-sync-price-lists.ps1"], "الـworktree المخصّص لنشرات الأسعار وحدها");
assert.deepEqual(cfg0.mainDependentTasks.map((t) => [t.task, t.script]), [["OZK-PriceListSync", "tools/auto-sync-price-lists.ps1"]]);
const sync = read("tools/auto-sync-price-lists.ps1");
assert.match(sync, /rev-parse --abbrev-ref HEAD/);
assert.match(sync, /\$currentBranch -ne "main"/, "حارس main في مزامنة النشرات لم يُخفَّف");
// أي سكربت يشترط الفرع main يجب أن يكون مهمة معلنة (أو أداة يدوية مستثناة بتعليل).
const manualMainTools = { "tools/ai-work-coordination.ps1": "أداة يدوية لقفل AI على main، ليست مهمة مجدولة" };
const declared = new Set(cfg0.mainDependentTasks.map((t) => t.script));
for (const f of readdirSync(path.join(root, "tools")).filter((n) => n.endsWith(".ps1")).map((n) => `tools/${n}`)) {
  const src = read(f);
  if (/(abbrev-ref HEAD|branch --show-current)/.test(src) && /-ne\s+["']main["']/.test(src)) {
    assert.ok(declared.has(f) || manualMainTools[f], `${f} يشترط main وليس معلناً في mainDependentTasks`);
  }
}
const pre = read("tools/deploy-gate/migration-preflight.ps1");
assert.match(pre, /task definition not visible/, "مهمة غير مرئية ⇒ حجب");
assert.match(pre, /outside its allow-list/, "لا باب خلفي عبر worktree الـmain");
assert.match(pre, /main worktree must not be the operational repository/);
assert.match(gateSrc, /\$pre = Invoke-InstallPreflight \$Config[\s\S]{0,400}migration preflight blocked/, "Initialize يرفض ما لم ينجح الفحص");
assert.match(checkWfRaw(), /tools\\tests\\Test-MigrationPreflight\.ps1/);
ok("مزامنة النشرات تبقى على main عبر worktree مخصّص، والتحويل محجوب حتى ينجح الفحص (Codex P1 #5)");

// حدود الثقة (تصميم التركيب القادم، Codex P1 على #285): هوية بوابة مخصّصة لا تشغّل كود أي
// مستودع؛ SYSTEM/OZKSync/LOQ/Administrators مرفوضة، وملفات الثقة لا يكتبها غيرها.
const trust = cfg0.trust;
const idKey = (s) => String(s).toLowerCase().replace(/^.*\\/, "").replace(/^localsystem$|^s-1-5-18$/, "system").replace(/^s-1-5-32-544$/, "administrators");
assert.ok(trust.gateAccount && !["system", "ozksync", "loq", "administrators", "local service", "network service"].includes(idKey(trust.gateAccount)), "هوية البوابة مخصّصة لا SYSTEM/OZKSync/LOQ/Administrators");
assert.deepEqual(trust.gateDirWriters, [trust.gateAccount], "ملفات الثقة تكتبها الهوية المخصّصة وحدها");
for (const f of ["system", "ozksync", "loq", "administrators"]) assert.ok(trust.forbiddenGateIdentities.map(idKey).includes(f), `هوية مرفوضة مسجّلة: ${f}`);
assert.ok(!trust.gateDirWriters.some((w) => ["system", "ozksync", "loq", "administrators"].includes(idKey(w))), "لا هوية عبء عمل ولا Administrators بين كتّاب ملفات الثقة");
assert.match(read("tools/ameen-autoprint/install-service.bat"), /\/ru SYSTEM/, "سبب رفض SYSTEM ما زال قائماً: AutoPrint من المستودع بحساب SYSTEM");
const preSrc = read("tools/deploy-gate/migration-preflight.ps1");
for (const needle of ["function Invoke-GateIdentityPreflight", "forbidden gate identity", "dedicated gate identity is reused", "identity not verifiable", "writable by the dedicated gate identity only", "which may write the gate trust files", "function Invoke-InstallPreflight"]) assert.ok(preSrc.includes(needle), `حارس الهوية: ${needle}`);
assert.match(gateSrc, /\$pre = Invoke-InstallPreflight \$Config/, "Initialize يشغّل فحص التثبيت الكامل (الهوية + نشرات الأسعار)");
// Codex P1 (#285): جرد الخدمات بـStop وقائمة فارغة تحجب؛ Action مهمة البوابة مطابق حرفياً؛ ACL فعلية.
assert.match(preSrc, /Get-CimInstance -ClassName Win32_Service -ErrorAction Stop/);
assert.doesNotMatch(preSrc, /Win32_Service -ErrorAction SilentlyContinue|Get-ScheduledTask -ErrorAction SilentlyContinue \| Where-Object \{ \$_\.TaskPath/, "لا جرد صامت الفشل");
assert.ok(preSrc.includes("service inventory is empty"), "قائمة خدمات فارغة = حجب");
for (const needle of ["function Test-ExactGateAction", "interpreter is not the approved PowerShell", "disallowed PowerShell argument", "arguments cannot be parsed unambiguously", "script path is not an absolute canonical path", "disallowed script argument", "expected exactly one action"]) assert.ok(preSrc.includes(needle), `Action البوابة الحرفي: ${needle}`);
{ const i = preSrc.indexOf("function Test-ExactGateAction"); const exact = preSrc.slice(i, preSrc.indexOf("\nfunction ", i + 10));
  assert.doesNotMatch(exact, /'-command'|'-encodedcommand'|'-c'|'-enc'/i, "لا مفتاح تنفيذ مضمَّن ضمن القائمة المسموحة لمهمة البوابة"); }
// مكان المهمة لا يمنح استثناء: لا إعادة لاستثناء \Microsoft\ (أو أي TaskPath) من جرد الهويات.
const preCode = preSrc.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
assert.doesNotMatch(preCode, /TaskPath\s+-(not)?(like|match|eq)|\.TaskPath\s*-(not)?(like|match)|\\\\?Microsoft\\\\?\*/i, "لا استثناء لمهام حسب TaskPath (ومنها \\Microsoft\\)");
assert.match(preCode, /Get-ScheduledTask -ErrorAction Stop\)\)/, "جرد كل المهام بلا ترشيح");
for (const needle of ["function Resolve-WorkloadReach", "cannot determine whether this", "function Expand-UserProfileVariables", "function Expand-MachineVariables", "$depth -ge 3"]) assert.ok(preSrc.includes(needle), `تتبّع الأغلفة: ${needle}`);
// Codex P1: مراجع البيئة تُفحص في الـAction وفي كل غلاف بالمسار نفسه — لا تقتصر على الـAction.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const act = body("Get-ActionReach"), wrap = body("Get-WrapperReach");
  assert.match(act, /foreach \(\$pair in @\(@\('execute', \$Execute\), @\('arguments', \$Arguments\), @\('workingDirectory', \$WorkingDirectory\)\)\)[\s\S]*Expand-TraceText/, "كل حقل Action يمرّ بفحص البيئة");
  assert.match(wrap, /\$xi = Expand-TraceText \(\[string\]\$inner\) \$Ctx\.identity \$Path\s+if \(\$xi\.undetermined\) \{ \$r = Join-Reach \$r \(New-Reach 'UNKNOWN'/, "جسم الغلاف يمرّ بفحص البيئة ⇒ UNKNOWN");
  for (const b of [act, wrap]) assert.doesNotMatch(b, /Expand-UserProfileVariables|Expand-MachineVariables|%\[A-Za-z_\]/, "لا توسيع/فحص بيئة مباشر خارج Expand-TraceText");
  const i2 = preSrc.indexOf("function Expand-TraceText"); const tx = preSrc.slice(i2, preSrc.indexOf("\nfunction ", i2 + 10));
  for (const needle of ["\\$\\{env:", "\\$env:", "!([A-Za-z_]", "GetEnvironmentVariable", "\\.Environment\\s*\\(", "%~dp0", "$undetermined = $true }\n    return"]) assert.ok(tx.includes(needle), `صيغة بيئة مغطّاة: ${needle}`);
  assert.match(preSrc, /function ConvertTo-CanonicalTracePath/, "تطبيع '..' قبل فحص الجذر");
}
// Codex P1 (#285): حقول Action منفصلة، ثلاثي الحالة بلا سقوط UNKNOWN→NOT_REPO، ومهمة بوابة واحدة إلزامية.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const inv = body("Get-PreflightTaskInventory"), idp = body("Invoke-GateIdentityPreflight"), act = body("Get-ActionReach"), join = body("Join-Reach");
  // 1) لا دمج لحقول الـAction في نص واحد للتحليل الأمني.
  assert.doesNotMatch(inv, /\+ ' ' \+|-join "`n"|action = \(/, "الجرد لا يدمج Execute/Arguments/WorkingDirectory");
  assert.match(inv, /execute = \[string\]\$_\.Execute; arguments = \[string\]\$_\.Arguments; workingDirectory = \[string\]\$_\.WorkingDirectory/);
  assert.match(idp, /if \(\$item\.kind -eq 'task' -or \$item\.kind -eq 'startup'\) \{\s+\$reach = Resolve-TaskReach \$Config \$item\.actions/, "المهام تُصنَّف بحقولها المنظّمة");
  assert.doesNotMatch(idp, /Resolve-WorkloadReach \$Config \(\[string\]\$item\.action\) \(\[string\]\$item\.identity\)\s*\n\s*\$isRepo/, "لا تصنيف مهمة من نص مدموج");
  assert.match(act, /Get-TargetReach \$Ctx \$exe \$wd/, "البرنامج يُحلّ بالنسبة لمجلد العمل");
  assert.match(body("Get-TargetReach"), /Resolve-TracePath \$Target \$WorkDir/, "الهدف النسبي يُحلّ بالنسبة لمجلد العمل");
  assert.match(act, /working directory inside a repository root/);
  // 2) لا سقوط UNKNOWN → NOT_REPO.
  assert.match(join, /foreach \(\$s in @\('REPO', 'UNKNOWN'\)\)/, "أولوية REPO ثم UNKNOWN ثم NOT_REPO");
  assert.match(idp, /if \(\$reach\.status -eq 'UNKNOWN' -and \$maybePrivileged\)/, "UNKNOWN مع صلاحية ⇒ حجب");
  assert.doesNotMatch(preSrc, /catch \{[^}]*New-Reach 'NOT_REPO'|New-Reach 'NOT_REPO' \('/, "لا NOT_REPO عند فشل أو سبب");
  for (const needle of ["PowerShell -EncodedCommand: payload cannot be inspected statically", "PowerShell -Command without a provable static target", "cmd invocation without a parsable /c command", "without a script target", "invocation without a static target", "arguments cannot be parsed unambiguously", "cannot be resolved statically"]) assert.ok(preSrc.includes(needle), `أمر مبهم ⇒ UNKNOWN: ${needle}`);
  // 3) Initialize لا ينجح بلا مهمة بوابة واحدة مطابقة.
  for (const needle of ["is not registered: Initialize requires exactly one validated gate task", "duplicate gate tasks", "gate task must run as the dedicated gate identity", "gate task identity not verifiable", "gate-like task conflicts", "gate task path is"]) assert.ok(idp.includes(needle), `مهمة البوابة إلزامية: ${needle}`);
  assert.match(idp, /\$why = Test-ExactGateAction \$Config \$gateTaskItem/, "Action مهمة البوابة يُفحص حرفياً دائماً");
  assert.match(idp, /\$named = @\(\$inventory \| Where-Object \{ \$_\.kind -eq 'task' -and \(\[string\]\$_\.name\) -eq \$gateTask \}\)\s+if \(\$named\.Count -eq 0\) \{ \$results \+= & \$block 'gate task'[^\n]*\n\s+elseif \(\$named\.Count -gt 1\) \{ \$results \+= & \$block 'gate task'/, "صفر أو أكثر من مهمة بوابة ⇒ حجب");
  assert.match(idp, /if \(-not \$gateTask\) \{ \$results \+= & \$block 'gate task' 'no gateTaskName configured' \}/);
  assert.match(body("Invoke-InstallPreflight"), /Invoke-GateIdentityPreflight \$Config/);
  assert.equal(cfg0.trust.gateTaskPath, "\\", "مسار مهمة البوابة المتوقع");
  assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /bootstrap/, "ترتيب التثبيت: مرحلة bootstrap قبل Initialize");
}
// Codex P1 (#285): جرد Startup/Logon ضمن تحليل الثقة، ومهمة البوابة Disabled + DryRun، وDeploy بانتقال مثبت.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const idp = body("Invoke-GateIdentityPreflight"), inv = body("Get-PreflightStartupInventory");
  // الجرد لا يرجع إلى Tasks+Services فقط.
  assert.match(idp, /\$inventory \+= @\(Get-PreflightStartupInventory \| ForEach-Object \{ \$_ \| Add-Member -NotePropertyName kind -NotePropertyValue 'startup'/, "Startup/Logon ضمن الجرد");
  assert.match(idp, /cannot enumerate startup\/logon sources/, "فشل جرد Startup ⇒ حجب");
  assert.match(idp, /if \(\$item\.kind -eq 'task' -or \$item\.kind -eq 'startup'\) \{\s+\$reach = Resolve-TaskReach/, "عناصر Startup بالنموذج الثلاثي نفسه");
  assert.match(idp, /\$item\.unreadable\) \{ \$reach = New-Reach 'UNKNOWN'/, "مصدر Startup غير مقروء ⇒ UNKNOWN");
  for (const needle of ["CommonStartup", "Microsoft\\Windows\\CurrentVersion\\Run", "RunOnce", "WOW6432Node", "ProfileList", "HKEY_USERS", "user registry hive is not loaded", "AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"]) assert.ok(inv.includes(needle), `مصدر Startup/Logon: ${needle}`);
  assert.doesNotMatch(inv, /reg(\.exe)? load|Set-ItemProperty|New-ItemProperty|Remove-Item/i, "جرد Startup قراءة فقط");
  assert.match(body("Get-StartupFolderItems"), /catch \{ return @\(New-StartupItem [^\n]*startup folder cannot be read/, "مجلد Startup غير مقروء ⇒ عنصر UNKNOWN");
  assert.match(preSrc, /\$script:AnyLogonSid = 'S-1-5-32-544'/, "مصادر الجهاز تعمل لأي مستخدم منهم المدراء");
  // مهمة البوابة أثناء Initialize: Disabled و-Mode DryRun حرفياً.
  assert.match(idp, /if \(-not \$gstate\) \{ \$results \+= & \$block \$gsub 'gate task enabled\/disabled state cannot be read' \}\s+elseif \(\$gstate -ne 'Disabled'\) \{ \$results \+= & \$block \$gsub \('gate task must be Disabled during Initialize/, "مهمة غير Disabled أو حالة غير مقروءة ⇒ حجب");
  assert.match(idp, /gate task enabled\/disabled state cannot be read/);
  const exact = body("Test-ExactGateAction");
  assert.match(exact, /if \(\$modes\.Count -eq 0\) \{ return 'missing -Mode \(script default is Deploy\)/, "غياب Mode ⇒ رفض");
  assert.match(exact, /if \(\$modes\.Count -gt 1\) \{ return \('-Mode given more than once/, "Mode مكرر ⇒ رفض");
  assert.match(exact, /if \(\$modes\[0\] -cne 'DryRun' -and \$modes\[0\]\.ToLowerInvariant\(\) -ne 'dryrun'\) \{ return/, "Mode غير DryRun ⇒ رفض");
  assert.match(exact, /the gate task must be registered with exactly -Mode DryRun/);
  assert.doesNotMatch(exact, /@\('deploy', 'dryrun'\)/, "لا قبول لـDeploy أثناء Initialize");
  assert.match(body("Get-PreflightTaskInventory"), /state = \[string\]\$t\.State/, "الجرد يحمل حالة المهمة");
  // Deploy لا يُسمح بمجرد Initialize: انتقال مثبت بـ24 ساعة DryRun كاملة من سجل التدقيق.
  const gt = gateSrc.slice(gateSrc.indexOf("function Test-DeployTransition"), gateSrc.indexOf("\nfunction ", gateSrc.indexOf("function Test-DeployTransition") + 10));
  assert.match(gateSrc, /if \(\$GateMode -eq 'Deploy'\) \{\s+\$notReady = Test-DeployTransition \$Config \$paths\s+if \(\$notReady\) \{ return Complete-Gate \$paths \$record 'STOP'/, "Deploy بلا انتقال مثبت ⇒ STOP");
  for (const needle of ["deploy transition not established", "[Math]::Max(24,", "must start after a successful Initialize", "non-successful or non-DryRun", "gap of", "ends in the future", "no recorded owner approval"]) assert.ok(gt.includes(needle), `إثبات DryRun: ${needle}`);
  assert.match(gateSrc, /if \(\$Result -ne 'NOOP' -or \$Record\.mode -eq 'DryRun'\) \{ Write-AuditRecord/, "كل تشغيل DryRun يُدقَّق");
  assert.ok(cfg0.trust.trustFiles.includes("deploy-transition.json") && !cfg0.trust.requiredTrustFiles.includes("deploy-transition.json"), "ملف الانتقال ملف ثقة وليس شرطاً لـInitialize");
  assert.ok(cfg0.dryRunSoak && cfg0.dryRunSoak.hours >= 24, "سياسة 24 ساعة كاملة");
  const doc = read("docs/ai/topics/windows-deploy-gate.md");
  for (const needle of ["**BOOTSTRAP**", "**INITIALIZE**", "**DRYRUN**", "**DEPLOY**", "حالة الانتقال: غير منفَّذ", "OZK-Tobacco-Server.vbs"]) assert.ok(doc.includes(needle), `توثيق: ${needle}`);
}
// Codex P1 (#285): الغلاف المفقود/غير المقروء/الفارغ ⇒ UNKNOWN، وACL المجلد الأب جزء إلزامي من الثقة.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const reader = body("Read-PreflightWrapperText"), wrap = body("Get-WrapperReach"), acl = body("Test-GateTrustAcl");
  assert.match(reader, /if \(-not \(Test-Path -LiteralPath \$Path -PathType Leaf\)\) \{ return \$null \}/, "غلاف مفقود ⇒ $null لا نص فارغ");
  assert.doesNotMatch(reader, /return ''|catch/, "فشل القراءة لا يتحول إلى نص فارغ صالح");
  assert.match(wrap, /try \{ \$inner = Read-PreflightWrapperText \(\[string\]\$pc\.final\) \} catch \{ return \(New-Reach 'UNKNOWN'/, "فشل القراءة ⇒ UNKNOWN");
  assert.match(wrap, /if \(\$null -eq \$inner\) \{ return \(New-Reach 'UNKNOWN' \('wrapper is missing/, "غلاف مفقود ⇒ UNKNOWN");
  assert.match(wrap, /if \(\$inner\.Length -eq 0\) \{ return \(New-Reach 'UNKNOWN' \('wrapper is empty \(zero bytes\)/, "غلاف بطول صفر ⇒ UNKNOWN");
  assert.match(body("Get-GateParentPath"), /LastIndexOf\(\$Sep\)/);
  assert.match(acl, /\$parent = Get-GateParentPath \$dir \$sep[\s\S]*if \(-not \$parent\) \{ \$results \+= & \$block [^\n]*'gateDir has no parent container whose ACL can be verified' \}\s+else \{ \$targets \+= \$parent \}\s+\$targets \+= \$dir/, "ACL المجلد الأب ضمن الأهداف إلزامياً");
  assert.match(acl, /if \(\$path -eq \$parent\) \{ \$subject = 'acl parent '/);
  assert.match(acl, /catch \{ \$results \+= & \$block \$subject \('cannot read ACL: '/, "تعذّر قراءة ACL (ومنها الأب) ⇒ حجب");
  assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /المجلد الأب المباشر/);
}
// Codex P1 (#285): سلسلة الأسلاف حتى مرسى الثقة — لا اكتفاء بـgateDir والأب المباشر.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const acl = body("Test-GateTrustAcl"), anc = body("Get-AncestorReplacementFindings"), lv = body("Get-GateAncestorLevels");
  assert.match(acl, /if \(-not \$anchor\) \{ \$results \+= & \$block 'acl ancestors' 'no trust anchor configured/, "مرسى الثقة إلزامي");
  assert.match(acl, /\$levels = Get-GateAncestorLevels \$parent \$anchor \$sep\s+if \(\$null -eq \$levels\) \{ \$results \+= & \$block/, "مرسى غير سلف ⇒ حجب");
  assert.match(acl, /foreach \(\$lv in @\(\$levels\)\) \{\s+try \{ \$lacl = Get-PreflightAcl \$lv \} catch \{ \$results \+= & \$block [^\n]*'cannot read ACL: '/, "كل مستوى سلف يُقرأ، والفشل ⇒ حجب");
  assert.match(acl, /Get-AncestorReplacementFindings \$lv \$lacl \$approved/);
  assert.match(acl, /\$approved = @\(\$gateSid, 'S-1-5-18', 'S-1-5-32-544', \$script:TrustedInstallerSid\)/, "ثقة إدارة النظام محددة صراحة");
  assert.match(acl, /if \(@\(\$memberSids \| Where-Object \{ -not \$_ \}\)\.Count -eq 0\) \{ \$approved \+= \$memberSids \}/, "عضوية غير محسومة لا تعتمد أحداً");
  assert.match(preSrc, /\$script:ReplaceRightsMask = 64 -bor 65536 -bor 262144 -bor 524288/, "حقوق الاستبدال: حذف الأبناء، Delete، WRITE_DAC، WRITE_OWNER");
  assert.match(anc, /0x10000000/, "GENERIC_ALL قدرة استبدال");
  assert.match(anc, /if \(\$ace\.PSObject\.Properties\['inheritOnly'\] -and \[bool\]\$ace\.inheritOnly\) \{ continue \}/);
  assert.match(anc, /if \(\$type -eq 'Deny'\) \{ continue \}\s+if \(\$type -ne 'Allow'\) \{ \$out \+= /, "Deny لا يُحتسب حماية، ونوع غير معروف ⇒ حجب");
  for (const needle of ["ACL is empty or unreadable", "owner cannot be resolved to a SID", "implicit WRITE_DAC", "rights cannot be interpreted", "cannot be resolved to a SID"]) assert.ok(anc.includes(needle), `سلف: ${needle}`);
  assert.doesNotMatch(anc + lv, /ToLowerInvariant\(\)\s*-(eq|ne)\s*\$gate|Get-AccountLeafName/, "لا مقارنة أسماء حسابات");
  assert.match(body("Get-PreflightAcl"), /inheritOnly = \(\(\$_\.PropagationFlags -band \[System\.Security\.AccessControl\.PropagationFlags\]::InheritOnly\) -ne 0\)/);
  assert.equal(cfg0.trust.trustAnchor, "C:\\ProgramData", "مرسى الثقة الحالي");
  assert.ok(cfg0.gateDir.toLowerCase().startsWith(cfg0.trust.trustAnchor.toLowerCase() + "\\"), "gateDir تحت مرسى الثقة");
  // الحارس المستقل الذي يبرّر ثقة إدارة النظام على الأسلاف يبقى قائماً.
  assert.match(preSrc, /privileged repository workload: runs repo code as/);
  const doc = read("docs/ai/topics/windows-deploy-gate.md");
  for (const needle of ["مرسى الثقة", "ثقة إدارة النظام", "ثقة repo workloads المؤتمتة", "أب مخصّص"]) assert.ok(doc.includes(needle), `توثيق الأسلاف: ${needle}`);
}
// Codex P1 (#285): مهام GroupId ليست هوية تنفيذ — GROUP + REPO/UNKNOWN ⇒ حجب، وRunLevel ضمن الجرد.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const inv = body("Get-PreflightTaskInventory"), idp = body("Invoke-GateIdentityPreflight");
  assert.doesNotMatch(inv, /if \(-not \$id\) \{ \$id = \[string\]\$t\.Principal\.GroupId \}/, "GroupId لا يُعامل كـUserId");
  assert.match(inv, /if \(\$uid -and -not \$gid -and \(\[string\]\$t\.Principal\.LogonType\) -ne 'Group'\) \{ \$ptype = 'USER' \}\s+elseif \(\$gid -and -not \$uid\) \{ \$ptype = 'GROUP' \}/, "نوع الـprincipal صريح من تعريف المهمة");
  assert.match(inv, /'Limited' \{ \$rl = 'LeastPrivilege' \} 'Highest' \{ \$rl = 'HighestAvailable' \}/, "RunLevel مُلتقط");
  assert.match(inv, /principalType = \$ptype; userId = \$uid; groupId = \$gid; runLevel = \$rl/, "RunLevel لا يسقط من الجرد");
  assert.match(idp, /if \(\$item\.kind -eq 'task' -and \$ptype -eq 'GROUP'\) \{[\s\S]*?elseif \(\$reach\.status -eq 'REPO'\) \{ \$results \+= & \$block[\s\S]*?elseif \(\$reach\.status -eq 'UNKNOWN'\) \{ \$results \+= & \$block[\s\S]*?continue\s+\}/, "GROUP + REPO/UNKNOWN ⇒ حجب قبل أي حكم بامتياز SID المجموعة");
  assert.ok(idp.indexOf("$ptype -eq 'GROUP'") < idp.indexOf("$maybePrivileged ="), "قاعدة المجموعة تسبق تقييم امتياز الـSID");
  assert.match(idp, /if \(\$runLevel -ne 'LeastPrivilege' -and \$runLevel -ne 'HighestAvailable'\) \{ \$results \+= & \$block [^\n]*unreadable RunLevel/, "RunLevel غير مقروء مع مجموعة ⇒ حجب");
  assert.match(idp, /HighestAvailable'\) \{ ': a member administrator runs elevated' \}/, "HighestAvailable يظهر صراحة في السبب");
  assert.match(idp, /if \(\$item\.kind -eq 'task' -and \$ptype -ne 'USER'\) \{\s+if \(\$reach\.status -ne 'NOT_REPO'\) \{ \$results \+= & \$block/, "نوع principal غير محسوم + REPO/UNKNOWN ⇒ حجب");
  assert.match(idp, /\$ptype = if \(\$item\.PSObject\.Properties\['principalType'\] -and \$item\.principalType\) \{ \[string\]\$item\.principalType \} else \{ 'UNKNOWN' \}/, "مهمة بلا نوع ⇒ UNKNOWN لا USER");
  assert.match(idp, /if \(\$gptype -ne 'USER'\) \{ \$results \+= & \$block \$gsub \('gate task principal must be the dedicated USER identity/, "GroupId غير مقبول لمهمة البوابة");
  assert.match(idp, /workloads = @\(\$workloads\)/, "سجل تدقيق لكل عنصر");
  assert.match(gateSrc, /\$record\['preflight_workloads'\] = Format-PreflightWorkloads \$pre/, "Initialize يدقّق نتائج الجرد");
  assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /GroupId/);
}
// Codex P1 (#285): الاحتواء بهوية المسار في نظام الملفات (junction/symlink/8.3)، لا بالنص وحده.
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  assert.ok(!preSrc.includes("function Test-InRepoRoot") && !preSrc.includes("Test-FieldReachesRepo"), "لا مقارنة احتواء نصية وحدها");
  const callers = [...preSrc.matchAll(/^function ([\w-]+)[\s\S]*?(?=^function |(?![\s\S]))/gm)].filter((m) => /Test-KeyInRoots /.test(m[0])).map((m) => m[1]).sort();
  assert.deepEqual(callers, ["Get-FieldReach", "Get-PathContainment"], "Test-KeyInRoots يُستدعى من قرار الاحتواء المركزي والفحص النصي الإيجابي فقط");
  assert.match(body("Test-KeyInRoots"), /\$Key -eq \$root -or \$Key\.StartsWith\(\$root \+ '\\'\)/, "حدود المسار: C:\\repo2 ليس داخل C:\\repo");
  const ctx = body("New-ReachContext"), pc = body("Get-PathContainment"), res = body("Resolve-PreflightFinalPath");
  assert.match(ctx, /\$rr = Resolve-PreflightFinalPath \(\[string\]\$root\)[\s\S]*else \{ \$rootErrors \+= /, "جذور المستودع تُحلّ في نظام الملفات ولا تسقط بصمت");
  assert.match(pc, /if \(@\(\$Ctx\.rootErrors\)\.Count -gt 0\) \{ return \[pscustomobject\]@\{ state = 'UNKNOWN'/, "جذر غير محلول ⇒ UNKNOWN");
  assert.match(pc, /if \(\$MustExist\) \{ return \[pscustomobject\]@\{ state = 'UNKNOWN'/, "هدف مفقود ⇒ UNKNOWN");
  assert.match(pc, /return \[pscustomobject\]@\{ state = 'UNKNOWN'; final = ''; reason = \('filesystem identity cannot be resolved: '/, "فشل الحل ⇒ UNKNOWN لا OUT");
  assert.match(pc, /Test-KeyInRoots \(ConvertTo-CanonicalTracePath \(\[string\]\$r\.path\)\) \$all/, "المرشّح بمساره النهائي مقابل الجذور النهائية");
  assert.match(res, /\[OzkGateFs\.FinalPath\]::Resolve\(\$cur, \[ref\]\$e2\)/);
  assert.match(res, /return \(New-PathResolution 'ERROR' '' \('the final path of ' \+ \$kind/, "reparse مكسور ⇒ ERROR");
  assert.match(preSrc, /CreateFileW\(path, 0, 7, IntPtr\.Zero, 3, 0x02000000, IntPtr\.Zero\)/, "يتبع reparse points (بلا FILE_FLAG_OPEN_REPARSE_POINT)");
  const fpCalls = [...preSrc.matchAll(/GetFinalPathNameByHandleW\(h, sb, \(uint\)sb\.Capacity, (\w+)\)/g)].map((m) => m[1]);
  assert.ok(fpCalls.length === 2 && fpCalls.every((f) => f === "0"), "كل استدعاء بـFILE_NAME_NORMALIZED: أسماء طويلة لا 8.3");
  assert.match(body("Get-ActionReach"), /\$pc = Get-PathContainment \$Ctx \$wd \$true[\s\S]*else \{ \$wd = ConvertTo-CanonicalTracePath \(\[string\]\$pc\.final\) \}/, "مجلد العمل يُحلّ قبل الأهداف النسبية");
  assert.match(body("Get-WrapperReach"), /\$pc = Get-PathContainment \$Ctx \$Path \$true[\s\S]*Read-PreflightWrapperText \(\[string\]\$pc\.final\)/, "الغلاف يُحلّ قبل قراءته واحتوائه");
  assert.match(body("Get-TargetReach"), /\$pc = Get-PathContainment \$Ctx \$p \$true/);
  assert.match(body("Invoke-GateIdentityPreflight"), /\('repository root ' \+ \$root\) \('cannot be canonicalized to an existing final filesystem path/, "جذر لا يُحلّ ⇒ حجب");
  assert.match(checkWfRaw(), /tools\\tests\\Test-GatePathIdentity\.ps1/, "اختبار junctions حقيقية مسجّل في CI (5.1)");
  const pid = read("tools/tests/Test-GatePathIdentity.ps1");
  for (const needle of ["New-Item -ItemType Junction", "Add-Skip", "ShortPath", "SymbolicLink", "[IO.Directory]::Delete($l)"]) assert.ok(pid.includes(needle), `اختبار الهوية: ${needle}`);
  assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /GetFinalPathNameByHandleW/);
}
// Codex P1 (#285): أهداف تنفيذ محسوبة داخل الأغلفة ⇒ UNKNOWN (تحليل ساكن، بلا تقييم ولا تنفيذ).
{
  const body = (n) => { const i = preSrc.indexOf(`function ${n}`); assert.ok(i >= 0, n); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
  const wrap = body("Get-WrapperReach"), wd = body("Get-WrapperDynamicReach"), ps = body("Get-PsDynamicExecution"), sc = body("Get-ScriptDynamicExecution");
  assert.match(wrap, /\$dr = Get-WrapperDynamicReach \$Ctx \(\[string\]\$pc\.final\) \$inner \$depth\s+if \(\$dr\.status -eq 'REPO'\) \{ return \$dr \}\s+\$r = Join-Reach \$r \$dr/, "كل غلاف يمرّ بكاشف التنفيذ الديناميكي، وUNKNOWN لا يُطوى");
  assert.match(wd, /if \(\$why\) \{ return \(New-Reach 'UNKNOWN'/, "سبب ديناميكي ⇒ UNKNOWN");
  assert.match(ps, /\[System\.Management\.Automation\.Language\.Parser\]::ParseInput/, "PowerShell يُحلَّل بشجرته (بلا تنفيذ)");
  assert.match(ps, /if \(@\(\$errs\)\.Count -gt 0\) \{ return /, "نص PowerShell غير قابل للتحليل ⇒ UNKNOWN");
  assert.match(ps, /if \(\$op -eq 'Ampersand' -or \$op -eq 'Dot'\) \{\s+if \(-not \(Test-PsLiteralAst \$first\)\) \{ return /, "& و. بهدف غير حرفي ⇒ UNKNOWN");
  assert.match(ps, /if \(-not \(Test-PsLiteralAst \$fp\)\) \{ return \(\$name \+ ' with a dynamic target: '/, "Start-Process بهدف محسوب ⇒ UNKNOWN");
  assert.match(ps, /-not \(\$bound\['ScriptBlock'\]\.Value -is \[System\.Management\.Automation\.Language\.ScriptBlockExpressionAst\]\)\) \{ return /, "Invoke-Command بكتلة محسوبة ⇒ UNKNOWN");
  assert.match(ps, /'invoke', 'invokereturnasis', 'invokescript', 'newscriptblock'/, "استدعاءات .Invoke/InvokeScript ⇒ UNKNOWN");
  assert.match(sc, /if \(\$arg -notmatch \$lit\) \{ return \('\.' \+ \$m\.Groups\[1\]\.Value \+ ' with a computed command: '/, "VBS Run/Exec بهدف غير حرفي ⇒ UNKNOWN");
  assert.match(sc, /\\\.\(Run\|Exec\|ShellExecute\)/, "Run/Exec/ShellExecute مغطاة");
  assert.match(sc, /\(call\|start\)\\s\+[^\n]*return \('call\/start with a variable target: '/, "cmd call/start بمتغير ⇒ UNKNOWN");
  assert.match(sc, /call set \(double expansion/);
  assert.match(sc, /for-loop runs a command taken from data/);
  assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /StaticParameterBinder/);
}
// Codex P1: قرارات الثقة بالـSID حصراً — لا عودة لمقارنة الاسم بعد حذف بادئة الجهاز/المجال.
assert.ok(!preSrc.includes("ConvertTo-IdentityKey"), "مفتاح الهوية بالاسم محذوف نهائياً");
const fnBody = (name) => { const i = preSrc.indexOf(`function ${name}`); assert.ok(i >= 0, name); const j = preSrc.indexOf("\nfunction ", i + 10); return preSrc.slice(i, j < 0 ? undefined : j); };
for (const fn of ["Test-GateTrustAcl", "Invoke-GateIdentityPreflight"]) {
  const body = fnBody(fn);
  assert.match(body, /Resolve-PrincipalSid/, `${fn} يحلّ الهويات إلى SID`);
  assert.doesNotMatch(body, /LastIndexOf\(|Get-AccountLeafName|\.Split\(|-split\s*'\\\\'|ToLowerInvariant\(\)\s*-(eq|ne)/, `${fn} لا يقارن أسماء الحسابات`);
}
assert.match(fnBody("Resolve-PrincipalSid"), /Invoke-NtAccountTranslate/);
assert.match(fnBody("Get-PreflightAcl"), /GetOwner\(\$sidType\)[\s\S]*GetAccessRules\(\$true, \$true, \$sidType\)/, "ACL تُقرأ بالـSID مباشرة");
const leafUsers = [...preSrc.matchAll(/Get-AccountLeafName \$/g)].length;
assert.equal(leafUsers, 1, "اسم الحساب الأخير لمسار ملف التعريف فقط");
assert.ok(cfg0.trust.gateAccount.includes("\\") || /^S-1-/i.test(cfg0.trust.gateAccount), "هوية البوابة مؤهَّلة بالجهاز أو SID");
assert.ok(preSrc.includes("gate identity must be machine-qualified"), "اسم بلا بادئة مرفوض");
for (const needle of ["function Test-GateTrustAcl", "function Get-PreflightAcl", "Get-Acl -LiteralPath $Path -ErrorAction Stop", "cannot read ACL", "owner is ", "rights cannot be interpreted", "write-granting ACE with an unresolvable identity", "required trust file is missing"]) assert.ok(preSrc.includes(needle), `ACL الفعلية: ${needle}`);
assert.match(preSrc, /\$c = Test-GateTrustAcl \$Config/, "فحص التثبيت يشمل ACL الفعلية");
assert.equal(cfg0.trust.gateInterpreter, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
assert.equal(cfg0.trust.gateScript, "deploy-gate.ps1");
for (const f of ["tools\\tests\\Test-GateTrustAcl.ps1"]) assert.ok(checkWfRaw().includes(f), `مسجّل في CI: ${f}`);
for (const needle of ["function Get-PreflightAdminMembers", "privileged repository workload", "member of local Administrators", "cannot determine whether", "cannot enumerate tasks/services"]) assert.ok(preSrc.includes(needle), `حارس الصلاحيات: ${needle}`);
assert.match(preSrc, /if \(\$key -eq 'S-1-5-18' -or \$key -eq 'S-1-5-32-544'\)/, "repo workload بحساب SYSTEM/Administrators يحجب بغض النظر عن الكتّاب");
assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /لا يجوز لأي repo workload مؤتمت أن يعمل بحساب\s+SYSTEM أو Local Administrator/);
assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /التثبيت BLOCKED/);
assert.match(read("docs/ai/topics/windows-deploy-gate.md"), /least-privilege/);
assert.match(checkWfRaw(), /tools\\tests\\Test-GateIdentityPreflight\.ps1/);
// لا توصية بـSYSTEM هويةً للبوابة في أي مرجع إنتاجي.
for (const f of ["docs/ai/topics/windows-deploy-gate.md", "tools/deploy-gate/README.md", "tools/deploy-gate/gate-config.example.json", "tools/deploy-gate/deploy-gate.ps1"]) {
  const src = read(f);
  assert.doesNotMatch(src, /"gateAccount":\s*"(SYSTEM|NT AUTHORITY\\\\SYSTEM|OZKSync|LOQ)"/i, `${f}: gateAccount غير مخصّص`);
  assert.doesNotMatch(src, /Windows Deploy Gate[^\n]{0,40}\((SYSTEM)\)|تعمل بحساب \*\*SYSTEM\*\*|كتابته لـ \*\*SYSTEM وAdministrators فقط\*\*|Administrators\/SYSTEM فقط/, `${f} يوصي بـSYSTEM/Administrators حاجزاً`);
}
for (const f of ["state.json", "audit.jsonl", "writer-allowlist.json", "deploying.flag", "gate-config.json", "deploy-gate.ps1", "run-repo-task.ps1"]) assert.ok(trust.trustFiles.includes(f), `ملف ثقة: ${f}`);
assert.ok(cfg0.logDir && !cfg0.logDir.toLowerCase().startsWith(cfg0.gateDir.toLowerCase() + "\\") && cfg0.logDir.toLowerCase() !== cfg0.gateDir.toLowerCase(), "logDir خارج gateDir");
const launcherCode = read("tools/deploy-gate/run-repo-task.ps1").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const launcherWrites = [...launcherCode.matchAll(/(WriteAllText|AppendAllText|WriteAllBytes|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)[^\n]*/g)].map((m) => m[0]);
assert.ok(launcherWrites.length >= 1);
for (const w of launcherWrites) assert.ok(/\$LogDir/.test(w), `المشغّل يكتب خارج logDir: ${w}`);
assert.doesNotMatch(launcherCode, /Join-Path \$gateDir 'launcher\.log'/);
for (const f of ["writer-allowlist.json", "deploying.flag", "state.json"]) {
  for (const m of launcherCode.matchAll(new RegExp(`[^\\n]*${f.replace(".", "\\.")}[^\\n]*`, "g"))) assert.doesNotMatch(m[0], /Write|Set-Content|Remove-Item|Move-Item|Out-File/, `المشغّل لا يكتب ${f}`);
}
const gatePathsFn = gateSrc.slice(gateSrc.indexOf("function Get-GatePaths"), gateSrc.indexOf("function Write-GateLog"));
for (const f of ["state.json", "audit.jsonl", "writer-allowlist.json", "deploying.flag", "deploy-gate.log", "deploy-gate.lock"]) assert.match(gatePathsFn, new RegExp(`Join-Path \\$Config\\.gateDir '${f.replace(".", "\\.")}'`), `ملف الثقة ${f} تحت gateDir`);
assert.doesNotMatch(gateSrc, /(WriteAllText|AppendAllText|Set-Content|Out-File)\s*\(?\s*\(?\s*Join-Path \$Config\.repoPath/, "البوابة لا تكتب داخل المستودع إلا عبر git");
const notifySrc = read("tools/deploy-gate/notify.ps1");
assert.doesNotMatch(notifySrc, /WriteAllText|AppendAllText|Set-Content|Out-File|Remove-Item/, "notify.ps1 قراءة فقط");
const doc = read("docs/ai/topics/windows-deploy-gate.md");
assert.match(doc, /حدود الثقة لهوية البوابة/);
assert.match(doc, /Dedicated Gate Identity/);
assert.match(doc, /ليست حماية من مدير بشري خبيث/);
assert.match(doc, /24 ساعة كاملة/);
assert.match(doc, /88ae841c6696bef2cbe75579039b215396972a6e/);
assert.match(doc, /مصدره غير متحقَّق/);
assert.match(doc, /windows-production-integrity/);
assert.match(read("tools/deploy-gate/migration-preflight.ps1"), /\$taskState -ceq 'Disabled'/, "Disabled حرفياً من Task Scheduler وحده");
// وجود الـSHA على windows-production ليس موافقة: البوابة تشترط Deployment للهدف نفسه وCI قبل الدمج.
const deployFlow = gateSrc.slice(gateSrc.indexOf("function Invoke-DeployGate"), gateSrc.indexOf("function Invoke-GateRollback"));
const idx = (needle) => { const i = deployFlow.indexOf(needle); assert.ok(i >= 0, `مفقود في مسار النشر: ${needle}`); return i; };
assert.ok(idx("Get-ReleaseApproval $Config $target") < idx("'merge', '--ff-only'"), "الموافقة تُفحص قبل الدمج");
assert.ok(idx("Get-CiVerdict $Config $target") < idx("'merge', '--ff-only'"), "CI يُفحص قبل الدمج");
assert.ok(idx("if (-not $ci.ok)") < idx("'merge', '--ff-only'") && idx("if (-not $approval.ok)") < idx("'merge', '--ff-only'"));
assert.match(gateSrc, /\[string\]\$payload\.sha -ne \$Sha\) \{ continue \}/, "الموافقة للـSHA الهدف نفسه بالضبط");
assert.match(doc, /ليست ضماناً كافياً وحدها/);
assert.match(doc, /VERSION ID DRIFT/);
assert.match(doc, /20260928140000/);
assert.match(doc, /20260928145121/);
assert.match(doc, /ACTION TAKEN: NONE/);
assert.match(doc, /خط الأساس الحالي على الجهاز `88ae841`/);
assert.doesNotMatch(doc, /متجمّد على `1812c08`/, "الحالة الحالية لا تدّعي 1812c08");
ok("حدود الثقة: هوية بوابة مخصّصة وحدها تكتب ملفات الثقة (SYSTEM/OZKSync/LOQ/Administrators مرفوضة)، والمشغّل يكتب سجله في logDir فقط؛ والتوثيق يسجّل خط الأساس وحماية الفرع وDryRun 24 ساعة");

// 2) الـworkflow
const wf = read(".github/workflows/windows-release.yml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const onBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
assert.match(onBlock, /workflow_dispatch:/);
assert.doesNotMatch(onBlock, /\bpush:|\bpull_request|\bschedule:|workflow_run/, "لا تشغيل تلقائي");
const releaseJob = wf.slice(wf.indexOf("\n  release:"));
assert.match(releaseJob, /environment: windows-production/);
assert.match(releaseJob, /needs: verify/);
assert.doesNotMatch(wf, /--force|push -f\b|\+refs\/heads|:\+/);
assert.match(releaseJob, /node scripts\/windows-release-apply\.mjs --verification windows-release\.json/);
const applySrc = read("scripts/windows-release-apply.mjs").split("\n").filter((l) => !l.trim().startsWith("//")).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");
assert.doesNotMatch(applySrc, /--force|"-f"|\+refs|reset|rebase/, "التقديم بلا force ولا reset ولا rebase");
assert.match(applySrc, /planPush\(/);
assert.match(applySrc, /neither the verified base/);
assert.doesNotMatch(wf, /run:[^\n]*\$\{\{\s*inputs\./, "المدخلات عبر env لا داخل run");
ok("الـworkflow يدوي، الموافقة تسبق الدفع، Fast-Forward بلا --force، والمدخلات عبر env");

// 3) البوابة
const gate = read("tools/deploy-gate/deploy-gate.ps1");
for (const token of ["'pull'", "'rebase'", "'--hard'"]) assert.ok(!gate.includes(token), `البوابة لا تمرّر ${token}`);
assert.ok(gate.includes("'merge', '--ff-only'"));
assert.ok(gate.includes("'reset', '--keep'"), "الرجوع اليدوي بـreset --keep");
assert.match(gate, /\$deployedResults = @\('OK', 'DEPLOYED_PENDING_RESTART'\)/, "الرجوع يقبل OK وDEPLOYED_PENDING_RESTART فقط (Codex P1 #6)");
assert.match(gate, /try \{ \$entry = \$line \| ConvertFrom-Json \} catch \{ continue \}/, "سطر تدقيق تالف لا يُسقط الرجوع ولا يُحتسب");
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
for (const f of ["tools/deploy-gate/deploy-gate.ps1", "tools/deploy-gate/run-repo-task.ps1", "tools/deploy-gate/notify.ps1", "tools/deploy-gate/migration-preflight.ps1", "tools/tests/Test-DeployGate.ps1", "tools/tests/Test-RunRepoTask.ps1", "tools/tests/Test-MigrationPreflight.ps1", "tools/tests/Test-GateIdentityPreflight.ps1", "tools/tests/Test-GateTrustAcl.ps1", "tools/tests/Test-GatePathIdentity.ps1"]) {
  const bytes = readFileSync(path.join(root, f));
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, `${f} يحمل BOM (5.1 يقرأ غيره ANSI)`);
}
ok("اختبارا 5.1 مسجّلان في CI وملفات البوابة تحمل BOM");

console.log(`check-windows-deploy-gate: اجتاز ${passed} عقود.`);
