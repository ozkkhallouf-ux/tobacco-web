-- ============================================================================
-- جدولة تنبيه النفاد حسب أولوية المبيعات بـpg_cron كل 15 دقيقة.
--
-- لماذا: جدولة GitHub Actions (cron '*/15' في .github/workflows/stock-priority-alerts.yml)
-- غير مضمونة؛ يوم 2026-10-03 شغّلها GitHub تلقائياً مرة واحدة في 6 ساعات. قرار المالك:
-- النقل إلى pg_cron بنفس حماية customer-inactivity-alert (رمز في app_secrets).
--
-- لا قواعد هنا: الحساب والرسالة ومنع التكرار (6 ساعات) في src/stock-alert-priority.js،
-- تشغّله الدالة الطرفية stock-priority-alert. هذا الملف دالة استدعاء وجدولة فقط.
--
-- الرمز: صف app_secrets.name = 'stock_priority_alert_token' يُضاف عند التطبيق ولا يُكتب
-- في المستودع. غيابه يجعل الجدولة عملية فارغة. لا تعديل على notify_telegram ولا
-- telegram_outbox، ولا علاقة بقاعدة الأمين.
-- ============================================================================

create or replace function public.dispatch_stock_priority_alert()
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
    url := 'https://dyxbirfpxeocqffnfdeb.supabase.co/functions/v1/stock-priority-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-OZK-Stock-Alert-Token', alert_token
    ),
    body := jsonb_build_object('action', 'scheduled_check')
  );
end;
$$;
revoke all on function public.dispatch_stock_priority_alert() from public, anon, authenticated;

do $$
begin
  -- قاعدة بلا pg_cron (إعادة تشغيل محلية أو فرع معاينة): الدالة تُنشأ، والجدولة تُتخطّى.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'stock-priority-alert: pg_cron absent, skipping schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'stock-priority-alert') then
    perform cron.unschedule('stock-priority-alert');
  end if;
  perform cron.schedule('stock-priority-alert', '*/15 * * * *', 'select public.dispatch_stock_priority_alert();');
end $$;
