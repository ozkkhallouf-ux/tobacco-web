"use strict";
// بصمة محتوى المستند: SHA-256 على JSON قانوني (مفاتيح مرتبة، أرقام مقرّبة 6 خانات)
// لحقول الفاتورة التي تظهر على الورقة — بلا طوابع زمنية ولا رصيد الزبون (يتغيّر مع كل
// دفعة لاحقة فيولّد «نسخة» زائفة). نفس البصمة = نفس المستند ⇒ لا ملف ثانٍ.
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

function invoiceContent(inv) {
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

function invoiceVersionHash(inv) {
  return sha256(JSON.stringify(canonical(invoiceContent(inv))));
}

function jobIdFor(docType, sourceGuid, versionHash, version) {
  return sha256(`${docType}|${String(sourceGuid).toLowerCase()}|${versionHash}|${version}`).slice(0, 32);
}

module.exports = { canonical, sha256, invoiceContent, invoiceVersionHash, jobIdFor };
