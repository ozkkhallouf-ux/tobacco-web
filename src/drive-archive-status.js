// ============================================================================
// شارة «أرشفة Google Drive» للمالك — تحلّ محلّ شارة iCloud في الموضع نفسه.
//
// تقرأ مرآة حالة العامل (proposed/22: document_archive_heartbeat وdocument_archive_items)
// بجلسة المستخدم، فتحكمها RLS: المالك وحده يرى الصفوف؛ غيره يرى صفراً فلا تظهر الشارة.
//
// قواعد ثابتة:
//   * «متصلة» فقط إن تحقق العامل فعلياً من Drive خلال 15 دقيقة وتقريره حديث؛ تقرير قديم
//     = «العامل لا يردّ»، لا أخضر من حالة سابقة.
//   * الكتابة الوحيدة: request_document_archive_retry (RPC للمالك وحده، للفاشلة وحدها).
//   * رابط Drive يُعرض فقط بصيغة رابط العرض الخاص (يفتح بحساب المالك)، وكل نص مُهرَّب.
//   * معطّلة افتراضياً: appConfig.documentArchive.driveUi === true بعد التفعيل.
// التوثيق: docs/ai/topics/drive-invoice-archive.md
// ============================================================================
(function () {
  "use strict";

  const STALE_MS = 15 * 60 * 1000;
  const REFRESH_MS = 60 * 1000;
  const DRIVE_VIEW_RE = /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,200}\/view(\?usp=drivesdk)?$/;
  const ITEM_COLUMNS = "job_id,doc_number,doc_date,customer_name,version,status,failed,drive_web_link,last_error,updated_at";
  const STATES = Object.freeze({
    connected: { label: "متصلة", tone: "ok" },
    disconnected: { label: "غير متصلة", tone: "warn" },
    needs_reauth: { label: "تحتاج إعادة مصادقة", tone: "error" },
    identity_mismatch: { label: "حساب Google غير معتمد — متوقفة", tone: "error" },
    not_private: { label: "الأرشيف صار مشتركاً — متوقفة", tone: "error" },
    disabled: { label: "وضع تجريبي بلا رفع", tone: "unknown" },
    stale: { label: "العامل لا يردّ", tone: "warn" },
  });
  const TONE_COLOR = Object.freeze({ ok: "#3ecf7a", warn: "#e0a43a", error: "#e05a4f", unknown: "#9a9a9a" });

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]));
  }

  function fmtTime(value) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return "—";
    try {
      return d.toLocaleString("en-GB", { timeZone: "Asia/Damascus", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch {
      return d.toISOString().slice(0, 16).replace("T", " ");
    }
  }

  // نموذج العرض: نقي، يُختبر بلا DOM.
  function buildView(heartbeat, items, nowMs) {
    if (!heartbeat) return null;
    const reported = Date.parse(heartbeat.reported_at || "");
    const checked = Date.parse(heartbeat.drive_checked_at || "");
    let key = STATES[heartbeat.drive_state] ? heartbeat.drive_state : "disconnected";
    if (!(nowMs - reported <= STALE_MS)) key = "stale";
    else if (key === "connected" && !(nowMs - checked <= STALE_MS)) key = "disconnected";
    const list = Array.isArray(items) ? items : [];
    return {
      state: key,
      label: STATES[key].label,
      tone: STATES[key].tone,
      mode: String(heartbeat.mode || ""),
      pending: Number(heartbeat.pending_count) || 0,
      failed: Number(heartbeat.failed_count) || 0,
      lastSuccessAt: heartbeat.last_success_at || null,
      reportedAt: heartbeat.reported_at || null,
      failedItems: list.filter((i) => i.failed),
      recentItems: list.filter((i) => !i.failed),
    };
  }

  function safeLink(url) {
    return DRIVE_VIEW_RE.test(String(url || "")) ? String(url) : "";
  }

  function itemRow(item, withRetry) {
    const link = safeLink(item.drive_web_link);
    const version = Number(item.version) > 1 ? ` (نسخة ${Number(item.version)})` : "";
    return `<li data-job="${escapeText(item.job_id)}">`
      + `<span>فاتورة ${escapeText(item.doc_number)}${version} · ${escapeText(item.customer_name)} · ${escapeText(item.doc_date)}</span>`
      + (link ? ` <a href="${escapeText(link)}" target="_blank" rel="noopener noreferrer">فتح في Drive</a>` : "")
      + (withRetry ? ` <button type="button" data-retry="${escapeText(item.job_id)}">إعادة المحاولة</button>`
        + `<small> ${escapeText(item.last_error || "")}</small>` : "")
      + "</li>";
  }

  function panelHtml(view) {
    const failed = view.failedItems.length
      ? `<h4>فشلت (${view.failed})</h4><ul>${view.failedItems.map((i) => itemRow(i, true)).join("")}</ul>` : "";
    const recent = view.recentItems.length
      ? `<h4>آخر المؤرشف</h4><ul>${view.recentItems.map((i) => itemRow(i, false)).join("")}</ul>` : "";
    return `<div class="dar-head"><strong>أرشفة Google Drive: ${escapeText(view.label)}</strong>`
      + `<button type="button" data-close>×</button></div>`
      + `<p>آخر أرشفة ناجحة: ${escapeText(fmtTime(view.lastSuccessAt))} · آخر تقرير: ${escapeText(fmtTime(view.reportedAt))}</p>`
      + `<p>معلّقة: ${view.pending} · فاشلة: ${view.failed}${view.mode === "dry-run" ? " · وضع تجريبي" : ""}</p>`
      + `<form data-search><input name="n" inputmode="numeric" placeholder="رقم فاتورة" aria-label="بحث برقم الفاتورة"><button>بحث</button></form>`
      + `<div data-results></div>${failed}${recent}<p data-msg role="status"></p>`;
  }

  let chip = null;
  let panel = null;
  let lastView = null;
  let timer = null;

  function config() {
    try { return (window.appConfig && window.appConfig.documentArchive) || {}; } catch { return {}; }
  }

  function client() {
    return typeof window !== "undefined" ? window.ozkSupabaseClient : null;
  }

  async function load(c) {
    if (!c || typeof c.from !== "function") return null;
    if (c.auth && typeof c.auth.getSession === "function") {
      const { data } = await c.auth.getSession();
      if (!data || !data.session) return null;
    }
    const hb = await c.from("document_archive_heartbeat").select("host,drive_state,drive_checked_at,mode,last_success_at,pending_count,failed_count,reported_at")
      .order("reported_at", { ascending: false }).limit(1);
    if (hb.error || !Array.isArray(hb.data) || !hb.data.length) return null; // غير المالك، أو الهجرة غير مطبّقة
    const items = await c.from("document_archive_items").select(ITEM_COLUMNS).order("updated_at", { ascending: false }).limit(30);
    return buildView(hb.data[0], items.error ? [] : items.data, Date.now());
  }

  function hide() {
    if (chip) { chip.remove(); chip = null; }
    if (panel) { panel.remove(); panel = null; }
  }

  function renderChip(view) {
    if (!chip || !chip.isConnected) {
      chip = document.createElement("button");
      chip.type = "button";
      chip.setAttribute("data-ozk-drive-archive-status", "");
      chip.dir = "rtl";
      chip.style.cssText = [
        "position:fixed", "inset-inline-start:16px", "bottom:14px", "z-index:99998",
        "display:flex", "align-items:center", "gap:6px", "padding:4px 9px", "border-radius:999px",
        "font:600 11px/1.6 Tahoma,Arial,sans-serif", "cursor:pointer", "opacity:.85",
        "background:rgba(20,16,10,.78)", "color:#efe7d8", "border:1px solid rgba(255,255,255,.12)",
      ].join(";");
      chip.addEventListener("click", togglePanel);
      document.body.appendChild(chip);
    }
    chip.textContent = "";
    const dot = document.createElement("span");
    dot.style.cssText = `width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:${TONE_COLOR[view.tone]}`;
    const label = document.createElement("span");
    const counts = view.pending || view.failed ? ` · معلّقة ${view.pending} · فاشلة ${view.failed}` : "";
    label.textContent = `أرشفة Google Drive: ${view.label}${counts}`;
    chip.append(dot, label);
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    if (!lastView) return;
    panel = document.createElement("div");
    panel.setAttribute("data-ozk-drive-archive-panel", "");
    panel.dir = "rtl";
    panel.style.cssText = [
      "position:fixed", "inset-inline-start:16px", "bottom:48px", "z-index:99999",
      "width:min(420px,calc(100vw - 32px))", "max-height:60vh", "overflow:auto", "padding:12px 14px",
      "border-radius:12px", "background:#1b1611", "color:#efe7d8", "font:13px/1.7 Tahoma,Arial,sans-serif",
      "box-shadow:0 10px 30px rgba(0,0,0,.4)", "border:1px solid rgba(255,255,255,.12)",
    ].join(";");
    panel.innerHTML = panelHtml(lastView);
    panel.addEventListener("click", onPanelClick);
    panel.querySelector("[data-search]").addEventListener("submit", onSearch);
    document.body.appendChild(panel);
  }

  function message(text) {
    const el = panel && panel.querySelector("[data-msg]");
    if (el) el.textContent = text;
  }

  async function onPanelClick(event) {
    const target = event.target;
    if (target.closest("[data-close]")) { togglePanel(); return; }
    const retry = target.closest("[data-retry]");
    if (!retry) return;
    retry.disabled = true;
    try {
      const { data, error } = await client().rpc("request_document_archive_retry", { p_job_id: retry.getAttribute("data-retry") });
      message(error ? "تعذّر طلب إعادة المحاولة." : (data && data.ok ? "طُلبت إعادة المحاولة؛ ينفّذها العامل خلال دقائق." : "لا حاجة لإعادة المحاولة."));
    } catch {
      message("تعذّر طلب إعادة المحاولة.");
    }
  }

  async function onSearch(event) {
    event.preventDefault();
    const n = String(new FormData(event.target).get("n") || "").trim();
    const box = panel.querySelector("[data-results]");
    if (!/^\d{1,12}$/.test(n)) { box.textContent = ""; return; }
    try {
      const { data, error } = await client().from("document_archive_items").select(ITEM_COLUMNS)
        .eq("doc_number", n).order("version", { ascending: true }).limit(20);
      box.innerHTML = error ? "<p>تعذّر البحث.</p>"
        : (data && data.length ? `<ul>${data.map((i) => itemRow(i, Boolean(i.failed))).join("")}</ul>` : "<p>لا نسخة مؤرشفة لهذا الرقم.</p>");
    } catch {
      box.innerHTML = "<p>تعذّر البحث.</p>";
    }
  }

  async function refresh() {
    if (config().driveUi !== true || typeof document === "undefined" || !document.body) { hide(); return; }
    let view = null;
    try { view = await load(client()); } catch { view = null; }
    lastView = view;
    if (!view) { hide(); return; }
    renderChip(view);
  }

  function boot() {
    if (config().driveUi !== true) return;
    refresh();
    timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }

  const api = Object.freeze({ buildView, panelHtml, safeLink, refresh, STATES, STALE_MS });
  if (typeof window !== "undefined") {
    window.ozkDriveArchiveStatus = api;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  void timer;
})();
