-- receipt-balance-query.sql — رصيد الزبون قبل سند القبض وبعده من دفتر أستاذ الأمين
-- READ-ONLY: SELECT وحده (الحارس ../manual-a4-print/lib/sql-guard.js).
--
-- نفس منطق ../ameen-autoprint/ameen-customer-balance-query.sql (رصيد مستند الفاتورة) حرفياً،
-- والهدف معطى مباشرة: قيد السند (ce000.GUID) وحساب الزبون (en000.AccountGUID). الترتيب الزمني
-- (balanceChrono) نفسه المستعمل لمستندات الموقع، فرصيد السند لا يتضخّم بقيود اليوم اللاحقة.
-- «قبل/بعد» للقيد كاملاً على هذا الحساب (كل أسطر الزبون في السند معاً).
--
-- المعاملات: @entryGuid, @accountGuid
-- النتيجة: صف واحد (document_previous, document_current)، أو لا صفوف ⇒ لا يُطبع رصيد.

;with ledger as (
    select en.AccountGUID as account_guid,
           en.ParentGUID as parent_guid,
           coalesce(case when ce.Date >= '2000-01-01' then ce.Date end, en.Date) as entry_date,
           case when coalesce(en.Notes, '') like N'%افتتاح%' then 0 else 1 end as is_opening,
           coalesce(ce.CreateDate, en.Date) as sort_date,
           coalesce(ce.Number, 0) as voucher_number,
           en.Number as entry_number,
           cast(coalesce(en.Debit, 0) - coalesce(en.Credit, 0) as decimal(28, 6)) as movement,
           cast(sum(coalesce(en.Debit, 0) - coalesce(en.Credit, 0)) over (
               partition by en.AccountGUID
               order by coalesce(case when ce.Date >= '2000-01-01' then ce.Date end, en.Date),
                        case when coalesce(en.Notes, '') like N'%افتتاح%' then 0 else 1 end,
                        coalesce(ce.CreateDate, en.Date), coalesce(ce.Number, 0), en.Number
               rows unbounded preceding) as decimal(28, 6)) as balance_chrono
    from dbo.en000 en
    left join dbo.ce000 ce on ce.GUID = en.ParentGUID
    where en.AccountGUID = @accountGuid
      and (coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0)
), document_rows as (
    select l.*,
           first_value(l.balance_chrono - l.movement) over (
               partition by l.account_guid, l.parent_guid
               order by l.entry_date, l.is_opening, l.sort_date, l.voucher_number, l.entry_number
               rows between unbounded preceding and unbounded following) as document_previous,
           last_value(l.balance_chrono) over (
               partition by l.account_guid, l.parent_guid
               order by l.entry_date, l.is_opening, l.sort_date, l.voucher_number, l.entry_number
               rows between unbounded preceding and unbounded following) as document_current
    from ledger l
)
select top (1) d.document_previous, d.document_current
from document_rows d
where d.parent_guid = @entryGuid;
