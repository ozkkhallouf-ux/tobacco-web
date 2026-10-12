-- proposed/12-digest-only-atomic-bundle.sql
--
-- **مقترح — غير مطبَّق على الإنتاج.** الطريق الوحيد المسموح لتفعيل سياسة «الملخص اليومي فقط».
-- كل شيء في معاملة واحدة: إما أن يتغيّر المراقب وتقرير المساء معاً (وتُسجَّل الأعطال
-- القائمة فوراً)، أو لا يتغيّر شيء. لا توجد لحظة تصمت فيها الإنذارات قبل أن يستطيع التقرير
-- المسائي عرض الأعطال.
--
-- الترتيب: (1) تحقق قبلي (الحالة الحية مطابقة لما صُمم عليه + مرساة التقرير)
-- (2) لقطة للتعريفين الأصليين (3) proposed/10 (4) تهيئة الأعطال المفتوحة (دورة مراقب كاملة
-- بعد انتظار أي دورة جارية) (5) proposed/11 رقعة التقرير (6) تحقق بعدي. أي فشل = تراجع كامل.
-- idempotent: إعادة التشغيل تكتشف الحالة المطبَّقة، لا تكرر الحوادث ولا تعيد اللقطة.
-- لا يلمس public.notify_telegram ولا cron ولا Windows ولا أي بيانات إنتاج غير جداول هذه الميزة.
-- **طريقة التشغيل**: كطلب واحد (يُنفَّذ كمعاملة ضمنية واحدة: أي خطأ يتراجع بكل شيء ولا يترك
-- جلسة معلّقة) أو psql --single-transaction -v ON_ERROR_STOP=1 -f. لا begin/commit داخل الملف عمداً.
-- حارس: لو نُفِّذ كل أمر بمعاملته (autocommit) يضيع الإعداد المحلي أدناه فيرفض proposed/10 التطبيق
-- قبل تغيير أي دالة. التراجع: proposed/12-digest-only-rollback.sql.
select set_config('app.digest_bundle', 'on', true);

-- (1) تحقق قبلي ------------------------------------------------------------------
do $pre$
declare mon_src text; ev text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
begin
  select prosrc into mon_src from pg_proc where oid = to_regprocedure('private.monitor_project_tasks()');
  if mon_src is null then raise exception 'preflight: private.monitor_project_tasks() missing'; end if;
  if md5(mon_src) not in ('2c762f38b56ea5a683061529bd5e5d7f', 'd695a9aea9c75bdd302e40ddd8b16204') then
    raise exception 'preflight: live monitor_project_tasks differs from proposed/09 (md5 %), refusing to overwrite unknown drift (accepted: live=09 or already-applied bundle)', md5(mon_src);
  end if;
  if to_regprocedure('public.send_evening_report()') is null then raise exception 'preflight: public.send_evening_report() missing'; end if;
  select pg_get_functiondef(to_regprocedure('public.send_evening_report()')) into ev;
  if position('daily_open_faults_section' in ev) = 0
     and (length(ev) - length(replace(ev, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'preflight: send_evening_report anchor not found exactly once';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'notify_telegram') then
    raise exception 'preflight: public.notify_telegram missing';
  end if;
end $pre$;

-- (2) لقطة التعريفين الأصليين (مرة واحدة فقط؛ لا تُستبدل عند إعادة التشغيل) --------
create table if not exists private.digest_bundle_snapshot(
  fn text primary key, def text not null, taken_at timestamptz not null default now());
alter table private.digest_bundle_snapshot enable row level security;
revoke all on private.digest_bundle_snapshot from public, anon, authenticated;
insert into private.digest_bundle_snapshot(fn, def)
select 'private.monitor_project_tasks()', pg_get_functiondef(to_regprocedure('private.monitor_project_tasks()'))
where md5((select prosrc from pg_proc where oid = to_regprocedure('private.monitor_project_tasks()'))) = '2c762f38b56ea5a683061529bd5e5d7f'
on conflict (fn) do nothing;
insert into private.digest_bundle_snapshot(fn, def)
select 'public.send_evening_report()', pg_get_functiondef(to_regprocedure('public.send_evening_report()'))
where position('daily_open_faults_section' in pg_get_functiondef(to_regprocedure('public.send_evening_report()'))) = 0
on conflict (fn) do nothing;

-- (3) proposed/10 ------------------------------------------------------------------

-- proposed/10 (سياسة الملخص اليومي فقط): الأعطال التشغيلية غير الحرجة لا ترسل
-- Telegram مستقلاً؛ تُسجَّل داخلياً وتُعرض في قسم «حالة الأنظمة والأعطال» بآخر
-- التقرير المسائي. alert_after_minutes = حدّ «التأكيد» (استمرار مثبت) لا حدّ
-- إرسال. max_age_minutes لا يتغيّر (الواجهة تعكسه وscripts/check-customer-
-- intelligence-wiring.mjs يثبّته). severity='critical' فقط يُنبَّه فوراً بعد التحقق.
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
    where table_schema='private' and table_name='project_task_monitors' and column_name='severity'
  ) then
    alter table private.project_task_monitors add column severity text not null default 'digest'
      check (severity in ('digest','critical'));
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_monitors' and column_name='impact_note'
  ) then
    alter table private.project_task_monitors add column impact_note text;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='private' and table_name='project_task_health_state' and column_name='fault_since'
  ) then
    alter table private.project_task_health_state add column fault_since timestamptz;
  end if;
end $$;

-- سجلّ الأعطال (تدقيق داخلي + المصدر الوحيد لقسم التقرير اليومي). صف مفتوح واحد
-- فقط لكل مهمة (فهرس فريد جزئي) ⇒ لا يتكرر العطل نفسه داخل التقرير. confirmed_at
-- يُملأ حين يثبت استمرار العطل؛ الأعطال العابرة تُغلق دون أن تظهر في التقرير.
-- يُحفظ الصف مفتوحاً حتى لو لم يُرسل أي تنبيه إطلاقاً.
create table if not exists private.project_task_incidents (
  id bigserial primary key,
  task_key text not null,
  started_at timestamptz not null,
  confirmed_at timestamptz,
  ended_at timestamptz,
  last_success_at timestamptz,
  last_seen_at timestamptz not null default now(),
  detail text,
  alerted boolean not null default false
);
create unique index if not exists project_task_incidents_one_open
  on private.project_task_incidents(task_key) where ended_at is null;
alter table private.project_task_incidents enable row level security;
revoke all on table private.project_task_incidents from public,anon,authenticated;

-- ============================================================================
-- سجلّ الحوادث التشغيلية الموحَّد (private.ops_events) — مصدر واحد لكل ما لا يستحق
-- رسالة Telegram مستقلة: مهام cron، وأحداث Windows/GitHub حين يُوصَل مسارها
-- (الربط عبر notify_telegram **غير مطبَّق** ويتطلب موافقة صريحة، انظر README).
-- صف مفتوح واحد لكل (source,event_key)؛ التكرار يزيد occurrences فقط.
-- ============================================================================
create table if not exists private.ops_events (
  id bigserial primary key,
  source text not null,
  event_key text not null,
  label text not null,
  severity text not null default 'digest' check (severity in ('digest','critical')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1,
  resolved_at timestamptz,
  detail text
);
create unique index if not exists ops_events_one_open
  on private.ops_events(source,event_key) where resolved_at is null;
alter table private.ops_events enable row level security;
revoke all on table private.ops_events from public,anon,authenticated;

-- دليل مستقل على فشل خدمة الموقع/المبيعات الجوهرية. لا يوجد حتى الآن مسبار مستقل
-- معتمد، لذا تُرجع false دائماً ⇒ لا إنذار فوري «توقف كامل» من هذا المراقب مهما صمت
-- وكيل أمين (صمت الوكيل ليس دليلاً على توقف الموقع). إنذار الموقع الحقيقي يبقى فورياً
-- عبر health-check.yml الخارجي. تُستبدل بمسبار مستقل فقط بعد موافقة المالك.
create or replace function private.core_outage_verified()
returns boolean language sql stable as $$ select false $$;
revoke all on function private.core_outage_verified() from public,anon,authenticated;

-- توجيه حدث إلى 'digest' (سجلّ + تقرير مسائي) أو 'immediate' (Telegram فوري).
-- القاعدة الآمنة: كل ما لا نعرفه صراحةً فهو immediate (لا كتم أعمى). الأمن، وفشل
-- النسخ الاحتياطي، وتنبيه الموقع (health_check) تبقى فورية.
create or replace function private.ops_event_route(p_kind text, p_dedupe_key text)
returns text language sql immutable as $$
 select case
  when coalesce(p_kind,'') ~* '(secur|auth|breach|health_check)' then 'immediate'
  when coalesce(p_dedupe_key,'') ~* '(backup|secur|auth)' then 'immediate'
  when p_kind in ('sync_failure','price_sync_failure','price_sync_mismatch','windows') then 'digest'
  when coalesce(p_dedupe_key,'') ~ '^(price-sync:|winfail:|project-cron-failure:)' then 'digest'
  else 'immediate'
 end
$$;
revoke all on function private.ops_event_route(text,text) from public,anon,authenticated;

create or replace function private.record_ops_event(
  p_source text, p_event_key text, p_label text, p_detail text default null,
  p_severity text default 'digest', p_now timestamptz default now())
returns void language plpgsql security definer set search_path=private,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('ops_event:'||p_source||':'||p_event_key,0));
 insert into private.ops_events(source,event_key,label,severity,first_seen_at,last_seen_at,detail)
  values(p_source,p_event_key,p_label,p_severity,p_now,p_now,p_detail)
  on conflict(source,event_key) where resolved_at is null do update set
   occurrences=private.ops_events.occurrences+1,last_seen_at=excluded.last_seen_at,
   detail=excluded.detail,label=excluded.label,severity=excluded.severity;
end $$;
revoke all on function private.record_ops_event(text,text,text,text,text,timestamptz) from public,anon,authenticated;

create or replace function private.resolve_ops_event(p_source text, p_event_key text, p_now timestamptz default now())
returns void language sql security definer set search_path=private,pg_temp as $$
 update private.ops_events set resolved_at=p_now
  where source=p_source and event_key=p_event_key and resolved_at is null
$$;
revoke all on function private.resolve_ops_event(text,text,timestamptz) from public,anon,authenticated;

-- رصد حالة قائمة (مهام cron): يفتح الحدث إن لم يوجد، وإلا يحدّث last_seen_at والتفاصيل
-- فقط (بلا زيادة occurrences لأن الرصد كل 5 دقائق ليس «تكراراً» للعطل). p_since هي
-- أفضل تقدير لبداية العطل ويُستعمل عند الإنشاء فقط. مستقلة عن أي تنبيه سابق: عطل cron
-- قائم قبل التفعيل يُسجَّل في أول دورة ولا يختفي لمجرد أنه أُنذر عنه بالنظام القديم.
create or replace function private.observe_ops_event(
  p_source text, p_event_key text, p_label text, p_detail text default null,
  p_since timestamptz default null, p_severity text default 'digest')
returns void language plpgsql security definer set search_path=private,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('ops_event:'||p_source||':'||p_event_key,0));
 insert into private.ops_events(source,event_key,label,severity,first_seen_at,last_seen_at,detail)
  values(p_source,p_event_key,p_label,p_severity,least(coalesce(p_since,now()),now()),now(),p_detail)
  on conflict(source,event_key) where resolved_at is null do update set
   last_seen_at=now(),detail=excluded.detail,label=excluded.label;
end $$;
revoke all on function private.observe_ops_event(text,text,text,text,timestamptz,text) from public,anon,authenticated;

-- أحداث المصادر الخارجية (Windows/GitHub) لا تحمل إشارة تعافٍ؛ تتكرر ما دام العطل
-- قائماً (dedupe 60 د)، فصمتها p_silence يعني زوال العطل ⇒ تُغلق داخلياً.
-- مهام cron (source='cron') تُغلق صراحةً عند عودتها ولا يشملها هذا الإغلاق.
create or replace function private.close_stale_ops_events(
  p_now timestamptz default now(), p_silence interval default interval '6 hours')
returns void language sql security definer set search_path=private,pg_temp as $$
 update private.ops_events set resolved_at=p_now
  where resolved_at is null and source<>'cron' and last_seen_at<p_now-p_silence
$$;
revoke all on function private.close_stale_ops_events(timestamptz,interval) from public,anon,authenticated;

-- proposed/10: حدّ تأكيد العطل لكل مهمة (دقائق) من إيقاعها الفعلي، لا مدة موحّدة:
-- كلها ≥ 4× دورة المهمة، فلا يُعدّ إطفاء/انقطاع إنترنت قصير عطلاً مؤكداً.
-- ameen-main = 720 د (12 ساعة): ساعات العمل الرسمية غير مثبتة فلا تُفترض؛ إطفاء الأجهزة
-- الليلي المعتاد لا يتحوّل إلى عطل مؤكَّد، وإطفاء أطول (عطلة/عطل فعلي) يظهر في التقرير.
update private.project_task_monitors m set alert_after_minutes=v.mins
from (values ('ameen-main',720),('customer-balances',120),('customer-movements',180),
 ('customer-invoices',240),('daily-profit',120),('price-sync',180),('invoice-series',120),
 ('item-details',720),('khalil-audit',120),('expense-entries',360)) as v(task_key,mins)
where m.task_key=v.task_key and m.alert_after_minutes is distinct from v.mins;

-- لا مهمة حرجة افتراضياً: توقف وكيل أمين ليس توقفاً للموقع أو المبيعات. آلية 'critical'
-- باقية، لكن الإنذار الفوري يتطلب دليلاً مستقلاً (private.core_outage_verified()).
update private.project_task_monitors set severity='digest' where task_key='ameen-main' and severity<>'digest';

-- أثر العطل على الموقع/البيانات كما يظهر في التقرير اليومي (نص قابل للمراجعة).
update private.project_task_monitors m set impact_note=v.note
from (values
 ('ameen-main','وكيل مزامنة أمين غير متصل: تتوقف تحديثات بيانات أمين على الموقع فقط؛ الموقع والمبيعات لا يتأثران بذلك وحده (قد يكون الجهاز مطفأً)'),
 ('customer-balances','أرصدة الزبائن في الموقع قد تكون قديمة'),
 ('customer-movements','كشوف حركات الزبائن في الموقع غير محدّثة'),
 ('customer-invoices','فواتير الزبائن الجديدة قد لا تظهر في الموقع'),
 ('daily-profit','رقم الربح اليومي في الموقع غير محدّث'),
 ('price-sync','تغييرات الأسعار من أمين قد لا تصل للموقع'),
 ('invoice-series','أرقام/سلاسل الفواتير في الموقع غير محدّثة'),
 ('item-details','تفاصيل المواد والمخزون في الموقع قد تكون قديمة'),
 ('khalil-audit','سجل تدقيق خليل لا يُرفع'),
 ('expense-entries','حركات المصاريف الجديدة لا تظهر في الموقع ولا في التقرير المسائي')
) as v(task_key,note)
where m.task_key=v.task_key and m.impact_note is distinct from v.note;

-- proposed/10: قرار الإبلاغ كدالة نقية قابلة للاختبار الحتمي (الملخص اليومي فقط).
--   'ok'      سليم ولا إنذار فوري سابق ⇒ لا شيء
--   'recover' سليم بعد إنذار فوري أُرسل فعلاً (حرج فقط) ⇒ رسالة تعافٍ واحدة
--   'track'   متأخر دون حدّ التأكيد ⇒ تسجيل داخلي فقط
--   'open'    عطل مؤكّد غير حرج ⇒ يُسجَّل ويظهر في التقرير اليومي (بلا Telegram)
--   'alert'   عطل مؤكّد حرج ومُتحقَّق منه ولم يُنذَر عنه ⇒ إنذار فوري واحد
--   'hold'    عطل مؤكّد حرج سبق الإنذار عنه ⇒ صمت
create or replace function private.project_task_alert_decision(
  p_has_report boolean, p_age_minutes numeric, p_backlogged boolean,
  p_fault_minutes numeric, p_max_age integer, p_alert_after integer,
  p_critical boolean, p_verified boolean, p_alerted boolean)
returns text language sql immutable
as $$
 select case
  when not (not p_has_report or p_age_minutes>p_max_age or p_backlogged) then
   case when p_alerted then 'recover' else 'ok' end
  when not (not p_has_report or p_age_minutes>=p_alert_after
            or (p_backlogged and p_fault_minutes>=p_alert_after)) then 'track'
  when p_alerted then 'hold'
  when p_critical and p_verified then 'alert'
  else 'open'
 end
$$;
revoke all on function private.project_task_alert_decision(boolean,numeric,boolean,numeric,integer,integer,boolean,boolean,boolean)
  from public,anon,authenticated;

-- كشف غياب التقرير المسائي (مستقل عن مهمته send-evening-report).
-- الدليل هو الإرسال الفعلي: صف public.telegram_outbox بنوع evening_report أُنشئ اليوم (بتوقيت
-- دمشق) وحالته dispatched/sent (أو pending حديث < 10 د بانتظار المُرسِل) — لا نجاح cron ولا غيابه.
-- يعمل من المراقب كل 5 دقائق، فيكشف توقف المهمة نفسها بلا سجل تشغيل (cron لم يطلقها أصلاً).
--   • قبل 20:15 دمشق: لا شيء (غياب التقرير قبل موعده ليس عطلاً). 20:15 = 15 د سماح بعد الموعد.
--   • بعد 20:15 ولا دليل: تنبيه واحد في اليوم (dedupe 1440 د) + حدث ops_events لقسم الملخص.
--   • وصل التقرير (ولو متأخراً/بإعادة محاولة): يُغلق الحدث داخلياً بلا رسالة.
--   • تغيّر اليوم: مفتاح اليوم الجديد؛ حدث الأمس المفتوح يبقى ظاهراً في تقرير الغد ثم يُغلق عند وصوله.
-- p_now للاختبار فقط؛ أي خطأ هنا لا يُسقط المراقب.
create or replace function private.check_evening_report_delivered(p_now timestamptz default now())
returns void language plpgsql security definer
set search_path=private,public,pg_temp
as $$
declare dam timestamp; day_start timestamptz; day_key text; delivered boolean;
begin
 dam:=p_now at time zone 'Asia/Damascus';
 if dam::time < time '20:15' then return; end if;
 day_start:=date_trunc('day',dam) at time zone 'Asia/Damascus';
 day_key:='evening-missing:'||to_char(dam,'YYYY-MM-DD');
 select exists(select 1 from public.telegram_outbox
   where event_type='evening_report' and created_at>=day_start and created_at<=p_now
     and (status in ('dispatched','sent') or (status='pending' and created_at>p_now-interval '10 minutes')))
  into delivered;
 if delivered then
  update private.ops_events set resolved_at=p_now
   where source='report' and event_key like 'evening-missing:%' and resolved_at is null;
  return;
 end if;
 perform private.observe_ops_event('report',day_key,'التقرير المسائي اليومي لم يصل',
  'لم يُسجَّل إرسال التقرير بعد 20:15 بتوقيت دمشق',(date_trunc('day',dam)+interval '20 hours') at time zone 'Asia/Damascus');
 perform public.notify_telegram('project_task_failure',
  format('🚨 التقرير المسائي اليومي لم يصل%1$s• الموعد: 20:00 بتوقيت دمشق%1$s• لا دليل على إرساله بعد 20:15%1$s• لن تصلك قائمة الأعطال حتى يُصلَح.',chr(10)),
  day_key,1440);
exception when others then
 raise warning 'check_evening_report_delivered: %',sqlerrm;
end $$;
revoke all on function private.check_evening_report_delivered(timestamptz) from public,anon,authenticated;

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
 previous_fault_since timestamptz; fault_start timestamptz; fault_origin timestamptz; alert_after integer;
 is_alerted boolean; decision text; is_critical boolean; is_verified boolean;
begin
 -- دورتان متداخلتان (تأخر دورة سابقة) لا تعملان معاً: الثانية تخرج بلا أثر.
 if not pg_try_advisory_xact_lock(hashtextextended('monitor_project_tasks',0)) then
  return;
 end if;
 -- سجلّ التدقيق يُحتفظ به 180 يوماً ثم يُقلَّم.
 delete from private.project_task_incidents where ended_at < now()-interval '180 days';
 -- غياب التقرير المسائي: كشف مستقل عن مهمته (راجع الدالة).
 perform private.check_evening_report_delivered();
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
  is_critical:=cfg.severity='critical';
  -- is_alerted: أُرسل إنذار فوري فعلاً (حرج فقط). last_alert_at لا يُسجَّل إلا بعد
  -- نجاح notify_telegram، وتُصفَّر عند التعافي.
  is_alerted:=previous_healthy=false and previous_alert_at is not null;
  -- بداية العطل = لحظة تجاوز الحداثة (آخر نجاح + max_age) لا لحظة أول رصد، فلا
  -- تُزاح البداية عند أول تشغيل بعد التفعيل. الاستمرار يحتفظ بالقيمة المحفوظة.
  fault_origin:=case when last_at is null then now() else least(now(),last_at+make_interval(mins=>cfg.max_age_minutes)) end;
  fault_start:=case when previous_healthy=false then coalesce(previous_fault_since,fault_origin) else fault_origin end;
  -- تحقق من الحرج: صمت تقارير أمين نفسها ليس دليلاً مستقلاً على توقف الموقع/المبيعات
  -- (قناة وكيل أمين هي المعطوبة نفسها). الدليل المستقل = core_outage_verified() فقط.
  is_verified:=is_critical and private.core_outage_verified();
  decision:=private.project_task_alert_decision(
   last_at is not null, age_minutes, is_backlogged,
   round(extract(epoch from(now()-fault_start))/60.0,1),
   cfg.max_age_minutes, alert_after, is_critical, is_verified, is_alerted);

  if decision in ('track','open','alert','hold') then
   detail_text:=case
    when last_at is null then 'لم يصل أي تقرير حتى الآن'
    when last_at<now()-make_interval(mins=>cfg.max_age_minutes) then
     format('آخر نجاح منذ %s دقيقة عند %s',age_minutes,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'))
    else
     format('تراكم محتمل (status=%s) — آخر دفعة كاملة عند %s',last_status,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI'))
    end;
   if decision='track' then
    detail_text:='تأخر دون حدّ التأكيد (تسجيل داخلي فقط) — '||detail_text;
   end if;
   if decision='alert' then
    -- إنذار فوري واحد للحرج المتحقَّق منه فقط. previous_alert_at لا يُسجَّل إلا
    -- بعد قبول الإدراج في telegram_outbox دون استثناء؛ عند فشله تُعاد المحاولة.
    -- مفتاح dedupe = هوية العطل (fault_start) فلا تتكرر الرسالة.
    begin
     perform public.notify_telegram('project_task_failure',
      format('🚨 توقف كامل مؤكَّد: %2$s%1$s• المصدر: %3$s%1$s• الحالة: %4$s%1$s• الأثر: %5$s',
       chr(10),cfg.task_label,cfg.report_source,detail_text,coalesce(cfg.impact_note,'—')),
      'project-task-failure:'||cfg.task_key||':'||to_char(fault_start,'YYYYMMDDHH24MISSMS'),1);
     previous_alert_at:=now();
    exception when others then
     raise warning 'monitor_project_tasks: notify_telegram failed for %: %',cfg.task_key,sqlerrm;
    end;
   end if;
   -- سجلّ العطل المفتوح (يُكتب دائماً، حتى بلا أي تنبيه).
   insert into private.project_task_incidents(task_key,started_at,confirmed_at,last_success_at,last_seen_at,detail,alerted)
    values(cfg.task_key,fault_start,case when decision='track' then null else now() end,last_at,now(),detail_text,previous_alert_at is not null)
    on conflict(task_key) where ended_at is null do update set
     confirmed_at=coalesce(private.project_task_incidents.confirmed_at,excluded.confirmed_at),
     last_success_at=excluded.last_success_at,last_seen_at=now(),detail=excluded.detail,
     alerted=private.project_task_incidents.alerted or excluded.alerted;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_success_at,last_alert_at,last_detail,fault_since)
    values(cfg.task_key,false,now(),last_at,previous_alert_at,detail_text,fault_start)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_success_at=excluded.last_success_at,
     last_alert_at=excluded.last_alert_at,last_detail=excluded.last_detail,fault_since=excluded.fault_since;
  else
   -- تعافٍ: لا رسالة مستقلة للأعطال غير الحرجة (تُسجَّل داخلياً فقط)؛ رسالة تعافٍ
   -- واحدة فقط لحرج أُنذر عنه فعلاً (decision='recover').
   if decision='recover' then
    perform public.notify_telegram('project_task_recovered',
     format('✅ عادت المهمة للعمل%1$s• المهمة: %2$s%1$s• المصدر: %3$s%1$s• آخر نجاح: %4$s',
      chr(10),cfg.task_label,cfg.report_source,to_char(last_at at time zone 'Asia/Riyadh','YYYY-MM-DD HH24:MI')),
     'project-task-recovered:'||cfg.task_key||':'||to_char(now(),'YYYYMMDDHH24MI'),1);
   end if;
   update private.project_task_incidents set ended_at=now(),last_seen_at=now()
    where task_key=cfg.task_key and ended_at is null;
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
    -- سياسة الملخص اليومي: فشل مهمة cron يُسجَّل في سجلّ الحوادث الموحَّد ويظهر في
    -- قسم «حالة الأنظمة والأعطال» بالتقرير المسائي، بلا Telegram مستقل ولا تكرار ساعي.
    -- previous_alert_at يعني الآن «سُجِّل» (آلة الحالة محفوظة كما هي لاختبارات PR #220).
    -- التسجيل الفعلي في ops_events يجري بلا شرط أدناه (observe_ops_event) كل دورة، لا هنا:
    -- حارس should_alert يُخفي العطل القائم قبل التفعيل (previous_alert_at حديث أو فشل
    -- أُنذر عنه بالنظام القديم) فيغيب عن التقرير اليومي.
    begin
     -- استثناء وحيد من «ملخص يومي فقط»: مهمة التقرير المسائي نفسها هي ناقل الملخص، فعطلها
     -- لا يمكن أن يظهر في الملخص. تُنبَّه فوراً (مفتاح dedupe نفسه، مرة لكل حادثة ثم ساعياً
     -- لحالتي stuck/disabled)، وإن فشل الإرسال لا تتقدّم حالة التنبيه فيُعاد بالدورة التالية.
     if job_record.jobname='send-evening-report'
        and (previous_alerted_health is distinct from job_health
             or (job_health='failed' and previous_alerted_terminal_at is distinct from terminal_at)) then
      -- تنبيه واحد لكل حادثة مؤكدة (فشل نهائي بـterminal_at جديد أو انتقال تصنيف): بلا تذكير ساعي،
      -- وغياب التقرير قبل موعده ليس عطلاً (التصنيف يعتمد على سجلّ تشغيل فعلي فاشل/عالق/معطّل فقط).
      perform public.notify_telegram('project_task_failure',
       format('🚨 تقرير المساء اليومي لا يعمل%1$s• المهمة: %2$s%1$s• الحالة: %3$s%1$s• لن تصلك قائمة الأعطال حتى يُصلَح.',chr(10),job_record.jobname,detail_text),
       failure_dedupe_key,60);
     end if;
     previous_alert_at:=now();
     if job_health='failed' then
      previous_alerted_terminal_at:=terminal_at;
      previous_alerted_health_since:=null;
     else
      previous_alerted_health_since:=health_incident_since;
     end if;
     previous_alerted_health:=job_health;
    exception when others then
     raise warning 'monitor_project_tasks: state update failed for cron:%: %',job_record.jobname,sqlerrm;
    end;
   end if;
   -- رصد بلا شرط: كل دورة يبقى العطل القائم مفتوحاً في السجلّ الموحَّد (يظهر في التقرير
   -- المسائي) سواء أُنذر عنه سابقاً أم لا. بداية العطل = آخر تشغيل نهائي/جارٍ إن عُرف.
   begin
    perform private.observe_ops_event('cron',job_record.jobname,'مهمة مجدولة: '||job_record.jobname,detail_text,
     coalesce(terminal_at,last_job_at));
   exception when others then
    raise warning 'monitor_project_tasks: observe_ops_event failed for cron:%: %',job_record.jobname,sqlerrm;
   end;
   insert into private.project_task_health_state(task_key,is_healthy,last_observed_at,last_alert_at,last_alerted_terminal_at,last_alerted_health,last_alerted_health_since,last_detail)
    values('cron:'||job_record.jobname,false,now(),previous_alert_at,previous_alerted_terminal_at,previous_alerted_health,previous_alerted_health_since,detail_text)
    on conflict(task_key) do update set is_healthy=false,last_observed_at=now(),last_alert_at=excluded.last_alert_at,
     last_alerted_terminal_at=excluded.last_alerted_terminal_at,last_alerted_health=excluded.last_alerted_health,
     last_alerted_health_since=excluded.last_alerted_health_since,
     last_detail=excluded.last_detail;
  elsif job_health = 'ok' then
   -- 'ok' وحدها تمنح شهادة النجاح. لا محاولة قيد التنفيذ، ولا مهمة لم تُشغَّل.
   -- يُغلَق أي حدث مفتوح عند كل نجاح مُشاهَد (idempotent) دون شرط على is_healthy:
   -- بعد تراجع/إعادة تطبيق قد يبقى حدث مفتوح وحالة صحية true.
   perform private.resolve_ops_event('cron',job_record.jobname);
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
   -- حكم سابق غير سليم يبقى قائماً أثناء محاولة جارية: لا يُعتبر الحدث يتيماً.
   update private.ops_events set last_seen_at=now()
    where source='cron' and event_key=job_record.jobname and resolved_at is null;
  end if;
 end loop;
 -- أحداث cron اليتيمة (مهمة حُذفت من cron.job فلا تُرصد ولا تعود «سليمة»): تُغلق بعد ساعة صمت.
 update private.ops_events set resolved_at=now()
  where source='cron' and resolved_at is null and last_seen_at<now()-interval '1 hour';
 perform private.close_stale_ops_events();
end $$;

revoke all on function private.monitor_project_tasks() from public,anon,authenticated;

-- تهيئة الأعطال المفتوحة قبل/عند التفعيل: تنتظر دورة المراقب الجارية (قفل صريح، وهو
-- يُعاد دخوله داخل المراقب) ثم تشغّل دورة كاملة فتُسجَّل الأعطال القائمة فوراً —
-- مهام المشروع من آخر نجاح فعلي، ومهام cron الفاشلة حالياً بلا اشتراط تنبيه سابق.
-- idempotent: الفهارس الفريدة (حادثة مفتوحة واحدة لكل مهمة/حدث) تمنع التكرار.
create or replace function private.seed_open_faults()
returns void language plpgsql security definer set search_path=private,public,cron,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('monitor_project_tasks',0));
 perform private.monitor_project_tasks();
end $$;
revoke all on function private.seed_open_faults() from public,anon,authenticated;

-- proposed/10: قسم «حالة الأنظمة والأعطال» في آخر التقرير المسائي.
-- يقرأ الأعطال المفتوحة المؤكَّدة من مصدرين فقط: project_task_incidents وops_events
-- (لا يعتمد على أي تنبيه سابق): كل عطل مرة واحدة، ويستمر ظهوره في كل تقرير يومي
-- حتى يُحلّ. أعطال المراقبات المعطّلة تبقى ظاهرة مع وسم صريح (لا تختفي صامتةً).
-- الحدّ الآمن للطول p_max_chars: الأعطال مرتّبة بالأهمية (حرج، ثم مهام المزامنة،
-- ثم cron، ثم أحداث Windows/GitHub، ثم الأقدم)؛ إن ضاقت الميزانية تُختصر الأسطر
-- ثم يُذكر عدد ما لم يُعرض. p_now وسيط صريح كي تبقى الاختبارات حتمية.
drop function if exists private.daily_open_faults_section(timestamptz);
create or replace function private.daily_open_faults_section(p_now timestamptz default now(), p_max_chars integer default 1500)
returns text language plpgsql stable security definer
set search_path=private,public,pg_temp
as $$
declare last_obs timestamptz; r record; n int:=0; mins numeric; dur text; full_t text; short_t text;
 hdr text; guard text:=''; body text:=''; hidden int:=0; compact boolean:=false;
 budget int:=greatest(coalesce(p_max_chars,1500),200); reserve int:=90;
begin
 select max(s.last_observed_at) into last_obs
  from private.project_task_health_state s
  join private.project_task_monitors m on m.task_key=s.task_key and m.enabled;
 if last_obs is null or last_obs<p_now-interval '30 minutes' then
  guard:=chr(10)||'⚠️ تعذّر التحقق من حالة الأنظمة: آخر فحص للمراقبة '
   ||coalesce(to_char(last_obs at time zone 'Asia/Damascus','YYYY-MM-DD HH24:MI'),'غير معروف')||' بتوقيت دمشق.';
 end if;
 select count(*) into n from (
  select 1 from private.project_task_incidents where ended_at is null and confirmed_at is not null
  union all select 1 from private.ops_events where resolved_at is null) c;
 hdr:='🛠 حالة الأنظمة والأعطال'||case when n>0 then ' ('||n||')' else '' end||guard;
 if n=0 then
  return case when guard<>'' then hdr else hdr||chr(10)||'✅ لا توجد أعطال تشغيلية مستمرة' end;
 end if;
 for r in
  select * from (
   select case when m.severity='critical' then 0 else 1 end as rnk,
    coalesce(m.task_label,i.task_key) as label, i.started_at as started, i.last_success_at as last_ok,
    coalesce(m.impact_note,'—') as note, 1 as occ, (m.task_key is null or not m.enabled) as off,
    false as is_ops, i.task_key as k
   from private.project_task_incidents i
   left join private.project_task_monitors m on m.task_key=i.task_key
   where i.ended_at is null and i.confirmed_at is not null
   union all
   select case when e.severity='critical' then 0 when e.source='cron' then 2 else 3 end,
    e.label, e.first_seen_at, null::timestamptz, coalesce(left(e.detail,140),'—'), e.occurrences, false,
    true, e.source||':'||e.event_key
   from private.ops_events e where e.resolved_at is null
  ) q order by rnk, started, k
 loop
  mins:=greatest(0,floor(extract(epoch from(p_now-r.started))/60.0));
  dur:=case
   when mins>=1440 then format('%s يوم و%s ساعة',floor(mins/1440),floor((mins-floor(mins/1440)*1440)/60))
   when mins>=60 then format('%s ساعة و%s دقيقة',floor(mins/60),mins-floor(mins/60)*60)
   else format('%s دقيقة',mins) end;
  full_t:=chr(10)||'• '||r.label||chr(10)
   ||'  بدأ: '||to_char(r.started at time zone 'Asia/Damascus','YYYY-MM-DD HH24:MI')||' — مستمر منذ '||dur||chr(10)
   ||case when r.is_ops then case when r.occ>1 then '  تكرر: '||r.occ||' مرة'||chr(10) else '' end
          else '  آخر نجاح: '||coalesce(to_char(r.last_ok at time zone 'Asia/Damascus','YYYY-MM-DD HH24:MI'),'غير معروف')||chr(10) end
   ||case when r.is_ops then '  التفاصيل: ' else '  الأثر: ' end||r.note
   ||case when r.off then chr(10)||'  ⚠️ المراقبة معطّلة — حالة هذا العطل غير محدّثة' else '' end;
  short_t:=chr(10)||'• '||r.label||' — منذ '||dur||case when r.off then ' (المراقبة معطّلة)' else '' end;
  if not compact and length(hdr)+length(body)+length(full_t)<=budget-reserve then
   body:=body||full_t;
  else
   compact:=true;
   if length(hdr)+length(body)+length(short_t)<=budget-reserve then body:=body||short_t;
   else hidden:=hidden+1; end if;
  end if;
 end loop;
 return hdr||body||case when hidden>0 then chr(10)||'… و'||hidden||' أعطال أخرى غير معروضة (راجع سجل الأعطال)' else '' end;
end;
$$;
revoke all on function private.daily_open_faults_section(timestamptz,integer) from public,anon,authenticated;

-- (4) تهيئة الأعطال المفتوحة قبل الرقعة ------------------------------------------------
select private.seed_open_faults();

-- (5) proposed/11 ------------------------------------------------------------------
do $patch$
declare
  def text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
  addition constant text := $b$begin
    msg := msg || chr(10) || chr(10) || coalesce(private.daily_open_faults_section(now(), greatest(3900 - length(msg) - 2, 200)), '');
  exception when others then
    msg := msg || chr(10) || chr(10) || '🛠 حالة الأنظمة والأعطال' || chr(10) || '⚠️ تعذّر إعداد هذا القسم.';
  end;
  $b$;
begin
  select pg_get_functiondef('public.send_evening_report()'::regprocedure) into def;
  if position('daily_open_faults_section' in def) > 0 then
    raise notice 'send_evening_report: already patched, skipping';
    return;
  end if;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'send_evening_report: anchor not found exactly once; aborting without change';
  end if;
  execute replace(def, anchor, addition || anchor);
end
$patch$;

-- (6) تحقق بعدي (أي فشل يتراجع بكل شيء) ----------------------------------------------
do $post$
declare mon text; ev text; sec text;
begin
  select prosrc into mon from pg_proc where oid = to_regprocedure('private.monitor_project_tasks()');
  if md5(mon) <> 'd695a9aea9c75bdd302e40ddd8b16204' then raise exception 'postflight: monitor body differs from the bundled definition (md5 %)', md5(mon); end if;
  if (length(mon) - length(replace(mon, 'public.notify_telegram(', ''))) / length('public.notify_telegram(') <> 3 then
    raise exception 'postflight: monitor must contain exactly 3 notify_telegram calls (critical, recovery, evening-report job failure)';
  end if;
  select pg_get_functiondef(to_regprocedure('public.send_evening_report()')) into ev;
  if position('daily_open_faults_section' in ev) = 0 then raise exception 'postflight: evening report not patched'; end if;
  sec := private.daily_open_faults_section(now(), 1500);
  if sec is null or position('حالة الأنظمة والأعطال' in sec) = 0 then raise exception 'postflight: section builder failed'; end if;
end $post$;
