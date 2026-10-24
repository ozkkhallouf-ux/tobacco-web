// فحص انحدار لتراكب أسماء الأصناف الطويلة فوق عمودَي الكمية والحالة في تقرير
// المخزون (وقائمة مستودع الأمانات) — بتخطيط Chromium حقيقي بخط Cairo الرسمي —
// ولعروض الأعمدة: الاسم 48% في التقرير الرئيسي، و44% في صفحة الأمانات بلا «رقم الصنف».
//
// العطل الذي يحرسه: الاسم كان يُمرَّر عبر pdfAr وحدها، وهي تحوّل كل مسافة إلى
// مسافة ثابتة (U+00A0) لا ينكسر عندها السطر أبداً. الخلية عرضها ثابت
// (table-layout:fixed؛ وصف المجموعة colspan=3 أول صف فتأخذ الأعمدة الثلاثة أثلاثاً
// متساوية ≈117px لا 48%)، فالاسم الأطول منها لا يلتف بل يفيض فوق العمود المجاور.
// لذلك يبني الفحص الجدول بصف المجموعة أولاً كما في groupMarkup حرفياً.
// قياس فعلي بأسماء النشرة على ورقة A4: 28 خلية فائضة (حتى 41px) قبل الإصلاح، 0 بعده.
//
// الإصلاح pdfArWrap: نفس pdfAr مع <wbr> بعد كل مسافة ثابتة (فرصة كسر بلا مسافة
// عادية يسقطها html2canvas)، ما عدا المسافة التي يليها رقم — هناك <wbr> يسقط
// المسافة على مسار الهاتف («بلاك11»).

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
const ENGINE = [
  grab(/function escapeHtml\(value\) \{[\s\S]*?\n\}\n/, "escapeHtml"),
  grab(/function pdfAr\(s\) \{[\s\S]*?\n\}\n/, "pdfAr"),
  grab(/function pdfArWrap\(s\) \{[\s\S]*?\n\}\n/, "pdfArWrap"),
  grab(/const REPORT_STYLE = `<style>[\s\S]*?<\/style>`;/, "REPORT_STYLE"),
  grab(/const INVENTORY_REPORT_STYLE = `<style>[\s\S]*?<\/style>`;/, "INVENTORY_REPORT_STYLE")
].join("\n");
if (failed) process.exit(1);

// خط Cairo الرسمي مضمَّناً (data:) كي يطابق القياس ما يُطبع فعلاً.
const font = (w) => readFileSync(new URL(`../public/fonts/cairo/cairo-3.130-arabic-${w}.woff2`, import.meta.url)).toString("base64");
const FACES = [400, 700].map((w) =>
  `@font-face{font-family:"Cairo";font-weight:${w};src:url(data:font/woff2;base64,${font(w)}) format("woff2")}`).join("")
  + ':root{--ozk-font:"Cairo",Tahoma,Arial,sans-serif;--ozk-doc-line-height:1.35}';

// أسماء بطول أسماء النشرة الحقيقية، واسم مبالغ فيه يفيض بأي خط.
const NAMES = [
  "كابتن بلاك كور ازرق جديد — مع قداحات 1",
  "دافيدوف كلاسيك جولد سليم مع فلتر 10",
  "مارلبورو تاتش أحمر طويل نحيف سوبر 4",
  "ونستون كومباكت بلس أزرق فضي 7",
  "اليغانس سليم فضي بدون طبعة",
  "صنف باسم طويل جداً جداً جداً يتجاوز عرض الخلية مهما كان الخط المستخدم في الطباعة 12"
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 718, height: 1047 } });
  await page.setContent('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style></head><body></body></html>');
  await page.emulateMedia({ media: "print" });
  // المحرّك (نص src/app.js) يُحقن وسم script، والبيانات تمرّ وسيطاً لا نصاً مُركّباً.
  await page.addScriptTag({ content: ENGINE });
  const res = await page.evaluate(async ({ names, faces }) => {
    const row = (cell) => '<tr><td style="width:48%">' + cell + '</td><td style="width:29%">'
      + escapeHtml(pdfAr("37 كرتونة")) + '</td><td style="width:23%"><span class="status-active">متوفّر</span></td></tr>';
    const table = (fn, cols) => '<div class="inventory-columns"><div class="inventory-column"><div class="inventory-group"><table>'
      + (cols ? '<colgroup><col style="width:48%"><col style="width:29%"><col style="width:23%"></colgroup>' : '') + '<tbody>'
      + '<tr class="inventory-group-row"><td colspan="3">' + escapeHtml(pdfAr("كابتن بلاك")) + '<span class="group-count">6</span></td></tr>'
      + names.map((n) => row(fn(n))).join("") + '</tbody></table></div></div><div class="inventory-column"></div></div>';
    const style = document.createElement("style");
    style.textContent = faces;
    document.head.appendChild(style);
    document.body.innerHTML = REPORT_STYLE + INVENTORY_REPORT_STYLE
      + '<div class="ozk-rpt inventory-rpt"><section id="old">' + table((n) => escapeHtml(pdfAr(n))) + '</section>'
      + '<section id="new">' + table(pdfArWrap, true) + '</section></div>';
    await document.fonts.ready;
    const measure = (id) => [...document.querySelectorAll("#" + id + " tr:not(.inventory-group-row) td:first-child")].map((td) => ({
      overflow: td.scrollWidth - td.clientWidth,
      text: td.textContent,
      share: td.getBoundingClientRect().width / td.closest("table").getBoundingClientRect().width,
      rowOverflow: [...td.parentElement.children].some((c) => c.scrollWidth - c.clientWidth > 1)
    }));
    return {
      cairo: document.fonts.check('10px "Cairo"', "كابتن"),
      old: measure("old"), now: measure("new"),
      expected: names.map((n) => pdfAr(n)),
      wrapped: names.map(pdfArWrap)
    };
  }, { names: NAMES, faces: FACES });

  check("خط Cairo محمَّل للقياس", res.cairo);
  // ضابط: بأسماء بطول النشرة الحقيقية (لا بالاسم المبالغ فيه وحده) يفيض الاسم فعلاً.
  const oldOver = res.old.slice(0, 5).filter((c) => c.overflow > 1).length;
  check(`الضابط: pdfAr وحدها تفيض بأسماء واقعية (${oldOver}/5: ${res.old.map((c) => c.overflow).join(",")}px)`,
    oldOver >= 3);
  const over = res.now.map((c, i) => (c.overflow > 1 ? `${i + 1}:${c.overflow}px` : null)).filter(Boolean);
  check(`لا اسم يفيض عن خليته بعد الإصلاح (${over.join(",") || "صفر"})`, over.length === 0);
  check(`عمود الاسم بعرضه المقصود ≈48% لا ثلث (${Math.round(res.now[0].share * 100)}%)`,
    res.now.every((c) => c.share > 0.45 && c.share < 0.51));
  check("لا خلية كمية أو حالة تفيض في الصفوف نفسها", res.now.every((c) => !c.rowOverflow));
  check("نص الاسم محفوظ حرفياً بلا حذف ولا اختصار",
    res.now.every((c, i) => c.text === res.expected[i]));
  check("لا فرصة كسر بين مسافة ورقم يليها (تسقط المسافة على مسار الهاتف)",
    res.wrapped.every((h) => !/<wbr>[0-9\u0660-\u0669]/.test(h)));
  check("فرصة كسر بين الكلمات العربية موجودة",
    res.wrapped[0].includes("\u00a0<wbr>"));
  const xss = await page.evaluate(() => pdfArWrap('<img src=x> & "ب"'));
  check("pdfArWrap تهرّب HTML", !xss.includes("<img") && xss.includes("&lt;img"));
} finally {
  await browser.close();
}

// حرّاس نصّيون: موضعا الاسم يستخدمان النسخة القابلة للالتفاف، وأعمدة التقرير الرئيسي
// ثلاثة فقط (الاسم، الكمية، الحالة) بعروضها المقصودة — لا عمود رمز/رقم صنف فيه.
const groupSrc = appJs.match(/const groupMarkup = \(group, part = 0, partCount = 1\) => `[\s\S]*?<\/table><\/div>`;/)?.[0] || "";
check("groupMarkup مستخرج", Boolean(groupSrc));
check("التقرير الرئيسي يثبّت العروض 48/29/23 بـcolgroup",
  groupSrc.includes('<colgroup><col style="width:48%"><col style="width:29%"><col style="width:23%"></colgroup>'));
check("صف الصنف في التقرير الرئيسي ثلاث خلايا فقط",
  (groupSrc.match(/group\.items\.map\(\(it\) => `<tr>([\s\S]*?)<\/tr>`/)?.[1].match(/<td/g) || []).length === 3);
check("لا رمز/رقم صنف في التقرير الرئيسي",
  !/itemNumber|itemCode|رقم الصنف|رمز المادة|الكود/.test(groupSrc));
check("تقرير المخزون: خلية الاسم عبر pdfArWrap",
  appJs.includes('<td style="width:48%">${pdfArWrap(it.name || "")}</td>'));
check("قائمة الأمانات: الاسم والمجموعة عبر pdfArWrap",
  appJs.includes("<tr><td>${pdfArWrap(it.name)}</td><td>${pdfArWrap(it.groupLabel)}</td>"));
// قرار عمر (2026-10-24): «رقم الصنف» يُحذف من صفحة الأمانات **المطبوعة** وحدها، ويتّسع
// الاسم (33% ← 44%). البيانات نفسها باقية: ورقة Excel للأمانات تحمل رقم الصنف كما هي.
const amanatSrc = appJs.match(/function amanatWarehousePageMarkup\(result\) \{[\s\S]*?\n\}\n/)?.[0] || "";
check("amanatWarehousePageMarkup مستخرج", Boolean(amanatSrc));
check("صفحة الأمانات المطبوعة بلا عمود «رقم الصنف»",
  !amanatSrc.includes("رقم الصنف") && !/escapeHtml\(it\.itemNumber\)/.test(amanatSrc));
check("عمود اسم الصنف في صفحة الأمانات 44%",
  amanatSrc.includes('<th style="width:44%">${escapeHtml(pdfAr("اسم الصنف"))}</th>'));
const amanatWidths = [...(amanatSrc.match(/<thead>[\s\S]*?<\/thead>/)?.[0] || "").matchAll(/width:(\d+)%/g)].map((m) => +m[1]);
check(`عروض أعمدة الأمانات مجموعها 100% (${amanatWidths.join("+")})`,
  amanatWidths.length === 5 && amanatWidths.reduce((a, b) => a + b, 0) === 100);
check("ورقة Excel للأمانات ما زالت تحمل رقم الصنف (لا حذف بيانات)",
  /const AMANAT_SHEET_HEADERS = \["رقم الصنف",/.test(appJs) && /sheet\.items\.map\(\(it\) => \[it\.itemNumber, it\.name/.test(appJs));

if (failed) {
  console.error("\ninventory report name-wrap check FAILED");
  process.exit(1);
}
console.log("\ninventory report name-wrap check passed");
