# ============================================================
# push-khalil-audit-log.ps1
# يقرأ log000 في الأمين (event-driven، مصدر التدقيق الحقيقي عبر triggers
# داخل الأمين نفسه) مُصفّىً على UserGUID خليل فقط، ويرفع كل حدث إلى
# khalil_audit_events في Supabase عبر record_khalil_audit_event (idempotent،
# cursor آمن ضد تساوي LogTime). الإشعار إلى تيليجرام يتم تلقائياً من داخل
# قاعدة البيانات (trigger على khalil_audit_events) — هذا السكربت لا يستدعي
# notify_telegram مباشرة إطلاقاً.
#
# لا يكتب هذا السكربت أي شيء إلى قاعدة الأمين — قراءة فقط (SELECT). لا
# يُعدَّل هنا أي صلاحية لخليل داخل الأمين بأي شكل.
#
# ضمان "لا يتحرك cursor بعد آخر حدث غير مؤكد": التقدّم يتم داخل
# record_khalil_audit_event نفسها لكل صف على حدة (transactional)، والحلقة
# هنا تتوقف فوراً عند أول فشل استدعاء RPC دون معالجة أي صف لاحق — فتبقى
# القيمة الحيّة في khalil_audit_cursor عند آخر صف تم تأكيده فعلياً بالخادم.
# ============================================================
param(
    [switch]$DryRun,
    [int]$BatchSize = 200,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\khalil-audit-push.log"
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
            -Message $Message -EventType "sync_failure" -DedupeKey "winfail:push-khalil-audit-log" `
            -DedupeMinutes 60 -EnvFile $EnvFile
    } catch { }
}

# GUID خليل الحقيقي في us000 (Number=5, LoginName='خليل'). ثابت مقصود —
# الفلترة على SQL Server هنا + الحارس المطابق داخل record_khalil_audit_event
# في Supabase يمنعان معاً نسب أي حدث لمستخدم آخر لسجل خليل.
$KHALIL_USER_GUID = "9A5FE33A-720C-493B-8A13-CE33EE5A008E"
# إن كان الـcursor فارغاً (أول تشغيل)، لا نستورد كامل تاريخ log000 — نبدأ من
# نافذة خلفية محدودة (بالساعات) قابلة للضبط عبر KHALIL_AUDIT_BACKFILL_HOURS.
$backfillHours = Get-Setting "KHALIL_AUDIT_BACKFILL_HOURS"
if (-not $backfillHours) { $backfillHours = 24 }

$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "ERROR: AMEEN_SQL_CONNECTION_STRING missing."; exit 1 }
if (-not $apiKey -or -not $syncEmail -or -not $syncPassword) {
    Write-Log "ERROR: Supabase sync credentials missing."
    exit 1
}

function Get-XmlTotal([string]$xml) {
    if (-not $xml) { return $null }
    $m = [regex]::Match($xml, '<Total>\s*(-?[0-9]+(\.[0-9]+)?)\s*</Total>')
    if (-not $m.Success) { return $null }
    $v = 0.0
    if ([double]::TryParse($m.Groups[1].Value, [ref]$v)) { return $v }
    return $null
}

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # ---- المصادقة على Supabase كهوية المزامنة الموثوقة ----
    $authBody = @{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress
    $auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes($authBody)) -TimeoutSec 20
    if (-not $auth.access_token) { throw "Sync user login failed." }

    $headers = @{
        apikey = $apiKey
        Authorization = "Bearer $($auth.access_token)"
        "Accept-Profile" = "public"
        "Content-Profile" = "public"
        Prefer = "return=representation"
    }

    # ---- قراءة الـcursor الحالي (last_log_time, last_log_guid) ----
    $cursorResp = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/get_khalil_audit_cursor" `
        -Headers $headers -ContentType "application/json; charset=utf-8" `
        -Body ([Text.Encoding]::UTF8.GetBytes("{}")) -TimeoutSec 20

    $cursorTime = $null
    $cursorGuid = $null
    if ($cursorResp -and $cursorResp.Count -gt 0) {
        if ($cursorResp[0].last_log_time) { $cursorTime = [datetime]$cursorResp[0].last_log_time }
        if ($cursorResp[0].last_log_guid) { $cursorGuid = [string]$cursorResp[0].last_log_guid }
    }

    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 60
    $cmd.CommandText = @"
SELECT TOP (@BatchSize)
    GUID, LogTime, UserGUID, Computer, Operation, OperationType,
    RecGUID, RecNum, TypeGUID, RecContent
FROM log000
WHERE UserGUID = @UserGuid
  AND (
        @CursorTime IS NULL
        OR LogTime > @CursorTime
        OR (LogTime = @CursorTime AND GUID > @CursorGuid)
      )
  AND (@CursorTime IS NOT NULL OR LogTime >= @BackfillFrom)
ORDER BY LogTime ASC, GUID ASC
"@
    $cmd.Parameters.AddWithValue("@BatchSize", $BatchSize) | Out-Null
    $cmd.Parameters.AddWithValue("@UserGuid", [guid]$KHALIL_USER_GUID) | Out-Null
    if ($cursorTime) { $cmd.Parameters.AddWithValue("@CursorTime", $cursorTime) | Out-Null }
    else { $cmd.Parameters.AddWithValue("@CursorTime", [DBNull]::Value) | Out-Null }
    if ($cursorGuid) { $cmd.Parameters.AddWithValue("@CursorGuid", [guid]$cursorGuid) | Out-Null }
    else { $cmd.Parameters.AddWithValue("@CursorGuid", [DBNull]::Value) | Out-Null }
    $cmd.Parameters.AddWithValue("@BackfillFrom", (Get-Date).AddHours(-1 * [double]$backfillHours)) | Out-Null

    $reader = $cmd.ExecuteReader()
    $rows = @()
    while ($reader.Read()) {
        $rows += [PSCustomObject]@{
            Guid          = [string]$reader["GUID"]
            LogTime       = [datetime]$reader["LogTime"]
            UserGuid      = [string]$reader["UserGUID"]
            Computer      = if ($reader["Computer"] -is [DBNull]) { $null } else { [string]$reader["Computer"] }
            Operation     = if ($reader["Operation"] -is [DBNull]) { $null } else { [string]$reader["Operation"] }
            OperationType = if ($reader["OperationType"] -is [DBNull]) { $null } else { [int]$reader["OperationType"] }
            RecGuid       = if ($reader["RecGUID"] -is [DBNull]) { $null } else { [string]$reader["RecGUID"] }
            RecNum        = if ($reader["RecNum"] -is [DBNull]) { $null } else { [string]$reader["RecNum"] }
            TypeGuid      = if ($reader["TypeGUID"] -is [DBNull]) { $null } else { [string]$reader["TypeGUID"] }
            RecContent    = if ($reader["RecContent"] -is [DBNull]) { $null } else { [string]$reader["RecContent"] }
        }
    }
    $reader.Close()

    Write-Log ("Found {0} new log000 row(s) for Khalil." -f $rows.Count)
    if ($rows.Count -eq 0) { $conn.Close(); exit 0 }

    if ($DryRun) {
        $rows | Format-Table Guid, LogTime, Operation, RecNum -AutoSize
        $conn.Close()
        exit 0
    }

    $beforeCmd = $conn.CreateCommand()
    $beforeCmd.CommandTimeout = 30
    $beforeCmd.CommandText = @"
SELECT TOP 1 RecContent
FROM log000
WHERE RecNum = @RecNum AND TypeGUID = @TypeGuid AND LogTime < @LogTime
ORDER BY LogTime DESC
"@
    $pRecNum = $beforeCmd.Parameters.Add("@RecNum", [Data.SqlDbType]::NVarChar, 100)
    $pTypeGuid = $beforeCmd.Parameters.Add("@TypeGuid", [Data.SqlDbType]::UniqueIdentifier)
    $pLogTime = $beforeCmd.Parameters.Add("@LogTime", [Data.SqlDbType]::DateTime)

    $processed = 0
    foreach ($row in $rows) {
        $beforeXml = $null
        if ($row.RecNum -and $row.TypeGuid) {
            $pRecNum.Value = $row.RecNum
            $pTypeGuid.Value = [guid]$row.TypeGuid
            $pLogTime.Value = $row.LogTime
            $br = $beforeCmd.ExecuteReader()
            if ($br.Read() -and -not ($br["RecContent"] -is [DBNull])) { $beforeXml = [string]$br["RecContent"] }
            $br.Close()
        }
        $afterXml = $row.RecContent

        $beforeTotal = Get-XmlTotal $beforeXml
        $afterTotal = Get-XmlTotal $afterXml
        $financialDelta = $null
        if ($null -ne $beforeTotal -and $null -ne $afterTotal) {
            $financialDelta = [math]::Round($afterTotal - $beforeTotal, 4)
        }

        $payload = @{
            p_ameen_log_guid     = $row.Guid
            p_ameen_log_time     = $row.LogTime.ToString("yyyy-MM-ddTHH:mm:ss.fffffff")
            p_ameen_user_guid    = $row.UserGuid
            p_ameen_user_login   = "خليل"
            p_device             = $row.Computer
            p_operation          = $row.Operation
            p_operation_type     = $row.OperationType
            p_rec_num            = $row.RecNum
            p_type_guid          = $row.TypeGuid
            p_invoice_number     = $row.RecNum
            p_invoice_guid       = $row.RecGuid
            p_before_snapshot    = if ($beforeXml) { @{ xml = $beforeXml } } else { $null }
            p_after_snapshot     = if ($afterXml) { @{ xml = $afterXml } } else { $null }
            p_financial_delta    = $financialDelta
            p_notes              = $null
        } | ConvertTo-Json -Depth 8 -Compress

        try {
            Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/rpc/record_khalil_audit_event" `
                -Headers $headers -ContentType "application/json; charset=utf-8" `
                -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 30 | Out-Null
            $processed++
        } catch {
            # توقف فوري عند أول فشل: الـcursor في Supabase يبقى عند آخر حدث
            # تم تأكيده فعلاً (record_khalil_audit_event لم تُقدِّمه لهذا
            # الصف الفاشل)، فالتشغيل التالي يعيد محاولة هذا الصف نفسه ولا
            # يخسر أي حدث لاحق أيضاً لأنه لم يُرسَل بعد.
            Write-Log ("ERROR on GUID $($row.Guid): " + $_.Exception.Message)
            $conn.Close()
            Notify-Failure ("🚨 فشل رفع حدث تدقيق خليل (GUID: $($row.Guid))`n" + $_.Exception.Message)
            exit 1
        }
    }

    $conn.Close()
    Write-Log ("Pushed $processed / $($rows.Count) Khalil audit event(s) successfully.")
    exit 0
} catch {
    Write-Log ("ERROR: " + $_.Exception.Message)
    Notify-Failure ("🚨 فشل سكربت مزامنة تدقيق خليل`n" + $_.Exception.Message)
    exit 1
}
