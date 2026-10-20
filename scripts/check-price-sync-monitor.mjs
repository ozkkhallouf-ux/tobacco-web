// ============================================================================
// مراقبة مزامنة الأسعار المستقلة على Supabase (supabase/proposed/17-price-sync-monitor.sql) — المرحلة 3.
//
// ثلاث طبقات:
//   ١) عقود ساكنة على نص الهجرة: مصدر واحد (price_sync_heartbeats)، ساعة الخادم، قفل استشاري، حادثة
//      واحدة مفتوحة، بلا أسرار ولا HTML، توافق التوجيه مع 12/13/15، وتعطيل المراقب القديم؛ والحارس:
//      بصماته = أجسام 12/13/15 في ملفاتها نفسها، وكل جملة تُنشئ شيئاً داخل كتلة التثبيت المحروسة.
//   ٢) حارس 17 حياً على PostgreSQL محلي، كلٌّ في قاعدة مستقلة: لا حزمة، 12 فقط، 12+13، الثلاث بالترتيب،
//      عدد صحيح بمعرّفات خاطئة (بصمة/ترتيب/سجل هجرات)، وتنفيذ أمر بأمر — والحارس الفاشل لا يُنشئ شيئاً.
//   ٣) supabase/tests/price-sync-monitor.sql كاملاً (السلوك)، ثم تزامن حقيقي في أربع حالات انتقال.
// لا شبكة ولا تيليغرام حقيقي ولا بيانات إنتاج.
// ============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const migration = read("supabase/proposed/17-price-sync-monitor.sql");
const rollback = read("supabase/proposed/17-price-sync-monitor-rollback.sql");
const m16 = read("supabase/proposed/16-price-sync-heartbeats.sql");
const envSql = read("supabase/tests/price-sync-monitor-env.sql");
const testSql = read("supabase/tests/price-sync-monitor.sql");
const f12 = read("supabase/proposed/12-digest-only-atomic-bundle.sql");
const f13 = read("supabase/proposed/13-digest-routing-for-noncritical-alerts.sql");
const f15 = read("supabase/proposed/15-ameen-sync-outage-incident.sql");
const code = migration.replace(/--.*$/gm, "");
const md5 = (s) => createHash("md5").update(s).digest("hex");

// تعريف دالة كما في ملف الحزمة: { body = prosrc، sql = جملة create كاملة }.
function definition(text, name) {
  // تهريب كامل لمحارف التعبير النمطي (CodeQL js/incomplete-sanitization).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`create or replace function ${escaped}\\s*\\(`, "gi");
  const found = [];
  let m;
  while ((m = re.exec(text))) {
    const asRe = /\bas\s+(\$[A-Za-z0-9_]*\$)/g;
    asRe.lastIndex = m.index;
    const a = asRe.exec(text);
    const start = a.index + a[0].length;
    const end = text.indexOf(a[1], start);
    found.push({ body: text.slice(start, end), sql: text.slice(m.index, text.indexOf(";", end + a[1].length) + 1) });
  }
  assert.equal(found.length, 1, `${name}: تعريف واحد متوقَّع`);
  return found[0];
}
const PKG = {
  monitor12: definition(f12, "private.monitor_project_tasks"),
  section12: definition(f12, "private.daily_open_faults_section"),
  route13: definition(f13, "private.ops_event_route"),
  lifecycle13: definition(f13, "public.health_lifecycle"),
  dispatch13: definition(f13, "private.notify_telegram_dispatch"),
  dispatch15: definition(f15, "private.notify_telegram_dispatch"),
  section15: definition(f15, "private.daily_open_faults_section"),
  tick15: definition(f15, "private.sync_outage_tick")
};
// إعادة جسم الإرسال الإنتاجي المبسّط (بيئة الاختبار وحدها): جسم 15 يحمل قيماً افتراضية للمعاملات فلا يُستبدل بلا drop.
const dispatchProd = `drop function if exists private.notify_telegram_dispatch(text,text,text,integer,jsonb);\n${definition(envSql, "private.notify_telegram_dispatch").sql}`;

// الجمل العليا (احترام السلاسل الدولارية والمفردة والتعليقات).
function topLevelStatements(sql) {
  const out = []; let buf = ""; let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j + 1; continue; }
    const c = sql[i];
    if (c === "'") { let j = i + 1; while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1; buf += sql.slice(i, j + 1); i = j + 1; continue; }
    const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
    if (tag) { const j = sql.indexOf(tag[0], i + tag[0].length); buf += sql.slice(i, j + tag[0].length); i = j + tag[0].length; continue; }
    if (c === ";") { if (buf.trim()) out.push(buf.trim()); buf = ""; i += 1; continue; }
    buf += c; i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

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
assert.match(code, /public\.notify_telegram\('price_sync_partial'/);
assert.match(code, /and not probe_superseded then/, "محاولة أحدث من فحص «معطّلة» تُسقطه");
assert.match(code, /when 'ameen_unreachable' then '\^winfail:apply-to-ameen\$'/, "امتصاص تنبيه Windows المطابق");
assert.match(code, /and o\.created_at > coalesce\(p_since, '-infinity'::timestamptz\)/, "الامتصاص محصور بسلسلة الفشل الحالية (Codex P1)");
assert.match(code, /incident_key\s+uuid not null default gen_random_uuid\(\) unique/, "مفتاح حادثة لا يتكرر بعد تراجع وإعادة تطبيق");
assert.doesNotMatch(code, /'price-sync-outage:' \|\| inc\.id/, "لا معرّف تسلسلي في مفتاح dedupe");
assert.doesNotMatch(code, /exception\s+when/i, "فشل إدراج الرسالة يُرجع الدورة كلها (لا التقاط)");
assert.match(code, /revoke all on function private\.price_sync_monitor_tick\(timestamptz\) from public, anon, authenticated, service_role\s/);
assert.doesNotMatch(code, /grant\s+(execute|select|insert|update|delete|all)[^;]*price_sync_(monitor|incidents)/i, "لا منح لأي دور");
assert.match(code, /update private\.project_task_monitors set enabled = false where task_key = 'price-sync' and enabled;/,
  "المراقب القديم يُعطَّل لمنع التنبيه المزدوج");
assert.match(code, /cron\.schedule\('price-sync-monitor', '\* \* \* \* \*', 'select private\.price_sync_monitor_tick\(\);'\)/);
assert.match(rollback, /cron\.unschedule\('price-sync-monitor'\)/);
assert.match(rollback, /set enabled = true where task_key = 'price-sync'/);
assert.doesNotMatch(rollback.replace(/--.*$/gm, ""), /price_sync_heartbeats|notify_telegram/);

// الحارس: بصماته هي أجسام 12/13/15 في ملفاتها الحالية (ينكسر هذا الفحص إن تغيّرت الحزم دون تحديثه).
for (const [label, def, pin] of [
  ["12 monitor_project_tasks", PKG.monitor12, "fcaf57ebe99fd132762a426ffd4873e9"],
  ["13 health_lifecycle", PKG.lifecycle13, "1cd6b62f9474327d3d32e0b993c548c4"],
  ["13 ops_event_route", PKG.route13, "7228700c82cfc2948563abfc3d2025d1"],
  ["15 notify_telegram_dispatch", PKG.dispatch15, "c35b5c198c2b10b3901471bf5b1cbec1"],
  ["15 daily_open_faults_section", PKG.section15, "d5bb80ca095984e779928b57ab1f3a95"],
  ["15 sync_outage_tick", PKG.tick15, "91e6d4d8517fd766f048902d57e1a94e"]
]) {
  assert.equal(md5(def.body), pin, `بصمة ${label} في الحارس لا تطابق ملف الحزمة`);
  assert.ok(code.includes(`'${pin}'`), `الحارس لا يثبّت بصمة ${label}`);
}
assert.notEqual(md5(PKG.dispatch13.body), md5(PKG.dispatch15.body), "جسم إرسال 13 ≠ 15: الحارس يميّز 13 وحدها");
// الذرّية: لا جملة عليا تُنشئ شيئاً خارج كتل DO؛ والحارس قبل التثبيت؛ والتثبيت يتحقق من نجاحه أولاً.
const statements = topLevelStatements(migration);
for (const st of statements) {
  assert.ok(/^(do\s+\$|select set_config\('app\.price_sync_monitor_17', 'on', true\)$)/i.test(st), `جملة عليا خارج الكتل المحروسة: ${st.slice(0, 80)}`);
}
const order = statements.map((st) => (st.match(/^do\s+(\$[a-z0-9_]+\$)/i) || [, st.slice(0, 10)])[1]);
assert.deepEqual(order, ["select set", "$guard17$", "$install17$", "$post17$"], `ترتيب الكتل: ${order.join(" ")}`);
assert.match(statements[2], /^do \$install17\$\s*begin\s*if coalesce\(current_setting\('app\.price_sync_monitor_17', true\), ''\) <> 'guard-passed' then\s*raise exception/,
  "التثبيت لا يعمل إلا إن نجح الحارس في المعاملة نفسها");
assert.ok(!/execute|create |insert |update |cron\.schedule/i.test(statements[1].replace(/raise exception[^;]*;/gi, "").replace(/execute 'select min\(taken_at\)[^;]*;/g, "").replace(/execute \$q\$[\s\S]*?\$q\$\s*into[^;]*;/, "")),
  "الحارس قراءة فقط");

// التوجيه في الحزم 12/13: نوع الحدث ومفتاحه لا يقعان تحت قواعد «الملخص».
const dedupeKeys = ["price-sync-outage:3f0c2a1e-7b9d-4c1e-9a55-0d6b2c8e4f10:open", "price-sync-partial:3f0c2a1e-7b9d-4c1e-9a55-0d6b2c8e4f10:open"];
for (const rule of [/^price-sync:/, /^winfail:/, /^project-cron-failure:/, /^(price-sync:|winfail:|project-cron-failure:)/]) {
  for (const key of dedupeKeys) assert.ok(!rule.test(key), `مفتاح الحادثة ${key} يطابق قاعدة ملخص ${rule}`);
}
for (const text of [f12, f13, f15]) {
  assert.doesNotMatch(text, /price_sync_outage|price_sync_partial|price_sync_recovered|price-sync-outage|price-sync-partial/, "حزمة تعرّف نوع حدثنا");
}
console.log("  ✓ عقود ساكنة: مصدر واحد، ساعة الخادم، قفل، حادثة واحدة، بلا أسرار ولا HTML، توافق 12/13/15، حارس ذرّي ببصمات الحزم");

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

const freshDb = () => {
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const r = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
  assert.equal(r.status, 0, output(r));
};
const envBundle = envSql.replace("\\i :m16", () => m16);

// علامات «الحزمة مطبَّقة»: لقطاتها وأجسام دوالها الحقيقية من ملفاتها (البصمات نفسها التي يتحقق منها الحارس).
function packagesSql({ p12 = true, p13 = true, p15 = true, times = [1, 2, 3], dispatch15 = true, snapshot13 = true, partial15 = false, noTick15 = false, section12 = false, noCron15 = false, oldMonitor = false, migrations = null } = {}) {
  const at = (k) => `timestamptz '2026-10-21 00:00:00+00' + interval '${k} minutes'`;
  const parts = ["set check_function_bodies = off;", "create schema if not exists private;"];
  if (p12) parts.push(
    "create table if not exists private.ops_events (id int);",
    "create table if not exists private.project_task_incidents (id int);",
    "create table private.digest_bundle_snapshot (fn text primary key, def text not null, taken_at timestamptz not null default now());",
    `insert into private.digest_bundle_snapshot values ('private.monitor_project_tasks()', 'x', ${at(times[0])}), ('public.send_evening_report()', 'x', ${at(times[0])});`,
    oldMonitor ? "create or replace function private.monitor_project_tasks() returns void language plpgsql as $$ begin null; end $$;" : PKG.monitor12.sql);
  if (p13) parts.push(
    snapshot13 ? "create table private.digest_routing_snapshot (fn text primary key, def text not null, taken_at timestamptz not null default now());" : "",
    snapshot13 ? `insert into private.digest_routing_snapshot values ('private.notify_telegram_dispatch(text,text,text,integer,jsonb)', 'x', ${at(times[1])});` : "",
    PKG.route13.sql, PKG.lifecycle13.sql, PKG.dispatch13.sql);
  if (p15) parts.push(
    "create table private.sync_outage_snapshot (fn text primary key, def text not null, taken_at timestamptz not null default now());",
    `insert into private.sync_outage_snapshot values ('dispatch', 'x', ${at(times[2])}), ('section', 'x', ${at(times[2])});`,
    dispatch15 ? PKG.dispatch15.sql : "", partial15 ? "" : (section12 ? PKG.section12.sql : PKG.section15.sql), partial15 || noTick15 ? "" : PKG.tick15.sql,
    noCron15 ? "" : "select cron.schedule('sync-outage-tick', '*/5 * * * *', 'select private.sync_outage_tick()');");
  if (migrations) for (const [version, name] of migrations) parts.push(`insert into supabase_migrations.schema_migrations values ('${version}', '${name}');`);
  parts.push("reset check_function_bodies;");
  return parts.join("\n");
}
const OBJECTS17 = `select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private' and (c.relname like 'price_sync_monitor%' or c.relname like 'price_sync_incidents%'))
  + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'price_sync_monitor%')
  || ':' || (select count(*) from cron.job where jobname = 'price-sync-monitor')
  || ':' || (select enabled from private.project_task_monitors where task_key = 'price-sync')`;

const GUARD_CASES = [
  { name: "لم تُطبَّق أي حزمة", pk: { p12: false, p13: false, p15: false }, refuse: /requires proposed\/12/ },
  { name: "لقطة 12 وجداولها بلا جسم المراقب الجديد", pk: { oldMonitor: true }, refuse: /requires proposed\/12/ },
  { name: "12 فقط", pk: { p13: false, p15: false }, refuse: /requires proposed\/13/ },
  { name: "12 و13 فقط", pk: { p15: false }, refuse: /requires proposed\/15/ },
  { name: "الثلاث بالترتيب الصحيح", pk: { migrations: [["20261021000100", "digest_only_atomic_bundle"], ["20261021000200", "digest_routing_for_noncritical_alerts"], ["20261021000300", "ameen_sync_outage_incident"]] }, ok: true },
  { name: "عدد لقطات صحيح لكن جسم إرسال 13 لا 15 (معرّف خاطئ)", pk: { dispatch15: false }, refuse: /requires proposed\/15/ },
  { name: "15 جزئية: جسم الإرسال ولقطتها بلا قسم التقرير ولا sync_outage_tick", pk: { partial15: true }, refuse: /requires proposed\/15/ },
  { name: "قسم التقرير بجسم 12 لا 15 (بقية 15 مطبَّقة)", pk: { section12: true }, refuse: /requires proposed\/15/ },
  { name: "15 بلا مهمة cron sync-outage-tick", pk: { noCron15: true }, refuse: /sync-outage-tick missing/ },
  { name: "15 بلا sync_outage_tick وحدها", pk: { noTick15: true }, refuse: /requires proposed\/15/ },
  { name: "دوال 13 موجودة بلا لقطتها", pk: { snapshot13: false }, refuse: /requires proposed\/13/ },
  { name: "الثلاث لكن بترتيب خاطئ (15 قبل 13)", pk: { times: [1, 3, 2] }, refuse: /applied in that order/ },
  { name: "سجل هجرات بعدد صحيح وإصدارات معكوسة", pk: { migrations: [["3", "digest_only_atomic_bundle"], ["2", "digest_routing_for_noncritical_alerts"], ["1", "ameen_sync_outage_incident"]] }, refuse: /schema_migrations records 12\/13\/15 inconsistently/ },
  { name: "سجل هجرات بعدد صحيح ومعرّفات أخرى، بلا حزم", pk: { p12: false, p13: false, p15: false, migrations: [["1", "a_12"], ["2", "b_13"], ["3", "c_15"]] }, refuse: /requires proposed\/12/ },
  { name: "سجل ناقص (13 غير مسجّلة) مع حزم مطبَّقة", pk: { migrations: [["1", "digest_only_atomic_bundle"], ["3", "ameen_sync_outage_incident"]] }, refuse: /inconsistently/ },
  { name: "تنفيذ أمر بأمر (autocommit) مع الحزم الثلاث", pk: {}, autocommit: true, refuse: /single transaction/ }
];
let failed = false;
const guardLines = [];
for (const gc of GUARD_CASES) {
  freshDb();
  const setup = psql(["-d", DB, "-X", "-q", "-v", "ON_ERROR_STOP=1"], { input: `${envBundle}\n${packagesSql(gc.pk)}` });
  const args = gc.autocommit ? ["-d", DB, "-X", "-q"] : ["-d", DB, "-X", "-q", "--single-transaction", "-v", "ON_ERROR_STOP=1"];
  const apply = psql(args, { input: migration });
  const after = psql(["-d", DB, "-tA", "-c", OBJECTS17]).stdout.trim();
  const text = output(apply);
  let ok;
  if (gc.ok) ok = setup.status === 0 && apply.status === 0 && /^\d+:1:false$/.test(after) && Number(after.split(":")[0]) >= 10;
  else ok = setup.status === 0 && gc.refuse.test(text) && after === "0:0:true" && (gc.autocommit || apply.status !== 0);
  guardLines.push(`${ok ? "✓" : "✗"} ${gc.name} ⇒ ${gc.ok ? "طُبّق" : "رُفض"} (كائنات:cron:المراقب القديم مفعّل = ${after})`);
  if (!ok) { failed = true; console.error(gc.name, output(setup), text); }
}

// ── ٣) السلوك الكامل: الحزم الثلاث مطبَّقة، ثم كل تطبيق لـ17 في معاملة واحدة بجسم إرسال 15 مؤقتاً ─────
freshDb();
assert.ok(testSql.includes("\\i :env") && testSql.includes("\\i :packages") && testSql.includes("\\i :migration") && testSql.includes("\\i :rollback"));
const withMigration = `begin;\n${PKG.dispatch15.sql}\n${migration}\ncommit;\n${dispatchProd}`;
const bundled = testSql
  .replace("\\i :env", () => envBundle)
  .replace("\\i :packages", () => `${packagesSql()}\n${dispatchProd}`)
  .replaceAll("\\i :migration", () => withMigration)
  .replace("\\i :rollback", () => rollback);
const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
const text = output(run);
const passes = (text.match(/PASS /g) || []).length;
if (run.status !== 0 || !text.includes("PRICE_SYNC_MONITOR_OK") || /TEST FAIL/.test(text)) failed = true;

// تزامن حقيقي: 3 دورات من اتصالات منفصلة في اللحظة نفسها، في أربع حالات انتقال.
const RESET = `delete from public.price_sync_heartbeats; delete from private.price_sync_incidents;
  delete from private.price_sync_monitor_state; delete from public.telegram_outbox;`;
const HB = (minutesAgo, outcome) => `insert into public.price_sync_heartbeats
  (received_at, writer_id, kind, host, occurred_at, outcome, summary, last_success_at)
  values (now() - interval '${minutesAgo} minutes', gen_random_uuid(), 'attempt', 'OZK2026', now(), '${outcome}',
  '{"applied_wholesale":321,"applied_retail":317,"conflict_count":${outcome === "applied_with_conflicts" ? 2 : 0},"not_in_ameen":0}'::jsonb,
  ${["applied", "no_changes"].includes(outcome) ? `now() - interval '${minutesAgo} minutes'` : "null"});`;
const STATE = `insert into private.price_sync_monitor_state values (true, now() - interval '2 hours', now() - interval '1 minute', 'HEALTHY', 'applied');`;
const OPEN = (kind, state) => `insert into private.price_sync_incidents (kind, opened_at, opened_state, current_state, last_seen_at, alert_sent_at, announced_by)
  values ('${kind}', now() - interval '20 minutes', '${state}', '${state}', now() - interval '1 minute', now() - interval '20 minutes', 'monitor');`;
const SCENARIOS = [
  { name: "انقطاع قائم", setup: `${RESET} ${HB(40, "applied")} ${STATE}`,
    expect: { price_sync_outage: 1, open: 1 }, winner: "alert_sent" },
  { name: "أول تشغيل بلا حالة", setup: `${RESET} ${HB(2, "applied")}`,
    expect: { price_sync_outage: 0, open: 0 }, winner: "baseline" },
  { name: "انقطاع ← جزئي", setup: `${RESET} ${HB(40, "applied")} ${HB(6, "applied_with_conflicts")} ${HB(1, "applied_with_conflicts")} ${STATE} ${OPEN("outage", "STALE")}`,
    expect: { price_sync_partial: 1, open: 1 }, winner: "outage_to_partial" },
  { name: "تعافٍ", setup: `${RESET} ${HB(1, "applied")} ${STATE} ${OPEN("outage", "STALE")}`,
    expect: { price_sync_recovered: 1, open: 0 }, winner: "recovery_sent" }
];
const tickSql = "begin; select private.price_sync_monitor_tick(); select pg_sleep(0.5); commit;";
const parallel = () => new Promise((resolve) => {
  const child = spawn(command, argvOf(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1", "-tAc", tickSql]));
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (status) => resolve({ status, out }));
});
const concurrency = [];
if (!failed) {
  for (const scenario of SCENARIOS) {
    const setup = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1", "-c", scenario.setup]);
    const results = await Promise.all([parallel(), parallel(), parallel()]);
    const counts = {};
    for (const key of Object.keys(scenario.expect)) {
      const q = key === "open"
        ? "select count(*) from private.price_sync_incidents where closed_at is null"
        : `select count(*) from public.telegram_outbox where event_type = '${key}'`;
      counts[key] = Number(psql(["-d", DB, "-tAc", q]).stdout.trim());
    }
    const ticks = results.map((r) => (r.out.match(/\b(alert_\w+|partial_\w+|outage_to_partial|incident_\w+|healthy|baseline\w*|recovery_sent|closed_silent)\b/) || ["?"])[0]);
    const winners = ticks.filter((t) => t === scenario.winner).length;
    const ok = setup.status === 0 && results.every((r) => r.status === 0) && winners === 1
      && Object.entries(scenario.expect).every(([k, v]) => counts[k] === v);
    concurrency.push(`${ok ? "✓" : "✗"} ${scenario.name}: ${ticks.sort().join(",")} ${JSON.stringify(counts)}`);
    if (!ok) {
      failed = true;
      console.error(output(setup), results.map((r) => r.out).join("\n"));
    }
  }
}
psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);

for (const line of guardLines) console.log(`  حارس 17: ${line}`);
if (failed) {
  console.error(text);
  console.error(`concurrency:\n${concurrency.join("\n")}`);
  console.error("check-price-sync-monitor: live SQL test failed");
  process.exit(1);
}
assert.ok(passes >= 110, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
console.log(`  ✓ اختبار حي على PostgreSQL: ${passes} تأكيداً`);
for (const line of concurrency) console.log(`  تزامن (3 دورات متوازية) ${line}`);
console.log("check-price-sync-monitor: اجتاز الفحص.");
