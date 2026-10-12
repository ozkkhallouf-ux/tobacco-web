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

// حرج واحد فقط: ameen-main
assert.match(canonical, /severity='critical'[^;]*task_key='ameen-main'/s, 'ameen-main يجب أن يكون الحرج الوحيد');
assert.match(canonical, /impact_note/);

// لا رسالة «توقفت مهمة بالمشروع» ولا تذكيرات ⏰
assert.ok(!canonical.includes('توقفت مهمة بالمشروع'), 'رسالة «توقفت مهمة بالمشروع» ما زالت موجودة');
assert.ok(!canonical.includes('⏰'), 'تذكير دوري ما زال موجوداً');
// رسالة التعافي مشروطة بقرار recover (حرج أُنذر عنه فعلاً)
assert.match(canonical, /if decision='recover' then\s+perform public\.notify_telegram\('project_task_recovered'/);
// حلقة cron.job وتنبيهاتها الفورية لم تُمسّ
assert.ok(canonical.includes('🚨 توقفت مهمة داخل الموقع'), 'تنبيه مهام cron داخل الموقع اختفى');
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
console.log('Project task alert policy checks passed.');
