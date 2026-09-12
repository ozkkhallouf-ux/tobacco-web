-- ============================================================================
-- مقترح — غير مطبَّق. لا يحذف هذا الملف شيئاً بصيغته الحالية.
--
-- الواقع المثبت (2026-09-06): 361 صفاً في approved_price_items مقابل 302
-- item_guid مميز — أي 59 صفاً مكرراً. طبقة القرار تدمجها بالمعرّف في الذاكرة
-- فلا يظهر الصنف مرتين، لكن المصدر يبقى مزدوجاً وأي مستهلك آخر عرضة للازدواج.
--
-- الخطوة الأولى تشخيصية بحتة: أخرج القائمة وراجعها بشرياً قبل أي حذف.
-- ============================================================================

-- (1) الصفوف المكرّرة بالمعرّف، مع ما يميّز كل نسخة.
select
  a.item_guid,
  count(*) as copies,
  array_agg(a.id order by a.updated_at desc nulls last) as ids,
  array_agg(distinct a.item_name) as names,
  array_agg(distinct a.item_key) as keys,
  array_agg(a.sale_price order by a.updated_at desc nulls last) as prices,
  array_agg(a.updated_at order by a.updated_at desc nulls last) as updated
from public.approved_price_items a
group by a.item_guid
having count(*) > 1
order by copies desc, a.item_guid;

-- (2) هل تختلف الأسعار بين النسخ؟ اختلاف السعر يعني أن الحذف قرار تجاري لا تقني.
select a.item_guid, count(distinct a.sale_price) as distinct_prices
from public.approved_price_items a
group by a.item_guid
having count(*) > 1 and count(distinct a.sale_price) > 1;

-- ----------------------------------------------------------------------------
-- (3) لا تُشغّل ما تحت هذا السطر إلا بعد مراجعة مخرجات (1) و(2) وموافقة صريحة.
--     يُبقي أحدث صف لكل معرّف ويحذف ما عداه، ثم يمنع تكراراً جديداً.
-- ----------------------------------------------------------------------------
-- begin;
--   delete from public.approved_price_items a
--   using (
--     select id, row_number() over (
--       partition by item_guid order by updated_at desc nulls last, id desc
--     ) as rn
--     from public.approved_price_items
--     where item_guid is not null
--   ) ranked
--   where a.id = ranked.id and ranked.rn > 1;
--
--   create unique index if not exists approved_price_items_item_guid_key
--     on public.approved_price_items (item_guid)
--     where item_guid is not null;
-- commit;
