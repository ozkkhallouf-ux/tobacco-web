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
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  voucherPdfMarkup: /function voucherPdfMarkup\(v\) \{[\s\S]*?\n\}\n/,
  invoicePriceBasis: /function invoicePriceBasis\(inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineTotalValue: /function invoiceLineTotalValue\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineValueText: /function invoiceLineValueText\(line, inv\) \{[\s\S]*?\n\}\n/,
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
vm.runInContext(source.join("\n"), sandbox);
const {
  sanitizeDocumentTitle, fileDateLabel, archiveDocumentTitle, withDocumentTitle,
  salesTotals, voucherPdfMarkup, invoiceLineTotalValue, invoiceLineQty, invoiceLinePrice
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

  // مسار الفاتورة اليدوية (printInvoice/manualArchiveMeta) حُذف من main في
  // cb4fa65: كان route غير مسجَّل في خريطة pages فيكسر render() صامتاً، ومعه
  // حارس check-keyboard-shortcut-routes.mjs يمنع عودته. أرشفته كانت على كود
  // لا يُستدعى أبداً، فسقط التوقّع معه — ولا يجوز إعادته لمجرد إبقاء الفحص.
  assert.ok(!/function printInvoice\(/.test(appJs), "عاد مسار الفاتورة الميت الذي حذفه main");
  assert.ok(!/manualArchiveMeta/.test(appJs), "بقي أثر من مسار الفاتورة الميت");

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
  assert.ok(/0\.5/.test(html), "قيمة الحسم 0.5 غير مطبوعة");
  assert.ok(/\b50\b/.test(html), "قيمة الدفعة 50 غير مطبوعة");
  // ولا يجوز أن يُطبع 50 في سطر الحسم.
  const discountRow = html.match(/<th>الحسم<\/th><td[^>]*>[^<]*/)[0];
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
  const discountRow = html.match(/<th>الحسم<\/th><td[^>]*>[^<]*/)[0];
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
const invOf = (lines) => ({ total: lines.reduce((s, l) => s + l.lineTotal, 0), lines });

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
  assert.ok(html.includes("0.5 كرتونة"), "الكمية غير مطبوعة بالوحدة الكبرى");
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
