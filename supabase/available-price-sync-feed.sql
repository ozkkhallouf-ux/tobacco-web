-- نشرة الأسعار العامة: أسعار المواد الموجودة فعلياً في جرد الأمين فقط.
-- شغّل هذا الملف مرة واحدة في Supabase SQL Editor قبل نشر تعديل المولّد.

create or replace view public.available_price_sync_feed as
select
  feed.*,
  prices.stock_qty,
  prices.stock_status,
  prices.source_synced_at
from public.approved_price_sync_feed as feed
join public.approved_price_items as prices
  on prices.item_key = feed.item_key
where coalesce(prices.stock_qty, 0) > 0;

grant select on public.available_price_sync_feed to anon, authenticated;

comment on view public.available_price_sync_feed is
  'Public price-list feed filtered to items with positive stock from the latest Al-Ameen-backed approved price record. Includes bulletin_note per item (see approved-price-sync-feed-bulletin-note.sql).';
