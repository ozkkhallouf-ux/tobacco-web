-- ============================================================================
-- 26: إشعار تيليغرام لأرشفة المستندات «مرة واحدة على الأكثر» — حجز ذرّي قبل الإرسال.
--
-- الحالة: مقترحة، غير مطبَّقة. التطبيق بموافقة صريحة من المالك فقط، وقبل نشر نسخة
-- document-archive-notify التي تستدعي document_archive_claim_send (الدالة القديمة تبقى
-- تعمل على هذا المخطط بلا تغيير، والجديدة تفشل مغلقة بلا إرسال إن غاب).
-- التراجع: 26-document-archive-send-claim-rollback.sql.
--
-- الثغرة (تدقيق المرحلة 6): الدالة كانت «افحص ثم أرسل ثم سجّل»، والفحص والإرسال غير
-- ذرّيين، والإرسال يسبق أي أثر دائم. فتتكرر الرسالة حين:
--   أ) يصل طلبان للمهمة نفسها معاً (العامل يقطع الطلب بعد 120ث ويعيده والأول ما زال يعمل)؛
--   ب) يصل تيليغرام ثم يفشل التسجيل كلياً؛
--   ج) تتوقف الدالة بين الإرسال والتسجيل؛
--   د) يُحيي العامل المهمة «الفاشلة» كل ساعة فيعيد (ب) أو (ج) بلا حد.
--
-- المبدأ Fail Closed: غياب رسالة واحدة أهون من تكرارها. حالة الإرسال على السجل نفسه:
--   null       لم يُحجز إرسال
--   sending    حجز قائم (send_claim_id): لا يُرسل غيره
--   sent       له telegram_message_id: لا إرسال أبداً، يُعاد الرقم نفسه
--   uncertain  حجز تجاوز 15 دقيقة بلا رقم رسالة: ربما وصلت وربما لا ⇒ لا إرسال تلقائي
--              أبداً، تنبيه واحد للمالك، والإعادة بطلبه الصريح وحده
--
-- الأمن كما في 22: الدوال الجديدة لـservice_role وحده، وإعادة الإرسال للمالك وحده.
-- لا حذف ولا تعديل لأي صف قائم عدا ملء send_state='sent' لما له رقم رسالة.
-- ============================================================================

begin;

alter table public.document_archive_items
  add column if not exists send_state      text check (send_state in ('sending', 'sent', 'uncertain')),
  add column if not exists send_claim_id   uuid,
  add column if not exists send_claimed_at timestamptz;

-- ما أُرسل قبل هذه الهجرة (رقم رسالة مسجَّل) يُعلَّم مرسَلاً، فلا يُحجز له إرسال ثانٍ.
update public.document_archive_items
   set send_state = 'sent'
 where telegram_message_id is not null and send_state is distinct from 'sent';

create index if not exists document_archive_items_sending_idx
  on public.document_archive_items (send_claimed_at) where send_state = 'sending';

-- ─── upsert 22 بلا تغيير، إلا: رقم رسالة (قائم أو قادم) ⇒ send_state='sent' ───
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
    telegram_message_id, telegram_sent_at, attempts, last_error, host, created_at, updated_at, send_state)
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
    p_now, p_now,
    case when nullif(p_item ->> 'telegram_message_id', '') is not null then 'sent' end)
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
    updated_at = p_now,
    -- رقم الرسالة يحسم الحالة الغامضة أيضاً: العامل يبلّغ الرقم الذي استلمه فلا تنبيه كاذب.
    send_state = case when coalesce(t.telegram_message_id, excluded.telegram_message_id) is not null
                      then 'sent' else t.send_state end
  -- الهوية ثابتة: نفس job_id بمصدر أو نسخة مختلفة = خطأ لا يُكتب فوقه.
  where t.source_guid = excluded.source_guid
    and t.version = excluded.version
    and t.version_hash = excluded.version_hash
    and t.doc_type = excluded.doc_type;
end;
$$;

revoke all on function private.document_archive_upsert_item(jsonb, timestamptz) from public, anon, authenticated;

-- ─── حجز تجاوز المهلة بلا رقم رسالة ⇒ uncertain + تنبيه واحد للمالك ───
-- يُستدعى من الحجز نفسه ومن كل تقرير للعامل (كل 5 دقائق)، فلا يحتاج cron.
create or replace function private.document_archive_mark_uncertain(p_job_id text default null)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_count int := 0;
begin
  for v_row in
    update public.document_archive_items
       set send_state = 'uncertain', updated_at = now()
     where send_state = 'sending'
       and telegram_message_id is null
       and send_claimed_at < now() - interval '15 minutes'
       and (p_job_id is null or job_id = p_job_id)
    returning job_id, doc_number, doc_date, version
  loop
    v_count := v_count + 1;
    if to_regprocedure('public.notify_telegram(text,text,text,integer)') is not null then
      perform public.notify_telegram(
        'document_archive',
        format(E'⚠️ إشعار أرشفة الفاتورة رقم %s (%s، نسخة %s) قد يكون وصل أو لم يصل.\n'
               'لن يُعاد إرساله تلقائياً منعاً للتكرار. تحقّق من المحادثة، وأعد إرساله يدوياً إن لم يصل.',
               v_row.doc_number, v_row.doc_date, v_row.version),
        'document-archive-uncertain:' || v_row.job_id,
        10080);
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.document_archive_mark_uncertain(text) from public, anon, authenticated;

-- ─── الحجز قبل الإرسال (دالة Edge بدور service_role) ───
-- النتيجة:
--   claimed            لا إرسال سابق ولا حجز: الإرسال لك وحدك بهذا الحجز
--   duplicate          أُرسل سابقاً: message_id نفسه، بلا إرسال
--   in_flight          حجز آخر قائم منذ أقل من 15 دقيقة: لا إرسال
--   uncertain          حجز قديم بلا رقم، أو حالة غامضة: لا إرسال أبداً
--   identity_conflict  job_id نفسه بمصدر/نسخة/بصمة مختلفة: لا إرسال
create or replace function public.document_archive_claim_send(p_item jsonb, p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job text := p_item ->> 'job_id';
  v_row public.document_archive_items%rowtype;
begin
  if p_claim_id is null or v_job is null then
    raise exception 'document_archive: job_id and claim_id required' using errcode = '22023';
  end if;

  -- السجل موجود قبل القفل (العامل قد لم يبلّغ عنه بعد). لا يخفض الحالة ولا يمسّ رقم رسالة.
  begin
    perform private.document_archive_upsert_item(
      (p_item - 'telegram_message_id') || '{"status":"uploaded","failed":false}'::jsonb, now());
  exception when unique_violation then
    return jsonb_build_object('result', 'identity_conflict');
  end;

  select * into v_row from public.document_archive_items where job_id = v_job for update;
  if not found
     or v_row.source_guid is distinct from (p_item ->> 'source_guid')::uuid
     or v_row.version is distinct from (p_item ->> 'version')::int
     or v_row.version_hash is distinct from (p_item ->> 'version_hash')
     or v_row.doc_type is distinct from (p_item ->> 'doc_type') then
    return jsonb_build_object('result', 'identity_conflict');
  end if;

  if v_row.telegram_message_id is not null then
    return jsonb_build_object('result', 'duplicate', 'message_id', v_row.telegram_message_id);
  end if;

  if v_row.send_state = 'sending' then
    if v_row.send_claimed_at >= now() - interval '15 minutes' then
      return jsonb_build_object('result', 'in_flight');
    end if;
    perform private.document_archive_mark_uncertain(v_job);
    return jsonb_build_object('result', 'uncertain');
  end if;

  if v_row.send_state = 'uncertain' then
    return jsonb_build_object('result', 'uncertain');
  end if;

  update public.document_archive_items
     set send_state = 'sending', send_claim_id = p_claim_id, send_claimed_at = now(), updated_at = now()
   where job_id = v_job;
  return jsonb_build_object('result', 'claimed');
end;
$$;

revoke all on function public.document_archive_claim_send(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.document_archive_claim_send(jsonb, uuid) to service_role;

-- ─── تحرير الحجز: تيليغرام رفض صراحةً (ردّ ok:false) فلم يُسلَّم شيء ───
-- بحجز هذا الطلب نفسه وحده، وما لم يُسجَّل رقم رسالة.
create or replace function public.document_archive_release_send(p_job_id text, p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.document_archive_items
     set send_state = null, send_claim_id = null, send_claimed_at = null, updated_at = now()
   where job_id = p_job_id
     and send_state = 'sending'
     and send_claim_id = p_claim_id
     and telegram_message_id is null;
  return found;
end;
$$;

revoke all on function public.document_archive_release_send(text, uuid) from public, anon, authenticated;
grant execute on function public.document_archive_release_send(text, uuid) to service_role;

-- ─── تقرير العامل: 22 بلا تغيير، إلا أنه يحسم الحجوزات المنتهية أولاً ───
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
  -- العناصر أولاً: رقم رسالة يبلّغه العامل يحسم الحجز قبل أن يُعدّ غامضاً.
  for v_item in select value from jsonb_array_elements(v_items) loop
    begin
      perform private.document_archive_upsert_item(v_item || jsonb_build_object('host', p_report ->> 'host'), v_now);
    exception when unique_violation then
      v_rejected := v_rejected + 1;
    end;
  end loop;

  perform private.document_archive_mark_uncertain(null);

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

-- ─── إعادة إرسال إشعار غامض: المالك وحده، بعد أن يتحقق بنفسه أنه لم يصل ───
-- تفك الحالة الغامضة وتطلب من العامل محاولة جديدة (عبر طابور الإعادة القائم).
create or replace function public.request_document_archive_resend(p_job_id text)
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
  select * into v_item from public.document_archive_items where job_id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_item.telegram_message_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_sent');
  end if;
  if v_item.send_state is distinct from 'uncertain' then
    return jsonb_build_object('ok', false, 'reason', 'not_uncertain');
  end if;
  update public.document_archive_items
     set send_state = null, send_claim_id = null, send_claimed_at = null, updated_at = now()
   where job_id = p_job_id;
  insert into public.document_archive_retry_requests (job_id, requested_by)
  values (p_job_id, auth.uid())
  on conflict (job_id) where consumed_at is null do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.request_document_archive_resend(text) from public, anon;
grant execute on function public.request_document_archive_resend(text) to authenticated;

commit;
