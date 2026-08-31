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
  sanitizeDocumentTitle: /function sanitizeDocumentTitle\(value\) \{[\s\S]*?\n\}\n/,
  fileDateLabel: /function fileDateLabel\(isoDate\) \{[\s\S]*?\n\}\n/,
  archiveDocumentTitle: /function archiveDocumentTitle\(docType, meta\) \{[\s\S]*?\n\}\n/,
  withDocumentTitle: /function withDocumentTitle\(html, title\) \{[\s\S]*?\n\}\n/,
  salesTotals: /function salesTotals\(\) \{[\s\S]*?\n\}\n/,
  voucherPdfMarkup: /function voucherPdfMarkup\(v\) \{[\s\S]*?\n\}\n/
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
  formatMoney: (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  roundPrice: (value) => Math.round(Number(value || 0) * 1000) / 1000,
  toNumber: (value) => {
    const n = Number(String(value == null ? "" : value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  },
  balanceText: (bal, cur) => `${Math.abs(Number(bal || 0)).toFixed(2)} ${cur}`,
  invoiceLineQty: () => "",
  invoiceLinePrice: () => "",
  REPORT_STYLE: "",
  appConfig: { name: "OZK", supportEmail: "x@y.z" },
  todayIsoDate: () => "2026-08-31"
};
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);
const {
  sanitizeDocumentTitle, fileDateLabel, archiveDocumentTitle, withDocumentTitle,
  salesTotals, voucherPdfMarkup
} = sandbox;

// ===== 1) اسم الملف: الزبون + الرقم =====

test("normal invoice filename includes customer + invoice number", () => {
  const meta = { party: "حسن عباس", number: "562", date: "2026-08-31" };
  const title = archiveDocumentTitle("invoice", meta);
  assert.equal(title, "فاتورة - حسن عباس - رقم 562 - 31-08-2026");
  assert.ok(title.includes("حسن عباس"), "اسم الزبون مفقود");
  assert.ok(title.includes("562"), "رقم الفاتورة مفقود");
});

test("return invoice filename includes customer + invoice number", () => {
  const title = archiveDocumentTitle("return_invoice", { party: "سامر", number: "44", date: "2026-08-31" });
  assert.equal(title, "فاتورة مرتجع - سامر - رقم 44 - 31-08-2026");
  assert.ok(title.startsWith("فاتورة مرتجع"), "المرتجع يجب أن يبقى مستقلاً عن الفاتورة العادية");
});

test("بلا تاريخ موثوق: الاسم يبقى صحيحاً بلا حشو", () => {
  assert.equal(archiveDocumentTitle("invoice", { party: "حسن عباس", number: "562" }),
    "فاتورة - حسن عباس - رقم 562");
  assert.equal(fileDateLabel("غير صالح"), "");
  assert.equal(fileDateLabel("2026-08-31"), "31-08-2026");
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
  assert.equal(sanitizeDocumentTitle("حسن‏  عباس"), "حسن عباس");
});

test("عنوان المستند يُفرض فعلياً داخل HTML المطبوع (وهو ما يقرأه كروم)", () => {
  const doc = "<!doctype html><html><head><meta charset=\"utf-8\"><title>فاتورة مبيعات 562</title></head><body>x</body></html>";
  const out = withDocumentTitle(doc, "فاتورة - حسن عباس - رقم 562 - 31-08-2026");
  assert.ok(out.includes("<title>فاتورة - حسن عباس - رقم 562 - 31-08-2026</title>"));
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

  assert.match(appJs, /const manualArchiveMeta = \{ party: customer, number: invNum, date: todayIsoDate\(\) \};/);
  assert.match(appJs, /title: archiveDocumentTitle\("invoice", manualArchiveMeta\)/);
  assert.match(appJs, /archive: \{ docType: "invoice", meta: manualArchiveMeta \}/);

  // ملف التنزيل المباشر لفاتورة المبيعات يستعمل نفس الكائن أيضاً.
  assert.match(appJs, /const fileName = `\$\{archiveDocumentTitle\("invoice", pdfArchiveMeta\)\}\.pdf`;/);
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
  assert.ok(/0\.50/.test(html), "قيمة الحسم 0.50 غير مطبوعة");
  assert.ok(/50\.00/.test(html), "قيمة الدفعة 50 غير مطبوعة");
  // ولا يجوز أن يُطبع 50 في سطر الحسم.
  const discountRow = html.match(/<th>الحسم<\/th><td[^>]*>[^<]*/)[0];
  assert.ok(discountRow.includes("0.50"), `سطر الحسم يحمل قيمة خاطئة: ${discountRow}`);
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
  assert.ok(!/<th>حسم<\/th>/.test(appJs.match(/function voucherPdfMarkup\(v\)[\s\S]*?\n\}\n/)[0]),
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

// ===== النتيجة =====

console.log("فحص سلامة مستند الفاتورة (اسم الملف + الفصل المحاسبي):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص مستند الفاتورة نجحت.");
