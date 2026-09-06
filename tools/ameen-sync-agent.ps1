param(
  [Alias("nce")]
  [switch]$Once,
  [int]$IntervalSeconds = 60,
  [Alias("owhreshold", "Threshold")]
  [int]$LowThreshold = 50,
  [string]$StockQueryPath = ".\tools\ameen-stock-query.sql",
  [string]$CustomerBalancesQueryPath = ".\tools\ameen-customer-balances-query.sql",
  [switch]$SkipCustomerBalances,
  [string]$LogPath = (Join-Path $PSScriptRoot "..\logs\ameen-sync.log")
)

$ErrorActionPreference = "Stop"

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::Expect100Continue = $false

function Require-Env($Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, "User")
  if (-not $value) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  }
  if (-not $value) {
    throw "Missing environment variable: $Name"
  }
  return $value
}

function Write-AgentLog($Message) {
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line

  if ($LogPath) {
    $logDirectory = Split-Path -Parent $LogPath
    if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory)) {
      New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    }

    Add-Content -LiteralPath $LogPath -Value $line
  }
}

function Normalize-ItemName($Value) {
  $text = ""
  if ($null -ne $Value) {
    $text = [string]$Value
  }
  $text = $text.Trim()
  $text = [regex]::Replace($text, '^\d{2,}\s*-\s*', "")
  $text = $text.Replace("أ", "ا").Replace("إ", "ا").Replace("آ", "ا").Replace("ى", "ي").Replace("ة", "ه")
  $text = [regex]::Replace($text, "[^\p{L}\p{N}]+", " ")
  $text = [regex]::Replace($text, "\s+", " ")
  $normalized = $text.Trim().ToLowerInvariant()
  switch ($normalized) {
    "كابتن بلاك كوين ازرق" { return "كابتن بلاك كور ازرق جديد" }
    "كابتن بلاك كوين اسود" { return "كابتن بلاك كور اسود جديد" }
    default { return $normalized }
  }
}

function To-Number($Value) {
  if ($null -eq $Value -or $Value -eq "") {
    return 0
  }
  $text = ([string]$Value).Replace(",", "").Trim()
  $number = 0.0
  if ([double]::TryParse($text, [ref]$number)) {
    return $number
  }
  return 0
}

function To-IsoDate($Value) {
  if ($null -eq $Value -or $Value -eq "") {
    return ""
  }
  return ([datetime]$Value).ToString("o")
}

function New-TextFromCodePoints([int[]]$Codes) {
  return -join ($Codes | ForEach-Object { [char]$_ })
}

function Test-TextContains($Value, [int[]]$Codes) {
  if ($null -eq $Value) {
    return $false
  }
  $text = [string]$Value
  $needle = New-TextFromCodePoints $Codes
  return $text.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-LowStockRule($ItemName, $GroupName, $Unit2Name, $Unit2Factor, $FallbackThreshold) {
  if ($Unit2Factor -le 0) {
    $Unit2Factor = 1
  }

  $groupAndName = "{0} {1}" -f $GroupName, $ItemName
  $isMasterGroup = Test-TextContains $groupAndName @(0x0645, 0x0627, 0x0633, 0x062A, 0x0631)
  $isGauloisesGroup = Test-TextContains $groupAndName @(0x063A, 0x0644, 0x0648, 0x0627, 0x0632)

  if ($isMasterGroup -or $isGauloisesGroup) {
    return [PSCustomObject]@{
      Mode = "unit1"
      Unit1Threshold = 250.0
      Unit2Threshold = [math]::Round((250.0 / $Unit2Factor), 3)
      Basis = "group_250_unit1"
    }
  }

  $isCarton = (Test-TextContains $Unit2Name @(0x0643, 0x0631, 0x062A, 0x0648, 0x0646)) -or (Test-TextContains $Unit2Name @(0x0643, 0x0631, 0x062A, 0x0648, 0x0646, 0x0629))
  if ($isCarton) {
    return [PSCustomObject]@{
      Mode = "unit2"
      Unit1Threshold = 50.0 * $Unit2Factor
      Unit2Threshold = 50.0
      Basis = "carton_50_unit2"
    }
  }

  $isPack = (Test-TextContains $Unit2Name @(0x0637, 0x0631, 0x062F)) -or (Test-TextContains $Unit2Name @(0x0634, 0x0631, 0x062D, 0x0629))
  if ($isPack) {
    return [PSCustomObject]@{
      Mode = "unit2"
      Unit1Threshold = 12.0 * $Unit2Factor
      Unit2Threshold = 12.0
      Basis = "pack_12_unit2"
    }
  }

  return [PSCustomObject]@{
    Mode = "unit2"
    Unit1Threshold = [double]$FallbackThreshold * $Unit2Factor
    Unit2Threshold = [double]$FallbackThreshold
    Basis = "fallback_unit2"
  }
}

function Read-JsonArray($Value) {
  if ($null -eq $Value -or $Value -eq "") {
    return @()
  }

  try {
    $parsed = ConvertFrom-Json -InputObject ([string]$Value)
    if ($null -eq $parsed) {
      return @()
    }
    return @($parsed)
  } catch {
    return @()
  }
}

function ConvertTo-JsonText($Value, $Depth = 10) {
  return ($Value | ConvertTo-Json -Depth $Depth)
}

function Invoke-RestMethodWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][hashtable]$Headers,
    [string]$ContentType = "",
    [object]$Body = $null,
    [int]$MaxAttempts = 3
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $parameters = @{
        Method = $Method
        Uri = $Uri
        Headers = $Headers
        TimeoutSec = 60
        DisableKeepAlive = $true
      }
      if ($ContentType) {
        $parameters.ContentType = $ContentType
      }
      if ($null -ne $Body) {
        $parameters.Body = $Body
      }
      return Invoke-RestMethod @parameters
    } catch {
      $message = $_.Exception.Message
      $isTransient = $message -match "underlying connection|connection.*closed|receive|send|temporarily|timeout"
      if (-not $isTransient -or $attempt -eq $MaxAttempts) {
        throw
      }
      Write-AgentLog ("Supabase connection attempt {0}/{1} failed; retrying. Error: {2}" -f $attempt, $MaxAttempts, $message)
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Get-SupabaseSession($Url, $ApiKey, $Email, $Password) {
  $endpoint = "$Url/auth/v1/token?grant_type=password"
  $headers = @{
    apikey = $ApiKey
    Accept = "application/json"
  }
  $body = ConvertTo-JsonText -Value @{
    email = $Email
    password = $Password
  }

  try {
    return Invoke-RestMethodWithRetry -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body
  } catch {
    throw "Supabase login failed for TOBACCO_SYNC_EMAIL. Rerun tools\setup-ameen-sync-env.ps1 with a valid Supabase Auth user. Original error: $($_.Exception.Message)"
  }
}

function Invoke-SqlRows($ConnectionString, $Query) {
  Add-Type -AssemblyName System.Data
  $connection = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
  $rows = New-Object System.Collections.Generic.List[object]

  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 60
    $command.CommandText = $Query
    $reader = $command.ExecuteReader()

    while ($reader.Read()) {
      $row = [ordered]@{}
      for ($index = 0; $index -lt $reader.FieldCount; $index++) {
        $name = $reader.GetName($index)
        $row[$name] = if ($reader.IsDBNull($index)) { $null } else { $reader.GetValue($index) }
      }
      $rows.Add([PSCustomObject]$row)
    }
  } finally {
    if ($connection.State -eq "Open") {
      $connection.Close()
    }
  }

  return $rows
}

function Build-InventoryReport($Rows, $LowThreshold) {
  $items = @()

  foreach ($row in $Rows) {
    $name = [string]$row.item_name
    $key = Normalize-ItemName $name
    if (-not $key) {
      continue
    }

    $qty = To-Number $row.stock_qty
    $qtyNet = if ($row.PSObject.Properties.Name -contains "stock_qty_net") { To-Number $row.stock_qty_net } else { $qty }
    $qtyPositive = if ($row.PSObject.Properties.Name -contains "stock_qty_positive") { To-Number $row.stock_qty_positive } else { if ($qty -gt 0) { $qty } else { 0 } }
    $groupName = if ($row.PSObject.Properties.Name -contains "group_name") { [string]$row.group_name } else { "" }
    $unit1Name = if ($row.PSObject.Properties.Name -contains "unit1_name") { [string]$row.unit1_name } else { "" }
    $unit2Name = if ($row.PSObject.Properties.Name -contains "unit2_name") { [string]$row.unit2_name } else { "" }
    $unit2Factor = if ($row.PSObject.Properties.Name -contains "unit2_factor") { To-Number $row.unit2_factor } else { 1 }
    if ($unit2Factor -le 0) {
      $unit2Factor = 1
    }
    if (-not $unit2Name) {
      $unit2Name = $unit1Name
    }
    $unit2Qty = if ($unit2Factor -gt 0) { $qty / $unit2Factor } else { $qty }
    $lowRule = Get-LowStockRule -ItemName $name -GroupName $groupName -Unit2Name $unit2Name -Unit2Factor $unit2Factor -FallbackThreshold $LowThreshold

    $status = "active"
    if ($qty -le 0) {
      $status = "out"
    } elseif ($lowRule.Mode -eq "unit1" -and $qty -le $lowRule.Unit1Threshold) {
      $status = "low"
    } elseif ($lowRule.Mode -ne "unit1" -and $unit2Qty -le $lowRule.Unit2Threshold) {
      $status = "low"
    }

    $items += [ordered]@{
      key = $key
      name = $name
      groupName = $groupName
      stockQty = [math]::Round($qty, 3)
      stockQtyNet = [math]::Round($qtyNet, 3)
      stockQtyPositive = [math]::Round($qtyPositive, 3)
      stockQtyUnit2 = [math]::Round($unit2Qty, 3)
      status = $status
      unit1Name = $unit1Name
      unit2Name = $unit2Name
      unit2Factor = [math]::Round($unit2Factor, 3)
      priceListed = $false
      lowThreshold = if ($lowRule.Mode -eq "unit1") { [math]::Round($lowRule.Unit1Threshold, 3) } else { [math]::Round($lowRule.Unit2Threshold, 3) }
      lowThresholdUnit = $lowRule.Mode
      lowThresholdUnit2 = [math]::Round($lowRule.Unit2Threshold, 3)
      lowThresholdUnit1 = [math]::Round($lowRule.Unit1Threshold, 3)
      lowThresholdBasis = $lowRule.Basis
    }
  }

  if (-not $items.Count) {
    throw "Ameen stock query returned no items. Edit tools\\ameen-stock-query.sql after identifying the real Ameen tables."
  }

  $summary = [ordered]@{
    reportDate = (Get-Date).ToString("yyyy-MM-dd")
    source = "ameen_sql_agent"
    totalStockItems = $items.Count
    availableItems = @($items | Where-Object { $_.stockQty -gt 0 }).Count
    lowStockItems = @($items | Where-Object { $_.status -eq "low" }).Count
    outOfStockItems = @($items | Where-Object { $_.status -eq "out" }).Count
    staleItems = 0
    activeItems = @($items | Where-Object { $_.status -eq "active" }).Count
    threshold = $LowThreshold
    syncedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  return @{
    Summary = $summary
    Items = $items
  }
}

function Build-CustomerBalanceReport($Rows) {
  $items = @()

  foreach ($row in $Rows) {
    $name = [string]$row.customer_name
    $key = Normalize-ItemName $name
    if (-not $key) {
      continue
    }

    $balance = To-Number $row.balance
    $creditLimit = To-Number $row.credit_limit
    $remainingLimit = To-Number $row.remaining_limit
    $lastPaymentAmount = To-Number $row.last_payment_amount
    $lastPaymentDate = To-IsoDate $row.last_payment_date
    $recentPayments = @(
      Read-JsonArray $row.recent_payments_json | ForEach-Object {
        [ordered]@{
          amount = [math]::Round((To-Number $_.amount), 3)
          date = To-IsoDate $_.date
          notes = [string]$_.notes
          number = [string]$_.number
        }
      }
    )
    $recentMovements = @(
      Read-JsonArray $row.recent_movements_json | ForEach-Object {
        [ordered]@{
          debit = [math]::Round((To-Number $_.debit), 3)
          credit = [math]::Round((To-Number $_.credit), 3)
          date = To-IsoDate $_.date
          notes = [string]$_.notes
          number = [string]$_.number
          type = [string]$_.type
        }
      }
    )
    $status = "clear"

    if ($creditLimit -gt 0 -and $balance -gt $creditLimit) {
      $status = "over_limit"
    } elseif ($creditLimit -gt 0 -and $balance -gt 0 -and (($balance / $creditLimit) -ge 0.9)) {
      $status = "near_limit"
    } elseif ($balance -gt 0) {
      $status = "open_balance"
    } elseif ($balance -lt 0) {
      $status = "credit_balance"
    }

    $items += [ordered]@{
      key = $key
      name = $name
      balance = [math]::Round($balance, 3)
      creditLimit = [math]::Round($creditLimit, 3)
      remainingLimit = [math]::Round($remainingLimit, 3)
      lastPaymentAmount = [math]::Round($lastPaymentAmount, 3)
      lastPaymentDate = $lastPaymentDate
      lastPaymentNotes = [string]$row.last_payment_notes
      recentPayments = $recentPayments
      # عدد الدفعات الفعلي داخل نافذة الزخم (90 يوماً). نموذج خطر التحصيل يقارنه
      # بعدد ما وصله ليعرف الاقتطاع يقيناً بدل الاستدلال عليه من التواريخ.
      paymentsInWindow = [int](To-Number $row.payments_in_window)
      recentMovements = $recentMovements
      status = $status
      customerGuid = [string]$row.customer_guid
      customerAccountGuid = [string]$row.customer_account_guid
      isSupplier = ((To-Number $row.is_supplier) -eq 1)
    }
  }

  if (-not $items.Count) {
    throw "Ameen customer balances query returned no customers. Edit tools\\ameen-customer-balances-query.sql after identifying the real Ameen customer table."
  }

  $totalBalance = 0.0
  $totalCreditLimit = 0.0
  $totalDebitBalance = 0.0
  $totalCreditBalance = 0.0
  foreach ($item in $items) {
    $totalBalance += [double]$item.balance
    $totalCreditLimit += [double]$item.creditLimit
    if ([double]$item.balance -gt 0) {
      $totalDebitBalance += [double]$item.balance
    } elseif ([double]$item.balance -lt 0) {
      $totalCreditBalance += [double]$item.balance
    }
  }

  $summary = [ordered]@{
    reportDate = (Get-Date).ToString("yyyy-MM-dd")
    source = "ameen_customer_balances"
    totalCustomers = $items.Count
    customersWithBalance = @($items | Where-Object { $_.balance -ne 0 }).Count
    customersWithDebitBalance = @($items | Where-Object { $_.balance -gt 0 }).Count
    customersWithCreditBalance = @($items | Where-Object { $_.balance -lt 0 }).Count
    customersWithLimit = @($items | Where-Object { $_.creditLimit -gt 0 }).Count
    overLimitCustomers = @($items | Where-Object { $_.status -eq "over_limit" }).Count
    nearLimitCustomers = @($items | Where-Object { $_.status -eq "near_limit" }).Count
    totalBalance = [math]::Round($totalBalance, 3)
    totalDebitBalance = [math]::Round($totalDebitBalance, 3)
    totalCreditBalance = [math]::Round($totalCreditBalance, 3)
    totalCreditLimit = [math]::Round($totalCreditLimit, 3)
    syncedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  return @{
    Summary = $summary
    Items = $items
  }
}

function Send-Report($SupabaseUrl, $ApiKey, $Session, $Report, $Source) {
  $endpoint = "$SupabaseUrl/rest/v1/inventory_reports"
  $headers = @{
    apikey = $ApiKey
    Authorization = "Bearer $($Session.access_token)"
    Accept = "application/json"
    "Accept-Profile" = "public"
    "Content-Profile" = "public"
    Prefer = "return=minimal"
  }
  $body = ConvertTo-JsonText -Value @{
    report_date = $Report.Summary.reportDate
    source = $Source
    summary = $Report.Summary
    items = $Report.Items
    created_by = $Session.user.id
  } -Depth 20

  Invoke-RestMethodWithRetry -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body | Out-Null
}

function Send-InventoryReport($SupabaseUrl, $ApiKey, $Session, $Report) {
  Send-Report -SupabaseUrl $SupabaseUrl -ApiKey $ApiKey -Session $Session -Report $Report -Source "ameen_sql_agent"
}

function Sync-PriceListStockOnFullUnitChange($SupabaseUrl, $ApiKey, $Session, $Report) {
  $headers = @{
    apikey = $ApiKey
    Authorization = "Bearer $($Session.access_token)"
    Accept = "application/json"
    "Accept-Profile" = "public"
    "Content-Profile" = "public"
  }
  $endpoint = "$SupabaseUrl/rest/v1/approved_price_items"
  $publishedResponse = Invoke-RestMethodWithRetry -Method Get -Uri "$endpoint`?select=item_key,item_name,stock_qty,unit2_factor&limit=5000" -Headers $headers
  $published = @()
  foreach ($row in $publishedResponse) { $published += $row }
  $publishedByKey = @{}
  foreach ($row in $published) {
    $matchKey = Normalize-ItemName $row.item_name
    if (-not $matchKey) { continue }
    if (-not $publishedByKey.ContainsKey($matchKey)) { $publishedByKey[$matchKey] = @() }
    $publishedByKey[$matchKey] = @($publishedByKey[$matchKey]) + @($row)
  }

  # تجميع أصناف التقرير حسب المفتاح المطبّع قبل المقارنة: بطاقتا أمين مكررتان
  # بالاسم نفسه بعد التطبيع (مثل 273/274، الحسم المعروف) كانتا تكتبان قيمتين
  # متعاكستين على سطر النشرة نفسه بالتناوب كل تشغيلة (تذبذب 136↔0). نجمع كمية
  # البطاقات المتصادمة في سجل واحد، ويمثّل المجموعةَ السطرُ الأكبر مخزوناً
  # (لوحداته وحالته). أي تصادم جديد غير 273/274 يُسجَّل بتحذير — لا يُرفض هنا
  # (فقد يكون سطراً حقيقياً بمخزون يجب أن ينشر) لكن يجب أن يظهر بالسجل ليُراجَع
  # مثل tools\pull-item-numbers.ps1.
  $knownCollisionKeys = @("غلواز كوين اصفر اس سبعه")
  $reportByKey = @{}
  foreach ($item in $Report.Items) {
    $key = Normalize-ItemName $item.name
    if (-not $key) { continue }
    if (-not $reportByKey.ContainsKey($key)) {
      $reportByKey[$key] = @{ Rep = $item; Qty = (To-Number $item.stockQty); Names = @($item.name) }
    } else {
      $entry = $reportByKey[$key]
      $qty = To-Number $item.stockQty
      $entry.Qty = $entry.Qty + $qty
      $entry.Names += $item.name
      if ($qty -gt (To-Number $entry.Rep.stockQty)) { $entry.Rep = $item }
    }
  }
  foreach ($key in @($reportByKey.Keys)) {
    $entry = $reportByKey[$key]
    if ($entry.Names.Count -gt 1 -and ($knownCollisionKeys -notcontains $key)) {
      Write-AgentLog ("تحذير: تصادم تطبيع جديد غير معروف بمزامنة مخزون النشرة — يُجمع تلقائياً، يحتاج مراجعة: [" + $key + "] بطاقات: " + ($entry.Names -join " | "))
    }
  }

  $changed = 0
  $matched = 0
  foreach ($key in @($reportByKey.Keys)) {
    if (-not $publishedByKey.ContainsKey($key)) { continue }
    $entry = $reportByKey[$key]
    $item = $entry.Rep
    $currents = @($publishedByKey[$key])
    if (-not $currents.Count) { continue }
    $matched += $currents.Count

    foreach ($current in $currents) {
      $oldQty = To-Number $current.stock_qty
      $oldFactor = To-Number $current.unit2_factor
      if ($oldFactor -le 0) { $oldFactor = To-Number $item.unit2Factor }
      if ($oldFactor -le 0) { $oldFactor = 1 }
      $newQty = To-Number $entry.Qty
      $newFactor = To-Number $item.unit2Factor
      if ($newFactor -le 0) { $newFactor = 1 }

      $oldFullUnits = [math]::Floor($oldQty / $oldFactor)
      $newFullUnits = [math]::Floor($newQty / $newFactor)
      $availabilityChanged = (($oldQty -gt 0) -ne ($newQty -gt 0))
      if ($oldFullUnits -eq $newFullUnits -and -not $availabilityChanged) { continue }

      $payload = ConvertTo-JsonText -Value @{
        stock_qty = [math]::Round($newQty, 3)
        stock_status = [string]$item.status
        unit1_name = [string]$item.unit1Name
        unit2_name = [string]$item.unit2Name
        unit2_factor = [math]::Round($newFactor, 3)
        source_synced_at = (Get-Date).ToUniversalTime().ToString("o")
        updated_at = (Get-Date).ToUniversalTime().ToString("o")
      } -Depth 5
      $encodedKey = [uri]::EscapeDataString([string]$current.item_key)
      Invoke-RestMethodWithRetry -Method Patch -Uri "$endpoint`?item_key=eq.$encodedKey" -Headers ($headers + @{ Prefer = "return=minimal" }) -ContentType "application/json; charset=utf-8" -Body $payload | Out-Null
      $changed++
    }
  }
  Write-AgentLog ("Price-list stock comparison: Published={0}, Matched={1}, BoundaryChanges={2}" -f $published.Count, $matched, $changed)
  return $changed
}

function Send-CustomerBalanceReport($SupabaseUrl, $ApiKey, $Session, $Report) {
  Send-Report -SupabaseUrl $SupabaseUrl -ApiKey $ApiKey -Session $Session -Report $Report -Source "ameen_customer_balances"
}

function Sync-Once {
  $connectionString = Require-Env "AMEEN_SQL_CONNECTION_STRING"
  $supabaseUrl = (Require-Env "TOBACCO_SUPABASE_URL").TrimEnd("/")
  $supabaseKey = Require-Env "TOBACCO_SUPABASE_PUBLIC_KEY"
  $syncEmail = Require-Env "TOBACCO_SYNC_EMAIL"
  $syncPassword = Require-Env "TOBACCO_SYNC_PASSWORD"

  if (-not (Test-Path -LiteralPath $StockQueryPath)) {
    throw "Stock query file not found: $StockQueryPath"
  }

  $query = Get-Content -Raw -LiteralPath $StockQueryPath
  $rows = Invoke-SqlRows -ConnectionString $connectionString -Query $query
  $report = Build-InventoryReport -Rows $rows -LowThreshold $LowThreshold
  $session = Get-SupabaseSession -Url $supabaseUrl -ApiKey $supabaseKey -Email $syncEmail -Password $syncPassword
  Send-InventoryReport -SupabaseUrl $supabaseUrl -ApiKey $supabaseKey -Session $session -Report $report
  $priceListStockChanges = Sync-PriceListStockOnFullUnitChange -SupabaseUrl $supabaseUrl -ApiKey $supabaseKey -Session $session -Report $report

  $customerCount = 0
  if (-not $SkipCustomerBalances) {
    if (-not (Test-Path -LiteralPath $CustomerBalancesQueryPath)) {
      throw "Customer balances query file not found: $CustomerBalancesQueryPath"
    }

    $customerQuery = Get-Content -Raw -LiteralPath $CustomerBalancesQueryPath
    $customerRows = Invoke-SqlRows -ConnectionString $connectionString -Query $customerQuery
    $customerReport = Build-CustomerBalanceReport -Rows $customerRows
    Send-CustomerBalanceReport -SupabaseUrl $supabaseUrl -ApiKey $supabaseKey -Session $session -Report $customerReport
    $customerCount = $customerReport.Items.Count
  }

  Write-AgentLog ("Synced {0} items. PriceListFullUnitChanges={1}, Low={2}, Out={3}, Customers={4}" -f $report.Items.Count, $priceListStockChanges, $report.Summary.lowStockItems, $report.Summary.outOfStockItems, $customerCount)

  # حدّث تقرير الربح من نفس دورة الأمين الجارية. يبقى مستقلاً عن تقرير
  # المخزون، وفشله لا يلغي مزامنة المخزون التي اكتملت بالفعل.
  try {
    & "$PSScriptRoot\push-daily-profit.ps1"
    if ($LASTEXITCODE -ne 0) { Write-AgentLog "Daily profit sync returned a failure code." }
  } catch {
    Write-AgentLog ("Daily profit sync failed: {0}" -f $_.Exception.Message)
  }

  # Customer invoice details are owned by this same permanent main-computer
  # agent. The helper rate-limits successful uploads to once per hour, so the
  # disabled legacy standalone task is no longer a health dependency.
  try {
    & "$PSScriptRoot\push-customer-invoices.ps1" -MinimumIntervalMinutes 60
    if ($LASTEXITCODE -ne 0) { Write-AgentLog "Customer invoice sync returned a failure code." }
  } catch {
    Write-AgentLog ("Customer invoice sync failed: {0}" -f $_.Exception.Message)
  }

  # Keep the Telegram daily-payment and cashbox snapshot fresh. The helper is
  # read-only on Al-Ameen and rate-limits its Supabase uploads to one per five
  # minutes, even though this main agent normally runs every minute.
  try {
    & "$PSScriptRoot\push-daily-movement.ps1" -MinimumIntervalMinutes 5
  } catch {
    Write-AgentLog ("Daily movement sync failed: {0}" -f $_.Exception.Message)
  }

  # Keep the protected financial-assistant account snapshot fresh without
  # increasing load on Al-Ameen during the one-minute main sync cycle.
  try {
    & "$PSScriptRoot\push-ameen-account-balances.ps1" -MinimumIntervalMinutes 15
    if ($LASTEXITCODE -ne 0) { Write-AgentLog "Account balance sync returned a failure code." }
  } catch {
    Write-AgentLog ("Account balance sync failed: {0}" -f $_.Exception.Message)
  }

  # Supplier balances shown in Decision Today come from ac000 in Ameen's USD
  # base currency. Refresh them continuously through this permanent task.
  try {
    & "$PSScriptRoot\push-supplier-obligations.ps1" -Apply -MinimumIntervalMinutes 5
    if ($LASTEXITCODE -ne 0) { Write-AgentLog "Supplier obligation sync returned a failure code." }
  } catch {
    Write-AgentLog ("Supplier obligation sync failed: {0}" -f $_.Exception.Message)
  }
}

do {
  try {
    Sync-Once
  } catch {
    Write-AgentLog ("Sync failed: {0}" -f $_.Exception.Message)
    if ($Once) {
      throw
    }
  }

  if ($Once) {
    break
  }
  Start-Sleep -Seconds $IntervalSeconds
} while ($true)
