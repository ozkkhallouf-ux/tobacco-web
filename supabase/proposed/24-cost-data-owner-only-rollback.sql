-- ============================================================================
-- تراجع Migration 24: يعيد السياسات والصلاحيات كما كانت على Production حرفياً
-- قبل الهجرة (لقطة 2026-10-25)، أي يعيد التسرّب نفسه. لا يمسّ أي بيانات.
-- يُستعمل فقط إن كسرت الهجرة مساراً قائماً. بصمته مُختبرة محلياً:
-- scripts/check-cost-data-owner-only.mjs يقارن السياسات والـACL قبل الهجرة وبعد التراجع.
-- ============================================================================

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $guard$
begin
  if not exists (select 1 from pg_policy where polname = 'sales_line_items_owner_select') then
    raise exception 'migration 24 rollback guard: migration 24 is not applied';
  end if;
end
$guard$;

-- 1) sales_line_items
drop policy if exists sales_line_items_owner_select on public.sales_line_items;
create policy "authenticated can select sales_line_items" on public.sales_line_items
  as permissive for select to authenticated using (true);

-- 2) ameen_item_snapshot
drop policy if exists ameen_item_snapshot_owner_select on public.ameen_item_snapshot;
create policy "authenticated can select ameen_item_snapshot" on public.ameen_item_snapshot
  as permissive for select to authenticated using (true);
drop function if exists public.list_ameen_item_snapshot();

-- 3) inventory_reports
drop policy if exists inventory_reports_cost_sources_owner_only on public.inventory_reports;

-- 4) supplier_item_offers
drop policy if exists supplier_item_offers_owner_select on public.supplier_item_offers;
create policy supplier_item_offers_read on public.supplier_item_offers
  as permissive for select to authenticated using (true);
grant all on public.v_item_supplier_comparison to anon;

-- 5) الصلاحيات كما كانت (arwdDxtm)
grant all on public.item_costs to anon, authenticated;
grant all on public.app_secrets to anon, authenticated;
grant all on public.bot_config to anon, authenticated;

commit;

notify pgrst, 'reload schema';
