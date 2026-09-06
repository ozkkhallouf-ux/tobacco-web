-- P3-1: حذف الـindexes المكررة (redundant)
-- 2026-09-02
--
-- ════════════════════════════════════════════════════════════════════════════
-- السبب الجذري
-- ════════════════════════════════════════════════════════════════════════════
-- وُجِد index عادي (plain btree) على نفس العمود الذي يملك UNIQUE index بالفعل.
-- UNIQUE index يُغطِّي وظيفة الـplain index بالكامل (يمكن استخدامه لأي SELECT
-- على نفس العمود). الـindex المكرر يضيف:
--   • حجماً زائداً في القرص
--   • تكلفة write overhead على كل INSERT/UPDATE
--   • إرباكاً في خطط الـquery planner
-- ولا يُضيف شيئاً وظيفياً.
--
-- ════════════════════════════════════════════════════════════════════════════
-- الـindexes المحذوفة
-- ════════════════════════════════════════════════════════════════════════════
--
--  ┌──────────────────────────────────────────────┬──────────────────────────┐
--  │ index مكرر (يُحذَف)                          │ UNIQUE index البديل      │
--  ├──────────────────────────────────────────────┼──────────────────────────┤
--  │ customer_credit_limits_customer_key_idx       │ customer_credit_limits   │
--  │ btree(customer_key) — plain                   │ _customer_key_key        │
--  │                                               │ btree(customer_key) UNIQ │
--  ├──────────────────────────────────────────────┼──────────────────────────┤
--  │ idx_prices_product_id                         │ prices_product_id_key    │
--  │ btree(product_id) — plain                     │ btree(product_id) UNIQ   │
--  └──────────────────────────────────────────────┴──────────────────────────┘
--
-- كلا الجدولين فارغان (0 صفوف) والـindexes لم تُستخدَم قط (idx_scan=0).
-- إحصائيات stats_reset=NULL (لم تُعَد منذ إنشاء الDB) — القيمة موثوقة.
--
-- مصدر الـaudit: P3-1 — 2026-09-02
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. customer_credit_limits ──────────────────────────────────────────────
DROP INDEX IF EXISTS public.customer_credit_limits_customer_key_idx;

-- ── 2. prices ─────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.idx_prices_product_id;

-- ══════════════════════════════════════════════════════════════════════════
-- تحقق ذاتي: UNIQUE indexes البديلة ما زالت موجودة
-- ══════════════════════════════════════════════════════════════════════════

DO $$
declare
  v_count int;
begin
  select count(*) into v_count
    from pg_indexes
   where schemaname = 'public'
     and indexname in (
       'customer_credit_limits_customer_key_key',
       'prices_product_id_key'
     );

  if v_count <> 2 then
    raise exception
      'P3-1: توقَّعنا UNIQUE index بديلَين (2)، وجدنا % — لا تكتمل الـmigration',
      v_count;
  end if;

  -- تأكد أن الـindexes المكررة حُذِفت فعلاً
  select count(*) into v_count
    from pg_indexes
   where schemaname = 'public'
     and indexname in (
       'customer_credit_limits_customer_key_idx',
       'idx_prices_product_id'
     );

  if v_count > 0 then
    raise exception
      'P3-1: لا يزال % من الـindexes المكررة موجوداً بعد الحذف — راجع الـmigration',
      v_count;
  end if;

  raise notice 'P3-1 ✓: حُذف index مكرر × 2 · UNIQUE indexes البديلة سليمة × 2';
end $$;
