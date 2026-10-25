-- source-status-query.sql — حالة فاتورة مؤرشفة في المصدر بمعرّفها وحده
-- READ-ONLY: SELECT وحده. بلا شرط نوع ولا تاريخ ولا ترحيل: يميّز «حُذفت» (لا صف) من
-- «أُلغي ترحيلها» و«تغيّر نوعها» و«خرج تاريخها من النطاق».
--
-- المعاملات:  @invoiceGuid

SELECT
  LOWER(CONVERT(nvarchar(36), u.GUID))              AS invoice_guid,
  u.Number                                          AS invoice_number,
  CONVERT(nvarchar(10), CAST(u.Date AS date), 120)  AS invoice_date,
  LOWER(CONVERT(nvarchar(36), u.TypeGUID))          AS type_guid,
  ISNULL(u.IsPosted, 0)                             AS is_posted
FROM dbo.bu000 u
WHERE u.GUID = @invoiceGuid
