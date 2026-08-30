-- ============================================================
-- OZK TOBACCO — جدول حركة المصاريف (دفعات الصرف)
-- شغّل هذا الملف في Supabase → SQL Editor → New query
--
-- يتغذّى من tools/push-expense-entries.ps1 على جهاز Windows، اللي
-- بيقرأ قيود en000 المسجّلة على حسابات المصاريف بشجرة حسابات الأمين
-- (ac000، الحساب الأب "المصاريف" GUID 6AE0066F-D39E-4805-83D5-
-- B8DA92F7D7F1) — مو نوع فاتورة منفصل، بل قيود محاسبية عادية.
--
-- مصدر قسم "🧾 المصاريف اليوم" بالتقرير المسائي (send_evening_report).
--
-- ⚠️ تحديث أمني (2026-08-30، ملاحظة Codex P1 على PR #140):
-- كان هذا الملف تاريخياً ينشئ سياسات "expense_entries_*_authenticated"
-- مفتوحة (using(true)/with check(true)) — أي حساب authenticated يقرأ/
-- يضيف/يحذف بحرية كاملة. الإصلاح الحي طُبِّق عبر
-- supabase/migrations/20260830144330_expense_entries_owner_only_rls.sql
-- (سياسات is_owner()، محدود لحساب owner فقط — راجع ذلك الملف لتفاصيل
-- التحقيق والتبرير الكامل)، لكن هذا الملف المرجعي بقي غير محدَّث.
--
-- الخطر الذي أصلحه هذا التحديث: PostgreSQL يجمع سياسات RLS المتعددة
-- لنفس العملية بمنطق OR — فلو أُعيد تشغيل هذا الملف على قاعدة (جديدة أو
-- بعد الـmigration، بالخطأ أو لإعادة تجهيز) وهو لا يزال ينشئ سياسات
-- مفتوحة بأسماء مختلفة عن سياسات is_owner()، لكانت السياسة المفتوحة
-- تتعايش مع سياسة is_owner() وتُعيد فتح الوصول للجميع رغم وجود الإصلاح.
-- الحل: هذا الملف الآن ينشئ **نفس أسماء وسياسات** الـmigration حرفياً،
-- ويسقط أي سياسة قديمة (بالاسمين القديم والجديد) قبل الإنشاء — فتشغيله
-- بأي ترتيب (قبل الـmigration أو بعدها أو بدلاً منها على قاعدة جديدة)
-- ينتج نفس الحالة الآمنة النهائية دائماً، بلا احتمال تعايش سياسات.
-- ============================================================

create table if not exists public.expense_entries (
  id bigserial primary key,
  entry_date date not null,
  account_name text not null,
  amount numeric not null,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.expense_entries enable row level security;

-- ── متطلّب مسبق: دالة صلاحية المالك ──────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_owner()') is null then
    raise exception
      'أوقفت التنفيذ: الدالة public.is_owner() غير موجودة. طبّق owner-role-access.sql أولاً.';
  end if;
end $$;

-- إسقاط أي سياسة قديمة (الاسم المفتوح القديم قبل 2026-08-30) — يضمن عدم
-- تعايش سياسة مفتوحة مع سياسة is_owner() الجديدة عبر منطق OR.
drop policy if exists "expense_entries_select_authenticated" on public.expense_entries;
drop policy if exists "expense_entries_insert_authenticated" on public.expense_entries;
drop policy if exists "expense_entries_delete_authenticated" on public.expense_entries;

-- إسقاط النسخة الحالية قبل إعادة الإنشاء — يجعل تشغيل هذا الملف idempotent
-- (قابلاً للتكرار الآمن) على قاعدة نُفِّذت عليها الـmigration مسبقاً.
drop policy if exists "expense_entries_owner_select" on public.expense_entries;
drop policy if exists "expense_entries_owner_insert" on public.expense_entries;
drop policy if exists "expense_entries_owner_delete" on public.expense_entries;

create policy "expense_entries_owner_select" on public.expense_entries
  for select to authenticated using (public.is_owner());

create policy "expense_entries_owner_insert" on public.expense_entries
  for insert to authenticated with check (public.is_owner());

create policy "expense_entries_owner_delete" on public.expense_entries
  for delete to authenticated using (public.is_owner());

-- سحب امتيازات الجدول من anon/public — دفاع بالعمق (نفس منطق الـmigration
-- وshared-documents-anon-lockdown.sql: RLS يحجب anon اليوم لغياب سياسة له،
-- لكن الامتياز الخام لا يُترك متاحاً بانتظار سياسة مستقبلية عن طريق الخطأ).
revoke all privileges on table public.expense_entries from anon;
revoke all privileges on table public.expense_entries from public;
revoke all privileges on table public.expense_entries from authenticated;
grant select, insert, delete on table public.expense_entries to authenticated;

create index if not exists idx_expense_entries_date on public.expense_entries (entry_date desc);
