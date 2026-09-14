// ============================================================================
// قراءة صفوف مستند الطباعة بمحلّل HTML حقيقي (لا regex).
//
// **مطابقة صفٍّ كامل، لا احتواء نصّي** (مستقلّة عن الخط تماماً).
// لماذا الصفّ كاملاً: التطبيع يحذف الفراغات، فاسمُ صنفٍ أقصر قد يكون مقطعاً
// داخل اسم أطول («اليغانس سليم فضي» داخل «اليغانس سليم فضي بدون طبعة»)، فيقبله
// `includes` ويمرّ حذفُ الأقصر زوراً — وهي نفس ثغرة الاحتواء التي أُغلقت في
// قارئ الـPDF (ملاحظة Codex P1 على 3468f90). فنقارن الخلايا الثلاث بالتساوي
// التام مع صفٍّ واحد من الترميز.
//
// ومستندٌ غائب (فشل الزر في إنتاجه) = **كل الصفوف مفقودة**، لا «لا شيء مفقود»
// (ملاحظة DeepScan INSUFFICIENT_NULL_CHECK).
//
// ---------------------------------------------------------------------------
// لماذا هُجر الـregex (تنبيه CodeQL js/incomplete-multi-character-sanitization)
// ---------------------------------------------------------------------------
// كان الاستخراج: التقاط <tr>/<td> بـregex ثم `replace(/<[^>]*>/g, "")` على
// محتوى الخلية. وهي ليست قراءةً بل حذفُ ما **يشبه** الوسم مرّةً واحدة، فتنهار
// في الاتجاهين — وكلاهما مُقاس، لا مفترض (راجع الفحص المرافق
// check-price-bulletin-markup-rows.mjs، فكل حالة هناك رقمٌ منه):
//
//   إنذار كاذب (صفٌّ على الورق يُبلَّغ مفقوداً):
//     · الكيانات لا تُفكّ: «A &amp; B» تُقرأ «A&amp;B» والنصّ الفعلي «A & B»،
//       فاسمُ صنفٍ فيه & أو < أو > يسقط رغم سلامة الورقة.
//     · قيمة سمة فيها '>': <td title="a>b">NAME</td> تُقرأ «b">NAME».
//     · <td> غير مغلق: الـregex لا يجد شيئاً فتُبلَّغ **كل** الصفوف مفقودة.
//     · جدول متداخل داخل خلية: الصفّ الخارجي يسقط كلّه.
//
//   مرور زائف (نصٌّ ليس على الورق يُشبِع المطابقة) — وهو الأخطر، لأن هذا
//   الحارس هو البديل **المفروض دائماً** حين يتعذّر خط النشرة:
//     · التعليقات تُحسب نصّاً: <!-- <td>GHOST</td> --> يمرّ كأنه مطبوع.
//     · وسمٌ مشطور يلتحم: «scri<b></b>pt» يصير «script» بعد الحذف — وهو بعينه
//       ما ترصده قاعدة CodeQL: حذفُ الوسم مرّةً واحدة يلحم الجارَين فيُركّب
//       نصّاً لم يكن متّصلاً في المصدر.
//
// الحلّ ليس regex أمتن، بل ترك التحليل لمن يُحسنه: نُسلّم الترميز إلى محلّل
// HTML الحقيقي — **نفس محرّك كروميوم الذي يرسم المستند** — ونقرأ textContent.
// فما يقيسه الحارس صار هو ما يراه المتصفّح فعلاً، لا تقريباً نصّياً له.
//
// أمان التحليل: DOMParser بنوع "text/html" **لا يُنفّذ** سكربتاً ولا يحمّل
// مورداً (لا <script> ولا onerror ولا شبكة)، والتحليل يجري في سياق فارغ
// منفصل عن صفحة التطبيق، والناتج نصٌّ يُستعمل مفتاحَ مقارنة فقط.
// ============================================================================

export const MARKUP_CELL_SEPARATOR = "\u0001";
export const flattenForMarkup = (value) => String(value).normalize("NFKC").replace(/\s+/g, "");

// يعمل داخل الصفحة. `:scope > td` تحديداً: خلايا الصفّ نفسه لا خلايا جدولٍ
// متداخل — فالجدول الداخلي صفوفه تُقرأ صفوفاً مستقلّة كما هو في الـDOM.
//
// ويُحذف <script>/<style>/<template> من نسخةٍ من الخلية قبل القراءة: محتواها
// ليس نصّاً مطبوعاً على الورق، فلا يجوز أن يدخل مفتاح المقارنة. (التعليقات
// خارجة أصلاً — textContent لا يشملها.)
const readRowCells = (html) => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rendered = (td) => {
    const copy = td.cloneNode(true);
    for (const el of copy.querySelectorAll("script, style, template")) el.remove();
    return copy.textContent;
  };
  return [...doc.querySelectorAll("tr")]
    .map((tr) => [...tr.querySelectorAll(":scope > td")].map(rendered));
};

// صفحة تحليل واحدة كسولة تُعاد على كل النداءات: التحليل لا يحتاج سياق التطبيق
// ولا خطوطه، وإطلاق سياق لكل نداء كان سيضاعف زمن الحارس بلا مقابل.
// تُغلق ضمناً مع browser.close() في نهاية الفحص.
export function createMarkupRowReader(browser) {
  let pending = null;
  const parserPage = () => (pending ??= browser.newContext().then((c) => c.newPage()));

  const markupRowKeys = async (documentHtml) => new Set(
    (await (await parserPage()).evaluate(readRowCells, String(documentHtml)))
      .filter((cells) => cells.length)
      .map((cells) => cells.map(flattenForMarkup).join(MARKUP_CELL_SEPARATOR)));

  const rowsMissingFromMarkup = async (documentHtml, rows) => {
    if (typeof documentHtml !== "string" || !documentHtml) return [...rows];
    const keys = await markupRowKeys(documentHtml);
    return rows.filter((row) => !keys.has(
      [row.name, row.unit, row.price].map(flattenForMarkup).join(MARKUP_CELL_SEPARATOR)));
  };

  return { markupRowKeys, rowsMissingFromMarkup };
}
