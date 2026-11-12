-- Migration 30: التحكم بظهور الأصناف في نشرة الأسعار الموجهة للزبائن (طلب عمر 2026-11-12).
--
-- لماذا: المالك يريد إخفاء أصناف معيّنة عن الزبائن (بالموقع وPDF والطباعة والواتساب)
-- دون أي أثر على المخزون أو الأسعار أو الفواتير أو الأمين. لا وسيلة لذلك اليوم.
--
-- ما تفعله:
--   * جدول item_bulletin_visibility: سطر واحد لكل item_guid مخفي فقط — الحالة
--     الافتراضية لكل صنف غائب عن الجدول هي «ظاهر»، فالإظهار يحذف السطر بدل
--     تسجيل قيمة متقابلة.
--   * جدول item_bulletin_visibility_audit: سجل تدقيق إلحاقي لكل تغيير (إخفاء/
--     إظهار، السبب، من، متى).
--   * دالة set_item_bulletin_visibility للمالك وحده (is_owner). لا INSERT/
--     UPDATE/DELETE مباشر لأي دور.
--   * نافذة bulletin_hidden_items_feed (anon) لمولّد النشرات: item_key فقط
--     للأصناف المخفية ذات المخزون الموجب — نفس أصناف available_price_sync_feed
--     العامة أصلاً. لا سعر ولا تكلفة ولا GUID ولا سبب ولا بريد.
--
-- قواعد ثابتة:
--   * لا شيء هنا يقرأ الأمين أو يكتب فيه.
--   * لا يمسّ أي جدول قائم ولا أي سعر ولا أي مخزون — approved_price_items تُقرأ فقط في النافذة.
--   * لا بذر: لا توجد قواعد إخفاء سابقة لمراجعتها، فكل الأصناف تبقى ظاهرة كما هي اليوم.
--   * القراءة والكتابة: المالك وحده لكلا الجدولين.

begin;

do $$ begin
  if to_regclass('public.item_bulletin_visibility') is not null
     or to_regclass('public.item_bulletin_visibility_audit') is not null then
    raise exception 'migration 30 guard: already applied';
  end if;
end $$;

create table public.item_bulletin_visibility (
  item_guid text primary key
    check (item_guid ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'),
  item_key text not null default '' check (length(item_key) <= 200),
  item_name text not null default '' check (length(item_name) <= 200),
  reason text not null default '' check (length(reason) <= 300),
  updated_by uuid,
  updated_by_email text not null default '',
  updated_at timestamptz not null default now()
);

create table public.item_bulletin_visibility_audit (
  id bigint generated always as identity primary key,
  item_guid text not null,
  item_key text not null default '',
  item_name text not null default '',
  action text not null check (action in ('hide', 'show')),
  reason text not null default '',
  changed_by uuid,
  changed_by_email text not null default '',
  changed_at timestamptz not null default now()
);

create index item_bulletin_visibility_audit_guid_idx
  on public.item_bulletin_visibility_audit (item_guid, changed_at desc);

alter table public.item_bulletin_visibility enable row level security;
alter table public.item_bulletin_visibility force row level security;
alter table public.item_bulletin_visibility_audit enable row level security;
alter table public.item_bulletin_visibility_audit force row level security;

revoke all on table public.item_bulletin_visibility from public, anon, authenticated;
revoke all on table public.item_bulletin_visibility_audit from public, anon, authenticated;
grant select on table public.item_bulletin_visibility to authenticated;
grant select on table public.item_bulletin_visibility_audit to authenticated;

create policy item_bulletin_visibility_owner_select on public.item_bulletin_visibility
  for select to authenticated
  using ((select public.is_owner()));

create policy item_bulletin_visibility_audit_owner_select on public.item_bulletin_visibility_audit
  for select to authenticated
  using ((select public.is_owner()));

-- ---------------------------------------------------------------------------
-- الكتابة الوحيدة: المالك وحده، مع سطر تدقيق في المعاملة نفسها.
-- ---------------------------------------------------------------------------
create function public.set_item_bulletin_visibility(
  p_item_guid text, p_hidden boolean, p_item_key text, p_item_name text, p_reason text default ''
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_guid text := upper(btrim(coalesce(p_item_guid, ''), ' {}'));
  v_key text := left(btrim(coalesce(p_item_key, '')), 200);
  v_name text := left(btrim(coalesce(p_item_name, '')), 200);
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_was_hidden boolean;
begin
  if not public.is_owner() or auth.uid() is null then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_guid !~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' then
    raise exception 'invalid_item_guid';
  end if;
  if p_hidden is null then
    raise exception 'invalid_hidden';
  end if;
  if v_reason = '' then
    v_reason := case when p_hidden
      then 'إخفاء من شاشة إدارة نشرة الأسعار'
      else 'إظهار من شاشة إدارة نشرة الأسعار'
    end;
  end if;

  select true into v_was_hidden from public.item_bulletin_visibility where item_guid = v_guid for update;
  v_was_hidden := coalesce(v_was_hidden, false);

  if p_hidden then
    insert into public.item_bulletin_visibility
      (item_guid, item_key, item_name, reason, updated_by, updated_by_email, updated_at)
    values (v_guid, v_key, v_name, v_reason, auth.uid(), v_email, now())
    on conflict (item_guid) do update
      set item_key = case when excluded.item_key <> '' then excluded.item_key else public.item_bulletin_visibility.item_key end,
          item_name = case when excluded.item_name <> '' then excluded.item_name else public.item_bulletin_visibility.item_name end,
          reason = excluded.reason,
          updated_by = excluded.updated_by,
          updated_by_email = excluded.updated_by_email,
          updated_at = now();
  else
    delete from public.item_bulletin_visibility where item_guid = v_guid;
  end if;

  insert into public.item_bulletin_visibility_audit
    (item_guid, item_key, item_name, action, reason, changed_by, changed_by_email)
  values (v_guid, v_key, v_name, case when p_hidden then 'hide' else 'show' end, v_reason, auth.uid(), v_email);

  return jsonb_build_object('item_guid', v_guid, 'hidden', p_hidden, 'was_hidden', v_was_hidden);
end; $$;

revoke all on function public.set_item_bulletin_visibility(text, boolean, text, text, text) from public, anon;
grant execute on function public.set_item_bulletin_visibility(text, boolean, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- نافذة المولّد العامة: item_key فقط، لأصناف النافذة العامة نفسها.
-- ---------------------------------------------------------------------------
create function price_feed_private.bulletin_hidden_items()
returns table (item_key text)
language sql stable security definer set search_path = '' as $$
  select p.item_key
  from public.item_bulletin_visibility as v
  join public.approved_price_items as p
    on upper(p.item_guid) = v.item_guid
  where coalesce(p.stock_qty, 0) > 0
$$;

revoke all on function price_feed_private.bulletin_hidden_items() from public;
grant execute on function price_feed_private.bulletin_hidden_items() to anon, authenticated, service_role;

create view public.bulletin_hidden_items_feed with (security_invoker = on) as
  select item_key from price_feed_private.bulletin_hidden_items();

revoke all on table public.bulletin_hidden_items_feed from public, anon, authenticated;
grant select on table public.bulletin_hidden_items_feed to anon, authenticated;

commit;
