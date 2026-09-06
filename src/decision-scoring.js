(function () {
  "use strict";

  // ============================================================================
  // نواة تقييم لوحة «قرار اليوم» — دوال نقية بلا DOM وبلا شبكة، كي تُختبر مباشرة.
  //
  // ثلاثة نماذج مستقلة:
  //   scoreItems      — أولوية شراء الصنف
  //   scoreSuppliers  — أولوية الشراء من المورد (منفصلة عن التزامه المالي)
  //   scoreCustomers  — خطر التحصيل
  //
  // القواعد التي لا تُكسر:
  //   • الهوية بالمعرّف (GUID) أولاً. الاسم للعرض فقط، ولا يكون هوية إلا حين
  //     يغيب المعرّف تماماً — لأن إعادة التسمية في الأمين تشطر السجلات صامتاً.
  //   • نفاد المخزون وحده ليس سبباً كافياً للاستعجال. تُقاس الحياة أولاً.
  //   • لا أرقام سحرية داخل المعادلات — كلها في TUNABLES.
  //   • غياب معطى لا يُختلق: يُعاد توزيع وزنه على المعطيات المتوفّرة.
  // ============================================================================

  const TUNABLES = Object.freeze({
    // ---- أولوية شراء الصنف ----
    PURCHASE_MIN_DAILY_SALES: 0.5,        // تحت هذا المعدل يُعدّ الصنف ضعيف الطلب
    PURCHASE_DORMANT_DAYS: 21,            // بلا بيع أطول من هذا = راكد
    PURCHASE_TARGET_COVERAGE_DAYS: 14,    // أيام التغطية المستهدفة
    PURCHASE_DORMANT_MAX_SCORE: 25,       // سقف درجة الراكد
    PURCHASE_WEIGHT_URGENCY: 0.55,
    PURCHASE_WEIGHT_DEMAND: 0.30,
    PURCHASE_WEIGHT_VALUE: 0.15,
    PURCHASE_URGENT_AT: 85,
    PURCHASE_SOON_AT: 65,

    // ---- أولوية المورد ----
    SUPPLIER_WEIGHT_DEMAND_AT_RISK: 0.40,
    SUPPLIER_WEIGHT_COVERAGE_GAP: 0.30,
    SUPPLIER_WEIGHT_SALES_IMPORTANCE: 0.20,
    SUPPLIER_WEIGHT_TIME_SINCE_PURCHASE: 0.10,
    SUPPLIER_PURCHASE_CYCLE_DAYS: 45,
    SUPPLIER_URGENT_AT: 70,
    SUPPLIER_SOON_AT: 45,

    // ---- خطر التحصيل ----
    // التعرّض لم يعد وزناً جمعياً بل مقداراً مضروباً — انظر شرح الصيغة في
    // scoreCustomers. هذا الثابت هو المئين المرجعي الذي تُعاير عليه الخسارة.
    // 1.0 = أعلى خسارة متوقّعة في المجتمع هي المعيار. جُرّب 0.90 على عيّنة
    // الإنتاج فتشبّع 13 زبوناً عند 100 بالضبط وضاع الترتيب داخل أهم شريحة —
    // وهو عين العطل الذي بدأ منه هذا الإصلاح. يُخفَّض هذا الثابت فقط إن ظهر
    // مدين شاذّ الحجم يسحق المقياس.
    COLLECTION_EXPOSURE_REFERENCE_PERCENTILE: 1.0,
    COLLECTION_WEIGHT_PAYMENT_DELAY: 0.30,
    COLLECTION_WEIGHT_UTILIZATION: 0.25,
    COLLECTION_WEIGHT_MOMENTUM: 0.15,
    COLLECTION_DELAY_CAP_DAYS: 60,        // التأخير الذي يبلغ عنده المكوّن أقصاه
    COLLECTION_MOMENTUM_WINDOW_DAYS: 90,  // نافذة قياس انتظام السداد
    COLLECTION_UTILIZATION_CAP: 1.5,      // نسبة الاستخدام التي تُشبع المكوّن
    COLLECTION_NEUTRAL_UTILIZATION: 0.5,  // بديل محايد حين لا يوجد حد معتمد
    // عتبتا التصنيف تُقاسان على احتمال التعثّر (behaviouralRisk × 100)،
    // لا على درجة الأولوية — انظر الشرح عند حقل level.
    COLLECTION_CRITICAL_AT: 70,
    COLLECTION_WATCH_AT: 45,

    // ---- حداثة اللقطة ----
    SNAPSHOT_MAX_AGE_HOURS: 26,           // ما بعده تُعدّ توصية الشراء غير موثوقة
    SNAPSHOT_WARN_AGE_HOURS: 8
  });

  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DAY_MS = 86400000;

  // ---------------------------------------------------------------- أدوات عامة

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function numOr(value, fallback) {
    const parsed = num(value);
    return parsed === null ? fallback : parsed;
  }

  function clamp(value, low, high) {
    if (!Number.isFinite(value)) return low;
    return Math.min(high, Math.max(low, value));
  }

  function cleanText(value) {
    return String(value === null || value === undefined ? "" : value).trim().replace(/\s+/gu, " ");
  }

  // تطبيع عربي للعرض والمطابقة الاحتياطية وحدها — لا يُستعمل هوية أبداً.
  function normalizedName(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/[أإآٱ]/gu, "ا")
      .replace(/ة/gu, "ه")
      .replace(/[ً-ْـ]/gu, "");
  }

  function toGuid(value) {
    const text = cleanText(value).toLowerCase();
    if (!text || text === ZERO_GUID || !GUID_PATTERN.test(text)) return "";
    return text;
  }

  function toTime(value) {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    const time = parsed.getTime();
    return Number.isFinite(time) ? time : null;
  }

  function daysBetween(laterMs, earlierMs) {
    if (!Number.isFinite(laterMs) || !Number.isFinite(earlierMs)) return null;
    return Math.max(0, (laterMs - earlierMs) / DAY_MS);
  }

  // رتبة مئوية ضمن [0,1]: نسبة القيم الأصغر تماماً. القيم المتساوية تنال الرتبة
  // نفسها، فلا يسيطر صنف واحد سريع جداً على المقياس كما يفعل القسمة على الأقصى.
  function percentileRanker(values) {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (sorted.length <= 1) {
      return () => (sorted.length === 1 ? 1 : 0);
    }
    return function rank(value) {
      if (!Number.isFinite(value)) return 0;
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (sorted[mid] < value) low = mid + 1;
        else high = mid;
      }
      return clamp(low / (sorted.length - 1), 0, 1);
    };
  }

  // مئين بالمقدار (لا بالرتبة): يُستعمل معياراً لتعيير الخسارة المتوقّعة، فلا
  // يفرض أكبرُ مدين وحده المقياس ولا يُفنى أصغرهم.
  function percentileValue(values, fraction) {
    const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    if (sorted.length === 1) return sorted[0];
    const position = clamp(fraction, 0, 1) * (sorted.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }

  function settings(overrides) {
    return Object.freeze({ ...TUNABLES, ...(overrides || {}) });
  }

  // --------------------------------------------------------- هوية الصنف والدمج

  // الهوية بترتيب صارم: معرّف صريح، ثم مفتاح يبدو معرّفاً، ثم الاسم كملاذ أخير
  // موسوم صراحةً كي يظهر في التشخيص أنه ليس هوية مستقرة.
  function itemIdentity(row) {
    const guid = toGuid(row?.itemGuid ?? row?.item_guid)
      || toGuid(row?.itemKey ?? row?.item_key)
      || toGuid(row?.key);
    if (guid) return { id: `guid:${guid}`, guid, basis: "guid" };
    const name = normalizedName(row?.itemName ?? row?.item_name ?? row?.name);
    if (name) return { id: `name:${name}`, guid: "", basis: "name" };
    return { id: "", guid: "", basis: "none" };
  }

  function supplierIdentity(row) {
    const guid = toGuid(row?.supplierGuid ?? row?.supplier_guid ?? row?.guid);
    if (guid) return { id: `guid:${guid}`, guid, basis: "guid" };
    const name = normalizedName(row?.supplierName ?? row?.supplier_name ?? row?.name);
    if (name) return { id: `name:${name}`, guid: "", basis: "name" };
    return { id: "", guid: "", basis: "none" };
  }

  function customerIdentity(row) {
    const guid = toGuid(row?.customerGuid ?? row?.customer_guid)
      || toGuid(row?.customerAccountGuid ?? row?.customer_account_guid);
    if (guid) return { id: `guid:${guid}`, guid, basis: "guid" };
    const key = cleanText(row?.customerKey ?? row?.customer_key ?? row?.key);
    if (key) return { id: `key:${key.toLowerCase()}`, guid: "", basis: "key" };
    const name = normalizedName(row?.customerName ?? row?.customer_name ?? row?.name);
    if (name) return { id: `name:${name}`, guid: "", basis: "name" };
    return { id: "", guid: "", basis: "none" };
  }

  // أحدث سجل يفوز عند التكرار: الأكمل بياناتٍ ثم الأحدث تحديثاً. لا يُحذف شيء من
  // المصدر — الدمج في طبقة القرار وحدها.
  function preferRow(current, candidate) {
    if (!current) return candidate;
    const score = (row) => {
      let points = 0;
      if (toGuid(row?.itemGuid ?? row?.item_guid)) points += 4;
      if (num(row?.salePrice ?? row?.sale_price) !== null) points += 2;
      if (num(row?.stockQty ?? row?.stock_qty) !== null) points += 1;
      return points;
    };
    const currentScore = score(current);
    const candidateScore = score(candidate);
    if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
    const currentAt = toTime(current?.updatedAt ?? current?.updated_at ?? current?.approvedAt ?? current?.approved_at) ?? 0;
    const candidateAt = toTime(candidate?.updatedAt ?? candidate?.updated_at ?? candidate?.approvedAt ?? candidate?.approved_at) ?? 0;
    return candidateAt > currentAt ? candidate : current;
  }

  function dedupeItems(rows) {
    const byIdentity = new Map();
    const skipped = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const identity = itemIdentity(row);
      if (!identity.id) { skipped.push(row); continue; }
      const existing = byIdentity.get(identity.id);
      byIdentity.set(identity.id, existing ? preferRow(existing, row) : row);
    }
    return {
      rows: Array.from(byIdentity.values()),
      identities: byIdentity,
      duplicateCount: (Array.isArray(rows) ? rows.length : 0) - byIdentity.size - skipped.length,
      unidentifiedCount: skipped.length
    };
  }

  // فهرس اللقطة: المعرّف هو المفتاح الأساسي، والاسم فهرس احتياطي يُستشار فقط
  // حين لا يحمل الصنف معرّفاً — فلا يرث صنفٌ حركةَ صنفٍ آخر يطابقه اسماً.
  function buildSnapshotIndex(rows) {
    const byGuid = new Map();
    const byName = new Map();
    const nameCollisions = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const guid = toGuid(row?.itemGuid ?? row?.item_guid) || toGuid(row?.itemKey ?? row?.item_key);
      if (guid && !byGuid.has(guid)) byGuid.set(guid, row);
      const name = normalizedName(row?.itemName ?? row?.item_name);
      if (!name) continue;
      if (byName.has(name)) nameCollisions.add(name);
      else byName.set(name, row);
    }
    return { byGuid, byName, nameCollisions };
  }

  function findSnapshot(index, row) {
    const guid = toGuid(row?.itemGuid ?? row?.item_guid) || toGuid(row?.itemKey ?? row?.item_key);
    if (guid) return index.byGuid.get(guid) || null;
    const name = normalizedName(row?.itemName ?? row?.item_name);
    // اسم مكرر في اللقطة لا يصلح مطابقةً — يُترك بلا حركة بدل نسبتها للخطأ.
    if (!name || index.nameCollisions.has(name)) return null;
    return index.byName.get(name) || null;
  }

  // --------------------------------------------------------------- حداثة اللقطة

  function snapshotFreshness(snapshotRows, options) {
    const config = settings(options?.tunables);
    const now = toTime(options?.now) ?? Date.now();
    let newest = null;
    for (const row of Array.isArray(snapshotRows) ? snapshotRows : []) {
      const at = toTime(row?.generatedAt ?? row?.generated_at);
      if (at !== null && (newest === null || at > newest)) newest = at;
    }
    if (newest === null) {
      return Object.freeze({
        generatedAt: null, ageHours: null, state: "missing", trusted: false,
        reason: "لا توجد لقطة أصناف — تعذّر حساب أولوية الشراء."
      });
    }
    const ageHours = Math.max(0, (now - newest) / 3600000);
    const state = ageHours > config.SNAPSHOT_MAX_AGE_HOURS ? "stale"
      : ageHours > config.SNAPSHOT_WARN_AGE_HOURS ? "aging" : "fresh";
    return Object.freeze({
      generatedAt: new Date(newest).toISOString(),
      ageHours,
      state,
      trusted: state !== "stale" && state !== "missing",
      reason: state === "stale"
        ? `بيانات أولوية الشراء قديمة — آخر تحديث قبل ${Math.floor(ageHours)} ساعة.`
        : null
    });
  }

  // ------------------------------------------------------- أولوية شراء الصنف

  function readItemFacts(row, snapshot, nowMs) {
    // المخزون والحركة من اللقطة حين توفّرت، لأنهما يُحسبان معاً على نافذة واحدة.
    // الخلط بين مخزون لقطة وحالة مصدر آخر أحدث هو ما أنتج تناقضات سابقة.
    const stockFromSnapshot = num(snapshot?.stockUnit1 ?? snapshot?.stock_unit1);
    const stock = stockFromSnapshot !== null ? stockFromSnapshot : num(row?.stockQty ?? row?.stock_qty);
    const sold30d = num(snapshot?.unitsSold30d ?? snapshot?.units_sold_30d)
      ?? num(row?.unitsSold30d ?? row?.units_sold_30d);
    const lastSaleAt = toTime(snapshot?.lastSaleDate ?? snapshot?.last_sale_date
      ?? row?.lastSaleDate ?? row?.last_sale_date);
    const unit2Factor = num(row?.unit2Factor ?? row?.unit2_factor)
      ?? num(snapshot?.unit2Factor ?? snapshot?.unit2_factor);
    const price = num(row?.salePrice ?? row?.sale_price);
    return {
      stock,
      sold30d,
      dailySales: sold30d === null ? null : sold30d / 30,
      idleDays: lastSaleAt === null ? null : daysBetween(nowMs, lastSaleAt),
      lastSaleDate: lastSaleAt === null ? null : new Date(lastSaleAt).toISOString().slice(0, 10),
      unit2Factor: unit2Factor !== null && unit2Factor > 1 ? unit2Factor : null,
      price: price !== null && price > 0 ? price : null,
      supplierGuid: toGuid(snapshot?.lastSupplierGuid ?? snapshot?.last_supplier_guid),
      supplierName: cleanText(snapshot?.lastSupplierName ?? snapshot?.last_supplier_name),
      lastPurchaseAt: toTime(snapshot?.lastPurchaseDate ?? snapshot?.last_purchase_date)
    };
  }

  function coverageOf(stock, dailySales) {
    if (dailySales === null || dailySales <= 0) return Infinity;
    return Math.max(0, stock === null ? 0 : stock) / dailySales;
  }

  function suggestQuantity(facts, coverageDays, config) {
    if (facts.dailySales === null || facts.dailySales <= 0) {
      return Object.freeze({ units: 0, cartons: null, unit2Factor: null, basis: "no_velocity" });
    }
    const target = facts.dailySales * config.PURCHASE_TARGET_COVERAGE_DAYS;
    const units = Math.max(0, target - Math.max(0, facts.stock === null ? 0 : facts.stock));
    if (units <= 0) {
      return Object.freeze({ units: 0, cartons: null, unit2Factor: facts.unit2Factor, basis: "covered" });
    }
    // التقريب للعبوة يجري فقط حين يكون معامل التحويل موثوقاً — لا يُخترع تحويل.
    if (facts.unit2Factor !== null) {
      const cartons = Math.ceil(units / facts.unit2Factor);
      return Object.freeze({
        units: cartons * facts.unit2Factor,
        cartons,
        unit2Factor: facts.unit2Factor,
        basis: "unit2"
      });
    }
    return Object.freeze({ units: Math.ceil(units), cartons: null, unit2Factor: null, basis: "unit1" });
  }

  function scoreItems(input) {
    const config = settings(input?.tunables);
    const nowMs = toTime(input?.now) ?? Date.now();
    const deduped = dedupeItems(input?.items);
    const index = buildSnapshotIndex(input?.snapshots);

    const prepared = deduped.rows.map((row) => {
      const identity = itemIdentity(row);
      const snapshot = findSnapshot(index, row);
      const facts = readItemFacts(row, snapshot, nowMs);
      const coverageDays = coverageOf(facts.stock, facts.dailySales);
      const hasVelocity = facts.dailySales !== null;
      const belowFloor = hasVelocity && facts.dailySales < config.PURCHASE_MIN_DAILY_SALES;
      const idle = facts.idleDays !== null && facts.idleDays > config.PURCHASE_DORMANT_DAYS;
      // بوابة الحياة تسبق كل شيء: النفاد لا يمنح استعجالاً لصنف لا طلب عليه.
      const dormant = hasVelocity && (belowFloor || idle);
      return {
        row, identity, snapshot, facts, coverageDays,
        hasVelocity, dormant,
        dormantReason: !dormant ? null : idle && belowFloor ? "طلب ضعيف وبلا بيع حديث"
          : idle ? "بلا بيع حديث" : "طلب ضعيف"
      };
    });

    // المقاييس النسبية تُبنى من الأصناف النشطة وحدها، كي لا يسحب الركود المقياس.
    const active = prepared.filter((entry) => entry.hasVelocity && !entry.dormant);
    const demandRank = percentileRanker(active.map((entry) => entry.facts.dailySales));
    const valueSamples = active
      .filter((entry) => entry.facts.price !== null)
      .map((entry) => entry.facts.dailySales * entry.facts.price);
    const valueRank = percentileRanker(valueSamples);
    // القيمة تدخل النموذج فقط إن كانت معروفة لأغلب الأصناف النشطة؛ دونها يُعاد
    // توزيع وزنها بدل تعويضها برقم مخترع.
    const valueUsable = active.length > 0 && valueSamples.length >= Math.ceil(active.length / 2);

    const scored = prepared.map((entry) => {
      const { facts, coverageDays } = entry;
      const name = cleanText(entry.row?.itemName ?? entry.row?.item_name ?? entry.row?.name) || "صنف";
      const base = {
        id: entry.identity.id,
        itemGuid: entry.identity.guid,
        identityBasis: entry.identity.basis,
        name,
        stock: facts.stock,
        sold30d: facts.sold30d,
        dailySales: facts.dailySales,
        coverageDays,
        idleDays: facts.idleDays,
        lastSaleDate: facts.lastSaleDate,
        price: facts.price,
        supplierGuid: facts.supplierGuid,
        supplierName: facts.supplierName,
        lastPurchaseAt: facts.lastPurchaseAt,
        matchedSnapshot: Boolean(entry.snapshot)
      };

      if (!entry.hasVelocity) {
        return Object.freeze({
          ...base, score: 0, priority: "unknown", urgency: null, demandScale: null, valueScale: null,
          reason: "حركة المبيعات غير متوفرة — لا تقييم شراء",
          suggested: Object.freeze({ units: 0, cartons: null, unit2Factor: null, basis: "no_velocity" })
        });
      }

      const urgency = clamp(1 - coverageDays / config.PURCHASE_TARGET_COVERAGE_DAYS, 0, 1);

      if (entry.dormant) {
        // يبقى تدرّج داخل الراكد كي يُرتَّب بينه، لكنه لا يتجاوز السقف أبداً.
        const score = Math.round(clamp(urgency, 0, 1) * config.PURCHASE_DORMANT_MAX_SCORE);
        return Object.freeze({
          ...base,
          score,
          priority: "dormant",
          urgency,
          demandScale: null,
          valueScale: null,
          reason: `${entry.dormantReason} — ${formatDailySales(facts.dailySales)} يومياً`,
          suggested: Object.freeze({ units: 0, cartons: null, unit2Factor: facts.unit2Factor, basis: "dormant" })
        });
      }

      const demandScale = demandRank(facts.dailySales);
      const valueScale = valueUsable && facts.price !== null
        ? valueRank(facts.dailySales * facts.price)
        : null;

      let score;
      if (valueScale === null) {
        // إعادة توزيع وزن القيمة على المكوّنين المتوفّرين — لا قيمة وهمية.
        const total = config.PURCHASE_WEIGHT_URGENCY + config.PURCHASE_WEIGHT_DEMAND;
        score = 100 * ((config.PURCHASE_WEIGHT_URGENCY / total) * urgency
          + (config.PURCHASE_WEIGHT_DEMAND / total) * demandScale);
      } else {
        score = 100 * (config.PURCHASE_WEIGHT_URGENCY * urgency
          + config.PURCHASE_WEIGHT_DEMAND * demandScale
          + config.PURCHASE_WEIGHT_VALUE * valueScale);
      }
      const rounded = Math.round(clamp(score, 0, 100));
      const priority = rounded >= config.PURCHASE_URGENT_AT ? "urgent"
        : rounded >= config.PURCHASE_SOON_AT ? "soon" : "steady";

      return Object.freeze({
        ...base,
        score: rounded,
        priority,
        urgency,
        demandScale,
        valueScale,
        reason: buildItemReason(facts, coverageDays, demandScale),
        suggested: suggestQuantity(facts, coverageDays, config)
      });
    });

    // الفرز الثانوي صريح: التغطية ثم السرعة، والاسم آخر فاصل فقط — كي لا يعود
    // الترتيب الأبجدي عاملاً فعلياً عند تساوي الدرجات.
    const rank = { urgent: 0, soon: 1, steady: 2, dormant: 3, unknown: 4 };
    scored.sort((a, b) =>
      (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9)
      || b.score - a.score
      || (a.coverageDays ?? Infinity) - (b.coverageDays ?? Infinity)
      || (b.dailySales ?? -1) - (a.dailySales ?? -1)
      || a.name.localeCompare(b.name, "ar"));

    return Object.freeze({
      items: Object.freeze(scored),
      duplicateCount: deduped.duplicateCount,
      unidentifiedCount: deduped.unidentifiedCount,
      nameMatchedCount: scored.filter((item) => item.identityBasis === "name").length,
      valueScaleUsed: valueUsable,
      urgentCount: scored.filter((item) => item.priority === "urgent").length,
      dormantCount: scored.filter((item) => item.priority === "dormant").length
    });
  }

  function formatDailySales(dailySales) {
    if (dailySales === null) return "—";
    return dailySales >= 10 ? String(Math.round(dailySales)) : dailySales.toFixed(2);
  }

  function buildItemReason(facts, coverageDays, demandScale) {
    const parts = [];
    if (facts.stock !== null && facts.stock <= 0) parts.push("نافد");
    else if (Number.isFinite(coverageDays)) parts.push(`تغطية ${coverageDays < 1 ? "أقل من يوم" : `${Math.round(coverageDays)} يوم`}`);
    parts.push(`${formatDailySales(facts.dailySales)} يومياً`);
    if (demandScale >= 0.8) parts.push("من الأسرع دوراناً");
    return parts.join(" · ");
  }

  // --------------------------------------------------------- أولوية المورد

  function scoreSuppliers(input) {
    const config = settings(input?.tunables);
    const nowMs = toTime(input?.now) ?? Date.now();
    const scoredItems = Array.isArray(input?.items) ? input.items : [];
    const obligations = Array.isArray(input?.obligations) ? input.obligations : [];

    // التزام المورد يُفهرس على حدة تماماً — لا يدخل ترتيب الشراء إطلاقاً.
    const obligationByIdentity = new Map();
    for (const row of obligations) {
      const identity = supplierIdentity(row);
      if (!identity.id) continue;
      const amount = numOr(row?.amountDue ?? row?.amount_due, 0);
      const existing = obligationByIdentity.get(identity.id);
      obligationByIdentity.set(identity.id, {
        amount: (existing?.amount || 0) + amount,
        currency: cleanText(row?.currency) || existing?.currency || "",
        name: cleanText(row?.supplierName ?? row?.supplier_name) || existing?.name || ""
      });
    }

    const groups = new Map();
    for (const item of scoredItems) {
      if (!item.supplierGuid && !item.supplierName) continue;
      const identity = supplierIdentity({ supplierGuid: item.supplierGuid, supplierName: item.supplierName });
      if (!identity.id) continue;
      if (!groups.has(identity.id)) {
        groups.set(identity.id, {
          identity, name: item.supplierName || "مورد", items: [],
          lastPurchaseAt: null
        });
      }
      const group = groups.get(identity.id);
      group.items.push(item);
      if (item.lastPurchaseAt !== null && (group.lastPurchaseAt === null || item.lastPurchaseAt > group.lastPurchaseAt)) {
        group.lastPurchaseAt = item.lastPurchaseAt;
      }
    }

    const totalDailySales = scoredItems.reduce((sum, item) => sum + (item.dailySales || 0), 0);

    const raw = Array.from(groups.values()).map((group) => {
      const live = group.items.filter((item) => item.priority !== "dormant" && item.priority !== "unknown");
      // «الطلب المعرَّض» لا «عدد النافد»: مورد أصنافه على بعد ساعات من النفاد
      // يخسر مبيعات فعلية مثل مورد نفدت أصنافه. القياس الثنائي (نافد/غير نافد)
      // أسقط على عيّنة الإنتاج مورداً بأربعة أصناف عاجلة و40٪ من المبيعات دون
      // مورد بصنف واحد نافد. الوزن هنا = المبيع اليومي × درجة إلحاح الصنف.
      const demandAtRisk = live
        .reduce((sum, item) => sum + (item.dailySales || 0) * (item.urgency || 0), 0);
      const gapCount = live.filter((item) =>
        Number.isFinite(item.coverageDays) && item.coverageDays < config.PURCHASE_TARGET_COVERAGE_DAYS).length;
      const coverageGap = live.length > 0 ? gapCount / live.length : 0;
      const supplierDailySales = live.reduce((sum, item) => sum + (item.dailySales || 0), 0);
      const salesImportance = totalDailySales > 0 ? supplierDailySales / totalDailySales : 0;
      const daysSincePurchase = group.lastPurchaseAt === null ? null : daysBetween(nowMs, group.lastPurchaseAt);
      const timeSincePurchase = daysSincePurchase === null
        ? 0
        : clamp(daysSincePurchase / config.SUPPLIER_PURCHASE_CYCLE_DAYS, 0, 1);
      const obligation = obligationByIdentity.get(group.identity.id) || null;
      return {
        group, demandAtRisk, coverageGap, salesImportance, timeSincePurchase, daysSincePurchase,
        urgentCount: live.filter((item) => item.priority === "urgent").length,
        stockoutCount: live.filter((item) => item.stock !== null && item.stock <= 0).length,
        activeCount: live.length,
        totalCount: group.items.length,
        obligation
      };
    });

    const demandAtRiskRank = percentileRanker(raw.map((entry) => entry.demandAtRisk));
    const salesRank = percentileRanker(raw.map((entry) => entry.salesImportance));

    const scored = raw.map((entry) => {
      const demandAtRiskScale = entry.demandAtRisk > 0 ? demandAtRiskRank(entry.demandAtRisk) : 0;
      const salesScale = entry.salesImportance > 0 ? salesRank(entry.salesImportance) : 0;
      const score = Math.round(clamp(100 * (
        config.SUPPLIER_WEIGHT_DEMAND_AT_RISK * demandAtRiskScale
        + config.SUPPLIER_WEIGHT_COVERAGE_GAP * entry.coverageGap
        + config.SUPPLIER_WEIGHT_SALES_IMPORTANCE * salesScale
        + config.SUPPLIER_WEIGHT_TIME_SINCE_PURCHASE * entry.timeSincePurchase
      ), 0, 100));
      return Object.freeze({
        id: entry.group.identity.id,
        supplierGuid: entry.group.identity.guid,
        identityBasis: entry.group.identity.basis,
        name: entry.group.name,
        score,
        priority: score >= config.SUPPLIER_URGENT_AT ? "urgent"
          : score >= config.SUPPLIER_SOON_AT ? "soon" : "watch",
        urgentCount: entry.urgentCount,
        stockoutCount: entry.stockoutCount,
        activeCount: entry.activeCount,
        totalCount: entry.totalCount,
        coverageGap: entry.coverageGap,
        salesImportance: entry.salesImportance,
        demandAtRisk: entry.demandAtRisk,
        daysSincePurchase: entry.daysSincePurchase,
        // الالتزام المالي معروض مستقلاً ولا يشارك في الدرجة إطلاقاً.
        obligationAmount: entry.obligation ? entry.obligation.amount : null,
        obligationCurrency: entry.obligation ? entry.obligation.currency : "",
        reason: buildSupplierReason(entry)
      });
    });

    scored.sort((a, b) =>
      b.score - a.score
      || b.urgentCount - a.urgentCount
      || b.demandAtRisk - a.demandAtRisk
      || a.name.localeCompare(b.name, "ar"));

    return Object.freeze({
      suppliers: Object.freeze(scored),
      obligationCount: obligationByIdentity.size,
      linkedSupplierCount: groups.size
    });
  }

  function buildSupplierReason(entry) {
    const parts = [];
    if (entry.stockoutCount > 0) parts.push(`${entry.stockoutCount} صنف نافد نشط`);
    if (entry.coverageGap > 0) parts.push(`${Math.round(entry.coverageGap * 100)}٪ تحت التغطية الهدف`);
    if (entry.daysSincePurchase !== null) parts.push(`آخر شراء قبل ${Math.round(entry.daysSincePurchase)} يوم`);
    return parts.length ? parts.join(" · ") : "لا نواقص نشطة حالياً";
  }

  // --------------------------------------------------------- خطر التحصيل

  function paymentsWithin(row, nowMs, windowDays) {
    const list = Array.isArray(row?.recentPayments) ? row.recentPayments : [];
    let total = 0;
    let count = 0;
    for (const payment of list) {
      const at = toTime(payment?.date);
      if (at === null) continue;
      const age = daysBetween(nowMs, at);
      if (age === null || age > windowDays) continue;
      const amount = num(payment?.amount);
      if (amount === null || amount <= 0) continue;
      total += amount;
      count += 1;
    }
    return { total, count };
  }

  function scoreCustomers(input) {
    const config = settings(input?.tunables);
    const nowMs = toTime(input?.now) ?? Date.now();
    const rows = Array.isArray(input?.balances) ? input.balances : [];
    const limits = Array.isArray(input?.creditLimits) ? input.creditLimits : [];

    const limitByGuid = new Map();
    const limitByKey = new Map();
    const limitByName = new Map();
    for (const limit of limits) {
      const amount = numOr(limit?.creditLimit ?? limit?.credit_limit, 0);
      if (amount <= 0) continue;
      const guid = toGuid(limit?.customerGuid ?? limit?.customer_guid);
      if (guid) { if (!limitByGuid.has(guid)) limitByGuid.set(guid, limit); continue; }
      const key = cleanText(limit?.customerKey ?? limit?.customer_key).toLowerCase();
      if (key && !limitByKey.has(key)) limitByKey.set(key, limit);
      const name = normalizedName(limit?.customerName ?? limit?.customer_name);
      if (name && !limitByName.has(name)) limitByName.set(name, limit);
    }

    // المعرّف أولاً؛ الاحتياط بالاسم مقصور على حدود بلا معرّف حين يحمل الزبون
    // معرّفاً، كي لا يرث حسابٌ حدَّ حسابٍ آخر يطابقه اسماً.
    function limitFor(row) {
      const guid = toGuid(row?.customerGuid ?? row?.customer_guid);
      if (guid && limitByGuid.has(guid)) {
        const match = limitByGuid.get(guid);
        return { amount: numOr(match?.creditLimit ?? match?.credit_limit, 0), source: "approved" };
      }
      const key = cleanText(row?.customerKey ?? row?.customer_key ?? row?.key).toLowerCase();
      if (key && limitByKey.has(key)) {
        const match = limitByKey.get(key);
        return { amount: numOr(match?.creditLimit ?? match?.credit_limit, 0), source: "approved" };
      }
      const name = normalizedName(row?.customerName ?? row?.name);
      if (name && limitByName.has(name)) {
        const match = limitByName.get(name);
        return { amount: numOr(match?.creditLimit ?? match?.credit_limit, 0), source: "approved" };
      }
      const ameen = numOr(row?.creditLimit ?? row?.credit_limit, 0);
      if (ameen > 0) return { amount: ameen, source: "ameen" };
      return { amount: 0, source: "missing" };
    }

    const prepared = rows.map((row) => {
      const balance = Math.max(0, numOr(row?.balance ?? row?.debit ?? row?.amount ?? row?.remaining, 0));
      const limit = limitFor(row);
      const lastPaymentAt = toTime(row?.lastPaymentDate ?? row?.last_payment_date);
      const payments = paymentsWithin(row, nowMs, config.COLLECTION_MOMENTUM_WINDOW_DAYS);
      return {
        row, balance, limit, lastPaymentAt, payments,
        name: cleanText(row?.name ?? row?.customerName ?? row?.customer_name) || "زبون",
        identity: customerIdentity(row),
        daysSincePayment: lastPaymentAt === null ? null : daysBetween(nowMs, lastPaymentAt),
        lastPaymentAmount: num(row?.lastPaymentAmount ?? row?.last_payment_amount)
      };
    }).filter((entry) => entry.balance > 0);

    const exposureRank = percentileRanker(prepared.map((entry) => entry.balance));

    // ---- الصيغة النهائية: خسارة متوقّعة ----
    //
    //   behaviouralRisk = Σ(وزن × مكوّن سلوكي) ÷ Σ(الأوزان السلوكية)   ∈ [0,1]
    //   expectedLoss    = balance × behaviouralRisk                      بالدولار
    //   score           = 100 × min(1, expectedLoss ÷ p90(expectedLoss)) ∈ [0,100]
    //
    // لماذا لا الجمع الوزني المباشر: ثلاثة من المكوّنات الأربعة سلوكية ولا تعرف
    // حجم المال، فتبلغ أقصاها لدى مدين تافه — وأنتج ذلك على عيّنة الإنتاج تصدّر
    // مدين بـ177$ على مدين بـ16,796$.
    //
    // ولماذا لا التعرّض كرتبة مئوية مضروبة: الرتبة تجعل أصغر مدين = 0 فيُفنى
    // حاصل الضرب كلّه مهما ساء سداده، وتُبالغ في الفوارق (مدينان بـ30 و9 آلاف
    // تفصلهما رتبةُ 1 مقابل 0 لا نسبةُ 30:9). المقدار هو الصحيح لا الترتيب.
    //
    // المعيار هو أعلى خسارة متوقّعة في المجتمع، فتنتشر الدرجات على كامل المدى
    // ولا يتساوى رأس القائمة. مئين أدنى (p90) يُشبع الشريحة العليا كلها عند 100
    // فيعيد المشكلة الأصلية: قائمة لا تميّز بين أخطر زبائنها.
    const behaviouralTotal = config.COLLECTION_WEIGHT_PAYMENT_DELAY
      + config.COLLECTION_WEIGHT_UTILIZATION
      + config.COLLECTION_WEIGHT_MOMENTUM;

    const behaviouralOf = (paymentDelay, utilization, momentum) => (behaviouralTotal > 0
      ? (config.COLLECTION_WEIGHT_PAYMENT_DELAY * paymentDelay
        + config.COLLECTION_WEIGHT_UTILIZATION * utilization
        + config.COLLECTION_WEIGHT_MOMENTUM * momentum) / behaviouralTotal
      : 0);

    const componentsOf = (entry) => {
      // الزبون الذي لم يدفع قط يأخذ أقصى تأخير — غياب السجل ليس براءة.
      const paymentDelay = entry.daysSincePayment === null
        ? 1
        : clamp(entry.daysSincePayment / config.COLLECTION_DELAY_CAP_DAYS, 0, 1);
      const ratio = entry.limit.amount > 0 ? entry.balance / entry.limit.amount : null;
      const utilization = ratio === null
        ? config.COLLECTION_NEUTRAL_UTILIZATION
        : clamp(ratio / config.COLLECTION_UTILIZATION_CAP, 0, 1);
      // الزخم يقيس الدفعات مقابل حجم الدين، فالدفعة الرمزية لا تُطفئ الخطر.
      const momentum = clamp(1 - entry.payments.total / entry.balance, 0, 1);
      return { paymentDelay, utilization, momentum, ratio };
    };

    const expectedLosses = prepared.map((entry) => {
      const parts = componentsOf(entry);
      return entry.balance * behaviouralOf(parts.paymentDelay, parts.utilization, parts.momentum);
    });
    const lossReference = percentileValue(expectedLosses, config.COLLECTION_EXPOSURE_REFERENCE_PERCENTILE);

    const scored = prepared.map((entry) => {
      const exposure = exposureRank(entry.balance);
      // الزبون الذي لم يدفع قط يأخذ أقصى تأخير — غياب السجل ليس براءة.
      const paymentDelay = entry.daysSincePayment === null
        ? 1
        : clamp(entry.daysSincePayment / config.COLLECTION_DELAY_CAP_DAYS, 0, 1);
      const ratio = entry.limit.amount > 0 ? entry.balance / entry.limit.amount : null;
      const utilization = ratio === null
        ? config.COLLECTION_NEUTRAL_UTILIZATION
        : clamp(ratio / config.COLLECTION_UTILIZATION_CAP, 0, 1);
      // الزخم يقيس الدفعات مقابل حجم الدين، فالدفعة الرمزية لا تُطفئ الخطر.
      const momentum = clamp(1 - entry.payments.total / entry.balance, 0, 1);

      const behaviouralRisk = behaviouralOf(paymentDelay, utilization, momentum);
      const expectedLoss = entry.balance * behaviouralRisk;
      const score = Math.round(clamp(
        lossReference > 0 ? 100 * (expectedLoss / lossReference) : 0, 0, 100));

      return Object.freeze({
        id: entry.identity.id,
        customerGuid: entry.identity.guid,
        name: entry.name,
        balance: entry.balance,
        limit: entry.limit.amount,
        limitSource: entry.limit.source,
        ratio,
        overBy: ratio === null ? null : Math.max(0, entry.balance - entry.limit.amount),
        available: ratio === null ? null : Math.max(0, entry.limit.amount - entry.balance),
        daysSincePayment: entry.daysSincePayment,
        lastPaymentDate: entry.lastPaymentAt === null ? null : new Date(entry.lastPaymentAt).toISOString().slice(0, 10),
        lastPaymentAmount: entry.lastPaymentAmount,
        payments90d: entry.payments.total,
        paymentCount90d: entry.payments.count,
        exposure, paymentDelay, utilization, momentum, behaviouralRisk, expectedLoss,
        score,
        // بُعدان مستقلان عمداً:
        //   score = أولوية التحصيل (خسارة متوقّعة بالمال) — يحكم الترتيب.
        //   level = شدّة الخطر (احتمال التعثّر) — يحكم لون الحالة والرسالة.
        // خلطهما يُنتج تضليلاً في الاتجاهين: مدين بـ2,743$ متجاوز حدّه 5.5× ولم
        // يدفع منذ 36 يوماً كان يظهر «اعتيادياً» لأن مبلغه صغير، ومدين ضخم
        // منتظم السداد كان يظهر «خطراً عالياً» لأن مبلغه كبير.
        level: behaviouralRisk >= config.COLLECTION_CRITICAL_AT / 100 ? "critical"
          : behaviouralRisk >= config.COLLECTION_WATCH_AT / 100 ? "watch" : "normal",
        reason: buildCustomerReason(entry, ratio, exposure)
      });
    });

    scored.sort((a, b) =>
      b.score - a.score
      || b.balance - a.balance
      || a.name.localeCompare(b.name, "ar"));

    return Object.freeze({
      customers: Object.freeze(scored),
      totalReceivables: scored.reduce((sum, row) => sum + row.balance, 0),
      overLimitTotal: scored.reduce((sum, row) => sum + (row.overBy || 0), 0),
      missingLimitCount: scored.filter((row) => row.limitSource === "missing").length,
      missingLimitReceivables: scored
        .filter((row) => row.limitSource === "missing")
        .reduce((sum, row) => sum + row.balance, 0),
      criticalCount: scored.filter((row) => row.level === "critical").length
    });
  }

  function buildCustomerReason(entry, ratio, exposure) {
    const parts = [];
    if (exposure >= 0.8) parts.push("رصيد مرتفع");
    if (entry.daysSincePayment === null) parts.push("لا دفعة مسجّلة");
    else if (entry.daysSincePayment >= 30) parts.push(`لم يدفع منذ ${Math.round(entry.daysSincePayment)} يوماً`);
    if (ratio !== null && ratio >= 1) parts.push(`تجاوز الحد ${ratio.toFixed(1)}×`);
    else if (ratio === null) parts.push("بلا حد معتمد");
    if (entry.payments.total > 0 && entry.balance > 0 && entry.payments.total / entry.balance < 0.05) {
      parts.push("دفعات رمزية مقارنة بالرصيد");
    }
    return parts.length ? parts.join(" + ") : "ضمن المتابعة الاعتيادية";
  }

  const api = Object.freeze({
    TUNABLES,
    scoreItems,
    scoreSuppliers,
    scoreCustomers,
    snapshotFreshness,
    dedupeItems,
    buildSnapshotIndex,
    findSnapshot,
    itemIdentity,
    supplierIdentity,
    customerIdentity,
    percentileRanker,
    normalizedName,
    toGuid
  });

  if (typeof window !== "undefined") window.ozkDecisionScoring = api;
  if (typeof globalThis !== "undefined") globalThis.ozkDecisionScoring = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
