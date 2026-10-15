import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// اختبار proposed/15 (حادثة انقطاع مزامنة الأمين الموحَّدة + القسم المسائي الموحَّد) فوق 12 و13،
// مع خط notify_telegram→dispatch→outbox بجسم الإنتاج الحرفي. **إرسال وهمي فقط**: telegram_outbox جدول محلي.
// التشغيل: PGLITE_DIR=<مسار @electric-sql/pglite> node supabase/tests/ameen-sync-outage.sim.mjs (يتخطى إن لم يتوفر).
// كل سيناريو يطبع PASS/FAIL؛ أي FAIL ⇒ خروج بخطأ.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try {
  const dir = process.env.PGLITE_DIR;
  ({ PGlite } = dir
    ? await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href)
    : await import('@electric-sql/pglite'));
} catch {
  console.log('ameen-sync-outage.sim: SKIPPED (pglite غير متاح؛ عيّن PGLITE_DIR)');
  process.exit(0);
}
const sql = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const baseMain = execFileSync('git', ['show', 'origin/main:supabase/project-task-health-monitor.sql'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).replace(/\r\n/g, '\n');
const p09 = sql('supabase/proposed/09-cron-reenabled-failed-alert-fix.sql');
const bundle = sql('supabase/proposed/12-digest-only-atomic-bundle.sql');
const p13 = sql('supabase/proposed/13-digest-routing-for-noncritical-alerts.sql');
const p15 = sql('supabase/proposed/15-ameen-sync-outage-incident.sql');
const rb12 = sql('supabase/proposed/12-digest-only-rollback.sql');
const rb13 = sql('supabase/proposed/13-digest-routing-rollback.sql');
const rb15 = sql('supabase/proposed/15-ameen-sync-outage-rollback.sql');
assert.ok(!/@@[A-Z0-9]+@@/.test(p15 + rb15), 'proposed/15: md5 placeholders not filled');

const PROD_DISPATCH = `CREATE OR REPLACE FUNCTION private.notify_telegram_dispatch(p_event_type text, p_message text, p_dedupe_key text DEFAULT NULL::text, p_dedupe_minutes integer DEFAULT 60, p_reply_markup jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_message is null or length(trim(p_message)) = 0 then return; end if;
  if p_dedupe_key is not null and exists (
    select 1 from public.telegram_outbox
    where dedupe_key = p_dedupe_key
      and created_at > now() - make_interval(mins => greatest(p_dedupe_minutes, 1))
  ) then
    return;
  end if;
  insert into public.telegram_outbox (event_type, message, dedupe_key, reply_markup)
  values (p_event_type, left(p_message, 3900), p_dedupe_key, p_reply_markup);
end;
$function$`;
const EVENING = `create or replace function public.send_evening_report() returns void language plpgsql as $f$
declare msg text; today text := to_char(now(),'YYYY-MM-DD');
begin msg := 'REPORT';
  perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);
end $f$;`;
async function liveDb() {
  const db = new PGlite();
  await db.exec(`
   create schema cron; create schema private; create role anon; create role authenticated; create role service_role;
   create table cron.job(jobid serial primary key, jobname text, active boolean default true);
   create table cron.job_run_details(jobid int, status text, start_time timestamptz);
   create function cron.schedule(a text,b text,c text) returns void language sql as $$ insert into cron.job(jobname) values (a) $$;
   create function cron.unschedule(a text) returns void language sql as $$ delete from cron.job where jobname=a $$;
   create table public.inventory_reports(source text, created_at timestamptz default now());
   create table public.khalil_audit_sync_heartbeat(created_at timestamptz default now(), status text);
   create table public.expense_entries(created_at timestamptz default now());
   create table public.telegram_outbox(id bigserial primary key, event_type text, message text, dedupe_key text, reply_markup jsonb,
     status text not null default 'pending', created_at timestamptz not null default now());
   ${PROD_DISPATCH};
   create function public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text default null, p_dedupe_minutes int default 60, p_reply_markup jsonb default null)
     returns void language sql security definer set search_path=public as $$ select private.notify_telegram_dispatch(p_event_type,p_message,p_dedupe_key,p_dedupe_minutes,p_reply_markup) $$;
  `);
  await db.exec(`select set_config('app.digest_bundle','on',false)`);
  await db.exec(baseMain); await db.exec(p09); await db.exec(EVENING);
  await db.exec(`select set_config('app.digest_bundle','',false)`);
  // سجل cron نظيف: لا مهام فاشلة تُربك عدّ الرسائل
  await db.exec(`delete from cron.job_run_details; delete from cron.job;`);
  return db;
}
const q = async (db, s, p) => (await db.query(s, p)).rows;
const one = async (db, s, p) => (await q(db, s, p))[0];
const fnMd5 = async (db, sig) => (await one(db, `select md5(prosrc) m from pg_proc where oid=to_regprocedure($1)`, [sig])).m;
const DISP = 'private.notify_telegram_dispatch(text,text,text,integer,jsonb)';
const SECT = 'private.daily_open_faults_section(timestamptz,integer)';
const L = (local) => new Date(local.replace(' ', 'T') + ':00+03:00'); // دمشق UTC+3
const iso = (d) => d.toISOString();
const addMin = (d, m) => new Date(d.getTime() + m * 60000);

const results = [];
async function scenario(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, e.message]); console.log('FAIL', name, '—', e.message); }
}

// ── «قبل»: الإنتاج الحالي (09) — كم رسالة يولّد انقطاع كامل؟ ─────────────────────────────────
const before = await liveDb();
const seedAll = async (db, at) => {
  await db.query(`insert into public.inventory_reports(source,created_at)
    select report_source,$1::timestamptz from private.project_task_monitors where source_table='inventory_reports'`, [iso(at)]);
  await db.query(`insert into public.khalil_audit_sync_heartbeat(created_at,status) values ($1,'ok')`, [iso(at)]);
  await db.query(`insert into public.expense_entries(created_at) values ($1)`, [iso(at)]);
};
await seedAll(before, new Date(Date.now() - 70 * 60000));
await before.exec('select private.monitor_project_tasks()');
const beforeCount = (await one(before, `select count(*)::int c from public.telegram_outbox where event_type='project_task_failure'`)).c;
console.log(`baseline (production 09): full 70-minute outage ⇒ ${beforeCount} separate project_task_failure messages`);

// ── «بعد»: 12 ثم 13 ثم 15 ─────────────────────────────────────────────────────────────────
const db = await liveDb();
await assert.rejects(db.exec(p15), /requires proposed\/12/);
await db.exec(bundle);
await assert.rejects(db.exec(p15), /requires proposed\/13/);
await db.exec(p13);
const disp13 = await fnMd5(db, DISP);
const sect12 = await fnMd5(db, SECT);
await db.exec(p15);
const disp15 = await fnMd5(db, DISP);
const sect15 = await fnMd5(db, SECT);
console.log(`md5: dispatch13=${disp13} section12=${sect12} dispatch15=${disp15} section15=${sect15}`);
const snapQ = `select md5(string_agg(fn||def,'|' order by fn)) s from private.sync_outage_snapshot`;
const snap1 = (await one(db, snapQ)).s;
await db.exec(p15); // إعادة التطبيق: idempotent
assert.equal((await one(db, snapQ)).s, snap1, 'snapshot unchanged on re-apply');
assert.equal(await fnMd5(db, DISP), disp15);
assert.equal((await one(db, `select count(*)::int c from cron.job where jobname='sync-outage-tick'`)).c >= 1, true);

const reset = async () => {
  await db.exec(`delete from public.telegram_outbox; delete from public.inventory_reports; delete from public.khalil_audit_sync_heartbeat;
    delete from public.expense_entries; delete from private.sync_outage_incidents; delete from private.project_task_incidents;
    delete from private.ops_events;`);
};
const tick = async (t) => (await one(db, `select private.sync_outage_tick($1::timestamptz) r`, [iso(t)])).r;
const alerts = () => q(db, `select dedupe_key, message from public.telegram_outbox where event_type like 'ameen_sync_outage%' order by id`);
const incidents = () => q(db, `select * from private.sync_outage_incidents order by id`);
// انقطاع كامل: كل المهام تنجح عند S ثم تصمت D دقيقة. دورة كل step دقائق حتى S+until. الدورة قبل عودة البيانات في الدقيقة نفسها.
async function outage(S, D, { step = 1, until = D + 20, beforeTick } = {}) {
  await reset();
  await seedAll(db, S);
  const actions = [];
  for (let m = 0; m <= until; m += step) {
    const t = addMin(S, m);
    if (beforeTick) await beforeTick(m, t);
    actions.push([m, await tick(t)]);
    if (m >= D) await seedAll(db, t);
  }
  return actions;
}
const alertMinute = (actions) => actions.filter(([, a]) => a.endsWith('=alert')).map(([m]) => m);
const recoveryMinute = (actions) => actions.filter(([, a]) => a.endsWith('=recovered')).map(([m]) => m);

await scenario('انقطاع 10 دقائق (دوام): حادثة قصيرة مسجّلة تظهر مساءً، بلا تنبيه', async () => {
  const a = await outage(L('2026-11-02 10:00'), 10);
  assert.deepEqual(alertMinute(a), []);
  const inc = await incidents();
  assert.equal(inc.length, 1);
  assert.equal(iso(inc[0].ended_at), iso(L('2026-11-02 10:11')));
  assert.equal((await alerts()).length, 0);
  const sec = (await one(db, `select private.daily_open_faults_section($1::timestamptz, 1500) s`, [iso(L('2026-11-02 23:00'))])).s;
  assert.ok(sec.includes('من \u206610:00\u2069 إلى \u206610:11\u2069 (\u206611\u2069 دقيقة)'), sec);
});
await scenario('صمت 4 دقائق (أقل من حدّ الرصد): لا شيء', async () => {
  const a = await outage(L('2026-11-02 10:00'), 4);
  assert.equal((await incidents()).length, 0);
  assert.deepEqual(alertMinute(a), []);
});
await scenario('انقطاع 35 دقيقة (دوام): حادثة مسجّلة بلا تنبيه، تظهر في التقرير المسائي', async () => {
  await outage(L('2026-11-02 10:00'), 35);
  const inc = await incidents();
  assert.equal(inc.length, 1);
  assert.equal(inc[0].alerted_at, null);
  assert.equal(iso(inc[0].started_at), iso(L('2026-11-02 10:00')));
  assert.equal(iso(inc[0].ended_at), iso(L('2026-11-02 10:36')));
  assert.equal((await alerts()).length, 0);
  const sec = (await one(db, `select private.daily_open_faults_section($1::timestamptz, 1500) s`, [iso(L('2026-11-02 23:00'))])).s;
  assert.match(sec, /أعطال انتهت خلال آخر 24 ساعة/);
  assert.ok(sec.includes('من ⁦10:00⁩ إلى ⁦10:36⁩'), sec);
  assert.ok(sec.includes('⁦36⁩ دقيقة'), sec);
  assert.match(sec, /دون تنبيه \(لم يبلغ حد الدوام\)/);
});
await scenario('انقطاع 59 دقيقة (دوام): لا تنبيه', async () => {
  const a = await outage(L('2026-11-02 10:00'), 59);
  assert.deepEqual(alertMinute(a), []);
  assert.equal((await alerts()).length, 0);
  assert.equal(Number((await incidents())[0].business_minutes), 60); // انتهى عند دورة الدقيقة 60 (البيانات عادت 59)
});
await scenario('انقطاع 60 دقيقة (دوام): تنبيه واحد عند الدقيقة 60', async () => {
  const a = await outage(L('2026-11-02 10:00'), 60);
  assert.deepEqual(alertMinute(a), [60]);
  assert.deepEqual(recoveryMinute(a), [77]); // انتهت 61 ⇒ رسالة تعافٍ واحدة بعد ثبات 15 د
  const al = (await alerts()).filter((r) => r.dedupe_key.startsWith('ameen-sync-outage:'));
  assert.equal(al.length, 1);
  assert.match(al[0].dedupe_key, /^ameen-sync-outage:OZK2026:\d+$/);
  assert.match(al[0].message, /انقطاع مزامنة الأمين/);
});
await scenario('انقطاع 90 دقيقة (دوام): تنبيه واحد + رسالة تعافٍ واحدة بعد ثبات 15 د، 9 مهام في حادثة واحدة', async () => {
  const a = await outage(L('2026-11-02 10:00'), 90, { until: 180 });
  assert.deepEqual(alertMinute(a), [60]);
  assert.deepEqual(recoveryMinute(a), [107]); // انتهت عند 91 (أول دورة بعد عودة البيانات)، والتعافي يُثبَّت بعد 15 د
  const al = await alerts();
  assert.equal(al.length, 2);
  assert.match(al[1].dedupe_key, /^ameen-sync-outage-recovered:OZK2026:\d+$/);
  assert.match(al[1].message, /عادت مزامنة الأمين/);
  assert.match(al[1].message, /كل المهام عادت للعمل/);
  const inc = await incidents();
  assert.equal(inc.length, 1);
  assert.ok(inc[0].ended_at);
  assert.ok(inc[0].recovery_sent_at);
  // صمت 90 د يشمل كل المهام عدا تفاصيل المواد (حدّها 480 د): تسع مهام في حادثة واحدة
  assert.equal(inc[0].affected_tasks.length, 9, inc[0].affected_tasks.join(','));
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox`)).c, 2, 'no other message at all');
});
await scenario('انقطاع 35 و59 دقيقة: لا رسالة تعافٍ لانقطاع لم يُنذر عنه', async () => {
  for (const d of [35, 59]) {
    const a = await outage(L('2026-11-02 10:00'), d, { step: 1, until: d + 60 });
    assert.deepEqual(recoveryMinute(a), []);
    assert.equal((await alerts()).length, 0);
  }
});
await scenario('تعافٍ كاذب: عودة البيانات لحظياً بعد الإنذار ثم انقطاع جديد خلال المهلة ⇒ لا رسالة تعافٍ، ثم واحدة عند التعافي الحقيقي', async () => {
  const S = L('2026-11-02 10:00');
  await reset(); await seedAll(db, S);
  const acts = [];
  for (let m = 0; m <= 260; m += 5) {
    const t = addMin(S, m);
    acts.push([m, await tick(t)]);
    if (m === 70) await seedAll(db, t); // نبضة واحدة (إعادة تشغيل) ثم صمت
    if (m >= 200) await seedAll(db, t); // التعافي الحقيقي
  }
  assert.deepEqual(alertMinute(acts), [60]);
  assert.deepEqual(recoveryMinute(acts), [225]); // انتهت عند 205، والتعافي يُثبَّت بعد أكثر من 15 د
  assert.equal((await alerts()).length, 2);
  assert.equal((await incidents())[0].reopened, 1);
});
await scenario('إعادة تشغيل المراقب أثناء انتظار التعافي: دورات مكررة ⇒ رسالة تعافٍ واحدة', async () => {
  const S = L('2026-11-02 10:00');
  await outage(S, 90, { step: 1, until: 140, beforeTick: async (m, t) => { if (m >= 106 && m <= 108) { await tick(t); await tick(t); } } });
  assert.equal((await alerts()).filter((r) => r.dedupe_key.startsWith('ameen-sync-outage-recovered:')).length, 1);
});
await scenario('تعافٍ جزئي مستمر: انتظار 60 د ثم رسالة واحدة «⚠️ تعافٍ جزئي» تسمّي المتأخرتين', async () => {
  const S = L('2026-11-02 10:00');
  await reset(); await seedAll(db, S);
  const acts = [];
  for (let m = 0; m <= 240; m += 5) {
    const t = addMin(S, m);
    acts.push([m, await tick(t)]);
    if (m >= 90) {
      await db.query(`insert into public.inventory_reports(source,created_at)
        select report_source,$1::timestamptz from private.project_task_monitors
        where source_table='inventory_reports' and task_key not in ('customer-balances','daily-profit')`, [iso(t)]);
      await db.query(`insert into public.khalil_audit_sync_heartbeat(created_at,status) values ($1,'ok')`, [iso(t)]);
      await db.query(`insert into public.expense_entries(created_at) values ($1)`, [iso(t)]);
    }
  }
  assert.deepEqual(alertMinute(acts), [60]);
  assert.equal(recoveryMinute(acts).length, 1);
  const recs = (await alerts()).filter((r) => r.dedupe_key.startsWith('ameen-sync-outage-recovered:'));
  assert.equal(recs.length, 1);
  assert.match(recs[0].message, /^⚠️ تعافٍ جزئي لمزامنة الأمين/);
  assert.match(recs[0].message, /ما زالت متأخرة: أرصدة الزبائن، الربح اليومي/);
  const inc = (await incidents())[0];
  const waited = (new Date(inc.recovery_sent_at) - new Date(inc.ended_at)) / 60000;
  assert.ok(waited >= 60 && waited <= 65, `waited ${waited}`);
});
await scenario('تعافٍ جزئي ثم كامل خلال الانتظار ⇒ رسالة واحدة «✅ عادت» فقط', async () => {
  const S = L('2026-11-02 10:00');
  await reset(); await seedAll(db, S);
  for (let m = 0; m <= 200; m += 5) {
    const t = addMin(S, m);
    await tick(t);
    if (m >= 120) await seedAll(db, t);
    else if (m >= 90) {
      await db.query(`insert into public.inventory_reports(source,created_at)
        select report_source,$1::timestamptz from private.project_task_monitors
        where source_table='inventory_reports' and task_key not in ('customer-balances','daily-profit')`, [iso(t)]);
      await db.query(`insert into public.khalil_audit_sync_heartbeat(created_at,status) values ($1,'ok')`, [iso(t)]);
      await db.query(`insert into public.expense_entries(created_at) values ($1)`, [iso(t)]);
    }
  }
  const recs = (await alerts()).filter((r) => r.dedupe_key.startsWith('ameen-sync-outage-recovered:'));
  assert.equal(recs.length, 1);
  assert.match(recs[0].message, /^✅ عادت مزامنة الأمين/);
  assert.match(recs[0].message, /كل المهام عادت للعمل/);
});
await scenario('انقطاع بين يومي دوام: 22:30 → 08:30 ⇒ 30 دقيقة دوام فقط، لا إنذار ولا تعافٍ، مسجّل', async () => {
  const a = await outage(L('2026-11-02 22:30'), 600, { step: 5, until: 660 });
  assert.deepEqual(alertMinute(a), []);
  assert.deepEqual(recoveryMinute(a), []);
  const inc = await incidents();
  assert.equal(inc.length, 1);
  assert.equal(Number(inc[0].business_minutes), 30);
});
await scenario('حدود الدوام: انقطاع الليلة 03:35–04:10 ⇒ لا تنبيه، مسجّل بمدته', async () => {
  const a = await outage(L('2026-10-15 03:35'), 35);
  assert.deepEqual(alertMinute(a), []);
  const inc = await incidents();
  assert.equal(inc.length, 1);
  assert.equal(Number(inc[0].business_minutes), 0);
  const sec = (await one(db, `select private.daily_open_faults_section($1::timestamptz, 1500) s`, [iso(L('2026-10-15 23:00'))])).s;
  assert.ok(sec.includes('من ⁦03:35⁩ إلى ⁦04:11⁩'), sec);
});
await scenario('حدود الدوام: بدأ 08:30 ⇒ التنبيه 10:00 (60 دقيقة دوام) لا 09:30', async () => {
  const S = L('2026-11-02 08:30');
  const a = await outage(S, 150, { step: 5, until: 160 });
  assert.deepEqual(alertMinute(a), [90]);
});
await scenario('حدود الدوام: بدأ 22:30 ومستمر للصباح ⇒ لا تنبيه ليلاً، التنبيه 09:30 (تراكمي 30+30)', async () => {
  const S = L('2026-11-02 22:30');
  const a = await outage(S, 720, { step: 5, until: 725 });
  assert.deepEqual(alertMinute(a), [660]); // 22:30 + 11h = 09:30
});
await scenario('حدود الدوام: بدأ 22:00 ⇒ التنبيه عند دورة 23:00 (مهلة السماح)', async () => {
  const a = await outage(L('2026-11-02 22:00'), 90, { step: 5, until: 95 });
  assert.deepEqual(alertMinute(a), [60]);
});
await scenario('حدود الدوام: المراقب متوقف 22:55–23:30 ⇒ لا تنبيه ليلاً، التنبيه 09:00', async () => {
  const S = L('2026-11-02 22:00');
  await reset(); await seedAll(db, S);
  const fired = [];
  for (let m = 0; m <= 700; m += 5) {
    if (m > 50 && m < 90) continue; // دورات مفقودة
    if ((await tick(addMin(S, m))).endsWith('=alert')) fired.push(m);
  }
  assert.deepEqual(fired, [660]); // 22:00 + 11h = 09:00
});
await scenario('تعدد المهام: مهمتان متوقفتان فقط ⇒ لا حادثة', async () => {
  await reset();
  const S = L('2026-11-02 10:00');
  await seedAll(db, S);
  for (let m = 1; m <= 120; m += 5) {
    const t = addMin(S, m);
    await db.query(`insert into public.inventory_reports(source,created_at)
      select report_source,$1::timestamptz from private.project_task_monitors
      where source_table='inventory_reports' and task_key not in ('ameen-main','customer-balances')`, [iso(t)]);
    await db.query(`insert into public.khalil_audit_sync_heartbeat(created_at,status) values ($1,'ok')`, [iso(t)]);
    await db.query(`insert into public.expense_entries(created_at) values ($1)`, [iso(t)]);
    await tick(t);
  }
  assert.equal((await incidents()).length, 0);
  assert.equal((await alerts()).length, 0);
});
await scenario('تعدد المهام: أعطال مزمنة قديمة + مهمة واحدة جديدة ⇒ لا حادثة (لا سبب مشترك)', async () => {
  await reset();
  const S = L('2026-11-02 10:00');
  await seedAll(db, addMin(S, -3000)); // كل شيء قديم منذ يومين…
  for (let m = 0; m <= 120; m += 5) {
    const t = addMin(S, m);
    // …ثم كل المهام تعمل ما عدا اثنتين مزمنتين؛ ameen-main تتوقف عند S
    await db.query(`insert into public.inventory_reports(source,created_at)
      select report_source,$1::timestamptz from private.project_task_monitors
      where source_table='inventory_reports' and task_key not in ('ameen-main','customer-invoices')`, [iso(t)]);
    await db.query(`insert into public.khalil_audit_sync_heartbeat(created_at,status) values ($1,'ok')`, [iso(t)]);
    if (m === 0) await db.query(`insert into public.inventory_reports(source,created_at) values ('ameen_sql_agent',$1)`, [iso(t)]);
    await tick(t);
  }
  assert.equal((await incidents()).length, 0);
});
await scenario('إعادة تشغيل المراقب: دورتان بنفس اللحظة وتكرار الدورات ⇒ تنبيه واحد', async () => {
  const S = L('2026-11-02 10:00');
  await outage(S, 100, { step: 5, until: 120, beforeTick: async (m, t) => { if (m === 60 || m === 65) await tick(t); } });
  assert.equal((await alerts()).length, 1);
});
await scenario('إعادة تشغيل المراقب: فشل الإدراج في outbox عند الدقيقة 60 ⇒ يُعاد مرة واحدة في الدورة التالية', async () => {
  const S = L('2026-11-02 10:00');
  const a = await outage(S, 100, { step: 5, until: 110, beforeTick: async (m) => {
    if (m === 60) await db.exec(`alter table public.telegram_outbox add constraint no_outage check (event_type <> 'ameen_sync_outage')`);
    if (m === 65) await db.exec(`alter table public.telegram_outbox drop constraint no_outage`);
  } });
  assert.equal(a.find(([m]) => m === 60)[1], 'OZK2026=error');
  assert.deepEqual(alertMinute(a), [65]);
  assert.equal((await alerts()).length, 1);
});
await scenario('التعافي ثم عودة الانقطاع خلال 15 دقيقة ⇒ نفس الحادثة، بلا تنبيه ثانٍ', async () => {
  const S = L('2026-11-02 10:00');
  await reset(); await seedAll(db, S);
  for (let m = 0; m <= 200; m += 5) {
    const t = addMin(S, m);
    await tick(t);
    if (m === 70) await seedAll(db, t); // تعافٍ لحظي (إعادة تشغيل الجهاز) ثم صمت جديد
  }
  const inc = await incidents();
  assert.equal(inc.length, 1, JSON.stringify(inc.map((i) => [i.started_at, i.ended_at])));
  assert.equal(inc[0].reopened, 1);
  assert.equal((await alerts()).length, 1);
});
await scenario('عطل الكاشف نفسه: 3 دورات فاشلة ⇒ تنبيه فوري واحد، ونجاح دورة يصفّر العدّاد', async () => {
  await reset();
  const S = L('2026-11-02 10:00');
  await seedAll(db, S);
  await db.exec(`alter table public.khalil_audit_sync_heartbeat rename to khalil_x`);
  const res = [];
  try {
    for (let m = 0; m <= 30; m += 5) res.push(await tick(addMin(S, m)));
  } finally { await db.exec(`alter table public.khalil_x rename to khalil_audit_sync_heartbeat`); }
  assert.ok(res.every((r) => r === 'OZK2026=error'), res.join(','));
  const rows = await q(db, `select dedupe_key, message from public.telegram_outbox where event_type='sync_outage_detector_failed'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe_key, 'sync-outage-detector-failed:OZK2026');
  assert.match(rows[0].message, /كاشف انقطاع مزامنة الأمين معطّل/);
  await tick(addMin(S, 35));
  assert.equal((await one(db, `select consecutive_errors c from private.sync_outage_config where device='OZK2026'`)).c, 0);
});
await scenario('انقطاعان منفصلان بفارق ساعتين ⇒ تنبيهان (لكل حادثة واحد)', async () => {
  const S = L('2026-11-02 10:00');
  await reset(); await seedAll(db, S);
  for (let m = 0; m <= 400; m += 5) {
    const t = addMin(S, m);
    if (m >= 90 && m <= 210) await seedAll(db, t); // سليم 11:30–13:30
    await tick(t);
  }
  assert.equal((await incidents()).length, 2);
  const keys = (await alerts()).map((r) => r.dedupe_key);
  assert.equal(keys.filter((k) => k.startsWith('ameen-sync-outage:')).length, 2);
  assert.equal(keys.filter((k) => k.startsWith('ameen-sync-outage-recovered:')).length, 1); // الأولى تعافت؛ الثانية مستمرة
});
await scenario('send_recovery=false (مفتاح إيقاف): لا رسالة تعافٍ إطلاقاً', async () => {
  await db.exec(`update private.sync_outage_config set send_recovery=false`);
  try {
    await outage(L('2026-11-02 10:00'), 90, { step: 5, until: 140 });
    assert.equal((await alerts()).length, 1);
  } finally { await db.exec(`update private.sync_outage_config set send_recovery=true`); }
});

// ── دمج تقادم المخزون ──
const stockStale = () => db.query(`select public.notify_telegram('stock_low', $1, 'stock-priority:stale:stock-stale', 360)`,
  ['⏳ تنبيهات النفاد متوقفة\nالسبب: البيانات قديمة أو ناقصة']);
// الدمج يعيد التحقق على الوقت الحقيقي now()، فهذه السيناريوهات تبدأ قبل 30 دقيقة حقيقية، بدوام كامل اليوم لتكون حتمية
const nowAnchored = () => new Date(Math.floor((Date.now() - 30 * 60000) / 60000) * 60000);
async function allDay(fn) {
  await db.exec(`update private.sync_outage_config set business_start='00:00', business_end='23:59:59'`);
  try { await fn(); } finally { await db.exec(`update private.sync_outage_config set business_start='09:00', business_end='23:00'`); }
}
await scenario('تقادم المخزون أثناء حادثة مفتوحة ⇒ يُدمج ولا يُرسل منفصلاً، ويظهر في التنبيه الوحيد', () => allDay(async () => {
  const S = nowAnchored();
  await outage(S, 100, { step: 5, until: 105, beforeTick: async (m) => { if (m === 30) await stockStale(); } });
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox where event_type='stock_low'`)).c, 0);
  const inc = (await incidents())[0];
  assert.equal(inc.stock_stale_absorbed, 1);
  const al = await alerts();
  assert.equal(al.length, 1);
  assert.match(al[0].message, /تنبيهات النفاد متوقفة أيضاً/);
}));
await scenario('حادثة مفتوحة قديمة (المراقب متوقف) والجهاز عاد ⇒ تقادم المخزون فوري، والحادثة تُغلق', async () => {
  await reset();
  const S = new Date(Date.now() - 3 * 3600000);
  await seedAll(db, S);
  await tick(addMin(S, 30)); // حادثة مفتوحة، ثم توقفت sync-outage-tick
  assert.equal((await incidents()).filter((i) => !i.ended_at).length, 1);
  await seedAll(db, new Date()); // الجهاز عاد
  await stockStale();
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox where dedupe_key='stock-priority:stale:stock-stale'`)).c, 1);
  assert.equal((await incidents()).filter((i) => !i.ended_at).length, 0);
});
await scenario('تقادم المخزون بلا انقطاع ⇒ فوري كما اليوم', async () => {
  await reset(); await seedAll(db, new Date());
  await stockStale();
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox where dedupe_key='stock-priority:stale:stock-stale'`)).c, 1);
});
await scenario('تقادم المخزون قبل أول دورة لكن الانقطاع قائم فعلاً ⇒ تُفتح الحادثة (بلا إرسال) ويُدمج', async () => {
  await reset(); await seedAll(db, new Date(Date.now() - 20 * 60000));
  await stockStale();
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox`)).c, 0);
  const inc = await incidents();
  assert.equal(inc.length, 1);
  assert.equal(inc[0].stock_stale_absorbed, 1);
  assert.equal(inc[0].alerted_at, null);
});

// ── الفوري المستقل لا يُمس ──
await scenario('التنبيهات الفورية المستقلة تبقى فورية مع 15', async () => {
  await reset();
  const cases = [
    ['security_alert', 'secur-x'], ['windows', 'ameen-backup-copy-fail'], ['windows', 'backup-failed'],
    ['price_sync_failure', 'price-sync:verify-failed'], ['sync_failure', 'winfail:apply-to-ameen'], ['sync_failure', 'winfail:pull-approved-prices'],
    ['health_check', 'health-site-down'], ['github_actions_failure', 'gha-fail:دخان ما بعد النشر'],
    ['project_task_failure', 'evening-missing:2026-11-02'], ['sync_failure', 'project-cron-failure:send-evening-report:1'],
    ['uptime', 'uptime:site:down:1'], ['windows', 'deploy-gate-crash'],
  ];
  for (const [k, key] of cases) await db.query(`select public.notify_telegram($1,$2,$3,60)`, [k, `msg ${key}`, key]);
  const got = (await q(db, `select dedupe_key from public.telegram_outbox`)).map((r) => r.dedupe_key);
  for (const [, key] of cases) assert.ok(got.some((g) => g === key || g.startsWith('price-sync:')), `missing ${key}`);
  assert.equal(got.length, cases.length);
});
await scenario('غير الحرج يبقى ملخصاً (13 كما هو): winfail دفعة بيانات لا تُرسل', async () => {
  await reset();
  await db.query(`select public.notify_telegram('sync_failure','فشل رفع الربح','winfail:push-daily-profit',60)`);
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox`)).c, 0);
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null`)).c, 1);
});

await scenario('تزامن أعطال: انقطاع + فشل أسعار فوري + عطل دفعة غير حرج + تقادم مخزون ⇒ كلٌّ في مساره', () => allDay(async () => {
  const S = nowAnchored();
  await outage(S, 100, { step: 5, until: 100, beforeTick: async (m) => {
    if (m === 30) {
      await db.query(`select public.notify_telegram('price_sync_failure','فشل التحقق','price-sync:verify-failed',60)`);
      await db.query(`select public.notify_telegram('sync_failure','فشل رفع الربح','winfail:push-daily-profit',60)`);
      await stockStale();
    }
  } });
  const rows = await q(db, `select event_type, dedupe_key from public.telegram_outbox order by id`);
  assert.deepEqual(rows.map((r) => r.event_type), ['price_sync_failure', 'ameen_sync_outage'], JSON.stringify(rows));
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null and event_key='winfail:push-daily-profit'`)).c, 1);
  assert.equal((await incidents())[0].stock_stale_absorbed, 1);
  const sec = (await one(db, `select private.daily_open_faults_section($1::timestamptz, 3000) s`, [iso(addMin(S, 100))])).s;
  assert.match(sec, /مزامنة الأمين على OZK2026/);
  assert.match(sec, /فشل رفع الربح/);
}));

// ── التقرير المسائي ──
await scenario('فشل بناء القسم ⇒ التقرير المسائي يُرسل مع سطر تعذّر الإعداد', async () => {
  await reset();
  await db.exec(`alter table private.sync_outage_incidents rename to sync_outage_incidents_x`);
  try {
    await db.exec(`select public.send_evening_report()`);
  } finally { await db.exec(`alter table private.sync_outage_incidents_x rename to sync_outage_incidents`); }
  const r = await one(db, `select message from public.telegram_outbox where event_type='evening_report'`);
  assert.ok(r, 'evening report row exists');
  assert.match(r.message, /تعذّر إعداد هذا القسم/);
});
await scenario('غياب التقرير المسائي ⇒ تنبيه فوري مستقل (evening-missing)', async () => {
  await reset();
  await db.query(`select private.check_evening_report_delivered($1::timestamptz)`, [iso(L('2099-11-02 23:20'))]);
  assert.equal((await one(db, `select count(*)::int c from public.telegram_outbox where dedupe_key='evening-missing:2099-11-02'`)).c, 1);
});
await scenario('التقرير المسائي: قسم موحَّد يطوي مهام الانقطاع ويعرض الأعطال القصيرة', async () => {
  await reset();
  const S = L('2026-11-02 12:00');
  await outage(S, 50, { step: 5, until: 60 });
  // حوادث 12 لكل مهمة ضمن نافذة الانقطاع (تُطوى) + عطل قصير مستقل غير مؤكَّد + عطل cron مستمر
  await db.query(`insert into private.project_task_incidents(task_key,started_at,confirmed_at,ended_at,last_success_at,last_seen_at,detail)
    select k, $1::timestamptz + interval '10 minutes', null, $1::timestamptz + interval '55 minutes', $1::timestamptz, $1::timestamptz, 'x'
    from unnest(array['ameen-main','customer-balances','khalil-audit','daily-profit']) k`, [iso(S)]);
  await db.query(`insert into private.project_task_incidents(task_key,started_at,confirmed_at,ended_at,last_success_at,last_seen_at,detail)
    values ('price-sync', $1::timestamptz, null, $1::timestamptz + interval '20 minutes', $1::timestamptz, $1::timestamptz, 'y')`, [iso(L('2026-11-02 16:00'))]);
  await db.query(`insert into private.ops_events(source,event_key,label,first_seen_at,last_seen_at) values ('cron','cron:x','مهمة cron فاشلة',$1,$1)`, [iso(L('2026-11-02 18:00'))]);
  const sec = (await one(db, `select private.daily_open_faults_section($1::timestamptz, 3000) s`, [iso(L('2026-11-02 23:00'))])).s;
  assert.match(sec, /^🛠 حالة الأنظمة والأعطال \(⁦1⁩\)/);
  assert.match(sec, /مهمة cron فاشلة/);
  assert.match(sec, /أعطال انتهت خلال آخر 24 ساعة \(⁦2⁩\)/, sec);
  assert.ok(sec.includes('مزامنة الأسعار: من ⁦16:00⁩ إلى ⁦16:20⁩ (⁦20⁩ دقيقة) — تعافٍ مؤكَّد (عطل قصير دون حد التأكيد)'), sec);
  assert.ok(!sec.includes('مزامنة أمين الرئيسية:'), 'member task folded under the outage');
  for (const line of sec.split('\n')) {
    assert.equal((line.match(/⁦/g) || []).length, (line.match(/⁩/g) || []).length, `bidi balance: ${line}`);
  }
  console.log('---- sample evening section ----\n' + sec + '\n--------------------------------');
});
await scenario('التقرير المسائي: انقطاع مستمر يظهر مرة واحدة مع حالته', async () => {
  await reset();
  const S = L('2026-11-02 21:00');
  await outage(S, 500, { step: 5, until: 120 });
  await db.query(`insert into private.project_task_incidents(task_key,started_at,confirmed_at,last_success_at,last_seen_at,detail)
    select k, $1::timestamptz + interval '10 minutes', now(), $1::timestamptz, now(), 'x'
    from unnest(array['ameen-main','customer-balances','khalil-audit']) k`, [iso(S)]);
  const sec = (await one(db, `select private.daily_open_faults_section($1::timestamptz, 1500) s`, [iso(L('2026-11-02 23:00'))])).s;
  assert.match(sec, /حالة الأنظمة والأعطال \(⁦1⁩\)/, sec);
  assert.match(sec, /مزامنة الأمين على OZK2026/);
  assert.match(sec, /مستمر، أُرسل تنبيه فوري/);
  assert.ok(!sec.includes('أرصدة الزبائن\n'), 'member tasks folded');
});
await scenario('التقرير المسائي: لا يتجاوز الحد مع 40 عطلاً', async () => {
  await reset();
  await db.exec(`insert into private.ops_events(source,event_key,label,first_seen_at,last_seen_at,detail)
    select 'telegram','k'||g,'عطل رقم '||g, now()-interval '3 hours', now(), repeat('تفصيل ',30) from generate_series(1,40) g;
    insert into private.ops_events(source,event_key,label,first_seen_at,last_seen_at,resolved_at,resolution)
    select 'telegram','r'||g,'منتهٍ '||g, now()-interval '5 hours', now()-interval '4 hours', now()-interval '1 hour','explicit' from generate_series(1,30) g;`);
  for (const b of [200, 600, 1500, 3900]) {
    const sec = (await one(db, `select private.daily_open_faults_section(now(), $1) s`, [b])).s;
    assert.ok(sec.length <= b, `len ${sec.length} > ${b}`);
    assert.match(sec, /حالة الأنظمة والأعطال/);
  }
});

// ── التراجع ──
await scenario('ترتيب التراجع: 13 يرفض ما دام 15 فعّالاً؛ 15 ثم 13 ثم 12 تعيد البصمات', async () => {
  await reset();
  await assert.rejects(db.exec(rb13), /proposed\/15 is active/);
  await db.exec(rb15);
  assert.equal(await fnMd5(db, DISP), disp13);
  assert.equal(await fnMd5(db, SECT), sect12);
  assert.equal((await one(db, `select count(*)::int c from cron.job where jobname='sync-outage-tick'`)).c, 0);
  assert.equal((await one(db, `select to_regclass('private.sync_outage_snapshot') r`)).r, null);
  await db.exec(rb13);
  await db.exec(rb12);
  assert.equal(await fnMd5(db, DISP), '60bbae6f1fed8ba5e66c9a9a91daed40');
  // إعادة التطبيق الكاملة بعد التراجع تعمل
  await db.exec(bundle); await db.exec(p13); await db.exec(p15);
  assert.equal(await fnMd5(db, DISP), disp15);
  assert.equal(await fnMd5(db, SECT), sect15);
});

const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n${results.length - fails.length}/${results.length} PASS`);
if (fails.length) process.exit(1);
console.log('AMEEN SYNC OUTAGE SIM OK');
