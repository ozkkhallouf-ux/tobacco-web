// ============================================================================
// OZK OFFICIAL FONT — الخط الرسمي الموحّد لهوية OZK TOBACCO
//
// المرجع: «فاتورة-البسطة-OZK.pdf» (2026-10-22). فحص pdffonts وجدول name في
// الخطوط المضمّنة فيه: Cairo الإصدار 3.130 (gftools 0.9.24)، الوزنان 400 و700،
// fsType=0 (تضمين حر). الترخيص SIL Open Font License 1.1 — public/fonts/cairo/OFL.txt.
//
// هذا الملف **المصدر الوحيد** لاسم الخط وسلسلته الاحتياطية وعناوين ملفاته:
//   · يحقن @font-face ومتغيّرَي --ozk-font و--ozk-doc-line-height في مستند التطبيق
//     (styles.css يقرأ المتغيّر ولا يكتب اسم الخط بنفسه).
//   · قوالب المستندات (فاتورة، تقارير، إيصال الدفع، فواتير المشتريات) تقرأ
//     var(--ozk-font, …) بدل كتابة "Tahoma,Arial" حرفياً. فاتورة الكاشير 80mm
//     مستثناة بقرار المالك (2026-10-22) وتبقى على خطها الأصلي.
//   · المستندات المستقلة (إطار الطباعة srcdoc، نسخة iCloud، نافذة دفتر الجرد)
//     لا ترث خطوط الصفحة، فتأخذ @font-face بعناوين مطلقة عبر withFaces().
//
// متزامن غير defer عمداً: يُحمَّل في <head> قبل كل سكربت يبني مستنداً، فيبدأ
// تنزيل الخط قبل أي قياس ارتفاعات (تقسيم صفحات الجرد والنشرة يقيس النص في
// مستند التطبيق) وقبل أي التقاط html2canvas.
//
// الملفات woff2 مقسّمة عربي/لاتيني بـunicode-range كما تقدّمها Google Fonts،
// وأسماؤها تحمل رقم الإصدار فلا تتغيّر أبداً — لا تحتاج معامل ?v=.
// ============================================================================

const OZK_FONT = (() => {
  const FAMILY = "Cairo";
  const VERSION = "3.130";
  // الاحتياط هو سلسلة المشروع السابقة نفسها: إن تعذّر تحميل Cairo يرجع المستند
  // كما كان تماماً، لا إلى خط غريب.
  const STACK = "Cairo,Tahoma,Arial,sans-serif";
  const WEIGHTS = Object.freeze([400, 700]);
  // ارتفاع سطر المستندات المطبوعة. مقاييس Cairo (ascent 1.303 + descent 0.571)
  // تجعل الارتفاع «normal» = 1.874em مقابل 1.207em لـTahoma، فبلا قيمة صريحة
  // يطول كل صف جدول نحو 30% وتزيد أوراق الفاتورة. 1.35 يُبقي ترقيم الصفحات
  // قريباً من السابق ويترك لذيول الحروف (ي ج ع) مكانها داخل حشوة الخلية.
  const DOC_LINE_HEIGHT = "1.35";

  const RANGES = Object.freeze({
    arabic: "U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0897-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC",
    latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
  });

  const FILE = (subset, weight) => `public/fonts/cairo/cairo-${VERSION}-${subset}-${weight}.woff2`;

  // أساس العناوين: مجلد المستودع الجذري المشتق من عنوان هذا السكربت نفسه
  // (src/ozk-font.js)، فتعمل العناوين من الجذر ومن أي مسار فرعي على Pages.
  const scriptSrc = (typeof document !== "undefined" && document.currentScript && document.currentScript.src) || "";
  const BASE = (() => {
    try {
      if (scriptSrc) return new URL("../", scriptSrc).href;
      if (typeof document !== "undefined" && document.baseURI) return new URL("./", document.baseURI).href;
    } catch {
      // يُكمل بالعناوين النسبية.
    }
    return "";
  })();

  const url = (subset, weight, prefix) => {
    if (typeof prefix === "string") return prefix + FILE(subset, weight);
    return BASE ? new URL(FILE(subset, weight), BASE).href : FILE(subset, weight);
  };

  // `prefix` اختياري: مسار نسبي إلى جذر المستودع لصفحة مولَّدة خارج التطبيق
  // (نشرات public/downloads/ تمرّر "../../"). بلا prefix: عناوين مطلقة.
  function faceCss(prefix) {
    return WEIGHTS.flatMap((weight) => Object.keys(RANGES).map((subset) =>
      `@font-face{font-family:"${FAMILY}";font-style:normal;font-weight:${weight};font-display:swap;`
      + `src:url("${url(subset, weight, prefix)}") format("woff2");unicode-range:${RANGES[subset]}}`
    )).join("");
  }

  // الأوجه + متغيّرا الجذر. القوالب تكتب var(--ozk-font, <السلسلة القديمة>) فتبقى
  // كما كانت حرفياً في أي سياق لم يُحقن فيه هذا (فحوص vm، أداة خارجية).
  function rootCss() {
    return `${faceCss()}:root{--ozk-font:${STACK};--ozk-doc-line-height:${DOC_LINE_HEIGHT}}`;
  }

  // يُدرج @font-face في <head> مستند HTML مستقل (نص)، مرة واحدة.
  function withFaces(html) {
    const source = String(html == null ? "" : html);
    if (source.includes("data-ozk-font-face")) return source;
    const tag = `<style data-ozk-font-face>${rootCss()}</style>`;
    if (/<head[^>]*>/i.test(source)) return source.replace(/<head[^>]*>/i, (open) => `${open}${tag}`);
    return tag + source;
  }

  // يحمّل الأوجه الأربعة فعلاً (document.fonts.load) — unicode-range وحده لا ينزّل
  // الخط قبل أن يظهر نص يحتاجه، والقياس قد يسبق ذلك.
  function load(doc) {
    const target = doc || (typeof document !== "undefined" ? document : null);
    if (!target || !target.fonts || typeof target.fonts.load !== "function") return Promise.resolve(false);
    const jobs = WEIGHTS.flatMap((weight) => [
      target.fonts.load(`${weight} 16px "${FAMILY}"`, "ابت"),
      target.fonts.load(`${weight} 16px "${FAMILY}"`, "0123456789")
    ]);
    return Promise.all(jobs).then((sets) => sets.every((set) => set && set.length > 0), () => false);
  }

  // انتظار بسقف: خط لا يصل أبداً يجب ألا يوقف طباعة أو تصدير PDF.
  function ready(timeoutMs = 3000) {
    return Promise.race([
      load(),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
  }

  if (typeof document !== "undefined" && document.head && !document.querySelector("style[data-ozk-font-face]")) {
    const style = document.createElement("style");
    style.setAttribute("data-ozk-font-face", "");
    style.textContent = rootCss();
    document.head.appendChild(style);
    void load();
  }

  return Object.freeze({ FAMILY, VERSION, STACK, WEIGHTS, DOC_LINE_HEIGHT, RANGES, FILE, faceCss, rootCss, withFaces, load, ready });
})();

// globalThis كي تستورده سكربتات Node (توليد النشرات) بـimport جانبي.
globalThis.OZK_FONT = OZK_FONT;
