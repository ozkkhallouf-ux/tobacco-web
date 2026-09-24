param(
  [string]$ReportDate = (Get-Date).ToString("yyyy-MM-dd"),
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\reports\daily"),
  [string]$LogPath = (Join-Path $PSScriptRoot "..\logs\ameen-daily-summary.log")
)

$ErrorActionPreference = "Stop"

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

function Optional-Env($Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, "User")
  if (-not $value) {
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  }
  return $value
}

function Write-DailyLog($Message) {
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Write-Host $line
  if ($LogPath) {
    $logDirectory = Split-Path -Parent $LogPath
    if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory)) {
      New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
    }
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
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

function Format-Money($Value) {
  return ([double]$Value).ToString("N3", [Globalization.CultureInfo]::GetCultureInfo("en-US"))
}

function Escape-Html($Value) {
  return [System.Net.WebUtility]::HtmlEncode([string]$Value)
}

function ConvertTo-JsonText($Value, $Depth = 10) {
  return ($Value | ConvertTo-Json -Depth $Depth)
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

  return Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType "application/json; charset=utf-8" -Body $body
}

function Invoke-SupabaseGet($Url, $ApiKey, $Session, $PathAndQuery) {
  $headers = @{
    apikey = $ApiKey
    Authorization = "Bearer $($Session.access_token)"
    Accept = "application/json"
  }
  return Invoke-RestMethod -Method Get -Uri "$Url/rest/v1/$PathAndQuery" -Headers $headers
}

function Invoke-SqlRows($ConnectionString, $Query) {
  Add-Type -AssemblyName System.Data
  $connection = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
  $rows = New-Object System.Collections.Generic.List[object]

  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 90
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

function Invoke-SqlRowsParameterized($ConnectionString, $Query, $Parameters) {
  Add-Type -AssemblyName System.Data
  $connection = New-Object System.Data.SqlClient.SqlConnection $ConnectionString
  $rows = New-Object System.Collections.Generic.List[object]

  try {
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandTimeout = 90
    $command.CommandText = $Query
    foreach ($p in $Parameters) {
      $command.Parameters.Add($p) | Out-Null
    }
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

function Get-DailyMovementRows($ConnectionString, $ReportDate) {
  if ($ReportDate -notmatch '^\d{4}-\d{2}-\d{2}$') {
    throw "ReportDate must be in yyyy-MM-dd format."
  }

  $parsedDate = [DateTime]::ParseExact($ReportDate, "yyyy-MM-dd", $null)

  # last_payment_date بتعريف الدفعة الموحّد نفسه في tools/ameen-customer-balances-query.sql
  # (الكتلة بين علامتَي payment-rule منسوخة حرفياً ويفرض الفحص تطابقها). الموردون على شرطهم السابق.
  $query = @"
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
  cu.GUID as customer_guid,
  cast(sum(coalesce(en.Debit, 0)) as decimal(18, 3)) as daily_debit,
  cast(sum(coalesce(en.Credit, 0)) as decimal(18, 3)) as daily_credit,
  cast(sum(coalesce(en.Debit, 0) - coalesce(en.Credit, 0)) as decimal(18, 3)) as daily_net,
  count(*) as movement_count,
  max(case when coalesce(en.Credit, 0) > 0 and (acp.Name = N'الموردون' or pl.GUID is not null) then en.Date end) as last_payment_date
from dbo.en000 en
join dbo.cu000 cu
  on cu.AccountGUID = en.AccountGUID
left join dbo.ac000 acc on acc.GUID = cu.AccountGUID
left join dbo.ac000 acp on acp.GUID = acc.ParentGUID
left join payment_lines pl on pl.GUID = en.GUID
where
  en.Date >= @reportDate
  and en.Date < dateadd(day, 1, @reportDate)
  and (coalesce(en.Debit, 0) > 0 or coalesce(en.Credit, 0) > 0)
  and cu.CustomerName is not null
  and ltrim(rtrim(cu.CustomerName)) <> ''
  and (cu.bHide is null or cu.bHide = 0)
group by
  cu.CustomerName,
  cu.GUID
order by
  daily_net desc,
  cu.CustomerName;
"@

  $dateParam = New-Object System.Data.SqlClient.SqlParameter("@reportDate", [System.Data.SqlDbType]::DateTime)
  $dateParam.Value = $parsedDate

  return Invoke-SqlRowsParameterized -ConnectionString $ConnectionString -Query $query -Parameters @($dateParam)
}

# المعرّف الصفري الذي يكتبه الأمين بدل NULL ليس معرّفاً — عامله كغياب دائماً.
function Get-NormalizedGuid($Value) {
  if ($null -eq $Value) { return "" }
  $guid = ([string]$Value).Trim().ToLowerInvariant()
  if (-not $guid -or $guid -eq "00000000-0000-0000-0000-000000000000") { return "" }
  return $guid
}

# هوية صاحب الحد `customer_guid` لا اسمه. هذا التقرير كان يطابق بالمفتاح النصّي
# وحده، فإعادة تسمية حساب في الأمين تُسقط حدَّ صاحبه من عدّادَي «تجاوز الحد»
# و«قريب من الحد» ومن الجدول المُرسَل — بالضبط كما كانت تسقطه الواجهة قبل
# هذا الإصلاح. ثلاث خرائط لا واحدة، بنفس انضباط `customerLimitMaps` في
# `src/app.js`:
#   • ByGuid       — الهوية القطعية.
#   • ByKeyLegacy  — حدود **بلا معرّف** فقط؛ هي وحدها ما يجوز مطابقته بالاسم
#                    لزبون يحمل معرّفاً، وإلا ورث حسابٌ حدَّ حسابٍ آخر يطابقه اسماً.
#   • ByKeyAny     — لتقارير أرصدة قديمة لا تحمل معرّفاً؛ السلوك السابق حرفياً.
function Convert-CreditLimitsMap($Rows) {
  $byGuid = @{}
  $byKeyLegacy = @{}
  $byKeyAny = @{}
  foreach ($row in @($Rows)) {
    $guid = Get-NormalizedGuid $row.customer_guid
    if (-not $guid) { $guid = Get-NormalizedGuid $row.customerGuid }

    $key = ""
    if ($row.customerKey) {
      $key = [string]$row.customerKey
    } elseif ($row.customer_key) {
      $key = [string]$row.customer_key
    }

    if ($guid -and -not $byGuid.ContainsKey($guid)) { $byGuid[$guid] = $row }
    if ($key) {
      if (-not $byKeyAny.ContainsKey($key)) { $byKeyAny[$key] = $row }
      if (-not $guid -and -not $byKeyLegacy.ContainsKey($key)) { $byKeyLegacy[$key] = $row }
    }
  }
  return @{ ByGuid = $byGuid; ByKeyLegacy = $byKeyLegacy; ByKeyAny = $byKeyAny }
}

function Get-InternalCreditLimit($Item, $CreditLimits) {
  $guid = Get-NormalizedGuid $Item.customerGuid
  if ($guid -and $CreditLimits.ByGuid.ContainsKey($guid)) {
    return To-Number $CreditLimits.ByGuid[$guid].credit_limit
  }

  $key = [string]$Item.key
  if (-not $key) { return 0 }

  if ($guid) {
    if ($CreditLimits.ByKeyLegacy.ContainsKey($key)) {
      return To-Number $CreditLimits.ByKeyLegacy[$key].credit_limit
    }
    return 0
  }

  if ($CreditLimits.ByKeyAny.ContainsKey($key)) {
    return To-Number $CreditLimits.ByKeyAny[$key].credit_limit
  }
  return 0
}

function Get-EffectiveCustomerItems($Items, $CreditLimits) {
  $result = @()
  foreach ($item in @($Items)) {
    $key = [string]$item.key
    $internalLimit = Get-InternalCreditLimit -Item $item -CreditLimits $CreditLimits

    $ameenLimit = To-Number $item.creditLimit
    $limit = if ($internalLimit -gt 0) { $internalLimit } else { $ameenLimit }
    $balance = To-Number $item.balance
    $status = "clear"
    if ($limit -gt 0 -and $balance -gt $limit) {
      $status = "over_limit"
    } elseif ($limit -gt 0 -and $balance -gt 0 -and $balance -ge ($limit * 0.8)) {
      $status = "near_limit"
    } elseif ($balance -gt 0) {
      $status = "open_balance"
    } elseif ($balance -lt 0) {
      $status = "credit_balance"
    }

    $result += [PSCustomObject]@{
      name = [string]$item.name
      key = $key
      balance = $balance
      creditLimit = $limit
      remainingLimit = if ($limit -gt 0) { $limit - [math]::Max(0, $balance) } else { 0 }
      status = $status
      lastPaymentAmount = To-Number $item.lastPaymentAmount
      lastPaymentDate = [string]$item.lastPaymentDate
    }
  }
  return $result
}

function Build-TableRows($Rows, $Columns) {
  if (-not @($Rows).Count) {
    return '<tr><td colspan="{0}">لا توجد بيانات.</td></tr>' -f $Columns.Count
  }

  return (@($Rows) | ForEach-Object {
    $cells = foreach ($column in $Columns) {
      $value = & $column.Value $_
      "<td>$(Escape-Html $value)</td>"
    }
    "<tr>$($cells -join '')</tr>"
  }) -join "`n"
}

function Build-DailySummaryHtml($Summary, $DailyRows, $Customers, $StockSummary, $OutputCsvPath) {
  $topPayments = @($DailyRows | Sort-Object daily_credit -Descending | Select-Object -First 12)
  $topDebits = @($DailyRows | Sort-Object daily_debit -Descending | Select-Object -First 12)
  $topDebtors = @($Customers | Where-Object { $_.balance -gt 0 } | Sort-Object balance -Descending | Select-Object -First 12)
  $overLimit = @($Customers | Where-Object { $_.status -eq "over_limit" } | Sort-Object remainingLimit | Select-Object -First 12)

  $paymentColumns = @(
    [PSCustomObject]@{ Label = "الزبون"; Value = { param($row) $row.customer_name } }
    [PSCustomObject]@{ Label = "دفعات اليوم"; Value = { param($row) Format-Money $row.daily_credit } }
    [PSCustomObject]@{ Label = "حركة دين اليوم"; Value = { param($row) Format-Money $row.daily_debit } }
    [PSCustomObject]@{ Label = "الصافي"; Value = { param($row) Format-Money $row.daily_net } }
  )
  $debtorColumns = @(
    [PSCustomObject]@{ Label = "الزبون"; Value = { param($row) $row.name } }
    [PSCustomObject]@{ Label = "الرصيد"; Value = { param($row) Format-Money $row.balance } }
    [PSCustomObject]@{ Label = "الحد"; Value = { param($row) if ($row.creditLimit -gt 0) { Format-Money $row.creditLimit } else { "غير محدد" } } }
    [PSCustomObject]@{ Label = "المتبقي"; Value = { param($row) if ($row.creditLimit -gt 0) { Format-Money $row.remainingLimit } else { "غير محدد" } } }
  )

  $paymentsHeader = ($paymentColumns | ForEach-Object { "<th>$(Escape-Html $_.Label)</th>" }) -join ""
  $debtorsHeader = ($debtorColumns | ForEach-Object { "<th>$(Escape-Html $_.Label)</th>" }) -join ""

  $html = @"
<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>OZK TOBACCO Daily Summary $($Summary.reportDate)</title>
  <style>
    body { margin: 0; padding: 24px; background: #080705; color: #fff6dd; font-family: Segoe UI, Tahoma, Arial, sans-serif; }
    h1, h2 { margin: 0 0 12px; }
    .muted { color: #bba779; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
    .metric, section { border: 1px solid #46361f; border-radius: 8px; background: #14100b; padding: 14px; }
    .metric span { display: block; color: #bba779; font-size: 13px; }
    .metric strong { display: block; color: #f2cf78; font-size: 24px; margin-top: 4px; direction: ltr; text-align: right; }
    section { margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #332716; padding: 8px; text-align: right; }
    th { color: #f2cf78; }
    td { color: #fff6dd; }
    .ltr { direction: ltr; unicode-bidi: plaintext; }
  </style>
</head>
<body>
  <h1>ملخص الحركة اليومية - OZK TOBACCO</h1>
  <p class="muted">تاريخ التقرير: <span class="ltr">$($Summary.reportDate)</span> / وقت الإنشاء: <span class="ltr">$($Summary.generatedAt)</span></p>
  <div class="grid">
    <div class="metric"><span>حركة دين اليوم</span><strong>$(Format-Money $Summary.dailyDebit)</strong></div>
    <div class="metric"><span>دفعات اليوم</span><strong>$(Format-Money $Summary.dailyCredit)</strong></div>
    <div class="metric"><span>صافي الحركة</span><strong>$(Format-Money $Summary.dailyNet)</strong></div>
    <div class="metric"><span>زبائن تحركوا اليوم</span><strong>$($Summary.activeCustomers)</strong></div>
    <div class="metric"><span>إجمالي ديون الزبائن</span><strong>$(Format-Money $Summary.totalDebitBalance)</strong></div>
    <div class="metric"><span>تجاوزوا الحد</span><strong>$($Summary.overLimitCustomers)</strong></div>
    <div class="metric"><span>قريب من الحد</span><strong>$($Summary.nearLimitCustomers)</strong></div>
    <div class="metric"><span>قرب النفاد / نفد</span><strong>$($StockSummary.lowStockItems) / $($StockSummary.outOfStockItems)</strong></div>
  </div>
  <section>
    <h2>أكبر دفعات اليوم</h2>
    <table><thead><tr>$paymentsHeader</tr></thead><tbody>$(Build-TableRows $topPayments $paymentColumns)</tbody></table>
  </section>
  <section>
    <h2>أكبر حركة دين اليوم</h2>
    <table><thead><tr>$paymentsHeader</tr></thead><tbody>$(Build-TableRows $topDebits $paymentColumns)</tbody></table>
  </section>
  <section>
    <h2>أعلى أرصدة حالية</h2>
    <table><thead><tr>$debtorsHeader</tr></thead><tbody>$(Build-TableRows $topDebtors $debtorColumns)</tbody></table>
  </section>
  <section>
    <h2>متجاوزو الحد</h2>
    <table><thead><tr>$debtorsHeader</tr></thead><tbody>$(Build-TableRows $overLimit $debtorColumns)</tbody></table>
  </section>
  <p class="muted">ملف CSV التفصيلي: <span class="ltr">$(Escape-Html $OutputCsvPath)</span></p>
</body>
</html>
"@
  return $html
}

function Send-DailyEmail($Subject, $HtmlBody, $Attachments) {
  $server = Optional-Env "TOBACCO_SMTP_SERVER"
  $user = Optional-Env "TOBACCO_SMTP_USER"
  $password = Optional-Env "TOBACCO_SMTP_PASSWORD"
  $from = Optional-Env "TOBACCO_SMTP_FROM"
  $to = Optional-Env "TOBACCO_DAILY_REPORT_TO"

  if (-not $to) {
    $to = "ozk.kh@outlook.com"
  }

  if (-not $server -or -not $user -or -not $password -or -not $from) {
    Write-DailyLog "Email skipped: SMTP environment variables are not configured. Report was generated locally."
    return $false
  }

  $portValue = Optional-Env "TOBACCO_SMTP_PORT"
  $port = if ($portValue) { [int]$portValue } else { 587 }
  $enableSslValue = Optional-Env "TOBACCO_SMTP_SSL"
  $enableSsl = -not ($enableSslValue -and $enableSslValue.ToLowerInvariant() -eq "false")

  $message = New-Object System.Net.Mail.MailMessage
  $smtp = New-Object System.Net.Mail.SmtpClient($server, $port)

  try {
    $message.From = $from
    foreach ($address in $to.Split(",", [System.StringSplitOptions]::RemoveEmptyEntries)) {
      $message.To.Add($address.Trim())
    }
    $message.Subject = $Subject
    $message.Body = $HtmlBody
    $message.IsBodyHtml = $true

    foreach ($attachment in @($Attachments)) {
      if (Test-Path -LiteralPath $attachment) {
        [void]$message.Attachments.Add($attachment)
      }
    }

    $smtp.EnableSsl = $enableSsl
    $smtp.Credentials = New-Object System.Net.NetworkCredential($user, $password)
    $smtp.Send($message)
    Write-DailyLog "Email sent to $to"
    return $true
  } catch {
    Write-DailyLog "Email failed: $($_.Exception.Message)"
    return $false
  } finally {
    $message.Dispose()
    $smtp.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $OutputDirectory)) {
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
}

$supabaseUrl = (Require-Env "TOBACCO_SUPABASE_URL").TrimEnd("/")
$supabaseKey = Require-Env "TOBACCO_SUPABASE_PUBLIC_KEY"
$syncEmail = Require-Env "TOBACCO_SYNC_EMAIL"
$syncPassword = Require-Env "TOBACCO_SYNC_PASSWORD"
$connectionString = Require-Env "AMEEN_SQL_CONNECTION_STRING"

$session = Get-SupabaseSession -Url $supabaseUrl -ApiKey $supabaseKey -Email $syncEmail -Password $syncPassword
$inventoryReports = @(Invoke-SupabaseGet -Url $supabaseUrl -ApiKey $supabaseKey -Session $session -PathAndQuery "inventory_reports?select=created_at,summary,items&source=eq.ameen_sql_agent&order=created_at.desc&limit=1")
$customerReports = @(Invoke-SupabaseGet -Url $supabaseUrl -ApiKey $supabaseKey -Session $session -PathAndQuery "inventory_reports?select=created_at,summary,items&source=eq.ameen_customer_balances&order=created_at.desc&limit=1")
$creditLimitRows = @(Invoke-SupabaseGet -Url $supabaseUrl -ApiKey $supabaseKey -Session $session -PathAndQuery "customer_credit_limits?select=customer_key,customer_guid,customer_name,credit_limit,notes")

if (-not $inventoryReports.Count) {
  throw "No Ameen inventory report found in Supabase."
}
if (-not $customerReports.Count) {
  throw "No Ameen customer balance report found in Supabase."
}

$dailyRows = @(Get-DailyMovementRows -ConnectionString $connectionString -ReportDate $ReportDate)
$creditLimits = Convert-CreditLimitsMap $creditLimitRows
$customers = @(Get-EffectiveCustomerItems -Items $customerReports[0].items -CreditLimits $creditLimits)
$stockSummary = $inventoryReports[0].summary

$dailyDebit = 0.0
$dailyCredit = 0.0
foreach ($row in $dailyRows) {
  $dailyDebit += To-Number $row.daily_debit
  $dailyCredit += To-Number $row.daily_credit
}

$totalDebitBalance = 0.0
foreach ($customer in $customers) {
  if ($customer.balance -gt 0) {
    $totalDebitBalance += $customer.balance
  }
}

$summary = [PSCustomObject]@{
  reportDate = $ReportDate
  generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  dailyDebit = [math]::Round($dailyDebit, 3)
  dailyCredit = [math]::Round($dailyCredit, 3)
  dailyNet = [math]::Round($dailyDebit - $dailyCredit, 3)
  activeCustomers = $dailyRows.Count
  totalDebitBalance = [math]::Round($totalDebitBalance, 3)
  overLimitCustomers = @($customers | Where-Object { $_.status -eq "over_limit" }).Count
  nearLimitCustomers = @($customers | Where-Object { $_.status -eq "near_limit" }).Count
}

$csvPath = Join-Path $OutputDirectory ("tobacco-daily-movement-{0}.csv" -f $ReportDate)
$htmlPath = Join-Path $OutputDirectory ("tobacco-daily-summary-{0}.html" -f $ReportDate)

if (@($dailyRows).Count) {
  $dailyRows |
    Select-Object customer_name, daily_debit, daily_credit, daily_net, movement_count, last_payment_date |
    Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
} else {
  "customer_name,daily_debit,daily_credit,daily_net,movement_count,last_payment_date" |
    Set-Content -LiteralPath $csvPath -Encoding UTF8
}

$html = Build-DailySummaryHtml -Summary $summary -DailyRows $dailyRows -Customers $customers -StockSummary $stockSummary -OutputCsvPath $csvPath
[System.IO.File]::WriteAllText($htmlPath, $html, [System.Text.Encoding]::UTF8)

$subject = "OZK TOBACCO daily movement summary $ReportDate"
$sent = Send-DailyEmail -Subject $subject -HtmlBody $html -Attachments @($htmlPath, $csvPath)

Write-DailyLog ("Daily summary generated. Date={0}, ActiveCustomers={1}, DailyDebit={2}, DailyCredit={3}, EmailSent={4}, Html={5}, Csv={6}" -f $ReportDate, $summary.activeCustomers, (Format-Money $summary.dailyDebit), (Format-Money $summary.dailyCredit), $sent, $htmlPath, $csvPath)

