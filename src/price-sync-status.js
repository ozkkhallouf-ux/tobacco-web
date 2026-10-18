// ============================================================================
// شريط حالة مزامنة الأسعار (الموقع ← الأمين) في صفحة الأسعار — المرحلة الثانية.
//
// يقرأ public.price_sync_heartbeats (proposed/16، مطبَّقة 2026-10-18) قراءةً فقط بجلسة المستخدم،
// فتحكمه RLS: الموظفون وحدهم يرون الصفوف (is_staff())، وغيرهم يرى صفر صفوف ⇒ UNKNOWN.
// يصنّف بـ src/price-sync-health.js ويعرض الحالة الخماسية بتوقيت دمشق.
//
// قواعد ثابتة:
//   * لا كتابة إطلاقاً: select فقط، ولا rpc/insert/update/delete.
//   * لا writer_id ولا host في الطلب ولا في العرض (لا هوية حساب).
//   * أي فشل في القراءة (بلا عميل، بلا جلسة، خطأ شبكة/صلاحية) = UNKNOWN بنص صريح، لا أخضر افتراضي.
//   * HEALTHY لا يأتي من نجاح قديم: المصنِّف يعطي STALE إن تجاوزت آخر محاولة 15 دقيقة.
//   * التحديث كل 60 ثانية والصفحة ظاهرة على مسار pricing، وعند العودة للتبويب؛ يُستبدل الشريط وحده
//     في مكانه بلا render كامل.
//   * حفظ سعر والحالة ليست HEALTHY: تحذير يُلحق برسالة الحفظ (لا منع للحفظ) عبر saveWarning().
// التوثيق: docs/ai/topics/price-sync-heartbeat.md
// ============================================================================
(function () {
  "use strict";

  const ROUTE = "pricing";
  const TABLE = "price_sync_heartbeats";
  // أعمدة العرض فقط — بلا writer_id ولا host.
  const COLUMNS = "received_at,kind,outcome,summary,last_success_at,last_ameen_contact_at";
  const ROW_LIMIT = 20;
  const REFRESH_MS = 60000;
  const READ_FAILED_TEXT = "تعذّر قراءة حالة المزامنة";

  const LEVEL_CLASS = Object.freeze({ ok: "is-healthy", warn: "is-stale", error: "is-failed", unknown: "is-unknown" });
  const STATE_LABEL = Object.freeze({
    HEALTHY: "سليمة",
    STALE: "متوقفة",
    FAILED: "فشلت",
    DISABLED: "معطّلة",
    UNKNOWN: "غير معروفة"
  });

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  }

  function isCount(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  // آخر فشل وسببه من الصفوف نفسها (المصنِّف يعطي وقته فقط).
  function lastFailureOf(engine, rows) {
    let best = null;
    for (const row of Array.isArray(rows) ? rows : []) {
      const attempt = engine.normalizeAttempt(row);
      if (!attempt || engine.SUCCESS_OUTCOMES.includes(attempt.outcome)) continue;
      if (!best || attempt.at > best.at) best = attempt;
    }
    if (!best) return null;
    const reason = engine.FAILURE_OUTCOMES[best.outcome] || "فشل غير معروف السبب";
    return { at: best.at, outcome: best.outcome, reason };
  }

  // نموذج العرض: نقي، يُختبر بلا DOM.
  // readError: نص الخطأ إن فشلت القراءة (يُعرض UNKNOWN بلا تصنيف أي صفوف).
  function buildModel(engine, rows, options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    if (!engine) {
      return { state: "UNKNOWN", level: "unknown", icon: "❔", title: READ_FAILED_TEXT, detail: "", facts: [], checkedAt: now };
    }
    if (options.readError) {
      return { state: "UNKNOWN", level: "unknown", icon: "❔", title: READ_FAILED_TEXT, detail: "تُعرض الحالة غير معروفة إلى أن تنجح القراءة", facts: [], checkedAt: now };
    }
    const health = engine.classifyPriceSyncHealth(rows, { now });
    const text = engine.describePriceSyncHealth(health, { now });
    const at = (value) => engine.formatDamascusTime(value, now);
    const facts = [];
    facts.push({ label: "آخر نجاح مثبت", value: health.lastSuccessAt ? at(health.lastSuccessAt) : "لا يوجد" });
    facts.push({ label: "آخر محاولة", value: health.lastAttemptAt ? at(health.lastAttemptAt) : "لا يوجد" });
    const counts = health.counts || {};
    if (isCount(counts.appliedWholesale) || isCount(counts.appliedRetail)) {
      facts.push({ label: "المطبَّق", value: `جملة ${isCount(counts.appliedWholesale) ? counts.appliedWholesale : "؟"} — مفرق ${isCount(counts.appliedRetail) ? counts.appliedRetail : "؟"}` });
    }
    if (isCount(counts.conflicts) || isCount(counts.notInAmeen)) {
      facts.push({ label: "التعارضات", value: `${isCount(counts.conflicts) ? counts.conflicts : 0} تعارض — ${isCount(counts.notInAmeen) ? counts.notInAmeen : 0} غير موجود بالأمين` });
    }
    // «المعلّق» لا يُعرض إلا إن كان مثبتاً: فرق الفحص المستقل بعد الكتابة (مواد لم تطابق أو ناقصة).
    if (isCount(counts.mismatches) && isCount(counts.missing) && counts.mismatches + counts.missing > 0) {
      facts.push({ label: "لم تصل للأمين (مثبت بالفحص)", value: `${counts.mismatches + counts.missing} سعر` });
    }
    const failure = lastFailureOf(engine, rows);
    if (failure) facts.push({ label: "آخر فشل", value: `${failure.reason} — ${at(failure.at)}` });
    return {
      state: health.state,
      level: text.level,
      icon: text.icon,
      title: text.text,
      detail: text.detail || "",
      facts,
      checkedAt: now
    };
  }

  function renderHtml(model) {
    const level = LEVEL_CLASS[model.level] || LEVEL_CLASS.unknown;
    const label = STATE_LABEL[model.state] || STATE_LABEL.UNKNOWN;
    const facts = model.facts.map((fact) =>
      `<div class="price-sync-fact"><dt>${escapeText(fact.label)}</dt><dd>${escapeText(fact.value)}</dd></div>`).join("");
    return `<section class="price-sync-status ${level}" data-price-sync-status data-state="${escapeText(model.state)}" role="status" aria-live="polite">
  <div class="price-sync-head">
    <span class="price-sync-icon" aria-hidden="true">${escapeText(model.icon)}</span>
    <div class="price-sync-text">
      <strong>مزامنة الأسعار مع الأمين: <span class="price-sync-state">${escapeText(label)}</span></strong>
      <span class="price-sync-title">${escapeText(model.title)}</span>
      ${model.detail ? `<span class="price-sync-detail">${escapeText(model.detail)}</span>` : ""}
    </div>
  </div>
  ${facts ? `<dl class="price-sync-facts">${facts}</dl>` : ""}
</section>`;
  }

  // قراءة فقط عبر جلسة المستخدم. client: عميل supabase-js (قابل للحقن في الاختبار).
  async function fetchRows(client) {
    if (!client || typeof client.from !== "function") throw new Error("no_client");
    if (client.auth && typeof client.auth.getSession === "function") {
      const { data } = await client.auth.getSession();
      if (!data || !data.session) throw new Error("no_session");
    }
    const { data, error } = await client.from(TABLE).select(COLUMNS).order("received_at", { ascending: false }).limit(ROW_LIMIT);
    if (error) throw new Error(String(error.message || "read_failed"));
    return Array.isArray(data) ? data : [];
  }

  async function loadModel(options = {}) {
    const engine = options.engine || (typeof window !== "undefined" ? window.ozkPriceSyncHealth : null);
    const client = options.client || (typeof window !== "undefined" ? window.ozkSupabaseClient : null);
    try {
      const rows = await fetchRows(client);
      return buildModel(engine, rows, { now: options.now });
    } catch (error) {
      return buildModel(engine, [], { now: options.now, readError: String(error && error.message || error) });
    }
  }

  // نص تحذير يُلحق برسالة حفظ السعر إن لم تكن المزامنة سليمة؛ فارغ إن كانت سليمة.
  function saveWarningFor(model) {
    // لا قراءة بعد = غير معروفة، لا سليمة.
    if (model && model.state === "HEALTHY") return "";
    if (!model || model.state === "UNKNOWN") return "⚠️ حالة مزامنة الأسعار مع الأمين غير معروفة — تأكد من وصول السعر للأمين.";
    return `⚠️ ${model.title} — هذا السعر لن يصل للأمين حتى تعود المزامنة.`;
  }

  const api = { ROUTE, TABLE, COLUMNS, ROW_LIMIT, REFRESH_MS, READ_FAILED_TEXT, buildModel, renderHtml, fetchRows, loadModel, saveWarningFor };

  // ── الربط بالصفحة (المتصفح فقط) ────────────────────────────────────────────────────────────
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    let current = null;
    let timer = null;
    let busy = false;

    const onPricing = () => {
      try { return typeof state !== "undefined" && state.route === ROUTE && Boolean(state.session); } catch { return false; }
    };

    // يضع الشريط أعلى صفحة الأسعار، أو يستبدله في مكانه دون إعادة رسم الصفحة.
    function paint() {
      if (!onPricing()) return;
      const host = document.querySelector(".newsletter-hub");
      if (!host) return;
      const html = renderHtml(current || buildModel(window.ozkPriceSyncHealth, [], { readError: "loading" }));
      const existing = host.querySelector("[data-price-sync-status]");
      const template = document.createElement("template");
      template.innerHTML = html.trim();
      const node = template.content.firstElementChild;
      if (existing) existing.replaceWith(node); else host.prepend(node);
    }

    async function refresh() {
      if (busy || !onPricing() || document.hidden) return;
      busy = true;
      try {
        current = await loadModel();
      } finally {
        busy = false;
      }
      paint();
    }

    function syncTimer() {
      if (onPricing()) {
        if (!timer) {
          timer = setInterval(refresh, REFRESH_MS);
          queueMicrotask(refresh);
        }
      } else if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    api.saveWarning = () => saveWarningFor(current);
    api.refresh = refresh;

    try {
      if (typeof render === "function") {
        const baseRender = render;
        // eslint-disable-next-line no-global-assign
        render = function priceSyncAwareRender() {
          baseRender();
          paint();
          syncTimer();
        };
        document.addEventListener("visibilitychange", () => { if (!document.hidden && onPricing()) refresh(); });
        window.addEventListener("online", () => { if (onPricing()) refresh(); });
        paint();
        syncTimer();
      }
    } catch {
      // الشريط ميزة إضافية: لا يكسر الصفحة إن تعذّر ربطه.
    }
  }

  if (typeof window !== "undefined") window.ozkPriceSyncStatus = api;
  if (typeof globalThis !== "undefined") globalThis.ozkPriceSyncStatus = api;
})();
