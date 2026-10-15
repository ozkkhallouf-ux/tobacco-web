-- proposed/15-ameen-sync-outage-incident.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة، ويُطبَّق بعد 12 ثم 13 فقط.**
--
-- المشكلة: انقطاع واحد لمزامنة الأمين على جهاز OZK2026 (إطفاء، صيانة، تعطّل المهام) يظهر اليوم
-- كسبع رسائل «🚨 توقفت مهمة بالمشروع» منفصلة + رسالة «⏳ تنبيهات النفاد متوقفة» + سبع رسائل تعافٍ.
-- الحزمة 12 تُسكت رسائل المهام المنفردة (ملخص مسائي فقط) لكنها لا تُرسل أي إنذار فوري حتى لو
-- طال الانقطاع الكامل ساعات (core_outage_verified() = false). هذه الحزمة تسدّ الفجوة:
--
--   * حادثة واحدة لكل جهاز (private.sync_outage_incidents): تُفتح حين تتقادم ≥ 3 مهام مزامنة
--     «مترابطة» (آخر نجاح لكل منها ضمن 60 دقيقة من أحدثها، فالمهمة المعطوبة منذ أيام لا تُحسب
--     سبباً مشتركاً). بدايتها = أحدث آخر نجاح بين المهام المتقادمة (لحظة توقف المزامنة فعلاً).
--   * إنذار فوري **واحد** فقط حين تبلغ مدة الانقطاع داخل ساعات الدوام (09:00–23:00 دمشق) 60 دقيقة.
--     العدّاد تراكمي داخل الانقطاع المتصل نفسه. لا تكرار: alerted_at يُكتب في معاملة الإرسال نفسها،
--     ومفتاح منع التكرار = هوية الحادثة، والقفل الاستشاري يمنع دورتين متزامنتين.
--   * رسالة تعافٍ واحدة فقط (قرار عمر 2026-10-15) ولحادثة أُرسل عنها إنذار فقط، وبعد ثبات التعافي
--     مهلة الدمج (15 د) كي لا يكون تعافياً كاذباً: عودة الانقطاع خلال المهلة تعيد فتح الحادثة نفسها
--     بلا إنذار ثانٍ ولا رسالة تعافٍ. إن بقيت مهام متأخرة عند الإرسال تُسمّى صراحةً في الرسالة.
--     recovery_sent_at يُسجَّل في معاملة الإرسال نفسها ⇒ لا تكرار عند إعادة تشغيل المراقب.
--   * تقادم المخزون (stock-priority:stale:*) أثناء حادثة مفتوحة يُدمج فيها ولا يُرسل منفصلاً.
--     دون حادثة مفتوحة يمرّ فورياً كما هو اليوم (لا تغيير).
--   * قسم «🛠 حالة الأنظمة والأعطال» المسائي يُعاد بناؤه بتنسيق موحَّد: المستمر بتفاصيله، ثم كل عطل
--     انتهى خلال 24 ساعة — القصيرة منها أيضاً — بوقت البداية والنهاية والمدة وحالة التعافي.
--     مهام الجهاز التي توقفت بسبب الانقطاع تُطوى تحت الحادثة الواحدة بدل سبعة أسطر.
--
-- لا يمسّ: public.notify_telegram، monitor_project_tasks (بصمة 12)، send_evening_report (كتلة 12 كما هي)،
-- ops_event_route، absorb_digest_alert، refine_immediate_alert، health_lifecycle، ولا أي مسار فوري:
-- الأمن، النسخ الاحتياطي، سلسلة الأسعار، تعطل الموقع، غياب التقرير المسائي — كلها تبقى فورية ومستقلة.
-- لا يمسّ proposed/14 (uptime_ingest يستدعي dispatch بنوع uptime ومفتاح لا يبدأ بـstock-priority:stale:).
--
-- يعدّل دالتين فقط مع لقطة لكل منهما: private.notify_telegram_dispatch (خطّاف دمج تقادم المخزون قبل
-- خطّاف 13) وprivate.daily_open_faults_section (القسم الموحَّد). ويُنشئ مهمة cron واحدة: sync-outage-tick كل 5 دقائق.
--
-- يُشغَّل كطلب واحد (معاملة ضمنية) أو psql --single-transaction.
-- التراجع: 15-ameen-sync-outage-rollback.sql (قبل تراجع 13 ثم 12).
-- الاختبار: supabase/tests/ameen-sync-outage.sim.mjs (إرسال وهمي: telegram_outbox جدول محلي).

do $pre$
declare disp text; sec text; ev text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
  addition constant text := $b$begin
    msg := msg || chr(10) || chr(10) || coalesce(private.daily_open_faults_section(now(), greatest(3900 - length(msg) - 2, 200)), '');
  exception when others then
    msg := msg || chr(10) || chr(10) || '🛠 حالة الأنظمة والأعطال' || chr(10) || '⚠️ تعذّر إعداد هذا القسم.';
  end;
  $b$;
  patched constant text := addition || anchor;
begin
  if to_regclass('private.digest_bundle_snapshot') is null or to_regclass('private.project_task_incidents') is null
     or to_regclass('private.ops_events') is null or to_regclass('private.project_task_monitors') is null then
    raise exception 'proposed/15 requires proposed/12 (digest bundle) to be applied first';
  end if;
  if to_regclass('private.digest_routing_snapshot') is null then
    raise exception 'proposed/15 requires proposed/13 (digest routing) to be applied first';
  end if;
  -- القسم يجب أن يبقى موصولاً بالتقرير المسائي بالنص الدقيق (وإلا فالحوادث المسجَّلة بلا عرض = صامتة)
  ev := pg_get_functiondef(to_regprocedure('public.send_evening_report()'));
  if (length(ev) - length(replace(ev, patched, ''))) / length(patched) <> 1 then
    raise exception 'proposed/15: send_evening_report lacks the exact open-faults block from proposed/12; refusing';
  end if;
  -- بصمتان فقط لكل دالة مُستبدَلة: جسم 13/12 (أول تطبيق) أو جسم 15 نفسه (إعادة التشغيل)
  select prosrc into disp from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)');
  if md5(disp) not in ('f7bee114d77cecea3bf9fceceb24425a', 'c35b5c198c2b10b3901471bf5b1cbec1') then
    raise exception 'proposed/15: notify_telegram_dispatch drifted from the proposed/13 body (md5 %); refusing to overwrite', md5(disp);
  end if;
  select prosrc into sec from pg_proc where oid = to_regprocedure('private.daily_open_faults_section(timestamptz,integer)');
  if md5(sec) not in ('dc646928b3f107fcfe5c210d67543d44', 'd5bb80ca095984e779928b57ab1f3a95') then
    raise exception 'proposed/15: daily_open_faults_section drifted from the proposed/12 body (md5 %); refusing to overwrite', md5(sec);
  end if;
end $pre$;

-- لقطة قبل التعديل (مرة واحدة: إعادة التطبيق لا تسجّل جسم 15 كأصل)
create table if not exists private.sync_outage_snapshot(
  fn text primary key, def text not null, taken_at timestamptz not null default now());
alter table private.sync_outage_snapshot enable row level security;
revoke all on private.sync_outage_snapshot from public, anon, authenticated;
insert into private.sync_outage_snapshot(fn, def)
  select 'private.notify_telegram_dispatch(text,text,text,integer,jsonb)',
         pg_get_functiondef(to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))
  where position('ameen-outage:v1' in (select prosrc from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) = 0
  on conflict (fn) do nothing;
insert into private.sync_outage_snapshot(fn, def)
  select 'private.daily_open_faults_section(timestamptz,integer)',
         pg_get_functiondef(to_regprocedure('private.daily_open_faults_section(timestamptz,integer)'))
  where position('sync-outage-section:v1' in (select prosrc from pg_proc where oid = to_regprocedure('private.daily_open_faults_section(timestamptz,integer)'))) = 0
  on conflict (fn) do nothing;

-- ── الإعداد ──────────────────────────────────────────────────────────────────────────────────
create table if not exists private.sync_outage_config (
  device text primary key,
  label text not null,
  enabled boolean not null default true,
  min_stale_tasks integer not null default 3 check (min_stale_tasks >= 2),
  correlation_minutes integer not null default 60 check (correlation_minutes between 5 and 1440),
  alert_after_business_minutes integer not null default 60 check (alert_after_business_minutes between 5 and 1440),
  business_start time not null default '09:00',
  business_end time not null default '23:00',
  business_tz text not null default 'Asia/Damascus',
  -- دورة متأخرة بعد نهاية الدوام بقليل ما زالت تُنذر عن عبور حدّ حصل داخل الدوام
  alert_grace_minutes integer not null default 10 check (alert_grace_minutes between 0 and 60),
  merge_gap_minutes integer not null default 15 check (merge_gap_minutes between 0 and 240),
  send_recovery boolean not null default true,
  check (business_end > business_start)
);
alter table private.sync_outage_config enable row level security;
revoke all on private.sync_outage_config from public, anon, authenticated;
insert into private.sync_outage_config(device, label) values ('OZK2026', 'مزامنة الأمين على OZK2026')
  on conflict (device) do nothing;

create table if not exists private.sync_outage_members (
  device text not null references private.sync_outage_config(device) on delete cascade,
  task_key text not null references private.project_task_monitors(task_key) on delete cascade,
  primary key (device, task_key)
);
alter table private.sync_outage_members enable row level security;
revoke all on private.sync_outage_members from public, anon, authenticated;
-- كل مهام tools/*.ps1 المراقَبة تعمل من OZK2026 (يسجّلها ensure-ameen-sync.ps1 هناك)
insert into private.sync_outage_members(device, task_key)
  select 'OZK2026', m.task_key from private.project_task_monitors m
  where m.task_key in ('ameen-main','customer-balances','customer-movements','customer-invoices','daily-profit',
                       'price-sync','invoice-series','item-details','khalil-audit','expense-entries')
  on conflict do nothing;

create table if not exists private.sync_outage_incidents (
  id bigserial primary key,
  device text not null,
  started_at timestamptz not null,
  detected_at timestamptz not null,
  last_seen_at timestamptz not null,
  ended_at timestamptz,
  peak_stale integer not null default 0,
  affected_tasks text[] not null default '{}',
  task_details jsonb,
  business_minutes numeric not null default 0,
  alerted_at timestamptz,
  alert_key text,
  recovery_sent_at timestamptz,
  reopened integer not null default 0,
  stock_stale_absorbed integer not null default 0,
  stock_stale_last_at timestamptz,
  stock_stale_detail text
);
create unique index if not exists sync_outage_incidents_one_open
  on private.sync_outage_incidents(device) where ended_at is null;
alter table private.sync_outage_incidents enable row level security;
revoke all on private.sync_outage_incidents from public, anon, authenticated;

-- ── أدوات الوقت ──────────────────────────────────────────────────────────────────────────────
-- دقائق التقاطع بين [p_from, p_to] وساعات الدوام اليومية بالتوقيت المحلي.
create or replace function private.sync_outage_business_minutes(
  p_from timestamptz, p_to timestamptz, p_start time, p_end time, p_tz text)
returns numeric language sql stable as $$
 select coalesce(round(sum(greatest(0, extract(epoch from (
          least(p_to, (d::date + p_end) at time zone p_tz) - greatest(p_from, (d::date + p_start) at time zone p_tz))) / 60.0)), 1), 0)
 from generate_series((p_from at time zone p_tz)::date, (p_to at time zone p_tz)::date, interval '1 day') d
 where p_to > p_from and p_end > p_start
$$;
revoke all on function private.sync_outage_business_minutes(timestamptz,timestamptz,time,time,text) from public, anon, authenticated;

create or replace function private.sync_outage_in_business(p_at timestamptz, p_start time, p_end time, p_tz text)
returns boolean language sql stable as $$
 select (p_at at time zone p_tz)::time >= p_start and (p_at at time zone p_tz)::time < p_end
$$;
revoke all on function private.sync_outage_in_business(timestamptz,time,time,text) from public, anon, authenticated;

-- نص موحَّد للأرقام والأوقات داخل نص عربي: كل قيمة محصورة بـLRI…PDI فلا تنقلب في Telegram.
create or replace function private.ops_fmt_iso(p_text text)
returns text language sql immutable as $$ select chr(8294) || coalesce(p_text, '') || chr(8297) $$;
revoke all on function private.ops_fmt_iso(text) from public, anon, authenticated;

create or replace function private.ops_fmt_duration(p_minutes numeric)
returns text language sql immutable as $$
 select case
  when m >= 1440 then private.ops_fmt_iso((m / 1440)::text) || ' يوم'
    || case when (m % 1440) / 60 > 0 then ' و' || private.ops_fmt_iso(((m % 1440) / 60)::text) || ' ساعة' else '' end
  when m >= 60 then private.ops_fmt_iso((m / 60)::text) || ' ساعة'
    || case when m % 60 > 0 then ' و' || private.ops_fmt_iso((m % 60)::text) || ' دقيقة' else '' end
  else private.ops_fmt_iso(m::text) || ' دقيقة' end
 from (select greatest(0, floor(coalesce(p_minutes, 0)))::bigint as m) x
$$;
revoke all on function private.ops_fmt_duration(numeric) from public, anon, authenticated;

-- الوقت بتوقيت دمشق: «HH:MI» إن كان في يوم p_ref المحلي نفسه، وإلا «MM-DD HH:MI».
create or replace function private.ops_fmt_time(p_at timestamptz, p_ref timestamptz)
returns text language sql stable as $$
 select case when p_at is null then 'غير معروف'
  when (p_at at time zone 'Asia/Damascus')::date = (p_ref at time zone 'Asia/Damascus')::date
   then private.ops_fmt_iso(to_char(p_at at time zone 'Asia/Damascus', 'HH24:MI'))
  else private.ops_fmt_iso(to_char(p_at at time zone 'Asia/Damascus', 'MM-DD HH24:MI')) end
$$;
revoke all on function private.ops_fmt_time(timestamptz,timestamptz) from public, anon, authenticated;

-- ── الرصد ────────────────────────────────────────────────────────────────────────────────────
-- حالة كل مهمة عضو الآن، بنفس مصدر monitor_project_tasks (inventory_reports بالمصدر أو جدول مخصّص).
-- قراءة فقط. التراكم (status<>'ok') ليس انقطاعاً فلا يُحسب هنا.
create or replace function private.sync_outage_observe(p_device text, p_now timestamptz default now())
returns table(task_key text, task_label text, last_at timestamptz, max_age integer, stale boolean)
language plpgsql stable security definer set search_path = private, public, pg_temp as $$
#variable_conflict use_column
declare m record; la timestamptz;
begin
 for m in
  select t.task_key as k, t.task_label as lbl, t.report_source as src, t.source_table as tbl, t.max_age_minutes as age
  from private.sync_outage_members s
  join private.project_task_monitors t on t.task_key = s.task_key and t.enabled
  where s.device = p_device order by t.task_key
 loop
  if m.tbl = 'inventory_reports' then
   select max(r.created_at) into la from public.inventory_reports r where r.source = m.src and r.created_at <= p_now;
  else
   execute format('select max(created_at) from public.%I where created_at <= $1', m.tbl) into la using p_now;
  end if;
  task_key := m.k; task_label := m.lbl; last_at := la; max_age := m.age;
  stale := la is null or la < p_now - make_interval(mins => m.age);
  return next;
 end loop;
end $$;
revoke all on function private.sync_outage_observe(text,timestamptz) from public, anon, authenticated;

-- نص الإنذار الفوري الوحيد للحادثة
create or replace function private.sync_outage_message(p_id bigint, p_now timestamptz default now())
returns text language plpgsql stable security definer set search_path = private, public, pg_temp as $$
declare i record; c record; names text; nl constant text := chr(10); rlm constant text := chr(8207);
begin
 select * into i from private.sync_outage_incidents where id = p_id;
 select * into c from private.sync_outage_config where device = i.device;
 select string_agg(coalesce(m.task_label, a.k), '، ' order by a.k) into names
  from unnest(i.affected_tasks) a(k) left join private.project_task_monitors m on m.task_key = a.k;
 return '🚨 انقطاع مزامنة الأمين — ' || private.ops_fmt_iso(i.device) || nl
  || rlm || '• البداية: ' || private.ops_fmt_iso(to_char(i.started_at at time zone c.business_tz, 'YYYY-MM-DD HH24:MI')) || ' بتوقيت دمشق' || nl
  || rlm || '• المدة: ' || private.ops_fmt_duration(extract(epoch from (p_now - i.started_at)) / 60)
         || ' (منها ' || private.ops_fmt_duration(i.business_minutes) || ' ضمن الدوام)' || nl
  || rlm || '• المهام المتوقفة (' || private.ops_fmt_iso(cardinality(i.affected_tasks)::text) || '): ' || coalesce(names, '—') || nl
  || case when i.stock_stale_absorbed > 0 then rlm || '• تنبيهات النفاد متوقفة أيضاً (بيانات المخزون قديمة) — مُدمجة هنا' || nl else '' end
  || rlm || '• الأثر: أرصدة المخزون والزبائن والفواتير على الموقع وفي البوت لا تتحدّث.' || nl
  || rlm || 'لن يُرسَل تنبيه آخر لهذا الانقطاع؛ ستصلك رسالة واحدة عند ثبات التعافي.';
end $$;
revoke all on function private.sync_outage_message(bigint,timestamptz) from public, anon, authenticated;

-- نص رسالة التعافي الوحيدة. p_obs = الرصد الحالي: أي مهمة من مهام الحادثة ما زالت متأخرة تُسمّى صراحةً
-- (لا «عادت كل المهام» إلا إن كانت عادت فعلاً).
create or replace function private.sync_outage_recovery_message(p_id bigint, p_obs jsonb)
returns text language plpgsql stable security definer set search_path = private, public, pg_temp as $$
declare i record; c record; still text; nl constant text := chr(10); rlm constant text := chr(8207);
begin
 select * into i from private.sync_outage_incidents where id = p_id;
 select * into c from private.sync_outage_config where device = i.device;
 select string_agg(e->>'label', '، ' order by e->>'task') into still
  from jsonb_array_elements(coalesce(p_obs, '[]'::jsonb)) e
  where (e->>'stale')::boolean and (e->>'task') = any(i.affected_tasks);
 return '✅ عادت مزامنة الأمين — ' || private.ops_fmt_iso(i.device) || nl
  || rlm || '• الانقطاع: من ' || private.ops_fmt_iso(to_char(i.started_at at time zone c.business_tz, 'YYYY-MM-DD HH24:MI'))
         || ' إلى ' || private.ops_fmt_iso(to_char(i.ended_at at time zone c.business_tz, 'YYYY-MM-DD HH24:MI')) || ' بتوقيت دمشق' || nl
  || rlm || '• المدة: ' || private.ops_fmt_duration(extract(epoch from (i.ended_at - i.started_at)) / 60)
         || ' (منها ' || private.ops_fmt_duration(i.business_minutes) || ' ضمن الدوام)' || nl
  || rlm || '• المهام التي توقفت: ' || private.ops_fmt_iso(cardinality(i.affected_tasks)::text) || nl
  || case when still is not null then rlm || '⚠️ ما زالت متأخرة: ' || still || ' (تُتابَع في التقرير المسائي)'
          else rlm || '• كل المهام عادت للعمل.' end;
end $$;
revoke all on function private.sync_outage_recovery_message(bigint,jsonb) from public, anon, authenticated;

-- خطوة واحدة لجهاز واحد. تُرجع: disabled | none | recovered (أُرسلت رسالة التعافي) | open | reopen | track | alert | recover.
-- p_alert=false: تسجيل فقط (يُستعمل من خطّاف الدمج داخل dispatch، فلا إرسال متداخل).
create or replace function private.sync_outage_step(p_device text, p_now timestamptz default now(), p_alert boolean default true)
returns text language plpgsql security definer set search_path = private, public, pg_temp as $$
declare cfg record; inc record; prev record; obs jsonb; n int; newest timestamptz; stale_keys text[];
 bm numeric; act text; k text; rec boolean := false;
begin
 select * into cfg from private.sync_outage_config c where c.device = p_device;
 if cfg is null or not cfg.enabled then return 'disabled'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sync_outage:' || p_device, 0));

 -- «مترابطة»: متقادمة وآخر نجاح لها ضمن correlation_minutes من أحدث آخر نجاح بين المتقادمات.
 -- المهمة المعطوبة منذ زمن (أو بلا أي تقرير) لا تصنع انقطاعاً مع عطل منفرد آخر.
 with o as (select * from private.sync_outage_observe(p_device, p_now)),
      nw as (select max(o.last_at) as newest from o where o.stale)
 select coalesce(jsonb_agg(jsonb_build_object('task', o.task_key, 'label', o.task_label, 'last_ok', o.last_at,
                    'max_age', o.max_age, 'stale', o.stale) order by o.task_key), '[]'::jsonb),
        max(nw.newest),
        coalesce(array_agg(o.task_key order by o.task_key) filter (where o.stale and o.last_at >= nw.newest - make_interval(mins => cfg.correlation_minutes)), '{}')
   into obs, newest, stale_keys
   from o cross join nw;
 n := cardinality(stale_keys);

 select * into inc from private.sync_outage_incidents i where i.device = p_device and i.ended_at is null;
 if inc.id is null then
  -- رسالة التعافي المؤجّلة: حادثة أُنذر عنها وانتهت منذ أكثر من مهلة الدمج دون أن تعود ⇒ رسالة واحدة.
  -- (المساواة مع المهلة تبقى لإعادة الفتح أدناه، فلا تتعارض الحالتان في الدورة نفسها.)
  if p_alert and cfg.send_recovery then
   select * into prev from private.sync_outage_incidents i
    where i.device = p_device and i.ended_at is not null and i.alerted_at is not null and i.recovery_sent_at is null
      and i.ended_at < p_now - make_interval(mins => cfg.merge_gap_minutes)
    order by i.ended_at limit 1;
   if prev.id is not null then
    perform public.notify_telegram('ameen_sync_outage_recovered', private.sync_outage_recovery_message(prev.id, obs),
      'ameen-sync-outage-recovered:' || p_device || ':' || prev.id, 1440);
    update private.sync_outage_incidents set recovery_sent_at = p_now where id = prev.id;
    rec := true;
   end if;
  end if;
  if n < cfg.min_stale_tasks then return case when rec then 'recovered' else 'none' end; end if;
  -- عودة الانقطاع بعد تعافٍ قصير (إعادة تشغيل/تذبذب) = الحادثة نفسها: لا إنذار جديد ولا رسالة تعافٍ
  select * into prev from private.sync_outage_incidents i
   where i.device = p_device and i.ended_at is not null and i.ended_at >= p_now - make_interval(mins => cfg.merge_gap_minutes)
   order by i.ended_at desc limit 1;
  if prev.id is not null then
   update private.sync_outage_incidents set ended_at = null, reopened = reopened + 1, last_seen_at = p_now,
     peak_stale = greatest(peak_stale, n),
     affected_tasks = (select array_agg(distinct x order by x) from unnest(affected_tasks || stale_keys) x),
     task_details = obs
    where id = prev.id;
   act := 'reopen';
  else
   insert into private.sync_outage_incidents(device, started_at, detected_at, last_seen_at, peak_stale, affected_tasks, task_details)
    values (p_device, least(coalesce(newest, p_now), p_now), p_now, p_now, n, stale_keys, obs);
   act := 'open';
  end if;
 else
  if n < cfg.min_stale_tasks then
   -- انتهاء الحادثة فقط؛ رسالة التعافي (إن لزمت) تُرسل بعد ثبات التعافي مهلة الدمج (أعلاه)
   update private.sync_outage_incidents set ended_at = p_now, last_seen_at = p_now, task_details = obs,
     business_minutes = private.sync_outage_business_minutes(started_at, p_now, cfg.business_start, cfg.business_end, cfg.business_tz)
    where id = inc.id;
   return 'recover';
  end if;
  update private.sync_outage_incidents set last_seen_at = p_now, peak_stale = greatest(peak_stale, n),
    affected_tasks = (select array_agg(distinct x order by x) from unnest(affected_tasks || stale_keys) x),
    task_details = obs
   where id = inc.id;
  act := 'track';
 end if;

 select * into inc from private.sync_outage_incidents i where i.device = p_device and i.ended_at is null;
 bm := private.sync_outage_business_minutes(inc.started_at, p_now, cfg.business_start, cfg.business_end, cfg.business_tz);
 update private.sync_outage_incidents set business_minutes = bm where id = inc.id;
 if p_alert and inc.alerted_at is null and bm >= cfg.alert_after_business_minutes
    and (private.sync_outage_in_business(p_now, cfg.business_start, cfg.business_end, cfg.business_tz)
         or private.sync_outage_in_business(p_now - make_interval(mins => cfg.alert_grace_minutes), cfg.business_start, cfg.business_end, cfg.business_tz)) then
  k := 'ameen-sync-outage:' || p_device || ':' || inc.id;
  -- الإرسال وتسجيل alerted_at في المعاملة نفسها: فشل الإدراج يُلغي الاثنين فتُعاد المحاولة في الدورة التالية
  perform public.notify_telegram('ameen_sync_outage', private.sync_outage_message(inc.id, p_now), k, 1440);
  update private.sync_outage_incidents set alerted_at = p_now, alert_key = k where id = inc.id;
  act := 'alert';
 end if;
 return act;
end $$;
revoke all on function private.sync_outage_step(text,timestamptz,boolean) from public, anon, authenticated;

-- دورة pg_cron: كل جهاز مفعَّل. فشل جهاز لا يوقف غيره (ويُسجَّل تحذيراً).
create or replace function private.sync_outage_tick(p_now timestamptz default now())
returns text language plpgsql security definer set search_path = private, public, pg_temp as $$
declare d record; res text := ''; r text;
begin
 delete from private.sync_outage_incidents where ended_at < p_now - interval '180 days';
 for d in select device from private.sync_outage_config where enabled order by device loop
  begin
   r := private.sync_outage_step(d.device, p_now, true);
  exception when others then
   raise warning 'sync_outage_tick: % failed: %', d.device, sqlerrm;
   r := 'error';
  end;
  res := res || case when res = '' then '' else ',' end || d.device || '=' || r;
 end loop;
 return res;
end $$;
revoke all on function private.sync_outage_tick(timestamptz) from public, anon, authenticated;

-- يدمج تنبيه تقادم المخزون في حادثة انقطاع مفتوحة (السبب مشترك: البيانات نفسها تأتي من الجهاز المنقطع).
-- القرار دائماً على الرصد الحي لحظة التنبيه: الحادثة تُفتح أو تُغلق حسبه (تسجيلاً فقط، بلا إرسال).
-- أي خطأ ⇒ false ⇒ يُرسَل التنبيه كما كان (يفشل مفتوحاً).
create or replace function private.sync_outage_absorb_stock_stale(p_message text, p_key text)
returns boolean language plpgsql security definer set search_path = private, public, pg_temp as $$
declare d record; inc_id bigint;
begin
 if coalesce(p_key, '') not like 'stock-priority:stale:%' then return false; end if;
 for d in select device from private.sync_outage_config where enabled order by device loop
  -- إعادة تحقق حيّة دائماً (لا ثقة بحادثة مفتوحة قديمة: إن توقفت sync-outage-tick تبقى مفتوحة بلا نهاية):
  -- الخطوة تغلقها إن عاد الجهاز، أو تفتحها إن كان منقطعاً فعلاً — تسجيلاً فقط، بلا إرسال.
  perform private.sync_outage_step(d.device, now(), false);
  select id into inc_id from private.sync_outage_incidents where device = d.device and ended_at is null;
  if inc_id is not null then
   update private.sync_outage_incidents
      set stock_stale_absorbed = stock_stale_absorbed + 1, stock_stale_last_at = now(),
          stock_stale_detail = left(btrim(p_message), 300)
    where id = inc_id;
   return true;
  end if;
 end loop;
 return false;
exception when others then
 raise warning 'sync_outage_absorb_stock_stale failed (%), falling back to immediate delivery', sqlerrm;
 return false;
end $$;
revoke all on function private.sync_outage_absorb_stock_stale(text,text) from public, anon, authenticated;

-- ── dispatch: جسم 13 حرفياً + خطّاف الدمج قبله ──────────────────────────────────────────────
create or replace function private.notify_telegram_dispatch(
  p_event_type     text,
  p_message        text,
  p_dedupe_key     text default null,
  p_dedupe_minutes int  default 60,
  p_reply_markup   jsonb default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare rf record; refined boolean := false;
begin
  -- ameen-outage:v1  (proposed/15) — تقادم المخزون أثناء انقطاع مزامنة مفتوح يُدمج في الحادثة؛ أي فشل ⇒ يُرسَل كالمعتاد
  if p_reply_markup is null and coalesce(p_dedupe_key, '') like 'stock-priority:stale:%'
     and p_message is not null and length(trim(p_message)) > 0 then
    begin
      if private.sync_outage_absorb_stock_stale(p_message, p_dedupe_key) then return; end if;
    exception when others then null;
    end;
  end if;
  -- digest-routing:v1  (proposed/13) — غير الحرج يذهب للسجلّ الموحَّد؛ أي فشل ⇒ يُرسَل كالمعتاد
  if p_message is not null and length(trim(p_message)) > 0 and p_reply_markup is null then
    begin
      if private.absorb_digest_alert(p_event_type, p_message, p_dedupe_key) then return; end if;
    exception when others then null;  -- عطل في آلية الملخص لا يمنع التنبيه (أمن/فشل التقرير المسائي مستقلان)
    end;
  end if;
  if p_message is null or length(trim(p_message)) = 0 then return; end if;
  if p_reply_markup is null and p_event_type in ('price_sync_mismatch','price_sync_failure') then
    begin
      select * into rf from private.refine_immediate_alert(p_event_type, p_message, p_dedupe_key);
      if rf.msg is not null and rf.skip then return; end if;
      if rf.msg is not null then
        p_message := rf.msg; p_dedupe_key := rf.dkey; refined := true; -- التكرار حُسم في refine (skip)؛ لا يحجب تبدّلَ الشدة صفٌّ أقدم
      end if;
    exception when others then null;  -- يفشل مفتوحاً: يُرسَل النص الأصلي
    end;
  end if;
  if not refined and p_dedupe_key is not null and exists (
    select 1 from public.telegram_outbox
    where dedupe_key = p_dedupe_key
      and created_at > now() - make_interval(mins => greatest(p_dedupe_minutes, 1))
  ) then
    return;
  end if;
  insert into public.telegram_outbox (event_type, message, dedupe_key, reply_markup)
  values (p_event_type, left(p_message, 3900), p_dedupe_key, p_reply_markup);
end;
$$;
revoke all on function private.notify_telegram_dispatch(text, text, text, int, jsonb) from public, anon, authenticated;
grant execute on function private.notify_telegram_dispatch(text, text, text, int, jsonb) to service_role;

-- ── قسم «حالة الأنظمة والأعطال» الموحَّد ─────────────────────────────────────────────────────
-- sync-outage-section:v1. نفس التوقيع ونفس مصادر 12، بتنسيق واحد لكل عطل:
--   المستمر:  • العنوان / البداية — مستمر منذ / الحالة / الأثر أو التفاصيل   (يُختصر لسطر عند ضيق المساحة)
--   المنتهي (آخر 24 ساعة، القصير أيضاً):  • العنوان: من ‹بداية› إلى ‹نهاية› (‹مدة›) — حالة التعافي
-- مهام الجهاز التي بدأت مع الانقطاع وانتهت معه تُطوى تحت الحادثة (لا سبعة أسطر لعطل واحد).
-- لا يتجاوز p_max_chars أبداً؛ الأولوية للمستمر، ثم المنتهي، ثم عدد ما لم يُعرض.
create or replace function private.daily_open_faults_section(p_now timestamptz default now(), p_max_chars integer default 1500)
returns text language plpgsql stable security definer
set search_path=private,public,pg_temp
as $$
declare
 nl constant text := chr(10); rlm constant text := chr(8207);
 last_obs timestamptz; guard text := ''; hdr text; n int := 0; r record;
 body text := ''; hidden int := 0; compact boolean := false; full_t text; short_t text;
 budget int := greatest(coalesce(p_max_chars, 1500), 200);
 ended_lines text[] := '{}'; ended_hdr text; ended_t text := ''; en int := 0; eshown int := 0; reserve int := 0;
 tail_more text; res text;
begin
 -- sync-outage-section:v1 (proposed/15)
 select max(s.last_observed_at) into last_obs
  from private.project_task_health_state s
  join private.project_task_monitors m on m.task_key = s.task_key and m.enabled;
 if last_obs is null or last_obs < p_now - interval '30 minutes' then
  guard := nl || rlm || '⚠️ تعذّر التحقق من حالة الأنظمة: آخر فحص للمراقبة '
   || coalesce(private.ops_fmt_iso(to_char(last_obs at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI')), 'غير معروف') || ' بتوقيت دمشق.';
 end if;

 -- ── المنتهي خلال 24 ساعة: سطر واحد لكل عطل ──
 for r in
  with outs as (
   select o.*, coalesce(o.ended_at, p_now) as until_ from private.sync_outage_incidents o
   where o.ended_at is null or o.ended_at > p_now - interval '24 hours'),
  folded as (
   -- حادثة مهمة تُطوى تحت انقطاع جهازها إن بدأت ضمنه (أو قبله بمهلة الدمج) وانتهت معه أو ما زال الانقطاع مستمراً
   select distinct i.id from private.project_task_incidents i
   join private.sync_outage_members sm on sm.task_key = i.task_key
   join outs o on o.device = sm.device
   join private.sync_outage_config c on c.device = o.device
   where i.started_at >= o.started_at - make_interval(mins => greatest(c.merge_gap_minutes, 15))
     and i.started_at <= o.until_
     and (o.ended_at is null or (i.ended_at is not null and i.ended_at <= o.ended_at + make_interval(mins => greatest(c.merge_gap_minutes, 15)))))
  select * from (
   select o.ended_at as end_, c.label || ' (' || private.ops_fmt_iso(cardinality(o.affected_tasks)::text) || ' مهام)' as label,
     o.started_at as start_,
     'تعافٍ مؤكَّد' || case when o.alerted_at is not null then '، أُرسل تنبيه فوري' else '، دون تنبيه (لم يبلغ حد الدوام)' end
       || case when o.stock_stale_absorbed > 0 then '، شمل توقف تنبيهات النفاد' else '' end as status
   from outs o join private.sync_outage_config c on c.device = o.device
   where o.ended_at is not null and o.ended_at <= p_now
   union all
   select * from (
    select distinct on (i.task_key) i.ended_at, coalesce(m.task_label, i.task_key), i.started_at,
      case when i.confirmed_at is null then 'تعافٍ مؤكَّد (عطل قصير دون حد التأكيد)' else 'تعافٍ مؤكَّد' end
    from private.project_task_incidents i
    left join private.project_task_monitors m on m.task_key = i.task_key
    where i.ended_at is not null and i.ended_at > p_now - interval '24 hours' and i.ended_at <= p_now
      and i.id not in (select id from folded)
      and not exists (select 1 from private.project_task_incidents x where x.task_key = i.task_key and x.ended_at is null)
    order by i.task_key, i.ended_at desc) t
   union all
   select * from (
    select distinct on (e.source, e.event_key)
      case when e.resolution = 'explicit' then e.resolved_at else e.last_seen_at end, e.label, e.first_seen_at,
      case when e.resolution = 'explicit' then 'تعافٍ مؤكَّد'
           else 'غير مؤكَّد: توقف التكرار دون إشارة تعافٍ (النهاية = آخر رصد)' end
    from private.ops_events e
    where e.resolved_at is not null and e.resolved_at > p_now - interval '24 hours' and e.resolved_at <= p_now
      and not exists (select 1 from private.ops_events x where x.source = e.source and x.event_key = e.event_key and x.resolved_at is null)
    order by e.source, e.event_key, e.resolved_at desc) u
  ) q order by q.end_ desc nulls last
 loop
  en := en + 1;
  ended_lines := ended_lines || (nl || rlm || '• ' || left(r.label, 120) || ': من ' || private.ops_fmt_time(r.start_, p_now)
    || ' إلى ' || private.ops_fmt_time(r.end_, p_now)
    || ' (' || private.ops_fmt_duration(extract(epoch from (r.end_ - r.start_)) / 60) || ') — ' || r.status);
 end loop;
 ended_hdr := nl || nl || '🕘 أعطال انتهت خلال آخر 24 ساعة (' || private.ops_fmt_iso(en::text) || ')';

 -- ── المستمر الآن ──
 select count(*) into n from (
  select 1 from private.sync_outage_incidents where ended_at is null
  union all
  select 1 from private.project_task_incidents i where i.ended_at is null and i.confirmed_at is not null
   and not exists (select 1 from private.sync_outage_incidents o
     join private.sync_outage_members sm on sm.device = o.device and sm.task_key = i.task_key
     join private.sync_outage_config c on c.device = o.device
     where o.ended_at is null and i.started_at >= o.started_at - make_interval(mins => greatest(c.merge_gap_minutes, 15)))
  union all
  select 1 from private.ops_events where resolved_at is null) c;
 hdr := '🛠 حالة الأنظمة والأعطال' || case when n > 0 then ' (' || private.ops_fmt_iso(n::text) || ')' else '' end || guard;
 if n = 0 then
  hdr := hdr || case when guard <> '' then '' else nl || rlm || '✅ لا توجد أعطال تشغيلية مستمرة' end;
 end if;
 if en > 0 then reserve := least(length(ended_hdr) + length(ended_lines[1]), 260) + 60; end if;

 for r in
  select * from (
   -- 0: انقطاع الجهاز (حادثة واحدة تطوي مهامه)
   select 0 as rnk, c.label as label, o.started_at as started, o.last_seen_at as last_ok, false as off,
     'المهام المتوقفة (' || private.ops_fmt_iso(cardinality(o.affected_tasks)::text) || '): '
       || coalesce((select string_agg(coalesce(m.task_label, a.k), '، ' order by a.k)
                    from unnest(o.affected_tasks) a(k) left join private.project_task_monitors m on m.task_key = a.k), '—') as note,
     case when o.alerted_at is not null then 'مستمر، أُرسل تنبيه فوري ' || private.ops_fmt_time(o.alerted_at, p_now)
          else 'مستمر، دون تنبيه فوري (' || private.ops_fmt_duration(o.business_minutes) || ' ضمن الدوام)' end
       || case when o.stock_stale_absorbed > 0 then '، وتنبيهات النفاد متوقفة' else '' end as status,
     'outage' as kind, 'o:' || o.device as k
   from private.sync_outage_incidents o join private.sync_outage_config c on c.device = o.device
   where o.ended_at is null
   union all
   select case when m.severity = 'critical' then 1 else 2 end, coalesce(m.task_label, i.task_key), i.started_at, i.last_success_at,
     (m.task_key is null or not m.enabled), coalesce(m.impact_note, '—'),
     'مستمر' || case when i.alerted then '، أُرسل تنبيه فوري' else '' end, 'task', i.task_key
   from private.project_task_incidents i
   left join private.project_task_monitors m on m.task_key = i.task_key
   where i.ended_at is null and i.confirmed_at is not null
     and not exists (select 1 from private.sync_outage_incidents o
       join private.sync_outage_members sm on sm.device = o.device and sm.task_key = i.task_key
       join private.sync_outage_config c on c.device = o.device
       where o.ended_at is null and i.started_at >= o.started_at - make_interval(mins => greatest(c.merge_gap_minutes, 15)))
   union all
   select case when e.severity = 'critical' then 1 when e.source = 'cron' then 3 else 4 end, e.label, e.first_seen_at, null::timestamptz,
     (e.source = 'telegram' and e.event_key ~ '^health-' and e.last_seen_at < p_now - interval '30 hours'),
     coalesce(left(e.detail, 140), '—'),
     'مستمر' || case when e.occurrences > 1 then '، تكرر ' || private.ops_fmt_iso(e.occurrences::text) || ' مرة' else '' end,
     'ops', e.source || ':' || e.event_key
   from private.ops_events e where e.resolved_at is null
  ) q order by rnk, started, k
 loop
  full_t := nl || rlm || '• ' || left(r.label, 120) || nl
   || rlm || '  البداية: ' || private.ops_fmt_iso(to_char(r.started at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI'))
   || ' — منذ ' || private.ops_fmt_duration(extract(epoch from (p_now - r.started)) / 60) || nl
   || rlm || '  الحالة: ' || r.status
   || case when r.kind = 'task' then nl || rlm || '  آخر نجاح: ' || private.ops_fmt_time(r.last_ok, p_now) else '' end
   || nl || rlm || case when r.kind = 'ops' then '  التفاصيل: ' else '  الأثر: ' end || r.note
   || case when r.off and r.kind = 'ops' then nl || rlm || '  ⚠️ لم يصل تحديث منذ أكثر من 30 ساعة — يلزم إعادة التحقق (لا يُعدّ محلولاً ولا مؤكَّد الاستمرار)'
           when r.off then nl || rlm || '  ⚠️ المراقبة معطّلة — حالة هذا العطل غير محدّثة' else '' end;
  short_t := nl || rlm || '• ' || left(r.label, 120) || ' — منذ ' || private.ops_fmt_duration(extract(epoch from (p_now - r.started)) / 60)
   || case when r.off and r.kind = 'ops' then ' (يلزم إعادة التحقق)' when r.off then ' (المراقبة معطّلة)' else '' end;
  if not compact and length(hdr) + length(body) + length(full_t) <= budget - reserve - 70 then
   body := body || full_t;
  else
   compact := true;
   if length(hdr) + length(body) + length(short_t) <= budget - reserve - 70 then body := body || short_t;
   else hidden := hidden + 1; end if;
  end if;
 end loop;
 res := hdr || body || case when hidden > 0 then nl || rlm || '… و' || private.ops_fmt_iso(hidden::text) || ' أعطال مستمرة أخرى غير معروضة (راجع سجل الأعطال)' else '' end;

 if en > 0 and length(res) + length(ended_hdr) + 60 <= budget then
  ended_t := ended_hdr;
  for i in 1 .. en loop
   if length(res) + length(ended_t) + length(ended_lines[i]) + 60 <= budget then
    ended_t := ended_t || ended_lines[i]; eshown := eshown + 1;
   else exit; end if;
  end loop;
  tail_more := case when en > eshown then nl || rlm || '… و' || private.ops_fmt_iso((en - eshown)::text) || ' أخرى' else '' end;
  res := res || ended_t || tail_more;
 end if;
 if length(res) > budget then
  -- حارس أخير (لا يُتوقع بلوغه): لا قصّ داخل حصر الاتجاه
  res := '🛠 حالة الأنظمة والأعطال' || nl || rlm || '⚠️ القسم أطول من المساحة المتاحة؛ راجع سجل الأعطال.';
 end if;
 return res;
end;
$$;
revoke all on function private.daily_open_faults_section(timestamptz,integer) from public,anon,authenticated;

-- ── الجدولة: دورة واحدة كل 5 دقائق (المهمة الوحيدة الجديدة) ─────────────────────────────────
select cron.schedule('sync-outage-tick', '*/5 * * * *', 'select private.sync_outage_tick()');

-- تحقق بعدي (أي فشل يتراجع بكل شيء)
do $post$
declare disp text; sec text;
begin
  select prosrc into disp from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)');
  if position('ameen-outage:v1' in disp) = 0 or position('digest-routing:v1' in disp) = 0 then
    raise exception 'postflight 15: dispatch lacks one of the hooks';
  end if;
  if (select count(*) from private.sync_outage_snapshot) <> 2 then
    raise exception 'postflight 15: snapshot must hold exactly 2 functions';
  end if;
  sec := private.daily_open_faults_section(now(), 1500);
  if sec is null or position('حالة الأنظمة والأعطال' in sec) = 0 then raise exception 'postflight 15: section builder failed'; end if;
  if (select count(*) from private.sync_outage_members where device = 'OZK2026') < 3 then
    raise exception 'postflight 15: OZK2026 has fewer than 3 monitored member tasks';
  end if;
end $post$;
