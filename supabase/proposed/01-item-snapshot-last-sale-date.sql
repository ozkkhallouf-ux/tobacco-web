-- ============================================================================
-- مقترح — غير مطبَّق. يضيف تاريخ آخر بيع فعلي لكل صنف.
--
-- الحاجة: بوابة «الراكد» في لوحة القرار تعتمد اليوم على المعدّل اليومي وحده،
-- فصنف يبيع 0.6 قطعة يومياً لكنه لم يُطلب منذ 25 يوماً يمرّ منها. المُدخل موجود
-- أصلاً في sales_line_items ويقرأه المولّد بالفعل (latestSales في
-- scripts/item-snapshot-pipeline.mjs) — ما ينقص هو عمود يحمله.
--
-- ترتيب التطبيق الإلزامي:
--   1) هذا الملف (العمود + الدالة).
--   2) تعديل scripts/item-snapshot-pipeline.mjs ليُخرج last_sale_date.
--   3) تشغيل tools/push-purchase-item-snapshot.ps1 (بلا -Apply أولاً) والتحقق.
--   4) تشغيله بـ-Apply، ثم التأكد أن generated_at تغيّر وأن العمود امتلأ.
--
-- ملاحظة أمان: jsonb_to_recordset يتجاهل المفاتيح غير المعلَنة، فإخراج المولّد
-- للحقل قبل تطبيق هذا الملف لا يكسر شيئاً — يُهمَل بصمت فقط.
-- ============================================================================
begin;

alter table public.ameen_item_snapshot
  add column if not exists last_sale_date date;

comment on column public.ameen_item_snapshot.last_sale_date is
  'أحدث تاريخ بيع للصنف ضمن نافذة اللقطة. NULL يعني لا بيع في النافذة.';

-- الدالة تُعاد كاملةً في الملف المرجعي supabase/ameen-item-snapshot-refresh.sql.
-- المطلوب هنا ثلاث إضافات فقط داخلها:
--   • في jsonb_to_recordset:  last_sale_date date,
--   • في قائمة أعمدة insert:  last_sale_date,
--   • في قائمة select:        s.last_sale_date,
-- لا يُغيَّر أي حارس من حرّاس الحداثة أو الذرّية.

commit;
