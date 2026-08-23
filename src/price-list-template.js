(function initOzkPriceListTemplate(root) {
  "use strict";

  const VERSION = "2026-08-20-new-bulletin";
  const RIGHT_GROUPS = ["ماستر", "كابتن بلاك", "اوسكار", "اختمار", "روز", "1970", "كينغ دوم", "مانشستر"];
  const LEFT_GROUPS = ["غلواز", "اليغانس", "تي اس", "أوريس", "حمرا", "يونايتد", "ولسون", "نابولي"];
  const SPECIAL_RIGHT_GROUPS = ["فحم", "ورق", "فيبات", "قداحات", "سلفان"];
  const SPECIAL_LEFT_GROUPS = ["معسل"];
  const SPECIAL_GROUPS = new Set([...SPECIAL_RIGHT_GROUPS, ...SPECIAL_LEFT_GROUPS, "مزايا", "نخلة"]);

  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Almarai:wght@300;400;700;800&display=swap');
    @page { size: A4 portrait; margin: 0; }
    .ozk-price-list, .ozk-price-list * { box-sizing: border-box; }
    .ozk-price-list {
      --page:#0c0a07; --surface:#141009; --surface-alt:#0f0c07; --surface-strong:#1a1208;
      --text:#f3ead2; --muted:#a88d61; --line:#33240d; --gold:#d7a83f;
      --gold-strong:#efc45d; --button-text:#0c0a07;
      width:100%; margin:0; padding:0; overflow:hidden; background:var(--page); color:var(--text);
      direction:rtl; font-family:'Almarai',Tahoma,Arial,sans-serif; transition:background .2s ease,color .2s ease;
    }
    .ozk-price-list[data-theme="light"] {
      --page:#fffdf8; --surface:#ffffff; --surface-alt:#f8f3e8; --surface-strong:#5b3a09;
      --text:#211b12; --muted:#796a54; --line:#e4d8c1; --gold:#a56f09;
      --gold-strong:#7a4f00; --button-text:#ffffff;
    }
    .ozk-price-list .price-list-header {
      background:var(--page); padding:10px 14px 8px; display:flex; align-items:center;
      justify-content:space-between; gap:10px; border-bottom:2px solid var(--gold);
    }
    .ozk-price-list .price-list-header-logo { height:48px; width:auto; }
    .ozk-price-list .price-list-header-center { flex:1; text-align:center; }
    .ozk-price-list .price-list-header-title {
      font-size:20px; font-weight:900; color:var(--gold-strong); letter-spacing:1px;
    }
    .ozk-price-list .price-list-header-date {
      font-size:10.5px; color:var(--muted); margin-top:2px; font-weight:600; direction:ltr;
    }
    .ozk-price-list .price-list-currency-badge {
      display:inline-block; padding:3px 12px; border-radius:20px; font-size:10.5px;
      font-weight:700; margin-top:4px; letter-spacing:.3px; white-space:nowrap;
      padding-inline-start:12px; padding-inline-end:32px;
    }
    .ozk-price-list .badge-usd { background:var(--gold); color:var(--button-text); }
    .ozk-price-list .badge-syp { background:#2d6a2d; color:#c8f0c8; }
    .ozk-price-list .new-syria-flag {
      display:inline-grid; grid-template-rows:repeat(3,3px); width:16px; height:9px; overflow:hidden;
      border:1px solid rgba(255,255,255,.45); border-radius:1px; vertical-align:middle;
      direction:ltr; margin-inline-end:4px;
    }
    .ozk-price-list .new-syria-flag .green { background:#16813b; }
    .ozk-price-list .new-syria-flag .white {
      background:#fff; color:#d71920; font-size:4px; line-height:3px; letter-spacing:1px; text-align:center;
    }
    .ozk-price-list .new-syria-flag .black { background:#111; }
    .ozk-price-list .price-list-header-right { min-width:62px; text-align:left; }
    .ozk-price-list .price-list-subheader {
      background:var(--surface-alt); border-bottom:1px solid var(--line); padding:4px 14px;
      font-size:9px; color:var(--muted); display:flex; justify-content:space-between;
      font-weight:600; letter-spacing:.2px; margin-bottom:6px;
    }
    .ozk-price-list .price-list-subheader strong { color:var(--gold-strong); }
    .ozk-price-list .price-list-phones { display:flex; flex-direction:column; align-items:flex-end; gap:0; }
    .ozk-price-list .price-list-phones span {
      font-size:11px; color:var(--muted); font-weight:800; direction:ltr; line-height:1.35;
    }
    .ozk-price-list .price-list-phones .location { color:var(--gold-strong); direction:rtl; }
    .ozk-price-list .price-list-columns {
      display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; align-items:start;
      padding:0 8px 8px; background:var(--page); position:relative;
    }
    .ozk-price-list .price-list-columns::before {
      content:""; position:absolute; top:0; bottom:8px; left:50%; width:2px;
      transform:translateX(-50%); background:var(--gold); border-radius:2px;
    }
    .ozk-price-list .price-list-column-stack {
      min-width:0; background:var(--page); position:relative; z-index:1;
    }
    .ozk-price-list .price-list-secondary-page {
      break-before:page; page-break-before:always; margin-top:8px;
    }
    .ozk-price-list .price-list-group {
      break-inside:avoid; -webkit-column-break-inside:avoid; margin-bottom:5px;
      border:1px solid var(--line); border-radius:3px; overflow:hidden;
    }
    .ozk-price-list .price-list-group-header {
      background:var(--surface-strong); border-bottom:1px solid var(--line); padding:3.5px 9px;
      font-size:11px; font-weight:900; color:#f2c55c; display:flex; justify-content:space-between;
      align-items:center; letter-spacing:.3px;
    }
    .ozk-price-list .price-list-group-count {
      font-size:8.5px; background:rgba(255,255,255,.12); color:#f4d184;
      border-radius:8px; padding:1px 6px; font-weight:700;
    }
    .ozk-price-list table { width:100%; border-collapse:collapse; }
    .ozk-price-list td { padding:2.5px 8px; border-bottom:1px solid var(--line); font-size:10px; }
    .ozk-price-list td.name { font-weight:700; color:var(--text); width:54%; }
    .ozk-price-list td.unit { color:var(--muted); text-align:center; width:16%; font-size:9px; }
    .ozk-price-list td.price {
      font-weight:900; text-align:left; direction:ltr; font-size:10.5px; color:var(--gold-strong); width:30%;
    }
    .ozk-price-list tr.odd { background:var(--surface); }
    .ozk-price-list tr.even { background:var(--surface-alt); }
    .ozk-price-list tr:last-child td { border-bottom:none; }
    .ozk-price-list .price-list-document-tools {
      position:fixed; top:12px; left:12px; z-index:999; display:flex; flex-wrap:wrap; gap:6px;
    }
    .ozk-price-list .price-list-document-tools button,
    .ozk-price-list .price-list-document-tools a {
      background:var(--gold); color:var(--button-text); border:1px solid var(--gold); padding:8px 12px;
      border-radius:6px; font-size:11px; font-weight:900; cursor:pointer;
      font-family:'Almarai',Tahoma,sans-serif; text-decoration:none;
    }
    .ozk-price-list .price-list-document-tools .theme-switch {
      background:var(--surface); color:var(--text); border-color:var(--line);
    }
    @media screen and (max-width:720px) {
      .ozk-price-list .price-list-columns { grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; padding:0 4px 6px; }
      .ozk-price-list.has-document-tools .price-list-header { padding-top:102px; }
      .ozk-price-list .price-list-document-tools { right:10px; left:10px; justify-content:center; }
      .ozk-price-list .price-list-group { margin-bottom:3px; }
      .ozk-price-list .price-list-group-header { padding:4px 5px; font-size:9px; }
      .ozk-price-list td { padding:3px 4px; font-size:8px; }
      .ozk-price-list td.name { width:55%; }
      .ozk-price-list td.unit { width:15%; font-size:7px; }
      .ozk-price-list td.price { width:30%; font-size:8px; }
    }
    @media print {
      .ozk-price-list, .ozk-price-list .price-list-columns, .ozk-price-list .price-list-column-stack {
        background:var(--page) !important;
      }
      .ozk-price-list { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
      .ozk-price-list .no-print { display:none !important; }
      .ozk-price-list .price-list-secondary-page {
        break-before:page; page-break-before:always; break-inside:avoid-page; page-break-inside:avoid; margin-top:0;
      }
    }
  `;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function layoutGroups(groups) {
    const safeGroups = Array.isArray(groups) ? groups : [];
    const byName = new Map(safeGroups.map((group) => [String(group?.name || ""), group]));
    const take = (names) => names.map((name) => byName.get(name)).filter(Boolean);
    const right = take(RIGHT_GROUPS);
    const left = take(LEFT_GROUPS);
    const reserved = new Set([...right, ...left].map((group) => group.name));
    const remaining = safeGroups.filter((group) => !reserved.has(group.name) && !SPECIAL_GROUPS.has(group.name));
    const height = (stack) => stack.reduce((sum, group) => sum + (group.items?.length || 0) + 1, 0);
    remaining.forEach((group) => (height(right) <= height(left) ? right : left).push(group));
    return {
      right,
      left,
      specialRight: take(SPECIAL_RIGHT_GROUPS),
      specialLeft: take(SPECIAL_LEFT_GROUPS)
    };
  }

  function renderGroup(group) {
    const items = Array.isArray(group?.items) ? group.items : [];
    return `
      <div class="price-list-group">
        <div class="price-list-group-header">
          <span>${escapeHtml(group?.name)}</span>
          <span class="price-list-group-count">${items.length}</span>
        </div>
        <table><tbody>${items.map((item, index) => `
          <tr class="${index % 2 === 0 ? "odd" : "even"}">
            <td class="name">${escapeHtml(item?.name)}</td>
            <td class="unit">${escapeHtml(item?.unit)}</td>
            <td class="price">${escapeHtml(item?.price)}</td>
          </tr>`).join("")}
        </tbody></table>
      </div>`;
  }

  function renderStack(groups) {
    return groups.map(renderGroup).join("\n");
  }

  function pageCount(groups) {
    const layout = layoutGroups(groups);
    return 1 + (layout.specialRight.length || layout.specialLeft.length ? 1 : 0);
  }

  function render(options = {}) {
    const groups = Array.isArray(options.groups) ? options.groups : [];
    const layout = layoutGroups(groups);
    const tools = options.tools || null;
    const toolsMarkup = tools ? `
      <div class="price-list-document-tools no-print">
        <button type="button" onclick="window.print()">طباعة مباشرة</button>
        <a data-pdf-open href="${escapeHtml(tools.pdfFile)}">فتح PDF</a>
        <a data-pdf-download href="${escapeHtml(tools.pdfFile)}" download>تنزيل PDF</a>
        <button class="theme-switch" type="button" onclick="toggleTheme()">فاتح / داكن</button>
      </div>` : "";
    const specialMarkup = layout.specialRight.length || layout.specialLeft.length ? `
      <div class="price-list-columns price-list-secondary-page">
        <div class="price-list-column-stack">${renderStack(layout.specialRight)}</div>
        <div class="price-list-column-stack">${renderStack(layout.specialLeft)}</div>
      </div>` : "";
    return `
      <style data-ozk-price-list-style="${VERSION}">${CSS}</style>
      <section class="ozk-price-list${tools ? " has-document-tools" : ""}" data-theme="${options.theme === "light" ? "light" : "dark"}" data-template-version="${VERSION}">
        ${toolsMarkup}
        <header class="price-list-header">
          <img src="${escapeHtml(options.logoSrc)}" alt="OZK TOBACCO" class="price-list-header-logo">
          <div class="price-list-header-center">
            <div class="price-list-header-title">نشرة الأسعار</div>
            <div class="price-list-header-date">${escapeHtml(options.issueDate)}</div>
            <span class="price-list-currency-badge ${escapeHtml(options.badgeClass)}">${options.badgeLabelHtml || ""}</span>
          </div>
          <div class="price-list-header-right" aria-hidden="true"></div>
        </header>
        <div class="price-list-subheader">
          <span>السعر المعروض: <strong>${escapeHtml(options.unitLabel)}</strong></span>
          <div class="price-list-phones">
            <span>0985000771</span><span>0984000662</span><span>مركز: 0994092038</span>
            <span class="location">دوما - ساحة الغنم</span>
          </div>
        </div>
        <div class="price-list-columns">
          <div class="price-list-column-stack">${renderStack(layout.right)}</div>
          <div class="price-list-column-stack">${renderStack(layout.left)}</div>
        </div>
        ${specialMarkup}
      </section>`;
  }

  root.OZKPriceListTemplate = Object.freeze({ VERSION, CSS, layoutGroups, pageCount, render });
})(globalThis);
