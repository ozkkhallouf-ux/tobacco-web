# Test-DailyProfitLib.ps1 - Windows PowerShell 5.1 regression test for tools/daily-profit-lib.ps1.
# No SQL, no Supabase: the formula and the zero-filled range run on synthetic rows.
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
. (Join-Path $root "tools\daily-profit-lib.ps1")

$script:pass = 0
function Assert-True($cond, [string]$name) {
    if (-not $cond) { throw "FAIL: $name" }
    $script:pass++
    Write-Host "PASS $name"
}
function Near($a, $b) { return [math]::Abs([double]$a - [double]$b) -lt 0.00005 }

# Run under a comma-decimal culture: rounding and dates must not depend on it.
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo("de-DE")

# 1) the approved formula
$row = New-DailyProfitZeroRow "2026-08-24"
$row.sales_gross = 1000.123456; $row.sales_discounts = 10; $row.sales_extras = 0.5
$row.sales_cost = 700; $row.returns_gross = 100; $row.returns_discounts = 5; $row.returns_extras = 1
$row.returns_cost = 60; $row.expenses = 25; $row.sales_bill_count = 3; $row.return_bill_count = 1
$row.line_count = 9; $row.missing_cost_lines = 0; $row.expense_entry_count = 2
$s = New-DailyProfitSummary -Row $row -SyncMode "recompute" -SyncedAt "2026-11-25T00:00:00.0000000Z"
# net returns = 100 - 5 + 1 = 96 ; net sales = 1000.123456 - 10 + 0.5 - 96 = 894.623456
Assert-True (Near $s.returns 96) "net returns = gross - discounts + extras"
Assert-True (Near $s.net_sales 894.6235) "net sales rounded to 4 places"
Assert-True (Near $s.net_cost 640) "net cost = sales cost - returns cost"
Assert-True (Near $s.gross_profit 254.6235) "gross (trading) profit = net sales - net cost"
Assert-True (Near $s.net_profit 229.6235) "net profit = gross profit - expenses"
Assert-True (Near $s.product_margin_before_adjustments 300.1235) "product margin = sales gross - sales cost"
Assert-True ($s.complete -eq $true) "no missing cost -> complete"
Assert-True ($s.sync_mode -eq "recompute" -and $s.report_date -eq "2026-08-24") "mode and date carried"

$keys = @($s.Keys)
$expected = @("report_date", "currency", "sales_gross", "sales_cost", "product_margin_before_adjustments", "discounts", "sales_extras", "returns", "returns_cost", "net_sales", "net_cost", "gross_profit", "expenses", "net_profit", "sales_bill_count", "return_bill_count", "expense_entry_count", "line_count", "missing_cost_lines", "complete", "sync_mode", "synced_at")
Assert-True (($keys -join ",") -eq ($expected -join ",")) "summary keys and order match the historical summary plus sync_mode"

# 2) missing cost is never a complete day
$row.missing_cost_lines = 2
$s2 = New-DailyProfitSummary -Row $row -SyncMode "today"
Assert-True ($s2.complete -eq $false -and $s2.missing_cost_lines -eq 2) "missing cost -> incomplete"

# 3) JSON is culture-independent (dot decimals)
$json = [pscustomobject]$s | ConvertTo-Json -Compress
Assert-True ($json.Contains('"net_sales":894.6235')) "JSON uses dot decimals under de-DE"

# 4) zero-filled range, no unrolling for a single day
$found = @{ "2026-08-02" = $row }
$range = Complete-DailyProfitRange -Rows $found -From ([datetime]"2026-08-01") -To ([datetime]"2026-08-03")
Assert-True ($range.Count -eq 3) "range has one row per calendar day"
Assert-True ($range[0].report_date -eq "2026-08-01" -and $range[0].sales_gross -eq 0 -and $range[0].missing_cost_lines -eq 0) "day without activity is zero, not skipped"
Assert-True ([object]::ReferenceEquals($range[1], $row)) "day with activity keeps its row"
$one = Complete-DailyProfitRange -Rows @{} -From ([datetime]"2026-11-20") -To ([datetime]"2026-11-20")
Assert-True ($one.Count -eq 1 -and $one[0].report_date -eq "2026-11-20") "single-day range stays a one-element list"

# 5) the range query keeps the approved filters and is parameterised
$sql = Get-DailyProfitRangeSql
Assert-True ($sql.Contains("u.Date >= @from") -and $sql.Contains("u.Date < DATEADD(day, 1, @to)")) "bills filtered by [@from, @to]"
Assert-True ($sql.Contains("en.Date >= @from") -and $sql.Contains("FULL OUTER JOIN Expense")) "expense-only days are kept"
Assert-True ($sql -notmatch '(?i)\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b') "range query is read-only"

Write-Host "DAILY_PROFIT_LIB_OK $script:pass"
