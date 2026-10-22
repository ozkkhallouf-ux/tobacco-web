"use strict";
// حارس القراءة فقط: الضمان الصادق الوحيد هنا على مستوى الأمر لا الحساب —
// حساب الاتصال قد يملك صلاحية كتابة (tobacco_sync_service يملك INSERT/UPDATE
// على جدول الأسعار)، فيُرفض قبل الإرسال أي نص ليس استعلام SELECT صافياً.

const FORBIDDEN = /\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|backup|restore|dbcc|into|openrowset|opendatasource|openquery|sp_\w+|xp_\w+|waitfor|shutdown|kill|use)\b/i;

function stripSql(text) {
  return String(text || "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/N?'(?:[^']|'')*'/g, "''");
}

function assertReadOnlySql(text) {
  const body = stripSql(text).trim();
  if (!body) throw new Error("sql-guard: استعلام فارغ");
  if (!/^(select|;?\s*with)\b/i.test(body)) {
    throw new Error("sql-guard: الاستعلام لا يبدأ بـSELECT أو WITH — مرفوض");
  }
  const hit = body.match(FORBIDDEN);
  if (hit) throw new Error(`sql-guard: كلمة غير مسموحة في استعلام قراءة: ${hit[0]}`);
  // عبارة واحدة فقط: لا فاصلة منقوطة إلا في أوله (نمط ;with) أو آخره.
  const inner = body.replace(/^;/, "").replace(/;\s*$/, "");
  if (inner.includes(";")) throw new Error("sql-guard: أكثر من عبارة SQL — مرفوض");
  return text;
}

module.exports = { assertReadOnlySql, stripSql };
