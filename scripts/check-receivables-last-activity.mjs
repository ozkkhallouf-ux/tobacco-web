// ============================================================================
// فحص انحداري: **«آخر فاتورة» و«آخر دفعة» في تقرير الذمم.**
//
// المطلوب (2026-10-22): أن يُعرف من تقرير الذمم مباشرةً منذ متى اشترى الزبون آخر مرة
// ومنذ متى دفع، والمورد منذ متى اشترينا منه ومنذ متى دفعنا له — بلا فتح كشف الحساب.
//
// المصدر كتلة last-activity في tools/ameen-customer-balances-query.sql. الفحص يشغّل
// **كتلة SQL الحقيقية** على SQLite بقيود ومستندات مصطنعة كلياً تحاكي أشكال المستندات
// وحدها (الحسم مقابل 43، المرتجع مقابل 42، القيد الافتتاحي، القيد المركب، فاتورة غير
// مرحّلة، مرتجع بيع وشراء، 135 فروقات الصندوق، حساب بدورين). المعرّفات الحقيقية الوحيدة
// معرّفات بنية الدليل والأنواع التي تحملها الكتلة نفسها — إعداد لا بيانات زبائن.
//
// ثم يشغّل **الدوال الحقيقية** من src/app.js داخل vm: صياغة المدة بالعربية، يوم دمشق قرب
// منتصف الليل، الحالات الصريحة (لا توجد/بانتظار المزامنة/مستقبلي/غير صالح)، فصل الدورين،
// الترتيب، ومستند الذمم PDF — مع إثبات أن أرصدة المستند لا تتغيّر بوجود العمودين.
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
const agent = readFileSync(new URL("../tools/ameen-sync-agent.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

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

// ---------------------------------------------------------------------------
// 1) كتلة SQL الحقيقية
const begin = sql.indexOf("-- last-activity:begin");
const end = sql.indexOf("-- last-activity:end");
const block = sql.slice(begin, end).replace(/--[^\n]*/g, "").replace(/\bdbo\./g, "").trim();

const SALE_TYPE = "b0000000-0000-4000-8000-000000000001";
const SALE_TYPE_2 = "b0000000-0000-4000-8000-000000000002"; // نوع بيع ثانٍ (BillType = 1 أيضاً)
const SALE_RETURN_TYPE = "b0000000-0000-4000-8000-000000000003";
const PURCHASE_TYPE = "91377a56-ebfc-48c0-b79e-72063e1d7e3a";
const PURCHASE_RETURN_TYPE = "c9aca8fe-f50e-46eb-91ac-29ee32acbb3e";
const OPENING_ENTRY_TYPE = "ea69ba80-662d-4fa4-90ee-4d2e1988a8ea";
const ZERO = "00000000-0000-0000-0000-000000000000";
const CASH = "d0000000-0000-4000-8000-000000000131";
const CASH_DIFF_135 = "ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8";
const DISCOUNT_43 = "d0000000-0000-4000-8000-000000000043";
const RETURN_42 = "d0000000-0000-4000-8000-000000000042";
const PURCHASES = "d0000000-0000-4000-8000-000000000071";
const SALES = "d0000000-0000-4000-8000-000000000041";
const card = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const acct = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// البطاقات: 1 زبون عادي، 2 زبون بفواتير بلا دفعات، 3 مورد، 4 حساب بدورين، 5 بلا شيء.
const cards = [1, 2, 3, 4, 5].map((n) => [card(n), acct(n)]);
const bills = [];
const bill = (n, type, custCard, date, posted = 1) => bills.push([`u${n}`, type, custCard, date, posted]);
// زبون 1: بيع اليوم، وبيع أحدث غير مرحّل، ومرتجع بيع أحدث — الاثنان خارج «آخر فاتورة».
bill(1, SALE_TYPE, card(1), "2026-10-20T00:00:00", 1);
bill(2, SALE_TYPE_2, card(1), "2026-10-22T00:00:00", 1);
bill(3, SALE_TYPE, card(1), "2026-10-25T00:00:00", 0);
bill(4, SALE_RETURN_TYPE, card(1), "2026-10-26T00:00:00", 1);
// زبون 2: فاتورة واحدة.
bill(5, SALE_TYPE, card(2), "2026-09-01T00:00:00", 1);
// مورد 3: شراء قبل يومين، ومرتجع شراء أحدث خارجها.
bill(6, PURCHASE_TYPE, card(3), "2026-10-20T00:00:00", 1);
bill(7, PURCHASE_RETURN_TYPE, card(3), "2026-10-21T00:00:00", 1);
// حساب بدورين 4.
bill(8, SALE_TYPE, card(4), "2026-10-10T00:00:00", 1);
bill(9, PURCHASE_TYPE, card(4), "2026-10-15T00:00:00", 1);
// فاتورة بلا بطاقة (نقدية بلا اسم) لا تُنسب لأحد.
bill(10, SALE_TYPE, ZERO, "2026-10-22T00:00:00", 1);

const ce = [];
const en = [];
let seq = 0;
const entry = (id, type = "e0000000-0000-4000-8000-0000000000aa") => ce.push([id, type]);
const line = (parent, account, contra, debit, credit, date, type = 0) => en.push([`l${++seq}`, parent, account, contra, debit, credit, date, type]);
// زبون 1: قبض أمس عبر الصندوق، ثم حسم ومرتجع اليوم (دائنان ليسا قبضاً)، وسطر Type ≠ 0.
entry("ce1"); line("ce1", acct(1), CASH, 0, 50, "2026-10-21T00:00:00"); line("ce1", CASH, acct(1), 50, 0, "2026-10-21T00:00:00");
entry("ce2"); line("ce2", acct(1), DISCOUNT_43, 0, 3, "2026-10-22T00:00:00");
entry("ce3"); line("ce3", acct(1), RETURN_42, 0, 9, "2026-10-22T00:00:00");
entry("ce4"); line("ce4", acct(1), CASH, 0, 1, "2026-10-23T00:00:00", 1);
// مقابل 135 فروقات الصندوق ليس قبضاً.
entry("ce5"); line("ce5", acct(1), CASH_DIFF_135, 0, 2, "2026-10-24T00:00:00");
// قيد بيع آجل: مدين على الزبون مقابل المبيعات — ليس دفعاً له.
entry("ce6"); line("ce6", acct(1), SALES, 100, 0, "2026-10-22T00:00:00");
// زبون 2: قيد افتتاحي بمقابل صفري ومدين على الصندوق — مستبعد بنوعه.
entry("ce7", OPENING_ENTRY_TYPE); line("ce7", acct(2), ZERO, 0, 40, "2026-01-01T00:00:00"); line("ce7", CASH, ZERO, 40, 0, "2026-01-01T00:00:00");
// قيد مركب بمقابل صفري بلا أي سطر صندوق — تسوية لا دفعة.
entry("ce8"); line("ce8", acct(2), ZERO, 0, 5, "2026-09-05T00:00:00"); line("ce8", PURCHASES, ZERO, 5, 0, "2026-09-05T00:00:00");
// مورد 3: فاتورة الشراء دائنة عليه مقابل المشتريات (ليست قبضاً)، ودفعة له قبل 3 أيام
// في قيد مركب بمقابل صفري ودائن على الصندوق، ومرتجع الشراء مدين مقابل المشتريات (ليس دفعاً).
entry("ce9"); line("ce9", acct(3), PURCHASES, 0, 300, "2026-10-20T00:00:00");
entry("ce10"); line("ce10", acct(3), ZERO, 120, 0, "2026-10-19T00:00:00"); line("ce10", CASH, ZERO, 0, 120, "2026-10-19T00:00:00");
entry("ce11"); line("ce11", acct(3), PURCHASES, 30, 0, "2026-10-21T00:00:00");
// حساب 4 بدورين: قبض منه ودفع له.
entry("ce12"); line("ce12", acct(4), CASH, 0, 10, "2026-10-12T00:00:00");
entry("ce13"); line("ce13", acct(4), CASH, 20, 0, "2026-10-16T00:00:00");

const tables = {
  cash_accounts_fixture: { columns: ["GUID text"], rows: [[CASH]] },
  cu000: { columns: ["GUID text", "AccountGUID text"], rows: cards },
  bt000: { columns: ["GUID text", "BillType integer"], rows: [[SALE_TYPE, 1], [SALE_TYPE_2, 1], [SALE_RETURN_TYPE, 3], [PURCHASE_TYPE, 0], [PURCHASE_RETURN_TYPE, 0]] },
  bu000: { columns: ["GUID text", "TypeGUID text", "CustGUID text", "Date text", "IsPosted integer"], rows: bills },
  ce000: { columns: ["GUID text", "TypeGUID text"], rows: ce },
  en000: { columns: ["GUID text", "ParentGUID text", "AccountGUID text", "ContraAccGUID text", "Debit real", "Credit real", "Date text", "Type integer"], rows: en }
};

let rows = [];
test("علامتا last-activity تحيطان بـCTEين مجمَّعين (لا استعلام لكل حساب)", () => {
  assert.ok(begin > 0 && end > begin, "علامتا last-activity مفقودتان");
  assert.match(block, /^, last_bills as \(/);
  assert.match(block, /group by u\.CustGUID/);
  assert.match(block, /group by en\.AccountGUID/);
  assert.doesNotMatch(block, /outer apply|cu\.GUID|cu\.AccountGUID/i, "الكتلة تشير إلى البطاقة الخارجية — ستصير استعلاماً لكل حساب");
  const query = `with cash_accounts as (select GUID from cash_accounts_fixture)\n${block}\n`
    + "select cu.GUID as g, last_bills.last_sale_invoice_date as sale, last_bills.last_purchase_invoice_date as purchase,"
    + " last_cash.last_receipt_date as receipt, last_cash.last_disbursement_date as paid"
    + " from cu000 cu left join last_bills on last_bills.cust_guid = cu.GUID left join last_cash on last_cash.acct = cu.AccountGUID order by cu.GUID";
  rows = runSql(tables, query);
  assert.equal(rows.length, 5, "الربط ضاعف البطاقات أو أسقطها");
});
const R = (n) => rows.find((r) => r.g === card(n)) || {};
test("زبون: آخر فاتورة = أحدث فاتورة بيع مرحّلة (نوعا بيع)، بلا غير المرحّلة ولا المرتجع", () => {
  assert.equal(R(1).sale, "2026-10-22T00:00:00");
  assert.equal(R(1).purchase, null);
});
test("زبون: آخر دفعة = قبض عبر الصندوق، لا الحسم (43) ولا المرتجع (42) ولا 135 ولا Type ≠ 0", () => {
  assert.equal(R(1).receipt, "2026-10-21T00:00:00");
});
test("قيد البيع الآجل على الزبون ليس «دفعاً له»", () => {
  assert.equal(R(1).paid, null);
});
test("زبون بفواتير بلا دفعات: القيد الافتتاحي والتسوية بلا صندوق ليسا دفعة", () => {
  assert.equal(R(2).sale, "2026-09-01T00:00:00");
  assert.equal(R(2).receipt, null);
});
test("مورد: آخر شراء بلا مرتجع الشراء، وآخر دفعة له من قيد مركب على الصندوق", () => {
  assert.equal(R(3).purchase, "2026-10-20T00:00:00");
  assert.equal(R(3).paid, "2026-10-19T00:00:00");
  assert.equal(R(3).receipt, null, "فاتورة الشراء الدائنة على المورد حُسبت قبضاً");
  assert.equal(R(3).sale, null);
});
test("حساب بدورين: البيع والشراء والقبض والدفع كلٌّ في عموده", () => {
  assert.deepEqual({ ...R(4) }, { g: card(4), sale: "2026-10-10T00:00:00", purchase: "2026-10-15T00:00:00", receipt: "2026-10-12T00:00:00", paid: "2026-10-16T00:00:00" });
});
test("حساب بلا فواتير ولا دفعات: كل الأعمدة NULL", () => {
  assert.deepEqual([R(5).sale, R(5).purchase, R(5).receipt, R(5).paid], [null, null, null, null]);
});

test("الاستعلام يعرض الأعمدة الأربعة ويربط بمعرّف البطاقة وحسابها", () => {
  assert.match(sql, /last_bills\.last_sale_invoice_date,\n\s+last_bills\.last_purchase_invoice_date,\n\s+last_cash\.last_receipt_date,\n\s+last_cash\.last_disbursement_date\n/);
  assert.match(sql, /left join last_bills on last_bills\.cust_guid = cu\.GUID\nleft join last_cash on last_cash\.acct = cu\.AccountGUID\n/);
});
test("balance وآخر دفعة القديمة لم يتغيّرا", () => {
  assert.match(sql, /cast\(coalesce\(ac\.Debit, 0\) - coalesce\(ac\.Credit, 0\) as decimal\(18, 3\)\) as balance,/);
  assert.match(sql, /select top 1 en\.Credit as last_payment_amount, en\.Date as last_payment_date/);
});
test("وكيل المزامنة يمرّر الحقول الأربعة ويرفع العلامة فقط إن حملها الاستعلام", () => {
  for (const f of ["lastSaleInvoiceDate = To-IsoDate $row.last_sale_invoice_date", "lastPurchaseInvoiceDate = To-IsoDate $row.last_purchase_invoice_date",
    "lastReceiptDate = To-IsoDate $row.last_receipt_date", "lastDisbursementDate = To-IsoDate $row.last_disbursement_date"]) {
    assert.ok(agent.includes(f), `مفقود في الوكيل: ${f}`);
  }
  assert.match(agent, /lastActivity = \$\(if \(\$lastActivityComplete\) \{ "v1" \} else \{ \$null \}\)/);
  assert.match(agent, /PSObject\.Properties\.Name -notcontains \$_/);
});

// ---------------------------------------------------------------------------
// 2) الواجهة: الدوال الحقيقية
function extract(patterns) {
  return Object.entries(patterns).map(([name, pattern]) => {
    const found = appJs.match(pattern);
    if (!found) throw new Error(`لم أجد ${name} في src/app.js`);
    return found[0];
  }).join("\n");
}
let box = null;
test("استخراج دوال آخر فاتورة/آخر دفعة ومستند الذمم", () => {
  const source = extract({
    lastActivity: /const LAST_ACTIVITY_MARKER = [\s\S]*?\nfunction customerLastActivityHtml\(rows\) \{[\s\S]*?\n\}\n/,
    sorts: /const LAST_ACTIVITY_SORTS = \{[\s\S]*?\n\};\n/,
    sortCustomerItems: /function sortCustomerItems\(items, sort\) \{[\s\S]*?\n\}\n/,
    customerBalance: /function customerBalance\(item\) \{[\s\S]*?\n\}\n/,
    customerRemainingLimit: /function customerRemainingLimit\(item\) \{[\s\S]*?\n\}\n/,
    customerLimit: /function customerLimit\(item\) \{[\s\S]*?\n\}\n/,
    customerLastPaymentAmount: /function customerLastPaymentAmount\(item\) \{[\s\S]*?\n\}\n/,
    customerLastPaymentDate: /function customerLastPaymentDate\(item\) \{[\s\S]*?\n\}\n/,
    customerBalanceTotals: /function customerBalanceTotals\(items\) \{[\s\S]*?\n\}\n/,
    customerBalanceSortValue: /function customerBalanceSortValue\(item\) \{[\s\S]*?\n\}\n/,
    threshold: /const RECEIVABLES_NATIVE_SETTLED_BELOW = [^;]+;/,
    receivablesNativeBalance: /function receivablesNativeBalance\(item\) \{[\s\S]*?\n\}\n/,
    receivablesReportGroups: /function receivablesReportGroups\(items\) \{[\s\S]*?\n\}\n/,
    receivablesPdfMarkup: /function receivablesPdfMarkup\(\) \{[\s\S]*?\n\}\n/
  });
  box = {
    REPORT_STYLE: "",
    escapeHtml: (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    formatMoney: (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(Number(v || 0)),
    todayIsoDate: () => "2026-10-22",
    latestCustomerBalanceItems: () => box.__items,
    state: { customerBalanceReports: [] }
  };
  vm.createContext(box);
  vm.runInContext(`${source}
this.api = { arabicElapsed, lastActivityCell, lastActivityToday, customerLastActivity, customerLastActivitySortDay,
  customerLastActivityText, customerLastActivityHtml, lastActivityFullDate, sortCustomerItems, receivablesPdfMarkup, customerReportHasLastActivity };`, box);
});
const api = () => box.api;
// 22-10-2026 12:00 بتوقيت دمشق (+03).
const NOON = new Date("2026-10-22T09:00:00Z");

test("المدة بالعربية: اليوم، أمس، يومين، 3 أيام، 15 يوماً، شهرين، سنة", () => {
  const cases = { 0: "اليوم", 1: "أمس", 2: "منذ يومين", 3: "منذ 3 أيام", 10: "منذ 10 أيام", 11: "منذ 11 يوماً", 15: "منذ 15 يوماً",
    29: "منذ 29 يوماً", 30: "منذ شهر", 60: "منذ شهرين", 95: "منذ 3 أشهر", 340: "منذ 11 شهراً", 365: "منذ سنة", 730: "منذ سنتين", 1200: "منذ 3 سنوات" };
  for (const [d, label] of Object.entries(cases)) assert.equal(api().arabicElapsed(Number(d)), label, `${d} يوم`);
});
test("زبون اشترى اليوم ودفع أمس", () => {
  const a = api().customerLastActivity({ accountClass: "customer", lastSaleInvoiceDate: "2026-10-22T00:00:00", lastReceiptDate: "2026-10-21T00:00:00" }, true, NOON);
  assert.equal(a.invoice.map((r) => r.label).join(), "اليوم");
  assert.equal(a.payment.map((r) => r.label).join(), "أمس");
  assert.equal(a.invoice[0].title, "الخميس 2026-10-22");
});
test("زبون بفواتير بلا دفعات: «لا توجد دفعات»، وبلا شيء: «لا توجد فواتير»", () => {
  const a = api().customerLastActivity({ accountClass: "customer", lastSaleInvoiceDate: "2026-10-07T00:00:00" }, true, NOON);
  assert.equal(a.invoice[0].label, "منذ 15 يوماً");
  assert.equal(a.payment[0].label, "لا توجد دفعات");
  assert.equal(a.payment[0].state, "none");
  const n = api().customerLastActivity({ accountClass: "customer" }, true, NOON);
  assert.equal(n.invoice[0].label, "لا توجد فواتير");
});
test("مورد: فاتورة شراء منذ يومين ودفعة له منذ 3 أيام — لا يقرأ البيع ولا القبض", () => {
  const a = api().customerLastActivity({ accountClass: "supplier", lastPurchaseInvoiceDate: "2026-10-20T00:00:00", lastDisbursementDate: "2026-10-19T00:00:00", lastReceiptDate: "2026-10-21T00:00:00" }, true, NOON);
  assert.equal(api().customerLastActivityText(a.invoice), "منذ يومين (2026-10-20)");
  assert.equal(api().customerLastActivityText(a.payment), "منذ 3 أيام (2026-10-19)");
});
test("تقرير قديم بلا accountClass: isSupplier يحدد الدور", () => {
  const a = api().customerLastActivity({ isSupplier: true, lastPurchaseInvoiceDate: "2026-10-20T00:00:00" }, true, NOON);
  assert.equal(a.invoice[0].kind, "purchase");
});
test("حساب بدورين: سطران موسومان لكل عمود بلا خلط", () => {
  const a = api().customerLastActivity({ accountClass: "customer", lastSaleInvoiceDate: "2026-10-10T00:00:00", lastPurchaseInvoiceDate: "2026-10-15T00:00:00",
    lastReceiptDate: "2026-10-12T00:00:00", lastDisbursementDate: "2026-10-16T00:00:00" }, true, NOON);
  assert.equal(api().customerLastActivityText(a.invoice), "بيع: منذ 12 يوماً (2026-10-10) | شراء: منذ 7 أيام (2026-10-15)");
  assert.equal(api().customerLastActivityText(a.payment), "قبض: منذ 10 أيام (2026-10-12) | دفع: منذ 6 أيام (2026-10-16)");
});
test("زبون له «دفع» (مردود نقدي) بلا أي شراء: لا يظهر سطر دفع", () => {
  const a = api().customerLastActivity({ accountClass: "customer", lastSaleInvoiceDate: "2026-10-10T00:00:00", lastDisbursementDate: "2026-10-16T00:00:00" }, true, NOON);
  assert.equal(a.payment.length, 1);
  assert.equal(a.payment[0].label, "لا توجد دفعات");
});
test("قرب منتصف الليل: اليوم يُحسب بتوقيت دمشق لا UTC ولا وقت المزامنة", () => {
  const before = new Date("2026-10-21T20:59:00Z"); // 23:59 دمشق، 21-10
  const after = new Date("2026-10-21T21:01:00Z");  // 00:01 دمشق، 22-10 (وما زال 21-10 في UTC)
  const item = { accountClass: "customer", lastSaleInvoiceDate: "2026-10-21T00:00:00", lastReceiptDate: "2026-10-22T00:00:00" };
  assert.equal(api().customerLastActivity(item, true, before).invoice[0].label, "اليوم");
  assert.equal(api().customerLastActivity(item, true, before).payment[0].label, "تاريخ مستقبلي");
  assert.equal(api().customerLastActivity(item, true, after).invoice[0].label, "أمس");
  assert.equal(api().customerLastActivity(item, true, after).payment[0].label, "اليوم");
});
test("تاريخ بإزاحة صريحة يُقرأ يومه كما كُتب (لا انزلاق يوم)", () => {
  const c = api().lastActivityCell("2026-10-22T00:00:00.0000000+03:00", "x", true, NOON);
  assert.equal(c.label, "اليوم");
});
test("تاريخ مستقبلي وتاريخ غير صالح: حالة صريحة لا مدة", () => {
  const f = api().lastActivityCell("2026-10-30T00:00:00", "x", true, NOON);
  assert.equal(f.state, "future");
  assert.equal(f.title, "الجمعة 2026-10-30");
  assert.equal(api().lastActivityCell("2026-02-30", "x", true, NOON).state, "invalid");
  assert.equal(api().lastActivityCell("garbage", "x", true, NOON).label, "تاريخ غير صالح");
});
test("تقرير بلا العلامة: «بانتظار المزامنة» لا «لا توجد فواتير»", () => {
  const a = api().customerLastActivity({ accountClass: "customer" }, false, NOON);
  assert.equal(a.invoice[0].label, "بانتظار المزامنة");
  assert.equal(a.payment[0].state, "pending");
  box.state.customerBalanceReports = [{ summary: { lastActivity: "v1" } }];
  assert.equal(api().customerReportHasLastActivity(), true);
  box.state.customerBalanceReports = [{ summary: {} }];
  assert.equal(api().customerReportHasLastActivity(), false);
});
test("الوقت الظاهر في التلميح فقط حين يحمل التاريخ ساعة غير منتصف الليل", () => {
  assert.equal(api().lastActivityFullDate("2026-10-21T23:40:00"), "الأربعاء 2026-10-21 23:40");
  assert.equal(api().lastActivityFullDate("2026-10-21T00:00:00"), "الأربعاء 2026-10-21");
});
test("HTML: التاريخ الكامل في title والنص مُهرَّب", () => {
  const a = api().customerLastActivity({ accountClass: "customer", lastSaleInvoiceDate: "2026-10-22T00:00:00" }, true, NOON);
  assert.equal(api().customerLastActivityHtml(a.invoice), '<span class="last-activity last-activity-ok" title="الخميس 2026-10-22">اليوم</span>');
});

test("الترتيب حسب آخر فاتورة/آخر دفعة: الأحدث والأقدم، وبلا تاريخ في الآخر دائماً", () => {
  box.state.customerBalanceReports = [{ summary: { lastActivity: "v1" } }];
  const items = [
    { name: "a", balance: 1, accountClass: "customer", lastSaleInvoiceDate: "2026-10-01T00:00:00", lastReceiptDate: "2026-10-20T00:00:00" },
    { name: "b", balance: 5, accountClass: "customer" },
    { name: "c", balance: 2, accountClass: "supplier", lastPurchaseInvoiceDate: "2026-10-21T00:00:00" },
    { name: "d", balance: 3, accountClass: "customer", lastSaleInvoiceDate: "2026-09-01T00:00:00", lastReceiptDate: "2026-09-02T00:00:00" }
  ];
  const order = (s) => api().sortCustomerItems(items, s).map((i) => i.name).join("");
  assert.equal(order("lastInvoiceDesc"), "cadb");
  assert.equal(order("lastInvoiceAsc"), "dacb");
  assert.equal(order("lastPaymentDesc"), "adbc", "بلا دفعة يُرتَّبون بعد ذوي الدفعة بالرصيد");
  assert.equal(order("lastPaymentAsc"), "dabc");
  assert.equal(order("balanceDesc"), "bdca", "الترتيب الافتراضي تغيّر");
});

const pdfItems = () => [
  { name: "زبون اشترى اليوم", balance: 120, accountClass: "customer", lastSaleInvoiceDate: "2026-10-22T00:00:00", lastReceiptDate: "2026-10-21T00:00:00", lastPaymentAmount: 50, lastPaymentDate: "2026-10-21T00:00:00" },
  { name: "مورد", balance: -300, accountClass: "supplier", lastPurchaseInvoiceDate: "2026-10-20T00:00:00", lastDisbursementDate: "2026-10-19T00:00:00" },
  { name: "ليري", balance: -2, accountCurrency: "ل.س.", accountCurrencyIsBase: false, balanceAccountCcy: 700, accountClass: "customer" }
];
const realDate = Date;
function withNow(iso, fn) {
  const fixed = new realDate(iso);
  box.Date = class extends realDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed.getTime(); } };
  try { return fn(); } finally { box.Date = realDate; }
}
test("مستند الذمم PDF: العمودان بعلامة التقرير، والأرصدة والإجماليات مطابقة حرفياً لما قبلها", () => {
  box.__items = pdfItems();
  box.state.customerBalanceReports = [{ summary: {} }];
  const before = api().receivablesPdfMarkup();
  box.state.customerBalanceReports = [{ summary: { lastActivity: "v1" } }];
  const after = withNow("2026-10-22T09:00:00Z", () => vm.runInContext("receivablesPdfMarkup()", box));
  assert.ok(!before.includes("آخر فاتورة"), "العمود ظهر بلا العلامة");
  assert.match(after, /<th>آخر فاتورة<\/th><th>آخر دفعة \(منذ\)<\/th><th>تاريخ آخر دفعة<\/th>/);
  assert.match(after, /زبون اشترى اليوم<\/td><td class="deb">120<\/td><td class="cred">—<\/td><td>اليوم<br><small class="muted">2026-10-22<\/small><\/td><td>أمس<br>/);
  assert.match(after, /مورد<\/td><td class="deb">—<\/td><td class="cred">300<\/td><td>منذ يومين<br>[^]*?<\/td><td>منذ 3 أيام<br>/);
  const numbers = (h) => [...h.matchAll(/<td class="(?:deb|cred)">([^<]*)<\/td>/g)].map((m) => m[1]).join("|");
  assert.equal(numbers(after), numbers(before), "أرقام المدين/الدائن تغيّرت");
  const cards = (h) => [...h.matchAll(/<div class="v [a-z]+">([^<]*)<\/div>/g)].map((m) => m[1]).join("|");
  assert.equal(cards(after), cards(before), "بطاقات الإجماليات تغيّرت");
  // كل صف بعدد الخلايا نفسه بعد إضافة العمودين.
  for (const tr of after.match(/<tr[^>]*>[\s\S]*?<\/tr>/g).slice(1)) {
    assert.equal((tr.match(/<td/g) || []).length, 8, `صف بعدد خلايا خاطئ: ${tr.slice(0, 80)}`);
  }
});
test("العناصر لا تُعدَّل (balance وlastPaymentDate كما هي)", () => {
  const items = pdfItems();
  box.__items = items;
  box.state.customerBalanceReports = [{ summary: { lastActivity: "v1" } }];
  api().receivablesPdfMarkup();
  api().sortCustomerItems(items, "lastInvoiceDesc");
  assert.equal(JSON.stringify(items), JSON.stringify(pdfItems()));
});

test("الواجهة: الصف وخيارات الترتيب والتصدير ولوحة التفاصيل موصولة", () => {
  assert.match(appJs, /\$\{customerLastActivityRow\(item\)\}/);
  for (const v of ["lastInvoiceDesc", "lastInvoiceAsc", "lastPaymentDesc", "lastPaymentAsc"]) {
    assert.match(appJs, new RegExp(`<option value="${v}"`));
  }
  assert.match(appJs, /"آخر فاتورة \(منذ\)", "آخر دفعة \(منذ\)"\]/);
  assert.match(appJs, /\$\{customerLastActivityMetrics\(item\)\}/);
});

console.log("فحص آخر فاتورة وآخر دفعة في تقرير الذمم:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n${failed} فشل`);
  process.exit(1);
}
console.log(`\nاجتاز ${results.length} فحصاً.`);
