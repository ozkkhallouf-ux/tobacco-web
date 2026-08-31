// فحص انحدار لمحرّك توزيع مجموعات تقرير المخزون على صفحات A4
// (inventoryPackPages / inventoryBalanceLastPage / inventoryTwoColumnPages بـsrc/app.js).
//
// العطل الذي يحرسه هذا الفحص: التوزيع القديم كان يوازن العمودين ثم يفتح صفحة
// جديدة عند أول مجموعة لا تتّسع في أيٍّ منهما — فيُهدر باقي **العمودين معاً**
// دفعةً واحدة (حتى ربع صفحة بيضاء). العقد الجديد: تعبئة تسلسلية بالارتفاع
// الحقيقي، بلا تقسيم مجموعة وبلا إعادة ترتيب.
//
// اختبار وحدة صِرف (Node بلا DOM) لأن الدوال المُختبَرة نقية: تأخذ ارتفاعات
// مُقاسة (وهمية هنا) ولا تلمس document — فتُختبر الحالات القاسية (فراغ لا يتّسع،
// فراغ يتّسع بالضبط، مجموعة أطول من عمود كامل، حجز سطر التذييل) بدقة البكسل
// دون تفاوت المتصفح.

import { readFileSync } from "node:fs";
import vm from "node:vm";

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
let failed = false;

function check(label, condition) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`ok: ${label}`);
  }
}

// --- استخراج الدوال النقية وتنفيذها فعلياً (لا مطابقة نصية) ---
const PATTERNS = {
  INVENTORY_PACK_SAFETY_PX: /const INVENTORY_PACK_SAFETY_PX = \d+;/,
  inventoryPageGeometry: /function inventoryPageGeometry\(mode\) \{[\s\S]*?\n\}\n/,
  inventoryPackPages: /function inventoryPackPages\(entries, options = \{\}\) \{[\s\S]*?\n\}\n/,
  inventoryBalanceLastPage: /function inventoryBalanceLastPage\(page, limit\) \{[\s\S]*?\n\}\n/,
  inventoryTwoColumnPages: /function inventoryTwoColumnPages\(entries, columnCapacity = 48\) \{[\s\S]*?\n\}\n/,
  inventoryReportPages: /function inventoryReportPages\(parts, mode\) \{[\s\S]*?\n\}\n/
};

const chunks = [];
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const match = appJs.match(pattern);
  if (!match) {
    console.error(`FAIL: could not extract ${name} from src/app.js — contract changed?`);
    failed = true;
    continue;
  }
  chunks.push(match[0]);
}
if (failed) process.exit(1);

const context = vm.createContext({ console });
// `inventoryReportPages` يلمس DOM عبر measureInventoryReportBlocks، ونحن بلا DOM هنا.
// نحقن بديلاً يُرجع قياسات مُمرَّرة من الاختبار، فيُنفَّذ منطق حجز التذييل الحقيقي
// (اكتشاف الدورة واختيار التخطيط الآمن) بلا أي متصفح.
vm.runInContext(
  `let __measureStub = null;
   function measureInventoryReportBlocks() { return __measureStub; }
   function inventoryPageGeometryStub() {}
   ${chunks.join("\n")}
   ;globalThis.__api = { INVENTORY_PACK_SAFETY_PX, inventoryPageGeometry, inventoryPackPages, inventoryBalanceLastPage, inventoryTwoColumnPages,
     runReportPages(measureStub, geometry, entriesCount) {
       __measureStub = measureStub;
       const parts = { entries: Array.from({ length: entriesCount }, (_, i) => ({ name: "م" + i, html: "", rows: 1 })) };
       const realGeom = inventoryPageGeometry;
       inventoryPageGeometry = () => geometry;
       try { return inventoryReportPages(parts, "print"); }
       finally { inventoryPageGeometry = realGeom; __measureStub = null; }
     } };`,
  context
);
const api = context.__api;

const g = (name, height) => ({ name, height });
const names = (page) => page.columns.map((column) => column.map((entry) => entry.name));
const flat = (pages) => pages.flatMap((page) => [...page.columns[0], ...page.columns[1]]).map((entry) => entry.name);

// === 1) العطل الأصلي: فراغ كبير في عمودين متوازنين لا يُهدر بعد الآن ===
// التوزيع القديم (توازن ثم فشل) كان يضع أ يميناً وب يساراً ثم يفتح صفحة جديدة
// لـج، فيترك ~40% من الصفحة الأولى بيضاء. التسلسلي يملأ العمود الأول أولاً.
{
  const entries = [g("أ", 600), g("ب", 300), g("ج", 300)];
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 0 });
  check("لا فراغ مهدور: الثلاث مجموعات بصفحة واحدة", pages.length === 1);
  check("لا فراغ مهدور: العمود الأول امتلأ قبل الانتقال للثاني",
    JSON.stringify(names(pages[0])) === JSON.stringify([["أ", "ب"], ["ج"]]));
}

// === 2) لا تُقسَّم مجموعة بين عمودين ولا بين صفحتين أبداً ===
{
  const entries = Array.from({ length: 40 }, (_, i) => g(`م${i}`, 137));
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 10 });
  const placed = flat(pages);
  check("لا تقسيم: كل مجموعة ظهرت مرة واحدة بالضبط",
    placed.length === entries.length && new Set(placed).size === entries.length);
  check("لا تقسيم: لا فيضان بأي عمود",
    pages.every((page) => page.sizes.every((size) => size <= 1000 - 10 + 1e-6)));
}

// === 3) الترتيب لا يتغيّر إطلاقاً (قراءة: عمود أول ثم ثانٍ، صفحة بعد صفحة) ===
{
  const entries = Array.from({ length: 25 }, (_, i) => g(`م${i}`, 90 + (i % 7) * 40));
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, firstPageBudget: 820, safetyPx: 10 });
  check("الترتيب محفوظ حرفياً بعد التعبئة",
    JSON.stringify(flat(pages)) === JSON.stringify(entries.map((entry) => entry.name)));
}

// === 4) الفراغ يتّسع بالضبط: لا تُدفع المجموعة لصفحة تالية بلا داعٍ ===
{
  const entries = [g("أ", 700), g("ب", 290)];
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 10 });
  check("يتّسع بالضبط: المجموعتان بنفس العمود بلا صفحة إضافية",
    pages.length === 1 && JSON.stringify(names(pages[0])[0]) === JSON.stringify(["أ", "ب"]));
}
{
  const entries = [g("أ", 700), g("ب", 291)]; // بكسل واحد فوق الحد
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 10 });
  check("لا يتّسع ببكسل واحد: انتقلت كاملة للعمود الثاني من نفس الصفحة",
    pages.length === 1 && JSON.stringify(names(pages[0])) === JSON.stringify([["أ"], ["ب"]]));
}

// === 5) العمودان يُستغلان بالكامل قبل فتح صفحة جديدة ===
{
  const entries = [g("أ", 900), g("ب", 900), g("ج", 900)];
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 0 });
  check("استغلال العمودين: الصفحة الأولى أخذت مجموعتين (عمود لكل منهما)",
    pages.length === 2 && JSON.stringify(names(pages[0])) === JSON.stringify([["أ"], ["ب"]]));
  check("استغلال العمودين: الثالثة فقط انتقلت للصفحة الثانية",
    JSON.stringify(names(pages[1])) === JSON.stringify([["ج"], []]));
}

// === 6) مجموعة أطول من عمود كامل: تُوضع ولا تُحذف ولا تُقصّ ولا تُعلّق الحلقة ===
{
  const entries = [g("صغيرة", 100), g("عملاقة", 5000), g("تالية", 100)];
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 10 });
  const placed = flat(pages);
  check("مجموعة عملاقة: لم تُحذف ولا تكررت", placed.length === 3 && new Set(placed).size === 3);
  check("مجموعة عملاقة: الترتيب بقي كما هو",
    JSON.stringify(placed) === JSON.stringify(["صغيرة", "عملاقة", "تالية"]));
  check("مجموعة عملاقة: وُضعت وحدها بعمود فارغ (لم تُحشر فوق مجموعة أخرى)",
    pages.some((page) => page.columns.some((column) => column.length === 1 && column[0].name === "عملاقة")));
}

// === 7) الصفحة الأولى ميزانيتها أقل (رأس + بطاقات الملخص) ===
{
  const entries = [g("أ", 500), g("ب", 400)];
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, firstPageBudget: 800, safetyPx: 0 });
  check("ميزانية الصفحة الأولى مخفّضة فعلياً: ب لم تُحشر فوق أ",
    JSON.stringify(names(pages[0])) === JSON.stringify([["أ"], ["ب"]]));
}

// === 8) حجز سطر التذييل بالصفحة الأخيرة ===
{
  const entries = [g("أ", 980)];
  const withReserve = api.inventoryPackPages(entries, { fullBudget: 1000, safetyPx: 0, reserveIndex: 0, reservePx: 40 });
  check("حجز التذييل: لم تُفقد المجموعة رغم ضيق الميزانية", flat(withReserve).length === 1);
  const two = api.inventoryPackPages([g("أ", 500), g("ب", 480)], { fullBudget: 1000, safetyPx: 0, reserveIndex: 0, reservePx: 40 });
  check("حجز التذييل: ب لم تُحشر فوق أ لأن الحجز يمنع ذلك",
    JSON.stringify(names(two[0])) === JSON.stringify([["أ"], ["ب"]]));
}

// === 9) موازنة الصفحة الأخيرة: عمود طويل بجانب عمود فارغ = نصف صفحة بيضاء ===
{
  const page = { columns: [[g("أ", 200), g("ب", 200), g("ج", 200), g("د", 200)], []], sizes: [800, 0] };
  api.inventoryBalanceLastPage(page, 1000);
  check("موازنة الصفحة الأخيرة: العمود الثاني لم يعد فارغاً",
    page.columns[1].length > 0 && page.columns[0].length > 0);
  check("موازنة الصفحة الأخيرة: الترتيب لم يتغيّر (قطع بنقطة واحدة)",
    JSON.stringify([...page.columns[0], ...page.columns[1]].map((entry) => entry.name))
      === JSON.stringify(["أ", "ب", "ج", "د"]));
  check("موازنة الصفحة الأخيرة: العمودان متساويان", page.sizes[0] === 400 && page.sizes[1] === 400);
}
{
  // لا تُطبَّق الموازنة إن سبّبت فيضاناً بالعمود الآخر
  const page = { columns: [[g("أ", 900)], [g("ب", 100)]], sizes: [900, 100] };
  const before = JSON.stringify(names(page));
  api.inventoryBalanceLastPage(page, 950);
  check("الموازنة تُلغى إن سبّبت فيضاناً", JSON.stringify(names(page)) === before);
}
{
  // مجموعة واحدة: لا شيء يُوازن
  const page = { columns: [[g("أ", 300)], []], sizes: [300, 0] };
  api.inventoryBalanceLastPage(page, 1000);
  check("مجموعة واحدة: تبقى بالعمود الأول بلا تغيير",
    page.columns[0].length === 1 && page.columns[1].length === 0);
}

// === 10) بيانات كثيرة: كل انتقال عمود/صفحة اضطراري لا اختياري ===
// هذا هو التعريف الدقيق لـ«لا فراغ مهدور» مع بقاء الترتيب: أول مجموعة في أي
// عمود يجب أن تكون **لا تتّسع** في العمود السابق.
//
// ملاحظة مهمة لمن يعدّل لاحقاً: لا تُقاس جودة هذا المحرّك بمقارنة عدد صفحاته
// بحدّ نظري مبني على إعادة ترتيب المجموعات. إعادة الترتيب ممنوعة بالمواصفة،
// وتحت هذا القيد فالتعبئة التسلسلية هي الأمثل المُثبَت (تقسيم تسلسل إلى أقل عدد
// من الكتل بسعة محدودة — الجشع أمثل حين تكون السعات غير متناقصة). قد يبدو
// التوزيع القديم أحياناً «أكثف» بعدد الصفحات لأنه يُبقي عمودين مفتوحين معاً،
// لكنه يفعل ذلك بكسر ترتيب القراءة (مجموعة لاحقة تسبق سابقتها بالعمود الأول)،
// وهو ما تمنعه المواصفة صراحةً.
function avoidableBreaks(pages, { fullBudget, firstPageBudget, safetyPx }) {
  const columns = [];
  pages.forEach((page, pageIndex) => {
    const limit = (pageIndex === 0 ? firstPageBudget ?? fullBudget : fullBudget) - safetyPx;
    page.columns.forEach((entries, columnIndex) => {
      columns.push({ entries, limit, size: page.sizes[columnIndex], at: `ص${pageIndex}/ع${columnIndex}` });
    });
  });
  const found = [];
  for (let i = 1; i < columns.length; i += 1) {
    const first = columns[i].entries[0];
    const previous = columns[i - 1];
    if (!first) continue;
    if (previous.size + first.height <= previous.limit + 1e-6) found.push(`${columns[i].at}:${first.name}`);
  }
  return found;
}

// التوزيع القديم حرفياً (يوازن ثم يفشل) — مرجع يثبت أن العطل كان حقيقياً وزال.
function legacyBalancedPages(entries, { fullBudget, firstPageBudget, safetyPx }) {
  const pages = [];
  const newPage = () => ({ columns: [[], []], sizes: [0, 0] });
  let page = newPage();
  pages.push(page);
  const limitFor = () => ((pages.length === 1 ? firstPageBudget ?? fullBudget : fullBudget) - safetyPx);
  for (const entry of entries) {
    const weight = entry.height;
    const capacity = limitFor();
    let column = page.sizes[0] <= page.sizes[1] ? 0 : 1;
    const other = column === 0 ? 1 : 0;
    if (page.sizes[column] + weight > capacity && page.sizes[other] + weight <= capacity) column = other;
    if (page.sizes[column] + weight > capacity) {
      page = newPage();
      pages.push(page);
      column = 0;
    }
    page.columns[column].push(entry);
    page.sizes[column] += weight;
  }
  return pages;
}

const readingOrder = (pages) => pages.flatMap((page) => [...page.columns[0], ...page.columns[1]]).map((entry) => entry.name);

{
  const entries = Array.from({ length: 300 }, (_, i) => g(`م${i}`, 40 + (i % 11) * 25));
  const options = { fullBudget: 1000, firstPageBudget: 880, safetyPx: 10 };
  const pages = api.inventoryPackPages(entries, options);
  check("بيانات كثيرة: كل المجموعات موجودة مرة واحدة وبالترتيب",
    JSON.stringify(flat(pages)) === JSON.stringify(entries.map((entry) => entry.name)));
  check("بيانات كثيرة: لا فيضان بأي عمود",
    pages.every((page, index) => page.sizes.every((size) => size <= (index === 0 ? 880 : 1000) - 10 + 1e-6)));
  const gaps = avoidableBreaks(pages, options);
  check(`بيانات كثيرة: لا انتقال عمود/صفحة كان يمكن تفاديه (${gaps.slice(0, 5).join(",") || "لا شيء"})`,
    gaps.length === 0);

  // نفس البيانات على التوزيع القديم: يثبت أن الفحص أعلاه يرصد عطلاً حقيقياً.
  const legacy = legacyBalancedPages(entries, options);
  check(`مرجع: التوزيع القديم كان يترك فراغات كان يمكن تفاديها (${avoidableBreaks(legacy, options).length} موضعاً)`,
    avoidableBreaks(legacy, options).length > 0);
  check("مرجع: التوزيع القديم كان يكسر ترتيب القراءة فعلاً",
    JSON.stringify(readingOrder(legacy)) !== JSON.stringify(entries.map((entry) => entry.name)));
  check("الجديد: ترتيب القراءة (عمود أول ثم ثانٍ) مطابق لترتيب الإدخال حرفياً",
    JSON.stringify(readingOrder(pages)) === JSON.stringify(entries.map((entry) => entry.name)));
}

// السيناريو الحقيقي: مجموعة كبيرة تتبعها صغيرات — أقسى حالة على «توازن ثم فشل»،
// وهي بالضبط شكل تقرير المخزون (ماستر/غلواز كبيرة ثم مجموعات صغيرة).
{
  const sizes = [520, 90, 70, 140, 610, 80, 95, 300, 210, 60, 480, 130, 75, 260, 55];
  const entries = sizes.map((height, i) => g(`مج${i}`, height));
  const options = { fullBudget: 1000, firstPageBudget: 880, safetyPx: 10 };
  const pages = api.inventoryPackPages(entries, options);
  const gaps = avoidableBreaks(pages, options);
  check(`تقرير واقعي: لا فراغ كان يمكن تفاديه (${gaps.join(",") || "لا شيء"})`, gaps.length === 0);
  check("تقرير واقعي: الترتيب محفوظ",
    JSON.stringify(readingOrder(pages)) === JSON.stringify(entries.map((entry) => entry.name)));
  const legacy = legacyBalancedPages(entries, options);
  check(`تقرير واقعي: صفحات أقل أو تساوي القديم (${pages.length} مقابل ${legacy.length})`,
    pages.length <= legacy.length);
}

// === 11) بيانات قليلة: صفحة واحدة، لا صفحة فارغة تابعة ===
{
  const entries = [g("أ", 120), g("ب", 90)];
  const pages = api.inventoryPackPages(entries, { fullBudget: 1000, firstPageBudget: 880, safetyPx: 10 });
  check("بيانات قليلة: صفحة واحدة فقط", pages.length === 1);
}
{
  const pages = api.inventoryPackPages([], { fullBudget: 1000, safetyPx: 10 });
  check("بلا بيانات: صفحة واحدة فارغة بلا انهيار",
    pages.length === 1 && pages[0].columns[0].length === 0 && pages[0].columns[1].length === 0);
}

// === 12) هندسة A4 الحقيقية لكل مسار تصدير ===
{
  const print = api.inventoryPageGeometry("print");
  check(`هندسة الطباعة: عرض المحتوى 190mm ≈ ${print.contentWidthPx.toFixed(1)}px`,
    Math.abs(print.contentWidthPx - 190 * (96 / 25.4)) < 0.5);
  check(`هندسة الطباعة: ارتفاع الصفحة 277mm ≈ ${print.pageHeightPx.toFixed(1)}px`,
    Math.abs(print.pageHeightPx - 277 * (96 / 25.4)) < 0.5);
  const canvas = api.inventoryPageGeometry("canvas");
  check("هندسة الهاتف: العرض يخصم حشوة .ozk-rpt الأفقية (794-20)", canvas.contentWidthPx === 774);
  check(`هندسة الهاتف: ارتفاع الصفحة موجب ومعقول (${canvas.pageHeightPx.toFixed(1)}px)`,
    canvas.pageHeightPx > 900 && canvas.pageHeightPx < 1300);
  check("هامش الأمان مُعرَّف وموجب", api.INVENTORY_PACK_SAFETY_PX > 0);
}

// === 13) المسار الاحتياطي بلا DOM: تسلسلي أيضاً، لا يهدر العمودين معاً ===
{
  const entries = [{ name: "أ", rows: 30 }, { name: "ب", rows: 18 }, { name: "ج", rows: 20 }];
  const pages = api.inventoryTwoColumnPages(entries, 48);
  check("الاحتياطي: أ+ب ملأتا العمود الأول (48 سطراً بالضبط)",
    JSON.stringify(pages[0].columns[0].map((entry) => entry.name)) === JSON.stringify(["أ", "ب"]));
  check("الاحتياطي: ج ذهبت للعمود الثاني لا لصفحة جديدة",
    pages.length === 1 && JSON.stringify(pages[0].columns[1].map((entry) => entry.name)) === JSON.stringify(["ج"]));
}

// === 14) حارس تراجعي نصّي: لا عودة للتقدير الثابت ولا لخوارزمية «العمود الأقصر» ===
{
  check("لا عودة لخوارزمية العمود الأقصر (توازن ثم فشل)",
    !appJs.includes("page.weights[0] <= page.weights[1]"));
  check("القياس الحقيقي من DOM موجود", appJs.includes("measureInventoryReportBlocks")
    && appJs.includes("getBoundingClientRect"));
  check("رأس الصفحة والبطاقات يُخصمان من ميزانية الصفحة",
    /const fullBudget = geometry\.pageHeightPx - measured\.headPx;/.test(appJs)
    && /const firstPageBudget = fullBudget - measured\.cardsPx;/.test(appJs));
  check("break-inside:avoid باقٍ كشبكة أمان لا كحل وحيد",
    appJs.includes(".inventory-group{margin:0 0 5px;break-inside:avoid;page-break-inside:avoid}"));
  check("التقرير يقيس بهندسة المسار الذي سيُصدَّر فعلاً",
    /isHandheldDevice\(\) \? "canvas" : "print"/.test(appJs));
}

// === 15) تذبذب حجز التذييل (ملاحظة Codex P1 على PR #156) ===
// السيناريو: ثلاث مجموعات 350px وحدّ صفحة 790px وتذييل 100px. بلا حجز يسع
// التخطيط صفحة واحدة [700,350]؛ لكن حجز التذييل على ص0 يُخرج صفحتين، وحجزه
// على ص1 (التي صارت الأخيرة) يُعيد الصفحة الأولى إلى ميزانيتها الكاملة فيعود
// التخطيط صفحة واحدة — فتتناوب الحلقة بين 1 و2 بلا استقرار أبداً.
//
// الكود القديم كان يكتفي بأربع محاولات ثم يحتفظ بآخر ناتج، فيخرج بتخطيط صفحة
// واحدة عمودها 700px بينما الحدّ بعد خصم التذييل 690px — فيضان يدفع التذييل أو
// مجموعة إلى ورقة إضافية، ويطبع الرأس «صفحة 1 من 1» والورق ورقتان.
{
  const PAGE = 800, HEAD = 0, CARDS = 0, FOOT = 100, SAFETY = api.INVENTORY_PACK_SAFETY_PX;
  const heights = [350, 350, 350];
  const geometry = { contentWidthPx: 700, pageHeightPx: PAGE };
  const measure = { heights, headPx: HEAD, cardsPx: CARDS, footPx: FOOT };
  const fullBudget = PAGE - HEAD;
  const firstPageBudget = fullBudget - CARDS;
  const base = { fullBudget, firstPageBudget, safetyPx: SAFETY };
  const limitOfPage = (i) => Math.max(0, (i === 0 ? firstPageBudget : fullBudget) - SAFETY);
  const entries = heights.map((height, i) => ({ name: `م${i}`, height }));

  // (أ) بلا حجز: التخطيط ينجح بصفحة واحدة — هذا ما يجعل السيناريو تذبذبياً أصلاً.
  const unreserved = api.inventoryPackPages(entries, base);
  check("تذبذب: بلا حجز التذييل ينجح التخطيط بصفحة واحدة",
    unreserved.length === 1 && unreserved.sizes === undefined && unreserved[0].sizes[0] === 700);

  // (ب) التذبذب حقيقي: حجز على ص0 -> صفحتان، وحجز على ص1 -> صفحة واحدة.
  const r0 = api.inventoryPackPages(entries, { ...base, reserveIndex: 0, reservePx: FOOT });
  const r1 = api.inventoryPackPages(entries, { ...base, reserveIndex: 1, reservePx: FOOT });
  check("تذبذب: الحجز على ص0 يُخرج صفحتين", r0.length === 2);
  check("تذبذب: الحجز على ص1 يُعيده لصفحة واحدة (دورة مغلقة)", r1.length === 1);

  // (ج) السلوك القديم (أربع محاولات ثم آخر ناتج) كان يُنتج فيضاناً فعلياً.
  let legacy = api.inventoryPackPages(entries, base);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const reserveIndex = legacy.length - 1;
    const next = api.inventoryPackPages(entries, { ...base, reserveIndex, reservePx: FOOT });
    legacy = next;
    if (next.length === reserveIndex + 1) break;
  }
  const legacyLast = legacy.length - 1;
  const legacyTallest = Math.max(legacy[legacyLast].sizes[0], legacy[legacyLast].sizes[1]);
  const legacyOverflow = legacyTallest + FOOT - limitOfPage(legacyLast);
  check(`مرجع: السلوك القديم كان يُنتج فيضاناً فعلياً (${legacyOverflow.toFixed(0)}px)`, legacyOverflow > 0);

  // (د) بعد الإصلاح: لا فيضان، ولا انقسام، والعدد المعروض = الفعلي، والحجز على
  //     الصفحة الأخيرة الفعلية.
  const pages = api.runReportPages(measure, geometry, heights.length);
  const lastIndex = pages.length - 1;
  const tallest = Math.max(pages[lastIndex].sizes[0], pages[lastIndex].sizes[1]);

  check("الإصلاح: لا فيضان بالصفحة الأخيرة بعد احتساب التذييل",
    tallest + FOOT <= limitOfPage(lastIndex) + 1e-6);
  check("الإصلاح: الحجز مطبَّق فعلياً على الصفحة الأخيرة (تتّسع لمحتواها + التذييل)",
    pages[lastIndex].sizes.every((size) => size + FOOT <= limitOfPage(lastIndex) + 1e-6));
  check("الإصلاح: لا فيضان بأي عمود في أي صفحة",
    pages.every((page, i) => page.sizes.every((size) => size <= limitOfPage(i) + 1e-6)));

  const placed = pages.flatMap((page) => [...page.columns[0], ...page.columns[1]]);
  check("الإصلاح: لا مجموعة مقسّمة ولا مفقودة ولا مكرّرة",
    placed.length === heights.length && new Set(placed.map((e) => e.name)).size === heights.length);
  check("الإصلاح: الترتيب محفوظ",
    JSON.stringify(placed.map((e) => e.name)) === JSON.stringify(entries.map((e) => e.name)));

  // العدد المعروض بالرأس («صفحة i من pages.length») يطابق الورق الفعلي: كل صفحة
  // منطقية يجب أن تسع ورقة واحدة بالضبط بعد احتساب الرأس والبطاقات والتذييل.
  const actualSheets = pages.reduce((sum, page, i) => {
    const content = Math.max(page.sizes[0], page.sizes[1])
      + HEAD + (i === 0 ? CARDS : 0) + (i === lastIndex ? FOOT : 0);
    return sum + Math.max(1, Math.ceil((content - 1e-6) / PAGE));
  }, 0);
  check(`الإصلاح: العدد المعروض (${pages.length}) = الورق الفعلي (${actualSheets})`,
    actualSheets === pages.length);
}

// === 16) لا عودة إلى «عدد محاولات ثابت ثم آخر ناتج» ===
{
  check("اكتشاف الدورة صريح عبر مجموعة الفهارس المُجرَّبة",
    appJs.includes("triedReserveIndexes") && /triedReserveIndexes\.has\(reserveIndex\)/.test(appJs));
  check("شرط الخروج هو نقطة الثبات مع أمان التذييل معاً",
    /next\.length - 1 === reserveIndex && footerFits\(next\)/.test(appJs));
  check("عند الدورة يوجد بديل يحجز التذييل من كل الصفحات",
    appJs.includes("reserveEveryPage"));
  check("لا عودة لحلقة المحاولات الثابتة",
    !/for \(let attempt = 0; attempt < 4; attempt \+= 1\)[\s\S]{0,200}reservePx: measured\.footPx/.test(appJs));
}

if (failed) {
  console.error("\ninventory report page packing check FAILED");
  process.exit(1);
}
console.log("\ninventory report page packing check passed");
