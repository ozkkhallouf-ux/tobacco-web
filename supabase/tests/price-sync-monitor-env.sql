-- بيئة مشتركة لاختبارات proposed/17: أدوار Supabase، وauth، وis_staff()، و16، ونسخ مطابقة لجسم الإنتاج من
-- notify_telegram وnotify_telegram_dispatch وtelegram_outbox، وproject_task_monitors مصغّر، وcron وسجل هجرات مصغّران.
-- يُحمَّل عبر scripts/check-price-sync-monitor.mjs في قاعدة مؤقتة مستقلة. لا شبكة ولا تيليغرام حقيقي.
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
-- cron وسجل الهجرات المصغّران: لاختبار أن الحارس الفاشل لا يُنشئ مهمة، وأن 17 تجدول مهمتها بعد نجاحه.
create schema if not exists cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean not null default true);
create or replace function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid $$;
create or replace function cron.unschedule(p_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = p_name returning 1) select exists (select 1 from d) $$;
create schema if not exists supabase_migrations;
create table supabase_migrations.schema_migrations (version text primary key, name text);

create table private.project_task_monitors (task_key text primary key, task_label text, enabled boolean not null default true,
  source_table text, report_source text, max_age_minutes integer, check_status boolean default false);
insert into private.project_task_monitors values
  ('price-sync', 'مزامنة الأسعار', true, 'inventory_reports', 'ameen_price_sync_status', 30, false),
  ('ameen-main', 'مزامنة أمين الرئيسية', true, 'inventory_reports', 'ameen_sql_agent', 10, false);

