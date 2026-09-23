// ============================================================================
// فحص انحداري: **مرتجع المبيعات — ربط قطعي بقيده، وأرصدة قيده هو، وبلا تخمين.**
//
// الأعطال الحقيقية التي يمنعها (مُثبتة من قيود الأمين وتقرير الإنتاج، 2026-09-22):
//   D1 سند قبض طُبع «فاتورة مرتجع»: كان المرتجع يُطابق بقيد دائن بفرق مبلغ < 1$ ثم
//      بالمبلغ وحده — فالتقط قبض 20.00 مقابل مرتجع 19.80 بنفس اليوم، وثلاث قبضات
//      4.85/3.37/3.55 مقابل مرتجع 4.226.
//   D2 «الرصيد بعد المرتجع» كان الرصيد الحالي للحساب، لا رصيد قيد المرتجع.
//   D3 حسم المرتجع (قيد مدين على الزبون) لم يكن يُعرض، ومعادلة الرصيد لا تُغلق.
//
// المصدر المُثبت للربط: er000 (ParentType = 2) — يحمله `push-customer-movements.ps1`
// في `billGuid` لقيود مرتجع المبيعات وحدها، ويَسِم التقرير بـ`summary.billLinks`.
//
// كل البيانات هنا مجهولة الهوية: أسماء ومعرّفات مصطنعة، والأرقام وحدها منقولة من
// الشواهد المحاسبية لأنها ما يُختبر. الفحص يشغّل **الدوال الحقيقية** المستخرجة من
// `src/app.js` داخل vm — لا نسخة مبسّطة.
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
const movementsPs = readFileSync(new URL("../tools/push-customer-movements.ps1", import.meta.url), "utf8");

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
  movementsReportLinksReturns: /function movementsReportLinksReturns\(\) \{[\s\S]*?\n\}\n/,
  movementReturnLink: /function movementReturnLink\(movement\) \{[\s\S]*?\n\}\n/,
  creditMovementKind: /function creditMovementKind\(customer, movement\) \{[\s\S]*?\n\}\n/,
  returnMovementForBill: /function returnMovementForBill\(billGuid\) \{[\s\S]*?\n\}\n/,
  returnLedgerBalances: /function returnLedgerBalances\(inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  applyReturnLedger: /function applyReturnLedger\(opts, inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  applyReturnLedgerForBill: /function applyReturnLedgerForBill\(opts, inv\) \{[\s\S]*?\n\}\n/,
  movementsReportCovers: /function movementsReportCovers\(dateStr\) \{[\s\S]*?\n\}\n/,
  balanceText: /function balanceText\(bal, cur\) \{[\s\S]*?\n\}\n/,
  voucherInvoiceBalanceRows: /function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/
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

const state = {
  customerInvoicesReport: null,
  customerMovementsReport: null,
  customerBalanceReports: []
};
const sandbox = { console, Intl, state, applyCustomerLimits: (items) => items };
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);
const {
  movementReturnLink, creditMovementKind, returnMovementForBill, returnLedgerBalances,
  applyReturnLedger, applyReturnLedgerForBill, voucherInvoiceBalanceRows
} = sandbox;

// ===== بيانات مجهولة الهوية =====

const G = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CUST_A = { name: "زبون أ", customerGuid: G(0xa1) }; // شاهد D1: قبض 20.00 مقابل مرتجع 19.80
const CUST_B = { name: "زبون ب", customerGuid: G(0xb1) }; // شاهد D1: قبضات مقابل مرتجع 4.226
const CUST_C = { name: "زبون ج", customerGuid: G(0xc1) }; // شاهد #32: مرتجع بحسم
const CUST_D = { name: "زبون د", customerGuid: G(0xd1) }; // مرتجع عادي

const RET_A = G(0x1a);
const RET_B = G(0x1b);
const RET_32 = G(0x32);
const RET_D = G(0x1d);
const SALE_D = G(0x5d);

const invoicesReport = {
  summary: { periodDays: 60 },
  items: [
    { name: CUST_A.name, customerGuid: CUST_A.customerGuid, invoices: [
      { guid: RET_A, number: "11", date: "2026-09-10", total: 19.8, discount: 0, payment: 0, isReturn: true, customerGuid: CUST_A.customerGuid, lines: [] }
    ] },
    { name: CUST_B.name, customerGuid: CUST_B.customerGuid, invoices: [
      { guid: RET_B, number: "12", date: "2026-09-11", total: 4.226, discount: 0, payment: 0, isReturn: true, customerGuid: CUST_B.customerGuid, lines: [] }
    ] },
    { name: CUST_C.name, customerGuid: CUST_C.customerGuid, invoices: [
      { guid: RET_32, number: "32", date: "2026-09-12", total: 420.02, discount: 0.02, payment: 0, isReturn: true, customerGuid: CUST_C.customerGuid, lines: [] }
    ] },
    { name: CUST_D.name, customerGuid: CUST_D.customerGuid, invoices: [
      { guid: RET_D, number: "40", date: "2026-09-13", total: 50, discount: 0, payment: 0, isReturn: true, customerGuid: CUST_D.customerGuid, lines: [] },
      { guid: SALE_D, number: "900", date: "2026-09-13", total: 50, discount: 0, payment: 0, isReturn: false, customerGuid: CUST_D.customerGuid, lines: [] }
    ] }
  ]
};

// تقرير حركات موسوم بالربط (المزامنة الجديدة): قيد المرتجع يحمل معرّف فاتورته على
// سطر الدائن وسطر حسمه معاً؛ سندات القبض وفواتير البيع بلا معرّف.
function linkedMovements() {
  return {
    summary: { fromDate: "2026-06-23", billLinks: "er000-return-v1", periodDays: 92 },
    items: [
      { name: CUST_A.name, customerGuid: CUST_A.customerGuid, movements: [
        { date: "2026-09-10", debit: 0, credit: 20, billGuid: "", docPrev: 100, docNew: 80 },
        { date: "2026-09-10", debit: 0, credit: 19.8, billGuid: RET_A, docPrev: 80, docNew: 60.2 }
      ] },
      { name: CUST_B.name, customerGuid: CUST_B.customerGuid, movements: [
        { date: "2026-09-11", debit: 0, credit: 4.85, billGuid: "" },
        { date: "2026-09-11", debit: 0, credit: 3.37, billGuid: "" },
        { date: "2026-09-11", debit: 0, credit: 3.55, billGuid: "" },
        { date: "2026-09-11", debit: 0, credit: 4.226, billGuid: RET_B, docPrev: 30, docNew: 25.774 }
      ] },
      { name: CUST_C.name, customerGuid: CUST_C.customerGuid, movements: [
        { date: "2026-09-12", debit: 0, credit: 420.02, billGuid: RET_32, docPrev: 2751.848, docNew: 2331.848 },
        { date: "2026-09-12", debit: 0.02, credit: 0, billGuid: RET_32, docPrev: 2751.848, docNew: 2331.848 }
      ] },
      { name: CUST_D.name, customerGuid: CUST_D.customerGuid, movements: [
        { date: "2026-09-13", debit: 50, credit: 0, billGuid: "00000000-0000-0000-0000-000000000000", docPrev: 150, docNew: 200 },
        { date: "2026-09-13", debit: 0, credit: 50, billGuid: RET_D, docPrev: 200, docNew: 150 }
      ] }
    ]
  };
}

// التقرير المنشور حالياً (قبل وصول المزامنة الجديدة): لا علامة، والمعرّف صفري دائماً.
function oldMovements() {
  const r = linkedMovements();
  delete r.summary.billLinks;
  for (const it of r.items) for (const m of it.movements) m.billGuid = "00000000-0000-0000-0000-000000000000";
  return r;
}

function reset(movements) {
  state.customerInvoicesReport = invoicesReport;
  state.customerMovementsReport = movements;
  state.customerBalanceReports = [{ items: [CUST_A, CUST_B, CUST_C, CUST_D] }];
}
const movesOf = (cust) => state.customerMovementsReport.items.find((x) => x.customerGuid === cust.customerGuid).movements;

// ===== D1: القبض لا يصير مرتجعاً =====

test("مرتجع عادي مربوط: يُصنَّف مرتجعاً بفاتورته وأرصدة قيده", () => {
  reset(linkedMovements());
  const m = movesOf(CUST_D)[1];
  const k = creditMovementKind(CUST_D, m);
  assert.equal(k.kind, "return");
  assert.equal(k.invoice.number, "40");
  const opts = applyReturnLedger({}, k.invoice, m.docPrev, m.docNew);
  assert.equal(opts.prevBalance, 200);
  assert.equal(opts.newBalance, 150);
  assert.equal(opts.discount, undefined);
  assert.equal(opts.ledgerWarning, undefined);
});

test("زبون أ: قبض 20.00 بنفس يوم مرتجع 19.80 يبقى سند قبض، والمرتجع بمعرّفه", () => {
  reset(linkedMovements());
  const [receipt, ret] = movesOf(CUST_A);
  assert.equal(creditMovementKind(CUST_A, receipt).kind, "receipt");
  const k = creditMovementKind(CUST_A, ret);
  assert.equal(k.kind, "return");
  assert.equal(k.invoice.guid, RET_A);
});

test("زبون ب: القبضات 4.85/3.37/3.55 كلها سندات قبض، والمرتجع 4.226 وحده مرتجع", () => {
  reset(linkedMovements());
  const moves = movesOf(CUST_B);
  assert.deepEqual(moves.map((m) => creditMovementKind(CUST_B, m).kind), ["receipt", "receipt", "receipt", "return"]);
});

test("تقرير قديم بلا ربط: لا تاريخ ولا مبلغ يجعل قيداً مرتجعاً أبداً", () => {
  reset(oldMovements());
  for (const cust of [CUST_A, CUST_B, CUST_C, CUST_D]) {
    for (const m of movesOf(cust)) {
      const k = creditMovementKind(cust, m);
      assert.notEqual(k.kind, "return", `${cust.name} ${m.credit}`);
      assert.equal(movementReturnLink(m), null);
    }
  }
});

test("تقرير قديم: القبض القريب مبلغاً يبقى قبضاً، والمطابق تماماً لمرتجع لا يُطبع أي مستند", () => {
  reset(oldMovements());
  const [receiptA, retA] = movesOf(CUST_A);
  assert.equal(creditMovementKind(CUST_A, receiptA).kind, "receipt"); // 20.00 مقابل 19.80
  assert.equal(creditMovementKind(CUST_A, retA).kind, "unclassified"); // 19.80 = مرتجع فعلي
  const kindsB = movesOf(CUST_B).map((m) => creditMovementKind(CUST_B, m).kind);
  assert.deepEqual(kindsB, ["receipt", "receipt", "receipt", "unclassified"]);
});

test("قيد دائن بلا معرّف في تقرير موسوم = سند قبض حتى لو طابق مرتجعاً يوماً ومبلغاً", () => {
  reset(linkedMovements());
  assert.equal(creditMovementKind(CUST_D, { date: "2026-09-13", credit: 50, billGuid: "" }).kind, "receipt");
});

test("مرتجع مربوط لزبون آخر: غير مصنَّف، لا مستند", () => {
  reset(linkedMovements());
  assert.equal(creditMovementKind(CUST_A, { date: "2026-09-13", credit: 50, billGuid: RET_D }).kind, "unclassified");
});

test("مرتجع مربوط تفاصيله لم تُزامَن: return-pending، لا سند قبض ولا مرتجع", () => {
  reset(linkedMovements());
  assert.equal(creditMovementKind(CUST_D, { date: "2026-09-13", credit: 7, billGuid: G(0xeee) }).kind, "return-pending");
  // تقرير قديم بمعرّف مجهول: لا يُفترض أنه مرتجع.
  reset(oldMovements());
  assert.equal(movementReturnLink({ billGuid: G(0xeee) }), null);
});

// ===== شاهد #32 وحسم المرتجع =====

test("#32: إجمالي 420.02 / حسم 0.02 / صافٍ 420.00 — المعادلة تُغلق على 2751.848 ← 2331.848", () => {
  reset(linkedMovements());
  const inv = invoicesReport.items[2].invoices[0];
  assert.equal(inv.total, 420.02);
  assert.equal(inv.discount, 0.02);
  assert.equal(Math.round((inv.total - inv.discount) * 1000) / 1000, 420);
  const r = returnLedgerBalances(inv, 2751.848, 2331.848);
  assert.equal(r.warning, undefined);
  assert.equal(r.prevBalance, 2751.848);
  assert.equal(r.newBalance, 2331.848);
  assert.equal(r.discount, 0.02);
  assert.equal(Math.round((r.prevBalance - inv.total + r.discount - r.newBalance) * 1000) / 1000, 0);
});

test("#32: مسار قوائم الفواتير يجد قيده بمعرّفه ويطبع سطر حسم «+» يرفع الرصيد", () => {
  reset(linkedMovements());
  const inv = invoicesReport.items[2].invoices[0];
  const opts = applyReturnLedgerForBill({ type: "return", amount: inv.total }, inv);
  assert.equal(opts.ledgerWarning, undefined);
  assert.equal(opts.prevBalance, 2751.848);
  assert.equal(opts.newBalance, 2331.848);
  assert.equal(opts.discount, 0.02);
  const rows = [];
  voucherInvoiceBalanceRows(rows, opts, "$", "$", true);
  const disc = rows.find((x) => x.label === "حسم على المرتجع");
  assert.ok(disc, "سطر حسم المرتجع غائب");
  assert.equal(disc.value, "+ 0.02 $");
  assert.equal(disc.tone, "deb");
  assert.equal(rows.find((x) => x.label === "قيمة هذا المرتجع").value, "420.02 $");
  assert.ok(!rows.some((x) => x.label === "الحسم"), "حسم المرتجع طُبع بإشارة حسم البيع");
});

test("#32: سطر الحسم المدين 0.02 جزء من المرتجع، لا فاتورة بيع", () => {
  reset(linkedMovements());
  const discRow = movesOf(CUST_C)[1];
  assert.ok(movementReturnLink(discRow), "سطر حسم المرتجع لم يُعرف كجزء من المرتجع");
  // لائحة الفواتير في لوحة الزبون تستثنيه بهذا الربط نفسه، وزر مستندها يرفضه.
  assert.match(appJs, /const invoiceMoves = movements\.filter\(\(m\) => Number\(m\?\.debit \|\| 0\) > 0 && !movementReturnLink\(m\)\);/);
  assert.match(appJs, /if \(movementReturnLink\(\{ billGuid: el\.dataset\.billGuid \}\)\) \{/);
});

// ===== فشل مغلق للدلالات غير المثبتة =====

test("مرتجع صندوق بلا حساب زبون: لا رصيد سابق/جديد/حالي", () => {
  const inv = { guid: G(0xca5), isReturn: true, total: 30, discount: 0, payment: 0, customerGuid: "" };
  const opts = applyReturnLedger({}, inv, 10, -20);
  assert.ok(opts.ledgerWarning);
  for (const k of ["prevBalance", "newBalance", "balance", "accountBalance", "discount"]) assert.equal(opts[k], undefined, k);
});

test("مرتجع عليه دفعة/استرداد نقدي: دلالة غير مثبتة، بلا رصيد", () => {
  const inv = { ...invoicesReport.items[3].invoices[0], payment: 50 };
  const r = returnLedgerBalances(inv, 200, 150);
  assert.ok(r.warning);
  assert.equal(r.newBalance, undefined);
});

test("معادلة لا تُغلق (فرق غير مفسَّر): بلا رصيد", () => {
  const inv = invoicesReport.items[3].invoices[0];
  const r = returnLedgerBalances(inv, 200, 149);
  assert.match(r.warning, /لا يُغلق/);
  assert.equal(r.prevBalance, undefined);
});

test("قيد بلا أرصدة مخزَّنة: بلا رصيد — لا رصيد حالي بديلاً", () => {
  const inv = invoicesReport.items[3].invoices[0];
  for (const [p, n] of [["", ""], [undefined, 150], [200, null], ["x", 150]]) {
    const opts = applyReturnLedger({}, inv, p, n);
    assert.ok(opts.ledgerWarning, `${p}/${n}`);
    assert.equal(opts.newBalance, undefined);
    assert.equal(opts.balance, undefined);
  }
});

test("ربط مبهم: قيدان دائنان بمعرّف مرتجع واحد ⇒ لا قيد، وتحذير بلا رصيد", () => {
  reset(linkedMovements());
  movesOf(CUST_D).push({ date: "2026-09-13", debit: 0, credit: 50, billGuid: RET_D, docPrev: 150, docNew: 100 });
  assert.equal(returnMovementForBill(RET_D), null);
  const opts = applyReturnLedgerForBill({}, invoicesReport.items[3].invoices[0]);
  assert.ok(opts.ledgerWarning);
  assert.equal(opts.newBalance, undefined);
});

test("مرتجع مسمّى لا قيد له في تقرير موسوم يغطّي تاريخه: تحذير بلا رصيد", () => {
  reset(linkedMovements());
  const inv = { guid: G(0xf00), number: "77", date: "2026-09-14", total: 5, isReturn: true, customerGuid: CUST_D.customerGuid };
  const opts = applyReturnLedgerForBill({}, inv);
  assert.match(opts.ledgerWarning, /غير مسجَّل/);
  assert.equal(opts.newBalance, undefined);
});

test("تقرير قديم: مسار قوائم الفواتير يطبع المرتجع بلا رصيد، لا الرصيد الحالي", () => {
  reset(oldMovements());
  const opts = applyReturnLedgerForBill({}, invoicesReport.items[2].invoices[0]);
  assert.match(opts.ledgerWarning, /لم يصل بعد/);
  assert.equal(opts.newBalance, undefined);
  assert.equal(opts.balance, undefined);
});

test("قيد المرتجع على حساب زبون آخر: تحذير بلا رصيد", () => {
  reset(linkedMovements());
  const inv = { ...invoicesReport.items[3].invoices[0], customerGuid: CUST_A.customerGuid };
  const opts = applyReturnLedgerForBill({}, inv);
  assert.match(opts.ledgerWarning, /زبون آخر/);
});

test("لا أثر للرصيد الحالي في مسارات المرتجع", () => {
  assert.doesNotMatch(appJs, /balanceLabel = "الرصيد بعد المرتجع"/);
  assert.doesNotMatch(appJs, /function findReturnInvoiceForMovement/);
});

// ===== فاتورة البيع بلا تغيير =====

test("فاتورة بيع: أسطر الرصيد والحسم والدفعة كما كانت حرفياً", () => {
  const rows = [];
  voucherInvoiceBalanceRows(rows, { prevBalance: 100, amount: 50, discount: 2, payment: 10, adjust: 0, newBalance: 138 }, "$", "$", false);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { label: "الرصيد السابق", value: "100 $ (عليكم)" },
    { label: "قيمة هذه الفاتورة", value: "50 $" },
    { label: "الحسم", value: "− 2 $", tone: "cred" },
    { label: "دفعة من الزبون", value: "− 10 $", tone: "cred" },
    { label: "الرصيد الجديد", value: "138 $ (عليكم)", strong: true }
  ]);
});

test("سطر فاتورة البيع (معرّف صفري أو فارغ) لا يُعدّ جزءاً من مرتجع", () => {
  for (const make of [linkedMovements, oldMovements]) {
    reset(make());
    assert.equal(movementReturnLink(movesOf(CUST_D)[0]), null);
    assert.equal(movementReturnLink({ billGuid: "" }), null);
  }
  // ومعرّف فاتورة بيع حقيقية لا يُحوِّلها مرتجعاً.
  reset(linkedMovements());
  assert.equal(movementReturnLink({ billGuid: SALE_D }), null);
});

// ===== سكربت المزامنة: ربط للمرتجعات وحدها وبلا تضاعف صفوف =====

test("المزامنة: er000 عبر OUTER APPLY بتجميع COUNT(*) = 1 — صف واحد لكل سطر، ولا ربط مبهم", () => {
  assert.match(movementsPs, /OUTER APPLY \(\s*SELECT CASE WHEN COUNT\(\*\) = 1 THEN MAX\(CAST\(er\.ParentGUID AS varchar\(40\)\)\) END AS ret_bill\s*FROM dbo\.er000 er/);
  assert.doesNotMatch(movementsPs, /GROUP BY[^\n]*er\./, "GROUP BY داخل الربط قد يعيد صفوفاً متعددة");
  assert.doesNotMatch(movementsPs, /(LEFT |INNER )?JOIN dbo\.er000/, "ربط er000 بـJOIN مباشر يضاعف أسطر en000");
});

test("المزامنة: الربط لقيود مرتجع المبيعات وحدها (ParentType = 2 وBillType = 3)", () => {
  assert.match(movementsPs, /WHERE er\.EntryGUID = en\.ParentGUID AND er\.ParentType = 2 AND rt\.BillType = 3/);
  assert.match(movementsPs, /billLinks\s+= \$\(if \(\$buTypeCol\) \{ "er000-return-v1" \} else \{ \$null \}\)/);
  assert.match(appJs, /const RETURN_LINK_MARKER = "er000-return-v1";/);
});

// ===== النتيجة =====

console.log("فحص مرتجع المبيعات (الربط والأرصدة):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
