// ============================================================================
// تقسيم صفحات فاتورة الجملة A4 (tools/ameen-autoprint/invoice-html.js) — القالب
// المشترك بين أداة الطباعة اليدوية A4 ومراقب الطباعة التلقائية وعامل أرشفة Drive.
//
// العطل (فاتورة 1100، 2026-10-25): فاتورة 11 سطراً خرجت صفحتين، الثانية لا تحمل
// إلا سطر التذييل. السبب: حشوة الإطار الرأسية تبقى في الطباعة رغم إخفاء الإطار،
// والتذييل آخر عنصر فينزلق وحده.
//
// الفحص يولّد PDF حقيقياً بـChromium (نفس pdfOptions) لفواتير قصيرة وطويلة
// ومتعددة الصفحات وA5، ثم يقرأ محتوى كل صفحة: يلوّن الاختبار وحده (CSS لون فقط،
// بلا أثر على التخطيط) أسطر الجدول وملخص الدفع والختم والتذييل بألوان فريدة،
// ويبحث عن أوامر الرسم بها في تيار كل صفحة بعد فك ضغطه.
// ============================================================================
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { buildInvoiceHtml } = require(path.join(root, "tools/ameen-autoprint/invoice-html.js"));
const { PAPERS, pdfOptions, applyPaperCss } = require(path.join(root, "tools/manual-a4-print/lib/paper.js"));

// ألوان العلامات: قيم صافية يكتبها Chromium في تيار الصفحة «r g b rg» حرفياً.
const MARK = { row: "1 1 0 rg", sums: "1 0 1 rg", seal: "0 1 1 rg", foot: "0 0 1 rg" };
const MARK_CSS = `<style>
  table tbody tr:not(.totrow) td { color:#ffff00 !important; }
  .rows .row, .rows .row b { color:#ff00ff !important; }
  .seal, .seal div { color:#00ffff !important; }
  .seal { opacity:1 !important; } /* الشفافية ترسم الختم في XObject منفصل خارج تيار الصفحة */
  .foot, .foot span { color:#0000ff !important; }
</style>`;

const NAMES = ["اوسكار طويل", "اوسكار سليم فضي", "جيتان قصير", "كابتن بلاك كور اسود جديد", "كابتن بلاك كوين ذهبي",
  "اليغانس طويل فضي", "غلواز كوين أحمر", "غلواز كوين أصفر", "أوريس منغا", "روز طويل فضي", "يونايتد"];
const LONG = " صنف باسم طويل جداً جداً لاختبار التفاف السطر داخل خلية الجدول عند الطباعة";

function invoice(n, { discount = false, longItems = false } = {}) {
  return {
    number: 9001, date: "2026-10-25", customer: "زبون اختبار", currencyIso: "USD",
    total: 5538, discount: discount ? 38 : 0, firstPay: 0, customerBalanceFound: true, customerBalance: 12670,
    items: Array.from({ length: n }, (_, i) => ({ name: NAMES[i % NAMES.length] + (longItems ? LONG : ""), unit: "كرتونة", qty: (i % 3) + 1 })),
  };
}

// تيارات محتوى الصفحات بترتيب /Kids (شجرة الصفحات قد تتداخل).
function pageContents(pdf) {
  const s = pdf.toString("latin1");
  const objects = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) objects.set(Number(m[1]), { body: m[2], at: m.index + m[0].indexOf(m[2]) });
  const streamOf = (id) => {
    const o = objects.get(id);
    const len = /\/Length (\d+)( 0 R)?/.exec(o.body);
    const n = len[2] ? Number(/^\s*(\d+)/.exec(objects.get(Number(len[1])).body)[1]) : Number(len[1]);
    const start = o.at + o.body.indexOf("stream") + "stream".length + (s[o.at + o.body.indexOf("stream") + 6] === "\r" ? 2 : 1);
    const raw = pdf.subarray(start, start + n);
    return /\/FlateDecode/.test(o.body) ? zlib.inflateSync(raw).toString("latin1") : raw.toString("latin1");
  };
  const rootPages = [...objects.entries()].find(([, o]) => /\/Type\s*\/Pages/.test(o.body) && !/\/Parent/.test(o.body));
  const out = [];
  const walk = (id) => {
    const o = objects.get(id).body;
    if (/\/Type\s*\/Pages/.test(o)) {
      for (const k of /\/Kids\s*\[([^\]]*)\]/.exec(o)[1].matchAll(/(\d+) 0 R/g)) walk(Number(k[1]));
      return;
    }
    const c = /\/Contents\s*(?:\[\s*)?(\d+) 0 R/.exec(o);
    out.push(streamOf(Number(c[1])));
  };
  walk(rootPages[0]);
  return out;
}

const browser = await chromium.launch(process.env.OZK_CHROME_PATH ? { executablePath: process.env.OZK_CHROME_PATH } : {});
const page = await browser.newPage();
async function layout(n, opts, paperKey = "A4") {
  const paper = PAPERS[paperKey];
  const html = applyPaperCss(buildInvoiceHtml(invoice(n, opts)), paper).replace("</head>", `${MARK_CSS}</head>`);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const pdf = await page.pdf(pdfOptions(paper));
  return pageContents(pdf).map((c) => Object.fromEntries(Object.entries(MARK).map(([k, v]) => [k, new RegExp(`(^|\\s)${v}(\\s|$)`).test(c)])));
}

let cases = 0;
try {
  // ١) فاتورة 1100 (11 سطراً، بلا حسم): صفحة واحدة كاملة.
  const f1100 = await layout(11, {});
  assert.equal(f1100.length, 1, "فاتورة 11 سطراً بلا حسم تخرج صفحة واحدة");
  assert.deepEqual(f1100[0], { row: true, sums: true, seal: true, foot: true }, "الصفحة الواحدة تحمل الجدول والملخص والختم والتذييل");

  // ٢) لا قص ولا تصغير: أحجام الخط وعرض الجدول كما هي في وسط الطباعة.
  await page.emulateMedia({ media: "print" });
  await page.setContent(buildInvoiceHtml(invoice(3)), { waitUntil: "load" });
  const css = await page.evaluate(() => {
    const px = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    return { td: px("td", "fontSize"), th: px("th", "fontSize"), row: px(".row", "fontSize"), foot: px(".foot", "fontSize"),
      big: px(".amount-box .big", "fontSize"), wrapX: px(".wrap", "paddingLeft"), docX: px(".doc", "paddingLeft"),
      repeatHead: px("thead", "display") };
  });
  assert.deepEqual(css, { td: "13px", th: "12px", row: "14px", foot: "11px", big: "26px", wrapX: "14px", docX: "22px", repeatHead: "table-header-group" },
    "أحجام الخط والحشوة الأفقية ثابتة، ورأس الجدول thead يتكرر في كل صفحة");
  await page.emulateMedia({ media: null });

  // ٣) قصيرة وطويلة ومتعددة الصفحات، A4 وA5.
  const VARIANTS = [["A4", {}], ["A4", { discount: true }], ["A4", { longItems: true }], ["A5", {}]];
  for (const [paperKey, opts] of VARIANTS) {
    for (const n of [1, 8, 10, 11, 12, 13, 15, 20, 22, 25, 30, 40, 45, 50, 60]) {
      const pages = await layout(n, opts, paperKey);
      const label = `${paperKey} ${JSON.stringify(opts)} ${n} سطراً`;
      const last = pages[pages.length - 1];
      assert.ok(last.sums && last.seal && last.foot, `${label}: الملخص والختم والتذييل معاً في الصفحة الأخيرة`);
      pages.forEach((p, i) => {
        assert.ok(p.row || p.sums, `${label}: الصفحة ${i + 1} ليست فارغة من البيانات`);
        if (p.foot || p.seal) assert.ok(p.sums, `${label}: الصفحة ${i + 1} لا تبدأ بالختم أو التذييل وحدهما`);
        if (i < pages.length - 1) assert.ok(p.row && !p.foot && !p.seal, `${label}: الصفحة ${i + 1} أسطر جدول فقط قبل الخاتمة`);
      });
      assert.ok(pages.some((p) => p.row), `${label}: أسطر الجدول موجودة`);
      cases++;
    }
  }
} finally {
  await browser.close();
}
console.log(`check-invoice-a4-pagination: اجتاز ${cases + 2} حالة (فاتورة 1100 صفحة واحدة، لا تذييل ولا ختم منفردان، الخط والعرض ثابتان).`);
