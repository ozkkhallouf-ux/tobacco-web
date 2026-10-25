// ============================================================================
// تدقيق أسعار النشرة مقابل التكلفة — منطق نقي (Pure) بلا شبكة ولا DOM ولا كتابة.
//
// يغذّي ستارتين في «مركز نشرة الأسعار»:
//   • «مواد تحت سعر التكلفة»  — سعر بيع صالح أقل من تكلفة الوحدة الثانية نفسها
//   • «مواد غير مسعّرة»       — صنف في نطاق النشرة بلا سعر جملة أو مفرق صالح
//
// لا يغيّر أي سعر ولا أي تكلفة، ولا يقترح تعديلاً تلقائياً. الحكم للعرض فقط.
//
// تعريف التكلفة (كما هو في الموقع منذ قبل هذه الأداة، لا يُعاد تعريفه هنا):
//   item_costs.avg_cost = متوسط التكلفة AvgPrice من vwMaterials في الأمين
//   (tools/push-item-costs.ps1، قراءة فقط) — بعملة الأساس الدولار ولكل وحدة أولى
//   (كروز/علبة). تكلفة الوحدة الثانية = avg_cost × unit2Factor، وهو نفس حساب
//   بطاقة التسعير (pricingRow) في src/app.js.
//
// سعر البيع:
//   الجملة = approved_price_items.unit2_price (دولار للوحدة الثانية)
//   المفرق = approved_price_items.price_payload.retail.price (دولار للوحدة الثانية؛
//            نشرة السوري تضربه بسعر الصرف، فالمقارنة بالدولار قبل التحويل)
//
// قاعدة الأمان: لا حكم «تحت التكلفة» إلا بإثبات قابلية المقارنة. أي نقص أو شك
// يضع الصنف في «تعذّر الحكم» مع السبب، ولا يُعدّ رابحاً ولا خاسراً. وفشل تحميل
// مصدر لا يجعل الأصناف «غير مسعّرة» — تتوقف الستارة كلها وتقول السبب.
//
// التوثيق: docs/ai/topics/price-bulletins.md
// ============================================================================
(function () {
  "use strict";

  const VERSION = 1;

  const THRESHOLDS = Object.freeze({
    // التكلفة الإجمالية أقدم من هذا ⇒ لا أحكام إطلاقاً (مهمة رفع التكلفة كل 15 دقيقة).
    costFeedMaxAgeHours: 24,
    // صف تكلفة لم يُحدَّث مع آخر رفع بهذه المدة ⇒ الصنف غاب عن vwMaterials أو انقطع.
    costRowLagHours: 24,
    // نسبة سعر/تكلفة خارج هذا المدى تُرجّح اختلاف الوحدة لا ربحاً أو خسارة حقيقية.
    plausibleRatioMin: 1 / 3,
    plausibleRatioMax: 3,
    // avg_cost مقرَّب لثلاث منازل، والسعر لمنزلتين.
    costDecimals: 3,
    priceEpsilon: 0.005
  });

  const PRICE_TYPES = Object.freeze({ wholesale: "wholesale", retail: "retail" });
  const PRICE_TYPE_LABELS = Object.freeze({ wholesale: "جملة", retail: "مفرق" });
  const PRICE_STATES = Object.freeze({ valid: "valid", missing: "missing", zero: "zero", invalid: "invalid" });
  const PRICE_STATE_LABELS = Object.freeze({
    valid: "مسعّر",
    missing: "سعر مفقود",
    zero: "سعر صفري",
    invalid: "سعر غير صالح"
  });
  const BULLETIN_LABELS = Object.freeze({ general: "النشرة العامة", wazari: "الوزاري" });

  const REASONS = Object.freeze({
    cost_missing: "لا توجد تكلفة مسجّلة لهذه المادة",
    cost_zero: "التكلفة صفر في الأمين",
    cost_invalid: "تكلفة غير صالحة",
    cost_currency: "عملة التكلفة ليست الدولار",
    cost_row_stale: "تكلفة المادة لم تُحدَّث مع آخر رفع",
    no_guid: "لا معرّف أمين للمادة — لا مطابقة بالاسم",
    factor_invalid: "عامل الوحدة الثانية غير صالح",
    factor_mismatch: "عامل الوحدة في السعر المحفوظ يخالف الأمين",
    ratio_implausible: "فرق غير منطقي بين السعر والتكلفة — يُرجَّح اختلاف الوحدة"
  });

  function toNumberOrNaN(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return NaN;
      return Number(text);
    }
    return NaN;
  }

  // missing: لا قيمة إطلاقاً · zero: صفر صريح · invalid: غير رقمي أو سالب · valid: موجب منتهٍ
  function classifyPrice(raw) {
    if (raw === undefined || raw === null || raw === "") return { state: PRICE_STATES.missing, value: null };
    const n = toNumberOrNaN(raw);
    if (!Number.isFinite(n) || n < 0) return { state: PRICE_STATES.invalid, value: null };
    if (n === 0) return { state: PRICE_STATES.zero, value: 0 };
    return { state: PRICE_STATES.valid, value: n };
  }

  function positiveFactor(raw) {
    const n = toNumberOrNaN(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function timeMs(value) {
    if (!value) return NaN;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // سعر الجملة كما تقرؤه النشرة (itemUnit2Price): unit2_price أولاً، وإلا سعر
  // الوحدة الأولى القديم × العامل. الحالة تؤخذ من unit2_price حين لا بديل صالح.
  function wholesalePrice(approved, factor) {
    if (!approved) return { state: PRICE_STATES.missing, value: null, source: "" };
    const primary = classifyPrice(approved.unit2Price);
    if (primary.state === PRICE_STATES.valid) return { ...primary, source: "unit2_price" };
    const legacy = classifyPrice(approved.unit1Price);
    if (legacy.state === PRICE_STATES.valid && factor) {
      return { state: PRICE_STATES.valid, value: round2(legacy.value * factor), source: "unit1_price" };
    }
    return { ...primary, source: "" };
  }

  function retailPrice(approved) {
    if (!approved) return { state: PRICE_STATES.missing, value: null, source: "" };
    return { ...classifyPrice(approved.retailPrice), source: "price_payload.retail.price" };
  }

  function indexCosts(rows) {
    const byGuid = new Map();
    let newestMs = NaN;
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row) return;
      const guid = String(row.item_guid || "").trim().toUpperCase();
      if (guid && !byGuid.has(guid)) byGuid.set(guid, row);
      const ms = timeMs(row.updated_at);
      if (Number.isFinite(ms) && (!Number.isFinite(newestMs) || ms > newestMs)) newestMs = ms;
    });
    return { byGuid, newestMs };
  }

  function isUsd(currency) {
    const text = String(currency == null ? "" : currency).trim().toUpperCase();
    return text === "" || text === "$" || text === "USD";
  }

  // تكلفة الوحدة الثانية أو سبب تعذّرها — مستقلة عن نوع السعر.
  function resolveCost(item, costIndex) {
    const guid = String(item.itemGuid || "").trim().toUpperCase();
    if (!guid) return { ok: false, reason: "no_guid" };
    const row = costIndex.byGuid.get(guid);
    if (!row) return { ok: false, reason: "cost_missing" };
    const unitCost = toNumberOrNaN(row.avg_cost);
    const updatedAt = row.updated_at || "";
    if (!Number.isFinite(unitCost) || unitCost < 0) return { ok: false, reason: "cost_invalid", updatedAt };
    if (unitCost === 0) return { ok: false, reason: "cost_zero", updatedAt };
    if (!isUsd(row.currency)) return { ok: false, reason: "cost_currency", updatedAt };
    const rowMs = timeMs(updatedAt);
    if (!Number.isFinite(rowMs) || costIndex.newestMs - rowMs > THRESHOLDS.costRowLagHours * 3600000) {
      return { ok: false, reason: "cost_row_stale", updatedAt };
    }
    const factor = positiveFactor(item.unit2Factor);
    if (!factor) return { ok: false, reason: "factor_invalid", updatedAt };
    const approvedFactor = item.approved ? positiveFactor(item.approved.unit2Factor) : null;
    if (item.approved && item.approved.unit2Factor != null && item.approved.unit2Factor !== "" && approvedFactor !== factor) {
      return { ok: false, reason: "factor_mismatch", updatedAt };
    }
    const tolerance = 0.5 * Math.pow(10, -THRESHOLDS.costDecimals) * factor + THRESHOLDS.priceEpsilon;
    return { ok: true, unitCost, factor, cartonCost: unitCost * factor, tolerance, updatedAt };
  }

  function baseRow(item) {
    return {
      key: String(item.key || ""),
      name: String(item.name || ""),
      code: String(item.code || ""),
      groupName: String(item.groupName || ""),
      bulletin: item.bulletin === "wazari" ? "wazari" : "general",
      bulletinLabel: BULLETIN_LABELS[item.bulletin === "wazari" ? "wazari" : "general"],
      unit1Name: String(item.unit1Name || ""),
      unit2Name: String(item.unit2Name || ""),
      unit2Factor: positiveFactor(item.unit2Factor),
      stockQty: Number(item.stockQty) || 0
    };
  }

  // يظهر الصنف في نشرة الجملة بشرط وحدة ثانية كاملة؛ نشرة المفرق تقبل أي مخزون موجب.
  function inBulletin(item, type) {
    return type === PRICE_TYPES.wholesale ? Boolean(item.fullUnit2) : Number(item.stockQty) > 0;
  }

  function sourceStatus(input) {
    if (!input.stock || !input.stock.available) return { ok: false, reason: "لا يوجد تقرير مخزون حديث من الأمين — لا يمكن تحديد نطاق النشرة" };
    const prices = input.prices || {};
    if (prices.status !== "ok") {
      return {
        ok: false,
        reason: prices.status === "unauthenticated"
          ? "سجّل الدخول لقراءة الأسعار المعتمدة"
          : `تعذّر تحميل الأسعار المعتمدة${prices.error ? ` (${prices.error})` : ""} — لا تُصنَّف أي مادة`
      };
    }
    return { ok: true, reason: "" };
  }

  function costStatus(input, costIndex, now) {
    const costs = input.costs || {};
    if (costs.status === "not_owner") return { ok: false, reason: "التكلفة تظهر للمدير فقط" };
    if (costs.status !== "ok") {
      return { ok: false, reason: `تعذّر تحميل التكاليف${costs.error ? ` (${costs.error})` : ""} — لا أحكام دون تكلفة` };
    }
    if (!costIndex.byGuid.size) return { ok: false, reason: "لا توجد بيانات تكلفة مرفوعة من الأمين" };
    if (!Number.isFinite(costIndex.newestMs)) return { ok: false, reason: "تاريخ رفع التكلفة غير معروف" };
    const ageHours = (now - costIndex.newestMs) / 3600000;
    if (ageHours > THRESHOLDS.costFeedMaxAgeHours) {
      return { ok: false, reason: `بيانات التكلفة قديمة (آخر رفع قبل ${Math.floor(ageHours)} ساعة) — الأحكام معلّقة حتى تُحدَّث` };
    }
    if (ageHours < -0.25) return { ok: false, reason: "تاريخ رفع التكلفة في المستقبل — ساعة غير موثوقة" };
    return { ok: true, reason: "" };
  }

  function auditPriceCost(input) {
    const source = input || {};
    const nowMs = Number.isFinite(timeMs(source.now)) ? timeMs(source.now) : Date.now();
    const items = Array.isArray(source.items) ? source.items.filter((item) => item && Number(item.stockQty) > 0) : [];
    const costIndex = indexCosts(source.costs && source.costs.rows);
    const scope = sourceStatus(source);
    const costs = scope.ok ? costStatus(source, costIndex, nowMs) : { ok: false, reason: scope.reason };
    const costsUpdatedAt = Number.isFinite(costIndex.newestMs) ? new Date(costIndex.newestMs).toISOString() : "";
    const stockSyncedAt = (source.stock && source.stock.syncedAt) || "";

    const below = [];
    const unverifiable = [];
    const unpriced = [];

    if (scope.ok) {
      items.forEach((item) => {
        const factor = positiveFactor(item.unit2Factor);
        const prices = {
          wholesale: wholesalePrice(item.approved, factor),
          retail: retailPrice(item.approved)
        };
        const showCost = costs.ok || (source.costs && source.costs.status === "ok");
        const cost = showCost ? resolveCost(item, costIndex) : { ok: false, reason: "" };

        if (prices.wholesale.state !== PRICE_STATES.valid || prices.retail.state !== PRICE_STATES.valid) {
          unpriced.push({
            ...baseRow(item),
            hasApprovedRow: Boolean(item.approved),
            wholesaleState: prices.wholesale.state,
            wholesaleStateLabel: PRICE_STATE_LABELS[prices.wholesale.state],
            wholesalePrice: prices.wholesale.value,
            retailState: prices.retail.state,
            retailStateLabel: PRICE_STATE_LABELS[prices.retail.state],
            retailPrice: prices.retail.value,
            cartonCost: cost.ok ? round2(cost.cartonCost) : null,
            costNote: cost.ok ? "" : (cost.reason ? REASONS[cost.reason] : "")
          });
        }

        if (!costs.ok) return;
        Object.keys(PRICE_TYPES).forEach((type) => {
          const price = prices[type];
          if (price.state !== PRICE_STATES.valid) return;
          const row = {
            ...baseRow(item),
            priceType: type,
            priceTypeLabel: PRICE_TYPE_LABELS[type],
            priceSource: price.source,
            salePrice: round2(price.value),
            inBulletin: inBulletin(item, type),
            costUpdatedAt: cost.updatedAt || ""
          };
          if (!cost.ok) {
            unverifiable.push({ ...row, reason: cost.reason, reasonLabel: REASONS[cost.reason] });
            return;
          }
          const ratio = price.value / cost.cartonCost;
          if (!(ratio >= THRESHOLDS.plausibleRatioMin && ratio <= THRESHOLDS.plausibleRatioMax)) {
            unverifiable.push({ ...row, cartonCost: round2(cost.cartonCost), reason: "ratio_implausible", reasonLabel: REASONS.ratio_implausible });
            return;
          }
          const loss = cost.cartonCost - price.value;
          if (loss <= cost.tolerance) return;
          below.push({
            ...row,
            unitCost: cost.unitCost,
            cartonCost: round2(cost.cartonCost),
            lossPerUnit2: round2(loss),
            lossPercent: Math.round((loss / cost.cartonCost) * 1000) / 10
          });
        });
      });
    }

    below.sort((a, b) => b.lossPercent - a.lossPercent || b.lossPerUnit2 - a.lossPerUnit2 || a.name.localeCompare(b.name, "ar"));
    unpriced.sort((a, b) => a.groupName.localeCompare(b.groupName, "ar") || a.name.localeCompare(b.name, "ar"));
    unverifiable.sort((a, b) => a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name, "ar"));

    const distinct = (rows) => new Set(rows.map((row) => row.key)).size;
    return {
      version: VERSION,
      generatedAt: new Date(nowMs).toISOString(),
      stockSyncedAt,
      costsUpdatedAt,
      scopeCount: scope.ok ? items.length : 0,
      belowCost: {
        status: costs.ok ? "ok" : "unavailable",
        reason: costs.reason,
        rows: below,
        unverifiable,
        itemCount: distinct(below),
        byPriceType: {
          wholesale: below.filter((row) => row.priceType === PRICE_TYPES.wholesale).length,
          retail: below.filter((row) => row.priceType === PRICE_TYPES.retail).length
        },
        unverifiableItemCount: distinct(unverifiable)
      },
      unpriced: {
        status: scope.ok ? "ok" : "unavailable",
        reason: scope.reason,
        rows: unpriced,
        itemCount: unpriced.length,
        byState: unpriced.reduce((acc, row) => {
          [row.wholesaleState, row.retailState].forEach((state) => {
            if (state !== PRICE_STATES.valid) acc[state] = (acc[state] || 0) + 1;
          });
          return acc;
        }, {})
      }
    };
  }

  // ===== أدوات العرض: بحث وفرز داخل الستارة (نقية كذلك) =====
  function normalizeQuery(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[إأآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/[ً-ْـ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function filterRows(rows, query) {
    const q = normalizeQuery(query);
    if (!q) return rows.slice();
    return rows.filter((row) => normalizeQuery(`${row.name} ${row.code} ${row.groupName}`).includes(q));
  }

  const SORTS = Object.freeze({
    belowCost: Object.freeze({
      lossPercentDesc: (a, b) => b.lossPercent - a.lossPercent,
      lossValueDesc: (a, b) => b.lossPerUnit2 - a.lossPerUnit2,
      nameAsc: (a, b) => a.name.localeCompare(b.name, "ar"),
      groupAsc: (a, b) => a.groupName.localeCompare(b.groupName, "ar") || b.lossPercent - a.lossPercent
    }),
    unpriced: Object.freeze({
      groupAsc: (a, b) => a.groupName.localeCompare(b.groupName, "ar") || a.name.localeCompare(b.name, "ar"),
      nameAsc: (a, b) => a.name.localeCompare(b.name, "ar"),
      stockDesc: (a, b) => b.stockQty - a.stockQty,
      costDesc: (a, b) => (b.cartonCost || 0) - (a.cartonCost || 0)
    })
  });

  function sortRows(rows, panel, sortKey) {
    const table = SORTS[panel] || {};
    const compare = table[sortKey] || Object.values(table)[0];
    return compare ? rows.slice().sort(compare) : rows.slice();
  }

  const api = Object.freeze({
    VERSION,
    THRESHOLDS,
    PRICE_TYPES,
    PRICE_STATES,
    PRICE_STATE_LABELS,
    REASONS,
    classifyPrice,
    auditPriceCost,
    filterRows,
    sortRows,
    SORTS
  });

  if (typeof window !== "undefined") window.ozkPriceCostAudit = api;
  if (typeof globalThis !== "undefined") globalThis.ozkPriceCostAudit = api;
})();
