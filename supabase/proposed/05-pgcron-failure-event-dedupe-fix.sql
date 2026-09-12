-- ============================================================================
-- إصلاح تكميلي فوق 04 — 04 مُطبَّقة على الإنتاج بالفعل (راجع
-- supabase/proposed/README.md وتعليقات 04 نفسها). هذا الملف لا يعيد تطبيق 04
-- ولا يُعدِّل منطقها؛ يضيف فقط ما اكتشفه مراجعو PR #220 (Copilot) من ثغرتين
-- متبقيتين في تصميم 04، وكلتاهما مُتحقَّق منها هنا بالكود لا بالافتراض:
--
-- (١) مفتاح dedupe الثابت لحالة 'failed':
--     04 (السطر ~152) تستدعي:
--       notify_telegram('project_task_failure', ..., 'project-cron-failure:'||jobname, 60)
--     لكل حالات job_health IN ('disabled','failed','stuck') بنفس الصيغة —
--     المفتاح يعتمد على اسم المهمة فقط، بلا أي أثر لهوية الحادثة (terminal_at).
--     طبقة dedupe الفعلية (private.notify_telegram_dispatch في
--     telegram-notifications.sql) تفحص فقط: هل يوجد صف في telegram_outbox
--     بنفس dedupe_key خلال آخر p_dedupe_minutes دقيقة؟ لا علاقة لها بمحتوى
--     الرسالة أو بهوية الحدث. النتيجة الفعلية: فشل حقيقي جديد (terminal_at
--     مختلف) لنفس المهمة خلال أقل من 60 دقيقة من إنذار "failed" سابق لنفس
--     المهمة يُصطدم بنفس المفتاح فتُسقِطه notify_telegram_dispatch بصمت —
--     ورغم ذلك monitor_project_tasks() في 04 يُحدِّث previous_alerted_terminal_at
--     إلى القيمة الجديدة فوراً بعد الـperform (04 سطر 154) دون أي تحقق من أن
--     الرسالة أُدرجت فعلاً في telegram_outbox (notify_telegram ترجع void ولا
--     تُخبر المستدعي بنجاح الإدراج من عدمه). العطل إذن ليس مجرد تأخير، بل
--     **فقدان دائم صامت** لإنذار حادثة فشل حقيقية ومختلفة عن سابقتها.
--     تأكيد Copilot: CONFIRMED.
--
-- (٢) last_alerted_terminal_at بلا تهيئة عند الترحيل:
--     04 (سطر 54-55) تضيف العمود بـ ALTER TABLE ADD COLUMN IF NOT EXISTS
--     last_alerted_terminal_at بلا DEFAULT — فكل صف كان موجوداً قبل تطبيق 04
--     يحصل على NULL. لأي مهمة كانت already 'failed' وقت تطبيق 04:
--       should_alert := previous_healthy IS DISTINCT FROM false   -- false (كانت already unhealthy)
--                     OR previous_alert_at IS NULL                -- false (أُنذرت من قبل)
--                     OR previous_alerted_terminal_at IS DISTINCT FROM terminal_at
--                        -- NULL IS DISTINCT FROM <non-null> = TRUE
--     فتكون النتيجة TRUE حتماً في أول دورة مراقبة بعد الترحيل — أي إنذار مكرر
--     كاذب واحد بالضبط لكل مهمة كانت already-failed وقت الترحيل، رغم أنها
--     أُنذرت عنها من قبل ولم يطرأ فشل جديد. تأكيد Copilot: CONFIRMED.
--
-- الإصلاحان أدناه مستقلان تماماً عن منطق 'stuck'/'disabled' (لا تغيير هناك:
-- يبقيان على الحارس الزمني الدوري previous_alert_at<now()-interval '60 minutes'
-- كما صمّمتهما 04 بقصد — التذكير الدوري لحالة جارية لم "تنتهِ" مقصود لا عطل).
--
-- هذا الملف idempotent بالكامل (CREATE OR REPLACE FUNCTION + UPDATE محروس
-- بشروط يستحيل معها تكرار أثره على نفس الصف مرتين) ولا يمسّ:
--   - جداول بيانات تجارية (فقط private.project_task_health_state، جدول حالة
--     داخلي للمراقبة، لا بيانات عمل).
--   - جدولة أي مهمة cron (لا UPDATE/ALTER على cron.job).
--   - منطق 'stuck' أو 'disabled' أو التعافي (recovery) — سطور 04 الخاصة بها
--     منسوخة هنا بلا أي تغيير.
--
-- **مطبَّق على الإنتاج** (PR #220) — تحقُّق مباشر من المالك على الإنتاج
-- 2026-09-13: select 1 PASS، monitor_project_tasks() تستخدم فعلاً مفتاح
-- dedupe المرتبط بـterminal_at لحالة 'failed'، should_alert لهذه الحالة
-- يعتمد على previous_alerted_terminal_at، 'stuck'/'disabled' ما زالا على
-- الحارس الدوري الأصلي، 12/12 مهمة cron نشطة، الجدولة لم تتغيّر، والتهيئة
-- الرجعية (القسم ٢ أدناه) طُبِّقت فقط على الصفوف المطابقة لشروطها. راجع أيضاً
-- supabase/proposed/README.md وsupabase/project-task-health-monitor.sql
-- (الأخير مُزامَن الآن مع هذا المنطق النهائي).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (٢) تهيئة آمنة لـlast_alerted_terminal_at للصفوف الموروثة فقط
-- ----------------------------------------------------------------------------
-- لا نخترع terminal_at ولا نفترض أن كل صف failed سبق إنذاره فعلاً. نُهيّئ فقط
-- الصفوف التي:
--   - task_key من نوع 'cron:%' (نطاق هذا العطل حصراً؛ صفوف project_task_monitors
--     خارج هذا الملف أصلاً ولا تستخدم last_alerted_terminal_at).
--   - is_healthy = false الآن (أي already-failed وقت هذا الترحيل).
--   - last_alerted_terminal_at IS NULL (لم تُهيَّأ من قبل — idempotent: تشغيل
--     ثانٍ لا يغيّر شيئاً لأن الشرط يفشل بعد أول تشغيل).
--   - last_alert_at IS NOT NULL — **دليل فعلي** على أن إنذاراً سابقاً حدث لهذا
--     الصف (وإلا لن نُخفي فشلاً لم يُنذَر عنه قط: لو last_alert_at NULL فهذا
--     يعني health-state لم يُسجَّل له أي إنذار سابق، فنترك should_alert يعمل
--     بمنطقه الطبيعي في أول دورة، وهذا سلوك صحيح لا عطل).
-- المصدر: أحدث terminal run فعلي حالياً في cron.job_run_details لكل jobid —
-- وبما أن terminal_at لحالة 'failed' لا يتغيّر إلا بمحاولة تشغيل جديدة، وبما
-- أن is_healthy=false يعكس تصنيفاً حديثاً جداً (دورة مراقبة واحدة على الأكثر)،
-- فإن القيمة الحالية في cron.job_run_details هي بإثبات منطقي نفس terminal_at
-- الذي أُنذر عنه سابقاً — لا قيمة مُخترعة.
--
-- المقايضة الموثَّقة صراحة: نافذة سباق صغيرة (دورة pg_cron واحدة تقريباً،
-- ≤ دقيقة) تبقى ممكنة إن حدثت محاولة فشل جديدة فعلاً بين آخر دورة مراقبة
-- وتنفيذ هذا الترحيل بالذات — عندها ستُهيَّأ last_alerted_terminal_at مباشرة
-- إلى قيمة "الفشل الجديد" هذا فيُبتلع إنذاره الأول صامتاً. هذا خطر ضئيل جداً
-- ومقبول صراحة مقارنة بالبديل: إنذار مكرر كاذب مضمون لكل مهمة already-failed.
with latest_terminal as (
  select jobid,
         max(start_time) filter (where status in ('succeeded','failed')) as terminal_at
  from cron.job_run_details
  group by jobid
),
target as (
  select j.jobname, lt.terminal_at
  from cron.job j
  join latest_terminal lt on lt.jobid = j.jobid
  where lt.terminal_at is not null
)
update private.project_task_health_state s
set last_alerted_terminal_at = t.terminal_at
from target t
where s.task_key = 'cron:' || t.jobname
  and s.is_healthy = false
  and s.last_alerted_terminal_at is null
  and s.last_alert_at is not null;

-- ----------------------------------------------------------------------------
-- (١) مفتاح dedupe مرتبط بهوية الحادثة لحالة 'failed' فقط
-- ----------------------------------------------------------------------------
-- نسخة كاملة من دالة 04 بلا أي تغيير سوى مفتاح notify_telegram لفرع 'failed':
-- يضاف إليه terminal_at (بدقة الثانية) بدلاً من اسم المهمة وحده. 'stuck'
-- و'disabled' يبقيان على المفتاح الأصلي بلا أي تغيير (نفس السطر 04 حرفياً)
-- لأن حارسهما الزمني (previous_alert_at<...60 minutes) هو نفسه المقصود
-- للتذكير الدوري، ومفتاحهما الثابت هو الصحيح لهذا الغرض تحديداً.
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
    -- 05: مفتاح dedupe لحالة 'failed' يتضمن terminal_at (هوية الحادثة
    -- نفسها) بدل اسم المهمة وحده — بهذا فشل جديد (terminal_at مختلف) خلال
    -- أقل من 60 دقيقة من إنذار سابق لنفس المهمة يحصل على مفتاح مختلف تماماً
    -- فلا يصطدم بنافذة dedupe الخاصة بالفشل السابق، ويُرسَل فوراً.
    -- 'stuck'/'disabled': المفتاح كما هو في 04 بلا تغيير (التذكير الدوري
    -- يعتمد عمداً على نفس المفتاح كل ساعة).
    if job_health='failed' then
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||to_char(terminal_at,'YYYYMMDDHH24MISS');
    else
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname;
    end if;
    perform public.notify_telegram('project_task_failure',
     format('🚨 توقفت مهمة داخل الموقع%1$s• المهمة: %2$s%1$s• الحالة: %3$s',chr(10),job_record.jobname,detail_text),
     failure_dedupe_key,60);
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
