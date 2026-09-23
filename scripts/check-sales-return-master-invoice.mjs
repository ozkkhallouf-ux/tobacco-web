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
  invoiceLineFractionalUnit1: /function invoiceLineFractionalUnit1\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineQtyParts: /function invoiceLineQtyParts\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineQty: /function invoiceLineQty\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineUnitPrice: /function invoiceLineUnitPrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLinePrice: /function invoiceLinePrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  returnLedgerBalances: /function returnLedgerBalances\(inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  applyReturnLedger: /function applyReturnLedger\(opts, inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  formatInvoiceMoney: /function formatInvoiceMoney\(value\) \{[\s\S]*?\n\}\n/,
  balanceText: /function balanceText\(bal, cur, money = formatMoney\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRows: /function voucherLedgerRows\(v\) \{[\s\S]*?\n\}\n/,
  voucherAccountBalanceRow: /function voucherAccountBalanceRow\(rows, v, balCur\) \{[\s\S]*?\n\}\n/,
  voucherInvoiceBalanceRows: /function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
  pushInvoiceRoundingDrift: /function pushInvoiceRoundingDrift\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
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
// « OZK TOBACCO» معزول اتجاهياً داخل الملاحظة والتذييل (مرتجع #37 على iPhone): المسافة
// في عنصرها والعبارة في <bdi>. نص الملاحظة يُقارن بلا وسم العزل، والعزل يُفحص في قسمه.
const BRAND_ISOLATED = "<span> </span><bdi>OZK TOBACCO</bdi>";
const unisolate = (html) => html.split(BRAND_ISOLATED).join(" OZK TOBACCO");
const noteHtmlOf = (html) => { const m = html.match(/<p class="muted" style="margin:8px 0 0">([\s\S]*?)<\/p>/); return m ? m[1] : null; };
const noteOf = (html) => { const n = noteHtmlOf(html); return n === null ? null : unisolate(n); };
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
// فاتورات البيع الثلاث الأولى أُعيد التقاطها عمداً بعد قرار المنزلتين (2026-09-23، فاتورة 830):
// مقارنة المخرجات قبله وبعده أثبتت أن الفرق الوحيد نصوص المبالغ (505 ⇒ 505.00، 129.673 ⇒
// 129.67، 1,370 ⇒ 1,370.00…) بنفس القيمة مقرّبة لمنزلتين، بلا أي تغيير في نص أو صف أو تخطيط.
// صفوف 634 مثبّتة حرفياً أدناه كي لا يمرّ تغيير رقمي خلف بصمة جديدة.

const SALE_LINES = [
  { material: "معسل فاخر اسود حرة كف", qty: 48, qtyUnits: 2, unit1: "كف", unit2: "كرتونة", price: 170 },
  { material: "فحم ايكو نارة احمر", qty: 80, qtyUnits: 5, unit1: "كف", unit2: "كرتونة", price: 33 }
];
const GOLDEN = [
  ["فاتورة بيع بحسم ودفعة وتسوية", { type: "invoice", no: "634", date: "2026-09-05", name: "زبون د", phone: "0985000771", cur: "$", amount: 505, prevBalance: 1000, newBalance: 1370, discount: 25, payment: 100, adjust: 10, lines: SALE_LINES }, "e0d0c5d95e9783670107530e55144b89ed9e9a0bb09f281a8d29d7a8f5333158"],
  ["فاتورة بيع غير منعكسة على الذمة", { type: "invoice", no: "2046", date: "2026-09-05", name: "زبون هـ", cur: "$", amount: 129.673, accountBalance: -1.15, accountBalanceAt: "2026-09-05T10:00:00Z", lines: SALE_LINES }, "fedbb62635add674adb905e9efce86961232c0f712f802e19d76b58d7463a1b6"],
  ["فاتورة بيع بلا رقم ولا رصيد", { type: "invoice", date: "2026-09-05", name: "زبون و", amount: 50, lines: [] }, "b409ac49fe5f539910d35deaec2b92cb49c0f5585a965f8f3ac2b94a4f86afdb"],
  ["سند قبض برصيد بعد الدفعة ورصيد حالي", { type: "receipt", no: "R-1", date: "2026-09-10", name: "زبون ز", cur: "$", amount: 20, balance: 80, balanceLabel: "الرصيد بعد الدفعة", currentBalance: 60.2, currentBalanceAt: "2026-09-10T10:00:00Z" }, "7964a1c9e7d49ff1b9c642618391cd18a25889ffd8498a06bf1cb4189e9cee5a"],
  ["سند قبض بمبلغ قريب من مرتجع بنفس اليوم", { type: "receipt", no: "R-2", date: "2026-09-10", name: "زبون ز", cur: "$", amount: 20, balance: 80, newBalance: 80, prevBalance: 100, lines: LINES_48 }, "bc8ff71504ce875f9c48b90e663903f90dc117681997135206a7f79f397c1e64"],
  ["سند صرف", { type: "payment", no: "PV-1", date: "2026-09-06", name: "أبو زياد للنقل", cur: "ل.س", amount: 90000, method: "نقدي", notes: "نقل", balance: 0 }, "ccd26af26cdbea7610992d9781153ed0bf901c07d1c6d28580c9e9408e708e90"],
  ["نوع مشتريات (غير مدعوم هنا)", { type: "purchase", no: "PO-1", date: "2026-09-06", name: "مورد", cur: "$", amount: 5, newBalance: 5, lines: SALE_LINES }, "debbb9ced37072923b2aa2832568d8c2c9113bd0d4826cb678fe7b809300e112"],
  ["مرتجع مشتريات (غير مدعوم هنا)", { type: "purchase_return", no: "PRET-1", date: "2026-09-06", name: "مورد", cur: "$", amount: 5, newBalance: 5, lines: SALE_LINES }, "837d979d46a98b1a5564b151c8da05ad2442b9a3a35d4f1cf3b188221751bde3"],
  ["نوع فارغ", { date: "2026-09-06", name: "س", amount: 5, balance: 1 }, "f3030f67cc8fb1a543546b512afe0ffc4baa7e5f0bffb4e37971562562c415de"]
];
// الاستثناء الوحيد المعتمد بعد main: عزل «OZK TOBACCO» بـ<bdi> في ملاحظة القالب الرئيسي
// وتذييله. البصمة تبقى بصمة main نفسها بعد إزالة وسم العزل وحده، فأي فرق آخر (رقم،
// صف، نص، تخطيط) يُسقط الفحص. وعدد مواضع العزل مثبت: اثنان في القالب الرئيسي (الملاحظة
// والتذييل)، وصفر في القالب القديم.
if (process.argv.includes("--print-golden")) {
  for (const [label, v] of GOLDEN) console.log(`${sha(unisolate(voucherPdfMarkup(v)))}  ${label}`);
  process.exit(0);
}
for (const [label, v, hash] of GOLDEN) {
  test(`لم يتغيّر إلا عزل OZK TOBACCO: ${label}`, () => {
    const html = voucherPdfMarkup(v);
    assert.equal(sha(unisolate(html)), hash, "مخرجات مستند غير المرتجع تغيّرت بأكثر من عزل OZK TOBACCO");
    const isolated = html.split(BRAND_ISOLATED).length - 1;
    assert.equal(isolated, html.includes('class="ozk-inv"') ? 2 : 0, `مواضع العزل ${isolated}`);
  });
}

test("البوابة: القبض والصرف وأي نوع غير المرتجع لا يدخل القالب الرئيسي", () => {
  for (const type of ["receipt", "payment", "purchase", "purchase_return", "Return", "return ", "", undefined]) {
    const out = voucherPdfMarkup({ type, name: "س", amount: 5, cur: "$", date: "2026-09-06", balance: 1, newBalance: 1, lines: LINES_48 });
    assert.ok(out.includes("ozk-rpt") && !out.includes("ozk-inv"), `النوع ${JSON.stringify(type)} دخل القالب الرئيسي`);
  }
  const gate = appJs.match(/function voucherPdfMarkup\(v\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(gate, /if \(\(isInv \|\| isRet\) && typeof OZK_INVOICE !== "undefined"/, "البوابة ليست isInv || isRet حرفياً");
  assert.match(gate, /const isInv = v\.type === "invoice";\n {2}const isRet = v\.type === "return";/);
});

test("فاتورة البيع 634: الصفوف نفسها والقيم نفسها، بمنزلتين فقط", () => {
  const doc = saleInvoiceDocument(GOLDEN[0][1]);
  assert.deepEqual(own(doc.rows).map((r) => [r.label, r.value]), [
    ["التاريخ", "2026-09-05"],
    ["الرصيد السابق", "1,000.00 $ (عليكم)"],
    ["قيمة هذه الفاتورة", "505.00 $"],
    ["الحسم", "− 25.00 $"],
    ["دفعة من الزبون", "− 100.00 $"],
    ["تسوية على الحساب", "− 10.00 $"],
    ["الرصيد الجديد", "1,370.00 $ (عليكم)"]
  ]);
  assert.equal(doc.amountText, "505.00");
});

test("فاتورة البيع 830 على القالب الرئيسي: 34,360.33 − 0.33 ⇒ الرصيد 34,360.00 لا 34,359.998", () => {
  const v = { type: "invoice", no: "830", date: "2026-09-23", name: "زبون ط", cur: "$", amount: 34360.328, prevBalance: 0, newBalance: 34359.998, discount: 0.33, lines: [] };
  const doc = saleInvoiceDocument(v);
  assert.equal(doc.amountText, "34,360.33");
  assert.deepEqual(own(doc.rows).map((r) => [r.label, r.value]), [
    ["التاريخ", "2026-09-23"],
    ["الرصيد السابق", "مسدّد (صفر)"],
    ["قيمة هذه الفاتورة", "34,360.33 $"],
    ["الحسم", "− 0.33 $"],
    ["الرصيد الجديد", "34,360.00 $ (عليكم)"]
  ]);
  const text = visible(voucherPdfMarkup(v));
  assert.ok(text.includes("34,360.00"), "الرصيد الجديد غير مطبوع بمنزلتين");
  assert.ok(!text.includes("34,359.998") && !text.includes("34,360.328"), "مبلغ بثلاث منازل ما زال مطبوعاً");
  assert.ok(!text.includes("دفعة من الزبون"), "الحسم طُبع دفعة");
});

test("المرتجع على صياغة Phase 2 حرفياً: قيمته وأرصدته بلا منزلتين مفروضتين", () => {
  const doc = saleInvoiceDocument(movementOpts(INV_48, "زبون أ", 36273.646, 36120.426));
  assert.equal(doc.kind, "return");
  assert.equal(doc.amountText, sandbox.formatMoney(INV_48.total));
  const rows = own(doc.rows).map((r) => [r.label, r.value]);
  assert.deepEqual(rows.find((r) => r[0] === "الرصيد السابق"), ["الرصيد السابق", "36,273.646 $ (عليكم)"]);
  assert.deepEqual(rows.find((r) => r[0] === "الرصيد الجديد"), ["الرصيد الجديد", "36,120.426 $ (عليكم)"]);
});

test("فاتورة البيع: kind invoice وبديل INV وملاحظتها كما هي", () => {
  const doc = saleInvoiceDocument({ type: "invoice", amount: 1, lines: [] });
  assert.equal(doc.kind, "invoice");
  assert.equal(doc.no, "INV-20260914-0001");
  assert.equal(doc.note, undefined, "فاتورة البيع حملت ملاحظة بديلة");
});

// ===== 7) الكمية الكسرية بالوحدة الصغرى (مرتجع #37، فشل iPhone 2026-09-23) =====
//
// الأمين يسجّل العلب المفردة أعشارَ كروز (107.6). تحويلها إلى كسر كرتونة (2.152) لا
// معنى له، فتُعرض الكمية بالكروز وحده. الكروز الصحيح يبقى على السلوك القائم.

const LINES_37 = [
  { material: "مادة و", qty: 107.6, qtyUnits: 2.152, unit1: "كروز", unit2: "كرتونة", price: 12.8, lineTotal: 1377.28, lineTotalSource: "derived" },
  { material: "مادة ز", qty: 11.4, qtyUnits: 0.228, unit1: "كروز", unit2: "كرتونة", price: 14.2, lineTotal: 161.88, lineTotalSource: "derived" }
];
const INV_37 = { guid: "00000000-0000-4000-8000-000000000037", number: "37", date: "2026-08-31", total: 1539.16, discount: 0, payment: 0, isReturn: true, customerGuid: "00000000-0000-4000-8000-0000000000c1", lines: LINES_37 };
const EXPECTED_37 = [
  ["مادة و", "107.6 كروز", "12.8 $ / كروز", "1,377.28"],
  ["مادة ز", "11.4 كروز", "14.2 $ / كروز", "161.88"]
];

test("#37: 107.6 كروز و11.4 كروز فقط، بلا كسر كرتونة، والسعر بالكروز والقيمة كما كانت", () => {
  const html = voucherPdfMarkup(listOpts(INV_37, "زبون ح", "", ""));
  assert.deepEqual(cells(html), EXPECTED_37);
  assert.ok(!/2\.152|0\.228/.test(visible(html)), "كسر الكرتونة ما زال مطبوعاً");
  assert.deepEqual(own(sandbox.invoiceLineQtyParts(LINES_37[0])), { value: "107.6", unit: "كروز", detailValue: "", detailUnit: "" });
  assert.deepEqual(own(sandbox.invoiceLineQtyParts(LINES_37[1])), { value: "11.4", unit: "كروز", detailValue: "", detailUnit: "" });
  assert.equal(sandbox.invoiceLineQty(LINES_37[0]), "107.6 كروز");
  assert.equal(sandbox.invoiceLineQty(LINES_37[1]), "11.4 كروز");
});

test("البيع والمرتجع يستعملان نفس قاعدة الكمية الكسرية", () => {
  const sale = voucherPdfMarkup({ type: "invoice", name: "زبون ح", amount: 1539.16, cur: "$", date: "2026-08-31", no: "37", lines: LINES_37 });
  assert.deepEqual(cells(sale), EXPECTED_37);
  const ret = saleInvoiceDocument(listOpts(INV_37, "زبون ح", "", ""));
  const inv = saleInvoiceDocument({ type: "invoice", amount: 1539.16, lines: LINES_37 });
  assert.deepEqual(own(ret.lines), own(inv.lines));
  // سطر البيع الوحيد بكروز كسري في بيانات الجهاز (فاتورة 1393).
  assert.equal(sandbox.invoiceLineQty({ qty: 0.8, qtyUnits: 0.016, unit1: "كروز", unit2: "كرتونة" }), "0.8 كروز");
});

// مراجعة Codex على 9a40cf9: الكمية المعروضة × السعر المعروض = القيمة. الكروز الكسري
// بجانب سعر الكرتونة يعطي 107.6 × 640 = 68,864 بدل 1,377.28.
test("سعر السطر يتبع وحدة الكمية: الكمية × السعر المعروضان = القيمة، والقيمة لم تتغيّر", () => {
  const num = (t) => Number(String(t).replace(/[^0-9.]/g, ""));
  for (const row of EXPECTED_37) {
    assert.ok(Math.abs(num(row[1]) * num(row[2]) - num(row[3])) < 0.005, JSON.stringify(row));
  }
  // القيمة من `invoiceLineValueText` نفسها قبل التعديل وبعده.
  const inv = { total: 1539.16, lines: LINES_37 };
  assert.deepEqual(LINES_37.map((l) => sandbox.invoiceLineValueText(l, inv)), ["1,377.28", "161.88"]);
  // أساس الكرتونة (سعر مخزَّن للكرتونة، قيمة حقيقية من الأمين) بكروز كسري: سعر الكروز = 640 ÷ 50.
  const cartonBasis = { qty: 107.6, qtyUnits: 2.152, unit1: "كروز", unit2: "كرتونة", price: 640, lineTotal: 1377.28 };
  assert.equal(sandbox.invoiceLinePrice(cartonBasis, { total: 1377.28, lines: [cartonBasis] }), "12.8 $ / كروز");
  assert.equal(sandbox.invoiceLineValueText(cartonBasis, { total: 1377.28, lines: [cartonBasis] }), "1,377.28");
});

test("سعر الكميات الصحيحة لم يتغيّر: 0.16 كرتونة (8 كروز) بسعر الكرتونة", () => {
  const cases = [
    [{ qty: 8, qtyUnits: 0.16, unit1: "كروز", unit2: "كرتونة", price: 12.8, lineTotal: 102.4, lineTotalSource: "derived" }, "640 $ / كرتونة"],
    [{ qty: 50, qtyUnits: 1, unit1: "كروز", unit2: "كرتونة", price: 640, lineTotal: 640 }, "640 $ / كرتونة"],
    [{ qty: 7, unit1: "كروز", price: 13.5, lineTotal: 94.5 }, "13.5 $ / كروز"]
  ];
  for (const [line, text] of cases) {
    assert.equal(sandbox.invoiceLinePrice(line, { total: line.lineTotal, lines: [line] }), text, JSON.stringify(line));
  }
});

test("الكميات الصحيحة لم تتغيّر: 0.16 كرتونة (8 كروز) وأمثالها", () => {
  const same = [
    [{ qty: 8, qtyUnits: 0.16, unit1: "كروز", unit2: "كرتونة" }, { value: "0.16", unit: "كرتونة", detailValue: "8", detailUnit: "كروز" }, "0.16 كرتونة (8 كروز)"],
    [{ qty: 50, qtyUnits: 1, unit1: "كروز", unit2: "كرتونة" }, { value: "1", unit: "كرتونة", detailValue: "50", detailUnit: "كروز" }, "1 كرتونة (50 كروز)"],
    [{ qty: 25, qtyUnits: 0.5, unit1: "كروز", unit2: "كرتونة" }, { value: "0.5", unit: "كرتونة", detailValue: "25", detailUnit: "كروز" }, "0.5 كرتونة (25 كروز)"],
    [{ qty: 3, qtyUnits: 0.125, unit1: "كروز", unit2: "شرحة" }, { value: "0.125", unit: "شرحة", detailValue: "3", detailUnit: "كروز" }, "0.125 شرحة (3 كروز)"],
    [{ qty: 48, qtyUnits: 2, unit1: "كف", unit2: "كرتونة" }, { value: "2", unit: "كرتونة", detailValue: "48", detailUnit: "كف" }, "2 كرتونة (48 كف)"],
    [{ qty: 175, qtyUnits: 3.5, unit1: "كروز", unit2: "كرتونة" }, { value: "3.5", unit: "كرتونة", detailValue: "175", detailUnit: "كروز" }, "3.5 كرتونة (175 كروز)"],
    [{ qty: 5, qtyUnits: 5, unit1: "كرتونة", unit2: "كرتونة" }, { value: "5", unit: "كرتونة", detailValue: "", detailUnit: "" }, "5 كرتونة"],
    [{ qty: 7, unit1: "كروز" }, { value: "7", unit: "كروز", detailValue: "", detailUnit: "" }, "7 كروز"],
    [{ qty: 0, qtyUnits: 0, unit1: "كروز", unit2: "كرتونة" }, { value: "—", unit: "", detailValue: "", detailUnit: "" }, "—"]
  ];
  for (const [line, parts, text] of same) {
    assert.deepEqual(own(sandbox.invoiceLineQtyParts(line)), parts, JSON.stringify(line));
    assert.equal(sandbox.invoiceLineQty(line), text);
  }
  // شاهد #48 بكل أسطره الصحيحة بقي على حاله (خانة الكمية في اختبار #48 أعلاه).
});

// ===== 8) عزل «OZK TOBACCO» اتجاهياً (تداخل الكلمتين في PDF الهاتف) =====

test("ملاحظة المرتجع (بقيد ومحايدة) والبيع والتذييل: OZK TOBACCO معزول، والنص المرئي كما هو حرفاً", () => {
  const cases = [
    [voucherPdfMarkup(movementOpts(INV_48, "زبون أ", 36273.646, 36120.426)), "هذا سند رسمي بقيمة البضاعة المرتجعة إلى<span> </span><bdi>OZK TOBACCO</bdi> — خُصمت من رصيد حسابكم.", NOTE_PROVEN],
    [voucherPdfMarkup(listOpts(INV_37, "زبون ح", "", "")), "هذا سند رسمي بقيمة البضاعة المرتجعة إلى<span> </span><bdi>OZK TOBACCO</bdi>.", NOTE_NEUTRAL],
    [voucherPdfMarkup({ type: "invoice", name: "زبون", amount: 1, lines: [] }), "هذه فاتورة صادرة عن<span> </span><bdi>OZK TOBACCO</bdi>.", OZK_INVOICE.KINDS.invoice.note]
  ];
  for (const [html, note, text] of cases) {
    assert.equal(noteHtmlOf(html), note);
    // بلا وسم العزل هو النص الأصلي حرفاً (والمسافة داخل <span> هي مسافته نفسها).
    assert.equal(noteOf(html), text, "النص المرئي للملاحظة تغيّر");
    assert.ok(html.includes('<div class="rfoot"><span>صادر آليًا عن نظام<span> </span><bdi>OZK TOBACCO</bdi> · رقم المركز: 0994092038</span>'), "التذييل بلا عزل");
    // الترويسة والختم عنصران مستقلان سليمان أصلاً: بلا تغيير.
    assert.ok(html.includes('<div class="brand">OZK TOBACCO<small>') && html.includes('<div class="s-logo">OZK TOBACCO</div>'));
  }
});

test("عزل الملاحظة يسبق الهروب: نص الملاحظة ما زال مُهرَّباً", () => {
  const doc = saleInvoiceDocument({ type: "return", amount: 1, lines: [] });
  doc.note = "<b>x</b> OZK TOBACCO";
  const html = OZK_INVOICE.markup(doc);
  assert.equal(noteHtmlOf(html), "&lt;b&gt;x&lt;/b&gt;<span> </span><bdi>OZK TOBACCO</bdi>");
});

// ===== 9) نقاط الدخول الثلاث القائمة =====

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
  const e2 = appJs.match(/data-action='gen-invoice-doc'\][\s\S]*?\n {2}\}\);\n/);
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
