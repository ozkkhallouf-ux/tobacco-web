-- تراجع 26: يحذف حجوزات إشعار الأرشفة ودوالها وحدها. جداول 22 وملفات Drive لا تُمسّ.
-- انشر قبله نسخة document-archive-notify السابقة (بلا الحجز)، وإلا فشلت الدالة مغلقة (502 بلا إرسال).
begin;

drop function if exists public.document_archive_release_notification_claims(text[]);
drop function if exists public.document_archive_finish_notification(text, uuid, text, bigint, text);
drop function if exists public.document_archive_claim_notification(text, int, text);
drop function if exists private.document_archive_alert_unknown(text, text);
drop table if exists public.document_archive_notify_claims;

commit;
