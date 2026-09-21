-- ############################################################################
-- ⛔ تحذير حاسم (أُضيف 2026-09-21 بعد تدقيق قراءة فقط على البيانات الحية)
--
-- كتلة الحذف المعلّقة في القسم (3) أدناه **غير آمنة ولا يجوز تشغيلها كما هي**.
-- هي تختار الصف الباقي بـ `order by updated_at desc` — وهذا المعيار **خاطئ**
-- على البيانات الحالية، لا نظرياً بل بالقياس:
--
--     `updated_at desc` يختار الصف **اليتيم** في 31 مجموعة من 53 (58٪).
--
-- السبب: الصفوف اليتيمة تُلمَس بعد الحية بأجزاء من الثانية ضمن دورة المزامنة
-- نفسها (مثال مقيس: «اليغانس سليم أزرق» اليتيم 22:30:34.278 مقابل «اليغانس
-- سليم ازرق» الحيّ 22:30:33.059). فتشغيل القسم (3) كان سيحذف البطاقة الحية
-- ويُبقي اليتيمة في 31 حالة — خسارة صامتة لا رجعة فيها.
--
-- معيار الـcanonical الصحيح الوحيد (حاسم بلا لبس في كل 53 مجموعة):
--     الصف الذي `item_key` له موجود ضمن `key` في أحدث تقرير مصدره
--     `ameen_sql_agent` في `inventory_reports` — أي بطاقة الأمين الحية.
--     لا `updated_at`، ولا الأحدث، ولا الأعلى سعراً، ولا الاسم.
--
-- حالة البيانات وقت كتابة هذا التحذير: 357 صفاً، 53 مجموعة مكررة، 54 صفاً
-- يتيماً، وكلها الفئة A (يتيم إملائي أو اسم أمين سابق) — لا alias تجاري واحد
-- بينها، ولا مجموعة بأكثر من بطاقة حية. الأسعار متفقة داخل كل مجموعة فلا
-- تعارض نشط.
--
-- منع التكرار الجديد صار مطبَّقاً بالكود منذ فرع
-- `fix/prevent-new-guid-duplicate-rows`: `findNewDuplicateGuidRows` في
-- src/price-guid-conflict.js يرفض إنشاء صف ثانٍ على بطاقة مأهولة قبل أي كتابة.
-- تنظيف الـ54 القائمة و`unique index` يبقيان قرارين لاحقين مستقلين.
-- ############################################################################

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
-- (3) ⛔ **متروك للتوثيق فقط — لا يُشغَّل.** معيار `updated_at desc` أدناه يحذف
--     الصف الحيّ في 31 مجموعة من 53 (راجع التحذير أعلى الملف). أي تنظيف مستقبلي
--     يجب أن يختار الباقي بمطابقة `item_key` مع بطاقة الأمين الحية، لا بالزمن.
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
