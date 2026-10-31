// ============================================================================
// فحص دمج الفواتير الفورية (src/live-invoices.js) فوق تقرير ameen_customer_invoices.
//
// كل حالة هنا تمنع خطأً محاسبياً محدداً في ورقة تُعرض أو تُطبع للزبون:
//   • الأحدث يفوز، والصف الأقدم من لقطة التقرير لا يُستعمل.
//   • السطر بوحدة إدخاله (bi000.Unity) والقيمة Price × Qty ÷ factor.
//   • مجموع لا يطابق bu000.Total، أو مادة/وحدة مجهولة ⇒ تبقى نسخة التقرير.
//   • الحذف يزيل الفاتورة، ونقلها لزبون آخر لا يتركها عند الأول.
//   • الفواتير بلا اسم زبون (كاشير) لا تدخل، كما في التقرير.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../src/live-invoices.js";

const L = globalThis.ozkLiveInvoices;
assert.ok(L, "src/live-invoices.js لم يعرّف ozkLiveInvoices");

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const CUST_A = G(101), CUST_B = G(102);
const ITEM_X = G(201), ITEM_Y = G(202), ITEM_NEW = G(203), ITEM_UNKNOWN = G(299);

function reportLine(itemGuid, material, qty, price, unit = 2) {
  return { itemGuid, material, qty, qtyUnits: qty / 50, price, lineTotal: price * qty / (unit === 2 ? 50 : 1),
    lineTotalSource: "ameen", unit1: "كروز", unit2: "كرتونة", unit2Fact: 50, unit3: "", unit3Fact: 0, inputUnit: unit };
}

function baseReport() {
  return {
    source: "ameen_customer_invoices",
    created_at: "2026-10-31T15:00:05Z",
    summary: { payloadVersion: 2, periodDays: 60, fromDate: "2026-09-01", customers: 1, bills: 2, syncedAt: "2026-10-31T15:00:00.000Z" },
    items: [{
      name: "زبون أ", customerGuid: CUST_A, customerAccountGuid: "", truncated: false,
      invoices: [
        { number: "100", date: "2026-10-30", customerGuid: CUST_A, currency: "USD", currencyVal: 1, guid: G(1),
          total: 572, discount: 0, payment: 0, isReturn: false,
          lines: [reportLine(ITEM_X, "مادة س", 100, 286), reportLine(ITEM_Y, "مادة ص", 10, 0, 1)] },
        { number: "99", date: "2026-10-29", customerGuid: CUST_A, currency: "SYP", currencyVal: 0.00007, guid: G(2),
          total: 22, discount: 0, payment: 0, isReturn: false, lines: [reportLine(ITEM_Y, "مادة ص", 10, 2.2, 1)] }
      ]
    }]
  };
}

function liveRow(guid, { at = "2026-10-31T15:30:00Z", seq = 5, status = "active", number = 101, date = "2026-10-31",
  customer = CUST_A, name = "زبون أ", total, lines, currencyVal = 1, billType = 1, disc = 0, extra = 0, firstPay = 0 } = {}) {
  return {
    bill_guid: guid, bill_type: billType, status, source_event_at: at, source_seq: seq, bill_number: number,
    bill_date: date, customer_guid: customer, is_named: Boolean(name),
    payload: { bill_guid: guid, bill_type: billType, number, bill_date: date, customer_guid: customer, customer_name: name,
      currency_val: currencyVal, total, total_disc: disc, total_extra: extra, first_pay: firstPay, lines }
  };
}
const ln = (item, qty, price, unity) => ({ item_guid: item, qty, price, unity });
const priceItems = [{ item_guid: ITEM_NEW.toUpperCase(), item_name: "مادة جديدة", unit1_name: "كروز", unit2_name: "كرتونة", unit2_factor: 10 }];

function invoices(report) { return report.items.flatMap((e) => e.invoices.map((inv) => ({ ...inv, owner: e.customerGuid, ownerName: e.name }))); }
function byGuid(report, g) { return invoices(report).find((inv) => inv.guid === g); }

test("فاتورة جديدة تُضاف لمجموعة زبونها بالمعرّف، بوحدة إدخال كل سطر", () => {
  const row = liveRow(G(3), { total: 286 + 22, lines: [ln(ITEM_X, 50, 286, 2), ln(ITEM_Y, 10, 2.2, 1)] });
  const { report, stats } = L.mergeLiveInvoices(baseReport(), [row]);
  assert.equal(stats.added, 1);
  const inv = byGuid(report, G(3));
  assert.ok(inv, "الفاتورة الجديدة غائبة");
  assert.equal(inv.owner, CUST_A);
  assert.equal(inv.number, "101");
  assert.equal(inv.currency, "USD");
  assert.equal(inv.lines[0].material, "مادة س");
  assert.equal(inv.lines[0].inputUnit, 2);
  assert.equal(inv.lines[0].lineTotal, 286);
  assert.equal(inv.lines[1].lineTotal, 22);
  assert.equal(report.summary.bills, 3);
  assert.equal(report.items[0].invoices[0].guid, G(3), "الأحدث تاريخاً أولاً");
});

test("تعديل فاتورة قائمة يستبدل نسخة التقرير بالكامل", () => {
  const row = liveRow(G(1), { number: 100, date: "2026-10-30", total: 858, lines: [ln(ITEM_X, 150, 286, 2)] });
  const { report, stats } = L.mergeLiveInvoices(baseReport(), [row]);
  assert.equal(stats.replaced, 1);
  const inv = byGuid(report, G(1));
  assert.equal(inv.total, 858);
  assert.equal(inv.lines.length, 1);
  assert.equal(inv.live, true);
  assert.equal(report.summary.bills, 2);
});

test("صف فوري أقدم من لقطة التقرير (بعد الهامش) لا يُستعمل", () => {
  const row = liveRow(G(1), { at: "2026-10-31T14:40:00Z", total: 858, lines: [ln(ITEM_X, 150, 286, 2)] });
  const base = baseReport();
  const { report, stats } = L.mergeLiveInvoices(base, [row]);
  assert.equal(stats.olderThanReport, 1);
  assert.equal(report, base, "التقرير يجب أن يبقى نفس الكائن");
});

test("صف داخل هامش قراءة التقرير يفوز (تعديل بين قراءة التقرير ورفعه)", () => {
  const row = liveRow(G(1), { at: "2026-10-31T14:55:00Z", number: 100, date: "2026-10-30", total: 858, lines: [ln(ITEM_X, 150, 286, 2)] });
  const { report } = L.mergeLiveInvoices(baseReport(), [row]);
  assert.equal(byGuid(report, G(1)).total, 858);
});

test("مجموع أسطر لا يطابق إجمالي الأمين ⇒ تبقى نسخة التقرير", () => {
  const row = liveRow(G(1), { total: 900, lines: [ln(ITEM_X, 150, 286, 2)] });
  const base = baseReport();
  const { report, stats } = L.mergeLiveInvoices(base, [row]);
  assert.equal(stats.rejected.total_mismatch, 1);
  assert.equal(report, base);
  assert.equal(byGuid(report, G(1)).total, 572);
});

test("مادة غير معروفة أو وحدة ثالثة بلا معامل ⇒ رفض النسخة الفورية", () => {
  const a = L.mergeLiveInvoices(baseReport(), [liveRow(G(4), { total: 10, lines: [ln(ITEM_UNKNOWN, 1, 10, 1)] })]);
  assert.equal(a.stats.rejected.unknown_item, 1);
  const b = L.mergeLiveInvoices(baseReport(), [liveRow(G(4), { total: 10, lines: [ln(ITEM_X, 1, 10, 3)] })]);
  assert.equal(b.stats.rejected.unit, 1);
});

test("اسم المادة ومعاملها من لائحة الأسعار حين لا تظهر في التقرير", () => {
  const row = liveRow(G(5), { total: 30, lines: [ln(ITEM_NEW, 20, 15, 2)] });
  const { report } = L.mergeLiveInvoices(baseReport(), [row], { priceItems });
  const inv = byGuid(report, G(5));
  assert.equal(inv.lines[0].material, "مادة جديدة");
  assert.equal(inv.lines[0].unit2Fact, 10);
  assert.equal(inv.lines[0].qtyUnits, 2);
});

test("الحذف يزيل الفاتورة", () => {
  const { report, stats } = L.mergeLiveInvoices(baseReport(), [liveRow(G(2), { status: "deleted", total: 0, lines: [] })]);
  assert.equal(stats.removed, 1);
  assert.equal(byGuid(report, G(2)), undefined);
  assert.equal(report.summary.bills, 1);
});

test("نقل الفاتورة لزبون آخر يزيلها من الأول ويسمّي المجموعة الجديدة من الأرصدة", () => {
  const row = liveRow(G(1), { customer: CUST_B, name: "نص على رأس الفاتورة", total: 572, lines: [ln(ITEM_X, 100, 286, 2), ln(ITEM_Y, 10, 0, 1)] });
  const { report } = L.mergeLiveInvoices(baseReport(), [row], { balanceItems: [{ name: "زبون ب الرسمي", customerGuid: CUST_B }] });
  const inv = byGuid(report, G(1));
  assert.equal(inv.owner, CUST_B);
  assert.equal(inv.ownerName, "زبون ب الرسمي");
  assert.equal(invoices(report).filter((i) => i.guid === G(1)).length, 1);
});

test("نقل فاتورة من زبون بحساب إلى اسم بلا حساب، والعكس، يغيّر مجموعتها", () => {
  const toNameOnly = liveRow(G(1), { customer: null, name: "زبون ج بلا حساب", total: 572, lines: [ln(ITEM_X, 100, 286, 2), ln(ITEM_Y, 10, 0, 1)] });
  const a = L.mergeLiveInvoices(baseReport(), [toNameOnly]).report;
  const moved = byGuid(a, G(1));
  assert.equal(moved.owner, "");
  assert.equal(moved.ownerName, "زبون ج بلا حساب");
  assert.equal(invoices(a).filter((i) => i.guid === G(1)).length, 1);

  const base = baseReport();
  base.items.push({ name: "زبون د", customerGuid: "", invoices: [{ ...base.items[0].invoices[1], guid: G(10), customerGuid: "" }] });
  const toAccount = liveRow(G(10), { customer: CUST_B, name: "زبون د", total: 22, lines: [ln(ITEM_Y, 10, 2.2, 1)] });
  const b = L.mergeLiveInvoices(base, [toAccount], { balanceItems: [{ name: "زبون ب", customerGuid: CUST_B }] }).report;
  assert.equal(byGuid(b, G(10)).owner, CUST_B);
  assert.ok(!b.items.some((e) => e.name === "زبون د"), "المجموعة القديمة بلا معرّف تفرغ فتُحذف");
});

test("تعديل فاتورة بنفس الهوية (نص اسم مختلف ومعرّف واحد) يبقيها في مكانها", () => {
  const row = liveRow(G(1), { name: "نص اسم آخر", number: 100, date: "2026-10-30", total: 858, lines: [ln(ITEM_X, 150, 286, 2)] });
  const { report } = L.mergeLiveInvoices(baseReport(), [row]);
  assert.equal(report.items.length, 1);
  assert.equal(byGuid(report, G(1)).ownerName, "زبون أ");
});

test("فاتورة بلا اسم زبون (كاشير) لا تدخل، كما في التقرير", () => {
  const { stats } = L.mergeLiveInvoices(baseReport(), [liveRow(G(6), { name: null, customer: null, total: 22, lines: [ln(ITEM_Y, 10, 2.2, 1)] })]);
  assert.equal(stats.rejected.unnamed, 1);
});

test("عملة الليرة تُستنتج من التقرير بمعدّلها، والمرتجع يبقى مرتجعاً", () => {
  const row = liveRow(G(7), { billType: 3, currencyVal: 0.00007, total: 22, lines: [ln(ITEM_Y, 10, 2.2, 1)] });
  const inv = byGuid(L.mergeLiveInvoices(baseReport(), [row]).report, G(7));
  assert.equal(inv.currency, "SYP");
  assert.equal(inv.currencyVal, 0.00007);
  assert.equal(inv.isReturn, true);
});

test("فاتورة أقدم من نافذة التقرير لا تُضاف", () => {
  const { stats } = L.mergeLiveInvoices(baseReport(), [liveRow(G(8), { date: "2026-08-01", total: 22, lines: [ln(ITEM_Y, 10, 2.2, 1)] })]);
  assert.equal(stats.outOfWindow, 1);
});

test("الحسم والدفعة الأولى تُنقلان كما هما، ولا يتغيّر الإجمالي", () => {
  const row = liveRow(G(9), { total: 286, disc: 6, firstPay: 100, lines: [ln(ITEM_X, 50, 286, 2)] });
  const inv = byGuid(L.mergeLiveInvoices(baseReport(), [row]).report, G(9));
  assert.equal(inv.total, 286);
  assert.equal(inv.discount, 6);
  assert.equal(inv.payment, 100);
});

test("بلا صفوف فورية يبقى التقرير نفس الكائن", () => {
  const base = baseReport();
  assert.equal(L.mergeLiveInvoices(base, []).report, base);
});

test("liveFetchSince = لقطة التقرير ناقص الهامش", () => {
  assert.equal(L.liveFetchSince(baseReport(), Date.parse("2026-10-31T16:00:00Z")), "2026-10-31T14:50:00.000Z");
  assert.equal(L.liveFetchSince(null, Date.parse("2026-10-31T16:00:00Z")), "2026-10-30T16:00:00.000Z");
});

test("الموقع يحمّل الوحدة قبل app.js ويخزّنها في الكاش، ويقرأ الجدول بالقراءة فقط", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const pos = (n) => html.indexOf(n);
  assert.ok(pos("src/live-invoices.js?v=tobacco-") > 0 && pos("src/live-invoices.js") < pos("src/app.js"));
  const sw = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
  assert.ok(sw.includes('"src/live-invoices.js"'));
  const client = readFileSync(new URL("../src/supabase-client.js", import.meta.url), "utf8");
  const fn = client.slice(client.indexOf("async listLiveAmeenInvoices"), client.indexOf("async getPurchaseInvoicesAmeenReport"));
  assert.ok(fn.includes('.from("ameen_invoices")'));
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(fn), "قراءة الفواتير الفورية يجب أن تبقى قراءة فقط");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const poll = app.slice(app.indexOf("// الفواتير الفورية: قراءة خفيفة كل 10 ثوانٍ"));
  assert.ok(/state\.route === "sales" && state\.salesHistoryOpen/.test(poll.slice(0, 1500)), "شاشة «الفواتير السابقة» يجب أن تتحدّث فورياً");
  const loader = app.slice(app.indexOf("async function loadLiveInvoices()"), app.indexOf("// ===== هوية الزبون والفاتورة"));
  assert.ok(/prices === state\.liveInvoicesPrices/.test(loader), "تغيّر لائحة الأسعار يجب أن يُبطل ذاكرة الدمج");
  const pricesLoader = app.slice(app.indexOf("async function loadApprovedPriceItems()"));
  assert.ok(/await loadLiveInvoices\(\);\n\}/.test(pricesLoader.slice(0, 900)), "وصول لائحة الأسعار يعيد دمج الفواتير الفورية");
  const engine = readFileSync(new URL("../src/live-invoices.js", import.meta.url), "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|\.from\(/.test(engine), "منطق الدمج يجب أن يبقى نقياً بلا شبكة");
});

console.log("check-live-invoices:");
console.log(results.join("\n"));
if (failed) { console.error(`\n${failed} فحص فشل`); process.exit(1); }
console.log(`\nكل الفحوص نجحت (${results.length})`);
