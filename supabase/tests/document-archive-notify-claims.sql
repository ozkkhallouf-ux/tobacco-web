-- اختبار supabase/proposed/26-document-archive-notify-claims.sql (فوق 22) على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-drive-invoice-archive.mjs في قاعدة مستقلة، ثم يختبر التزامن الحقيقي
-- بعمليات psql متوازية، ثم التراجع. لا اتصال بأي خدمة خارجية ولا بيانات إنتاج.
\set ON_ERROR_STOP 1
\set QUIET 1

do $guard$
begin
  if current_database() is distinct from 'ozk_document_archive_claims_test' then
    raise exception 'notify claims test runs only in ozk_document_archive_claims_test';
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

\i :migration22
\i :migration26

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

create function pg_temp.claim(p_job text) returns jsonb language sql as $$
  select public.document_archive_claim_notification(p_job, 300)
$$;
create function pg_temp.state(p_job text) returns text language sql as $$
  select state from public.document_archive_notify_claims where job_id = p_job
$$;

\set QUIET 0
set role service_role;
select pg_temp.act('service');

-- ── ١) حجز، ثم قائم، ثم مُرسَل ──
create temp table t (k text primary key, v jsonb);
insert into t values ('a', pg_temp.claim(repeat('a', 32)));
select pg_temp.ok((select v ->> 'status' from t where k = 'a') = 'claimed' and (select v ? 'token' from t where k = 'a'), 'first claim wins');
select pg_temp.ok(pg_temp.claim(repeat('a', 32)) ->> 'status' = 'in_progress', 'second claim within lease is in_progress');
select pg_temp.ok((public.document_archive_finish_notification(repeat('a', 32), gen_random_uuid(), 'sent', 7001) ->> 'ok')::boolean = false, 'finish with foreign token ignored');
do $$ begin
  perform public.document_archive_finish_notification(repeat('a', 32), (select (v ->> 'token')::uuid from t where k = 'a'), 'sent', null);
  raise exception 'TEST FAIL: sent without message_id accepted';
exception when invalid_parameter_value then raise notice 'PASS sent requires message_id';
end $$;
select pg_temp.ok((public.document_archive_finish_notification(repeat('a', 32), (select (v ->> 'token')::uuid from t where k = 'a'), 'sent', 7001) ->> 'ok')::boolean, 'finish sent');
select pg_temp.ok(pg_temp.claim(repeat('a', 32)) = '{"status":"sent","message_id":7001}'::jsonb, 'claim after sent returns message_id, no new claim');
select pg_temp.ok((public.document_archive_finish_notification(repeat('a', 32), (select (v ->> 'token')::uuid from t where k = 'a'), 'not_sent') ->> 'ok')::boolean = false, 'sent cannot be downgraded');

-- ── ٢) رفض صريح ⇒ released ⇒ حجز جديد ──
insert into t values ('b', pg_temp.claim(repeat('b', 32)));
select pg_temp.ok((public.document_archive_finish_notification(repeat('b', 32), (select (v ->> 'token')::uuid from t where k = 'b'), 'not_sent', null, 'telegram_sendDocument_429') ->> 'ok')::boolean, 'finish not_sent');
select pg_temp.ok(pg_temp.state(repeat('b', 32)) = 'released', 'not_sent releases');
select pg_temp.ok(pg_temp.claim(repeat('b', 32)) ->> 'status' = 'claimed', 'released can be claimed again');
select pg_temp.ok((select attempts from public.document_archive_notify_claims where job_id = repeat('b', 32)) = 2, 'reclaim counts attempts');

-- ── ٣) مجهول ⇒ لا حجز إلا بتحرير المالك ──
insert into t values ('c', pg_temp.claim(repeat('c', 32)));
select pg_temp.ok((public.document_archive_finish_notification(repeat('c', 32), (select (v ->> 'token')::uuid from t where k = 'c'), 'unknown', null, 'telegram_sendDocument_network') ->> 'ok')::boolean, 'finish unknown');
select pg_temp.ok(pg_temp.claim(repeat('c', 32)) ->> 'status' = 'unknown' and pg_temp.claim(repeat('c', 32)) ->> 'status' = 'unknown', 'unknown stays unknown');
select pg_temp.ok(public.document_archive_release_notification_claims(array[repeat('a', 32), repeat('c', 32)]) = 1, 'release touches unknown only');
select pg_temp.ok(pg_temp.state(repeat('a', 32)) = 'sent', 'release never touches sent');
select pg_temp.ok(pg_temp.claim(repeat('c', 32)) ->> 'status' = 'claimed', 'owner-released unknown can be claimed');

-- ── ٤) انتهاء مهلة sending ⇒ مجهول؛ رد متأخر بالرمز نفسه يصحّحه إلى sent ──
insert into t values ('d', pg_temp.claim(repeat('d', 32)));
update public.document_archive_notify_claims set claimed_at = now() - interval '6 minutes' where job_id = repeat('d', 32);
select pg_temp.ok(pg_temp.claim(repeat('d', 32)) ->> 'status' = 'unknown', 'expired lease becomes unknown, not released');
select pg_temp.ok((select last_error from public.document_archive_notify_claims where job_id = repeat('d', 32)) = 'lease_expired', 'expired lease recorded');
select pg_temp.ok((public.document_archive_finish_notification(repeat('d', 32), (select (v ->> 'token')::uuid from t where k = 'd'), 'not_sent') ->> 'ok')::boolean = false, 'late not_sent cannot release unknown');
select pg_temp.ok((public.document_archive_finish_notification(repeat('d', 32), (select (v ->> 'token')::uuid from t where k = 'd'), 'sent', 7004) ->> 'ok')::boolean, 'late sent with same token accepted');
select pg_temp.ok(pg_temp.state(repeat('d', 32)) = 'sent', 'late sent resolves to sent');

-- ── ٥) message_id مسجَّل قبل الهجرة أو بتقرير العامل يبقى حارساً ──
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(jsonb_build_object('job_id', repeat('e', 32), 'doc_type', 'wholesale_invoice',
    'source_guid', '11111111-1111-4111-8111-111111111111', 'doc_number', '505', 'doc_date', '2026-10-24',
    'version', 1, 'version_hash', repeat('1', 64), 'status', 'notified', 'failed', false, 'attempts', 0,
    'telegram_message_id', 7005)))) is not null as reported \gset
select pg_temp.ok(pg_temp.claim(repeat('e', 32)) = '{"status":"sent","message_id":7005}'::jsonb, 'legacy telegram_message_id blocks resend');
insert into t values ('f', pg_temp.claim(repeat('f', 32)));
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(jsonb_build_object('job_id', repeat('f', 32), 'doc_type', 'wholesale_invoice',
    'source_guid', '11111111-1111-4111-8111-111111111112', 'doc_number', '506', 'doc_date', '2026-10-24',
    'version', 1, 'version_hash', repeat('2', 64), 'status', 'notified', 'failed', false, 'attempts', 0,
    'telegram_message_id', 7006)))) is not null as reported \gset
select pg_temp.ok(pg_temp.claim(repeat('f', 32)) ->> 'message_id' = '7006', 'worker report message_id returned for a stuck claim');
select pg_temp.ok(pg_temp.state(repeat('f', 32)) = 'sent', 'worker report resolves a stuck sending claim to sent');

-- ── ٥ب) تنبيه المالك عند «غير محسوم» ──
-- قبل وجود notify_telegram (أعلاه): الانتقال إلى unknown نجح بلا تنبيه ولا خطأ.
select pg_temp.ok((select alerted_at is null from public.document_archive_notify_claims where job_id = repeat('c', 32)), 'no notify_telegram: unknown still recorded, no alert, no error');
reset role;
create table public.test_alerts (event_type text, message text, dedupe_key text, dedupe_minutes int);
grant select on public.test_alerts to service_role;
create function public.notify_telegram(p_event_type text, p_message text, p_dedupe_key text default null,
  p_dedupe_minutes int default 60, p_reply_markup jsonb default null) returns void language plpgsql as $$
begin
  if current_setting('test.alerts_fail', true) = 'on' then raise exception 'outbox down'; end if;
  if p_dedupe_key is not null and exists (select 1 from public.test_alerts where dedupe_key = p_dedupe_key) then return; end if;
  insert into public.test_alerts values (p_event_type, p_message, p_dedupe_key, p_dedupe_minutes);
end $$;
set role service_role;

insert into t values ('g', public.document_archive_claim_notification(repeat('a', 31) || '1', 300, 'فاتورة جملة رقم 601 — 2026-10-25 — V1'));
select pg_temp.ok((select count(*) from public.test_alerts) = 0, 'claim alone sends no alert');
select pg_temp.ok((public.document_archive_finish_notification(repeat('a', 31) || '1', (select (v ->> 'token')::uuid from t where k = 'g'), 'unknown', null, 'telegram_sendDocument_network') ->> 'ok')::boolean, 'finish unknown with outbox');
select pg_temp.ok((select count(*) from public.test_alerts) = 1, 'unknown raises exactly one owner alert');
select pg_temp.ok((select event_type = 'document_archive_unknown' and dedupe_key = 'document-archive-unknown:' || repeat('a', 31) || '1:1' and dedupe_minutes = 1440
  from public.test_alerts), 'alert event, per-incident dedupe key (job:attempt), 24h window');
select pg_temp.ok((select message like '%إرسال غير محسوم%' and message like '%فاتورة جملة رقم 601 — 2026-10-25 — V1%'
  and message like '%ولن يُعاد إرساله تلقائياً%' and message like '%telegram_sendDocument_network%' from public.test_alerts), 'alert text names the document, the reason and no auto-resend');
select pg_temp.ok((select alerted_at is not null from public.document_archive_notify_claims where job_id = repeat('a', 31) || '1'), 'alerted_at recorded');
select pg_temp.ok(pg_temp.claim(repeat('a', 31) || '1') ->> 'status' = 'unknown' and (select count(*) from public.test_alerts) = 1, 'repeated claims on unknown do not re-alert');

-- حادثة ثانية خلال 24 ساعة: المالك يعيد المحاولة (مساره الموثّق أدناه في ٥ج)، فتصير المحاولة الجديدة
-- غير محسومة أيضاً (توقفت الدالة بعد الإرسال ⇒ انتهاء المهلة) ⇒ تنبيه جديد واحد لها، والسابق لا يتكرر.
select pg_temp.ok(public.document_archive_release_notification_claims(array[repeat('a', 31) || '1']) = 1, 'incident 1 released by owner retry');
insert into t values ('g2', public.document_archive_claim_notification(repeat('a', 31) || '1', 300, 'فاتورة جملة رقم 601 — 2026-10-25 — V1'));
select pg_temp.ok((select v ->> 'status' from t where k = 'g2') = 'claimed', 'owner retry: exactly one new claim');
select pg_temp.ok(pg_temp.claim(repeat('a', 31) || '1') ->> 'status' = 'in_progress' and (select count(*) from public.test_alerts) = 1, 'new attempt in flight: no alert yet');
update public.document_archive_notify_claims set claimed_at = now() - interval '10 minutes' where job_id = repeat('a', 31) || '1';
select pg_temp.ok(pg_temp.claim(repeat('a', 31) || '1') ->> 'status' = 'unknown', 'incident 2: second attempt expires to unknown');
select pg_temp.ok((select count(*) from public.test_alerts where dedupe_key like 'document-archive-unknown:' || repeat('a', 31) || '1:%') = 2
  and exists (select 1 from public.test_alerts where dedupe_key = 'document-archive-unknown:' || repeat('a', 31) || '1:2'), 'incident 2 within 24h: one new alert');
select pg_temp.ok(pg_temp.claim(repeat('a', 31) || '1') ->> 'status' = 'unknown' and pg_temp.claim(repeat('a', 31) || '1') ->> 'status' = 'unknown'
  and (select count(*) from public.test_alerts where dedupe_key like 'document-archive-unknown:' || repeat('a', 31) || '1:%') = 2, 'incident 2 repeated claims: no extra alert');
-- الردّ المتأخر للمحاولة الثانية (ضاع ثم وصل بالرمز نفسه) يحسمها مُرسَلة بلا تنبيه ولا إرسال آخر.
select pg_temp.ok((public.document_archive_finish_notification(repeat('a', 31) || '1', (select (v ->> 'token')::uuid from t where k = 'g2'), 'sent', 7601) ->> 'ok')::boolean
  and pg_temp.claim(repeat('a', 31) || '1') = '{"status":"sent","message_id":7601}'::jsonb, 'late response resolves incident 2 to sent');
select pg_temp.ok(public.document_archive_release_notification_claims(array[repeat('a', 31) || '1']) = 0, 'owner retry cannot release a sent claim');
select pg_temp.ok((select count(*) from public.test_alerts where dedupe_key like 'document-archive-unknown:' || repeat('a', 31) || '1:%') = 2, 'no alert for sent');

insert into t values ('h', public.document_archive_claim_notification(repeat('a', 31) || '2', 300, 'فاتورة جملة رقم 602 — 2026-10-25 — V2'));
update public.document_archive_notify_claims set claimed_at = now() - interval '10 minutes' where job_id = repeat('a', 31) || '2';
select pg_temp.ok(pg_temp.claim(repeat('a', 31) || '2') ->> 'status' = 'unknown', 'lease expiry with outbox');
select pg_temp.ok((select count(*) from public.test_alerts where message like '%رقم 602%' and message like '%lease_expired%') = 1, 'lease expiry alerts once with reason');

insert into t values ('i', public.document_archive_claim_notification(repeat('a', 31) || '3', 300, 'فاتورة جملة رقم 603'));
select public.document_archive_finish_notification(repeat('a', 31) || '3', (select (v ->> 'token')::uuid from t where k = 'i'), 'not_sent', null, 'telegram_sendDocument_429') is not null as x \gset
insert into t values ('j', public.document_archive_claim_notification(repeat('a', 31) || '4', 300, 'فاتورة جملة رقم 604'));
select public.document_archive_finish_notification(repeat('a', 31) || '4', (select (v ->> 'token')::uuid from t where k = 'j'), 'sent', 7604) is not null as x \gset
select pg_temp.ok((select count(*) from public.test_alerts) = 3, 'not_sent and sent raise no alert');

select set_config('test.alerts_fail', 'on', false) is not null as x \gset
insert into t values ('k', public.document_archive_claim_notification(repeat('a', 31) || '5', 300, 'فاتورة جملة رقم 605'));
select pg_temp.ok((public.document_archive_finish_notification(repeat('a', 31) || '5', (select (v ->> 'token')::uuid from t where k = 'k'), 'unknown', null, 'x') ->> 'ok')::boolean
  , 'outbox failure does not fail finish');
select pg_temp.ok(pg_temp.state(repeat('a', 31) || '5') = 'unknown', 'outbox failure keeps unknown state');
select pg_temp.ok((select alerted_at is null from public.document_archive_notify_claims where job_id = repeat('a', 31) || '5'), 'failed alert not marked alerted');
select set_config('test.alerts_fail', 'off', false) is not null as x \gset

-- ── ٥ج) مسار إعادة المالك اليدوي من SQL Editor (supabase/proposed/26-document-archive-owner-retry.sql) ──
-- SQL Editor بلا جلسة: الدالة الرسمية وحدها ترفض. الملف يمرّ بها بهوية المالك من auth.users.
reset role;
select set_config('request.jwt.claims', '', false) is not null as x \gset
create table auth.users (id uuid primary key, email text unique, raw_app_meta_data jsonb);
insert into auth.users values
  ('22222222-2222-2222-2222-222222222222', 'ozkkhallouf@gmail.com', '{"role":"owner"}'),
  ('11111111-1111-1111-1111-111111111111', 'staff@example.test', '{"role":"employee"}');
set role service_role;
select pg_temp.act('service');
insert into t values ('r', pg_temp.claim(repeat('8', 32)));
select public.document_archive_finish_notification(repeat('8', 32), (select (v ->> 'token')::uuid from t where k = 'r'), 'unknown', null, 'telegram_sendDocument_network') is not null as x \gset
select public.document_archive_ingest_report(jsonb_build_object('host', 'OZK2026', 'drive_state', 'connected', 'mode', 'live',
  'items', jsonb_build_array(jsonb_build_object('job_id', repeat('8', 32), 'doc_type', 'wholesale_invoice',
    'source_guid', '11111111-1111-4111-8111-111111111188', 'doc_number', '608', 'doc_date', '2026-10-25',
    'version', 1, 'version_hash', repeat('8', 64), 'status', 'uploaded', 'failed', true, 'attempts', 0,
    'last_error', 'notify:DELIVERY_UNKNOWN')))) is not null as x \gset
reset role;
select set_config('request.jwt.claims', '', false) is not null as x \gset
do $$ begin
  perform public.request_document_archive_retry(repeat('8', 32));
  raise exception 'TEST FAIL: retry without owner session accepted';
exception when insufficient_privilege then raise notice 'PASS SQL Editor without session: direct call refused (owner only)';
end $$;
\i :owner_retry
select pg_temp.ok((select count(*) = 1 and bool_and(requested_by = '22222222-2222-2222-2222-222222222222' and consumed_at is null)
  from public.document_archive_retry_requests where job_id = repeat('8', 32)), 'owner retry file: one open request as the owner');
select pg_temp.ok(coalesce(current_setting('request.jwt.claims', true), '') = '', 'owner identity does not outlive the transaction');
\i :owner_retry
select pg_temp.ok((select count(*) from public.document_archive_retry_requests where job_id = repeat('8', 32)) = 1, 'owner retry file twice: still one request');
-- حساب غير مالك بالمسار نفسه ⇒ رفض.
do $$ begin
  perform set_config('request.jwt.claims', (select json_build_object('sub', id, 'role', 'authenticated', 'app_metadata', raw_app_meta_data)::text
    from auth.users where email = 'staff@example.test'), true);
  perform public.request_document_archive_retry(repeat('8', 32));
  raise exception 'TEST FAIL: staff retry accepted';
exception when insufficient_privilege then raise notice 'PASS non-owner identity refused';
end $$;
-- التقرير التالي يسلّم الطلب، وتحرير الدالة يمسّ المجهول وحده، فحجز جديد واحد بالضبط.
set role service_role;
select pg_temp.act('service');
select pg_temp.ok((select (public.document_archive_ingest_report('{"host":"OZK2026","drive_state":"connected","mode":"live"}') -> 'retry_job_ids') = jsonb_build_array(repeat('8', 32))), 'report delivers owner retry once');
select pg_temp.ok(public.document_archive_release_notification_claims(array[repeat('8', 32)]) = 1, '/report releases the unknown claim');
select pg_temp.ok(pg_temp.claim(repeat('8', 32)) ->> 'status' = 'claimed' and pg_temp.claim(repeat('8', 32)) ->> 'status' = 'in_progress', 'after owner retry: one claim, then in_progress');

-- ── ٦) مدخلات ──
do $$ begin
  perform public.document_archive_claim_notification('not-a-job', 300);
  raise exception 'TEST FAIL: invalid job_id accepted';
exception when invalid_parameter_value then raise notice 'PASS invalid job_id rejected';
end $$;
do $$ begin
  perform public.document_archive_claim_notification(repeat('a', 32), 5);
  raise exception 'TEST FAIL: tiny lease accepted';
exception when invalid_parameter_value then raise notice 'PASS lease bounds enforced';
end $$;
do $$ begin
  insert into public.document_archive_notify_claims (job_id, state, claim_token) values (repeat('9', 32), 'sent', gen_random_uuid());
  raise exception 'TEST FAIL: sent without message_id stored';
exception when check_violation then raise notice 'PASS sent row requires message_id';
end $$;
reset role;

-- ── ٧) الصلاحيات ──
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    begin
      execute format('set local role %I', r);
      perform public.document_archive_claim_notification(repeat('7', 32), 300);
      raise exception 'TEST FAIL: % can claim', r;
    exception when insufficient_privilege then raise notice 'PASS % cannot claim', r;
    end;
    begin
      execute format('set local role %I', r);
      perform public.document_archive_release_notification_claims(array[repeat('c', 32)]);
      raise exception 'TEST FAIL: % can release', r;
    exception when insufficient_privilege then raise notice 'PASS % cannot release', r;
    end;
    begin
      execute format('set local role %I', r);
      perform public.document_archive_finish_notification(repeat('a', 32), gen_random_uuid(), 'unknown');
      raise exception 'TEST FAIL: % can finish', r;
    exception when insufficient_privilege then raise notice 'PASS % cannot finish', r;
    end;
  end loop;
end $$;
reset role;

set role authenticated;
select pg_temp.act('owner');
select pg_temp.ok((select count(*) from public.document_archive_notify_claims) >= 5, 'owner reads claims');
do $$ begin
  update public.document_archive_notify_claims set state = 'released';
  raise exception 'TEST FAIL: owner direct update allowed';
exception when insufficient_privilege then raise notice 'PASS owner cannot update claims directly';
end $$;
select pg_temp.act('staff');
select pg_temp.ok((select count(*) from public.document_archive_notify_claims) = 0, 'staff sees no claims');
reset role;
set role anon;
do $$ begin
  perform 1 from public.document_archive_notify_claims;
  raise exception 'TEST FAIL: anon reads claims';
exception when insufficient_privilege then raise notice 'PASS anon cannot read claims';
end $$;
reset role;

\echo NOTIFY_CLAIMS_SQL_OK
