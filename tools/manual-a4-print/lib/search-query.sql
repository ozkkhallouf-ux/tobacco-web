-- search-query.sql — كل الفواتير التي تحمل الرقم المطلوب، من أي نوع
-- READ-ONLY: SELECT وحده. الحارس lib/sql-guard.js يرفض أي كلمة كتابة قبل الإرسال.
--
-- الرقم نفسه يتكرر بين أنواع الفواتير (مبيعات، مبيعات ل.س، مركز، مرتجع...)،
-- فالنتيجة قائمة يختار منها المستخدم بالنوع والتاريخ والزبون، لا سجل واحد.
--
-- المعاملات:  @number  رقم الفاتورة (u.Number)

SELECT TOP (50)
  LOWER(CONVERT(nvarchar(36), u.GUID))              AS invoice_guid,
  u.Number                                          AS invoice_number,
  CONVERT(nvarchar(10), CAST(u.Date AS date), 120)  AS invoice_date,
  LOWER(CONVERT(nvarchar(36), u.TypeGUID))          AS type_guid,
  LTRIM(RTRIM(ISNULL(bt.Name, N'')))                AS type_name,
  ISNULL(bt.BillType, -1)                           AS bill_type,
  ISNULL(u.IsPosted, 0)                             AS is_posted,
  LTRIM(RTRIM(ISNULL(u.Cust_Name, N'')))            AS customer_name,
  CAST(ISNULL(u.Total,     0) AS decimal(18,2))     AS total,
  CAST(ISNULL(u.TotalDisc, 0) AS decimal(18,2))     AS discount,
  CAST(ISNULL(u.FirstPay,  0) AS decimal(18,2))     AS first_pay,
  CAST(ISNULL(u.TotalExtra, 0) AS decimal(18,2))    AS total_extra,
  CAST(ISNULL(u.CurrencyVal, 1) AS decimal(28,12))  AS currency_val,
  LTRIM(RTRIM(ISNULL(cur.CurrencyISO, N'')))        AS currency_iso,
  (SELECT COUNT(*) FROM dbo.bi000 c WHERE c.ParentGUID = u.GUID) AS line_count
FROM dbo.bu000 u
LEFT JOIN dbo.bt000 bt  ON bt.GUID  = u.TypeGUID
LEFT JOIN dbo.my000 cur ON cur.GUID = u.CurrencyGUID
WHERE u.Number = @number
ORDER BY u.Date DESC, bt.Name ASC
