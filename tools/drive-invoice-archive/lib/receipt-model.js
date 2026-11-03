"use strict";
// نموذج سند القبض للأرشيف: صفوف receipts-query.sql (سطر لكل مبلغ) ← مستند لكل زبون داخل السند.
//
// قرار المالك (2026-11-03): كل زبون في سند القبض مستند مستقل عن غيره. هوية المستند
// (sourceGuid) معرّف ثابت مشتق من (معرّف السند في الأمين، حساب الزبون) بصيغة GUID، لأن
// جدول الأرشيف فريد على (doc_type, source_guid, version): سند فيه ثلاثة زبائن = ثلاثة مستندات.
// الاشتقاق ثابت عبر التعديل: تعديل مبلغ الزبون ⇒ V2 للمستند نفسه، لا مستند جديد.
//
// القيم كما خزّنها الأمين: en000.Credit بعملة الأساس (الدولار)، والمبلغ بعملة السطر =
// Credit ÷ CurrencyVal (نفس قاعدة tools/push-daily-movement.ps1).

const crypto = require("crypto");
const { canonical, sha256 } = require("./fingerprint");

const DOC_TYPE = "receipt";
const RECEIPT_HASH_SCHEMA = 1;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const lower = (v) => String(v == null ? "" : v).trim().toLowerCase();
const text = (v) => String(v == null ? "" : v).trim();
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isGuid(v) {
  return GUID_RE.test(lower(v)) && lower(v) !== "00000000-0000-0000-0000-000000000000";
}

// UUID بنمط الإصدار 5 من sha256 (لا SHA-1): ثابت لنفس (السند، الحساب)، ولا يصطدم بمعرّف أمين.
function receiptDocGuid(receiptGuid, accountGuid) {
  const h = crypto.createHash("sha256").update(`ozk-receipt|${lower(receiptGuid)}|${lower(accountGuid)}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

function lineOf(r) {
  return {
    lineGuid: lower(r.line_guid),
    number: num(r.line_number),
    amount: num(r.amount),
    nativeAmount: r.native_amount === null || r.native_amount === undefined ? null : num(r.native_amount),
    currencyVal: num(r.currency_val),
    currencyIso: text(r.currency_iso).toUpperCase(),
    cashName: text(r.cash_name),
    notes: text(r.line_notes),
  };
}

// صفوف صفحة واحدة ← سندات: { receiptGuid, header, docs: [ { ...مستند الزبون } ] }.
// سند بلا سطر قبض على زبون (حساب فارغ) يبقى بلا مستندات ولا يُؤرشف.
function groupReceipts(rows) {
  const byReceipt = new Map();
  for (const r of rows || []) {
    const receiptGuid = lower(r.receipt_guid);
    if (!isGuid(receiptGuid)) continue;
    let rec = byReceipt.get(receiptGuid);
    if (!rec) {
      rec = {
        receiptGuid,
        row: r,
        header: {
          receiptGuid,
          number: text(r.receipt_number),
          date: text(r.receipt_date),
          notes: text(r.receipt_notes),
          entryGuid: isGuid(r.entry_guid) ? lower(r.entry_guid) : "",
          entryLinks: num(r.entry_links),
          isPosted: num(r.is_posted) === 1,
          changedAt: text(r.changed_at),
          createdAt: text(r.created_at),
          secondsSinceChange: num(r.seconds_since_change),
        },
        accounts: new Map(),
      };
      byReceipt.set(receiptGuid, rec);
    }
    const account = lower(r.account_guid);
    if (!isGuid(account)) continue;
    let acc = rec.accounts.get(account);
    if (!acc) {
      acc = { accountGuid: account, customerGuid: isGuid(r.customer_guid) ? lower(r.customer_guid) : "", customer: text(r.customer_name), lines: [] };
      rec.accounts.set(account, acc);
    }
    acc.lines.push(lineOf(r));
  }
  return [...byReceipt.values()].map((rec) => ({
    receiptGuid: rec.receiptGuid,
    row: rec.row,
    header: rec.header,
    docs: [...rec.accounts.values()].map((acc) => buildDoc(rec.header, acc)),
  }));
}

// المبلغ المعروض: بعملة الأسطر إن اتحدت (مبلغ سند بالليرة يُعرض بالليرة كما في الأمين)،
// وإلا بالدولار (عملة الأساس). الدولار مرجع دائم: الرصيد بالدولار دائماً.
function buildDoc(header, acc) {
  const lines = acc.lines.slice().sort((a, b) => a.number - b.number || (a.lineGuid < b.lineGuid ? -1 : 1));
  const amountUsd = lines.reduce((s, l) => s + l.amount, 0);
  const isos = [...new Set(lines.map((l) => l.currencyIso || ""))];
  const single = isos.length === 1 && lines.every((l) => l.nativeAmount !== null);
  const currencyIso = single ? isos[0] : "USD";
  const amount = single ? lines.reduce((s, l) => s + l.nativeAmount, 0) : amountUsd;
  return {
    guid: receiptDocGuid(header.receiptGuid, acc.accountGuid),
    docType: DOC_TYPE,
    receiptGuid: header.receiptGuid,
    entryGuid: header.entryGuid,
    accountGuid: acc.accountGuid,
    customerGuid: acc.customerGuid,
    customer: acc.customer,
    number: header.number,
    date: header.date,
    notes: header.notes,
    isPosted: header.isPosted,
    lines,
    amount: Math.round(amount * 1000) / 1000,
    amountUsd: Math.round(amountUsd * 1000) / 1000,
    currencyIso: currencyIso || "USD",
    balance: null, // { previous, current } بالدولار من receipt-balance-query.sql، أو null
  };
}

// البصمة: ما يُطبع ويؤثر على الذمة كما خُزّن — الرقم والتاريخ والبيان والقيد والحساب والزبون
// والأسطر بأرقامها ومبالغها وعملتها وصندوقها وبيانها. خارجها عمداً: اسم الزبون (إعادة تسمية
// بطاقة ليست تعديلاً)، معرّفات الأسطر (قد يعيد الأمين إنشاءها عند الحفظ)، والرصيد (يتغيّر
// مع كل حركة لاحقة).
function receiptVersionHash(doc) {
  const content = {
    schema: RECEIPT_HASH_SCHEMA,
    receiptGuid: doc.receiptGuid,
    accountGuid: doc.accountGuid,
    customerGuid: doc.customerGuid,
    entryGuid: doc.entryGuid,
    number: doc.number,
    date: doc.date,
    notes: doc.notes,
    lines: doc.lines.map((l) => ({ number: l.number, amount: l.amount, currencyVal: l.currencyVal, currencyIso: l.currencyIso, cashName: l.cashName, notes: l.notes })),
  };
  return sha256(JSON.stringify(canonical(content)));
}

// تلميح رخيص لتغيّر السند كاملاً (كل صفوفه بلا الطوابع الزمنية المتحركة).
function receiptHint(rows) {
  const stable = (rows || []).map((r) => {
    const { changed_at, seconds_since_change, ...rest } = r; // eslint-disable-line no-unused-vars
    return rest;
  });
  return sha256(JSON.stringify(canonical(stable)));
}

module.exports = { DOC_TYPE, RECEIPT_HASH_SCHEMA, receiptDocGuid, groupReceipts, buildDoc, receiptVersionHash, receiptHint, isGuid };
