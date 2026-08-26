-- ============================================================
-- OZK TOBACCO — ملاحظة النشرة لكل صنف (bulletin_note)
-- ترحيل إضافي آمن: لا يضيف عموداً جديداً في approved_price_items،
-- بل يعيد استخدام عمود notes الموجود مسبقاً (100% غير مستخدم قبل هذا التاريخ)
-- ويعرضه عبر سلسلة الـviews العامة تحت اسم bulletin_note.
-- طُبّق على الإنتاج بتاريخ 2026-08-26.
-- ============================================================
--
-- لماذا notes وليس عمود جديد؟
--   approved_price_items.notes موجود منذ إنشاء الجدول (افتراضي '') ولم يُستخدم
--   إطلاقاً من أي مسار حفظ أو قراءة. إعادة استخدامه يوفّر ربطاً مباشراً بالصنف
--   بلا مخاطرة ترحيل جديدة، ويستفيد من التطبيع الثنائي الجاهز أصلاً في
--   src/supabase-client.js (normalizeDbApprovedPrice / normalizeApprovedPriceInput).
--
-- السلسلة: approved_price_items.notes
--            → approved_price_sync_feed.bulletin_note (هذا الملف)
--            → available-price-sync-feed.sql (عمود ممرَّر عبر feed.*)
--            → scripts/generate-price-lists.mjs و src/app.js يركّبان
--              "الاسم — الملاحظة" فقط عند وجود نص، دون تعديل تصميم النشرة.
--
-- approved_price_sync_feed غير مُعرَّف كملف .sql في هذا المجلد أصلاً (تعريفه حي
-- فقط في قاعدة الإنتاج)، لذلك التعريف الكامل التالي هو ما طُبّق فعلياً:

drop view if exists public.approved_price_sync_feed cascade;

create view public.approved_price_sync_feed as
select
  item_key,
  item_name,
  sale_price,
  unit1_price,
  unit1_name,
  unit2_name,
  unit2_factor,
  unit2_price,
  ((price_payload -> 'retail'::text) ->> 'price'::text)::numeric as retail_carton_usd,
  updated_at,
  notes as bulletin_note
from public.approved_price_items;

comment on column public.approved_price_items.notes is
  'ملاحظة النشرة الحرة لكل صنف (اختيارية) — تُعرض بجانب اسم الصنف في نشرة الأسعار والـPDF بصيغة "الاسم — الملاحظة". فارغة افتراضياً.';

-- available_price_sync_feed يعتمد على approved_price_sync_feed عبر feed.*، وإضافة
-- عمود جديد في نهاية هذه الـview يزحزح ترتيب أعمدة الـview المعتمدة عليها
-- (stock_qty وغيره)، وCREATE OR REPLACE VIEW يرفض ذلك (42P16). لذلك أُعيد إنشاء
-- available_price_sync_feed بالكامل — التعريف مطابق لما في available-price-sync-feed.sql:

drop view if exists public.available_price_sync_feed;

create view public.available_price_sync_feed as
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
  'Public price-list feed filtered to items with positive stock from the latest Al-Ameen-backed approved price record. Includes bulletin_note per item.';

-- تحقّق سريع بعد التشغيل:
--   select item_key, bulletin_note from public.available_price_sync_feed limit 5;
