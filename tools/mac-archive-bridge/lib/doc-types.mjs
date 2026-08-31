// خريطة أنواع المستندات -> مجلد iCloud + قالب الاسم.
//
// هذه هي **السلطة الوحيدة** على وجهة الحفظ: الموقع يرسل `docType` فقط ولا
// يرسل مساراً ولا اسم ملف إطلاقاً. أي نوع خارج هذه الخريطة يُرفض بـ400.

/** @typedef {{folder:string, label:string, needsParty:boolean, needsNumber:boolean}} DocTypeSpec */

/** @type {Record<string, DocTypeSpec>} */
export const DOC_TYPES = {
  invoice: { folder: "فواتير الزبائن", label: "فاتورة", needsParty: true, needsNumber: true },
  // المرتجع مستند زبون كامل فيسكن مع فواتير الزبائن، لكنه **نوع مستقل** لا
  // يُخلط مع `invoice` داخلياً: عنوانه «فاتورة مرتجع» يميّزه في الأرشيف عن بيع
  // حقيقي، ويبقى قابلاً لتغيير وجهته أو قواعده لاحقاً بلا مساس بمسار البيع.
  return_invoice: { folder: "فواتير الزبائن", label: "فاتورة مرتجع", needsParty: true, needsNumber: true },
  receipt: { folder: "سندات قبض ودفع", label: "سند قبض", needsParty: true, needsNumber: true },
  payment: { folder: "سندات قبض ودفع", label: "سند دفع", needsParty: true, needsNumber: true },
  price_list: { folder: "نشرات أسعار", label: "نشرة أسعار", needsParty: false, needsNumber: false },
  stock_report: { folder: "تقرير المخزون", label: "تقرير المخزون", needsParty: false, needsNumber: false },
  receivables_report: { folder: "تقرير الذمم", label: "تقرير الذمم", needsParty: false, needsNumber: false },
  account_statement: { folder: "كشف حسابات", label: "كشف حساب", needsParty: true, needsNumber: false },
  purchase_invoice: { folder: "فواتير المشتريات", label: "فاتورة مشتريات", needsParty: false, needsNumber: true },
  other_report: { folder: "تقارير مختلفة", label: "تقرير", needsParty: false, needsNumber: false }
};

export const DOC_TYPE_NAMES = Object.keys(DOC_TYPES);

/** المجلدات المطلوب وجودها فعلياً داخل iCloud Drive (بلا تكرار). */
export const REQUIRED_FOLDERS = [...new Set(DOC_TYPE_NAMES.map((k) => DOC_TYPES[k].folder))];

export function isKnownDocType(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DOC_TYPES, value);
}
