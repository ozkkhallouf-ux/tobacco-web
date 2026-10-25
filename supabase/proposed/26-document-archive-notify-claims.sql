-- ============================================================================
-- 26: إشعار أرشفة المستندات «مرة واحدة على الأكثر» — حجز ذرّي قبل إرسال تيليغرام.
--
-- الحالة: مقترحة، غير مطبَّقة. التطبيق بموافقة صريحة من المالك فقط، وقبل نشر نسخة
-- document-archive-notify التي تستدعي هذه الدوال (الدالة بلا هذه الهجرة تفشل مغلقة: 502 بلا إرسال).
-- التراجع: 26-document-archive-notify-claims-rollback.sql (لا يمسّ جداول 22 ولا ملفات Drive).
--
-- الثغرة التي تُغلقها (22 كانت «مرة على الأقل»):
--   * طلبان متزامنان للمهمة نفسها (مهلة العامل 120ث ثم إعادة بينما الأول ما زال يرسل)
--     يقرآن «لا message_id» معاً فيرسلان مرتين.
--   * وصل المستند لكن ضاع ردّ تيليغرام (انقطاع، مهلة، جسم غير مقروء) ⇒ 502 بلا تسجيل ⇒ إعادة.
--   * وصل وسُجّل الرد لكن فشل التسجيل وقُتل العامل قبل تقريره ⇒ إعادة.
--
-- القاعدة: لا sendDocument إلا بحجز ناجح لـjob_id. الحجز صف واحد بمفتاح أساسي، فطلبان
-- متزامنان لا يحجزان معاً. نتيجة الإرسال:
--   sent      ⇒ message_id محفوظ؛ كل طلب لاحق يعيده بلا إرسال.
--   not_sent  ⇒ رفض صريح من تيليغرام (ok=false): released، وإعادة العامل تحجز من جديد.
--   unknown   ⇒ لا نعرف إن وصل: لا إعادة تلقائية أبداً. المالك وحده يحرّرها بطلب إعادة
--               محاولة من الموقع (request_document_archive_retry) بعد أن يتحقق من تيليغرام.
-- حجز «sending» تجاوز مهلته (العملية ماتت في منتصف الإرسال) يصير unknown لا released.
--
-- تنبيه المالك: كل انتقال إلى unknown يضع رسالة نصية واحدة في telegram_outbox عبر
-- notify_telegram (مفتاح منع تكرار لكل مهمة، 24 ساعة): «إرسال غير محسوم» مع وصف المستند
-- وما يفعله. نص فقط، لا PDF، فالتنبيه لا يكرر المستند. فشل التنبيه لا يغيّر حالة الحجز.
--
-- الأمن: RLS والقراءة للمالك وحده كجداول 22؛ الكتابة عبر الدوال بدور service_role وحده.
-- لا حذف: التحرير حالة released لا إزالة صف، ولا cron ولا cascade.
-- ============================================================================

begin;

create schema if not exists private;

create table if not exists public.document_archive_notify_claims (
  job_id      text primary key check (job_id ~ '^[0-9a-f]{32}$'),
  state       text not null check (state in ('sending', 'sent', 'unknown', 'released')),
  claim_token uuid not null,
  claimed_at  timestamptz not null default now(),
  attempts    int not null default 1 check (attempts >= 1),
  message_id  bigint,
  resolved_at timestamptz,
  last_error  text check (last_error is null or length(last_error) <= 80),
  label       text check (label is null or length(label) <= 200),
  alerted_at  timestamptz,
  check (state <> 'sent' or message_id is not null)
);

alter table public.document_archive_notify_claims enable row level security;
revoke all on public.document_archive_notify_claims from public, anon, authenticated;
grant select on public.document_archive_notify_claims to authenticated;
grant select, insert, update on public.document_archive_notify_claims to service_role;

drop policy if exists document_archive_notify_claims_owner_read on public.document_archive_notify_claims;
create policy document_archive_notify_claims_owner_read on public.document_archive_notify_claims
  for select to authenticated using (public.is_owner());

-- ─── تنبيه «غير محسوم» للمالك (نص عبر telegram_outbox) ───
-- لا يرمي أبداً: غياب notify_telegram أو فشلها لا يُسقط انتقال الحالة.
create or replace function private.document_archive_alert_unknown(p_job_id text, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
begin
  select coalesce(nullif(label, ''), 'مستند أرشفة') into v_label
    from public.document_archive_notify_claims where job_id = p_job_id;
  if to_regproc('public.notify_telegram') is null then
    return false;
  end if;
  perform public.notify_telegram(
    'document_archive_unknown',
    '⚠️ أرشفة الفواتير: إرسال غير محسوم' || chr(10)
      || v_label || chr(10)
      || 'لم يتأكد وصول ملف PDF إلى تيليغرام (' || coalesce(p_reason, 'unknown') || ')، ولن يُعاد إرساله تلقائياً.' || chr(10)
      || 'إن وصلك المستند فلا تفعل شيئاً. وإن لم يصل فاطلب إعادة المحاولة لهذه المهمة.' || chr(10)
      || 'المهمة: ' || left(p_job_id, 12),
    'document-archive-unknown:' || p_job_id,
    1440);
  update public.document_archive_notify_claims set alerted_at = now() where job_id = p_job_id;
  return true;
exception when others then
  return false;
end;
$$;

revoke all on function private.document_archive_alert_unknown(text, text) from public, anon, authenticated;

-- ─── الحجز قبل الإرسال ───
-- يعيد {status: claimed|sent|in_progress|unknown, token?, message_id?}.
create or replace function public.document_archive_claim_notification(p_job_id text, p_lease_seconds int default 300, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim public.document_archive_notify_claims%rowtype;
  v_token uuid := gen_random_uuid();
  v_msg   bigint;
begin
  if p_job_id is null or p_job_id !~ '^[0-9a-f]{32}$' then
    raise exception 'document_archive: invalid job_id' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception 'document_archive: lease must be 60..3600 seconds' using errcode = '22023';
  end if;

  -- إشعار سُجّل قبل هذه الهجرة (أو بتقرير العامل) يبقى حارساً.
  select telegram_message_id into v_msg from public.document_archive_items where job_id = p_job_id;
  if v_msg is not null then
    insert into public.document_archive_notify_claims (job_id, state, claim_token, message_id, resolved_at)
    values (p_job_id, 'sent', v_token, v_msg, now())
    on conflict (job_id) do update set state = 'sent',
      message_id = coalesce(document_archive_notify_claims.message_id, excluded.message_id),
      resolved_at = coalesce(document_archive_notify_claims.resolved_at, excluded.resolved_at)
    returning * into v_claim;
    return jsonb_build_object('status', 'sent', 'message_id', v_claim.message_id);
  end if;

  insert into public.document_archive_notify_claims (job_id, state, claim_token, label)
  values (p_job_id, 'sending', v_token, left(p_label, 200))
  on conflict (job_id) do nothing;
  if found then
    return jsonb_build_object('status', 'claimed', 'token', v_token);
  end if;

  select * into v_claim from public.document_archive_notify_claims where job_id = p_job_id for update;
  if v_claim.state = 'sent' then
    return jsonb_build_object('status', 'sent', 'message_id', v_claim.message_id);
  elsif v_claim.state = 'released' then
    update public.document_archive_notify_claims
       set state = 'sending', claim_token = v_token, claimed_at = now(), attempts = attempts + 1,
           resolved_at = null, last_error = null, alerted_at = null, label = coalesce(left(p_label, 200), label)
     where job_id = p_job_id;
    return jsonb_build_object('status', 'claimed', 'token', v_token);
  elsif v_claim.state = 'sending' and v_claim.claimed_at > now() - make_interval(secs => p_lease_seconds) then
    return jsonb_build_object('status', 'in_progress');
  elsif v_claim.state = 'sending' then
    update public.document_archive_notify_claims
       set state = 'unknown', resolved_at = now(), last_error = 'lease_expired'
     where job_id = p_job_id;
    perform private.document_archive_alert_unknown(p_job_id, 'lease_expired');
  end if;
  return jsonb_build_object('status', 'unknown');
end;
$$;

revoke all on function public.document_archive_claim_notification(text, int, text) from public, anon, authenticated;
grant execute on function public.document_archive_claim_notification(text, int, text) to service_role;

-- ─── نتيجة الإرسال ───
-- بالرمز نفسه وحده. sent يُقبل أيضاً بعد أن صار الحجز unknown بانتهاء المهلة (الرد وصل متأخراً:
-- الحقيقة أفضل من الشك). not_sent وunknown لا يُقبلان إلا من sending.
create or replace function public.document_archive_finish_notification(
  p_job_id text, p_token uuid, p_outcome text, p_message_id bigint default null, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  if p_outcome = 'sent' then
    if p_message_id is null then
      raise exception 'document_archive: message_id required for sent' using errcode = '22023';
    end if;
    update public.document_archive_notify_claims
       set state = 'sent', message_id = p_message_id, resolved_at = now(), last_error = null
     where job_id = p_job_id and claim_token = p_token and state in ('sending', 'unknown');
  elsif p_outcome in ('not_sent', 'unknown') then
    update public.document_archive_notify_claims
       set state = case when p_outcome = 'not_sent' then 'released' else 'unknown' end,
           resolved_at = now(), last_error = left(p_error, 80)
     where job_id = p_job_id and claim_token = p_token and state = 'sending';
  else
    raise exception 'document_archive: outcome must be sent, not_sent or unknown' using errcode = '22023';
  end if;
  get diagnostics v_rows = row_count;
  if v_rows = 1 and p_outcome = 'unknown' then
    perform private.document_archive_alert_unknown(p_job_id, left(p_error, 80));
  end if;
  return jsonb_build_object('ok', v_rows = 1);
end;
$$;

revoke all on function public.document_archive_finish_notification(text, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.document_archive_finish_notification(text, uuid, text, bigint, text) to service_role;

-- ─── تحرير المجهول بطلب المالك ───
-- تستدعيها الدالة بـretry_job_ids التي سلّمها document_archive_ingest_report (طلبات المالك وحده).
-- لا تمسّ sent ولا sending.
create or replace function public.document_archive_release_notification_claims(p_job_ids text[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows int;
begin
  update public.document_archive_notify_claims
     set state = 'released', resolved_at = now(), last_error = 'owner_retry'
   where job_id = any (coalesce(p_job_ids, '{}')) and state = 'unknown';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function public.document_archive_release_notification_claims(text[]) from public, anon, authenticated;
grant execute on function public.document_archive_release_notification_claims(text[]) to service_role;

commit;
