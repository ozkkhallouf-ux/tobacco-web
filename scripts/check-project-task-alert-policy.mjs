import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// سياسة تنبيهات Telegram للمهام (proposed/10): حدّ الحداثة max_age_minutes
// للتسجيل الداخلي فقط، والإرسال بعد alert_after_minutes المثبت لكل مهمة.
// فحص ثابت؛ المحاكاة الحتمية الكاملة في supabase/tests/project-task-alert-decision.sql.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');
const canonical = await read('supabase/project-task-health-monitor.sql');
const proposed = await read('supabase/proposed/10-telegram-task-alert-noise-fix.sql');

const maxAge = Object.fromEntries(
  [...canonical.matchAll(/\('([a-z-]+)','[^']*','[^']*',(\d+),true,'[^']*'\)/g)].map((m) => [m[1], Number(m[2])]),
);
const alertAfter = Object.fromEntries(
  [...canonical.matchAll(/\('([a-z-]+)',(\d+)\)/g)].map((m) => [m[1], Number(m[2])]),
);
assert.ok(Object.keys(maxAge).length >= 10, 'تعذّر تفكيك حدود الحداثة');
for (const [key, max] of Object.entries(maxAge)) {
  assert.ok(alertAfter[key], `${key}: لا alert_after_minutes`);
  assert.ok(alertAfter[key] >= Math.max(45, max * 1.5), `${key}: حدّ التنبيه (${alertAfter[key]}) قريب جداً من حدّ الحداثة (${max})`);
}
assert.ok(alertAfter['ameen-main'] <= 60, 'ameen-main هو المؤشر الأسرع (≤ 60 دقيقة)');

// الرسالة القديمة «توقفت مهمة بالمشروع» ممنوعة للتأخر العادي — لا ترد في الدالة
assert.ok(!canonical.includes('توقفت مهمة بالمشروع'), 'رسالة «توقفت مهمة بالمشروع» ما زالت موجودة');
// رسالة التعافي مشروطة بقرار recover (إنذار سابق فعلي)
assert.match(canonical, /if decision='recover' then\s+perform public\.notify_telegram\('project_task_recovered'/);
// حلقة cron.job وتنبيهاتها الفورية لم تُمسّ
assert.ok(canonical.includes('🚨 توقفت مهمة داخل الموقع'), 'تنبيه مهام cron داخل الموقع اختفى');
// الملف المقترح يحمل نفس الدالة القانونية حرفياً
const fn = (s) => s.slice(s.indexOf('create or replace function private.monitor_project_tasks()'));
const strip = (s) => fn(s).split('revoke all on function private.monitor_project_tasks()')[0].trim();
assert.equal(strip(proposed), strip(canonical), 'proposed/10 يخالف الدالة القانونية');
console.log('Project task alert policy checks passed.');
