# ينشر نبضة مزامنة الأسعار في public.price_sync_heartbeat عبر الدالة
# record_price_sync_heartbeat (supabase/proposed/16-price-sync-heartbeat.sql).
# يستدعيه sync-approved-prices-to-ameen.ps1 في كل محاولة، نجاحاً أو فشلاً.
# ويمكن أن يستدعيه طرف خارجي بـ-Status disabled أو paused مع -Message.
#
# best-effort: لا يرمي استثناء، ولا يؤثر رمز خروجه على رمز خروج المهمة.
# لا يتصل بالأمين إطلاقاً: يكتب في Supabase وحده، بحساب المزامنة.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ok", "mismatch", "pull_failed", "apply_failed", "verify_failed", "disabled", "paused")]
    [string]$Status,
    [ValidateSet("pull", "apply", "verify", "done", "external")][string]$Stage = "external",
    [string]$AttemptStartedAt = "",
    [int]$PulledCount = 0,
    [string]$FeedMaxUpdatedAt = "",
    [int]$AppliedWholesale = 0,
    [int]$AppliedRetail = 0,
    [int]$SkippedCount = 0,
    [int]$NotFoundCount = 0,
    [int]$ConflictCount = 0,
    [int]$VerifiedWholesale = 0,
    [int]$VerifiedRetail = 0,
    [int]$MismatchCount = 0,
    [int]$MissingCount = 0,
    [switch]$Applied,
    [switch]$AmeenConnected,
    [string]$Message = "",
    [string]$EnvFile = "$PSScriptRoot\.env",
    # للاختبار فقط: يكتب الحمولة JSON في هذا الملف بدل الإرسال.
    [string]$CaptureFile = ""
)

try {
    $payload = [ordered]@{
        status = $Status
        stage = $Stage
        attempt_started_at = $AttemptStartedAt
        attempt_finished_at = (Get-Date).ToUniversalTime().ToString("o")
        computer = [string]$env:COMPUTERNAME
        pulled_count = $PulledCount
        feed_max_updated_at = $FeedMaxUpdatedAt
        applied_wholesale = $AppliedWholesale
        applied_retail = $AppliedRetail
        skipped_count = $SkippedCount
        not_found_count = $NotFoundCount
        conflict_count = $ConflictCount
        verified_wholesale = $VerifiedWholesale
        verified_retail = $VerifiedRetail
        mismatch_count = $MismatchCount
        missing_count = $MissingCount
        applied = [bool]$Applied
        ameen_connected = [bool]$AmeenConnected
        message = if ($Message.Length -gt 500) { $Message.Substring(0, 500) } else { $Message }
    }
    $body = @{ p_heartbeat = $payload } | ConvertTo-Json -Compress -Depth 4

    if ($CaptureFile) {
        [IO.File]::WriteAllText($CaptureFile, $body, (New-Object Text.UTF8Encoding($false)))
        Write-Host "PRICE-SYNC-HEARTBEAT CAPTURED ($Status)"
        exit 0
    }

    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
            $parts = $_ -split '=', 2
            $name = $parts[0].Trim()
            $value = ($parts[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($name, $value)
        }
    }

    $url = if ($env:SUPABASE_URL) { $env:SUPABASE_URL.TrimEnd('/') } else { "https://dyxbirfpxeocqffnfdeb.supabase.co" }
    # الدالة تقبل هوية المزامنة الموثوقة وحدها؛ مفتاح الخدمة بلا هوية مستخدم فلا يصلح هنا.
    $apiKey = $env:TOBACCO_SUPABASE_PUBLIC_KEY
    $email = $env:TOBACCO_SYNC_EMAIL
    $pass = $env:TOBACCO_SYNC_PASSWORD
    if (-not ($apiKey -and $email -and $pass)) { throw "missing_sync_account_credentials" }
    $authBody = @{ email = $email; password = $pass } | ConvertTo-Json
    $auth = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($authBody)) -TimeoutSec 15
    $token = $auth.access_token
    if (-not $token) { throw "authentication_failed" }

    Invoke-RestMethod -Method Post -Uri "$url/rest/v1/rpc/record_price_sync_heartbeat" -Headers @{
        apikey = $apiKey
        Authorization = "Bearer $token"
        "Content-Profile" = "public"
    } -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 15 | Out-Null
    Write-Host "PRICE-SYNC-HEARTBEAT OK ($Status)" -ForegroundColor Green
    exit 0
} catch {
    # قبل تطبيق proposed/16 تعيد PostgREST خطأ PGRST202 (الدالة غير موجودة): متوقع ولا يكسر شيئاً.
    Write-Host "PRICE-SYNC-HEARTBEAT FAILED: $($_.Exception.Message)" -ForegroundColor Yellow
    exit 1
}
