-- ============================================================================
-- مقترح غير مُطبَّق — لا يلمس هذا الملف الإنتاج بذاته. ينفّذ ثلاث ملاحظات
-- Codex P1 من الجولة الثانية على PR #220 فوق 04+05 (المطبَّقتين فعلاً على
-- الإنتاج، راجع supabase/proposed/README.md)، ولا يُعدِّل أياً منهما ولا
-- يُعيد تطبيقهما. الملف idempotent بالكامل (CREATE OR REPLACE FUNCTION فقط،
-- بلا أي DDL على جدول أو DML على بيانات) ولا يمسّ جدولة أي مهمة cron.
--
-- (١) supabase/project-task-health-monitor.sql:340 — private.cron_job_health():
--     فرع 'failed' كان يسبق فحص 'stuck' بلا استثناء، فـretry جديد بدأ فعلاً
--     بعد فشل نهائي سابق لنفس المهمة، وتجاوز مهلة stuck (p_grace) دون أن
--     يُحسم بعد، كان يبقى مصنَّفاً 'failed' القديم ولا يأخذ التذكير الدوري
--     لحالة 'stuck' الحيّة الفعلية. الإصلاح: فرع 'failed' يستثني الآن صراحةً
--     الحالة التي يكون فيها آخر تشغيل مطلق (p_latest_status) قيد التنفيذ فعلاً
--     ومتجاوزاً p_grace — تلك الحالة تسقط إلى فرع 'stuck' بدلاً من ذلك. لا
--     تغيير على فرعي 'disabled'/'ok'/'inflight'/'never_run'.
--
-- (٢) و(٣) supabase/project-task-health-monitor.sql:289،362 —
--     private.monitor_project_tasks(): previous_alert_at/previous_alerted_terminal_at
--     كانا يُسجَّلان بلا شرط بعد استدعاء notify_telegram في كلتا الحلقتين
--     (project_task_monitors وcron.job)، فأي استثناء أثناء الإرسال (رفض
--     تفويض، خطأ اتصال بقاعدة البيانات أثناء الإدراج في telegram_outbox) كان
--     يُحسب "تم التنبيه" رغم عدم قبول الرسالة للإرسال أصلاً — فيضيع الإنذار
--     الوحيد لحادثة فشل (dedupe بـterminal_at لا يتكرر). العقد الفعلي لـ
--     notify_telegram/notify_telegram_dispatch (راجع supabase/telegram-
--     notifications.sql) هو إدراج غير متزامن بطابور telegram_outbox — التسليم
--     الحقيقي إلى Telegram يجري لاحقاً وبشكل غير متزامن عبر
--     dispatch_telegram_outbox، ولا يمكن تأكيده مزامنةً هنا. فـ"القبول الفعلي
--     للإرسال وفق العقد الحالي" هو نجاح هذا الإدراج بلا استثناء. الإصلاح: كل
--     استدعاء notify_telegram في الحلقتين مُغلَّف الآن بـ
--     begin...exception when others then raise warning...end; مع نقل تحديث
--     previous_alert_at (وprevious_alerted_terminal_at بفرع 'failed') إلى
--     داخل مسار النجاح فقط؛ عند فشل الإدراج تبقى القيمتان كما وردتا من
--     health_state المحفوظة فيبقى should_alert صحيحاً بالدورة التالية
--     فيُعاد الإرسال تلقائياً بلا loop سريع ولا spam (المهلة الدورية الأصلية
--     60 دقيقة لم تتغيّر).
--
-- كلا الملفين نُسخة كاملة مطابقة لما في supabase/project-task-health-monitor.sql
-- الحالي (canonical) — لا فرق متعمَّد بين هذا الملف وذاك بعد تطبيقه.
-- ============================================================================

create or replace function private.cron_job_health(
  p_active boolean,
  p_latest_status text,
  p_latest_at timestamptz,
  p_terminal_status text,
  p_terminal_at timestamptz,
  p_grace interval default interval '10 minutes',
  p_now timestamptz default now()
) returns text language sql immutable parallel safe as $fn$
  select case
    -- التعطيل يسبق كل شيء: هو العنوان مهما كانت آخر حالة تشغيل. و«ليس true»
    -- تشمل NULL عمداً — حالة مجهولة النشاط تُعامل معاملة المعطّلة لا المُهمَلة.
    when p_active is not true then 'disabled'

    -- الفشل النهائي حقيقة مكتملة، ولا تسقط لمجرد أن محاولة جديدة بدأت فوقها —
    -- ما لم تكن تلك المحاولة نفسها قد تجاوزت المهلة الآن (راجع شرط الاستثناء
    -- أدناه، طابق شرط 'stuck'). هذا هو جوهر إصلاح ملاحظة Codex P1 الثانية
    -- (الجولة الثانية): retry جديد عالق بعد فشل سابق يجب أن يظهر 'stuck' —
    -- الحالة الحيّة الحقيقية الآن — لا 'failed' القديم الذي لم يعد يعكس واقع
    -- المحاولة الجارية.
    when p_terminal_status = 'failed'
     and not (
       p_latest_status is not null
       and p_latest_status not in ('succeeded','failed')
       and (p_latest_at is null or p_now - p_latest_at >= p_grace)
     )
    then 'failed'

    -- محاولة جارية تجاوزت المهلة (أو حالة مجهولة لا نستطيع إثبات حداثتها)
    -- ⇒ جمود يستحق الإنذار. تُفحص فعلياً ضمن استثناء 'failed' أعلاه أيضاً،
    -- فأي retry عالق بعد فشل سابق يصل هنا لا إلى 'failed'.
    when p_latest_status is not null
     and p_latest_status not in ('succeeded','failed')
     and (p_latest_at is null or p_now - p_latest_at >= p_grace) then 'stuck'

    -- نجاح نهائي: شهادة السلامة الوحيدة. محاولة جارية فوقه لا تُلغيه ولا
    -- تُرقّيه — الحكم يبقى على آخر نتيجة مكتملة.
    when p_terminal_status = 'succeeded' then 'ok'

    -- لا نتيجة مكتملة قط: إمّا محاولة أولى ما زالت تعمل، أو لم تُشغَّل بعد.
    -- كلتاهما محايدة: لا إنذار ولا شهادة نجاح.
    when p_latest_status is not null then 'inflight'
    else 'never_run'
  end;
$fn$;

revoke all on function private.cron_job_health(boolean,text,timestamptz,text,timestamptz,interval,timestamptz)
  from public,anon,authenticated;

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
    -- Codex P1 (PR #220، الملاحظة الثالثة): previous_alert_at:=now() كان يُسجَّل
    -- بلا شرط بعد استدعاء notify_telegram، فأي استثناء أثناء الإرسال (رفض
    -- تفويض، خطأ اتصال بقاعدة البيانات) كان يُحسب "تم التنبيه" رغم عدم قبول
    -- الرسالة للإرسال أصلاً. notify_telegram/notify_telegram_dispatch عقدهما
    -- الفعلي إدراج غير متزامن بطابور telegram_outbox (التسليم الحقيقي إلى
    -- Telegram يجري لاحقاً وبشكل غير متزامن عبر dispatch_telegram_outbox،
    -- ولا يمكن تأكيده مزامنةً هنا) — فـ"القبول الفعلي للإرسال وفق العقد
    -- الحالي" هو نجاح هذا الإدراج بلا استثناء. عند فشله نُبقي previous_alert_at
    -- كما كان (null أو قديم) فتُعاد المحاولة بالدورة التالية تلقائياً.
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
   select is_healthy,last_alert_at,last_alerted_terminal_at into previous_healthy,previous_alert_at,previous_alerted_terminal_at
    from private.project_task_health_state where task_key='cron:'||job_record.jobname;

   if job_health='failed' then
    should_alert:=previous_healthy is distinct from false or previous_alert_at is null
     or previous_alerted_terminal_at is distinct from terminal_at;
   else
    should_alert:=previous_healthy is distinct from false or previous_alert_at is null
     or previous_alert_at<now()-interval '60 minutes';
   end if;

   if should_alert then
    if job_health='failed' then
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||to_char(terminal_at,'YYYYMMDDHH24MISS');
    else
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname;
    end if;
    -- Codex P1 (PR #220، الملاحظة الثانية): previous_alert_at/previous_alerted_terminal_at
    -- كانا يُسجَّلان بلا شرط بعد notify_telegram، فيضيع إنذار 'failed' الوحيد
    -- (dedupe بـterminal_at لا يتكرر) إن فشل الإرسال باستثناء. نفس التبرير
    -- المذكور أعلاه في حلقة project_task_monitors: القبول الفعلي للإرسال هنا
    -- هو نجاح إدراج notify_telegram بلا استثناء؛ عند الفشل نُبقي القيمتين
    -- كما وردتا من الحالة المحفوظة (previous_healthy/select أعلاه) فيبقى
    -- should_alert صحيحاً بالدورة التالية ويُعاد الإرسال.
    begin
     perform public.notify_telegram('project_task_failure',
      format('🚨 توقفت مهمة داخل الموقع%1$s• المهمة: %2$s%1$s• الحالة: %3$s',chr(10),job_record.jobname,detail_text),
      failure_dedupe_key,60);
     previous_alert_at:=now();
     if job_health='failed' then previous_alerted_terminal_at:=terminal_at; end if;
    exception when others then
     raise warning 'monitor_project_tasks: notify_telegram failed for cron:%: %',job_record.jobname,sqlerrm;
    end;
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
