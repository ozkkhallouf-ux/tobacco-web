"use strict";
// أسماء مجلدات Google Drive وملفاته. كل مجلد يُعرَّف بمفتاح ثابت في appProperties
// (ozkFolderKey) لا باسمه: إعادة تسمية زبون في الأمين لا تشطر أرشيفه، وزبونان
// بالاسم نفسه لا يختلطان (المعرّف الداخلي في المفتاح وفي الاسم الظاهر).

const ROOT_FOLDER_NAME = "OZK Tobacco Archive";

const DOC_TYPES = Object.freeze({
  wholesale_invoice: { folder: "فواتير مبيعات الجملة", label: "فاتورة جملة", numberLabel: "فاتورة رقم" },
  receipt: { folder: "سندات القبض", label: "سند قبض", numberLabel: "سند قبض رقم" },
});

// محارف ممنوعة في أسماء الملفات على Windows/Drive، ومحارف التحكم والاتجاه.
const UNSAFE_RE = /[\\/:*?"<>|\u0000-\u001f\u007f؜‎‏‪-‮⁦-⁩]/g;

function safeSegment(value, max = 80) {
  // قصّ مبكر: يحدّ كلفة التعابير أدناه مهما طال النص القادم من الأمين.
  const flat = String(value == null ? "" : value).slice(0, max * 4).replace(UNSAFE_RE, " ").replace(/\s+/g, " ").trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return Array.from(flat).slice(0, max).join("").trim();
}

function shortGuid(guid) {
  const g = String(guid || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return g.length >= 8 ? g.slice(0, 8) : "";
}

function docTypeInfo(docType) {
  const info = DOC_TYPES[docType];
  if (!info) throw new Error(`نوع مستند غير مدعوم: ${docType}`);
  return info;
}

function customerFolderName(name, guid) {
  const shown = safeSegment(name) || "زبون غير محدد";
  return `${shown} [${shortGuid(guid) || "بلا-معرف"}]`;
}

// المسار من الجذر: الجذر ← نوع المستند ← السنة ← الشهر ← الزبون.
function folderPlan(job) {
  const info = docTypeInfo(job.docType);
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(job.date || ""));
  if (!m) throw new Error(`تاريخ مستند غير صالح: ${job.date}`);
  const [, year, month] = m;
  return [
    { key: "root", name: ROOT_FOLDER_NAME },
    { key: `type:${job.docType}`, name: info.folder },
    { key: `year:${job.docType}:${year}`, name: year },
    { key: `month:${job.docType}:${year}-${month}`, name: month },
    {
      key: `customer:${job.docType}:${year}-${month}:${String(job.customerGuid || "none").toLowerCase()}`,
      name: customerFolderName(job.customerName, job.customerGuid),
    },
  ];
}

// «2026-10-31» ⇒ «31-10-2026» (التاريخ كما يقرؤه المالك). تاريخ غير صالح يُرفض كما في folderPlan.
function displayDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) throw new Error(`تاريخ مستند غير صالح: ${date}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// «اسم الزبون - فاتورة رقم 1151 - 31-10-2026.pdf». الاسم من الفاتورة نفسها (customerName من
// الأمين)، منظَّفاً من محارف Windows/Drive الممنوعة ومحارف الاتجاه ومقصوصاً عند 80 محرفاً.
// النسخة المعدّلة V2 فما فوق تحمل لاحقة « - V2» كي لا يحمل ملفان في المجلد نفسه الاسم نفسه.
// الاسم للعرض وحده: الهوية ومنع التكرار بـappProperties.ozkJobId، لا بالاسم.
function fileName(job) {
  const info = docTypeInfo(job.docType);
  const customer = safeSegment(job.customerName) || "زبون غير محدد";
  const number = safeSegment(job.number, 30) || "بلا-رقم";
  const version = Number(job.version) || 1;
  return `${customer} - ${info.numberLabel} ${number} - ${displayDate(job.date)}${version > 1 ? ` - V${version}` : ""}.pdf`;
}

module.exports = { ROOT_FOLDER_NAME, DOC_TYPES, safeSegment, shortGuid, customerFolderName, folderPlan, displayDate, fileName };
