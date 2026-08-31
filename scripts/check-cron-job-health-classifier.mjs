import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// عطل إنتاجي حيّ (2026-08-31): كان تصنيف حالة مهام pg_cron قائمة حظر —
// `last_job_status<>'succeeded'` — فكل ما ليس "succeeded" يُعدّ فشلاً، بما فيه
// التشغيل الجاري. النتيجة عاصفة إنذارات كاذبة على prune-inventory-reports ست
// مرات في الساعة، بينما فشلها الحقيقي الوحيد في 11226 تشغيلة كان في 2026-08-20.
//
// هذا الفحص يمنع رجوع منطق الـblacklist، ويثبّت الحدود التي يسهل أن تنزلق في
// أي تعديل لاحق: قائمة السماح، الحالات الست، سلوك NULL الصريح، ودلالة حدّ
// المهلة (< مقابل <=) التي بلا تثبيت تصير غموضاً في أول مراجعة.
const MONITOR_SQL = 'supabase/project-task-health-monitor.sql';
const TRUTH_TABLE = 'supabase/tests/cron-job-health-truth-table.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = await readFile(path.join(repoRoot, MONITOR_SQL), 'utf8');
const truth = await readFile(path.join(repoRoot, TRUTH_TABLE), 'utf8');

const codeOnly = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

const monitorCode = codeOnly(sql);

// ---------------------------------------------------------------------------
// 1) منطق الـblacklist القديم ممنوع من العودة بأي تباعد مسافات.
//    هذا هو جوهر العطل: قائمة حظر تجعل كل حالة عابرة فشلاً.
// ---------------------------------------------------------------------------
assert.doesNotMatch(
  monitorCode,
  /last_job_status\s*<>\s*'succeeded'/,
  `${MONITOR_SQL}: عاد منطق الـblacklist (last_job_status <> 'succeeded') — الحالات العابرة ستُعدّ فشلاً من جديد`,
);
assert.doesNotMatch(
  monitorCode,
  /p_status\s*<>\s*'succeeded'/,
  `${MONITOR_SQL}: تصنيف بقائمة حظر داخل الدالة النقية — المطلوب قائمة سماح صريحة`,
);

// ---------------------------------------------------------------------------
// 2) الدالة النقية موجودة بتوقيعها الكامل، ويستعملها المراقب فعلاً.
//    وجود الدالة بلا استدعاء = منطق ميت والعطل ما زال حياً.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode,
  /create or replace function private\.cron_job_health\(/,
  `${MONITOR_SQL}: الدالة النقية private.cron_job_health مفقودة`,
);
for (const param of ['p_active boolean', 'p_status text', 'p_last_at timestamptz', 'p_grace interval', 'p_now timestamptz']) {
  assert.ok(monitorCode.includes(param), `${MONITOR_SQL}: وسيط مفقود من الدالة النقية — ${param}`);
}
assert.match(
  monitorCode,
  /job_health:=private\.cron_job_health\(job_record\.active,last_job_status,last_job_at,cron_grace\)/,
  `${MONITOR_SQL}: monitor_project_tasks لا يستدعي المصنِّف — الدالة موجودة لكنها معطّلة عملياً`,
);

// ---------------------------------------------------------------------------
// 3) الحالات الست كلها مصنَّفة صراحة، ولا حالة تُترك لسلوك ضمني.
// ---------------------------------------------------------------------------
const VERDICTS = ['disabled', 'never_run', 'ok', 'failed', 'inflight', 'stuck'];
for (const verdict of VERDICTS) {
  assert.ok(
    monitorCode.includes(`'${verdict}'`),
    `${MONITOR_SQL}: الحالة "${verdict}" غير مذكورة في التصنيف`,
  );
}

// NULL لها سلوك صريح مكتوب، لا نتيجة عرضية لثلاثية SQL المنطقية.
assert.match(
  monitorCode,
  /when p_status is null then 'never_run'/,
  `${MONITOR_SQL}: سلوك status=NULL يجب أن يكون صريحاً (never_run)، لا متروكاً للمنطق الثلاثي`,
);
assert.match(
  monitorCode,
  /when p_last_at is null then 'stuck'/,
  `${MONITOR_SQL}: عابرة بلا طابع زمني يجب أن تُصنَّف stuck صراحة — لا يمكن إثبات حداثتها`,
);
// active=NULL تُعامل معاملة المعطّلة: "is not true" لا "not p_active"، لأن
// الثانية تُرجِع NULL فيسقط الشرط بصمت.
assert.match(
  monitorCode,
  /when p_active is not true then 'disabled'/,
  `${MONITOR_SQL}: يجب استعمال "p_active is not true" كي تُغطّى حالة NULL؛ "not p_active" تسقط بصمت`,
);

// ---------------------------------------------------------------------------
// 4) دلالة حدّ المهلة مثبتة: العمر < grace ⇒ inflight، و>= grace ⇒ stuck.
//    أي انزلاق إلى <= يقلب سلوك الحدّ بالضبط ويجب أن يسقط هنا.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode,
  /when p_now - p_last_at < p_grace then 'inflight'/,
  `${MONITOR_SQL}: مقارنة الحدّ يجب أن تبقى "p_now - p_last_at < p_grace" حرفياً (< صارمة، لا <=)`,
);
assert.doesNotMatch(
  monitorCode,
  /p_now - p_last_at <= p_grace/,
  `${MONITOR_SQL}: <= تقلب دلالة الحدّ — عشر دقائق بالضبط يجب أن تكون stuck لا inflight`,
);

// p_now وسيط لا now() داخل الجسم، وإلا استحال اختبار الحدود حتمياً.
const fnBody = monitorCode.slice(
  monitorCode.indexOf('create or replace function private.cron_job_health('),
  monitorCode.indexOf('$fn$;') + 5,
);
assert.doesNotMatch(
  fnBody.slice(fnBody.indexOf('select case')),
  /now\(\)/,
  `${MONITOR_SQL}: جسم الدالة يجب أن يبقى نقياً — الزمن يدخل عبر p_now لا عبر now()`,
);

// ---------------------------------------------------------------------------
// 5) المهلة عشر دقائق في الدالة وفي المراقب معاً — مشتقة من أطول تشغيل مشروع
//    مقيس (404.99 ثانية ≈ 6.75 دقيقة). أي تغيير يحتاج قراراً موثّقاً.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode,
  /p_grace interval default interval '10 minutes'/,
  `${MONITOR_SQL}: المهلة الافتراضية يجب أن تبقى 10 دقائق`,
);
assert.match(
  monitorCode,
  /cron_grace interval:=interval '10 minutes'/,
  `${MONITOR_SQL}: المهلة التي يمرّرها المراقب يجب أن تبقى 10 دقائق`,
);

// ---------------------------------------------------------------------------
// 6) قرار الإنذار يشمل الثلاث المُنذِرة فقط — لا تُسقَط stuck ولا تُضاف inflight.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode,
  /if job_health in \('disabled','failed','stuck'\) then/,
  `${MONITOR_SQL}: شرط الإنذار يجب أن يكون بالضبط ('disabled','failed','stuck')`,
);

// ---------------------------------------------------------------------------
// 7) نص الرسالة يفرّق بين الثلاث — وإلا بقيت تقول "توقفت" عن مهمة تعمل.
// ---------------------------------------------------------------------------
assert.match(monitorCode, /when 'disabled' then 'المهمة معطلة'/, `${MONITOR_SQL}: نص disabled مفقود`);
assert.match(monitorCode, /when 'failed' then format\('فشل آخر تشغيل عند/, `${MONITOR_SQL}: نص failed مفقود أو لا يميّز نفسه`);
assert.match(monitorCode, /format\('عالقة في حالة %s منذ %s'/, `${MONITOR_SQL}: نص stuck مفقود أو لا يذكر الحالة والمدة`);

// ---------------------------------------------------------------------------
// 8) الصلاحيات: الدالة النقية ليست سطح هجوم، لكن الاتساق مع بقية الملف مطلوب.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode,
  /revoke all on function private\.cron_job_health\(boolean,text,timestamptz,interval,timestamptz\)/,
  `${MONITOR_SQL}: revoke مفقود عن الدالة النقية`,
);

// ---------------------------------------------------------------------------
// 9) جدول الحقيقة موجود ويغطي فعلاً ما يدّعيه.
// ---------------------------------------------------------------------------
const asserts = truth.match(/assert private\.cron_job_health\(/g) ?? [];
assert.ok(
  asserts.length >= 25,
  `${TRUTH_TABLE}: عدد التأكيدات ${asserts.length} أقل من 25 — حُذفت حالات من جدول الحقيقة`,
);
// كل حالة عابرة يجب أن تُختبر على جانبي المهلة معاً. مجرد ورودها في الملف
// لا يكفي: نسخة واحدة تُبقي الفحص أخضر بينما نصف تغطيتها ذهب.
for (const status of ['starting', 'connecting', 'sending', 'running']) {
  assert.ok(
    truth.includes(`,'${status}',t0-interval '1 minute'`),
    `${TRUTH_TABLE}: الحالة العابرة "${status}" غير مختبَرة ضمن المهلة (inflight)`,
  );
  assert.ok(
    truth.includes(`,'${status}',t0-interval '11 minutes'`),
    `${TRUTH_TABLE}: الحالة العابرة "${status}" غير مختبَرة بعد المهلة (stuck)`,
  );
}
for (const [needle, why] of [
  ["t0-interval '10 minutes'", 'الحدّ بالضبط عند عشر دقائق'],
  ["interval '10 minutes' - interval '1 microsecond'", 'ميكروثانية تحت الحدّ'],
  ["interval '10 minutes' + interval '1 microsecond'", 'ميكروثانية فوق الحدّ'],
  ["'some-future-state'", 'حالة مجهولة'],
  ['private.cron_job_health(true,null,null', 'status=NULL مع طابع زمني NULL'],
  ["private.cron_job_health(true,'running',null", 'عابرة بلا طابع زمني'],
  ["private.cron_job_health(null,'succeeded'", 'active=NULL'],
  ["'2026-08-31 08:50:00.215132+00'", 'الحادثة الإنتاجية الحقيقية بأرقامها'],
]) {
  assert.ok(truth.includes(needle), `${TRUTH_TABLE}: حالة غير مغطاة — ${why}`);
}

console.log(
  `pg_cron job health classifier checks passed (${VERDICTS.length} حالات، ${asserts.length} تأكيداً في جدول الحقيقة، المهلة 10 دقائق، الحدّ صارم <).`,
);
