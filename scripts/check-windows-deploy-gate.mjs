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
assert.deepEqual(comps.map((c) => c.name), ["TOBACCO Ameen Read Worker", "OZK-AmeenAutoPrint", "OZK-Tobacco-Server (scripts/serve.mjs)", "TOBACCO Ameen Invoice Agent"]);
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
// الدفعة د0: وكيل الفواتير عملية واحدة طويلة تحمّل مكتبتها مرة عند البدء.
for (const m of read("tools/ameen-invoice-event-agent.ps1").matchAll(/^\. \(Join-Path \$PSScriptRoot "([A-Za-z0-9_.-]+\.ps1)"\)/gm)) need("TOBACCO Ameen Invoice Agent", `tools/${m[1]}`);
need("TOBACCO Ameen Invoice Agent", "tools/ameen-invoice-event-agent.ps1");
need("TOBACCO Ameen Invoice Agent", "tools/ameen-invoice-events-lib.ps1");
const invoiceAgent = comps.find((c) => c.name === "TOBACCO Ameen Invoice Agent");
assert.equal(invoiceAgent.taskName, "TOBACCO Ameen Invoice Agent");
assert.match(invoiceAgent.runner, /never restarts it/, "الوكيل: إعادة التشغيل خارج البوابة");
assert.ok(!byName["TOBACCO Ameen Invoice Agent"].has("tools/ameen-invoice-agent-monitor.ps1"), "المراقب مهمة قصيرة، ليس عملية طويلة");
assert.deepEqual(affectedLongRunning(["tools/ameen-invoice-events-lib.ps1"], comps), ["TOBACCO Ameen Invoice Agent"]);
assert.ok(cfg0.pauseTasks.includes("TOBACCO Ameen Invoice Agent Monitor"), "مراقب الوكيل ضمن pauseTasks");
assert.ok(!cfg0.routingExempt.includes("TOBACCO Ameen Invoice Agent Monitor"), "مراقب الوكيل غير معفى من التوجيه: كوده من المستودع");
assert.ok(!cfg0.pauseTasks.includes("TOBACCO Ameen Invoice Agent"), "الوكيل لا يُنتظر خموله (لا ينتهي)، بل يُسجَّل للإعادة");
// البوابة والمشغّل لا يمرّران -Send ولا -StrictEnvFile ولا يلمسان ملف التفعيل أو الاتصال: نص الإعداد وصف فقط.
for (const src of [gateSrc, read("tools/deploy-gate/run-repo-task.ps1")]) {
  assert.doesNotMatch(src, /'-Send'|-Send\b(?!-)|StrictEnvFile|send-enabled\.flag|ameen-invoice-agent\.env/, "لا -Send ولا -StrictEnvFile ولا ملف اتصال في البوابة");
}
assert.ok(Object.keys(invoiceAgent).every((k) => ["name", "runner", "files", "untrackedFiles", "taskName"].includes(k)), "مكوّن الوكيل بلا وسائط تشغيل");
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
// تشخيص 2026-10-25: مزامنة النشرات متقاعدة (معطّلة منذ 2026-09-07، النشرات من generate-price-lists.yml)،
// فلا مهمة تحتاج main اليوم. الاستثناء محصور بهذه المهمة وحدها، ويشترط الفحص بقاءها معطّلة.
assert.deepEqual(cfg0.mainDependentTasks, [], "لا مهمة تحتاج main؛ أي إضافة تمرّ بمراجعة صريحة");
assert.deepEqual(cfg0.retiredMainTasks.map((t) => [t.task, t.script]), [["OZK-PriceListSync", "tools/auto-sync-price-lists.ps1"]], "الاستثناء المتقاعد لمزامنة النشرات وحدها");
for (const t of cfg0.retiredMainTasks) {
  assert.match(t.retiredOn, /^\d{4}-\d{2}-\d{2}$/, `${t.task}: تاريخ التقاعد مطلوب`);
  assert.ok(String(t.reason || "").length > 40, `${t.task}: تعليل التقاعد مطلوب`);
}
const sync = read("tools/auto-sync-price-lists.ps1");
assert.match(sync, /rev-parse --abbrev-ref HEAD/);
assert.match(sync, /\$currentBranch -ne "main"/, "حارس main في مزامنة النشرات لم يُخفَّف");
// أي سكربت يشترط الفرع main يجب أن يكون مهمة معلنة، أو مهمة متقاعدة معلنة، أو أداة يدوية مستثناة بتعليل.
const manualMainTools = { "tools/ai-work-coordination.ps1": "أداة يدوية لقفل AI على main، ليست مهمة مجدولة" };
const declared = new Set([...cfg0.mainDependentTasks, ...cfg0.retiredMainTasks].map((t) => t.script));
for (const f of readdirSync(path.join(root, "tools")).filter((n) => n.endsWith(".ps1")).map((n) => `tools/${n}`)) {
  const src = read(f);
  if (/(abbrev-ref HEAD|branch --show-current)/.test(src) && /-ne\s+["']main["']/.test(src)) {
    assert.ok(declared.has(f) || manualMainTools[f], `${f} يشترط main وليس معلناً في mainDependentTasks أو retiredMainTasks`);
  }
}
const pre = read("tools/deploy-gate/migration-preflight.ps1");
assert.match(pre, /task definition not visible/, "مهمة غير مرئية ⇒ حجب");
assert.match(pre, /outside its allow-list/, "لا باب خلفي عبر worktree الـmain");
assert.match(pre, /retired main task is enabled/, "مهمة متقاعدة مفعّلة ⇒ حجب");
assert.match(pre, /retired task not visible/, "مهمة متقاعدة غير مرئية ⇒ حجب");
assert.match(pre, /declared both main-dependent and retired/);
assert.match(pre, /function Get-PreflightTaskState[\s\S]{0,300}Get-ScheduledTask -TaskName/, "حالة المهمة قراءة فقط");
assert.match(pre, /main worktree must not be the operational repository/);
assert.match(gateSrc, /\$pre = Invoke-MigrationPreflight \$Config[\s\S]{0,400}migration preflight blocked/, "Initialize يرفض ما لم ينجح الفحص");
assert.match(checkWfRaw(), /tools\\tests\\Test-MigrationPreflight\.ps1/);
ok("لا مهمة تحتاج main؛ مزامنة النشرات متقاعدة ويجب أن تبقى معطّلة، والـworktree ليس باباً خلفياً، والتحويل محجوب حتى ينجح الفحص (Codex P1 #5)");

// تدقيق 2026-10-20: الثغرات الست، ومنع الرجوع، والتزامن، والنسخ الاحتياطي، والاستعادة.
assert.match(cfg0.deviceBaselineSha, /^[0-9a-f]{40}$/, "deviceBaselineSha = SHA كامل لما يشغّله الجهاز");
assert.match(gateSrc, /does not contain deviceBaselineSha/, "البوابة ترفض هدفاً أقدم من الجهاز");
assert.match(gateSrc, /is behind the device/, "Initialize يرفض فرعاً متأخراً عن الجهاز بدل التبديل إليه");
assert.match(read("scripts/windows-release-verify.mjs"), /assertNotOlderThanDevice\(ctx, sha, config\);/, "الـworkflow يرفض إصداراً أقدم من الجهاز قبل الموافقة");
assert.match(read("scripts/windows-release-apply.mjs"), /assertNotOlderThanDevice\(ctx, sha, config\);/, "ويعيد الرفض قبل الدفع");
// (a) الخادم المحلي الفعلي
const live = cfg0.liveServedFromRepo;
assert.equal(live.taskName, "TOBACCO Local Web Server");
assert.match(live.serverCode, /ProgramData\\OZK-TOBACCO\\LocalWebServer\\server\.mjs$/);
for (const p of ["index.html", "src/", "public/"]) assert.ok(live.paths.includes(p), `الخادم المحلي يخدم ${p} من المستودع`);
assert.match(gateSrc, /live_served_changed/);
// (b) مشغّل الطباعة الحقيقي
const autoprint = comps.find((c) => c.name === "OZK-AmeenAutoPrint");
assert.match(autoprint.runner, /LOGON/);
assert.doesNotMatch(autoprint.runner, /\(ONSTART\)/);
// (c) مهام النسخ الاحتياطي تستدعي سكربت التنبيه من المستودع
for (const t of ["OZK Ameen Verified Backup", "OZK Ameen Backup Health Monitor"]) {
  assert.ok(cfg0.pauseTasks.includes(t), `${t} ضمن pauseTasks`);
  assert.ok(cfg0.routingExempt.includes(t), `${t} معفاة من التوجيه (كودها مثبّت خارج المستودع)`);
}
for (const t of cfg0.routingExempt) assert.ok(cfg0.pauseTasks.includes(t), `routingExempt ⊆ pauseTasks: ${t}`);
assert.ok(!cfg0.routingExempt.includes("TOBACCO Ameen Sync") && !cfg0.routingExempt.includes("TOBACCO Approved Prices Pull"), "مهام المستودع لا تُعفى من التوجيه");
assert.ok(Number(cfg0.startGuardSeconds) >= 60);
// (d) worktree الـmain المنفصل يُسمّى صراحةً
assert.match(pre, /detached HEAD at/);
// (e) لا تبديل مع مهمة غير موجَّهة أو موعد قريب أو عملية git جارية، وإعادة الفحص بعد الانتظار
assert.match(gateSrc, /not routed through run-repo-task\.ps1/);
assert.match(gateSrc, /unrouted tasks about to start/);
assert.match(gateSrc, /git operation in progress/);
assert.match(gateSrc, /HEAD moved during the pause/);
// (f) مهمة غير مرئية لا تُعدّ متوقفة
assert.match(gateSrc, /not visible to the gate account \(run as SYSTEM\)/);
for (const name of ["TOBACCO Ameen Read Worker", "OZK-AmeenAutoPrint"]) assert.equal(comps.find((c) => c.name === name).taskName, name);
// سكربت مهمة يحذفه الإصدار
assert.match(gateSrc, /release removes scripts that scheduled tasks run/);
// قفل، نسخة احتياطية + SHA256، تحقق بعد التبديل، استعادة بلا git كاتب
assert.match(gateSrc, /function Enter-GateLock[\s\S]{0,200}'None'/);
assert.match(gateSrc, /New-DeployBackup[\s\S]{0,4000}Set-DeployFlag/, "النسخة الاحتياطية تسبق أي إيقاف أو تبديل");
assert.match(gateSrc, /Test-DeployedFiles/);
assert.match(gateSrc, /inflight\.json/);
const recover = gateSrc.slice(gateSrc.indexOf("function Invoke-GateRecover"), gateSrc.indexOf("function Invoke-GateAckRestart"));
assert.doesNotMatch(recover, /Invoke-GateGit \$Config @\('(reset|checkout|merge|clean|restore|stash)'/, "الاستعادة لا تستعمل أي أمر git كاتب");
assert.match(recover, /quarantine/, "الملف الناقص يُنقل ولا يُحذف");
// Codex P1 على #337: التراجع يُسجَّل في inflight.json قبل reset --keep، وRecover يكمله أو يتراجع عنه أو يتوقف.
assert.match(gateSrc, /Write-InflightRecord \$Paths 'Rollback'[\s\S]{0,300}\$reset = Invoke-GateReset/, "inflight.json يُكتب قبل reset --keep");
assert.match(gateSrc, /function Invoke-GateReset[\s\S]{0,120}'reset', '--keep'/);
assert.match(recover, /Read-InflightRecord/, "Recover يتحقق من السجل قبل أي مساس");
assert.match(recover, /interrupted rollback completed/);
assert.match(recover, /refusing to guess the state/, "سجل مفقود مع علم أو شجرة متّسخة = توقف");
assert.match(gateSrc, /outside the gate backups folder/);
assert.match(gateSrc, /backup manifest does not match inflight\.json/);
const rollbackSrc = gateSrc.slice(gateSrc.indexOf("function Invoke-GateRollback"), gateSrc.indexOf("function Complete-RollbackState"));
assert.match(rollbackSrc, /Get-TaskGuard[\s\S]{0,1200}New-DeployBackup/, "التراجع يمرّ بحارس المهام قبل أي نسخ أو reset");
assert.match(rollbackSrc, /Get-SwitchBlockers \$Config \$Head[\s\S]{0,2000}Invoke-GateReset/, "وإعادة الفحص بعد الانتظار قبل reset --keep");
assert.match(gateSrc, /\$running \+= \(\$name \+ ' \(not visible\)'\)/, "مهمة غير مرئية ليست خاملة في Wait-TasksIdle");
assert.match(gateSrc, /tasks started after the idle wait/, "مهمة بدأت بعد الانتظار تمنع التبديل");
const completeSrc = gateSrc.slice(gateSrc.indexOf("function Complete-RollbackState"), gateSrc.indexOf("function Invoke-GateUnpin"));
assert.match(completeSrc, /Save-GateState[\s\S]*Clear-DeployFlag[\s\S]*Close-InflightRecord/, "inflight.json يُزال آخراً بعد كتابة الحالة");
assert.doesNotMatch(recover, /Move-Item -LiteralPath \$Paths\.Inflight/, "Recover لا ينقل السجل قبل اكتمال الإنهاء");
assert.match(recover, /Get-TaskGuard[\s\S]*Wait-TasksIdle[\s\S]*Get-SwitchBlockers \$Config \$Head -AllowDirty[\s\S]*Copy-Item -LiteralPath \$copy/, "Recover يمرّ بحارس المهام والانتظار وإعادة الفحص قبل أي إعادة كتابة");
assert.match(gateSrc, /'git-index'/, "فهرس git يُنسخ احتياطياً قبل التبديل");
const completeDeploy = gateSrc.slice(gateSrc.indexOf("function Complete-DeployState"), gateSrc.indexOf("function Close-InflightRecord"));
assert.match(completeDeploy, /Save-WriterAllowlist[\s\S]*Save-GateState[\s\S]*Clear-DeployFlag[\s\S]*Close-InflightRecord/, "النشر يزيل inflight.json آخراً");
const deployTail = gateSrc.slice(gateSrc.indexOf("post-deploy file verification failed"), gateSrc.indexOf("function Invoke-GateRollback"));
assert.doesNotMatch(deployTail, /Remove-Item -LiteralPath \$paths\.Inflight/, "لا إزالة للسجل قبل الإنهاء في النشر");
assert.match(recover, /interrupted deploy completed/, "Recover يكمل نشراً حرّك HEAD بعد التحقق");
assert.match(recover, /indexSha256/, "Recover يعيد الفهرس بعد التحقق من بصمته");
ok("تدقيق 2026-10-20: لا إصدار أقدم من الجهاز، الثغرات الست (a–f)، قفل، نسخة احتياطية بـSHA256، تحقق بعد التبديل، واستعادة آمنة");

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
// الدفعة د0: سجل المشغّل خارج مجلد البوابة، شهري، والمشغّل لا ينشئ المجلد.
assert.match(launcher, /function Get-LauncherLogPath/);
assert.match(launcher, /'launcher-' \+ \$Now\.ToString\('yyyy-MM'/);
assert.match(launcher, /StartsWith\(\$gateFull \+ \$sep/, "سجل داخل مجلد البوابة مرفوض");
assert.doesNotMatch(launcher, /New-Item|CreateDirectory/, "المشغّل لا ينشئ مجلد السجل");
assert.doesNotMatch(launcher, /Write-LauncherLog \$gateDir/, "كل نداءات السجل تمرّر الإعداد");
const logDirWin = String(cfg0.launcherLogDir || "").toLowerCase();
const gateDirWin = String(cfg0.gateDir || "").toLowerCase().replace(/\\+$/, "");
assert.ok(logDirWin && logDirWin !== gateDirWin && !logDirWin.startsWith(gateDirWin + "\\") && !gateDirWin.startsWith(logDirWin + "\\"), "launcherLogDir خارج gateDir");
const logAcl = read("tools/deploy-gate/set-launcher-log-acl.ps1");
assert.match(logAcl, /S-1-3-4/, "OWNER RIGHTS يلغي WRITE_DAC الضمني لمنشئ الملف");
assert.match(logAcl, /SetAccessRuleProtection\(\$true, \$false\)/);
assert.match(logAcl, /if \(-not \$DoApply\) \{[^}]*return 'PLAN'/, "بلا -Apply خطة فقط");
for (const v of ["LogWriterDirRights", "LogWriterFileRights", "LogOwnerRightsFile"]) {
  const m = logAcl.match(new RegExp(`\\$script:${v} = \\[System\\.Security\\.AccessControl\\.FileSystemRights\\]'([^']+)'`));
  assert.ok(m, `${v} معرّف`);
  for (const bad of ["FullControl", "Modify", "Delete", "DeleteSubdirectoriesAndFiles", "ChangePermissions", "TakeOwnership", "CreateDirectories", "Write"]) {
    assert.ok(!m[1].split(/,\s*/).includes(bad), `${v} لا يمنح ${bad}`);
  }
}
assert.ok(!/Set-Acl[^\n]*\$Gate\b/.test(logAcl), "سكربت السجل لا يغيّر صلاحيات مجلد البوابة");
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
assert.match(checkWf, /tools\\tests\\Test-LauncherLogAcl\.ps1/);
for (const f of ["tools/deploy-gate/deploy-gate.ps1", "tools/deploy-gate/run-repo-task.ps1", "tools/deploy-gate/notify.ps1", "tools/deploy-gate/migration-preflight.ps1", "tools/tests/Test-DeployGate.ps1", "tools/tests/Test-RunRepoTask.ps1", "tools/tests/Test-MigrationPreflight.ps1", "tools/deploy-gate/set-launcher-log-acl.ps1", "tools/tests/Test-LauncherLogAcl.ps1"]) {
  const bytes = readFileSync(path.join(root, f));
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, `${f} يحمل BOM (5.1 يقرأ غيره ANSI)`);
}
ok("اختبارا 5.1 مسجّلان في CI وملفات البوابة تحمل BOM");

console.log(`check-windows-deploy-gate: اجتاز ${passed} عقود.`);
