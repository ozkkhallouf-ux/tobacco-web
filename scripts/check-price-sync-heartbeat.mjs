// ============================================================================
// فحص نبضة مزامنة الأسعار (المرحلة 1):
//   ١) مصنّف الحالة src/price-sync-health.js على سيناريوهات مصطنعة.
//   ٢) عقود ساكنة على الـSQL المقترح وسكربتات Windows.
//   ٣) تشغيل حي لـ supabase/tests/price-sync-heartbeat.sql على Postgres مؤقت.
// كل الأوقات والأرقام مصطنعة؛ لا بيانات إنتاج.
// ============================================================================
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import "../src/price-sync-health.js";

const engine = globalThis.ozkPriceSyncHealth;
assert.ok(engine, "src/price-sync-health.js لم يعرّف ozkPriceSyncHealth");
const { classifyPriceSyncHealth: classify, describePriceSyncHealth: describe, formatDamascusTime, STATES } = engine;

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error?.stack || error}`); }
}

// 08:34Z = 11:34 دمشق.
const NOW = new Date("2026-10-18T08:34:00.000Z");
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();
const row = (overrides = {}) => ({
  status: "ok",
  stage: "done",
  created_at: ago(1),
  pulled_count: 321,
  applied_wholesale: 321,
  applied_retail: 317,
  skipped_count: 0,
  not_found_count: 0,
  conflict_count: 0,
  verified_wholesale: 321,
  verified_retail: 317,
  mismatch_count: 0,
  missing_count: 0,
  message: "",
  ameen_connected_at: ago(1),
  last_applied_at: ago(1),
  applied_feed_max_updated_at: "2026-10-18T07:30:00.000Z",
  last_success_at: ago(1),
  last_failure_at: null,
  last_failure_status: null,
  new_prices: true,
  previous_status: "ok",
  gap_minutes: 5,
  ...overrides
});
const at = (r, options = {}) => classify(r, { now: NOW, ...options });
const text = (health) => describe(health, { now: NOW });

test("المهمة تعمل ولا توجد أسعار جديدة: HEALTHY بلا أسعار جديدة", () => {
  const health = at(row({ new_prices: false }));
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.reason, "no_new_prices");
  assert.equal(health.pendingEdits, false);
  const shown = text(health);
  assert.equal(shown.tone, "ok");
  assert.equal(shown.title, "✅ آخر وصول للأمين: 11:33");
  assert.match(shown.detail, /لا أسعار جديدة/);
});

test("نجاح بأسعار جديدة: HEALTHY والأرقام محفوظة", () => {
  const health = at(row());
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.reason, "applied");
  assert.equal(health.counts.pulled, 321);
  assert.equal(health.counts.appliedRetail, 317);
  assert.equal(health.resumedAfterMinutes, null);
});

test("المهمة متوقفة: لا محاولة منذ 17 دقيقة ⇒ STALE رغم أن آخر صف ok", () => {
  const health = at(row({ created_at: ago(17), last_success_at: ago(17), ameen_connected_at: ago(17) }));
  assert.equal(health.state, STATES.STALE);
  assert.equal(health.reason, "no_recent_attempt");
  const shown = text(health);
  assert.equal(shown.tone, "warn");
  assert.equal(shown.title, "⚠️ المزامنة متوقفة منذ 11:17");
});

test("الحد بالضبط 15 دقيقة ما زال HEALTHY، وبعده STALE", () => {
  assert.equal(at(row({ created_at: ago(15) })).state, STATES.HEALTHY);
  assert.equal(at(row({ created_at: ago(15.2) })).state, STATES.STALE);
});

test("نجاح قديم من أمس لا يُعدّ دليلاً: STALE ويُعرض بالتاريخ", () => {
  const health = at(row({ created_at: ago(24 * 60), last_success_at: ago(24 * 60) }));
  assert.equal(health.state, STATES.STALE);
  assert.equal(text(health).title, "⚠️ المزامنة متوقفة منذ 17/10 11:34");
});

test("فشل الاتصال بالأمين: FAILED مع آخر وصول ناجح", () => {
  const health = at(row({
    status: "apply_failed", stage: "apply", created_at: ago(2),
    last_success_at: ago(20), ameen_connected_at: ago(20), last_failure_at: ago(2), last_failure_status: "apply_failed"
  }));
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.reason, "apply_failed");
  const shown = text(health);
  assert.equal(shown.tone, "error");
  assert.equal(shown.title, "❌ فشل آخر اتصال بالأمين");
  assert.match(shown.detail, /آخر محاولة: 11:32/);
  assert.match(shown.detail, /آخر وصول للأمين: 11:14/);
});

test("فشل قديم ثم توقف: STALE لا FAILED، فالأحدث أن المهمة لا تعمل", () => {
  const health = at(row({ status: "apply_failed", created_at: ago(40) }));
  assert.equal(health.state, STATES.STALE);
  assert.equal(health.reason, "no_recent_attempt_after_apply_failed");
});

test("فشل السحب والتحقق والفروق: FAILED بعناوين مختلفة", () => {
  assert.equal(text(at(row({ status: "pull_failed" }))).title, "❌ تعذّر سحب الأسعار من الموقع");
  assert.equal(text(at(row({ status: "verify_failed" }))).title, "❌ تعذّر التحقق من أسعار الأمين");
  const mismatch = at(row({ status: "mismatch", mismatch_count: 3, missing_count: 1 }));
  assert.equal(mismatch.state, STATES.FAILED);
  assert.match(text(mismatch).detail, /فروق: 3 — ناقصة: 1/);
});

test("تعارض أسعار: التحقق نجح لكن الأصناف المتعارضة لم تُكتب ⇒ FAILED", () => {
  const health = at(row({ conflict_count: 2, last_success_at: ago(30) }));
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.reason, "conflict");
  const shown = text(health);
  assert.equal(shown.title, "❌ تعارض أسعار — لم تُكتب بعض الأصناف");
  assert.match(shown.detail, /أصناف متعارضة: 2/);
});

test("استئناف المزامنة بعد 76 دقيقة: HEALTHY مع إشارة العودة", () => {
  const health = at(row({ previous_status: "disabled", gap_minutes: 76 }));
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.resumedAfterMinutes, 76);
  assert.match(text(health).detail, /عادت المزامنة بعد توقف 76 دقيقة/);
  // فجوة دورة واحدة عادية ليست استئنافاً.
  assert.equal(at(row({ gap_minutes: 5 })).resumedAfterMinutes, null);
});

test("المهمة معطّلة أو موقوفة للصيانة: DISABLED حتى لو كان البلاغ قديماً", () => {
  const disabled = at(row({ status: "disabled", stage: "external", created_at: ago(60), message: "معطّلة للصيانة" }));
  assert.equal(disabled.state, STATES.DISABLED);
  assert.equal(text(disabled).title, "⛔ مهمة مزامنة الأسعار معطّلة منذ 10:34");
  assert.match(text(disabled).detail, /معطّلة للصيانة/);
  const paused = at(row({ status: "paused", stage: "external" }));
  assert.equal(paused.state, STATES.DISABLED);
  assert.match(text(paused).title, /^⏸ المزامنة موقوفة للصيانة/);
});

test("غياب البيانات وصفوف لا تُقرأ: UNKNOWN", () => {
  for (const [input, reason] of [
    [null, "no_data"],
    [undefined, "no_data"],
    [{}, "unknown_status"],
    [row({ status: "error" }), "unknown_status"],
    [row({ created_at: "" }), "no_timestamp"],
    [row({ created_at: "garbage" }), "no_timestamp"],
    [row({ created_at: ago(-30) }), "future_timestamp"]
  ]) {
    const health = at(input);
    assert.equal(health.state, STATES.UNKNOWN, reason);
    assert.equal(health.reason, reason);
    assert.equal(text(health).tone, "muted");
  }
  // انحراف ساعة صغير مقبول.
  assert.equal(at(row({ created_at: ago(-2) })).state, STATES.HEALTHY);
});

test("تعديل سعر بالموقع أثناء التوقف: pendingEdits ونص الكاشير", () => {
  const stale = row({ created_at: ago(40), applied_feed_max_updated_at: "2026-10-18T07:00:00.000Z" });
  const health = at(stale, { latestPriceEditAt: "2026-10-18T07:44:00.000Z" });
  assert.equal(health.state, STATES.STALE);
  assert.equal(health.pendingEdits, true);
  assert.match(text(health).detail, /الكاشير يبيع بالسعر القديم/);
  // تعديل داخل آخر تطبيق، أو بفارق أقل من دقيقة: لا انتظار.
  assert.equal(at(stale, { latestPriceEditAt: "2026-10-18T07:00:30.000Z" }).pendingEdits, false);
  // أثناء HEALTHY يبقى العلم ولا يظهر النص: الدورة التالية ستحمله.
  const healthy = at(row(), { latestPriceEditAt: "2026-10-18T08:33:00.000Z" });
  assert.equal(healthy.pendingEdits, true);
  assert.doesNotMatch(text(healthy).detail, /الكاشير/);
});

test("توقيت دمشق: UTC+3، ومنتصف الليل يغيّر اليوم", () => {
  assert.equal(formatDamascusTime("2026-10-18T07:17:00Z", { now: NOW }), "10:17");
  assert.equal(formatDamascusTime("2026-10-17T21:30:00Z", { now: NOW }), "00:30");
  assert.equal(formatDamascusTime("2026-10-17T20:59:00Z", { now: NOW }), "17/10 23:59");
  assert.equal(formatDamascusTime("2025-12-31T20:00:00Z", { now: NOW }), "31/12/2025 23:00");
  assert.equal(formatDamascusTime(null, { now: NOW }), "غير معروف");
});

test("المصنّف نقي: لا يعدّل الصف ويرفض now غير صالح", () => {
  const input = row();
  const copy = JSON.stringify(input);
  at(input);
  assert.equal(JSON.stringify(input), copy);
  assert.throws(() => classify(input, { now: "garbage" }), TypeError);
});

// ── عقود ساكنة ─────────────────────────────────────────────────────────────
const read = (path) => readFileSync(path, "utf8");
const sql = read("supabase/proposed/16-price-sync-heartbeat.sql");
const sqlCode = sql.replace(/--.*$/gm, "");
const orchestrator = read("tools/sync-approved-prices-to-ameen.ps1");
const publisher = read("tools/publish-price-sync-heartbeat.ps1");
const pull = read("tools/pull-approved-prices.ps1");

test("SQL: كتابة عبر دالة محصورة بهوية المزامنة، وقراءة الموظفين وحدهم", () => {
  for (const contract of [
    "security definer",
    "set search_path = ''",
    "9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3",
    "force row level security",
    "revoke all on public.price_sync_heartbeat from public, anon, authenticated",
    "grant select on public.price_sync_heartbeat to authenticated",
    "using (public.is_staff())",
    "revoke all on function public.record_price_sync_heartbeat(jsonb) from public, anon, authenticated",
    "grant execute on function public.record_price_sync_heartbeat(jsonb) to authenticated",
    "pg_advisory_xact_lock",
    "interval '14 days'"
  ]) assert.ok(sql.includes(contract), `16-price-sync-heartbeat.sql missing: ${contract}`);
  assert.doesNotMatch(sqlCode, /\bfor (insert|update|delete)\b/i, "لا سياسة كتابة مباشرة على الجدول");
});

test("SQL: لا Telegram ولا cron ولا مساس بالمراقب أو inventory_reports", () => {
  assert.doesNotMatch(sqlCode, /notify_telegram|telegram_outbox|cron\.|monitor_project_tasks/i);
  assert.doesNotMatch(sqlCode, /\b(insert into|update|delete from)\s+public\.inventory_reports\b/i);
  assert.doesNotMatch(sqlCode, /\bcreate\s+trigger\b/i);
});

test("Windows: المنسّق ينشر نبضة لكل نتيجة ويحافظ على رموز الخروج", () => {
  for (const status of ["pull_failed", "apply_failed", "verify_failed"]) {
    assert.match(orchestrator, new RegExp(`Publish-Heartbeat @\\{ Status = "${status}"`), `نبضة ${status}`);
  }
  assert.match(orchestrator, /Status = \$status; Stage = "done"/, "نبضة ok/mismatch بعد التحقق");
  for (const code of ["exit 1", "exit 2", "exit 3", "exit 0"]) assert.ok(orchestrator.includes(code), code);
  // الحالة القديمة لم تُستبدل.
  assert.match(orchestrator, /publish-price-sync-status\.ps1" -Status \$status/);
  assert.match(orchestrator, /DedupeKey "winfail:apply-to-ameen"/);
  // المعاينة لا تنشر.
  const preview = orchestrator.slice(orchestrator.indexOf("if (-not $Apply) {\n    # المعاينة"));
  assert.ok(preview.indexOf("exit 0") < preview.indexOf("Publish-Heartbeat"), "المعاينة تخرج قبل أي نبضة");
});

test("Windows: الناشر لا يلمس الأمين ويستعمل حساب المزامنة وحده", () => {
  assert.doesNotMatch(publisher, /AMEEN_SQL|SqlClient|SqlConnection/);
  assert.doesNotMatch(publisher, /SUPABASE_SERVICE_KEY/);
  assert.match(publisher, /rpc\/record_price_sync_heartbeat/);
  assert.doesNotMatch(publisher, /\bthrow\b(?![^\n]*")/, "كل رمي داخل try");
  assert.match(pull, /Write-Output "PRICE_PULL count=\$\(\$response\.Count\) max_updated_at=\$feedMaxText"/);
});

// ── تشغيل SQL حي ───────────────────────────────────────────────────────────
const DB = "ozk_price_sync_heartbeat_test";
const TEST_SQL = "supabase/tests/price-sync-heartbeat.sql";
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  return spawnSync(viaTcp ? "psql" : "sudo", viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args], { encoding: "utf8", ...options });
}
const output = (result) => `${result.stdout || ""}${result.stderr || ""}`;

function runSql() {
  const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
  if (probe.status !== 0) {
    if (process.env.CI === "true" || process.env.PGHOST) {
      console.error(output(probe) || "psql is not available");
      console.error(`CI must execute ${TEST_SQL}`);
      process.exit(1);
    }
    results.push("  ⏭️  تشغيل SQL الحي تُخطّي (لا Postgres محلي)");
    return;
  }
  const admin = (statement) => psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", statement]);
  admin(`drop database if exists ${DB}`);
  const create = admin(`create database ${DB}`);
  const run = psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", TEST_SQL]);
  admin(`drop database if exists ${DB}`);
  const log = `${output(create)}${output(run)}`;
  if (create.status !== 0 || run.status !== 0 || !log.includes("PRICE_SYNC_HEARTBEAT_TEST_OK")) {
    failed += 1;
    results.push(`  ❌ تشغيل ${TEST_SQL}\n${log}`);
    return;
  }
  results.push(`  ✅ تشغيل SQL حي: صلاحيات، حمل آخر نجاح، تعارض، تعطيل، استئناف، احتفاظ، تراجع`);
}
runSql();

console.log("check-price-sync-heartbeat:");
console.log(results.join("\n"));
if (failed) {
  console.error(`check-price-sync-heartbeat: فشل ${failed} اختبار`);
  process.exit(1);
}
console.log(`check-price-sync-heartbeat: اجتاز ${results.length} بنداً.`);
