import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOnce, probe } from '../src/core.mjs';

const M = 5 * 60_000, T0 = 1_800_000_000_000;
const logs = []; const log = (l) => logs.push(l);
const ok = async (u) => new Response(String(u).includes('price') ? 'x' : 'OZK TOBACCO', { status: 200 });
const down = async () => { throw new TypeError('fetch failed'); };
const mem = (init = null) => { let v = init; const o = { puts: 0, get: async () => v, put: async (_, s) => { o.puts++; v = s; }, peek: () => v }; return o; };

test('فشل الاتصال يُسجَّل ok:false بسبب صريح ولا يُعدّ نجاحاً', async () => {
  const r = await probe(down, 'https://ozktobacco.com/', { marker: 'OZK TOBACCO', now: 1 });
  assert.equal(r.ok, false); assert.equal(r.detail, 'network-error:TypeError');
  logs.length = 0; const kv = mem();
  const o = await runOnce({ env: {}, now: T0, fetchImpl: down, kv, log });
  assert.equal(o.state.targets.site.status, 'SUSPECT');
  assert.ok(logs.some((l) => l.includes('"ok":false') && l.includes('network-error')));
});
test('مهلة حقيقية: fetch معلّق يُجهَض ويُسجَّل timeout', async () => {
  const hang = (_, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  const r = await probe(hang, 'https://a/', { marker: null, now: 1, timeoutMs: 20 });
  assert.deepEqual([r.ok, r.detail], [false, 'timeout']);
});
test('فشل الاتصال المتكرر يؤكد down مرة واحدة (لا نجاح كاذب)', async () => {
  const kv = mem(); const ev = [];
  for (let i = 0; i < 6; i++) ev.push(...(await runOnce({ env: {}, now: T0 + i * M, fetchImpl: down, kv, log })).events);
  assert.deepEqual(ev.filter((e) => e.target === 'site').map((e) => e.type), ['down']);
});
test('فشل الحفظ: 3 محاولات ثم خطأ ظاهر، والتشغيل التالي يعيد نفس معرّف الحدث', async () => {
  const kv = mem(); await runOnce({ env: {}, now: T0, fetchImpl: down, kv, log }); await runOnce({ env: {}, now: T0 + M, fetchImpl: down, kv, log });
  const failing = { get: kv.get, put: async () => { throw new Error('kv 503'); }, n: 0 };
  let n = 0; failing.put = async () => { n++; throw new Error('kv 503'); };
  await assert.rejects(runOnce({ env: {}, now: T0 + 2 * M, fetchImpl: down, kv: failing, log }), /storage write failed/);
  assert.equal(n, 3);
  const a = await runOnce({ env: {}, now: T0 + 2 * M + 1000, fetchImpl: down, kv, log }); // الحفظ لم يحدث ⇒ يعاد توليد الحدث
  const sa = a.events.filter((e) => e.target === 'site');
  assert.equal(sa[0].id.endsWith(':down'), true);
  assert.equal(sa[0].incident, (await runOnce({ env: {}, now: T0 + 3 * M, fetchImpl: down, kv, log })).state.targets.site.incident.id, 'نفس الحادثة');
});
test('فشل قراءة الحالة: لا حكم ولا كتابة فوق الحالة السليمة', async () => {
  const kv = mem(); await runOnce({ env: {}, now: T0, fetchImpl: down, kv, log });
  const before = kv.peek(); let puts = 0;
  const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { puts++; } };
  await assert.rejects(runOnce({ env: {}, now: T0 + M, fetchImpl: down, kv: broken, log }), /storage read failed/);
  assert.equal(puts, 0); assert.equal(kv.peek(), before);
});
test('فقدان الحالة أثناء عطل: حادثة جديدة واحدة فقط، وحالة تالفة تُعاد تهيئتها', async () => {
  const kv = mem(); for (let i = 0; i < 4; i++) await runOnce({ env: {}, now: T0 + i * M, fetchImpl: down, kv, log });
  const kv2 = mem(); const ev = [];
  for (let i = 4; i < 10; i++) ev.push(...(await runOnce({ env: {}, now: T0 + i * M, fetchImpl: down, kv: kv2, log })).events);
  assert.equal(ev.filter((e) => e.type === 'down' && e.target === 'site').length, 1);
  const bad = mem('{not json'); const o = await runOnce({ env: {}, now: T0, fetchImpl: ok, kv: bad, log });
  assert.equal(o.state.targets.site.status, 'UP');
});
test('تشغيلان متداخلان يقرآن حالة قديمة: نفس معرّف الحدث (يُزال تكراره عند المستلم)', async () => {
  const seed = mem(); for (let i = 0; i < 2; i++) await runOnce({ env: {}, now: T0 + i * M, fetchImpl: down, kv: seed, log });
  const snap = seed.peek();
  const slow = () => ({ get: async () => { await new Promise((r) => setTimeout(r, 5)); return snap; }, put: async () => {} });
  const [a, b] = await Promise.all([
    runOnce({ env: {}, now: T0 + 2 * M, fetchImpl: down, kv: slow(), log }),
    runOnce({ env: {}, now: T0 + 3 * M, fetchImpl: down, kv: slow(), log }),
  ]);
  const ids = new Set([...a.events, ...b.events].filter((e) => e.target === 'site').map((e) => e.id));
  assert.equal(ids.size, 1, 'معرّف واحد مهما تداخلت التشغيلات');
});
test('DRY_RUN وغير DRY_RUN: لا اتصال إلا بفحصي ozktobacco.com حتى مع وجود أسرار وهمية وعطل', async () => {
  for (const env of [{}, { DRY_RUN: '1' }, { DRY_RUN: '0' }]) {
    const calls = [];
    const f = async (u) => { calls.push(String(u)); throw new TypeError('x'); };
    const fakeEnv = { ...env, TELEGRAM_BOT_TOKEN: 't', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' };
    const kv = mem(); let evs = [];
    for (let i = 0; i < 4; i++) evs.push(...(await runOnce({ env: fakeEnv, now: T0 + i * M, fetchImpl: f, kv, log })).events);
    assert.ok(evs.length >= 1);
    assert.ok(calls.every((u) => u.startsWith('https://ozktobacco.com/')), JSON.stringify(calls));
    assert.ok(evs.every((e) => (env.DRY_RUN === '0') ? e.status === 'pending' && !e.dryRun : e.status === 'delivered' && e.dryRun));
  }
});
test('ثابت ساكن: الشيفرة لا تحوي أي مرسِل (Telegram/Supabase/sendMessage/service_role)', () => {
  for (const f of ['../src/core.mjs', '../src/index.mjs', '../src/state-machine.mjs']) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /telegram|supabase|sendMessage|service_role|notify_telegram/i, f);
  }
});
