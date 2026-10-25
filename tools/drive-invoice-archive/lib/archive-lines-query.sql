-- archive-lines-query.sql — أسطر فاتورة واحدة بالـGUID لعامل الأرشفة
-- READ-ONLY: SELECT وحده. الحارس ../manual-a4-print/lib/sql-guard.js يرفض أي كلمة كتابة.
--
-- أعمدة العرض الثمانية الأولى مطابقة حرفياً لـ../manual-a4-print/lib/lines-query.sql (الـPDF
-- يُبنى منها بـlineFromRow نفسه). الباقي لبصمة المحتوى وحدها: كل ما يغيّر السطر في الأمين
-- (المعرّفات، الكميات الثلاث، السعر، الحسم، الإضافة، الهدية، الضريبة، المستودع، مركز الكلفة)،
-- بأعمدة bi000 المثبتة على AmnDb002 في وكيل الأحداث (ameen-invoice-events-lib.ps1).
-- استعلام مستقل كي لا يتغيّر شيء في أداة الطباعة اليدوية.
--
-- المعاملات:  @invoiceGuid

SELECT
  LTRIM(RTRIM(ISNULL(m.Name, N'')))                 AS item_name,
  ISNULL(bi.Unity, 1)                               AS input_unit,
  LTRIM(RTRIM(ISNULL(m.Unity, N'')))                AS unit1_name,
  LTRIM(RTRIM(ISNULL(m.Unit2, N'')))                AS unit2_name,
  LTRIM(RTRIM(ISNULL(m.Unit3, N'')))                AS unit3_name,
  CAST(ISNULL(m.Unit2Fact, 0) AS decimal(18,6))     AS unit2_fact,
  CAST(ISNULL(m.Unit3Fact, 0) AS decimal(18,6))     AS unit3_fact,
  CAST(ISNULL(bi.Qty, 0) AS decimal(18,6))          AS qty,
  LOWER(CONVERT(nvarchar(36), bi.GUID))             AS line_guid,
  ISNULL(bi.Number, 0)                              AS line_number,
  LOWER(CONVERT(nvarchar(36), bi.MatGUID))          AS mat_guid,
  CAST(ISNULL(bi.Qty2, 0) AS decimal(18,6))         AS qty2,
  CAST(ISNULL(bi.Qty3, 0) AS decimal(18,6))         AS qty3,
  CAST(ISNULL(bi.Price, 0) AS decimal(28,6))        AS price,
  CAST(ISNULL(bi.Discount, 0) AS decimal(28,6))     AS line_discount,
  CAST(ISNULL(bi.Extra, 0) AS decimal(28,6))        AS line_extra,
  CAST(ISNULL(bi.BonusQnt, 0) AS decimal(18,6))     AS bonus_qty,
  CAST(ISNULL(bi.VAT, 0) AS decimal(28,6))          AS line_vat,
  LOWER(CONVERT(nvarchar(36), bi.StoreGUID))        AS line_store_guid,
  LOWER(CONVERT(nvarchar(36), bi.CostGUID))         AS cost_guid
FROM dbo.bi000 bi
JOIN dbo.mt000 m ON m.GUID = bi.MatGUID
WHERE bi.ParentGUID = @invoiceGuid
ORDER BY ISNULL(bi.Number, 0) ASC, bi.GUID ASC
