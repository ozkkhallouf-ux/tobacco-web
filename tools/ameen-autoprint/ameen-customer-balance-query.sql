-- ameen-customer-balance-query.sql — رصيد الزبون الحقيقي من دفتر أستاذ الأمين
-- Read-only — لا يكتب شيئاً في قاعدة الأمين
--
-- نفس منطق Get-InvoiceDocumentBalance المستخدم في خط الكاشير (ozk-print-bridge.ps1)
-- حرفياً، لضمان اتساق مصدر الحقيقة بين الكاشير والجملة. الربط يتم حصراً عبر
-- GUID الفاتورة → قيود en000 → AccountGUID → cu000.AccountGUID
-- (ممنوع الربط باسم الزبون).
--
-- المعاملات:
--   @invoiceGuid  GUID فاتورة الجملة (u.GUID من bu000)
--
-- النتيجة: صف واحد (document_previous, document_current) إن وُجد مستند محاسبي
-- حقيقي مرتبط بهذه الفاتورة، أو لا صفوف إطلاقاً إذا تعذّر العثور على حساب
-- الزبون — في هذه الحالة يجب على الطبقة المستدعية عدم عرض أي رقم رصيد.

;with invoice_document as (
    select top (1) en.ParentGUID as parent_guid
    from dbo.en000 en
    left join dbo.bi000 bib on bib.GUID = en.BiGUID
    where coalesce(bib.ParentGUID, en.BiGUID) = @invoiceGuid
      and en.ParentGUID is not null
      and en.ParentGUID <> '00000000-0000-0000-0000-000000000000'
      and (coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0)
    order by en.Number, en.GUID
), target as (
    select top (1) en.AccountGUID as account_guid, en.ParentGUID as parent_guid
    from dbo.en000 en
    join invoice_document doc on doc.parent_guid = en.ParentGUID
    join dbo.cu000 cu on cu.AccountGUID = en.AccountGUID
    where coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0
    order by en.Number, en.GUID
), ledger as (
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
    join target t on t.account_guid = en.AccountGUID
    where coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0
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
select top (1) d.account_guid, d.document_previous, d.document_current
from document_rows d
join target t on t.account_guid = d.account_guid and t.parent_guid = d.parent_guid;
