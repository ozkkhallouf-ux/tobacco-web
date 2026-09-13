-- ============================================================================
-- مقترح غير مُطبَّق — لا يلمس هذا الملف الإنتاج بذاته. يعالج ملاحظة Codex P1
-- جديدة على PR #220 فوق 07 (مقترح، غير مطبَّق أيضاً — راجع
-- supabase/proposed/README.md)، ولا يُعدِّل 04/05/06 المطبَّقة تاريخياً ولا
-- يُعيد تطبيقها، ولا يُعدِّل 07 نفسه (يبقى كما هو، غير مطبَّق).
--
-- خلافاً لـ07 (idempotent بالكامل بلا أي DDL)، هذا الملف يحتاج DDL فعلي —
-- عمود جديد `last_alerted_health_since` على private.project_task_health_state
-- — لأن الإصلاح المطلوب لا يمكن حله بمنطق الدالة وحده. لهذا صار 08 مستقلاً
-- بدل تعديل 07 في مكانه.
--
-- supabase/project-task-health-monitor.sql — private.monitor_project_tasks():
-- 07 جعلت مفتاح dedupe لحالتَي 'stuck'/'disabled' يتضمن job_health (التصنيف
-- وحده)، فحلّت انتقالاً حقيقياً بين تصنيفين (مثلاً stuck⇒disabled) لأن كل
-- تصنيف صار له مساحة dedupe مستقلة. لكنها لم تحلّ عودة *نفس* التصنيف مرتين
-- خلال أقل من 60 دقيقة: تسلسل stuck⇒disabled⇒stuck خلال أقل من 60 دقيقة —
-- الانتقال الثالث (العودة إلى stuck) يستوفي should_alert (بفضل شرط
-- previous_alerted_health is distinct from job_health في 06)، لكنه يبني نفس
-- مفتاح "project-cron-failure:<job>:stuck" الذي أدرجه notify_telegram قبل
-- لحظات ضمن نافذة الـ60 دقيقة نفسها للحادثة الأولى (stuck الأولى) — فيُسقَط
-- الإنذار الثالث صامتاً رغم أن should_alert صحيح، ثم previous_alert_at/
-- previous_alerted_health تُحدَّث خطأً كأن الإرسال نجح فعلاً.
--
-- الإصلاح: عمود جديد last_alerted_health_since يسجّل لحظة الدخول الفعلي
-- إلى التصنيف الحالي (لا وقت الإنذار وحده)، ويصبح جزءاً من مفتاح الـdedupe
-- لحالتَي 'stuck'/'disabled':
--   project-cron-failure:<job>:<job_health>:<health_incident_since>
-- كل انتقال حقيقي بين تصنيفين (previous_alerted_health مختلف) يحصل على
-- health_incident_since=now() فمفتاح جديد تماماً — حتى لو كان التصنيف نفسه
-- قد أُنذر عنه من قبل خلال الساعة الماضية. أما استمرار نفس التصنيف (تذكير
-- دوري لاحق، لا transition) فيُبقي health_incident_since كما كانت
-- (coalesce(previous_alerted_health_since, now())) فيبقى نفس المفتاح ويعمل
-- التذكير الدوري الساعي الأصلي بلا أي تغيير في مهلته أو semantics الـdedupe.
-- 'failed' لا تتأثر إطلاقاً: مفتاحها مبني على terminal_at (05) لا على
-- job_health/health_incident_since، ويبقى كما هو بلا تغيير.
--
-- ملاحظة مهمة: هذا الإصلاح (مثل 05/06/07) لا يعتمد على استثناء notify_telegram
-- لمعرفة نجاح الإرسال — notify_telegram/notify_telegram_dispatch يمكن أن
-- يُسقطا الإرسال بصمت (dedupe hit) بلا رمي أي استثناء، وهذا بالضبط ما يعالجه
-- تفرّد المفتاح لكل حادثة انتقال بدل الاعتماد على begin...exception فقط.
--
-- هذا الملف نسخة كاملة مطابقة لما في supabase/project-task-health-monitor.sql
-- الحالي (canonical) — لا فرق متعمَّد بين هذا الملف وذاك بعد تطبيقه.
-- ============================================================================

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_health_state' and column_name='last_alerted_health_since'
  ) then
    alter table private.project_task_health_state add column if not exists last_alerted_health_since timestamptz;
  end if;
end $$;

create or replace function private.monitor_project_tasks()
returns void language plpgsql security definer
set search_path=private,public,cron,pg_temp
as $$
declare cfg record; last_at timestamptz; age_minutes numeric; last_status text; is_backlogged boolean;
 previous_healthy boolean; previous_alert_at timestamptz; detail_text text;
 job_record record; last_job_status text; last_job_at timestamptz;
 job_health text; cron_grace interval:=interval '10 minutes';
 terminal_status text; terminal_at timestamptz; retry_running boolean;
 previous_alerted_terminal_at timestamptz; should_alert boolean; failure_dedupe_key text;
 previous_alerted_health text;
 -- proposed/08: هوية incident لكل حادثة انتقال فعلي بين تصنيفَي stuck/disabled
 -- (راجع تعليق عمود last_alerted_health_since أعلاه).
 previous_alerted_health_since timestamptz; health_incident_since timestamptz;
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
    begin
     perform public.notify_telegram('project_task_failure',
      format('🚨 توقفت مهمة بالمشروع%1$s• المهمة: %2$s%1$s• المصدر: %3$s%1$s• الحالة: %4$s%1$s• الحد المسموح: %5$s دقيقة',
       chr(10),cfg.task_label,cfg.report_source,detail_text,cfg.max_age_minutes),
      'project-task-failure:'||cfg.task_key,60);
     previous_alert_at:=now();
    exception when others then
     raise warning 'monitor_project_tasks: notify_telegram failed for %: %',cfg.task_key,sqlerrm;
    end;
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
   select is_healthy,last_alert_at,last_alerted_terminal_at,last_alerted_health,last_alerted_health_since
    into previous_healthy,previous_alert_at,previous_alerted_terminal_at,previous_alerted_health,previous_alerted_health_since
    from private.project_task_health_state where task_key='cron:'||job_record.jobname;

   if job_health='failed' then
    should_alert:=previous_healthy is distinct from false or previous_alert_at is null
     or previous_alerted_terminal_at is distinct from terminal_at;
   else
    should_alert:=previous_healthy is distinct from false or previous_alert_at is null
     or previous_alert_at<now()-interval '60 minutes'
     or previous_alerted_health is distinct from job_health;
   end if;

   if should_alert then
    if job_health='failed' then
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||to_char(terminal_at,'YYYYMMDDHH24MISS');
    else
     -- proposed/08: راجع تعليق الرأس أعلاه للتفصيل الكامل — health_incident_since
     -- يميّز كل حادثة انتقال فعلي عن مجرد استمرار نفس التصنيف.
     if previous_alerted_health is distinct from job_health then
      health_incident_since:=now();
     else
      health_incident_since:=coalesce(previous_alerted_health_since,now());
     end if;
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||job_health||':'||to_char(health_incident_since,'YYYYMMDDHH24MISSMS');
    end if;
    begin
     perform public.notify_telegram('project_task_failure',
      format('🚨 توقفت مهمة داخل الموقع%1$s• المهمة: %2$s%1$s• الحالة: %3$s',chr(10),job_record.jobname,detail_text),
      failure_dedupe_key,60);
     previous_alert_at:=now();
     if job_health='failed' then
      previous_alerted_terminal_at:=terminal_at;
      previous_alerted_health_since:=null;
     else
      previous_alerted_health_since:=health_incident_since;
     end if;
     previous_alerted_health:=job_health;
    exception when others then
     raise warning 'monitor_project_tasks: notify_telegram failed for cron:%: %',job_record.jobname,sqlerrm;
    end;
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_alert_at,last_alerted_terminal_at,last_alerted_health,last_alerted_health_since,last_detail)
    values('cron:'||job_record.jobname,false,now(),previous_alert_at,previous_alerted_terminal_at,previous_alerted_health,previous_alerted_health_since,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_alert_at=excluded.last_alert_at,
     last_alerted_terminal_at=excluded.last_alerted_terminal_at,last_alerted_health=excluded.last_alerted_health,
     last_alerted_health_since=excluded.last_alerted_health_since,
     last_detail=excluded.last_detail;
  elsif job_health = 'ok' then
   select is_healthy into previous_healthy from private.project_task_health_state where task_key='cron:'||job_record.jobname;
   if previous_healthy=false then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت مهمة الموقع للعمل%1$s• المهمة: %2$s',chr(10),job_record.jobname),
     'project-cron-recovered:'||job_record.jobname||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_alerted_terminal_at,last_alerted_health,last_alerted_health_since,last_detail)
    values('cron:'||job_record.jobname,true,now(),terminal_at,null,null,null,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,
     last_alert_at=null,last_alerted_terminal_at=null,last_alerted_health=null,last_alerted_health_since=null,last_detail='يعمل';
  else
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_detail)
    values('cron:'||job_record.jobname,null,now(),
     case when job_health='never_run' then 'لم تُشغَّل بعد' else 'قيد التنفيذ' end)
    on conflict(task_key) do update set last_observed_at=now();
  end if;
 end loop;
end $$;

revoke all on function private.monitor_project_tasks() from public,anon,authenticated;
