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
  ['security_alert', 'x', 'immediate'], ['windows', 'backup-failed', 'immediate'], ['windows', 'launcher-writer-hash-abc', 'immediate'], ['windows', 'launcher-writer-no-allowlist', 'immediate'], ['windows', 'deploy-gate-crash', 'immediate'], ['sync_failure', 'auth-x', 'immediate'],
  ['health_check', 'health-site-down', 'immediate'], ['health_check', 'health-health-check-crashed', 'immediate'],
  ['health_check', 'health-workflow-x', 'digest'],
  ['github_actions_failure', 'gha-fail:دخان ما بعد النشر', 'immediate'], ['github_actions_failure', 'gha-fail:فحص صحة المشروع', 'immediate'],
  ['github_actions_failure', 'gha-fail:CI', 'digest'],
  ['sync_failure', 'x', 'digest'], ['price_sync_mismatch', 'price-sync:mismatch', 'immediate'], ['price_sync_failure', 'price-sync:verify-failed', 'immediate'],
  ['windows', 'price-sync:anything', 'immediate'],
  ['sync_failure', 'winfail:apply-to-ameen', 'immediate'], ['sync_failure', 'winfail:pull-approved-prices', 'immediate'],
  ['sync_failure', 'winfail:push-daily-profit', 'digest'], ['sync_failure', 'winfail:push-expense-entries', 'digest'],
  ['sync_failure', 'winfail:push-khalil-audit-log', 'digest'], ['sync_failure', 'winfail:push-sales-line-items', 'digest'],
  ['windows', 'local-server-revive-fail', 'immediate'],
  ['windows', 'ameen-backup-empty', 'immediate'], ['windows', 'ameen-backup-copy-fail', 'immediate'],
  ['windows', 'ameen-sync-watchdog', 'digest'], ['windows', 'snapshot-producer-missing', 'digest'], ['windows', 'winfail:t', 'digest'],
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


// ===== قرارات المالك: الأسعار، إحياء الخادم، حُلّ اليوم، نوافذ الصمت =====
const lastOut = async () => (await q(db, 'select event_type,dedupe_key,message from public.telegram_outbox order by id desc limit 1'))[0];
const cnt = async () => (await outbox(db)).length;
const MM = (d, m) => `⚠️ مزامنة الأسعار ليست مكتملة\nفروقات: ${d} — مواد ناقصة: ${m}`;
{
  let n0 = await cnt();
  // فروقات > 0 لا تثبت وحدها تأثيراً فعلياً: اكتشاف فقط، فوري، دون ادّعاء «تأثير مؤكَّد»
  await notify(db, 'price_sync_mismatch', MM(3, 0), 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 1, 'any price difference is immediate');
  let o = await lastOut();
  assert.match(o.message, /اكتُشف اختلاف/);
  assert.match(o.message, /غير مؤكَّد/);
  assert.doesNotMatch(o.message, /تأثير مؤكَّد على الأسعار/);
  assert.match(o.message, /فروقات: 3 — مواد ناقصة: 0/);
  assert.equal(o.dedupe_key, 'price-sync:mismatch:detected:3:0');
  await notify(db, 'price_sync_mismatch', MM(3, 0), 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 1, 'same state is not repeated');
  await notify(db, 'price_sync_mismatch', MM(0, 2), 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 2);
  o = await lastOut();
  assert.match(o.message, /اكتُشف اختلاف/);
  assert.equal(o.dedupe_key, 'price-sync:mismatch:detected:0:2');
  await notify(db, 'price_sync_mismatch', MM(3, 0), 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 3, 'a changed state going back to an earlier one must still alert');
  await notify(db, 'price_sync_mismatch', MM(5, 1), 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 4, 'changed counts alert immediately');
  await db.exec(`update public.telegram_outbox set created_at=now()-interval '25 hours' where dedupe_key like 'price-sync:mismatch:%'`);
  await notify(db, 'price_sync_mismatch', MM(5, 1), 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 5, 'daily reminder for persisting state');
  await notify(db, 'price_sync_mismatch', 'نص مختلف تماماً', 'price-sync:mismatch', 30);
  assert.equal(await cnt(), n0 + 6);
  assert.equal((await lastOut()).message, 'نص مختلف تماماً');
  await notify(db, 'price_sync_failure', '🚨 تعذر التحقق من مزامنة الأسعار مع الأمين', 'price-sync:verify-failed', 60);
  await notify(db, 'price_sync_failure', '🚨 تعذر التحقق من مزامنة الأسعار مع الأمين', 'price-sync:verify-failed', 60);
  assert.equal(await cnt(), n0 + 7);
  o = await lastOut();
  assert.equal(o.dedupe_key, 'price-sync:verify-failed');
  assert.match(o.message, /غير مؤكَّدة/);
  assert.doesNotMatch(o.message, /تأثير مؤكَّد/);
  await db.exec(`update public.telegram_outbox set created_at=now()-interval '61 minutes' where dedupe_key='price-sync:verify-failed'`);
  await notify(db, 'price_sync_failure', '🚨 تعذر التحقق من مزامنة الأسعار مع الأمين', 'price-sync:verify-failed', 60);
  assert.equal(await cnt(), n0 + 8, 'verify-failed reminder after 60 min');
  await notify(db, 'sync_failure', '🚨 فشل تطبيق الأسعار على قاعدة الأمين', 'winfail:apply-to-ameen', 60);
  await notify(db, 'sync_failure', '🚨 فشل سحب الأسعار', 'winfail:pull-approved-prices', 60);
  assert.equal(await cnt(), n0 + 10, 'price-chain sync failures are immediate');
  await notify(db, 'sync_failure', '🚨 فشل دفع الربح', 'winfail:push-daily-profit', 60);
  assert.equal(await cnt(), n0 + 10, 'non-price data push failure stays in the digest');
  assert.ok((await open(db)).some((r) => r.event_key === 'winfail:push-daily-profit'));
  await notify(db, 'windows', 'تعذّر إنعاش سيرفر الموقع المحلي على المنفذ 3000', 'local-server-revive-fail', 60);
  assert.equal(await cnt(), n0 + 11);
  await notify(db, 'windows', 'تعذّر إنعاش سيرفر الموقع المحلي على المنفذ 3000', 'local-server-revive-fail', 60);
  assert.equal(await cnt(), n0 + 11, 'no repeat within 60 minutes');
  await db.exec(`update public.telegram_outbox set created_at=now()-interval '61 minutes' where dedupe_key='local-server-revive-fail'`);
  await notify(db, 'windows', 'تعذّر إنعاش سيرفر الموقع المحلي على المنفذ 3000', 'local-server-revive-fail', 60);
  assert.equal(await cnt(), n0 + 12, 'hourly reminder while the outage continues');
  assert.ok(!(await open(db)).some((r) => r.event_key === 'local-server-revive-fail'), 'revive failure must not be digest-only');
  // الأمن وفشل التقرير المسائي مستقلان حتى لو تعطّل الامتصاص بالكامل
  const savedAbs = await one(db, `select pg_get_functiondef('private.absorb_digest_alert(text,text,text)'::regprocedure) d`);
  await db.exec(`drop function private.absorb_digest_alert(text,text,text)`); await db.exec(`create function private.absorb_digest_alert(a text,b text,c text) returns boolean language plpgsql as $$ begin raise exception 'boom'; end $$`);
  const n1 = await cnt();
  await notify(db, 'security_alert', 'اختراق', 'sec-indep');
  await notify(db, 'report', 'التقرير المسائي لم يُسلَّم', 'evening-missing:2026-01-01');
  assert.equal(await cnt(), n1 + 2, 'security / evening-report failure stay immediate regardless of digest machinery');
  await db.exec(`drop function private.absorb_digest_alert(text,text,text)`); await db.exec(savedAbs.d);
}
console.log('prices/revive/independence ok');

{
  const sec = async () => (await one(db, 'select private.daily_open_faults_section(now(), 3000) s')).s;
  const fresh = () => db.exec(`update private.ops_events set resolved_at=now(), resolution='silence' where resolved_at is null`);
  await db.exec('delete from private.ops_events');
  await notify(db, 'windows', 'عامل أمين عالق T21', 'ameen-read-worker-stuck:21');
  assert.ok((await sec()).includes('عامل أمين عالق T21'));
  assert.ok(!(await sec()).includes('حُلّ اليوم'));
  await db.exec(`select private.resolve_ops_event('telegram','ameen-read-worker-stuck:21')`);
  const s1 = await sec();
  assert.match(s1, /✅ حُلّ اليوم \(1\)/);
  assert.match(s1, /عامل أمين عالق T21/);
  // إغلاق بالصمت: لا يُعرض كمتعافٍ
  await notify(db, 'sync_failure', 'دوري صامت T22', 'winfail:push-expense-entries');
  await db.exec(`update private.ops_events set last_seen_at=now()-interval '3 hours 1 minute' where event_key='winfail:push-expense-entries'`);
  await db.exec(`select private.close_stale_ops_events(now(), interval '3 hours')`);
  assert.equal((await one(db, `select resolution r from private.ops_events where event_key='winfail:push-expense-entries'`)).r, 'silence');
  const s2 = await sec();
  assert.ok(!s2.includes('دوري صامت T22'), 'silence closure must not be listed as recovered: ' + s2);
  assert.match(s2, /دون إشارة تعافٍ مؤكَّدة/);
  // عاد العطل ⇒ لا يُعرض متعافياً
  await notify(db, 'windows', 'عالق من جديد', 'ameen-read-worker-stuck:21');
  const s3 = await sec();
  assert.ok(!/✅ حُلّ اليوم[\s\S]*عامل أمين عالق T21/.test(s3), s3);
  assert.match(s3, /عالق من جديد/);
  await fresh();
  // أقدم من 24 ساعة لا يظهر
  await notify(db, 'windows', 'قديم', 'ameen-read-worker-stuck:old');
  await db.exec(`select private.resolve_ops_event('telegram','ameen-read-worker-stuck:old')`);
  await db.exec(`update private.ops_events set resolved_at=now()-interval '25 hours' where event_key='ameen-read-worker-stuck:old'`);
  { const sx = await sec(); assert.ok(!sx.includes('ameen-read-worker-stuck:old') && !sx.includes('• قديم'), sx); }
  // نوافذ الصمت
  const T = async (key, kind, ago, wantOpen) => {
    await notify(db, kind, 'x ' + key, key);
    await db.exec(`update private.ops_events set last_seen_at=now()-interval '${ago}' where event_key='${key}' and resolved_at is null`);
    await db.exec(`select private.close_stale_ops_events(now(), interval '3 hours')`);
    const isOpen = (await open(db)).some((r) => r.event_key === key);
    assert.equal(isOpen, wantOpen, `${key} @ ${ago}`);
    await fresh();
  };
  await T('winfail:push-daily-profit', 'sync_failure', '2 hours 59 minutes', true);
  await T('winfail:push-daily-profit', 'sync_failure', '3 hours 1 minute', false);
  await T('ameen-sync-watchdog', 'windows', '2 hours 59 minutes', true);
  await T('ameen-sync-watchdog', 'windows', '3 hours 1 minute', false);
  for (const k of ['daily-git-pull-fail', 'daily-git-pull-stuck', 'ameen-read-worker-stuck:3', 'automation-failure:x', 'gha-fail:CI']) {
    const kind = k.startsWith('gha-') ? 'github_actions_failure' : k.startsWith('automation') ? 'automation_failure' : 'windows';
    await T(k, kind, '29 hours', true);
    await T(k, kind, '31 hours', false);
  }
  // عطل مستمر 48س يتكرر: صف مفتوح واحد
  await notify(db, 'sync_failure', 'مستمر 48س', 'winfail:push-sales-line-items');
  await db.exec(`update private.ops_events set first_seen_at=now()-interval '48 hours', last_seen_at=now()-interval '30 minutes' where event_key='winfail:push-sales-line-items' and resolved_at is null`);
  for (let i = 0; i < 3; i++) { await db.exec(`select private.close_stale_ops_events(now(), interval '3 hours')`); await notify(db, 'sync_failure', 'مستمر 48س', 'winfail:push-sales-line-items'); }
  assert.equal((await q(db, `select 1 from private.ops_events where event_key='winfail:push-sales-line-items' and resolved_at is null`)).length, 1);
  assert.match(await sec(), /مستمر 48س/);
  for (let i = 0; i < 12; i++) { await notify(db, 'windows', 'عطل ' + i, 'ameen-read-worker-stuck:b' + i); await db.exec(`select private.resolve_ops_event('telegram','ameen-read-worker-stuck:b${i}')`); }
  const sb = (await one(db, 'select private.daily_open_faults_section(now(), 700) s')).s;
  assert.ok(sb.length <= 700, 'section exceeded budget: ' + sb.length);
  await fresh();
}
console.log('resolved-today / silence windows ok');

// ===== أعطال فحص الصحة (health-*): لا يُغلقها الصمت، تُغلق بإشارة تعافٍ صريحة فقط =====
{
  const sec = async () => (await one(db, 'select private.daily_open_faults_section(now(), 3000) s')).s;
  const isOpen = async (k) => (await open(db)).some((r) => r.event_key === k);
  const closeNow = () => db.exec(`select private.close_stale_ops_events(now(), interval '3 hours')`);
  await db.exec(`update private.ops_events set resolved_at=now(), resolution='silence' where resolved_at is null`);
  await db.exec(`update private.ops_events set resolved_at=now()-interval '48 hours' where resolved_at is not null`);
  const outN = async () => (await outbox(db)).length;
  const n0 = await outN();
  // (1) عطل مستمر > 30 س دون تحديث: لا يُغلَق ولا يُعدّ محلولاً، ويُعرض «يلزم إعادة التحقق»
  await notify(db, 'health_check', 'فشل Workflow CI', 'health-workflow-ci-issue-7');
  await db.exec(`update private.ops_events set first_seen_at=now()-interval '60 hours', last_seen_at=now()-interval '55 hours' where event_key='health-workflow-ci-issue-7'`);
  for (let i = 0; i < 3; i++) await closeNow();
  assert.ok(await isOpen('health-workflow-ci-issue-7'), 'health fault must survive silence closure');
  const s1 = await sec();
  assert.match(s1, /فشل Workflow CI/);
  assert.match(s1, /يلزم إعادة التحقق/);
  assert.ok(!/حُلّ اليوم[\s\S]*فشل Workflow CI/.test(s1), 'stale health fault must not be listed as recovered');
  // (2) عودة المراقبة بعد انقطاع: التحديث يجدّد last_seen_at فيزول وسم إعادة التحقق دون تكرار الحدث
  await notify(db, 'health_check', 'فشل Workflow CI', 'health-workflow-ci-issue-7');
  assert.equal((await q(db, `select 1 from private.ops_events where event_key='health-workflow-ci-issue-7' and resolved_at is null`)).length, 1);
  assert.ok(!(await sec()).includes('يلزم إعادة التحقق'), 'fresh again after monitoring returns');
  // (3) أقل من 30 س: ظاهر بلا وسم
  await db.exec(`update private.ops_events set last_seen_at=now()-interval '29 hours' where event_key='health-workflow-ci-issue-7'`);
  assert.ok(!(await sec()).includes('يلزم إعادة التحقق'));
  await db.exec(`update private.ops_events set last_seen_at=now()-interval '31 hours' where event_key='health-workflow-ci-issue-7'`);
  assert.match(await sec(), /يلزم إعادة التحقق/);
  // (4) تعافٍ صريح: يغلق العطل (explicit) ويظهر «حُلّ اليوم» دون أي رسالة تيليغرام
  const n1 = await outN();
  await notify(db, 'health_check', 'تعافى', 'health-recovered:workflow-ci-issue-7');
  assert.equal(await outN(), n1, 'recovery signal is absorbed, no Telegram');
  assert.ok(!(await isOpen('health-workflow-ci-issue-7')));
  assert.equal((await one(db, `select resolution r from private.ops_events where event_key='health-workflow-ci-issue-7' order by id desc limit 1`)).r, 'explicit');
  assert.match(await sec(), /✅ حُلّ اليوم \(1\)[\s\S]*فشل Workflow CI/);
  // (5) مفتاح بلا Issue (noissue-<ساعة>) يُطبَّع، ويُغلق بالتعافي نفسه
  await notify(db, 'health_check', 'مسح فاشل', 'health-scan-noissue-482001');
  assert.ok(await isOpen('health-scan-noissue'));
  await db.exec(`update private.ops_events set last_seen_at=now()-interval '40 hours' where event_key='health-scan-noissue'`);
  await closeNow();
  assert.ok(await isOpen('health-scan-noissue'), 'noissue health fault also survives silence');
  await notify(db, 'health_check', 'تعافى', 'health-recovered:scan-noissue-482050');
  assert.ok(!(await isOpen('health-scan-noissue')));
  // (6) لا يمسّ غيره: بقية الأعطال تُغلق بالصمت كما كانت، والحرجان فوريان
  await notify(db, 'windows', 'x', 'ameen-sync-watchdog');
  await db.exec(`update private.ops_events set last_seen_at=now()-interval '3 hours 1 minute' where event_key='ameen-sync-watchdog' and resolved_at is null`);
  await closeNow();
  assert.ok(!(await isOpen('ameen-sync-watchdog')), 'non-health faults still closed by silence');
  await db.exec(`delete from public.telegram_outbox where dedupe_key in ('health-site-down','health-health-check-crashed')`);
  const n2 = await outN();
  await notify(db, 'health_check', 'الموقع واقع', 'health-site-down');
  await notify(db, 'health_check', 'انهيار الفحص', 'health-health-check-crashed');
  assert.equal(await outN(), n2 + 2, 'critical health alerts stay immediate');
  assert.ok(!(await isOpen('health-site-down')) && !(await isOpen('health-health-check-crashed')));
  assert.equal(n1, n0, 'no Telegram rows from absorbed health faults / recovery');
  await db.exec(`update private.ops_events set resolved_at=now(), resolution='silence' where resolved_at is null`);
}
console.log('health faults persist until explicit recovery ok');

// rollback / re-apply
// انجراف: تعديل لاحق على دالة موجَّهة ⇒ التراجع يرفض ولا يكتب فوقه
const routeDef = (await one(db, `select pg_get_functiondef('private.ops_event_route(text,text)'::regprocedure) d`)).d;
await db.exec(routeDef.replace("else 'immediate'", "else 'immediate' /* later fix */"));
await assert.rejects(db.exec(rb13), /drifted/);
await db.exec(routeDef);
// حادثة إنذار واحد مفتوحة وقت التراجع ⇒ تُرسَل مرة واحدة في رسالة موحَّدة (لا تضيع، لا فيضان)
await notify(db, 'windows', 'متدهور وحيد', 'ameen-read-worker-degraded:55');
const outBefore = (await outbox(db)).length;
await db.exec(rb13);
{
  const ob = await outbox(db);
  assert.equal(ob.length, outBefore + 1, 'exactly one drain message');
  assert.equal(ob[ob.length - 1].event_type, 'ops_rollback_drain');
  assert.match((await one(db, `select message m from public.telegram_outbox order by id desc limit 1`)).m, /متدهور وحيد/);
}
assert.equal(await md5(db), PROD, 'rollback restores exact production body');
assert.equal((await one(db, `select to_regprocedure('private.absorb_digest_alert(text,text,text)') r`)).r, null);
assert.equal((await one(db, `select to_regclass('private.digest_routing_snapshot') r`)).r, null);
await notify(db, 'windows', 'بعد التراجع', 'winfail:after');
assert.equal((await outbox(db)).length, outBefore + 2, 'after rollback, alert is immediate again');
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
await assert.rejects(db.exec(bundle), /13 is active/);
await assert.rejects(db.exec(rb12), /13 is active/);
// تقرير يذكر القسم في تعليق فقط ⇒ 13 يرفض (لا يمتص تنبيهات بلا عرض)
{
  const rep = (await one(db, `select pg_get_functiondef('public.send_evening_report()'::regprocedure) d`)).d;
  const start = rep.lastIndexOf('begin', rep.indexOf('coalesce(private.daily_open_faults_section'));
  const end = rep.indexOf('end;', start) + 4;
  await db.exec(rep.slice(0, start) + '/* daily_open_faults_section */' + rep.slice(end));
  await assert.rejects(db.exec(p13), /exact open-faults block/);
  await db.exec(rep); // يعيد التقرير المرقَّع
}
// تعديل لاحق على ops_event_silence أو absorb_digest_alert بعد تطبيق 13: إعادة تطبيق 13 ترفض ولا تكتب فوقه
{
  for (const fn of ['private.ops_event_silence(text)', 'private.absorb_digest_alert(text,text,text)', 'private.refine_immediate_alert(text,text,text)']) {
    const d = await liveDb();
    await d.exec(bundle);
    await d.exec(p13);
    const def = (await one(d, `select pg_get_functiondef('${fn}'::regprocedure) d`)).d;
    const tweaked = def.replace(/(as \$\w*\$)/i, '$1 /* later approved fix */ ');
    await d.exec(tweaked);
    await assert.rejects(d.exec(p13), /drifted/);
    assert.match((await one(d, `select pg_get_functiondef('${fn}'::regprocedure) d`)).d, /later approved fix/);
  }
}
// تعديل إنتاجي لاحق على ops_event_route أو close_stale بعد 12: 13 يرفض ولا يكتب فوقه
{
  for (const fn of ['private.ops_event_route(text,text)', 'private.close_stale_ops_events(timestamptz,interval)']) {
    const d = await liveDb();
    await d.exec(bundle);
    const def = (await one(d, `select pg_get_functiondef('${fn}'::regprocedure) d`)).d;
    await d.exec(def.replace(/(as \$\w*\$\s)/i, '$1 /* later approved fix */ '));
    await assert.rejects(d.exec(p13), /drifted/);
    assert.equal((await one(d, `select count(*)::int n from pg_proc where proname='absorb_digest_alert'`)).n, 0);
  }
}
// ═══ public.health_lifecycle (RPC دورة حياة أعطال health-check بإقرار صريح) ═══
{
  const rpc = async (d, op, key = null, issue = null, label = null) =>
    (await one(d, `select public.health_lifecycle($1,$2,$3,$4) r`.replace(/\$(\d)/g, (_, i) => [`'${op}'`, key == null ? 'null' : `'${key}'`, issue == null ? 'null' : issue, label == null ? 'null' : `'${label}'`][i - 1]))).r;
  const open = async (d) => (await one(d, `select count(*)::int n from private.ops_events where source='telegram' and resolved_at is null`)).n;
  const d = await liveDb();
  await d.exec(bundle);
  // قبل 13: لا RPC (هذا ما يراه السكربت كـPGRST202 ⇒ وضع قديم بعد تأكيد)
  assert.equal((await one(d, `select to_regprocedure('public.health_lifecycle(text,text,integer,text)') r`)).r, null);
  await d.exec(p13);
  const ob0 = (await outbox(d)).length;
  // probe
  assert.deepEqual(await rpc(d, 'probe'), { ok: true, op: 'probe', v: 1, ready: true });
  // renew: يفتح ثم يجدّد (idempotent)؛ لا Telegram
  assert.deepEqual(await rpc(d, 'renew', 'ameen-sync', 7, 'مزامنة'), { ok: true, op: 'renew', renewed: 0, created: true });
  assert.deepEqual(await rpc(d, 'renew', 'ameen-sync', 7, 'مزامنة'), { ok: true, op: 'renew', renewed: 1, created: false });
  assert.equal(await open(d), 1);
  assert.equal((await one(d, `select event_key k from private.ops_events where source='telegram' and resolved_at is null`)).k, 'health-ameen-sync-issue-7');
  // مفاتيح/أرقام Issue مختلفة ⇒ أحداث منفصلة
  await rpc(d, 'renew', 'ameen-sync', 8);
  await rpc(d, 'renew', 'other-fault', 7);
  assert.equal(await open(d), 3);
  // resolve يغلق المطابق وحده؛ ويكرَّر بلا خطأ
  assert.deepEqual(await rpc(d, 'resolve', 'ameen-sync', 7), { ok: true, op: 'resolve', resolved: 1 });
  assert.deepEqual(await rpc(d, 'resolve', 'ameen-sync', 7), { ok: true, op: 'resolve', resolved: 0 });
  assert.equal(await open(d), 2);
  assert.deepEqual((await d.query(`select event_key k from private.ops_events where source='telegram' and resolved_at is null order by 1`)).rows.map((x) => x.k), ['health-ameen-sync-issue-8', 'health-other-fault-issue-7']);
  assert.equal((await one(d, `select resolution r from private.ops_events where event_key='health-ameen-sync-issue-7'`)).r, 'explicit');
  // resolve لمفتاح/Issue غير موجود لا يمس غيره
  assert.equal((await rpc(d, 'resolve', 'ameen-sync', 99)).resolved, 0);
  assert.equal(await open(d), 2);
  // التجديد بعد الإغلاق يفتح حدثاً جديداً (عطل عاد)
  assert.equal((await rpc(d, 'renew', 'ameen-sync', 7)).created, true);
  assert.equal(await open(d), 3);
  // أخطاء صريحة (لا false صامت)
  for (const [op, k, i] of [['bogus', 'x', 1], ['renew', null, 1], ['renew', '', 1], ['renew', 'health-x', 1], ['resolve', 'site-down', 1], ['renew', 'health-check-crashed', 1], ['renew', 'x', null], ['resolve', 'x', 0], ['renew', 'x', -3], [null, null, null]]) {
    await assert.rejects(rpc(d, op, k, i), /health_lifecycle/, `${op}/${k}/${i}`);
  }
  assert.equal(await open(d), 3, 'rejected calls change nothing');
  // لا رسالة Telegram من أي عملية
  assert.equal((await outbox(d)).length, ob0, 'RPC never queues Telegram');
  // أمان SECURITY DEFINER والصلاحيات
  const meta = await one(d, `select prosecdef sd, proconfig cfg from pg_proc where oid='public.health_lifecycle(text,text,integer,text)'::regprocedure`);
  assert.equal(meta.sd, true);
  assert.deepEqual(meta.cfg, ['search_path=pg_catalog, pg_temp']);
  for (const [r, want] of [['anon', false], ['authenticated', false], ['public', false], ['service_role', true]]) {
    assert.equal((await one(d, `select has_function_privilege('${r}','public.health_lifecycle(text,text,integer,text)','execute') x`)).x, want, r);
  }
  // الاستدعاء الفعلي بدور service_role يعمل، وبدور anon مرفوض
  await d.exec(`set role service_role`);
  assert.equal((await rpc(d, 'probe')).ready, true);
  await d.exec(`reset role`);
  await d.exec(`set role anon`);
  await assert.rejects(rpc(d, 'probe'), /permission denied/);
  await d.exec(`reset role`);
  // probe لا يعلن الجاهزية إن غاب خطّاف التوجيه من dispatch (RPC موجودة لكن التوجيه غير فعّال)
  {
    const d2 = await liveDb();
    await d2.exec(bundle);
    await d2.exec(p13);
    await d2.exec(`create or replace function private.notify_telegram_dispatch(p_event_type text,p_message text,p_dedupe_key text default null,p_dedupe_minutes int default 60,p_reply_markup jsonb default null) returns void language sql security definer as $$ select 1 $$`);
    assert.equal((await rpc(d2, 'probe')).ready, false);
  }
  // التراجع: يُسقط الـRPC ولا يترك صلاحية ولا يلمس أحداث الأعطال، وإعادة التطبيق تعيدها
  await d.exec(rb13);
  assert.equal((await one(d, `select to_regprocedure('public.health_lifecycle(text,text,integer,text)') r`)).r, null);
  assert.equal((await one(d, `select count(*)::int n from pg_proc where proname='health_lifecycle'`)).n, 0);
  await d.exec(p13);
  assert.equal((await rpc(d, 'probe')).ready, true);
  // تعديل لاحق على جسم الـRPC ⇒ التراجع يرفض ولا يسقطها
  await d.exec((await one(d, `select pg_get_functiondef('public.health_lifecycle(text,text,integer,text)'::regprocedure) d`)).d.replace(/(as \$\w*\$)/i, '$1 /* later approved fix */ '));
  await assert.rejects(d.exec(rb13), /health_lifecycle drifted/);
  assert.notEqual((await one(d, `select to_regprocedure('public.health_lifecycle(text,text,integer,text)') r`)).r, null);
  console.log('health_lifecycle RPC ok');
}
console.log('rollback/reapply/drift ok');
console.log('anon exec route:', (await one(db, `select has_function_privilege('anon','private.ops_event_route(text,text)','execute') a`)).a);
console.log('ALL P13 CHECKS PASSED');
process.exit(0);
