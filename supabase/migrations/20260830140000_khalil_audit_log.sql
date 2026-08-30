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
  -- Codex P1، 2026-08-30، جولة ٤: أول تشغيل بعد تسجيل المهمة (أو أي تشغيل
  -- يلحق تاريخاً كبيراً بعد توقّف طويل) قد يعالج حتى BatchSize=200 حدث
  -- تاريخي دفعة واحدة، وكل حدث كان يُطلق إشعار تيليجرام فورياً رغم أن موزّع
  -- outbox يرسل 20 رسالة/دقيقة فقط — فيُحجب إشعارات العمل الحقيقية (دفعات،
  -- طلبات، إلخ) خلف مئات إشعارات "خليل" القديمة. is_backfill يُسجَّل بالسكربت
  -- حين يكون عمر الحدث (LogTime) أقدم من نافذة قصيرة (15 دقيقة)، ويقرأه
  -- الـtrigger أدناه ليتجاوز notify_telegram لهذا الصف فقط — الصف نفسه يبقى
  -- محفوظاً بكامل تفاصيله في سجل الـAudit، فقط بلا إشعار فوري له.
  is_backfill boolean not null default false,
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
  -- Codex P1، 2026-08-30، جولة ٧: يُضبَط مرة واحدة فقط — لحظة إنشاء هذا
  -- الصف لأول مرة على الإطلاق (أول حدث يُسجَّل بعد تفعيل صلاحيات خليل).
  -- سكربت المزامنة يستخدمه كحدّ ثابت ودائم لتمييز "تاريخ سابق للمراقبة
  -- الحيّة" عن "حدث حيّ حقيقي"، بدل الاعتماد على غياب الـcursor فقط —
  -- الذي كان يصف أول دفعة فقط، فتُعامَل بقية سجل الباك-فيل (بعد BatchSize
  -- صف) كأحداث حيّة في التشغيلات التالية وتُغرِق طابور تيليجرام (20
  -- رسالة/دقيقة). القيمة لا تُعدَّل أبداً بعد الإدراج الأول (غير مذكورة في
  -- on conflict do update أدناه)، فتبقى صامدة عبر كل الدفعات اللاحقة مهما
  -- طال تفريغ التاريخ المتراكم.
  backfill_before timestamp,
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
returns table (last_log_time timestamp, last_log_guid uuid, backfill_before timestamp)
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
    select c.last_log_time, c.last_log_guid, c.backfill_before
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
  p_notes text,
  p_is_backfill boolean default false
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
    financial_delta, notes, is_backfill
  ) values (
    p_ameen_log_guid, p_ameen_log_time, p_ameen_user_guid, p_ameen_user_login,
    p_device, p_operation, p_operation_type, p_rec_num, p_type_guid,
    p_invoice_number, p_invoice_guid, p_before_snapshot, p_after_snapshot,
    p_financial_delta, p_notes, coalesce(p_is_backfill, false)
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
  -- backfill_before تُضبَط فقط عند إدراج الصف الوحيد لأول مرة (now()، أي
  -- لحظة أول حدث يُسجَّل على الإطلاق) — عمداً غير مذكورة في do update set
  -- كي لا تُلمَس بعد ذلك أبداً، فتبقى حدّاً ثابتاً عبر كل الدفعات اللاحقة
  -- (Codex P1، جولة ٧).
  insert into public.khalil_audit_cursor (id, last_log_time, last_log_guid, updated_at, backfill_before)
  values (1, p_ameen_log_time, p_ameen_log_guid, now(), now())
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
  jsonb, jsonb, numeric, text, boolean
) from public;
grant execute on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text, boolean
) to authenticated, service_role;
revoke all on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text, boolean
) from anon;

-- ------------------------------------------------------------
-- 6-أ) شبكة أمان مستقلة تماماً عن telegram_outbox (Codex P1، 2026-08-30،
--    جولة ٥): المحاولة الاحتياطية في الـtrigger أدناه كانت تكتب إلى
--    telegram_outbox نفسها — لو كان العطل الأصلي في notify_telegram سببه
--    telegram_outbox نفسه (قفل/جدول معطوب)، فالمحاولة الاحتياطية تفشل أيضاً
--    بنفس السبب، ويُفقَد الإشعار للأبد فعلياً: صفّ الـAudit له GUID فريد
--    (on conflict do nothing)، فلا يُعاد إدراجه أبداً ولن يُطلَق هذا الـ
--    trigger AFTER INSERT ثانيةً لنفس الحدث. هذا الجدول المخصّص + دالة
--    إعادة المحاولة أدناه (private.retry_khalil_audit_notify_failures،
--    مجدولة بـpg_cron) يشكّلان مساراً مستقلاً كلياً عن telegram_outbox:
--    حتى لو تعطّل telegram_outbox نفسه مؤقتاً، هذا الجدول يبقى نقطة حفظ
--    موثوقة يُعاد منها محاولة الإدراج في telegram_outbox لاحقاً عند تعافيه.
--    لا يخالف هذا ضمان "الـtrigger لا يكتب رجوعاً إلى khalil_audit_events"
--    (البند 13 أعلى الملف) لأن هذا جدول منفصل تماماً، لا يُعدَّل
--    khalil_audit_events نفسه إطلاقاً من أي مسار إشعار.
-- ------------------------------------------------------------
create schema if not exists private;

create table if not exists public.khalil_audit_notify_failures (
  id bigint generated always as identity primary key,
  ameen_log_guid uuid not null unique,
  message text not null,
  first_failed_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  resolved_at timestamptz
);

comment on table public.khalil_audit_notify_failures is
  'شبكة أمان مستقلة عن telegram_outbox لإشعارات تدقيق خليل التي فشلت '
  'مرتين (notify_telegram + الإدراج الاحتياطي بـtelegram_outbox معاً) — '
  'تُعاد محاولتها دورياً عبر private.retry_khalil_audit_notify_failures.';

alter table public.khalil_audit_notify_failures enable row level security;
revoke all on public.khalil_audit_notify_failures from public, anon, authenticated, service_role;

-- دالة مساعدة SECURITY DEFINER تُستدعى من الـtrigger أدناه — best-effort
-- بالكامل: أي فشل هنا (حتى لو نادر جداً) يُبتلع بتحذير فقط، فلا يمكن لهذا
-- المسار الاحتياطي نفسه أن يُسقط معاملة تسجيل حدث الـAudit إطلاقاً.
create or replace function private.record_khalil_audit_notify_failure(
  p_ameen_log_guid uuid,
  p_message text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.khalil_audit_notify_failures (ameen_log_guid, message)
  values (p_ameen_log_guid, p_message)
  on conflict (ameen_log_guid) do update set
    last_attempt_at = now(),
    attempts = public.khalil_audit_notify_failures.attempts + 1,
    resolved_at = null;
exception
  -- Codex P1، 2026-08-30، جولة ٦: QUERY_CANCELED مستثنى عمداً من OTHERS في
  -- PL/pgSQL — لو هذا الإدراج انتظر على قفل حتى statement_timeout أو أُلغي،
  -- بدون هذا الفرع الصريح كان الإلغاء سيتسرب من هذه الدالة نفسها ويُسقط
  -- معاملة تسجيل حدث الـAudit والـcursor. best-effort مطابق لفرع OTHERS.
  when query_canceled then
    raise warning 'khalil_audit: notify-failure recorder canceled for ameen_log_guid=%',
      p_ameen_log_guid;
  when others then
    raise warning 'khalil_audit: could not record notify failure for ameen_log_guid=%: %',
      p_ameen_log_guid, sqlerrm;
end;
$$;

revoke all on function private.record_khalil_audit_notify_failure(uuid, text)
  from public, anon, authenticated, service_role;

-- دالة إعادة محاولة دورية (pg_cron) — مستقلة تماماً عن مسار الـtrigger،
-- تعمل فقط حين يتعافى telegram_outbox. best-effort لكل صف على حدة: فشل
-- صف واحد لا يوقف بقية الصفوف، ولا يُسقط أي شيء آخر بالنظام.
create or replace function private.retry_khalil_audit_notify_failures()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r record;
begin
  for r in
    select * from public.khalil_audit_notify_failures
    where resolved_at is null
    order by first_failed_at
    limit 100
  loop
    begin
      if not exists (
        select 1 from public.telegram_outbox
        where dedupe_key = r.ameen_log_guid::text
          and created_at > now() - interval '1 minute'
      ) then
        insert into public.telegram_outbox (event_type, message, dedupe_key)
        values ('khalil_audit_event', r.message, r.ameen_log_guid::text);
      end if;
      update public.khalil_audit_notify_failures
        set resolved_at = now()
        where id = r.id;
    exception
      when others then
        update public.khalil_audit_notify_failures
          set last_attempt_at = now(), attempts = attempts + 1
          where id = r.id;
        raise warning 'khalil_audit: retry of notify failure id=% (ameen_log_guid=%) failed again: %',
          r.id, r.ameen_log_guid, sqlerrm;
    end;
  end loop;
end;
$$;

revoke all on function private.retry_khalil_audit_notify_failures()
  from public, anon, authenticated, service_role;

do $$ declare old_job bigint; begin
  for old_job in select jobid from cron.job where jobname='retry-khalil-audit-notify-failures'
  loop perform cron.unschedule(old_job); end loop;
  perform cron.schedule('retry-khalil-audit-notify-failures', '*/5 * * * *',
    'select private.retry_khalil_audit_notify_failures();');
end $$;

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
  -- Codex P1، 2026-08-30، جولة ٤: صفوف backfill (is_backfill=true، انظر
  -- تعليق العمود أعلاه) تبقى محفوظة بكامل تفاصيلها في khalil_audit_events —
  -- فقط لا تُطلِق إشعار تيليجرام فورياً هنا، لتفادي إغراق طابور الإرسال
  -- (20 رسالة/دقيقة) بمئات الأحداث التاريخية على حساب التنبيهات الحيّة.
  if new.is_backfill then
    return new;
  end if;

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
  --
  -- ملاحظة أمنية/موثوقية (Codex P1، 2026-08-30): هذا الـtrigger يعمل داخل
  -- نفس معاملة record_khalil_audit_event. أي استثناء غير مُلتقَط من
  -- notify_telegram (مثلاً عطل بجدول telegram_outbox أو دالة الإرسال) كان
  -- سيُسقط الـtransaction كاملةً، فيُحذف صفّ الـAudit وتراجع الـcursor —
  -- ما يخالف صراحةً "فشل Telegram لا يغير أو يحذف Audit Event". الحل: كتلة
  -- exception محلية تلتقط أي خطأ من مسار الإشعار فقط (savepoint ضمني من
  -- plpgsql) ولا تدع الفشل يتسرب خارج الـtrigger أبداً — صفّ الـAudit
  -- وتقدّم الـcursor يبقيان مضمونين بغضّ النظر عن نتيجة notify_telegram.
  begin
    perform public.notify_telegram(
      'khalil_audit_event',
      v_message,
      new.ameen_log_guid::text,
      1
    );
  exception
    -- ملاحظة أمنية/موثوقية إضافية (Codex P1، 2026-08-30، جولة ٢): exception
    -- when others لا يلتقط QUERY_CANCELED (Postgres يستثنيها عمداً من فئة
    -- OTHERS لأنها إشارة إدارية). لو انتهت مهلة statement_timeout أثناء
    -- notify_telegram تحديداً (لا أثناء بقية الدالة)، كانت ستتسرب خارج هذه
    -- الكتلة وتُسقط نفس المعاملة رغم أن صف الـAudit نفسه أُدرج بنجاح سلفاً —
    -- نفس الخرق الذي عولج أعلاه لكن عبر مسار استثناء مختلف. معالجة صريحة هنا
    -- تُبقي إسقاط الإشعار فقط دون أي أثر على صف الـAudit أو الـcursor.
    when query_canceled then
      raise warning 'khalil_audit: notify_telegram canceled/timed out for ameen_log_guid=%',
        new.ameen_log_guid;
      -- ملاحظة أمنية/موثوقية إضافية (Codex P1، 2026-08-30، جولة ٣): سابقاً
      -- التحذير فقط كان يعني ضياع الإشعار للأبد — صفّ الـAudit مُدرَج أصلاً
      -- بـon conflict (ameen_log_guid) do nothing، فلا يُعاد إدراجه أبداً
      -- لاحقاً، وهذا الـtrigger AFTER INSERT لن يُطلَق ثانيةً لنفس الحدث —
      -- لا يوجد أي مسار retry. الإصلاح: محاولة إدراج احتياطي مباشر في
      -- telegram_outbox (تجاوز notify_telegram نفسها) كي يلتقطه
      -- dispatch_telegram_outbox() بالـcron العادي كأي رسالة أخرى، حتى لو
      -- كان العطل داخل notify_telegram نفسها لا في الجدول. لو فشل هذا
      -- الاحتياطي أيضاً (مثلاً الجدول نفسه معطوب)، نكتفي بتحذير إضافي دون
      -- أي أثر آخر على صفّ الـAudit أو الـcursor.
      begin
        if not exists (
          select 1 from public.telegram_outbox
          where dedupe_key = new.ameen_log_guid::text
            and created_at > now() - interval '1 minute'
        ) then
          insert into public.telegram_outbox (event_type, message, dedupe_key)
          values ('khalil_audit_event', left(v_message, 3900), new.ameen_log_guid::text);
        end if;
      -- Codex P1، 2026-08-30، جولة ٤ (finding a): نفس ثغرة QUERY_CANCELED
      -- المذكورة أعلاه، لكن هنا داخل محاولة الإدراج الاحتياطي بالـoutbox
      -- نفسها — لو انتهت مهلة statement_timeout أثناء هذا الإدراج تحديداً
      -- (وليس أثناء notify_telegram)، exception when others وحدها كانت
      -- ستدع QUERY_CANCELED يتسرب من هنا فيُسقط نفس المعاملة رغم أن صف
      -- الـAudit مُدرَج أصلاً. معالجة صريحة تُبقي الأثر الوحيد تحذيراً.
      -- Codex P1، 2026-08-30، جولة ٥: لو فشلت هذه المحاولة الاحتياطية أيضاً
      -- (مثلاً لأن telegram_outbox نفسه هو سبب العطل الأصلي)، تحذير فقط كان
      -- يعني ضياع الإشعار للأبد فعلياً (انظر البند 6-أ أعلاه). الآن نسجّل
      -- الفشل في جدول khalil_audit_notify_failures المستقل تماماً عن
      -- telegram_outbox، ليعيد private.retry_khalil_audit_notify_failures
      -- محاولة التسليم لاحقاً عند تعافي outbox.
      exception
        when query_canceled then
          raise warning 'khalil_audit: fallback telegram_outbox insert canceled/timed out for ameen_log_guid=%',
            new.ameen_log_guid;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
        when others then
          raise warning 'khalil_audit: fallback telegram_outbox insert also failed for ameen_log_guid=%: %',
            new.ameen_log_guid, sqlerrm;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
      end;
    when others then
      raise warning 'khalil_audit: notify_telegram failed for ameen_log_guid=%: %',
        new.ameen_log_guid, sqlerrm;
      begin
        if not exists (
          select 1 from public.telegram_outbox
          where dedupe_key = new.ameen_log_guid::text
            and created_at > now() - interval '1 minute'
        ) then
          insert into public.telegram_outbox (event_type, message, dedupe_key)
          values ('khalil_audit_event', left(v_message, 3900), new.ameen_log_guid::text);
        end if;
      exception
        when query_canceled then
          raise warning 'khalil_audit: fallback telegram_outbox insert canceled/timed out for ameen_log_guid=%',
            new.ameen_log_guid;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
        when others then
          raise warning 'khalil_audit: fallback telegram_outbox insert also failed for ameen_log_guid=%: %',
            new.ameen_log_guid, sqlerrm;
          perform private.record_khalil_audit_notify_failure(new.ameen_log_guid, left(v_message, 3900));
      end;
  end;

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

-- ------------------------------------------------------------
-- 7) heartbeat مزامنة خليل — جدول مخصّص، وليس public.inventory_reports
--    (Codex P1، 2026-08-30، جولة ٤، findings b + d):
--    b) أي موظف مصادَق (authenticated) كان قادراً على الكتابة مباشرة على
--       inventory_reports عبر REST بـsource='khalil_audit_sync_heartbeat'
--       منتحلاً صفة سكربت المزامنة — نفس ثغرة inventory_reports العامة
--       الموثّقة سلفاً في supabase/ameen-warehouse-stock-reports.sql (وُجدت
--       أول مرة عبر Codex على PR #40 الجولة ٢). الإصلاح هنا هو نفس النمط:
--       جدول مخصّص بصلاحية INSERT محصورة بهوية المزامنة الموثوقة فقط.
--    d) inventory_reports له trigger غير مشروط (tg_notify_inventory_report
--       في telegram-notifications.sql) يُطلِق إشعار "📦 وصل تقرير الجرد
--       اليومي" ويحجز dedupe_key = 'inventory:<date>' لمدة 1200 دقيقة عند
--       أول إدراج بأي تاريخ — أي heartbeat كتب هناك أولاً كان يُسكِت إشعار
--       الجرد الحقيقي طوال ذلك اليوم. جدول منفصل تماماً يزيل هذا التداخل.
-- ------------------------------------------------------------
create table if not exists public.khalil_audit_sync_heartbeat (
  id bigint generated by default as identity primary key,
  status text not null default 'ok',
  found_count integer not null default 0,
  processed_count integer not null default 0,
  ran_at timestamptz not null,
  computer text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.khalil_audit_sync_heartbeat enable row level security;

revoke all on public.khalil_audit_sync_heartbeat from public, anon, authenticated, service_role;
grant select, insert on public.khalil_audit_sync_heartbeat to authenticated;

create policy "owners can read khalil audit heartbeat"
  on public.khalil_audit_sync_heartbeat for select
  to authenticated
  using (public.is_staff());

-- يعيد استخدام نفس دالة هوية المزامنة الموثوقة (UUID ثابت
-- 9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3) المعرّفة أعلاه لـ
-- khalil_audit_events نفسه — نفس الهوية التي تكتب أحداث التدقيق تكتب
-- الـheartbeat أيضاً، فلا حاجة لدالة sync-writer منفصلة.
create policy "only sync writer can insert khalil audit heartbeat"
  on public.khalil_audit_sync_heartbeat for insert
  to authenticated
  with check (public.khalil_audit_is_sync_writer() and created_by = auth.uid());

-- لا سياسة UPDATE أو DELETE: الـheartbeat سجل تاريخي يُقرأ فقط لغرض
-- المراقبة (private.monitor_project_tasks يقرأ آخر created_at)، ولا حاجة
-- لتعديله أو حذفه من أي دور تطبيقي.
