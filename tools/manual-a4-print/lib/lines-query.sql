-- lines-query.sql — أسطر فاتورة واحدة بالـGUID
-- READ-ONLY: SELECT وحده.
--
-- الكمية بوحدة إدخال السطر الصريحة bi.Unity (1 = mt.Unity، 2 = Unit2، 3 = Unit3)،
-- و bi.Qty مخزَّنة دائماً بالوحدة الأولى، فالمعروض = Qty ÷ معامل وحدة الإدخال.
-- (نفس قاعدة invoiceLineInputUnit في src/app.js؛ مراقب الطباعة التلقائية يعالج
-- الوحدتين 1 و2 فقط، وهنا أُضيفت 3 كي لا تُطبع كمية الوحدة الثالثة بالوحدة الأولى.)
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
  CAST(ISNULL(bi.Qty, 0) AS decimal(18,6))          AS qty
FROM dbo.bi000 bi
JOIN dbo.mt000 m ON m.GUID = bi.MatGUID
WHERE bi.ParentGUID = @invoiceGuid
ORDER BY ISNULL(bi.Number, 0) ASC
