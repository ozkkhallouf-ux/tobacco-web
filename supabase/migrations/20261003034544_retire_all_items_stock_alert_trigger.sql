-- إيقاف تنبيه النفاد القديم لكل الأصناف (trg_notify_stock_alerts).
--
-- قرار المالك (2026-10-03): تنبيه «قاربت النفاد / نفدت» في تيليغرام يخص الأصناف
-- المهمة حسب صافي مبيع آخر 30 يوماً وحدها، برسالة واحدة مرتبة بالأولوية.
-- البديل: src/stock-alert-priority.js (منطق نقي) + scripts/stock-priority-alerts.mjs
-- + .github/workflows/stock-priority-alerts.yml، ويكتب عبر notify_telegram نفسها.
--
-- الـtrigger القديم كان ينبّه على أي صنف في approved_price_items يعبر حد
-- low_stock_threshold أو الصفر، بلا أي اعتبار للمبيعات. بقاؤه مع البديل يعني
-- رسائل مكررة ونقيض القرار.
--
-- ترتيب التطبيق: فعّل متغيّر المستودع STOCK_PRIORITY_ALERTS_ENABLED = 'true' أولاً،
-- ثم طبّق هذا الترحيل — كي لا تمرّ فترة بلا أي تنبيه نفاد.
--
-- طُبِّق على المشروع الحي في 2026-10-03 بموافقة المالك، بعد وصول أول تنبيه حسب
-- الأولوية إلى تيليغرام (الإصدار المسجَّل 20261003034544). اسم الملف كان
-- 20261003020000_… وأُعيدت تسميته ليطابق الإصدار المسجَّل. لا يُعاد تشغيله.
--
-- لا يمسّ: notify_telegram، telegram_outbox، bot_config.low_stock_threshold (ما زال
-- يغذّي التقريرين الصباحي والمسائي وأمر «شو ناقص» والبديل الجديد)، ولا أي trigger آخر.
-- idempotent.

drop trigger if exists trg_notify_stock_alerts on public.approved_price_items;
drop function if exists public.tg_notify_stock_alerts();
