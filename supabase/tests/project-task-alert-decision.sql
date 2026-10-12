-- جدول حقيقة private.project_task_alert_decision (proposed/10) — تقييم خالص،
-- لا يقرأ ولا يكتب أي جدول. التشغيل:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/project-task-alert-decision.sql
-- المعاملات: has_report, age, backlogged, fault_min, max_age, alert_after, alerted, since_alert, reminder
do $$
declare t constant text := 'project_task_alert_decision';
begin
  -- سليم
  assert private.project_task_alert_decision(true, 5, false, 0, 10, 120, false, null) = 'ok';
  -- تأخر 10–30 دقيقة: تسجيل فقط
  assert private.project_task_alert_decision(true, 15, false, 5, 10, 120, false, null) = 'log';
  assert private.project_task_alert_decision(true, 33.9, false, 30, 30, 180, false, null) = 'log';
  -- 1–2 ساعة دون حدّ التنبيه: ما زال تسجيلاً
  assert private.project_task_alert_decision(true, 119.9, false, 100, 10, 120, false, null) = 'log';
  -- الحدّ نفسه = تنبيه
  assert private.project_task_alert_decision(true, 120, false, 110, 10, 120, false, null) = 'alert';
  -- تكرار: لا رسالة ثانية، ولا قبل 6 ساعات
  assert private.project_task_alert_decision(true, 300, false, 290, 10, 120, true, 10) = 'hold';
  assert private.project_task_alert_decision(true, 300, false, 290, 10, 120, true, 359.9) = 'hold';
  assert private.project_task_alert_decision(true, 300, false, 290, 10, 120, true, 360) = 'remind';
  -- تعافٍ: رسالة فقط إن أُنذر عنه
  assert private.project_task_alert_decision(true, 2, false, 0, 10, 120, true, 50) = 'recover';
  assert private.project_task_alert_decision(true, 2, false, 0, 10, 120, false, null) = 'ok';
  -- لا تقرير إطلاقاً
  assert private.project_task_alert_decision(false, null, false, 0, 10, 120, false, null) = 'alert';
  -- تراكم status≠ok: يلزم استمرار
  assert private.project_task_alert_decision(true, 1, true, 30, 10, 120, false, null) = 'log';
  assert private.project_task_alert_decision(true, 1, true, 120, 10, 120, false, null) = 'alert';
  raise notice 'project_task_alert_decision: all assertions passed';
end $$;
