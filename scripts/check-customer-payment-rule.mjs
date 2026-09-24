// ============================================================================
// فحص انحداري: **«الدفعة» = قبض دخل صندوقاً، لا أي سطر دائن على الزبون.**
//
// العطل الحقيقي (2026-09-24): «آخر دفعة» لزبون كانت حسمَ فاتورته (TotalDisc) لا قبضاً.
// استعلام الأرصدة كان يعدّ كل `Credit > 0 AND Type = 0` على حساب الزبون دفعة، فيدخل
// الحسم والمرتجع والقيد الافتتاحي والتسويات والتحويلات في «آخر دفعة» وسجل الدفعات
// وعدّاد نافذة زخم السداد معاً.
//
// القاعدة المعتمدة مُثبتة قراءةً على الأمين (2026-09-24) على كل الأسطر الدائنة للزبائن
// بلا إيجابي ولا سلبي خاطئ معروف. تلك البيانات متغيرة وحساسة فلا يُختبر بها ولا تُنسخ
// هنا؛ يُختبر بقيود مصطنعة كلياً تحاكي **أشكال** الشواهد المحاسبية وحدها: الأسماء
// والمبالغ ومعرّفات القيود والزبائن كلها وهمية. المعرّفات الحقيقية الوحيدة هي معرّفات
// بنية دليل الحسابات التي تحملها القاعدة نفسها (جذر الصناديق، 135، شجرة 121، نوع القيد
// الافتتاحي) — وهي إعداد لا بيانات زبائن.
//
// الفحص **يشغّل كتلة SQL الحقيقية** (بين علامتَي payment-rule في
// tools/ameen-customer-balances-query.sql) على SQLite — لا نسخة مبسّطة:
// node:sqlite إن وُجد (Node ≥ 22)، وإلا python3/sqlite3 (متاح على مشغّلات CI).
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

const balancesSql = readFileSync(new URL("../tools/ameen-customer-balances-query.sql", import.meta.url), "utf8");
const dailySummaryPs = readFileSync(new URL("../tools/ameen-daily-summary.ps1", import.meta.url), "utf8");
const dailyMovementPs = readFileSync(new URL("../tools/push-daily-movement.ps1", import.meta.url), "utf8");

function ruleBlock(text, label) {
  const normalized = text.replace(/\r\n/g, "\n");
  const begin = normalized.indexOf("-- payment-rule:begin");
  const end = normalized.indexOf("-- payment-rule:end");
  assert.ok(begin >= 0 && end > begin, `${label}: علامتا payment-rule مفقودتان`);
  return normalized.slice(begin, end + "-- payment-rule:end".length);
}

const ZERO = "00000000-0000-0000-0000-000000000000";
// معرّفات بنية دليل الحسابات التي تحملها القاعدة نفسها (إعداد، لا بيانات زبائن).
const RULE = {
  cashRoot: "c0dc3c06-b2ac-4e57-beae-19d7da3f514c",
  diff135: "ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8",
  customers121: "e30187a7-eccc-4ff8-8a7d-f2df5e660b53",
  openingType: "ea69ba80-662d-4fa4-90ee-4d2e1988a8ea",
};
// كل ما عداها مصطنع.
const fake = (tag) => `f${tag.padStart(7, "0")}-0000-4000-8000-000000000000`;
const A = {
  boxA: fake("b1"), boxB: fake("b2"), boxC: fake("b3"),
  netSales: fake("a4"), sales: fake("a41"), returns: fake("a42"), discount: fake("a43"),
  expenses: fake("a5"), expenseChild: fake("a51"), expenseOther: fake("a52"),
  advances: fake("a6"), advanceChild: fake("a61"),
  custGroup: fake("c0"), custSubGroup: fake("c00"),
  custA: fake("c1"), custB: fake("c2"), custC: fake("c3"), custD: fake("c4"),
  custE: fake("c5"), custF: fake("c6"), custG1: fake("c7"), custG2: fake("c8"),
};

const ac000 = [
  [RULE.cashRoot, ZERO], [A.boxA, RULE.cashRoot], [A.boxB, RULE.cashRoot], [A.boxC, RULE.cashRoot],
  [RULE.diff135, RULE.cashRoot],
  [RULE.customers121, ZERO], [A.custGroup, RULE.customers121], [A.custSubGroup, A.custGroup],
  [A.custA, A.custSubGroup], [A.custB, A.custSubGroup], [A.custC, A.custGroup], [A.custD, A.custGroup],
  [A.custE, A.custGroup], [A.custF, A.custGroup], [A.custG1, A.custGroup], [A.custG2, A.custGroup],
  [A.netSales, ZERO], [A.sales, A.netSales], [A.returns, A.netSales], [A.discount, A.netSales],
  [A.expenses, ZERO], [A.expenseChild, A.expenses], [A.expenseOther, A.expenses],
  [A.advances, ZERO], [A.advanceChild, A.advances],
];

const RECEIPT_TYPE = fake("t1");
const E = {};
for (const k of ["saleDiscount", "manualCash", "saleFirstPay", "receipt", "saleReturn", "compoundSplit",
  "compoundNull", "compoundPassThrough", "opening", "advanceCashOut", "advanceCashIn", "expenseVia135",
  "expenseViaBox", "customerVia135", "zeroOnly135", "transfer", "typeOne"]) {
  E[k] = fake(`e${Object.keys(E).length + 1}`);
}
const ce000 = Object.values(E).map((g) => [g, g === E.opening ? RULE.openingType : g === E.receipt ? RECEIPT_TYPE : ZERO]);
// عمداً: القيد fake("e99") بلا رأس في ce000.

// en000: [GUID, ParentGUID, AccountGUID, ContraAccGUID, Debit, Credit, Type]
let seq = 0;
const en000 = [];
function line(parent, account, contra, debit, credit, type = 0) {
  seq += 1;
  const guid = `en${String(seq).padStart(6, "0")}-0000-4000-8000-000000000000`;
  en000.push([guid, parent, account, contra, debit, credit, type]);
  return guid;
}

const MUST_PAY = {};
const MUST_NOT = {};

// فاتورة بيع: المدين على الزبون، وحسمها دائن مقابل حساب الحسم الممنوح.
line(E.saleDiscount, A.custA, A.sales, 1000.5, 0);
MUST_NOT["حسم فاتورة بيع مقابل الحسم الممنوح"] = line(E.saleDiscount, A.custA, A.discount, 0, 0.5);
line(E.saleDiscount, A.discount, A.custA, 0.5, 0);
// قيد يدوي بلا مستند: الزبون دائن مقابل صندوق مباشرة — قبض.
MUST_PAY["قيد يدوي دائن مقابل صندوق"] = line(E.manualCash, A.custA, A.boxA, 0, 1000);
line(E.manualCash, A.boxA, A.custA, 1000, 0);
// فاتورة بيع بدفعة أولى (FirstPay): سطر الدفعة مقابل صندوق داخل قيد الفاتورة.
line(E.saleFirstPay, A.custB, A.sales, 300, 0);
line(E.saleFirstPay, A.custB, A.discount, 0.01, 0);
MUST_PAY["الدفعة الأولى FirstPay مقابل صندوق"] = line(E.saleFirstPay, A.custB, A.boxB, 0, 250);
line(E.saleFirstPay, A.boxB, A.custB, 250, 0);
// سند قبض عادي.
MUST_PAY["سند قبض عادي مقابل صندوق"] = line(E.receipt, A.custC, A.boxC, 0, 120.123456);
line(E.receipt, A.boxC, A.custC, 120.123456, 0);
// مرتجع مبيعات: دائن مقابل مرتجع المبيعات، ومدين حسمه مقابل الحسم.
MUST_NOT["مرتجع مبيعات مقابل حساب المرتجع"] = line(E.saleReturn, A.custD, A.returns, 0, 80);
line(E.saleReturn, A.custD, A.discount, 0.02, 0);
line(E.saleReturn, A.returns, A.custD, 80, 0);
// قيد مركب: دفعة واحدة بمقابل صفري دخلت صندوقين بمبلغين جزئيين — لا مطابقة مبلغ.
MUST_PAY["قيد مركب: دفعة بمقابل صفري دخلت صندوقين"] = line(E.compoundSplit, A.custE, ZERO, 0, 50);
line(E.compoundSplit, A.boxA, ZERO, 45, 0);
line(E.compoundSplit, A.boxB, ZERO, 5, 0);
// قيد مركب بمقابل NULL لا صفري.
MUST_PAY["قيد مركب: مقابل NULL ومدين صندوق"] = line(E.compoundNull, A.custE, null, 0, 70);
line(E.compoundNull, A.boxA, null, 70, 0);
// قيد مركب: دفعتان ثم خروج المبلغ من الصندوق للمصاريف في القيد نفسه.
MUST_PAY["قيد مركب: دفعة أولى ثم خروج من الصندوق"] = line(E.compoundPassThrough, A.custF, ZERO, 0, 40);
MUST_PAY["قيد مركب: دفعة ثانية ثم خروج من الصندوق"] = line(E.compoundPassThrough, A.custF, ZERO, 0, 30);
line(E.compoundPassThrough, A.boxC, ZERO, 40, 0);
line(E.compoundPassThrough, A.boxC, ZERO, 30, 0);
line(E.compoundPassThrough, A.boxC, ZERO, 0, 70);
line(E.compoundPassThrough, A.expenseOther, ZERO, 70, 0);
// القيد الافتتاحي: دائن الزبون بمقابل صفري، وفي القيد مدين على الصناديق.
MUST_NOT["القيد الافتتاحي (نوعه ea69ba80)"] = line(E.opening, A.custD, ZERO, 0, 60);
line(E.opening, A.boxA, ZERO, 500, 0);
line(E.opening, A.boxB, ZERO, 7, 0);
// سلفة موظف (خارج شجرة 121): الصندوق دائن فقط، ثم حالة فيها مدين صندوق — الشجرة تُخرجها.
MUST_NOT["سلفة/راتب والصندوق دائن فقط"] = line(E.advanceCashOut, A.advanceChild, ZERO, 0, 25);
line(E.advanceCashOut, A.boxC, ZERO, 0, 25);
MUST_NOT["سلفة مقابل صندوق (خارج شجرة 121)"] = line(E.advanceCashIn, A.advanceChild, A.boxC, 0, 25);
line(E.advanceCashIn, A.boxC, A.advanceChild, 25, 0);
// حساب مصاريف مسجّل زبوناً: تسوية مقابل 135، ودائن مقابل صندوق.
MUST_NOT["حساب مصاريف: تسوية مقابل 135"] = line(E.expenseVia135, A.expenseChild, RULE.diff135, 0, 15);
line(E.expenseVia135, RULE.diff135, A.expenseChild, 15, 0);
MUST_NOT["حساب مصاريف مقابل صندوق (خارج شجرة 121)"] = line(E.expenseViaBox, A.expenseChild, A.boxB, 0, 35);
line(E.expenseViaBox, A.boxB, A.expenseChild, 35, 0);
// 135 فروقات الصندوق على زبون حقيقي: مباشرة، وبمقابل صفري لا مدين فيه إلا على 135.
MUST_NOT["زبون مقابل 135 فروقات الصندوق"] = line(E.customerVia135, A.custC, RULE.diff135, 0, 3.5);
line(E.customerVia135, RULE.diff135, A.custC, 3.5, 0);
MUST_NOT["مقابل صفري ومدين 135 وحده"] = line(E.zeroOnly135, A.custC, ZERO, 0, 2.25);
line(E.zeroOnly135, RULE.diff135, ZERO, 2.25, 0);
// تحويل بين حسابَي زبون.
MUST_NOT["تحويل بين حسابَي زبون"] = line(E.transfer, A.custG2, A.custG1, 0, 4.5);
line(E.transfer, A.custG1, A.custG2, 4.5, 0);
// Type ≠ 0 لا يُعدّ حتى لو مقابله صندوق.
MUST_NOT["سطر Type = 1 مقابل صندوق"] = line(E.typeOne, A.custC, A.boxA, 0, 12, 1);
line(E.typeOne, A.boxA, A.custC, 12, 0, 1);
// مقابل صفري في قيد بلا رأس ce000: لا يُثبت نوع القيد ⇒ لا دفعة.
MUST_NOT["مقابل صفري بلا رأس قيد"] = line(fake("e99"), A.custC, ZERO, 0, 9);
line(fake("e99"), A.boxA, ZERO, 9, 0);

// ترجمة كتلة T-SQL إلى SQLite: حذف التعليقات وبادئة dbo. فقط — المنطق نفسه حرفياً.
function toSqlite(block) {
  return block.replace(/--[^\n]*/g, "").replace(/\bdbo\./g, "");
}

function runPaymentRule(block) {
  const sql = `${toSqlite(block)}\nselect GUID from payment_lines order by GUID`;
  const schema = [
    "create table ac000 (GUID text primary key, ParentGUID text)",
    "create table ce000 (GUID text primary key, TypeGUID text)",
    "create table en000 (GUID text primary key, ParentGUID text, AccountGUID text, ContraAccGUID text, Debit real, Credit real, Type integer)",
  ];
  let sqlite = null;
  try { sqlite = process.getBuiltinModule?.("node:sqlite") ?? null; } catch { sqlite = null; }
  if (sqlite?.DatabaseSync) {
    const db = new sqlite.DatabaseSync(":memory:");
    for (const s of schema) db.exec(s);
    const ins = (table, rows) => {
      const stmt = db.prepare(`insert into ${table} values (${rows[0].map(() => "?").join(",")})`);
      for (const r of rows) stmt.run(...r);
    };
    ins("ac000", ac000); ins("ce000", ce000); ins("en000", en000);
    return db.prepare(sql).all().map((r) => r.GUID);
  }
  const py = `
import json, sqlite3, sys
d = json.load(sys.stdin)
c = sqlite3.connect(":memory:")
for s in d["schema"]: c.execute(s)
for t in ("ac000", "ce000", "en000"):
    rows = d[t]
    c.executemany("insert into %s values (%s)" % (t, ",".join("?" * len(rows[0]))), rows)
print(json.dumps([r[0] for r in c.execute(d["sql"]).fetchall()]))
`;
  const run = spawnSync("python3", ["-c", py], {
    input: JSON.stringify({ schema, ac000, ce000, en000, sql }),
    encoding: "utf8",
  });
  if (run.error || run.status !== 0) {
    throw new Error(`تعذّر تشغيل SQLite (لا node:sqlite ولا python3): ${run.error?.message || run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

const balancesBlock = ruleBlock(balancesSql, "ameen-customer-balances-query.sql");
let selected = [];
test("كتلة القاعدة تعمل فعلاً على قيود ثابتة", () => {
  selected = runPaymentRule(balancesBlock);
  assert.ok(Array.isArray(selected) && selected.length > 0, "لم تُرجع القاعدة أي سطر");
});
const picked = new Set(selected);

for (const [name, guid] of Object.entries(MUST_PAY)) {
  test(`دفعة: ${name}`, () => assert.ok(picked.has(guid), `${name} لم يُعدّ دفعة`));
}
for (const [name, guid] of Object.entries(MUST_NOT)) {
  test(`ليست دفعة: ${name}`, () => assert.ok(!picked.has(guid), `${name} عُدّ دفعة`));
}
test("لا تلتقط القاعدة غير الأسطر الدائنة المقصودة (ولا أسطر الصناديق المدينة)", () => {
  const expected = new Set(Object.values(MUST_PAY));
  const extra = selected.filter((g) => !expected.has(g));
  assert.deepEqual(extra, [], `أسطر زائدة: ${extra.join(", ")}`);
});

test("الأماكن الثلاثة (آخر دفعة، سجل الدفعات، نافذة الزخم) تستعمل القاعدة نفسها", () => {
  const sql = balancesSql.replace(/\r\n/g, "\n");
  const apply = (alias) => {
    const end = sql.indexOf(`) ${alias}\n`);
    assert.ok(end > 0, `تعذّر إيجاد ${alias}`);
    return sql.slice(sql.lastIndexOf("outer apply (", end), end);
  };
  for (const alias of ["last_payment", "recent_payments", "payments_window"]) {
    const body = apply(alias);
    assert.match(body, /en\.GUID in \(select pl\.GUID from payment_lines pl\)/, `${alias} لا يستعمل payment_lines`);
    assert.match(body, /acp\.Name = N'الموردون' or en\.GUID in/, `${alias} غيّر منطق الموردين`);
  }
  assert.doesNotMatch(apply("recent_movements"), /payment_lines/, "آخر الحركات ليست دفعات — يجب ألا تُصفّى بقاعدة الدفعة");
});

test("القاعدة بالمعرّفات والشجرة: لا تاريخ ولا مبلغ ولا اسم حساب", () => {
  const body = toSqlite(balancesBlock);
  assert.doesNotMatch(body, /\bDate\b/i, "القاعدة تطابق بالتاريخ");
  assert.doesNotMatch(body, /abs\s*\(|Credit\s*=|Debit\s*=|=\s*(en|d)\.(Credit|Debit)/i, "القاعدة تطابق بالمبلغ");
  assert.doesNotMatch(body, /\bName\b|N'/, "القاعدة تعتمد اسم حساب");
  for (const [label, guid] of [["جذر الصناديق", RULE.cashRoot], ["135 مستبعد", RULE.diff135], ["شجرة 121", RULE.customers121], ["القيد الافتتاحي", RULE.openingType]]) {
    assert.ok(body.includes(`'${guid}'`), `المعرّف مفقود: ${label}`);
  }
});

test("ameen-daily-summary.ps1 يحمل الكتلة نفسها حرفياً ويبني last_payment_date عليها", () => {
  assert.equal(ruleBlock(dailySummaryPs, "ameen-daily-summary.ps1"), balancesBlock, "الكتلة في ملخص اليوم انحرفت عن استعلام الأرصدة");
  const ps = dailySummaryPs.replace(/\r\n/g, "\n");
  assert.match(ps, /left join payment_lines pl on pl\.GUID = en\.GUID/);
  assert.match(ps, /max\(case when coalesce\(en\.Credit, 0\) > 0 and \(acp\.Name = N'الموردون' or pl\.GUID is not null\) then en\.Date end\) as last_payment_date/);
});

test("«دفعات اليوم» في push-daily-movement.ps1 خارج نطاق هذا الإصلاح (مسار مستقل)", () => {
  assert.doesNotMatch(dailyMovementPs, /payment-rule:begin/, "push-daily-movement.ps1 عُدّل ضمن هذا الإصلاح");
});

console.log("فحص قاعدة الدفعة الحقيقية للزبون:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n${failed} فحص فشل.`);
  process.exit(1);
}
console.log(`\nاجتاز ${results.length} فحصاً.`);
