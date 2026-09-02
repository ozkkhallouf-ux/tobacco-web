-- ============================================================
-- OZK TOBACCO — واجهة مراقبة صحة البوت
-- مرجع توثيقي فقط — لا تُشغِّل هذا الملف يدوياً.
-- الـview موجودة في الإنتاج منذ 2026-07-25 تقريباً.
-- التعديل الأخير: P2-2 migration (20260902070000) أضاف security_invoker=on.
--
-- الغرض: ترجع تنبيهات صحية مُجمَّعة لبوت المراقبة:
--   - فشل مزامنة الأمين (event_type = sync_failure / price_sync_failure)
--   - تعارض أسعار (event_type = price_sync_mismatch)
--   - رسائل تيليغرام فشلت
--   - طابور تيليغرام متوقف (pending > 15 دقيقة)
--   - تأخر مزامنة > 3 ساعات (خلال ساعات العمل 9-23 دمشق)
--   - تقرير الصباح لم يصل بعد 11:00
--
-- الصلاحيات المقصودة:
--   authenticated  → SELECT (يخص الـbots المصادَق عليها)
--   service_role   → full access
--   anon           → لا وصول
--
-- حماية الأمان:
--   WHERE is_staff() في نهاية الـview — غير الـstaff يحصلون على صفر صفوف.
--   security_invoker = on — الـRLS يُطبَّق على الجداول الأصلية (منذ 2026-09-02).
--
-- مثال استعلام (من Telegram webhook أو bot):
--   select area, severity, detail from public.bot_health_alerts;
-- ============================================================

-- التعريف الحالي على الإنتاج (مُستخرج من pg_views, 2026-09-02):
-- (هذا توثيق فقط — الـmigration هو المصدر الرسمي للتغييرات)

/*
create or replace view public.bot_health_alerts
with (security_invoker = on)
as
with params as (
  select
    now() as ts_utc,
    (now() at time zone 'Asia/Damascus') as ts_local
),
freshness as (
  select greatest(
    coalesce((select max(created_at) from inventory_reports), '1970-01-01+00'),
    coalesce((select max(created_at) from sales_line_items),  '1970-01-01+00'),
    coalesce((select max(source_synced_at) from approved_price_items), '1970-01-01+00')
  ) as last_sync
)
select area, severity, detail
from (
  select 'sync' as area, 'high' as severity,
         'فشل مزامنة: ' || count(*) || ' مرة بآخر ساعة — ' || left(max(message), 160) as detail
    from telegram_outbox, params
   where event_type in ('sync_failure', 'price_sync_failure')
     and created_at > ts_utc - interval '65 minutes'
   having count(*) > 0

  union all
  select 'prices', 'medium',
         'تعارض أسعار (price_sync_mismatch): ' || count(*) || ' بآخر ساعة'
    from telegram_outbox, params
   where event_type = 'price_sync_mismatch'
     and created_at > ts_utc - interval '65 minutes'
   having count(*) > 0

  union all
  select 'notify', 'high',
         'رسائل تيليغرام فشل إرسالها: ' || count(*) || ' بآخر ساعة'
    from telegram_outbox, params
   where status = 'failed'
     and created_at > ts_utc - interval '65 minutes'
   having count(*) > 0

  union all
  select 'dispatcher', 'high',
         'طابور تيليغرام متوقف: ' || count(*) || ' رسالة معلّقة أقدم من 15 دقيقة'
    from telegram_outbox, params
   where status = 'pending'
     and created_at < ts_utc - interval '15 minutes'
   having count(*) > 0

  union all
  select 'sync', 'high',
         'تأخر مزامنة: ما في تحديث من الأمين من ' ||
         round(extract(epoch from (ts_utc - last_sync)) / 3600.0, 1) || ' ساعة'
    from params, freshness
   where last_sync < ts_utc - interval '3 hours'
     and extract(hour from ts_local) between 9 and 23

  union all
  select 'report', 'medium',
         'تقرير الصباح ما إجا اليوم (متوقع ~8 صباحاً) — يمكن التقرير وقف'
    from params
   where extract(hour from ts_local) >= 11
     and not exists (
       select 1 from telegram_outbox t
        where t.event_type = 'morning_report'
          and (t.created_at at time zone 'Asia/Damascus')::date = ts_local::date
     )
) alerts
where is_staff();

grant select on public.bot_health_alerts to authenticated;
*/
