// ============================================================================
// فحص تنبيهات النفاد حسب أولوية المبيعات (src/stock-alert-priority.js) ومُشغِّلها.
// كل الأسماء والكميات والمعرّفات مصطنعة؛ لا بيانات إنتاج.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import "../src/stock-alert-priority.js";
import { run } from "./stock-priority-alerts.mjs";

const engine = globalThis.ozkStockAlertPriority;
assert.ok(engine, "src/stock-alert-priority.js لم يعرّف ozkStockAlertPriority");

const results = [];
let failed = 0;
async function test(name, fn) {
  try { await fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error?.stack || error}`); }
}

const NOW = new Date("2026-10-03T09:00:00.000Z");
const fresh = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
const guid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const date = (daysAgo) => new Date(Date.UTC(2026, 9, 3) - daysAgo * 86400000).toISOString().slice(0, 10);

// sales: [{ g, name, qty, daysAgo, isReturn }] — كل عنصر فاتورة مستقلة.
// يحاكي تجميع tools/push-item-sales.ps1: نافذة 30 يوماً شاملة يوم المرجع، وصف لكل
// صنف (GROUP BY m.GUID)، وكل الفواتير بلا شرط على اسم الزبون.
function salesReport(sales, overrides = {}) {
  const rows = new Map();
  for (const sale of sales) {
    if ((sale.daysAgo ?? 1) > 29) continue;
    const g = sale.g === undefined ? "" : sale.g;
    const key = g || `name:${sale.name}`;
    if (!rows.has(key)) rows.set(key, { itemGuid: g, name: sale.name, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: sale.factor ?? 50, saleQty: 0, returnQty: 0, saleInvoiceCount: 0, returnInvoiceCount: 0 });
    const row = rows.get(key);
    if (sale.isReturn === true) { row.returnQty += sale.qty; row.returnInvoiceCount += 1; }
    else { row.saleQty += sale.qty; row.saleInvoiceCount += 1; }
  }
  return {
    source: "ameen_item_sales",
    report_date: "2026-10-03",
    created_at: fresh(20),
    summary: { payloadVersion: 1, windowDays: 30, fromDate: date(29), toDate: "2026-10-03", includesAnonymous: true, syncedAt: fresh(20) },
    items: [...rows.values()],
    ...overrides
  };
}

function stockReport(items, overrides = {}) {
  return {
    source: "ameen_sql_agent",
    report_date: "2026-10-03",
    created_at: fresh(3),
    summary: { syncedAt: fresh(3) },
    items: items.map((item) => ({ itemGuid: item.g ?? null, name: item.name, stockQty: item.stock, unit2Factor: item.factor ?? 50, unit1Name: "كروز", unit2Name: "كرتونة" })),
    ...overrides
  };
}

// صنف يُباع n فاتورة بكمية q لكل فاتورة
const sold = (g, name, invoices, qtyEach, extra = {}) => Array.from({ length: invoices }, (_, i) => ({ g, name, qty: qtyEach, daysAgo: 1 + i, ...extra }));

// عشرة أصناف: الصافي 1000..100 بخطوة 100، كل منها 5 فواتير.
function tenItems() {
  const sales = [];
  for (let i = 1; i <= 10; i += 1) sales.push(...sold(guid(i), `صنف ${i}`, 5, (11 - i) * 20));
  return sales;
}

await test("1) الصافي = البيع ناقص المرتجع بالكروز، والربط بـitemGuid", () => {
  const report = salesReport([
    ...sold(guid(1), "مادة أ", 3, 100),
    { g: guid(1), name: "مادة أ", qty: 50, isReturn: true }
  ]);
  const p = engine.computeSalesPriority({ salesReport: report });
  const item = p.ranked.find((r) => r.key === `g:${guid(1)}`);
  assert.equal(item.soldQty, 300);
  assert.equal(item.returnedQty, 50);
  assert.equal(item.netQty, 250);
  assert.equal(item.saleInvoiceCount, 3, "المرتجع لا يُعدّ فاتورة بيع");
});

await test("1) الاسم المطبَّع احتياط: سطر بلا itemGuid يُربط بمعرّف الاسم الوحيد", () => {
  const report = salesReport([
    ...sold(guid(1), "مادة أ", 2, 100),
    { g: "", name: "مادة  ا", qty: 100, daysAgo: 4 }
  ]);
  const p = engine.computeSalesPriority({ salesReport: report });
  assert.equal(p.ranked.length, 1);
  assert.equal(p.ranked[0].netQty, 300);
  assert.equal(p.ranked[0].saleInvoiceCount, 3);
});

await test("1) اسم يقابل معرّفين لا يُدمج بأي منهما", () => {
  const report = salesReport([
    ...sold(guid(1), "مادة مكررة", 3, 100),
    ...sold(guid(2), "مادة مكررة", 3, 100),
    { g: "", name: "مادة مكررة", qty: 999, daysAgo: 2 }
  ]);
  const p = engine.computeSalesPriority({ salesReport: report });
  assert.equal(p.ranked.find((r) => r.key === `g:${guid(1)}`).netQty, 300);
  assert.equal(p.ranked.find((r) => r.key === `g:${guid(2)}`).netQty, 300);
  assert.ok(p.ranked.some((r) => r.key === "n:ماده مكرره"));
  assert.ok(p.warnings.some((w) => w.startsWith("ambiguous_names:")));
});

await test("1) نافذة 30 يوماً تنتهي بيوم المرجع، وتقرير بنافذة أخرى مرفوض", () => {
  const p = engine.computeSalesPriority({ salesReport: salesReport([{ g: guid(1), name: "م", qty: 10, daysAgo: 29 }]) });
  assert.equal(p.ok, true);
  assert.equal(p.window.startDate, "2026-09-04");
  assert.equal(p.window.referenceDate, "2026-10-03");
  for (const summary of [
    { windowDays: 14, fromDate: date(13) },
    { windowDays: 30, fromDate: date(30) },
    { windowDays: 30 }
  ]) {
    const bad = salesReport([{ g: guid(1), name: "م", qty: 10 }], { summary: { ...summary, syncedAt: fresh(20) } });
    assert.equal(engine.computeSalesPriority({ salesReport: bad }).code, "window_mismatch", JSON.stringify(summary));
  }
});

await test("1) مبيعات «مركز» بلا اسم زبون تدخل الترتيب: المصدر يجمع كل فواتير البيع والمرتجع", () => {
  const ps = readFileSync("tools/push-item-sales.ps1", "utf8");
  const open = ps.indexOf('$cmd.CommandText = @"');
  const sql = ps.slice(open, ps.indexOf('"@', open));
  assert.ok(open > 0 && sql.length > 100, "استعلام التجميع غير موجود");
  assert.ok(!/Cust_Name|cu000/i.test(sql), "الاستعلام يشترط الزبون فيُسقط مبيعات الكاشير");
  assert.match(sql, /bt\.BillType IN \(1, 3\)/);
  assert.match(sql, /COUNT\(DISTINCT CASE WHEN bt\.BillType = 1 THEN u\.GUID END\)/);
  assert.match(sql, /GROUP BY m\.GUID/);
  assert.match(ps, /source\s*=\s*"ameen_item_sales"/);
  assert.match(ps, /\[int\]\$WindowDays = 30/);
  assert.equal(engine.CONFIG.salesSource, "ameen_item_sales");
});

await test("2+3) الترتيب تنازلي، وأعلى 20% أو فوق المتوسط أيهما أوسع", () => {
  const p = engine.computeSalesPriority({ salesReport: salesReport(tenItems()) });
  assert.deepEqual(p.ranked.map((r) => r.netQty), [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
  assert.equal(p.topCount, 2);
  assert.equal(p.averageNetQty, 550);
  // فوق المتوسط (550): 1000..600 = خمسة أصناف، أوسع من أعلى 20% (اثنان)
  assert.equal(p.eligible.length, 5);
  assert.deepEqual(p.eligible.map((r) => r.priorityRank), [1, 2, 3, 4, 5]);
  assert.ok(p.eligible.every((r) => r.priorityTotal === 5));
});

await test("3) أعلى 20% أوسع من المتوسط حين يشدّ صنف شاذ المتوسط", () => {
  const sales = [...sold(guid(1), "ضخم", 5, 2000)];
  for (let i = 2; i <= 10; i += 1) sales.push(...sold(guid(i), `صنف ${i}`, 5, 10 + i));
  const p = engine.computeSalesPriority({ salesReport: salesReport(sales) });
  // المتوسط ≈ 1076: فوقه صنف واحد؛ أعلى 20% = اثنان
  assert.equal(p.topCount, 2);
  assert.equal(p.eligible.length, 2);
});

await test("3) التعادل على حد أعلى 20% يُضم", () => {
  const sales = [];
  for (let i = 1; i <= 5; i += 1) sales.push(...sold(guid(i), `ص${i}`, 3, 100));
  const p = engine.computeSalesPriority({ salesReport: salesReport(sales) });
  assert.equal(p.topCount, 1);
  assert.equal(p.eligible.length, 5, "كلها متعادلة على الحد");
});

await test("4) أقل من 3 فواتير بيع ⇒ لا أهلية مهما كانت الكمية", () => {
  const sales = [...sold(guid(1), "فاتورتان", 2, 5000), ...tenItems().filter((s) => s.g !== guid(1))];
  const p = engine.computeSalesPriority({ salesReport: salesReport(sales) });
  assert.equal(p.ranked[0].key, `g:${guid(1)}`, "يبقى في الترتيب");
  assert.ok(!p.eligible.some((r) => r.key === `g:${guid(1)}`));
  assert.equal(p.eligible[0].priorityRank, 1);
});

await test("4) صنف صافيه صفر أو سالب (مرتجعات) خارج الترتيب", () => {
  const report = salesReport([
    ...sold(guid(1), "مرتجع كامل", 3, 100),
    { g: guid(1), name: "مرتجع كامل", qty: 300, isReturn: true },
    ...sold(guid(2), "عادي", 3, 100)
  ]);
  const p = engine.computeSalesPriority({ salesReport: report });
  assert.deepEqual(p.ranked.map((r) => r.key), [`g:${guid(2)}`]);
});

const tenStock = (overrides = {}) => stockReport(Array.from({ length: 10 }, (_, i) => ({ g: guid(i + 1), name: `صنف ${i + 1}`, stock: overrides[i + 1] ?? 100000 })));

await test("4) صنف لم يُبع في 30 يوماً لا يُنبَّه عليه ولو نفد", () => {
  const stock = stockReport([
    ...Array.from({ length: 10 }, (_, i) => ({ g: guid(i + 1), name: `صنف ${i + 1}`, stock: 100000 })),
    { g: guid(77), name: "راكد", stock: 0 }
  ]);
  const r = engine.buildStockAlerts({ stockReport: stock, salesReport: salesReport(tenItems()), now: NOW });
  assert.equal(r.status, "none");
  assert.equal(r.messages.length, 0);
});

await test("5) الرسالة: الاسم والرصيد بالكرتونة وكم يوم يكفي والأولوية، مرتبة من الأهم", () => {
  // صنف 3 صافيه 800 كروز/30 يوماً ⇒ 26.67 يومياً؛ رصيد 100 ⇒ 3.75 يوم.
  // صنف 1 نفد. صنف 5 رصيده يكفي 30 يوماً ⇒ لا تنبيه.
  const r = engine.buildStockAlerts({ stockReport: tenStock({ 1: 0, 3: 100, 5: 600 }), salesReport: salesReport(tenItems()), now: NOW, lowStockThreshold: 50 });
  assert.equal(r.status, "alert");
  assert.equal(r.alerts.length, 2);
  assert.deepEqual(r.alerts.map((a) => a.priorityRank), [1, 3]);
  const text = r.messages[0].message;
  assert.match(text, /أصناف مهمة قاربت النفاد: 2 من 5/);
  const lines = text.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(lines[0], "• أولوية 1 من 5 — صنف 1 — الرصيد 0 كرتونة (0 كروز) — يكفي 0 يوم (نفد)");
  assert.equal(lines[1], "• أولوية 3 من 5 — صنف 3 — الرصيد 2 كرتونة (100 كروز) — يكفي 3.8 يوم");
});

await test("5) حد bot_config.low_stock_threshold يبقى فعّالاً للأصناف المهمة", () => {
  const r = engine.buildStockAlerts({ stockReport: tenStock({ 5: 590 }), salesReport: salesReport(tenItems()), now: NOW, lowStockThreshold: 600 });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].priorityRank, 5);
});

await test("1) الرصيد يُربط بالاسم حين يغيب itemGuid من تقرير المخزون", () => {
  const stock = stockReport(Array.from({ length: 10 }, (_, i) => ({ g: null, name: `صنف ${i + 1}`, stock: i === 1 ? 0 : 100000 })));
  const r = engine.buildStockAlerts({ stockReport: stock, salesReport: salesReport(tenItems()), now: NOW });
  assert.deepEqual(r.alerts.map((a) => a.priorityRank), [2]);
});

await test("6) مخزون قديم ⇒ لا تنبيه أصناف، رسالة تقادم فقط", () => {
  const stale = stockReport([{ g: guid(1), name: "صنف 1", stock: 0 }], { created_at: fresh(30), summary: { syncedAt: fresh(30) } });
  const r = engine.buildStockAlerts({ stockReport: stale, salesReport: salesReport(tenItems()), now: NOW });
  assert.equal(r.status, "stale");
  assert.equal(r.alerts.length, 0);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].message, /أرصدة المخزون: قديمة \(عمرها 30 دقيقة، الحد 10\)/);
  assert.ok(!/صنف 1/.test(r.messages[0].message));
  assert.equal(r.messages[0].dedupeKey, "stock-priority:stale:stock-stale");
});

await test("6) مبيعات قديمة أو مفقودة ⇒ تبليغ بالتقادم", () => {
  const old = salesReport(tenItems(), { created_at: fresh(200), summary: { windowDays: 30, fromDate: date(29), syncedAt: fresh(200) } });
  let r = engine.buildStockAlerts({ stockReport: tenStock({ 1: 0 }), salesReport: old, now: NOW });
  assert.equal(r.status, "stale");
  assert.match(r.messages[0].message, /مبيعات الأصناف: قديمة/);
  r = engine.buildStockAlerts({ stockReport: tenStock({ 1: 0 }), salesReport: null, now: NOW });
  assert.equal(r.status, "stale");
  assert.match(r.messages[0].message, /مبيعات الأصناف: غير متوفرة/);
});

await test("6) نافذة المبيعات لا تطابق آخر 30 يوماً ⇒ لا تنبيه ناقص", () => {
  const short = salesReport(tenItems(), { summary: { windowDays: 14, fromDate: date(13), syncedAt: fresh(20) } });
  const r = engine.buildStockAlerts({ stockReport: tenStock({ 1: 0 }), salesReport: short, now: NOW });
  assert.equal(r.status, "stale");
  assert.equal(r.alerts.length, 0);
  assert.match(r.messages[0].message, /مبيعات الأصناف: لا تطابق نافذة آخر 30 يوماً/);
  assert.equal(r.messages[0].dedupeKey, "stock-priority:stale:sales-window_mismatch");
});

await test("صف مبيعات تالف لا يُحسب ويُبلَّغ تحذيراً", () => {
  const report = salesReport(tenItems());
  report.items.push({ itemGuid: guid(55), name: "تالف", saleQty: "abc", returnQty: 0, saleInvoiceCount: 9 });
  const p = engine.computeSalesPriority({ salesReport: report });
  assert.ok(!p.items.some((i) => i.key === `g:${guid(55)}`));
  assert.ok(p.warnings.includes("invalid_rows:1"));
});

await test("7) منع التكرار: نفس المجموعة ⇒ نفس المفتاح، وتغيّر حالة صنف ⇒ مفتاح جديد", () => {
  const inv = salesReport(tenItems());
  const a = engine.buildStockAlerts({ stockReport: tenStock({ 3: 100 }), salesReport: inv, now: NOW });
  const b = engine.buildStockAlerts({ stockReport: tenStock({ 3: 90 }), salesReport: inv, now: NOW });
  const c = engine.buildStockAlerts({ stockReport: tenStock({ 3: 0 }), salesReport: inv, now: NOW });
  assert.equal(a.messages[0].dedupeKey, b.messages[0].dedupeKey, "تغيّر الكمية وحده لا يعيد الإرسال");
  assert.notEqual(a.messages[0].dedupeKey, c.messages[0].dedupeKey, "low → out يعيد الإرسال");
  assert.equal(a.messages[0].cooldownMinutes, 360);
  assert.equal(a.messages[0].eventType, "stock_low");
  assert.match(a.messages[0].dedupeKey, /^stock-priority:[0-9a-f]{8}$/);
});

await test("7) رسالة طويلة تُقسم تحت حد notify_telegram بمفاتيح أجزاء مستقلة", () => {
  const sales = [];
  for (let i = 1; i <= 200; i += 1) sales.push(...sold(guid(i), `صنف طويل الاسم جداً رقم ${i} للتجربة`, 3, 100));
  const stock = stockReport(Array.from({ length: 200 }, (_, i) => ({ g: guid(i + 1), name: `صنف طويل الاسم جداً رقم ${i + 1} للتجربة`, stock: 0 })));
  const r = engine.buildStockAlerts({ stockReport: stock, salesReport: salesReport(sales), now: NOW });
  assert.equal(r.alerts.length, 200);
  assert.ok(r.messages.length > 1);
  assert.ok(r.messages.every((m) => m.message.length <= engine.CONFIG.maxMessageChars));
  assert.equal(new Set(r.messages.map((m) => m.dedupeKey)).size, r.messages.length);
  const allLines = r.messages.flatMap((m) => m.message.split("\n").filter((l) => l.startsWith("•")));
  assert.equal(allLines.length, 200);
  assert.ok(allLines[0].startsWith("• أولوية 1 من 200"));
});

await test("الحتمية: نفس المدخلات بترتيب مختلف ⇒ نفس الناتج", () => {
  const sales = tenItems();
  const a = engine.buildStockAlerts({ stockReport: tenStock({ 2: 0, 4: 10 }), salesReport: salesReport(sales), now: NOW });
  const b = engine.buildStockAlerts({ stockReport: tenStock({ 2: 0, 4: 10 }), salesReport: salesReport([...sales].reverse()), now: NOW });
  assert.deepEqual(a.messages, b.messages);
});

await test("CONFIG موثّق ومجمَّد بالعتبات المطلوبة", () => {
  const c = engine.CONFIG;
  assert.ok(Object.isFrozen(c));
  assert.equal(c.windowDays, 30);
  assert.equal(c.topShare, 0.2);
  assert.equal(c.minSaleInvoices, 3);
  const doc = readFileSync("docs/ai/topics/stock-priority-alerts.md", "utf8");
  for (const token of ["windowDays", "topShare", "minSaleInvoices", "lowCoverageDays", "cooldownMinutes", "maxAgeMinutes"]) {
    assert.ok(doc.includes(token), `الوثيقة لا تذكر ${token}`);
  }
});

await test("عتبات الحداثة: المخزون = مراقب المهام (10)، والمبيعات ثلاث دورات من مهمتها (30 × 3)", () => {
  const sql = readFileSync("supabase/project-task-health-monitor.sql", "utf8");
  assert.match(sql, /\('ameen-main','[^']+','ameen_sql_agent',10,/);
  assert.equal(engine.CONFIG.maxAgeMinutes.stock, 10);
  const task = readFileSync("tools/register-item-sales-task.ps1", "utf8");
  const interval = Number(task.match(/\[int\]\$IntervalMinutes = (\d+)/)[1]);
  assert.equal(engine.CONFIG.maxAgeMinutes.sales, interval * 3);
});

await test("9) لا كتابة على الأمين ولا ذكر لتقارير المستودعات في المسار الجديد", () => {
  // سكربت المبيعات يقرأ الأمين: SELECT وحده، بلا أي أمر كتابة في نصوص SQL.
  const ps = readFileSync("tools/push-item-sales.ps1", "utf8");
  const sqlTexts = [...ps.matchAll(/CommandText = (?:@"([\s\S]*?)"@|"([^"]*)")/g)].map((m) => m[1] ?? m[2]);
  assert.ok(sqlTexts.length >= 2);
  for (const sql of sqlTexts) {
    assert.match(sql.trim(), /^SELECT\b/i);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(sql), "أمر كتابة في استعلام الأمين");
  }
  assert.ok(!/ExecuteNonQuery/.test(ps));
  for (const path of ["src/stock-alert-priority.js", "scripts/stock-priority-alerts.mjs", ".github/workflows/stock-priority-alerts.yml"]) {
    const source = readFileSync(path, "utf8");
    assert.ok(!/AMEEN_SQL_(WRITE_)?CONNECTION|SqlConnection|AmnDb00|Invoke-Sqlcmd/i.test(source), `${path} يلمس الأمين`);
    assert.ok(!/ameen_warehouse_stock_reports|الامانة/.test(source.replace(/المستبعِد لمستودع الامانة/g, "")), `${path} يقرأ تقارير المستودعات`);
  }
  const runner = readFileSync("scripts/stock-priority-alerts.mjs", "utf8");
  const writes = [...runner.matchAll(/method:\s*"(POST|PATCH|PUT|DELETE)"/g)];
  assert.equal(writes.length, 1, "كتابة واحدة فقط");
  assert.ok(runner.includes("/rest/v1/rpc/notify_telegram"));
});

await test("الـtrigger القديم لكل الأصناف متوقف في المرجع والترحيل، والتنبيهات الأخرى باقية", () => {
  const ref = readFileSync("supabase/telegram-notifications.sql", "utf8");
  assert.ok(!/create trigger trg_notify_stock_alerts/.test(ref));
  assert.ok(ref.includes("drop trigger if exists trg_notify_stock_alerts on public.approved_price_items;"));
  for (const keep of ["trg_notify_new_price_items", "create or replace function public.notify_telegram("]) assert.ok(ref.includes(keep), `${keep} اختفى`);
  const migration = readdirSync("supabase/migrations").find((f) => f.endsWith("_retire_all_items_stock_alert_trigger.sql"));
  assert.ok(migration);
  const sql = readFileSync(`supabase/migrations/${migration}`, "utf8").replace(/--.*$/gm, "");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements, [
    "drop trigger if exists trg_notify_stock_alerts on public.approved_price_items",
    "drop function if exists public.tg_notify_stock_alerts()"
  ]);
});

// ── المُشغِّل بـfetch مزيّف ───────────────────────────────────────────────────
function fakeFetch({ stock, sales, threshold = "50", rpcStatus = 204 }) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (url.includes("/rpc/notify_telegram")) return json(null, rpcStatus);
    if (url.includes("source=eq.ameen_sql_agent")) return json(stock ? [stock] : []);
    if (url.includes("source=eq.ameen_item_sales")) return json(sales ? [sales] : []);
    if (url.includes("/bot_config")) return json([{ value: threshold }]);
    return json({}, 404);
  };
  return { impl, calls };
}
const env = { SUPABASE_URL: "https://example.invalid/", SUPABASE_SERVICE_ROLE_KEY: "test-key" };

await test("المُشغِّل: تجريبي بلا --send لا يرسل، ولا يطبع أسماء", async () => {
  const fake = fakeFetch({ stock: tenStock({ 1: 0 }), sales: salesReport(tenItems()) });
  const logs = [];
  const out = await run({ env, argv: [], fetchImpl: fake.impl, now: NOW, log: (l) => logs.push(l) });
  assert.equal(out.sent, 0);
  assert.equal(out.result.status, "alert");
  assert.ok(!fake.calls.some((c) => c.url.includes("/rpc/")));
  assert.ok(!logs.join("\n").includes("صنف 1"));
  for (const c of fake.calls) assert.equal(c.init.headers["Accept-Profile"], "public");
});

await test("المُشغِّل: --send يستدعي notify_telegram بمفتاح التكرار ونافذته وContent-Profile", async () => {
  const fake = fakeFetch({ stock: tenStock({ 1: 0 }), sales: salesReport(tenItems()) });
  const out = await run({ env, argv: ["--send"], fetchImpl: fake.impl, now: NOW, log: () => {} });
  assert.equal(out.sent, 1);
  const rpc = fake.calls.find((c) => c.url === "https://example.invalid/rest/v1/rpc/notify_telegram");
  assert.equal(rpc.init.headers["Content-Profile"], "public");
  const body = JSON.parse(rpc.init.body);
  assert.equal(body.p_event_type, "stock_low");
  assert.match(body.p_dedupe_key, /^stock-priority:/);
  assert.equal(body.p_dedupe_minutes, 360);
  assert.match(body.p_message, /أولوية 1 من 5/);
});

await test("المُشغِّل: مصدر قديم ⇒ يرسل رسالة التقادم وحدها", async () => {
  const fake = fakeFetch({ stock: null, sales: salesReport(tenItems()) });
  const out = await run({ env, argv: ["--send"], fetchImpl: fake.impl, now: NOW, log: () => {} });
  assert.equal(out.result.status, "stale");
  const body = JSON.parse(fake.calls.find((c) => c.url.includes("/rpc/")).init.body);
  assert.match(body.p_message, /أرصدة المخزون: غير متوفرة/);
});

await test("المُشغِّل: فشل notify_telegram يُسقط التشغيل بخطأ ظاهر", async () => {
  const fake = fakeFetch({ stock: tenStock({ 1: 0 }), sales: salesReport(tenItems()), rpcStatus: 500 });
  await assert.rejects(run({ env, argv: ["--send"], fetchImpl: fake.impl, now: NOW, log: () => {} }), /HTTP 500/);
});

await test("المُشغِّل: بلا سرّ — التجريبي يتخطى بلا فشل، و--send يفشل صراحة", async () => {
  const fake = fakeFetch({ stock: null, sales: null });
  const out = await run({ env: { SUPABASE_URL: "https://example.invalid" }, argv: [], fetchImpl: fake.impl, now: NOW, log: () => {} });
  assert.equal(out.sent, 0);
  assert.equal(fake.calls.length, 0);
  await assert.rejects(run({ env: { SUPABASE_URL: "https://example.invalid" }, argv: ["--send"], fetchImpl: fake.impl, now: NOW, log: () => {} }), /SUPABASE_SERVICE_ROLE_KEY/);
});

await test("فشل workflow التنبيهات مراقَب في alert-on-automation-failure.yml", () => {
  const name = readFileSync(".github/workflows/stock-priority-alerts.yml", "utf8").match(/^name:\s*(.+)$/m)[1].trim();
  const watcher = readFileSync(".github/workflows/alert-on-automation-failure.yml", "utf8");
  assert.ok(watcher.includes(`- "${name}"`), `${name} غير مدرج في قائمة المراقبة`);
});

console.log("check-stock-alert-priority:");
console.log(results.join("\n"));
if (failed) {
  console.error(`❌ ${failed} فحصاً فشل.`);
  process.exit(1);
}
console.log(`✅ ${results.length} فحصاً ناجحاً.`);
