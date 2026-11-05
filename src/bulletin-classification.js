// ============================================================================
// تصنيف الأصناف بين «النشرة العامة» و«الوزاري» — منطق نقي واحد يستعمله الموقع
// (src/app.js) ومولّد النشرات (scripts/generate-price-lists.mjs) معاً.
//
// ترتيب الحكم (الأعلى يغلب):
//   1) تصحيح المالك المحفوظ في Supabase (item_bulletin_classifications، بالـGUID).
//   2) تصحيح مؤكد بمعرّف الأمين مثبّت هنا (CONFIRMED_OVERRIDES).
//   3) قاعدة الاسم التاريخية (nameRuleBulletin) — احتياط لكل ما لم يُصحَّح.
//
// المطابقة بالـGUID أولاً. المطابقة بالمفتاح (item_key) لا تُستعمل إلا لصف لا
// يحمل GUID أصلاً (نافذة النشرة العامة available_price_sync_feed بلا GUID)، ولا
// تُطبَّق أبداً على صف يحمل GUID مختلفاً: صنفان باسم واحد لا يرث أحدهما تصحيح الآخر.
//
// لا شيء هنا يقرأ الأمين أو يكتب فيه، ولا يغيّر سعراً.
// التوثيق: docs/ai/topics/price-bulletins.md
// ============================================================================
(function () {
  "use strict";

  const GENERAL = "general";
  const WAZARI = "wazari";
  const BULLETINS = Object.freeze([GENERAL, WAZARI]);
  const LABELS = Object.freeze({ [GENERAL]: "النشرة العامة", [WAZARI]: "الوزاري" });
  const SOURCES = Object.freeze({
    OWNER: "owner_override",
    CONFIRMED: "confirmed_override",
    NAME_RULE: "name_rule"
  });

  // تصحيحات مؤكدة بمعرّف الأمين (mt000.GUID) ورقم المادة، لا بالاسم.
  // المصدر: آخر جرد الأمين (ameen_sql_agent) وتقرير تفاصيل المواد (ameen_item_details)
  // في Supabase بتاريخ 2026-11-05 — اسم واحد لكل GUID ولا تكرار.
  const CONFIRMED_OVERRIDES = Object.freeze([
    Object.freeze({
      itemGuid: "294A7DC9-9BB3-4BEF-8791-F3C336AFD727",
      itemNumber: "463",
      itemKey: "وينستون ازرق مخصص",
      bulletin: GENERAL,
      reason: "صنف عام أُدخل بفاتورة شراء؛ قاعدة الاسم «وينستون بلا حرة» صنّفته وزاري خطأً (طلب عمر 2026-11-05)"
    }),
    Object.freeze({
      itemGuid: "B29EB8C3-A1FE-4FEB-A18A-30E26189FDA2",
      itemNumber: "464",
      itemKey: "وينستون فضي مخصص",
      bulletin: GENERAL,
      reason: "صنف عام أُدخل بفاتورة شراء؛ قاعدة الاسم «وينستون بلا حرة» صنّفته وزاري خطأً (طلب عمر 2026-11-05)"
    })
  ]);

  // مطابق لـ normalizeItemName في src/app.js (الفحص يقارن النتائج).
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
    const guid = String(value ?? "").trim().replace(/^\{|\}$/g, "").toUpperCase();
    return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(guid) ? guid : "";
  }

  function isBulletin(value) {
    return value === GENERAL || value === WAZARI;
  }

  // قاعدة الاسم التاريخية كما كانت حرفياً في app.js والمولّد قبل هذا الملف.
  function nameRuleBulletin(rawName) {
    const name = normalizeName(rawName);
    if (name.includes("نخله") && (name.includes("محزر") || name.includes("وزاري"))) return WAZARI;
    if (name.includes("كينت") && !name.includes("حره")) return WAZARI;
    if (name.includes("وينستون") && !name.includes("حره")) return WAZARI;
    if (name.includes("فاخر") && name.includes("اسود") && name.includes("محزر")) return WAZARI;
    if (
      name.includes("مالبورو") &&
      (name.includes("محزر") ||
        (name.includes("ورق") && (name.includes("ابيض") || name.includes("احمر"))) ||
        (name.includes("كوين") && name.includes("ازرق")))
    ) return WAZARI;
    return GENERAL;
  }

  function itemGuidOf(item) {
    return normalizeGuid(item && (item.itemGuid ?? item.item_guid ?? item.guid));
  }

  function itemKeyOf(item) {
    if (!item) return "";
    return normalizeName(item.itemKey ?? item.item_key ?? item.key ?? item.name ?? item.itemName ?? item.item_name ?? "");
  }

  function itemNameOf(item) {
    if (!item) return "";
    return String(item.name ?? item.itemName ?? item.item_name ?? item.itemKey ?? item.item_key ?? item.key ?? "");
  }

  const AMBIGUOUS = Object.freeze({ ambiguous: true });

  // يبني فهرس التصحيحات. `ownerRows` صفوف Supabase (item_guid/bulletin...) أو صفوف
  // النافذة العامة (item_key/bulletin بلا GUID). تصحيح المالك يغلب المثبّت هنا.
  function buildOverrideIndex(ownerRows) {
    const byGuid = new Map();
    const byKey = new Map();
    const put = (row, source) => {
      const bulletin = String(row.bulletin || "").trim();
      if (!isBulletin(bulletin)) return;
      const entry = {
        bulletin,
        source,
        itemGuid: normalizeGuid(row.itemGuid ?? row.item_guid),
        itemKey: normalizeName(row.itemKey ?? row.item_key ?? ""),
        itemNumber: String(row.itemNumber ?? row.item_number ?? ""),
        itemName: String(row.itemName ?? row.item_name ?? ""),
        reason: String(row.reason ?? ""),
        updatedAt: row.updatedAt ?? row.updated_at ?? "",
        updatedByEmail: row.updatedByEmail ?? row.updated_by_email ?? ""
      };
      if (entry.itemGuid) byGuid.set(entry.itemGuid, entry);
      if (entry.itemKey) {
        // مفتاح يشير لأكثر من GUID مختلف ⇒ ملتبس: لا يُطبَّق بالمفتاح إطلاقاً.
        const previous = byKey.get(entry.itemKey);
        if (previous && previous !== AMBIGUOUS && previous.itemGuid && entry.itemGuid && previous.itemGuid !== entry.itemGuid) {
          byKey.set(entry.itemKey, AMBIGUOUS);
        } else if (previous !== AMBIGUOUS) {
          byKey.set(entry.itemKey, entry);
        }
      }
    };
    CONFIRMED_OVERRIDES.forEach((row) => put(row, SOURCES.CONFIRMED));
    (Array.isArray(ownerRows) ? ownerRows : []).forEach((row) => row && put(row, SOURCES.OWNER));
    return { byGuid, byKey };
  }

  let defaultIndex = null;
  function confirmedIndex() {
    if (!defaultIndex) defaultIndex = buildOverrideIndex([]);
    return defaultIndex;
  }

  // يرجع { bulletin, source, label, override? }.
  function classifyItem(item, index) {
    const idx = index || confirmedIndex();
    const guid = itemGuidOf(item);
    if (guid) {
      const hit = idx.byGuid.get(guid);
      if (hit) return { bulletin: hit.bulletin, source: hit.source, label: LABELS[hit.bulletin], override: hit };
    } else {
      const hit = idx.byKey.get(itemKeyOf(item));
      if (hit && hit !== AMBIGUOUS) return { bulletin: hit.bulletin, source: hit.source, label: LABELS[hit.bulletin], override: hit };
    }
    const bulletin = nameRuleBulletin(itemNameOf(item));
    return { bulletin, source: SOURCES.NAME_RULE, label: LABELS[bulletin] };
  }

  function isWazariItem(item, index) {
    return classifyItem(item, index).bulletin === WAZARI;
  }

  const api = Object.freeze({
    VERSION: 1,
    GENERAL,
    WAZARI,
    BULLETINS,
    LABELS,
    SOURCES,
    CONFIRMED_OVERRIDES,
    normalizeName,
    normalizeGuid,
    nameRuleBulletin,
    buildOverrideIndex,
    classifyItem,
    isWazariItem
  });

  if (typeof window !== "undefined") window.ozkBulletinClassification = api;
  if (typeof globalThis !== "undefined") globalThis.ozkBulletinClassification = api;
})();
