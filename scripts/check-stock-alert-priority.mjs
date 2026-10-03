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
  // صنف 3 صافيه 800 كروز/30 يوماً ⇒ 26.67 يومياً؛ رصيد 75 ⇒ 2.8 يوم.
  // صنف 1 نفد. صنف 5 رصيده يكفي 30 يوماً ⇒ لا تنبيه.
  const r = engine.buildStockAlerts({ stockReport: tenStock({ 1: 0, 3: 75, 5: 600 }), salesReport: salesReport(tenItems()), now: NOW, lowStockThreshold: 50 });
  assert.equal(r.status, "alert");
  assert.equal(r.alerts.length, 2);
  assert.deepEqual(r.alerts.map((a) => a.priorityRank), [1, 3]);
  const text = r.messages[0].message;
  assert.match(text, /أصناف مهمة قاربت النفاد: 2 من 5/);
  const lines = text.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(lines[0], "• أولوية 1 من 5 — صنف 1 — الرصيد 0 كرتونة (0 كروز) — يكفي 0 يوم (نفد)");
  assert.equal(lines[1], "• أولوية 3 من 5 — صنف 3 — الرصيد 1.5 كرتونة (75 كروز) — يكفي 2.8 يوم");
});

await test("5) حد «يكفي» 3 أيام: 3 أيام بالضبط تُنبَّه، 3.75 يوم لا", () => {
  assert.equal(engine.CONFIG.lowCoverageDays, 3);
  // صنف 3: 26.67 كروز يومياً ⇒ رصيد 80 = 3 أيام بالضبط، ورصيد 100 = 3.75 يوم.
  const atLimit = engine.buildStockAlerts({ stockReport: tenStock({ 3: 80 }), salesReport: salesReport(tenItems()), now: NOW, lowStockThreshold: 50 });
  assert.deepEqual(atLimit.alerts.map((a) => a.priorityRank), [3]);
  const above = engine.buildStockAlerts({ stockReport: tenStock({ 3: 100 }), salesReport: salesReport(tenItems()), now: NOW, lowStockThreshold: 50 });
  assert.equal(above.status, "none");
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
  const a = engine.buildStockAlerts({ stockReport: tenStock({ 3: 70 }), salesReport: inv, now: NOW });
  const b = engine.buildStockAlerts({ stockReport: tenStock({ 3: 60 }), salesReport: inv, now: NOW });
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

// ── الدالة الطرفية stock-priority-alert (جدولة pg_cron) تحت عميل Supabase وهمي ─────────
async function runEdge({ header = "tok-stock", stored = "tok-stock", stock = tenStock({ 1: 0 }), sales = salesReport(tenItems()), threshold = "50", body = { action: "scheduled_check" }, notifyError = null, now = NOW } = {}) {
  const ts = (await import("typescript")).default;
  const vm = await import("node:vm");
  const { outputText, diagnostics } = ts.transpileModule(readFileSync("supabase/functions/stock-priority-alert/index.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: "stock-priority-alert.ts"
  });
  assert.equal(diagnostics.length, 0, "الدالة تُترجم بلا أخطاء صياغة");
  const engineSource = readFileSync("supabase/functions/_shared/stock-alert-priority.js", "utf8");
  const bySource = { ameen_sql_agent: stock, ameen_item_sales: sales };
  const calls = { rpc: [], tables: [] };
  const from = (table) => {
    calls.tables.push(table);
    const filters = {};
    const result = () => {
      if (table === "app_secrets") return { data: stored === null ? null : { value: stored }, error: null };
      if (table === "inventory_reports") return { data: [bySource[filters.source]].filter(Boolean), error: null };
      if (table === "bot_config") return { data: threshold === null ? null : { value: threshold }, error: null };
      throw new Error(`جدول غير متوقع ${table}`);
    };
    const builder = {
      select: () => builder,
      eq: (column, value) => { filters[column] = value; return builder; },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => result(),
      then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject)
    };
    return builder;
  };
  const rpc = async (name, args) => { calls.rpc.push({ name, args }); return { error: notifyError }; };
  const HostDate = Date;
  class FixedDate extends HostDate {
    constructor(...args) { if (args.length) super(...args); else super(now.getTime()); }
    static now() { return now.getTime(); }
  }
  const context = vm.createContext({
    Response, Request, Headers, console, Promise, JSON, Math, Number, String, Object, Array, Map, Set, Infinity, isNaN,
    Date: FixedDate,
    Deno: { env: { get: (name) => ({ SUPABASE_URL: "https://local.test", SUPABASE_SERVICE_ROLE_KEY: "service-test" }[name] || "") } },
    exports: {}
  });
  context.globalThis = context;
  context.require = (specifier) => {
    if (specifier === "../_shared/stock-alert-priority.js") { vm.runInContext(engineSource, context); return {}; }
    if (specifier.startsWith("npm:@supabase/supabase-js")) return { createClient: () => ({ from, rpc }) };
    throw new Error(`استيراد غير متوقع ${specifier}`);
  };
  context.module = { exports: context.exports };
  vm.runInContext(outputText, context, { filename: "stock-priority-alert.js" });
  const headers = { "content-type": "application/json" };
  if (header !== null) headers["x-ozk-stock-alert-token"] = header;
  const response = await context.exports.default.fetch(new Request("https://local.test/functions/v1/stock-priority-alert", {
    method: "POST", headers, body: JSON.stringify(body)
  }));
  return { status: response.status, body: await response.json(), calls };
}

await test("pg_cron: نسخة الخادم من المحرك تطابق src/stock-alert-priority.js بايتاً ببايت", () => {
  assert.equal(readFileSync("supabase/functions/_shared/stock-alert-priority.js", "utf8"), readFileSync("src/stock-alert-priority.js", "utf8"),
    "شغّل: cp src/stock-alert-priority.js supabase/functions/_shared/");
  const fn = readFileSync("supabase/functions/stock-priority-alert/index.ts", "utf8");
  assert.match(fn, /import "\.\.\/_shared\/stock-alert-priority\.js";/);
  assert.match(fn, /buildStockAlerts\(/, "الخطة من المحرك لا من حساب ثانٍ");
  assert.match(fn, /sameToken\(req\.headers\.get\("x-ozk-stock-alert-token"\)/);
  assert.doesNotMatch(fn, /AmnDb00|AMEEN_SQL|mssql|tedious|sqlcmd|ameen_warehouse_stock_reports/i, "لا وصول للأمين ولا لتقارير المستودعات");
  assert.doesNotMatch(fn, /from\("(?!app_secrets|inventory_reports|bot_config)/, "لا جداول أخرى");
  assert.doesNotMatch(fn, /\.(insert|update|upsert|delete)\(/, "لا كتابة غير notify_telegram");
});

await test("pg_cron: الرمز شرط قبل أي قراءة، ورمز غير مضبوط ⇒ لا شيء", async () => {
  const wrong = await runEdge({ header: "tok-x" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.calls.tables, ["app_secrets"], "لا قراءة قبل التحقق من الرمز");
  assert.equal(wrong.calls.rpc.length, 0);
  assert.equal((await runEdge({ stored: null, header: "" })).status, 401);
  assert.equal((await runEdge({ header: null })).status, 401);
});

await test("pg_cron: التشغيل المجدول يرسل نفس رسالة المُشغِّل ومفتاحها ونافذة 360 دقيقة", async () => {
  const out = await runEdge();
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.mode, "live");
  assert.equal(out.body.sent, 1);
  assert.equal(out.calls.rpc.length, 1);
  const expected = engine.buildStockAlerts({ stockReport: tenStock({ 1: 0 }), salesReport: salesReport(tenItems()), now: NOW, lowStockThreshold: 50 }).messages[0];
  assert.deepEqual(JSON.parse(JSON.stringify(out.calls.rpc[0])), { name: "notify_telegram", args: { p_event_type: "stock_low", p_message: expected.message, p_dedupe_key: expected.dedupeKey, p_dedupe_minutes: 360 } });
  assert.ok(!JSON.stringify(out.body).includes("صنف 1"), "لا أسماء أصناف في الرد");
});

await test("pg_cron: dryRun لا يرسل، ومصدر قديم ⇒ رسالة التقادم وحدها، وفشل الإرسال ظاهر", async () => {
  const dry = await runEdge({ body: { dryRun: true } });
  assert.equal(dry.body.mode, "dry_run");
  assert.equal(dry.body.messages, 1);
  assert.equal(dry.calls.rpc.length, 0);
  const stale = await runEdge({ stock: null });
  assert.equal(stale.body.status, "stale");
  assert.match(stale.calls.rpc[0].args.p_message, /أرصدة المخزون: غير متوفرة/);
  const failed = await runEdge({ notifyError: { message: "x" } });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "notify_failed");
  const noThreshold = await runEdge({ threshold: null, stock: tenStock({ 5: 590 }) });
  assert.equal(noThreshold.body.alerts, 0, "بلا حد مضبوط يُستعمل 50 كما في المُشغِّل");
});

await test("pg_cron: الهجرة تجدول كل 15 دقيقة برمز app_secrets، وتتخطى بلا pg_cron، والدالة بلا JWT", () => {
  const name = readdirSync("supabase/migrations").find((f) => f.endsWith("_stock_priority_alert_cron.sql"));
  assert.ok(name);
  const sql = readFileSync(`supabase/migrations/${name}`, "utf8");
  assert.match(sql, /cron\.schedule\('stock-priority-alert', '\*\/15 \* \* \* \*', 'select public\.dispatch_stock_priority_alert\(\);'\)/);
  assert.match(sql, /from public\.app_secrets where name = 'stock_priority_alert_token'/);
  assert.match(sql, /if alert_token is null or alert_token = '' then return; end if;/, "بلا رمز ⇒ عملية فارغة");
  assert.match(sql, /'X-OZK-Stock-Alert-Token', alert_token/);
  assert.match(sql, /revoke all on function public\.dispatch_stock_priority_alert\(\) from public, anon, authenticated;/);
  assert.ok(sql.indexOf("from pg_extension where extname = 'pg_cron'") > 0 && sql.indexOf("from pg_extension where extname = 'pg_cron'") < sql.indexOf("from cron.job"), "يتحقق من pg_cron قبل cron.job");
  const code = sql.replace(/--.*$/gm, "").toLowerCase();
  assert.doesNotMatch(code, /amndb00|notify_telegram|telegram_outbox|insert into public\.app_secrets/, "لا أمين ولا تعديل لتيليغرام ولا رمز مكتوب");
  assert.match(readFileSync("supabase/config.toml", "utf8"), /\[functions\.stock-priority-alert\]\s*\nverify_jwt = false/);
});

console.log("check-stock-alert-priority:");
console.log(results.join("\n"));
if (failed) {
  console.error(`❌ ${failed} فحصاً فشل.`);
  process.exit(1);
}
console.log(`✅ ${results.length} فحصاً ناجحاً.`);
