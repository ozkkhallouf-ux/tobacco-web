-- Central health monitoring for OZK project sync sources and Supabase cron jobs.
-- Applied live on 2026-08-23. Safe to rerun.
create schema if not exists private;

create table if not exists private.project_task_monitors (
  task_key text primary key,
  task_label text not null,
  report_source text not null unique,
  max_age_minutes integer not null check (max_age_minutes between 5 and 10080),
  enabled boolean not null default true,
  -- Codex P1، 2026-08-30، جولة ٤ (khalil-audit PR #139): heartbeat خليل
  -- انتقل إلى جدول مخصّص public.khalil_audit_sync_heartbeat بدل
  -- inventory_reports (انظر migrations/20260830140000_khalil_audit_log.sql
  -- finding b/d). أضيف هذا العمود ليدعم المراقب قراءة آخر created_at من أي
  -- جدول مخصّص بلا فلترة source (الجدول نفسه مخصّص لمصدر واحد)، مع إبقاء
  -- السلوك الافتراضي (inventory_reports + فلترة source) لبقية الصفوف.
  source_table text not null default 'inventory_reports',
  -- Codex P1، 2026-08-30، جولة ٥ (khalil-audit PR #139): heartbeat يمكن أن
  -- يكون حديثاً زمنياً (created_at ضمن max_age_minutes) لكن يحمل status
  -- غير "ok" — مثلاً "backlog" حين تُعيد push-khalil-audit-log.ps1 دفعة
  -- كاملة (== BatchSize) فيرجَّح وجود صفوف أخرى خلف الـcursor لم تُعالَج
  -- بعد. الاعتماد على حداثة created_at وحدها (كما كان سابقاً) كان يعتبر
  -- هذه الحالة "سليمة" رغم تراكم متزايد بصمت. check_status=true يجعل
  -- monitor_project_tasks() يقرأ آخر status من الجدول المخصّص وينبّه إن لم
  -- يكن "ok"، حتى لو كان حديثاً. القيمة الافتراضية false تُبقي بقية الصفوف
  -- (بلا عمود status أصلاً) بسلوكها القديم بلا أي تغيير.
  check_status boolean not null default false
);

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_monitors' and column_name='source_table'
  ) then
    alter table private.project_task_monitors add column source_table text not null default 'inventory_reports';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_monitors' and column_name='check_status'
  ) then
    alter table private.project_task_monitors add column check_status boolean not null default false;
  end if;
end $$;

create table if not exists private.project_task_health_state (
  task_key text primary key,
  is_healthy boolean,
  last_observed_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_alert_at timestamptz,
  last_detail text
);

insert into private.project_task_monitors(task_key,task_label,report_source,max_age_minutes,enabled,source_table) values
 ('ameen-main','مزامنة أمين الرئيسية','ameen_sql_agent',10,true,'inventory_reports'),
 ('customer-balances','أرصدة الزبائن','ameen_customer_balances',10,true,'inventory_reports'),
 ('customer-movements','حركات الزبائن','ameen_customer_movements',30,true,'inventory_reports'),
 ('customer-invoices','فواتير الزبائن','ameen_customer_invoices',90,true,'inventory_reports'),
 ('daily-profit','الربح اليومي','ameen_daily_profit',15,true,'inventory_reports'),
 ('price-sync','مزامنة الأسعار','ameen_price_sync_status',30,true,'inventory_reports'),
 ('invoice-series','سلاسل الفواتير','ameen_invoice_series',30,true,'inventory_reports'),
 ('item-details','تفاصيل المواد','ameen_item_details',480,true,'inventory_reports'),
 -- Codex P1، 2026-08-30، جولة ٣: tools/push-khalil-audit-log.ps1 لم يكن له
 -- أي heartbeat — لو توقفت مهمة "TOBACCO Khalil Audit Sync" (معطّلة/محذوفة/
 -- الجهاز مطفأ) لا آلية سابقة كانت تكتشف ذلك. المهمة تعمل كل دقيقتين، هامش
 -- 10 دقائق كافٍ لتفادي إنذار كاذب من تأخير عابر مع كشف التوقف الحقيقي بسرعة.
 -- جولة ٤: الـheartbeat انتقل لجدول مخصّص khalil_audit_sync_heartbeat
 -- (source_table)، فلم يعد report_source يُستخدم للفلترة هنا، فقط كتسمية.
 ('khalil-audit','مزامنة تدقيق خليل','khalil_audit_sync_heartbeat',10,true,'khalil_audit_sync_heartbeat')
on conflict(task_key) do update set task_label=excluded.task_label,report_source=excluded.report_source,
 max_age_minutes=excluded.max_age_minutes,enabled=excluded.enabled,source_table=excluded.source_table;

-- جولة ٥: تفعيل فحص status لصف خليل تحديداً (انظر تعليق العمود أعلاه) —
-- تحديث منفصل بدل إضافته لقائمة insert...on conflict فوق كي لا يُعاد ضبط
-- بقية الصفوف check_status=false في كل إعادة تشغيل (وهي بالفعل القيمة
-- الافتراضية الصحيحة لها، لكن الوضوح أفضل من الاعتماد الضمني).
update private.project_task_monitors set check_status=true where task_key='khalil-audit';

create or replace function private.monitor_project_tasks()
returns void language plpgsql security definer
set search_path=private,public,cron,pg_temp
as $$
declare cfg record; last_at timestamptz; age_minutes numeric; last_status text; is_backlogged boolean;
 previous_healthy boolean; previous_alert_at timestamptz; detail_text text;
 job_record record; last_job_status text; last_job_at timestamptz;
begin
 for cfg in select * from private.project_task_monitors where enabled order by task_key loop
  -- جولة ٤: source_table='inventory_reports' (الافتراضي) يبقي السلوك
  -- القديم كما هو (فلترة بعمود source داخل الجدول المشترك). أي قيمة أخرى
  -- تعني جدولاً مخصّصاً بمصدر واحد فقط (مثل khalil_audit_sync_heartbeat)،
  -- فلا حاجة لفلترة source هناك أصلاً.
  last_status:=null;
  if cfg.source_table = 'inventory_reports' then
   select max(created_at) into last_at from public.inventory_reports where source=cfg.report_source;
  else
   execute format('select max(created_at) from public.%I', cfg.source_table) into last_at;
   -- جولة ٥: heartbeat حديث زمنياً لا يعني بالضرورة "سليم" — status آخر
   -- صف قد يكون "backlog" (دفعة كاملة == BatchSize، انظر تعليق العمود
   -- check_status أعلاه). فحص إضافي فقط للجداول المخصّصة التي طلبت ذلك.
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
  if not job_record.active or(last_job_status is not null and last_job_status<>'succeeded') then
   detail_text:=case when not job_record.active then 'المهمة معطلة'
    else format('آخر تشغيل: %s عند %s',last_job_status,to_char(last_job_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI')) end;
   select is_healthy,last_alert_at into previous_healthy,previous_alert_at
    from private.project_task_health_state where task_key='cron:'||job_record.jobname;
   if previous_healthy is distinct from false or previous_alert_at is null or previous_alert_at<now()-interval '60 minutes' then
    perform public.notify_telegram('project_task_failure',
     format('🚨 توقفت مهمة داخل الموقع%1$s• المهمة: %2$s%1$s• الحالة: %3$s',chr(10),job_record.jobname,detail_text),
     'project-cron-failure:'||job_record.jobname,60);
    previous_alert_at:=now();
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_alert_at,last_detail)
    values('cron:'||job_record.jobname,false,now(),previous_alert_at,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_alert_at=excluded.last_alert_at,last_detail=excluded.last_detail;
  else
   select is_healthy into previous_healthy from private.project_task_health_state where task_key='cron:'||job_record.jobname;
   if previous_healthy=false then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت مهمة الموقع للعمل%1$s• المهمة: %2$s',chr(10),job_record.jobname),
     'project-cron-recovered:'||job_record.jobname||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail)
    values('cron:'||job_record.jobname,true,now(),last_job_at,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,last_alert_at=null,last_detail='يعمل';
  end if;
 end loop;
end $$;

revoke all on function private.monitor_project_tasks() from public,anon,authenticated;
revoke all on table private.project_task_monitors from public,anon,authenticated;
revoke all on table private.project_task_health_state from public,anon,authenticated;

do $$ declare old_job bigint; begin
 for old_job in select jobid from cron.job where jobname='monitor-project-tasks'
 loop perform cron.unschedule(old_job); end loop;
 perform cron.schedule('monitor-project-tasks','*/5 * * * *','select private.monitor_project_tasks();');
end $$;
