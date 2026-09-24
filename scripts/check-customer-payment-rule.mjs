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
//
// «دفعات اليوم» في tools/push-daily-movement.ps1 تحمل الكتلة نفسها حرفياً، ويُشغَّل
// paymentSql فيها كاملاً على قيود مصطنعة بأشكال شواهدها (قسم «دفعات اليوم» أدناه).
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

// يشغّل SQL على SQLite في الذاكرة: tables = { اسم: { columns, rows } } ويعيد الصفوف كائنات.
function runSql(tables, sql) {
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
    return db.prepare(sql).all().map((r) => ({ ...r }));
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
  const run = spawnSync("python3", ["-c", py], {
    input: JSON.stringify({ schema, tables, sql }),
    encoding: "utf8",
  });
  if (run.error || run.status !== 0) {
    throw new Error(`تعذّر تشغيل SQLite (لا node:sqlite ولا python3): ${run.error?.message || run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

function runPaymentRule(block) {
  const sql = `${toSqlite(block)}\nselect GUID from payment_lines order by GUID`;
  return runSql({
    ac000: { columns: ["GUID text primary key", "ParentGUID text"], rows: ac000 },
    ce000: { columns: ["GUID text primary key", "TypeGUID text"], rows: ce000 },
    en000: { columns: ["GUID text primary key", "ParentGUID text", "AccountGUID text", "ContraAccGUID text", "Debit real", "Credit real", "Type integer"], rows: en000 },
  }, sql).map((r) => r.GUID);
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

// ── «دفعات اليوم» (tools/push-daily-movement.ps1) ─────────────────────────────
// العطل (2026-09-24): paymentSql كان يعدّ كل سطر دائن على حساب في cu000 دفعة، فظهر
// حسم فاتورة 0.01 ضمن «دفعات اليوم». الإصلاح يحمل كتلة payment-rule نفسها ويُبقي فلتر
// التاريخ وربط cu000 للاسم واستبعاد الموردين وشكل الصف. الفحص يشغّل paymentSql الحقيقي
// كاملاً على قيود مصطنعة تحاكي أشكال الشواهد (الأسماء والمعرّفات وهمية، والمبالغ تحاكي
// الشاهد فقط لتسمية الحالة).
const DM_DAY = "2026-09-24";

function dailyMovementPaymentSql() {
  const ps = dailyMovementPs.replace(/\r\n/g, "\n");
  const match = ps.match(/\$paymentSql = @"\n([\s\S]*?)\n"@/);
  assert.ok(match, "تعذّر إيجاد paymentSql في push-daily-movement.ps1");
  return match[1];
}

// ترجمة T-SQL إلى SQLite: التعليقات وdbo. وN'' وDATEADD وLEFT فقط — المنطق نفسه حرفياً.
function dailyMovementToSqlite(sql, day) {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);
  let out = toSqlite(sql);
  const steps = [
    [/DATEADD\(day,1,'\$Date'\)/g, `'${nextDay}'`],
    [/'\$Date'/g, `'${day}'`],
    [/\bN'/g, "'"],
    [/LEFT\(COALESCE\(en\.Notes,''\), 120\)/g, "substr(COALESCE(en.Notes,''), 1, 120)"],
  ];
  for (const [pattern, replacement] of steps) {
    assert.match(out, pattern, `نمط الترجمة غير موجود: ${pattern}`);
    out = out.replace(pattern, replacement);
  }
  assert.doesNotMatch(out, /\$\w/, "بقي متغيّر PowerShell غير مترجم");
  return out;
}

const D = {
  boxUsd: fake("d1"), boxSyp: fake("d2"), boxDollar: fake("d3"), boxSham: fake("d4"),
  custRoot: fake("d10"),
  faisal: fake("d11"), baron: fake("d12"), firstPay: fake("d13"), returner: fake("d14"),
  purchaser: fake("d15"), badr: fake("d16"), khayal: fake("d17"), opener: fake("d18"),
  via135: fake("d19"), older: fake("d20"),
  sales41: fake("d30"), returns42: fake("d31"), discount43: fake("d32"), inventory1241: fake("d33"),
  acc515: fake("d34"), suppliersRoot: fake("d40"), supplier: fake("d41"),
};
const dmAc000 = [
  [RULE.cashRoot, ZERO, "الأموال الجاهزة"], [D.boxUsd, RULE.cashRoot, "صندوق دولار"],
  [D.boxSyp, RULE.cashRoot, "صندوق سوري"], [D.boxDollar, RULE.cashRoot, "صندوق آخر خارج الأربعة"],
  [D.boxSham, RULE.cashRoot, "شام كاش"], [RULE.diff135, RULE.cashRoot, "فروقات الصندوق"],
  [RULE.customers121, ZERO, "الزبائن"], [D.custRoot, RULE.customers121, "مجموعة زبائن"],
  ...["faisal", "baron", "firstPay", "returner", "purchaser", "badr", "khayal", "opener", "via135", "older"]
    .map((k) => [D[k], D.custRoot, `زبون ${k}`]),
  [D.sales41, ZERO, "المبيعات"], [D.returns42, ZERO, "مرتجع المبيعات"], [D.discount43, ZERO, "الحسم الممنوح"],
  [D.inventory1241, ZERO, "مخزون بضاعة"], [D.acc515, ZERO, "فرق جرد"],
  [D.suppliersRoot, ZERO, "الموردون"], [D.supplier, D.suppliersRoot, "مورد"],
];
const dmCu000 = [
  ...["faisal", "baron", "firstPay", "returner", "purchaser", "badr", "khayal", "opener", "via135", "older"]
    .map((k) => [D[k], `زبون ${k}`]),
  [D.acc515, "فرق جرد"], [D.supplier, "مورد"],
];

const dmCe000 = [];
const dmEn000 = [];
let dmSeq = 0;
function dmEntry(tag, type = ZERO) {
  const guid = fake(`e${tag}`);
  dmCe000.push([guid, type]);
  return guid;
}
function dmLine(parent, account, contra, debit, credit, date = DM_DAY) {
  dmSeq += 1;
  dmEn000.push([`dm${String(dmSeq).padStart(6, "0")}-0000-4000-8000-000000000000`, parent, account, contra, debit, credit, 0, `${date} 00:00:00`, dmSeq, "ملاحظة"]);
}

const DM_PAY = [];
const DM_NOT = [];
function pay(name, customer, amount) { DM_PAY.push({ name, customer, amount }); }
function notPay(name, customer, amount) { DM_NOT.push({ name, customer, amount }); }

// فاتورة بيع بحسم 0.01 ثم سند قبض 869.565 في اليوم نفسه.
let e = dmEntry("f1");
dmLine(e, D.faisal, D.sales41, 700, 0); dmLine(e, D.faisal, D.discount43, 0, 0.01); dmLine(e, D.discount43, D.faisal, 0.01, 0);
notPay("حسم فاتورة 0.01 مقابل 43", "زبون faisal", 0.01);
e = dmEntry("f2");
dmLine(e, D.faisal, D.boxSyp, 0, 869.565); dmLine(e, D.boxSyp, D.faisal, 869.565, 0);
pay("سند قبض 869.565", "زبون faisal", 869.57);
// حسم 1.83 ثم قيد يدوي 38,730 على صندوق من شجرة 13 خارج الصناديق الأربعة.
e = dmEntry("b1");
dmLine(e, D.baron, D.sales41, 1000, 0); dmLine(e, D.baron, D.discount43, 0, 1.83); dmLine(e, D.discount43, D.baron, 1.83, 0);
notPay("حسم فاتورة 1.83 مقابل 43", "زبون baron", 1.83);
e = dmEntry("b2");
dmLine(e, D.baron, D.boxDollar, 0, 38730); dmLine(e, D.boxDollar, D.baron, 38730, 0);
pay("قيد يدوي 38,730 مقابل صندوق", "زبون baron", 38730);
// فاتورة بيع بدفعة أولى 1,047.
e = dmEntry("p1");
dmLine(e, D.firstPay, D.sales41, 1500, 0); dmLine(e, D.firstPay, D.boxUsd, 0, 1047); dmLine(e, D.boxUsd, D.firstPay, 1047, 0);
pay("الدفعة الأولى FirstPay", "زبون firstPay", 1047);
// مرتجع مبيعات.
e = dmEntry("r1");
dmLine(e, D.returner, D.returns42, 0, 420.02); dmLine(e, D.returns42, D.returner, 420.02, 0);
notPay("مرتجع مبيعات مقابل 42", "زبون returner", 420.02);
// فاتورة شراء من زبون: دائن مقابل مخزون 1241.
e = dmEntry("i1");
dmLine(e, D.purchaser, D.inventory1241, 0, 2000); dmLine(e, D.inventory1241, D.purchaser, 2000, 0);
notPay("فاتورة شراء مقابل 1241", "زبون purchaser", 2000);
// قبض مركّب بمقابل صفري: 200 وحده، و450 بجانب سطر آخر مقابل صندوق، و760 و456 في قيد واحد.
e = dmEntry("z1");
dmLine(e, D.badr, ZERO, 0, 200); dmLine(e, D.boxUsd, ZERO, 200, 0);
pay("قبض مركّب 200", "زبون badr", 200);
e = dmEntry("z2");
dmLine(e, D.badr, ZERO, 0, 450); dmLine(e, D.boxUsd, ZERO, 450, 0);
dmLine(e, D.badr, D.boxSyp, 0, 20); dmLine(e, D.boxSyp, D.badr, 20, 0);
pay("قبض مركّب 450", "زبون badr", 450);
pay("سطر مقابل صندوق في القيد المركّب نفسه", "زبون badr", 20);
e = dmEntry("z3");
dmLine(e, D.khayal, ZERO, 0, 760); dmLine(e, D.khayal, ZERO, 0, 456); dmLine(e, D.boxUsd, ZERO, 1216, 0);
pay("قبض مركّب 760", "زبون khayal", 760);
pay("قبض مركّب 456", "زبون khayal", 456);
// 135 فروقات الصندوق: زبون مقابله 135، والحساب 515 مقابل 135 وصندوق و1241.
e = dmEntry("c1");
dmLine(e, D.via135, RULE.diff135, 0, 5); dmLine(e, RULE.diff135, D.via135, 5, 0);
notPay("زبون مقابل 135", "زبون via135", 5);
e = dmEntry("c2");
dmLine(e, D.acc515, RULE.diff135, 0, 673); dmLine(e, RULE.diff135, D.acc515, 673, 0);
notPay("الحساب 515 مقابل 135", "فرق جرد", 673);
e = dmEntry("c3");
dmLine(e, D.acc515, D.boxSham, 0, 1000); dmLine(e, D.boxSham, D.acc515, 1000, 0);
notPay("الحساب 515 مقابل صندوق", "فرق جرد", 1000);
e = dmEntry("c4");
dmLine(e, D.acc515, D.inventory1241, 0, 9863.18); dmLine(e, D.inventory1241, D.acc515, 9863.18, 0);
notPay("الحساب 515 مقابل 1241", "فرق جرد", 9863.18);
// القيد الافتتاحي بمقابل صفري وفيه مدين على صندوق.
e = dmEntry("o1", RULE.openingType);
dmLine(e, D.opener, ZERO, 0, 60); dmLine(e, D.boxUsd, ZERO, 60, 0);
notPay("القيد الافتتاحي", "زبون opener", 60);
// مورد دائن مقابل صندوق: الموردون خارج «دفعات اليوم» كما كانوا.
e = dmEntry("s1");
dmLine(e, D.supplier, D.boxUsd, 0, 300); dmLine(e, D.boxUsd, D.supplier, 300, 0);
notPay("مورد مقابل صندوق", "مورد", 300);
// قبض حقيقي في يوم آخر: فلتر التاريخ باقٍ.
e = dmEntry("d1");
dmLine(e, D.older, D.boxUsd, 0, 500, "2026-09-23"); dmLine(e, D.boxUsd, D.older, 500, 0, "2026-09-23");
notPay("قبض بتاريخ يوم آخر", "زبون older", 500);

let dmRows = [];
test("paymentSql في push-daily-movement.ps1 يعمل فعلاً على قيود ثابتة", () => {
  dmRows = runSql({
    ac000: { columns: ["GUID text primary key", "ParentGUID text", "Name text"], rows: dmAc000 },
    ce000: { columns: ["GUID text primary key", "TypeGUID text"], rows: dmCe000 },
    en000: { columns: ["GUID text primary key", "ParentGUID text", "AccountGUID text", "ContraAccGUID text", "Debit real", "Credit real", "Type integer", "Date text", "Number integer", "Notes text"], rows: dmEn000 },
    cu000: { columns: ["AccountGUID text", "CustomerName text"], rows: dmCu000 },
  }, dailyMovementToSqlite(dailyMovementPaymentSql(), DM_DAY));
  assert.ok(dmRows.length > 0, "لم يُرجع paymentSql أي صف");
});
const dmKey = (customer, amount) => `${customer}|${Number(amount).toFixed(2)}`;
const dmPicked = new Set(dmRows.map((r) => dmKey(r.customer, r.amount)));
for (const c of DM_PAY) {
  test(`دفعات اليوم — دفعة: ${c.name}`, () => assert.ok(dmPicked.has(dmKey(c.customer, c.amount)), `${c.name} لم يظهر في دفعات اليوم`));
}
for (const c of DM_NOT) {
  test(`دفعات اليوم — ليست دفعة: ${c.name}`, () => assert.ok(!dmPicked.has(dmKey(c.customer, c.amount)), `${c.name} ظهر في دفعات اليوم`));
}
test("دفعات اليوم: لا صفوف زائدة، وشكل الصف customer/amount/number/notes كما هو", () => {
  assert.equal(dmRows.length, DM_PAY.length, `عدد الصفوف ${dmRows.length} والمتوقع ${DM_PAY.length}`);
  for (const r of dmRows) assert.deepEqual(Object.keys(r), ["customer", "amount", "number", "notes"]);
});

test("push-daily-movement.ps1 يحمل كتلة payment-rule نفسها حرفياً", () => {
  assert.equal(ruleBlock(dailyMovementPs, "push-daily-movement.ps1"), balancesBlock, "الكتلة في دفعات اليوم انحرفت عن استعلام الأرصدة");
});

test("paymentSql يُبقي فلتر اليوم وربط cu000 واستبعاد الموردين ويضيف القاعدة", () => {
  const sql = dailyMovementPaymentSql();
  assert.match(sql, /AND en\.Date >= '\$Date' AND en\.Date < DATEADD\(day,1,'\$Date'\)/, "فلتر التاريخ تغيّر");
  assert.match(sql, /JOIN cu000 c ON c\.AccountGUID = en\.AccountGUID/, "ربط cu000 للاسم تغيّر");
  assert.match(sql, /AND \(acp\.Name IS NULL OR acp\.Name <> N'الموردون'\)/, "استبعاد الموردين تغيّر");
  assert.match(sql, /AND en\.GUID IN \(SELECT pl\.GUID FROM payment_lines pl\)/, "paymentSql لا يستعمل payment_lines");
});

test("شكل الحمولة المرفوعة لم يتغيّر (payments وpaymentSummary وusdPayments)", () => {
  const ps = dailyMovementPs.replace(/\r\n/g, "\n");
  assert.match(ps, /payments = @\(\$payments\)/);
  assert.match(ps, /paymentSummary = \[ordered\]@\{ count = @\(\$payments\)\.Count; totalUsd = \$paymentTotal \}/);
  assert.match(ps, /usdPayments = @\(\$usdPayments\)/);
  assert.match(ps, /customer = \$_\.Name\n\s+paid = /);
});
console.log("فحص قاعدة الدفعة الحقيقية للزبون:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n${failed} فحص فشل.`);
  process.exit(1);
}
console.log(`\nاجتاز ${results.length} فحصاً.`);
