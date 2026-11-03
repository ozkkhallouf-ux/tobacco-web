-- receipt-baseline-query.sql — لقطة أساس سندات القبض لتفعيل الإنتاج (كل سند قبض موجود)
-- READ-ONLY: SELECT وحده (الحارس ../manual-a4-print/lib/sql-guard.js).
-- سند في اللقطة لا يُرصد ولا يُرفع ولا يُرسل عنه أبداً مهما عُدّل (كلقطة الفواتير).
-- المعاملات: @receiptType

SELECT LOWER(CONVERT(nvarchar(36), p.GUID)) AS receipt_guid,
       CONVERT(nvarchar(33), CONVERT(datetime2(3), p.CreateDate), 126) AS created_at
FROM dbo.py000 p
WHERE p.TypeGUID = @receiptType
