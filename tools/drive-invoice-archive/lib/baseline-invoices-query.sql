-- baseline-invoices-query.sql — لقطة الأساس لحظة تفعيل الإنتاج (node worker.js --baseline)
-- READ-ONLY: SELECT وحده عبر الحارس.
--
-- كل فاتورة بنوعي الجملة المعتمدين موجودة الآن، بأي تاريخ وأي حالة ترحيل: هذه «القديمة» التي
-- لا تُؤرشف أبداً، حتى لو رُحّلت أو عُدّلت أو غُيّر تاريخها بعد التفعيل. أنواع أخرى تتحوّل لاحقاً
-- إلى جملة يستبعدها حدّ CreateDate (@createdFrom) في changed-invoices-query.sql.
--
-- المعاملات: @t0, @t1 أنواع الجملة المعتمدة.

SELECT
  LOWER(CONVERT(nvarchar(36), u.GUID))                            AS invoice_guid,
  CONVERT(nvarchar(33), CONVERT(datetime2(3), u.CreateDate), 126) AS created_at
FROM dbo.bu000 u
WHERE u.TypeGUID IN (@t0, @t1)
ORDER BY u.GUID ASC
