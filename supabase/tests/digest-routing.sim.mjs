import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// اختبار proposed/13 (توجيه الأعطال غير الحرجة للملخص): يُشغَّل فوق الحزمة 12 مع خط notify_telegram→dispatch→outbox
// بجسم الإنتاج الحرفي (md5 60bbae6f…). بلا Telegram: telegram_outbox جدول محلي فقط.
// التشغيل: PGLITE_DIR=<مسار @electric-sql/pglite> node supabase/tests/digest-routing.sim.mjs (يتخطى إن لم يتوفر).
// وقد شُغّل أيضاً حرفياً على PostgreSQL 17.6 الحقيقي (نفس إصدار الإنتاج).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try {
  const dir = process.env.PGLITE_DIR;
  ({ PGlite } = dir
    ? await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href)
    : await import('@electric-sql/pglite'));
} catch {
  console.log('digest-routing.sim: SKIPPED (pglite غير متاح؛ عيّن PGLITE_DIR)');
  process.exit(0);
}
const sql = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const baseMain = execFileSync('git', ['show', 'origin/main:supabase/project-task-health-monitor.sql'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).replace(/\r\n/g, '\n');
const p09 = sql('supabase/proposed/09-cron-reenabled-failed-alert-fix.sql');
const bundle = sql('supabase/proposed/12-digest-only-atomic-bundle.sql');
const p13 = sql('supabase/proposed/13-digest-routing-for-noncritical-alerts.sql');
const rb12 = sql('supabase/proposed/12-digest-only-rollback.sql');
const rb13 = sql('supabase/proposed/13-digest-routing-rollback.sql');
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
   create function cron.schedule(a text,b text,c text) returns void language sql as 'select';
   create function cron.unschedule(a text) returns void language sql as 'select';
   create table public.inventory_reports(source text, created_at timestamptz default now());
   create table public.khalil_audit_sync_heartbeat(created_at timestamptz default now(), status text);
   create table public.expense_entries(created_at timestamptz default now());
   create table public.telegram_outbox(id bigserial primary key, event_type text, message text, dedupe_key text, reply_markup jsonb,
     status text not null default 'pending', created_at timestamptz not null default now());
   ${PROD_DISPATCH};
   create function public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text default null, p_dedupe_minutes int default 60, p_reply_markup jsonb default null)
     returns void language sql security definer set search_path=public as $$ select private.notify_telegram_dispatch(p_event_type,p_message,p_dedupe_key,p_dedupe_minutes,p_reply_markup) $$;
  `);
  await db.exec(baseMain); await db.exec(p09); await db.exec(EVENING);
  await db.exec(`update private.project_task_monitors set enabled=false where task_key not in ('customer-balances','price-sync')`);
  return db;
}
const q = async (db, s, p) => (await db.query(s, p)).rows;
const one = async (db, s, p) => (await q(db, s, p))[0];
const md5 = async (db) => (await one(db, `select md5(prosrc) m from pg_proc where oid='private.notify_telegram_dispatch(text,text,text,integer,jsonb)'::regprocedure`)).m;
const notify = (db, k, m, key = null, mins = 60, rm = null) =>
  db.query(`select public.notify_telegram($1,$2,$3,$4,$5::jsonb)`, [k, m, key, mins, rm]);
const outbox = (db) => q(db, 'select event_type,dedupe_key from public.telegram_outbox order by id');
const open = (db) => q(db, `select source,event_key from private.ops_events where resolved_at is null order by event_key`);
const PROD = '60bbae6f1fed8ba5e66c9a9a91daed40';

const db = await liveDb();
assert.equal(await md5(db), PROD, 'fixture != production body');
await assert.rejects(db.exec(p13), /requires proposed\/12/);
assert.equal(await md5(db), PROD);
await db.exec(bundle);
await db.exec(p13);
const h1 = await md5(db);
assert.notEqual(h1, PROD);
const snapQ = `select md5(string_agg(fn||def,'|' order by fn)) s from private.digest_routing_snapshot`;
const snap1 = await one(db, snapQ);
await db.exec(p13);
assert.equal(await md5(db), h1);
assert.equal((await one(db, snapQ)).s, snap1.s, 'snapshot unchanged on re-apply');
assert.equal((await one(db, 'select count(*)::int c from private.digest_routing_snapshot')).c, 3);

const R = async (k, key) => (await one(db, 'select private.ops_event_route($1,$2) r', [k, key])).r;
for (const [k, key, want] of [
  ['security_alert', 'x', 'immediate'], ['windows', 'backup-failed', 'immediate'], ['sync_failure', 'auth-x', 'immediate'],
  ['health_check', 'health-site-down', 'immediate'], ['health_check', 'health-health-check-crashed', 'immediate'],
  ['health_check', 'health-workflow-x', 'digest'],
  ['github_actions_failure', 'gha-fail:دخان ما بعد النشر', 'immediate'], ['github_actions_failure', 'gha-fail:فحص صحة المشروع', 'immediate'],
  ['github_actions_failure', 'gha-fail:CI', 'digest'],
  ['sync_failure', 'x', 'digest'], ['price_sync_mismatch', 'price-sync:1', 'digest'], ['windows', 'winfail:t', 'digest'],
  ['evening_report', 'evening:2026-01-01', 'immediate'], ['project_task_failure', 'k', 'immediate'],
  ['weird_unknown', null, 'immediate'], ['', '', 'immediate'], ['order_new', 'o1', 'immediate'],
  ['sync_failure', 'project-cron-failure:send-evening-report:20260101:x', 'immediate'], ['report', 'evening-missing:2026-01-01', 'immediate'],
  ['sync_failure', 'project-cron-failure:other-job:1', 'digest'],
]) assert.equal(await R(k, key), want, `${k}/${key}`);
console.log('route matrix ok');

await notify(db, 'windows', '⚠️ فشلت مهمة ويندوز X\nتفاصيل', 'winfail:ameen-pull');
await notify(db, 'sync_failure', 'فشل المزامنة', 'sync-y');
await notify(db, 'health_check', 'workflow فاشل', 'health-workflow-ci');
assert.deepEqual(await outbox(db), [], 'digest alerts must not enqueue');
assert.deepEqual((await open(db)).map((r) => r.event_key), ['health-workflow-ci', 'sync-y', 'winfail:ameen-pull']);
await notify(db, 'security_alert', 'اختراق', 'sec1');
await notify(db, 'health_check', 'الموقع واقع', 'health-site-down');
await notify(db, 'order_new', 'طلب', 'o1');
await notify(db, 'windows', 'نسخ احتياطي فشل', 'backup-x');
await notify(db, 'evening_report', 'REPORT', 'evening:d');
await notify(db, 'windows', 'رسالة بزر', 'winfail:btn', 60, '{"inline_keyboard":[]}');
await notify(db, 'brand_new_kind', 'نوع جديد', null);
assert.deepEqual((await outbox(db)).map((r) => r.dedupe_key), ['sec1', 'health-site-down', 'o1', 'backup-x', 'evening:d', 'winfail:btn', null]);
await notify(db, 'security_alert', 'اختراق', 'sec1');
assert.equal((await outbox(db)).length, 7, 'immediate dedupe unchanged');
await notify(db, 'windows', '  ', 'winfail:e');
assert.equal((await open(db)).length, 3);
console.log('dispatch ok');

for (let i = 0; i < 5; i++) await notify(db, 'windows', 'تكرار', 'winfail:ameen-pull');
assert.equal((await q(db, `select 1 from private.ops_events where event_key='winfail:ameen-pull'`)).length, 1);

const sec = (await one(db, 'select private.daily_open_faults_section(now(), 1500) s')).s;
console.log(sec);
assert.ok(sec.includes('تكرار'), 'section lacks the windows fault');

// fail-open
const saved = await one(db, `select pg_get_functiondef('private.observe_ops_event(text,text,text,text,timestamptz,text)'::regprocedure) d`);
await db.exec(`create or replace function private.observe_ops_event(p_source text,p_event_key text,p_label text,p_detail text default null,p_since timestamptz default null,p_severity text default 'digest') returns void language plpgsql as $$ begin raise exception 'boom'; end $$`);
const before = (await outbox(db)).length;
await notify(db, 'sync_failure', 'يجب ألا يضيع', 'sync-failopen');
assert.equal((await outbox(db)).length, before + 1, 'fail-open lost a message');
await db.exec(saved.d);
console.log('fail-open ok');

// multi-day
await db.exec(`update private.ops_events set resolved_at=now() where resolved_at is null`);
await notify(db, 'windows', 'يومي', 'daily-git-pull');
await notify(db, 'sync_failure', 'دوري', 'sync-periodic');
await db.exec(`update private.ops_events set last_seen_at=now()-interval '24 hours' where event_key in ('daily-git-pull','sync-periodic')`);
await db.exec(`select private.close_stale_ops_events(now())`);
assert.deepEqual((await open(db)).map((r) => r.event_key), ['daily-git-pull'], 'periodic closed after 3h silence; daily kept');
const s24 = (await one(db, 'select private.daily_open_faults_section(now(), 1500) s')).s;
assert.ok(s24.includes('daily-git-pull') || s24.includes('يومي'), 'daily fault visible in next report: ' + s24);
await db.exec(`update private.ops_events set last_seen_at=now()-interval '31 hours' where event_key='daily-git-pull'`);
await db.exec(`select private.close_stale_ops_events(now())`);
assert.deepEqual(await open(db), [], 'recovered fault must not show open');
const sOk = (await one(db, 'select private.daily_open_faults_section(now(), 1500) s')).s;
console.log(sOk);
await notify(db, 'windows', 'يومي', 'daily-git-pull');
assert.deepEqual((await open(db)).map((r) => r.event_key), ['daily-git-pull']);
console.log('multi-day ok');

// ameen recovery
await notify(db, 'windows', 'عالق', 'ameen-read-worker-stuck:7');
await notify(db, 'windows', 'متدهور', 'ameen-read-worker-degraded:7');
assert.ok((await open(db)).some((r) => r.event_key === 'ameen-read-worker-stuck:7'));
await notify(db, 'windows', 'تعافى', 'ameen-read-worker-recovered:7');
assert.ok(!(await open(db)).some((r) => r.event_key.startsWith('ameen-read-worker')), 'recovered still open');
// حادثة عامل أمين تُنذَر مرة واحدة: لا تُغلق بنافذة الصمت (3س) قبل التقرير
await notify(db, 'windows', 'متدهور', 'ameen-read-worker-degraded:9');
await db.exec(`update private.ops_events set last_seen_at = now() - interval '10 hours' where event_key = 'ameen-read-worker-degraded:9'`);
await db.exec(`select private.close_stale_ops_events(now())`);
assert.ok((await open(db)).some((r) => r.event_key === 'ameen-read-worker-degraded:9'), 'one-shot ameen incident closed too early');
await notify(db, 'windows', 'تعافى', 'ameen-read-worker-recovered:9');
console.log('recovery ok');

// rollback / re-apply
const outBefore = (await outbox(db)).length;
await db.exec(rb13);
assert.equal(await md5(db), PROD, 'rollback restores exact production body');
assert.equal((await one(db, `select to_regprocedure('private.absorb_digest_alert(text,text,text)') r`)).r, null);
assert.equal((await one(db, `select to_regclass('private.digest_routing_snapshot') r`)).r, null);
await notify(db, 'windows', 'بعد التراجع', 'winfail:after');
assert.equal((await outbox(db)).length, outBefore + 1, 'after rollback, alert is immediate again');
await assert.rejects(db.exec(rb13), /no snapshot/);
await db.exec(p13);
assert.notEqual(await md5(db), PROD);
await db.exec(rb13);
await db.exec(`create or replace function private.notify_telegram_dispatch(p_event_type text,p_message text,p_dedupe_key text default null,p_dedupe_minutes int default 60,p_reply_markup jsonb default null) returns void language sql as $$ select 1 $$`);
await assert.rejects(db.exec(p13), /drifted/);
// تعديل لاحق يحتفظ بالوسم ⇒ يُرفض عند إعادة التشغيل ولا يُكتب فوقه
await db.exec(p13.replace(/^do \$pre\$[\s\S]*?end \$pre\$;/m, 'select 1;')); // يثبّت جسم 13 (تجاوز الفحص للتحضير فقط)
await db.exec(`create or replace function private.notify_telegram_dispatch(p_event_type text,p_message text,p_dedupe_key text default null,p_dedupe_minutes int default 60,p_reply_markup jsonb default null) returns void language sql security definer as $$ select 1 /* digest-routing:v1 edited */ $$`);
await assert.rejects(db.exec(p13), /drifted/);
// تراجع 12 مرفوض ما دام 13 فعّالاً
await assert.rejects(db.exec(rb12), /13 is active/);
console.log('rollback/reapply/drift ok');
console.log('anon exec route:', (await one(db, `select has_function_privilege('anon','private.ops_event_route(text,text)','execute') a`)).a);
console.log('ALL P13 CHECKS PASSED');
process.exit(0);
