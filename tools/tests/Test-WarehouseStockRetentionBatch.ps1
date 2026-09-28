#Requires -Version 5.1
# ============================================================
# Test-WarehouseStockRetentionBatch.ps1
#
# عطل إنتاجي (2026-09-28): مهمة «TOBACCO Ameen Warehouse Reports» كل ساعة
# تنفّذ في tools/push-ameen-warehouse-stock.ps1 حذفاً واحداً:
#   DELETE /ameen_warehouse_stock_reports?created_at=lt.<الآن ناقص يومين>
# دور authenticated مهلته 8 ثوانٍ. الصفوف القديمة آلاف وصف items لكل منها
# عشرات الكيلوبايت، فينتهي البيان (57014) ويتراجع الحذف كاملاً ولا يُحذف شيء.
#
# قاعدة الاحتفاظ لم تتغيّر: يُحذف فقط الصف الذي created_at أقدم تماماً من
# (الآن بالتوقيت العالمي − يومين). صف الحدّ نفسه وما بعده يبقى، ومنها أحدث
# تقارير المخزون.
#
# الاختبار سلوكي: يشغّل دوال الملف الإنتاجي على جدول في الذاكرة بلا شبكة.
# الحذف دفعة واحدة فوق حد البيان يرمي مهلة ولا يمس الجدول؛ الحذف بالدفعات
# يفرّغ القديم فقط.
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
if ($pushText -match 'Method Delete[\s\S]{0,400}created_at=lt\.') {
  Add-Failure "push script still deletes by an unbounded created_at filter"
} else {
  Add-Pass "delete is no longer a single created_at filter"
}
if ($pushText -notmatch 'select=id,created_at&created_at=lt\.' -or $pushText -notmatch 'id=in\.') {
  Add-Failure "cleanup must read a limited id page (created_at=lt) and delete those ids"
} else {
  Add-Pass "cleanup reads a limited page and deletes by primary key"
}
if ($pushText -notmatch 'Method Delete -Uri "\$url/rest/v1/ameen_warehouse_stock_reports\?id=in\.\(\$filter\)" -Headers \(\$hdr \+ @\{ Prefer = "return=minimal" \}\)') {
  Add-Failure "batched delete must target id=in.(...) and Prefer: return=minimal so items jsonb is not returned"
} else {
  Add-Pass "delete is by primary key and does not return the items payload"
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
if ($retentionText -notmatch '\[int\]\$BatchSize = 40' -or $retentionText -notmatch '\[int\]\$MaxBatches = 150') {
  Add-Failure "production defaults must stay BatchSize=40 and MaxBatches=150"
} else {
  Add-Pass "production batch defaults are 40 rows and 150 rounds"
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

# صفحة مسمومة: الصف الجديد يجب ألا يدخل دفعة الحذف حتى لو أعاده الخادم.
$poison = @(
  (New-ReportRow 1 '2026-09-20T00:00:00Z'),
  (New-ReportRow 2 '2026-09-28T13:00:25Z'),
  (New-ReportRow 3 '2026-09-26T13:00:25Z'),
  (New-ReportRow 4 '2026-09-01T08:00:00Z')
)
$poisonIds = @(Get-AmeenWarehouseStockCleanupIdList (Select-AmeenWarehouseStockCleanupIds -Rows $poison -CutoffText $cutoff -BatchSize 10))
$poisonJoined = $poisonIds -join ','
if ($poisonJoined -ne ((New-ReportId 4) + ',' + (New-ReportId 1))) {
  Add-Failure "poisoned page selected '$poisonJoined' instead of the two old ids, oldest first"
} else {
  Add-Pass "fresh and exact-cutoff rows are excluded; old ids stay oldest-first"
}

$singleList = @(Get-AmeenWarehouseStockCleanupIdList (Select-AmeenWarehouseStockCleanupIds -Rows (New-ReportRow 7 '2026-09-01T00:00:00Z') -CutoffText $cutoff -BatchSize 10))
if ($singleList.Count -ne 1 -or $singleList[0] -ne (New-ReportId 7)) {
  Add-Failure "a single old row (PowerShell unwraps one-element JSON) was not selected"
} else {
  Add-Pass "a one-element page still yields one id"
}
$emptyIds = @(Get-AmeenWarehouseStockCleanupIdList (Select-AmeenWarehouseStockCleanupIds -Rows $null -CutoffText $cutoff -BatchSize 10))
if ($emptyIds.Count -ne 0) {
  Add-Failure "null page should yield no ids"
} else {
  Add-Pass "null page yields no ids"
}

# الحد الافتراضي يجب أن يبقى أصغر من الحذف الذي انتهت مهلته (آلاف الصفوف).
$seenBatchSize = 0
$defaultProbe = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -FetchPage {
  param([string]$CutoffText, [int]$BatchSize)
  $script:seenBatchSize = $BatchSize
  return $null
} -DeleteIds {
  param($Ids)
  throw "default probe must not delete"
}
if ($seenBatchSize -lt 1 -or $seenBatchSize -gt 80) {
  Add-Failure "default batch size $seenBatchSize is outside 1..80"
} else {
  Add-Pass "default batch size is $seenBatchSize"
}
if ($defaultProbe.Removed -ne 0 -or -not $defaultProbe.Exhausted) {
  Add-Failure "empty table should remove nothing and finish"
} else {
  Add-Pass "empty table finishes without a delete"
}

function New-MemoryStore {
  $store = New-Object System.Collections.ArrayList
  # 120 تقريراً قديماً (أكثر من دفعة واحدة) + 10 تقارير داخل نافذة اليومين.
  for ($i = 1; $i -le 120; $i++) {
    $stamp = (New-UtcInstant '2026-08-23T15:00:00').AddHours($i).ToString('yyyy-MM-ddTHH:mm:ssZ')
    [void]$store.Add((New-ReportRow $i $stamp))
  }
  for ($i = 201; $i -le 210; $i++) {
    $stamp = (New-UtcInstant '2026-09-27T13:00:00').AddHours($i - 201).ToString('yyyy-MM-ddTHH:mm:ssZ')
    [void]$store.Add((New-ReportRow $i $stamp))
  }
  return [pscustomobject]@{ Rows = $store }
}

$store = (New-MemoryStore).Rows
$beforeCount = @($store).Count
$legacyError = $null
try {
  $legacyIds = @(Get-AmeenWarehouseStockCleanupIdList (Select-AmeenWarehouseStockCleanupIds -Rows $store -CutoffText $cutoff -BatchSize 100000))
  if ($legacyIds.Count -gt $seenBatchSize) {
    throw "canceling statement due to statement timeout"
  }
  foreach ($id in $legacyIds) {
    $match = @($store | Where-Object { $_.id -eq $id })
    foreach ($row in $match) { [void]$store.Remove($row) }
  }
} catch {
  $legacyError = $_.Exception.Message
}
if ($legacyError -notmatch 'statement timeout') {
  Add-Failure "unbatched delete should hit the statement timeout, got: $legacyError"
} elseif (@($store).Count -ne $beforeCount) {
  Add-Failure "timed-out unbatched delete must roll back and leave every row"
} else {
  Add-Pass "unbatched delete times out and leaves the table unchanged ($beforeCount rows)"
}

$deletedFresh = New-Object System.Collections.ArrayList
$deleteCalls = 0
$cleanup = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -FetchPage {
  param([string]$CutoffText, [int]$BatchSize)
  $eligible = @($store | Where-Object {
    Test-AmeenWarehouseStockRowExpired -CreatedAt $_.created_at -CutoffText $CutoffText
  })
  $ordered = @($eligible | Sort-Object @{ Expression = { ConvertTo-AmeenWarehouseStockUtc $_.created_at } }, id)
  if ($ordered.Count -gt $BatchSize) {
    $ordered = @($ordered | Select-Object -First $BatchSize)
  }
  return $ordered
} -DeleteIds {
  param($Ids)
  $script:deleteCalls += 1
  foreach ($id in @($Ids)) {
    $match = @($store | Where-Object { $_.id -eq $id })
    if ($match.Count -ne 1) { throw "delete target missing: $id" }
    $row = $match[0]
    if (-not (Test-AmeenWarehouseStockRowExpired -CreatedAt $row.created_at -CutoffText $cutoff)) {
      [void]$deletedFresh.Add($id)
      throw "refusing to delete a row that retention keeps: $id"
    }
    [void]$store.Remove($row)
  }
}

$remainingOld = @($store | Where-Object {
  Test-AmeenWarehouseStockRowExpired -CreatedAt $_.created_at -CutoffText $cutoff
}).Count
$remainingFresh = @($store | Where-Object {
  -not (Test-AmeenWarehouseStockRowExpired -CreatedAt $_.created_at -CutoffText $cutoff)
}).Count
if ($deletedFresh.Count -ne 0) {
  Add-Failure "batched cleanup asked to delete $($deletedFresh.Count) row(s) inside the retention window"
} elseif ($remainingOld -ne 0 -or $remainingFresh -ne 10 -or $cleanup.Removed -ne 120) {
  Add-Failure "after batches removed=$($cleanup.Removed) oldLeft=$remainingOld freshLeft=$remainingFresh exhausted=$($cleanup.Exhausted)"
} elseif (-not $cleanup.Exhausted -or $cleanup.Stalled) {
  Add-Failure "cleanup should finish without stalling"
} elseif ($cleanup.Batches -lt 2) {
  Add-Failure "120 old rows must take more than one batch (batches=$($cleanup.Batches), size=$seenBatchSize)"
} else {
  Add-Pass "batched cleanup removed 120 old rows in $($cleanup.Batches) batches and kept the 10 newest"
}

# تعطل: الحذف لا يزيل الصف، فيجب أن تتوقف الحلقة بدل أن تدور حتى حد الدفعات.
$stuck = New-Object System.Collections.ArrayList
[void]$stuck.Add((New-ReportRow 900 '2026-08-01T00:00:00Z'))
$stuckCalls = 0
$stuckResult = Invoke-AmeenWarehouseStockReportCleanup -CutoffText $cutoff -MaxBatches 20 -FetchPage {
  param([string]$CutoffText, [int]$BatchSize)
  return $stuck.ToArray()
} -DeleteIds {
  param($Ids)
  $script:stuckCalls += 1
}
if (-not $stuckResult.Stalled -or $stuckCalls -gt 2 -or @($stuck).Count -ne 1) {
  Add-Failure "stall guard failed: stalled=$($stuckResult.Stalled) calls=$stuckCalls rows=$(@($stuck).Count)"
} else {
  Add-Pass "a delete that does not remove the row stops instead of looping"
}

if ($failures.Count -gt 0) {
  Write-Host ("FAILED: {0} check(s)" -f $failures.Count) -ForegroundColor Red
  exit 1
}
Write-Host "OK: warehouse stock retention batching" -ForegroundColor Green
exit 0
