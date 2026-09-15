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
--
-- ============================================================
-- Codex P1 (PR #228, 2026-09-15): verify-or-skip on fresh replay
-- ============================================================
-- Active migration history may create approved_price_items (20260827110254)
-- without the three feed/health views — those live in out-of-band
-- supabase/*.sql (and bot_health_alerts is also recreated later in
-- 20260914130000). Unconditional REVOKE/ALTER/GRANT against absent views
-- aborted clean replay. Each step below runs only when the view exists;
-- absent → NOTICE no-op (will not invent view DDL here).

do $audit$
declare
  v_anon_available text;
  v_bot_invoker    text;
begin
  -- ── 1. available_price_sync_feed — least-privilege SELECT only ──────────
  if to_regclass('public.available_price_sync_feed') is null then
    raise notice
      'p2_security_definer_views_audit (20260902070000): available_price_sync_feed absent — treating as fresh-DB / out-of-band feature path; skipping REVOKE/GRANT (will not invent view DDL).';
  else
    execute 'revoke all on public.available_price_sync_feed from anon';
    execute 'revoke all on public.available_price_sync_feed from authenticated';
    execute 'grant select on public.available_price_sync_feed to anon';
    execute 'grant select on public.available_price_sync_feed to authenticated';
    execute $c$
      comment on view public.available_price_sync_feed is
        'نشرة أسعار عامة مُصفَّاة للمواد ذات المخزون الموجب — SECURITY DEFINER مقصود لنفس سبب approved_price_sync_feed. الصلاحيات: SELECT فقط لـanon وauthenticated (تمّ تصحيح drift كان يمنح DML زائداً).'
    $c$;

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
  end if;

  -- ── 2. bot_health_alerts — security_invoker=on ─────────────────────────
  if to_regclass('public.bot_health_alerts') is null then
    raise notice
      'p2_security_definer_views_audit (20260902070000): bot_health_alerts absent — treating as fresh-DB / out-of-band feature path; skipping ALTER VIEW (later 20260914130000 recreates with security_invoker when applied).';
  else
    execute 'alter view public.bot_health_alerts set (security_invoker = on)';
    execute $c$
      comment on view public.bot_health_alerts is
        'مراقبة صحة البوت — security_invoker=on مفعَّل (2026-09-02). الـRLS على الجداول الأصلية يسمح للـstaff بالقراءة؛ غير الـstaff يحصلون على صفر صفوف بسبب WHERE is_staff() في نهاية الـview. لا يعرض بيانات خام، فقط أعداد وطوابع زمنية مجمَّعة.'
    $c$;

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
  end if;

  -- ── 3. approved_price_sync_feed — GRANT SELECT documentation only ──────
  if to_regclass('public.approved_price_sync_feed') is null then
    raise notice
      'p2_security_definer_views_audit (20260902070000): approved_price_sync_feed absent — treating as fresh-DB / out-of-band feature path; skipping GRANT/COMMENT (will not invent view DDL).';
  else
    execute 'grant select on public.approved_price_sync_feed to anon';
    execute 'grant select on public.approved_price_sync_feed to authenticated';
    execute $c$
      comment on view public.approved_price_sync_feed is
        'نشرة أسعار عامة — SECURITY DEFINER مقصود: approved_price_items لديه RLS staff-only، والـview يتجاوزه عمداً ليتيح قراءة الأسعار لـanon بلا مصادقة. تحويله إلى security_invoker يكسر مولّد PDF ومزامنة الأسعار.'
    $c$;
  end if;
end;
$audit$;
