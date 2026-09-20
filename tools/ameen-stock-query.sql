-- Ameen live stock query for Al-Ameen 9 / AmnDb002.  (v2 — bills-based)
-- Read-only. It does not write anything inside Al-Ameen.
--
-- لماذا v2: النسخة السابقة قرأت ms000 الذي صار يحمل رصيد أول المدة مرتين بعد
-- تدوير السنة (رصيد بطاقة المادة + فاتورة بضاعة أول المدة) فتضخّم المخزون.
-- الآن نحسب من الفواتير نفسها (bi000) بإشارة نوع الفاتورة الرسمية في الأمين
-- (bt000.bIsInput / bIsOutput) — يطابق كشف المادة في الأمين تماماً، ويعالج
-- المناقلات والمرتجعات تلقائياً. تحقق 2026-07-05: ماستر طويل ورق = 21 ✓.
--
-- Expected output for the sync agent (unchanged):
--   item_name, item_number, item_guid, group_name,
--   stock_qty, stock_qty_net, stock_qty_positive,
--   unit1_name, unit2_name, unit2_factor
--
-- stock_qty is always the NET balance across stores (stock_qty_net), including
-- negative values. It must never fall back to stock_qty_positive: a material
-- can be positive in one store and negative in another (uncleared transfer),
-- and summing only the positive side inflates the reported total. stock_qty_net
-- and stock_qty_positive stay separate diagnostic fields — do not remove them.

with per_store as (
  select
    bi.MatGUID,
    bi.StoreGUID,
    sum(
      case
        when bt.bIsInput = 1 then coalesce(bi.Qty, 0)
        when bt.bIsOutput = 1 then -coalesce(bi.Qty, 0)
        else 0
      end
    ) as qty
  from dbo.bi000 bi
  join dbo.bu000 u on u.GUID = bi.ParentGUID
  join dbo.bt000 bt on bt.GUID = u.TypeGUID
  group by bi.MatGUID, bi.StoreGUID
),
stock_by_material as (
  select
    MatGUID,
    sum(qty) as stock_qty_net,
    sum(case when qty > 0 then qty else 0 end) as stock_qty_positive
  from per_store
  group by MatGUID
)
select
  cast(mt.Number as nvarchar(32)) as item_number,
  cast(mt.GUID as nvarchar(36)) as item_guid,
  mt.Name as item_name,
  nullif(ltrim(rtrim(gr.Name)), '') as group_name,
  cast(coalesce(stock.stock_qty_net, mt.Qty, 0) as decimal(18, 3)) as stock_qty,
  cast(coalesce(stock.stock_qty_net, mt.Qty, 0) as decimal(18, 3)) as stock_qty_net,
  cast(coalesce(stock.stock_qty_positive, 0) as decimal(18, 3)) as stock_qty_positive,
  nullif(ltrim(rtrim(mt.Unity)), '') as unit1_name,
  nullif(ltrim(rtrim(mt.Unit2)), '') as unit2_name,
  cast(
    case
      when coalesce(mt.Unit2Fact, 0) > 0 then mt.Unit2Fact
      else 1
    end
    as decimal(18, 3)
  ) as unit2_factor
from dbo.mt000 mt
left join dbo.gr000 gr
  on gr.GUID = mt.GroupGUID
left join stock_by_material stock
  on stock.MatGUID = mt.GUID
where
  mt.Name is not null
  and ltrim(rtrim(mt.Name)) <> ''
order by
  mt.Number,
  mt.Name;
