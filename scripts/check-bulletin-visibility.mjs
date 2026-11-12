// ============================================================================
// فحص ظهور الأصناف في نشرة الأسعار (src/bulletin-visibility.js) وMigration 30.
//
// ثابت: الحالة الافتراضية ظاهر؛ الإخفاء استثناء بالـGUID يحذفه الإظهار بدل قيمة
//        متقابلة؛ القراءة والكتابة للمالك وحده (RLS)؛ المولّد يستبعد الأصناف
//        المخفية قبل أي تفرّع وزاري/عام أو دولار/سوري.
// حيّ (Postgres محلي فقط): بنية Supabase مصغّرة ببيانات اصطناعية، ثم كل دور:
//        anon، موظف، موظف جرد، حساب غريب، المالك — وسجل التدقيق والتراجع،
//        وأن approved_price_items لا تتغيّر إطلاقاً.
// ============================================================================
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const MODULE = read("src/bulletin-visibility.js");
const APP = read("src/app.js");
const CLIENT = read("src/supabase-client.js");
const GENERATOR = read("scripts/generate-price-lists.mjs");
const INDEX = read("index.html");
const SW = read("public/service-worker.js");
const MIGRATION = read("supabase/proposed/30-item-bulletin-visibility.sql");
const ROLLBACK = read("supabase/proposed/30-item-bulletin-visibility-rollback.sql");
// مطبّقة بالإصدار 20261112120000؛ نسخة migrations يجب أن تطابق proposed/30 حرفياً
// كي لا يراها Supabase CLI هجرة مختلفة أو ناقصة.
assert.equal(read("supabase/migrations/20261112120000_item_bulletin_visibility.sql"), MIGRATION,
  "migrations/20261112120000_item_bulletin_visibility.sql يجب أن تطابق proposed/30 حرفياً");

await import("../src/bulletin-classification.js");
await import("../src/bulletin-visibility.js");
const V = globalThis.ozkBulletinVisibility;
assert.ok(V, "الوحدة تصدّر ozkBulletinVisibility");

const GUID_A = "AAAAAAAA-1111-2222-3333-444444444444";
const GUID_B = "BBBBBBBB-1111-2222-3333-444444444444";

// --- 1) المنطق النقي: الحالة الافتراضية ظاهرة، والـGUID يسبق المفتاح ----------------
assert.deepEqual(V.isHiddenItem({ itemGuid: GUID_A }, V.buildHiddenIndex([])), false, "فهرس فارغ ⇒ كل الأصناف ظاهرة");
const idxByGuid = V.buildHiddenIndex([{ item_guid: GUID_A.toLowerCase(), item_key: "صنف مخفي" }]);
assert.equal(V.isHiddenItem({ itemGuid: GUID_A }, idxByGuid), true, "GUID بأي حالة أحرف يُطابق");
// إعادة تسمية الصنف في الأمين لا تُسقط الإخفاء (الهوية بالـGUID).
assert.equal(V.isHiddenItem({ itemGuid: GUID_A, name: "اسم جديد كلياً" }, idxByGuid), true);
// صنف آخر بمفتاح مطابق نصاً وGUID مختلف لا يرث الإخفاء — الـGUID حاضر فيُهمل المفتاح.
assert.equal(V.isHiddenItem({ itemGuid: GUID_B, itemKey: "صنف مخفي" }, idxByGuid), false, "GUID مختلف لا يرث إخفاء مفتاح مشابه");
// صف نافذة المولّد العامة بلا GUID: المطابقة بالمفتاح الحرفي وحده (نفس أصناف
// available_price_sync_feed، التي لا تكشف item_guid أصلاً).
const idxByKey = V.buildHiddenIndex([{ item_key: "صنف مخفي" }]);
assert.equal(V.isHiddenItem({ itemKey: "صنف مخفي", name: "صنف مخفي" }, idxByKey), true);
assert.equal(V.isHiddenItem({ itemKey: "صنف ظاهر", name: "صنف ظاهر" }, idxByKey), false);
// بلا GUID ولا مفتاح مطابق على الإطلاق ⇒ ظاهر دوماً (الحالة الافتراضية).
assert.equal(V.isHiddenItem({ name: "صنف عشوائي" }, idxByKey), false);
// حقول الاسم البديلة (itemKey/item_key/key/name/itemName/item_name) تؤدي للمطابقة نفسها.
["itemKey", "item_key", "key", "name", "itemName", "item_name"].forEach((field) => {
  assert.equal(V.isHiddenItem({ [field]: "صنف مخفي" }, idxByKey), true, `الحقل ${field} يُطابق بالمفتاح`);
});

// --- 2) مصدر واحد: الموقع والمولّد لا يكرّران منطق الإخفاء -------------------------
assert.match(APP, /function isItemHidden\(item\) \{\s*const engine = window\.ozkBulletinVisibility;\s*if \(!engine\) return false;\s*return engine\.isHiddenItem\(item, bulletinVisibilityIndex\(\)\);/);
assert.match(GENERATOR, /import "\.\.\/src\/bulletin-visibility\.js";/);
assert.match(GENERATOR, /visibilityEngine\.isHiddenItem\(\{ itemKey: item\.key \|\| item\.name, name: item\.name \}, hiddenIndex\)/);
assert.match(GENERATOR, /bulletin_hidden_items_feed\?select=item_key&limit=5000/);
assert.match(GENERATOR, /usdItems = usdItems\.filter\(\(item\) => !isHiddenFromCustomers\(item\)\);/);
assert.match(GENERATOR, /sypItems = sypItems\.filter\(\(item\) => !isHiddenFromCustomers\(item\)\);/);
// الاستبعاد يسبق كل تفرّع وزاري/عام بالدولار والسوري — نفس المصفوفتين يقرأهما toWazari/consolidateGeneral بعده.
const filterPos = GENERATOR.indexOf("usdItems = usdItems.filter((item) => !isHiddenFromCustomers(item));");
const wazariPos = GENERATOR.indexOf("const usdWazariItems = toWazari(usdItems);");
assert.ok(filterPos > 0 && wazariPos > filterPos, "الإخفاء قبل أي تفرّع وزاري/عام");
const pos = (needle) => INDEX.indexOf(needle);
assert.ok(pos("src/bulletin-visibility.js?v=tobacco-") > 0 &&
  pos("src/bulletin-classification.js") < pos("src/bulletin-visibility.js") &&
  pos("src/bulletin-visibility.js") < pos("src/app.js"),
  "الوحدة تُحمَّل بعد التصنيف وقبل app.js وبمعامل النسخة");
assert.match(SW, /"src\/bulletin-visibility\.js"/, "الوحدة في كاش التطبيق");

// --- 3) الواجهة: المالك وحده يرى ويعدّل، وكتابة عبر RPC فقط ------------------------
assert.match(APP, /function pricingVisibilityLine\(item\) \{\s*(?:\/\/.*\s*)*if \(!isOwner\(\)\) return "";/, "سطر الظهور للمالك وحده (القراءة مقيّدة بالـRLS أصلاً)");
assert.match(APP, /const canEdit = Boolean\(guid\) && Boolean\(dataStore\.setItemBulletinVisibility\);/);
assert.match(APP, /if \(!isOwner\(\)\) throw new Error\("تعديل ظهور الصنف للمالك فقط\."\);/, "saveBulletinVisibility يرفض غير المالك دفاعياً أيضاً");
assert.match(CLIENT, /rpc\("set_item_bulletin_visibility"/);
assert.doesNotMatch(CLIENT, /from\("item_bulletin_visibility"\)\s*\.(insert|update|upsert|delete)/, "لا كتابة مباشرة من المتصفح");
// الفلتر والعدادات في شاشة التسعير للمالك وحده أيضاً (نفس قيد RLS).
assert.match(APP, /const visibilityCounts = isOwner\(\) \? pricingVisibilityCounts\(items\) : null;/);
assert.match(APP, /const visibleItems = isOwner\(\) \? applyPricingVisibilityFilter\(items, state\.pricingVisibilityFilter\) : items;/);

// --- 4) الهجرة: ثوابت ---------------------------------------------------------------
assert.match(MIGRATION, /^begin;/m);
assert.match(MIGRATION, /^commit;/m);
assert.match(MIGRATION, /migration 30 guard: already applied/);
assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ""),
  /\b(delete\s+from\s+public\.(?!item_bulletin_visibility\b)|truncate|drop\s+|alter\s+table\s+public\.(?!item_bulletin_visibility))/i,
  "الهجرة لا تمسّ جداول قائمة");
assert.doesNotMatch(MIGRATION, /(update|insert\s+into)\s+public\.approved_price_items/i, "لا تغيير لأي سعر أو مخزون");
assert.doesNotMatch(MIGRATION, /grant\s+(insert|update|delete|all)[^;]*item_bulletin_visibility/i, "لا كتابة مباشرة على الجدولين");
assert.match(MIGRATION, /if not public\.is_owner\(\) or auth\.uid\(\) is null then/);
assert.match(MIGRATION, /raise exception 'invalid_item_guid';/);
assert.match(MIGRATION, /raise exception 'invalid_hidden';/);
assert.doesNotMatch(MIGRATION, /approved_price_sync_feed/, "لا مساس بنافذة #291");
const feedSelect = /create view public\.bulletin_hidden_items_feed[^;]*select ([^;]*?) from/i.exec(MIGRATION);
assert.equal(feedSelect?.[1].trim(), "item_key", "النافذة العامة: item_key فقط، بلا GUID ولا سعر ولا سبب");
assert.match(MIGRATION, /where coalesce\(p\.stock_qty, 0\) > 0/, "النافذة العامة تستبعد الأصناف بلا مخزون موجب");
assert.match(ROLLBACK, /migration 30 is not applied/);

// --- 5) الفحص الحي -------------------------------------------------------------------
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-bulletin-visibility: refusing non-local PGHOST");
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
  console.log("check-bulletin-visibility: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

const DB = "ozk_bulletin_visibility_test";
const run = (sql, { db = DB, ok = true } = {}) => {
  const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
  if (ok) assert.equal(r.status, 0, output(r));
  return r;
};
run(`drop database if exists ${DB}`, { db: "postgres" });
run(`create database ${DB}`, { db: "postgres" });

// بنية Supabase مصغّرة؛ is_owner ونافذة الأسعار منسوخة من Production (2026-11-12).
run(`
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supa_owner') then create role supa_owner nologin nosuperuser bypassrls; end if;
end $$;
grant anon, authenticated, service_role to supa_owner;
create schema auth authorization supa_owner;
create schema price_feed_private authorization supa_owner;
alter schema public owner to supa_owner;
grant usage on schema public, auth, price_feed_private to anon, authenticated;
set role supa_owner;
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on all functions in schema auth to anon, authenticated;
create function public.is_owner() returns boolean language sql stable
set search_path to 'public', 'pg_temp' as $function$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$function$;
create table public.approved_price_items(item_key text primary key, item_name text, item_guid text, unit2_price numeric, stock_qty numeric, price_payload jsonb);
alter table public.approved_price_items enable row level security;
insert into public.approved_price_items values
  ('صنف مخفي', 'صنف مخفي', '${GUID_A}', 650, 50, '{"retail":{"price":660}}'),
  ('صنف ظاهر', 'صنف ظاهر', '${GUID_B}', 400, 30, '{}'),
  ('صنف بلا مخزون', 'صنف بلا مخزون', 'CCCCCCCC-0000-0000-0000-000000000001', 100, 0, '{}');
reset role;
`);
const PRICES_FINGERPRINT = "select md5(string_agg(to_jsonb(p)::text, '|' order by item_key)) from public.approved_price_items p";
const before = run(PRICES_FINGERPRINT).stdout.trim();
run(`set role supa_owner;\n${MIGRATION}`);
assert.match(output(run(`set role supa_owner;\n${MIGRATION}`, { ok: false })), /already applied/, "التطبيق المكرر يُرفض");

const ID = {
  owner: { sub: "00000000-0000-0000-0000-0000000000f1", email: "owner@test.local", app_metadata: { role: "owner" } },
  employee: { sub: "00000000-0000-0000-0000-0000000000e1", email: "employee@test.local", app_metadata: { role: "employee" } },
  stranger: { sub: "00000000-0000-0000-0000-0000000000e3", email: "stranger@example.com", app_metadata: {} },
  counter: { sub: "00000000-0000-0000-0000-0000000000c1", email: "inv@accounts.test", app_metadata: { role: "inventory_counter" } }
};
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

// البذر: لا قواعد إخفاء سابقة لمراجعتها — كل الأصناف تبقى ظاهرة كما هي اليوم.
assert.equal(run("select count(*) from public.item_bulletin_visibility").stdout.trim(), "0");
assert.equal(run("select count(*) from public.item_bulletin_visibility_audit").stdout.trim(), "0");

// القراءة: المالك وحده، حتى للطاقم.
assert.match(as("anon", "select count(*) from public.item_bulletin_visibility"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.item_bulletin_visibility_audit"), /^ERR:permission denied/);
assert.equal(as("employee", "select count(*) from public.item_bulletin_visibility"), "0", "القراءة للمالك وحده، لا الطاقم");
assert.equal(as("counter", "select count(*) from public.item_bulletin_visibility"), "0");
assert.equal(as("stranger", "select count(*) from public.item_bulletin_visibility"), "0");
assert.equal(as("employee", "select count(*) from public.item_bulletin_visibility_audit"), "0");

// الكتابة: المالك وحده وعبر الدالة وحدها.
const setVis = (who, guid, hidden, reason = "") =>
  as(who, `select public.set_item_bulletin_visibility('${guid}', ${hidden}, 'مفتاح', 'اسم', '${reason}')->>'hidden'`);
assert.match(setVis("anon", GUID_A, "true"), /^ERR:permission denied/);
assert.match(setVis("employee", GUID_A, "true"), /^ERR:not_allowed/);
assert.match(setVis("counter", GUID_A, "true"), /^ERR:not_allowed/);
assert.match(setVis("stranger", GUID_A, "true"), /^ERR:not_allowed/);
assert.match(as("owner", `insert into public.item_bulletin_visibility(item_guid) values ('${GUID_A}')`), /^ERR:permission denied/);
assert.match(as("owner", "update public.item_bulletin_visibility_audit set reason='x'"), /^ERR:permission denied/);
assert.match(as("owner", "delete from public.item_bulletin_visibility_audit"), /^ERR:permission denied/);
assert.match(setVis("owner", "not-a-guid", "true"), /^ERR:invalid_item_guid/);
assert.match(as("owner", `select public.set_item_bulletin_visibility('${GUID_A}', null, 'مفتاح', 'اسم', '')`), /^ERR:invalid_hidden/);

// الإخفاء: السبب الفارغ يُعبّأ تلقائياً بنص افتراضي — بخلاف التصنيف، لا خطأ إلزامي للسبب هنا.
assert.equal(setVis("owner", `{${GUID_A.toLowerCase()}}`, "true"), "true", "GUID يُطبَّع (أقواس/أحرف صغيرة)");
assert.equal(run(`select item_key, reason, updated_by_email from public.item_bulletin_visibility where item_guid='${GUID_A}'`).stdout.trim(),
  "مفتاح|إخفاء من شاشة إدارة نشرة الأسعار|owner@test.local", "سبب افتراضي عربي عند ترك الحقل فارغاً");
assert.equal(run(`select action||'|'||changed_by_email from public.item_bulletin_visibility_audit where item_guid='${GUID_A}' order by id desc limit 1`).stdout.trim(),
  "hide|owner@test.local");

// سبب مخصّص يُحفظ كما هو.
assert.equal(setVis("owner", GUID_A, "true", "طلب زبون كبير"), "true");
assert.equal(run(`select reason from public.item_bulletin_visibility where item_guid='${GUID_A}'`).stdout.trim(), "طلب زبون كبير");
assert.equal(run(`select count(*) from public.item_bulletin_visibility_audit where item_guid='${GUID_A}'`).stdout.trim(), "2", "كل تغيير له سطر تدقيق، حتى إخفاء فوق إخفاء");

// الإظهار يحذف السطر بدل تسجيل قيمة متقابلة (الحالة الافتراضية = غياب السطر).
assert.equal(setVis("owner", GUID_A, "false"), "false");
assert.equal(run(`select count(*) from public.item_bulletin_visibility where item_guid='${GUID_A}'`).stdout.trim(), "0", "الإظهار يحذف السطر");
assert.equal(run(`select count(*) from public.item_bulletin_visibility_audit where item_guid='${GUID_A}'`).stdout.trim(), "3");
assert.equal(run(`select action from public.item_bulletin_visibility_audit where item_guid='${GUID_A}' order by id desc limit 1`).stdout.trim(), "show");

// نافذة المولّد العامة: item_key فقط، للمخفي ذي المخزون الموجب وحده، بلا GUID ولا سعر.
assert.equal(setVis("owner", GUID_A, "true"), "true");
assert.equal(as("anon", "select string_agg(item_key, ',') from public.bulletin_hidden_items_feed"), "صنف مخفي");
assert.equal(run("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='bulletin_hidden_items_feed'").stdout.trim(), "item_key");
assert.match(as("anon", "select * from price_feed_private.bulletin_hidden_items() where false"), /^$/);
// صنف مخفي بلا مخزون لا يظهر في نافذة المولّد (استبعاده أصلاً من available_price_sync_feed العامة).
assert.equal(setVis("owner", "CCCCCCCC-0000-0000-0000-000000000001", "true"), "true");
assert.equal(as("anon", "select string_agg(item_key, ',' order by item_key) from public.bulletin_hidden_items_feed"), "صنف مخفي", "المخفي بلا مخزون مستبعد من النافذة");
assert.equal(setVis("owner", "CCCCCCCC-0000-0000-0000-000000000001", "false"), "false");

// لا سعر أو مخزون تغيّر.
assert.equal(run(PRICES_FINGERPRINT).stdout.trim(), before, "approved_price_items لم تتغيّر إطلاقاً");

// التراجع.
run(`create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
grant usage on schema supabase_migrations to supa_owner; grant select, delete on supabase_migrations.schema_migrations to supa_owner;`);
run(`set role supa_owner;\n${ROLLBACK}`);
assert.equal(run("select to_regclass('public.item_bulletin_visibility') is null and to_regclass('public.bulletin_hidden_items_feed') is null").stdout.trim(), "t");
assert.equal(run("select count(*) from pg_proc where proname in ('set_item_bulletin_visibility','bulletin_hidden_items')").stdout.trim(), "0");
assert.equal(run(PRICES_FINGERPRINT).stdout.trim(), before, "التراجع لا يمسّ الأسعار");

run(`drop database if exists ${DB}`, { db: "postgres" });
console.log("check-bulletin-visibility: OK (static + live SQL)");
