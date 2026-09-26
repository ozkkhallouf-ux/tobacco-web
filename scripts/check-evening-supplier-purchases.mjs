// ============================================================================
// فحص انحداري: **«🛒 مشتريات الموردين اليوم» = فواتير شراء الأمين الفعلية فقط.**
//
// العطل الحقيقي (2026-09-24): القسم 2ج في send_evening_report كان يعرض كل
// recentPayments بتاريخ اليوم لحسابات isSupplier من تقرير الأرصدة. فظهر سند قبض
// نقدي من المورد (مصاري استلمناها منه) على أنه «مشتريات»، ومثله القيد الافتتاحي
// والقيود اليدوية على حسابات الموردين. الإصلاح يقرأ ameen_purchase_invoice_reports
// (فواتير bu000 بنوع «مشتريات»/«مرتجع مشتريات») ويرفض الحكم على تقرير قديم أو مفقود.
//
// الفحص **يشغّل الترحيل الحقيقي** على Postgres مؤقت (initdb في مجلد مؤقت، مقبس
// محلي، بلا شبكة) ثم يستدعي send_evening_report() نفسها ويقرأ ما أرسلته إلى
// notify_telegram (بديل يلتقط الرسائل). كل الأسماء والمبالغ والمعرّفات مصطنعة؛
// لا مورد حقيقي ولا مبلغ شاهد حقيقي.
//
// Postgres متاح على مشغّلات ubuntu في CI (/usr/lib/postgresql/*/bin). إن غاب
// محلياً يُتخطّى الفحص برسالة صريحة؛ وفي CI (CI=true) غيابه فشل لا تخطٍّ.
// ============================================================================

import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const migrationPath = new URL("../supabase/migrations/20260926140000_evening_report_supplier_purchases_from_bills.sql", import.meta.url);
const referencePath = new URL("../supabase/telegram-notifications.sql", import.meta.url);
const migration = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");
const reference = readFileSync(referencePath, "utf8").replace(/\r\n/g, "\n");

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

function region(text, begin, end, label) {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  assert.ok(b >= 0 && e > b, `${label}: العلامتان ${begin} / ${end} مفقودتان`);
  return text.slice(b, e + end.length);
}

// ── فحوص ثابتة (بلا Postgres) ────────────────────────────────────────────────
test("النسخة المرجعية في telegram-notifications.sql مطابقة حرفياً للترحيل", () => {
  const m = region(migration, "-- evening-report:begin", "-- evening-report:end", "الترحيل");
  const r = region(reference, "-- evening-report:begin", "-- evening-report:end", "المرجع");
  assert.equal(r, m);
  const md = region(migration, "create or replace function public.evening_supplier_purchases_digest", "-- evening-report:begin", "الترحيل");
  const rd = region(reference, "create or replace function public.evening_supplier_purchases_digest", "-- evening-report:begin", "المرجع");
  assert.equal(rd, md);
});

test("قسم المشتريات لا يقرأ recentPayments ولا isSupplier", () => {
  const section = region(migration, "-- supplier-purchases:begin", "-- supplier-purchases:end", "الترحيل");
  assert.ok(section.includes("ameen_purchase_invoice_reports"));
  assert.ok(!/recentPayments|isSupplier|ameen_customer_balances/.test(section));
});

test("لا أرقام شهود ولا استثناءات مثبّتة في الترحيل", () => {
  for (const needle of ["17600", "17,600", "20840", "20,840"]) {
    assert.ok(!migration.includes(needle), `الترحيل يحوي ${needle}`);
  }
});

// ── إيجاد Postgres ───────────────────────────────────────────────────────────
function candidateDirs() {
  const dirs = [];
  for (const root of ["/usr/lib/postgresql", "/opt/homebrew/opt", "/usr/local/opt"]) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).sort().reverse()) {
      if (root.endsWith("postgresql") || name.startsWith("postgresql")) dirs.push(path.join(root, name, "bin"));
    }
  }
  for (const p of (process.env.PATH || "").split(path.delimiter)) if (p) dirs.push(p);
  return dirs;
}
const pgBin = candidateDirs().find((d) => ["initdb", "pg_ctl", "psql", "postgres"].every((b) => existsSync(path.join(d, b))));

if (!pgBin) {
  if (process.env.CI) {
    results.push("  ❌ Postgres غير موجود على مشغّل CI — لا يُسمح بتخطّي هذا الفحص هناك");
    failed += 1;
  } else {
    results.push("  ⚠️ Postgres (initdb/pg_ctl/psql) غير موجود محلياً — تُخطّيت فحوص التنفيذ");
  }
} else {
  runDbTests();
}

function runDbTests() {
  // مسار قصير: مقبس Unix محدود بنحو 103 حروف على macOS، وtmpdir() هناك طويل.
  const work = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : tmpdir(), "evpur-"));
  const data = path.join(work, "data");
  const sock = path.join(work, "sock");
  const port = String(55000 + Math.floor(Math.random() * 5000));
  const bin = (b) => path.join(pgBin, b);
  // LC_ALL=C: postmaster على macOS يرفض الإقلاع («became multithreaded») بلغة بيئة غير صالحة.
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  const run = (b, args, input) => spawnSync(bin(b), args, { encoding: "utf8", input, env });
  let started = false;
  try {
    spawnSync("mkdir", ["-p", sock]);
    let r = run("initdb", ["-D", data, "-A", "trust", "-U", "postgres", "-E", "UTF8", "--locale=C", "--no-sync"]);
    assert.equal(r.status, 0, `initdb: ${r.stderr}`);
    r = run("pg_ctl", ["-D", data, "-l", path.join(work, "log"), "-w", "-o",
      `-k ${sock} -c listen_addresses= -p ${port} -F -c timezone=UTC`, "start"]);
    assert.equal(r.status, 0, `pg_ctl start: ${r.stderr} ${existsSync(path.join(work, "log")) ? readFileSync(path.join(work, "log"), "utf8").slice(-600) : ""}`);
    started = true;

    const sql = (text) => {
      const file = path.join(work, "q.sql");
      writeFileSync(file, text);
      const out = run("psql", ["-h", sock, "-p", port, "-U", "postgres", "-d", "postgres", "-X", "-q", "-At",
        "-v", "ON_ERROR_STOP=1", "-f", file]);
      if (out.status !== 0) throw new Error(`psql: ${out.stderr}`);
      return out.stdout;
    };

    sql(`
      create role anon; create role authenticated; create role service_role;
      create table daily_sales_summary(total_sales numeric, total_cash numeric, total_credit numeric, created_at timestamptz default now());
      create table sales_line_items(sale_date date, line_total numeric, qty numeric, unit2_factor numeric);
      create table bot_config(key text, value text);
      create table approved_price_items(stock_qty numeric);
      create table inventory_reports(source text, summary jsonb, items jsonb, created_at timestamptz default now());
      create table expense_entries(entry_date date, amount numeric, account_name text, notes text, created_at timestamptz default now());
      create table customer_requests(customer text, request_type text, channel text, status text, created_at timestamptz default now());
      create table whatsapp_orders(created_at timestamptz default now());
      create table price_change_log(item_name text, old_price numeric, new_price numeric, changed_at timestamptz default now());
      create table ameen_purchase_invoice_reports(id serial, report_date date, summary jsonb, items jsonb, created_by uuid, created_at timestamptz default now());
      create table outbox(id serial, event_type text, message text, dedupe_key text);
      create function notify_telegram(p_event text, p_msg text, p_key text default null, p_min int default 0, p_extra jsonb default null)
        returns void language sql as $$ insert into outbox(event_type, message, dedupe_key) values (p_event, p_msg, p_key) $$;
    `);
    sql(migration);

    const today = sql("select to_char(current_date, 'YYYY-MM-DD');").trim();
    const yesterday = sql("select to_char(current_date - 1, 'YYYY-MM-DD');").trim();
    const from = sql("select to_char(current_date - 60, 'YYYY-MM-DD');").trim();
    const q = (v) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

    // تقرير أرصدة مصطنع: حركات دائنة على حساب مورد بتاريخ اليوم ليست شراءً.
    const balances = [
      { name: "مورد اختبار ج", isSupplier: true, recentPayments: [
        { date: `${today}T00:00:00`, amount: 4321, notes: "صندوق" },          // قبض نقدي من المورد
        { date: `${today}T00:00:00`, amount: 65, notes: "بيد موظف" },        // قبض ضمن سند مركّب
        { date: `${today}T00:00:00`, amount: 888, notes: "القيد الافتتاحي" }, // رصيد افتتاحي
        { date: `${today}T00:00:00`, amount: 12.5, notes: "فرق حساب" },     // قيد يومية يدوي
      ] },
      { name: "زبون اختبار", isSupplier: false, recentPayments: [{ date: `${today}T00:00:00`, amount: 200, notes: "دفعة" }] },
    ];

    const inv = (guid, date, total, extra = {}) => ({ guid, date, total, number: guid.slice(-3), currency: "USD", isReturn: false, payMethod: "unknown", ...extra });
    const mainItems = [
      { name: "مورد اختبار أ", truncated: false, invoices: [
        inv("aaaa-001", today, 1234.5),
        inv("aaaa-002", today, 100, { discount: 15 }),   // فاتورة فيها حسم: يُعرض الإجمالي قبله
        inv("aaaa-003", yesterday, 999),                  // شراء الأمس
        inv("aaaa-001", today, 1234.5),                   // تكرار نفس الفاتورة
      ] },
      { name: "", truncated: false, invoices: [inv("bbbb-001", today, 77.25)] }, // نقدي بلا اسم مورد
      { name: "مورد اختبار ب", truncated: false, invoices: [
        inv("cccc-001", today, 50),
        inv("cccc-002", today, 300, { isReturn: true }), // مرتجع مشتريات اليوم
      ] },
    ];

    function scenario({ items = mainItems, summary, createdAt = "now() - interval '5 minutes'", noReport = false, extraSql = "" }) {
      const s = summary ?? { syncedAt: null, fromDate: from, periodDays: 60 };
      const out = sql(`
        truncate outbox, inventory_reports, ameen_purchase_invoice_reports;
        insert into inventory_reports(source, summary, items) values ('ameen_customer_balances', '{}'::jsonb, ${q(balances)});
        ${noReport ? "" : `insert into ameen_purchase_invoice_reports(report_date, summary, items, created_at)
          values (current_date, ${q(s)}, ${q(items)}, ${createdAt});`}
        ${extraSql}
        select send_evening_report();
        select event_type || chr(9) || replace(message, chr(10), ' ⏎ ') from outbox order by id;
      `);
      const rows = out.split("\n").filter(Boolean).map((l) => { const [type, ...m] = l.split("\t"); return { type, msg: m.join("\t") }; });
      const of = (t) => rows.filter((x) => x.type === t).map((x) => x.msg).join(" ‖ ");
      return { rows, purchases: of("evening_report_purchases"), returns: of("evening_report_purchase_returns"), payments: of("evening_report_payments"), all: rows };
    }

    const main = scenario({});
    test("شراء اليوم يظهر بإجمالي الفاتورة، مجمّعاً للمورد، بلا تكرار", () => {
      assert.match(main.purchases, /مورد اختبار أ — 1,334\.50 \$ \(2 فواتير\)/);
      assert.match(main.purchases, /مورد اختبار ب — 50\.00 \$/);
    });
    test("فاتورة بحسم تُعرض بإجماليها قبل الحسم (لا يُطرح الحسم)", () => {
      assert.match(main.purchases, /1,334\.50/);
      assert.ok(!main.purchases.includes("1,319.50"));
    });
    test("شراء نقدي بلا اسم مورد يظهر تحت «نقدي بلا مورد»", () => {
      assert.match(main.purchases, /نقدي بلا مورد — 77\.25 \$/);
    });
    test("الإجمالي قبل الحسم يجمع المشتريات فقط ولا يطرح المرتجع", () => {
      assert.match(main.purchases, /الإجمالي \(قبل الحسم\): 1,461\.75 \$ — 4 فاتورة/);
    });
    test("شراء الأمس لا يدخل مشتريات اليوم", () => {
      assert.ok(!main.purchases.includes("999"));
    });
    test("مرتجع مشتريات اليوم رسالة مستقلة وواضحة", () => {
      assert.match(main.returns, /مرتجعات المشتريات اليوم/);
      assert.match(main.returns, /مورد اختبار ب — 300\.00 \$/);
      assert.match(main.returns, /لم تُطرح/);
      assert.ok(!main.purchases.includes("300.00"));
    });
    test("قبض نقدي من المورد (سند قبض) ليس مشتريات", () => {
      assert.ok(!main.purchases.includes("4,321") && !main.purchases.includes("مورد اختبار ج"));
    });
    test("قبض ضمن سند مركّب من المورد ليس مشتريات", () => {
      assert.ok(!main.purchases.includes("65.00"));
    });
    test("القيد الافتتاحي على حساب المورد ليس مشتريات", () => {
      assert.ok(!main.purchases.includes("888"));
    });
    test("قيد يومية يدوي على حساب المورد ليس مشتريات", () => {
      assert.ok(!main.purchases.includes("12.50"));
    });
    test("قسم دفعات الزبائن لم يتغيّر: الزبون يظهر والمورد لا", () => {
      assert.match(main.payments, /زبون اختبار — 200\.00 \$/);
      assert.ok(!main.payments.includes("مورد اختبار ج"));
      assert.ok(main.all.some((x) => x.type === "evening_report"));
    });

    const stale = scenario({ createdAt: "now() - interval '5 hours'" });
    test("تقرير قديم ⇒ تحذير «تعذّر الحكم» لا «صفر مشتريات»", () => {
      assert.match(stale.purchases, /تعذّر الحكم/);
      assert.match(stale.purchases, /قديم/);
      assert.ok(!/لا توجد فواتير شراء|الإجمالي|1,334/.test(stale.purchases));
      assert.equal(stale.returns, "");
    });
    const staleSynced = scenario({ summary: { syncedAt: new Date(Date.now() - 6 * 3600e3).toISOString(), fromDate: from } });
    test("syncedAt القديم يحكم حتى لو أُدرج الصف حديثاً", () => {
      assert.match(staleSynced.purchases, /تعذّر الحكم/);
    });
    const notCovering = scenario({ summary: { fromDate: sql("select to_char(current_date + 1, 'YYYY-MM-DD');").trim() } });
    test("تقرير لا تغطي نافذته اليوم ⇒ تعذّر الحكم", () => {
      assert.match(notCovering.purchases, /تعذّر الحكم/);
    });
    const missing = scenario({ noReport: true });
    test("تقرير مفقود ⇒ تحذير صريح", () => {
      assert.match(missing.purchases, /تعذّر الحكم/);
      assert.match(missing.purchases, /لا يوجد تقرير/);
      assert.ok(!/لا توجد فواتير شراء/.test(missing.purchases));
    });
    const none = scenario({ items: [{ name: "مورد اختبار أ", invoices: [inv("dddd-001", yesterday, 10)] }] });
    test("تقرير حديث بلا فواتير اليوم ⇒ «لا توجد فواتير شراء»", () => {
      assert.match(none.purchases, /لا توجد فواتير شراء في الأمين اليوم/);
      assert.equal(none.returns, "");
    });
    const returnsOnly = scenario({ items: [{ name: "مورد اختبار ب", invoices: [inv("eeee-001", today, 40, { isReturn: true })] }] });
    test("مرتجع فقط ⇒ «لا توجد فواتير شراء» + رسالة مرتجع مستقلة", () => {
      assert.match(returnsOnly.purchases, /لا توجد فواتير شراء/);
      assert.match(returnsOnly.returns, /مورد اختبار ب — 40\.00 \$/);
    });
    const invalid = scenario({ items: [{ name: "مورد اختبار أ", invoices: [inv("ffff-001", today, "غير رقم")] }] });
    test("فاتورة اليوم بلا إجمالي رقمي ⇒ تعذّر الحكم لا رقم ناقص", () => {
      assert.match(invalid.purchases, /بلا إجمالي صالح/);
    });
    const many = scenario({ items: Array.from({ length: 25 }, (_, i) => ({ name: `مورد اختبار ${i + 1}`, invoices: [inv(`gggg-${i}`, today, i + 1)] })) });
    test("أكثر من 20 مورداً ⇒ رسالتان والإجمالي في الأخيرة", () => {
      const msgs = many.rows.filter((x) => x.type === "evening_report_purchases");
      assert.equal(msgs.length, 2);
      assert.match(msgs[1].msg, /الإجمالي \(قبل الحسم\): 325\.00 \$ — 25 فاتورة/);
    });
    const broken = scenario({ extraSql: "alter table ameen_purchase_invoice_reports rename to apir_hidden;" });
    sql("alter table if exists apir_hidden rename to ameen_purchase_invoice_reports;");
    test("خطأ غير متوقع في قسم المشتريات لا يُسقط بقية التقرير", () => {
      assert.match(broken.purchases, /تعذّر الحكم/);
      assert.ok(broken.all.some((x) => x.type === "evening_report"));
      assert.match(broken.payments, /زبون اختبار/);
    });

    const digest = sql(`
      select string_agg(kind, ',' order by kind) from (
        select (evening_supplier_purchases_digest(now() - interval '2 hours 59 minutes', '{}'::jsonb, '[]'::jsonb, current_date, now())).kind
        union all select (evening_supplier_purchases_digest(now() - interval '3 hours 1 minute', '{}'::jsonb, '[]'::jsonb, current_date, now())).kind
        union all select (evening_supplier_purchases_digest(now() + interval '1 hour', '{}'::jsonb, '[]'::jsonb, current_date, now())).kind
        union all select (evening_supplier_purchases_digest(now(), '{"syncedAt":"garbage"}'::jsonb, '[]'::jsonb, current_date, now())).kind
      ) t;`).trim();
    test("حدود الحداثة: 2:59 حديث، 3:01 قديم، مستقبل = قديم، syncedAt تالف يرجع لوقت الإدراج", () => {
      assert.equal(digest, "none,none,stale,stale");
    });
  } catch (error) {
    failed += 1;
    results.push(`  ❌ تهيئة Postgres/التنفيذ: ${error && error.message}`);
  } finally {
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(work, { recursive: true, force: true });
  }
}

console.log("check-evening-supplier-purchases:");
console.log(results.join("\n"));
if (failed > 0) {
  console.error(`check-evening-supplier-purchases: فشل ${failed}`);
  process.exit(1);
}
console.log("check-evening-supplier-purchases: OK");
