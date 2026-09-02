-- P2-3: auth_rls_initplan — khalil_audit_sync_heartbeat
-- 2026-09-02
--
-- ════════════════════════════════════════════════════════════════════════════
-- السبب الجذري
-- ════════════════════════════════════════════════════════════════════════════
-- Supabase Performance Advisor يُعلِم بـWARN (auth_rls_initplan) على جدول
-- public.khalil_audit_sync_heartbeat بسبب استدعاء مباشر لـauth.uid() داخل
-- WITH CHECK للـINSERT policy:
--
--   WITH CHECK (khalil_audit_is_sync_writer() AND (created_by = auth.uid()))
--                                                              ^^^^^^^^^^^
--   المشكلة: auth.uid() مُستدعى مباشرةً — لا يُولِّد InitPlan
--            فيُعيد PostgreSQL تقييمه لكل row مُدرَجة بدل مرة واحدة.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الفحص الكامل للـpolicies على الجدول
-- ════════════════════════════════════════════════════════════════════════════
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ policy                        │ cmd    │ qual / with_check               │
-- ├──────────────────────────────────────────────────────────────────────────┤
-- │ owners can read ...heartbeat  │ SELECT │ is_staff()            → سليمة   │
-- │ only sync writer can insert.. │ INSERT │ khalil_audit_is_sync_writer()   │
-- │                               │        │ AND created_by = auth.uid()     │
-- │                               │        │                       → مشكلة  │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- ملاحظة: khalil_audit_is_sync_writer() تستدعي (select auth.uid()) داخلياً
-- بشكل صحيح — لكن ذلك لا يُصلح الاستدعاء المنفصل لـauth.uid() في
-- WITH CHECK؛ كل استدعاء يُقيَّم باستقلالية.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الإصلاح
-- ════════════════════════════════════════════════════════════════════════════
-- قبل: created_by = auth.uid()
-- بعد: created_by = (SELECT auth.uid())
--
-- تأثير الإصلاح:
--   • السلوك الأمني: لا يتغير — الشرط نفسه، نفس المنطق، نفس القيمة
--   • الأداء: PostgreSQL يُقيِّم auth.uid() مرة واحدة (InitPlan)
--             ويُخزِّن نتيجتها في الـquery plan بدل re-evaluation لكل row
--   • يُسكِت تحذير auth_rls_initplan في Performance Advisor

-- ── DROP الـpolicy القديمة ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "only sync writer can insert khalil audit heartbeat"
  ON public.khalil_audit_sync_heartbeat;

-- ── إعادة إنشاء بالـwrapper الصحيح ────────────────────────────────────────
CREATE POLICY "only sync writer can insert khalil audit heartbeat"
  ON public.khalil_audit_sync_heartbeat
  FOR INSERT
  TO authenticated
  WITH CHECK (
    khalil_audit_is_sync_writer()
    AND (created_by = (SELECT auth.uid()))
  );

-- ── تحقق ذاتي ──────────────────────────────────────────────────────────────
DO $$
declare
  v_with_check text;
  v_count      int;
begin
  -- 1. تأكد أن الـpolicy موجودة
  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'khalil_audit_sync_heartbeat'
     and policyname = 'only sync writer can insert khalil audit heartbeat'
     and cmd        = 'INSERT';

  if v_count <> 1 then
    raise exception
      'khalil_audit_sync_heartbeat: INSERT policy غير موجودة بعد الإنشاء (count=%)',
      v_count;
  end if;

  -- 2. تأكد أن with_check تحتوي على (SELECT auth.uid()) وليس auth.uid() مجرداً
  select with_check into v_with_check
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'khalil_audit_sync_heartbeat'
     and policyname = 'only sync writer can insert khalil audit heartbeat';

  -- pg_policies.with_check يعرض النص المُولَّد — نبحث عن النمط الصحيح
  -- كلا النمطين SELECT auth.uid() و(select auth.uid()) مقبولان
  if v_with_check not ilike '%select auth.uid()%' then
    raise exception
      'khalil_audit_sync_heartbeat: with_check لا يحتوي على (SELECT auth.uid()): %',
      v_with_check;
  end if;

  -- 3. تأكد أن SELECT policy (owners can read) لا تزال موجودة وسليمة
  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'khalil_audit_sync_heartbeat'
     and policyname = 'owners can read khalil audit heartbeat'
     and cmd        = 'SELECT';

  if v_count <> 1 then
    raise exception
      'khalil_audit_sync_heartbeat: SELECT policy اختفت — عدد=%',
      v_count;
  end if;

end $$;
