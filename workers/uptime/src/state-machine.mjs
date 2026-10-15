// آلة حالة نقيّة (بلا شبكة ولا تخزين ولا ساعة): step(state, now, results, cfg) → { state, events, ignored }
// UP → SUSPECT → DOWN → RECOVERING → UP. الأحداث لها معرّفات حتمية ⇒ إعادة التنفيذ لا تُنتج حدثاً جديداً (effectively-once).
export const SLOT_MS = 5 * 60_000;
export const CONFIRM_FAILS = 3; // من آخر WINDOW نتائج
export const WINDOW = 4;
export const RECOVER_OK = 2;
export const REMINDERS = [['1h', 3_600_000], ['6h', 21_600_000], ['24h', 86_400_000]];
export const EVENTS_KEEP = 20; // سجل للتشخيص فقط؛ الأحداث المعلّقة في state.pending ولا يطالها هذا القص

export const TARGETS = {
  site: { critical: true },
  bulletin: { critical: false },
};

export const emptyState = () => ({ v: 1, lastRunAt: 0, heartbeat: 0, targets: {}, events: [], pending: [] });
const emptyTarget = () => ({ status: 'UP', window: [], okStreak: 0, incident: null });

const slot = (t) => Math.floor(t / SLOT_MS) * SLOT_MS;

// كل معالج يعدّل حالة الهدف t مباشرةً ويستدعي ctx.emit للأحداث؛ نفس منطق الانتقالات دون تغيير.
const HANDLERS = {
  UP(t, r, ctx) {
    if (!r.ok) { t.status = 'SUSPECT'; t.firstFailAt = ctx.now; }
  },
  SUSPECT(t, r, ctx) {
    if (r.ok) { t.status = 'UP'; delete t.firstFailAt; return; }
    if (t.window.filter((x) => !x).length < CONFIRM_FAILS) return;
    t.status = 'DOWN';
    t.incident = { id: `${ctx.name}:${slot(t.firstFailAt)}`, downAt: ctx.now, reminders: [] };
    ctx.emit(ctx.mk('down', 'down', `${ctx.name} down (${r.detail || 'fail'})`, r.detail || 'fail'));
  },
  DOWN(t, r, ctx) {
    if (r.ok) { t.status = 'RECOVERING'; t.okStreak = 1; return; }
    for (const [label, ms] of REMINDERS) {
      if (ctx.now - t.incident.downAt >= ms && !t.incident.reminders.includes(label)) {
        t.incident.reminders.push(label);
        ctx.emit(ctx.mk(`reminder:${label}`, 'reminder', `${ctx.name} still down (${label})`));
      }
    }
  },
  RECOVERING(t, r, ctx) {
    if (!r.ok) { t.status = 'DOWN'; t.okStreak = 0; return; }
    if (++t.okStreak < RECOVER_OK) return;
    ctx.emit(ctx.mk('recovered', 'recovered', `${ctx.name} recovered after ${Math.round((ctx.now - t.incident.downAt) / 60000)}m`));
    t.status = 'UP'; t.okStreak = 0; t.incident = null; delete t.firstFailAt;
  },
};

export function step(prev, now, results, targets = TARGETS) {
  const state = structuredClone(prev && prev.v === 1 ? prev : emptyState());
  // تشغيل مكرر أو غير مرتّب: لا أثر
  if (now <= state.lastRunAt) return { state: prev, events: [], ignored: true };
  const events = [];
  state.pending ||= [];
  const seen = new Set([...state.events, ...state.pending].map((e) => e.id));
  const emit = (e) => { if (!seen.has(e.id)) { seen.add(e.id); events.push(e); } };

  for (const [name, cfg] of Object.entries(targets)) {
    const r = results[name];
    if (!r) continue;
    const t = (state.targets[name] ||= emptyTarget());
    t.window = [...t.window, !!r.ok].slice(-WINDOW);
    const mk = (suffix, type, text, detail = null) => ({
      id: `${t.incident.id}:${suffix}`, type, target: name, incident: t.incident.id,
      severity: cfg.critical ? 'critical' : 'medium', alertable: !!cfg.critical, at: now, text, detail,
    });
    HANDLERS[t.status](t, r, { name, now, emit, mk });
    if (t.status === 'UP') t.okStreak = 0;
  }
  state.lastRunAt = now;
  state.heartbeat = now;
  return { state, events, ignored: false };
}
