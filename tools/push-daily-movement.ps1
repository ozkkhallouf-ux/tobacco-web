# ============================================================
# push-daily-movement.ps1
# READ-ONLY on Al-Ameen SQL. It only publishes a presentation
# snapshot to Supabase for the website and Telegram bot.
#
# The cash report covers the four approved operating cashboxes:
#   - Centre sales USD / SYP
#   - Sham Cash USD / SYP
# Every cashbox is reported in its own native currency.
# Internal transfers are separated from external inflow/outflow.
# ============================================================
param(
    [string]$Date = (Get-Date).ToString("yyyy-MM-dd"),
    [string]$EnvFile = "$PSScriptRoot\.env",
    [int]$MinimumIntervalMinutes = 0,
    [switch]$NoUpload
)

$ErrorActionPreference = "Stop"
if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "Date must be yyyy-MM-dd" }
if ($MinimumIntervalMinutes -lt 0) { throw "MinimumIntervalMinutes cannot be negative" }

$markerPath = Join-Path $PSScriptRoot "logs\daily-movement-last-sync.txt"
if (-not $NoUpload -and $MinimumIntervalMinutes -gt 0 -and (Test-Path -LiteralPath $markerPath)) {
    try {
        $lastSync = [datetime]::Parse(
            (Get-Content -Raw -LiteralPath $markerPath).Trim(),
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        $age = (Get-Date).ToUniversalTime() - $lastSync.ToUniversalTime()
        if ($lastSync.ToLocalTime().ToString("yyyy-MM-dd") -eq $Date -and $age.TotalMinutes -lt $MinimumIntervalMinutes) {
            Write-Host ("SKIP - daily movement was synced {0:N1} minutes ago." -f $age.TotalMinutes)
            return
        }
    } catch {
        # An invalid marker must not block a fresh accounting snapshot.
    }
}

if (Test-Path -LiteralPath $EnvFile) {
    Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $kv = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($kv[0].Trim(), $kv[1].Trim(), "Process")
    }
}

$connStr = $env:AMEEN_SQL_CONNECTION_STRING
if (-not $connStr) { $connStr = $env:AMEEN_SQL_WRITE_CONNECTION_STRING }
if (-not $connStr) { throw "No AMEEN SQL connection string found." }

# Stable account identifiers in AmnDb002. GUIDs are used deliberately so a
# mistyped or changed account code cannot silently select the wrong cashbox.
$CASH_ROOT = "c0dc3c06-b2ac-4e57-beae-19d7da3f514c"
$CENTRE_USD = "aacb5a67-6a19-45e4-b0b3-9a0b61a5790f"
$CENTRE_SYP = "18d12068-7b7a-45bc-855b-5a0dec084f9d"
$SHAMCASH_USD = "007fb589-7fb3-4e9e-b289-6cfc153dacb5"
$SHAMCASH_SYP = "b3b2ee0f-0099-4390-8920-f1099c553658"
$USD = "c06860b8-c1ed-42e8-bf94-a630aae129ac"

Add-Type -AssemblyName "System.Data"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
$conn.Open()

function Query($sql) {
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 180
    $reader = $cmd.ExecuteReader()
    $rows = @()
    while ($reader.Read()) {
        $row = [ordered]@{}
        for ($i = 0; $i -lt $reader.FieldCount; $i++) {
            $name = $reader.GetName($i)
            $value = if ($reader.IsDBNull($i)) { $null } else { $reader.GetValue($i) }
            if ($value -is [decimal]) { $value = [double]$value }
            $row[$name] = $value
        }
        $rows += [pscustomobject]$row
    }
    $reader.Close()
    return $rows
}

try {
    # Sales quantities by bill type and Unit2 (sales=1, returns=3).
    $salesSql = @"
SELECT bt.Name AS billType, bt.BillType AS billClass, ISNULL(m.Unit2,'') AS unit,
       CAST(SUM(CASE WHEN m.Unit2Fact > 0 THEN bi.Qty / m.Unit2Fact ELSE 0 END) AS decimal(18,3)) AS units,
       COUNT(DISTINCT u.GUID) AS bills
FROM bu000 u
JOIN bi000 bi ON bi.ParentGUID = u.GUID
JOIN mt000 m  ON m.GUID = bi.MatGUID
JOIN bt000 bt ON bt.GUID = u.TypeGUID
WHERE u.Date >= '$Date' AND u.Date < DATEADD(day,1,'$Date')
  AND bt.BillType IN (1,3)
GROUP BY bt.Name, bt.BillType, m.Unit2
HAVING SUM(CASE WHEN m.Unit2Fact > 0 THEN bi.Qty / m.Unit2Fact ELSE 0 END) <> 0
ORDER BY bt.Name, m.Unit2
"@
    $sales = Query $salesSql

    # Customer payments are expressed in Al-Ameen's USD base currency. Keep
    # individual payments so names and notes are preserved. A payment is money
    # that reached a cashbox, not every customer credit line: the block between
    # the payment-rule markers is copied verbatim from
    # tools/ameen-customer-balances-query.sql (the check enforces it), so invoice
    # discounts, returns, purchase bills, opening entries, transfers and non-121
    # accounts registered in cu000 stay out. Suppliers remain excluded as before.
    $paymentSql = @"
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
SELECT c.CustomerName AS customer,
       CAST(en.Credit AS decimal(18,2)) AS amount,
       en.Number AS number,
       LEFT(COALESCE(en.Notes,''), 120) AS notes
FROM en000 en
JOIN cu000 c ON c.AccountGUID = en.AccountGUID
  LEFT JOIN ac000 acc ON acc.GUID = c.AccountGUID
  LEFT JOIN ac000 acp ON acp.GUID = acc.ParentGUID
WHERE en.Credit > 0
  AND COALESCE(en.Type, 0) = 0
  AND en.Date >= '$Date' AND en.Date < DATEADD(day,1,'$Date')
  AND c.CustomerName IS NOT NULL AND LTRIM(RTRIM(c.CustomerName)) <> ''
  AND (acp.Name IS NULL OR acp.Name <> N'الموردون')
  AND en.GUID IN (SELECT pl.GUID FROM payment_lines pl)
ORDER BY en.Credit DESC, c.CustomerName, en.Number
"@
    $payments = Query $paymentSql

    # Backward-compatible aggregate used by the existing website report.
    $usdPayments = @(
        $payments |
            Group-Object customer |
            ForEach-Object {
                [pscustomobject][ordered]@{
                    customer = $_.Name
                    paid = [math]::Round((($_.Group | Measure-Object -Property amount -Sum).Sum), 2)
                }
            } |
            Sort-Object paid -Descending
    )

    # Existing no-name USD cash-sales number kept for the current website UI.
    $cashSql = @"
SELECT CAST(ISNULL(SUM(u.Total),0) AS decimal(18,2)) AS total, COUNT(*) AS bills
FROM bu000 u JOIN bt000 bt ON bt.GUID = u.TypeGUID
WHERE u.CurrencyGUID = '$USD' AND bt.BillType = 1
  AND (u.Cust_Name IS NULL OR LTRIM(RTRIM(u.Cust_Name)) = '')
  AND u.Date >= '$Date' AND u.Date < DATEADD(day,1,'$Date')
"@
    $cash = (Query $cashSql)[0]

    # Debit on a cash account is incoming money; credit is outgoing money.
    # CurrencyVal is USD per one native-currency unit, so native amount is
    # base USD divided by that rate. Contra accounts under the cash root are
    # internal transfers and are shown separately to avoid double counting.
    $cashboxSql = @"
WITH CashTree AS (
    SELECT GUID, ParentGUID FROM ac000 WHERE GUID = '$CASH_ROOT'
    UNION ALL
    SELECT a.GUID, a.ParentGUID
    FROM ac000 a
    JOIN CashTree p ON a.ParentGUID = p.GUID
),
SelectedCash AS (
    SELECT CAST('$CENTRE_USD' AS uniqueidentifier) AS AccountGUID
    UNION ALL SELECT CAST('$CENTRE_SYP' AS uniqueidentifier)
    UNION ALL SELECT CAST('$SHAMCASH_USD' AS uniqueidentifier)
    UNION ALL SELECT CAST('$SHAMCASH_SYP' AS uniqueidentifier)
),
Entries AS (
    SELECT a.GUID AS AccountGUID, a.Code, a.Name, cur.Code AS Currency,
           cur.CurrencyVal AS CurrentRateToUsd, en.Date, en.Debit, en.Credit,
           en.ContraAccGUID,
           COALESCE(NULLIF(en.CurrencyVal,0), NULLIF(entryCur.CurrencyVal,0), NULLIF(cur.CurrencyVal,0), 1.0) AS RateToUsd,
           CASE WHEN ct.GUID IS NULL THEN 0 ELSE 1 END AS IsInternalTransfer
    FROM SelectedCash s
    JOIN ac000 a ON a.GUID = s.AccountGUID
    JOIN my000 cur ON cur.GUID = a.CurrencyGUID
    LEFT JOIN en000 en ON en.AccountGUID = a.GUID
    LEFT JOIN my000 entryCur ON entryCur.GUID = en.CurrencyGUID
    LEFT JOIN CashTree ct ON ct.GUID = en.ContraAccGUID
)
SELECT Code AS code, Name AS name, Currency AS currency,
       CAST(MAX(CurrentRateToUsd) AS decimal(24,10)) AS rateToUsd,
       CAST(ISNULL(SUM(CASE WHEN Date < '$Date' THEN (Debit-Credit)/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS opening,
       CAST(ISNULL(SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') THEN Debit/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS incoming,
       CAST(ISNULL(SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') THEN Credit/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS outgoing,
       CAST(ISNULL(SUM(CASE WHEN Date < DATEADD(day,1,'$Date') THEN (Debit-Credit)/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS closing,
       CAST(ISNULL(SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') AND IsInternalTransfer=0 THEN Debit/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS externalIncoming,
       CAST(ISNULL(SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') AND IsInternalTransfer=0 THEN Credit/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS externalOutgoing,
       CAST(ISNULL(SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') AND IsInternalTransfer=1 THEN Debit/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS transferIn,
       CAST(ISNULL(SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') AND IsInternalTransfer=1 THEN Credit/RateToUsd ELSE 0 END),0) AS decimal(24,2)) AS transferOut,
       SUM(CASE WHEN Date >= '$Date' AND Date < DATEADD(day,1,'$Date') THEN 1 ELSE 0 END) AS entries
FROM Entries
GROUP BY AccountGUID, Code, Name, Currency
ORDER BY Code
OPTION (MAXRECURSION 100)
"@
    $cashboxes = @(Query $cashboxSql)
} finally {
    $conn.Close()
}

$cashTotalsByCurrency = [ordered]@{}
foreach ($box in $cashboxes) {
    $currency = [string]$box.currency
    if (-not $cashTotalsByCurrency.Contains($currency)) {
        $cashTotalsByCurrency[$currency] = [ordered]@{
            currency = $currency
            opening = 0.0
            externalIncoming = 0.0
            externalOutgoing = 0.0
            closing = 0.0
        }
    }
    $totals = $cashTotalsByCurrency[$currency]
    $totals.opening += [double]$box.opening
    $totals.externalIncoming += [double]$box.externalIncoming
    $totals.externalOutgoing += [double]$box.externalOutgoing
    $totals.closing += [double]$box.closing
}
$cashTotals = @($cashTotalsByCurrency.Values | ForEach-Object {
    $_.opening = [math]::Round([double]$_.opening, 2)
    $_.externalIncoming = [math]::Round([double]$_.externalIncoming, 2)
    $_.externalOutgoing = [math]::Round([double]$_.externalOutgoing, 2)
    $_.closing = [math]::Round([double]$_.closing, 2)
    [pscustomobject]$_
})

$paymentTotal = [math]::Round((($payments | Measure-Object -Property amount -Sum).Sum), 2)
$payload = [ordered]@{
    date = $Date
    generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    accountingBasis = "Al-Ameen en000 read-only; Debit=incoming, Credit=outgoing; customer payments are USD base"
    sales = @($sales)
    payments = @($payments)
    paymentSummary = [ordered]@{ count = @($payments).Count; totalUsd = $paymentTotal }
    usdPayments = @($usdPayments)
    usdCash = [ordered]@{ total = [double]$cash.total; bills = [int]$cash.bills }
    cashboxes = @($cashboxes)
    cashTotals = @($cashTotals)
}

if (-not $NoUpload) {
    function Need($name) {
        $value = [Environment]::GetEnvironmentVariable($name, "User")
        if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, "Process") }
        if (-not $value) { throw "Missing env var: $name" }
        return $value
    }

    $url = (Need "TOBACCO_SUPABASE_URL").TrimEnd("/")
    $key = Need "TOBACCO_SUPABASE_PUBLIC_KEY"
    $email = Need "TOBACCO_SYNC_EMAIL"
    $password = Need "TOBACCO_SYNC_PASSWORD"
    $auth = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" -Headers @{ apikey=$key; Accept="application/json" } -ContentType "application/json; charset=utf-8" -Body (@{ email=$email; password=$password } | ConvertTo-Json)
    $body = @{ report_date = $Date; payload = $payload } | ConvertTo-Json -Depth 10
    Invoke-RestMethod -Method Post -Uri "$url/rest/v1/daily_movement_reports" -Headers @{ apikey=$key; Authorization=("Bearer "+$auth.access_token); "Accept-Profile"="public"; "Content-Profile"="public"; Prefer="return=minimal" } -ContentType "application/json; charset=utf-8" -Body $body | Out-Null

    $markerDir = Split-Path -Parent $markerPath
    if (-not (Test-Path -LiteralPath $markerDir)) { New-Item -ItemType Directory -Path $markerDir | Out-Null }
    (Get-Date).ToUniversalTime().ToString("o") | Set-Content -LiteralPath $markerPath -Encoding UTF8
}

Write-Host ""
Write-Host ("=== Daily Movement " + $Date + " ===")
Write-Host ("Customer payments: " + @($payments).Count + " / total USD " + $paymentTotal)
foreach ($box in $cashboxes) {
    Write-Host ("  " + $box.name + " [" + $box.currency + "] opening=" + $box.opening + " incoming=" + $box.incoming + " outgoing=" + $box.outgoing + " closing=" + $box.closing)
}
if ($NoUpload) { Write-Host "READ-ONLY CHECK OK - nothing uploaded." }
else { Write-Host "PUSH OK - daily movement uploaded to Supabase." }
