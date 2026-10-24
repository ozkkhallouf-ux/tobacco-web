// فحص انحدار لاتجاه النص والمسافات في **ملف PDF فاتورة المبيعات** (saveSalesInvoicePdf
// ← salesInvoicePdfMarkup ← html2pdf مباشرة).
//
// العطل الذي يحرسه (2026-10-24): html2canvas يرسم كل مقطع نصي باتجاه LTR ويسقط
// المسافة عند حدود المقاطع، وهذا المسار لم يكن يمرّ بتثبيت المسافات الذي يطبّقه
// createPortablePdfBlob. فخرج في الملف المسلَّم للزبون:
//   «صفة :البيع»، «السجل :التجاري0310109105»، «:الزبون»، «2026 24 أكتوبر»،
//   «فاتورةمبيعات»، «محل أبوأحمد»، «المتبقّي(مسدّد)».
// الإصلاح: &rlm; بعد النقطتين وقبل القيمة، و&nbsp; حول الشرطة والنقطة الوسطى والقوس،
// وpinArabicSpacesForCanvas على الحاوية قبل html2pdf.

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
const saveSrc = fn("saveSalesInvoicePdf");
const portableSrc = fn("createPortablePdfBlob");
const ENGINE = [
  grab(/const SALES_DRAFT_INVOICE_NO = "[^"]+";/, "SALES_DRAFT_INVOICE_NO"),
  grab(/const SALES_TRADE_REGISTER_NO = "[^"]+";/, "SALES_TRADE_REGISTER_NO"),
  grab(/const SALES_TRADE_CAPACITY = "[^"]+";/, "SALES_TRADE_CAPACITY"),
  fn("escapeHtml"), fn("salesDraftBannerHtml"), fn("pinArabicSpacesForCanvas"), fn("salesInvoicePdfMarkup")
].join("\n");
if (failed) process.exit(1);

check("saveSalesInvoicePdf يثبّت المسافات العربية على الحاوية قبل html2pdf",
  /pinArabicSpacesForCanvas\(container\);[\s\S]*?window\.html2pdf\(\)\.set\(/.test(saveSrc));
check("createPortablePdfBlob ما زال يثبّت المسافات بنفس الدالة",
  /pinArabicSpacesForCanvas\(source\);[\s\S]*?window\.html2pdf\(\)\.set\(/.test(portableSrc));

const AR = "[\\u0600-\\u06ff]";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body></body></html>');
  const res = await page.evaluate(`(()=>{${ENGINE}
    const markup = salesInvoicePdfMarkup({
      invNo: "A-2712", customer: "محل أبو أحمد", payLabel: "أجل",
      dateLabel: "24 أكتوبر 2026", curLabel: "دولار أمريكي",
      rows: [{ name: "كابتن بلاك كور ازرق", unit: "كرتونة", qty: "2", price: "$286.00", total: "$572.00" }],
      grand: "$572.00", discount: "$0.00", net: "$572.00", paid: "$0.00", remaining: "$572.00", remainingLabel: "عليه"
    });
    const box = document.createElement("div");
    box.innerHTML = markup;
    document.body.appendChild(box);
    pinArabicSpacesForCanvas(box);
    const nodes = [];
    const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) nodes.push(n.nodeValue);
    const foot = box.querySelector(".pdf-foot span");
    return {
      nodes,
      text: box.textContent,
      footer: foot ? foot.textContent : "",
      registerNode: foot ? [...foot.childNodes].map((c) => c.nodeType === 3 ? "T" : c.tagName).join(",") : ""
    };
  })()`);

  // 1) كل نقطتين بعد حرف عربي يليها RLM (وإلا رُسمت يمين الكلمة)
  const badColon = res.nodes.filter((t) => new RegExp(`${AR}:(?!\\u200f)`).test(t));
  check(`كل «عنوان:» عربي معزول باتجاه RTL (${badColon.length ? JSON.stringify(badColon) : "الكل"})`, badColon.length === 0);
  // 2) لا مسافة عادية بين حرفين عربيين داخل مقطع واحد
  const loose = res.nodes.filter((t) => new RegExp(`${AR} ${AR}`).test(t));
  check(`لا مسافة عربية قابلة للسقوط (${loose.length ? JSON.stringify(loose) : "صفر"})`, loose.length === 0);
  // 3) المسافات حول الشرطة والنقطة الوسطى والقوس ثابتة
  check("«مركز أبو زياد — لتجارة الدخان» بمسافات ثابتة", res.text.includes("زياد — لتجارة"));
  check("«المتبقّي (…)» بمسافة ثابتة قبل القوس", res.text.includes("المتبقّي (عليه)"));
  check("النقطة الوسطى في التذييل بمسافتين ثابتتين", res.footer.includes(" · "));
  // 4) القيم المعروضة بعد العنوان تبدأ بـRLM (التاريخ لا ينقلب)
  check("قيمة التاريخ تبدأ بـRLM", res.nodes.some((t) => t === "‏24 أكتوبر 2026"));
  // 5) رقم السجل كامل وبعده فاصل لا يعتمد على عقدة مسافة يسقطها html2canvas
  check("رقم السجل التجاري كاملاً في التذييل", res.footer.includes("0310109105"));
  check("لا عقدة مسافة منفردة قبل رقم السجل",
    /margin-right:\.3em">\$\{escapeHtml\(SALES_TRADE_REGISTER_NO\)\}/.test(appJs) && !/التجاري:&rlm; <span dir="ltr"/.test(appJs));
  // 6) لا نص محذوف: العناوين والصفة كما هي (بعد إزالة المحارف الخفية والمسافات الثابتة)
  const plain = res.text.replace(/‏/g, "").replace(/ /g, " ");
  for (const s of ["صفة البيع:", "السجل التجاري:", "الزبون:", "طريقة الدفع:", "التاريخ:", "العملة:",
    "من تاجر جملة الجملة إلى تاجر جملة ومفرق", "فاتورة مبيعات", "كابتن بلاك كور ازرق"]) {
    check(`النص محفوظ: «${s}»`, plain.includes(s));
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error("\nsales invoice PDF bidi check FAILED");
  process.exit(1);
}
console.log("\nsales invoice PDF bidi check passed");
