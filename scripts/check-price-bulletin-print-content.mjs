// حارس محتوى نسخة الطباعة: **ما يظهر في المعاينة يجب أن يكون داخل الورق فعلاً.**
//
// العطل الذي يغلقه (نشرة الليرة، بلاغ إنتاجي):
//   المعاينة تعرض كل المجموعات والأصناف، وعند «حفظ / مشاركة PDF» تخرج الورقة
//   بالرأس وحده بلا أي صنف. السبب الجذري كان «كتلة إنقاذ الصفحة الأولى» في
//   packGroupsIntoBalancedPages: كانت تُعيد تعبئة الصفحة الأولى بميزانية
//   **الورقة الكاملة** متى خرجت مستغلّة أقل من نصف ميزانيتها المخفَّضة، ثم
//   يُركَّب الرأس (~156px) فوق كتلة بارتفاع ورقة كاملة — فتتجاوز الكتلة حدّ
//   الورقة. كروم يُجزّئها (ورقة زائدة ومحتوى مشطور)، وسفاري يدفعها كاملةً إلى
//   الورقة التالية بينما `.ozk-price-list{overflow:hidden}` يقصّ ما خرج، فيصل
//   الزبون ملف فيه الرأس وحده.
//
// لماذا لم ترصده الحراس القائمة: `check-price-bulletin-item-coverage.mjs` يقارن
// أسماء الأصناف داخل **الترميز** (DOM)، و`check-price-bulletin-export-integrity.mjs`
// يعدّ صفحات الملف ويقيس الخلفية. الترميز كان سليماً وعدد الصفحات مطابقاً —
// والأصناف مع ذلك خارج الورق. لذلك يقرأ هذا الحارس **نص ملف PDF نفسه**
// (عبر خرائط /ToUnicode) ويطالب بوجود كل اسم مجموعة وكل اسم صنف داخله.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, resolve } from "node:path";

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

// ===== قراءة نص PDF =====
// القارئ نفسه يعيش في وحدة مشتركة كي يستعمله حارس توزيع الصفحة الأولى بنفس
// الصرامة حرفياً — راجع scripts/lib/price-bulletin-pdf-text.mjs لشرح آلية
// القراءة ولسلسلة ملاحظات Codex التي شدّدت المطابقة.
import {
  pdfPageLines, normalizeArabic, lineText, printedRow, printedGroup
} from "./lib/price-bulletin-pdf-text.mjs";
import { waitForBulletinFont } from "./lib/bulletin-font-ready.mjs";

// الفحص برسالة صريحة تطلب توسيع القارئ إلى إعادة بناء الخلايا قبل اعتماده.
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

const A4_HEIGHT_PX = 297 / 25.4 * 96;
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

// يطبع مستند تصدير جاهزاً ويُرجع نصّ كل ورقة + هندسة كتل الصفحات.
async function printDocument(documentHtml) {
  const context = await browser.newContext({ viewport: { width: 794, height: 1123 }, bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route(`${BASE}/__print`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml }));
  await page.goto(`${BASE}/__print`, { waitUntil: "networkidle" });
  await page.emulateMedia({ media: "print" });
  const geometry = await page.evaluate(() => {
    const section = document.querySelector(".ozk-price-list");
    const top = section.getBoundingClientRect().top;
    return [...document.querySelectorAll(".price-list-columns")].map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: +(rect.top - top).toFixed(2), bottom: +(rect.bottom - top).toFixed(2), height: +rect.height.toFixed(2) };
    });
  });
  const pdf = await page.pdf({
    format: "A4", printBackground: true, preferCSSPageSize: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" }
  });
  await context.close();
  return { pages: pdfPageLines(pdf), geometry, bytes: pdf.length };
}

// أول كتلة أعمدة تعيش تحت الرأس على **نفس الورقة**، فحدّها هو حدّ الورقة
// الأولى؛ وكل كتلة تالية تبدأ ورقتها بفاصل قسري فحدّها ارتفاع ورقة كاملة.
function blocksOverflowingTheirPage(geometry) {
  return geometry
    .map((block, index) => ({ index, over: +((index === 0 ? block.bottom : block.height) - A4_HEIGHT_PX).toFixed(2) }))
    .filter((row) => row.over > 0.5);
}

// ===== 1) مسار التصدير الفعلي: زر «حفظ / مشاركة PDF» =====
// نلتقط المستند من **إطار الطباعة الذي يبنيه الزر نفسه**، لا من المعاينة.
for (const sc of [
  { label: "نشرة الليرة (مفرق) — داكن", useSyria: true, theme: "dark", vw: 1440, vh: 900 },
  { label: "نشرة الليرة (مفرق) — فاتح", useSyria: true, theme: "light", vw: 1440, vh: 900 },
  { label: "نشرة الدولار (جملة) — داكن", useSyria: false, theme: "dark", vw: 1440, vh: 900 },
  { label: "نشرة الليرة على هاتف 390px", useSyria: true, theme: "dark", vw: 390, vh: 844 }
]) {
  const { context, page } = await bootApp(sc.vw, sc.vh);
  await page.evaluate((sc) => {
    (0, eval)("state").syriaRateConfirmed = true;
    window.openPricePreview(sc.useSyria, sc.theme);
  }, sc);
  await page.waitForSelector("[data-action='export-price-preview']", { timeout: 10000 });
  // التصدير يختم قرار الخط على الترميز، والسلسلة الاحتياطية قد لا تُشكّل العربية
  // على بعض الأنظمة — فننتظر خط النشرة كما ينتظره المستخدم الحقيقي، ونُصرّح به
  // شرطاً بدل أن تفشل المطابقة لسببٍ يخصّ النظام لا الكود.
  const fontReady = await waitForBulletinFont(page);

  // هويات ما يراه المستخدم على الشاشة قبل الضغط.
  const expected = await page.evaluate(() => ({
    rows: [...document.querySelectorAll(".price-preview-scroll .ozk-price-list tbody tr")].map((tr) => ({
      name: tr.querySelector("td.name").textContent.trim(),
      unit: tr.querySelector("td.unit").textContent.trim(),
      price: tr.querySelector("td.price").textContent.trim()
    })),
    groups: [...document.querySelectorAll(".price-preview-scroll .ozk-price-list .price-list-group")].map((g) => ({
      name: g.querySelector(".price-list-group-name").textContent.trim(),
      count: g.querySelector(".price-list-group-count").textContent.trim()
    })),
    pageCount: Number((document.querySelector(".price-preview-titles p")?.textContent.match(/(\d+)\s*صفحة/) || [])[1] || 0)
  }));

  const wrapped = await page.evaluate(
    ([markup, probe]) => new Function(`return ${probe}`)()(markup),
    [await page.evaluate(() => window.bulletinRenderPlan(window.buildBulletinDataset(
      (0, eval)("state").pricePreview.useSyria, (0, eval)("state").pricePreview.theme).dataset).markup), WRAP_PROBE]);

  await page.click("[data-action='export-price-preview']");
  await page.waitForFunction(() => Boolean(document.querySelector("iframe[data-print-frame]")), null, { timeout: 10000 });
  const documentHtml = await page.evaluate(() =>
    document.querySelector("iframe[data-print-frame]").getAttribute("srcdoc"));
  await context.close();

  check(`${sc.label}: خط النشرة جاهز قبل التصدير (شرط مطابقة النصّ العربي)`,
    fontReady, "لم يجهز خط النشرة خلال 20 ثانية — المطابقة النصّية تقيس النظام لا الكود");

  check(`${sc.label}: لا اسم يلتفّ في هندسة الطباعة (شرط قراءة الملف سطراً سطراً)`,
    wrapped.length === 0,
    `أسماء ملتفّة: ${JSON.stringify(wrapped.slice(0, 5))} — وسّع قارئ الملف إلى إعادة بناء الخلايا قبل اعتماد هذه الأسماء`);

  check(`${sc.label}: زر التصدير ينتج مستند طباعة فعلياً`,
    typeof documentHtml === "string" && documentHtml.includes("ozk-price-list"),
    `طول المستند = ${documentHtml ? documentHtml.length : "لا شيء"}`);

  const printed = await printDocument(documentHtml);
  const text = printed.pages;

  check(`${sc.label}: عدد أوراق الملف = عدد صفحات المعاينة (${expected.pageCount})`,
    printed.pages.length === expected.pageCount,
    `المعاينة ${expected.pageCount} · الملف ${printed.pages.length}`);

  // --- جوهر الحارس: أسماء المجموعات والأصناف داخل الورق نفسه ---
  const missingGroups = expected.groups.filter((g) => !text.some((lines) => printedGroup(lines, g)));
  check(`${sc.label}: كل رؤوس المجموعات (${expected.groups.length}) مطبوعة كاملةً داخل الملف`,
    missingGroups.length === 0, `مفقودة: ${JSON.stringify(missingGroups.slice(0, 8))}`);

  const missingItems = expected.rows.filter((row) => !text.some((lines) => printedRow(lines, row)));
  check(`${sc.label}: كل صفوف الأصناف (${expected.rows.length}) مطبوعة كاملةً (اسم+وحدة+سعر)`,
    missingItems.length === 0, `مفقودة: ${JSON.stringify(missingItems.slice(0, 6))}`);

  // --- «الرأس فقط»: كل ورقة يجب أن تحمل أصنافاً، لا ترويسة وحدها ---
  const itemsPerPage = text.map((lines) => expected.rows.filter((row) => printedRow(lines, row)).length);
  check(`${sc.label}: لا ورقة تحمل الرأس وحده — كل ورقة فيها أصناف`,
    itemsPerPage.every((count) => count > 0),
    `أصناف كل ورقة = [${itemsPerPage.join(", ")}]`);

  // الورقة الأولى تحديداً هي التي كانت تخرج بالرأس وحده.
  check(`${sc.label}: الورقة الأولى تحمل أصنافاً`, (itemsPerPage[0] || 0) > 0,
    `الورقة الأولى فيها ${itemsPerPage[0]} صنف`);

  // --- السبب الجذري: لا كتلة أعمدة تتجاوز ورقتها ---
  const overflowing = blocksOverflowingTheirPage(printed.geometry);
  check(`${sc.label}: كل كتلة أعمدة داخل حدود ورقتها (الأولى مع الرأس)`,
    overflowing.length === 0,
    `تجاوز: ${JSON.stringify(overflowing)} — ارتفاع A4 = ${A4_HEIGHT_PX.toFixed(2)}px`);
}

// ===== 2) الشكل الذي كان يُطلق «إنقاذ الصفحة الأولى» =====
// مجموعتان أوليان متوسطتان لا تتّسعان معاً تحت الرأس: هذا بالضبط ما كان
// يجعل الصفحة الأولى مستغلّة أقل من نصف ميزانيتها فتُعاد تعبئتها بميزانية
// الورقة الكاملة وتفيض. نبنيه بارتفاعات مقاسة حقيقية من نفس القالب.
{
  const { context, page } = await bootApp(1440, 900);
  const built = await page.evaluate(() => {
    const T = window.OZKPriceListTemplate;
    const RIGHT = ["ماستر", "كابتن بلاك", "اوسكار", "اختمار"];
    const LEFT = ["غلواز", "اليغانس", "تي اس", "أوريس"];
    const SPECIAL = ["فحم", "ورق", "معسل", "نخلة"];
    const mk = (name, count) => ({
      name,
      items: Array.from({ length: count }, (_, i) => ({
        name: `${name} صنف رقم ${i + 1}`, unit: "كرتونة", price: "12,345 ل.س"
      }))
    });
    // 23 ثم 29 صنفاً: القياس الفعلي يعطي ~500px ثم ~530px — لا تتّسعان معاً
    // تحت الرأس، وهو الشكل الذي كان يفيض بـ26px فوق حدّ الورقة.
    const groups = [
      mk(RIGHT[0], 23), mk(RIGHT[1], 29), mk(RIGHT[2], 10), mk(RIGHT[3], 10),
      mk(LEFT[0], 23), mk(LEFT[1], 29), mk(LEFT[2], 10), mk(LEFT[3], 10),
      ...SPECIAL.map((n) => mk(n, 5))
    ];
    const renderOptions = {
      logoSrc: `${location.origin}/public/icons/ozk-logo.png`,
      issueDate: T.formatArabicIssueDate(new Date()),
      badgeClass: "badge-syp", badgeLabelHtml: "ليرة — مفرق — صرف 14,050",
      unitLabel: "سعر المفرق للوحدة", theme: "dark"
    };
    // نفس مجس القياس المستعمل داخل التطبيق (buildMeasuredBulletinLayout).
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10000px;top:0;width:794px;visibility:hidden;pointer-events:none";
    probe.innerHTML = T.render({ ...renderOptions, groups });
    probe.querySelector(".ozk-price-list").setAttribute("data-measure-print", "");
    document.body.appendChild(probe);
    let layout, headerHeightPx;
    try {
      const header = probe.querySelector(".price-list-header");
      const sub = probe.querySelector(".price-list-subheader");
      headerHeightPx = header.getBoundingClientRect().height + sub.getBoundingClientRect().height
        + (parseFloat(getComputedStyle(sub).marginBottom) || 0);
      const stack = document.createElement("div");
      stack.className = "price-list-column-stack";
      stack.style.width = `${probe.querySelector(".price-list-column-stack").getBoundingClientRect().width}px`;
      probe.querySelector(".ozk-price-list").appendChild(stack);
      const heights = new Map();
      groups.forEach((g) => {
        stack.innerHTML = T.renderGroup(g);
        const el = stack.firstElementChild;
        heights.set(String(g.name), el.getBoundingClientRect().height + (parseFloat(getComputedStyle(el).marginBottom) || 0));
      });
      layout = T.layoutGroupsMeasured(groups, heights, { pageWidthPx: 794, headerHeightPx, safetyMarginPx: 6 });
    } finally { probe.remove(); }
    const markup = T.render({ ...renderOptions, groups, layout });
    return {
      headerHeightPx,
      pageCount: layout.mainPages.length + layout.specialPages.length,
      rows: groups.flatMap((g) => g.items),
      groups: groups.map((g) => ({ name: g.name, count: String(g.items.length) })),
      documentHtml: T.printDocument({ theme: "dark", title: "rescue-shape", bodyHtml: markup })
    };
  });
  await context.close();

  const printed = await printDocument(built.documentHtml);
  const text = printed.pages;

  const overflowing = blocksOverflowingTheirPage(printed.geometry);
  check("شكل الإنقاذ: لا كتلة أعمدة تتجاوز ورقتها (الصفحة الأولى + الرأس)",
    overflowing.length === 0,
    `تجاوز: ${JSON.stringify(overflowing)} — الرأس ${built.headerHeightPx.toFixed(1)}px`);
  check("شكل الإنقاذ: عدد أوراق الملف = عدد الصفحات المخطَّطة",
    printed.pages.length === built.pageCount,
    `مخطَّط ${built.pageCount} · مطبوع ${printed.pages.length}`);
  const missing = built.rows.filter((row) => !text.some((lines) => printedRow(lines, row)));
  check("شكل الإنقاذ: كل صفوف الأصناف مطبوعة كاملةً داخل الملف",
    missing.length === 0, `مفقودة: ${JSON.stringify(missing.slice(0, 6))}`);
  const missingGroups = built.groups.filter((g) => !text.some((lines) => printedGroup(lines, g)));
  check("شكل الإنقاذ: كل رؤوس المجموعات مطبوعة كاملةً داخل الملف",
    missingGroups.length === 0, `مفقودة: ${JSON.stringify(missingGroups)}`);
  const perPage = text.map((lines) => built.rows.filter((row) => printedRow(lines, row)).length);
  check("شكل الإنقاذ: لا ورقة بالرأس وحده", perPage.every((n) => n > 0), `[${perPage.join(", ")}]`);
}

// ===== 2ب) شاهد سالب: الحارس يرصد فقدان صنف فعلاً (لا يمرّ زوراً) =====
// يغطّي **كلتا** ثغرتَي المرور الزائف اللتين رصدتهما Codex:
//   أ) على d0c229f6: تقسيم الاسم إلى مقاطع تُبحث كلٌّ على حدة في كامل نص
//      الصفحة — فتُشبَع مقاطع صنف ضائع من صفوف أخرى تشاركه كلماته الشائعة.
//   ب) على 6ac9fae7: الاحتواء النصّي — التطبيع يحذف الفراغات، فاسم أقصر قد
//      يكون مقطعاً داخل اسم أطول («اليغانس سليم فضي» داخل «اليغانس سليم فضي
//      بدون طبعة»)، فيُشبعه سطر الأطول.
// نحذف ضحيّة من كل نوع، ونطالب برصد الاثنتين — ونُظهر صراحةً أن القاعدتين
// القديمتين كانتا ستمرّان.
{
  const { context, page } = await bootApp(1440, 900);
  const built = await page.evaluate(() => {
    const state = (0, eval)("state");
    state.syriaRateConfirmed = true;
    const ds = window.buildBulletinDataset(true, "dark").dataset;
    const plan = window.bulletinRenderPlan(ds);
    const rows = window.bulletinTemplateGroups(ds).flatMap((g) => g.items);
    const flat = (v) => String(v).normalize("NFKC").replace(/\s+/g, "");
    const words = (n) => n.trim().split(/\s+/).filter(Boolean);

    // (أ) كل كلماتها مشتركة مع أصناف أخرى.
    const shared = rows.find((row) => {
      const parts = words(row.name);
      return parts.length >= 2
        && parts.every((w) => rows.some((other) => other.name !== row.name && words(other.name).includes(w)));
    });
    // (ب) اسمها مقطع صارم داخل اسم صنف آخر أطول.
    const nested = rows.find((row) =>
      rows.some((other) => other.name !== row.name && flat(other.name).includes(flat(row.name))));

    const victims = [shared, nested].filter(Boolean)
      .filter((row, i, list) => list.findIndex((r) => r.name === row.name) === i);

    const doc = new DOMParser().parseFromString(plan.markup, "text/html");
    victims.forEach((victim) => {
      [...doc.querySelectorAll("tbody tr")]
        .find((tr) => tr.querySelector("td.name")?.textContent.trim() === victim.name)
        ?.remove();
    });
    const styleTag = plan.markup.slice(0, plan.markup.indexOf("</style>") + "</style>".length);
    return {
      victims, rows,
      documentHtml: window.OZKPriceListTemplate.printDocument({
        theme: "dark", title: "negative-witness",
        bodyHtml: styleTag + doc.querySelector(".ozk-price-list").outerHTML
      })
    };
  });
  await context.close();

  const printed = await printDocument(built.documentHtml);
  const text = printed.pages;

  // القاعدتان القديمتان، لإظهار أن الشاهد يغطّي ثغرة حقيقية لا مفترضة.
  const oldFragmentRule = (lines, name) => {
    const page = lines.map(lineText).join("");
    return String(name).trim().split(/\s+/).map(normalizeArabic).filter(Boolean)
      .every((w) => page.includes(w));
  };
  const oldSubstringRule = (lines, name) =>
    lines.some((line) => lineText(line).includes(normalizeArabic(name)));

  check("الشاهد السالب: وُجدت ضحيّتان تغطّيان الثغرتين",
    built.victims.length === 2, `الضحايا = ${JSON.stringify(built.victims.map((v) => v.name))}`);

  built.victims.forEach((victim, index) => {
    const kind = index === 0 ? "كلمات مشتركة" : "اسم داخل اسم أطول";
    const oldWouldPass = index === 0
      ? text.some((lines) => oldFragmentRule(lines, victim.name))
      : text.some((lines) => oldSubstringRule(lines, victim.name));
    check(`الشاهد السالب (${kind}): القاعدة القديمة كانت تمرّ زوراً على «${victim.name}»`,
      oldWouldPass, "الشاهد فقد معناه — اختر ضحيّة أقسى");
    check(`الشاهد السالب (${kind}): الحارس الحالي يرصد «${victim.name}» مفقوداً`,
      !text.some((lines) => printedRow(lines, victim)),
      "الصفّ حُذف من المستند ومع ذلك اعتبره الحارس مطبوعاً");
  });

  const missing = built.rows.filter((row) => !text.some((lines) => printedRow(lines, row)));
  const victimNames = new Set(built.victims.map((v) => v.name));
  check("الشاهد السالب: لا ضحايا جانبية — المفقود هو المحذوف وحده",
    missing.length === built.victims.length && missing.every((row) => victimNames.has(row.name)),
    `المفقود = ${JSON.stringify(missing.map((r) => r.name).slice(0, 8))} · المحذوف = ${JSON.stringify([...victimNames])}`);
}

// ===== 2ب-٢) شاهد سالب: تشوّه رقمي (ترتيب الأرقام) يُرصد =====
// ملاحظة Codex P1 الثالثة (على 14ef895e): بصمة الحروف مرتّبةً كانت تُسوّي بين
// «12,345» و«12,354»، وبين عدّاد مجموعة «12» و«21» — فيمرّ الحارس رغم تشوّه
// رقم يراه الزبون. هنا نُبدّل رقمين داخل سعر وداخل عدّاد مجموعة، ونطالب برصد
// الاثنين. (المطابقة الآن تُبلّط مقاطع الرسم: ترتيب الحروف داخل المقطع مصون.)
{
  const { context, page } = await bootApp(1440, 900);
  const built = await page.evaluate(() => {
    const state = (0, eval)("state");
    state.syriaRateConfirmed = true;
    const ds = window.buildBulletinDataset(true, "dark").dataset;
    const plan = window.bulletinRenderPlan(ds);
    const doc = new DOMParser().parseFromString(plan.markup, "text/html");

    // يبدّل أول رقمين مختلفين متجاورين — نفس الحروف بترتيب مختلف.
    const swapDigits = (value) => {
      const chars = [...value];
      for (let i = 0; i < chars.length - 1; i += 1) {
        if (/\d/.test(chars[i]) && /\d/.test(chars[i + 1]) && chars[i] !== chars[i + 1]) {
          [chars[i], chars[i + 1]] = [chars[i + 1], chars[i]];
          return chars.join("");
        }
      }
      return null;
    };

    const rowEl = [...doc.querySelectorAll("tbody tr")]
      .find((tr) => swapDigits(tr.querySelector("td.price").textContent.trim()));
    const priceRow = {
      name: rowEl.querySelector("td.name").textContent.trim(),
      unit: rowEl.querySelector("td.unit").textContent.trim(),
      price: rowEl.querySelector("td.price").textContent.trim()
    };
    rowEl.querySelector("td.price").textContent = swapDigits(priceRow.price);

    const groupEl = [...doc.querySelectorAll(".price-list-group")]
      .find((g) => swapDigits(g.querySelector(".price-list-group-count").textContent.trim()));
    const group = groupEl && {
      name: groupEl.querySelector(".price-list-group-name").textContent.trim(),
      count: groupEl.querySelector(".price-list-group-count").textContent.trim()
    };
    if (groupEl) groupEl.querySelector(".price-list-group-count").textContent = swapDigits(group.count);

    const styleTag = plan.markup.slice(0, plan.markup.indexOf("</style>") + "</style>".length);
    return {
      priceRow, group,
      corruptedPrice: swapDigits(priceRow.price),
      corruptedCount: group ? swapDigits(group.count) : null,
      documentHtml: window.OZKPriceListTemplate.printDocument({
        theme: "dark", title: "digit-corruption",
        bodyHtml: styleTag + doc.querySelector(".ozk-price-list").outerHTML
      })
    };
  });
  await context.close();

  const printed = await printDocument(built.documentHtml);
  const text = printed.pages;

  // البصمة القديمة: حروف مرتّبةً — تُسوّي بين «12,345» و«12,354».
  const oldFingerprintRule = (lines, row) => {
    const wanted = [...normalizeArabic(`${row.name}${row.unit}${row.price}`)].sort().join("");
    const name = normalizeArabic(row.name);
    return lines.some((line) => {
      const flat = lineText(line);
      return flat.startsWith(name) && [...flat].sort().join("") === wanted;
    });
  };

  check(`تشوّه رقمي: السعر «${built.priceRow.price}» شُوّه إلى «${built.corruptedPrice}» بنفس الحروف`,
    built.corruptedPrice && built.corruptedPrice !== built.priceRow.price,
    `${built.priceRow.price} → ${built.corruptedPrice}`);
  check("تشوّه رقمي: البصمة القديمة (حروف مرتّبةً) كانت تمرّ زوراً على السعر المشوّه",
    text.some((lines) => oldFingerprintRule(lines, built.priceRow)),
    "الشاهد فقد معناه — لم تعد البصمة القديمة تمرّ أصلاً");
  check("تشوّه رقمي: الحارس الحالي يرصد السعر المشوّه",
    !text.some((lines) => printedRow(lines, built.priceRow)),
    `«${built.priceRow.name}» بسعر مشوّه ومع ذلك اعتبره الحارس مطبوعاً سليماً`);
  check(`تشوّه رقمي: عدّاد المجموعة «${built.group?.count}» شُوّه إلى «${built.corruptedCount}»`,
    Boolean(built.group) && built.corruptedCount !== built.group.count,
    "لم تُوجد مجموعة بعدّاد قابل للتبديل");
  check("تشوّه رقمي: الحارس الحالي يرصد عدّاد المجموعة المشوّه",
    Boolean(built.group) && !text.some((lines) => printedGroup(lines, built.group)),
    `عدّاد «${built.group?.name}» مشوّه ومع ذلك اعتبره الحارس مطبوعاً سليماً`);
}

// ===== 2ب-٣) شاهد سالب: تبديل ترتيب كلمات الاسم يُرصد =====
// ملاحظة Codex P1 الرابعة (على c34a75e8): كروم يرسم كل كلمة من خلية الاسم في
// كتلة مستقلة، فتبليطٌ يقبل أي ترتيب للكتل كان يقبل «سليم ماستر أزرق» مكان
// «ماستر سليم أزرق» — تشوّه عربي يراه الزبون. الآن كتل المقطع الواحد تُضمّ
// بأصلها الأفقي في مقطع ذرّي ترتيبه مصون، فيُرصد التبديل.
{
  const { context, page } = await bootApp(1440, 900);
  const built = await page.evaluate(() => {
    const state = (0, eval)("state");
    state.syriaRateConfirmed = true;
    const ds = window.buildBulletinDataset(true, "dark").dataset;
    const plan = window.bulletinRenderPlan(ds);
    const doc = new DOMParser().parseFromString(plan.markup, "text/html");

    // نبدّل أول كلمتين مختلفتين في اسم صنف — نفس الكلمات بترتيب مختلف.
    const swapWords = (name) => {
      const parts = name.trim().split(/\s+/);
      if (parts.length < 2 || parts[0] === parts[1]) return null;
      return [parts[1], parts[0], ...parts.slice(2)].join(" ");
    };
    const cell = [...doc.querySelectorAll("tbody tr td.name")]
      .find((td) => swapWords(td.textContent.trim()));
    const rowEl = cell.closest("tr");
    const original = {
      name: cell.textContent.trim(),
      unit: rowEl.querySelector("td.unit").textContent.trim(),
      price: rowEl.querySelector("td.price").textContent.trim()
    };
    cell.textContent = swapWords(original.name);

    const styleTag = plan.markup.slice(0, plan.markup.indexOf("</style>") + "</style>".length);
    return {
      original, scrambled: swapWords(original.name),
      documentHtml: window.OZKPriceListTemplate.printDocument({
        theme: "dark", title: "word-order",
        bodyHtml: styleTag + doc.querySelector(".ozk-price-list").outerHTML
      })
    };
  });
  await context.close();

  const printed = await printDocument(built.documentHtml);
  const text = printed.pages;

  // القاعدة القديمة: كل كلمة كتلةٌ مستقلة تُبلَّط بأي ترتيب — أي «تساوي محتوى
  // بلا ترتيب». نُمثّلها بتساوي مجموعة الحروف والطول معاً.
  const oldPerBlockTiling = (lines, row) => {
    const target = normalizeArabic(row.name) + normalizeArabic(row.unit) + normalizeArabic(row.price);
    const wanted = [...target].sort().join("");
    return lines.some((line) => {
      const flat = line.join("");
      return flat.length === target.length && [...flat].sort().join("") === wanted;
    });
  };

  check(`تبديل الكلمات: «${built.original.name}» شُوّه إلى «${built.scrambled}»`,
    Boolean(built.scrambled) && built.scrambled !== built.original.name,
    `${built.original.name} → ${built.scrambled}`);
  check("تبديل الكلمات: القاعدة القديمة (تبليط كل كتلة على حدة) كانت تمرّ زوراً",
    text.some((lines) => oldPerBlockTiling(lines, built.original)),
    "الشاهد فقد معناه — لم تعد القاعدة القديمة تمرّ أصلاً");
  check("تبديل الكلمات: الحارس الحالي يرصد الاسم المبدَّل",
    !text.some((lines) => printedRow(lines, built.original)),
    `«${built.original.name}» بُدّلت كلماته ومع ذلك اعتبره الحارس مطبوعاً سليماً`);
}

// ===== 2ج) كاشف الالتفاف نفسه يعمل (وإلا كان الشرط أعلاه بلا معنى) =====
// شاهد موجب على الكاشف: اسم أطول من خليته يجب أن يُرصد ملتفّاً، واسم عادي لا.
{
  const { context, page } = await bootApp(1440, 900);
  const LONG = "ماستر طويل أزرق سليم نعنع مثلج بعلبة مزدوجة طويلة الاسم جداً للاختبار";
  const probe = await page.evaluate(([LONG, wrapProbe]) => {
    const T = window.OZKPriceListTemplate;
    const options = {
      logoSrc: `${location.origin}/public/icons/ozk-logo.png`, issueDate: T.formatArabicIssueDate(new Date()),
      badgeClass: "badge-syp", badgeLabelHtml: "ليرة", unitLabel: "سعر", theme: "dark"
    };
    const row = (name) => ({ name, unit: "كرتونة", price: "1,000 ل.س" });
    const detect = new Function(`return ${wrapProbe}`)();
    return {
      withLong: detect(T.render({ ...options, groups: [{ name: "ماستر", items: [row(LONG), row("ماستر صنف قصير")] }] })),
      withoutLong: detect(T.render({ ...options, groups: [{ name: "ماستر", items: [row("ماستر صنف قصير")] }] }))
    };
  }, [LONG, WRAP_PROBE]);
  await context.close();

  check("كاشف الالتفاف: يرصد الاسم الأطول من خليته", probe.withLong.includes(LONG),
    `رصد: ${JSON.stringify(probe.withLong)}`);
  check("كاشف الالتفاف: لا ينذر على الأسماء العادية", probe.withoutLong.length === 0,
    JSON.stringify(probe.withoutLong));
}

// ===== 3) حارس بنيوي: الصفحة الأولى لا تُعبَّأ بميزانية أكبر من ميزانيتها =====
// فحص مباشر على المُوزِّع بلا DOM: ميزانية الصفحة الأولى = الورقة - الرأس،
// وأي إعادة تعبئة تتجاوزها هي عين العطل الذي أُغلق.
{
  const context = await browser.newContext({ bypassCSP: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.OZKPriceListTemplate === "object", null, { timeout: 20000 });
  const probe = await page.evaluate(() => {
    const T = window.OZKPriceListTemplate;
    const g = (name) => ({ name, items: [{ name: `${name} صنف`, unit: "ك", price: "1.00 $" }] });
    const groups = [g("ماستر"), g("كابتن بلاك"), g("غلواز"), g("اليغانس")];
    // 470px ثم 500px: لا تتّسعان معاً تحت رأس 156px، وتتّسعان معاً بلا رأس.
    const heights = new Map([["ماستر", 470], ["كابتن بلاك", 500], ["غلواز", 470], ["اليغانس", 500]]);
    const headerHeightPx = 156;
    const layout = T.layoutGroupsMeasured(groups, heights, { pageWidthPx: 794, headerHeightPx, safetyMarginPx: 6 });
    const pageHeight = T.computePageContentHeightPx(794);
    const first = layout.mainPages[0];
    return {
      firstPageHeight: Math.max(first.rightHeight, first.leftHeight),
      firstPageBudget: pageHeight - 8 - headerHeightPx,
      pageHeight,
      placed: layout.mainPages.reduce((n, p) => n + p.right.length + p.left.length, 0)
        + layout.specialPages.reduce((n, p) => n + p.right.length + p.left.length, 0),
      total: groups.length
    };
  });
  await context.close();
  check("المُوزِّع: أطول عمود بالصفحة الأولى ضمن ميزانيتها المخفَّضة بالرأس",
    probe.firstPageHeight <= probe.firstPageBudget + 1e-6,
    `عمود ${probe.firstPageHeight}px مقابل ميزانية ${probe.firstPageBudget.toFixed(2)}px`);
  check("المُوزِّع: لا مجموعة تُفقد رغم تقييد الصفحة الأولى",
    probe.placed === probe.total, `وُزّعت ${probe.placed} من ${probe.total}`);
}

await browser.close();
server.close();

if (failed > 0) {
  console.error(`\n✗ فشل ${failed} فحصاً في محتوى نسخة الطباعة لنشرة الأسعار.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص محتوى نسخة الطباعة لنشرة الأسعار نجحت.");
