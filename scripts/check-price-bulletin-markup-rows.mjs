// ============================================================================
// حارس قارئ صفوف مستند الطباعة (scripts/lib/markup-rows.mjs).
//
// لماذا يوجد: القارئ هو **البديل المفروض دائماً** في حارسَي
// check-price-bulletin-print-content.mjs و‑first-page-content.mjs — أي الشرط
// الذي يبقى مطبَّقاً حتى حين يتعذّر خط النشرة فتُعلَّق المطابقة الحرفية على
// الـPDF. فخللٌ فيه يفتح الباب في الاتجاهين: إنذارٌ كاذب على ورقةٍ سليمة،
// أو — وهو الأخطر — **مرورٌ زائف** لصفٍّ ليس على الورق أصلاً.
//
// وكان القارئ ينزع الوسوم بتعبير نمطي يمرّ مرّةً واحدة (تنبيه CodeQL
// js/incomplete-multi-character-sanitization). كل حالة أدناه قيست على تلك
// النسخة فأخطأتها، وتقيسها الآن على المحلّل الحقيقي فتصحّ — فالفحص يسقط فوراً
// إن عاد أحدٌ إلى نزع الوسوم نصّياً.
// ============================================================================
import { chromium } from "playwright";
import { createMarkupRowReader, flattenForMarkup } from "./lib/markup-rows.mjs";

let failed = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); }
};

const browser = await chromium.launch();
const { rowsMissingFromMarkup, markupRowKeys } = createMarkupRowReader(browser);

// مستند بشكل مستند الطباعة الحقيقي: <table> حاضر دائماً، وإلا أسقط محلّل HTML
// الصفوف بقاعدة foster parenting فصار الفحص فارغاً بلا أن يُخبر.
const doc = (bodyHtml) => `<!doctype html><html lang="ar" dir="rtl"><head>`
  + `<meta charset="utf-8"><title>نشرة الأسعار</title></head><body>`
  + `<section class="ozk-price-list"><table><tbody>${bodyHtml}</tbody></table></section>`
  + `</body></html>`;

const ROWS = [
  { name: "اليغانس سليم فضي", unit: "كروز", price: "99,000 ل.س" },
  { name: "غلواز قصير أحمر", unit: "كروز", price: "109,560 ل.س" }
];
const cells = (row, nameHtml = row.name) => `<td class="name">${nameHtml}</td>`
  + `<td class="unit">${row.unit}</td><td class="price">${row.price}</td>`;
const asRow = (row, nameHtml) => `<tr>${cells(row, nameHtml)}</tr>`;
const HEALTHY = doc(ROWS.map((r) => asRow(r)).join(""));

const missingNames = async (markup, rows = ROWS) =>
  (await rowsMissingFromMarkup(markup, rows)).map((r) => r.name);

// ---------------------------------------------------------------------------
// ١) الأساس: مستند سليم، وصفّ محذوف، ومستند غائب
// ---------------------------------------------------------------------------
console.log("\n١) الأساس");
{
  const onHealthy = await missingNames(HEALTHY);
  check("المستند السليم: لا صفّ مفقود", onHealthy.length === 0, JSON.stringify(onHealthy));

  const stripped = HEALTHY.replace(asRow(ROWS[1]), "");
  const onStripped = await missingNames(stripped);
  check("يرصد الصفّ المحذوف", onStripped.join("") === ROWS[1].name, JSON.stringify(onStripped));

  for (const [label, absent] of [["null", null], ["فارغ", ""], ["غير نصّ", 42]]) {
    const onAbsent = await rowsMissingFromMarkup(absent, ROWS);
    check(`مستند غائب (${label}) = كل الصفوف مفقودة`,
      onAbsent.length === ROWS.length, `المرصود ${onAbsent.length} من ${ROWS.length}`);
  }
}

// ---------------------------------------------------------------------------
// ٢) مرور زائف: نصٌّ ليس على الورق لا يجوز أن يُشبِع المطابقة
//    (هذه هي الحالات التي كان النزع النصّي يمرّرها زوراً)
// ---------------------------------------------------------------------------
console.log("\n٢) لا مرور زائف — ما ليس مطبوعاً لا يُحسب");
{
  // الصفّ الثاني محذوف من الورق وموجود داخل تعليق HTML فقط.
  const ghostInComment = doc(asRow(ROWS[0]) + `<!-- ${asRow(ROWS[1])} -->`);
  const onGhost = await missingNames(ghostInComment);
  check("صفّ داخل تعليق HTML يبقى مفقوداً (لا يُحسب مطبوعاً)",
    onGhost.join("") === ROWS[1].name, JSON.stringify(onGhost));

  // الصفّ الثاني محذوف، واسمه مدسوس في قيمة سمة على صفّ آخر.
  const ghostInAttr = doc(asRow(ROWS[0], `<span title="${ROWS[1].name}">${ROWS[0].name}</span>`));
  const onAttr = await missingNames(ghostInAttr);
  check("اسم داخل قيمة سمة يبقى مفقوداً (لا تسرّب للسمات)",
    onAttr.join("") === ROWS[1].name, JSON.stringify(onAttr));

  // محتوى <script> داخل خلية ليس نصّاً مطبوعاً، فلا يدخل مفتاح المقارنة.
  const scriptInCell = doc(asRow(ROWS[0], `${ROWS[0].name}<script>const x = "${ROWS[1].name}";</script>`)
    + asRow(ROWS[1], `<style>.x{content:"${ROWS[1].name}"}</style>`));
  const onScript = await missingNames(scriptInCell);
  check("محتوى <script>/<style> لا يُشبِع صفّاً",
    onScript.join("") === ROWS[1].name, JSON.stringify(onScript));

  // لا يقبل الاحتواء النصّي: اسم أقصر داخل اسم أطول (ثغرة Codex على 3468f90).
  const swallowed = HEALTHY.replace(asRow(ROWS[0]), asRow({ ...ROWS[0], name: `${ROWS[0].name} بدون طبعة` }));
  const onSwallowed = await missingNames(swallowed);
  check("اسم مبتلع داخل اسم أطول لا يُشبِع الأقصر",
    onSwallowed.join("") === ROWS[0].name, JSON.stringify(onSwallowed));
}

// ---------------------------------------------------------------------------
// ٣) إنذار كاذب: صفٌّ على الورق لا يجوز أن يُبلَّغ مفقوداً
//    (النزع النصّي كان يُسقط كلّ حالة من هذه)
// ---------------------------------------------------------------------------
console.log("\n٣) لا إنذار كاذب — ما هو مطبوع يُقرأ كما يُرسم");
{
  const AMP = { name: "تنباك & عسل", unit: "كروز", price: "1,000 ل.س" };
  const LT = { name: "عرض <خاص>", unit: "كروز", price: "2,000 ل.س" };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const entities = doc(asRow(AMP, esc(AMP.name)) + asRow(LT, esc(LT.name)));
  const onEntities = await missingNames(entities, [AMP, LT]);
  check("الكيانات تُفكّ: اسم فيه & أو < أو > يُطابَق",
    onEntities.length === 0, JSON.stringify(onEntities));

  const attrGt = doc(asRow(ROWS[0], `<span title="a>b" data-q='x>y'>${ROWS[0].name}</span>`) + asRow(ROWS[1]));
  const onAttrGt = await missingNames(attrGt);
  check("قيمة سمة تحوي '>' لا تكسر قراءة الخلية",
    onAttrGt.length === 0, JSON.stringify(onAttrGt));

  const split = doc(asRow(ROWS[0], ROWS[0].name.replace(" ", `<span></span> <b></b>`)) + asRow(ROWS[1]));
  const onSplit = await missingNames(split);
  check("اسم مشطور بوسوم تنسيق يُقرأ متّصلاً",
    onSplit.length === 0, JSON.stringify(onSplit));

  const unclosed = doc(ROWS.map((r) => `<tr><td class="name">${r.name}`
    + `<td class="unit">${r.unit}<td class="price">${r.price}`).join(""));
  const onUnclosed = await missingNames(unclosed);
  check("<td> غير مغلق: الصفوف تُقرأ ولا تُبلَّغ كلّها مفقودة",
    onUnclosed.length === 0, JSON.stringify(onUnclosed));

  const nested = doc(asRow(ROWS[0], `<table><tr><td>ملاحظة</td></tr></table>${ROWS[0].name}`) + asRow(ROWS[1]));
  const onNested = await missingNames(nested);
  check("جدول متداخل داخل خلية لا يُسقط الصفّ الخارجي",
    onNested.join("") === ROWS[0].name || onNested.length === 0,
    `المرصود: ${JSON.stringify(onNested)} — المطلوب ألا يسقط ${ROWS[1].name}`);
}

// ---------------------------------------------------------------------------
// ٤) حمولات متداخلة/مشوّهة: لا إعادة تركيب لوسمٍ خطر، ولا تنفيذ
// ---------------------------------------------------------------------------
console.log("\n٤) الحمولات المتداخلة والمشوّهة");
{
  // شواهد تُميّز **ما لا يُرسم على الورق أبداً** عن النصّ المرئي: محتوى عنصر
  // <script> وقيم السمات. أي ظهور لها في مفتاح مقارنة = تسرّب.
  // (لا نمنع كلمة «alert» بذاتها: في حمولةٍ مثل `<scr<script>ipt>…` يصير
  // «ipt>…» نصّاً **مرئياً** فعلاً، فمنعه كان سيمنع نصّاً مشروعاً — وهو ما
  // كشفه هذا الفحص على نفسه قبل تضييق الشرط.)
  const SCRIPT_ONLY = "OZK_SCRIPT_ONLY";
  const ATTR_ONLY = "OZK_ATTR_ONLY";

  // حمولات مصمَّمة على ثغرة النزع النصّي: حذف الوسم مرّةً واحدة يلحم الجارَين.
  const PAYLOADS = [
    `<<script>script>OZK_TEXT_1<</script>/script>`,
    `<scr<script>ipt>OZK_TEXT_2</scr</script>ipt>`,
    `<img src=x onerror="window.__ozkPwned = 1">`,
    `<svg/onload=window.__ozkPwned=1>`,
    `<iframe src="javascript:window.__ozkPwned=1"></iframe>`,
    `<img src="x" alt="> <script>${SCRIPT_ONLY}</script>">`,
    `<!--><script>${SCRIPT_ONLY}</script>-->`,
    `<script>${SCRIPT_ONLY}</script>OZK_TEXT_7`,
    `<span title="${ATTR_ONLY}" data-n="${ATTR_ONLY}">OZK_TEXT_8</span>`
  ];
  const payloadDoc = doc(PAYLOADS.map((p, i) =>
    `<tr><td class="name">${p}</td><td class="unit">كروز</td><td class="price">${i}</td></tr>`).join("")
    + ROWS.map((r) => asRow(r)).join(""));

  const keys = [...await markupRowKeys(payloadDoc)];

  // (أ) محتوى <script> لا يدخل المقارنة أبداً.
  const scriptLeak = keys.filter((k) => k.includes(SCRIPT_ONLY));
  check("محتوى <script> لا يتسرّب إلى مفاتيح المقارنة",
    scriptLeak.length === 0, `تسرّب: ${JSON.stringify(scriptLeak)}`);

  // (ب) قيم السمات لا تدخل المقارنة أبداً — ومنها معالِجات الأحداث.
  const attrLeak = keys.filter((k) => k.includes(ATTR_ONLY) || /onerror|onload|javascript:/i.test(k));
  check("قيم السمات ومعالِجات الأحداث لا تتسرّب إلى مفاتيح المقارنة",
    attrLeak.length === 0, `تسرّب: ${JSON.stringify(attrLeak)}`);

  // (ج) والنصّ المرئي فعلاً يصل — وإلا كان الشرطان أعلاه يمرّان بمفاتيح فارغة.
  check("النصّ المرئي داخل الحمولات يصل إلى المفاتيح (الفحص ليس فارغاً)",
    keys.some((k) => k.includes("OZK_TEXT_8")) && keys.some((k) => k.includes("OZK_TEXT_7")),
    `المفاتيح: ${JSON.stringify(keys.slice(0, 4))}`);

  // (ب) الحمولات لا تُركّب صفوفاً وهمية تُطابق أصنافاً حقيقية.
  const onPayloads = await missingNames(payloadDoc);
  check("وجود الحمولات لا يُخفي صفوف الأصناف الحقيقية",
    onPayloads.length === 0, JSON.stringify(onPayloads));

  const fake = { name: "اليغانس سليم ذهبي", unit: "كروز", price: "7" };
  const onFake = await missingNames(payloadDoc, [fake]);
  check("الحمولات لا تُركّب صفّاً غير موجود",
    onFake.length === 1, `المرصود: ${JSON.stringify(onFake)}`);

  // (ج) التحليل نفسه لا يُنفّذ شيئاً: DOMParser("text/html") لا يشغّل سكربتاً
  //     ولا يحمّل مورداً. نقيسه بدل أن نفترضه.
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.route("**/*", (route) => { requests.push(route.request().url()); route.abort(); });
  const pwned = await page.evaluate((html) => {
    const d = new DOMParser().parseFromString(html, "text/html");
    return { flag: window.__ozkPwned ?? null, scripts: d.querySelectorAll("script").length };
  }, doc(PAYLOADS.map((p) => `<tr><td>${p}</td></tr>`).join("")));
  await page.waitForTimeout(200);
  await context.close();

  check("التحليل لا يُنفّذ سكربتاً ولا معالِج حدث",
    pwned.flag === null, `window.__ozkPwned = ${pwned.flag}`);
  check("التحليل لا يُطلق أي طلب شبكة",
    requests.length === 0, `طلبات: ${JSON.stringify(requests.slice(0, 5))}`);
  check("عناصر <script> تُبنى في المستند المحلَّل لكنها خاملة (فلا يُقرأ محتواها)",
    pwned.scripts > 0, `عدد عناصر script = ${pwned.scripts}`);
}

// ---------------------------------------------------------------------------
// ٥) التطبيع: المقارنة تتجاهل الفراغات وتُوحّد أشكال المحارف
// ---------------------------------------------------------------------------
console.log("\n٥) التطبيع");
{
  check("flattenForMarkup يحذف الفراغات",
    flattenForMarkup(" ا ب\nج\t") === "ابج", flattenForMarkup(" ا ب\nج\t"));
  check("flattenForMarkup يُطبّع NFKC",
    flattenForMarkup("ﺏﺑ") === flattenForMarkup("بب"),
    `${flattenForMarkup("ﺏﺑ")} ≠ ${flattenForMarkup("بب")}`);

  const spaced = doc(ROWS.map((r) =>
    `<tr>\n  <td class="name">\n  ${r.name}  \n</td>\n`
    + `  <td class="unit"> ${r.unit} </td>\n  <td class="price"> ${r.price} </td>\n</tr>`).join("\n"));
  const onSpaced = await missingNames(spaced);
  check("الفراغات والأسطر داخل الخلايا لا تكسر المطابقة",
    onSpaced.length === 0, JSON.stringify(onSpaced));
}

await browser.close();

if (failed) {
  console.error(`\n❌ قارئ صفوف الترميز: ${failed} فحصاً فاشلاً.`);
  process.exit(1);
}
console.log("\n✅ قارئ صفوف الترميز: كل الفحوص ناجحة.");
