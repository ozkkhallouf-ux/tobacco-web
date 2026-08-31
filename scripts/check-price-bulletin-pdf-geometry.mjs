// فحص هندسة ملف PDF الناتج عن **زر التصدير الحقيقي** في شاشة معاينة النشرة.
//
// يغلق العطل المُبلَّغ بتاريخ 2026-08-31: ملف مُصدَّر من الموقع خرج بـ
// Producer = «jsPDF 2.3.1»، بحجم ~57MB، محتواه محشور في الثلث الأيسر من الورقة،
// عمود السعر مقصوص، وصفحة ثالثة فارغة تماماً. السبب الجذري كان مسار
// html2pdf/html2canvas الذي يحوّل DOM بعرض النافذة إلى canvas عملاق.
//
// المبدأ: لا نفحص صياغة الكود بل **الملف الناتج وهندسته**. كل فحص هنا يفشل
// إذا رجع أي من أعراض ذلك العطل:
//   1. فراغ جانبي يتجاوز الحد المعقول (المحتوى لا يملأ عرض الورقة)
//   2. غياب عمود السعر أو خلية سعر فارغة
//   3. صفحة فارغة أو شبه فارغة
//   4. اختلاف عدد عناصر المعاينة عن عناصر مستند التصدير
//   5. رجوع مسار jsPDF/html2canvas (يُكشف من Producer داخل الملف نفسه)
//   6. اعتماد عرض المستند على عرض النافذة بدل مقاس A4 الثابت
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

// مقاس A4 عند 96dpi — نفس المقاس الذي يقطّع عليه محرك الطباعة الأصلي.
const A4_W = 210 / 25.4 * 96;   // 793.70
const A4_H = 297 / 25.4 * 96;   // 1122.52

// ===== الحدود المقبولة =====
// الفراغ الجانبي: النشرة تُرسم حتى حافة الورقة تقريباً (هوامش القالب ~8px من
// كل جهة ≈ 1%). العطل المُبلَّغ كان ~66% فراغاً على جهة واحدة. الحد 8% يترك
// مجالاً واسعاً لأي تعديل تصميمي مشروع ويظل يكشف الانهيار فوراً.
const MAX_SIDE_GAP_RATIO = 0.08;
// صفحة "شبه فارغة": صفحة النشرة الأخيرة وصفحة الأصناف غير السجائرية قد تمتلئ
// جزئياً بشكل مشروع (المجموعات لا تُقصّ، والقسم الخاص يبدأ بصفحة مستقلة)، لكن
// أي صفحة تحمل أقل من هذه النسبة من ارتفاع الورقة هي عرض العطل القديم.
const MIN_PAGE_FILL_RATIO = 0.12;

// بيانات حقيقية من نفس ملف توليد النشرات المنشورة (294 صنفاً، عدة صفحات).
const raw = JSON.parse(readFileSync(resolve(root, "scripts/price-data.json"), "utf8"));
const ITEMS = raw.map((r) => ({
  key: r.item_key, name: r.name, groupName: r.group,
  // كرتونات كاملة: نشرة الجملة تشترط hasFullSecondUnit
  stockQty: (r.unitFactor || 50) * 8,
  unit1Name: r.unit1 || "كروز", unit2Name: r.unit || "كرتونة", unit2Factor: r.unitFactor || 50
}));
const PRICES = raw.map((r) => ({
  itemKey: r.item_key, unit1Name: r.unit1 || "كروز", unit2Name: r.unit || "كرتونة",
  unit2Factor: r.unitFactor || 50, unit2Price: r.usd,
  pricePayload: { retail: { price: r.usd } }, updatedAt: "2026-08-31T00:00:00.000Z"
}));

const browser = await chromium.launch();

// تشكيلات تغطي العملتين والثيمين، وعرضَي نافذة مختلفين جذرياً: عرض النافذة
// يجب ألا يغيّر مقاس المستند المصدَّر ولا توزيع صفحاته.
const CASES = [
  { useSyria: false, theme: "dark", appWidth: 1440, label: "USD/dark @1440" },
  { useSyria: true, theme: "dark", appWidth: 1440, label: "SYP/dark @1440" },
  { useSyria: false, theme: "light", appWidth: 1440, label: "USD/light @1440" },
  { useSyria: false, theme: "dark", appWidth: 390, label: "USD/dark @390 (هاتف)" }
];

const pageCountsByBulletin = new Map();

for (const { useSyria, theme, appWidth, label } of CASES) {
  // ===== 1) المرور بالمسار الحقيقي: فتح المعاينة ثم **نقر زر التصدير** =====
  const appContext = await browser.newContext({
    viewport: { width: appWidth, height: 900 }, bypassCSP: true, serviceWorkers: "block"
  });
  const page = await appContext.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));
  await page.goto(`${BASE}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.buildBulletinDataset === "function", null, { timeout: 20000 });
  await page.evaluate(({ items, prices }) => {
    // `state` تصريح const في سكربت كلاسيكي: مرئي لـeval العام لا كخاصية window.
    // لا نضيف أي منفذ اختبار إلى كود الإنتاج من أجل هذا الفحص.
    const state = (0, eval)("state");
    window.tobaccoData.setSyriaExchangeRate = async (value) => Number(value);
    state.inventoryReports = [{ items, summary: { syncedAt: "2026-08-31T00:00:00.000Z" } }];
    state.approvedPriceItems = prices;
    state.syriaExchangeRate = 14050;
    state.syriaRateConfirmed = true;
  }, { items: ITEMS, prices: PRICES });

  const captured = await page.evaluate(async ({ useSyria, theme }) => {
    const calls = [];
    const real = window.printHtmlDocument;
    window.printHtmlDocument = (html, options) => { calls.push({ html, options }); };
    try {
      window.openPricePreview(useSyria, theme);
      await new Promise((r) => setTimeout(r, 250));
      const button = document.querySelector("[data-action='export-price-preview']");
      if (!button) return { error: "زر التصدير غير موجود داخل المعاينة" };
      // عدد الأصناف كما تعرضه المعاينة على الشاشة فعلاً (لا من الـdataset).
      const previewRows = document.querySelectorAll(".price-preview-scroll .ozk-price-list tbody tr").length;
      button.click();                                   // ← النقرة الحقيقية
      await new Promise((r) => setTimeout(r, 250));
      return { calls: calls.length, html: calls[0]?.html || "", previewRows };
    } finally { window.printHtmlDocument = real; }
  }, { useSyria, theme });
  await appContext.close();

  if (captured.error) { check(`${label}: المسار الحقيقي يصل إلى زر التصدير`, false, captured.error); continue; }
  check(`${label}: نقرة التصدير تنتج مستند طباعة واحداً`, captured.calls === 1,
    `عدد استدعاءات printHtmlDocument = ${captured.calls}`);
  check(`${label}: لا أخطاء JS أثناء المعاينة والتصدير`, pageErrors.length === 0, pageErrors.join(" | "));

  // ===== 2) اطبع المستند الملتقط بمقاس A4 الحقيقي =====
  const printContext = await browser.newContext({
    viewport: { width: Math.round(A4_W), height: Math.round(A4_H) }, bypassCSP: true, serviceWorkers: "block"
  });
  const printPage = await printContext.newPage();
  await printPage.route(`${BASE}/__bulletin`, (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: captured.html }));
  await printPage.goto(`${BASE}/__bulletin`, { waitUntil: "networkidle" });
  await printPage.emulateMedia({ media: "print" });

  const geo = await printPage.evaluate(({ A4_W, A4_H }) => {
    const sheet = document.querySelector(".ozk-price-list");
    const rows = [...document.querySelectorAll(".ozk-price-list tbody tr")];
    const priceCells = [...document.querySelectorAll(".ozk-price-list td.price")];

    // صندوق المحتوى الأفقي: أقصى يسار وأقصى يمين تصلهما صفوف الأسعار فعلاً.
    let minLeft = Infinity, maxRight = -Infinity;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.width <= 0) continue;
      if (r.left < minLeft) minLeft = r.left;
      if (r.right > maxRight) maxRight = r.right;
    }

    const pages = [...document.querySelectorAll(".price-list-columns")].map((el) => {
      const rect = el.getBoundingClientRect();
      const pageRows = el.querySelectorAll("tbody tr").length;
      return { height: +rect.height.toFixed(1), width: +rect.width.toFixed(1), rows: pageRows };
    });

    return {
      sheetWidth: +sheet.getBoundingClientRect().width.toFixed(1),
      rows: rows.length,
      priceCells: priceCells.length,
      emptyPriceCells: priceCells.filter((td) => td.textContent.trim().length === 0).length,
      rowsMissingPriceCell: rows.filter((tr) => !tr.querySelector("td.price")).length,
      minLeft: Number.isFinite(minLeft) ? +minLeft.toFixed(1) : null,
      maxRight: Number.isFinite(maxRight) ? +maxRight.toFixed(1) : null,
      pages,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor
    };
  }, { A4_W, A4_H });

  const pdf = await printPage.pdf({
    format: "A4", printBackground: true, preferCSSPageSize: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" }
  });
  await printContext.close();

  const latin = pdf.toString("latin1");
  const pdfPages = (latin.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const producer = (latin.match(/\/Producer\s*\(([^)]*)\)/) || [])[1] || "";

  // ===== 3) الفحوص =====

  // (أ) عرض المستند مشتق من A4 لا من عرض النافذة.
  check(`${label}: عرض المستند = مقاس A4 لا عرض النافذة`,
    Math.abs(geo.sheetWidth - A4_W) <= 1,
    `sheetWidth=${geo.sheetWidth}px بينما A4=${A4_W.toFixed(1)}px (عرض النافذة=${appWidth}px)`);

  // (ب) الفراغ الجانبي — عرض العطل الأصلي «المحتوى في الثلث الأيسر».
  const leftGap = geo.minLeft === null ? 1 : geo.minLeft / A4_W;
  const rightGap = geo.maxRight === null ? 1 : (A4_W - geo.maxRight) / A4_W;
  check(`${label}: الفراغ الجانبي الأيسر ضمن الحد (${(MAX_SIDE_GAP_RATIO * 100).toFixed(0)}%)`,
    leftGap <= MAX_SIDE_GAP_RATIO,
    `فراغ أيسر = ${(leftGap * 100).toFixed(1)}% (minLeft=${geo.minLeft})`);
  check(`${label}: الفراغ الجانبي الأيمن ضمن الحد (${(MAX_SIDE_GAP_RATIO * 100).toFixed(0)}%)`,
    rightGap <= MAX_SIDE_GAP_RATIO,
    `فراغ أيمن = ${(rightGap * 100).toFixed(1)}% (maxRight=${geo.maxRight})`);

  // (ج) عمود السعر موجود وغير مقصوص.
  check(`${label}: كل صف يحمل خلية سعر`,
    geo.rows > 0 && geo.rowsMissingPriceCell === 0,
    `${geo.rowsMissingPriceCell} صفاً بلا خلية سعر (إجمالي الصفوف ${geo.rows})`);
  check(`${label}: لا خلية سعر فارغة`,
    geo.emptyPriceCells === 0,
    `${geo.emptyPriceCells} خلية سعر فارغة من ${geo.priceCells}`);

  // (د) لا صفحة فارغة ولا شبه فارغة.
  const blank = geo.pages.filter((p) => p.rows === 0);
  check(`${label}: لا صفحة بلا أي صنف`, blank.length === 0,
    `${blank.length} صفحة فارغة من ${geo.pages.length}`);
  const nearlyEmpty = geo.pages.filter((p) => p.height / A4_H < MIN_PAGE_FILL_RATIO);
  check(`${label}: لا صفحة شبه فارغة (< ${(MIN_PAGE_FILL_RATIO * 100).toFixed(0)}% من الورقة)`,
    nearlyEmpty.length === 0,
    `نسب الامتلاء = ${geo.pages.map((p) => (p.height / A4_H * 100).toFixed(0) + "%").join(", ")}`);

  // (هـ) عدد صفحات الملف = عدد صفحات النشرة — ورقة بيضاء زائدة تظهر هنا فوراً.
  check(`${label}: عدد صفحات الملف = عدد صفحات النشرة`,
    pdfPages === geo.pages.length,
    `${geo.pages.length} صفحة نشرة مقابل ${pdfPages} صفحة في الملف — الزائدة بيضاء`);

  // (و) لا يوجد صفحة تفيض عن الورقة فتدفع ورقة بيضاء بعدها.
  const overflowing = geo.pages.filter((p) => p.height - A4_H > 0.5);
  check(`${label}: لا صفحة تفيض عن ارتفاع الورقة`, overflowing.length === 0,
    `أسوأ فيض = ${Math.max(...geo.pages.map((p) => p.height - A4_H)).toFixed(2)}px`);

  // (ز) حارس الانحدار المباشر: عودة مسار html2canvas/jsPDF تظهر في Producer.
  check(`${label}: الملف ليس من إنتاج jsPDF (مسار html2canvas القديم)`,
    !/jsPDF/i.test(producer),
    `Producer = "${producer}"`);

  // (ح) خلفية موحدة على كامل الورقة (عطل «نصفها أسود ونصفها أبيض»).
  const expectedBg = theme === "light" ? "rgb(255, 253, 248)" : "rgb(12, 10, 7)";
  check(`${label}: خلفية المستند موحدة على html وbody`,
    geo.bodyBg === expectedBg && geo.htmlBg === expectedBg,
    `html=${geo.htmlBg} body=${geo.bodyBg} المتوقع=${expectedBg}`);

  // (ط) عناصر المعاينة = عناصر مستند التصدير.
  check(`${label}: عدد عناصر المعاينة = عدد عناصر التصدير`,
    captured.previewRows === geo.rows,
    `المعاينة=${captured.previewRows} التصدير=${geo.rows}`);

  // (ي) حجم الملف معقول لنشرة نصية (العطل أنتج ~57MB من canvas).
  check(`${label}: حجم الملف معقول (< 5MB) وليس هيكلاً فارغاً (> 20KB)`,
    pdf.length > 20 * 1024 && pdf.length < 5 * 1024 * 1024,
    `${(pdf.length / 1024 / 1024).toFixed(2)}MB`);

  pageCountsByBulletin.set(`${useSyria}|${theme}|${appWidth}`, geo.pages.length);
}

// ===== 4) عرض النافذة لا يغيّر توزيع الصفحات =====
// نفس النشرة (USD/dark) من نافذة 1440 ومن نافذة 390 يجب أن تُنتج نفس عدد
// الصفحات: أي اعتماد على window.innerWidth/scrollWidth يكسر هذه المساواة.
{
  const wide = pageCountsByBulletin.get("false|dark|1440");
  const narrow = pageCountsByBulletin.get("false|dark|390");
  check("توزيع الصفحات مستقل عن عرض النافذة (1440 مقابل 390)",
    wide !== undefined && wide === narrow,
    `1440 → ${wide} صفحة، 390 → ${narrow} صفحة`);
}

await browser.close();
server.close();

if (failed > 0) {
  console.error(`\n✗ فشل ${failed} فحصاً في هندسة PDF نشرة الأسعار.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص هندسة ملف PDF لنشرة الأسعار نجحت.");
