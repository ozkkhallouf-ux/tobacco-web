-- تراجع 29: يحذف دالة تحرير حجز إشعار واحد وحدها. لا يمسّ جدول الحجوزات (26) ولا دوالها.
-- انشر قبله نسخة document-archive-notify السابقة (بلا تحرير جزء من دفعة)، وإلا فشل تحرير
-- الحجوزات الناجحة سابقاً بعد عطل جزئي في دفعة (يبقى آمناً: تنتهي مهلتها وتصير unknown كالمعتاد).
begin;

drop function if exists public.document_archive_release_notification_claim(text, uuid);

commit;
