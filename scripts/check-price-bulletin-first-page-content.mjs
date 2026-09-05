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

async function bootApp(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**://*.supabase.co/**", (route) => route.abort());
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
  return { context, page };
}

// يطبع مستند تصدير جاهزاً ويُرجع نصّ كل ورقة + هندسة كتل الأعمدة.
async function printExportDocument(documentHtml) {
  const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route(`${BASE}/__firstpage`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
  await page.goto(`${BASE}/__firstpage`, { waitUntil: "networkidle" });
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
    return { headerHeight: +headerHeight.toFixed(2), blocks };
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
  const { context, page } = await bootApp(sc.vw, sc.vh);
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

  check(`${sc.label}: الورقة الأولى تحمل رأس النشرة`, sheetCarriesHeader(firstSheet),
    "عنوان «نشرة الأسعار» غير مطبوع على الورقة الأولى");

  // **جوهر الحارس.** لا «موجود في مكان ما بالملف»: كل صفّ خطّطت له الخطة
  // للصفحة الأولى يجب أن يُطبع على الورقة الأولى **نفسها**.
  const onFirst = rowsOnSheet(firstSheet, planned.firstPageRows);
  check(`${sc.label}: الورقة الأولى تحمل أصنافاً فعلاً (لا ورقة عنوان)`, onFirst > 0,
    `صفر صنف على الورقة الأولى من ${planned.firstPageRows.length} صنفاً مخطَّطاً لها`
    + ` — أوراق الملف = ${printed.sheets.length}`);

  check(`${sc.label}: كل صفوف الصفحة الأولى المخطَّطة (${planned.firstPageRows.length}) مطبوعة على الورقة الأولى`,
    onFirst === planned.firstPageRows.length,
    `مطبوع على الورقة الأولى ${onFirst} من ${planned.firstPageRows.length}`);

  const missingFirstGroups = planned.firstPageGroups.filter((g) => !printedGroup(firstSheet, g));
  check(`${sc.label}: كل رؤوس مجموعات الصفحة الأولى (${planned.firstPageGroups.length}) على الورقة الأولى`,
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
  const { context, page } = await bootApp(1440, 900);
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

  check("ورقة العنوان: الورقة الأولى تحمل الرأس",
    sheetCarriesHeader(firstSheet), "الرأس نفسه غاب عن الورقة الأولى");

  // القرار الصريح: الكتلة التالية (المعبّأة لورقة كاملة) لا تُوضع تحت الرأس،
  // فتحتفظ بفاصلها القسري. هذا ما يمنع القصّ على سفاري.
  check("ورقة العنوان: الكتلة المعبّأة لورقة كاملة تحتفظ بفاصلها القسري",
    printed.geometry.blocks[0]?.forcedBreak === true,
    "كتلة بميزانية ورقة كاملة وُضعت تحت الرأس — تتجاوز ورقتها ويقصّها سفاري");

  check("ورقة العنوان: الورقة الأولى بلا أصناف — وهذا هو السلوك المقصود هنا وحده",
    onFirst === 0,
    `الورقة الأولى تحمل ${onFirst} صنفاً رغم أن الصفحة المخطَّطة فارغة`);

  // الثمن المقبول ورقٌ مهدور، لا صنفٌ ضائع أو مقصوص.
  const anywhere = built.rows.filter((row) => printed.sheets.some((sheet) => printedRow(sheet, row))).length;
  check("ورقة العنوان: لا صنف يضيع من الملف",
    anywhere === built.rows.length, `مطبوع ${anywhere} من ${built.rows.length}`);

  const overflowing = printed.geometry.blocks
    .map((b, i) => ({ i, over: +((i === 0 ? b.bottom : b.height) - A4_HEIGHT_PX).toFixed(2) }))
    .filter((r) => r.over > 0.5);
  check("ورقة العنوان: لا كتلة تتجاوز ورقتها (لا شيء يُقصّ)",
    overflowing.length === 0, `تجاوز: ${JSON.stringify(overflowing)}`);
}

// ===== ٣) شاهد سالب: الحارس يرصد الرأس المهجور فعلاً =====
// لو لم يكن هذا الفحص قادراً على الفشل لكان بلا معنى. نأخذ مستند تصدير سليماً
// ونفرض على كتلته الأولى فاصلاً قسرياً — أي نُعيد إنتاج العطل حرفياً — ونطالب
// أن يرصده مِسبار الورقة الأولى نفسه المستعمل أعلاه.
{
  const { context, page } = await bootApp(1440, 900);
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
  check("شاهد سالب: المستند السليم يضع أصنافاً على الورقة الأولى",
    rowsOnSheet(healthyPrint.sheets[0] || [], planned.rows) > 0,
    "المرجع السليم نفسه بلا أصناف على الورقة الأولى — الشاهد بلا قيمة");

  // نفس المستند، وقد وُضع فاصل قسري على أول كتلة أعمدة: العطل حرفياً.
  const stranded = healthy.replace('class="price-list-columns"',
    'class="price-list-columns price-list-secondary-page"');
  check("شاهد سالب: حُقن الفاصل القسري فعلاً في أول كتلة", stranded !== healthy,
    "لم يُعثر على أول كتلة أعمدة لحقنها — الشاهد لم يُبنَ");

  const strandedPrint = await printExportDocument(stranded);
  const strandedFirst = strandedPrint.sheets[0] || [];
  check("شاهد سالب: الحارس يرصد الرأس المهجور (صفر صنف على الورقة الأولى)",
    rowsOnSheet(strandedFirst, planned.rows) === 0,
    "الورقة الأولى المهجورة ما زالت تُحسب حاملةً أصنافاً — المِسبار لا يرصد العطل");
  check("شاهد سالب: الورقة المهجورة تحمل الرأس وحده (وهو ما رآه المالك)",
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

await browser.close();
server.close();

if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً في توزيع الورقة الأولى للنشرة.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص توزيع الورقة الأولى لنشرة الأسعار نجحت.");
