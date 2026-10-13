// آلة حالة نقيّة (بلا شبكة ولا تخزين ولا ساعة): step(state, now, results, cfg) → { state, events, ignored }
// UP → SUSPECT → DOWN → RECOVERING → UP. الأحداث لها معرّفات حتمية ⇒ إعادة التنفيذ لا تُنتج حدثاً جديداً (effectively-once).
export const SLOT_MS = 5 * 60_000;
export const CONFIRM_FAILS = 3; // من آخر WINDOW نتائج
export const WINDOW = 4;
export const RECOVER_OK = 2;
export const REMINDERS = [['1h', 3_600_000], ['6h', 21_600_000], ['24h', 86_400_000]];
export const EVENTS_KEEP = 20;

export const TARGETS = {
  site: { critical: true },
  bulletin: { critical: false },
};

export const emptyState = () => ({ v: 1, lastRunAt: 0, heartbeat: 0, targets: {}, events: [] });
const emptyTarget = () => ({ status: 'UP', window: [], okStreak: 0, incident: null });

const slot = (t) => Math.floor(t / SLOT_MS) * SLOT_MS;

export function step(prev, now, results, targets = TARGETS) {
  const state = structuredClone(prev && prev.v === 1 ? prev : emptyState());
  // تشغيل مكرر أو غير مرتّب: لا أثر
  if (now <= state.lastRunAt) return { state: prev, events: [], ignored: true };
  const events = [];
  const seen = new Set(state.events.map((e) => e.id));
  const emit = (e) => { if (!seen.has(e.id)) { seen.add(e.id); events.push(e); } };

  for (const [name, cfg] of Object.entries(targets)) {
    const r = results[name];
    if (!r) continue;
    const t = (state.targets[name] ||= emptyTarget());
    t.window = [...t.window, !!r.ok].slice(-WINDOW);
    const mk = (suffix, type, text) => ({
      id: `${t.incident.id}:${suffix}`, type, target: name, incident: t.incident.id,
      severity: cfg.critical ? 'critical' : 'medium', alertable: !!cfg.critical, at: now, text,
    });

    if (t.status === 'UP') {
      if (!r.ok) { t.status = 'SUSPECT'; t.firstFailAt = now; }
    } else if (t.status === 'SUSPECT') {
      if (r.ok) { t.status = 'UP'; delete t.firstFailAt; }
      else if (t.window.filter((x) => !x).length >= CONFIRM_FAILS) {
        t.status = 'DOWN';
        t.incident = { id: `${name}:${slot(t.firstFailAt)}`, downAt: now, reminders: [] };
        emit(mk('down', 'down', `${name} down (${r.detail || 'fail'})`));
      }
    } else if (t.status === 'DOWN') {
      if (r.ok) { t.status = 'RECOVERING'; t.okStreak = 1; }
      else {
        for (const [label, ms] of REMINDERS) {
          if (now - t.incident.downAt >= ms && !t.incident.reminders.includes(label)) {
            t.incident.reminders.push(label);
            emit(mk(`reminder:${label}`, 'reminder', `${name} still down (${label})`));
          }
        }
      }
    } else if (t.status === 'RECOVERING') {
      if (!r.ok) { t.status = 'DOWN'; t.okStreak = 0; }
      else if (++t.okStreak >= RECOVER_OK) {
        emit(mk('recovered', 'recovered', `${name} recovered after ${Math.round((now - t.incident.downAt) / 60000)}m`));
        t.status = 'UP'; t.okStreak = 0; t.incident = null; delete t.firstFailAt;
      }
    }
    if (t.status === 'UP') t.okStreak = 0;
  }
  state.lastRunAt = now;
  state.heartbeat = now;
  return { state, events, ignored: false };
}
