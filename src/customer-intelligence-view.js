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
  // تاريخ الحد اختياري: فشل قراءته (مثلاً قبل تطبيق الـmigration) لا يُسقط الشاشة،
  // فيعمل المحرك بسلوك STEP 1 ويُعرض السبب.
  let historyError = null;
  let lastUpdatedAt = null;
  let refreshTimer = null;
  // حفظ الحد المعتمد يدوياً (المالك): رسالة آخر محاولة لكل زبون.
  let approvedSave = { customerId: null, busy: false, message: "", tone: "" };

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
  // الكمية بوحدة مفهومة: الكرتونة أولاً إن عُرف معاملها، والكروز بين قوسين.
  // المحرك يقدّم الرقمين (netQty بالوحدة الأولى، netQtyUnit2 بالثانية) — هنا تنسيق فقط.
  const itemQuantity = (item) => {
    const format = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const unit1 = item.unit1 ? ` ${escape(item.unit1)}` : "";
    if (isNumber(item.netQtyUnit2) && item.unit2) {
      return `<bdi>${format(item.netQtyUnit2)} ${escape(item.unit2)}</bdi> <span class="muted">(<bdi>${format(item.netQty)}${unit1}</bdi>)</span>`;
    }
    return `<bdi>${format(item.netQty)}${unit1}</bdi>`;
  };
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
    credit_balance_unknown: "الرصيد غير متاح",
    credit_delinquent: "متعثّر: الائتمان موقوف",
    credit_inactive: "غير نشط: بلا حد",
    credit_low_data: "بيانات غير كافية",
    credit_smoothed: "حد منعَّم أسبوعياً",
    key_customer: "زبون مهم",
    key_customer_absent: "زبون مهم غائب",
    credit_not_customer: "ليس زبون مبيعات: بلا حد",
    credit_needs_review: "حد الائتمان غير متاح: يحتاج مراجعة",
    credit_insufficient_data: "الحد يحتاج مراجعة: بيانات غير كافية",
    credit_mixed_role: "دور مختلط (زبون ومورد)",
    old_debt_collection: "تحصيل دين قديم",
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
    credit_balance_unknown: "warn",
    credit_delinquent: "danger",
    credit_low_data: "warn",
    credit_needs_review: "warn",
    credit_insufficient_data: "warn",
    credit_mixed_role: "warn",
    old_debt_collection: "warn",
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
    { key: "creditLimitDisplay", label: "الحد الائتماني المقترح", type: "number" },
    { key: "currentBalance", label: "الرصيد الحالي", type: "number" },
    { key: "availableCredit", label: "المتاح من الحد", type: "number" },
    { key: "creditUsagePercent", label: "نسبة استخدام الحد", type: "number" },
    { key: "overLimitAmount", label: "مقدار التجاوز", type: "number" },
    { key: "riskScore", label: "الخطر", type: "number" },
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

      // نافذة جلب أوسع قليلاً من lookbackDays؛ المحرك يقصّها بدقة على يوم المرجع.
      const sinceDate = new Date(Date.now() - (engine.CONFIG.creditHistory.lookbackDays + 2) * 86400000).toISOString().slice(0, 10);
      historyError = null;
      const [invoicesReport, balanceReports, movementsReport, creditLimits, historyRows] = await Promise.all([
        data.getCustomerInvoicesReport ? data.getCustomerInvoicesReport() : null,
        data.listCustomerBalanceReports ? data.listCustomerBalanceReports() : [],
        data.getCustomerMovementsReport ? data.getCustomerMovementsReport() : null,
        data.listCustomerCreditLimits ? data.listCustomerCreditLimits() : [],
        data.listCustomerCreditHistory
          ? data.listCustomerCreditHistory({ sinceDate }).catch((error) => {
            historyError = String(error?.message || error || "تعذّر قراءة تاريخ الحد.");
            return undefined;
          })
          : undefined
      ]);

      intel = engine.build({
        invoicesReport,
        balancesReport: Array.isArray(balanceReports) ? balanceReports[0] : balanceReports,
        movementsReport,
        creditLimits,
        creditHistory: historyRows
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
  // رصيد مدين بلا حد موثوق: يُراجَع ضمن خطر الائتمان (لا يختفي التنبيه لأن الرقم غير موثوق).
  const insufficientWithBalance = (row) => row.flags.includes("credit_insufficient_data") && isNumber(row.currentBalance) && row.currentBalance > 0;

  function matchesFilter(row) {
    const has = (flag) => row.flags.includes(flag);
    switch (view.segment) {
      case "vip": return has("vip");
      case "declining": return has("declining");
      case "inactive": return has("inactive");
      case "reactivated": return has("reactivated");
      case "new": return has("new") || has("possibly_new");
      case "credit": return has("over_credit_limit") || has("near_credit_limit") || has("credit_delinquent") || insufficientWithBalance(row);
      case "attention": return has("over_credit_limit") || has("near_credit_limit") || has("credit_delinquent") || insufficientWithBalance(row) || has("declining") || has("inactive") || has("at_risk_churn");
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
    // «يحتاج مراجعة: بيانات غير كافية» يغني عن وسم البيانات القليلة نفسه.
    const shown = flags.includes("credit_insufficient_data") ? flags.filter((flag) => flag !== "credit_low_data") : flags;
    const list = limit > 0 ? shown.slice(0, limit) : shown;
    const extra = limit > 0 && shown.length > limit ? `<span class="ci-chip">+${shown.length - limit}</span>` : "";
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
      { label: "خطر ائتمان", value: count(s.overCreditLimitCount + s.nearCreditLimitCount + (s.delinquentCreditCount || 0)), hint: `${count(s.overCreditLimitCount)} متجاوز · ${count(s.nearCreditLimitCount)} قريب · ${count(s.delinquentCreditCount || 0)} متعثّر` }
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

  // اتجاه الخطر كما حسبه المحرك من آخر 7 لقطات — عرض فقط.
  const RISK_TREND = {
    up: { arrow: "↑", tone: "bad", label: "الخطر صاعد" },
    down: { arrow: "↓", tone: "good", label: "الخطر نازل" },
    flat: { arrow: "→", tone: "", label: "الخطر ثابت" }
  };
  function riskTrendBadge(row) {
    const trend = RISK_TREND[row.creditHistory?.riskTrend?.direction];
    if (!trend) return "";
    const delta = row.creditHistory.riskTrend.delta;
    return `<span class="ci-trend ${trend.tone}" title="${escape(`${trend.label}: ${delta > 0 ? "+" : ""}${delta} درجة على ${row.creditHistory.riskTrend.points} لقطات`)}">${trend.arrow}</span>`;
  }

  function changeLine(row) {
    const change = row.creditHistory?.change;
    return change ? `<div class="ci-change ${change.direction === "down" ? "bad" : change.direction === "up" ? "good" : ""}">${escape(change.text)}</div>` : "";
  }

  function tableRow(row) {
    const trend = row.purchaseTrend?.percent;
    const trendClass = isNumber(trend) ? (trend < 0 ? "bad" : trend > 0 ? "good" : "") : "";
    const trendText = isNumber(trend)
      ? percent(trend)
      : ({ new_activity: "نشاط جديد", no_activity: "لا حركة", insufficient_data: "غير كافٍ", no_positive_baseline: "بلا أساس" }[row.purchaseTrend?.state] || "—");
    const creditText = isNumber(row.creditUsagePercent)
      ? `${Math.round(row.creditUsagePercent)}%`
      : (CREDIT_STATUS_TEXT[row.creditStatus] || "—");
    // الاستخدام والمتاح والتجاوز على الحد المعتمد يدوياً إن وُجد (قرار المالك 2026-10-25).
    const basisTag = row.limitBasis === "approved" ? ` <span class="ci-basis" title="محسوب على الحد المعتمد يدوياً">معتمد</span>` : "";
    const creditCurrency = row.creditCurrency || "USD";
    const amountCurrency = row.balanceCurrency || creditCurrency;
    // الحد المقترح: رقم إن وُجد، وإلا حالة صريحة («يحتاج مراجعة»، «موقوف»...) بدل رقم غير موثوق.
    const proposedCell = proposedText(row);
    const overClass = isNumber(row.overLimitAmount) && row.overLimitAmount > 0 ? "bad" : "";
    return `
      <tr class="ci-row ${view.selectedId === row.customerId ? "selected" : ""}" data-ci-customer="${escape(row.customerId)}" tabindex="0">
        <td class="ci-name">${escape(row.customerName)}${changeLine(row)}</td>
        <td><span class="ci-segment ${escape(row.primarySegment)}">${escape(SEGMENT_LABELS[row.primarySegment] || row.primarySegment)}</span></td>
        <td dir="ltr">${money(row.netSales30d, row.currency)}</td>
        <td dir="ltr">${money(row.netSalesPrevious30d, row.currency)}</td>
        <td dir="ltr" class="${trendClass}">${escape(trendText)}</td>
        <td dir="ltr">${day(row.lastPurchaseAt)}</td>
        <td dir="ltr">${count(row.daysSinceLastPurchase)}</td>
        <td dir="${isNumber(row.creditLimitDisplay) ? "ltr" : "auto"}">${proposedCell}</td>
        <td dir="ltr">${money(row.balanceDisplay ?? row.currentBalance, row.balanceCurrency || row.creditCurrency || "USD")}</td>
        <td dir="ltr">${money(row.availableCredit, amountCurrency)}</td>
        <td dir="${isNumber(row.creditUsagePercent) ? "ltr" : "auto"}">${escape(creditText)}${basisTag}</td>
        <td dir="ltr" class="${overClass}">${money(row.overLimitAmount, amountCurrency)}</td>
        <td dir="ltr">${count(row.riskScore)} ${riskTrendBadge(row)}</td>
        <td class="ci-flags">${flagChips(row.flags, 3)}</td>
      </tr>`;
  }

  const CREDIT_STATUS_TEXT = {
    unknown_limit: "بلا حد",
    unknown_balance: "رصيد غير متاح",
    delinquent: "موقوف (متعثّر)",
    inactive_no_limit: "غير نشط",
    prepaid: "رصيد دائن",
    not_customer: "ليس زبون مبيعات",
    stale_balance: "غير متاح: الرصيد غير حديث",
    awaiting_typed_source: "غير متاح: بانتظار مصدر حركات موسوم",
    stale_invoices: "غير متاح: الفواتير غير حديثة",
    accounting_day_mismatch: "غير متاح: يوم المحاسبة غير متطابق",
    missing_rate: "غير متاح: لا سعر صرف لعملة الحساب",
    needs_review: "غير متاح: يحتاج مراجعة",
    insufficient_data: "يحتاج مراجعة",
    old_debt_collection: "تحصيل دين قديم"
  };
  // نص خانة «الحد المقترح» حين لا رقم.
  const PROPOSED_STATUS_TEXT = {
    insufficient_data: "يحتاج مراجعة",
    needs_review: "يحتاج مراجعة",
    not_customer: "ليس زبوناً تجارياً",
    prepaid: "لا تعرّض (دفع مسبق)",
    unknown_limit: "غير محدد"
  };
  const AUTO_STATUS_TEXT = {
    normal: "آلي",
    low_data: "يحتاج مراجعة: بيانات غير كافية",
    delinquent: "آلي: موقوف للتعثّر",
    inactive: "آلي: لا حد (غير نشط)",
    prepaid: "آلي: لا تعرّض (دفع مسبق)",
    non_customer: "لا حد: ليس زبون مبيعات",
    needs_review: "حد الائتمان غير متاح: الحساب يحتاج مراجعة نوع الحركة"
  };
  const CYCLE_BASIS_TEXT = {
    fifo_median: "وسيط أيام السداد الفعلية",
    payment_interval: "وسيط الفاصل بين الدفعات",
    portfolio_median: "وسيط المحفظة (بيانات قليلة)"
  };

  // مصادر بلا حد معروض: نص ثابت.
  const UNAVAILABLE_LIMIT_TEXT = {
    stale: "غير متاح (تقرير الأرصدة غير حديث)",
    untyped: "غير متاح (بانتظار تقرير حركات موسوم بالنوع)",
    stale_invoices: "غير متاح (تقرير الفواتير غير حديث)",
    day_mismatch: "غير متاح (المصادر على يومين محاسبيين مختلفين)",
    missing_rate: "غير متاح (لا سعر صرف لعملة الحساب)"
  };

  function creditLimitText(row) {
    const auto = row.autoCredit;
    if (row.creditLimitSource === "auto") {
      const label = AUTO_STATUS_TEXT[auto?.status] || "آلي";
      return row.creditLimitDisplay === null ? escape(label) : `${money(row.creditLimitDisplay, row.creditCurrency || "USD")} (${escape(label)} — مقترح)`;
    }
    if (UNAVAILABLE_LIMIT_TEXT[row.creditLimitSource]) return UNAVAILABLE_LIMIT_TEXT[row.creditLimitSource];
    if (row.creditLimitSource === "ameen") return `${money(row.creditLimitDisplay ?? row.creditLimit, row.creditCurrency || "USD")} (من الأمين — لا دفتر حساب للحساب الآلي)`;
    return "غير محدد";
  }

  // مكوّنات الحد المقترح كما حسبها المحرك — عرض فقط، بلا إعادة حساب.
  const num = (value, digits = 2) => (isNumber(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—");
  const share = (value) => (isNumber(value) ? `${Math.round(value * 100)}%` : "—");
  const CAPPED_BY_TEXT = {
    coverage: "سقف التغطية (التحصيل أقل من 90%)",
    low_data: "سقف البيانات القليلة",
    precaution: "السقف الاحترازي (1.5× الاحتياج الطبيعي)"
  };

  // «لماذا هذا الحد؟» — كل رقم من مخرج المحرك. المبالغ بعملة الأساس (الدولار) كما يحسبها الدفتر.
  const BASE = "USD";
  const factList = (facts) => `<dl class="ci-facts">${facts.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd dir="auto">${value}</dd></div>`).join("")}</dl>`;
  const sinceText = (date, days) => (date ? `${day(date)}${isNumber(days) ? ` (منذ ${days} يوماً)` : ""}` : "—");

  function drawTable(draws) {
    if (!Array.isArray(draws) || !draws.length) return "";
    const cells = (key, missing) => draws.map((d) => `<td dir="ltr">${d.covered ? money(d[key], BASE) : missing}</td>`).join("");
    return `<div class="ci-mini-wrap"><table class="ci-mini"><thead><tr><th>السحب (فواتير البيع)</th>${draws.map((d) => `<th>آخر ${d.days} يوماً</th>`).join("")}</tr></thead><tbody>
        <tr><td>الإجمالي</td>${cells("total", "غير مغطى")}</tr>
        <tr><td>المتوسط اليومي</td>${cells("daily", "—")}</tr>
        <tr><td>المتوسط الشهري</td>${cells("monthly", "—")}</tr>
      </tbody></table></div>`;
  }

  function behaviourFacts(pb) {
    if (!pb) return [];
    return [
      ["فواتير مسددة فعلاً", count(pb.settledCount)],
      ["انتظام الدفع", isNumber(pb.onTimeShare) ? `${share(pb.onTimeShare)} من قيمتها سُدِّد خلال ${num(pb.dueDays, 1)} يوماً` : "غير محسوب (لا فواتير مسددة)"],
      ["متوسط التأخير بعد الاستحقاق", isNumber(pb.averageDelayDays) ? `${num(pb.averageDelayDays, 1)} يوماً (${count(pb.lateCount)} فاتورة متأخرة)` : "—"]
    ];
  }

  function proposalFacts(row, auto) {
    const facts = [];
    if (isNumber(auto.cycleDays)) facts.push(["دورة السداد الفعلية", `${num(auto.cycleDays, 1)} يوماً (${escape(CYCLE_BASIS_TEXT[auto.cycleBasis] || auto.cycleBasis || "—")})`]);
    facts.push(...behaviourFacts(auto.paymentBehaviour));
    if (isNumber(auto.coverage)) facts.push(["تغطية الدفع (60 يوماً)", share(auto.coverage)]);
    if (isNumber(auto.overdueAmount)) facts.push([`الرصيد المتأخر (أقدم من ${num(auto.overdueAfterDays, 0)} يوماً)`, `<bdi dir="ltr">${money(auto.overdueAmount, BASE)}</bdi>`]);
    if (isNumber(auto.oldestOpenDays)) facts.push(["أقدم دين مفتوح", `${auto.oldestOpenDays} يوماً`]);
    facts.push(["آخر شراء", sinceText(row.lastPurchaseAt, row.daysSinceLastPurchase)]);
    facts.push(["آخر دفعة", auto.lastPaymentDate ? sinceText(auto.lastPaymentDate, auto.daysSinceLastPayment) : "لا دفعة في الدفتر"]);
    return facts;
  }

  function formulaResult(auto) {
    if (auto.status === "low_data") return "<strong>يحتاج مراجعة</strong> — البيانات لا تكفي لرقم موثوق، فلا يُعرض الحد المحافظ المحسوب.";
    const smoothed = auto.smoothing?.applied && isNumber(auto.limitBaseRaw) ? ` (بعد التنعيم الأسبوعي؛ قبله ${money(auto.limitBaseRaw, BASE)})` : "";
    return `<strong dir="ltr">${money(auto.limitBase, BASE)}</strong>${smoothed}`;
  }

  function formulaBlock(auto) {
    if (!isNumber(auto.velocity) || !isNumber(auto.exposureCycleDays) || !isNumber(auto.quality)) return "";
    const caps = auto.cappedBy ? ` × ${escape(CAPPED_BY_TEXT[auto.cappedBy] || auto.cappedBy)}` : "";
    const need = auto.status === "low_data" ? ""
      : `<p class="muted">الاحتياج الطبيعي = السحب اليومي × دورة السداد الفعلية = <bdi dir="ltr">${money(auto.naturalNeed, BASE)}</bdi>، والسقف الاحترازي (1.5×) = <bdi dir="ltr">${money(auto.precautionaryCap, BASE)}</bdi>. الحد المعروض مقرَّب تجارياً للأسفل.</p>`;
    return `<p class="ci-formula">الحد المقترح = السحب اليومي <bdi dir="ltr">${money(auto.velocity, BASE)}</bdi> × الدورة المتوقعة <bdi dir="ltr">${num(auto.exposureCycleDays, 1)}</bdi> يوماً × معامل انتظام الدفع <bdi dir="ltr">${num(auto.quality, 3)}</bdi> × معامل المخاطر <bdi dir="ltr">${num(auto.riskFactor, 3)}</bdi> = ${formulaResult(auto)}</p>
        <p class="muted">معامل الانتظام Q من التغطية (${share(auto.coverageScore)}) والانضباط (${num(auto.punctuality, 2)}) ومخاطر الرصيد (${num(auto.risk, 2)}). معامل المخاطر = الاتجاه (${num(auto.trend, 3)})${caps}.</p>
        ${need}`;
  }

  function rateLine(rate) {
    if (!rate) return "";
    const source = rate.basis === "customer_latest_invoice" ? "آخر فاتورة للزبون" : "آخر فاتورة بهذه العملة في المحفظة";
    return `<p class="muted">حساب بعملة ${escape(rate.currency)}: التحويل بسعر <bdi dir="ltr">${num(1 / rate.rate, 0)}</bdi> ${escape(rate.currency)} للدولار من ${source} بتاريخ ${day(rate.date)}.</p>`;
  }

  // الحالات التي تعرض ملاحظات المحرك في «لماذا» أعلى اللوحة لا تكررها هنا.
  const NOTES_SHOWN_ABOVE = new Set(["delinquent", "inactive_no_limit", "not_customer", "needs_review", "insufficient_data"]);
  const FIFO_NOTE = `<p class="muted ci-note">الدورة وأيام السداد بطريقة FIFO: كل دفعة تسدّد أقدم فاتورة مفتوحة، فالدفعة الجزئية لا تُغلق الفاتورة، والفواتير المتزامنة تُسدَّد بترتيبها، ومدة الانقطاع عن الشراء بلا دين لا تُحسب دورة سداد.</p>`;

  function proposalSection(row) {
    const auto = row.autoCredit;
    if (!auto) return "";
    const notes = !NOTES_SHOWN_ABOVE.has(row.creditStatus) && (auto.notes || []).length
      ? `<ul class="ci-why">${auto.notes.map((note) => `<li>${escape(note)}</li>`).join("")}</ul>` : "";
    return `<div class="ci-proposal"><h4>لماذا هذا الحد المقترح؟</h4>${drawTable(auto.drawAverages)}${formulaBlock(auto)}${factList(proposalFacts(row, auto))}${FIFO_NOTE}${rateLine(row.exchangeRate)}${notes}</div>`;
  }

  // الحد المعتمد: ما يحفظه المالك يدوياً (customer_credit_limits، بالدولار كصفحة الأرصدة). المقترح
  // لا يُحفظ تلقائياً أبداً، ولا يُكتب أي حد إلى الأمين.
  const proposedText = (row) => (isNumber(row.creditLimitDisplay)
    ? money(row.creditLimitDisplay, row.creditCurrency || BASE)
    : escape(PROPOSED_STATUS_TEXT[row.creditStatus] || CREDIT_STATUS_TEXT[row.creditStatus] || "غير متاح"));

  const LIMIT_BASIS_TEXT = { approved: "الحد المعتمد يدوياً", auto: "الحد المقترح", ameen: "حد الأمين" };

  function approvedLines(approved) {
    if (!approved || !isNumber(approved.limit) || approved.limit < 0) return [`<p class="muted">لا حد معتمد يدوياً لهذا الزبون، فالاستخدام والتجاوز على الحد المقترح.</p>`];
    const updated = approved.updatedAt ? ` <span class="muted">آخر تعديل ${escape(approved.updatedAt.slice(0, 10))}</span>` : "";
    const byName = approved.matchedBy === "name" ? ` <span class="muted">(مربوط بالاسم)</span>` : "";
    const usage = isNumber(approved.usagePercent) ? `${Math.round(approved.usagePercent)}%` : "—";
    const diff = isNumber(approved.proposedMinusApproved)
      ? ` · المقترح ${approved.proposedMinusApproved >= 0 ? "أعلى" : "أقل"} بـ ${money(Math.abs(approved.proposedMinusApproved), BASE)}` : "";
    const zero = approved.limit === 0 ? ` <span class="muted">(قرار صريح: بلا آجل)</span>` : "";
    return [
      `<p>الحد المعتمد (المالك): <strong dir="ltr">${money(approved.limit, BASE)}</strong>${zero}${updated}${byName}</p>`,
      `<p class="muted">مقابل الحد المعتمد: الاستخدام ${usage} · المتاح ${money(approved.availableCredit, BASE)} · التجاوز ${money(approved.overLimitAmount, BASE)}${diff}</p>`
    ];
  }

  function approvedForm(row) {
    if (!row.customerGuid || !window.tobaccoData?.upsertCustomerCreditLimit) {
      return `<p class="muted ci-note">${row.customerGuid ? "تعديل الحد غير متاح في هذه الجلسة." : "لا معرّف أمين لهذا السجل، فلا يُحفظ له حد من هنا."}</p>`;
    }
    const saveState = approvedSave.customerId === row.customerId ? approvedSave : {};
    const approved = row.approvedCredit;
    const prefill = approved?.limit >= 0 ? approved.limit : (isNumber(row.creditLimit) ? Math.round(row.creditLimit) : "");
    const message = saveState.message ? `<p class="ci-${saveState.tone === "error" ? "warning" : "change good"}">${escape(saveState.message)}</p>` : "";
    return `
      <form class="ci-approve" data-ci-approve="${escape(row.customerId)}">
        <label>اعتماد حد يدوياً (بالدولار)
          <input type="number" name="approvedLimit" min="0" step="any" inputmode="decimal" value="${escape(prefill)}" dir="ltr" required>
        </label>
        <button class="button" type="submit" ${saveState.busy ? "disabled" : ""}>${saveState.busy ? "جاري الحفظ…" : "حفظ الحد المعتمد"}</button>
      </form>
      <p class="muted ci-note">الحفظ يكتب إلى حدود الزبائن في الموقع (نفس حد صفحة الأرصدة) ولا يغيّر شيئاً في الأمين.</p>
      ${message}`;
  }

  function approvedSection(row) {
    const ameen = isNumber(row.ameenCreditLimit) ? `<p class="muted">حد الأمين (قراءة فقط): ${money(row.ameenCreditLimit, BASE)}</p>` : "";
    return `<div class="ci-approved"><h4>الحد المقترح والحد المعتمد</h4><p>الحد المقترح: <strong>${proposedText(row)}</strong> — حساب آلي، غير معتمد.</p>${approvedLines(row.approvedCredit).join("")}${ameen}${approvedForm(row)}</div>`;
  }

  const SMOOTHING_TEXT = {
    no_history: "لا لقطة سابقة بعد: الحد المحسوب كما هو.",
    no_numeric_baseline: "اللقطة المرجعية بلا حد رقمي (متعثّر أو غير نشط): الحد المحسوب كما هو.",
    within_bounds: "التغيير ضمن حدود التنعيم الأسبوعي.",
    capped_increase: "الحد محصور بسقف الارتفاع الأسبوعي.",
    capped_decrease: "الحد محصور بسقف النزول الأسبوعي."
  };

  // تاريخ الحد كما حسبه المحرك: آخر لقطة، وسبب التغيير، والتنعيم، واتجاه الخطر — عرض فقط.
  function historySection(row) {
    const history = row.creditHistory;
    if (!history) {
      return historyError ? `<p class="muted ci-note">تاريخ الحد غير متاح: ${escape(historyError)}</p>` : "";
    }
    const lines = [];
    if (history.change) lines.push(`<p class="ci-change ${history.change.direction === "down" ? "bad" : history.change.direction === "up" ? "good" : ""}">${escape(history.change.text)}</p>`);
    if (history.previous) {
      lines.push(`<p class="muted">آخر لقطة: ${day(history.previous.date)} · الحد ${money(history.previous.creditLimitDisplay, history.previous.creditCurrency || "USD")}</p>`);
    } else {
      lines.push(`<p class="muted">لا لقطة سابقة لهذا الزبون بعد.</p>`);
    }
    const smoothing = history.smoothing;
    // بيانات غير كافية: لا أرقام حد (ولا حدود التنعيم) — «يحتاج مراجعة» فقط.
    if (smoothing && SMOOTHING_TEXT[smoothing.reason] && row.autoCredit?.status !== "low_data") {
      const baseline = smoothing.baselineDate ? ` (المرجع ${escape(smoothing.baselineDate)}${isNumber(smoothing.minLimitBase) ? `: بين ${money(smoothing.minLimitBase)} و${money(smoothing.maxLimitBase)}` : ""})` : "";
      lines.push(`<p class="muted">التنعيم الأسبوعي: ${escape(SMOOTHING_TEXT[smoothing.reason])}${baseline}${isNumber(row.autoCredit?.limitBaseRaw) && smoothing.applied ? ` — الحد المحسوب قبل التنعيم ${money(row.autoCredit.limitBaseRaw)}` : ""}</p>`);
    }
    const trend = history.riskTrend;
    if (trend && RISK_TREND[trend.direction]) {
      lines.push(`<p class="muted">اتجاه الخطر: ${riskTrendBadge(row)} ${escape(RISK_TREND[trend.direction].label)} (${trend.delta > 0 ? "+" : ""}${escape(trend.delta)} درجة من ${escape(trend.fromDate)} إلى ${escape(trend.toDate)}، ${count(trend.points)} لقطات)</p>`);
    }
    return `<div class="ci-history"><h4>تاريخ الحد</h4>${lines.join("")}</div>`;
  }

  function detailPanel() {
    const row = intel.customers.find((entry) => entry.customerId === view.selectedId);
    if (!row) return `<section class="panel ci-detail"><h3>تفاصيل الزبون</h3><p class="muted">اختر زبوناً من الجدول لعرض تحليله.</p></section>`;

    const items = row.topItems.length
      ? `<ol class="ci-items">${row.topItems.map((item) => `<li><span>${escape(item.itemName || "صنف")}</span><span>${item.valueVerified ? `<span dir="ltr">${money(item.netValue, row.currency)}</span>` : `<span title="سطر بلا وحدة إدخال من الأمين — القيمة غير مؤكدة">قيمة غير مؤكدة</span>`} · ${itemQuantity(item)}</span></li>`).join("")}</ol>`
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
      ["الرصيد الحالي", money(row.balanceDisplay ?? row.currentBalance, row.balanceCurrency || row.creditCurrency || "USD")],
      ["الحد المقترح", creditLimitText(row)],
      ["أساس الاستخدام والتجاوز", LIMIT_BASIS_TEXT[row.limitBasis] || "لا حد يُقاس عليه"],
      ["المتاح من الحد", money(row.availableCredit, row.balanceCurrency || row.creditCurrency || "USD")],
      ["نسبة استخدام الحد", isNumber(row.creditUsagePercent) ? `${row.creditUsagePercent}%` : (CREDIT_STATUS_TEXT[row.creditStatus] || "—")],
      ["مقدار التجاوز", money(row.overLimitAmount, row.balanceCurrency || row.creditCurrency || "USD")],
      ["نمط الشراء المعتاد", row.cadenceTrusted ? `كل ${row.typicalGapDays} يوماً` : "غير محسوب (تاريخ غير كافٍ)"],
      ["حد اعتبار التوقف", `${row.inactiveThresholdDays} يوماً`],
      ["درجة النشاط", count(row.activityScore)],
      ["درجة القيمة", count(row.valueScore)],
      ["درجة الخطر", `${count(row.riskScore)} ${riskTrendBadge(row)}`]
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
        ${approvedSection(row)}
        ${proposalSection(row)}
        ${historySection(row)}
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
    // الشاشة تتجاوز baseRender() بعد رسم shell()، فبدون هذا الربط تبقى أزرار
    // الغلاف (خروج/سمة/تثبيت) بلا مستمع — نفس ربط render() في app.js.
    app.querySelector("[data-action='toggle-theme']")?.addEventListener("click", () => {
      state.darkMode = !state.darkMode;
      applyTheme();
      render();
    });
    app.querySelector("[data-action='retry-startup']")?.addEventListener("click", () => { window.location.reload(); });
    app.querySelector("[data-action='install']")?.addEventListener("click", installApp);
    app.querySelector("[data-action='logout']")?.addEventListener("click", logout);
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

    app.querySelectorAll("[data-ci-approve]").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveApprovedLimit(form);
    }));

    app.querySelectorAll("[data-ci-customer]").forEach((row) => {
      const select = () => { view.selectedId = row.dataset.ciCustomer; render(); };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
      });
    });
  }

  // حفظ الحد المعتمد بضغطة المالك وحده — نفس دالة صفحة الأرصدة (upsertCustomerCreditLimit).
  async function saveApprovedLimit(form) {
    const row = intel?.customers.find((entry) => entry.customerId === form.dataset.ciApprove);
    if (!row || !row.customerGuid || approvedSave.busy || !window.ozkCanAccessRoute?.(ROUTE)) return;
    const value = Number(String(new FormData(form).get("approvedLimit") ?? "").replace(/,/g, ""));
    if (!Number.isFinite(value) || value < 0) {
      approvedSave = { customerId: row.customerId, busy: false, message: "أدخل رقماً صحيحاً (صفر أو أكثر).", tone: "error" };
      render();
      return;
    }
    approvedSave = { customerId: row.customerId, busy: true, message: "", tone: "" };
    render();
    try {
      await window.tobaccoData.upsertCustomerCreditLimit({
        customerKey: window.ozkCustomerIntelligence.normalizeName(row.customerName),
        customerGuid: row.customerGuid,
        customerName: row.customerName,
        creditLimit: value,
        notes: `اعتماد من ذكاء الزبائن (المقترح عندها: ${isNumber(row.creditLimit) ? Math.round(row.creditLimit) : "غير متاح"})`
      });
      approvedSave = { customerId: row.customerId, busy: false, message: `حُفظ الحد المعتمد ${value.toLocaleString("en-US")} USD.`, tone: "good" };
      await loadIntel();
    } catch (error) {
      approvedSave = { customerId: row.customerId, busy: false, message: String(error?.message || error || "تعذّر حفظ الحد."), tone: "error" };
    }
    render();
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
