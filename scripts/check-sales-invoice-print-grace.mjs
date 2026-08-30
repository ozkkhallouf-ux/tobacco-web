// يتحقق سلوكياً (تنفيذ حقيقي داخل vm، لا مطابقة نصية فقط) من إصلاح هشاشة
// طباعة فاتورة المبيعات: انقطاع مؤقت بجهاز مزامنة ترقيم الفواتير (>15 دقيقة)
// لم يعد يمنع الطباعة/تصدير PDF بالكامل — يسمح بنافذة تسامح أوسع (60 دقيقة)
// بعد تأكيد صريح من الموظف، بينما يبقى الحفظ الفعلي (salesSaveInvoice) بحدّه
// الصارم الأصلي (15 دقيقة) دون أي تغيير — لأنه الموضع الوحيد الذي يحجز رقماً
// فعلياً بقاعدة البيانات.
//
// يغطي: انقطاع قصير (طبيعي)، تجاوز 15 دقيقة (تدهور مؤقت للطباعة فقط)، تجاوز
// 60 دقيقة (حجب كامل كالسابق)، عودة الاتصال (لا حالة عالقة)، ومنع تكرار
// الأرقام (العدّاد المحلي يبقى فعّالاً حتى أثناء التسامح، وحارس الحفظ لم يمسّه
// شيء).

import { readFileSync } from "node:fs";
import vm from "node:vm";

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

const PATTERNS = {
  normalizeItemName: /function normalizeItemName\(value\) \{[\s\S]*?\n\}/,
  salesCurrentMode: /function salesCurrentMode\(\) \{[\s\S]*?\n\}/,
  SALES_AMEEN_SERIES: /const SALES_AMEEN_SERIES = \{[\s\S]*?\n\};/,
  salesSeriesTarget: /function salesSeriesTarget\(mode\) \{[\s\S]*?\n\}/,
  salesAmeenSeries: /function salesAmeenSeries\(mode\) \{[\s\S]*?\n\}/,
  salesSeqState: /function salesSeqState\(mode\) \{[\s\S]*?\n\}/,
  salesReserveInvoiceNo: /function salesReserveInvoiceNo\(no, mode\) \{[\s\S]*?\n\}/,
  peekSalesInvoiceNumber: /function peekSalesInvoiceNumber\(mode, \{ allowPrintGrace = false \} = \{\}\) \{[\s\S]*?\n\}/,
  SALES_SERIES_MAX_AGE_MS: /const SALES_SERIES_MAX_AGE_MS = 15 \* 60000;/,
  SALES_PRINT_GRACE_MAX_AGE_MS: /const SALES_PRINT_GRACE_MAX_AGE_MS = 60 \* 60000;/,
  salesSeriesState: /function salesSeriesState\(mode\) \{[\s\S]*?\n\}/,
  salesPrintSeriesState: /function salesPrintSeriesState\(mode\) \{[\s\S]*?\n\}/,
  salesSeriesAgeText: /function salesSeriesAgeText\(ageMs\) \{[\s\S]*?\n\}/,
  salesSeriesBlockReason: /function salesSeriesBlockReason\(st\) \{[\s\S]*?\n\}/,
  salesPrintGraceWarning: /function salesPrintGraceWarning\(printSt\) \{[\s\S]*?\n\}/,
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

const sourceBlock = Object.values(extracted).join("\n\n");

function makeSandbox() {
  const store = {};
  const sandbox = {
    state: { salesMode: "jumla", invoiceSeriesReport: null },
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
  check("1c: peek بلا grace يُرجع الرقم عادةً", sb.peekSalesInvoiceNumber("jumla") === "100");
  check(
    "1d: peek مع grace يُرجع نفس الرقم (لا فرق وقت الحالة الطبيعية)",
    sb.peekSalesInvoiceNumber("jumla", { allowPrintGrace: true }) === "100",
  );
}

// ── 2) انقطاع قصير تجاوز 15 دقيقة (تدهور — طباعة فقط) ───────────────────────
{
  const sb = makeSandbox();
  sb.state.invoiceSeriesReport = seriesReport(20);
  const save = sb.salesSeriesState("jumla");
  const print = sb.salesPrintSeriesState("jumla");
  check("2a: الحفظ يبقى محجوباً عند 20 دقيقة (لم يتغيّر الحد الصارم)", save.usable === false);
  check("2b: الطباعة مسموحة عند 20 دقيقة (ضمن نافذة الـ60 دقيقة)", print.printUsable === true);
  check("2c: الطباعة في حالة تدهور تتطلب تأكيداً", print.degraded === true);
  check(
    "2d: peek بلا grace يُرجع فارغاً (نفس سلوك الحفظ تماماً)",
    sb.peekSalesInvoiceNumber("jumla") === "",
  );
  check(
    "2e: peek مع grace يُرجع رقماً فعلياً للطباعة",
    sb.peekSalesInvoiceNumber("jumla", { allowPrintGrace: true }) === "100",
  );
  const warning = sb.salesPrintGraceWarning(print);
  check("2f: رسالة التحذير غير فارغة وتذكر أن الرقم تقديري", typeof warning === "string" && warning.includes("تقديري"));
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
  check(
    "3d: peek مع grace يُرجع فارغاً بعد تجاوز الـ60 دقيقة",
    sb.peekSalesInvoiceNumber("jumla", { allowPrintGrace: true }) === "",
  );
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
  check("5d: الرقم المعروض يعكس السلسلة الجديدة فوراً", sb.peekSalesInvoiceNumber("jumla") === "150");
}

// ── 6) منع تكرار الأرقام: العدّاد المحلي يبقى فعّالاً حتى أثناء التسامح ─────
{
  const sb = makeSandbox();
  // جهاز أصدر سابقاً (بحفظ ناجح فعلي) حتى الرقم 150، لكن قراءة الأمين الحالية
  // متأخرة/متدهورة وتقول أن التالي 100 فقط — العدّاد المحلي يجب أن يفوز.
  sb.writeJson("sales-invoice-seq-jumla", 150);
  sb.state.invoiceSeriesReport = seriesReport(20, { nextNo: 100 });
  const peeked = sb.peekSalesInvoiceNumber("jumla", { allowPrintGrace: true });
  check(
    "6a: العدّاد المحلي (150) يتغلّب على رقم الأمين المتأخر (100) حتى في وضع التسامح",
    peeked === "151",
  );
  check("6b: لا يُعاد أبداً رقم ≤ العدّاد المحلي المحجوز سابقاً", Number(peeked) > 150);
}

// ── 7) حارس تراجعي نصّي: مسار الحفظ (salesSaveInvoice) لم يُمسّ إطلاقاً ─────
{
  const saveFn = appJs.match(/async function salesSaveInvoice\(\) \{[\s\S]*?\n\}\n\nfunction /)?.[0];
  check("7a: تعذّر عزل salesSaveInvoice للتحقق النصي", !!saveFn);
  if (saveFn) {
    check("7b: الحفظ لا يزال يستدعي await refreshInvoiceSeries()", saveFn.includes("await refreshInvoiceSeries()"));
    check("7c: الحفظ لا يزال يفحص salesSeriesState(mode).usable الصارم", saveFn.includes("salesSeriesState(mode)") && saveFn.includes(".usable"));
    check(
      "7d: الحفظ لا يستدعي peekSalesInvoiceNumber بوسيط allowPrintGrace إطلاقاً",
      /peekSalesInvoiceNumber\(mode\)/.test(saveFn) && !saveFn.includes("allowPrintGrace"),
    );
    check("7e: الحجز لا يزال يحدث فقط بعد نجاح createSharedDocument", /createSharedDocument\(doc\);\s*\n\s*\/\/[\s\S]*?salesReserveInvoiceNo\(doc\.no, doc\.mode\);/.test(saveFn));
  }
}

// ── 8) حارس تراجعي نصّي: الطباعة/تصدير PDF تستخدمان بوابة التسامح والتأكيد ──
{
  const printFn = appJs.match(/function printSalesInvoice\(\) \{[\s\S]*?\n\}\n\nfunction /)?.[0];
  const pdfFn = appJs.match(/async function saveSalesInvoicePdf\(\) \{[\s\S]*?\n\}\n\nfunction /)?.[0];
  check("8a: تعذّر عزل printSalesInvoice للتحقق النصي", !!printFn);
  check("8b: تعذّر عزل saveSalesInvoicePdf للتحقق النصي", !!pdfFn);
  for (const [name, fn] of [["printSalesInvoice", printFn], ["saveSalesInvoicePdf", pdfFn]]) {
    if (!fn) continue;
    check(`8c[${name}]: يستخدم salesPrintSeriesState لا salesSeriesState مباشرة للبوابة`, fn.includes("salesPrintSeriesState(mode)"));
    check(`8d[${name}]: يتحقق من printUsable`, fn.includes(".printUsable"));
    check(`8e[${name}]: يطلب تأكيداً صريحاً عند التدهور فقط`, /if \([a-zA-Z]+\.degraded && !confirm\(/.test(fn));
  }
}

if (failed) {
  console.error("Sales invoice print grace-degradation contract FAILED.");
  process.exit(1);
}
console.log("Sales invoice print grace-degradation contract checks passed.");
