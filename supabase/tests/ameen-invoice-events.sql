-- اختبار supabase/proposed/18-ameen-invoice-events.sql على PostgreSQL محلي مؤقت.
-- يشغّله scripts/check-ameen-invoice-events.mjs (قاعدة مستقلة تُحذف بعده).
-- بيئة مصطنعة: أدوار Supabase وauth.uid() من request.jwt.claims وis_staff() بجسم الإنتاج.
-- لا اتصال بأي خدمة خارجية ولا بيانات إنتاج ولا بيانات زبائن حقيقية.
\set ON_ERROR_STOP 1
\set QUIET 1

do $guard$
begin
  if current_database() is distinct from 'ozk_ameen_invoice_events_test' then
    raise exception 'ameen invoice events test runs only in ozk_ameen_invoice_events_test';
  end if;
  if to_regclass('public.inventory_reports') is not null or to_regclass('public.approved_price_items') is not null then
    raise exception 'refusing: database has production tables';
  end if;
end
$guard$;

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
create or replace function public.is_staff() returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp' as $$
  select exists (
    select 1 from public.staff_allowlist s
    where lower(s.email) = lower(coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''))
  );
$$;
grant execute on function public.is_staff() to anon, authenticated, service_role;

create table pg_temp.ids (name text primary key, claims jsonb not null, db_role text not null);
insert into pg_temp.ids values
  ('sync',    '{"sub":"9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3","role":"authenticated","email":"sync@example.test"}', 'authenticated'),
  ('staff',   '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"staff@example.test"}', 'authenticated'),
  ('owner',   '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"owner@example.test"}', 'authenticated'),
  ('user',    '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","email":"customer@example.test"}', 'authenticated'),
  ('anon',    '{"role":"anon"}', 'anon'),
  ('service', '{"role":"service_role"}', 'service_role');

\i :migration

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

-- يستدعي الدالة بهوية المزامنة ويعيد نتيجتها (jsonb)
create or replace function pg_temp.apply_as(p_who text, p_events jsonb) returns jsonb
language plpgsql as $$
declare v_claims jsonb; v_role text; v_out jsonb;
begin
  select claims, db_role into v_claims, v_role from pg_temp.ids where name = p_who;
  perform set_config('request.jwt.claims', v_claims::text, true);
  execute format('set local role %I', v_role);
  v_out := public.apply_ameen_invoice_events(p_events);
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return v_out;
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

-- حدث كما يبنيه الوكيل حرفياً (event_id = sha256(guid|seq|kind|hash|at))
create or replace function pg_temp.hx(p text) returns text language sql as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;
create or replace function pg_temp.ev(p_guid text, p_kind text, p_ver text, p_at text, p_seq bigint, p_bill jsonb default null) returns jsonb
language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schema', 'ameen-invoice-event/v1',
    'event_id', pg_temp.hx(p_guid || '|' || p_seq::text || '|' || p_kind || '|' || p_ver || '|' || p_at),
    'kind', p_kind, 'bill_guid', p_guid, 'version_hash', p_ver,
    'source_event_at', p_at, 'source_seq', p_seq, 'detected_at', p_at,
    'bill', p_bill))
$$;
create or replace function pg_temp.bill(p_guid text, p_type int, p_total numeric, p_named boolean default true, p_posted boolean default true, p_date text default '2026-10-20') returns jsonb
language sql as $$
  select jsonb_build_object('bill_guid', p_guid, 'bill_type', p_type, 'number', 1001, 'bill_date', p_date,
    'is_named', p_named, 'is_posted', p_posted, 'customer_guid', case when p_named then 'aaaaaaaa-0000-0000-0000-000000000001' end,
    'total', p_total, 'lines', jsonb_build_array(jsonb_build_object('line_guid', 'bbbbbbbb-0000-0000-0000-000000000001', 'qty', 10, 'price', p_total / 10)))
$$;

\set QUIET 0
do $tests$
declare
  g1 text := 'c0000000-0000-0000-0000-000000000001';
  g2 text := 'c0000000-0000-0000-0000-000000000002';
  g3 text := 'c0000000-0000-0000-0000-000000000003';
  g4 text := 'c0000000-0000-0000-0000-000000000004';
  vA text := pg_temp.hx('version-A');
  vB text := pg_temp.hx('version-B');
  vC text := pg_temp.hx('version-C');
  t0 text := '2026-10-20T15:00:00.000Z';
  t1 text := '2026-10-20T15:01:00.000Z';
  t2 text := '2026-10-20T15:02:00.000Z';
  t3 text := '2026-10-20T15:03:00.000Z';
  t4 text := '2026-10-20T15:04:00.000Z';
  t5 text := '2026-10-20T15:05:00.000Z';
  create_evt jsonb := pg_temp.ev(g1, 'upsert', vA, t1, 1, pg_temp.bill(g1, 1, 100));
  direct_insert text := format('insert into public.ameen_invoices (bill_guid, bill_type, status, version_hash, source_event_at, source_seq, payload) values (%L, 1, ''active'', %L, now(), 1, ''{}''::jsonb)', g1, vA);
  direct_event text := format('insert into public.ameen_invoice_events (event_id, bill_guid, kind, version_hash, source_event_at, source_seq, outcome, writer_id) values (%L, %L, ''upsert'', %L, now(), 1, ''applied'', %L)', vA, g1, vA, g1);
  rpc text := format('select public.apply_ameen_invoice_events(%L::jsonb)', jsonb_build_array(create_evt)::text);
  r jsonb;
  n bigint;
begin
  -- ١) لا كتابة مباشرة لأحد على الجدولين
  perform pg_temp.expect('direct insert invoices: staff denied',   pg_temp.try_as('staff', direct_insert),   '42501');
  perform pg_temp.expect('direct insert invoices: owner denied',   pg_temp.try_as('owner', direct_insert),   '42501');
  perform pg_temp.expect('direct insert invoices: sync denied',    pg_temp.try_as('sync', direct_insert),    '42501');
  perform pg_temp.expect('direct insert invoices: service denied', pg_temp.try_as('service', direct_insert), '42501');
  perform pg_temp.expect('direct insert invoices: anon denied',    pg_temp.try_as('anon', direct_insert),    '42501');
  perform pg_temp.expect('direct insert events: sync denied',      pg_temp.try_as('sync', direct_event),     '42501');
  perform pg_temp.expect('direct insert events: staff denied',     pg_temp.try_as('staff', direct_event),    '42501');

  -- ٢) الدالة لهوية المزامنة وحدها
  perform pg_temp.expect('rpc: staff denied',   pg_temp.try_as('staff', rpc),   '42501');
  perform pg_temp.expect('rpc: owner denied',   pg_temp.try_as('owner', rpc),   '42501');
  perform pg_temp.expect('rpc: user denied',    pg_temp.try_as('user', rpc),    '42501');
  perform pg_temp.expect('rpc: anon denied',    pg_temp.try_as('anon', rpc),    '42501');
  perform pg_temp.expect('rpc: service denied', pg_temp.try_as('service', rpc), '42501');
  select count(*) into n from public.ameen_invoices;
  perform pg_temp.expect('rejected callers wrote nothing', n::text, '0');

  -- ٣) إنشاء فاتورة
  r := pg_temp.apply_as('sync', jsonb_build_array(create_evt));
  perform pg_temp.expect('create: applied', r ->> 'applied', '1');
  perform pg_temp.expect('create: outcome', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('create: one row', (select count(*) from public.ameen_invoices where bill_guid = g1::uuid)::text, '1');
  perform pg_temp.expect('create: revision 1', (select revision from public.ameen_invoices where bill_guid = g1::uuid)::text, '1');
  perform pg_temp.expect('create: status active', (select status from public.ameen_invoices where bill_guid = g1::uuid), 'active');
  perform pg_temp.expect('create: payload total', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g1::uuid), '100');
  perform pg_temp.expect('create: event logged with writer', (select writer_id::text from public.ameen_invoice_events where bill_guid = g1::uuid), '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3');

  -- ٤) إعادة الإرسال نفسه (انقطاع/إعادة محاولة) ⇒ duplicate بلا أي تغيير
  r := pg_temp.apply_as('sync', jsonb_build_array(create_evt));
  perform pg_temp.expect('resend: duplicate', r ->> 'duplicate', '1');
  perform pg_temp.expect('resend: outcome', r -> 'results' -> 0 ->> 'outcome', 'duplicate');
  perform pg_temp.expect('resend: still revision 1', (select revision from public.ameen_invoices where bill_guid = g1::uuid)::text, '1');
  perform pg_temp.expect('resend: one event row', (select count(*) from public.ameen_invoice_events where bill_guid = g1::uuid)::text, '1');

  -- ٥) تعديل الفاتورة في الأمين ⇒ نفس الصف يتحدّث (بلا صف ثانٍ)
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'upsert', vB, t2, 2, pg_temp.bill(g1, 1, 150))));
  perform pg_temp.expect('edit: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('edit: still exactly one row for the bill', (select count(*) from public.ameen_invoices where bill_guid = g1::uuid)::text, '1');
  perform pg_temp.expect('edit: total rows in table', (select count(*) from public.ameen_invoices)::text, '1');
  perform pg_temp.expect('edit: revision 2', (select revision from public.ameen_invoices where bill_guid = g1::uuid)::text, '2');
  perform pg_temp.expect('edit: payload updated', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g1::uuid), '150');
  perform pg_temp.expect('edit: version updated', (select version_hash from public.ameen_invoices where bill_guid = g1::uuid), vB);

  -- ٦) حدث أقدم (تسلسل أصغر) متأخر الوصول ⇒ stale ولا يرجّع المحتوى
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'upsert', vC, t0, 1, pg_temp.bill(g1, 1, 999))));
  perform pg_temp.expect('late older event: stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('late older event: payload kept', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g1::uuid), '150');
  perform pg_temp.expect('late older event: revision kept', (select revision from public.ameen_invoices where bill_guid = g1::uuid)::text, '2');

  -- ٧) نفس المحتوى بوقت أحدث (حفظ بلا تغيير) ⇒ noop بلا مراجعة جديدة
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'upsert', vB, t3, 4, pg_temp.bill(g1, 1, 150))));
  perform pg_temp.expect('same content newer: noop', r -> 'results' -> 0 ->> 'outcome', 'noop');
  perform pg_temp.expect('same content newer: revision kept', (select revision from public.ameen_invoices where bill_guid = g1::uuid)::text, '2');

  -- ٨) الرجوع لمحتوى قديم (A ← B ← A) بوقت أحدث ⇒ يُطبَّق (لا يُعامل كمكرر)
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'upsert', vA, t4, 5, pg_temp.bill(g1, 1, 100))));
  perform pg_temp.expect('revert to earlier content: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('revert: revision 3', (select revision from public.ameen_invoices where bill_guid = g1::uuid)::text, '3');
  perform pg_temp.expect('revert: payload', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g1::uuid), '100');

  -- ٩) حذف ⇒ شاهد قبر بنفس الصف؛ حدث أقدم لا يحييه؛ حذف ثانٍ noop
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'delete', 'deleted', t5, 6)));
  perform pg_temp.expect('delete: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('delete: status', (select status from public.ameen_invoices where bill_guid = g1::uuid), 'deleted');
  perform pg_temp.expect('delete: still one row', (select count(*) from public.ameen_invoices where bill_guid = g1::uuid)::text, '1');
  perform pg_temp.expect('delete: deleted_at set', ((select deleted_at from public.ameen_invoices where bill_guid = g1::uuid) is not null)::text, 'true');
  perform pg_temp.expect('delete: last payload kept for audit', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g1::uuid), '100');
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'upsert', vC, t4, 5, pg_temp.bill(g1, 1, 5))));
  perform pg_temp.expect('older upsert after delete: stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('older upsert after delete: still deleted', (select status from public.ameen_invoices where bill_guid = g1::uuid), 'deleted');
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'delete', 'deleted', '2026-10-20T15:06:00.000Z', 8)));
  perform pg_temp.expect('second delete: noop', r -> 'results' -> 0 ->> 'outcome', 'noop');

  -- ١٠) فاتورة أُعيدت بعد الحذف بحدث أحدث ⇒ تعود active
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g1, 'upsert', vC, '2026-10-20T15:07:00.000Z', 9, pg_temp.bill(g1, 1, 70))));
  perform pg_temp.expect('restore: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('restore: active', (select status from public.ameen_invoices where bill_guid = g1::uuid), 'active');
  perform pg_temp.expect('restore: deleted_at cleared', ((select deleted_at from public.ameen_invoices where bill_guid = g1::uuid) is null)::text, 'true');

  -- ١١) حذف فاتورة لم نرها ⇒ شاهد قبر يمنع إحياءها بحدث أقدم
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g2, 'delete', 'deleted', t3, 10)));
  perform pg_temp.expect('delete unknown: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g2, 'upsert', vA, t2, 9, pg_temp.bill(g2, 1, 10))));
  perform pg_temp.expect('older create after unknown delete: stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('unknown delete stays deleted', (select status from public.ameen_invoices where bill_guid = g2::uuid), 'deleted');

  -- ١٢) دفعة غير مرتبة تُعالج بترتيب source_seq؛ المكرر داخل الدفعة نفسها duplicate
  r := pg_temp.apply_as('sync', jsonb_build_array(
         pg_temp.ev(g3, 'upsert', vB, t2, 21, pg_temp.bill(g3, 1, 20)),
         pg_temp.ev(g3, 'upsert', vA, t1, 20, pg_temp.bill(g3, 1, 10)),
         pg_temp.ev(g3, 'upsert', vB, t2, 21, pg_temp.bill(g3, 1, 20))));
  perform pg_temp.expect('unordered batch: applied 2', r ->> 'applied', '2');
  perform pg_temp.expect('unordered batch: duplicate 1', r ->> 'duplicate', '1');
  perform pg_temp.expect('unordered batch: final content is newest', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g3::uuid), '20');
  perform pg_temp.expect('unordered batch: revision 2', (select revision from public.ameen_invoices where bill_guid = g3::uuid)::text, '2');

  -- ١٣) مرتجع مبيعات (BillType 3) ومبيعات مركز بلا اسم وإلغاء ترحيل
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g4, 'upsert', vA, t1, 30, pg_temp.bill(g4, 3, 40, false))));
  perform pg_temp.expect('return bill: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('return bill: bill_type 3', (select bill_type::text from public.ameen_invoices where bill_guid = g4::uuid), '3');
  perform pg_temp.expect('unnamed bill: is_named false, no customer', (select is_named::text || '/' || coalesce(customer_guid::text, 'null') from public.ameen_invoices where bill_guid = g4::uuid), 'false/null');
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g4, 'upsert', vB, t2, 31, pg_temp.bill(g4, 3, 40, false, false))));
  perform pg_temp.expect('unpost: applied as update', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('unpost: is_posted false', (select is_posted::text from public.ameen_invoices where bill_guid = g4::uuid), 'false');

  -- ١٤) أخطاء على مستوى الطلب كله فقط ترفض الطلب: ليس مصفوفة، أو أكثر من 200 حدث
  perform pg_temp.expect('non-array request rejected', pg_temp.try_as('sync', 'select public.apply_ameen_invoice_events(''{}''::jsonb)'), '22023');
  perform pg_temp.expect('201 events request rejected', pg_temp.try_as('sync', format('select public.apply_ameen_invoice_events(%L::jsonb)',
    (select jsonb_agg(pg_temp.ev(g3, 'upsert', vC, t3, 100 + i, pg_temp.bill(g3, 1, 1))) from generate_series(1, 201) i)::text)), '22023');
  perform pg_temp.expect('rejected request changed nothing', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g3::uuid), '20');

  -- ١٥) القراءة: الموظفون فقط
  perform pg_temp.expect('staff can read', pg_temp.try_as('staff', 'select 1 from public.ameen_invoices limit 1'), 'OK');
  perform set_config('request.jwt.claims', (select claims::text from pg_temp.ids where name = 'user'), true);
  set local role authenticated;
  select count(*) into n from public.ameen_invoices;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect('non-staff user sees no invoices', n::text, '0');
  perform pg_temp.expect('anon cannot read', pg_temp.try_as('anon', 'select 1 from public.ameen_invoices'), '42501');
end
$tests$;

-- ١٥ب) ملاحظات المالك (2026-10-20) — اختبارات إلزامية
do $owner$
declare
  g text := 'd0000000-0000-0000-0000-000000000001';
  h text := 'd0000000-0000-0000-0000-000000000002';
  vA text := pg_temp.hx('owner-A');
  vB text := pg_temp.hx('owner-B');
  vC text := pg_temp.hx('owner-C');
  vX text := pg_temp.hx('owner-A-second-round');   -- محتوى A جديد (يختلف عن الحالي) لاختبار A ← B ← A
  vY text := pg_temp.hx('owner-B-second-round');
  day1 date := '2026-09-01';
  batch jsonb;
  r jsonb;
  mc integer;
begin
  -- (1) تعديل فاتورة دون تغيير تاريخها: اليوم القديم = الجديد ⇒ يُزال التكرار قبل الإدخال (لا خطأ ON CONFLICT)
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g, 'upsert', vA, '2026-10-20T16:00:00.000Z', 1000, pg_temp.bill(g, 1, 100, true, true, '2026-09-01'))));
  perform pg_temp.expect('same-day: create marks the day once', (select mark_count from public.ameen_invoice_dirty_days where day = day1)::text, '1');
  perform pg_temp.expect('same-day: daily total after create', (select total::text from public.ameen_invoice_daily_totals where day = day1 and bill_type = 1), '100');
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g, 'upsert', vB, '2026-10-20T16:01:00.000Z', 1001, pg_temp.bill(g, 1, 130, true, true, '2026-09-01'))));
  perform pg_temp.expect('same-day edit: applied without error', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('same-day edit: day counted once in this request', r ->> 'dirty_days', '1');
  perform pg_temp.expect('same-day edit: still one dirty row for the day', (select count(*) from public.ameen_invoice_dirty_days where day = day1)::text, '1');
  perform pg_temp.expect('same-day edit: mark_count +1 (not +2)', (select mark_count from public.ameen_invoice_dirty_days where day = day1)::text, '2');
  perform pg_temp.expect('same-day edit: daily total recomputed (no double count)', (select total::text from public.ameen_invoice_daily_totals where day = day1 and bill_type = 1), '130');
  perform pg_temp.expect('same-day edit: bill count unchanged', (select bills::text from public.ameen_invoice_daily_totals where day = day1 and bill_type = 1), '1');

  -- (1ب) عدة تعديلات لنفس الفاتورة في الطلب نفسه، ومعها فاتورة ثانية في اليوم نفسه ⇒ اليوم مرة واحدة
  batch := jsonb_build_array(
    pg_temp.ev(g, 'upsert', vC, '2026-10-20T16:02:00.000Z', 1002, pg_temp.bill(g, 1, 140, true, true, '2026-09-01')),
    pg_temp.ev(g, 'upsert', vA, '2026-10-20T16:03:00.000Z', 1003, pg_temp.bill(g, 1, 150, true, true, '2026-09-01')),
    pg_temp.ev(h, 'upsert', vA, '2026-10-20T16:03:00.000Z', 1004, pg_temp.bill(h, 1, 50, true, true, '2026-09-01')));
  r := pg_temp.apply_as('sync', batch);
  perform pg_temp.expect('batch same day: three applied', r ->> 'applied', '3');
  perform pg_temp.expect('batch same day: one dirty day in the request', r ->> 'dirty_days', '1');
  perform pg_temp.expect('batch same day: mark_count +1 for the whole request', (select mark_count from public.ameen_invoice_dirty_days where day = day1)::text, '3');
  perform pg_temp.expect('batch same day: totals = latest content of each bill', (select total::text from public.ameen_invoice_daily_totals where day = day1 and bill_type = 1), '200');
  perform pg_temp.expect('batch same day: two bills that day', (select bills::text from public.ameen_invoice_daily_totals where day = day1 and bill_type = 1), '2');

  -- (1ج) تعديل ينقل التاريخ ⇒ اليومان كلاهما للإعادة، والمجاميع تنتقل بلا بقايا
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(h, 'upsert', vB, '2026-10-20T16:04:00.000Z', 1005, pg_temp.bill(h, 1, 50, true, true, '2026-09-02'))));
  perform pg_temp.expect('date move: both days marked', r ->> 'dirty_days', '2');
  perform pg_temp.expect('date move: old day total drops', (select total::text from public.ameen_invoice_daily_totals where day = day1 and bill_type = 1), '150');
  perform pg_temp.expect('date move: new day total', (select total::text from public.ameen_invoice_daily_totals where day = '2026-09-02' and bill_type = 1), '50');

  -- (1د) حذف ⇒ يومه للإعادة، ويخرج من المجاميع
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(h, 'delete', 'deleted', '2026-10-20T16:05:00.000Z', 1006)));
  perform pg_temp.expect('delete: its day marked', r ->> 'dirty_days', '1');
  perform pg_temp.expect('delete: day leaves totals', (select count(*)::text from public.ameen_invoice_daily_totals where day = '2026-09-02'), '0');

  -- (2) A ← B ← A بنفس وقت المصدر: المفتاح يحمل GUID والتسلسل فلا يُرفض الأخير كمكرر
  r := pg_temp.apply_as('sync', jsonb_build_array(
         pg_temp.ev(g, 'upsert', vX, '2026-10-20T16:10:00.000Z', 1010, pg_temp.bill(g, 1, 10, true, true, '2026-09-01')),
         pg_temp.ev(g, 'upsert', vY, '2026-10-20T16:10:00.000Z', 1011, pg_temp.bill(g, 1, 20, true, true, '2026-09-01')),
         pg_temp.ev(g, 'upsert', vX, '2026-10-20T16:10:00.000Z', 1012, pg_temp.bill(g, 1, 10, true, true, '2026-09-01'))));
  perform pg_temp.expect('A-B-A same time: none treated as duplicate', r ->> 'duplicate', '0');
  perform pg_temp.expect('A-B-A same time: all three applied', r ->> 'applied', '3');
  perform pg_temp.expect('A-B-A same time: final content is A', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g::uuid), '10');
  perform pg_temp.expect('A-B-A same time: final version is A', (select version_hash from public.ameen_invoices where bill_guid = g::uuid), vX);
  perform pg_temp.expect('A-B-A: three distinct event rows', (select count(*)::text from public.ameen_invoice_events where bill_guid = g::uuid and source_seq between 1010 and 1012), '3');

  -- (3) إعادة المحاولة بعد انقطاع الاتصال: الدفعة نفسها مرة أخرى ⇒ كلها duplicate ولا شيء يتغيّر
  select mark_count into mc from public.ameen_invoice_dirty_days where day = day1;
  r := pg_temp.apply_as('sync', jsonb_build_array(
         pg_temp.ev(g, 'upsert', vX, '2026-10-20T16:10:00.000Z', 1010, pg_temp.bill(g, 1, 10, true, true, '2026-09-01')),
         pg_temp.ev(g, 'upsert', vY, '2026-10-20T16:10:00.000Z', 1011, pg_temp.bill(g, 1, 20, true, true, '2026-09-01')),
         pg_temp.ev(g, 'upsert', vX, '2026-10-20T16:10:00.000Z', 1012, pg_temp.bill(g, 1, 10, true, true, '2026-09-01'))));
  perform pg_temp.expect('retry after disconnect: all duplicate', r ->> 'duplicate', '3');
  perform pg_temp.expect('retry after disconnect: nothing applied', r ->> 'applied', '0');
  perform pg_temp.expect('retry after disconnect: no day re-marked', (select mark_count from public.ameen_invoice_dirty_days where day = day1)::text, mc::text);
  perform pg_temp.expect('retry after disconnect: content unchanged', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g::uuid), '10');

  -- (4) وصول خارج الترتيب عبر طلبين: الأحدث وصل أولاً ثم الأقدم ⇒ الأقدم stale ولا يكتب فوق الأحدث
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g, 'upsert', vC, '2026-10-20T16:20:00.000Z', 1021, pg_temp.bill(g, 1, 99, true, true, '2026-09-01'))));
  perform pg_temp.expect('out-of-order: newer applied first', r -> 'results' -> 0 ->> 'outcome', 'applied');
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g, 'upsert', vB, '2026-10-20T16:15:00.000Z', 1020, pg_temp.bill(g, 1, 20, true, true, '2026-09-01'))));
  perform pg_temp.expect('out-of-order: older arrives later = stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('out-of-order: newest content kept', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g::uuid), '99');
  perform pg_temp.expect('out-of-order: stale did not mark a day', r ->> 'dirty_days', '0');
  -- نفس وقت المصدر لكن تسلسل أقدم ⇒ stale أيضاً (التسلسل يحسم التعادل)
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(g, 'upsert', vA, '2026-10-20T16:20:00.000Z', 1019, pg_temp.bill(g, 1, 1, true, true, '2026-09-01'))));
  perform pg_temp.expect('tie on time, lower seq = stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('tie on time: newest content kept', (select payload ->> 'total' from public.ameen_invoices where bill_guid = g::uuid), '99');

  -- القراءة: الأيام والمجاميع للموظفين فقط
  perform pg_temp.expect('staff can read dirty days', pg_temp.try_as('staff', 'select 1 from public.ameen_invoice_dirty_days limit 1'), 'OK');
  perform pg_temp.expect('staff can read daily totals', pg_temp.try_as('staff', 'select 1 from public.ameen_invoice_daily_totals limit 1'), 'OK');
  perform pg_temp.expect('anon cannot read daily totals', pg_temp.try_as('anon', 'select 1 from public.ameen_invoice_daily_totals'), '42501');
  perform pg_temp.expect('direct write to dirty days denied (sync)', pg_temp.try_as('sync', 'insert into public.ameen_invoice_dirty_days (day) values (''2026-01-01'')'), '42501');
end
$owner$;

do $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', (select claims::text from pg_temp.ids where name = 'user'), true);
  set local role authenticated;
  select count(*) into n from public.ameen_invoice_daily_totals;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect('non-staff user sees no daily totals', n::text, '0');
end $$;

-- ١٥ج) مراجعة المالك P1 — الترتيب بالتسلسل وحده، وعزل الأحداث المعطوبة
do $p1$
declare
  m1 text := 'e0000000-0000-0000-0000-000000000001';
  m2 text := 'e0000000-0000-0000-0000-000000000002';
  m3 text := 'e0000000-0000-0000-0000-000000000003';
  vA text := pg_temp.hx('p1-A');
  vB text := pg_temp.hx('p1-B');
  good1 jsonb; good2 jsonb; future jsonb; forged jsonb; badschema jsonb; badguid jsonb; strseq jsonb; baddate jsonb; delhash jsonb; otherbill jsonb;
  r jsonb;
  ev_before bigint;
begin
  -- (أ) تعديل أحدث (تسلسل أكبر) لكن تاريخ تعديله في الأمين أقدم ⇒ يُطبَّق (لا يُرفض بسبب الوقت)
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(m1, 'upsert', vA, '2026-10-20T16:30:00.000Z', 5000, pg_temp.bill(m1, 1, 10, true, true, '2026-09-10'))));
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(m1, 'upsert', vB, '2026-10-20T16:00:00.000Z', 5001, pg_temp.bill(m1, 1, 11, true, true, '2026-09-10'))));
  perform pg_temp.expect('newer seq with OLDER Ameen time: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  perform pg_temp.expect('newer seq with older time: content updated', (select payload ->> 'total' from public.ameen_invoices where bill_guid = m1::uuid), '11');
  -- والعكس: تسلسل أقدم بوقت أحدث ⇒ stale
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(m1, 'upsert', vA, '2026-10-20T16:59:00.000Z', 4999, pg_temp.bill(m1, 1, 10, true, true, '2026-09-10'))));
  perform pg_temp.expect('older seq with NEWER Ameen time: stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('older seq with newer time: newest content kept', (select payload ->> 'total' from public.ameen_invoices where bill_guid = m1::uuid), '11');

  -- (ب) دفعة مختلطة: سليمان + ثمانية معطوبة، منها حدث بتاريخ مستقبلي ⇒ السليمان يُطبَّقان والبقية تُعزل
  good1     := pg_temp.ev(m2, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5010, pg_temp.bill(m2, 1, 70, true, true, '2026-09-11'));
  future    := pg_temp.ev(m3, 'upsert', vA, '2099-01-01T00:00:00.000Z', 5011, pg_temp.bill(m3, 1, 5));
  forged    := jsonb_set(pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5012, pg_temp.bill(m3, 1, 5)), '{event_id}', to_jsonb(vB));
  badschema := jsonb_set(pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5013, pg_temp.bill(m3, 1, 5)), '{schema}', '"v0"');
  badguid   := jsonb_set(pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5014, pg_temp.bill(m3, 1, 5)), '{bill_guid}', '"NOT-A-GUID"');
  strseq    := jsonb_set(pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5015, pg_temp.bill(m3, 1, 5)), '{source_seq}', '"5015"');
  baddate   := pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5016, pg_temp.bill(m3, 1, 5, true, true, '20-10-2026'));
  delhash   := pg_temp.ev(m3, 'delete', vA, '2026-10-20T16:31:00.000Z', 5017);
  otherbill := pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5018, pg_temp.bill(m2, 1, 5));
  good2     := pg_temp.ev(m2, 'upsert', vB, '2026-10-20T16:32:00.000Z', 5019, pg_temp.bill(m2, 1, 75, true, true, '2026-09-11'));
  select count(*) into ev_before from public.ameen_invoice_events;
  r := pg_temp.apply_as('sync', jsonb_build_array(good1, future, forged, badschema, badguid, strseq, baddate, delhash, otherbill, good2, '"not an object"'::jsonb));
  perform pg_temp.expect('mixed batch: request itself succeeds', (r is not null)::text, 'true');
  perform pg_temp.expect('mixed batch: two valid applied', r ->> 'applied', '2');
  perform pg_temp.expect('mixed batch: nine rejected', r ->> 'rejected', '9');
  perform pg_temp.expect('mixed batch: every event has a result', jsonb_array_length(r -> 'results')::text, '11');
  perform pg_temp.expect('mixed batch: future event rejected with reason',
    (select x ->> 'reason' from jsonb_array_elements(r -> 'results') x where x ->> 'index' = '2'), 'event timestamp is in the future');
  perform pg_temp.expect('mixed batch: forged key rejected', (select x ->> 'reason' from jsonb_array_elements(r -> 'results') x where x ->> 'index' = '3'), 'event_id does not match event content');
  perform pg_temp.expect('mixed batch: rejected results carry the event id', (select x ->> 'event_id' from jsonb_array_elements(r -> 'results') x where x ->> 'index' = '2'), future ->> 'event_id');
  perform pg_temp.expect('mixed batch: reasons carry no bill content', (select count(*)::text from jsonb_array_elements(r -> 'results') x where x::text ~ '"total"|lines|customer'), '0');
  perform pg_temp.expect('mixed batch: valid content applied in order', (select payload ->> 'total' from public.ameen_invoices where bill_guid = m2::uuid), '75');
  perform pg_temp.expect('mixed batch: nothing written for rejected bill', (select count(*)::text from public.ameen_invoices where bill_guid = m3::uuid), '0');
  perform pg_temp.expect('mixed batch: only valid events logged', (select count(*) - ev_before from public.ameen_invoice_events)::text, '2');
  perform pg_temp.expect('mixed batch: dirty day only from valid events', r ->> 'dirty_days', '1');

  -- (ج) إصلاح الحدث المعزول وإعادة إرساله: الحدث المستقبلي بعد تصحيح وقته يُطبَّق
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(m3, 'upsert', vA, '2026-10-20T16:31:00.000Z', 5011, pg_temp.bill(m3, 1, 5))));
  perform pg_temp.expect('repaired future event: applied', r -> 'results' -> 0 ->> 'outcome', 'applied');
  -- وإعادة حدث مُصلَح بتسلسله الأصلي بعد أن سبقه أحدث ⇒ stale، لا يكتب فوق الأحدث
  r := pg_temp.apply_as('sync', jsonb_build_array(pg_temp.ev(m2, 'upsert', vA, '2026-10-20T16:31:30.000Z', 5012, pg_temp.bill(m2, 1, 1, true, true, '2026-09-11'))));
  perform pg_temp.expect('requeued old seq after newer applied: stale', r -> 'results' -> 0 ->> 'outcome', 'stale');
  perform pg_temp.expect('requeued old seq: newest content kept', (select payload ->> 'total' from public.ameen_invoices where bill_guid = m2::uuid), '75');
end
$p1$;

-- ١٦) الدالة SECURITY DEFINER بمسار بحث ثابت، والجداول بلا سياسات كتابة
do $$
declare v_conf text[]; v_def boolean;
begin
  select proconfig, prosecdef into v_conf, v_def from pg_proc where oid = 'public.apply_ameen_invoice_events(jsonb)'::regprocedure;
  perform pg_temp.expect('rpc is security definer', v_def::text, 'true');
  perform pg_temp.expect('rpc has fixed search_path', (v_conf @> array['search_path=""'])::text, 'true');
  perform pg_temp.expect('service_role has no execute privilege', has_function_privilege('service_role', 'public.apply_ameen_invoice_events(jsonb)', 'execute')::text, 'false');
  perform pg_temp.expect('anon has no execute privilege', has_function_privilege('anon', 'public.apply_ameen_invoice_events(jsonb)', 'execute')::text, 'false');
  perform pg_temp.expect('rls forced on invoices', (select relforcerowsecurity::text from pg_class where oid = 'public.ameen_invoices'::regclass), 'true');
  perform pg_temp.expect('rls forced on events', (select relforcerowsecurity::text from pg_class where oid = 'public.ameen_invoice_events'::regclass), 'true');
  perform pg_temp.expect('rls forced on dirty days', (select relforcerowsecurity::text from pg_class where oid = 'public.ameen_invoice_dirty_days'::regclass), 'true');
  perform pg_temp.expect('daily totals view is security_invoker', (select (reloptions @> array['security_invoker=true'])::text from pg_class where oid = 'public.ameen_invoice_daily_totals'::regclass), 'true');
  perform pg_temp.expect('no write policy exists', (select count(*)::text from pg_policies where tablename in ('ameen_invoices', 'ameen_invoice_events', 'ameen_invoice_dirty_days') and cmd <> 'SELECT'), '0');
end $$;

-- ١٧) التراجع يُسقط كائنات 18 فقط
\i :rollback
do $$ begin
  perform pg_temp.expect('rollback dropped invoices', (to_regclass('public.ameen_invoices') is null)::text, 'true');
  perform pg_temp.expect('rollback dropped events', (to_regclass('public.ameen_invoice_events') is null)::text, 'true');
  perform pg_temp.expect('rollback dropped dirty days', (to_regclass('public.ameen_invoice_dirty_days') is null)::text, 'true');
  perform pg_temp.expect('rollback dropped daily totals view', (to_regclass('public.ameen_invoice_daily_totals') is null)::text, 'true');
  perform pg_temp.expect('rollback dropped rpc', (to_regprocedure('public.apply_ameen_invoice_events(jsonb)') is null)::text, 'true');
  perform pg_temp.expect('rollback kept is_staff', (to_regprocedure('public.is_staff()') is not null)::text, 'true');
end $$;

select 'AMEEN_INVOICE_EVENTS_OK';
