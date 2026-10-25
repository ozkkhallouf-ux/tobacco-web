-- ============================================================================
-- Migration 24: قصر بيانات التكلفة والربح على المالك (2026-10-25) — مقترحة، غير مطبَّقة
--
-- المشكلة (تدقيق قراءة فقط على Production، 2026-10-25):
--   أي حساب مسجَّل غير موظف جرد — ومنه حساب «موظف» ozk.kh@outlook.com والحساب بلا
--   دور — يقرأ مباشرة عبر REST:
--     • sales_line_items.unit_cost / net_profit (سياسة SELECT = true)
--     • ameen_item_snapshot.average_cost / last_purchase_price (سياسة SELECT = true)
--     • inventory_reports بالمصدر ameen_daily_profit (تكلفة البضاعة وصافي الربح)
--       وبالمصدر ameen_purchase_invoices (أسعار الشراء) — سياسة SELECT = is_staff()
--     • supplier_item_offers.price (عروض أسعار الموردين، سياسة SELECT = true؛ فارغ حالياً)
--
-- الإصلاح بأقل صلاحية:
--   1) sales_line_items: SELECT للمالك أو هوية المزامنة وحدهما.
--   2) ameen_item_snapshot: SELECT المباشر للمالك أو هوية المزامنة وحدهما، ودالة
--      list_ameen_item_snapshot() للطاقم تعيد الصفوف بأعمدة التكلفة فارغة (NULL)
--      لغير المالك، فتبقى اقتراحات المخزون والحركة تعمل في شاشة الشراء.
--   3) inventory_reports: سياسة RESTRICTIVE تحجب مصدرَي الربح والشراء عن غير المالك
--      قراءةً وكتابةً، ولا تمسّ بقية المصادر.
--   4) supplier_item_offers: SELECT للمالك وحده؛ وسحب صلاحية anon عن الـview فوقه.
--   5) تنظيف صلاحيات زائدة لا تحميها إلا RLS: item_costs (anon كاملة، وTRUNCATE/
--      REFERENCES/TRIGGER لـauthenticated)، وapp_secrets وbot_config (كاملة لـanon
--      وauthenticated، ولا تقرؤهما إلا دوال بمفتاح الخدمة أو SECURITY DEFINER).
--
-- لا يمسّ: هوية المزامنة (المالك نفسه، uid 9724dbe4-…)، ولا الدوال الطرفية (مفتاح
-- الخدمة يتجاوز RLS)، ولا صلاحيات الكتابة القائمة، ولا أي بيانات.
--
-- التطبيق: معاملة واحدة؛ الحارس يرفض أي Production يختلف عمّا دُقِّق؛ وتحقق أدوار
-- داخل المعاملة نفسها يُلغي كل شيء إن فشل. التراجع: 24-cost-data-owner-only-rollback.sql
-- ============================================================================

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- --- الحارس: Production كما دُقِّق، والهجرة غير مطبَّقة ------------------------
do $guard$
declare
  v_missing text;
begin
  select string_agg(x.t || '.' || x.p, ', ') into v_missing
  from (values
    ('sales_line_items', 'authenticated can select sales_line_items'),
    ('ameen_item_snapshot', 'authenticated can select ameen_item_snapshot'),
    ('supplier_item_offers', 'supplier_item_offers_read'),
    ('inventory_reports', 'inventory_reports_staff_select')
  ) as x(t, p)
  where not exists (
    select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = x.t and pol.polname = x.p
      and pol.polcmd = 'r' and pol.polpermissive
      and pg_get_expr(pol.polqual, pol.polrelid) = case when x.p = 'inventory_reports_staff_select' then 'is_staff()' else 'true' end
  );
  if v_missing is not null then
    raise exception 'migration 24 guard: expected baseline policy missing or changed: %', v_missing;
  end if;

  if exists (select 1 from pg_policy where polname in (
       'sales_line_items_owner_select', 'ameen_item_snapshot_owner_select',
       'inventory_reports_cost_sources_owner_only', 'supplier_item_offers_owner_select'))
     or to_regprocedure('public.list_ameen_item_snapshot()') is not null then
    raise exception 'migration 24 guard: already applied (partially or fully)';
  end if;

  if to_regprocedure('public.sales_line_items_is_sync_writer()') is null
     or to_regprocedure('public.ameen_item_snapshot_is_sync_writer()') is null
     or to_regprocedure('public.is_owner()') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception 'migration 24 guard: identity helper function missing';
  end if;
end
$guard$;

-- --- 1) sales_line_items ------------------------------------------------------
drop policy "authenticated can select sales_line_items" on public.sales_line_items;
create policy sales_line_items_owner_select on public.sales_line_items
  as permissive for select to authenticated
  using ((select public.is_owner()) or (select public.sales_line_items_is_sync_writer()));

-- --- 2) ameen_item_snapshot -----------------------------------------------------
drop policy "authenticated can select ameen_item_snapshot" on public.ameen_item_snapshot;
create policy ameen_item_snapshot_owner_select on public.ameen_item_snapshot
  as permissive for select to authenticated
  using ((select public.is_owner()) or (select public.ameen_item_snapshot_is_sync_writer()));

create function public.list_ameen_item_snapshot()
returns setof public.ameen_item_snapshot
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role text := lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', ''));
  v_owner boolean := (select public.is_owner());
begin
  if auth.uid() is null or v_role = 'inventory_counter'
     or not (v_owner or (select public.is_staff())) then
    raise exception 'list_ameen_item_snapshot: غير مصرّح' using errcode = '42501';
  end if;

  return query
  select s.id, s.item_key, s.item_guid, s.item_number, s.item_name, s.unit1_name, s.unit2_name,
         s.unit2_factor, s.stock_unit1, s.stock_unit2,
         case when v_owner then s.last_purchase_price end,
         case when v_owner then s.last_purchase_currency end,
         s.last_purchase_date,
         case when v_owner then s.last_purchase_unit end,
         case when v_owner then s.average_cost end,
         case when v_owner then s.average_cost_currency end,
         case when v_owner then s.average_cost_basis end,
         s.last_supplier_name, s.last_supplier_guid, s.units_sold_30d, s.movement_rank, s.generated_at
  from public.ameen_item_snapshot s;
end;
$function$;

comment on function public.list_ameen_item_snapshot() is
  'Migration 24: لقطة أصناف الأمين للطاقم. أعمدة التكلفة وآخر سعر شراء NULL لغير المالك.';
revoke all on function public.list_ameen_item_snapshot() from public, anon;
grant execute on function public.list_ameen_item_snapshot() to authenticated;

-- --- 3) inventory_reports: مصدرا الربح والشراء للمالك وحده -------------------
create policy inventory_reports_cost_sources_owner_only on public.inventory_reports
  as restrictive for all to authenticated
  using (source not in ('ameen_daily_profit', 'ameen_purchase_invoices') or (select public.is_owner()))
  with check (source not in ('ameen_daily_profit', 'ameen_purchase_invoices') or (select public.is_owner()));

-- --- 4) supplier_item_offers ----------------------------------------------------
drop policy supplier_item_offers_read on public.supplier_item_offers;
create policy supplier_item_offers_owner_select on public.supplier_item_offers
  as permissive for select to authenticated
  using ((select public.is_owner()));
revoke all on public.v_item_supplier_comparison from anon;

-- --- 5) صلاحيات زائدة -----------------------------------------------------------
revoke all on public.item_costs from anon;
revoke truncate, references, trigger on public.item_costs from authenticated;
revoke all on public.app_secrets from anon, authenticated;
revoke all on public.bot_config from anon, authenticated;

-- --- تحقق داخل المعاملة: أي فشل يُلغي كل ما سبق ------------------------------
do $verify$
declare
  v_n integer;
  v_staff_email text := (select min(email) from public.staff_allowlist);
begin
  -- عضو طاقم بدور employee (بريد من staff_allowlist نفسه حتى يمرّ is_staff()): لا تكلفة ولا ربح.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', '00000000-0000-0000-0000-0000000000e1', 'email', v_staff_email, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'employee'))::text, true);
  set local role authenticated;
  select count(*) into v_n from public.sales_line_items;
  if v_n <> 0 then raise exception 'verify: employee still reads sales_line_items (%)', v_n; end if;
  select count(*) into v_n from public.ameen_item_snapshot;
  if v_n <> 0 then raise exception 'verify: employee still reads ameen_item_snapshot (%)', v_n; end if;
  select count(*) into v_n from public.inventory_reports where source in ('ameen_daily_profit', 'ameen_purchase_invoices');
  if v_n <> 0 then raise exception 'verify: employee still reads cost reports (%)', v_n; end if;
  select count(*) into v_n from public.list_ameen_item_snapshot()
    where average_cost is not null or last_purchase_price is not null;
  if v_n <> 0 then raise exception 'verify: snapshot RPC leaks cost to employee (%)', v_n; end if;
  reset role;

  -- المالك: يقرأ كما كان.
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000f1","email":"owner@verify.local","role":"authenticated","app_metadata":{"role":"owner"}}', true);
  set local role authenticated;
  select count(*) into v_n from public.sales_line_items;
  if v_n = 0 then raise exception 'verify: owner lost sales_line_items'; end if;
  select count(*) into v_n from public.ameen_item_snapshot;
  if v_n = 0 then raise exception 'verify: owner lost ameen_item_snapshot'; end if;
  reset role;

  if has_table_privilege('anon', 'public.app_secrets', 'select')
     or has_table_privilege('authenticated', 'public.app_secrets', 'select')
     or has_table_privilege('anon', 'public.bot_config', 'select')
     or has_table_privilege('anon', 'public.item_costs', 'select')
     or has_table_privilege('authenticated', 'public.item_costs', 'truncate') then
    raise exception 'verify: excess grants remain';
  end if;
  if not has_table_privilege('authenticated', 'public.item_costs', 'select,insert,update,delete') then
    raise exception 'verify: owner write path on item_costs lost';
  end if;
  perform set_config('request.jwt.claims', '', true);
end
$verify$;

commit;

notify pgrst, 'reload schema';
