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
import zlib from "node:zlib";

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
// كروم يرسم كل مقطع نصّي داخل كتلة `BT … ET`، ويضع علامة `/ReversedChars`
// على الكتل المرسومة بترتيب **بصري** (العربية)، ويرفق `/Span<</ActualText …>>`
// بالحروف التي لا يكفي فيها رمز الخط (الروابط مثل «لأ»). فنقرأ النص هكذا:
//   · حروف الكتلة بالترتيب، مع تفضيل ActualText على خريطة /ToUnicode؛
//   · تُعكس حروف الكتلة إن حملت `/ReversedChars` فتعود لترتيبها المنطقي؛
//   · الكتل نفسها تُرسم من اليسار إلى اليمين، فيُعكس ترتيبها ليعود منطقياً.
// بهذا يخرج اسم الصنف المختلط («1970 سليم أزرق») بترتيبه الصحيح، ولا يلتصق
// عدّاد المجموعة برقم داخل الاسم التالي.
const INFLATE = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
// حرف تحكّم لا يظهر في أي نص عربي: يفصل الكتل أثناء التحليل ثم يُحذف قبل المقارنة.
const RUN_SEPARATOR = "\u0001";

function inflateStream(body) {
  const sm = String(body).match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
  if (!sm) return null;
  let data = Buffer.from(sm[1], "latin1");
  if (/\/FlateDecode/.test(body)) {
    try { data = zlib.inflateSync(data, INFLATE); }
    catch { try { data = zlib.inflateRawSync(data, INFLATE); } catch { return null; } }
  }
  return data.toString("latin1");
}

function utf16beFromHex(hex) {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out.replace(/^\uFEFF/, "");
}

function parseToUnicode(cmap) {
  const map = new Map();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), utf16beFromHex(pair[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(row[1], 16), hi = parseInt(row[2], 16), dst = parseInt(row[3], 16);
      for (let code = lo; code <= hi && code - lo < 65536; code += 1) {
        map.set(code, String.fromCodePoint(dst + (code - lo)));
      }
    }
  }
  return map;
}

// حروف عملية إظهار واحدة، **حرفاً حرفاً**. عملية `Tj` واحدة قد تحمل أكثر من
// رمز خط (مثل `<001A002B> Tj`)، فلو عوملت العملية ككتلة واحدة لبقي ترتيب
// حروفها الداخلي بصرياً بعد عكس الكتلة — فتخرج «كروز» بصيغة «كرزو» و«دفيدوف»
// بصيغة «دفيدفو»، ويسقط اسم مطبوع فعلاً من المطابقة. العكس يجب أن يجري على
// مستوى الحرف لا على مستوى العملية.
function decodeShowOperator(payload, unicodeMap) {
  const glyphs = [];
  for (const hex of payload.matchAll(/<([0-9A-Fa-f]*)>/g)) {
    const h = hex[1];
    for (let k = 0; k + 4 <= h.length; k += 4) {
      const glyph = unicodeMap.get(parseInt(h.slice(k, k + 4), 16));
      if (glyph) glyphs.push(glyph);
    }
  }
  return glyphs;
}

// نص كتلة `BT … ET` واحدة بترتيبها المنطقي.
// `/Span<</ActualText …>>` يصف النص المنطقي لمجموعة رسوم (يفكّ روابط مثل «لأ»)،
// فيُؤخذ كوحدة واحدة لا تُعكس داخلياً، ويبقى سارياً حتى `EMC` كي لا تُحتسب رسوم
// المجموعة نفسها مرتين.
function readTextBlock(blockBody, fonts, unicodeFor) {
  const reversed = /\/ReversedChars\s+BMC/.test(blockBody);
  const ops = /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\/ActualText\s*<([0-9A-Fa-f]*)>|\[([\s\S]*?)\]\s*TJ|<([0-9A-Fa-f]*)>\s*Tj|\bEMC\b/g;
  const glyphs = [];
  let font = null;
  let spanText = null;
  let spanEmitted = false;
  let op;
  while ((op = ops.exec(blockBody))) {
    if (op[1] !== undefined) { font = fonts.get(op[1]) ?? null; continue; }
    if (op[2] !== undefined) { spanText = utf16beFromHex(op[2]); spanEmitted = false; continue; }
    if (op[3] === undefined && op[4] === undefined) { spanText = null; continue; } // EMC
    if (spanText != null) {
      if (!spanEmitted) { glyphs.push(spanText); spanEmitted = true; }
      continue;
    }
    const payload = op[3] !== undefined ? op[3] : `<${op[4]}>`;
    glyphs.push(...decodeShowOperator(payload, font != null ? unicodeFor(font) : new Map()));
  }
  if (!glyphs.length) return "";
  return (reversed ? glyphs.reverse() : glyphs).join("");
}

// خرائط /ToUnicode لكل خط، محسوبة مرة واحدة لكل ملف.
function unicodeResolver(objects) {
  const cache = new Map();
  return (fontId) => {
    if (cache.has(fontId)) return cache.get(fontId);
    const ref = (String(objects.get(fontId) || "").match(/\/ToUnicode\s+(\d+)\s+0\s+R/) || [])[1];
    const stream = ref ? inflateStream(objects.get(+ref) || "") : null;
    const map = stream ? parseToUnicode(stream) : new Map();
    cache.set(fontId, map);
    return map;
  };
}

function pageFontMap(pageBody) {
  const fontBlock = (pageBody.match(/\/Font\s*<<([\s\S]*?)>>/) || [])[1] || "";
  const fonts = new Map();
  for (const f of fontBlock.matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) fonts.set(f[1], +f[2]);
  return fonts;
}

// إحداثيات كتلة النص: `a b c d e f Tm` — e أفقي، f رأسي. تُستعمل لتجميع
// الكتل في **أسطر** حقيقية، وهو ما يربط مقاطع الاسم الملتفّ بسطره لا بالصفحة كلها.
function blockOrigin(blockBody) {
  const tm = blockBody.match(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/);
  if (!tm) return null;
  return { x: parseFloat(tm[5]), y: parseFloat(tm[6]) };
}

const LINE_TOLERANCE_PX = 3;

// أسطر مجموعة كتل واحدة. كل سطر يحتفظ بمواضع كتله الأفقية لأننا نحتاجها
// للتمييز بين سطر صفّ جديد وسطر «تكملة التفاف» داخل الخلية نفسها.
// الكتل تُرسم يساراً⇦يميناً، فعكس ترتيبها داخل السطر يعيده لترتيبه المنطقي.
function linesFromBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const grouped = [];
  let current = null;
  for (const block of sorted) {
    if (!current || Math.abs(block.y - current.y) > LINE_TOLERANCE_PX) {
      current = { y: block.y, items: [] };
      grouped.push(current);
    }
    current.items.push(block);
  }
  return grouped.map((line) => ({
    xs: [...new Set(line.items.map((b) => Math.round(b.x)))],
    text: line.items.sort((a, b) => a.x - b.x).map((b) => b.text).reverse().join(RUN_SEPARATOR)
  }));
}

// أسطر الصفحة **مرتّبة بالعمود**: النشرة عمودان متجاوران، فصفّان متقابلان
// يتشاركان نفس المدى الرأسي تقريباً. لو بُنيت الأسطر للصفحة كاملة لاختلط
// سطرُ العمود الآخر بسطور العمود الأول، فينكسر ضمّ الالتفاف ويسقط اسم مطبوع
// فعلاً. سطر فاصل فارغ بين العمودين يمنع أي مطابقة من العبور بينهما.
const COLUMN_SEPARATOR_LINE = "";
function pageLinesByColumn(blocks) {
  if (!blocks.length) return [];
  const xs = blocks.map((b) => b.x);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const right = blocks.filter((b) => b.x >= midX);
  const left = blocks.filter((b) => b.x < midX);
  return [
    ...linesFromBlocks(right).map((line) => line.text),
    COLUMN_SEPARATOR_LINE,
    ...linesFromBlocks(left).map((line) => line.text)
  ];
}

function pdfPageLines(pdf) {
  const raw = pdf.toString("latin1");
  const objects = new Map();
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) objects.set(+m[1], m[2]);
  const unicodeFor = unicodeResolver(objects);

  const pages = [];
  for (const [, body] of objects) {
    if (!/\/Type\s*\/Page[^s]/.test(body)) continue;
    const contentsId = (body.match(/\/Contents\s+(\d+)\s+0\s+R/) || [])[1];
    const content = contentsId ? inflateStream(objects.get(+contentsId) || "") : null;
    if (!content) { pages.push([]); continue; }
    const fonts = pageFontMap(body);
    const blocks = [];
    for (const bt of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      const text = readTextBlock(bt[1], fonts, unicodeFor);
      if (!text) continue;
      const origin = blockOrigin(bt[1]) || { x: 0, y: blocks.length };
      blocks.push({ ...origin, text });
    }
    pages.push(pageLinesByColumn(blocks).map(normalizeArabic));
  }
  return pages;
}

// نص قابل للمقارنة: بلا فواصل تحليل ولا تشكيل ولا علامات اتجاه ولا فراغات،
// وبأشكال الحروف الأساسية (NFKC يفكّ أشكال العرض العربية).
function normalizeArabic(value) {
  return String(value)
    .replaceAll(RUN_SEPARATOR, "")
    .normalize("NFKC")
    .replace(/[\u0640\u064B-\u0652\u0670\u200B-\u200F\u061C\u2066-\u2069\u202A-\u202E\uFEFF]/g, "")
    .replace(/\s+/g, "");
}

// هل الاسم مطبوع داخل هذه الورقة؟
//
// **مربوط بالسطر، لا بالصفحة.** الاسم الذي يُرسم بسطر واحد يجب أن يظهر متّصلاً
// داخل نصّ ذلك السطر. والاسم الذي يلتفّ داخل خليته (والالتفاف لا يقع إلا عند
// فراغ) تتوزّع مقاطعه على أسطر **متتالية** بالترتيب، فنقبله فقط إن وُجدت مقاطعه
// كذلك: مقطع في السطر k، وتاليه في k+1، وهكذا.
//
// لماذا هذا القيد ضروري (ملاحظة Codex P1 على d0c229f6): البحث عن كل مقطع
// مستقلاً في **كامل نص الصفحة** كان يسمح لصنف مفقود فعلاً بأن يُحتسب مطبوعاً،
// لأن أسماء النشرة تُعيد استعمال كلمات شائعة («ماستر»، «سليم»، «فضي»، «أزرق»)
// فتُشبع مقاطعُه من صفوف أخرى لا علاقة لها به — أي حارس يمرّ زوراً بينما محتوى
// يراه الزبون ضائع. سيناريو «الشاهد السالب» أدناه يُثبت أن هذا لم يعد ممكناً.
// الاسم مطبوع إذا ظهر **متّصلاً داخل سطر واحد** من أسطر الورقة (وقد ضُمّت
// أسطر الالتفاف إلى خلاياها قبل ذلك). لا تقسيم إلى مقاطع تُبحث كلٌّ على حدة:
// ذلك التسامح هو ما رصدته Codex كـP1، لأنه يسمح لصنف ضائع بأن يُحتسب مطبوعاً
// من كلمات صفوف أخرى. سيناريو «الشاهد السالب» يثبت أن الثغرة أُغلقت.
function printedContains(pageLines, name) {
  const flat = normalizeArabic(name);
  if (!flat) return true;
  return pageLines.some((line) => line.includes(flat));
}

// شرط صحة قراءة الملف: قارئ نص PDF يقرأ **سطوراً**، فالاسم الذي يُرسم بسطر
// واحد يُقارَن متّصلاً بلا أي تسامح — وهو ما يغلق ثغرة المرور الزائف (ملاحظة
// Codex P1 على d0c229f6). أما الاسم الذي يلتفّ داخل خليته فتتوزّع حروفه على
// مقطعَي رسم يفصل بينهما في الملف محتوى خليتَي الوحدة والسعر (بمحاور رأسية
// مختلفة، لأن الخليتين تتوسّطان صفاً أطول) — ولا سبيل لإعادة تجميعه إلا
// بإعادة بناء الخلايا هندسياً.
//
// بدل التسامح (الذي يُعيد فتح الثغرة) أو التخمين الهندسي (الهشّ)، **نفرض
// الشرط صراحةً**: لا اسم يلتفّ في هندسة الطباعة. أي اسم جديد يلتفّ يُفشل هذا
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

  // هويات ما يراه المستخدم على الشاشة قبل الضغط.
  const expected = await page.evaluate(() => ({
    itemNames: [...document.querySelectorAll(".price-preview-scroll .ozk-price-list tbody tr td.name")]
      .map((td) => td.textContent.trim()),
    groupNames: [...document.querySelectorAll(".price-preview-scroll .ozk-price-list .price-list-group-name")]
      .map((el) => el.textContent.trim()),
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
  const missingGroups = expected.groupNames.filter((name) => !text.some((pageText) => printedContains(pageText, name)));
  check(`${sc.label}: كل أسماء المجموعات (${expected.groupNames.length}) مطبوعة داخل الملف`,
    missingGroups.length === 0, `مفقودة: ${JSON.stringify(missingGroups.slice(0, 8))}`);

  const missingItems = expected.itemNames.filter((name) => !text.some((pageText) => printedContains(pageText, name)));
  check(`${sc.label}: كل أسماء الأصناف (${expected.itemNames.length}) مطبوعة داخل الملف`,
    missingItems.length === 0, `مفقودة: ${JSON.stringify(missingItems.slice(0, 8))}`);

  // --- «الرأس فقط»: كل ورقة يجب أن تحمل أصنافاً، لا ترويسة وحدها ---
  const itemsPerPage = text.map((pageText) =>
    expected.itemNames.filter((name) => printedContains(pageText, name)).length);
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
      itemNames: groups.flatMap((g) => g.items.map((i) => i.name)),
      groupNames: groups.map((g) => g.name),
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
  const missing = built.itemNames.filter((n) => !text.some((pageText) => printedContains(pageText, n)));
  check("شكل الإنقاذ: كل الأصناف مطبوعة داخل الملف",
    missing.length === 0, `مفقودة: ${JSON.stringify(missing.slice(0, 8))}`);
  const missingGroups = built.groupNames.filter((n) => !text.some((pageText) => printedContains(pageText, n)));
  check("شكل الإنقاذ: كل المجموعات مطبوعة داخل الملف",
    missingGroups.length === 0, `مفقودة: ${JSON.stringify(missingGroups)}`);
  const perPage = text.map((t) => built.itemNames.filter((n) => printedContains(t, n)).length);
  check("شكل الإنقاذ: لا ورقة بالرأس وحده", perPage.every((n) => n > 0), `[${perPage.join(", ")}]`);
}

// ===== 2ب) شاهد سالب: الحارس يرصد فقدان صنف فعلاً (لا يمرّ زوراً) =====
// ملاحظة Codex P1 على d0c229f6: المطابقة السابقة كانت تبحث عن كل مقطع من الاسم
// مستقلاً في **كامل نص الصفحة**، فصنفٌ ضائع فعلاً كان يُحتسب مطبوعاً لأن أسماء
// النشرة تُعيد استعمال كلمات شائعة تُشبع مقاطعه من صفوف أخرى.
//
// هنا نُثبت السلوك لا الصياغة: نحذف صفّ صنف **مختار خصّيصاً بحيث تكون كل كلماته
// موجودة في أسماء أصناف أخرى**، نطبع الملف، ثم نطالب بأن يرصده الحارس مفقوداً —
// ونُظهر صراحةً أن القاعدة القديمة (بحث الصفحة كاملة) كانت ستمرّه.
{
  const { context, page } = await bootApp(1440, 900);
  const built = await page.evaluate(() => {
    const state = (0, eval)("state");
    state.syriaRateConfirmed = true;
    const ds = window.buildBulletinDataset(true, "dark").dataset;
    const plan = window.bulletinRenderPlan(ds);
    const names = window.bulletinTemplateGroups(ds).flatMap((g) => g.items.map((i) => i.name));

    // ضحيّة كل كلماتها مشتركة مع أسماء أخرى: أقسى حالة على المطابقة.
    const words = (n) => n.trim().split(/\s+/).filter(Boolean);
    const victim = names.find((name) => {
      const parts = words(name);
      return parts.length >= 2 && parts.every((w) => names.some((other) => other !== name && words(other).includes(w)));
    }) || names[names.length - 1];

    const doc = new DOMParser().parseFromString(plan.markup, "text/html");
    const row = [...doc.querySelectorAll("tbody tr")]
      .find((tr) => tr.querySelector("td.name")?.textContent.trim() === victim);
    row.remove();
    const mutated = doc.querySelector(".ozk-price-list").outerHTML;
    const styleTag = plan.markup.slice(0, plan.markup.indexOf("</style>") + "</style>".length);
    return {
      victim,
      names,
      documentHtml: window.OZKPriceListTemplate.printDocument({
        theme: "dark", title: "negative-witness", bodyHtml: styleTag + mutated
      })
    };
  });
  await context.close();

  const printed = await printDocument(built.documentHtml);
  const text = printed.pages;

  // القاعدة القديمة: كل مقطع يُبحث عنه مستقلاً في كامل نص الصفحة، بلا ترتيب ولا جوار.
  const pageWideFragmentMatch = (pageText, name) => {
    const words = String(name).trim().split(/\s+/).map(normalizeArabic).filter(Boolean);
    return words.every((w) => pageText.includes(w));
  };
  const wholePageText = text.map((lines) => lines.join(""));

  check("الشاهد السالب: الضحيّة اسم كل كلماته مشتركة مع أصناف أخرى",
    built.victim.trim().split(/\s+/).length >= 2, `الضحيّة = ${built.victim}`);
  check("الشاهد السالب: القاعدة القديمة (بحث الصفحة كاملة) كانت تمرّ زوراً",
    wholePageText.some((t) => pageWideFragmentMatch(t, built.victim)),
    `القاعدة القديمة لم تكن ستمرّ على «${built.victim}» — الشاهد فقد معناه، اختر ضحيّة أقسى`);
  check("الشاهد السالب: الحارس الحالي يرصد الصنف المحذوف مفقوداً",
    !text.some((lines) => printedContains(lines, built.victim)),
    `«${built.victim}» حُذف من المستند ومع ذلك اعتبره الحارس مطبوعاً`);

  const missing = built.names.filter((n) => !text.some((lines) => printedContains(lines, n)));
  check("الشاهد السالب: لا ضحايا جانبية — المفقود هو المحذوف وحده",
    missing.length === 1 && missing[0] === built.victim,
    `المفقود = ${JSON.stringify(missing.slice(0, 8))} · المحذوف = ${built.victim}`);
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
