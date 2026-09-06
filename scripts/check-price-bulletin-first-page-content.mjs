// حارس توزيع **الورقة الأولى** في نشرة الأسعار.
//
// العطل الذي يغلقه (بلاغ إنتاجي، نشرة الليرة، معاينة طباعة كروم على جهاز المالك):
//   عند «حفظ / مشاركة PDF» تخرج النشرة بأربع أوراق، **الورقة الأولى فيها الرأس
//   وحده** بلا صنف واحد، وكل المجموعات تبدأ من الورقة الثانية. أي أن الزبون
//   يستلم نشرةً تفتح بورقة عنوان لم يطلبها أحد.
//
// **لماذا لم يرصده الحارس القائم** (`check-price-bulletin-print-content.mjs`):
//   ذلك الحارس يسأل «هل كل صنف مطبوع **في مكان ما** داخل الملف؟» و«هل كل ورقة
//   تحمل أصنافاً؟». وكلا السؤالين يمرّ في هذا العطل تحديداً حين تكون البيانات
//   المستعملة في الفحص لا تُطلق الحالة: الأصناف كلّها موجودة فعلاً (لكن على
//   الورقة الثانية فصاعداً)، ولا ورقة فارغة (الورقة الأولى تحمل الرأس، وهو
//   نصّ مطبوع). فالسؤال الصحيح ليس «أين وُجدت الأصناف؟» بل **«ماذا يقع على
//   الورقة الأولى نفسها؟»** — وهو ما يقيسه هذا الحارس وحده.
//
// السببان اللذان يُنتجان الورقة العنوان، وكلاهما مُثبَّت هنا:
//
//   ١) **حتمي — الفاصل القسري يرثه بلوك ليس صاحبه.** حين تخرج الصفحة الأولى
//      المخطَّطة بلا مجموعات (لا تتّسع أي مجموعة تحت الرأس)، كان
//      `renderPagesBlock` يحذف كتلتها الفارغة **ويُبقي مكانها في المصفوفة**،
//      فيصير أولُ بلوك مرسوم فعلاً «ليس الأول» ويأخذ `break-before:page` —
//      فتُدفع كل الأصناف إلى الورقة التالية ويبقى الرأس وحيداً. (سيناريو ٢)
//
//   ٢) **هامشي — كتلة الأعمدة الأولى تتجاوز ورقتها ببضعة بكسلات.** كروم لا
//      يشطرها عندها بل ينقلها **كاملةً** إلى الورقة الثانية. قياس فعلي عبر
//      `page.pdf()`: تجاوز 3.86px ⇒ ورقة أولى بـ34 مقطع نصّ (الرأس وحده) وورقة
//      ثانية بـ793 مقطعاً (كل الأصناف). ومصدر التجاوز بنيوي: الارتفاعات تُقاس
//      في **مستند التطبيق** وتُطبع في **إطار طباعة آخر**، والمستندان لا
//      يتّفقان (قياس فعلي على نفس البيانات: عمود قِيس 949px خرج مطبوعاً 902px).
//      وبهامش الأمان وحده (6px) كان أسوأ حالٍ مسموح يترك 5.58px تحت حافة
//      الورقة — أي العطل على بُعد خطأ تقريب واحد. (سيناريو ٤)
//
// القاعدة التي يفرضها هذا الملف: **الورقة الأولى تحمل الرأس ومعه أصناف، دائماً،
// متى كان تحت الرأس حيّز فعلي.** ورقة عنوان مستقلّة لا تُطبع إلا بقرار صريح.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { pdfPageLines, normalizeArabic, printedRow, printedGroup } from "./lib/price-bulletin-pdf-text.mjs";
import { FONT_USABLE_PROBE, prepareBulletinFont } from "./lib/bulletin-font-ready.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8"
};
const server = createServer((req, res) => {
  const clean = decodeURIComponent(String(req.url || "/").split("?")[0]);
  let target = normalize(join(root, clean === "/" ? "/index.html" : clean));
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) target = join(root, "index.html");
  res.setHeader("Content-Type", TYPES[extname(target)] || "application/octet-stream");
  createReadStream(target).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); }
};

// تأكيدٌ يعتمد على **شكل الحروف** داخل الملف، فيلزمه خط النشرة: بلا الخط تُرسم
// السلسلة الاحتياطية، وهي تختلف بين الأنظمة وقد لا تحمل محارف عربية أصلاً —
// فتفشل المطابقة لسببٍ يخصّ النظام لا الكود. وربطُ بوابةٍ إلزامية بالوصول إلى
// Google Fonts يستبدل بعطلٍ بيئي عطلاً شبكياً (ملاحظة Codex P1 على 1aa1a6f).
//
// **لكن التعليق وحده يفتح ثغرة**: تشغيلٌ بلا شبكة كان سيمرّ حتى لو أُخفي كل نصّ
// الأصناف من الورق (ملاحظة Codex P1 على 3333ecf). لذلك لا يُعلَّق شيء إلا وله
// بديلٌ **مستقلّ عن شكل الحروف** يبقى مفروضاً دائماً، ويُعلَن في كل سيناريو:
//   · كل صفٍّ متوقَّع موجود نصّاً في مستند الطباعة (يرصد الحذف والتشويه)؛
//   · وكمّ النصّ المرسوم على كل ورقة يوازي ما خُطِّط لها (يرصد ما لم يصل الورق).
const SKIP_NOTE = "خط النشرة غير متاح (شبكة) — المطابقة الحرفية معلَّقة، والبديل المستقلّ عن الخط مفروض";
let skipped = 0;
const checkWithFont = (fontReady, name, condition, detail) => {
  if (!fontReady) { skipped += 1; console.log(`  ⏭️  ${name} — ${SKIP_NOTE}`); return; }
  check(name, condition, detail);
};

// صفوف مستند الطباعة كما هي في الترميز — **مطابقة صفٍّ كامل، لا احتواء نصّي**
// (مستقلّة عن الخط تماماً).
//
// لماذا الصفّ كاملاً: التطبيع يحذف الفراغات، فاسمُ صنفٍ أقصر قد يكون مقطعاً
// داخل اسم أطول («اليغانس سليم فضي» داخل «اليغانس سليم فضي بدون طبعة»)، فيقبله
// `includes` ويمرّ حذفُ الأقصر زوراً — وهي نفس ثغرة الاحتواء التي أُغلقت في
// قارئ الـPDF (ملاحظة Codex P1 على 3468f90). فنقارن الخلايا الثلاث بالتساوي
// التام مع صفٍّ واحد من الترميز.
//
// ومستندٌ غائب (فشل الزر في إنتاجه) = **كل الصفوف مفقودة**، لا «لا شيء مفقود»
// (ملاحظة DeepScan INSUFFICIENT_NULL_CHECK).
const flattenForMarkup = (value) => String(value).normalize("NFKC").replace(/\s+/g, "");
const MARKUP_CELL_SEPARATOR = "\u0001";
function markupRowKeys(documentHtml) {
  const keys = new Set();
  for (const row of String(documentHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      .map((cell) => flattenForMarkup(cell[1].replace(/<[^>]*>/g, "")));
    if (cells.length) keys.add(cells.join(MARKUP_CELL_SEPARATOR));
  }
  return keys;
}
function rowsMissingFromMarkup(documentHtml, rows) {
  if (typeof documentHtml !== "string" || !documentHtml) return [...rows];
  const keys = markupRowKeys(documentHtml);
  return rows.filter((row) => !keys.has(
    [row.name, row.unit, row.price].map(flattenForMarkup).join(MARKUP_CELL_SEPARATOR)));
}

const A4_HEIGHT_PX = 297 / 25.4 * 96;

// ===== بيانات بشكل بيانات الإنتاج =====
const raw = JSON.parse(readFileSync(resolve(root, "scripts/price-data.json"), "utf8"));
const ITEMS = raw.map((r) => ({
  key: r.item_key, name: r.name, groupName: r.group,
  stockQty: (r.unitFactor || 50) * 8,
  unit1Name: r.unit1 || "كروز", unit2Name: r.unit || "كرتونة", unit2Factor: r.unitFactor || 50
}));
const PRICES = raw.map((r) => ({
  itemKey: r.item_key, unit1Name: r.unit1 || "كروز", unit2Name: r.unit || "كرتونة",
  unit2Factor: r.unitFactor || 50, unit2Price: r.usd,
  pricePayload: { retail: { price: r.usd } }, updatedAt: "2026-08-31T00:00:00.000Z"
}));

const browser = await chromium.launch();

async function bootApp(width, height, { blockWebfont = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**://*.supabase.co/**", (route) => route.abort());
  if (blockWebfont) await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.buildBulletinDataset === "function", null, { timeout: 20000 });
  await page.evaluate(({ items, prices }) => {
    const state = (0, eval)("state");
    const reports = [{ items, summary: { syncedAt: "2026-08-31T00:00:00.000Z" } }];
    window.tobaccoData.isConfigured = () => false;
    window.tobaccoData.listInventoryReports = async () => reports;
    window.tobaccoData.listApprovedPriceItems = async () => prices;
    window.tobaccoData.getSyriaExchangeRate = async () => 14050;
    window.tobaccoData.setSyriaExchangeRate = async (v) => Number(v);
    state.inventoryReports = reports;
    state.approvedPriceItems = prices;
    state.syriaExchangeRate = 14050;
    state.syriaRateConfirmed = true;
  }, { items: ITEMS, prices: PRICES });
  // خط النشرة لا يبدأ تحميله إلا حين تدخل قواعد القالب (وفيها `@import`) إلى
  // المستند — إلا في سيناريو حجب الخط عمداً، فانتظاره هناك بلا معنى.
  const fontReady = blockWebfont ? false : await prepareBulletinFont(page);
  return { context, page, fontReady };
}

// يطبع مستند تصدير جاهزاً ويُرجع نصّ كل ورقة + هندسة كتل الأعمدة.
async function printExportDocument(documentHtml) {
  const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route(`${BASE}/__firstpage`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
  // `networkidle` غير موثوق هنا: اتصال خطوط Google قد يبقى مفتوحاً فتنتهي المهلة
  // ويسقط الفحص لسبب شبكي لا علاقة له بالمقيس. ننتظر تحميل المستند ثم **جهوزية
  // الخطوط تحديداً** — وهي وحدها ما يؤثر في الهندسة — بمهلة محدودة لا تُسقِط
  // الفحص: خطٌّ لا يصل يعني رسماً بالاحتياطي، وهو حالة مشروعة نقيسها كما هي.
  await page.goto(`${BASE}/__firstpage`, { waitUntil: "load" });
  await page.evaluate(() => Promise.race([
    document.fonts.ready.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 10000))
  ]));
  await page.emulateMedia({ media: "print" });
  const geometry = await page.evaluate(() => {
    const section = document.querySelector(".ozk-price-list");
    const top = section.getBoundingClientRect().top;
    const subheader = section.querySelector(".price-list-subheader");
    const headerHeight = section.querySelector(".price-list-header").getBoundingClientRect().height
      + subheader.getBoundingClientRect().height
      + (parseFloat(getComputedStyle(subheader).marginBottom) || 0);
    const blocks = [...section.querySelectorAll(".price-list-columns")].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        top: +(rect.top - top).toFixed(2),
        bottom: +(rect.bottom - top).toFixed(2),
        height: +rect.height.toFixed(2),
        forcedBreak: el.classList.contains("price-list-secondary-page")
      };
    });
    // **كل صفٍّ مخطَّط يجب أن يُرسم فعلاً على الورق.** بلا خط النشرة تتعذّر مطابقة
    // النصّ، وحينها لا يكفي وجود الاسم في الترميز: انحدارُ طباعةٍ مثل
    // `display:none` يُبقي الأسماء بلا رسم. ولا يكفي صندوقُ التخطيط وحده:
    // `visibility:hidden` أو `opacity:0` يُبقيان الصندوق كاملاً ولا يُرسم شيء
    // (ملاحظتا Codex P1 على 3468f90 و34e7874). فنسأل المتصفح نفسه عن الظهور
    // عبر `checkVisibility`، ونُكمل بفحص صريح للخاصّيتين حيث لا تتوفّر.
    const rows = [...section.querySelectorAll("tbody tr")];
    const unrenderedRows = rows.filter((tr) => {
      const rect = tr.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return true;
      if (typeof tr.checkVisibility === "function"
        && !tr.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })) {
        return true;
      }
      for (let node = tr; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return true;
      }
      return false;
    }).length;
    return { headerHeight: +headerHeight.toFixed(2), blocks, renderedRowCount: rows.length, unrenderedRows };
  });
  const pdf = await page.pdf({
    format: "A4", printBackground: true, preferCSSPageSize: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" }
  });
  await context.close();
  return { sheets: pdfPageLines(pdf), geometry };
}

// هل هذه الورقة تحمل الرأس؟ عنوان النشرة سطرٌ مستقلّ في الملف.
const HEADER_TITLE = normalizeArabic("نشرة الأسعار");
function sheetCarriesHeader(sheetLines) {
  return sheetLines.some((line) => line.join("") === HEADER_TITLE);
}

// كم صفّ صنف من هذه القائمة مطبوع على هذه الورقة **نفسها**؟
function rowsOnSheet(sheetLines, rows) {
  return rows.filter((row) => printedRow(sheetLines, row)).length;
}

// شرط صحة القراءة: القارئ يقارن صفّاً كاملاً بسطر واحد، فاسمٌ يلتفّ داخل خليته
// يتوزّع على سطرين ولا يُطابَق. نفس الشرط المفروض في حارس محتوى الطباعة.
const WRAP_PROBE = `(markup) => {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;visibility:hidden;pointer-events:none";
  probe.innerHTML = markup;
  probe.querySelector(".ozk-price-list").setAttribute("data-measure-print", "");
  document.body.appendChild(probe);
  try {
    return [...probe.querySelectorAll("td.name, .price-list-group-name")]
      .filter((cell) => {
        const lineHeight = parseFloat(getComputedStyle(cell).lineHeight) || 14;
        return cell.getBoundingClientRect().height > lineHeight * 1.4;
      })
      .map((cell) => cell.textContent.trim());
  } finally { probe.remove(); }
}`;

// ===== ١) المسار الحقيقي: زر «حفظ / مشاركة PDF» =====
// المستند يُلتقط من **إطار الطباعة الذي يفتحه الزر نفسه**، لا من المعاينة،
// ثم يُطبع فعلياً ويُقرأ نصّ ورقته الأولى.
for (const sc of [
  { label: "نشرة الليرة (مفرق) — داكن", useSyria: true, theme: "dark", vw: 1440, vh: 900 },
  { label: "نشرة الدولار (جملة) — داكن", useSyria: false, theme: "dark", vw: 1440, vh: 900 },
  { label: "نشرة الليرة على هاتف 390px", useSyria: true, theme: "dark", vw: 390, vh: 844 }
]) {
  const { context, page, fontReady } = await bootApp(sc.vw, sc.vh);
  await page.evaluate((sc) => {
    (0, eval)("state").syriaRateConfirmed = true;
    window.openPricePreview(sc.useSyria, sc.theme);
  }, sc);
  await page.waitForSelector("[data-action='export-price-preview']", { timeout: 10000 });
  // ما خطّطت له الخطة للصفحة الأولى تحديداً — هوية ما يجب أن يقع على الورقة الأولى.
  const planned = await page.evaluate(() => {
    const state = (0, eval)("state");
    const plan = window.bulletinRenderPlan(
      window.buildBulletinDataset(state.pricePreview.useSyria, state.pricePreview.theme).dataset);
    const firstPage = plan.layout.mainPages[0];
    const firstGroups = [...firstPage.right, ...firstPage.left];
    return {
      markup: plan.markup,
      totalGroups: plan.groups.length,
      totalRows: plan.groups.reduce((n, g) => n + g.items.length, 0),
      firstPageGroups: firstGroups.map((g) => ({ name: g.name, count: String(g.items.length) })),
      firstPageRows: firstGroups.flatMap((g) => g.items.map((it) => ({ name: it.name, unit: it.unit, price: it.price })))
    };
  });

  const wrapped = await page.evaluate(
    ([markup, probe]) => new Function(`return ${probe}`)()(markup), [planned.markup, WRAP_PROBE]);

  await page.click("[data-action='export-price-preview']");
  await page.waitForFunction(() => Boolean(document.querySelector("iframe[data-print-frame]")), null, { timeout: 10000 });
  const documentHtml = await page.evaluate(() =>
    document.querySelector("iframe[data-print-frame]").getAttribute("srcdoc"));
  await context.close();

  check(`${sc.label}: لا اسم يلتفّ في هندسة الطباعة (شرط قراءة الملف سطراً سطراً)`,
    wrapped.length === 0, `أسماء ملتفّة: ${JSON.stringify(wrapped.slice(0, 5))}`);

  check(`${sc.label}: الخطة تضع مجموعات على الصفحة الأولى (حيّز فعلي تحت الرأس)`,
    planned.firstPageGroups.length > 0,
    `الصفحة الأولى المخطَّطة فارغة رغم وجود ${planned.totalGroups} مجموعة`);

  const printed = await printExportDocument(documentHtml);
  const firstSheet = printed.sheets[0] || [];

  checkWithFont(fontReady, `${sc.label}: الورقة الأولى تحمل رأس النشرة`, sheetCarriesHeader(firstSheet),
    "عنوان «نشرة الأسعار» غير مطبوع على الورقة الأولى");

  // **جوهر الحارس.** لا «موجود في مكان ما بالملف»: كل صفّ خطّطت له الخطة
  // للصفحة الأولى يجب أن يُطبع على الورقة الأولى **نفسها**.
  // **بديلٌ مستقلّ عن الخط، مفروض دائماً.** يرصد إخفاء نصّ الأصناف أو تشويهه
  // حتى حين تتعذّر المطابقة الحرفية لغياب خط النشرة.
  const missingFromMarkup = rowsMissingFromMarkup(documentHtml, planned.firstPageRows);
  check(`${sc.label}: صفوف الصفحة الأولى موجودة نصّاً في مستند الطباعة (مستقلّ عن الخط)`,
    missingFromMarkup.length === 0, `مفقودة من الترميز: ${JSON.stringify(missingFromMarkup.slice(0, 5))}`);

  // **كل صفٍّ يُنتج رسماً فعلياً** — قياس هندسي لا نصّي، فيسري حتى بلا خط النشرة.
  // يرصد انحدار طباعةٍ (مثل `display:none`) يُبقي الاسم في الترميز بلا رسم.
  check(`${sc.label}: كل صفوف المستند مرسومة فعلاً (لا صفّ بلا رسم)`,
    printed.geometry.unrenderedRows === 0,
    `${printed.geometry.unrenderedRows} صفاً بلا ارتفاع أو عرض من ${printed.geometry.renderedRowCount}`);

  check(`${sc.label}: عدد صفوف المستند = عدد صفوف الـdataset`,
    printed.geometry.renderedRowCount === planned.totalRows,
    `في المستند ${printed.geometry.renderedRowCount} · بالبيانات ${planned.totalRows}`);

  const onFirst = rowsOnSheet(firstSheet, planned.firstPageRows);
  checkWithFont(fontReady, `${sc.label}: الورقة الأولى تحمل أصنافاً فعلاً (لا ورقة عنوان)`, onFirst > 0,
    `صفر صنف على الورقة الأولى من ${planned.firstPageRows.length} صنفاً مخطَّطاً لها`
    + ` — أوراق الملف = ${printed.sheets.length}`);

  checkWithFont(fontReady, `${sc.label}: كل صفوف الصفحة الأولى المخطَّطة (${planned.firstPageRows.length}) مطبوعة على الورقة الأولى`,
    onFirst === planned.firstPageRows.length,
    `مطبوع على الورقة الأولى ${onFirst} من ${planned.firstPageRows.length}`);

  const missingFirstGroups = planned.firstPageGroups.filter((g) => !printedGroup(firstSheet, g));
  checkWithFont(fontReady, `${sc.label}: كل رؤوس مجموعات الصفحة الأولى (${planned.firstPageGroups.length}) على الورقة الأولى`,
    missingFirstGroups.length === 0, `مفقودة عن الورقة الأولى: ${JSON.stringify(missingFirstGroups.slice(0, 6))}`);

  // الفاصل القسري ملك أول كتلة **مرسومة**: لو حمله أولُ بلوك لهُجر الرأس وحده.
  check(`${sc.label}: أول كتلة أعمدة مرسومة بلا فاصل قسري (تشارك الرأس ورقته)`,
    printed.geometry.blocks.length > 0 && printed.geometry.blocks[0].forcedBreak === false,
    `أول كتلة تحمل price-list-secondary-page — الرأس يبقى وحده على الورقة الأولى`);

  // خلوص الحافة: الكتلة الأولى تعيش تحت الرأس على نفس الورقة.
  const firstBlock = printed.geometry.blocks[0];
  const clearance = firstBlock ? +(A4_HEIGHT_PX - firstBlock.bottom).toFixed(2) : null;
  check(`${sc.label}: كتلة الأعمدة الأولى داخل ورقتها (الأولى محسوبة مع الرأس)`,
    firstBlock != null && firstBlock.bottom <= A4_HEIGHT_PX + 0.5,
    `أسفل الكتلة ${firstBlock?.bottom} مقابل حدّ A4 ${A4_HEIGHT_PX.toFixed(2)} — خلوص ${clearance}px`);
}

// ===== ٢) ورقة العنوان مسموحة في حالة واحدة فقط — وبلا فقدان ولا قصّ =====
// حين لا تتّسع أي مجموعة تحت الرأس تخرج `mainPages[0]` فارغة، وتكون الكتلة
// التالية مُعبَّأة بميزانية **ورقة كاملة**. وضعُها تحت الرأس عندئذٍ يُنتج كتلة
// أطول من ورقتها بمقدار الرأس: كروم يُجزّئ، وسفاري على iPhone يدفع الكتلة
// كاملةً بينما `overflow:hidden` يقصّ ما خرج — أي أصناف لا تصل الزبون
// (ملاحظة Codex P1 على 1de3a48). فالقرار الصريح: تبقى ورقة العنوان في هذه
// الحالة وحدها، ويُفرض ألا يضيع صنف وألا تتجاوز كتلةٌ ورقتها.
// يُبنى من نفس دالتَي التصدير (`render` + `printDocument`) اللتين يستدعيهما
// زرّ «حفظ / مشاركة PDF» في `exportBulletinPdf`.
{
  const { context, page, fontReady: emptyFirstFontReady } = await bootApp(1440, 900);
  const built = await page.evaluate(() => {
    const T = window.OZKPriceListTemplate;
    const mk = (name, count) => ({
      name,
      items: Array.from({ length: count }, (_, i) => ({
        name: `${name} صنف رقم ${i + 1}`, unit: "كرتونة", price: "12,345 ل.س"
      }))
    });
    const groups = [mk("ماستر", 12), mk("غلواز", 12), mk("اوسكار", 10), mk("اليغانس", 10)];
    const renderOptions = {
      logoSrc: `${location.origin}/public/icons/ozk-logo.png`,
      issueDate: T.formatArabicIssueDate(new Date()),
      badgeClass: "badge-syp", badgeLabelHtml: "ليرة — مفرق — صرف 14,050",
      unitLabel: "سعر المفرق للوحدة", theme: "dark"
    };
    // ارتفاعات مقاسة حقيقية من نفس القالب (نفس مجسّ buildMeasuredBulletinLayout).
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;visibility:hidden;pointer-events:none";
    probe.innerHTML = T.render({ ...renderOptions, groups });
    probe.querySelector(".ozk-price-list").setAttribute("data-measure-print", "");
    document.body.appendChild(probe);
    let heights;
    try {
      const stack = document.createElement("div");
      stack.className = "price-list-column-stack";
      stack.style.width = `${probe.querySelector(".price-list-column-stack").getBoundingClientRect().width}px`;
      probe.querySelector(".ozk-price-list").appendChild(stack);
      heights = new Map();
      groups.forEach((g) => {
        stack.innerHTML = T.renderGroup(g);
        const el = stack.firstElementChild;
        heights.set(String(g.name), el.getBoundingClientRect().height + (parseFloat(getComputedStyle(el).marginBottom) || 0));
      });
    } finally { probe.remove(); }

    // رأسٌ يملأ الورقة: لا مساحة تحته إطلاقاً ⇒ mainPages[0] تخرج فارغة.
    // هذا هو المولّد الحتمي للحالة؛ الرأس المرسوم يبقى رأس النشرة الطبيعي.
    const layout = T.layoutGroupsMeasured(groups, heights, {
      pageWidthPx: 794, headerHeightPx: T.computePageContentHeightPx(794), safetyMarginPx: 6
    });
    const markup = T.render({ ...renderOptions, groups, layout });
    return {
      documentHtml: T.printDocument({ theme: "dark", title: "نشرة الأسعار", bodyHtml: markup }),
      firstPlannedPageEmpty: layout.mainPages[0].right.length === 0 && layout.mainPages[0].left.length === 0,
      rows: groups.flatMap((g) => g.items.map((it) => ({ name: it.name, unit: it.unit, price: it.price }))),
      totalPlanned: layout.mainPages.length + layout.specialPages.length
    };
  });
  await context.close();

  check("صفحة أولى مخطَّطة فارغة: الحالة المولِّدة تحقّقت فعلاً",
    built.firstPlannedPageEmpty, "الرأس بطول الورقة لم يُفرغ mainPages[0] — السيناريو لم يُبنَ");

  const printed = await printExportDocument(built.documentHtml);
  const firstSheet = printed.sheets[0] || [];
  const onFirst = rowsOnSheet(firstSheet, built.rows);

  checkWithFont(emptyFirstFontReady, "ورقة العنوان: الورقة الأولى تحمل الرأس",
    sheetCarriesHeader(firstSheet), "الرأس نفسه غاب عن الورقة الأولى");

  // القرار الصريح: الكتلة التالية (المعبّأة لورقة كاملة) لا تُوضع تحت الرأس،
  // فتحتفظ بفاصلها القسري. هذا ما يمنع القصّ على سفاري.
  check("ورقة العنوان: الكتلة المعبّأة لورقة كاملة تحتفظ بفاصلها القسري",
    printed.geometry.blocks[0]?.forcedBreak === true,
    "كتلة بميزانية ورقة كاملة وُضعت تحت الرأس — تتجاوز ورقتها ويقصّها سفاري");

  checkWithFont(emptyFirstFontReady, "ورقة العنوان: الورقة الأولى بلا أصناف — وهذا هو السلوك المقصود هنا وحده",
    onFirst === 0,
    `الورقة الأولى تحمل ${onFirst} صنفاً رغم أن الصفحة المخطَّطة فارغة`);

  // الثمن المقبول ورقٌ مهدور، لا صنفٌ ضائع أو مقصوص.
  const anywhere = built.rows.filter((row) => printed.sheets.some((sheet) => printedRow(sheet, row))).length;
  checkWithFont(emptyFirstFontReady, "ورقة العنوان: لا صنف يضيع من الملف",
    anywhere === built.rows.length, `مطبوع ${anywhere} من ${built.rows.length}`);

  const overflowing = printed.geometry.blocks
    .map((b, i) => ({ i, over: +((i === 0 ? b.bottom : b.height) - A4_HEIGHT_PX).toFixed(2) }))
    .filter((r) => r.over > 0.5);
  check("ورقة العنوان: لا كتلة تتجاوز ورقتها (لا شيء يُقصّ)",
    overflowing.length === 0, `تجاوز: ${JSON.stringify(overflowing)}`);
}

// ===== ٢ب) شاهد سالب للبديل المستقلّ عن الخط =====
// البديل يبقى مفروضاً حين يتعذّر الخط، فلا يجوز أن يكون شكلياً. نُثبت أنه يرصد
// حذف صفٍّ من مستند الطباعة، وأنه **لا يقبل الاحتواء النصّي**: اسمٌ أقصر داخل
// اسم أطول لا يُشبِعه (وهي الثغرة التي رصدتها Codex على 3468f90).
{
  const rows = [
    { name: "اليغانس سليم فضي", unit: "كروز", price: "99,000 ل.س" },
    { name: "غلواز قصير أحمر", unit: "كروز", price: "109,560 ل.س" }
  ];
  const asRow = (row) => `<tr><td class="name">${row.name}</td>`
    + `<td class="unit">${row.unit}</td><td class="price">${row.price}</td></tr>`;
  const healthy = `<section class="ozk-price-list"><table><tbody>`
    + rows.map(asRow).join("") + `</tbody></table></section>`;
  const stripped = healthy.replace(asRow(rows[1]), "");
  // نفس الاسم الأقصر مبتلعاً داخل اسم أطول: القاعدة القديمة (`includes`) كانت تقبله.
  const swallowed = healthy.replace(asRow(rows[0]),
    asRow({ ...rows[0], name: `${rows[0].name} بدون طبعة` }));

  check("شاهد سالب (بديل مستقلّ عن الخط): المستند السليم بلا نقص",
    rowsMissingFromMarkup(healthy, rows).length === 0,
    `المرصود: ${JSON.stringify(rowsMissingFromMarkup(healthy, rows).map((r) => r.name))}`);
  check("شاهد سالب (بديل مستقلّ عن الخط): يرصد الصفّ المحذوف",
    rowsMissingFromMarkup(stripped, rows).map((r) => r.name).join("") === rows[1].name,
    `المرصود: ${JSON.stringify(rowsMissingFromMarkup(stripped, rows).map((r) => r.name))}`);
  check("شاهد سالب (بديل مستقلّ عن الخط): لا يقبل اسماً مبتلعاً داخل اسم أطول",
    rowsMissingFromMarkup(swallowed, rows).map((r) => r.name).join("") === rows[0].name,
    `المرصود: ${JSON.stringify(rowsMissingFromMarkup(swallowed, rows).map((r) => r.name))}`);
  check("شاهد سالب (بديل مستقلّ عن الخط): مستند غائب = كل الصفوف مفقودة",
    rowsMissingFromMarkup(null, rows).length === rows.length,
    `المرصود ${rowsMissingFromMarkup(null, rows).length} من ${rows.length}`);
}

// ===== ٢ج) شاهد سالب لفحص الرسم: صفٌّ مخفيٌّ يُرصد بالطرق الثلاث =====
// فحص الرسم يبقى مفروضاً حين يتعذّر الخط، فيجب أن يُثبت أنه يرصد ما لا يُرسم.
// نأخذ مستند تصدير سليماً ونُخفي صفّاً بكلٍّ من الطرق الثلاث على حدة، ونطالب
// برصده في كل مرة — بما فيها `visibility:hidden` و`opacity:0` اللتان تُبقيان
// صندوق التخطيط كاملاً (ملاحظة Codex P1 على 34e7874).
{
  const { context, page } = await bootApp(1440, 900);
  await page.evaluate(() => {
    (0, eval)("state").syriaRateConfirmed = true;
    window.openPricePreview(true, "dark");
  });
  await page.waitForSelector("[data-action='export-price-preview']", { timeout: 10000 });
  await page.click("[data-action='export-price-preview']");
  await page.waitForFunction(() => Boolean(document.querySelector("iframe[data-print-frame]")), null, { timeout: 10000 });
  const healthy = await page.evaluate(() =>
    document.querySelector("iframe[data-print-frame]").getAttribute("srcdoc"));
  await context.close();

  const healthyPrint = await printExportDocument(healthy);
  check("شاهد سالب (فحص الرسم): المستند السليم بلا صفّ غير مرسوم",
    healthyPrint.geometry.unrenderedRows === 0 && healthyPrint.geometry.renderedRowCount > 0,
    `غير مرسوم ${healthyPrint.geometry.unrenderedRows} من ${healthyPrint.geometry.renderedRowCount}`);

  for (const [label, rule] of [
    ["display:none", "display:none"],
    ["visibility:hidden", "visibility:hidden"],
    ["opacity:0", "opacity:0"]
  ]) {
    const hidden = healthy.replace("</body>",
      `<style>.ozk-price-list tbody tr:first-child{${rule} !important}</style></body>`);
    const printedHidden = await printExportDocument(hidden);
    check(`شاهد سالب (فحص الرسم): يرصد صفّاً مخفياً بـ${label}`,
      printedHidden.geometry.unrenderedRows > 0,
      `لم يُرصد أي صفّ غير مرسوم رغم إخفاء صفّ بـ${label}`);
  }
}

// ===== ٣) شاهد سالب: الحارس يرصد الرأس المهجور فعلاً =====
// لو لم يكن هذا الفحص قادراً على الفشل لكان بلا معنى. نأخذ مستند تصدير سليماً
// ونفرض على كتلته الأولى فاصلاً قسرياً — أي نُعيد إنتاج العطل حرفياً — ونطالب
// أن يرصده مِسبار الورقة الأولى نفسه المستعمل أعلاه.
{
  const { context, page, fontReady: witnessFontReady } = await bootApp(1440, 900);
  await page.evaluate(() => {
    (0, eval)("state").syriaRateConfirmed = true;
    window.openPricePreview(true, "dark");
  });
  await page.waitForSelector("[data-action='export-price-preview']", { timeout: 10000 });
  const planned = await page.evaluate(() => {
    const plan = window.bulletinRenderPlan(window.buildBulletinDataset(true, "dark").dataset);
    const first = plan.layout.mainPages[0];
    return {
      rows: [...first.right, ...first.left].flatMap((g) =>
        g.items.map((it) => ({ name: it.name, unit: it.unit, price: it.price })))
    };
  });
  await page.click("[data-action='export-price-preview']");
  await page.waitForFunction(() => Boolean(document.querySelector("iframe[data-print-frame]")), null, { timeout: 10000 });
  const healthy = await page.evaluate(() =>
    document.querySelector("iframe[data-print-frame]").getAttribute("srcdoc"));
  await context.close();

  const healthyPrint = await printExportDocument(healthy);
  checkWithFont(witnessFontReady, "شاهد سالب: المستند السليم يضع أصنافاً على الورقة الأولى",
    rowsOnSheet(healthyPrint.sheets[0] || [], planned.rows) > 0,
    "المرجع السليم نفسه بلا أصناف على الورقة الأولى — الشاهد بلا قيمة");

  // نفس المستند، وقد وُضع فاصل قسري على أول كتلة أعمدة: العطل حرفياً.
  const stranded = healthy.replace('class="price-list-columns"',
    'class="price-list-columns price-list-secondary-page"');
  check("شاهد سالب: حُقن الفاصل القسري فعلاً في أول كتلة", stranded !== healthy,
    "لم يُعثر على أول كتلة أعمدة لحقنها — الشاهد لم يُبنَ");

  const strandedPrint = await printExportDocument(stranded);
  const strandedFirst = strandedPrint.sheets[0] || [];
  checkWithFont(witnessFontReady, "شاهد سالب: الحارس يرصد الرأس المهجور (صفر صنف على الورقة الأولى)",
    rowsOnSheet(strandedFirst, planned.rows) === 0,
    "الورقة الأولى المهجورة ما زالت تُحسب حاملةً أصنافاً — المِسبار لا يرصد العطل");
  checkWithFont(witnessFontReady, "شاهد سالب: الورقة المهجورة تحمل الرأس وحده (وهو ما رآه المالك)",
    sheetCarriesHeader(strandedFirst),
    "الورقة الأولى المهجورة لا تحمل حتى الرأس — الشاهد لا يُطابق البلاغ");
}

// ===== ٤) الحارس البنيوي: أسوأ حالٍ مسموح يجب أن يخرج من نطاق «النقل الكامل» =====
// الصفحة الأولى وحدها تتشارك ورقتها مع رأسٍ **قِيس في مستند آخر**. وسلوك كروم
// عند تجاوز كتلتها لورقتها ليس خطياً (قياس فعلي، راجع FIRST_PAGE_DRIFT_RESERVE_PX):
//   · تجاوز 0 … ~8px ⇒ تُنقل الكتلة **كاملةً** ⇒ ورقة عنوان بالرأس وحده.
//   · تجاوز ≥ ~14px  ⇒ تُشطر الكتلة ⇒ الرأس يبقى ومعه أصناف.
// فالخطر نطاقٌ ضيّق محدَّد، لا «كلما زاد التجاوز ساء الحال». ولا يكفي أن يمرّ
// حجم بيانات بعينه: القاعدة أن تترك **الميزانية نفسها** خلوصاً يُخرج أسوأ حالٍ
// مسموح من ذلك النطاق كلّه.
const CHROME_WHOLE_BLOCK_PUSH_BAND_PX = 8;
{
  const { context, page } = await bootApp(1440, 900);
  const budget = await page.evaluate(() => {
    const T = window.OZKPriceListTemplate;
    const pageHeight = T.computePageContentHeightPx(794);
    const headerHeightPx = 156.375; // الرأس الحقيقي المقاس في هندسة الطباعة
    const groups = [{ name: "ماستر", items: [{ name: "أ", unit: "ك", price: "$1" }] }];
    const heights = new Map([["ماستر", 40]]);
    const layout = T.layoutGroupsMeasured(groups, heights, { pageWidthPx: 794, headerHeightPx, safetyMarginPx: 6 });
    // أطول عمود مسموح على الصفحة الأولى.
    const maxColumn = pageHeight - T.COLUMNS_PADDING_BOTTOM_PX - headerHeightPx - T.DEFAULT_SAFETY_MARGIN_PX;
    // والكتلة الأولى تُرسم بلا حاشية سفلية، فأسفلها = الرأس + العمود وحده.
    return {
      pageHeight,
      padding: T.COLUMNS_PADDING_BOTTOM_PX,
      worstBottom: headerHeightPx + maxColumn,
      firstPageHoldsGroups: layout.mainPages[0].right.length + layout.mainPages[0].left.length > 0
    };
  });
  await context.close();

  check("الميزانية: ارتفاع الصفحة المحسوب لا يتجاوز ورقة A4 الحقيقية",
    budget.pageHeight <= A4_HEIGHT_PX + 1e-6,
    `المحسوب ${budget.pageHeight} مقابل A4 ${A4_HEIGHT_PX.toFixed(2)}`);

  // الخلوص يُبنى على إسقاط حاشية الكتلة الأولى، وهي قيمة معلنة في القالب.
  // غيابها يعني حساباً بلا أساس، فنقولها صراحةً بدل أن تتسرّب NaN للمقارنة.
  check("الميزانية: القالب يُعلن حاشية كتلة الأعمدة",
    Number.isFinite(budget.padding) && budget.padding > 0,
    `COLUMNS_PADDING_BOTTOM_PX = ${budget.padding}`);

  const clearance = +(A4_HEIGHT_PX - budget.worstBottom).toFixed(2);

  // الشرط الذي يهمّ فعلاً: الخلوص يتجاوز نطاق «النقل الكامل» المقيس، فلا يقع
  // أسوأ حالٍ مسموح داخل النطاق الذي يُنتج ورقة العنوان.
  check(`الميزانية: الخلوص خارج نطاق نقل الكتلة كاملةً (> ${CHROME_WHOLE_BLOCK_PUSH_BAND_PX}px)`,
    Number.isFinite(clearance) && clearance > CHROME_WHOLE_BLOCK_PUSH_BAND_PX,
    `الخلوص ${clearance}px داخل النطاق الخطر — كتلة الأعمدة الأولى على بُعد خطأ تقريب`
    + ` من الانتقال كاملةً للورقة الثانية وترك الرأس وحده`);

  check("الميزانية: الصفحة الأولى ما زالت تحمل مجموعات تحت الرأس",
    budget.firstPageHoldsGroups,
    "لم تعد أي مجموعة تتّسع تحت الرأس");
}

// ===== ٥) القياس والطباعة لا يفترقان في الخط =====
// القياس والطباعة يجريان في مستندين، ولكلٍّ انتظارُه المحدود لجهوزية الخط.
// فقد ينتهي انتظار القياس بالخط الاحتياطي بينما يصل الخط أثناء انتظار إطار
// الطباعة — فيُقاس بخطٍّ ويُطبع بآخر، والفارق المقيس (~5% من ارتفاع العمود:
// 949px بالاحتياطي مقابل 902px بالخط) يكفي لدفع كتلة الأعمدة الأولى خارج
// ورقتها فتُنقل كاملةً أو تُقصّ. (ملاحظة Codex P1 على 6508dd7.)
// نُعيد إنتاج الحالة حرفياً: نحجب الخط عن **التطبيق** (فيقيس بالاحتياطي)،
// ثم نطبع المستند في سياق **الخط فيه متاح** — ونطالب بأن يبقى المطبوع مطابقاً
// للمقيس، وبأن تبقى الورقة الأولى حاملة أصنافها.
{
  const { context, page } = await bootApp(1440, 900, { blockWebfont: true });
  await page.evaluate(() => {
    (0, eval)("state").syriaRateConfirmed = true;
    window.openPricePreview(true, "dark");
  });
  await page.waitForSelector("[data-action='export-price-preview']", { timeout: 15000 });
  const planned = await page.evaluate((probeSrc) => {
    const plan = window.bulletinRenderPlan(window.buildBulletinDataset(true, "dark").dataset);
    const first = plan.layout.mainPages[0];
    return {
      fontUsable: new Function(`return ${probeSrc}`)()(),
      markupHasFallbackAttr: /<section class="ozk-price-list[^"]*"[^>]*\sdata-fallback-font/.test(plan.markup),
      rows: [...first.right, ...first.left].flatMap((g) =>
        g.items.map((it) => ({ name: it.name, unit: it.unit, price: it.price })))
    };
  }, FONT_USABLE_PROBE);
  await page.click("[data-action='export-price-preview']");
  await page.waitForFunction(() => Boolean(document.querySelector("iframe[data-print-frame]")), null, { timeout: 15000 });
  const documentHtml = await page.evaluate(() =>
    document.querySelector("iframe[data-print-frame]").getAttribute("srcdoc"));
  await context.close();

  check("اتفاق الخط: القياس جرى فعلاً بالخط الاحتياطي (الحالة بُنيت)",
    planned.fontUsable === false, "خط النشرة كان متاحاً رغم حجبه — السيناريو لم يُبنَ");

  // **نفس نسخة الترميز تُقاس وتُطبع.** الوسم على ترميز الخطة المقيسة يعني أن
  // المجسّ قاس بالاحتياطي أيضاً، لا بمقاييس مختلطة.
  check("اتفاق الخط: ترميز الخطة المقيسة موسوم بالاحتياطي كذلك",
    planned.markupHasFallbackAttr,
    "الترميز الذي قِيس غير موسوم — القياس جرى بمقاييس مختلطة والطباعة بالاحتياطي");

  check("اتفاق الخط: الترميز المطبوع موسومٌ بقرار القياس (data-fallback-font)",
    /<section class="ozk-price-list[^"]*"[^>]*\sdata-fallback-font/.test(documentHtml)
    && /font-family:Tahoma,Arial,sans-serif !important/.test(documentHtml),
    "الترميز لا يحمل قرار الخط — قد يُقاس بخطٍّ ويُطبع بآخر");

  // يُطبع في سياق الخط فيه متاح: لولا الوراثة لرُسم بـAlmarai وخالف المقيس.
  const printed = await printExportDocument(documentHtml);
  const usedFont = await (async () => {
    const ctx2 = await browser.newContext({ viewport: { width: 794, height: 1123 }, bypassCSP: true, serviceWorkers: "block" });
    const p2 = await ctx2.newPage();
    await p2.route(`${BASE}/__fontcheck`, (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
    await p2.goto(`${BASE}/__fontcheck`, { waitUntil: "load" });
    await p2.evaluate(() => Promise.race([
      document.fonts.ready.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10000))
    ]));
    const v = await p2.evaluate(() =>
      getComputedStyle(document.querySelector(".price-list-header-title")).fontFamily);
    await ctx2.close();
    return v;
  })();
  check("اتفاق الخط: المستند يُرسم بالاحتياطي حتى حين يكون الخط متاحاً للطباعة",
    !/Almarai/.test(usedFont), `font-family المطبوع = ${usedFont}`);

  // **قياس كمّي لا نصّي هنا عمداً.** مطابقة الصفوف حرفياً تتطلّب خطاً يُشكّل
  // العربية، والسلسلة الاحتياطية تختلف بين الأنظمة (Tahoma على ماك، وخطٌّ آخر
  // على لينكس CI قد لا يُشكّل العربية أصلاً) — فالمطابقة النصّية هناك تقيس
  // النظام لا الكود. مطابقة الصفوف الصارمة مفروضة في سيناريو ١ بالخط الحقيقي؛
  // وما يهمّ هنا أن **كمّ المحتوى المرسوم على الورقة الأولى** يوازي ما خُطِّط
  // لها، أي أنها لم تُهجَر إلى ورقة عنوان.
  const firstSheet = printed.sheets[0] || [];
  const laterSheets = printed.sheets.slice(1).reduce((n, sheet) => n + sheet.length, 0);
  check("اتفاق الخط: الورقة الأولى تحمل كمّ محتوى يوازي ما خُطِّط لها",
    firstSheet.length >= planned.rows.length * 0.8,
    `أسطر الورقة الأولى ${firstSheet.length} مقابل ${planned.rows.length} صفاً مخطَّطاً`
    + ` (أسطر بقية الأوراق ${laterSheets})`);

  const firstBlock = printed.geometry.blocks[0];
  check("اتفاق الخط: كتلة الأعمدة الأولى داخل ورقتها",
    firstBlock != null && firstBlock.bottom <= A4_HEIGHT_PX + 0.5,
    `أسفل الكتلة ${firstBlock?.bottom} مقابل ${A4_HEIGHT_PX.toFixed(2)}`);
}

await browser.close();
server.close();

if (skipped) {
  console.log(`\nℹ️  ${skipped} تأكيداً نصّياً معلَّقاً: ${SKIP_NOTE}.`);
}

if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً في توزيع الورقة الأولى للنشرة.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص توزيع الورقة الأولى لنشرة الأسعار نجحت.");
