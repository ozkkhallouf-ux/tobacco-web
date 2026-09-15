-- ============================================================
-- khalil_audit_log — active-history base (version 20260830141802)
-- ============================================================
-- Production records this exact version + name:
--   version: 20260830141802
--   name:    khalil_audit_log
-- (confirmed via `supabase migration list`, read-only audit 2026-09-14).
--
-- Why this file exists
-- --------------------
-- 1) Close the remote-only history gap so `supabase db push` / Stage 2 is
--    not blocked by a production version with no matching local file.
--    `--include-all` does NOT fix remote-only (inverse) gaps.
-- 2) Provide replayable bootstrap DDL for fresh DB / CI migration replay.
--    An exception-only "objects must already exist" placeholder aborts every
--    clean replay at this version (Codex P1 on PR #228).
--
-- Provenance / non-claims (critical)
-- ----------------------------------
-- Bootstrap SQL below is derived from the local draft
-- `superseded/20260830140000_khalil_audit_log.sql` (evolved form expected by
-- `tools/push-khalil-audit-log.ps1` and later 09-02 migrations).
-- Byte-for-byte equivalence with the SQL Editor script that originally
-- produced production version 20260830141802 is NOT proven and is NOT
-- claimed.
--
-- Attribution nuance: git commit e2a81a6 created only the BASE objects
-- (events, cursor, record_khalil_audit_event). Heartbeat + notify_failures
-- were designed later on the same draft. Live catalog checks confirm those
-- tables exist on production; whether they were part of this stamp or
-- separate unrecorded SQL Editor applies is unproven. They are included in
-- the fresh-bootstrap path so later active migrations and the sync agent can
-- run on a clean database. This is bootstrap-for-replay, not a forensic claim.
--
-- Apply behavior / safety
-- -----------------------
-- - Normal production Stage 2: CLI sees version already recorded → skips file.
-- - If this file is somehow executed against a DB that already has the base
--   objects: the guard DO block raises and aborts before any bootstrap DDL
--   (history-safe refuse-to-reapply — no CREATE OR REPLACE of live functions).
-- - Fresh DB (base objects missing): guard passes; bootstrap DDL runs.
-- - Auth helpers (Codex P1, 2026-09-15): `public.is_owner()` is provisioned on
--   the fresh path from `supabase/owner-role-access.sql` before owner policies
--   (not invented). `public.is_staff()` has no definition in active migration
--   history — only out-of-band / non-migration SQL — so the heartbeat SELECT
--   policy is deferred (NOTICE) when that helper is absent; RLS + revoke still
--   deny direct reads. Production already has both helpers and skips this file.
-- - No FORCE ROW LEVEL SECURITY. No migration repair. This commit alone does
--   not authorize applying SQL to production.
-- ============================================================

do $guard$
declare
  v_has_base boolean;
begin
  v_has_base :=
    to_regclass('public.khalil_audit_events') is not null
    and to_regclass('public.khalil_audit_cursor') is not null
    and exists (
      select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = 'record_khalil_audit_event'
    );

  if v_has_base then
    raise exception
      'khalil_audit_log (20260830141802): base objects already present — refusing bootstrap DDL re-apply (history-safe). On production this version should already be recorded so the CLI skips this file; do not run it manually against a live database.';
  end if;

  raise notice 'khalil_audit_log (20260830141802): base objects missing — running fresh-DB bootstrap DDL derived from superseded draft (not proven identical to original production SQL Editor apply).';
end;
$guard$;

-- ----- fresh-DB bootstrap DDL (reached only when guard above passes) -----

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
  -- Codex P1، 2026-08-31، جولة ١٠ ("Quarantine empty-content events instead
  -- of blocking the cursor"): كان GUARD السكربت يوقف الـpipeline بالكامل
  -- للأبد عند أول صف OperationType محتوى (2/3/100) يصل RecContent فارغاً منه
  -- — رغم أن تعليق السكربت نفسه يوثّق أن هذا يحدث فعلاً (>99% وليس 100% من
  -- هذه الصفوف تحمل محتوى)، أي صف طبيعي واحد كهذا كان يُجمِّد كل أحداث خليل
  -- اللاحقة إلى الأبد. الحل: عمود حالة صريح بدل الحجب — 'ok' = محتوى طبيعي
  -- ومُعالَج، 'no_content_expected' = OperationType لا يحمل محتوى أصلاً
  -- (فتح/عرض/إغلاق)، 'quarantined_empty_content' = كان يُفترض أن يحمل محتوى
  -- لكنه وصل فارغاً — يُسجَّل الحدث بلا snapshot بدل حجب الجميع، مع تنبيه
  -- منفصل غير حاجز عبر Notify-Failure.
  content_status text not null default 'ok'
    constraint khalil_audit_events_content_status_check
    check (content_status in ('ok', 'no_content_expected', 'quarantined_empty_content')),
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

-- ------------------------------------------------------------
-- Auth helper prerequisite (fresh-DB only — this block is never reached on
-- production Stage 2). Derived verbatim from supabase/owner-role-access.sql;
-- do not invent alternate owner semantics here.
-- ------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'owner';
$$;

comment on function public.is_owner() is
  'Owner authorization from immutable Auth app_metadata.role.';

revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

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
  -- Codex P1، 2026-08-30، جولة ٩: حد دائم (وليس زمنياً نسبياً لـ"الآن")
  -- لبداية نافذة إعادة مسح log000 بحثاً عن صفوف خليل التزمت متأخراً. سابقاً
  -- كان السكربت يحسب $overlapFrom = (Get-Date).AddMinutes(-$OverlapWindowMinutes)
  -- في كل تشغيل — لو توقّف السكربت/المهمة المجدولة أطول من هذه النافذة
  -- الثابتة (كما حصل فعلياً في عطل SQL Server مؤقت اليوم)، عند الاستئناف
  -- كانت النافذة تُحتسَب من "الآن" الجديد فتقفز فوق أي صف التزم متأخراً
  -- خلال الفجوة الأطول من النافذة، فيُفقَد للأبد بمجرد تقدّم الـcursor
  -- فوقه. هذا العمود يمثّل بدلاً من ذلك "كل ما قبل هذه اللحظة تم مسحه
  -- والتأكد أنه لا يحوي صفوفاً مفقودة فعلياً" — لا علاقة له بالساعة
  -- الحالية إطلاقاً، فبعد أي توقف مهما طال يستأنف السكربت المسح من نفس
  -- النقطة بالضبط. يتقدّم فقط عبر update_khalil_audit_overlap_floor أدناه،
  -- أحادي الاتجاه (لا يتراجع أبداً).
  overlap_floor_time timestamp,
  -- Codex P1، 2026-08-31، جولة ١٠ ("Track GUID when advancing a truncated
  -- overlap page"): overlap_floor_time وحده (بدون GUID) كان يكفي فقط حين لا
  -- يوجد أكثر من BatchSize صف بنفس LogTime بالضبط. لو تراكمت صفوف Khalil
  -- بنفس اللحظة تفوق BatchSize (مثلاً بعد توقف طويل)، كانت الصفحة تُقطَع عند
  -- BatchSize والحد يتقدّم فقط إلى ذلك LogTime المشترك — فيعيد التشغيل
  -- التالي `LogTime >= @OverlapFrom` نفس أول BatchSize صف للأبد (livelock)،
  -- ولا تصل الصفوف اللاحقة بنفس اللحظة ولا أي صف أحدث أبداً. هذا العمود
  -- يخزّن GUID آخر صف عولِج فعلاً ضمن نفس overlap_floor_time، فيستأنف
  -- الاستعلام بمقارنة صف (LogTime, GUID) تماماً كما يفعل last_log_guid
  -- للـcursor الرئيسي — بلا أي احتمال livelock أو تخطٍّ.
  overlap_floor_guid uuid,
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
returns table (
  last_log_time timestamp,
  last_log_guid uuid,
  backfill_before timestamp,
  overlap_floor_time timestamp,
  overlap_floor_guid uuid
)
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
    select c.last_log_time, c.last_log_guid, c.backfill_before, c.overlap_floor_time, c.overlap_floor_guid
    from public.khalil_audit_cursor c
    where c.id = 1;
end;
$$;

revoke all on function public.get_khalil_audit_cursor() from public;
grant execute on function public.get_khalil_audit_cursor() to authenticated, service_role;
revoke all on function public.get_khalil_audit_cursor() from anon;

-- ------------------------------------------------------------
-- 4-أ) تقديم (overlap_floor_time, overlap_floor_guid) — الدالة الوحيدة
--    القادرة على تعديل هذين العمودين. أحادية الاتجاه بحتة (لا تتراجع أبداً،
--    بمقارنة صف كاملة مثل last_log_time/last_log_guid)، ومقيَّدة بهوية
--    المزامنة الموثوقة فقط (Codex P1، 2026-08-30، جولة ٩؛ ممدَّدة بـGUID
--    جولة ١٠). التقييد بألا يتجاوز الحد نافذة زمنية دنيا خلف "الآن" (Codex
--    P1، جولة ١٠، "Keep rescanning ranges that can receive late commits")
--    مسؤولية السكربت المستدعي حصراً — عمداً وليس هنا: عزل SQL Server (حيث
--    تحدث الالتزامات المتأخرة فعلياً) عن ساعة Postgres يتجنّب أي خطأ فروق
--    توقيت بين الخادمين لو نُفِّذ الفحص هنا بدلاً من ذلك.
-- ------------------------------------------------------------
create or replace function public.update_khalil_audit_overlap_floor(
  p_floor timestamp,
  p_floor_guid uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- قيمة حارسة تمثّل "الأدنى الممكن" حين يكون GUID الحد غير معروف بالضبط
  -- (مثلاً حد مُقيَّد زمنياً وليس مأخوذاً من صف حقيقي) — تجعل المقارنة أدناه
  -- تعامله دوماً كأنه *قبل* أي GUID حقيقي بنفس اللحظة، فلا يُفلِت أي صف عبر
  -- الخطأ (يُعاد فحصه بأمان idempotent بدل تخطيه).
  v_min_guid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  if auth.uid() is null then
    raise exception 'update_khalil_audit_overlap_floor requires an authenticated caller';
  end if;
  if not public.khalil_audit_is_sync_writer() then
    raise exception 'update_khalil_audit_overlap_floor is restricted to the trusted sync identity';
  end if;
  if p_floor is null then
    return;
  end if;

  -- الصف (id=1) يجب أن يكون موجوداً أصلاً (ينشئه record_khalil_audit_event
  -- عند أول حدث) — لو لم يوجد بعد فلا معنى لتقديم حد overlap قبل وجود أي
  -- cursor أصلاً، فنكتفي بعدم الفعل بدل الفشل.
  update public.khalil_audit_cursor
     set overlap_floor_time = p_floor,
         overlap_floor_guid = p_floor_guid,
         updated_at = now()
   where id = 1
     and (
       overlap_floor_time is null
       or (p_floor, coalesce(p_floor_guid, v_min_guid))
          > (overlap_floor_time, coalesce(overlap_floor_guid, v_min_guid))
     );
end;
$$;

revoke all on function public.update_khalil_audit_overlap_floor(timestamp, uuid)
  from public, anon, service_role;
grant execute on function public.update_khalil_audit_overlap_floor(timestamp, uuid)
  to authenticated;

-- الدالة القديمة أحادية المعامل (جولة ٩) لم تعد مستخدَمة — السكربت يستدعي
-- النسخة ثنائية المعامل حصراً الآن. تُحذَف صراحة (وليس ترك overload معلَّق)
-- كي لا يبقى مسار قديم يتجاوز حراسة الـGUID الجديدة بالخطأ.
drop function if exists public.update_khalil_audit_overlap_floor(timestamp);

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
  p_is_backfill boolean default false,
  -- Codex P1، 2026-08-31، جولة ١٠: انظر تعليق عمود content_status أعلاه.
  p_content_status text default 'ok',
  -- Codex P1، 2026-08-31، جولة ١٤ ("Use the Ameen clock for the persisted
  -- backfill boundary"): ساعة SQL Server المحلية للأمين (مصدر LogTime) قد
  -- تنجرف عن ساعة Postgres UTC. سابقاً backfill_before كانت تُضبَط دوماً
  -- بـ now() الخاصة بـPostgres عند أول صف يُسجَّل — فتُقارَن لاحقاً في
  -- PowerShell مباشرة مع LogTime المحلي للأمين بلا أي تحويل، فأي انحراف
  -- ساعة (حتى لو دقائق) يُصنِّف صفوفاً تاريخية فعلياً كـ"حيّة" فتُغرِق طابور
  -- تيليجرام بمئات التنبيهات. الإصلاح: السكربت يمرّر ساعة الأمين نفسها
  -- (SELECT GETDATE() من نفس اتصال SQL Server) كـp_ameen_scan_time، وتُستخدَم
  -- هي حصراً لضبط backfill_before بدل now() — يبقى now() احتياطاً فقط لتوافق
  -- استدعاءات قديمة لا تمرّر هذه القيمة.
  p_ameen_scan_time timestamp default null
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
    financial_delta, notes, is_backfill, content_status
  ) values (
    p_ameen_log_guid, p_ameen_log_time, p_ameen_user_guid, p_ameen_user_login,
    p_device, p_operation, p_operation_type, p_rec_num, p_type_guid,
    p_invoice_number, p_invoice_guid, p_before_snapshot, p_after_snapshot,
    p_financial_delta, p_notes, coalesce(p_is_backfill, false),
    coalesce(p_content_status, 'ok')
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
  values (1, p_ameen_log_time, p_ameen_log_guid, now(), coalesce(p_ameen_scan_time, now()))
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
  jsonb, jsonb, numeric, text, boolean, text, timestamp
) from public;
grant execute on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text, boolean, text, timestamp
) to authenticated, service_role;
revoke all on function public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text, boolean, text, timestamp
) from anon;

-- التوقيع القديم (١٦ معاملاً، بلا p_content_status، جولة ٧) لم يعد
-- مستخدَماً — السكربت يستدعي التوقيع الجديد (١٧ معاملاً) حصراً الآن. يُحذَف
-- صراحة كي لا يبقى overload قديم يتجاوز تصنيف content_status الجديد.
drop function if exists public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text, boolean
);

-- التوقيع الأقدم (١٧ معاملاً، بلا p_ameen_scan_time، جولة ١٠) لم يعد
-- مستخدَماً — السكربت يستدعي التوقيع الجديد (١٨ معاملاً) حصراً الآن (جولة
-- ١٤). يُحذَف صراحة لنفس سبب الحذف أعلاه.
drop function if exists public.record_khalil_audit_event(
  uuid, timestamp, uuid, text, text, text, smallint, text, uuid, text, uuid,
  jsonb, jsonb, numeric, text, boolean, text
);

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

-- SELECT policy gates on public.is_staff(). That helper is NOT defined in
-- active migration history (only referenced from out-of-band SQL such as
-- approved-prices-table.sql / ameen-*-reports.sql). Inventing staff_allowlist
-- semantics here would violate the no-invented-auth rule. Defer when absent:
-- RLS stays enabled and grants alone do not bypass missing SELECT policies.
do $staff_read_policy$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise notice
      'khalil_audit_log (20260830141802): public.is_staff() absent — deferring SELECT policy "owners can read khalil audit heartbeat" (RLS deny-by-default retained; apply staff_allowlist/is_staff out-of-band then recreate policy if needed).';
  else
    execute $p$
      create policy "owners can read khalil audit heartbeat"
        on public.khalil_audit_sync_heartbeat for select
        to authenticated
        using (public.is_staff())
    $p$;
  end if;
end;
$staff_read_policy$;

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
