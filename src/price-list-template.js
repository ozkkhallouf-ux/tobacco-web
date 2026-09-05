(function initOzkPriceListTemplate(root) {
  "use strict";

  const VERSION = "2026-08-31-native-print-pagination";

  // لون خلفية الصفحة لكل ثيم — التعريف الوحيد بالمشروع. الـCSS يقرأه عبر
  // --page، ويقرأه أيضاً `src/app.js` و`scripts/generate-pdfs.mjs` بدل تكرار
  // القيمة الحرفية في ثلاثة أماكن (تكرارها هو ما سمح لخلفية تصدير الموقع أن
  // تختلف عن خلفية النشرات المنشورة).
  const THEME_PAGE_BACKGROUND = Object.freeze({ dark: "#0c0a07", light: "#fffdf8" });

  function themePageBackground(theme) {
    return THEME_PAGE_BACKGROUND[theme === "light" ? "light" : "dark"];
  }
  const RIGHT_GROUPS = ["ماستر", "كابتن بلاك", "اوسكار", "اختمار", "روز", "1970", "كينغ دوم", "مانشستر"];
  const LEFT_GROUPS = ["غلواز", "اليغانس", "تي اس", "أوريس", "حمرا", "يونايتد", "ولسون", "نابولي"];
  const SPECIAL_RIGHT_GROUPS = ["فحم", "ورق", "فيبات", "قداحات", "سلفان"];
  // «مزايا» و«نخلة» علامتا معسل، فوجهتهما عمود القسم الخاص الأيسر مع «معسل».
  const SPECIAL_LEFT_GROUPS = ["معسل", "مزايا", "نخلة"];
  // **مشتقّة من قائمتَي الوجهة، لا تُكتب يدوياً.** كانت تُكتب يدوياً وتضمّ
  // «مزايا» و«نخلة» بلا وجود لهما في أي من القائمتين، فكان layoutGroups يستبعدهما
  // من `remaining` (لأنهما ضمن SPECIAL_GROUPS) ولا يلتقطهما `take()` (لأنهما ليسا
  // في أي قائمة وجهة) — فتسقط المجموعة بأكملها من النشرة بصمت: أربعة أصناف من
  // «نخلة» لم تصل الزبون (224 صنفاً في البيانات مقابل 220 في الملف).
  // الاشتقاق يجعل «اسم بلا وجهة» مستحيلاً بنيوياً.
  const SPECIAL_GROUPS = new Set([...SPECIAL_RIGHT_GROUPS, ...SPECIAL_LEFT_GROUPS]);
  const ARABIC_MONTHS = [
    "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
    "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"
  ];

  function formatArabicIssueDate(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const day = String(date.getDate()).padStart(2, "0");
    const year = String(date.getFullYear());
    return `${day} ${ARABIC_MONTHS[date.getMonth()]} ${year}`;
  }

  function renderIssueDate(value) {
    const issueDate = String(value || "").trim();
    const parts = issueDate.match(/^(\d{1,2})\s+(.+?)\s+(\d{4})$/);
    if (!parts) return escapeHtml(issueDate);
    return `<span class="issue-date-day">${escapeHtml(parts[1])}</span><span class="issue-date-month" dir="rtl">${escapeHtml(parts[2])}</span><span class="issue-date-year">${escapeHtml(parts[3])}</span>`;
  }

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
      display:flex; align-items:center; justify-content:center; gap:4px;
      font-size:10.5px; color:var(--muted); margin-top:2px; font-weight:600; direction:ltr; unicode-bidi:isolate;
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
      /*
       * ملاحظة حرجة: كان هذا العنصر CSS Grid (display:grid +
       * grid-template-columns:repeat(2,minmax(0,1fr))). html2canvas مع
       * foreignObjectRendering:true (مطلوب لتفادي انعكاس ترتيب النص العربي —
       * راجع html2canvas في exportBulletinPdf بـsrc/app.js) لا يحسب عرض أعمدة
       * CSS Grid بشكل صحيح داخل SVG foreignObject: كان يرسم العمود الأول فقط
       * بعرض ضيّق (min-content تقريباً) ويترك ~78% من عرض الصفحة فارغاً أسود/
       * أبيض بلا محتوى — رغم أن عرض الـcanvas الملتقط نفسه كان صحيحاً 794px،
       * وأن نفس العنصر يُعرض بشكل سليم تماماً بمعاينة Playwright/متصفح عادية.
       * إيقاف foreignObjectRendering يُصلح العرض لكنه يكسر تشكيل الحروف
       * العربية (تظهر منعكسة/مبعثرة الحروف). الحل: استبدال Grid بـFlexbox —
       * html2canvas يحسب عرض flex-basis بشكل صحيح داخل foreignObject، فيبقى
       * العمودان بعرض متساوٍ فعلي بلا هوامش فارغة، مع تشكيل عربي سليم.
       */
      display:flex; gap:8px; align-items:flex-start;
      padding:0 8px 8px; background:var(--page); position:relative;
    }
    .ozk-price-list .price-list-columns::before {
      content:""; position:absolute; top:0; bottom:8px; left:50%; width:2px;
      transform:translateX(-50%); background:var(--gold); border-radius:2px;
    }
    .ozk-price-list .price-list-column-stack {
      flex:1 1 0; min-width:0; background:var(--page); position:relative; z-index:1;
    }
    .ozk-price-list .price-list-secondary-page {
      break-before:page; page-break-before:always; margin-top:8px;
    }
    /* الكتلة الأولى وحدها (التي تتشارك ورقتها مع الرأس) بلا حاشية سفلية: لا
       يليها شيء على ورقتها، وإسقاطها يرفع أسفلها 8px فيخرج أسوأ حالٍ مسموح من
       نطاق «نقل الكتلة كاملةً» — بلا تغيير أي شيء في توزيع المجموعات.
       راجع COLUMNS_PADDING_BOTTOM_PX أعلاه للقياسات. */
    .ozk-price-list .price-list-columns:not(.price-list-secondary-page) { padding-bottom:0; }
    .ozk-price-list .price-list-columns:not(.price-list-secondary-page)::before { bottom:0; }
    .ozk-price-list .price-list-group {
      break-inside:avoid; -webkit-column-break-inside:avoid; margin-bottom:5px;
      border:1px solid var(--line); border-radius:3px; overflow:hidden;
    }
    /* اسم مجموعة طويل كان يزيح الشارة خارج الرأس أو يقصّها: الاسم يلتفّ داخل
       مساحته (min-width:0 شرط ليعمل الالتفاف داخل flex) والشارة تبقى بعرضها.
       منقول من PR #115 — قواعد التفاف الاسم وحدها، وهي مشكلة مستقلة عن فواصل
       الصفحات التي عالجها هذا الفرع من جذرها. */
    .ozk-price-list .price-list-group-header {
      background:var(--surface-strong); border-bottom:1px solid var(--line); padding:3.5px 9px;
      font-size:11px; font-weight:900; color:#f2c55c; display:flex; justify-content:space-between;
      align-items:center; letter-spacing:.3px; gap:6px;
    }
    .ozk-price-list .price-list-group-name {
      min-width:0; overflow-wrap:break-word; word-break:break-word;
    }
    .ozk-price-list .price-list-group-count {
      flex:0 0 auto; font-size:8.5px; background:rgba(255,255,255,.12); color:#f4d184;
      border-radius:8px; padding:1px 6px; font-weight:700; white-space:nowrap;
    }
    .ozk-price-list table { width:100%; border-collapse:collapse; table-layout:fixed; }
    .ozk-price-list td { padding:2.5px 8px; border-bottom:1px solid var(--line); font-size:10px; }
    .ozk-price-list td.name {
      font-weight:700; color:var(--text); width:54%; overflow-wrap:break-word; word-break:break-word;
      white-space:normal; hyphens:auto;
    }
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
    /* قواعد عرض الهاتف — للعرض على الشاشة فقط. تُستثنى منها أي نسخة تحمل
       [data-measure-print]: تلك هي نسخة القياس التي يبني عليها المُرقِّم توزيع
       صفحات A4، ويجب أن تُقاس بطباعة الطباعة لا بطباعة الهاتف. بدون هذا
       الاستثناء كان القياس على iPhone يجري بخطوط وحشوات أصغر ثم تُطبع النشرة
       بأبعاد سطح المكتب، فتفيض الأعمدة عن الورقة وتظهر صفحات زائدة. */
    @media screen and (max-width:720px) {
      .ozk-price-list:not([data-measure-print]) .price-list-columns { gap:4px; padding:0 4px 6px; }
      .ozk-price-list.has-document-tools:not([data-measure-print]) .price-list-header { padding-top:102px; }
      .ozk-price-list:not([data-measure-print]) .price-list-document-tools { right:10px; left:10px; justify-content:center; }
      .ozk-price-list:not([data-measure-print]) .price-list-group { margin-bottom:3px; }
      .ozk-price-list:not([data-measure-print]) .price-list-group-header { padding:4px 5px; font-size:9px; }
      .ozk-price-list:not([data-measure-print]) td { padding:3px 4px; font-size:8px; }
      .ozk-price-list:not([data-measure-print]) td.name { width:55%; }
      .ozk-price-list:not([data-measure-print]) td.unit { width:15%; font-size:7px; }
      .ozk-price-list:not([data-measure-print]) td.price { width:30%; font-size:8px; }
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

  // خلفية **المستند** (html/body)، لا خلفية القالب. هذه هي القاعدة التي كانت
  // غائبة عن كل مسار تصدير داخل الموقع: في الطباعة الأصلية تُرسم خلفية الورقة
  // من html/body لا من القسم، فكان ذيل الصفحة الأخيرة وأي فراغ حول القالب يخرج
  // **أبيض** داخل نشرة داكنة — وهو بالضبط عطل «صفحة نصفها أسود ونصفها أبيض».
  // `scripts/generate-pdfs.mjs` كان يحقن هذه القاعدة لنفسه فقط، ولذلك خرجت
  // النشرات المنشورة سليمة بينما خرج تصدير الموقع مكسوراً.
  function documentBackgroundCss(theme) {
    const background = themePageBackground(theme);
    return `
    html, body { margin:0; padding:0; background:${background}; }
    @media print {
      html, body { background:${background} !important; }
      html { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
    }`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // هامش أمان بالبكسل ضد أخطاء التقريب عند تقطيع html2pdf/html2canvas للصفحات
  // (راجع الفحص التشخيصي السابق لدرجات drawImage الفعلية) — لا نملأ العمود حتى آخر بكسل.
  const DEFAULT_SAFETY_MARGIN_PX = 6;

  // مقاس A4 الحقيقي بالبكسل عند 96dpi — وهو المقاس الذي يقطّع عليه محرك
  // الطباعة الأصلي فعلاً (`@page { size:A4; margin:0 }`): 210مم = 793.70px،
  // و297مم = 1122.52px. الحساب السابق `pageWidthPx * 297/210` لم يكن مشتقاً من
  // مقاس الورقة الحقيقي، فبقيت ميزانية العمود أطول قليلاً من الورقة الفعلية.
  const A4_WIDTH_PX = 210 / 25.4 * 96;
  const A4_HEIGHT_PX = 297 / 25.4 * 96;

  // **لا تتجاوز الورقة الحقيقية أبداً.** صندوق الصفحة الذي يقطّع عليه محرك
  // الطباعة هو A4 حرفياً (`@page{size:A4;margin:0}`) مهما كان عرض المجس الذي
  // قِيست به الارتفاعات. التحجيم بنسبة `width / A4_WIDTH_PX` كان يمنح المجس
  // القياسي (794px) ميزانيةَ 1122.94px — أي 0.42px **فوق** الورقة (1122.52px)،
  // تُقتطع صامتةً من هامش الأمان الذي يفصل الصفحة الأولى عن حافة الورق.
  function computePageContentHeightPx(pageWidthPx = 794) {
    const width = Number(pageWidthPx) > 0 ? Number(pageWidthPx) : A4_WIDTH_PX;
    return Math.min(A4_HEIGHT_PX, A4_HEIGHT_PX * (width / A4_WIDTH_PX));
  }

  // حاشية أسفل كتلة الأعمدة. `.price-list-columns` تحمل `padding:0 8px 8px`،
  // فتُخصم من ميزانية **كل** صفحة كي لا تتجاوز الكتلة (محتوى + حاشية) ورقتها.
  const COLUMNS_PADDING_BOTTOM_PX = 8;

  // خلوص الصفحة الأولى عن حافة الورقة — وهو وحده ما يفصلها عن عطل «ورقة العنوان».
  //
  // الصفحة الأولى هي الوحيدة التي تتشارك ورقتها مع الرأس، والرأس **يُقاس في
  // مستند غير المستند الذي يُطبع**: القياس يجري داخل مجسّ في صفحة التطبيق
  // (`buildMeasuredBulletinLayout` في src/app.js)، بينما الرسم يجري داخل إطار
  // طباعة مستقلّ. قياسٌ فعليّ للفارق على نفس البيانات: عمودٌ قِيس 949px خرج
  // مطبوعاً 902px — أي المستندان لا يتّفقان، والاتجاه ليس مضموناً.
  //
  // وسلوك كروم عند التجاوز **ليس خطياً**، وهذا ما يحدّد المطلوب. قياس عبر
  // `page.pdf()` على نفس المستند بتجاوزات متدرّجة:
  //   · تجاوز 1.86px … 7.86px ⇒ كروم ينقل الكتلة **كاملةً** إلى الورقة الثانية:
  //     ورقة أولى بـ34 مقطع نصّ (= الرأس وحده)، وثانية بـ793 مقطعاً (= كل الأصناف).
  //   · تجاوز ≥ ~13.86px ⇒ كروم **يشطر** الكتلة: 749 مقطعاً على الورقة الأولى
  //     و78 على الثانية — أي الرأس يبقى ومعه أصناف، والعطل لا يظهر أصلاً.
  // (جُرِّب إلغاء `overflow:hidden` وفرض `break-inside:auto` على كتلة الأعمدة:
  //  لا يغيّران هذا السلوك، فالشطر ليس خياراً نملك فرضه.)
  //
  // فالنطاق الخطر ضيّق ومعروف: تجاوزٌ بين صفر و~8px. وبالحساب القديم كان أسوأ
  // حالٍ مسموح يترك 5.58px فقط تحت الحافة — **داخل النطاق مباشرةً**، والعطل على
  // بُعد خطأ تقريب واحد.
  //
  // **كيف يُوسَّع الخلوص بلا لمس التوزيع إطلاقاً:** الميزانية تخصم حاشية 8px من
  // كل صفحة. والكتلة الأولى وحدها لا حاجة لها بتلك الحاشية: لا يليها شيء على
  // ورقتها. فحين لا تُرسَم حاشيتُها (قاعدة CSS على
  // `.price-list-columns:not(.price-list-secondary-page)` أدناه) يرتفع أسفلها
  // 8px مجاناً — فيصير الخلوص 6px + 8px = **14px**، خارج النطاق الخطر كلّه.
  //
  // ولماذا هذا الطريق لا خصمٌ إضافي من الميزانية: أي خصم يُضيّق الصفحة الأولى
  // يُغيّر **أي المجموعات تتّسع فيها**، فيضع التوزيع على حافة قرار. وقياس الخطوط
  // في مستند التطبيق ما زال يسابق تحميل الخط، فعلى تلك الحافة يختلف التوزيع
  // باختلاف البيئة: أُثبت عملياً أن خصم 6px جعل iPhone و1440px يُنتجان توزيعين
  // مختلفين على CI (بينما يتطابقان بلا خصم)، وخصم 8px فأكثر يدفع القسم الخاص
  // في نشرة الدولار إلى ورقة رابعة. إسقاط الحاشية يشتري الخلوص نفسه بلا أيٍّ من
  // الثمنين: التوزيع يبقى مطابقاً لما كان حرفياً، وشكل النشرة لا يتغيّر.

  // نسبة التفاوت (من ميزانية العمود) التي تُعتبر "فراغاً كبيراً" يستحق محاولة
  // نقل مجموعة كاملة من العمود الأطول للأقصر — قاعدة التوازن (Balance Rule).
  const DEFAULT_BALANCE_THRESHOLD_RATIO = 0.12;

  // بعد ملء عمودَي صفحة واحدة: إن كان التفاوت بين ارتفاعيهما كبيراً، جرّب نقل
  // آخر مجموعة كاملة من العمود الأطول إلى العمود الأقصر — فقط إن اتّسعت هناك
  // فعلاً (بلا فيضان) وحسّنت التوازن فعلياً. النقل يبقى ضمن نفس الصفحة فقط،
  // وآخر مجموعة تُصبح آخر عنصر بالعمود الآخر — أي لا يتغيّر ترتيب القراءة
  // الإجمالي للصفحة (تبقى آخر ما يُقرأ فيها)، تحقيقاً لشرط "عدم كسر الترتيب".
  function balancePageColumns(page, limit, heights, thresholdPx) {
    const diffBefore = Math.abs(page.rightHeight - page.leftHeight);
    if (diffBefore <= thresholdPx) return;
    const longerKey = page.rightHeight >= page.leftHeight ? "right" : "left";
    const shorterKey = longerKey === "right" ? "left" : "right";
    const longerList = page[longerKey];
    if (!longerList.length) return;
    const lastGroup = longerList[longerList.length - 1];
    const h = heights instanceof Map ? heights.get(String(lastGroup?.name || "")) : undefined;
    if (h == null || !Number.isFinite(h)) return;
    const shorterHeightKey = `${shorterKey}Height`;
    const longerHeightKey = `${longerKey}Height`;
    const newShorterHeight = page[shorterHeightKey] + h;
    if (newShorterHeight > limit + 1e-6) return; // النقل يسبب فيضاناً بالعمود الأقصر — ألغِه
    const newLongerHeight = page[longerHeightKey] - h;
    const diffAfter = Math.abs(newLongerHeight - newShorterHeight);
    if (diffAfter >= diffBefore) return; // لا يحسّن التوازن فعلياً — ألغِه
    longerList.pop();
    page[shorterKey].push(lastGroup);
    page[longerHeightKey] = newLongerHeight;
    page[shorterHeightKey] = newShorterHeight;
  }

  // توزيع تسلسل واحد من المجموعات (بترتيبها كما هو، بدون أي إعادة ترتيب فعلية
  // بين المجموعات نفسها) على صفحات، كل صفحة بعمودين ثابتَي العرض (يمين/يسار).
  // الفرق الجوهري عن التصميم السابق: العمودان يسحبان من نفس الطابور المشترك،
  // فإن كان عمود أطول إجمالاً من الآخر في مجموع محتواه، تمتصّ الصفحات اللاحقة
  // الفارق تلقائياً بدل ترك عمود كامل فارغاً بينما الآخر يتكدّس (هذا كان سبب
  // العطل: تعبئة مسارين مستقلّين بصفحات منفصلة تماماً). كل مجموعة تُنقل كاملة
  // لعمود واحد فقط، ولا تُقسَّم أبداً. القياس عمودي بحت (remainingHeight)، لا
  // علاقة له بعرض الصفحة أو عرض المجموعة (يبقى 100% من عرض عموده دائماً عبر CSS).
  // ملاحظة حرجة (إصلاح تثبيت "ماستر"/"غلواز" أول كل عمود): كانت هذه الدالة
  // تستقبل طابوراً موحّداً واحداً (يمين ثم يسار مدمجَين) فتملأ عمود اليمين من
  // أوله حتى ينفد، ثم تُكمل نفس الطابور داخل عمود اليسار — فإن كانت مجموعات
  // اليمين (المثبَّتة + الإضافات) أطول من ميزانية عمود واحد، كانت تطفح فعلياً
  // إلى عمود اليسار "المرئي" مزيحةً "غلواز" (أول مجموعات اليسار) لنهاية العمود
  // بدل بدايته. الإصلاح: طابوران منفصلان (يمين/يسار) بأولوية كل طابور لعموده
  // الخاص، مع سماح "فيضان" فقط بعد نفاد الطابور الآخر تماماً — هذا يحافظ على
  // نفس إصلاح توازن الأعمدة عبر الصفحات (PR #122) دون كسر ترتيب التثبيت.
  function packGroupsIntoBalancedPages(rightGroups, leftGroups, heights, budgetOptions, safetyMarginPx = DEFAULT_SAFETY_MARGIN_PX) {
    const reducedFirstPageBudget = Math.max(0, Number(budgetOptions?.reducedFirstPageBudget ?? budgetOptions?.fullBudget) || 0);
    const fullBudget = Math.max(0, Number(budgetOptions?.fullBudget) || 0);
    const balanceThresholdPx = Number.isFinite(budgetOptions?.balanceThresholdPx)
      ? budgetOptions.balanceThresholdPx
      : Math.max(40, fullBudget * DEFAULT_BALANCE_THRESHOLD_RATIO);
    const maxPossibleLimit = Math.max(0, fullBudget - safetyMarginPx);

    const toEntries = (groups) => (Array.isArray(groups) ? groups : [])
      .map((group) => {
        const name = String(group?.name || "");
        const h = heights instanceof Map ? heights.get(name) : undefined;
        return { group, name, h };
      })
      .filter((entry) => entry.h != null && Number.isFinite(entry.h)); // ارتفاع غير معروف: تجاهل آمن

    const oversized = [];
    const stripOversized = (entries) => entries.filter((entry) => {
      if (entry.h > maxPossibleLimit + 1e-6) {
        oversized.push({ name: entry.name, height: entry.h, limit: maxPossibleLimit });
        return false;
      }
      return true;
    });

    const rq = stripOversized(toEntries(rightGroups));
    const lq = stripOversized(toEntries(leftGroups));

    const pages = [];
    let ri = 0;
    let li = 0;

    while (ri < rq.length || li < lq.length) {
      const pageIndex = pages.length;
      const budgetForThisPage = pageIndex === 0 ? reducedFirstPageBudget : fullBudget;
      const limit = Math.max(0, budgetForThisPage - safetyMarginPx);
      const page = { right: [], left: [], rightHeight: 0, leftHeight: 0 };

      // عمود اليمين: من طابور اليمين أولاً، ثم فيضان من طابور اليسار إن نفد الأول.
      for (;;) {
        if (ri < rq.length && page.rightHeight + rq[ri].h <= limit + 1e-6) {
          page.right.push(rq[ri].group);
          page.rightHeight += rq[ri].h;
          ri += 1;
        } else if (ri >= rq.length && li < lq.length && page.rightHeight + lq[li].h <= limit + 1e-6) {
          page.right.push(lq[li].group);
          page.rightHeight += lq[li].h;
          li += 1;
        } else {
          break;
        }
      }

      // عمود اليسار: من طابور اليسار أولاً، ثم فيضان من طابور اليمين إن نفد الأول.
      for (;;) {
        if (li < lq.length && page.leftHeight + lq[li].h <= limit + 1e-6) {
          page.left.push(lq[li].group);
          page.leftHeight += lq[li].h;
          li += 1;
        } else if (li >= lq.length && ri < rq.length && page.leftHeight + rq[ri].h <= limit + 1e-6) {
          page.left.push(rq[ri].group);
          page.leftHeight += rq[ri].h;
          ri += 1;
        } else {
          break;
        }
      }

      // **لا تُملأ صفحةٌ بأكثر من ميزانيتها هي.** كانت هنا «كتلة إنقاذ» تُعيد
      // تعبئة الصفحة الأولى بالميزانية الكاملة (ارتفاع الورقة كلها) متى خرجت
      // فارغة أو مستغلّة أقل من نصف ميزانيتها المخفَّضة، بحجّة أن «الرأس فوق
      // الأعمدة لا داخلها فالمساحة الفعلية أكبر». الحجّة مقلوبة: الرأس يجلس
      // على **نفس الورقة** فوق الأعمدة، فمساحة الصفحة الأولى أقلّ من غيرها
      // بمقدار ارتفاعه لا أكثر منها. فكانت كتلة الأعمدة الأولى تُبنى بارتفاع
      // ورقة كاملة ثم يُركَّب فوقها الرأس (~156px) — أي كتلة أطول من الورقة
      // بالضبط بمقدار الرأس. النتيجة المقاسة:
      //   · كروم يُجزّئ الكتلة: ورقة زائدة ومحتوى الصفحة الأولى مشطور.
      //   · سفاري يدفع الكتلة **كاملةً** إلى الورقة التالية (نفس سلوك الدفع
      //     الموصوف في خصم حاشية الأعمدة أدناه)، و`.ozk-price-list` تحمل
      //     `overflow:hidden` فيُقصّ ما خرج — فتصل الزبون نشرةٌ فيها **الرأس
      //     وحده بلا أي صنف**، وهو بالضبط العطل الإنتاجي في نشرة الليرة.
      // ميزانية الصفحة الأولى = ارتفاع الورقة - الرأس، ولا شيء يزيدها. وإن لم
      // تتّسع أي مجموعة تحت الرأس فالصفحة الأولى تبقى بلا أعمدة (يتكفّل
      // renderPagesBlock بعدم رسم كتلة فارغة) وتبدأ المجموعات من الورقة
      // التالية بميزانيتها الكاملة — ورقة أهدر خيرٌ من أصناف تختفي.
      balancePageColumns(page, limit, heights, balanceThresholdPx);
      pages.push(page);
    }

    return { pages, oversized };
  }

  // ملء الفراغ المتبقي في آخر صفحة رئيسية بمجموعات القسم الخاص (فحم، معسل،
  // ورق، فيبات، قداحات، سلفان).
  //
  // قبل هذه الخطوة كان القسم الخاص يبدأ **دائماً** بصفحة جديدة، فتخرج آخر صفحة
  // رئيسية نصف فارغة (هامش سفلي ~47%) وتُطبع بعدها صفحة كاملة للفحم والمعسل —
  // ورق مهدور بلا سبب.
  //
  // القاعدة: تنزل المجموعة إلى الفراغ المتبقي **فقط إذا اتّسعت كاملةً** في
  // عمودها. لا تُقسَّم مجموعة أبداً بين صفحتين ولا بين عمودين، ولا يتغيّر ترتيب
  // القراءة: نستهلك بادئة كل طابور فقط (نتوقف عند أول مجموعة لا تتّسع) كي لا
  // تسبق مجموعةٌ متأخرةٌ مجموعةً أسبق منها.
  //
  // مؤشرا الطابورين مشتركان بين العمودين، تماماً كما في
  // packGroupsIntoBalancedPages: العمود يسحب من طابوره أولاً ثم يقبل فيضان
  // الطابور الآخر **بعد نفاده هو**. بدون هذا الفيضان يبقى عمود اليسار شبه فارغ
  // بينما تُدفع مجموعات صغيرة إلى صفحة مستقلة لا تحمل غير ~12% من الورقة — أي
  // يبقى الهدر الذي جاءت هذه الميزة لإزالته.
  //
  // لا نُعيد موازنة الأعمدة بعد الملء (balancePageColumns) لأن الموازنة تنقل آخر
  // مجموعة بين العمودين، فتكسر هوية القسم الخاص (يمين/يسار).
  function fillTrailingSpaceWithSpecialGroups(pages, budgets, specialRight, specialLeft, heights, safetyMarginPx) {
    const toEntries = (groups) => (Array.isArray(groups) ? groups : [])
      .map((group) => {
        const name = String(group?.name || "");
        const h = heights instanceof Map ? heights.get(name) : undefined;
        return { group, name, h };
      });

    const rq = toEntries(specialRight);
    const lq = toEntries(specialLeft);
    const remainder = (queue, from) => queue.slice(from).map((entry) => entry.group);

    const lastIndex = pages.length - 1;
    const page = lastIndex >= 0 ? pages[lastIndex] : null;
    if (!page) return { right: remainder(rq, 0), left: remainder(lq, 0), carried: 0 };

    // آخر صفحة رئيسية قد تكون الصفحة الأولى نفسها (نشرة قصيرة)، وميزانيتها
    // حينها مخفوضة بارتفاع الرأس — نفس الميزانية التي حُزمت بها.
    const budgetForPage = lastIndex === 0
      ? Math.max(0, Number(budgets?.reducedFirstPageBudget) || 0)
      : Math.max(0, Number(budgets?.fullBudget) || 0);
    const limit = Math.max(0, budgetForPage - safetyMarginPx);

    // صفحة احتياطية بلا ارتفاعات محسوبة (لا مجموعات رئيسية إطلاقاً): تبدأ من صفر.
    if (!Number.isFinite(page.rightHeight)) page.rightHeight = 0;
    if (!Number.isFinite(page.leftHeight)) page.leftHeight = 0;

    let carried = 0;
    let ri = 0;
    let li = 0;
    const tryTake = (entry, columnKey, heightKey) => {
      if (!entry || entry.h == null || !Number.isFinite(entry.h)) return false;
      if (page[heightKey] + entry.h > limit + 1e-6) return false; // لا تتّسع كاملةً
      page[columnKey].push(entry.group);
      page[heightKey] += entry.h;
      carried += 1;
      return true;
    };

    // عمود اليمين: طابور اليمين أولاً، ثم فيضان طابور اليسار إن نفد اليمين.
    for (;;) {
      if (ri < rq.length) {
        if (!tryTake(rq[ri], "right", "rightHeight")) break;
        ri += 1;
      } else if (li < lq.length) {
        if (!tryTake(lq[li], "right", "rightHeight")) break;
        li += 1;
      } else break;
    }

    // عمود اليسار: طابور اليسار أولاً، ثم فيضان طابور اليمين إن نفد اليسار.
    for (;;) {
      if (li < lq.length) {
        if (!tryTake(lq[li], "left", "leftHeight")) break;
        li += 1;
      } else if (ri < rq.length) {
        if (!tryTake(rq[ri], "left", "leftHeight")) break;
        ri += 1;
      } else break;
    }

    return { right: remainder(rq, ri), left: remainder(lq, li), carried };
  }

  // نُبقي على نفس تصنيف الهوية التجارية (يمين/يسار/خاص بالاسم) من layoutGroups()
  // كترتيب أساسي، لكن الآن نُغذّي بها طابوراً موحّداً واحداً لكل من الأعمدة
  // الرئيسية والخاصة بدل مسارين مستقلّين — هذا ما يضمن فعلياً توازن العمودين
  // عبر الصفحات (راجع packGroupsIntoBalancedPages أعلاه لسبب العطل السابق).
  // الارتفاعات مُقاسة فعلياً من DOM (وليست تقديرات ثابتة بعدد الأسطر).
  // heights: Map(name -> px).
  function layoutGroupsMeasured(groups, heights, options = {}) {
    const base = layoutGroups(groups);
    const pageWidthPx = options.pageWidthPx ?? 794;
    const pageHeightPx = options.pageHeightPx ?? computePageContentHeightPx(pageWidthPx);
    const headerHeightPx = Math.max(0, Number(options.headerHeightPx) || 0);
    const safetyMarginPx = options.safetyMarginPx ?? DEFAULT_SAFETY_MARGIN_PX;

    // صفحة1 من الأعمدة الرئيسية تبدأ تحت الرأس/الرأس الفرعي فتُخصم ميزانيتها؛ بقية الصفحات كاملة.
    // طابورا يمين/يسار منفصلان (لا دمج مسبق) — راجع تعليق packGroupsIntoBalancedPages
    // لسبب هذا الفصل: يضمن "ماستر" و"غلواز" أول عمودَيهما دائماً.
    //
    // .price-list-columns تحمل padding:0 8px 8px، أي 8px أسفلها لا تُملأ بمحتوى.
    // بدون خصمها كانت حاوية الأعمدة تتجاوز حد الصفحة بـ2px (safetyMargin=6 - padding=8 = -2)،
    // فيدفعها سفاري بالكامل إلى الصفحة التالية بدل تقسيمها — فتظهر الصفحة الأولى فارغة
    // مع الرأس فقط. الخصم يضمن هامش 6px موجب على كل صفحة.
    const effectivePageHeight = Math.max(0, pageHeightPx - COLUMNS_PADDING_BOTTOM_PX);
    const mainBudgets = {
      reducedFirstPageBudget: Math.max(0, effectivePageHeight - headerHeightPx),
      fullBudget: effectivePageHeight
    };
    const mainPack = packGroupsIntoBalancedPages(base.right, base.left, heights, mainBudgets, safetyMarginPx);
    const mainPages = mainPack.pages.length
      ? mainPack.pages
      : [{ right: [], left: [], rightHeight: 0, leftHeight: 0 }];

    // ينزل من القسم الخاص إلى فراغ آخر صفحة رئيسية كل مجموعة تتّسع كاملةً.
    const spill = fillTrailingSpaceWithSpecialGroups(
      mainPages, mainBudgets, base.specialRight, base.specialLeft, heights, safetyMarginPx
    );

    // ما تبقّى من القسم الخاص يبدأ بصفحة جديدة كاملة بلا رأس متكرر. إن نزل
    // القسم بأكمله في الفراغ أعلاه فلا تُنتَج هنا أي صفحة.
    const specialPack = packGroupsIntoBalancedPages(spill.right, spill.left, heights, {
      reducedFirstPageBudget: effectivePageHeight,
      fullBudget: effectivePageHeight
    }, safetyMarginPx);
    const specialPages = specialPack.pages;

    return {
      mainPages,
      specialPages,
      carriedSpecialGroups: spill.carried,
      oversized: [...mainPack.oversized, ...specialPack.oversized],
      dropped: base.dropped
    };
  }

  // يحوّل ناتج layoutGroups() القديم (تقدير بعدد الأسطر) إلى نفس شكل
  // {mainPages, specialPages, oversized} — يُستخدم افتراضياً حين لا تتوفر
  // ارتفاعات حقيقية (مثال: توليد النشرات الثابتة عبر Node بدون DOM)، فيبقى
  // سلوك هذه المسارات مطابقاً تماماً لما كان عليه قبل هذه الميزة (بلا كسر).
  function layoutGroupsLegacyPages(groups) {
    const layout = layoutGroups(groups);
    const mainPages = [{ right: layout.right, left: layout.left }];
    const specialPages = layout.specialRight.length || layout.specialLeft.length
      ? [{ right: layout.specialRight, left: layout.specialLeft }]
      : [];
    return { mainPages, specialPages, oversized: [], dropped: layout.dropped };
  }

  function layoutGroups(groups) {
    const safeGroups = Array.isArray(groups) ? groups : [];
    const byName = new Map(safeGroups.map((group) => [String(group?.name || ""), group]));
    const take = (names) => names.map((name) => byName.get(name)).filter(Boolean);
    const right = take(RIGHT_GROUPS);
    const left = take(LEFT_GROUPS);
    const reserved = new Set([...right, ...left].map((group) => group.name));
    const remaining = safeGroups.filter((group) => !reserved.has(group.name) && !SPECIAL_GROUPS.has(group.name));
    // طول الاسم (يشمل "الاسم — الملاحظة" عند وجودها) يحدد عدد الأسطر داخل الخلية
    // فعلياً بعد إضافة table-layout:fixed + word-break أعلاه؛ فسطر واحد لا يكفي
    // لتقدير الارتفاع الحقيقي لصنف باسم/ملاحظة طويلين. تقدير تقريبي: ~26 حرفاً
    // عربياً لكل سطر ضمن عرض 54% من عمود بحجم خط 10px.
    const CHARS_PER_NAME_LINE = 26;
    const itemLines = (item) => Math.max(1, Math.ceil(String(item?.name || "").length / CHARS_PER_NAME_LINE));
    const height = (stack) => stack.reduce(
      (sum, group) => sum + (group.items || []).reduce((rows, item) => rows + itemLines(item), 0) + 1,
      0
    );
    remaining.forEach((group) => (height(right) <= height(left) ? right : left).push(group));
    const specialRight = take(SPECIAL_RIGHT_GROUPS);
    const specialLeft = take(SPECIAL_LEFT_GROUPS);

    // حارس الاكتمال: التصنيف أعلاه يجب أن يكون **شاملاً** — كل مجموعة دخلت هنا
    // تخرج في عمود. أي اسم يفلت (مثل «نخلة» سابقاً) يُبلَّغ عنه صراحةً بدل أن
    // تختفي أصنافه من نشرة الزبون بلا أثر. التصدير يرفض عند امتلائه.
    const placed = new Set([...right, ...left, ...specialRight, ...specialLeft].map((group) => group.name));
    const dropped = safeGroups.map((group) => String(group?.name || "")).filter((name) => !placed.has(name));

    return { right, left, specialRight, specialLeft, dropped };
  }

  function renderGroup(group) {
    const items = Array.isArray(group?.items) ? group.items : [];
    return `
      <div class="price-list-group">
        <div class="price-list-group-header">
          <span class="price-list-group-name">${escapeHtml(group?.name)}</span>
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

  // يبني {mainPages, specialPages, oversized} من الخيارات: layout جاهز مُمرَّر
  // صراحة (لضمان أن render() يستخدم بالضبط ما حسبته المعاينة/التصدير)، وإلا
  // ارتفاعات مُقاسة إن توفرت، وإلا التوزيع التقليدي (Node بلا DOM).
  function resolvePagesLayout(groups, options) {
    if (options.layout && Array.isArray(options.layout.mainPages)) return options.layout;
    if (options.measuredHeights instanceof Map) return layoutGroupsMeasured(groups, options.measuredHeights, options);
    return layoutGroupsLegacyPages(groups);
  }

  function pageCount(groups, options = {}) {
    const pagesLayout = resolvePagesLayout(Array.isArray(groups) ? groups : [], options || {});
    return pagesLayout.mainPages.length + pagesLayout.specialPages.length;
  }

  // يرسم مجموعة صفحات (كل صفحة = {right:[groups], left:[groups]}) داخل شبكة
  // عمودين لكل صفحة. أي صفحة غير الأولى على الإطلاق في المستند بأكمله تُجبر
  // على بدء صفحة جديدة (secondary-page) — سواء كانت امتداداً لفيض الأعمدة
  // الرئيسية أو بداية قسم المجموعات الخاصة.
  //
  // **متى تُطبع ورقةُ عنوان — وبأي قرار.** الصفحة الأولى تخرج بلا مجموعات في
  // حالة واحدة فقط: ألا تتّسع أيٌّ من مجموعتَي رأس الطابورين تحت الرأس. وحينها
  // تكون الكتلة التالية مُعبَّأة بميزانية **ورقة كاملة** (fullBudget)، فوضعها
  // تحت الرأس يعني كتلةً أطول من ورقتها بمقدار الرأس (~156px) — وهو بالضبط
  // الفيض الذي يوثّقه docs/ai/topics/price-bulletins.md: كروم يُجزّئ أو ينقل،
  // وسفاري على iPhone **يدفع الكتلة كاملةً** بينما
  // `.ozk-price-list{overflow:hidden}` يقصّ ما خرج — أي ورقة عنوان مجدداً، أو
  // أسوأ: أصناف مقصوصة لا تصل الزبون. (ملاحظة Codex P1 على 1de3a48.)
  //
  // لذلك يبقى الفاصل القسري في مكانه، و**ورقة العنوان قرارٌ صريح** لهذه الحالة
  // وحدها: أن يُهدر ورقٌ خيرٌ من أن يُقصّ صنف. وهي لا تقع بالبيانات الحقيقية
  // أصلاً (رأسا الطابورين «ماستر» و«غلواز» أصغر بكثير من ميزانية الصفحة
  // الأولى)، والحارس يفرض ألا تقع إلا حين تكون الصفحة الأولى المخطَّطة فارغة
  // فعلاً — لا كأثر جانبي لفاصلٍ ورثه بلوك ليس صاحبه.
  //
  // أما العطل الإنتاجي المُبلَّغ (نشرة الليرة: «4 أوراق»، الأولى عنوان بلا صنف)
  // فمصدره **ليس** هذه الحالة بل ضيقُ خلوص الصفحة الأولى عن حافة الورقة —
  // راجع COLUMNS_PADDING_BOTTOM_PX أعلاه: كتلةٌ تتجاوز ورقتها بـ0…8px يَنقلها
  // كروم كاملةً فيهجُر الرأس. وذلك مُغلَق بإسقاط حاشية الكتلة الأولى.
  function renderPagesBlock(pages, isDocumentFirstPage) {
    return pages.map((page, index) => {
      // كتلة فارغة لا تُرسم (كانت تطبع حاشية وفاصلاً ذهبياً معلّقاً تحت رأس
      // وحيد)، لكن مكانها يبقى في الترقيم كي تحتفظ الكتل التالية بفاصلها
      // القسري — فلا تُوضع كتلةُ ورقةٍ كاملة تحت الرأس. راجع الشرح أعلاه.
      if (!page.right.length && !page.left.length) return "";
      const forceBreak = !(isDocumentFirstPage && index === 0);
      return `
      <div class="price-list-columns${forceBreak ? " price-list-secondary-page" : ""}">
        <div class="price-list-column-stack">${renderStack(page.right)}</div>
        <div class="price-list-column-stack">${renderStack(page.left)}</div>
      </div>`;
    }).join("\n");
  }

  function render(options = {}) {
    const groups = Array.isArray(options.groups) ? options.groups : [];
    const pagesLayout = resolvePagesLayout(groups, options);
    const tools = options.tools || null;
    const toolsMarkup = tools ? `
      <div class="price-list-document-tools no-print">
        <button type="button" onclick="window.print()">طباعة مباشرة</button>
        <a data-pdf-open href="${escapeHtml(tools.pdfFile)}">فتح PDF</a>
        <a data-pdf-download href="${escapeHtml(tools.pdfFile)}" download>تنزيل PDF</a>
        <button class="theme-switch" type="button" onclick="toggleTheme()">فاتح / داكن</button>
      </div>` : "";
    const mainMarkup = renderPagesBlock(pagesLayout.mainPages, true);
    const specialMarkup = pagesLayout.specialPages.length
      ? renderPagesBlock(pagesLayout.specialPages, false)
      : "";
    return `
      <style data-ozk-price-list-style="${VERSION}">${CSS}</style>
      <section class="ozk-price-list${tools ? " has-document-tools" : ""}" lang="ar" dir="rtl" translate="no" data-theme="${options.theme === "light" ? "light" : "dark"}" data-template-version="${VERSION}">
        ${toolsMarkup}
        <header class="price-list-header">
          <img src="${escapeHtml(options.logoSrc)}" alt="OZK TOBACCO" class="price-list-header-logo">
          <div class="price-list-header-center">
            <div class="price-list-header-title">نشرة الأسعار</div>
            <div class="price-list-header-date" dir="ltr">${renderIssueDate(options.issueDate)}</div>
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
        ${mainMarkup}
        ${specialMarkup}
      </section>`;
  }

  // مستند طباعة مستقل كامل يلفّ نفس ناتج render() حرفياً. الطباعة الأصلية
  // للمتصفح («حفظ بصيغة PDF») هي محرك تصدير النشرة المعتمد: هي وحدها التي
  // تُشكّل الحروف العربية صحيحاً، وتحترم break-before:page فلا تُنتج صفحات
  // بيضاء، وترسم الخلفية الداكنة على كامل الورقة. لا يُبنى هنا أي HTML بديل —
  // `bodyHtml` يجب أن يكون ناتج render() نفسه الذي تعرضه المعاينة، كي يستحيل
  // أن يختلف الملف المصدَّر عن المعاينة.
  function printDocument(options = {}) {
    const theme = options.theme === "light" ? "light" : "dark";
    const title = String(options.title || "نشرة الأسعار");
    const bodyHtml = String(options.bodyHtml || "");
    return `<!doctype html>
<html lang="ar" dir="rtl" translate="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=794">
<meta name="google" content="notranslate">
<title>${escapeHtml(title)}</title>
<style>${documentBackgroundCss(theme)}</style>
</head>
<body data-theme="${theme}">${bodyHtml}</body>
</html>`;
  }

  root.OZKPriceListTemplate = Object.freeze({
    VERSION,
    CSS,
    THEME_PAGE_BACKGROUND,
    themePageBackground,
    documentBackgroundCss,
    printDocument,
    formatArabicIssueDate,
    layoutGroups,
    pageCount,
    render,
    renderGroup,
    computePageContentHeightPx,
    packGroupsIntoBalancedPages,
    layoutGroupsMeasured,
    DEFAULT_SAFETY_MARGIN_PX,
    COLUMNS_PADDING_BOTTOM_PX
  });
})(globalThis);
