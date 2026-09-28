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
assert.doesNotMatch(preSrc, /'-command'|'-encodedcommand'|'-c'|'-enc'/i, "لا مفتاح تنفيذ مضمَّن ضمن القائمة المسموحة");
// مكان المهمة لا يمنح استثناء: لا إعادة لاستثناء \Microsoft\ (أو أي TaskPath) من جرد الهويات.
const preCode = preSrc.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
assert.doesNotMatch(preCode, /TaskPath\s+-(not)?(like|match|eq)|\.TaskPath\s*-(not)?(like|match)|\\\\?Microsoft\\\\?\*/i, "لا استثناء لمهام حسب TaskPath (ومنها \\Microsoft\\)");
assert.match(preCode, /Get-ScheduledTask -ErrorAction Stop\)\)/, "جرد كل المهام بلا ترشيح");
for (const needle of ["function Resolve-WorkloadReach", "cannot determine whether this", "function Expand-UserProfileVariables", "function Expand-MachineVariables", "$depth -ge 3"]) assert.ok(preSrc.includes(needle), `تتبّع الأغلفة: ${needle}`);
for (const needle of ["function Test-GateTrustAcl", "function Get-PreflightAcl", "Get-Acl -LiteralPath $Path -ErrorAction Stop", "cannot read ACL", "owner is ", "rights cannot be interpreted", "write-granting ACE with an unresolvable identity", "required trust file is missing"]) assert.ok(preSrc.includes(needle), `ACL الفعلية: ${needle}`);
assert.match(preSrc, /\$c = Test-GateTrustAcl \$Config/, "فحص التثبيت يشمل ACL الفعلية");
assert.equal(cfg0.trust.gateInterpreter, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
assert.equal(cfg0.trust.gateScript, "deploy-gate.ps1");
for (const f of ["tools\\tests\\Test-GateTrustAcl.ps1"]) assert.ok(checkWfRaw().includes(f), `مسجّل في CI: ${f}`);
for (const needle of ["function Get-PreflightAdminMembers", "privileged repository workload", "member of local Administrators", "cannot determine whether", "cannot enumerate tasks/services"]) assert.ok(preSrc.includes(needle), `حارس الصلاحيات: ${needle}`);
assert.match(preSrc, /if \(\$key -eq 'system' -or \$key -eq 'administrators'\)/, "repo workload بحساب SYSTEM/Administrators يحجب بغض النظر عن الكتّاب");
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
for (const f of ["tools/deploy-gate/deploy-gate.ps1", "tools/deploy-gate/run-repo-task.ps1", "tools/deploy-gate/notify.ps1", "tools/deploy-gate/migration-preflight.ps1", "tools/tests/Test-DeployGate.ps1", "tools/tests/Test-RunRepoTask.ps1", "tools/tests/Test-MigrationPreflight.ps1", "tools/tests/Test-GateIdentityPreflight.ps1", "tools/tests/Test-GateTrustAcl.ps1"]) {
  const bytes = readFileSync(path.join(root, f));
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, `${f} يحمل BOM (5.1 يقرأ غيره ANSI)`);
}
ok("اختبارا 5.1 مسجّلان في CI وملفات البوابة تحمل BOM");

console.log(`check-windows-deploy-gate: اجتاز ${passed} عقود.`);
