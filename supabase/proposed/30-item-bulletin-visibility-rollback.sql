-- تراجع Migration 30 — يحذف جدولي الظهور ونافذة المولّد ودوال الكتابة فقط.
-- يحتاج موافقة المالك الصريحة وتصديراً لبيانات item_bulletin_visibility قبل التشغيل
-- إن كانت هناك أصناف مخفية فعلاً وقت التراجع (ستعود كلها ظاهرة فوراً للزبائن).

begin;

do $$ begin
  if to_regclass('public.item_bulletin_visibility') is null then
    raise exception 'migration 30 is not applied';
  end if;
end $$;

drop view if exists public.bulletin_hidden_items_feed;
drop function if exists price_feed_private.bulletin_hidden_items();
drop function if exists public.set_item_bulletin_visibility(text, boolean, text, text, text);
drop table if exists public.item_bulletin_visibility_audit;
drop table if exists public.item_bulletin_visibility;

delete from supabase_migrations.schema_migrations where version = '20261112120000';

commit;
