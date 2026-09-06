-- ============================================================================
-- مقترح — غير مطبَّق. يجعل كتابة التزامات الموردين idempotent.
--
-- الوضع الحالي: tools/push-supplier-obligations.ps1 يحذف كل صفوف المصدر ثم
-- يُدخل البديل. بين الحذف والإدخال نافذة يكون فيها الجدول فارغاً، وأي انقطاع
-- شبكة داخلها يترك الالتزامات ممسوحة. الجدول لا يحمل اليوم أي قيد فريد يسمح
-- بـupsert (المفتاح الأساسي id فقط).
--
-- بعد تطبيق هذا الملف يمكن استبدال delete+insert بـ:
--   POST /rest/v1/supplier_obligations?on_conflict=source,supplier_key
--   Prefer: resolution=merge-duplicates
-- ============================================================================
begin;

-- يُفشل التطبيق مبكراً وبوضوح إن كان في الجدول ازدواج قائم.
do $$
begin
  if exists (
    select 1 from public.supplier_obligations
    group by source, supplier_key having count(*) > 1
  ) then
    raise exception 'duplicate (source, supplier_key) rows exist; resolve them before adding the constraint';
  end if;
end $$;

create unique index if not exists supplier_obligations_source_supplier_key
  on public.supplier_obligations (source, supplier_key);

commit;
