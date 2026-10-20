-- proposed/18-ameen-invoice-events.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** لا يجدول cron ولا يرسل شيئاً ولا يمسّ
-- inventory_reports ولا تقرير ameen_customer_invoices ولا أي مزامنة قائمة.
--
-- الغرض: مخزن «أحداث فواتير الأمين» (Ameen Invoice Event Sync، المرحلة 2). يكتبه
-- tools/ameen-invoice-event-agent.ps1 عبر الدالة الوحيدة apply_ameen_invoice_events.
--
-- النموذج:
--   * public.ameen_invoices: صف واحد لكل فاتورة أمين، مفتاحه bill_guid (= bu000.GUID الثابت عند
--     التعديل — ثبت بفحص المرحلة 1). تعديل الفاتورة في الأمين يحدّث الصف نفسه (revision + 1) ولا
--     يُنشئ صفاً ثانياً أبداً. الحذف شاهد قبر (status = 'deleted') لا حذف فعلي، فلا يعيد حدثٌ قديم
--     متأخر إحياءَ فاتورة محذوفة.
--   * public.ameen_invoice_events: سجل إلحاقي لكل حدث استُلم، مفتاحه event_id ⇒ إعادة الإرسال
--     (انقطاع إنترنت، إعادة محاولة) لا تكرر شيئاً.
--
-- الضمانات:
--   * لا كتابة مباشرة لأي دور: revoke all من public وanon وauthenticated وservice_role، وRLS مفعّلة
--     ومفروضة (force) بلا أي سياسة كتابة.
--   * الكتابة الوحيدة عبر public.apply_ameen_invoice_events(jsonb) — SECURITY DEFINER بمسار بحث فارغ —
--     ولا تقبل إلا هوية المزامنة المعتمدة (9724dbe4-…، نفس حساب ameen_price_sync_status). أي مستخدم
--     آخر — ولو موظفاً أو مالكاً — يُرفض بـ 42501. لا احتياط بمفتاح service_role.
--   * الترتيب (مراجعة المالك P1، 2026-10-20): التسلسل source_seq الذي يمنحه الوكيل مرة واحدة لكل حدث
--     (ثابت عبر إعادة المحاولة، متزايد لكل فاتورة) هو وحده ما يحدد الأحدث — لا وقت المصدر. تعديل أحدث
--     يُطبَّق ولو كان تاريخ تعديله في الأمين أقدم؛ وما تسلسله ≤ المطبَّق «stale» ولا يغيّر شيئاً. داخل
--     الدفعة تُعالج الأحداث بترتيب source_seq، مع قفل استشاري لكل فاتورة.
--   * العزل (مراجعة المالك P1): كل حدث يُتحقق منه ويُطبَّق في كتلة فرعية مستقلة؛ الحدث المعطوب (ومنه
--     المستقبلي التاريخ) يعود «rejected» برمز وسبب مختصر بلا محتوى، وتكتمل بقية الدفعة. الوكيل يعزله
--     محلياً (Dead Letter) ولا يُفقد.
--   * مفتاح الحدث = sha256(bill_guid|source_seq|kind|version_hash|source_event_at): يحمل GUID الفاتورة
--     وتسلسلاً متزايداً، لا بصمة المحتوى وحدها — فعودة الفاتورة لمحتوى سابق (A ← B ← A) حدث جديد لا
--     «مكرر» (ملاحظة المالك 2026-10-20). يُعاد حسابه على الخادم، فلا يُقبل مفتاح مختلَق.
--   * الأيام المتأثرة: كل حدث مطبَّق يعلّم يوم الفاتورة القديم والجديد في ameen_invoice_dirty_days
--     لإعادة احتساب التقارير. التعديل بلا تغيير التاريخ يعطي اليوم نفسه مرتين، فتُزال الأيام المكررة
--     (DISTINCT) قبل إدخال واحد في نهاية الطلب — لا خطأ «ON CONFLICT … a second time» ولا عدّ مزدوج.
--   * المجاميع اليومية تُحسب من المصدر نفسه (عرض ameen_invoice_daily_totals) فتبقى صحيحة بعد أي
--     تعديل أو حذف بلا تراكم.
--   * القراءة: الموظفون فقط (is_staff()).
--   * حدود: ≤ 200 حدث و≤ 4MB لكل طلب، ≤ 256KB لكل فاتورة، ولا طابع زمني مستقبلي بأكثر من 5 دقائق.
--
-- يُشغَّل كطلب واحد أو `psql --single-transaction`. التراجع: 18-ameen-invoice-events-rollback.sql.
-- الاختبار: supabase/tests/ameen-invoice-events.sql (يشغّله scripts/check-ameen-invoice-events.mjs).

do $pre$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'proposed/18 requires public.is_staff()';
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise exception 'proposed/18 requires auth.uid()';
  end if;
end
$pre$;

-- ── الجداول ──────────────────────────────────────────────────────────────────────────────────

create table if not exists public.ameen_invoices (
  bill_guid       uuid primary key,
  bill_type       smallint check (bill_type in (1, 3)),         -- 1 مبيع، 3 مرتجع؛ null لشاهد قبر مجهول
  status          text not null check (status in ('active', 'deleted')),
  version_hash    text not null check (version_hash ~ '^([0-9a-f]{64}|deleted)$'),
  revision        integer not null default 1 check (revision >= 1),
  source_event_at timestamptz not null,                          -- وقت الحدث في الأمين (UTC)
  source_seq      bigint not null check (source_seq >= 1),       -- تسلسل الوكيل المحلي
  bill_number     bigint,
  bill_date       date,
  customer_guid   uuid,
  is_named        boolean,
  is_posted       boolean,
  payload         jsonb,                                         -- آخر لقطة كاملة (رأس + أسطر)
  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint ameen_invoices_active_has_payload check (status <> 'active' or (payload is not null and bill_type is not null)),
  constraint ameen_invoices_payload_object check (payload is null or pg_catalog.jsonb_typeof(payload) = 'object'),
  constraint ameen_invoices_payload_size check (payload is null or pg_column_size(payload) <= 262144),
  constraint ameen_invoices_deleted_marker check ((status = 'deleted') = (version_hash = 'deleted'))
);

create index if not exists ameen_invoices_customer_idx
  on public.ameen_invoices (customer_guid, bill_date desc) where status = 'active';
create index if not exists ameen_invoices_updated_idx
  on public.ameen_invoices (updated_at desc);

create table if not exists public.ameen_invoice_events (
  event_id        text primary key check (event_id ~ '^[0-9a-f]{64}$'),
  bill_guid       uuid not null,
  kind            text not null check (kind in ('upsert', 'delete')),
  version_hash    text not null check (version_hash ~ '^([0-9a-f]{64}|deleted)$'),
  source_event_at timestamptz not null,
  source_seq      bigint not null,
  detected_at     timestamptz,
  outcome         text not null check (outcome in ('applied', 'stale', 'noop')),
  writer_id       uuid not null,
  received_at     timestamptz not null default now()
);

create index if not exists ameen_invoice_events_bill_idx
  on public.ameen_invoice_events (bill_guid, received_at desc);

-- أيام تحتاج إعادة احتساب التقارير المرتبطة. صف واحد لكل يوم؛ mark_count يزيد مرة واحدة لكل طلب
-- لمس اليوم (لا لكل حدث)، فيعرف المستهلك أن اليوم تغيّر منذ آخر احتساب عبر last_marked_at.
create table if not exists public.ameen_invoice_dirty_days (
  day            date primary key,
  first_marked_at timestamptz not null default now(),
  last_marked_at  timestamptz not null default now(),
  mark_count      integer not null default 1 check (mark_count >= 1)
);

-- مجاميع يومية محسوبة من الفواتير الفعّالة مباشرة (لا تخزين، فلا انحراف بعد التعديل أو الحذف).
create or replace view public.ameen_invoice_daily_totals
with (security_invoker = true) as
select i.bill_date as day,
       i.bill_type,
       count(*)::integer as bills,
       coalesce(sum(case when pg_catalog.jsonb_typeof(i.payload -> 'total') = 'number' then (i.payload ->> 'total')::numeric end), 0) as total,
       coalesce(sum(case when pg_catalog.jsonb_typeof(i.payload -> 'total_disc') = 'number' then (i.payload ->> 'total_disc')::numeric end), 0) as total_disc,
       coalesce(sum(case when pg_catalog.jsonb_typeof(i.payload -> 'first_pay') = 'number' then (i.payload ->> 'first_pay')::numeric end), 0) as first_pay
  from public.ameen_invoices i
 where i.status = 'active'
 group by i.bill_date, i.bill_type;

comment on table public.ameen_invoices is
  'فواتير الأمين (proposed/18): صف لكل bu000.GUID. الكتابة عبر apply_ameen_invoice_events فقط؛ القراءة للموظفين.';
comment on table public.ameen_invoice_dirty_days is
  'أيام فواتير الأمين التي تغيّرت وتحتاج إعادة احتساب تقاريرها (proposed/18). الكتابة عبر الدالة فقط.';
comment on view public.ameen_invoice_daily_totals is
  'مجاميع يومية من ameen_invoices الفعّالة (proposed/18). security_invoker: تخضع لسياسة القراءة نفسها.';
comment on table public.ameen_invoice_events is
  'سجل أحداث فواتير الأمين (proposed/18): مفتاح event_id يمنع التكرار. الكتابة عبر الدالة فقط.';

alter table public.ameen_invoices enable row level security;
alter table public.ameen_invoices force row level security;
alter table public.ameen_invoice_events enable row level security;
alter table public.ameen_invoice_events force row level security;
alter table public.ameen_invoice_dirty_days enable row level security;
alter table public.ameen_invoice_dirty_days force row level security;

revoke all on table public.ameen_invoices from public, anon, authenticated, service_role;
revoke all on table public.ameen_invoice_events from public, anon, authenticated, service_role;
revoke all on table public.ameen_invoice_dirty_days from public, anon, authenticated, service_role;
revoke all on table public.ameen_invoice_daily_totals from public, anon, authenticated, service_role;
grant select on table public.ameen_invoices to authenticated;
grant select on table public.ameen_invoice_events to authenticated;
grant select on table public.ameen_invoice_dirty_days to authenticated;
grant select on table public.ameen_invoice_daily_totals to authenticated;

drop policy if exists "staff can read ameen invoices" on public.ameen_invoices;
create policy "staff can read ameen invoices"
  on public.ameen_invoices
  for select
  to authenticated
  using ((select public.is_staff()));

drop policy if exists "staff can read ameen invoice events" on public.ameen_invoice_events;
create policy "staff can read ameen invoice events"
  on public.ameen_invoice_events
  for select
  to authenticated
  using ((select public.is_staff()));

drop policy if exists "staff can read ameen invoice dirty days" on public.ameen_invoice_dirty_days;
create policy "staff can read ameen invoice dirty days"
  on public.ameen_invoice_dirty_days
  for select
  to authenticated
  using ((select public.is_staff()));

-- ── هوية المزامنة المعتمدة ───────────────────────────────────────────────────────────────────

create or replace function public.ameen_invoice_is_sync_writer()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.uid()) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid, false);
$$;

revoke all on function public.ameen_invoice_is_sync_writer() from public, anon, service_role;
grant execute on function public.ameen_invoice_is_sync_writer() to authenticated;

-- ── دالة الكتابة الوحيدة ──────────────────────────────────────────────────────────────────────

create or replace function public.apply_ameen_invoice_events(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_writer   uuid := (select auth.uid());
  v_now      timestamptz := pg_catalog.now();
  v_evt      jsonb;
  v_idx      bigint;
  v_id       text;
  v_kind     text;
  v_guid     uuid;
  v_hash     text;
  v_at_text  text;
  v_at       timestamptz;
  v_seq      bigint;
  v_detected timestamptz;
  v_bill     jsonb;
  v_cur      record;
  v_found    boolean;
  v_outcome  text;
  v_results  jsonb := '[]'::jsonb;
  v_applied  integer := 0;
  v_dupes    integer := 0;
  v_stale    integer := 0;
  v_noop     integer := 0;
  v_rejected integer := 0;
  v_reason   text;
  v_old_day  date;
  v_new_day  date;
  v_days     date[] := '{}'::date[];
  v_marked   integer := 0;
begin
  -- أخطاء على مستوى الطلب كله (الهوية والشكل والحجم) ترفض الطلب؛ ما عداها يُعزل حدثاً حدثاً.
  if not public.ameen_invoice_is_sync_writer() then
    raise exception 'apply_ameen_invoice_events is restricted to the trusted sync identity'
      using errcode = '42501';
  end if;
  if p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array' then
    raise exception 'events must be a JSON array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_events) > 200 then
    raise exception 'too many events in one request' using errcode = '22023';
  end if;
  if pg_catalog.pg_column_size(p_events) > 4194304 then
    raise exception 'events payload too large' using errcode = '22023';
  end if;

  -- الترتيب بالتسلسل وحده؛ الحدث بلا تسلسل صالح يأتي آخراً ويُرفض منفرداً.
  for v_evt, v_idx in
    select e.value, e.ordinality
      from pg_catalog.jsonb_array_elements(p_events) with ordinality as e(value, ordinality)
     order by case when pg_catalog.jsonb_typeof(e.value -> 'source_seq') = 'number'
                    and (e.value ->> 'source_seq') ~ '^[0-9]{1,18}$'
                   then (e.value ->> 'source_seq')::bigint end nulls last,
              e.ordinality
  loop
    v_id := case when pg_catalog.jsonb_typeof(v_evt) = 'object' and (v_evt ->> 'event_id') ~ '^[0-9a-f]{64}$'
                 then v_evt ->> 'event_id' end;
    -- كتلة فرعية لكل حدث: أي خطأ فيه يُرجع تغييراته وحده ويُسجَّل «rejected» ثم نكمل.
    -- متغيرات PL/pgSQL لا تُرجعها الكتلة، لذلك تُحدَّث العدّادات والأيام في آخرها فقط.
    begin
      if pg_catalog.jsonb_typeof(v_evt) <> 'object' then
        raise exception 'event must be a JSON object' using errcode = '22023';
      end if;
      if coalesce(v_evt ->> 'schema', '') <> 'ameen-invoice-event/v1' then
        raise exception 'unsupported event schema' using errcode = '22023';
      end if;
      if pg_catalog.jsonb_typeof(v_evt -> 'source_seq') is distinct from 'number'
         or (v_evt ->> 'source_seq') !~ '^[0-9]{1,18}$' then
        raise exception 'source_seq must be a positive integer' using errcode = '22023';
      end if;
      v_seq     := (v_evt ->> 'source_seq')::bigint;
      v_kind    := v_evt ->> 'kind';
      v_hash    := v_evt ->> 'version_hash';
      v_at_text := v_evt ->> 'source_event_at';
      if v_seq < 1 then
        raise exception 'source_seq must be a positive integer' using errcode = '22023';
      end if;
      if v_id is null then
        raise exception 'event_id must be a sha256 hex' using errcode = '22023';
      end if;
      if v_kind is null or v_kind not in ('upsert', 'delete') then
        raise exception 'unsupported event kind' using errcode = '22023';
      end if;
      if coalesce(v_evt ->> 'bill_guid', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or v_evt ->> 'bill_guid' = '00000000-0000-0000-0000-000000000000' then
        raise exception 'bill_guid must be a lowercase non-zero uuid' using errcode = '22023';
      end if;
      v_guid := (v_evt ->> 'bill_guid')::uuid;
      if (v_kind = 'upsert' and coalesce(v_hash, '') !~ '^[0-9a-f]{64}$')
         or (v_kind = 'delete' and v_hash is distinct from 'deleted') then
        raise exception 'version_hash does not match event kind' using errcode = '22023';
      end if;
      begin
        v_at := v_at_text::timestamptz;
        v_detected := nullif(v_evt ->> 'detected_at', '')::timestamptz;
      exception when others then
        raise exception 'event timestamp is invalid' using errcode = '22007';
      end;
      if v_at is null then
        raise exception 'source_event_at is required' using errcode = '22023';
      end if;
      if v_at > v_now + interval '5 minutes' or v_detected > v_now + interval '5 minutes' then
        raise exception 'event timestamp is in the future' using errcode = '22023';
      end if;
      -- المفتاح مشتقّ لا مختلَق: نفس صيغة الوكيل حرفياً.
      if v_id <> pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           (v_evt ->> 'bill_guid') || '|' || (v_evt ->> 'source_seq') || '|' || v_kind || '|' || v_hash || '|' || v_at_text, 'UTF8')), 'hex') then
        raise exception 'event_id does not match event content' using errcode = '22023';
      end if;
      if v_kind = 'upsert' then
        v_bill := v_evt -> 'bill';
        if pg_catalog.jsonb_typeof(v_bill) is distinct from 'object'
           or v_bill ->> 'bill_guid' is distinct from v_evt ->> 'bill_guid'
           or coalesce(v_bill ->> 'bill_type', '') not in ('1', '3')
           or pg_catalog.jsonb_typeof(v_bill -> 'lines') is distinct from 'array' then
          raise exception 'upsert needs a bill snapshot for the same bill_guid' using errcode = '22023';
        end if;
        if pg_catalog.pg_column_size(v_bill) > 262144 then
          raise exception 'bill snapshot too large' using errcode = '22023';
        end if;
        if v_bill ? 'bill_date' and (v_bill ->> 'bill_date') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'bill_date must be YYYY-MM-DD' using errcode = '22023';
        end if;
      else
        v_bill := null;
      end if;

      -- ── منع التكرار ──
      if exists (select 1 from public.ameen_invoice_events x where x.event_id = v_id) then
        v_outcome := 'duplicate';
      else
        -- ── الترتيب لكل فاتورة: التسلسل وحده يحدد الأحدث (لا وقت المصدر) ──
        -- تعديل أحدث يُطبَّق ولو كان تاريخ تعديله في الأمين أقدم؛ وما تسلسله ≤ المطبَّق stale.
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ameen_invoice:' || v_guid::text, 0));
        select i.status, i.version_hash, i.source_seq, i.bill_date into v_cur
          from public.ameen_invoices i where i.bill_guid = v_guid for update;
        v_found := found;
        v_old_day := case when v_found and v_cur.status = 'active' then v_cur.bill_date end;
        v_new_day := case when v_kind = 'upsert' then (v_bill ->> 'bill_date')::date end;

        if v_found and v_seq <= v_cur.source_seq then
          v_outcome := 'stale';
        elsif v_kind = 'upsert' then
          if v_found and v_cur.status = 'active' and v_cur.version_hash = v_hash then
            v_outcome := 'noop';
            update public.ameen_invoices
               set source_event_at = v_at, source_seq = v_seq
             where bill_guid = v_guid;
          else
            v_outcome := 'applied';
            insert into public.ameen_invoices as t
              (bill_guid, bill_type, status, version_hash, revision, source_event_at, source_seq,
               bill_number, bill_date, customer_guid, is_named, is_posted, payload, updated_at, deleted_at)
            values
              (v_guid, (v_bill ->> 'bill_type')::smallint, 'active', v_hash, 1, v_at, v_seq,
               case when pg_catalog.jsonb_typeof(v_bill -> 'number') = 'number' then (v_bill ->> 'number')::numeric::bigint end,
               v_new_day,
               case when (v_bill ->> 'customer_guid') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_bill ->> 'customer_guid')::uuid end,
               case when pg_catalog.jsonb_typeof(v_bill -> 'is_named') = 'boolean' then (v_bill ->> 'is_named')::boolean end,
               case when pg_catalog.jsonb_typeof(v_bill -> 'is_posted') = 'boolean' then (v_bill ->> 'is_posted')::boolean end,
               v_bill, v_now, null)
            on conflict (bill_guid) do update
              set bill_type = excluded.bill_type, status = 'active', version_hash = excluded.version_hash,
                  revision = t.revision + 1, source_event_at = excluded.source_event_at,
                  source_seq = excluded.source_seq, bill_number = excluded.bill_number,
                  bill_date = excluded.bill_date, customer_guid = excluded.customer_guid,
                  is_named = excluded.is_named, is_posted = excluded.is_posted,
                  payload = excluded.payload, updated_at = v_now, deleted_at = null;
          end if;
        else
          if v_found and v_cur.status = 'deleted' then
            v_outcome := 'noop';
            update public.ameen_invoices
               set source_event_at = v_at, source_seq = v_seq
             where bill_guid = v_guid;
          else
            v_outcome := 'applied';
            -- شاهد قبر: نحتفظ بآخر لقطة للتدقيق، ونمنع إحياء الفاتورة بحدث أقدم.
            insert into public.ameen_invoices as t
              (bill_guid, bill_type, status, version_hash, revision, source_event_at, source_seq, updated_at, deleted_at)
            values (v_guid, null, 'deleted', 'deleted', 1, v_at, v_seq, v_now, v_now)
            on conflict (bill_guid) do update
              set status = 'deleted', version_hash = 'deleted', revision = t.revision + 1,
                  source_event_at = excluded.source_event_at, source_seq = excluded.source_seq,
                  updated_at = v_now, deleted_at = v_now;
          end if;
        end if;

        insert into public.ameen_invoice_events
          (event_id, bill_guid, kind, version_hash, source_event_at, source_seq, detected_at, outcome, writer_id, received_at)
        values (v_id, v_guid, v_kind, v_hash, v_at, v_seq, v_detected, v_outcome, v_writer, v_now);
      end if;

      -- آخر الكتلة: العدّادات واليوم القديم/الجديد (قد يتكرران — تعديل بلا تغيير التاريخ — يُزال لاحقاً).
      if v_outcome = 'applied' then
        v_days := v_days || v_old_day || v_new_day;
        v_applied := v_applied + 1;
      elsif v_outcome = 'duplicate' then v_dupes := v_dupes + 1;
      elsif v_outcome = 'stale' then v_stale := v_stale + 1;
      else v_noop := v_noop + 1;
      end if;
      v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'event_id', v_id, 'index', v_idx, 'outcome', v_outcome));
    exception when others then
      -- عزل: سبب مختصر بلا محتوى الحدث. رسائلنا (22023/22007) معروفة النص؛ غيرها يُختصر لرمزه.
      v_reason := case when sqlstate in ('22023', '22007') then sqlerrm else 'unexpected error ' || sqlstate end;
      v_rejected := v_rejected + 1;
      v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'event_id', v_id, 'index', v_idx, 'outcome', 'rejected', 'reason_code', sqlstate, 'reason', v_reason));
    end;
  end loop;

  -- إدخال واحد للأيام المتأثرة بعد إزالة التكرار: ON CONFLICT DO UPDATE لا يقبل الصف نفسه مرتين
  -- في أمر واحد، والعدّ يزيد مرة واحدة لكل يوم لكل طلب.
  insert into public.ameen_invoice_dirty_days as d (day, first_marked_at, last_marked_at, mark_count)
  select distinct x.day, v_now, v_now, 1
    from pg_catalog.unnest(v_days) as x(day)
   where x.day is not null
  on conflict (day) do update
    set last_marked_at = excluded.last_marked_at, mark_count = d.mark_count + 1;
  get diagnostics v_marked = row_count;

  return pg_catalog.jsonb_build_object(
    'results', v_results, 'applied', v_applied, 'duplicate', v_dupes, 'stale', v_stale, 'noop', v_noop,
    'rejected', v_rejected, 'dirty_days', v_marked);
end;
$$;

revoke all on function public.apply_ameen_invoice_events(jsonb) from public, anon, service_role;
grant execute on function public.apply_ameen_invoice_events(jsonb) to authenticated;

comment on function public.apply_ameen_invoice_events(jsonb) is
  'proposed/18: يطبّق أحداث فواتير الأمين بترتيبها وبلا تكرار. هوية المزامنة فقط.';

notify pgrst, 'reload schema';
