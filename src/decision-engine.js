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

  function scoring() {
    return (typeof window !== "undefined" && window.ozkDecisionScoring) || null;
  }

  function snapshotRows() {
    const candidates = [state?.ameenItemSnapshot, state?.ameenItemSnapshots, state?.itemSnapshots, state?.poItemSnapshots];
    return candidates.find(Array.isArray) || [];
  }

  // حداثة اللقطة تُحسب مرة واحدة وتُمرَّر للعرض: التوصية لا تُقدَّم كأنها حديثة
  // حين يكون مصدرها متوقفاً — وهو ما أخفى تجمّد ستة أيام دون أي إشارة.
  function snapshotHealth() {
    const api = scoring();
    if (!api) return { generatedAt: null, ageHours: null, state: "missing", trusted: false, reason: "نواة التقييم غير محمّلة." };
    return api.snapshotFreshness(snapshotRows(), { now: new Date() });
  }

  function collectionModel() {
    const api = scoring();
    if (!api) return { customers: [], totalReceivables: 0, overLimitTotal: 0, missingLimitCount: 0, missingLimitReceivables: 0, criticalCount: 0 };
    return api.scoreCustomers({
      balances: balanceItems(),
      creditLimits: Array.isArray(state?.customerCreditLimits) ? state.customerCreditLimits : [],
      now: new Date()
    });
  }

  function purchaseModel() {
    const api = scoring();
    if (!api) return { items: [], duplicateCount: 0, unidentifiedCount: 0, nameMatchedCount: 0, valueScaleUsed: false, urgentCount: 0, dormantCount: 0 };
    return api.scoreItems({
      items: Array.isArray(state?.approvedPriceItems) ? state.approvedPriceItems : [],
      snapshots: snapshotRows(),
      now: new Date()
    });
  }

  function invoiceRemaining(invoice) {
    const explicit = invoice.remaining ?? invoice.remainingTotal ?? invoice.remaining_total;
    if (hasNumber(explicit)) return Math.max(0, num(explicit));
    const total = invoice.total ?? invoice.grandTotal ?? invoice.grand_total;
    const paid = invoice.paidAmount ?? invoice.paid_amount ?? invoice.paidTotal ?? invoice.paid_total ?? invoice.paymentAmount ?? invoice.payment_amount;
    if (hasNumber(total) && hasNumber(paid)) return Math.max(0, num(total) - num(paid));
    return null;
  }

  // التزامات الموردين من تقرير فواتير الشراء — مصدر احتياطي يبقى معروضاً حين
  // يكون جدول supplier_obligations فارغاً، بدل أن يُمحى القسم بالكامل.
  function purchaseReportObligations() {
    const groups = Array.isArray(state?.poAmeenReport?.items) ? state.poAmeenReport.items : [];
    return groups.map((supplier) => {
      const invoices = Array.isArray(supplier.invoices) ? supplier.invoices : [];
      const known = invoices.map(invoiceRemaining).filter((value) => value !== null);
      return {
        supplierName: supplier.name || "مورد",
        supplierGuid: supplier.guid || supplier.supplierGuid || supplier.supplier_guid || "",
        amountDue: known.reduce((sum, value) => sum + value, 0),
        currency: "USD",
        invoiceCount: invoices.length,
        knownCount: known.length,
        complete: invoices.length > 0 && known.length === invoices.length
      };
    }).filter((row) => row.invoiceCount > 0);
  }

  function supplierModel(purchase) {
    const api = scoring();
    if (!api) return { suppliers: [], obligationCount: 0, linkedSupplierCount: 0 };
    const live = Array.isArray(window.ozkSupplierObligations) ? window.ozkSupplierObligations : [];
    // الالتزام المالي يُقرأ من الجدول المخصّص حين توفّر، وإلا من تقرير الفواتير.
    // في كلتا الحالتين لا يدخل ترتيب أولوية الشراء.
    const obligations = live.length ? live : purchaseReportObligations().filter((row) => row.complete);
    return api.scoreSuppliers({
      items: purchase.items,
      obligations,
      now: new Date()
    });
  }

  function riskBadge(level) {
    const map = {
      critical: ["خطر عالٍ", "danger"],
      watch: ["متابعة", "warning"],
      normal: ["ضمن المتابعة", "success"]
    };
    const [label, cls] = map[level] || map.normal;
    return `<span class="status-chip decision-${cls}">${label}</span>`;
  }

  function purchaseBadge(priority) {
    const map = {
      urgent: ["عاجل", "danger"],
      soon: ["قريب", "warning"],
      steady: ["مستقر", "success"],
      dormant: ["راكد / طلب ضعيف", "pending"],
      unknown: ["بلا حركة مسجّلة", "pending"]
    };
    const [label, cls] = map[priority] || map.unknown;
    return `<span class="status-chip decision-${cls}">${label}</span>`;
  }

  function supplierBadge(priority) {
    const map = {
      urgent: ["أولوية عالية", "danger"],
      soon: ["مراجعة اليوم", "warning"],
      watch: ["متابعة", "pending"]
    };
    const [label, cls] = map[priority] || map.watch;
    return `<span class="status-chip decision-${cls}">${label}</span>`;
  }

  const dash = (value, digits) => (value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString("en-US", { maximumFractionDigits: digits ?? 0 }));

  function coverageLabel(days) {
    if (days === null || days === undefined) return "—";
    if (!Number.isFinite(days)) return "بلا حركة";
    if (days < 1) return "أقل من يوم";
    return `${Math.round(days)} يوم`;
  }

  function suggestedLabel(suggested) {
    if (!suggested || !(suggested.units > 0)) return "—";
    if (suggested.cartons) return `${dash(suggested.cartons)} كرتونة <small class="muted">(${dash(suggested.units)} وحدة)</small>`;
    return `${dash(suggested.units)} وحدة`;
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

  function snapshotBanner(health) {
    if (!health || health.trusted) return "";
    const when = health.generatedAt
      ? new Date(health.generatedAt).toLocaleString("ar", { dateStyle: "medium", timeStyle: "short" })
      : "غير معروف";
    const age = health.ageHours === null ? "" : ` (قبل ${Math.floor(health.ageHours)} ساعة)`;
    return `<p class="decision-alert" role="status"><strong>⚠️ بيانات أولوية الشراء قديمة</strong> — آخر تحديث للقطة الأصناف: ${escape(when)}${escape(age)}. الدرجات أدناه محسوبة من مخزون وحركة غير حديثين ولا تُعتمد أمراً بالشراء حتى تُجدَّد اللقطة.</p>`;
  }

  function decisionPage() {
    if (!state?.session) return shell(`<section class="panel"><h2>قرار اليوم</h2><p class="muted">سجّل الدخول أولاً لعرض قرارات السيولة والتحصيل والموردين.</p></section>`);
    if (!window.ozkCanAccessRoute?.(ROUTE)) return shell(`<section class="panel"><h2>غير متاح</h2><p class="muted">قرار اليوم متاح لحساب المالك فقط.</p></section>`);

    const collection = collectionModel();
    const purchase = purchaseModel();
    const suppliers = supplierModel(purchase);
    const health = snapshotHealth();
    // عند قِدَم اللقطة تبقى الأرقام معروضة للتشخيص، لكن عدّاد «شراء عاجل» لا
    // يدّعي رقماً موثوقاً — الادعاء بالحداثة هو ما أخفى العطل ستة أيام.
    const urgentBuy = health.trusted ? purchase.urgentCount : null;

    const collectionRows = collection.customers.slice(0, 12).map((row) => {
      const source = row.limitSource === "approved" ? "معتمد داخليًا" : row.limitSource === "ameen" ? "معتمد في أمين" : "بلا حد معتمد";
      return `<tr>
        <td><strong>${escape(row.name)}</strong></td>
        <td dir="ltr">${money(row.balance)}</td>
        <td dir="ltr">${row.limit > 0 ? `${money(row.limit)}<small class="muted" style="display:block">${escape(source)}</small>` : '<span class="muted">غير محدد</span>'}</td>
        <td dir="ltr">${row.lastPaymentDate ? escape(row.lastPaymentDate) : "—"}</td>
        <td dir="ltr">${row.daysSincePayment === null ? "—" : dash(Math.round(row.daysSincePayment))}</td>
        <td dir="ltr"><strong>${escape(row.score)}</strong>/100</td>
        <td>${riskBadge(row.level)}</td>
        <td class="decision-reason">${escape(row.reason)}</td>
      </tr>`;
    }).join("");

    const supplierRows = suppliers.suppliers.slice(0, 10).map((row, index) => `<tr>
      <td>${index + 1}</td>
      <td><strong>${escape(row.name)}</strong></td>
      <td dir="ltr">${dash(row.urgentCount)}</td>
      <td dir="ltr">${dash(row.stockoutCount)}</td>
      <td dir="ltr">${Math.round(row.coverageGap * 100)}٪</td>
      <td dir="ltr">${(row.salesImportance * 100).toFixed(1)}٪</td>
      <td dir="ltr"><strong>${escape(row.score)}</strong>/100</td>
      <td>${supplierBadge(row.priority)}</td>
      <td dir="ltr">${row.obligationAmount === null ? '<span class="muted">—</span>' : money(row.obligationAmount)}</td>
    </tr>`).join("");

    const purchaseRows = purchase.items.slice(0, 12).map((row) => `<tr>
      <td><strong>${escape(row.name)}</strong></td>
      <td dir="ltr">${dash(row.stock)}</td>
      <td dir="ltr">${dash(row.sold30d)}</td>
      <td dir="ltr">${row.dailySales === null ? "—" : escape(row.dailySales >= 10 ? String(Math.round(row.dailySales)) : row.dailySales.toFixed(2))}</td>
      <td dir="ltr">${escape(coverageLabel(row.coverageDays))}</td>
      <td dir="ltr">${row.lastSaleDate ? escape(row.lastSaleDate) : "—"}</td>
      <td dir="ltr"><strong>${escape(row.score)}</strong>/100</td>
      <td>${purchaseBadge(row.priority)}</td>
      <td dir="ltr">${suggestedLabel(row.suggested)}</td>
      <td class="decision-reason">${escape(row.reason)}</td>
    </tr>`).join("");

    const dedupeNote = purchase.duplicateCount > 0
      ? `<p class="decision-note">دُمج ${escape(purchase.duplicateCount)} سجلاً مكرراً بالمعرّف قبل التقييم، فلا يظهر الصنف الواحد مرتين. التكرار في المصدر لم يُحذف — يحتاج تنظيفاً منفصلاً بموافقتك.</p>`
      : "";
    const nameMatchNote = purchase.nameMatchedCount > 0
      ? `<p class="decision-note">${escape(purchase.nameMatchedCount)} صنفاً بلا معرّف مستقر ويُطابَق بالاسم — هوية هشّة أمام إعادة التسمية، تستحق مراجعة.</p>`
      : "";

    return shell(`
      <section class="panel wide decision-page">
        <div class="panel-title-row"><div><h2 style="margin:0">📌 قرار اليوم</h2><p class="muted" style="margin:4px 0 0">ملخص تنفيذي مبني على آخر بيانات متاحة.</p></div><span class="decision-live ${liveClass()}"><i class="decision-live-dot"></i>${escape(liveLabel())}</span></div>
        ${snapshotBanner(health)}
        <p class="decision-note"><strong>أساس الحساب:</strong> الرصيد المستحق = مجموع القيود المدينة ناقص القيود الدائنة من حساب الزبون في أمين. درجة خطر التحصيل تجمع حجم الرصيد وتأخّر السداد واستخدام الحد وانتظام الدفعات — والحد الائتماني أحد عواملها لا العامل الوحيد، ولا يُخمَّن حين يغيب. أولوية شراء الصنف تقوم على أيام التغطية وسرعة الدوران؛ النفاد وحده لا يمنح استعجالاً لصنف ضعيف الطلب.</p>
        <div class="decision-kpis">
          <article class="decision-kpi"><small>إجمالي الرصيد المستحق</small><strong dir="ltr">${money(collection.totalReceivables)}</strong><span>فواتير وسحوبات ناقص القبض والدفعات</span></article>
          <article class="decision-kpi"><small>زبائن بخطر تحصيل عالٍ</small><strong>${escape(collection.criticalCount)}</strong><span>مرتّبون بالدرجة لا بالحد وحده</span></article>
          <article class="decision-kpi"><small>ذمم بلا حد معتمد</small><strong dir="ltr">${money(collection.missingLimitReceivables)}</strong><span>${escape(collection.missingLimitCount)} زبوناً — يظهرون في الترتيب ولا يُسقَطون</span></article>
          <article class="decision-kpi"><small>أصناف شراء عاجل</small><strong>${urgentBuy === null ? "—" : escape(urgentBuy)}</strong><span>${urgentBuy === null ? "معلّق حتى تُجدَّد اللقطة" : `و${escape(purchase.dormantCount)} صنفاً راكداً مستبعَداً`}</span></article>
        </div>
      </section>
      <section class="panel wide decision-section"><div class="panel-title-row"><div><h2 style="margin:0">💵 التحصيل والخطر الائتماني</h2></div><button class="button secondary" type="button" data-route="balances">فتح أرصدة الزبائن</button></div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>الزبون</th><th>الرصيد</th><th>الحد المعتمد</th><th>آخر دفعة</th><th>أيام بلا دفع</th><th>الدرجة</th><th>الحالة</th><th>السبب</th></tr></thead><tbody>${collectionRows || '<tr><td colspan="8" class="muted">لا توجد أرصدة مدينة متاحة حالياً.</td></tr>'}</tbody></table></div></section>
      <section class="panel wide decision-section"><div class="panel-title-row"><div><h2 style="margin:0">🚚 أولوية الموردين</h2></div><button class="button secondary" type="button" data-route="purchases">فتح المشتريات</button></div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>#</th><th>المورد</th><th>أصناف عاجلة</th><th>نافد</th><th>فجوة التغطية</th><th>وزن المبيعات</th><th>أولوية الشراء</th><th>الحالة</th><th>الالتزام المالي</th></tr></thead><tbody>${supplierRows || '<tr><td colspan="9" class="muted">لا تتوفر أصناف مرتبطة بمورد لحساب أولوية الشراء حالياً.</td></tr>'}</tbody></table></div><p class="decision-note">أولوية الشراء تُحسب من نواقص أصناف المورد وسرعة دورانها وفجوة تغطيتها — <strong>لا من رصيده المالي</strong>. الالتزام المالي عمود مستقل للعلم فقط، ومورد رصيده صفر قد تكون أولويته عالية.</p></section>
      <section class="panel wide decision-section"><div class="panel-title-row"><div><h2 style="margin:0">📦 أولوية الأصناف</h2></div><button class="button secondary" type="button" data-route="warehouses">فتح المستودعات</button></div><div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>الصنف</th><th>المخزون</th><th>مبيع 30 يوم</th><th>معدل يومي</th><th>التغطية</th><th>آخر بيع</th><th>الدرجة</th><th>الحالة</th><th>كمية مقترحة</th><th>السبب</th></tr></thead><tbody>${purchaseRows || '<tr><td colspan="10" class="muted">لا توجد أصناف معتمدة متاحة حالياً.</td></tr>'}</tbody></table></div><p class="decision-note">الكمية المقترحة قيمة مساعدة لبلوغ ${escape(window.ozkDecisionScoring?.TUNABLES?.PURCHASE_TARGET_COVERAGE_DAYS ?? 14)} يوم تغطية — وليست أمر شراء، ولا يُنشأ أي طلب تلقائياً.</p>${dedupeNote}${nameMatchNote}</section>
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
