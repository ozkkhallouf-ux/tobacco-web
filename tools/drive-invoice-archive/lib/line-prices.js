"use strict";
// سعر الوحدة وإجمالي السطر لنسخة الأرشيف — من صفوف الأمين نفسها، بلا تخمين.
//
// القاعدة المعتمدة (#276، مثبتة على AmnDb002 بمطابقة 200/200 فاتورة):
//   bi000.Qty بالوحدة الأولى دائماً، وbi000.Price سعر وحدة إدخال السطر (bi000.Unity)،
//   فقيمة السطر = Price × Qty ÷ معامل(Unity)، والمعامل 1 أو mt000.Unit2Fact أو Unit3Fact.
//   المبالغ بعملة الأساس كإجمالي الرأس، فتُقسم على CurrencyVal كما يفعل headerFromRow.
//
// لا تُعرض الأسعار إلا إذا طابق مجموع الأسطر المعروضة إجمالي الفاتورة (bu000.Total،
// مقرَّباً لخانتين في الاستعلام) بفرق لا يتجاوز TOLERANCE بعملة الأساس. وإلا يُرجع سبباً
// قصيراً بلا مبالغ ولا أسماء، ويُطبع القالب كما كان (الكمية وحدها).

const model = require("../../manual-a4-print/lib/invoice-model");

// نصف خانة التقريب الثانية مع هامش فاصلة عائمة.
const TOLERANCE = 0.005 + 1e-9;

function factorOf(row) {
  const unit = Number(row.input_unit);
  if (unit === 1) return 1;
  if (unit === 2) return Number(row.unit2_fact) > 0 ? Number(row.unit2_fact) : null;
  if (unit === 3) return Number(row.unit3_fact) > 0 ? Number(row.unit3_fact) : null;
  return null;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// inv: ناتج model.buildInvoice(header, lines, …). يُرجع { ok, inv, reason }:
// ok=true ⇒ inv نسخة عناصرها تحمل unitPrice وlineTotal بعملة الفاتورة.
function priceInvoiceItems(inv, lineRows) {
  const rows = (lineRows || []).filter((r) => model.lineFromRow(r).name);
  if (!rows.length || rows.length !== (inv.items || []).length) return { ok: false, inv, reason: "no_lines" };
  const cv = Number(inv.currencyVal) > 0 ? Number(inv.currencyVal) : 1;
  let sumBase = 0;
  const priced = [];
  for (let i = 0; i < rows.length; i++) {
    const factor = factorOf(rows[i]);
    if (factor === null) return { ok: false, inv, reason: "unit_factor_missing" };
    const price = Number(rows[i].price);
    const qty = Number(rows[i].qty);
    if (!Number.isFinite(price) || !Number.isFinite(qty)) return { ok: false, inv, reason: "invalid_number" };
    const lineBase = (price * qty) / factor;
    sumBase += lineBase;
    priced.push({ ...inv.items[i], unitPrice: round6(price / cv), lineTotal: round6(lineBase / cv) });
  }
  const totalBase = Number(inv.total) * cv;
  if (!Number.isFinite(totalBase) || Math.abs(sumBase - totalBase) > TOLERANCE) return { ok: false, inv, reason: "total_mismatch" };
  return { ok: true, inv: { ...inv, items: priced }, reason: "" };
}

module.exports = { priceInvoiceItems, TOLERANCE };
