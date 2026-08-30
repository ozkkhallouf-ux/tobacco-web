// يتحقق سلوكياً (تنفيذ حقيقي داخل vm، لا مطابقة نصية فقط) من إصلاح هشاشة
// طباعة فاتورة المبيعات: انقطاع مؤقت بجهاز مزامنة ترقيم الفواتير (>15 دقيقة)
// لم يعد يمنع الطباعة/تصدير PDF بالكامل — يسمح بنافذة تسامح أوسع (60 دقيقة)
// بعد تأكيد صريح من الموظف، بينما يبقى الحفظ الفعلي (salesSaveInvoice) بحدّه
// الصارم الأصلي (15 دقيقة) دون أي تغيير — لأنه الموضع الوحيد الذي يحجز رقماً
// فعلياً بقاعدة البيانات.
//
// تصميم v2 (بعد ملاحظة Codex P1 على PR #144 — round 1): لم يعد يُطبع أي رقم
// حقيقي أو تخميني إطلاقاً أثناء التدهور. رقم "تقديري" مطبوع على ورقة تُسلَّم
// للزبون قد يصطدم فعلياً بفاتورة أُدخلت مباشرة بالأمين أو من جهاز آخر خلال
// نافذة الانقطاع — العدّاد المحلي (salesSeqState) لا يكتشف إصداراً خارجياً
// كهذا. الحل: تُطبع مسودة صريحة (SALES_DRAFT_INVOICE_NO) بشارة تحذير مرئية
// داخل المستند نفسه، فيستحيل تكرارها بالتعريف بغضّ النظر عمّا يحدث في مكان
// آخر — صفر احتمال تصادم لا مجرّد تقليله.
//
// يغطي: انقطاع قصير (طبيعي)، تجاوز 15 دقيقة (تدهور مؤقت للطباعة فقط — مسودة
// بلا رقم)، تجاوز 60 دقيقة (حجب كامل كالسابق)، عودة الاتصال (لا حالة عالقة)،
// ومنع تكرار الأرقام (العدّاد المحلي يبقى فعّالاً في الحالة الطبيعية، وحارس
// الحفظ لم يمسّه شيء، ولا رقم حقيقي يُطبع إطلاقاً أثناء التدهور فيستحيل
// تكراره أصلاً)، وحارسان تراجعيان نصّيان: الحفظ لم يُمسّ، والطباعة/PDF/إيصال
// المفرق تستخدم جميعاً نمط المسودة الجديد ولا تستدعي ensureSalesInvoiceNo
// إطلاقاً أثناء التدهور.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

const PATTERNS = {
  normalizeItemName: /function normalizeItemName\(value\) \{[\s\S]*?\n\}\n/,
  salesCurrentMode: /function salesCurrentMode\(\) \{[\s\S]*?\n\}\n/,
  SALES_AMEEN_SERIES: /const SALES_AMEEN_SERIES = \{[\s\S]*?\n\};/,
  salesSeriesTarget: /function salesSeriesTarget\(mode\) \{[\s\S]*?\n\}\n/,
  salesAmeenSeries: /function salesAmeenSeries\(mode\) \{[\s\S]*?\n\}\n/,
  salesSeqState: /function salesSeqState\(mode\) \{[\s\S]*?\n\}\n/,
  peekSalesInvoiceNumber: /function peekSalesInvoiceNumber\(mode\) \{[\s\S]*?\n\}\n/,
  salesReserveInvoiceNo: /function salesReserveInvoiceNo\(no, mode\) \{[\s\S]*?\n\}\n/,
  ensureSalesInvoiceNo: /function ensureSalesInvoiceNo\(\) \{[\s\S]*?\n\}\n/,
  SALES_SERIES_MAX_AGE_MS: /const SALES_SERIES_MAX_AGE_MS = 15 \* 60000;/,
  SALES_PRINT_GRACE_MAX_AGE_MS: /const SALES_PRINT_GRACE_MAX_AGE_MS = 60 \* 60000;/,
  salesSeriesState: /function salesSeriesState\(mode\) \{[\s\S]*?\n\}\n/,
  SALES_DRAFT_INVOICE_NO: /const SALES_DRAFT_INVOICE_NO = "[^"]*";/,
  salesDraftBannerHtml: /function salesDraftBannerHtml\(invNo\) \{[\s\S]*?\n\}\n/,
  salesPrintSeriesState: /function salesPrintSeriesState\(mode\) \{[\s\S]*?\n\}\n/,
  salesSeriesAgeText: /function salesSeriesAgeText\(ageMs\) \{[\s\S]*?\n\}\n/,
  salesSeriesBlockReason: /function salesSeriesBlockReason\(st\) \{[\s\S]*?\n\}\n/,
  salesPrintGraceWarning: /function salesPrintGraceWarning\(printSt\) \{[\s\S]*?\n\}\n/,
};

const extracted = {};
for (const [name, re] of Object.entries(PATTERNS)) {
  const m = appJs.match(re);
  if (!m) {
    console.error(`تعذّر عزل ${name} من app.js — تحقق من تطابق الأنماط (ربما أُعيدت صياغة الدالة).`);
    process.exit(1);
  }
  extracted[name] = m[0];
}

// ملاحظة: إعلانات `const` العلوية (مثل SALES_DRAFT_INVOICE_NO) لا تصبح خواصّ
// على كائن الـcontext في vm — بخلاف إعلانات الدوال، التي تُرفَق فعلاً (وهذا ما
// يجعل sb.peekSalesInvoiceNumber وغيرها متاحة أدناه). فيُضاف Wrapper بسيط
// لكشف قيمة الثابت للاختبارات الخارجية دون تغيير أي سلوك حقيقي.
const sourceBlock = Object.values(extracted).join("\n\n")
  + "\n\nfunction __testGetDraftInvoiceNo() { return SALES_DRAFT_INVOICE_NO; }\n";

function makeSandbox() {
  const store = {};
  const sandbox = {
    state: {
      salesMode: "jumla",
      invoiceSeriesReport: null,
      salesInvoiceNo: "",
      salesInvoiceNoMode: "",
    },
    readJson: (key, fallback) => (key in store ? store[key] : fallback),
    writeJson: (key, value) => {
      store[key] = value;
    },
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(sourceBlock, sandbox, { filename: "sales-invoice-print-grace-extract.js" });
  return sandbox;
}

const JUMLA_GUID = "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4";
const agoIso = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const seriesReport = (minutesAgo, { nextNo = 100, lastNo = 99 } = {}) => ({
  items: [{ typeGuid: JUMLA_GUID, typeName: "مبيعات", nextNo, lastNo }],
  summary: { syncedAt: agoIso(minutesAgo) },
});

let failed = false;
function check(label, condition) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failed = true;
  }
}

// ── 1) طبيعي (≤15 دقيقة) — سلوك اليوم بلا أي تغيير ──────────────────────────
{
  const sb = makeSandbox();
  sb.state.invoiceSeriesReport = seriesReport(5);
  const save = sb.salesSeriesState("jumla");
  const print = sb.salesPrintSeriesState("jumla");
  check("1a: الحفظ مسموح عند 5 دقائق", save.usable === true);
  check("1b: الطباعة مسموحة عند 5 دقائق بلا تدهور", print.printUsable === true && print.degraded === false);
  check("1c: peek يُرجع الرقم الحقيقي في الحالة الطبيعية", sb.peekSalesInvoiceNumber("jumla") === "100");
  check("1d: ensureSalesInvoiceNo يُرجع نفس الرقم الحقيقي", sb.ensureSalesInvoiceNo() === "100");
  check("1e: لا شارة تحذير على رقم حقيقي", sb.salesDraftBannerHtml("100") === "");
}

// ── 2) انقطاع قصير تجاوز 15 دقيقة (تدهور — طباعة مسودة بلا رقم فقط) ─────────
{
  const sb = makeSandbox();
  sb.state.invoiceSeriesReport = seriesReport(20);
  const save = sb.salesSeriesState("jumla");
  const print = sb.salesPrintSeriesState("jumla");
  check("2a: الحفظ يبقى محجوباً عند 20 دقيقة (لم يتغيّر الحد الصارم)", save.usable === false);
  check("2b: الطباعة مسموحة عند 20 دقيقة (ضمن نافذة الـ60 دقيقة)", print.printUsable === true);
  check("2c: الطباعة في حالة تدهور تتطلب تأكيداً", print.degraded === true);
  check(
    "2d: peek بلا أي وسيط تسامح يُرجع فارغاً دائماً أثناء التدهور (لا رقم حقيقي أو تخميني إطلاقاً)",
    sb.peekSalesInvoiceNumber("jumla") === "",
  );
  const warning = sb.salesPrintGraceWarning(print);
  check("2e: رسالة التحذير غير فارغة وتذكر أنها مسودة بلا رقم نهائي", typeof warning === "string" && warning.includes("مسودة") && warning.includes("بلا رقم"));
  check("2f: رسالة التحذير لا تصف الرقم بأنه \"تقديري\" (لا يُطبع رقم إطلاقاً)", !warning.includes("تقديري"));
  // محاكاة ما تفعله printSalesInvoice/saveSalesInvoicePdf فعلياً عند التدهور:
  const invNoWhenDegraded = sb.__testGetDraftInvoiceNo();
  const banner = sb.salesDraftBannerHtml(invNoWhenDegraded);
  check("2g: شارة التحذير تظهر على رقم المسودة", typeof banner === "string" && banner.includes("مسودة") && banner.length > 0);
  check("2h: رقم المسودة نفسه ليس رقماً (نص تحذيري واضح)", typeof invNoWhenDegraded === "string" && invNoWhenDegraded.includes("بلا رقم"));
}

// ── 3) انقطاع طويل تجاوز 60 دقيقة (حجب كامل — كالسابق تماماً) ───────────────
{
  const sb = makeSandbox();
  sb.state.invoiceSeriesReport = seriesReport(70);
  const save = sb.salesSeriesState("jumla");
  const print = sb.salesPrintSeriesState("jumla");
  check("3a: الحفظ محجوب عند 70 دقيقة", save.usable === false);
  check("3b: الطباعة أيضاً محجوبة عند 70 دقيقة (تجاوزت نافذة التسامح)", print.printUsable === false);
  check("3c: لا حالة تدهور بعد تجاوز النافذة — حجب كامل مباشرة", print.degraded === false);
  check("3d: peek يُرجع فارغاً بعد تجاوز الـ60 دقيقة أيضاً", sb.peekSalesInvoiceNumber("jumla") === "");
  const reason = sb.salesSeriesBlockReason(print);
  check("3e: رسالة الحجب غير فارغة", typeof reason === "string" && reason.length > 0);
  check(
    "3f: رسالة الحجب مفهومة للموظف — لا تذكر اسم مهمة Windows التقني",
    !reason.includes("TOBACCO Invoice Series Push"),
  );
  check("3g: رسالة الحجب توجّه الموظف لعمل مفهوم (التواصل مع الإدارة)", reason.includes("الإدارة"));
}

// ── 4) لا بيانات سلسلة إطلاقاً (حتى لو الطابع الزمني حديث) — يبقى محجوباً ───
{
  const sb = makeSandbox();
  sb.state.invoiceSeriesReport = { items: [], summary: { syncedAt: agoIso(1) } };
  const print = sb.salesPrintSeriesState("jumla");
  check("4a: لا سلسلة مطابقة = طباعة محجوبة حتى مع طابع زمني حديث", print.printUsable === false);
  check("4b: لا حالة تدهور بلا سلسلة أصلاً", print.degraded === false);
}

// ── 5) عودة الاتصال — لا حالة عالقة، القرار يُحسب من جديد كل مرة ───────────
{
  const sb = makeSandbox();
  sb.state.invoiceSeriesReport = seriesReport(70);
  check("5a: قبل العودة — محجوب", sb.salesPrintSeriesState("jumla").printUsable === false);
  // تصل مزامنة جديدة طازجة (نفس sandbox، لا إعادة تشغيل ولا كاش مخفي)
  sb.state.invoiceSeriesReport = seriesReport(2, { nextNo: 150, lastNo: 149 });
  const afterRecovery = sb.salesPrintSeriesState("jumla");
  check("5b: بعد عودة الاتصال — الطباعة طبيعية فوراً بلا تدهور", afterRecovery.printUsable === true && afterRecovery.degraded === false);
  check("5c: بعد عودة الاتصال — الحفظ طبيعي أيضاً فوراً", sb.salesSeriesState("jumla").usable === true);
  check("5d: الرقم المعروض يعكس السلسلة الجديدة فوراً (رقم حقيقي لا مسودة)", sb.peekSalesInvoiceNumber("jumla") === "150");
}

// ── 6) منع تكرار الأرقام: العدّاد المحلي يبقى فعّالاً في الحالة الطبيعية ────
{
  const sb = makeSandbox();
  // جهاز أصدر سابقاً (بحفظ ناجح فعلي) حتى الرقم 150، لكن قراءة الأمين الحالية
  // (طازجة، ضمن الـ15 دقيقة) تقول أن التالي 100 فقط — العدّاد المحلي يجب أن يفوز.
  sb.writeJson("sales-invoice-seq-jumla", 150);
  sb.state.invoiceSeriesReport = seriesReport(5, { nextNo: 100 });
  const peeked = sb.peekSalesInvoiceNumber("jumla");
  check(
    "6a: العدّاد المحلي (150) يتغلّب على رقم الأمين المتأخر (100) في الحالة الطبيعية",
    peeked === "151",
  );
  check("6b: لا يُعاد أبداً رقم ≤ العدّاد المحلي المحجوز سابقاً", Number(peeked) > 150);
  // وأثناء التدهور (>15 دقيقة) لا يُطبع أي رقم حقيقي إطلاقاً بغضّ النظر عن
  // العدّاد المحلي — فيستحيل تصادمه مع فاتورة خارجية بالتعريف.
  const sb2 = makeSandbox();
  sb2.writeJson("sales-invoice-seq-jumla", 150);
  sb2.state.invoiceSeriesReport = seriesReport(20, { nextNo: 100 });
  check("6c: أثناء التدهور peek يبقى فارغاً حتى مع عدّاد محلي متقدّم", sb2.peekSalesInvoiceNumber("jumla") === "");
}

// ── 7) حارس تراجعي نصّي: مسار الحفظ (salesSaveInvoice) لم يُمسّ إطلاقاً ─────
{
  const saveFn = appJs.match(/async function salesSaveInvoice\(\) \{[\s\S]*?\n\}\n/)?.[0];
  check("7a: تعذّر عزل salesSaveInvoice للتحقق النصي", !!saveFn);
  if (saveFn) {
    check("7b: الحفظ لا يزال يستدعي await refreshInvoiceSeries()", saveFn.includes("await refreshInvoiceSeries()"));
    check("7c: الحفظ لا يزال يفحص salesSeriesState(mode).usable الصارم", saveFn.includes("salesSeriesState(mode)") && saveFn.includes(".usable"));
    check(
      "7d: الحفظ يستدعي peekSalesInvoiceNumber(mode) بلا أي وسيط تسامح",
      /peekSalesInvoiceNumber\(mode\)/.test(saveFn) && !saveFn.includes("allowPrintGrace") && !saveFn.includes("SALES_DRAFT_INVOICE_NO"),
    );
    check("7e: الحجز لا يزال يحدث فقط بعد نجاح createSharedDocument", /createSharedDocument\(doc\);\s*\n\s*\/\/[\s\S]*?salesReserveInvoiceNo\(doc\.no, doc\.mode\);/.test(saveFn));
  }
}

// ── 8) حارس تراجعي نصّي: الطباعة/PDF/إيصال المفرق تستخدم نمط المسودة الجديد ─
{
  const printFn = appJs.match(/function printSalesInvoice\(\) \{[\s\S]*?\n\}\n/)?.[0];
  const pdfFn = appJs.match(/async function saveSalesInvoicePdf\(\) \{[\s\S]*?\n\}\n/)?.[0];
  const markupFn = appJs.match(/function salesInvoicePdfMarkup\(data\) \{[\s\S]*?\n\}\n/)?.[0];
  const receiptFn = appJs.match(/function salesReceiptDocument\(data\) \{[\s\S]*?\n\}\n/)?.[0];
  check("8a: تعذّر عزل printSalesInvoice للتحقق النصي", !!printFn);
  check("8b: تعذّر عزل saveSalesInvoicePdf للتحقق النصي", !!pdfFn);
  check("8c: تعذّر عزل salesInvoicePdfMarkup للتحقق النصي", !!markupFn);
  check("8d: تعذّر عزل salesReceiptDocument للتحقق النصي", !!receiptFn);

  for (const [name, fn] of [["printSalesInvoice", printFn], ["saveSalesInvoicePdf", pdfFn]]) {
    if (!fn) continue;
    check(`8e[${name}]: يستخدم salesPrintSeriesState لا salesSeriesState مباشرة للبوابة`, fn.includes("salesPrintSeriesState(mode)"));
    check(`8f[${name}]: يتحقق من printUsable`, fn.includes(".printUsable"));
    check(`8g[${name}]: يطلب تأكيداً صريحاً عند التدهور فقط`, /if \([a-zA-Z]+\.degraded\)/.test(fn) || /degraded && !confirm\(/.test(fn));
    check(`8h[${name}]: عند التدهور يُسند رقم المسودة صراحة — لا رقماً تخمينياً`, /invNo = SALES_DRAFT_INVOICE_NO/.test(fn));
    check(`8i[${name}]: خارج التدهور فقط يُستدعى ensureSalesInvoiceNo`, /invNo = ensureSalesInvoiceNo\(\);/.test(fn));
  }

  check("8j: قالب PDF يُدرِج شارة التحذير عبر salesDraftBannerHtml(data.invNo)", markupFn.includes("${salesDraftBannerHtml(data.invNo)}"));
  check("8k: قالب إيصال المفرق (80mm) يتحقق من SALES_DRAFT_INVOICE_NO لإظهار شارة تحذيره الخاصة", receiptFn.includes("SALES_DRAFT_INVOICE_NO"));
  check("8l: قالب فاتورة الجملة (A4) يُدرِج شارة التحذير عبر salesDraftBannerHtml(invNo)", printFn.includes("${salesDraftBannerHtml(invNo)}"));
}

if (failed) {
  console.error("Sales invoice print grace-degradation contract FAILED.");
  process.exit(1);
}
console.log("Sales invoice print grace-degradation contract checks passed.");
