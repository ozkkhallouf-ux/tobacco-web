// ============================================================================
// فحص مصنِّف صحة مزامنة الأسعار (src/price-sync-health.js) ونبضه على Windows.
// كل الأوقات والأعداد مصطنعة؛ لا بيانات إنتاج ولا شبكة.
// السبب: حادثة 2026-10-18 — مهمة الأسعار معطّلة 4 ساعات وآخر «ok» يتقادم بصمت.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "../src/price-sync-health.js";

const engine = globalThis.ozkPriceSyncHealth;
assert.ok(engine, "src/price-sync-health.js لم يعرّف ozkPriceSyncHealth");
const { STATES, classifyPriceSyncHealth: classify, describePriceSyncHealth: describe, formatDamascusTime } = engine;

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error?.stack || error}`); }
}

// 11:40 بتوقيت دمشق = 08:40 UTC
const NOW = new Date("2026-10-18T08:40:00.000Z");
const ago = (minutes) => new Date(NOW.getTime() - minutes * 60000).toISOString();

function attempt(minutesAgo, outcome, extra = {}) {
  return {
    source: engine.SOURCE,
    created_at: ago(minutesAgo),
    summary: Object.assign({
      schema: engine.SCHEMA,
      kind: "attempt",
      attempt_started_at: ago(minutesAgo + 0.2),
      attempt_finished_at: ago(minutesAgo),
      outcome,
      ameen_contact_at: ["applied", "no_changes", "verify_mismatch", "applied_with_conflicts"].includes(outcome) ? ago(minutesAgo) : null,
      sent_count: 321,
      applied_wholesale: outcome === "pull_failed" ? null : 321,
      applied_retail: outcome === "pull_failed" ? null : 317,
      not_in_ameen: 0,
      conflict_count: 0,
      verify: { wholesale_matched: 321, retail_matched: 317, mismatches: 0, missing: 0 },
      prices_changed: outcome === "no_changes" ? false : true
    }, extra)
  };
}

function probe(minutesAgo, task) {
  return {
    source: engine.SOURCE,
    created_at: ago(minutesAgo),
    summary: {
      schema: engine.SCHEMA,
      kind: "task_probe",
      probed_at: ago(minutesAgo),
      task: Object.assign({ name: "TOBACCO Approved Prices Pull", exists: true, enabled: true, state: "Ready", last_run_time: ago(minutesAgo + 1), last_result: 0 }, task)
    }
  };
}

test("المهمة تعمل ولا توجد أسعار جديدة ⇒ HEALTHY (no_changes)", () => {
  const health = classify([attempt(2, "no_changes"), attempt(7, "applied")], { now: NOW });
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.reason, "no_changes");
  assert.equal(health.counts.pricesChanged, false);
  assert.equal(health.resumedAfter, null);
  const text = describe(health, { now: NOW });
  assert.equal(text.level, "ok");
  assert.equal(text.text, "آخر وصول للأمين: 11:38");
  assert.match(text.detail, /لا أسعار جديدة/);
});

test("وصول أسعار جديدة مثبت ⇒ HEALTHY (applied) مع أعداد المرسل والمطبّق", () => {
  const health = classify([attempt(3, "applied")], { now: NOW });
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.reason, "applied");
  assert.equal(health.counts.sent, 321);
  assert.equal(health.counts.appliedWholesale, 321);
  assert.equal(health.counts.appliedRetail, 317);
  assert.equal(health.counts.conflicts, 0);
  assert.equal(health.lastAmeenContactAt.toISOString(), ago(3));
});

test("المهمة معطّلة (فحص حديث) ⇒ DISABLED حتى لو كان آخر نجاح قبل دقائق", () => {
  const health = classify([attempt(4, "applied"), probe(1, { enabled: false, state: "Disabled" })], { now: NOW });
  assert.equal(health.state, STATES.DISABLED);
  assert.equal(health.reason, "task_disabled");
  const text = describe(health, { now: NOW });
  assert.equal(text.level, "error");
  assert.match(text.text, /معطّلة/);
  assert.match(text.detail, /11:36/);
});

test("المهمة غير مسجّلة ⇒ DISABLED (task_missing)", () => {
  const health = classify([probe(2, { exists: false, enabled: false, state: "Missing" })], { now: NOW });
  assert.equal(health.state, STATES.DISABLED);
  assert.equal(health.reason, "task_missing");
  assert.match(describe(health, { now: NOW }).text, /غير مسجّلة/);
});

test("نجاح قديم بلا محاولة حديثة ⇒ STALE، والنص «متوقفة منذ» وقت آخر نجاح بتوقيت دمشق", () => {
  // آخر نجاح 10:17 دمشق (07:17 UTC)، ولا شيء بعده
  const health = classify([attempt(83, "applied")], { now: NOW });
  assert.equal(health.state, STATES.STALE);
  assert.equal(health.reason, "no_recent_attempt");
  assert.equal(health.lastSuccessAt.toISOString(), ago(83));
  const text = describe(health, { now: NOW });
  assert.equal(text.level, "warn");
  assert.equal(text.text, "المزامنة متوقفة منذ 10:17");
});

test("نجاح قديم لا يُحسب نجاحاً حالياً حتى مع فحص مهمة حديث يقول إنها مفعّلة", () => {
  const health = classify([attempt(60, "applied"), probe(3, {})], { now: NOW });
  assert.equal(health.state, STATES.STALE);
  assert.notEqual(health.state, STATES.HEALTHY);
});

test("فشل الاتصال بالأمين ⇒ FAILED (ameen_unreachable) و«فشل آخر اتصال بالأمين»", () => {
  const health = classify([
    attempt(2, "ameen_unreachable", { stage_failed: "connect", applied_wholesale: null, applied_retail: null, verify: {}, last_success_at: ago(40) }),
    attempt(40, "applied")
  ], { now: NOW });
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.reason, "ameen_unreachable");
  assert.equal(health.lastSuccessAt.toISOString(), ago(40));
  assert.equal(health.lastFailureAt.toISOString(), ago(2));
  assert.equal(health.lastAmeenContactAt.toISOString(), ago(40));
  const text = describe(health, { now: NOW });
  assert.equal(text.level, "error");
  assert.equal(text.text, "فشل آخر اتصال بالأمين");
  assert.match(text.detail, /11:00/);
});

test("تعارض أسعار ⇒ FAILED (applied_with_conflicts) مع عدد التعارضات", () => {
  const health = classify([attempt(1, "applied_with_conflicts", { conflict_count: 2, not_in_ameen: 1 })], { now: NOW });
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.counts.conflicts, 2);
  assert.equal(health.counts.notInAmeen, 1);
  assert.equal(describe(health, { now: NOW }).text, "طُبّقت الأسعار مع تعارض في 2 صنف و1 صنف غير موجود بالأمين");
});

test("فروق بعد الفحص ⇒ FAILED (verify_mismatch)", () => {
  const health = classify([attempt(1, "verify_mismatch", { verify: { mismatches: 3, missing: 0 } })], { now: NOW });
  assert.equal(health.state, STATES.FAILED);
  assert.match(describe(health, { now: NOW }).text, /فروق: 3/);
});

test("المهمة مسجّلة بلا -Apply ⇒ FAILED (preview_only)، فالأسعار لا تصل للأمين", () => {
  const health = classify([attempt(1, "preview_only", { stage_failed: "apply" })], { now: NOW });
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.reason, "preview_only");
});

test("فشل سحب الأسعار من الموقع ⇒ FAILED (pull_failed) بلا اتصال بالأمين", () => {
  const health = classify([attempt(2, "pull_failed", { stage_failed: "pull", verify: {} })], { now: NOW });
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.lastAmeenContactAt, null);
});

test("استئناف المزامنة بعد انقطاع ⇒ HEALTHY مع resumedAfter", () => {
  const health = classify([attempt(1, "applied"), attempt(240, "applied")], { now: NOW });
  assert.equal(health.state, STATES.HEALTHY);
  assert.ok(health.resumedAfter);
  assert.equal(health.resumedAfter.gapMinutes, 239);
  assert.match(describe(health, { now: NOW }).detail, /عادت المزامنة بعد انقطاع 239 دقيقة/);
});

test("استئناف بعد فشل ⇒ HEALTHY مع resumedAfter.previousOutcome", () => {
  const health = classify([attempt(1, "applied"), attempt(6, "ameen_unreachable")], { now: NOW });
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.resumedAfter.previousOutcome, "ameen_unreachable");
});

test("غياب البيانات ⇒ UNKNOWN (no_data)", () => {
  for (const rows of [[], null, undefined]) {
    const health = classify(rows, { now: NOW });
    assert.equal(health.state, STATES.UNKNOWN);
    assert.equal(health.reason, "no_data");
  }
  assert.equal(describe(classify([], { now: NOW }), { now: NOW }).level, "unknown");
});

test("بيانات تالفة أو مخطط آخر ⇒ UNKNOWN، ولا تُحسب صفوف ameen_price_sync_status القديمة", () => {
  const legacy = { source: "ameen_price_sync_status", created_at: ago(1), summary: { status: "ok", checked_at: ago(1) } };
  const wrongSchema = { created_at: ago(1), summary: { schema: "other/v9", kind: "attempt", outcome: "applied", attempt_finished_at: ago(1) } };
  const health = classify([legacy, wrongSchema, { summary: null }], { now: NOW });
  assert.equal(health.state, STATES.UNKNOWN);
  assert.equal(health.reason, "unreadable_data");
});

test("فحص مهمة فقط بلا محاولات ⇒ UNKNOWN (no_attempts) إن كانت المهمة مفعّلة", () => {
  const health = classify([probe(2, {})], { now: NOW });
  assert.equal(health.state, STATES.UNKNOWN);
  assert.equal(health.reason, "no_attempts");
});

test("فحص مهمة قديم يقول «معطّلة» لا يتغلّب على محاولة ناجحة حديثة", () => {
  const health = classify([attempt(1, "applied"), probe(120, { enabled: false, state: "Disabled" })], { now: NOW });
  assert.equal(health.state, STATES.HEALTHY);
  assert.ok(health.warnings.includes("task_probe_stale"));
});

test("طابع زمني مستقبلي ⇒ UNKNOWN (future_timestamp)", () => {
  const health = classify([attempt(-30, "applied")], { now: NOW });
  assert.equal(health.state, STATES.UNKNOWN);
  assert.equal(health.reason, "future_timestamp");
});

test("نتيجة غير معروفة ⇒ UNKNOWN (unknown_outcome)", () => {
  const health = classify([attempt(1, "something_new")], { now: NOW });
  assert.equal(health.state, STATES.UNKNOWN);
  assert.equal(health.reason, "unknown_outcome");
});

test("الترتيب لا يهم: الأحدث هو المعتمد", () => {
  const health = classify([attempt(30, "ameen_unreachable"), attempt(2, "applied"), attempt(20, "applied")], { now: NOW });
  assert.equal(health.state, STATES.HEALTHY);
  assert.equal(health.lastAttemptAt.toISOString(), ago(2));
});

test("العتبة: 15 دقيقة HEALTHY، و16 STALE", () => {
  assert.equal(classify([attempt(15, "applied")], { now: NOW }).state, STATES.HEALTHY);
  assert.equal(classify([attempt(16, "applied")], { now: NOW }).state, STATES.STALE);
});

test("التوقيت بتوقيت دمشق (UTC+3)، والتاريخ يظهر لغير اليوم", () => {
  assert.equal(formatDamascusTime("2026-10-18T08:34:00Z", NOW), "11:34");
  assert.equal(formatDamascusTime("2026-10-17T20:59:00Z", NOW), "2026-10-17 23:59");
  assert.equal(formatDamascusTime("2026-10-17T21:01:00Z", NOW), "00:01");
  assert.equal(formatDamascusTime(null, NOW), "—");
});

test("received_at (ساعة الخادم) يتقدّم على طوابع العميل: طابع مزوَّر حديث لا يُخفي التقادم", () => {
  const row = attempt(1, "applied");
  row.received_at = ago(60);
  const health = classify([row, probe(1, {})], { now: NOW });
  assert.equal(health.state, STATES.STALE);
  assert.equal(health.lastAttemptAt.toISOString(), ago(60));
});

test("last_success_at المعلن لا يتقدّم على زمن الصف نفسه", () => {
  const row = attempt(30, "verify_mismatch", { last_success_at: ago(-120), verify: { mismatches: 2, missing: 0 } });
  row.received_at = ago(30);
  const health = classify([row], { now: NOW });
  assert.ok(health.lastSuccessAt <= new Date(ago(30)), `lastSuccessAt=${health.lastSuccessAt?.toISOString()}`);
});

for (const [name, extra] of [
  ["بلا اتصال مثبت بالأمين", { ameen_contact_at: null }],
  ["بلا نتيجة فحص", { verify: {} }],
  ["فحص بفروق", { verify: { mismatches: 3, missing: 0 } }],
  ["بلا تطبيق فعلي", { applied_wholesale: 0 }],
  ["أرقام فحص نصية", { verify: { mismatches: "0", missing: "0" } }],
  ["مع تعارض", { conflict_count: 2 }]
]) {
  test(`نجاح ${name} ⇒ FAILED (unproven_success) لا HEALTHY`, () => {
    const health = classify([attempt(2, "applied", extra), probe(1, {})], { now: NOW });
    assert.equal(health.state, STATES.FAILED);
    assert.equal(health.reason, "unproven_success");
    assert.equal(health.lastSuccessAt, null);
  });
}

test("أعمدة الخادم last_success_at/last_ameen_contact_at تتقدّم على ذاكرة الناشر", () => {
  const row = attempt(3, "ameen_unreachable", { last_success_at: ago(4) });
  row.received_at = ago(3);
  row.last_success_at = ago(200);
  row.last_ameen_contact_at = ago(150);
  const health = classify([row, probe(1, {})], { now: NOW });
  assert.equal(health.state, STATES.FAILED);
  assert.equal(health.lastSuccessAt.toISOString(), ago(200));
  assert.equal(health.lastAmeenContactAt.toISOString(), ago(150));
});

test("لا اعتماد على قاعدة الأمين: المصنِّف لا يحوي SQL ولا كتابة ولا شبكة", () => {
  const source = readFileSync("src/price-sync-health.js", "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|insert|update|delete)\s*\(/i);
  assert.doesNotMatch(source, /MaterialPriceListItem000|SqlConnection/);
});

test("الناشر على Windows: قراءة Task Scheduler فقط ولا اتصال بالأمين، ويخرج دائماً بصفر", () => {
  const ps = readFileSync("tools/publish-price-sync-heartbeat.ps1", "utf8");
  const code = ps.replace(/#.*$/gm, "");
  assert.doesNotMatch(code, /SqlConnection|SqlCommand|AMEEN_SQL|Enable-ScheduledTask|Disable-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask/);
  assert.match(code, /Get-ScheduledTask -TaskName \$TaskName/);
  assert.match(code, /\$rpcName = "record_price_sync_heartbeat"/);
  assert.doesNotMatch(code, /inventory_reports/, "النبض لا يُكتب في inventory_reports (Codex P1)");
  assert.match(code, /schema = "price-sync-heartbeat\/v1"|\$schema = "price-sync-heartbeat\/v1"/);
  const exits = [...code.matchAll(/\bexit\s+(\d+)/g)].map((m) => m[1]);
  assert.ok(exits.length > 0 && exits.every((value) => value === "0"), `رموز خروج غير الصفر: ${exits.join(",")}`);
  assert.equal(ps.charCodeAt(0), 0xfeff, "سكربت PowerShell 5.1 يحتاج BOM");
});

test("المنسِّق ينشر نبضاً في كل مسار خروج دون تغيير رموز الخروج القديمة", () => {
  const ps = readFileSync("tools/sync-approved-prices-to-ameen.ps1", "utf8");
  const code = ps.replace(/#.*$/gm, "");
  for (const outcome of ["pull_failed", "preview_only", "ameen_unreachable", "apply_failed", "verify_failed", "verify_mismatch", "applied_with_conflicts", "applied"]) {
    assert.ok(code.includes(`"${outcome}"`), `مسار ${outcome} بلا نبض`);
  }
  assert.deepEqual([...code.matchAll(/\bexit\s+(\d+)/g)].map((m) => m[1]), ["1", "0", "1", "2", "3"], "رموز الخروج القديمة تغيّرت");
  assert.match(code, /publish-price-sync-status\.ps1" -Status \$status/, "ameen_price_sync_status القديم باقٍ");
  assert.match(code, /EventType "sync_failure" -DedupeKey "winfail:apply-to-ameen"/, "تنبيه فشل التطبيق باقٍ");
  assert.equal(ps.charCodeAt(0), 0xfeff, "سكربت PowerShell 5.1 يحتاج BOM");
});

test("Sync Watchdog ينشر فحص المهمة best-effort فقط", () => {
  const ps = readFileSync("tools/ensure-ameen-sync.ps1", "utf8");
  const block = ps.slice(ps.indexOf("# ---------- 3ج)"), ps.indexOf("# ---------- 4)"));
  assert.ok(block.length > 0, "كتلة فحص مهمة الأسعار مفقودة");
  assert.match(block, /-Mode TaskProbe/);
  assert.doesNotMatch(block, /\$problems\.Add|exit\s+\d/, "الفحص لا يضيف مشكلة ولا يغيّر رمز الخروج");
  assert.match(block, /try \{[\s\S]*\} catch \{/);
});

console.log("check-price-sync-health:");
console.log(results.join("\n"));
if (failed) {
  console.error(`❌ ${failed} فحصاً فشل.`);
  process.exit(1);
}
console.log(`✅ ${results.length} فحصاً ناجحاً.`);
