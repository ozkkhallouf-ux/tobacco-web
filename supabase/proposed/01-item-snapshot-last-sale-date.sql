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
--   2) تعديل scripts/item-snapshot-pipeline.mjs: إضافة 'last_sale_date' إلى
--      SNAPSHOT_FIELDS وإخراجه من buildItemSnapshot.
--   3) تعديل قائمة الأعمدة الصريحة في src/supabase-client.js (listItemSnapshots)
--      لتشمل last_sale_date. بدون هذه الخطوة يمتلئ العمود في القاعدة ولا يصل
--      المتصفح أبداً، فتبقى بوابة الركود الزمنية معطَّلة بصمت رغم تطبيق العمود.
--   4) تشغيل tools/push-purchase-item-snapshot.ps1 (بلا -Apply أولاً) والتحقق.
--   5) تشغيله بـ-Apply، ثم التأكد أن generated_at تغيّر وأن العمود امتلأ.
--
-- إلى أن تكتمل الخطوات الخمس، تُعلن طبقة القرار البوابة معطَّلة صراحةً عبر
-- idleGateActive/idleGateNote في src/decision-scoring.js — لا تُفترض عاملة.
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
