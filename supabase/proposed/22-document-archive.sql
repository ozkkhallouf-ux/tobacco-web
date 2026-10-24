-- ============================================================================
-- 22: أرشفة المستندات على Google Drive — حالة المهام ونبض العامل وطلبات إعادة المحاولة.
--
-- الحالة: مقترحة، غير مطبَّقة. التطبيق بموافقة صريحة من المالك فقط.
-- التراجع: 22-document-archive-rollback.sql (يحذف هذه الكائنات وحدها؛ ملفات Drive لا تُمسّ).
--
-- المصدر الموثوق لحالة كل مهمة هو صندوق العامل المحلي على OZK2026؛ هذه الجداول مرآة
-- للعرض في الموقع، تكتبها دالة Edge `document-archive-notify` بدور service_role وحده.
--
-- الأمن:
--   * RLS على الجداول الثلاثة؛ القراءة للمالك وحده (public.is_owner())، لا للموظفين.
--   * لا سياسة كتابة لأي دور عدا service_role (يتجاوز RLS). anon بلا أي صلاحية.
--   * المالك يطلب إعادة المحاولة عبر request_document_archive_retry وحدها (SECURITY DEFINER).
--   * لا يُخزَّن هنا توكن ولا سرّ؛ رابط Drive رابط العرض الخاص فقط (يحتاج تسجيل دخول المالك).
--   * لا حذف تلقائي: لا cron تنظيف ولا cascade يمسّ سجل الأرشيف.
-- ============================================================================

begin;

create schema if not exists private;

create table if not exists public.document_archive_items (
  job_id              text primary key check (job_id ~ '^[0-9a-f]{32}$'),
  doc_type            text not null check (doc_type in ('wholesale_invoice', 'receipt')),
  source_guid         uuid not null,
  doc_number          text not null check (length(doc_number) between 1 and 40),
  doc_date            date not null,
  customer_guid       uuid,
  customer_name       text not null default '' check (length(customer_name) <= 200),
  amount              numeric(18, 3),
  currency            text not null default '' check (length(currency) <= 8),
  version             int  not null check (version between 1 and 1000),
  version_hash        text not null check (version_hash ~ '^[0-9a-f]{64}$'),
  status              text not null check (status in ('rendered', 'uploaded', 'notified')),
  failed              boolean not null default false,
  drive_file_id       text check (drive_file_id is null or drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  drive_web_link      text check (drive_web_link is null
                        or drive_web_link ~ '^https://drive\.google\.com/file/d/[A-Za-z0-9_-]{10,200}/view(\?usp=drivesdk)?$'),
  telegram_message_id bigint,
  telegram_sent_at    timestamptz,
  attempts            int not null default 0 check (attempts >= 0),
  last_error          text check (last_error is null or length(last_error) <= 120),
  host                text not null default '' check (length(host) <= 64),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (doc_type, source_guid, version)
);

create index if not exists document_archive_items_source_idx
  on public.document_archive_items (doc_type, source_guid, version desc);
create index if not exists document_archive_items_attention_idx
  on public.document_archive_items (updated_at desc) where failed or status <> 'notified';

create table if not exists public.document_archive_heartbeat (
  host             text primary key check (length(host) between 1 and 64),
  drive_state      text not null check (drive_state in
                     ('connected', 'disconnected', 'needs_reauth', 'identity_mismatch', 'not_private', 'disabled')),
  drive_checked_at timestamptz,
  mode             text not null check (mode in ('dry-run', 'drive', 'live')),
  last_success_at  timestamptz,
  pending_count    int not null default 0 check (pending_count >= 0),
  failed_count     int not null default 0 check (failed_count >= 0),
  worker_version   text not null default '' check (length(worker_version) <= 40),
  reported_at      timestamptz not null default now()
);

create table if not exists public.document_archive_retry_requests (
  id           bigserial primary key,
  job_id       text not null references public.document_archive_items (job_id) on delete restrict,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  consumed_at  timestamptz
);

create unique index if not exists document_archive_retry_one_open
  on public.document_archive_retry_requests (job_id) where consumed_at is null;

alter table public.document_archive_items enable row level security;
alter table public.document_archive_heartbeat enable row level security;
alter table public.document_archive_retry_requests enable row level security;

revoke all on public.document_archive_items, public.document_archive_heartbeat,
  public.document_archive_retry_requests from public, anon, authenticated;
revoke all on sequence public.document_archive_retry_requests_id_seq from public, anon, authenticated;
grant select on public.document_archive_items, public.document_archive_heartbeat,
  public.document_archive_retry_requests to authenticated;
-- service_role (دالة Edge) يقرأ ويكتب؛ صريحة هنا ولا تعتمد على الصلاحيات الافتراضية للمشروع.
grant select, insert, update on public.document_archive_items, public.document_archive_heartbeat,
  public.document_archive_retry_requests to service_role;
grant usage on sequence public.document_archive_retry_requests_id_seq to service_role;

drop policy if exists document_archive_items_owner_read on public.document_archive_items;
create policy document_archive_items_owner_read on public.document_archive_items
  for select to authenticated using (public.is_owner());
drop policy if exists document_archive_heartbeat_owner_read on public.document_archive_heartbeat;
create policy document_archive_heartbeat_owner_read on public.document_archive_heartbeat
  for select to authenticated using (public.is_owner());
drop policy if exists document_archive_retry_owner_read on public.document_archive_retry_requests;
create policy document_archive_retry_owner_read on public.document_archive_retry_requests
  for select to authenticated using (public.is_owner());

-- ─── upsert مهمة واحدة بلا خفض: الحالة لا تعود للخلف، وmessage_id/file_id لا يُمسحان ───
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

-- ─── تقرير العامل (عبر دالة Edge بدور service_role) ───
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

  for v_item in select value from jsonb_array_elements(v_items) loop
    perform private.document_archive_upsert_item(v_item || jsonb_build_object('host', p_report ->> 'host'), v_now);
  end loop;

  -- طلبات المالك المفتوحة: تُسلَّم مرة واحدة وتُعلَّم مستهلكة في المعاملة نفسها.
  with taken as (
    update public.document_archive_retry_requests r
       set consumed_at = v_now
     where r.consumed_at is null
    returning r.job_id
  )
  select coalesce(jsonb_agg(job_id), '[]'::jsonb) into v_retry from taken;

  return jsonb_build_object('items', jsonb_array_length(v_items), 'retry_job_ids', v_retry);
end;
$$;

revoke all on function public.document_archive_ingest_report(jsonb) from public, anon, authenticated;
grant execute on function public.document_archive_ingest_report(jsonb) to service_role;

-- ─── تسجيل إشعار تيليغرام بعد الإرسال (دالة Edge بدور service_role) ───
create or replace function public.document_archive_record_notification(p_item jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(p_item ->> 'telegram_message_id', '') is null then
    raise exception 'document_archive: telegram_message_id required' using errcode = '22023';
  end if;
  perform private.document_archive_upsert_item(p_item || '{"status":"notified","failed":false}'::jsonb, now());
end;
$$;

revoke all on function public.document_archive_record_notification(jsonb) from public, anon, authenticated;
grant execute on function public.document_archive_record_notification(jsonb) to service_role;

-- ─── طلب إعادة محاولة من المالك وحده ───
create or replace function public.request_document_archive_retry(p_job_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.document_archive_items%rowtype;
begin
  if not coalesce(public.is_owner(), false) then
    raise exception 'document_archive: owner only' using errcode = '42501';
  end if;
  select * into v_item from public.document_archive_items where job_id = p_job_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if not v_item.failed then
    return jsonb_build_object('ok', false, 'reason', 'not_failed');
  end if;
  insert into public.document_archive_retry_requests (job_id, requested_by)
  values (p_job_id, auth.uid())
  on conflict (job_id) where consumed_at is null do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.request_document_archive_retry(text) from public, anon;
grant execute on function public.request_document_archive_retry(text) to authenticated;

commit;
