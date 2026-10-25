// ============================================================================
// فحص Migration 24 (قصر بيانات التكلفة والربح على المالك).
//
// ثابت: عقود نصية على ملفَي الهجرة والتراجع وعلى مستهلك المتصفح.
// حيّ (Postgres محلي فقط، كما في check-daily-report-once-per-date): يبني نسخة بنية
// Production من scripts/fixtures/cost-data-prod-baseline.sql ببيانات اصطناعية، ثم:
//   1) يثبت التسرّب قبل الهجرة (الموظف يقرأ التكلفة) — حتى لا ينجح الفحص على فراغ.
//   2) يطبّق الهجرة ويختبر كل دور: anon، موظف، طاقم بلا دور، حساب غريب، موظف جرد،
//      المالك، وهوية المزامنة (بدوال الكتابة الحقيقية).
//   3) يطبّق التراجع ويقارن بصمة السياسات والصلاحيات ببصمة ما قبل الهجرة حرفياً.
// ============================================================================
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const MIGRATION = read("supabase/proposed/24-cost-data-owner-only.sql");
const ROLLBACK = read("supabase/proposed/24-cost-data-owner-only-rollback.sql");
const FIXTURE = read("scripts/fixtures/cost-data-prod-baseline.sql");
const CLIENT = read("src/supabase-client.js");

// --- عقود ثابتة ----------------------------------------------------------------
// 24 مطبَّقة على الإنتاج (2026-10-25، الإصدار 20261025024900): النص مجمَّد، والنسخة المسجّلة مطابقة حرفياً.
// البصمة على نهايات LF: نسخة Windows بـcore.autocrlf=true تحمل CRLF والنص نفسه.
assert.equal(crypto.createHash("sha256").update(MIGRATION.replace(/\r\n/g, "\n")).digest("hex"), "7b55af00c95b0ed3923f32412ab3cb9b55aa390af8631cdaf51d1aa03e7bcab6", "proposed/24 يجب أن يبقى مطابقاً للنسخة المطبَّقة");
assert.equal(read("supabase/migrations/20261025024900_cost_data_owner_only.sql"), MIGRATION, "migrations/20261025024900_cost_data_owner_only.sql يجب أن تطابق proposed/24 حرفياً");
assert.match(MIGRATION, /^begin;/m, "الهجرة يجب أن تكون معاملة واحدة");
assert.match(MIGRATION, /migration 24 guard: already applied/, "الحارس يجب أن يرفض التطبيق المكرر");
assert.doesNotMatch(MIGRATION, /\b(delete\s+from|truncate\s+(table\s+)?public|update\s+public\.)/i,
  "الهجرة لا تمسّ البيانات");
assert.match(MIGRATION, /create policy sales_line_items_owner_select[\s\S]*?is_owner\(\)\)\s+or\s+\(select public\.sales_line_items_is_sync_writer\(\)\)/i);
assert.match(MIGRATION, /create policy ameen_item_snapshot_owner_select[\s\S]*?ameen_item_snapshot_is_sync_writer/i);
assert.match(MIGRATION, /as restrictive for all to authenticated[\s\S]*?'ameen_daily_profit', 'ameen_purchase_invoices'/i);
assert.match(MIGRATION, /revoke all on function public\.list_ameen_item_snapshot\(\) from public, anon;/i);
for (const col of ["last_purchase_price", "last_purchase_currency", "last_purchase_unit", "average_cost", "average_cost_currency", "average_cost_basis"]) {
  assert.match(MIGRATION, new RegExp(`case when v_owner then s\\.${col} end`), `العمود ${col} يجب أن يُحجب عن غير المالك`);
}
assert.match(ROLLBACK, /migration 24 is not applied/);
assert.match(CLIENT, /rpc\("list_ameen_item_snapshot"\)/, "المتصفح يقرأ اللقطة عبر الدالة المقنَّعة");

// --- الفحص الحي ------------------------------------------------------------------
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-cost-data-owner-only: refusing non-local PGHOST");
  process.exit(1);
}
const viaTcp = Boolean(process.env.PGHOST);
const command = viaTcp ? "psql" : "sudo";
const argvOf = (args) => (viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args]);
const psql = (args, options = {}) => spawnSync(command, argvOf(["-X", "-q", ...args]), { encoding: "utf8", ...options });
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    process.exit(1);
  }
  console.log("check-cost-data-owner-only: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

const DB = "ozk_cost_data_test";
const run = (sql, { db = DB, ok = true } = {}) => {
  const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
  if (ok) assert.equal(r.status, 0, output(r));
  return r;
};
run(`drop database if exists ${DB}`, { db: "postgres" });
run(`create database ${DB}`, { db: "postgres" });
run(FIXTURE);

const SYNC = "00000000-0000-0000-0000-00000000aaaa";
const ID = {
  owner: { sub: "00000000-0000-0000-0000-0000000000f1", email: "owner@test.local", app_metadata: { role: "owner" } },
  sync: { sub: SYNC, email: "sync@test.local", app_metadata: { role: "owner" } },
  syncStale: { sub: SYNC, email: "sync@test.local", app_metadata: {} },
  employee: { sub: "00000000-0000-0000-0000-0000000000e1", email: "employee@test.local", app_metadata: { role: "employee" } },
  norole: { sub: "00000000-0000-0000-0000-0000000000e2", email: "norole@test.local", app_metadata: {} },
  stranger: { sub: "00000000-0000-0000-0000-0000000000e3", email: "stranger@example.com", app_metadata: {} },
  counter: { sub: "00000000-0000-0000-0000-0000000000c1", email: "inv@accounts.test", app_metadata: { role: "inventory_counter" } }
};
// يشغّل استعلاماً واحداً بدور محدد داخل معاملة تُلغى دائماً؛ يعيد النص أو رمز الخطأ.
const as = (who, sql) => {
  const role = who === "anon" ? "anon" : "authenticated";
  const claims = who === "anon" ? { role: "anon" } : { ...ID[who], role: "authenticated" };
  const r = run(`begin;
select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true) \\g /dev/null
set local role ${role};
${sql};
rollback;`, { ok: false });
  if (r.status !== 0) {
    const code = /ERROR:\s+(.*)/.exec(r.stderr || "")?.[1] || "error";
    return `ERR:${code}`;
  }
  return r.stdout.trim();
};
const n = (who, sql) => as(who, `select count(*) from (${sql}) q`);

const FINGERPRINT = `select md5(string_agg(x, E'\\n' order by x)) from (
  select format('P %s %s %s %s %s %s %s', c.relname, p.polname, p.polcmd, p.polpermissive,
    array_to_string(array(select rolname from pg_roles where oid = any(p.polroles) order by 1), ','),
    pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) x
  from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace s on s.oid = c.relnamespace
  where s.nspname = 'public'
  union all
  select format('A %s %s', c.relname, array_to_string(array(select a::text from unnest(c.relacl) a order by 1), ','))
  from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind in ('r', 'v')
  union all
  select format('F %s %s', p.proname, coalesce(p.proacl::text, '')) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public') t`;
const fingerprint = () => run(FINGERPRINT).stdout.trim();

// 1) التسرّب قائم قبل الهجرة.
const before = fingerprint();
assert.equal(n("employee", "select unit_cost, net_profit from public.sales_line_items"), "6", "baseline: الموظف يقرأ تكلفة البيع");
assert.equal(n("employee", "select average_cost from public.ameen_item_snapshot where average_cost is not null"), "4");
assert.equal(n("employee", "select 1 from public.inventory_reports where source = 'ameen_daily_profit'"), "1");
assert.equal(n("stranger", "select 1 from public.sales_line_items"), "6", "baseline: حساب غريب بلا دور يقرأ الربح");

// 2) الهجرة.
run(MIGRATION);
const after = fingerprint();
assert.notEqual(after, before);

// anon
assert.match(as("anon", "select count(*) from public.sales_line_items"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.app_secrets"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.bot_config"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.item_costs"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.v_item_supplier_comparison"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.list_ameen_item_snapshot()"), /^ERR:permission denied/);

for (const who of ["employee", "norole"]) {
  assert.equal(n(who, "select 1 from public.sales_line_items"), "0", `${who}: sales_line_items`);
  assert.equal(n(who, "select 1 from public.ameen_item_snapshot"), "0", `${who}: snapshot مباشر`);
  assert.equal(n(who, "select 1 from public.list_ameen_item_snapshot()"), "4", `${who}: اقتراحات الشراء باقية`);
  assert.equal(n(who, `select 1 from public.list_ameen_item_snapshot()
    where average_cost is null and average_cost_currency is null and average_cost_basis is null
      and last_purchase_price is null and last_purchase_currency is null and last_purchase_unit is null
      and stock_unit1 > 0 and movement_rank is not null and last_purchase_date is not null`), "4", `${who}: التكلفة محجوبة والباقي سليم`);
  assert.equal(n(who, "select 1 from public.inventory_reports where source in ('ameen_daily_profit','ameen_purchase_invoices')"), "0");
  assert.equal(n(who, "select 1 from public.inventory_reports"), "2", `${who}: تقارير المخزون والأرصدة باقية`);
  assert.match(as(who, `insert into public.inventory_reports(source, created_by) values ('ameen_daily_profit', '${ID[who].sub}')`),
    /^ERR:new row violates row-level security policy/, `${who}: لا تزوير تقرير ربح`);
  assert.equal(as(who, `insert into public.inventory_reports(source, created_by) values ('ameen_sql_agent', '${ID[who].sub}') returning 1`), "1",
    `${who}: كتابة الطاقم للمصادر الأخرى باقية`);
  assert.equal(n(who, "select 1 from public.supplier_item_offers"), "0");
  assert.equal(n(who, "select 1 from public.item_costs"), "0");
  assert.match(as(who, "select count(*) from public.app_secrets"), /^ERR:permission denied/);
  assert.match(as(who, "truncate public.item_costs"), /^ERR:permission denied/);
}

assert.equal(n("stranger", "select 1 from public.sales_line_items"), "0");
assert.match(as("stranger", "select count(*) from public.list_ameen_item_snapshot()"), /^ERR:list_ameen_item_snapshot/);
assert.equal(n("counter", "select 1 from public.inventory_reports"), "0");
assert.match(as("counter", "select count(*) from public.list_ameen_item_snapshot()"), /^ERR:list_ameen_item_snapshot/);

// المالك: لا تغيير.
assert.equal(n("owner", "select 1 from public.sales_line_items where net_profit is not null"), "6");
assert.equal(n("owner", "select 1 from public.ameen_item_snapshot where average_cost is not null"), "4");
assert.equal(n("owner", "select 1 from public.list_ameen_item_snapshot() where average_cost is not null and last_purchase_price is not null"), "4");
assert.equal(n("owner", "select 1 from public.inventory_reports"), "4");
assert.equal(n("owner", "select 1 from public.supplier_item_offers"), "1");
assert.equal(n("owner", "select 1 from public.v_item_supplier_comparison"), "1");
assert.equal(as("owner", "insert into public.item_costs(match_key, avg_cost) values ('k9', 1) on conflict (match_key) do update set avg_cost = excluded.avg_cost returning 1"), "1",
  "مسار push-item-costs (upsert بالمالك) باقٍ");

// هوية المزامنة: دوال الكتابة الحقيقية تعمل، وحذف النافذة يرى الصفوف.
const salesRows = JSON.stringify([{ source_key: "11111111-1111-1111-1111-111111111111", bill_no: "N1", bill_type: "retail",
  sale_date: new Date().toISOString().slice(0, 10), item_key: "k1", item_name: "صنف 1", qty: 1, unit_price: 9, line_total: 9, unit_cost: 6, net_profit: 3 }]);
for (const who of ["sync", "syncStale"]) {
  assert.equal(as(who, `select row_count from public.replace_sales_line_items_window(current_date - 30, current_date, '${salesRows}'::jsonb);
    select count(*) from public.sales_line_items`).split("\n").join(","), "1,1", `${who}: استبدال نافذة المبيعات`);
  assert.equal(as(who, `select public.replace_ameen_item_snapshot_probe('[{"item_key":"k1","item_name":"x","average_cost":1,"last_purchase_price":1}]'::jsonb);
    select count(*) from public.ameen_item_snapshot`).split("\n").join(","), "1,1", `${who}: نشر لقطة الأصناف`);
}
assert.match(as("sync", "select (public.upsert_ameen_daily_profit(current_date, '{\"net_profit\":1}'::jsonb, '[]'::jsonb)).source"), /^ameen_daily_profit$/);
assert.match(as("employee", "select public.replace_sales_line_items_window(current_date, current_date, '[{}]'::jsonb)"), /^ERR:sync writer required/);

// التطبيق المكرر مرفوض بلا أثر.
assert.notEqual(run(MIGRATION, { ok: false }).status, 0);
assert.equal(fingerprint(), after);

// 3) التراجع يعيد البصمة حرفياً، ويعود التسرّب (دليل أن التراجع كامل).
run(ROLLBACK);
assert.equal(fingerprint(), before, "التراجع لم يُعِد السياسات والصلاحيات كما كانت");
assert.equal(n("employee", "select 1 from public.sales_line_items"), "6");
assert.notEqual(run(ROLLBACK, { ok: false }).status, 0, "تراجع مكرر يجب أن يُرفض");

// 4) إعادة التطبيق بعد التراجع تعطي البصمة نفسها.
run(MIGRATION);
assert.equal(fingerprint(), after);

run(`drop database if exists ${DB}`, { db: "postgres" });
console.log("check-cost-data-owner-only: static + live (before/after/rollback/reapply) passed.");
