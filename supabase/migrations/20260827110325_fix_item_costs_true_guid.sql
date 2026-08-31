-- العمود القديم item_guid في item_costs كان في الحقيقة مفتاح تطابق (GUID أو كود أو اسم) وليس
-- دائماً GUID فعلي؛ نعيد تسميته match_key (يبقى المفتاح الأساسي لمنع التكرار عند الرفع، وهو
-- عمود إلزامي non-null بحكم push-item-costs.ps1) ونضيف عمود item_guid حقيقي (GUID الأمين
-- فقط أو NULL) يستخدمه تطابق شاشة التسعير بالمعرّف بدل مفتاح التطابق العام.
--
-- الترحيل آمن للتشغيل المتكرر: إعادة التسمية تُنفَّذ فقط إن كان العمود القديم item_guid ما يزال
-- موجوداً وmatch_key غير موجود بعد (أي لم يُطبَّق الترحيل من قبل)، والباقي idempotent بالكامل.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'item_costs' and column_name = 'item_guid'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'item_costs' and column_name = 'match_key'
  ) then
    alter table public.item_costs rename column item_guid to match_key;
  end if;
end $$;

alter table public.item_costs add column if not exists item_guid text;
create index if not exists idx_item_costs_item_guid on public.item_costs(item_guid) where item_guid is not null;
