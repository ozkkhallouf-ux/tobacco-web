#Requires -Version 5.1
# قاعدة الاحتفاظ بتقارير مخزون المستودعات، واستدعاء الحذف على دفعات.
#
# الحد نفسه الذي كان في tools/push-ameen-warehouse-stock.ps1:
# يُحذف الصف فقط إذا كان created_at أقدم تماماً من (الآن UTC − يومين).
# صف الحدّ نفسه، وكل تقرير أحدث منه، يبقى. هذا يشمل التقارير التي تُرفع
# في نفس تشغيل المهمة.
#
# الحذف نفسه ليس هنا. الدالة prune_ameen_warehouse_stock_reports على
# Supabase تقفل دفعة ثم تحذف ما بقي غير مرتبط بجلسة جرد. هذا الملف يكرر
# النداء حتى ترجع الدالة صفراً أو أصغر من حجم الدفعة، أو حتى حد الجولات.
# كل نداء معاملة مستقلة.
#
# لماذا الدفعات: دور authenticated مهلته 8 ثوانٍ. الحذف الواحد كان يُلغى
# (57014). مهمة ويندوز حدها 15 دقيقة وRestartCount 3، لذلك الحد 24 دفعة:
# 24 × مهلة الطلب 20 ثانية = 8 دقائق، ويبقى وقت لقراءة الأمين والرفع.
# مهلة البيان 57014 تُعاد المحاولة بحد MaxTimeouts ثم تتوقف الجولة.
# «unexpected foreign key» يوقف الجولة فوراً.

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

function Invoke-AmeenWarehouseStockReportCleanup {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$CutoffText,
    [Parameter(Mandatory = $true)][scriptblock]$PruneBatch,
    [int]$BatchSize = 40,
    [int]$MaxBatches = 24,
    [int]$MaxTimeouts = 3
  )
  if ($BatchSize -lt 1 -or $BatchSize -gt 40) { throw "BatchSize must be between 1 and 40." }
  if ($MaxBatches -lt 1) { throw "MaxBatches must be at least 1." }
  if ($MaxTimeouts -lt 1) { throw "MaxTimeouts must be at least 1." }

  $removed = 0
  $batches = 0
  $timeouts = 0

  while ($batches -lt $MaxBatches) {
    $raw = $null
    try {
      $raw = @(& $PruneBatch -CutoffText $CutoffText -BatchSize $BatchSize)
    } catch {
      $serverBody = ""
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $serverBody = [string]$_.ErrorDetails.Message
      }
      $blob = ([string]$_.Exception.Message) + " " + $serverBody
      if ($serverBody) { Write-Warning ("رد الخادم: " + $serverBody) }
      if ($blob -match '57014' -or $blob -match 'statement timeout') {
        $timeouts += 1
        Write-Warning ("مهلة بيان أثناء تنظيف تقارير المخزون ({0}/{1})." -f $timeouts, $MaxTimeouts)
        if ($timeouts -ge $MaxTimeouts) {
          return [pscustomobject]@{
            Removed = $removed
            Batches = $batches
            Exhausted = $false
            Stopped = "timeout"
          }
        }
        continue
      }
      if ($blob -match 'unexpected foreign key') {
        Write-Warning "توقف تنظيف تقارير المخزون: مفتاح أجنبي غير متوقع."
        return [pscustomobject]@{
          Removed = $removed
          Batches = $batches
          Exhausted = $false
          Stopped = "foreign-key"
        }
      }
      Write-Warning ("تعذّر تنظيف تقارير المخزون: " + $_.Exception.Message)
      throw
    }

    if ($raw.Count -ne 1 -or $null -eq $raw[0]) {
      throw "نداء تنظيف تقارير المخزون لم يُرجع عدداً واحداً."
    }
    $count = 0
    if (-not [int]::TryParse([string]$raw[0], [ref]$count)) {
      throw "نداء تنظيف تقارير المخزون أرجع قيمة غير رقمية."
    }
    if ($count -lt 0 -or $count -gt $BatchSize) {
      throw "نداء تنظيف تقارير المخزون أرجع عدداً خارج الدفعة."
    }
    if ($count -eq 0) {
      return [pscustomobject]@{
        Removed = $removed
        Batches = $batches
        Exhausted = $true
        Stopped = ""
      }
    }

    $removed += $count
    $batches += 1
    Write-Host ("تنظيف تقارير المخزون: دفعة {0}، حُذف {1}." -f $batches, $count)
    if ($count -lt $BatchSize) {
      return [pscustomobject]@{
        Removed = $removed
        Batches = $batches
        Exhausted = $true
        Stopped = ""
      }
    }
  }

  return [pscustomobject]@{
    Removed = $removed
    Batches = $batches
    Exhausted = $false
    Stopped = ""
  }
}
