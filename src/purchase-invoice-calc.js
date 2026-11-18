// ===== حسابات فاتورة المشتريات (poCalc) — دوال صِرفة بلا DOM =====
// تُحمَّل كسكربت عادي (بلا module) قبل app.js فتُلحق poCalc بالنافذة العامة،
// وscripts/check.mjs يشغّلها بمحاكاة vm ليختبرها مباشرة بلا وسيط DOM.
(function (root) {
  const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
  const persianDigits = "۰۱۲۳۴۵۶۷۸۹";

  function poToEnglishDigits(value) {
    return String(value ?? "")
      .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)));
  }

  // يطبّع أرقام عربية/فارسية وفواصل عشرية عربية إلى رقم إنجليزي — يُستعمل لحقول
  // الكمية والسعر والدفعة في فاتورة المشتريات (يشارك المنطق مع normalizeNumericText
  // في app.js، لكنه هنا معزول عن أي متغير عام كي يبقى قابلاً للاختبار في Node مباشرة).
  function poNormalizeNumeric(value, options = {}) {
    const { allowNegative = false, allowDecimal = true } = options;
    let text = poToEnglishDigits(value)
      .replace(/[٫،]/g, ".")
      .replace(/\s+/g, "")
      .trim();

    const commaCount = (text.match(/,/g) || []).length;
    if (allowDecimal && !text.includes(".") && commaCount === 1) {
      const [, decimalPart = ""] = text.split(",");
      if (/^\d{1,2}$/.test(decimalPart)) text = text.replace(",", ".");
    }

    text = text.replace(/,/g, "").replace(/[^\d.-]/g, "");
    const isNegative = allowNegative && text.includes("-");
    text = text.replace(/-/g, "");

    if (!allowDecimal) {
      text = text.replace(/\./g, "");
    } else {
      const parts = text.split(".");
      text = `${parts.shift() || ""}${parts.length ? `.${parts.join("")}` : ""}`;
      if (text.startsWith(".")) text = `0${text}`;
    }

    return isNegative && text ? `-${text}` : text;
  }

  function poToNumber(value) {
    const text = poNormalizeNumeric(value);
    if (!text) return 0;
    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function poRound2(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.round((number + Number.EPSILON) * 100) / 100;
  }

  // سطر الفاتورة: يتجاهل الكمية/السعر إن لم يُختر صنف حقيقي (row.key فارغ) —
  // نفس قاعدة salesRowComputed: سطر بلا هوية صنف لا يدخل أي مجموع.
  function poRowComputed(row) {
    if (!row || !row.key) return { qty: 0, price: 0, lineTotal: 0 };
    const qty = poToNumber(row.qty);
    const price = poToNumber(row.price);
    return { qty, price, lineTotal: poRound2(qty * price) };
  }

  function poTotals(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const grand = list.reduce((sum, row) => sum + poRowComputed(row).lineTotal, 0);
    return { grand: poRound2(grand) };
  }

  // الدفع/المتبقي: موجب = ما زال مستحقاً للمورد، صفر (ضمن هامش قرش) = مسدّد بالكامل،
  // سالب = دُفع أكثر من المطلوب (يجب ألا يحدث لأن poValidatePayment يرفضه، لكن الحساب
  // نفسه لا يفترض ذلك ويُبلغ عنه بصدق بدل حجبه).
  function poRemainingState(input) {
    const total = poRound2(input?.total);
    const paidAmount = poRound2(input?.paidAmount);
    const remaining = poRound2(total - paidAmount);
    const epsilon = 0.01;
    let status = "settled";
    if (remaining > epsilon) status = "due";
    else if (remaining < -epsilon) status = "over";
    return { total, paidAmount, remaining, status };
  }

  // يرفض صراحة (خطأ عربي) بدل الحسم الصامت: دفعة سالبة أو أكبر من الإجمالي.
  // الدفعة الجزئية مسموحة دوماً؛ صفر مسموح (فاتورة آجلة بلا دفعة أولى).
  function poValidatePayment(input) {
    const total = poRound2(input?.total);
    // فحص السالب يجب أن يسبق poToNumber: poToNumber (عبر poNormalizeNumeric بلا
    // allowNegative) يحذف إشارة السالب بصمت، فيصبح -1 قيمته 1 — هذا يُخفي الخطأ
    // بدل رفضه. نقرأ الإشارة الخام أولاً من رقم أو نص قبل أي تطبيع.
    const rawText = poToEnglishDigits(input?.amount).trim();
    const isRawNegative = typeof input?.amount === "number" ? input.amount < 0 : rawText.startsWith("-");
    if (isRawNegative) return { ok: false, error: "لا يمكن أن تكون قيمة الدفعة سالبة." };
    const amount = poToNumber(input?.amount);
    if (amount - total > 0.01) return { ok: false, error: "قيمة الدفعة أكبر من إجمالي الفاتورة." };
    return { ok: true, error: "" };
  }

  // النص الظاهر لصنف مختار: "رقم — اسم" دوماً كي لا يظهر السطر باسم فقط أو رقم
  // فقط. الرقم نص خام (لا Number()) كي لا تُفقد الأصفار البادئة (مثال: "0005").
  function poItemDisplayLabel(num, name) {
    const numText = String(num ?? "").trim();
    const nameText = String(name ?? "").trim();
    if (numText && nameText) return `${numText} — ${nameText}`;
    return numText || nameText;
  }

  // عند تعديل المستخدم لحقل البحث بعد اختيار صنف: يجب إبطال key/name/num فوراً
  // كي لا يُحفَظ صنف قديم تحت رقم/اسم جديد كتبه المستخدم لاحقاً بلا اختيار فعلي
  // من قائمة الاقتراحات. لا إبطال إن كانت القيمة الجديدة مطابقة لنص الاختيار نفسه
  // (مثال: إعادة رسم الحقل بلا تغيير فعلي من المستخدم).
  function poNextRowAfterQueryInput(row, newValue) {
    const prevQ = (row && row.q) || "";
    const hadSelection = !!(row && row.key);
    if (hadSelection && newValue !== prevQ) {
      return { key: "", name: "", num: "", q: newValue };
    }
    return {
      key: (row && row.key) || "",
      name: (row && row.name) || "",
      num: (row && row.num) || "",
      q: newValue
    };
  }

  // يمنع حفظ سطر كُتب فيه نص بحث (رقم أو اسم) دون اختيار فعلي من الاقتراحات —
  // بدل حسمه بصمت (كان سلوك الفلترة السابق: r.key فقط بلا تنبيه للمستخدم).
  function poHasUnselectedEntry(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.some((row) => row && !row.key && String(row.q || "").trim());
  }

  // يمنع تسجيل نفس الصنف مرتين في فاتورة واحدة (يجب دمج الكمية بدل سطر ثانٍ).
  function poDedupeLines(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const seen = new Map();
    const duplicateItemKeys = [];
    list.forEach((row) => {
      if (!row || !row.key) return;
      const count = (seen.get(row.key) || 0) + 1;
      seen.set(row.key, count);
      if (count === 2) duplicateItemKeys.push(row.key);
    });
    return { ok: duplicateItemKeys.length === 0, duplicateItemKeys };
  }

  // ترتيب الحالات: مسودة(0) → معتمدة(1) → بانتظار المزامنة/فشلت(2) → مُزامَنة(3).
  // sync_pending وfailed يتشاركان الرتبة كممر إعادة محاولة بالاتجاهين. الانتقال
  // للأمام خطوة واحدة فقط مسموح، ولا خروج من synced إطلاقاً (تصحيحها إجراء منفصل
  // مُدقَّق بسجل — وليس تحديث حالة عادي)، ولا عودة لمسودة من أي حالة لاحقة.
  const PO_STATUS_RANK = { draft: 0, approved: 1, sync_pending: 2, failed: 2, synced: 3 };
  const PO_STATUS_LABELS = {
    draft: "مسودة",
    approved: "معتمدة",
    sync_pending: "بانتظار المزامنة",
    synced: "مُزامَنة",
    failed: "فشلت المزامنة"
  };

  function poCanTransitionStatus(from, to) {
    if (!(from in PO_STATUS_RANK) || !(to in PO_STATUS_RANK)) return false;
    if (from === to) return true;
    if (from === "synced") return false;
    if (to === "draft") return false;
    if (PO_STATUS_RANK[from] === 2 && PO_STATUS_RANK[to] === 2) return true;
    return PO_STATUS_RANK[to] === PO_STATUS_RANK[from] + 1;
  }

  // ===== عرض فواتير مشتريات الأمين (قراءة فقط) — لا علاقة بحالات المسودة أعلاه =====

  // تطبيع نص بحث عربي (موردين/أصناف): همزات/تاء مربوطة/ألف مقصورة موحّدة
  // وتشكيل محذوف، كي يتطابق «المؤمن» مع «الامين» مثلاً. معزول هنا عمداً عن
  // normalizeItemName في app.js كي تبقى الدالة صِرفة قابلة للاختبار بمعزل عن DOM.
  function poNormalizeSearchText(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[إأآا]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي")
      .replace(/[ً-ْ]/g, "");
  }

  // أسماء الموردين المطابقة لنص بحث المستخدم من قائمة أسماء حقيقية (مستخرَجة من
  // تقرير فواتير الأمين) — بلا نتائج إن كان البحث فارغاً، وسقف 8 اقتراحات.
  function poAmeenSupplierMatches(query, supplierNames) {
    const names = Array.isArray(supplierNames) ? supplierNames : [];
    const raw = String(query || "").trim();
    if (!raw) return [];
    const normalizedQuery = poNormalizeSearchText(raw);
    return names.filter((name) => poNormalizeSearchText(name).includes(normalizedQuery)).slice(0, 8);
  }

  // فهرس التنقل بين فواتير مورد واحد (0 = الأحدث ضمن قائمة مرتّبة تنازلياً
  // بالتاريخ). direction: -1 = الفاتورة السابقة (أقدم)، +1 = التالية (أحدث).
  // لا يخرج عن حدود القائمة أبداً مهما تكرر الاستدعاء.
  function poAmeenClampNavIndex(count, index, direction) {
    const total = Math.max(0, Number(count) || 0);
    if (total === 0) return 0;
    const current = Number.isFinite(Number(index)) ? Number(index) : 0;
    const next = current + (Number(direction) || 0);
    if (next < 0) return 0;
    if (next > total - 1) return total - 1;
    return next;
  }

  // بنود فاتورة مشتريات أمين مطابقة لنص بحث برقم المادة أو اسمها — بلا فلترة
  // إن كان البحث فارغاً (تُعرض كل البنود).
  function poAmeenItemMatches(query, items) {
    const list = Array.isArray(items) ? items : [];
    const raw = String(query || "").trim();
    if (!raw) return list;
    const normalizedQuery = poNormalizeSearchText(raw);
    return list.filter((item) => {
      const numText = String((item && item.itemNumber) ?? "").trim();
      const nameNorm = poNormalizeSearchText((item && item.itemName) || "");
      return numText.includes(raw) || nameNorm.includes(normalizedQuery);
    });
  }

  function poAmeenPositiveFactor(value) {
    const factor = Number(value);
    return Number.isFinite(factor) && factor > 1 ? factor : 0;
  }

  function poAmeenCatalogCodes(row) {
    if (!row) return [];
    return [
      row.itemNumber,
      row.itemCode,
      row.item_number,
      row.item_code,
      row.number
    ].map((value) => String(value || "").trim()).filter(Boolean);
  }

  function poAmeenCatalogName(row) {
    return poNormalizeSearchText((row && (row.itemName || row.name || row.item_name)) || "");
  }

  // معامل الكرتونة من سطر التقرير إن وُجد، وإلا من كتالوج بترقيم الأمين ثم
  // بالاسم المطابق الوحيد. لا تخمين لمعامل 50 — غياب المعامل يُبقي العرض بالكروز.
  function poAmeenResolveUnit2Factor(item, catalogs) {
    const direct = poAmeenPositiveFactor(item && (item.unit2Factor ?? item.unit2_factor));
    if (direct) return direct;
    const list = Array.isArray(catalogs) ? catalogs : [];
    const num = String((item && item.itemNumber) || "").trim();
    const nameNorm = poNormalizeSearchText((item && item.itemName) || "");
    const uniqueFactors = (rows) => {
      const factors = [];
      rows.forEach((row) => {
        const factor = poAmeenPositiveFactor(row && (row.unit2Factor ?? row.unit2_factor));
        if (factor && !factors.includes(factor)) factors.push(factor);
      });
      return factors;
    };
    if (num) {
      const byNum = uniqueFactors(list.filter((row) => poAmeenCatalogCodes(row).includes(num)));
      if (byNum.length === 1) return byNum[0];
    }
    if (nameNorm) {
      const byName = uniqueFactors(list.filter((row) => poAmeenCatalogName(row) === nameNorm));
      if (byName.length === 1) return byName[0];
    }
    return 1;
  }

  function poAmeenFormatQty(value) {
    if (value == null || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const rounded = Math.round((number + Number.EPSILON) * 1000) / 1000;
    return String(Object.is(rounded, -0) ? 0 : rounded);
  }

  function poAmeenFormatPrice(value) {
    if (value == null || value === "") return "—";
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return number.toFixed(2);
  }

  // كمية الأمين وتكلفة الوحدة الأساسية مخزَّنتان بالكروز. العرض المطلوب للكرتونة:
  // الكمية ÷ المعامل، وآخر/متوسط التكلفة × المعامل. المعامل ≤ 1 يُبقي القيم كما وصلت.
  function poAmeenCartonDisplay(item, unit2Factor, labels) {
    const factor = poAmeenPositiveFactor(unit2Factor);
    const qty = item && item.qty != null && item.qty !== "" ? Number(item.qty) : null;
    const lastPrice = item && item.lastPrice != null && item.lastPrice !== "" ? Number(item.lastPrice) : null;
    const avgPrice = item && item.avgPrice != null && item.avgPrice !== "" ? Number(item.avgPrice) : null;
    const rawUnit = String((item && item.unit) || "").trim();
    const unit1Name = String((labels && labels.unit1Name) || "كروز").trim() || "كروز";
    const unit2Name = String((labels && labels.unit2Name) || "كرتونة").trim() || "كرتونة";
    if (!factor) {
      return {
        converted: false,
        qtyText: poAmeenFormatQty(qty),
        qtyHint: "",
        unit: rawUnit || "—",
        lastPriceText: poAmeenFormatPrice(lastPrice),
        avgPriceText: poAmeenFormatPrice(avgPrice)
      };
    }
    const qtyCarton = qty != null && Number.isFinite(qty) ? qty / factor : null;
    const lastCarton = lastPrice != null && Number.isFinite(lastPrice) ? lastPrice * factor : null;
    const avgCarton = avgPrice != null && Number.isFinite(avgPrice) ? avgPrice * factor : null;
    const unit = /كرتون/.test(rawUnit) ? rawUnit : unit2Name;
    return {
      converted: true,
      qtyText: poAmeenFormatQty(qtyCarton),
      qtyHint: qty != null && Number.isFinite(qty) ? `${poAmeenFormatQty(qty)} ${unit1Name}` : "",
      unit,
      lastPriceText: poAmeenFormatPrice(lastCarton),
      avgPriceText: poAmeenFormatPrice(avgCarton)
    };
  }

  root.poCalc = {
    poToEnglishDigits,
    poNormalizeNumeric,
    poToNumber,
    poRound2,
    poRowComputed,
    poTotals,
    poRemainingState,
    poValidatePayment,
    poItemDisplayLabel,
    poNextRowAfterQueryInput,
    poHasUnselectedEntry,
    poDedupeLines,
    poCanTransitionStatus,
    PO_STATUS_RANK,
    PO_STATUS_LABELS,
    poNormalizeSearchText,
    poAmeenSupplierMatches,
    poAmeenClampNavIndex,
    poAmeenItemMatches,
    poAmeenResolveUnit2Factor,
    poAmeenCartonDisplay
  };
})(typeof window !== "undefined" ? window : globalThis);
