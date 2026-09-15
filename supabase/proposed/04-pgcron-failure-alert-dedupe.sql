-- ============================================================================
-- تحديث حالة (PR #220): هذا الملف مطبَّق فعلاً على الإنتاج — تحقّق منه عبر
-- cron.job_run_details وسجلّ الدالة الفعلية private.monitor_project_tasks()
-- على قاعدة dyxbirfpxeocqffnfdeb. راجع وصف PR #220 لتفاصيل التحقق والتاريخ
-- الدقيق. هذا الملف لا يُعدَّل ولا يُعاد تطبيقه بعد اليوم؛ أي إصلاح إضافي
-- (كمفتاح dedupe الثابت أو تهيئة last_alerted_terminal_at الموروثة) ينتقل
-- إلى ترحيل تكميلي منفصل: supabase/proposed/05-pgcron-failure-event-dedupe-fix.sql.
-- النص أدناه يوثّق النسخة *الأصلية* كما كُتبت وقت اقتراحها؛ عُدِّل هنا لغوياً
-- فقط ليعكس أنها الآن مُطبَّقة، دون أي تغيير في المنطق أو الشيفرة.
--
-- (توثيق أصلي وقت الاقتراح، لا يزال دقيقاً منطقياً):
--
-- العطل المُبلَّغ عنه (2026-09-10/11): إنذارات كاذبة متكررة على
-- ozk-collection-followups وsend-morning-report — مهمتان يوميتان. تحقّق فعلي
-- في cron.job_run_details أثبت أن فشل 2026-09-10 كان محاولة واحدة انتهت
-- ("job startup timeout")، لا توقفاً فعلياً مستمراً. المشكلة أن
-- private.monitor_project_tasks() (النسخة الحالية في project-task-health-monitor.sql،
-- السطور ~296-320) تُعامل أي فشل نهائي مُصنَّف 'failed' بواسطة
-- private.cron_job_health() بنفس حارس التذكير الدوري المستخدم للحالات
-- الحيّة (stuck/disabled): previous_alert_at<now()-interval '60 minutes'.
-- ولأن terminal_at لا يتغيّر (المهمة يومية، لا تشغيل تالٍ إلا غداً)، تبقى
-- job_health='failed' طوال اليوم فيُعاد نفس التنبيه كل ساعة بلا أي حدث جديد.
--
-- التمييز المطلوب (بلا إخفاء فشل حقيقي):
--   A) فشل حديث يستحق إنذاراً                                  ⇒ يُنذَر (كالسابق)
--   B) حادثة أُنذر عنها سابقاً وانتهت، بلا محاولة جديدة         ⇒ لا تكرار الآن (هذا الإصلاح)
--   C) مهمة متأخرة فعلاً عن موعدها التالي (محاولة جارية تجاوزت المهلة) ⇒ تبقى تُنذَر
--      دورياً — 'stuck' حالة جارية لم "تنتهِ" فعلياً، لا حادثة مغلقة.
--   D) فشل متكرر عبر تشغيلات متعددة                            ⇒ لا يُخفى: كل failed
--      جديد بـterminal_at مختلف يُنذَر مجدداً بصرف النظر عن الساعة الزمنية.
--   E) نجاح لاحق بعد فشل = "تعافٍ"                              ⇒ لا تغيير (كان صحيحاً أصلاً،
--      مبني على job_health='ok' لا على مرور الوقت).
--   F) انقطاع عام مؤقت والتشغيلة التالية لم يحن موعدها بعد        ⇒ نفس آلية (B): بلا محاولة
--      جديدة لا تكرار.
--
-- الآلية: عمود جديد last_alerted_terminal_at يحفظ *أي فشل نهائي بعينه* أُنذر
-- عنه آخر مرة. لحالة job_health='failed' تحديداً، الإنذار يتكرر فقط حين تتغيّر
-- terminal_at عن آخر قيمة أُنذر عنها (فشل جديد فعلاً) — لا لمجرد مرور ستين
-- دقيقة. أمّا 'stuck' و'disabled' فتُبقيان على الحارس الزمني القديم كما هو،
-- لأنهما حالتان جاريتان لم "تنتهِ" بعد (اسمياً "قيد الحدوث الآن")، والتذكير
-- الدوري لهما بقصد لا عطل — هذا مثبَّت ومختبَر في
-- supabase/tests/cron-job-health-transitions.sql (سيناريو ٧: "التذكير الدوري
-- ما زال قادراً على العمل" — يبقى صحيحاً لـstuck تحديداً بعد هذا الإصلاح).
--
-- لماذا هذا لا يكرر عطل المحاولة الرابعة المرفوضة (Codex P1 على PR #154):
-- ذلك الإصلاح كان يُقدِّم previous_alert_at:=now() بلا شرط مستقل، فيصطدم
-- بمهلة dedupe الخاصة بطبقة telegram_outbox (project-cron-failure:<job>,
-- 60 دقيقة) ويُصفِّر ساعة *التذكير الدوري نفسها* دون أن تصل الرسالة فعلاً —
-- فيتأجّل التذكير الدوري لحالة لم تُبلَّغ. هنا العمود الجديد مستقل تماماً عن
-- previous_alert_at ولا يُلغي أي تذكير دوري قائم: 'stuck'/'disabled' لا يمسّان
-- last_alerted_terminal_at إطلاقاً وحارسهما الزمني لا يتغيّر. الفصل بين "هل
-- الحالة صحية" (هذا الملف) و"هل الرسالة نفسها وصلت" (طبقة outbox) يبقى كما هو
-- موثَّق أصلاً في تعليقات monitor_project_tasks().
--
-- الاختبار: supabase/tests/cron-job-health-transitions.sql (مستقل،
-- pg_temp فقط، لا يمسّ أي جدول إنتاج، لا يحتاج تطبيق هذا الملف لتشغيله).
--
-- التطبيق: هذا الملف كامل idempotent (ALTER ... ADD COLUMN IF NOT EXISTS +
-- CREATE OR REPLACE FUNCTION) وآمن لإعادة التشغيل. **مطبَّق فعلاً على
-- الإنتاج الآن (PR #220)** — راجع الأعلى.
--
-- ملاحظتان اكتُشفتا لاحقاً في مراجعة PR #220 بعد التطبيق (معالجتان في 05،
-- لا هنا):
--   1) مفتاح dedupe لإنذار 'failed' (أدناه) ثابت باسم المهمة فقط، بلا
--      terminal_at — قد يُسقط طبقة telegram_outbox صمتاً إنذار فشل جديد يقع
--      خلال 60 دقيقة من فشل سابق لنفس المهمة، رغم أن هذا الملف نفسه يُقدِّم
--      previous_alerted_terminal_at بلا شرط نجاح الإرسال الفعلي.
--   2) عمود last_alerted_terminal_at الجديد (أدناه) بلا قيمة ابتدائية —
--      لأي صف كان already-failed وقت هذا التطبيق، أول دورة بعده تُنذر مرة
--      واحدة تكراراً كاذباً لأن العمود NULL.
-- ============================================================================

alter table private.project_task_health_state
  add column if not exists last_alerted_terminal_at timestamptz;

create or replace function private.monitor_project_tasks()
returns void language plpgsql security definer
set search_path=private,public,cron,pg_temp
as $$
declare cfg record; last_at timestamptz; age_minutes numeric; last_status text; is_backlogged boolean;
 previous_healthy boolean; previous_alert_at timestamptz; detail_text text;
 job_record record; last_job_status text; last_job_at timestamptz;
 job_health text; cron_grace interval:=interval '10 minutes';
 terminal_status text; terminal_at timestamptz; retry_running boolean;
 previous_alerted_terminal_at timestamptz; should_alert boolean;
begin
 for cfg in select * from private.project_task_monitors where enabled order by task_key loop
  last_status:=null;
  if cfg.source_table = 'inventory_reports' then
   select max(created_at) into last_at from public.inventory_reports where source=cfg.report_source;
  else
   execute format('select max(created_at) from public.%I', cfg.source_table) into last_at;
   if cfg.check_status then
    execute format('select status from public.%I order by created_at desc limit 1', cfg.source_table) into last_status;
   end if;
  end if;
  age_minutes:=case when last_at is null then null else round(extract(epoch from(now()-last_at))/60.0,1) end;
  is_backlogged:=last_status is not null and last_status<>'ok';
  select is_healthy,last_alert_at into previous_healthy,previous_alert_at
    from private.project_task_health_state where task_key=cfg.task_key;

  if last_at is null or last_at<now()-make_interval(mins=>cfg.max_age_minutes) or is_backlogged then
   detail_text:=case
    when last_at is null then 'لم يصل أي تقرير حتى الآن'
    when last_at<now()-make_interval(mins=>cfg.max_age_minutes) then
     format('آخر نجاح منذ %s دقيقة عند %s',age_minutes,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'))
    else
     format('تراكم محتمل (status=%s) — آخر دفعة كاملة عند %s',last_status,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'))
    end;
   if previous_healthy is distinct from false or previous_alert_at is null or previous_alert_at<now()-interval '60 minutes' then
    perform public.notify_telegram('project_task_failure',
     format('🚨 توقفت مهمة بالمشروع%1$s• المهمة: %2$s%1$s• المصدر: %3$s%1$s• الحالة: %4$s%1$s• الحد المسموح: %5$s دقيقة',
      chr(10),cfg.task_label,cfg.report_source,detail_text,cfg.max_age_minutes),
     'project-task-failure:'||cfg.task_key,60);
    previous_alert_at:=now();
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail)
    values(cfg.task_key,false,now(),last_at,previous_alert_at,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_success_at=excluded.last_success_at,
     last_alert_at=excluded.last_alert_at,last_detail=excluded.last_detail;
  else
   if previous_healthy=false then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت المهمة للعمل%1$s• المهمة: %2$s%1$s• المصدر: %3$s%1$s• آخر نجاح: %4$s',
      chr(10),cfg.task_label,cfg.report_source,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI')),
     'project-task-recovered:'||cfg.task_key||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail)
    values(cfg.task_key,true,now(),last_at,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,last_alert_at=null,last_detail='يعمل';
  end if;
 end loop;

 for job_record in select jobid,jobname,active from cron.job where jobname<>'monitor-project-tasks' loop
  select status,start_time into last_job_status,last_job_at from cron.job_run_details
   where jobid=job_record.jobid order by start_time desc limit 1;
  select status,start_time into terminal_status,terminal_at from cron.job_run_details
   where jobid=job_record.jobid and status in ('succeeded','failed')
   order by start_time desc limit 1;
  retry_running:=last_job_status is not null and last_job_status not in ('succeeded','failed');
  job_health:=private.cron_job_health(job_record.active,last_job_status,last_job_at,
   terminal_status,terminal_at,cron_grace);
  if job_health in ('disabled','failed','stuck') then
   detail_text:=case job_health
    when 'disabled' then 'المهمة معطلة'
    when 'failed' then format('فشل آخر تشغيل مكتمل عند %s%s',
     coalesce(to_char(terminal_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),'وقت غير معروف'),
     case when retry_running then ' (ومحاولة جارية الآن — لم تُحسم بعد)' else '' end)
    else format('عالقة في حالة %s منذ %s',coalesce(last_job_status,'غير معروفة'),
     coalesce(round(extract(epoch from(now()-last_job_at))/60.0,1)::text||' دقيقة','مدة غير معروفة'))
    end;
   select is_healthy,last_alert_at,last_alerted_terminal_at into previous_healthy,previous_alert_at,previous_alerted_terminal_at
    from private.project_task_health_state where task_key='cron:'||job_record.jobname;

   -- الإصلاح: 'failed' حادثة مكتملة — لا تُنذَر ثانية لمجرد مرور ساعة إن كانت
   -- terminal_at نفسها لم تتغيّر (لا محاولة جديدة). 'stuck'/'disabled' حالتان
   -- جاريتان فتبقيان على الحارس الزمني الأصلي (التذكير الدوري مقصود لهما).
   if job_health='failed' then
    should_alert:=previous_healthy is distinct from false
     or previous_alert_at is null
     or previous_alerted_terminal_at is distinct from terminal_at;
   else
    should_alert:=previous_healthy is distinct from false
     or previous_alert_at is null
     or previous_alert_at<now()-interval '60 minutes';
   end if;

   if should_alert then
    perform public.notify_telegram('project_task_failure',
     format('🚨 توقفت مهمة داخل الموقع%1$s• المهمة: %2$s%1$s• الحالة: %3$s',chr(10),job_record.jobname,detail_text),
     'project-cron-failure:'||job_record.jobname,60);
    previous_alert_at:=now();
    if job_health='failed' then previous_alerted_terminal_at:=terminal_at; end if;
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_alert_at,last_alerted_terminal_at,last_detail)
    values('cron:'||job_record.jobname,false,now(),previous_alert_at,previous_alerted_terminal_at,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_alert_at=excluded.last_alert_at,
     last_alerted_terminal_at=excluded.last_alerted_terminal_at,last_detail=excluded.last_detail;
  elsif job_health = 'ok' then
   select is_healthy into previous_healthy from private.project_task_health_state where task_key='cron:'||job_record.jobname;
   if previous_healthy=false then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت مهمة الموقع للعمل%1$s• المهمة: %2$s',chr(10),job_record.jobname),
     'project-cron-recovered:'||job_record.jobname||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   -- تعافٍ فعلي: تصفير last_alerted_terminal_at أيضاً، كي يُنذَر فشلٌ مقبل
   -- بصرف النظر عن terminal_at القديم الذي كان مؤنذَراً عنه قبل هذا التعافي.
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_alerted_terminal_at,last_detail)
    values('cron:'||job_record.jobname,true,now(),terminal_at,null,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,
     last_alert_at=null,last_alerted_terminal_at=null,last_detail='يعمل';
  else
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_detail)
    values('cron:'||job_record.jobname,null,now(),
     case when job_health='never_run' then 'لم تُشغَّل بعد' else 'قيد التنفيذ' end)
    on conflict(task_key) do update set last_observed_at=now();
  end if;
 end loop;
end $$;

revoke all on function private.monitor_project_tasks() from public,anon,authenticated;
