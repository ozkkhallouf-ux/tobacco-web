// ============================================================================
// OZK MASTER INVOICE TEMPLATE — قالب الفاتورة الرسمي الموحّد
//
// المرجع البصري المعتمد: فاتورة «لؤي خلوف المحترم - الضاحية» رقم 634.
// هذا الملف هو مصدر الحقيقة البصري لكل مستندات الفواتير:
//   فاتورة مبيعات · مرتجع مبيعات · فاتورة مشتريات · مرتجع مشتريات
//
// ---------------------------------------------------------------------------
// لماذا ملف واحد وليس شجرة وحدات (kinds/seal/legal/adapters منفصلة)؟
//
// المشروع موقع ثابت بلا build step وبلا bundler: كل ملفات `src/*.js` تُحمَّل
// وسوماً عادية `<script defer>` في `index.html` وتتشارك النطاق العام — لا
// `import` ولا `export` في أي منها (تحقّقتُ: صفر في `src/app.js`). فكل ملف
// إضافي يعني وسماً جديداً، ومعامل نسخة جديداً يجب ألّا يُنسى، وترتيب تحميل
// جديداً يمكن أن ينكسر بصمت. ولأن حارس الاختبار يستخرج الكود من المصدر بتعابير
// نمطية، فكل ملف إضافي سطح استخراج إضافي قابل للكسر.
//
// لذلك: ملف واحد، وفضاء أسماء واحد `OZK_INVOICE`، وأقسامه الداخلية مفصولة
// كما في البنية المقترحة (STYLE / SEAL / KINDS / legalBox / markup / adapters).
// الفصل المعماري المطلوب تحقّق فعلاً: الفاتورة لم تعد تستعمل `REPORT_STYLE`
// ولا الصنف `.ozk-rpt`، بل تنسيقها الخاص وصنفها الخاص `.ozk-inv`.
// ============================================================================

const OZK_INVOICE = (() => {
  // ==========================================================================
  // 1) STYLE — تنسيق الفاتورة وحده. نسخة مستقلة عن REPORT_STYLE عمداً:
  //    قالب التقرير وقالب الفاتورة هويتان منفصلتان، وتغيير أحدهما لا يمسّ
  //    الآخر. القيم مطابقة للمرجع 634 حرفياً.
  // ==========================================================================
  const STYLE = `<style>
.ozk-inv{font-family:Tahoma,Arial,sans-serif;color:#221808;background:#fff;direction:rtl;padding:6px 10px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ozk-inv .rhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #b8892a;padding-bottom:8px;margin-bottom:12px}
.ozk-inv .brand{font-weight:900;font-size:19px}.ozk-inv .brand small{display:block;font-weight:400;font-size:10px;color:#6b5535}
.ozk-inv .rtitle{flex:1;text-align:right;white-space:nowrap;padding-right:14px}.ozk-inv .rtitle h2{margin:0;font-size:16px;color:#b8892a;white-space:nowrap}.ozk-inv .rtitle span{font-size:10px;color:#6b5535;white-space:nowrap}
.ozk-inv .balbox{background:#f6ead0;border:1px solid #b8892a;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.ozk-inv .balbox .nm{font-weight:900;font-size:15px}.ozk-inv .balbox .big{font-size:24px;font-weight:900;color:#c0271f}
.ozk-inv .muted{color:#6b5535;font-size:10.5px}
.ozk-inv .sec{font-weight:800;font-size:12.5px;margin:12px 0 4px}
.ozk-inv table{width:100%;border-collapse:collapse;font-size:12px}
.ozk-inv th{background:#ece6d4;padding:6px 8px;text-align:right;border:1px solid #c8b890;font-size:11px}
.ozk-inv td{padding:5px 8px;border:1px solid #c8b890}
.ozk-inv table{page-break-inside:auto}.ozk-inv thead{display:table-header-group}.ozk-inv tfoot{display:table-footer-group}.ozk-inv tr{page-break-inside:avoid}.ozk-inv .rhead,.ozk-inv .balbox{page-break-inside:avoid}
.ozk-inv tr:nth-child(even) td{background:#faf6ec}
.ozk-inv .deb{color:#c0271f;font-weight:700}.ozk-inv .cred{color:#16794f;font-weight:700}
.ozk-inv .rlogo{height:46px;width:auto}
.ozk-inv .legalbox{margin:10px 0 0;padding:7px 10px;border:1px solid #c8b890;border-radius:6px;background:#f6ead0;font-size:11.5px;font-weight:700;text-align:center}
.ozk-inv .rfoot{margin-top:16px;border-top:1.5px solid #b8892a;padding-top:7px;font-size:10px;color:#6b5535;display:flex;justify-content:space-between}
.ozk-inv .items-table{table-layout:fixed}
.ozk-inv .items-table td,.ozk-inv .items-table th{overflow-wrap:anywhere}
.ozk-inv .q-det{color:#6b5535;font-size:.9em}
.ozk-inv .stamp-wrap{margin-top:16px;display:flex;justify-content:flex-start;page-break-inside:avoid}
.ozk-inv .seal{border:2.5px solid #16357a;outline:1.5px solid #16357a;outline-offset:3px;border-radius:12px;color:#16357a;padding:9px 20px;text-align:center;transform:rotate(-5deg);opacity:.9;line-height:1.45}
.ozk-inv .seal .s-name{font-size:15px;font-weight:900}
.ozk-inv .seal .s-sub{font-size:12px;font-weight:700}
.ozk-inv .seal .s-logo{font-size:18px;font-weight:900;letter-spacing:1px;margin:2px 0}
.ozk-inv .seal .s-info{font-size:10.5px;font-weight:700}
.ozk-inv .seal .s-addr{font-size:11px;font-weight:700;border-top:1px solid #16357a;margin-top:4px;padding-top:3px}
</style>`;

  // ==========================================================================
  // 2) SEAL — الختم الكحلي المعتمد في المرجع 634.
  //
  // ⚠️ لونه `#16357a` كحليّ مقصود ومعتمد من صاحب النظام. أي حارس ألوان مستقبلي
  //    من نوع «NO BLUE» على مستندات OZK **يجب أن يستثني الختم صراحةً**. لا
  //    يُغيَّر لونه ولا حدوده ولا دورانه ولا شفافيته ولا محاذاته ولا نصّه.
  // ==========================================================================
  const SEAL_COLOR = "#16357a";
  const SEAL = `
    <div class="stamp-wrap"><div class="seal">
      <div class="s-name">مركز أبو زياد</div>
      <div class="s-sub">لتجارة الدخان</div>
      <div class="s-logo">OZK TOBACCO</div>
      <div class="s-info" dir="ltr">0985000771 - 0984000662 · رقم المركز: 0994092038</div>
      <div class="s-addr">دوما - ساحة الغنم</div>
    </div></div>`;

  // ==========================================================================
  // 3) KINDS — أنواع المستندات الأربعة وهوية كل نوع.
  //    `legal` يعني ظهور صندوق صفة البيع والسجل التجاري (مستندات البيع وحدها).
  // ==========================================================================
  const KINDS = {
    invoice: {
      title: "فاتورة", partyLabel: "", amountLabel: "قيمة الفاتورة",
      amountColor: "#c0271f", prefix: "INV", archiveType: "invoice",
      legal: true, seal: true, itemsLabel: "أصناف الفاتورة",
      ledgerAmountLabel: "قيمة هذه الفاتورة",
      note: "هذه فاتورة صادرة عن OZK TOBACCO."
    },
    return: {
      title: "فاتورة مرتجع", partyLabel: "", amountLabel: "قيمة المرتجع",
      amountColor: "#16794f", prefix: "RET", archiveType: "return_invoice",
      legal: true, seal: true, itemsLabel: "أصناف المرتجع",
      ledgerAmountLabel: "قيمة هذا المرتجع",
      note: "هذا سند رسمي بقيمة البضاعة المرتجعة إلى OZK TOBACCO — خُصمت من رصيد حسابكم."
    },
    purchase: {
      title: "فاتورة مشتريات", partyLabel: "المورد", amountLabel: "قيمة فاتورة المشتريات",
      amountColor: "#c0271f", prefix: "PO", archiveType: "purchase_invoice",
      legal: false, seal: true, itemsLabel: "أصناف فاتورة المشتريات",
      ledgerAmountLabel: "قيمة هذه الفاتورة",
      note: "هذه فاتورة مشتريات صادرة عن نظام OZK TOBACCO."
    },
    purchase_return: {
      title: "مرتجع مشتريات", partyLabel: "المورد", amountLabel: "قيمة مرتجع المشتريات",
      amountColor: "#16794f", prefix: "PRET", archiveType: "purchase_return",
      legal: false, seal: true, itemsLabel: "أصناف مرتجع المشتريات",
      ledgerAmountLabel: "قيمة هذا المرتجع",
      note: "هذا مستند بمرتجع مشتريات صادر عن نظام OZK TOBACCO."
    }
  };

  // ==========================================================================
  // 4) LEGAL — صفة البيع والسجل التجاري.
  //    مصدر الحقيقة واحد: الثابتان `SALES_TRADE_CAPACITY` و
  //    `SALES_TRADE_REGISTER_NO` في `src/app.js`. لا نُكرّر قيمتهما هنا؛
  //    نقرؤهما وقت الاستدعاء فلا يهمّ ترتيب تحميل الوسوم.
  // ==========================================================================
  function legalBox(esc) {
    const capacity = typeof SALES_TRADE_CAPACITY === "string" ? SALES_TRADE_CAPACITY : "";
    const register = typeof SALES_TRADE_REGISTER_NO === "string" ? SALES_TRADE_REGISTER_NO : "";
    return `<div class="legalbox">صفة البيع: ${esc(capacity)} · السجل التجاري: <span dir="ltr">${esc(register)}</span></div>`;
  }

  // ==========================================================================
  // 5) نسب أعمدة جدول الأصناف — عقد ثابت: 37 / 26 / 20 / 17
  //    بدونها يترك المتصفح عرض الأعمدة لحسابه الخاص، فيتغيّر الشكل بتغيّر
  //    طول أسماء المواد — ولا يمكن لحارس بصري أن يضمن مطابقة المرجع.
  // ==========================================================================
  const COLUMN_WIDTHS = ["37%", "26%", "20%", "17%"];
  const COLUMN_HEADS = ["المادة", "الكمية", "سعر الوحدة", "قيمة السطر"];
  const ITEMS_COLGROUP = `<colgroup>${COLUMN_WIDTHS.map((w) => `<col style="width:${w}">`).join("")}</colgroup>`;

  // ==========================================================================
  // 6) MARKUP — بناء المستند.
  //
  //    كل القيم المحاسبية تصل جاهزة من المستدعي: الكمية وسعر الوحدة وقيمة
  //    السطر والأرصدة ونصوصها. هذا القالب **عرض فقط** ولا يحسب شيئاً ولا
  //    يقرّب ولا يعيد كتابة منطق `invoiceLine*` ولا `balanceText`.
  // ==========================================================================
  // جدول المواد بأعمدته الأربعة المعتمدة. عرضٌ محض: النصوص تصل جاهزة ولا
  // يُشتقّ هنا شيء من الكمية ولا الوحدة ولا سعر الوحدة ولا قيمة السطر.
  // خانة الكمية: كل جزء في عنصر عزل مستقل، وبلا أي قوس.
  //
  // محرّك الرسم على الهاتف (`html2canvas` بلا foreignObjectRendering) لا يطبّق
  // خوارزمية BiDi: يأخذ مواضع الصناديق من تخطيط المتصفح الحقيقي ثم يرسم نصّ كل
  // عقدة بنفسه. فعقدة واحدة تحمل «0.12 كرتونة (6 كروز)» تخرج مُعاد ترتيبها،
  // ولا ينفع معها عزلٌ ولا `dir` لأن المحرّك لا يقرؤهما. وثبت بالقياس أن
  // القوسين لا ينجوان بأي صورة (حرفيَّين، أو عنصرين، أو بـ`dir="ltr"`، أو
  // كـ`content` في CSS)، وأن إصلاح NBSP نفسه هو ما يُزيح الرقم عن وحدته.
  // فالأجزاء الذرّية تحلّ الأمرين معاً: كل صندوق يضعه التخطيط الحقيقي في موضعه،
  // ولا تبقى عقدة مختلطة يلحمها NBSP. التفصيل في
  // `scripts/check-invoice-quantity-render.mjs`.
  function qtyCellHtml(line, esc) {
    const parts = line.qtyParts;
    if (!parts) return `<bdi>${esc(line.qtyText || "")}</bdi>`;
    const atom = (text) => `<bdi>${esc(text)}</bdi>`;
    const main = [parts.value, parts.unit].filter(Boolean).map(atom).join(" ");
    if (!parts.detailValue) return main;
    // التوضيح ثانوي بصرياً (أخفت وأصغر) بدل الأقواس التي كانت تحمل هذا الدور.
    return `${main} <span class="q-det">${atom(parts.detailValue)} ${atom(parts.detailUnit)}</span>`;
  }

  function itemsTableHtml(doc, kind, esc) {
    const lines = Array.isArray(doc.lines) ? doc.lines : [];
    if (!lines.length) return "";
    const body = lines.map((line) => {
      // `<bdi>` يعزل كل خلية مختلطة الاتجاه عن جاراتها، فلا ينقلب
      // «2 كرتونة (100 كروز)» ولا يتبدّل ترتيب «$ 250 / كرتونة».
      const rest = [line.priceText || "", line.valueText || ""];
      return `<tr><td>${esc(line.material || "")}</td>`
        + `<td>${qtyCellHtml(line, esc)}</td>`
        + rest.map((c) => `<td><bdi>${esc(c)}</bdi></td>`).join("")
        + `</tr>`;
    }).join("");
    return `
    <div class="sec">${esc(kind.itemsLabel)}</div>
    <table class="items-table">
      ${ITEMS_COLGROUP}
      <thead><tr>${COLUMN_HEADS.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
  }

  // أسطر الدفتر كما ينتجها `voucherLedgerRows`. لا يقرّر هذا الشقّ أي سطر
  // يظهر ولا بأي ترتيب — يرسم ما وصله كما وصله.
  function infoRowsHtml(doc, dateHtml, esc) {
    return (doc.rows || []).map((row) => {
      const width = row.width ? ` style="width:${row.width}"` : "";
      const cls = row.tone === "cred" ? ' class="cred"' : (row.tone === "deb" ? ' class="deb"' : "");
      const value = row.isDate ? dateHtml : `<bdi>${esc(row.value)}</bdi>`;
      const body = row.strong ? `<b>${value}</b>` : value;
      return `<tr><th${width}>${esc(row.label)}</th><td${cls}>${body}${row.suffixHtml || ""}</td></tr>`;
    }).join("");
  }

  function markup(doc) {
    const esc = doc.escapeHtml;
    const kind = KINDS[doc.kind] || KINDS.invoice;
    const cur = doc.cur || "ل.س";
    const dstr = String(doc.date || "").slice(0, 10);

    // BiDi: التاريخ ISO رقمٌ لاتيني داخل سياق عربي. بلا عزل صريح قد يقلبه
    // خوارزم الاتجاه إلى 05-09-2026. `dir="ltr"` يعزله فيبقى 2026-09-05.
    const dateHtml = `<span dir="ltr">${esc(dstr)}</span>`;

    const itemsTable = itemsTableHtml(doc, kind, esc);
    const infoRows = infoRowsHtml(doc, dateHtml, esc);
    const partyMeta = doc.partyMeta || "";

    return `${STYLE}<div class="ozk-inv">
    <div class="rhead">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="public/icons/ozk-logo.png" class="rlogo" alt="OZK" onerror="this.style.display='none'">
        <div class="brand">OZK TOBACCO<small>مركز أبو زياد — لتجارة الدخان</small></div>
      </div>
      <div class="rtitle"><h2>${esc(doc.title || kind.title)}</h2><span>رقم: ${esc(doc.no || "")} · ${dateHtml}</span></div>
    </div>
    <div class="balbox">
      <div><div class="nm">${esc(doc.party || "")}</div>
        <div class="muted">${partyMeta}</div></div>
      <div style="text-align:left"><div class="muted">${esc(doc.amountLabel || kind.amountLabel)}</div>
        <div class="big" style="color:${doc.amountColor || kind.amountColor}"><bdi>${esc(doc.amountText || "")} ${esc(cur)}</bdi></div></div>
    </div>${itemsTable}
    <table>${infoRows}</table>
    <p class="muted" style="margin:8px 0 0">${esc(doc.note || kind.note)}</p>
    ${kind.legal ? legalBox(esc) : ""}
    ${kind.seal ? SEAL : ""}
    <div class="rfoot"><span>صادر آليًا عن نظام OZK TOBACCO · رقم المركز: 0994092038</span><span dir="ltr">0985000771 — 0984000662</span></div>
  </div>`;
  }

  return { STYLE, SEAL, SEAL_COLOR, KINDS, legalBox, markup, COLUMN_WIDTHS, COLUMN_HEADS };
})();

if (typeof window !== "undefined") window.OZK_INVOICE = OZK_INVOICE;
