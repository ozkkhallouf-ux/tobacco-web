-- اختبار proposed/17-price-sync-monitor.sql على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-price-sync-monitor.mjs: قاعدة مستقلة تُحذف بعده، والملفات تُمرَّر عبر stdin.
-- بيئة مصطنعة: أدوار Supabase، وauth.uid()/auth.jwt()، وis_staff()، وproposed/16، ونسخ مطابقة لجسم
-- الإنتاج من public.notify_telegram وprivate.notify_telegram_dispatch وtelegram_outbox، وجدول
-- private.project_task_monitors مصغّر. لا شبكة ولا تيليغرام حقيقي: الرسائل تبقى في telegram_outbox.
-- الساعة مثبتة: T0 = 2026-10-19 10:00 UTC (13:00 دمشق).
\set ON_ERROR_STOP 1
\set QUIET 1

do $guard$
begin
  if current_database() is distinct from 'ozk_price_sync_monitor_test' then
    raise exception 'price sync monitor test runs only in ozk_price_sync_monitor_test';
  end if;
  if to_regclass('public.inventory_reports') is not null or to_regclass('public.approved_price_items') is not null then
    raise exception 'refusing: database has production tables';
  end if;
end
$guard$;

-- ── بيئة Supabase المصغّرة ───────────────────────────────────────────────────────────────────
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end
$roles$;
grant usage on schema public to anon, authenticated, service_role;
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif((select auth.jwt()) ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
create table public.staff_allowlist (email text primary key);
insert into public.staff_allowlist values ('staff@example.test');
create or replace function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $$
  select exists (select 1 from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''))) $$;
grant execute on function public.is_staff() to anon, authenticated, service_role;

\i :m16

-- نسخ مطابقة لجسم الإنتاج (2026-10-19): telegram_outbox وnotify_telegram (6ca4caa8) وdispatch (60bbae6f).
create schema if not exists private;
create table public.telegram_outbox (
  id bigint generated always as identity primary key, event_type text, message text, dedupe_key text,
  status text not null default 'pending', attempts integer not null default 0,
  created_at timestamptz not null default now(), sent_at timestamptz, reply_markup jsonb, net_request_id bigint);
create or replace function private.notify_telegram_dispatch(p_event_type text, p_message text, p_dedupe_key text, p_dedupe_minutes integer, p_reply_markup jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_message is null or length(trim(p_message)) = 0 then return; end if;
  if p_dedupe_key is not null and exists (
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
create or replace function public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text default null, p_dedupe_minutes integer default 60, p_reply_markup jsonb default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  if not (v_jwt_role is null or v_jwt_role = 'service_role' or pg_trigger_depth() > 0 or public.is_staff()) then
    raise exception 'notify_telegram: unauthorized direct call' using errcode = '42501';
  end if;
  perform private.notify_telegram_dispatch(p_event_type, p_message, p_dedupe_key, p_dedupe_minutes, p_reply_markup);
end;
$$;
create table private.project_task_monitors (task_key text primary key, task_label text, enabled boolean not null default true,
  source_table text, report_source text, max_age_minutes integer, check_status boolean default false);
insert into private.project_task_monitors values
  ('price-sync', 'مزامنة الأسعار', true, 'inventory_reports', 'ameen_price_sync_status', 30, false),
  ('ameen-main', 'مزامنة أمين الرئيسية', true, 'inventory_reports', 'ameen_sql_agent', 10, false);

-- ── الهجرة ──────────────────────────────────────────────────────────────────────────────────
\i :migration
\i :migration

-- ── أدوات الاختبار ───────────────────────────────────────────────────────────────────────────
create or replace function pg_temp.expect(p_name text, p_actual text, p_expected text) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'TEST FAIL: % — expected %, got %', p_name, p_expected, p_actual;
  end if;
  raise notice 'PASS %', p_name;
end $$;
create or replace function pg_temp.expect_like(p_name text, p_actual text, p_pattern text) returns void language plpgsql as $$
begin
  if p_actual is null or p_actual not like p_pattern then
    raise exception 'TEST FAIL: % — expected like %, got %', p_name, p_pattern, p_actual;
  end if;
  raise notice 'PASS %', p_name;
end $$;
create or replace function pg_temp.t(p_minutes numeric) returns timestamptz language sql immutable as $$
  select timestamptz '2026-10-19 10:00:00+00' + make_interval(secs => p_minutes * 60) $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$
begin
  delete from public.price_sync_heartbeats;
  delete from private.price_sync_incidents;
  delete from private.price_sync_monitor_state;
  delete from public.telegram_outbox;
end $$;
-- نبضة محاولة (received_at = ساعة الخادم المصطنعة).
create or replace function pg_temp.attempt(p_min numeric, p_outcome text) returns void language plpgsql as $$
begin
  insert into public.price_sync_heartbeats (received_at, writer_id, kind, host, occurred_at, outcome, summary, last_success_at, last_ameen_contact_at)
  values (pg_temp.t(p_min), '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3', 'attempt', 'OZK2026', pg_temp.t(p_min), p_outcome,
    jsonb_build_object('schema','price-sync-heartbeat/v1','kind','attempt','host','OZK2026','outcome',p_outcome,
      'attempt_finished_at', pg_temp.t(p_min)::text,
      'applied_wholesale', 321, 'applied_retail', 317, 'conflict_count', 0, 'not_in_ameen', 0,
      'verify', jsonb_build_object('mismatches', 0, 'missing', 0)),
    case when p_outcome in ('applied','no_changes') then pg_temp.t(p_min) end, pg_temp.t(p_min));
end $$;
create or replace function pg_temp.probe(p_min numeric, p_enabled boolean, p_exists boolean default true) returns void language plpgsql as $$
begin
  insert into public.price_sync_heartbeats (received_at, writer_id, kind, host, occurred_at, outcome, summary)
  values (pg_temp.t(p_min), '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3', 'task_probe', 'OZK2026', pg_temp.t(p_min), null,
    jsonb_build_object('schema','price-sync-heartbeat/v1','kind','task_probe','host','OZK2026','probed_at', pg_temp.t(p_min)::text,
      'task', jsonb_build_object('exists', p_exists, 'enabled', p_enabled, 'state', case when p_enabled then 'Ready' else 'Disabled' end)));
end $$;
create or replace function pg_temp.tick(p_min numeric) returns text language sql as $$
  select private.price_sync_monitor_tick(pg_temp.t(p_min)) $$;
create or replace function pg_temp.outbox(p_event text) returns text language sql as $$
  select count(*)::text from public.telegram_outbox where event_type = p_event $$;
create or replace function pg_temp.state(p_min numeric) returns text language sql as $$
  select state from private.price_sync_monitor_assess(pg_temp.t(p_min)) $$;

\set QUIET 0

-- ── ١) منع التكرار مع المراقب القديم، والتطبيق المزدوج آمن ────────────────────────────────────
do $$ begin
  perform pg_temp.expect('old price-sync monitor disabled', (select enabled::text from private.project_task_monitors where task_key = 'price-sync'), 'false');
  perform pg_temp.expect('other monitors untouched', (select enabled::text from private.project_task_monitors where task_key = 'ameen-main'), 'true');
  perform pg_temp.expect('config row single', (select count(*)::text from private.price_sync_monitor_config), '1');
end $$;

-- ── ٢) التصنيف ──────────────────────────────────────────────────────────────────────────────
do $$ begin
  perform pg_temp.reset();
  perform pg_temp.expect('no attempts = UNKNOWN (absence is not success)', pg_temp.state(0), 'UNKNOWN');
  perform pg_temp.attempt(0, 'applied');
  perform pg_temp.expect('fresh proven success = HEALTHY', pg_temp.state(5), 'HEALTHY');
  perform pg_temp.expect('success at exactly 15 min = HEALTHY', pg_temp.state(15), 'HEALTHY');
  perform pg_temp.expect('old success (16 min) with no attempts = STALE', pg_temp.state(16), 'STALE');
  perform pg_temp.attempt(14, 'ameen_unreachable');
  perform pg_temp.expect('single failure after recent success = HEALTHY (transient)', pg_temp.state(14.5), 'HEALTHY');
  perform pg_temp.expect('no success > 15 min but recent attempts = FAILED', pg_temp.state(16), 'FAILED');
  perform pg_temp.attempt(15.2, 'apply_failed');
  perform pg_temp.expect('two consecutive failures = FAILED early', pg_temp.state(15.3), 'FAILED');
  perform pg_temp.probe(16, false);
  perform pg_temp.expect('fresh disabled probe = DISABLED', pg_temp.state(16.5), 'DISABLED');
  perform pg_temp.expect('disabled probe older than 45 min ignored', pg_temp.state(70), 'STALE');
  -- طوابع العميل لا تُحتسب: نجاح وصل قديماً (received_at) مهما كان occurred_at.
  perform pg_temp.reset();
  insert into public.price_sync_heartbeats (received_at, writer_id, kind, host, occurred_at, outcome, summary)
  values (pg_temp.t(-40), gen_random_uuid(), 'attempt', 'OZK2026', pg_temp.t(0), 'applied', '{}'::jsonb);
  perform pg_temp.expect('server received_at decides, not client occurred_at', pg_temp.state(0), 'STALE');
end $$;

-- ── ٣) أول تشغيل: خط أساس صامت ─────────────────────────────────────────────────────────────
do $$ begin
  perform pg_temp.reset();
  perform pg_temp.attempt(-5, 'applied'); perform pg_temp.attempt(0, 'applied');
  perform pg_temp.expect('first run healthy = baseline', pg_temp.tick(1), 'baseline');
  perform pg_temp.expect('baseline sends nothing', (select count(*)::text from public.telegram_outbox), '0');
  perform pg_temp.expect('second run healthy', pg_temp.tick(2), 'healthy');
  perform pg_temp.expect('no recovery without incident', pg_temp.outbox('price_sync_recovered'), '0');
end $$;

-- ── ٤) انقطاع كامل (الجهاز مطفأ): تنبيه واحد بعد 15 د، لا تكرار، تعافٍ واحد ────────────────────
do $$
declare i int; msg text;
begin
  -- متابعة من ٣: آخر نجاح عند 0.
  perform pg_temp.expect('at 10 min still healthy', pg_temp.tick(10), 'healthy');
  perform pg_temp.expect('at 15 min still healthy (threshold inclusive)', pg_temp.tick(15), 'healthy');
  perform pg_temp.expect('at 16 min outage alert', pg_temp.tick(16), 'alert_sent');
  perform pg_temp.expect('exactly one outage alert', pg_temp.outbox('price_sync_outage'), '1');
  for i in 17..120 loop perform pg_temp.tick(i); end loop;
  perform pg_temp.expect('no repeat across 104 more minutes', pg_temp.outbox('price_sync_outage'), '1');
  select message into msg from public.telegram_outbox where event_type = 'price_sync_outage';
  perform pg_temp.expect_like('alert title', msg, '🔴 OZK | توقف مزامنة الأسعار%');
  perform pg_temp.expect_like('alert last success in Damascus time', msg, '%آخر مزامنة ناجحة: 13:00%');
  perform pg_temp.expect_like('alert outage duration', msg, '%مدة الانقطاع: 16 دقيقة%');
  perform pg_temp.expect_like('alert state', msg, '%الحالة: STALE%');
  perform pg_temp.expect_like('alert monitor and device', msg, '%المراقبة: Supabase%الجهاز: OZK2026');
  perform pg_temp.expect('alert has no HTML', (msg ~ '<[a-zA-Z/]')::text, 'false');
  perform pg_temp.expect('alert dedupe key per incident', ((select dedupe_key from public.telegram_outbox where event_type = 'price_sync_outage') ~ '^price-sync-outage:[0-9a-f-]{36}:open$')::text, 'true');
  -- نبضة فاشلة متأخرة لا تعلن تعافياً.
  perform pg_temp.attempt(121, 'pull_failed');
  perform pg_temp.expect('late failed heartbeat keeps incident', pg_temp.tick(122), 'incident_ongoing');
  -- نجاح مثبت حديث ⇒ تعافٍ واحد.
  perform pg_temp.attempt(125, 'applied');
  perform pg_temp.expect('proven fresh success = recovery', pg_temp.tick(126), 'recovery_sent');
  perform pg_temp.expect('exactly one recovery', pg_temp.outbox('price_sync_recovered'), '1');
  for i in 127..140 loop perform pg_temp.tick(i); end loop;
  perform pg_temp.expect('no second recovery', pg_temp.outbox('price_sync_recovered'), '1');
  select message into msg from public.telegram_outbox where event_type = 'price_sync_recovered';
  perform pg_temp.expect_like('recovery text', msg, '🟢 OZK | عودة مزامنة الأسعار%عادت المزامنة للعمل بنجاح.%آخر نجاح: 15:05%جملة: 321%مفرق: 317%التعارضات: 0%انتهت الحادثة.');
  perform pg_temp.expect('incident closed', (select count(*)::text from private.price_sync_incidents where closed_at is null), '0');
end $$;

-- ── ٥) فشل عابر لا يفتح حادثة ───────────────────────────────────────────────────────────────
do $$ begin
  perform pg_temp.reset();
  perform pg_temp.attempt(0, 'applied'); perform pg_temp.tick(0.5);
  perform pg_temp.attempt(5, 'ameen_unreachable');
  perform pg_temp.expect('one failure: no incident', pg_temp.tick(5.5), 'healthy');
  perform pg_temp.attempt(10, 'applied');
  perform pg_temp.expect('recovered before threshold: still no incident', pg_temp.tick(10.5), 'healthy');
  perform pg_temp.expect('no messages for transient failure', (select count(*)::text from public.telegram_outbox), '0');
end $$;

-- ── ٦) فشل متكرر: اكتشاف مبكر قبل 15 د ───────────────────────────────────────────────────────
do $$
declare msg text;
begin
  perform pg_temp.reset();
  perform pg_temp.attempt(0, 'applied'); perform pg_temp.tick(0.5);
  perform pg_temp.attempt(5, 'ameen_unreachable'); perform pg_temp.tick(5.5);
  perform pg_temp.attempt(10, 'ameen_unreachable');
  perform pg_temp.expect('second consecutive failure alerts early', pg_temp.tick(10.5), 'alert_sent');
  select message into msg from public.telegram_outbox where event_type = 'price_sync_outage';
  perform pg_temp.expect_like('failed title and reason', msg, '🔴 OZK | فشل مزامنة الأسعار%الحالة: FAILED%السبب: تعذّر الاتصال بقاعدة الأمين%');
  -- نجاح ثم فشل فوري: لا تعافٍ لأن آخر محاولة ليست ناجحة… ثم نجاح ⇒ تعافٍ واحد.
  perform pg_temp.attempt(15, 'applied');
  perform pg_temp.attempt(20, 'pull_failed');
  perform pg_temp.expect('success followed by failure is not proof of recovery', pg_temp.tick(20.5), 'incident_waiting_proof');
  perform pg_temp.attempt(25, 'no_changes');
  perform pg_temp.expect('no_changes is proven success: recovery', pg_temp.tick(25.5), 'recovery_sent');
  perform pg_temp.expect('one alert one recovery', (select string_agg(event_type, ',' order by id) from public.telegram_outbox), 'price_sync_outage,price_sync_recovered');
end $$;

-- ── ٧) المهمة معطّلة: اكتشاف فوري، حادثة واحدة رغم تغيّر الحالة الفرعية ─────────────────────────
do $$ begin
  perform pg_temp.reset();
  perform pg_temp.attempt(0, 'applied'); perform pg_temp.tick(0.5);
  perform pg_temp.probe(2, false);
  perform pg_temp.expect('disabled probe alerts immediately', pg_temp.tick(2.5), 'alert_sent');
  perform pg_temp.expect_like('disabled message', (select message from public.telegram_outbox), '🔴 OZK | مهمة مزامنة الأسعار معطّلة%الحالة: DISABLED%');
  perform pg_temp.tick(30); perform pg_temp.tick(60);
  perform pg_temp.expect('DISABLED then STALE: still one alert', pg_temp.outbox('price_sync_outage'), '1');
  perform pg_temp.expect('incident tracks current state', (select current_state from private.price_sync_incidents where closed_at is null), 'STALE');
  perform pg_temp.probe(61, true); perform pg_temp.attempt(62, 'applied');
  perform pg_temp.expect('re-enabled and synced: recovery', pg_temp.tick(62.5), 'recovery_sent');
end $$;

-- ── ٨) خط أساس على عطل قائم: صامت ثم تصعيد واحد بعد 30 د؛ وتعافٍ صامت إن لم يُنبَّه ─────────────
do $$ begin
  perform pg_temp.reset();
  perform pg_temp.attempt(-120, 'applied');
  perform pg_temp.expect('historical outage at first run = silent', pg_temp.tick(0), 'baseline_open_silent');
  perform pg_temp.expect('silent baseline sends nothing', (select count(*)::text from public.telegram_outbox), '0');
  perform pg_temp.expect('before escalation window', pg_temp.tick(29), 'incident_ongoing');
  perform pg_temp.expect('escalates once after 30 min', pg_temp.tick(30), 'baseline_escalated');
  perform pg_temp.tick(31); perform pg_temp.tick(90);
  perform pg_temp.expect('escalation not repeated', pg_temp.outbox('price_sync_outage'), '1');

  perform pg_temp.reset();
  perform pg_temp.attempt(-120, 'applied');
  perform pg_temp.tick(0);
  perform pg_temp.attempt(10, 'applied');
  perform pg_temp.expect('silent incident recovers silently', pg_temp.tick(10.5), 'closed_silent');
  perform pg_temp.expect('no recovery for an incident never announced', (select count(*)::text from public.telegram_outbox), '0');

  perform pg_temp.reset();
  perform pg_temp.expect('empty table at first run = silent', pg_temp.tick(0), 'baseline_open_silent');
  perform pg_temp.expect('empty table escalates as UNKNOWN', pg_temp.tick(30), 'baseline_escalated');
  perform pg_temp.expect_like('unknown message', (select message from public.telegram_outbox), '%الحالة: UNKNOWN%لا توجد أي نبضة مزامنة مسجّلة%');
end $$;

-- ── ٩) فشل إرسال تيليغرام: لا ضياع ولا حالة مُعلّمة كذباً ──────────────────────────────────────
do $$
declare v_state text;
begin
  perform pg_temp.reset();
  perform pg_temp.attempt(0, 'applied'); perform pg_temp.tick(0.5);
  alter table public.telegram_outbox add constraint outbox_down check (false) not valid;
  begin
    perform pg_temp.tick(16);
    v_state := 'no error';
  exception when others then
    v_state := sqlstate;
  end;
  alter table public.telegram_outbox drop constraint outbox_down;
  perform pg_temp.expect('outbox failure aborts the tick', v_state, '23514');
  perform pg_temp.expect('no incident recorded when alert could not be queued', (select count(*)::text from private.price_sync_incidents), '0');
  perform pg_temp.expect('next tick retries and alerts', pg_temp.tick(17), 'alert_sent');
  perform pg_temp.expect('exactly one alert after retry', pg_temp.outbox('price_sync_outage'), '1');
end $$;

-- ── ١٠) الأمن: لا أحد غير cron/postgres يشغّل المراقب أو يقرأ الحوادث ───────────────────────────
do $$
declare r text; who text;
begin
  foreach who in array array['anon','authenticated','service_role'] loop
    begin
      execute format('set local role %I', who);
      perform private.price_sync_monitor_tick(now());
      r := 'OK';
    exception when others then r := sqlstate; end;
    reset role;
    perform pg_temp.expect(who || ' cannot run tick', r, '42501');
    begin
      execute format('set local role %I', who);
      perform count(*) from private.price_sync_incidents;
      r := 'OK';
    exception when others then r := sqlstate; end;
    reset role;
    perform pg_temp.expect(who || ' cannot read incidents', r, '42501');
    begin
      execute format('set local role %I', who);
      insert into private.price_sync_incidents (opened_at, opened_state, current_state, last_seen_at) values (now(), 'STALE', 'STALE', now());
      r := 'OK';
    exception when others then r := sqlstate; end;
    reset role;
    perform pg_temp.expect(who || ' cannot forge incident', r, '42501');
  end loop;
  perform pg_temp.expect('tick is security definer with empty search_path',
    (select (prosecdef and proconfig @> array['search_path=""'])::text from pg_proc where oid = 'private.price_sync_monitor_tick(timestamptz)'::regprocedure), 'true');
end $$;

-- ── ١١) التراجع ──────────────────────────────────────────────────────────────────────────────
\i :rollback
do $$ begin
  perform pg_temp.expect('rollback drops tick', (to_regprocedure('private.price_sync_monitor_tick(timestamptz)') is null)::text, 'true');
  perform pg_temp.expect('rollback drops incidents', (to_regclass('private.price_sync_incidents') is null)::text, 'true');
  perform pg_temp.expect('rollback re-enables old monitor', (select enabled::text from private.project_task_monitors where task_key = 'price-sync'), 'true');
  perform pg_temp.expect('rollback keeps heartbeats table', (to_regclass('public.price_sync_heartbeats') is not null)::text, 'true');
end $$;
\i :migration

-- ── ١٢) تراجع ثم إعادة تطبيق مع بقاء telegram_outbox (Codex P1): الحادثة الجديدة تُنبَّه فعلاً ─────
do $$ begin
  perform pg_temp.expect('outbox kept across rollback/reapply', (select (count(*) > 0)::text from public.telegram_outbox where dedupe_key like 'price-sync-outage:%'), 'true');
  delete from public.price_sync_heartbeats;
  -- مفتاح تثبيت سابق بمعرّف تسلسلي (كما كان قبل الإصلاح) ما زال داخل نافذة الأسبوع.
  insert into public.telegram_outbox (event_type, message, dedupe_key) values ('price_sync_outage', 'old', 'price-sync-outage:1:open');
  perform pg_temp.attempt(0, 'applied');
  perform pg_temp.expect('reapplied: baseline', pg_temp.tick(0.5), 'baseline');
  perform pg_temp.expect('reapplied: new outage alerts', pg_temp.tick(16), 'alert_sent');
  perform pg_temp.expect('new incident message really queued (no dedupe collision)',
    (select count(*)::text from public.telegram_outbox o join private.price_sync_incidents i
       on o.dedupe_key = 'price-sync-outage:' || i.incident_key || ':open'
     where i.closed_at is null and o.message like '🔴 OZK |%'), '1');
  perform pg_temp.expect('a real outage message was queued after reapply',
    (select count(*)::text from public.telegram_outbox where event_type = 'price_sync_outage' and message like '🔴 OZK |%' and created_at = now()
       and dedupe_key <> 'price-sync-outage:1:open'), '1');
end $$;

select 'PRICE_SYNC_MONITOR_OK';
