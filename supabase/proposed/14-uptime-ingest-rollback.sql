-- proposed/14-uptime-ingest-rollback.sql
--
-- **غير مطبَّق على الإنتاج.** تراجع كامل عن 14-uptime-ingest.sql في معاملة واحدة.
--
-- الترتيب الآمن قبل تشغيله:
--   1) أوقف الإرسال من الـWorker أولاً (DRY_RUN=1، أو احذف سرّ UPTIME_HMAC_SECRET من Cloudflare)
--      وإلا فسيفشل كل نداء بعد التراجع (404 من PostgREST) ويبقى الحدث معلّقاً عند الـWorker — وهذا آمن، لا ضياع.
--   2) إن كان المراقب مجدولاً: select cron.unschedule('uptime-heartbeat-watch');  (الدالة تُسقط أدناه)
--   3) شغّل هذا الملف.
--
-- لا يمسّ telegram_outbox ولا أي رسالة دخلتها مسبقاً، ولا notify_telegram/notify_telegram_dispatch، ولا app_secrets
-- (صف uptime_ingest_hmac، إن وُجد، يُحذف يدوياً وبموافقة منفصلة).
-- يحذف سجلّ الأحداث والحوادث الخاص بـuptime (private.uptime_*)؛ إن أردت الاحتفاظ به فاحذف أسطر drop table.

do $guard$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from cron.job where command ilike '%watch_uptime_heartbeat%') then
    raise exception 'unschedule the uptime watchdog cron job first';
  end if;
end
$guard$;

drop function if exists public.watch_uptime_heartbeat();
drop function if exists public.uptime_ingest(text, text);
drop function if exists private.uptime_cancel_recovery(bigint);
drop function if exists private.uptime_close_key(text, text, timestamptz);
drop function if exists private.uptime_enqueue(text, text);
drop function if exists private.uptime_message(text, text, text, timestamptz, timestamptz);

drop table if exists private.uptime_events;
drop table if exists private.uptime_incidents;
drop table if exists private.uptime_ingest_nonces;
drop table if exists private.uptime_heartbeat;
drop table if exists private.uptime_config;

notify pgrst, 'reload schema';
