-- تراجع 16: يُسقط الدالة والجدول. لا يمسّ ameen_price_sync_status ولا أي جدول آخر.
-- بعد التراجع يستمر سكربت المزامنة بلا تغيير في سلوكه: فشل نشر النبضة
-- best-effort ولا يغيّر رمز خروج المهمة.
drop function if exists public.record_price_sync_heartbeat(jsonb);
drop table if exists public.price_sync_heartbeat;
notify pgrst, 'reload schema';
