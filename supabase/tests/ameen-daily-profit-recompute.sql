-- اختبار supabase/proposed/31-ameen-daily-profit-recompute.sql على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-daily-profit-recompute.mjs (قاعدة مستقلة تُحذف بعده).
-- بيئة مصطنعة: أدوار Supabase وauth.uid() من request.jwt.claims، وجدول
-- inventory_reports بأعمدة الإنتاج، ودالتا المزامنة بجسم الإنتاج
-- (supabase/ameen-daily-profit-atomic-upsert.sql). لا بيانات إنتاج ولا اتصال خارجي.
\set ON_ERROR_STOP 1
\set QUIET 1

do $guard$
begin
  if current_database() is distinct from 'ozk_daily_profit_recompute_test' then
    raise exception 'daily profit recompute test runs only in ozk_daily_profit_recompute_test';
  end if;
  if to_regclass('public.inventory_reports') is not null then
    raise exception 'refusing: database already has inventory_reports';
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

-- جدول inventory_reports بأعمدة الإنتاج وافتراضاتها.
create table public.inventory_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null default current_date,
  source text not null default 'ameen_excel',
  summary jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
alter table public.inventory_reports enable row level security;
grant select on public.inventory_reports to authenticated;

\i :base

\i :migration

create function pg_temp.act(p_who text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', case p_who
    when 'sync' then '{"sub":"9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3","role":"authenticated"}'
    when 'staff' then '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}'
    else '{"role":"anon"}' end, false);
end $$;

create function pg_temp.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond is distinct from true then raise exception 'TEST FAIL: %', p_name; end if;
  raise notice 'PASS %', p_name;
end $$;

create function pg_temp.raises(p_sql text, p_name text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'PASS %', p_name;
    return;
  end;
  raise exception 'TEST FAIL: % (no error)', p_name;
end $$;

-- ملخص اصطناعي بمفاتيح push-daily-profit.ps1 نفسها.
create function pg_temp.summary(p_date date, p_mode text, p_net_sales numeric, p_cost numeric, p_missing int, p_synced text)
returns jsonb language sql as $$
  select jsonb_build_object(
    'report_date', p_date::text, 'currency', 'USD',
    'sales_gross', p_net_sales, 'sales_cost', p_cost, 'product_margin_before_adjustments', p_net_sales - p_cost,
    'discounts', 0, 'sales_extras', 0, 'returns', 0, 'returns_cost', 0,
    'net_sales', p_net_sales, 'net_cost', p_cost, 'gross_profit', p_net_sales - p_cost,
    'expenses', 0, 'net_profit', p_net_sales - p_cost,
    'sales_bill_count', 1, 'return_bill_count', 0, 'expense_entry_count', 0,
    'line_count', 1, 'missing_cost_lines', p_missing, 'complete', p_missing = 0,
    'sync_mode', p_mode, 'synced_at', p_synced)
$$;

-- البيانات: يوم ماضٍ مجمّد (لقطة اليوم القديمة) ويوم بلا صف.
select set_config('t.d_old', ((now() at time zone 'Asia/Damascus')::date - 10)::text, false);
select set_config('t.d_missing', ((now() at time zone 'Asia/Damascus')::date - 9)::text, false);
select set_config('t.d_today', ((now() at time zone 'Asia/Damascus')::date)::text, false);

select pg_temp.act('sync');
set role authenticated;
select public.upsert_ameen_daily_profit(current_setting('t.d_old')::date,
  pg_temp.summary(current_setting('t.d_old')::date, 'today', 1000, 400, 3, '2026-01-01T00:00:00Z') - 'sync_mode', '[]'::jsonb) is not null as seeded;
reset role;
update public.inventory_reports set created_at = '2026-01-01T00:00:00Z' where report_date = current_setting('t.d_old')::date;

-- ١) الهوية والصلاحيات
select pg_temp.act('anon');
set role anon;
select pg_temp.raises($$select public.recompute_ameen_daily_profit(current_setting('t.d_old')::date, '{}'::jsonb)$$, 'anon cannot execute');
reset role;
select pg_temp.act('staff');
set role authenticated;
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_old'),
  pg_temp.summary(current_setting('t.d_old')::date, 'recompute', 1, 1, 0, 'x')), 'staff identity rejected');
select pg_temp.raises('select count(*) from private.ameen_daily_profit_revisions', 'authenticated cannot read revisions');
select pg_temp.raises($$select private.ameen_daily_profit_revert_revisions('-infinity')$$, 'authenticated cannot revert');
reset role;

-- ٢) نافذة التاريخ وصحة الملخص
select pg_temp.act('sync');
set role authenticated;
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_today'),
  pg_temp.summary(current_setting('t.d_today')::date, 'recompute', 1, 1, 0, 'x')), 'today rejected (owned by today sync)');
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_today')::date + 1,
  pg_temp.summary(current_setting('t.d_today')::date + 1, 'recompute', 1, 1, 0, 'x')), 'future rejected');
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_today')::date - 401,
  pg_temp.summary(current_setting('t.d_today')::date - 401, 'recompute', 1, 1, 0, 'x')), 'older than 400 days rejected');
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_old'),
  pg_temp.summary(current_setting('t.d_missing')::date, 'recompute', 1, 1, 0, 'x')), 'summary for another date rejected');
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_old'),
  pg_temp.summary(current_setting('t.d_old')::date, 'today', 1, 1, 0, 'x')), 'sync_mode must be recompute');
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_old'),
  pg_temp.summary(current_setting('t.d_old')::date, 'recompute', 1, 1, 0, 'x') - 'net_profit'), 'missing financial key rejected');
select pg_temp.raises(format($$select public.recompute_ameen_daily_profit(%L, %L::jsonb)$$, current_setting('t.d_old'),
  jsonb_set(pg_temp.summary(current_setting('t.d_old')::date, 'recompute', 1, 1, 2, 'x'), '{complete}', 'true')),
  'missing cost can never be marked complete');
reset role;
select pg_temp.ok((select count(*) from private.ameen_daily_profit_revisions) = 0, 'rejected calls wrote nothing');

-- ٣) نفس المحتوى المالي بختم وقت مختلف: لا كتابة
select set_config('t.before', clock_timestamp()::text, false);
set role authenticated;
select pg_temp.ok(public.recompute_ameen_daily_profit(current_setting('t.d_old')::date,
  pg_temp.summary(current_setting('t.d_old')::date, 'recompute', 1000.0000, 400, 3, '2026-11-25T00:00:00Z')) = 'unchanged', 'same numbers -> unchanged');
reset role;
select pg_temp.ok((select summary->>'synced_at' from public.inventory_reports where report_date = current_setting('t.d_old')::date) = '2026-01-01T00:00:00Z', 'unchanged day not rewritten');
select pg_temp.ok((select count(*) from private.ameen_daily_profit_revisions) = 0, 'unchanged day leaves no revision');

-- ٤) تغيّرت التكلفة بأثر رجعي: تحديث مع حفظ created_at والقديم في السجل
set role authenticated;
select pg_temp.ok(public.recompute_ameen_daily_profit(current_setting('t.d_old')::date,
  pg_temp.summary(current_setting('t.d_old')::date, 'recompute', 1000, 620.25, 1, '2026-11-25T00:00:00Z')) = 'updated', 'recosted day -> updated');
reset role;
select pg_temp.ok((select (summary->>'gross_profit')::numeric from public.inventory_reports where report_date = current_setting('t.d_old')::date) = 379.75, 'updated gross profit stored');
select pg_temp.ok((select (summary->>'complete')::boolean from public.inventory_reports where report_date = current_setting('t.d_old')::date) = false, 'missing cost stays flagged incomplete');
select pg_temp.ok((select created_at from public.inventory_reports where report_date = current_setting('t.d_old')::date) = '2026-01-01T00:00:00Z', 'created_at kept (freshness monitor and latest-report readers unaffected)');
select pg_temp.ok((select (old_summary->>'gross_profit')::numeric from private.ameen_daily_profit_revisions where action = 'updated') = 600, 'revision keeps old summary');

-- ٥) يوم غائب: إدراج
set role authenticated;
select pg_temp.ok(public.recompute_ameen_daily_profit(current_setting('t.d_missing')::date,
  pg_temp.summary(current_setting('t.d_missing')::date, 'recompute', 50, 20, 0, '2026-11-25T00:00:00Z')) = 'inserted', 'missing day -> inserted');
select pg_temp.ok(public.recompute_ameen_daily_profit(current_setting('t.d_missing')::date,
  pg_temp.summary(current_setting('t.d_missing')::date, 'recompute', 50, 20, 0, '2026-11-26T00:00:00Z')) = 'unchanged', 'second run is idempotent');
reset role;
select pg_temp.ok((select count(*) from public.inventory_reports where source = 'ameen_daily_profit') = 2, 'one row per date, no duplicates');
select pg_temp.ok((select count(*) from private.ameen_daily_profit_revisions) = 2, 'two revisions recorded');

-- ٦) مزامنة اليوم لم تتأثر
select pg_temp.act('sync');
set role authenticated;
select public.upsert_ameen_daily_profit(current_setting('t.d_today')::date,
  pg_temp.summary(current_setting('t.d_today')::date, 'today', 70, 30, 0, 'now'), '[]'::jsonb) is not null as today_synced;
reset role;
select pg_temp.ok((select report_date from public.inventory_reports where source = 'ameen_daily_profit' order by created_at desc limit 1)
  = current_setting('t.d_today')::date, 'latest by created_at is still today');

-- ٧) تراجع البيانات بالدالة
select pg_temp.ok(private.ameen_daily_profit_revert_revisions(current_setting('t.before')::timestamptz) = 2, 'revert returns two revisions');
select pg_temp.ok((select (summary->>'gross_profit')::numeric from public.inventory_reports where report_date = current_setting('t.d_old')::date) = 600, 'revert restores old summary');
select pg_temp.ok((select count(*) from public.inventory_reports where report_date = current_setting('t.d_missing')::date) = 0, 'revert removes inserted day');
select pg_temp.ok((select count(*) from public.inventory_reports where report_date = current_setting('t.d_today')::date) = 1, 'revert leaves today untouched');

-- ٨) ملف التراجع الكامل
select pg_temp.act('sync');
set role authenticated;
select public.recompute_ameen_daily_profit(current_setting('t.d_old')::date,
  pg_temp.summary(current_setting('t.d_old')::date, 'recompute', 999, 400, 0, 'y'));
reset role;

\i :rollback

select pg_temp.ok(to_regprocedure('public.recompute_ameen_daily_profit(date, jsonb)') is null, 'rollback drops recompute function');
select pg_temp.ok(to_regclass('private.ameen_daily_profit_revisions') is null, 'rollback drops revisions table');
select pg_temp.ok((select (summary->>'gross_profit')::numeric from public.inventory_reports where report_date = current_setting('t.d_old')::date) = 600, 'rollback restores data first');
select pg_temp.ok(to_regprocedure('public.upsert_ameen_daily_profit(date, jsonb, jsonb)') is not null, 'rollback keeps today upsert');

\echo DAILY_PROFIT_RECOMPUTE_OK
