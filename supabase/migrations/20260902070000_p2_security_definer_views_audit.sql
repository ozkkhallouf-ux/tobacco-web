-- P2-2: Security Definer Views — Audit & Fix
-- 2026-09-02
--
-- ════════════════════════════════════════════════════════════════════════════
-- السبب الجذري
-- ════════════════════════════════════════════════════════════════════════════
-- كل view في PostgreSQL تعمل كـSECURITY DEFINER بشكل افتراضي (تُنفَّذ باسم
-- المالك = postgres). Supabase Security Advisor يُعلم بمستوى ERROR على أي view
-- لا تحمل خاصية security_invoker=on لأنها تتجاوز RLS على الجداول الأصلية.
--
-- الـ3 views المُعلَّم عليها:
--   ┌─────────────────────────────┬───────────────────────────────────────────┐
--   │ approved_price_sync_feed    │ عمد — نشرة أسعار عامة (لا تُصلَح بتغيير  │
--   │                             │ security_invoker: ستكسر وصول anon)        │
--   ├─────────────────────────────┼───────────────────────────────────────────┤
--   │ available_price_sync_feed   │ عمد — نفس التصميم + إصلاح حقيقي: زيادة  │
--   │                             │ صلاحيات DML لـanon/authenticated في Prod  │
--   │                             │ مقارنة بما في ملفات الـrepo (drift)        │
--   ├─────────────────────────────┼───────────────────────────────────────────┤
--   │ bot_health_alerts           │ يمكن تحويلها إلى security_invoker=on بأمان│
--   │                             │ — تُسكت تحذير Security Advisor بلا أثر   │
--   └─────────────────────────────┴───────────────────────────────────────────┘
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا لا يمكن تحويل price feeds إلى security_invoker؟
-- ════════════════════════════════════════════════════════════════════════════
-- approved_price_items: RLS مفعَّل + سياسات تشترط is_staff(). anon لا يحقق
-- is_staff() أبداً. لو فُعِّل security_invoker ستُنفَّذ الـview بصلاحية anon
-- → RLS يُعيد صفراً صفوف → تتوقف نشرة الأسعار ومولّد الـPDF.
-- الحل الصحيح: إبقاء SECURITY DEFINER (الإعداد الافتراضي) + توثيق النية.
-- تحذير Security Advisor على هاتين الـview هو false-positive في هذا التصميم.
--
-- ════════════════════════════════════════════════════════════════════════════
-- لماذا آمن تحويل bot_health_alerts إلى security_invoker؟
-- ════════════════════════════════════════════════════════════════════════════
-- الـview تُرجع صفوفاً فقط عند WHERE is_staff() في النهاية. عند التحويل:
--   - telegram_outbox: authenticated (غير inventory_counter) يقرأه عبر RLS ✓
--   - inventory_reports: is_staff() = true في RLS policy → staff يقرأه ✓
--   - sales_line_items: authenticated can select (USING true) ✓
--   - approved_price_items: is_staff() في RLS policy → staff يقرأه ✓
-- النتيجة: لا تغيير في السلوك لأي مستخدم، لكن Security Advisor يُسكَت.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. available_price_sync_feed — إصلاح حقيقي: تصحيح الصلاحيات الزائدة
-- ══════════════════════════════════════════════════════════════════════════
-- الإنتاج الحالي: anon=arwdDxtm و authenticated=arwdDxtm (INSERT/UPDATE/DELETE
-- وغيرها). ملف الـrepo يُعرِّف فقط GRANT SELECT. الصلاحيات الزائدة غير ضارة
-- وظيفياً (الـview غير قابلة للكتابة) لكنها تنتهك مبدأ least-privilege.

REVOKE ALL ON public.available_price_sync_feed FROM anon;
REVOKE ALL ON public.available_price_sync_feed FROM authenticated;
GRANT SELECT ON public.available_price_sync_feed TO anon;
GRANT SELECT ON public.available_price_sync_feed TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. bot_health_alerts — تحويل إلى security_invoker لإسكات Security Advisor
-- ══════════════════════════════════════════════════════════════════════════

ALTER VIEW public.bot_health_alerts SET (security_invoker = on);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. approved_price_sync_feed — توثيق صريح فقط (لا تغيير وظيفي)
-- ══════════════════════════════════════════════════════════════════════════
-- الإنتاج الحالي: anon=r (SELECT فقط) — صحيح. GRANT SELECT صريح للتوثيق
-- وضمان الإيدمبوتنسي لو أُعيد إنشاء الـview مستقبلاً.

GRANT SELECT ON public.approved_price_sync_feed TO anon;
GRANT SELECT ON public.approved_price_sync_feed TO authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. تعليقات توثيق النية على الـ3 views
-- ══════════════════════════════════════════════════════════════════════════

COMMENT ON VIEW public.approved_price_sync_feed IS
  'نشرة أسعار عامة — SECURITY DEFINER مقصود: approved_price_items لديه RLS staff-only، والـview يتجاوزه عمداً ليتيح قراءة الأسعار لـanon بلا مصادقة. تحويله إلى security_invoker يكسر مولّد PDF ومزامنة الأسعار.';

COMMENT ON VIEW public.available_price_sync_feed IS
  'نشرة أسعار عامة مُصفَّاة للمواد ذات المخزون الموجب — SECURITY DEFINER مقصود لنفس سبب approved_price_sync_feed. الصلاحيات: SELECT فقط لـanon وauthenticated (تمّ تصحيح drift كان يمنح DML زائداً).';

COMMENT ON VIEW public.bot_health_alerts IS
  'مراقبة صحة البوت — security_invoker=on مفعَّل (2026-09-02). الـRLS على الجداول الأصلية يسمح للـstaff بالقراءة؛ غير الـstaff يحصلون على صفر صفوف بسبب WHERE is_staff() في نهاية الـview. لا يعرض بيانات خام، فقط أعداد وطوابع زمنية مجمَّعة.';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. تحقق ذاتي
-- ══════════════════════════════════════════════════════════════════════════

DO $$
declare
  v_anon_available  text;
  v_anon_approved   text;
  v_bot_invoker     text;
begin
  -- تحقق من صلاحيات available_price_sync_feed لـanon: يجب أن تكون r فقط
  select array_to_string(relacl, ',') into v_anon_available
    from pg_class
   where relname = 'available_price_sync_feed'
     and relnamespace = 'public'::regnamespace;

  if v_anon_available like '%anon=arwdDxtm%'
  or v_anon_available like '%anon=aw%'
  or v_anon_available like '%anon=rw%' then
    raise exception
      'available_price_sync_feed: anon لا يزال يملك صلاحيات DML زائدة: %',
      v_anon_available;
  end if;

  -- تحقق من security_invoker على bot_health_alerts
  select option_value into v_bot_invoker
    from pg_options_to_table((
      select reloptions from pg_class
       where relname = 'bot_health_alerts'
         and relnamespace = 'public'::regnamespace
    ))
   where option_name = 'security_invoker';

  if coalesce(lower(v_bot_invoker), '') not in ('on', 'true') then
    raise exception
      'bot_health_alerts: security_invoker لم يُفعَّل — القيمة الحالية: %',
      coalesce(v_bot_invoker, 'NULL');
  end if;

end $$;
