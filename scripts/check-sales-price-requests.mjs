// ============================================================================
// فحص Migration 27 (فواتير بانتظار تسعير المالك قبل الأمين) وعقود الواجهة.
//
// ثابت: الهجرة معاملة واحدة بحارس، لا تمسّ جداول قائمة، ولا صلاحيات مباشرة للكتابة؛
//        والمتصفح لا يكتب الجدول إلا عبر الدوال.
// حيّ (Postgres محلي فقط): بنية Supabase مصغّرة ببيانات اصطناعية، ثم كل دور:
//        anon، موظف، موظف جرد، حساب غريب، المالك — والدورة كاملة مع التعارضات.
// ============================================================================
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const MIGRATION = read("supabase/proposed/27-sales-price-requests.sql");
const ROLLBACK = read("supabase/proposed/27-sales-price-requests-rollback.sql");
const CLIENT = read("src/supabase-client.js");
const APP = read("src/app.js");
const MODULE = read("src/sales-price-requests.js");
const INDEX = read("index.html");

// --- عقود ثابتة ----------------------------------------------------------------
assert.match(MIGRATION, /^begin;/m, "الهجرة معاملة واحدة");
assert.equal(read("supabase/migrations/20261105130000_sales_price_requests.sql"), MIGRATION,
  "migrations/20261105130000_sales_price_requests.sql يجب أن تطابق proposed/27 حرفياً");
assert.match(MIGRATION, /^commit;/m);
assert.match(MIGRATION, /migration 27 guard: already applied/, "حارس التطبيق المكرر");
assert.doesNotMatch(MIGRATION, /\b(delete\s+from|truncate|drop\s+table|alter\s+table\s+public\.(?!sales_price_requests))/i,
  "الهجرة لا تمسّ جداول أو بيانات قائمة");
assert.doesNotMatch(MIGRATION, /grant\s+(insert|update|delete|all)[^;]*sales_price_requests\s+to/i, "لا كتابة مباشرة على الجدول");
assert.match(MIGRATION, /force row level security/);
assert.match(MIGRATION, /if not public\.is_owner\(\) then raise exception 'owner_only'/, "التسعير للمالك وحده");
assert.match(ROLLBACK, /migration 27 is not applied/);
assert.doesNotMatch(CLIENT, /from\("sales_price_requests"\)\s*\.(insert|update|upsert|delete)/, "المتصفح لا يكتب الجدول مباشرة");
for (const fn of ["sales_price_request_submit", "sales_price_request_price", "sales_price_request_mark_entered", "sales_price_request_cancel"]) {
  assert.match(CLIENT, new RegExp(`rpc\\("${fn}"`), `العميل ينادي ${fn}`);
}
assert.match(INDEX, /src\/sales-price-requests\.js\?v=tobacco-\d+/, "الوحدة الجديدة محمّلة بمعامل النسخة");
assert.match(APP, /OzkSalesPriceRequests/, "app.js يستعمل الوحدة");

// منطق الوحدة النقي يُختبر في Node بلا متصفح.
const sandbox = { window: {} };
new Function("window", MODULE)(sandbox.window);
const SPR = sandbox.window.OzkSalesPriceRequests;
assert.ok(SPR, "الوحدة تصدّر window.OzkSalesPriceRequests");
assert.equal(SPR.needsOwnerPricing({ accessRole: "employee" }), true);
assert.equal(SPR.needsOwnerPricing({ accessRole: "owner" }), false);
assert.equal(SPR.needsOwnerPricing(null), false);
assert.equal(SPR.statusLabel("priced"), "مسعّرة");
assert.equal(SPR.statusLabel("submitted"), "بانتظار التسعير");
assert.equal(SPR.statusLabel("entered"), "أُدخلت في الأمين");
assert.deepEqual(SPR.stockCheck(5, 3), { level: "short", available: 3 });
assert.deepEqual(SPR.stockCheck(2, 3), { level: "ok", available: 3 });
assert.deepEqual(SPR.stockCheck(2, null), { level: "unknown", available: null });
assert.deepEqual(SPR.stockCheck(1, 0), { level: "short", available: 0 });
assert.match(SPR.errorMessage("version_conflict"), /عدّل/);
assert.match(SPR.errorMessage("owner_only"), /للمالك/);

// مدخل قائمة التنقل (الهاتف: زر شريط الفاتورة يقع تحت شبكة القائمة الطويلة).
const navCtx = (owner) => ({ isOwner: () => owner, route: () => "overview" });
assert.match(SPR.navButton(navCtx(true)), /data-action="spr-nav-open"[^>]*>📝 بانتظار تسعيري</, "مدخل المالك في القائمة");
assert.match(SPR.navButton(navCtx(false)), />📝 فواتير التسعير</, "مدخل المحاسب في القائمة");
assert.doesNotMatch(SPR.navButton(navCtx(true)), /data-route=/, "المدخل ليس data-route: setRoute يغلق اللوحة");
assert.equal(typeof SPR.openPanel, "function");
assert.match(APP, /OzkSalesPriceRequests\.navButton\(salesPriceRequestsCtx\(\)\)/, "app.js يرسم المدخل في القائمة");
assert.match(APP, /\$\{state\.session && !isInventoryCounter\(\) && window\.OzkSalesPriceRequests \? window\.OzkSalesPriceRequests\.navButton/, "المدخل لا يظهر لموظف الجرد ولا بلا جلسة");
assert.match(APP, /\[data-action='spr-nav-open'\][\s\S]{0,200}setRoute\("sales"\);[\s\S]{0,120}openPanel\(salesPriceRequestsCtx\(\)\)/,
  "المدخل ينقل إلى المبيعات ثم يفتح اللوحة (بهذا الترتيب)");
assert.match(APP, /route: \(\) => state\.route/, "ctx يمرّر المسار الحالي");

// --- الفحص الحي ------------------------------------------------------------------
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-sales-price-requests: refusing non-local PGHOST");
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
  console.log("check-sales-price-requests: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

const DB = "ozk_sales_price_requests_test";
const run = (sql, { db = DB, ok = true } = {}) => {
  const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
  if (ok) assert.equal(r.status, 0, output(r));
  return r;
};
run(`drop database if exists ${DB}`, { db: "postgres" });
run(`create database ${DB}`, { db: "postgres" });

// بنية Supabase مصغّرة؛ is_staff/is_owner منسوختان من Production (2026-11-05).
run(`
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supa_owner') then create role supa_owner nologin nosuperuser bypassrls; end if;
end $$;
grant anon, authenticated to supa_owner;
create schema auth authorization supa_owner;
alter schema public owner to supa_owner;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
set role supa_owner;
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on all functions in schema auth to anon, authenticated;
create table public.staff_allowlist(email text primary key);
insert into public.staff_allowlist values ('owner@test.local'), ('employee@test.local'), ('employee2@test.local'), ('inv@accounts.test');
create function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $function$
  select exists (select 1 from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', '')));
$function$;
create function public.is_owner() returns boolean language sql stable
set search_path to 'public', 'pg_temp' as $function$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$function$;
create table public.telegram_outbox(event_type text, message text, dedupe_key text);
create function public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text default null, p_dedupe_minutes integer default 60, p_reply_markup jsonb default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin insert into public.telegram_outbox values (p_event_type, p_message, p_dedupe_key); end; $$;
grant execute on function public.notify_telegram(text, text, text, integer, jsonb) to authenticated;
reset role;
`);
run(`set role supa_owner;\n${MIGRATION}`);
// التطبيق المكرر يُرفض بالحارس.
assert.match(output(run(`set role supa_owner;\n${MIGRATION}`, { ok: false })), /already applied/);

const ID = {
  owner: { sub: "00000000-0000-0000-0000-0000000000f1", email: "owner@test.local", app_metadata: { role: "owner" } },
  employee: { sub: "00000000-0000-0000-0000-0000000000e1", email: "employee@test.local", app_metadata: { role: "employee" } },
  employee2: { sub: "00000000-0000-0000-0000-0000000000e2", email: "employee2@test.local", app_metadata: { role: "employee" } },
  stranger: { sub: "00000000-0000-0000-0000-0000000000e3", email: "stranger@example.com", app_metadata: {} },
  counter: { sub: "00000000-0000-0000-0000-0000000000c1", email: "inv@accounts.test", app_metadata: { role: "inventory_counter" } }
};
// يشغّل استعلاماً بدور محدد ويُلتزم (commit) لتتابع الدورة؛ يعيد النص أو رمز الخطأ.
const as = (who, sql) => {
  const role = who === "anon" ? "anon" : "authenticated";
  const claims = who === "anon" ? { role: "anon" } : { ...ID[who], role: "authenticated" };
  const r = run(`begin;
select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true) \\g /dev/null
set local role ${role};
${sql};
commit;`, { ok: false });
  if (r.status !== 0) return `ERR:${/ERROR:\s+(.*)/.exec(r.stderr || "")?.[1] || "error"}`;
  return r.stdout.trim();
};

const LINES = JSON.stringify([
  { key: "k1", num: "101", name: "صنف أ", unit: "كرتونة", unitKey: "unit2", qty: 2, price: 100 },
  { key: "k2", num: "102", name: "صنف ب", unit: "كروز", unitKey: "unit1", qty: 5, price: 7.5 }
]);
const submit = (who, lines = LINES, mode = "'jumla'", rate = "null") =>
  as(who, `select public.sales_price_request_submit(${mode}, 'زبون تجريبي', 'credit', '${lines}'::jsonb, ${rate}, '')->>'id'`);

// الإرسال: غير الطاقم مرفوض.
assert.match(submit("anon"), /^ERR:permission denied/);
assert.match(submit("stranger"), /^ERR:not_allowed/);
assert.match(submit("counter"), /^ERR:not_allowed/);
// كتابة مباشرة ممنوعة لكل الأدوار.
assert.match(as("employee", "insert into public.sales_price_requests(mode, requested_lines, lines, created_by) values ('jumla','[]','[]', auth.uid())"), /^ERR:permission denied/);
assert.match(as("owner", "update public.sales_price_requests set status='priced'"), /^ERR:permission denied/);
// تحقق الأسطر.
assert.match(submit("employee", "[]"), /^ERR:lines_required/);
assert.match(submit("employee", JSON.stringify([{ name: "x", unitKey: "unit2", qty: 0 }])), /^ERR:line_qty_invalid/);
assert.match(submit("employee", JSON.stringify([{ name: "x", unitKey: "bad", qty: 1 }])), /^ERR:line_unit_invalid/);
assert.match(submit("employee", LINES, "'mufrak'"), /^ERR:rate_required/);

const id1 = submit("employee");
assert.match(id1, /^\d+$/);
assert.equal(run(`select total, status, version, created_by_email from public.sales_price_requests where id=${id1}`).stdout.trim(), "237.50|submitted|1|employee@test.local", "الإجمالي محسوب في الخادم");
assert.equal(run(`select count(*) from public.telegram_outbox where dedupe_key='sales-price-request:${id1}'`).stdout.trim(), "1", "إشعار تيليغرام للمالك");

// القراءة.
assert.match(as("anon", "select count(*) from public.sales_price_requests"), /^ERR:permission denied/);
assert.equal(as("stranger", "select count(*) from public.sales_price_requests"), "0");
assert.equal(as("counter", "select count(*) from public.sales_price_requests"), "0");
assert.equal(as("employee2", "select count(*) from public.sales_price_requests"), "1");

// المحاسب لا يسعّر ولا يدخل قبل التسعير.
assert.match(as("employee", `select public.sales_price_request_price(${id1}, 1, array[110, 8]::numeric[], 0)`), /^ERR:owner_only/);
assert.match(as("employee", `select public.sales_price_request_mark_entered(${id1}, 1, 'B-1')`), /^ERR:not_priced/);
// المالك: طول الأسعار، السعر الصفري، النسخة، الحسم.
assert.match(as("owner", `select public.sales_price_request_price(${id1}, 1, array[110]::numeric[], 0)`), /^ERR:prices_length_mismatch/);
assert.match(as("owner", `select public.sales_price_request_price(${id1}, 1, array[110, 0]::numeric[], 0)`), /^ERR:line_price_required/);
assert.match(as("owner", `select public.sales_price_request_price(${id1}, 9, array[110, 8]::numeric[], 0)`), /^ERR:version_conflict/);
assert.match(as("owner", `select public.sales_price_request_price(${id1}, 1, array[110, 8]::numeric[], 9999)`), /^ERR:discount_invalid/);
assert.equal(as("owner", `select public.sales_price_request_price(${id1}, 1, array[110, 8]::numeric[], 10)->>'version'`), "2");
assert.equal(run(`select status, total, discount, net, lines->0->>'qty', lines->1->>'total', requested_lines->0->>'price' from public.sales_price_requests where id=${id1}`).stdout.trim(),
  "priced|260.00|10|250.00|2|40.00|100", "الكميات ثابتة، الأسعار الجديدة، والطلب الأصلي محفوظ");
// المحاسب لا يلغي بعد التسعير؛ إدخال بلا رقم مرفوض؛ نسخة قديمة مرفوضة.
assert.match(as("employee", `select public.sales_price_request_cancel(${id1}, 2, '')`), /^ERR:not_allowed/);
assert.match(as("employee", `select public.sales_price_request_mark_entered(${id1}, 2, '  ')`), /^ERR:ameen_bill_no_required/);
assert.match(as("employee", `select public.sales_price_request_mark_entered(${id1}, 1, 'B-1')`), /^ERR:version_conflict/);
assert.equal(as("employee2", `select public.sales_price_request_mark_entered(${id1}, 2, 'B-77')->>'status'`), "entered");
// بعد الإدخال: مقفلة لكل شيء.
assert.match(as("owner", `select public.sales_price_request_price(${id1}, 3, array[1, 1]::numeric[], 0)`), /^ERR:status_locked/);
assert.match(as("owner", `select public.sales_price_request_cancel(${id1}, 3, '')`), /^ERR:status_locked/);
assert.match(as("employee", `select public.sales_price_request_mark_entered(${id1}, 3, 'B-78')`), /^ERR:not_priced/);

// الإلغاء: صاحب الطلب قبل التسعير فقط، وغيره من الموظفين لا.
const id2 = submit("employee");
assert.match(as("employee2", `select public.sales_price_request_cancel(${id2}, 1, '')`), /^ERR:not_allowed/);
assert.equal(as("employee", `select public.sales_price_request_cancel(${id2}, 1, 'خطأ')->>'status'`), "cancelled");
// المالك يلغي طلباً مسعّراً لم يُدخل.
const id3 = submit("employee", LINES, "'mufrak'", "14050");
assert.equal(run(`select rate from public.sales_price_requests where id=${id3}`).stdout.trim(), "14050");
assert.equal(as("owner", `select public.sales_price_request_price(${id3}, 1, array[1500000, 105000]::numeric[], 0)->>'status'`), "priced");
assert.equal(as("owner", `select public.sales_price_request_cancel(${id3}, 2, '')->>'status'`), "cancelled");
// الدوال الداخلية غير متاحة للمتصفح.
assert.match(as("employee", "select public.sales_price_requests_clean_lines('[]'::jsonb, false)"), /^ERR:permission denied/);

// التراجع.
run(`set role supa_owner;\n${ROLLBACK}`);
assert.equal(run("select to_regclass('public.sales_price_requests') is null").stdout.trim(), "t");
assert.equal(run("select count(*) from pg_proc where proname like 'sales_price_request%'").stdout.trim(), "0");

run(`drop database if exists ${DB}`, { db: "postgres" });
console.log("check-sales-price-requests: OK (static + live SQL)");
