-- التراجع عن 22 (أرشفة المستندات): يحذف كائنات المرآة في Supabase وحدها.
-- لا يمسّ ملفات Google Drive ولا صندوق العامل المحلي على OZK2026 (المصدر الموثوق).
-- أوقف العامل أو حوّله إلى dry-run قبل التنفيذ، وإلا فشلت تقاريره (رمز rpc_…_404) بلا ضرر.
begin;
drop function if exists public.request_document_archive_retry(text);
drop function if exists public.document_archive_record_notification(jsonb);
drop function if exists public.document_archive_ingest_report(jsonb);
drop function if exists private.document_archive_upsert_item(jsonb, timestamptz);
drop table if exists public.document_archive_retry_requests;
drop table if exists public.document_archive_heartbeat;
drop table if exists public.document_archive_items;
commit;
