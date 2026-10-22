"use strict";
// أحجام الورق المدعومة. القالب الرسمي مصمَّم لـA4 (عرض 720px). A5 = نفس القالب
// مصغَّراً بـzoom 0.7 (عرض A5 المطبوع 148mm ≈ 0.70 × عرض A4 210mm) — لا قالب ثانٍ.
// الطابعة لها درج خلفي واحد: A5 يتطلب وضع ورق A5 فعلياً في الدرج.
const PAPERS = Object.freeze({
  A4: { label: "A4", pdf: { format: "A4", margin: "12mm" }, css: "", sumatraPaper: "A4" },
  // تصغير بـzoom داخل المستند لا بمعامل scale في page.pdf: القالب يفرض
  // @page{size:A4} فكان Chrome يرسم صفحة A4 ثم يقصّها داخل A5.
  A5: {
    label: "A5",
    pdf: { format: "A5", margin: "8mm" },
    css: "@page{size:A5 portrait;margin:8mm}html{zoom:0.7}",
    sumatraPaper: "A5",
  },
});

function paperFor(name, config) {
  const key = String(name || "A4").toUpperCase();
  const enabled = (config && Array.isArray(config.papers) && config.papers.length) ? config.papers : ["A4"];
  if (!PAPERS[key] || !enabled.map((p) => String(p).toUpperCase()).includes(key)) {
    throw new Error(`حجم ورق غير مسموح: ${name}`);
  }
  return PAPERS[key];
}

function pdfOptions(paper) {
  const m = paper.pdf.margin;
  return {
    format: paper.pdf.format,
    printBackground: true,
    preferCSSPageSize: false,
    margin: { top: m, bottom: m, left: m, right: m },
  };
}

// إعدادات SumatraPDF: عدد النسخ + الورق. الصفحة مولَّدة بالحجم الصحيح أصلاً.
// يحقن تعديل الورق في آخر <head> (بعد أنماط القالب فيغلبها)؛ A4 بلا مساس.
function applyPaperCss(html, paper) {
  if (!paper.css) return html;
  return String(html).replace("</head>", `<style>${paper.css}</style>\n</head>`);
}

function sumatraSettings(paper, copies) {
  return `${copies}x,paper=${paper.sumatraPaper}`;
}

module.exports = { PAPERS, paperFor, pdfOptions, sumatraSettings, applyPaperCss };
