// فحص انحدار لمسار **الكمبيوتر** في «تقرير الزبائن المتأخرين عن الدفع»: يشغّل
// printOverdueReport وexportReportPdf الحقيقيتين من src/app.js ثم يطبع الوثيقة
// الناتجة طباعة Chromium حقيقية.
//
// العطل الذي يحرسه (2026-10-24): كان هذا التقرير وحده يمرّ على الكمبيوتر بـhtml2pdf
// (تحويل الصفحة إلى صورة نقطية ثم قصّها على ارتفاع الورقة)، فكان:
//   (أ) يقسم الصف بين ورقتين — القص على ارتفاع الصورة لا على حدود الصفوف؛
//   (ب) يسقط html2canvas المسافات العربية: «عنالدفع»، «32يوم»، «بالجملةونصف».
// بقية التقارير تطبع عبر exportReportPdf ← printHtmlDocument (طباعة Chrome الأصلية
// بقاعدة tr{page-break-inside:avoid})، وهذا ما يفرضه الفحص الآن.
// مسار الهاتف لم يُمسّ: createPortablePdfBlob يعالج المسافات ويتجنّب قطع الصفوف
// (يحرسه check.mjs).

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
let failed = false;
function check(label, condition) {
  if (!condition) { console.error(`FAIL: ${label}`); failed = true; }
  else console.log(`ok: ${label}`);
}
const grab = (re, name) => {
  const m = appJs.match(re);
  if (!m) { console.error(`FAIL: تعذّر استخراج ${name} من src/app.js`); failed = true; return ""; }
  return m[0];
};
const fn = (name) => grab(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`), name);
const overdueSrc = fn("printOverdueReport");
// تصغير ملاءمة الفاتورة (invoicePrintFitZoom) يستدعيه exportReportPdf؛ لا يمسّ التقارير.
const ENGINE = [fn("escapeHtml"), overdueSrc,
  grab(/const INVOICE_PRINT_AREA_PX = [^\n]*/, "INVOICE_PRINT_AREA_PX"),
  grab(/const INVOICE_FIT_MIN_ZOOM = [^\n]*/, "INVOICE_FIT_MIN_ZOOM"),
  fn("invoicePrintFitZoom"), fn("exportReportPdf")].join("\n");
if (failed) process.exit(1);

check("printOverdueReport لا يستدعي html2pdf مباشرة (مسار الكمبيوتر عبر exportReportPdf)",
  !/html2pdf\s*\(/.test(overdueSrc) && /await exportReportPdf\(html, \{ docType: "other_report"/.test(overdueSrc));
check("مسار الهاتف ما زال عبر createPortablePdfBlob",
  /isHandheldDevice\(\)[\s\S]*?createPortablePdfBlob\(html, filename/.test(overdueSrc));

const NAMES = ["محل أبو أحمد للجملة ونصف الجملة", "سوبر ماركت النور", "بقالية الأمانة — فرع المزة", "مؤسسة الشام التجارية للمواد الغذائية"];
const COUNT = 46;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body></body></html>');
  const res = await page.evaluate(`(async()=>{
    const calls = { html2pdf: 0, portable: 0, archived: 0, doc: null, title: null };
    window.html2pdf = () => { calls.html2pdf++; throw new Error("html2pdf on desktop"); };
    const isHandheldDevice = () => false;
    const createPortablePdfBlob = async () => { calls.portable++; };
    const presentPortablePdf = () => {};
    const archiveToICloud = () => { calls.archived++; };
    const archiveDocumentTitle = (t, meta) => meta.title;
    const documentFileName = (t, meta) => meta.title + ".pdf";
    const todayIsoDate = () => "2026-10-24";
    const setNotice = () => {}; const render = () => {}; const safeErrorMessage = String;
    const formatMoney = (v) => Number(v).toLocaleString("en-US");
    const BULLETIN_PAGE_WIDTH_PX = 794;
    const printHtmlDocument = (doc, options) => { calls.doc = doc; calls.title = options && options.title; };
    const names = ${JSON.stringify(NAMES)};
    const overdueCustomers = () => Array.from({ length: ${COUNT} }, (_, i) =>
      ({ customer_name: names[i % names.length] + " " + (i + 1), daysSince: i % 7 === 0 ? null : 3 + i, bal: 1200 + i * 37.5 }));
    const customerBalance = (x) => x.bal;
    ${ENGINE}
    await printOverdueReport();
    return calls;
  })()`);

  check(`مسار الكمبيوتر لا يمرّ بـhtml2pdf (${res.html2pdf}) ولا بمسار الهاتف (${res.portable})`,
    res.html2pdf === 0 && res.portable === 0);
  check("وثيقة الطباعة سُلّمت لـprintHtmlDocument", typeof res.doc === "string" && res.doc.length > 0);
  check(`عنوان الطباعة «${res.title}»`, res.title === "تقرير الزبائن المتأخرين");
  check("نسخة iCloud ما زالت تُؤرشف مرة واحدة", res.archived === 1);
  check("‎@page A4 عمودي بهامش 10mm", /@page\{size:A4 portrait;margin:10mm\}/.test(res.doc || ""));

  await page.setContent(res.doc, { waitUntil: "load" });
  const dom = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("tbody tr")];
    return {
      rows: rows.length,
      avoid: rows.every((tr) => ["avoid", "avoid-page"].includes(getComputedStyle(tr).breakInside)),
      theadRepeat: getComputedStyle(document.querySelector("thead")).display === "table-header-group",
      title: document.querySelector("h3")?.textContent || "",
      days: rows.map((tr) => tr.lastElementChild.textContent.trim()).find((t) => t !== "—") || "",
      text: document.body.textContent
    };
  });
  check(`كل الزبائن مطبوعون بلا حذف (${dom.rows}/${COUNT})`, dom.rows === COUNT);
  check("الصف لا ينقسم بين ورقتين (tr{break-inside:avoid})", dom.avoid);
  check("رأس الجدول يتكرّر في كل ورقة", dom.theadRepeat);
  check(`المسافات العربية محفوظة كنص («${dom.title}»، «${dom.days}»)`,
    dom.title.includes("عن الدفع") && / يوم$/.test(dom.days));
  check("أسماء الزبائن كاملة", NAMES.every((n) => dom.text.includes(n)));

  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  check(`طباعة حقيقية متعددة الأوراق (${pages})`, pages >= 2);
} finally {
  await browser.close();
}

if (failed) {
  console.error("\noverdue report print-path check FAILED");
  process.exit(1);
}
console.log("\noverdue report print-path check passed");
