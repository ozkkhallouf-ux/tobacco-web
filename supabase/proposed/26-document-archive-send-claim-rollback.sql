-- التراجع عن 26 (حجز إرسال تيليغرام لأرشفة المستندات): يعيد دالتي 22 كما طُبّقتا حرفياً،
-- ويحذف دوال الحجز وأعمدته. لا يمسّ أي صف قائم ولا رقم رسالة ولا ملف Drive.
-- الترتيب: أعِد نشر نسخة document-archive-notify السابقة (بلا claim_send) أولاً، وإلا رفضت
-- الدالة الجديدة كل إشعار (rpc 404 ⇒ فشل مغلق بلا إرسال) حتى تُعاد.
begin;
drop function if exists public.request_document_archive_resend(text);
drop function if exists public.document_archive_release_send(text, uuid);
drop function if exists public.document_archive_claim_send(jsonb, uuid);

-- دالة 22 حرفياً (supabase/proposed/22-document-archive.sql).
create or replace function private.document_archive_upsert_item(p_item jsonb, p_now timestamptz)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rank constant jsonb := '{"rendered":1,"uploaded":2,"notified":3}';
begin
  insert into public.document_archive_items as t (
    job_id, doc_type, source_guid, doc_number, doc_date, customer_guid, customer_name,
    amount, currency, version, version_hash, status, failed, drive_file_id, drive_web_link,
    telegram_message_id, telegram_sent_at, attempts, last_error, host, created_at, updated_at)
  values (
    p_item ->> 'job_id',
    p_item ->> 'doc_type',
    (p_item ->> 'source_guid')::uuid,
    p_item ->> 'doc_number',
    (p_item ->> 'doc_date')::date,
    nullif(p_item ->> 'customer_guid', '')::uuid,
    coalesce(p_item ->> 'customer_name', ''),
    nullif(p_item ->> 'amount', '')::numeric,
    coalesce(p_item ->> 'currency', ''),
    (p_item ->> 'version')::int,
    p_item ->> 'version_hash',
    p_item ->> 'status',
    coalesce((p_item ->> 'failed')::boolean, false),
    nullif(p_item ->> 'drive_file_id', ''),
    nullif(p_item ->> 'drive_web_link', ''),
    nullif(p_item ->> 'telegram_message_id', '')::bigint,
    case when nullif(p_item ->> 'telegram_message_id', '') is not null then p_now end,
    coalesce((p_item ->> 'attempts')::int, 0),
    left(nullif(p_item ->> 'last_error', ''), 120),
    left(coalesce(p_item ->> 'host', ''), 64),
    p_now, p_now)
  on conflict (job_id) do update set
    status = case when (v_rank ->> excluded.status)::int >= (v_rank ->> t.status)::int
                  then excluded.status else t.status end,
    failed = excluded.failed,
    customer_name = excluded.customer_name,
    drive_file_id = coalesce(t.drive_file_id, excluded.drive_file_id),
    drive_web_link = coalesce(t.drive_web_link, excluded.drive_web_link),
    telegram_message_id = coalesce(t.telegram_message_id, excluded.telegram_message_id),
    telegram_sent_at = coalesce(t.telegram_sent_at, excluded.telegram_sent_at),
    attempts = greatest(t.attempts, excluded.attempts),
    last_error = excluded.last_error,
    host = case when excluded.host <> '' then excluded.host else t.host end,
    updated_at = p_now
  -- الهوية ثابتة: نفس job_id بمصدر أو نسخة مختلفة = خطأ لا يُكتب فوقه.
  where t.source_guid = excluded.source_guid
    and t.version = excluded.version
    and t.version_hash = excluded.version_hash
    and t.doc_type = excluded.doc_type;
end;
$$;

revoke all on function private.document_archive_upsert_item(jsonb, timestamptz) from public, anon, authenticated;

-- دالة 22 حرفياً.
create or replace function public.document_archive_ingest_report(p_report jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now   timestamptz := now();
  v_items jsonb := coalesce(p_report -> 'items', '[]'::jsonb);
  v_item  jsonb;
  v_retry jsonb;
  v_rejected int := 0;
begin
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 200 then
    raise exception 'document_archive: items must be an array of at most 200' using errcode = '22023';
  end if;

  insert into public.document_archive_heartbeat as h (
    host, drive_state, drive_checked_at, mode, last_success_at, pending_count, failed_count, worker_version, reported_at)
  values (
    left(p_report ->> 'host', 64),
    p_report ->> 'drive_state',
    nullif(p_report ->> 'drive_checked_at', '')::timestamptz,
    p_report ->> 'mode',
    nullif(p_report ->> 'last_success_at', '')::timestamptz,
    coalesce((p_report ->> 'pending_count')::int, 0),
    coalesce((p_report ->> 'failed_count')::int, 0),
    left(coalesce(p_report ->> 'worker_version', ''), 40),
    v_now)
  on conflict (host) do update set
    drive_state = excluded.drive_state,
    drive_checked_at = excluded.drive_checked_at,
    mode = excluded.mode,
    last_success_at = greatest(h.last_success_at, excluded.last_success_at),
    pending_count = excluded.pending_count,
    failed_count = excluded.failed_count,
    worker_version = excluded.worker_version,
    reported_at = v_now;

  -- عنصر يتعارض مع (doc_type, source_guid, version) بـjob_id آخر (ملف مهمة تالف عُزل محلياً
  -- فأُعيد رقم النسخة) يُرفض وحده ويُعدّ؛ لا يُسقط الدفعة ولا النبض فتتجمّد المرآة.
  for v_item in select value from jsonb_array_elements(v_items) loop
    begin
      perform private.document_archive_upsert_item(v_item || jsonb_build_object('host', p_report ->> 'host'), v_now);
    exception when unique_violation then
      v_rejected := v_rejected + 1;
    end;
  end loop;

  -- طلبات المالك المفتوحة: تُسلَّم مرة واحدة وتُعلَّم مستهلكة في المعاملة نفسها.
  with taken as (
    update public.document_archive_retry_requests r
       set consumed_at = v_now
     where r.consumed_at is null
    returning r.job_id
  )
  select coalesce(jsonb_agg(job_id), '[]'::jsonb) into v_retry from taken;

  return jsonb_build_object('items', jsonb_array_length(v_items), 'rejected', v_rejected, 'retry_job_ids', v_retry);
end;
$$;

revoke all on function public.document_archive_ingest_report(jsonb) from public, anon, authenticated;
grant execute on function public.document_archive_ingest_report(jsonb) to service_role;

drop function if exists private.document_archive_mark_uncertain(text);
drop index if exists public.document_archive_items_sending_idx;
alter table public.document_archive_items
  drop column if exists send_claimed_at,
  drop column if exists send_claim_id,
  drop column if exists send_state;
commit;
