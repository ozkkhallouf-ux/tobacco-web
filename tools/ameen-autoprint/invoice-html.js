"use strict";
// قالب فاتورة A4 — نفس تصميم receipt.html (renderInvoice) المستخدم على الموقع

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// الخط الرسمي Cairo مضمَّناً base64: puppeteer يرسم عبر setContent بلا أصل
// ولا شبكة مضمونة، فلا يصل إلى عنوان woff2. أسماء الملفات والأوزان ونطاقات
// المحارف تُقرأ من المصدر الوحيد src/ozk-font.js (يُشغَّل في vm معزول)، والملفات
// من public/fonts/cairo في المستودع نفسه. أي فشل (ملف ناقص في نسخة منشورة
// جزئياً) ⇒ لا أوجه، فيُطبع بالاحتياطي Tahoma كما كان تماماً — لا يتوقف الطباعة.
const REPO_ROOT = path.resolve(__dirname, "..", "..");
let officialFontCache = null;
function officialFont() {
  if (officialFontCache) return officialFontCache;
  let result = { css: "", stack: "Tahoma,Arial,sans-serif", lineHeight: "normal" };
  try {
    const sandbox = {};
    vm.runInNewContext(fs.readFileSync(path.join(REPO_ROOT, "src", "ozk-font.js"), "utf8"), sandbox, { timeout: 1000 });
    const font = sandbox.OZK_FONT;
    const css = font.WEIGHTS.flatMap((weight) => Object.keys(font.RANGES).map((subset) => {
      const data = fs.readFileSync(path.join(REPO_ROOT, ...font.FILE(subset, weight).split("/"))).toString("base64");
      return `@font-face{font-family:"${font.FAMILY}";font-style:normal;font-weight:${weight};`
        + `src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${font.RANGES[subset]}}`;
    })).join("");
    result = { css, stack: font.STACK, lineHeight: font.DOC_LINE_HEIGHT };
  } catch {
    // الاحتياط أعلاه.
  }
  officialFontCache = result;
  return result;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

// تسمية العملة الفعلية للفاتورة (my000.CurrencyISO) — لا نص «ل.س» ثابت.
// USD → «$ 1,350»  ·  SYP أو مجهول → «1,350 ل.س»  ·  غيرهما → الرمز ISO.
function amt(inv, value) {
  const iso = String(inv && inv.currencyIso || "").trim().toUpperCase();
  // dir="ltr" يثبّت ترتيب الرمز والرقم داخل صفحة RTL، فلا يقفز «$» بين
  // بداية النص ونهايته حسب سياق الخلية.
  if (iso === "USD") return `<span dir="ltr">$ ${money(value)}</span>`;
  if (iso === "SYP" || iso === "") return `<span dir="ltr">${money(value)}</span> ل.س`;
  return `<span dir="ltr">${money(value)} ${iso}</span>`;
}

// عمودا «سعر الوحدة» و«الإجمالي» اختياريان: يطلبهما عامل أرشفة Drive وحده بعد مطابقة
// مجموع الأسطر مع إجمالي الفاتورة (lib/line-prices.js في مجلد عامل الأرشفة).
// بلا الخيار يبقى الناتج حرفياً كما هو للطباعة التلقائية واليدوية A4.
const PRICE_CSS = `<style>
  td.num, th.num { white-space:nowrap; }
  td.num { text-align:left; }
</style>`;

function pricedItems(items) {
  return items.length > 0 && items.every((it) => Number.isFinite(it.unitPrice) && Number.isFinite(it.lineTotal));
}

function buildInvoiceHtml(inv, { linePrices = false } = {}) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const net = inv.total - inv.discount;
  const remaining = net - inv.firstPay;
  const priced = linePrices === true && pricedItems(items);

  const rows = items.length
    ? items.map((it, i) =>
        `<tr><td>${i + 1}</td><td>${esc(it.name)}</td>`
        + `<td>${money(it.qty)} ${esc(it.unit)}</td>`
        + (priced ? `<td class="num">${amt(inv, it.unitPrice)}</td><td class="num">${amt(inv, it.lineTotal)}</td>` : "")
        + `</tr>`
      ).join("")
    : `<tr><td colspan="3" style="color:var(--muted)">لا توجد أصناف</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة رقم ${esc(inv.number)}</title>
<style>${officialFont().css}</style>
<style>
  :root {
    --gold:#b8892a; --ink:#221808; --muted:#6b5535;
    --line:#c8b890; --cream:#faf6ec; --card:#ece6d4;
    --red:#c0271f; --blue:#16357a;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:#fff; color:var(--ink);
              font-family:${officialFont().stack}; line-height:${officialFont().lineHeight}; }
  .wrap { max-width:720px; margin:0 auto; padding:14px; }
  .doc { background:#fff; border:1px solid var(--line); border-radius:12px;
         padding:22px 22px 16px; }
  .head { display:flex; justify-content:space-between; align-items:center;
          border-bottom:2px solid var(--gold); padding-bottom:12px;
          margin-bottom:16px; gap:10px; }
  .brand { font-weight:900; font-size:20px; }
  .brand small { display:block; font-weight:400; font-size:11px; color:var(--muted); }
  .reg-line { text-align:center; font-size:12px; font-weight:700; color:var(--muted);
              margin-bottom:14px; }
  .sale-desc { text-align:center; font-size:12.5px; font-weight:700; color:var(--ink);
               background:var(--cream); border:1px solid var(--line); border-radius:8px;
               padding:8px 10px; margin:10px 0; }
  .title { text-align:left; }
  .title h1 { margin:0; font-size:19px; color:var(--gold); white-space:nowrap; }
  .title span { font-size:11px; color:var(--muted); }
  .cust { background:var(--cream); border:1px solid var(--line); border-radius:10px;
          padding:12px 14px; display:flex; justify-content:space-between;
          align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
  .cust .nm { font-weight:900; font-size:16px; }
  .cust .meta { font-size:12px; color:var(--muted); }
  .amount-box { text-align:left; }
  .amount-box .lbl { font-size:12px; color:var(--muted); }
  .amount-box .big { font-size:26px; font-weight:900; color:var(--red); direction:ltr; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin:8px 0; }
  th { background:var(--card); padding:8px; text-align:right;
       border:1px solid var(--line); font-size:12px; }
  td { padding:7px 8px; border:1px solid var(--line); }
  tr:nth-child(even) td { background:var(--cream); }
  .totrow td { background:var(--card); font-weight:900; }
  .rows { margin:10px 0; }
  .row { display:flex; justify-content:space-between; padding:9px 4px;
         border-bottom:1px dashed var(--line); font-size:14px; }
  .row b { direction:ltr; }
  .foot { margin-top:16px; border-top:1px solid var(--line); padding-top:10px;
          display:flex; justify-content:space-between; font-size:11px;
          color:var(--muted); flex-wrap:wrap; gap:6px; }
  .stamp-wrap { margin-top:16px; display:flex; justify-content:flex-start; }
  .seal { border:2.5px solid #16357a; outline:1.5px solid #16357a;
          outline-offset:3px; border-radius:12px; color:#16357a;
          padding:9px 20px; text-align:center; transform:rotate(-5deg);
          opacity:.9; line-height:1.45; display:inline-block; }
  .seal .s-name { font-size:15px; font-weight:900; }
  .seal .s-sub  { font-size:12px; font-weight:700; }
  .seal .s-logo { font-size:18px; font-weight:900; letter-spacing:1px; margin:2px 0; }
  .seal .s-info { font-size:10.5px; font-weight:700; }
  .seal .s-addr { font-size:11px; font-weight:700; border-top:1px solid #16357a;
                  margin-top:4px; padding-top:3px; }
  /* فاصل الصفحات: سطر الجدول لا يُشطر، ورأس الجدول يتكرر في كل صفحة، والختم مع
     التذييل كتلة واحدة مع ملخص الدفع وصفة البيع — فلا تبدأ صفحة بالختم أو
     بالتذييل وحدهما. */
  tr { break-inside:avoid; }
  .closing { break-inside:avoid; }
  @page { size:A4 portrait; margin:12mm; }
  /* إطار المستند مخفي في الطباعة، فحشوته الرأسية فراغ أبيض يدفع آخر المحتوى إلى
     صفحة ثانية (فاتورة 11 سطراً). الحشوة الأفقية تبقى كي لا يتغيّر عرض الجدول. */
  @media print {
    .doc { border:none; box-shadow:none; border-radius:0; padding-top:0; padding-bottom:0; }
    .wrap { padding-top:0; padding-bottom:0; }
  }
</style>
${priced ? PRICE_CSS : ""}</head>
<body>
<div class="wrap">
  <div class="doc">
    <div class="head">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="brand">OZK TOBACCO
          <small>مركز أبو زياد — لتجارة الدخان</small>
        </div>
      </div>
      <div class="title">
        <h1>فاتورة</h1>
        <span>رقم: ${esc(inv.number)} · ${esc(inv.date)}</span>
      </div>
    </div>

    <div class="reg-line">رقم السجل التجاري: 0310109105</div>

    <div class="cust">
      <div>
        <div class="nm">${esc(inv.customer || "—")}</div>
      </div>
      <div class="amount-box">
        <div class="lbl">إجمالي الفاتورة</div>
        <div class="big">${amt(inv, inv.total)}</div>
      </div>
    </div>

    <table>
      <thead><tr><th>#</th><th>الصنف</th><th>الكمية</th>${priced ? `<th class="num">سعر الوحدة</th><th class="num">الإجمالي</th>` : ""}</tr></thead>
      <tbody>
      ${rows}
      <tr class="totrow">
        <td colspan="${priced ? 4 : 2}">إجمالي الفاتورة</td>
        <td>${amt(inv, inv.total)}</td>
      </tr>
      </tbody>
    </table>

    <div class="closing">
    <div class="rows">
      ${inv.discount > 0 ? `<div class="row"><span>الحسم</span><b>${amt(inv, inv.discount)}</b></div>` : ""}
      ${inv.discount > 0 ? `<div class="row"><span>الصافي</span><b>${amt(inv, net)}</b></div>` : ""}
      <div class="row"><span>المدفوع</span><b>${amt(inv, inv.firstPay)}</b></div>
      <div class="row"><span>المتبقي من هذه الفاتورة</span><b>${amt(inv, remaining)}</b></div>
      ${inv.customerBalanceFound
        ? `<div class="row"><span>الرصيد الحالي للزبون</span><b>${amt(inv, inv.customerBalance)}</b></div>`
        : `<div class="row"><span>الرصيد الحالي للزبون</span><b style="color:var(--muted)">غير متاح</b></div>`
      }
    </div>

    <div class="sale-desc">صفة البيع: من تاجر جملة الجملة إلى تاجر جملة ومفرق</div>

    <div class="stamp-wrap">
      <div class="seal">
        <div class="s-name">مركز أبو زياد</div>
        <div class="s-sub">لتجارة الدخان</div>
        <div class="s-logo">OZK TOBACCO</div>
        <div class="s-info" dir="ltr">0985000771 - 0984000662 · رقم المركز: 0994092038</div>
        <div class="s-addr">دوما — ساحة الغنم</div>
      </div>
    </div>

    <div class="foot">
      <span>صادر آليًا عن نظام OZK TOBACCO · رقم المركز: 0994092038</span>
      <span dir="ltr">0985000771 — 0984000662</span>
    </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

module.exports = { buildInvoiceHtml };
