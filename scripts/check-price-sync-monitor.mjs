// ============================================================================
// مراقبة مزامنة الأسعار المستقلة على Supabase (supabase/proposed/17-price-sync-monitor.sql) — المرحلة 3.
//
// طبقتان:
//   ١) عقود ساكنة على نص الهجرة: مصدر واحد (price_sync_heartbeats)، ساعة الخادم، قفل استشاري، حادثة
//      واحدة مفتوحة، بلا أسرار ولا HTML، توافق التوجيه مع الحزم 12/13، وتعطيل المراقب القديم.
//   ٢) تشغيل حي لـ supabase/tests/price-sync-monitor.sql على PostgreSQL محلي مؤقت (إلزامي في CI)،
//      ثم اختبار تزامن حقيقي: دورتان متوازيتان من اتصالين منفصلين ⇒ تنبيه واحد فقط.
// لا شبكة ولا تيليغرام حقيقي ولا بيانات إنتاج.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const migration = read("supabase/proposed/17-price-sync-monitor.sql");
const rollback = read("supabase/proposed/17-price-sync-monitor-rollback.sql");
const m16 = read("supabase/proposed/16-price-sync-heartbeats.sql");
const testSql = read("supabase/tests/price-sync-monitor.sql");
const code = migration.replace(/--.*$/gm, "");

// ── ١) عقود ساكنة ───────────────────────────────────────────────────────────────────────────
assert.match(code, /from public\.price_sync_heartbeats h/, "المصدر الوحيد: price_sync_heartbeats");
assert.doesNotMatch(code, /inventory_reports|ameen_price_sync_status/, "لا يعتمد على المصادر القديمة");
assert.doesNotMatch(code, /occurred_at|attempt_finished_at|probed_at/, "لا طوابع عميل: received_at وnow() فقط");
assert.match(code, /pg_advisory_xact_lock\(pg_catalog\.hashtext\('private\.price_sync_monitor_tick'\)\)/);
assert.match(code, /create unique index if not exists price_sync_incidents_one_open[\s\S]*?where closed_at is null/);
assert.match(code, /'Asia\/Damascus'/);
assert.doesNotMatch(code, /<[a-z\/][^>]*>/i, "لا HTML في الرسائل");
assert.doesNotMatch(code, /telegram_bot_token|api\.telegram\.org|vault\.|net\.http_post/i, "لا أسرار ولا إرسال مباشر: notify_telegram فقط");
assert.match(code, /public\.notify_telegram\('price_sync_outage'/);
assert.match(code, /public\.notify_telegram\('price_sync_recovered'/);
assert.doesNotMatch(code, /exception\s+when/i, "فشل إدراج الرسالة يُرجع الدورة كلها (لا التقاط)");
assert.match(code, /revoke all on function private\.price_sync_monitor_tick\(timestamptz\) from public, anon, authenticated, service_role;/);
assert.doesNotMatch(code, /grant\s+(execute|select|insert|update|delete|all)[^;]*price_sync_(monitor|incidents)/i, "لا منح لأي دور");
assert.match(code, /update private\.project_task_monitors set enabled = false where task_key = 'price-sync' and enabled;/,
  "المراقب القديم يُعطَّل لمنع التنبيه المزدوج");
assert.match(code, /cron\.schedule\('price-sync-monitor', '\* \* \* \* \*', 'select private\.price_sync_monitor_tick\(\);'\)/);
assert.match(rollback, /cron\.unschedule\('price-sync-monitor'\)/);
assert.match(rollback, /set enabled = true where task_key = 'price-sync'/);
assert.doesNotMatch(rollback.replace(/--.*$/gm, ""), /price_sync_heartbeats|notify_telegram/);

// التوجيه في الحزم 12/13 (غير مطبَّقة): نوع الحدث ومفتاحه لا يقعان تحت قواعد «الملخص».
const dedupeOpen = "price-sync-outage:1:open";
for (const rule of [/^price-sync:/, /^winfail:/, /^project-cron-failure:/, /^(price-sync:|winfail:|project-cron-failure:)/]) {
  assert.ok(!rule.test(dedupeOpen), `مفتاح الحادثة يطابق قاعدة ملخص ${rule}`);
}
for (const file of ["supabase/proposed/12-digest-only-atomic-bundle.sql", "supabase/proposed/13-digest-routing-for-noncritical-alerts.sql", "supabase/proposed/15-ameen-sync-outage-incident.sql"]) {
  const text = read(file);
  assert.doesNotMatch(text, /price_sync_outage|price_sync_recovered|price-sync-outage/, `${file} يعرّف نوع حدثنا`);
}
console.log("  ✓ عقود ساكنة: مصدر واحد، ساعة الخادم، قفل، حادثة واحدة، بلا أسرار ولا HTML، توافق 12/13/15");

// ── ٢) تشغيل حي ─────────────────────────────────────────────────────────────────────────────
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-price-sync-monitor: refusing non-local PGHOST");
  process.exit(1);
}
const DB = "ozk_price_sync_monitor_test";
const viaTcp = Boolean(process.env.PGHOST);
const command = viaTcp ? "psql" : "sudo";
const argvOf = (args) => (viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args]);
const psql = (args, options = {}) => spawnSync(command, argvOf(args), { encoding: "utf8", ...options });
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;

const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/price-sync-monitor.sql");
    process.exit(1);
  }
  console.log("check-price-sync-monitor: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
const create = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
assert.ok(testSql.includes("\\i :m16") && testSql.includes("\\i :migration") && testSql.includes("\\i :rollback"));
// stdin لا -f: في CI يعمل psql بمستخدم postgres الذي لا يقرأ مجلد العامل.
const bundled = testSql
  .replace("\\i :m16", () => m16)
  .replaceAll("\\i :migration", () => migration)
  .replace("\\i :rollback", () => rollback);
const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
const text = `${output(create)}${output(run)}`;
const passes = (text.match(/PASS /g) || []).length;
let failed = create.status !== 0 || run.status !== 0 || !text.includes("PRICE_SYNC_MONITOR_OK") || /TEST FAIL/.test(text);

// تزامن حقيقي: دورتان من اتصالين منفصلين في اللحظة نفسها على انقطاع قائم.
let concurrency = "skipped";
if (!failed) {
  const setup = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1", "-c", `
    delete from public.price_sync_heartbeats; delete from private.price_sync_incidents;
    delete from private.price_sync_monitor_state; delete from public.telegram_outbox;
    insert into public.price_sync_heartbeats (received_at, writer_id, kind, host, occurred_at, outcome, summary, last_success_at)
      values (now() - interval '40 minutes', gen_random_uuid(), 'attempt', 'OZK2026', now(), 'applied', '{}'::jsonb, now() - interval '40 minutes');
    insert into private.price_sync_monitor_state values (true, now() - interval '2 hours', now() - interval '1 minute', 'HEALTHY', 'applied');`]);
  const tickSql = "begin; select private.price_sync_monitor_tick(); select pg_sleep(0.5); commit;";
  const parallel = () => new Promise((resolve) => {
    const child = spawn(command, argvOf(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1", "-tAc", tickSql]));
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => resolve({ status, out }));
  });
  const results = await Promise.all([parallel(), parallel(), parallel()]);
  const count = psql(["-d", DB, "-tAc", "select count(*) from public.telegram_outbox where event_type = 'price_sync_outage'"]);
  const opened = psql(["-d", DB, "-tAc", "select count(*) from private.price_sync_incidents where closed_at is null"]);
  const ticks = results.map((r) => (r.out.match(/\b(alert_sent|incident_ongoing|healthy|baseline\w*|recovery_sent)\b/) || ["?"])[0]).sort().join(",");
  concurrency = `${count.stdout.trim()} alert / ${opened.stdout.trim()} incident (${ticks})`;
  if (setup.status !== 0 || results.some((r) => r.status !== 0) || count.stdout.trim() !== "1" || opened.stdout.trim() !== "1") {
    failed = true;
    console.error(output(setup), results.map((r) => r.out).join("\n"));
  }
}
psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);

if (failed) {
  console.error(text);
  console.error(`concurrency: ${concurrency}`);
  console.error("check-price-sync-monitor: live SQL test failed");
  process.exit(1);
}
assert.ok(passes >= 70, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
console.log(`  ✓ اختبار حي على PostgreSQL: ${passes} تأكيداً`);
console.log(`  ✓ تزامن: 3 دورات متوازية ⇒ ${concurrency}`);
console.log("check-price-sync-monitor: اجتاز الفحص.");
