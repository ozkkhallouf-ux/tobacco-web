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
    assert.equal(ingest({ events: [ev('site', b, 'recovered', b + 4_000_000)], scheduledTime: b + 4_000_000 }).results[0].outcome, 'recovery-pending');
    assert.equal(ingest({ events: [ev('site', a, 'recovered', a + 4_100_000)], scheduledTime: b + 4_100_000 }).results[0].outcome, 'suppressed:recovery-pending');
    ingest({ scheduledTime: b + 4_300_000, targets: { site: 'UP' } });               // دورة مرشّحة
    assert.equal(outbox(), 2, 'لا تعافٍ قبل دورتين');
    ingest({ scheduledTime: b + 4_600_000, targets: { site: 'UP' } });               // تأكيد
    assert.equal(outbox(), 3, 'down + تذكير 1h + recovered');
    assert.equal(count(`select count(*) from public.telegram_outbox where dedupe_key = 'uptime:site:${a}:recovered:${b + 4_000_000}'`), 1);
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
    r = ingest({ events: [ev('site', S, 'recovered', S + 4_000_000)], scheduledTime: S + 4_000_000, targets: { site: 'UP' } });
    assert.equal(r.results[0].outcome, 'recovery-pending');
    assert.equal(outbox(), 2, 'لا رسالة تعافٍ قبل التأكيد');
    ingest({ scheduledTime: S + 4_300_000, targets: { site: 'UP', bulletin: 'DOWN' } });
    ingest({ scheduledTime: S + 4_600_000, targets: { site: 'UP', bulletin: 'DOWN' } });
    assert.equal(outbox(), 3, 'انقطاع + تذكير + تعافٍ، والنشرة بلا رسالة');
  });

  test('حادثة الظل التي تعافت في الطلب نفسه لا تُرقّى', () => {
    reset();
    const S = 1_800_000_000_000;
    ingest({ events: [ev('site', S, 'down')] });
    setNotify(true);
    ingest({ events: [ev('site', S, 'recovered', S + 3_000_000)], scheduledTime: S + 3_000_000, targets: { site: 'UP' } });
    assert.equal(outbox(), 0, 'تعافٍ معلّق: لا ترقية');
    ingest({ scheduledTime: S + 3_300_000, targets: { site: 'UP' } });
    ingest({ scheduledTime: S + 3_600_000, targets: { site: 'UP' } });
    assert.equal(outbox(), 0, 'لا تنبيه لانقطاع لم يُبلَّغ وانتهى');
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 0);
  });

  test('ضياع حالة KV بعد انقطاع مُبلَّغ: نبض بحالة UP يُغلق الحادثة برسالة تعافٍ، والانقطاع التالي يُنبَّه', () => {
    reset(); setNotify(true);
    const now = Date.now(); const S1 = now - 3_600_000;
    ingest({ events: [ev('site', S1, 'down', now - 3_000_000)], scheduledTime: now - 3_000_000 });
    assert.equal(outbox(), 1);
    ingest({ scheduledTime: now - 60_000, targets: { site: 'SUSPECT' } });   // ليس UP ⇒ لا مطابقة
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1);
    ingest({ scheduledTime: now - 30_000, targets: { site: 'UP', bulletin: 'UP' } });  // Worker بحالة جديدة: الموقع شغّال
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1, 'تعافٍ معلّق لا إغلاق');
    assert.equal(outbox(), 1);
    ingest({ scheduledTime: now - 20_000, targets: { site: 'UP', bulletin: 'UP' } });     // دورة مرشّحة
    assert.equal(outbox(), 1);
    ingest({ scheduledTime: now, targets: { site: 'UP', bulletin: 'UP' } });              // تأكيد
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
    ingest({ scheduledTime: now - 60_000, targets: { site: 'UP' } });
    ingest({ scheduledTime: now - 30_000, targets: { site: 'UP' } });
    ingest({ scheduledTime: now, targets: { site: 'UP' } });                   // الإرسال مقفل
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 0);
    assert.equal(outbox(), 0);
  });

  test('تشغيلان لنفس الدقيقة اختلف فحصهما: UP لا يُغلق حادثة فتحها DOWN (لا تعافٍ كاذب)', async () => {
    reset(); setNotify(true);
    const tick = Date.now();
    ingest({ events: [ev('site', tick - 600_000, 'down', tick)], scheduledTime: tick, targets: { site: 'DOWN' } });
    ingest({ scheduledTime: tick, targets: { site: 'UP' } });
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 1, 'ما زالت مفتوحة');
    assert.equal(outbox(), 1, 'لا رسالة تعافٍ');
    // متزامنان فعلاً: الثاني ينتظر قفل النبض ويقرأ ما ثبّته الأول
    reset(); setNotify(true);
    const t2 = Date.now() + 1;
    const pd = body({ events: [ev('site', t2 - 600_000, 'down', t2)], scheduledTime: t2, targets: { site: 'DOWN' } });
    const pu = body({ scheduledTime: t2, targets: { site: 'UP' } });
    await Promise.all([psqlAsync(ingestAs('anon', pd, sign(pd))), psqlAsync(ingestAs('anon', pu, sign(pu)))]);
    const open = count(`select count(*) from private.uptime_incidents where closed_at is null`);
    assert.equal(open, 1, 'أيّاً كان الترتيب تبقى الحادثة مفتوحة');
    assert.equal(outbox(), 1);
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
    assert.deepEqual(r.results.map((x) => x.outcome), ['recorded', 'recovery-pending']);
    ingest({ scheduledTime: Date.now(), targets: { bulletin: 'UP' } });
    ingest({ scheduledTime: Date.now() + 1, targets: { bulletin: 'UP' } });
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 0);
    assert.equal(one(`select outcome from private.uptime_events where type = 'recovered'`), 'recorded');
    assert.equal(outbox(), 0);
  });

  test('ترتيب زمني داخل الطلب: down قبل recovered، والطلب المتأخر لا يعيد النبض إلى الوراء', () => {
    reset(); setNotify(true);
    const s = 1_800_000_000_000;
    const r = ingest({ events: [ev('site', s, 'recovered', s + 20 * 60_000), ev('site', s, 'down', s + 10 * 60_000)], scheduledTime: s + 20 * 60_000 });
    assert.deepEqual(r.results.map((x) => x.outcome), ['notified', 'recovery-pending']);
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

  test('تكامل: انقطاع بدأ في DRY_RUN ثم فُعّل الإرسال والموقع واقف ⇒ تنبيه واحد ثم تعافٍ واحد', async () => {
    reset(); setNotify(true);
    const live = { DRY_RUN: '0', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', UPTIME_HMAC_SECRET: SECRET };
    let siteUp = false;
    const fetchImpl = async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://ozktobacco.com/')) {
        if (u.includes('price-list')) return new Response('x', { status: 200 });
        return siteUp ? new Response('OZK TOBACCO', { status: 200 }) : new Response('', { status: 503 });
      }
      const { p_payload, p_signature } = JSON.parse(init.body);
      try { return new Response(await psqlAsync(ingestAs('anon', p_payload, p_signature)), { status: 200 }); }
      catch { return new Response('{"message":"rejected"}', { status: 400 }); }
    };
    let v = null;
    const kv = { get: async () => v, put: async (_, s2) => { v = s2; } };
    const T = Date.now() - 6 * M;
    const step = (i, env) => runOnce({ env, now: T + i * M, fetchImpl, kv, log: () => {} });
    for (let i = 0; i < 4; i++) await step(i, {});                      // DOWN في الظل
    assert.equal(outbox(), 0);
    await step(4, live);
    assert.equal(outbox(), 1, 'تنبيه الانقطاع الجاري');
    await step(5, live);
    assert.equal(outbox(), 1);
    siteUp = true; await step(6, live); await step(7, live);
    assert.equal(outbox(), 1, 'التعافي معلّق حتى يؤكده تشغيلان تاليان');
    await step(8, live);
    assert.equal(outbox(), 1);
    await step(9, live);
    assert.equal(outbox(), 2, 'تعافٍ واحد');
    assert.equal(count(`select count(*) from private.uptime_incidents where closed_at is null`), 0);
  });

  // ── التعافي على مرحلتين (ملاحظة Codex P1 على 2147c43): لا إغلاق ولا رسالة تعافٍ إلا بتأكيد تشغيل أحدث تماماً ──
  const openCount = () => count(`select count(*) from private.uptime_incidents where closed_at is null`);
  const recovered = () => count(`select count(*) from public.telegram_outbox where message like '✅%'`);

  test('تعافٍ مرتّب: DOWN ثم RECOVERED ثم تأكيد ⇒ إغلاق بوقت التعافي الفعلي ورسالة واحدة', () => {
    reset(); setNotify(true);
    const S = 1_900_000_000_000; const D = S + 2 * M; const R = S + 20 * M;
    assert.equal(ingest({ events: [ev('site', S, 'down', D)], scheduledTime: D, targets: { site: 'DOWN' } }).results[0].outcome, 'notified');
    assert.equal(ingest({ events: [ev('site', S, 'recovered', R)], scheduledTime: R, targets: { site: 'UP' } }).results[0].outcome, 'recovery-pending');
    assert.equal(openCount(), 1, 'نفس الطلب لا يؤكد نفسه');
    assert.equal(recovered(), 0);
    ingest({ scheduledTime: R + M, targets: { site: 'UP' } });
    assert.equal(openCount(), 1, 'دورة مرشّحة فقط');
    ingest({ scheduledTime: R + 2 * M, targets: { site: 'UP' } });
    assert.equal(openCount(), 0);
    assert.equal(recovered(), 1);
    assert.equal(one(`select (extract(epoch from closed_at) * 1000)::bigint from private.uptime_incidents`), String(R), 'closed_at = وقت التعافي لا وقت التأكيد');
    assert.equal(one(`select outcome || ',' || outbox_dedupe_key from private.uptime_events where type = 'recovered'`), `notified,uptime:site:${S}:recovered:${R}`);
    ingest({ scheduledTime: R + 3 * M, targets: { site: 'UP' } });
    assert.equal(recovered(), 1, 'لا تكرار');
  });

  test('RECOVERED قديم يصل بعد DOWN أحدث ⇒ لا يمسّ الحادثة الأحدث', () => {
    reset(); setNotify(true);
    const S1 = 1_900_000_000_000; const S2 = S1 + 60 * M;
    ingest({ events: [ev('site', S1, 'down', S1 + 2 * M)], scheduledTime: S1 + 2 * M });
    ingest({ scheduledTime: S1 + 10 * M, targets: { site: 'UP' } });          // ضياع KV: تعافٍ من النبض
    ingest({ scheduledTime: S1 + 11 * M, targets: { site: 'UP' } });          // مرشّحة
    ingest({ scheduledTime: S1 + 12 * M, targets: { site: 'UP' } });          // مؤكد ⇒ S1 مغلقة
    ingest({ events: [ev('site', S2, 'down', S2 + 2 * M)], scheduledTime: S2 + 2 * M, targets: { site: 'DOWN' } });
    assert.equal(outbox(), 3, 'down S1 + تعافيها + down S2');
    const late = ingest({ events: [ev('site', S1, 'recovered', S1 + 9 * M)], scheduledTime: S2 + 3 * M, targets: { site: 'DOWN' } });
    assert.equal(late.results[0].outcome, 'suppressed:stale-recovery');
    const older = ingest({ events: [ev('site', S2 - 30 * M, 'recovered', S2 - 5 * M)], scheduledTime: S2 + 4 * M, targets: { site: 'DOWN' } });
    assert.equal(older.results[0].outcome, 'suppressed:stale-recovery', 'تعافٍ أقدم من فتح الحادثة');
    ingest({ scheduledTime: S2 + 5 * M, targets: { site: 'UP' } });          // تعافٍ معلّق من النبض
    assert.equal(one(`select recover_event is null from private.uptime_incidents where closed_at is null`), 't');
    assert.equal(openCount(), 1, 'الحادثة الأحدث ما زالت مفتوحة');
    assert.equal(recovered(), 1);
  });

  test('تكرار RECOVERED (نفس المعرّف أو معرّف بديل) ⇒ رسالة تعافٍ واحدة', () => {
    reset(); setNotify(true);
    const a = 1_900_000_000_000; const b = a + 30 * M;
    ingest({ events: [ev('site', a, 'down', a + 2 * M)], scheduledTime: a + 2 * M });
    ingest({ events: [ev('site', b, 'down', b + 2 * M)], scheduledTime: b + 2 * M });   // اسم بديل
    const r1 = ev('site', b, 'recovered', b + 20 * M);
    assert.equal(ingest({ events: [r1], scheduledTime: b + 20 * M }).results[0].outcome, 'recovery-pending');
    assert.equal(ingest({ events: [r1, r1], scheduledTime: b + 20 * M + 1 }).results.map((x) => x.outcome).join(), 'duplicate,duplicate');
    assert.equal(ingest({ events: [ev('site', a, 'recovered', b + 21 * M)], scheduledTime: b + 21 * M }).results[0].outcome, 'suppressed:recovery-pending');
    ingest({ scheduledTime: b + 22 * M, targets: { site: 'UP' } });
    ingest({ events: [r1], scheduledTime: b + 23 * M, targets: { site: 'UP' } });
    assert.equal(recovered(), 1);
    assert.equal(count(`select count(*) from private.uptime_incidents`), 1);
  });

  test('إلغاء التعافي المعلّق: تشغيل أحدث بحالة DOWN/RECOVERING أو تذكير أحدث؛ تشغيل نفس الدقيقة لا يحسم', () => {
    reset(); setNotify(true);
    const S = 1_900_000_000_000; const R = S + 20 * M;
    ingest({ events: [ev('site', S, 'down', S + 2 * M)], scheduledTime: S + 2 * M });
    ingest({ events: [ev('site', S, 'recovered', R)], scheduledTime: R, targets: { site: 'UP' } });
    ingest({ scheduledTime: R, targets: { site: 'DOWN' } });                 // نفس الدقيقة: لا حسم
    assert.equal(one(`select recover_at is not null from private.uptime_incidents`), 't');
    ingest({ scheduledTime: R + M, targets: { site: 'SUSPECT' } });         // لا قرار
    assert.equal(one(`select recover_at is not null from private.uptime_incidents`), 't');
    ingest({ scheduledTime: R + 2 * M, targets: { site: 'DOWN' } });        // أحدث تماماً ⇒ إلغاء
    assert.equal(one(`select recover_at is null from private.uptime_incidents`), 't');
    assert.equal(one(`select outcome from private.uptime_events where type = 'recovered'`), 'suppressed:recovery-cancelled');
    ingest({ scheduledTime: R + 3 * M, targets: { site: 'UP' } });          // يُعلَّق من جديد…
    assert.equal(ingest({ events: [ev('site', S, 'reminder:1h', S + 62 * M)], scheduledTime: S + 62 * M }).results[0].outcome, 'notified');
    assert.equal(one(`select recover_at is null from private.uptime_incidents`), 't', '…ويلغيه تذكير أحدث');
    assert.equal(openCount(), 1);
    assert.equal(recovered(), 0, 'لا تعافٍ كاذب');
    assert.equal(outbox(), 2, 'down + تذكير 1h');
  });

  test('طلبان متزامنان لنفس الدقيقة (recovered+UP مقابل DOWN) بكل ترتيب ⇒ لا إغلاق ولا رسالة، ويحسم التشغيل التالي', async () => {
    for (const nextStatus of ['DOWN', 'UP']) {
      reset(); setNotify(true);
      const S = Date.now() - 40 * M; const T = S + 20 * M;
      ingest({ events: [ev('site', S, 'down', S + 2 * M)], scheduledTime: S + 2 * M, targets: { site: 'DOWN' } });
      const pa = body({ events: [ev('site', S, 'recovered', T)], scheduledTime: T, targets: { site: 'UP' } });
      const pb = body({ scheduledTime: T, targets: { site: 'DOWN' } });
      await Promise.all([psqlAsync(ingestAs('anon', pa, sign(pa))), psqlAsync(ingestAs('anon', pb, sign(pb)))]);
      assert.equal(openCount(), 1);
      assert.equal(recovered(), 0, 'لا تعافٍ قبل الحسم');
      ingest({ scheduledTime: T + M, targets: { site: nextStatus } });
      ingest({ scheduledTime: T + 2 * M, targets: { site: nextStatus } });
      assert.equal(openCount(), nextStatus === 'UP' ? 0 : 1);
      assert.equal(recovered(), nextStatus === 'UP' ? 1 : 0);
    }
  });

  // تكامل حقيقي: runOnce مرتين بالتزامن لنفس scheduledTime، فحص الموقع مختلف، وترتيب وصول الطلبين وكتابة KV متحكَّم به.
  const raceHarness = () => {
    const live = { DRY_RUN: '0', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', UPTIME_HMAC_SECRET: SECRET };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let v = null;
    const T = Date.now() - 30 * M;
    const history = [];                                    // قيمة KV بعد كل دورة (لمحاكاة قراءة قديمة)
    const run = (i, siteOk, { rpcDelay = 0, putDelay = 0, readStale, rpcFail = false } = {}) => runOnce({
      env: live, now: T + i * M, log: () => {},
      kv: {
        get: async () => (readStale === undefined ? v : history[readStale]),
        put: async (_, s2) => { if (putDelay) await sleep(putDelay); v = s2; },
      },
      fetchImpl: async (url, init) => {
        const u = String(url);
        if (u.startsWith('https://ozktobacco.com/')) {
          if (u.includes('price-list')) return new Response('x', { status: 200 });
          return siteOk ? new Response('OZK TOBACCO', { status: 200 }) : new Response('', { status: 503 });
        }
        if (rpcDelay) await sleep(rpcDelay);
        if (rpcFail) return new Response('{"message":"upstream"}', { status: 503 });
        const { p_payload, p_signature } = JSON.parse(init.body);
        try { return new Response(await psqlAsync(ingestAs('anon', p_payload, p_signature)), { status: 200 }); }
        catch { return new Response('{"message":"rejected"}', { status: 400 }); }
      },
    });
    const state = () => JSON.parse(v);
    const snap = (i) => { history[i] = v; };
    return { run, state, snap };
  };
  const toRecovering = async (h) => {
    for (let i = 0; i < 3; i++) { await h.run(i, false); h.snap(i); } // UP → SUSPECT → … → DOWN (تنبيه)
    await h.run(3, true); h.snap(3);                       // RECOVERING (okStreak = 1)
    assert.equal(h.state().targets.site.status, 'RECOVERING');
    assert.equal(outbox(), 1);
  };

  test('Cron مرتين بالتزامن واختلف الفحص، بكل ترتيبات الوصول وكتابة KV ⇒ لا تعافٍ كاذب ولا حادثة ثانية', async () => {
    const orders = [
      { name: 'recovered يصل أولاً، DOWN يكسب KV', a: { putDelay: 250 }, b: { rpcDelay: 120, putDelay: 400 } },
      { name: 'DOWN يصل أولاً، DOWN يكسب KV', a: { rpcDelay: 120 }, b: { putDelay: 400 } },
      { name: 'recovered يصل أولاً، recovered يكسب KV', a: { putDelay: 400 }, b: { rpcDelay: 120 } },
      { name: 'DOWN يصل أولاً، recovered يكسب KV', a: { rpcDelay: 120, putDelay: 400 }, b: {} },
    ];
    for (const o of orders) {
      reset(); setNotify(true);
      const h = raceHarness();
      await toRecovering(h);
      await Promise.all([h.run(4, true, o.a), h.run(4, false, o.b)]);
      for (let i = 5; i <= 7; i++) await h.run(i, false);  // الانقطاع مستمر
      assert.equal(recovered(), 0, `${o.name}: لا رسالة تعافٍ`);
      assert.equal(count(`select count(*) from private.uptime_incidents`), 1, `${o.name}: حادثة واحدة`);
      assert.equal(openCount(), 1, `${o.name}: مفتوحة`);
      assert.equal(one(`select recover_at is null from private.uptime_incidents`), 't', `${o.name}: التعافي المعلّق أُلغي`);
      assert.equal(h.state().targets.site.status, 'DOWN');
      assert.equal(outbox(), 1, `${o.name}: تنبيه الانقطاع الأول فقط`);
    }
  });

  test('بعد السباق (DOWN يكسب KV): التذكيرات تستمر بنفس الحادثة، والتعافي الحقيقي يُبلَّغ مرة واحدة', async () => {
    reset(); setNotify(true);
    const h = raceHarness();
    await toRecovering(h);
    const incident = h.state().targets.site.incident.id;
    await Promise.all([h.run(4, true, { putDelay: 250 }), h.run(4, false, { rpcDelay: 120, putDelay: 400 })]);
    assert.equal(h.state().targets.site.incident.id, incident, 'نفس معرّف الحادثة');
    for (let i = 5; i <= 14; i++) await h.run(i, false);  // ساعة على أول down (i=2)
    assert.equal(outbox(), 2);
    assert.match(one(`select message from public.telegram_outbox order by id desc limit 1`), /⏳/);
    assert.equal(one(`select incident_key from private.uptime_incidents`), incident);
    await h.run(15, true); await h.run(16, true);          // تعافٍ حقيقي (معرّف recovered مكرر ⇒ تعافٍ من النبض)
    await h.run(17, true);
    assert.equal(recovered(), 0, 'معلّق: مرشّحة');
    await h.run(18, true);
    assert.equal(recovered(), 1);
    assert.equal(openCount(), 0);
    assert.equal(outbox(), 3, 'انقطاع + تذكير + تعافٍ');
    assert.equal(count(`select count(*) from private.uptime_incidents`), 1);
  });

  test('تأرجح الموقع (recovered يكسب KV ثم يسقط الموقع ثانية) ⇒ انقطاع واحد مستمر بلا تعافٍ كاذب، ثم تعافٍ واحد', async () => {
    reset(); setNotify(true);
    const h = raceHarness();
    await toRecovering(h);
    await Promise.all([h.run(4, true, { putDelay: 400 }), h.run(4, false, { rpcDelay: 120 })]);
    assert.equal(h.state().targets.site.status, 'UP');
    await h.run(5, false); await h.run(6, false);                          // SUSPECT: لا قرار
    assert.equal(recovered(), 0);
    assert.equal(one(`select recover_at is not null from private.uptime_incidents`), 't');
    await h.run(7, false);                                                 // DOWN بمعرّف جديد ⇒ اسم بديل يلغي التعافي
    assert.equal(h.state().targets.site.status, 'DOWN');
    assert.equal(count(`select count(*) from private.uptime_incidents`), 1, 'لا حادثة ثانية');
    assert.equal(one(`select recover_at is null and array_length(aliases, 1) = 1 from private.uptime_incidents`), 't');
    for (let i = 8; i <= 11; i++) await h.run(i, i % 2 === 0);             // تأرجح أثناء الانقطاع: RECOVERING/DOWN
    assert.equal(outbox(), 1, 'لا تنبيه انقطاع ثانٍ ولا تعافٍ');
    await h.run(12, true); await h.run(13, true); await h.run(14, true);
    assert.equal(recovered(), 0, 'التعافي معلّق');
    await h.run(15, true);
    assert.equal(recovered(), 1);
    assert.equal(openCount(), 0);
  });

  // ── دورة تأكيد التعافي (ملاحظة Codex P1 على 600878e) ──
  // ترتيبات الوصول إلى Supabase × الكتابة في KV لزوج تشغيلات واحد
  const PAIR_ORDERS = [
    { name: 'الأول يصل أولاً ويكسب KV', a: { putDelay: 400 }, b: { rpcDelay: 120 } },
    { name: 'الأول يصل أولاً والثاني يكسب KV', a: { putDelay: 250 }, b: { rpcDelay: 120, putDelay: 400 } },
    { name: 'الثاني يصل أولاً والأول يكسب KV', a: { rpcDelay: 120, putDelay: 400 }, b: {} },
    { name: 'الثاني يصل أولاً ويكسب KV', a: { rpcDelay: 120 }, b: { putDelay: 400 } },
  ];
  const siteStatus = (h) => h.state().targets.site.status;
  // الانقطاع الحقيقي = حالة الـWorker الفائزة في KV. الثوابت المطلوبة:
  //  ١) ما دام الـWorker يحمل حادثة، فحادثتها على الخادم (بمعرّفها أو اسم بديل) مفتوحة ⇒ لا إغلاق ولا تعافٍ كاذب
  //     والتذكيرات تجد حادثة مفتوحة.
  //  ٢) رسالة تعافٍ واحدة على الأكثر لكل حادثة، ولا رسالة تعافٍ لحادثة مفتوحة.
  //  ٣) حادثة مفتوحة واحدة على الأكثر.
  const assertConsistent = (h, label, { corrected = 0 } = {}) => {
    const inc = h.state().targets.site.incident;
    if (inc) {
      const st = one(`select coalesce((select case when closed_at is null then 'open' else 'closed' end
        from private.uptime_incidents where incident_key = '${inc.id}' or '${inc.id}' = any (aliases)), 'missing')`);
      assert.equal(st, 'open', `${label}: الـWorker ما زال يحمل ${inc.id} ⇒ يجب أن تبقى حادثته مفتوحة`);
    }
    assert.equal(count(`select count(*) from (select dedupe_key from public.telegram_outbox where message like '✅%'
      group by 1 having count(*) > 1) d`), 0, `${label}: لا تكرار لرسالة التعافي`);
    // رسالة تعافٍ لحادثة أُعيد فتحها تُحسب فقط إن تبعها تصحيح (corrected)
    assert.ok(recovered() <= count(`select count(*) from private.uptime_incidents where closed_at is not null`) + corrected,
      `${label}: كل رسالة تعافٍ لحادثة مغلقة`);
    assert.ok(openCount() <= 1, `${label}: حادثة مفتوحة واحدة`);
  };

  test('دورة التأكيد بتشغيلين متزامنين، كل ترتيبات الوصول وKV، وكل الحالات (UP/SUSPECT/DOWN/RECOVERING) ⇒ متسقة مع الـWorker', async () => {
    // السباق الأول يحدد الحالة الفائزة (متعافٍ أو واقف)، ثم دورة التأكيد بتشغيلين اختلف فحصهما
    const firstRace = { recoveredWins: PAIR_ORDERS[0], downWins: PAIR_ORDERS[1] };
    for (const [winner, o1] of Object.entries(firstRace)) {
      for (const o2 of PAIR_ORDERS) {
        const label = `${winner} / ${o2.name}`;
        reset(); setNotify(true);
        const h = raceHarness();
        await toRecovering(h);
        await Promise.all([h.run(4, true, o1.a), h.run(4, false, o1.b)]);
        h.snap(4);
        const before = siteStatus(h);
        assert.equal(before, winner === 'recoveredWins' ? 'UP' : 'DOWN');
        await Promise.all([h.run(5, true, o2.a), h.run(5, false, o2.b)]);   // UP/SUSPECT أو RECOVERING/DOWN
        h.snap(5);
        assertConsistent(h, `${label} بعد دورة التأكيد`);
        for (let i = 6; i <= 22; i++) { await h.run(i, false); h.snap(i); assertConsistent(h, `${label} دورة ${i}`); }
        // الانقطاع مستمر: إما حادثته مفتوحة بتذكيرها، أو أُغلقت عن تعافٍ رآه الـWorker وانقطاع جديد نُبِّه عنه
        const reminders = count(`select count(*) from public.telegram_outbox where message like '⏳%'`);
        const downs = count(`select count(*) from public.telegram_outbox where message like '🔴%'`);
        if (recovered() === 0) {
          assert.equal(reminders, 1, `${label}: التذكير لم يتوقف`);
          assert.equal(count(`select count(*) from private.uptime_incidents`), 1, `${label}: حادثة واحدة`);
        } else {
          assert.equal(downs, 2, `${label}: بعد تعافٍ رآه الـWorker يُنبَّه الانقطاع الجديد (لا صمت)`);
        }
      }
    }
  });

  test('نبضة قديمة تصل بعد نبضة أحدث: UP القديم لا يرشّح ولا يؤكد، وDOWN القديم يعترض', () => {
    reset(); setNotify(true);
    const S = 1_900_000_000_000; const R = S + 20 * M;
    ingest({ events: [ev('site', S, 'down', S + 2 * M)], scheduledTime: S + 2 * M });
    ingest({ events: [ev('site', S, 'recovered', R)], scheduledTime: R, targets: { site: 'UP' } });
    ingest({ scheduledTime: R + 2 * M, targets: { site: 'SUSPECT' } });
    ingest({ scheduledTime: R + M, targets: { site: 'UP' } });            // متأخرة: أقدم من آخر مقبول
    assert.equal(openCount(), 1);
    assert.equal(recovered(), 0);
    assert.equal(one(`select confirm_tick is null from private.uptime_incidents`), 't', 'UP متأخر لا يرشّح');
    ingest({ scheduledTime: R + M + 1, targets: { site: 'DOWN' } });      // DOWN متأخر يعترض (آمن: يؤخر فقط)
    assert.equal(one(`select recover_at is null from private.uptime_incidents`), 't');
    assert.equal(openCount(), 1);
  });

  test('قراءة KV متأخرة أكثر من 5 دقائق بلا تشغيل مكرر ⇒ الكاتب القديم يصبح الحقيقة ولا تناقض', async () => {
    reset(); setNotify(true);
    const h = raceHarness();
    await toRecovering(h);
    await h.run(4, false); h.snap(4);                                       // DOWN
    await h.run(5, true, { readStale: 3 }); h.snap(5);                      // يقرأ حالة دورة 3 (RECOVERING) ⇒ recovered
    assertConsistent(h, 'بعد القراءة القديمة');
    for (let i = 6; i <= 8; i++) { await h.run(i, false); h.snap(i); assertConsistent(h, `دورة ${i}`); }
  });

  test('سباق ثانٍ مع قراءة KV متأخرة أكثر من 5 دقائق يخسر كتابتها ⇒ اعتراض الشقيق يمنع الإغلاق', async () => {
    reset(); setNotify(true);
    const h = raceHarness();
    await toRecovering(h);
    await Promise.all([h.run(4, true, { putDelay: 250 }), h.run(4, false, { rpcDelay: 120, putDelay: 400 })]); // DOWN يكسب
    h.snap(4);
    assert.equal(siteStatus(h), 'DOWN');
    // دورة 5 مكررة: تشغيل يقرأ قيمة دورة 3 القديمة (> 5 دقائق) وفحصه ناجح، يصل أولاً ويخسر KV
    await Promise.all([h.run(5, true, { readStale: 3, putDelay: 250 }), h.run(5, false, { rpcDelay: 120, putDelay: 400 })]);
    h.snap(5);
    for (let i = 6; i <= 16; i++) { await h.run(i, false); h.snap(i); }
    assertConsistent(h, 'سباق مزدوج مع قراءة قديمة');
  });

  // ── اعتراض الشقيق: UP وDOWN لنفس الدقيقة بكل الترتيبات، في الدورة المرشّحة ودورة التأكيد ──
  const pendingIncident = () => {
    const S = 1_900_000_000_000; const R = S + 20 * M;
    ingest({ events: [ev('site', S, 'down', S + 2 * M)], scheduledTime: S + 2 * M, targets: { site: 'DOWN' } });
    ingest({ events: [ev('site', S, 'recovered', R)], scheduledTime: R, targets: { site: 'UP' } });
    return { S, R };
  };
  const signed = (opts) => { const p = body(opts); return () => psqlAsync(ingestAs('anon', p, sign(p))); };

  test('الدورة المرشّحة: UP وDOWN لنفس الدقيقة (متتاليان بالترتيبين، ومتزامنان) ⇒ الاعتراض يلغي دائماً', async () => {
    for (const mode of ['UP ثم DOWN', 'DOWN ثم UP', 'متزامنان']) {
      reset(); setNotify(true);
      const { R } = pendingIncident();
      const up = signed({ scheduledTime: R + M, targets: { site: 'UP' } });
      const down = signed({ scheduledTime: R + M, targets: { site: 'DOWN' } });
      if (mode === 'UP ثم DOWN') { await up(); await down(); }
      else if (mode === 'DOWN ثم UP') { await down(); await up(); }
      else await Promise.all([up(), down()]);
      assert.equal(one(`select recover_at is null and confirm_tick is null from private.uptime_incidents`), 't', `${mode}: أُلغي`);
      ingest({ scheduledTime: R + 2 * M, targets: { site: 'UP' } });       // لا تأكيد من دورة بلا مرشّحة
      assert.equal(openCount(), 1, `${mode}: ما زالت مفتوحة`);
      assert.equal(recovered(), 0, `${mode}: لا تعافٍ`);
    }
  });

  test('دورة التأكيد: UP يؤكد ثم يصل DOWN لنفس الدقيقة ⇒ إعادة فتح برسالة تصحيح، والتذكيرات تستمر', async () => {
    for (const mode of ['UP ثم DOWN', 'DOWN ثم UP', 'متزامنان']) {
      reset(); setNotify(true);
      const { S, R } = pendingIncident();
      ingest({ scheduledTime: R + M, targets: { site: 'UP' } });          // مرشّحة
      const up = signed({ scheduledTime: R + 2 * M, targets: { site: 'UP' } });
      const down = signed({ scheduledTime: R + 2 * M, targets: { site: 'DOWN' } });
      if (mode === 'UP ثم DOWN') { await up(); assert.equal(recovered(), 1); await down(); }
      else if (mode === 'DOWN ثم UP') { await down(); await up(); }
      else await Promise.all([up(), down()]);
      assert.equal(openCount(), 1, `${mode}: الحادثة مفتوحة في النهاية`);
      const fixes = count(`select count(*) from public.telegram_outbox where message like '⚠️ تصحيح%'`);
      if (mode === 'DOWN ثم UP') assert.equal(recovered() + fixes, 0, `${mode}: الاعتراض سبق ⇒ لا تعافٍ ولا تصحيح`);
      else assert.equal(recovered(), fixes, `${mode}: كل تعافٍ أُرسل يتبعه تصحيح`);
      const r = ingest({ events: [ev('site', S, 'reminder:1h', S + 62 * M)], scheduledTime: S + 62 * M, targets: { site: 'DOWN' } });
      assert.equal(r.results[0].outcome, 'notified', `${mode}: التذكير لم يُكتم`);
      assert.equal(count(`select count(*) from private.uptime_incidents`), 1, `${mode}: حادثة واحدة`);
      // التعافي الحقيقي لاحقاً: رسالة واحدة بمفتاح جديد (لا يتصادم مع الأولى)
      ingest({ scheduledTime: S + 70 * M, targets: { site: 'UP' } });
      ingest({ scheduledTime: S + 71 * M, targets: { site: 'UP' } });
      ingest({ scheduledTime: S + 72 * M, targets: { site: 'UP' } });
      assert.equal(openCount(), 0, `${mode}: أُغلقت بعد التعافي الحقيقي`);
      assert.equal(count(`select count(*) from public.telegram_outbox where message like '✅%'`), (mode === 'DOWN ثم UP' ? 0 : 1) + 1);
    }
  });

  test('القيد المتبقي: شقيق فشل طلبه وكسب KV + قراءة متأخرة في دورة التأكيد ⇒ تعافٍ كاذب يتبعه تصحيح ولا صمت', async () => {
    reset(); setNotify(true);
    const h = raceHarness();
    await toRecovering(h);
    await Promise.all([h.run(4, true, { putDelay: 250 }), h.run(4, false, { rpcDelay: 120, putDelay: 400 })]); // DOWN يكسب
    h.snap(4);
    // دورة 5: تشغيل قديم القراءة (دورة 3) يقول UP ويصل؛ شقيقه الحديث DOWN فشل طلبه وكسب KV ⇒ مرشّحة بلا اعتراض
    await Promise.allSettled([h.run(5, true, { readStale: 3, putDelay: 250 }), h.run(5, false, { rpcFail: true, putDelay: 400 })]);
    h.snap(5);
    assert.equal(h.state().targets.site.status, 'DOWN');
    // دورة 6: قراءة قديمة ثانية (> 10 دقائق) تقول UP وتصل أولاً ⇒ تأكيد كاذب؛ الشقيق الحديث DOWN يصل بعده
    await Promise.all([h.run(6, true, { readStale: 3, putDelay: 250 }), h.run(6, false, { rpcDelay: 120, putDelay: 400 })]);
    h.snap(6);
    assert.equal(recovered(), 1, 'القيد: رسالة تعافٍ كاذبة ممكنة بثلاثة شذوذات معاً');
    assert.equal(count(`select count(*) from public.telegram_outbox where message like '⚠️ تصحيح%'`), 1, 'يتبعها تصحيح فوراً');
    for (let i = 7; i <= 16; i++) { await h.run(i, false); h.snap(i); assertConsistent(h, `دورة ${i}`, { corrected: 1 }); }
    assert.equal(count(`select count(*) from public.telegram_outbox where message like '⏳%'`), 1, 'التذكير لم يتوقف');
    assert.equal(count(`select count(*) from private.uptime_incidents`), 1);
  });

  test('التراجع: يزيل كل كائنات 14 ولا يمسّ telegram_outbox، ويرفض إن كان المراقب مجدولاً', () => {
    const rowsBefore = count(`select count(*) from public.telegram_outbox`);
    psql(`create schema cron; create table cron.job(jobid serial, jobname text, command text);
          insert into cron.job(jobname, command) values ('uptime-heartbeat-watch', 'select public.watch_uptime_heartbeat()');`);
    rejects(() => psql(ROLLBACK), /unschedule the uptime watchdog/);
    psql(`delete from cron.job`);
    psql(ROLLBACK);
    assert.equal(count(`select count(*) from pg_proc where proname in ('uptime_ingest','watch_uptime_heartbeat','uptime_enqueue','uptime_message','uptime_cancel_recovery','uptime_close_key')`), 0);
    assert.equal(count(`select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname like 'uptime_%'`), 0);
    assert.equal(count(`select count(*) from public.telegram_outbox`), rowsBefore);
    assert.equal(one(`select md5(prosrc) from pg_proc where proname = 'notify_telegram_dispatch'`), '60bbae6f1fed8ba5e66c9a9a91daed40', 'dispatch لم تُمس');
    psql(MIGRATION); // إعادة التطبيق بعد التراجع
    assert.equal(count(`select count(*) from pg_proc where proname = 'uptime_ingest'`), 1);
  });
}
