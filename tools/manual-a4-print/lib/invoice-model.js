"use strict";
// تحويل صفوف الأمين إلى كائن الفاتورة الذي يفهمه القالب الرسمي
// tools/ameen-autoprint/invoice-html.js (buildInvoiceHtml) — نفس الحقول تماماً.

// GUID مبيعات المركز (الكاشير 80mm) — مرفوض دائماً مهما كان الإعداد.
const CASHIER_RETAIL_TYPE_GUID = "cc1097b1-662d-4d80-8e4e-3b493249591c";
// أنواع الجملة المعتمدة (نفس قائمة watcher.js وozk-print-bridge.ps1).
const DEFAULT_ALLOWED_TYPE_GUIDS = Object.freeze([
  "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4",
  "4a827bee-6ae1-4474-802b-970068872fcc",
]);

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normGuid(g) {
  return String(g || "").trim().toLowerCase();
}

function isGuid(g) {
  return GUID_RE.test(normGuid(g));
}

function allowedTypes(config) {
  const list = (config && Array.isArray(config.allowedTypeGuids) && config.allowedTypeGuids.length)
    ? config.allowedTypeGuids : DEFAULT_ALLOWED_TYPE_GUIDS;
  return list.map(normGuid).filter((g) => g && g !== CASHIER_RETAIL_TYPE_GUID);
}

// سبب عدم الطباعة بالعربية، أو "" إن كانت قابلة للطباعة.
function printBlockReason(typeGuid, config) {
  const g = normGuid(typeGuid);
  if (g === CASHIER_RETAIL_TYPE_GUID) return "فاتورة مبيعات المركز — تُطبع على طابعة الكاشير 80mm فقط";
  if (!allowedTypes(config).includes(g)) return "نوع فاتورة غير مدعوم في طباعة A4";
  return "";
}

function currencyVal(row) {
  const cv = Number(row.currency_val);
  return cv > 0 ? cv : 1;
}

function headerFromRow(row, config) {
  const cv = currencyVal(row);
  const block = printBlockReason(row.type_guid, config);
  return {
    guid: normGuid(row.invoice_guid),
    number: Number(row.invoice_number),
    date: String(row.invoice_date || ""),
    typeGuid: normGuid(row.type_guid),
    typeName: String(row.type_name || "").trim() || "نوع غير معروف",
    billType: Number(row.bill_type),
    isPosted: Number(row.is_posted) === 1,
    customer: String(row.customer_name || "").trim(),
    total: Number(row.total) / cv,
    discount: Number(row.discount) / cv,
    firstPay: Number(row.first_pay) / cv,
    extra: round2(Number(row.total_extra) || 0) / cv,
    currencyVal: cv,
    currencyIso: String(row.currency_iso || "").trim().toUpperCase(),
    lineCount: Number(row.line_count) || 0,
    printable: block === "",
    blockReason: block,
  };
}

// «تدوير» الإجمالي بخانتين كبقية مبالغ الرأس: استعلام البحث يقرؤه decimal(18,2)، أما
// استعلام عامل الأرشفة فيقرؤه decimal(28,6) لبصمته، فلا يختلف المطبوع بين المسارين.
// التقريب بعيداً عن الصفر كـCAST في SQL Server؛ الهامش 1e-7 سنتاً يصحّح تمثيل الفاصلة
// العائمة (1.005 × 100 = 100.4999…) ولا يمسّ قيمة بستّ خانات كما يقرؤها الاستعلام.
function round2(n) {
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7) / 100;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// السطر: Qty بالوحدة الأولى دائماً؛ المعروض بوحدة الإدخال bi.Unity.
// معامل مفقود أو صفري ⇒ لا قسمة، ويُعرض بالوحدة الأولى (لا تخمين).
function lineFromRow(row) {
  const unit = Number(row.input_unit);
  const qty = Number(row.qty) || 0;
  const unit1 = String(row.unit1_name || "").trim();
  let name = unit1;
  let shown = qty;
  if (unit === 2 && Number(row.unit2_fact) > 0) {
    name = String(row.unit2_name || "").trim() || unit1;
    shown = qty / Number(row.unit2_fact);
  } else if (unit === 3 && Number(row.unit3_fact) > 0) {
    name = String(row.unit3_name || "").trim() || unit1;
    shown = qty / Number(row.unit3_fact);
  }
  return { name: String(row.item_name || "").trim(), unit: name || "وحدة", qty: round3(shown) };
}

function buildInvoice(header, lineRows, balance) {
  const items = (lineRows || []).map(lineFromRow).filter((it) => it.name);
  const inv = { ...header, items };
  inv.customerBalanceFound = balance !== null && balance !== undefined && Number.isFinite(Number(balance));
  inv.customerBalance = inv.customerBalanceFound ? Number(balance) / header.currencyVal : null;
  return inv;
}

module.exports = {
  CASHIER_RETAIL_TYPE_GUID,
  DEFAULT_ALLOWED_TYPE_GUIDS,
  normGuid,
  isGuid,
  allowedTypes,
  printBlockReason,
  headerFromRow,
  lineFromRow,
  buildInvoice,
};
