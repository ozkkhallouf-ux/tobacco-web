-- proposed/16-price-sync-heartbeats-rollback.sql
--
-- **غير مطبَّق على الإنتاج.** يُسقط كائنات proposed/16 فقط (الجدول ودالتا الكتابة والهوية).
-- لا يمسّ inventory_reports ولا ameen_price_sync_status ولا أي تنبيه.
-- قبله: انشر سكربتات Windows السابقة أو اقبل أن يكتب الناشر «PRICE-SYNC-HEARTBEAT FAILED» (best-effort،
-- لا يكسر المزامنة) حتى يُعاد الجدول. بيانات النبض تُفقد (سجل تشغيلي فقط، لا بيانات محاسبية).

drop function if exists public.record_price_sync_heartbeat(jsonb);
drop function if exists public.price_sync_is_sync_writer();
drop table if exists public.price_sync_heartbeats;

notify pgrst, 'reload schema';
