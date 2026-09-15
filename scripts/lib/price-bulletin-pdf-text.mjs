// قارئ نصّ ملف PDF لنشرات الأسعار — الوحدة المشتركة بين حرّاس الطباعة.
//
// لماذا مشتركة: حارس محتوى الطباعة (check-price-bulletin-print-content.mjs)
// وحارس توزيع الصفحة الأولى (check-price-bulletin-first-page-content.mjs)
// يحتاجان **نفس** القراءة الصارمة بالضبط. نسختان منها تعنيان أن ملاحظةً
// تُصلَح في واحدة وتبقى ثغرةً في الأخرى — وسلسلة ملاحظات Codex الموثّقة أدناه
// كلّها وقعت في هذا القارئ تحديداً. مصدرٌ واحد يجعل تشديده يسري على الحارسين معاً.
//
// كروم يرسم كل مقطع نصّي داخل كتلة `BT … ET`، ويضع علامة `/ReversedChars`
// على الكتل المرسومة بترتيب **بصري** (العربية)، ويرفق `/Span<</ActualText …>>`
// بالحروف التي لا يكفي فيها رمز الخط (الروابط مثل «لأ»). فنقرأ النص هكذا:
//   · حروف الكتلة بالترتيب، مع تفضيل ActualText على خريطة /ToUnicode؛
//   · تُعكس حروف الكتلة إن حملت `/ReversedChars` فتعود لترتيبها المنطقي؛
//   · الكتل نفسها تُرسم من اليسار إلى اليمين، فيُعكس ترتيبها ليعود منطقياً.
// بهذا يخرج اسم الصنف المختلط («1970 سليم أزرق») بترتيبه الصحيح، ولا يلتصق
// عدّاد المجموعة برقم داخل الاسم التالي.
import zlib from "node:zlib";

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

// أسطر مجموعة كتل واحدة. الكتل تُرسم يساراً⇦يميناً، فعكس ترتيبها داخل السطر
// يعيده لترتيبه المنطقي.
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
  // كل سطر = **مصفوفة «مقاطع منطقية»**، لا مصفوفة كتل رسم.
  //
  // كروم يرسم كل كلمة من خلية الاسم في كتلة `BT…ET` مستقلة، لكن كتل المقطع
  // الواحد تتشارك **نفس أصل النص** (`Tm`) لأنها مقطع ثنائي الاتجاه واحد. لذلك
  // نضمّ الكتل المتتالية ذات الأصل الأفقي نفسه في مقطع واحد **ذرّي** ترتيبه
  // الداخلي مصون.
  //
  // هذا يغلق ملاحظة Codex P1 الرابعة (على c34a75e8): بلا هذا الضمّ كانت
  // المطابقة تُبلّط كل كلمة على حدة، فتقبل «سليم ماستر أزرق» مكان
  // «ماستر سليم أزرق» — تشوّه عربي يراه الزبون ويمرّ من الحارس.
  //
  // ويبقى التسامح المشروع بين المقاطع: خلية السعر تحمل مقطعين بأصلين مختلفين
  // (الرقم و«ل.س») لأنها تُرسم `direction:ltr` داخل نشرة `rtl`.
  return grouped.map((line) => {
    const ordered = line.items.sort((a, b) => a.x - b.x).reverse();
    const runs = [];
    let current = null;
    for (const block of ordered) {
      const origin = Math.round(block.x);
      if (!current || current.origin !== origin) {
        current = { origin, parts: [] };
        runs.push(current);
      }
      current.parts.push(block.text);
    }
    return runs.map((run) => normalizeArabic(run.parts.join(""))).filter(Boolean);
  });
}

// أسطر الصفحة **مرتّبة بالعمود**: النشرة عمودان متجاوران، فصفّان متقابلان
// يتشاركان نفس المدى الرأسي تقريباً. لو بُنيت الأسطر للصفحة كاملة لاختلط
// سطرُ العمود الآخر بسطور العمود الأول، فينكسر ضمّ الالتفاف ويسقط اسم مطبوع
// فعلاً. سطر فاصل فارغ بين العمودين يمنع أي مطابقة من العبور بينهما.
const COLUMN_SEPARATOR_LINE = [];
function pageLinesByColumn(blocks) {
  if (!blocks.length) return [];
  const xs = blocks.map((b) => b.x);
  const midX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const right = blocks.filter((b) => b.x >= midX);
  const left = blocks.filter((b) => b.x < midX);
  return [...linesFromBlocks(right), COLUMN_SEPARATOR_LINE, ...linesFromBlocks(left)];
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
    pages.push(pageLinesByColumn(blocks));
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
// **مطابقة صفّ كامل، لا احتواء نصّي.** الصفّ المطبوع سطرٌ واحد في الملف يحمل
// خلاياه الثلاث بالترتيب المنطقي: الاسم ثم الوحدة ثم السعر. فنقارن السطر
// **بالتساوي التام** مع تسلسل الخلايا الثلاث كما تعرضها المعاينة.
//
// لماذا التساوي لا الاحتواء (ملاحظة Codex P1 الثانية، على 6ac9fae7): التطبيع
// يحذف الفراغات، فاسمُ صنفٍ أقصر قد يكون **مقطعاً داخل** اسم أطول — مثل
// «اليغانس سليم فضي» داخل «اليغانس سليم فضي بدون طبعة» في price-data.json.
// مع الاحتواء كان حذف الصفّ الأقصر يمرّ بلا رصد لأن سطر الأطول يُشبعه.
// وبمقارنة الصفّ كاملاً يُرصد أي غياب — وتُفحص الأسعار والوحدات معه لا بمعزل.
//
// (وقبلها، ملاحظة P1 الأولى على d0c229f6: تقسيم الاسم إلى مقاطع تُبحث كلٌّ على
// حدة في كامل نص الصفحة كان يسمح لصنف ضائع بأن تُشبَع مقاطعُه من صفوف أخرى
// تشاركه كلماته الشائعة. لا تقسيم بعد الآن إطلاقاً.)
// نص السطر كاملاً (للعروض التشخيصية وللقواعد القديمة في الشاهد السالب).
function lineText(line) {
  return line.join("");
}

// **مطابقة صفّ كامل، بترتيب مصون بالكامل.**
//
// السطر المُعاد بناؤه = مقاطع منطقية متسلسلة. الصفّ المطبوع يجب أن يساوي
// نصَّ خلاياه الثلاث **حرفياً**: الاسم ثم الوحدة ثم السعر — بلا احتواء جزئي،
// وبلا أي إعادة ترتيب حرّة.
//
// الاستثناء الوحيد المسموح، وهو معروف السبب ومحصور بموضعه: خلية السعر تُرسم
// `direction:ltr` داخل نشرة `rtl`، فيخرج جزء العملة قبل الرقم في نصف الحالات.
// لذلك نقبل صيغتين اثنتين فقط للسعر: «رقم+عملة» و«عملة+رقم». لا شيء غير ذلك.
//
// هذا يغلق سلسلة ملاحظات Codex على هذا الحارس، كلٌّ منها كانت تسمح بمرور
// زائف على تشوّه يراه الزبون:
//   · d0c229f6 — مقاطع الاسم تُبحث كلٌّ على حدة في كامل الصفحة.
//   · 6ac9fae7 — الاحتواء النصّي: اسم أقصر يُشبَع من سطر اسم أطول يحويه.
//   · 14ef895e — بصمة الحروف مرتّبةً: «12,345» = «12,354»، وعدّاد «12» = «21».
//   · c34a75e8 — تبليط كل كلمة على حدة: «سليم ماستر أزرق» = «ماستر سليم أزرق».
// الشواهد السالبة الأربعة أدناه تُثبت أن كلاً منها صار يُرصد.
function priceOrderings(price) {
  const normalized = normalizeArabic(price);
  const split = /^([\d.,]+)(.+)$/.exec(normalized);
  return split ? [normalized, `${split[2]}${split[1]}`] : [normalized];
}

function printedRow(pageLines, row) {
  const prefix = normalizeArabic(row.name) + normalizeArabic(row.unit);
  const wanted = new Set(priceOrderings(row.price).map((price) => prefix + price));
  return pageLines.some((line) => wanted.has(line.join("")));
}

// رأس المجموعة سطرٌ يحمل اسمها وعدّاد أصنافها — بنفس الصرامة، وبالترتيبين
// الممكنين وحدهما (العدّاد شارة تُرسم على يسار الاسم).
function printedGroup(pageLines, group) {
  const name = normalizeArabic(group.name);
  const count = normalizeArabic(String(group.count));
  const wanted = new Set([`${name}${count}`, `${count}${name}`]);
  return pageLines.some((line) => wanted.has(line.join("")));
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

export {
  pdfPageLines,
  normalizeArabic,
  lineText,
  priceOrderings,
  printedRow,
  printedGroup,
  COLUMN_SEPARATOR_LINE,
  LINE_TOLERANCE_PX
};
