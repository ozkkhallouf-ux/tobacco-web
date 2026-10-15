// ozk-uptime — مراقبة الموقع كل 5 دقائق. DRY_RUN افتراضياً: لا طلب إلا فحصي ozktobacco.com.
// DRY_RUN="0" مع إعداد كامل ⇒ الأحداث ونبض الحياة تُرسل موقَّعة إلى Supabase (ingest.mjs)؛ لا Telegram ولا service_role هنا.
import { step, emptyState, EVENTS_KEEP, TARGETS } from './state-machine.mjs';
import { ingestConfig, sendBatch } from './ingest.mjs';

export const SITE_URL = 'https://ozktobacco.com/';
export const BULLETIN_URL = 'https://ozktobacco.com/public/downloads/price-list-usd.html';
const STATE_KEY = 'state:v1';
const TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;
export const PENDING_MAX = 100; // حدّ أمان فقط (حدثان لكل انقطاع عادةً)؛ القابل للتنبيه لا يُسقط قبل غيره
export const INGEST_BATCH_MAX = 50; // = حدّ الخادم لكل طلب؛ الباقي يبقى معلّقاً للتشغيل التالي (لا رفض للدفعة كلها)

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
    if (s && s.v === 1 && s.targets && Array.isArray(s.events)) {
      if (!Array.isArray(s.pending)) s.pending = []; // حالة أقدم من قائمة المعلّق
      return { state: s, lost: false };
    }
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
  const st = out.state;
  let ingest = null;
  let events;
  if (dry) {
    // DRY_RUN: تسجيل فقط، بلا أي طلب. المعلّق (إن وُجد من وضع سابق) يبقى كما هو ولا يُسقط.
    // لكن حدث الحادثة الحية المعلّقة نفسها (تعافيها أو تذكيرها) يلحق بها في المعلّق، وإلا عاد الوضع الحي
    // فأرسل down قديماً بلا تعافيه وبقيت الحادثة مفتوحة على الخادم.
    const liveIncidents = new Set(st.pending.map((e) => e.incident));
    events = out.events.map((e) => (liveIncidents.has(e.incident)
      ? { ...e, status: 'pending', dryRun: false }
      : { ...e, status: 'dry-run', dryRun: true }));
    st.pending = capPending(mergePending(st.pending, events.filter((e) => !e.dryRun)), log);
    st.events = [...st.events, ...events.filter((e) => e.dryRun)].slice(-EVENTS_KEEP);
  } else {
    ({ events, ingest } = await deliverLive(st, out.events, { env, fetchImpl, now, log }));
  }
  for (const e of events) log(JSON.stringify({ t: 'ozk-uptime-event', ...e }));
  // الحفظ بعد الإرسال وفي كتابة واحدة: فشل الحفظ يُبقي الحالة القديمة فتتكرر الانتقالات بالمعرّفات نفسها
  // (الخادم يرجع duplicate)، ونجاحه يحفظ الانتقال والمعلّق معاً.
  let saved = true;
  if (kv) saved = await saveState(kv, st, log);
  log(JSON.stringify({ t: 'ozk-uptime', dry, stateLost: loaded.lost, saved, pending: st.pending.length,
    ingest: ingest && (ingest.ok ? 'ok' : ingest.reason),
    site: { ok: site.ok, detail: site.detail, ms: site.ms }, bulletin: { ok: bulletin.ok, detail: bulletin.detail, ms: bulletin.ms },
    status: st.targets.site?.status }));
  if (!saved) throw new Error('ozk-uptime: storage write failed');
  // بعد الحفظ: فشل الإرسال (أو DRY_RUN=0 بلا إعداد كامل) يظهر خطأً في سجلات Cloudflare، والحدث محفوظ معلّقاً
  if (ingest && !ingest.ok) throw new Error(`ozk-uptime: ingest failed (${ingest.reason})`);
  return { ...out, events, ingest };
}

// at-least-once: الجديد يُضاف إلى المعلّق، ولا يخرج حدث من المعلّق إلا بإقرار صريح من الخادم.
// يعدّل st.pending وst.events، ويرجع أحداث هذا التشغيل بحالاتها ونتيجة الإرسال.
async function deliverLive(st, fresh, { env, fetchImpl, now, log }) {
  const batch = mergePending(st.pending, [...fresh, ...replayDowns(st, fresh)]);
  const cfg = ingestConfig(env);
  // يُرسل حتى بلا أحداث: هذا هو نبض الحياة الذي يراقبه الخادم (توقف > 20 دقيقة ⇒ تنبيه)
  const sent = batch.slice(0, INGEST_BATCH_MAX);
  const ingest = cfg
    ? await sendBatch(cfg, { fetchImpl, events: sent, scheduledTime: now, targets: targetStatuses(st, batch.slice(INGEST_BATCH_MAX)) })
    : { ok: false, reason: 'not-configured' };
  const acked = [];
  st.pending = [];
  for (const e of batch) {
    const outcome = ingest.ok ? ingest.outcomes.get(e.id) : undefined; // ما لم يُرسل أو لم يُقرّ به يبقى معلّقاً
    if (outcome) acked.push({ ...e, status: outcome === 'duplicate' ? 'duplicate' : 'accepted', outcome, dryRun: false });
    else st.pending.push({ ...e, status: 'pending', dryRun: false });
  }
  for (const e of acked) {
    const inc = e.type === 'down' && st.targets[e.target]?.incident;
    if (inc && inc.id === e.incident) inc.delivered = true; // الخادم يعرف هذا الانقطاع
  }
  st.pending = capPending(st.pending, log);
  st.events = [...st.events, ...acked].slice(-EVENTS_KEEP);
  const byId = new Map([...acked, ...st.pending].map((e) => [e.id, e]));
  const events = fresh.map((e) => byId.get(e.id) || { ...e, status: 'pending', dryRun: false });
  if (!ingest.ok) log(JSON.stringify({ t: 'ozk-uptime', error: 'ingest-failed', reason: ingest.reason, pending: st.pending.length }));
  return { events, ingest };
}

// انقطاع جارٍ لم يُقرّ الخادم بحدث down له (بدأ في DRY_RUN ثم فُعّل الإرسال والهدف ما زال واقفاً، أو حالة
// أقدم بلا علامة): يُعاد حدث down بمعرّفه ووقته الأصليين، وإلا كُتمت تذكيراته وتعافيه (لا حادثة مفتوحة على
// الخادم). التكرار آمن: الخادم يرجع duplicate لمعرّف معروف.
function replayDowns(st, fresh) {
  const known = new Set([...st.pending, ...fresh].map((e) => e.id));
  const out = [];
  for (const [name, t] of Object.entries(st.targets)) {
    const inc = t.incident;
    if (!inc || inc.delivered || !TARGETS[name]) continue;
    const id = `${inc.id}:down`;
    if (known.has(id)) continue;
    out.push({ id, type: 'down', target: name, incident: inc.id, severity: TARGETS[name].critical ? 'critical' : 'medium',
      alertable: !!TARGETS[name].critical, at: inc.downAt, text: `${name} down (${inc.detail || 'fail'})`, detail: inc.detail || 'fail',
      upTicks: inc.upTicks || 0, replay: true });
  }
  return out;
}

// حالة كل هدف الآن، تُرسل مع النبض ليُغلق الخادم حادثة مفتوحة لم يصله تعافيها (ضياع حالة KV).
// هدف بقي له حدث لم يُرسل في هذه الدفعة (> 50) تُحجب حالته حتى يصل كل ما قبله.
function targetStatuses(st, unsent) {
  const held = new Set(unsent.map((e) => e.target));
  const out = {};
  for (const [name, t] of Object.entries(st.targets)) if (!held.has(name)) out[name] = t.status;
  return out;
}

// دمج بلا تكرار بالمعرّف، مرتباً زمنياً (down قبل recovered)
export function mergePending(pending, fresh) {
  const m = new Map();
  for (const e of [...(pending || []), ...(fresh || [])]) if (!m.has(e.id)) m.set(e.id, e);
  return [...m.values()].sort((a, b) => a.at - b.at);
}

// تجاوز الحدّ (انقطاع Supabase طويل جداً): يُسقط الأقدم من غير القابل للتنبيه أولاً، مع سجل خطأ ظاهر
export function capPending(pending, log = () => {}) {
  if (pending.length <= PENDING_MAX) return pending;
  const keep = [...pending].sort((a, b) => (b.alertable - a.alertable) || (b.at - a.at)).slice(0, PENDING_MAX);
  const ids = new Set(keep.map((e) => e.id));
  log(JSON.stringify({ t: 'ozk-uptime', error: 'pending-overflow', dropped: pending.filter((e) => !ids.has(e.id)).map((e) => e.id) }));
  return pending.filter((e) => ids.has(e.id));
}

export const handler = {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runOnce({ env, now: controller.scheduledTime }));
  },
  async fetch() { return new Response('not found', { status: 404 }); },
};
