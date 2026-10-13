import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, isDryRun, probe } from '../src/core.mjs';
import worker from '../src/index.mjs';

const M = 5 * 60_000, T0 = 1_800_000_000_000;
const quiet = () => {};
function fakeKV({ stale = false } = {}) {
  let v = null, snap = null; const puts = [];
  return { puts,
    async get() { return JSON.parse(stale && snap ? snap : (v ?? 'null')); },
    async put(_, s) { puts.push(s); snap = snap ?? s; v = s; } };
}
function fakeFetch(mode, calls = []) {
  return async (url) => {
    calls.push(String(url));
    if (mode.throws) throw Object.assign(new Error('x'), { name: mode.throws });
    const bulletin = String(url).includes('price-list');
    if (mode.status && !bulletin) return new Response('', { status: mode.status });
    return new Response(bulletin ? 'x' : '<title>OZK TOBACCO</title>', { status: 200 });
  };
}

test('DRY_RUN مفعّل افتراضياً', () => {
  assert.equal(isDryRun({}), true); assert.equal(isDryRun({ DRY_RUN: '1' }), true);
  assert.equal(isDryRun({ DRY_RUN: '0' }), false);
});
test('probe: 200+marker نجاح، 503 فشل، غياب marker فشل، مهلة فشل', async () => {
  assert.equal((await probe(fakeFetch({}), 'https://a/', { marker: 'OZK TOBACCO', now: 1 })).ok, true);
  assert.equal((await probe(fakeFetch({ status: 503 }), 'https://a/', { marker: 'OZK TOBACCO', now: 1 })).detail, 'http-503');
  assert.equal((await probe(async () => new Response('hi'), 'https://a/', { marker: 'OZK TOBACCO', now: 1 })).detail, 'marker-missing');
  assert.equal((await probe(fakeFetch({ throws: 'TypeError' }), 'https://a/', { marker: null, now: 1 })).detail, 'network-error:TypeError');
});
test('دورة كاملة: عطل ثم تعافٍ، حدثان فقط، لا طلبات إلا إلى ozktobacco.com، كتابة واحدة لكل تشغيل', async () => {
  const kv = fakeKV(), calls = [], env = {};
  const modes = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, {}, {}];
  const evs = [];
  for (let i = 0; i < modes.length; i++) {
    const o = await runOnce({ env, now: T0 + i * M, fetchImpl: fakeFetch(modes[i], calls), kv, log: quiet });
    evs.push(...o.events);
  }
  assert.deepEqual(evs.map((e) => e.type), ['down', 'recovered']);
  assert.ok(evs.every((e) => e.dryRun && e.status === 'delivered'));
  assert.ok(calls.every((u) => u.startsWith('https://ozktobacco.com/')), 'لا اتصال بأي جهة أخرى (لا Telegram/Supabase)');
  assert.equal(kv.puts.length, modes.length);
});
test('إطلاق مزدوج لنفس الموعد لا يكرر الحدث حتى مع قراءة KV قديمة', async () => {
  const kv = fakeKV({ stale: false });
  const f = fakeFetch({ status: 500 });
  for (let i = 0; i < 2; i++) await runOnce({ env: {}, now: T0 + i * M, fetchImpl: f, kv, log: quiet });
  const a = await runOnce({ env: {}, now: T0 + 2 * M, fetchImpl: f, kv, log: quiet });
  const b = await runOnce({ env: {}, now: T0 + 2 * M, fetchImpl: f, kv, log: quiet });
  assert.equal(a.events.length, 1); assert.equal(b.ignored, true);
});
test('بلا KV يعمل في الذاكرة دون استثناء', async () => {
  const o = await runOnce({ env: {}, now: T0, fetchImpl: fakeFetch({}), log: quiet });
  assert.equal(o.state.targets.site.status, 'UP');
});
test('scheduled يستخدم scheduledTime و fetch يرجع 404', async () => {
  let p; const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try { await worker.scheduled({ scheduledTime: T0 }, {}, { waitUntil: (x) => (p = x) }); await p; } finally { globalThis.fetch = orig; }
  assert.equal((await worker.fetch()).status, 404);
});
