-- proposed/17-price-sync-monitor-rollback.sql
--
-- **غير مطبَّق على الإنتاج.** يُلغي مراقبة مزامنة الأسعار المستقلة (proposed/17) ويعيد المراقب القديم.
-- يُلغي مهمة cron «price-sync-monitor»، ويُسقط دوال 17 وجداولها (سجل الحوادث يُفقد: تشغيلي فقط)،
-- ويعيد تفعيل صف «price-sync» في private.project_task_monitors كما كان قبل 17.
-- لا يمسّ public.price_sync_heartbeats (16) ولا notify_telegram ولا أي مهمة أخرى.
-- حادثة مفتوحة لحظة التراجع لا يُرسل لها تعافٍ؛ المراقب القديم يتولى من دورته التالية (حد 30 د).

do $unschedule$
begin
  if to_regnamespace('cron') is not null then
    if exists (select 1 from cron.job where jobname = 'price-sync-monitor') then
      perform cron.unschedule('price-sync-monitor');
    end if;
  end if;
end
$unschedule$;

drop function if exists private.price_sync_monitor_tick(timestamptz);
drop function if exists private.price_sync_monitor_assess(timestamptz);
drop function if exists private.price_sync_monitor_alert_text(text, text, timestamptz, timestamptz, timestamptz, text);
drop function if exists private.price_sync_monitor_recovery_text(timestamptz, integer, integer, integer, timestamptz, timestamptz);
drop function if exists private.price_sync_monitor_reason_text(text);
drop function if exists private.price_sync_monitor_time(timestamptz, timestamptz);
drop table if exists private.price_sync_incidents;
drop table if exists private.price_sync_monitor_state;
drop table if exists private.price_sync_monitor_config;

do $restore$
begin
  if to_regclass('private.project_task_monitors') is not null then
    update private.project_task_monitors set enabled = true where task_key = 'price-sync' and not enabled;
  end if;
end
$restore$;
