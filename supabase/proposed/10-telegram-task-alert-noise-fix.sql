-- proposed/10-telegram-task-alert-noise-fix.sql
--
-- **مقترح — غير مطبَّق على الإنتاج.** يُطبَّق فقط بتفويض صريح من المالك.
--
-- المشكلة (مثبتة بالكود وببيانات الإنتاج لـ14 يوماً: 148 حادثة، 936 رسالة):
-- حدّ «الحداثة» max_age_minutes (10/15/30 دقيقة) كان هو نفسه حدّ إرسال
-- «🚨 توقفت مهمة بالمشروع»، فيُرسَل إنذار عند أول عيّنة متأخرة، ثم يتكرر كل
-- ساعة. نحو نصف الحوادث تنتهي خلال 60 دقيقة (تأخر عابر / إطفاء جهاز /
-- انقطاع إنترنت) والوسيط 57 دقيقة.
--
-- الإصلاح (تعديل دالة + عمودين، بلا مساس ببيانات التقارير ولا جدولة cron):
--   • alert_after_minutes لكل مهمة: لا Telegram قبله — يُسجَّل التأخر داخلياً
--     في project_task_health_state.last_detail فقط. max_age_minutes لا يتغيّر
--     (واجهة التطبيق تعكسه وscripts/check-customer-intelligence-wiring.mjs يثبّته).
--   • fault_since: بداية العطل الحالي — تُقاس بها مدّة التراكم (status≠ok).
--   • رسالة واحدة لكل عطل، تذكير كل 6 ساعات فقط، ورسالة تعافٍ واحدة فقط
--     لمهمة أُنذر عنها فعلاً.
--   • حلقة cron.job («توقفت مهمة داخل الموقع») وتنبيهات Windows sync_failure
--     والتنبيهات الأمنية: لا تغيير إطلاقاً.
-- الدالة الكاملة مطابقة للملف القانوني supabase/project-task-health-monitor.sql.
-- التراجع: أعد تطبيق proposed/09 (الدالة السابقة)؛ العمودان الجديدان غير ضارّين.

-- proposed/10 (تنبيهات تيليجرام المزعجة): حدّ التنبيه منفصل عن max_age_minutes.
-- max_age_minutes يبقى حدّ «الحداثة» الذي تعكسه واجهة التطبيق
-- (CONFIG.freshnessMinutes في customer-intelligence) ويُسجَّل داخلياً فقط؛
-- أما إرسال Telegram فلا يحدث قبل alert_after_minutes (استمرار مثبت).
-- fault_since يحفظ بداية العطل الحالي كي تُقاس مدّته بين الدورات.
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_monitors' and column_name='alert_after_minutes'
  ) then
    alter table private.project_task_monitors add column alert_after_minutes integer
      check (alert_after_minutes is null or alert_after_minutes between 5 and 10080);
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_health_state' and column_name='fault_since'
  ) then
    alter table private.project_task_health_state add column fault_since timestamptz;
  end if;
end $$;

-- proposed/10: حدود التنبيه لكل مهمة (دقائق) من إيقاعها الفعلي، لا مدة موحّدة:
-- كلها ≥ 4× دورة المهمة، لتحمّل إطفاء/انقطاع إنترنت مؤقتاً على أجهزة OZK.
-- ameen-main هو المؤشر الأسرع (دورته دقيقة واحدة وكل المصادر تعتمد عليه).
update private.project_task_monitors m set alert_after_minutes=v.mins
from (values ('ameen-main',45),('customer-balances',120),('customer-movements',180),
 ('customer-invoices',240),('daily-profit',120),('price-sync',180),('invoice-series',120),
 ('item-details',720),('khalil-audit',120),('expense-entries',360)) as v(task_key,mins)
where m.task_key=v.task_key and m.alert_after_minutes is distinct from v.mins;

-- proposed/10: قرار التنبيه كدالة نقية قابلة للاختبار الحتمي.
--   'ok'      سليم ولا إنذار سابق ⇒ لا رسالة
--   'recover' سليم بعد إنذار أُرسل فعلاً ⇒ رسالة تعافٍ واحدة
--   'log'     متأخر لكن دون حدّ التنبيه (أو تراكم غير مستمر) ⇒ تسجيل داخلي فقط
--   'alert'   عطل مستمر تجاوز alert_after ولم يُنذَر عنه ⇒ رسالة واحدة
--   'hold'    عطل مُنذَر عنه ولم يحن التذكير ⇒ صمت
--   'remind'  عطل مُنذَر عنه ومرّ p_reminder_minutes منذ آخر رسالة ⇒ تذكير
create or replace function private.project_task_alert_decision(
  p_has_report boolean, p_age_minutes numeric, p_backlogged boolean,
  p_fault_minutes numeric, p_max_age integer, p_alert_after integer,
  p_alerted boolean, p_minutes_since_alert numeric, p_reminder_minutes integer default 360)
returns text language sql immutable
as $$
 select case
  when not (not p_has_report or p_age_minutes>p_max_age or p_backlogged) then
   case when p_alerted then 'recover' else 'ok' end
  when not (not p_has_report or p_age_minutes>=p_alert_after
            or (p_backlogged and p_fault_minutes>=p_alert_after)) then
   case when p_alerted then 'hold' else 'log' end
  when not p_alerted then 'alert'
  when p_minutes_since_alert>=p_reminder_minutes then 'remind'
  else 'hold'
 end
$$;
revoke all on function private.project_task_alert_decision(boolean,numeric,boolean,numeric,integer,integer,boolean,numeric,integer)
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
 previous_alerted_health text;
 -- proposed/08: هوية incident لكل حادثة انتقال فعلي بين تصنيفَي stuck/disabled
 -- (راجع تعليق عمود last_alerted_health_since أعلاه).
 previous_alerted_health_since timestamptz; health_incident_since timestamptz;
 previous_fault_since timestamptz; fault_start timestamptz; alert_after integer; is_alerted boolean; decision text;
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
  select is_healthy,last_alert_at,fault_since into previous_healthy,previous_alert_at,previous_fault_since
    from private.project_task_health_state where task_key=cfg.task_key;
  alert_after:=coalesce(cfg.alert_after_minutes,greatest(cfg.max_age_minutes*4,120));
  -- is_alerted: أُرسل إنذار فعلاً لهذا العطل. previous_alert_at لا يُسجَّل إلا
  -- بعد نجاح notify_telegram (راجع الحارس أدناه) وتُصفَّر عند التعافي.
  is_alerted:=previous_healthy=false and previous_alert_at is not null;
  fault_start:=case when previous_healthy=false then coalesce(previous_fault_since,now()) else now() end;
  decision:=private.project_task_alert_decision(
   last_at is not null, age_minutes, is_backlogged,
   round(extract(epoch from(now()-fault_start))/60.0,1),
   cfg.max_age_minutes, alert_after, is_alerted,
   case when previous_alert_at is null then null else extract(epoch from(now()-previous_alert_at))/60.0 end);

  if decision in ('log','alert','hold','remind') then
   detail_text:=case
    when last_at is null then 'لم يصل أي تقرير حتى الآن'
    when last_at<now()-make_interval(mins=>cfg.max_age_minutes) then
     format('آخر نجاح منذ %s دقيقة عند %s',age_minutes,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'))
    else
     format('تراكم محتمل (status=%s) — آخر دفعة كاملة عند %s',last_status,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'))
    end;
   if decision='log' then
    detail_text:='تأخر دون حدّ التنبيه (تسجيل داخلي فقط) — '||detail_text;
   end if;
   if decision in ('alert','remind') then
    -- Codex P1 (PR #220): previous_alert_at لا يُسجَّل إلا بعد قبول الإدراج في
    -- telegram_outbox دون استثناء؛ عند فشله تُعاد المحاولة تلقائياً بالدورة التالية.
    -- مفتاح dedupe = هوية العطل (fault_start) ثم طابع التذكير، فلا يُكتم عطل جديد
    -- بعد تعافٍ سريع ولا تتكرر الرسالة نفسها.
    begin
     perform public.notify_telegram('project_task_failure',
      format('%6$s%1$s• المهمة: %2$s%1$s• المصدر: %3$s%1$s• الحالة: %4$s%1$s• حدّ التنبيه: %5$s دقيقة',
       chr(10),cfg.task_label,cfg.report_source,detail_text,alert_after,
       case when decision='alert' then '🚨 انقطاع مستمر في مهمة بالمشروع' else '⏰ تذكير: الانقطاع ما زال قائماً' end),
      'project-task-failure:'||cfg.task_key||':'||to_char(fault_start,'YYYYMMDDHH24MISSMS')
       ||case when decision='remind' then ':r'||to_char(now(),'YYYYMMDDHH24MI') else '' end,
      1);
     previous_alert_at:=now();
    exception when others then
     raise warning 'monitor_project_tasks: notify_telegram failed for %: %',cfg.task_key,sqlerrm;
    end;
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail,fault_since)
    values(cfg.task_key,false,now(),last_at,previous_alert_at,detail_text,fault_start)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_success_at=excluded.last_success_at,
     last_alert_at=excluded.last_alert_at,last_detail=excluded.last_detail,fault_since=excluded.fault_since;
  else
   -- رسالة التعافي مرة واحدة وفقط لمهمة أُنذر عنها فعلاً (decision='recover').
   if decision='recover' then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت المهمة للعمل%1$s• المهمة: %2$s%1$s• المصدر: %3$s%1$s• آخر نجاح: %4$s',
      chr(10),cfg.task_label,cfg.report_source,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI')),
     'project-task-recovered:'||cfg.task_key||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail,fault_since)
    values(cfg.task_key,true,now(),last_at,null,'يعمل',null)
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,last_alert_at=null,last_detail='يعمل',fault_since=null;
  end if;
 end loop;

 for job_record in select jobid,jobname,active from cron.job where jobname<>'monitor-project-tasks' loop
  -- مصدران مستقلان، لا مصدر واحد. الصف الأحدث وحده لا يكفي: بمجرد أن يبدأ
  -- التشغيل التالي يختفي الفشل المكتمل من النظر (حادثة 2026-08-30 09:14).
  --   (١) أحدث تشغيل مطلقاً — هل هناك محاولة جارية الآن؟
  select status,start_time into last_job_status,last_job_at from cron.job_run_details
   where jobid=job_record.jobid order by start_time desc limit 1;
  --   (٢) أحدث تشغيل نهائي — آخر نتيجة مكتملة، مهما علاها من محاولات.
  select status,start_time into terminal_status,terminal_at from cron.job_run_details
   where jobid=job_record.jobid and status in ('succeeded','failed')
   order by start_time desc limit 1;
  retry_running:=last_job_status is not null and last_job_status not in ('succeeded','failed');
  -- التصنيف كله في الدالة النقية أعلاه؛ هنا قرار الحالة فقط، بثلاثة فروع
  -- صريحة لا فرعين. الفرعان وحدهما كانا هما العطل (ملاحظة Codex P1 على
  -- PR #154): كل ما ليس إنذاراً كان يسقط في مسار "سليم"، فمهمة فاشلة تُعيد
  -- المحاولة تتصادف مع دورة المراقب فتُصنَّف inflight ⇒ تُرسَل رسالة تعافٍ
  -- كاذبة، ويُمسح last_alert_at، ويُسجَّل بدء محاولة لم تنجح في
  -- last_success_at. ثم إن فشلت المحاولة فعلاً، يكتم
  -- notify_telegram_dispatch إشعارها لأن مفتاح project-cron-failure:<job>
  -- ثابت بمهلة 60 دقيقة وقد استُهلك عند الفشل الأول — فتبقى "✅ عادت للعمل"
  -- آخر ما يراه المشغّل والمهمة فاشلة. مراقب صامت ومطمئن كذباً أسوأ من
  -- مراقب صاخب وصادق.
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
   -- حارس الإنذار لم يتغيّر عن سلوكه الأصلي لـ'stuck'/'disabled'، عمداً.
   --
   -- جُرّب هنا شرط رابع «فشل نهائي بدأ بعد آخر إنذار ⇒ فشل جديد» ثم أُسقط بعد
   -- ملاحظة Codex P1 الثالثة على PR #154، وكانت محقّة: مفتاح الإرسال
   -- project-cron-failure:<job> ثابت بمهلة 60 دقيقة، وnotify_telegram_dispatch
   -- يعود بلا إدراج حين يجده حديثاً، وnotify_telegram دالة RETURNS void فلا
   -- تُبلّغ عن الكتم إطلاقاً — بينما previous_alert_at:=now() أدناه يعمل بلا
   -- شرط. فالنتيجة كانت أن الفشل الثاني داخل الساعة يُسجَّل كأنه أُنذر عنه ولا
   -- يصل المشغّل، وتُصفَّر معه ساعة التذكير الدوري فيتأجّل إشعاره ستين دقيقة
   -- أخرى — أي أسوأ من السلوك الذي أراد الشرط إصلاحه.
   --
   -- الفصل المقصود: هذا الملف مسؤول عن *صحة الحالة* (unhealthy، وسبب الفشل في
   -- last_detail، ولا تعافٍ إلا بنجاح نهائي). أمّا «هل تصل الرسالة مرة أم
   -- تُكتم» فهي سياسة الإرسال في طبقة telegram_outbox، وعلاجها الصحيح مفتاح
   -- dedupe لكل تشغيل نهائي أو إشارة تأكيد من notify_telegram.
   --
   -- proposed/05: الحل الفعلي المطبَّق على الإنتاج لهذا البند بالذات —
   -- 'failed' حادثة مكتملة، فلا تُنذَر ثانية لمجرد مرور ساعة إن كانت terminal_at
   -- نفسها لم تتغيّر (لا محاولة جديدة)؛ 'stuck'/'disabled' حالتان جاريتان
   -- فتبقيان على الحارس الزمني الأصلي (التذكير الدوري مقصود لهما).
   if job_health='failed' then
    -- Codex P1 (PR #220، ملاحظة إضافية): previous_alerted_terminal_at وحدها تفترض أن
    -- عودة terminal_at نفسها تعني "لا جديد" — خطأ حين تكون آخر حالة أُنذر عنها فعلياً
    -- تصنيفاً مختلفاً (disabled) لنفس terminal_at القديم: مهمة أُنذرت كـ'failed' ثم
    -- عُطِّلت (last_alerted_health='disabled')، وأُعيد تفعيلها بلا تشغيل جديد — تعود
    -- 'failed' بنفس terminal_at القديم، فيبقى previous_alerted_terminal_at مطابقاً
    -- ويبقى previous_healthy=false أصلاً (عُطِّلت وهي غير سليمة) فلا يتغيّر أي شرط —
    -- ينزلق الانتقال بلا إنذار رغم أن الحالة الحيّة الآن غير معروفة للمشغّل (آخر ما
    -- رآه "المهمة معطلة"). انتقال تصنيف حقيقي (previous_alerted_health مختلف) يستحق
    -- إنذاره فوراً هنا أيضاً، تماماً كما في فرع stuck/disabled أدناه.
    -- previous_alerted_health is null يعني حادثة موروثة سبقت وجود هذا العمود
    -- أصلاً (لا انتقال تصنيف حقيقي رُصد قط) — نفس سيناريو الترحيل في proposed/05
    -- (last_alerted_terminal_at كانت NULL قبل 04)؛ اعتباره "انتقالاً" هنا كان
    -- سيُطلق إنذاراً كاذباً واحداً فوراً على كل صف قديم رغم أن التهيئة الآمنة
    -- في 05 سوَّت terminal_at أصلاً بلا حاجة لإنذار — لذا يُشترط NOT NULL.
    should_alert:=previous_healthy is distinct from false or previous_alert_at is null
     or previous_alerted_terminal_at is distinct from terminal_at
     or (previous_alerted_health is not null and previous_alerted_health is distinct from job_health);
   else
    -- Codex P1 (PR #220، الجولة الثالثة): الحارس الزمني الساعي وحده يفترض أن
    -- previous_alert_at الحديث يعني أن هذه الحالة بعينها أُنذر عنها بالفعل —
    -- خطأ حين يكون الإنذار السابق لتصنيف مختلف (failed أُنذر عنه قبل 39
    -- دقيقة، والمهمة الآن stuck). انتقال حقيقي بين تصنيفين يستحق إنذاره
    -- فوراً بصرف النظر عن عمر آخر إنذار، تماماً كما لو كانت previous_alert_at
    -- غير موجودة أصلاً.
    should_alert:=previous_healthy is distinct from false or previous_alert_at is null
     or previous_alert_at<now()-interval '60 minutes'
     or previous_alerted_health is distinct from job_health;
   end if;

   if should_alert then
    -- 05: مفتاح dedupe لحالة 'failed' يتضمن terminal_at (هوية الحادثة نفسها)
    -- بدل اسم المهمة وحده — بهذا فشل جديد (terminal_at مختلف) خلال أقل من 60
    -- دقيقة من إنذار سابق لنفس المهمة يحصل على مفتاح مختلف تماماً فلا يصطدم
    -- بنافذة dedupe الخاصة بالفشل السابق، ويُرسَل فوراً.
    -- 07 (PR #220): مفتاح dedupe لحالتَي 'stuck'/'disabled' كان اسم المهمة
    -- وحده بلا تصنيف — فانتقال حقيقي بين التصنيفين (should_alert أعلاه يصير
    -- true فوراً بفضل شرط previous_alerted_health) كان يصطدم مع نفس المفتاح
    -- الذي أدرجه notify_telegram قبل لحظات لتصنيف مختلف ضمن نافذة الـ60 دقيقة
    -- نفسها، فيُرجع notify_telegram silently (dedupe hit، بلا استثناء يُلتقط)
    -- ولا يصل الإنذار الجديد إطلاقاً رغم أن should_alert صحيح. الإصلاح: إلحاق
    -- job_health بالمفتاح — كل تصنيف له مساحة dedupe مستقلة، فانتقال التصنيف
    -- يُنذَر فوراً، والاستمرار على نفس التصنيف يبقي نفس المفتاح فيعمل التذكير
    -- الدوري الساعي كما كان بلا أي تغيير في مهلته.
    if job_health='failed' then
     -- نفس علاج job_health أدناه لحالتَي stuck/disabled: مفتاح terminal_at وحده يصطدم
     -- مع مفتاح إنذار 'failed' الأصلي (نفس terminal_at) حين يكون هذا انتقالاً حقيقياً
     -- (previous_alerted_health مختلف، كإعادة تفعيل مهمة كانت معطّلة بلا تشغيل جديد)
     -- لا تكراراً لنفس الحادثة — فيُسقَط الإنذار الجديد بصمت رغم أن should_alert صحيح.
     -- إلحاق طابع انتقال طازج بالمفتاح فقط عند اختلاف previous_alerted_health يحلّ هذا
     -- بلا مساس بالسلوك الأصلي (dedupe بـterminal_at وحده) حين لا يوجد انتقال تصنيف.
     if previous_alerted_health is distinct from job_health then
      failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||to_char(terminal_at,'YYYYMMDDHH24MISS')||':'||to_char(now(),'YYYYMMDDHH24MISSMS');
     else
      failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||to_char(terminal_at,'YYYYMMDDHH24MISS');
     end if;
    else
     -- proposed/08 (PR #220، ملاحظة Codex P1 جديدة على 07): job_health وحده
     -- يحلّ انتقالاً حقيقياً بين تصنيفين لكن لا يحلّ عودة *نفس* التصنيف مرتين
     -- خلال أقل من 60 دقيقة (stuck->disabled->stuck) — الانتقال الثالث يحصل
     -- على نفس مفتاح "...:stuck" الذي أدرجه notify_telegram قبل لحظات لنفس
     -- الحادثة الأولى، فيُسقَط بصمت رغم أن should_alert صحيح. health_incident_since
     -- تُسجَّل عند كل دخول فعلي لتصنيف جديد (previous_alerted_health مختلف)
     -- وتبقى كما هي عبر التذكير الدوري لنفس التصنيف (previous_alerted_health_since).
     if previous_alerted_health is distinct from job_health then
      health_incident_since:=now();
     else
      health_incident_since:=coalesce(previous_alerted_health_since,now());
     end if;
     failure_dedupe_key:='project-cron-failure:'||job_record.jobname||':'||job_health||':'||to_char(health_incident_since,'YYYYMMDDHH24MISSMS');
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
   -- 'ok' وحدها تمنح شهادة النجاح. لا محاولة قيد التنفيذ، ولا مهمة لم تُشغَّل.
   select is_healthy into previous_healthy from private.project_task_health_state where task_key='cron:'||job_record.jobname;
   if previous_healthy=false then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت مهمة الموقع للعمل%1$s• المهمة: %2$s',chr(10),job_record.jobname),
     'project-cron-recovered:'||job_record.jobname||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   -- proposed/05: تعافٍ فعلي يُصفِّر last_alerted_terminal_at أيضاً، كي يُنذَر
   -- فشلٌ مقبل بصرف النظر عن terminal_at القديم الذي كان مؤنذَراً عنه قبل هذا
   -- التعافي.
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_alerted_terminal_at,last_alerted_health,last_alerted_health_since,last_detail)
    values('cron:'||job_record.jobname,true,now(),terminal_at,null,null,null,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,
     last_alert_at=null,last_alerted_terminal_at=null,last_alerted_health=null,last_alerted_health_since=null,last_detail='يعمل';
  else
   -- 'inflight' / 'never_run': حالة محايدة. لا إنذار ولا تعافٍ، ولا تُمَس
   -- is_healthy ولا last_alert_at ولا last_success_at ولا last_detail —
   -- الحكم السابق يبقى كما هو حتى نرى نتيجة نهائية فعلية. كل ما تثبته هذه
   -- الحالة أن المراقب شاهد المهمة، فتُحدَّث last_observed_at وحدها.
   --
   -- الصف الغائب (مهمة جديدة لم يُحكم عليها بعد): يُنشأ بـis_healthy=null —
   -- العمود nullable في المخطط أصلاً، وهي القيمة الوحيدة الصادقة هنا. ولا
   -- تُخترع true لمجرد إنشاء الصف. وnull آمنة في الفرعين الآخرين معاً:
   --   الإنذار : null is distinct from false = true  ⇒ الإشعار يمرّ لاحقاً.
   --   التعافي : null = false ⇒ NULL ⇒ لا تعافٍ كاذباً من حالة مجهولة.
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_detail)
    values('cron:'||job_record.jobname,null,now(),
     case when job_health='never_run' then 'لم تُشغَّل بعد' else 'قيد التنفيذ' end)
    on conflict(task_key) do update set last_observed_at=now();
  end if;
 end loop;
end $$;

revoke all on function private.monitor_project_tasks() from public,anon,authenticated;
