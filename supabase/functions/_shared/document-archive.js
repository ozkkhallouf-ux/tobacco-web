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

export function isPdfBytes(bytes) {
  return Boolean(bytes && bytes.length >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d);
}

// يتحقق من حقول طلب الإشعار ويعيد كائناً نظيفاً، أو { error } برمز ثابت.
export function validateNotifyFields(input) {
  const f = input || {};
  for (const key of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(f, key)) return { error: "recipient_not_allowed" };
  }
  const jobId = String(f.job_id ?? "").trim();
  if (!JOB_ID_RE.test(jobId)) return { error: "job_id" };
  const docType = String(f.doc_type ?? "").trim();
  if (!DOC_TYPES[docType]) return { error: "doc_type" };
  const sourceGuid = String(f.source_guid ?? "").trim().toLowerCase();
  if (!GUID_RE.test(sourceGuid)) return { error: "source_guid" };
  const docNumber = String(f.doc_number ?? "").trim();
  if (!docNumber || docNumber.length > 40) return { error: "doc_number" };
  const docDate = String(f.doc_date ?? "").trim();
  if (!DATE_RE.test(docDate)) return { error: "doc_date" };
  const version = Number(f.version);
  if (!Number.isInteger(version) || version < 1 || version > 1000) return { error: "version" };
  const versionHash = String(f.version_hash ?? "").trim();
  if (!HASH_RE.test(versionHash)) return { error: "version_hash" };
  const amountRaw = f.amount === "" || f.amount === null || f.amount === undefined ? null : Number(f.amount);
  if (amountRaw !== null && !Number.isFinite(amountRaw)) return { error: "amount" };
  const driveLink = String(f.drive_link ?? "").trim();
  if (!isDriveViewLink(driveLink)) return { error: "drive_link" };
  const driveFileId = String(f.drive_file_id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(driveFileId) || !driveLink.includes(`/d/${driveFileId}/`)) return { error: "drive_file_id" };
  const customerGuidRaw = String(f.customer_guid ?? "").trim().toLowerCase();
  if (customerGuidRaw && !GUID_RE.test(customerGuidRaw)) return { error: "customer_guid" };
  return {
    value: {
      job_id: jobId,
      doc_type: docType,
      source_guid: sourceGuid,
      doc_number: docNumber,
      doc_date: docDate,
      customer_guid: customerGuidRaw || null,
      customer_name: fmt().clean(f.customer_name ?? "", 120),
      amount: amountRaw,
      currency: fmt().clean(f.currency ?? "", 8).toUpperCase(),
      version,
      version_hash: versionHash,
      drive_link: driveLink,
      drive_file_id: driveFileId,
    },
  };
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
