// ============================================================================
// Master Invoice — Phase 2: **مرتجع المبيعات على قالب الفاتورة الرئيسي.**
//
// ما يثبّته:
//   · المرتجع يُرسم بـOZK_INVOICE.markup (`kind: "return"`) لا بقالب التقارير القديم،
//     بنفس أسطر الأصناف ونفس صفوف الدفتر التي كان يطبعها القديم حرفاً بحرف
//     (شاهدا #48 و#32، الأرقام حقيقية والأسماء مصطنعة).
//   · البوابة `isInv || isRet` وحدها: سند القبض والصرف وأي نوع آخر يبقى على القديم
//     ومخرجاته لم تتغيّر بايتاً (بصمات ملتقطة من main 2c0d094 قبل التعديل).
//   · فاتورة البيع لم تتغيّر بايتاً (بصمات من main نفسه).
//   · حارس رصيد المرتجع: الرصيد الحالي أو المفرد لا يُطبع على مرتجع مهما مرّره
//     المستدعي، والسابق/الجديد لا يُطبعان إلا من قيد مثبت (applyReturnLedger).
//   · مرتجع بلا قيد مثبت (fail closed) يحمل ملاحظة محايدة لا تدّعي أثراً على الذمة.
//   · نقاط الدخول الثلاث القائمة لمرتجع المبيعات تنتهي كلها إلى هذا المسار.
//
// يشغّل **الكود الحقيقي** من `src/app.js` و`src/documents/invoice/ozk-invoice.js` داخل vm.
// ============================================================================

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const invoiceJs = readFileSync(new URL("../src/documents/invoice/ozk-invoice.js", import.meta.url), "utf8");

const PATTERNS = {
  SALES_TRADE_CONSTS: /const SALES_TRADE_REGISTER_NO = [^\n]*\nconst SALES_TRADE_CAPACITY = [^\n]*\n/,
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  normGuid: /function normGuid\(value\) \{[\s\S]*?\n\}\n/,
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  invoicePriceBasis: /function invoicePriceBasis\(inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineBasis: /function invoiceLineBasis\(line\) \{[\s\S]*?\n\}\n/,
  invoiceBasisTolerance: /function invoiceBasisTolerance\(lines\) \{[\s\S]*?\n\}\n/,
  invoiceLineCandidates: /function invoiceLineCandidates\(line\) \{[\s\S]*?\n\}\n/,
  INVOICE_BASIS_CONSTS: /const INVOICE_BASIS_SEARCH_BUDGET = [^\n]*\n[\s\S]*?const INVOICE_BASIS_PLAN_CACHE = [^\n]*\n/,
  invoiceLineBasisPlan: /function invoiceLineBasisPlan\(inv\) \{[\s\S]*?\n\}\n/,
  computeInvoiceLineBasisPlan: /function computeInvoiceLineBasisPlan\(lines, total\) \{[\s\S]*?\n\}\n/,
  invoiceLineTotalValue: /function invoiceLineTotalValue\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineValueText: /function invoiceLineValueText\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineQtyParts: /function invoiceLineQtyParts\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineQty: /function invoiceLineQty\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineUnitPrice: /function invoiceLineUnitPrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLinePrice: /function invoiceLinePrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  returnLedgerBalances: /function returnLedgerBalances\(inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  applyReturnLedger: /function applyReturnLedger\(opts, inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  balanceText: /function balanceText\(bal, cur\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRows: /function voucherLedgerRows\(v\) \{[\s\S]*?\n\}\n/,
  voucherAccountBalanceRow: /function voucherAccountBalanceRow\(rows, v, balCur\) \{[\s\S]*?\n\}\n/,
  voucherInvoiceBalanceRows: /function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
  voucherSingleBalanceRows: /function voucherSingleBalanceRows\(rows, v, cur, balCur, isInv, isRet, balLabel\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRowHtml: /function voucherLedgerRowHtml\(row\) \{[\s\S]*?\n\}\n/,
  RETURN_NOTE_UNPROVEN: /const RETURN_NOTE_UNPROVEN = [^\n]*\n/,
  returnLedgerView: /function returnLedgerView\(v\) \{[\s\S]*?\n\}\n/,
  saleInvoiceDocument: /function saleInvoiceDocument\(v\) \{[\s\S]*?\n\}\n/,
  voucherPdfMarkup: /function voucherPdfMarkup\(v\) \{[\s\S]*?\n\}\n/,
  exportVoucherPdf: /async function exportVoucherPdf\(v\) \{[\s\S]*?\n\}\n/
};

const source = [];
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const found = appJs.match(pattern);
  if (!found) {
    failed += 1;
    results.push(`  ❌ استخراج ${name}\n     لم أجد التعريف في src/app.js`);
    continue;
  }
  source.push(found[0]);
}

const escapeHtml = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// التصدير نفسه يُلتقط بلا متصفح: ما يُرسم وأين يُؤرشف.
const exported = [];
const sandbox = {
  console,
  Intl,
  state: {},
  escapeHtml,
  shortDateTime: () => "2026-09-14 10:00",
  docNumber: (prefix) => `${prefix}-20260914-0001`,
  REPORT_STYLE: "<style>/* report */</style>",
  todayIsoDate: () => "2026-09-14",
  exportReportPdf: async (html, archive) => { exported.push({ html, archive }); return true; },
  setNotice: () => {},
  render: () => {}
};
vm.createContext(sandbox);
vm.runInContext(invoiceJs, sandbox);
vm.runInContext(source.join("\n"), sandbox);
const OZK_INVOICE = vm.runInContext("OZK_INVOICE", sandbox);
const { voucherPdfMarkup, saleInvoiceDocument, applyReturnLedger, exportVoucherPdf } = sandbox;
const own = (value) => JSON.parse(JSON.stringify(value));
const sha = (text) => createHash("sha256").update(text).digest("hex");

// نص الصفحة المرئي بلا وسوم ولا RLM، لفحص الادعاءات المطبوعة.
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\u200f/g, "").replace(/\s+/g, " ");
const cells = (html) => [...html.matchAll(/<tr><td>([\s\S]*?)<\/td>(<td>[\s\S]*?<\/td>)(<td>[\s\S]*?<\/td>)(<td>[\s\S]*?<\/td>)<\/tr>/g)]
  .map((m) => [m[1], visible(m[2]).trim(), visible(m[3]).trim(), visible(m[4]).trim()]);
const ledgerRows = (html) => [...html.matchAll(/<tr><th[^>]*>([^<]*)<\/th><td([^>]*)>([\s\S]*?)<\/td><\/tr>/g)]
  .map((m) => [m[1], visible(m[3]).trim(), (m[2].match(/class="(\w+)"/) || [])[1] || ""]);

// ===== شواهد مجهّلة (الأرقام حقيقية) =====

// #48: أربعة أصناف، شرحة وكرتونة، «علبة» وحدةً صغرى، وكميات كسرية؛ أسطر `derived`.
const LINES_48 = [
  { material: "مادة أ", qty: 3, qtyUnits: 0.25, unit1: "كروز", unit2: "شرحة", price: 11.83, lineTotal: 35.49, lineTotalSource: "derived" },
  { material: "مادة ب", qty: 3, qtyUnits: 0.25, unit1: "علبة", unit2: "شرحة", price: 11.83, lineTotal: 35.49, lineTotalSource: "derived" },
  { material: "مادة ج", qty: 3, qtyUnits: 0.125, unit1: "كروز", unit2: "شرحة", price: 5.92, lineTotal: 17.76, lineTotalSource: "derived" },
  { material: "مادة د", qty: 8, qtyUnits: 0.16, unit1: "كروز", unit2: "كرتونة", price: 8.06, lineTotal: 64.48, lineTotalSource: "derived" }
];
const INV_48 = { guid: "00000000-0000-4000-8000-000000000048", number: "48", date: "2026-09-14", total: 153.22, discount: 0, payment: 0, isReturn: true, customerGuid: "00000000-0000-4000-8000-0000000000a1", lines: LINES_48 };
const LINES_32 = [
  { material: "مادة هـ", qty: 20, qtyUnits: 2, unit1: "كروز", unit2: "كرتونة", price: 21.001, lineTotal: 420.02, lineTotalSource: "derived" }
];
const INV_32 = { guid: "00000000-0000-4000-8000-000000000032", number: "32", date: "2026-08-26", total: 420.02, discount: 0.02, payment: 0, isReturn: true, customerGuid: "00000000-0000-4000-8000-0000000000b1", lines: LINES_32 };

// نفس أشكال `opts` التي يبنيها المعالجان القائمان في src/app.js:
//   E1 gen-movement-doc (لوحة الزبون): base + notes + phone، ثم applyReturnLedger من بيانات الزر.
//   E2/E3 gen-invoice-doc (فواتير التقارير / الفواتير السابقة): بلا notes/phone، ثم applyReturnLedger(ForBill).
const movementOpts = (inv, name, docPrev, docNew) => applyReturnLedger({
  name, phone: "0900000000", date: inv.date, notes: "مرتجع مبيعات", cur: "$",
  type: "return", amount: inv.total, no: String(inv.number), lines: inv.lines
}, inv, docPrev, docNew);
const listOpts = (inv, name, docPrev, docNew) => applyReturnLedger({
  type: "return", name, amount: inv.total, cur: "$", date: inv.date, no: String(inv.number), lines: inv.lines
}, inv, docPrev, docNew);

const NOTE_PROVEN = "هذا سند رسمي بقيمة البضاعة المرتجعة إلى OZK TOBACCO — خُصمت من رصيد حسابكم.";
const NOTE_NEUTRAL = "هذا سند رسمي بقيمة البضاعة المرتجعة إلى OZK TOBACCO.";
const noteOf = (html) => { const m = html.match(/<p class="muted" style="margin:8px 0 0">([^<]*)<\/p>/); return m ? m[1] : null; };
const BALANCE_WORDS = /الرصيد|رصيد الحساب|\(عليكم\)|\(لكم\)|مسدّد/;

// ===== 1) #48: مرتجع زبون عادي =====

test("#48 (مسار لوحة الزبون): قالب رئيسي، أسطر ودفتر مطابقة للقيم المثبتة", () => {
  const html = voucherPdfMarkup(movementOpts(INV_48, "زبون أ", 36273.646, 36120.426));
  assert.ok(html.includes('class="ozk-inv"'), "المرتجع لم يصل إلى القالب الرئيسي");
  assert.ok(!html.includes("ozk-rpt"), "المرتجع ما زال على قالب التقارير");
  assert.deepEqual(cells(html), [
    ["مادة أ", "0.25 شرحة 3 كروز", "141.96 $ / شرحة", "35.49"],
    ["مادة ب", "0.25 شرحة 3 علبة", "141.96 $ / شرحة", "35.49"],
    ["مادة ج", "0.125 شرحة 3 كروز", "142.08 $ / شرحة", "17.76"],
    ["مادة د", "0.16 كرتونة 8 كروز", "403 $ / كرتونة", "64.48"]
  ]);
  assert.deepEqual(ledgerRows(html), [
    ["التاريخ", "2026-09-14", ""],
    ["البيان", "مرتجع مبيعات", ""],
    ["الرصيد السابق", "36,273.646 $ (عليكم)", ""],
    ["قيمة هذا المرتجع", "153.22 $", ""],
    ["الرصيد الجديد", "36,120.426 $ (عليكم)", ""]
  ]);
  assert.equal(noteOf(html), NOTE_PROVEN, "مرتجع بقيد مثبت فقد ملاحظته الأصلية");
});

test("#48: أسطر الأصناف نفس نصوص invoiceLine* (لا حساب جديد في القالب)", () => {
  const doc = saleInvoiceDocument(movementOpts(INV_48, "زبون أ", 36273.646, 36120.426));
  const inv = { total: INV_48.total, lines: LINES_48 };
  assert.deepEqual(own(doc.lines.map((l) => [l.qtyText, l.priceText, l.valueText])),
    LINES_48.map((l) => [sandbox.invoiceLineQty(l), sandbox.invoiceLinePrice(l, inv), sandbox.invoiceLineValueText(l, inv)]));
  assert.equal(own(doc.lines).reduce((s, l) => s + Number(l.valueText), 0).toFixed(2), "153.22");
});

// ===== 2) #32: مرتجع بحسم =====

test("#32 (مسار القوائم): حسم المرتجع «+ 0.02» مدين، والمعادلة تُغلق 2751.848 ← 2331.848", () => {
  const html = voucherPdfMarkup(listOpts(INV_32, "زبون ب", 2751.848, 2331.848));
  assert.ok(html.includes('class="ozk-inv"') && !html.includes("ozk-rpt"));
  assert.deepEqual(ledgerRows(html), [
    ["التاريخ", "2026-08-26", ""],
    ["الرصيد السابق", "2,751.848 $ (عليكم)", ""],
    ["قيمة هذا المرتجع", "420.02 $", ""],
    ["حسم على المرتجع", "+ 0.02 $", "deb"],
    ["الرصيد الجديد", "2,331.848 $ (عليكم)", ""]
  ]);
  const text = visible(html);
  assert.ok(!/تسوية|دفعة من الزبون/.test(text), "صف غير مثبت ظهر على المرتجع");
  assert.ok(!/الحسم\s+−/.test(text), "حسم المرتجع طُبع بإشارة حسم البيع");
  assert.match(html, /قيمة المرتجع<\/div>\s*<div class="big" style="color:#16794f"><bdi>420\.02 \$<\/bdi>/, "المبلغ الكبير ليس الإجمالي 420.02 بالأخضر");
  assert.equal(noteOf(html), NOTE_PROVEN);
});

// ===== 3) حارس رصيد المرتجع =====

test("رصيد حالي/مفرد يُمرَّر عمداً لمرتجع لا يُطبع (بلا قيد)", () => {
  const html = voucherPdfMarkup({
    type: "return", name: "زبون ج", amount: 10, cur: "$", date: "2026-09-20", no: "50", lines: LINES_48.slice(0, 1),
    balance: 777.5, balanceLabel: "الرصيد الحالي", accountBalance: 888.25, accountBalanceAt: "2026-09-20T10:00:00Z",
    currentBalance: 999.125, currentBalanceAt: "2026-09-20T10:00:00Z", ledgerWarning: "تقرير قديم بلا ربط."
  });
  const text = visible(html);
  assert.ok(!/777\.5|888\.25|999\.125/.test(text), "رقم رصيد مُمرَّر بالخطأ طُبع على المرتجع");
  assert.ok(!BALANCE_WORDS.test(text), "صف رصيد ظهر على مرتجع بلا قيد");
  assert.ok(!text.includes("الرصيد بعد المرتجع"));
});

test("رصيد حالي يُمرَّر عمداً مع قيد مثبت: يُطبع السابق/الجديد من القيد وحده", () => {
  const opts = movementOpts(INV_48, "زبون أ", 36273.646, 36120.426);
  Object.assign(opts, { balance: 33274.926, accountBalance: 33274.926, currentBalance: 33274.926, payment: 4500, adjust: 12.5 });
  const html = voucherPdfMarkup(opts);
  const text = visible(html);
  assert.ok(!text.includes("33,274.926"), "الرصيد الحالي طُبع على مرتجع");
  assert.ok(!/الرصيد الحالي|رصيد الحساب الحالي|الرصيد بعد المرتجع|دفعة من الزبون|تسوية/.test(text));
  assert.deepEqual(ledgerRows(html).map((r) => r[0]), ["التاريخ", "البيان", "الرصيد السابق", "قيمة هذا المرتجع", "الرصيد الجديد"]);
});

test("سابق/جديد مع تحذير قيد: لا يُطبع أي رصيد (القيد غير موثوق)", () => {
  const html = voucherPdfMarkup({
    type: "return", name: "زبون ج", amount: 10, cur: "$", date: "2026-09-20", no: "50", lines: [],
    prevBalance: 100, newBalance: 90, discount: 1, ledgerWarning: "تعذّر حساب رصيد المرتجع."
  });
  assert.ok(!BALANCE_WORDS.test(visible(html)));
  assert.ok(!/حسم على المرتجع/.test(visible(html)));
  assert.equal(noteOf(html), NOTE_NEUTRAL);
});

// ===== 4) fail closed: بلا قيد مثبت ⇒ بلا رصيد وبملاحظة محايدة =====

const FAIL_CLOSED = [
  ["مرتجع صندوق / بلا حساب زبون", { ...INV_48, customerGuid: "" }, 100, 50],
  ["استرداد نقدي على المرتجع", { ...INV_48, payment: 20 }, 36273.646, 36120.426],
  ["معادلة لا تُغلق (إضافة غير مثبتة)", INV_48, 36273.646, 36100],
  ["قيد بلا أرصدة مخزَّنة", INV_48, "", ""]
];
for (const [label, inv, prev, next] of FAIL_CLOSED) {
  test(`fail closed — ${label}: بلا رصيد، ملاحظة محايدة، بلا «خُصمت من رصيد حسابكم»`, () => {
    for (const build of [movementOpts, listOpts]) {
      const opts = build(inv, "زبون ج", prev, next);
      assert.ok(opts.ledgerWarning, "الحالة لم تُعامل fail closed في applyReturnLedger");
      const html = voucherPdfMarkup(opts);
      assert.ok(html.includes('class="ozk-inv"'));
      assert.ok(!BALANCE_WORDS.test(visible(html)), "ادعاء رصيد على مرتجع غير مثبت");
      assert.equal(noteOf(html), NOTE_NEUTRAL);
      assert.ok(!html.includes("خُصمت من رصيد حسابكم"));
      assert.equal(cells(html).length, inv.lines.length, "الأصناف سقطت من المستند");
    }
  });
}

test("مرتجع بلا أي حقل رصيد إطلاقاً (تحذير مسار القوائم): ملاحظة محايدة", () => {
  const html = voucherPdfMarkup({ type: "return", name: "زبون ج", amount: 10, cur: "$", date: "2026-09-20", no: "50", lines: [],
    ledgerWarning: "ربط المرتجع بقيده لم يصل بعد من مزامنة Windows." });
  assert.equal(noteOf(html), NOTE_NEUTRAL);
  assert.deepEqual(ledgerRows(html).map((r) => r[0]), ["التاريخ"]);
});

// ===== 5) هوية المرتجع =====

test("هوية المرتجع: kind/العنوان/RET/الأخضر/الأصناف/legal/الختم/Tahoma", () => {
  const doc = saleInvoiceDocument(listOpts(INV_48, "زبون أ", 36273.646, 36120.426));
  assert.equal(doc.kind, "return");
  assert.equal(saleInvoiceDocument({ type: "return", amount: 1, lines: [] }).no, "RET-20260914-0001", "البديل ليس من KINDS.return.prefix");
  assert.equal(OZK_INVOICE.KINDS.return.prefix, "RET");
  const html = voucherPdfMarkup(listOpts(INV_48, "زبون أ", 36273.646, 36120.426));
  assert.ok(html.includes("<h2>فاتورة مرتجع</h2>"), "العنوان ليس «فاتورة مرتجع»");
  assert.ok(!html.includes("<h2>فاتورة</h2>"), "المرتجع يحمل عنوان فاتورة البيع");
  assert.match(html, /قيمة المرتجع<\/div>\s*<div class="big" style="color:#16794f">/, "المبلغ ليس بأخضر المرتجع");
  assert.ok(!/class="big" style="color:#c0271f"/.test(html), "أحمر البيع على المرتجع");
  assert.ok(html.includes('<div class="sec">أصناف المرتجع</div>'));
  assert.ok(html.includes('class="legalbox"') && html.includes('class="seal"'));
  assert.ok(html.includes("font-family:Tahoma,Arial,sans-serif"));
  assert.ok(html.includes('<div class="nm">زبون أ</div>'), "الطرف ليس اسم الزبون");
});

test("الأرشفة واسم الملف: return_invoice ومطابق لـKINDS.return.archiveType", () => {
  exported.length = 0;
  // exportReportPdf يُستدعى متزامناً قبل أول await، فالالتقاط فوري.
  exportVoucherPdf(listOpts(INV_48, "زبون أ", 36273.646, 36120.426));
  assert.equal(exported.length, 1);
  assert.equal(exported[0].archive.docType, "return_invoice");
  assert.equal(exported[0].archive.docType, OZK_INVOICE.KINDS.return.archiveType);
  assert.deepEqual(own(exported[0].archive.meta), { party: "زبون أ", number: "48", date: "2026-09-14" });
  assert.ok(exported[0].html.includes('class="ozk-inv"'), "مسار التصدير لم يرسم القالب الرئيسي");
  // اسم الملف «فاتورة مرتجع - {الزبون} - رقم {الرقم} - {التاريخ}» يحرسه check-document-filenames.mjs.
  assert.match(appJs, /return_invoice: "فاتورة مرتجع",/);
});

// ===== 6) البيع والسندات لم تتغيّر بايتاً =====
//
// بصمات sha256 ملتقطة من main 2c0d094 (قبل Phase 2) بنفس هذا الـsandbox.

const SALE_LINES = [
  { material: "معسل فاخر اسود حرة كف", qty: 48, qtyUnits: 2, unit1: "كف", unit2: "كرتونة", price: 170 },
  { material: "فحم ايكو نارة احمر", qty: 80, qtyUnits: 5, unit1: "كف", unit2: "كرتونة", price: 33 }
];
const GOLDEN = [
  ["فاتورة بيع بحسم ودفعة وتسوية", { type: "invoice", no: "634", date: "2026-09-05", name: "زبون د", phone: "0985000771", cur: "$", amount: 505, prevBalance: 1000, newBalance: 1370, discount: 25, payment: 100, adjust: 10, lines: SALE_LINES }, "23871b2142500af51a8e53c5191fcdede6428760fe21e584d4d796d13dc9cc74"],
  ["فاتورة بيع غير منعكسة على الذمة", { type: "invoice", no: "2046", date: "2026-09-05", name: "زبون هـ", cur: "$", amount: 129.673, accountBalance: -1.15, accountBalanceAt: "2026-09-05T10:00:00Z", lines: SALE_LINES }, "e2836f1bef7db946b03259a7f1533144686ee09b91707a2d8039f47fe9726a3a"],
  ["فاتورة بيع بلا رقم ولا رصيد", { type: "invoice", date: "2026-09-05", name: "زبون و", amount: 50, lines: [] }, "4df50ffa14181ca4cf5b0d8bba2768e91d0c49a1ce676c7e74feea7f3aecb9ac"],
  ["سند قبض برصيد بعد الدفعة ورصيد حالي", { type: "receipt", no: "R-1", date: "2026-09-10", name: "زبون ز", cur: "$", amount: 20, balance: 80, balanceLabel: "الرصيد بعد الدفعة", currentBalance: 60.2, currentBalanceAt: "2026-09-10T10:00:00Z" }, "7964a1c9e7d49ff1b9c642618391cd18a25889ffd8498a06bf1cb4189e9cee5a"],
  ["سند قبض بمبلغ قريب من مرتجع بنفس اليوم", { type: "receipt", no: "R-2", date: "2026-09-10", name: "زبون ز", cur: "$", amount: 20, balance: 80, newBalance: 80, prevBalance: 100, lines: LINES_48 }, "bc8ff71504ce875f9c48b90e663903f90dc117681997135206a7f79f397c1e64"],
  ["سند صرف", { type: "payment", no: "PV-1", date: "2026-09-06", name: "أبو زياد للنقل", cur: "ل.س", amount: 90000, method: "نقدي", notes: "نقل", balance: 0 }, "ccd26af26cdbea7610992d9781153ed0bf901c07d1c6d28580c9e9408e708e90"],
  ["نوع مشتريات (غير مدعوم هنا)", { type: "purchase", no: "PO-1", date: "2026-09-06", name: "مورد", cur: "$", amount: 5, newBalance: 5, lines: SALE_LINES }, "debbb9ced37072923b2aa2832568d8c2c9113bd0d4826cb678fe7b809300e112"],
  ["مرتجع مشتريات (غير مدعوم هنا)", { type: "purchase_return", no: "PRET-1", date: "2026-09-06", name: "مورد", cur: "$", amount: 5, newBalance: 5, lines: SALE_LINES }, "837d979d46a98b1a5564b151c8da05ad2442b9a3a35d4f1cf3b188221751bde3"],
  ["نوع فارغ", { date: "2026-09-06", name: "س", amount: 5, balance: 1 }, "f3030f67cc8fb1a543546b512afe0ffc4baa7e5f0bffb4e37971562562c415de"]
];
if (process.argv.includes("--print-golden")) {
  for (const [label, v] of GOLDEN) console.log(`${sha(voucherPdfMarkup(v))}  ${label}`);
  process.exit(0);
}
for (const [label, v, hash] of GOLDEN) {
  test(`لم يتغيّر بايتاً: ${label}`, () => {
    assert.equal(sha(voucherPdfMarkup(v)), hash, "مخرجات مستند غير المرتجع تغيّرت");
  });
}

test("البوابة: القبض والصرف وأي نوع غير المرتجع لا يدخل القالب الرئيسي", () => {
  for (const type of ["receipt", "payment", "purchase", "purchase_return", "Return", "return ", "", undefined]) {
    const out = voucherPdfMarkup({ type, name: "س", amount: 5, cur: "$", date: "2026-09-06", balance: 1, newBalance: 1, lines: LINES_48 });
    assert.ok(out.includes("ozk-rpt") && !out.includes("ozk-inv"), `النوع ${JSON.stringify(type)} دخل القالب الرئيسي`);
  }
  const gate = appJs.match(/function voucherPdfMarkup\(v\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(gate, /if \(\(isInv \|\| isRet\) && typeof OZK_INVOICE !== "undefined"/, "البوابة ليست isInv || isRet حرفياً");
  assert.match(gate, /const isInv = v\.type === "invoice";\n  const isRet = v\.type === "return";/);
});

test("فاتورة البيع: kind invoice وبديل INV وملاحظتها كما هي", () => {
  const doc = saleInvoiceDocument({ type: "invoice", amount: 1, lines: [] });
  assert.equal(doc.kind, "invoice");
  assert.equal(doc.no, "INV-20260914-0001");
  assert.equal(doc.note, undefined, "فاتورة البيع حملت ملاحظة بديلة");
});

// ===== 7) نقاط الدخول الثلاث القائمة =====

test("نقاط الدخول الثلاث لمرتجع المبيعات موصولة بالمعالجَين القائمَين", () => {
  // E1 لوحة الزبون، E2 فواتير الزبون بصفحة التقارير، E3 الفواتير السابقة.
  assert.equal((appJs.match(/data-action="gen-movement-doc"[^\n]*📄 فاتورة مرتجع PDF<\/button>/g) || []).length, 1, "E1");
  assert.match(appJs, /data-action="gen-invoice-doc" data-inv-guid[^\n]*\$\{inv\.isReturn \? "تصدير فاتورة المرتجع PDF" : "تصدير الفاتورة PDF \(مع الأصناف\)"\}/, "E2");
  assert.match(appJs, /data-action="gen-invoice-doc"\n[\s\S]{0,300}\$\{inv\.isReturn \? "تصدير فاتورة المرتجع PDF" : "تصدير الفاتورة PDF"\}/, "E3");
});

test("المعالجان وحدهما يبنيان مستند مرتجع، وكلاهما يمرّ بـexportVoucherPdf ← القالب الرئيسي", () => {
  const retBuilders = appJs.match(/type: "return"|type: inv\.isReturn \? "return" : "invoice"/g) || [];
  assert.equal(retBuilders.length, 2, `مواضع بناء مستند المرتجع: ${retBuilders.length}`);
  const e1 = appJs.match(/if \(kind\.kind === "return"\) \{[\s\S]*?exportVoucherPdf\(opts\);/);
  assert.ok(e1 && /applyReturnLedger\(opts, retMatch, el\.dataset\.docPrev, el\.dataset\.docNew\)/.test(e1[0]), "E1 لم يعد يمرّ بأرصدة قيده");
  const e2 = appJs.match(/data-action='gen-invoice-doc'\][\s\S]*?\n  \}\);\n/);
  assert.ok(e2 && /applyReturnLedgerForBill\(opts, inv\)/.test(e2[0]) && /exportVoucherPdf\(opts\)/.test(e2[0]), "E2/E3 لم يعد يمرّ بأرصدة قيده");
  assert.equal((appJs.match(/OZK_INVOICE\.markup\(/g) || []).length, 1, "القالب الرئيسي يُستدعى من خارج voucherPdfMarkup");
});

test("كل مسارات المرتجع ترسم نفس المستند (لوحة الزبون والقوائم)", () => {
  const a = voucherPdfMarkup(movementOpts(INV_32, "زبون ب", 2751.848, 2331.848));
  const b = voucherPdfMarkup(listOpts(INV_32, "زبون ب", 2751.848, 2331.848));
  assert.deepEqual(cells(a), cells(b));
  // الفرق الوحيد القائم أصلاً: البيان والهاتف في مسار اللوحة.
  assert.deepEqual(ledgerRows(a).filter((r) => r[0] !== "البيان"), ledgerRows(b));
});

// ===== النتيجة =====

console.log("\n🔁 مرتجع المبيعات على قالب الفاتورة الرئيسي (Phase 2)\n");
console.log(results.join("\n"));
if (failed > 0) {
  console.log(`\n❌ فشل ${failed} فحصاً\n`);
  process.exit(1);
}
console.log(`\n✅ ${results.length} فحصاً ناجحاً\n`);
