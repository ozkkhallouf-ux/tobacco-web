-- khalil_audit_tables_explicit_deny — 2026-09-02
--
-- السبب: khalil_audit_cursor وkhalil_audit_notify_failures يملكان RLS مفعَّلاً
-- بلا أي policy، مما يُطلق تحذير Security Advisor (rls_enabled_no_policy/INFO).
-- التصميم الحالي صحيح وآمن فعلاً:
--   1. REVOKE ALL من public/anon/authenticated/service_role طُبِّق عند إنشاء الجداول
--      — لا مستخدم عادي يملك table-level privilege أصلاً.
--   2. الوصول الوحيد عبر دوال SECURITY DEFINER تعمل بصلاحية postgres (صاحب الجدول)،
--      وصاحب الجدول يتجاوز RLS تلقائياً بلا policies.
--   3. النتيجة الفعلية لـ"RLS + لا policies": SELECT يعيد صفر صفوف، INSERT/UPDATE/DELETE
--      مرفوضة — وهو بالضبط ما نريده.
--
-- هذا المigration لا يغيّر السلوك الفعلي، يضيف فقط سياستَي RESTRICTIVE USING(false)
-- توثيقاً صريحاً للنية ويُسكت تحذير Security Advisor الذي يفترض خطأً أن غياب
-- الـpolicies نسيان لا قصد.
--
-- الدوال المتأثرة (SECURITY DEFINER — تبقى غير متأثرة لأنها تعمل كـpostgres):
--   public.get_khalil_audit_cursor        → authenticated, service_role
--   public.record_khalil_audit_event      → authenticated, service_role
--   public.update_khalil_audit_overlap_floor → authenticated, service_role
--   private.record_khalil_audit_notify_failure → postgres فقط
--   private.retry_khalil_audit_notify_failures → postgres فقط

-- ========== khalil_audit_cursor ==========

ALTER TABLE public.khalil_audit_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no_direct_access_cursor" ON public.khalil_audit_cursor;

CREATE POLICY "no_direct_access_cursor"
  ON public.khalil_audit_cursor
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- ========== khalil_audit_notify_failures ==========

ALTER TABLE public.khalil_audit_notify_failures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no_direct_access_failures" ON public.khalil_audit_notify_failures;

CREATE POLICY "no_direct_access_failures"
  ON public.khalil_audit_notify_failures
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- التحقق الذاتي: كلا الجدولين يجب أن يملكا الآن policy واحدة على الأقل
DO $$
declare
  cursor_count int;
  failures_count int;
begin
  select count(*) into cursor_count
    from pg_policies
   where schemaname = 'public' and tablename = 'khalil_audit_cursor';

  select count(*) into failures_count
    from pg_policies
   where schemaname = 'public' and tablename = 'khalil_audit_notify_failures';

  if cursor_count < 1 then
    raise exception 'khalil_audit_cursor: expected ≥1 policy, found %', cursor_count;
  end if;

  if failures_count < 1 then
    raise exception 'khalil_audit_notify_failures: expected ≥1 policy, found %', failures_count;
  end if;
end $$;
