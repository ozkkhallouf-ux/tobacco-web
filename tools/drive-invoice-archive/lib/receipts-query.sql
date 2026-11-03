-- receipts-query.sql — سندات القبض المرشّحة للأرشفة (مستند لكل زبون داخل السند)
-- READ-ONLY: SELECT وحده. الحارس ../manual-a4-print/lib/sql-guard.js يرفض أي كلمة كتابة قبل الإرسال.
--
-- المصدر مثبت باكتشاف قراءة فقط على AmnDb002 (2026-11-03، discover-receipts.js):
--   * السند = py000 بنوع «سند قبض» (@receiptType)، ورقمه py000.Number (لا ce000.Number).
--   * قيده ce000 عبر er000 (ParentType = 4)، وأسطره en000.
--   * py000.CreateDate مضبوط دائماً، وLastUpdateDate عند التعديل ⇒ الرصد التزايدي كالفواتير.
--   * السند الواحد قد يجمع عدة زبائن ⇒ مستند مستقل لكل (سند، حساب زبون) — قرار المالك 2026-11-03.
-- سطر القبض بالتعريف الموحّد (tools/ameen-customer-balances-query.sql، payment-rule): دائن على
-- حساب تحت شجرة الزبائن 121، سطر عادي en.Type = 0، مقابله صندوق من شجرة 13 عدا 135 فروقات
-- الصندوق، أو مقابل صفري وفي القيد نفسه صندوق مدين.
--
-- المعاملات:
--   @receiptType  et000 «سند قبض»
--   @dateFrom     أقدم تاريخ سند يدخل الأرشيف
--   @since        مؤشر الصفحات: وقت التغيير (datetime2(3))
--   @sinceGuid    مؤشر الصفحات: آخر GUID سند عند @since نفسه (صفري لبداية نافذة)
--   @onlyGuid     NULL للرصد العادي؛ أو سند واحد لطابور إعادة أخطاء الرصد
--   @createdFrom  NULL (تجربة محصورة/قبل الإنتاج)؛ أو لحظة التفعيل بساعة SQL (py000.CreateDate)
--
-- الصفحة 500 سند (لا 500 صف): كل أسطر السند في الصفحة نفسها، فلا يُشطر سند بين صفحتين.
-- صف لكل سطر قبض (يُجمَّع لكل زبون في receipt-model.js). سند بلا سطر قبض على زبون يرجع صفاً
-- واحداً بحساب فارغ كي يتقدّم المؤشر بعده.

WITH cash_tree AS (
  SELECT a.GUID FROM dbo.ac000 a WHERE a.GUID = 'c0dc3c06-b2ac-4e57-beae-19d7da3f514c'
  UNION ALL
  SELECT a.GUID FROM dbo.ac000 a JOIN cash_tree t ON a.ParentGUID = t.GUID
),
cash AS (SELECT t.GUID FROM cash_tree t WHERE t.GUID <> 'ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8'),
customer_tree AS (
  SELECT a.GUID FROM dbo.ac000 a WHERE a.GUID = 'e30187a7-eccc-4ff8-8a7d-f2df5e660b53'
  UNION ALL
  SELECT a.GUID FROM dbo.ac000 a JOIN customer_tree t ON a.ParentGUID = t.GUID
),
vouchers AS (
  SELECT TOP (500) p.GUID, p.Number, p.Date, p.Notes, p.CreateDate, chg.changed_at
  FROM dbo.py000 p
  CROSS APPLY (
    SELECT CONVERT(datetime2(3),
             CASE WHEN ISNULL(p.LastUpdateDate, '19000101') > ISNULL(p.CreateDate, '19000101')
                  THEN p.LastUpdateDate ELSE p.CreateDate END) AS changed_at
  ) chg
  WHERE p.TypeGUID = @receiptType
    AND p.Date >= @dateFrom
    AND (p.CreateDate >= DATEADD(second, -1, @since) OR p.LastUpdateDate >= DATEADD(second, -1, @since))
    AND (chg.changed_at > @since OR (chg.changed_at = @since AND p.GUID > @sinceGuid))
    AND (@onlyGuid IS NULL OR p.GUID = @onlyGuid)
    AND (@createdFrom IS NULL OR p.CreateDate >= @createdFrom)
  ORDER BY chg.changed_at ASC, p.GUID ASC
),
links AS (
  SELECT v.GUID AS receipt_guid, COUNT(er.GUID) AS entry_links,
         MAX(CONVERT(nvarchar(36), er.EntryGUID)) AS entry_guid_text
  FROM vouchers v
  LEFT JOIN dbo.er000 er ON er.ParentGUID = v.GUID AND er.ParentType = 4
  GROUP BY v.GUID
),
lines AS (
  SELECT l.receipt_guid, en.GUID AS line_guid, en.Number AS line_number, en.AccountGUID AS account_guid,
         en.Credit, en.CurrencyVal, en.Notes,
         cur.CurrencyISO AS currency_iso,
         CASE WHEN en.ContraAccGUID IN (SELECT c.GUID FROM cash c) THEN cb.Name ELSE cd.Name END AS cash_name
  FROM links l
  JOIN dbo.ce000 ce ON l.entry_links = 1 AND ce.GUID = CONVERT(uniqueidentifier, l.entry_guid_text)
  JOIN dbo.en000 en ON en.ParentGUID = ce.GUID
  JOIN customer_tree ct ON ct.GUID = en.AccountGUID
  LEFT JOIN dbo.my000 cur ON cur.GUID = en.CurrencyGUID
  LEFT JOIN dbo.ac000 cb ON cb.GUID = en.ContraAccGUID
  OUTER APPLY (
    SELECT TOP (1) da.Name
    FROM dbo.en000 d JOIN dbo.ac000 da ON da.GUID = d.AccountGUID
    WHERE d.ParentGUID = en.ParentGUID AND COALESCE(d.Debit, 0) > 0 AND d.AccountGUID IN (SELECT c.GUID FROM cash c)
    ORDER BY d.Number
  ) cd
  WHERE COALESCE(en.Credit, 0) > 0 AND COALESCE(en.Type, 0) = 0
    AND (
      en.ContraAccGUID IN (SELECT c.GUID FROM cash c)
      OR (COALESCE(en.ContraAccGUID, '00000000-0000-0000-0000-000000000000') = '00000000-0000-0000-0000-000000000000'
          AND EXISTS (SELECT 1 FROM dbo.en000 d WHERE d.ParentGUID = en.ParentGUID AND COALESCE(d.Debit, 0) > 0
                        AND d.AccountGUID IN (SELECT c.GUID FROM cash c)))
    )
)
SELECT
  LOWER(CONVERT(nvarchar(36), v.GUID))                         AS receipt_guid,
  v.Number                                                     AS receipt_number,
  CONVERT(nvarchar(10), CAST(v.Date AS date), 120)             AS receipt_date,
  LTRIM(RTRIM(ISNULL(v.Notes, N'')))                           AS receipt_notes,
  l.entry_links                                                AS entry_links,
  LOWER(ISNULL(l.entry_guid_text, N''))                        AS entry_guid,
  ISNULL(ce.IsPosted, 0)                                       AS is_posted,
  LOWER(ISNULL(CONVERT(nvarchar(36), ln.line_guid), N''))      AS line_guid,
  ln.line_number                                               AS line_number,
  LOWER(ISNULL(CONVERT(nvarchar(36), ln.account_guid), N''))   AS account_guid,
  LOWER(ISNULL(CONVERT(nvarchar(36), cu.GUID), N''))           AS customer_guid,
  LTRIM(RTRIM(ISNULL(cu.CustomerName, N'')))                   AS customer_name,
  CAST(ln.Credit AS decimal(28, 6))                            AS amount,
  CAST(ln.Credit / NULLIF(ln.CurrencyVal, 0) AS decimal(28, 6)) AS native_amount,
  CAST(ln.CurrencyVal AS decimal(28, 12))                      AS currency_val,
  LTRIM(RTRIM(ISNULL(ln.currency_iso, N'')))                   AS currency_iso,
  LTRIM(RTRIM(ISNULL(ln.cash_name, N'')))                      AS cash_name,
  LTRIM(RTRIM(ISNULL(ln.Notes, N'')))                          AS line_notes,
  CONVERT(nvarchar(33), v.changed_at, 126)                     AS changed_at,
  CONVERT(nvarchar(33), CONVERT(datetime2(3), v.CreateDate), 126) AS created_at,
  DATEDIFF(second, v.changed_at, GETDATE())                    AS seconds_since_change
FROM vouchers v
JOIN links l ON l.receipt_guid = v.GUID
LEFT JOIN dbo.ce000 ce ON l.entry_links = 1 AND ce.GUID = CONVERT(uniqueidentifier, l.entry_guid_text)
LEFT JOIN lines ln ON ln.receipt_guid = v.GUID
OUTER APPLY (SELECT TOP (1) c.GUID, c.CustomerName FROM dbo.cu000 c WHERE c.AccountGUID = ln.account_guid ORDER BY c.GUID) cu
ORDER BY v.changed_at ASC, v.GUID ASC, ln.account_guid ASC, ln.line_number ASC
OPTION (MAXRECURSION 100)
