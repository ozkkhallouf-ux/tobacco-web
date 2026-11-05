-- receipt-baseline-query.sql — لقطة أساس سندات القبض لتفعيل الإنتاج (كل سند قبض موجود)
-- READ-ONLY: SELECT وحده (الحارس ../manual-a4-print/lib/sql-guard.js).
-- سند في اللقطة لا يُرصد ولا يُرفع ولا يُرسل عنه أبداً مهما عُدّل (كلقطة الفواتير).
-- ومعها كل قيد يدوي بنوع صفري لا يرتبط بمستند في er000 (مرشّحو القيود اليدوية في
-- receipts-query.sql، مجموعة أوسع عمداً: ما في اللقطة لا يُرسل، فالزيادة لا تضر).
-- المعاملات: @receiptType

SELECT LOWER(CONVERT(nvarchar(36), p.GUID)) AS receipt_guid,
       CONVERT(nvarchar(33), CONVERT(datetime2(3), p.CreateDate), 126) AS created_at
FROM dbo.py000 p
WHERE p.TypeGUID = @receiptType
UNION ALL
SELECT LOWER(CONVERT(nvarchar(36), ce.GUID)) AS receipt_guid,
       CONVERT(nvarchar(33), CONVERT(datetime2(3), ce.CreateDate), 126) AS created_at
FROM dbo.ce000 ce
WHERE COALESCE(ce.TypeGUID, '00000000-0000-0000-0000-000000000000') = '00000000-0000-0000-0000-000000000000'
  AND NOT EXISTS (SELECT 1 FROM dbo.er000 er WHERE er.EntryGUID = ce.GUID)
