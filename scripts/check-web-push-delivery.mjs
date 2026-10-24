// ============================================================================
// إشعارات Web Push: من حدث Telegram إلى ظهور الإشعار (تدقيق 2026-10-24).
//
// أربع طبقات، بلا شبكة ولا مزود Push حقيقي ولا بيانات إنتاج:
//   ١) policy.ts: المستلم المخوّل، تصنيف أخطاء المزود، TTL، الرسائل القديمة، الوسم الفريد، حالة الصندوق.
//   ٢) Edge Function `web-push` (dispatch/test) تحت عميل Supabase ومكتبة web-push وهميين:
//      حساب غير مالك لا يستلم، اشتراك منتهٍ يُعطَّل، رسائل متتالية بوسوم مختلفة، رسالة قديمة لا تُرسل،
//      خطأ عابر يُعاد بحدود، والدالة تعمل قبل تطبيق الهجرة وبعده.
//   ٣) proposed/23 على PostgreSQL محلي: كل نوع على حدة (مسموح/مستثنى)، دفعات الأمين، منع التكرار،
//      لا إعادة إرسال للقديم، رفض إعادة التطبيق، والتراجع الحرفي.
//   ٤) Service Worker: كل رسالة إشعار مستقل، وrenotify/requireInteraction من الحمولة فقط.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

function loadTs(rel, requireMap = {}, globals = {}) {
  const { outputText, diagnostics } = ts.transpileModule(read(rel), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: path.basename(rel)
  });
  assert.equal(diagnostics.length, 0, `${rel}: يُترجم بلا أخطاء صياغة`);
  const module = { exports: {} };
  const sandbox = {
    ...globals, module, exports: module.exports, console, URL, Date, JSON, Map, Set, Number, String, Promise, Response,
    require: (name) => {
      if (name in requireMap) return requireMap[name];
      throw new Error(`استيراد غير متوقع: ${name}`);
    }
  };
  vm.runInNewContext(outputText, sandbox, { filename: rel });
  return module.exports;
}

// ── ١) policy.ts ───────────────────────────────────────────────────────────────────────────
const policy = loadTs("supabase/functions/web-push/policy.ts");
{
  const { isAuthorizedRecipient, classifyPushError, isStale, messageTag, buildMessagePayload, outboxOutcome } = policy;
  assert.equal(policy.PUSH_TTL_SECONDS, 86400, "TTL الأحداث 24 ساعة");
  assert.equal(isAuthorizedRecipient({ app_metadata: { role: "owner" } }), true);
  assert.equal(isAuthorizedRecipient({ app_metadata: { role: " Owner " } }), true);
  for (const role of ["employee", "inventory_counter", "", null, undefined]) {
    assert.equal(isAuthorizedRecipient({ app_metadata: { role } }), false, `الدور ${role} غير مخوّل`);
  }
  assert.equal(isAuthorizedRecipient(null), false);
  assert.equal(isAuthorizedRecipient({ user_metadata: { role: "owner" } }), false, "user_metadata يكتبه المستخدم فلا يُعتمد");

  assert.equal(classifyPushError(404), "expired");
  assert.equal(classifyPushError(410), "expired");
  for (const code of [0, 429, 500, 502, 503]) assert.equal(classifyPushError(code), "transient", `${code} عابر`);
  for (const code of [400, 401, 403, 413]) assert.equal(classifyPushError(code), "rejected", `${code} رفض دائم لا يعطّل`);

  const now = Date.parse("2026-10-24T20:00:00Z");
  assert.equal(isStale("2026-10-24T15:00:00Z", now), false, "5 ساعات ما زالت صالحة");
  assert.equal(isStale("2026-10-24T13:00:00Z", now), true, "7 ساعات قديمة");
  assert.equal(isStale("garbage", now), false);

  const a = { id: 1, event_type: "stock_low", title: "t", body: "b", tag: "stock_low" };
  const b = { ...a, id: 2 };
  assert.notEqual(messageTag(a), messageTag(b), "رسالتان من النوع نفسه بوسمين مختلفين");
  assert.equal(messageTag(a), messageTag({ ...a }), "الرسالة نفسها بالوسم نفسه (لا تكرار عند وصولها مرتين)");

  const pay = buildMessagePayload({ id: 9, event_type: "ameen_payment", title: "💵 دفعة", body: "x", tag: "ameen_payment", navigate: null });
  assert.equal(pay.web_push, 8030);
  assert.equal(pay.notification.renotify, true);
  assert.equal(pay.notification.require_interaction, true, "الدفعة تبقى ظاهرة إن سمح النظام");
  assert.equal(pay.notification.navigate, "https://ozktobacco.com/?route=overview");
  assert.equal(pay.notification.tag, "ameen_payment-9");
  assert.equal(buildMessagePayload(a).notification.require_interaction, false, "النقص لا يعلق على الشاشة");

  assert.deepEqual({ ...outboxOutcome({ accepted: 1, failed: 3, transientOnly: false }, 0) }, { status: "sent", attempts: 1, last_error: null });
  assert.equal(outboxOutcome({ accepted: 0, failed: 0, transientOnly: true }, 0).last_error, "no_authorized_subscriptions");
  assert.equal(outboxOutcome({ accepted: 0, failed: 2, transientOnly: true }, 0).status, "pending");
  assert.equal(outboxOutcome({ accepted: 0, failed: 2, transientOnly: true }, 2).status, "failed", "حد إعادة المحاولة");
  assert.equal(outboxOutcome({ accepted: 0, failed: 2, transientOnly: false }, 0, "boom").last_error, "boom");
  console.log("  ✓ policy.ts: مالك فقط، تصنيف الأخطاء، TTL 24س، تجاوز القديم، وسم فريد، حالة الصندوق");
}

// ── ٢) Edge Function تحت عملاء وهميين ─────────────────────────────────────────────────────
function fakeAdmin(db, { usersById, missingColumns = false, sessionUser = null }) {
  const log = { updates: [] };
  function query(table) {
    const filters = [];
    let patch = null;
    let mode = "select";
    const api = {
      select() { mode = mode === "update" ? mode : "select"; return api; },
      eq(col, value) { filters.push([col, value]); return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { return Promise.resolve(run()).then((r) => ({ data: r.data?.[0] ?? null, error: r.error })); },
      update(fields) { mode = "update"; patch = fields; return api; },
      upsert() { return Promise.resolve({ error: null }); },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
    };
    function rows() { return (db[table] || []).filter((r) => filters.every(([c, v]) => r[c] === v)); }
    function run() {
      if (mode === "update") {
        if (missingColumns && table === "web_push_outbox" && Object.keys(patch).some((k) => k.startsWith("provider_"))) {
          return { error: { code: "PGRST204", message: "column not found" } };
        }
        for (const r of rows()) Object.assign(r, patch);
        log.updates.push({ table, patch: { ...patch }, filters: [...filters] });
        return { error: null };
      }
      return { data: rows().map((r) => ({ ...r })), error: null };
    }
    return api;
  }
  return {
    log,
    client: {
      from: query,
      auth: {
        getUser: async () => (sessionUser ? { data: { user: sessionUser }, error: null } : { data: { user: null }, error: new Error("no") }),
        admin: {
          getUserById: async (id) => (usersById[id] instanceof Error
            ? { data: { user: null }, error: usersById[id] }
            : { data: { user: usersById[id] ?? null }, error: usersById[id] ? null : new Error("missing") })
        }
      }
    }
  };
}

function fakeWebpush(responder) {
  const sent = [];
  return {
    sent,
    module: {
      default: {
        setVapidDetails() {},
        async sendNotification(sub, payload, options) {
          sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
          const status = responder(sub.endpoint);
          if (status !== 201) throw Object.assign(new Error(`status ${status}`), { statusCode: status });
          return { statusCode: 201 };
        }
      }
    }
  };
}

async function runEdge({ db, usersById, responder = () => 201, missingColumns = false, action = "dispatch", sessionUser = null }) {
  const admin = fakeAdmin(db, { usersById, missingColumns, sessionUser });
  const push = fakeWebpush(responder);
  const mod = loadTs("supabase/functions/web-push/index.ts", {
    "npm:web-push@3.6.7": push.module,
    "npm:@supabase/supabase-js@2.57.4": { createClient: () => admin.client },
    "./policy.ts": policy
  }, { Deno: { env: { get: (k) => ({ SUPABASE_URL: "http://local", SUPABASE_SERVICE_ROLE_KEY: "svc" })[k] } } });
  const headers = action === "dispatch"
    ? { "x-ozk-push-token": "t".repeat(40) }
    : { authorization: "Bearer session" };
  const res = await mod.default.fetch(new Request("http://local/functions/v1/web-push", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action })
  }));
  return { status: res.status, body: await res.json(), sent: push.sent, db, log: admin.log };
}

const OWNER = "00000000-0000-0000-0000-00000000000a";
const EMPLOYEE = "00000000-0000-0000-0000-00000000000b";
const users = { [OWNER]: { id: OWNER, app_metadata: { role: "owner" } }, [EMPLOYEE]: { id: EMPLOYEE, app_metadata: { role: "employee" } } };
const secrets = [
  { name: "web_push_dispatch_token", value: "t".repeat(40) },
  { name: "web_push_vapid_public_key", value: "pub" },
  { name: "web_push_vapid_private_key", value: "priv" }
];
const sub = (id, user, endpoint) => ({ id, user_id: user, endpoint, p256dh: "k", auth_key: "a", enabled: true });
const fresh = () => new Date(Date.now() - 60_000).toISOString();
const msg = (id, event_type, extra = {}) => ({ id, event_type, title: `عنوان ${id}`, body: "متن", tag: event_type, navigate: "/?route=overview", attempts: 0, status: "pending", created_at: fresh(), ...extra });

{
  // حساب غير مالك + اشتراك منتهٍ + دفعة من الأمين
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac"), sub(2, OWNER, "https://fcm/old"), sub(3, EMPLOYEE, "https://fcm/emp")],
    web_push_outbox: [msg(10, "ameen_payment")]
  };
  const r = await runEdge({ db, usersById: users, responder: (e) => (e === "https://fcm/old" ? 410 : 201) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.sent.map((s) => s.endpoint).sort(), ["https://fcm/mac", "https://fcm/old"], "لا إرسال لحساب الموظف");
  assert.ok(r.sent.every((s) => s.options.TTL === 86400), "TTL 24 ساعة");
  assert.equal(db.web_push_subscriptions[1].enabled, false, "الاشتراك المنتهي (410) يُعطَّل");
  assert.equal(db.web_push_subscriptions[1].last_error, "expired:410");
  assert.equal(db.web_push_subscriptions[2].enabled, true, "اشتراك الموظف لا يُمسّ");
  const row = db.web_push_outbox[0];
  assert.equal(row.status, "sent");
  assert.equal(row.provider_accepted, 1);
  assert.equal(row.provider_failed, 1);
  assert.equal(r.body.recipients, 2);
  assert.equal(r.sent[0].payload.notification.require_interaction, true);
  console.log("  ✓ dispatch: مالك فقط، 410 يُعطَّل، TTL 24س، وعدّاد قبول المزود منفصل عن الظهور");
}
{
  // ثلاث رسائل متتالية من النوع نفسه
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac")],
    web_push_outbox: [msg(21, "stock_low"), msg(22, "stock_low"), msg(23, "stock_low")]
  };
  const r = await runEdge({ db, usersById: users });
  const tags = r.sent.map((s) => s.payload.notification.tag);
  assert.equal(new Set(tags).size, 3, "ثلاث رسائل = ثلاثة وسوم");
  assert.ok(r.sent.every((s) => s.payload.notification.renotify === true));
  assert.ok(db.web_push_outbox.every((m) => m.status === "sent"));
  console.log("  ✓ رسائل متتالية من النوع نفسه: وسوم مختلفة مع renotify");
}
{
  // رسالة قديمة (بعد عطل أو قبل النشر) لا تُرسل؛ والحديثة تُرسل
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac")],
    web_push_outbox: [msg(31, "stock_low", { created_at: new Date(Date.now() - 7 * 3600_000).toISOString() }), msg(32, "customer_request")]
  };
  const r = await runEdge({ db, usersById: users });
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].payload.notification.tag, "customer_request-32");
  assert.equal(db.web_push_outbox[0].status, "failed");
  assert.equal(db.web_push_outbox[0].last_error, "stale_skipped");
  assert.equal(r.body.skipped, 1);
  console.log("  ✓ لا دفعة إشعارات قديمة: ما تجاوز 6 ساعات يُتجاوز بلا إرسال");
}
{
  // جهاز غير متصل/مزود معطّل مؤقتاً: 503 ⇒ تبقى معلّقة حتى حدّ المحاولات، بلا تكرار لمن قبل
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac")],
    web_push_outbox: [msg(41, "ameen_sync_outage")]
  };
  await runEdge({ db, usersById: users, responder: () => 503 });
  assert.equal(db.web_push_outbox[0].status, "pending");
  assert.equal(db.web_push_outbox[0].attempts, 1);
  assert.match(db.web_push_subscriptions[0].last_error, /^transient:503:/);
  assert.equal(db.web_push_subscriptions[0].enabled, true);
  await runEdge({ db, usersById: users, responder: () => 503 });
  await runEdge({ db, usersById: users, responder: () => 503 });
  assert.equal(db.web_push_outbox[0].status, "failed", "تتوقف بعد 3 محاولات");
  assert.equal(db.web_push_outbox[0].attempts, 3);
  // رفض دائم (403) لا يعطّل الاشتراك ولا يُعاد
  const db2 = { app_secrets: secrets.map((s) => ({ ...s })), web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac")], web_push_outbox: [msg(42, "stock_low")] };
  await runEdge({ db: db2, usersById: users, responder: () => 403 });
  assert.equal(db2.web_push_outbox[0].status, "failed");
  assert.equal(db2.web_push_subscriptions[0].enabled, true);
  console.log("  ✓ أخطاء المزود: العابر يُعاد 3 مرات كحد أقصى، والدائم يُسجَّل بلا تعطيل");
}
{
  // لا مالك مشترك، أو تعذّر قراءة المستخدم ⇒ لا إرسال لأحد
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(3, EMPLOYEE, "https://fcm/emp"), sub(4, OWNER, "https://fcm/mac")],
    web_push_outbox: [msg(51, "payment")]
  };
  const r = await runEdge({ db, usersById: { [EMPLOYEE]: users[EMPLOYEE], [OWNER]: new Error("auth down") } });
  assert.equal(r.sent.length, 0, "فشل التحقق من الدور = لا إرسال");
  assert.equal(db.web_push_outbox[0].last_error, "no_authorized_subscriptions");
  console.log("  ✓ حساب غير مخوّل لا يستلم، وتعذّر التحقق من الدور لا يفتح الإرسال");
}
{
  // الدالة الجديدة قبل تطبيق الهجرة: الأعمدة الجديدة غائبة ⇒ يُكتب السجل بدونها
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac")],
    web_push_outbox: [msg(61, "stock_low")]
  };
  await runEdge({ db, usersById: users, missingColumns: true });
  assert.equal(db.web_push_outbox[0].status, "sent");
  assert.equal(db.web_push_outbox[0].provider_accepted, undefined);
  console.log("  ✓ ترتيب النشر: الدالة تعمل قبل الهجرة (بلا أعمدة القبول) وبعدها");
}
{
  // test: يبقى لاشتراكات المستدعي وحده وبـTTL قصير
  const db = {
    app_secrets: secrets.map((s) => ({ ...s })),
    web_push_subscriptions: [sub(1, OWNER, "https://fcm/mac"), sub(3, EMPLOYEE, "https://fcm/emp")],
    web_push_outbox: []
  };
  const r = await runEdge({ db, usersById: users, action: "test", sessionUser: users[OWNER] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.sent.map((s) => s.endpoint), ["https://fcm/mac"]);
  assert.equal(r.sent[0].options.TTL, 300);
  console.log("  ✓ action test: اشتراكات المستدعي وحده، TTL 300");
}

// ── ٣) proposed/23 على PostgreSQL محلي ────────────────────────────────────────────────────
const MIG = read("supabase/proposed/23-web-push-explicit-allowlist.sql");
const RB = read("supabase/proposed/23-web-push-explicit-allowlist-rollback.sql");
const ENV = read("supabase/tests/web-push-allowlist-env.sql");
const strip = (s) => s.replace(/--.*$/gm, "");
{
  const code = strip(MIG);
  assert.doesNotMatch(code, /notify_telegram|dispatch_telegram_outbox|cron\.|insert\s+into\s+public\.telegram_outbox|delete\s+from|update\s+public\./i, "23 لا يمسّ Telegram ولا Cron ولا يعدّل سجلات");
  assert.match(code, /^begin;[\s\S]*^commit;\s*$/m, "معاملة واحدة");
  assert.match(code, /is distinct from 'd1e5f0e91bd925e3a6cd02cf1c5b6a66'/, "حارس بصمة الإنتاج");
  assert.match(code, /is distinct from '2b7bf2592546534cca021a7f1a558f0c'/, "حارس البصمة بعد التطبيق");
  const fn = (s) => s.slice(s.indexOf("CREATE OR REPLACE FUNCTION public.mirror_telegram_to_web_push()"), s.indexOf("$function$;", s.indexOf("CREATE OR REPLACE FUNCTION public.mirror_telegram_to_web_push()")));
  assert.equal(fn(RB), fn(ENV), "التراجع = جسم الإنتاج حرفياً");
}

// كل نوع معروف في الإنتاج (notify_telegram ومصادر أخرى، 2026-10-24) مصنَّف صراحةً.
const ALLOWED = ["payment", "ameen_payment", "customer_request", "whatsapp_order", "stock_low", "credit_over", "credit_near", "credit_limit",
  "sync_failure", "ameen_sync_outage", "ameen_sync_outage_recovered", "price_sync_outage", "price_sync_recovered",
  "inventory_report", "inventory_complete", "inventory_late", "inventory_daily_summary", "daily_movement", "daily_bill_audit", "daily_sales",
  "morning_report", "evening_report"];
const EXCLUDED = ["morning_report_debts", "evening_report_expenses", "evening_report_orders", "evening_report_payments", "evening_report_prices",
  "evening_report_purchase_returns", "evening_report_purchases", "evening_cash_report", "collection_followup", "windows", "price_change",
  "price_item_new", "project_task_failure", "project_task_recovered", "item_costs", "documents", "automation_failure", "github_actions_failure",
  "CUSTOMER_INACTIVE_5D", "ameen_cost_anomaly", "price_sync_partial", "price_sync_mismatch", "sync_outage_detector_failed", "khalil_audit_event",
  "stock_priority_stale", "credit_something_new"];
for (const t of EXCLUDED.slice(0, -2)) assert.match(MIG, new RegExp(`\\b${t.replace(/_\*$/, "")}`), `${t}: مستثنى موثَّق في 23`);

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-web-push-delivery: refusing non-local PGHOST");
  process.exit(1);
}
const viaTcp = Boolean(process.env.PGHOST);
const command = viaTcp ? "psql" : "sudo";
const argvOf = (args) => (viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args]);
const psql = (args, options = {}) => spawnSync(command, argvOf(["-X", "-q", ...args]), { encoding: "utf8", ...options });
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
let liveSql = probe.status === 0;
if (!liveSql && (process.env.CI === "true" || process.env.PGHOST)) {
  console.error(output(probe) || "psql is not available");
  process.exit(1);
}
if (liveSql) {
  const DB = "ozk_web_push_allowlist_test";
  const run = (sql, { db = DB, ok = true } = {}) => {
    const r = psql(["-d", db, "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
    if (ok) assert.equal(r.status, 0, output(r));
    return r;
  };
  const val = (sql) => run(sql).stdout.trim();
  run(`drop database if exists ${DB}`, { db: "postgres" });
  run(`create database ${DB}`, { db: "postgres" });
  run(ENV);
  assert.equal(val("select md5(prosrc) from pg_proc where proname='mirror_telegram_to_web_push'"), "d1e5f0e91bd925e3a6cd02cf1c5b6a66", "البيئة = جسم الإنتاج");

  // حدث قبل الهجرة لا يُعاد إرساله بعدها
  run(`insert into public.telegram_outbox(event_type, message) values ('ameen_payment', E'💵 دفعة قديمة\\nقبل الهجرة');`);
  assert.equal(val("select count(*) from public.web_push_outbox"), "0", "النسخة القديمة تُسقط ameen_payment");
  run(MIG);
  assert.equal(val("select count(*) from public.web_push_outbox"), "0", "لا backfill");

  for (const t of ALLOWED) {
    const before = Number(val("select count(*) from public.web_push_outbox"));
    run(`insert into public.telegram_outbox(event_type, message) values ('${t}', E'عنوان ${t}\\nمتن ${t}');`);
    assert.equal(Number(val("select count(*) from public.web_push_outbox")), before + 1, `${t}: يُنشئ سجل Push واحداً`);
  }
  for (const t of EXCLUDED) {
    const before = Number(val("select count(*) from public.web_push_outbox"));
    run(`insert into public.telegram_outbox(event_type, message) values ('${t}', E'عنوان ${t}\\nمتن ${t}');`);
    assert.equal(Number(val("select count(*) from public.web_push_outbox")), before, `${t}: لا Push (Telegram فقط)`);
  }
  assert.equal(val("select count(*) from public.telegram_outbox"), String(1 + ALLOWED.length + EXCLUDED.length), "Telegram يستلم كل شيء كما كان");

  // دفعة الأمين: العنوان والمتن والربط بالحدث الأصلي
  const payId = val(`insert into public.telegram_outbox(event_type, message) values ('ameen_payment', E'💵 دفعة من أبو جاد\\n700 $') returning id`);
  const pay = val(`select o.title || '|' || o.body || '|' || o.tag || '|' || o.status from public.web_push_outbox o where o.source_telegram_id = ${payId}`);
  assert.equal(pay, "💵 دفعة من أبو جاد|700 $|ameen_payment|pending");

  // منع التكرار: النص نفسه خلال 30 دقيقة = سجل واحد، حتى من نوع مشابه آخر
  const n0 = Number(val("select count(*) from public.web_push_outbox"));
  run(`insert into public.telegram_outbox(event_type, message) values ('payment', E'💵 دفعة من أبو جاد\\n700 $');`);
  assert.equal(Number(val("select count(*) from public.web_push_outbox")), n0, "النص نفسه من مصدر آخر لا يتكرر");
  run(`update public.web_push_outbox set created_at = now() - interval '31 minutes' where title = '💵 دفعة من أبو جاد';`);
  run(`insert into public.telegram_outbox(event_type, message) values ('ameen_payment', E'💵 دفعة من أبو جاد\\n700 $');`);
  assert.equal(Number(val("select count(*) from public.web_push_outbox")), n0 + 1, "بعد 30 دقيقة دفعة جديدة مستقلة");
  // متتالية من النوع نفسه بنص مختلف: كلها تُنشأ
  run(`insert into public.telegram_outbox(event_type, message) select 'stock_low', E'نقص ' || g || E'\\nمادة ' || g from generate_series(1,3) g;`);
  assert.equal(Number(val("select count(*) from public.web_push_outbox")), n0 + 4, "ثلاثة تنبيهات نقص متتالية = ثلاثة سجلات");

  // صلاحيات: الدالتان غير قابلتين للاستدعاء من anon/authenticated
  assert.equal(val("select has_function_privilege('anon','public.web_push_allowed_event_types()','execute')::text || has_function_privilege('authenticated','public.mirror_telegram_to_web_push()','execute')::text"), "falsefalse");
  // إعادة التطبيق مرفوضة، والتراجع حرفي، والتراجع مرتين مرفوض
  assert.notEqual(run(MIG, { ok: false }).status, 0, "إعادة تطبيق 23 مرفوضة");
  run(RB);
  assert.equal(val("select md5(prosrc) from pg_proc where proname='mirror_telegram_to_web_push'"), "d1e5f0e91bd925e3a6cd02cf1c5b6a66", "التراجع يعيد جسم الإنتاج");
  assert.equal(val("select count(*) from pg_proc where proname='web_push_allowed_event_types'"), "0");
  assert.notEqual(run(RB, { ok: false }).status, 0, "تراجع ثانٍ مرفوض");
  run(`drop database if exists ${DB}`, { db: "postgres" });
  console.log(`  ✓ proposed/23 (PostgreSQL محلي): ${ALLOWED.length} نوعاً مسموحاً و${EXCLUDED.length} مستثنى كلٌّ على حدة، دفعات الأمين، منع التكرار، لا backfill، تراجع حرفي`);
} else {
  console.log("  • proposed/23: العقود الساكنة نجحت؛ التشغيل الحي تُخطّي (لا PostgreSQL محلي)");
}

// ── ٤) Service Worker ──────────────────────────────────────────────────────────────────────
{
  const sw = read("public/service-worker.js");
  const pushLine = sw.split("\n").find((l) => l.startsWith('self.addEventListener("push"'));
  assert.ok(pushLine, "معالج push موجود");
  const shown = [];
  const listeners = {};
  const self = {
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    addEventListener: (name, fn) => { listeners[name] = fn; }
  };
  vm.runInNewContext(pushLine, { self, String, JSON });
  const fire = async (data) => {
    let waited;
    listeners.push({ data, waitUntil: (p) => { waited = p; } });
    await waited;
  };
  const jsonData = (obj) => ({ json: () => obj, text: () => JSON.stringify(obj) });
  for (const id of [1, 2, 3]) {
    await fire(jsonData(policy.buildMessagePayload({ id, event_type: "stock_low", title: `نقص ${id}`, body: "x", tag: "stock_low" })));
  }
  assert.equal(new Set(shown.map((s) => s.options.tag)).size, 3, "ثلاثة إشعارات مستقلة");
  assert.ok(shown.every((s) => s.options.renotify === true && s.options.requireInteraction === false));
  await fire(jsonData(policy.buildMessagePayload({ id: 4, event_type: "ameen_payment", title: "دفعة", body: "x", tag: "ameen_payment" })));
  assert.equal(shown.at(-1).options.requireInteraction, true);
  // نص خام (اختبار DevTools) أو رسالة الاختبار القديمة: وسم افتراضي بلا renotify
  await fire({ json: () => { throw new Error("not json"); }, text: () => "تجربة" });
  assert.deepEqual([shown.at(-1).options.tag, shown.at(-1).options.renotify, shown.at(-1).options.body], ["ozk-alert", false, "تجربة"]);
  await fire(jsonData({ web_push: 8030, notification: { title: "🔔 اختبار", body: "b", tag: "push-test" } }));
  assert.deepEqual([shown.at(-1).options.tag, shown.at(-1).options.renotify], ["push-test", false]);
  console.log("  ✓ Service Worker: كل رسالة إشعار مستقل، وrenotify/requireInteraction من الحمولة وحدها");
}

console.log("check-web-push-delivery: OK");
