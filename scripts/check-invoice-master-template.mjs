// ============================================================================
// الحارس الذهبي لقالب الفاتورة الرئيسي (OZK MASTER INVOICE TEMPLATE).
//
// المرجع البصري المعتمد: فاتورة «لؤي خلوف المحترم - الضاحية» رقم 634.
// هذا الفحص يثبّت المواصفة البصرية والبنيوية لذلك المرجع كي لا ينزلق القالب
// بتعديل لاحق. يشغّل الكود الحقيقي من `src/documents/invoice/ozk-invoice.js`
// و`src/app.js` داخل vm — لا مطابقة نصية على المصدر ولا نسخة مبسّطة منه.
//
// ما يحرسه:
//   · الشعار ووجوده وارتفاعه 46px
//   · Tahoma وليس Noto
//   · لوحة ألوان الفاتورة كاملة (ذهبي/كريمي/zebra/حدود/أحمر/أخضر)
//   · الختم الكحلي #16357a بحدوده ودورانه وشفافيته ونصّه
//   · أعمدة جدول الأصناف الأربعة بترتيبها ونسبها 37/26/20/17
//   · النص القانوني ورقم السجل ومصدرهما الواحد
//   · التذييل المرجعي
//   · بنية الدفتر وفصل الحسم عن دفعة الزبون فصلاً تاماً
//   · الفصل المعماري: الفاتورة لا تستعمل قالب التقارير
//   · عزل الاتجاه (BiDi) للتاريخ وللكمية ولسعر الوحدة
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
const invoiceJs = readFileSync(new URL("../src/documents/invoice/ozk-invoice.js", import.meta.url), "utf8");

// ===== استخراج الكود الحقيقي =====

const PATTERNS = {
  SALES_TRADE_CONSTS: /const SALES_TRADE_REGISTER_NO = [^\n]*\nconst SALES_TRADE_CAPACITY = [^\n]*\n/,
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  formatInvoiceMoney: /function formatInvoiceMoney\(value\) \{[\s\S]*?\n\}\n/,
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
  movementsReportCovers: /function movementsReportCovers\(dateStr\) \{[\s\S]*?\n\}\n/,
  invoiceLineUnitPrice: /function invoiceLineUnitPrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  invoiceLinePrice: /function invoiceLinePrice\(line, inv\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRows: /function voucherLedgerRows\(v\) \{[\s\S]*?\n\}\n/,
  voucherInvoiceBalanceRows: /function voucherInvoiceBalanceRows\(rows, v, cur, balCur, isRet\) \{[\s\S]*?\n\}\n/,
  voucherSingleBalanceRows: /function voucherSingleBalanceRows\(rows, v, cur, balCur, isInv, isRet, balLabel\) \{[\s\S]*?\n\}\n/,
  voucherAccountBalanceRow: /function voucherAccountBalanceRow\(rows, v, balCur\) \{[\s\S]*?\n\}\n/,
  voucherLedgerRowHtml: /function voucherLedgerRowHtml\(row\) \{[\s\S]*?\n\}\n/,
  RETURN_NOTE_UNPROVEN: /const RETURN_NOTE_UNPROVEN = [^\n]*\n/,
  returnLedgerView: /function returnLedgerView\(v\) \{[\s\S]*?\n\}\n/,
  saleInvoiceDocument: /function saleInvoiceDocument\(v\) \{[\s\S]*?\n\}\n/,
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

const escapeHtml = (value) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const sandbox = {
  console,
  state: {},
  escapeHtml,
  toNumber: (value) => {
    const n = Number(String(value == null ? "" : value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  },
  balanceText: (bal, cur) => {
    const n = Number(bal || 0);
    if (Math.abs(n) < 0.005) return "مسدّد (صفر)";
    return `${Math.abs(n).toFixed(2)} ${cur} ${n > 0 ? "(عليكم)" : "(لكم)"}`;
  },
  shortDateTime: () => "2026-09-05 10:00",
  docNumber: (prefix) => `${prefix}-0001`,
  REPORT_STYLE: "<style>/* report */</style>",
  todayIsoDate: () => "2026-09-05"
};
vm.createContext(sandbox);
// وحدة الفاتورة أولاً: هي مصدر التنسيق والختم والأنواع.
vm.runInContext(invoiceJs, sandbox);
vm.runInContext(source.join("\n"), sandbox);

// `const` في أعلى سكربت vm لا يصبح خاصية على كائن السياق، فنقرؤه بتقييم اسمه.
const OZK_INVOICE = vm.runInContext("OZK_INVOICE", sandbox);
const { voucherPdfMarkup, voucherLedgerRows, saleInvoiceDocument, invoiceLineQtyParts, invoiceLineQty, movementsReportCovers } = sandbox;
// المصفوفات العائدة من vm تحمل نموذجاً أوّلياً من عالَم آخر، فـdeepEqual الصارم
// يرفضها رغم تطابق المحتوى. ننسخها إلى مصفوفات هذا العالَم قبل المقارنة.
const own = (value) => JSON.parse(JSON.stringify(value));

// ===== fixtures =====

const LINES = [
  { material: "معسل فاخر اسود حرة كف", qty: 2, unit: "كرتونة", price: 170, unit2Factor: 24 },
  { material: "فحم ايكو نارة احمر", qty: 5, unit: "كرتونة", price: 33, unit2Factor: 16 }
];

const base = (extra = {}) => ({
  type: "invoice",
  no: "634",
  date: "2026-09-05",
  name: "لؤي خلوف المحترم - الضاحية",
  phone: "0985000771",
  cur: "$",
  balanceCur: "$",
  amount: 505,
  prevBalance: 1000,
  newBalance: 1505,
  lines: LINES,
  ...extra
});

const html = (extra) => voucherPdfMarkup(base(extra));
const reference = html();

// ===== 1) الهوية البصرية للمرجع =====

test("الشعار موجود بمساره المعتمد", () => {
  assert.ok(reference.includes('src="public/icons/ozk-logo.png"'), "مسار الشعار مفقود");
  assert.ok(reference.includes('class="rlogo"'), "صنف الشعار مفقود");
});

test("ارتفاع الشعار 46px", () => {
  assert.ok(/\.ozk-inv \.rlogo\{height:46px/.test(OZK_INVOICE.STYLE), "ارتفاع الشعار ليس 46px");
});

test("الخط Tahoma وليس Noto", () => {
  assert.ok(/font-family:Tahoma,Arial,sans-serif/.test(OZK_INVOICE.STYLE), "Tahoma مفقود");
  assert.ok(!/Noto/i.test(OZK_INVOICE.STYLE), "Noto ممنوع في الفواتير");
  assert.ok(!/Noto/i.test(reference), "Noto ممنوع في مخرجات الفاتورة");
});

test("لوحة ألوان الفاتورة كاملة كما في المرجع", () => {
  const required = {
    "#b8892a": "الذهبي",
    "#f6ead0": "صندوق الطرف",
    "#ece6d4": "رأس الجدول",
    "#faf6ec": "zebra",
    "#c8b890": "الحدود",
    "#221808": "الحبر",
    "#6b5535": "النص الثانوي",
    "#c0271f": "الأحمر",
    "#16794f": "الأخضر"
  };
  for (const [hex, label] of Object.entries(required)) {
    assert.ok(OZK_INVOICE.STYLE.includes(hex), `${label} ${hex} مفقود من تنسيق الفاتورة`);
  }
});

test("الخط الذهبي تحت الترويسة 2px", () => {
  assert.ok(/border-bottom:2px solid #b8892a/.test(OZK_INVOICE.STYLE), "الخط الذهبي 2px مفقود");
});

// ===== 2) الختم =====

test("الختم كحلي #16357a ولا يخضع لأي حارس NO BLUE", () => {
  assert.equal(OZK_INVOICE.SEAL_COLOR, "#16357a");
  assert.ok(/\.ozk-inv \.seal\{[^}]*border:2\.5px solid #16357a/.test(OZK_INVOICE.STYLE), "حد الختم تغيّر");
  assert.ok(/outline:1\.5px solid #16357a/.test(OZK_INVOICE.STYLE), "outline الختم تغيّر");
  assert.ok(/transform:rotate\(-5deg\)/.test(OZK_INVOICE.STYLE), "دوران الختم تغيّر");
  assert.ok(/opacity:\.9/.test(OZK_INVOICE.STYLE), "شفافية الختم تغيّرت");
  assert.ok(/justify-content:flex-start/.test(OZK_INVOICE.STYLE), "محاذاة الختم تغيّرت");
});

test("نص الختم كما في المرجع", () => {
  for (const line of ["مركز أبو زياد", "لتجارة الدخان", "OZK TOBACCO", "دوما - ساحة الغنم"]) {
    assert.ok(OZK_INVOICE.SEAL.includes(line), `سطر الختم «${line}» مفقود`);
  }
  assert.ok(reference.includes('class="seal"'), "الختم غائب عن الفاتورة");
});

// ===== 3) عقد جدول الأصناف =====

test("الأعمدة الأربعة بترتيبها المعتمد", () => {
  assert.deepEqual(own(OZK_INVOICE.COLUMN_HEADS), ["المادة", "الكمية", "سعر الوحدة", "قيمة السطر"]);
  const heads = [...reference.matchAll(/<th>([^<]+)<\/th>/g)].map((m) => m[1]).slice(0, 4);
  assert.deepEqual(heads, ["المادة", "الكمية", "سعر الوحدة", "قيمة السطر"], "ترتيب الأعمدة تغيّر");
});

test("نسب الأعمدة 37 / 26 / 20 / 17", () => {
  assert.deepEqual(own(OZK_INVOICE.COLUMN_WIDTHS), ["37%", "26%", "20%", "17%"]);
  const widths = [...reference.matchAll(/<col style="width:([\d.]+%)">/g)].map((m) => m[1]);
  assert.deepEqual(widths, ["37%", "26%", "20%", "17%"], "نسب الأعمدة تغيّرت");
  const sum = widths.reduce((total, w) => total + parseFloat(w), 0);
  assert.equal(sum, 100, "مجموع النسب ليس 100%");
});

test("رأس الجدول كريمي لا ذهبي، بمحاذاة يمين وحد كامل", () => {
  assert.ok(/\.ozk-inv th\{background:#ece6d4/.test(OZK_INVOICE.STYLE), "رأس الجدول ليس كريمياً");
  assert.ok(/\.ozk-inv th\{[^}]*text-align:right/.test(OZK_INVOICE.STYLE), "محاذاة الرأس ليست يميناً");
  assert.ok(/\.ozk-inv th\{[^}]*border:1px solid #c8b890/.test(OZK_INVOICE.STYLE), "حد الرأس مفقود");
  assert.ok(/\.ozk-inv td\{[^}]*border:1px solid #c8b890/.test(OZK_INVOICE.STYLE), "حد الخلايا مفقود");
});

test("zebra وتكرار الرأس وعدم انقسام الصف بين صفحتين", () => {
  assert.ok(/tr:nth-child\(even\) td\{background:#faf6ec\}/.test(OZK_INVOICE.STYLE), "zebra مفقود");
  assert.ok(/\.ozk-inv thead\{display:table-header-group\}/.test(OZK_INVOICE.STYLE), "تكرار الرأس مفقود");
  assert.ok(/\.ozk-inv tr\{page-break-inside:avoid\}/.test(OZK_INVOICE.STYLE), "الصف قد ينقسم بين صفحتين");
});

// ===== 4) النص القانوني والتذييل =====

test("النص القانوني ورقم السجل من مصدر واحد في app.js", () => {
  assert.ok(reference.includes("صفة البيع: من تاجر جملة الجملة إلى تاجر جملة ومفرق"), "صفة البيع مفقودة");
  assert.ok(reference.includes("0310109105"), "رقم السجل مفقود");
  assert.ok(/السجل التجاري: <span dir="ltr">0310109105<\/span>/.test(reference), "رقم السجل بلا عزل اتجاه");
  // مصدر الحقيقة الوحيد: القيمتان مُعرَّفتان مرة واحدة في app.js ولا تتكرّران
  // كنصّ حرفي داخل وحدة الفاتورة.
  assert.ok(!invoiceJs.includes("0310109105"), "رقم السجل مكرّر داخل وحدة الفاتورة");
  assert.ok(!invoiceJs.includes("من تاجر جملة الجملة"), "صفة البيع مكرّرة داخل وحدة الفاتورة");
});

test("التذييل المرجعي كامل", () => {
  // «OZK TOBACCO» معزول اتجاهياً (تداخل الكلمتين في PDF الهاتف)؛ يحرسه check-invoice-brand-isolation.mjs.
  assert.ok(reference.includes("صادر آليًا عن نظام<span> </span><bdi>OZK TOBACCO</bdi> · "), "سطر التذييل مفقود أو بلا عزل");
  assert.ok(reference.includes("رقم المركز: 0994092038"), "رقم المركز مفقود");
  assert.ok(/<span dir="ltr">0985000771 — 0984000662<\/span>/.test(reference), "هواتف التذييل مفقودة أو بلا عزل");
});

// ===== 5) الفصل المعماري =====

test("الفاتورة لا تستعمل قالب التقارير", () => {
  assert.ok(!reference.includes("ozk-rpt"), "الفاتورة ما زالت على صنف التقرير");
  assert.ok(!reference.includes("/* report */"), "الفاتورة ما زالت تحقن REPORT_STYLE");
  assert.ok(reference.includes('<div class="ozk-inv">'), "جذر الفاتورة مفقود");
});

test("وحدة الفاتورة سكربت عام بلا import/export (لا build step في المشروع)", () => {
  assert.ok(!/^\s*(import|export)\s/m.test(invoiceJs), "الوحدة تستعمل ESM وهذا لا يُحمَّل في هذا المشروع");
});

test("الأنواع الأربعة معرّفة بهويتها", () => {
  assert.deepEqual(own(Object.keys(OZK_INVOICE.KINDS)), ["invoice", "return", "purchase", "purchase_return"]);
  assert.equal(OZK_INVOICE.KINDS.invoice.amountColor, "#c0271f");
  assert.equal(OZK_INVOICE.KINDS.return.amountColor, "#16794f");
  assert.equal(OZK_INVOICE.KINDS.purchase.amountColor, "#c0271f");
  assert.equal(OZK_INVOICE.KINDS.purchase_return.amountColor, "#16794f");
  assert.equal(OZK_INVOICE.KINDS.invoice.prefix, "INV");
  assert.equal(OZK_INVOICE.KINDS.return.prefix, "RET");
  assert.equal(OZK_INVOICE.KINDS.purchase.prefix, "PO");
  assert.equal(OZK_INVOICE.KINDS.purchase_return.prefix, "PRET");
  assert.equal(OZK_INVOICE.KINDS.invoice.legal, true);
  assert.equal(OZK_INVOICE.KINDS.return.legal, true);
  for (const kind of Object.values(OZK_INVOICE.KINDS)) assert.equal(kind.seal, true, "كل الأنواع تحمل الختم");
});

// ===== 6) بنية الدفتر والفصل المحاسبي =====

test("بنية الدفتر المرجعية بترتيبها", () => {
  const labels = own(voucherLedgerRows(base()).map((r) => r.label));
  assert.deepEqual(labels, ["التاريخ", "الرصيد السابق", "قيمة هذه الفاتورة", "الرصيد الجديد"]);
});

test("الحسم ودفعة الزبون سطران منفصلان لا يختلطان", () => {
  const rows = voucherLedgerRows(base({ discount: 25, payment: 100, newBalance: 1380 }));
  const labels = rows.map((r) => r.label);
  assert.ok(labels.includes("الحسم"), "سطر الحسم مفقود");
  assert.ok(labels.includes("دفعة من الزبون"), "سطر دفعة الزبون مفقود");
  assert.equal(labels.filter((l) => l === "الحسم").length, 1, "الحسم تكرّر");
  const payRow = rows.find((r) => r.label === "دفعة من الزبون");
  assert.ok(!/حسم/.test(payRow.label), "دفعة الزبون طُبعت باسم حسم");
  const out = voucherPdfMarkup(base({ discount: 25, payment: 100, newBalance: 1380 }));
  assert.ok(out.includes("<th>الحسم</th>"), "الحسم غائب عن المستند");
  assert.ok(out.includes("<th>دفعة من الزبون</th>"), "دفعة الزبون غائبة عن المستند");
});

test("الحسم وحده لا يستدعي سطر دفعة", () => {
  const labels = voucherLedgerRows(base({ discount: 25, newBalance: 1480 })).map((r) => r.label);
  assert.ok(labels.includes("الحسم"));
  assert.ok(!labels.includes("دفعة من الزبون"), "سطر دفعة ظهر بلا دفعة");
});

test("الدفعة وحدها لا تُسمّى حسماً", () => {
  const labels = voucherLedgerRows(base({ payment: 100, newBalance: 1405 })).map((r) => r.label);
  assert.ok(labels.includes("دفعة من الزبون"));
  assert.ok(!labels.includes("الحسم"), "دفعة طُبعت كحسم");
});

test("التسوية غير المنسوبة لا تُسمّى حسماً", () => {
  const labels = voucherLedgerRows(base({ adjust: 40, newBalance: 1465 })).map((r) => r.label);
  assert.ok(labels.includes("تسوية على الحساب"), "سطر التسوية مفقود");
  assert.ok(!labels.includes("الحسم"), "التسوية طُبعت كحسم");
});

test("نصوص الرصيد: عليكم / لكم / مسدّد (صفر)", () => {
  assert.ok(voucherPdfMarkup(base({ newBalance: 1505 })).includes("(عليكم)"), "رصيد موجب");
  assert.ok(voucherPdfMarkup(base({ newBalance: -220 })).includes("(لكم)"), "رصيد سالب");
  assert.ok(voucherPdfMarkup(base({ newBalance: 0 })).includes("مسدّد (صفر)"), "رصيد صفر");
});

test("عملة الرصيد مستقلة عن عملة الفاتورة", () => {
  const out = voucherPdfMarkup(base({ cur: "ل.س", balanceCur: "$", amount: 7000000 }));
  assert.ok(/الرصيد الجديد<\/th><td><b><bdi>[^<]*\$/.test(out), "عملة الرصيد تبعت عملة الفاتورة");
});

// ===== 7) عزل الاتجاه (BiDi) =====

test("تاريخ الترويسة معزول فلا ينقلب", () => {
  assert.ok(/<span dir="ltr">2026-09-05<\/span>/.test(reference), "تاريخ الترويسة بلا عزل");
  assert.ok(!/05-09-2026/.test(reference), "التاريخ مقلوب");
});

test("سطر التاريخ في الدفتر معزول أيضاً", () => {
  assert.ok(/<th style="width:130px">التاريخ<\/th><td><span dir="ltr">2026-09-05<\/span><\/td>/.test(reference),
    "سطر التاريخ في الدفتر بلا عزل");
});

test("خلايا سعر الوحدة وقيمة السطر معزولة بـbdi، والكمية مركَّبة بالتخطيط", () => {
  const body = reference.slice(reference.indexOf("<tbody>"), reference.indexOf("</tbody>"));
  const cells = [...body.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1]);
  // أربع خلايا لكل سطر: الأولى (المادة) عربية خالصة بلا عزل، والأخيرتان معزولتان.
  // أما الكمية فلا تُعزَل بـbdi عمداً: العزل يترك التركيب البصري لخوارزمية
  // BiDi، وهي التي انقلبت على WebKit. الكمية تُركَّب بمجموعات flex فيصير
  // ترتيبها قراراً تخطيطياً لا يختلف بين المحرّكات.
  assert.equal(cells.length % 4, 0, "عدد الخلايا لا يطابق أربعة أعمدة");
  for (let i = 0; i < cells.length; i += 4) {
    assert.ok(!cells[i].startsWith("<bdi>"), "عمود المادة لا يحتاج عزلاً");
    assert.ok(/^<span class="qty">[\s\S]*<\/span>$/.test(cells[i + 1]),
      `خلية الكمية ${i + 1} لم تعد مجموعات تخطيطية`);
    assert.ok(!/<bdi>/.test(cells[i + 1]),
      `خلية الكمية ${i + 1} عادت تعتمد عزل BiDi في تركيبها البصري`);
    for (const offset of [2, 3]) {
      assert.ok(/^<bdi>[\s\S]*<\/bdi>$/.test(cells[i + offset]),
        `الخلية ${i + offset} بلا عزل اتجاه`);
    }
  }
});

test("مسافات NBSP لم تعد تُطبَّق عمياً على كل مسافة عربية", () => {
  const block = appJs.match(/const textWalker = document\.createTreeWalker\(source, NodeFilter\.SHOW_TEXT\);[\s\S]*?textNode = textWalker\.nextNode\(\);\n  \}/);
  assert.ok(block, "لم أجد كتلة معالجة المسافات");
  assert.ok(!/replace\(\/ \/g, "\\u00a0"\)/.test(block[0]), "الاستبدال الأعمى ما زال قائماً");
  // إعادة تنفيذ التعبير نفسه للتأكد أنه يحمي «عربي↔عربي» و«رقم↔عربي» فقط.
  const fix = (text) => text.replace(
    /([\u0600-\u06ff]) (?=[\u0600-\u06ff0-9\u0660-\u0669])|([0-9\u0660-\u0669]) (?=[\u0600-\u06ff])/g,
    (match, arabicBefore, digitBefore) => `${arabicBefore || digitBefore}\u00a0`
  );
  assert.equal(fix("رقم 1"), "رقم\u00a01", "المسافة بين كلمة عربية ورقم لم تُحمَ");
  assert.equal(fix("2 كرتونة (100 كروز)"), "2\u00a0كرتونة (100\u00a0كروز)", "مسافة القوس تجمّدت");
  assert.equal(fix("$ 250 / كرتونة"), "$ 250 / كرتونة", "مسافات سعر الوحدة تغيّرت");
});

// ===== 8) fixtures متنوعة =====

test("فاتورة بعملة الدولار", () => {
  const out = voucherPdfMarkup(base({ cur: "$" }));
  assert.ok(out.includes("$"), "رمز الدولار مفقود");
});

test("فاتورة بعملة الليرة", () => {
  const out = voucherPdfMarkup(base({ cur: "ل.س", amount: 7100000 }));
  assert.ok(out.includes("ل.س"), "وسم الليرة مفقود");
});

test("فاتورة بسطر واحد وأخرى متعددة الأسطر تبقيان على نفس البنية", () => {
  const one = voucherPdfMarkup(base({ lines: [LINES[0]], amount: 340 }));
  const many = voucherPdfMarkup(base({ lines: Array.from({ length: 40 }, () => LINES[0]), amount: 13600 }));
  for (const out of [one, many]) {
    assert.ok(out.includes('<table class="items-table">'), "جدول الأصناف مفقود");
    assert.ok(out.includes("<col style=\"width:37%\">"), "نسب الأعمدة مفقودة");
    assert.ok(out.includes('class="seal"'), "الختم مفقود");
    assert.ok(out.includes("صفة البيع"), "النص القانوني مفقود");
  }
  assert.equal((many.match(/<thead>/g) || []).length, 1, "رأس الجدول تكرّر في المصدر");
});

test("فاتورة بلا أسطر لا تطبع جدول أصناف فارغاً", () => {
  const out = voucherPdfMarkup(base({ lines: [] }));
  assert.ok(!out.includes('<table class="items-table">'), "طُبع جدول أصناف فارغ");
  assert.ok(out.includes('<div class="ozk-inv">'), "المستند نفسه مفقود");
});

test("الكمية المختلطة الاتجاه تصل كما تنتجها الدالة القائمة", () => {
  const doc = saleInvoiceDocument(base());
  assert.ok(doc.lines.length === 2, "عدد الأسطر تغيّر");
  for (const line of doc.lines) {
    assert.ok(typeof line.qtyText === "string" && line.qtyText.length > 0, "نص الكمية فارغ");
    assert.ok(typeof line.priceText === "string", "نص سعر الوحدة مفقود");
    assert.ok(typeof line.valueText === "string", "نص قيمة السطر مفقود");
  }
});

test("سندا القبض والصرف ما زالا على المسار القديم، والمرتجع على القالب الرئيسي (المرحلة 2)", () => {
  for (const type of ["receipt", "payment"]) {
    const out = voucherPdfMarkup(base({ type, newBalance: 100, balance: 100 }));
    assert.ok(out.includes("ozk-rpt") && !out.includes("ozk-inv"), `${type} خرج عن المسار القديم قبل مرحلته`);
  }
  const ret = voucherPdfMarkup(base({ type: "return", newBalance: 100, balance: 100 }));
  assert.ok(ret.includes("ozk-inv") && !ret.includes("ozk-rpt"), "مرتجع المبيعات لم يصل إلى القالب الرئيسي");
  // التفاصيل الكاملة للمرتجع في check-sales-return-master-invoice.mjs.
});

// ===== دلالات التسوية: ثلاث حالات صريحة =====
//
// غياب قيد الذمم لفاتورة له تفسيران لا يميّزهما الغياب وحده. الفاتورة 2046
// («ابو ياسر برغوت سوري»، 129.673 $) ثبت بفحص الأمين أنها مقيَّدة على صندوق
// مبيعات المركز لا على ذمة الزبون — ورصيد حسابه بقي −1.15 قبلها وبعدها.
// كان القالب يطبع تحتها سطراً وحيداً «الرصيد الحالي 1.15 $ (لكم)» فيُقرأ
// كأنه ناتج الفاتورة. هذه الفحوص تثبّت الحالات الثلاث.

const LEDGER_LABELS = (v) => own(voucherLedgerRows(v)).map((r) => r.label);

test("حالة 1: فاتورة ذمم موثقة — أسطر الدفتر كما هي بلا تغيير", () => {
  const labels = LEDGER_LABELS(base({ prevBalance: 1000, newBalance: 1380, discount: 25, payment: 100 }));
  assert.deepEqual(labels, [
    "التاريخ", "الرصيد السابق", "قيمة هذه الفاتورة", "الحسم", "دفعة من الزبون", "الرصيد الجديد"
  ], "ترتيب أسطر فاتورة الذمم تغيّر");
});

test("حالة 2: فاتورة غير منعكسة على الذمة — لا رصيد سابق ولا جديد", () => {
  const rows = own(voucherLedgerRows({
    type: "invoice", date: "2026-09-21", cur: "$", balanceCur: "$",
    amount: 129.673, accountBalance: -1.15, accountBalanceAt: "2026-09-21T13:47:10Z"
  }));
  const labels = rows.map((r) => r.label);
  assert.deepEqual(labels, ["التاريخ", "رصيد الحساب الحالي"], "أسطر الحالة 2 ليست كما يجب");
  for (const forbidden of ["الرصيد السابق", "الرصيد الجديد", "قيمة هذه الفاتورة", "الرصيد الحالي"]) {
    assert.ok(!labels.includes(forbidden), `سطر «${forbidden}» ظهر على فاتورة لا تحرّك الذمة`);
  }
});

test("حالة 2: رصيد الحساب موسوم صراحةً بأنه مستقل عن الفاتورة", () => {
  const rows = own(voucherLedgerRows({
    type: "invoice", date: "2026-09-21", cur: "$", balanceCur: "$",
    amount: 129.673, accountBalance: -1.15, accountBalanceAt: "2026-09-21T13:47:10Z"
  }));
  const row = rows.find((r) => r.label === "رصيد الحساب الحالي");
  assert.ok(row, "سطر رصيد الحساب مفقود");
  assert.ok(/مستقل عن هذه الفاتورة/.test(row.suffixHtml || ""), "الوسم الصريح غائب — الرقم يُقرأ كناتج الفاتورة");
  assert.ok(!/نقد/.test(row.suffixHtml || ""), "لا يجوز استنتاج أسلوب التسوية من غياب قيد الذمم");
});

test("حالة 2: قيمة الرصيد نفسها لم تتغيّر (1.15 لكم)", () => {
  const rows = own(voucherLedgerRows({
    type: "invoice", date: "2026-09-21", cur: "$", balanceCur: "$",
    amount: 129.673, accountBalance: -1.15
  }));
  const row = rows.find((r) => r.label === "رصيد الحساب الحالي");
  assert.ok(/1\.15/.test(row.value) && /\(لكم\)/.test(row.value), `قيمة الرصيد تغيّرت: ${row.value}`);
});

test("حالة 3: دلالة التسوية غير محسومة — لا سطر رصيد إطلاقاً (fail closed)", () => {
  const labels = LEDGER_LABELS({ type: "invoice", date: "2026-09-21", cur: "$", balanceCur: "$", amount: 129.673 });
  assert.deepEqual(labels, ["التاريخ"], "طُبع سطر رصيد رغم أن الدلالة غير محسومة");
});

test("تغطية دفتر الحركات: محمَّل ويغطّي ⇒ نعم، غائب أو خارج النافذة ⇒ لا", () => {
  sandbox.state.customerMovementsReport = null;
  assert.equal(movementsReportCovers("2026-09-21"), false, "دفتر غائب اعتُبر مغطّياً");

  sandbox.state.customerMovementsReport = { items: [], summary: { fromDate: "2026-06-21" } };
  assert.equal(movementsReportCovers("2026-09-21"), false, "دفتر فارغ اعتُبر مغطّياً");

  sandbox.state.customerMovementsReport = { items: [{ name: "زبون" }], summary: { fromDate: "2026-06-21" } };
  assert.equal(movementsReportCovers("2026-09-21"), true, "دفتر يغطّي التاريخ اعتُبر غير مغطٍّ");
  assert.equal(movementsReportCovers("2026-05-01"), false, "تاريخ قبل بداية النافذة اعتُبر مغطّى");
  assert.equal(movementsReportCovers(""), false, "تاريخ فارغ اعتُبر مغطّى");
  sandbox.state.customerMovementsReport = null;
});

// ===== خانة الكمية: أجزاء ذرّية بلا أقواس =====

test("أجزاء الكمية مفصولة، والنص المسطّح القديم لم يتغيّر", () => {
  const line = { qty: 6, unit1: "كروز", qtyUnits: 0.12, unit2: "كرتونة" };
  const parts = own(invoiceLineQtyParts(line));
  assert.deepEqual(parts, { value: "0.12", unit: "كرتونة", detailValue: "6", detailUnit: "كروز" });
  assert.equal(invoiceLineQty(line), "0.12 كرتونة (6 كروز)", "النص المسطّح تغيّر — ثلاثة مسارات تعتمده");
});

test("خانة الكمية في القالب: أجزاء ذرّية، بلا أقواس، بالترتيب الصحيح", () => {
  const out = voucherPdfMarkup(base({
    amount: 44.508,
    lines: [{ material: "ماستر طويل ورق", qty: 6, unit1: "كروز", qtyUnits: 0.12, unit2: "كرتونة", price: 7.418, lineTotal: 44.509 }]
  }));
  const body = out.split("<tbody>")[1].split("</tbody>")[0];
  assert.ok(!/[()]/.test(body), "عاد القوسان إلى خانة الكمية — لا ينجوان من محرّك الرسم");
  assert.ok(
    body.includes(
      '<span class="qty">'
      + '<span class="qg">\u200f<span class="qv">0.12</span> <span class="qu">كرتونة</span></span>'
      + '<span class="qg q-det">\u200f<span class="qv">6</span> <span class="qu">كروز</span></span>'
      + '</span>'
    ),
    "خانة الكمية ليست مجموعتين مستقلتين بأجزاء موضوعة هندسياً"
  );
  assert.ok(!/<bdi>/.test(body.split("</td>")[1] || ""), "الكمية عادت تعتمد عزل BiDi");
  assert.ok(body.includes("q-det"), "التوضيح فقد تمييزه البصري الثانوي");
});

test("ترتيب الكمية هندسيّ فيزيائي، لا BiDi ولا flex", () => {
  // صياغتان سابقتان تركتا الترتيب البصري لخوارزمية BiDi (أجزاء داخل <bdi>
  // سطرية، ثم مجموعات flex بـdirection:ltr)، فخرجتا صحيحتين على Chromium
  // ومقلوبتين على WebKit. الآن: كتلة مستقلة لكل مجموعة، وعائم لكل جزء —
  // وموضع العائم فيزيائي لا علاقة له باتجاه الفقرة.
  for (const rule of [/\.ozk-inv \.qty\{[^}]*display:block/, /\.ozk-inv \.qg\{[^}]*display:block/,
                      /\.ozk-inv \.qg \.qv\{[^}]*float:right/, /\.ozk-inv \.qg \.qu\{[^}]*float:right/]) {
    assert.ok(rule.test(invoiceJs), `قاعدة الوضع الهندسي الضامنة للترتيب سقطت: ${rule}`);
  }
  // القاعدتان اللتان شفّرتا العطل: ممنوع عودتهما إلى خانة الكمية.
  for (const banned of [/\.ozk-inv \.qt?[yg][^{]*\{[^}]*display:flex/, /\.ozk-inv \.qt?[yg][^{]*\{[^}]*direction:ltr/]) {
    assert.ok(!banned.test(invoiceJs), `عادت قاعدة تُسلِّم الترتيب لخوارزمية الاتجاه: ${banned}`);
  }
});

test("كمية بلا وحدة كبرى: جزء واحد بلا توضيح", () => {
  const parts = own(invoiceLineQtyParts({ qty: 6, unit1: "كروز" }));
  assert.deepEqual(parts, { value: "6", unit: "كروز", detailValue: "", detailUnit: "" });
  assert.equal(invoiceLineQty({ qty: 6, unit1: "كروز" }), "6 كروز");
});

// ===== النتيجة =====

console.log("\n🧾 حارس قالب الفاتورة الرئيسي (المرجع 634)\n");
console.log(results.join("\n"));
if (failed > 0) {
  console.log(`\n❌ فشل ${failed} فحصاً\n`);
  process.exit(1);
}
console.log(`\n✅ ${results.length} فحصاً ناجحاً\n`);
