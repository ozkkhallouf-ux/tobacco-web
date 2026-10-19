-- proposed/17-price-sync-monitor.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** يُنشئ مهمة cron جديدة ويعطّل صف المراقب
-- القديم «price-sync» (راجع «منع التكرار» أدناه).
--
-- OZK Price Sync Protection — المرحلة الثالثة: مراقبة مستقلة على Supabase لمزامنة الأسعار
-- (الموقع ← الأمين)، تعمل حتى لو كان OZK2026 مطفأً أو بلا إنترنت، وتنبّه في تيليغرام مرة واحدة
-- عند بداية الحادثة ومرة واحدة عند التعافي.
--
-- المصدر الوحيد: public.price_sync_heartbeats (proposed/16، مطبَّقة 2026-10-18). كل الأزمنة من ساعة
-- الخادم (received_at وnow())، لا من طوابع العميل. العرض بتوقيت دمشق.
--
-- الحالات (private.price_sync_monitor_assess):
--   DISABLED  فحص مهمة حديث (≤ 45 د) يقول إن «TOBACCO Approved Prices Pull» معطّلة أو غير مسجّلة.
--   UNKNOWN   لا أي محاولة مزامنة في الجدول. غياب البيانات مشكلة، لا نجاح.
--   HEALTHY   نجاح مثبت (applied/no_changes — الدالة 16 لا تقبله بلا إثبات) خلال آخر 15 د، وآخر
--             محاولة ليست جزءاً من فشلين متتاليين.
--   FAILED    لا نجاح مثبت منذ أكثر من 15 د رغم وصول محاولات حديثة، أو فشل محاولتين متتاليتين
--             (اكتشاف مبكر عند الدورة الثانية، نحو 10 د). فشل عابر واحد ثم نجاح لا يفتح حادثة.
--   STALE     لا نجاح مثبت منذ أكثر من 15 د ولا محاولة حديثة: المهمة لا تعمل أو الجهاز مطفأ أو بلا
--             إنترنت أو DNS. نجاح قديم ليس دليلاً على السلامة.
--
-- دورة الحادثة (private.price_sync_monitor_tick، cron كل دقيقة):
--   * قفل استشاري: تشغيلان متزامنان لا يرسلان مرتين.
--   * حادثة واحدة مفتوحة على الأكثر (فهرس فريد جزئي). رسالة واحدة عند فتحها، ولا تكرار ما دامت مفتوحة
--     مهما تغيّرت حالتها الفرعية (STALE ← DISABLED…).
--   * التعافي: نجاح مثبت حديث وآخر محاولة ناجحة ولا فحص «معطّلة» حديث ⇒ إغلاق ورسالة تعافٍ واحدة،
--     فقط إن كانت رسالة الفتح قد أُرسلت. لا تعافٍ بلا حادثة مفتوحة.
--   * أول تشغيل خط أساس: إن كانت المزامنة معطوبة لحظة التفعيل تُفتح الحادثة صامتة (لا يُعدّ التاريخ
--     حادثة جديدة)، ثم يُنبَّه مرة واحدة إن بقيت قائمة 30 د بعد التفعيل.
--   * فشل إدراج رسالة تيليغرام يُفشل الدورة كلها (لا تُلتقط الاستثناءات)، فتُرجَع الحالة وتُعاد المحاولة
--     في الدقيقة التالية دون ضياع التنبيه. وتكرار فشل الدورة تكشفه مراقبة cron القائمة في
--     private.monitor_project_tasks (cron:price-sync-monitor) — فشل المراقب منفصل عن فشل المزامنة.
--   * مفتاح dedupe لكل حادثة: «price-sync-outage:<incident_key UUID>:open|recovered» بنافذة أسبوع (حماية
--     ثانية). UUID لا معرّف تسلسلي، فلا يصطدم بمفتاح حادثة سابقة بعد تراجع وإعادة تطبيق.
--
-- منع التكرار مع المراقب القائم:
--   private.monitor_project_tasks يراقب «price-sync» من ameen_price_sync_status (يُكتب بعد النجاح فقط)
--   بحد 30 د ويعيد التنبيه كل 60 د. هذا الملف يعطّل ذلك الصف (enabled=false) في المعاملة نفسها لأن
--   المراقب الجديد يحل محله، ولا يمسّ دالة monitor_project_tasks ولا بقية المهام.
--   تنبيهات Windows من OZK2026 نفسه (winfail:apply-to-ameen، price-sync:mismatch، price-sync:verify-failed)
--   لا تُمسّ هنا.
--
-- توافق الحزم 12/13/15 (غير مطبَّقة): event_type «price_sync_outage»/«price_sync_recovered» ومفتاح
-- «price-sync-outage:» لا يطابقان قواعد التوجيه إلى الملخص فيهما (sync_failure، ‎^price-sync:، ‎^winfail:)،
-- فيبقى التنبيه فورياً. و12/15 تقرآن صفوف project_task_monitors المفعّلة فقط.
--
-- الأمن: الدوال والجداول في private بلا أي منح لـ anon/authenticated/service_role؛ لا يستدعيها إلا
-- cron (postgres). الموظف لا يستطيع فتح حادثة أو إعلان تعافٍ، ولا كتابة نبض (16).
--
-- التراجع: 17-price-sync-monitor-rollback.sql. الاختبار: supabase/tests/price-sync-monitor.sql عبر
-- scripts/check-price-sync-monitor.mjs (PostgreSQL محلي في CI).

do $pre$
begin
  if to_regclass('public.price_sync_heartbeats') is null then
    raise exception 'proposed/17 requires proposed/16 (public.price_sync_heartbeats)';
  end if;
  if to_regprocedure('public.notify_telegram(text,text,text,integer,jsonb)') is null then
    raise exception 'proposed/17 requires public.notify_telegram(text,text,text,integer,jsonb)';
  end if;
end
$pre$;

create schema if not exists private;

-- ── الإعدادات والحالة ────────────────────────────────────────────────────────────────────────

create table if not exists private.price_sync_monitor_config (
  id                        boolean primary key default true check (id),
  stale_after_minutes       integer not null default 15 check (stale_after_minutes between 5 and 240),
  probe_fresh_minutes       integer not null default 45 check (probe_fresh_minutes between 5 and 240),
  early_failure_attempts    integer not null default 2  check (early_failure_attempts between 2 and 10),
  baseline_escalate_minutes integer not null default 30 check (baseline_escalate_minutes between 5 and 1440),
  device_label              text    not null default 'OZK2026'
);
insert into private.price_sync_monitor_config (id) values (true) on conflict (id) do nothing;

create table if not exists private.price_sync_monitor_state (
  id                boolean primary key default true check (id),
  baseline_at       timestamptz not null,
  last_evaluated_at timestamptz not null,
  last_state        text not null,
  last_reason       text
);

create table if not exists private.price_sync_incidents (
  id               bigint generated always as identity primary key,
  -- مفتاح الحادثة في dedupe: UUID لا يتكرر بعد تراجع وإعادة تطبيق (الهوية id تبدأ من 1 من جديد
  -- بينما يبقى telegram_outbox، فيصطدم «price-sync-outage:1:open» القديم ويُكتم التنبيه — Codex P1).
  incident_key     uuid not null default gen_random_uuid() unique,
  opened_at        timestamptz not null,
  opened_state     text not null,
  opened_reason    text,
  current_state    text not null,
  current_reason   text,
  last_seen_at     timestamptz not null,
  from_baseline    boolean not null default false,
  alert_sent_at    timestamptz,
  closed_at        timestamptz,
  recovery_sent_at timestamptz,
  constraint price_sync_incidents_states check (
    opened_state in ('STALE','FAILED','DISABLED','UNKNOWN') and current_state in ('STALE','FAILED','DISABLED','UNKNOWN'))
);
create unique index if not exists price_sync_incidents_one_open
  on private.price_sync_incidents ((true)) where closed_at is null;

revoke all on table private.price_sync_monitor_config, private.price_sync_monitor_state, private.price_sync_incidents
  from public, anon, authenticated, service_role;

-- ── التصنيف (قراءة فقط) ─────────────────────────────────────────────────────────────────────

create or replace function private.price_sync_monitor_assess(p_now timestamptz default now())
returns table (
  state text, reason text,
  last_success_at timestamptz, last_attempt_at timestamptz, last_outcome text,
  consecutive_failures integer,
  applied_wholesale integer, applied_retail integer, conflicts integer, not_in_ameen integer,
  probe_at timestamptz, probe_enabled boolean, probe_exists boolean, host text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cfg     private.price_sync_monitor_config%rowtype;
  latest  record;
  probe   record;
  v_stale interval;
  v_success_outcomes text[] := array['applied','no_changes'];
begin
  select * into cfg from private.price_sync_monitor_config where id;
  if not found then
    cfg.stale_after_minutes := 15; cfg.probe_fresh_minutes := 45; cfg.early_failure_attempts := 2;
  end if;
  v_stale := pg_catalog.make_interval(mins => cfg.stale_after_minutes);

  select h.received_at, h.outcome, h.summary into latest
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.received_at <= p_now
   order by h.received_at desc, h.id desc limit 1;

  select pg_catalog.max(h.received_at) into last_success_at
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.outcome = any (v_success_outcomes) and h.received_at <= p_now;

  select pg_catalog.count(*)::integer into consecutive_failures
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.received_at <= p_now
     and h.received_at > coalesce(price_sync_monitor_assess.last_success_at, '-infinity'::timestamptz)
     and not (h.outcome = any (v_success_outcomes));

  select h.received_at, h.summary into probe
    from public.price_sync_heartbeats h
   where h.kind = 'task_probe' and h.received_at <= p_now
   order by h.received_at desc, h.id desc limit 1;

  last_attempt_at := latest.received_at;
  last_outcome    := latest.outcome;
  host := coalesce(nullif(latest.summary ->> 'host', ''), nullif(probe.summary ->> 'host', ''));

  -- أعداد آخر نجاح مثبت (لرسالة التعافي).
  select (case when pg_catalog.jsonb_typeof(h.summary -> 'applied_wholesale') = 'number' then (h.summary ->> 'applied_wholesale')::numeric::integer end),
         (case when pg_catalog.jsonb_typeof(h.summary -> 'applied_retail') = 'number' then (h.summary ->> 'applied_retail')::numeric::integer end),
         (case when pg_catalog.jsonb_typeof(h.summary -> 'conflict_count') = 'number' then (h.summary ->> 'conflict_count')::numeric::integer end),
         (case when pg_catalog.jsonb_typeof(h.summary -> 'not_in_ameen') = 'number' then (h.summary ->> 'not_in_ameen')::numeric::integer end)
    into applied_wholesale, applied_retail, conflicts, not_in_ameen
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.outcome = any (v_success_outcomes) and h.received_at <= p_now
   order by h.received_at desc, h.id desc limit 1;

  probe_at := probe.received_at;
  probe_enabled := case when pg_catalog.jsonb_typeof(probe.summary -> 'task' -> 'enabled') = 'boolean' then (probe.summary -> 'task' ->> 'enabled')::boolean end;
  probe_exists  := case when pg_catalog.jsonb_typeof(probe.summary -> 'task' -> 'exists') = 'boolean' then (probe.summary -> 'task' ->> 'exists')::boolean end;

  if probe_at is not null and probe_at >= p_now - pg_catalog.make_interval(mins => cfg.probe_fresh_minutes)
     and (probe_exists is false or probe_enabled is false) then
    state := 'DISABLED';
    reason := case when probe_exists is false then 'task_missing' else 'task_disabled' end;
  elsif latest.received_at is null then
    state := 'UNKNOWN'; reason := 'no_data';
  elsif last_success_at is null or last_success_at < p_now - v_stale then
    if latest.received_at >= p_now - v_stale then
      state := 'FAILED'; reason := latest.outcome;
    else
      state := 'STALE'; reason := 'no_recent_attempt';
    end if;
  elsif consecutive_failures >= cfg.early_failure_attempts then
    state := 'FAILED'; reason := latest.outcome;
  else
    state := 'HEALTHY';
    reason := case when consecutive_failures > 0 then 'transient_failure' else latest.outcome end;
  end if;
  return next;
end;
$$;

-- ── نصوص الرسائل (بلا HTML، بتوقيت دمشق) ────────────────────────────────────────────────────

create or replace function private.price_sync_monitor_time(p_at timestamptz, p_now timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_at is null then 'لا يوجد'
    when pg_catalog.date(p_at at time zone 'Asia/Damascus') = pg_catalog.date(p_now at time zone 'Asia/Damascus')
      then pg_catalog.to_char(p_at at time zone 'Asia/Damascus', 'HH24:MI')
    else pg_catalog.to_char(p_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI')
  end;
$$;

create or replace function private.price_sync_monitor_reason_text(p_reason text)
returns text
language sql
stable
set search_path = ''
as $$
  select case p_reason
    when 'no_recent_attempt'      then 'لا محاولات مزامنة حديثة (المهمة لا تعمل أو الجهاز مطفأ أو بلا اتصال)'
    when 'no_data'                then 'لا توجد أي نبضة مزامنة مسجّلة'
    when 'task_disabled'          then 'مهمة TOBACCO Approved Prices Pull معطّلة على Windows'
    when 'task_missing'           then 'مهمة TOBACCO Approved Prices Pull غير مسجّلة على Windows'
    when 'pull_failed'            then 'تعذّر سحب الأسعار من الموقع'
    when 'ameen_unreachable'      then 'تعذّر الاتصال بقاعدة الأمين'
    when 'apply_failed'           then 'فشل تطبيق الأسعار على الأمين'
    when 'verify_failed'          then 'تعذّر التحقق من الأسعار في الأمين'
    when 'verify_mismatch'        then 'أسعار الأمين لا تطابق الموقع'
    when 'applied_with_conflicts' then 'طُبّقت الأسعار مع تعارض أو أصناف غير موجودة'
    when 'preview_only'           then 'المهمة تعمل بوضع المعاينة ولا تكتب في الأمين'
    else coalesce(p_reason, 'غير معروف')
  end;
$$;

create or replace function private.price_sync_monitor_alert_text(
  p_state text, p_reason text, p_last_success timestamptz, p_since timestamptz, p_now timestamptz, p_device text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.concat_ws(pg_catalog.chr(10),
    case p_state
      when 'STALE'    then '🔴 OZK | توقف مزامنة الأسعار'
      when 'FAILED'   then '🔴 OZK | فشل مزامنة الأسعار'
      when 'DISABLED' then '🔴 OZK | مهمة مزامنة الأسعار معطّلة'
      else                 '🔴 OZK | حالة مزامنة الأسعار غير معروفة'
    end,
    '',
    'آخر مزامنة ناجحة: ' || private.price_sync_monitor_time(p_last_success, p_now),
    'مدة الانقطاع: ' || coalesce(
      (pg_catalog.floor(extract(epoch from (p_now - coalesce(p_last_success, p_since))) / 60))::bigint::text || ' دقيقة',
      'غير معروفة'),
    'الحالة: ' || p_state,
    'السبب: ' || private.price_sync_monitor_reason_text(p_reason),
    '',
    '⚠️ قد لا تصل تعديلات الأسعار',
    'من الموقع إلى برنامج الأمين.',
    '',
    'المراقبة: Supabase',
    'الجهاز: ' || coalesce(p_device, 'OZK2026'));
$$;

create or replace function private.price_sync_monitor_recovery_text(
  p_last_success timestamptz, p_wholesale integer, p_retail integer, p_conflicts integer,
  p_opened_at timestamptz, p_now timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.concat_ws(pg_catalog.chr(10),
    '🟢 OZK | عودة مزامنة الأسعار',
    '',
    'عادت المزامنة للعمل بنجاح.',
    'آخر نجاح: ' || private.price_sync_monitor_time(p_last_success, p_now),
    'جملة: ' || coalesce(p_wholesale::text, '؟'),
    'مفرق: ' || coalesce(p_retail::text, '؟'),
    'التعارضات: ' || coalesce(p_conflicts::text, '0'),
    'مدة الحادثة: ' || (pg_catalog.floor(extract(epoch from (p_now - p_opened_at)) / 60))::bigint::text || ' دقيقة',
    '',
    'انتهت الحادثة.');
$$;

-- ── دورة المراقبة ──────────────────────────────────────────────────────────────────────────

create or replace function private.price_sync_monitor_tick(p_now timestamptz default now())
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg      private.price_sync_monitor_config%rowtype;
  a        record;
  st       private.price_sync_monitor_state%rowtype;
  inc      private.price_sync_incidents%rowtype;
  v_problem  boolean;
  v_recovered boolean;
  v_result text;
begin
  -- تشغيلان متزامنان (cron مكرر أو يدوي) يتسلسلان: الثاني يرى ما كتبه الأول.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('private.price_sync_monitor_tick'));

  select * into cfg from private.price_sync_monitor_config where id;
  select * into a from private.price_sync_monitor_assess(p_now);
  v_problem := a.state in ('STALE','FAILED','DISABLED','UNKNOWN');
  -- التعافي يحتاج دليلاً حديثاً: آخر محاولة نفسها ناجحة ومثبتة، لا مجرد غياب الخطأ.
  v_recovered := a.state = 'HEALTHY' and a.last_outcome in ('applied','no_changes')
                 and a.last_attempt_at = a.last_success_at;

  select * into st from private.price_sync_monitor_state where id for update;
  select * into inc from private.price_sync_incidents where closed_at is null for update;

  if st.id is null then
    -- أول تشغيل: خط أساس صامت. لا يُعدّ التاريخ حادثة جديدة.
    insert into private.price_sync_monitor_state (id, baseline_at, last_evaluated_at, last_state, last_reason)
    values (true, p_now, p_now, a.state, a.reason);
    if v_problem and inc.id is null then
      insert into private.price_sync_incidents (opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, from_baseline)
      values (p_now, a.state, a.reason, a.state, a.reason, p_now, true);
      return 'baseline_open_silent';
    end if;
    return 'baseline';
  end if;

  if inc.id is null then
    if v_problem then
      insert into private.price_sync_incidents (opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, alert_sent_at)
      values (p_now, a.state, a.reason, a.state, a.reason, p_now, p_now)
      returning * into inc;
      -- بلا التقاط استثناء: فشل الإدراج يُرجع الدورة كلها فتُعاد المحاولة في الدقيقة التالية.
      perform public.notify_telegram('price_sync_outage',
        private.price_sync_monitor_alert_text(a.state, a.reason, a.last_success_at, p_now, p_now, coalesce(a.host, cfg.device_label)),
        'price-sync-outage:' || inc.incident_key || ':open', 10080, null);
      v_result := 'alert_sent';
    else
      v_result := 'healthy';
    end if;
  elsif v_problem then
    update private.price_sync_incidents
       set current_state = a.state, current_reason = a.reason, last_seen_at = p_now
     where id = inc.id;
    if inc.alert_sent_at is null and inc.from_baseline
       and p_now >= st.baseline_at + pg_catalog.make_interval(mins => cfg.baseline_escalate_minutes) then
      update private.price_sync_incidents set alert_sent_at = p_now where id = inc.id;
      perform public.notify_telegram('price_sync_outage',
        private.price_sync_monitor_alert_text(a.state, a.reason, a.last_success_at, inc.opened_at, p_now, coalesce(a.host, cfg.device_label)),
        'price-sync-outage:' || inc.incident_key || ':open', 10080, null);
      v_result := 'baseline_escalated';
    else
      v_result := 'incident_ongoing';
    end if;
  elsif v_recovered then
    update private.price_sync_incidents
       set closed_at = p_now, last_seen_at = p_now,
           recovery_sent_at = case when inc.alert_sent_at is not null then p_now end
     where id = inc.id;
    if inc.alert_sent_at is not null then
      perform public.notify_telegram('price_sync_recovered',
        private.price_sync_monitor_recovery_text(a.last_success_at, a.applied_wholesale, a.applied_retail, a.conflicts, inc.opened_at, p_now),
        'price-sync-outage:' || inc.incident_key || ':recovered', 10080, null);
      v_result := 'recovery_sent';
    else
      v_result := 'closed_silent';
    end if;
  else
    -- HEALTHY بلا دليل تعافٍ كامل (فشل عابر بعد النجاح): الحادثة تبقى مفتوحة بلا رسائل.
    update private.price_sync_incidents set last_seen_at = p_now where id = inc.id;
    v_result := 'incident_waiting_proof';
  end if;

  update private.price_sync_monitor_state
     set last_evaluated_at = p_now, last_state = a.state, last_reason = a.reason
   where id;
  return v_result;
end;
$$;

revoke all on function private.price_sync_monitor_assess(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.price_sync_monitor_time(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.price_sync_monitor_reason_text(text) from public, anon, authenticated, service_role;
revoke all on function private.price_sync_monitor_alert_text(text, text, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function private.price_sync_monitor_recovery_text(timestamptz, integer, integer, integer, timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.price_sync_monitor_tick(timestamptz) from public, anon, authenticated, service_role;

-- ── منع التكرار: المراقب الجديد يحل محل صف «price-sync» القديم ──────────────────────────────

do $retire$
begin
  if to_regclass('private.project_task_monitors') is not null then
    update private.project_task_monitors set enabled = false where task_key = 'price-sync' and enabled;
  end if;
end
$retire$;

-- ── الجدولة (cron كل دقيقة) ─────────────────────────────────────────────────────────────────

do $schedule$
begin
  if to_regnamespace('cron') is not null then
    if exists (select 1 from cron.job where jobname = 'price-sync-monitor') then
      perform cron.unschedule('price-sync-monitor');
    end if;
    perform cron.schedule('price-sync-monitor', '* * * * *', 'select private.price_sync_monitor_tick();');
  end if;
end
$schedule$;
