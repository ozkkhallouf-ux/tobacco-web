// ozk-uptime — مراقبة الموقع كل 5 دقائق. المرحلة 1: DRY_RUN فقط، بلا أسرار ولا Telegram ولا service_role.
import { step, emptyState, EVENTS_KEEP } from './state-machine.mjs';

export const SITE_URL = 'https://ozktobacco.com/';
export const BULLETIN_URL = 'https://ozktobacco.com/public/downloads/price-list-usd.html';
const STATE_KEY = 'state:v1';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;

// DRY_RUN مفعّل ما لم يُضبط صراحةً على "0"
export const isDryRun = (env) => String(env?.DRY_RUN ?? '1') !== '0';

export async function probe(fetchImpl, url, { marker, now, timeoutMs = TIMEOUT_MS }) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  try {
    const res = await fetchImpl(`${url}?_=${now}`, {
      signal: ac.signal, redirect: 'follow',
      headers: { 'user-agent': 'ozk-uptime/1', 'cache-control': 'no-cache' },
      cf: { cacheTtl: 0 },
    });
    if (res.status !== 200) return { ok: false, detail: `http-${res.status}`, ms: ms() };
    if (!marker) { try { await res.body?.cancel(); } catch {} return { ok: true, detail: 'http-200', ms: ms() }; }
    const text = (await res.text()).slice(0, MAX_BODY);
    return text.includes(marker) ? { ok: true, detail: 'http-200', ms: ms() } : { ok: false, detail: 'marker-missing', ms: ms() };
  } catch (e) {
    // فشل الاتصال فشلٌ دائماً (ok:false) مع سبب صريح؛ لا يُفسَّر نجاحاً ولا يُبتلع
    return { ok: false, detail: timedOut ? 'timeout' : `network-error:${String(e?.name || 'Error').slice(0, 40)}`, ms: ms() };
  } finally { clearTimeout(timer); }
}

// قراءة الحالة: مفقود/تالف ⇒ حالة جديدة (فقدان حالة)، أما فشل القراءة نفسه فيُرمى كي لا نكتب فوق حالة سليمة.
async function loadState(kv, log) {
  if (!kv) return { state: emptyState(), lost: false };
  const raw = await kv.get(STATE_KEY); // الرمي هنا = تخطي التشغيل بلا كتابة
  if (raw == null) return { state: emptyState(), lost: true };
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (s && s.v === 1 && s.targets && Array.isArray(s.events)) return { state: s, lost: false };
  } catch {}
  log(JSON.stringify({ t: 'ozk-uptime', warn: 'state-corrupt-reset' }));
  return { state: emptyState(), lost: true };
}

async function saveState(kv, state, log) {
  const body = JSON.stringify(state);
  let err;
  for (let i = 1; i <= 3; i++) {
    try { await kv.put(STATE_KEY, body); return true; } catch (e) { err = e; }
  }
  log(JSON.stringify({ t: 'ozk-uptime', error: 'storage-write-failed', attempts: 3, msg: String(err?.message || err).slice(0, 80) }));
  return false;
}

export async function runOnce({ env = {}, now, fetchImpl = fetch, kv = env.UPTIME_STATE, log = console.log }) {
  const dry = isDryRun(env);
  const [site, bulletin] = await Promise.all([
    probe(fetchImpl, SITE_URL, { marker: 'OZK TOBACCO', now }),
    probe(fetchImpl, BULLETIN_URL, { marker: null, now }),
  ]);
  let loaded;
  try { loaded = await loadState(kv, log); } catch (e) {
    // لا نعرف الحالة ⇒ لا نحكم ولا نكتب (لا فقدان حادثة ولا حادثة مكررة)؛ الفشل يظهر في سجلات Cloudflare
    log(JSON.stringify({ t: 'ozk-uptime', error: 'storage-read-failed', msg: String(e?.message || e).slice(0, 80) }));
    throw new Error('ozk-uptime: storage read failed');
  }
  const out = step(loaded.state, now, { site, bulletin });
  if (out.ignored) { log(JSON.stringify({ t: 'ozk-uptime', ignored: true, now })); return out; }
  // المرحلة 1: لا مرسِل في الكود إطلاقاً؛ الأحداث تُسجَّل فقط. (لا Telegram/Supabase ولا أي fetch غير الفحصين)
  // التسليم قبل الحفظ: إن فشل الحفظ يُعاد توليد نفس المعرّفات الحتمية في التشغيل التالي (at-least-once، والمستلم يزيل التكرار بالمعرّف)
  const delivered = out.events.map((e) => ({ ...e, status: dry ? 'delivered' : 'pending', dryRun: dry }));
  out.state.events = [...out.state.events, ...delivered].slice(-EVENTS_KEEP);
  for (const e of delivered) log(JSON.stringify({ t: 'ozk-uptime-event', ...e }));
  let saved = true;
  if (kv) saved = await saveState(kv, out.state, log);
  log(JSON.stringify({ t: 'ozk-uptime', dry, stateLost: loaded.lost, saved,
    site: { ok: site.ok, detail: site.detail, ms: site.ms }, bulletin: { ok: bulletin.ok, detail: bulletin.detail, ms: bulletin.ms },
    status: out.state.targets.site?.status }));
  if (!saved) throw new Error('ozk-uptime: storage write failed');
  return { ...out, events: delivered };
}

export const handler = {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runOnce({ env, now: controller.scheduledTime }));
  },
  async fetch() { return new Response('not found', { status: 404 }); },
};
