// ============================================================================
// فحص انحداري: **حساب ليري مسدَّد بعملته لا يظهر ذمةً في تقرير الذمم.**
//
// العطل الحقيقي (مُثبت قراءةً على الأمين 2026-09-26): تقرير الذمم يعرض
// `balance = ac000.Debit − ac000.Credit` بعملة الأساس (الدولار). والأمين يخزّن كل
// سطر ليرة بالدولار حسب سعر يومه، فحساب سُدِّد كاملاً بالليرة يبقى عليه فرق صرف
// بالدولار يظهر ذمةً، وحساب مدين بالليرة قد يظهر دائناً بالدولار (اتجاه مقلوب).
//
// الإصلاح: الاستعلام يعلن رصيد الحساب بعملته (`balance_account_ccy`) إلى جانب
// `balance` الذي لا يتغيّر، وتقرير الذمم وحده يحكم على الحساب غير الدولاري بعملته:
// أقل من 1 بعملة الحساب = مسدَّد ولا يُعرض.
//
// الفحص يشغّل **كتلة SQL الحقيقية** (بين علامتَي account-ccy) على SQLite،
// و**الدوال الحقيقية** من src/app.js داخل vm. كل البيانات مصطنعة.
// ============================================================================

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

const sql = readFileSync(new URL("../tools/ameen-customer-balances-query.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const agent = readFileSync(new URL("../tools/ameen-sync-agent.ps1", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// SQLite: node:sqlite إن وُجد، وإلا python3 (نفس أسلوب check-customer-payment-rule).
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

const stripComments = (text) => text.replace(/--[^\n]*/g, "").replace(/\bdbo\./g, "");

// ---------------------------------------------------------------------------
// 1) كتلة SQL: الرصيد بعملة الحساب
const begin = sql.indexOf("-- account-ccy:begin");
const end = sql.indexOf("-- account-ccy:end");
let innerSelect = "";
test("علامتا account-ccy موجودتان وتحيطان بـ outer apply واحد", () => {
  assert.ok(begin > 0 && end > begin, "علامتا account-ccy مفقودتان");
  const block = stripComments(sql.slice(begin, end)).trim();
  const m = block.match(/^outer apply \(([\s\S]*)\)\s*account_ccy\s*$/);
  assert.ok(m, "الكتلة ليست outer apply ... account_ccy");
  innerSelect = m[1];
});

const USD = "a0000000-0000-4000-8000-000000000001";
const SYP = "a0000000-0000-4000-8000-000000000002";
const EUR = "a0000000-0000-4000-8000-000000000003";
const acct = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// en000.Debit/Credit بالدولار؛ CurrencyVal = دولار لكل وحدة من عملة السطر.
const syp = (amount, rate) => amount / rate;
const enRows = [];
let seq = 0;
const line = (account, currency, debitUsd, creditUsd, currencyVal) =>
  enRows.push([`e${++seq}`, account, currency, debitUsd, creditUsd, currencyVal]);

// (أ) الشاهد: بيع بالليرة بسعر 13250 ومرتجع بسعر 13600 وقبض بسعر 14000 يصفّر الليرة.
line(acct(1), SYP, syp(10_000_000, 13_250), 0, 1 / 13_250);
line(acct(1), SYP, syp(40_000_000, 13_350), 0, 1 / 13_350);
line(acct(1), SYP, 0, syp(8_000_000, 13_600), 1 / 13_600);
line(acct(1), SYP, 0, syp(42_000_000, 14_000), 1 / 14_000);
// (ب) باقٍ حقيقي +500 ل.س، والدولار سالب بسبب الصرف.
line(acct(2), SYP, syp(1_000_500, 13_000), 0, 1 / 13_000);
line(acct(2), SYP, 0, syp(1_000_000, 12_000), 1 / 12_000);
// (ج) سطر بعملة أخرى على حساب ليري ⇒ غير معروف (NULL).
line(acct(3), SYP, syp(100_000, 13_000), 0, 1 / 13_000);
line(acct(3), EUR, 5, 0, 1.1);
// (د) سطر بسعر صفري ⇒ غير معروف (NULL) بلا قسمة على صفر.
line(acct(4), SYP, 10, 0, 0);
// (هـ) حساب دولاري عادي.
line(acct(5), USD, 120, 0, 1);
line(acct(5), USD, 0, 20, 1);
// (و) acct(6) بلا أي سطر ⇒ صفر.

const accounts = [
  [acct(1), SYP], [acct(2), SYP], [acct(3), SYP], [acct(4), SYP], [acct(5), USD], [acct(6), SYP]
];

function nativeBalance(accountGuid, currencyGuid) {
  const query = `select * from (${innerSelect.replace(/cu\.AccountGUID/g, `'${accountGuid}'`).replace(/ac\.CurrencyGUID/g, `'${currencyGuid}'`)})`;
  const rows = runSql({
    en000: { columns: ["GUID text", "AccountGUID text", "CurrencyGUID text", "Debit real", "Credit real", "CurrencyVal real"], rows: enRows }
  }, query);
  assert.equal(rows.length, 1, "outer apply يجب أن يعيد صفاً واحداً لكل حساب");
  return rows[0].balance_account_ccy;
}

test("لا مرجع خارجي (ac./cu.) داخل أي SUM — SQL Server يرفضه", () => {
  for (const m of innerSelect.matchAll(/sum\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi)) {
    assert.doesNotMatch(m[1], /\b(ac|cu)\./i, `مرجع خارجي داخل SUM: ${m[0]}`);
  }
});
test("حساب ليري مسدَّد بعملته: الرصيد بعملته صفر رغم فرق الدولار", () => {
  const usd = enRows.filter((r) => r[1] === acct(1)).reduce((s, r) => s + r[3] - r[4], 0);
  assert.ok(Math.abs(usd) > 1, `الشاهد المصطنع يجب أن يحمل فرق صرف بالدولار (${usd})`);
  const v = nativeBalance(acct(1), SYP);
  assert.ok(v !== null && Math.abs(v) < 0.01, `الرصيد بالليرة ${v} وليس صفراً`);
});
test("الاتجاه يُحكم بعملة الحساب: +500 ل.س رغم دولار سالب", () => {
  const usd = enRows.filter((r) => r[1] === acct(2)).reduce((s, r) => s + r[3] - r[4], 0);
  assert.ok(usd < 0, "الشاهد المصطنع يجب أن يكون سالباً بالدولار");
  const v = nativeBalance(acct(2), SYP);
  assert.ok(Math.abs(v - 500) < 0.01, `الرصيد بالليرة ${v} وليس 500`);
});
test("سطر بعملة غير عملة الحساب ⇒ NULL (لا رصيد ناقص)", () => {
  assert.equal(nativeBalance(acct(3), SYP), null);
});
test("سطر بلا سعر صالح ⇒ NULL بلا قسمة على صفر", () => {
  assert.equal(nativeBalance(acct(4), SYP), null);
});
test("حساب دولاري: الرصيد بعملته = رصيده بالدولار", () => {
  assert.ok(Math.abs(nativeBalance(acct(5), USD) - 100) < 0.001);
});
test("حساب بلا حركات ⇒ صفر", () => {
  assert.equal(Number(nativeBalance(acct(6), SYP)), 0);
});

test("account_currency_is_base: CurrencyVal = 1 أساس، وغيره لا، وغياب العملة NULL", () => {
  const m = stripComments(sql).match(/(case when acc_cur\.GUID is null[\s\S]*?end) as account_currency_is_base/);
  assert.ok(m, "تعبير account_currency_is_base مفقود");
  const rows = runSql({
    ac000: { columns: ["GUID text", "CurrencyGUID text"], rows: [["x1", USD], ["x2", SYP], ["x3", null]] },
    my000: { columns: ["GUID text", "Code text", "CurrencyVal real"], rows: [[USD, "$", 1], [SYP, "ل.س.", 1 / 12_000]] }
  }, `select ac.GUID as g, ${m[1]} as b from ac000 ac left join my000 acc_cur on acc_cur.GUID = ac.CurrencyGUID order by ac.GUID`);
  assert.deepEqual(rows.map((r) => r.b), [1, 0, null]);
});

test("balance القديم لم يتغيّر: ما زال ac000.Debit − ac000.Credit", () => {
  assert.match(sql, /cast\(coalesce\(ac\.Debit, 0\) - coalesce\(ac\.Credit, 0\) as decimal\(18, 3\)\) as balance,/);
  assert.match(sql, /left join dbo\.my000 acc_cur on acc_cur\.GUID = ac\.CurrencyGUID/);
});

test("وكيل المزامنة يمرّر الحقول الثلاثة ويُبقي الغياب null لا صفراً", () => {
  assert.match(agent, /accountCurrency = \[string\]\$row\.account_currency/);
  assert.match(agent, /accountCurrencyIsBase = if \(\$null -eq \$row\.account_currency_is_base\) \{ \$null \}/);
  assert.match(agent, /balanceAccountCcy = if \(\$null -eq \$row\.balance_account_ccy\) \{ \$null \}/);
  assert.match(agent, /balance = \[math\]::Round\(\$balance, 3\)/);
});

// ---------------------------------------------------------------------------
// 2) الواجهة: الدوال الحقيقية من src/app.js
function extract(patterns) {
  const out = [];
  for (const [name, pattern] of Object.entries(patterns)) {
    const found = appJs.match(pattern);
    if (!found) throw new Error(`لم أجد ${name} في src/app.js`);
    out.push(found[0]);
  }
  return out.join("\n");
}

let box = null;
test("استخراج دوال تقرير الذمم", () => {
  const source = extract({
    customerBalance: /function customerBalance\(item\) \{[\s\S]*?\n\}\n/,
    customerLastPaymentAmount: /function customerLastPaymentAmount\(item\) \{[\s\S]*?\n\}\n/,
    customerLastPaymentDate: /function customerLastPaymentDate\(item\) \{[\s\S]*?\n\}\n/,
    customerLimit: /function customerLimit\(item\) \{[\s\S]*?\n\}\n/,
    customerBalanceTotals: /function customerBalanceTotals\(items\) \{[\s\S]*?\n\}\n/,
    customerBalanceSortValue: /function customerBalanceSortValue\(item\) \{[\s\S]*?\n\}\n/,
    threshold: /const RECEIVABLES_NATIVE_SETTLED_BELOW = [^;]+;/,
    receivablesNativeBalance: /function receivablesNativeBalance\(item\) \{[\s\S]*?\n\}\n/,
    receivablesReportGroups: /function receivablesReportGroups\(items\) \{[\s\S]*?\n\}\n/,
    receivablesPdfMarkup: /function receivablesPdfMarkup\(\) \{[\s\S]*?\n\}\n/
  });
  box = {
    REPORT_STYLE: "",
    escapeHtml: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    formatMoney: (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(Number(v || 0)),
    todayIsoDate: () => "2026-01-01",
    latestCustomerBalanceItems: () => box.__items
  };
  vm.createContext(box);
  vm.runInContext(`${source}\nthis.receivablesReportGroups = receivablesReportGroups; this.receivablesPdfMarkup = receivablesPdfMarkup;`, box);
});

const fixture = () => [
  { name: "حساب ليري مسدَّد", balance: 111.111, accountCurrency: "ل.س.", accountCurrencyIsBase: false, balanceAccountCcy: 0 },
  { name: "حساب ليري بكسر ليرة", balance: -3.3, accountCurrency: "ل.س.", accountCurrencyIsBase: false, balanceAccountCcy: 0.4 },
  { name: "حساب ليري اتجاهه مقلوب", balance: -20.5, accountCurrency: "ل.س.", accountCurrencyIsBase: false, balanceAccountCcy: 500 },
  { name: "حساب ليري دائن", balance: -0.9, accountCurrency: "ل.س.", accountCurrencyIsBase: false, balanceAccountCcy: -500 },
  { name: "حساب دولاري", balance: 100, accountCurrency: "$", accountCurrencyIsBase: true, balanceAccountCcy: 100 },
  { name: "تقرير قديم بلا حقول", balance: 50 },
  { name: "ليري رصيده بعملته مجهول", balance: 10, accountCurrency: "ل.س.", accountCurrencyIsBase: false, balanceAccountCcy: null },
  { name: "دولاري مسدَّد", balance: 0, accountCurrencyIsBase: true, balanceAccountCcy: 0 }
];

test("الحساب الليري المسدَّد بعملته (0 أو أقل من 1) لا يُعدّ ذمة", () => {
  const g = box.receivablesReportGroups(fixture());
  assert.equal(g.settled, 2);
  const names = [...g.base.map((i) => i.name), ...g.native.map((n) => n.item.name)];
  assert.ok(!names.includes("حساب ليري مسدَّد"));
  assert.ok(!names.includes("حساب ليري بكسر ليرة"));
});
test("الحساب الليري ذو الباقي الحقيقي يُعرض بعملته واتجاهها", () => {
  const g = box.receivablesReportGroups(fixture());
  const flipped = g.native.find((n) => n.item.name === "حساب ليري اتجاهه مقلوب");
  assert.ok(flipped && flipped.amount === 500 && flipped.currency === "ل.س.");
  const t = g.nativeTotals.get("ل.س.");
  assert.deepEqual({ ...t }, { debit: 500, credit: 500, debitCustomers: 1, creditCustomers: 1 });
});
test("الدولاري والتقرير القديم ومجهول العملة يبقون على balance كما كان", () => {
  const g = box.receivablesReportGroups(fixture());
  // مقارنة نصية: مصفوفة vm من عالم آخر فلا تطابق deepEqual الصارمة.
  assert.equal(g.base.map((i) => i.name).sort().join(" | "), ["تقرير قديم بلا حقول", "حساب دولاري", "ليري رصيده بعملته مجهول"].sort().join(" | "));
});
test("balance لا يُعدَّل على العناصر", () => {
  const items = fixture();
  box.receivablesReportGroups(items);
  assert.deepEqual(items.map((i) => i.balance), fixture().map((i) => i.balance));
});
test("مستند الذمم: إجمالي الدولار بلا حسابات الليرة، والليرة بسطر مستقل", () => {
  box.__items = fixture();
  const html = box.receivablesPdfMarkup();
  assert.ok(!html.includes("حساب ليري مسدَّد"), "حساب مسدَّد بعملته ظهر في التقرير");
  assert.ok(!html.includes("حساب ليري بكسر ليرة"), "حساب رصيده أقل من 1 ل.س ظهر في التقرير");
  assert.match(html, /الإجمالي بالدولار \(3 زبون\)<\/td><td class="deb">160<\/td><td class="cred">0<\/td>/);
  assert.match(html, /حساب ليري اتجاهه مقلوب<\/td><td class="deb">500 ل\.س\.<\/td><td class="cred">—<\/td>/);
  assert.match(html, /الإجمالي بـل\.س\. \(2 زبون\)<\/td><td class="deb">500<\/td><td class="cred">500<\/td>/);
  assert.match(html, /2 حساب بعملة غير الدولار مسدَّد بعملته/);
  assert.ok(!html.includes("111.111"), "فرق الصرف ظهر رقماً في التقرير");
});
test("تقرير قديم كلّه بلا الحقول الجديدة يُنتج الأرقام السابقة نفسها", () => {
  box.__items = [{ name: "أ", balance: 30 }, { name: "ب", balance: -12.5 }, { name: "ج", balance: 0 }];
  const html = box.receivablesPdfMarkup();
  assert.match(html, /الإجمالي بالدولار \(2 زبون\)<\/td><td class="deb">30<\/td><td class="cred">12.5<\/td>/);
  assert.ok(!html.includes("الإجمالي بـ"), "ظهر سطر عملة بلا حسابات بعملة أخرى");
  assert.ok(!html.includes("مسدَّد بعملته"));
});

test("الحقول الجديدة لا يقرؤها في الواجهة إلا تقرير الذمم", () => {
  const uses = [...appJs.matchAll(/balanceAccountCcy|accountCurrencyIsBase/g)].map((m) => m.index);
  const fnStart = appJs.indexOf("function receivablesNativeBalance(item)");
  const fnEnd = appJs.indexOf("\n}\n", fnStart);
  assert.ok(uses.length > 0 && uses.every((i) => i > fnStart && i < fnEnd),
    "balanceAccountCcy/accountCurrencyIsBase مستعمل خارج receivablesNativeBalance");
});

console.log("فحص تقرير الذمم بعملة الحساب:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n${failed} فشل`);
  process.exit(1);
}
console.log(`\nاجتاز ${results.length} فحصاً.`);
