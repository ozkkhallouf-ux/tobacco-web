// ============================================================================
// أرشفة المستندات (Google Drive) — منطق نقي مشترك بين دالة Edge
// `document-archive-notify` وفحوصها على Node. بلا شبكة ولا أسرار ولا Deno.
//
// يتطلب تحميل ./telegram-format.js قبله (يضع globalThis.ozkTelegramFormat).
//
// قواعد ثابتة:
//   * الوجهة الوحيدة لأي إشعار هي محادثة المالك من bot_config — لا يُقرأ أي chat_id
//     من الطلب (validateNotifyFields يرفض الحقل صراحةً).
//   * رابط Drive يُقبل فقط بصيغة رابط العرض الخاص (drive.google.com/file/d/<id>/view)
//     ولا يُقبل أي رابط مشاركة عام أو رابط تنزيل مباشر.
//   * الوصف نص عادي بلا parse_mode، فلا حقن تنسيق.
// ============================================================================

export const DOC_TYPES = Object.freeze({
  wholesale_invoice: { label: "فاتورة جملة", icon: "🧾" },
  receipt: { label: "سند قبض", icon: "💵" },
});

// حد تيليغرام لوصف المرفق 1024 محرفاً؛ هامش للأمان.
export const CAPTION_MAX = 1000;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const JOB_ID_RE = /^[0-9a-f]{32}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DRIVE_VIEW_RE = /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,200}\/view(\?usp=drivesdk)?$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const FORBIDDEN_FIELDS = ["chat_id", "chatId", "to", "recipient", "phone"];

function fmt() {
  const api = globalThis.ozkTelegramFormat;
  if (!api) throw new Error("telegram-format غير محمَّل");
  return api;
}

// مقارنة بزمن ثابت لسرّ الطلب (لا تُسرّب طول التطابق).
export function timingSafeEqualText(a, b) {
  const x = new TextEncoder().encode(String(a ?? ""));
  const y = new TextEncoder().encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && x.length > 0;
}

export function isDriveViewLink(value) {
  return DRIVE_VIEW_RE.test(String(value ?? ""));
}

// ملف PDF كامل: يبدأ بـ«%PDF-» وينتهي بعلامة «%%EOF» ضمن آخر 1024 بايت (المعيار
// يسمح بفراغات بعدها). ملف مقطوع أثناء النقل أو الكتابة يفقد العلامة فيُرفض قبل الإرسال.
const PDF_EOF = [0x25, 0x25, 0x45, 0x4f, 0x46];
export function isPdfBytes(bytes) {
  if (!(bytes && bytes.length >= 10
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d)) return false;
  for (let i = bytes.length - PDF_EOF.length; i >= Math.max(5, bytes.length - 1024); i--) {
    if (PDF_EOF.every((b, j) => bytes[i + j] === b)) return true;
  }
  return false;
}

const text = (value) => String(value ?? "").trim();
const optionalNumber = (value) => (value === "" || value === null || value === undefined ? null : Number(value));

// قواعد الحقول بالترتيب: أول قاعدة فاشلة تحدد رمز الخطأ.
const NOTIFY_RULES = [
  ["job_id", (v) => JOB_ID_RE.test(v.job_id)],
  ["doc_type", (v) => Boolean(DOC_TYPES[v.doc_type])],
  ["source_guid", (v) => GUID_RE.test(v.source_guid)],
  ["doc_number", (v) => v.doc_number.length > 0 && v.doc_number.length <= 40],
  ["doc_date", (v) => DATE_RE.test(v.doc_date)],
  ["version", (v) => Number.isInteger(v.version) && v.version >= 1 && v.version <= 1000],
  ["version_hash", (v) => HASH_RE.test(v.version_hash)],
  ["amount", (v) => v.amount === null || Number.isFinite(v.amount)],
  ["drive_link", (v) => isDriveViewLink(v.drive_link)],
  ["drive_file_id", (v) => /^[A-Za-z0-9_-]{10,200}$/.test(v.drive_file_id) && v.drive_link.includes(`/d/${v.drive_file_id}/`)],
  ["customer_guid", (v) => !v.customer_guid || GUID_RE.test(v.customer_guid)],
];

// يتحقق من حقول طلب الإشعار ويعيد كائناً نظيفاً، أو { error } برمز ثابت.
export function validateNotifyFields(input) {
  const f = input || {};
  if (FORBIDDEN_FIELDS.some((key) => Object.prototype.hasOwnProperty.call(f, key))) return { error: "recipient_not_allowed" };
  const value = {
    job_id: text(f.job_id),
    doc_type: text(f.doc_type),
    source_guid: text(f.source_guid).toLowerCase(),
    doc_number: text(f.doc_number),
    doc_date: text(f.doc_date),
    customer_guid: text(f.customer_guid).toLowerCase() || null,
    customer_name: fmt().clean(f.customer_name ?? "", 120),
    amount: optionalNumber(f.amount),
    currency: fmt().clean(f.currency ?? "", 8).toUpperCase(),
    version: Number(f.version),
    version_hash: text(f.version_hash),
    drive_link: text(f.drive_link),
    drive_file_id: text(f.drive_file_id),
  };
  const failed = NOTIFY_RULES.find(([, ok]) => !ok(value));
  return failed ? { error: failed[0] } : { value };
}

// وصف المستند في تيليغرام: كل الحقول المطلوبة في نص عادي ≤ CAPTION_MAX.
// إن تجاوز (لا يحدث بأسماء مقصوصة عند 120 محرفاً، لكنه مضمون) يُرسل وصف مختصر
// مع المستند ثم رسالة ثانية مرتبطة بالتفاصيل كاملة.
export function buildNotifyCaption(v) {
  const t = fmt();
  const type = DOC_TYPES[v.doc_type];
  const versionText = v.version > 1 ? ` (نسخة معدّلة رقم ${t.num(v.version, 0)})` : "";
  const amount = v.amount === null || v.amount === undefined
    ? "—"
    : t.money(v.amount, v.currency || "$", 2);
  const lines = [
    t.line(`${type.icon} ${type.label} — أرشفة ناجحة`),
    t.field("الزبون", t.name(v.customer_name, "زبون غير محدد")),
    t.field("رقم المستند", `${t.name(v.doc_number)}${versionText}`),
    t.field("التاريخ", `${t.LRI}${v.doc_date}${t.PDI}`),
    t.field("المبلغ", amount),
    t.field("حالة الأرشفة", "✅ محفوظ في Google Drive (خاص)"),
    t.line("الرابط الخاص (يفتح بحساب المالك فقط):"),
    v.drive_link,
  ];
  const full = lines.join("\n");
  if (full.length <= CAPTION_MAX) return { caption: full, followUp: null };
  const short = [lines[0], lines[2], lines[5]].join("\n").slice(0, CAPTION_MAX);
  return { caption: short, followUp: full.slice(0, 3900) };
}

// صف document_archive_items الذي تسجّله الدالة بعد الإرسال.
export function itemFromNotify(v, messageId, host) {
  return {
    job_id: v.job_id,
    doc_type: v.doc_type,
    source_guid: v.source_guid,
    doc_number: v.doc_number,
    doc_date: v.doc_date,
    customer_guid: v.customer_guid,
    customer_name: v.customer_name,
    amount: v.amount,
    currency: v.currency,
    version: v.version,
    version_hash: v.version_hash,
    status: "notified",
    drive_file_id: v.drive_file_id,
    drive_web_link: v.drive_link,
    telegram_message_id: messageId,
    host: host || "",
  };
}
