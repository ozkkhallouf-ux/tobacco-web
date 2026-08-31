// حارس تغطية أصناف نشرة الأسعار: **لا صنف يسقط بصمت، ولا عدّاد صفحات يكذب.**
//
// يغلق عطلين مُثبتين بتاريخ 2026-08-31:
//
//   1) مجموعة «نخلة» (٤ أصناف) كانت تختفي من النشرة بلا أي أثر. السبب:
//      SPECIAL_GROUPS كانت تُكتب يدوياً وتضمّ «مزايا» و«نخلة» بلا وجود لهما في
//      SPECIAL_RIGHT_GROUPS ولا SPECIAL_LEFT_GROUPS — فيستبعدهما layoutGroups من
//      `remaining` ولا يلتقطهما `take()`، فتسقط المجموعة كلها. النشرة تصل الزبون
//      ناقصة أربعة أصناف وأسعارها، وهو أسوأ من عدم إصدارها.
//
//   2) ترويسة المعاينة كانت تقول «2 صفحة» بينما الملف المصدَّر ٣ صفحات، لأن
//      customerPriceTemplatePageCount كان يمرّ بمسار تقديري مستقل
//      (layoutGroupsLegacyPages) بدل الـlayout المقاس الذي يُبنى منه الرسم فعلاً.
//
// المبدأ: نقارن **هويات الأصناف** (أسماء العرض، وهي فريدة عبر النشرة) بين
// الـdataset والمعاينة والمستند المصدَّر، ونقارن عدد صفحات المعاينة بعدد صفحات
// ملف PDF حقيقي. أي فارق = فشل.
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

// ===== 0) حارس المصدر: SPECIAL_GROUPS مشتقّة، لا مكتوبة يدوياً =====
// إعادة كتابتها يدوياً هي بعينها الطريقة التي وُلد بها عطل «نخلة».
{
  const src = readFileSync(resolve(root, "src/price-list-template.js"), "utf8");
  const line = src.match(/const\s+SPECIAL_GROUPS\s*=\s*new\s+Set\(\[([^\]]*)\]\)/);
  check("SPECIAL_GROUPS مشتقّة من قائمتَي الوجهة فقط (بلا أسماء يدوية)",
    Boolean(line) && /^\s*\.\.\.SPECIAL_RIGHT_GROUPS\s*,\s*\.\.\.SPECIAL_LEFT_GROUPS\s*$/.test(line[1]),
    `SPECIAL_GROUPS = new Set([${line ? line[1].trim() : "غير موجودة"}]) — أي اسم يدوي هنا يسقط بلا وجهة`);
}

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

async function boot(vw, vh) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, bypassCSP: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
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
  return { ctx, page };
}

// ===== 1) كل مجموعة لها وجهة — بما فيها «مزايا» و«نخلة» =====
// فحص سلوكي لا يقرأ ثوابت داخلية: نُغذّي layoutGroups بأسماء القسم الخاص كلها
// ونطالب بألا يسقط أي اسم.
{
  const { ctx, page } = await boot(1440, 900);
  const probe = await page.evaluate(() => {
    const names = ["معسل", "مزايا", "نخلة", "فحم", "ورق", "فيبات", "قداحات", "سلفان", "ماستر", "غلواز", "مجموعة مجهولة"];
    const groups = names.map((n) => ({ name: n, items: [{ name: `${n} صنف`, unit: "كرتونة", price: "1.00 $" }] }));
    const lg = window.OZKPriceListTemplate.layoutGroups(groups);
    const placed = [...lg.right, ...lg.left, ...lg.specialRight, ...lg.specialLeft].map((g) => g.name);
    return { dropped: lg.dropped || [], placed, specialLeft: lg.specialLeft.map((g) => g.name) };
  });
  check("لا مجموعة تسقط من التصنيف (بما فيها مزايا ونخلة)",
    probe.dropped.length === 0, `سقطت: ${JSON.stringify(probe.dropped)}`);
  check("«مزايا» و«نخلة» لهما وجهة صريحة في عمود القسم الخاص",
    probe.specialLeft.includes("مزايا") && probe.specialLeft.includes("نخلة"),
    `specialLeft = ${JSON.stringify(probe.specialLeft)}`);
  await ctx.close();
}

// ===== 2) تطابق الهويات والعدد وعدد الصفحات، في كل ثيم/عملة/عرض نافذة =====
for (const sc of [
  { label: "USD/dark @1440", useSyria: false, theme: "dark", vw: 1440, vh: 900 },
  { label: "USD/light @1440", useSyria: false, theme: "light", vw: 1440, vh: 900 },
  { label: "SYP/dark @1440", useSyria: true, theme: "dark", vw: 1440, vh: 900 },
  { label: "USD/dark @390", useSyria: false, theme: "dark", vw: 390, vh: 844 }
]) {
  const { ctx, page } = await boot(sc.vw, sc.vh);

  const got = await page.evaluate(async (sc) => {
    const state = (0, eval)("state");
    state.syriaRateConfirmed = true;
    const ds = window.buildBulletinDataset(sc.useSyria, sc.theme).dataset;
    const groups = window.bulletinTemplateGroups(ds);
    const plan = window.bulletinRenderPlan(ds);

    // هويات الـdataset: أسماء العرض داخل المجموعات (فريدة عبر النشرة).
    const datasetIds = [];
    groups.forEach((g) => g.items.forEach((i) => datasetIds.push(i.name)));

    // هويات المعاينة: من الشاشة المرسومة فعلاً.
    window.openPricePreview(sc.useSyria, sc.theme);
    await new Promise((r) => setTimeout(r, 300));
    const previewIds = [...document.querySelectorAll(".price-preview-scroll .ozk-price-list tbody tr td.name")]
      .map((td) => td.textContent.trim());
    const headerText = document.querySelector(".price-preview-titles p")?.textContent || "";
    const previewPageCount = Number((headerText.match(/(\d+)\s*صفحة/) || [])[1] || 0);

    // هويات المستند المصدَّر: من نفس الرسم الذي يُطبع.
    const doc = new DOMParser().parseFromString(plan.markup, "text/html");
    const exportIds = [...doc.querySelectorAll(".ozk-price-list tbody tr td.name")].map((td) => td.textContent.trim());
    const exportGroups = [...doc.querySelectorAll(".ozk-price-list .price-list-group")].map((g) => {
      const h = g.querySelector(".price-list-group-header").cloneNode(true);
      h.querySelectorAll(".price-list-group-count").forEach((n) => n.remove());
      return { name: h.textContent.replace(/\s+/g, " ").trim(), rows: g.querySelectorAll("tbody tr").length };
    });

    return {
      datasetItems: ds.items.length, datasetIds, previewIds, exportIds,
      previewPageCount, planPageCount: plan.pageCount, dropped: plan.dropped,
      exportGroups, groupNames: groups.map((g) => g.name),
      printDoc: window.OZKPriceListTemplate.printDocument({
        theme: ds.theme, title: "coverage", bodyHtml: plan.markup
      })
    };
  }, sc);
  await ctx.close();

  const setOf = (a) => new Set(a);
  const missing = got.datasetIds.filter((id) => !setOf(got.exportIds).has(id));
  const extra = got.exportIds.filter((id) => !setOf(got.datasetIds).has(id));
  const dupExport = got.exportIds.filter((id, i) => got.exportIds.indexOf(id) !== i);

  check(`${sc.label}: لا مجموعة سقطت من التوزيع`, got.dropped.length === 0, JSON.stringify(got.dropped));
  check(`${sc.label}: عدد أصناف dataset = المعاينة = التصدير`,
    got.datasetItems === got.previewIds.length && got.previewIds.length === got.exportIds.length,
    `dataset=${got.datasetItems} preview=${got.previewIds.length} export=${got.exportIds.length}`);
  check(`${sc.label}: لا هوية صنف مفقودة من التصدير`, missing.length === 0, JSON.stringify(missing.slice(0, 8)));
  check(`${sc.label}: لا هوية صنف زائدة في التصدير`, extra.length === 0, JSON.stringify(extra.slice(0, 8)));
  check(`${sc.label}: لا هوية صنف مكررة في التصدير`, dupExport.length === 0, JSON.stringify(dupExport.slice(0, 8)));

  const nakhla = got.exportGroups.find((g) => g.name === "نخلة");
  check(`${sc.label}: مجموعة «نخلة» موجودة بأصنافها الأربعة`,
    Boolean(nakhla) && nakhla.rows === 4, `نخلة = ${JSON.stringify(nakhla)}`);

  // كل مجموعة تظهر مرة واحدة فقط — أي تكرار يعني مجموعة قُسّمت بين عمودين/صفحتين.
  const names = got.exportGroups.map((g) => g.name);
  const dupGroups = names.filter((n, i) => names.indexOf(n) !== i);
  check(`${sc.label}: كل مجموعة كتلة واحدة غير مقسّمة`, dupGroups.length === 0, JSON.stringify(dupGroups));
  check(`${sc.label}: كل مجموعات الـdataset ظهرت في المستند`,
    got.groupNames.every((n) => names.includes(n)),
    `مفقودة: ${JSON.stringify(got.groupNames.filter((n) => !names.includes(n)))}`);

  // ===== عدد صفحات المعاينة = عدد صفحات ملف PDF حقيقي =====
  const pctx = await browser.newContext({ viewport: { width: 794, height: 1123 }, bypassCSP: true, serviceWorkers: "block" });
  const pp = await pctx.newPage();
  await pp.route(`${BASE}/__coverage`, (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: got.printDoc }));
  await pp.goto(`${BASE}/__coverage`, { waitUntil: "networkidle" });
  await pp.emulateMedia({ media: "print" });
  const pdf = await pp.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" } });
  await pctx.close();
  const pdfPages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;

  check(`${sc.label}: عدد صفحات المعاينة = عدد صفحات ملف PDF`,
    got.previewPageCount === pdfPages,
    `المعاينة تعرض ${got.previewPageCount} صفحة بينما الملف ${pdfPages}`);
  check(`${sc.label}: عدّاد المعاينة مشتقّ من الـlayout المقاس نفسه`,
    got.previewPageCount === got.planPageCount,
    `header=${got.previewPageCount} plan=${got.planPageCount}`);
}

await browser.close();
server.close();

if (failed > 0) {
  console.error(`\n✗ فشل ${failed} فحصاً في تغطية أصناف نشرة الأسعار.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص تغطية أصناف نشرة الأسعار وعدّاد صفحاتها نجحت.");
