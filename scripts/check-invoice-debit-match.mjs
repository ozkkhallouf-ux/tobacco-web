// ============================================================================
// فحص انحداري: مطابقة فاتورة البيع لقيد مدين عند تصدير PDF لا تخمّن بالمبلغ
// وحده ولا بالتاريخ وحده.
//
// العطل: billGuid صفري في قيود البيع (100% في قياسات الإنتاج). مسار
// gen-movement-doc كان يسقط من (تاريخ+مبلغ) إلى «أي فاتورة بنفس المبلغ» ثم
// «أي فاتورة بنفس اليوم». فاتورتان في يوم واحد، أو قيد افتتاحي/تحويل بجانب
// فاتورة ذلك اليوم، كانا يلصقان أصناف فاتورة أخرى على المستند المسلَّم للزبون.
// invoiceMovement كانت تأخذ آخر قيد مطابق فيطبع رصيد الفاتورة الأخرى.
//
// الإصلاح: المعرّف أولاً، وإلا تاريخ+مبلغ معاً ونتيجة واحدة فقط. بلا تطابق
// فريد يُرفض التصدير (الخطأ القائم) أو يُطبع بلا رصيد قيد.
// الأسماء مصطنعة. الفحص يشغّل الدوال الحقيقية من src/app.js داخل vm.
// ============================================================================

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

test("معالج الحركة لا يسقط إلى مبلغ وحده أو تاريخ وحده", () => {
  const handlerAt = appJs.indexOf("app.querySelectorAll(\"[data-action='gen-movement-doc']\")");
  assert.ok(handlerAt > 0, "معالج زر الحركة غائب");
  const next = appJs.indexOf("app.querySelectorAll(\"[data-action='gen-invoice-doc']\")", handlerAt);
  const handler = appJs.slice(handlerAt, next > handlerAt ? next : handlerAt + 9000);
  assert.ok(handler.includes("uniqueInvoiceByDateAmount"), "المطابقة الاحتياطية ليست uniqueInvoiceByDateAmount");
  assert.equal(handler.includes("|| invs.find((x) => amtMatch(x))"), false, "بقي السقوط إلى المبلغ وحده");
  assert.equal(handler.includes("|| invs.find((x) => dateMatch(x))"), false, "بقي السقوط إلى التاريخ وحده");
});

const PATTERNS = {
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  normalizeItemName: /function normalizeItemName\(value\) \{[\s\S]*?\n\}\n/,
  smartNameMatch: /function smartNameMatch\(list, getName, name\) \{[\s\S]*?\n\}\n/,
  normGuid: /function normGuid\(value\) \{[\s\S]*?\n\}\n/,
  uniqueInvoiceByDateAmount: /function uniqueInvoiceByDateAmount\(invs, dateStr, debit\) \{[\s\S]*?\n\}\n/,
  uniqueDebitMovementOnDate: /function uniqueDebitMovementOnDate\(movements, dateStr, amount\) \{[\s\S]*?\n\}\n/,
  invoiceMovement: /function invoiceMovement\(custName, inv\) \{[\s\S]*?\n\}\n/
};

const source = [];
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const found = appJs.match(pattern);
  if (!found) {
    failed += 1;
    results.push(`  ❌ استخراج ${name}\n     لم أجد التعريف في src/app.js`);
    continue;
  }
  source.push(found[0]);
}

const state = { customerMovementsReport: null };
const sandbox = { console, state };
if (source.length === Object.keys(PATTERNS).length) {
  vm.createContext(sandbox);
  vm.runInContext(source.join("\n"), sandbox);
}

const {
  uniqueInvoiceByDateAmount,
  uniqueDebitMovementOnDate,
  invoiceMovement
} = sandbox;

const DAY = "2026-10-11";
const BIG = { number: "1401", date: DAY, total: 2860, isReturn: false, guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", lines: [{ name: "اوسكار", qty: 10 }] };
const SMALL = { number: "1402", date: DAY, total: 180, isReturn: false, guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2", lines: [{ name: "مفرد", qty: 2 }] };
const REPEAT = { number: "1388", date: "2026-10-01", total: 2860, isReturn: false, guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3", lines: [{ name: "اوسكار قديم", qty: 10 }] };
const RET = { number: "R12", date: DAY, total: 180, isReturn: true, guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4", lines: [] };

test("تاريخ+مبلغ فريد يعيد الفاتورة الصحيحة", () => {
  const match = uniqueInvoiceByDateAmount([BIG, SMALL, REPEAT], DAY, 180);
  assert.equal(match, SMALL);
});

test("افتتاحي أو تحويل بنفس اليوم لا يلتصق بفاتورة أخرى", () => {
  assert.equal(uniqueInvoiceByDateAmount([BIG, SMALL], DAY, 5000), null);
});

test("نفس المبلغ في يوم آخر لا يكفي", () => {
  assert.equal(uniqueInvoiceByDateAmount([BIG, SMALL, REPEAT], DAY, 2860.4), BIG);
  assert.equal(uniqueInvoiceByDateAmount([BIG, SMALL, REPEAT], "2026-10-08", 2860), null);
});

test("فاتورتان بنفس اليوم ونفس المبلغ تقريباً تُرفضان", () => {
  const twin = { ...SMALL, number: "1403", total: 180.4, guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5" };
  assert.equal(uniqueInvoiceByDateAmount([SMALL, twin], DAY, 180), null);
});

test("المرتجع لا يُختار بدل فاتورة البيع", () => {
  assert.equal(uniqueInvoiceByDateAmount([RET], DAY, 180), null);
  assert.equal(uniqueInvoiceByDateAmount([RET, SMALL], DAY, 180), SMALL);
});

test("invoiceMovement: قيد فريد بالتاريخ والمبلغ", () => {
  state.customerMovementsReport = {
    items: [{
      name: "زبون تجريبي",
      movements: [
        { date: DAY, debit: 2860, credit: 0, billGuid: "", docPrev: 0, docNew: 2860 },
        { date: DAY, debit: 180, credit: 0, billGuid: "", docPrev: 2860, docNew: 3040 }
      ]
    }]
  };
  const mv = invoiceMovement("زبون تجريبي", { date: DAY, total: 180, guid: "" });
  assert.equal(mv && mv.debit, 180);
  assert.equal(mv && mv.docNew, 3040);
});

test("invoiceMovement: فاتورتان متقاربتان في نفس اليوم لا تأخذان رصيد الآخر", () => {
  state.customerMovementsReport = {
    items: [{
      name: "زبون تجريبي",
      movements: [
        { date: DAY, debit: 100, credit: 0, billGuid: "", docPrev: 0, docNew: 100 },
        { date: DAY, debit: 100.4, credit: 0, billGuid: "", docPrev: 100, docNew: 200.4 }
      ]
    }]
  };
  assert.equal(invoiceMovement("زبون تجريبي", { date: DAY, total: 100, guid: "" }), null);
  assert.equal(invoiceMovement("زبون تجريبي", { date: DAY, total: 100.4, guid: "" }), null);
});

test("uniqueDebitMovementOnDate يرفض التعدد ويقبل الواحد", () => {
  const rows = [
    { date: DAY, debit: 100 },
    { date: DAY, debit: 100.4 },
    { date: "2026-10-01", debit: 100 }
  ];
  assert.equal(uniqueDebitMovementOnDate(rows, DAY, 100), null);
  assert.equal(uniqueDebitMovementOnDate(rows, "2026-10-01", 100).debit, 100);
});

console.log("فحص مطابقة فاتورة القيد المدين:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
