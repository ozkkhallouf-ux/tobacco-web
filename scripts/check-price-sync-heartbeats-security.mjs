// ============================================================================
// أمن جدول نبض مزامنة الأسعار (supabase/proposed/16-price-sync-heartbeats.sql).
//
// قرار المالك (2026-10-18، خيار B): نبض المزامنة في جدول مستقل لا يكتبه إلا هوية المزامنة
// المعتمدة، فلا يستطيع مستخدم عادي للموقع — ولا موظف ولا مالك — تزوير حالة HEALTHY، و«النجاح»
// لا يُقبل بلا إثبات وصول الأسعار للأمين.
//
// طبقتان:
//   ١) عقود ساكنة على نص الهجرة (تعمل في كل مكان).
//   ٢) تشغيل حي لـ supabase/tests/price-sync-heartbeats-security.sql على PostgreSQL محلي مؤقت:
//      في CI إلزامي (وظيفة check تشغّل Postgres محلياً)، ومحلياً يُتخطى إن لم يوجد Postgres.
//      الاتصال: PGHOST/PGPORT/PGUSER إن ضُبطت، وإلا `sudo -u postgres psql` (نمط
//      check-warehouse-stock-prune). القاعدة مستقلة وتُحذف بعد التشغيل.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(root, "supabase/proposed/16-price-sync-heartbeats.sql");
const rollbackPath = path.join(root, "supabase/proposed/16-price-sync-heartbeats-rollback.sql");
const testPath = path.join(root, "supabase/tests/price-sync-heartbeats-security.sql");

// ── ١) عقود ساكنة ───────────────────────────────────────────────────────────────────────────
const migration = readFileSync(migrationPath, "utf8");
const code = migration.replace(/--.*$/gm, "");

assert.match(code, /create table if not exists public\.price_sync_heartbeats/);
assert.match(code, /alter table public\.price_sync_heartbeats enable row level security;/);
assert.match(code, /alter table public\.price_sync_heartbeats force row level security;/);
assert.match(code, /revoke all on table public\.price_sync_heartbeats from public, anon, authenticated, service_role;/,
  "لا كتابة مباشرة لأي دور، ولا حتى service_role");
assert.match(code, /grant select on table public\.price_sync_heartbeats to authenticated;/);
assert.doesNotMatch(code, /grant\s+(insert|update|delete|all)[^;]*price_sync_heartbeats/i, "لا منح كتابة على الجدول");
assert.doesNotMatch(code, /create policy[^;]*for\s+(insert|update|delete|all)/i, "لا سياسة كتابة");
assert.match(code, /using \(\(select public\.is_staff\(\)\)\)/, "القراءة للموظفين فقط");
assert.match(code, /select coalesce\(\(select auth\.uid\(\)\) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid, false\);/,
  "هوية المزامنة المعتمدة نفسها التي تكتب ameen_price_sync_status");
assert.match(code, /security definer\s+set search_path = ''/);
assert.match(code, /if not public\.price_sync_is_sync_writer\(\) then/);
assert.doesNotMatch(code, /v_is_service|'service_role'/, "لا احتياط بمفتاح service_role");
assert.match(code, /pg_advisory_xact_lock/, "حمل آخر نجاح من الصف السابق مسلسل");
assert.match(code, /errcode = '42501'/);
assert.match(code, /revoke all on function public\.record_price_sync_heartbeat\(jsonb\) from public, anon, service_role;/);
assert.match(code, /grant execute on function public\.record_price_sync_heartbeat\(jsonb\) to authenticated;/);
assert.match(code, /success outcome requires proof that prices reached Ameen/);
assert.doesNotMatch(code, /inventory_reports/, "الجدول الجديد مستقل تماماً عن inventory_reports");
assert.doesNotMatch(code, /notify_telegram|cron\.schedule/, "لا تنبيه ولا جدولة في هذه المرحلة");
const rollback = readFileSync(rollbackPath, "utf8").replace(/--.*$/gm, "");
assert.match(rollback, /drop table if exists public\.price_sync_heartbeats;/);
assert.doesNotMatch(rollback, /inventory_reports|is_staff|ameen_price_sync_status/);

// الناشر على Windows يكتب عبر الدالة وحدها، ولم يعد يلمس inventory_reports (Codex P1 على #332).
const publisher = readFileSync(path.join(root, "tools/publish-price-sync-heartbeat.ps1"), "utf8").replace(/#.*$/gm, "");
assert.match(publisher, /\$rpcName = "record_price_sync_heartbeat"/);
assert.match(publisher, /\/rest\/v1\/rpc\/\$rpcName/);
assert.doesNotMatch(publisher, /inventory_reports/);
assert.doesNotMatch(publisher, /SUPABASE_SERVICE_KEY/, "الناشر يستعمل حساب المزامنة وحده");
console.log("  ✓ عقود ساكنة: لا كتابة مباشرة، هوية المزامنة فقط، النجاح بإثبات، بلا inventory_reports");

// ── ٢) تشغيل حي ─────────────────────────────────────────────────────────────────────────────
const DB = "ozk_price_sync_heartbeats_test";

function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  const command = viaTcp ? "psql" : "sudo";
  const argv = viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args];
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;

const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/price-sync-heartbeats-security.sql");
    process.exit(1);
  }
  console.log("check-price-sync-heartbeats-security: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
const create = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
// الملفات تُمرَّر عبر stdin لا بـ -f/\\i: في CI يعمل psql بمستخدم postgres الذي لا يقرأ مجلد العامل.
const testSql = readFileSync(testPath, "utf8");
assert.ok(testSql.includes("\\i :migration") && testSql.includes("\\i :rollback"), "الاختبار يجب أن يطبّق الهجرة والتراجع");
const bundled = testSql
  .replace("\\i :migration", () => migration)
  .replace("\\i :rollback", () => readFileSync(rollbackPath, "utf8"));
const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
const drop = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
const text = `${output(create)}${output(run)}`;
const passes = (text.match(/PASS /g) || []).length;

if (create.status !== 0 || run.status !== 0 || !text.includes("PRICE_SYNC_HEARTBEATS_SECURITY_OK") || /TEST FAIL/.test(text)) {
  console.error(text);
  console.error("check-price-sync-heartbeats-security: live SQL test failed");
  process.exit(run.status || 1);
}
if (drop.status !== 0) console.error(output(drop));
assert.ok(passes >= 60, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
console.log(`  ✓ اختبار حي على PostgreSQL: ${passes} تأكيداً`);
console.log("check-price-sync-heartbeats-security: اجتاز الفحص.");
