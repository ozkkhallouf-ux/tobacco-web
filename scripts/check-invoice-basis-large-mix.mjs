// ============================================================================
// فحص انحداري: فاتورة مبيعات طويلة مختلطة الأسس تُطبَع بقيم لا تطابق إجمالي الأمين.
//
// العطل المُثبت على الإنتاج في 2026-09-23: عُدِّلت فاتورة مبيعات (193 سطراً،
// الإجمالي 38731.828) في الأمين ووصلت لقطة التفاصيل إلى Supabase، لكن
// `computeInvoiceLineBasisPlan` استسلم عند سقف 200000 خطوة (التوزيع المضبوط
// يقع عند الخطوة 356037 بالترتيب نفسه) فرجع «لا حكم». المسار الاحتياطي طبع كل
// الأسطر بأساس الكرتونة، فصار مجموعها 34244.73 بدل إجمالي الأمين — فرق 4487$.
// الأرقام أدناه كميات وأسعار فقط، بلا أسماء.
//
// ويحرس كذلك أن شاشة «الفواتير السابقة» تُستَطلع مع التحديث الدوري: التبويب
// المفتوح عليها كان يبقى على اللقطة القديمة بعد وصول التعديل.
// ============================================================================
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

const PATTERNS = {
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  invoiceBasisTolerance: /function invoiceBasisTolerance\(lines\) \{[\s\S]*?\n\}\n/,
  invoiceLineCandidates: /function invoiceLineCandidates\(line\) \{[\s\S]*?\n\}\n/,
  INVOICE_BASIS_CONSTS: /const INVOICE_BASIS_SEARCH_BUDGET = [^\n]*\n[\s\S]*?const INVOICE_BASIS_PLAN_CACHE = [^\n]*\n/,
  invoiceLineBasisPlan: /function invoiceLineBasisPlan\(inv\) \{[\s\S]*?\n\}\n/,
  computeInvoiceLineBasisPlan: /function computeInvoiceLineBasisPlan\(lines, total\) \{[\s\S]*?\n\}\n/,
  invoicePriceBasis: /function invoicePriceBasis\(inv\) \{[\s\S]*?\n\}\n/,
  invoiceLineTotalValue: /function invoiceLineTotalValue\(line, inv\) \{[\s\S]*?\n\}\n/,
  customerInvoiceAutoRefresh: /function customerInvoiceAutoRefresh\(route, salesHistoryOpen\) \{[\s\S]*?\n\}\n/
};

const source = [];
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const found = appJs.match(pattern);
  assert.ok(found, `لم أجد ${name} في src/app.js`);
  source.push(found[0]);
}

const sandbox = { console, Map, WeakMap, Math, Number };
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);

const TOTAL = 38731.828;
const rows = `
368,350,7
350,200,4
350,50,1
380,75,1.5
297,150,3
297,150,3
402,250,5
402,100,2
402,50,1
402,50,1
240,50,1
295,100,2
325,100,2
325,50,1
370,50,1
375,50,1
285,50,1
285,50,1
247,50,1
328,50,1
305,50,1
318,50,1
265,50,1
277,100,2
312,100,2
247,50,1
230,50,1
4,15,0.3
4.52,10,0.2
3.4,10,0.2
258,50,1
308,50,1
255,50,1
255,25,0.5
263,50,1
306,100,2
325,50,1
320,50,1
345,25,0.5
320,50,1
320,100,2
16,15,15
72,20,1
80,20,1
8.5,360,15
8,120,5
170,25,0.5
225,50,1
225,50,1
4,10,0.2
4.2,10,0.2
3.7,10,0.2
4.1,10,0.2
4.3,10,0.2
490,50,1
270,50,1
405,50,1
13.8,5,0.1
13.8,5,0.1
20,10,0.5
24.5,15,0.3
550,25,0.5
1230,25,0.5
3.9,5,0.1
3.9,5,0.1
3.9,5,0.1
3.9,5,0.1
3.9,5,0.1
3.9,5,0.1
275,50,1
283,50,1
10,10,0.2
190,50,1
675,25,0.5
20,5,0.25
20,5,0.25
22,10,0.333
22,10,0.333
22,10,0.2
6.4,10,0.2
295,100,2
275,50,1
190,25,0.5
100,36,3
100,12,0.5
100,6,0.5
100,6,0.5
100,6,0.5
110,12,1
100,6,0.5
4,5,0.1
3,5,0.1
275,50,1
4,5,0.1
322,50,1
322,50,1
5.5,5,0.1
265,25,0.5
280,50,1
265,25,0.5
238,50,1
238,50,1
225,50,1
190,25,0.5
295,50,1
245,25,0.5
6.6,10,0.2
4,10,0.143
4,10,0.2
195,25,0.5
4.9,10,0.2
5,10,0.2
5,5,0.1
250,50,1
250,25,0.5
265,50,1
4.5,5,0.1
4.5,5,0.1
4.5,5,0.1
4.5,5,0.1
3.9,10,0.2
3.9,10,0.2
4.4,10,0.2
4.4,10,0.2
4.4,10,0.2
3.8,10,0.2
3.8,10,0.2
3.8,5,0.1
3.8,5,0.1
255,50,1
200,50,1
4.2,10,0.2
4.2,10,0.2
5.5,10,0.2
5,10,0.2
5.5,5,0.1
8.333,5,0.167
41,24,1
13.75,6,0.5
13.75,3,0.25
13.75,6,0.5
13.75,6,0.5
13.75,6,0.5
13.75,6,0.5
180,12,1
180,12,1
100,12,1
31.5,10,1
32,10,1
31,20,1
31,50,5
28,10,1
34,80,2
27,10,1
27,10,1
31,40,1
32,40,2
33,16,1
30,10,1
29,10,1
31.5,10,1
31.5,10,1
31.5,10,1
31,10,1
31,40,1
31,20,1
6.042,5,0.208
10,6,0.5
6.042,10,0.417
6.042,6,0.25
20,6,1
20,5,0.833
6.042,10,0.417
10,6,0.5
135,24,1
145,24,2
12.083,23,1.917
145,24,2
145,12,1
140,12,1
125,12,1
125,12,1
11,6,0.5
11,6,0.5
140,12,1
145,12,1
16.667,6,0.5
455,25,1
300,40,1
0,10,0.2
270,25,0.5
335,50,1
265,25,0.5
`.trim().split("\n");

const lines = rows.map((row) => {
  const [price, qty, qtyUnits] = row.split(",").map(Number);
  return {
    price,
    qty,
    qtyUnits,
    lineTotal: price * qty,
    lineTotalSource: "derived",
    unit1: "كروز",
    unit2: "كرتونة"
  };
});
const inv = { total: TOTAL, lines };
const plan = sandbox.computeInvoiceLineBasisPlan(lines, TOTAL);
assert.ok(plan, "بحث أساس السعر يجب أن يجد توزيعاً يطابق إجمالي الفاتورة");
let sum = 0;
for (const line of lines) sum += sandbox.invoiceLineTotalValue(line, inv);
assert.ok(
  Math.abs(sum - TOTAL) <= 0.005,
  `مجموع قيم الأسطر المعروضة ${sum} لا يطابق إجمالي الأمين ${TOTAL}`
);

const history = sandbox.customerInvoiceAutoRefresh("sales", true);
assert.equal(history.poll, true, "شاشة الفواتير السابقة يجب أن تُستطلع دورياً");
assert.equal(history.repaintOnlyWhenInvoicesChange, true);
assert.equal(sandbox.customerInvoiceAutoRefresh("sales", false).poll, false);
assert.equal(sandbox.customerInvoiceAutoRefresh("dashboard", false).poll, true);
assert.equal(sandbox.customerInvoiceAutoRefresh("dashboard", false).repaintOnlyWhenInvoicesChange, false);
assert.equal(sandbox.customerInvoiceAutoRefresh("overview", false).poll, false);

console.log(`invoice basis large-mix check passed (${lines.length} lines, sum ${sum}).`);
