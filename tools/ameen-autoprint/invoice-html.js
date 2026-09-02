"use strict";
// قالب فاتورة A4 — نفس تصميم receipt.html (renderInvoice) المستخدم على الموقع

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function buildInvoiceHtml(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const net = inv.total - inv.discount;
  const remaining = net - inv.firstPay;

  const rows = items.length
    ? items.map((it, i) =>
        `<tr><td>${i + 1}</td><td>${esc(it.name)}</td>`
        + `<td>${money(it.qty)} ${esc(it.unit)}</td></tr>`
      ).join("")
    : `<tr><td colspan="3" style="color:var(--muted)">لا توجد أصناف</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة رقم ${esc(inv.number)}</title>
<style>
  :root {
    --gold:#b8892a; --ink:#221808; --muted:#6b5535;
    --line:#c8b890; --cream:#faf6ec; --card:#ece6d4;
    --red:#c0271f; --blue:#16357a;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:#fff; color:var(--ink);
              font-family:Tahoma,Arial,sans-serif; }
  .wrap { max-width:720px; margin:0 auto; padding:14px; }
  .doc { background:#fff; border:1px solid var(--line); border-radius:12px;
         padding:22px 22px 16px; }
  .head { display:flex; justify-content:space-between; align-items:center;
          border-bottom:2px solid var(--gold); padding-bottom:12px;
          margin-bottom:16px; gap:10px; }
  .brand { font-weight:900; font-size:20px; }
  .brand small { display:block; font-weight:400; font-size:11px; color:var(--muted); }
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
  @page { size:A4 portrait; margin:12mm; }
  @media print { .doc { border:none; box-shadow:none; border-radius:0; } }
</style>
</head>
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

    <div class="cust">
      <div>
        <div class="nm">${esc(inv.customer || "—")}</div>
      </div>
      <div class="amount-box">
        <div class="lbl">إجمالي الفاتورة</div>
        <div class="big">${money(inv.total)} ل.س</div>
      </div>
    </div>

    <table>
      <tr><th>#</th><th>الصنف</th><th>الكمية</th></tr>
      ${rows}
      <tr class="totrow">
        <td colspan="2">إجمالي الفاتورة</td>
        <td>${money(inv.total)} ل.س</td>
      </tr>
    </table>

    <div class="rows">
      ${inv.discount > 0 ? `<div class="row"><span>الحسم</span><b>${money(inv.discount)} ل.س</b></div>` : ""}
      ${inv.discount > 0 ? `<div class="row"><span>الصافي</span><b>${money(net)} ل.س</b></div>` : ""}
      <div class="row"><span>المدفوع</span><b>${money(inv.firstPay)} ل.س</b></div>
      <div class="row"><span>الرصيد الحالي</span><b>${money(remaining)} ل.س</b></div>
    </div>

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
</body>
</html>`;
}

module.exports = { buildInvoiceHtml };
