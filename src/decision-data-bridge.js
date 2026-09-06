(function () {
  // ============================================================================
  // جسر بين خدمة البيانات ولوحة القرار.
  //
  // كان يطابق الأسعار المعتمدة بلقطة الأمين عبر `itemKey` أولاً — و`item_key`
  // في `approved_price_items` يحمل **اسم الصنف بالعربية**، بينما يحمله في
  // `ameen_item_snapshot` **GUID**. فلا يتقاطع المفتاحان في أي صف، وكان الجسر
  // يسقط دائماً إلى المطابقة بالاسم: هوية هشّة أمام الهمزة والتاء المربوطة
  // وإعادة التسمية في الأمين.
  //
  // الآن: المعرّف هو الهوية، والاسم مطابقة احتياطية لا تُستعمل إلا حين يغيب
  // المعرّف تماماً — وتُلغى إذا كان الاسم مكرراً في اللقطة، فلا يرث صنفٌ حركة
  // صنفٍ آخر يشبهه اسماً.
  // ============================================================================

  function scoring() {
    return (typeof window !== "undefined" && window.ozkDecisionScoring) || null;
  }

  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function toGuid(value) {
    const api = scoring();
    if (api?.toGuid) return api.toGuid(value);
    const text = String(value ?? "").trim().toLowerCase();
    return !text || text === ZERO_GUID || !GUID_PATTERN.test(text) ? "" : text;
  }

  function normalizedName(value) {
    const api = scoring();
    if (api?.normalizedName) return api.normalizedName(value);
    return String(value ?? "").trim().toLowerCase()
      .replace(/[أإآٱ]/gu, "ا").replace(/ة/gu, "ه").replace(/[ً-ْـ]/gu, "");
  }

  function finiteOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function buildIndex(rows) {
    const api = scoring();
    if (api?.buildSnapshotIndex) return api.buildSnapshotIndex(rows);
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

  function findSnapshot(index, item) {
    const api = scoring();
    if (api?.findSnapshot) return api.findSnapshot(index, item);
    const guid = toGuid(item?.itemGuid ?? item?.item_guid) || toGuid(item?.itemKey ?? item?.item_key);
    if (guid) return index.byGuid.get(guid) || null;
    const name = normalizedName(item?.itemName ?? item?.item_name);
    if (!name || index.nameCollisions.has(name)) return null;
    return index.byName.get(name) || null;
  }

  function installBridge() {
    const service = window.tobaccoData;
    if (!service || service.__decisionSnapshotBridgeInstalled) return Boolean(service);
    if (typeof service.listItemSnapshots !== "function") return false;

    const originalListItemSnapshots = service.listItemSnapshots.bind(service);
    const originalListApprovedPriceItems =
      typeof service.listApprovedPriceItems === "function"
        ? service.listApprovedPriceItems.bind(service)
        : null;

    // الاسم الذي يستعمله محرّك القرار.
    if (typeof service.listAmeenItemSnapshot !== "function") {
      service.listAmeenItemSnapshot = originalListItemSnapshots;
    }

    // يمرّر مخزون الأمين وحركة الثلاثين يوماً إلى محرّك القرار مع الحفاظ على
    // بيانات سعر البيع المعتمد. المخزون والحركة يأتيان من اللقطة نفسها كي لا
    // يُخلط مخزونُ تاريخٍ بحالةِ تاريخٍ آخر.
    if (originalListApprovedPriceItems) {
      service.listApprovedPriceItems = async function listApprovedPriceItemsWithLiveSnapshot() {
        const [approvedResult, snapshotResult] = await Promise.allSettled([
          originalListApprovedPriceItems(),
          originalListItemSnapshots()
        ]);

        if (approvedResult.status !== "fulfilled") throw approvedResult.reason;
        const approved = Array.isArray(approvedResult.value) ? approvedResult.value : [];
        if (snapshotResult.status !== "fulfilled") return approved;

        const snapshots = Array.isArray(snapshotResult.value) ? snapshotResult.value : [];
        const index = buildIndex(snapshots);

        return approved.map((item) => {
          const snapshot = findSnapshot(index, item);
          if (!snapshot) return item;

          const stock = finiteOrNull(snapshot.stockUnit1 ?? snapshot.stock_unit1);
          const sold30d = finiteOrNull(snapshot.unitsSold30d ?? snapshot.units_sold_30d);

          return {
            ...item,
            ...(stock !== null ? { stockQty: stock, stock_qty: stock } : {}),
            ...(sold30d !== null ? { unitsSold30d: sold30d, units_sold_30d: sold30d } : {}),
            ameenSnapshotGeneratedAt: snapshot.generatedAt || snapshot.generated_at || "",
            ameenLastSaleDate: snapshot.lastSaleDate || snapshot.last_sale_date || "",
            ameenLastPurchaseDate: snapshot.lastPurchaseDate || snapshot.last_purchase_date || "",
            ameenLastPurchasePrice: snapshot.lastPurchasePrice ?? snapshot.last_purchase_price ?? null,
            ameenLastSupplierName: snapshot.lastSupplierName || snapshot.last_supplier_name || "",
            ameenLastSupplierGuid: snapshot.lastSupplierGuid || snapshot.last_supplier_guid || ""
          };
        });
      };
    }

    service.__decisionSnapshotBridgeInstalled = true;
    return true;
  }

  if (!installBridge()) {
    window.addEventListener("DOMContentLoaded", installBridge, { once: true });
  }
})();
