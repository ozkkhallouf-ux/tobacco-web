import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// عطلان إنتاجيان حيّان، كلاهما في تصنيف حالة مهام pg_cron:
//
// (١) 2026-08-31 — التصنيف كان قائمة حظر (`last_job_status<>'succeeded'`)، فكل
//     ما ليس "succeeded" يُعدّ فشلاً بما فيه التشغيل الجاري. النتيجة رفرفة
//     prune-inventory-reports ست مرات في الساعة، بينما فشلها الحقيقي الوحيد في
//     11226 تشغيلة كان في 2026-08-20.
//
// (٢) 2026-08-30 09:14 — الاعتماد على الصف الأحدث وحده يُخفي فشلاً مكتملاً
//     بمجرد أن يبدأ التشغيل التالي فوقه: فشلت dispatch-due-reminders
//     وdispatch-telegram-outbox وdispatch-web-push-outbox في اللحظة نفسها،
//     وبدأ تشغيلها التالي 09:15:00.13 قبل دورة المراقب 09:15 — فلم يخرج إنذار
//     واحد عن الإخفاقات الثلاثة.
//
// هذا الفحص يمنع رجوع أيٍّ من العطلين، ويثبّت الحدود التي يسهل أن تنزلق:
// قائمة السماح، فصل الصف الأحدث عن آخر نتيجة مكتملة، الفروع الثلاثة، سلوك
// NULL الصريح، ودلالة حدّ المهلة (< مقابل <=).
const MONITOR_SQL = 'supabase/project-task-health-monitor.sql';
const TRUTH_TABLE = 'supabase/tests/cron-job-health-truth-table.sql';
const TRANSITIONS = 'supabase/tests/cron-job-health-transitions.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = await readFile(path.join(repoRoot, MONITOR_SQL), 'utf8');
const truth = await readFile(path.join(repoRoot, TRUTH_TABLE), 'utf8');
const transitions = await readFile(path.join(repoRoot, TRANSITIONS), 'utf8');

const codeOnly = (text) =>
  text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const monitorCode = codeOnly(sql);

// ---------------------------------------------------------------------------
// 1) منطق الـblacklist القديم ممنوع من العودة بأي تباعد مسافات.
// ---------------------------------------------------------------------------
assert.doesNotMatch(
  monitorCode, /last_job_status\s*<>\s*'succeeded'/,
  `${MONITOR_SQL}: عاد منطق الـblacklist — الحالات العابرة ستُعدّ فشلاً من جديد`,
);
assert.doesNotMatch(
  monitorCode, /p_(?:latest|terminal)_status\s*<>\s*'succeeded'/,
  `${MONITOR_SQL}: تصنيف بقائمة حظر داخل الدالة النقية — المطلوب قائمة سماح صريحة`,
);

// ---------------------------------------------------------------------------
// 2) الدالة النقية بتوقيعها الكامل: مصدران مستقلان، لا مصدر واحد.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode, /create or replace function private\.cron_job_health\(/,
  `${MONITOR_SQL}: الدالة النقية private.cron_job_health مفقودة`,
);
for (const param of [
  'p_active boolean', 'p_latest_status text', 'p_latest_at timestamptz',
  'p_terminal_status text', 'p_terminal_at timestamptz',
  'p_grace interval', 'p_now timestamptz',
]) {
  assert.ok(monitorCode.includes(param), `${MONITOR_SQL}: وسيط مفقود من الدالة النقية — ${param}`);
}
assert.match(
  monitorCode,
  /revoke all on function private\.cron_job_health\(boolean,text,timestamptz,text,timestamptz,interval,timestamptz\)/,
  `${MONITOR_SQL}: revoke مفقود أو توقيعه لا يطابق الدالة`,
);

// ---------------------------------------------------------------------------
// 3) الاستعلامان منفصلان — قلب إصلاح العطل الثاني.
//    استعلام واحد يعني أن فشلاً مكتملاً يختفي بمجرد بدء التشغيل التالي.
// ---------------------------------------------------------------------------
assert.match(
  monitorCode,
  /select status,start_time into last_job_status,last_job_at from cron\.job_run_details\n\s*where jobid=job_record\.jobid order by start_time desc limit 1;/,
  `${MONITOR_SQL}: استعلام "أحدث تشغيل مطلقاً" مفقود أو تغيّر`,
);
assert.match(
  monitorCode,
  /select status,start_time into terminal_status,terminal_at from cron\.job_run_details\n\s*where jobid=job_record\.jobid and status in \('succeeded','failed'\)\n\s*order by start_time desc limit 1;/,
  `${MONITOR_SQL}: استعلام "أحدث تشغيل نهائي" مفقود — بدونه يبتلع retry جارٍ الفشل المكتمل`,
);
assert.match(
  monitorCode,
  /job_health:=private\.cron_job_health\(job_record\.active,last_job_status,last_job_at,\n\s*terminal_status,terminal_at,cron_grace\);/,
  `${MONITOR_SQL}: المراقب لا يمرّر المصدرين معاً إلى المصنِّف`,
);

// ---------------------------------------------------------------------------
// 4) الحالات الست، وأسبقية الفشل النهائي على الجمود وعلى المحاولة الجارية.
// ---------------------------------------------------------------------------
const VERDICTS = ['disabled', 'never_run', 'ok', 'failed', 'inflight', 'stuck'];
for (const verdict of VERDICTS) {
  assert.ok(monitorCode.includes(`'${verdict}'`), `${MONITOR_SQL}: الحالة "${verdict}" غير مذكورة`);
}
const fnStart = monitorCode.indexOf('create or replace function private.cron_job_health(');
const fnBody = monitorCode.slice(fnStart, monitorCode.indexOf('$fn$;', fnStart) + 5);
const iFailed = fnBody.indexOf("when p_terminal_status = 'failed' then 'failed'");
const iStuck = fnBody.indexOf("then 'stuck'");
const iOk = fnBody.indexOf("when p_terminal_status = 'succeeded' then 'ok'");
assert.ok(iFailed > 0, `${MONITOR_SQL}: الفشل النهائي غير مصنَّف صراحةً`);
assert.ok(
  iFailed < iStuck && iStuck < iOk,
  `${MONITOR_SQL}: الأسبقية يجب أن تبقى failed ثم stuck ثم ok — الفشل حقيقة والجمود استنتاج`,
);
assert.match(
  fnBody, /when p_active is not true then 'disabled'/,
  `${MONITOR_SQL}: يجب "p_active is not true" كي تُغطّى NULL؛ "not p_active" تسقط بصمت`,
);
assert.match(
  fnBody, /when p_latest_status is not null then 'inflight'\n\s*else 'never_run'/,
  `${MONITOR_SQL}: التمييز الصريح بين inflight وnever_run مفقود`,
);
assert.doesNotMatch(
  fnBody.slice(fnBody.indexOf('select case')), /now\(\)/,
  `${MONITOR_SQL}: جسم الدالة يجب أن يبقى نقياً — الزمن يدخل عبر p_now لا now()`,
);

// ---------------------------------------------------------------------------
// 5) حدّ المهلة: العمر < grace ⇒ لا جمود، >= grace ⇒ stuck. عشر دقائق مشتقة
//    من القياس (أطول تشغيل مشروع 404.99 ثانية ≈ 6.75 دقيقة).
// ---------------------------------------------------------------------------
assert.match(
  monitorCode, /\(p_latest_at is null or p_now - p_latest_at >= p_grace\) then 'stuck'/,
  `${MONITOR_SQL}: مقارنة الحدّ يجب أن تبقى ">= p_grace" حرفياً`,
);
assert.doesNotMatch(
  monitorCode, /p_now - p_latest_at > p_grace/,
  `${MONITOR_SQL}: ">" تقلب دلالة الحدّ — عشر دقائق بالضبط يجب أن تكون stuck`,
);
assert.match(monitorCode, /p_grace interval default interval '10 minutes'/, `${MONITOR_SQL}: المهلة الافتراضية تغيّرت`);
assert.match(monitorCode, /cron_grace interval:=interval '10 minutes'/, `${MONITOR_SQL}: مهلة المراقب تغيّرت`);

// ---------------------------------------------------------------------------
// 6) الفروع الثلاثة الصريحة، والحياد الكامل للفرع الثالث.
// ---------------------------------------------------------------------------
const cronLoop = monitorCode.slice(monitorCode.indexOf('for job_record in select'));
const iFail = cronLoop.indexOf("if job_health in ('disabled','failed','stuck') then");
const iOkBranch = cronLoop.indexOf("elsif job_health = 'ok' then");
const iNeutral = cronLoop.indexOf('\n  else\n', iOkBranch);
const iEnd = cronLoop.indexOf('\n  end if;', iNeutral);
assert.ok(
  iFail >= 0 && iOkBranch > iFail && iNeutral > iOkBranch && iEnd > iNeutral,
  `${MONITOR_SQL}: الفروع الثلاثة (failure / ok / neutral) غير موجودة بهذا الترتيب — لا تعُد إلى فرعين`,
);
const failBranch = cronLoop.slice(iFail, iOkBranch);
const okBranch = cronLoop.slice(iOkBranch, iNeutral);
const neutralBranch = cronLoop.slice(iNeutral, iEnd);

assert.match(failBranch, /notify_telegram\('project_task_failure'/, `${MONITOR_SQL}: فرع الفشل لا يُشعر`);
assert.match(okBranch, /notify_telegram\('project_task_recovered'/, `${MONITOR_SQL}: التعافي ليس في فرع 'ok'`);
assert.doesNotMatch(
  neutralBranch, /notify_telegram/,
  `${MONITOR_SQL}: الفرع المحايد يُصدر إشعاراً — inflight/never_run يجب أن يصمتا تماماً`,
);
assert.match(
  neutralBranch, /values\('cron:'\|\|job_record\.jobname,null,now\(\),/,
  `${MONITOR_SQL}: الفرع المحايد يجب أن يُنشئ الصف بـis_healthy=null — لا تُخترع true`,
);
const neutralUpsert = neutralBranch.slice(neutralBranch.indexOf('on conflict(task_key) do update set'));
const neutralSet = neutralUpsert.slice(neutralUpsert.indexOf('set ') + 4, neutralUpsert.indexOf(';'));
assert.equal(
  neutralSet.trim(), 'last_observed_at=now()',
  `${MONITOR_SQL}: on conflict في الفرع المحايد يجب أن يحدّث last_observed_at وحدها — وجدت: ${neutralSet.trim()}`,
);

// شهادة النجاح تُختم بزمن التشغيل الناجح، لا بزمن محاولة ما زالت جارية.
assert.match(
  okBranch, /values\('cron:'\|\|job_record\.jobname,true,now\(\),terminal_at,null,'يعمل'\)/,
  `${MONITOR_SQL}: last_success_at يجب أن يكون terminal_at لا last_job_at`,
);

// ---------------------------------------------------------------------------
// 7) هوية الفشل: فشل نهائي بدأ بعد آخر إنذار هو فشل جديد يستحق إشعاراً.
//    الاعتماد على is_healthy وحدها يبتلع كل فشل جديد داخل نافذة الساعة.
// ---------------------------------------------------------------------------
// ملاحظة Codex P1 الثالثة على PR #154: شرط "terminal_at > previous_alert_at"
// جُرّب ثم أُسقط. مفتاح الإرسال ثابت بمهلة 60 دقيقة، وnotify_telegram دالة
// RETURNS void فلا تُبلّغ عن الكتم، بينما previous_alert_at:=now() يعمل بلا
// شرط — فكان الفشل الثاني يُسجَّل كأنه أُنذر عنه ولا يصل، وتُصفَّر معه ساعة
// التذكير. تصنيف الحالة هنا؛ وسياسة الإرسال بند مستقل.
assert.doesNotMatch(
  failBranch, /terminal_at\s*>\s*previous_alert_at/,
  `${MONITOR_SQL}: عاد شرط "فشل نهائي جديد منذ آخر إنذار" — يُقدّم last_alert_at على رسالة قد تكتمها سياسة الإرسال`,
);
assert.match(
  failBranch, /previous_healthy is distinct from false or previous_alert_at is null/,
  `${MONITOR_SQL}: حارس الانتقال إلى الفشل تغيّر`,
);
assert.match(
  failBranch, /previous_alert_at<now\(\)-interval '60 minutes'/,
  `${MONITOR_SQL}: تذكير الستين دقيقة لفشل مستمر اختفى`,
);

// ---------------------------------------------------------------------------
// 8) نص الرسالة يفرّق بين الثلاث، ويذكر المحاولة الجارية فوق الفشل.
// ---------------------------------------------------------------------------
assert.match(monitorCode, /when 'disabled' then 'المهمة معطلة'/, `${MONITOR_SQL}: نص disabled مفقود`);
assert.match(monitorCode, /when 'failed' then format\('فشل آخر تشغيل مكتمل عند/, `${MONITOR_SQL}: نص failed مفقود`);
assert.match(monitorCode, /ومحاولة جارية الآن/, `${MONITOR_SQL}: الرسالة لا تذكر وجود محاولة جارية فوق الفشل`);
assert.match(monitorCode, /format\('عالقة في حالة %s منذ %s'/, `${MONITOR_SQL}: نص stuck مفقود`);

// ---------------------------------------------------------------------------
// 9) جدول الحقيقة يغطي ما يدّعيه.
// ---------------------------------------------------------------------------
const truthAsserts = truth.match(/assert private\.cron_job_health\(/g) ?? [];
assert.ok(truthAsserts.length >= 31, `${TRUTH_TABLE}: عدد التأكيدات ${truthAsserts.length} أقل من 31`);
// كل حالة عابرة تُختبر على جانبي المهلة فوق نجاح نهائي: ضمنها ⇒ ok (لا إنذار
// كاذب)، وبعدها ⇒ stuck. القياس على السلوك المتوقَّع لا على نص فاصل زمني بعينه.
const truthFlat = truth.replace(/\s+/g, ' ');
for (const status of ['starting', 'connecting', 'sending', 'running']) {
  for (const [verdict, why] of [['ok', 'فوق نجاح نهائي وضمن المهلة'], ['stuck', 'بعد المهلة']]) {
    assert.match(
      truthFlat,
      new RegExp(`cron_job_health\\(true,'${status}',[^)]*'succeeded',[^)]*\\) = '${verdict}'`),
      `${TRUTH_TABLE}: "${status}" ${why} غير مختبَرة (المتوقَّع ${verdict})`,
    );
  }
}
for (const [needle, why] of [
  ["'running',t0-interval '10 seconds','failed'", 'محاولة جارية فوق فشل نهائي'],
  ["t0-interval '10 minutes','succeeded'", 'الحدّ بالضبط عند عشر دقائق'],
  ["interval '10 minutes' - interval '1 microsecond'", 'ميكروثانية تحت الحدّ'],
  ["interval '10 minutes' + interval '1 microsecond'", 'ميكروثانية فوق الحدّ'],
  ["'some-future-state'", 'حالة مجهولة'],
  ['private.cron_job_health(true,null,null,null,null', 'لا تشغيل قط'],
  ["private.cron_job_health(true,'running',null,'succeeded'", 'محاولة جارية بلا طابع زمني'],
  ["private.cron_job_health(null,'succeeded'", 'active=NULL'],
  ["'2026-08-30 09:14:00.000956+00'", 'حادثة الإنتاج 2026-08-30 09:14'],
]) {
  assert.ok(truth.includes(needle), `${TRUTH_TABLE}: تغطية ناقصة — ${why}`);
}

// ---------------------------------------------------------------------------
// 10) اختبارات انتقال الحالة: التسلسلات التي لا يلمسها جدول الحقيقة.
// ---------------------------------------------------------------------------
const transitionAsserts = transitions.match(/\bassert /g) ?? [];
assert.ok(
  transitionAsserts.length >= 56,
  `${TRANSITIONS}: عدد التأكيدات ${transitionAsserts.length} أقل من 56 — حُذف تأكيد`,
);
assert.match(
  transitions,
  /select status,start_time into terminal_status,terminal_at from pg_temp\.runs_probe/,
  `${TRANSITIONS}: الاختبار لا يعيد بناء استعلام "آخر نتيجة مكتملة" — يفقد قيمته كحارس`,
);
for (const [needle, why] of [
  ['5: محاولة جارية فوق فشل مكتمل', 'succeeded → failed → running'],
  ['15: last_alert_at لم يُقدَّم', 'فشل A ⇒ إنذار ثم فشل B: الساعة لا تتقدّم'],
  ['20: التعافي خرج عند النجاح الفعلي', 'failed → running → succeeded'],
  ['24: صفر إشعارات في تسلسل سليم بالكامل', 'healthy → running → succeeded'],
  ['26: الفشل يظهر عند النتيجة النهائية', 'healthy → running → failed'],
  ['28: حادثة 09:14', 'حادثة الإنتاج كـfixture'],
  ['32: ثلاث دورات إضافية على نفس الفشل', 'لا إنذار مكرر لنفس الفشل'],
  ['35: محاولة جارية منذ 15 دقيقة', 'transient بعد المهلة ⇒ stuck'],
  ['39: is_healthy=null', 'never_run بلا حالة سابقة'],
  ['44: المحايدة لم تدهس حكم الفشل القائم', 'المحايدة لا تدهس حكماً'],
  ['51: الفشل B لم يُقدّم last_alert_at', 'انحدار Codex P1 الثالثة صراحةً'],
  ['55: التذكير الدوري خرج في موعده الأصلي', 'التذكير الدوري ما زال يعمل'],
]) {
  assert.ok(transitions.includes(needle), `${TRANSITIONS}: تسلسل غير مغطّى — ${why}`);
}
// الحادثة تدخل كقيم مكتوبة، لا كاستعلام لبيانات إنتاج.
assert.doesNotMatch(
  transitions, /from cron\.job_run_details/,
  `${TRANSITIONS}: الاختبار يقرأ بيانات إنتاج — يجب أن يبني تاريخه بقيم مكتوبة`,
);

console.log(
  `pg_cron job health checks passed (${VERDICTS.length} حالات، ${truthAsserts.length} في جدول الحقيقة، `
  + `${transitionAsserts.length} في انتقال الحالة، مصدران منفصلان، ثلاثة فروع، المهلة 10 دقائق).`,
);
