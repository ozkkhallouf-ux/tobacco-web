-- يضيف item_guid (GUID الأمين الحقيقي) إلى approved_price_items كي تحتفظ لائحة الأسعار
-- بمفتاح مطابقة متوسط التكلفة الحي (item_costs) دون انتظار مهمة الـsnapshot المجدولة.
alter table public.approved_price_items add column if not exists item_guid text;
create index if not exists idx_approved_price_items_item_guid on public.approved_price_items(item_guid) where item_guid is not null;
