// ============================================================================
// فحص تصنيف الأصناف عامة/وزاري (src/bulletin-classification.js) وMigration 28.
//
// ثابت: الموقع والمولّد يستعملان المصدر نفسه ولا يحملان قاعدة اسم خاصة بهما؛
//        الوينستون المخصص (463/464) عامة بالـGUID؛ لا ترث صنفاً آخر بالاسم؛
//        قسم «تسعير أصناف الوزاري» مستقل عن «تسعير الأصناف العامة».
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
const MODULE = read("src/bulletin-classification.js");
const APP = read("src/app.js");
const CLIENT = read("src/supabase-client.js");
const GENERATOR = read("scripts/generate-price-lists.mjs");
const INDEX = read("index.html");
const SW = read("public/service-worker.js");
const MIGRATION = read("supabase/proposed/28-item-bulletin-classifications.sql");
const ROLLBACK = read("supabase/proposed/28-item-bulletin-classifications-rollback.sql");
// مطبّقة على الإنتاج بالإصدار 20261105170000؛ نسخة migrations يجب أن تطابق proposed/28 حرفياً
// كي لا يراها Supabase CLI هجرة مختلفة أو ناقصة.
assert.equal(read("supabase/migrations/20261105170000_item_bulletin_classifications.sql"), MIGRATION,
  "migrations/20261105170000_item_bulletin_classifications.sql يجب أن تطابق proposed/28 حرفياً");

await import("../src/bulletin-classification.js");
const C = globalThis.ozkBulletinClassification;
assert.ok(C, "الوحدة تصدّر ozkBulletinClassification");

const BLUE = "294A7DC9-9BB3-4BEF-8791-F3C336AFD727";
const SILVER = "B29EB8C3-A1FE-4FEB-A18A-30E26189FDA2";

// --- 1) التصحيحان المؤكدان: GUID ورقم واسم، بلا تكرار --------------------------
const confirmed = C.CONFIRMED_OVERRIDES;
assert.equal(confirmed.length, 2);
assert.deepEqual(confirmed.map((r) => [r.itemGuid, r.itemNumber, r.itemKey, r.bulletin]), [
  [BLUE, "463", "وينستون ازرق مخصص", "general"],
  [SILVER, "464", "وينستون فضي مخصص", "general"]
]);
assert.equal(new Set(confirmed.map((r) => r.itemGuid)).size, confirmed.length, "لا GUID مكرر");
assert.equal(new Set(confirmed.map((r) => C.normalizeName(r.itemKey))).size, confirmed.length, "لا مفتاح مكرر");
confirmed.forEach((r) => assert.equal(C.normalizeGuid(r.itemGuid), r.itemGuid, "GUID بصيغة الأمين"));

// --- 2) قاعدة الاسم مطابقة حرفياً لما كان في app.js قبل الإصلاح ---------------------
const legacyNormalize = (value) => String(value ?? "").trim().replace(/^\d{2,}\s*[-–—]\s*/u, "")
  .replace(/[ـًٌٍَُِّْ]/gu, "").replace(/[إأآٱ]/gu, "ا").replace(/ى/gu, "ي").replace(/ة/gu, "ه")
  .replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
function legacyIsWazari(raw) {
  const name = legacyNormalize(raw);
  if (name.includes("نخله") && (name.includes("محزر") || name.includes("وزاري"))) return true;
  if (name.includes("كينت") && !name.includes("حره")) return true;
  if (name.includes("وينستون") && !name.includes("حره")) return true;
  if (name.includes("فاخر") && name.includes("اسود") && name.includes("محزر")) return true;
  if (name.includes("مالبورو") && (name.includes("محزر") ||
    (name.includes("ورق") && (name.includes("ابيض") || name.includes("احمر"))) ||
    (name.includes("كوين") && name.includes("ازرق")))) return true;
  return false;
}
const SAMPLE_NAMES = [
  "وينستون أزرق", "وينستون فضي", "وينستون ازرق حرة", "وينستون احمر حرة", "وينستون ازرق علب",
  "وينستون ازرق مخصص", "وينستون فضي مخصص", "كينت أزرق", "كينت ازرق حرة", "نخلة محزر لبناني",
  "نخلة كف محزر لبناني", "معسل نخلة 100غ", "معسل فاخر اسود محزر", "معسل الفاخر ربع محزر",
  "مالبورو غولد طابع", "مالبورو ورق أبيض", "مالبورو كوين أزرق", "مالبورو محزر", "اليغانس طويل فضي مخصص",
  "123 - وينستون فضي", "ماستر كوين أبيض"
];
for (const name of SAMPLE_NAMES) {
  assert.equal(C.nameRuleBulletin(name) === "wazari", legacyIsWazari(name), `قاعدة الاسم تغيّرت لـ«${name}»`);
  assert.equal(C.normalizeName(name), legacyNormalize(name), `التطبيع اختلف عن normalizeItemName لـ«${name}»`);
}
// والتطبيع في الوحدة يطابق normalizeItemName في app.js نصاً.
const appNormalize = /function normalizeItemName\(value\) \{\s*const normalized = String\(value \?\? ""\)([\s\S]*?)\.toLowerCase\(\);/.exec(APP);
assert.ok(appNormalize, "normalizeItemName في app.js");
assert.ok(MODULE.replace(/\s+/g, "").includes(appNormalize[1].replace(/\s+/g, "")), "تطبيع الوحدة = normalizeItemName في app.js");

// --- 3) الحكم ---------------------------------------------------------------------
const cls = (item, idx) => C.classifyItem(item, idx);
// الموقع: GUID من الجرد (أحرف صغيرة كما يرسلها الأمين).
assert.deepEqual([cls({ itemGuid: BLUE.toLowerCase(), name: "وينستون ازرق مخصص" }).bulletin, cls({ itemGuid: BLUE.toLowerCase(), name: "وينستون ازرق مخصص" }).source], ["general", "confirmed_override"]);
assert.equal(cls({ itemGuid: SILVER.toLowerCase(), key: "وينستون فضي مخصص", name: "وينستون فضي مخصص" }).bulletin, "general");
// إعادة تسمية الصنف في الأمين لا تُسقط التصحيح (الهوية بالـGUID).
assert.equal(cls({ itemGuid: BLUE, name: "وينستون ازرق" }).bulletin, "general");
// صنف آخر باسم مطابق وGUID مختلف لا يرث التصحيح.
assert.equal(cls({ itemGuid: "11111111-2222-3333-4444-555555555555", name: "وينستون ازرق مخصص" }).bulletin, "wazari");
// المولّد: صف النافذة بلا GUID ⇒ بالمفتاح الحرفي.
assert.equal(cls({ itemKey: "وينستون ازرق مخصص", name: "وينستون ازرق مخصص" }).bulletin, "general");
assert.equal(cls({ itemKey: "وينستون فضي مخصص", name: "وينستون فضي مخصص" }).bulletin, "general");
// باقي الوزاري الفعلي باقٍ وزاري، والعام عام.
assert.equal(cls({ itemGuid: "375EF607-3E41-491D-9546-E7BDE8B1BDF0", name: "وينستون فضي" }).bulletin, "wazari");
assert.equal(cls({ itemKey: "كينت ازرق", name: "كينت أزرق" }).bulletin, "wazari");
assert.equal(cls({ itemKey: "نخله محزر لبناني", name: "نخلة محزر لبناني" }).bulletin, "wazari");
assert.equal(cls({ itemKey: "وينستون احمر حره", name: "وينستون احمر حرة" }).bulletin, "general");
// تصحيح المالك يغلب المثبّت، ويُطبَّق بالمفتاح على النافذة العامة أيضاً.
const ownerIdx = C.buildOverrideIndex([
  { item_guid: BLUE, item_key: "وينستون ازرق مخصص", bulletin: "wazari" },
  { item_guid: "375EF607-3E41-491D-9546-E7BDE8B1BDF0", item_key: "وينستون فضي", bulletin: "general" },
  { item_key: "كينت ازرق", bulletin: "general" },
  { item_guid: "AAAAAAAA-0000-0000-0000-000000000001", item_key: "اسم ملتبس", bulletin: "general" },
  { item_guid: "AAAAAAAA-0000-0000-0000-000000000002", item_key: "اسم ملتبس", bulletin: "wazari" },
  { item_guid: "AAAAAAAA-0000-0000-0000-000000000003", item_key: "خطأ", bulletin: "bogus" }
]);
assert.deepEqual([cls({ itemGuid: BLUE }, ownerIdx).bulletin, cls({ itemGuid: BLUE }, ownerIdx).source], ["wazari", "owner_override"]);
assert.equal(cls({ itemKey: "وينستون ازرق مخصص" }, ownerIdx).bulletin, "wazari", "النافذة ترى تصحيح المالك بالمفتاح");
assert.equal(cls({ itemGuid: SILVER, name: "وينستون فضي مخصص" }, ownerIdx).bulletin, "general", "المثبّت باقٍ لما لم يصحّحه المالك");
assert.equal(cls({ itemGuid: "375ef607-3e41-491d-9546-e7bde8b1bdf0", name: "وينستون فضي" }, ownerIdx).bulletin, "general");
assert.equal(cls({ itemKey: "كينت ازرق", name: "كينت أزرق" }, ownerIdx).bulletin, "general");
assert.equal(cls({ itemKey: "اسم ملتبس", name: "وينستون ملتبس" }, ownerIdx).source, "name_rule", "مفتاح لـGUIDين مختلفين لا يُطبَّق بالمفتاح");
assert.equal(cls({ itemGuid: "AAAAAAAA-0000-0000-0000-000000000003", name: "وينستون خطأ" }, ownerIdx).source, "name_rule", "نشرة غير صالحة تُهمل");

// --- 4) مصدر واحد: الموقع والمولّد ------------------------------------------------
assert.doesNotMatch(APP.replace(/\/\/.*$/gm, ""), /includes\("وينستون"\)/, "app.js لا يحمل قاعدة اسم خاصة به");
assert.doesNotMatch(GENERATOR.replace(/\/\/.*$/gm, ""), /includes\(name, "وينستون"\)/, "المولّد لا يحمل قاعدة اسم خاصة به");
assert.match(APP, /function isWazariPriceItem\(item\) \{\s*return itemBulletinClassification\(item\)\.bulletin === "wazari";/);
assert.match(GENERATOR, /import "\.\.\/src\/bulletin-classification\.js";/);
assert.match(GENERATOR, /bulletinEngine\.isWazariItem\(\{ itemKey: item\.key \|\| item\.name, name: item\.name \}, bulletinIndex\)/);
assert.match(GENERATOR, /key: String\(r\.item_key \|\| ""\)\.trim\(\),/, "المولّد يحمل item_key للمطابقة");
assert.match(GENERATOR, /bulletin_item_classification_feed\?select=item_key,bulletin/);
const pos = (needle) => INDEX.indexOf(needle);
assert.ok(pos("src/bulletin-classification.js?v=tobacco-") > 0 && pos("src/bulletin-classification.js") < pos("src/app.js"),
  "الوحدة تُحمَّل قبل app.js وبمعامل النسخة");
assert.match(SW, /"src\/bulletin-classification\.js"/, "الوحدة في كاش التطبيق");

// --- 5) شاشة التسعير: قسمان مستقلان ----------------------------------------------
assert.match(APP, /<h3>تسعير الأصناف العامة<\/h3>/);
assert.match(APP, /<h3>تسعير أصناف الوزاري<\/h3>/);
assert.match(APP, /\$\{wazariPricingSection\(\)\}/, "قسم الوزاري مرسوم في صفحة النشرة");
assert.match(APP, /function wazariPricingWorklistItems\(\) \{\s*return pricingWorklistItems\(\{ ignoreSearch: true \}\)\s*\.filter\(\(item\) => isWazariPriceItem\(item\)\)/);
assert.match(APP, /items\.filter\(\(item\) => !isWazariPriceItem\(item\)\)\.forEach/, "النشرة العامة تستبعد الوزاري");
assert.match(APP, /const canEdit = isOwner\(\) && Boolean\(guid\)/, "تصحيح التصنيف للمالك وحده في الواجهة");
assert.match(APP, /غير مسعّر/, "غير المسعّر ظاهر صراحة");
assert.match(CLIENT, /rpc\("set_item_bulletin_classification"/);
assert.doesNotMatch(CLIENT, /from\("item_bulletin_classifications"\)\s*\.(insert|update|upsert|delete)/, "لا كتابة مباشرة من المتصفح");

// --- 6) الهجرة: ثوابت ---------------------------------------------------------------
assert.match(MIGRATION, /^begin;/m);
assert.match(MIGRATION, /^commit;/m);
assert.match(MIGRATION, /migration 28 guard: already applied/);
assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ""),
  /\b(delete\s+from\s+public\.(?!item_bulletin_classifications\b)|truncate|drop\s+|alter\s+table\s+public\.(?!item_bulletin_classification))/i,
  "الهجرة لا تمسّ جداول قائمة");
assert.doesNotMatch(MIGRATION, /(update|insert\s+into)\s+public\.approved_price_items/i, "لا تغيير لأي سعر");
assert.doesNotMatch(MIGRATION, /grant\s+(insert|update|delete|all)[^;]*item_bulletin_classification/i, "لا كتابة مباشرة على الجدولين");
assert.match(MIGRATION, /if not public\.is_owner\(\) or auth\.uid\(\) is null then/);
assert.doesNotMatch(MIGRATION, /approved_price_sync_feed/, "لا مساس بنافذة #291");
const feedSelect = /create view public\.bulletin_item_classification_feed[^;]*select ([^;]*?) from/i.exec(MIGRATION);
assert.equal(feedSelect?.[1].trim(), "item_key, bulletin", "النافذة العامة: item_key والنشرة فقط");
assert.match(ROLLBACK, /migration 28 is not applied/);

// --- 7) الفحص الحي -------------------------------------------------------------------
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-bulletin-classification: refusing non-local PGHOST");
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
  console.log("check-bulletin-classification: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

const DB = "ozk_bulletin_classification_test";
const run = (sql, { db = DB, ok = true } = {}) => {
  const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
  if (ok) assert.equal(r.status, 0, output(r));
  return r;
};
run(`drop database if exists ${DB}`, { db: "postgres" });
run(`create database ${DB}`, { db: "postgres" });

// بنية Supabase مصغّرة؛ is_staff/is_owner ونافذة الأسعار منسوخة من Production (2026-11-05).
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
create table public.staff_allowlist(email text primary key);
insert into public.staff_allowlist values ('owner@test.local'), ('employee@test.local'), ('inv@accounts.test');
create function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $function$
  select exists (select 1 from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', '')));
$function$;
create function public.is_owner() returns boolean language sql stable
set search_path to 'public', 'pg_temp' as $function$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$function$;
create table public.approved_price_items(item_key text primary key, item_name text, item_guid text, unit2_price numeric, stock_qty numeric, price_payload jsonb);
alter table public.approved_price_items enable row level security;
insert into public.approved_price_items values
  ('وينستون ازرق مخصص', 'وينستون ازرق مخصص', '294a7dc9-9bb3-4bef-8791-f3c336afd727', 650, 50, '{"retail":{"price":660}}'),
  ('وينستون فضي مخصص', 'وينستون فضي مخصص', '${SILVER}', 650, 0, '{}'),
  ('صنف عام', 'صنف عام', 'CCCCCCCC-0000-0000-0000-000000000001', 100, 10, '{}');
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

// البذر: التصحيحان + سطرا تدقيق.
assert.equal(run("select string_agg(item_guid||':'||bulletin||':'||item_number, ',' order by item_number) from public.item_bulletin_classifications").stdout.trim(),
  `${BLUE}:general:463,${SILVER}:general:464`);
assert.equal(run("select count(*) from public.item_bulletin_classification_audit where new_bulletin='general' and old_bulletin is null").stdout.trim(), "2");

// القراءة.
assert.match(as("anon", "select count(*) from public.item_bulletin_classifications"), /^ERR:permission denied/);
assert.match(as("anon", "select count(*) from public.item_bulletin_classification_audit"), /^ERR:permission denied/);
assert.equal(as("employee", "select count(*) from public.item_bulletin_classifications"), "2");
assert.equal(as("counter", "select count(*) from public.item_bulletin_classifications"), "0");
assert.equal(as("stranger", "select count(*) from public.item_bulletin_classifications"), "0");
assert.equal(as("employee", "select count(*) from public.item_bulletin_classification_audit"), "0", "سجل التدقيق للمالك وحده");
assert.equal(as("owner", "select count(*) from public.item_bulletin_classification_audit"), "2");
// نافذة المولّد العامة: أصناف المخزون الموجب وحدها، بلا أي عمود آخر.
assert.equal(as("anon", "select string_agg(item_key||'='||bulletin, ',') from public.bulletin_item_classification_feed"), "وينستون ازرق مخصص=general");
assert.equal(run("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name='bulletin_item_classification_feed'").stdout.trim(), "item_key,bulletin");
assert.match(as("anon", "select * from price_feed_private.bulletin_classification_rows() where false"), /^$/);

// الكتابة: المالك وحده وعبر الدالة وحدها.
const set = (who, guid, bulletin, reason = "تصحيح اختبار") =>
  as(who, `select public.set_item_bulletin_classification('${guid}', '${bulletin}', 'مفتاح', 'اسم', '${reason}')->>'bulletin'`);
assert.match(set("anon", BLUE, "wazari"), /^ERR:permission denied/);
assert.match(set("employee", BLUE, "wazari"), /^ERR:not_allowed/);
assert.match(set("counter", BLUE, "wazari"), /^ERR:not_allowed/);
assert.match(set("stranger", BLUE, "wazari"), /^ERR:not_allowed/);
assert.match(as("owner", `insert into public.item_bulletin_classifications(item_guid, bulletin, reason) values ('${BLUE}', 'wazari', 'xxx')`), /^ERR:permission denied/);
assert.match(as("owner", "update public.item_bulletin_classification_audit set reason='x'"), /^ERR:permission denied/);
assert.match(as("owner", "delete from public.item_bulletin_classification_audit"), /^ERR:permission denied/);
assert.match(set("owner", "not-a-guid", "wazari"), /^ERR:invalid_item_guid/);
assert.match(set("owner", BLUE, "other"), /^ERR:invalid_bulletin/);
assert.match(set("owner", BLUE, "wazari", "  "), /^ERR:reason_required/);
assert.equal(set("owner", `{${BLUE.toLowerCase()}}`, "wazari"), "wazari", "GUID يُطبَّع (أقواس/أحرف صغيرة)");
assert.equal(run(`select bulletin, updated_by_email, item_key from public.item_bulletin_classifications where item_guid='${BLUE}'`).stdout.trim(), "wazari|owner@test.local|مفتاح");
assert.equal(run(`select old_bulletin||'>'||new_bulletin||'|'||changed_by_email from public.item_bulletin_classification_audit where item_guid='${BLUE}' order by id desc limit 1`).stdout.trim(), "general>wazari|owner@test.local");
assert.equal(set("owner", BLUE, "auto"), "auto");
assert.equal(run(`select count(*) from public.item_bulletin_classifications where item_guid='${BLUE}'`).stdout.trim(), "0", "auto يزيل التصحيح");
assert.equal(run(`select count(*) from public.item_bulletin_classification_audit where item_guid='${BLUE}'`).stdout.trim(), "3", "كل تغيير له سطر تدقيق");

// لا سعر تغيّر.
assert.equal(run(PRICES_FINGERPRINT).stdout.trim(), before, "approved_price_items لم تتغيّر إطلاقاً");

// التراجع.
run(`create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key, name text, statements text[]);
grant usage on schema supabase_migrations to supa_owner; grant select, delete on supabase_migrations.schema_migrations to supa_owner;`);
run(`set role supa_owner;\n${ROLLBACK}`);
assert.equal(run("select to_regclass('public.item_bulletin_classifications') is null and to_regclass('public.bulletin_item_classification_feed') is null").stdout.trim(), "t");
assert.equal(run("select count(*) from pg_proc where proname in ('set_item_bulletin_classification','bulletin_classification_rows')").stdout.trim(), "0");
assert.equal(run(PRICES_FINGERPRINT).stdout.trim(), before, "التراجع لا يمسّ الأسعار");

run(`drop database if exists ${DB}`, { db: "postgres" });
console.log("check-bulletin-classification: OK (static + live SQL)");
