#Requires -Version 5.1
# ============================================================
# Test-WarehouseStockRetentionBatch.ps1
#
# عطل إنتاجي (2026-09-28): مهمة «TOBACCO Ameen Warehouse Reports» كل ساعة
# كانت تنفّذ حذفاً واحداً:
#   DELETE /ameen_warehouse_stock_reports?created_at=lt.<الآن ناقص يومين>
# دور authenticated مهلته 8 ثوانٍ، فينتهي البيان (57014) ولا يُحذف شيء.
#
# تقسيم الحذف إلى معرّفات لا يكفي. smart_inventory_sessions.source_report_id
# يشير إلى التقرير بلا ON DELETE. حذف تقرير ما زالت جلسة جرد تشير إليه يفشل
# بخرق المفتاح الأجنبي. CASCADE محظور لأنه يمسح الجلسة وأصنافها وعدّها وسجلها.
# inventory_recon_sessions يستخدم ON DELETE SET NULL، ونُبقي إشارته أيضاً.
#
# التنظيف صار نداءً متكرراً لدالة prune_ameen_warehouse_stock_reports: دفعة
# محدودة من الصفوف الأقدم تماماً من يومين وغير المشار إليها. حد اليومين نفسه.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-WarehouseStockRetentionBatch.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$retentionPath = Join-Path (Join-Path $repoRoot 'tools') 'ameen-warehouse-stock-retention.ps1'
$pushPath = Join-Path (Join-Path $repoRoot 'tools') 'push-ameen-warehouse-stock.ps1'
$migrationPath = Join-Path (Join-Path (Join-Path $repoRoot 'supabase') 'migrations') '20260928140000_prune_ameen_warehouse_stock_reports.sql'
$failures = New-Object System.Collections.ArrayList

function Add-Failure([string]$Message) {
  [void]$failures.Add($Message)
  Write-Host "  FAIL: $Message" -ForegroundColor Red
}
function Add-Pass([string]$Message) {
  Write-Host "  ok  : $Message" -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $pushPath)) {
  Write-Host "FAIL: missing $pushPath" -ForegroundColor Red
  exit 1
}
$pushText = Get-Content -LiteralPath $pushPath -Raw -Encoding UTF8

if ($pushText -notmatch 'ameen-warehouse-stock-retention\.ps1') {
  Add-Failure "push-ameen-warehouse-stock.ps1 must dot-source the retention file"
} else {
  Add-Pass "push script uses the retention file"
}
if ($pushText -notmatch 'Invoke-AmeenWarehouseStockReportCleanup') {
  Add-Failure "push script must call Invoke-AmeenWarehouseStockReportCleanup"
} else {
  Add-Pass "push script calls the batched cleanup"
}
if ($pushText -match 'AddDays\(') {
  Add-Failure "push script must not compute its own retention window"
} else {
  Add-Pass "push script does not override the two-day cutoff"
}
if ($pushText -match 'Method Delete' -or $pushText -match 'created_at=lt\.' -or $pushText -match 'id=in\.') {
  Add-Failure "push script still deletes rows itself; cleanup must be the prune RPC only"
} else {
  Add-Pass "push script does not delete warehouse reports directly"
}
if ($pushText -notmatch 'rest/v1/rpc/prune_ameen_warehouse_stock_reports' -or $pushText -notmatch 'p_before' -or $pushText -notmatch 'p_limit') {
  Add-Failure "push script must POST prune_ameen_warehouse_stock_reports with p_before and p_limit"
} else {
  Add-Pass "push script calls the prune function in a loop"
}
if ($pushText -match '(?i)(delete|update|insert).{0,120}smart_inventory') {
  Add-Failure "push script must not write smart_inventory tables"
} else {
  Add-Pass "push script does not write smart inventory tables"
}

if (-not (Test-Path -LiteralPath $migrationPath)) {
  Add-Failure "missing $migrationPath"
  Write-Host ("FAILED: {0} check(s)" -f $failures.Count) -ForegroundColor Red
  exit 1
}
$migrationText = Get-Content -LiteralPath $migrationPath -Raw -Encoding UTF8
$migrationCode = [regex]::Replace($migrationText, '(?m)--.*$', '')
$migrationCode = [regex]::Replace($migrationCode, '/\*[\s\S]*?\*/', '')
if ($migrationText -notmatch 'security definer' -or $migrationText -notmatch "set search_path = ''") {
  Add-Failure "prune function must be security definer with an empty search_path"
} else {
  Add-Pass "prune function is security definer with a fixed search_path"
}
if ($migrationText -notmatch '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3') {
  Add-Failure "prune function must allow only the sync writer UUID"
} else {
  Add-Pass "prune function checks the sync writer"
}
if ($migrationCode -notmatch 'not exists \([\s\S]{0,240}smart_inventory_sessions' -or $migrationCode -notmatch 'not exists \([\s\S]{0,240}inventory_recon_sessions') {
  Add-Failure "prune function must skip reports referenced by smart inventory and recon sessions"
} else {
  Add-Pass "prune function skips referenced reports"
}
if ($migrationCode -match '(?i)on delete cascade' -or $migrationCode -match '(?i)alter table[\s\S]{0,160}smart_inventory_' -or $migrationCode -match '(?i)(update|delete from|insert into)\s+public\.smart_inventory_' -or $migrationCode -match '(?i)(update|delete from|insert into)\s+public\.inventory_recon_sessions') {
  Add-Failure "migration must not change inventory foreign keys or write inventory rows"
} else {
  Add-Pass "migration does not cascade or write inventory rows"
}
if ($migrationText -notmatch "least\(p_before, pg_catalog\.now\(\) - interval '2 days'\)" -or $migrationText -notmatch 'p_limit > 40') {
  Add-Failure "prune function must clamp the cutoff at two days and cap the batch at 40"
} else {
  Add-Pass "cutoff stays two days and the batch cap stays 40"
}

if (-not (Test-Path -LiteralPath $retentionPath)) {
  Add-Failure "missing $retentionPath"
  Write-Host ("FAILED: {0} check(s)" -f $failures.Count) -ForegroundColor Red
  exit 1
}

. $retentionPath
Add-Pass "loaded retention functions from the production file"
$retentionText = Get-Content -LiteralPath $retentionPath -Raw -Encoding UTF8

if ($retentionText -notmatch 'AddDays\(-2\)') {
  Add-Failure "retention cutoff must stay AddDays(-2)"
} else {
  Add-Pass "cutoff is still two days"
}
if ($retentionText -match 'AddDays\(-(1|3|7|14|30)\)') {
  Add-Failure "retention window drifted away from two days"
}
if ($retentionText -notmatch '\[int\]\$BatchSize = 40' -or $retentionText -notmatch '\[int\]\$MaxBatches = 150' -or $retentionText -notmatch '\[scriptblock\]\$PruneBatch') {
  Add-Failure "production cleanup must take a prune callback with BatchSize=40 and MaxBatches=150"
} else {
  Add-Pass "production batch defaults are 40 rows and 150 rounds"
}
if ($retentionText -match '\$FetchPage' -or $retentionText -match '\$DeleteIds' -or $retentionText -match 'id=in') {
  Add-Failure "retention module must not select or delete report ids itself"
} else {
  Add-Pass "retention module only repeats the prune call"
}

function New-UtcInstant([string]$Text) {
  return [datetime]::ParseExact(
    $Text,
    'yyyy-MM-ddTHH:mm:ss',
    [cultureinfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  )
}

$now = New-UtcInstant '2026-09-28T13:00:25'
$cutoff = Get-AmeenWarehouseStockRetentionCutoffText -Now $now
if ($cutoff -ne '2026-09-26T13:00:25Z') {
  Add-Failure "cutoff text for 2026-09-28T13:00:25Z was '$cutoff', expected 2026-09-26T13:00:25Z"
} else {
  Add-Pass "cutoff text matches the previous two-day UTC boundary"
}

$boundaryCases = @(
  @{ At = '2026-09-26T13:00:24Z'; Expired = $true; Label = 'one second older than the cutoff' },
  @{ At = '2026-09-26T13:00:24.9+00:00'; Expired = $true; Label = 'fraction just before the cutoff second' },
  @{ At = '2026-09-26T13:00:25Z'; Expired = $false; Label = 'exact cutoff instant' },
  @{ At = '2026-09-26T13:00:25.1+00:00'; Expired = $false; Label = 'fraction after the cutoff' },
  @{ At = '2026-09-28T13:00:25Z'; Expired = $false; Label = 'report inserted in the current run' },
  @{ At = '2026-08-23T15:00:18.10661+00:00'; Expired = $true; Label = 'oldest backlog shape' }
)
foreach ($case in $boundaryCases) {
  $expired = Test-AmeenWarehouseStockRowExpired -CreatedAt $case.At -CutoffText $cutoff
  if ($expired -ne $case.Expired) {
    Add-Failure "$($case.Label): expired=$expired, expected $($case.Expired)"
  } else {
    Add-Pass $case.Label
  }
}

function New-ReportId([int]$Number) {
  return ('00000000-0000-4000-8000-{0:d12}' -f $Number)
}
function New-ReportRow([int]$Number, [string]$CreatedAt) {
  return [pscustomobject]@{
    id = (New-ReportId $Number)
    created_at = $CreatedAt
  }
}

# نفس قاعدة الدالة: الصف يُحذف فقط إذا كان أقدم من الحد وغير مشار إليه.
# الإشارات تُمرَّر كمجموعات ولا تُعدَّل. الصف المشار إليه لا يستهلك خانة الدفعة.
function Invoke-ModelPrune {
  param(
    $Store,
    $SmartIds,
    $ReconIds,
    [Parameter(Mandatory = $true)][string]$CutoffText,
    [Parameter(Mandatory = $true)][int]$BatchSize
  )
  $smart = @{}
  $recon = @{}
  foreach ($id in @($SmartIds)) { if ($id) { $smart[[string]$id] = $true } }
  foreach ($id in @($ReconIds)) { if ($id) { $recon[[string]$id] = $true } }
  $eligible = New-Object System.Collections.Generic.List[object]
  foreach ($row in @($Store)) {
    if ($null -eq $row) { continue }
    if (-not (Test-AmeenWarehouseStockRowExpired -CreatedAt $row.created_at -CutoffText $CutoffText)) { continue }
    if ($smart.ContainsKey([string]$row.id)) { continue }
    if ($recon.ContainsKey([string]$row.id)) { continue }
    [void]$eligible.Add($row)
  }
  $ordered = @($eligible.ToArray() | Sort-Object @{ Expression = { ConvertTo-AmeenWarehouseStockUtc $_.created_at } }, id)
  if ($ordered.Count -gt $BatchSize) {
    $ordered = @($ordered | Select-Object -First $BatchSize)
  }
  $removed = 0
  foreach ($row in $ordered) {
    if ($null -eq $row) { continue }
    [void]$Store.Remove($row)
    $removed += 1
  }
  return [int]$removed
}

$seenBatchSize = 0
$defaultProbe = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -PruneBatch {
  param([string]$CutoffText, [int]$BatchSize)
  $script:seenBatchSize = $BatchSize
  return 0
}
if ($seenBatchSize -ne 40) {
  Add-Failure "default batch size was $seenBatchSize, expected 40"
} else {
  Add-Pass "default batch size is 40"
}
if ($defaultProbe.Removed -ne 0 -or -not $defaultProbe.Exhausted) {
  Add-Failure "empty table should remove nothing and finish"
} else {
  Add-Pass "empty table finishes without a delete"
}

$peekCalls = 0
$capped = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -MaxBatches 2 -PruneBatch {
  param([string]$CutoffText, [int]$BatchSize)
  $script:peekCalls += 1
  return $BatchSize
}
if ($peekCalls -ne 2 -or $capped.Removed -ne 80 -or $capped.Exhausted) {
  Add-Failure "full batches must stop at MaxBatches without an extra deleting call (calls=$peekCalls removed=$($capped.Removed) exhausted=$($capped.Exhausted))"
} else {
  Add-Pass "a full backlog stops at the batch cap and continues next hour"
}

function New-MemoryStore {
  $store = New-Object System.Collections.ArrayList
  $smart = New-Object System.Collections.ArrayList
  $recon = New-Object System.Collections.ArrayList
  # 8 جلسات تجربة قديمة، وتقرير جرد مطابق قديم، و41 تقريراً قديماً بلا إشارة.
  for ($i = 1; $i -le 8; $i++) {
    $stamp = (New-UtcInstant '2026-08-23T15:00:00').AddDays($i).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $row = New-ReportRow $i $stamp
    [void]$store.Add($row)
    [void]$smart.Add($row.id)
  }
  $reconRow = New-ReportRow 9 '2026-09-01T00:00:00Z'
  [void]$store.Add($reconRow)
  [void]$recon.Add($reconRow.id)
  $both = New-ReportRow 10 '2026-09-02T00:00:00Z'
  [void]$store.Add($both)
  [void]$smart.Add($both.id)
  [void]$recon.Add($both.id)
  for ($i = 11; $i -le 51; $i++) {
    $stamp = (New-UtcInstant '2026-09-03T00:00:00').AddHours($i).ToString('yyyy-MM-ddTHH:mm:ssZ')
    [void]$store.Add((New-ReportRow $i $stamp))
  }
  $exact = New-ReportRow 60 '2026-09-26T13:00:25Z'
  [void]$store.Add($exact)
  for ($i = 201; $i -le 209; $i++) {
    $stamp = (New-UtcInstant '2026-09-27T13:00:00').AddHours($i - 201).ToString('yyyy-MM-ddTHH:mm:ssZ')
    [void]$store.Add((New-ReportRow $i $stamp))
  }
  $today = New-ReportRow 300 '2026-09-28T12:00:00Z'
  [void]$store.Add($today)
  [void]$smart.Add($today.id)
  return [pscustomobject]@{
    Rows = $store
    SmartIds = $smart.ToArray()
    ReconIds = $recon.ToArray()
  }
}

$fixture = New-MemoryStore
$store = $fixture.Rows
$smartIds = $fixture.SmartIds
$reconIds = $fixture.ReconIds
$protectedIds = @($smartIds + $reconIds + @(
  (New-ReportId 60),
  (New-ReportId 201),
  (New-ReportId 202),
  (New-ReportId 203),
  (New-ReportId 204),
  (New-ReportId 205),
  (New-ReportId 206),
  (New-ReportId 207),
  (New-ReportId 208),
  (New-ReportId 209)
))
$beforeProtected = @($store | Where-Object { $protectedIds -contains $_.id }).Count
$pruneCalls = 0
$cleanup = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -PruneBatch {
  param([string]$CutoffText, [int]$BatchSize)
  $script:pruneCalls += 1
  return (Invoke-ModelPrune -Store $store -SmartIds $smartIds -ReconIds $reconIds -CutoffText $CutoffText -BatchSize $BatchSize)
}
$afterProtected = @($store | Where-Object { $protectedIds -contains $_.id }).Count
$expiredUnreferenced = @($store | Where-Object {
  (Test-AmeenWarehouseStockRowExpired -CreatedAt $_.created_at -CutoffText $cutoff) -and
  ($smartIds -notcontains $_.id) -and
  ($reconIds -notcontains $_.id)
}).Count
$missingRefs = @($smartIds + $reconIds | Where-Object {
  $id = $_
  -not @($store | Where-Object { $_.id -eq $id })
}).Count
if ($beforeProtected -ne $afterProtected -or $missingRefs -ne 0) {
  Add-Failure "referenced or in-window reports were deleted ($beforeProtected -> $afterProtected, missingRefs=$missingRefs)"
} elseif ($expiredUnreferenced -ne 0) {
  Add-Failure "old unreferenced rows remain ($expiredUnreferenced)"
} elseif ($cleanup.Removed -ne 41 -or -not $cleanup.Exhausted -or $pruneCalls -ne 2) {
  Add-Failure "expected 41 unreferenced old rows in 2 calls, got removed=$($cleanup.Removed) calls=$pruneCalls exhausted=$($cleanup.Exhausted)"
} else {
  Add-Pass "referenced smart-inventory and recon reports stayed; 41 old unreferenced rows were deleted"
}

# لما تبقى التقارير القديمة كلها مشار إليها، الدفعة ترجع صفراً وتبقى الصفوف.
$onlyRefs = New-Object System.Collections.ArrayList
$onlySmart = New-Object System.Collections.ArrayList
$refRow = New-ReportRow 900 '2026-08-01T00:00:00Z'
[void]$onlyRefs.Add($refRow)
[void]$onlySmart.Add($refRow.id)
$onlyCalls = 0
$onlyResult = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -PruneBatch {
  param([string]$CutoffText, [int]$BatchSize)
  $script:onlyCalls += 1
  return (Invoke-ModelPrune -Store $onlyRefs -SmartIds $onlySmart.ToArray() -ReconIds @() -CutoffText $CutoffText -BatchSize $BatchSize)
}
if ($onlyResult.Removed -ne 0 -or -not $onlyResult.Exhausted -or $onlyCalls -ne 1 -or @($onlyRefs).Count -ne 1) {
  Add-Failure "a referenced-only backlog must return 0 and keep the report (removed=$($onlyResult.Removed) calls=$onlyCalls rows=$(@($onlyRefs).Count))"
} else {
  Add-Pass "when every old report is still referenced, nothing is deleted"
}

if ($failures.Count -gt 0) {
  Write-Host ("FAILED: {0} check(s)" -f $failures.Count) -ForegroundColor Red
  exit 1
}
Write-Host "OK: warehouse stock retention preserves referenced reports" -ForegroundColor Green
exit 0
