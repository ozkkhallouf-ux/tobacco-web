-- إثبات تشغيلي لدالة prune_ameen_warehouse_stock_reports على قاعدة فارغة محلية.
-- لا يُشغَّل على المشروع الحي: يرفض أي جدول فيه عمود items أو warehouse_key
-- (شكل الإنتاج)، ويُنشأ له قاعدة مستقلة تُحذف بعد الاختبار.
--
-- يشغّل المالك غير المزوّد بـsuperuser ومع BYPASSRLS، مع FORCE RLS وسياسة
-- تخفي كل جلسات الجرد. التقرير المشار إليه يجب أن يبقى، وجلسات الجرد لا
-- تُمس، والمفتاح الأجنبي يبقى NO ACTION لا CASCADE.

\set ON_ERROR_STOP on

do $$
begin
  if inet_server_addr() is not null
     and host(inet_server_addr()) not in ('127.0.0.1', '::1') then
    raise exception 'prune test refuses a non-loopback server';
  end if;
  if to_regclass('public.ameen_warehouse_stock_reports') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'ameen_warehouse_stock_reports'
         and column_name = 'items'
     ) then
    raise exception 'refusing: ameen_warehouse_stock_reports has the production shape';
  end if;
  if to_regclass('public.smart_inventory_sessions') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'smart_inventory_sessions'
         and column_name = 'warehouse_key'
     ) then
    raise exception 'refusing: smart_inventory_sessions has the production shape';
  end if;
end
$$;

drop table if exists public.prune_test_extra_ref;
drop table if exists public.inventory_recon_sessions;
drop table if exists public.smart_inventory_sessions;
drop table if exists public.ameen_warehouse_stock_reports;
drop function if exists public.prune_ameen_warehouse_stock_reports(timestamptz, integer);

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'prune_fn_owner') then
    create role prune_fn_owner nologin nobypassrls;
  end if;
end
$$;

alter role prune_fn_owner nobypassrls;
alter role prune_fn_owner bypassrls;

create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table public.ameen_warehouse_stock_reports (
  id uuid primary key,
  created_at timestamptz not null
);

-- نفس اسم المفتاح وفعله على الحي: NO ACTION، والعمود source_report_id.
create table public.smart_inventory_sessions (
  id uuid primary key,
  source_report_id uuid not null,
  constraint smart_inventory_sessions_source_report_id_fkey
    foreign key (source_report_id) references public.ameen_warehouse_stock_reports (id)
);

create table public.inventory_recon_sessions (
  id uuid primary key,
  source_report_id uuid,
  constraint inventory_recon_sessions_source_report_id_fkey
    foreign key (source_report_id) references public.ameen_warehouse_stock_reports (id) on delete set null
);

\ir ../migrations/20260928140000_prune_ameen_warehouse_stock_reports.sql

alter function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) owner to prune_fn_owner;
grant usage on schema auth to prune_fn_owner;
grant execute on function auth.uid() to prune_fn_owner;
-- FOR UPDATE يحتاج صلاحية UPDATE. على الحي المالك هو مالك الجدول.
-- دور الاختبار ليس المالك، فيُمنح القفل هنا فقط ولا يُمنح لـauthenticated في الهجرة.
grant select, update, delete on public.ameen_warehouse_stock_reports to prune_fn_owner;
grant select on public.smart_inventory_sessions to prune_fn_owner;
grant select on public.inventory_recon_sessions to prune_fn_owner;

alter table public.smart_inventory_sessions enable row level security;
alter table public.smart_inventory_sessions force row level security;
alter table public.inventory_recon_sessions enable row level security;
alter table public.inventory_recon_sessions force row level security;
create policy prune_test_hide_smart on public.smart_inventory_sessions for all using (false);
create policy prune_test_hide_recon on public.inventory_recon_sessions for all using (false);

begin;

insert into public.ameen_warehouse_stock_reports (id, created_at)
select
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  pg_catalog.now() - interval '30 days' - (n || ' hours')::interval
from pg_catalog.generate_series(1, 8) as n;

insert into public.smart_inventory_sessions (id, source_report_id)
select
  ('20000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from pg_catalog.generate_series(1, 8) as n;

insert into public.ameen_warehouse_stock_reports (id, created_at) values
  ('10000000-0000-4000-8000-000000000009', pg_catalog.now() - interval '20 days'),
  ('10000000-0000-4000-8000-000000000010', pg_catalog.now() - interval '25 days');

insert into public.inventory_recon_sessions (id, source_report_id) values
  ('30000000-0000-4000-8000-000000000009', '10000000-0000-4000-8000-000000000009'),
  ('30000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000010');

insert into public.smart_inventory_sessions (id, source_report_id) values
  ('20000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000010');

insert into public.ameen_warehouse_stock_reports (id, created_at)
select
  ('10000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid,
  pg_catalog.now() - interval '10 days' - (n || ' minutes')::interval
from pg_catalog.generate_series(1, 45) as n;

insert into public.ameen_warehouse_stock_reports (id, created_at) values
  ('10000000-0000-4000-8000-000000000050', pg_catalog.now() - interval '2 days' - interval '1 second'),
  ('10000000-0000-4000-8000-000000000051', pg_catalog.now() - interval '2 days'),
  ('10000000-0000-4000-8000-000000000052', pg_catalog.now() - interval '2 days' + interval '1 second'),
  ('10000000-0000-4000-8000-000000000053', pg_catalog.now() - interval '1 day'),
  ('10000000-0000-4000-8000-000000000054', pg_catalog.now() - interval '3 hours');

insert into public.smart_inventory_sessions (id, source_report_id) values
  ('20000000-0000-4000-8000-000000000054', '10000000-0000-4000-8000-000000000054');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000099', false);

do $$
declare
  reports_before integer;
  sessions_before integer;
begin
  select count(*) into reports_before from public.ameen_warehouse_stock_reports;
  select count(*) into sessions_before from public.smart_inventory_sessions;
  if reports_before <> 60 or sessions_before <> 10 then
    raise exception 'fixture row count drifted: reports=% sessions=%', reports_before, sessions_before;
  end if;
  begin
    perform public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
    raise exception 'non-sync caller must be rejected';
  exception
    when insufficient_privilege then
      if sqlerrm not like '%sync writer only%' then
        raise;
      end if;
  end;
  if (select count(*) from public.ameen_warehouse_stock_reports) <> reports_before
     or (select count(*) from public.smart_inventory_sessions) <> sessions_before then
    raise exception 'rejected caller must not delete anything';
  end if;
end
$$;

select set_config('request.jwt.claim.sub', '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3', false);

do $$
begin
  begin
    perform public.prune_ameen_warehouse_stock_reports(null, 40);
    raise exception 'null cutoff must be rejected';
  exception
    when invalid_parameter_value then
      if sqlerrm not like '%p_before%' then
        raise;
      end if;
  end;
  begin
    perform public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 41);
    raise exception 'limit 41 must be rejected';
  exception
    when invalid_parameter_value then
      if sqlerrm not like '%p_limit%' then
        raise;
      end if;
  end;
  begin
    perform public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 0);
    raise exception 'limit 0 must be rejected';
  exception
    when invalid_parameter_value then
      if sqlerrm not like '%p_limit%' then
        raise;
      end if;
  end;
end
$$;

do $$
declare
  first_batch integer;
  second_batch integer;
  third_batch integer;
  smart_confdel "char";
  recon_confdel "char";
begin
  if not has_function_privilege('authenticated', 'public.prune_ameen_warehouse_stock_reports(timestamptz, integer)', 'execute') then
    raise exception 'authenticated must be able to call the prune function';
  end if;
  if has_function_privilege('anon', 'public.prune_ameen_warehouse_stock_reports(timestamptz, integer)', 'execute')
     or has_function_privilege('public', 'public.prune_ameen_warehouse_stock_reports(timestamptz, integer)', 'execute') then
    raise exception 'anon and public must not execute the prune function';
  end if;

  select c.confdeltype into smart_confdel
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.smart_inventory_sessions'::pg_catalog.regclass
    and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass;
  select c.confdeltype into recon_confdel
  from pg_catalog.pg_constraint as c
  where c.conrelid = 'public.inventory_recon_sessions'::pg_catalog.regclass
    and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass;
  if smart_confdel is distinct from 'a' or recon_confdel is distinct from 'n' then
    raise exception 'foreign key actions drifted: smart=% recon=%', smart_confdel, recon_confdel;
  end if;

  -- p_before = now() أوسع من قاعدة اليومين. الدالة تقصّه، فالتقرير الحديث يبقى.
  first_batch := public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
  if first_batch <> 40 then
    raise exception 'first batch deleted %, expected 40', first_batch;
  end if;
  second_batch := public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
  if second_batch <> 6 then
    raise exception 'second batch deleted %, expected the remaining 6 unreferenced old rows', second_batch;
  end if;
  third_batch := public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
  if third_batch <> 0 then
    raise exception 'third batch deleted %, expected 0', third_batch;
  end if;

  if (select count(*) from public.smart_inventory_sessions) <> 10 then
    raise exception 'smart inventory sessions were modified';
  end if;
  if (select count(*) from public.inventory_recon_sessions) <> 2 then
    raise exception 'inventory recon sessions were modified';
  end if;
  if exists (
    select 1
    from public.smart_inventory_sessions as s
    where not exists (
      select 1 from public.ameen_warehouse_stock_reports as r
      where r.id = s.source_report_id
    )
  ) then
    raise exception 'a smart inventory source report was deleted';
  end if;
  if exists (
    select 1
    from public.inventory_recon_sessions as i
    where i.source_report_id is null
       or not exists (
         select 1 from public.ameen_warehouse_stock_reports as r
         where r.id = i.source_report_id
       )
  ) then
    raise exception 'a recon source report was deleted or nulled';
  end if;
  if not exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-000000000051'
  ) or not exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-000000000052'
  ) or not exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-000000000053'
  ) or not exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-000000000054'
  ) then
    raise exception 'cutoff, newer, or today''s inventory report was deleted';
  end if;
  if exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-000000000050'
  ) then
    raise exception 'the unreferenced row one second past the cutoff survived';
  end if;
  if (select count(*) from public.ameen_warehouse_stock_reports) <> 14 then
    raise exception 'expected 14 surviving reports, found %',
      (select count(*) from public.ameen_warehouse_stock_reports);
  end if;
end
$$;

do $$
declare
  before_count integer;
begin
  select count(*) into before_count from public.ameen_warehouse_stock_reports;
  create table public.prune_test_extra_ref (
    id integer primary key,
    report_id uuid references public.ameen_warehouse_stock_reports (id) on delete cascade
  );
  begin
    perform public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
    raise exception 'an unexpected foreign key must stop deletion';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm not like '%unexpected foreign key%' then
        raise;
      end if;
  end;
  drop table public.prune_test_extra_ref;
  if (select count(*) from public.ameen_warehouse_stock_reports) <> before_count then
    raise exception 'unexpected foreign key still deleted reports';
  end if;
end
$$;

do $$
begin
  begin
    delete from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-000000000001';
    raise exception 'direct delete of a referenced report must fail the foreign key';
  exception
    when foreign_key_violation then
      null;
  end;
  if not exists (
    select 1 from public.smart_inventory_sessions
    where id = '20000000-0000-4000-8000-000000000001'
      and source_report_id = '10000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'the smart inventory session changed after the rejected direct delete';
  end if;
end
$$;

do $$
declare
  before_count integer;
  smart_before integer;
  recon_before integer;
begin
  select count(*) into before_count from public.ameen_warehouse_stock_reports;
  select count(*) into smart_before from public.smart_inventory_sessions;
  select count(*) into recon_before from public.inventory_recon_sessions;
  alter table public.smart_inventory_sessions
    drop constraint smart_inventory_sessions_source_report_id_fkey;
  alter table public.smart_inventory_sessions
    add constraint smart_inventory_sessions_source_report_id_fkey
    foreign key (source_report_id)
    references public.ameen_warehouse_stock_reports (id)
    on delete cascade;
  begin
    perform public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
    raise exception 'cascade fk must be refused';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm not like '%unexpected foreign key%' then
        raise;
      end if;
  end;
  if (select count(*) from public.ameen_warehouse_stock_reports) <> before_count then
    raise exception 'cascade guard deleted reports';
  end if;
  if (select count(*) from public.smart_inventory_sessions) <> smart_before
     or (select count(*) from public.inventory_recon_sessions) <> recon_before then
    raise exception 'cascade guard wrote inventory rows';
  end if;
  alter table public.smart_inventory_sessions
    drop constraint smart_inventory_sessions_source_report_id_fkey;
  alter table public.smart_inventory_sessions
    add constraint smart_inventory_sessions_source_report_id_fkey
    foreign key (source_report_id)
    references public.ameen_warehouse_stock_reports (id);
end
$$;

commit;

-- سباق جلستين: جلسة بعيدة تمسك KEY SHARE على تقرير قديم (كما يفعل إدراج
-- مفتاح أجنبي) ثم تنتظر. التنظيف يجب أن يتجاوز ذلك الصف عبر SKIP LOCKED
-- ويحذف تقريراً قديماً غيره، بلا كتابة على جدولي الجلسات.
create extension if not exists dblink;

insert into public.ameen_warehouse_stock_reports (id, created_at) values
  ('10000000-0000-4000-8000-0000000000a1', pg_catalog.now() - interval '16 days'),
  ('10000000-0000-4000-8000-0000000000a2', pg_catalog.now() - interval '15 days');

select pg_catalog.pg_advisory_lock(824283);

select dblink_connect(
  'holder',
  'host=/var/run/postgresql dbname=' || current_database() || ' user=postgres'
);

select dblink_send_query('holder', $holder$
do $body$
begin
  perform id
  from public.ameen_warehouse_stock_reports
  where id = '10000000-0000-4000-8000-0000000000a1'
  for key share;
  perform pg_catalog.pg_advisory_lock(824282);
  perform pg_catalog.pg_advisory_lock(824283);
end
$body$;
$holder$);

do $$
declare
  i integer := 0;
  held boolean;
begin
  loop
    select exists (
      select 1
      from pg_catalog.pg_locks
      where locktype = 'advisory'
        and classid = 0
        and objid = 824282
        and granted
    ) into held;
    exit when held;
    i := i + 1;
    if i > 50 then
      raise exception 'race holder did not take the key-share signal lock';
    end if;
    perform pg_catalog.pg_sleep(0.1);
  end loop;
end
$$;

select set_config('request.jwt.claim.sub', '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3', false);
set statement_timeout = '5s';

do $$
declare
  removed integer;
  smart_before integer;
  recon_before integer;
begin
  select count(*) into smart_before from public.smart_inventory_sessions;
  select count(*) into recon_before from public.inventory_recon_sessions;
  removed := public.prune_ameen_warehouse_stock_reports(pg_catalog.now(), 40);
  if removed < 1 then
    raise exception 'locked-path prune deleted nothing';
  end if;
  if not exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-0000000000a1'
  ) then
    raise exception 'the KEY SHARE row was deleted or waited past skip locked';
  end if;
  if exists (
    select 1 from public.ameen_warehouse_stock_reports
    where id = '10000000-0000-4000-8000-0000000000a2'
  ) then
    raise exception 'the unlocked old row survived the locking prune';
  end if;
  if (select count(*) from public.smart_inventory_sessions) <> smart_before
     or (select count(*) from public.inventory_recon_sessions) <> recon_before then
    raise exception 'locking prune wrote inventory rows';
  end if;
end
$$;

set statement_timeout = 0;
select pg_catalog.pg_advisory_unlock(824283);
select * from dblink_get_result('holder') as holder_done(ignored text);
select dblink_disconnect('holder');

select 'PRUNE_TEST_OK' as result;
