// ============================================================================
// «أحداث فواتير الأمين» — Ameen Invoice Event Sync، المرحلة 2 (غير مفعَّلة).
//
// قرار المالك (2026-10-20): المرحلة 2 فرع وPR Draft فقط؛ لا تفعيل ولا نشر ولا تغيير على مزامنة
// الإنتاج القائمة، والأمين قراءة فقط دائماً. تعديل فاتورة في الأمين يجب أن يحدّث الفاتورة نفسها
// في الموقع بلا تكرار.
//
// ثلاث طبقات:
//   ١) عقود ساكنة على الهجرة المقترحة والتراجع والوكيل والمكتبة (تعمل في كل مكان).
//   ٢) تشغيل حي لـ supabase/tests/ameen-invoice-events.sql على PostgreSQL محلي مؤقت: في CI إلزامي،
//      ومحلياً يُتخطى إن لم يوجد Postgres. نفس حارس المضيف ونمط check-price-sync-heartbeats-security.
//   ٣) اختبار PowerShell tools/tests/Test-AmeenInvoiceEvents.ps1 عبر pwsh إن وُجد (في CI إلزامي؛
//      وظيفة ps51-compat تشغّله أيضاً على Windows PowerShell 5.1).
// ============================================================================
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, "");
const migrationRel = "supabase/proposed/18-ameen-invoice-events.sql";
const rollbackRel = "supabase/proposed/18-ameen-invoice-events-rollback.sql";
const testRel = "supabase/tests/ameen-invoice-events.sql";
const agentRel = "tools/ameen-invoice-event-agent.ps1";
const libRel = "tools/ameen-invoice-events-lib.ps1";

// ── ١) عقود ساكنة ───────────────────────────────────────────────────────────────────────────
const migration = read(migrationRel);
const code = migration.replace(/--.*$/gm, "");
for (const table of ["ameen_invoices", "ameen_invoice_events"]) {
  assert.match(code, new RegExp(`create table if not exists public\\.${table} \\(`));
  assert.match(code, new RegExp(`alter table public\\.${table} enable row level security;`));
  assert.match(code, new RegExp(`alter table public\\.${table} force row level security;`));
  assert.match(code, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role;`),
    `${table}: لا كتابة مباشرة لأي دور، ولا حتى service_role`);
  assert.match(code, new RegExp(`grant select on table public\\.${table} to authenticated;`));
  assert.doesNotMatch(code, new RegExp(`grant\\s+(insert|update|delete|all)[^;]*${table}`, "i"), `${table}: لا منح كتابة`);
}
assert.match(code, /bill_guid\s+uuid primary key/, "صف واحد لكل فاتورة: bu000.GUID هو المفتاح");
assert.match(code, /event_id\s+text primary key/, "مفتاح الحدث يمنع التكرار");
assert.doesNotMatch(code, /create policy[^;]*for\s+(insert|update|delete|all)/i, "لا سياسة كتابة");
assert.match(code, /using \(\(select public\.is_staff\(\)\)\)/, "القراءة للموظفين فقط");
assert.match(code, /select coalesce\(\(select auth\.uid\(\)\) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid, false\);/,
  "هوية المزامنة المعتمدة نفسها");
assert.match(code, /security definer\s+set search_path = ''/);
assert.match(code, /if not public\.ameen_invoice_is_sync_writer\(\) then/);
assert.match(code, /errcode = '42501'/);
assert.doesNotMatch(code, /'service_role'/, "لا احتياط بمفتاح service_role");
assert.match(code, /\(v_at, v_seq\) <= \(v_cur\.source_event_at, v_cur\.source_seq\)/, "الحدث الأقدم stale ولا يطبَّق");
assert.match(code, /order by \(e ->> 'source_seq'\)::bigint/, "الدفعة تُعالج بترتيب التسلسل");
assert.match(code, /pg_advisory_xact_lock/, "قفل لكل فاتورة");
assert.match(code, /on conflict \(bill_guid\) do update/, "التعديل يحدّث الصف نفسه");
assert.match(code, /revision = t\.revision \+ 1/);
assert.match(code, /\(v_evt ->> 'bill_guid'\) \|\| '\|' \|\| \(v_evt ->> 'source_seq'\) \|\| '\|' \|\| v_kind \|\| '\|' \|\| v_hash \|\| '\|' \|\| v_at_text/,
  "مفتاح الحدث = GUID + تسلسل متزايد (+ النوع والنسخة والوقت)، لا بصمة المحتوى وحدها؛ يُعاد حسابه على الخادم");
// ملاحظة المالك (1): الأيام المتأثرة تُزال مكرراتها قبل إدخال واحد، والمجاميع تُحسب من المصدر.
assert.match(code, /create table if not exists public\.ameen_invoice_dirty_days \(/);
assert.match(code, /select distinct x\.day, v_now, v_now, 1\s+from pg_catalog\.unnest\(v_days\)/,
  "إزالة تكرار اليوم قبل الإدخال (تعديل بلا تغيير التاريخ = اليوم نفسه مرتين)");
assert.match(code, /on conflict \(day\) do update/);
assert.match(code, /create or replace view public\.ameen_invoice_daily_totals\s+with \(security_invoker = true\)/,
  "المجاميع اليومية من المصدر وبصلاحيات القارئ");
assert.match(code, /alter table public\.ameen_invoice_dirty_days force row level security;/);
assert.match(code, /revoke all on function public\.apply_ameen_invoice_events\(jsonb\) from public, anon, service_role;/);
assert.match(code, /grant execute on function public\.apply_ameen_invoice_events\(jsonb\) to authenticated;/);
assert.doesNotMatch(code, /inventory_reports|ameen_customer_invoices/, "مستقل تماماً عن تقرير الفواتير القائم");
assert.doesNotMatch(code, /notify_telegram|cron\.schedule|net\.http/, "لا تنبيه ولا جدولة ولا اتصال خارجي");
assert.doesNotMatch(code, /\bdelete\s+from\s+public\.ameen_invoices\b/i, "الحذف شاهد قبر لا حذف فعلي");

// الوكيل يبني المفتاح نفسه، وبذرة التسلسل من الساعة فلا يعود إلى 1 بعد ضياع الحالة.
const libSrc = read(libRel);
assert.match(libSrc, /"\{0\}\|\{1\}\|\{2\}\|\{3\}\|\{4\}" -f \$BillGuid, \$Seq\.ToString\(\$script:Invariant\), \$Kind, \$VersionHash, \$SourceEventAt/,
  "مفتاح الوكيل = guid|seq|kind|version|at بنفس ترتيب الخادم");
assert.match(libSrc, /last_seq = \(Get-AmeenSeqSeed \$NowUtc\)/, "التسلسل يبدأ من الساعة");

// اختبارات إلزامية بطلب المالك (2026-10-20): حذف أيٍّ منها يُسقط الفحص.
const sqlTest = read(testRel);
for (const name of [
  "same-day edit: applied without error",
  "same-day edit: mark_count +1 (not +2)",
  "same-day edit: daily total recomputed (no double count)",
  "batch same day: one dirty day in the request",
  "date move: both days marked",
  "A-B-A same time: none treated as duplicate",
  "A-B-A same time: final content is A",
  "retry after disconnect: all duplicate",
  "retry after disconnect: no day re-marked",
  "out-of-order: older arrives later = stale",
  "out-of-order: newest content kept",
  "tie on time, lower seq = stale",
  "unordered batch: final content is newest",
  "late older event: stale",
  "edit: still exactly one row for the bill",
]) assert.ok(sqlTest.includes(`'${name}'`), `اختبار SQL إلزامي مفقود: ${name}`);
const psTest = read("tools/tests/Test-AmeenInvoiceEvents.ps1");
for (const name of [
  "A->B->A same timestamp: last A key differs from first A key",
  "A->B->A same timestamp: strictly increasing seq",
  "event key contains the bill guid and seq, not content alone",
  "state lost with empty outbox: clock seed is above every earlier seq",
  "offline: nothing removed",
  "online again: sent strictly in seq order",
  "edit: one updated event for the SAME bill_guid",
]) assert.ok(psTest.includes(`'${name}'`), `اختبار PowerShell إلزامي مفقود: ${name}`);

const rollback = read(rollbackRel).replace(/--.*$/gm, "");
assert.match(rollback, /drop table if exists public\.ameen_invoices;/);
assert.match(rollback, /drop table if exists public\.ameen_invoice_events;/);
assert.match(rollback, /drop table if exists public\.ameen_invoice_dirty_days;/);
assert.match(rollback, /drop view if exists public\.ameen_invoice_daily_totals;/);
assert.match(rollback, /drop function if exists public\.apply_ameen_invoice_events\(jsonb\);/);
assert.doesNotMatch(rollback, /inventory_reports|is_staff|ameen_price_sync_status/);

// الهجرة مقترحة فقط: لا تدخل سلسلة supabase/migrations.
for (const f of readdirSync(path.join(root, "supabase/migrations")).filter((n) => n.endsWith(".sql"))) {
  const sql = readFileSync(path.join(root, "supabase/migrations", f), "utf8");
  assert.doesNotMatch(sql, /apply_ameen_invoice_events|public\.ameen_invoices\b/, `${f}: المرحلة 2 غير مطبَّقة؛ لا هجرة فعّالة لها`);
}

// الوكيل والمكتبة: قراءة فقط، لا تسجيل مهمة، لا إرسال افتراضي.
const agent = read(agentRel);
const lib = read(libRel);
const agentCode = agent.replace(/#.*$/gm, "");
const libCode = lib.replace(/#.*$/gm, "");
assert.match(agentCode, /\$RpcName = "apply_ameen_invoice_events"/, "الوكيل يكتب عبر الدالة المقترحة وحدها");
assert.match(agentCode, /\/rest\/v1\/rpc\//);
assert.match(agentCode, /if \(-not \$Send\) \{ return \$false \}/, "لا إرسال بلا -Send");
assert.match(agentCode, /\$ActivationFlag = "send-enabled\.flag"/, "ولا بلا ملف تفعيل يضعه المالك");
assert.match(agentCode, /Assert-AmeenReadOnlySql \$Sql/, "كل SQL يمرّ عبر حارس القراءة");
assert.match(agentCode, /SET LOCK_TIMEOUT 3000; /);
assert.match(agentCode, /\$ExpectedDatabase = "AmnDb002"/);
for (const [name, text] of [["agent", agent], ["lib", lib]]) {
  assert.doesNotMatch(text, /AMEEN_SQL_WRITE_CONNECTION_STRING|WRITE_CONNECTION/, `${name}: لا سلسلة اتصال الكتابة`);
  assert.doesNotMatch(text, /Register-ScheduledTask|schtasks/i, `${name}: لا تسجيل مهمة مجدولة`);
  assert.doesNotMatch(text, /ExecuteNonQuery|ExecuteReader|ExecuteScalar|SqlBulkCopy|Invoke-Sqlcmd/, `${name}: لا تنفيذ SQL خارج القراءة المحروسة`);
  assert.doesNotMatch(text, /with\s*\(\s*nolock/i, `${name}: لا NOLOCK (قراءة متسقة فقط)`);
  assert.doesNotMatch(text, /inventory_reports|SUPABASE_SERVICE_KEY|service_role/, `${name}: حساب المزامنة وحده، بلا inventory_reports`);
}
// أنماط فحص الكتابة في بوابة نشر Windows على ملفات المرحلة 2 (دفاع إضافي متطابق مع البوابة).
const gate = JSON.parse(read("tools/deploy-gate/gate-config.example.json"));
for (const pattern of gate.writeScan.patterns) {
  const re = new RegExp(pattern, "i");
  assert.doesNotMatch(agentCode, re, `agent: نمط كتابة على الأمين (${pattern})`);
  assert.doesNotMatch(libCode, re, `lib: نمط كتابة على الأمين (${pattern})`);
}
// غير مفعَّل: لا شيء في المستودع يشغّل الوكيل.
const runners = [];
const walk = (dir) => {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!["node_modules", ".git", "tests"].includes(entry.name)) walk(rel); continue; }
    if (!/\.(ps1|psm1|vbs|cmd|bat|json|js|mjs|yml|yaml)$/.test(entry.name)) continue;
    const relPosix = rel.split(path.sep).join("/");
    // الوكيل ومكتبته، وفحوص scripts/check*.mjs (تقرأ الملفات ولا تشغّلها — نفس استثناء writeScan في البوابة).
    if ([agentRel, libRel].includes(relPosix) || /^scripts\/check[^/]*\.mjs$/.test(relPosix)) continue;
    if (readFileSync(path.join(root, rel), "utf8").includes("ameen-invoice-event-agent")) runners.push(rel);
  }
};
for (const dir of ["tools", "scripts", ".github"]) if (existsSync(path.join(root, dir))) walk(dir);
assert.deepEqual(runners, [], `الوكيل غير مفعَّل: لا يجوز أن يستدعيه أي ملف (${runners.join(", ")})`);
console.log("  ✓ عقود ساكنة: صف لكل فاتورة، بلا تكرار، بترتيب، هوية المزامنة فقط، الوكيل قراءة فقط وغير مفعَّل");

// ── ٢) تشغيل SQL حي ─────────────────────────────────────────────────────────────────────────
const DB = "ozk_ameen_invoice_events_test";
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  const command = viaTcp ? "psql" : "sudo";
  const argv = viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args];
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-ameen-invoice-events: refusing non-local PGHOST");
  process.exit(1);
}
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/ameen-invoice-events.sql");
    process.exit(1);
  }
  console.log("  - SQL حي: متخطى (لا PostgreSQL محلي)");
} else {
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const create = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
  const testSql = read(testRel);
  assert.ok(testSql.includes("\\i :migration") && testSql.includes("\\i :rollback"), "الاختبار يطبّق الهجرة والتراجع");
  const bundled = testSql.replace("\\i :migration", () => migration).replace("\\i :rollback", () => read(rollbackRel));
  const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
  const drop = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const text = `${output(create)}${output(run)}`;
  const passes = (text.match(/PASS /g) || []).length;
  if (create.status !== 0 || run.status !== 0 || !text.includes("AMEEN_INVOICE_EVENTS_OK") || /TEST FAIL/.test(text)) {
    console.error(text);
    console.error("check-ameen-invoice-events: live SQL test failed");
    process.exit(run.status || 1);
  }
  if (drop.status !== 0) console.error(output(drop));
  assert.ok(passes >= 120, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
  console.log(`  ✓ اختبار SQL حي على PostgreSQL: ${passes} تأكيداً`);
}

// ── ٣) اختبار PowerShell ────────────────────────────────────────────────────────────────────
const pwshProbe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
if (pwshProbe.status !== 0) {
  if (process.env.CI === "true") { console.error("CI must run tools/tests/Test-AmeenInvoiceEvents.ps1 (pwsh missing)"); process.exit(1); }
  console.log("  - اختبار PowerShell: متخطى (لا pwsh)");
} else {
  const ps = spawnSync("pwsh", ["-NoProfile", "-File", path.join(root, "tools/tests/Test-AmeenInvoiceEvents.ps1")], { encoding: "utf8" });
  const psText = output(ps);
  if (ps.status !== 0 || /^FAIL /m.test(psText)) {
    console.error(psText);
    console.error("check-ameen-invoice-events: PowerShell test failed");
    process.exit(ps.status || 1);
  }
  const m = psText.match(/Ameen invoice events: (\d+) PASS, (\d+) FAIL/);
  assert.ok(m && Number(m[2]) === 0 && Number(m[1]) >= 95, "نتيجة اختبار PowerShell غير متوقعة");
  console.log(`  ✓ اختبار PowerShell (${pwshProbe.stdout.trim()}): ${m[1]} تأكيداً`);
}
console.log("check-ameen-invoice-events: اجتاز الفحص.");
