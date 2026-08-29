-- ============================================================
-- ameen-daily-profit-atomic-upsert.sql
-- نسخة مرجعية لموضوع upsert ذرّي لتقرير ameen_daily_profit في inventory_reports.
-- طُبِّق فعلياً على قاعدة Supabase عبر migration باسم
-- atomic_upsert_ameen_daily_profit — هذا الملف توثيق فقط، لا يُشغَّل تلقائياً.
--
-- السبب: tools/push-daily-profit.ps1 يُستدعى من مهمتي Windows
-- TOBACCO Ameen Sync و TOBACCO Sales Line Items Push، وقد تتزامن الاثنتان.
-- النمط القديم (INSERT ثم DELETE للأقدم بمعرّف الصف الجديد) يفتح نافذة
-- تزامن حقيقية: تشغيلان متزامنان قد يحذف كل منهما صفّ الآخر فيبقى اليوم
-- بلا أي تقرير ربح. الحل هنا ينقل الحسم إلى Postgres بجملة SQL واحدة ذرّية،
-- فلا توجد أي لحظة بين "إدراج" و"حذف" يمكن أن يتداخل معها تشغيل آخر.
-- ============================================================

-- فهرس فريد جزئي: لا يفرض فرادة إلا على صفوف ameen_daily_profit، فلا يؤثر
-- على بقية المصادر التي تحتفظ عمداً بعدة صفوف لنفس (source, report_date)
-- كسجل تاريخي (ameen_customer_balances، daily_movement_reports، ...).
create unique index if not exists inventory_reports_ameen_daily_profit_date_uidx
  on public.inventory_reports (report_date)
  where source = 'ameen_daily_profit';

-- ملاحظة أمنية (Codex P1، 2026-08-29): GRANT وحدها لا تكفي — Postgres يمنح
-- EXECUTE لـPUBLIC تلقائياً على أي دالة جديدة ما لم تُسحب صراحة. بما أن هذه
-- الدالة SECURITY DEFINER، فبقاء PUBLIC ممنوحاً كان يسمح لأي مستخدم مصادَق
-- (أو anon حسب صلاحيات الـschema) باستدعائها وتجاوز RLS على inventory_reports.
-- الإصلاح: REVOKE صريح من PUBLIC، وإسقاط معامل created_by المُرسَل من العميل
-- (كان قابلاً للتزوير بأي UUID) واشتقاقه من auth.uid() داخل الدالة نفسها.
create or replace function public.upsert_ameen_daily_profit(
  p_report_date date,
  p_summary jsonb,
  p_items jsonb
) returns public.inventory_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_reports;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'upsert_ameen_daily_profit requires an authenticated caller';
  end if;

  insert into public.inventory_reports (source, report_date, summary, items, created_by)
  values ('ameen_daily_profit', p_report_date, p_summary, p_items, v_uid)
  on conflict (report_date) where source = 'ameen_daily_profit'
  do update set
    summary = excluded.summary,
    items = excluded.items,
    created_by = excluded.created_by,
    created_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.upsert_ameen_daily_profit(date, jsonb, jsonb) from public;
grant execute on function public.upsert_ameen_daily_profit(date, jsonb, jsonb) to authenticated, service_role;
