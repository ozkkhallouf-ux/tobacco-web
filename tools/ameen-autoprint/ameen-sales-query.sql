-- ameen-sales-query.sql — فواتير مبيعات الجملة الجديدة
-- مبيعات المركز (مفرق) مستثناة — تطبعها طابعة الكاشير الموجودة
-- Read-only — لا يكتب شيئاً في قاعدة الأمين
--
-- المعاملات:
--   @guid0      GUID نوع "مبيعات" (الجملة النشيطة)
--   @watchFrom  تاريخ بداية المراقبة (YYYY-MM-DD)
--
-- الكمية المعروضة:
--   bi.Unity = 1 → كمية بالوحدة الأولى (علبة)  → bi.Qty
--   bi.Unity = 2 → كمية بالوحدة الثانية (كرتون) → bi.Qty / Unit2Fact
-- (مؤكّد بمطابقة شاشة الأمين مع فاتورة رقم 52)

SELECT
  LOWER(CONVERT(nvarchar(36), u.GUID))                AS invoice_guid,
  u.Number                                             AS invoice_number,
  CONVERT(nvarchar(10), CAST(u.Date AS date), 120)     AS invoice_date,
  LTRIM(RTRIM(ISNULL(u.Cust_Name, N'')))              AS customer_name,
  CAST(ISNULL(u.Total,    0) AS decimal(18,2))         AS total,
  CAST(ISNULL(u.TotalDisc,0) AS decimal(18,2))         AS discount,
  CAST(ISNULL(u.FirstPay, 0) AS decimal(18,2))         AS first_pay,
  LTRIM(RTRIM(ISNULL(m.Name, N'')))                   AS item_name,
  LTRIM(RTRIM(ISNULL(
    CASE WHEN bi.Unity = 2 THEN NULLIF(m.Unit2,  N'')
                            ELSE NULLIF(m.Unity, N'')
    END, N'وحدة')))                                     AS unit_name,
  CAST(
    CASE WHEN bi.Unity = 2 AND ISNULL(m.Unit2Fact,0) > 0
         THEN ISNULL(bi.Qty,0) / m.Unit2Fact
         ELSE ISNULL(bi.Qty,0)
    END AS decimal(18,3))                              AS display_qty
FROM dbo.bu000 u
JOIN  dbo.bi000 bi ON bi.ParentGUID = u.GUID
JOIN  dbo.mt000 m  ON m.GUID = bi.MatGUID
WHERE u.TypeGUID = @guid0
  AND CAST(u.Date AS date) >= CAST(@watchFrom AS date)
  AND CAST(u.Date AS date) <= CAST(DATEADD(day,1,GETDATE()) AS date)
ORDER BY u.Date ASC, u.Number ASC, ISNULL(bi.Number,0) ASC
