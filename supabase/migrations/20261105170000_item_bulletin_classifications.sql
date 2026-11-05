-- Migration 28: تصحيح تصنيف الأصناف بين «النشرة العامة» و«الوزاري» بمعرّف الأمين (طلب عمر 2026-11-05).
--
-- لماذا: التصنيف كان بقاعدة اسم وحدها («وينستون» بلا «حرة» ⇒ وزاري)، فصنّف «وينستون ازرق مخصص»
-- و«وينستون فضي مخصص» وزاري خطأً ولا وسيلة لتصحيحه دون تعديل الكود.
--
-- ما تفعله:
--   * جدول item_bulletin_classifications: تصحيح واحد لكل item_guid (general | wazari).
--   * جدول item_bulletin_classification_audit: سجل تدقيق إلحاقي لكل تغيير (قبل/بعد/السبب/من/متى).
--   * دالة set_item_bulletin_classification للمالك وحده (is_owner)، و'auto' يزيل التصحيح
--     فيعود الصنف لقاعدة الاسم. لا INSERT/UPDATE/DELETE مباشر لأي دور.
--   * نافذة bulletin_item_classification_feed (anon) لمولّد النشرات: item_key والنشرة فقط
--     لأصناف approved_price_items ذات المخزون الموجب — نفس أصناف available_price_sync_feed
--     العامة أصلاً. لا سعر ولا تكلفة ولا GUID ولا سبب ولا بريد.
--   * بذر تصحيحين مؤكدين: وينستون ازرق مخصص (463) ووينستون فضي مخصص (464) ⇒ general.
--
-- قواعد ثابتة:
--   * لا شيء هنا يقرأ الأمين أو يكتب فيه.
--   * لا يمسّ أي جدول قائم ولا أي سعر ولا أي مخزون — approved_price_items تُقرأ فقط في النافذة.
--   * القراءة: الطاقم (is_staff) عدا موظف الجرد للتصحيحات؛ المالك وحده لسجل التدقيق.

begin;

do $$ begin
  if to_regclass('public.item_bulletin_classifications') is not null
     or to_regclass('public.item_bulletin_classification_audit') is not null then
    raise exception 'migration 28 guard: already applied';
  end if;
end $$;

create table public.item_bulletin_classifications (
  item_guid text primary key
    check (item_guid ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'),
  bulletin text not null check (bulletin in ('general', 'wazari')),
  item_key text not null default '' check (length(item_key) <= 200),
  item_name text not null default '' check (length(item_name) <= 200),
  item_number text check (item_number is null or length(item_number) <= 40),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  updated_by uuid,
  updated_by_email text not null default '',
  updated_at timestamptz not null default now()
);

create table public.item_bulletin_classification_audit (
  id bigint generated always as identity primary key,
  item_guid text not null,
  item_key text not null default '',
  item_name text not null default '',
  old_bulletin text,
  new_bulletin text not null check (new_bulletin in ('general', 'wazari', 'auto')),
  reason text not null,
  changed_by uuid,
  changed_by_email text not null default '',
  changed_at timestamptz not null default now()
);

create index item_bulletin_classification_audit_guid_idx
  on public.item_bulletin_classification_audit (item_guid, changed_at desc);

alter table public.item_bulletin_classifications enable row level security;
alter table public.item_bulletin_classifications force row level security;
alter table public.item_bulletin_classification_audit enable row level security;
alter table public.item_bulletin_classification_audit force row level security;

revoke all on table public.item_bulletin_classifications from public, anon, authenticated;
revoke all on table public.item_bulletin_classification_audit from public, anon, authenticated;
grant select on table public.item_bulletin_classifications to authenticated;
grant select on table public.item_bulletin_classification_audit to authenticated;

create policy item_bulletin_classifications_staff_select on public.item_bulletin_classifications
  for select to authenticated
  using (
    (select public.is_staff())
    and (select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', ''))) <> 'inventory_counter'
  );

create policy item_bulletin_classification_audit_owner_select on public.item_bulletin_classification_audit
  for select to authenticated
  using ((select public.is_owner()));

-- ---------------------------------------------------------------------------
-- الكتابة الوحيدة: المالك وحده، مع سطر تدقيق في المعاملة نفسها.
-- ---------------------------------------------------------------------------
create function public.set_item_bulletin_classification(
  p_item_guid text, p_bulletin text, p_item_key text, p_item_name text, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_guid text := upper(btrim(coalesce(p_item_guid, ''), ' {}'));
  v_bulletin text := lower(btrim(coalesce(p_bulletin, '')));
  v_key text := left(btrim(coalesce(p_item_key, '')), 200);
  v_name text := left(btrim(coalesce(p_item_name, '')), 200);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_old text;
begin
  if not public.is_owner() or auth.uid() is null then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_guid !~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$' then
    raise exception 'invalid_item_guid';
  end if;
  if v_bulletin not in ('general', 'wazari', 'auto') then
    raise exception 'invalid_bulletin';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 300 then
    raise exception 'reason_required';
  end if;

  select bulletin into v_old from public.item_bulletin_classifications where item_guid = v_guid for update;

  if v_bulletin = 'auto' then
    delete from public.item_bulletin_classifications where item_guid = v_guid;
  else
    insert into public.item_bulletin_classifications
      (item_guid, bulletin, item_key, item_name, reason, updated_by, updated_by_email, updated_at)
    values (v_guid, v_bulletin, v_key, v_name, v_reason, auth.uid(), v_email, now())
    on conflict (item_guid) do update
      set bulletin = excluded.bulletin,
          item_key = case when excluded.item_key <> '' then excluded.item_key else public.item_bulletin_classifications.item_key end,
          item_name = case when excluded.item_name <> '' then excluded.item_name else public.item_bulletin_classifications.item_name end,
          reason = excluded.reason,
          updated_by = excluded.updated_by,
          updated_by_email = excluded.updated_by_email,
          updated_at = now();
  end if;

  insert into public.item_bulletin_classification_audit
    (item_guid, item_key, item_name, old_bulletin, new_bulletin, reason, changed_by, changed_by_email)
  values (v_guid, v_key, v_name, v_old, v_bulletin, v_reason, auth.uid(), v_email);

  return jsonb_build_object('item_guid', v_guid, 'bulletin', v_bulletin, 'previous', v_old);
end; $$;

revoke all on function public.set_item_bulletin_classification(text, text, text, text, text) from public, anon;
grant execute on function public.set_item_bulletin_classification(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- نافذة المولّد العامة: item_key والنشرة فقط، لأصناف النافذة العامة نفسها.
-- ---------------------------------------------------------------------------
create function price_feed_private.bulletin_classification_rows()
returns table (item_key text, bulletin text)
language sql stable security definer set search_path = '' as $$
  select p.item_key, c.bulletin
  from public.item_bulletin_classifications as c
  join public.approved_price_items as p
    on upper(p.item_guid) = c.item_guid
  where coalesce(p.stock_qty, 0) > 0
$$;

revoke all on function price_feed_private.bulletin_classification_rows() from public;
grant execute on function price_feed_private.bulletin_classification_rows() to anon, authenticated, service_role;

create view public.bulletin_item_classification_feed with (security_invoker = on) as
  select item_key, bulletin from price_feed_private.bulletin_classification_rows();

revoke all on table public.bulletin_item_classification_feed from public, anon, authenticated;
grant select on table public.bulletin_item_classification_feed to anon, authenticated;

-- ---------------------------------------------------------------------------
-- بذر التصحيحين المؤكدين (المعرّفات من جرد الأمين وتقرير تفاصيل المواد 2026-11-05).
-- ---------------------------------------------------------------------------
insert into public.item_bulletin_classifications
  (item_guid, bulletin, item_key, item_name, item_number, reason, updated_by_email)
values
  ('294A7DC9-9BB3-4BEF-8791-F3C336AFD727', 'general', 'وينستون ازرق مخصص', 'وينستون ازرق مخصص', '463',
   'صنف عام أُدخل بفاتورة شراء؛ قاعدة الاسم صنّفته وزاري خطأً (طلب عمر 2026-11-05)', 'migration-28'),
  ('B29EB8C3-A1FE-4FEB-A18A-30E26189FDA2', 'general', 'وينستون فضي مخصص', 'وينستون فضي مخصص', '464',
   'صنف عام أُدخل بفاتورة شراء؛ قاعدة الاسم صنّفته وزاري خطأً (طلب عمر 2026-11-05)', 'migration-28');

insert into public.item_bulletin_classification_audit
  (item_guid, item_key, item_name, old_bulletin, new_bulletin, reason, changed_by_email)
select item_guid, item_key, item_name, null, bulletin, reason, 'migration-28'
from public.item_bulletin_classifications;

commit;
