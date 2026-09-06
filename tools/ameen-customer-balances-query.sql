-- Ameen customer balances (read-only). is_supplier = 1 when the account's parent is الموردون.
select
  cu.CustomerName as customer_name,
  cast(coalesce(ac.Debit, 0) - coalesce(ac.Credit, 0) as decimal(18, 3)) as balance,
  cast(coalesce(nullif(cu.MaxDebit, 0), nullif(ac.MaxDebit, 0), 0) as decimal(18, 3)) as credit_limit,
  cast(coalesce(nullif(cu.MaxDebit, 0), nullif(ac.MaxDebit, 0), 0) - (coalesce(ac.Debit, 0) - coalesce(ac.Credit, 0)) as decimal(18, 3)) as remaining_limit,
  cu.GUID as customer_guid,
  cu.AccountGUID as customer_account_guid,
  case when acp.Name = N'الموردون' then 1 else 0 end as is_supplier,
  cast(coalesce(last_payment.last_payment_amount, 0) as decimal(18, 3)) as last_payment_amount,
  last_payment.last_payment_date,
  last_payment.last_payment_notes,
  coalesce(recent_payments.recent_payments_json, '[]') as recent_payments_json,
  coalesce(recent_movements.recent_movements_json, '[]') as recent_movements_json
from dbo.cu000 cu
left join dbo.ac000 ac  on ac.GUID = cu.AccountGUID
left join dbo.ac000 acp on acp.GUID = ac.ParentGUID
outer apply (
  select top 1 en.Credit as last_payment_amount, en.Date as last_payment_date, en.Notes as last_payment_notes
  from dbo.en000 en
  where en.AccountGUID = cu.AccountGUID and coalesce(en.Credit, 0) > 0 and coalesce(en.Type, 0) = 0
  order by en.Date desc, en.Number desc, en.GUID desc
) last_payment
outer apply (
  select (
    -- 40 لا 6: نموذج خطر التحصيل يقيس زخم السداد على نافذة 90 يوماً، وسقف الستّ
    -- كان يقتطعها لـ35 زبوناً من 121 (29%) فيُظهر سدادهم أسوأ مما هو.
    select top 40 cast(en.Credit as decimal(18, 3)) as amount, en.Date as date, en.Notes as notes, en.Number as number
    from dbo.en000 en
    where en.AccountGUID = cu.AccountGUID and coalesce(en.Credit, 0) > 0 and coalesce(en.Type, 0) = 0
    order by en.Date desc, en.Number desc, en.GUID desc
    for json path
  ) as recent_payments_json
) recent_payments
outer apply (
  select (
    select top 10 cast(coalesce(en.Debit, 0) as decimal(18, 3)) as debit, cast(coalesce(en.Credit, 0) as decimal(18, 3)) as credit,
      en.Date as date, en.Notes as notes, en.Number as number, en.Type as type
    from dbo.en000 en
    where en.AccountGUID = cu.AccountGUID and (coalesce(en.Debit, 0) > 0 or coalesce(en.Credit, 0) > 0)
    order by en.Date desc, en.Number desc, en.GUID desc
    for json path
  ) as recent_movements_json
) recent_movements
where cu.CustomerName is not null and ltrim(rtrim(cu.CustomerName)) <> '' and (cu.bHide is null or cu.bHide = 0)
order by balance desc, cu.CustomerName;