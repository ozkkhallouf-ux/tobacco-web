-- proposed/16-price-sync-heartbeats.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** لا يجدول cron ولا يرسل شيئاً ولا يمسّ
-- inventory_reports أو ameen_price_sync_status أو أي تنبيه قائم.
--
-- الغرض: جدول مستقل لنبض مزامنة الأسعار (الموقع ← الأمين) — حادثة 2026-10-18. يكتبه
-- tools/publish-price-sync-heartbeat.ps1 ويقرؤه src/price-sync-health.js.
--
-- لماذا لا inventory_reports (قرار المالك، خيار B، ومراجعة Codex P1 على #332):
--   * inventory_reports يقبل الإدراج من أي موظف (is_staff())، فيستطيع مستخدم عادي للموقع تزوير
--     حالة HEALTHY.
--   * عليه trigger «تقرير الجرد اليومي» (telegram-notifications.sql) يُطلق إشعاراً كاذباً مع أول نبض
--     كل يوم ويستهلك مفتاح dedupe اليوم فيكتم الإشعار الحقيقي.
--
-- الضمانات:
--   * لا كتابة مباشرة لأي دور: revoke all من public وanon وauthenticated وservice_role، وRLS مفعّلة
--     ومفروضة (force) بلا أي سياسة INSERT/UPDATE/DELETE.
--   * الكتابة الوحيدة عبر public.record_price_sync_heartbeat(jsonb) — SECURITY DEFINER — ولا تقبل إلا:
--       - هوية المزامنة المعتمدة (auth.uid() = حساب المزامنة نفسه الذي يكتب ameen_price_sync_status
--         ومعظم مصادر الأمين: 9724dbe4-…، بنمط *_is_sync_writer القائم)، أو
--       - service_role (الاحتياط الحالي في سكربتات Windows حين لا تتوفر بيانات حساب المزامنة).
--     أي مستخدم آخر للموقع، ولو كان موظفاً أو مالكاً، يُرفض بـ 42501.
--   * «النجاح» يحتاج إثباتاً على الخادم: outcome ∈ {applied, no_changes} يُرفض ما لم يحمل اتصالاً
--     مثبتاً بالأمين (ameen_contact_at)، وفحصاً مستقلاً بلا فروق (verify.mismatches = 0 و
--     verify.missing = 0)، وتطبيقاً فعلياً (applied_wholesale ≥ 1)، وصفر تعارض وصفر صنف مفقود.
--   * زمن الحداثة من ساعة الخادم: received_at = now() لا يرسله العميل؛ والمصنِّف يعتمد عليه.
--     الطوابع الزمنية التي يرسلها العميل تُرفض إن كانت مستقبلية بأكثر من 5 دقائق.
--   * القراءة: الموظفون فقط (is_staff()) — نفس من يرى صفحة الأسعار اليوم.
--   * حجم الحمولة ≤ 16KB، والاحتفاظ 30 يوماً (تنظيف داخل دالة الكتابة نفسها).
--
-- لا يمسّ: inventory_reports، ameen_price_sync_status، notify_telegram، أي cron، أي دالة قائمة.
-- يُشغَّل كطلب واحد (معاملة ضمنية) أو `psql --single-transaction`. التراجع:
-- 16-price-sync-heartbeats-rollback.sql. الاختبار الأمني: supabase/tests/price-sync-heartbeats-security.sql
-- (يشغّله scripts/check-price-sync-heartbeats-security.mjs على PostgreSQL محلي في CI).

do $pre$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'proposed/16 requires public.is_staff()';
  end if;
  if to_regprocedure('auth.uid()') is null or to_regprocedure('auth.jwt()') is null then
    raise exception 'proposed/16 requires auth.uid() and auth.jwt()';
  end if;
end
$pre$;

-- ── الجدول ───────────────────────────────────────────────────────────────────────────────────

create table if not exists public.price_sync_heartbeats (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),          -- ساعة الخادم؛ مصدر الحداثة الوحيد
  writer_id   uuid,                                          -- auth.uid() لهوية المزامنة؛ null = service_role
  kind        text not null check (kind in ('attempt', 'task_probe')),
  host        text not null check (char_length(host) between 1 and 120),
  occurred_at timestamptz not null,                          -- ما يعلنه العميل (للعرض فقط)
  outcome     text check (outcome is null or outcome in (
                'applied', 'no_changes', 'pull_failed', 'ameen_unreachable', 'apply_failed',
                'verify_failed', 'verify_mismatch', 'applied_with_conflicts', 'preview_only')),
  summary     jsonb not null check (jsonb_typeof(summary) = 'object'),
  constraint price_sync_heartbeats_outcome_matches_kind check ((kind = 'attempt') = (outcome is not null)),
  constraint price_sync_heartbeats_summary_size check (pg_column_size(summary) <= 16384)
);

create index if not exists price_sync_heartbeats_received_at_idx
  on public.price_sync_heartbeats (received_at desc);

comment on table public.price_sync_heartbeats is
  'نبض مزامنة الأسعار (proposed/16). الكتابة عبر record_price_sync_heartbeat فقط؛ القراءة للموظفين.';

alter table public.price_sync_heartbeats enable row level security;
alter table public.price_sync_heartbeats force row level security;

revoke all on table public.price_sync_heartbeats from public, anon, authenticated, service_role;
grant select on table public.price_sync_heartbeats to authenticated;

drop policy if exists "staff can read price sync heartbeats" on public.price_sync_heartbeats;
create policy "staff can read price sync heartbeats"
  on public.price_sync_heartbeats
  for select
  to authenticated
  using ((select public.is_staff()));

-- ── هوية المزامنة المعتمدة ───────────────────────────────────────────────────────────────────

create or replace function public.price_sync_is_sync_writer()
returns boolean
language sql
stable
set search_path = ''
as $$
  select (select auth.uid()) = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid;
$$;

revoke all on function public.price_sync_is_sync_writer() from public, anon;
grant execute on function public.price_sync_is_sync_writer() to authenticated, service_role;

-- ── دالة الكتابة الوحيدة ──────────────────────────────────────────────────────────────────────

create or replace function public.record_price_sync_heartbeat(p_summary jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_service boolean := coalesce((select auth.jwt()) ->> 'role', '') = 'service_role';
  v_writer     uuid    := (select auth.uid());
  v_kind       text;
  v_outcome    text;
  v_host       text;
  v_occurred   timestamptz;
  v_verify     jsonb;
  v_task       jsonb;
  v_id         bigint;
begin
  if not v_is_service and not public.price_sync_is_sync_writer() then
    raise exception 'record_price_sync_heartbeat is restricted to the trusted sync identity'
      using errcode = '42501';
  end if;

  if p_summary is null or jsonb_typeof(p_summary) <> 'object' then
    raise exception 'heartbeat summary must be a JSON object' using errcode = '22023';
  end if;
  if pg_column_size(p_summary) > 16384 then
    raise exception 'heartbeat summary too large' using errcode = '22023';
  end if;
  if coalesce(p_summary ->> 'schema', '') <> 'price-sync-heartbeat/v1' then
    raise exception 'unsupported heartbeat schema' using errcode = '22023';
  end if;

  v_kind := p_summary ->> 'kind';
  v_host := nullif(btrim(coalesce(p_summary ->> 'host', '')), '');
  if v_kind not in ('attempt', 'task_probe') then
    raise exception 'unsupported heartbeat kind' using errcode = '22023';
  end if;
  if v_host is null or char_length(v_host) > 120 then
    raise exception 'heartbeat host is required' using errcode = '22023';
  end if;

  begin
    v_occurred := case v_kind
      when 'attempt' then (p_summary ->> 'attempt_finished_at')::timestamptz
      else (p_summary ->> 'probed_at')::timestamptz
    end;
  exception when others then
    raise exception 'heartbeat timestamp is invalid' using errcode = '22007';
  end;
  if v_occurred is null then
    raise exception 'heartbeat timestamp is required' using errcode = '22023';
  end if;
  if v_occurred > now() + interval '5 minutes' then
    raise exception 'heartbeat timestamp is in the future' using errcode = '22023';
  end if;

  if v_kind = 'attempt' then
    v_outcome := p_summary ->> 'outcome';
    if v_outcome is null or v_outcome not in (
         'applied', 'no_changes', 'pull_failed', 'ameen_unreachable', 'apply_failed',
         'verify_failed', 'verify_mismatch', 'applied_with_conflicts', 'preview_only') then
      raise exception 'unsupported heartbeat outcome' using errcode = '22023';
    end if;

    -- النجاح يعني وصول الأسعار فعلياً إلى الأمين: لا يُقبل بلا إثبات.
    -- الأرقام تُقرأ فقط إن كانت JSON numbers؛ غير ذلك = null فيُرفض (لا تحويل نصوص قد يرمي خطأً آخر).
    if v_outcome in ('applied', 'no_changes') then
      v_verify := p_summary -> 'verify';
      if nullif(p_summary ->> 'ameen_contact_at', '') is null
         or jsonb_typeof(v_verify) is distinct from 'object'
         or (case when jsonb_typeof(v_verify -> 'mismatches') = 'number' then (v_verify ->> 'mismatches')::numeric end) is distinct from 0
         or (case when jsonb_typeof(v_verify -> 'missing') = 'number' then (v_verify ->> 'missing')::numeric end) is distinct from 0
         or coalesce((case when jsonb_typeof(p_summary -> 'applied_wholesale') = 'number' then (p_summary ->> 'applied_wholesale')::numeric end), 0) < 1
         or coalesce(jsonb_typeof(p_summary -> 'conflict_count'), 'null') not in ('number', 'null')
         or coalesce(jsonb_typeof(p_summary -> 'not_in_ameen'), 'null') not in ('number', 'null')
         or (case when jsonb_typeof(p_summary -> 'conflict_count') = 'number' then (p_summary ->> 'conflict_count')::numeric else 0 end) <> 0
         or (case when jsonb_typeof(p_summary -> 'not_in_ameen') = 'number' then (p_summary ->> 'not_in_ameen')::numeric else 0 end) <> 0 then
        raise exception 'success outcome requires proof that prices reached Ameen'
          using errcode = '22023';
      end if;
    end if;
  else
    v_task := p_summary -> 'task';
    if jsonb_typeof(v_task) is distinct from 'object'
       or jsonb_typeof(v_task -> 'enabled') is distinct from 'boolean'
       or jsonb_typeof(v_task -> 'exists') is distinct from 'boolean' then
      raise exception 'task probe requires task.exists and task.enabled' using errcode = '22023';
    end if;
  end if;

  insert into public.price_sync_heartbeats (writer_id, kind, host, occurred_at, outcome, summary)
  values (case when v_is_service then null else v_writer end, v_kind, v_host, v_occurred, v_outcome, p_summary)
  returning id into v_id;

  delete from public.price_sync_heartbeats where received_at < now() - interval '30 days';

  return v_id;
end;
$$;

revoke all on function public.record_price_sync_heartbeat(jsonb) from public, anon;
grant execute on function public.record_price_sync_heartbeat(jsonb) to authenticated, service_role;

comment on function public.record_price_sync_heartbeat(jsonb) is
  'proposed/16: يسجّل نبض مزامنة الأسعار. هوية المزامنة أو service_role فقط؛ النجاح يحتاج إثبات وصول الأسعار للأمين.';

notify pgrst, 'reload schema';
