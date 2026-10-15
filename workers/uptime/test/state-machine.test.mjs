import test from 'node:test';
import assert from 'node:assert/strict';
import { step, emptyState } from '../src/state-machine.mjs';

const M = 5 * 60_000, T0 = 1_800_000_000_000;
const OK = { site: { ok: true }, bulletin: { ok: true } };
const BAD = { site: { ok: false, detail: 'timeout' }, bulletin: { ok: true } };
function run(seq, start = emptyState()) {
  let s = start, all = [];
  seq.forEach((r, i) => { const o = step(s, T0 + i * M, r); s = o.state; all.push(...o.events); });
  return { s, all };
}

test('فشل واحد أو اثنان لا ينتجان تنبيهاً', () => {
  assert.equal(run([OK, BAD, OK, OK]).all.length, 0);
  assert.equal(run([BAD, BAD, OK, OK]).all.length, 0);
});
test('3 إخفاقات ⇒ down واحد فقط مهما طال العطل', () => {
  const { all, s } = run([BAD, BAD, BAD, BAD, BAD, BAD]);
  assert.deepEqual(all.map((e) => e.type), ['down']);
  assert.equal(all[0].alertable, true);
  assert.equal(s.targets.site.status, 'DOWN');
});
test('تعافٍ يحتاج نجاحين متتاليين ويصدر recovered واحداً', () => {
  const { all } = run([BAD, BAD, BAD, OK, BAD, OK, OK, OK]);
  assert.deepEqual(all.map((e) => e.type), ['down', 'recovered']);
  assert.equal(all[0].incident, all[1].incident, 'نفس الحادثة رغم الاهتزاز');
});
test('تذكيرات 1h/6h/24h مرة واحدة لكل عتبة', () => {
  const seq = Array(3 + 24 * 12 + 2).fill(BAD);
  const types = run(seq).all.map((e) => e.id.split(':').slice(-2).join(':'));
  assert.equal(types.filter((x) => x.startsWith('reminder')).length, 3);
});
test('تشغيل مكرر أو قديم يُتجاهل', () => {
  let s = run([BAD, BAD]).s;
  const dup = step(s, s.lastRunAt, BAD);
  assert.equal(dup.ignored, true);
  assert.equal(step(s, s.lastRunAt - M, BAD).ignored, true);
  const o = step(s, s.lastRunAt + M, BAD); s = o.state;
  assert.equal(o.events.length, 1);
});
test('إعادة تشغيل نفس الخطوة من حالة قديمة لا تُكرّر الحدث (معرّف حتمي)', () => {
  const pre = run([BAD, BAD]).s;
  const a = step(pre, T0 + 2 * M, BAD);
  {
    const stale = structuredClone(a.state); stale.events = a.events; // الحدث سُجّل
    stale.lastRunAt = T0 + M; // قراءة قديمة لـ lastRunAt فقط
    assert.equal(step(stale, T0 + 2 * M, BAD).events.length, 0);
  }
});
test('النشرة المتعطلة سجلّ فقط (غير قابلة للتنبيه)', () => {
  const b = { site: { ok: true }, bulletin: { ok: false } };
  const { all } = run([b, b, b]);
  assert.equal(all[0].alertable, false);
  assert.equal(all[0].severity, 'medium');
});
test('فجوة طويلة بين التشغيلات لا تُنشئ حدثاً بذاتها', () => {
  const s = run([OK]).s;
  assert.equal(step(s, T0 + 3 * 3_600_000, OK).events.length, 0);
});

test('upTicks: دورات UP بعد التعافي تُعدّ مرة واحدة لكل دورة، ويحملها down التالي', () => {
  const ups = (n) => Array(n).fill(OK);
  // recovered عند ثاني نجاح؛ بعده n دورات UP ثم انقطاع جديد
  for (const n of [0, 1, 2, 3]) {
    const { all } = run([BAD, BAD, BAD, OK, OK, ...ups(n), BAD, BAD, BAD]);
    const downs = all.filter((e) => e.type === 'down');
    assert.equal(downs.length, 2, `n=${n}`);
    assert.equal(downs[0].upTicks, 0);
    assert.equal(downs[1].upTicks, n, `n=${n}: دورات UP بين التعافي والانقطاع الجديد`);
    assert.notEqual(downs[0].incident, downs[1].incident);
  }
  // SUSPECT عاد UP يُعدّ دورة UP؛ الإخفاق لا يُعدّ
  const blip = run([BAD, BAD, BAD, OK, OK, OK, BAD, OK, BAD, BAD, BAD]).all.filter((e) => e.type === 'down');
  assert.equal(blip[1].upTicks, 2);
});
test('upTicks: تشغيل مكرر لنفس الموعد أو أقدم لا يزيد العدّ', () => {
  let s = emptyState();
  const at = (i, r) => { const o = step(s, T0 + i * M, r); if (!o.ignored) s = o.state; return o; };
  [BAD, BAD, BAD, OK, OK].forEach((r, i) => at(i, r));       // تعافٍ عند الدورة 4
  at(5, OK);
  assert.equal(at(5, OK).ignored, true, 'تكرار Cron');
  assert.equal(at(3, OK).ignored, true, 'نبضة أقدم');
  assert.equal(s.targets.site.upTicks, 1);
  at(7, OK);                                                     // تأخر Cron: دورة فعلية واحدة
  assert.equal(s.targets.site.upTicks, 2);
});
