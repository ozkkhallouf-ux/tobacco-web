# يرفع مخزون كل مستودع فعلي بالأمين (dbo.st000) إلى Supabase — تقرير مستقل
# لكل مستودع بالمصدر ameen_warehouse_stock، يستخدمه الجرد الشهري لعرض قائمة
# المستودعات الحقيقية واختيار مستودع واحد عند كل جرد فعلي.
#
# لا يوجد مستودع "جملة" أو "مركز عام" ثابت بالأمين — المفتاح الموثوق الوحيد
# هو GUID مستودع dbo.st000، والاسم للعرض فقط. هذا السكريبت لا يخترع مستودعات
# ولا يربط مستودعاً بنوع بيع (جملة/مفرق).
#
# قراءة فقط من الأمين (SELECT فقط، بلا أي INSERT/UPDATE/DELETE). يكتب في
# Supabase على ameen_warehouse_stock_reports فقط (جدول مستقل محصور الكتابة
# بحساب المزامنة هذا عبر RLS — مراجعة Codex على PR #40) — لا يمسّ أي جدول
# أو رصيد أو سعر بالأمين.
#
# التشغيل التجريبي (بلا كتابة، يطبع أسماء المستودعات وعدد الأصناف والمجموع فقط):
#   .\tools\push-ameen-warehouse-stock.ps1 -WhatIf
# التشغيل الفعلي:
#   .\tools\push-ameen-warehouse-stock.ps1
param(
  [switch]$WhatIf,
  [string]$EnvFile = ""
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot "ameen-warehouse-stock-retention.ps1")

if ($EnvFile -and (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
  Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
    $parts = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
  }
}

function Get-EnvVar($name) {
  $v = [Environment]::GetEnvironmentVariable($name, "Process")
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, "User") }
  if (-not $v) { throw "متغير البيئة ناقص: $name" }
  return $v
}

# نفس تطبيع الاسم المستخدم في push-item-details.ps1 وameen-sync-agent.ps1 —
# itemKey هنا هو نفس المفتاح الذي يطابق به RPC (inventory_recon_create_session_with_lines)
# سطور الجرد مع أصناف تقرير المستودع الموثوق.
function Normalize-ItemName($Value) {
  $text = if ($null -ne $Value) { [string]$Value } else { "" }
  $text = $text.Trim()
  $text = [regex]::Replace($text, '^\d{2,}\s*-\s*', "")
  $text = $text.Replace("أ","ا").Replace("إ","ا").Replace("آ","ا").Replace("ى","ي").Replace("ة","ه")
  $text = [regex]::Replace($text, "[^\p{L}\p{N}]+", " ")
  $text = [regex]::Replace($text, "\s+", " ")
  $n = $text.Trim().ToLowerInvariant()
  switch ($n) {
    "كابتن بلاك كوين ازرق" { return "كابتن بلاك كور ازرق جديد" }
    "كابتن بلاك كوين اسود" { return "كابتن بلاك كور اسود جديد" }
    default { return $n }
  }
}

# ── قراءة الأمين (SELECT فقط) ─────────────────────────────────────────────────
# نفس منطق ameen-stock-query.sql (bIsInput/bIsOutput) لكن بدون تجميع المستودعات
# مع بعضها — كل مستودع بـdbo.st000 يبقى منفصلاً بالنتيجة، وتُدرَج كل الأصناف
# بكل مستودع (حتى برصيد صفر) ليتوفّر كتالوغ كامل عند الجرد الفعلي.
# ملاحظة: عمود st000.IsActive قيمته False لكل المستودعات الخمسة الحقيقية بهذا
# التركيب (تحقّق 2026-08-04) — أي لا يعكس فعلاً كون المستودع مستخدَماً أم لا،
# لذلك لا نُصفّي عليه؛ st000 يحوي 5 صفوف فقط وتطابق المستودعات الفعلية تماماً.
$sql = @'
with per_store as (
  select bi.MatGUID, bi.StoreGUID,
    sum(case when bt.bIsInput = 1 then coalesce(bi.Qty, 0)
             when bt.bIsOutput = 1 then -coalesce(bi.Qty, 0)
             else 0 end) as qty
  from dbo.bi000 bi
  join dbo.bu000 u on u.GUID = bi.ParentGUID
  join dbo.bt000 bt on bt.GUID = u.TypeGUID
  group by bi.MatGUID, bi.StoreGUID
)
select
  cast(st.GUID as nvarchar(36))              as store_guid,
  st.Name                                    as store_name,
  cast(mt.GUID as nvarchar(36))              as item_guid,
  cast(mt.Number as nvarchar(32))            as item_number,
  mt.Name                                    as item_name,
  nullif(ltrim(rtrim(mt.Unity)), '')         as unit1_name,
  cast(isnull(ps.qty, 0) as decimal(18,3))   as qty
from dbo.st000 st
cross join dbo.mt000 mt
left join per_store ps on ps.MatGUID = mt.GUID and ps.StoreGUID = st.GUID
where mt.Name is not null and ltrim(rtrim(mt.Name)) <> ''
order by st.Name, mt.Number
'@

$cs = Get-EnvVar "AMEEN_SQL_CONNECTION_STRING"
$cn = New-Object System.Data.SqlClient.SqlConnection $cs
try { $cn.Open() }
catch {
  # اسم الخادم OZK-TOBACCO يتذبذب مع VPN — الرجوع إلى الـIP المباشر
  Write-Host "تعذّر الاتصال بالاسم، أجرّب الـIP المباشر..." -ForegroundColor Yellow
  $cn = New-Object System.Data.SqlClient.SqlConnection ($cs -replace 'OZK-TOBACCO', '192.168.1.200,1433')
  $cn.Open()
}
$cmd = $cn.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 300
$rd = $cmd.ExecuteReader()

$byStore = [ordered]@{}
while ($rd.Read()) {
  $storeGuid = [string]$rd["store_guid"]
  $storeName = [string]$rd["store_name"]
  if (-not $storeGuid -or -not $storeName) { continue }
  if (-not $byStore.Contains($storeGuid)) {
    $byStore[$storeGuid] = [ordered]@{
      guid  = $storeGuid
      name  = $storeName
      items = @()
    }
  }
  $itemName = [string]$rd["item_name"]
  $itemKey = Normalize-ItemName $itemName
  if (-not $itemKey) { continue }
  $byStore[$storeGuid].items += ,([ordered]@{
    itemKey    = $itemKey
    itemGuid   = [string]$rd["item_guid"]
    itemNumber = [string]$rd["item_number"]
    itemName   = $itemName
    unitName   = [string]$rd["unit1_name"]
    qty        = [double]$rd["qty"]
  })
}
$rd.Close(); $cn.Close()

# مواد حقيقية مختلفة قد تتطابق بعد Normalize-ItemName (تختلف بعلامات ترقيم فقط،
# مثال بطاقتي 273/274). itemKey يُستخدم كمفتاح فريد بالواجهة وبقيد
# unique(session_id, item_key) بالجرد الفعلي، فتصادم مفتاحين يُخفي أحد الصنفين أو
# يمنع حفظ الجرد — نميّز كل مجموعة متصادمة بإضافة بادئة من itemGuid (فريد دوماً).
foreach ($storeGuid in @($byStore.Keys)) {
  $groups = $byStore[$storeGuid].items | Group-Object -Property itemKey
  foreach ($g in $groups) {
    if ($g.Count -le 1) { continue }
    foreach ($it in $g.Group) {
      $guidSuffix = ($it.itemGuid -replace '[^0-9a-fA-F]', '')
      if ($guidSuffix.Length -gt 8) { $guidSuffix = $guidSuffix.Substring(0, 8) }
      $it.itemKey = "$($it.itemKey)_$guidSuffix"
    }
  }
}

$stores = @($byStore.Values)
if ($stores.Count -eq 0) { throw "لم تُقرأ أي مستودعات — أوقفت الرفع." }

Write-Host "مستودعات: $($stores.Count)"
foreach ($s in $stores) {
  $total = 0.0
  foreach ($it in $s.items) { $total += $it.qty }
  Write-Host ("  {0} — أصناف: {1} — إجمالي الكمية: {2}" -f $s.name, $s.items.Count, [math]::Round($total, 3))
}

if ($WhatIf) {
  Write-Host "[تجربة] لن يُكتب شيء." -ForegroundColor Cyan
  exit 0
}

# ── الرفع إلى Supabase (inventory_reports فقط، تقرير مستقل لكل مستودع) ────────
$url = (Get-EnvVar "TOBACCO_SUPABASE_URL").TrimEnd("/")
$key = Get-EnvVar "TOBACCO_SUPABASE_PUBLIC_KEY"
$auth = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" `
  -Headers @{ apikey = $key; Accept = "application/json" } `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{ email = (Get-EnvVar "TOBACCO_SYNC_EMAIL"); password = (Get-EnvVar "TOBACCO_SYNC_PASSWORD") } | ConvertTo-Json)
$hdr = @{ apikey = $key; Authorization = ("Bearer " + $auth.access_token); "Accept-Profile" = "public"; "Content-Profile" = "public" }
$generatedAt = (Get-Date).ToUniversalTime().ToString("o")
$reportDate = (Get-Date).ToString("yyyy-MM-dd")

foreach ($s in $stores) {
  $body = @{
    report_date = $reportDate
    created_by  = $auth.user.id
    summary     = @{
      source        = "ameen_warehouse_stock"
      generated_at  = $generatedAt
      warehouseKey  = $s.guid
      warehouseName = $s.name
      item_count    = $s.items.Count
    }
    items = $s.items
  } | ConvertTo-Json -Depth 6 -Compress

  Invoke-RestMethod -Method Post -Uri "$url/rest/v1/ameen_warehouse_stock_reports" `
    -Headers ($hdr + @{ Prefer = "return=minimal" }) `
    -ContentType "application/json; charset=utf-8" -Body $body | Out-Null

  Write-Host "رُفع تقرير مستودع: $($s.name) ($($s.items.Count) صنف)." -ForegroundColor Green
}

# الإبقاء على حد اليومين عبر Get-AmeenWarehouseStockRetentionCutoffText.
# الحذف السابق كان طلباً واحداً لكل الصفوف المطابقة، فينتهي بيان دور
# authenticated (8 ثوانٍ) ويتراجع الحذف. الفهرس على created_at موجود؛
# الصفحة المحدودة تستخدمه، والحذف هنا بمعرّفات الدفعة فقط بلا جسم items.
$cutoff = Get-AmeenWarehouseStockRetentionCutoffText
try {
  $fetchPage = {
    param([string]$CutoffText, [int]$BatchSize)
    $pageUri = "$url/rest/v1/ameen_warehouse_stock_reports?select=id,created_at&created_at=lt.$CutoffText&order=created_at.asc&limit=$BatchSize"
    return Invoke-RestMethod -Method Get -Uri $pageUri -Headers $hdr
  }.GetNewClosure()
  $deleteIds = {
    param($Ids)
    # اسم مختلف عن $Ids: PowerShell لا يفرّق حالة الأحرف.
    $batchIds = @($Ids | Where-Object { $_ })
    if ($batchIds.Count -eq 0) { return }
    $filter = ($batchIds -join ",")
    Invoke-RestMethod -Method Delete -Uri "$url/rest/v1/ameen_warehouse_stock_reports?id=in.($filter)" -Headers ($hdr + @{ Prefer = "return=minimal" }) | Out-Null
  }.GetNewClosure()
  $cleanup = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -FetchPage $fetchPage -DeleteIds $deleteIds
  if ($cleanup.Stalled) {
    Write-Warning "توقف تنظيف تقارير المخزون: دفعة لم تُحذف، ستُعاد في الجولة التالية."
  } elseif (-not $cleanup.Exhausted) {
    Write-Warning "تنظيف تقارير المخزون لم يكتمل في هذه الجولة ($($cleanup.Removed) صفاً). تكمل الجولة التالية."
  } elseif ($cleanup.Removed -gt 0) {
    Write-Host "نُظّف $($cleanup.Removed) تقرير مخزون أقدم من يومين، على دفعات." -ForegroundColor Green
  }
} catch { Write-Warning "تعذّر تنظيف تقارير المخزون القديمة: $($_.Exception.Message)" }

Write-Host "تم رفع $($stores.Count) تقرير مستودع مستقل إلى ameen_warehouse_stock_reports." -ForegroundColor Green
