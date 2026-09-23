// ============================================================================
// فحص انحداري: **حسم فاتورة البيع ليس سند قبض، ودفعة الزبون ليست حسماً.**
//
// الحالة الحقيقية (2026-09-23، تقرير الإنتاج): فاتورة 830 بقيمة 34,360.328 $ وحسم
// (TotalDisc) 0.33 $، بلا دفعة (FirstPay = 0). قيدها في الأمين سند واحد: مدين
// 34,360.328 ودائن 0.33 على الزبون (docPrev 0 ← docNew 34,359.998)، وبلا billGuid لأن
// الربط القطعي محصور بقيود المرتجعات. فكان الموقع يعرض السطر الدائن 0.33 في
// «سندات القبض» بعنوان «دفعة: 0.33» ويسمح بتصدير «سند قبض» له — بينما لم يُسجَّل
// أي قبض (payment_records فارغ لهذا الزبون). مستند الفاتورة نفسه كان صحيحاً.
//
// الفحص يشغّل **الدوال الحقيقية** المستخرجة من `src/app.js` داخل vm. الأسماء
// والمعرّفات مصطنعة؛ الأرقام وحدها منقولة من الشاهد لأنها ما يُختبر.
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
  escapeHtml: /function escapeHtml\(value\) \{[\s\S]*?\n\}\n/,
  todayIsoDate: /function todayIsoDate\(\) \{[\s\S]*?\n\}\n/,
  shortDateTime: /function shortDateTime\(value\) \{[\s\S]*?\n\}\n/,
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
  customerFullMovements: /function customerFullMovements\(item\) \{[\s\S]*?\n\}\n/,
  RETURN_LINK_MARKER: /const RETURN_LINK_MARKER = "er000-return-v1";/,
  movementsReportLinksReturns: /function movementsReportLinksReturns\(\) \{[\s\S]*?\n\}\n/,
  movementReturnLink: /function movementReturnLink\(movement\) \{[\s\S]*?\n\}\n/,
  creditMovementKind: /function creditMovementKind\(customer, movement, fromLinkedLedger\) \{[\s\S]*?\n\}\n/,
  invoiceDiscountCreditLine: /function invoiceDiscountCreditLine\(customer, movement\) \{[\s\S]*?\n\}\n/,
  formatInvoiceMoney: /function formatInvoiceMoney\(value\) \{[\s\S]*?\n\}\n/,
  balanceText: /function balanceText\(bal, cur, money = formatMoney\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRows: /function voucherLedgerRows\(v\) \{[\s\S]*?\n\}\n/,
  voucherAccountBalanceRow: /function voucherAccountBalanceRow\(rows, v, balCur\) \{[\s\S]*?\n\}\n/,
  voucherInvoiceBalanceRows: /function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
  voucherSingleBalanceRows: /function voucherSingleBalanceRows\(rows, v, cur, balCur, isInv, isRet, balLabel\) \{[\s\S]*?\n\}\n/
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
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);
const { creditMovementKind, voucherLedgerRows, roundPrice, formatMoney, formatInvoiceMoney } = sandbox;

// ===== بيانات مجهولة الهوية بأرقام الشاهد =====

const G = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUST = { name: "زبون الشاهد", customerGuid: G(0x830) };
const INV_830 = { guid: G(0x8300), number: "830", date: "2026-09-23", total: 34360.328, discount: 0.33, payment: 0, currency: "USD", currencyVal: 1, isReturn: false, customerGuid: CUST.customerGuid, lines: [] };

// قيد الفاتورة كما وصل من push-customer-movements.ps1 حرفياً (سطران على سند واحد).
const DEBIT_830 = { date: "2026-09-23", debit: 34360.328, credit: 0, notes: "", billGuid: "", balance: 34360.328, balanceChrono: 34360.328, docPrev: 0, docNew: 34359.998 };
const DISC_830 = { date: "2026-09-23", debit: 0, credit: 0.33, notes: "", billGuid: "", balance: 34359.998, balanceChrono: 34359.998, docPrev: 0, docNew: 34359.998 };

function reset({ invoices = [INV_830], movements = [DEBIT_830, DISC_830], linked = true } = {}) {
  state.customerInvoicesReport = { summary: { periodDays: 60 }, items: [{ name: CUST.name, customerGuid: CUST.customerGuid, invoices }] };
  state.customerMovementsReport = {
    summary: { fromDate: "2026-06-23", periodDays: 92, ...(linked ? { billLinks: "er000-return-v1" } : {}) },
    items: [{ name: CUST.name, customerGuid: CUST.customerGuid, openingBalance: 0, movements }]
  };
  state.customerBalanceReports = [{ items: [CUST] }];
}

const labels = (rows) => JSON.parse(JSON.stringify(rows.map((r) => r.label)));
const row = (rows, label) => rows.find((r) => r.label === label);

// ===== 1) الشاهد الحقيقي: 0.33 حسم على الفاتورة، لا سند قبض =====

test("فاتورة 830: السطر الدائن 0.33 حسم على الفاتورة لا «دفعة» (تقرير موسوم بالربط)", () => {
  reset();
  const k = creditMovementKind(CUST, DISC_830, true);
  assert.equal(k.kind, "invoice-discount");
  assert.equal(k.invoice.number, "830");
});

test("فاتورة 830: التصنيف نفسه في تقرير قديم بلا علامة ربط", () => {
  reset({ linked: false });
  assert.equal(creditMovementKind(CUST, DISC_830).kind, "invoice-discount");
});

test("زر السند (القيد مُعاد بناؤه من data-*، القيم نصوص) يرفض طبع سند قبض للحسم", () => {
  reset();
  const fromButton = { date: DISC_830.date, credit: 0.33, billGuid: "", docPrev: "0", docNew: "34359.998" };
  assert.equal(creditMovementKind(CUST, fromButton, true).kind, "invoice-discount");
});

test("مستند فاتورة 830: السابق 0 + 34,360.328 − الحسم 0.33 = 34,359.998 خاماً، ويُطبع 34,360.00 بلا «دفعة» وبلا تسوية", () => {
  const prev = roundPrice(DEBIT_830.docPrev);
  const next = roundPrice(DEBIT_830.docNew);
  const adjust = roundPrice(prev + INV_830.total - INV_830.discount - INV_830.payment - next);
  assert.equal(adjust, 0, "المعادلة تُغلق من الحسم وحده");
  const rows = voucherLedgerRows({ type: "invoice", cur: "$", date: "2026-09-23", amount: INV_830.total, prevBalance: prev, newBalance: next, discount: INV_830.discount });
  assert.deepEqual(labels(rows), ["التاريخ", "الرصيد السابق", "قيمة هذه الفاتورة", "الحسم", "الرصيد الجديد"]);
  assert.equal(row(rows, "الرصيد السابق").value, "مسدّد (صفر)");
  assert.equal(row(rows, "قيمة هذه الفاتورة").value, "34,360.33 $");
  assert.equal(row(rows, "الحسم").value, "− 0.33 $");
  assert.equal(row(rows, "الرصيد الجديد").value, "34,360.00 $ (عليكم)");
  assert.ok(!JSON.stringify(rows).includes("34,359.998"), "الرصيد طُبع بثلاث منازل");
  assert.ok(!labels(rows).includes("دفعة من الزبون"));
});

// ===== 2) القبض الحقيقي يبقى قبضاً: 34,306.33 − 0.33 = 34,306.00 =====

// سند قبض مستقل: سند قيد خاص به، فرصيدا سنده يبدآن من رصيد ما قبله.
const RECEIPT_033 = { date: "2026-09-23", debit: 0, credit: 0.33, notes: "", billGuid: "", balance: 34306, balanceChrono: 34306, docPrev: 34306.33, docNew: 34306 };

test("سند قبض 0.33 مستقل بنفس اليوم يبقى «سند قبض» ولا يلتقطه حسم الفاتورة", () => {
  const DEBIT = { ...DEBIT_830, docNew: 34306.33 };
  reset({
    invoices: [{ ...INV_830, total: 34306.33, discount: 0.33 }],
    movements: [{ ...DEBIT, debit: 34306.33, docPrev: 0, docNew: 34306.33 }, RECEIPT_033]
  });
  assert.equal(creditMovementKind(CUST, RECEIPT_033, true).kind, "receipt");
});

test("الانحدار المطلوب: الرصيد السابق 34306.33 − الدفعة 0.33 = 34306.00", () => {
  const previous = 34306.33;
  const payment = 0.33;
  const discount = 0;
  const resulting = roundPrice(previous - payment);
  assert.equal(resulting, 34306);
  assert.equal(payment, 0.33);
  assert.notEqual(discount, payment);
  const rows = voucherLedgerRows({ type: "receipt", cur: "$", date: "2026-09-23", amount: payment, balance: resulting, balanceLabel: "الرصيد بعد الدفعة" });
  assert.deepEqual(labels(rows), ["التاريخ", "الرصيد بعد الدفعة"]);
  assert.equal(row(rows, "الرصيد بعد الدفعة").value, "34,306 $ (عليكم)");
  assert.ok(!labels(rows).includes("الحسم"), "الدفعة طُبعت باسم «الحسم»");
});

// ===== 3) الدفعة المرافقة للفاتورة ليست حسماً =====

test("فاتورة بدفعة مرافقة (FirstPay 0.33) بلا حسم: الدائن لا يُعاد تصنيفه، ويُطبع «دفعة من الزبون»", () => {
  reset({ invoices: [{ ...INV_830, discount: 0, payment: 0.33 }] });
  assert.notEqual(creditMovementKind(CUST, DISC_830, true).kind, "invoice-discount");
  const rows = voucherLedgerRows({ type: "invoice", cur: "$", amount: 34360.328, prevBalance: 0, newBalance: 34359.998, payment: 0.33 });
  assert.equal(row(rows, "دفعة من الزبون").value, "− 0.33 $");
  assert.equal(row(rows, "الرصيد الجديد").value, "34,360.00 $ (عليكم)");
  assert.ok(!labels(rows).includes("الحسم"), "الدفعة طُبعت باسم «الحسم»");
});

test("حسم ودفعة بالمبلغ نفسه على الفاتورة: مبهم ⇒ لا إعادة تصنيف بالتخمين", () => {
  reset({ invoices: [{ ...INV_830, discount: 0.33, payment: 0.33 }] });
  assert.notEqual(creditMovementKind(CUST, DISC_830, true).kind, "invoice-discount");
});

test("دائن بلا رصيدَي سند (تقرير أقدم) لا يُعاد تصنيفه", () => {
  reset();
  const { docPrev, docNew, ...bare } = DISC_830;
  assert.equal(creditMovementKind(CUST, bare, true).kind, "receipt");
});

test("حسم لا يطابق حسم الفاتورة (0.34 ≠ 0.33) يبقى على سلوكه القديم", () => {
  reset();
  assert.equal(creditMovementKind(CUST, { ...DISC_830, credit: 0.34 }, true).kind, "receipt");
});

// ===== 4) الدقة والتنسيق =====

test("الدولار: التنسيق لا يطبع ضجيج الفاصلة العائمة", () => {
  assert.equal(formatMoney(roundPrice(34360.328 - 0.33)), "34,359.998");
  assert.equal(formatMoney(roundPrice(34306.33 - 0.33)), "34,306");
  assert.equal(formatMoney(roundPrice(0.1 + 0.2)), "0.3");
  assert.equal(roundPrice(34306.33 - 0.33), 34306);
});

// ===== 5) قرار العمل 2026-09-23: مبالغ فاتورة البيع وأرصدتها بمنزلتين كعرض الأمين =====

test("فاتورة 830: 34359.998 ⇒ \"34,360.00\" وليس \"34,359.998\"", () => {
  assert.equal(formatInvoiceMoney(34359.998), "34,360.00");
  assert.notEqual(formatInvoiceMoney(34359.998), "34,359.998");
  assert.equal(formatMoney(34359.998), "34,359.998", "القيمة الخام وformatMoney لم تتغيّرا");
});

test("التقريب المحاسبي نصف-للأعلى بمنزلتين، بلا انحراف الفاصلة العائمة", () => {
  const cases = [
    [34360.328, "34,360.33"], [0.33, "0.33"], [0, "0.00"], [34306, "34,306.00"],
    [1.005, "1.01"], [2.675, "2.68"], [1.004, "1.00"], [0.125, "0.13"],
    [-1.005, "-1.01"], [-0.004, "0.00"], [34306.33 - 0.33, "34,306.00"], [0.1 + 0.2, "0.30"]
  ];
  for (const [input, expected] of cases) assert.equal(formatInvoiceMoney(input), expected, String(input));
});

test("فاتورة البيع وحدها بمنزلتين: القيمة الكبيرة في القالبين، والمرتجع على formatMoney", () => {
  assert.match(appJs, /amountText: \(kind === "invoice" \? formatInvoiceMoney : formatMoney\)\(v\.amount \|\| 0\),/);
  assert.match(appJs, /escapeHtml\(\(isInv \? formatInvoiceMoney : formatMoney\)\(v\.amount \|\| 0\)\)/);
  assert.match(appJs, /const money = isRet \? formatMoney : formatInvoiceMoney;/);
});

test("المرتجع وسند القبض باقيان على صياغتهما (القرار لفاتورة البيع وحدها)", () => {
  const ret = voucherLedgerRows({ type: "return", cur: "$", amount: 420.02, prevBalance: 2751.848, newBalance: 2331.848, discount: 0.02 });
  assert.equal(row(ret, "الرصيد السابق").value, "2,751.848 $ (عليكم)");
  assert.equal(row(ret, "قيمة هذا المرتجع").value, "420.02 $");
  assert.equal(row(ret, "حسم على المرتجع").value, "+ 0.02 $");
  assert.equal(row(ret, "الرصيد الجديد").value, "2,331.848 $ (عليكم)");
  const rec = voucherLedgerRows({ type: "receipt", cur: "$", amount: 0.33, balance: 34359.998, balanceLabel: "الرصيد بعد الدفعة" });
  assert.equal(row(rec, "الرصيد بعد الدفعة").value, "34,359.998 $ (عليكم)");
});

test("أسعار الأصناف وكمياتها وقيم أسطرها لا تمرّ بصيغة المنزلتين", () => {
  for (const fn of ["invoiceLinePrice", "invoiceLineValueText", "invoiceLineQty", "invoiceLineQtyParts", "invoiceLineUnitPrice", "invoiceLineBasisPlan"]) {
    const body = appJs.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`));
    assert.ok(body, `لم أجد ${fn}`);
    assert.ok(!body[0].includes("formatInvoiceMoney"), `${fn} صار بمنزلتين`);
  }
});

// ===== 6) لوحة الزبون تفصل سطر الحسم عن سندات القبض وعن المرتجعات =====

test("لوحة الزبون: invoice-discount خارج «سندات القبض» وخارج «المرتجعات»", () => {
  assert.match(appJs, /const returnMoves = classifiedCredits\.filter\(\(m\) => m\._retKind !== "receipt" && m\._retKind !== "invoice-discount"\);/);
  assert.match(appJs, /const paymentMoves = classifiedCredits\.filter\(\(m\) => m\._retKind === "receipt"\);/);
  assert.match(appJs, /حسم على الفاتورة: /);
});

// ===== النتيجة =====

console.log("فحص حسم الفاتورة ≠ سند القبض (شاهد 830):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
