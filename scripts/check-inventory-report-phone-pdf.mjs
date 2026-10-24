// فحص انحدار لمسار **الهاتف** في تقرير «المخزون — حسب ترتيب النشرة»: يصدّر التقرير
// بنفس سلسلة الإنتاج حرفياً (inventoryReportPages بهندسة "canvas" ثم
// createPortablePdfBlob عبر html2pdf الحقيقي من public/vendor) ويعدّ أوراق PDF.
//
// العطل الذي يحرسه (2026-10-22): inventoryPageGeometry("canvas") كان يفترض أن
// html2pdf يرسم الحاوية بعرض 794px وأن الورقة ≈ 1138px. والحقيقة أن toContainer()
// يعيد رصف النسخة بعرض المنطقة الداخلية للصفحة (194mm = 733px) ويقطع الورقة عند
// ≈ 1061px. فكانت كل صفحة مُعبَّأة أطول من ورقتها، يفيض ذيلها لورقة جديدة ثم يدفع
// break-after:page الصفحة التالية لورقة أخرى: 4 صفحات مُعبَّأة خرجت 8 أوراق نصفها
// شبه فارغ، وبعض التوزيعات فشلت كلياً بـ«خرجت صفحة PDF فارغة».
//
// فحص check-inventory-report-print-pages.mjs لا يلتقطه لأنه يطبع مسار اللابتوب
// (page.pdf) وحده، وهندسته صحيحة.

import { chromium } from "playwright";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const appJs = readFileSync(join(root, "src/app.js"), "utf8");
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
const ENGINE = [
  grab(/const REPORT_STYLE = `<style>[\s\S]*?<\/style>`;/, "REPORT_STYLE"),
  grab(/const INVENTORY_REPORT_STYLE = `<style>[\s\S]*?<\/style>`;/, "INVENTORY_REPORT_STYLE"),
  grab(/const INVENTORY_PACK_SAFETY_PX = \d+;/, "INVENTORY_PACK_SAFETY_PX"),
  grab(/const BULLETIN_PAGE_WIDTH_PX = \d+;/, "BULLETIN_PAGE_WIDTH_PX"),
  grab(/const PRIORITY_INVENTORY_GROUPS = \[[\s\S]*?\n\];/, "PRIORITY_INVENTORY_GROUPS"),
  ...["normalizeItemName", "isPriorityInventoryGroup", "inventoryPageGeometry", "inventoryPackPages",
    "inventoryBalanceLastPage", "inventoryTwoColumnPages", "measureInventoryReportBlocks",
    "splitOversizedInventoryEntries", "inventoryReportPages", "canvasInkRatio",
    "trimTrailingPortablePdfDecorations", "createPortablePdfBlob"].map(fn)
].join("\n");
if (failed) process.exit(1);

// نفس بنية groupMarkup/headMarkup في inventoryReportPdfMarkup.
const BUILDER = `
const esc=(v)=>String(v==null?"":v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const renderGroup=(g,part=0,partCount=1)=>'<div class="inventory-group"><table><colgroup><col style="width:48%"><col style="width:29%"><col style="width:23%"></colgroup><tbody>'
 +'<tr class="inventory-group-row"><td colspan="3">'+esc(g.label)
 +(partCount>1?' <span class="group-part">'+esc((part+1)+"/"+partCount)+'</span>':'')
 +'<span class="group-count">'+g.items.length+'</span></td></tr>'
 +g.items.map(it=>'<tr><td style="width:48%">'+esc(it.name)+'</td><td style="width:29%">'+esc(it.qty)
   +'</td><td style="width:23%"><span class="status-active">متوفّر</span></td></tr>').join("")
 +'</tbody></table></div>';
const HEAD=(i,c)=>'<div class="rhead"><div class="brand">OZK TOBACCO<small>تقرير المخزون التشغيلي</small></div>'
 +'<div class="rtitle"><h2>المخزون — حسب ترتيب النشرة</h2><span>بتاريخ 2026-10-22 · صفحة '+(i+1)+' من '+c+'</span></div></div>';
const CARDS='<div class="cards"><div class="rcard"><div class="v gold">412</div><div class="l">أصناف فعلية ومتداولة</div></div>'
 +'<div class="rcard"><div class="v red">37</div><div class="l">قريب من النفاد حسب حركة المبيع</div></div>'
 +'<div class="rcard"><div class="v red">6</div><div class="l">نافد وله طلب حديث</div></div></div>';
const FOOT='<p class="muted" style="margin-top:6px">الحالة محسوبة على تغطية المبيع خلال 60 يوماً. لا تُدمج أصناف المعسل.</p>';
const WORDS=["احمر","ازرق","ابيض","سليم","لايت","سوبر","فضي","ذهبي","نانو","كلاسيك","منتول","20 سيجارة","طويل","اورجينال"];
const LABELS=["غلواز","ماستر","كابتن","اليغانس","كينغ"];
function groupsOf(sizes){
  let seed=7; const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  return sizes.map((n,gi)=>{const label=LABELS[gi]||("مجموعة "+gi);
    return {label,items:Array.from({length:n},(_,i)=>({
      name:label+" "+Array.from({length:1+Math.floor(rnd()*4)},()=>WORDS[Math.floor(rnd()*WORDS.length)]).join(" "),
      qty:(1+Math.floor(rnd()*90))+" كرتونة + "+Math.floor(rnd()*10)+" كروز"}))};});
}
async function exportPhone(sizes){
  const entries=groupsOf(sizes).map(g=>({group:g,html:renderGroup(g),rows:g.items.length+1}));
  const pages=inventoryReportPages({entries,renderGroup,headHtml:HEAD(0,1),cardsHtml:CARDS,footHtml:FOOT},"canvas");
  const body=REPORT_STYLE+INVENTORY_REPORT_STYLE+'<div class="ozk-rpt inventory-rpt">'+pages.map((pg,i)=>
    '<section class="inventory-page">'+HEAD(i,pages.length)+(i===0?CARDS:"")
    +'<div class="inventory-columns"><div class="inventory-column">'+pg.columns[0].map(e=>e.html).join("")
    +'</div><div class="inventory-column">'+pg.columns[1].map(e=>e.html).join("")+'</div></div>'
    +(i===pages.length-1?FOOT:"")+'</section>').join("")+'</div>';
  try {
    const blob=await createPortablePdfBlob(body,"inventory.pdf",{width:BULLETIN_PAGE_WIDTH_PX});
    const text=new TextDecoder("latin1").decode(await blob.arrayBuffer());
    return {layoutPages:pages.length,pdfPages:(text.match(/\\/Type\\s*\\/Page(?!s)/g)||[]).length};
  } catch (error) { return {layoutPages:pages.length,error:String(error&&error.message||error)}; }
}
async function html2pdfGeometry(){
  const c=document.createElement("div");
  c.style.cssText="position:fixed;left:0;top:0;width:"+BULLETIN_PAGE_WIDTH_PX+"px";
  c.innerHTML='<div class="ozk-rpt">x</div>';
  document.body.appendChild(c);
  try {
    const w=window.html2pdf().set({margin:[8,8,8,8],jsPDF:{unit:"mm",format:"a4",orientation:"portrait"}}).from(c.firstElementChild);
    await w.toContainer();
    const inner=w.prop.pageSize.inner;
    return {containerPx:w.prop.container.getBoundingClientRect().width,pagePx:inner.px.width*inner.ratio,
      engine:inventoryPageGeometry("canvas")};
  } finally { c.remove(); }
}`;

// الخادم يخدم قائمة ملفات ثابتة تُقرأ من القرص مرة واحدة عند الإقلاع — لا يُبنى أي
// مسار من عنوان الطلب، فلا مجال لقراءة ملف خارج القائمة.
const SERVED = new Map([
  ["/src/ozk-font.js", { type: "text/javascript", data: readFileSync(join(root, "src/ozk-font.js")) }],
  ["/public/vendor/html2pdf.bundle.min.js", { type: "text/javascript", data: readFileSync(join(root, "public/vendor/html2pdf.bundle.min.js")) }],
  ...readdirSync(join(root, "public/fonts/cairo"))
    .filter((name) => name.endsWith(".woff2"))
    .map((name) => [`/public/fonts/cairo/${name}`, { type: "font/woff2", data: readFileSync(join(root, "public/fonts/cairo", name)) }])
]);
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head><body></body></html>');
    return;
  }
  const file = SERVED.get(path);
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": file.type });
  res.end(file.data);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const SCENARIOS = [
  ["مزيج واقعي (35 مجموعة)", [5, 1, 3, 12, 4, 6, 1, 3, 28, 22, 4, 28, 8, 22, 28, 1, 5, 12, 10, 1, 15, 15, 3, 18, 12, 3, 18, 6, 10, 18, 15, 5, 5, 15, 1]],
  ["مجموعة كبيرة بين صغيرة", [6, 4, 3, 5, 2, 60, 3, 8, 1, 1, 2, 12, 25, 4, 30, 2, 9]],
  ["مجموعات صغيرة كثيرة", [2, 1, 3, 1, 4, 2, 2, 3, 1, 1, 4, 2, 3, 3, 1, 2, 4, 1, 2, 3, 1, 1, 2, 4, 3, 2, 1, 3, 2, 2, 4, 1, 3, 2, 1, 2, 3, 4, 1, 2]],
  ["صفحات شبه ممتلئة", [8, 6, 5, 7, 4, 40, 38, 36, 41, 39, 37, 1, 2]],
  ["تقرير صغير", [5, 3]]
];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ url: "/src/ozk-font.js" });
  await page.evaluate(() => OZK_FONT.ready());
  await page.addScriptTag({ url: "/public/vendor/html2pdf.bundle.min.js" });
  await page.addScriptTag({ content: `${ENGINE}\n${BUILDER}\nwindow.__exportPhone=exportPhone;window.__geometry=html2pdfGeometry;` });

  // ١) الهندسة التي يعبّئ بها المحرّك = ما يرسمه html2pdf فعلاً.
  const geo = await page.evaluate(() => window.__geometry());
  check(`عرض المحتوى المقيس (${geo.engine.contentWidthPx}) = عرض حاوية html2pdf ناقص الحشوة (${geo.containerPx - 20})`,
    Math.abs(geo.engine.contentWidthPx - (geo.containerPx - 20)) <= 1);
  check(`ارتفاع الصفحة المُعبَّأة (${geo.engine.pageHeightPx}) لا يتجاوز ورقة html2pdf ناقص الحشوة (${(geo.pagePx - 12).toFixed(1)})`,
    geo.engine.pageHeightPx <= geo.pagePx - 12 + 0.5);

  // ٢) كل صفحة مُعبَّأة = ورقة PDF واحدة بالضبط عبر سلسلة الهاتف الحقيقية.
  for (const [label, sizes] of SCENARIOS) {
    const result = await page.evaluate((s) => window.__exportPhone(s), sizes);
    if (result.error) {
      check(`${label}: التصدير نجح (${result.error})`, false);
      continue;
    }
    check(`${label}: صفحات التوزيع (${result.layoutPages}) = أوراق PDF الهاتف (${result.pdfPages})`,
      result.layoutPages === result.pdfPages);
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error("\ninventory report phone-pdf check FAILED");
  process.exit(1);
}
console.log("\ninventory report phone-pdf check passed");
