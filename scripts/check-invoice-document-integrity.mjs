// فحص سلوكي لمستند الفاتورة: اسم الملف المقترح + الفصل المحاسبي بين الحسم
// ودفعة الزبون. يُنفَّذ الكود الحقيقي من `src/app.js` داخل vm — لا مطابقة نصية
// ولا نسخة مبسّطة منه.
//
// العطلان المُثبتان بتاريخ 2026-08-31:
//   1) اسم ملف PDF من كروم يحمل الرقم بلا اسم الزبون. السبب: كروم يشتقّ الاسم
//      من `<title>` المستند المطبوع، وكانت العناوين «فاتورة مبيعات 562» فقط،
//      و`options.title` كان يُستعمل لسمة الإطار لا للمستند.
//   2) دفعة الزبون تُطبع في خانة «حسم». السبب الجذري في طبقة البيانات:
//      `adjust = السابق + الفاتورة − الجديد` فرقٌ يبتلع أي دفعة على نفس السند،
//      وكان يُطبع بعنوان «حسم» بلا شرط.

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

// ===== استخراج الدوال الحقيقية وتشغيلها =====

const PATTERNS = {
  DOC_TYPE_LABELS: /const DOC_TYPE_LABELS = \{[\s\S]*?\n\};/,
  DOC_TITLE_REGEXES: /const DOC_TITLE_INVISIBLE = [^\n]*\nconst DOC_TITLE_DIACRITICS = [^\n]*\n/,
  sanitizeDocumentTitle: /function sanitizeDocumentTitle\(value, max = 80\) \{[\s\S]*?\n\}\n/,
  fileDateLabel: /function fileDateLabel\(isoDate\) \{[\s\S]*?\n\}\n/,
  NUMBERLESS_FILE_DOC_TYPES: /const NUMBERLESS_FILE_DOC_TYPES = [^\n]*\n/,
  // صفة البيع والسجل التجاري: يستخدمهما voucherPdfMarkup، ويجب أن يُستخرجا من
  // المصدر لا أن يُثبَّتا في الصندوق — كي يفشل الاختبار إن تغيّر النص في app.js.
  SALES_TRADE_CONSTS: /const SALES_TRADE_REGISTER_NO = [^\n]*\nconst SALES_TRADE_CAPACITY = [^\n]*\n/,
  archiveDocumentTitle: /function archiveDocumentTitle\(docType, meta\) \{[\s\S]*?\n\}\n/,
  withDocumentTitle: /function withDocumentTitle\(html, title\) \{[\s\S]*?\n\}\n/,
  salesTotals: /function salesTotals\(\) \{[\s\S]*?\n\}\n/,
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  formatInvoiceMoney: /function formatInvoiceMoney\(value\) \{[\s\S]*?\n\}\n/,
  // أسطر الدفتر خرجت من voucherPdfMarkup إلى دالة واحدة يستدعيها مسارا العرض
  // (السندات القديمة وقالب الفاتورة الرئيسي) — فيجب استخراجها معه.
  voucherLedgerRows: /function voucherLedgerRows\(v\) \{[\s\S]*?\n\}\n/,
  voucherInvoiceBalanceRows: /function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
  pushInvoiceRoundingDrift: /function pushInvoiceRoundingDrift\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
  voucherSingleBalanceRows: /function voucherSingleBalanceRows\(rows, v, cur, balCur, isInv, isRet, balLabel\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRowHtml: /function voucherLedgerRowHtml\(row\) \{[\s\S]*?\n\}\n/,
  saleInvoiceDocument: /function saleInvoiceDocument\(v\) \{[\s\S]*?\n\}\n/,
  voucherPdfMarkup: /function voucherPdfMarkup\(v\) \{[\s\S]*?\n\}\n/,
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
  invoiceLinePrice: /function invoiceLinePrice\(line, inv\) \{[\s\S]*?\n\}\n/
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

// شوائب DOM/تنسيق يحتاجها الكود المستخرَج، بأبسط صورة صادقة.
const sandbox = {
  console,
  state: {},
  escapeHtml: (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  toNumber: (value) => {
    const n = Number(String(value == null ? "" : value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  },
  balanceText: (bal, cur) => `${Math.abs(Number(bal || 0)).toFixed(2)} ${cur}`,
  REPORT_STYLE: "",
  appConfig: { name: "OZK", supportEmail: "x@y.z" },
  todayIsoDate: () => "2026-08-31"
};
vm.createContext(sandbox);
// قالب الفاتورة الرئيسي وحدة عامة مستقلة؛ نحمّلها أولاً كي يمرّ مستند الفاتورة
// بالمسار الإنتاجي نفسه لا بمسار احتياطي.
vm.runInContext(
  readFileSync(new URL("../src/documents/invoice/ozk-invoice.js", import.meta.url), "utf8"),
  sandbox
);
vm.runInContext(source.join("\n"), sandbox);
const {
  sanitizeDocumentTitle, fileDateLabel, archiveDocumentTitle, withDocumentTitle,
  salesTotals, voucherPdfMarkup, invoiceLineTotalValue, invoiceLineQty, invoiceLinePrice,
  invoicePriceBasis, invoiceLineUnitPrice, invoiceLineBasis, invoiceLineBasisPlan
} = sandbox;

// ===== 1) اسم الملف: الزبون + الرقم =====

test("normal invoice filename includes customer + invoice number", () => {
  const meta = { party: "حسن عباس", number: "562", date: "2026-08-31" };
  const title = archiveDocumentTitle("invoice", meta);
  assert.equal(title, "فاتورة - حسن عباس - رقم 562 - 2026-08-31");
  assert.ok(title.includes("حسن عباس"), "اسم الزبون مفقود");
  assert.ok(title.includes("562"), "رقم الفاتورة مفقود");
});

test("return invoice filename includes customer + invoice number", () => {
  const title = archiveDocumentTitle("return_invoice", { party: "سامر", number: "44", date: "2026-08-31" });
  assert.equal(title, "فاتورة مرتجع - سامر - رقم 44 - 2026-08-31");
  assert.ok(title.startsWith("فاتورة مرتجع"), "المرتجع يجب أن يبقى مستقلاً عن الفاتورة العادية");
});

test("بلا تاريخ موثوق: الاسم يبقى صحيحاً بلا حشو", () => {
  assert.equal(archiveDocumentTitle("invoice", { party: "حسن عباس", number: "562" }),
    "فاتورة - حسن عباس - رقم 562");
  assert.equal(fileDateLabel("غير صالح"), "");
  assert.equal(fileDateLabel("2026-08-31"), "2026-08-31");
  assert.equal(fileDateLabel("2026-8-31"), "", "صيغة غير ISO لا تُقبل");
});

test("Arabic customer names preserved", () => {
  for (const name of ["حسن عباس", "مركز أبو زياد", "شريفة أسعد شريفة", "مؤسسة الشام"]) {
    const title = archiveDocumentTitle("invoice", { party: name, number: "1", date: "2026-08-31" });
    assert.ok(title.includes(name), `الاسم العربي تشوّه: ${title}`);
  }
  // لا تحويل إلى شرطات سفلية ولا حذف للفراغات كما كان يفعل اسم الملف القديم.
  assert.ok(!archiveDocumentTitle("invoice", { party: "حسن عباس", number: "1" }).includes("_"));
});

test("invalid filename characters sanitized", () => {
  const dirty = 'حسن/عباس\\:*?"<>|';
  const cleaned = sanitizeDocumentTitle(dirty);
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!cleaned.includes(ch), `بقي محرف ممنوع: ${ch}`);
  }
  assert.ok(cleaned.includes("حسن") && cleaned.includes("عباس"), `ضاع الاسم: ${cleaned}`);
  assert.equal(sanitizeDocumentTitle("../../etc/passwd"), "etc passwd");
  assert.equal(sanitizeDocumentTitle("...بادئة"), "بادئة");
  // محارف الاتجاه غير المرئية تُحذف ولا تُبقي فراغات مزدوجة.
  assert.equal(sanitizeDocumentTitle("حسن\u200F  عباس"), "حسن عباس");
});

test("عنوان المستند يُفرض فعلياً داخل HTML المطبوع (وهو ما يقرأه كروم)", () => {
  const doc = "<!doctype html><html><head><meta charset=\"utf-8\"><title>فاتورة مبيعات 562</title></head><body>x</body></html>";
  const out = withDocumentTitle(doc, "فاتورة - حسن عباس - رقم 562 - 2026-08-31");
  assert.ok(out.includes("<title>فاتورة - حسن عباس - رقم 562 - 2026-08-31</title>"));
  assert.ok(!out.includes("<title>فاتورة مبيعات 562</title>"), "العنوان القديم لم يُستبدل");
  // مستند بلا <title>: يُحقن داخل <head>.
  const bare = "<!doctype html><html><head></head><body>y</body></html>";
  assert.ok(withDocumentTitle(bare, "فاتورة - سامر - رقم 9").includes("<title>فاتورة - سامر - رقم 9</title>"));
  // عنوان فارغ لا يفسد المستند.
  assert.equal(withDocumentTitle(doc, ""), doc);
});

test("exported filename metadata === archive metadata", () => {
  // نفس الكائن يغذّي اسم ملف كروم واسم النسخة المؤرشفة: مصدر واحد لا مصدران.
  assert.match(appJs, /const salesArchiveMeta = \{ party: customer, number: invNo, date: todayIsoDate\(\) \};/);
  assert.match(appJs, /title: archiveDocumentTitle\("invoice", salesArchiveMeta\)/);
  assert.match(appJs, /archive: invNo === SALES_DRAFT_INVOICE_NO \? null : \{[\s\S]*?meta: salesArchiveMeta/);

  assert.match(appJs, /const purchaseArchiveMeta = \{ party: po\.supplierName, number: po\.publicId, date: todayIsoDate\(\) \};/);
  assert.match(appJs, /title: archiveDocumentTitle\("purchase_invoice", purchaseArchiveMeta\)/);
  assert.match(appJs, /archive: \{ docType: "purchase_invoice", meta: purchaseArchiveMeta \}/);

  // مسار الفاتورة اليدوية (printInvoice/manualArchiveMeta) حُذف من main في
  // cb4fa65: كان route غير مسجَّل في خريطة pages فيكسر render() صامتاً، ومعه
  // حارس check-keyboard-shortcut-routes.mjs يمنع عودته. أرشفته كانت على كود
  // لا يُستدعى أبداً، فسقط التوقّع معه — ولا يجوز إعادته لمجرد إبقاء الفحص.
  assert.ok(!/function printInvoice\(/.test(appJs), "عاد مسار الفاتورة الميت الذي حذفه main");
  assert.ok(!/manualArchiveMeta/.test(appJs), "بقي أثر من مسار الفاتورة الميت");

  // ملف التنزيل المباشر لفاتورة المبيعات يستعمل نفس الكائن أيضاً.
  assert.match(appJs, /const fileName = documentFileName\("invoice", pdfArchiveMeta\);/);
  assert.match(appJs, /archiveToICloud\("invoice", blob, pdfArchiveMeta\);/);

  // العنوان يصل فعلاً إلى المستند المطبوع لا إلى سمة الإطار وحدها.
  assert.match(appJs, /frame\.srcdoc = withDocumentTitle\(html, options\.title\);/);
});

// ===== 2) الفصل المحاسبي: الحسم ≠ دفعة الزبون =====

const invoiceDoc = (extra) => voucherPdfMarkup({
  type: "invoice", name: "حسن عباس", no: "562", date: "2026-08-31",
  cur: "$", amount: 200, prevBalance: 0, newBalance: 149.5, ...extra
});

test("payment does not populate discount", () => {
  const html = invoiceDoc({ payment: 50, newBalance: 150 });
  assert.ok(html.includes("دفعة من الزبون"), "سطر الدفعة مفقود");
  assert.ok(!html.includes("<th>الحسم</th>"), "الدفعة ظهرت في خانة الحسم");
});

test("discount does not populate payment", () => {
  const html = invoiceDoc({ discount: 0.5, newBalance: 199.5 });
  assert.ok(html.includes("<th>الحسم</th>"), "سطر الحسم مفقود");
  assert.ok(!html.includes("دفعة من الزبون"), "الحسم ظهر في خانة الدفعة");
});

test("invoice with both values prints two separate rows", () => {
  // مثال المالك حرفياً: فاتورة 200، حسم 0.50، دفعة 50.
  const html = invoiceDoc({ discount: 0.5, payment: 50, newBalance: 149.5 });
  assert.ok(html.includes("<th>الحسم</th>"), "سطر الحسم مفقود");
  assert.ok(html.includes("<th>دفعة من الزبون</th>"), "سطر الدفعة مفقود");
  assert.ok(/0\.5/.test(html), "قيمة الحسم 0.5 غير مطبوعة");
  assert.ok(/\b50\b/.test(html), "قيمة الدفعة 50 غير مطبوعة");
  // ولا يجوز أن يُطبع 50 في سطر الحسم.
  // خلايا القيم صارت معزولة بـ<bdi> منعاً لانقلاب الاتجاه؛ القيم نفسها لم تتغيّر.
  const discountRow = html.match(/<th>الحسم<\/th><td[^>]*>(?:<bdi>)?[^<]*/)[0];
  assert.ok(discountRow.includes("0.5"), `سطر الحسم يحمل قيمة خاطئة: ${discountRow}`);
  assert.ok(!discountRow.includes("50.00"), "الدفعة طُبعت داخل سطر الحسم");
});

test("invoice with payment only shows payment row", () => {
  const html = invoiceDoc({ payment: 50, newBalance: 150 });
  assert.equal((html.match(/<th>دفعة من الزبون<\/th>/g) || []).length, 1);
  assert.equal((html.match(/<th>الحسم<\/th>/g) || []).length, 0);
});

test("invoice with discount only shows discount row", () => {
  const html = invoiceDoc({ discount: 0.5, newBalance: 199.5 });
  assert.equal((html.match(/<th>الحسم<\/th>/g) || []).length, 1);
  assert.equal((html.match(/<th>دفعة من الزبون<\/th>/g) || []).length, 0);
});

test("لا حسم ولا دفعة: لا يظهر أي من السطرين", () => {
  const html = invoiceDoc({ newBalance: 200 });
  assert.ok(!html.includes("<th>الحسم</th>"));
  assert.ok(!html.includes("<th>دفعة من الزبون</th>"));
});

test("الفرق غير المنسوب لا يُسمّى حسماً أبداً", () => {
  // فجوة بيانات الأمين: الفرق قد يكون دفعة. تسميته «حسم» خطأ محاسبي.
  const html = invoiceDoc({ adjust: 50, newBalance: 150 });
  assert.ok(html.includes("تسوية على الحساب"), "الفرق غير المنسوب بلا تسمية صحيحة");
  assert.ok(!html.includes("<th>الحسم</th>"), "الفرق غير المنسوب طُبع بعنوان «حسم»");
  // أسطر الرصيد صارت في voucherInvoiceBalanceRows، فالتدقيق النصّي يلاحقها إلى
  // موضعها الجديد بدل أن يفحص دالةً لم تعد تحوي الأسطر أصلاً (ففحصها يصبح بلا
  // معنى، ويمرّ فراغاً). الكتلة المستخرَجة تُلتقط أولاً ويُتحقَّق من وجودها.
  const balanceRowsSrc = appJs.match(/function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\)[\s\S]*?\n\}\n/);
  assert.ok(balanceRowsSrc, "تعذّر العثور على voucherInvoiceBalanceRows — التدقيق النصّي فقد هدفه");
  assert.ok(/label: "الحسم"/.test(balanceRowsSrc[0]), "سطر الحسم الحقيقي غادر الكتلة — التدقيق يفحص موضعاً خاطئاً");
  assert.ok(!/label: "حسم"/.test(balanceRowsSrc[0]),
    "بقيت التسمية القديمة «حسم» للفرق غير المنسوب في الكود");
});

test("balance calculation subtracts both independently", () => {
  // مسار فاتورة المبيعات من الموقع: المصدر يفصل الحقلين أصلاً.
  sandbox.state.salesRows = [{ key: "a", qty: 2, price: 100 }];
  sandbox.state.salesDiscount = 0.5;
  sandbox.state.salesPayMethod = "credit";
  sandbox.state.salesPaid = 50;
  const totals = salesTotals();
  assert.equal(totals.grand, 200, "قيمة الفاتورة");
  assert.equal(totals.discount, 0.5, "الحسم يجب أن يكون الحسم وحده");
  assert.equal(totals.paid, 50, "الدفعة يجب أن تكون الدفعة وحدها");
  assert.equal(totals.net, 199.5, "الصافي = القيمة − الحسم");
  // الرصيد الجديد = السابق + الفاتورة − الحسم − الدفعة
  assert.equal(Math.round((0 + totals.grand - totals.discount - totals.paid) * 100) / 100, 149.5);
  assert.equal(Math.round(totals.remaining * 100) / 100, 149.5);
});

test("الحسم لا يبتلع الدفعة عند حساب الفرق غير المنسوب", () => {
  // الفرق يُحسب بعد طرح الحسم والدفعة المعروفَين، فلا يعود يبتلعهما.
  assert.match(appJs, /opts\.prevBalance \+ total - knownDiscount - knownPayment - opts\.newBalance/);
  assert.match(appJs, /if \(knownDiscount > 0\.009\) opts\.discount = knownDiscount;/);
  assert.match(appJs, /if \(knownPayment > 0\.009\) opts\.payment = knownPayment;/);
});

// ===== 3) الفصل المحاسبي من مصدر الأمين (A) =====

// أرقام حقيقية مقروءة من AmnDb002 بتاريخ 2026-08-31 (READ ONLY).
const AMEEN_562 = { number: "562", total: 2751.5, discount: 0, payment: 2000 };
const AMEEN_561 = { number: "561", total: 17698.5, discount: 0.5, payment: 16626 };

test("invoice 562: discount = 0 و payment = 2000", () => {
  assert.equal(AMEEN_562.discount, 0);
  assert.equal(AMEEN_562.payment, 2000);
  const html = voucherPdfMarkup({
    type: "invoice", name: "زبون 562", no: "562", date: "2026-08-31", cur: "$",
    amount: AMEEN_562.total, prevBalance: 0,
    discount: AMEEN_562.discount, payment: AMEEN_562.payment,
    newBalance: AMEEN_562.total - AMEEN_562.discount - AMEEN_562.payment
  });
  assert.ok(html.includes("<th>دفعة من الزبون</th>"), "الدفعة 2000 يجب أن تظهر كدفعة");
  assert.ok(!html.includes("<th>الحسم</th>"), "الحسم صفر فلا يظهر سطره");
  assert.ok(!html.includes("تسوية على الحساب"), "لا فرق غير مفسر");
});

test("invoice 561: discount = 0.500 و payment = 16626", () => {
  assert.equal(AMEEN_561.discount, 0.5);
  assert.equal(AMEEN_561.payment, 16626);
  const html = voucherPdfMarkup({
    type: "invoice", name: "زبون 561", no: "561", date: "2026-08-31", cur: "$",
    amount: AMEEN_561.total, prevBalance: 0,
    discount: AMEEN_561.discount, payment: AMEEN_561.payment,
    newBalance: AMEEN_561.total - AMEEN_561.discount - AMEEN_561.payment
  });
  assert.ok(html.includes("<th>الحسم</th>"), "سطر الحسم مفقود");
  assert.ok(html.includes("<th>دفعة من الزبون</th>"), "سطر الدفعة مفقود");
  const discountRow = html.match(/<th>الحسم<\/th><td[^>]*>(?:<bdi>)?[^<]*/)[0];
  assert.ok(discountRow.includes("0.5"), `سطر الحسم: ${discountRow}`);
  assert.ok(!/16,?626/.test(discountRow), "الدفعة دخلت سطر الحسم");
});

test("TotalDisc لا يُعامل كنسبة", () => {
  // 0.500 على فاتورة 17698.5: كقيمة = 0.50، وكنسبة = 88.49 — الفرق فاضح.
  const asPercent = AMEEN_561.total * AMEEN_561.discount / 100;
  assert.ok(Math.abs(asPercent - AMEEN_561.discount) > 80, "الاختبار نفسه غير مميِّز");
  const html = voucherPdfMarkup({
    type: "invoice", name: "س", no: "561", date: "2026-08-31", cur: "$",
    amount: AMEEN_561.total, prevBalance: 0, discount: AMEEN_561.discount,
    newBalance: AMEEN_561.total - AMEEN_561.discount
  });
  assert.ok(html.includes("0.5"), "الحسم لم يُطبع كقيمة");
  assert.ok(!html.includes("88.49"), "الحسم عومل كنسبة");
  // والسكربت لا يضرب الحسم بالإجمالي في أي موضع.
  const ps1 = readFileSync(new URL("../tools/push-customer-invoices.ps1", import.meta.url), "utf8");
  // نُسقط التعليقات (PowerShell # وSQL --) قبل الفحص: التعليق قد يذكر النجمة شرحاً.
  const ps1Code = ps1.replace(/^\s*#.*$/gm, "").replace(/--.*$/gm, "");
  assert.ok(!/TotalDisc[^\n]*\*/.test(ps1Code), "TotalDisc مضروب بشيء في السكربت");
  assert.ok(!/discount[^\n]*\*\s*(\$b\.total|total)/i.test(ps1Code), "الحسم مضروب بالإجمالي");
  assert.match(ps1, /CAST\(COALESCE\(u\.TotalDisc,0\) AS decimal\(18,3\)\) AS bill_discount/);
  assert.match(ps1, /CAST\(COALESCE\(u\.FirstPay,0\)\s+AS decimal\(18,3\)\) AS bill_first_pay/);
  assert.match(ps1, /discount = \[math\]::Round\(\$b\.discount, 3\)/);
  assert.match(ps1, /payment  = \[math\]::Round\(\$b\.payment, 3\)/);
  // SELECT فقط على الأمين. الفحص محصور بنصوص SQL نفسها (here-strings) — بقية
  // السكربت يخاطب Supabase عبر HTTP وله عمليات حذف مشروعة هناك لا علاقة لها بالأمين.
  const sqlBlocks = ps1.match(/@"[\s\S]*?"@/g) || [];
  assert.ok(sqlBlocks.length > 0, "لم أجد أي نص SQL في السكربت");
  for (const block of sqlBlocks) {
    if (!/\bFROM\b|\bSELECT\b/i.test(block)) continue;
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|EXEC)\b/i.test(block),
      "نص SQL يحوي عبارة كتابة: " + block.slice(0, 80));
  }
  // والحقلان الجديدان من bu000 نفسه بلا join إضافي.
  const invoiceSql = sqlBlocks.find((b) => b.includes("bill_discount")) || "";
  assert.ok(invoiceSql.includes("u.TotalDisc") && invoiceSql.includes("u.FirstPay"),
    "الحقلان لا يُقرآن من رأس الفاتورة");
  assert.equal((invoiceSql.match(/\bJOIN\b/gi) || []).length, 3, "عدد الـjoins تغيّر عن bt000/bi000/mt000");
});

test("fallback adjustment يساوي فقط الفرق غير المفسر", () => {
  assert.match(appJs, /opts\.prevBalance \+ total - knownDiscount - knownPayment - opts\.newBalance/);
  // مع القيم الحقيقية للفاتورة 562 لا يبقى فرق إطلاقاً.
  const residual = 0 + AMEEN_562.total - AMEEN_562.discount - AMEEN_562.payment
    - (AMEEN_562.total - AMEEN_562.discount - AMEEN_562.payment);
  assert.equal(residual, 0);
  // وفرق حقيقي غير مفسر (تعديل لاحق) يبقى ظاهراً بتسميته الصحيحة.
  const html = voucherPdfMarkup({
    type: "invoice", name: "س", no: "9", date: "2026-08-31", cur: "$",
    amount: 200, prevBalance: 0, discount: 1, payment: 10, adjust: 4, newBalance: 185
  });
  assert.ok(html.includes("<th>الحسم</th>") && html.includes("<th>دفعة من الزبون</th>")
    && html.includes("تسوية على الحساب"), "الثلاثة يجب أن تظهر منفصلة");
});

// ===== 4) قيمة السطر / نصف الكرتونة (B) =====

// أساس أسعار الفاتورة كروز (unit1): السعر لكل كروز، والكمية بالكروز.
// نصف كرتونة = 25 كروز، سعر الكروز 8.06، معامل الكرتونة 50.
const halfCarton = { material: "ماستر", qty: 25, qtyUnits: 0.5, price: 8.06, lineTotal: 201.5, unit1: "كروز", unit2: "كرتونة" };
const fullCarton = { material: "ماستر", qty: 50, qtyUnits: 1, price: 8.06, lineTotal: 403, unit1: "كروز", unit2: "كرتونة" };
const invOf = (lines, totalOverride) => ({
  total: totalOverride != null ? totalOverride : lines.reduce((s, l) => s + l.lineTotal, 0),
  lines
});

test("half carton displays unit price 403", () => {
  const inv = invOf([halfCarton]);
  assert.equal(invoiceLinePrice(halfCarton, inv), "403 $ / كرتونة");
});

test("half carton displays line total 201.50", () => {
  const inv = invOf([halfCarton]);
  assert.equal(invoiceLineTotalValue(halfCarton, inv), 201.5);
  assert.equal(invoiceLineQty(halfCarton), "0.5 كرتونة (25 كروز)");
});

test("full carton displays correct unit price and line total", () => {
  const inv = invOf([fullCarton]);
  assert.equal(invoiceLinePrice(fullCarton, inv), "403 $ / كرتونة");
  assert.equal(invoiceLineTotalValue(fullCarton, inv), 403);
});

test("line total remains qty × base-unit price", () => {
  const inv = invOf([halfCarton, fullCarton]);
  for (const line of [halfCarton, fullCarton]) {
    assert.equal(invoiceLineTotalValue(line, inv), Math.round(line.qty * line.price * 1000) / 1000);
  }
  // ومجموع قيم الأسطر = إجمالي الفاتورة.
  const sum = [halfCarton, fullCarton].reduce((s, l) => s + invoiceLineTotalValue(l, inv), 0);
  assert.equal(Math.round(sum * 100) / 100, 604.5);
});

test("PDF/print uses same lineTotal as invoice data", () => {
  const html = voucherPdfMarkup({
    type: "invoice", name: "حسن عباس", no: "562", date: "2026-08-31", cur: "$",
    amount: 201.5, prevBalance: 0, newBalance: 201.5, lines: [halfCarton]
  });
  assert.ok(html.includes("<th>قيمة السطر</th>"), "عمود قيمة السطر مفقود من المستند");
  assert.ok(html.includes("201.5"), "قيمة السطر الفعلية غير مطبوعة");
  assert.ok(html.includes("403"), "سعر الوحدة (الكرتونة) غير مطبوع");
  // الكمية والسعر والقيمة ثلاثة أعمدة منفصلة لا يُخلط بينها.
  // الكمية صارت أجزاءً ذرّية في عناصر عزل مستقلة (محرّك الرسم على الهاتف يعيد
  // ترتيب أي عقدة نصّية مختلطة) — فنفحص الجزأين وترتيبهما بدل السلسلة الملتصقة.
  // القيمة والوحدة المتوقَّعتان كما هما، ولم يتغيّر أي رقم.
  const qtyValueAt = html.indexOf('<span class="qv">0.5</span>');
  const qtyUnitAt = html.indexOf('<span class="qu">كرتونة</span>');
  assert.ok(qtyValueAt >= 0 && qtyUnitAt > qtyValueAt, "الكمية غير مطبوعة بالوحدة الكبرى");
});

// ===== 4ب) فاتورة #712 بتاريخ 2026-09-12: كمية جزئية من كروز بسعر الوحدة الصغرى
// (العطل المُثبت: `price(كروز) × qtyUnits(كسر شرحة/كرتونة)` بدل `stored` الصحيحة) =====

// معسل فاخر أسود كروز محرز: الشرحة = 12 كروز، سعر الشرحة 175$ → سعر الكروز
// 175/12، والكمية المباعة 10 كروز (0.8333 شرحة).
const shishaLine = {
  material: "معسل فاخر أسود كروز محرز", qty: 10, qtyUnits: 10 / 12,
  price: 175 / 12, lineTotal: (10 * 175) / 12, unit1: "كروز", unit2: "شرحة"
};
// Marlboro أبيض ورق: 10 كروز بسعر الكروز 20.5$، معامل الكرتونة يجعلها 0.2 كرتونة.
const marlboroLine = {
  material: "Marlboro أبيض ورق", qty: 10, qtyUnits: 0.2,
  price: 20.5, lineTotal: 205, unit1: "كروز", unit2: "كرتونة"
};
// Master Queen أبيض: 15 كروز بسعر الكروز 9.7$، معامل الكرتونة يجعلها 0.3 كرتونة.
const masterQueenLine = {
  material: "Master Queen أبيض", qty: 15, qtyUnits: 0.3,
  price: 9.7, lineTotal: 145.5, unit1: "كروز", unit2: "كرتونة"
};

test("معسل فاخر أسود كروز محرز: 10 كروز من شرحة 12 بسعر 175$ = 145.833$", () => {
  const inv = invOf([shishaLine]);
  assert.equal(invoiceLineTotalValue(shishaLine, inv), 145.833);
});

test("Marlboro أبيض ورق: 10 كروز بسعر الكروز 20.5$ = 205$", () => {
  const inv = invOf([marlboroLine]);
  assert.equal(invoiceLineTotalValue(marlboroLine, inv), 205);
});

test("Master Queen أبيض: 15 كروز بسعر الكروز 9.7$ = 145.5$", () => {
  const inv = invOf([masterQueenLine]);
  assert.equal(invoiceLineTotalValue(masterQueenLine, inv), 145.5);
});

test("فاتورة مختلطة الأساس (unit1 وunit2 معاً): كل سطر يحتفظ بقيمته الصحيحة", () => {
  // سطر أغلبية الفاتورة بالقيمة: مسعّر بالكرتونة كاملة (unit2)، يجعل
  // invoicePriceBasis(inv) يحسم "unit2" لكامل الفاتورة رغم أن سطر Marlboro
  // مسعّر بالكروز (unit1) تحديداً.
  const bigCartonLine = {
    material: "صنف بالجملة", qty: 500, qtyUnits: 10,
    price: 205, lineTotal: 2050, unit1: "كروز", unit2: "كرتونة"
  };
  const inv = invOf([marlboroLine, bigCartonLine]);
  // تأكيد أن الفاتورة فعلاً "ملتبسة": الأساس المحسوم لكامل الفاتورة unit2،
  // وهو ما كان يُطبَّق خطأً على سطر Marlboro أيضاً قبل الإصلاح.
  assert.equal(invoicePriceBasis(inv), "unit2");
  // ومع ذلك يجب أن يعطي كل سطر قيمته الصحيحة الخاصة به.
  assert.equal(invoiceLineTotalValue(marlboroLine, inv), 205, "سطر الكروز يجب أن يبقى 205$ رغم أساس الفاتورة unit2");
  assert.equal(invoiceLineTotalValue(bigCartonLine, inv), 2050);
  // وعرض سعر الوحدة لا يخلط بين سعر الكروز وكمية الكرتونة: يُحوَّل لما يعادله
  // بالكرتونة (20.5 × 50 = 1025) بدل عرض 20.5$ بجانب 0.2 كرتونة.
  const marlboroPrice = invoiceLineUnitPrice(marlboroLine, inv);
  assert.equal(marlboroPrice.unit, "كرتونة");
  assert.equal(marlboroPrice.price, 1025);
  const bigCartonPrice = invoiceLineUnitPrice(bigCartonLine, inv);
  assert.equal(bigCartonPrice.price, 205);
  assert.equal(bigCartonPrice.unit, "كرتونة");
});

test("invariant: قيمة سطر مخزَّنة موجبة لا تتغيّر بسبب تحويل الوحدة مهما كان أساس الفاتورة", () => {
  // كل الأمثلة الثلاثة + الحالة المختلطة: `stored` (lineTotal من الأمين) هو
  // القيمة الوحيدة المسموح بها دائماً حين تكون رقماً موجباً، بصرف النظر عن
  // نتيجة invoicePriceBasis أو عن قيمة qtyUnits/price.
  const lines = [shishaLine, marlboroLine, masterQueenLine];
  for (const forcedBasisInv of [invOf(lines), { total: 0, lines: [] }, null]) {
    for (const line of lines) {
      assert.equal(
        invoiceLineTotalValue(line, forcedBasisInv),
        Math.round(line.lineTotal * 1000) / 1000,
        `${line.material}: القيمة المخزَّنة يجب أن تفوز دائماً`
      );
    }
  }
});

// ===== 4ج) ملاحظة Codex P1 على PR #215: تمييز lineTotal الحقيقي من الأمين عن
// lineTotal المشتق (fallback = Qty × Price) داخل tools/push-customer-invoices.ps1
// حين لا يوجد عمود إجمالي حقيقي على bi000 لتنصيب أمين معيّن. المشتق يساوي
// price×qty بالتعريف، فلو وثقنا به لحسم أساس السطر (`invoiceLineBasis`) لأعاد
// "unit1" دائماً — يُسقط آلية الحسم لكل الفواتير على ذلك التنصيب بصمت. =====

test("P1 — REAL AMEEN: lineTotalSource=ameen يبقى مصدر الحقيقة (10 كروز × 20.5 = 205$)", () => {
  const line = {
    material: "Marlboro أبيض ورق", qty: 10, qtyUnits: 0.2,
    price: 20.5, lineTotal: 205, lineTotalSource: "ameen", unit1: "كروز", unit2: "كرتونة"
  };
  const inv = invOf([line]);
  assert.equal(invoiceLineBasis(line), "unit1", "أساس السطر الحقيقي من الأمين يجب أن يُحسم بمقارنة stored");
  assert.equal(invoiceLineTotalValue(line, inv), 205);
});

test("P1 — DERIVED + سعر الوحدة الكبرى (كرتونة): لا يجوز تصنيف السطر unit1 لمجرد أن stored = qty×price", () => {
  // factor = 50 (qty÷qtyUnits)، السعر فعلياً سعر الكرتونة (1025)، لكن الأداة
  // رفعت qty=10 (بوحدة الكروز) والقيمة المشتقة = 10 × 1025 = 10250 — رقم خاطئ
  // تماماً، وليس القيمة الفعلية 0.2 كرتونة × 1025 = 205.
  const price = 1025;
  const qty = 10;
  const qtyUnits = 0.2; // factor = qty / qtyUnits = 50
  const derivedStored = qty * price; // 10250 — fallback خاطئ، وليس إجمالي أمين حقيقي
  const line = {
    material: "صنف بالجملة", qty, qtyUnits, price,
    lineTotal: derivedStored, lineTotalSource: "derived", unit1: "كروز", unit2: "كرتونة"
  };
  // إجمالي الفاتورة الحقيقي (لو من الأمين) يطابق 0.2 كرتونة × 1025 = 205،
  // فيحسم invoicePriceBasis أساس unit2 لهذه الفاتورة.
  const inv = invOf([line], 205);
  assert.equal(invoiceLineBasis(line), null, "derived لا يجوز أن يحسم أساساً من stored المصنَّعة");
  assert.equal(invoicePriceBasis(inv), "unit2");
  assert.equal(
    invoiceLineTotalValue(line, inv), 205,
    "يجب استخدام أساس الفاتورة (0.2 × 1025) لا stored المشتقة (10250)"
  );
});

test("P1 — DERIVED + سعر الوحدة الصغرى (كروز): يبقى qty × price حين أساس الفاتورة unit1", () => {
  const price = 20.5; // سعر الكروز
  const qty = 10;
  const qtyUnits = 0.2;
  const derivedStored = qty * price; // 205 — يصادف أنها صحيحة هنا لأن الأساس فعلاً unit1
  const line = {
    material: "Marlboro أبيض ورق", qty, qtyUnits, price,
    lineTotal: derivedStored, lineTotalSource: "derived", unit1: "كروز", unit2: "كرتونة"
  };
  const inv = invOf([line], 205); // يطابق qty×price، فيحسم invoicePriceBasis أساس unit1
  assert.equal(invoiceLineBasis(line), null, "derived يبقى null بصرف النظر عن تطابق stored مصادفةً");
  assert.equal(invoicePriceBasis(inv), "unit1");
  assert.equal(invoiceLineTotalValue(line, inv), 205, "qty × price يبقى صحيحاً حين الأساس فعلاً unit1");
});

test("P1 — LEGACY: lineTotalSource غائب (فواتير رُفعت قبل إضافة الحقل) — لا تغيير بالسلوك", () => {
  const line = {
    material: "Master Queen أبيض", qty: 15, qtyUnits: 0.3,
    price: 9.7, lineTotal: 145.5, unit1: "كروز", unit2: "كرتونة"
    // لا lineTotalSource إطلاقاً
  };
  const inv = invOf([line]);
  assert.equal(invoiceLineBasis(line), "unit1", "الفواتير القديمة بلا الحقل تبقى تُحسم من stored كما كانت");
  assert.equal(invoiceLineTotalValue(line, inv), 145.5);
});

test("P1 — فاتورة مختلطة: سطر derived لا يفسد حسم الأساس لسطور ameen الحقيقية المجاورة", () => {
  const realLine = {
    material: "Marlboro أبيض ورق", qty: 10, qtyUnits: 0.2,
    price: 20.5, lineTotal: 205, lineTotalSource: "ameen", unit1: "كروز", unit2: "كرتونة"
  };
  const derivedLine = {
    material: "صنف بالجملة", qty: 10, qtyUnits: 0.2,
    price: 1025, lineTotal: 10250, lineTotalSource: "derived", unit1: "كروز", unit2: "كرتونة"
  };
  const inv = invOf([realLine, derivedLine], 205 + 205);
  assert.equal(invoiceLineBasis(realLine), "unit1", "سطر ameen الحقيقي يبقى محسوماً من stored الخاصة به");
  assert.equal(invoiceLineTotalValue(realLine, inv), 205, "سطر ameen لا يتأثر بوجود سطر derived بجانبه");
  assert.equal(invoiceLineTotalValue(derivedLine, inv), 205, "سطر derived يُحسب من أساس الفاتورة لا من stored المصنَّعة");
});

// ===== 4د) فاتورة #733 بتاريخ 2026-09-13 (مركز الشعلان دوما): القيمة المخزَّنة
// القادمة من الأمين نفسها مبنية على وحدة خاطئة =====
//
// بيانات حقيقية من آخر تقرير `ameen_customer_invoices` (اللقطة المتأثرة، إجمالي
// 1163.6$): كل `lineTotal` = `price × qty` و`qty` بالكروز، بينما أربعة من الأسعار
// الخمسة أسعار كرتونة. فطُبع «14,300$» لكرتونة واحدة سعرها 286$، و«7,950$»
// لنصف كرتونة سعرها 318$ — وطُبع الرقم نفسه «سعر الوحدة» أيضاً.
//
// السطر الخامس (غلواز قصير أصفر) شاهد أن أساساً واحداً لكل الفاتورة لا يكفي:
// سعره 8.04$ سعر **كروز** فعلاً (8.04 × 50 = 402$ للكرتونة)، وقيمته المخزَّنة
// 120.6$ صحيحة. فلا كل الأسطر كرتونة ولا كلها كروز.
const inv733Lines = [
  { material: "ماستر سليم أزرق", qty: 50, qtyUnits: 1, price: 286, lineTotal: 14300, unit1: "كروز", unit2: "كرتونة" },
  { material: "ماستر سليم فضي", qty: 50, qtyUnits: 1, price: 290, lineTotal: 14500, unit1: "كروز", unit2: "كرتونة" },
  { material: "اختمار سليم فضي", qty: 50, qtyUnits: 1, price: 308, lineTotal: 15400, unit1: "كروز", unit2: "كرتونة" },
  { material: "اليغانس قصير فضي", qty: 25, qtyUnits: 0.5, price: 318, lineTotal: 7950, unit1: "كروز", unit2: "كرتونة" },
  { material: "غلواز قصير أصفر", qty: 15, qtyUnits: 0.3, price: 8.04, lineTotal: 120.6, unit1: "كروز", unit2: "كرتونة" }
];
const INV_733_TOTAL = 1163.6;
const inv733 = invOf(inv733Lines, INV_733_TOTAL);
const INV_733_EXPECTED = [286, 290, 308, 159, 120.6];

test("#733: قيم الأسطر الخمسة كما في فاتورة الأمين", () => {
  assert.deepEqual(
    inv733Lines.map((line) => invoiceLineTotalValue(line, inv733)),
    INV_733_EXPECTED
  );
});

test("#733: مجموع أسطر الطباعة = إجمالي الفاتورة 1163.6$", () => {
  const sum = inv733Lines.reduce((acc, line) => acc + invoiceLineTotalValue(line, inv733), 0);
  assert.equal(Math.round(sum * 1000) / 1000, INV_733_TOTAL);
});

test("#733: لا أساس واحد يطابق الإجمالي — المطابقة للخلطة وحدها", () => {
  // شاهد أن الإصلاح ليس «اختر unit1 أو unit2 لكل الفاتورة»: كلا المجموعين بعيد.
  const sumUnit1 = inv733Lines.reduce((a, l) => a + l.price * l.qty, 0);
  const sumUnit2 = inv733Lines.reduce((a, l) => a + l.price * l.qtyUnits, 0);
  assert.ok(Math.abs(sumUnit1 - INV_733_TOTAL) > 1, `مجموع unit1 = ${sumUnit1}`);
  assert.ok(Math.abs(sumUnit2 - INV_733_TOTAL) > 1, `مجموع unit2 = ${sumUnit2}`);
  // والمخزَّن مساوٍ لمجموع unit1 تماماً، فلا يصلح دليلاً على أساس أي سطر.
  const sumStored = inv733Lines.reduce((a, l) => a + l.lineTotal, 0);
  assert.equal(Math.round(sumStored * 1000) / 1000, Math.round(sumUnit1 * 1000) / 1000);
});

test("#733: سعر الوحدة معروض بالكرتونة (286/290/308/318/402) لا 14,300 ولا 15,400", () => {
  assert.deepEqual(
    inv733Lines.map((line) => invoiceLineUnitPrice(line, inv733).price),
    [286, 290, 308, 318, 402]
  );
  for (const line of inv733Lines) {
    assert.equal(invoiceLineUnitPrice(line, inv733).unit, "كرتونة");
  }
});

test("#733: المستند المطبوع لا يحمل أي رقم من أرقام العطل", () => {
  const html = voucherPdfMarkup({
    type: "invoice", name: "مركز الشعلان دوما", no: "733", date: "2026-09-13", cur: "$",
    amount: INV_733_TOTAL, prevBalance: 0, newBalance: INV_733_TOTAL, lines: inv733Lines
  });
  for (const wrong of ["14,300", "14,500", "15,400", "7,950", "6,030"]) {
    assert.ok(!html.includes(wrong), `الرقم الخاطئ ${wrong} ما زال مطبوعاً`);
  }
  assert.ok(html.includes("<td><bdi>286 $ / كرتونة</bdi></td>"), "سعر كرتونة ماستر سليم أزرق غير مطبوع");
  assert.ok(html.includes("<td><bdi>402 $ / كرتونة</bdi></td>"), "سعر كرتونة غلواز غير مطبوع");
  assert.ok(html.includes("<td><bdi>159</bdi></td>"), "قيمة نصف كرتونة اليغانس غير مطبوعة");
  assert.ok(html.includes("<td><bdi>120.6</bdi></td>"), "قيمة غلواز غير مطبوعة");
});

// ===== 4هـ) حصر مطلق: قيمة سطر لا تتجاوز إجمالي الفاتورة بحال =====
//
// العطل كله ينضغط في هذه العبارة: كرتونة واحدة سعرها 286$ لا تصير 14,300$، ونصف
// كرتونة سعرها 318$ لا تصير 7,950$. الحصر معمَّم لا موقوف على أرقام #733: أي سطر
// قيمته المطبوعة أكبر من إجمالي الفاتورة هو حساب خاطئ بالضرورة، لأن الأسطر كلها
// موجبة ومجموعها هو الإجمالي.
test("حصر: 1 كرتونة × 286$ لا تعطي 14,300$ أبداً", () => {
  const line = inv733Lines[0];
  const value = invoiceLineTotalValue(line, inv733);
  assert.notEqual(value, 14300);
  assert.equal(value, 286);
  assert.notEqual(invoiceLineUnitPrice(line, inv733).price, 14300);
});

test("حصر: 0.5 كرتونة × 318$ لا تعطي 7,950$ أبداً", () => {
  const line = inv733Lines[3];
  const value = invoiceLineTotalValue(line, inv733);
  assert.notEqual(value, 7950);
  assert.equal(value, 159);
  assert.notEqual(invoiceLineUnitPrice(line, inv733).price, 7950);
});

test("حصر معمَّم: لا سطر قيمته أكبر من إجمالي الفاتورة", () => {
  for (const line of inv733Lines) {
    const value = invoiceLineTotalValue(line, inv733);
    assert.ok(value <= INV_733_TOTAL + 0.001, `${line.material}: ${value} > ${INV_733_TOTAL}`);
  }
});

// ===== 4و) حالات حدّية للخطة: لا تتفعّل بلا مطابقة، ولا تُفسد فاتورة سليمة =====

test("الخطة لا تتفعّل بلا إجمالي موثوق (الفواتير القديمة والاستدعاء بلا فاتورة)", () => {
  for (const line of inv733Lines) {
    // بلا إجمالي: لا حكم، فيبقى السلوك القديم (القيمة المخزَّنة كما هي).
    assert.equal(invoiceLineTotalValue(line, { total: 0, lines: inv733Lines }), line.lineTotal);
    assert.equal(invoiceLineTotalValue(line, null), line.lineTotal);
  }
});

test("الخطة لا تتفعّل حين لا يوجد توزيع يطابق الإجمالي", () => {
  // إجمالي لا يطابقه أي توزيع مرشّحات (ولا المخزَّن): لا حكم ⇒ السلوك القديم.
  const bogus = invOf(inv733Lines, 999.99);
  assert.equal(invoiceLineBasisPlan(bogus), null);
  for (const line of inv733Lines) {
    assert.equal(invoiceLineTotalValue(line, bogus), line.lineTotal);
  }
});

test("فاتورة قيمها المخزَّنة تطابق الإجمالي تبقى بلا مساس", () => {
  // نفس أسطر #733 لكن بقيم مخزَّنة صحيحة وإجمالي مطابق لها: الخطة لا تُستدعى
  // للتغيير، والقيمة المخزَّنة تُطبع كما هي.
  const healthy = inv733Lines.map((line, i) => ({ ...line, lineTotal: INV_733_EXPECTED[i] }));
  const inv = invOf(healthy, INV_733_TOTAL);
  assert.equal(invoiceLineBasisPlan(inv), null, "مجموع مخزَّن مطابق ⇒ لا حكم");
  assert.deepEqual(healthy.map((line) => invoiceLineTotalValue(line, inv)), INV_733_EXPECTED);
});

test("سطر سعره صفر لا يُخرج الفاتورة السليمة من بوابة «المخزَّن موثوق»", () => {
  // بيانات الجهاز فيها أسطر `price = 0` وقيمتها صفر (فاتورة #102 مثلاً). لو
  // حُسبت القيمة الصفرية «غائبة» لسقطت البوابة، ودخلت فاتورة مجموعها المخزَّن
  // مطابقٌ تماماً في بحثٍ لا حاجة له، وربما خرجت بتوزيع غير توزيعها الصحيح.
  const lines = [
    { material: "صنف مسعّر", qty: 15, qtyUnits: 0.3, price: 7.1, lineTotal: 106.5, unit1: "كروز", unit2: "كرتونة" },
    { material: "صنف بسعر صفر", qty: 2, qtyUnits: 0.04, price: 0, lineTotal: 0, unit1: "كروز", unit2: "كرتونة" }
  ];
  const inv = invOf(lines, 106.5);
  assert.equal(invoiceLineBasisPlan(inv), null, "مجموع مخزَّن مطابق ⇒ لا حكم ولا بحث");
  assert.equal(invoiceLineTotalValue(lines[0], inv), 106.5);
  assert.equal(invoiceLineTotalValue(lines[1], inv), 0);
});

test("أساس مختلط مع أسطر متطابقة المرشّحين: المجموع يطابق الإجمالي", () => {
  // ثلاثة أسطر متطابقة تماماً (نفس السعر والكميات) واثنان يجب أن يُقرآ بالكروز:
  // الخطة تختار عدداً لا هويةً، فلا تعدّد حلول بلا فرق في القيم.
  const twin = { material: "معسل", qty: 3, qtyUnits: 0.25, price: 11.08, lineTotal: 33.24, unit1: "كروز", unit2: "شرحة" };
  const carton = { material: "سجائر", qty: 50, qtyUnits: 1, price: 290, lineTotal: 14500, unit1: "كروز", unit2: "كرتونة" };
  const lines = [carton, { ...twin }, { ...twin }, { ...twin }];
  const total = 290 + 33.24 + 33.24 + 2.77; // كرتونة + سطران بالكروز + سطر بالشرحة
  const inv = invOf(lines, total);
  const values = lines.map((line) => invoiceLineTotalValue(line, inv));
  assert.equal(values[0], 290, "سطر الكرتونة");
  assert.equal(Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100, Math.round(total * 100) / 100);
});

// ===== 4ز) فاتورة #698 (57 سطراً): الهامش يكبر بعدد الأسطر، فلا يُقبل توزيع
// «داخل الهامش» قبل تجربة المضبوط =====
//
// العطل المُثبت: `invoiceBasisTolerance` تساوي 0.0006 × مجموع الأسعار، فبلغت
// 3.644$ في فاتورة بـ57 سطراً. فقَبِل البحث أول توزيع يقع داخل الهامش وكان
// بعيداً 3.234$ عن الإجمالي، رغم وجود توزيع مضبوط. النتيجة: سطر «تي اس سليم
// فضي» سعره 3.3$ (سعر كروز، `unit1_price = 3.3` مقابل `unit2_price = 165` في
// لائحة الأسعار المعتمدة) قُرئ كرتونةً فصارت قيمته 0.066$ بدل 3.3$.
test("#698: توزيع مضبوط يتقدّم على توزيع «داخل هامش التقريب»", () => {
  // مصغَّر أمين لنفس البنية: سطر كبير يستهلك الإجمالي، وسطران صغيران الفرق
  // بينهما أصغر من هامش فاتورة طويلة — والمضبوط منهما واحد فقط.
  const big = { material: "صنف كرتونة", qty: 50, qtyUnits: 1, price: 400, lineTotal: 20000, unit1: "كروز", unit2: "كرتونة" };
  const cruise = { material: "صنف كروز", qty: 1, qtyUnits: 0.02, price: 3.3, lineTotal: 3.3, unit1: "كروز", unit2: "كرتونة" };
  // الإجمالي الصحيح: 400 (كرتونة) + 3.3 (كروز) = 403.3
  const inv = invOf([big, cruise], 403.3);
  assert.equal(invoiceLineTotalValue(big, inv), 400, "السطر الكبير كرتونة");
  assert.equal(invoiceLineTotalValue(cruise, inv), 3.3, "سطر الكروز لا يُقرأ كرتونة (0.066$)");
  const sum = invoiceLineTotalValue(big, inv) + invoiceLineTotalValue(cruise, inv);
  assert.equal(Math.round(sum * 1000) / 1000, 403.3, "المجموع مضبوط لا «قريب»");
});

test("هامش التقريب يبقى متاحاً حين لا يوجد توزيع مضبوط", () => {
  // شرحة 12 كروز: `qtyUnits` مدوَّرة إلى 0.833 فلا تطابق تام ممكن، والهامش
  // هو ما يجعل الفاتورة قابلة للحسم إطلاقاً. لا يجوز أن يُلغيه تفضيل المضبوط.
  const line = { material: "معسل", qty: 10, qtyUnits: 0.833, price: 175, lineTotal: 1750, unit1: "كروز", unit2: "شرحة" };
  const inv = invOf([line], 145.833);
  assert.equal(invoiceLineBasisPlan(inv)?.get(line), "unit2", "الحسم يجب أن ينجح بالهامش");
  assert.equal(invoiceLineTotalValue(line, inv), 145.775); // 175 × 0.833
});

// ===== 4ح) سعر الوحدة وقيمة السطر يقرآن الأساس من مصدر واحد =====
//
// خطر بنيوي: لو قرأت إحدى الدالتين الخطة والأخرى `stored` لظهر مستند «سعر وحدة
// صحيح × كمية معروضة ≠ قيمة السطر» — وهي ورقة تُسلَّم للزبون ولا تُجمع.
test("اتساق الأساس: سعر الوحدة المعروض × الكمية المعروضة = قيمة السطر", () => {
  const cases = [
    { lines: inv733Lines, total: INV_733_TOTAL },
    { lines: [shishaLine, marlboroLine, masterQueenLine], total: undefined },
    { lines: [halfCarton, fullCarton], total: undefined },
    { // مختلطة: كرتونة + كروز + كسر كرتونة
      lines: [
        { material: "أ", qty: 50, qtyUnits: 1, price: 290, lineTotal: 14500, unit1: "كروز", unit2: "كرتونة" },
        { material: "ب", qty: 15, qtyUnits: 0.3, price: 8.1, lineTotal: 121.5, unit1: "كروز", unit2: "كرتونة" },
        { material: "ج", qty: 25, qtyUnits: 0.5, price: 318, lineTotal: 7950, unit1: "كروز", unit2: "كرتونة" }
      ],
      total: 290 + 121.5 + 159
    }
  ];
  for (const testCase of cases) {
    const inv = invOf(testCase.lines, testCase.total);
    for (const line of testCase.lines) {
      const resolved = invoiceLineUnitPrice(line, inv);
      const value = invoiceLineTotalValue(line, inv);
      if (!resolved || !(value > 0)) continue;
      // الكمية المعروضة هي التي تقابل وحدة السعر المعروضة (نفس منطق invoiceLineQty).
      const shownQty = resolved.unit === String(line.unit2 || "").trim() ? line.qtyUnits : line.qty;
      assert.ok(
        Math.abs(resolved.price * shownQty - value) <= Math.max(0.02, 0.002 * value),
        `${line.material}: ${resolved.price} × ${shownQty} = ${resolved.price * shownQty} ≠ ${value}`
      );
    }
  }
});

test("تدقيق المصدر: كلتا الدالتين تستشير خطة الفاتورة", () => {
  // حارس بنيوي: لو أُضيف مسار قيمة أو سعر لا يقرأ الخطة، عاد خطر التنافر.
  const valueFn = appJs.match(/function invoiceLineTotalValue\(line, inv\) \{[\s\S]*?\n\}\n/)[0];
  const priceFn = appJs.match(/function invoiceLineUnitPrice\(line, inv\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(valueFn, /invoiceLineBasisPlan\(inv\)/, "invoiceLineTotalValue لا تقرأ الخطة");
  assert.match(priceFn, /invoiceLineBasisPlan\(inv\)/, "invoiceLineUnitPrice لا تقرأ الخطة");
  // والخطة تتقدّم على stored وعلى invoiceLineBasis في كل منهما.
  assert.ok(
    valueFn.indexOf("invoiceLineBasisPlan") < valueFn.indexOf("line?.lineTotalSource") ||
    valueFn.indexOf("invoiceLineBasisPlan") < valueFn.indexOf("stored > 0"),
    "الخطة يجب أن تُفحص قبل الوثوق بالقيمة المخزَّنة"
  );
  assert.ok(
    priceFn.indexOf("invoiceLineBasisPlan") < priceFn.indexOf("invoiceLineBasis(line)"),
    "الخطة يجب أن تُفحص قبل invoiceLineBasis"
  );
});

// ===== 5) كل مسارات تصدير الفاتورة تنسب الحسم والدفعة (لا مسار متخلّف) =====

test("تدقيق: كل موضع يحسب adjust يطرح الحسم والدفعة أولاً", () => {
  // العطل الذي كان: أُصلح مسار زر الحركات وحده، وبقي مسار «التقارير ← فواتير
  // الزبون» يضع الفرق كاملاً في adjust — فتظهر دفعة الفاتورة 562 «تسوية على
  // الحساب 2000». مسارا تصدير لنفس المستند بنتيجتين مختلفتين.
  const sites = appJs.match(/opts\.prevBalance \+ (?:total|invoiceTotal|amount)[^;]*?opts\.newBalance/g) || [];
  assert.ok(sites.length >= 2, `عدد مواضع حساب adjust = ${sites.length} (متوقع 2 على الأقل)`);
  for (const site of sites) {
    assert.ok(/knownDiscount/.test(site) && /knownPayment/.test(site),
      "موضع يحسب adjust بلا طرح الحسم والدفعة: " + site.replace(/\s+/g, " "));
  }
  // وكل موضع يمرّر الحقلين إلى المستند.
  assert.equal((appJs.match(/if \(knownDiscount > 0\.009\) opts\.discount = knownDiscount;/g) || []).length, sites.length);
  assert.equal((appJs.match(/if \(knownPayment > 0\.009\) opts\.payment = knownPayment;/g) || []).length, sites.length);
  // مسار التقارير يقرأ الحقلين من حمولة الأمين نفسها.
  assert.match(appJs, /Number\(inv\.discount \|\| 0\)/);
  assert.match(appJs, /Number\(inv\.payment \|\| 0\)/);
  // ومسار زر الحركات يقرأهما من الفاتورة المطابَقة.
  assert.match(appJs, /Number\(match\.discount \|\| 0\)/);
  assert.match(appJs, /Number\(match\.payment \|\| 0\)/);
});

test("مسار التقارير: الفاتورة 562 تُظهر دفعة لا تسوية", () => {
  // أرقام حقيقية من AmnDb002: total 2751.5، discount 0، payment 2000.
  const prev = 0, total = 2751.5, discount = 0, payment = 2000;
  const newBalance = prev + total - discount - payment;      // 751.5
  const residual = prev + total - discount - payment - newBalance;
  assert.equal(residual, 0, "لا يجوز بقاء أي فرق غير مفسر");
  const html = voucherPdfMarkup({
    type: "invoice", name: "زبون 562", no: "562", date: "2026-08-30", cur: "$",
    amount: total, prevBalance: prev, payment, newBalance,
    ...(residual > 0.009 ? { adjust: residual } : {})
  });
  assert.ok(html.includes("<th>دفعة من الزبون</th>"), "سطر الدفعة مفقود");
  assert.ok(!html.includes("تسوية على الحساب"), "الدفعة ظهرت كتسوية");
  assert.ok(!html.includes("<th>الحسم</th>"), "حسم صفر لا يجوز أن يظهر");
});

test("مسار التقارير: الفاتورة 561 تُظهر الحسم والدفعة سطرين لا adjust", () => {
  const prev = 0, total = 17698.5, discount = 0.5, payment = 16626;
  const newBalance = prev + total - discount - payment;      // 1072
  const residual = prev + total - discount - payment - newBalance;
  assert.equal(residual, 0);
  const html = voucherPdfMarkup({
    type: "invoice", name: "زبون 561", no: "561", date: "2026-08-30", cur: "$",
    amount: total, prevBalance: prev, discount, payment, newBalance
  });
  assert.ok(html.includes("<th>الحسم</th>"), "سطر الحسم مفقود");
  assert.ok(html.includes("<th>دفعة من الزبون</th>"), "سطر الدفعة مفقود");
  assert.ok(!html.includes("تسوية على الحساب"), "دُمجا في تسوية");
});

test("التسوية تبقى فقط لفرق غير مفسر فعلاً", () => {
  const prev = 0, total = 200, discount = 1, payment = 10, newBalance = 185;
  const residual = prev + total - discount - payment - newBalance;   // 4
  assert.equal(residual, 4);
  const html = voucherPdfMarkup({
    type: "invoice", name: "س", no: "9", date: "2026-08-31", cur: "$",
    amount: total, prevBalance: prev, discount, payment, adjust: residual, newBalance
  });
  for (const row of ["<th>الحسم</th>", "<th>دفعة من الزبون</th>", "تسوية على الحساب"]) {
    assert.ok(html.includes(row), `مفقود: ${row}`);
  }
});

// ===== النتيجة =====

console.log("فحص سلامة مستند الفاتورة (اسم الملف + الفصل المحاسبي):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص مستند الفاتورة نجحت.");
