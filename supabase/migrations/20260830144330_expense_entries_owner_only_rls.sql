-- ============================================================
-- OZK TOBACCO — expense_entries: تقييد الوصول بـ is_owner() فقط
--
-- الوضع الحالي (مؤكَّد بفحص حي مباشر على Supabase، 2026-08-30):
--   for select to authenticated using (true);
--   for insert to authenticated with check (true);
--   for delete to authenticated using (true);
-- أي حساب "authenticated" (بصرف النظر عن دوره) يقدر يقرأ/يضيف/يحذف قيود
-- مصاريف مالية بحرية كاملة. هذا الجدول هو الاستثناء الوحيد بالمخطط بلا أي
-- تقييد دور.
--
-- لماذا is_owner() لا is_staff(): تحقّقتُ فعليًا (لا افتراضًا) أن:
--   • لا يوجد أي مستهلك حالي لصلاحية SELECT عبر RLS إطلاقًا — التقارير
--     (send_evening_report/send_morning_report/send_evening_cash_report)
--     كلها SECURITY DEFINER تتجاوز RLS، وEdge Function
--     financial-assistant يستخدم SUPABASE_SERVICE_ROLE_KEY ويتجاوزه أيضًا.
--     لا وجود لـexpense_entries في src/ إطلاقًا (grep بصفر نتائج).
--   • الكاتب الوحيد هو tools/push-expense-entries.ps1 عبر حساب
--     TOBACCO_SYNC_EMAIL — تحقّقتُ من قيمته الفعلية على جهاز الويندوز:
--     ozkkhalouf@gmail.com، وهو حساب owner فعلي (auth.users.app_metadata
--     .role = 'owner'، مؤكَّد بالاستعلام المباشر).
--   • is_staff() لا يفرّق بين owner/accountant/employee (فحص ثنائي فقط:
--     هل البريد داخل staff_allowlist؟) — غير مناسب لجدول محاسبي حساس لا
--     يحتاجه أي طرف غير owner فعليًا اليوم.
--
-- الرجوع (Rollback): استبدال السياسات الثلاث بالسياسات المفتوحة الأصلية
-- (انظر أسفل الملف) — أو git revert لهذه الهجرة، لأنها لم تُطبَّق على أي
-- قاعدة إنتاج بعد.
-- ============================================================

-- ── متطلّب مسبق: دالة صلاحية المالك ──────────────────────────────────────
do $$
begin
  if to_regprocedure('public.is_owner()') is null then
    raise exception
      'أوقفت التنفيذ: الدالة public.is_owner() غير موجودة. طبّق owner-role-access.sql أولاً.';
  end if;
end $$;

-- ── 1) استبدال السياسات المفتوحة بسياسات is_owner() ──────────────────────
drop policy if exists "expense_entries_select_authenticated" on public.expense_entries;
drop policy if exists "expense_entries_insert_authenticated" on public.expense_entries;
drop policy if exists "expense_entries_delete_authenticated" on public.expense_entries;

create policy "expense_entries_owner_select" on public.expense_entries
  for select to authenticated using (public.is_owner());

create policy "expense_entries_owner_insert" on public.expense_entries
  for insert to authenticated with check (public.is_owner());

create policy "expense_entries_owner_delete" on public.expense_entries
  for delete to authenticated using (public.is_owner());

-- ── 2) سحب امتيازات الجدول — دفاع بالعمق ─────────────────────────────────
-- anon يملك من منح Supabase الافتراضي امتيازات الجدول كاملة (مؤكَّد
-- بالفحص المباشر: SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER)
-- رغم أن RLS يحجبها اليوم لغياب أي سياسة anon. تُسحب صراحة كي لا يعتمد
-- الأمان على "غياب سياسة" وحده.
revoke all privileges on table public.expense_entries from anon;
revoke all privileges on table public.expense_entries from public;

-- authenticated: القراءة والإدراج والحذف فقط (ما تسمح به السياسات فعلاً).
-- الشخص الذي يمرّ الآن هو owner فقط عبر شرط RLS، لا عبر منح Postgres —
-- منح authenticated لازم يبقى لأن حساب owner نفسه هو authenticated.
revoke all privileges on table public.expense_entries from authenticated;
grant select, insert, delete on table public.expense_entries to authenticated;

alter table public.expense_entries enable row level security;
-- عمداً بلا FORCE ROW LEVEL SECURITY (نفس منطق shared-documents-anon-lockdown.sql):
-- FORCE يُخضع مالك الجدول لسياساته فتُعطي كتلة التحقّق أدناه نجاحاً كاذباً
-- حين تُشغَّل بحساب المالك.

-- ── 3) تحقّق ذاتي بعد التطبيق ──────────────────────────────────────────────
-- has_table_privilege/pg_policies فقط — لا has_policy (غير موجودة أصلاً في
-- PostgreSQL/Supabase).
do $$
declare
  n_open_policy int;
  n_owner_policy int;
  p text;
begin
  -- (أ) لا سياسة متبقية using(true)/with check(true) بلا شرط
  select count(*) into n_open_policy from pg_policies
   where schemaname = 'public' and tablename = 'expense_entries'
     and ((qual is not null and qual = 'true') or (with_check is not null and with_check = 'true'));
  if n_open_policy > 0 then
    raise exception 'ما زالت هناك سياسة مفتوحة (true) على expense_entries.';
  end if;

  -- (ب) السياسات الثلاث الجديدة موجودة وتستخدم is_owner() تحديدًا
  select count(*) into n_owner_policy from pg_policies
   where schemaname = 'public' and tablename = 'expense_entries'
     and policyname in ('expense_entries_owner_select','expense_entries_owner_insert','expense_entries_owner_delete')
     and coalesce(qual, with_check) ilike '%is_owner%';
  if n_owner_policy <> 3 then
    raise exception 'سياسات is_owner() الثلاث غير مكتملة على expense_entries (وُجد %).', n_owner_policy;
  end if;

  -- (ج) RLS مفعّل
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'expense_entries' and c.relrowsecurity) then
    raise exception 'RLS غير مفعّل على expense_entries.';
  end if;

  -- (د) anon بلا أي امتياز فعّال
  foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege('anon', 'public.expense_entries', p) then
      raise exception 'anon ما زال يملك امتياز % على expense_entries.', p;
    end if;
  end loop;

  -- (هـ) authenticated محصور بـSELECT/INSERT/DELETE فقط، بلا UPDATE
  if has_table_privilege('authenticated', 'public.expense_entries', 'UPDATE') then
    raise exception 'authenticated يملك امتياز UPDATE الزائد على expense_entries.';
  end if;
  if not (has_table_privilege('authenticated', 'public.expense_entries', 'SELECT')
      and has_table_privilege('authenticated', 'public.expense_entries', 'INSERT')
      and has_table_privilege('authenticated', 'public.expense_entries', 'DELETE')) then
    raise exception 'authenticated فقد SELECT/INSERT/DELETE — حساب owner (وسكريبت المزامنة) لن يعمل.';
  end if;

  raise notice 'تحقّق ناجح: expense_entries محصور الآن بـis_owner()، ولا امتياز لـanon/public.';
end $$;

-- ============================================================
-- الرجوع اليدوي (Rollback) — لا يُنفَّذ تلقائيًا، للمرجعية فقط:
--
-- drop policy if exists "expense_entries_owner_select" on public.expense_entries;
-- drop policy if exists "expense_entries_owner_insert" on public.expense_entries;
-- drop policy if exists "expense_entries_owner_delete" on public.expense_entries;
-- create policy "expense_entries_select_authenticated" on public.expense_entries
--   for select to authenticated using (true);
-- create policy "expense_entries_insert_authenticated" on public.expense_entries
--   for insert to authenticated with check (true);
-- create policy "expense_entries_delete_authenticated" on public.expense_entries
--   for delete to authenticated using (true);
-- grant select, insert, update, delete, truncate, references, trigger
--   on table public.expense_entries to anon, authenticated;
-- ============================================================
