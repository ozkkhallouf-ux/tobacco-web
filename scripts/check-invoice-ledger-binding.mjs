// ============================================================================
// فحص انحداري: **فاتورة PDF لا تحمل أرصدة قيد فاتورة أخرى، ولا «تسوية» مختلَقة.**
//
// العطل الحقيقي الذي يمنعه (مُثبت من الأمين بالقراءة فقط ومن لقطات تقريرَي الحركات
// والفواتير في Supabase، 2026-10-24). الأرقام وأرقام الفواتير حقيقية، والاسم
// والمعرّفات والأصناف مصطنعة:
//   • للزبون يومها ثلاث فواتير: 1091 (806.60، حسم 0.40)، 1092 (1060)، و1095 التي
//     أُدخلت بـ451 ثم عُدّلت إلى 796؛ ودفعتان 309 و700. الرصيد قبل اليوم 2,791.80.
//   • قيود المبيعات كلها تصل بـbillGuid فارغ. بين 15:51 و15:55 UTC كان قيد 1095
//     (451، الرصيد 3,649 ← 4,100) في الدفتر وتفاصيلها لم تصل بعد.
//   • زر «فاتورة PDF» على ذلك القيد سقط إلى «أول فاتورة بنفس التاريخ» = 1091، فطبع
//     أصناف 1091 بين رصيدَي قيد 1095، والفرق «تسوية على الحساب − 355.20»:
//     3,649 + 806.60 − 0.40 − 4,100 = 355.20 — لا قيد ولا سند بهذا المبلغ في الأمين.
//
// يشغّل **المعالجَين الحقيقيين** (`gen-movement-doc` و`gen-invoice-doc`) والدوال
// الحقيقية من `src/app.js` و`src/documents/invoice/ozk-invoice.js` داخل vm.
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

const appJs = readFileSync(new URL(process.env.OZK_APP_JS || "../src/app.js", import.meta.url), "utf8");
const invoiceJs = readFileSync(new URL("../src/documents/invoice/ozk-invoice.js", import.meta.url), "utf8");

const PATTERNS = {
  SALES_TRADE_CONSTS: /const SALES_TRADE_REGISTER_NO = [^\n]*\nconst SALES_TRADE_CAPACITY = [^\n]*\n/,
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  normGuid: /function normGuid\(value\) \{[\s\S]*?\n\}\n/,
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  formatInvoiceMoney: /function formatInvoiceMoney\(value\) \{[\s\S]*?\n\}\n/,
  reportSyncedAt: /function reportSyncedAt\(report\) \{[\s\S]*?\n\}\n/,
  customerFullMovements: /function customerFullMovements\(item\) \{[\s\S]*?\n\}\n/,
  SALE_BINDING_TOLERANCE: /const SALE_BINDING_TOLERANCE = [^\n]*\n/,
  saleAmountsEqual: /function saleAmountsEqual\(a, b\) \{[\s\S]*?\n\}\n/,
  saleLedgerCandidates: /function saleLedgerCandidates\(movements, date, amount\) \{[\s\S]*?\n\}\n/,
  saleInvoiceCandidates: /function saleInvoiceCandidates\(invoices, date, amount\) \{[\s\S]*?\n\}\n/,
  bindSaleInvoiceLedger: /function bindSaleInvoiceLedger\(\{ movements, invoices, invoice = null, movement = null \}\) \{[\s\S]*?\n\}\n/,
  invoiceLedgerResidual: /function invoiceLedgerResidual\(prev, total, discount, extra, payment, next\) \{[\s\S]*?\n\}\n/,
  invoiceKnownExtra: /function invoiceKnownExtra\(inv\) \{[\s\S]*?\n\}\n/,
  invoiceEntryProvesResidual: /function invoiceEntryProvesResidual\(movements, movement, residual\) \{[\s\S]*?\n\}\n/,
  saleBindingRefusal: /function saleBindingRefusal\(reason, amount, date, item\) \{[\s\S]*?\n\}\n/,
  movementsReportCovers: /function movementsReportCovers\(dateStr\) \{[\s\S]*?\n\}\n/,
  movementChronoBalance: /function movementChronoBalance\(m\) \{[\s\S]*?\n\}\n/,
  movementDocBalances: /function movementDocBalances\(m\) \{[\s\S]*?\n\}\n/,
  invoicePriceBasis: /function invoicePriceBasis\(inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineBasis: /function invoiceLineBasis\(line\) \{[\s\S]*?\n\}\n/,
  invoiceBasisTolerance: /function invoiceBasisTolerance\(lines\) \{[\s\S]*?\n\}\n/,
  invoiceLineCandidates: /function invoiceLineCandidates\(line\) \{[\s\S]*?\n\}\n/,
  INVOICE_BASIS_CONSTS: /const INVOICE_BASIS_SEARCH_BUDGET = [^\n]*\n[\s\S]*?const INVOICE_BASIS_PLAN_CACHE = [^\n]*\n/,
  invoiceLineBasisPlan: /function invoiceLineBasisPlan\(inv\) \{[\s\S]*?\n\}\n/,
  computeInvoiceLineBasisPlan: /function computeInvoiceLineBasisPlan\(lines, total\) \{[\s\S]*?\n\}\n/,
  invoiceLineInputUnit: /function invoiceLineInputUnit\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineTotalValue: /function invoiceLineTotalValue\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineValueText: /function invoiceLineValueText\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineFractionalUnit1: /function invoiceLineFractionalUnit1\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineQtyParts: /function invoiceLineQtyParts\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineQty: /function invoiceLineQty\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineUnitPrice: /function invoiceLineUnitPrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLinePrice: /function invoiceLinePrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  returnLedgerBalances: /function returnLedgerBalances\(inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
  applyReturnLedger: /function applyReturnLedger\(opts, inv, docPrev, docNew\) \{[\s\S]*?\n\}\n/,
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
  // المعالجان الحقيقيان كما يسجّلهما bindEvents.
  movementHandler: /app\.querySelectorAll\("\[data-action='gen-movement-doc'\]"\)\.forEach\(\(el\) => \{[\s\S]*?\n {2}\}\);\n/,
  invoiceHandler: /app\.querySelectorAll\("\[data-action='gen-invoice-doc'\]"\)\.forEach\(\(el\) => \{[\s\S]*?\n {2}\}\);\n/
};

const extracted = {};
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const found = appJs.match(pattern);
  if (!found) {
    failed += 1;
    results.push(`  ❌ استخراج ${name}\n     لم أجد التعريف في src/app.js`);
    continue;
  }
  extracted[name] = found[0];
}
const { movementHandler = "", invoiceHandler = "" } = extracted;
delete extracted.movementHandler;
delete extracted.invoiceHandler;

const escapeHtml = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ===== الشاهد: زبون واحد، يوم 2026-10-24 =====

const CUST_GUID = "00000000-0000-4000-8000-00000000c091";
const CUST = { name: "زبون الشاهد 1091", customerGuid: CUST_GUID, balance: 4445 };
const DAY = "2026-10-24";
const line = (material, qty, price) => ({ material, qty, unit1: "كروز", price, lineTotal: roundTo(qty * price), lineTotalSource: "ameen" });
function roundTo(x) { return Math.round(x * 1000) / 1000; }

const INV_1091 = { guid: "00000000-0000-4000-8000-000000001091", number: "1091", date: DAY, total: 806.6, discount: 0.4, payment: 0, isReturn: false,
  lines: [line("صنف أ", 2, 115), line("صنف ب", 1, 100), line("صنف ج", 1, 100), line("صنف د", 1, 38), line("صنف هـ", 1, 156.5), line("صنف و", 1, 49.6), line("صنف ز", 1, 132.5)] };
const INV_1092 = { guid: "00000000-0000-4000-8000-000000001092", number: "1092", date: DAY, total: 1060, discount: 0, payment: 0, isReturn: false,
  lines: [line("صنف ح", 1, 70), line("صنف أ", 6, 115), line("صنف ط", 1, 230), line("صنف ي", 1, 70)] };
const INV_1095_451 = { guid: "00000000-0000-4000-8000-000000001095", number: "1095", date: DAY, total: 451, discount: 0, payment: 0, isReturn: false,
  lines: [line("صنف أ", 1, 230), line("صنف ك", 1, 115), line("صنف ل", 1, 60), line("صنف ط", 0.2, 230)] };
const INV_1095_796 = { ...INV_1095_451, total: 796,
  lines: [line("صنف أ", 1, 230), line("صنف ك", 4, 115), line("صنف ل", 1, 60), line("صنف ط", 0.2, 230)] };

// أسطر الدفتر كما يرفعها push-customer-movements.ps1 (billGuid فارغ دائماً اليوم).
const mv = (o) => ({ date: DAY, debit: 0, credit: 0, notes: "", billGuid: "", ...o });
const LEDGER_COMMON = [
  mv({ date: "2026-10-22", credit: 1000, notes: "دفعة", docPrev: 3791.8, docNew: 2791.8, balance: 2791.8, balanceChrono: 2791.8, lineKind: "payment" }),
  mv({ debit: 806.6, docPrev: 2791.8, docNew: 3598, balance: 3598.4, balanceChrono: 3598.4, lineKind: "sale" }),
  mv({ debit: 1060, docPrev: 3598, docNew: 4658, balance: 4658.4, balanceChrono: 4658, lineKind: "sale" }),
  mv({ credit: 0.4, docPrev: 2791.8, docNew: 3598, balance: 5454, balanceChrono: 3598, lineKind: "discount" }),
  mv({ credit: 309, notes: "دفعة", docPrev: 4658, docNew: 4349, balance: 5145, balanceChrono: 4349, lineKind: "payment" }),
  mv({ credit: 700, notes: "دفعة", docPrev: 4349, docNew: 3649, balance: 4445, balanceChrono: 3649, lineKind: "payment" })
];
const MV_1095_451 = mv({ debit: 451, docPrev: 3649, docNew: 4100, balance: 4900.4, balanceChrono: 4100, lineKind: "sale" });
const MV_1095_796 = mv({ debit: 796, docPrev: 3649, docNew: 4445, balance: 5454.4, balanceChrono: 4445, lineKind: "sale" });

// ===== مُشغّل المعالجَين =====

function harness({ movements, invoices, account = CUST.balance }) {
  const notices = [];
  const exported = [];
  const handlers = {};
  const report = { summary: { fromDate: "2026-07-24", syncedAt: "2026-10-24T15:53:00Z" }, items: [{ name: CUST.name, customerGuid: CUST_GUID, movements }] };
  const invoicesReport = { items: [{ name: CUST.name, customerGuid: CUST_GUID, invoices }] };
  const item = { ...CUST, balance: account };
  const sandbox = {
    console, Intl,
    state: { customerMovementsReport: report, customerInvoicesReport: invoicesReport, customerBalanceReports: [{ summary: { syncedAt: "2026-10-24T15:53:30Z" } }] },
    escapeHtml,
    shortDateTime: () => "2026-10-24 18:53",
    docNumber: (prefix) => `${prefix}-20261024-0001`,
    todayIsoDate: () => DAY,
    setTimeout: (fn) => fn(),
    voucherExportBusy: false,
    app: { querySelectorAll: (sel) => [{ sel, dataset: {}, addEventListener(_t, fn) { handlers[sel] = { el: this, fn }; } }] },
    selectedCustomer: () => item,
    latestCustomerBalanceItems: () => [item],
    customerKey: () => "k-1091",
    customerProfile: () => ({ phone: "" }),
    customerCurrency: () => "$",
    customerBalance: (it) => Number(it?.balance),
    customerInvoicesFor: () => invoices,
    customerInvoicesEmptyText: () => "(تفاصيل الفواتير متأخرة عن الدفتر.)",
    invoiceByGuid: (guid) => {
      const g = String(guid || "").trim().toLowerCase();
      const invoice = g ? invoices.find((x) => x.guid === g) : null;
      return invoice ? { invoice, entry: invoicesReport.items[0] } : null;
    },
    smartNameMatch: (list, getName, name) => list.find((x) => getName(x) === name) || null,
    movementReturnLink: () => null,
    movementDocTypeFromButton: (kind) => (kind === "payment_out" ? "payment" : "invoice"),
    creditMovementKind: () => ({ kind: "receipt" }),
    exportMovementReceipt: () => { exported.push({ receipt: true }); },
    applyReturnLedgerForBill: () => {},
    showNoticeNow: (type, text) => { notices.push({ type, text }); },
    exportVoucherPdf: (opts) => { exported.push(opts); }
  };
  vm.createContext(sandbox);
  vm.runInContext(invoiceJs, sandbox);
  vm.runInContext(Object.values(extracted).join("\n"), sandbox);
  vm.runInContext(movementHandler + invoiceHandler, sandbox);
  const click = (sel, dataset) => {
    const h = handlers[sel];
    Object.keys(h.el.dataset).forEach((k) => delete h.el.dataset[k]);
    Object.assign(h.el.dataset, dataset);
    sandbox.voucherExportBusy = false;
    h.fn();
  };
  return {
    sandbox, notices, exported,
    // زر «📄 فاتورة PDF» على سطر الدفتر — نفس سمات data-* التي يرسمها customerDetailsPanel.
    clickMovement: (m) => click("[data-action='gen-movement-doc']", {
      debit: String(m.debit || 0), credit: "0", date: m.date, notes: m.notes || "",
      balance: String(m.balance), balanceChrono: String(m.balanceChrono),
      docNew: String(m.docNew), docPrev: String(m.docPrev), billGuid: m.billGuid || ""
    }),
    // زر «تصدير الفاتورة PDF» في قائمة فواتير الزبون.
    clickInvoice: (inv) => click("[data-action='gen-invoice-doc']", {
      invGuid: inv.guid, invNumber: inv.number, invDate: inv.date, customer: CUST.name
    })
  };
}

const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/‏/g, "").replace(/\s+/g, " ");
const ledgerRows = (html) => [...html.matchAll(/<tr><th[^>]*>([^<]*)<\/th><td([^>]*)>([\s\S]*?)<\/td><\/tr>/g)]
  .map((m) => [m[1], visible(m[3]).trim()]);
const pdf = (h, opts) => h.sandbox.voucherPdfMarkup(opts);
const onlyExport = (h) => {
  assert.equal(h.notices.length, 0, "رسالة غير متوقعة: " + (h.notices[0] && h.notices[0].text));
  assert.equal(h.exported.length, 1, "لم يُصدَّر مستند واحد بالضبط");
  return h.exported[0];
};
const onlyRefusal = (h, pattern) => {
  assert.equal(h.exported.length, 0, "صدر PDF رغم تعذّر الربط القاطع");
  assert.equal(h.notices.length, 1, "لا رسالة واضحة للمستخدم");
  assert.equal(h.notices[0].type, "error");
  if (pattern) assert.match(h.notices[0].text, pattern);
  assert.match(h.notices[0].text, /لم يُصدَّر أي PDF/);
};

// ===== 1) الحالة الفعلية: نافذة 15:51–15:55 =====

test("قيد 1095 (451) وتفاصيله لم تصل بعد: لا PDF، ورسالة صريحة — لا أصناف 1091 ولا تسوية 355.20", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_451], invoices: [INV_1091, INV_1092] });
  h.clickMovement(MV_1095_451);
  onlyRefusal(h, /لم أجد تفاصيل فاتورة بقيمة 451/);
});

test("1091 من سطر الدفتر: الرصيد السابق 2,791.80 والجديد 3,598.00، الحسم 0.40، بلا تسوية", () => {
  for (const ledger of [[...LEDGER_COMMON, MV_1095_451], [...LEDGER_COMMON, MV_1095_796]]) {
    for (const invoices of [[INV_1091, INV_1092], [INV_1091, INV_1092, INV_1095_451], [INV_1091, INV_1092, INV_1095_796]]) {
      const h = harness({ movements: ledger, invoices });
      h.clickMovement(LEDGER_COMMON[1]);
      const opts = onlyExport(h);
      assert.equal(opts.no, "1091");
      assert.equal(opts.prevBalance, 2791.8);
      assert.equal(opts.newBalance, 3598);
      assert.equal(opts.discount, 0.4);
      assert.ok(!("adjust" in opts), "تسوية مستنتجة على 1091");
      const html = pdf(h, opts);
      assert.deepEqual(ledgerRows(html).filter((r) => r[0] !== "التاريخ"), [
        ["الرصيد السابق", "2,791.80 $ (عليكم)"],
        ["قيمة هذه الفاتورة", "806.60 $"],
        ["الحسم", "− 0.40 $"],
        ["الرصيد الجديد", "3,598.00 $ (عليكم)"]
      ]);
      const text = visible(html);
      assert.ok(!/تسوية|355\.20|4,100|3,649/.test(text), "رقم أو سطر من قيد فاتورة أخرى ظهر على 1091");
    }
  }
});

test("1091 من قائمة الفواتير: نفس الأرقام، بلا تسوية", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_451], invoices: [INV_1091, INV_1092] });
  h.clickInvoice(INV_1091);
  const opts = onlyExport(h);
  assert.equal(opts.prevBalance, 2791.8);
  assert.equal(opts.newBalance, 3598);
  assert.equal(opts.discount, 0.4);
  assert.ok(!("adjust" in opts));
  assert.ok(!/تسوية/.test(visible(pdf(h, opts))));
});

test("1092 من المسارين: 3,598.00 ← 4,658.00 بلا حسم ولا تسوية", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_796], invoices: [INV_1091, INV_1092, INV_1095_796] });
  h.clickMovement(LEDGER_COMMON[2]);
  h.clickInvoice(INV_1092);
  assert.equal(h.notices.length, 0);
  assert.equal(h.exported.length, 2);
  for (const opts of h.exported) {
    assert.equal(opts.no, "1092");
    assert.equal(opts.prevBalance, 3598);
    assert.equal(opts.newBalance, 4658);
    assert.ok(!("adjust" in opts) && !("discount" in opts) && !("payment" in opts));
  }
});

// ===== 2) تعديل 1095 من 451 إلى 796 =====

test("1095 بنسخة 451 بعد وصول تفاصيلها (15:55–16:01): أصنافها هي، 3,649 ← 4,100", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_451], invoices: [INV_1091, INV_1092, INV_1095_451] });
  h.clickMovement(MV_1095_451);
  const opts = onlyExport(h);
  assert.equal(opts.no, "1095");
  assert.equal(opts.amount, 451);
  assert.equal(opts.prevBalance, 3649);
  assert.equal(opts.newBalance, 4100);
  assert.ok(!("adjust" in opts));
});

test("1095 بعد التعديل إلى 796 والتقريران متزامنان: 3,649 ← 4,445 في المسارين", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_796], invoices: [INV_1091, INV_1092, INV_1095_796] });
  h.clickMovement(MV_1095_796);
  h.clickInvoice(INV_1095_796);
  assert.equal(h.notices.length, 0);
  assert.equal(h.exported.length, 2);
  for (const opts of h.exported) {
    assert.equal(opts.no, "1095");
    assert.equal(opts.amount, 796);
    assert.equal(opts.prevBalance, 3649);
    assert.equal(opts.newBalance, 4445);
    assert.ok(!("adjust" in opts));
  }
});

test("التفاصيل عُدّلت إلى 796 والدفتر ما زال على 451: سطر الدفتر يُرفض، والقائمة بلا رصيد قيد", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_451], invoices: [INV_1091, INV_1092, INV_1095_796] });
  h.clickMovement(MV_1095_451);
  onlyRefusal(h, /451/);
  const h2 = harness({ movements: [...LEDGER_COMMON, MV_1095_451], invoices: [INV_1091, INV_1092, INV_1095_796] });
  h2.clickInvoice(INV_1095_796);
  const opts = onlyExport(h2);
  assert.ok(!("prevBalance" in opts) && !("newBalance" in opts) && !("adjust" in opts), "رصيدا قيد 451 طُبعا على فاتورة 796");
  assert.ok(!/4,100|3,649/.test(visible(pdf(h2, opts))));
});

test("الدفتر صار 796 والتفاصيل ما زالت 451: لا ربط بقيد لا يساوي قيمتها", () => {
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_796], invoices: [INV_1091, INV_1092, INV_1095_451] });
  h.clickMovement(MV_1095_796);
  onlyRefusal(h, /796/);
  const h2 = harness({ movements: [...LEDGER_COMMON, MV_1095_796], invoices: [INV_1091, INV_1092, INV_1095_451] });
  h2.clickInvoice(INV_1095_451);
  const opts = onlyExport(h2);
  assert.ok(!("prevBalance" in opts) && !("newBalance" in opts));
});

test("المعرّف يربط القيد بالفاتورة لكن المبلغين مختلفان (تعديل لم يكتمل): لا PDF", () => {
  const linked = { ...MV_1095_451, billGuid: INV_1095_451.guid };
  const h = harness({ movements: [...LEDGER_COMMON, linked], invoices: [INV_1091, INV_1092, INV_1095_796] });
  h.clickMovement(linked);
  onlyRefusal(h, /عُدّلت ولم تكتمل المزامنة/);
});

// ===== 3) التباس التاريخ والمبلغ =====

test("فاتورتان بنفس اليوم ونفس المبلغ بلا معرّف: لا ربط بترتيب النتائج في المسارين", () => {
  const twinA = { ...INV_1092, guid: "00000000-0000-4000-8000-00000000a001", number: "2001", total: 230, lines: [line("صنف ط", 1, 230)] };
  const twinB = { ...twinA, guid: "00000000-0000-4000-8000-00000000a002", number: "2002" };
  const mA = mv({ debit: 230, docPrev: 3649, docNew: 3879, balance: 1, balanceChrono: 3879, lineKind: "sale" });
  const mB = mv({ debit: 230, docPrev: 3879, docNew: 4109, balance: 2, balanceChrono: 4109, lineKind: "sale" });
  const h = harness({ movements: [...LEDGER_COMMON, mA, mB], invoices: [INV_1091, INV_1092, twinA, twinB] });
  h.clickMovement(mB);
  onlyRefusal(h, /أكثر من فاتورة أو قيد/);
  const h2 = harness({ movements: [...LEDGER_COMMON, mA, mB], invoices: [INV_1091, INV_1092, twinA, twinB] });
  h2.clickInvoice(twinA);
  onlyRefusal(h2, /أكثر من فاتورة أو قيد/);
});

test("فاتورة واحدة وقيدان بنفس اليوم والمبلغ (الثاني بلا تفاصيل): لا ربط", () => {
  const one = { ...INV_1092, guid: "00000000-0000-4000-8000-00000000a003", number: "2003", total: 230, lines: [line("صنف ط", 1, 230)] };
  const mA = mv({ debit: 230, docPrev: 3649, docNew: 3879, balance: 1, balanceChrono: 3879, lineKind: "sale" });
  const mB = mv({ debit: 230, docPrev: 3879, docNew: 4109, balance: 2, balanceChrono: 4109, lineKind: "sale" });
  const h = harness({ movements: [...LEDGER_COMMON, mA, mB], invoices: [INV_1091, INV_1092, one] });
  h.clickMovement(mA);
  onlyRefusal(h);
});

test("فاتورة بنفس المبلغ بتاريخ آخر لا تُلصق بقيد هذا اليوم", () => {
  const otherDay = { ...INV_1095_451, guid: "00000000-0000-4000-8000-00000000a004", number: "1080", date: "2026-10-20" };
  const h = harness({ movements: [...LEDGER_COMMON, MV_1095_451], invoices: [INV_1091, INV_1092, otherDay] });
  h.clickMovement(MV_1095_451);
  onlyRefusal(h, /لم أجد تفاصيل/);
});

// ===== 4) الحسومات والدفعات الحقيقية تبقى سليمة =====

test("فاتورة بدفعة أولى وسطر فروقات صندوق حقيقي في قيدها: الدفعة سطر، والفرق مثبت يُطبع", () => {
  // شكل الفاتورة 707 الحقيقي: 341.51، دفعة أولى 230، وسطر 20.491 مدين في القيد نفسه.
  const inv = { guid: "00000000-0000-4000-8000-000000000707", number: "707", date: DAY, total: 341.51, discount: 0, payment: 230, isReturn: false, lines: [line("صنف م", 1, 341.51)] };
  const sale = mv({ debit: 341.51, docPrev: 0, docNew: 132.001, balance: 341.51, balanceChrono: 341.51, lineKind: "sale" });
  const pay = mv({ credit: 230, docPrev: 0, docNew: 132.001, balance: 132.001, balanceChrono: 132.001, lineKind: "sale_payment" });
  const adj = mv({ debit: 20.491, docPrev: 0, docNew: 132.001, balance: 152.492, balanceChrono: 362.001, lineKind: "adjustment" });
  for (const click of ["clickMovement", "clickInvoice"]) {
    const h = harness({ movements: [sale, adj, pay], invoices: [inv] });
    h[click](click === "clickMovement" ? sale : inv);
    const opts = onlyExport(h);
    assert.equal(opts.payment, 230);
    assert.equal(opts.adjust, -20.491);
    const rows = ledgerRows(pdf(h, opts)).map((r) => r[0]);
    assert.ok(rows.includes("دفعة من الزبون") && rows.includes("إضافة / تسوية"), rows.join("|"));
  }
});

test("فاتورة بحسم ودفعة يُغلقان القيد: سطران منفصلان، بلا تسوية", () => {
  const inv = { guid: "00000000-0000-4000-8000-000000000561", number: "561", date: DAY, total: 17698.5, discount: 0.5, payment: 16626, isReturn: false, lines: [line("صنف ن", 1, 17698.5)] };
  const sale = mv({ debit: 17698.5, docPrev: 0, docNew: 1072, balance: 1, balanceChrono: 17698.5, lineKind: "sale" });
  const disc = mv({ credit: 0.5, docPrev: 0, docNew: 1072, balance: 2, balanceChrono: 17698, lineKind: "discount" });
  const pay = mv({ credit: 16626, docPrev: 0, docNew: 1072, balance: 3, balanceChrono: 1072, lineKind: "sale_payment" });
  for (const click of ["clickMovement", "clickInvoice"]) {
    const h = harness({ movements: [sale, disc, pay], invoices: [inv] });
    h[click](click === "clickMovement" ? sale : inv);
    const opts = onlyExport(h);
    assert.equal(opts.discount, 0.5);
    assert.equal(opts.payment, 16626);
    assert.ok(!("adjust" in opts));
    const text = visible(pdf(h, opts));
    assert.ok(text.includes("الحسم") && text.includes("دفعة من الزبون") && !text.includes("تسوية"));
  }
});

test("حسم مصنَّف «unknown» في الدفتر يُغلق المعادلة: يُصدَّر بلا تسوية (شاهد 2620)", () => {
  const inv = { guid: "00000000-0000-4000-8000-000000002620", number: "2620", date: DAY, total: 203.116, discount: 0.012, payment: 0, isReturn: false, lines: [line("صنف س", 1, 203.116)] };
  const sale = mv({ debit: 203.116, docPrev: 850.224, docNew: 1053.329, balance: 1, balanceChrono: 1053.34, lineKind: "sale" });
  const disc = mv({ credit: 0.012, docPrev: 850.224, docNew: 1053.329, balance: 2, balanceChrono: 1053.329, lineKind: "unknown" });
  const h = harness({ movements: [sale, disc], invoices: [inv] });
  h.clickMovement(sale);
  const opts = onlyExport(h);
  assert.ok(!("adjust" in opts));
});

test("تدوير TotalExtra على رأس الفاتورة: يُطبع «تدوير» ويُغلق القيد، لا يُرفض ولا يُسمّى تسوية", () => {
  // شاهد #402: 3000.98 + 0.02 = 3001. سطر التدوير مقابل 43 يُوسم discount إن كان
  // دائناً على الزبون، أو adjustment إن كان مديناً — في الحالين ليس تسوية.
  const inv = { guid: "00000000-0000-4000-8000-000000000043", number: "43", date: DAY, total: 3000.98, discount: 0, extra: 0.02, payment: 1000, isReturn: false, lines: [line("صنف ف", 1, 3000.98)] };
  const sale = mv({ debit: 3000.98, docPrev: 0, docNew: 2001, balance: 3000.98, balanceChrono: 3000.98, lineKind: "sale" });
  const extraLine = mv({ debit: 0.02, docPrev: 0, docNew: 2001, balance: 3001, balanceChrono: 3001, lineKind: "discount" });
  const pay = mv({ credit: 1000, docPrev: 0, docNew: 2001, balance: 2001, balanceChrono: 2001, lineKind: "sale_payment" });
  for (const click of ["clickMovement", "clickInvoice"]) {
    const h = harness({ movements: [sale, extraLine, pay], invoices: [inv] });
    h[click](click === "clickMovement" ? sale : inv);
    const opts = onlyExport(h);
    assert.equal(opts.extra, 0.02);
    assert.equal(opts.payment, 1000);
    assert.ok(!("adjust" in opts), "التدوير طُبع تسوية");
    const rows = ledgerRows(pdf(h, opts)).map((r) => r[0]);
    assert.ok(rows.includes("تدوير"), rows.join("|"));
    assert.ok(!rows.includes("إضافة / تسوية") && !rows.includes("تسوية على الحساب"), rows.join("|"));
  }
});

test("تدوير 20.49 بلا سطر دفتر مستقل: المعادلة تُغلق من رأس الفاتورة ولا تُرفض", () => {
  const inv = { guid: "00000000-0000-4000-8000-000000000707", number: "707b", date: DAY, total: 341.51, discount: 0, extra: 20.491, payment: 230, isReturn: false, lines: [line("صنف م", 1, 341.51)] };
  const sale = mv({ debit: 341.51, docPrev: 0, docNew: 132.001, balance: 341.51, balanceChrono: 341.51, lineKind: "sale" });
  const pay = mv({ credit: 230, docPrev: 0, docNew: 132.001, balance: 132.001, balanceChrono: 132.001, lineKind: "sale_payment" });
  const h = harness({ movements: [sale, pay], invoices: [inv] });
  h.clickInvoice(inv);
  const opts = onlyExport(h);
  assert.equal(opts.extra, 20.491);
  assert.ok(!("adjust" in opts));
  assert.ok(ledgerRows(pdf(h, opts)).some((r) => r[0] === "تدوير"));
});

test("فرق أرصدة لا يثبته أي سطر في قيد الفاتورة: لا PDF ولا «تسوية»", () => {
  const broken = { ...LEDGER_COMMON[1], docNew: 3242.8 };   // 355.20 بلا أي سطر يفسّره
  const disc = { ...LEDGER_COMMON[3], docNew: 3242.8 };
  for (const click of ["clickMovement", "clickInvoice"]) {
    const h = harness({ movements: [LEDGER_COMMON[0], broken, disc], invoices: [INV_1091] });
    h[click](click === "clickMovement" ? broken : INV_1091);
    onlyRefusal(h, /لا تُغلق/);
  }
});

test("فاتورة على صندوق (لا قيد على ذمة الزبون): رصيد الحساب مستقلاً، بلا سابق/جديد", () => {
  const cash = { guid: "00000000-0000-4000-8000-000000002046", number: "2046", date: DAY, total: 129.673, discount: 0, payment: 0, isReturn: false, lines: [line("صنف ع", 1, 129.673)] };
  const h = harness({ movements: LEDGER_COMMON, invoices: [INV_1091, INV_1092, cash] });
  h.clickInvoice(cash);
  const opts = onlyExport(h);
  assert.ok(!("prevBalance" in opts) && !("adjust" in opts));
  assert.equal(opts.accountBalance, 4445);
});

// ===== 5) لا سقوط إلى التاريخ وحده أو المبلغ وحده في المصدر =====

test("المعالجان لا يحويان مطابقة بالتاريخ وحده أو بالمبلغ وحده أو بترتيب النتائج", () => {
  for (const [name, src] of [["gen-movement-doc", movementHandler], ["gen-invoice-doc", invoiceHandler]]) {
    assert.ok(src, `${name} غير مستخرج`);
    assert.ok(!/invs\.find\(\(x\) => dateMatch\(x\)\)/.test(src), `${name}: سقوط إلى التاريخ وحده`);
    assert.ok(!/invs\.find\(\(x\) => amtMatch\(x\)\)/.test(src), `${name}: سقوط إلى المبلغ وحده`);
    assert.match(src, /bindSaleInvoiceLedger\(/, `${name}: لا يمرّ بالربط القاطع`);
    assert.match(src, /invoiceEntryProvesResidual\(/, `${name}: الفرق يُطبع بلا إثبات`);
  }
  assert.ok(!/function invoiceMovement\(/.test(appJs), "invoiceMovement القديمة (أول تطابق تاريخ/مبلغ) ما زالت موجودة");
  // opts.adjust لا يُضبط إلا بعد إثبات أسطر القيد.
  const sites = appJs.match(/opts\.adjust = [^;]+;/g) || [];
  assert.equal(sites.length, 2, `مواضع ضبط adjust: ${sites.length}`);
});

// ===== النتيجة =====

console.log("\n🔗 ربط فاتورة PDF بقيدها (1091 / 1092 / 1095)\n");
console.log(results.join("\n"));
if (failed > 0) {
  console.log(`\n❌ فشل ${failed} فحصاً\n`);
  process.exit(1);
}
console.log(`\n✅ ${results.length} فحصاً ناجحاً\n`);
