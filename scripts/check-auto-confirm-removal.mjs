// ============================================================================
// فحص Migration 25 (إيقاف التأكيد التلقائي لكل حساب جديد في auth.users).
//
// ثابت: عقود نصية على ملفَي الهجرة والتراجع، وأن inventory-auth ينشئ حساباته
// مؤكَّدة صراحةً (email_confirm: true) فلا يعتمد على المشغّل.
// حيّ (Postgres محلي فقط): يبني auth.users يملكه دور غير دور الهجرة (كما في
// Production: supabase_auth_admin يملك الجدول وpostgres يملك الدالة وله TRIGGER فقط)،
// ويثبّت الدالة بجسم الإنتاج الحرفي (md5 87419c26…)، ثم:
//   1) يثبت أن المشغّل يؤكّد أي صف غير مؤكَّد قبل الهجرة — حتى لا ينجح الفحص على فراغ.
//   2) يطبّق الهجرة بدور غير مالك: الحذف يُرفض فيبقى المشغّل، والدالة تمرير محض.
//   3) التطبيق المكرر والتراجع المكرر مرفوضان بلا أثر.
//   4) التراجع يعيد الجسم الحرفي والسلوك.
//   5) بدور مالك: المشغّل يُحذف، والتراجع يعيده بتعريفه الحرفي.
//   6) جسم مختلف عن المدقَّق ⇒ الحارس يرفض.
// ============================================================================
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const MIGRATION = read("supabase/proposed/25-remove-auto-confirm-trigger.sql");
const ROLLBACK = read("supabase/proposed/25-remove-auto-confirm-trigger-rollback.sql");
const INVENTORY_AUTH = read("supabase/functions/inventory-auth/index.ts");

// --- عقود ثابتة ----------------------------------------------------------------
// 25 مطبَّقة على الإنتاج (2026-10-25 10:21:51Z، الإصدار 20261025102151): النص مجمَّد، والنسخة المسجّلة مطابقة حرفياً.
// البصمة على نهايات LF: نسخة Windows بـcore.autocrlf=true تحمل CRLF والنص نفسه.
assert.equal(crypto.createHash("sha256").update(MIGRATION.replace(/\r\n/g, "\n")).digest("hex"), "6a9a7b59ffb11b8a7a9684f67ec479118df5ffa5d3f72ec6934b3ceadd2a421c", "proposed/25 يجب أن يبقى مطابقاً للنسخة المطبَّقة");
assert.equal(read("supabase/migrations/20261025102151_remove_auto_confirm_trigger.sql"), MIGRATION, "migrations/20261025102151_remove_auto_confirm_trigger.sql يجب أن تطابق proposed/25 حرفياً");
assert.match(MIGRATION, /^begin;/m, "الهجرة يجب أن تكون معاملة واحدة");
assert.match(MIGRATION, /migration 25 guard: already applied/);
assert.match(MIGRATION, /md5\(prosrc\)[^\n]*'87419c26b8fbe5fd1e29a7e180829363'/, "الحارس يقارن جسم الإنتاج المدقَّق");
assert.match(MIGRATION, /exception when insufficient_privilege then/, "رفض الحذف لغير المالك يجب أن يُلتقط لا أن يُفشل الهجرة");
const MIGRATION_SQL = MIGRATION.replace(/--[^\n]*/g, "");
assert.doesNotMatch(MIGRATION_SQL, /\b(delete\s+from|truncate|update\s+auth\.|alter\s+table|disable_signup|mailer_autoconfirm)/i,
  "الهجرة لا تمسّ المستخدمين ولا إعدادات Auth");
assert.doesNotMatch(MIGRATION_SQL, /drop\s+function/i, "الدالة تبقى لسهولة التراجع");
assert.match(ROLLBACK, /migration 25 is not applied/);
assert.match(ROLLBACK, /'87419c26b8fbe5fd1e29a7e180829363'/, "التراجع يتحقق من استعادة الجسم الحرفي");
assert.match(INVENTORY_AUTH, /email_confirm:\s*true/, "inventory-auth يجب أن ينشئ الحسابات مؤكَّدة بنفسه");

// --- الفحص الحي ------------------------------------------------------------------
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-auto-confirm-removal: refusing non-local PGHOST");
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
  console.log("check-auto-confirm-removal: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

const DB = "ozk_auto_confirm_test";
const OWNER = "ozk_ac_auth_owner"; // يقابل supabase_auth_admin
const APP = "ozk_ac_app"; // يقابل postgres على Supabase: يملك الدالة، وله TRIGGER على auth.users فقط
const run = (sql, { db = DB, ok = true } = {}) => {
  const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
  if (ok) assert.equal(r.status, 0, output(r));
  return r;
};
const asApp = (sql, opts) => run(`set role ${APP};\n${sql}`, opts);

run(`drop database if exists ${DB}`, { db: "postgres" });
run(`do $$ begin
  if not exists (select 1 from pg_roles where rolname = '${OWNER}') then create role ${OWNER} nologin; end if;
  if not exists (select 1 from pg_roles where rolname = '${APP}') then create role ${APP} nologin; end if;
end $$;
create database ${DB};`, { db: "postgres" });
run(`create schema auth authorization ${OWNER};
create table auth.users (id serial primary key, email text not null, email_confirmed_at timestamptz);
alter table auth.users owner to ${OWNER};
grant usage on schema auth to ${APP};
grant trigger on auth.users to ${APP};
grant create on schema public to ${APP};`);
asApp(`create function public.auto_confirm_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'auth', 'public', 'pg_temp'
as $function$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$function$;
create trigger auto_confirm_new_user_trg before insert on auth.users
  for each row execute function public.auto_confirm_new_user();`);

const md5 = () => run("select md5(prosrc) from pg_proc where oid = 'public.auto_confirm_new_user()'::regprocedure").stdout.trim();
const triggerDef = () => run("select coalesce(string_agg(pg_get_triggerdef(oid), ';'), '') from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal").stdout.trim();
// يدرج صفاً كما يفعل GoTrue (بدور مالك الجدول) ويعيد هل وصل مؤكَّداً.
let seq = 0;
const insertConfirmed = (confirmed) => {
  seq += 1;
  return run(`set role ${OWNER};
insert into auth.users (email, email_confirmed_at) values ('u${seq}@test.local', ${confirmed ? "now()" : "null"})
returning email_confirmed_at is not null;`).stdout.trim();
};
const PROD_MD5 = "87419c26b8fbe5fd1e29a7e180829363";
const PROD_TRIGGER = "CREATE TRIGGER auto_confirm_new_user_trg BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION auto_confirm_new_user()";

// 1) قبل: الجسم مطابق للإنتاج، والمشغّل يؤكّد كل صف.
assert.equal(md5(), PROD_MD5, "fixture يجب أن يطابق جسم الإنتاج");
assert.equal(triggerDef(), PROD_TRIGGER);
assert.equal(insertConfirmed(false), "t", "قبل الهجرة: المشغّل يؤكّد الصف غير المؤكَّد");

// 2) بدور غير مالك: الحذف مرفوض فيُلتقط، والدالة تمرير محض.
const applied = asApp(MIGRATION);
assert.match(output(applied), /trigger kept \(auth\.users not owned by ozk_ac_app\), function neutralized/);
assert.equal(triggerDef(), PROD_TRIGGER, "غير المالك لا يحذف المشغّل");
assert.notEqual(md5(), PROD_MD5);
assert.equal(insertConfirmed(false), "f", "بعد الهجرة: الصف غير المؤكَّد يبقى غير مؤكَّد");
assert.equal(insertConfirmed(true), "t", "بعد الهجرة: الإنشاء الإداري المؤكَّد صراحةً يبقى مؤكَّداً");

// 3) التطبيق المكرر مرفوض بلا أثر.
const neutralized = md5();
assert.match(output(asApp(MIGRATION, { ok: false })), /migration 25 guard: already applied/);
assert.equal(md5(), neutralized);

// 4) التراجع يعيد الجسم والسلوك حرفياً؛ والتراجع المكرر مرفوض.
asApp(ROLLBACK);
assert.equal(md5(), PROD_MD5);
assert.equal(triggerDef(), PROD_TRIGGER);
assert.equal(insertConfirmed(false), "t", "بعد التراجع: يعود التأكيد التلقائي");
assert.match(output(asApp(ROLLBACK, { ok: false })), /migration 25 rollback guard: migration 25 is not applied/);
assert.equal(md5(), PROD_MD5);

// 5) بدور مالك (superuser محلياً): المشغّل يُحذف، والتراجع بدور غير مالك يعيده.
assert.match(output(run(MIGRATION)), /migration 25: trigger dropped/);
assert.equal(triggerDef(), "");
assert.equal(insertConfirmed(false), "f");
asApp(ROLLBACK);
assert.equal(triggerDef(), PROD_TRIGGER, "التراجع يعيد المشغّل بتعريفه الحرفي");
assert.equal(md5(), PROD_MD5);
assert.equal(insertConfirmed(false), "t");

// 6) جسم انحرف عن المدقَّق ⇒ الحارس يرفض ولا يغيّر شيئاً.
asApp(`create or replace function public.auto_confirm_new_user() returns trigger language plpgsql
security definer set search_path to 'auth', 'public', 'pg_temp' as $f$ begin return new; end; $f$;`);
const drifted = md5();
assert.match(output(asApp(MIGRATION, { ok: false })), /function body differs from audited production/);
assert.equal(md5(), drifted);

run(`drop database if exists ${DB}`, { db: "postgres" });
console.log("check-auto-confirm-removal: static + live (before/non-owner/reapply/rollback/owner/drift) passed.");
