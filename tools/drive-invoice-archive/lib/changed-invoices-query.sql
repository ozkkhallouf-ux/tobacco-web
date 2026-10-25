-- changed-invoices-query.sql — فواتير الجملة المرشّحة للأرشفة
-- READ-ONLY: SELECT وحده. الحارس ../manual-a4-print/lib/sql-guard.js يرفض أي كلمة كتابة قبل الإرسال.
--
-- رصد تزايدي: ما أُنشئ أو عُدِّل بعد @since (CreateDate أو LastUpdateDate؛ قيمة الأخير
-- الافتراضية 1980-01-01 لفاتورة لم تُعدَّل)، ومطابقة دورية بـ@since قديم على نافذة تاريخ.
-- lines_checksum تلميح رخيص لتغيّر الأسطر (كل أعمدة البصمة): اختلافه يستدعي تحميل الأسطر
-- وحساب البصمة الحقيقية. تعديل لا يلمس LastUpdateDate تلتقطه المطابقة الدورية بهذا التلميح.
-- seconds_since_change بساعة SQL نفسها (لا ساعة الجهاز) لمهلة الاستقرار قبل الأرشفة.
--
-- المعاملات:
--   @t0, @t1      أنواع الجملة المعتمدة (الكاشير cc1097b1 مرفوض قبل الوصول هنا)
--   @dateFrom     أقدم تاريخ فاتورة يدخل الأرشيف
--   @since        مؤشر الصفحات: وقت التغيير (datetime2(3))
--   @sinceGuid    مؤشر الصفحات: آخر GUID عند @since نفسه (صفري لبداية نافذة)
--   @onlyGuid     NULL للرصد العادي؛ أو فاتورة واحدة لطابور إعادة أخطاء الرصد
--
-- المؤشر مركّب (changed_at, GUID) وحصري، بنفس ترتيب ORDER BY: 500 فاتورة أو أكثر بالوقت
-- نفسه (استيراد دفعة) لا تحبس الصفحات على أول 500. changed_at مقرَّب إلى datetime2(3)
-- فيطابق النص الراجع القيمة المقارَنة بالضبط (datetime يحمل أجزاء 1/300 ثانية).

SELECT TOP (500)
  LOWER(CONVERT(nvarchar(36), u.GUID))                AS invoice_guid,
  u.Number                                            AS invoice_number,
  CONVERT(nvarchar(10), CAST(u.Date AS date), 120)    AS invoice_date,
  LOWER(CONVERT(nvarchar(36), u.TypeGUID))            AS type_guid,
  LTRIM(RTRIM(ISNULL(bt.Name, N'')))                  AS type_name,
  ISNULL(bt.BillType, -1)                             AS bill_type,
  ISNULL(u.IsPosted, 0)                               AS is_posted,
  LOWER(CONVERT(nvarchar(36), u.CustGUID))            AS customer_guid,
  LTRIM(RTRIM(ISNULL(NULLIF(cu.CustomerName, N''), ISNULL(u.Cust_Name, N'')))) AS customer_name,
  CAST(ISNULL(u.Total,     0) AS decimal(18,2))       AS total,
  CAST(ISNULL(u.TotalDisc, 0) AS decimal(18,2))       AS discount,
  CAST(ISNULL(u.FirstPay,  0) AS decimal(18,2))       AS first_pay,
  -- حقول البصمة (المخطط 2): بقية الرأس كما خُزّن، بأعمدة مثبتة على AmnDb002 في وكيل الأحداث.
  LOWER(CONVERT(nvarchar(36), u.CustAccGUID))         AS customer_account_guid,
  LTRIM(RTRIM(ISNULL(u.Cust_Name, N'')))              AS bill_customer_name,
  LOWER(CONVERT(nvarchar(36), u.StoreGUID))           AS store_guid,
  ISNULL(u.PayType, 0)                                AS pay_type,
  CAST(ISNULL(u.TotalExtra, 0) AS decimal(28,6))      AS total_extra,
  CAST(ISNULL(u.ItemsDisc,  0) AS decimal(28,6))      AS items_disc,
  CAST(ISNULL(u.ItemsExtra, 0) AS decimal(28,6))      AS items_extra,
  CAST(ISNULL(u.BonusDisc,  0) AS decimal(28,6))      AS bonus_disc,
  CAST(ISNULL(u.VAT,        0) AS decimal(28,6))      AS vat,
  CAST(ISNULL(u.CurrencyVal, 1) AS decimal(28,12))    AS currency_val,
  LTRIM(RTRIM(ISNULL(cur.CurrencyISO, N'')))          AS currency_iso,
  (SELECT COUNT(*) FROM dbo.bi000 c WHERE c.ParentGUID = u.GUID) AS line_count,
  (SELECT CHECKSUM_AGG(BINARY_CHECKSUM(c.GUID, c.Number, c.MatGUID, c.Qty, c.Qty2, c.Qty3, c.Unity, c.Price,
                                       c.Discount, c.Extra, c.BonusQnt, c.VAT, c.StoreGUID, c.CostGUID))
     FROM dbo.bi000 c WHERE c.ParentGUID = u.GUID)   AS lines_checksum,
  CONVERT(nvarchar(33), chg.changed_at, 126)          AS changed_at,
  DATEDIFF(second, chg.changed_at, GETDATE())         AS seconds_since_change
FROM dbo.bu000 u
CROSS APPLY (
  SELECT CONVERT(datetime2(3),
           CASE WHEN ISNULL(u.LastUpdateDate, '19000101') > ISNULL(u.CreateDate, '19000101')
                THEN u.LastUpdateDate ELSE u.CreateDate END) AS changed_at
) chg
LEFT JOIN dbo.bt000 bt  ON bt.GUID  = u.TypeGUID
LEFT JOIN dbo.my000 cur ON cur.GUID = u.CurrencyGUID
LEFT JOIN dbo.cu000 cu  ON cu.GUID  = u.CustGUID
WHERE u.TypeGUID IN (@t0, @t1)
  AND u.Date >= @dateFrom
  -- ترشيح أولي واسع بثانية (التقريب قد يرفع القيمة جزءاً من الملّي ثانية)، ثم المؤشر الدقيق.
  AND (u.CreateDate >= DATEADD(second, -1, @since) OR u.LastUpdateDate >= DATEADD(second, -1, @since))
  AND (chg.changed_at > @since OR (chg.changed_at = @since AND u.GUID > @sinceGuid))
  AND (@onlyGuid IS NULL OR u.GUID = @onlyGuid)
ORDER BY chg.changed_at ASC, u.GUID ASC
