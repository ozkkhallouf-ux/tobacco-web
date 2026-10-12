import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// سياسة تنبيهات Telegram للمهام (proposed/10 + 11) = «ملخص يومي فقط» للأعطال
// غير الحرجة: لا رسائل مستقلة، والعطل المؤكَّد المستمر يظهر في قسم
// «حالة الأنظمة والأعطال» بالتقرير المسائي. فحص ثابت؛ الحقيقة الحتمية في
// supabase/tests/project-task-alert-decision.sql.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');
const canonical = await read('supabase/project-task-health-monitor.sql');
const p10 = await read('supabase/proposed/10-telegram-task-alert-noise-fix.sql');
const p11 = await read('supabase/proposed/11-evening-report-open-faults-section.sql');
const eveningMigration = await read(
  'supabase/migrations/20260926234241_evening_report_supplier_purchases_from_bills.sql',
);

const maxAge = Object.fromEntries(
  [...canonical.matchAll(/\('([a-z-]+)','[^']*','[^']*',(\d+),true,'[^']*'\)/g)].map((m) => [m[1], Number(m[2])]),
);
const alertAfter = Object.fromEntries(
  [...canonical.matchAll(/\('([a-z-]+)',(\d+)\)/g)].map((m) => [m[1], Number(m[2])]),
);
assert.ok(Object.keys(maxAge).length >= 10, 'تعذّر تفكيك حدود الحداثة');
for (const [key, max] of Object.entries(maxAge)) {
  assert.ok(alertAfter[key], `${key}: لا alert_after_minutes`);
  assert.ok(
    alertAfter[key] >= Math.max(45, max * 1.5),
    `${key}: حدّ التأكيد (${alertAfter[key]}) قريب جداً من حدّ الحداثة (${max})`,
  );
}

// لا مهمة حرجة افتراضياً: ameen-main بند ملخص (توقف الوكيل ≠ توقف الموقع/المبيعات)
assert.match(canonical, /set severity='digest' where task_key='ameen-main'/, 'ameen-main يجب أن يكون digest');
assert.ok(!/set severity='critical'/.test(canonical), 'لا مهمة تُضبط حرجة افتراضياً');
assert.equal(alertAfter['ameen-main'], 720, 'ameen-main: حدّ التأكيد 720 د (ساعات العمل غير مثبتة)');
assert.match(canonical, /function private\.core_outage_verified\(\)\s+returns boolean language sql stable as \$\$ select false \$\$/);
assert.match(canonical, /is_verified:=is_critical and private\.core_outage_verified\(\)/);
assert.ok(!canonical.includes('any_recent'), 'صمت inventory_reports لم يعد دليلاً على توقف كامل');
assert.match(canonical, /impact_note/);

// لا رسالة «توقفت مهمة بالمشروع» ولا تذكيرات ⏰
assert.ok(!canonical.includes('توقفت مهمة بالمشروع'), 'رسالة «توقفت مهمة بالمشروع» ما زالت موجودة');
assert.ok(!canonical.includes('⏰'), 'تذكير دوري ما زال موجوداً');
// رسالة التعافي مشروطة بقرار recover (حرج أُنذر عنه فعلاً)
assert.match(canonical, /if decision='recover' then\s+perform public\.notify_telegram\('project_task_recovered'/);
// حلقة cron.job: سجلّ موحَّد لا Telegram
assert.ok(!canonical.includes('🚨 توقفت مهمة داخل الموقع'), 'تنبيه cron الفوري ما زال موجوداً');
assert.ok(!canonical.includes('✅ عادت مهمة الموقع للعمل'), 'تعافي cron المستقل ما زال موجوداً');
assert.match(canonical, /private\.observe_ops_event\('cron',job_record\.jobname/);
assert.match(canonical, /private\.resolve_ops_event\('cron',job_record\.jobname\)/);
// المراقب كله لا يحتوي إلا ثلاث رسائل ممكنة: الحرج المتحقَّق وتعافيه، وعطل مهمة التقرير المسائي نفسها (ناقل الملخص)
const monitorBody = canonical.slice(
  canonical.indexOf('create or replace function private.monitor_project_tasks()'),
  canonical.indexOf('revoke all on function private.monitor_project_tasks()'),
);
assert.match(monitorBody, /if job_record\.jobname='send-evening-report'\s+and \(previous_alerted_health is distinct from job_health\s+or \(job_health='failed' and previous_alerted_terminal_at is distinct from terminal_at\)\) then[\s\S]*?perform public\.notify_telegram\(/, 'استثناء مهمة التقرير المسائي مفقود');
assert.equal(monitorBody.split('public.notify_telegram(').length - 1, 3, 'المراقب يجب ألا يرسل إلا إنذار الحرج المتحقَّق وتعافيه');
// كاشف غياب التقرير المسائي: دالة مستقلة عن مهمة الإرسال، يستدعيها المراقب، برسالة واحدة يومياً
const detector = canonical.slice(
  canonical.indexOf('create or replace function private.check_evening_report_delivered('),
  canonical.indexOf('revoke all on function private.check_evening_report_delivered('),
);
assert.ok(detector.length > 200, 'كاشف التقرير المسائي مفقود');
assert.ok(monitorBody.includes('perform private.check_evening_report_delivered();'), 'المراقب لا يستدعي كاشف التقرير المسائي');
assert.equal(detector.split('public.notify_telegram(').length - 1, 1, 'الكاشف يرسل رسالة واحدة فقط');
assert.match(detector, /'evening-missing:'\|\|to_char\(rep_day,'YYYY-MM-DD'\)/, 'مفتاح اليوم');
assert.match(detector, /day_key,1440\)/, 'تنبيه واحد في اليوم');
assert.ok(detector.includes("'Asia/Damascus'") && detector.includes("time '23:15'") && !detector.includes("time '20:15'"), 'الحدّ 23:15 دمشق (التقرير 20:00 UTC = 23:00 دمشق)');
assert.ok(detector.includes("event_type='evening_report'") && detector.includes("status='sent'") && !detector.includes("status in ('dispatched','sent')"), 'الدليل sent المؤكَّد لا dispatched ولا نجاح cron');
assert.ok(!detector.includes('cron.'), 'الكاشف يجب ألا يعتمد على cron');
// بلا ربط بـnotify_telegram (يتطلب موافقة المالك)
assert.ok(!/create (or replace )?function public\.notify_telegram/.test(canonical), 'الملف القانوني يعدّل notify_telegram الإنتاجي');
assert.ok(!/create (or replace )?function public\.notify_telegram/.test(p10), 'proposed/10 يعدّل notify_telegram الإنتاجي');
// دوال الطبقة الموحَّدة موجودة، وتوجيه المجهول/الأمني/النسخ الاحتياطي فوري
for (const f of ['ops_event_route', 'record_ops_event', 'resolve_ops_event', 'close_stale_ops_events']) {
  assert.ok(canonical.includes(`function private.${f}(`), `الدالة ${f} مفقودة`);
  assert.ok(p10.includes(`function private.${f}(`), `proposed/10 يفتقد ${f}`);
}
assert.match(canonical, /else 'immediate'\s+end/);
assert.match(canonical, /\(backup\|secur\|auth\)/);
assert.match(canonical, /project_task_alert_decision/);
assert.match(canonical, /pg_try_advisory_xact_lock\(hashtextextended\('monitor_project_tasks'/, 'قفل منع تداخل الدورات مفقود');
// حدّ طول القسم والمراقبات المعطّلة
assert.match(canonical, /p_max_chars integer default 1500/);
assert.ok(canonical.includes('أعطال أخرى غير معروضة'));
assert.ok(canonical.includes('المراقبة معطّلة'));
assert.ok(!/join private\.project_task_monitors m on m\.task_key=i\.task_key and m\.enabled/.test(canonical), 'عطل المراقبة المعطّلة يختفي صامتاً');
assert.ok(p11.includes('daily_open_faults_section(now(), greatest(3900'), 'proposed/11 لا يمرّر الميزانية المتبقية');
// قسم التقرير: عنوان، حالة سليمة، حارس انقطاع المراقبة
for (const s of ['حالة الأنظمة والأعطال', 'لا توجد أعطال تشغيلية مستمرة', 'تعذّر التحقق من حالة الأنظمة']) {
  assert.ok(canonical.includes(s), `القسم يفتقد: ${s}`);
}
// فهرس يمنع تكرار العطل المفتوح لنفس المهمة
assert.match(canonical, /project_task_incidents_one_open[\s\S]*where ended_at is null/);

// proposed/10 يحمل نفس الدوال القانونية حرفياً
const slice = (s, from, to) => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `لم يُعثر على ${from}`);
  return s.slice(i, s.indexOf(to, i)).trim();
};
for (const [from, to] of [
  ['create or replace function private.monitor_project_tasks()', 'revoke all on function private.monitor_project_tasks()'],
  ['create or replace function private.project_task_alert_decision(', 'revoke all on function private.project_task_alert_decision'],
  ['create or replace function private.daily_open_faults_section(', 'revoke all on function private.daily_open_faults_section'],
  ['create or replace function private.check_evening_report_delivered(', 'revoke all on function private.check_evening_report_delivered'],
]) {
  assert.equal(slice(p10, from, to), slice(canonical, from, to), `proposed/10 يخالف القانوني: ${from}`);
}

// proposed/11: المرساة موجودة مرة واحدة تماماً في آخر تعريف مُرحَّل لتقرير المساء
const anchor = "perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);";
assert.ok(p11.includes(anchor), 'proposed/11 لا يحمل المرساة');
assert.equal(eveningMigration.split(anchor).length - 1, 1, 'المرساة ليست مرة واحدة في ترحيل التقرير المسائي');
assert.ok(p11.includes('exception when others'), 'القسم يجب ألا يُسقط التقرير عند خطأ');
const body = p11.slice(p11.indexOf('do $patch$')).replace(anchor, '');
assert.ok(!body.includes('notify_telegram('), 'proposed/11 يجب ألا يضيف رسالة Telegram جديدة');

// ── الحزمة الذرّية (proposed/12): لا مرحلة صامتة، وبذر الأعطال القائمة، وبلا لمس notify_telegram ──
const bundle = await read('supabase/proposed/12-digest-only-atomic-bundle.sql');
const rollback = await read('supabase/proposed/12-digest-only-rollback.sql');
assert.ok(!/^\s*(begin|commit);/mi.test(bundle), 'الحزمة طلب واحد ضمني: لا begin/commit داخلها');
assert.ok(bundle.includes("set_config('app.digest_bundle'"), 'الحزمة لا تضبط حارس التطبيق');
assert.ok(p10.includes("current_setting('app.digest_bundle'") && p11.includes("current_setting('app.digest_bundle'"), '10/11 بلا حارس يمنع التطبيق المنفرد');
assert.ok(canonical.includes("current_setting('app.digest_bundle'"), 'الملف القانوني يجب ألا يُطبَّق خارج الحزمة (مرحلة صامتة)');
assert.ok(!/position\('observe_ops_event' in mon/.test(bundle), 'الحزمة تقبل الانجراف بمجرد وجود اسم observe_ops_event');
assert.match(bundle, /md5\(mon_src\) not in \('2c762f38b56ea5a683061529bd5e5d7f', '[0-9a-f]{32}'\)/, 'بصمات دقيقة فقط للمراقب');
assert.ok(bundle.includes('seed_open_faults'), 'الحزمة لا تبذر الأعطال المفتوحة');
assert.ok(bundle.includes('2c762f38b56ea5a683061529bd5e5d7f'), 'الحزمة لا تتحقق من بصمة المراقب الحي (= 09)');
assert.ok(!/create (or replace )?function public\.notify_telegram/.test(bundle + rollback), 'الحزمة/التراجع يعدّلان notify_telegram');
assert.ok(rollback.includes('private.digest_bundle_snapshot') || rollback.includes('snapshot'), 'التراجع بلا لقطة');
// ── proposed/13: توجيه التنبيهات غير الحرجة للملخص — يفشل مفتوحاً ولا يمسّ public.notify_telegram ──
const p13 = await read('supabase/proposed/13-digest-routing-for-noncritical-alerts.sql');
const rb13 = await read('supabase/proposed/13-digest-routing-rollback.sql');
assert.ok(!/create (or replace )?function public\./.test(p13 + rb13), 'proposed/13 يجب ألا يعدّل أي دالة في public');
assert.ok(p13.includes('60bbae6f1fed8ba5e66c9a9a91daed40'), 'proposed/13 لا يثبّت بصمة الإنتاج لدالة الإرسال');
assert.ok(p13.includes("exception when others") && p13.includes('return false'), 'الامتصاص يجب أن يفشل مفتوحاً (يعيد false فيُرسَل التنبيه)');
assert.ok(p13.includes('p_reply_markup is null'), 'الرسائل ذات الأزرار تبقى فورية');
assert.match(p13, /else 'immediate'\s+end/, 'المجهول يجب أن يبقى فورياً');
assert.ok(/security|secur\|auth/.test(p13) && p13.includes('backup'), 'الأمن والنسخ الاحتياطي فوريان');
assert.ok(p13.includes('site-down') && p13.includes('دخان ما بعد النشر'), 'انقطاع الموقع فوري');
assert.ok(p13.includes('patched constant text') && p13.includes('exact open-faults block'), '13 يتحقق من كتلة القسم الدقيقة في التقرير لا من وجود الاسم');
assert.ok(p13.includes('f7bee114d77cecea3bf9fceceb24425a') && !p13.includes("position('digest-routing:v1' in disp)"), '13 يقبل بصمتين فقط (الإنتاج وجسم 13) ولا يكتفي بالوسم');
assert.ok(p13.includes('automation-failure:|ameen-read-worker-)'), 'حوادث عامل أمين تُنذَر مرة واحدة ⇒ نافذة 30 ساعة');
assert.ok((await read('supabase/proposed/12-digest-only-rollback.sql')).includes('digest_routing_snapshot'), 'تراجع 12 يجب أن يرفض عند فعالية 13');
const rb13s = await read('supabase/proposed/13-digest-routing-rollback.sql');
assert.ok((await read('supabase/proposed/12-digest-only-atomic-bundle.sql')).includes('$order12$') && (await read('supabase/proposed/12-digest-only-atomic-bundle.sql')).includes('$guard12$'), 'الحزمة 12 تحرس الترتيب والمعاملة');
assert.ok((await read('supabase/proposed/12-digest-only-atomic-bundle.sql')).includes('$drift12$'), 'الحزمة 12 ترفض الكتابة فوق دوال مساعدة عُدّلت لاحقاً');
assert.ok((await read('supabase/proposed/13-digest-routing-for-noncritical-alerts.sql')).includes('$pre2$'), 'الحزمة 13 تتحقق من انجراف ops_event_route وclose_stale قبل التطبيق');
assert.ok((await read('supabase/proposed/13-digest-routing-for-noncritical-alerts.sql')).includes('2796ac5d112c557951d8fd3c837de6f7') && (await read('supabase/proposed/13-digest-routing-for-noncritical-alerts.sql')).includes('88c6e3d972aa11368de77a7c7a2b52e0'), 'الحزمة 13 تثبّت بصمة ops_event_silence وabsorb_digest_alert');
assert.ok(p13.includes('^(deploy-gate-|launcher-)') && rb13s.includes('f34f129268ee375c10006f004de2d00e'), 'أحداث بوابة النشر/المشغّل فورية وبصمة التوجيه محدَّثة');
assert.ok(rb13s.includes('f7bee114d77cecea3bf9fceceb24425a') && rb13s.includes('drifted') && rb13s.includes('ops_rollback_drain'), 'تراجع 13 يتحقق من الانجراف ويفرّغ الأعطال المفتوحة مرة واحدة');
assert.ok((await read('supabase/proposed/12-digest-only-rollback.sql')).includes('d695a9aea9c75bdd302e40ddd8b16204') && (await read('supabase/proposed/12-digest-only-rollback.sql')).includes('drifted'), 'تراجع 12 يتحقق من الانجراف');
assert.ok((await read('supabase/proposed/12-digest-only-rollback.sql')).includes('ops_rollback_drain'), 'تراجع 12 يفرّغ الأعطال المفتوحة مرة واحدة');
assert.ok(p13.includes('send-evening-report') && p13.includes('evening-missing:'), 'ناقل الملخص (فشل/غياب التقرير المسائي) يبقى فورياً');
assert.ok(rb13.includes('digest_routing_snapshot'), 'تراجع 13 بلا لقطة');
// قرارات المالك (PR #312): الأسعار فورية بنص يميّز الاختلاف عن الأثر المؤكَّد، إحياء الخادم فوري، «حُلّ اليوم» للتعافي المؤكَّد فقط
assert.ok(p13.includes("~ '^price-sync:' then 'immediate'") && p13.includes("p_kind in ('price_sync_failure','price_sync_mismatch') then 'immediate'"), 'مزامنة الأسعار يجب أن تبقى فورية');
assert.ok(!p13.includes('🚨 مزامنة الأسعار: تأثير مؤكَّد') && p13.includes('غير مؤكَّد') && p13.includes('اكتُشف اختلاف') && p13.includes('refine_immediate_alert'), 'نص الأسعار يميّز الاختلاف عن التأثير المؤكَّد');
assert.ok(p13.includes("= 'local-server-revive-fail' then 'immediate'"), 'فشل إحياء الخادم فوري');
assert.ok(p13.includes('winfail:(apply-to-ameen|pull-approved-prices)$'), 'فشل سلسلة الأسعار فوري وباقي دفعات البيانات في الملخص');
assert.ok(p13.includes('refined boolean') && p13.includes('exception when others then null;  -- عطل في آلية الملخص'), 'عطل الامتصاص لا يمنع التنبيه (الأمن مستقل)');
const p12s = await read('supabase/proposed/12-digest-only-atomic-bundle.sql');
assert.ok(p12s.includes("resolution in ('explicit','silence')") && p12s.includes("resolution='explicit'") && p12s.includes('حُلّ اليوم'), '12 يسجّل نوع الإغلاق ويعرض «حُلّ اليوم» للتعافي الصريح فقط');
assert.ok(p13.includes("resolution='silence'") || p13.includes("resolution = 'silence'"), 'إغلاق الصمت لا يُعرض متعافياً');
console.log('Project task alert policy checks passed.');
