#Requires -Version 5.1
# قاعدة الاحتفاظ بتقارير مخزون المستودعات، والحذف على دفعات.
#
# الحد نفسه الذي كان في tools/push-ameen-warehouse-stock.ps1:
# يُحذف الصف فقط إذا كان created_at أقدم تماماً من (الآن UTC − يومين).
# صف الحدّ نفسه، وكل تقرير أحدث منه، يبقى. هذا يشمل التقارير التي تُرفع
# في نفس تشغيل المهمة.
#
# لماذا الدفعات: دور authenticated على Supabase مهلته 8 ثوانٍ. حذف كل
# الصفوف المطابقة ببيان واحد كان يُلغى (57014) فيتراجع ولا يُحذف شيء،
# لأن المتراكم آلاف الصفوف وعمود items كبير. الفهرس
# ameen_warehouse_stock_reports_created_at_idx موجود أصلاً على created_at
# في الإنتاج وفي supabase/ameen-warehouse-stock-reports.sql. قراءة صفحة
# مرتبة ومحدودة تستخدمه. حذف الجدول كله دفعة واحدة لا يستخدمه لأن أغلب
# الصفوف تطابق الشرط، فيمسح الجدول. لذلك لا هجرة فهرس جديدة.

function ConvertTo-AmeenWarehouseStockUtc {
  param([Parameter(Mandatory = $true)]$Value)
  if ($Value -is [datetimeoffset]) {
    return $Value.UtcDateTime
  }
  if ($Value -is [datetime]) {
    $dt = [datetime]$Value
    if ($dt.Kind -eq [DateTimeKind]::Utc) { return $dt }
    if ($dt.Kind -eq [DateTimeKind]::Local) { return $dt.ToUniversalTime() }
    return [datetime]::SpecifyKind($dt, [DateTimeKind]::Utc)
  }
  $text = ([string]$Value).Trim()
  if ($text.EndsWith("Z")) {
    $text = $text.Substring(0, $text.Length - 1) + "+00:00"
  }
  $parsed = [datetimeoffset]::Parse($text, [cultureinfo]::InvariantCulture)
  return $parsed.UtcDateTime
}

function Get-AmeenWarehouseStockRetentionCutoffText {
  param([datetime]$Now)
  $utc = $Now
  if (-not $PSBoundParameters.ContainsKey("Now")) {
    $utc = (Get-Date).ToUniversalTime()
  } elseif ($utc.Kind -ne [DateTimeKind]::Utc) {
    $utc = $utc.ToUniversalTime()
  }
  return $utc.AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ", [cultureinfo]::InvariantCulture)
}

function Test-AmeenWarehouseStockRowExpired {
  param(
    $CreatedAt,
    [Parameter(Mandatory = $true)][string]$CutoffText
  )
  $created = ConvertTo-AmeenWarehouseStockUtc $CreatedAt
  $cutoff = ConvertTo-AmeenWarehouseStockUtc $CutoffText
  return $created -lt $cutoff
}

function Test-AmeenWarehouseStockReportId {
  param([string]$Id)
  return $Id -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

function Select-AmeenWarehouseStockCleanupIds {
  param(
    $Rows,
    [Parameter(Mandatory = $true)][string]$CutoffText,
    [Parameter(Mandatory = $true)][int]$BatchSize
  )
  # غلاف وليس مصفوفة: إرجاع المصفوفة من دالة يفكّها PowerShell، وصفّ
  # واحد أو مصفوفة فارغة يُحسبان غلطاً كعنصر. Ids تبقى مجموعة حتى لو فارغة.
  $chosen = New-Object System.Collections.Generic.List[object]
  # $Rows و$pageRows ليسا نفس المتغير: أسماء PowerShell لا تفرّق حالة الأحرف.
  $pageRows = @()
  if ($null -ne $Rows) { $pageRows = @($Rows) }
  foreach ($row in $pageRows) {
    if ($null -eq $row) { continue }
    if ($row -is [System.Array]) { continue }
    $id = [string]$row.id
    if ([string]::IsNullOrWhiteSpace($id)) { continue }
    if (-not (Test-AmeenWarehouseStockReportId $id)) {
      throw "معرّف تقرير مخزون غير صالح للحذف."
    }
    if (-not (Test-AmeenWarehouseStockRowExpired -CreatedAt $row.created_at -CutoffText $CutoffText)) {
      continue
    }
    [void]$chosen.Add([pscustomobject]@{
      id = $id
      created = (ConvertTo-AmeenWarehouseStockUtc $row.created_at)
    })
  }
  $ordered = @($chosen.ToArray() | Sort-Object created, id)
  if ($BatchSize -ge 0 -and $ordered.Count -gt $BatchSize) {
    $ordered = @($ordered | Select-Object -First $BatchSize)
  }
  $ids = New-Object System.Collections.Generic.List[string]
  foreach ($item in $ordered) {
    if ($null -eq $item) { continue }
    [void]$ids.Add([string]$item.id)
  }
  return [pscustomobject]@{ Ids = $ids.ToArray() }
}

function Get-AmeenWarehouseStockCleanupIdList {
  param($Selection)
  if ($null -eq $Selection -or $null -eq $Selection.Ids) { return }
  foreach ($id in $Selection.Ids) {
    if ([string]::IsNullOrWhiteSpace([string]$id)) { continue }
    Write-Output ([string]$id)
  }
}

function Invoke-AmeenWarehouseStockReportCleanup {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$CutoffText,
    [Parameter(Mandatory = $true)][scriptblock]$FetchPage,
    [Parameter(Mandatory = $true)][scriptblock]$DeleteIds,
    [int]$BatchSize = 40,
    [int]$MaxBatches = 150
  )
  if ($BatchSize -lt 1) { throw "BatchSize must be at least 1." }
  if ($MaxBatches -lt 1) { throw "MaxBatches must be at least 1." }

  $removed = 0
  $batches = 0
  $seen = @{}
  $stalled = $false

  while ($batches -lt $MaxBatches) {
    $page = & $FetchPage -CutoffText $CutoffText -BatchSize $BatchSize
    $ids = @(Get-AmeenWarehouseStockCleanupIdList (Select-AmeenWarehouseStockCleanupIds -Rows $page -CutoffText $CutoffText -BatchSize $BatchSize))
    if ($ids.Count -eq 0) {
      return [pscustomobject]@{
        Removed = $removed
        Batches = $batches
        Exhausted = $true
        Stalled = $false
      }
    }

    $pending = New-Object System.Collections.Generic.List[string]
    foreach ($id in $ids) {
      if (-not $seen.ContainsKey($id)) { [void]$pending.Add($id) }
    }
    if ($pending.Count -eq 0) {
      $stalled = $true
      break
    }

    & $DeleteIds -Ids ($pending.ToArray())
    foreach ($id in $pending) { $seen[$id] = $true }
    $removed += $pending.Count
    $batches += 1
    Write-Host ("تنظيف تقارير المخزون: دفعة {0}، حُذف {1}." -f $batches, $pending.Count)
  }

  if (-not $stalled) {
    $peek = & $FetchPage -CutoffText $CutoffText -BatchSize $BatchSize
    $peekIds = @(Get-AmeenWarehouseStockCleanupIdList (Select-AmeenWarehouseStockCleanupIds -Rows $peek -CutoffText $CutoffText -BatchSize $BatchSize))
    $unseen = @($peekIds | Where-Object { -not $seen.ContainsKey($_) })
    if ($unseen.Count -eq 0) {
      return [pscustomobject]@{
        Removed = $removed
        Batches = $batches
        Exhausted = $true
        Stalled = $false
      }
    }
  }

  return [pscustomobject]@{
    Removed = $removed
    Batches = $batches
    Exhausted = $false
    Stalled = [bool]$stalled
  }
}
