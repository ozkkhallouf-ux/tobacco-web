// ============================================================================
// أولوية تنبيهات النفاد حسب المبيعات — منطق نقي (Pure) بلا شبكة ولا DOM ولا كتابة.
//
// القرار (طلب المالك 2026-10-03): تنبيه تيليغرام «قاربت النفاد» يخص الأصناف
// المهمة وحدها. الأهمية = صافي الكمية المبيعة في آخر 30 يوماً من فواتير البيع:
// البيع ناقص المرتجع، بالكروز (bi000.Qty بالوحدة الأولى دائماً)، وتُعرض بالكرتونة.
//
// المصدر `ameen_item_sales` (tools/push-item-sales.ps1) يجمع **كل** فواتير البيع
// والمرتجع (BillType 1/3) لكل صنف، ومنها «مبيعات مركز» بلا اسم زبون. تقرير
// ameen_customer_invoices لا يصلح هنا لأنه يُسقط كل فاتورة بلا اسم زبون، فيُنقص
// مبيع أصناف الكاشير أو يصفّره (مراجعة Codex على PR #298).
//
// المدخلات صفوف `inventory_reports` كما هي (source/report_date/created_at/summary/items):
//   • تقرير المبيعات  ameen_item_sales  — صنف واحد لكل صف: saleQty، returnQty، saleInvoiceCount
//   • تقرير المخزون   ameen_sql_agent   (tools/ameen-sync-agent.ps1) — الرصيد الحي
//     المستبعِد لمستودع الامانة. لا يُقرأ approved_price_items.stock_qty لأنه لا
//     يتحدّث إلا عند عبور وحدة ثانية كاملة.
//
// المخرجات أوصاف رسائل فقط: { eventType, message, dedupeKey, cooldownMinutes }.
// الإرسال في scripts/stock-priority-alerts.mjs عبر notify_telegram (منع التكرار هناك).
// التوثيق: docs/ai/topics/stock-priority-alerts.md
// ============================================================================
(function () {
  "use strict";

  const VERSION = 1;

  // كل العتبات هنا. تغييرها يغيّر من يُنبَّه عليه — وثّق أي تعديل في الوثيقة.
  const CONFIG = Object.freeze({
    stockSource: "ameen_sql_agent",
    salesSource: "ameen_item_sales",
    // نافذة المبيعات: يوم المرجع (report_date المحلي لتقرير المبيعات) و29 يوماً قبله.
    // التقرير مجمَّع سلفاً، فنافذته (summary.windowDays/fromDate) يجب أن تطابقها بالضبط.
    windowDays: 30,
    // الأصناف المؤهلة: أعلى 20% من الأصناف المباعة (سقف للأعلى، وتُضم التعادلات
    // على الحد)، أو صافي مبيع أعلى من متوسط كل الأصناف المباعة — أيهما أوسع (اتحاد).
    topShare: 0.2,
    // أقل من 3 فواتير بيع مستقلة في النافذة ⇒ لا تنبيه أبداً.
    minSaleInvoices: 3,
    // «قارب النفاد»: نفد (رصيد ≤ 0)، أو يكفي ≤ 7 أيام بمعدل البيع اليومي،
    // أو رصيده ≤ حد bot_config.low_stock_threshold (بالكروز، أمر «حد التنبيه» في البوت).
    lowCoverageDays: 7,
    // المخزون: عتبة private.project_task_monitors نفسها (ameen-main 10).
    // المبيعات: المهمة كل 30 دقيقة (register-item-sales-task.ps1)، فثلاث دورات فائتة = قديم.
    maxAgeMinutes: Object.freeze({ stock: 10, sales: 90 }),
    // منع التكرار: نفس مجموعة الأصناف وحالاتها لا تُرسل مرتين خلال 6 ساعات.
    cooldownMinutes: 360,
    staleCooldownMinutes: 360,
    // notify_telegram يقتطع عند 3900 حرف؛ نقسّم قبله.
    maxMessageChars: 3500
  });

  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  const DAY_MS = 86400000;

  const finite = (value) => (value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
  const text = (value) => String(value ?? "").trim().replace(/\s+/gu, " ");

  // نفس تطبيع src/app.js (normalizeItemName بلا aliases) وsrc/customer-intelligence.js
  // وtools/ameen-sync-agent.ps1 (Normalize-ItemName). احتياط للربط فقط.
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
    const guid = text(value).toLowerCase().replace(/^\{|\}$/g, "");
    return guid && guid !== ZERO_GUID ? guid : "";
  }

  function dayNumber(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
    if (!match) return null;
    const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : null;
  }

  function dayString(day) {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
  }

  function timestampMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  function reportSyncedMs(report) {
    return timestampMs(report?.summary?.syncedAt) ?? timestampMs(report?.created_at);
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function formatNumber(value, digits = 1) {
    const rounded = round(Number(value) || 0, digits);
    const [intPart, fraction] = Math.abs(rounded).toFixed(digits).split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const trimmed = fraction && /[1-9]/.test(fraction) ? `${grouped}.${fraction.replace(/0+$/, "")}` : grouped;
    return rounded < 0 ? `-${trimmed}` : trimmed;
  }

  // FNV-1a 32-bit — بصمة حتمية لمفتاح منع التكرار (بلا crypto، يعمل بأي بيئة).
  function fingerprint(value) {
    let hash = 0x811c9dc5;
    const input = String(value);
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function mergeConfig(overrides) {
    if (!overrides) return CONFIG;
    return Object.freeze({
      ...CONFIG,
      ...overrides,
      maxAgeMinutes: Object.freeze({ ...CONFIG.maxAgeMinutes, ...overrides.maxAgeMinutes })
    });
  }

  // ── الهوية: itemGuid أولاً، والاسم المطبَّع احتياط فقط ─────────────────────
  // اسم مطبَّع يقابل معرّفاً واحداً بالضبط (في المخزون أو المبيعات) يُربط به؛
  // اسم يقابل أكثر من معرّف يبقى مفتاح اسم مستقلاً ولا يُدمج بأي منها.
  function buildIdentity(stockReport, salesReport) {
    const guidsByName = new Map();
    const remember = (guid, name) => {
      const g = normalizeGuid(guid);
      const n = normalizeName(name);
      if (!g || !n) return;
      if (!guidsByName.has(n)) guidsByName.set(n, new Set());
      guidsByName.get(n).add(g);
    };
    for (const report of [stockReport, salesReport]) {
      for (const item of Array.isArray(report?.items) ? report.items : []) remember(item?.itemGuid, item?.name);
    }
    const ambiguousNames = new Set([...guidsByName].filter(([, set]) => set.size > 1).map(([name]) => name));
    function resolve(guid, name) {
      const g = normalizeGuid(guid);
      if (g) return { key: `g:${g}`, via: "guid" };
      const n = normalizeName(name);
      if (!n) return null;
      const set = guidsByName.get(n);
      if (set && set.size === 1) return { key: `g:${[...set][0]}`, via: "name" };
      return { key: `n:${n}`, via: "name" };
    }
    return { resolve, ambiguousNames };
  }

  // ── الحداثة واكتمال النافذة ───────────────────────────────────────────────
  function sourceState(report, source, syncedMs, ageMinutes, maxAge) {
    if (!report || !Array.isArray(report.items)) return "missing";
    if (report.source && report.source !== source) return "wrong_source";
    if (syncedMs === null) return "missing_as_of";
    return ageMinutes > maxAge ? "stale" : "fresh";
  }

  function evaluateSources({ stockReport, salesReport, now, config }) {
    const nowMs = timestampMs(now) ?? Date.now();
    const problems = [];
    const sources = {};
    for (const [kind, report, source, maxAge] of [
      ["stock", stockReport, config.stockSource, config.maxAgeMinutes.stock],
      ["sales", salesReport, config.salesSource, config.maxAgeMinutes.sales]
    ]) {
      const syncedMs = report ? reportSyncedMs(report) : null;
      const ageMinutes = syncedMs === null ? null : Math.max(0, (nowMs - syncedMs) / 60000);
      const state = sourceState(report, source, syncedMs, ageMinutes, maxAge);
      sources[kind] = { state, asOf: syncedMs === null ? null : new Date(syncedMs).toISOString(), ageMinutes: ageMinutes === null ? null : round(ageMinutes, 1), maxAgeMinutes: maxAge };
      if (state !== "fresh") problems.push({ kind, code: state });
    }
    return { sources, problems };
  }

  // التقرير مجمَّع على نافذة ثابتة في SQL، فلا يُعاد تقطيعه هنا: نافذته يجب أن
  // تساوي windowDays وتنتهي بيوم المرجع بالضبط، وإلا فالترتيب على فترة أخرى.
  function salesWindow(salesReport, config) {
    const referenceDay = dayNumber(salesReport?.report_date) ?? dayNumber(salesReport?.summary?.toDate);
    if (referenceDay === null) return { ok: false, code: "no_reference_day" };
    const startDay = referenceDay - (config.windowDays - 1);
    const fromDay = dayNumber(salesReport?.summary?.fromDate);
    const windowDays = finite(salesReport?.summary?.windowDays);
    const matches = windowDays === config.windowDays && fromDay === startDay;
    return { ok: matches, code: matches ? null : "window_mismatch", referenceDay, startDay };
  }

  // ── صف مبيعات صنف واحد ────────────────────────────────────────────────────
  function addSalesRow(byKey, resolved, row, counts) {
    let entry = byKey.get(resolved.key);
    if (!entry) {
      entry = { key: resolved.key, itemGuid: resolved.key.startsWith("g:") ? resolved.key.slice(2) : null, name: "", soldQty: 0, returnedQty: 0, saleInvoiceCount: 0, unit2Factor: null, unit2Name: "" };
      byKey.set(resolved.key, entry);
    }
    if (!entry.name) entry.name = text(row?.name);
    const factor = finite(row?.unit2Factor);
    if (factor !== null && factor > 0 && entry.unit2Factor === null) entry.unit2Factor = factor;
    if (!entry.unit2Name) entry.unit2Name = text(row?.unit2Name);
    entry.soldQty += counts.saleQty;
    entry.returnedQty += counts.returnQty;
    entry.saleInvoiceCount += counts.saleInvoiceCount;
  }

  function rowCounts(row) {
    const saleQty = finite(row?.saleQty);
    const returnQty = finite(row?.returnQty) ?? 0;
    const saleInvoiceCount = finite(row?.saleInvoiceCount) ?? 0;
    if (saleQty === null || saleQty < 0 || returnQty < 0 || saleInvoiceCount < 0) return null;
    return { saleQty, returnQty, saleInvoiceCount: Math.floor(saleInvoiceCount) };
  }

  // ── 1+2+3+4: صافي المبيع، الترتيب، الأهلية ─────────────────────────────────
  function computeSalesPriority({ salesReport, stockReport = null, config: overrides } = {}) {
    const config = mergeConfig(overrides);
    const window = salesWindow(salesReport, config);
    const warnings = [];
    if (!window.ok) {
      return { ok: false, code: window.code, window, items: [], ranked: [], eligible: [], soldCount: 0, topCount: 0, averageNetQty: null, warnings };
    }
    const identity = buildIdentity(stockReport, salesReport);
    const byKey = new Map();
    let invalidRows = 0;
    let unidentifiedRows = 0;
    for (const row of Array.isArray(salesReport?.items) ? salesReport.items : []) {
      const counts = rowCounts(row);
      if (!counts) { invalidRows += 1; continue; }
      const resolved = identity.resolve(row?.itemGuid, row?.name);
      if (!resolved) { unidentifiedRows += 1; continue; }
      addSalesRow(byKey, resolved, row, counts);
    }
    if (invalidRows) warnings.push(`invalid_rows:${invalidRows}`);
    if (unidentifiedRows) warnings.push(`unidentified_rows:${unidentifiedRows}`);
    if (identity.ambiguousNames.size) warnings.push(`ambiguous_names:${identity.ambiguousNames.size}`);

    const items = [...byKey.values()].map((entry) => ({
      key: entry.key,
      itemGuid: entry.itemGuid,
      name: entry.name,
      soldQty: round(entry.soldQty, 3),
      returnedQty: round(entry.returnedQty, 3),
      netQty: round(entry.soldQty - entry.returnedQty, 3),
      saleInvoiceCount: entry.saleInvoiceCount,
      unit2Factor: entry.unit2Factor,
      unit2Name: entry.unit2Name
    }));

    // «صنف مباع» = صافي موجب في النافذة. الترتيب تنازلي بالصافي، والتعادل بعدد
    // الفواتير ثم المفتاح — فالنتيجة حتمية.
    const ranked = items
      .filter((item) => item.netQty > 0)
      .sort((a, b) => b.netQty - a.netQty || b.saleInvoiceCount - a.saleInvoiceCount || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((item, index) => ({ ...item, salesRank: index + 1 }));
    const soldCount = ranked.length;
    const topCount = soldCount ? Math.ceil(soldCount * config.topShare) : 0;
    const topCutoffQty = topCount ? ranked[topCount - 1].netQty : null;
    const averageNetQty = soldCount ? round(ranked.reduce((sum, item) => sum + item.netQty, 0) / soldCount, 3) : null;

    const eligibleRaw = ranked.filter((item) => {
      const inTop = topCutoffQty !== null && item.netQty >= topCutoffQty;
      const aboveAverage = averageNetQty !== null && item.netQty > averageNetQty;
      return (inTop || aboveAverage) && item.saleInvoiceCount >= config.minSaleInvoices;
    });
    const eligible = eligibleRaw.map((item, index) => ({ ...item, priorityRank: index + 1, priorityTotal: eligibleRaw.length }));

    return {
      ok: true,
      code: null,
      window: { referenceDate: dayString(window.referenceDay), startDate: dayString(window.startDay), days: config.windowDays },
      items,
      ranked,
      eligible,
      soldCount,
      topCount,
      topCutoffQty,
      averageNetQty,
      warnings
    };
  }

  // ── الرصيد الحالي لكل مفتاح ───────────────────────────────────────────────
  function indexStock(stockReport, identity) {
    const map = new Map();
    for (const item of Array.isArray(stockReport?.items) ? stockReport.items : []) {
      const resolved = identity.resolve(item?.itemGuid, item?.name);
      const qty = finite(item?.stockQty);
      if (!resolved || qty === null) continue;
      const existing = map.get(resolved.key);
      if (existing) { existing.stockQty += qty; continue; }
      const factor = finite(item?.unit2Factor);
      map.set(resolved.key, {
        name: text(item?.name),
        stockQty: qty,
        unit2Factor: factor !== null && factor > 0 ? factor : null,
        unit1Name: text(item?.unit1Name),
        unit2Name: text(item?.unit2Name)
      });
    }
    return map;
  }

  function stockLabel(stockQty, factor, unit1Name, unit2Name) {
    const unit1 = unit1Name || "كروز";
    if (factor && factor > 1) {
      return `${formatNumber(stockQty / factor)} ${unit2Name || "كرتونة"} (${formatNumber(stockQty, 0)} ${unit1})`;
    }
    return `${formatNumber(stockQty)} ${unit1}`;
  }

  function staleMessage(problems, sources, config) {
    const label = { stock: "أرصدة المخزون", sales: "مبيعات الأصناف" };
    const reason = {
      missing: "غير متوفرة",
      wrong_source: "من مصدر غير متوقع",
      missing_as_of: "بلا وقت مزامنة",
      stale: null,
      no_reference_day: "بلا يوم مرجع",
      window_mismatch: `لا تطابق نافذة آخر ${config.windowDays} يوماً`
    };
    const lines = problems.map((problem) => {
      const source = sources?.[problem.kind];
      const why = reason[problem.code] ?? (source && source.ageMinutes !== null
        ? `قديمة (عمرها ${formatNumber(source.ageMinutes, 0)} دقيقة، الحد ${source.maxAgeMinutes})`
        : "قديمة");
      return `• ${label[problem.kind]}: ${why}`;
    });
    const code = problems.map((p) => `${p.kind}-${p.code}`).sort().join("+");
    return {
      eventType: "stock_low",
      message: ["⏳ تنبيهات النفاد متوقفة: البيانات قديمة أو ناقصة", ...lines, "لن يُرسل تنبيه ناقص حتى تتحدث المزامنة."].join("\n"),
      dedupeKey: `stock-priority:stale:${code}`,
      cooldownMinutes: config.staleCooldownMinutes
    };
  }

  function chunkMessages(header, lines, footer, maxChars) {
    const parts = [];
    let current = [];
    let size = 0;
    for (const line of lines) {
      if (current.length && size + line.length + 1 > maxChars - header.length - 40) {
        parts.push(current);
        current = [];
        size = 0;
      }
      current.push(line);
      size += line.length + 1;
    }
    if (current.length) parts.push(current);
    return parts.map((part, index) => {
      const head = parts.length > 1 ? `${header} (${index + 1}/${parts.length})` : header;
      const tail = index === parts.length - 1 && footer ? [footer] : [];
      return [head, ...part, ...tail].join("\n");
    });
  }

  function classifyItem(item, stock, threshold, config) {
    const dailyRate = item.netQty / config.windowDays;
    const coverageDays = stock.stockQty <= 0 ? 0 : stock.stockQty / dailyRate;
    let status = null;
    if (stock.stockQty <= 0) status = "out";
    else if (coverageDays <= config.lowCoverageDays) status = "low";
    else if (threshold !== null && stock.stockQty <= threshold) status = "low";
    if (!status) return null;
    const factor = stock.unit2Factor ?? item.unit2Factor;
    const unit2Name = stock.unit2Name || item.unit2Name;
    return {
      key: item.key,
      itemGuid: item.itemGuid,
      name: stock.name || item.name,
      status,
      stockQty: round(stock.stockQty, 3),
      unit2Factor: factor,
      netQty: item.netQty,
      dailyRate: round(dailyRate, 3),
      coverageDays: round(coverageDays, 1),
      priorityRank: item.priorityRank,
      priorityTotal: item.priorityTotal,
      stockLabel: stockLabel(stock.stockQty, factor, stock.unit1Name, unit2Name),
      soldLabel: stockLabel(item.netQty, factor, stock.unit1Name, unit2Name)
    };
  }

  function alertMessages(alerts, total, missingStock, config) {
    const header = `⚠️ أصناف مهمة قاربت النفاد: ${alerts.length} من ${total} صنفاً مهماً\nالأهمية = صافي مبيع آخر ${config.windowDays} يوماً`;
    const lines = alerts.map((alert) => {
      const days = alert.status === "out" ? "يكفي 0 يوم (نفد)" : `يكفي ${formatNumber(alert.coverageDays)} يوم`;
      return `• أولوية ${alert.priorityRank} من ${alert.priorityTotal} — ${alert.name} — الرصيد ${alert.stockLabel} — ${days}`;
    });
    const footer = missingStock ? `ℹ️ ${missingStock} صنف مهم بلا رصيد مطابق في تقرير المخزون` : "";
    const texts = chunkMessages(header, lines, footer, config.maxMessageChars);
    const signature = fingerprint(alerts.map((alert) => `${alert.key}=${alert.status}`).sort().join("|"));
    return texts.map((message, index) => ({
      eventType: "stock_low",
      message,
      dedupeKey: texts.length > 1 ? `stock-priority:${signature}:p${index + 1}of${texts.length}` : `stock-priority:${signature}`,
      cooldownMinutes: config.cooldownMinutes
    }));
  }

  // ── المدخل الرئيسي ────────────────────────────────────────────────────────
  // status: "alert" (رسائل أصناف)، "none" (لا صنف مهم قارب النفاد)، "stale" (رسالة تقادم فقط).
  function buildStockAlerts({ stockReport, salesReport, now = new Date(), lowStockThreshold = null, config: overrides } = {}) {
    const config = mergeConfig(overrides);
    const { sources, problems } = evaluateSources({ stockReport, salesReport, now, config });
    if (problems.length) {
      return { version: VERSION, status: "stale", sources, problems, priority: null, alerts: [], messages: [staleMessage(problems, sources, config)], warnings: [] };
    }
    const priority = computeSalesPriority({ salesReport, stockReport, config });
    if (!priority.ok) {
      const windowProblems = [{ kind: "sales", code: priority.code }];
      return { version: VERSION, status: "stale", sources, problems: windowProblems, priority, alerts: [], messages: [staleMessage(windowProblems, sources, config)], warnings: priority.warnings };
    }

    const identity = buildIdentity(stockReport, salesReport);
    const stockByKey = indexStock(stockReport, identity);
    const threshold = finite(lowStockThreshold);
    const warnings = [...priority.warnings];
    const alerts = [];
    let missingStock = 0;

    for (const item of priority.eligible) {
      const stock = stockByKey.get(item.key);
      if (!stock) { missingStock += 1; continue; }
      const alert = classifyItem(item, stock, threshold, config);
      if (alert) alerts.push(alert);
    }
    if (missingStock) warnings.push(`eligible_without_stock:${missingStock}`);
    alerts.sort((a, b) => a.priorityRank - b.priorityRank);

    if (!alerts.length) {
      return { version: VERSION, status: "none", sources, problems: [], priority, alerts, messages: [], warnings };
    }

    const messages = alertMessages(alerts, priority.eligible.length, missingStock, config);
    return { version: VERSION, status: "alert", sources, problems: [], priority, alerts, messages, warnings };
  }

  const api = Object.freeze({
    VERSION,
    CONFIG,
    normalizeName,
    normalizeGuid,
    computeSalesPriority,
    buildStockAlerts,
    formatNumber,
    fingerprint
  });

  if (typeof window !== "undefined") window.ozkStockAlertPriority = api;
  if (typeof globalThis !== "undefined") globalThis.ozkStockAlertPriority = api;
})();
