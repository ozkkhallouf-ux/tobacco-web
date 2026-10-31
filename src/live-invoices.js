// ============================================================================
// الفواتير الفورية — دمج جدول `ameen_invoices` مع تقرير `ameen_customer_invoices`.
// منطق نقي (Pure): لا شبكة ولا DOM ولا كتابة على أي جدول.
//
// القرار (طلب المالك 2026-10-31): كل فاتورة جديدة أو معدّلة في الأمين تظهر على
// الموقع خلال ثوانٍ، مطابقة للأمين، بلا أي تعديل على الأسعار أو الأرصدة أو الحسابات.
//
// المصدران:
//   • التقرير القديم ameen_customer_invoices (tools/push-customer-invoices.ps1): لقطة
//     كاملة لـ60 يوماً كل بضع دقائق، بأسماء المواد ووحداتها من mt000.
//   • الجدول الفوري ameen_invoices (tools/ameen-invoice-event-agent.ps1 بـ -Send): آخر
//     حالة لكل فاتورة خلال ثوانٍ من حفظها في الأمين، لكن بلا أسماء مواد ولا وحدات.
//
// القواعد (كل واحدة تمنع خطأً محاسبياً محدداً):
//   1) الأحدث يفوز لكل فاتورة: صف فوري أحدث من لقطة التقرير (بهامش قراءة التقرير)
//      يحلّ محلّ نسخة التقرير، أو يضيفها إن كانت جديدة، أو يحذفها إن حُذفت. صف أقدم
//      من اللقطة لا يُستعمل — الوكيل ربما توقّف والتقرير يرى ما بعده.
//   2) أسماء المواد ووحداتها تُحلّ بـ item_guid: من أسطر التقرير نفسه (mt000) أولاً،
//      ثم من لائحة الأسعار. لا تخمين بالاسم.
//   3) التحقق الحسابي إلزامي: Σ(السعر × الكمية ÷ معامل وحدة الإدخال) يجب أن يساوي
//      إجمالي الفاتورة (bu000.Total) حرفياً ضمن 0.01. أي سطر لا تُحلّ مادته أو وحدته،
//      أو مجموع لا يطابق، يُسقط النسخة الفورية كلها وتبقى نسخة التقرير كما هي.
//   4) نفس شروط التقرير: فواتير بيع/مرتجع (1/3) باسم زبون، داخل نافذة التقرير.
//   5) الهوية customer_guid (u.CustGUID = cu000.GUID، نفس معرّف التقرير).
// ============================================================================
(function () {
  "use strict";

  const VERSION = 1;
  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  // التقرير يقرأ الأمين ثم يرفع؛ تعديل يقع بين القراءة والرفع يحمل وقتاً أقدم من
  // syncedAt وهو غير موجود في اللقطة. الهامش يجعل الصف الفوري يفوز في هذه النافذة.
  const REPORT_READ_MARGIN_MS = 10 * 60 * 1000;
  const TOTAL_TOLERANCE = 0.01;

  function normGuid(value) {
    const g = String(value ?? "").trim().toLowerCase();
    return !g || g === ZERO_GUID ? "" : g;
  }

  function num(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function round3(value) {
    return Math.round(Number(value || 0) * 1000) / 1000;
  }

  function timeMs(value) {
    const t = new Date(value || "").getTime();
    return Number.isFinite(t) ? t : null;
  }

  // دليل المواد: item_guid ← { material, unit1, unit2, unit2Fact, unit3, unit3Fact }.
  // أسطر التقرير أولاً (مأخوذة من mt000 مباشرة)، ولائحة الأسعار احتياطاً للمواد
  // التي لم تُبَع خلال نافذة التقرير. لائحة الأسعار لا تحمل وحدة ثالثة.
  function buildItemCatalog(report, priceItems) {
    const catalog = new Map();
    const entries = Array.isArray(report?.items) ? report.items : [];
    for (const entry of entries) {
      for (const inv of Array.isArray(entry?.invoices) ? entry.invoices : []) {
        for (const line of Array.isArray(inv?.lines) ? inv.lines : []) {
          const g = normGuid(line?.itemGuid);
          if (!g || catalog.has(g)) continue;
          catalog.set(g, {
            material: String(line?.material || "").trim(),
            unit1: String(line?.unit1 || "").trim(),
            unit2: String(line?.unit2 || "").trim(),
            unit2Fact: Number(line?.unit2Fact || 0),
            unit3: String(line?.unit3 || "").trim(),
            unit3Fact: Number(line?.unit3Fact || 0)
          });
        }
      }
    }
    for (const item of Array.isArray(priceItems) ? priceItems : []) {
      const g = normGuid(item?.item_guid ?? item?.itemGuid);
      if (!g || catalog.has(g)) continue;
      catalog.set(g, {
        material: String(item?.item_name ?? item?.itemName ?? "").trim(),
        unit1: String(item?.unit1_name ?? item?.unit1Name ?? "").trim(),
        unit2: String(item?.unit2_name ?? item?.unit2Name ?? "").trim(),
        unit2Fact: Number(item?.unit2_factor ?? item?.unit2Factor ?? 0),
        unit3: "",
        unit3Fact: 0
      });
    }
    return catalog;
  }

  // عملة الفاتورة: الجدول الفوري يحمل currency_val لا رمز العملة. الرمز يُستنتج من
  // التقرير نفسه: الرمز الوحيد بمعدّل 1 (عملة الأساس) والرمز الوحيد بمعدّل ≠ 1.
  // بلا تقرير يُحسم: USD/SYP (العملتان الوحيدتان في بيانات المشروع). أكثر من رمز
  // بمعدّل ≠ 1 يعني أن الاستنتاج غير قاطع، فتُرفض الفواتير الأجنبية الفورية.
  function currencyResolver(report) {
    const base = new Set();
    const foreign = new Set();
    for (const entry of Array.isArray(report?.items) ? report.items : []) {
      for (const inv of Array.isArray(entry?.invoices) ? entry.invoices : []) {
        const iso = String(inv?.currency || "").trim().toUpperCase();
        if (!iso) continue;
        const val = num(inv?.currencyVal);
        if (val === 1) base.add(iso); else if (val !== null && val > 0) foreign.add(iso);
      }
    }
    const baseIso = base.size === 1 ? [...base][0] : base.size === 0 ? "USD" : null;
    const foreignIso = foreign.size === 1 ? [...foreign][0] : foreign.size === 0 ? "SYP" : null;
    return (val) => {
      if (val === null || val === 1) return baseIso;
      if (val > 0) return foreignIso;
      return null;
    };
  }

  // يحوّل صفاً فورياً إلى شكل فاتورة التقرير بالضبط، أو يعيد { error } بسبب الرفض.
  function liveRowToInvoice(row, catalog, currencyOf) {
    const p = row?.payload && typeof row.payload === "object" ? row.payload : null;
    if (!p) return { error: "no_payload" };
    const billType = Number(p.bill_type ?? row.bill_type);
    if (billType !== 1 && billType !== 3) return { error: "bill_type" };
    const customerName = String(p.customer_name || "").trim();
    if (!customerName) return { error: "unnamed" };
    const total = num(p.total);
    if (total === null) return { error: "no_total" };
    const currencyVal = num(p.currency_val);
    const currency = currencyOf(currencyVal);
    if (!currency) return { error: "currency" };

    const lines = [];
    let sum = 0;
    for (const raw of Array.isArray(p.lines) ? p.lines : []) {
      const itemGuid = normGuid(raw?.item_guid);
      const info = itemGuid ? catalog.get(itemGuid) : null;
      if (!info || !info.material) return { error: "unknown_item" };
      const unity = Number(raw?.unity);
      const qty = num(raw?.qty) ?? 0;
      const price = num(raw?.price) ?? 0;
      let factor = null;
      if (unity === 1) factor = 1;
      else if (unity === 2 && info.unit2 && info.unit2Fact > 0) factor = info.unit2Fact;
      else if (unity === 3 && info.unit3 && info.unit3Fact > 0) factor = info.unit3Fact;
      if (!factor) return { error: "unit" };
      const value = price * qty / factor;
      sum += value;
      const f2 = info.unit2Fact;
      lines.push({
        itemGuid,
        material: info.material,
        qty: round3(qty),
        qtyUnits: f2 > 0 ? round3(qty / f2) : round3(qty),
        price: round3(price),
        lineTotal: round3(value),
        // القيمة محسوبة هنا لا مقروءة من عمود إجمالي؛ inputUnit الصريح يجعلها غير
        // مستعملة في الموقع أصلاً، والعلامة تمنع أي مسار احتياطي من الوثوق بها.
        lineTotalSource: "derived",
        unit1: info.unit1,
        unit2: info.unit2,
        unit2Fact: f2,
        unit3: info.unit3,
        unit3Fact: info.unit3Fact,
        inputUnit: unity
      });
    }
    if (!lines.length) return { error: "no_lines" };
    if (Math.abs(sum - total) > TOTAL_TOLERANCE) return { error: "total_mismatch" };

    const date = String(p.bill_date || row.bill_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "date" };
    const number = p.number ?? row.bill_number;
    return {
      invoice: {
        number: number === null || number === undefined ? "" : String(number),
        date,
        customerGuid: normGuid(p.customer_guid ?? row.customer_guid),
        currency,
        currencyVal: currencyVal === null ? 1 : currencyVal,
        guid: normGuid(p.bill_guid ?? row.bill_guid),
        total: round3(total),
        discount: round3(num(p.total_disc) ?? 0),
        payment: round3(num(p.first_pay) ?? 0),
        isReturn: billType === 3,
        lines,
        live: true
      },
      customerName
    };
  }

  // يدمج الصفوف الفورية في التقرير ويعيد تقريراً **جديداً** (هوية كائن جديدة كي
  // تُبطل كل ذاكرة مؤقتة مربوطة بالتقرير) أو التقرير نفسه إن لم يتغيّر شيء.
  //   options.priceItems   : صفوف approved_price_items (احتياط أسماء المواد)
  //   options.balanceItems : عناصر تقرير الأرصدة (اسم الحساب الرسمي بالمعرّف)
  function mergeLiveInvoices(report, liveRows, options = {}) {
    const rows = Array.isArray(liveRows) ? liveRows : [];
    const stats = { applied: 0, added: 0, replaced: 0, removed: 0, olderThanReport: 0, outOfWindow: 0, rejected: {} };
    if (!rows.length) return { report, stats };

    const syncedMs = timeMs(report?.summary?.syncedAt || report?.created_at);
    const cutoffMs = syncedMs === null ? null : syncedMs - REPORT_READ_MARGIN_MS;
    const fromDate = String(report?.summary?.fromDate || "").slice(0, 10);
    const catalog = buildItemCatalog(report, options.priceItems);
    const currencyOf = currencyResolver(report);

    const nameByGuid = new Map();
    for (const b of Array.isArray(options.balanceItems) ? options.balanceItems : []) {
      const g = normGuid(b?.customerGuid);
      const n = String(b?.name || "").trim();
      if (g && n && !nameByGuid.has(g)) nameByGuid.set(g, n);
    }

    // آخر حالة لكل فاتورة فقط (الصفوف في الجدول فريدة بالمعرّف، والفرز احتياط).
    const latest = new Map();
    for (const row of rows) {
      const g = normGuid(row?.bill_guid);
      if (!g) continue;
      const prev = latest.get(g);
      if (!prev || Number(row?.source_seq || 0) > Number(prev?.source_seq || 0)) latest.set(g, row);
    }

    // نسخة عميقة للمستوى المعدَّل فقط: المجموعات والقوائم، لا الأسطر.
    const entries = (Array.isArray(report?.items) ? report.items : []).map((entry) => ({
      ...entry,
      invoices: Array.isArray(entry?.invoices) ? entry.invoices.slice() : []
    }));
    const locate = new Map();
    entries.forEach((entry, ei) => entry.invoices.forEach((inv, ii) => {
      const g = normGuid(inv?.guid);
      if (g) locate.set(g, { ei, ii });
    }));
    const removals = [];

    for (const [guid, row] of latest) {
      const eventMs = timeMs(row?.source_event_at);
      if (cutoffMs !== null && (eventMs === null || eventMs < cutoffMs)) { stats.olderThanReport += 1; continue; }
      const where = locate.get(guid);

      if (String(row?.status || "") === "deleted") {
        if (where) { removals.push(where); stats.removed += 1; stats.applied += 1; }
        continue;
      }
      const date = String(row?.bill_date || row?.payload?.bill_date || "").slice(0, 10);
      if (fromDate && date && date < fromDate) { stats.outOfWindow += 1; continue; }

      const result = liveRowToInvoice(row, catalog, currencyOf);
      if (result.error) {
        stats.rejected[result.error] = (stats.rejected[result.error] || 0) + 1;
        continue;
      }
      const invoice = result.invoice;
      stats.applied += 1;
      if (where) {
        const entry = entries[where.ei];
        if (normGuid(entry.customerGuid) && invoice.customerGuid && normGuid(entry.customerGuid) !== invoice.customerGuid) {
          // الفاتورة نُقلت لزبون آخر: تُحذف من مجموعة الأول وتُضاف لمجموعة الثاني.
          removals.push(where);
          addToCustomer(entries, invoice, result.customerName, nameByGuid);
        } else {
          entry.invoices[where.ii] = invoice;
        }
        stats.replaced += 1;
      } else {
        addToCustomer(entries, invoice, result.customerName, nameByGuid);
        stats.added += 1;
      }
    }

    if (!stats.applied) return { report, stats };

    const drop = new Set(removals.map((w) => `${w.ei}:${w.ii}`));
    const items = entries
      .map((entry, ei) => ({ ...entry, invoices: entry.invoices.filter((_, ii) => !drop.has(`${ei}:${ii}`)) }))
      .filter((entry) => entry.invoices.length)
      .map((entry) => (entry.liveTouched ? { ...entry, invoices: sortInvoices(entry.invoices) } : entry))
      .map(({ liveTouched, ...entry }) => entry);
    const bills = items.reduce((n, entry) => n + entry.invoices.length, 0);
    const merged = {
      ...(report || { source: "ameen_customer_invoices" }),
      items,
      summary: {
        ...(report?.summary || {}),
        customers: items.length,
        bills,
        liveInvoices: stats.applied,
        liveVersion: VERSION
      }
    };
    return { report: merged, stats };
  }

  function addToCustomer(entries, invoice, customerName, nameByGuid) {
    const g = invoice.customerGuid;
    let entry = g ? entries.find((e) => normGuid(e?.customerGuid) === g) : null;
    if (!entry && !g) {
      const n = customerName.toLowerCase();
      entry = entries.find((e) => !normGuid(e?.customerGuid) && String(e?.name || "").trim().toLowerCase() === n) || null;
    }
    if (!entry) {
      entry = {
        name: (g && nameByGuid.get(g)) || customerName,
        customerGuid: g,
        customerAccountGuid: "",
        invoices: [],
        truncated: false
      };
      entries.push(entry);
    }
    entry.invoices.push(invoice);
    entry.liveTouched = true;
  }

  // نفس ترتيب التقرير: الأحدث تاريخاً أولاً، ثم الرقم الأكبر.
  function sortInvoices(list) {
    return list.slice().sort((a, b) => {
      const d = String(b?.date || "").localeCompare(String(a?.date || ""));
      if (d) return d;
      return Number(b?.number || 0) - Number(a?.number || 0);
    });
  }

  // أقدم وقت حدث يحتاجه الموقع من الجدول الفوري: ما بعد لقطة التقرير بهامشها.
  function liveFetchSince(report, nowMs) {
    const syncedMs = timeMs(report?.summary?.syncedAt || report?.created_at);
    // بلا تقرير: آخر 24 ساعة فقط (الجدول الفوري لا يغني عن لقطة الـ60 يوماً).
    const since = syncedMs === null
      ? (Number.isFinite(nowMs) ? nowMs : Date.now()) - 24 * 60 * 60 * 1000
      : syncedMs - REPORT_READ_MARGIN_MS;
    return new Date(since).toISOString();
  }

  const api = Object.freeze({
    VERSION,
    REPORT_READ_MARGIN_MS,
    TOTAL_TOLERANCE,
    buildItemCatalog,
    liveRowToInvoice,
    mergeLiveInvoices,
    liveFetchSince
  });

  if (typeof window !== "undefined") window.ozkLiveInvoices = api;
  if (typeof globalThis !== "undefined") globalThis.ozkLiveInvoices = api;
})();
