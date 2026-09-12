(function () {
  // ============================================================================
  // طبقة الالتزامات المالية للموردين.
  //
  // عقدها الصارم: هذه الطبقة **تغذّي** لوحة القرار برصيد أمين، ولا تملك أبداً
  // صلاحية محو ما رسمه المحرّك. النسخة السابقة كانت تستبدل tbody في كل حالة —
  // فحين فرغ جدول supplier_obligations محت عشرين مورداً حقيقياً وأحلّت مكانهم
  // رسالة «لا يوجد رصيد مستحق»، وهي رسالة عن الالتزام لا عن الموردين.
  //
  // الآن: النتيجة تُنشر في window.ozkSupplierObligations ويعيد المحرّك الرسم
  // بنفسه. لا كتابة مباشرة في DOM القسم إطلاقاً.
  // ============================================================================

  const REFRESH_MS = 60 * 1000;
  let inFlight = false;
  let lastSignature = null;

  function sameRows(rows) {
    const signature = JSON.stringify((rows || []).map((row) => [
      row.supplier_key || row.supplierKey || "",
      row.supplier_name || row.supplierName || "",
      row.amount_due ?? row.amountDue ?? null,
      row.currency || ""
    ]));
    if (signature === lastSignature) return true;
    lastSignature = signature;
    return false;
  }

  function normalize(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      supplierKey: row.supplier_key ?? row.supplierKey ?? "",
      supplierGuid: row.supplier_key ?? row.supplierGuid ?? "",
      supplierName: row.supplier_name ?? row.supplierName ?? "مورد",
      amountDue: Number(row.amount_due ?? row.amountDue ?? 0) || 0,
      currency: row.currency || "",
      supplyRisk: String(row.supply_risk ?? row.supplyRisk ?? "normal").toLowerCase(),
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
      source: row.source ?? ""
    }));
  }

  async function refreshSupplierObligations() {
    if (inFlight) return;
    if (typeof state !== "undefined" && state?.route !== "decision") return;
    const client = window.supplierObligationsData;
    if (!client?.listSupplierObligations) return;

    inFlight = true;
    try {
      const rows = await client.listSupplierObligations();
      // جدول فارغ حقيقة تُسجَّل، لا سبباً لمسح شيء: المحرّك يسقط عندها إلى
      // التزامات تقرير فواتير الشراء ويبقي أولوية الشراء كما هي.
      window.ozkSupplierObligations = normalize(rows);
      window.ozkSupplierObligationsState = {
        loaded: true,
        count: window.ozkSupplierObligations.length,
        at: new Date().toISOString(),
        error: null
      };
      if (!sameRows(rows) && typeof render === "function" && state?.route === "decision") render();
    } catch (error) {
      // الفشل لا يُفرِّغ آخر نسخة صالحة ولا يمسّ العرض — يُسجَّل فقط.
      window.ozkSupplierObligationsState = {
        loaded: Array.isArray(window.ozkSupplierObligations),
        count: Array.isArray(window.ozkSupplierObligations) ? window.ozkSupplierObligations.length : 0,
        at: new Date().toISOString(),
        error: String(error?.message || error)
      };
      console.error("[OZK Supplier Obligations]", error);
    } finally {
      inFlight = false;
    }
  }

  window.ozkRefreshSupplierObligations = refreshSupplierObligations;

  setTimeout(refreshSupplierObligations, 0);
  setInterval(refreshSupplierObligations, REFRESH_MS);
})();
