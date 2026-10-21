// ============================================================================
// تقريرا الحركة اليومية والجرد: رسالة واحدة لكل تاريخ تقرير (supabase/proposed/19 و20).
//
// طبقتان:
//   ١) عقود ساكنة: كل هجرة تعدّل دالة trigger واحدة بحارس بصمة قبل وبعد، ولا تمسّ notify_telegram
//      ولا notify_telegram_dispatch ولا Cron ولا تكتب في telegram_outbox؛ تنبيه الدفعات بمفتاحه ونافذته؛
//      والتراجع يعيد جسم الإنتاج حرفياً (مطابق لنسخة بيئة الاختبار).
//   ٢) تشغيل حي على PostgreSQL محلي فوق نسخ حرفية من دوال الإنتاج (بصماتها مُتحقَّق منها): أول إرسال،
//      إعادة التشغيل في اليوم نفسه، اختلاف الوقت، يوم دمشق الجديد، دفعة Cron متأخرة، جلستان متزامنتان،
//      صف فاشل وإعادة محاولته، غياب صف outbox، نافذة 14 يوماً، تاريخ مُرسَل نُظّف من outbox، غياب التاريخ،
//      البذر من outbox، الاستقلال بين الهجرتين، رفض إعادة التطبيق، والتراجع.
// لا شبكة ولا تيليغرام حقيقي ولا بيانات إنتاج.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const FILES = {
  m19: read("supabase/proposed/19-daily-movement-once-per-date.sql"),
  r19: read("supabase/proposed/19-daily-movement-once-per-date-rollback.sql"),
  m20: read("supabase/proposed/20-inventory-report-once-per-date.sql"),
  r20: read("supabase/proposed/20-inventory-report-once-per-date-rollback.sql")
};
const envSql = read("supabase/tests/daily-report-once-per-date-env.sql");

const PROD = {
  movement: "feb6663e6fcebe7ca17248960e0ec8d8",
  inventory: "775cf58c60f4e147e94b760f3d95e540",
  notify: "6ca4caa80df699aa530ef9aee3c86bda",
  dispatch: "c35b5c198c2b10b3901471bf5b1cbec1"
};
const NEW = { movement: "287872ff20674cf03adb840ec48e9722", inventory: "578be73ec38616f4c5d5537b0435aba7" };

// تعريف دالة كامل (من CREATE حتى $function$;).
function definition(text, name) {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.ok(start >= 0, `${name}: تعريف مفقود`);
  assert.equal(text.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`, start + 1), -1, `${name}: تعريف واحد متوقَّع`);
  const end = text.indexOf("$function$;", text.indexOf("AS $function$", start) + 13);
  return text.slice(start, end + "$function$;".length);
}

// ── ١) عقود ساكنة ─────────────────────────────────────────────────────────────────────────
const strip = (s) => s.replace(/--.*$/gm, "");
for (const [m, r, fn, prod, fresh] of [
  ["m19", "r19", "public.tg_notify_daily_movement", PROD.movement, NEW.movement],
  ["m20", "r20", "public.tg_notify_inventory_report", PROD.inventory, NEW.inventory]
]) {
  const code = strip(FILES[m]);
  assert.match(code, new RegExp(`is distinct from '${prod}'`), `${m}: حارس البصمة قبل التطبيق`);
  assert.match(code, new RegExp(`is distinct from '${fresh}'`), `${m}: حارس البصمة بعد التطبيق`);
  assert.equal((code.match(/CREATE OR REPLACE FUNCTION/gi) || []).length, 1, `${m}: دالة واحدة فقط`);
  assert.doesNotMatch(code, /notify_telegram_dispatch|dispatch_telegram_outbox|cron\.|insert\s+into\s+public\.telegram_outbox|update\s+public\.telegram_outbox|delete\s+from\s+public\.telegram_outbox/i, `${m}: لا يمسّ الإرسال ولا Cron ولا outbox`);
  assert.match(code, /on conflict do nothing;\s*get diagnostics v_claimed = row_count;/, `${m}: مطالبة ذرّية بالتاريخ`);
  assert.match(code, /at time zone 'Asia\/Damascus'/, `${m}: تاريخ دمشق`);
  assert.match(code, /- 14\b/, `${m}: نافذة 14 يوماً`);
  assert.match(code, /^begin;[\s\S]*^commit;\s*$/m, `${m}: معاملة واحدة`);
  // التراجع = جسم بيئة الاختبار (= الإنتاج) حرفياً
  assert.equal(definition(FILES[r], fn), definition(envSql, fn), `${r}: التراجع يعيد جسم الإنتاج حرفياً`);
  assert.match(strip(FILES[r]), new RegExp(`is distinct from '${fresh}'`), `${r}: يرفض إن لم تكن النسخة الجديدة`);
}
// تنبيه الدفعات في 19 بنصه ومفتاحه ونافذته كما في الإنتاج
const tail = (s) => s.slice(s.indexOf("  select coalesce(r.payload->'payments'"), s.indexOf("$function$;", s.indexOf("  select coalesce(r.payload->'payments'")));
assert.equal(tail(definition(FILES.m19, "public.tg_notify_daily_movement")), tail(definition(envSql, "public.tg_notify_daily_movement")), "19: جزء الدفعات حرفياً كما في الإنتاج");
console.log("  ✓ عقود ساكنة: دالة واحدة لكل هجرة بحارسَي بصمة، لا إرسال ولا Cron، الدفعات كما هي، والتراجع حرفي");

// ── ٢) تشغيل حي ──────────────────────────────────────────────────────────────────────────
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-daily-report-once-per-date: refusing non-local PGHOST");
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
  console.log("check-daily-report-once-per-date: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}

const DB = "ozk_daily_report_test";
const run = (sql, { db = DB, ok = true } = {}) => {
  const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
  if (ok) assert.equal(r.status, 0, output(r));
  return r;
};
const val = (sql) => run(sql).stdout.trim();
const fresh = (...migs) => {
  run(`drop database if exists ${DB}`, { db: "postgres" });
  run(`create database ${DB}`, { db: "postgres" });
  run(envSql);
  for (const m of migs) run(FILES[m]);
};
const KIND = {
  movement: { mig: "m19", rb: "r19", prefix: "movement", event: "daily_movement", fn: "tg_notify_daily_movement",
    snap: (d) => `insert into public.daily_movement_reports(report_date, payload) values (${d}, '{"payments":[]}');` },
  inventory: { mig: "m20", rb: "r20", prefix: "inventory", event: "inventory_report", fn: "tg_notify_inventory_report",
    snap: (d) => `insert into public.inventory_reports(report_date, source, items) values (${d}, 'ameen_inventory', '[1,2,3]');` }
};
const TODAY = "(now() at time zone 'Asia/Damascus')::date";
const dateSql = (offset) => `(${TODAY} + ${offset})`;
const keyOf = (k, offset) => val(`select '${k.prefix}:' || ${dateSql(offset)}::text`);
const count = (k, offset = 0) => Number(val(`select count(*) from public.telegram_outbox where event_type='${k.event}' and dedupe_key='${keyOf(k, offset)}'`));
const fp = (name) => val(`select md5(prosrc) from pg_proc where proname='${name}'`);
let checks = 0;
const eq = (got, want, msg) => { assert.equal(got, want, msg); checks += 1; };

// تأكيد: نسخ البيئة = الإنتاج
fresh();
eq(fp("tg_notify_daily_movement"), PROD.movement, "env: movement = production");
eq(fp("tg_notify_inventory_report"), PROD.inventory, "env: inventory = production");
eq(fp("notify_telegram"), PROD.notify, "env: notify = production");
eq(fp("notify_telegram_dispatch"), PROD.dispatch, "env: dispatch = production");
// إعادة إنتاج العطل على النسخة الحالية: إرسال ثانٍ بعد مرور النافذة
for (const [name, k, hours] of [["movement", KIND.movement, "12 hours 5 minutes"], ["inventory", KIND.inventory, "20 hours 5 minutes"]]) {
  run(k.snap(dateSql(0)));
  run(`update public.telegram_outbox set created_at = now() - interval '${hours}' where event_type='${k.event}'`);
  run(k.snap(dateSql(0)));
  eq(count(k), 2, `${name}: النسخة الحالية تُرسل مرتين بعد ${hours} (العطل مُعاد إنتاجه)`);
}

async function concurrent(k, offset) {
  const first = spawn(command, argvOf(["-X", "-q", "-d", DB, "-v", "ON_ERROR_STOP=1", "-c",
    `begin; ${k.snap(dateSql(offset))} select pg_sleep(1.5); commit;`]));
  const done = new Promise((resolve) => first.on("close", resolve));
  await new Promise((r) => setTimeout(r, 400));
  run(k.snap(dateSql(offset)));
  assert.equal(await done, 0, "الجلسة الأولى");
}

for (const [name, k] of Object.entries(KIND)) {
  const other = name === "movement" ? KIND.inventory : KIND.movement;
  fresh(k.mig);
  eq(fp(k.fn), NEW[name], `${name}: البصمة بعد التطبيق`);
  eq(fp(other.fn), PROD[name === "movement" ? "inventory" : "movement"], `${name}: الهجرة لا تمسّ التقرير الآخر`);
  eq(fp("notify_telegram") + fp("notify_telegram_dispatch"), PROD.notify + PROD.dispatch, `${name}: notify/dispatch دون تغيير`);
  // 1) أول إرسال
  run(k.snap(dateSql(0))); eq(count(k), 1, `${name} 1: أول لقطة تُرسل`);
  // 2) إعادة التشغيل في اليوم نفسه
  run(k.snap(dateSql(0)) + k.snap(dateSql(0))); eq(count(k), 1, `${name} 2: إعادة التشغيل في اليوم نفسه`);
  // 3) اختلاف وقت التشغيل: بعد 12:05 و20:05 و23:59 من الإرسال الأول
  for (const h of ["12 hours 5 minutes", "20 hours 5 minutes", "23 hours 59 minutes"]) {
    run(`update public.telegram_outbox set created_at = now() - interval '${h}'; update private.daily_report_notifications set claimed_at = now() - interval '${h}';`);
    run(k.snap(dateSql(0))); eq(count(k), 1, `${name} 3: لقطة بعد ${h}`);
  }
  // 4) يوم دمشق الجديد: رسالة واحدة جديدة
  run(k.snap(dateSql(1)) + k.snap(dateSql(1))); eq(count(k, 1), 1, `${name} 4: اليوم التالي يُرسل مرة`);
  // 5) دفعة Cron متأخرة في معاملة واحدة
  run(`begin; ${k.snap(dateSql(2))} ${k.snap(dateSql(2))} ${k.snap(dateSql(2))} commit;`); eq(count(k, 2), 1, `${name} 5: دفعة متأخرة في معاملة`);
  // 6) جلستان متزامنتان فعلاً
  await concurrent(k, 3); eq(count(k, 3), 1, `${name} 6: جلستان متزامنتان`);
  // 7) صف فاشل: لا صف ثانٍ، والصف نفسه يُحيا لإعادة المحاولة (منطق dispatch_telegram_outbox الحي)
  run(`update public.telegram_outbox set status='failed', attempts=5, sent_at=now()-interval '2 hours' where dedupe_key='${keyOf(k, 0)}'`);
  run(k.snap(dateSql(0))); eq(count(k), 1, `${name} 7a: الصف الفاشل لا يُكرَّر`);
  run(`update public.telegram_outbox set status = 'pending', attempts = 0 where status = 'failed' and sent_at < now() - interval '1 hour'`);
  eq(val(`select status || attempts from public.telegram_outbox where dedupe_key='${keyOf(k, 0)}'`), "pending0", `${name} 7b: الصف الفاشل يُحيا لإعادة المحاولة`);
  eq(val(`select (n.outbox_id = o.id)::text from private.daily_report_notifications n join public.telegram_outbox o on o.dedupe_key='${keyOf(k, 0)}' where n.report_kind='${k.event}' and n.report_date=${dateSql(0)}`), "true", `${name} 7c: السجل مربوط بصف الرسالة`);
  // 8) لم يُنشأ صف outbox (امتصاص أو فشل صامت): لا يُحسب مُرسَلاً، واللقطة التالية ترسل
  run(`create or replace function private.absorb_digest_alert(text, text, text) returns boolean language sql as $$ select true $$;`);
  run(k.snap(dateSql(4))); eq(count(k, 4), 0, `${name} 8a: لا صف`);
  eq(val(`select count(*) from private.daily_report_notifications where report_kind='${k.event}' and report_date=${dateSql(4)}`), "0", `${name} 8b: الادعاء يُلغى`);
  run(`create or replace function private.absorb_digest_alert(text, text, text) returns boolean language sql as $$ select false $$;`);
  run(k.snap(dateSql(4))); eq(count(k, 4), 1, `${name} 8c: اللقطة التالية ترسل`);
  // 9) نافذة 14 يوماً: عمر 14 يُرسل مرة، 15 لا يُرسل ولا يُسجَّل
  run(k.snap(dateSql(-14)) + k.snap(dateSql(-14))); eq(count(k, -14), 1, `${name} 9a: تقرير متأخر 14 يوماً يُرسل مرة`);
  run(k.snap(dateSql(-15))); eq(count(k, -15), 0, `${name} 9b: تقرير أقدم من 14 يوماً لا يُرسل`);
  eq(val(`select count(*) from private.daily_report_notifications where report_kind='${k.event}' and report_date=${dateSql(-15)}`), "0", `${name} 9c: ولا يُسجَّل`);
  // 10) تاريخ أُرسل ثم نظّف cleanup-telegram-outbox صفّه: لا يُعاد
  run(`delete from public.telegram_outbox where dedupe_key='${keyOf(k, -14)}'`);
  run(k.snap(dateSql(-14))); eq(count(k, -14), 0, `${name} 10: لا إعادة بعد تنظيف outbox`);
  // 11) غياب report_date: مفتاح بتاريخ دمشق مهما كانت منطقة الجلسة
  run(`delete from public.telegram_outbox; delete from private.daily_report_notifications; set timezone = 'Pacific/Kiritimati'; ${k.snap("null")}`);
  eq(val(`select dedupe_key from public.telegram_outbox where event_type='${k.event}'`), keyOf(k, 0), `${name} 11: الاحتياط بتاريخ دمشق`);
  // 12) البذر: صف outbox قبل التطبيق لتاريخ اليوم ⇒ لا رسالة ثانية بعده
  fresh();
  run(k.snap(dateSql(0)));
  run(`update public.telegram_outbox set created_at = now() - interval '23 hours 30 minutes'`);
  run(FILES[k.mig]);
  run(k.snap(dateSql(0))); eq(count(k), 1, `${name} 12: البذر يمنع إعادة تاريخ أُرسل قبل التطبيق`);
  // 13) رفض إعادة التطبيق دون أي أثر
  eq(run(FILES[k.mig], { ok: false }).status, 3, `${name} 13a: إعادة التطبيق مرفوضة`);
  eq(fp(k.fn), NEW[name], `${name} 13b: الجسم لم يتغيّر بعد الرفض`);
  // 14) التراجع حرفي، ويحذف صفوفه، ويُسقط الجدول إن لم يستعمله غيره
  run(FILES[k.rb]);
  eq(fp(k.fn), PROD[name], `${name} 14a: التراجع يعيد جسم الإنتاج`);
  eq(val(`select to_regclass('private.daily_report_notifications') is null`), "t", `${name} 14b: الجدول يُسقط إن لم يستعمله غيره`);
}

// الهجرتان معاً: مستقلتان، وتراجع واحدة لا يُسقط جدول الأخرى
fresh("m19", "m20");
run(KIND.movement.snap(dateSql(0)) + KIND.inventory.snap(dateSql(0)) + KIND.movement.snap(dateSql(0)) + KIND.inventory.snap(dateSql(0)));
eq(count(KIND.movement) + count(KIND.inventory), 2, "19+20: رسالة واحدة لكل تقرير");
run(FILES.r19);
eq(fp("tg_notify_daily_movement"), PROD.movement, "19+20: تراجع 19 وحده");
eq(fp("tg_notify_inventory_report"), NEW.inventory, "19+20: 20 باقية");
eq(val(`select count(*) from private.daily_report_notifications where report_kind='inventory_report'`), "1", "19+20: سجل 20 باقٍ");
run(KIND.inventory.snap(dateSql(0))); eq(count(KIND.inventory), 1, "19+20: 20 تعمل بعد تراجع 19");
run(FILES.r20);
eq(val(`select to_regclass('private.daily_report_notifications') is null`), "t", "19+20: الجدول يُسقط بعد التراجعين");
// تنبيه الدفعات بعد 19: دفعة جديدة ⇒ رسالة، اللقطة نفسها ⇒ لا
fresh("m19");
run(`insert into public.daily_movement_reports(report_date,payload) values (${dateSql(0)}, '{"payments":[{"customer":"T","amount":5}]}');`.repeat(2));
eq(val(`select count(*) from public.telegram_outbox where event_type='ameen_payment'`), "1", "19: تنبيه الدفعات كما هو");

run(`drop database if exists ${DB}`, { db: "postgres" });
console.log(`  ✓ تشغيل حي: ${checks} تأكيداً على نسخ الإنتاج الحرفية (التكرار مُعاد إنتاجه ثم مُصلَح)`);
console.log("check-daily-report-once-per-date: OK");
