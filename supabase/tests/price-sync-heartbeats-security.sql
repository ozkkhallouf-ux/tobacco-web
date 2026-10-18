-- اختبار أمني لـ supabase/proposed/16-price-sync-heartbeats.sql على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-price-sync-heartbeats-security.mjs (قاعدة مستقلة تُحذف بعده).
-- بيئة مصطنعة: أدوار Supabase وauth.uid()/auth.jwt() من request.jwt.claims وis_staff() بجسم الإنتاج.
-- لا اتصال بأي خدمة خارجية ولا بيانات إنتاج.
\set ON_ERROR_STOP 1
\set QUIET 1

-- ── بيئة Supabase المصغّرة ─────────────────────────────────────────────────────────────────────
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

create table public.staff_allowlist (email text primary key);
insert into public.staff_allowlist values ('staff@example.test'), ('owner@example.test');
-- جسم is_staff() كما هو على الإنتاج.
create or replace function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''))
  );
$$;
grant execute on function public.is_staff() to anon, authenticated, service_role;

-- هويات الاختبار
create table pg_temp.ids (name text primary key, claims jsonb not null, db_role text not null);
insert into pg_temp.ids values
  ('sync',    '{"sub":"9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3","role":"authenticated","email":"sync@example.test"}', 'authenticated'),
  ('staff',   '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"staff@example.test"}', 'authenticated'),
  ('owner',   '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"owner@example.test","app_metadata":{"role":"owner"}}', 'authenticated'),
  ('user',    '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"customer@example.test"}', 'authenticated'),
  ('anon',    '{"role":"anon"}', 'anon'),
  ('service', '{"role":"service_role"}', 'service_role');

-- ── تطبيق الهجرة المقترحة ─────────────────────────────────────────────────────────────────────
\i :migration

-- مرجع نبض ناجح صالح بإثبات كامل
create table pg_temp.fx (name text primary key, summary jsonb not null);
insert into pg_temp.fx values ('good', jsonb_build_object(
  'schema', 'price-sync-heartbeat/v1', 'kind', 'attempt', 'host', 'OZK2026',
  'attempt_started_at', (now() - interval '20 seconds')::text,
  'attempt_finished_at', now()::text,
  'outcome', 'applied', 'ameen_contact_at', now()::text,
  'sent_count', 321, 'applied_wholesale', 321, 'applied_retail', 317,
  'not_in_ameen', 0, 'conflict_count', 0,
  'verify', jsonb_build_object('wholesale_matched', 321, 'retail_matched', 317, 'mismatches', 0, 'missing', 0)));
grant select on pg_temp.fx to anon, authenticated, service_role;

-- تشغيل SQL بهوية معيّنة؛ يعيد 'OK' أو SQLSTATE الخطأ.
create or replace function pg_temp.try_as(p_who text, p_sql text) returns text
language plpgsql as $$
declare v_claims jsonb; v_role text;
begin
  select claims, db_role into v_claims, v_role from pg_temp.ids where name = p_who;
  perform set_config('request.jwt.claims', v_claims::text, true);
  execute format('set local role %I', v_role);
  begin
    execute p_sql;
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'OK';
end;
$$;

create or replace function pg_temp.expect(p_name text, p_actual text, p_expected text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'TEST FAIL: % — expected %, got %', p_name, p_expected, p_actual;
  end if;
  raise notice 'PASS %', p_name;
end;
$$;

create or replace function pg_temp.rpc(p_summary jsonb) returns text language sql as $$
  select format('select public.record_price_sync_heartbeat(%L::jsonb)', p_summary::text)
$$;

\set QUIET 0
do $tests$
declare
  good jsonb := (select summary from pg_temp.fx where name = 'good');
  direct_insert text := format(
    'insert into public.price_sync_heartbeats (kind, host, occurred_at, outcome, summary) values (''attempt'', ''x'', now(), ''applied'', %L::jsonb)',
    good::text);
  n bigint;
begin
  -- ١) لا كتابة مباشرة لأحد: موظف، مالك، هوية المزامنة نفسها، service_role، anon
  perform pg_temp.expect('direct insert: staff denied',        pg_temp.try_as('staff', direct_insert),   '42501');
  perform pg_temp.expect('direct insert: owner denied',        pg_temp.try_as('owner', direct_insert),   '42501');
  perform pg_temp.expect('direct insert: sync identity denied',pg_temp.try_as('sync', direct_insert),    '42501');
  perform pg_temp.expect('direct insert: service_role denied', pg_temp.try_as('service', direct_insert), '42501');
  perform pg_temp.expect('direct insert: anon denied',         pg_temp.try_as('anon', direct_insert),    '42501');

  -- ٢) تزوير HEALTHY عبر الدالة: كل مستخدم غير هوية المزامنة يُرفض
  perform pg_temp.expect('rpc: staff cannot forge HEALTHY',    pg_temp.try_as('staff', pg_temp.rpc(good)), '42501');
  perform pg_temp.expect('rpc: owner cannot forge HEALTHY',    pg_temp.try_as('owner', pg_temp.rpc(good)), '42501');
  perform pg_temp.expect('rpc: ordinary user cannot forge',    pg_temp.try_as('user',  pg_temp.rpc(good)), '42501');
  perform pg_temp.expect('rpc: anon has no execute',           pg_temp.try_as('anon',  pg_temp.rpc(good)), '42501');
  select count(*) into n from public.price_sync_heartbeats;
  perform pg_temp.expect('no row written by rejected callers', n::text, '0');

  -- ٣) هوية المزامنة: نجاح بإثبات مقبول، وwriter_id = الهوية، وreceived_at من ساعة الخادم
  perform pg_temp.expect('rpc: sync identity applied with proof', pg_temp.try_as('sync', pg_temp.rpc(good)), 'OK');
  perform pg_temp.expect('writer_id is the sync identity',
    (select writer_id::text from public.price_sync_heartbeats order by id desc limit 1), '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3');
  perform pg_temp.expect('received_at is server time',
    (select (abs(extract(epoch from (received_at - now()))) < 60)::text from public.price_sync_heartbeats order by id desc limit 1), 'true');
  perform pg_temp.expect('client cannot inject received_at',
    pg_temp.try_as('sync', pg_temp.rpc(good || '{"received_at":"2099-01-01T00:00:00Z"}')), 'OK');
  perform pg_temp.expect('injected received_at ignored',
    (select (received_at < now() + interval '1 minute')::text from public.price_sync_heartbeats order by id desc limit 1), 'true');

  -- ٤) النجاح يعني وصول الأسعار فعلياً: كل نجاح بلا إثبات يُرفض حتى من هوية المزامنة
  perform pg_temp.expect('success without ameen_contact_at rejected', pg_temp.try_as('sync', pg_temp.rpc(good - 'ameen_contact_at')), '22023');
  perform pg_temp.expect('success with mismatches rejected',  pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{verify,mismatches}', '1'))), '22023');
  perform pg_temp.expect('success with missing rejected',     pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{verify,missing}', '2'))), '22023');
  perform pg_temp.expect('success without verify rejected',   pg_temp.try_as('sync', pg_temp.rpc(good - 'verify')), '22023');
  perform pg_temp.expect('success with string mismatches rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{verify,mismatches}', '"0"'))), '22023');
  perform pg_temp.expect('success with zero applied rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{applied_wholesale}', '0'))), '22023');
  perform pg_temp.expect('no_changes with conflicts rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(jsonb_set(good, '{outcome}', '"no_changes"'), '{conflict_count}', '2'))), '22023');
  perform pg_temp.expect('success with not_in_ameen rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{not_in_ameen}', '1'))), '22023');
  perform pg_temp.expect('success with string conflicts rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{conflict_count}', '"x"'))), '22023');

  -- ٥) نتائج الفشل تُقبل بلا إثبات (هي نفسها دليل العطل)
  perform pg_temp.expect('failure outcome accepted without proof',
    pg_temp.try_as('sync', pg_temp.rpc(jsonb_build_object('schema','price-sync-heartbeat/v1','kind','attempt','host','OZK2026',
      'attempt_finished_at', now()::text, 'outcome','ameen_unreachable','stage_failed','connect'))), 'OK');

  -- ٦) مدخلات غير صالحة
  perform pg_temp.expect('future timestamp rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{attempt_finished_at}', to_jsonb((now() + interval '1 hour')::text)))), '22023');
  perform pg_temp.expect('invalid timestamp rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{attempt_finished_at}', '"yesterday-ish"'))), '22007');
  perform pg_temp.expect('wrong schema rejected',     pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{schema}', '"other/v9"'))), '22023');
  perform pg_temp.expect('unknown kind rejected',     pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{kind}', '"forged"'))), '22023');
  perform pg_temp.expect('unknown outcome rejected',  pg_temp.try_as('sync', pg_temp.rpc(jsonb_set(good, '{outcome}', '"healthy"'))), '22023');
  perform pg_temp.expect('missing host rejected',     pg_temp.try_as('sync', pg_temp.rpc(good - 'host')), '22023');
  perform pg_temp.expect('non-object rejected',       pg_temp.try_as('sync', 'select public.record_price_sync_heartbeat(''[1,2]''::jsonb)'), '22023');
  perform pg_temp.expect('oversized summary rejected',pg_temp.try_as('sync', pg_temp.rpc(good || jsonb_build_object('message', repeat('x', 20000)))), '22023');

  -- ٧) فحص المهمة
  perform pg_temp.expect('task probe accepted', pg_temp.try_as('sync', pg_temp.rpc(jsonb_build_object('schema','price-sync-heartbeat/v1','kind','task_probe','host','OZK2026',
      'probed_at', now()::text, 'task', jsonb_build_object('exists', true, 'enabled', false, 'state', 'Disabled')))), 'OK');
  perform pg_temp.expect('task probe without enabled rejected', pg_temp.try_as('sync', pg_temp.rpc(jsonb_build_object('schema','price-sync-heartbeat/v1','kind','task_probe','host','OZK2026',
      'probed_at', now()::text, 'task', jsonb_build_object('exists', true)))), '22023');
  perform pg_temp.expect('staff cannot forge task probe', pg_temp.try_as('staff', pg_temp.rpc(jsonb_build_object('schema','price-sync-heartbeat/v1','kind','task_probe','host','OZK2026',
      'probed_at', now()::text, 'task', jsonb_build_object('exists', true, 'enabled', true, 'state', 'Ready')))), '42501');

  -- ٨) service_role (احتياط سكربتات Windows): مسموح عبر الدالة، وwriter_id = null
  perform pg_temp.expect('service_role rpc accepted', pg_temp.try_as('service', pg_temp.rpc(good)), 'OK');
  perform pg_temp.expect('service_role writer_id is null',
    (select coalesce(writer_id::text, 'null') from public.price_sync_heartbeats order by id desc limit 1), 'null');

  -- ٩) لا تعديل ولا حذف لأحد
  perform pg_temp.expect('staff update denied',  pg_temp.try_as('staff', 'update public.price_sync_heartbeats set outcome = ''applied'''), '42501');
  perform pg_temp.expect('sync update denied',   pg_temp.try_as('sync',  'update public.price_sync_heartbeats set outcome = ''applied'''), '42501');
  perform pg_temp.expect('staff delete denied',  pg_temp.try_as('staff', 'delete from public.price_sync_heartbeats'), '42501');
  perform pg_temp.expect('service delete denied',pg_temp.try_as('service', 'delete from public.price_sync_heartbeats'), '42501');
end
$tests$;

-- ١٠) القراءة: الموظف يرى، والمستخدم العادي لا يرى شيئاً، وanon ممنوع
begin;
select set_config('request.jwt.claims', (select claims::text from pg_temp.ids where name = 'staff'), true);
set local role authenticated;
do $$ begin perform pg_temp.expect('staff can read heartbeats', ((select count(*) from public.price_sync_heartbeats) >= 4)::text, 'true'); end $$;
rollback;
begin;
select set_config('request.jwt.claims', (select claims::text from pg_temp.ids where name = 'user'), true);
set local role authenticated;
do $$ begin perform pg_temp.expect('non-staff user sees nothing', (select count(*) from public.price_sync_heartbeats)::text, '0'); end $$;
rollback;
do $$ begin perform pg_temp.expect('anon cannot read', pg_temp.try_as('anon', 'select count(*) from public.price_sync_heartbeats'), '42501'); end $$;

-- ١١) الاحتفاظ 30 يوماً
insert into public.price_sync_heartbeats (received_at, writer_id, kind, host, occurred_at, outcome, summary)
values (now() - interval '40 days', null, 'attempt', 'old', now() - interval '40 days', 'applied', '{}'::jsonb);
do $$ begin
  perform pg_temp.expect('retention trigger call', pg_temp.try_as('sync', pg_temp.rpc((select summary from pg_temp.fx where name = 'good'))), 'OK');
  perform pg_temp.expect('rows older than 30 days pruned', (select count(*) from public.price_sync_heartbeats where host = 'old')::text, '0');
end $$;

-- ١٢) الدالة SECURITY DEFINER بمسار بحث ثابت، وبلا منح لـ anon/public
do $$
declare v_conf text[]; v_def boolean;
begin
  select proconfig, prosecdef into v_conf, v_def from pg_proc where oid = 'public.record_price_sync_heartbeat(jsonb)'::regprocedure;
  perform pg_temp.expect('rpc is security definer', v_def::text, 'true');
  perform pg_temp.expect('rpc has fixed search_path', (v_conf @> array['search_path=public, pg_temp'])::text, 'true');
  perform pg_temp.expect('anon has no execute privilege', has_function_privilege('anon', 'public.record_price_sync_heartbeat(jsonb)', 'execute')::text, 'false');
  perform pg_temp.expect('rls forced', (select relforcerowsecurity::text from pg_class where oid = 'public.price_sync_heartbeats'::regclass), 'true');
  perform pg_temp.expect('no insert policy exists', (select count(*)::text from pg_policies where tablename = 'price_sync_heartbeats' and cmd <> 'SELECT'), '0');
end $$;

-- ١٣) التراجع يُسقط كائنات 16 فقط
\i :rollback
do $$ begin
  perform pg_temp.expect('rollback dropped table', (to_regclass('public.price_sync_heartbeats') is null)::text, 'true');
  perform pg_temp.expect('rollback dropped rpc', (to_regprocedure('public.record_price_sync_heartbeat(jsonb)') is null)::text, 'true');
  perform pg_temp.expect('rollback kept is_staff', (to_regprocedure('public.is_staff()') is not null)::text, 'true');
end $$;

select 'PRICE_SYNC_HEARTBEATS_SECURITY_OK';
