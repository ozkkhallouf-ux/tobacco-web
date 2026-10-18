# ============================================================================
# publish-price-sync-heartbeat.ps1 — نبض مزامنة الأسعار (الموقع ← الأمين)
#
# يكتب صفاً في inventory_reports بالمصدر ameen_price_sync_heartbeat بنوعين:
#   -Mode Attempt    من sync-approved-prices-to-ameen.ps1 في **كل** تشغيل، ناجحاً أو فاشلاً
#                    (ameen_price_sync_status القديم لا يُكتب إلا بعد فحص الأسعار، فيتقادم
#                    آخر «ok» بصمت عند الفشل أو التعطيل — حادثة 2026-10-18).
#   -Mode TaskProbe  من ensure-ameen-sync.ps1 (Sync Watchdog): حالة المهمة المجدولة نفسها،
#                    لأن المهمة المعطّلة لا تكتب شيئاً فلا يُكتشف التعطيل إلا من خارجها.
#                    يُنشر فوراً إن كانت المهمة معطّلة أو مفقودة، وإلا مرة كل 30 دقيقة.
#
# قراءة فقط على Windows Task Scheduler (Get-ScheduledTask). لا اتصال بالأمين هنا إطلاقاً.
# Best-effort: يخرج دائماً بالرمز 0 كي لا يكسر سلسلة المزامنة؛ النتيجة في سطر
# «PRICE-SYNC-HEARTBEAT …». المصنِّف: src/price-sync-health.js
# التوثيق: docs/ai/topics/price-sync-heartbeat.md
# ============================================================================
param(
    [ValidateSet("Attempt", "TaskProbe")][string]$Mode = "Attempt",
    [ValidateSet("applied", "pull_failed", "ameen_unreachable", "apply_failed", "verify_failed",
                 "verify_mismatch", "applied_with_conflicts", "preview_only")]
    [string]$Outcome = "applied",
    [string]$StageFailed = "",
    [string]$AttemptStartedAt = "",
    [switch]$AmeenContact,
    [int]$SentCount = -1,
    [int]$AppliedWholesale = -1,
    [int]$AppliedRetail = -1,
    [int]$Skipped = -1,
    [int]$NotInAmeen = -1,
    [int]$ConflictCount = -1,
    [int]$WholesaleMatched = -1,
    [int]$RetailMatched = -1,
    [int]$Mismatches = -1,
    [int]$Missing = -1,
    [string]$PricesFingerprint = "",
    [string]$Message = "",
    [string]$TaskName = "TOBACCO Approved Prices Pull",
    [int]$ProbeEveryMinutes = 30,
    [string]$StateFile = "$PSScriptRoot\logs\price-sync-heartbeat-state.json",
    [string]$EnvFile = "$PSScriptRoot\.env",
    # للاختبار: حالة المهمة بصيغة JSON بدل Get-ScheduledTask، ووقت ثابت، وكتابة الحمولة بلا نشر.
    [string]$TaskInfoJson = "",
    [string]$Now = "",
    [switch]$DryRun,
    [string]$ResultFile = ""
)

$ErrorActionPreference = "Stop"
$source = "ameen_price_sync_heartbeat"
$schema = "price-sync-heartbeat/v1"

function Get-NowUtc {
    if ($Now) { return ([DateTime]::Parse($Now, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)) }
    return (Get-Date).ToUniversalTime()
}

function ConvertTo-IsoUtc($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [DateTime]) {
        if ($Value.Year -lt 2000) { return $null }   # LastRunTime الحارس حين لم تعمل المهمة قط
        return $Value.ToUniversalTime().ToString("o")
    }
    $text = [string]$Value
    if (-not $text) { return $null }
    return $text
}

function Read-State {
    $state = [ordered]@{ last_success_at = $null; last_failure_at = $null; last_success_fingerprint = $null; last_probe_published_at = $null }
    if ($StateFile -and (Test-Path -LiteralPath $StateFile)) {
        try {
            $loaded = Get-Content -Raw -LiteralPath $StateFile -Encoding UTF8 | ConvertFrom-Json
            foreach ($key in @($state.Keys)) {
                if ($loaded.PSObject.Properties.Name -contains $key) {
                    # PowerShell 7 يحوّل نصوص ISO إلى DateTime عند ConvertFrom-Json؛ نعيدها نصاً UTC موحّداً.
                    $value = $loaded.$key
                    $state[$key] = $(if ($value -is [DateTime]) { $value.ToUniversalTime().ToString("o") } else { $value })
                }
            }
        } catch { }   # حالة تالفة = نبدأ من جديد؛ لا نخترع نجاحاً سابقاً
    }
    return $state
}

function Write-State($State) {
    if (-not $StateFile) { return }
    $dir = Split-Path -Parent $StateFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = $State | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($StateFile, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-TaskSnapshot {
    if ($TaskInfoJson) {
        $fake = $TaskInfoJson | ConvertFrom-Json
        return [ordered]@{
            name = $TaskName
            exists = [bool]$fake.exists
            enabled = [bool]$fake.enabled
            state = [string]$fake.state
            last_run_time = $fake.last_run_time
            last_result = $fake.last_result
            next_run_time = $fake.next_run_time
        }
    }
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $task = $null }
    if (-not $task) {
        return [ordered]@{ name = $TaskName; exists = $false; enabled = $false; state = "Missing"; last_run_time = $null; last_result = $null; next_run_time = $null }
    }
    $info = $null
    try { $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop } catch { $info = $null }
    return [ordered]@{
        name = $TaskName
        exists = $true
        enabled = [bool]$task.Settings.Enabled
        state = [string]$task.State
        last_run_time = $(if ($info) { ConvertTo-IsoUtc $info.LastRunTime } else { $null })
        last_result = $(if ($info) { [int64]$info.LastTaskResult } else { $null })
        next_run_time = $(if ($info) { ConvertTo-IsoUtc $info.NextRunTime } else { $null })
    }
}

function Optional-Int([int]$Value) { if ($Value -lt 0) { return $null } else { return $Value } }

function Get-SupabaseAuth {
    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
            $parts = $_ -split '=', 2
            $name = $parts[0].Trim()
            $value = ($parts[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($name, $value)
        }
    }
    $url = if ($env:SUPABASE_URL) { $env:SUPABASE_URL.TrimEnd('/') } else { "https://dyxbirfpxeocqffnfdeb.supabase.co" }
    # نفس منطق publish-price-sync-status.ps1: inventory_reports.created_by يحتاج هوية مستخدم،
    # فنفضّل حساب المزامنة؛ ومفتاح الخدمة احتياط فقط.
    $apiKey = $null; $token = $null; $createdBy = $null
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
    return @{ Url = $url; ApiKey = $apiKey; Token = $token; CreatedBy = $createdBy }
}

function Publish-Summary($Summary, $NowUtc) {
    $damascusDate = $NowUtc.AddHours(3).ToString("yyyy-MM-dd")   # دمشق UTC+3 ثابت منذ 2022
    if ($DryRun) {
        $json = [ordered]@{ report_date = $damascusDate; source = $source; summary = $Summary; items = @() } | ConvertTo-Json -Depth 8 -Compress
        if ($ResultFile) { [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding($false))) }
        return "DRYRUN"
    }
    $auth = Get-SupabaseAuth
    $body = [ordered]@{
        report_date = $damascusDate
        source = $source
        summary = $Summary
        items = @()
        created_by = $auth.CreatedBy
    } | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$($auth.Url)/rest/v1/inventory_reports" -Headers @{
        apikey = $auth.ApiKey
        Authorization = "Bearer $($auth.Token)"
        "Content-Profile" = "public"
        Prefer = "return=minimal"
    } -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
    return "OK"
}

try {
    $nowUtc = Get-NowUtc
    $nowIso = $nowUtc.ToString("o")
    $state = Read-State
    $task = Get-TaskSnapshot
    $hostName = [Environment]::MachineName

    if ($Mode -eq "TaskProbe") {
        $unhealthy = (-not $task.exists) -or (-not $task.enabled) -or ([string]$task.state -eq "Disabled")
        $due = $true
        if (-not $unhealthy -and $state.last_probe_published_at) {
            try {
                $last = [DateTime]::Parse([string]$state.last_probe_published_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
                $due = (($nowUtc - $last).TotalMinutes -ge $ProbeEveryMinutes)
            } catch { $due = $true }
        }
        if (-not $due) {
            Write-Output "PRICE-SYNC-HEARTBEAT SKIPPED (task_probe throttled)"
            exit 0
        }
        $summary = [ordered]@{
            schema = $schema
            kind = "task_probe"
            host = $hostName
            probed_at = $nowIso
            task = $task
        }
        $result = Publish-Summary $summary $nowUtc
        $state.last_probe_published_at = $nowIso
        Write-State $state
        Write-Output "PRICE-SYNC-HEARTBEAT $result (task_probe enabled=$($task.enabled) state=$($task.state))"
        exit 0
    }

    # ---------- Attempt ----------
    $finalOutcome = $Outcome
    $pricesChanged = $null
    if ($PricesFingerprint -and $state.last_success_fingerprint) {
        $pricesChanged = ([string]$state.last_success_fingerprint -ne $PricesFingerprint)
    }
    # «لا أسعار جديدة»: نجاح كامل مثبت بالفحص، والبصمة السعرية مطابقة لآخر نجاح.
    if ($Outcome -eq "applied" -and $pricesChanged -eq $false) { $finalOutcome = "no_changes" }

    $success = @("applied", "no_changes") -contains $finalOutcome
    if ($success) {
        $state.last_success_at = $nowIso
        if ($PricesFingerprint) { $state.last_success_fingerprint = $PricesFingerprint }
    } else {
        $state.last_failure_at = $nowIso
    }
    # الحالة المحلية تُحدَّث حتى لو فشل النشر: هي ذاكرة الناشر عن آخر نجاح/فشل فعلي.
    Write-State $state

    $verify = [ordered]@{
        wholesale_matched = Optional-Int $WholesaleMatched
        retail_matched = Optional-Int $RetailMatched
        mismatches = Optional-Int $Mismatches
        missing = Optional-Int $Missing
    }
    $summary = [ordered]@{
        schema = $schema
        kind = "attempt"
        host = $hostName
        attempt_started_at = $(if ($AttemptStartedAt) { $AttemptStartedAt } else { $nowIso })
        attempt_finished_at = $nowIso
        outcome = $finalOutcome
        stage_failed = $(if ($StageFailed) { $StageFailed } else { $null })
        ameen_contact_at = $(if ($AmeenContact) { $nowIso } else { $null })
        sent_count = Optional-Int $SentCount
        applied_wholesale = Optional-Int $AppliedWholesale
        applied_retail = Optional-Int $AppliedRetail
        skipped = Optional-Int $Skipped
        not_in_ameen = Optional-Int $NotInAmeen
        conflict_count = Optional-Int $ConflictCount
        verify = $verify
        prices_fingerprint = $(if ($PricesFingerprint) { $PricesFingerprint } else { $null })
        prices_changed = $pricesChanged
        last_success_at = $state.last_success_at
        last_failure_at = $state.last_failure_at
        task = $task
        message = $Message
    }
    $result = Publish-Summary $summary $nowUtc
    Write-Output "PRICE-SYNC-HEARTBEAT $result (attempt outcome=$finalOutcome)"
    exit 0
} catch {
    Write-Output "PRICE-SYNC-HEARTBEAT FAILED: $($_.Exception.Message)"
    exit 0
}
