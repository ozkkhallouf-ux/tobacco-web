# ============================================================
# daily-profit-lib.ps1  (dot-source only; ASCII only for Windows PowerShell 5.1)
#
# Single source of the ameen_daily_profit formula, shared by:
#   - tools/push-daily-profit.ps1        (current day, every sync cycle)
#   - tools/recompute-daily-profit.ps1   (past days, nightly / weekly)
#
# The formula is the approved one, unchanged since push-daily-profit.ps1:
#   net returns = returns gross - returns discounts + returns extras
#   net sales   = sales gross - discounts + sales extras - net returns
#   net cost    = sales cost - returns cost        (cost = Qty x UnitCostPrice)
#   gross profit (trading profit) = net sales - net cost
#   net profit  = gross profit - operating expenses
# complete = (missing_cost_lines == 0). A line with UnitCostPrice NULL or <= 0
# adds 0 to the cost, so its day is flagged incomplete, never "profit".
#
# Ameen access: SELECT only. Every query here is a single read statement.
# ============================================================

# Operating-expense parent account. Purchase transport expenses are excluded
# on purpose: they are part of the goods cost already.
$script:DailyProfitExpenseParentGuid = "6AE0066F-D39E-4805-83D5-B8DA92F7D7F1"

function Get-DailyProfitRangeSql {
    # One row per calendar date that has a sales/return bill or an expense entry
    # in [@from, @to]. Dates with no activity are filled with zeros by
    # Get-DailyProfitRows, exactly like the single-day query used to return.
    return @"
;WITH BillCost AS (
    SELECT
        CAST(u.Date AS date) AS report_date,
        u.GUID,
        bt.BillType,
        CAST(COALESCE(u.Total, 0) AS float) AS gross_amount,
        CAST(COALESCE(u.TotalDisc, 0) AS float) AS discount_amount,
        CAST(COALESCE(u.TotalExtra, 0) AS float) AS extra_amount,
        SUM(CAST(COALESCE(bi.Qty, 0) * COALESCE(bi.UnitCostPrice, 0) AS float)) AS item_cost,
        SUM(CASE WHEN bi.UnitCostPrice IS NULL OR bi.UnitCostPrice <= 0 THEN 1 ELSE 0 END) AS missing_cost_lines,
        COUNT(*) AS line_count
    FROM bu000 u
    JOIN bt000 bt ON bt.GUID = u.TypeGUID
    JOIN bi000 bi ON bi.ParentGUID = u.GUID
    WHERE bt.BillType IN (1, 3)
      AND u.Date >= @from
      AND u.Date < DATEADD(day, 1, @to)
    GROUP BY CAST(u.Date AS date), u.GUID, bt.BillType, u.Total, u.TotalDisc, u.TotalExtra
), Bills AS (
    SELECT
        report_date,
        SUM(CASE WHEN BillType = 1 THEN gross_amount ELSE 0 END) AS sales_gross,
        SUM(CASE WHEN BillType = 1 THEN discount_amount ELSE 0 END) AS sales_discounts,
        SUM(CASE WHEN BillType = 1 THEN extra_amount ELSE 0 END) AS sales_extras,
        SUM(CASE WHEN BillType = 1 THEN item_cost ELSE 0 END) AS sales_cost,
        SUM(CASE WHEN BillType = 3 THEN gross_amount ELSE 0 END) AS returns_gross,
        SUM(CASE WHEN BillType = 3 THEN discount_amount ELSE 0 END) AS returns_discounts,
        SUM(CASE WHEN BillType = 3 THEN extra_amount ELSE 0 END) AS returns_extras,
        SUM(CASE WHEN BillType = 3 THEN item_cost ELSE 0 END) AS returns_cost,
        SUM(CASE WHEN BillType = 1 THEN 1 ELSE 0 END) AS sales_bill_count,
        SUM(CASE WHEN BillType = 3 THEN 1 ELSE 0 END) AS return_bill_count,
        SUM(line_count) AS line_count,
        SUM(missing_cost_lines) AS missing_cost_lines
    FROM BillCost
    GROUP BY report_date
), Expense AS (
    SELECT
        CAST(en.Date AS date) AS report_date,
        CAST(SUM(COALESCE(en.Debit, 0) - COALESCE(en.Credit, 0)) AS float) AS expenses,
        COUNT(*) AS expense_entry_count
    FROM en000 en
    JOIN ac000 a ON a.GUID = en.AccountGUID
    WHERE a.ParentGUID = '$($script:DailyProfitExpenseParentGuid)'
      AND en.Date >= @from
      AND en.Date < DATEADD(day, 1, @to)
      AND (COALESCE(en.Debit, 0) <> 0 OR COALESCE(en.Credit, 0) <> 0)
    GROUP BY CAST(en.Date AS date)
)
SELECT
    CONVERT(char(10), COALESCE(b.report_date, e.report_date), 23) AS report_date,
    COALESCE(b.sales_gross, 0) AS sales_gross,
    COALESCE(b.sales_discounts, 0) AS sales_discounts,
    COALESCE(b.sales_extras, 0) AS sales_extras,
    COALESCE(b.sales_cost, 0) AS sales_cost,
    COALESCE(b.returns_gross, 0) AS returns_gross,
    COALESCE(b.returns_discounts, 0) AS returns_discounts,
    COALESCE(b.returns_extras, 0) AS returns_extras,
    COALESCE(b.returns_cost, 0) AS returns_cost,
    COALESCE(b.sales_bill_count, 0) AS sales_bill_count,
    COALESCE(b.return_bill_count, 0) AS return_bill_count,
    COALESCE(b.line_count, 0) AS line_count,
    COALESCE(b.missing_cost_lines, 0) AS missing_cost_lines,
    COALESCE(e.expenses, 0) AS expenses,
    COALESCE(e.expense_entry_count, 0) AS expense_entry_count
FROM Bills b
FULL OUTER JOIN Expense e ON e.report_date = b.report_date
ORDER BY 1
"@
}

function New-DailyProfitZeroRow([string]$ReportDate) {
    return [ordered]@{
        report_date = $ReportDate
        sales_gross = 0.0; sales_discounts = 0.0; sales_extras = 0.0; sales_cost = 0.0
        returns_gross = 0.0; returns_discounts = 0.0; returns_extras = 0.0; returns_cost = 0.0
        sales_bill_count = 0; return_bill_count = 0; line_count = 0; missing_cost_lines = 0
        expenses = 0.0; expense_entry_count = 0
    }
}

function Get-DailyProfitServerToday($Connection) {
    # The Ameen server's own calendar day (the device clock), exactly what the
    # single-day query used through CAST(GETDATE() AS date).
    $cmd = $Connection.CreateCommand()
    $cmd.CommandText = "SELECT CONVERT(char(10), CAST(GETDATE() AS date), 23)"
    $cmd.CommandTimeout = 30
    return [string]$cmd.ExecuteScalar()
}

function Get-DailyProfitRows($Connection, [string]$From, [string]$To, [int]$TimeoutSeconds = 300) {
    # Returns one ordered row per calendar date in [From, To], zero-filled.
    $fromDate = [datetime]::ParseExact($From, "yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture)
    $toDate = [datetime]::ParseExact($To, "yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture)
    if ($toDate -lt $fromDate) { throw "daily profit range is empty: $From > $To" }

    $cmd = $Connection.CreateCommand()
    $cmd.CommandText = Get-DailyProfitRangeSql
    $cmd.CommandTimeout = $TimeoutSeconds
    $pFrom = $cmd.Parameters.Add("@from", [System.Data.SqlDbType]::Date); $pFrom.Value = $fromDate
    $pTo = $cmd.Parameters.Add("@to", [System.Data.SqlDbType]::Date); $pTo.Value = $toDate

    $found = @{}
    $reader = $cmd.ExecuteReader()
    try {
        while ($reader.Read()) {
            $row = New-DailyProfitZeroRow ([string]$reader["report_date"])
            foreach ($k in @("sales_gross", "sales_discounts", "sales_extras", "sales_cost", "returns_gross", "returns_discounts", "returns_extras", "returns_cost", "expenses")) {
                $row[$k] = [double]$reader[$k]
            }
            foreach ($k in @("sales_bill_count", "return_bill_count", "line_count", "missing_cost_lines", "expense_entry_count")) {
                $row[$k] = [int]$reader[$k]
            }
            $found[$row.report_date] = $row
        }
    } finally { $reader.Close() }

    return ,(Complete-DailyProfitRange -Rows $found -From $fromDate -To $toDate)
}

function Complete-DailyProfitRange([hashtable]$Rows, [datetime]$From, [datetime]$To) {
    $out = New-Object System.Collections.ArrayList
    for ($d = $From; $d -le $To; $d = $d.AddDays(1)) {
        $key = $d.ToString("yyyy-MM-dd", [Globalization.CultureInfo]::InvariantCulture)
        if ($Rows.ContainsKey($key)) { [void]$out.Add($Rows[$key]) } else { [void]$out.Add((New-DailyProfitZeroRow $key)) }
    }
    return ,$out
}

function New-DailyProfitSummary($Row, [string]$SyncMode = "today", [string]$SyncedAt = $null) {
    # Same keys, rounding and order as the summary push-daily-profit.ps1 has
    # always uploaded, plus sync_mode ("today" | "recompute").
    $netReturns = $Row.returns_gross - $Row.returns_discounts + $Row.returns_extras
    $netSales = $Row.sales_gross - $Row.sales_discounts + $Row.sales_extras - $netReturns
    $netCost = $Row.sales_cost - $Row.returns_cost
    $productMargin = $Row.sales_gross - $Row.sales_cost
    $grossProfit = $netSales - $netCost
    $netProfit = $grossProfit - $Row.expenses
    if (-not $SyncedAt) { $SyncedAt = (Get-Date).ToUniversalTime().ToString("o") }

    return [ordered]@{
        report_date = $Row.report_date
        currency = "USD"
        sales_gross = [math]::Round([double]$Row.sales_gross, 4)
        sales_cost = [math]::Round([double]$Row.sales_cost, 4)
        product_margin_before_adjustments = [math]::Round($productMargin, 4)
        discounts = [math]::Round([double]$Row.sales_discounts, 4)
        sales_extras = [math]::Round([double]$Row.sales_extras, 4)
        returns = [math]::Round($netReturns, 4)
        returns_cost = [math]::Round([double]$Row.returns_cost, 4)
        net_sales = [math]::Round($netSales, 4)
        net_cost = [math]::Round($netCost, 4)
        gross_profit = [math]::Round($grossProfit, 4)
        expenses = [math]::Round([double]$Row.expenses, 4)
        net_profit = [math]::Round($netProfit, 4)
        sales_bill_count = [int]$Row.sales_bill_count
        return_bill_count = [int]$Row.return_bill_count
        expense_entry_count = [int]$Row.expense_entry_count
        line_count = [int]$Row.line_count
        missing_cost_lines = [int]$Row.missing_cost_lines
        complete = ([int]$Row.missing_cost_lines -eq 0)
        sync_mode = $SyncMode
        synced_at = $SyncedAt
    }
}

function New-AmeenReadOnlyConnection([string]$ConnectionString, [string]$ApplicationName) {
    # Forces read intent and tags the session; never prints the connection string.
    Add-Type -AssemblyName "System.Data"
    $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder($ConnectionString)
    $b["ApplicationIntent"] = "ReadOnly"
    if ($ApplicationName) { $b["Application Name"] = $ApplicationName }
    $conn = New-Object System.Data.SqlClient.SqlConnection($b.ConnectionString)
    $conn.Open()
    return $conn
}
