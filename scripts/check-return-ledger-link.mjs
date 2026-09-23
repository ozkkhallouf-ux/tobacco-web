// ============================================================================
// فحص انحداري: **فرز المرتجع وأرصدة مستنده من ربط قيده بفاتورته (er000).**
//
// الأعطال الثلاثة المُثبتة على بيانات الأمين الحقيقية (AmnDb002، 2026-09-23):
//   1) سندات قبض صُنِّفت مرتجعات: المطابقة بالتاريخ والمبلغ بفارق «أقل من 1»،
//      ثم بالمبلغ وحده. زبون A: قبض 20.00 بيوم مرتجع 19.80. زبون B: قبضات
//      3.547 و4.85 و3.37 حول مرتجع 4.226.
//   2) «الرصيد بعد المرتجع» كان الرصيد الحالي للزبون لا رصيد لحظة القيد.
//   3) حسم المرتجع #32 (420.02 − 0.02) لم يظهر، فلم يُغلق الدفتر بفارق 0.02.
//
// السبب الجذري: `en000.BiGUID` صفري في كل أسطر حسابات الزبائن (2378/2378)،
// بينما الربط القطعي في `er000` (ParentType=2 ⇐ bu000). المزامنة تملأ منه
// `billGuid` و`billType`.
//
// الشواهد مجهَّلة: الأسماء والمعرّفات مختلَقة، والمبالغ والأرصدة كما في الأمين.
// الفحص يشغّل **الدوال الحقيقية** المستخرجة من `src/app.js` داخل vm، ويفحص نصّ
// `tools/push-customer-movements.ps1` فحصاً ساكناً.
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
const syncPs1 = readFileSync(new URL("../tools/push-customer-movements.ps1", import.meta.url), "utf8")
  .replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

const fn = (name) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`);
const PATTERNS = {
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  escapeHtml: fn("escapeHtml"),
  roundPrice: fn("roundPrice"),
  todayIsoDate: fn("todayIsoDate"),
  shortDateTime: fn("shortDateTime"),
  docNumber: fn("docNumber"),
  formatMoney: fn("formatMoney"),
  normalizeItemName: fn("normalizeItemName"),
  smartNameMatch: fn("smartNameMatch"),
  normGuid: fn("normGuid"),
  customerIdentity: fn("customerIdentity"),
  customerInvoiceEntries: fn("customerInvoiceEntries"),
  invoiceIdentityCacheVar: /let _invoiceIdentityCache = null;/,
  invoiceIdentityCache: fn("invoiceIdentityCache"),
  customerInvoiceEntryFor: fn("customerInvoiceEntryFor"),
  customerInvoicesFor: fn("customerInvoicesFor"),
  invoiceByGuid: fn("invoiceByGuid"),
  reportSyncedAt: fn("reportSyncedAt"),
  latestCustomerBalanceItems: fn("latestCustomerBalanceItems"),
  customerFullMovements: fn("customerFullMovements"),
  movementHasBillLink: fn("movementHasBillLink"),
  movementBillType: fn("movementBillType"),
  isReturnLegMovement: fn("isReturnLegMovement"),
  isReturnCreditMovement: fn("isReturnCreditMovement"),
  findReturnInvoiceForMovement: fn("findReturnInvoiceForMovement"),
  returnDocLedger: fn("returnDocLedger"),
  returnVoucherOptions: fn("returnVoucherOptions"),
  movementLinkAttrs: fn("movementLinkAttrs"),
  movementFromDataset: fn("movementFromDataset"),
  returnLedgerMovement: fn("returnLedgerMovement"),
  balanceText: fn("balanceText"),
  voucherLedgerRows: fn("voucherLedgerRows"),
  voucherAccountBalanceRow: fn("voucherAccountBalanceRow"),
  voucherInvoiceBalanceRows: fn("voucherInvoiceBalanceRows"),
  voucherSingleBalanceRows: fn("voucherSingleBalanceRows")
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
const sandbox = { console, state, Intl, applyCustomerLimits: (items) => items };
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);
// مصفوفات vm من عالم آخر: نسلسلها قبل deepEqual كي تُقارن القيم لا النماذج.
const plain = (value) => JSON.parse(JSON.stringify(value));
const {
  movementHasBillLink, movementBillType, isReturnLegMovement, isReturnCreditMovement,
  findReturnInvoiceForMovement, returnDocLedger, returnVoucherOptions, movementLinkAttrs,
  movementFromDataset, returnLedgerMovement, voucherLedgerRows
} = sandbox;

// ===== الشواهد المجهَّلة =====

const CA = "aaaaaaaa-0000-4000-8000-00000000000a"; // زبون A
const CB = "aaaaaaaa-0000-4000-8000-00000000000b"; // زبون B
const CC = "aaaaaaaa-0000-4000-8000-00000000000c"; // زبون C (مرتجع #32)
const RA = "bbbbbbbb-0000-4000-8000-0000000000a1"; // مرتجع 19.80
const RB = "bbbbbbbb-0000-4000-8000-0000000000b1"; // مرتجع 4.226
const SB = "bbbbbbbb-0000-4000-8000-0000000000b2"; // فاتورة بيع 15.036 مع رجل حسم دائن 0.017
const R32 = "bbbbbbbb-0000-4000-8000-000000000032"; // مرتجع #32

// حركة من مزامنة er000: المفتاح billType حاضر دائماً (null لغير الفواتير).
const mvL = (o) => ({ billGuid: "", billType: null, ...o });
// نفس الحركة كما في تقرير أقدم من تحديث المزامنة: بلا مفتاح billType.
const withoutBillLink = (m) => { const copy = { ...m }; delete copy.billType; return copy; };

const movementsA = [
  mvL({ date: "2026-07-13", debit: 0, credit: 100, balance: 46.666, docPrev: 146.666, docNew: 46.666 }),
  mvL({ date: "2026-07-13", debit: 0, credit: 20, balance: 26.666, docPrev: 46.666, docNew: 26.666 }),
  mvL({ date: "2026-07-13", debit: 0, credit: 19.8, billGuid: RA, billType: 3, balance: 6.866, docPrev: 26.666, docNew: 6.866 })
];
const movementsB = [
  mvL({ date: "2026-07-23", debit: 0, credit: 4.85, docPrev: 20, docNew: 15.15 }),
  mvL({ date: "2026-08-24", debit: 0, credit: 3.37, docPrev: 15.15, docNew: 11.78 }),
  mvL({ date: "2026-09-10", debit: 0, credit: 3.547, docPrev: 13.218, docNew: 9.671 }),
  mvL({ date: "2026-09-10", debit: 0, credit: 4.226, billGuid: RB, billType: 3, docPrev: 9.671, docNew: 5.445 }),
  mvL({ date: "2026-09-10", debit: 15.036, credit: 0, billGuid: SB, billType: 1, docPrev: 5.444, docNew: 20.463 }),
  mvL({ date: "2026-09-10", debit: 0, credit: 0.017, billGuid: SB, billType: 1, docPrev: 5.444, docNew: 20.463 })
];
// مرتجع #32: سطران على ذمة الزبون في السند نفسه — مدين 0.02 (حسم) ودائن 420.02.
const movementsC = [
  mvL({ date: "2026-08-26", debit: 0.02, credit: 0, billGuid: R32, billType: 3, docPrev: 2751.848, docNew: 2331.848 }),
  mvL({ date: "2026-08-26", debit: 0, credit: 420.02, billGuid: R32, billType: 3, docPrev: 2751.848, docNew: 2331.848 })
];

const retA = { number: "10", date: "2026-07-13", guid: RA, customerGuid: CA, total: 19.8, discount: 0, payment: 0, isReturn: true, lines: [] };
const retB = { number: "15", date: "2026-09-10", guid: RB, customerGuid: CB, total: 4.226, discount: 0, payment: 0, isReturn: true, lines: [] };
const saleB = { number: "1753", date: "2026-09-10", guid: SB, customerGuid: CB, total: 15.036, discount: 0.017, payment: 0, isReturn: false, lines: [] };
const ret32 = { number: "32", date: "2026-08-26", guid: R32, customerGuid: CC, total: 420.02, discount: 0.02, payment: 0, isReturn: true, lines: [] };

const custA = { name: "زبون A", customerGuid: CA, balance: 999.5 };
const custB = { name: "زبون B", customerGuid: CB, balance: 777.25 };
const custC = { name: "زبون C", customerGuid: CC, balance: 1500 }; // رصيد حالي ≠ رصيد لحظة المرتجع

function loadLinkedReports() {
  state.customerBalanceReports = [{ summary: { syncedAt: "2026-09-23T01:00:00Z" }, items: [custA, custB, custC] }];
  state.customerMovementsReport = {
    summary: { fromDate: "2026-06-23", billLink: "er000" },
    items: [
      { name: custA.name, customerGuid: CA, movements: movementsA },
      { name: custB.name, customerGuid: CB, movements: movementsB },
      { name: custC.name, customerGuid: CC, movements: movementsC }
    ]
  };
  state.customerInvoicesReport = {
    summary: { periodDays: 60 },
    items: [
      { name: custA.name, customerGuid: CA, invoices: [retA] },
      { name: custB.name, customerGuid: CB, invoices: [retB, saleB] },
      { name: custC.name, customerGuid: CC, invoices: [ret32] }
    ]
  };
}

// ===== 1) سندات القبض لا تصير مرتجعات =====

test("T1 زبون A: قبض 20.00 بيوم مرتجع 19.80 يبقى قبضاً، والمرتجع يُعرف بربطه", () => {
  loadLinkedReports();
  assert.equal(isReturnCreditMovement(custA, movementsA[1]), false);
  assert.equal(isReturnCreditMovement(custA, movementsA[0]), false);
  assert.equal(isReturnCreditMovement(custA, movementsA[2]), true);
  assert.equal(findReturnInvoiceForMovement(custA, movementsA[1]), null);
  assert.equal(findReturnInvoiceForMovement(custA, movementsA[2]).guid, RA);
});

test("T2 زبون B: قبضات 4.85 و3.37 و3.547 حول مرتجع 4.226 — لا شيء منها مرتجع", () => {
  loadLinkedReports();
  for (const m of [movementsB[0], movementsB[1], movementsB[2]]) {
    assert.equal(isReturnCreditMovement(custB, m), false, `القبض ${m.credit} صُنِّف مرتجعاً`);
    assert.equal(findReturnInvoiceForMovement(custB, m), null);
  }
  assert.equal(findReturnInvoiceForMovement(custB, movementsB[3]).guid, RB);
});

test("T3 رجل فاتورة البيع الدائن (حسم/دفعة، BillType=1) ليس مرتجعاً أبداً", () => {
  loadLinkedReports();
  assert.equal(isReturnCreditMovement(custB, movementsB[5]), false);
  assert.equal(isReturnLegMovement(movementsB[5]), false);
  assert.equal(findReturnInvoiceForMovement(custB, movementsB[5]), null);
});

test("T4 تقرير قديم بلا ربط: مطابقة صارمة بنفس اليوم وسنت — لا «المبلغ وحده» ولا «أقل من 1»", () => {
  loadLinkedReports();
  const legacy = (m) => ({ ...withoutBillLink(m), billGuid: "00000000-0000-0000-0000-000000000000" });
  assert.equal(movementHasBillLink(legacy(movementsA[1])), false);
  assert.equal(isReturnCreditMovement(custA, legacy(movementsA[1])), false, "20.00 مقابل 19.80 بفارق 0.20");
  assert.equal(isReturnCreditMovement(custB, legacy(movementsB[0])), false, "4.85 بيوم آخر");
  assert.equal(isReturnCreditMovement(custB, legacy(movementsB[1])), false, "3.37 بيوم آخر");
  assert.equal(isReturnCreditMovement(custB, legacy(movementsB[2])), false, "3.547 بنفس اليوم وفارق 0.679");
  assert.equal(isReturnCreditMovement(custA, legacy(movementsA[2])), true, "المرتجع الحقيقي يبقى مرتجعاً");
});

test("T5 billType null لا يصير صفراً (مشتريات)، والصفر نوع حقيقي وليس مرتجعاً", () => {
  assert.equal(movementBillType({ billGuid: SB, billType: null }), null);
  assert.equal(movementBillType({ billGuid: SB, billType: 0 }), 0);
  assert.equal(isReturnLegMovement({ billGuid: SB, billType: 0 }), false);
  assert.equal(movementBillType({ billGuid: "00000000-0000-0000-0000-000000000000", billType: 3 }), null, "معرّف صفري ليس ربطاً");
});

// ===== 2) رصيد المرتجع من قيده لا من الرصيد الحالي =====

test("T6 #32: السابق 2751.848 − (420.02 − 0.02) = الجديد 2331.848، والحسم ظاهر", () => {
  loadLinkedReports();
  const ledger = returnDocLedger(ret32, movementsC[1]);
  assert.equal(ledger.ok, true, ledger.reason);
  assert.equal(ledger.prevBalance, 2751.848);
  assert.equal(ledger.newBalance, 2331.848);
  assert.equal(ledger.discount, 0.02);
});

test("T7 مستند المرتجع لا يحمل الرصيد الحالي أبداً (المساران)", () => {
  loadLinkedReports();
  const fromMovement = returnVoucherOptions({ name: custC.name, cur: "$" }, ret32, movementsC[1]);
  const fromReport = returnVoucherOptions({ name: custC.name, cur: "$" }, ret32, returnLedgerMovement(custC, ret32));
  for (const opts of [fromMovement, fromReport]) {
    assert.equal(opts.type, "return");
    assert.equal(opts.prevBalance, 2751.848);
    assert.equal(opts.newBalance, 2331.848);
    assert.equal(opts.balance, undefined);
    assert.equal(opts.balanceLabel, undefined);
    assert.equal(opts.accountBalance, undefined);
    assert.notEqual(opts.newBalance, custC.balance);
  }
});

test("T8 مسار التقارير يجد قيد المرتجع الدائن بمعرّفه، لا سطر حسمه المدين", () => {
  loadLinkedReports();
  const m = returnLedgerMovement(custC, ret32);
  assert.equal(m.credit, 420.02);
  assert.equal(returnLedgerMovement(custA, retA).credit, 19.8);
});

// ===== 3) الحسم في مستند المرتجع =====

test("T9 أسطر مستند #32: السابق ← القيمة ← «الحسم على المرتجع +0.02» ← الجديد، وتُغلق", () => {
  loadLinkedReports();
  const opts = returnVoucherOptions({ name: custC.name, cur: "$", date: "2026-08-26" }, ret32, movementsC[1]);
  const rows = voucherLedgerRows(opts);
  const labels = plain(rows.map((r) => r.label));
  assert.deepEqual(labels, ["التاريخ", "الرصيد السابق", "قيمة هذا المرتجع", "الحسم على المرتجع", "الرصيد الجديد"]);
  const disc = rows.find((r) => r.label === "الحسم على المرتجع");
  assert.equal(disc.value, "+ 0.02 $");
  assert.equal(disc.tone, "deb");
  assert.equal(Math.round((opts.prevBalance - opts.amount + opts.discount) * 1000) / 1000, opts.newBalance);
});

test("T10 سطر حسم المرتجع المدين ليس فاتورة بيع", () => {
  assert.equal(isReturnLegMovement(movementsC[0]), true);
  assert.equal(isReturnLegMovement(movementsB[4]), false, "مدين فاتورة البيع يبقى فاتورة");
});

test("T11 أسطر فاتورة البيع لم تتغيّر: «الحسم −» و«دفعة من الزبون −»", () => {
  const rows = voucherLedgerRows({ type: "invoice", date: "2026-09-10", cur: "$", amount: 100, prevBalance: 10, newBalance: 102, discount: 5, payment: 3 });
  assert.deepEqual(plain(rows.map((r) => [r.label, r.value, r.tone || ""])), [
    ["التاريخ", "2026-09-10", ""],
    ["الرصيد السابق", "10 $ (عليكم)", ""],
    ["قيمة هذه الفاتورة", "100 $", ""],
    ["الحسم", "− 5 $", "cred"],
    ["دفعة من الزبون", "− 3 $", "cred"],
    ["الرصيد الجديد", "102 $ (عليكم)", ""]
  ]);
});

// ===== 4) الحالات غير المُثبتة تُغلق بلا أرصدة =====

test("T12 مرتجع بلا حساب زبون (نقدي على الصندوق) — لا رصيد إطلاقاً", () => {
  loadLinkedReports();
  const cashReturn = { ...ret32, guid: "cccccccc-0000-4000-8000-000000000001", customerGuid: "" };
  const opts = returnVoucherOptions({ name: "" }, cashReturn, null);
  assert.equal(opts.prevBalance, undefined);
  assert.equal(opts.newBalance, undefined);
  assert.equal(opts.balance, undefined);
  assert.match(opts.ledgerNotice, /بلا حساب زبون/);
  assert.deepEqual(plain(voucherLedgerRows(opts).map((r) => r.label)), ["التاريخ"]);
});

test("T13 مرتجع مسمّى بلا قيد مربوط في دفتره (مرحَّل لصندوق/حساب آخر) — fail closed", () => {
  loadLinkedReports();
  const orphan = { ...retA, guid: "cccccccc-0000-4000-8000-000000000002" };
  assert.equal(returnLedgerMovement(custA, orphan), null);
  const opts = returnVoucherOptions({ name: custA.name }, orphan, returnLedgerMovement(custA, orphan));
  assert.equal(opts.newBalance, undefined);
  assert.match(opts.ledgerNotice, /مربوطاً/);
});

test("T14 مرتجع بدفعة نقدية (FirstPay) — fail closed", () => {
  loadLinkedReports();
  const ledger = returnDocLedger({ ...ret32, payment: 5 }, movementsC[1]);
  assert.equal(ledger.ok, false);
  assert.match(ledger.reason, /دفعة نقدية/);
});

test("T15 قيد لا يُغلق (إضافة على مرتجع زبون مثلاً) — fail closed", () => {
  loadLinkedReports();
  const ledger = returnDocLedger(ret32, { ...movementsC[1], docNew: 2331.8 });
  assert.equal(ledger.ok, false);
  assert.match(ledger.reason, /لا يطابق/);
});

test("T16 حركة من تقرير قديم (بلا billType) لا تكفي لأرصدة المرتجع", () => {
  loadLinkedReports();
  const ledger = returnDocLedger(ret32, withoutBillLink(movementsC[1]));
  assert.equal(ledger.ok, false);
});

// ===== 5) نقل الربط عبر سمات الأزرار =====

test("T17 movementLinkAttrs ↔ movementFromDataset ذهاباً وإياباً", () => {
  assert.equal(movementLinkAttrs(movementsC[1]), ' data-bill-link="1" data-bill-type="3"');
  assert.equal(movementLinkAttrs(movementsA[1]), ' data-bill-link="1" data-bill-type=""');
  assert.equal(movementLinkAttrs({ credit: 1 }), "");
  const linked = movementFromDataset({ date: "2026-08-26", billGuid: R32, billLink: "1", billType: "3", docPrev: "2751.848", docNew: "2331.848" }, 420.02);
  assert.equal(linked.billType, 3);
  assert.equal(isReturnLegMovement(linked), true);
  assert.equal(returnDocLedger(ret32, linked).ok, true);
  const receipt = movementFromDataset({ date: "2026-07-13", billGuid: "", billLink: "1", billType: "" }, 20);
  assert.equal(receipt.billType, null);
  assert.equal(movementHasBillLink(receipt), true);
  const legacy = movementFromDataset({ date: "2026-07-13", billGuid: "" }, 20);
  assert.equal(movementHasBillLink(legacy), false);
});

// ===== 6) فحوص ساكنة: المستهلكون والمزامنة =====

test("T18 لوحة الزبون تفرز بالربط، وسطر حسم المرتجع خارج قائمة الفواتير", () => {
  assert.match(appJs, /const invoiceMoves = movements\.filter\(\(m\) => Number\(m\?\.debit \|\| 0\) > 0 && !isReturnLegMovement\(m\)\);/);
  assert.match(appJs, /const returnMoves = creditMoves\.filter\(\(m\) => isReturnCreditMovement\(item, m\)\);/);
  assert.match(appJs, /const paymentMoves = creditMoves\.filter\(\(m\) => !isReturnCreditMovement\(item, m\)\);/);
});

test("T19 لا مسار يطبع «الرصيد بعد المرتجع» من الرصيد الحالي", () => {
  assert.doesNotMatch(appJs, /balanceLabel = "الرصيد بعد المرتجع"/);
  assert.equal((appJs.match(/returnVoucherOptions\(/g) || []).length, 3, "التعريف + مسار الحركات + مسار التقارير");
  assert.match(appJs, /exportVoucherPdf\(returnVoucherOptions\(opts, inv, returnLedgerMovement\(ledgerCustomer, inv\)\)\);/);
  assert.match(appJs, /exportVoucherPdf\(returnVoucherOptions\(\{ \.\.\.base, cur: "\$" \}, retMatch, mv\)\);/);
});

test("T20 أزرار الحركات الثلاثة تحمل billGuid وسمات الربط", () => {
  for (const label of ["📄 فاتورة PDF", "📄 فاتورة مرتجع PDF", "📄 سند قبض PDF"]) {
    const re = new RegExp(`data-bill-guid="\\$\\{escapeHtml\\(String\\(m\\?\\.billGuid \\|\\| ""\\)\\)\\}"\\$\\{movementLinkAttrs\\(m\\)\\} style="margin-top:6px">${label}</button>`);
    assert.match(appJs, re, label);
  }
});

test("T21 المزامنة: billGuid من er000 (ParentType=2) وbillType والعلامة، بلا BiGUID", () => {
  assert.match(syncPs1, /LEFT JOIN dbo\.er000 er ON er\.EntryGUID = en\.ParentGUID AND er\.ParentType = 2/);
  assert.match(syncPs1, /CASE WHEN er\.ParentType = 2 THEN LOWER\(CAST\(er\.ParentGUID AS varchar\(40\)\)\) ELSE '' END AS bill_guid/);
  assert.match(syncPs1, /bt\.BillType AS bill_type/);
  assert.match(syncPs1, /billType = \$\(if \(\$r\.IsDBNull\(10\)\) \{ \$null \} else \{ \[int\]\$r\.GetValue\(10\) \}\)/);
  assert.match(syncPs1, /billLink {4}= "er000"/);
  assert.doesNotMatch(syncPs1, /COALESCE\(bib\.ParentGUID, en\.BiGUID\)/);
  assert.doesNotMatch(syncPs1, /JOIN dbo\.bi000 bib/);
});

test("T22 المزامنة: حارس القيد متعدد الربط يوقف الرفع", () => {
  assert.match(syncPs1, /GROUP BY EntryGUID HAVING COUNT\(\*\) > 1/);
  assert.match(syncPs1, /if \(\$multiLinked -gt 0\) \{ throw /);
});

test("T23 المزامنة: استعلامات الأمين قراءة فقط", () => {
  const sqlBlocks = [...syncPs1.matchAll(/CommandText = @"\n([\s\S]*?)\n"@/g)].map((m) => m[1])
    .concat([...syncPs1.matchAll(/CommandText = "([^"]*)"/g)].map((m) => m[1]));
  assert.ok(sqlBlocks.length >= 3, "لم أجد استعلامات الأمين");
  for (const sql of sqlBlocks) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE|EXEC|EXECUTE)\b/i);
  }
});

// ===== النتيجة =====

console.log("فحص ربط المرتجع بقيده (er000):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
