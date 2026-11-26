// فحص إعادة احتساب الأرباح اليومية للأيام الماضية (Migration 31 + سكربتات Windows).
//
// العطل الذي يمنعه (مطابقة 2026-11-25): push-daily-profit.ps1 يحسب اليوم وحده، فكل
// يوم ماضٍ بقي لقطة مجمّدة؛ 80 يوماً من 99 خالفت الأمين، وسبعة أيام غابت.
//
// ١) ساكن: المعادلة في مكان واحد (tools/daily-profit-lib.ps1) يستعمله سكربت اليوم
//    وسكربت إعادة الاحتساب؛ الأمين قراءة فقط؛ اليوم الحالي خارج إعادة الاحتساب؛
//    قفل ضد التداخل؛ الملفات ASCII لـPowerShell 5.1.
// ٢) حي: الهجرة والتراجع على PostgreSQL محلي مؤقت (supabase/tests/ameen-daily-profit-recompute.sql).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const read = (p) => readFileSync(p, "utf8");
const lib = read("tools/daily-profit-lib.ps1");
const today = read("tools/push-daily-profit.ps1");
const recompute = read("tools/recompute-daily-profit.ps1");
const register = read("tools/register-daily-profit-recompute-tasks.ps1");
const migration = read("supabase/proposed/31-ameen-daily-profit-recompute.sql");
const rollback = read("supabase/proposed/31-ameen-daily-profit-recompute-rollback.sql");

// ── ١) ساكن ─────────────────────────────────────────────────────────────────
for (const [name, text] of [["daily-profit-lib.ps1", lib], ["recompute-daily-profit.ps1", recompute], ["register-daily-profit-recompute-tasks.ps1", register]]) {
  assert.ok(!/[^\x00-\x7F]/.test(text), `${name} must stay ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI)`);
}

// المعادلة المعتمدة بحرفها، في المكتبة وحدها.
for (const piece of [
  "$netReturns = $Row.returns_gross - $Row.returns_discounts + $Row.returns_extras",
  "$netSales = $Row.sales_gross - $Row.sales_discounts + $Row.sales_extras - $netReturns",
  "$netCost = $Row.sales_cost - $Row.returns_cost",
  "$grossProfit = $netSales - $netCost",
  "$netProfit = $grossProfit - $Row.expenses",
  "complete = ([int]$Row.missing_cost_lines -eq 0)",
  "bi.UnitCostPrice IS NULL OR bi.UnitCostPrice <= 0",
  "bt.BillType IN (1, 3)",
  "6AE0066F-D39E-4805-83D5-B8DA92F7D7F1",
]) {
  assert.ok(lib.includes(piece), `daily-profit-lib.ps1 lost a piece of the approved formula: ${piece}`);
}
for (const [name, text] of [["push-daily-profit.ps1", today], ["recompute-daily-profit.ps1", recompute]]) {
  assert.ok(text.includes('daily-profit-lib.ps1"'), `${name} must dot-source daily-profit-lib.ps1 (one formula for today and past days)`);
  assert.ok(!/FROM\s+bu000/i.test(text.replace(/SELECT CONVERT\(char\(10\), MIN\(d\)[\s\S]*?\) x/, "")),
    `${name} must not carry its own copy of the profit query`);
  assert.ok(text.includes("New-AmeenReadOnlyConnection"), `${name} must open Ameen through the read-only helper`);
}
assert.ok(today.includes("New-DailyProfitSummary -Row $rows[0] -SyncMode \"today\""), "push-daily-profit.ps1 must keep computing the current day");

// الأمين قراءة فقط: لا جملة كتابة في أي من الثلاثة.
for (const [name, text] of [["daily-profit-lib.ps1", lib], ["push-daily-profit.ps1", today], ["recompute-daily-profit.ps1", recompute]]) {
  assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|MERGE\s+|EXEC(UTE)?\s+|DROP\s+|ALTER\s+|TRUNCATE\s+)/i.test(text),
    `${name} must not contain any SQL write statement (Ameen is READ ONLY)`);
  assert.ok(!text.includes("AMEEN_SQL_WRITE_CONNECTION_STRING"), `${name} must not use the Ameen write connection`);
}
assert.ok(lib.includes('$b["ApplicationIntent"] = "ReadOnly"'), "the Ameen connection helper must force ApplicationIntent=ReadOnly");

// اليوم الحالي ملك مزامنة اليوم؛ إعادة الاحتساب للماضي وحده، بقفل، وبلا كتابة في -DryRun.
assert.ok(recompute.includes("if ($toDate -gt $yesterday) { $toDate = $yesterday }"), "recompute must stop at yesterday");
assert.ok(recompute.includes("[System.IO.FileShare]::None"), "recompute must hold an exclusive lock against overlapping runs");
assert.ok(/if \(\$DryRun\) \{ Write-Log "DRY RUN: no Supabase write."; exit 0 \}/.test(recompute), "-DryRun must exit before any Supabase call");
assert.ok(recompute.indexOf("exit 0 }") < recompute.indexOf("auth/v1/token"), "-DryRun exit must come before the sign-in");
assert.ok(recompute.includes("rpc/recompute_ameen_daily_profit"), "recompute must write only through rpc/recompute_ameen_daily_profit");
assert.ok(!recompute.includes("rpc/upsert_ameen_daily_profit"), "recompute must not use the today upsert (it bumps created_at)");
assert.ok(!/-Method\s+(Patch|Delete|Put)\b/i.test(recompute), "recompute must not delete or patch rows directly");

// المهام المقترحة: ليلية 30 يوماً وأسبوعية للسنة، عبر المشغّل الموحّد، بلا تشغيل ذاتي.
assert.ok(register.includes("[int]$NightlyDays = 30") && register.includes("-Days $NightlyDays") && register.includes("-FullYear"), "register script must define the nightly 30-day and weekly full-year runs");
assert.ok(register.includes("run-repo-task.ps1"), "recompute tasks must run through the deploy-gate launcher");
assert.ok(register.includes("MultipleInstances") && register.includes("IgnoreNew"), "recompute tasks must not start a second instance");

// الهجرة: حارس، معاملة، هوية المزامنة، لا لمس لـcreated_at، تراجع.
assert.match(migration, /^begin;$/m);
assert.match(migration, /^commit;$/m);
assert.ok(migration.includes("public.ameen_daily_profit_is_sync_writer()"), "recompute RPC must use the sync-writer guard");
assert.ok(migration.includes("p_report_date >= v_today"), "recompute RPC must reject the current day");
assert.ok(!/created_at\s*=/.test(migration), "recompute RPC must never update created_at of an existing row");
assert.ok(migration.includes("((p_report_date + 1)::timestamp at time zone 'Asia/Damascus') - interval '1 second'"), "an inserted past day must be stamped at the end of its own day, not now()");
assert.ok(/revoke all on function public\.recompute_ameen_daily_profit\(date, jsonb\) from public, anon, service_role;/.test(migration));
assert.ok(/revoke all on table private\.ameen_daily_profit_revisions from public, anon, authenticated;/.test(migration));
assert.ok(rollback.includes("ameen_daily_profit_revert_revisions('-infinity'"), "rollback must restore data before dropping objects");
console.log("  ✓ ساكن: معادلة واحدة، الأمين قراءة فقط، اليوم خارج إعادة الاحتساب، قفل، هجرة وتراجع");

// ── ٢) حي على PostgreSQL محلي ───────────────────────────────────────────────
const DB = "ozk_daily_profit_recompute_test";
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-daily-profit-recompute: refusing non-local PGHOST");
  process.exit(1);
}
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  return spawnSync(viaTcp ? "psql" : "sudo", viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args], { encoding: "utf8", ...options });
}
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/ameen-daily-profit-recompute.sql");
    process.exit(1);
  }
  console.log("  - SQL حي: متخطى (لا PostgreSQL محلي)");
} else {
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const create = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
  const bundled = read("supabase/tests/ameen-daily-profit-recompute.sql")
    .replace("\\i :base", () => read("supabase/ameen-daily-profit-atomic-upsert.sql"))
    .replace("\\i :migration", () => migration)
    .replace("\\i :rollback", () => rollback);
  const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const text = `${output(create)}${output(run)}`;
  const passes = (text.match(/PASS /g) || []).length;
  if (create.status !== 0 || run.status !== 0 || !text.includes("DAILY_PROFIT_RECOMPUTE_OK") || /TEST FAIL/.test(text)) {
    console.error(text);
    console.error("check-daily-profit-recompute: live SQL test failed");
    process.exit(run.status || 1);
  }
  assert.ok(passes >= 30, `عدد تأكيدات SQL (${passes}) أقل من المتوقع`);
  console.log(`  ✓ الهجرة 31 والتراجع على PostgreSQL محلي: ${passes} تأكيداً`);
}
