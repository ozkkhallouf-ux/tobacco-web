-- اختبار supabase/proposed/26-document-archive-send-claim.sql فوق 22 على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-drive-invoice-archive.mjs على ثلاث جلسات في القاعدة نفسها:
--   ١) هذا الملف حتى علامة @@CONCURRENCY@@: 22 ثم بيانات قائمة ثم 26 ثم الاختبارات الوظيفية؛
--   ٢) حجوزات متزامنة من عمليات psql منفصلة (في سكربت الفحص)؛
--   ٣) ما بعد العلامة: التراجع عن 26 ثم التأكد أن 22 تعمل كما كانت ثم التراجع عن 22.
-- بيئة مصطنعة كما في document-archive.sql، وnotify_telegram بديل يسجّل التنبيهات في جدول اختبار.
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

create or replace function public.is_owner() returns boolean language sql stable security invoker
set search_path = public, pg_temp as $$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- بديل notify_telegram (التوقيع نفسه في الإنتاج): يسجّل ولا يرسل شيئاً.
create table public.test_owner_alerts (id serial primary key, event_type text, message text, dedupe_key text);
create or replace function public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text, p_dedupe_minutes integer)
returns void language sql security definer set search_path = public as $$
  insert into public.test_owner_alerts (event_type, message, dedupe_key) values (p_event_type, p_message, p_dedupe_key);
$$;
revoke all on function public.notify_telegram(text, text, text, integer) from public, anon, authenticated;

\i :migration22

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

-- كل job_id بمصدر مختلف (القيد الفريد (doc_type, source_guid, version)).
create function pg_temp.item(p_job text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object(
    'job_id', p_job, 'doc_type', 'wholesale_invoice',
    'source_guid', '11111111-1111-4111-8111-1111111111' || left(p_job, 2),
    'doc_number', '501', 'doc_date', '2026-10-24', 'customer_guid', 'aaaaaaaa-0000-4000-8000-000000000001',
    'customer_name', 'زبون تجريبي', 'amount', 1300, 'currency', 'USD', 'version', 1,
    'version_hash', repeat('1', 64), 'status', 'rendered', 'failed', false, 'attempts', 0,
    'drive_file_id', 'F000000000001xyz',
    'drive_web_link', 'https://drive.google.com/file/d/F000000000001xyz/view?usp=drivesdk') || p_extra
$$;

-- plpgsql: الجسم يُفحص عند الاستدعاء، فالدالتان تُعرَّفان قبل تطبيق 26.
create function pg_temp.claim(p_job text, p_claim uuid, p_extra jsonb default '{}') returns text language plpgsql as $$
begin
  return public.document_archive_claim_send(pg_temp.item(p_job, p_extra), p_claim) ->> 'result';
end $$;

create function pg_temp.state(p_job text) returns text language plpgsql as $$
begin
  return (select coalesce(send_state, 'null') from public.document_archive_items where job_id = p_job);
end $$;

create function pg_temp.alerts() returns bigint language sql as $$
  select count(*) from public.test_owner_alerts
$$;

-- بيانات قائمة قبل 26: إشعار مسجَّل (له رقم رسالة) وعنصر مرفوع بلا إشعار.
set role service_role;
select pg_temp.act('service');
select public.document_archive_record_notification(pg_temp.item(repeat('a', 32), '{"status":"notified","telegram_message_id":555}'));
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'dry-run',
  'items', jsonb_build_array(pg_temp.item(repeat('b', 32), '{"status":"uploaded"}'))));
reset role;

\i :migration26

\set QUIET 0
-- ── ١) الهجرة على بيانات قائمة ──
select pg_temp.ok(pg_temp.state(repeat('a', 32)) = 'sent', 'existing message_id backfilled as sent');
select pg_temp.ok(pg_temp.state(repeat('b', 32)) = 'null', 'unsent item untouched');
select pg_temp.ok((select status = 'notified' and telegram_message_id = 555 from public.document_archive_items where job_id = repeat('a', 32)), 'existing row data kept');

set role service_role;
select pg_temp.act('service');

-- ── ٢) الحجز والتكرار ──
select pg_temp.ok(pg_temp.claim(repeat('a', 32), gen_random_uuid()) = 'duplicate', 'sent item: duplicate, no claim');
select pg_temp.ok((public.document_archive_claim_send(pg_temp.item(repeat('a', 32)), gen_random_uuid()) ->> 'message_id')::bigint = 555, 'duplicate returns the same message_id');
select pg_temp.ok(pg_temp.claim(repeat('c', 32), '00000000-0000-4000-8000-00000000000c') = 'claimed', 'new job: claimed');
select pg_temp.ok((select send_state = 'sending' and send_claim_id = '00000000-0000-4000-8000-00000000000c' and status = 'uploaded'
  and send_claimed_at is not null from public.document_archive_items where job_id = repeat('c', 32)), 'claim recorded on the row');
select pg_temp.ok(pg_temp.claim(repeat('c', 32), gen_random_uuid()) = 'in_flight', 'second request while sending: in_flight');
select pg_temp.ok(pg_temp.claim(repeat('c', 32), '00000000-0000-4000-8000-00000000000c') = 'in_flight', 'same claim id again: still no second send');
select pg_temp.ok(pg_temp.claim(repeat('b', 32), gen_random_uuid()) = 'claimed', 'pre-existing unsent item: claimed');

-- ── ٣) التحرير: فشل صريح من تيليغرام، بحجز صاحبه وحده ──
select pg_temp.ok(not public.document_archive_release_send(repeat('c', 32), gen_random_uuid()), 'release with foreign claim refused');
select pg_temp.ok(pg_temp.state(repeat('c', 32)) = 'sending', 'foreign release leaves claim');
select pg_temp.ok(public.document_archive_release_send(repeat('c', 32), '00000000-0000-4000-8000-00000000000c'), 'owner of claim releases');
select pg_temp.ok(pg_temp.state(repeat('c', 32)) = 'null', 'released: no claim');
select pg_temp.ok(pg_temp.claim(repeat('c', 32), '00000000-0000-4000-8000-0000000000c2') = 'claimed', 'after release: new claim allowed');

-- ── ٤) تسجيل الإرسال يحسم الحجز، ولا تحرير بعده ──
select public.document_archive_record_notification(pg_temp.item(repeat('c', 32), '{"status":"notified","telegram_message_id":777}'));
select pg_temp.ok(pg_temp.state(repeat('c', 32)) = 'sent', 'record_notification marks sent');
select pg_temp.ok(not public.document_archive_release_send(repeat('c', 32), '00000000-0000-4000-8000-0000000000c2'), 'release after send refused');
select pg_temp.ok(pg_temp.claim(repeat('c', 32), gen_random_uuid()) = 'duplicate', 'after record: duplicate');

-- ── ٥) فشل التسجيل كلياً بعد الإرسال: تقرير العامل يحمل الرقم فيحسم الحجز بلا تنبيه ──
select pg_temp.ok(pg_temp.claim(repeat('d', 32), gen_random_uuid()) = 'claimed', 'job d claimed');
reset role;
update public.document_archive_items set send_claimed_at = now() - interval '20 minutes' where job_id = repeat('d', 32);
set role service_role;
select pg_temp.act('service');
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(pg_temp.item(repeat('d', 32), '{"status":"notified","telegram_message_id":888}'))));
select pg_temp.ok(pg_temp.state(repeat('d', 32)) = 'sent', 'worker report with message_id settles a stale claim');
reset role;
select pg_temp.ok(pg_temp.alerts() = 0, 'no false uncertain alert');

-- ── ٦) حجز علق (الدالة توقفت بعد الإرسال أو قبله): غامض، تنبيه واحد، لا إرسال تلقائي ──
set role service_role;
select pg_temp.act('service');
select pg_temp.ok(pg_temp.claim(repeat('e', 32), gen_random_uuid()) = 'claimed', 'job e claimed');
reset role;
update public.document_archive_items set send_claimed_at = now() - interval '16 minutes' where job_id = repeat('e', 32);
set role service_role;
select pg_temp.act('service');
select pg_temp.ok(pg_temp.claim(repeat('e', 32), gen_random_uuid()) = 'uncertain', 'stale claim: uncertain, no send');
select pg_temp.ok(pg_temp.state(repeat('e', 32)) = 'uncertain', 'row marked uncertain');
select pg_temp.ok(pg_temp.claim(repeat('e', 32), gen_random_uuid()) = 'uncertain', 'uncertain stays blocked');
reset role;
select pg_temp.ok(pg_temp.alerts() = 1, 'exactly one owner alert');
select pg_temp.ok((select dedupe_key = 'document-archive-uncertain:' || repeat('e', 32) and message like '%501%'
  from public.test_owner_alerts order by id desc limit 1), 'alert names the invoice, dedupe per job');

-- الحجز العالق يُحسم أيضاً بتقرير العامل الدوري (بلا طلب إشعار جديد).
set role service_role;
select pg_temp.act('service');
select pg_temp.ok(pg_temp.claim(repeat('f', 32), gen_random_uuid()) = 'claimed', 'job f claimed');
reset role;
update public.document_archive_items set send_claimed_at = now() - interval '30 minutes' where job_id = repeat('f', 32);
set role service_role;
select pg_temp.act('service');
select public.document_archive_ingest_report('{"host":"OZK2026","drive_state":"connected","mode":"live"}');
select pg_temp.ok(pg_temp.state(repeat('f', 32)) = 'uncertain', 'report sweep marks stale claim uncertain');
select public.document_archive_ingest_report('{"host":"OZK2026","drive_state":"connected","mode":"live"}');
reset role;
select pg_temp.ok(pg_temp.alerts() = 2, 'sweep alerts once per job');

-- تقرير لاحق يحمل رقم الرسالة يحسم الغامض (وصلت فعلاً).
set role service_role;
select pg_temp.act('service');
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(pg_temp.item(repeat('f', 32), '{"status":"notified","telegram_message_id":999}'))));
select pg_temp.ok(pg_temp.state(repeat('f', 32)) = 'sent', 'later message_id resolves uncertain');

-- ── ٧) الهوية ثابتة ──
select pg_temp.ok(pg_temp.claim(repeat('b', 32), gen_random_uuid(), jsonb_build_object('version_hash', repeat('f', 64))) = 'identity_conflict', 'different hash: identity_conflict');
select pg_temp.ok(pg_temp.claim(repeat('9', 32), gen_random_uuid(), jsonb_build_object('source_guid', '11111111-1111-4111-8111-1111111111bb')) = 'identity_conflict', 'same source/version under another job: identity_conflict');
select pg_temp.ok(not exists (select 1 from public.document_archive_items where job_id = repeat('9', 32)), 'conflicting job not created');
do $$ begin
  perform public.document_archive_claim_send(pg_temp.item(repeat('8', 32)), null);
  raise exception 'TEST FAIL: null claim accepted';
exception when invalid_parameter_value then raise notice 'PASS null claim id rejected';
end $$;
reset role;

-- ── ٨) الصلاحيات ──
set role authenticated;
select pg_temp.act('owner');
do $$ begin
  perform public.document_archive_claim_send(pg_temp.item(repeat('7', 32)), gen_random_uuid());
  raise exception 'TEST FAIL: owner can claim';
exception when insufficient_privilege then raise notice 'PASS authenticated cannot claim';
end $$;
do $$ begin
  perform public.document_archive_release_send(repeat('b', 32), gen_random_uuid());
  raise exception 'TEST FAIL: owner can release';
exception when insufficient_privilege then raise notice 'PASS authenticated cannot release';
end $$;
reset role;
set role anon;
select pg_temp.act('anon');
do $$ begin
  perform public.document_archive_claim_send(pg_temp.item(repeat('7', 32)), gen_random_uuid());
  raise exception 'TEST FAIL: anon can claim';
exception when insufficient_privilege then raise notice 'PASS anon cannot claim';
end $$;
do $$ begin
  perform public.request_document_archive_resend(repeat('e', 32));
  raise exception 'TEST FAIL: anon resend';
exception when insufficient_privilege then raise notice 'PASS anon cannot resend';
end $$;
reset role;

-- ── ٩) إعادة الإرسال: المالك وحده، للغامض وحده ──
set role authenticated;
select pg_temp.act('staff');
do $$ begin
  perform public.request_document_archive_resend(repeat('e', 32));
  raise exception 'TEST FAIL: staff resend';
exception when insufficient_privilege then raise notice 'PASS staff cannot resend';
end $$;
select pg_temp.act('owner');
select pg_temp.ok((public.request_document_archive_resend(repeat('a', 32)) ->> 'reason') = 'already_sent', 'resend refuses sent');
select pg_temp.ok((public.request_document_archive_resend(repeat('b', 32)) ->> 'reason') = 'not_uncertain', 'resend refuses in-flight/normal');
select pg_temp.ok((public.request_document_archive_resend(repeat('0', 32)) ->> 'reason') = 'not_found', 'resend unknown job');
select pg_temp.ok((public.request_document_archive_resend(repeat('e', 32)) ->> 'ok')::boolean, 'owner resends uncertain');
select pg_temp.ok(pg_temp.state(repeat('e', 32)) = 'null', 'resend clears uncertain');
reset role;
set role service_role;
select pg_temp.act('service');
select pg_temp.ok((public.document_archive_ingest_report('{"host":"OZK2026","drive_state":"connected","mode":"live"}') -> 'retry_job_ids') = jsonb_build_array(repeat('e', 32)), 'resend delivered to worker once');
select pg_temp.ok(pg_temp.claim(repeat('e', 32), gen_random_uuid()) = 'claimed', 'after owner resend: one new claim');
reset role;

\echo SEND_CLAIM_PART1_OK
-- @@CONCURRENCY@@
\set ON_ERROR_STOP 1
create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'TEST FAIL: %', p_name; end if;
  raise notice 'PASS %', p_name;
end $$;

select pg_temp.ok((select count(*) = 1 and bool_and(send_state = 'sending') from public.document_archive_items where job_id = repeat('5', 32)), 'concurrent claims left exactly one sending row');

-- ── ١٠) التراجع عن 26: 22 تعمل كما كانت، والبيانات باقية ──
\i :rollback26
select pg_temp.ok(not exists (select 1 from information_schema.columns where table_name = 'document_archive_items'
  and column_name in ('send_state', 'send_claim_id', 'send_claimed_at')), 'rollback 26 drops claim columns');
select pg_temp.ok(to_regprocedure('public.document_archive_claim_send(jsonb,uuid)') is null
  and to_regprocedure('public.document_archive_release_send(text,uuid)') is null
  and to_regprocedure('public.request_document_archive_resend(text)') is null
  and to_regprocedure('private.document_archive_mark_uncertain(text)') is null, 'rollback 26 drops claim functions');
select pg_temp.ok((select telegram_message_id = 555 from public.document_archive_items where job_id = repeat('a', 32)), 'rollback 26 keeps rows');
set role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(jsonb_build_object('job_id', repeat('5', 32), 'doc_type', 'wholesale_invoice',
    'source_guid', '11111111-1111-4111-8111-111111111155', 'doc_number', '502', 'doc_date', '2026-10-24',
    'customer_name', 'زبون تجريبي', 'currency', 'USD', 'version', 1, 'version_hash', repeat('1', 64),
    'status', 'notified', 'telegram_message_id', 4242))));
reset role;
select pg_temp.ok((select telegram_message_id = 4242 and status = 'notified' from public.document_archive_items where job_id = repeat('5', 32)), '22 ingest works after rollback 26');

\i :rollback22
select pg_temp.ok(to_regclass('public.document_archive_items') is null, 'rollback 22 removes objects');

\echo DOCUMENT_ARCHIVE_SEND_CLAIM_OK
