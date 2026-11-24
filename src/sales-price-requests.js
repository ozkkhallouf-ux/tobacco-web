// ============================================================================
// فواتير بانتظار تسعير المالك قبل إدخالها في الأمين (طلب عمر 2026-11-05).
//
// الدورة: المحاسب (حساب غير مالك) يكتب الفاتورة في «فاتورة مبيعات» ويرسلها للتسعير
//   ← يصل المالك إشعار تيليغرام ← المالك يعدّل الأسعار ويعتمدها («مسعّرة»)
//   ← المحاسب يدخلها يدوياً في الأمين ويسجّل رقم فاتورة الأمين («أُدخلت في الأمين»).
// لا شيء هنا يكتب في الأمين. كل كتابة عبر دوال Supabase (Migration 27) التي تتحقق
// من الدور والحالة والنسخة؛ هذه الوحدة لا تقرر الصلاحية، تعرضها فقط.
// فاتورة المالك من حسابه لا تمرّ بهذه الدورة (تُحفظ كما كانت).
// ============================================================================
(function (window) {
  const STATUS_LABELS = {
    submitted: "بانتظار التسعير",
    priced: "مسعّرة",
    entered: "أُدخلت في الأمين",
    cancelled: "ملغاة"
  };

  const ERROR_MESSAGES = {
    not_allowed: "ليس لديك صلاحية لهذه العملية على طلب التسعير.",
    owner_only: "التسعير للمالك وحده.",
    version_conflict: "عدّل شخص آخر هذه الفاتورة للتو — حدّث القائمة ثم أعد المحاولة.",
    status_locked: "هذه الفاتورة مقفلة (أُدخلت في الأمين أو أُلغيت).",
    not_priced: "الفاتورة لم تُسعَّر بعد — لا تُدخل في الأمين قبل تسعير المالك.",
    not_found: "لم يُعثر على الفاتورة.",
    lines_required: "أضف صنفاً واحداً على الأقل.",
    too_many_lines: "عدد الأصناف أكبر من المسموح (200).",
    line_qty_invalid: "كمية أحد الأصناف غير صالحة.",
    line_unit_invalid: "وحدة أحد الأصناف غير صالحة.",
    line_name_invalid: "اسم أحد الأصناف غير صالح.",
    line_price_invalid: "سعر أحد الأصناف غير صالح.",
    line_price_required: "كل صنف يحتاج سعراً أكبر من صفر قبل الاعتماد.",
    prices_length_mismatch: "عدد الأسعار لا يطابق عدد الأصناف — حدّث القائمة.",
    discount_invalid: "الحسم غير صالح (سالب أو أكبر من الإجمالي).",
    ameen_bill_no_required: "اكتب رقم فاتورة الأمين.",
    rate_required: "سعر صرف الليرة غير متوفر — لا يمكن إرسال فاتورة مفرق.",
    mode_invalid: "وضع الفاتورة غير صالح.",
    pay_method_invalid: "طريقة الدفع غير صالحة."
  };

  // الشرط بالحساب لا بالجهاز: الموقع يعرف من سجّل الدخول فقط.
  function needsOwnerPricing(session) {
    if (!session) return false;
    const role = session.accessRole;
    return role !== "owner" && role !== "inventory_counter";
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || "");
  }

  // الكمية المطلوبة والمتوفرة بالوحدة نفسها. المتوفر null = لا تقرير مستودعات.
  function stockCheck(requested, available) {
    if (available === null || available === undefined || !Number.isFinite(Number(available))) {
      return { level: "unknown", available: null };
    }
    const avail = Number(available);
    return { level: Number(requested) > avail ? "short" : "ok", available: avail };
  }

  function errorMessage(raw) {
    const text = String(raw?.message ?? raw ?? "");
    for (const code of Object.keys(ERROR_MESSAGES)) {
      if (text.includes(code)) return ERROR_MESSAGES[code];
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // الحالة والواجهة
  // ---------------------------------------------------------------------------
  const view = {
    open: false,
    loading: false,
    loaded: false,
    attempted: false,   // محاولة تحميل تلقائية واحدة — فشلها لا يعيد المحاولة مع كل رسم
    error: "",
    rows: [],
    filter: "active",   // active | all
    selectedId: null,
    prices: {},         // id → [string]
    discount: {},       // id → string
    billNo: {},         // id → string
    busy: false
  };

  function selected() {
    return view.rows.find((r) => r.id === view.selectedId) || null;
  }

  async function load(ctx, { quiet = false } = {}) {
    if (!ctx.dataStore?.listSalesPriceRequests) return;
    view.attempted = true;
    view.loading = true;
    view.error = "";
    if (!quiet) ctx.render();
    try {
      view.rows = await ctx.dataStore.listSalesPriceRequests();
      view.loaded = true;
    } catch (error) {
      view.error = errorMessage(error) || ctx.safeErrorMessage(error);
    } finally {
      view.loading = false;
      ctx.render();
    }
  }

  function pendingCount() {
    return view.rows.filter((r) => r.status === "submitted").length;
  }
  function pricedCount() {
    return view.rows.filter((r) => r.status === "priced").length;
  }

  function toolbarButton(ctx) {
    const owner = ctx.isOwner();
    const count = owner ? pendingCount() : pricedCount();
    const badge = view.loaded && count > 0 ? ` <span class="spr-badge">${count}</span>` : "";
    const label = owner ? "📝 بانتظار تسعيري" : "📝 فواتير التسعير";
    return `<button type="button" class="sales-mode-btn" data-action="spr-open" title="${owner ? "فواتير المحاسب التي تنتظر تسعيرك" : "فواتيرك المرسلة للتسعير وحالتها"}">${label}${badge}</button>`;
  }

  // مدخل ثابت في قائمة التنقل: على الهاتف تصير القائمة شبكة أعلى الصفحة، وزر شريط
  // الفاتورة يقع تحتها بعيداً عن العين. بلا عدّاد عمداً: القائمة لا تُحمَّل في كل
  // صفحة، وعدّاد قديم أسوأ من لا عدّاد. الفتح يعيد التحميل دائماً.
  function navButton(ctx) {
    const owner = ctx.isOwner();
    const active = view.open && ctx.route() === "sales" ? "active" : "";
    return `<button type="button" class="nav-link ${active}" data-action="spr-nav-open" title="${owner ? "فواتير المحاسب التي تنتظر تسعيرك" : "فواتيرك المرسلة للتسعير وحالتها"}">${owner ? "📝 بانتظار تسعيري" : "📝 فواتير التسعير"}</button>`;
  }

  function lineStockHtml(ctx, line) {
    const s = ctx.stockForLine(line);
    if (!s) return "";
    return `<small class="spr-stock ${s.short ? "is-short" : ""}">${ctx.escapeHtml(s.text)}</small>`;
  }

  function listHtml(ctx) {
    const esc = ctx.escapeHtml;
    const owner = ctx.isOwner();
    const rows = view.rows.filter((r) => view.filter === "all" || r.status === "submitted" || r.status === "priced");
    if (view.loading && !view.loaded) return '<p class="muted">جاري التحميل…</p>';
    if (view.error) return `<p class="notice-panel error">${esc(view.error)}</p>`;
    if (!rows.length) return `<p class="muted">${view.filter === "all" ? "لا توجد فواتير تسعير بعد." : "لا توجد فواتير مفتوحة."}</p>`;
    return `<div class="spr-list">${rows.map((r) => `
      <button type="button" class="spr-item is-${esc(r.status)} ${r.id === view.selectedId ? "active" : ""}" data-spr-select="${r.id}">
        <span class="spr-item-head"><strong>#${r.id}</strong> <span class="spr-status is-${esc(r.status)}">${esc(statusLabel(r.status))}</span></span>
        <span>${esc(r.customerName || "نقدي")} · ${r.lines.length} صنف · ${r.mode === "mufrak" ? "مفرق" : "جملة"}</span>
        <small class="muted" dir="ltr">${esc(ctx.formatDateTime(r.createdAt))}${owner && r.createdByEmail ? ` · ${esc(r.createdByEmail)}` : ""}${r.ameenBillNo ? ` · الأمين ${esc(r.ameenBillNo)}` : ""}</small>
      </button>`).join("")}</div>`;
  }

  function detailHtml(ctx) {
    const r = selected();
    if (!r) return '<p class="muted spr-empty">اختر فاتورة من القائمة.</p>';
    const esc = ctx.escapeHtml;
    const owner = ctx.isOwner();
    const mode = r.mode;
    const sym = mode === "mufrak" ? "ل.س" : "$";
    const canPrice = owner && (r.status === "submitted" || r.status === "priced");
    const prices = view.prices[r.id] || r.lines.map((l) => ctx.fmtPlain(l.price, mode));
    view.prices[r.id] = prices;
    const discount = view.discount[r.id] ?? (Number(r.discount) > 0 ? ctx.fmtPlain(r.discount, mode) : "");
    const total = r.lines.reduce((t, l, i) => t + Number(l.qty) * (canPrice ? ctx.toNumber(prices[i]) : Number(l.price)), 0);
    const net = total - (canPrice ? ctx.toNumber(discount) : Number(r.discount || 0));
    const showPrices = canPrice || r.status === "priced" || r.status === "entered";

    const linesHtml = r.lines.map((l, i) => {
      const cost = owner ? ctx.costForLine(l) : 0;
      const priceCell = canPrice
        ? `<input class="inv-input inv-num" data-spr-price="${i}" value="${esc(prices[i])}" inputmode="decimal" dir="ltr" type="text">`
        : showPrices ? `<span dir="ltr">${esc(ctx.money(l.price, mode))}</span>` : '<span class="muted">—</span>';
      const lineTotal = canPrice ? Number(l.qty) * ctx.toNumber(prices[i]) : Number(l.total);
      return `<tr>
        <td><strong>${esc(l.name)}</strong>${l.num ? `<small class="muted" dir="ltr"> #${esc(l.num)}</small>` : ""}${lineStockHtml(ctx, l)}</td>
        <td>${esc(l.unit || "")}</td>
        <td dir="ltr">${esc(String(l.qty))}</td>
        <td>${priceCell}${owner && cost > 0 ? `<small class="muted spr-cost" dir="ltr">تكلفة ${esc(ctx.money(cost, "jumla"))}</small>` : ""}</td>
        <td dir="ltr" data-spr-linetotal="${i}">${showPrices ? esc(ctx.money(lineTotal, mode)) : "—"}</td>
      </tr>`;
    }).join("");

    let actions = "";
    if (canPrice) {
      actions = `<div class="inv-actions"><button class="button primary" data-action="spr-price" ${view.busy ? "disabled" : ""}>✅ اعتماد التسعير</button>
        <button class="button secondary" data-action="spr-cancel" ${view.busy ? "disabled" : ""}>إلغاء الفاتورة</button></div>`;
    } else if (r.status === "priced") {
      actions = `<p class="spr-hint">أدخل الفاتورة في الأمين بهذه الأسعار تماماً، ثم اكتب رقم فاتورة الأمين هنا.</p>
        <div class="inv-actions"><input class="inv-input-main" data-spr-billno value="${esc(view.billNo[r.id] || "")}" placeholder="رقم فاتورة الأمين" dir="ltr" maxlength="40">
        <button class="button primary" data-action="spr-entered" ${view.busy ? "disabled" : ""}>✔ تم الإدخال في الأمين</button></div>`;
    } else if (r.status === "submitted") {
      actions = `<p class="spr-hint">بانتظار تسعير المالك. لا تُدخلها في الأمين قبل أن تصير «مسعّرة».</p>
        ${r.createdBy === ctx.session()?.id ? `<div class="inv-actions"><button class="button secondary" data-action="spr-cancel" ${view.busy ? "disabled" : ""}>إلغاء الفاتورة</button></div>` : ""}`;
    } else if (r.status === "entered") {
      actions = `<p class="spr-hint">أُدخلت في الأمين برقم <strong dir="ltr">${esc(r.ameenBillNo || "")}</strong>${r.enteredAt ? ` — ${esc(ctx.formatDateTime(r.enteredAt))}` : ""}.</p>`;
    } else if (r.status === "cancelled") {
      actions = `<p class="spr-hint">ملغاة${r.cancelReason ? `: ${esc(r.cancelReason)}` : ""}.</p>`;
    }

    return `<div class="spr-detail">
      <h3>فاتورة #${r.id} — ${esc(r.customerName || "نقدي")} <span class="spr-status is-${esc(r.status)}">${esc(statusLabel(r.status))}</span></h3>
      <p class="muted">${r.mode === "mufrak" ? `مفرق · ل.س${r.rate ? ` · صرف ${esc(ctx.money(r.rate, "mufrak"))}` : ""}` : "جملة · دولار"} · ${r.payMethod === "cash" ? "نقدي" : "أجل"}${r.note ? ` · ${esc(r.note)}` : ""}</p>
      <div class="inv-table-wrap"><table class="inv-table spr-table">
        <thead><tr><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>الإفرادي ${sym}</th><th>الإجمالي ${sym}</th></tr></thead>
        <tbody>${linesHtml}</tbody>
      </table></div>
      <div class="sales-summary">
        <div class="sales-summary-row"><span>الإجمالي</span><strong dir="ltr" data-spr-total>${showPrices ? esc(ctx.money(total, mode)) : "—"}</strong></div>
        ${canPrice ? `<div class="sales-summary-row"><span>حسم (${sym})</span><input class="inv-input-main sales-amount-input" data-spr-discount value="${esc(discount)}" inputmode="decimal" dir="ltr" type="text" placeholder="0"></div>` : Number(r.discount) > 0 ? `<div class="sales-summary-row"><span>حسم</span><strong dir="ltr">${esc(ctx.money(r.discount, mode))}</strong></div>` : ""}
        ${showPrices ? `<div class="sales-summary-row sales-summary-net"><span>الصافي</span><strong dir="ltr" data-spr-net>${esc(ctx.money(net, mode))}</strong></div>` : ""}
      </div>
      ${actions}
    </div>`;
  }

  function panel(ctx) {
    return `<section class="panel wide inv-panel spr-panel">
      <div class="sales-toolbar">
        <button type="button" class="sales-mode-btn active" data-action="spr-close">↩ رجوع للفاتورة الحالية</button>
        <div class="sales-mode-switch" role="group" aria-label="عرض">
          <button type="button" class="sales-mode-btn ${view.filter === "active" ? "active" : ""}" data-spr-filter="active">المفتوحة</button>
          <button type="button" class="sales-mode-btn ${view.filter === "all" ? "active" : ""}" data-spr-filter="all">الكل</button>
        </div>
        <button type="button" class="sales-mode-btn" data-action="spr-refresh" ${view.loading ? "disabled" : ""}>⟳ تحديث</button>
      </div>
      <div class="spr-layout">
        <div class="spr-col-list">${listHtml(ctx)}</div>
        <div class="spr-col-detail">${detailHtml(ctx)}</div>
      </div>
    </section>`;
  }

  function refreshDetailTotals(ctx, root) {
    const r = selected();
    if (!r) return;
    const prices = view.prices[r.id] || [];
    let total = 0;
    r.lines.forEach((l, i) => {
      const lt = Number(l.qty) * ctx.toNumber(prices[i]);
      total += lt;
      const cell = root.querySelector(`[data-spr-linetotal="${i}"]`);
      if (cell) cell.textContent = ctx.money(lt, r.mode);
    });
    const net = total - ctx.toNumber(view.discount[r.id] || "");
    const tEl = root.querySelector("[data-spr-total]");
    if (tEl) tEl.textContent = ctx.money(total, r.mode);
    const nEl = root.querySelector("[data-spr-net]");
    if (nEl) nEl.textContent = ctx.money(net, r.mode);
  }

  async function act(ctx, fn, successText) {
    if (view.busy) return;
    view.busy = true;
    ctx.render();
    try {
      await fn();
      ctx.setNotice("success", successText);
      await load(ctx, { quiet: true });
    } catch (error) {
      ctx.setNotice("error", errorMessage(error) || ctx.safeErrorMessage(error));
      if (/version_conflict/.test(String(error?.message || ""))) await load(ctx, { quiet: true });
    } finally {
      view.busy = false;
      ctx.render();
    }
  }

  function bind(root, ctx) {
    root.querySelector("[data-action='spr-open']")?.addEventListener("click", () => {
      view.open = true;
      load(ctx);
    });
    if (!view.open) return;
    root.querySelector("[data-action='spr-close']")?.addEventListener("click", () => {
      view.open = false;
      ctx.render();
    });
    root.querySelector("[data-action='spr-refresh']")?.addEventListener("click", () => load(ctx));
    root.querySelectorAll("[data-spr-filter]").forEach((btn) => btn.addEventListener("click", () => {
      view.filter = btn.dataset.sprFilter === "all" ? "all" : "active";
      ctx.render();
    }));
    root.querySelectorAll("[data-spr-select]").forEach((btn) => btn.addEventListener("click", () => {
      view.selectedId = Number(btn.dataset.sprSelect);
      ctx.render();
      // على الشاشة الضيقة التفاصيل تحت القائمة: انقل العين إليها كي لا يبدو الضغط بلا أثر.
      if (window.matchMedia?.("(max-width: 900px)").matches) {
        document.querySelector(".spr-detail")?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }));
    root.querySelectorAll("[data-spr-price]").forEach((input) => input.addEventListener("input", () => {
      const r = selected();
      if (!r) return;
      view.prices[r.id][Number(input.dataset.sprPrice)] = input.value;
      refreshDetailTotals(ctx, root);
    }));
    root.querySelector("[data-spr-discount]")?.addEventListener("input", (e) => {
      const r = selected();
      if (!r) return;
      view.discount[r.id] = e.target.value;
      refreshDetailTotals(ctx, root);
    });
    root.querySelector("[data-spr-billno]")?.addEventListener("input", (e) => {
      const r = selected();
      if (r) view.billNo[r.id] = e.target.value;
    });
    root.querySelector("[data-action='spr-price']")?.addEventListener("click", () => {
      const r = selected();
      if (!r) return;
      const prices = (view.prices[r.id] || []).map((p) => ctx.toNumber(p));
      if (prices.some((p) => !(p > 0))) {
        ctx.setNotice("error", ERROR_MESSAGES.line_price_required);
        ctx.render();
        return;
      }
      act(ctx, async () => {
        await ctx.dataStore.priceSalesPriceRequest(r.id, r.version, prices, ctx.toNumber(view.discount[r.id] || ""));
        delete view.prices[r.id];
        delete view.discount[r.id];
      }, `تم اعتماد تسعير الفاتورة #${r.id} — صارت «مسعّرة» عند المحاسب.`);
    });
    root.querySelector("[data-action='spr-entered']")?.addEventListener("click", () => {
      const r = selected();
      if (!r) return;
      const no = String(view.billNo[r.id] || "").trim();
      if (!no) {
        ctx.setNotice("error", ERROR_MESSAGES.ameen_bill_no_required);
        ctx.render();
        return;
      }
      act(ctx, () => ctx.dataStore.markSalesPriceRequestEntered(r.id, r.version, no),
        `سُجّلت الفاتورة #${r.id} كمُدخلة في الأمين برقم ${no}.`);
    });
    root.querySelector("[data-action='spr-cancel']")?.addEventListener("click", () => {
      const r = selected();
      if (!r) return;
      act(ctx, () => ctx.dataStore.cancelSalesPriceRequest(r.id, r.version, ""), `أُلغيت الفاتورة #${r.id}.`);
    });
  }

  // إرسال فاتورة المحاسب من نموذج «فاتورة مبيعات». payload مبني في app.js من الأسطر المحلولة.
  async function submit(ctx, payload) {
    try {
      const result = await ctx.dataStore.submitSalesPriceRequest(payload);
      view.attempted = false; // القائمة تُحدَّث في الرسم التالي لتشمل الطلب الجديد
      return result;
    } catch (error) {
      throw new Error(errorMessage(error) || ctx.safeErrorMessage(error));
    }
  }

  window.OzkSalesPriceRequests = {
    needsOwnerPricing,
    statusLabel,
    stockCheck,
    errorMessage,
    isOpen: () => view.open,
    close: () => { view.open = false; },
    // يُستدعى بعد setRoute("sales") (الذي يغلق اللوحة) — يفتحها ويحمّل القائمة طازجة.
    // وإن كان تحميل طازج جارياً أصلاً (أول دخول للصفحة يطلقه ensureLoaded) لا نطلق ثانياً.
    openPanel: (ctx) => { view.open = true; if (view.loading) ctx.render(); else load(ctx); },
    navButton,
    ensureLoaded: (ctx) => { if (!view.attempted && !view.loading) load(ctx, { quiet: true }); },
    toolbarButton,
    panel,
    bind,
    submit
  };
})(window);
