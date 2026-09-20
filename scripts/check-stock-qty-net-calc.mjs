// Regression guard: stock_qty must always be the NET balance across Ameen
// warehouses, even when a material is negative in one store and positive in
// another (uncleared transfer). A prior version fell back to the positive-only
// sum whenever the net was <= 0, which silently inflated quantities — 66 items
// totaling 13,250.40 units on 2026-09-20 (see tools/ameen-stock-query.sql history).
import { readFileSync } from "node:fs";
import vm from "node:vm";

let failed = false;
function assert(condition, message) { if (!condition) { failed = true; console.error(message); } }

const sql = readFileSync("tools/ameen-stock-query.sql", "utf8");
const selectListEnd = sql.indexOf("from dbo.mt000");
const selectList = sql.slice(0, selectListEnd);
assert(
  !/when\s+coalesce\(stock\.stock_qty_positive/i.test(selectList),
  "ameen-stock-query.sql must not fall back to stock_qty_positive when computing stock_qty — that hides negative store balances."
);
const stockQtyLine = selectList.match(/cast\([\s\S]*?\)\s*as\s+stock_qty,/i)?.[0] || "";
assert(
  /stock\.stock_qty_net/.test(stockQtyLine) && /as stock_qty,/.test(stockQtyLine),
  "ameen-stock-query.sql: stock_qty column must be derived directly from stock_qty_net."
);

// app.js: itemQty() must return the raw net quantity, including negative values.
const app = readFileSync("src/app.js", "utf8");
const fnMatch = app.match(/function itemQty\(item\)\s*\{[\s\S]*?\n\}/);
assert(Boolean(fnMatch), "src/app.js: itemQty() function not found.");
if (fnMatch) {
  assert(
    !/stockQtyPositive/.test(fnMatch[0]),
    "itemQty() must not substitute stockQtyPositive for a zero/negative net balance."
  );
  const context = vm.createContext({ Number, console });
  vm.runInContext(`${fnMatch[0]}\nthis.itemQty = itemQty;`, context);
  const negative = context.itemQty({ stockQty: -215, stockQtyPositive: 250 });
  const zero = context.itemQty({ stockQty: 0, stockQtyPositive: 0 });
  const positive = context.itemQty({ stockQty: 514, stockQtyPositive: 2600 });
  assert(negative === -215, `itemQty() must return the true negative net (-215), got ${negative}.`);
  assert(zero === 0, `itemQty() must return 0 when net is 0, got ${zero}.`);
  assert(positive === 514, `itemQty() must return the net (514), not the positive-only sum (2600), got ${positive}.`);
}

if (failed) process.exit(1);
console.log("Stock quantity net-balance calculation (SQL + itemQty) regression guard passed.");
