-- proposed/18-ameen-invoice-events-rollback.sql
--
-- **غير مطبَّق على الإنتاج.** يُسقط كائنات proposed/18 فقط (الجداول الثلاثة والعرض ودالتا الكتابة والهوية).
-- لا يمسّ inventory_reports ولا تقرير ameen_customer_invoices ولا أي مزامنة قائمة.
-- قبله: أوقف الإرسال بحذف ملف التفعيل send-enabled.flag من مجلد صندوق الوكيل؛ الأحداث تبقى في الصندوق
-- المحلي على الجهاز ولا تضيع. بيانات الجدولين نسخة مشتقة من الأمين (المصدر المحاسبي)، فلا فقدان محاسبي.

drop function if exists public.apply_ameen_invoice_events(jsonb);
drop function if exists public.ameen_invoice_is_sync_writer();
drop view if exists public.ameen_invoice_daily_totals;
drop table if exists public.ameen_invoice_dirty_days;
drop table if exists public.ameen_invoice_events;
drop table if exists public.ameen_invoices;

notify pgrst, 'reload schema';
