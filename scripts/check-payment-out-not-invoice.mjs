// ============================================================================
// فحص انحداري: **حركة الصندوق الخارجة (payment_out) ليست فاتورة بيع.**
//
// العطل (2026-10-01، تقرير الإنتاج ameen_customer_movements، lineKinds v1):
// لوحة الزبون كانت تعرض كل سطر مدين «فاتورة». سطر مدين 2500 على الصندوق
// (lineKind = payment_out، الرصيد يرتفع بقيمته) ظهر في «الفواتير» وزرّه
// «فاتورة PDF» يبحث عن فاتورة بيع بالمبلغ أو بتاريخ اليوم. المستند سند صرف
// لا سند قبض: القيد صرف من الصندوق. الملاحظة لا تُصنِّف:
// النوع يأتي من push-customer-movements.ps1. بلا العلامة lineKinds:v1 يبقى
// السلوك السابق (كل مدين غير مربوط بمرتجع فاتورة) لأن الصف لا يحمل نوعاً.
//
// الأسماء مصطنعة. الرقم 2500 من الشاهد لأنه ما يُختبر، بلا اسم زبون ولا ملاحظة
// شخصية. الفحص يشغّل الدوال الحقيقية من src/app.js داخل vm.
// ============================================================================

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

const PATTERNS = {
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  normalizeItemName: /function normalizeItemName\(value\) \{[\s\S]*?\n\}\n/,
  smartNameMatch: /function smartNameMatch\(list, getName, name\) \{[\s\S]*?\n\}\n/,
  normGuid: /function normGuid\(value\) \{[\s\S]*?\n\}\n/,
  customerIdentity: /function customerIdentity\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  customerInvoiceEntries: /function customerInvoiceEntries\(\) \{[\s\S]*?\n\}\n/,
  invoiceIdentityCacheVar: /let _invoiceIdentityCache = null;/,
  invoiceIdentityCache: /function invoiceIdentityCache\(\) \{[\s\S]*?\n\}\n/,
  orphanInvoiceEntries: /function orphanInvoiceEntries\(\) \{[\s\S]*?\n\}\n/,
  customerInvoiceEntryFor: /function customerInvoiceEntryFor\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  customerInvoicesFor: /function customerInvoicesFor\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  invoiceByGuid: /function invoiceByGuid\(guid\) \{[\s\S]*?\n\}\n/,
  latestCustomerBalanceItems: /function latestCustomerBalanceItems\(\) \{[\s\S]*?\n\}\n/,
  RETURN_LINK_MARKER: /const RETURN_LINK_MARKER = "er000-return-v1";/,
  LINE_KINDS_MARKER: /const LINE_KINDS_MARKER = "v1";/,
  movementsReportLinksReturns: /function movementsReportLinksReturns\(\) \{[\s\S]*?\n\}\n/,
  movementsReportHasLineKinds: /function movementsReportHasLineKinds\(\) \{[\s\S]*?\n\}\n/,
  movementReturnLink: /function movementReturnLink\(movement\) \{[\s\S]*?\n\}\n/,
  debitMovementKind: /function debitMovementKind\(movement, typedLedger\) \{[\s\S]*?\n\}\n/,
  debitMovementDocumentType: /function debitMovementDocumentType\(movement, typedLedger\) \{[\s\S]*?\n\}\n/,
  movementDocTypeFromButton: /function movementDocTypeFromButton\(lineKind, debit, credit\) \{[\s\S]*?\n\}\n/,
  customerCashPaymentRows: /function customerCashPaymentRows\(receiptMoves, movements, typedLedger\) \{[\s\S]*?\n\}\n/,
  customerPaymentRowAmount: /function customerPaymentRowAmount\(row\) \{[\s\S]*?\n\}\n/
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

const state = { customerInvoicesReport: null, customerMovementsReport: null, customerBalanceReports: [] };
const sandbox = { console, Intl, state, applyCustomerLimits: (items) => items };
if (!failed) {
  vm.createContext(sandbox);
  vm.runInContext(source.join("\n"), sandbox);
}
const {
  debitMovementKind,
  debitMovementDocumentType,
  movementDocTypeFromButton,
  customerCashPaymentRows,
  customerPaymentRowAmount,
  movementReturnLink
} = sandbox;

const CASH = { date: "2026-10-01", debit: 2500, credit: 0, notes: "", billGuid: "", lineKind: "payment_out", docPrev: 6668.002, docNew: 9168.002 };
const SALE = { date: "2026-09-30", debit: 7332.1, credit: 0, notes: "", billGuid: "", lineKind: "sale", docPrev: 0, docNew: 7332.1 };
const RECEIPT = { date: "2026-09-23", debit: 0, credit: 38730, notes: "", billGuid: "", lineKind: "payment" };
const OPENING = { date: "2026-07-01", debit: 100, credit: 0, notes: "", billGuid: "", lineKind: "opening" };

function oldInvoiceDebit(movement) {
  return Number(movement?.debit || 0) > 0 && !movementReturnLink(movement);
}

test("الشاهد: مدين 2500 نوعه payment_out كان يُحسب فاتورة بالقاعدة القديمة", () => {
  assert.equal(oldInvoiceDebit(CASH), true);
});

test("تقرير موسوم: payment_out دفعة نقدية وليست فاتورة، والملاحظة لا تغيّر الحكم", () => {
  assert.ok(appJs.includes('const LINE_KINDS_MARKER = "v1";'), "علامة الأنواع ليست v1");
  for (const notes of ["", "دفعة نقدية", "بيع بضاعة"]) {
    const kind = debitMovementKind({ ...CASH, notes }, true);
    assert.equal(kind.kind, "payment-out", notes);
    assert.equal(debitMovementDocumentType({ ...CASH, notes }, true), "payment", notes);
  }
});

test("سطر بيع يبقى فاتورة حتى لو ذكرت الملاحظة كلمة دفعة", () => {
  const noted = { ...SALE, notes: "دفعة نقدية" };
  assert.equal(debitMovementKind(noted, true).kind, "sale");
  assert.equal(debitMovementDocumentType(noted, true), "invoice");
});

test("بلا lineKinds:v1 لا نُخفي المدين: payment_out يبقى فاتورة كما كان", () => {
  assert.equal(debitMovementKind(CASH, false).kind, "sale");
  assert.equal(debitMovementDocumentType(CASH, false), "invoice");
});

test("افتتاحي مدين ليس payment_out فلا يخرج من الفواتير في هذا الإصلاح", () => {
  assert.equal(debitMovementKind(OPENING, true).kind, "sale");
});

test("قبض دائن ليس سطر مدين", () => {
  assert.equal(debitMovementKind(RECEIPT, true).kind, "none");
});

test("زر الحركة: payment_out يُصدَّر سند صرف قبل البحث عن فاتورة بيع", () => {
  assert.equal(movementDocTypeFromButton("payment_out", 2500, 0), "payment");
  assert.equal(movementDocTypeFromButton("", 7332.1, 0), "invoice");
  assert.equal(movementDocTypeFromButton("sale", 7332.1, 0), "invoice");
  const handlerAt = appJs.indexOf("app.querySelectorAll(\"[data-action='gen-movement-doc']\")");
  assert.ok(handlerAt > 0, "معالج زر الحركة غائب");
  const handler = appJs.slice(handlerAt, handlerAt + 8000);
  const receiptBranch = handler.indexOf("movementDocTypeFromButton");
  const invoiceSearch = handler.indexOf("customerInvoicesFor(item)");
  assert.ok(receiptBranch > 0 && invoiceSearch > receiptBranch, "فرع سند القبض يجب أن يسبق البحث عن فاتورة البيع");
  const balanceFn = appJs.match(/function fillReceiptVoucherBalance\(opts, item, storedDocNew\) \{[\s\S]*?\n\}\n/);
  assert.ok(balanceFn, "دالة رصيد سند القبض غائبة");
  assert.equal((balanceFn[0].match(/الرصيد بعد الدفعة/g) || []).length, 1);
  const exportFn = appJs.match(/function exportMovementReceipt\(base, item, amount, storedDocNew, voucherType\) \{[\s\S]*?\n\}\n/);
  assert.ok(exportFn, "دالة تصدير السند غائبة");
  assert.equal((exportFn[0].match(/fillReceiptVoucherBalance\(/g) || []).length, 1);
  assert.ok(exportFn[0].includes('voucherType === "payment"'), "payment_out لا يختار سند الصرف");
  assert.ok(exportFn[0].includes('docNumber(disbursement ? "PV" : "R")'), "رقم سند الصرف ليس PV");
  assert.ok(exportFn[0].includes('cur: disbursement ? "$" : base.cur'), "سند الصرف يأخذ عملة عرض الزبون بدل دولار الدفتر");
  assert.equal(handler.split("exportMovementReceipt(").length - 1, 2);
  assert.ok(handler.includes('exportMovementReceipt(base, item, debit, storedDocNew, "payment")'), "فرع المدين لا يمرّر نوع الصرف");
});

test("عمود الدفعات يجمع سند القبض مع payment_out والمبلغ من المدين", () => {
  const rows = customerCashPaymentRows([RECEIPT], [CASH, SALE], true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lineKind, "payment_out");
  assert.equal(rows[1].lineKind, "payment");
  assert.equal(customerPaymentRowAmount(rows[0]), 2500);
  assert.equal(customerPaymentRowAmount(rows[1]), 38730);
  assert.equal(customerCashPaymentRows([RECEIPT], [CASH], false).some((r) => r._payKind === "payment-out"), false);
});

test("لوحة الزبون: الفواتير من نوع sale وحده، وpayment_out يُرسم «دفعة» لا «فاتورة»", () => {
  const invoiceLine = "const invoiceMoves = movements.filter((m) => debitMovementKind(m, typedLedger).kind === \"sale\");";
  assert.ok(appJs.includes(invoiceLine), "فلتر الفواتير لا يستخدم debitMovementKind");
  assert.ok(appJs.includes("customerCashPaymentRows(paymentMoves, movements, typedLedger)"), "عمود الدفعات لا يضم payment_out");
  assert.ok(appJs.includes("customerPaymentRowAmount(m)") || appJs.includes("customerPaymentRowAmount(row)"), "مبلغ الدفعة لا يُقرأ من الصف");
  assert.ok(appJs.includes('data-line-kind="${cashOut ? "payment_out" : ""}"'), "زر الدفعة لا يعلّم payment_out");
  assert.ok(appJs.includes('cashOut ? "سند صرف PDF" : "سند قبض PDF"'), "زر payment_out ليس سند صرف");
  const panelAt = appJs.indexOf("function customerDetailsPanel");
  const panelEnd = appJs.indexOf("function customerBalanceSection");
  const panel = appJs.slice(panelAt, panelEnd > panelAt ? panelEnd : panelAt + 12000);
  const invoiceLabel = panel.indexOf("فاتورة: ");
  const paymentLabel = panel.indexOf("دفعة: ");
  assert.ok(invoiceLabel > 0 && paymentLabel > invoiceLabel);
  assert.ok(!panel.slice(paymentLabel, paymentLabel + 800).includes("فاتورة: "), "عمود الدفعات يسمّي payment_out فاتورة");
});

console.log("فحص payment_out ليست فاتورة:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
