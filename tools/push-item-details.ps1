# يرفع توزيع مخزون الصنف على المستودعات إلى Supabase ليعرضه زر معلومات
# الصنف (i) داخل فاتورة المبيعات.
#
# لا يرفع التكلفة إطلاقاً: inventory_reports يقرأه كل موظف مسجّل، بينما التكلفة
# والربح للمدير فقط. مصدر التكلفة الوحيد هو جدول item_costs المحمي بـRLS
# (is_owner) الذي يملؤه tools/push-item-costs.ps1.
#
# قراءة فقط من الأمين. يكتب في inventory_reports بمصدر ameen_item_details فقط —
# لا يمسّ الأسعار ولا approved_price_items ولا مزامنة الإنتاج (ameen-sync-agent.ps1).
#
# التشغيل التجريبي (بلا كتابة):  .\tools\push-item-details.ps1 -WhatIf
# التشغيل الفعلي:               .\tools\push-item-details.ps1
param([switch]$WhatIf)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# نفس تطبيع الاسم المستخدم في ameen-sync-agent.ps1 (item_key = الاسم المطبّع)
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
function Get-EnvVar($name) {
  $v = [Environment]::GetEnvironmentVariable($name, "User")
  if (-not $v) { $v = [Environment]::GetEnvironmentVariable($name, "Process") }
  if (-not $v) { throw "متغير البيئة ناقص: $name" }
  return $v
}

# ── قراءة الأمين ──────────────────────────────────────────────────────────────
# المخزون حسب المستودع: نفس منطق ameen-stock-query.sql (v2 من الفواتير بأعلام
#   bIsInput/bIsOutput) — لا يُقرأ من ms000 بعد تدوير السنة.
# مستودع الامانة مستبعد كما في ameen-stock-query.sql (بـGUID لا بالاسم): لا يظهر
#   سطراً في بطاقة الصنف ولا يدخل «مجموع المستودعات». قراءة فقط.
$sql = @'
with excluded_stores as (
  -- مستودع الامانة — dbo.st000.GUID
  select 'CA3BACBB-87FE-4826-B051-CAC335CDB670' as StoreGUID
),
per_store as (
  select bi.MatGUID, bi.StoreGUID,
    sum(case when bt.bIsInput = 1 then coalesce(bi.Qty, 0)
             when bt.bIsOutput = 1 then -coalesce(bi.Qty, 0)
             else 0 end) as qty
  from dbo.bi000 bi
  join dbo.bu000 u on u.GUID = bi.ParentGUID
  join dbo.bt000 bt on bt.GUID = u.TypeGUID
  left join excluded_stores xs
    on xs.StoreGUID = coalesce(nullif(bi.StoreGUID, '00000000-0000-0000-0000-000000000000'), u.StoreGUID)
  where xs.StoreGUID is null
  group by bi.MatGUID, bi.StoreGUID
)
select
  cast(mt.Number as nvarchar(32))            as item_number,
  mt.Name                                    as item_name,
  cast(isnull(mt.Unit2Fact, 1) as decimal(18,3)) as unit2_factor,
  isnull(st.Name, '')                        as store_name,
  cast(ps.qty as decimal(18,3))              as store_qty
from dbo.mt000 mt
left join per_store ps on ps.MatGUID = mt.GUID and ps.qty <> 0
left join dbo.st000 st on st.GUID = ps.StoreGUID
where mt.Name is not null and ltrim(rtrim(mt.Name)) <> ''
order by mt.Number, st.Name
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

$byKey = @{}
while ($rd.Read()) {
  $name = [string]$rd["item_name"]
  $key = Normalize-ItemName $name
  if (-not $key) { continue }
  if (-not $byKey.ContainsKey($key)) {
    $byKey[$key] = [ordered]@{
      key        = $key
      num        = [string]$rd["item_number"]
      name       = $name
      unit2Factor= [double]$rd["unit2_factor"]
      stores     = @()
    }
  }
  $store = [string]$rd["store_name"]
  if ($store) {
    $byKey[$key].stores += ,([ordered]@{ name = $store; qty = [double]$rd["store_qty"] })
  }
}
$rd.Close(); $cn.Close()

$items = @($byKey.Values)
$withStores = @($items | Where-Object { $_.stores.Count -gt 0 }).Count
Write-Host "أصناف الأمين: $($items.Count) — لها مخزون بمستودعات: $withStores"

if ($items.Count -eq 0) { throw "لم تُقرأ أي أصناف — أوقفت الرفع." }

if ($WhatIf) {
  Write-Host "[تجربة] لن يُكتب شيء. عيّنة:" -ForegroundColor Cyan
  $items | Where-Object { $_.stores.Count -gt 0 } | Select-Object -First 5 | ForEach-Object {
    $s = ($_.stores | ForEach-Object { "$($_.name)=$($_.qty)" }) -join " ، "
    Write-Host ("  #{0} {1} | {2}" -f $_.num, $_.name, $s)
  }
  exit 0
}

# ── الرفع إلى Supabase (inventory_reports فقط) ────────────────────────────────
$url = (Get-EnvVar "TOBACCO_SUPABASE_URL").TrimEnd("/")
$key = Get-EnvVar "TOBACCO_SUPABASE_PUBLIC_KEY"
$auth = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" `
  -Headers @{ apikey = $key; Accept = "application/json" } `
  -ContentType "application/json; charset=utf-8" `
  -Body (@{ email = (Get-EnvVar "TOBACCO_SYNC_EMAIL"); password = (Get-EnvVar "TOBACCO_SYNC_PASSWORD") } | ConvertTo-Json)
$hdr = @{ apikey = $key; Authorization = ("Bearer " + $auth.access_token); "Accept-Profile" = "public"; "Content-Profile" = "public" }

$body = @{
  report_date = (Get-Date).ToString("yyyy-MM-dd")
  source      = "ameen_item_details"
  created_by  = $auth.user.id
  summary     = @{
    source       = "ameen_item_details"
    generated_at = (Get-Date).ToUniversalTime().ToString("o")
    item_count   = $items.Count
    with_stores  = $withStores
    note         = "stores_only_no_cost"   # التكلفة في item_costs المحمي، ليست هنا
  }
  items = $items
} | ConvertTo-Json -Depth 6 -Compress

Invoke-RestMethod -Method Post -Uri "$url/rest/v1/inventory_reports" `
  -Headers ($hdr + @{ Prefer = "return=minimal" }) `
  -ContentType "application/json; charset=utf-8" -Body $body | Out-Null

Write-Host "تم رفع تفاصيل $($items.Count) صنف إلى inventory_reports (ameen_item_details)." -ForegroundColor Green
