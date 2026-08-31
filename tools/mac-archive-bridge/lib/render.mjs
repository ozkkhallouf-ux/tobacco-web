// تحويل HTML المستند إلى PDF محلياً عبر Chromium (Playwright).
//
// لماذا لا نولّد الـPDF داخل المتصفح ونرسله؟ لأن مسار سطح المكتب في الموقع
// يستعمل طباعة المتصفح الأصلية (`printHtmlDocument`) ولا ينتج Blob أصلاً،
// ومحرّك html2canvas معروف بإخراج صفحات بيضاء بعد تحديثات كروم (راجع تعليق
// `exportReportPdf` في src/app.js). Chromium هنا هو المحرّك نفسه الذي تستعمله
// نافذة الطباعة، فيخرج النص العربي متجهاً (vector) قابلاً للبحث ومطابقاً لما
// يراه المالك على الشاشة. المستودع يستعمل Playwright أصلاً في
// scripts/generate-pdfs.mjs فلا تبعية جديدة.

let chromiumPromise = null;
let browser = null;
let idleTimer = null;

async function getChromium() {
  if (!chromiumPromise) {
    chromiumPromise = import("playwright")
      .then((mod) => mod.chromium)
      .catch(() => null);
  }
  return chromiumPromise;
}

/** هل محرّك التحويل متاح فعلاً على هذا الجهاز؟ */
export async function renderAvailable() {
  const chromium = await getChromium();
  if (!chromium) return false;
  try {
    return Boolean(chromium.executablePath());
  } catch {
    return false;
  }
}

function scheduleIdleClose(idleMs) {
  if (idleTimer) clearTimeout(idleTimer);
  if (!idleMs) return;
  idleTimer = setTimeout(() => { closeBrowser().catch(() => {}); }, idleMs);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

export async function closeBrowser() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const current = browser;
  browser = null;
  if (current) await current.close().catch(() => {});
}

async function getBrowser() {
  const chromium = await getChromium();
  if (!chromium) throw new Error("Playwright غير مثبّت — شغّل: npm install ثم npx playwright install chromium");
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

const DOC_START = /^\s*(?:<!doctype|<html\b)/i;

/** هل النص مستند HTML كامل أم شذرة body فقط؟ */
export function isFullDocument(html) {
  return DOC_START.test(String(html || ""));
}

// نفس هيكل المستند الذي يبنيه `exportReportPdf` لنافذة الطباعة على سطح المكتب،
// كي تكون النسخة المؤرشفة مطابقة لما يطبعه المالك بيده حرفياً.
export function wrapReportDocument(bodyHtml, baseUrl) {
  const base = baseUrl ? `<base href="${escapeAttr(baseUrl)}">` : "";
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">'
    + base
    + "<style>@page{size:A4 portrait;margin:10mm}"
    + "html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}"
    + "img{max-width:100%}table{page-break-inside:auto}tr{page-break-inside:avoid}"
    + "thead{display:table-header-group}tfoot{display:table-footer-group}"
    + "@media print{.ozk-rpt{padding:0}}</style>"
    + "</head><body>" + bodyHtml + "</body></html>";
}

function escapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** يحقن <base> داخل مستند كامل لا يحتوي واحداً، كي تُحلّ الصور النسبية. */
function injectBase(html, baseUrl) {
  if (!baseUrl || /<base\b/i.test(html)) return html;
  const tag = `<base href="${escapeAttr(baseUrl)}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + tag + "</head>");
}

/**
 * يحوّل HTML إلى PDF.
 * @param {string} html شذرة body أو مستند كامل
 * @param {{baseUrl?:string, timeoutMs?:number, idleMs?:number}} options
 * @returns {Promise<Buffer>}
 */
export async function renderHtmlToPdf(html, options = {}) {
  const { baseUrl = "", timeoutMs = 30000, idleMs = 0 } = options;
  const source = String(html || "");
  if (!source.trim()) throw new Error("محتوى المستند فارغ");

  const document = isFullDocument(source)
    ? injectBase(source, baseUrl)
    : wrapReportDocument(source, baseUrl);

  let allowedPrefix = "";
  if (baseUrl) {
    try { allowedPrefix = new URL(baseUrl).origin; } catch { allowedPrefix = ""; }
  }

  const instance = await getBrowser();
  const context = await instance.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    // حصر الشبكة: لا شيء يخرج إلا إلى أصل الموقع نفسه (لتحميل الشعار مثلاً).
    // بلا هذا يصير الجسر أداة جلب لأي رابط يضعه المُرسل داخل الـHTML.
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) {
        return route.continue();
      }
      if (allowedPrefix && (url === allowedPrefix || url.startsWith(allowedPrefix + "/"))) {
        return route.continue();
      }
      return route.abort();
    });

    await page.setContent(document, { waitUntil: "load", timeout: timeoutMs }).catch(async (error) => {
      // مورد بطيء أو مقطوع لا يمنع إخراج المستند: القوالب تُخفي الشعار عند فشله
      // (onerror) فيبقى التقرير صحيحاً. أي خطأ آخر يُرفع كما هو.
      if (!/Timeout/i.test(String(error && error.message))) throw error;
    });
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      timeout: timeoutMs
    });
    return pdf;
  } finally {
    await context.close().catch(() => {});
    scheduleIdleClose(idleMs);
  }
}
