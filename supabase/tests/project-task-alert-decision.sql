-- جدول حقيقة private.project_task_alert_decision (proposed/10، سياسة الملخص اليومي فقط)
-- تقييم خالص، لا يقرأ ولا يكتب أي جدول. التشغيل:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/project-task-alert-decision.sql
-- المعاملات: has_report, age, backlogged, fault_min, max_age, alert_after, critical, verified, alerted
-- النواتج: ok | recover | track | open | hold | alert
do $$
begin
  -- سليم
  assert private.project_task_alert_decision(true, 5, false, 0, 10, 120, false, false, false) = 'ok';
  -- تأخر عابر دون حدّ التأكيد: تتبّع داخلي فقط (لا يظهر في التقرير)
  assert private.project_task_alert_decision(true, 15, false, 5, 10, 120, false, false, false) = 'track';
  assert private.project_task_alert_decision(true, 119.9, false, 100, 10, 120, false, false, false) = 'track';
  -- بلوغ حدّ التأكيد: عطل مؤكَّد غير حرج = open (يدخل التقرير اليومي، بلا Telegram)
  assert private.project_task_alert_decision(true, 120, false, 110, 10, 120, false, false, false) = 'open';
  assert private.project_task_alert_decision(true, 500, false, 490, 10, 120, false, true, false) = 'open';
  -- حرج لكن غير متحقَّق منه (مصدر آخر يعمل) = open وليس alert
  assert private.project_task_alert_decision(true, 60, false, 50, 15, 45, true, false, false) = 'open';
  -- حرج ومتحقَّق = alert (الإنذار الفوري الوحيد)
  assert private.project_task_alert_decision(true, 60, false, 50, 15, 45, true, true, false) = 'alert';
  -- بعد الإنذار: لا تكرار ولا تذكيرات
  assert private.project_task_alert_decision(true, 900, false, 890, 15, 45, true, true, true) = 'hold';
  -- تعافٍ: رسالة فقط لمن أُنذر عنه (الحرج)
  assert private.project_task_alert_decision(true, 2, false, 0, 15, 45, true, true, true) = 'recover';
  assert private.project_task_alert_decision(true, 2, false, 0, 10, 120, false, false, false) = 'ok';
  -- لا تقرير إطلاقاً: عطل مؤكَّد
  assert private.project_task_alert_decision(false, null, false, 0, 10, 120, false, false, false) = 'open';
  -- تراكم status≠ok: يلزم استمرار حتى التأكيد
  assert private.project_task_alert_decision(true, 1, true, 30, 10, 120, false, false, false) = 'track';
  assert private.project_task_alert_decision(true, 1, true, 120, 10, 120, false, false, false) = 'open';
  raise notice 'project_task_alert_decision: all assertions passed';
end $$;
