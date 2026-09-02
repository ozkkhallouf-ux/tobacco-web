// ============================================================================
// واجهة «ذكاء الزبائن» — عرض فقط فوق مخرج src/customer-intelligence.js.
//
// لا حساب تجاري هنا إطلاقاً: كل رقم يظهر على الشاشة يأتي جاهزاً من طبقة الحساب
// الـdeterministic. هذه الطبقة تجلب وتعرض وترتّب وتبحث فقط، فلا يوجد مصدر ثانٍ
// للحقيقة يتباعد عن الأول.
//
// الوصول: مسار المالك فقط (`OWNER_ONLY_ROUTES` في src/app.js). بيانات الأرصدة
// وحدود الائتمان ومبيعات الزبائن محمية عند القاعدة بـ`is_staff()` وبسياسة
// `deny_inventory_counter_access`، والبوابة هنا تضيّق لا توسّع.
// ============================================================================
(function () {
  "use strict";

  const ROUTE = "customerIntel";
  const REFRESH_MS = 120000;

  let intel = null;
  let loading = false;
  let lastError = null;
  let lastUpdatedAt = null;
  let refreshTimer = null;

  const view = {
    search: "",
    segment: "all",
    sortKey: "riskScore",
    sortDir: "desc",
    selectedId: null,
    includeSuppliers: false
  };

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const money = (value, currency = "USD") => (isNumber(value) ? `${value.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${currency}` : "—");
  const percent = (value) => (isNumber(value) ? `${value > 0 ? "+" : ""}${value.toFixed(1)}%` : "—");
  const count = (value) => (isNumber(value) ? value.toLocaleString("en-US") : "—");
  const day = (value) => (value ? escape(value) : "—");

  const SEGMENT_LABELS = {
    vip: "زبون رئيسي (VIP)",
    regular: "منتظم",
    declining: "متراجع",
    inactive: "متوقف",
    new: "جديد",
    reactivated: "عاد للنشاط",
    at_risk_debt: "خطر مديونية",
    dormant: "بلا شراء هذه الفترة",
    insufficient_data: "بيانات غير كافية"
  };

  const FLAG_LABELS = {
    vip: "VIP",
    vip_ranking_unreliable: "عيّنة صغيرة لترتيب VIP",
    declining: "تراجع",
    growing: "نمو",
    inactive: "متوقف",
    at_risk_churn: "تأخّر عن نمطه",
    reactivated: "عاد للنشاط",
    new: "جديد",
    possibly_new: "ربما جديد",
    no_purchases_in_window: "بلا فواتير بالنافذة",
    insufficient_history: "تاريخ غير كافٍ",
    cadence_unknown: "نمط الشراء غير محسوب",
    returns_exceed_sales: "مرتجعاته تفوق مبيعاته",
    over_credit_limit: "تجاوز حد الائتمان",
    near_credit_limit: "قريب من حد الائتمان",
    credit_limit_unknown: "بلا حد ائتمان محدد",
    ambiguous_identity: "اسم ملتبس بين معرّفين",
    mixed_currency: "فواتير بأكثر من عملة",
    stale_data: "مصدر غير حديث",
    supplier_account: "حساب مورد"
  };

  const FLAG_TONE = {
    over_credit_limit: "danger",
    inactive: "danger",
    returns_exceed_sales: "danger",
    ambiguous_identity: "danger",
    mixed_currency: "danger",
    declining: "warn",
    near_credit_limit: "warn",
    at_risk_churn: "warn",
    stale_data: "warn",
    insufficient_history: "warn",
    cadence_unknown: "warn",
    credit_limit_unknown: "warn",
    vip: "good",
    growing: "good",
    reactivated: "good",
    new: "good"
  };

  const FILTERS = [
    { id: "all", label: "الكل" },
    { id: "vip", label: "VIP" },
    { id: "declining", label: "متراجعون" },
    { id: "inactive", label: "متوقفون" },
    { id: "reactivated", label: "عادوا للنشاط" },
    { id: "new", label: "جدد" },
    { id: "credit", label: "خطر ائتمان" },
    { id: "attention", label: "يحتاج متابعة" },
    { id: "insufficient", label: "بيانات غير كافية" }
  ];

  const COLUMNS = [
    { key: "customerName", label: "الزبون", type: "text" },
    { key: "primarySegment", label: "التصنيف", type: "text" },
    { key: "netSales30d", label: "مبيعات 30 يوم", type: "number" },
    { key: "netSalesPrevious30d", label: "الفترة السابقة", type: "number" },
    { key: "trendPercent", label: "التغير %", type: "number" },
    { key: "lastPurchaseAt", label: "آخر شراء", type: "text" },
    { key: "daysSinceLastPurchase", label: "أيام منذ آخر شراء", type: "number" },
    { key: "currentBalance", label: "الرصيد", type: "number" },
    { key: "creditUsagePercent", label: "الائتمان", type: "number" },
    { key: "flags", label: "التنبيهات", type: "none" }
  ];

  // --------------------------------------------------------------------------
  // جلب البيانات — نفس دوال الوصول القائمة، بلا استعلام جديد ولا مفتاح خدمة.
  // --------------------------------------------------------------------------
  async function loadIntel() {
    if (loading || !state?.session || !window.ozkCanAccessRoute?.(ROUTE)) return;
    loading = true;
    lastError = null;
    render();
    try {
      const data = window.tobaccoData || {};
      const engine = window.ozkCustomerIntelligence;
      if (!engine) throw new Error("طبقة ذكاء الزبائن غير محمّلة.");

      const [invoicesReport, balanceReports, movementsReport, creditLimits] = await Promise.all([
        data.getCustomerInvoicesReport ? data.getCustomerInvoicesReport() : null,
        data.listCustomerBalanceReports ? data.listCustomerBalanceReports() : [],
        data.getCustomerMovementsReport ? data.getCustomerMovementsReport() : null,
        data.listCustomerCreditLimits ? data.listCustomerCreditLimits() : []
      ]);

      intel = engine.build({
        invoicesReport,
        balancesReport: Array.isArray(balanceReports) ? balanceReports[0] : balanceReports,
        movementsReport,
        creditLimits
      });
      lastUpdatedAt = new Date();
    } catch (error) {
      lastError = String(error?.message || error || "تعذّر تحميل ذكاء الزبائن.");
      console.error("[OZK Customer Intelligence]", error);
    } finally {
      loading = false;
      if (state?.route === ROUTE) render();
    }
  }

  // --------------------------------------------------------------------------
  // ترشيح وترتيب (عرض فقط)
  // --------------------------------------------------------------------------
  function matchesFilter(row) {
    const has = (flag) => row.flags.includes(flag);
    switch (view.segment) {
      case "vip": return has("vip");
      case "declining": return has("declining");
      case "inactive": return has("inactive");
      case "reactivated": return has("reactivated");
      case "new": return has("new") || has("possibly_new");
      case "credit": return has("over_credit_limit") || has("near_credit_limit");
      case "attention": return has("over_credit_limit") || has("near_credit_limit") || has("declining") || has("inactive") || has("at_risk_churn");
      case "insufficient": return row.primarySegment === "insufficient_data";
      default: return true;
    }
  }

  function sortValue(row, key) {
    if (key === "trendPercent") return row.purchaseTrend?.percent;
    return row[key];
  }

  function visibleRows() {
    if (!intel) return [];
    const needle = window.ozkCustomerIntelligence.normalizeName(view.search);
    const column = COLUMNS.find((entry) => entry.key === view.sortKey) || COLUMNS[0];
    const direction = view.sortDir === "asc" ? 1 : -1;

    return intel.customers
      .filter((row) => view.includeSuppliers || !row.isSupplier)
      .filter((row) => !needle || row.customerKey.includes(needle))
      .filter(matchesFilter)
      .slice()
      .sort((a, b) => {
        const left = sortValue(a, view.sortKey);
        const right = sortValue(b, view.sortKey);
        if (column.type === "number") {
          // القيم غير المتاحة (null) تبقى في الأسفل مهما كان اتجاه الترتيب،
          // فلا تتصدّر شاشةَ قرارٍ صفوفٌ لا رقم لها أصلاً.
          const leftMissing = !isNumber(left);
          const rightMissing = !isNumber(right);
          if (leftMissing && rightMissing) return String(a.customerId).localeCompare(String(b.customerId));
          if (leftMissing) return 1;
          if (rightMissing) return -1;
          return (left - right) * direction || String(a.customerId).localeCompare(String(b.customerId));
        }
        return String(left ?? "").localeCompare(String(right ?? ""), "ar") * direction
          || String(a.customerId).localeCompare(String(b.customerId));
      });
  }

  // --------------------------------------------------------------------------
  // أجزاء العرض
  // --------------------------------------------------------------------------
  function flagChips(flags, limit = 0) {
    const list = limit > 0 ? flags.slice(0, limit) : flags;
    const extra = limit > 0 && flags.length > limit ? `<span class="ci-chip">+${flags.length - limit}</span>` : "";
    return list
      .map((flag) => `<span class="ci-chip ${escape(FLAG_TONE[flag] || "")}">${escape(FLAG_LABELS[flag] || flag)}</span>`)
      .join("") + extra;
  }

  function freshnessLine() {
    const sources = intel?.sourcesFreshness || {};
    const label = { invoices: "الفواتير", balances: "الأرصدة", movements: "الحركات" };
    const parts = Object.entries(sources).map(([name, entry]) => {
      const age = entry.ageMinutes === null ? "غير معروف" : `${entry.ageMinutes} دقيقة`;
      const tone = entry.state === "fresh" ? "good" : "warn";
      return `<span class="ci-chip ${tone}">${escape(label[name] || name)}: ${escape(age)}</span>`;
    });
    return parts.join("");
  }

  function summaryCards() {
    const s = intel.summary;
    const cards = [
      { label: "زبائن نشطون (30 يوم)", value: count(s.activeCustomers), hint: `من أصل ${count(s.totalCustomers)} زبون` },
      { label: "VIP", value: count(s.vipCount), hint: intel.dataAvailability.vipRankingReliable ? `أعلى ${Math.round(intel.config.vipTopShare * 100)}% نسبياً` : "العيّنة أصغر من أن ترتَّب" },
      { label: "متراجعون", value: count(s.decliningCount), hint: `انخفاض ${Math.abs(intel.config.declineTrendPercent)}% أو أكثر` },
      { label: "متوقفون", value: count(s.inactiveCount), hint: "تجاوزوا ضعف نمطهم المعتاد" },
      { label: "عادوا للنشاط", value: count(s.reactivatedCount), hint: "اشتروا بعد انقطاع طويل" },
      { label: "خطر ائتمان", value: count(s.overCreditLimitCount + s.nearCreditLimitCount), hint: `${count(s.overCreditLimitCount)} متجاوز · ${count(s.nearCreditLimitCount)} قريب` }
    ];
    return cards.map((card) => `<article class="ci-card"><small>${escape(card.label)}</small><strong>${card.value}</strong><span>${escape(card.hint)}</span></article>`).join("");
  }

  function tableHead() {
    return COLUMNS.map((column) => {
      if (column.type === "none") return `<th>${escape(column.label)}</th>`;
      const active = view.sortKey === column.key;
      const arrow = active ? (view.sortDir === "asc" ? "▲" : "▼") : "";
      return `<th><button type="button" class="ci-sort ${active ? "active" : ""}" data-ci-sort="${escape(column.key)}">${escape(column.label)} ${arrow}</button></th>`;
    }).join("");
  }

  function tableRow(row) {
    const trend = row.purchaseTrend?.percent;
    const trendClass = isNumber(trend) ? (trend < 0 ? "bad" : trend > 0 ? "good" : "") : "";
    const trendText = isNumber(trend)
      ? percent(trend)
      : ({ new_activity: "نشاط جديد", no_activity: "لا حركة", insufficient_data: "غير كافٍ", no_positive_baseline: "بلا أساس" }[row.purchaseTrend?.state] || "—");
    const creditText = isNumber(row.creditUsagePercent)
      ? `${Math.round(row.creditUsagePercent)}%`
      : (row.creditStatus === "unknown_limit" ? "بلا حد" : "—");
    return `
      <tr class="ci-row ${view.selectedId === row.customerId ? "selected" : ""}" data-ci-customer="${escape(row.customerId)}" tabindex="0">
        <td class="ci-name">${escape(row.customerName)}</td>
        <td><span class="ci-segment ${escape(row.primarySegment)}">${escape(SEGMENT_LABELS[row.primarySegment] || row.primarySegment)}</span></td>
        <td dir="ltr">${money(row.netSales30d, row.currency)}</td>
        <td dir="ltr">${money(row.netSalesPrevious30d, row.currency)}</td>
        <td dir="ltr" class="${trendClass}">${escape(trendText)}</td>
        <td dir="ltr">${day(row.lastPurchaseAt)}</td>
        <td dir="ltr">${count(row.daysSinceLastPurchase)}</td>
        <td dir="ltr">${money(row.currentBalance)}</td>
        <td dir="ltr">${escape(creditText)}</td>
        <td class="ci-flags">${flagChips(row.flags, 3)}</td>
      </tr>`;
  }

  function detailPanel() {
    const row = intel.customers.find((entry) => entry.customerId === view.selectedId);
    if (!row) return `<section class="panel ci-detail"><h3>تفاصيل الزبون</h3><p class="muted">اختر زبوناً من الجدول لعرض تحليله.</p></section>`;

    const items = row.topItems.length
      ? `<ol class="ci-items">${row.topItems.map((item) => `<li><span>${escape(item.itemName || "صنف")}</span><span dir="ltr">${money(item.netValue, row.currency)} · ${item.netQty.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span></li>`).join("")}</ol>`
      : `<p class="muted">لا أصناف ضمن النافذة المتاحة.</p>`;

    const identityNote = row.customerGuid
      ? `معرّف الأمين: <code dir="ltr">${escape(row.customerGuid)}</code>`
      : "لا يوجد معرّف أمين لهذا السجل — الربط بالاسم المطبَّع فقط.";

    const facts = [
      ["آخر شراء", `${day(row.lastPurchaseAt)}${isNumber(row.daysSinceLastPurchase) ? ` (منذ ${row.daysSinceLastPurchase} يوماً)` : ""}`],
      ["أول شراء مرصود", day(row.firstPurchaseAt)],
      ["صافي مبيعات 30 يوم", money(row.netSales30d, row.currency)],
      ["صافي الفترة السابقة", money(row.netSalesPrevious30d, row.currency)],
      ["التغير", isNumber(row.purchaseTrend.percent) ? percent(row.purchaseTrend.percent) : "—"],
      ["مبيعات قبل المرتجعات", money(row.sales30d, row.currency)],
      ["المرتجعات (30 يوم)", money(row.returns30d, row.currency)],
      ["عدد الفواتير (30 يوم)", count(row.invoiceCount30d)],
      ["عدد الفواتير (السابقة)", count(row.invoiceCountPrevious30d)],
      ["متوسط الفاتورة", money(row.averageInvoice30d, row.currency)],
      ["الرصيد الحالي", money(row.currentBalance)],
      ["حد الائتمان", row.creditLimit === null ? "غير محدد" : `${money(row.creditLimit)} (${escape(row.creditLimitSource === "approved" ? "معتمد داخلياً" : "من الأمين")})`],
      ["نسبة استخدام الائتمان", isNumber(row.creditUsagePercent) ? `${row.creditUsagePercent}%` : "—"],
      ["نمط الشراء المعتاد", row.cadenceTrusted ? `كل ${row.typicalGapDays} يوماً` : "غير محسوب (تاريخ غير كافٍ)"],
      ["حد اعتبار التوقف", `${row.inactiveThresholdDays} يوماً`],
      ["درجة النشاط", count(row.activityScore)],
      ["درجة القيمة", count(row.valueScore)],
      ["درجة الخطر", count(row.riskScore)]
    ];

    return `
      <section class="panel ci-detail">
        <div class="ci-detail-head">
          <div>
            <h3>${escape(row.customerName)}</h3>
            <p class="muted">${identityNote}</p>
          </div>
          <span class="ci-segment ${escape(row.primarySegment)}">${escape(SEGMENT_LABELS[row.primarySegment] || row.primarySegment)}</span>
        </div>
        <div class="ci-flag-row">${flagChips(row.flags)}</div>
        <ul class="ci-why">${row.explanation.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
        <dl class="ci-facts">${facts.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd dir="auto">${value}</dd></div>`).join("")}</dl>
        <h4>أهم الأصناف (${escape(intel.window.previousStartDate)} → ${escape(intel.window.referenceDate)})</h4>
        ${items}
        <p class="muted ci-note">${row.topItemsIdentity === "item_name" ? "تجميع الأصناف بالاسم المطبَّع — تقرير الفواتير لا يحمل معرّف مادة بعد." : "تجميع الأصناف بمعرّف المادة من الأمين."}</p>
      </section>`;
  }

  // `shell()` و`state` و`render` و`app` و`setRoute` و`allowedRoutes` كلها معرّفة
  // في src/app.js بالنطاق العام للسكربتات الكلاسيكية — نفس ما تعتمده
  // command-center.js وdecision-engine.js. لا نستدعي baseRender() على مسارنا
  // لأن `pages` في app.js لا تعرف هذا المسار (وستُلقي TypeError).
  function page() {
    if (!state?.session) return shell(`<section class="panel"><h2>ذكاء الزبائن</h2><p class="muted">سجّل الدخول أولاً.</p></section>`);
    if (!window.ozkCanAccessRoute?.(ROUTE)) return shell(`<section class="panel"><h2>غير متاح</h2><p class="muted">ذكاء الزبائن متاح لحساب المالك فقط.</p></section>`);
    if (!intel) {
      return shell(`<section class="panel wide customer-intel"><h2>🎯 ذكاء الزبائن</h2><p class="muted">${loading ? "جاري تحليل بيانات الزبائن من الأمين…" : escape(lastError || "لم تُحمّل البيانات بعد.")}</p><button class="button" type="button" data-action="ci-refresh">${loading ? "جاري التحميل…" : "تحميل"}</button></section>`);
    }

    const rows = visibleRows();
    const updated = lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : "—";
    const staleWarning = intel.staleData
      ? `<p class="ci-warning">⚠️ أحد مصادر البيانات ليس حديثاً بما يكفي. الأرقام معروضة كما هي، ولا تُبنى عليها قرارات عالية الثقة قبل نجاح المزامنة.</p>`
      : "";
    const coverageWarning = intel.window.previousWindowCovered
      ? ""
      : `<p class="ci-warning">⚠️ نافذة البيانات (${count(intel.dataAvailability.coverageDays)} يوماً) لا تغطي الفترة السابقة كاملة، فنِسَب التغيّر معطّلة عمداً بدل عرض رقم مضلِّل.</p>`;
    const ambiguityWarning = intel.summary.ambiguousIdentityCount > 0
      ? `<p class="ci-warning">⚠️ ${count(intel.summary.ambiguousIdentityCount)} سجل يتشارك الاسم نفسه بمعرّفات مختلفة في الأمين. لم تُدمج ولم تُنسب لها مبيعات (${count(intel.dataAvailability.unresolvedAmbiguousInvoiceRows)} فاتورة غير منسوبة).</p>`
      : "";

    return shell(`
      <section class="panel wide customer-intel">
        <div class="ci-hero">
          <div>
            <span class="ci-kicker">OZK BUSINESS OS · CUSTOMER INTELLIGENCE</span>
            <h2>🎯 ذكاء الزبائن</h2>
            <p class="muted">تحليل قراءة-فقط فوق بيانات الأمين. النافذة الحالية ${escape(intel.window.currentStartDate)} → ${escape(intel.window.referenceDate)}، والمقارنة مع ${escape(intel.window.previousStartDate)} → ${escape(intel.window.previousEndDate)}.</p>
          </div>
          <button class="button secondary" type="button" data-action="ci-refresh" ${loading ? "disabled" : ""}>${loading ? "جاري التحديث…" : "تحديث"}</button>
        </div>
        <div class="ci-meta"><span>آخر تحديث: <strong>${escape(updated)}</strong></span><span>حداثة المصادر:</span>${freshnessLine()}</div>
        ${staleWarning}${coverageWarning}${ambiguityWarning}
        ${lastError ? `<p class="ci-warning">${escape(lastError)}</p>` : ""}
        <div class="ci-cards">${summaryCards()}</div>
      </section>

      <section class="panel wide customer-intel">
        <div class="ci-controls">
          <input class="ci-search" type="search" placeholder="🔍 ابحث باسم الزبون…" value="${escape(view.search)}" data-ci-search dir="auto">
          <div class="ci-filters">${FILTERS.map((filter) => `<button type="button" class="button secondary ${view.segment === filter.id ? "active" : ""}" data-ci-filter="${escape(filter.id)}">${escape(filter.label)}</button>`).join("")}</div>
          <label class="ci-toggle"><input type="checkbox" data-ci-suppliers ${view.includeSuppliers ? "checked" : ""}> إظهار حسابات الموردين</label>
        </div>
        <p class="muted">${count(rows.length)} سجل معروض.</p>
        <div class="ci-table-wrap">
          <table class="ci-table">
            <thead><tr>${tableHead()}</tr></thead>
            <tbody>${rows.length ? rows.map(tableRow).join("") : `<tr><td colspan="${COLUMNS.length}" class="muted">لا نتائج مطابقة.</td></tr>`}</tbody>
          </table>
        </div>
      </section>

      ${detailPanel()}`);
  }

  // --------------------------------------------------------------------------
  // الربط
  // --------------------------------------------------------------------------
  function bind() {
    app.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", (event) => {
      event.preventDefault();
      setRoute(button.dataset.route);
    }));
    app.querySelector("[data-action='ci-refresh']")?.addEventListener("click", loadIntel);

    const search = app.querySelector("[data-ci-search]");
    if (search) {
      search.addEventListener("input", () => {
        view.search = search.value;
        render();
        const next = app.querySelector("[data-ci-search]");
        if (next) { next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
      });
    }

    app.querySelectorAll("[data-ci-filter]").forEach((button) => button.addEventListener("click", () => {
      view.segment = button.dataset.ciFilter;
      render();
    }));

    app.querySelector("[data-ci-suppliers]")?.addEventListener("change", (event) => {
      view.includeSuppliers = Boolean(event.target.checked);
      render();
    });

    app.querySelectorAll("[data-ci-sort]").forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.ciSort;
      if (view.sortKey === key) view.sortDir = view.sortDir === "asc" ? "desc" : "asc";
      else { view.sortKey = key; view.sortDir = key === "customerName" || key === "lastPurchaseAt" ? "asc" : "desc"; }
      render();
    }));

    app.querySelectorAll("[data-ci-customer]").forEach((row) => {
      const select = () => { view.selectedId = row.dataset.ciCustomer; render(); };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
      });
    });
  }

  function addNav() {
    if (!window.ozkCanAccessRoute?.(ROUTE)) {
      document.querySelectorAll(`[data-route="${ROUTE}"]`).forEach((node) => node.remove());
      return;
    }
    if (document.querySelector(`[data-route="${ROUTE}"]`)) return;
    const nav = document.querySelector("aside .sidebar nav, aside nav, .sidebar nav");
    if (!nav) return;
    const template = nav.querySelector("[data-route]");
    const button = document.createElement(template?.tagName === "A" ? "a" : "button");
    button.className = template?.className || "nav-link";
    button.textContent = "🎯 ذكاء الزبائن";
    button.dataset.route = ROUTE;
    if (button.tagName === "A") button.href = "?route=customerIntel";
    button.addEventListener("click", (event) => { event.preventDefault(); setRoute(ROUTE); });
    nav.insertBefore(button, nav.firstChild);
  }

  function syncTimer() {
    // تسجيل الخروج: نمسح intel فوراً حتى لا تتسرّب بيانات الزبائن عبر snapshot().
    if (!state?.session) intel = null;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (state?.route === ROUTE && state?.session && window.ozkCanAccessRoute?.(ROUTE)) {
      refreshTimer = setInterval(loadIntel, REFRESH_MS);
      // أول دخول للمسار من الشريط الجانبي لا يمرّ بمُهيّئ الوحدة، فبدون هذا
      // السطر تبقى الشاشة على «لم تُحمّل البيانات بعد» حتى يضغط المستخدم زراً.
      // (نفس ما يفعله decision-engine.js في syncRefreshTimer.)
      if (!intel && !loading) queueMicrotask(loadIntel);
    }
  }

  try {
    allowedRoutes.add(ROUTE);
    if (new URLSearchParams(window.location.search).get("route") === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) state.route = ROUTE;

    const baseRender = render;
    render = function customerIntelAwareRender() {
      if (state.route === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) {
        app.innerHTML = page();
        bind();
        addNav();
        syncTimer();
        return;
      }
      baseRender();
      addNav();
      syncTimer();
    };

    window.ozkCustomerIntelligenceView = Object.freeze({
      ROUTE,
      refresh: loadIntel,
      // نتحقّق من الصلاحية عند كل استدعاء لا عند التحميل فقط — يمنع وصول حساب
      // آخر أو جلسة منتهية إلى بيانات الزبائن عبر الـAPI البرمجي.
      snapshot: () => (window.ozkCanAccessRoute?.(ROUTE) ? intel : null),
      coworkPayload: () => (intel && window.ozkCanAccessRoute?.(ROUTE) ? window.ozkCustomerIntelligence.buildCoworkPayload(intel) : null),
      alertDrafts: () => (intel && window.ozkCanAccessRoute?.(ROUTE) ? window.ozkCustomerIntelligence.buildAlertDrafts(intel) : [])
    });

    render();
    if (state?.route === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) setTimeout(loadIntel, 0);
  } catch (error) {
    console.error("[OZK Customer Intelligence View Init]", error);
  }
})();
