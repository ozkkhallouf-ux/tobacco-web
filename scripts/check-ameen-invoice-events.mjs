// ============================================================================
// «أحداث فواتير الأمين» — Ameen Invoice Event Sync، المرحلة 2 (غير مفعَّلة).
//
// قرار المالك (2026-10-20): المرحلة 2 فرع وPR Draft فقط؛ لا تفعيل ولا نشر ولا تغيير على مزامنة
// الإنتاج القائمة، والأمين قراءة فقط دائماً. تعديل فاتورة في الأمين يجب أن يحدّث الفاتورة نفسها
// في الموقع بلا تكرار.
//
// ثلاث طبقات:
//   ١) عقود ساكنة على الهجرة المقترحة والتراجع والوكيل والمكتبة (تعمل في كل مكان).
//   ٢) تشغيل حي لـ supabase/tests/ameen-invoice-events.sql على PostgreSQL محلي مؤقت: في CI إلزامي،
//      ومحلياً يُتخطى إن لم يوجد Postgres. نفس حارس المضيف ونمط check-price-sync-heartbeats-security.
//   ٣) اختبار PowerShell tools/tests/Test-AmeenInvoiceEvents.ps1 عبر pwsh إن وُجد (في CI إلزامي؛
//      وظيفة ps51-compat تشغّله أيضاً على Windows PowerShell 5.1).
// ============================================================================
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/^\uFEFF/, "");
const migrationRel = "supabase/proposed/18-ameen-invoice-events.sql";
const rollbackRel = "supabase/proposed/18-ameen-invoice-events-rollback.sql";
const testRel = "supabase/tests/ameen-invoice-events.sql";
const agentRel = "tools/ameen-invoice-event-agent.ps1";
const libRel = "tools/ameen-invoice-events-lib.ps1";

// ── ١) عقود ساكنة ───────────────────────────────────────────────────────────────────────────
const migration = read(migrationRel);
const code = migration.replace(/--.*$/gm, "");
for (const table of ["ameen_invoices", "ameen_invoice_events"]) {
  assert.match(code, new RegExp(`create table if not exists public\\.${table} \\(`));
  assert.match(code, new RegExp(`alter table public\\.${table} enable row level security;`));
  assert.match(code, new RegExp(`alter table public\\.${table} force row level security;`));
  assert.match(code, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role;`),
    `${table}: لا كتابة مباشرة لأي دور، ولا حتى service_role`);
  assert.match(code, new RegExp(`grant select on table public\\.${table} to authenticated;`));
  assert.doesNotMatch(code, new RegExp(`grant\\s+(insert|update|delete|all)[^;]*${table}`, "i"), `${table}: لا منح كتابة`);
}
assert.match(code, /bill_guid\s+uuid primary key/, "صف واحد لكل فاتورة: bu000.GUID هو المفتاح");
assert.match(code, /event_id\s+text primary key/, "مفتاح الحدث يمنع التكرار");
assert.doesNotMatch(code, /create policy[^;]*for\s+(insert|update|delete|all)/i, "لا سياسة كتابة");
assert.match(code, /using \(\(select public\.is_staff\(\)\)\)/, "القراءة للموظفين فقط");
assert.match(code, /select coalesce\(\(select auth\.uid\(\)\) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid, false\);/,
  "هوية المزامنة المعتمدة نفسها");
assert.match(code, /security definer\s+set search_path = ''/);
assert.match(code, /if not public\.ameen_invoice_is_sync_writer\(\) then/);
assert.match(code, /errcode = '42501'/);
assert.doesNotMatch(code, /'service_role'/, "لا احتياط بمفتاح service_role");
// مراجعة المالك P1: التسلسل وحده يحدد الأحدث — لا وقت المصدر.
assert.match(code, /if v_found and v_seq <= v_cur\.source_seq then\s+v_outcome := 'stale';/, "الحدث الأقدم (تسلسله ≤ المطبَّق) stale ولا يطبَّق");
assert.doesNotMatch(code, /\(v_at, v_seq\)|v_at\s*<=?\s*v_cur|source_event_at\s*<=?/, "وقت المصدر لا يدخل في تحديد الأحدث");
// مراجعة المالك P1: عزل الحدث المعطوب — كتلة فرعية لكل حدث، ورفضه نتيجة لا استثناء للطلب كله.
assert.match(code, /exception when others then\s+v_reason := case/, "كتلة استثناء لكل حدث");
assert.match(code, /'outcome', 'rejected', 'reason_code', sqlstate, 'reason', v_reason/);
assert.match(code, /v_reason := case when sqlstate in \('22023', '22007'\) then sqlerrm else 'unexpected error ' \|\| sqlstate end;/,
  "السبب المعاد بلا محتوى الحدث");
assert.match(code, /then \(e\.value ->> 'source_seq'\)::bigint end nulls last,/, "الدفعة تُعالج بترتيب التسلسل، والمعطوب آخراً");
assert.match(code, /pg_advisory_xact_lock/, "قفل لكل فاتورة");
assert.match(code, /on conflict \(bill_guid\) do update/, "التعديل يحدّث الصف نفسه");
assert.match(code, /revision = t\.revision \+ 1/);
assert.match(code, /\(v_evt ->> 'bill_guid'\) \|\| '\|' \|\| \(v_evt ->> 'source_seq'\) \|\| '\|' \|\| v_kind \|\| '\|' \|\| v_hash \|\| '\|' \|\| v_at_text/,
  "مفتاح الحدث = GUID + تسلسل متزايد (+ النوع والنسخة والوقت)، لا بصمة المحتوى وحدها؛ يُعاد حسابه على الخادم");
// ملاحظة المالك (1): الأيام المتأثرة تُزال مكرراتها قبل إدخال واحد، والمجاميع تُحسب من المصدر.
assert.match(code, /create table if not exists public\.ameen_invoice_dirty_days \(/);
assert.match(code, /select distinct x\.day, v_now, v_now, 1\s+from pg_catalog\.unnest\(v_days\)/,
  "إزالة تكرار اليوم قبل الإدخال (تعديل بلا تغيير التاريخ = اليوم نفسه مرتين)");
assert.match(code, /on conflict \(day\) do update/);
assert.match(code, /create or replace view public\.ameen_invoice_daily_totals\s+with \(security_invoker = true\)/,
  "المجاميع اليومية من المصدر وبصلاحيات القارئ");
assert.match(code, /alter table public\.ameen_invoice_dirty_days force row level security;/);
assert.match(code, /revoke all on function public\.apply_ameen_invoice_events\(jsonb\) from public, anon, service_role;/);
assert.match(code, /grant execute on function public\.apply_ameen_invoice_events\(jsonb\) to authenticated;/);
assert.doesNotMatch(code, /inventory_reports|ameen_customer_invoices/, "مستقل تماماً عن تقرير الفواتير القائم");
assert.doesNotMatch(code, /notify_telegram|cron\.schedule|net\.http/, "لا تنبيه ولا جدولة ولا اتصال خارجي");
assert.doesNotMatch(code, /\bdelete\s+from\s+public\.ameen_invoices\b/i, "الحذف شاهد قبر لا حذف فعلي");

// الوكيل يبني المفتاح نفسه، وبذرة التسلسل من الساعة فلا يعود إلى 1 بعد ضياع الحالة.
const libSrc = read(libRel);
assert.match(libSrc, /"\{0\}\|\{1\}\|\{2\}\|\{3\}\|\{4\}" -f \$BillGuid, \$Seq\.ToString\(\$script:Invariant\), \$Kind, \$VersionHash, \$SourceEventAt/,
  "مفتاح الوكيل = guid|seq|kind|version|at بنفس ترتيب الخادم");
assert.match(libSrc, /last_seq = \(Get-AmeenSeqSeed \$NowUtc\)/, "التسلسل يبدأ من الساعة");

// اختبارات إلزامية بطلب المالك (2026-10-20): حذف أيٍّ منها يُسقط الفحص.
const sqlTest = read(testRel);
for (const name of [
  "same-day edit: applied without error",
  "same-day edit: mark_count +1 (not +2)",
  "same-day edit: daily total recomputed (no double count)",
  "batch same day: one dirty day in the request",
  "date move: both days marked",
  "A-B-A same time: none treated as duplicate",
  "A-B-A same time: final content is A",
  "retry after disconnect: all duplicate",
  "retry after disconnect: no day re-marked",
  "out-of-order: older arrives later = stale",
  "out-of-order: newest content kept",
  "tie on time, lower seq = stale",
  "unordered batch: final content is newest",
  "late older event: stale",
  "newer seq with OLDER Ameen time: applied",
  "older seq with NEWER Ameen time: stale",
  "mixed batch: two valid applied",
  "mixed batch: nine rejected",
  "mixed batch: future event rejected with reason",
  "mixed batch: reasons carry no bill content",
  "mixed batch: nothing written for rejected bill",
  "mixed batch: dirty day only from valid events",
  "repaired future event: applied",
  "requeued old seq after newer applied: stale",
  "edit: still exactly one row for the bill",
]) assert.ok(sqlTest.includes(`'${name}'`), `اختبار SQL إلزامي مفقود: ${name}`);
const psTest = read("tools/tests/Test-AmeenInvoiceEvents.ps1");
for (const name of [
  "A->B->A same timestamp: last A key differs from first A key",
  "A->B->A same timestamp: strictly increasing seq",
  "event key contains the bill guid and seq, not content alone",
  "state lost with empty outbox: clock seed is above every earlier seq",
  "offline: nothing removed",
  "online again: sent strictly in seq order",
  "edit: one updated event for the SAME bill_guid",
  "validate: future timestamp flagged",
  "mixed batch: no batch failure",
  "mixed batch: locally invalid events never sent",
  "mixed batch: outbox empty, nothing lost",
  "dead letter: no sensitive data in reasons or log (no customer name, no amounts)",
  "repair requeue: back in pending with ORIGINAL seq",
  "repair requeue of still-broken event refused",
  "refused repair stays in dead letter (not lost, not queued)",
  // Codex P1-1 (a35c6e86): طابور Resnapshot دائم بقراءة مباشرة بالـGUID
  "resnapshot request: NOT closed early (still in dead letter, not in resolved)",
  "resnapshot request: survives losing state.json (stored with the dead letter)",
  "resnapshot read failure: request kept, no event",
  "resnapshot: reader called with the exact bill GUID (direct read, no date window)",
  "resnapshot: new seq is newer than the isolated event and every earlier seq",
  "resnapshot: event carries the old bill (date outside the 60-day window)",
  "resnapshot: request closed only after the event was written",
  "resnapshot: running the queue again creates no duplicate event",
  "resnapshot after crash: no duplicate event",
  "resnapshot of a bill gone from Ameen: delete event, request closed",
  // Codex P1-2 (a35c6e86): ملف JSON تالف لا يوقف الوكيل
  "corrupt json: send does not throw",
  "corrupt json: valid events sent and acked",
  "corrupt json: valid events still sent in seq order",
  "corrupt json: truncated and empty files isolated",
  "corrupt json: isolated file preserved byte-for-byte (not deleted)",
  "corrupt json: no file content or bill data in reason or log",
  "corrupt json: agent keeps working (next event acked)",
  "corrupt state.json: read does not throw",
  // Codex P1 (da7413e8): حدّ الدفعة بالبايتات، وقفل مثيل واحد
  "batch byte limit: default is below the server 4MB request limit",
  "batch byte limit: every request body within the byte limit",
  "batch byte limit: split into several requests, each making progress",
  "batch byte limit: order preserved across requests",
  "batch byte limit: single event larger than the limit still sent alone (no stall)",
  "server size rejection: nothing removed, batch cap halved",
  "server size rejection: next request uses the smaller cap and succeeds",
  "outbox lock: second acquire in the same process refused",
  "outbox lock: another process is refused while held",
  "outbox lock: second agent instance exits with code 5",
  "outbox lock: refused agent wrote no state or pending files",
  "outbox lock: released lock can be acquired again",
  // Codex P1 (7dbd9915): bill_type غير رقمي، وجسم استجابة PostgREST
  "bill_type text: validation returns a reason instead of throwing",
  "bill_type out of Int32: validation returns a reason instead of throwing",
  "bad bill_type: send does not throw",
  "bad bill_type: both bad events isolated, valid one sent",
  "rpc 400: error message carries status and PostgREST message from the body",
  "rpc 400: details/hint not copied into the message",
  "http 400 size rejection: batch cap halved (not retried forever at the same size)",
  // Codex P1 (51783c90): حذف ملف التفعيل يوقف الإرسال
  "send switch: on with -Send and the owner flag",
  "send switch: deleting the flag turns sending off on the next check",
  "send switch: wrong flag content keeps sending off",
  "send switch: agent re-checks the flag inside the loop before each send",
  // Codex P1 (51783c90): ملف التفعيل يُعاد فحصه قبل كل إرسال
  "send flag: re-checked inside the loop before each send",
  // أداء حفظ الحالة (2026-10-22): الحالة الكاملة عند التغيّر فقط، والعلامة المائية كل دورة
  "canonical json: plain text fast path is byte-identical",
  "canonical json: escapes still applied when needed",
  "state save mode: unchanged cycle saves the watermark only",
  "state save mode: a real change saves the full state",
  "performance: 20 unchanged cycles never rewrite state.json",
  "performance: watermark save stays well under the 500ms cycle budget",
  "performance: watermark save is at least 10x cheaper than a full save",
  "restart: newer watermark of the same state version is used",
  "restart: watermark kept verbatim in server-local time (no UTC shift on PowerShell 7)",
  "restart: watermark from an unsaved state version is ignored (safe rescan)",
  "restart: an older watermark never moves the state back",
  "corrupt watermark.json: state watermark kept",
  "interrupted save: temp leftovers removed on start",
  "interrupted save: original state.json intact and readable",
  "agent: detection loop chooses the save mode (no unconditional full save)",
  "agent: send path saves state only when something was sent or failed",
  // ملف مقفول لحظياً (ثبت على OZK2026): العلامة لا توقف الوكيل، والحالة الكاملة لا تُفسد الأصل
  "locked watermark.json: save does not throw",
  "locked state.json: full save fails loudly, original intact, no temp file",
  // Codex P1 (42af3a30): state_seq تالف في watermark.json لا يمنع الإقلاع
  "watermark state_seq valid: newer watermark used",
  "watermark state_seq restart: bad file replaced by the next save, no seq change",
  "watermark state_seq restart: no event emitted for known versions after recovery",
  "watermark state_seq parser: TryParse rejects text, overflow and zero",
  // Codex P1 (37be4ca8): تاريخ مستحيل في العلامة لا يوقف الوكيل
  "state.json invalid watermark date: read does not throw and watermark is cleared",
  "watermark parser: valid date returned verbatim, impossible dates rejected",
  // تعافي اتصال SQL (حادثة OZK2026 2026-10-25: إسبات بطارية ثم خروج صامت برمز 1)
  "sql reconnect: delay doubles from 2s and caps at 300s",
  "sql reconnect: lock timeout on an open connection is not a disconnect",
  "sql reconnect: closed or broken connection is a disconnect",
  "sql reconnect: transport error numbers are a disconnect",
  "sql reconnect: command timeout (-2/258) on an open connection is a slow-server warning, not a disconnect",
  "sql reconnect: pause after a resume is at least the poll interval and grows with consecutive resumes up to 300s",
  "sql reconnect: non-SQL error on an open connection is not a disconnect",
  "sql reconnect: connection InvalidOperationException is a disconnect",
  "sql reconnect: a locked state file is not mistaken for a disconnect",
  'sql reconnect: SqlException 0 "connection is broken" counts as a disconnect (live test 2026-10-26)',
  "sql reconnect: deadlock or syntax message is not mistaken for a disconnect",
  "sql reconnect: any SQL failure of a trivial query (GETDATE, open) is a disconnect",
  'sql reconnect: SqlException 0 "connection is broken" counts as a disconnect (live test 2026-10-26)',
  "sql reconnect: deadlock or syntax message is not mistaken for a disconnect",
  "sql reconnect: any SQL failure of a trivial query (GETDATE, open) is a disconnect",
  "sql reconnect: recovers after failures with backoff and logs RECONNECTING then RECOVERED",
  "sql reconnect: gives up after the attempt limit without throwing",
  "sql reconnect: log text never carries a password",
  "first connection failure: agent retries, logs DISCONNECTED/RECONNECTING/GAVE_UP and exits with code 6",
  "first connection failure: no password or user in the agent log",
  "first connection failure: no state, watermark or pending written",
  "first connection failure: outbox lock released after exit",
  "agent: first SQL query of each cycle runs inside error handling",
  "agent: startup connection and server time go through the reconnect path",
  "agent: a disconnect inside detection restarts the cycle without advancing the watermark",
  "agent: unexpected errors are logged as FATAL before exit",
  "agent: a broken connection is replaced, never reused",
  "disconnect at first query: watermark not advanced (memory and disk)",
  "disconnect at first query: no event and no seq allocated",
  "disconnect mid-cycle: nothing emitted, watermark and checkpoint unchanged",
  "outbox write failure after reads: not treated as a SQL disconnect (agent stops instead)",
  "outbox write failure after reads: nothing saved, disk state and watermark unchanged",
  "after reconnect: both invoices from the outage emitted exactly once",
  "after reconnect: seq strictly increasing from the last checkpoint",
  "after reconnect: watermark advances only after the successful cycle",
  "after reconnect: re-reading the same invoices creates no duplicate",
  "agent restart after recovery: no lost and no duplicate events",
  "agent: only failures before Resolve can trigger SQL recovery",
  "agent: database name re-verified after every reconnect",
  "agent: dead pooled connections cleared before reopening",
  "strict env file: agent refuses a missing, corrupt or malformed file with code 7 and never falls back to the environment",
  "strict env file: SQL outage still goes through DISCONNECTED/RECONNECTING/GAVE_UP (code 6)",
  "login guard: query passes the read-only guard as is",
  "login guard: unexpected account refused without naming it",
  "login guard: write on the price table, db_datawriter, database INSERT, EXECUTE or sysadmin refused",
  "login guard: fail-closed on undetermined role, missing read permission or empty result",
  "login guard: runs after the database check on every connection, first and after each reconnect",
  "login guard: a confirmed violation stops the agent with code 8 and a refusal line",
]) assert.ok(psTest.includes(`'${name}'`), `اختبار PowerShell إلزامي مفقود: ${name}`);

const rollback = read(rollbackRel).replace(/--.*$/gm, "");
assert.match(rollback, /drop table if exists public\.ameen_invoices;/);
assert.match(rollback, /drop table if exists public\.ameen_invoice_events;/);
assert.match(rollback, /drop table if exists public\.ameen_invoice_dirty_days;/);
assert.match(rollback, /drop view if exists public\.ameen_invoice_daily_totals;/);
assert.match(rollback, /drop function if exists public\.apply_ameen_invoice_events\(jsonb\);/);
assert.doesNotMatch(rollback, /inventory_reports|is_staff|ameen_price_sync_status/);

// طُبِّقت 18 على الإنتاج (2026-10-22) ثم 21 (2026-10-24)، وسُجِّلت كل منهما بإصدارها على الإنتاج: هجرتان
// فقط في السلسلة تحملان هذه الكائنات، ونصّ كل منهما مطابق حرفياً لما طُبِّق (proposed/18 وproposed/21) —
// أي تعديل لاحق يأتي بهجرة جديدة لا بتحرير هاتين.
{
  const applied18Rel = "supabase/migrations/20261022034859_ameen_invoice_events.sql";
  const applied21Rel = "supabase/migrations/20261024145946_ameen_invoice_events_concurrent_duplicates.sql";
  const carriers = readdirSync(path.join(root, "supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .filter((f) => /apply_ameen_invoice_events|public\.ameen_invoices\b/.test(readFileSync(path.join(root, "supabase/migrations", f), "utf8")))
    .sort();
  assert.deepEqual(carriers, [path.basename(applied18Rel), path.basename(applied21Rel)], "هجرتان فقط تحملان كائنات 18/21، بالإصدارين المسجَّلين على الإنتاج");
  assert.equal(read(applied18Rel), read(migrationRel), `${applied18Rel}: يجب أن تطابق proposed/18 حرفياً`);
  assert.equal(read(applied21Rel), read("supabase/proposed/21-ameen-invoice-events-concurrent-duplicates.sql"), `${applied21Rel}: يجب أن تطابق proposed/21 حرفياً`);
}

// الوكيل والمكتبة: قراءة فقط، لا تسجيل مهمة، لا إرسال افتراضي.
const agent = read(agentRel);
const lib = read(libRel);
const agentCode = agent.replace(/#.*$/gm, "");
const libCode = lib.replace(/#.*$/gm, "");
// تعافي اتصال SQL (حادثة OZK2026 2026-10-25): لا استعلام في الحلقة خارج المعالجة، ولا خروج صامت، ولا تسجيل لسلسلة الاتصال.
{
  const loop = agentCode.slice(agentCode.indexOf("    do {"), agentCode.indexOf("} while ($true)"));
  assert.match(loop, /try \{ \$nowSrv = \[datetime\]\(Invoke-AmeenRead "SELECT GETDATE\(\) t"\)/, "أول استعلام في الدورة داخل try");
  assert.match(loop, /catch \{ if \(Resume-AmeenSqlAfterFailure \$_ "بداية الدورة" -AnySqlIsLost\) \{ Wait-AmeenAfterSqlResume; continue \} else \{ throw \} \}/, "انقطاع في بداية الدورة ⇒ إعادة اتصال ثم مهلة ثم الدورة من جديد");
  assert.match(loop, /if \(Resume-AmeenSqlAfterFailure \$_ "الرصد والمطابقة"\) \{ Wait-AmeenAfterSqlResume; continue \}/, "انقطاع أثناء الرصد ⇒ لا تقدّم للعلامة، ومهلة قبل الإعادة");
  // لا continue بعد عودة الاتصال بلا مهلة: الإعادة الفورية كانت تتخطى حارس الأداء والنوم (مراجعة دمج #398).
  assert.equal((loop.match(/Resume-AmeenSqlAfterFailure[^\n]*\{ continue \}/g) || []).length, 0, "كل عودة اتصال في الحلقة تمر بـWait-AmeenAfterSqlResume");
  assert.ok(loop.indexOf("$script:resumeStreak = 0") > loop.indexOf("$elapsedMs = ((Get-Date) - $cycleStart)"), "عدّاد العودات يُصفَّر بعد دورة مكتملة فقط");
  assert.ok(loop.indexOf("Add-AmeenOutboxEvents -Dir $OutboxDir -Events $events") < loop.indexOf("$state.watermark = Format-AmeenSqlDate $nowSrv"), "العلامة بعد كتابة الأحداث");
  const rd = loop.indexOf("$readsDone = $true"), rs = loop.indexOf("$events = Resolve-AmeenInvoiceChanges"), gd = loop.indexOf("if ($readsDone) { throw }"), rm = loop.indexOf('Resume-AmeenSqlAfterFailure $_ "الرصد والمطابقة"');
  assert.ok(rd > 0 && rd < rs && gd > rs && gd < rm, "التعافي من SQL قبل Resolve فقط؛ فشل الكتابة بعده FATAL (Codex P1 على #397)");
}
assert.match(agentCode, /Write-AgentLog \("FATAL: /, "لا خروج صامت: الخطأ غير المتوقع يُسجَّل");
assert.match(agentCode, /\[int\]\$MaxReconnectAttempts = 288/, "حدّ أعلى لمحاولات إعادة الاتصال");
assert.doesNotMatch(agentCode, /Write-AgentLog[^\n]*(\$connStr|ConnectionString)/, "لا تُسجَّل سلسلة الاتصال");
assert.match(libCode, /function Invoke-AmeenSqlReconnect/);
assert.doesNotMatch(libCode.match(/\$script:AmeenSqlConnectionLostNumbers = @\(([^)]*)\)/)[1], /(^|,\s*)(-2|258)(\s*,|$)/, "مهلة الأمر ليست انقطاعاً: تبقى لحارس الأداء");
assert.match(libCode, /function ConvertTo-AmeenSafeLogText/);
assert.match(agentCode, /\$RpcName = "apply_ameen_invoice_events"/, "الوكيل يكتب عبر الدالة المقترحة وحدها");
assert.match(agentCode, /\/rest\/v1\/rpc\//);
assert.match(libCode, /if \(-not \$SendRequested\) \{ return \$false \}/, "لا إرسال بلا -Send");
assert.match(libCode, /\$flag = Join-Path \$Dir "send-enabled\.flag"/, "ولا بلا ملف تفعيل يضعه المالك");
// Codex P1 (51783c90): ملف التفعيل يُعاد فحصه داخل الحلقة قبل كل دفعة، فحذفه مفتاح إيقاف فعلي.
{
  const doIdx = agentCode.indexOf("    do {");
  const whileIdx = agentCode.indexOf("} while ($true)");
  const chkIdx = agentCode.indexOf("$sendNow = Test-AmeenSendActivated -Dir $OutboxDir -SendRequested:$Send");
  assert.ok(doIdx > 0 && chkIdx > doIdx && chkIdx < whileIdx, "إعادة فحص ملف التفعيل داخل الحلقة قبل كل دفعة");
}
assert.match(agentCode, /Assert-AmeenReadOnlySql \$Sql/, "كل SQL يمرّ عبر حارس القراءة");
assert.match(agentCode, /SET LOCK_TIMEOUT 3000; /);
assert.match(agentCode, /\$ExpectedDatabase = "AmnDb002"/);
assert.match(agentCode, /if \(\$ListDeadLetter -or \$RepairDeadLetterSeq -gt 0\) \{/, "طريقة واضحة لعرض الأحداث المعزولة وإصلاحها");
assert.match(libCode, /Move-AmeenEventToDeadLetter -Dir \$Dir -File \$p\.file -InvoiceEvent \$p\.event -Code \$why\.code/, "التحقق المحلي يعزل قبل الإرسال");
// Codex P1-2: كل ملف يُقرأ ويُحلَّل منفرداً، والتالف يُعزل ولا يرمي.
assert.match(libCode, /\$read = Read-AmeenJsonFileSafe -Path \$f\.FullName/, "قراءة محمية لكل ملف معلّق");
assert.match(libCode, /-Code "unreadable_json"/);
assert.match(libCode, /\$batch = Get-AmeenOutboxBatch -Dir \$Dir -Max \$BatchSize -NowUtc \$NowUtc/, "الإرسال يمرّ عبر الدفعة المحمية");
assert.doesNotMatch(libCode, /Get-Content -Raw -LiteralPath \$f\.FullName -Encoding UTF8 \| ConvertFrom-Json/, "لا تحليل غير محمي لملفات الصندوق");
// Codex P1-1: طابور Resnapshot دائم يُعالج في كل دورة بقراءة مباشرة بالـGUID.
assert.match(agentCode, /Invoke-AmeenResnapshotQueue -Dir \$OutboxDir -State \$state -Reader \$resnapshotReader/);
assert.match(agentCode, /\$o = Get-AmeenBillObservation \(\[string\]\$Guid\) @\(\)/, "القارئ بالـGUID مباشرة (لا نافذة تاريخ)");
assert.match(libCode, /status = "resnapshot_pending"/, "الطلب محفوظ مع الحدث المعزول (دائم)");
// Codex P1 (da7413e8): حدّ بايتات أدنى من حدّ الخادم، وقفل مثيل واحد قبل قراءة الحالة.
const maxBytes = Number((lib.match(/\$script:AmeenMaxBatchBytes = (\d+)/) || [])[1]);
const serverMax = Number((migration.match(/pg_column_size\(p_events\) > (\d+)/) || [])[1]);
assert.ok(maxBytes > 0 && serverMax > 0 && maxBytes < serverMax, `حدّ دفعة الوكيل (${maxBytes}) يجب أن يقل عن حدّ الخادم (${serverMax})`);
assert.match(libCode, /if \(\$take\.Count -gt 0 -and \(\$bytes \+ \$add\) -gt \$MaxBatchBytes\) \{ break \}/, "الدفعة تُبنى بحد بايتات");
assert.match(libCode, /\[IO\.FileShare\]::None/, "قفل حصري على ملف agent.lock");
assert.match(agentCode, /\$outboxLock = Enter-AmeenOutboxLock -Dir \$OutboxDir/, "الوكيل يأخذ القفل");
// Codex P1 (7dbd9915): الإرسال عبر Invoke-AmeenRpc (رسالة موحّدة من الجسم)، وتحويل bill_type آمن.
assert.match(agentCode, /\$resp = Invoke-AmeenRpc -Url/, "الوكيل يرسل عبر Invoke-AmeenRpc");
assert.doesNotMatch(agentCode, /Invoke-RestMethod -Method Post -Uri \(\$script:session\.url/, "لا استدعاء RPC مباشر يضيّع جسم الخطأ");
assert.match(libCode, /\[int\]::TryParse\(\[string\]\$b\.bill_type/, "تحويل bill_type آمن");
assert.doesNotMatch(libCode, /catch \{\s*\}/, "لا كتلة catch فارغة (CodeFactor PSAvoidUsingEmptyCatchBlock)");
assert.ok(agentCode.indexOf("Enter-AmeenOutboxLock -Dir $OutboxDir") < agentCode.indexOf("Read-AmeenInvoiceState -Dir $OutboxDir"), "القفل قبل قراءة الحالة");
const loopAt = agentCode.indexOf("do {");
const recheckAt = agentCode.indexOf("$sendNow = Test-AmeenSendActivated", loopAt);  // (من Cursor 25965c77، مُحدَّث للدالة الجديدة)
const sendAt = agentCode.indexOf("Send-AmeenInvoiceOutbox", loopAt);
assert.ok(loopAt >= 0 && recheckAt > loopAt && sendAt > recheckAt, "إعادة فحص ملف التفعيل داخل الحلقة قبل كل إرسال");
for (const [name, text] of [["agent", agent], ["lib", lib]]) {
  assert.doesNotMatch(text, /AMEEN_SQL_WRITE_CONNECTION_STRING|WRITE_CONNECTION/, `${name}: لا سلسلة اتصال الكتابة`);
  assert.doesNotMatch(text, /Register-ScheduledTask|schtasks/i, `${name}: لا تسجيل مهمة مجدولة`);
  assert.doesNotMatch(text, /ExecuteNonQuery|ExecuteReader|ExecuteScalar|SqlBulkCopy|Invoke-Sqlcmd/, `${name}: لا تنفيذ SQL خارج القراءة المحروسة`);
  assert.doesNotMatch(text, /with\s*\(\s*nolock/i, `${name}: لا NOLOCK (قراءة متسقة فقط)`);
  assert.doesNotMatch(text, /inventory_reports|SUPABASE_SERVICE_KEY|service_role/, `${name}: حساب المزامنة وحده، بلا inventory_reports`);
}
// أنماط فحص الكتابة في بوابة نشر Windows على ملفات المرحلة 2 (دفاع إضافي متطابق مع البوابة).
const gate = JSON.parse(read("tools/deploy-gate/gate-config.example.json"));
for (const pattern of gate.writeScan.patterns) {
  const re = new RegExp(pattern, "i");
  assert.doesNotMatch(agentCode, re, `agent: نمط كتابة على الأمين (${pattern})`);
  assert.doesNotMatch(libCode, re, `lib: نمط كتابة على الأمين (${pattern})`);
}
// غير مفعَّل: لا شيء في المستودع يشغّل الوكيل.
const runners = [];
const walk = (dir) => {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!["node_modules", ".git", "tests"].includes(entry.name)) walk(rel); continue; }
    if (!/\.(ps1|psm1|vbs|cmd|bat|json|js|mjs|yml|yaml)$/.test(entry.name)) continue;
    const relPosix = rel.split(path.sep).join("/");
    // الوكيل ومكتبته، والمراقب (يذكر اسمه ليتعرّف على عمليته فقط — حارسه في القسم ٤)، وفحوص scripts/check*.mjs
    // (تقرأ الملفات ولا تشغّلها — نفس استثناء writeScan في البوابة).
    if ([agentRel, libRel, "tools/ameen-invoice-agent-monitor.ps1"].includes(relPosix) || /^scripts\/check[^/]*\.mjs$/.test(relPosix)) continue;
    if (readFileSync(path.join(root, rel), "utf8").includes("ameen-invoice-event-agent")) runners.push(rel);
  }
};
for (const dir of ["tools", "scripts", ".github"]) if (existsSync(path.join(root, dir))) walk(dir);
assert.deepEqual(runners, [], `الوكيل غير مفعَّل: لا يجوز أن يستدعيه أي ملف (${runners.join(", ")})`);
console.log("  ✓ عقود ساكنة: صف لكل فاتورة، بلا تكرار، بترتيب، هوية المزامنة فقط، الوكيل قراءة فقط وغير مفعَّل");

// ── ٢) تشغيل SQL حي ─────────────────────────────────────────────────────────────────────────
const DB = "ozk_ameen_invoice_events_test";
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  const command = viaTcp ? "psql" : "sudo";
  const argv = viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args];
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-ameen-invoice-events: refusing non-local PGHOST");
  process.exit(1);
}
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/ameen-invoice-events.sql");
    process.exit(1);
  }
  console.log("  - SQL حي: متخطى (لا PostgreSQL محلي)");
} else {
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const create = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
  const testSql = read(testRel);
  assert.ok(testSql.includes("\\i :migration") && testSql.includes("\\i :rollback"), "الاختبار يطبّق الهجرة والتراجع");
  const bundled = testSql.replace("\\i :migration", () => migration).replace("\\i :rollback", () => read(rollbackRel));
  const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
  const drop = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const text = `${output(create)}${output(run)}`;
  const passes = (text.match(/PASS /g) || []).length;
  if (create.status !== 0 || run.status !== 0 || !text.includes("AMEEN_INVOICE_EVENTS_OK") || /TEST FAIL/.test(text)) {
    console.error(text);
    console.error("check-ameen-invoice-events: live SQL test failed");
    process.exit(run.status || 1);
  }
  if (drop.status !== 0) console.error(output(drop));
  assert.ok(passes >= 139, `عدد التأكيدات الحية أقل من المتوقع (${passes})`);
  console.log(`  ✓ اختبار SQL حي على PostgreSQL: ${passes} تأكيداً`);
}

// ── ٣) اختبار PowerShell ────────────────────────────────────────────────────────────────────
const pwshProbe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
if (pwshProbe.status !== 0) {
  if (process.env.CI === "true") { console.error("CI must run tools/tests/Test-AmeenInvoiceEvents.ps1 (pwsh missing)"); process.exit(1); }
  console.log("  - اختبار PowerShell: متخطى (لا pwsh)");
} else {
  const ps = spawnSync("pwsh", ["-NoProfile", "-File", path.join(root, "tools/tests/Test-AmeenInvoiceEvents.ps1")], { encoding: "utf8" });
  const psText = output(ps);
  if (ps.status !== 0 || /^FAIL /m.test(psText)) {
    console.error(psText);
    console.error("check-ameen-invoice-events: PowerShell test failed");
    process.exit(ps.status || 1);
  }
  const m = psText.match(/Ameen invoice events: (\d+) PASS, (\d+) FAIL/);
  assert.ok(m && Number(m[2]) === 0 && Number(m[1]) >= 170, "نتيجة اختبار PowerShell غير متوقعة");
  console.log(`  ✓ اختبار PowerShell (${pwshProbe.stdout.trim()}): ${m[1]} تأكيداً`);
}

// ── ٤) مراقب الوكيل المستقل (تنبيه انقطاع SQL الطويل، شرط المالك 2026-10-26) ────────────────────
const monitorRel = "tools/ameen-invoice-agent-monitor.ps1";
const monitor = read(monitorRel);
assert.match(monitor, /\$script:EventType = 'invoice_agent'/, "المراقب يرسل بنوع invoice_agent");
assert.match(monitor, /\[int\]\$ThresholdMinutes = 10,/, "عتبة الانقطاع 10 دقائق افتراضياً");
assert.match(monitor, /if \(\$out -match 'TELEGRAM-NOTIFY OK'\)/, "التنبيه واصل فقط بسطر TELEGRAM-NOTIFY OK");
assert.doesNotMatch(monitor, /SqlConnection|Invoke-Sqlcmd|EnvFile|Get-Content|GetEnvironmentVariable|Invoke-RestMethod/,
  "المراقب لا يتصل بـSQL ولا يقرأ الأسرار ولا يتصل بالشبكة بنفسه");
assert.doesNotMatch(monitor, /Stop-ScheduledTask|Start-ScheduledTask|Stop-Process|Register-ScheduledTask|Remove-Item/,
  "المراقب لا يوقف الوكيل ولا يغيّر المهام ولا يحذف شيئاً");
assert.deepEqual(monitor.split("\n").filter((l) => l.includes("ameen-invoice-event-agent")).map((l) => l.trim().slice(0, 40)),
  ["if ($p.CommandLine -match 'ameen-invoice"], "المراقب يذكر الوكيل في سطر التعرّف على عمليته وحده، ولا يشغّله");
// كل نص يُرسل يُبنى من نصوص ثابتة وأوقات ومدد: نص السجل الخام لا يدخل أي تنبيه.
assert.doesNotMatch(monitor, /\$msg\b[^\n]*-f|-f[^\n]*\$msg\b/, "نص سطر السجل لا يدخل نص تنبيه");
for (const marker of ["DISCONNECTED:", "RECONNECTING:", "RECOVERED:", "GAVE_UP:", "FATAL:", "بدء الوكيل:", "انتهى الوكيل:", "رفض: مثيل آخر"]) {
  assert.ok(monitor.includes(`'${marker}`), `المراقب يتعرّف على ${marker}`);
  assert.ok(agent.includes(marker) || lib.includes(marker), `علامة ${marker} ما زالت يكتبها الوكيل أو مكتبته (عقد السجل)`);
}
if (pwshProbe.status === 0) {
  const pm = spawnSync("pwsh", ["-NoProfile", "-File", path.join(root, "tools/tests/Test-AmeenInvoiceAgentMonitor.ps1")], { encoding: "utf8" });
  const pmText = output(pm);
  const mm = pmText.match(/PASSED: (\d+) assertions/);
  if (pm.status !== 0 || !mm) {
    console.error(pmText);
    console.error("check-ameen-invoice-events: agent monitor PowerShell test failed");
    process.exit(pm.status || 1);
  }
  assert.ok(Number(mm[1]) >= 56, `عدد تأكيدات مراقب الوكيل أقل من المتوقع (${mm[1]})`);
  console.log(`  ✓ مراقب الوكيل (محاكاة الانقطاع والتوقف وفشل Telegram): ${mm[1]} تأكيداً`);
}
console.log("check-ameen-invoice-events: اجتاز الفحص.");
