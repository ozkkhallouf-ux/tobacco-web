-- ============================================================================
-- حدود الائتمان: الهوية `customer_guid` لا اسم الزبون.
--
-- العطل الذي يمنعه: `customer_key` مشتقّ من اسم الزبون (`normalizeItemName`)،
-- واسم الحساب في الأمين نصّ قابل للتعديل في أي لحظة. فإعادة تسمية حساب واحدة
-- كانت تُغيّر المفتاح فينفصل الحد عن صاحبه صامتاً: يظهر الزبون «بلا حد»،
-- ويسقط عنه تصنيفا «تجاوز الحد» و«قريب من الحد» كلياً. وهو نفس العطل البنيوي
-- الذي أصاب ربط الفواتير بالاسم (راجع docs/ai/topics/customer-balances.md).
--
-- المعرّف يبقى نصّاً لا uuid: هو نفس شكل `customerGuid` في تقارير الأمين
-- المخزّنة jsonb، والمقارنة بينهما نصّية في كل مسارات الموقع.
-- ============================================================================

alter table public.customer_credit_limits add column if not exists customer_guid text;

-- المعرّف الصفري ليس معرّفاً: الأمين يكتبه بدل NULL، فقبوله يُنتج «مطابقة
-- قطعية» على قيمة لا تعني شيئاً. والقيد يفرض الشكل والحالة الصغيرة معاً كي لا
-- يتسلّل تفاوت حالة أحرف يكسر المطابقة النصّية.
alter table public.customer_credit_limits drop constraint if exists customer_credit_limits_customer_guid_shape;
alter table public.customer_credit_limits add constraint customer_credit_limits_customer_guid_shape
  check (
    customer_guid is null
    or (
      customer_guid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and customer_guid <> '00000000-0000-0000-0000-000000000000'
    )
  );

-- ---------------------------------------------------------------------------
-- ردم لمرة واحدة من أحدث تقرير أرصدة.
--
-- هذا ليس تخميناً جديداً: الموقع يربط الحد بصاحبه **بهذا المفتاح النصّي بالذات**
-- منذ اليوم الأول، فالردم يثبّت الربط القائم فعلاً في لحظة معلومة بدل تركه
-- معلّقاً على اسم قابل للتغيير. وهو محروس بثلاثة شروط: تطابق حرفي للمفتاح،
-- ومرشّح واحد لا أكثر (`guid_count = 1`)، ومعرّف غير صفري. أي مفتاح غامض
-- يبقى بلا معرّف ويستمر عمله بالاسم كما كان — لا نسبة بالتخمين إطلاقاً.
--
-- قيس قبل التطبيق على الإنتاج (2026-09-05): 25 سجل حد، 302 زبوناً في التقرير،
-- 25/25 تطابقاً بمرشّح واحد ومعرّف صالح، 0 مفاتيح بمعرّفات متعددة، 25 معرّفاً
-- متمايزاً — فلا سجل يبقى معلّقاً ولا تصادم على الفهرس الفريد.
-- ---------------------------------------------------------------------------
with latest as (
  select items
  from public.inventory_reports
  where source = 'ameen_customer_balances' and jsonb_typeof(items) = 'array'
  order by created_at desc
  limit 1
), report_items as (
  select
    e->>'key' as report_key,
    nullif(lower(trim(coalesce(e->>'customerGuid', ''))), '') as report_guid
  from latest, jsonb_array_elements(latest.items) e
), unambiguous as (
  select report_key, min(report_guid) as report_guid
  from report_items
  where report_key is not null and report_key <> ''
  group by report_key
  having count(distinct report_guid) = 1
     and min(report_guid) is not null
     and min(report_guid) <> '00000000-0000-0000-0000-000000000000'
)
update public.customer_credit_limits c
set customer_guid = u.report_guid
from unambiguous u
where c.customer_guid is null
  and c.customer_key = u.report_key
  -- لا نمنح معرّفاً سبق أن نُسب لسجل آخر
  and not exists (
    select 1 from public.customer_credit_limits x
    where x.customer_guid = u.report_guid and x.id <> c.id
  );

-- ---------------------------------------------------------------------------
-- الفهارس: الهوية على المعرّف، والمفتاح النصّي يبقى فريداً **فقط** حين يغيب
-- المعرّف (سجل قديم لم يُنسب بعد).
--
-- لماذا يسقط `unique(customer_key)` الكامل: تحت نموذج المعرّف يجوز أن يحمل
-- حسابان مختلفان الاسم نفسه — وهو ما كان النموذج القديم يطويه في سجل واحد —
-- فبقاء القيد الكامل يمنع حفظ حدّ الحساب الثاني برسالة خطأ قاعدة بيانات
-- غامضة. الحماية لا تضعف: تكرار سجلين بلا معرّف على المفتاح نفسه لا يزال
-- مرفوضاً، وتكرار المعرّف مرفوض أصلاً.
--
-- ملاحظة تشغيلية: الكود لم يعد يستعمل `on_conflict` على هذا الجدول (بحث ثم
-- كتابة في `src/supabase-client.js`)، لأن PostgREST لا يستطيع استنتاج فهرس
-- جزئي في ON CONFLICT.
-- ---------------------------------------------------------------------------
alter table public.customer_credit_limits drop constraint if exists customer_credit_limits_customer_key_key;
drop index if exists public.customer_credit_limits_customer_key_key;

create unique index if not exists customer_credit_limits_customer_guid_key
  on public.customer_credit_limits (customer_guid)
  where customer_guid is not null;

create unique index if not exists customer_credit_limits_customer_key_legacy_key
  on public.customer_credit_limits (customer_key)
  where customer_guid is null;
