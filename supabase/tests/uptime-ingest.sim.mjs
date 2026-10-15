// اختبار proposed/14-uptime-ingest.sql على PostgreSQL حقيقي (ومعه عقد التوقيع مع كود الـWorker نفسه).
// خط Telegram محلي فقط: telegram_outbox جدول محلي، وnotify_telegram_dispatch بجسم الإنتاج الحرفي (md5 60bbae6f…).
// لا اتصال بأي خدمة خارجية ولا Telegram ولا Supabase الإنتاج.
// التشغيل: UPTIME_PG_URL=postgres://postgres@host:port/postgres node --test supabase/tests/uptime-ingest.sim.mjs
// (مستخدم superuser على قاعدة محلية مؤقتة؛ يُنشئ قاعدة بيانات مستقلة ويحذفها في النهاية). بلا المتغير ⇒ SKIPPED.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRequest, ingestConfig } from '../../workers/uptime/src/ingest.mjs';
import { runOnce } from '../../workers/uptime/src/core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADMIN_URL = process.env.UPTIME_PG_URL;
const run = promisify(execFile);
const SECRET = 'test-secret-'.padEnd(48, 'x');
const M = 5 * 60_000;

if (!ADMIN_URL) {
  test('uptime-ingest.sim: SKIPPED (عيّن UPTIME_PG_URL لقاعدة PostgreSQL محلية مؤقتة)', () => {});
} else {
  const DB = `uptime_sim_${process.pid}`;
  const dbUrl = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB}`; return u.toString(); })();
  const sqlFile = (p) => readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
  const MIGRATION = sqlFile('supabase/proposed/14-uptime-ingest.sql');
  const ROLLBACK = sqlFile('supabase/proposed/14-uptime-ingest-rollback.sql');
  const psqlArgs = (url, sql) => [url, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql];
  const psql = (sql, url = dbUrl) => execFileSync('psql', psqlArgs(url, sql), { encoding: 'utf8' }).trim();
  const psqlAsync = async (sql) => (await run('psql', psqlArgs(dbUrl, sql), { encoding: 'utf8' })).stdout.trim();
  const lit = (s) => `$ozkq$${s}$ozkq$`;
  const one = (sql) => psql(sql);
  const count = (sql) => Number(psql(sql));

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

  // نداء كما يفعله PostgREST للـWorker: دور anon، نصّ وتوقيع
  const ingestAs = (role, payload, sig) =>
    `set role ${role}; select public.uptime_ingest(${lit(payload)}, ${lit(sig)})::text;`;
  const sign = (payload, secret = SECRET) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const body = ({ events = [], ts = Date.now(), nonce = randomUUID(), scheduledTime = Date.now(), targets } = {}) =>
    JSON.stringify({ v: 1, ts, nonce, scheduledTime, events, targets });
  const ingest = (opts = {}, { role = 'anon', secret = SECRET } = {}) => {
    const p = body(opts);
    return JSON.parse(psql(ingestAs(role, p, sign(p, secret))));
  };
  const rejects = (fn, re) => assert.throws(fn, (e) => re.test(String(e.stderr || e.message)));
  const ev = (target, slot, type, at = slot + 15 * 60_000, detail = 'http-503') => {
    const incident = `${target}:${slot}`;
    return { id: `${incident}:${type}`, type: type.split(':')[0], target, incident, at, detail };
  };
  const outbox = () => count(`select count(*) from public.telegram_outbox where event_type = 'uptime'`);
  const setNotify = (on) => psql(`update private.uptime_config set notify_enabled = ${on}`);
  const reset = () => psql(`truncate private.uptime_events, private.uptime_ingest_nonces, private.uptime_heartbeat;
    delete from private.uptime_incidents; delete from public.telegram_outbox;
    update private.uptime_config set notify_enabled = false, watchdog_enabled = false, stale_minutes = 20;`);

  before(() => {
    psql(`drop database if exists ${DB}`, ADMIN_URL);
    psql(`create database ${DB}`, ADMIN_URL);
    psql(`do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
      end $$;`, ADMIN_URL);
    psql(`
      create schema extensions; create extension pgcrypto schema extensions; create schema private;
      grant usage on schema public, extensions to anon, authenticated, service_role;
      create table public.app_secrets(name text primary key, value text);
      alter table public.app_secrets enable row level security;
      create table public.telegram_outbox(
        id bigserial primary key, event_type text not null, message text not null, dedupe_key text,
        status text not null default 'pending', attempts int not null default 0,
        created_at timestamptz not null default now(), sent_at timestamptz, reply_markup jsonb, net_request_id bigint);
      alter table public.telegram_outbox enable row level security;`);
    psql(PROD_DISPATCH);
    assert.equal(one(`select md5(prosrc) from pg_proc where proname = 'notify_telegram_dispatch'`), '60bbae6f1fed8ba5e66c9a9a91daed40', 'جسم الإنتاج الحرفي');
    psql(MIGRATION);
    psql(MIGRATION); // التطبيق مرتين آمن (idempotent)
  });
  after(() => { try { psql(`drop database if exists ${DB} with (force)`, ADMIN_URL); } catch {} });

  test('بلا سرّ: الدالة خاملة وترفض كل طلب، والمراقب لا يفعل شيئاً', () => {
    rejects(() => ingest(), /uptime_ingest: disabled/);
    psql(`insert into public.app_secrets values ('uptime_ingest_hmac', 'short')`);
    rejects(() => ingest({}, { secret: 'short' }), /uptime_ingest: disabled/);
    psql(`update private.uptime_config set watchdog_enabled = true`);
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'disabled');
    psql(`update public.app_secrets set value = ${lit(SECRET)} where name = 'uptime_ingest_hmac'; update private.uptime_config set watchdog_enabled = false`);
    assert.equal(count(`select count(*) from private.uptime_heartbeat`), 0);
  });

  test('الإعداد الافتراضي: تسجيل فقط (notify_enabled=false) والمراقب مقفل', () => {
    reset();
    assert.equal(one(`select notify_enabled::text || ',' || watchdog_enabled::text || ',' || stale_minutes from private.uptime_config`), 'false,false,20');
    const r = ingest({ events: [ev('site', 1_800_000_000_000, 'down')] });
    assert.deepEqual(r.results, [{ id: 'site:1800000000000:down', outcome: 'recorded' }]);
    assert.equal(outbox(), 0, 'لا رسالة في وضع الظل');
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1, 'الحادثة تُسجَّل رغم ذلك');
  });

  test('أمان HMAC: توقيع خاطئ، نص معدَّل، سرّ آخر، شكل توقيع غير صالح ⇒ 42501 بلا أي كتابة', () => {
    reset();
    const p = body({ events: [ev('site', 1, 'down')] });
    const good = sign(p);
    rejects(() => psql(ingestAs('anon', p, sign(p, 'another-secret'.padEnd(40, 'y')))), /bad request signature/);
    rejects(() => psql(ingestAs('anon', p.replace('"site"', '"bulletin"'), good)), /bad request signature/);
    rejects(() => psql(ingestAs('anon', p, good.toUpperCase())), /bad request signature/);
    rejects(() => psql(ingestAs('anon', p, good.slice(0, 63))), /bad request signature/);
    rejects(() => psql(ingestAs('anon', p, '')), /bad request signature/);
    assert.equal(count(`select count(*) from private.uptime_ingest_nonces`), 0, 'لا nonce يُستهلك قبل التحقق');
    assert.equal(count(`select count(*) from private.uptime_heartbeat`), 0);
    assert.equal(count(`select count(*) from private.uptime_events`), 0);
  });

  test('منع replay: نفس الطلب الموقَّع مرتين يُرفض في الثانية، وطلب خارج النافذة يُرفض', () => {
    reset();
    const p = body({ events: [] });
    psql(ingestAs('anon', p, sign(p)));
    rejects(() => psql(ingestAs('anon', p, sign(p))), /replayed request/);
    const old = body({ ts: Date.now() - 301_000 });
    rejects(() => psql(ingestAs('anon', old, sign(old))), /outside time window/);
    const future = body({ ts: Date.now() + 301_000 });
    rejects(() => psql(ingestAs('anon', future, sign(future))), /outside time window/);
    const badNonce = body({ nonce: 'short' });
    rejects(() => psql(ingestAs('anon', badNonce, sign(badNonce))), /bad nonce/);
    assert.equal(count(`select runs from private.uptime_heartbeat`), 1, 'نبض واحد فقط');
  });

  test('طلبات مزوّرة البنية (حتى بتوقيع صحيح) تُرفض كاملةً', () => {
    reset();
    const signed = (p) => () => psql(ingestAs('anon', p, sign(p)));
    rejects(signed('not json'), /payload is not json/);
    rejects(signed(JSON.stringify({ v: 2, ts: Date.now(), nonce: randomUUID(), events: [] })), /bad payload shape/);
    rejects(signed(JSON.stringify({ v: 1, nonce: randomUUID(), events: [] })), /bad payload shape/);
    const bad = [
      { ...ev('site', 5, 'down'), target: 'admin' },
      { ...ev('site', 5, 'down'), id: 'site:5:down;drop' },
      { ...ev('site', 5, 'down'), id: 'bulletin:5:down' },
      { ...ev('site', 5, 'down'), type: 'recovered' },
      { ...ev('site', 5, 'reminder:2h') },
      { ...ev('site', 5, 'down'), at: 'yesterday' },
    ];
    for (const e of bad) rejects(signed(body({ events: [e] })), /bad event/);
    rejects(signed(body({ events: Array.from({ length: 51 }, (_, i) => ev('bulletin', i, 'down')) })), /too many events/);
    assert.equal(count(`select count(*) from private.uptime_events`), 0);
    assert.equal(count(`select count(*) from private.uptime_heartbeat`), 0, 'رفض الطلب يلغي حتى النبض (معاملة واحدة)');
  });

  test('صلاحيات: anon يستدعي uptime_ingest فقط؛ لا جداول private ولا المراقب ولا dispatch', () => {
    for (const sql of [
      'set role anon; select count(*) from private.uptime_events',
      'set role anon; select public.watch_uptime_heartbeat()',
      `set role anon; select private.notify_telegram_dispatch('uptime','x','k',1,null)`,
      `set role anon; select private.uptime_enqueue('x','k')`,
      'set role authenticated; select public.uptime_ingest(null, null)',
    ]) rejects(() => psql(sql), /permission denied/);
  });

  test('تنبيه ذرّي: الحدث يُسجَّل والتنبيه يُدرج معاً؛ تكرار event_id لا يرسل ثانيةً', () => {
    reset(); setNotify(true);
    const d = ev('site', 1_800_000_000_000, 'down');
    assert.deepEqual(ingest({ events: [d] }).results, [{ id: d.id, outcome: 'notified' }]);
    assert.equal(outbox(), 1);
    assert.equal(one(`select dedupe_key from public.telegram_outbox`), `uptime:${d.id}`);
    assert.match(one(`select message from public.telegram_outbox`), /الموقع لا يستجيب[\s\S]*http-503/);
    assert.deepEqual(ingest({ events: [d] }).results, [{ id: d.id, outcome: 'duplicate' }]);
    assert.deepEqual(ingest({ events: [d, d] }).results, [{ id: d.id, outcome: 'duplicate' }, { id: d.id, outcome: 'duplicate' }]);
    assert.equal(outbox(), 1, 'رسالة واحدة مهما تكرر الطلب');
  });

  test('فشل إدخال outbox ⇒ فشل المعاملة كاملةً: لا حدث مسجّل ولا حادثة ولا nonce ولا نبض', () => {
    reset(); setNotify(true);
    psql(`create function public.fail_outbox() returns trigger language plpgsql as $$ begin raise exception 'outbox down'; end $$;
          create trigger fail_outbox before insert on public.telegram_outbox for each row execute function public.fail_outbox();`);
    const d = ev('site', 1_800_000_300_000, 'down');
    rejects(() => ingest({ events: [d] }), /outbox down/);
    assert.equal(count(`select count(*) from private.uptime_events`), 0, 'event_id غير مسجّل');
    assert.equal(count(`select count(*) from private.uptime_incidents`), 0);
    assert.equal(count(`select count(*) from private.uptime_ingest_nonces`), 0);
    assert.equal(count(`select count(*) from private.uptime_heartbeat`), 0);
    psql(`drop trigger fail_outbox on public.telegram_outbox; drop function public.fail_outbox();`);
    assert.deepEqual(ingest({ events: [d] }).results, [{ id: d.id, outcome: 'notified' }], 'إعادة المحاولة بعد عودة الخدمة تنجح');
    assert.equal(outbox(), 1);
  });

  test('كتم صامت من notify_telegram_dispatch (مفتاح موجود) يُعامل فشلاً لا تسليماً', () => {
    reset(); setNotify(true);
    const d = ev('site', 1_800_000_600_000, 'down');
    psql(`insert into public.telegram_outbox(event_type, message, dedupe_key) values ('uptime', 'older', 'uptime:${d.id}')`);
    rejects(() => ingest({ events: [d] }), /outbox row was not inserted/);
    assert.equal(count(`select count(*) from private.uptime_events`), 0);
  });

  test('نفس الانقطاع بمعرّف حادثة جديد (ضياع حالة KV) ⇒ لا تنبيه ثانٍ؛ التذكير والتعافي مرة واحدة', () => {
    reset(); setNotify(true);
    const a = 1_800_000_000_000, b = a + 30 * 60_000; // b: معرّف جديد لنفس العطل بعد فقدان الحالة
    assert.equal(ingest({ events: [ev('site', a, 'down')] }).results[0].outcome, 'notified');
    assert.equal(ingest({ events: [ev('site', b, 'down')] }).results[0].outcome, 'suppressed:same-outage');
    assert.equal(ingest({ events: [ev('site', b, 'reminder:1h', b + 3_600_000)] }).results[0].outcome, 'notified');
    assert.equal(ingest({ events: [ev('site', a, 'reminder:1h', a + 3_600_000)] }).results[0].outcome, 'suppressed:reminder-sent');
    assert.equal(ingest({ events: [ev('site', b, 'recovered', b + 4_000_000)] }).results[0].outcome, 'notified');
    assert.equal(ingest({ events: [ev('site', a, 'recovered', a + 4_100_000)] }).results[0].outcome, 'suppressed:no-open-incident');
    assert.equal(outbox(), 3, 'down + تذكير 1h + recovered');
    assert.equal(count(`select count(*) from private.uptime_incidents`), 1);
    assert.equal(one(`select array_length(aliases, 1) from private.uptime_incidents`), '1');
  });

  test('تفعيل الإرسال وحادثة فُتحت في الظل ما زالت مفتوحة ⇒ تنبيه انقطاع واحد، ثم تذكير وتعافٍ', () => {
    reset();
    const S = 1_800_000_000_000;
    ingest({ events: [ev('site', S, 'down'), ev('bulletin', S, 'down')] });   // الظل: تسجيل فقط
    assert.equal(outbox(), 0);
    setNotify(true);
    let r = ingest();                                                           // نبض حي بعد التفعيل
    assert.deepEqual(r.results, []);
    assert.equal(outbox(), 1, 'ترقية الحادثة المفتوحة');
    assert.equal(count(`select count(*) from public.telegram_outbox where dedupe_key = 'uptime:site:${S}:down'`), 1);
    assert.match(one(`select message from public.telegram_outbox`), /🔴/);
    ingest(); assert.equal(outbox(), 1, 'لا تكرار في النبض التالي');
    r = ingest({ events: [ev('site', S, 'reminder:1h', S + 3_600_000)] });
    assert.equal(r.results[0].outcome, 'notified');
    r = ingest({ events: [ev('site', S, 'recovered', S + 4_000_000)] });
    assert.equal(r.results[0].outcome, 'notified');
    assert.equal(outbox(), 3, 'انقطاع + تذكير + تعافٍ، والنشرة بلا رسالة');
  });

  test('حادثة الظل التي تعافت في الطلب نفسه لا تُرقّى', () => {
    reset();
    const S = 1_800_000_000_000;
    ingest({ events: [ev('site', S, 'down')] });
    setNotify(true);
    ingest({ events: [ev('site', S, 'recovered', S + 3_000_000)] });
    assert.equal(outbox(), 0, 'لا تنبيه لانقطاع لم يُبلَّغ وانتهى');
  });

  test('ضياع حالة KV بعد انقطاع مُبلَّغ: نبض بحالة UP يُغلق الحادثة برسالة تعافٍ، والانقطاع التالي يُنبَّه', () => {
    reset(); setNotify(true);
    const now = Date.now(); const S1 = now - 3_600_000;
    ingest({ events: [ev('site', S1, 'down', now - 3_000_000)], scheduledTime: now - 3_000_000 });
    assert.equal(outbox(), 1);
    ingest({ scheduledTime: now - 60_000, targets: { site: 'SUSPECT' } });   // ليس UP ⇒ لا مطابقة
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1);
    ingest({ scheduledTime: now, targets: { site: 'UP', bulletin: 'UP' } });  // Worker بحالة جديدة: الموقع شغّال
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 0, 'أُغلقت');
    assert.equal(outbox(), 2, 'رسالة تعافٍ واحدة');
    assert.match(one(`select message from public.telegram_outbox order by id desc limit 1`), /✅/);
    ingest({ scheduledTime: now + 1, targets: { site: 'UP' } });
    assert.equal(outbox(), 2, 'لا تكرار');
    const r = ingest({ events: [ev('site', now, 'down', now + 2)], scheduledTime: now + 2 });
    assert.equal(r.results[0].outcome, 'notified', 'الانقطاع التالي لا يُكتم كاسم بديل');
  });

  test('مطابقة الحالة: طلب أقدم من آخر طلب مقبول لا يُغلق، والحادثة غير المُبلَّغة تُغلق بصمت', () => {
    reset();
    const now = Date.now(); const S = now - 600_000;
    ingest({ events: [ev('site', S, 'down', now - 120_000)], scheduledTime: now - 120_000 });  // ظل: بلا تنبيه
    setNotify(true);
    ingest({ scheduledTime: now - 60_000, targets: { site: 'DOWN' } });       // ترقية: تنبيه انقطاع
    assert.equal(outbox(), 1);
    ingest({ scheduledTime: now - 90_000, targets: { site: 'UP' } });          // طلب متأخر أقدم
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1, 'لم يُغلق');
    reset();
    ingest({ events: [ev('site', S, 'down', now - 120_000)], scheduledTime: now - 120_000 });
    ingest({ scheduledTime: now, targets: { site: 'UP' } });                   // الإرسال مقفل
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 0);
    assert.equal(outbox(), 0);
  });

  test('حقل targets غير صالح يُرفض', () => {
    reset();
    for (const targets of [[], { site: 'up' }, { other: 'UP' }, { site: 1 }]) {
      rejects(() => ingest({ targets }), /bad targets/);
    }
  });

  test('النشرة تسجيل فقط حتى مع تفعيل الإرسال (قرار الخادم)', () => {
    reset(); setNotify(true);
    const r = ingest({ events: [ev('bulletin', 1, 'down', 10, 'http-404'), ev('bulletin', 1, 'recovered', 20)] });
    assert.deepEqual(r.results.map((x) => x.outcome), ['recorded', 'recorded']);
    assert.equal(outbox(), 0);
  });

  test('ترتيب زمني داخل الطلب: down قبل recovered، والطلب المتأخر لا يعيد النبض إلى الوراء', () => {
    reset(); setNotify(true);
    const s = 1_800_000_000_000;
    const r = ingest({ events: [ev('site', s, 'recovered', s + 20 * 60_000), ev('site', s, 'down', s + 10 * 60_000)], scheduledTime: s + 20 * 60_000 });
    assert.deepEqual(r.results.map((x) => x.outcome), ['notified', 'notified']);
    ingest({ scheduledTime: s }); // تشغيل Cron متأخر/قديم
    assert.equal(one(`select (extract(epoch from last_scheduled_at) * 1000)::bigint from private.uptime_heartbeat`), String(s + 20 * 60_000));
    assert.equal(one(`select runs from private.uptime_heartbeat`), '2');
  });

  test('تزامن: طلبان متوازيان بنفس الحدث، وحادثتان متوازيتان لنفس الهدف ⇒ رسالة واحدة', async () => {
    reset(); setNotify(true);
    const d = ev('site', 1_800_000_000_000, 'down');
    const call = (events) => { const p = body({ events }); return psqlAsync(ingestAs('anon', p, sign(p))).then(JSON.parse); };
    const rs = await Promise.all(Array.from({ length: 6 }, () => call([d])));
    assert.deepEqual(rs.map((r) => r.results[0].outcome).sort(), ['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'notified']);
    reset(); setNotify(true);
    const rs2 = await Promise.all([1, 2, 3, 4].map((k) => call([ev('site', 1_800_000_000_000 + k * M, 'down')])));
    assert.deepEqual(rs2.map((r) => r.results[0].outcome).sort(), ['notified', 'suppressed:same-outage', 'suppressed:same-outage', 'suppressed:same-outage']);
    assert.equal(outbox(), 1);
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1);
  });

  test('المراقب (20 دقيقة): تنبيه واحد لكل توقف، تعافٍ واحد، ولا شيء وهو مقفل', () => {
    reset();
    ingest({});
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'disabled');
    psql(`update private.uptime_config set watchdog_enabled = true`);
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'ok');
    psql(`update private.uptime_heartbeat set last_received_at = now() - interval '19 minutes'`);
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'ok', 'تأخر Cron دون العتبة لا يُنذر');
    psql(`update private.uptime_heartbeat set last_received_at = now() - interval '21 minutes'`);
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'stale-alerted');
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'stale', 'لا تكرار كل 5 دقائق');
    assert.equal(outbox(), 1);
    assert.match(one(`select message from public.telegram_outbox order by id desc limit 1`), /مراقب الموقع متوقف/);
    ingest({}); // عاد النبض
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'recovered');
    assert.equal(one(`select public.watch_uptime_heartbeat()`), 'ok');
    assert.equal(outbox(), 2);
    psql(`update private.uptime_config set watchdog_enabled = false`);
  });

  test('عقد التوقيع مع كود الـWorker: buildRequest يوقّع والخادم يقبل', async () => {
    reset();
    const cfg = ingestConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', UPTIME_HMAC_SECRET: SECRET });
    const { payload, signature } = await buildRequest(cfg, { events: [ev('bulletin', 7, 'down')], scheduledTime: Date.now() });
    const r = JSON.parse(psql(ingestAs('anon', payload, signature)));
    assert.equal(r.ok, true);
    assert.equal(r.results[0].outcome, 'recorded');
  });

  test('تكامل كامل: runOnce الحقيقي ↔ PostgreSQL، مع فشل Supabase ثم فشل كتابة KV', async () => {
    reset(); setNotify(true);
    const env = { DRY_RUN: '0', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', UPTIME_HMAC_SECRET: SECRET };
    let supabaseUp = true; const rpcCalls = [];
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://ozktobacco.com/')) return new Response('', { status: u.includes('price-list') ? 200 : 503 });
      assert.equal(u, 'https://example.supabase.co/rest/v1/rpc/uptime_ingest');
      assert.equal(init.headers.apikey, 'sb_publishable_test');
      assert.equal(init.headers.authorization, undefined, 'لا رمز خدمة');
      rpcCalls.push(u);
      if (!supabaseUp) return new Response('{"message":"upstream"}', { status: 503 });
      const { p_payload, p_signature } = JSON.parse(init.body);
      try { return new Response(await psqlAsync(ingestAs('anon', p_payload, p_signature)), { status: 200 }); }
      catch { return new Response('{"message":"rejected"}', { status: 400 }); }
    };
    let v = null; let failPut = false;
    const kv = { get: async () => v, put: async (_, s) => { if (failPut) throw new Error('kv 503'); v = s; } };
    const T0 = 1_800_000_000_000;
    const step = (i) => runOnce({ env, now: T0 + i * M, fetchImpl, kv, log: () => {} });
    await step(0); await step(1);                       // SUSPECT
    supabaseUp = false;
    await assert.rejects(step(2), /ingest failed \(http-503\)/); // DOWN: Supabase متعطل
    assert.equal(JSON.parse(v).pending.length, 1, 'محفوظ معلّقاً');
    assert.equal(outbox(), 0);
    supabaseUp = true; failPut = true;
    await assert.rejects(step(3), /storage write failed/); // أُرسل وقُبل، لكن KV فشل ⇒ الحالة القديمة باقية
    assert.equal(outbox(), 1);
    failPut = false;
    const o = await step(4);                             // يُعاد الإرسال بنفس المعرّف ⇒ duplicate
    assert.equal(o.ingest.ok, true);
    assert.equal(JSON.parse(v).pending.length, 0);
    assert.equal(outbox(), 1, 'رسالة واحدة رغم فشل Supabase ثم فشل KV');
    assert.equal(count(`select runs from private.uptime_heartbeat`), 4, 'نبض لكل تشغيل وصل الخادم (0،1،3،4؛ 2 فشل عند Supabase)');
    assert.ok(rpcCalls.length >= 3);
  });

  test('التراجع: يزيل كل كائنات 14 ولا يمسّ telegram_outbox، ويرفض إن كان المراقب مجدولاً', () => {
    const rowsBefore = count(`select count(*) from public.telegram_outbox`);
    psql(`create schema cron; create table cron.job(jobid serial, jobname text, command text);
          insert into cron.job(jobname, command) values ('uptime-heartbeat-watch', 'select public.watch_uptime_heartbeat()');`);
    rejects(() => psql(ROLLBACK), /unschedule the uptime watchdog/);
    psql(`delete from cron.job`);
    psql(ROLLBACK);
    assert.equal(count(`select count(*) from pg_proc where proname in ('uptime_ingest','watch_uptime_heartbeat','uptime_enqueue','uptime_message')`), 0);
    assert.equal(count(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname like 'uptime_%'`), 0);
    assert.equal(count(`select count(*) from public.telegram_outbox`), rowsBefore);
    assert.equal(one(`select md5(prosrc) from pg_proc where proname = 'notify_telegram_dispatch'`), '60bbae6f1fed8ba5e66c9a9a91daed40', 'dispatch لم تُمس');
    psql(MIGRATION); // إعادة التطبيق بعد التراجع
    assert.equal(count(`select count(*) from pg_proc where proname = 'uptime_ingest'`), 1);
  });
}
