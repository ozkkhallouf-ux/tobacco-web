-- ============================================================
-- khalil_audit_log
-- توثيق أفعال خليل (Ameen UserGUID = 9A5FE33A-720C-493B-8A13-CE33EE5A008E,
-- الجهاز OZKUSER) اعتماداً على log000 الحقيقي داخل الأمين (event-driven،
-- بلا polling على بيانات غير مُعلَّمة). هذا الملف لا يمس قاعدة الأمين
-- إطلاقاً — فقط Supabase. صلاحيات خليل داخل الأمين تُعدَّل يدوياً من شاشة
-- المستخدمين، وليس عبر SQL.
--
-- الضمانات المطلوبة:
--  1. cursor آمن ضد تساوي LogTime: عمودان (last_log_time, last_log_guid)،
--     تقدُّم يحترم ORDER BY LogTime, GUID عبر مقارنة صف (row-value) فلا
--     يضيع أي حدث عند تعدد سجلات بنفس اللحظة.
--  2. khalil_audit_events سجل Audit غير قابل للتعديل من مسار الإشعارات:
--     لا عمود telegram_status داخله، التسليم بالكامل عبر telegram_outbox
--     الموجودة (dedupe_key = ameen_log_guid)، وفشل تيليجرام لا يغيّر ولا
--     يحذف أي صف هنا (الـtrigger لا يكتب رجوعاً إلى الجدول نفسه).
--  3. أقل صلاحية: لا SELECT لـanon/authenticated العاديين؛ الكتابة فقط عبر
--     دالة SECURITY DEFINER محروسة بهوية المزامنة الموثوقة الوحيدة
--     (نفس UUID الثابت 9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3 المستخدم فعلياً
--     في ameen_daily_profit_is_sync_writer وبقية دوال sync writer بالمشروع)
--     + حارس صريح أن ameen_user_guid = خليل بالضبط، فلا يمكن لأي مستخدم
--     آخر أن يُنسب سجله لخليل حتى لو استدعى الدالة بهوية المزامنة نفسها.
-- ============================================================

-- ------------------------------------------------------------
-- 1) جدول الـAudit نفسه — immutable من خارج الدالة SECURITY DEFINER.
-- ------------------------------------------------------------
create table if not exists public.khalil_audit_events (
  id bigint generated always as identity primary key,
  ameen_log_guid uuid not null,
  ameen_log_time timestamp not null,
  ameen_user_guid uuid not null,
  ameen_user_login text,
  device text,
  operation text,
  operation_type smallint,
  rec_num text,
  type_guid uuid,
  invoice_number text,
  invoice_guid uuid,
  before_snapshot jsonb,
  after_snapshot jsonb,
  financial_delta numeric,
  notes text,
  recorded_at timestamptz not null default now()
);

create unique index if not exists khalil_audit_events_log_guid_uidx
  on public.khalil_audit_events (ameen_log_guid);

create index if not exists khalil_audit_events_user_time_idx
  on public.khalil_audit_events (ameen_user_guid, ameen_log_time desc);

create index if not exists khalil_audit_events_invoice_idx
  on public.khalil_audit_events (invoice_guid);

comment on table public.khalil_audit_events is
  'سجل Audit غير قابل للتعديل لأفعال خليل داخل الأمين (مصدره log000). '
  'الكتابة حصراً عبر record_khalil_audit_event؛ التسليم عبر telegram_outbox '
  'المنفصل فلا يتأثر هذا الجدول بفشل الإرسال.';

alter table public.khalil_audit_events enable row level security;

-- لا SELECT/INSERT/UPDATE/DELETE مباشر لأي دور — القراءة فقط عبر سياسة
-- is_owner أدناه، والكتابة فقط عبر الدالة SECURITY DEFINER.
revoke all on public.khalil_audit_events from public, anon, authenticated, service_role;

create policy "owners can read khalil audit events"
  on public.khalil_audit_events
  for select
  to authenticated
  using (public.is_owner());

grant select on public.khalil_audit_events to authenticated;

-- ------------------------------------------------------------
-- 2) cursor مقاوم لتساوي LogTime — صف وحيد (id = 1)، بلا أي منح مباشر
--    (يُقرأ ويُكتب فقط عبر الدوال SECURITY DEFINER أدناه).
-- ------------------------------------------------------------
create table if not exists public.khalil_audit_cursor (
  id smallint primary key default 1,
  last_log_time timestamp,
  last_log_guid uuid,
  updated_at timestamptz not null default now(),
  constraint khalil_audit_cursor_singleton check (id = 1)
);

comment on table public.khalil_audit_cursor is
  'صف وحيد يخزّن (last_log_time, last_log_guid) لمزامنة log000 → '
  'khalil_audit_events. التقدّم بمقارنة صف كاملة يحترم ORDER BY LogTime, '
  'GUID فلا يضيع أي حدث متزامن اللحظة.';

alter table public.khalil_audit_cursor enable row level security;
revoke all on public.khalil_audit_cursor from public, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3) هوية المزامنة الموثوقة — نفس النمط ونفس الـUUID الحي فعلياً
--    (ameen_daily_profit_is_sync_writer وبقية sync writer functions).
-- ------------------------------------------------------------
create or replace function public.khalil_audit_is_sync_writer()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (select auth.uid()) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid;
$$;

revoke all on function public.khalil_audit_is_sync_writer()
  from public, anon, service_role;
grant execute on function public.khalil_audit_is_sync_writer()
  to authenticated;

-- ------------------------------------------------------------
-- 4) قراءة الـcursor (SECURITY DEFINER — لا منح مباشر على الجدول نفسه).
-- ------------------------------------------------------------
create or replace function public.get_khalil_audit_cursor()
returns table (last_log_time timestamp, last_log_guid uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'get_khalil_audit_cursor requires an authenticated caller';
  end if;
  if not public.khalil_audit_is_sync_writer() then
    raise exception 'get_khalil_audit_cursor is restricted to the trusted sync identity';
  end if;

  return query
    select c.last_log_time, c.last_log_guid
    from public.khalil_audit_cursor c
    where c.id = 1;
end;
$$;

revoke all on function public.get_khalil_audit_cursor() from public;
grant execute on function public.get_khalil_audit_cursor() to authenticated, service_role;
revoke all on function public.get_khalil_audit_cursor() from anon;

-- ------------------------------------------------------------
-- 5) تسجيل حدث واحد + تقديم الـcursor بأمان — الدالة الوحيدة القادرة على
--    الكتابة في khalil_audit_events وkhalil_audit_cursor.
--    idempotent عبر on conflict على ameen_log_guid: إعادة تشغيل السكربت
--    بنفس الحدث لا تُنشئ صفاً مكرراً ولا تُطلق trigger الإشعار مرة ثانية
--    (لأن AFTER INSERT لا يطلَق عند ON CONFLICT DO NOTHING).
-- ------------------------------------------------------------
create or replace function public.record_khalil_audit_event(
  p_ameen_log_guid uuid,
  p_ameen_log_time timestamp,
  p_ameen_user_guid uuid,
  p_ameen_user_login text,
  p_device text,
  p_operation text,
  p_operation_type smallint,
  p_rec_num text,
  p_type_guid uuid,
  p_invoice_number text,
  p_invoice_guid uuid,
  p_before_snapshot jsonb,
  p_after_snapshot jsonb,
  p_financial_delta numeric,
  p_notes text
) returns public.khalil_audit_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.khalil_audit_events;
  -- GUID خليل الحقيقي في us000 — ثابت مقصود، وليس سراً (معرّف سجل لا كلمة
  -- مرور). أي p_ameen_user_guid غير هذا يُرفض هنا مهما كانت هوية المزامنة،
  -- فلا يمكن نسب فعل مستخدم آخر لسجل خليل.
  v_khalil_guid constant uuid := '9A5FE33A-720C-493B-8A13-CE33EE5A008E';
begin
  if auth.uid() is null then
    raise exception 'record_khalil_audit_event requires an authenticated caller';
  end if;
  if not public.khalil_audit_is_sync_writer() then
    raise exception 'record_khalil_audit_event is restricted to the trusted sync identity';
  end if;
  if p_ameen_user_guid is distinct from v_khalil_guid then
    raise exception 'record_khalil_audit_event only accepts events for the Khalil Ameen user';
  end if;

  insert into public.khalil_audit_events (
    ameen_log_guid, ameen_log_time, ameen_user_guid, ameen_user_login,
    device, operation, operation_type, rec_num, type_guid,
    invoice_number, invoice_guid, before_snapshot, after_snapshot,
    financial_delta, notes
  ) values (
    p_ameen_log_guid, p_ameen_log_time, p_ameen_user_guid, p_ameen_user_login,
    p_device, p_operation, p_operation_type, p_rec_num, p_type_guid,
    p_invoice_number, p_invoice_guid, p_before_snapshot, p_after_snapshot,
    p_financial_delta, p_notes
  )
  on conflict (ameen_log_guid) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- الحدث موجود مسبقاً (إعادة تشغيل السكربت) — أعِد الصف الموجود بدل
    -- الفشل، لضمان استجابة متسقة للسكربت المستدعي.
    select * into v_row from public.khalil_audit_events where ameen_log_guid = p_ameen_log_guid;
  end if;

  -- تقديم الـcursor بمقارنة صف كاملة: لا يتراجع أبداً، ولا يتخطى أي حدث
  -- بنفس اللحظة (يحترم ORDER BY LogTime, GUID المستخدم في القراءة).
  insert into public.khalil_audit_cursor (id, last_log_time, last_log_guid, updated_at)
  values (1, p_ameen_log_time, p_ameen_log_guid, now())
  on conflict (id) do update set
    last_log_time = excluded.last_log_time,
    last_log_guid = excluded.last_log_guid,
    updated_at = now()
  where khalil_audit_cursor.last_log_time is null
     or (excluded.last_log_time, excluded.last_log_guid)
        >= (khalil_audit_cursor.last_log_time, khalil_audit_cursor.last_log_guid);

  return v_row;
end;
$$;

revoke all on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text
) from public;
grant execute on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text
) to authenticated, service_role;
revoke all on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text
) from anon;

-- ------------------------------------------------------------
-- 6) trigger الإشعار — يقرأ فقط NEW.*، ولا يكتب إلى khalil_audit_events
--    (يبقى الجدول immutable من مسار الإشعارات). التسليم الفعلي والـretry
--    عبر telegram_outbox القائمة أصلاً (dispatch_telegram_outbox / pg_cron)
--    — فشل تيليجرام لا يغيّر شيئاً هنا، فقط يبقى الصف في outbox لإعادة
--    المحاولة. notify_telegram يُخوَّل تلقائياً هنا عبر pg_trigger_depth() > 0
--    (نفس المسار المعتمد في telegram-notifications.sql، بلا حاجة لأي منح
--    إضافي).
-- ------------------------------------------------------------
create or replace function public.tg_notify_khalil_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message text;
begin
  v_message := format(
    E'🕵️ حدث خليل\nالعملية: %s\nالفاتورة: %s\nالوقت: %s\nالجهاز: %s%s',
    coalesce(new.operation, 'غير محدد'),
    coalesce(new.invoice_number, new.rec_num, 'غير معروفة'),
    to_char(new.ameen_log_time, 'YYYY-MM-DD HH24:MI:SS'),
    coalesce(new.device, 'غير معروف'),
    case when new.financial_delta is not null
      then format(E'\nالفرق المالي: %s', new.financial_delta)
      else ''
    end
  );

  -- dedupe_key = ameen_log_guid (فريد لكل حدث فعلياً) → إشعار واحد بالضبط
  -- لكل صف يُدرج فعلياً هنا (on conflict do nothing في الدالة أعلاه يمنع
  -- أي إعادة إدراج تُطلق هذا الـtrigger من جديد لنفس الحدث).
  perform public.notify_telegram(
    'khalil_audit_event',
    v_message,
    new.ameen_log_guid::text,
    1
  );

  return new;
end;
$$;

drop trigger if exists khalil_audit_events_notify on public.khalil_audit_events;
create trigger khalil_audit_events_notify
  after insert on public.khalil_audit_events
  for each row execute function public.tg_notify_khalil_audit_event();

-- دالة trigger فقط — تنفيذها لا يحتاج EXECUTE من أي دور (Postgres يستدعيها
-- داخلياً عند AFTER INSERT بلا فحص صلاحية)، وترك EXECUTE ممنوحاً لـ
-- anon/authenticated كان يسمح باستدعائها مباشرة عبر
-- /rest/v1/rpc/tg_notify_khalil_audit_event (رصدته get_advisors).
revoke all on function public.tg_notify_khalil_audit_event()
  from public, anon, authenticated, service_role;
