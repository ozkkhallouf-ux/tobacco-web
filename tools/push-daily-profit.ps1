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

# المعادلة والاستعلام في مكان واحد يشاركه سكربت إعادة احتساب الأيام الماضية
# (recompute-daily-profit.ps1)، فلا تنحرف معادلة اليوم عن معادلة الأيام السابقة.
. "$PSScriptRoot\daily-profit-lib.ps1"

try {
    $conn = New-AmeenReadOnlyConnection -ConnectionString $connStr -ApplicationName "ozk-daily-profit-today"
    try {
        # اليوم بتقويم خادم الأمين نفسه (CAST(GETDATE() AS date)) كما كان دائماً.
        $reportDate = Get-DailyProfitServerToday $conn
        $rows = Get-DailyProfitRows -Connection $conn -From $reportDate -To $reportDate -TimeoutSeconds 180
    } finally { $conn.Close() }
    if ($rows.Count -ne 1) { throw "لم يرجع استعلام الربح نتيجة واحدة لليوم." }

    $summary = New-DailyProfitSummary -Row $rows[0] -SyncMode "today"
    $salesGross = $summary.sales_gross
    $netProfit = $summary.net_profit
    $missingCostLines = $summary.missing_cost_lines

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
