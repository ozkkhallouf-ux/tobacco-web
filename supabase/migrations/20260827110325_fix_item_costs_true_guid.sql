-- العمود القديم item_guid في item_costs كان في الحقيقة مفتاح تطابق (GUID أو كود أو اسم) وليس
-- دائماً GUID فعلي؛ نعيد تسميته match_key (يبقى المفتاح الأساسي لمنع التكرار عند الرفع، وهو
-- عمود إلزامي non-null بحكم push-item-costs.ps1) ونضيف عمود item_guid حقيقي (GUID الأمين
-- فقط أو NULL) يستخدمه تطابق شاشة التسعير بالمعرّف بدل مفتاح التطابق العام.
--
-- الترحيل آمن للتشغيل المتكرر: إعادة التسمية تُنفَّذ فقط إن كان العمود القديم item_guid ما يزال
-- موجوداً وmatch_key غير موجود بعد (أي لم يُطبَّق الترحيل من قبل)، والباقي idempotent بالكامل.
--
-- ============================================================
-- Codex P1 (PR #228, 2026-09-15): fresh-DB verify-or-skip
-- ============================================================
-- No CREATE TABLE for public.item_costs exists in active migration history
-- or in tracked out-of-band supabase/*.sql. Inventing DDL from the
-- push-item-costs.ps1 upsert shape is forbidden (same rule as other #228
-- placeholders that refuse unsafe invented schemas; cost-leak risk).
--
-- When the table is absent (fresh DB / feature never bootstrapped): NOTICE
-- no-op so replay can reach audit bootstrap 20260830141802.
-- When present: apply the original rename + add column logic unchanged.
-- Production Stage 2: this version is already recorded → CLI skips the file.
-- Does NOT claim a standalone end-to-end product bootstrap.
-- ============================================================

do $$
begin
  if to_regclass('public.item_costs') is null then
    raise notice
      'fix_item_costs_true_guid (20260827110325): public.item_costs absent — treating as fresh-DB / out-of-band feature path; history-safe no-op (will not invent CREATE TABLE; no baseline DDL in repo).';
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'item_costs' and column_name = 'item_guid'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'item_costs' and column_name = 'match_key'
  ) then
    alter table public.item_costs rename column item_guid to match_key;
  end if;

  alter table public.item_costs add column if not exists item_guid text;
  create index if not exists idx_item_costs_item_guid on public.item_costs(item_guid) where item_guid is not null;
  raise notice 'fix_item_costs_true_guid (20260827110325): item_costs present — applied match_key rename (if needed) and item_guid column/index (idempotent).';
end;
$$;
