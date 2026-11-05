"use strict";
// قالب سند القبض A4 للأرشيف — تصميم سند القبض نفسه في الموقع (voucherPdfMarkup في src/app.js:
// العنوان والرقم والتاريخ، الزبون، «المبلغ المستلم» بالأخضر، أسطر الرصيد، الختم، التذييل)، وألوان
// قالب الفاتورة A4 وخط Cairo المضمَّن من المصدر نفسه (../../ameen-autoprint/invoice-html.js
// ← src/ozk-font.js). بلا خط مضمَّن يرفض العامل الأرشفة (requireOfficialFont).

const { officialFont } = require("../../ameen-autoprint/invoice-html");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function money(n, digits = 2) {
  const x = Number(n || 0);
  return x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

// USD → «$ 1,350» · SYP → «1,350 ل.س» · غيرهما → ISO. الدولار بخانتين، والليرة بلا كسور.
function amt(iso, value) {
  const code = String(iso || "").trim().toUpperCase();
  if (code === "USD" || code === "") return `<span dir="ltr">$ ${money(value, 2)}</span>`;
  if (code === "SYP") return `<span dir="ltr">${money(value, 0)}</span> ل.س`;
  return `<span dir="ltr">${money(value, 2)} ${esc(code)}</span>`;
}

function balanceRows(doc) {
  const b = doc.balance;
  if (!b) return `<div class="row"><span>رصيد الحساب</span><b style="color:var(--muted)">غير متاح</b></div>`;
  return `<div class="row"><span>الرصيد قبل السند</span><b>${amt("USD", b.previous)}</b></div>`
    + `<div class="row"><span>الرصيد بعد الدفعة</span><b>${amt("USD", b.current)}</b></div>`;
}

function buildReceiptHtml(doc) {
  const font = officialFont();
  const lines = Array.isArray(doc.lines) ? doc.lines : [];
  const foreign = String(doc.currencyIso || "USD").toUpperCase() !== "USD";
  const many = lines.length > 1;
  const lineRows = lines.map((l, i) => `<tr><td>${i + 1}</td>`
    + `<td>${amt(foreign ? doc.currencyIso : "USD", foreign ? l.nativeAmount : l.amount)}</td>`
    + (foreign ? `<td>${amt("USD", l.amount)}</td>` : "")
    + `<td>${esc(l.cashName || "—")}</td><td>${esc(l.notes || "")}</td></tr>`).join("");
  const single = lines[0] || {};
  const statement = [doc.notes, many ? "" : single.notes].filter((s, i, a) => s && a.indexOf(s) === i).join(" — ");

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>سند قبض رقم ${esc(doc.number)}</title>
<style>${font.css}</style>
<style>
  :root { --gold:#b8892a; --ink:#221808; --muted:#6b5535; --line:#c8b890; --cream:#faf6ec; --card:#ece6d4; --green:#16794f; }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:#fff; color:var(--ink); font-family:${font.stack}; line-height:${font.lineHeight}; }
  .wrap { max-width:720px; margin:0 auto; padding:14px; }
  .doc { background:#fff; border:1px solid var(--line); border-radius:12px; padding:22px 22px 16px; }
  .head { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid var(--gold);
          padding-bottom:12px; margin-bottom:16px; gap:10px; }
  .brand { font-weight:900; font-size:20px; }
  .brand small { display:block; font-weight:400; font-size:11px; color:var(--muted); }
  .title { text-align:left; }
  .title h1 { margin:0; font-size:19px; color:var(--gold); white-space:nowrap; }
  .title span { font-size:11px; color:var(--muted); }
  .cust { background:var(--cream); border:1px solid var(--line); border-radius:10px; padding:12px 14px; display:flex;
          justify-content:space-between; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap; }
  .cust .nm { font-weight:900; font-size:16px; }
  .cust .meta { font-size:12px; color:var(--muted); }
  .amount-box { text-align:left; }
  .amount-box .lbl { font-size:12px; color:var(--muted); }
  .amount-box .big { font-size:26px; font-weight:900; color:var(--green); direction:ltr; }
  .amount-box .eq { font-size:12px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:13px; margin:8px 0; }
  th { background:var(--card); padding:8px; text-align:right; border:1px solid var(--line); font-size:12px; }
  td { padding:7px 8px; border:1px solid var(--line); }
  tr:nth-child(even) td { background:var(--cream); }
  .rows { margin:10px 0; }
  .row { display:flex; justify-content:space-between; padding:9px 4px; border-bottom:1px dashed var(--line); font-size:14px; }
  .row b { direction:ltr; }
  .note { font-size:12.5px; color:var(--muted); margin:10px 0 0; }
  .closing { break-inside:avoid; }
  .stamp-wrap { margin-top:16px; display:flex; justify-content:flex-start; }
  .seal { border:2.5px solid #16357a; outline:1.5px solid #16357a; outline-offset:3px; border-radius:12px; color:#16357a;
          padding:9px 20px; text-align:center; transform:rotate(-5deg); opacity:.9; line-height:1.45; display:inline-block; }
  .seal .s-name { font-size:15px; font-weight:900; }
  .seal .s-sub  { font-size:12px; font-weight:700; }
  .seal .s-logo { font-size:18px; font-weight:900; letter-spacing:1px; margin:2px 0; }
  .seal .s-info { font-size:10.5px; font-weight:700; }
  .seal .s-addr { font-size:11px; font-weight:700; border-top:1px solid #16357a; margin-top:4px; padding-top:3px; }
  .foot { margin-top:16px; border-top:1px solid var(--line); padding-top:10px; display:flex; justify-content:space-between;
          font-size:11px; color:var(--muted); flex-wrap:wrap; gap:6px; }
  @page { size:A4 portrait; margin:12mm; }
  @media print { .doc { border:none; box-shadow:none; border-radius:0; padding-top:0; padding-bottom:0; } .wrap { padding-top:0; padding-bottom:0; } }
</style></head>
<body>
<div class="wrap">
  <div class="doc">
    <div class="head">
      <div class="brand">OZK TOBACCO<small>مركز أبو زياد — لتجارة الدخان</small></div>
      <div class="title"><h1>سند قبض</h1><span>${doc.sourceKind === "entry" ? "رقم القيد" : "رقم"}: ${esc(doc.number)} · ${esc(doc.date)}</span></div>
    </div>

    <div class="cust">
      <div><div class="nm">${esc(doc.customer || "زبون غير محدد")}</div>
        ${!many && single.cashName ? `<div class="meta">الصندوق: ${esc(single.cashName)}</div>` : ""}</div>
      <div class="amount-box"><div class="lbl">المبلغ المستلم</div>
        <div class="big">${amt(doc.currencyIso, doc.amount)}</div>
        ${foreign ? `<div class="eq">المعادل: ${amt("USD", doc.amountUsd)}</div>` : ""}</div>
    </div>

    ${many ? `<table>
      <thead><tr><th>#</th><th>المبلغ</th>${foreign ? "<th>المعادل بالدولار</th>" : ""}<th>الصندوق</th><th>البيان</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>` : ""}

    <div class="closing">
      <div class="rows">
        ${statement ? `<div class="row"><span>البيان</span><span>${esc(statement)}</span></div>` : ""}
        ${balanceRows(doc)}
      </div>
      <p class="note">شكراً لتعاملكم مع OZK TOBACCO. هذا سند رسمي بالمبلغ المستلم.</p>
      <div class="stamp-wrap"><div class="seal">
        <div class="s-name">مركز أبو زياد</div>
        <div class="s-sub">لتجارة الدخان</div>
        <div class="s-logo">OZK TOBACCO</div>
        <div class="s-info" dir="ltr">0985000771 - 0984000662 · رقم المركز: 0994092038</div>
        <div class="s-addr">دوما — ساحة الغنم</div>
      </div></div>
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

module.exports = { buildReceiptHtml, amt };
