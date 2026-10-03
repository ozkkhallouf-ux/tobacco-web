-- إصلاح bot_health_alerts: تغطية صفوف dispatched العالقة + نافذة failed الصحيحة
-- (رد على ملاحظة Codex P1 الجديدة على PR #220، بعد commit 0678110937،
--  على bot-health-alerts.sql:73-78 مقارنة بمنطق dispatch_telegram_outbox
--  المُحدَّث في نفس PR)
--
-- المشكلة: الإصلاحات السابقة في نفس PR (إحياء 'failed' بعد ساعة +
-- تصنيف 'no_response'/'network_error' بعد 15 دقيقة) غيّرت توقيت انتقال
-- الصف من dispatched إلى failed: يحتاج الآن حتى 5 دورات مطابقة (كل دورة
-- تتطلب 15 دقيقة انتظار بلا ردّ قبل أن تُصنَّف network_error وتُعاد
-- المحاولة) — أي نحو 75 دقيقة من الإنشاء حتى يصبح الصف 'failed' فعلياً
-- في أسوأ الحالات. الفحصان الحاليان لا يغطيان هذا:
--   ١) فحص "رسائل فشل إرسالها" يقارن created_at بنافذة 65 دقيقة — لكن صفاً
--      وصل 'failed' بعد 75 دقيقة من إنشائه يكون created_at خارج هذه
--      النافذة فعلياً فور وصوله 'failed'، فلا يُنبَّه عليه إطلاقاً.
--   ٢) فحص "طابور متوقف" يراقب status='pending' فقط. لو توقّف
--      pg_cron/dispatch_telegram_outbox تماماً بعد إرسال دفعة (فباتت
--      عالقة على 'dispatched' لا 'pending')، لا يوجد فحص يكتشف ذلك —
--      وهذا بالضبط ما يفترضه الفحص "طابور تيليغرام متوقف".
--
-- الإصلاح:
--   - فحص "رسائل فشل": التصفية بـsent_at (آخر محاولة فعلية، تُحدَّث في كل
--     محاولة إرسال) بدل created_at، فتبقى النافذة الزمنية مرتبطة بحداثة
--     آخر نشاط على الصف لا بوقت إنشائه الأصلي.
--   - فحص "طابور متوقف": إضافة تغطية لصفوف dispatched العالقة بلا تقدّم
--     لأكثر من 20 دقيقة (هامش فوق حلقة 15 دقيقة no_response الداخلية،
--     يكفي لاستبعاد التذبذب الطبيعي مع بقائه حساساً لتوقف الـcron الفعلي).
--
-- لا تغيير على أي فحص آخر في الـview ولا على صلاحياتها (security_invoker
-- يبقى on كما في migration 20260902070000).

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
   -- Codex P1 (PR #220، بعد 0678110937): sent_at لا created_at — إحياء
   -- 'failed' بعد ساعة ومطابقة no_response بعد 15 دقيقة يعنيان أن الصف قد
   -- يصل 'failed' بعد ~75 دقيقة من إنشائه، فتفوته نافذة created_at.
   where status = 'failed'
     and sent_at > ts_utc - interval '65 minutes'
   having count(*) > 0

  union all
  select 'dispatcher', 'high',
         'طابور تيليغرام متوقف: ' || count(*) || ' رسالة معلّقة أقدم من 15 دقيقة'
    from telegram_outbox, params
   where status = 'pending'
     and created_at < ts_utc - interval '15 minutes'
   having count(*) > 0

  union all
  select 'dispatcher', 'high',
         'طابور تيليغرام متوقف: ' || count(*) || ' رسالة عالقة dispatched بلا تقدّم أكثر من 20 دقيقة'
    from telegram_outbox, params
   -- Codex P1 (PR #220، بعد 0678110937): صف dispatched لا يتقدّم يعني
   -- توقّف dispatch_telegram_outbox/pg_cron نفسه — الحلقة الداخلية تصنّف
   -- أي صف بلا ردّ خلال 15 دقيقة إن كانت تعمل أصلاً، فبقاؤه dispatched
   -- بعد 20 دقيقة دليل توقف لا تأخّر عابر.
   where status = 'dispatched'
     and sent_at < ts_utc - interval '20 minutes'
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

comment on view public.bot_health_alerts is
  'مراقبة صحة البوت — security_invoker=on مفعَّل (2026-09-02). الـRLS على الجداول الأصلية يسمح للـstaff بالقراءة؛ غير الـstaff يحصلون على صفر صفوف بسبب WHERE is_staff() في نهاية الـview. لا يعرض بيانات خام، فقط أعداد وطوابع زمنية مجمَّعة. فحص notify يستخدم sent_at لا created_at، وفحص dispatcher يغطي dispatched العالقة أيضاً (PR #220، 2026-09-14).';
