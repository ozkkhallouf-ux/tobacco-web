// اختبارات اصطناعية (pglite، لا اتصال بأي قاعدة حقيقية ولا Telegram) للحزمة الذرّية
// supabase/proposed/12-digest-only-atomic-bundle.sql — تغطي ملاحظات Codex P1 الثلاث:
//   P1#1 لا سلوك من 09 غير المعتمد: الحي = 09 (md5) والحزمة ترفض أي انحراف.
//   P1#2 لا فجوة صمت: المراقب والتقرير المسائي يتغيّران معاً أو لا شيء (فشل جزئي/تراجع/إعادة).
//   P1#3 الأعطال المفتوحة قبل التفعيل (مهام مشروع + cron فاشلة) تُهيَّأ فتظهر، بلا تكرار.
// التشغيل: PGLITE_DIR=<مسار حزمة @electric-sql/pglite> node supabase/tests/digest-bundle.sim.mjs
// (لا تُضاف pglite تبعيةً للمستودع؛ بدونها يتخطى الاختبار برسالة صريحة).
// قيد معروف: pglite جلسة واحدة، فالتزامن الحقيقي متعدد الجلسات لا يُختبر هنا؛ يُختبر
// تسلسل الاستدعاءات المتداخلة وفهارس منع التكرار والقفل المعاد دخوله.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let PGlite;
try {
  const dir = process.env.PGLITE_DIR;
  ({ PGlite } = dir
    ? await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href)
    : await import('@electric-sql/pglite'));
} catch {
  console.log('digest-bundle.sim: SKIPPED (pglite غير متاح؛ عيّن PGLITE_DIR)');
  process.exit(0);
}
const sql = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const baseMain = execFileSync('git', ['show', 'origin/main:supabase/project-task-health-monitor.sql'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).replace(/\r\n/g, '\n');
const p09 = sql('supabase/proposed/09-cron-reenabled-failed-alert-fix.sql');
const bundle = sql('supabase/proposed/12-digest-only-atomic-bundle.sql');
const rollback = sql('supabase/proposed/12-digest-only-rollback.sql');
const P09_MD5 = '2c762f38b56ea5a683061529bd5e5d7f';

const EVENING = (anchor = true) => `
create or replace function public.send_evening_report() returns void language plpgsql as $f$
declare msg text; today text := to_char(now(),'YYYY-MM-DD');
begin
  msg := 'REPORT';
  ${anchor ? "perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);" : 'perform 1;'}
end $f$;`;

// حالة «الإنتاج الحالي»: القانوني الأساسي + 09 + تقرير مسائي ببنية المرساة نفسها.
async function liveDb() {
  const db = new PGlite();
  await db.exec(`
   create schema cron; create schema private;
   create role anon; create role authenticated;
   create table cron.job(jobid serial primary key, jobname text, active boolean default true);
   create table cron.job_run_details(jobid int, status text, start_time timestamptz);
   create function cron.schedule(a text,b text,c text) returns void language sql as 'select';
   create function cron.unschedule(a text) returns void language sql as 'select';
   create table public.inventory_reports(source text, created_at timestamptz default now());
   create table public.khalil_audit_sync_heartbeat(created_at timestamptz default now(), status text);
   create table public.expense_entries(created_at timestamptz default now());
   create table sent(kind text, msg text, key text);
   create function public.notify_telegram(k text, m text, dk text default null, dm int default 0, rm jsonb default null) returns void language sql as
    $$ insert into sent values(k,m,dk) $$;
  `);
  await db.exec(baseMain);
  await db.exec(p09);
  await db.exec(EVENING(true));
  await db.exec(`update private.project_task_monitors set enabled=false where task_key not in ('customer-balances','price-sync')`);
  return db;
}
const md5 = async (db, sig) => (await db.query(`select md5(prosrc) m from pg_proc where oid=to_regprocedure('${sig}')`)).rows[0].m;
const defOf = async (db, sig) => (await db.query(`select pg_get_functiondef(to_regprocedure('${sig}')) d`)).rows[0].d;
const sent = async (db) => (await db.query('select kind,msg,key from sent order by ctid')).rows;
const one = async (db, q) => (await db.query(q)).rows[0];
const exists = async (db, rel) => (await one(db, `select to_regclass('${rel}') r`)).r !== null;

// ───────────── P1#1: الحي = 09 والحزمة تحمي من الانحراف ─────────────
{
  const db = await liveDb();
  assert.equal(await md5(db, 'private.monitor_project_tasks()'), P09_MD5, 'ثابت md5 في الحزمة يجب أن يطابق جسم 09 المحمَّل');
  // انحراف مجهول عن 09 ⇒ رفض كامل بلا أثر
  await db.exec(`do $x$ declare d text; begin
     select replace(pg_get_functiondef('private.monitor_project_tasks()'::regprocedure),'begin','begin /*drift*/') into d; execute d; end $x$;`);
  const drifted = await md5(db, 'private.monitor_project_tasks()');
  assert.notEqual(drifted, P09_MD5);
  await assert.rejects(db.exec(bundle), /refusing to overwrite unknown drift/);
  assert.equal(await md5(db, 'private.monitor_project_tasks()'), drifted, 'الفشل لا يغيّر شيئاً');
  assert.equal(await exists(db, 'private.ops_events'), false, 'تراجع كامل بما فيه الجداول الجديدة');
  assert.equal(await exists(db, 'private.digest_bundle_snapshot'), false);
  // الفرق السلوكي الوحيد عن الحي هو سياسة التنبيه: نفس العطل، 09 يرسل و«الجديد» لا يرسل
  const live = await liveDb();
  await live.exec(`insert into public.inventory_reports(source,created_at) values('ameen_customer_balances', now()-interval '30 minutes')`);
  await live.exec('select private.monitor_project_tasks()');
  assert.ok((await sent(live)).some((r) => r.kind === 'project_task_failure'), 'تحقق: السلوك الحي الحالي يرسل فعلاً');
  await live.exec('delete from sent');
  await live.exec(bundle);
  await live.exec('select private.monitor_project_tasks()');
  assert.equal((await sent(live)).filter((r) => r.kind.startsWith('project_task')).length, 0, 'بعد التفعيل لا رسائل مستقلة');
  // notify_telegram لم يُمَس
  const db2 = await liveDb();
  const before = await md5(db2, 'public.notify_telegram(text,text,text,integer,jsonb)');
  await db2.exec(bundle);
  assert.equal(await md5(db2, 'public.notify_telegram(text,text,text,integer,jsonb)'), before);
  // انجراف لاحق يُبقي observe_ops_event: لا يُقبل بمجرد وجود اسم الدالة (بصمات دقيقة فقط)
  const d3 = await liveDb();
  await d3.exec(bundle);
  await d3.exec(`do $x$ declare d text; begin
     select replace(pg_get_functiondef('private.monitor_project_tasks()'::regprocedure),'begin','begin /*later-edit*/') into d; execute d; end $x$;`);
  const edited = await md5(d3, 'private.monitor_project_tasks()');
  assert.match((await defOf(d3, 'private.monitor_project_tasks()')), /observe_ops_event/);
  await assert.rejects(d3.exec(bundle), /refusing to overwrite unknown drift/);
  assert.equal(await md5(d3, 'private.monitor_project_tasks()'), edited, 'التعديل اللاحق لم يُستبدل');
  // الملف القانوني لا يُشغَّل خارج الحزمة (يمنع مرحلة صامتة بلا قسم في التقرير)
  const d4 = await liveDb();
  const canonicalSql = readFileSync(path.join(root, 'supabase/project-task-health-monitor.sql'), 'utf8');
  await assert.rejects(d4.exec(canonicalSql), /only through proposed\/12/);
  assert.equal(await md5(d4, 'private.monitor_project_tasks()'), P09_MD5, 'المراقب لم يتغيّر');
  assert.equal(await exists(d4, 'private.ops_events'), false);
  // وكذلك proposed/10 و11 منفردين
  for (const f of ['10-telegram-task-alert-noise-fix.sql', '11-evening-report-open-faults-section.sql']) {
    const d5 = await liveDb();
    await assert.rejects(d5.exec(readFileSync(path.join(root, 'supabase/proposed', f), 'utf8')), /only through proposed\/12/);
    assert.equal(await md5(d5, 'private.monitor_project_tasks()'), P09_MD5);
  }
  console.log('P1#1 OK');
}

// ───────────── P1#2: ذرّية، فشل جزئي، إعادة تطبيق، تراجع ─────────────
{
  // (أ) مرساة مفقودة ⇒ رفض قبلي، المراقب ما زال 09 والتقرير سليم
  const a = await liveDb();
  await a.exec(EVENING(false));
  await assert.rejects(a.exec(bundle), /anchor not found exactly once/);
  assert.equal(await md5(a, 'private.monitor_project_tasks()'), P09_MD5, 'المراقب لم يتغيّر');
  assert.equal(await exists(a, 'private.ops_events'), false);

  // (ب) فشل في منتصف الحزمة (جدول متعارض) ⇒ تراجع كامل، لا حالة نصفية
  const b = await liveDb();
  const evBefore = await defOf(b, 'public.send_evening_report()');
  await b.exec('create table private.ops_events(id int)');
  await assert.rejects(b.exec(bundle));
  await b.exec('rollback').catch(() => {});
  assert.equal(await md5(b, 'private.monitor_project_tasks()'), P09_MD5, 'فشل جزئي: المراقب الأصلي سليم');
  assert.equal(await defOf(b, 'public.send_evening_report()'), evBefore, 'فشل جزئي: التقرير الأصلي سليم');
  assert.equal(await exists(b, 'private.digest_bundle_snapshot'), false, 'اللقطة تراجعت أيضاً');

  // (ب2) ذكر اسم الدالة في تعليق فقط ≠ مُرقَّع ⇒ رفض قبلي، لا تغيير
  const b2 = await liveDb();
  await b2.exec(EVENING(true).replace('perform public.notify_telegram', '/* daily_open_faults_section */ perform public.notify_telegram'));
  const ev2 = await defOf(b2, 'public.send_evening_report()');
  await assert.rejects(b2.exec(bundle), /not as the exact patched block/);
  assert.equal(await md5(b2, 'private.monitor_project_tasks()'), P09_MD5, 'رفض: المراقب لم يتغيّر');
  assert.equal(await defOf(b2, 'public.send_evening_report()'), ev2);

  // (ج) فشل في الرقعة نفسها بعد تحديث المراقب ⇒ المراقب يعود (لا صمت بلا تقرير)
  const c = await liveDb();
  await c.exec(`create or replace function public.send_evening_report() returns void language plpgsql as $f$
    declare msg text; today text; begin msg:='R'; perform public.notify_telegram('evening_report', msg, 'evening:'||today, 720);
    perform public.notify_telegram('evening_report', msg, 'evening:'||today, 720); end $f$;`);
  await assert.rejects(c.exec(bundle), /anchor not found exactly once/);
  assert.equal(await md5(c, 'private.monitor_project_tasks()'), P09_MD5);

  // (د) تطبيق ناجح: المراقب والتقرير معاً
  const d = await liveDb();
  const origEv = await defOf(d, 'public.send_evening_report()');
  await d.exec(bundle);
  const monDef = await defOf(d, 'private.monitor_project_tasks()');
  const evDef = await defOf(d, 'public.send_evening_report()');
  assert.match(monDef, /observe_ops_event/);
  assert.match(evDef, /daily_open_faults_section/);
  // إعادة التطبيق: لا تغيير ولا تكرار لقطة، اللقطة تحتفظ بالأصل
  await d.exec(bundle);
  assert.equal(await defOf(d, 'private.monitor_project_tasks()'), monDef);
  assert.equal(await defOf(d, 'public.send_evening_report()'), evDef);
  const snaps = (await d.query('select fn,def from private.digest_bundle_snapshot order by fn')).rows;
  assert.equal(snaps.length, 2);
  assert.equal(snaps.find((s) => s.fn === 'public.send_evening_report()').def, origEv, 'اللقطة = الأصل لا المعدَّل');
  assert.ok(!snaps.find((s) => s.fn === 'private.monitor_project_tasks()').def.includes('observe_ops_event'));
  // «تزامن» اصطناعي: استدعاءان متداخلان
  await Promise.all([d.exec(bundle), d.exec(bundle)]);
  assert.equal(await defOf(d, 'public.send_evening_report()'), evDef);

  // (هـ) تراجع: يعيد 09 والتقرير الأصلي حرفياً، ثم يمكن التفعيل ثانية
  await d.exec(rollback);
  assert.equal(await md5(d, 'private.monitor_project_tasks()'), P09_MD5);
  assert.equal(await defOf(d, 'public.send_evening_report()'), origEv);
  await assert.rejects(d.exec(rollback), /snapshot is empty/);
  await d.exec(bundle);
  assert.equal(await defOf(d, 'public.send_evening_report()'), evDef);
  console.log('P1#2 OK');
}

// ───────────── P1#3: أعطال قائمة قبل التفعيل تظهر ولا تتكرر ─────────────
{
  const db = await liveDb();
  // مهمة cron فاشلة منذ أيام، وسبق إنذارها بالنظام القديم (حالة الحارس القديم: previous_alert_at حديث)
  await db.exec(`insert into cron.job(jobname) values('dispatch-web-push-outbox'),('healthy-job')`);
  await db.exec(`insert into cron.job_run_details(jobid,status,start_time) values
    (1,'failed',now()-interval '3 days'),(1,'failed',now()-interval '1 day'),(2,'succeeded',now()-interval '2 minutes')`);
  await db.exec('select private.monitor_project_tasks()'); // المراقب القديم يرصد ويرسل مرة
  await db.exec(`update private.project_task_health_state set last_alert_at=now() where task_key='cron:dispatch-web-push-outbox'`);
  // مهمة مشروع متوقفة منذ 10 ساعات (فوق حدّ التأكيد 120 د) وبدأت قبل التفعيل
  await db.exec(`insert into public.inventory_reports(source,created_at) values('ameen_customer_balances', now()-interval '600 minutes')`);
  await db.exec('select private.monitor_project_tasks()');
  await db.exec('delete from sent');

  await db.exec(bundle);
  // بعد التفعيل مباشرة (دون انتظار دورة 5 دقائق): العطلان مفتوحان
  const evs = (await db.query(`select source,event_key,first_seen_at,occurrences from private.ops_events where resolved_at is null`)).rows;
  assert.equal(evs.length, 1);
  assert.equal(evs[0].event_key, 'dispatch-web-push-outbox');
  assert.ok(Date.now() - new Date(evs[0].first_seen_at).getTime() > 23 * 3600e3, 'بداية العطل = آخر تشغيل فاشل لا لحظة التفعيل');
  assert.equal((await db.query(`select 1 from private.project_task_incidents where task_key='customer-balances' and ended_at is null and confirmed_at is not null`)).rows.length, 1);
  assert.equal((await db.query(`select 1 from private.ops_events where event_key='healthy-job'`)).rows.length, 0);

  // تكرار الدورات وإعادة التفعيل: لا حوادث مكررة ولا عدّاد متضخم
  for (let i = 0; i < 6; i++) await db.exec('select private.monitor_project_tasks()');
  await db.exec(bundle);
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null`)).c, 1);
  assert.equal((await one(db, `select count(*)::int c from private.project_task_incidents where ended_at is null and task_key='customer-balances'`)).c, 1);
  assert.equal((await one(db, `select occurrences o from private.ops_events where event_key='dispatch-web-push-outbox'`)).o, 1);

  // التقرير المسائي يعرض العطلين مرة واحدة في الرسالة الرئيسية، ولا رسالة إضافية
  await db.exec(`update private.project_task_health_state set last_observed_at=now()`);
  await db.exec('select public.send_evening_report()');
  const out = await sent(db);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'evening_report');
  assert.equal(out[0].msg.split('dispatch-web-push-outbox').length - 1, 1);
  assert.equal(out[0].msg.split('• أرصدة الزبائن').length - 1, 1);

  // تعافي وإغلاق: نجاح نهائي يغلق، ومهمة محذوفة تُغلق بعد ساعة صمت
  await db.exec(`insert into cron.job_run_details(jobid,status,start_time) values(1,'succeeded',now())`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null`)).c, 0);
  await db.exec(`insert into cron.job(jobname) values('gone-job')`);
  await db.exec(`insert into cron.job_run_details(jobid,status,start_time) values(3,'failed',now()-interval '5 minutes')`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null`)).c, 1);
  await db.exec(`delete from cron.job where jobname='gone-job'`);
  await db.exec(`update private.ops_events set last_seen_at=now()-interval '2 hours' where event_key='gone-job'`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null`)).c, 0);
  // Codex جولة 3: حدث cron مفتوح بقي بعد تراجع بينما حالة الصحة true ⇒ يُغلق عند أول نجاح مُشاهَد
  await db.exec(`insert into cron.job_run_details(jobid,status,start_time) values(2,'succeeded',now())`);
  await db.exec(`insert into private.ops_events(source,event_key,label) values('cron','healthy-job','stale-after-rollback')`);
  await db.exec(`insert into private.project_task_health_state(task_key,is_healthy,last_observed_at) values('cron:healthy-job',true,now()) on conflict(task_key) do update set is_healthy=true`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null and event_key='healthy-job'`)).c, 0);
  console.log('P1#3 OK');
}

// ───────────── الأمن والحرج لا يتأثران، والتقرير المسائي سليم ─────────────
{
  const db = await liveDb();
  await db.exec(bundle);
  const route = async (k, key) => (await one(db, `select private.ops_event_route('${k}','${key}') r`)).r;
  for (const [k, key] of [['security_alert', 'sec:1'], ['health_check', 'health-site-down:1'], ['backup', 'x'], ['unknown_kind', 'x']]) {
    assert.equal(await route(k, key), 'immediate', `${k} يبقى فورياً`);
  }
  // الحرج: بلا دليل مستقل لا إنذار؛ ومع الدليل إنذار واحد + تعافٍ واحد
  await db.exec(`update private.project_task_monitors set severity='critical', enabled=true where task_key='customer-balances'`);
  await db.exec(`insert into public.inventory_reports(source,created_at) values('ameen_customer_balances', now()-interval '600 minutes')`);
  await db.exec('delete from sent; select private.monitor_project_tasks()');
  assert.equal((await sent(db)).length, 0, 'حرج بلا دليل مستقل = ملخص فقط');
  await db.exec(`create or replace function private.core_outage_verified() returns boolean language sql stable as $$ select true $$`);
  await db.exec('select private.monitor_project_tasks(); select private.monitor_project_tasks(); select private.monitor_project_tasks();');
  assert.equal((await sent(db)).filter((r) => r.kind === 'project_task_failure').length, 1, 'إنذار حرج متحقَّق واحد فقط');
  await db.exec(`insert into public.inventory_reports(source,created_at) values('ameen_customer_balances', now())`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await sent(db)).filter((r) => r.kind === 'project_task_recovered').length, 1);
  // تقرير مسائي بلا أعطال
  await db.exec(`delete from sent; update private.project_task_monitors set enabled=false where task_key='price-sync'; update private.project_task_incidents set ended_at=now() where task_key='price-sync' and ended_at is null; update private.project_task_health_state set last_observed_at=now()`);
  await db.exec('select public.send_evening_report()');
  const r = await sent(db);
  assert.equal(r.length, 1);
  assert.match(r[0].msg, /^REPORT\n\n🛠 حالة الأنظمة والأعطال\n✅ لا توجد أعطال تشغيلية مستمرة/);
  console.log('SECURITY/CRITICAL/REPORT OK');
}
// ───────────── Codex جولة 4: مهمة التقرير المسائي المعطّلة + تراجع بعد فشل cron قائم ─────────────
{
  const db = await liveDb();
  await db.exec(bundle);
  await db.exec(`insert into cron.job(jobname) values('send-evening-report'),('other-job')`);
  await db.exec(`insert into cron.job_run_details(jobid,status,start_time) values
    (1,'failed',now()-interval '2 hours'),(2,'failed',now()-interval '2 hours')`);
  await db.exec('delete from sent');
  await db.exec('select private.monitor_project_tasks()');
  let out = await sent(db);
  assert.equal(out.length, 1, 'فقط مهمة التقرير المسائي تُنبَّه فوراً؛ غيرها ملخص');
  assert.equal(out[0].kind, 'project_task_failure');
  assert.match(out[0].msg, /send-evening-report/);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await sent(db)).length, 1, 'لا تكرار للتنبيه لنفس الحادثة');
  // لا تذكير ساعي: حتى لو مرّت ساعتان على آخر تنبيه يبقى تنبيه واحد
  await db.exec(`update private.project_task_health_state set last_alert_at=now()-interval '3 hours' where task_key='cron:send-evening-report'`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await sent(db)).length, 1, 'لا تذكير ساعي');
  // التعافي: يُغلق الحدث داخلياً بلا رسالة
  await db.exec(`insert into cron.job_run_details(jobid,status,start_time) values(1,'succeeded',now())`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await sent(db)).length, 1, 'لا رسالة تعافٍ');
  assert.equal((await one(db, `select count(*)::int c from private.ops_events where resolved_at is null and event_key='send-evening-report'`)).c, 0);
  // مهمة التقرير بلا أي تشغيل بعد (قبل الموعد) ليست عطلاً
  await db.exec(`insert into cron.job(jobname) values('send-evening-report-pre')`);
  await db.exec('select private.monitor_project_tasks()');
  assert.equal((await sent(db)).length, 1, 'غياب التشغيل قبل الموعد ليس عطلاً');
  // 7 مهام فاشلة ⇒ تُصفَّر كلها (لا عطل صامت بعد التراجع)
  for (let k = 0; k < 7; k++) {
    await db.exec(`insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_alert_at,last_alerted_health) values('cron:flood-${k}',false,now()-interval '${k} minutes',now(),'failed')`);
  }
  // التراجع بعد فشل cron قائم: المراقب 09 المستعاد يُنذر عن العطل القائم مرة واحدة
  await db.exec(rollback);
  await db.exec('delete from sent');
  await db.exec('select private.monitor_project_tasks()');
  out = await sent(db);
  assert.ok(out.some((o) => /other-job/.test(o.msg)), 'بعد التراجع يُنذر 09 عن عطل cron القائم');
  const reset = (await one(db, `select count(*)::int c from private.project_task_health_state where task_key like 'cron:flood-%' and last_alert_at is null`)).c;
  assert.equal(reset, 7, `كل أعطال cron القائمة تُنذَر بعد التراجع (flood=${reset})`);
  console.log('P1 round4 OK');
}

// ───────────── كاشف غياب التقرير المسائي (مستقل عن مهمته) ─────────────
{
  const db = await liveDb();
  await db.exec(bundle);
  await db.exec(`
   create table public.telegram_outbox(id serial primary key, event_type text, message text, dedupe_key text,
     status text not null default 'pending', created_at timestamptz not null default now());
   create or replace function public.notify_telegram(k text, m text, dk text default null, dm int default 0, rm jsonb default null)
   returns void language plpgsql as $f$ begin
     if dk is not null and exists(select 1 from public.telegram_outbox where dedupe_key=dk and created_at>now()-make_interval(mins=>dm)) then return; end if;
     insert into public.telegram_outbox(event_type,message,dedupe_key,status) values(k,m,dk,'sent');
     insert into sent values(k,m,dk);
   end $f$;`);
  await db.exec('delete from sent');
  const chk = (t) => db.exec(`select private.check_evening_report_delivered('${t}')`);
  const alerts = async () => (await sent(db)).filter((r) => (r.key || '').startsWith('evening-missing:'));
  const rep = (t, st) => db.exec(`insert into public.telegram_outbox(event_type,message,dedupe_key,status,created_at) values('evening_report','R','evening:x','${st}','${t}')`);
  const openEv = async () => (await one(db, `select count(*)::int c from private.ops_events where source='report' and resolved_at is null`)).c;
  // دمشق = UTC+3: التقرير 23:00 = 20:00Z؛ الحدّ 23:15 = 20:15Z
  // قبل الحدّ (23:10 دمشق): غياب التقرير ليس عطلاً
  await chk('2026-10-12T20:10:00Z');
  assert.equal((await alerts()).length, 0, 'قبل 23:15 لا تنبيه');
  // انقطاع cron: لا تشغيل ولا سجل ولا تقرير ⇒ تنبيه واحد فقط مهما تكرر الفحص
  for (const t of ['20:16', '20:21', '20:26', '21:30', '21:55']) await chk(`2026-10-12T${t}:00Z`);
  assert.equal((await alerts()).length, 1, 'تنبيه واحد لكل تقرير غائب');
  assert.equal((await alerts())[0].key, 'evening-missing:2026-10-12');
  assert.equal(await openEv(), 1);
  // إعادة محاولة ناجحة متأخرة: يُغلق الحدث بلا رسالة جديدة
  await rep('2026-10-12T21:40:00Z', 'sent');
  await chk('2026-10-12T21:45:00Z');
  assert.equal(await openEv(), 0, 'وصول التقرير يغلق الحدث داخلياً');
  assert.equal((await alerts()).length, 1, 'لا رسالة تعافٍ');
  // يوم جديد: تأخر داخل السماح (23:12 دمشق) فلا إنذار كاذب
  await rep('2026-10-13T20:12:00Z', 'sent');
  await chk('2026-10-13T20:16:00Z');
  assert.equal((await alerts()).length, 1, 'تقرير داخل مهلة السماح: لا إنذار');
  // يوم ثالث: فشل إرسال (failed فقط) ⇒ يُعدّ غائباً، ثم إعادة المحاولة تنجح
  await rep('2026-10-14T20:00:00Z', 'failed');
  await chk('2026-10-14T20:16:00Z');
  assert.equal((await alerts()).length, 2, 'فشل الإرسال = غياب فعلي');
  assert.equal((await alerts())[1].key, 'evening-missing:2026-10-14');
  await chk('2026-10-14T20:30:00Z');
  assert.equal((await alerts()).length, 2, 'لا تكرار في اليوم نفسه');
  await rep('2026-10-14T20:35:00Z', 'dispatched');
  await chk('2026-10-14T20:40:00Z'); // قيد الإرسال: لا إغلاق ولا إنذار جديد
  assert.equal(await openEv(), 1, 'dispatched غير مؤكَّد ليس تسليماً');
  await chk('2026-10-14T21:00:00Z'); // dispatched عالق > 10 د: ما زال غياباً (والإنذار مُنع بالمفتاح)
  assert.equal(await openEv(), 1);
  assert.equal((await alerts()).length, 2);
  await rep('2026-10-14T21:05:00Z', 'sent');
  await chk('2026-10-14T21:10:00Z');
  assert.equal(await openEv(), 0, 'sent المؤكَّد يغلق الحدث');
  // pending عالق أكثر من 10 دقائق ليس دليل إرسال؛ pending حديث دليل (بانتظار المُرسِل)
  await rep('2026-10-15T20:05:00Z', 'pending');
  await chk('2026-10-15T20:12:00Z');
  assert.equal((await alerts()).length, 2, 'pending حديث: لا إنذار');
  await chk('2026-10-15T20:30:00Z');
  assert.equal((await alerts()).length, 3, 'pending عالق > 10 د = غياب');
  // يوم لاحق بلا تقرير: حدث الأمس يبقى مفتوحاً (يظهر في ملخص الغد) ثم يُغلق بوصول التقرير
  await chk('2026-10-16T20:16:00Z');
  assert.equal((await alerts()).length, 4, 'يوم جديد = مفتاح جديد');
  assert.equal(await openEv(), 2);
  await rep('2026-10-17T06:00:00Z', 'sent'); // إرسال يدوي مبكر في يوم 17 (09:00 دمشق) يُحسب دليلاً لذلك اليوم
  await chk('2026-10-17T20:20:00Z');
  assert.equal(await openEv(), 0);
  assert.equal((await alerts()).length, 4);
  // بعد منتصف الليل (00:30 دمشق = 21:30Z) ما زال غياب تقرير الأمس يُكشف؛ بعد 02:00 دمشق يبدأ يوم جديد
  await chk('2026-10-18T21:30:00Z');
  assert.equal((await alerts()).length, 5, 'اكتشاف بعد منتصف الليل لتقرير اليوم السابق');
  assert.equal((await alerts())[4].key, 'evening-missing:2026-10-18');
  await chk('2026-10-19T00:00:00Z'); // 03:00 دمشق: يوم 19 قبل حدّه
  assert.equal((await alerts()).length, 5);
  // مستقل عن cron: لا صفوف في cron.job ومع ذلك يُكشف الغياب؛ والمراقب يستدعيه
  assert.equal((await one(db, `select count(*)::int c from cron.job where jobname='send-evening-report'`)).c, 0);
  assert.ok((await one(db, `select position('check_evening_report_delivered' in prosrc) p from pg_proc where oid=to_regprocedure('private.monitor_project_tasks()')`)).p > 0, 'المراقب يستدعي الكاشف');
  // خطأ داخل الكاشف لا يُسقط المراقب
  await db.exec('alter table public.telegram_outbox rename to telegram_outbox_x');
  await chk('2026-10-18T20:20:00Z');
  await db.exec('select private.monitor_project_tasks()');
  console.log('EVENING MISSING DETECTOR OK');
}

console.log('DIGEST BUNDLE SIM OK');
