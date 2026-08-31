// فحص انحدار للصفحات البيضاء في تقرير المخزون المطبوع — بطباعة PDF **حقيقية**
// عبر Chromium، لا بحساب ارتفاعات فقط.
//
// العطل الذي يحرسه: مجموعة أطول من عمود صفحة كاملة كانت تُوضع في عمود فارغ
// اعتماداً على أن «المتصفح سيمدّها». هذا مستحيل: CSS الخاص بنا يضع
// break-inside:avoid على .inventory-group، فيرفض كروم تمديدها ويدفعها كاملة إلى
// الصفحة التالية — فتبقى الصفحة الحالية بالرأس (وبطاقات الملخص بالأولى) وحدها،
// أي **صفحة A4 بيضاء**، ثم يضيف break-after:page صفحة أخرى.
// قياس فعلي قبل الإصلاح: مجموعة بـ70 صنفاً -> 4 أوراق مقابل صفحتين معروضتين،
// أولاهما 128 عملية نص والثانية 64 (رأس فقط). ومع مجموعتين طويلتين ظهرت صفحة
// بيضاء بينهما أيضاً — وهو ما أبلغ عنه المستخدم حرفياً.
//
// لماذا لم تلتقطه فحوص PR #156؟ لأنها كانت كلها حسابية على الارتفاعات، ولم يطبع
// أيٌّ منها صفحة واحدة فعلياً. وحالة «المجموعة العملاقة» فيها كانت تتحقق من عدم
// فقدانها أو تكرارها أو كسر ترتيبها فقط — لا من شكلها المطبوع. تفاعل
// break-inside:avoid مع صندوق أطول من الصفحة لا يظهر في أي حساب ارتفاعات.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

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
  grab(/const REPORT_STYLE = `<style>[\s\S]*?<\/style>`;/, "REPORT_STYLE"),
  grab(/const INVENTORY_REPORT_STYLE = `<style>[\s\S]*?<\/style>`;/, "INVENTORY_REPORT_STYLE"),
  grab(/const INVENTORY_PACK_SAFETY_PX = \d+;/, "SAFETY"),
  grab(/function inventoryPageGeometry\(mode\) \{[\s\S]*?\n\}\n/, "inventoryPageGeometry"),
  grab(/function inventoryPackPages\(entries, options = \{\}\) \{[\s\S]*?\n\}\n/, "inventoryPackPages"),
  grab(/function inventoryBalanceLastPage\(page, limit\) \{[\s\S]*?\n\}\n/, "inventoryBalanceLastPage"),
  grab(/function inventoryTwoColumnPages\(entries, columnCapacity = 48\) \{[\s\S]*?\n\}\n/, "inventoryTwoColumnPages"),
  grab(/function splitOversizedInventoryEntries\(entries, heights, maxColumnPx, renderGroup\) \{[\s\S]*?\n\}\n/, "splitOversizedInventoryEntries"),
  grab(/function measureInventoryReportBlocks\(parts, geometry\) \{[\s\S]*?\n\}\n/, "measureInventoryReportBlocks"),
  grab(/function inventoryReportPages\(parts, mode\) \{[\s\S]*?\n\}\n/, "inventoryReportPages")
].join("\n");
if (failed) process.exit(1);

// نفس بنية groupMarkup في inventoryReportPdfMarkup حرفياً (بما فيها رقم الجزء).
const BUILDER = `
const esc=(v)=>String(v==null?"":v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const renderGroup=(g,part=0,partCount=1)=>'<div class="inventory-group"><table><tbody>'
 +'<tr class="inventory-group-row"><td colspan="3">'+esc(g.label)
 +(partCount>1?' <span class="group-part">'+esc((part+1)+"/"+partCount)+'</span>':'')
 +'<span class="group-count">'+g.items.length+'</span></td></tr>'
 +g.items.map(it=>'<tr><td style="width:48%">'+esc(it.name)+'</td><td style="width:29%">'+esc(it.qty)
   +'</td><td style="width:23%"><span class="status-active">متوفّر</span></td></tr>').join("")
 +'</tbody></table></div>';
const HEAD=(i,c)=>'<div class="rhead"><div class="brand">OZK TOBACCO<small>تقرير المخزون التشغيلي</small></div>'
 +'<div class="rtitle"><h2>المخزون — حسب ترتيب النشرة</h2><span>بتاريخ 2026-08-31 · صفحة '+(i+1)+' من '+c+'</span></div></div>';
const CARDS='<div class="cards"><div class="rcard"><div class="v gold">120</div><div class="l">أصناف فعلية ومتداولة</div></div>'
 +'<div class="rcard"><div class="v red">14</div><div class="l">قريب من النفاد</div></div>'
 +'<div class="rcard"><div class="v red">3</div><div class="l">نافد وله طلب حديث</div></div></div>';
const FOOT='<p class="muted" style="margin-top:6px">الحالة محسوبة على تغطية المبيع خلال 60 يوماً. لا تُدمج أصناف المعسل.</p>';
function build(spec){
  const groups=spec.map((cnt,gi)=>({label:"مجموعة "+gi,
    items:Array.from({length:cnt},(_,i)=>({name:(i%4===0?"صنف طويل الاسم نسبياً للمجموعة "+gi+" رقم "+i:"صنف "+gi+"-"+i),qty:(10+i)+" كرتونة"}))}));
  const entries=groups.map(g=>({group:g,html:renderGroup(g),rows:g.items.length+1}));
  const pages=inventoryReportPages({entries,renderGroup,headHtml:HEAD(0,1),cardsHtml:CARDS,footHtml:FOOT},"print");
  const markup=pages.map((pg,i)=>'<section class="inventory-page">'+HEAD(i,pages.length)+(i===0?CARDS:"")
    +'<div class="inventory-columns"><div class="inventory-column">'+pg.columns[0].map(e=>e.html).join("")
    +'</div><div class="inventory-column">'+pg.columns[1].map(e=>e.html).join("")+'</div></div>'
    +(i===pages.length-1?FOOT:"")+'</section>').join("");
  return {domPages:pages.length,
    pageGroupCounts:pages.map(pg=>pg.columns[0].length+pg.columns[1].length),
    totalItems:groups.reduce((s,g)=>s+g.items.length,0),
    body:REPORT_STYLE+INVENTORY_REPORT_STYLE+'<div class="ozk-rpt inventory-rpt">'+markup+'</div>'};
}`;

// نفس وثيقة الطباعة التي يبنيها exportReportPdf حرفياً.
const DOC = (body) => '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير المخزون</title>'
  + '<style>@page{size:A4 portrait;margin:10mm}'
  + 'html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}'
  + 'img{max-width:100%}table{page-break-inside:auto}tr{page-break-inside:avoid}thead{display:table-header-group}tfoot{display:table-footer-group}'
  + '@media print{.ozk-rpt{padding:0}}</style></head><body>' + body + '</body></html>';

const A4_CONTENT_PX = 277 * (96 / 25.4); // 1046.9 — مقاسة فعلياً من كروم
const BLANK_INK_MAX = 150;               // صفحة برأس فقط أعطت 64–128 عملية نص

function pdfTextOpsPerPage(pdf) {
  const s = pdf.toString("latin1");
  const contents = [...s.matchAll(/\/Type\s*\/Page[^s][\s\S]{0,400}?\/Contents\s+(\d+)\s+0\s+R/g)].map((m) => +m[1]);
  const objs = {};
  for (const m of s.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) objs[+m[1]] = m[2];
  return contents.map((id) => {
    const sm = (objs[id] || "").match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
    if (!sm) return -1;
    let d = Buffer.from(sm[1], "latin1");
    try { d = zlib.inflateSync(d); } catch { try { d = zlib.inflateRawSync(d); } catch { /* غير مضغوط */ } }
    return (d.toString("latin1").match(/\bTJ\b|\bTj\b/g) || []).length;
  });
}

const SCENARIOS = [
  ["مجموعات صغيرة معتادة",        [10, 10, 10, 10, 10, 10]],
  ["مجموعة أطول من عمود (70)",    [70, 8, 8]],
  ["مجموعة أطول بكثير (120)",     [120, 8]],
  ["مجموعتان طويلتان",            [80, 80, 10]],
  ["مجموعة طويلة وحيدة",          [90]],
  ["مجموعة هائلة (300)",          [300]],
  ["مزيج واقعي",                  [45, 3, 22, 7, 60, 12, 9, 31, 5, 18]],
  ["مجموعات بصنف واحد",           [1, 1, 1]],
  ["تقرير صغير جداً",             [3]]
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [label, spec] of SCENARIOS) {
    await page.setContent('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body></body></html>');
    const built = await page.evaluate(`(()=>{${ENGINE}\n${BUILDER}\nreturn build(${JSON.stringify(spec)});})()`);

    await page.setContent(DOC(built.body), { waitUntil: "load" });
    const sections = await page.evaluate(() =>
      [...document.querySelectorAll(".inventory-page")].map((s) => ({
        height: s.getBoundingClientRect().height,
        groups: s.querySelectorAll(".inventory-group").length
      })));
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    const ink = pdfTextOpsPerPage(pdf);

    // 1) عدد صفحات DOM = عدد صفحات الطباعة الفعلية (هذا وحده يرصد العطل: كان 2 مقابل 4)
    check(`${label}: صفحات DOM (${built.domPages}) = صفحات PDF (${ink.length})`,
      built.domPages === ink.length);
    // 2) صفر صفحات فارغة — أولاً وبيناً وآخراً
    const blanks = ink.map((v, i) => (v <= BLANK_INK_MAX ? i + 1 : null)).filter(Boolean);
    check(`${label}: لا صفحة بيضاء في أي موضع (${blanks.length ? blanks.join(",") : "لا شيء"})`,
      blanks.length === 0);
    // 3) كل صفحة معروضة تحمل مجموعة واحدة على الأقل
    check(`${label}: كل صفحة فيها مجموعة واحدة على الأقل`,
      built.pageGroupCounts.every((n) => n > 0) && sections.every((s) => s.groups > 0));
    // 4) لا مجموعة تنقسم بين صفحتين: كل قسم يسع ورقة واحدة، فيستحيل أن يمتد صندوق عبر الحدّ
    const tall = sections.map((s, i) => (s.height > A4_CONTENT_PX + 1 ? `ص${i + 1}=${s.height.toFixed(0)}px` : null)).filter(Boolean);
    check(`${label}: كل صفحة تسع ورقة A4 واحدة (${tall.join(",") || "الكل"})`, tall.length === 0);
    // 5) لا فقدان لأي صنف بعد التقسيم
    const rendered = await page.evaluate(() =>
      document.querySelectorAll(".inventory-group tbody tr:not(.inventory-group-row)").length);
    check(`${label}: كل الأصناف مطبوعة (${rendered}/${built.totalItems})`, rendered === built.totalItems);
  }

  // آخر صفحة يجب ألا تحمل فاصل صفحة بعدها، وإلا وُلدت ورقة زائدة. نبنيها بأنماط
  // التقرير الحقيقية (لا بوثيقة عارية) وإلا كان الفحص بلا معنى.
  await page.setContent('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body></body></html>');
  const breaks = await page.evaluate(`(()=>{${ENGINE}
    document.body.innerHTML = REPORT_STYLE + INVENTORY_REPORT_STYLE
      + '<div class="ozk-rpt inventory-rpt"><section class="inventory-page">أ</section><section class="inventory-page">ب</section></div>';
    return [...document.querySelectorAll(".inventory-page")].map((s)=>getComputedStyle(s).breakAfter);
  })()`);
  check(`آخر صفحة بلا break-after (${breaks.join(",")})`,
    breaks[breaks.length - 1] === "auto" && breaks[0] === "page");
} finally {
  await browser.close();
}

// حرّاس تراجعيون نصّيون
check("المجموعة الأطول من عمود تُقسَّم مسبقاً لا تُترك للمتصفح",
  appJs.includes("splitOversizedInventoryEntries") && /const maxColumnPx = geometry\.pageHeightPx - measured\.headPx - INVENTORY_PACK_SAFETY_PX;/.test(appJs));
check("التقرير يمرّر renderGroup كي تُبنى الأجزاء بنفس القالب",
  /renderGroup: groupMarkup/.test(appJs));
check("حارس صريح ضد إخراج صفحة بلا مجموعات",
  /pages\.filter\(\(page\) => page\.columns\[0\]\.length > 0 \|\| page\.columns\[1\]\.length > 0\)/.test(appJs));
check("إصلاح التذبذب (PR #156) ما زال قائماً",
  appJs.includes("triedReserveIndexes") && /next\.length - 1 === reserveIndex && footerFits\(next\)/.test(appJs));
check("قاعدة عدم تقسيم المجموعة القابلة للاحتواء لم تُمسّ",
  appJs.includes(".inventory-group{margin:0 0 5px;break-inside:avoid;page-break-inside:avoid}"));

if (failed) {
  console.error("\ninventory report print-pages check FAILED");
  process.exit(1);
}
console.log("\ninventory report print-pages check passed");
