-- proposed/21-ameen-invoice-events-concurrent-duplicates.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** يستبدل جسم الدالة الوحيدة
-- public.apply_ameen_invoice_events(jsonb) من 18 (المطبَّقة 2026-10-22 بالإصدار 20261022034859) — بلا
-- مساس بأي جدول أو سياسة أو صلاحية أو بيانات، ولا cron ولا إرسال. ملف 18 نفسه لا يُعدَّل.
--
-- لماذا (Codex P1 على #344، 75a7fc37): طلبان متزامنان يعيدان الحدث نفسه (مثلاً إعادة محاولة الوكيل بعد مهلة
-- HTTP بينما الطلب الأول ما زال يعمل) كانا يجتازان فحص التكرار قبل القفل الاستشاري؛ الثاني ينتظر القفل ثم
-- يصطدم بالمفتاح الأساسي لـ ameen_invoice_events بعد التزام الأول، فيحوّله catch-all إلى «rejected» ويعزله
-- الوكيل في Dead Letter نهائياً بدل الإقرار به مكرراً.
--
-- التغيير (ثلاثة فقط، وكل ما عداها حرفياً كما في 18):
--   ١) القفل الاستشاري للفاتورة يُؤخذ قبل فحص التكرار، فيرى الفحص ما التزمه الطلب الآخر.
--   ٢) unique_violation على ameen_invoice_events_pkey داخل الحدث ⇒ duplicate (دفاع ثانٍ).
--   ٣) الأخطاء العابرة (40P01 تعارض أقفال، 40001، 55P03، 57014) تُفشل الطلب كله فيعيده الوكيل بتراجع، بدل
--      «rejected» لحدث سليم.
--
-- الصلاحيات: create or replace يحفظ ACL الحالية، وتُعاد revoke/grant نفسها صراحةً كما في 18.
-- يُشغَّل كطلب واحد أو `psql --single-transaction`. التراجع: 21-...-rollback.sql (جسم 18 حرفياً).
-- الاختبار: scripts/check-ameen-invoice-events-p1.mjs (طلبان متزامنان على PostgreSQL محلي + مجموعة 18 كاملة).

do $pre$
begin
  if to_regprocedure('public.apply_ameen_invoice_events(jsonb)') is null or to_regclass('public.ameen_invoice_events') is null then
    raise exception 'proposed/21 requires proposed/18 (apply_ameen_invoice_events and ameen_invoice_events) to be applied first';
  end if;
end
$pre$;

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
  v_constraint text;
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

      -- ── القفل قبل فحص التكرار (proposed/21، Codex P1) ──
      -- طلبان متزامنان يعيدان الحدث نفسه: كان كلاهما يجتاز فحص التكرار قبل القفل، فيصطدم الثاني بالمفتاح
      -- الأساسي بعد التزام الأول ويُرفض فيعزله الوكيل خطأً. القفل الاستشاري للفاتورة (حتى نهاية المعاملة)
      -- يُؤخذ أولاً، ففحص التكرار بعده يرى ما التزمه الطلب الآخر (READ COMMITTED لكل أمر).
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ameen_invoice:' || v_guid::text, 0));
      -- ── منع التكرار ──
      if exists (select 1 from public.ameen_invoice_events x where x.event_id = v_id) then
        v_outcome := 'duplicate';
      else
        -- ── الترتيب لكل فاتورة: التسلسل وحده يحدد الأحدث (لا وقت المصدر) ──
        -- تعديل أحدث يُطبَّق ولو كان تاريخ تعديله في الأمين أقدم؛ وما تسلسله ≤ المطبَّق stale.
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
    exception
      -- أخطاء عابرة (تعارض أقفال، تسلسل، إلغاء بمهلة) ليست عيباً في الحدث: تُفشل الطلب كله فيعيد الوكيل
      -- الدفعة لاحقاً بتراجع، بدل «rejected» يعزله نهائياً (proposed/21).
      when sqlstate '40P01' or sqlstate '40001' or sqlstate '55P03' or sqlstate '57014' then
        raise;
      -- دفاع ثانٍ (proposed/21): تعارض على مفتاح الحدث نفسه = التزمه طلب آخر ⇒ duplicate لا rejected.
      when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint = 'ameen_invoice_events_pkey' then
          v_dupes := v_dupes + 1;
          v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'event_id', v_id, 'index', v_idx, 'outcome', 'duplicate'));
        else
          v_rejected := v_rejected + 1;
          v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'event_id', v_id, 'index', v_idx, 'outcome', 'rejected', 'reason_code', sqlstate, 'reason', 'unexpected error ' || sqlstate));
        end if;
      when others then
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
  'proposed/18+21: يطبّق أحداث فواتير الأمين بترتيبها وبلا تكرار، والتكرار المتزامن duplicate. هوية المزامنة فقط.';

notify pgrst, 'reload schema';
