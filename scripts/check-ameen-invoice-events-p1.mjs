// ============================================================================
// «أحداث فواتير الأمين» — إصلاحا Codex P1 على #344 (75a7fc37)، بلا تعديل ملف 18 المطبَّق.
//
//   P1-a: حدث يصل مرتين في اللحظة نفسها (طلبان متزامنان) كان الثاني يُرفض فيعزله الوكيل.
//         الإصلاح: supabase/proposed/21-ameen-invoice-events-concurrent-duplicates.sql (مقترح، غير مطبَّق).
//   P1-b: إعادة تشغيل السلسلة على قاعدة جديدة تقف عند 18 لغياب public.is_staff().
//         الإصلاح: supabase/migrations/20261022034858_is_staff_replay_prerequisite.sql (رفض افتراضي، no-op
//         حيث توجد الدالة كالإنتاج).
//
// طبقتان: عقود ساكنة (في كل مكان)، وتشغيل حي على PostgreSQL محلي مؤقت (إلزامي في CI) يشمل طلبين
// متزامنين فعلاً عبر جلستي psql، وإثبات العيب على 18 وحدها ثم زواله بعد 21.
// ============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/^﻿/, "");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const m18Rel = "supabase/proposed/18-ameen-invoice-events.sql";
const m21Rel = "supabase/proposed/21-ameen-invoice-events-concurrent-duplicates.sql";
const r21Rel = "supabase/proposed/21-ameen-invoice-events-concurrent-duplicates-rollback.sql";
const stubRel = "supabase/migrations/20261022034858_is_staff_replay_prerequisite.sql";
const suiteRel = "supabase/tests/ameen-invoice-events.sql";
const m18 = read(m18Rel), m21 = read(m21Rel), r21 = read(r21Rel), stub = read(stubRel);

// ── ١) عقود ساكنة ─────────────────────────────────────────────────────────────────────────────
// ملف 18 كما طُبّق على الإنتاج 2026-10-22 (الإصدار 20261022034859) — لا يُمسّ.
assert.equal(sha256(readFileSync(path.join(root, m18Rel), "utf8")), "f7c6e491b97d1e00df7f549d0cf7e1543f0280cce7f0fa73346c0500fbb16c79", "proposed/18 يجب أن يبقى مطابقاً للنسخة المطبَّقة");

const code = (s) => s.replace(/--.*$/gm, "");
const c21 = code(m21);
const lockAt = c21.indexOf("pg_advisory_xact_lock");
const dupAt = c21.indexOf("from public.ameen_invoice_events x where x.event_id = v_id");
assert.ok(lockAt > 0 && dupAt > lockAt, "21: القفل الاستشاري للفاتورة قبل فحص التكرار");
assert.equal((c21.match(/pg_advisory_xact_lock/g) || []).length, 1, "21: قفل واحد لكل حدث");
assert.match(c21, /when unique_violation then\s+get stacked diagnostics v_constraint = constraint_name;\s+if v_constraint = 'ameen_invoice_events_pkey' then/, "21: تعارض مفتاح الحدث ⇒ duplicate");
assert.match(c21, /when sqlstate '40P01' or sqlstate '40001' or sqlstate '55P03' or sqlstate '57014' then\s+raise;/, "21: الأخطاء العابرة تُفشل الطلب لا الحدث");
assert.doesNotMatch(c21, /\b(create|alter|drop)\s+(table|policy|view|index)\b|\binsert\s+into\s+public\.(?!ameen_invoice)/i, "21: لا جداول ولا سياسات — جسم الدالة فقط");
assert.match(c21, /revoke all on function public\.apply_ameen_invoice_events\(jsonb\) from public, anon, service_role;/);
assert.match(c21, /grant execute on function public\.apply_ameen_invoice_events\(jsonb\) to authenticated;/);
assert.match(c21, /security definer\s+set search_path = ''/);
assert.match(c21, /if not public\.ameen_invoice_is_sync_writer\(\) then/, "21: هوية المزامنة وحدها كما في 18");
// التراجع = جسم 18 حرفياً
const fn18 = m18.slice(m18.indexOf("create or replace function public.apply_ameen_invoice_events"), m18.indexOf("notify pgrst"));
assert.ok(fn18.length > 1000 && r21.includes(fn18.trim()), "21-rollback يعيد جسم 18 حرفياً");
// الشرط المسبق: لا يُنشئ إلا إن غابت الدالة، ورفض افتراضي فقط
const cStub = code(stub);
assert.match(cStub, /if to_regprocedure\('public\.is_staff\(\)'\) is null then/, "الشرط المسبق محروس بغياب الدالة");
assert.match(cStub, /\$body\$ select false \$body\$/, "البديل رفض افتراضي");
assert.doesNotMatch(cStub, /create or replace function|grant |revoke |drop |alter /i, "الشرط المسبق لا يستبدل ولا يغيّر صلاحيات");
assert.ok("20261022034858" < "20261022034859", "الشرط المسبق يسبق 18 في الترتيب");
console.log("  ✓ عقود ساكنة: 18 بلا مساس، 21 جسم الدالة فقط، الشرط المسبق رفض افتراضي محروس");

// ── ٢) تشغيل حي على PostgreSQL محلي ──────────────────────────────────────────────────────────
function psqlArgs(args) {
  const viaTcp = Boolean(process.env.PGHOST);
  return viaTcp ? ["psql", args] : ["sudo", ["-n", "-u", "postgres", "psql", ...args]];
}
function psql(args, options = {}) {
  const [cmd, argv] = psqlArgs(args);
  return spawnSync(cmd, argv, { encoding: "utf8", ...options });
}
function psqlAsync(args, input) {
  const [cmd, argv] = psqlArgs(args);
  return new Promise((resolve) => {
    const p = spawn(cmd, argv);
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (status) => resolve({ status, out }));
    p.stdin.end(input);
  });
}
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-ameen-invoice-events-p1: refusing non-local PGHOST");
  process.exit(1);
}
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    process.exit(1);
  }
  console.log("  - SQL حي: متخطى (لا PostgreSQL محلي)");
  console.log("check-ameen-invoice-events-p1: اجتاز الفحص (ساكن فقط).");
  process.exit(0);
}

const SYNC = "9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3";
const PRELUDE = `
do $r$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $r$;
grant usage on schema public to anon, authenticated, service_role;
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif((coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb) ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;
// جسم is_staff كما على الإنتاج (نفس نسخة supabase/tests/ameen-invoice-events.sql)
const PROD_IS_STAFF = `
create table public.staff_allowlist (email text primary key);
create or replace function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''))
  );
$$;
grant execute on function public.is_staff() to anon, authenticated, service_role;
`;
const dbs = [];
function freshDb(name, sql) {
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${name}`]);
  const c = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${name}`]);
  assert.equal(c.status, 0, output(c));
  dbs.push(name);
  if (sql) {
    const r = psql(["-d", name, "-X", "-v", "ON_ERROR_STOP=1", "-q"], { input: sql });
    assert.equal(r.status, 0, `${name}: ${output(r)}`);
  }
}
const run = (db, sql) => psql(["-d", db, "-X", "-v", "ON_ERROR_STOP=1", "-q", "-At"], { input: sql });

function invoiceEvent(guid, seq) {
  const hash = sha256(`v|${guid}|${seq}`);
  const at = "2026-10-22T10:00:00.000Z";
  return {
    schema: "ameen-invoice-event/v1", kind: "upsert", bill_guid: guid, version_hash: hash, source_event_at: at,
    source_seq: seq, detected_at: at, event_id: sha256(`${guid}|${seq}|upsert|${hash}|${at}`),
    bill: { bill_guid: guid, bill_type: 1, bill_date: "2026-10-22", lines: [], total: 10 },
  };
}
const session = (events, { sleep = 0, lockTimeout = null } = {}) => `
\\set ON_ERROR_STOP 1
begin;
select set_config('request.jwt.claims', '{"sub":"${SYNC}","role":"authenticated"}', true) \\g /dev/null
${lockTimeout ? `set local lock_timeout = '${lockTimeout}';` : ""}
set local role authenticated;
select 'RESULT ' || public.apply_ameen_invoice_events($ev$${JSON.stringify(events)}$ev$::jsonb)::text;
${sleep ? `select pg_sleep(${sleep}) \\g /dev/null` : ""}
commit;
`;
const outcomeOf = (text) => {
  const m = text.match(/RESULT (\{.*\})/);
  return m ? JSON.parse(m[1]).results[0].outcome : null;
};
// طلبان متزامنان يحملان الحدث نفسه: A يطبّقه ويمسك المعاملة ثانيتين، وB يبدأ أثناءها.
async function concurrentSameEvent(db, ev, bOptions = {}) {
  const a = psqlAsync(["-d", db, "-X", "-q", "-At"], session([ev], { sleep: 2 }));
  await new Promise((r) => setTimeout(r, 600));
  const b = psqlAsync(["-d", db, "-X", "-q", "-At"], session([ev], bOptions));
  return { a: await a, b: await b };
}

let passes = 0;
const pass = (name) => { passes++; console.log(`  ✓ ${name}`); };
try {
  // P1-a على 18 وحدها: إثبات العيب (الطلب الثاني يُرفض)
  const DBC = "ozk_ameen_invoice_p1_concurrency";
  freshDb(DBC, PRELUDE + PROD_IS_STAFF + m18);
  const before = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000001", 1792641146300));
  assert.equal(outcomeOf(before.a.out), "applied", before.a.out);
  assert.equal(outcomeOf(before.b.out), "rejected", `18 وحدها: متوقع إعادة إنتاج العيب\n${before.b.out}`);
  pass("18 وحدها: الحدث نفسه في طلبين متزامنين ⇒ الثاني rejected (العيب مُعاد إنتاجه)");
  // مهلة قفل على 18: الحدث السليم يُرفض أيضاً
  const lt18 = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000002", 1792641146301), { lockTimeout: "300ms" });
  assert.equal(outcomeOf(lt18.b.out), "rejected", lt18.b.out);
  pass("18 وحدها: مهلة قفل عابرة ⇒ الحدث السليم rejected (العيب مُعاد إنتاجه)");

  // تطبيق 21 على القاعدة نفسها
  const ap = run(DBC, m21);
  assert.equal(ap.status, 0, output(ap));
  const acl = run(DBC, "select has_function_privilege('anon','public.apply_ameen_invoice_events(jsonb)','execute')::text || ',' || has_function_privilege('service_role','public.apply_ameen_invoice_events(jsonb)','execute')::text || ',' || has_function_privilege('authenticated','public.apply_ameen_invoice_events(jsonb)','execute')::text || ',' || (select prosecdef::text from pg_proc where oid = 'public.apply_ameen_invoice_events(jsonb)'::regprocedure)");
  assert.equal(acl.stdout.trim(), "false,false,true,true", output(acl));
  pass("21: الصلاحيات كما هي (anon وservice_role بلا تنفيذ، authenticated فقط، SECURITY DEFINER)");

  const after = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000003", 1792641146302));
  assert.equal(outcomeOf(after.a.out), "applied", after.a.out);
  assert.equal(outcomeOf(after.b.out), "duplicate", `21: الطلب الثاني يجب أن يكون duplicate\n${after.b.out}`);
  const rows = run(DBC, "select count(*) from public.ameen_invoice_events where bill_guid = 'c0000000-0000-4000-8000-000000000003'");
  assert.equal(rows.stdout.trim(), "1");
  pass("21: الحدث نفسه في طلبين متزامنين ⇒ applied ثم duplicate، وصف حدث واحد فقط");

  const lt21 = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000004", 1792641146303), { lockTimeout: "300ms" });
  assert.notEqual(lt21.b.status, 0, "21: مهلة القفل تُفشل الطلب كله");
  assert.match(lt21.b.out, /lock timeout/i);
  assert.equal(outcomeOf(lt21.b.out), null, "21: لا نتيجة rejected لحدث سليم");
  const rows4 = run(DBC, "select count(*) from public.ameen_invoice_events where bill_guid = 'c0000000-0000-4000-8000-000000000004'");
  assert.equal(rows4.stdout.trim(), "1");
  pass("21: مهلة قفل عابرة ⇒ الطلب يفشل كله (يعيده الوكيل بتراجع) ولا يُرفض الحدث");

  // دفاع ثانٍ: تعارض المفتاح يُعامل duplicate حتى لو فات فحص التكرار
  const def = run(DBC, `
    begin;
    select set_config('request.jwt.claims', '{"sub":"${SYNC}","role":"authenticated"}', true) \\g /dev/null
    set local role authenticated;
    select 'RESULT ' || public.apply_ameen_invoice_events($ev$${JSON.stringify([invoiceEvent("c0000000-0000-4000-8000-000000000003", 1792641146302)])}$ev$::jsonb)::text;
    commit;`);
  assert.equal(outcomeOf(def.stdout), "duplicate", output(def));
  pass("21: إعادة إرسال متتالية للحدث نفسه ⇒ duplicate");

  // التراجع يعيد جسم 18 (والعيب معه) بلا مساس بالبيانات
  const rb = run(DBC, r21);
  assert.equal(rb.status, 0, output(rb));
  const kept = run(DBC, "select count(*) from public.ameen_invoice_events");
  assert.equal(kept.stdout.trim(), "4");
  pass("21-rollback: يعيد جسم 18 ولا يمسّ الأحداث المسجّلة");

  // P1-b: إعادة تشغيل على قاعدة جديدة بلا is_staff
  const DBR = "ozk_ameen_invoice_p1_replay";
  freshDb(DBR, PRELUDE);
  const without = run(DBR, m18);
  assert.notEqual(without.status, 0, "بلا الشرط المسبق: 18 تتوقف (العيب مُعاد إنتاجه)");
  assert.match(output(without), /requires public\.is_staff\(\)/);
  pass("قاعدة جديدة بلا الشرط المسبق: 18 تتوقف عند is_staff (العيب مُعاد إنتاجه)");
  const s1 = run(DBR, stub);
  assert.equal(s1.status, 0, output(s1));
  const m = run(DBR, m18);
  assert.equal(m.status, 0, `بعد الشرط المسبق: 18 تُطبَّق\n${output(m)}`);
  const s2 = run(DBR, stub);
  assert.equal(s2.status, 0, "الشرط المسبق قابل لإعادة التشغيل");
  const st = run(DBR, "select public.is_staff()::text || ',' || (select count(*) from pg_policies where tablename like 'ameen_invoice%')::text");
  assert.equal(st.stdout.trim(), "false,3", output(st));
  pass("قاعدة جديدة: الشرط المسبق ثم 18 ⇒ تُطبَّق، 3 سياسات، is_staff() = false (رفض افتراضي)، وإعادة التشغيل آمنة");
  const r21r = run(DBR, m21);
  assert.equal(r21r.status, 0, output(r21r));
  pass("قاعدة جديدة: 21 تُطبَّق بعد 18 بلا خطأ");

  // الشرط المسبق no-op حيث توجد is_staff (كالإنتاج)
  const DBP = "ozk_ameen_invoice_p1_prodlike";
  freshDb(DBP, PRELUDE + PROD_IS_STAFF);
  const sig = "select md5(prosrc) || '|' || coalesce(proacl::text,'') || '|' || prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = 'public.is_staff()'::regprocedure";
  const b0 = run(DBP, sig).stdout.trim();
  const s3 = run(DBP, stub);
  assert.equal(s3.status, 0, output(s3));
  assert.equal(run(DBP, sig).stdout.trim(), b0, "الشرط المسبق لا يغيّر is_staff الموجودة");
  pass("قاعدة كالإنتاج: الشرط المسبق لا يغيّر جسم is_staff ولا صلاحياتها ولا خصائصها");

  // مجموعة 18 الكاملة (139 تأكيداً) مع 21 مطبَّقة فوقها: لا تراجع في الدلالات
  const DBS = "ozk_ameen_invoice_events_test";
  freshDb(DBS, null);
  const suite = read(suiteRel);
  const bundled = suite.replace("\\i :migration", () => `${m18}\n${m21}`).replace("\\i :rollback", () => read("supabase/proposed/18-ameen-invoice-events-rollback.sql"));
  const sr = psql(["-d", DBS, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
  const st2 = output(sr);
  const n = (st2.match(/PASS /g) || []).length;
  assert.ok(sr.status === 0 && st2.includes("AMEEN_INVOICE_EVENTS_OK") && !/TEST FAIL/.test(st2) && n >= 139, st2);
  pass(`مجموعة 18 كاملة مع 21 فوقها: ${n} تأكيداً بلا فشل`);
} finally {
  for (const d of dbs) psql(["-d", "postgres", "-c", `drop database if exists ${d}`]);
}
assert.ok(passes >= 11, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
console.log(`check-ameen-invoice-events-p1: اجتاز الفحص (${passes} سيناريو حي).`);
