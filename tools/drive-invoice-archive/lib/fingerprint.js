"use strict";
// بصمة محتوى المستند: SHA-256 على JSON قانوني (مفاتيح مرتبة، أرقام مقرّبة 6 خانات).
// المخطط 2 (الحالي): الفاتورة كما خُزّنت في الأمين — رأسها (الزبون والحساب والمستودع
// والعملة والإجماليات والحسومات والإضافات والمدفوع وطريقة الدفع) وكل أسطرها بمعرّفاتها
// (المادة والوحدة والكميات الثلاث والسعر والحسم والإضافة والهدية والضريبة) — لا ما
// يُطبع وحده: تعديل سعر سطرين يحفظ الإجمالي يبقى تعديلاً حقيقياً.
// خارج البصمة عمداً: الطوابع الزمنية، رصيد الزبون (يتغيّر مع كل دفعة لاحقة)، وأسماء
// العرض من البطاقات (اسم الزبون في cu000 واسم المادة ووحداتها في mt000) — إعادة تسمية
// بطاقة ليست تعديلاً للفاتورة. اسم الزبون المحفوظ على رأس الفاتورة (Cust_Name) داخلها.
// نفس البصمة = نفس المستند ⇒ لا ملف ثانٍ.
// معرّف المهمة = أول 32 خانة من sha256(نوع|GUID|البصمة|رقم النسخة): ثابت عبر إعادة
// المعالجة، ورجوع المحتوى لنسخة سابقة (A ← B ← A) نسخة ثالثة لا تصادم الأولى.

const crypto = require("crypto");

function canonical(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("رقم غير منتهٍ في البصمة");
    return Math.round(value * 1e6) / 1e6;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
    return out;
  }
  return value;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const HASH_SCHEMA = 2;

function lowerGuid(v) {
  return String(v || "").toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// المخطط 1: حقول الورقة وحدها (أسماء العرض، والأسطر بالاسم والوحدة والكمية فقط).
// يبقى لمطابقة مهام قديمة حُسبت به قبل الترقية (rebaseLegacy في archiver.js).
function legacyInvoiceContent(inv) {
  return {
    guid: String(inv.guid).toLowerCase(),
    number: inv.number,
    date: inv.date,
    typeGuid: String(inv.typeGuid || "").toLowerCase(),
    customerGuid: String(inv.customerGuid || "").toLowerCase(),
    customer: inv.customer,
    total: inv.total,
    discount: inv.discount,
    firstPay: inv.firstPay,
    currencyIso: inv.currencyIso,
    currencyVal: inv.currencyVal,
    items: (inv.items || []).map((it) => ({ name: it.name, unit: it.unit, qty: it.qty })),
  };
}

// رأس الفاتورة من صف changed-invoices-query.sql (قيم الأمين الخام، بلا قسمة على سعر الصرف).
function sourceHeader(row) {
  return {
    guid: lowerGuid(row.invoice_guid),
    number: num(row.invoice_number),
    date: String(row.invoice_date || ""),
    typeGuid: lowerGuid(row.type_guid),
    customerGuid: lowerGuid(row.customer_guid),
    customerAccountGuid: lowerGuid(row.customer_account_guid),
    billCustomerName: String(row.bill_customer_name || "").trim(),
    storeGuid: lowerGuid(row.store_guid),
    currencyIso: String(row.currency_iso || "").trim().toUpperCase(),
    currencyVal: num(row.currency_val),
    payType: num(row.pay_type),
    total: num(row.total),
    totalDisc: num(row.discount),
    totalExtra: num(row.total_extra),
    itemsDisc: num(row.items_disc),
    itemsExtra: num(row.items_extra),
    bonusDisc: num(row.bonus_disc),
    vat: num(row.vat),
    firstPay: num(row.first_pay),
  };
}

// سطر من archive-lines-query.sql بمعرّفاته وقيمه الخام (Qty بالوحدة الأولى كما في bi000).
function sourceLine(r) {
  return {
    lineGuid: lowerGuid(r.line_guid),
    number: num(r.line_number),
    matGuid: lowerGuid(r.mat_guid),
    unity: num(r.input_unit),
    qty: num(r.qty),
    qty2: num(r.qty2),
    qty3: num(r.qty3),
    price: num(r.price),
    discount: num(r.line_discount),
    extra: num(r.line_extra),
    bonusQty: num(r.bonus_qty),
    vat: num(r.line_vat),
    storeGuid: lowerGuid(r.line_store_guid),
    costGuid: lowerGuid(r.cost_guid),
  };
}

// الترتيب برقم السطر ثم معرّفه: بصمة واحدة مهما رجعت الأسطر من SQL.
function invoiceContent(row, lineRows) {
  const lines = (lineRows || []).map(sourceLine)
    .sort((a, b) => a.number - b.number || (a.lineGuid < b.lineGuid ? -1 : a.lineGuid > b.lineGuid ? 1 : 0));
  return { schema: HASH_SCHEMA, header: sourceHeader(row), lines };
}

function hashOf(content) {
  return sha256(JSON.stringify(canonical(content)));
}

function invoiceVersionHash(row, lineRows) {
  return hashOf(invoiceContent(row, lineRows));
}

function legacyVersionHash(inv) {
  return hashOf(legacyInvoiceContent(inv));
}

function jobIdFor(docType, sourceGuid, versionHash, version) {
  return sha256(`${docType}|${String(sourceGuid).toLowerCase()}|${versionHash}|${version}`).slice(0, 32);
}

module.exports = {
  HASH_SCHEMA, canonical, sha256, invoiceContent, invoiceVersionHash, legacyInvoiceContent, legacyVersionHash, jobIdFor,
};
