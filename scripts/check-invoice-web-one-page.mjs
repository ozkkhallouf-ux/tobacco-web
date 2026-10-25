// حارس هدر الورق في فاتورة الجملة على الموقع (قالب OZK_INVOICE) — بطباعة PDF حقيقية.
//
// العطل الذي يحرسه (بلاغ المالك 2026-10-25): فاتورة 11 صنفاً مع حسم ودفعة كانت تخرج
// ورقتين. ارتفاعها في وسط الطباعة 1085px والمتاح في A4 بهامش 10mm هو 1047px، فتجاوز
// التذييل الحدّ بنحو 38px وسقط وحده على الورقة الثانية (78 عملية نص فقط). وعلى
// الهاتف (html2pdf) خرجت الورقة الثانية بيضاء. وكان الشيء نفسه يقع من 11 إلى 14 صنفاً
// ومن 35 إلى 38 (ورقة ثالثة بالتذييل وحده).
//
// الإصلاح في src/documents/invoice/ozk-invoice.js:
//   • كتلة `.inv-closing` واحدة لا تنشطر: الأرصدة، والملاحظة، وصفة البيع، والختم،
//     والتذييل. فلا تبدأ ورقة بالختم أو التذييل وحدهما؛ إن لم تتسع الكتلة انتقلت كاملةً
//     ومعها الأرصدة، وهي محتوى حقيقي.
//   • حشوة رأسية أقل في خلايا الجدولين وهامشا الختم والتذييل. أحجام الخط كما هي.
// وفي createPortablePdfBlob (src/app.js): البياض الذي يدرجه html2pdf عمداً لدفع كتلة
// كاملة لم يعد يُحسب «صفحة فارغة» ويُفشل التصدير.
//
// المساران المفحوصان هما مسارا exportReportPdf حرفياً: وثيقة الطباعة الأصلية (اللابتوب)
// بـ@page A4 وهامش 10mm، وcreatePortablePdfBlob عبر html2pdf الحقيقي (الهاتف).
// الخط Cairo الحقيقي من public/fonts، لأن ارتفاع السطر يقرّر مكان القطع.

import { chromium } from "playwright";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const appJs = readFileSync(join(root, "src/app.js"), "utf8");
const invJs = readFileSync(join(root, "src/documents/invoice/ozk-invoice.js"), "utf8");
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
  grab(/const BULLETIN_PAGE_WIDTH_PX = \d+;/, "BULLETIN_PAGE_WIDTH_PX"),
  grab(/const SALES_TRADE_REGISTER_NO = "[^"]*";/, "SALES_TRADE_REGISTER_NO"),
  grab(/const SALES_TRADE_CAPACITY = "[^"]*";/, "SALES_TRADE_CAPACITY"),
  ...["canvasInkRatio", "portablePdfSpacerRanges", "trimTrailingPortablePdfDecorations",
    "pinArabicSpacesForCanvas", "createPortablePdfBlob"].map(fn)
].join("\n");
// وثيقة الطباعة كما يبنيها exportReportPdf، لا نسخة منها.
const PRINT_DOC = grab(/const doc =\n\s+'<!doctype html>[\s\S]*?'<\/body><\/html>';/, "وثيقة exportReportPdf");
if (failed) process.exit(1);

// ===== حرّاس نصّيون =====
check("ختام الفاتورة كتلة واحدة لا تنشطر",
  invJs.includes(".ozk-inv .inv-closing{page-break-inside:avoid;break-inside:avoid}"));
check("الأرصدة والملاحظة وصفة البيع والختم والتذييل داخل .inv-closing بهذا الترتيب",
  /<div class="inv-closing">\s*<table>\$\{infoRows\}<\/table>\s*<p class="muted"[^\n]*\n\s*\$\{kind\.legal \? legalBox\(esc\) : ""\}\s*\$\{kind\.seal \? SEAL : ""\}\s*<div class="rfoot">[^\n]*\n\s*<\/div>/.test(invJs));
check("أحجام الخط لم تُصغَّر (الجدول 12px والرأس 11px)",
  invJs.includes(".ozk-inv table{width:100%;border-collapse:collapse;font-size:12px}")
  && /\.ozk-inv th\{[^}]*font-size:11px/.test(invJs));
check("فحص الشرائح الفارغة على الهاتف يستثني بياض فواصل html2pdf فقط",
  appJs.includes("bandRatios.some((ratio, i) => ratio <= 0.0005 && !bandIsSpacer(i))"));

const SERVED = new Map([
  ["/src/ozk-font.js", { type: "text/javascript", data: readFileSync(join(root, "src/ozk-font.js")) }],
  ["/src/documents/invoice/ozk-invoice.js", { type: "text/javascript", data: Buffer.from(invJs) }],
  ["/public/vendor/html2pdf.bundle.min.js", { type: "text/javascript", data: readFileSync(join(root, "public/vendor/html2pdf.bundle.min.js")) }],
  ["/public/icons/ozk-logo.png", { type: "image/png", data: readFileSync(join(root, "public/icons/ozk-logo.png")) }],
  ...readdirSync(join(root, "public/fonts/cairo")).filter((name) => name.endsWith(".woff2"))
    .map((name) => [`/public/fonts/cairo/${name}`, { type: "font/woff2", data: readFileSync(join(root, "public/fonts/cairo", name)) }])
]);
// قائمة ملفات ثابتة تُقرأ مرة واحدة؛ لا يُبنى أي مسار من عنوان الطلب.
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
const base = `http://127.0.0.1:${server.address().port}/`;

// بيانات اصطناعية بالكامل. الكمية بسطرين (كرتونة ثم كروز) كما تُطبع الفواتير الحقيقية،
// والأرصدة بأطول صيغها: السابق، القيمة، الحسم، دفعة الزبون، الجديد.
const BUILDER = `
const esc=(v)=>String(v==null?"":v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const NAMES=["غلواز احمر طويل","ماستر ابيض سليم","كابتن بلاك كلاسيك","اليغانس سوبر سليم فضي","كينغ سايز ذهبي 20 سيجارة","مالبورو احمر","ونستون لايت","سيدرز ازرق","ال ام نانو منتول","غلواز ازرق اورجينال سليم","ماستر سوبر سليم ذهبي"];
function invoice(n,o){
  const lines=Array.from({length:n},(_,i)=>({material:NAMES[i%NAMES.length]+(o.long&&i%3===0?" إصدار خاص بعلبة كرتون مقوّى":""),
    qtyParts:{value:String(1+i%4),unit:"كرتونة",detailValue:String((1+i%4)*50),detailUnit:"كروز"},
    priceText:"$ "+(250+i*3)+".00 / كرتونة",valueText:"$ "+((1+i%4)*(250+i*3))+".00"}));
  const rows=[{label:"التاريخ",value:"2026-10-24",width:"130px",isDate:true},
    {label:"الرصيد السابق",value:"1,250.00 $ (عليكم)"},{label:"قيمة هذه الفاتورة",value:"3,410.00 $"}];
  if(o.full){rows.push({label:"الحسم",value:"− 10.00 $",tone:"cred"});rows.push({label:"دفعة من الزبون",value:"− 500.00 $",tone:"cred"});}
  rows.push({label:"الرصيد الجديد",value:"4,150.00 $ (عليكم)",strong:true});
  return OZK_INVOICE.markup({kind:"invoice",escapeHtml:esc,no:"9001",date:"2026-10-24",cur:"$",party:"محل تجريبي",
    partyMeta:"هاتف: 0900000000",amountText:"3,410.00",lines,rows});
}
async function phone(n,o){
  try{
    const blob=await createPortablePdfBlob(invoice(n,o),"x.pdf",{width:BULLETIN_PAGE_WIDTH_PX});
    const text=new TextDecoder("latin1").decode(await blob.arrayBuffer());
    return {pages:(text.match(/\\/Type\\s*\\/Page(?!s)/g)||[]).length};
  }catch(e){return {error:String(e&&e.message||e)};}
}`;

// عمليات النص في كل ورقة. الدفق يُقرأ بطول /Length المعلن (مباشراً أو مرجعاً)، لا بتعبير
// نمطي حتى «endstream»: بايتات الدفق المضغوط قد تحوي تلك السلسلة فيُقطع مبكراً ويُقرأ صفراً
// (وقع على CI: ورقة كاملة قيست 0).
function textOpsPerPage(pdf) {
  const s = pdf.toString("latin1");
  const objs = new Map();
  for (const m of s.matchAll(/(?:^|[\r\n])(\d+)\s+0\s+obj\b/g)) objs.set(+m[1], m.index + m[0].length);
  const lengthOf = (dict) => {
    const ref = dict.match(/\/Length\s+(\d+)\s+0\s+R/);
    if (ref) return Number((s.slice(objs.get(+ref[1])).match(/^\s*(\d+)/) || [])[1]);
    return Number((dict.match(/\/Length\s+(\d+)/) || [])[1]);
  };
  const streamOps = (id) => {
    const start = objs.get(id);
    if (start === undefined) return -1;
    const at = s.indexOf("stream", start);
    const length = lengthOf(s.slice(start, at));
    if (!(length > 0)) return -1;
    const bodyStart = at + 6 + (s[at + 6] === "\r" ? 2 : 1);
    let d = Buffer.from(s.slice(bodyStart, bodyStart + length), "latin1");
    try { d = zlib.inflateSync(d); } catch { /* غير مضغوط */ }
    return (d.toString("latin1").match(/\bTJ\b|\bTj\b/g) || []).length;
  };
  return [...s.matchAll(/\/Type\s*\/Page[^s][\s\S]{0,400}?\/Contents\s+(\d+)\s+0\s+R/g)].map((m) => streamOps(+m[1]));
}

// ورقة التذييل وحده = 78 عملية نص، وكتلة الختام كاملة ≥ 290. الحد بينهما.
const NEAR_EMPTY_OPS = 200;
// كل فاتورة حتى هذا العدد بأطول أرصدة تتسع لورقة واحدة بعد الإصلاح (قِيس: 12).
const ONE_PAGE_UP_TO = 12;
const PHONE_SAMPLE = [1, 6, 10, 11, 12, 13, 14, 16, 20, 30, 35, 38, 39, 40];

const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base);
  for (const url of ["/src/ozk-font.js", "/src/documents/invoice/ozk-invoice.js", "/public/vendor/html2pdf.bundle.min.js"]) {
    await page.addScriptTag({ url });
  }
  await page.evaluate(() => OZK_FONT.ready());
  await page.addScriptTag({ content: `${ENGINE}\n${BUILDER}\nwindow.__invoice=invoice;window.__phone=phone;` });
  const printPage = await context.newPage();

  const desk = async (n, o) => {
    const body = await page.evaluate(([n, o]) => window.__invoice(n, o), [n, o]);
    // eval للوثيقة المستخرجة نفسها: bodyHtml وtitle هما متغيّرا exportReportPdf.
    const html = await page.evaluate(([bodyHtml, src]) => {
      const title = "فاتورة";
      return OZK_FONT.withFaces(eval(src + "\ndoc"));
    }, [body, PRINT_DOC]);
    await printPage.goto(base);
    await printPage.evaluate((h) => { document.open(); document.write(h); document.close(); }, html);
    await printPage.waitForLoadState("load");
    await printPage.evaluate(() => document.fonts.ready);
    const rows = await printPage.evaluate(() => document.querySelectorAll(".items-table tbody tr").length);
    return { ops: textOpsPerPage(await printPage.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })), rows };
  };

  // 1) الفاتورة المبلَّغ عنها: 11 صنفاً، بأرصدة قصيرة وطويلة وأسماء طويلة ⇒ ورقة واحدة
  for (const [label, o] of [["11 صنفاً", {}], ["11 صنفاً مع حسم ودفعة", { full: true }], ["11 صنفاً بأسماء طويلة", { long: true }]]) {
    const r = await desk(11, o);
    check(`اللابتوب: ${label} ورقة واحدة (${r.ops.length})`, r.ops.length === 1);
    const p = await page.evaluate(([n, o]) => window.__phone(n, o), [11, o]);
    check(`الهاتف: ${label} ورقة واحدة (${p.pages ?? p.error})`, p.pages === 1);
  }

  // 2) مسح من 1 إلى 40 صنفاً بأطول أرصدة على مسار الطباعة الأصلية
  for (let n = 1; n <= 40; n++) {
    const r = await desk(n, { full: true });
    const nearEmpty = r.ops.map((ops, i) => (ops < NEAR_EMPTY_OPS ? i + 1 : null)).filter(Boolean);
    check(`اللابتوب ${n} صنفاً: ${r.ops.length} ورقة، لا ورقة شبه فارغة (${r.ops.join("/")})`, nearEmpty.length === 0);
    if (n <= ONE_PAGE_UP_TO) check(`اللابتوب ${n} صنفاً: ورقة واحدة`, r.ops.length === 1);
    check(`اللابتوب ${n} صنفاً: كل الأصناف مطبوعة (${r.rows}/${n})`, r.rows === n);
  }

  // 3) الهاتف: لا فشل تصدير بسبب بياض الدفع، والقصيرة ورقة واحدة
  for (const n of PHONE_SAMPLE) {
    const p = await page.evaluate(([n, o]) => window.__phone(n, o), [n, { full: true }]);
    check(`الهاتف ${n} صنفاً: تصدير ناجح (${p.pages ?? p.error})`, Number.isInteger(p.pages) && p.pages >= 1);
    if (n <= ONE_PAGE_UP_TO) check(`الهاتف ${n} صنفاً: ورقة واحدة`, p.pages === 1);
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.error("\ninvoice web one-page check FAILED");
  process.exit(1);
}
console.log("\ninvoice web one-page check passed");
