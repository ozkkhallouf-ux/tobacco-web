-- تراجع Migration 28. يحذف تصحيحات التصنيف وسجل تدقيقها — لا يُشغَّل إلا بموافقة صريحة من المالك
-- وبعد تصدير الجدولين إن احتوت على تصحيحات غير التصحيحين المبذورين.
-- لا يمسّ أي سعر ولا أي مخزون ولا approved_price_items ولا available_price_sync_feed.
-- بعده: الموقع والمولّد يعودان تلقائياً للتصحيحات المؤكدة المثبّتة بالكود + قاعدة الاسم
-- (الوينستون المخصص يبقى «عامة» لأن تصحيحه مثبّت بالكود أيضاً).
begin;

do $$ begin
  if to_regclass('public.item_bulletin_classifications') is null then
    raise exception 'migration 28 is not applied';
  end if;
end $$;

drop view if exists public.bulletin_item_classification_feed;
drop function if exists price_feed_private.bulletin_classification_rows();
drop function if exists public.set_item_bulletin_classification(text, text, text, text, text);
drop table public.item_bulletin_classification_audit;
drop table public.item_bulletin_classifications;

delete from supabase_migrations.schema_migrations where version = '20261105170000';

commit;
