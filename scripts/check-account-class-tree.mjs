// ============================================================================
// فحص انحداري: **تصنيف حساب بطاقة الزبون من شجرة دليل الحسابات** (قرار المالك 2026-09-28).
//
// الخلل الذي يمنعه: تقرير الأرصدة يأخذ كل بطاقات cu000 أياً كان موقع حسابها في الشجرة، فدخلت
// «طابعة ليزرية» (أصل تحت 11 ← 113 أثاث ومفروشات) ذكاءَ الزبائن زبوناً «متعثّراً». التصنيف
// الآن بالانتماء الشجري بمعرّفات جذور الدليل (لا بالاسم ولا ببادئة الرمز).
//
// الفحص **يشغّل كتلة SQL الحقيقية** (بين علامتَي account-class ومعها عمود account-class-column
// من tools/ameen-customer-balances-query.sql) على SQLite ببيانات مصطنعة. التحقق الحي قراءةً على
// OZK2026 (2026-09-28): 264 customer، 43 supplier (= is_supplier بالاسم تماماً)، 3 employee،
// 1 expense، 1 revenue، 1 goods، 1 asset (الطابعة)، 0 other.
// ============================================================================
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const sql = readFileSync(new URL("../tools/ameen-customer-balances-query.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const agent = readFileSync(new URL("../tools/ameen-sync-agent.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const engine = readFileSync(new URL("../src/customer-intelligence.js", import.meta.url), "utf8");

function runSql(tables, query) {
  const schema = Object.entries(tables).map(([name, t]) => `create table ${name} (${t.columns.join(", ")})`);
  let sqlite = null;
  try { sqlite = process.getBuiltinModule?.("node:sqlite") ?? null; } catch { sqlite = null; }
  if (sqlite?.DatabaseSync) {
    const db = new sqlite.DatabaseSync(":memory:");
    for (const s of schema) db.exec(s);
    for (const [name, t] of Object.entries(tables)) {
      const stmt = db.prepare(`insert into ${name} values (${t.columns.map(() => "?").join(",")})`);
      for (const r of t.rows) stmt.run(...r);
    }
    return db.prepare(query).all().map((r) => ({ ...r }));
  }
  const py = `
import json, sqlite3, sys
d = json.load(sys.stdin)
c = sqlite3.connect(":memory:")
for s in d["schema"]: c.execute(s)
for name, t in d["tables"].items():
    c.executemany("insert into %s values (%s)" % (name, ",".join("?" * len(t["columns"]))), t["rows"])
cur = c.execute(d["sql"])
cols = [x[0] for x in cur.description]
print(json.dumps([dict(zip(cols, r)) for r in cur.fetchall()]))
`;
  const run = spawnSync("python3", ["-c", py], { input: JSON.stringify({ schema, tables, sql: query }), encoding: "utf8" });
  if (run.error || run.status !== 0) throw new Error(`تعذّر تشغيل SQLite: ${run.error?.message || run.stderr}`);
  return JSON.parse(run.stdout);
}

const strip = (text) => text.replace(/--[^\n]*/g, "").replace(/\bdbo\./g, "");
const block = (begin, end) => {
  const b = sql.indexOf(begin); const e = sql.indexOf(end);
  assert.ok(b > 0 && e > b, `علامتا ${begin} مفقودتان`);
  return strip(sql.slice(b + begin.length, e)).trim();
};

// جذور الدليل الحقيقية (بنية، لا بيانات زبائن).
const ROOT = {
  customers121: "e30187a7-eccc-4ff8-8a7d-f2df5e660b53", suppliers221: "85448bf9-74f1-4276-afcc-587f7d7a5534",
  advances125: "d2f225d2-d7ce-4a03-b711-dc81b2841caf", salaries501: "afe7ebb4-0210-4671-98e1-5621b8cadf1e",
  fixed11: "ce6e936a-3840-4f80-bf28-274aea4a3614", cash13: "c0dc3c06-b2ac-4e57-beae-19d7da3f514c",
  expenses5: "6ae0066f-d39e-4805-83d5-b8da92f7d7f1", revenue6: "32292636-198d-4ebb-9ada-9a21d24750b2",
  netSales4: "6d845c95-a40f-48e6-b875-e27c21477862", cost3: "eb3c0ebb-ca78-473e-9c16-f545c85ef1fe",
  goods7: "ef1db462-bda5-4946-a865-59ea22b7c4e9"
};
const ZERO = "00000000-0000-0000-0000-000000000000";
const fake = (tag) => `f${String(tag).padStart(7, "0")}-0000-4000-8000-000000000000`;
const top = { assets1: fake("r1"), current12: fake("r12"), liabilities2: fake("r2"), current22: fake("r22"), misc9: fake("r9") };
const ac000 = [
  [top.assets1, ZERO], [top.current12, top.assets1], [ROOT.customers121, top.current12], [ROOT.advances125, top.current12],
  [ROOT.fixed11, top.assets1], [ROOT.cash13, top.assets1], [top.liabilities2, ZERO], [top.current22, top.liabilities2],
  [ROOT.suppliers221, top.current22], [ROOT.expenses5, ZERO], [ROOT.salaries501, ROOT.expenses5], [ROOT.revenue6, ZERO],
  [ROOT.netSales4, ZERO], [ROOT.cost3, ZERO], [ROOT.goods7, ZERO], [top.misc9, ZERO],
  [fake("g1211"), ROOT.customers121], [fake("g113"), ROOT.fixed11], [fake("g221x"), ROOT.suppliers221]
];
const CARDS = [
  ["cust", fake("a1"), fake("g1211"), "customer"],                 // زبون تحت 121 ← 1211
  ["custNested", fake("a2"), fake("a1"), "customer"],              // حساب تحت حساب زبون (نوار خلوف)
  ["supplier", fake("a3"), fake("g221x"), "supplier"],
  ["printer", fake("a4"), fake("g113"), "asset"],                  // الشاهد: 11 ← 113 أثاث ومفروشات
  ["advance", fake("a5"), ROOT.advances125, "employee"],
  ["salary", fake("a6"), ROOT.salaries501, "employee"],            // 501 تحت 5: الموظف يسبق المصروف
  ["expense", fake("a7"), ROOT.expenses5, "expense"],
  ["revenue", fake("a8"), ROOT.revenue6, "revenue"],
  ["goods", fake("a9"), ROOT.goods7, "goods"],
  ["cost", fake("a10"), ROOT.cost3, "cost"],
  ["cash", fake("a11"), ROOT.cash13, "asset"],
  ["misc", fake("a12"), top.misc9, "other"],                       // جذر غير معروف ⇒ غامض
  ["orphan", fake("a13"), fake("missing"), "other"]                // أب مفقود ⇒ غامض لا تخمين
];
for (const [, acct, parent] of CARDS) ac000.push([acct, parent]);

test("الكتلة والعمود موجودان بين علاماتهما، وخارج كتلة payment-rule", () => {
  const cte = block("-- account-class:begin", "-- account-class:end");
  assert.match(cte, /^, account_class_root as \(/);
  assert.match(cte, /account_class_chain as \(/);
  assert.ok(sql.indexOf("-- account-class:begin") > sql.indexOf("-- payment-rule:end"), "لا يمسّ تعريف الدفعة الموحّد");
  block("-- account-class-column:begin", "-- account-class-column:end");
});

test("جذور الدليل كلها بالمعرّف (لا الاسم ولا بادئة الرمز)", () => {
  const cte = block("-- account-class:begin", "-- account-class:end");
  for (const guid of Object.values(ROOT)) assert.ok(cte.includes(guid), `جذر غائب: ${guid}`);
  assert.ok(!/Name|Code/.test(cte), "التصنيف لا يقرأ الاسم ولا الرمز");
  assert.ok(!/Name|Code/.test(block("-- account-class-column:begin", "-- account-class-column:end")));
});

test("التصنيف على SQLite: زبون/مورد/موظف/أصل/مصروف/إيراد/تكلفة/بضاعة/غامض", () => {
  const cte = block("-- account-class:begin", "-- account-class:end").replace(/^,\s*/, "");
  const column = block("-- account-class-column:begin", "-- account-class-column:end").replace(/,\s*$/, "");
  const query = `with ${cte} select cu.Tag as tag, ${column} from cu000 cu`;
  const rows = runSql({
    ac000: { columns: ["GUID", "ParentGUID"], rows: ac000 },
    cu000: { columns: ["Tag", "AccountGUID"], rows: CARDS.map(([tag, acct]) => [tag, acct]) }
  }, query);
  const got = Object.fromEntries(rows.map((r) => [r.tag, r.account_class]));
  for (const [tag, , , want] of CARDS) assert.equal(got[tag], want, `${tag}: ${got[tag]} ≠ ${want}`);
});

test("وكيل المزامنة يرسل accountClass ويرفع العلامة v1 فقط إن حملها كل صف", () => {
  assert.match(agent, /accountClass = \[string\]\$row\.account_class/);
  assert.match(agent, /\$accountClassesComplete = \(@\(\$items \| Where-Object \{ \[string\]::IsNullOrWhiteSpace\(\[string\]\$_\.accountClass\) \}\)\.Count -eq 0\)/);
  assert.match(agent, /accountClasses = \$\(if \(\$accountClassesComplete\) \{ "v1" \} else \{ \$null \}\)/);
});

test("عقد المحرك: العلامة نفسها، وكل صنف غير تجاري يعرفه المحرك", () => {
  const marker = engine.match(/const ACCOUNT_CLASSES_MARKER = "([^"]+)";/);
  assert.ok(marker && marker[1] === "v1", "علامة المحرك");
  const nonCustomer = engine.match(/const NON_CUSTOMER_ACCOUNT_CLASSES = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(nonCustomer, "NON_CUSTOMER_ACCOUNT_CLASSES غائب");
  for (const cls of ["employee", "asset", "expense", "revenue", "cost", "goods"]) assert.match(nonCustomer[1], new RegExp(`\\b${cls}:`), `صنف ${cls}`);
  for (const cls of ["customer", "supplier", "employee", "asset", "expense", "revenue", "cost", "goods", "other"]) {
    assert.ok(block("-- account-class-column:begin", "-- account-class-column:end").includes(`'${cls}'`), `المصدر لا يُنتج ${cls}`);
  }
});

console.log(results.join("\n"));
if (failed) { console.error(`تصنيف الحساب من الشجرة: فشل ${failed}`); process.exit(1); }
console.log(`تصنيف الحساب من الشجرة: ${results.length} عقود محسومة.`);
