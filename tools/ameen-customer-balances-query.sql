-- Ameen customer balances (read-only). is_supplier = 1 when the account's parent is الموردون.
-- payment-rule:begin
-- تعريف «الدفعة» الموحّد لآخر دفعة وسجل الدفعات وعدّاد نافذة الزخم معاً. كل سطر دائن
-- على الزبون ليس دفعة: حسم الفاتورة (دائن مقابل 43 الحسم الممنوح) والمرتجع (مقابل 42)
-- والقيد الافتتاحي والتسويات والتحويلات كلها دائنة. القبض الحقيقي هو ما دخل صندوقاً،
-- والحكم بالمعرّفات وشجرة الحسابات لا بالأسماء ولا بالتاريخ والمبلغ (مُثبت قراءةً على
-- الأمين في 2026-09-24 على كل الأسطر الدائنة للزبائن، بلا إيجابي ولا سلبي خاطئ معروف):
--   • حساب الزبون تحت شجرة 121 الزبائن (e30187a7…) — يُخرج حسابات المصاريف والسلف
--     المسجّلة في cu000.
--   • مقابل السطر صندوق من شجرة 13 الأموال الجاهزة (c0dc3c06…) عدا 135 فروقات الصندوق
--     (ef5d9f4c…) — يغطي سندات القبض والدفعة الأولى (FirstPay).
--   • أو مقابل صفري (قيد مركب) وفي القيد نفسه (en.ParentGUID) مدين على ذلك الصندوق،
--     والقيد ليس القيد الافتتاحي (ce.TypeGUID ea69ba80…). بلا مطابقة مبلغ عمداً: دفعة
--     واحدة في قيد مركب قد تدخل صندوقين بمبلغين جزئيين.
-- الموردون خارج هذا التعريف ويبقون على شرطهم السابق كما هو.
with cash_tree as (
  select ac.GUID, ac.ParentGUID from dbo.ac000 ac where ac.GUID = 'c0dc3c06-b2ac-4e57-beae-19d7da3f514c'
  union all
  select a.GUID, a.ParentGUID from dbo.ac000 a join cash_tree t on a.ParentGUID = t.GUID
),
cash_accounts as (
  select t.GUID from cash_tree t where t.GUID <> 'ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8'
),
customer_tree as (
  select ac.GUID, ac.ParentGUID from dbo.ac000 ac where ac.GUID = 'e30187a7-eccc-4ff8-8a7d-f2df5e660b53'
  union all
  select a.GUID, a.ParentGUID from dbo.ac000 a join customer_tree t on a.ParentGUID = t.GUID
),
payment_lines as (
  select en.GUID
  from dbo.en000 en
  join customer_tree ct on ct.GUID = en.AccountGUID
  left join dbo.ce000 ce on ce.GUID = en.ParentGUID
  where coalesce(en.Credit, 0) > 0 and coalesce(en.Type, 0) = 0
    and (
      en.ContraAccGUID in (select c.GUID from cash_accounts c)
      or (
        coalesce(en.ContraAccGUID, '00000000-0000-0000-0000-000000000000') = '00000000-0000-0000-0000-000000000000'
        and ce.GUID is not null
        and coalesce(ce.TypeGUID, '00000000-0000-0000-0000-000000000000') <> 'ea69ba80-662d-4fa4-90ee-4d2e1988a8ea'
        and exists (
          select 1 from dbo.en000 d
          where d.ParentGUID = en.ParentGUID and coalesce(d.Debit, 0) > 0
            and d.AccountGUID in (select c.GUID from cash_accounts c)
        )
      )
    )
)
-- payment-rule:end
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
  -- عدد الدفعات الفعلي داخل نافذة الزخم (90 يوماً). يقارنه النموذج بعدد ما وصله
  -- فيعرف الاقتطاع يقيناً بدل الاستدلال عليه من تواريخ ما وصل.
  coalesce(payments_window.payments_in_window, 0) as payments_in_window,
  payments_window.payments_window_start,
  coalesce(recent_movements.recent_movements_json, '[]') as recent_movements_json
from dbo.cu000 cu
left join dbo.ac000 ac  on ac.GUID = cu.AccountGUID
left join dbo.ac000 acp on acp.GUID = ac.ParentGUID
outer apply (
  select top 1 en.Credit as last_payment_amount, en.Date as last_payment_date, en.Notes as last_payment_notes
  from dbo.en000 en
  where en.AccountGUID = cu.AccountGUID and coalesce(en.Credit, 0) > 0 and coalesce(en.Type, 0) = 0
    and (acp.Name = N'الموردون' or en.GUID in (select pl.GUID from payment_lines pl))
  order by en.Date desc, en.Number desc, en.GUID desc
) last_payment
outer apply (
  select (
    -- 40 لا 6: نموذج خطر التحصيل يقيس زخم السداد على نافذة 90 يوماً، وسقف الستّ
    -- كان يقتطعها لـ35 زبوناً من 121 (29%) فيُظهر سدادهم أسوأ مما هو.
    select top 40 cast(en.Credit as decimal(18, 3)) as amount, en.Date as date, en.Notes as notes, en.Number as number
    from dbo.en000 en
    where en.AccountGUID = cu.AccountGUID and coalesce(en.Credit, 0) > 0 and coalesce(en.Type, 0) = 0
      and (acp.Name = N'الموردون' or en.GUID in (select pl.GUID from payment_lines pl))
    order by en.Date desc, en.Number desc, en.GUID desc
    for json path
  ) as recent_payments_json
) recent_payments
outer apply (
  -- يُعلَن حدّ النافذة مع العدد كي تَعُدّ طبقة التقييم بالحدّ نفسه بالضبط. من
  -- دونه يقارن الطرفان عدَّين محسوبين بحدَّين مختلفين (منتصف ليل تقويمي هنا،
  -- مقابل 90×24 ساعة متدحرجة في المتصفح) فتظهر فروقات حدّية كاذبة.
  select count_big(*) as payments_in_window,
         cast(dateadd(day, -90, cast(getdate() as date)) as date) as payments_window_start
  from dbo.en000 en
  where en.AccountGUID = cu.AccountGUID and coalesce(en.Credit, 0) > 0 and coalesce(en.Type, 0) = 0
    and (acp.Name = N'الموردون' or en.GUID in (select pl.GUID from payment_lines pl))
    and en.Date >= dateadd(day, -90, cast(getdate() as date))
) payments_window
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