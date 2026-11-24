"use strict";
// ============================================================================
// اكتشاف مخطط سندات القبض في الأمين (AmnDb002) — قراءة فقط، مرة واحدة، يدوياً.
//
// الغرض: تثبيت الأعمدة والعلاقات الفعلية لسند القبض قبل بناء أرشفته (لا تخمين أسماء).
// المعروف المثبت اليوم في المستودع: py000.GUID وpy000.TypeGUID وet000.GUID/Name، وربط
// er000 (ParentType = 4) بين قيد ce000 وسنده py000 (push-customer-movements.ps1).
// المجهول: رقم السند الظاهر في الأمين، تاريخه ووقت إنشائه وتعديله، وهل كل قبض يمر بـpy000.
//
// المخرجات: JSON بأسماء أعمدة وأنواعها وأعداد مجمّعة فقط — لا أسماء زبائن ولا مبالغ ولا
// معرّفات سندات. أسماء أنواع السندات (et000.Name) إعداد للبرنامج وليست بيانات زبائن.
// كل استعلام يمر بالحارس assertReadOnlySql (SELECT/WITH وحدهما). لا كتابة على الأمين.
//
//   node discover-receipts.js [--days 90] [--app <مجلد العامل المثبّت>]
//
// يقرأ سرّ SQL نفسه الذي يستعمله العامل (set-secret.ps1 -Name sql، حساب القراءة لا sa).
// --app: تشغيل من مجلد staging دون نسخ أي ملف إلى العامل المثبّت؛ الوحدات (الحارس،
// الأسرار، mssql) تُحمَّل من ذلك المجلد. بلاه: المجلد الذي فيه هذا الملف.
// ============================================================================

const path = require("path");

const argAt = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : "");
const APP = path.resolve(argAt("--app") || __dirname);
const fromApp = (...p) => require(path.join(APP, ...p));
const { assertReadOnlySql } = fromApp("..", "manual-a4-print", "lib", "sql-guard");
const { readSecret } = fromApp("lib", "secrets");
const { redact } = fromApp("lib", "redact");
const { DEFAULTS } = fromApp("lib", "config");

// الصناديق: شجرة 13 الأموال الجاهزة عدا 135 فروقات الصندوق؛ الزبائن: شجرة 121. القيد
// الافتتاحي ea69ba80. نفس الثوابت المثبتة في push-customer-movements.ps1 (payment-rule).
const CASH_ROOT = "c0dc3c06-b2ac-4e57-beae-19d7da3f514c";
const CASH_DIFF = "ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8";
const CUSTOMER_ROOT = "e30187a7-eccc-4ff8-8a7d-f2df5e660b53";
const OPENING_ENTRY_TYPE = "ea69ba80-662d-4fa4-90ee-4d2e1988a8ea";

const TABLES = ["py000", "et000", "ce000", "en000", "er000", "log000"];

function columnsSql() {
  return `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.DATA_TYPE AS ty
FROM INFORMATION_SCHEMA.COLUMNS c
WHERE c.TABLE_SCHEMA = 'dbo' AND c.TABLE_NAME IN (${TABLES.map((t) => `'${t}'`).join(", ")})
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`;
}

// أسطر القبض بتعريف الدفعة الموحّد: دائن على حساب تحت شجرة الزبائن، سطر عادي، مقابله
// صندوق (أو مقابل صفري وفي القيد نفسه صندوق مدين، والقيد ليس الافتتاحي).
function receiptLinesCte(days) {
  return `WITH cash_tree AS (
  SELECT a.GUID FROM dbo.ac000 a WHERE a.GUID = '${CASH_ROOT}'
  UNION ALL
  SELECT a.GUID FROM dbo.ac000 a JOIN cash_tree t ON a.ParentGUID = t.GUID
),
cash AS (SELECT t.GUID FROM cash_tree t WHERE t.GUID <> '${CASH_DIFF}'),
customer_tree AS (
  SELECT a.GUID FROM dbo.ac000 a WHERE a.GUID = '${CUSTOMER_ROOT}'
  UNION ALL
  SELECT a.GUID FROM dbo.ac000 a JOIN customer_tree t ON a.ParentGUID = t.GUID
),
lines AS (
  SELECT en.GUID AS line_guid, en.ParentGUID AS entry_guid, en.AccountGUID AS acct
  FROM dbo.en000 en
  JOIN customer_tree ct ON ct.GUID = en.AccountGUID
  LEFT JOIN dbo.ce000 ce ON ce.GUID = en.ParentGUID
  WHERE COALESCE(en.Credit, 0) > 0 AND COALESCE(en.Type, 0) = 0
    AND en.Date >= DATEADD(day, -${days}, CAST(GETDATE() AS date))
    AND (
      en.ContraAccGUID IN (SELECT c.GUID FROM cash c)
      OR (COALESCE(en.ContraAccGUID, '00000000-0000-0000-0000-000000000000') = '00000000-0000-0000-0000-000000000000'
          AND ce.GUID IS NOT NULL
          AND COALESCE(ce.TypeGUID, '00000000-0000-0000-0000-000000000000') <> '${OPENING_ENTRY_TYPE}'
          AND EXISTS (SELECT 1 FROM dbo.en000 d WHERE d.ParentGUID = en.ParentGUID AND COALESCE(d.Debit, 0) > 0
                        AND d.AccountGUID IN (SELECT c.GUID FROM cash c)))
    )
)`;
}

// تصنيف كل سطر قبض بربط قيده في er000: سند py000، فاتورة bu000 (دفعة البيع)، بلا ربط، أو مبهم.
function linkKindsSql(days) {
  return `${receiptLinesCte(days)}
SELECT k.kind, COUNT(*) AS line_count, COUNT(DISTINCT l.entry_guid) AS entry_count
FROM lines l
OUTER APPLY (
  SELECT COUNT(*) AS n, MIN(er.ParentType) AS pt FROM dbo.er000 er WHERE er.EntryGUID = l.entry_guid
) r
CROSS APPLY (SELECT CASE WHEN r.n = 0 THEN 'no_link' WHEN r.n > 1 THEN 'ambiguous'
                         WHEN r.pt = 4 THEN 'py000' WHEN r.pt = 2 THEN 'bill'
                         ELSE CONCAT('parent_type_', r.pt) END AS kind) k
GROUP BY k.kind
ORDER BY k.kind`;
}

// أنواع السندات (et000) التي تحمل أسطر قبض، بأعدادها.
function voucherTypesSql(days) {
  return `${receiptLinesCte(days)}
SELECT LOWER(CONVERT(nvarchar(36), et.GUID)) AS type_guid, LTRIM(RTRIM(ISNULL(et.Name, N''))) AS type_name,
       COUNT(DISTINCT py.GUID) AS voucher_count, COUNT(*) AS line_count
FROM lines l
JOIN dbo.er000 er ON er.EntryGUID = l.entry_guid AND er.ParentType = 4
JOIN dbo.py000 py ON py.GUID = er.ParentGUID
LEFT JOIN dbo.et000 et ON et.GUID = py.TypeGUID
GROUP BY et.GUID, et.Name
ORDER BY voucher_count DESC`;
}

// سند واحد بأكثر من زبون؟ (يحدد هل هوية المستند سند كامل أم سند × زبون).
function multiCustomerSql(days) {
  return `${receiptLinesCte(days)}
SELECT x.customers, COUNT(*) AS entry_count
FROM (SELECT l.entry_guid, COUNT(DISTINCT l.acct) AS customers FROM lines l GROUP BY l.entry_guid) x
GROUP BY x.customers
ORDER BY x.customers`;
}

// مقارنة رقم السند برقم القيد، وتوفر أوقات الإنشاء والتعديل — فقط بأعمدة ثبت وجودها أعلاه.
function numberingSql(days, py) {
  const has = (c) => py.has(c);
  const parts = ["COUNT(*) AS vouchers"];
  if (has("Number")) parts.push("SUM(CASE WHEN py.Number = ce.Number THEN 1 ELSE 0 END) AS py_number_eq_ce_number",
    "COUNT(DISTINCT CONCAT(CONVERT(nvarchar(36), py.TypeGUID), ':', py.Number)) AS distinct_type_number");
  if (has("Date")) parts.push("SUM(CASE WHEN CAST(py.Date AS date) = CAST(ce.Date AS date) THEN 1 ELSE 0 END) AS py_date_eq_ce_date");
  for (const c of ["CreateDate", "LastUpdateDate"]) {
    if (has(c)) parts.push(`SUM(CASE WHEN py.${c} IS NOT NULL AND py.${c} > '19810101' THEN 1 ELSE 0 END) AS py_${c.toLowerCase()}_set`);
  }
  if (has("IsPosted")) parts.push("SUM(CASE WHEN ISNULL(py.IsPosted, 0) = 1 THEN 1 ELSE 0 END) AS py_posted");
  if (has("CurrencyGUID")) parts.push("COUNT(DISTINCT py.CurrencyGUID) AS py_currencies");
  return `SELECT ${parts.join(", ")}
FROM dbo.py000 py
JOIN dbo.er000 er ON er.ParentGUID = py.GUID AND er.ParentType = 4
JOIN dbo.ce000 ce ON ce.GUID = er.EntryGUID
WHERE ce.Date >= DATEADD(day, -${days}, CAST(GETDATE() AS date))`;
}

// هل يسجّل log000 السندات؟ (TypeGUID = نوع السند) وما أنواع العمليات.
function logSql(days) {
  return `SELECT l.OperationType AS op, COUNT(*) AS n
FROM dbo.log000 l
WHERE l.LogTime >= DATEADD(day, -${days}, GETDATE())
  AND l.TypeGUID IN (SELECT et.GUID FROM dbo.et000 et)
GROUP BY l.OperationType
ORDER BY l.OperationType`;
}

async function main(argv) {
  const daysArg = argv.includes("--days") ? Number(argv[argv.indexOf("--days") + 1]) : 90;
  const days = Number.isInteger(daysArg) && daysArg > 0 && daysArg <= 400 ? daysArg : 90;
  const cfgFile = process.env.OZK_DRIVE_ARCHIVE_CONFIG || path.join(APP, "config.json");
  let user = {};
  try { user = JSON.parse(require("fs").readFileSync(cfgFile, "utf8").replace(/^﻿/, "")); } catch { /* الافتراضي */ }
  const secretDir = user.secretDir || DEFAULTS.secretDir;
  const conn = readSecret("sql", secretDir);
  if (!conn) throw new Error("سرّ SQL غير محفوظ (set-secret.ps1 -Name sql)");
  const sql = fromApp("node_modules", "mssql");
  const { parseSqlConnStr } = fromApp("..", "manual-a4-print", "server.js");
  const cfg = parseSqlConnStr(conn);
  if (/^sa$/i.test(cfg.user)) throw new Error("مرفوض: حساب sa لا يُستعمل. استعمل حساب القراءة.");
  cfg.options.appName = "OZK-DriveArchive-Discover";
  cfg.requestTimeout = 120_000;
  const pool = await new sql.ConnectionPool(cfg).connect();
  const q = async (text) => (await pool.request().query(assertReadOnlySql(text))).recordset;
  const out = { days, db: null, login: null, columns: {}, errors: {} };
  const step = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out.errors[key] = redact(err && err.message, 200); }
  };
  try {
    const who = await q("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");
    out.db = who[0].db;
    out.login = who[0].login;
    for (const row of await q(columnsSql())) (out.columns[row.t] = out.columns[row.t] || []).push(`${row.c}:${row.ty}`);
    const py = new Set((out.columns.py000 || []).map((c) => c.split(":")[0]));
    await step("receiptLineLinks", () => q(linkKindsSql(days)));
    await step("voucherTypes", () => q(voucherTypesSql(days)));
    await step("customersPerEntry", () => q(multiCustomerSql(days)));
    await step("numbering", async () => (await q(numberingSql(days, py)))[0]);
    await step("log000ForVoucherTypes", () => q(logSql(days)));
  } finally {
    await pool.close().catch(() => {});
  }
  console.log(JSON.stringify(out, null, 1));
}

module.exports = { columnsSql, linkKindsSql, voucherTypesSql, multiCustomerSql, numberingSql, logSql };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(redact(err && err.message || err));
    process.exit(1);
  });
}
