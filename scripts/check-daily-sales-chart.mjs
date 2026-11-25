// ============================================================================
// حارس رسم «حركة المبيعات اليومية» (src/daily-sales-chart.js).
// بيانات اصطناعية فقط — لا بيانات إنتاج.
//   • أيام الشهر الفعلية (28/29/30/31) والمستقبل فارغ بتوقيت دمشق.
//   • «لا بيانات» ≠ «صفر مبيعات»، والمتوسط لا يُحسب على أيام بلا بيانات.
//   • صافي سالب (مرتجعات > مبيعات) يُرسم ويُحسب كما هو.
//   • صفّان لنفس اليوم لا يُجمعان (يُعتمد الأحدث).
//   • الجلب يطلب صافي المبيعات وعدّادات الفواتير فقط، من ameen_daily_profit.
//   • الرسم موضوع فوق «ملخص الحركة اليومية» ولا يمسّ دالته.
// ============================================================================
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const context = { console, Date, Math, Number, String, Array, Object, Map, Intl, RegExp, JSON };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(read("src/daily-sales-chart.js"), context, { filename: "daily-sales-chart.js" });
const C = context.ozkDailySalesChart;
assert.ok(C, "ozkDailySalesChart must be installed");
const plain = (v) => JSON.parse(JSON.stringify(v));

// 1) أيام الشهر الفعلية
assert.equal(C.daysInMonth(2026, 2), 28);
assert.equal(C.daysInMonth(2028, 2), 29);
assert.equal(C.daysInMonth(2026, 11), 30);
assert.equal(C.daysInMonth(2026, 12), 31);
assert.equal(C.buildMonth([], "2028-02", "2028-03-10").days.length, 29);
assert.equal(C.buildMonth([], "2026-11", "2026-12-01").days.length, 30);
assert.equal(C.shiftMonth("2026-01", -1), "2025-12");
assert.equal(C.shiftMonth("2026-12", 1), "2027-01");
assert.deepEqual(plain(C.monthRange("2026-02")), { from: "2026-02-01", to: "2026-02-28" });
assert.equal(C.monthLabel("2026-11"), "تشرين الثاني 2026");

// 2) توقيت دمشق (UTC+3): 21:30Z يوم 30 = 00:30 يوم 1 بدمشق
assert.equal(C.damascusToday(new Date("2026-11-30T21:30:00Z")), "2026-12-01");
assert.equal(C.damascusToday(new Date("2026-11-30T20:30:00Z")), "2026-11-30");

// 3) الحالات: قيمة / صفر / بلا بيانات / مستقبل / مكرر / سالب
const rows = [
  { report_date: "2026-11-01", net_sales: 1000.5, sales_bill_count: 10, return_bill_count: 0, synced_at: "2026-11-01T21:59:00Z" },
  { report_date: "2026-11-02", net_sales: 0, sales_bill_count: 0, return_bill_count: 0, synced_at: "2026-11-02T21:59:00Z" },
  // 2026-11-03 لا تقرير ⇒ missing
  { report_date: "2026-11-04", net_sales: -250, sales_bill_count: 1, return_bill_count: 2, synced_at: "2026-11-04T21:59:00Z" },
  { report_date: "2026-11-05", net_sales: 300, sales_bill_count: 3, return_bill_count: 0, synced_at: "2026-11-05T10:00:00Z" },
  { report_date: "2026-11-05", net_sales: 500, sales_bill_count: 5, return_bill_count: 0, synced_at: "2026-11-05T21:59:00Z" },
  { report_date: "2026-11-06", net_sales: "1200.25", sales_bill_count: 9, return_bill_count: 1, synced_at: "2026-11-06T09:00:00Z" },
  { report_date: "2026-11-07", net_sales: null, sales_bill_count: 0, return_bill_count: 0 },
  { report_date: "2026-11-20", net_sales: 999, sales_bill_count: 1, return_bill_count: 0 } // مستقبلي بالنسبة لليوم ⇒ يُتجاهل
];
const month = C.buildMonth(rows, "2026-11", "2026-11-06");
const byDay = (d) => month.days[d - 1];
assert.equal(month.days.length, 30);
assert.equal(byDay(1).state, "value"); assert.equal(byDay(1).value, 1000.5);
assert.equal(byDay(2).state, "value"); assert.equal(byDay(2).value, 0, "يوم بتقرير بلا فواتير = صفر");
assert.equal(byDay(3).state, "missing", "يوم بلا تقرير = لا بيانات، لا صفر");
assert.equal(byDay(3).value, null);
assert.equal(byDay(4).value, -250, "صافي سالب يبقى سالباً");
assert.equal(byDay(5).value, 500, "صفّان لنفس اليوم: الأحدث، بلا جمع");
assert.equal(byDay(6).value, 1200.25); assert.equal(byDay(6).isToday, true);
assert.equal(byDay(7).state, "future");
assert.equal(byDay(20).state, "future", "صف مستقبلي لا يُرسم");
assert.equal(byDay(20).value, null);

const s = C.monthStats(month);
assert.equal(s.knownDays, 5);
assert.equal(s.missingDays, 1);
assert.equal(s.total, 2450.75);
assert.equal(s.average, 490.15, "المقام 5 أيام بيانات لا 6 أيام منقضية");
assert.deepEqual(plain(s.max), { value: 1200.25, date: "2026-11-06" });
assert.deepEqual(plain(s.min), { value: -250, date: "2026-11-04" });
const tie = C.monthStats(C.buildMonth([
  { report_date: "2026-10-02", net_sales: 0 }, { report_date: "2026-10-09", net_sales: 0 }
], "2026-10", "2026-10-31"));
assert.equal(tie.min.date, "2026-10-02", "التعادل: أول يوم");
const none = C.monthStats(C.buildMonth([], "2026-10", "2026-10-31"));
assert.equal(none.knownDays, 0); assert.equal(none.average, null); assert.equal(none.missingDays, 31);
assert.equal(none.minPositive, null);

// 3ب) «أدنى مبيع فعلي»: أقل قيمة موجبة؛ الصفر والسالب وبلا بيانات والمستقبل خارجه
assert.deepEqual(plain(s.minPositive), { value: 500, date: "2026-11-05" }, "الصفر (2/11) والسالب (4/11) مستبعدان");
assert.deepEqual(plain(s.min), { value: -250, date: "2026-11-04" }, "min القديم لم يتغيّر");
const futureLow = C.monthStats(C.buildMonth([
  { report_date: "2026-11-01", net_sales: 900 }, { report_date: "2026-11-02", net_sales: 0 },
  { report_date: "2026-11-20", net_sales: 5 } // مستقبلي ⇒ خارج المؤشر
], "2026-11", "2026-11-10"));
assert.deepEqual(plain(futureLow.minPositive), { value: 900, date: "2026-11-01" });
const allZero = C.monthStats(C.buildMonth([
  { report_date: "2026-12-04", net_sales: 0 }, { report_date: "2026-12-11", net_sales: 0 }
], "2026-12", "2026-12-31"));
assert.equal(allZero.knownDays, 2); assert.equal(allZero.minPositive, null, "لا مبيعات موجبة ⇒ null");
assert.equal(allZero.total, 0);
const tiePos = C.monthStats(C.buildMonth([
  { report_date: "2026-10-03", net_sales: 10 }, { report_date: "2026-10-08", net_sales: 10 }
], "2026-10", "2026-10-31"));
assert.equal(tiePos.minPositive.date, "2026-10-03", "التعادل: أول يوم");
// اليوم الحالي غير مكتمل ⇒ خارج «أدنى مبيع فعلي»، لكنه باقٍ في الإجمالي والمتوسط والرسم
const todayLow = C.monthStats(C.buildMonth([
  { report_date: "2026-11-01", net_sales: 900 }, { report_date: "2026-11-02", net_sales: 0 },
  { report_date: "2026-11-03", net_sales: 50 } // اليوم الحالي
], "2026-11", "2026-11-03"));
assert.deepEqual(plain(todayLow.minPositive), { value: 900, date: "2026-11-01" }, "اليوم الحالي مستبعد");
assert.equal(todayLow.total, 950); assert.equal(todayLow.knownDays, 3);
assert.equal(todayLow.average, 316.67);
const onlyToday = C.monthStats(C.buildMonth([{ report_date: "2026-11-01", net_sales: 70 }], "2026-11", "2026-11-01"));
assert.equal(onlyToday.minPositive, null, "اليوم الحالي وحده ⇒ لا توجد مبيعات");
assert.equal(onlyToday.total, 70);
// أيام الصفر تبقى مرسومة كنقاط على الخط
assert.equal((C.renderSvg(C.buildMonth([
  { report_date: "2026-12-04", net_sales: 0 }, { report_date: "2026-12-05", net_sales: 100 }
], "2026-12", "2026-12-05"), 600).match(/class="dsc-dot/g) || []).length, 2);
const future = C.buildMonth([], "2027-01", "2026-11-25");
assert.ok(future.days.every((d) => d.state === "future"));

// 4) التنسيق: أرقام إنجليزية والدولار قبل الرقم
assert.equal(C.formatUsd(1234567.891), "$1,234,567.89");
assert.equal(C.formatUsd(-250), "-$250.00");
assert.equal(C.formatUsd(0), "$0.00");
assert.equal(C.formatAxisUsd(25000), "$25K");
assert.equal(C.formatAxisUsd(1500000), "$1.5M");
assert.equal(C.formatAxisUsd(-500), "-$500");
assert.doesNotMatch(C.formatUsd(9876.5), /[٠-٩]/);

// 5) الرسم: الخط ينقطع عند يوم بلا بيانات، والمستقبل بلا نقاط
const svg = C.renderSvg(month, 700);
assert.match(svg, /<svg class="dsc-svg" width="700"/);
assert.equal((svg.match(/class="dsc-line"/g) || []).length, 2, "مقطعان: 1-2 ثم 4-6");
assert.equal((svg.match(/class="dsc-missing"/g) || []).length, 1);
assert.equal((svg.match(/class="dsc-dot/g) || []).length, 5);
assert.match(svg, /dsc-zero/);
assert.match(C.renderSvg(month, 360), /width="360"/);
const tipNa = C.tooltipHtml(byDay(3));
assert.match(tipNa, /لا تتوفر بيانات/);
assert.match(C.tooltipHtml(byDay(4)), /-\$250\.00/);
assert.match(C.tooltipHtml(byDay(4)), /2 مرتجع/);

// 6) الجلب: مصدر ameen_daily_profit وحقول المبيعات فقط (لا تكلفة ولا ربح)
const client = read("src/supabase-client.js");
const fetchBody = client.slice(client.indexOf("async getDailySalesSeries("), client.indexOf("async listCustomerBalanceReports("));
assert.ok(fetchBody.length > 0, "getDailySalesSeries missing");
assert.match(fetchBody, /\.eq\("source", "ameen_daily_profit"\)/);
assert.match(fetchBody, /net_sales:summary->net_sales/);
const selectArg = (fetchBody.match(/\.select\("([^"]*)"\)/) || [])[1] || "";
assert.equal(
  selectArg.split(",").map((f) => f.trim().split(":")[0]).join("|"),
  "report_date|net_sales|sales_bill_count|return_bill_count|synced_at",
  "الحقول المطلوبة محصورة بالمبيعات"
);
assert.doesNotMatch(selectArg, /cost|profit|expenses|\*/);
assert.match(fetchBody, /\.gte\("report_date"/);
assert.match(fetchBody, /\.lte\("report_date"/);

// 7) الربط في الصفحة: فوق «ملخص الحركة اليومية»، المالك وحده، والملخص لم يُمسّ
const app = read("src/app.js");
const reports = app.slice(app.indexOf("function reportsPage()"));
const chartAt = reports.indexOf("${dailySalesChartSection()}");
const summaryAt = reports.indexOf("📊 ملخص الحركة اليومية");
assert.ok(chartAt > 0 && chartAt < summaryAt, "الرسم يجب أن يسبق ملخص الحركة اليومية مباشرة");
const loader = app.slice(app.indexOf("async function loadSalesChartMonth("), app.indexOf("function dailySalesChartSection("));
assert.match(loader, /!isOwner\(\)/, "لا طلب لحساب غير المالك");
const kpis = app.slice(app.indexOf("function salesChartKpisMarkup("), app.indexOf("function salesChartPendingMarkup("));
assert.match(kpis, /"أدنى مبيع فعلي"/);
assert.match(kpis, /stats\.minPositive/);
assert.match(kpis, /"لا توجد مبيعات"/);
assert.doesNotMatch(kpis, /"أدنى يوم"|stats\.min\./, "المؤشر لم يعد يقرأ أدنى قيمة مطلقة");
const dm = app.slice(app.indexOf("function dailyMovementSection()"), app.indexOf("function reportsPage()"));
assert.doesNotMatch(dm, /salesChart|ozkDailySalesChart/, "ملخص الحركة اليومية لا يُعدَّل");

// 8) الأصل الجديد محمّل بمعامل النسخة ومُدرج في كاش Service Worker
const html = read("index.html");
assert.match(html, /<script src="src\/daily-sales-chart\.js\?v=tobacco-\d+" defer><\/script>/);
assert.ok(html.indexOf("src/daily-sales-chart.js") < html.indexOf("src/app.js?"), "قبل app.js");
assert.match(read("public/service-worker.js"), /"src\/daily-sales-chart\.js"/);

console.log("daily sales chart: OK");
