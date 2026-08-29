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

create or replace function public.upsert_ameen_daily_profit(
  p_report_date date,
  p_summary jsonb,
  p_items jsonb,
  p_created_by uuid
) returns public.inventory_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_reports;
begin
  insert into public.inventory_reports (source, report_date, summary, items, created_by)
  values ('ameen_daily_profit', p_report_date, p_summary, p_items, p_created_by)
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

grant execute on function public.upsert_ameen_daily_profit(date, jsonb, jsonb, uuid) to authenticated, service_role;
