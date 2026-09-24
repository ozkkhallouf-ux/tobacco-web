// ============================================================================
// فحص انحداري: **«الدفعة» = قبض دخل صندوقاً، لا أي سطر دائن على الزبون.**
//
// العطل الحقيقي (2026-09-24): «آخر دفعة» لمركز البارون كانت 0.33 ثم 1.83 — وهي حسم
// الفاتورة #830 (TotalDisc) لا قبض. استعلام الأرصدة كان يعدّ كل `Credit > 0 AND Type = 0`
// على حساب الزبون دفعة، فيدخل الحسم والمرتجع والقيد الافتتاحي والتسويات والتحويلات
// في «آخر دفعة» وسجل الدفعات وعدّاد نافذة زخم السداد معاً.
//
// القاعدة المعتمدة مُثبتة قراءةً على الأمين (OZK2026، 2026-09-24، كل البيانات منذ
// 2026-07-01): 920 سطر دفعة و191 سطراً دائناً ليس دفعة، بصفر إيجابي خاطئ وصفر سلبي خاطئ.
// هذه الأرقام من بيانات إنتاج متغيرة فلا يُختبر بها؛ يُختبر بقيود ثابتة تحاكي الشواهد.
//
// الفحص **يشغّل كتلة SQL الحقيقية** (بين علامتَي payment-rule في
// tools/ameen-customer-balances-query.sql) على SQLite بقيود ثابتة — لا نسخة مبسّطة:
// node:sqlite إن وُجد (Node ≥ 22)، وإلا python3/sqlite3 (متاح على مشغّلات CI).
// المعرّفات أدناه معرّفات الأمين الحقيقية للحسابات والقيود حيث أُثبتت؛ وما لم يُثبت
// (حسابات الزبائن والوسطاء) معرّفات مصطنعة.
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
const G = {
  cashRoot: "c0dc3c06-b2ac-4e57-beae-19d7da3f514c", // 13 الأموال الجاهزة
  box132: "f9f9b4a4-3ff7-4b45-94c9-2e4d10bb5227",   // الصندوق دولار
  box133: "aacb5a67-6a19-45e4-b0b3-9a0b61a5790f",   // صندوق مبيعات المركز $
  box134: "18d12068-7b7a-45bc-855b-5a0dec084f9d",   // صندوق مبيعات المركز ل.س
  diff135: "ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8",  // فروقات الصندوق — مستبعد
  box137: "007fb589-7fb3-4e9e-b289-6cfc153dacb5",   // الشام كاش
  box138: "b3b2ee0f-0099-4390-8920-f1099c553658",   // شام كاش سوري
  customers121: "e30187a7-eccc-4ff8-8a7d-f2df5e660b53",
  netSales4: "6d845c95-0000-4000-8000-000000000004",
  sales41: "fx000041-0000-4000-8000-000000000041",
  returns42: "327fdae7-0000-4000-8000-000000000042",
  discount43: "f632a1a6-f685-48dd-8150-a1fb65538c49",
  expenses5: "fx000005-0000-4000-8000-000000000005",
  acct515: "fx000515-0000-4000-8000-000000000515", // «فرق جرد اخراج» مسجّل في cu000
  acct525: "fx000525-0000-4000-8000-000000000525", // مصاريف ابو زياد
  advances125: "fx000125-0000-4000-8000-000000000125",
  acct12506: "fx012506-0000-4000-8000-000000012506", // سلفة عثمان شامية
  group1211: "fx001211-0000-4000-8000-000000001211",
  group5510: "fx005510-0000-4000-8000-000000005510",
  baron: "2fd38e8b-dde0-4798-98bc-e0b52e082481",
  tawzi: "9f4eb345-21fd-4553-847a-e09baff4a1e4",
  abuFaisal: "a50b3fe4-0000-4000-8000-000000000001",
  abuNawaf: "267f9f7a-0000-4000-8000-000000000002",
  badr: "fx221058-0000-4000-8000-000000000003",
  khayal: "fx121103-0000-4000-8000-000000000004",
  barghoutUsd: "fx000006-0000-4000-8000-000000000006",
  barghoutSyp: "fx000007-0000-4000-8000-000000000007",
  openingType: "ea69ba80-662d-4fa4-90ee-4d2e1988a8ea",
  receiptType: "a83da629-4a8b-4c2c-9d7a-a963de3640a5",
};

const ac000 = [
  [G.cashRoot, ZERO], [G.box132, G.cashRoot], [G.box133, G.cashRoot], [G.box134, G.cashRoot],
  [G.diff135, G.cashRoot], [G.box137, G.cashRoot], [G.box138, G.cashRoot],
  [G.customers121, ZERO], [G.group1211, G.customers121], [G.group5510, G.group1211],
  [G.baron, G.group5510], [G.tawzi, G.group5510], [G.abuFaisal, G.group1211], [G.abuNawaf, G.group1211],
  [G.badr, G.group1211], [G.khayal, G.group1211], [G.barghoutUsd, G.group1211], [G.barghoutSyp, G.group1211],
  [G.netSales4, ZERO], [G.sales41, G.netSales4], [G.returns42, G.netSales4], [G.discount43, G.netSales4],
  [G.expenses5, ZERO], [G.acct515, G.expenses5], [G.acct525, G.expenses5],
  [G.advances125, ZERO], [G.acct12506, G.advances125],
];

// ce000: [GUID, TypeGUID]
const E = {
  inv830: "6e3d11e5-f56c-4f4c-9521-5f43c3f96431",
  baron4648: "fbee629a-4f3b-4761-84e7-15f7036f3186",
  inv813: "6cef437b-fe79-455a-9d65-e9ea58fa7518",
  receipt553: "b46c870b-596f-418c-a7f0-d190160dc975",
  ret32: "0e18cdb6-71a6-4c0d-87de-675711f69dd5",
  ce2029: "b727c412-aff2-4212-9947-486e6c305dd8",
  ce2143: "e2b4f490-8ccd-4e00-9a16-5cf112bd75ed",
  ce2196: "91aa3789-726d-4de6-95c7-4c51990da2cd",
  opening1: "5ad39ecd-f6ac-4f64-8b7d-503a88f0da09",
  salary1769: "fx001769-0000-4000-8000-000000001769",
  salaryCash: "fx003273-0000-4000-8000-000000003273",
  adj4626: "fx004626-0000-4000-8000-000000004626",
  thief: "fx000515-1000-4000-8000-000000001000",
  diff135Customer: "fx000135-0000-4000-8000-000000000135",
  diff135Zero: "fx000135-0000-4000-8000-000000000136",
  transfer487: "fx000487-0000-4000-8000-000000000487",
  typeOne: "fx000001-0000-4000-8000-00000000000a",
};
const ce000 = [
  [E.inv830, ZERO], [E.baron4648, ZERO], [E.inv813, ZERO], [E.receipt553, G.receiptType],
  [E.ret32, ZERO], [E.ce2029, ZERO], [E.ce2143, ZERO], [E.ce2196, ZERO], [E.opening1, G.openingType],
  [E.salary1769, ZERO], [E.salaryCash, ZERO], [E.adj4626, ZERO], [E.thief, ZERO],
  [E.diff135Customer, ZERO], [E.diff135Zero, ZERO], [E.transfer487, ZERO], [E.typeOne, ZERO],
  // عمداً: القيد "fx-no-header" بلا رأس في ce000.
];

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

// #830: الفاتورة مدين على الزبون، والحسم 1.83 دائن مقابل 43 الحسم الممنوح.
line(E.inv830, G.baron, G.sales41, 38731.828, 0);
MUST_NOT["#830 حسم الفاتورة 1.83 مقابل 43"] = line(E.inv830, G.baron, G.discount43, 0, 1.83);
line(E.inv830, G.discount43, G.baron, 1.83, 0);
// البارون ce 4648: قيد يدوي بلا er، مقابل 132 — قبض مؤكَّد من صاحب العمل (38,730$ يوم 2026-09-23).
MUST_PAY["البارون 38,730 مقابل 132"] = line(E.baron4648, G.baron, G.box132, 0, 38730);
line(E.baron4648, G.box132, G.baron, 38730, 0);
// #813 FirstPay: الدفعة الأولى 1047 مقابل 133 داخل قيد الفاتورة.
line(E.inv813, G.tawzi, G.sales41, 1056.99, 0);
line(E.inv813, G.tawzi, G.discount43, 0.01, 0);
MUST_PAY["#813 FirstPay 1047 مقابل 133"] = line(E.inv813, G.tawzi, G.box133, 0, 1047);
line(E.inv813, G.box133, G.tawzi, 1047, 0);
// سند قبض عادي (553): ابو فيصل 869.57 مقابل 134.
MUST_PAY["ابو فيصل 869.57 سند قبض مقابل 134"] = line(E.receipt553, G.abuFaisal, G.box134, 0, 869.565217);
line(E.receipt553, G.box134, G.abuFaisal, 869.565217, 0);
// مرتجع #32: دائن 420.02 مقابل 42، ومدين حسمه 0.02 مقابل 43.
MUST_NOT["مرتجع #32 420.02 مقابل 42"] = line(E.ret32, G.abuNawaf, G.returns42, 0, 420.02);
line(E.ret32, G.abuNawaf, G.discount43, 0.02, 0);
line(E.ret32, G.returns42, G.abuNawaf, 420.02, 0);
// بدر ce 2029: دفعة 200 بمقابل صفري دخلت صندوقين (190 + 10) — لا مطابقة مبلغ.
MUST_PAY["بدر خلوف ce 2029 (200 = 190 + 10)"] = line(E.ce2029, G.badr, ZERO, 0, 200);
line(E.ce2029, G.box138, ZERO, 190, 0);
line(E.ce2029, G.box134, ZERO, 10, 0);
// بدر ce 2143: 450 بمقابل صفري، ومدين 138.
MUST_PAY["بدر خلوف ce 2143 (450)"] = line(E.ce2143, G.badr, null, 0, 450);
line(E.ce2143, G.box138, null, 450, 0);
// مركز الخيال ce 2196: دفعتان بمقابل صفري، ثم خروج المبلغ من 134 للمصاريف في القيد نفسه.
MUST_PAY["مركز الخيال ce 2196 (760)"] = line(E.ce2196, G.khayal, ZERO, 0, 760);
MUST_PAY["مركز الخيال ce 2196 (456)"] = line(E.ce2196, G.khayal, ZERO, 0, 456);
line(E.ce2196, G.box134, ZERO, 760, 0);
line(E.ce2196, G.box134, ZERO, 456, 0);
line(E.ce2196, G.box134, ZERO, 0, 1216);
line(E.ce2196, G.acct525, ZERO, 1216, 0);
// القيد الافتتاحي ce 1: دائن الزبون بمقابل صفري، وفي القيد مدين على الصناديق.
MUST_NOT["القيد الافتتاحي ce 1"] = line(E.opening1, G.abuNawaf, ZERO, 0, 875);
line(E.opening1, G.box133, ZERO, 5322.99, 0);
line(E.opening1, G.box134, ZERO, 67.23, 0);
// سلفة/رواتب 12506 (تحت 125 لا 121): الصندوق دائن فقط، ثم حالة فيها مدين صندوق — الشجرة تُخرجها.
MUST_NOT["رواتب سلفة عثمان ce 1769"] = line(E.salary1769, G.acct12506, ZERO, 0, 250);
line(E.salary1769, G.box134, ZERO, 0, 250);
MUST_NOT["سلفة عثمان مقابل صندوق (خارج شجرة 121)"] = line(E.salaryCash, G.acct12506, G.box134, 0, 250);
line(E.salaryCash, G.box134, G.acct12506, 250, 0);
// الحساب 515 تحت المصاريف: تسوية 673 مقابل 135، و1000 مقابل 137.
MUST_NOT["515 تسوية 673 مقابل 135"] = line(E.adj4626, G.acct515, G.diff135, 0, 673);
line(E.adj4626, G.diff135, G.acct515, 673, 0);
MUST_NOT["515 «دفعة» 1000 مقابل 137 (خارج شجرة 121)"] = line(E.thief, G.acct515, G.box137, 0, 1000);
line(E.thief, G.box137, G.acct515, 1000, 0);
// 135 فروقات الصندوق على زبون حقيقي: مباشرة، وبمقابل صفري لا مدين فيه إلا على 135.
MUST_NOT["زبون مقابل 135 فروقات الصندوق"] = line(E.diff135Customer, G.abuFaisal, G.diff135, 0, 3.5);
line(E.diff135Customer, G.diff135, G.abuFaisal, 3.5, 0);
MUST_NOT["مقابل صفري ومدين 135 وحده"] = line(E.diff135Zero, G.abuFaisal, ZERO, 0, 2.25);
line(E.diff135Zero, G.diff135, ZERO, 2.25, 0);
// تحويل 4.87 بين حسابَي زبون (الدولاري إلى السوري).
MUST_NOT["تحويل 4.87 بين زبونين"] = line(E.transfer487, G.barghoutSyp, G.barghoutUsd, 0, 4.87);
line(E.transfer487, G.barghoutUsd, G.barghoutSyp, 4.87, 0);
// Type ≠ 0 لا يُعدّ حتى لو مقابله صندوق.
MUST_NOT["سطر Type = 1 مقابل صندوق"] = line(E.typeOne, G.abuFaisal, G.box133, 0, 12, 1);
line(E.typeOne, G.box133, G.abuFaisal, 12, 0, 1);
// مقابل صفري في قيد بلا رأس ce000: لا يُثبت نوع القيد ⇒ لا دفعة.
MUST_NOT["مقابل صفري بلا رأس قيد"] = line("fx-no-header", G.abuFaisal, ZERO, 0, 9);
line("fx-no-header", G.box133, ZERO, 9, 0);

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
  for (const [label, guid] of [["جذر الصناديق", G.cashRoot], ["135 مستبعد", G.diff135], ["شجرة 121", G.customers121], ["القيد الافتتاحي", G.openingType]]) {
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
