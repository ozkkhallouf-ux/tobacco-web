-- مرجعي فقط — لا يُطبَّق تلقائياً على Supabase الحي. راجع تعليمات التطبيق أسفل الملف.
--
-- جدول مستقل مخصص لتقارير مخزون المستودعات من الأمين (يكتبه
-- tools/push-ameen-warehouse-stock.ps1، تقرير مستقل لكل مستودع حقيقي).
-- يستبدل الاعتماد على inventory_reports لهذا المصدر تحديداً — مراجعة Codex
-- على PR #40 (الجولة الثانية): source='ameen_warehouse_stock' وحده لا يمنع
-- أي موظف مسجَّل يملك صلاحية INSERT على inventory_reports (نفس الجدول
-- المشترك مع تقارير أخرى كثيرة) من إدراج صف بنفس المصدر وcreated_by مصطنع
-- ينتحل به هوية حساب المزامنة. نفس نمط الحل المستخدم سابقاً لمشكلة مشابهة
-- في ameen-purchase-invoice-reports.sql: جدول مستقل بسياسة INSERT محصورة
-- بحساب المزامنة الموثوق فقط، لا اعتماد على قيمة source وحدها.
--
-- التقرير يُقرأ فقط للحساب الموجود في staff_allowlist عبر public.is_staff().
-- مجرد امتلاك حساب authenticated لا يكفي لرؤية كميات المستودعات الحساسة.
--
do $$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'أوقفت التنفيذ: الدالة public.is_staff() غير موجودة. طبّق staff_allowlist ودالة is_staff() أولاً.';
  end if;
end
$$;

create table if not exists public.ameen_warehouse_stock_reports (
  id uuid default gen_random_uuid() primary key,
  report_date date not null default current_date,
  summary jsonb not null default '{}'::jsonb,
  items jsonb not null default '[]'::jsonb,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);

comment on table ameen_warehouse_stock_reports is 'تقرير مخزون مستودع حقيقي واحد بالأمين (dbo.st000) — تقرير مستقل لكل مستودع، كتابة فقط لحساب المزامنة الموثوق، قراءة لكل موظف مسجَّل. لا علاقة بجدول inventory_reports العام.';
comment on column ameen_warehouse_stock_reports.summary is 'ملخص التقرير: warehouseKey (GUID المستودع بالأمين)، warehouseName، item_count، generated_at.';
comment on column ameen_warehouse_stock_reports.items is 'مصفوفة أصناف المستودع: {itemKey, itemGuid, itemNumber, itemName, unitName, qty}.';
comment on column ameen_warehouse_stock_reports.created_by is 'يُختم تلقائياً بـauth.uid() الخاص بالجلسة الكاتبة عند الإدراج، وتتحقق سياسة INSERT أن هذه القيمة تطابق auth.uid() فعلاً وأن الكاتب هو حساب المزامنة الموثوق — يمنع NULL وانتحال هوية أي حساب آخر.';

create index if not exists ameen_warehouse_stock_reports_created_at_idx
  on ameen_warehouse_stock_reports (created_at desc);

alter table ameen_warehouse_stock_reports enable row level security;

-- لا صلاحية افتراضية لأي دور — كل وصول يمر عبر سياسات صريحة أدناه فقط.
revoke all on table public.ameen_warehouse_stock_reports from public, anon, authenticated;
grant select, insert, delete on table public.ameen_warehouse_stock_reports to authenticated;

-- القراءة: موظف موجود في allowlist — نفس سلوك inventory_reports السابق لهذا المصدر،
-- يستخدمها التطبيق لعرض قائمة المستودعات الفعلية وأصنافها عند الجرد.
drop policy if exists "authenticated can select ameen_warehouse_stock_reports" on ameen_warehouse_stock_reports;
create policy "authenticated can select ameen_warehouse_stock_reports"
  on ameen_warehouse_stock_reports for select
  to authenticated
  using (public.is_staff());

-- الكتابة (رفع من الأمين): تقتصر على حساب المزامنة الموثوق فقط — نفس
-- الحساب المستعمل في TOBACCO_SYNC_EMAIL/TOBACCO_SYNC_PASSWORD داخل
-- tools/push-ameen-warehouse-stock.ps1 (السكربت يسجّل دخول Supabase Auth
-- عادياً بهذا الحساب، وليس بمفتاح service-role يتجاوز RLS، فهذه السياسة ضرورية).
--
-- التحقق بالـUUID الثابت لحساب المزامنة الموثوق، لا بالبريد القابل للتغيير.
-- يجب مراجعة هذا UUID قبل تطبيق الملف على أي مشروع Supabase آخر.
create or replace function public.ameen_warehouse_stock_reports_is_sync_writer()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid() = '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid;
$$;

comment on function public.ameen_warehouse_stock_reports_is_sync_writer() is 'يطابق UUID حساب المزامنة الموثوق المستعمل في tools/push-ameen-warehouse-stock.ps1.';

revoke execute on function public.ameen_warehouse_stock_reports_is_sync_writer() from public, anon;
grant execute on function public.ameen_warehouse_stock_reports_is_sync_writer() to authenticated;

-- سياسة INSERT تشترط معاً: (1) المستعمل هو حساب المزامنة الموثوق، و(2)
-- created_by المُرسَل يطابق auth.uid() فعلياً — يمنع إدراج صف بـcreated_by
-- فارغ أو منتحِل لهوية مستخدم آخر حتى لو كان الطالب هو حساب المزامنة نفسه.
drop policy if exists "sync writer can insert ameen_warehouse_stock_reports" on ameen_warehouse_stock_reports;
create policy "sync writer can insert ameen_warehouse_stock_reports"
  on ameen_warehouse_stock_reports for insert
  to authenticated
  with check (
    public.ameen_warehouse_stock_reports_is_sync_writer()
    and created_by = auth.uid()
  );

-- لا سياسة UPDATE: السكربت يُدرج تقريراً جديداً ولا يعدّل صفاً موجوداً.
-- DELETE محصور بحساب المزامنة. التنظيف الدوري لا يستخدم REST مباشرة؛
-- الهجرة 20260928140000_prune_ameen_warehouse_stock_reports تعرّف دالة
-- تحذف دفعة من الصفوف غير المرتبطة بجلسة جرد. لا تُطبَّق تلقائياً.
drop policy if exists "sync writer can delete ameen_warehouse_stock_reports" on public.ameen_warehouse_stock_reports;
create policy "sync writer can delete ameen_warehouse_stock_reports"
  on public.ameen_warehouse_stock_reports for delete
  to authenticated
  using (public.ameen_warehouse_stock_reports_is_sync_writer());

-- ---------- تعليمات التطبيق (لا تُنفَّذ هنا) ----------
-- 1. راجع UUID حساب المزامنة الموثوق أعلاه قبل التطبيق.
-- 2. طبّق هذا الملف عبر Supabase SQL editor أو psql — لم يُطبَّق تلقائياً بهذه الجلسة.
--    يتطلب وجود public.is_staff() وstaff_allowlist المطبّقين في المشروع.
-- 3. بعد التطبيق: يجب تحديث tools/push-ameen-warehouse-stock.ps1 ليكتب على
--    هذا الجدول بدل inventory_reports (تم تحديثه بالفعل بهذا التغيير)، وتفريغ
--    أي صفوف قديمة بمصدر ameen_warehouse_stock من inventory_reports يدوياً إن رغبت
--    (اختياري — لا تُقرأ بعد الآن من هذا المصدر بعد تطبيق هذا الملف والتغييرات المرتبطة).
