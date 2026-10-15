// إرسال أحداث ozk-uptime ونبض الحياة إلى Supabase (public.uptime_ingest — supabase/proposed/14) بتوقيع HMAC-SHA256.
// لا مرسِل رسائل هنا: الخادم وحده يقرر الإدخال إلى طابور التنبيهات، داخل معاملة واحدة مع تسجيل event_id.
// يُستدعى فقط حين DRY_RUN="0" والإعداد كامل؛ وإلا لا يخرج أي طلب غير فحصي ozktobacco.com.
const RPC_PATH = '/rest/v1/rpc/uptime_ingest';
const TIMEOUT_MS = 10_000;
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;

// الإعداد الكامل أو null: عنوان المشروع، المفتاح العام (دور anon، ليس سراً)، وسرّ التوقيع (≥ 32 حرفاً).
export function ingestConfig(env) {
  const url = String(env?.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env?.SUPABASE_PUBLISHABLE_KEY || '').trim();
  const secret = String(env?.UPTIME_HMAC_SECRET || '');
  if (!URL_RE.test(url) || !apiKey || secret.length < 32) return null;
  return { url, apiKey, secret };
}

export async function hmacHex(secret, text) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// الحقول التي يقبلها الخادم فقط (قرار «قابل للتنبيه» على الخادم، لا يُرسل من هنا)
export const toWire = (e) => ({ id: e.id, type: e.type, target: e.target, incident: e.incident, at: e.at, detail: e.detail ?? null,
  ...(e.type === 'down' && Number.isInteger(e.upTicks) ? { upTicks: e.upTicks } : {}) });

// نص الطلب الحرفي يُوقَّع كما هو، والخادم يتحقق من التوقيع على النص نفسه قبل تحليله.
// targets (اختياري): حالة كل هدف الآن في آلة الحالة؛ الخادم يُغلق بها حادثة مفتوحة لم يصله تعافيها (ضياع KV).
export async function buildRequest(cfg, { events, scheduledTime, targets, now = Date.now(), nonce = crypto.randomUUID() }) {
  const payload = JSON.stringify({ v: 1, ts: now, nonce, scheduledTime, events: events.map(toWire), targets });
  return { payload, signature: await hmacHex(cfg.secret, payload) };
}

// النتيجة: { ok:true, outcomes: Map(id → outcome) } فقط عند إقرار صريح {ok:true, results:[…]}؛ أي شيء آخر فشل.
export async function sendBatch(cfg, { fetchImpl, events, scheduledTime, targets, now, nonce, timeoutMs = TIMEOUT_MS }) {
  const { payload, signature } = await buildRequest(cfg, { events, scheduledTime, targets, now, nonce });
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(cfg.url + RPC_PATH, {
      method: 'POST', signal: ac.signal,
      headers: {
        apikey: cfg.apiKey, 'content-type': 'application/json',
        'content-profile': 'public', 'accept-profile': 'public', 'user-agent': 'ozk-uptime/1',
      },
      body: JSON.stringify({ p_payload: payload, p_signature: signature }),
    });
    if (!res.ok) { try { await res.body?.cancel(); } catch {} return { ok: false, reason: `http-${res.status}` }; }
    let body;
    try { body = await res.json(); } catch { return { ok: false, reason: 'bad-response' }; }
    if (body?.ok !== true || !Array.isArray(body.results)) return { ok: false, reason: 'bad-response' };
    const outcomes = new Map();
    for (const r of body.results) if (r && typeof r.id === 'string' && typeof r.outcome === 'string') outcomes.set(r.id, r.outcome);
    return { ok: true, outcomes };
  } catch (e) {
    return { ok: false, reason: timedOut ? 'timeout' : `network-error:${String(e?.name || 'Error').slice(0, 40)}` };
  } finally { clearTimeout(timer); }
}
