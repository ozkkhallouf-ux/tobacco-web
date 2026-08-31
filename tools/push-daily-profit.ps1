# ============================================================
# push-daily-profit.ps1
# يحسب ربح اليوم من المصدر المحاسبي في الأمين ويرفع ملخصاً خاصاً
# إلى inventory_reports ليقرأه بوت تيليغرام.
#
# المعادلة:
# صافي المبيعات = المبيعات - الحسومات - المرتجعات
# صافي تكلفة البضاعة = تكلفة المبيع - تكلفة البضاعة المرتجعة
# صافي الربح = صافي المبيعات - صافي التكلفة - مصاريف التشغيل
#
# كل قيم bu000 / bi000 / en000 هنا بعملة الأساس في الأمين (الدولار)،
# حتى عندما تكون الفاتورة الأصلية بالليرة السورية.
# ============================================================
param(
    [switch]$DryRun,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\daily-profit-push.log"
)

$ErrorActionPreference = "Stop"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

function Write-Log($Message) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Notify-Failure($Message) {
    try {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message $Message -EventType "sync_failure" -DedupeKey "winfail:push-daily-profit" `
            -DedupeMinutes 60 -EnvFile $EnvFile
    } catch { }
}

$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "خطأ: اتصال الأمين غير موجود."; exit 1 }
if (-not $apiKey -or -not $syncEmail -or -not $syncPassword) {
    Write-Log "خطأ: إعدادات مزامنة Supabase ناقصة."
    exit 1
}

# مصاريف التشغيل المعتمدة. مصاريف نقل المشتريات مستثناة لأنها جزء من
# تكلفة البضاعة، وإدخالها هنا مرة ثانية يضاعف التكلفة.
$EXPENSE_PARENT_GUID = "6AE0066F-D39E-4805-83D5-B8DA92F7D7F1"

$sql = @"
;WITH BillCost AS (
    SELECT
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
      AND u.Date >= CAST(GETDATE() AS date)
      AND u.Date < DATEADD(day, 1, CAST(GETDATE() AS date))
    GROUP BY u.GUID, bt.BillType, u.Total, u.TotalDisc, u.TotalExtra
), Expense AS (
    SELECT
        CAST(COALESCE(SUM(COALESCE(en.Debit, 0) - COALESCE(en.Credit, 0)), 0) AS float) AS amount,
        COUNT(*) AS entry_count
    FROM en000 en
    JOIN ac000 a ON a.GUID = en.AccountGUID
    WHERE a.ParentGUID = '$EXPENSE_PARENT_GUID'
      AND en.Date >= CAST(GETDATE() AS date)
      AND en.Date < DATEADD(day, 1, CAST(GETDATE() AS date))
      AND (COALESCE(en.Debit, 0) <> 0 OR COALESCE(en.Credit, 0) <> 0)
)
SELECT
    CAST(GETDATE() AS date) AS report_date,
    COALESCE(SUM(CASE WHEN b.BillType = 1 THEN b.gross_amount ELSE 0 END), 0) AS sales_gross,
    COALESCE(SUM(CASE WHEN b.BillType = 1 THEN b.discount_amount ELSE 0 END), 0) AS sales_discounts,
    COALESCE(SUM(CASE WHEN b.BillType = 1 THEN b.extra_amount ELSE 0 END), 0) AS sales_extras,
    COALESCE(SUM(CASE WHEN b.BillType = 1 THEN b.item_cost ELSE 0 END), 0) AS sales_cost,
    COALESCE(SUM(CASE WHEN b.BillType = 3 THEN b.gross_amount ELSE 0 END), 0) AS returns_gross,
    COALESCE(SUM(CASE WHEN b.BillType = 3 THEN b.discount_amount ELSE 0 END), 0) AS returns_discounts,
    COALESCE(SUM(CASE WHEN b.BillType = 3 THEN b.extra_amount ELSE 0 END), 0) AS returns_extras,
    COALESCE(SUM(CASE WHEN b.BillType = 3 THEN b.item_cost ELSE 0 END), 0) AS returns_cost,
    COALESCE(SUM(CASE WHEN b.BillType = 1 THEN 1 ELSE 0 END), 0) AS sales_bill_count,
    COALESCE(SUM(CASE WHEN b.BillType = 3 THEN 1 ELSE 0 END), 0) AS return_bill_count,
    COALESCE(SUM(b.line_count), 0) AS line_count,
    COALESCE(SUM(b.missing_cost_lines), 0) AS missing_cost_lines,
    e.amount AS expenses,
    e.entry_count AS expense_entry_count
FROM Expense e
LEFT JOIN BillCost b ON 1 = 1
GROUP BY e.amount, e.entry_count
"@

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 180
    $reader = $cmd.ExecuteReader()
    if (-not $reader.Read()) { throw "لم يرجع استعلام الربح أي نتيجة." }

    $reportDate = ([datetime]$reader["report_date"]).ToString("yyyy-MM-dd")
    $salesGross = [double]$reader["sales_gross"]
    $discounts = [double]$reader["sales_discounts"]
    $salesExtras = [double]$reader["sales_extras"]
    $salesCost = [double]$reader["sales_cost"]
    $returnsGross = [double]$reader["returns_gross"]
    $returnsDiscounts = [double]$reader["returns_discounts"]
    $returnsExtras = [double]$reader["returns_extras"]
    $returnsCost = [double]$reader["returns_cost"]
    $expenses = [double]$reader["expenses"]
    $salesBillCount = [int]$reader["sales_bill_count"]
    $returnBillCount = [int]$reader["return_bill_count"]
    $lineCount = [int]$reader["line_count"]
    $missingCostLines = [int]$reader["missing_cost_lines"]
    $expenseEntryCount = [int]$reader["expense_entry_count"]
    $reader.Close()
    $conn.Close()

    $netReturns = $returnsGross - $returnsDiscounts + $returnsExtras
    $netSales = $salesGross - $discounts + $salesExtras - $netReturns
    $netCost = $salesCost - $returnsCost
    $productMargin = $salesGross - $salesCost
    $grossProfit = $netSales - $netCost
    $netProfit = $grossProfit - $expenses

    $summary = [ordered]@{
        report_date = $reportDate
        currency = "USD"
        sales_gross = [math]::Round($salesGross, 4)
        sales_cost = [math]::Round($salesCost, 4)
        product_margin_before_adjustments = [math]::Round($productMargin, 4)
        discounts = [math]::Round($discounts, 4)
        sales_extras = [math]::Round($salesExtras, 4)
        returns = [math]::Round($netReturns, 4)
        returns_cost = [math]::Round($returnsCost, 4)
        net_sales = [math]::Round($netSales, 4)
        net_cost = [math]::Round($netCost, 4)
        gross_profit = [math]::Round($grossProfit, 4)
        expenses = [math]::Round($expenses, 4)
        net_profit = [math]::Round($netProfit, 4)
        sales_bill_count = $salesBillCount
        return_bill_count = $returnBillCount
        expense_entry_count = $expenseEntryCount
        line_count = $lineCount
        missing_cost_lines = $missingCostLines
        complete = ($missingCostLines -eq 0)
        synced_at = (Get-Date).ToUniversalTime().ToString("o")
    }

    Write-Log ("تم الحساب: مبيعات {0:N2}$ | ربح صافي {1:N2}$ | أسطر تكلفة ناقصة {2}" -f $salesGross, $netProfit, $missingCostLines)
    if ($DryRun) {
        [PSCustomObject]$summary | Format-List
        exit 0
    }

    $authBody = @{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress
    $auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($authBody)) -TimeoutSec 20
    if (-not $auth.access_token) { throw "فشل تسجيل دخول مستخدم المزامنة." }

    $headers = @{
        apikey = $apiKey
        Authorization = "Bearer $($auth.access_token)"
        "Accept-Profile" = "public"
        "Content-Profile" = "public"
        Prefer = "return=representation"
    }
    # created_by يُشتق داخل الدالة من auth.uid() (هوية جلسة تسجيل الدخول أعلاه)
    # لا يُرسَل كمعامل — تفادياً لانتحال created_by من أي مستدعٍ آخر لو تسرّبت
    # الصلاحية مستقبلاً (ملاحظة Codex P1 على PR #132).
    $payload = @{
        p_report_date = $reportDate
        p_summary = $summary
        p_items = @()
    } | ConvertTo-Json -Depth 8 -Compress

    # upsert ذرّي بجملة SQL واحدة (RPC upsert_ameen_daily_profit) بدل إدراج
    # ثم حذف الأقدم: النمط القديم يفتح نافذة تزامن حقيقية بين TOBACCO Ameen
    # Sync وTOBACCO Sales Line Items Push (كلاهما يستدعي هذا السكربت) — قد
    # يحذف كل تشغيل صفّ الآخر فيبقى اليوم بلا أي تقرير. فهرس فريد جزئي على
    # (report_date) بشرط source='ameen_daily_profit' يجعل Postgres يحسم
    # التعارض ذرّياً داخل الخادم بلا أي نافذة زمنية بين الإدراج والحذف.
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/upsert_ameen_daily_profit" `
        -Headers $headers -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 30 | Out-Null

    Write-Log "تم رفع تقرير الربح اليومي بنجاح (upsert ذرّي)."
    exit 0
} catch {
    Write-Log ("خطأ: " + $_.Exception.Message)
    Notify-Failure ("🚨 فشل حساب أو رفع الربح اليومي`n" + $_.Exception.Message)
    exit 1
}
