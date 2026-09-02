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

  function freshnessOf(asOf, maxAgeMinutes, now) {
    if (!asOf) return { asOf: null, ageMinutes: null, maxAgeMinutes, state: "unknown", stale: true };
    const ageMinutes = Math.max(0, Math.round((now.getTime() - new Date(asOf).getTime()) / 60000));
    const stale = ageMinutes > maxAgeMinutes;
    return { asOf, ageMinutes, maxAgeMinutes, state: stale ? "stale" : "fresh", stale };
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

    for (const group of items) {
      const groupName = text(group?.name);
      const groupGuid = normalizeGuid(group?.customerGuid ?? group?.customer_guid);
      const invoices = Array.isArray(group?.invoices) ? group.invoices : [];

      for (const invoice of invoices) {
        const day = dayNumber(invoice?.date);
        if (day === null) continue;

        const isReturn = invoice?.isReturn === true;
        const sign = isReturn ? -1 : 1;
        const total = numberOrZero(invoice?.total);
        const discount = numberOrZero(invoice?.discount);
        const gross = total - discount;
        // معرّف الزبون على مستوى الفاتورة إن وفّرته المزامنة، وإلا معرّف المجموعة.
        const guid = normalizeGuid(invoice?.customerGuid ?? invoice?.customer_guid) || groupGuid;
        const currency = text(invoice?.currency).toUpperCase() || null;

        const lines = (Array.isArray(invoice?.lines) ? invoice.lines : []).map((line) => ({
          itemGuid: normalizeGuid(line?.itemGuid ?? line?.item_guid),
          material: text(line?.material),
          qty: numberOrZero(line?.qty),
          qtyUnits: numberOrNull(line?.qtyUnits),
          lineTotal: numberOrZero(line?.lineTotal)
        }));

        rows.push({
          customerName: groupName,
          customerGuid: guid,
          nameKey: normalizeName(groupName),
          day,
          date: dayNumberToKey(day),
          isReturn,
          sign,
          currency,
          netValue: round(sign * gross, 3),
          grossValue: round(gross, 3),
          firstPay: numberOrZero(invoice?.payment),
          number: text(invoice?.number),
          guid: text(invoice?.guid),
          lines
        });
      }
    }

    return rows;
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
    const referenceDay = dayNumber(referenceIso) ?? maxInvoiceDay ?? dayNumber(now.toISOString());

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
  // الائتمان: نفس ترتيب business-snapshot.js — معتمد داخلياً ثم حد الأمين ثم
  // «غير محدد». غياب الحد **ليس** صفراً ولا يُنتج تجاوزاً.
  // --------------------------------------------------------------------------
  function resolveCredit(balanceRow, approvedLimit) {
    const balance = numberOrZero(balanceRow?.balance);
    const ameenLimitRaw = numberOrNull(balanceRow?.creditLimit ?? balanceRow?.credit_limit);
    const ameenLimit = ameenLimitRaw !== null && ameenLimitRaw > 0 ? ameenLimitRaw : null;
    const approved = approvedLimit !== null && approvedLimit > 0 ? approvedLimit : null;

    const creditLimit = approved ?? ameenLimit;
    const creditLimitSource = approved !== null ? "approved" : ameenLimit !== null ? "ameen" : "missing";
    const exposure = Math.max(0, balance);
    const usagePercent = creditLimit !== null ? round((exposure / creditLimit) * 100, 2) : null;
    const ratio = creditLimit !== null ? exposure / creditLimit : null;

    let creditStatus = "normal";
    if (ratio !== null && ratio >= 1) creditStatus = "over_limit";
    else if (ratio !== null && ratio >= CONFIG.nearLimitRatio) creditStatus = "near_limit";
    else if (ratio === null && exposure > 0) creditStatus = "unknown_limit";

    return {
      currentBalance: round(balance, 3),
      creditLimit: creditLimit === null ? null : round(creditLimit, 3),
      creditLimitSource,
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
        if (!totals.has(key)) {
          totals.set(key, {
            itemGuid: line.itemGuid || null,
            itemName: line.material,
            netQty: 0,
            netQtyUnits: 0,
            netValue: 0,
            lineCount: 0
          });
        }
        const entry = totals.get(key);
        entry.netQty += row.sign * line.qty;
        entry.netQtyUnits += row.sign * (line.qtyUnits ?? 0);
        entry.netValue += row.sign * line.lineTotal;
        entry.lineCount += 1;
        if (!entry.itemName && line.material) entry.itemName = line.material;
      }
    }

    const items = [...totals.values()]
      .map((entry) => ({
        itemGuid: entry.itemGuid,
        itemName: entry.itemName,
        netQty: round(entry.netQty, 3),
        netQtyUnits: round(entry.netQtyUnits, 3),
        netValue: round(entry.netValue, 3),
        lineCount: entry.lineCount
      }))
      // ترتيب حتمي: القيمة تنازلياً ثم الاسم، فلا يتبدّل الناتج عند التعادل.
      .sort((a, b) => b.netValue - a.netValue || a.itemName.localeCompare(b.itemName, "ar"))
      .slice(0, CONFIG.topItemsLimit);

    return {
      items,
      identity: keyedByGuid > 0 && keyedByName === 0 ? "item_guid" : keyedByGuid > 0 ? "mixed" : "item_name"
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
  function build(input = {}) {
    const now = input.now instanceof Date ? new Date(input.now.getTime()) : new Date(input.now || Date.now());
    const invoicesReport = input.invoicesReport || null;
    const balancesReport = input.balancesReport || null;
    const movementsReport = input.movementsReport || null;
    const creditLimits = Array.isArray(input.creditLimits) ? input.creditLimits : [];

    const balanceItems = Array.isArray(balancesReport?.items) ? balancesReport.items : [];
    const invoiceRows = flattenInvoices(invoicesReport);
    const identity = buildIdentityIndex(balanceItems);
    const window = resolveWindow(invoicesReport, invoiceRows, now);

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
    const staleData = sourcesFreshness.invoices.stale || sourcesFreshness.balances.stale;
    const invoicesAvailable = Boolean(invoicesReport) && invoiceRows.length > 0;

    // ── حدود الائتمان المعتمدة داخلياً ────────────────────────────────────────
    const approvedLimitByKey = new Map();
    for (const limit of creditLimits) {
      const key = text(limit?.customerKey ?? limit?.customer_key)
        || normalizeName(limit?.customerName ?? limit?.customer_name);
      if (!key) continue;
      const value = numberOrNull(limit?.creditLimit ?? limit?.credit_limit);
      if (value === null) continue;
      if (!approvedLimitByKey.has(key)) approvedLimitByKey.set(key, value);
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
      const currencies = new Set(rows.map((row) => row.currency).filter(Boolean));
      // ممنوع جمع عملات مختلفة. غياب العملة يعني عملة الأساس (USD) الموثّقة.
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
      const credit = resolveCredit(record.balanceRow, approvedLimitByKey.get(record.nameKey) ?? null);
      const items = topItems(windowRows);

      const ambiguousIdentity = ambiguousUnresolvedNames.has(record.nameKey);
      const usableSales = invoicesAvailable && !currencyMixed && !ambiguousIdentity;

      drafts.push({
        record,
        currency,
        currencyMixed,
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
        isSupplier: record.balanceRow?.isSupplier === true
      });
    }

    // ── الأرضية النسبية للتراجع: ربع وسيط مبيعات الفترة السابقة ──────────────
    const positivePrevious = drafts
      .filter((draft) => draft.usableSales && draft.previous.netSales > 0)
      .map((draft) => draft.previous.netSales);
    const medianPrevious = median(positivePrevious) ?? 0;
    const declineFloor = Math.max(1, round(medianPrevious * CONFIG.declineMinPreviousShareOfMedian, 3));

    // ── ترتيب VIP النسبي ─────────────────────────────────────────────────────
    // المرشحون: من لديه صافي مبيعات موجب في النافذة (60 يوماً) وعدد فواتير كافٍ.
    const vipCandidates = drafts.filter(
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

    // ترتيب حتمي عند التعادل: الدرجة ثم صافي المبيعات ثم مفتاح السجل.
    const ranked = vipCandidates.slice().sort((a, b) => {
      const scoreA = compositeByRecord.get(a.record.recordKey).composite;
      const scoreB = compositeByRecord.get(b.record.recordKey).composite;
      return scoreB - scoreA
        || b.combined.netSales - a.combined.netSales
        || a.record.recordKey.localeCompare(b.record.recordKey);
    });
    const vipCutoff = vipRankingReliable ? Math.max(1, Math.ceil(CONFIG.vipTopShare * vipPopulation)) : 0;
    const vipKeys = new Set(ranked.slice(0, vipCutoff).map((draft) => draft.record.recordKey));
    const rankByRecord = new Map(ranked.map((draft, index) => [draft.record.recordKey, index + 1]));

    // ── التصنيف النهائي ──────────────────────────────────────────────────────
    const customers = drafts.map((draft) => {
      const composite = compositeByRecord.get(draft.record.recordKey) || null;
      const flags = [];
      const reasons = [];

      if (draft.ambiguousIdentity) flags.push("ambiguous_identity");
      if (draft.currencyMixed) flags.push("mixed_currency");
      if (staleData) flags.push("stale_data");
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
        && draft.previous.netSales >= declineFloor;
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
      if (!vipRankingReliable && draft.usableSales && draft.combined.netSales > 0) flags.push("vip_ranking_unreliable");
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
      else if (draft.credit.creditStatus === "over_limit" || draft.credit.creditStatus === "near_limit") primarySegment = "at_risk_debt";
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
      if (draft.credit.creditStatus === "over_limit") creditRisk = 100;
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
      if (draft.credit.creditStatus === "over_limit") reasons.push(`الرصيد ${draft.credit.creditUsagePercent}% من حد الائتمان المعتمد.`);
      else if (draft.credit.creditStatus === "near_limit") reasons.push(`الرصيد بلغ ${draft.credit.creditUsagePercent}% من حد الائتمان.`);
      else if (draft.credit.creditStatus === "unknown_limit") reasons.push("عليه رصيد مدين بلا حد ائتمان محدد.");

      return {
        customerId: draft.record.customerId,
        customerGuid: draft.record.customerGuid,
        customerName: draft.record.customerName,
        customerKey: draft.record.nameKey,
        identityBasis: draft.record.identityBasis,

        currency: draft.currency,
        currencyMixed: draft.currencyMixed,

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
        isSupplier: draft.isSupplier
      };
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
      insufficientDataCount: active.filter((row) => row.primarySegment === "insufficient_data").length,
      ambiguousIdentityCount: countFlag("ambiguous_identity"),
      netSales30d: round(active.reduce((sum, row) => sum + (row.netSales30d ?? 0), 0), 3),
      netSalesPrevious30d: round(active.reduce((sum, row) => sum + (row.netSalesPrevious30d ?? 0), 0), 3),
      totalReceivables: round(active.reduce((sum, row) => sum + Math.max(0, row.currentBalance), 0), 3),
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
    normalizeName
  });

  if (typeof window !== "undefined") window.ozkCustomerIntelligence = api;
  if (typeof globalThis !== "undefined" && typeof window === "undefined") globalThis.ozkCustomerIntelligence = api;
})();
