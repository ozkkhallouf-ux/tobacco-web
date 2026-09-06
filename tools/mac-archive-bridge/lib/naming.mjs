// بناء اسم الملف النهائي وتنقيته.
//
// قاعدة أمنية: الموقع لا يرسل اسم ملف ولا مساراً. يرسل حقولاً وصفية فقط
// (طرف/رقم/تاريخ/عنوان) والجسر هو من يبني الاسم من قالب نوع المستند.

import { DOC_TYPES } from "./doc-types.mjs";
import { stripInvisible } from "./arabic.mjs";

const MAX_PART = 60;

/**
 * ينقّي جزءاً نصياً قادماً من الموقع قبل وضعه داخل اسم ملف.
 * يمنع: فواصل المسار، محارف التحكّم، النقاط البادئة، تسلسل «..».
 * لا يمنع الحروف العربية ولا الفراغات العادية — الاسم يجب أن يبقى مقروءاً.
 */
export function sanitizePart(value, { max = MAX_PART } = {}) {
  let text = stripInvisible(String(value == null ? "" : value)).normalize("NFC");
  text = text
    .replace(/[\u0000-\u001F\u007F]/g, " ")  // محارف تحكّم
    .replace(/[/\\:]/g, " ")                 // فواصل مسار (مع «:» لأن Finder يعرضها «/»)
    .replace(/[<>"|?*]/g, " ")               // محارف تكسر التوافق مع ويندوز/الشبكة
    .replace(/\.{2,}/g, ".")                 // «..» -> «.» يقطع أي محاولة صعود مجلد
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s-]+/, "")                 // نقطة بادئة = ملف مخفي على macOS
    .replace(/[.\s]+$/, "");
  if (text.length > max) text = text.slice(0, max).trim();
  return text;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** يقبل تاريخ الموقع فقط بصيغة YYYY-MM-DD، وإلا يستعمل تاريخ الجهاز. */
export function resolveDate(value, today = new Date()) {
  const text = String(value == null ? "" : value).trim();
  if (ISO_DATE.test(text) && !Number.isNaN(Date.parse(text))) return text;
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * يبني اسم الملف حسب اصطلاح التسمية المعتمد لكل نوع.
 * يرجع { name, date, folder } ويرمي Error إذا نقص حقل إلزامي.
 */
export function buildFileName(docType, meta = {}, today = new Date()) {
  const spec = DOC_TYPES[docType];
  if (!spec) throw new Error(`نوع مستند غير مدعوم: ${docType}`);

  const date = resolveDate(meta.date, today);
  const party = sanitizePart(meta.party);
  const number = sanitizePart(meta.number, { max: 40 });
  const title = sanitizePart(meta.title, { max: 80 });
  const currency = sanitizePart(meta.currency, { max: 8 }).toUpperCase();

  if (spec.needsParty && !party) throw new Error(`الحقل «الاسم» مطلوب لنوع ${docType}`);
  if (spec.needsNumber && !number) throw new Error(`الحقل «الرقم» مطلوب لنوع ${docType}`);

  // قرار المالك 2026-09-06: **اسم النسخة المؤرشفة = اسم الملف المنزَّل حرفياً**
  // في كل المسارات (Save as PDF على سطح المكتب، التنزيل، مشاركة iOS، والأرشيف).
  // فأي فرع هنا يجب أن يطابق `archiveDocumentTitle` في `src/app.js` نصّاً بنصّ —
  // ويحرس التطابقَ فحصُ `scripts/check-document-filenames.mjs` الذي يقارن ناتج
  // التنفيذين لكل نوع مستند، فلا تنحرف النسختان بصمت.
  let base;
  switch (docType) {
    case "invoice":
    case "return_invoice":
      base = `${spec.label} - ${party} - رقم ${number} - ${date}`;
      break;
    case "receipt":
    case "payment":
      // بلا رقم: رقم السند يُولَّد في الموقع محلياً وعشوائياً («R-20260906-4821»)
      // فلا يعرّف شيئاً، ووجوده كان يطمس ما يميّز السند فعلاً — الطرف والتاريخ.
      // سندان لنفس الطرف في اليوم نفسه يفترقان بلاحقة `variantName` كما في
      // كشف الحساب تماماً، ولا يُستبدل ملف موجود أبداً.
      base = `${spec.label} - ${party} - ${date}`;
      break;
    case "purchase_invoice":
      // المورد اختياري: «فاتورة مشتريات - رقم 12 - 2026-08-31» عند غيابه.
      base = party
        ? `${spec.label} - ${party} - رقم ${number} - ${date}`
        : `${spec.label} - رقم ${number} - ${date}`;
      break;
    case "account_statement":
      base = `${spec.label} - ${party} - ${date}`;
      break;
    case "other_report":
      base = `${title || spec.label} - ${date}`;
      break;
    case "price_list":
      // اصطلاح النشرة الخاص (شرطات بلا فراغات + رمز العملة) المعتمد منذ PR #121
      // ويعرفه الزبائن على ملفاتهم. والعملة تفرّق نشرتَي اليوم الواحد (دولار/ليرة)
      // اللتين كانتا تتصادمان على اسم واحد فتُحفظ الثانية بلاحقة «(1)».
      base = ["نشرة-الأسعار", currency, date].filter(Boolean).join("-");
      break;
    default:
      // stock_report / receivables_report: التاريخ وحده
      base = `${spec.label} - ${date}`;
      break;
  }

  return { name: `${base}.pdf`, date, folder: spec.folder };
}

/**
 * اسم بديل عند وجود ملف بالاسم نفسه ومحتوى مختلف.
 * لا نستبدل ملفاً موجوداً أبداً — نضيف لاحقة مرقّمة.
 */
export function variantName(name, index) {
  const base = name.replace(/\.pdf$/i, "");
  return `${base} (${index}).pdf`;
}
