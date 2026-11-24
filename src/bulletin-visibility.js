// ============================================================================
// ظهور الأصناف في نشرة الأسعار الموجهة للزبائن — منطق نقي واحد يستعمله الموقع
// (src/app.js) ومولّد النشرات (scripts/generate-price-lists.mjs) معاً.
//
// الحالة الافتراضية لكل صنف: ظاهر. سطر في item_bulletin_visibility (بمعرّف
// الأمين GUID) هو الاستثناء الوحيد الممكن: الصنف مخفي عن الزبائن. إظهار الصنف
// يحذف السطر فيعود للحالة الافتراضية — بلا قيمتين متقابلتين تحتاجان تمييزاً.
//
// المطابقة بالـGUID أولاً، تماماً كما في bulletin-classification.js. المفتاح
// (item_key) احتياط لصف لا يحمل GUID أصلاً (نافذة المولّد العامة، لأن
// available_price_sync_feed لا تكشف item_guid).
//
// لا شيء هنا يقرأ الأمين أو يكتب فيه، ولا يغيّر سعراً أو كميةً أو مخزوناً.
// التوثيق: docs/ai/topics/price-bulletins.md
// ============================================================================
(function () {
  "use strict";

  const classification =
    (typeof window !== "undefined" && window.ozkBulletinClassification) ||
    (typeof globalThis !== "undefined" && globalThis.ozkBulletinClassification);
  if (!classification) {
    throw new Error("src/bulletin-classification.js لم يُحمَّل قبل src/bulletin-visibility.js");
  }
  const { normalizeGuid, normalizeName } = classification;

  function itemGuidOf(item) {
    return normalizeGuid(item && (item.itemGuid ?? item.item_guid ?? item.guid));
  }

  function itemKeyOf(item) {
    if (!item) return "";
    return normalizeName(item.itemKey ?? item.item_key ?? item.key ?? item.name ?? item.itemName ?? item.item_name ?? "");
  }

  // يبني فهرس الأصناف المخفية. `rows` صفوف Supabase (item_guid/item_key...) أو
  // صفوف نافذة المولّد العامة (item_key فقط بلا GUID).
  function buildHiddenIndex(rows) {
    const byGuid = new Set();
    const byKey = new Set();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row) return;
      const guid = normalizeGuid(row.itemGuid ?? row.item_guid);
      if (guid) byGuid.add(guid);
      const key = normalizeName(row.itemKey ?? row.item_key ?? "");
      if (key) byKey.add(key);
    });
    return { byGuid, byKey };
  }

  function isHiddenItem(item, index) {
    const idx = index || { byGuid: new Set(), byKey: new Set() };
    const guid = itemGuidOf(item);
    if (guid) return idx.byGuid.has(guid);
    return idx.byKey.has(itemKeyOf(item));
  }

  const api = Object.freeze({
    VERSION: 1,
    buildHiddenIndex,
    isHiddenItem
  });

  if (typeof window !== "undefined") window.ozkBulletinVisibility = api;
  if (typeof globalThis !== "undefined") globalThis.ozkBulletinVisibility = api;
})();
