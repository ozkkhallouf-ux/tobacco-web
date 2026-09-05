(function () {
  const ROUTE = "decision";
  const REFRESH_MS = 60000;
  let refreshTimer = null;
  let refreshBusy = false;
  let lastRefreshAt = null;
  let lastRefreshState = "idle";

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[char]));
  const num = (value) => {
    const n = Number(String(value ?? 0).replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  const hasNumber = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(String(value).replace(/,/g, "")));
  const money = (value) => `${Math.abs(num(value)).toLocaleString("en-US", { maximumFractionDigits: 0 })} $`;

  function balanceItems() {
    try { if (typeof latestCustomerBalanceItems === "function") return latestCustomerBalanceItems() || []; } catch {}
    const reports = Array.isArray(state?.customerBalanceReports) ? state.customerBalanceReports : [];
    return Array.isArray(reports[0]?.items) ? reports[0].items : [];
  }

  const customerKey = (row) => String(row?.customerKey || row?.customer_key || row?.key || row?.customerGuid || row?.customer_guid || row?.customerAccountGuid || row?.customer_account_guid || row?.guid || row?.name || "");
  const customerName = (row) => String(row?.name || row?.customerName || row?.customer_name || "زبون");
  const customerBalance = (row) => num(row?.balance ?? row?.debit ?? row?.amount ?? row?.remaining ?? 0);

  // المعرّف الصفري الذي يكتبه الأمين بدل NULL ليس معرّفاً.
  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  const rowGuid = (row) => {
    const guid = String(row?.customerGuid || row?.customer_guid || "").trim().toLowerCase();
    return !guid || guid === ZERO_GUID ? "" : guid;
  };

  function creditLimitFor(row) {
    const key = customerKey(row);
    const name = customerName(row).trim().toLowerCase();
    const guid = rowGuid(row);
    const limits = Array.isArray(state?.customerCreditLimits) ? state.customerCreditLimits : [];
    // المعرّف أولاً — لا يتغيّر بإعادة تسمية الحساب في الأمين. والاحتياط بالاسم
    // مقصور على حدود بلا معرّف حين يحمل الزبون معرّفاً، كي لا يرث حسابٌ حدَّ
    // حسابٍ آخر يطابقه اسماً.
    const nameFallbackOk = (x) => !guid || !rowGuid(x);
    const match = (guid ? limits.find((x) => rowGuid(x) === guid) : null)
      || limits.find((x) => nameFallbackOk(x) && String(x.customerKey || x.customer_key || "") === key)
      || limits.find((x) => nameFallbackOk(x) && String(x.customerName || x.customer_name || "").trim().toLowerCase() === name);
    const approvedLimit = num(match?.creditLimit ?? match?.credit_limit ?? 0);
    if (approvedLimit > 0) {
      return { amount: approvedLimit, source: "approved", updatedAt: match?.updatedAt || match?.updated_at || null };
    }
    const ameenLimit = num(row?.creditLimit ?? row?.credit_limit ?? 0);
    if (ameenLimit > 0) return { amount: ameenLimit, source: "ameen", updatedAt: null };
    return { amount: 0, source: "missing", updatedAt: null };
  }

  function customerRiskRows() {
    const order = { red: 0, orange: 1, unknown: 2, yellow: 3, green: 4 };
    return balanceItems().map((row) => {
      const balance = Math.max(0, customerBalance(row));
      const credit = creditLimitFor(row);
      const limit = credit.amount;
      const ratio = limit > 0 ? balance / limit : null;
      const overBy = ratio !== null ? Math.max(0, balance - limit) : null;
      const available = ratio !== null ? Math.max(0, limit - balance) : null;
      let level = "unknown";
      if (ratio !== null && ratio >= 1) level = "red";
      else if (ratio !== null && ratio >= 0.9) level = "orange";
      else if (ratio !== null && ratio >= 0.75) level = "yellow";
      else if (ratio !== null) level = "green";
      return { name: customerName(row), balance, limit, ratio, overBy, available, level, limitSource: credit.source };
    }).filter((row) => row.balance > 0).sort((a, b) => order[a.level] - order[b.level] || (b.ratio ?? -1) - (a.ratio ?? -1) || b.balance - a.balance);
  }

  function collectionFacts(risks) {
    return {
      totalReceivables: risks.reduce((sum, row) => sum + row.balance, 0),
      overLimitTotal: risks.reduce((sum, row) => sum + (row.overBy || 0), 0),
      missingLimitCount: risks.filter((row) => row.level === "unknown").length
    };
  }

  function itemSnapshotRows() {
    const candidates = [state?.ameenItemSnapshot, state?.ameenItemSnapshots, state?.itemSnapshots, state?.purchaseItemSnapshot];
    return candidates.find(Array.isArray) || [];
  }

  function velocityFor(item) {
    const direct = item.unitsSold30d ?? item.units_sold_30d ?? item.qtySold30d ?? item.qty_sold_30d;
    if (hasNumber(direct)) return num(direct);
    const key = String(item.itemKey || item.item_key || item.itemGuid || item.item_guid || "");
    const name = String(item.itemName || item.item_name || "").trim().toLowerCase();
    const snapshot = itemSnapshotRows().find((row) => String(row.itemKey || row.item_key || row.itemGuid || row.item_guid || "") === key)
      || itemSnapshotRows().find((row) => String(row.itemName || row.item_name || "").trim().toLowerCase() === name);
    const value = snapshot?.unitsSold30d ?? snapshot?.units_sold_30d ?? snapshot?.qtySold30d ?? snapshot?.qty_sold_30d;
    return hasNumber(value) ? num(value) : null;
  }

  function purchaseSignals() {
    return (Array.isArray(state?.approvedPriceItems) ? state.approvedPriceItems : []).map((item) => {
      const stock = Math.max(0, num(item.stockQty ?? item.stock_qty ?? 0));
      const sold30d = velocityFor(item);
      const status = String(item.stockStatus || item.stock_status || "").toLowerCase();
      let score = 20;
      let basis = "stock_only";
      let daysCover = null;

      if (sold30d !== null) {
        basis = "sales_velocity";
        if (sold30d > 0) daysCover = stock / (sold30d / 30);
        if (sold30d <= 0) score = stock > 0 ? 5 : 15;
        else if (stock <= 0 || /out|نفد|غير متوفر/.test(status)) score = 100;
        else if (daysCover < 3) score = 95;
        else if (daysCover < 7) score = 85;
        else if (daysCover < 14) score = 70;
        else if (daysCover < 30) score = 45;
        else score = 20;
      } else {
        if (stock <= 0 || /out|نفد|غير متوفر/.test(status)) score = 70;
        else if (stock <= 3) score = 55;
        else if (stock <= 7) score = 40;
        else score = 20;
      }
      return { name: item.itemName || item.item_name || "صنف", stock, sold30d, daysCover, score, basis };
    }).sort((a, b) => b.score - a.score).slice(0, 8);
  }

  function invoiceRemaining(invoice) {
    const explicit = invoice.remaining ?? invoice.remainingTotal ?? invoice.remaining_total;
    if (hasNumber(explicit)) return Math.max(0, num(explicit));
    const total = invoice.total ?? invoice.grandTotal ?? invoice.grand_total;
    const paid = invoice.paidAmount ?? invoice.paid_amount ?? invoice.paidTotal ?? invoice.paid_total ?? invoice.paymentAmount ?? invoice.payment_amount;
    if (hasNumber(total) && hasNumber(paid)) return Math.max(0, num(total) - num(paid));
    return null;
  }

  function supplierSignals() {
    const groups = Array.isArray(state?.poAmeenReport?.items) ? state.poAmeenReport.items : [];
    return groups.map((supplier) => {
      const invoices = Array.isArray(supplier.invoices) ? supplier.invoices : [];
      const known = invoices.map(invoiceRemaining).filter((value) => value !== null);
      return {
        name: supplier.name || "مورد",
        total: known.reduce((sum, value) => sum + value, 0),
        invoiceCount: invoices.length,
        knownCount: known.length,
        complete: invoices.length > 0 && known.length === invoices.length
      };
    }).filter((row) => row.invoiceCount > 0).sort((a, b) => {
      if (a.complete !== b.complete) return a.complete ? -1 : 1;
      return b.total - a.total;
    }).slice(0, 8);
  }

  function riskBadge(level) {
    const map = { red: ["متجاوز للحد", "danger"], orange: ["قريب من الحد", "warning"], unknown: ["حد غير محدد", "pending"], yellow: ["مراقبة", "pending"], green: ["ضمن الحد", "success"] };
    const [label, cls] = map[level] || map.green;
    return `<span class="status-chip decision-${cls}">${label}</span>`;
  }

  function liveLabel() {
    if (!navigator.onLine) return "غير متصل — عرض آخر بيانات محفوظة";
    if (lastRefreshState === "error") return "تعذر التحديث — ستتم إعادة المحاولة تلقائياً";
    if (lastRefreshState === "partial") return "تحديث جزئي — بعض المصادر لم تستجب";
    if (lastRefreshAt) return `آخر تحديث ناجح · ${lastRefreshAt.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}`;
    return "تحديث تلقائي كل دقيقة";
  }

  function liveClass() {
    if (!navigator.onLine || lastRefreshState === "error") return "offline";
    if (lastRefreshState === "partial") return "degraded";
    return "";
  }

  function decisionPage() {
    if (!state?.session) return shell(`<section class="panel"><h2>قرار اليوم</h2><p class="muted">سجّل الدخول أولاً لعرض قرارات السيولة والتحصيل والموردين.</p></section>`);
    if (!window.ozkCanAccessRoute?.(ROUTE)) return shell(`<section class="panel"><h2>غير متاح</h2><p class="muted">قرار اليوم متاح لحساب المالك فقط.</p></section>`);
    const risks = customerRiskRows();
    const facts = collectionFacts(risks);
    const suppliers = supplierSignals();
    const purchase = purchaseSignals();
    const redCount = risks.filter((row) => row.level === "red").length;
    const urgentBuy = purchase.filter((row) => row.score >= 85).length;

    const collectionRows = risks.slice(0, 10).map((row) => {
      const source = row.limitSource === "approved" ? "معتمد داخليًا" : row.limitSource === "ameen" ? "معتمد في أمين" : "";
      const action = row.level === "unknown"
        ? "تحديد حد معتمد قبل أي بيع آجل"
        : row.level === "red"
          ? `تحصيل ${money(row.overBy)} على الأقل قبل زيادة الآجل`
          : row.level === "orange"
            ? "متابعة التحصيل قبل بلوغ الحد"
            : `متاح ضمن الحد: ${money(row.available)}`;
      return `<tr><td><strong>${escape(row.name)}</strong></td><td dir="ltr">${money(row.balance)}</td><td dir="ltr">${row.limit > 0 ? `${money(row.limit)}<small class="muted" style="display:block">${escape(source)}</small>` : "غير محدد"}</td><td>${riskBadge(row.level)}</td><td>${action}</td></tr>`;
    }).join("");
    const supplierRows = suppliers.map((row, index) => `<tr><td>${index + 1}</td><td><strong>${escape(row.name)}</strong></td><td dir="ltr">${row.complete ? money(row.total) : "غير متاح"}</td><td>${escape(row.knownCount)}/${escape(row.invoiceCount)}</td><td>${row.complete ? (index < 2 ? '<span class="status-chip decision-danger">أولوية عالية</span>' : '<span class="status-chip decision-pending">مراجعة</span>') : '<span class="status-chip decision-warning">بيانات ناقصة</span>'}</td></tr>`).join("");
    const purchaseRows = purchase.map((row) => `<tr><td><strong>${escape(row.name)}</strong></td><td dir="ltr">${escape(row.stock)}</td><td>${row.sold30d === null ? "—" : escape(row.sold30d)}</td><td><strong>${escape(row.score)}</strong>/100</td><td>${row.basis === "sales_velocity" ? (row.score >= 85 ? '<span class="status-chip decision-danger">عاجل</span>' : row.score >= 65 ? '<span class="status-chip decision-warning">قريب</span>' : '<span class="status-chip decision-success">مستقر</span>') : '<span class="status-chip decision-pending">تقدير احتياطي</span>'}</td></tr>`).join("");

    return shell(`
      <section class="panel wide decision-page">
        <div class="panel-title-row"><div><h2 style="margin:0">📌 قرار اليوم</h2><p class="muted" style="margin:4px 0 0">ملخص تنفيذي مبني على آخر بيانات متاحة.</p></div><span class="decision-live ${liveClass()}"><i class="decision-live-dot"></i>${escape(liveLabel())}</span></div>
        <p class="decision-note"><strong>أساس الحساب:</strong> الرصيد المستحق = مجموع القيود المدينة (الفواتير والسحوبات) ناقص القيود الدائنة (القبض والدفعات) من حساب الزبون في أمين. الحد الائتماني سقف معتمد مستقل، ولا يتم تخمينه من حجم الرصيد أو تاريخ المبيعات.</p>
        <div class="decision-kpis">
          <article class="decision-kpi"><small>إجمالي الرصيد المستحق</small><strong dir="ltr">${money(facts.totalReceivables)}</strong><span>فواتير وسحوبات ناقص القبض والدفعات</span></article>
          <article class="decision-kpi"><small>التجاوز المؤكد للحدود</small><strong dir="ltr">${money(facts.overLimitTotal)}</strong><span>فقط للزبائن ذوي حد معتمد</span></article>
          <article class="decision-kpi"><small>حدود ائتمانية غير محددة</small><strong>${facts.missingLimitCount}</strong><span>لا تُصنّف خطرًا بالتخمين</span></article>
          <article class="decision-kpi"><small>أصناف شراء عاجل</small><strong>${urgentBuy}</strong><span>عند توفر سرعة المبيع تكون هي أساس التقييم</span></article>
        </div>
      </section>
      <section class="panel wide decision-section"><div class="panel-title-row"><div><h2 style="margin:0">💵 التحصيل والخطر الائتماني</h2></div><button class="button secondary" type="button" data-route="balances">فتح أرصدة الزبائن</button></div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>الزبون</th><th>الرصيد</th><th>الحد المعتمد</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>${collectionRows || '<tr><td colspan="5" class="muted">لا توجد أرصدة مدينة متاحة حالياً.</td></tr>'}</tbody></table></div></section>
      <section class="panel wide decision-section"><div class="panel-title-row"><div><h2 style="margin:0">🚚 أولوية الموردين</h2></div><button class="button secondary" type="button" data-route="purchases">فتح المشتريات</button></div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>#</th><th>المورد</th><th>الالتزام المؤكد</th><th>بيانات الفواتير</th><th>الأولوية</th></tr></thead><tbody>${supplierRows || '<tr><td colspan="5" class="muted">لا تتوفر التزامات موردين كافية للحساب حالياً.</td></tr>'}</tbody></table></div></section>
      <section class="panel wide decision-section"><div class="panel-title-row"><div><h2 style="margin:0">📦 أولوية الأصناف</h2></div><button class="button secondary" type="button" data-route="warehouses">فتح المستودعات</button></div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>الصنف</th><th>المخزون</th><th>مبيع 30 يوم</th><th>الأولوية</th><th>الحالة</th></tr></thead><tbody>${purchaseRows || '<tr><td colspan="5" class="muted">لا توجد أصناف معتمدة متاحة حالياً.</td></tr>'}</tbody></table></div><p class="decision-note">إذا لم تتوفر سرعة المبيع يظهر الصنف كـ «تقدير احتياطي» ولا يُعامل كتوصية شراء نهائية. التحديث يعمل تلقائياً كل دقيقة أثناء فتح الصفحة.</p></section>
    `);
  }

  function addDecisionNav() {
    if (!window.ozkCanAccessRoute?.(ROUTE)) {
      document.querySelectorAll('[data-route="decision"]').forEach((node) => node.remove());
      return;
    }
    if (document.querySelector('aside .sidebar nav [data-route="decision"], aside nav [data-route="decision"]')) return;
    const nav = document.querySelector("aside .sidebar nav, aside nav, .sidebar nav");
    if (!nav) return;
    const template = nav.querySelector("[data-route]");
    const button = document.createElement(template?.tagName === "A" ? "a" : "button");
    button.className = template?.className || "nav-link";
    button.textContent = "📌 قرار اليوم";
    button.dataset.route = ROUTE;
    if (button.tagName === "A") button.href = "?route=decision";
    button.addEventListener("click", (event) => { event.preventDefault(); setRoute(ROUTE); });
    nav.insertBefore(button, nav.firstChild);
  }

  async function refreshDecisionData() {
    if (refreshBusy || state?.route !== ROUTE || !state?.session) return;
    if (!navigator.onLine) { lastRefreshState = "offline"; if (state.route === ROUTE) render(); return; }
    refreshBusy = true;
    try {
      const jobs = [];
      if (window.tobaccoData?.listCustomerBalanceReports) jobs.push(window.tobaccoData.listCustomerBalanceReports().then((value) => { state.customerBalanceReports = value || []; }));
      if (window.tobaccoData?.listCustomerCreditLimits) jobs.push(window.tobaccoData.listCustomerCreditLimits().then((value) => { state.customerCreditLimits = value || []; }));
      if (window.tobaccoData?.listApprovedPriceItems) jobs.push(window.tobaccoData.listApprovedPriceItems().then((value) => { state.approvedPriceItems = value || []; }));
      if (window.tobaccoData?.getPurchaseInvoicesAmeenReport) jobs.push(window.tobaccoData.getPurchaseInvoicesAmeenReport().then((value) => { state.poAmeenReport = value || null; }));
      if (window.tobaccoData?.listAmeenItemSnapshot) jobs.push(window.tobaccoData.listAmeenItemSnapshot().then((value) => { state.ameenItemSnapshot = value || []; }));
      if (!jobs.length) { lastRefreshState = "error"; if (state.route === ROUTE) render(); return; }
      const results = await Promise.allSettled(jobs);
      const fulfilled = results.filter((result) => result.status === "fulfilled").length;
      const rejected = results.length - fulfilled;
      if (fulfilled > 0) lastRefreshAt = new Date();
      lastRefreshState = fulfilled === 0 ? "error" : rejected > 0 ? "partial" : "ok";
      if (state.route === ROUTE) render();
    } catch (error) {
      lastRefreshState = "error";
      console.error("[OZK Decision Refresh]", error);
      if (state.route === ROUTE) render();
    } finally { refreshBusy = false; }
  }

  function syncRefreshTimer() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (state?.route === ROUTE && state?.session && window.ozkCanAccessRoute?.(ROUTE)) {
      refreshTimer = setInterval(refreshDecisionData, REFRESH_MS);
      if (!lastRefreshAt && !refreshBusy) queueMicrotask(refreshDecisionData);
    }
  }

  try {
    allowedRoutes.add(ROUTE);
    const requestedRoute = new URLSearchParams(window.location.search).get("route");
    if (requestedRoute === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) state.route = ROUTE;
    const baseRender = render;
    render = function decisionAwareRender() {
      if (state.route === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) {
        app.innerHTML = decisionPage();
        app.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); setRoute(button.dataset.route); }));
        addDecisionNav();
        syncRefreshTimer();
        return;
      }
      baseRender();
      addDecisionNav();
      syncRefreshTimer();
    };
    window.addEventListener("online", () => { lastRefreshState = "idle"; if (state?.route === ROUTE) refreshDecisionData(); });
    window.addEventListener("offline", () => { lastRefreshState = "offline"; if (state?.route === ROUTE) render(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state?.route === ROUTE) refreshDecisionData(); });
    render();
    if (state?.route === ROUTE) setTimeout(refreshDecisionData, 0);
  } catch (error) { console.error("[OZK Decision Engine]", error); }
})();
