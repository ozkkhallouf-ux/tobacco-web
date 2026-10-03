-- ============================================================================
-- جدولة تنبيهات النفاد حسب أولوية المبيعات من pg_cron بدل GitHub Actions.
--
-- السبب (2026-10-03): جدولة GitHub (`*/15 * * * *` في stock-priority-alerts.yml)
-- غير مضمونة؛ في أول 6 ساعات بعد التفعيل شغّلت التنبيه تلقائياً مرة واحدة بدل نحو 25.
--
-- القواعد لا تُكرَّر هنا: المحرك src/stock-alert-priority.js تحمّله الدالة الطرفية
-- stock-priority-alerts من ../_shared. هذا الملف جدولة فقط، بنمط
-- dispatch_customer_inactivity_alert: رمز من app_secrets في رأس
-- X-OZK-Stock-Alert-Token، وغياب الرمز يجعل الجدولة عملية فارغة.
-- منع التكرار باقٍ في notify_telegram (dedupe_key + 360 دقيقة)، فتشغيل GitHub
-- وpg_cron معاً أثناء الانتقال لا يكرّر الرسالة.
--
-- لا جدول جديد ولا تعديل على notify_telegram. لا علاقة بقاعدة الأمين.
-- ============================================================================

create or replace function public.dispatch_stock_priority_alerts()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  alert_token text;
begin
  select value into alert_token from public.app_secrets where name = 'stock_priority_alert_token' limit 1;
  if alert_token is null or alert_token = '' then return; end if;

  perform net.http_post(
    url := 'https://dyxbirfpxeocqffnfdeb.supabase.co/functions/v1/stock-priority-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-OZK-Stock-Alert-Token', alert_token
    ),
    body := jsonb_build_object('action', 'check')
  );
end;
$$;
revoke all on function public.dispatch_stock_priority_alerts() from public, anon, authenticated;

do $$
begin
  -- قاعدة بلا pg_cron (إعادة تشغيل محلية أو فرع معاينة): الدالة تُنشأ، والجدولة تُتخطّى.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'stock-priority-alerts: pg_cron absent, skipping schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'stock-priority-alerts') then
    perform cron.unschedule('stock-priority-alerts');
  end if;
  perform cron.schedule('stock-priority-alerts', '*/15 * * * *', 'select public.dispatch_stock_priority_alerts();');
end $$;
