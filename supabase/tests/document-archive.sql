-- اختبار supabase/proposed/22-document-archive.sql على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-drive-invoice-archive.mjs (قاعدة مستقلة تُحذف بعده).
-- بيئة مصطنعة: أدوار Supabase وauth.jwt()/auth.uid() من request.jwt.claims وis_owner() بجسم الإنتاج.
-- لا اتصال بأي خدمة خارجية ولا بيانات إنتاج ولا بيانات زبائن حقيقية.
\set ON_ERROR_STOP 1
\set QUIET 1

do $guard$
begin
  if current_database() is distinct from 'ozk_document_archive_test' then
    raise exception 'document archive test runs only in ozk_document_archive_test';
  end if;
  if to_regclass('public.inventory_reports') is not null or to_regclass('public.approved_price_items') is not null then
    raise exception 'refusing: database has production tables';
  end if;
end
$guard$;

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
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif((select auth.jwt()) ->> 'sub', '')::uuid
$$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;

-- is_owner() بجسم الإنتاج (supabase/migrations/20260830141802_khalil_audit_log.sql).
create or replace function public.is_owner() returns boolean language sql stable security invoker
set search_path = public, pg_temp as $$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

\i :migration

create function pg_temp.act(p_who text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case p_who
    when 'owner' then '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","app_metadata":{"role":"owner"}}'
    when 'staff' then '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"employee"}}'
    when 'anon' then '{"role":"anon"}'
    else '{"role":"service_role"}' end, false);
end $$;

create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'TEST FAIL: %', p_name; end if;
  raise notice 'PASS %', p_name;
end $$;

create function pg_temp.item(p_job text, p_version int, p_status text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object(
    'job_id', p_job, 'doc_type', 'wholesale_invoice', 'source_guid', '11111111-1111-4111-8111-111111111111',
    'doc_number', '501', 'doc_date', '2026-10-24', 'customer_guid', 'aaaaaaaa-0000-4000-8000-000000000001',
    'customer_name', 'زبون تجريبي', 'amount', 1300, 'currency', 'USD', 'version', p_version,
    'version_hash', repeat(p_version::text, 64), 'status', p_status, 'failed', false, 'attempts', 0) || p_extra
$$;

\set QUIET 0
-- ── ١) service_role: تقرير العامل ──
set role service_role;
select pg_temp.act('service');
select public.document_archive_ingest_report(jsonb_build_object(
  'host', 'OZK2026', 'drive_state', 'connected', 'drive_checked_at', '2026-10-24T12:00:00Z', 'mode', 'live',
  'last_success_at', '2026-10-24T12:00:00Z', 'pending_count', 1, 'failed_count', 0, 'worker_version', 'test',
  'items', jsonb_build_array(pg_temp.item(repeat('a', 32), 1, 'rendered'))));
select pg_temp.ok((select count(*) = 1 from public.document_archive_items), 'report inserts item');
select pg_temp.ok((select drive_state = 'connected' from public.document_archive_heartbeat where host = 'OZK2026'), 'heartbeat stored');

-- الحالة لا تعود للخلف، وmessage_id/file_id لا يُمسحان.
select public.document_archive_record_notification(pg_temp.item(repeat('a', 32), 1, 'notified', jsonb_build_object(
  'telegram_message_id', 555, 'drive_file_id', 'F000000000001xyz',
  'drive_web_link', 'https://drive.google.com/file/d/F000000000001xyz/view?usp=drivesdk')));
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(pg_temp.item(repeat('a', 32), 1, 'uploaded'))));
select pg_temp.ok((select status = 'notified' and telegram_message_id = 555 and drive_file_id = 'F000000000001xyz'
  from public.document_archive_items where job_id = repeat('a', 32)), 'no status downgrade, ids kept');

-- نفس job_id بنسخة أو بصمة مختلفة لا يكتب فوق السجل.
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(pg_temp.item(repeat('a', 32), 1, 'notified', jsonb_build_object('version_hash', repeat('f', 64), 'customer_name', 'مزوّر')))));
select pg_temp.ok((select customer_name = 'زبون تجريبي' from public.document_archive_items where job_id = repeat('a', 32)), 'identity of job is immutable');

-- رابط عام مرفوض بقيد الجدول.
do $$ begin
  perform public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
    'items', jsonb_build_array(pg_temp.item(repeat('b', 32), 2, 'uploaded', jsonb_build_object(
      'drive_web_link', 'https://drive.google.com/uc?export=download&id=F000000000001xyz')))));
  raise exception 'TEST FAIL: public link accepted';
exception when check_violation then raise notice 'PASS public/download link rejected';
end $$;

-- أكثر من 200 عنصر مرفوض.
do $$ begin
  perform public.document_archive_ingest_report(jsonb_build_object('host', 'X', 'drive_state', 'connected', 'mode', 'live',
    'items', (select jsonb_agg(i) from generate_series(1, 201) i)));
  raise exception 'TEST FAIL: oversized report accepted';
exception when invalid_parameter_value then raise notice 'PASS oversized report rejected';
end $$;

select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(pg_temp.item(repeat('c', 32), 2, 'rendered', '{"failed": true, "last_error": "upload:TRANSIENT"}'))));
reset role;

-- ── ٢) القراءة: المالك وحده ──
set role authenticated;
select pg_temp.act('owner');
select pg_temp.ok((select count(*) = 2 from public.document_archive_items), 'owner reads items');
select pg_temp.ok((select count(*) = 1 from public.document_archive_heartbeat), 'owner reads heartbeat');
select pg_temp.act('staff');
select pg_temp.ok((select count(*) = 0 from public.document_archive_items), 'staff reads nothing');
select pg_temp.ok((select count(*) = 0 from public.document_archive_heartbeat), 'staff reads no heartbeat');

-- الكتابة المباشرة ممنوعة حتى على المالك.
select pg_temp.act('owner');
do $$ begin
  update public.document_archive_items set failed = false;
  raise exception 'TEST FAIL: owner direct update allowed';
exception when insufficient_privilege then raise notice 'PASS owner cannot update directly';
end $$;
do $$ begin
  perform public.document_archive_ingest_report('{"host":"X","drive_state":"connected","mode":"live"}');
  raise exception 'TEST FAIL: authenticated can ingest';
exception when insufficient_privilege then raise notice 'PASS authenticated cannot ingest';
end $$;

-- ── ٣) إعادة المحاولة: المالك وحده، للفاشلة وحدها، طلب مفتوح واحد ──
select pg_temp.ok((public.request_document_archive_retry(repeat('a', 32)) ->> 'reason') = 'not_failed', 'retry refuses non-failed');
select pg_temp.ok((public.request_document_archive_retry(repeat('c', 32)) ->> 'ok')::boolean, 'owner requests retry');
select pg_temp.ok((public.request_document_archive_retry(repeat('c', 32)) ->> 'ok')::boolean, 'second request is idempotent');
select pg_temp.ok((public.request_document_archive_retry(repeat('d', 32)) ->> 'reason') = 'not_found', 'unknown job');
select pg_temp.act('staff');
do $$ begin
  perform public.request_document_archive_retry(repeat('c', 32));
  raise exception 'TEST FAIL: staff retry allowed';
exception when insufficient_privilege then raise notice 'PASS staff cannot request retry';
end $$;
reset role;

set role anon;
select pg_temp.act('anon');
do $$ begin
  perform 1 from public.document_archive_items;
  raise exception 'TEST FAIL: anon read';
exception when insufficient_privilege then raise notice 'PASS anon cannot read';
end $$;
do $$ begin
  perform public.request_document_archive_retry(repeat('c', 32));
  raise exception 'TEST FAIL: anon retry';
exception when insufficient_privilege then raise notice 'PASS anon cannot request retry';
end $$;
reset role;

set role service_role;
select pg_temp.act('service');
select pg_temp.ok((select (public.document_archive_ingest_report('{"host":"OZK2026","drive_state":"connected","mode":"live"}') -> 'retry_job_ids') = jsonb_build_array(repeat('c', 32))), 'report delivers retry once');
select pg_temp.ok((select (public.document_archive_ingest_report('{"host":"OZK2026","drive_state":"connected","mode":"live"}') -> 'retry_job_ids') = '[]'::jsonb), 'retry consumed');
reset role;

-- ── ٤) التراجع ──
\i :rollback
select pg_temp.ok(to_regclass('public.document_archive_items') is null and to_regclass('public.document_archive_heartbeat') is null, 'rollback removes objects');
select pg_temp.ok(to_regprocedure('public.request_document_archive_retry(text)') is null, 'rollback removes functions');

\echo DOCUMENT_ARCHIVE_OK
