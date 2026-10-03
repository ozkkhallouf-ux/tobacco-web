// ============================================================================
// ذكاء الزبائن — طبقة تحليل تجاري deterministic فوق بيانات الأمين المزامَنة.
//
// مبدأ ثابت: هذا الملف **يقرأ فقط**. لا يكتب إلى الأمين ولا إلى Supabase ولا
// ينشئ أي قيد/فاتورة/رصيد. الأمين يبقى مصدر الحقيقة المحاسبي، وكل رقم هنا
// مشتق منه بحساب صريح قابل لإعادة الإنتاج — لا LLM ولا تخمين.
//
// لماذا JS نقي وليس SQL View/RPC:
//   • المدخلات ثلاثة صفوف jsonb يجلبها `business-snapshot.js` أصلاً (اليوم:
//     76 زبوناً/622 فاتورة، و300 صف أرصدة). الحجم لا يبرر aggregation في القاعدة.
//   • تنفيذ القواعد التجارية مرتين (JS للواجهة + SQL للـRPC) يعني مصدرَي حقيقة
//     يتباعدان بصمت — وهذا بالضبط ما تمنعه قاعدة «الحساب deterministic وواحد».
//   • الأمان لا يتحسّن بنقل الحساب للقاعدة: `inventory_reports` مقروء أصلاً لكل
//     `is_staff()`، فالمدخلات ليست سراً يكشفه الحساب. ما يحمي هذه الميزة هو
//     بوابة المسار للمالك فقط + سياسة `deny_inventory_counter_access` القائمة.
//   • هذا الملف يعمل تحت Node عبر `vm` بلا شبكة، فتُختبر كل القواعد في
//     `npm run check` — وهو ما لا يوفّره RPC.
// المخرج جاهز للاستهلاك الآلي عبر `buildCoworkPayload()` (JSON ثابت الشكل).
//
// المصادر:
//   inventory_reports.source = 'ameen_customer_invoices'  → مبيعات/مرتجعات وأسطرها
//   inventory_reports.source = 'ameen_customer_balances'   → الرصيد + حد الأمين + GUID
//   inventory_reports.source = 'ameen_customer_movements'  → حركات الحساب (سياق فقط)
//   customer_credit_limits                                  → الحد المعتمد داخلياً
// ============================================================================
(function () {
  "use strict";

  const SCHEMA_VERSION = 1;

  // --------------------------------------------------------------------------
  // إعدادات التصنيف — كل عتبة هنا، لا أرقام سحرية مبعثرة في الكود.
  // --------------------------------------------------------------------------
  const CONFIG = Object.freeze({
    // طول الفترة الحالية والفترة المقارَنة (يوم).
    periodDays: 30,

    // حداثة كل مصدر بالدقائق — مطابقة لـ private.project_task_monitors
    // في supabase/project-task-health-monitor.sql (customer-balances=10،
    // customer-movements=30، customer-invoices=90). لا تغيّرها هنا وحدها.
    freshnessMinutes: Object.freeze({
      balances: 10,
      movements: 30,
      invoices: 90
    }),

    // عملة الأساس المحاسبي في الأمين (docs/ai/topics/customer-balances.md).
    baseCurrency: "USD",

    // ── الخمول (Inactive) ──────────────────────────────────────────────────
    // نحسب نمط الشراء المعتاد للزبون بدل عتبة واحدة للجميع.
    minPurchasesForCadence: 3,      // ≥3 مشتريات ⇒ ≥2 فجوة ⇒ وسيط ذو معنى
    inactiveGapMultiplier: 2,       // متوقف إذا تجاوز الغياب ضعف فجوته المعتادة
    inactiveMinimumDays: 14,        // ولا نعتبره متوقفاً قبل هذا مهما صغرت فجوته
    inactiveFallbackDays: 30,       // عند تعذّر حساب النمط (تاريخ غير كافٍ)
    churnRiskGapMultiplier: 1.5,    // تحذير مبكر قبل بلوغ حد الخمول

    // ── التراجع (Declining) ────────────────────────────────────────────────
    declineTrendPercent: -25,       // انخفاض صافي المبيعات المطلوب
    growthTrendPercent: 25,         // النمو المقابل (flag فقط)
    declineMinPreviousInvoices: 2,  // فاتورة واحدة سابقة ليست نمطاً
    // أرضية ضوضاء **نسبية** لا رقم دولار من الرأس: ربع وسيط مبيعات الفترة
    // السابقة عبر الزبائن الفاعلين.
    declineMinPreviousShareOfMedian: 0.25,

    // ── VIP ─────────────────────────────────────────────────────────────────
    // نسبي بحت: أعلى 20% من درجة مركّبة (قيمة + تكرار + استمرارية).
    vipTopShare: 0.2,
    vipMinInvoices: 2,
    vipMinPopulation: 5,            // تحت هذا العدد الترتيب النسبي غير موثوق
    vipWeights: Object.freeze({ value: 0.6, frequency: 0.25, continuity: 0.15 }),

    // ── الائتمان ────────────────────────────────────────────────────────────
    // مطابق لـ business-snapshot.js/buildReceivables — لا نظام ثانٍ متناقض.
    nearLimitRatio: 0.9,

    // ── حد الائتمان الآلي (STEP 1) ─────────────────────────────────────────
    // الحد المحسوب = سرعة السحب اليومية × دورة السداد الفعلية × جودة السداد ×
    // الاتجاه، مع ضوابط المخاطر. لا حد يدوي ولا تنعيم زمني هنا: التنعيم الأسبوعي
    // (+25%/−40%) يحتاج تاريخاً مخزَّناً للحد الجديد، وهو STEP 2.
    // المصدر: دفتر حساب الزبون (ameen_customer_movements) بعملة الأساس.
    autoCredit: Object.freeze({
      salesWindowDays: 60,
      recentDays: 30,
      weightRecent: 0.6,
      weightPrior: 0.4,
      largeInvoiceMinCount: 4,         // حارس الفاتورة الشاذة يعمل من 4 فواتير فأكثر
      largeInvoiceMaxShare: 0.35,      // أكبر فاتورة لا تساهم بأكثر من 35% من سحب 60 يوماً
      settleTolerance: 0.5,            // بقايا تقريب (عملة الأساس) لا تُبقي فاتورة مفتوحة
      cycleMinObservations: 3,
      portfolioMinDebits: 5,           // زبون يدخل إحصاء المحفظة من 5 فواتير فأكثر
      portfolioMinSample: 5,
      cycleFloorPercentile: 0.1,       // أرضية الدورة = P10 المحفظة (ولا تقل عن يوم)
      cycleCapPercentile: 0.9,         // سقف الدورة = P90 المحفظة
      cycleFallbackMedianDays: 7,      // احتياط حين تكون المحفظة أصغر من أن تُقاس
      cycleFallbackCapDays: 30,
      peakHeadroomMax: 1.5,            // هامش الذروة (p75) بحد أقصى 1.5× الوسيط
      coverageFloor: 0.8,
      coverageFull: 1,
      growthMinCoverage: 0.9,          // تحت 90% تحصيل: لا رفع بالنمو ولا هامش ذروة
      qualityWeights: Object.freeze({ coverage: 0.4, punctuality: 0.3, risk: 0.3 }),
      qualityMin: 0.35,
      qualitySpan: 0.8,                // Q ∈ [0.35, 1.15]
      balanceRiskFreeRatio: 1.25,      // الرصيد حتى 1.25× التعرض المعتاد طبيعي
      accumulationFreeShare: 0.25,     // تراكم الرصيد حتى 25% من سحب 30 يوماً طبيعي
      trendSlope: 0.3,
      trendMin: 0.8,
      trendMax: 1.1,
      lowDataMinDebits: 4,
      lowDataMinAgeDays: 45,
      lowDataDrawShare: 0.5,
      lowDataMedianMultiple: 2,
      delinquentCycleMultiple: 2,      // متأخر = أقدم من max(2× الدورة، الدورة + 14)
      delinquentMarginDays: 14,
      delinquentPaidShare: 0.5,        // ودفعات تلك المدة أقل من نصف المتأخر
      delinquentMinAmount: 50,         // دين متأخر دون 50 (عملة الأساس) بقايا لا تعثّر
      // عدم تطابق سحب الدفتر مع فواتير المبيع: مؤشر شذوذ لا مصنِّف (قرار المالك
      // 2026-09-27) — يُعلَّم الحساب «يحتاج مراجعة» بلا حد آلي، ولا يُسمّى «ليس زبوناً».
      salesInvoiceMinShare: 0.5,
      // دور مختلط (قرار المالك 2026-09-28): تحت lineKinds:v1، مشترياتنا من حساب زبون ≥ حد
      // الأهمية (delinquentMinAmount) و≥ 5% من (المشتريات + المبيعات) في تقرير الحركات ⇒
      // «يحتاج مراجعة» بلا حد آلي. لا يلغي التعثّر الحقيقي. 5% تفصل البيانات الحية بوضوح:
      // أقل حصة لمختلط حقيقي 18% والتالي 3.3%.
      mixedRolePurchaseMinShare: 0.05,
      // تحصيل دين قديم (قرار المالك 2026-09-28): وسم وصفي لا إعفاء. ≥ 80% من الرصيد دين قديم
      // (افتتاحي/منقول/مبيعات قبل نافذة السحب)، و≥ دفعتا قبض حقيقيتان (payment/receipt)
      // خلال 60 يوماً، وآخرهما ≤ 30 يوماً. يستبدل «تجاوز/قرب الحد» المضلل، ولا يمسّ التعثّر.
      oldDebt: Object.freeze({ minOldShare: 0.8, minReceipts: 2, receiptWindowDays: 60, lastReceiptMaxDays: 30 }),
      // حسابات أكّد المالك (2026-09-27) أنها ليست زبائن مبيعات (معرّف cu000).
      // هذه القائمة وحدها تصنّف «ليس زبون مبيعات». تُستبعد من الحد ومن عيّنة المحفظة.
      excludedAccountGuids: Object.freeze([
        "ababf0d4-dea5-4a39-8a80-8329635d7a0c", // قناة مبيع داخلية بفواتير مبيع عادية
        "1ef73b39-df30-4c3c-bea2-9ff0ded75064", // فروقات جرد
        "7a1f9a5a-00bc-445f-949a-e4ce8d306585"  // سلفة موظف ورواتب
      ]),
      // حسابات مختلطة أكّدها المالك (مورد وزبون على الحساب نفسه): حركتها تحوي
      // مشتريات ومدفوعات مورد لا تُفصل بأمان من تقرير الحركات الحالي، فلا حد آلي
      // ولا دخول في عيّنة المحفظة حتى يتوفر نوع المستند في المصدر.
      reviewAccountGuids: Object.freeze([
        "ece6ec27-b889-4441-adce-59a4fda5ccef"
      ])
    }),

    // ── تاريخ الحد (STEP 2) ─────────────────────────────────────────────────
    // لقطة يومية لكل زبون في customer_credit_history (يكتبها الخادم وحده:
    // supabase/functions/customer-credit-snapshot). المحرك يقرأ اللقطات السابقة
    // ليوم المرجع فقط (لا لقطة اليوم نفسه)، فيطابق حساب المتصفح حساب الخادم.
    creditHistory: Object.freeze({
      lookbackDays: 21,                // لقطات أقدم من 21 يوماً لا تدخل الحساب
      smoothingWindowDays: 7,          // التنعيم أسبوعي: الأساس لقطة عمرها ≥ 7 أيام
      maxWeeklyIncrease: 0.25,         // الحد لا يرتفع أكثر من +25% بالأسبوع
      maxWeeklyDecrease: 0.4,          // ولا ينزل أكثر من −40% بالأسبوع (التعثّر يصفّره فوراً)
      riskTrendSnapshots: 7,           // اتجاه الخطر من آخر 7 لقطات (مع لقطة اليوم)
      riskTrendMinSnapshots: 3,        // أقل من 3 نقاط: لا اتجاه
      riskTrendThreshold: 5,           // تغيّر الخطر على امتداد النقاط ≥ 5 درجات ⇒ صاعد/نازل
      secondaryFactorShare: 0.3        // عامل ثانٍ يُذكر في التفسير إن بلغ 30% من أثر الأول
    }),

    // ── تنبيه غياب الزبون المهم (CUSTOMER_INACTIVE_5D) ──────────────────────
    // «مهم» = أعلى 20% بصافي مشتريات 60 يوماً داخل عملته (عيّنة VIP نفسها وشرط
    // موثوقيتها: ≥ 5 مرشحين) أو شراء منتظم (≥ 4 أيام شراء في آخر 30 يوماً).
    // الموردون و«ليس زبون مبيعات» خارجه. المرتجع ليس شراءً.
    keyCustomerAlert: Object.freeze({
      inactiveDays: 5,                 // غياب ≥ 5 أيام بلا فاتورة بيع ⇒ تنبيه
      valueTopShare: 0.2,              // أعلى 20% بصافي المشتريات لكل عملة
      regularMinPurchaseDays: 4,       // أيام شراء متمايزة في آخر periodDays
      customersPerMessage: 20,         // رسالة يومية واحدة، تُقسَّم كل 20 زبوناً (حد تيليغرام)
      messageDedupeMinutes: 1440       // إعادة التشغيل في اليوم نفسه لا تكرّر الرسالة
    }),

    // ── جديد ────────────────────────────────────────────────────────────────
    // هامش أمان بعد بداية نافذة التقرير: من ظهر أول مرة داخل الأيام الأولى قد
    // يكون قديماً وسبقت مشترياتُه النافذة، فلا ندّعي أنه جديد.
    newCustomerEdgeGraceDays: 3,

    topItemsLimit: 5
  });

  // --------------------------------------------------------------------------
  // أدوات صغيرة (لا اعتماديات خارجية — يعمل الملف تحت المتصفح وNode معاً)
  // --------------------------------------------------------------------------
  const text = (value) => String(value ?? "").trim();

  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const numberOrZero = (value) => numberOrNull(value) ?? 0;

  // الأمين يخزّن u.Total / u.TotalDisc / أسطر bi000 بعملة الأساس (دولار).
  // المبلغ بعملة الفاتورة = الخام ÷ CurrencyVal (نفس watcher.js). بلا معدّل
  // صالح لا تُوسم الفاتورة بـISO أجنبي — الأرقام تبقى أساس.
  const invoiceCurrencyVal = (invoice) => {
    const parsed = numberOrNull(invoice?.currencyVal ?? invoice?.currency_val);
    return parsed !== null && parsed > 0 ? parsed : null;
  };
  const toInvoiceCurrency = (amount, currencyVal) => (
    currencyVal === null ? amount : amount / currencyVal
  );
  const invoiceCurrencyCode = (invoice) => {
    const iso = text(invoice?.currency).toUpperCase();
    if (!iso || iso === CONFIG.baseCurrency) return iso || null;
    return invoiceCurrencyVal(invoice) === null ? null : iso;
  };

  const round = (value, digits = 2) => {
    const factor = Math.pow(10, digits);
    return Math.round((numberOrZero(value) + Number.EPSILON) * factor) / factor;
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // نفس تطبيع الأسماء المستعمل في src/app.js (customerKey) وفي
  // tools/ameen-sync-agent.ps1 (Normalize-ItemName). تغييره هنا وحده يكسر الربط.
  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .replace(/^\d{2,}\s*[-–—]\s*/u, "")
      .replace(/[ـًٌٍَُِّْ]/gu, "")
      .replace(/[إأآٱ]/gu, "ا")
      .replace(/ى/gu, "ي")
      .replace(/ة/gu, "ه")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeGuid(value) {
    const normalized = text(value).toLowerCase();
    if (normalized === "00000000-0000-0000-0000-000000000000") return "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized) ? normalized : "";
  }

  function isoOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  // تواريخ الأمين تصل كسلسلة يوم بلا منطقة زمنية ("2026-08-31" أو
  // "2026-08-31T00:00:00.0000000"). نقارنها كأيام UTC حصراً حتى لا تنزلق
  // الحدود بيوم كامل حسب منطقة جهاز المستخدم.
  const DAY_MS = 86400000;

  function dayKey(value) {
    const raw = text(value);
    if (!raw) return null;
    const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString().slice(0, 10);
  }

  function dayNumber(value) {
    const key = dayKey(value);
    if (!key) return null;
    const time = Date.parse(`${key}T00:00:00.000Z`);
    return Number.isNaN(time) ? null : Math.round(time / DAY_MS);
  }

  function dayNumberToKey(value) {
    if (!Number.isFinite(value)) return null;
    return new Date(value * DAY_MS).toISOString().slice(0, 10);
  }

  function median(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // ترتيب مئوي بمنهج «أقل من أو يساوي» مع معالجة التعادل بالمتوسط، فلا يتغيّر
  // الناتج بتغيّر ترتيب المدخلات (شرط الـdeterminism).
  function percentileRank(sortedAscending, value) {
    if (!sortedAscending.length) return 0;
    let below = 0;
    let equal = 0;
    for (const entry of sortedAscending) {
      if (entry < value) below += 1;
      else if (entry === value) equal += 1;
    }
    return round(((below + equal / 2) / sortedAscending.length) * 100, 2);
  }

  // سبب تعذّر الحد الآلي حين يكون أحد مصدريه (الدفتر أو الأرصدة) غير حديث.
  function staleCreditNote(source, sourcesFreshness) {
    if (source === "accounting_day") return ACCOUNTING_DAY_NOTE;
    const label = source === "movements" ? "دفتر الحركات" : source === "invoices" ? "تقرير الفواتير" : "تقرير الأرصدة";
    const age = sourcesFreshness[source].ageMinutes;
    return age === null
      ? `${label} بلا وقت مزامنة معروف: لا حد آلي من بيانات غير مؤكدة الحداثة.`
      : `${label} غير حديث (آخر مزامنة قبل ${age} دقيقة): لا حد آلي من بيانات قديمة.`;
  }

  const ACCOUNTING_DAY_NOTE = "الحد الآلي غير متاح: الفواتير والحركات والأرصدة لا تمثل يوم المحاسبة المحلي نفسه (report_date)، فلا يُدمج يومان ولا تُخمَّن مبيعات ناقصة.";

  function freshnessOf(asOf, maxAgeMinutes, now) {
    if (!asOf) return { asOf: null, ageMinutes: null, maxAgeMinutes, state: "unknown", stale: true };
    const ageMinutes = Math.max(0, Math.round((now.getTime() - new Date(asOf).getTime()) / 60000));
    const stale = ageMinutes > maxAgeMinutes;
    return { asOf, ageMinutes, maxAgeMinutes, state: stale ? "stale" : "fresh", stale };
  }

  // --------------------------------------------------------------------------
  // قيمة سطر الفاتورة (عملة الأساس، قبل ÷ CurrencyVal).
  //
  // `bi000.Qty` مخزّنة دائماً بالوحدة الأولى (كروز)، و`bi000.Price` سعر **وحدة
  // إدخال السطر** (`bi000.Unity` ⇐ `inputUnit`: 1/2/3). فالقيمة = Price × Qty ÷
  // معامل تلك الوحدة — نفس قاعدة `invoiceLineInputUnit` في src/app.js (مثبتة على
  // الأمين الحي: طابقت إجمالي 658/658 فاتورة). `lineTotal` في الحمولة الحالية
  // `derived` = Qty × Price بلا قسمة، فسطر الكرتونة يتضخّم بمعامل الوحدة (50):
  // هذا بالضبط ما نفخ «أهم الأصناف» إلى مئات الآلاف.
  //
  //   1) inputUnit صالح + سعر ⇒ Price × Qty ÷ factor           (basis "input_unit")
  //   2) بلا inputUnit، و lineTotal من عمود إجمالي حقيقي أو حمولة قديمة بلا
  //      lineTotalSource ⇒ lineTotal كما هو                       (basis "stored")
  //   3) بلا inputUnit و lineTotalSource = "derived" ⇒ لا قيمة موثوقة: null
  //      (basis "unverified") — لا رقم مضخَّم يُعرض كأنه حقيقة.
  // --------------------------------------------------------------------------
  function lineValueOf(line) {
    const unit = Number(line?.inputUnit);
    const price = numberOrNull(line?.price);
    const qty = numberOrZero(line?.qty);
    if (price !== null && (unit === 1 || unit === 2 || unit === 3)) {
      const factor = unit === 1 ? 1 : numberOrNull(unit === 2 ? line?.unit2Fact : line?.unit3Fact);
      if (factor !== null && factor > 0) return { amount: (price * qty) / factor, basis: "input_unit" };
    }
    if (text(line?.lineTotalSource).toLowerCase() === "derived") return { amount: null, basis: "unverified" };
    return { amount: numberOrZero(line?.lineTotal), basis: "stored" };
  }

  // --------------------------------------------------------------------------
  // قراءة الفواتير: تسطيح تقرير ameen_customer_invoices إلى صفوف موحّدة.
  //
  // قيمة الفاتورة التجارية = Total − TotalDisc.
  //   • Total في الأمين = مجموع الأسطر قبل الحسم (موثّق في push-customer-invoices.ps1).
  //   • TotalDisc قيمة نقدية لا نسبة، وهي حسم فعلي على البيع ⇒ تُطرح.
  //   • FirstPay دفعة نقدية عند الفاتورة، ليست تخفيضاً للمبيعات ⇒ تُتابع منفصلة.
  // المرتجع (isReturn ⇐ BillType=3) يُطرح ولا يُحسب مبيعاً موجباً أبداً.
  // --------------------------------------------------------------------------
  function flattenInvoices(report) {
    const items = Array.isArray(report?.items) ? report.items : [];
    const rows = [];
    // مجموعات اقتُطعت (truncated=true) في push-customer-invoices.ps1 لأن فواتيرها
    // تجاوزت MaxInvoicesPerCustomer — نتتبّع مفتاحها لنُعطّل usableSales لاحقاً.
    const truncatedGuids = new Set();
    const truncatedNameKeys = new Set();

    for (const group of items) {
      const groupName = text(group?.name);
      const groupGuid = normalizeGuid(group?.customerGuid ?? group?.customer_guid);
      if (group?.truncated === true) {
        if (groupGuid) truncatedGuids.add(groupGuid);
        else truncatedNameKeys.add(normalizeName(groupName));
      }
      const invoices = Array.isArray(group?.invoices) ? group.invoices : [];

      for (const invoice of invoices) {
        const day = dayNumber(invoice?.date);
        if (day === null) continue;

        const isReturn = invoice?.isReturn === true;
        const sign = isReturn ? -1 : 1;
        const currencyVal = invoiceCurrencyVal(invoice);
        const total = toInvoiceCurrency(numberOrZero(invoice?.total), currencyVal);
        const discount = toInvoiceCurrency(numberOrZero(invoice?.discount), currencyVal);
        const gross = total - discount;
        // معرّف الزبون على مستوى الفاتورة إن وفّرته المزامنة، وإلا معرّف المجموعة.
        const guid = normalizeGuid(invoice?.customerGuid ?? invoice?.customer_guid) || groupGuid;
        const currency = invoiceCurrencyCode(invoice);

        const lines = (Array.isArray(invoice?.lines) ? invoice.lines : []).map((line) => {
          const value = lineValueOf(line);
          return {
            itemGuid: normalizeGuid(line?.itemGuid ?? line?.item_guid),
            material: text(line?.material),
            qty: numberOrZero(line?.qty),
            qtyUnits: numberOrNull(line?.qtyUnits),
            unit1: text(line?.unit1),
            unit2: text(line?.unit2),
            unit2Fact: numberOrNull(line?.unit2Fact),
            lineValue: value.amount === null ? null : toInvoiceCurrency(value.amount, currencyVal),
            valueBasis: value.basis
          };
        });

        rows.push({
          customerName: groupName,
          customerGuid: guid,
          nameKey: normalizeName(groupName),
          day,
          date: dayNumberToKey(day),
          isReturn,
          sign,
          currency,
          currencyVal,
          netValue: round(sign * gross, 3),
          grossValue: round(gross, 3),
          firstPay: toInvoiceCurrency(numberOrZero(invoice?.payment), currencyVal),
          number: text(invoice?.number),
          guid: text(invoice?.guid),
          lines
        });
      }
    }

    return { rows, truncatedGuids, truncatedNameKeys };
  }

  // --------------------------------------------------------------------------
  // هوية الزبون.
  //
  // القاعدة: `customerGuid` من الأمين هو المعرّف الرسمي. اسم الزبون مفتاح ربط
  // احتياطي فقط لأن تقرير الفواتير الحالي لا يحمل GUID (يُضاف إليه لاحقاً عبر
  // push-customer-invoices.ps1). وإذا قاد اسمٌ واحد إلى أكثر من GUID فالدمج
  // ممنوع: كل GUID سجل مستقل، وبيانات المبيعات المعرَّفة بالاسم وحده لا تُنسب
  // لأيّ منهم.
  // --------------------------------------------------------------------------
  function buildIdentityIndex(balanceItems) {
    const byGuid = new Map();
    const nameToGuids = new Map();
    const nameOnly = new Map();

    for (const item of balanceItems) {
      const guid = normalizeGuid(item?.customerGuid ?? item?.customer_guid);
      const name = text(item?.name ?? item?.customerName);
      const key = text(item?.key) || normalizeName(name);
      if (!key && !guid) continue;

      const record = {
        customerGuid: guid || null,
        customerName: name || key,
        nameKey: key,
        balanceRow: item
      };

      if (guid) {
        if (!byGuid.has(guid)) byGuid.set(guid, record);
        if (!nameToGuids.has(key)) nameToGuids.set(key, new Set());
        nameToGuids.get(key).add(guid);
      } else if (key && !nameOnly.has(key)) {
        nameOnly.set(key, record);
      }
    }

    const ambiguousNames = new Set();
    for (const [key, guids] of nameToGuids) if (guids.size > 1) ambiguousNames.add(key);

    return { byGuid, nameToGuids, nameOnly, ambiguousNames };
  }

  // --------------------------------------------------------------------------
  // نافذة الزمن.
  //
  // نقطة الإسناد ليست "اليوم" بل لحظة صلاحية التقرير (syncedAt ← created_at)،
  // لأن التقرير لقطة: لو تأخّرت المزامنة يوماً لصار "آخر 30 يوماً" نافذة كاذبة.
  // تقادم المصدر يظهر في freshness لا في تحريك النافذة.
  // --------------------------------------------------------------------------
  function resolveWindow(invoicesReport, invoiceRows, now) {
    const summary = invoicesReport?.summary || {};
    const referenceIso = isoOrNull(summary.syncedAt)
      || isoOrNull(invoicesReport?.created_at ?? invoicesReport?.createdAt)
      || isoOrNull(invoicesReport?.report_date ?? invoicesReport?.reportDate);

    const maxInvoiceDay = invoiceRows.reduce((max, row) => (max === null || row.day > max ? row.day : max), null);
    // يوم المرجع هو يوم المحاسبة المحلي (`report_date` بتوقيت جهاز الأمين)، لا تاريخ UTC من
    // `syncedAt`: بين منتصف الليل المحلي ومنتصف ليل UTC يسمّي `syncedAt` اليوم السابق فتخرج
    // فواتير اليوم من النافذة. `syncedAt` يبقى للحداثة وحدها.
    const localReportDay = dayNumber(invoicesReport?.report_date ?? invoicesReport?.reportDate);
    const referenceDay = localReportDay ?? dayNumber(referenceIso) ?? maxInvoiceDay ?? dayNumber(now.toISOString());

    const period = CONFIG.periodDays;
    const currentStart = referenceDay - period + 1;   // شامل
    const previousEnd = currentStart - 1;             // شامل
    const previousStart = previousEnd - period + 1;   // شامل

    // أقدم يوم تغطيه البيانات فعلاً: `fromDate` من ملخص التقرير هو الحقيقة،
    // وأقدم فاتورة موجودة حدٌّ أدنى احتياطي.
    const declaredFromDay = dayNumber(summary.fromDate);
    const minInvoiceDay = invoiceRows.reduce((min, row) => (min === null || row.day < min ? row.day : min), null);
    const coverageStartDay = declaredFromDay ?? minInvoiceDay;

    const coverageDays = coverageStartDay === null ? null : referenceDay - coverageStartDay + 1;
    // المقارنة تحتاج الفترة السابقة كاملة، وإلا فالنسبة تقارن نافذتين غير متكافئتين.
    const previousWindowCovered = coverageStartDay !== null && coverageStartDay <= previousStart;

    return {
      referenceIso: referenceIso || now.toISOString(),
      referenceDay,
      referenceDate: dayNumberToKey(referenceDay),
      periodDays: period,
      currentStart,
      currentStartDate: dayNumberToKey(currentStart),
      previousStart,
      previousStartDate: dayNumberToKey(previousStart),
      previousEnd,
      previousEndDate: dayNumberToKey(previousEnd),
      coverageStartDay,
      coverageStartDate: coverageStartDay === null ? null : dayNumberToKey(coverageStartDay),
      coverageDays,
      previousWindowCovered
    };
  }

  // --------------------------------------------------------------------------
  // الاتجاه: يعالج القسمة على صفر صراحةً بدل أن يُنتج Infinity/NaN.
  // --------------------------------------------------------------------------
  function trendOf(current, previous, previousCovered) {
    if (!previousCovered) return { percent: null, state: "insufficient_data" };
    if (previous > 0) {
      return { percent: round(((current - previous) / previous) * 100, 2), state: "measured" };
    }
    if (current > 0) return { percent: null, state: "new_activity" };
    if (current === 0 && previous === 0) return { percent: null, state: "no_activity" };
    // previous ≤ 0 (مرتجعات تفوق المبيعات) و current ≤ 0 — لا نسبة ذات معنى.
    return { percent: null, state: "no_positive_baseline" };
  }

  // --------------------------------------------------------------------------
  // دفتر حساب الزبون (ameen_customer_movements) — مصدر حد الائتمان الآلي.
  //
  // كل الحركات بعملة الأساس. تصنيف الدائن لمقاييس السداد من `lineKind` (نوع
  // المستند + الحساب المقابل من المصدر) لا من النص، ولا يُوثق به إلا حين يحمل
  // التقرير العلامة `summary.lineKinds = "v1"` (push-customer-movements.ps1).
  // بلا العلامة يبقى السلوك الحالي: billGuid = مرتجع، والافتتاحي يسوّي ولا يُعدّ
  // دفعة، وأي دائن آخر دفعة. الربط بالمعرّف وحده — لا اسم.
  // --------------------------------------------------------------------------
  const OPENING_ENTRY = /افتتاح/u;
  const LINE_KINDS_MARKER = "v1";
  // تصنيف الحساب من شجرة دليل الحسابات في الأمين (tools/ameen-customer-balances-query.sql،
  // بالانتماء الشجري بالمعرّف لا بالاسم). لا يُوثق به إلا بعلامة summary.accountClasses = "v1".
  const ACCOUNT_CLASSES_MARKER = "v1";
  const OLD_DEBT_NOTE = (info) => `تحصيل دين قديم: ${Math.round((info?.oldShare ?? 0) * 100)}% من الرصيد دين سابق يُسدَّد بانتظام (${info?.receipts60 ?? 0} دفعات خلال 60 يوماً، آخرها قبل ${info?.lastReceiptDays ?? "?"} يوماً). الدين قائم ولم يُسدَّد، والحد الآلي مبني على مبيعاته الحديثة.`;
  const NON_CUSTOMER_ACCOUNT_CLASSES = Object.freeze({
    employee: "سلف/رواتب موظفين", asset: "موجودات ثابتة أو نقدية", expense: "مصاريف",
    revenue: "إيرادات/صافي المبيعات", cost: "تكلفة المبيعات", goods: "البضاعة"
  });
  const UNTYPED_LEDGER_NOTE = "الحد الآلي غير متاح: تقرير الحركات لا يحمل نوع كل حركة (lineKinds:v1) بعد، فلا يُبنى حد ولا حكم تعثّر من دفتر يخلط الحسم والمشتريات بالدفعات.";
  // تحت lineKinds:v1 (قرار المالك 2026-09-27): دفعة الزبون وحدها تدخل التغطية والجودة
  // والانتظام واختبار التعثّر؛ sale_payment هو الاسم القانوني لدفعة البيع، وpayment/
  // receipt للتوافق. المرتجع والحسم ونقل الدين والتسوية تُنقص الدين (FIFO) ولا تُعدّ
  // دفعة. الشراء ودفعاتنا للحساب وunknown لا دفعة ولا تسوية: لا تُحسّن أي مؤشر سداد.
  const PAYMENT_LINE_KINDS = new Set(["sale_payment", "payment", "receipt"]);
  const SETTLE_LINE_KINDS = new Set(["discount", "debt_transfer", "adjustment", "opening"]);
  // جانب المدين تحت v1: قائمة سماح صريحة — sale وحده سحب (Sales Velocity، الدورة، الفاتورة
  // الشاذة). جانب الشراء (مشترياتنا ودفعاتنا للحساب ومرتجع المشتريات) خارج دفتر الزبون
  // كلياً كنظيره الدائن: لا سحب ولا دين FIFO. وغير المحسوم (unknown/other) لا سحب ولا دين.
  // وما سوى ذلك دين حقيقي بلا سحب.
  const SALE_LINE_KINDS = new Set(["sale"]);
  const PURCHASE_SIDE_LINE_KINDS = new Set(["purchase", "purchase_payment", "purchase_return", "payment_out"]);
  // مفردات عقد المصدر (#278، v1). أي قيمة خارجها تُقرأ unknown.
  const KNOWN_LINE_KINDS = new Set(["sale", "sale_payment", "payment", "receipt", "discount", "return", "purchase",
    "purchase_payment", "purchase_return", "payment_out", "opening", "debt_transfer", "adjustment", "other", "unknown"]);

  // حركة محاسبية غير محسومة من منظور الائتمان (قرار المالك 2026-09-27): unknown، وother
  // (حساب مقابل لم يثبت نوعه). لا سحب ولا دفعة ولا تسوية ولا دين، وأثرها المادي يوقف الحد.
  const UNRESOLVED_LINE_KINDS = new Set(["unknown", "other"]);

  function normalizeLineKind(value) {
    const kind = text(value).toLowerCase();
    return KNOWN_LINE_KINDS.has(kind) ? kind : "unknown";
  }

  function ledgerIndex(movementsReport) {
    const byGuid = new Map();
    let startDay = null;
    const items = Array.isArray(movementsReport?.items) ? movementsReport.items : [];
    const reportFromDay = dayNumber(movementsReport?.summary?.fromDate);
    const lineKindsTrusted = text(movementsReport?.summary?.lineKinds) === LINE_KINDS_MARKER;
    for (const item of items) {
      const guid = normalizeGuid(item?.customerGuid ?? item?.customer_guid);
      if (!guid || byGuid.has(guid)) continue;
      const rows = [];
      (Array.isArray(item?.movements) ? item.movements : []).forEach((movement, index) => {
        const day = dayNumber(movement?.date);
        const debit = numberOrZero(movement?.debit);
        const credit = numberOrZero(movement?.credit);
        if (day === null || (debit === 0 && credit === 0)) return;
        if (startDay === null || day < startDay) startDay = day;
        rows.push({
          day,
          index,
          debit,
          credit,
          isReturn: Boolean(text(movement?.billGuid ?? movement?.bill_guid)),
          isOpening: OPENING_ENTRY.test(text(movement?.notes)),
          lineKind: lineKindsTrusted ? normalizeLineKind(movement?.lineKind ?? movement?.line_kind) : null
        });
      });
      rows.sort((a, b) => a.day - b.day || a.index - b.index);
      // دين أقدم من نافذة التقرير (92 يوماً) لا يأتي حركةً بل openingBalance = الرصيد
      // قبل أول حركة معروضة. نضيفه قيداً افتتاحياً قبل بداية النافذة، وإلا خرج أقدم
      // دين من تسوية FIFO ومن التعثّر بمجرد أن تتجاوز النافذةُ القيدَ الافتتاحي.
      const carried = numberOrZero(item?.openingBalance ?? item?.opening_balance);
      if (Math.abs(carried) > CONFIG.autoCredit.settleTolerance) {
        const firstDay = rows.length ? rows[0].day : null;
        const day = Math.min(...[reportFromDay, firstDay].filter((value) => value !== null)) - 1;
        if (Number.isFinite(day)) {
          // تاريخه الاصطناعي يتحرك مع النافذة، فعمره الحقيقي مجهول و≥ عمر النافذة:
          // ageUnknown يحفظه متأخراً في كل لقطة لاحقة (لا يصغر عمره بتدحرج النافذة).
          rows.unshift({ day, index: -1, debit: Math.max(0, carried), credit: Math.max(0, -carried), isReturn: false, isOpening: true, ageUnknown: true, lineKind: null });
        }
      }
      // حجم الحركات المجهولة (مدين + دائن) — مادّيتها تحكم «يحتاج مراجعة» (build).
      const unknownAmount = rows.reduce((sum, row) => sum + (UNRESOLVED_LINE_KINDS.has(row.lineKind) ? row.debit + row.credit : 0), 0);
      byGuid.set(guid, { truncated: item?.truncated === true, rows, unknownAmount });
    }
    return { byGuid, startDay, lineKindsTrusted };
  }

  // مئين مرجّح بالمبلغ (أول قيمة يبلغ عندها الوزن التراكمي q من الإجمالي).
  function weightedQuantile(pairs, q) {
    const sorted = pairs.filter(([value, weight]) => Number.isFinite(value) && weight > 0).sort((a, b) => a[0] - b[0]);
    const total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
    if (!total) return null;
    let cumulative = 0;
    for (const [value, weight] of sorted) {
      cumulative += weight;
      if (cumulative >= total * q - 1e-9) return value;
    }
    return sorted[sorted.length - 1][0];
  }

  function interpolatedPercentile(values, q) {
    const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }

  // تسوية FIFO: المدين الجديد يُسدَّد أولاً من الدفعات المسبقة المعلّقة.
  function settleDebitFromAdvances(debit, advanceQueue, tolerance) {
    while (debit.remaining > tolerance && advanceQueue.length) {
      const advance = advanceQueue[0];
      const take = Math.min(advance.remaining, debit.remaining);
      advance.remaining -= take;
      debit.remaining -= take;
      if (debit.remaining <= tolerance) debit.settledDay = advance.day;
      if (advance.remaining <= tolerance) advanceQueue.shift();
    }
  }

  // تسوية FIFO: الدائن يسدّد أقدم مدين مفتوح أولاً، ويُعاد ما فاض عنه.
  function settleCreditAgainstOpen(amount, day, openQueue, tolerance) {
    let left = amount;
    while (left > tolerance && openQueue.length) {
      const debit = openQueue[0];
      const take = Math.min(left, debit.remaining);
      debit.remaining -= take;
      left -= take;
      if (debit.remaining <= tolerance) {
        debit.settledDay = day;
        openQueue.shift();
      }
    }
    return left;
  }

  // سطر مدين في الدفتر: سحب النافذة (حديث/سابق) ثم تسويته FIFO.
  // تصنيف سطر المدين: sale (سحب + دين FIFO)، debt (دين FIFO بلا سحب)، none (جانب الشراء).
  // بلا lineKind السلوك القديم: كل مدين غير افتتاحي سحب.
  function debitMetricKind(row) {
    if (UNRESOLVED_LINE_KINDS.has(row.lineKind)) return "none";
    if (row.isOpening) return "debt";
    if (!row.lineKind) return "sale";
    if (SALE_LINE_KINDS.has(row.lineKind)) return "sale";
    if (PURCHASE_SIDE_LINE_KINDS.has(row.lineKind)) return "none";
    return "debt";
  }

  function ledgerAddDebit(acc, row, span) {
    const metric = debitMetricKind(row);
    if (metric === "none") return;
    const isSale = metric === "sale";
    if (isSale) {
      acc.debitAmounts.push(row.debit);
      if (acc.firstDebitDay === null || row.day < acc.firstDebitDay) acc.firstDebitDay = row.day;
      if (span.inWindow(row.day)) {
        acc.windowDebits.push({ day: row.day, amount: row.debit });
        if (row.day >= span.recentStart) acc.salesRecent += row.debit;
        else acc.salesPrior += row.debit;
      }
    }
    const debit = { day: row.day, amount: row.debit, remaining: row.debit, isOpening: row.isOpening, isSale, ageUnknown: row.ageUnknown === true, settledDay: null };
    acc.debits.push(debit);
    settleDebitFromAdvances(debit, acc.advanceQueue, span.tolerance);
    if (debit.remaining > span.tolerance) acc.openQueue.push(debit);
  }

  // تصنيف سطر الدائن: payment (مقاييس السداد + FIFO)، return (مرتجع + FIFO)، settle
  // (FIFO وحدها)، none (لا هذا ولا ذاك). lineKind من المصدر الموسوم وحده — لا تخمين
  // من الملاحظات أو المبلغ أو تطابق فاتورة.
  function creditMetricKind(row) {
    if (row.lineKind) {
      if (PAYMENT_LINE_KINDS.has(row.lineKind)) return "payment";
      if (row.lineKind === "return") return "return";
      if (SETTLE_LINE_KINDS.has(row.lineKind)) return "settle";
      return "none";
    }
    if (row.isReturn) return "return";
    if (row.isOpening) return "settle";
    return "payment";
  }

  // سطر دائن في الدفتر: مرتجع أو دفعة أو تسوية فقط، ثم FIFO.
  function ledgerAddCredit(acc, row, span) {
    const metric = creditMetricKind(row);
    if (metric === "none") return;
    if (metric === "return") {
      if (span.inWindow(row.day)) acc.returns60 += row.credit;
    } else if (metric === "payment") {
      acc.paymentDays.add(row.day);
      acc.paymentsByDay.push({ day: row.day, amount: row.credit });
      if (acc.lastPaymentDay === null || row.day > acc.lastPaymentDay) acc.lastPaymentDay = row.day;
      if (span.inWindow(row.day)) acc.payments60 += row.credit;
    }
    const left = settleCreditAgainstOpen(row.credit, row.day, acc.openQueue, span.tolerance);
    if (left > span.tolerance) acc.advanceQueue.push({ day: row.day, remaining: left });
  }

  // متوسط الرصيد اليومي الموجب بين يومين شاملين (لـDSO).
  function averagePositiveBalance(rows, firstDay, lastDay) {
    let running = 0;
    let cursor = 0;
    let balanceDaysSum = 0;
    let balanceDays = 0;
    for (let day = firstDay; day <= lastDay; day += 1) {
      while (cursor < rows.length && rows[cursor].day <= day) {
        running += rows[cursor].debit - rows[cursor].credit;
        cursor += 1;
      }
      balanceDaysSum += Math.max(0, running);
      balanceDays += 1;
    }
    return balanceDays ? balanceDaysSum / balanceDays : 0;
  }

  // مقاييس موسومة بالنوع لسطر واحد (lineKinds:v1 وحده؛ بلا العلامة lineKind فارغ فلا أثر).
  function addLineKindFacts(kinds, row, span) {
    if (row.lineKind === "purchase") kinds.purchaseAmount += row.credit - row.debit;
    if (row.lineKind === "sale") kinds.saleAmount += row.debit;
    if (span.inWindow(row.day)) {
      if (row.lineKind === "sale_payment") kinds.salePayments60 += row.credit;
      if (row.lineKind === "return" || row.lineKind === "discount") kinds.returnsDiscounts60 += row.credit;
    }
    if ((row.lineKind === "payment" || row.lineKind === "receipt") && row.credit > 0) kinds.receiptDays.push(row.day);
  }

  // حقائق الزبون من دفتره: السحب، الدفعات، الرصيد، وأيام السداد بتسوية FIFO
  // (الدائن يسدّد أقدم مدين أولاً). الأمين لا يربط الدفعة بفاتورتها، فهذه
  // الطريقة المحاسبية المعيارية هي الربط الإحصائي المتاح.
  function ledgerFacts(entry, referenceDay, ledgerStartDay) {
    const A = CONFIG.autoCredit;
    const tolerance = A.settleTolerance;
    const recentStart = referenceDay - A.recentDays + 1;
    // النافذة: يوم المرجع وستون يوماً قبله (أعمار 0..60)، والسابقة أعمار 30..60 —
    // مطابق للمحاكاة المعتمدة.
    const windowStart = referenceDay - A.salesWindowDays;
    const span = { tolerance, recentStart, inWindow: (day) => day >= windowStart && day <= referenceDay };

    const acc = {
      salesRecent: 0,
      salesPrior: 0,
      returns60: 0,
      payments60: 0,
      lastPaymentDay: null,
      firstDebitDay: null,
      debitAmounts: [],
      windowDebits: [],
      paymentDays: new Set(),
      paymentsByDay: [],
      debits: [],
      openQueue: [],
      advanceQueue: []
    };
    let balance = 0;
    let balance30Ago = 0;
    // مقاييس موسومة بالنوع (lineKinds:v1 وحده؛ بلا العلامة lineKind فارغ فتبقى أصفاراً).
    const kinds = { purchaseAmount: 0, saleAmount: 0, salePayments60: 0, returnsDiscounts60: 0, receiptDays: [] };

    for (const row of entry.rows) {
      balance += row.debit - row.credit;
      addLineKindFacts(kinds, row, span);
      if (row.day <= referenceDay - A.recentDays) balance30Ago += row.debit - row.credit;
      if (row.debit > 0) ledgerAddDebit(acc, row, span);
      if (row.credit > 0) ledgerAddCredit(acc, row, span);
    }

    // أيام السداد لكل فاتورة (المفتوحة بعمرها الحالي — حد أدنى لا تخمين).
    const dtpPairs = acc.debits
      .filter((debit) => debit.isSale)
      .map((debit) => [(debit.settledDay ?? referenceDay) - debit.day, debit.amount]);
    const open = acc.debits.filter((debit) => debit.remaining > tolerance);
    const oldestOpenAge = open.length ? referenceDay - Math.min(...open.map((debit) => debit.day)) : null;

    const sortedPaymentDays = [...acc.paymentDays].sort((a, b) => a - b);
    const gaps = [];
    for (let index = 1; index < sortedPaymentDays.length; index += 1) gaps.push(sortedPaymentDays[index] - sortedPaymentDays[index - 1]);

    // متوسط الرصيد اليومي في نافذة السحب (لـDSO).
    const firstBalanceDay = Math.max(windowStart, ledgerStartDay ?? windowStart);
    const maxDebit = acc.windowDebits.reduce((best, debit) => (!best || debit.amount > best.amount ? debit : best), null);

    return {
      truncated: entry.truncated,
      unknownAmount: entry.unknownAmount ?? 0,
      purchaseAmount: Math.max(0, kinds.purchaseAmount),
      saleAmount: kinds.saleAmount,
      salePayments60: kinds.salePayments60,
      returnsDiscounts60: kinds.returnsDiscounts60,
      receiptDays: kinds.receiptDays,
      salesRecent: acc.salesRecent,
      salesPrior: acc.salesPrior,
      sales60: acc.salesRecent + acc.salesPrior,
      returns60: acc.returns60,
      payments60: acc.payments60,
      balance,
      balance30Ago,
      lastPaymentDay: acc.lastPaymentDay,
      firstDebitDay: acc.firstDebitDay,
      debitCount: acc.debitAmounts.length,
      windowDebitCount: acc.windowDebits.length,
      maxDebit60: maxDebit ? maxDebit.amount : 0,
      maxDebitIsRecent: maxDebit ? maxDebit.day >= recentStart : false,
      medianDebit: median(acc.debitAmounts),
      daysToPayMedian: weightedQuantile(dtpPairs, 0.5),
      daysToPayP75: weightedQuantile(dtpPairs, 0.75),
      paymentDayCount: sortedPaymentDays.length,
      paymentIntervalMedian: median(gaps),
      paymentsByDay: acc.paymentsByDay,
      open,
      oldestOpenAge,
      averageBalance60: averagePositiveBalance(entry.rows, firstBalanceDay, referenceDay),
      recentStart,
      windowStart
    };
  }

  // إحصاء المحفظة الحي: حدود الدورة من البيانات لا من رقم مختار (مطابق للمحاكاة
  // المعتمدة v5). العيّنة: زبائن فعليون لهم سحب، و≥ 5 فواتير، وليسوا دافعين مسبقاً.
  function portfolioCycleStats(factsList) {
    const A = CONFIG.autoCredit;
    const sample = factsList
      .filter((facts) => !facts.truncated && facts.sales60 > 0 && facts.debitCount >= A.portfolioMinDebits
        && facts.daysToPayMedian !== null && !(facts.balance < -A.settleTolerance && facts.payments60 >= facts.sales60))
      .map((facts) => Math.max(0, facts.daysToPayMedian));
    if (sample.length < A.portfolioMinSample) {
      return {
        sampleSize: sample.length,
        medianDays: A.cycleFallbackMedianDays,
        floorDays: 1,
        capDays: A.cycleFallbackCapDays,
        basis: "fallback"
      };
    }
    return {
      sampleSize: sample.length,
      medianDays: round(interpolatedPercentile(sample, 0.5), 2),
      floorDays: round(Math.max(1, interpolatedPercentile(sample, A.cycleFloorPercentile)), 2),
      capDays: round(interpolatedPercentile(sample, A.cycleCapPercentile), 2),
      basis: "portfolio"
    };
  }

  // تقريب تجاري للأسفل حسب حجم الحد وعملته — بلا كسور (مطابق للمحاكاة).
  function commercialRound(value, currency) {
    if (!(value > 0)) return 0;
    const steps = currency && currency !== CONFIG.baseCurrency
      ? [[10000000, 100000], [100000000, 500000], [Infinity, 1000000]]
      : [[1000, 100], [10000, 250], [Infinity, 500]];
    const step = steps.find(([below]) => value < below)[1];
    return Math.floor(value / step + 1e-9) * step;
  }

  // الدورة الديناميكية: وسيط أيام السداد (FIFO مرجّح بالمبلغ)، ثم وسيط الفاصل
  // بين الدفعات، ثم وسيط المحفظة.
  function autoCreditCycle(facts, stats) {
    const A = CONFIG.autoCredit;
    if (facts.debitCount >= A.cycleMinObservations && facts.daysToPayMedian !== null) {
      const cycleRaw = Math.max(0, facts.daysToPayMedian);
      return { cycleRaw, cycleBasis: "fifo_median", p75: Math.max(cycleRaw, facts.daysToPayP75 ?? cycleRaw) };
    }
    if (facts.paymentDayCount >= A.cycleMinObservations && facts.paymentIntervalMedian !== null) {
      return { cycleRaw: facts.paymentIntervalMedian, cycleBasis: "payment_interval", p75: null };
    }
    return { cycleRaw: stats.medianDays, cycleBasis: "portfolio_median", p75: null };
  }

  // الدين المتأخر: الأقدم من max(2×الدورة، الدورة + هامش)، ودفعات تلك المدة.
  function overdueFacts(facts, referenceDay, cycleDays) {
    const A = CONFIG.autoCredit;
    const overdueAfterDays = Math.max(cycleDays * A.delinquentCycleMultiple, cycleDays + A.delinquentMarginDays);
    // الدين المرحَّل من قبل النافذة (ageUnknown) متأخر في كل لقطة أياً كان حد الدورة؛
    // والتعثّر يبقى مشروطاً معه برصيد قائم وبدفعات لا تغطيه (computeAutoCredit).
    const overdueAmount = facts.open
      .filter((debit) => debit.ageUnknown || referenceDay - debit.day > overdueAfterDays)
      .reduce((sum, debit) => sum + debit.remaining, 0);
    const paidInOverdueSpan = facts.paymentsByDay
      .filter((payment) => payment.day > referenceDay - overdueAfterDays)
      .reduce((sum, payment) => sum + payment.amount, 0);
    return { overdueAfterDays, overdueAmount, paidInOverdueSpan };
  }

  // دائن/دفع مسبق: رصيده دائن ودفع ما سحب، أو يدفع قبل أن يسحب.
  function isPrepaidAccount(facts, balance) {
    const tolerance = CONFIG.autoCredit.settleTolerance;
    return (balance < -tolerance && facts.payments60 >= facts.sales60)
      || (balance <= tolerance && facts.daysToPayMedian !== null && facts.daysToPayMedian < 0);
  }

  // حارس الفاتورة الشاذة: فاتورة واحدة تتجاوز حصتها من السحب لا تنفخ السرعة.
  function largeInvoiceAdjustedDraw(facts, notes) {
    const A = CONFIG.autoCredit;
    const S60 = facts.sales60;
    let recent = facts.salesRecent;
    let prior = facts.salesPrior;
    // العدد من نافذة السحب نفسها (60 يوماً) لا من كامل تقرير الحركات (92): فواتير الأيام
    // 61–92 لا تجعل فاتورة النافذة الوحيدة «شاذة».
    if (facts.windowDebitCount >= A.largeInvoiceMinCount && facts.maxDebit60 > A.largeInvoiceMaxShare * S60) {
      const cut = facts.maxDebit60 - A.largeInvoiceMaxShare * S60;
      if (facts.maxDebitIsRecent) recent -= cut; else prior -= cut;
      notes.push(`حارس الفاتورة الشاذة خفّض أثر فاتورة ${Math.round(facts.maxDebit60)} بمقدار ${Math.round(cut)}.`);
    }
    return { recent, prior };
  }

  // سرعة السحب اليومية على الأيام الفعلية، والوتيرة المقارَنة بالرصيد.
  function drawVelocity(facts, age, draw) {
    const A = CONFIG.autoCredit;
    const fullWindow = age >= A.salesWindowDays;
    const activeDays = fullWindow ? A.salesWindowDays : age + 1;
    const velocity = fullWindow
      ? (A.weightRecent * draw.recent + A.weightPrior * draw.prior) / A.recentDays
      : (draw.recent + draw.prior) / activeDays;
    // الرصيد يتكوّن من فواتير حديثة، فيقارن بوتيرة آخر 30 يوماً إن كانت أعلى.
    const pace = Math.max(velocity, age >= A.recentDays ? facts.salesRecent / A.recentDays : velocity);
    return { fullWindow, activeDays, velocity, pace };
  }

  // هامش الذروة: لمن تحصيله ≥ 90% ورصيده ضمن المعتاد فقط — p75 بحد 1.5× الوسيط.
  function peakExposureCycle(cycle, coverage, balanceToCycle, stats, notes) {
    const A = CONFIG.autoCredit;
    const { cycleDays, p75 } = cycle;
    if (p75 === null || (coverage ?? 0) < A.growthMinCoverage || balanceToCycle > A.balanceRiskFreeRatio) return cycleDays;
    const peak = clamp(Math.min(p75, A.peakHeadroomMax * cycleDays), stats.floorDays, stats.capDays);
    if (!(peak > cycleDays)) return cycleDays;
    notes.push(`هامش ذروة: ${round(cycleDays, 1)} ← ${round(peak, 1)} يوماً (p75).`);
    return peak;
  }

  // جودة السداد Q: التغطية، والانضباط (أقدم دين مقابل موعده)، والرصيد كعامل مخاطر.
  function repaymentQuality(facts, balance, coverage, exposure) {
    const A = CONFIG.autoCredit;
    const { exposureCycle, pace } = exposure;
    const coverageScore = coverage === null ? 0 : clamp((coverage - A.coverageFloor) / (A.coverageFull - A.coverageFloor), 0, 1);
    const dueDays = exposureCycle * 1.5 + 3;
    const punctuality = facts.oldestOpenAge === null ? 1 : clamp(1 - (facts.oldestOpenAge - dueDays) / dueDays, 0, 1);
    const balanceRatio = exposure.amount > 0 ? Math.max(0, balance) / (pace * exposureCycle) : null;
    const balanceRisk = balanceRatio === null ? 1 : clamp(1 - (balanceRatio - A.balanceRiskFreeRatio), 0, 1);
    const s30 = facts.salesRecent;
    const accumulation = s30 > 0 ? (facts.balance - facts.balance30Ago) / s30 : 0;
    const accumulationRisk = clamp(1 - (accumulation - A.accumulationFreeShare) / 0.75, 0, 1);
    const risk = Math.min(balanceRisk, accumulationRisk);
    const W = A.qualityWeights;
    const quality = A.qualityMin + A.qualitySpan * (W.coverage * coverageScore + W.punctuality * punctuality + W.risk * risk);
    return { coverageScore, punctuality, balanceRatio, balanceRisk, accumulation, accumulationRisk, risk, quality };
  }

  // الاتجاه: عامل مستقل، ولا يرفع الحد مع تحصيل ضعيف أو رصيد غير معتاد.
  function autoCreditTrend(facts, fullWindow, coverage, risk, notes) {
    const A = CONFIG.autoCredit;
    const s30 = facts.salesRecent;
    const sb = facts.salesPrior;
    const trend = fullWindow && sb > 0 ? clamp(1 + A.trendSlope * (s30 / sb - 1), A.trendMin, A.trendMax) : 1;
    if (trend > 1 && ((coverage ?? 0) < A.growthMinCoverage || risk < 1)) {
      notes.push("زيادة السحب لم ترفع الحد: التحصيل أقل من 90% أو الرصيد أعلى من المعتاد.");
      return 1;
    }
    return trend;
  }

  // سقف التغطية ثم سقف البيانات غير الكافية (حد محافظ آلي).
  function cappedAutoLimit(limit, facts, age, capInputs, notes) {
    const A = CONFIG.autoCredit;
    const { exposure, coverage, quality } = capInputs;
    let capped = limit;
    let cappedBy = null;
    if (coverage !== null && coverage < A.growthMinCoverage) {
      const coverageCap = exposure * coverage * quality;
      if (capped > coverageCap) {
        capped = coverageCap;
        cappedBy = "coverage";
        notes.push(`سقف التغطية: التحصيل ${Math.round(coverage * 100)}% فقط.`);
      }
    }
    if (facts.debitCount >= A.lowDataMinDebits && age >= A.lowDataMinAgeDays) return { status: "normal", limit: capped, cappedBy };
    const cap = Math.min(A.lowDataDrawShare * facts.sales60, A.lowDataMedianMultiple * (facts.medianDebit ?? 0));
    if (capped > cap) { capped = cap; cappedBy = "low_data"; }
    notes.push("بيانات غير كافية: حد محافظ آلي (≤ نصف سحبه و≤ ضعف وسيط فاتورته).");
    return { status: "low_data", limit: capped, cappedBy };
  }

  function needsReviewResult(result, reason) {
    result.status = "needs_review";
    result.notes.push(reason);
    return result;
  }

  // تحصيل دين قديم: الجزء الحديث = مبيعات نافذة السحب غير المسددة (بعد دفعات البيع والمرتجع
  // والحسم فيها)، والباقي دين قديم. وصفي فقط: لا يمسّ الرصيد ولا الحد ولا Q ولا التعثّر.
  function oldDebtCollectionOf(facts, balance, referenceDay) {
    const O = CONFIG.autoCredit.oldDebt;
    if (!facts || !(balance > CONFIG.autoCredit.settleTolerance)) return null;
    const recentUnpaid = Math.min(balance, Math.max(0, facts.sales60 - facts.salePayments60 - facts.returnsDiscounts60));
    const oldAmount = balance - recentUnpaid;
    const oldShare = oldAmount / balance;
    const receipts = (facts.receiptDays || []).filter((day) => day <= referenceDay && referenceDay - day <= O.receiptWindowDays);
    const lastReceiptDays = receipts.length ? referenceDay - Math.max(...receipts) : null;
    if (oldShare < O.minOldShare || receipts.length < O.minReceipts || lastReceiptDays === null || lastReceiptDays > O.lastReceiptMaxDays) return null;
    return { oldAmount: round(oldAmount, 3), recentUnpaid: round(recentUnpaid, 3), oldShare: round(oldShare, 4), receipts60: receipts.length, lastReceiptDays };
  }

  function roundOrNull(value, digits) {
    return value === null ? null : round(value, digits);
  }

  // موانع تسبق أي حساب (بالترتيب نفسه): لا دفتر، دفتر مقتطع، ليس زبوناً، ومراجعة تسبق التعثّر.
  // تُرجع true إن حسمت النتيجة (result معدّل في مكانه).
  function autoCreditBlocked(facts, account, result) {
    const notes = result.notes;
    if (!facts) { notes.push("لا دفتر حساب لهذا الزبون في تقرير الحركات."); return true; }
    if (facts.truncated) { notes.push("دفتر هذا الزبون مقتطع، ولا يُبنى حد على بيانات ناقصة."); return true; }
    if (account.nonCustomer) {
      result.status = "non_customer";
      notes.push(account.nonCustomerReason);
      return true;
    }
    // المختلط المؤكد والحركات المجهولة المادية يسبقان التعثّر: لا حكم من بيانات ملتبسة.
    if (account.needsReview === "explicit" || account.needsReview === "unknown" || account.needsReview === "tree") {
      needsReviewResult(result, account.needsReviewReason);
      return true;
    }
    return false;
  }

  // الحد المحسوب الحقيقي لزبون واحد (عملة الأساس، قبل التقريب) — صيغة المحاكاة
  // المعتمدة v5 حرفياً، مع قاعدة التعثّر المعتمدة (2026-09-27) بدل قاعدة «موقوف» القديمة.
  // balance: الرصيد الموحّد بعملة الأساس (لحساب الليرة: رصيده بعملته × سعر الصرف).
  function computeAutoCredit(facts, stats, balance, referenceDay, account = {}) {
    const A = CONFIG.autoCredit;
    const notes = [];
    const result = { status: "unavailable", limitBase: null, notes };
    if (account.needsReview === "mixed") result.mixedRole = true;
    if (autoCreditBlocked(facts, account, result)) return result;

    const tolerance = A.settleTolerance;
    const S60 = facts.sales60;
    const age = facts.firstDebitDay === null ? A.salesWindowDays : referenceDay - facts.firstDebitDay;
    const net = S60 - facts.returns60;
    const R0 = net > 0 ? Math.max(facts.payments60 / net, 1 - Math.max(0, balance) / net) : null;

    // الدورة محصورة بين P10 وP90 للمحفظة الحية.
    const { cycleRaw, cycleBasis, p75 } = autoCreditCycle(facts, stats);
    const cycleDays = clamp(cycleRaw, stats.floorDays, stats.capDays);
    Object.assign(result, {
      cycleRawDays: round(cycleRaw, 2),
      cycleBasis,
      cycleDays: round(cycleDays, 2),
      paymentIntervalMedianDays: facts.paymentIntervalMedian,
      salesRecent: round(facts.salesRecent, 3),
      salesPrior: round(facts.salesPrior, 3),
      oldestOpenDays: facts.oldestOpenAge,
      daysSinceLastPayment: facts.lastPaymentDay === null ? null : referenceDay - facts.lastPaymentDay
    });

    // 1) متعثّر: رصيد قائم + دين أقدم من دورته بهامش واضح (وبقيمة معتبرة) +
    //    دفعات المدة لا تغطيه. يسبق «غير نشط»: الخامل المدين الذي لا يدفع متعثّر.
    const { overdueAfterDays, overdueAmount, paidInOverdueSpan } = overdueFacts(facts, referenceDay, cycleDays);
    // مطابقة الرصيد (قرار المالك 2026-09-27): الدين المتأخر من الدفتر لا يُعدّ قائماً إلا بقدر ما
    // يدعمه الرصيد الحالي الموثوق — لقطة دفتر أقدم قليلاً من الرصيد قد تفوتها دفعة. حد الأهمية
    // نفسه (delinquentMinAmount). لا يمسّ سجل الدفعات ولا جودة السداد ولا شرط الدفعات أدناه.
    const balanceSupportedOverdue = Math.min(overdueAmount, Math.max(0, balance));
    Object.assign(result, {
      overdueAfterDays: round(overdueAfterDays, 2),
      overdueAmount: round(overdueAmount, 3),
      balanceSupportedOverdue: round(balanceSupportedOverdue, 3),
      paidInOverdueSpan: round(paidInOverdueSpan, 3)
    });
    if (balance > tolerance && overdueAmount >= A.delinquentMinAmount && balanceSupportedOverdue >= A.delinquentMinAmount
      && paidInOverdueSpan < A.delinquentPaidShare * overdueAmount) {
      result.status = "delinquent";
      result.limitBase = 0;
      notes.push(`متعثّر: دين أقدم من ${Math.round(overdueAfterDays)} يوماً (${Math.round(overdueAmount)}) ودفعات تلك المدة ${Math.round(paidInOverdueSpan)} فقط.`);
      // المختلط لا يلغي التعثّر الحقيقي: الحالتان معاً (قرار المالك 2026-09-28).
      if (result.mixedRole) notes.push(account.needsReviewReason);
      return result;
    }

    // دفتر لا تطابقه فواتير المبيع: مدخلات الحد غير موثوقة، فلا حد آلي (بعد
    // التعثّر: الدين الحقيقي المتأخر يبقى تعثّراً أياً كان مصدره).
    if (account.needsReview) return needsReviewResult(result, account.needsReviewReason);

    // 2) غير نشط: لا سحب في نافذة السحب — لا حد، وليس متعثراً.
    if (!(S60 > 0)) {
      result.status = "inactive";
      result.limitBase = 0;
      notes.push(`غير نشط: لا سحب خلال ${A.salesWindowDays} يوماً، فلا حد (وليس متعثراً).`);
      return result;
    }

    // 3) دائن/دفع مسبق: لا تعرّض ائتماني.
    if (isPrepaidAccount(facts, balance)) {
      result.status = "prepaid";
      notes.push("رصيده دائن ويدفع قبل أن يسحب: لا تعرّض ائتماني ولا حد.");
      return result;
    }

    // 4) سرعة السحب اليومية على الأيام الفعلية، بعد حارس الفاتورة الشاذة.
    const { fullWindow, activeDays, velocity, pace } = drawVelocity(facts, age, largeInvoiceAdjustedDraw(facts, notes));

    // 5) هامش الذروة.
    const balanceToCycle = pace * cycleDays > 0 ? Math.max(0, balance) / (pace * cycleDays) : 0;
    const exposureCycle = peakExposureCycle({ cycleDays, p75 }, R0, balanceToCycle, stats, notes);
    const exposure = velocity * exposureCycle;

    // 6) جودة السداد Q.
    const coverage = R0;
    const { coverageScore, punctuality, balanceRatio, balanceRisk, accumulation, accumulationRisk, risk, quality } = repaymentQuality(facts, balance, coverage, { amount: exposure, exposureCycle, pace });

    // 7) الاتجاه، ثم السقوف.
    const trend = autoCreditTrend(facts, fullWindow, coverage, risk, notes);
    const { status, limit, cappedBy } = cappedAutoLimit(exposure * quality * trend, facts, age, { exposure, coverage, quality }, notes);

    Object.assign(result, {
      status,
      limitBase: Math.max(0, limit),
      activeDays,
      fullWindow,
      velocity: round(velocity, 3),
      exposureCycleDays: round(exposureCycle, 2),
      expectedExposure: round(exposure, 3),
      coverage: roundOrNull(coverage, 4),
      coverageScore: round(coverageScore, 4),
      punctuality: round(punctuality, 4),
      quality: round(quality, 4),
      trend: round(trend, 4),
      balanceRatio: roundOrNull(balanceRatio, 4),
      balanceRisk: round(balanceRisk, 4),
      accumulation: round(accumulation, 4),
      accumulationRisk: round(accumulationRisk, 4),
      risk: round(risk, 4),
      cappedBy
    });
    return result;
  }

  // --------------------------------------------------------------------------
  // الائتمان: الحد الآلي هو المصدر الوحيد. حد الأمين احتياط فقط حين يتعذّر
  // الحساب الآلي (لا دفتر للزبون). حدود customer_credit_limits القديمة لا تدخل
  // الحساب — تُعرض مرجعاً تشخيصياً فقط (legacyCreditLimit).
  // غياب الحد **ليس** صفراً ولا يُنتج تجاوزاً.
  // --------------------------------------------------------------------------
  function resolveCredit(balanceRow, auto, display, legacyCreditLimit = null, { balancesStale = false, invoicesStale = false, dayMismatch = false, ameenFxDayMismatch = false, autoGated = false } = {}) {
    const ameenLimitRaw = numberOrNull(balanceRow?.creditLimit ?? balanceRow?.credit_limit);
    // تقرير أرصدة غير حديث: لا حد الأمين من اللقطة نفسها بديلاً — رقم يبدو صالحاً وهو قديم.
    const ameenLimit = !balancesStale && ameenLimitRaw !== null && ameenLimitRaw > 0 ? ameenLimitRaw : null;
    const autoUsable = auto && auto.status !== "unavailable";

    const currency = display?.currency || CONFIG.baseCurrency;
    const rate = display?.rate ?? null;             // عملة الأساس لكل وحدة من عملة الحساب
    const foreign = currency !== CONFIG.baseCurrency && rate !== null;

    let creditLimit = null;
    let creditLimitDisplay = null;
    let creditLimitSource = "missing";
    if (autoUsable) {
      creditLimitSource = "auto";
      if (auto.limitBase !== null) {
        creditLimitDisplay = foreign ? commercialRound(auto.limitBase / rate, currency) : commercialRound(auto.limitBase, CONFIG.baseCurrency);
        creditLimit = foreign ? round(creditLimitDisplay * rate, 3) : creditLimitDisplay;
      }
    } else if (ameenLimit !== null) {
      // حد الأمين مخزَّن بعملة الأساس كبقية مبالغه.
      creditLimitSource = "ameen";
      creditLimit = ameenLimit;
      creditLimitDisplay = foreign ? round(ameenLimit / rate, 0) : ameenLimit;
    }
    // حساب بعملة غير الأساس يُعرض حده ورصيده بعملته دائماً — لا خلط.
    const creditCurrency = foreign ? currency : CONFIG.baseCurrency;

    const base = {
      creditLimit: creditLimit === null ? null : round(creditLimit, 3),
      creditLimitDisplay: creditLimitDisplay === null ? null : round(creditLimitDisplay, 3),
      creditCurrency,
      creditLimitSource,
      legacyCreditLimit,
      autoCredit: auto || null
    };

    // صف الأرصدة الغائب أو الرصيد غير الرقمي = مجهول، لا صفر ملفّق.
    if (!balanceRow || numberOrNull(balanceRow.balance) === null) {
      return { ...base, currentBalance: null, balanceDisplay: null, creditUsagePercent: null, creditStatus: "unknown_balance" };
    }

    const balance = numberOrNull(balanceRow.balance);
    // حساب الليرة يُقارن بعملته (لا بالدولار المشوّه بفروقات الصرف). وإن غاب رصيده
    // بعملته (سطر بعملة أخرى أو معدّل غير صالح) فالمقارنة بعملة الأساس: الرصيد
    // بالدولار مقابل ما يكافئ الحد بالدولار — لا دولار مقابل ليرة أبداً.
    const accountBalance = creditCurrency !== CONFIG.baseCurrency ? numberOrNull(balanceRow.balanceAccountCcy) : null;
    const nativeComparable = creditCurrency === CONFIG.baseCurrency || accountBalance !== null;
    const balanceDisplay = accountBalance !== null ? accountBalance : balance;
    const balanceCurrency = nativeComparable ? creditCurrency : CONFIG.baseCurrency;
    const exposure = Math.max(0, balanceDisplay);
    const compareLimit = nativeComparable ? creditLimitDisplay : creditLimit;

    let creditStatus = "normal";
    let usagePercent = null;
    const confirmedStatus = autoUsable && ["non_customer", "needs_review"].includes(auto.status);
    if (balancesStale && !confirmedStatus) {
      // لا استخدام ولا تجاوز ولا تعثّر من رصيد قديم.
      return { ...base, currentBalance: round(balance, 3), balanceDisplay: round(balanceDisplay, 3), balanceCurrency, creditLimitSource: autoUsable ? base.creditLimitSource : "stale", creditUsagePercent: null, creditStatus: "stale_balance" };
    }
    if (currency !== CONFIG.baseCurrency && rate === null && !confirmedStatus) {
      // قرار المالك (Codex P1): حساب بعملة غير الأساس بلا أي معدّل في لقطة الفواتير — رصيده بعملته،
      // بلا حد آلي ولا نسبة استخدام ولا حكم تجاوز حتى يتوفر معدّل. حد الأمين يُعرض بعملة الأساس المخزَّن بها.
      const nativeBalance = numberOrNull(balanceRow.balanceAccountCcy);
      return {
        ...base,
        ...(creditLimitSource === "ameen" ? {} : { creditLimit: null, creditLimitDisplay: null, creditLimitSource: "missing_rate" }),
        currentBalance: round(balance, 3),
        balanceDisplay: round(nativeBalance ?? balance, 3),
        balanceCurrency: nativeBalance !== null ? currency : CONFIG.baseCurrency,
        creditUsagePercent: null,
        creditStatus: "missing_rate"
      };
    }
    if ((dayMismatch || ameenFxDayMismatch || invoicesStale) && foreign && creditLimitSource === "ameen" && !confirmedStatus) {
      // قرار المالك: معدّل تحويل حد الأمين لعملة الحساب من الفواتير نفسها، فمع لقطة فواتير قديمة
      // أو على يوم آخر قد يكون قديماً — الحد يُعرض بمصدره، بلا نسبة استخدام ولا حكم تجاوز.
      return { ...base, currentBalance: round(balance, 3), balanceDisplay: round(balanceDisplay, 3), balanceCurrency, creditUsagePercent: null, creditStatus: dayMismatch || ameenFxDayMismatch ? "accounting_day_mismatch" : "stale_invoices" };
    }
    if (dayMismatch && !confirmedStatus && creditLimitSource !== "ameen") {
      // المصادر على يومين محاسبيين: لا حد آلي ولا استخدام ولا تجاوز ولا تعثّر ولا «غير نشط».
      return { ...base, currentBalance: round(balance, 3), balanceDisplay: round(balanceDisplay, 3), balanceCurrency, creditLimitSource: "day_mismatch", creditUsagePercent: null, creditStatus: "accounting_day_mismatch" };
    }
    if (invoicesStale && !confirmedStatus && creditLimitSource !== "ameen") {
      // لقطة فواتير قديمة: لا حد آلي ولا استخدام ولا تجاوز ولا تعثّر ولا «غير نشط» من نافذتها.
      // حد الأمين اليدوي (إن وُجد) يبقى بمصدره «ameen» — ليس حداً آلياً.
      return { ...base, currentBalance: round(balance, 3), balanceDisplay: round(balanceDisplay, 3), balanceCurrency, creditLimitSource: "stale_invoices", creditUsagePercent: null, creditStatus: "stale_invoices" };
    }
    if (autoGated && !confirmedStatus && creditLimitSource !== "ameen") {
      // لا حد آلي ولا استخدام ولا تجاوز ولا تعثّر قبل مصدر حركات موسوم بالنوع. حد الأمين
      // المُدخل يدوياً (إن وُجد) يبقى بمصدره «ameen» كمسار الدفتر غير الحديث — ليس حداً آلياً.
      return { ...base, currentBalance: round(balance, 3), balanceDisplay: round(balanceDisplay, 3), balanceCurrency, creditLimitSource: "untyped", creditUsagePercent: null, creditStatus: "awaiting_typed_source" };
    }
    if (autoUsable && auto.status === "delinquent") creditStatus = "delinquent";
    else if (autoUsable && auto.status === "inactive") creditStatus = "inactive_no_limit";
    else if (autoUsable && auto.status === "prepaid") creditStatus = "prepaid";
    else if (autoUsable && auto.status === "non_customer") creditStatus = "not_customer";
    else if (autoUsable && auto.status === "needs_review") creditStatus = "needs_review";
    else if (compareLimit !== null && compareLimit > 0) {
      usagePercent = round((exposure / compareLimit) * 100, 2);
      const ratio = exposure / compareLimit;
      if (ratio >= 1) creditStatus = "over_limit";
      else if (ratio >= CONFIG.nearLimitRatio) creditStatus = "near_limit";
    } else if (compareLimit === 0 && exposure > 0) {
      creditStatus = "over_limit";               // حد محسوب أقل من أصغر خطوة تقريب
    } else if (exposure > 0) {
      creditStatus = "unknown_limit";
    }

    return {
      ...base,
      currentBalance: round(balance, 3),
      balanceDisplay: round(balanceDisplay, 3),
      balanceCurrency,
      creditUsagePercent: usagePercent,
      creditStatus
    };
  }

  // --------------------------------------------------------------------------
  // نمط الشراء: وسيط الفجوات بين أيام الشراء المتمايزة داخل النافذة المتاحة.
  // --------------------------------------------------------------------------
  function purchaseCadence(purchaseDays) {
    const unique = [...new Set(purchaseDays)].sort((a, b) => a - b);
    if (unique.length < CONFIG.minPurchasesForCadence) {
      return {
        typicalGapDays: null,
        cadenceTrusted: false,
        inactiveThresholdDays: CONFIG.inactiveFallbackDays,
        thresholdBasis: "fallback"
      };
    }
    const gaps = [];
    for (let index = 1; index < unique.length; index += 1) gaps.push(unique[index] - unique[index - 1]);
    const typical = median(gaps);
    return {
      typicalGapDays: typical === null ? null : round(typical, 2),
      cadenceTrusted: true,
      inactiveThresholdDays: Math.max(CONFIG.inactiveMinimumDays, Math.round(CONFIG.inactiveGapMultiplier * typical)),
      thresholdBasis: "cadence"
    };
  }

  // --------------------------------------------------------------------------
  // أهم الأصناف: صافي الكمية والقيمة بعد طرح أسطر المرتجعات.
  // المفتاح: GUID المادة إن توفّر (يُضاف عبر push-customer-invoices.ps1)، وإلا
  // الاسم المطبَّع — وتُعلَّم الحالة حتى لا يُقرأ التجميع كأنه معرّف موثوق.
  //
  // القيمة من `lineValue` (بوحدة الإدخال، انظر lineValueOf) لا من lineTotal الخام.
  // الكمية بالوحدة الأولى (كروز) كما في الأمين، ومعها ما يعادلها بالوحدة الثانية
  // (كرتونة) واسما الوحدتين للعرض. صنف فيه سطر واحد بلا قيمة موثوقة تصير قيمته
  // null (`valueVerified = false`) ولا يُرتَّب فوق أصناف مؤكدة القيمة.
  // --------------------------------------------------------------------------
  function topItems(rows) {
    const totals = new Map();
    let keyedByGuid = 0;
    let keyedByName = 0;

    for (const row of rows) {
      for (const line of row.lines) {
        const key = line.itemGuid || `name:${normalizeName(line.material)}`;
        if (!key || key === "name:") continue;
        if (line.itemGuid) keyedByGuid += 1; else keyedByName += 1;
        if (!totals.has(key)) totals.set(key, newTopItemEntry(line));
        addLineToTopItem(totals.get(key), line, row.sign);
      }
    }

    const items = [...totals.values()]
      .map(topItemOutput)
      // ترتيب حتمي: المؤكَّد القيمة أولاً، ثم القيمة تنازلياً، ثم الاسم.
      .sort((a, b) => (Number(b.valueVerified) - Number(a.valueVerified))
        || ((b.netValue ?? 0) - (a.netValue ?? 0))
        || a.itemName.localeCompare(b.itemName, "ar"))
      .slice(0, CONFIG.topItemsLimit);

    return {
      items,
      identity: keyedByGuid > 0 && keyedByName === 0 ? "item_guid" : keyedByGuid > 0 ? "mixed" : "item_name"
    };
  }

  function newTopItemEntry(line) {
    return {
      itemGuid: line.itemGuid || null,
      itemName: line.material,
      netQty: 0,
      netQtyUnits: 0,
      netValue: 0,
      unverifiedLines: 0,
      unit1: "",
      unit2: "",
      unit2Fact: null,
      lineCount: 0
    };
  }

  // يضيف سطر فاتورة (بإشارة المبيع/المرتجع) إلى مجموع صنفه.
  function addLineToTopItem(entry, line, sign) {
    entry.netQty += sign * line.qty;
    entry.netQtyUnits += sign * (line.qtyUnits ?? 0);
    if (line.lineValue === null) entry.unverifiedLines += 1;
    else entry.netValue += sign * line.lineValue;
    entry.lineCount += 1;
    if (!entry.itemName && line.material) entry.itemName = line.material;
    if (!entry.unit1 && line.unit1) entry.unit1 = line.unit1;
    if (!entry.unit2 && line.unit2) entry.unit2 = line.unit2;
    if (entry.unit2Fact === null && line.unit2Fact !== null && line.unit2Fact > 0) entry.unit2Fact = line.unit2Fact;
  }

  function topItemOutput(entry) {
    const valueVerified = entry.unverifiedLines === 0;
    return {
      itemGuid: entry.itemGuid,
      itemName: entry.itemName,
      netQty: round(entry.netQty, 3),
      netQtyUnits: round(entry.netQtyUnits, 3),
      unit1: entry.unit1 || null,
      unit2: entry.unit2 || null,
      unit2Fact: entry.unit2Fact,
      netQtyUnit2: entry.unit2Fact ? round(entry.netQty / entry.unit2Fact, 3) : null,
      netValue: valueVerified ? round(entry.netValue, 3) : null,
      valueVerified,
      lineCount: entry.lineCount
    };
  }

  function summarizePeriod(rows) {
    let net = 0;
    let sales = 0;
    let returns = 0;
    let invoiceCount = 0;
    let returnCount = 0;
    const days = [];

    for (const row of rows) {
      net += row.netValue;
      if (row.isReturn) {
        returns += row.grossValue;
        returnCount += 1;
      } else {
        sales += row.grossValue;
        invoiceCount += 1;
        days.push(row.day);
      }
    }

    return {
      netSales: round(net, 3),
      sales: round(sales, 3),
      returns: round(returns, 3),
      invoiceCount,
      returnCount,
      billCount: rows.length,
      averageInvoice: invoiceCount > 0 ? round(sales / invoiceCount, 3) : null,
      purchaseDays: days
    };
  }

  // --------------------------------------------------------------------------
  // البناء الرئيسي
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // تاريخ الحد (STEP 2): التنعيم الأسبوعي، وتفسير التغيير، واتجاه الخطر.
  // المدخل: صفوف customer_credit_history كما يقرؤها المالك (snake_case أو camelCase).
  // كل ما هنا حساب حتمي من اللقطات ومن نتيجة المحرك نفسها — لا نص يُخترع ولا رقم يُقدَّر.
  // --------------------------------------------------------------------------
  // حالات الحد الرقمي (الحد قيمة محسوبة قابلة للتنعيم).
  const NUMERIC_AUTO_STATUSES = new Set(["normal", "low_data"]);
  // حالات تقول شيئاً عن البيانات لا عن الزبون: لا تُكتب لقطة منها ولا تصلح أساساً للمقارنة.
  const HISTORY_GAP_CREDIT_STATUSES = new Set([
    "unknown_balance", "missing_rate", "stale_balance", "stale_invoices", "accounting_day_mismatch", "awaiting_typed_source"
  ]);
  const AUTO_STATUS_LABELS = Object.freeze({
    normal: "طبيعي", low_data: "بيانات قليلة", delinquent: "متعثّر", inactive: "غير نشط",
    prepaid: "دفع مسبق", needs_review: "يحتاج مراجعة", non_customer: "ليس زبون مبيعات"
  });

  // ما تحفظه اللقطة من مكوّنات الصيغة — المفاتيح نفسها يقرؤها تفسير التغيير.
  function creditSnapshotFactors(auto) {
    const pick = (key) => (Number.isFinite(auto?.[key]) ? auto[key] : null);
    return {
      velocity: pick("velocity"),
      exposureCycleDays: pick("exposureCycleDays"),
      cycleDays: pick("cycleDays"),
      quality: pick("quality"),
      trend: pick("trend"),
      coverage: pick("coverage"),
      coverageScore: pick("coverageScore"),
      punctuality: pick("punctuality"),
      risk: pick("risk"),
      balanceRisk: pick("balanceRisk"),
      balanceRatio: pick("balanceRatio"),
      accumulation: pick("accumulation"),
      accumulationRisk: pick("accumulationRisk"),
      oldestOpenDays: pick("oldestOpenDays"),
      overdueAfterDays: pick("overdueAfterDays"),
      overdueAmount: pick("overdueAmount"),
      paidInOverdueSpan: pick("paidInOverdueSpan"),
      salesRecent: pick("salesRecent"),
      salesPrior: pick("salesPrior"),
      limitBaseRaw: Number.isFinite(auto?.limitBaseRaw) ? round(auto.limitBaseRaw, 3) : pick("limitBase") === null ? null : round(auto.limitBase, 3),
      cappedBy: auto?.cappedBy ?? null,
      smoothing: auto?.smoothing ?? null
    };
  }

  // أقدم دين متأخر بالأيام: عمر أقدم دين مفتوح إن تجاوز حد التأخر، وإلا صفر؛ null إن لم يُقَس.
  function oldestOverdueDaysOf(auto) {
    if (!auto || !Number.isFinite(auto.oldestOpenDays) || !Number.isFinite(auto.overdueAfterDays)) return null;
    return auto.oldestOpenDays > auto.overdueAfterDays ? auto.oldestOpenDays : 0;
  }

  function normalizeHistoryRow(row) {
    const day = dayNumber(row?.snapshot_date ?? row?.snapshotDate);
    const guid = normalizeGuid(row?.customer_guid ?? row?.customerGuid);
    if (day === null || !guid) return null;
    const factors = row?.factors && typeof row.factors === "object" && !Array.isArray(row.factors) ? row.factors : {};
    return {
      guid,
      day,
      date: dayNumberToKey(day),
      autoStatus: text(row.auto_status ?? row.autoStatus),
      creditStatus: text(row.credit_status ?? row.creditStatus),
      limitBase: numberOrNull(row.limit_base ?? row.limitBase),
      creditLimitDisplay: numberOrNull(row.credit_limit_display ?? row.creditLimitDisplay),
      creditCurrency: text(row.credit_currency ?? row.creditCurrency) || CONFIG.baseCurrency,
      riskScore: numberOrNull(row.risk_score ?? row.riskScore),
      factors
    };
  }

  // اللقطات الصالحة لكل زبون، الأحدث أولاً: قبل يوم المرجع حصراً (لقطة اليوم نفسه لا تدخل،
  // فإعادة التشغيل في اليوم نفسه لا تغيّر النتيجة)، وضمن lookbackDays، وبلا لقطات فجوة بيانات.
  function indexCreditHistory(rows, referenceDay) {
    const H = CONFIG.creditHistory;
    const byGuid = new Map();
    if (!Number.isFinite(referenceDay)) return byGuid;
    for (const raw of rows) {
      const row = normalizeHistoryRow(raw);
      if (!row || row.day >= referenceDay || row.day < referenceDay - H.lookbackDays) continue;
      if (!AUTO_STATUS_LABELS[row.autoStatus] || HISTORY_GAP_CREDIT_STATUSES.has(row.creditStatus)) continue;
      if (!byGuid.has(row.guid)) byGuid.set(row.guid, []);
      byGuid.get(row.guid).push(row);
    }
    for (const [guid, list] of byGuid) {
      const seen = new Set();
      byGuid.set(guid, list
        .sort((a, b) => b.day - a.day)
        .filter((row) => (seen.has(row.day) ? false : seen.add(row.day))));
    }
    return byGuid;
  }

  // التنعيم الأسبوعي (+25% / −40%) على الحد المحسوب بعملة الأساس قبل التقريب. الأساس: أحدث
  // لقطة عمرها ≥ 7 أيام، وإلا أقدم لقطة متاحة (تاريخ أقصر من أسبوع ⇒ حصر أشد لا أخف).
  // التعثّر وغير النشط لا يمرّان هنا: حدهما صفر فوراً. أساس غير رقمي (متعثّر/غير نشط/...)
  // ⇒ لا تنعيم: لا يُبنى صعود تدريجي من صفر لا يُكسر أبداً.
  function smoothAutoCredit(auto, history, referenceDay) {
    if (!auto || !NUMERIC_AUTO_STATUSES.has(auto.status) || !Number.isFinite(auto.limitBase)) return;
    const H = CONFIG.creditHistory;
    const raw = auto.limitBase;
    auto.limitBaseRaw = round(raw, 3);
    const list = history || [];
    const baseline = list.find((row) => row.day <= referenceDay - H.smoothingWindowDays) || list[list.length - 1] || null;
    if (!baseline) {
      auto.smoothing = { applied: false, reason: "no_history" };
      return;
    }
    if (!NUMERIC_AUTO_STATUSES.has(baseline.autoStatus) || !(baseline.limitBase > 0)) {
      auto.smoothing = { applied: false, reason: "no_numeric_baseline", baselineDate: baseline.date, baselineStatus: baseline.autoStatus };
      return;
    }
    const min = baseline.limitBase * (1 - H.maxWeeklyDecrease);
    const max = baseline.limitBase * (1 + H.maxWeeklyIncrease);
    const limited = clamp(raw, min, max);
    const applied = limited !== raw;
    auto.smoothing = {
      applied,
      reason: applied ? (raw > max ? "capped_increase" : "capped_decrease") : "within_bounds",
      baselineDate: baseline.date,
      baselineLimitBase: round(baseline.limitBase, 3),
      minLimitBase: round(min, 3),
      maxLimitBase: round(max, 3)
    };
    auto.limitBase = limited;
    if (applied) {
      auto.notes.push(`التنعيم الأسبوعي: الحد المحسوب ${Math.round(raw)} حُصر عند ${Math.round(limited)} (بين −${Math.round(H.maxWeeklyDecrease * 100)}% و+${Math.round(H.maxWeeklyIncrease * 100)}% من حد ${baseline.date}).`);
    }
  }

  const formatAmount = (value, currency) => {
    if (!Number.isFinite(value)) return "—";
    const formatted = Math.round(value).toLocaleString("en-US");
    return currency === CONFIG.baseCurrency ? `${formatted}$` : `${formatted} ${currency}`;
  };
  const formatPercent = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : "غير محسوبة");
  const formatSignedPercent = (value) => {
    if (!Number.isFinite(value)) return "—";
    const percentValue = Math.round(value * 100);
    return `${percentValue > 0 ? "+" : ""}${percentValue}%`;
  };
  const formatDays = (value) => (Number.isFinite(value) ? `${Math.round(value)} يوماً` : "بلا دين مفتوح");
  const formatRatio = (value) => (Number.isFinite(value) ? `${round(value, 2)}×` : "—");

  // أثر كل عامل على الحد بين لقطتين. الحد = السرعة × الدورة × Q × T، فأثر السرعة والدورة
  // والاتجاه = لوغاريتم نسبتها، وأثر مكوّنات Q (التغطية، الانضباط، مخاطر الرصيد) = تغيّر
  // مساهمتها في Q منسوباً إلى Q السابقة. النص يذكر القيمتين الفعليتين القديمة والجديدة.
  function creditFactorChanges(previous, current) {
    const A = CONFIG.autoCredit;
    const P = previous.factors || {};
    const C = current.factors || {};
    const changes = [];
    const logRatio = (before, after) => (before > 0 && after > 0 ? Math.log(after / before) : null);
    const add = (key, weight, phrase) => {
      if (weight !== null && Number.isFinite(weight) && Math.abs(weight) > 1e-9) changes.push({ key, weight, phrase });
    };
    add("velocity", logRatio(P.velocity, C.velocity),
      `متوسط السحب الشهري صار ${formatAmount(C.velocity * A.recentDays, CONFIG.baseCurrency)} بدل ${formatAmount(P.velocity * A.recentDays, CONFIG.baseCurrency)}`);
    add("cycle", logRatio(P.exposureCycleDays, C.exposureCycleDays),
      `دورة السداد صارت ${formatDays(C.exposureCycleDays)} بدل ${formatDays(P.exposureCycleDays)}`);
    add("trend", logRatio(P.trend, C.trend),
      `اتجاه السحب (آخر ${A.recentDays} يوماً مقابل التي قبلها) صار ${formatSignedPercent(C.trend - 1)} بدل ${formatSignedPercent(P.trend - 1)}`);
    if (P.quality > 0) {
      const W = A.qualityWeights;
      const share = (weight, before, after) => (Number.isFinite(before) && Number.isFinite(after)
        ? (A.qualitySpan * weight * (after - before)) / P.quality
        : null);
      add("coverage", share(W.coverage, P.coverageScore, C.coverageScore),
        `تغطية الدفع ${(C.coverage ?? 0) < (P.coverage ?? 0) ? "نزلت" : "ارتفعت"} من ${formatPercent(P.coverage)} إلى ${formatPercent(C.coverage)}`);
      add("punctuality", share(W.punctuality, P.punctuality, C.punctuality),
        `أقدم دين صار عمره ${formatDays(C.oldestOpenDays)} بدل ${formatDays(P.oldestOpenDays)}`);
      const accumulationBinds = Number.isFinite(C.accumulationRisk) && Number.isFinite(C.balanceRisk) && C.accumulationRisk < C.balanceRisk;
      add("risk", share(W.risk, P.risk, C.risk), accumulationBinds
        ? `تراكم الرصيد خلال ${A.recentDays} يوماً صار ${formatPercent(C.accumulation)} من سحبها بدل ${formatPercent(P.accumulation)}`
        : `الرصيد صار ${formatRatio(C.balanceRatio)} التعرض المعتاد بدل ${formatRatio(P.balanceRatio)}`);
    }
    return changes;
  }

  // العوامل التي تفسّر اتجاه التغيير: الأكبر أثراً بنفس اتجاه الحد، وثانٍ إن بلغ حصة واضحة منه.
  function dominantFactors(changes, direction) {
    const H = CONFIG.creditHistory;
    const sameWay = changes.filter((change) => Math.sign(change.weight) === direction);
    const pool = (sameWay.length ? sameWay : changes).slice().sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    if (!pool.length) return [];
    const [first, second] = pool;
    return second && Math.sign(second.weight) === Math.sign(first.weight) && Math.abs(second.weight) >= H.secondaryFactorShare * Math.abs(first.weight)
      ? [first, second]
      : [first];
  }

  const CAP_REASONS = Object.freeze({
    coverage: (factors) => `دخل سقف التغطية لأن تغطية الدفع ${formatPercent(factors.coverage)} أقل من ${Math.round(CONFIG.autoCredit.growthMinCoverage * 100)}%`,
    low_data: () => "بياناته قليلة فصار الحد محافظاً (لا يتجاوز نصف سحبه ولا ضعف وسيط فاتورته)"
  });

  // تفسير تغيّر الحد أو الحالة عن آخر لقطة صالحة، من مكوّنات الصيغة الفعلية وحدها.
  function creditChangeExplanation(previous, current) {
    const A = CONFIG.autoCredit;
    const P = previous.factors || {};
    const C = current.factors || {};
    const sameCurrency = previous.creditCurrency === current.creditCurrency;
    const prevLimit = previous.creditLimitDisplay;
    const curLimit = current.creditLimitDisplay;
    const limitChanged = sameCurrency && Number.isFinite(prevLimit) && Number.isFinite(curLimit) && prevLimit !== curLimit;
    const statusChanged = previous.autoStatus !== current.autoStatus;
    const prevNumeric = NUMERIC_AUTO_STATUSES.has(previous.autoStatus);
    const curNumeric = NUMERIC_AUTO_STATUSES.has(current.autoStatus);
    if (!limitChanged && !statusChanged) return null;
    const money = (value) => formatAmount(value, current.creditCurrency);
    const base = { previousDate: previous.date, previousStatus: previous.autoStatus, currentStatus: current.autoStatus, previousLimit: prevLimit, currentLimit: curLimit, currency: current.creditCurrency };

    if (statusChanged && current.autoStatus === "delinquent") {
      const drop = Number.isFinite(prevLimit) && prevLimit > 0 && sameCurrency ? `، فنزل الحد من ${money(prevLimit)} إلى ${money(0)}` : "، فالحد صفر";
      return { ...base, kind: "status", direction: "down", factors: ["delinquent"],
        text: `صار متعثّراً${drop}: عليه دين أقدم من ${formatDays(C.overdueAfterDays)} قيمته ${formatAmount(C.overdueAmount, CONFIG.baseCurrency)} ودفعات تلك المدة ${formatAmount(C.paidInOverdueSpan, CONFIG.baseCurrency)} فقط.` };
    }
    if (statusChanged && previous.autoStatus === "delinquent" && curNumeric) {
      return { ...base, kind: "status", direction: "up", factors: ["delinquent"],
        text: `خرج من التعثّر فصار الحد ${money(curLimit)} بدل ${money(0)}: الدين المتأخر صار ${formatAmount(C.overdueAmount, CONFIG.baseCurrency)} بدل ${formatAmount(P.overdueAmount, CONFIG.baseCurrency)}.` };
    }
    if (statusChanged && current.autoStatus === "inactive") {
      const drop = Number.isFinite(prevLimit) && prevLimit > 0 && sameCurrency ? `، فالحد ${money(0)} بدل ${money(prevLimit)}` : "";
      return { ...base, kind: "status", direction: "down", factors: ["inactive"],
        text: `صار غير نشط: لا سحب خلال ${A.salesWindowDays} يوماً${drop}.` };
    }
    if (statusChanged && previous.autoStatus === "inactive" && curNumeric) {
      return { ...base, kind: "status", direction: "up", factors: ["inactive"],
        text: `عاد للسحب: ${formatAmount((C.salesRecent ?? 0) + (C.salesPrior ?? 0), CONFIG.baseCurrency)} خلال ${A.salesWindowDays} يوماً، فصار الحد ${money(curLimit)} بدل ${money(0)}.` };
    }
    if (statusChanged && !(prevNumeric && curNumeric)) {
      const note = (current.notes || [])[0];
      return { ...base, kind: "status", direction: null, factors: ["status"],
        text: `تغيّرت الحالة من «${AUTO_STATUS_LABELS[previous.autoStatus] || previous.autoStatus}» إلى «${AUTO_STATUS_LABELS[current.autoStatus] || current.autoStatus}»${note ? `: ${note}` : "."}` };
    }
    if (!limitChanged) return null;

    // الحد رقمي في اللقطتين: السبب من أكبر عامل تغيّر في الصيغة.
    const direction = curLimit > prevLimit ? 1 : -1;
    const reasons = [];
    const keys = [];
    // دخول سقف يُنزل الحد، وزواله يرفعه: لا يُذكر سبباً لتغيّر بالاتجاه المعاكس.
    if (direction < 0 && C.cappedBy && C.cappedBy !== P.cappedBy && CAP_REASONS[C.cappedBy]) {
      reasons.push(CAP_REASONS[C.cappedBy](C));
      keys.push(`cap_${C.cappedBy}`);
    } else if (direction > 0 && P.cappedBy && P.cappedBy !== C.cappedBy) {
      keys.push(`uncap_${P.cappedBy}`);
      reasons.push(P.cappedBy === "low_data" ? "صارت بياناته كافية فزال الحد المحافظ" : "خرج من سقف التغطية");
    }
    for (const factor of dominantFactors(creditFactorChanges(previous, current), direction)) {
      reasons.push(factor.phrase);
      keys.push(factor.key);
    }
    const smoothing = C.smoothing && C.smoothing.applied ? C.smoothing : null;
    if (!reasons.length && (smoothing || (P.smoothing && P.smoothing.applied))) {
      reasons.push(`التنعيم الأسبوعي يقرّبه تدريجياً من الحد المحسوب ${formatAmount(C.limitBaseRaw, CONFIG.baseCurrency)}`);
      keys.push("smoothing");
    }
    if (!reasons.length) {
      reasons.push("تغيّر طفيف في مكوّنات الصيغة عبر خطوة التقريب");
      keys.push("rounding");
    }
    const smoothingNote = smoothing && !keys.includes("smoothing")
      ? ` الحد المحسوب ${formatAmount(C.limitBaseRaw, CONFIG.baseCurrency)}، والتنعيم الأسبوعي حصر التغيير بين −${Math.round(CONFIG.creditHistory.maxWeeklyDecrease * 100)}% و+${Math.round(CONFIG.creditHistory.maxWeeklyIncrease * 100)}% من حد ${smoothing.baselineDate}.`
      : "";
    return { ...base, kind: "limit", direction: direction > 0 ? "up" : "down", factors: keys,
      text: `${direction > 0 ? "ارتفع" : "نزل"} الحد من ${money(prevLimit)} إلى ${money(curLimit)} لأن ${reasons.join("، و")}.${smoothingNote}` };
  }

  // اتجاه درجة الخطر من آخر 7 لقطات (لقطة اليوم + 6 سابقة): ميل المربعات الصغرى × امتداد الأيام.
  function riskTrendOf(history, currentRisk, referenceDay) {
    const H = CONFIG.creditHistory;
    if (!Number.isFinite(currentRisk) || !Number.isFinite(referenceDay)) return null;
    const prior = (history || []).filter((row) => Number.isFinite(row.riskScore)).slice(0, H.riskTrendSnapshots - 1);
    if (prior.length + 1 < H.riskTrendMinSnapshots) return null;
    const points = [...prior.slice().reverse().map((row) => [row.day, row.riskScore]), [referenceDay, currentRisk]];
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
    const sxx = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    const slope = sxx > 0 ? points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / sxx : 0;
    const delta = slope * (points[points.length - 1][0] - points[0][0]);
    const direction = delta >= H.riskTrendThreshold ? "up" : delta <= -H.riskTrendThreshold ? "down" : "flat";
    return { direction, delta: round(delta, 1), points: points.length, fromDate: dayNumberToKey(points[0][0]), toDate: dayNumberToKey(referenceDay) };
  }

  // لقطة السجل الحالي بنفس شكل صف التاريخ — مصدر واحد للكاتب وللتفسير.
  function creditSnapshotOf(row, referenceDay) {
    const auto = row.autoCredit;
    return {
      guid: row.customerGuid,
      day: referenceDay,
      date: dayNumberToKey(referenceDay),
      autoStatus: auto?.status || "",
      creditStatus: row.creditStatus,
      limitBase: Number.isFinite(auto?.limitBase) ? round(auto.limitBase, 3) : null,
      creditLimitDisplay: row.creditLimitDisplay,
      creditCurrency: row.creditCurrency || CONFIG.baseCurrency,
      riskScore: row.riskScore,
      notes: auto?.notes || [],
      factors: creditSnapshotFactors(auto)
    };
  }

  // اللقطة صالحة للتاريخ: زبون بمعرّف، حالة حد معروفة، وليست فجوة بيانات.
  function snapshotEligibleRow(row) {
    return Boolean(row && !row.isSupplier && row.customerGuid && row.autoCredit
      && AUTO_STATUS_LABELS[row.autoCredit.status] && !HISTORY_GAP_CREDIT_STATUSES.has(row.creditStatus));
  }

  function creditHistoryView(row, history, referenceDay) {
    if (!snapshotEligibleRow(row)) return { previous: null, change: null, riskTrend: null, smoothing: row.autoCredit?.smoothing ?? null };
    const current = creditSnapshotOf(row, referenceDay);
    const previous = (history || [])[0] || null;
    return {
      previous: previous ? { date: previous.date, autoStatus: previous.autoStatus, creditLimitDisplay: previous.creditLimitDisplay, creditCurrency: previous.creditCurrency, riskScore: previous.riskScore } : null,
      change: previous ? creditChangeExplanation(previous, current) : null,
      riskTrend: riskTrendOf(history, row.riskScore, referenceDay),
      smoothing: row.autoCredit?.smoothing ?? null
    };
  }

  // صفوف customer_credit_history لليوم — يستدعيها الكاتب على الخادم وحده. المحرك لا يكتب.
  // لا لقطة من بيانات غير حديثة أو بلا مصدر موسوم أو على يومين محاسبيين: لقطة كهذه تصف
  // المزامنة لا الزبون، وتفسد أساس التنعيم.
  function buildCreditSnapshots(result) {
    const referenceDate = result?.window?.referenceDate || null;
    const availability = result?.dataAvailability || {};
    const reason = !result ? "no_result"
      : !referenceDate ? "no_reference_day"
        : result.staleData ? "stale_sources"
          : !availability.autoCreditEnabled ? "auto_credit_disabled"
            : !availability.accountingDayAligned ? "accounting_day_mismatch"
              : null;
    if (reason) return { eligible: false, reason, snapshotDate: referenceDate, rows: [] };
    const referenceDay = dayNumber(referenceDate);
    const rows = result.customers.filter(snapshotEligibleRow).map((row) => {
      const snapshot = creditSnapshotOf(row, referenceDay);
      return {
        customer_guid: row.customerGuid,
        snapshot_date: referenceDate,
        auto_status: snapshot.autoStatus,
        credit_status: row.creditStatus,
        primary_segment: row.primarySegment,
        credit_limit: row.creditLimit,
        credit_limit_display: row.creditLimitDisplay,
        credit_currency: snapshot.creditCurrency,
        limit_base: snapshot.limitBase,
        limit_base_raw: snapshot.factors.limitBaseRaw,
        balance: row.currentBalance,
        balance_display: row.balanceDisplay,
        balance_currency: row.balanceCurrency || null,
        utilization_percent: row.creditUsagePercent,
        oldest_overdue_days: oldestOverdueDaysOf(row.autoCredit),
        oldest_open_days: snapshot.factors.oldestOpenDays,
        coverage: snapshot.factors.coverage,
        punctuality: snapshot.factors.punctuality,
        risk_score: row.riskScore,
        factors: snapshot.factors,
        engine_schema_version: SCHEMA_VERSION,
        computed_at: result.generatedAt
      };
    });
    return { eligible: true, reason: null, snapshotDate: referenceDate, rows };
  }

  function build(input = {}) {
    const now = input.now instanceof Date ? new Date(input.now.getTime()) : new Date(input.now || Date.now());
    const invoicesReport = input.invoicesReport || null;
    const balancesReport = input.balancesReport || null;
    const movementsReport = input.movementsReport || null;
    const creditLimits = Array.isArray(input.creditLimits) ? input.creditLimits : [];
    // تاريخ الحد (STEP 2): غيابه (undefined) = سلوك STEP 1 حرفياً؛ مصفوفة (ولو فارغة) = تنعيم وتفسير.
    const creditHistoryRows = Array.isArray(input.creditHistory) ? input.creditHistory : null;

    const balanceItems = Array.isArray(balancesReport?.items) ? balancesReport.items : [];
    const { rows: invoiceRows, truncatedGuids, truncatedNameKeys } = flattenInvoices(invoicesReport);
    const identity = buildIdentityIndex(balanceItems);
    const window = resolveWindow(invoicesReport, invoiceRows, now);
    const historyIndex = creditHistoryRows ? indexCreditHistory(creditHistoryRows, window.referenceDay) : null;

    // ── يوم المحاسبة المحلي لكل مصدر ─────────────────────────────────────────
    // `report_date` بتوقيت جهاز الأمين (نفس تعريف يوم المرجع، 8d33476) — لا تاريخ UTC.
    // الحد الآلي يحتاج المصادر الثلاثة على اليوم نفسه: بعد منتصف الليل المحلي قد تبقى لقطة
    // الفواتير على الأمس (ضمن مهلة الحداثة) بينما الحركات والأرصدة انتقلت لليوم الجديد.
    const reportLocalDay = (report) => dayNumber(report?.report_date ?? report?.reportDate ?? report?.summary?.reportDate);
    const accountingDays = {
      invoices: reportLocalDay(invoicesReport),
      movements: reportLocalDay(movementsReport),
      balances: reportLocalDay(balancesReport)
    };
    const accountingDayAligned = Object.values(accountingDays).every((day) => day !== null && day === accountingDays.invoices);

    // ── حداثة المصادر ────────────────────────────────────────────────────────
    const sourcesFreshness = {
      invoices: freshnessOf(
        isoOrNull(invoicesReport?.summary?.syncedAt) || isoOrNull(invoicesReport?.created_at ?? invoicesReport?.createdAt),
        CONFIG.freshnessMinutes.invoices,
        now
      ),
      balances: freshnessOf(
        isoOrNull(balancesReport?.summary?.syncedAt) || isoOrNull(balancesReport?.created_at ?? balancesReport?.createdAt),
        CONFIG.freshnessMinutes.balances,
        now
      ),
      movements: freshnessOf(
        isoOrNull(movementsReport?.summary?.syncedAt) || isoOrNull(movementsReport?.created_at ?? movementsReport?.createdAt),
        CONFIG.freshnessMinutes.movements,
        now
      )
    };
    const staleData = sourcesFreshness.invoices.stale
      || sourcesFreshness.balances.stale
      || sourcesFreshness.movements.stale;
    const invoicesAvailable = Boolean(invoicesReport) && invoiceRows.length > 0;

    // ── حدود customer_credit_limits القديمة: مرجع تشخيصي فقط ─────────────────
    // قرار المالك (2026-09-27): حد واحد آلي بالكامل. القيم المخزنة لا تدخل
    // الحساب ولا الحالة — تُعرض legacyCreditLimit للمقارنة وحدها.
    const legacyLimitByGuid = new Map();
    const legacyLimitByKey = new Map();
    for (const limit of creditLimits) {
      const guid = normalizeGuid(limit?.customerGuid ?? limit?.customer_guid);
      const key = text(limit?.customerKey ?? limit?.customer_key)
        || normalizeName(limit?.customerName ?? limit?.customer_name);
      if (!key && !guid) continue;
      const value = numberOrNull(limit?.creditLimit ?? limit?.credit_limit);
      if (value === null) continue;
      if (guid && !legacyLimitByGuid.has(guid)) legacyLimitByGuid.set(guid, value);
      if (!guid && key && !legacyLimitByKey.has(key)) legacyLimitByKey.set(key, value);
    }

    // ── دفتر الحساب وحدود الدورة الحية للمحفظة ─────────────────────────────
    const ledger = ledgerIndex(movementsReport);
    // تعريف واحد للمورد في كل المحرك: مع accountClasses:v1 الموثوقة صنف الشجرة هو المصدر
    // (supplier وحده مورد، ولا تقلب العلامة القديمة زبوناً إلى مورد)؛ بلا العلامة أو بلا صنف
    // للبطاقة يبقى isSupplier القديم كما هو.
    const accountClassesTrusted = text(balancesReport?.summary?.accountClasses) === ACCOUNT_CLASSES_MARKER;
    const accountClassByGuid = new Map();
    if (accountClassesTrusted) {
      for (const item of balanceItems) {
        const guid = normalizeGuid(item?.customerGuid ?? item?.customer_guid);
        if (guid) accountClassByGuid.set(guid, text(item?.accountClass ?? item?.account_class).toLowerCase());
      }
    }
    const isSupplierAccount = (guid, legacyFlag) => {
      const cls = guid ? accountClassByGuid.get(guid) : "";
      return cls ? cls === "supplier" : legacyFlag === true;
    };
    const supplierGuids = new Set(balanceItems
      .map((item) => [normalizeGuid(item?.customerGuid ?? item?.customer_guid), item?.isSupplier])
      .filter(([guid, legacyFlag]) => guid && isSupplierAccount(guid, legacyFlag))
      .map(([guid]) => guid));
    const factsByGuid = new Map();
    for (const [guid, entry] of ledger.byGuid) {
      if (supplierGuids.has(guid)) continue;
      factsByGuid.set(guid, ledgerFacts(entry, window.referenceDay, ledger.startDay));
    }

    // حسابات ليست زبائن مبيعات (فروقات جرد، سلف، قنوات داخلية): السلوك المحاسبي
    // لا الاسم — سحبها في الدفتر لا تغطيه فواتير مبيع حقيقية. يُطبَّق فقط حين
    // يغطي تقرير الفواتير نافذة السحب كاملة، وهو حديث، ويحمل معرّف الزبون في كل صف، وإلا
    // يبقى قائمة المالك المؤكدة وحدها. تُستبعد من الحد ومن عيّنة المحفظة.
    const autoConfig = CONFIG.autoCredit;
    const creditWindowStart = window.referenceDay - autoConfig.salesWindowDays;
    const invoiceCoverageStart = dayNumber(invoicesReport?.summary?.fromDate)
      ?? (invoiceRows.length ? Math.min(...invoiceRows.map((row) => row.day)) : null);
    const invoicesProveSales = invoicesAvailable && !sourcesFreshness.invoices.stale
      && invoiceCoverageStart !== null && invoiceCoverageStart <= creditWindowStart
      && invoiceRows.every((row) => row.customerGuid);
    const invoicedSalesByGuid = new Map();
    for (const row of invoiceRows) {
      if (row.isReturn || row.day < creditWindowStart || row.day > window.referenceDay) continue;
      const baseValue = row.grossValue * (row.currencyVal ?? 1);
      invoicedSalesByGuid.set(row.customerGuid, (invoicedSalesByGuid.get(row.customerGuid) || 0) + baseValue);
    }
    const excludedGuids = new Set(autoConfig.excludedAccountGuids.map(normalizeGuid));
    const reviewGuids = new Set(autoConfig.reviewAccountGuids.map(normalizeGuid));
    // قائمتا المالك تُبنيان من المعرّفات مباشرة لا من الدفتر: حساب مدرج بلا أي حركة
    // في نافذة التقرير (فيغيب عن تقرير الحركات) يبقى مصنَّفاً ولا يسقط إلى حد الأمين.
    const nonCustomerByGuid = new Map([...excludedGuids].map((guid) => [guid, "حساب أكّد المالك أنه ليس زبون مبيعات: لا حد ائتمان."]));
    const needsReviewByGuid = new Map([...reviewGuids].filter((guid) => !excludedGuids.has(guid)).map((guid) => [guid,
      { kind: "explicit", reason: "حساب مختلط (مورد وزبون): حركته تحوي مشتريات ومدفوعات مورد لا تُفصل بأمان من المصدر الحالي." }]));
    // شجرة الحسابات (قرار المالك 2026-09-28): بطاقة الزبون وحدها ليست دليلاً. حساب تحت شجرة
    // غير تجارية ⇒ «ليس زبون مبيعات»، ومسار غامض أو غائب مع العلامة ⇒ «يحتاج مراجعة». بلا
    // العلامة لا شيء يتغير (القوائم الصريحة وحدها). قائمتا المالك تسبقان.
    const treeListedGuids = new Set();
    if (accountClassesTrusted) {
      for (const item of balanceItems) {
        const guid = normalizeGuid(item?.customerGuid ?? item?.customer_guid);
        if (!guid) continue;
        const cls = accountClassByGuid.get(guid);
        if (isSupplierAccount(guid, item?.isSupplier) || cls === "customer") continue;
        if (nonCustomerByGuid.has(guid) || needsReviewByGuid.has(guid)) continue;
        treeListedGuids.add(guid);
        if (NON_CUSTOMER_ACCOUNT_CLASSES[cls]) {
          nonCustomerByGuid.set(guid, `حساب خارج شجرة الزبائن في دليل الحسابات (${NON_CUSTOMER_ACCOUNT_CLASSES[cls]}): ليس زبون مبيعات.`);
        } else {
          needsReviewByGuid.set(guid, { kind: "tree", reason: "مسار الحساب في دليل الحسابات غير واضح (ليس تحت الزبائن ولا الموردين): يحتاج مراجعة، بلا حد آلي." });
        }
      }
    }
    for (const [guid, facts] of factsByGuid) {
      if (nonCustomerByGuid.has(guid) || needsReviewByGuid.has(guid)) continue;
      // تحت lineKinds:v1: حركات unknown مادية (≥ حد الأهمية نفسه delinquentMinAmount = 50،
      // المستعمل لشذوذ الدفتر أعلاه وللتعثّر) تجعل مدخلات الحد ملتبسة: «يحتاج مراجعة»، يسبق
      // التعثّر، خارج عيّنة المحفظة. دون الحد لا يوقف الحساب (ولا يُعدّ سحباً ولا دفعة أصلاً).
      if (facts.unknownAmount >= autoConfig.delinquentMinAmount) {
        needsReviewByGuid.set(guid, { kind: "unknown", reason: `يحتاج مراجعة نوع الحركة: حركات غير مصنّفة من المصدر بقيمة ${Math.round(facts.unknownAmount)} في دفتره.` });
        continue;
      }
      // دور مختلط: مشترياتنا منه مادية (≥ حد الأهمية و≥ 5% من نشاطه). المشتريات ليست سداداً ولا
      // تسوية (lineKind)، والحساب بلا حد آلي وخارج معايرة المحفظة، والتعثّر الحقيقي يبقى.
      if (ledger.lineKindsTrusted && facts.purchaseAmount >= autoConfig.delinquentMinAmount
        && facts.purchaseAmount / (facts.purchaseAmount + facts.saleAmount) >= autoConfig.mixedRolePurchaseMinShare) {
        const share = Math.round((facts.purchaseAmount / (facts.purchaseAmount + facts.saleAmount)) * 100);
        needsReviewByGuid.set(guid, { kind: "mixed", reason: `دور مختلط (زبون ومورد): مشترياتنا منه ${Math.round(facts.purchaseAmount)} (${share}% من نشاطه مع مبيعاته)، فلا حد آلي موثوق.` });
        continue;
      }
      if (!invoicesProveSales || facts.truncated || !(facts.sales60 > 0) || truncatedGuids.has(guid)) continue;
      const invoiced = invoicedSalesByGuid.get(guid) || 0;
      // فرق دون حد الأهمية (بقايا وتسويات صغيرة) لا يشغّل المراجعة.
      if (facts.sales60 - invoiced < autoConfig.delinquentMinAmount) continue;
      if (invoiced < autoConfig.salesInvoiceMinShare * facts.sales60) {
        needsReviewByGuid.set(guid, { kind: "suspect", reason: `يحتاج مراجعة نوع الحركة: فواتير المبيع تغطي ${Math.round((invoiced / facts.sales60) * 100)}% فقط من سحبه في الدفتر.` });
      }
    }
    // الحد الآلي مغلق (fail-closed) ما لم يحمل تقرير الحركات العلامة lineKinds:v1.
    const autoCreditGated = ledger.byGuid.size > 0 && !ledger.lineKindsTrusted;
    // عيّنة المحفظة من حسابات موثوقة الحركة فقط.
    const cycleStats = portfolioCycleStats([...factsByGuid.entries()]
      .filter(([guid]) => !nonCustomerByGuid.has(guid) && !needsReviewByGuid.has(guid))
      .map(([, facts]) => facts));

    // سعر الصرف لحساب بعملة غير الأساس: آخر CurrencyVal لفواتير الزبون بتلك
    // العملة، وإلا آخر معدّل في المحفظة كلها لنفس العملة.
    const latestRateByCurrency = new Map();
    const latestRateByGuid = new Map();
    for (const row of invoiceRows) {
      if (!row.currency || row.currency === CONFIG.baseCurrency || row.currencyVal === null) continue;
      const portfolio = latestRateByCurrency.get(row.currency);
      if (!portfolio || row.day > portfolio.day) latestRateByCurrency.set(row.currency, { day: row.day, rate: row.currencyVal });
      if (row.customerGuid) {
        const own = latestRateByGuid.get(row.customerGuid);
        if (!own || row.day > own.day) latestRateByGuid.set(row.customerGuid, { day: row.day, rate: row.currencyVal, currency: row.currency });
      }
    }
    function accountDisplay(balanceRow, guid) {
      if (!balanceRow || balanceRow.accountCurrencyIsBase !== false) return { currency: CONFIG.baseCurrency, rate: null };
      const own = guid ? latestRateByGuid.get(guid) : null;
      if (own) return { currency: own.currency, rate: own.rate, rateBasis: "customer_latest_invoice" };
      // حساب ليرة بلا فواتير بعملته: أحدث معدّل لأي عملة غير الأساس (عملة واحدة حالياً).
      const fallback = [...latestRateByCurrency.entries()].sort((a, b) => b[1].day - a[1].day)[0];
      if (fallback) return { currency: fallback[0], rate: fallback[1].rate, rateBasis: "portfolio_latest_invoice" };
      // لا معدّل في اللقطة كلها: تبقى عملة الحساب المعلنة (لا يُعامَل كحساب دولار برصيد
      // فيه فروقات صرف)، والمعدّل null يجعل الحد والاستخدام غير متاحين في resolveCredit.
      return { currency: String(balanceRow.accountCurrency || "").trim() || "عملة الحساب", rate: null, rateBasis: "missing" };
    }

    // ── نسب صفوف الفواتير إلى هوية ──────────────────────────────────────────
    // مفتاح السجل: GUID عند توفره، وإلا الاسم المطبَّع. الاسم الملتبس (أكثر من
    // GUID) لا يُنسب إطلاقاً.
    const records = new Map();
    const unresolvedByAmbiguity = [];

    function ensureRecord(recordKey, seed) {
      if (!records.has(recordKey)) {
        records.set(recordKey, {
          recordKey,
          customerId: seed.customerId,
          customerGuid: seed.customerGuid,
          customerName: seed.customerName,
          nameKey: seed.nameKey,
          identityBasis: seed.identityBasis,
          balanceRow: seed.balanceRow || null,
          rows: []
        });
      }
      const record = records.get(recordKey);
      if (!record.balanceRow && seed.balanceRow) record.balanceRow = seed.balanceRow;
      if (!record.customerGuid && seed.customerGuid) record.customerGuid = seed.customerGuid;
      return record;
    }

    // 1) كل زبون في تقرير الأرصدة يستحق سجلاً حتى لو بلا فواتير.
    for (const [guid, entry] of identity.byGuid) {
      ensureRecord(`guid:${guid}`, {
        customerId: guid,
        customerGuid: guid,
        customerName: entry.customerName,
        nameKey: entry.nameKey,
        identityBasis: "ameen_customer_guid",
        balanceRow: entry.balanceRow
      });
    }
    for (const [key, entry] of identity.nameOnly) {
      ensureRecord(`name:${key}`, {
        customerId: `name:${key}`,
        customerGuid: null,
        customerName: entry.customerName,
        nameKey: key,
        identityBasis: "normalized_name",
        balanceRow: entry.balanceRow
      });
    }

    // 2) صفوف الفواتير.
    for (const row of invoiceRows) {
      if (row.customerGuid) {
        const known = identity.byGuid.get(row.customerGuid);
        ensureRecord(`guid:${row.customerGuid}`, {
          customerId: row.customerGuid,
          customerGuid: row.customerGuid,
          customerName: known?.customerName || row.customerName,
          nameKey: known?.nameKey || row.nameKey,
          identityBasis: "ameen_customer_guid",
          balanceRow: known?.balanceRow || null
        }).rows.push(row);
        continue;
      }

      if (identity.ambiguousNames.has(row.nameKey)) {
        unresolvedByAmbiguity.push(row);
        continue;
      }

      const guids = identity.nameToGuids.get(row.nameKey);
      if (guids && guids.size === 1) {
        const guid = [...guids][0];
        const known = identity.byGuid.get(guid);
        ensureRecord(`guid:${guid}`, {
          customerId: guid,
          customerGuid: guid,
          customerName: known?.customerName || row.customerName,
          nameKey: row.nameKey,
          identityBasis: "normalized_name_to_guid",
          balanceRow: known?.balanceRow || null
        }).rows.push(row);
        continue;
      }

      ensureRecord(`name:${row.nameKey}`, {
        customerId: `name:${row.nameKey}`,
        customerGuid: null,
        customerName: row.customerName,
        nameKey: row.nameKey,
        identityBasis: "normalized_name",
        balanceRow: identity.nameOnly.get(row.nameKey)?.balanceRow || null
      }).rows.push(row);
    }

    // أسماء ملتبسة خلّفت فواتير بلا نسبة: هي وحدها ما يمنع احتساب مبيعات
    // أصحابها. لو حملت الفواتير GUID (بعد ترقية push-customer-invoices.ps1) لما
    // بقي صف غير منسوب، فلا يعاقَب الزبون على تشابه اسم لم يعد يُستعمل للربط.
    const ambiguousUnresolvedNames = new Set(unresolvedByAmbiguity.map((row) => row.nameKey));

    // ── حساب كل زبون ────────────────────────────────────────────────────────
    const drafts = [];

    for (const record of records.values()) {
      const rows = record.rows;
      // غياب العملة = عملة الأساس. نطبّع قبل Set لا نحذف: null بجانب SYP يجب
      // أن يكشف التنوع (USD+SYP)، لا أن يختفي ويجعل SYP وحيدة فتُجمع مبالغ بعملتين.
      const currencies = new Set(rows.map((row) => row.currency || CONFIG.baseCurrency));
      const currencyMixed = currencies.size > 1;
      const currency = currencies.size === 1 ? [...currencies][0] : CONFIG.baseCurrency;

      const currentRows = rows.filter((row) => row.day >= window.currentStart && row.day <= window.referenceDay);
      const previousRows = rows.filter((row) => row.day >= window.previousStart && row.day <= window.previousEnd);
      const windowRows = rows.filter((row) => row.day >= window.previousStart && row.day <= window.referenceDay);

      const current = summarizePeriod(currentRows);
      const previous = summarizePeriod(previousRows);
      const combined = summarizePeriod(windowRows);

      const saleDays = rows.filter((row) => !row.isReturn).map((row) => row.day);
      const firstPurchaseDay = saleDays.length ? Math.min(...saleDays) : null;
      const lastPurchaseDay = saleDays.length ? Math.max(...saleDays) : null;
      const daysSinceLastPurchase = lastPurchaseDay === null ? null : window.referenceDay - lastPurchaseDay;

      const cadence = purchaseCadence(saleDays);
      const legacyCreditLimit = record.customerGuid
        ? (legacyLimitByGuid.get(record.customerGuid) ?? legacyLimitByKey.get(record.nameKey) ?? null)
        : (legacyLimitByKey.get(record.nameKey) ?? null);
      const isSupplierRecord = isSupplierAccount(record.customerGuid, record.balanceRow?.isSupplier);
      const display = accountDisplay(record.balanceRow, record.customerGuid);
      let auto = null;
      // قائمتا المالك (بالمعرّف) لا تحتاجان بيانات حديثة، فتسبقان مسار المصدر القديم:
      // لا يظهر حد الأمين بديلاً لحساب مستبعد أو مختلط عند توقف المزامنة.
      const ownerListed = excludedGuids.has(record.customerGuid) || reviewGuids.has(record.customerGuid)
        || treeListedGuids.has(record.customerGuid);
      // بوابة الحد الآلي: الحركات والأرصدة والفواتير حديثة كلها (مهل CONFIG.freshnessMinutes
      // نفسها). يوم المرجع ونافذة السحب مرتكزان إلى لقطة الفواتير، فقِدمها يُخرج مبيعات أحدث
      // من النافذة بينما الرصيد وFIFO حاليان — لا حد ولا تعثّر ولا «غير نشط» منها.
      const staleCreditSource = ownerListed ? null
        : sourcesFreshness.movements.stale ? "movements"
          : sourcesFreshness.balances.stale ? "balances"
            : sourcesFreshness.invoices.stale ? "invoices"
              // حداثة كل مصدر وحده لا تكفي: الثلاثة على يوم المحاسبة المحلي نفسه (تحت v1).
              : ledger.lineKindsTrusted && !accountingDayAligned ? "accounting_day" : null;
      if (!isSupplierRecord && record.customerGuid && ownerListed) {
        // التصنيف من القائمة وحدها: لا يحتاج دفتراً ولا حركة ولا بيانات حديثة.
        auto = nonCustomerByGuid.has(record.customerGuid)
          ? { status: "non_customer", limitBase: null, notes: [nonCustomerByGuid.get(record.customerGuid)] }
          : { status: "needs_review", limitBase: null, notes: [needsReviewByGuid.get(record.customerGuid).reason] };
      } else if (!isSupplierRecord && record.customerGuid && ledger.byGuid.size > 0 && staleCreditSource) {
        // دفتر حركات أو تقرير أرصدة متوقف المزامنة: لا حد آلي ولا حكم تعثّر من بيانات قديمة.
        const review = needsReviewByGuid.get(record.customerGuid) || null;
        auto = review
          // «يحتاج مراجعة» حكم على نوع الحركة لا على حداثتها: يبقى، وبلا حد كما هو.
          ? { status: "needs_review", limitBase: null, staleLedger: true, mixedRole: review.kind === "mixed", notes: [review.reason, staleCreditNote(staleCreditSource, sourcesFreshness)] }
          : { status: "unavailable", limitBase: null, staleLedger: true, notes: [staleCreditNote(staleCreditSource, sourcesFreshness)] };
      } else if (!isSupplierRecord && record.customerGuid && autoCreditGated) {
        // قرار المالك (2026-09-27، Codex P1): بلا lineKinds:v1 يخلط الدفتر الحسم والمشتريات
        // بالدفعات، فلا حد آلي ولا حكم تعثّر منه. «يحتاج مراجعة» حكم على الحساب يبقى.
        const review = needsReviewByGuid.get(record.customerGuid) || null;
        auto = review
          ? { status: "needs_review", limitBase: null, untypedLedger: true, mixedRole: review.kind === "mixed", notes: [review.reason, UNTYPED_LEDGER_NOTE] }
          : { status: "unavailable", limitBase: null, untypedLedger: true, notes: [UNTYPED_LEDGER_NOTE] };
      } else if (!isSupplierRecord && record.customerGuid && ledger.byGuid.size > 0) {
        const facts = factsByGuid.get(record.customerGuid) || null;
        const rawBalance = numberOrNull(record.balanceRow?.balance);
        const accountBalance = numberOrNull(record.balanceRow?.balanceAccountCcy);
        // الرصيد الموحّد بعملة الأساس: حساب الليرة برصيده بعملته × المعدّل
        // (balance بالدولار فيه فروقات صرف تاريخية)، وبلا صف رصيد: رصيد الدفتر.
        const unifiedBalance = display.rate !== null && accountBalance !== null
          ? accountBalance * display.rate
          : (rawBalance ?? facts?.balance ?? 0);
        const nonCustomerReason = nonCustomerByGuid.get(record.customerGuid) || null;
        const review = needsReviewByGuid.get(record.customerGuid) || null;
        auto = computeAutoCredit(facts, cycleStats, unifiedBalance, window.referenceDay, {
          nonCustomer: nonCustomerReason !== null,
          nonCustomerReason,
          needsReview: review?.kind ?? null,
          needsReviewReason: review?.reason ?? null
        });
        if (display.rate !== null) auto.exchangeRate = display.rate;
        if (ledger.lineKindsTrusted && !["non_customer", "needs_review", "unavailable"].includes(auto.status)) {
          const oldDebt = oldDebtCollectionOf(facts, unifiedBalance, window.referenceDay);
          if (oldDebt) auto.oldDebtCollection = oldDebt;
        }
        // التنعيم الأسبوعي قبل حكم الاستخدام/التجاوز: الحد المعروض هو الحد المنعَّم.
        if (historyIndex) smoothAutoCredit(auto, historyIndex.get(record.customerGuid), window.referenceDay);
      }
      const credit = resolveCredit(record.balanceRow, auto, display, legacyCreditLimit, {
        balancesStale: sourcesFreshness.balances.stale,
        invoicesStale: sourcesFreshness.invoices.stale && !isSupplierRecord,
        dayMismatch: staleCreditSource === "accounting_day" && !isSupplierRecord,
        // معدّل تحويل حد الأمين من الفواتير: اختلاف يوم المحاسبة يمسّه مع v1 وبدونه (Codex P1).
        ameenFxDayMismatch: !accountingDayAligned && !isSupplierRecord,
        autoGated: autoCreditGated && !isSupplierRecord
      });
      // «تجاوز/قرب الحد» مقابل حد مبني على مبيعات حديثة صغيرة بينما الرصيد دين قديم يُحصَّل:
      // يُعرض «تحصيل دين قديم» بلا نسبة استخدام. الرصيد والحد كما هما، والتعثّر لا يُمسّ.
      if (credit.autoCredit?.oldDebtCollection && ["over_limit", "near_limit"].includes(credit.creditStatus)) {
        credit.creditStatus = "old_debt_collection";
        credit.creditUsagePercent = null;
      }
      // أصناف مختلطة العملة: لا نجمع lineTotals بعملات مختلفة — نُعيد صفر أصناف.
      const items = currencyMixed ? { items: [], identity: "item_guid" } : topItems(windowRows);

      const ambiguousIdentity = ambiguousUnresolvedNames.has(record.nameKey);
      // اقتطاع: إذا كان المنتج قيّد السجل إلى آخر 200 فاتورة فقط، تُعدّ البيانات
      // غير مكتملة وتُعطَّل مؤشرات المبيعات حتى لا يُقرأ الاتجاه قراءة خاطئة.
      const truncated = (record.customerGuid ? truncatedGuids.has(record.customerGuid) : false)
        || truncatedNameKeys.has(record.nameKey);
      const usableSales = invoicesAvailable && !currencyMixed && !ambiguousIdentity && !truncated;

      drafts.push({
        record,
        currency,
        currencyMixed,
        truncated,
        ambiguousIdentity,
        usableSales,
        current,
        previous,
        combined,
        firstPurchaseDay,
        lastPurchaseDay,
        daysSinceLastPurchase,
        saleDays,
        cadence,
        credit,
        items,
        isSupplier: isSupplierRecord
      });
    }

    // ── ترتيب وأرضية التراجع لكل عملة على حدة ───────────────────────────────
    // الموردون خارج العيّنة. عملتان مختلفتان لا تدخلان وسيطاً واحداً ولا ترتيب VIP
    // واحداً: رقم ليرة لا يُقارَن برقم دولار.
    function rankCohort(cohortDrafts) {
      const positivePrevious = cohortDrafts
        .filter((draft) => draft.usableSales && draft.previous.netSales > 0)
        .map((draft) => draft.previous.netSales);
      const medianPrevious = median(positivePrevious) ?? 0;
      const declineFloor = Math.max(1, round(medianPrevious * CONFIG.declineMinPreviousShareOfMedian, 3));
      const vipCandidates = cohortDrafts.filter(
        (draft) => draft.usableSales && draft.combined.netSales > 0 && draft.combined.invoiceCount >= CONFIG.vipMinInvoices
      );
      const vipPopulation = vipCandidates.length;
      const vipRankingReliable = vipPopulation >= CONFIG.vipMinPopulation;

      const valueSeries = vipCandidates.map((draft) => draft.combined.netSales).sort((a, b) => a - b);
      const frequencySeries = vipCandidates.map((draft) => draft.combined.invoiceCount).sort((a, b) => a - b);
      const continuitySeries = vipCandidates
        .map((draft) => new Set(draft.combined.purchaseDays.map((day) => Math.floor(day / 7))).size)
        .sort((a, b) => a - b);

      const compositeByRecord = new Map();
      for (const draft of vipCandidates) {
        const activeWeeks = new Set(draft.combined.purchaseDays.map((day) => Math.floor(day / 7))).size;
        const valueScore = percentileRank(valueSeries, draft.combined.netSales);
        const frequencyScore = percentileRank(frequencySeries, draft.combined.invoiceCount);
        const continuityScore = percentileRank(continuitySeries, activeWeeks);
        const composite = round(
          CONFIG.vipWeights.value * valueScore
          + CONFIG.vipWeights.frequency * frequencyScore
          + CONFIG.vipWeights.continuity * continuityScore,
          2
        );
        compositeByRecord.set(draft.record.recordKey, { composite, valueScore, frequencyScore, continuityScore, activeWeeks });
      }

      const ranked = vipCandidates.slice().sort((a, b) => {
        const scoreA = compositeByRecord.get(a.record.recordKey).composite;
        const scoreB = compositeByRecord.get(b.record.recordKey).composite;
        return scoreB - scoreA
          || b.combined.netSales - a.combined.netSales
          || a.record.recordKey.localeCompare(b.record.recordKey);
      });
      const vipCutoff = vipRankingReliable ? Math.max(1, Math.ceil(CONFIG.vipTopShare * vipPopulation)) : 0;
      // الزبون المهم بالقيمة: العيّنة وشرط موثوقيتها نفسهما، مرتبة بصافي المشتريات وحده.
      const valueRanked = vipCandidates.slice().sort((a, b) => b.combined.netSales - a.combined.netSales
        || a.record.recordKey.localeCompare(b.record.recordKey));
      const valueCutoff = vipRankingReliable ? Math.max(1, Math.ceil(CONFIG.keyCustomerAlert.valueTopShare * vipPopulation)) : 0;
      return {
        valueTopKeys: new Set(valueRanked.slice(0, valueCutoff).map((draft) => draft.record.recordKey)),
        valueRankByRecord: new Map(valueRanked.map((draft, index) => [draft.record.recordKey, index + 1])),
        declineFloor,
        vipPopulation,
        vipRankingReliable,
        compositeByRecord,
        vipKeys: new Set(ranked.slice(0, vipCutoff).map((draft) => draft.record.recordKey)),
        rankByRecord: new Map(ranked.map((draft, index) => [draft.record.recordKey, index + 1]))
      };
    }

    const rankingDrafts = drafts.filter((draft) => !draft.isSupplier && !draft.currencyMixed);
    const draftsByCurrency = new Map();
    for (const draft of rankingDrafts) {
      const code = draft.currency || CONFIG.baseCurrency;
      const list = draftsByCurrency.get(code);
      if (list) list.push(draft);
      else draftsByCurrency.set(code, [draft]);
    }

    const compositeByRecord = new Map();
    const vipKeys = new Set();
    const rankByRecord = new Map();
    const declineFloorByRecord = new Map();
    const rankingReliableByRecord = new Map();
    const valueTopKeys = new Set();
    const valueRankByRecord = new Map();
    const rankedByCurrency = new Map();
    for (const [code, cohort] of draftsByCurrency) {
      const rankedCohort = rankCohort(cohort);
      rankedByCurrency.set(code, rankedCohort);
      for (const [key, value] of rankedCohort.compositeByRecord) compositeByRecord.set(key, value);
      for (const key of rankedCohort.vipKeys) vipKeys.add(key);
      for (const [key, rank] of rankedCohort.rankByRecord) rankByRecord.set(key, rank);
      for (const key of rankedCohort.valueTopKeys) valueTopKeys.add(key);
      for (const [key, rank] of rankedCohort.valueRankByRecord) valueRankByRecord.set(key, rank);
      for (const draft of cohort) {
        declineFloorByRecord.set(draft.record.recordKey, rankedCohort.declineFloor);
        rankingReliableByRecord.set(draft.record.recordKey, rankedCohort.vipRankingReliable);
      }
    }

    const baseCohort = rankedByCurrency.get(CONFIG.baseCurrency) || rankCohort([]);
    const vipPopulation = baseCohort.vipPopulation;
    const vipRankingReliable = baseCohort.vipRankingReliable;
    const declineFloor = baseCohort.declineFloor;

    // ── التصنيف النهائي ──────────────────────────────────────────────────────
    const customers = drafts.map((draft) => {
      const composite = compositeByRecord.get(draft.record.recordKey) || null;
      const flags = [];
      const reasons = [];

      if (draft.ambiguousIdentity) flags.push("ambiguous_identity");
      if (draft.currencyMixed) flags.push("mixed_currency");
      if (staleData || draft.credit.autoCredit?.staleLedger) flags.push("stale_data");
      if (draft.isSupplier) flags.push("supplier_account");

      const trend = draft.usableSales
        ? trendOf(draft.current.netSales, draft.previous.netSales, window.previousWindowCovered)
        : { percent: null, state: "insufficient_data" };

      // خمول
      const inactiveThreshold = draft.cadence.inactiveThresholdDays;
      const isInactive = draft.usableSales
        && draft.daysSinceLastPurchase !== null
        && draft.daysSinceLastPurchase > inactiveThreshold;
      const isChurnRisk = !isInactive
        && draft.usableSales
        && draft.daysSinceLastPurchase !== null
        && draft.cadence.typicalGapDays !== null
        && draft.daysSinceLastPurchase > CONFIG.churnRiskGapMultiplier * draft.cadence.typicalGapDays;

      // عودة للنشاط: آخر شراء داخل الفترة الحالية، وسبقته فجوة تتجاوز حد الخمول.
      let isReactivated = false;
      if (draft.usableSales && draft.lastPurchaseDay !== null && draft.lastPurchaseDay >= window.currentStart) {
        const unique = [...new Set(draft.saleDays)].sort((a, b) => a - b);
        if (unique.length >= 2) {
          const gapBeforeLast = unique[unique.length - 1] - unique[unique.length - 2];
          isReactivated = gapBeforeLast > inactiveThreshold;
        }
      }

      // جديد: أول ظهور داخل النافذة المرصودة، بعد هامش أمان من حافتها.
      const edgeDay = window.coverageStartDay === null
        ? null
        : window.coverageStartDay + CONFIG.newCustomerEdgeGraceDays;
      const observedStart = draft.firstPurchaseDay !== null && edgeDay !== null && draft.firstPurchaseDay > edgeDay;
      const isNew = Boolean(draft.usableSales && observedStart);
      // «جديد» يصلح تصنيفاً أساسياً فقط لمن ظهر داخل الفترة الحالية. من بدأ قبلها
      // عاش فترة مقارنة كاملة، فوصفه بـ«جديد» يحجب واقعه الأهم (تراجع/تعثّر) —
      // ويبقى flag «جديد» عليه لأن أول ظهوره فعلاً داخل النافذة المرصودة.
      const isNewPrimary = isNew && draft.firstPurchaseDay >= window.currentStart;
      const possiblyNew = Boolean(
        draft.usableSales
        && !isNew
        && draft.firstPurchaseDay !== null
        && edgeDay !== null
        && draft.firstPurchaseDay <= edgeDay
        && draft.combined.invoiceCount <= 2
      );

      // تراجع: نشاط سابق ذو دلالة + انخفاض واضح.
      const previousQualifies = draft.previous.invoiceCount >= CONFIG.declineMinPreviousInvoices
        && draft.previous.netSales >= (declineFloorByRecord.get(draft.record.recordKey) ?? 1);
      const isDeclining = Boolean(
        draft.usableSales
        && trend.state === "measured"
        && previousQualifies
        && trend.percent !== null
        && trend.percent <= CONFIG.declineTrendPercent
      );
      const isGrowing = Boolean(
        draft.usableSales
        && trend.state === "measured"
        && previousQualifies
        && trend.percent !== null
        && trend.percent >= CONFIG.growthTrendPercent
      );

      const isVip = vipKeys.has(draft.record.recordKey);
      const hasCurrentActivity = draft.current.invoiceCount > 0;
      const noPurchasesInWindow = draft.usableSales && draft.combined.billCount === 0;

      if (isVip) flags.push("vip");
      if (rankingReliableByRecord.get(draft.record.recordKey) === false && !draft.isSupplier && draft.usableSales && draft.combined.netSales > 0) flags.push("vip_ranking_unreliable");
      if (isInactive) flags.push("inactive");
      if (isChurnRisk) flags.push("at_risk_churn");
      if (isReactivated) flags.push("reactivated");
      if (isNew) flags.push("new");
      if (possiblyNew) flags.push("possibly_new");
      if (isDeclining) flags.push("declining");
      if (isGrowing) flags.push("growing");
      if (noPurchasesInWindow) flags.push("no_purchases_in_window");
      if (!window.previousWindowCovered) flags.push("insufficient_history");
      // «النمط غير محسوب» يعني تعذّر قياسه رغم وجود مشتريات. من لا مشتريات له
      // أصلاً يكفيه no_purchases_in_window — وإلا صار كل سجل خامل يحمل تنبيهين
      // يقولان الشيء نفسه.
      if (!draft.cadence.cadenceTrusted && draft.usableSales && draft.saleDays.length > 0) flags.push("cadence_unknown");
      if (draft.combined.returns > draft.combined.sales && draft.combined.billCount > 0) flags.push("returns_exceed_sales");
      if (draft.credit.creditStatus === "over_limit") flags.push("over_credit_limit");
      if (draft.credit.creditStatus === "near_limit") flags.push("near_credit_limit");
      if (draft.credit.creditStatus === "unknown_limit") flags.push("credit_limit_unknown");
      if (draft.credit.creditStatus === "unknown_balance") flags.push("credit_balance_unknown");
      if (draft.credit.creditStatus === "delinquent") flags.push("credit_delinquent");
      if (draft.credit.creditStatus === "inactive_no_limit") flags.push("credit_inactive");
      if (draft.credit.creditStatus === "not_customer") flags.push("credit_not_customer");
      if (draft.credit.creditStatus === "needs_review") flags.push("credit_needs_review");
      if (draft.credit.autoCredit?.mixedRole) flags.push("credit_mixed_role");
      if (draft.credit.autoCredit?.oldDebtCollection) flags.push("old_debt_collection");
      if (draft.credit.autoCredit?.status === "low_data") flags.push("credit_low_data");
      if (draft.credit.autoCredit?.smoothing?.applied) flags.push("credit_smoothed");

      // الزبون المهم وغيابه (CUSTOMER_INACTIVE_5D): بلا مورد ولا «ليس زبون مبيعات» ولا مبيعات غير صالحة.
      const K = CONFIG.keyCustomerAlert;
      const keyEligible = draft.usableSales && !draft.isSupplier && draft.credit.creditStatus !== "not_customer";
      const purchaseDays30 = new Set(draft.current.purchaseDays).size;
      const keyByValue = keyEligible && valueTopKeys.has(draft.record.recordKey);
      const keyByRegularity = keyEligible && purchaseDays30 >= K.regularMinPurchaseDays;
      const keyCustomer = keyByValue || keyByRegularity
        ? {
          byValue: keyByValue,
          byRegularity: keyByRegularity,
          valueRank: valueRankByRecord.get(draft.record.recordKey) ?? null,
          purchaseDays30,
          // معدل المشتريات الشهرية = صافي 60 يوماً ÷ شهرين، بعملة الزبون.
          monthlyPurchases: round(draft.combined.netSales / 2, 3),
          absent: draft.daysSinceLastPurchase !== null && draft.daysSinceLastPurchase >= K.inactiveDays
        }
        : null;
      if (keyCustomer) flags.push("key_customer");
      if (keyCustomer?.absent) flags.push("key_customer_absent");

      // ترتيب أولوية التصنيف الأساسي (موثّق في docs/ai/topics/customer-intelligence.md).
      // ملاحظة مقصودة: VIP يسبق التراجع، فزبون VIP متراجع يبقى VIP مع flag تراجع.
      let primarySegment;
      if (!draft.usableSales) primarySegment = "insufficient_data";
      else if (noPurchasesInWindow) primarySegment = "insufficient_data";
      else if (isInactive) primarySegment = "inactive";
      else if (isVip) primarySegment = "vip";
      else if (isNewPrimary) primarySegment = "new";
      else if (isReactivated) primarySegment = "reactivated";
      else if (isDeclining) primarySegment = "declining";
      else if (["over_limit", "near_limit", "delinquent"].includes(draft.credit.creditStatus)) primarySegment = "at_risk_debt";
      else if (hasCurrentActivity) primarySegment = "regular";
      else primarySegment = "dormant";

      // ── الدرجات ────────────────────────────────────────────────────────────
      const valueScore = composite ? composite.valueScore : 0;
      const frequencyScore = composite ? composite.frequencyScore : 0;
      const recencyScore = draft.daysSinceLastPurchase === null
        ? 0
        : round(100 * clamp(1 - draft.daysSinceLastPurchase / Math.max(1, inactiveThreshold), 0, 1), 2);
      const activityScore = round(0.5 * recencyScore + 0.5 * frequencyScore, 2);

      let creditRisk = 0;
      if (draft.credit.creditStatus === "over_limit" || draft.credit.creditStatus === "delinquent") creditRisk = 100;
      else if (draft.credit.creditStatus === "near_limit") creditRisk = 80;
      else if (draft.credit.creditUsagePercent !== null) creditRisk = round(clamp(draft.credit.creditUsagePercent * 0.7, 0, 70), 2);
      else if (draft.credit.currentBalance > 0) creditRisk = 35;

      let churnRisk = 0;
      if (isInactive) churnRisk = 90;
      else if (isChurnRisk) churnRisk = 60;
      else if (isDeclining) churnRisk = 45;

      const riskScore = round(Math.max(creditRisk, churnRisk), 2);

      // ── تفسير مختصر deterministic (لا صياغة احتمالية) ──────────────────────
      if (!draft.usableSales) {
        if (draft.ambiguousIdentity) reasons.push("اسم الزبون يقابل أكثر من معرّف في الأمين، فلا تُنسب له مبيعات.");
        else if (draft.currencyMixed) reasons.push("فواتير هذا الزبون بأكثر من عملة، ولا يجوز جمعها.");
        else if (draft.truncated) reasons.push("سجل هذا الزبون مقتطع (تجاوز الحد الأقصى للفواتير)، فلا تُحسب مؤشراته.");
        else if (!invoicesAvailable) reasons.push("لا يتوفّر تقرير فواتير لحساب مبيعات هذا الزبون.");
        else reasons.push("لا توجد فواتير لهذا الزبون ضمن النافذة المتاحة.");
      } else {
        if (trend.state === "measured" && trend.percent !== null) {
          if (trend.percent === 0) {
            reasons.push(`صافي شراء هذا الزبون لم يتغيّر مقارنة بالـ${CONFIG.periodDays} يوماً السابقة.`);
          } else {
            const direction = trend.percent < 0 ? "تراجع" : "ارتفع";
            reasons.push(`${direction} صافي شراء هذا الزبون ${Math.abs(trend.percent)}% مقارنة بالـ${CONFIG.periodDays} يوماً السابقة.`);
          }
        } else if (trend.state === "new_activity") {
          reasons.push(`لا مبيعات في الفترة السابقة و${draft.current.invoiceCount} فاتورة في الفترة الحالية.`);
        } else if (trend.state === "no_activity") {
          reasons.push("لا مبيعات في الفترتين الحالية والسابقة.");
        } else if (trend.state === "insufficient_data") {
          reasons.push("نافذة البيانات لا تغطي الفترة السابقة كاملة، فلا تُحسب نسبة تغيّر.");
        }
        if (isInactive) {
          reasons.push(draft.cadence.cadenceTrusted
            ? `غاب ${draft.daysSinceLastPurchase} يوماً وفجوته المعتادة ${draft.cadence.typicalGapDays} يوماً.`
            : `غاب ${draft.daysSinceLastPurchase} يوماً وتاريخه لا يكفي لحساب نمط شراء، فطُبّق حد ${CONFIG.inactiveFallbackDays} يوماً.`);
        } else if (isChurnRisk) {
          reasons.push(`غاب ${draft.daysSinceLastPurchase} يوماً وهو أطول من فجوته المعتادة (${draft.cadence.typicalGapDays} يوماً).`);
        }
        if (isReactivated) reasons.push("عاد للشراء بعد انقطاع تجاوز نمطه المعتاد.");
      }
      if (draft.credit.creditStatus === "over_limit") {
        reasons.push(draft.credit.creditUsagePercent === null
          ? "عليه رصيد مدين وحده الآلي المحسوب صفر."
          : `الرصيد ${draft.credit.creditUsagePercent}% من حد الائتمان الآلي.`);
      }
      else if (draft.credit.creditStatus === "delinquent") reasons.push(...draft.credit.autoCredit.notes);
      else if (draft.credit.creditStatus === "inactive_no_limit") reasons.push(...draft.credit.autoCredit.notes);
      else if (draft.credit.creditStatus === "not_customer") reasons.push(...draft.credit.autoCredit.notes);
      else if (draft.credit.creditStatus === "needs_review") reasons.push(...draft.credit.autoCredit.notes);
      else if (draft.credit.creditStatus === "old_debt_collection") reasons.push(OLD_DEBT_NOTE(draft.credit.autoCredit.oldDebtCollection));
      else if (draft.credit.creditStatus === "near_limit") reasons.push(`الرصيد بلغ ${draft.credit.creditUsagePercent}% من حد الائتمان.`);
      else if (draft.credit.creditStatus === "unknown_limit") reasons.push("عليه رصيد مدين بلا حد ائتمان محدد.");
      else if (draft.credit.creditStatus === "awaiting_typed_source") reasons.push(UNTYPED_LEDGER_NOTE);
      else if (draft.credit.creditStatus === "missing_rate") reasons.push("حساب بعملة غير الدولار ولا يوجد سعر صرف لعملته في لقطة الفواتير: الرصيد بعملته، بلا حد آلي ولا نسبة استخدام ولا حكم تجاوز حتى يتوفر سعر.");
      else if (draft.credit.creditLimitSource === "ameen" && ["accounting_day_mismatch", "stale_invoices"].includes(draft.credit.creditStatus)) reasons.push("حد الأمين محفوظ بالدولار، ومعدّل تحويله لعملة الحساب من فواتير غير حديثة أو من يوم محاسبي آخر: لا نسبة استخدام ولا حكم تجاوز حتى تتحدّث الفواتير.");
      else if (draft.credit.creditStatus === "accounting_day_mismatch") reasons.push(ACCOUNTING_DAY_NOTE);
      else if (draft.credit.creditStatus === "stale_invoices") reasons.push("تقرير الفواتير غير حديث: حد الائتمان الآلي غير متاح، ولا نسبة استخدام ولا تجاوز ولا تعثّر ولا «غير نشط» من نافذة فواتير قديمة.");
      else if (draft.credit.creditStatus === "stale_balance") reasons.push("تقرير الأرصدة غير حديث: حد الائتمان غير متاح، ولا نسبة استخدام ولا حكم تجاوز من رصيد قديم.");
      else if (draft.credit.creditStatus === "unknown_balance") reasons.push("لا يوجد صف رصيد من الأمين لهذا الزبون، فلا يُعرض صفراً ولا يُحسب ضمن الذمم.");

      const out = {
        customerId: draft.record.customerId,
        customerGuid: draft.record.customerGuid,
        customerName: draft.record.customerName,
        customerKey: draft.record.nameKey,
        identityBasis: draft.record.identityBasis,

        currency: draft.currency,
        currencyMixed: draft.currencyMixed,
        truncated: draft.truncated,

        firstPurchaseAt: dayNumberToKey(draft.firstPurchaseDay),
        lastPurchaseAt: dayNumberToKey(draft.lastPurchaseDay),
        daysSinceLastPurchase: draft.daysSinceLastPurchase,

        netSales30d: draft.usableSales ? draft.current.netSales : null,
        sales30d: draft.usableSales ? draft.current.sales : null,
        returns30d: draft.usableSales ? draft.current.returns : null,
        invoiceCount30d: draft.usableSales ? draft.current.invoiceCount : null,
        averageInvoice30d: draft.usableSales ? draft.current.averageInvoice : null,

        netSalesPrevious30d: draft.usableSales ? draft.previous.netSales : null,
        salesPrevious30d: draft.usableSales ? draft.previous.sales : null,
        returnsPrevious30d: draft.usableSales ? draft.previous.returns : null,
        invoiceCountPrevious30d: draft.usableSales ? draft.previous.invoiceCount : null,

        netSales60d: draft.usableSales ? draft.combined.netSales : null,
        invoiceCount60d: draft.usableSales ? draft.combined.invoiceCount : null,

        purchaseTrend: { percent: trend.percent, state: trend.state },
        typicalGapDays: draft.cadence.typicalGapDays,
        cadenceTrusted: draft.cadence.cadenceTrusted,
        inactiveThresholdDays: inactiveThreshold,

        currentBalance: draft.credit.currentBalance,
        creditLimit: draft.credit.creditLimit,
        creditLimitSource: draft.credit.creditLimitSource,
        creditUsagePercent: draft.credit.creditUsagePercent,
        creditStatus: draft.credit.creditStatus,
        creditCurrency: draft.credit.creditCurrency,
        creditLimitDisplay: draft.credit.creditLimitDisplay,
        balanceDisplay: draft.credit.balanceDisplay,
        balanceCurrency: draft.credit.balanceCurrency,
        legacyCreditLimit: draft.credit.legacyCreditLimit,
        autoCredit: draft.credit.autoCredit,

        topItems: draft.items.items,
        topItemsIdentity: draft.items.identity,

        primarySegment,
        flags,
        vipRank: rankByRecord.get(draft.record.recordKey) ?? null,
        vipScore: composite ? composite.composite : null,

        activityScore,
        valueScore,
        riskScore,

        explanation: reasons,
        keyCustomer,
        isSupplier: draft.isSupplier
      };
      out.creditHistory = historyIndex ? creditHistoryView(out, historyIndex.get(out.customerGuid) || [], window.referenceDay) : null;
      return out;
    });

    // ترتيب افتراضي حتمي: الخطر ثم القيمة ثم المعرّف.
    customers.sort((a, b) => b.riskScore - a.riskScore
      || (b.netSales60d ?? -Infinity) - (a.netSales60d ?? -Infinity)
      || String(a.customerId).localeCompare(String(b.customerId)));

    const active = customers.filter((row) => !row.isSupplier);
    const countFlag = (flag) => active.filter((row) => row.flags.includes(flag)).length;

    const summary = {
      totalCustomers: active.length,
      withSalesInWindow: active.filter((row) => (row.invoiceCount60d ?? 0) > 0).length,
      activeCustomers: active.filter((row) => (row.invoiceCount30d ?? 0) > 0).length,
      vipCount: countFlag("vip"),
      decliningCount: countFlag("declining"),
      growingCount: countFlag("growing"),
      inactiveCount: countFlag("inactive"),
      reactivatedCount: countFlag("reactivated"),
      newCount: countFlag("new"),
      atRiskChurnCount: countFlag("at_risk_churn"),
      overCreditLimitCount: countFlag("over_credit_limit"),
      nearCreditLimitCount: countFlag("near_credit_limit"),
      unknownCreditLimitCount: countFlag("credit_limit_unknown"),
      unknownCreditBalanceCount: countFlag("credit_balance_unknown"),
      delinquentCreditCount: countFlag("credit_delinquent"),
      inactiveCreditCount: countFlag("credit_inactive"),
      lowDataCreditCount: countFlag("credit_low_data"),
      nonCustomerCreditCount: countFlag("credit_not_customer"),
      needsReviewCreditCount: countFlag("credit_needs_review"),
      mixedRoleCreditCount: countFlag("credit_mixed_role"),
      oldDebtCollectionCount: countFlag("old_debt_collection"),
      insufficientDataCount: active.filter((row) => row.primarySegment === "insufficient_data").length,
      ambiguousIdentityCount: countFlag("ambiguous_identity"),
      // تجميع المبيعات بعملة الأساس فقط — ممنوع إضافة مبالغ SYP إلى إجمالي USD.
      // الأرصدة (totalReceivables) دائماً بعملة الأساس (من الأمين المحاسبي).
      netSales30d: round(active.filter((row) => row.currency === CONFIG.baseCurrency).reduce((sum, row) => sum + (row.netSales30d ?? 0), 0), 3),
      netSalesPrevious30d: round(active.filter((row) => row.currency === CONFIG.baseCurrency).reduce((sum, row) => sum + (row.netSalesPrevious30d ?? 0), 0), 3),
      totalReceivables: round(active.reduce((sum, row) => {
        const balance = row.currentBalance;
        if (!Number.isFinite(balance)) return sum;
        return sum + Math.max(0, balance);
      }, 0), 3),
      currency: CONFIG.baseCurrency
    };
    summary.netSalesTrendPercent = summary.netSalesPrevious30d > 0
      ? round(((summary.netSales30d - summary.netSalesPrevious30d) / summary.netSalesPrevious30d) * 100, 2)
      : null;

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now.toISOString(),
      accountingSourceOfTruth: "Ameen (read-only)",
      config: CONFIG,
      window,
      dataAvailability: {
        invoicesAvailable,
        balancesAvailable: balanceItems.length > 0,
        movementsAvailable: Array.isArray(movementsReport?.items) && movementsReport.items.length > 0,
        autoCreditEnabled: ledger.byGuid.size > 0 && ledger.lineKindsTrusted,
        accountClassesTrusted,
        accountingDayAligned,
        accountingDays: Object.fromEntries(Object.entries(accountingDays).map(([key, day]) => [key, day === null ? null : dayNumberToKey(day)])),
        creditCycle: cycleStats,
        previousWindowCovered: window.previousWindowCovered,
        coverageDays: window.coverageDays,
        vipRankingReliable,
        vipPopulation,
        declineFloor,
        unresolvedAmbiguousInvoiceRows: unresolvedByAmbiguity.length
      },
      sourcesFreshness,
      staleData,
      summary,
      customers
    };
  }

  // --------------------------------------------------------------------------
  // مخرج ثابت الشكل للاستهلاك الآلي (Cowork/بوت/تنبيهات لاحقاً).
  // غير مربوط بأي مستهلك الآن — قراءة فقط، بلا آثار جانبية.
  // --------------------------------------------------------------------------
  function shortRow(row) {
    return {
      customerId: row.customerId,
      customerGuid: row.customerGuid,
      customerName: row.customerName,
      primarySegment: row.primarySegment,
      flags: row.flags,
      netSales30d: row.netSales30d,
      netSalesPrevious30d: row.netSalesPrevious30d,
      trendPercent: row.purchaseTrend.percent,
      trendState: row.purchaseTrend.state,
      lastPurchaseAt: row.lastPurchaseAt,
      daysSinceLastPurchase: row.daysSinceLastPurchase,
      currentBalance: row.currentBalance,
      creditLimit: row.creditLimit,
      creditUsagePercent: row.creditUsagePercent,
      creditStatus: row.creditStatus,
      riskScore: row.riskScore,
      explanation: row.explanation
    };
  }

  function buildCoworkPayload(result) {
    if (!result) return null;
    const active = result.customers.filter((row) => !row.isSupplier);
    const has = (row, flag) => row.flags.includes(flag);

    const vipDeclining = active.filter((row) => has(row, "vip") && (has(row, "declining") || has(row, "inactive") || has(row, "at_risk_churn")));
    const inactiveCustomers = active.filter((row) => has(row, "inactive"));
    const debtRisks = active.filter((row) => has(row, "over_credit_limit") || has(row, "near_credit_limit"));
    const reactivatedCustomers = active.filter((row) => has(row, "reactivated"));
    const declining = active.filter((row) => has(row, "declining"));

    const attentionKeys = new Set();
    const customersNeedingAttention = [...vipDeclining, ...debtRisks, ...declining, ...inactiveCustomers]
      .filter((row) => {
        if (attentionKeys.has(row.customerId)) return false;
        attentionKeys.add(row.customerId);
        return true;
      })
      .sort((a, b) => b.riskScore - a.riskScore || String(a.customerId).localeCompare(String(b.customerId)))
      .map(shortRow);

    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: result.generatedAt,
      accountingSourceOfTruth: result.accountingSourceOfTruth,
      window: {
        referenceDate: result.window.referenceDate,
        currentFrom: result.window.currentStartDate,
        previousFrom: result.window.previousStartDate,
        previousTo: result.window.previousEndDate,
        periodDays: result.window.periodDays,
        coverageDays: result.window.coverageDays,
        previousWindowCovered: result.window.previousWindowCovered
      },
      sourcesFreshness: result.sourcesFreshness,
      staleData: result.staleData,
      summary: result.summary,
      customersNeedingAttention,
      vipDeclining: vipDeclining.map(shortRow),
      inactiveCustomers: inactiveCustomers.map(shortRow),
      debtRisks: debtRisks.map(shortRow),
      reactivatedCustomers: reactivatedCustomers.map(shortRow)
    };
  }

  // --------------------------------------------------------------------------
  // تنبيه غياب الزبون المهم (CUSTOMER_INACTIVE_5D) — خطة يومية حتمية يرسلها الخادم.
  // alertedRows: صفوف customer_inactivity_alerts (من نُبِّه عنه لغيابه الحالي).
  // المخرج: الرسائل الجديدة، وصفوف الحالة للإضافة، ومفاتيح الحالة للحذف (من عاد واشترى أو
  // لم يعد مهماً). لا يرسل ولا يكتب شيئاً بنفسه.
  // --------------------------------------------------------------------------
  const ddmmyyyy = (key) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    return match ? `${match[3]}-${match[2]}-${match[1]}` : "—";
  };
  // بصمة قصيرة حتمية (FNV-1a 32bit) لمفتاح منع التكرار — ليست أماناً.
  const fingerprint = (value) => {
    let hash = 0x811c9dc5;
    for (const char of String(value)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const inactivityAlertKey = (row) => `CUSTOMER_INACTIVE_5D:${row.customerGuid || row.customerKey}:${row.lastPurchaseAt}`;

  function buildInactivityAlert(result, alertedRows = []) {
    const K = CONFIG.keyCustomerAlert;
    const code = "CUSTOMER_INACTIVE_5D";
    if (!result) return { status: "no_result", code, messages: [], absent: [], insertRows: [], deleteKeys: [] };
    const checkDay = dayKey(result.generatedAt);
    const invoices = result.sourcesFreshness?.invoices;
    // تقرير فواتير قديم أو غائب: لا تنبيه غياب من نافذة قديمة (قد يكون الزبون اشترى بعدها).
    // بلاغ «البيانات قديمة» مرة واحدة باليوم، والحالة لا تُمسّ.
    if (!result.dataAvailability?.invoicesAvailable || !invoices || invoices.stale) {
      const age = invoices?.ageMinutes;
      return {
        status: "stale_invoices",
        code,
        absent: [],
        insertRows: [],
        deleteKeys: [],
        messages: [{
          text: `⚠️ فحص غياب الزبائن المهمين لم يُنفَّذ اليوم: تقرير الفواتير ${age === null || age === undefined ? "غير متاح" : `عمره ${age} دقيقة`} (الحد ${CONFIG.freshnessMinutes.invoices} دقيقة). لا تنبيهات حتى تتحدّث المزامنة.`,
          dedupeKey: `${code}:stale:${checkDay}`
        }]
      };
    }

    const absent = result.customers
      .filter((row) => row.keyCustomer?.absent && !row.isSupplier && row.lastPurchaseAt)
      .sort((a, b) => (a.keyCustomer.valueRank ?? Infinity) - (b.keyCustomer.valueRank ?? Infinity)
        || (b.netSales60d ?? 0) - (a.netSales60d ?? 0)
        || String(a.customerId).localeCompare(String(b.customerId)))
      .map((row) => ({
        dedupeKey: inactivityAlertKey(row),
        customerGuid: row.customerGuid || null,
        customerKey: row.customerKey,
        customerName: row.customerName,
        lastPurchaseAt: row.lastPurchaseAt,
        daysSinceLastPurchase: row.daysSinceLastPurchase,
        typicalGapDays: row.cadenceTrusted ? row.typicalGapDays : null,
        monthlyPurchases: row.keyCustomer.monthlyPurchases,
        currency: row.currency,
        byValue: row.keyCustomer.byValue,
        byRegularity: row.keyCustomer.byRegularity
      }));

    const alertedKeys = new Set(alertedRows.map((row) => text(row?.dedupe_key ?? row?.dedupeKey)).filter(Boolean));
    const fresh = absent.filter((entry) => !alertedKeys.has(entry.dedupeKey));
    // تنظيف الحالة: يُحذف صف من عاد واشترى (آخر فاتورة بيع له تغيّرت)، وصف خرج غيابه من نافذة
    // الستين يوماً (لا يعود «مهماً» قبل شراء جديد، فلا خطر تكرار). من بقي غائباً يبقى صفّه
    // حتى لو خرج مؤقتاً من «المهمين»، كي لا يُنبَّه عنه مرة ثانية للغياب نفسه.
    const lastPurchaseByGuid = new Map();
    const lastPurchaseByKey = new Map();
    for (const row of result.customers) {
      if (row.customerGuid) lastPurchaseByGuid.set(normalizeGuid(row.customerGuid), row.lastPurchaseAt);
      else if (row.customerKey) lastPurchaseByKey.set(row.customerKey, row.lastPurchaseAt);
    }
    const deleteKeys = alertedRows
      .filter((row) => {
        const key = text(row?.dedupe_key ?? row?.dedupeKey);
        const stored = text(row?.last_purchase_date ?? row?.lastPurchaseAt);
        if (!key || !stored) return Boolean(key);
        const guid = normalizeGuid(row?.customer_guid ?? row?.customerGuid);
        const latest = guid ? lastPurchaseByGuid.get(guid) : lastPurchaseByKey.get(text(row?.customer_key ?? row?.customerKey));
        if (latest && latest !== stored) return true;
        return stored < result.window.previousStartDate;
      })
      .map((row) => text(row?.dedupe_key ?? row?.dedupeKey))
      .sort();

    const messages = [];
    for (let start = 0; start < fresh.length; start += K.customersPerMessage) {
      const chunk = fresh.slice(start, start + K.customersPerMessage);
      const part = fresh.length > K.customersPerMessage ? ` (${start / K.customersPerMessage + 1}/${Math.ceil(fresh.length / K.customersPerMessage)})` : "";
      const lines = chunk.map((entry, index) => {
        const gap = entry.typicalGapDays === null ? "غير محسوبة" : `${entry.typicalGapDays} يوماً`;
        return `${start + index + 1}. ${entry.customerName} — ${entry.daysSinceLastPurchase} يوماً بلا فاتورة (آخر فاتورة ${ddmmyyyy(entry.lastPurchaseAt)}) — فجوته المعتادة ${gap} — مشترياته الشهرية ${formatAmount(entry.monthlyPurchases, entry.currency || CONFIG.baseCurrency)}`;
      });
      messages.push({
        text: `🔕 زبائن مهمون بلا شراء منذ ${K.inactiveDays} أيام أو أكثر${part}\n${lines.join("\n")}`,
        // مفتاح الرسالة من محتواها (يوم المرجع + بصمة الزبائن): إعادة التشغيل بنفس القائمة لا
        // تكرّرها، وقائمة مختلفة في اليوم نفسه لا تُبتلَع بمفتاح رسالة سابقة.
        dedupeKey: `${code}:${result.window.referenceDate}:${fingerprint(chunk.map((entry) => entry.dedupeKey).join("|"))}`,
        customerKeys: chunk.map((entry) => entry.dedupeKey)
      });
    }
    return {
      status: "ok",
      code,
      referenceDate: result.window.referenceDate,
      absent,
      messages,
      insertRows: fresh.map((entry) => ({
        dedupe_key: entry.dedupeKey,
        customer_guid: entry.customerGuid,
        customer_key: entry.customerKey,
        last_purchase_date: entry.lastPurchaseAt
      })),
      deleteKeys
    };
  }

  // تنبيهات جاهزة للتوصيل لاحقاً بالبنية القائمة (telegram_outbox / web_push).
  // تُرجع أوصافاً فقط مع `dedupeKey` و`cooldownMinutes` — لا ترسل شيئاً بنفسها،
  // ولا تُستدعى من أي مسار إرسال حالياً (منعاً لأي spam أثناء التطوير).
  function buildAlertDrafts(result) {
    if (!result) return [];
    const active = result.customers.filter((row) => !row.isSupplier);
    const has = (row, flag) => row.flags.includes(flag);
    const day = String(result.window.referenceDate || "");
    const drafts = [];

    const vipDeclining = active.filter((row) => has(row, "vip") && has(row, "declining"));
    if (vipDeclining.length) {
      drafts.push({
        code: "VIP_DECLINING",
        severity: "high",
        count: vipDeclining.length,
        message: `${vipDeclining.length} زبون VIP تراجعت مشترياتهم مقارنة بالفترة السابقة.`,
        dedupeKey: `customer-intel:vip-declining:${day}`,
        cooldownMinutes: 720,
        customers: vipDeclining.map((row) => row.customerId)
      });
    }

    for (const row of active.filter((entry) => has(entry, "vip") && has(entry, "inactive"))) {
      drafts.push({
        code: "VIP_INACTIVE",
        severity: "high",
        count: 1,
        message: `زبون VIP (${row.customerName}) لم يشترِ منذ ${row.daysSinceLastPurchase} يوماً، وهي مدة أطول من نمطه المعتاد.`,
        dedupeKey: `customer-intel:vip-inactive:${row.customerId}:${day}`,
        cooldownMinutes: 1440,
        customers: [row.customerId]
      });
    }

    for (const row of active.filter((entry) => entry.creditStatus === "over_limit" || entry.creditStatus === "near_limit")) {
      drafts.push({
        code: row.creditStatus === "over_limit" ? "CREDIT_OVER_LIMIT" : "CREDIT_NEAR_LIMIT",
        severity: row.creditStatus === "over_limit" ? "critical" : "high",
        count: 1,
        message: `${row.customerName} وصل إلى ${row.creditUsagePercent}% من حد الائتمان.`,
        dedupeKey: `customer-intel:credit:${row.creditStatus}:${row.customerId}:${day}`,
        cooldownMinutes: 360,
        customers: [row.customerId]
      });
    }

    for (const row of active.filter((entry) => has(entry, "reactivated"))) {
      drafts.push({
        code: "CUSTOMER_REACTIVATED",
        severity: "info",
        count: 1,
        message: `${row.customerName} عاد للشراء بعد انقطاع تجاوز نمطه المعتاد.`,
        dedupeKey: `customer-intel:reactivated:${row.customerId}:${day}`,
        cooldownMinutes: 1440,
        customers: [row.customerId]
      });
    }

    return drafts;
  }

  const api = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    CONFIG,
    build,
    buildCoworkPayload,
    buildAlertDrafts,
    buildCreditSnapshots,
    buildInactivityAlert,
    normalizeName,
    commercialRound
  });

  if (typeof window !== "undefined") window.ozkCustomerIntelligence = api;
  if (typeof globalThis !== "undefined" && typeof window === "undefined") globalThis.ozkCustomerIntelligence = api;
})();
