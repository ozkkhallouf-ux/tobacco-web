-- إثبات تشغيلي لـ supabase/proposed/16-price-sync-heartbeat.sql على قاعدة فارغة محلية.
-- يشغّله scripts/check-price-sync-heartbeat.mjs في قاعدة مؤقتة تُحذف بعده.
-- لا يُشغَّل على المشروع الحي: يرفض أي خادم خارج الحلقة المحلية وأي جدول بشكل الإنتاج.

\set ON_ERROR_STOP on

do $$
begin
  if current_database() is distinct from 'ozk_price_sync_heartbeat_test'
     and inet_server_addr() is not null
     and host(inet_server_addr()) not in ('127.0.0.1', '::1') then
    raise exception 'price sync heartbeat test refuses a non-loopback server';
  end if;
  if to_regclass('public.approved_price_items') is not null
     or to_regclass('public.inventory_reports') is not null then
    raise exception 'refusing: database has production tables';
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

create schema if not exists auth;
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- بديل اختبار لـ is_staff(): مستخدم واحد مسموح.
create or replace function public.is_staff()
returns boolean language sql stable as $$
  select auth.uid() = '11111111-1111-1111-1111-111111111111'::uuid;
$$;
grant execute on function public.is_staff() to authenticated;

\i supabase/proposed/16-price-sync-heartbeat.sql

-- يعيد التطبيق بلا خطأ (idempotent).
\i supabase/proposed/16-price-sync-heartbeat.sql

grant usage on schema public to anon, authenticated;

create or replace function pg_temp.as_user(p_uid text) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claim.sub', p_uid, false);
$$;

create or replace function pg_temp.expect_error(p_sql text, p_code text, p_label text)
returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected % for: %', p_code, p_label;
exception when others then
  if sqlstate <> p_code then
    raise exception 'expected % but got % (%) for: %', p_code, sqlstate, sqlerrm, p_label;
  end if;
end;
$$;

create or replace function pg_temp.latest() returns public.price_sync_heartbeat language sql as $$
  select * from public.price_sync_heartbeat order by created_at desc, id desc limit 1;
$$;

-- ── الصلاحيات ──────────────────────────────────────────────────────────────
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
set role authenticated;
select pg_temp.expect_error(
  $q$select public.record_price_sync_heartbeat('{"status":"ok","applied":true,"ameen_connected":true}')$q$,
  '42501', 'non sync identity');
select pg_temp.expect_error(
  $q$insert into public.price_sync_heartbeat(status, stage) values ('ok', 'done')$q$,
  '42501', 'direct insert');
reset role;

set role anon;
select pg_temp.expect_error(
  $q$select public.record_price_sync_heartbeat('{"status":"ok"}')$q$,
  '42501', 'anon execute');
reset role;

-- ── المدخلات ───────────────────────────────────────────────────────────────
select pg_temp.as_user('9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3');
set role authenticated;
select pg_temp.expect_error(
  $q$select public.record_price_sync_heartbeat('{"status":"bogus"}')$q$, '22023', 'unknown status');
select pg_temp.expect_error(
  $q$select public.record_price_sync_heartbeat('{"status":"ok","applied":false,"ameen_connected":true}')$q$,
  '22023', 'ok without apply');
select pg_temp.expect_error(
  $q$select public.record_price_sync_heartbeat('[]')$q$, '22023', 'non object');

-- ── 1) أول نجاح ────────────────────────────────────────────────────────────
select public.record_price_sync_heartbeat(jsonb_build_object(
  'status', 'ok', 'stage', 'done', 'applied', true, 'ameen_connected', true,
  'pulled_count', 321, 'feed_max_updated_at', '2026-10-18T07:30:00Z',
  'applied_wholesale', 321, 'applied_retail', 317, 'verified_wholesale', 321, 'verified_retail', 317));
reset role;

do $$
declare r public.price_sync_heartbeat := pg_temp.latest();
begin
  if r.last_success_at is null or r.last_applied_at is null or r.ameen_connected_at is null then
    raise exception 'first ok must set success, applied and connected: %', row_to_json(r);
  end if;
  if r.new_prices is distinct from true or r.previous_status is not null or r.gap_minutes is not null then
    raise exception 'first ok: new_prices=true and no previous row expected: %', row_to_json(r);
  end if;
  if r.created_by is distinct from '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid then
    raise exception 'created_by must be the sync identity';
  end if;
  if r.pulled_count <> 321 or r.applied_retail <> 317 then
    raise exception 'counts not stored: %', row_to_json(r);
  end if;
end
$$;

-- نقل الصف للماضي لمحاكاة مرور الوقت (as superuser).
update public.price_sync_heartbeat set created_at = created_at - interval '5 minutes',
  last_success_at = last_success_at - interval '5 minutes',
  last_applied_at = last_applied_at - interval '5 minutes',
  ameen_connected_at = ameen_connected_at - interval '5 minutes';

-- ── 2) المهمة تعمل ولا توجد أسعار جديدة ───────────────────────────────────
set role authenticated;
select public.record_price_sync_heartbeat(jsonb_build_object(
  'status', 'ok', 'stage', 'done', 'applied', true, 'ameen_connected', true,
  'pulled_count', 321, 'feed_max_updated_at', '2026-10-18T07:30:00Z'));
reset role;
do $$
declare r public.price_sync_heartbeat := pg_temp.latest();
begin
  if r.new_prices is distinct from false then raise exception 'same feed max must give new_prices=false'; end if;
  if r.previous_status <> 'ok' or r.gap_minutes < 4.9 or r.gap_minutes > 5.1 then
    raise exception 'previous status and 5 minute gap expected: %', row_to_json(r);
  end if;
end
$$;

-- ── 3) فشل الاتصال بالأمين: آخر نجاح واتصال يبقيان، والفشل يُسجَّل ────────
update public.price_sync_heartbeat set created_at = created_at - interval '5 minutes',
  last_success_at = last_success_at - interval '5 minutes',
  last_applied_at = last_applied_at - interval '5 minutes',
  ameen_connected_at = ameen_connected_at - interval '5 minutes';
create temp table before_failure as select * from pg_temp.latest();
set role authenticated;
select public.record_price_sync_heartbeat(jsonb_build_object(
  'status', 'apply_failed', 'stage', 'apply', 'pulled_count', 321,
  'feed_max_updated_at', '2026-10-18T07:46:00Z', 'message', 'فشل تطبيق الأسعار على قاعدة الأمين'));
reset role;
do $$
declare
  r public.price_sync_heartbeat := pg_temp.latest();
  b record;
begin
  select * into b from before_failure;
  if r.last_success_at is distinct from b.last_success_at
     or r.ameen_connected_at is distinct from b.ameen_connected_at
     or r.last_applied_at is distinct from b.last_applied_at
     or r.applied_feed_max_updated_at is distinct from b.applied_feed_max_updated_at then
    raise exception 'failure must carry success/connected/applied forward: %', row_to_json(r);
  end if;
  if r.last_failure_at is null or r.last_failure_status <> 'apply_failed' or r.new_prices is not null then
    raise exception 'failure must be recorded without new_prices: %', row_to_json(r);
  end if;
  if r.message <> 'فشل تطبيق الأسعار على قاعدة الأمين' then raise exception 'arabic message lost'; end if;
end
$$;

-- ── 4) تعارض أسعار: التطبيق يُسجَّل، والنجاح المثبت لا يتقدم ───────────────
set role authenticated;
select public.record_price_sync_heartbeat(jsonb_build_object(
  'status', 'ok', 'stage', 'done', 'applied', true, 'ameen_connected', true,
  'feed_max_updated_at', '2026-10-18T07:46:00Z', 'conflict_count', 2));
reset role;
do $$
declare
  r public.price_sync_heartbeat := pg_temp.latest();
  b record;
begin
  select * into b from before_failure;
  if r.last_success_at is distinct from b.last_success_at then raise exception 'conflict must not count as proven success'; end if;
  if r.last_applied_at <= b.last_applied_at or r.conflict_count <> 2 or r.new_prices is distinct from true then
    raise exception 'conflict run must record apply and new prices: %', row_to_json(r);
  end if;
  if r.last_failure_status <> 'apply_failed' then raise exception 'last failure must be carried'; end if;
end
$$;

-- ── 5) تعطيل خارجي ثم استئناف بعد فجوة ─────────────────────────────────────
set role authenticated;
select public.record_price_sync_heartbeat('{"status":"disabled","message":"معطّلة للصيانة"}');
reset role;
do $$
declare r public.price_sync_heartbeat := pg_temp.latest();
begin
  if r.stage <> 'external' or r.last_applied_at is null or r.last_failure_status <> 'apply_failed' then
    raise exception 'disabled must keep history and default stage external: %', row_to_json(r);
  end if;
end
$$;
update public.price_sync_heartbeat set created_at = created_at - interval '76 minutes';
set role authenticated;
select public.record_price_sync_heartbeat(jsonb_build_object(
  'status', 'ok', 'stage', 'done', 'applied', true, 'ameen_connected', true,
  'feed_max_updated_at', '2026-10-18T08:34:00Z'));
reset role;
do $$
declare r public.price_sync_heartbeat := pg_temp.latest();
begin
  if r.previous_status <> 'disabled' or r.gap_minutes < 75.9 then
    raise exception 'resume must report the gap after disabled: %', row_to_json(r);
  end if;
  if r.last_success_at < now() - interval '1 second' or r.new_prices is distinct from true then
    raise exception 'resume must be a fresh proven success with new prices: %', row_to_json(r);
  end if;
end
$$;

-- ── 6) القراءة: الموظف وحده، والكتابة المباشرة ممنوعة ──────────────────────
select pg_temp.as_user('22222222-2222-2222-2222-222222222222');
set role authenticated;
do $$
begin
  if (select count(*) from public.price_sync_heartbeat) <> 0 then
    raise exception 'non staff must not read heartbeat rows';
  end if;
end
$$;
reset role;
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
set role authenticated;
do $$
begin
  if (select count(*) from public.price_sync_heartbeat) < 5 then
    raise exception 'staff must read heartbeat rows';
  end if;
end
$$;
select pg_temp.expect_error($q$delete from public.price_sync_heartbeat$q$, '42501', 'staff delete');
select pg_temp.expect_error($q$update public.price_sync_heartbeat set status = 'ok'$q$, '42501', 'staff update');
reset role;
set role anon;
select pg_temp.expect_error($q$select 1 from public.price_sync_heartbeat$q$, '42501', 'anon select');
reset role;

-- ── 7) الاحتفاظ 14 يوماً ───────────────────────────────────────────────────
update public.price_sync_heartbeat set created_at = now() - interval '20 days'
  where id = (select min(id) from public.price_sync_heartbeat);
select pg_temp.as_user('9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3');
set role authenticated;
select public.record_price_sync_heartbeat('{"status":"pull_failed","stage":"pull"}');
reset role;
do $$
begin
  if exists (select 1 from public.price_sync_heartbeat where created_at < now() - interval '14 days') then
    raise exception 'rows older than 14 days must be pruned';
  end if;
end
$$;

-- ── 8) التراجع ─────────────────────────────────────────────────────────────
-- دالة الاختبار المؤقتة تعتمد على نوع الصف، فتُسقط قبل التراجع.
drop function pg_temp.latest();
\i supabase/proposed/16-price-sync-heartbeat-rollback.sql
do $$
begin
  if to_regclass('public.price_sync_heartbeat') is not null
     or to_regprocedure('public.record_price_sync_heartbeat(jsonb)') is not null then
    raise exception 'rollback must drop table and function';
  end if;
end
$$;

\echo PRICE_SYNC_HEARTBEAT_TEST_OK
