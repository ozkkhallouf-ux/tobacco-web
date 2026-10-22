// ============================================================================
// «أحداث فواتير الأمين» — إصلاحا Codex P1 على #344 (75a7fc37)، بلا تعديل ملف 18 المطبَّق.
//
//   P1-a: حدث يصل مرتين في اللحظة نفسها (طلبان متزامنان) كان الثاني يُرفض فيعزله الوكيل.
//         الإصلاح: supabase/proposed/21-ameen-invoice-events-concurrent-duplicates.sql (مقترح، غير مطبَّق).
//   P1-b: إعادة تشغيل السلسلة على قاعدة جديدة تقف عند 18 لغياب public.is_staff().
//         الإصلاح: supabase/migrations/20260914125959_is_staff_replay_prerequisite.sql (رفض افتراضي، no-op
//         حيث توجد الدالة كالإنتاج).
//
// طبقتان: عقود ساكنة (في كل مكان)، وتشغيل حي على PostgreSQL محلي مؤقت (إلزامي في CI) يشمل طلبين
// متزامنين فعلاً عبر جلستي psql، وإثبات العيب على 18 وحدها ثم زواله بعد 21.
// ============================================================================
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/^﻿/, "");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const m18Rel = "supabase/proposed/18-ameen-invoice-events.sql";
const m21Rel = "supabase/proposed/21-ameen-invoice-events-concurrent-duplicates.sql";
const r21Rel = "supabase/proposed/21-ameen-invoice-events-concurrent-duplicates-rollback.sql";
const stubRel = "supabase/migrations/20260914125959_is_staff_replay_prerequisite.sql";
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
assert.match(cStub, /raise warning '20260914125959: public\.is_staff\(\) absent/, "إنشاء البديل يُعلَن ولا يمرّ صامتاً");
assert.doesNotMatch(cStub, /create or replace function|grant |revoke |drop |alter /i, "الشرط المسبق لا يستبدل ولا يغيّر صلاحيات");
// السلسلة الفعلية (Codex P1 على 092f2ce4 و#351): كل هجرة «تتطلب» is_staff() تأتي بعد الشرط المسبق.
// التصنيف لكل استعمال على حدة (لا للملف كله — Codex P1 على bf18d616): الاستعمال «محمي» فقط إن كان
//   ١) في فرع else لـ «if to_regprocedure('public.is_staff()') is null then … else … end if»، أو في فرع then
//      لـ «if to_regprocedure('public.is_staff()') is not null … then»؛ أو
//   ٢) بعد حارس «is null then … return; end if;» في كتلة DO نفسها (خروج مبكر حين تغيب الدالة)؛ أو
//   ٣) مسبوقاً في العبارة نفسها بـ «to_regprocedure('public.is_staff()') is not null and» (حارس وقت التشغيل).
// نص رسائل raise وcomment … is لا يُعدّ استعمالاً. الملف «يؤجّل» إن كانت كل استعمالاته محمية، و«يتطلب» إن وُجد
// استعمال واحد غير محمي (ومنه حارس يرفع exception ثم يستعمل الدالة، مثل 18). «يؤجّل» حرّ الموضع.
const GUARD_COND = String.raw`to_regprocedure\('public\.is_staff\(\)'\)\s+is\s+`;
function maskMessageLiterals(c) {
  // يستبدل محتوى النصوص الحرفية التي هي رسائل (raise <level> '…' أو comment on … is '…') بمسافات، مع حفظ المواقع.
  let out = c;
  for (const m of c.matchAll(/'(?:[^']|'')*'/g)) {
    const before = c.slice(Math.max(0, m.index - 80), m.index);
    if (/(raise\s+(notice|warning|info|log|debug|exception)|\bis)\s*$/i.test(before)) {
      out = out.slice(0, m.index) + " ".repeat(m[0].length) + out.slice(m.index + m[0].length);
    }
  }
  return out;
}
function isStaffUseProtected(c, p) {
  // ٣) حارس وقت التشغيل في العبارة نفسها
  const stmtStart = c.lastIndexOf(";", p) + 1;
  if (new RegExp(`${GUARD_COND}not\\s+null\\s+and\\s+[\\s\\S]*$`, "i").test(c.slice(stmtStart, p))) return true;
  // ٢) خروج مبكر في كتلة DO نفسها
  for (const d of c.matchAll(/\bdo\s+(\$\w*\$)([\s\S]*?)\1/gi)) {
    const bodyStart = d.index + d[0].indexOf(d[1]) + d[1].length;
    const bodyEnd = bodyStart + d[2].length;
    if (p < bodyStart || p > bodyEnd) continue;
    const re = new RegExp(`\\bif\\s+${GUARD_COND}null\\s+then([\\s\\S]*?)\\bend\\s+if\\b`, "gi");
    for (const g of d[2].matchAll(re)) {
      if (bodyStart + g.index + g[0].length <= p && /\breturn\b/i.test(g[1]) && !/\braise\s+exception\b/i.test(g[1])) return true;
    }
  }
  // ١) فرع محمي لحارس if — مسح بنيوي بمكدّس (if/elsif/else/end if، وcase/end لتجاهل else التعبيرات)
  const stack = [];
  const tok = /\bend\s+if\b|\bend\s+case\b|\bend\b|\belsif\b|\belse\b|\bcase\b|\bif\b/gi;
  for (const t of c.matchAll(tok)) {
    if (t.index >= p) break;
    const w = t[0].toLowerCase().replace(/\s+/g, " ");
    if (w === "if") {
      const rest = c.slice(t.index, c.indexOf(";", t.index) === -1 ? c.length : c.indexOf(";", t.index));
      if (!/\bthen\b/i.test(rest)) continue; // «if exists» / «if not exists» في DDL ليست جملة if
      const kind = new RegExp(`^if\\s+${GUARD_COND}null\\s+then`, "i").test(rest) ? "null"
        : new RegExp(`^if\\s+${GUARD_COND}not\\s+null\\b`, "i").test(rest) ? "notnull" : "other";
      stack.push({ type: "if", kind, branch: "then" });
    } else if (w === "elsif" || w === "else") {
      const top = stack[stack.length - 1];
      if (top) top.branch = top.type === "if" && w === "elsif" ? "elsif" : "else";
    } else if (w === "case") {
      stack.push({ type: "case" });
    } else if (w === "end if") {
      while (stack.length && stack[stack.length - 1].type !== "if") stack.pop();
      stack.pop();
    } else if (w === "end case" || w === "end") {
      if (stack.length && stack[stack.length - 1].type === "case") stack.pop();
    }
  }
  return stack.some((f) => f.type === "if" && ((f.kind === "null" && f.branch === "else") || (f.kind === "notnull" && f.branch === "then")));
}
function classifyIsStaffUse(sql) {
  const c = maskMessageLiterals(code(sql));
  // وسيط to_regprocedure('public.is_staff()') هو الحارس نفسه لا استدعاء للدالة
  const uses = [...c.matchAll(/(?<!to_regprocedure\('(?:public\.)?)\bis_staff\(\)/g)].map((m) => m.index);
  if (uses.length === 0) return "none";
  return uses.every((p) => isStaffUseProtected(c, p)) ? "defers" : "requires";
}
// files: [{ name, sql }] بأي ترتيب؛ يعيد قائمة المخالفات (فارغة = سليم).
function isStaffChainViolations(files, stubName) {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!sorted.some((f) => f.name === stubName)) return [`${stubName}: الشرط المسبق غائب عن السلسلة`];
  const stubVersion = stubName.slice(0, 14);
  return sorted
    .filter((f) => f.name !== stubName && classifyIsStaffUse(f.sql) === "requires" && f.name.slice(0, 14) <= stubVersion)
    .map((f) => `${f.name}: يتطلب is_staff() قبل الشرط المسبق ${stubVersion}`);
}
// اختبار القاعدة نفسها على سلاسل مصطنعة: تنجح مع الترتيب الصحيح وتفشل عند اعتماد مفقود فعلي.
{
  const stubName = path.basename(stubRel);
  const defers = "do $$ begin if to_regprocedure('public.is_staff()') is null then raise notice 'deferred'; else create policy p on t using (is_staff()); end if; end $$;";
  const raises = "do $$ begin if to_regprocedure('public.is_staff()') is null then raise exception 'x requires public.is_staff()'; end if; end $$; create policy p on t using ((select public.is_staff()));";
  const bare = "create view v as select 1 where is_staff();";
  const unrelated = "create table t (id int);";
  assert.equal(classifyIsStaffUse(defers), "defers");
  assert.equal(classifyIsStaffUse(raises), "requires");
  assert.equal(classifyIsStaffUse(bare), "requires");
  assert.equal(classifyIsStaffUse(unrelated), "none");
  assert.equal(classifyIsStaffUse(m18), "requires", "18 تتطلب is_staff (ترفع exception حين تغيب)");
  // Codex P1 (bf18d616): حارس لا يرمي في موضع، واستعمال غير محمي في موضع آخر من الملف نفسه ⇒ «تتطلب»
  const noticeThenBare = "do $$ begin if to_regprocedure('public.is_staff()') is null then raise notice 'skip'; end if; end $$; create policy p on t using (is_staff());";
  const returnOwnBlockThenBare = "do $g$ begin if to_regprocedure('public.is_staff()') is null then raise notice 'skip'; return; end if; end $g$; create policy p on t using (is_staff());";
  const earlyReturn = "do $g$ begin if to_regprocedure('public.is_staff()') is null then raise notice 'skip public.is_staff() absent'; return; end if; if not exists (select 1) then create policy p on t using (is_staff()); end if; end $g$;";
  const runtime = "create function f() returns boolean language plpgsql as $f$ begin if (to_regprocedure('public.is_staff()') is not null and public.is_staff()) then return true; end if; return false; end $f$;";
  const notNullBlock = "do $$ begin if to_regprocedure('public.is_staff()') is not null then execute 'create policy p on t using (is_staff())'; end if; end $$;";
  const caseInside = "do $$ begin if to_regprocedure('public.is_staff()') is null then raise notice 'x'; else perform case when true then 1 else 2 end; create policy p on t using (is_staff()); end if; end $$;";
  const messageOnly = "do $$ begin raise notice 'needs public.is_staff() later'; end $$; comment on table t is 'gated by is_staff()';";
  assert.equal(classifyIsStaffUse(noticeThenBare), "requires", "حارس notice ثم استعمال خارجه ⇒ تتطلب");
  assert.equal(classifyIsStaffUse(returnOwnBlockThenBare), "requires", "return من كتلة DO أخرى لا يحمي ما بعدها ⇒ تتطلب");
  assert.equal(classifyIsStaffUse(earlyReturn), "defers", "خروج مبكر في كتلة DO نفسها يحمي ما بعده");
  assert.equal(classifyIsStaffUse(runtime), "defers", "حارس وقت التشغيل is not null and يحمي");
  assert.equal(classifyIsStaffUse(notNullBlock), "defers", "فرع then لحارس is not null يحمي");
  assert.equal(classifyIsStaffUse(caseInside), "defers", "else تعبير case لا يُربك تتبّع فرع الحارس");
  assert.equal(classifyIsStaffUse(messageOnly), "none", "نص الرسائل ليس استعمالاً");
  // الهجرات الحقيقية: الثلاث المحروسة «تؤجّل» فعلاً لكل استعمال، والأولى غير المحروسة «تتطلب»
  for (const f of ["20260827110254_add_item_guid_to_approved_price_items.sql", "20260830141802_khalil_audit_log.sql", "20260902080000_p2_heartbeat_rls_initplan.sql"]) {
    assert.equal(classifyIsStaffUse(read(`supabase/migrations/${f}`)), "defers", `${f}: كل استعمال محمي`);
  }
  const good = [
    { name: "20260827110254_defers.sql", sql: defers }, { name: stubName, sql: stub },
    { name: "20260914130000_bare.sql", sql: bare }, { name: "20261022034859_raises.sql", sql: raises },
    { name: "20261023000000_defers_late.sql", sql: defers },
  ];
  assert.deepEqual(isStaffChainViolations(good, stubName), [], "الترتيب الصحيح ينجح، وما يؤجّل حرّ الموضع");
  const bareBefore = [...good, { name: "20260901000000_bare_early.sql", sql: bare }];
  assert.deepEqual(isStaffChainViolations(bareBefore, stubName), [`20260901000000_bare_early.sql: يتطلب is_staff() قبل الشرط المسبق ${stubName.slice(0, 14)}`], "استعمال غير محروس قبل الشرط المسبق يفشل");
  const raisesBefore = [...good, { name: "20260902000000_raises_early.sql", sql: raises }];
  assert.equal(isStaffChainViolations(raisesBefore, stubName).length, 1, "هجرة ترفع exception لغياب is_staff قبل الشرط المسبق تفشل");
  assert.equal(isStaffChainViolations(good.filter((f) => f.name !== stubName), stubName).length, 1, "غياب الشرط المسبق عن السلسلة يفشل");
  // السلسلة كما ستصير بعد #344 (18 داخل migrations بإصدارها المسجَّل) سليمة
  const dir = path.join(root, "supabase/migrations");
  const real = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") }));
  const with18 = real.some((f) => f.name.startsWith("20261022034859_")) ? real : [...real, { name: "20261022034859_ameen_invoice_events.sql", sql: m18 }];
  assert.deepEqual(isStaffChainViolations(with18, stubName), [], "السلسلة الفعّالة مع 18 سليمة");
  console.log("  ✓ قاعدة ترتيب is_staff: تنجح مع الترتيب الصحيح، وتفشل لاعتماد مفقود (غير محروس أو exception قبل الشرط المسبق، أو غياب الشرط)");
}
// السلسلة الفعّالة كما هي في المستودع
{
  const dir = path.join(root, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).map((name) => ({ name, sql: readFileSync(path.join(dir, name), "utf8") }));
  assert.deepEqual(isStaffChainViolations(files, path.basename(stubRel)), [], "السلسلة الفعّالة: كل ما يتطلب is_staff() بعد الشرط المسبق");
  assert.equal(classifyIsStaffUse(read("supabase/migrations/20260914130000_bot_health_alerts_dispatched_and_failed_windows.sql")), "requires", "أول استعمال يتطلبها معروف");
}
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
const DBC = "ozk_ameen_invoice_p1_concurrency";
const countEvents = (db, guid) => run(db, `select count(*) from public.ameen_invoice_events${guid ? ` where bill_guid = '${guid}'` : ""}`).stdout.trim();

// P1-a على 18 وحدها: إثبات العيب (الطلب الثاني يُرفض، ومهلة القفل العابرة كذلك)
async function reproduceOn18() {
  freshDb(DBC, PRELUDE + PROD_IS_STAFF + m18);
  const before = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000001", 1792641146300));
  assert.equal(outcomeOf(before.a.out), "applied", before.a.out);
  assert.equal(outcomeOf(before.b.out), "rejected", `18 وحدها: متوقع إعادة إنتاج العيب\n${before.b.out}`);
  pass("18 وحدها: الحدث نفسه في طلبين متزامنين ⇒ الثاني rejected (العيب مُعاد إنتاجه)");
  const lt18 = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000002", 1792641146301), { lockTimeout: "300ms" });
  assert.equal(outcomeOf(lt18.b.out), "rejected", lt18.b.out);
  pass("18 وحدها: مهلة قفل عابرة ⇒ الحدث السليم rejected (العيب مُعاد إنتاجه)");
}

function apply21KeepsGrants() {
  const ap = run(DBC, m21);
  assert.equal(ap.status, 0, output(ap));
  const acl = run(DBC, "select has_function_privilege('anon','public.apply_ameen_invoice_events(jsonb)','execute')::text || ',' || has_function_privilege('service_role','public.apply_ameen_invoice_events(jsonb)','execute')::text || ',' || has_function_privilege('authenticated','public.apply_ameen_invoice_events(jsonb)','execute')::text || ',' || (select prosecdef::text from pg_proc where oid = 'public.apply_ameen_invoice_events(jsonb)'::regprocedure)");
  assert.equal(acl.stdout.trim(), "false,false,true,true", output(acl));
  pass("21: الصلاحيات كما هي (anon وservice_role بلا تنفيذ، authenticated فقط، SECURITY DEFINER)");
}

async function concurrentDuplicateOn21() {
  const after = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000003", 1792641146302));
  assert.equal(outcomeOf(after.a.out), "applied", after.a.out);
  assert.equal(outcomeOf(after.b.out), "duplicate", `21: الطلب الثاني يجب أن يكون duplicate\n${after.b.out}`);
  assert.equal(countEvents(DBC, "c0000000-0000-4000-8000-000000000003"), "1");
  pass("21: الحدث نفسه في طلبين متزامنين ⇒ applied ثم duplicate، وصف حدث واحد فقط");
}

async function lockTimeoutOn21() {
  const lt21 = await concurrentSameEvent(DBC, invoiceEvent("c0000000-0000-4000-8000-000000000004", 1792641146303), { lockTimeout: "300ms" });
  assert.notEqual(lt21.b.status, 0, "21: مهلة القفل تُفشل الطلب كله");
  assert.match(lt21.b.out, /lock timeout/i);
  assert.equal(outcomeOf(lt21.b.out), null, "21: لا نتيجة rejected لحدث سليم");
  assert.equal(countEvents(DBC, "c0000000-0000-4000-8000-000000000004"), "1");
  pass("21: مهلة قفل عابرة ⇒ الطلب يفشل كله (يعيده الوكيل بتراجع) ولا يُرفض الحدث");
}

function sequentialRetryOn21() {
  const def = run(DBC, session([invoiceEvent("c0000000-0000-4000-8000-000000000003", 1792641146302)]));
  assert.equal(outcomeOf(def.stdout), "duplicate", output(def));
  pass("21: إعادة إرسال متتالية للحدث نفسه ⇒ duplicate");
}

function rollback21KeepsData() {
  const rb = run(DBC, r21);
  assert.equal(rb.status, 0, output(rb));
  assert.equal(countEvents(DBC), "4");
  pass("21-rollback: يعيد جسم 18 ولا يمسّ الأحداث المسجّلة");
}

// P1-b: إعادة تشغيل على قاعدة جديدة بلا is_staff
function replayFreshDatabase() {
  const DBR = "ozk_ameen_invoice_p1_replay";
  freshDb(DBR, PRELUDE);
  const without = run(DBR, m18);
  assert.notEqual(without.status, 0, "بلا الشرط المسبق: 18 تتوقف (العيب مُعاد إنتاجه)");
  assert.match(output(without), /requires public\.is_staff\(\)/);
  pass("قاعدة جديدة بلا الشرط المسبق: 18 تتوقف عند is_staff (العيب مُعاد إنتاجه)");
  const outs = [];
  for (const [sql, what] of [[stub, "الشرط المسبق"], [m18, "18 بعد الشرط المسبق"], [stub, "إعادة الشرط المسبق"]]) {
    const r = run(DBR, sql);
    assert.equal(r.status, 0, `${what}\n${output(r)}`);
    outs.push(output(r));
  }
  // لا يُخفي الاعتماد المفقود: إنشاء البديل يُعلَن بـ WARNING، وإعادة التشغيل (الدالة موجودة) صامتة
  assert.match(outs[0], /WARNING:\s+20260914125959: public\.is_staff\(\) absent — created deny-by-default stub/, outs[0]);
  assert.doesNotMatch(outs[2], /WARNING/, outs[2]);
  pass("قاعدة جديدة: إنشاء البديل يرفع WARNING صريحاً (لا يُخفي غياب is_staff)، والتشغيل الثاني صامت");
  const st = run(DBR, "select public.is_staff()::text || ',' || (select count(*) from pg_policies where tablename like 'ameen_invoice%')::text");
  assert.equal(st.stdout.trim(), "false,3", output(st));
  pass("قاعدة جديدة: الشرط المسبق ثم 18 ⇒ تُطبَّق، 3 سياسات، is_staff() = false (رفض افتراضي)، وإعادة التشغيل آمنة");
  const r21r = run(DBR, m21);
  assert.equal(r21r.status, 0, output(r21r));
  pass("قاعدة جديدة: 21 تُطبَّق بعد 18 بلا خطأ");
}

// الشرط المسبق no-op حيث توجد is_staff (كالإنتاج)
function stubIsNoOpOnProductionLike() {
  const DBP = "ozk_ameen_invoice_p1_prodlike";
  freshDb(DBP, PRELUDE + PROD_IS_STAFF);
  const sig = "select md5(prosrc) || '|' || coalesce(proacl::text,'') || '|' || prosecdef::text || '|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = 'public.is_staff()'::regprocedure";
  const b0 = run(DBP, sig).stdout.trim();
  const s3 = run(DBP, stub);
  assert.equal(s3.status, 0, output(s3));
  assert.doesNotMatch(output(s3), /WARNING/, "كالإنتاج: لا بديل ولا تحذير");
  assert.equal(run(DBP, sig).stdout.trim(), b0, "الشرط المسبق لا يغيّر is_staff الموجودة");
  pass("قاعدة كالإنتاج: الشرط المسبق لا يغيّر جسم is_staff ولا صلاحياتها ولا خصائصها");
}

// مجموعة 18 الكاملة (139 تأكيداً) مع 21 مطبَّقة فوقها: لا تراجع في الدلالات
function fullSuiteWith21() {
  const DBS = "ozk_ameen_invoice_events_test";
  freshDb(DBS, null);
  const bundled = read(suiteRel).replace("\\i :migration", () => `${m18}\n${m21}`).replace("\\i :rollback", () => read("supabase/proposed/18-ameen-invoice-events-rollback.sql"));
  const sr = psql(["-d", DBS, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
  const text = output(sr);
  const n = (text.match(/PASS /g) || []).length;
  assert.ok(sr.status === 0 && text.includes("AMEEN_INVOICE_EVENTS_OK") && !/TEST FAIL/.test(text) && n >= 139, text);
  pass(`مجموعة 18 كاملة مع 21 فوقها: ${n} تأكيداً بلا فشل`);
}

try {
  await reproduceOn18();
  apply21KeepsGrants();
  await concurrentDuplicateOn21();
  await lockTimeoutOn21();
  sequentialRetryOn21();
  rollback21KeepsData();
  replayFreshDatabase();
  stubIsNoOpOnProductionLike();
  fullSuiteWith21();
} finally {
  for (const d of dbs) psql(["-d", "postgres", "-c", `drop database if exists ${d}`]);
}
assert.ok(passes >= 13, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
console.log(`check-ameen-invoice-events-p1: اجتاز الفحص (${passes} سيناريو حي).`);
