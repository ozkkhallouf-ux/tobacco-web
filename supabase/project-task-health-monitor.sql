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
 ('khalil-audit','مزامنة تدقيق خليل','khalil_audit_sync_heartbeat',10,true,'khalil_audit_sync_heartbeat'),
 -- 2026-08-31: مهمة "TOBACCO Expense Entries Push" كانت غير مسجّلة إطلاقاً
 -- على OZK2026 بين 12 و25 آب، فتوقف خط المصاريف ١٩ يوماً بلا إنذار واحد،
 -- والتقرير المسائي يعلن "المصاريف اليوم: 0" كل ليلة بينما الحركات موجودة
 -- فعلاً في الأمين. السبب أن لا شيء كان يراقب هذا الخط: مراقب Windows
 -- (tools/ensure-ameen-sync.ps1) يكتشف المهام الموجودة فقط — فمهمة محذوفة
 -- لا يراها أصلاً — ولم يكن هنا صف يراقب البيانات نفسها. هذا الصف يغلق
 -- الثقب من جهة البيانات: أي انقطاع في الرفع يُكتشف بصرف النظر عن سبب
 -- التوقف (حذف المهمة/تعطيلها/فشلها/إطفاء الجهاز).
 -- source_table='expense_entries' أي النمط المخصّص (كما khalil-audit) لأن
 -- tools/push-expense-entries.ps1 لا يكتب أي heartbeat في inventory_reports
 -- إطلاقاً، فلا قيمة source يمكن الفلترة عليها هناك. وmax(created_at) على
 -- الجدول نفسه هو بالضبط زمن آخر رفع ناجح: السكربت يحذف نافذة الأيام
 -- السبعة ثم يعيد إدراجها كاملة في كل تشغيل، فكل صفوف النافذة تحمل طابع
 -- التشغيلة الأخيرة (مثبت حياً: كل دورة PT30M تستبدل مجموعة المعرّفات
 -- بالكامل). ولا حاجة لصلاحيات إضافية — monitor_project_tasks() هي
 -- security definer ومالكها postgres، وهو نفسه مالك expense_entries بلا
 -- force row level security، فقراءة max(created_at) لا تصطدم بسياسات RLS
 -- "المالك فقط" على الجدول.
 -- 90 دقيقة = ٣ أضعاف دورة المهمة (PT30M): تتحمّل تشغيلتين فائتتين قبل
 -- الإنذار — وهو هامش ضروري على جهاز محمول يُطفأ ساعات — وهي نفس عتبة
 -- customer-invoices المثبتة أصلاً في هذا التصميم.
 -- check_status يبقى false (الافتراضي): expense_entries جدول بيانات بلا
 -- عمود status، فلا شيء يُقرأ. لا تُضَف هنا.
 -- قيد معروف ومقبول: لو مرّت نافذة الأيام السبعة كلها بلا أي حركة مصاريف
 -- في الأمين، يخرج السكربت بـexit 0 بلا حذف ولا إدراج (سطر "ma fi satr")
 -- فيتجمّد max(created_at) ويُطلق إنذاراً رغم سلامة المهمة. سبعة أيام
 -- متتالية بلا مصروف واحد في محل يعمل يومياً حالة تستحق النظر بنفسها،
 -- فالإنذار عندها صحيح لا كاذب، ولا يُعالَج بخفض الحساسية.
 ('expense-entries','حركة المصاريف','expense_entries',90,true,'expense_entries')
on conflict(task_key) do update set task_label=excluded.task_label,report_source=excluded.report_source,
 max_age_minutes=excluded.max_age_minutes,enabled=excluded.enabled,source_table=excluded.source_table;

-- جولة ٥: تفعيل فحص status لصف خليل تحديداً (انظر تعليق العمود أعلاه) —
-- تحديث منفصل بدل إضافته لقائمة insert...on conflict فوق كي لا يُعاد ضبط
-- بقية الصفوف check_status=false في كل إعادة تشغيل (وهي بالفعل القيمة
-- الافتراضية الصحيحة لها، لكن الوضوح أفضل من الاعتماد الضمني).
update private.project_task_monitors set check_status=true where task_key='khalil-audit';

-- ============================================================================
-- مصنِّف حالة مهام pg_cron — دالة نقية، مستخرجة عمداً كي يصبح المنطق مختبَراً.
--
-- عطل إنتاجي حيّ (2026-08-31): كان الشرط `last_job_status<>'succeeded'` قائمة
-- حظر — كل ما ليس "succeeded" فشل، بما فيه التشغيل الجاري. النتيجة عاصفة
-- إنذارات كاذبة على prune-inventory-reports: المراقب (*/5) وprune (*/10)
-- يبدآن في الثانية نفسها، وقياس ثلاث حوادث مستقلة أثبت أن حلقة cron تُنفَّذ
-- خلال أقل من 400 ميلي‌ثانية من بدء معاملة المراقب — أي داخل نافذة تشغيل
-- prune (0.3–0.4 ثانية) تماماً:
--   المراقب now()=08:50:00.213408 · بدء prune=08:50:00.215132 · نهايته=08:50:00.599234
-- فيقرأ الصف وهو فعلاً "running" فيعلنه فشلاً، ثم يعلن تعافياً بعد خمس دقائق
-- — ست مرات في الساعة. فشل prune الحقيقي الوحيد في 11226 تشغيلة كان في
-- 2026-08-20، فكل ما عداه كان ضجيجاً خالصاً.
--
-- pg_cron يكتب في cron.job_run_details.status ستّ قيم: أربع عابرة
-- (starting/connecting/sending/running) واثنتان نهائيتان (succeeded/failed).
-- العابرة تُحدَّث في مكانها فلا تبقى في التاريخ — تُرى باللقطة الآنية وحدها،
-- وهو بالضبط ما يفعله المراقب. لذلك التصنيف هنا قائمة سماح صريحة: أي قيمة
-- غير معروفة تُعامل معاملة العابرة (تحفُّظ: صمت داخل المهلة ثم إنذار بعدها)
-- بدل أن تُعدّ فشلاً فورياً كما كان.
--
-- p_grace = 10 دقائق مشتقة من القياس لا من التقدير: أطول تشغيل مشروع في
-- تاريخ هذه القاعدة كله هو 404.99 ثانية (dispatch-telegram-outbox) ≈ 6.75
-- دقيقة. عشر دقائق تغطّيه بهامش دون أن تعمي عن جمود حقيقي.
--
-- حدّ المهلة محسوم صراحة ولا يُترك لالتباس < مقابل <=:
--   العمر <  grace ⇒ inflight
--   العمر >= grace ⇒ stuck      (أي أن عشر دقائق بالضبط = stuck)
--
-- p_now وسيط صريح بدل now() داخل الجسم كي يبقى اختبار الحدود حتمياً بالضبط
-- بدل أن يعتمد على لحظة التنفيذ.
--
-- القيم المُعادة:
--   'disabled'   المهمة نفسها معطّلة              ⇒ إنذار فوري
--   'failed'     آخر تشغيل انتهى بالفشل            ⇒ إنذار فوري
--   'stuck'      عابرة/مجهولة تجاوزت المهلة        ⇒ إنذار
--   'inflight'   عابرة/مجهولة ضمن المهلة           ⇒ لا إنذار
--   'never_run'  لا تاريخ تشغيل إطلاقاً             ⇒ لا إنذار
--   'ok'         آخر تشغيل نجح                     ⇒ لا إنذار
--
-- جدول الحقيقة الكامل مختبَر في supabase/tests/cron-job-health-truth-table.sql
-- ============================================================================
create or replace function private.cron_job_health(
  p_active boolean,
  p_status text,
  p_last_at timestamptz,
  p_grace interval default interval '10 minutes',
  p_now timestamptz default now()
) returns text language sql immutable parallel safe as $fn$
  select case
    -- التعطيل يسبق كل شيء: هو العنوان مهما كانت آخر حالة تشغيل. و«ليس true»
    -- تشمل NULL عمداً — حالة مجهولة النشاط تُعامل معاملة المعطّلة لا المُهمَلة.
    when p_active is not true then 'disabled'
    -- NULL = لم تُشغَّل قط. سلوك صريح ومقصود لا نتيجة عرضية لثلاثية SQL:
    -- لا يحمل cron.job أي طابع إنشاء، فلا سبيل للتمييز بين مهمة أُنشئت للتوّ
    -- وأخرى لا تُقلع أبداً — وإنذارٌ هنا كان سيصرخ على كل مهمة جديدة.
    when p_status is null then 'never_run'
    when p_status = 'succeeded' then 'ok'
    when p_status = 'failed' then 'failed'
    -- عابرة أو مجهولة بلا طابع زمني: لا يمكن إثبات حداثتها، فالموقف المحافظ
    -- هو الإنذار لا الصمت.
    when p_last_at is null then 'stuck'
    when p_now - p_last_at < p_grace then 'inflight'
    else 'stuck'
  end;
$fn$;

revoke all on function private.cron_job_health(boolean,text,timestamptz,interval,timestamptz)
  from public,anon,authenticated;

create or replace function private.monitor_project_tasks()
returns void language plpgsql security definer
set search_path=private,public,cron,pg_temp
as $$
declare cfg record; last_at timestamptz; age_minutes numeric; last_status text; is_backlogged boolean;
 previous_healthy boolean; previous_alert_at timestamptz; detail_text text;
 job_record record; last_job_status text; last_job_at timestamptz;
 job_health text; cron_grace interval:=interval '10 minutes';
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
  job_health:=private.cron_job_health(job_record.active,last_job_status,last_job_at,cron_grace);
  if job_health in ('disabled','failed','stuck') then
   detail_text:=case job_health
    when 'disabled' then 'المهمة معطلة'
    when 'failed' then format('فشل آخر تشغيل عند %s',
     coalesce(to_char(last_job_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'),'وقت غير معروف'))
    else format('عالقة في حالة %s منذ %s',coalesce(last_job_status,'غير معروفة'),
     coalesce(round(extract(epoch from(now()-last_job_at))/60.0,1)::text||' دقيقة','مدة غير معروفة'))
    end;
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
  elsif job_health = 'ok' then
   -- 'ok' وحدها تمنح شهادة النجاح. لا محاولة قيد التنفيذ، ولا مهمة لم تُشغَّل.
   select is_healthy into previous_healthy from private.project_task_health_state where task_key='cron:'||job_record.jobname;
   if previous_healthy=false then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت مهمة الموقع للعمل%1$s• المهمة: %2$s',chr(10),job_record.jobname),
     'project-cron-recovered:'||job_record.jobname||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail)
    values('cron:'||job_record.jobname,true,now(),last_job_at,null,'يعمل')
    on conflict(task_key) do update set is_healthy=true,last_observed_at=now(),last_success_at=excluded.last_success_at,last_alert_at=null,last_detail='يعمل';
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
revoke all on table private.project_task_monitors from public,anon,authenticated;
revoke all on table private.project_task_health_state from public,anon,authenticated;

do $$ declare old_job bigint; begin
 for old_job in select jobid from cron.job where jobname='monitor-project-tasks'
 loop perform cron.unschedule(old_job); end loop;
 perform cron.schedule('monitor-project-tasks','*/5 * * * *','select private.monitor_project_tasks();');
end $$;
