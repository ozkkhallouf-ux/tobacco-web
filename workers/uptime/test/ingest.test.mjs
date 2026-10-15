// الإرسال إلى Supabase (DRY_RUN="0"): الإقرار، المعلّق، إعادة المحاولة، والتوقيع. الشبكة والخادم محاكاة بالكامل.
// الخادم الوهمي يطبّق عقد public.uptime_ingest (supabase/proposed/14): توقيع HMAC على النص الحرفي، nonce لمرة واحدة،
// event_id فريد. السلوك الحقيقي لقاعدة البيانات مختبَر في supabase/tests/uptime-ingest.sim.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { runOnce, PENDING_MAX, INGEST_BATCH_MAX, capPending, mergePending } from '../src/core.mjs';
import { hmacHex, ingestConfig, buildRequest, sendBatch } from '../src/ingest.mjs';
import { EVENTS_KEEP } from '../src/state-machine.mjs';

const M = 5 * 60_000, T0 = 1_800_000_000_000;
const SECRET = 'unit-test-secret-'.padEnd(40, 'z');
const ENV = { DRY_RUN: '0', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', UPTIME_HMAC_SECRET: SECRET };
const RPC = 'https://abc.supabase.co/rest/v1/rpc/uptime_ingest';
const quiet = () => {};
const memKV = () => { let v = null; const o = { puts: 0, fail: false, get: async () => v, put: async (_, s) => { if (o.fail) throw new Error('kv 503'); o.puts++; v = s; }, state: () => JSON.parse(v) }; return o; };

// خادم وهمي بعقد uptime_ingest. mode: ok | http500 | network | hang | bad | partial
function fakeServer() {
  const s = { mode: 'ok', ledger: new Map(), nonces: new Set(), requests: [], notified: [], rejected: 0, siteMode: 'down' };
  s.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://ozktobacco.com/')) {
      const bulletin = u.includes('price-list');
      if (s.siteMode === 'up' || bulletin) return new Response(bulletin ? 'x' : 'OZK TOBACCO', { status: 200 });
      return new Response('', { status: 503 });
    }
    assert.equal(u, RPC, 'نقطة واحدة فقط');
    s.requests.push(init);
    if (s.mode === 'network') throw new TypeError('fetch failed');
    if (s.mode === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
    if (s.mode === 'http500') return new Response('{"message":"db down"}', { status: 500 });
    const { p_payload, p_signature } = JSON.parse(init.body);
    if (createHmac('sha256', SECRET).update(p_payload).digest('hex') !== p_signature) { s.rejected++; return new Response('{}', { status: 401 }); }
    const j = JSON.parse(p_payload);
    if (s.nonces.has(j.nonce)) { s.rejected++; return new Response('{}', { status: 401 }); }
    s.nonces.add(j.nonce);
    if (s.mode === 'bad') return new Response(JSON.stringify({ ok: false }), { status: 200 });
    const evs = s.mode === 'partial' ? j.events.slice(0, 1) : j.events;
    const results = evs.map((e) => {
      if (s.ledger.has(e.id)) return { id: e.id, outcome: 'duplicate' };
      s.ledger.set(e.id, e);
      if (e.target === 'site') s.notified.push(e.id);
      return { id: e.id, outcome: e.target === 'site' ? 'notified' : 'recorded' };
    });
    return new Response(JSON.stringify({ ok: true, results }), { status: 200 });
  };
  return s;
}
const go = (srv, kv, i, env = ENV) => runOnce({ env, now: T0 + i * M, fetchImpl: srv.fetch, kv, log: quiet });

test('HMAC: يطابق node:crypto حرفياً، ويُوقَّع النص المرسل نفسه', async () => {
  assert.equal(await hmacHex(SECRET, 'نص عربي {"a":1}'), createHmac('sha256', SECRET).update('نص عربي {"a":1}').digest('hex'));
  const cfg = ingestConfig(ENV);
  const { payload, signature } = await buildRequest(cfg, { events: [], scheduledTime: 5, now: 6, nonce: 'n'.repeat(20) });
  assert.equal(payload, '{"v":1,"ts":6,"nonce":"nnnnnnnnnnnnnnnnnnnn","scheduledTime":5,"events":[]}');
  assert.equal(signature, createHmac('sha256', SECRET).update(payload).digest('hex'));
});
test('nonce مختلف لكل طلب (لا يُرفض طلب سليم كـreplay)', async () => {
  const cfg = ingestConfig(ENV);
  const a = JSON.parse((await buildRequest(cfg, { events: [], scheduledTime: 1 })).payload).nonce;
  const b = JSON.parse((await buildRequest(cfg, { events: [], scheduledTime: 1 })).payload).nonce;
  assert.notEqual(a, b); assert.match(a, /^[A-Za-z0-9:_-]{16,100}$/);
});
test('ingestConfig: عنوان Supabase فقط، ومفتاح عام، وسرّ ≥ 32؛ وإلا لا إرسال', () => {
  assert.ok(ingestConfig(ENV));
  assert.equal(ingestConfig({ ...ENV, SUPABASE_URL: 'https://evil.example.com' }), null);
  assert.equal(ingestConfig({ ...ENV, SUPABASE_URL: 'http://abc.supabase.co' }), null);
  assert.equal(ingestConfig({ ...ENV, UPTIME_HMAC_SECRET: 'short' }), null);
  assert.equal(ingestConfig({ ...ENV, SUPABASE_PUBLISHABLE_KEY: '' }), null);
});
test('الطلب: المفتاح العام فقط في الترويسات، لا Authorization ولا حقول زائدة في الأحداث', async () => {
  const srv = fakeServer(); const kv = memKV();
  for (let i = 0; i < 3; i++) await go(srv, kv, i);
  const init = srv.requests.at(-1);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.apikey, 'sb_publishable_x');
  assert.equal(init.headers.authorization, undefined);
  const ev = JSON.parse(JSON.parse(init.body).p_payload).events[0];
  assert.deepEqual(Object.keys(ev).sort(), ['at', 'detail', 'id', 'incident', 'target', 'type']);
  assert.equal(ev.detail, 'http-503');
});
test('نبض حياة في كل تشغيل حتى بلا أحداث، وscheduledTime الحقيقي (تأخر Cron لا يغيّر شيئاً)', async () => {
  const srv = fakeServer(); srv.siteMode = 'up'; const kv = memKV();
  const late = [0, 1, 2.6, 5]; // تأخر Cron: 13 دقيقة بين تشغيلين
  for (const i of late) await go(srv, kv, i);
  assert.equal(srv.requests.length, 4);
  assert.deepEqual(srv.requests.map((r) => JSON.parse(JSON.parse(r.body).p_payload).scheduledTime), late.map((i) => T0 + i * M));
  assert.ok(srv.requests.every((r) => JSON.parse(JSON.parse(r.body).p_payload).events.length === 0));
});
test('تكرار Cron لنفس الموعد: التشغيل الثاني يُتجاهل بلا أي طلب', async () => {
  const srv = fakeServer(); const kv = memKV();
  await go(srv, kv, 0);
  const o = await go(srv, kv, 0);
  assert.equal(o.ignored, true);
  assert.equal(srv.requests.length, 1);
});
test('لا «مُسلَّم» قبل الإقرار: فشل Supabase (500) ⇒ الحدث معلّق ومحفوظ، وخطأ ظاهر بعد الحفظ', async () => {
  const srv = fakeServer(); const kv = memKV();
  await go(srv, kv, 0); await go(srv, kv, 1);
  srv.mode = 'http500';
  await assert.rejects(go(srv, kv, 2), /ingest failed \(http-500\)/);
  const st = kv.state();
  assert.equal(st.pending.length, 1); assert.equal(st.pending[0].status, 'pending');
  assert.ok(!st.events.some((e) => e.type === 'down'), 'لا شيء في السجل كمُسلَّم');
  assert.equal(srv.notified.length, 0);
});
test('انقطاع الشبكة ثم مهلة ثم رد غير صالح ثم عودة: نفس المعرّف يُرسل ويُقبل مرة واحدة', async () => {
  const srv = fakeServer(); const kv = memKV();
  await go(srv, kv, 0); await go(srv, kv, 1);
  srv.mode = 'network'; await assert.rejects(go(srv, kv, 2), /network-error:TypeError/);
  const id = kv.state().pending[0].id;
  srv.mode = 'bad'; await assert.rejects(go(srv, kv, 3), /bad-response/);
  srv.mode = 'ok'; const o = await go(srv, kv, 4);
  assert.equal(o.ingest.ok, true);
  assert.deepEqual(srv.notified, [id]);
  assert.equal(kv.state().pending.length, 0);
  assert.equal(kv.state().events.find((e) => e.id === id).status, 'accepted');
});
test('مهلة حقيقية لطلب Supabase المعلّق تُجهَض ويبقى الحدث معلّقاً', async () => {
  const srv = fakeServer(); srv.mode = 'hang';
  const r = await sendBatch(ingestConfig(ENV), { fetchImpl: srv.fetch, events: [], scheduledTime: 1, timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
});
test('إقرار جزئي: ما لم يُقرّ به الخادم يبقى معلّقاً ويُعاد', async () => {
  const srv = fakeServer(); const kv = memKV();
  srv.siteMode = 'down';
  // عطل الموقع والنشرة معاً ⇒ حدثان في دفعة واحدة
  const both = async (u, init) => (String(u).startsWith('https://ozktobacco.com/') ? new Response('', { status: 503 }) : srv.fetch(u, init));
  for (let i = 0; i < 2; i++) await runOnce({ env: ENV, now: T0 + i * M, fetchImpl: both, kv, log: quiet });
  srv.mode = 'partial';
  await runOnce({ env: ENV, now: T0 + 2 * M, fetchImpl: both, kv, log: quiet });
  assert.equal(kv.state().pending.length, 1);
  srv.mode = 'ok';
  await runOnce({ env: ENV, now: T0 + 3 * M, fetchImpl: both, kv, log: quiet });
  assert.equal(kv.state().pending.length, 0);
  assert.equal(srv.ledger.size, 2);
});
test('تكرار event_id: رد duplicate يُخرج الحدث من المعلّق ولا يُعاد إرساله', async () => {
  const srv = fakeServer(); const kv = memKV();
  await go(srv, kv, 0); await go(srv, kv, 1);
  const pre = { id: `site:${T0}:down` }; srv.ledger.set(pre.id, pre); // قُبل سابقاً (مثلاً قبل ضياع حالة KV)
  const o = await go(srv, kv, 2);
  assert.equal(o.events[0].status, 'duplicate');
  assert.equal(kv.state().pending.length, 0);
  assert.equal(srv.notified.length, 0);
});
test('فشل كتابة KV بعد قبول الخادم: التشغيل التالي يعيد نفس المعرّف ⇒ duplicate، لا تنبيه ثانٍ', async () => {
  const srv = fakeServer(); const kv = memKV();
  await go(srv, kv, 0); await go(srv, kv, 1);
  kv.fail = true; await assert.rejects(go(srv, kv, 2), /storage write failed/);
  kv.fail = false; const o = await go(srv, kv, 3);
  assert.equal(o.events.filter((e) => e.type === 'down').length, 1);
  assert.equal(o.events[0].status, 'duplicate');
  assert.equal(srv.notified.length, 1);
});
test('فشل KV وفشل Supabase معاً: لا ضياع، يُعاد توليد الحدث نفسه ويُقبل لاحقاً', async () => {
  const srv = fakeServer(); const kv = memKV();
  await go(srv, kv, 0); await go(srv, kv, 1);
  srv.mode = 'http500'; kv.fail = true;
  await assert.rejects(go(srv, kv, 2), /storage write failed/);
  srv.mode = 'ok'; kv.fail = false;
  await go(srv, kv, 3);
  assert.equal(srv.notified.length, 1);
  assert.equal(kv.state().pending.length, 0);
});
test('امتلاء سجل الأحداث: النشرة المتذبذبة تملأ السجل ولا تطرد حدث الموقع المعلّق', async () => {
  const srv = fakeServer(); const kv = memKV();
  let n = 0; srv.mode = 'http500';
  // الموقع متعطل باستمرار، والنشرة تتذبذب (3 فشل ثم 2 نجاح) فتولّد down/recovered كثيرة
  const f = async (u, init) => {
    const s = String(u);
    if (s.includes('price-list')) return new Response('x', { status: (n % 5) < 3 ? 503 : 200 });
    if (s.startsWith('https://ozktobacco.com/')) return new Response('', { status: 503 });
    return srv.fetch(u, init);
  };
  for (; n < 60; n++) { try { await runOnce({ env: ENV, now: T0 + n * M, fetchImpl: f, kv, log: quiet }); } catch {} }
  const st = kv.state();
  assert.ok(st.pending.length > EVENTS_KEEP, `المعلّق ${st.pending.length} أكبر من حد السجل`);
  assert.ok(st.pending.some((e) => e.target === 'site' && e.type === 'down'), 'حدث الموقع لم يُطرد');
  srv.mode = 'ok';
  await runOnce({ env: ENV, now: T0 + n * M, fetchImpl: f, kv, log: quiet });
  assert.equal(kv.state().pending.length, 0);
  assert.equal(srv.notified.filter((id) => id.endsWith(':down')).length, 1);
  assert.ok(kv.state().events.length <= EVENTS_KEEP);
});
test('حدّ المعلّق: عند التجاوز يُسقط الأقدم غير القابل للتنبيه أولاً مع سجل خطأ ظاهر', () => {
  const site = { id: 'site:1:down', alertable: true, at: 1 };
  const bulletins = Array.from({ length: PENDING_MAX + 5 }, (_, i) => ({ id: `bulletin:${i}:down`, alertable: false, at: 10 + i }));
  const logs = [];
  const kept = capPending([site, ...bulletins], (l) => logs.push(l));
  assert.equal(kept.length, PENDING_MAX);
  assert.ok(kept.includes(site), 'القابل للتنبيه يبقى ولو كان الأقدم');
  assert.ok(!kept.some((e) => e.id === 'bulletin:0:down'));
  assert.match(logs[0], /pending-overflow/);
});
test('mergePending: بلا تكرار بالمعرّف ومرتب زمنياً', () => {
  const r = mergePending([{ id: 'a', at: 3 }, { id: 'b', at: 1 }], [{ id: 'a', at: 9 }, { id: 'c', at: 2 }]);
  assert.deepEqual(r.map((e) => e.id), ['b', 'c', 'a']);
});
test('حالة KV أقدم (بلا pending) تُقرأ بأمان، والانتقال من DRY_RUN إلى الإرسال لا يعيد أحداث الظل', async () => {
  const srv = fakeServer(); const kv = memKV();
  for (let i = 0; i < 3; i++) await go(srv, kv, i, {});                 // DRY_RUN: down في الظل
  const st = kv.state(); delete st.pending; await kv.put('state:v1', JSON.stringify(st));
  await go(srv, kv, 3);
  assert.equal(srv.notified.length, 0, 'حدث الظل لا يتحول تنبيهاً متأخراً');
  assert.deepEqual(kv.state().pending, []);
});
test('معلّق أكبر من حدّ الطلب (50): يُرسل على دفعات بالترتيب الزمني ولا تُرفض الدفعة كلها', async () => {
  const srv = fakeServer(); srv.siteMode = 'up'; const kv = memKV();
  await go(srv, kv, 0);
  const st = kv.state();
  st.pending = Array.from({ length: 70 }, (_, i) => ({ id: `bulletin:${i}:down`, type: 'down', target: 'bulletin', incident: `bulletin:${i}`, at: i, alertable: false, detail: 'x' }));
  await kv.put('state:v1', JSON.stringify(st));
  await go(srv, kv, 1);
  const sent = JSON.parse(JSON.parse(srv.requests.at(-1).body).p_payload).events;
  assert.equal(sent.length, INGEST_BATCH_MAX);
  assert.equal(sent[0].id, 'bulletin:0:down');
  assert.equal(kv.state().pending.length, 70 - INGEST_BATCH_MAX);
  await go(srv, kv, 2);
  assert.equal(kv.state().pending.length, 0);
  assert.equal(srv.ledger.size, 70);
});
