# ينشر نتيجة فحص مزامنة الأسعار في bot_config ليقرأها بوت تيليغرام.
param(
    [ValidateSet("ok", "mismatch", "error")][string]$Status,
    [int]$WholesaleMatched = 0,
    [int]$RetailMatched = 0,
    [int]$MismatchCount = 0,
    [int]$MissingCount = 0,
    [string]$Message = "",
    [string]$EnvFile = "$PSScriptRoot\.env"
)

try {
    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
            $parts = $_ -split '=', 2
            $name = $parts[0].Trim()
            $value = ($parts[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($name, $value)
        }
    }

    $url = if ($env:SUPABASE_URL) { $env:SUPABASE_URL.TrimEnd('/') } else { "https://dyxbirfpxeocqffnfdeb.supabase.co" }
    # inventory_reports.created_by معرّف NOT NULL، ومفتاح الخدمة لا يحمل هوية مستخدم،
    # فالرفع به كان يفشل بالخطأ 23502. نفضّل الدخول بحساب المزامنة مثل بقية سكربتات الرفع.
    $apiKey = $null
    $token = $null
    $createdBy = $null
    if (-not ($env:TOBACCO_SUPABASE_PUBLIC_KEY -and $env:TOBACCO_SYNC_EMAIL -and $env:TOBACCO_SYNC_PASSWORD)) {
        $apiKey = $env:SUPABASE_SERVICE_KEY
        $token = $apiKey
    }
    if (-not $apiKey) {
        $apiKey = $env:TOBACCO_SUPABASE_PUBLIC_KEY
        $email = $env:TOBACCO_SYNC_EMAIL
        $pass = $env:TOBACCO_SYNC_PASSWORD
        if (-not ($apiKey -and $email -and $pass)) { throw "missing_supabase_credentials" }
        $authBody = @{ email = $email; password = $pass } | ConvertTo-Json
        $auth = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" `
            -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
            -Body ([Text.Encoding]::UTF8.GetBytes($authBody)) -TimeoutSec 20
        $token = $auth.access_token
        $createdBy = $auth.user.id
        if (-not $token) { throw "authentication_failed" }
    }

    $statusPayload = @{
        status = $Status
        checked_at = (Get-Date).ToUniversalTime().ToString("o")
        wholesale_matched = $WholesaleMatched
        retail_matched = $RetailMatched
        mismatch_count = $MismatchCount
        missing_count = $MissingCount
        message = $Message
    }
    $body = @{
        report_date = (Get-Date).ToString("yyyy-MM-dd")
        source = "ameen_price_sync_status"
        summary = $statusPayload
        items = @()
        created_by = $createdBy
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$url/rest/v1/inventory_reports" -Headers @{
        apikey = $apiKey
        Authorization = "Bearer $token"
        "Content-Profile" = "public"
        Prefer = "return=minimal"
    } -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
    Write-Host "PRICE-SYNC-STATUS OK ($Status)" -ForegroundColor Green
    exit 0
} catch {
    Write-Host "PRICE-SYNC-STATUS FAILED: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
