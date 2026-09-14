param(
    [switch]$Apply,
    [int]$MinimumIntervalMinutes = 0,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\supplier-obligations-push.log",
    [string]$MarkerPath = "$PSScriptRoot\logs\supplier-obligations-last-success.txt"
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

# ============================================================================
# قرار الاستبدال — دالة نقية بلا شبكة ولا قاعدة بيانات، كي تُختبر مباشرة.
#
# ثلاث حالات لا رابع لها:
#   1) القراءة لم تُرجع أي مورد مرتبط بفواتير شراء ⇒ الاستعلام نفسه مشبوه، لا
#      حقيقة محاسبية. إجهاض مطلق، ولا عَلَم يتجاوزه.
#   2) القراءة أرجعت موردين وكلهم مسدَّدون ⇒ حالة نهائية **مُتحقَّقة**: الحمولة
#      الفارغة هنا حقيقة لا عطل. رفضها كان يُبقي دَيناً على من سدّد إلى الأبد
#      (ملاحظة Codex P1، صحيحة). يُؤذَن بالتفريغ لأن القراءة المصدرية نفسها
#      تحقَّقت — لا لأن أحداً مرّر عَلَماً.
#   3) القراءة أرجعت موردين وبعضهم مدين ⇒ استبدال عادي بحمولة غير فارغة.
#
# الإذن مشتقّ من دليل، لا من مفتاح سطر أوامر. لهذا حُذف -AllowEmpty: عَلَم لا
# يغيّر أي نتيجة يوهم بحماية غير موجودة، والحماية الحقيقية هي الحالة (1).
# ============================================================================
function Get-SupplierObligationsPlan {
    param(
        [AllowEmptyCollection()][object[]]$AllRows = @(),
        [AllowEmptyCollection()][object[]]$PayableRows = @()
    )

    if ($AllRows.Count -eq 0) {
        return [PSCustomObject]@{
            Action     = "abort"
            AllowEmpty = $false
            Reason     = "the Ameen read returned no purchase-linked suppliers at all. Refusing to touch Supabase."
        }
    }

    if ($PayableRows.Count -eq 0) {
        return [PSCustomObject]@{
            Action     = "replace"
            AllowEmpty = $true
            Reason     = "verified terminal state: all $($AllRows.Count) purchase-linked suppliers are settled."
        }
    }

    return [PSCustomObject]@{
        Action     = "replace"
        AllowEmpty = $false
        Reason     = "$($PayableRows.Count) of $($AllRows.Count) purchase-linked suppliers carry a positive payable balance."
    }
}

# ============================================================================
# استبدال ذرّي واحد عبر replace_supplier_obligations.
#
# لا حذف منفصل قبل الإدراج: الدالة تُدرج الجيل الحالي وتحذف ما ليس فيه داخل
# معاملة واحدة، فلا توجد لحظة يكون فيها الجدول فارغاً — وهي النافذة التي كان
# انقطاع الشبكة داخلها يترك الالتزامات ممسوحة.
#
# الحمولة تُرسَل دفعة واحدة عمداً: تقسيمها إلى دفعات يكسر الذرّية نفسها، لأن كل
# نداء يحذف ما ليس في دفعته هو.
# ============================================================================
function ConvertTo-ReplacePayloadJson {
    param(
        [string]$Source,
        [AllowEmptyCollection()][object[]]$Rows = @(),
        [bool]$AllowEmpty
    )

    # Windows PowerShell 5.1 يفكّ المصفوفة أحادية العنصر عند التحويل فينتج كائن
    # لا مصفوفة، فيرفضه jsonb_typeof(p_rows) = 'array'. البناء الصريح يمنع ذلك.
    if ($Rows.Count -eq 0) {
        $rowsJson = "[]"
    } else {
        $rowsJson = ConvertTo-Json -InputObject @($Rows) -Depth 5 -Compress
        if (-not $rowsJson.StartsWith("[")) { $rowsJson = "[$rowsJson]" }
    }

    $sourceJson = ConvertTo-Json -InputObject $Source -Compress
    $allowJson = if ($AllowEmpty) { "true" } else { "false" }
    return '{"p_source":' + $sourceJson + ',"p_allow_empty":' + $allowJson + ',"p_rows":' + $rowsJson + '}'
}

$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { throw "AMEEN_SQL_CONNECTION_STRING is missing." }
if ($Apply -and (-not $apiKey -or -not $syncEmail -or -not $syncPassword)) {
    throw "Supabase sync credentials are missing."
}

$PURCHASE_TYPE_GUID = "91377a56-ebfc-48c0-b79e-72063e1d7e3a"
$SOURCE = "ameen_ac000_credit_minus_debit"
$LEGACY_SOURCE = "ameen_cu000_credit_minus_debit"
$REPLACE_RPC = "replace_supplier_obligations"

if ($Apply -and $MinimumIntervalMinutes -gt 0 -and (Test-Path -LiteralPath $MarkerPath)) {
    $lastSuccess = (Get-Item -LiteralPath $MarkerPath).LastWriteTimeUtc
    if ($lastSuccess -gt (Get-Date).ToUniversalTime().AddMinutes(-$MinimumIntervalMinutes)) {
        Write-Log "Skipped: supplier balances are still fresh."
        exit 0
    }
}

$sql = @"
SELECT
    CONVERT(nvarchar(36), c.GUID) AS supplier_key,
    c.CustomerName AS supplier_name,
    CAST(a.Debit AS float) AS debit_total,
    CAST(a.Credit AS float) AS credit_total,
    CAST(a.Credit - a.Debit AS float) AS net_supplier_balance,
    MAX(CAST(u.Date AS date)) AS last_purchase_date
FROM cu000 c
JOIN ac000 a
  ON a.GUID = c.AccountGUID
JOIN bu000 u
  ON u.CustGUID = c.GUID
 AND u.TypeGUID = '$PURCHASE_TYPE_GUID'
WHERE ISNULL(c.bHide, 0) = 0
  AND NULLIF(LTRIM(RTRIM(c.CustomerName)), N'') IS NOT NULL
GROUP BY c.GUID, c.CustomerName, a.Debit, a.Credit
ORDER BY net_supplier_balance DESC, c.CustomerName;
"@

Write-Log "Reading supplier balances from Ameen ac000 base-currency accounts..."

Add-Type -AssemblyName "System.Data"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = $sql
$cmd.CommandTimeout = 120
$reader = $cmd.ExecuteReader()

$allRows = @()
while ($reader.Read()) {
    $net = [double]$reader["net_supplier_balance"]
    $allRows += [PSCustomObject]@{
        supplier_key = "$($reader['supplier_key'])"
        supplier_name = "$($reader['supplier_name'])"
        debit_total = [double]$reader["debit_total"]
        credit_total = [double]$reader["credit_total"]
        amount_due = [Math]::Max(0, $net)
        last_purchase_date = if ($reader["last_purchase_date"] -is [DBNull]) { $null } else { ([datetime]$reader["last_purchase_date"]).ToString("yyyy-MM-dd") }
    }
}
$reader.Close()
$conn.Close()

$rows = @($allRows | Where-Object { $_.amount_due -gt 0 })
Write-Log "Found $($allRows.Count) purchase-linked suppliers; $($rows.Count) have a positive payable balance."

$plan = Get-SupplierObligationsPlan -AllRows $allRows -PayableRows $rows
if ($plan.Action -eq "abort") {
    Write-Log "ABORT: $($plan.Reason)"
    throw "Supplier read returned zero rows; existing Supabase data was left untouched."
}
Write-Log "Replacement plan: $($plan.Reason)"
if ($plan.AllowEmpty) {
    Write-Log "WARNING: publishing an EMPTY generation for $SOURCE. Every supplier row for this source will be removed atomically."
}

if (-not $Apply) {
    Write-Host "=== DRY RUN: top supplier obligations ===" -ForegroundColor Yellow
    $rows | Sort-Object amount_due -Descending | Select-Object -First 20 supplier_name, debit_total, credit_total, amount_due, last_purchase_date | Format-Table -AutoSize
    Write-Log "DryRun only. Re-run with -Apply to upload."
    exit 0
}

Write-Log "Authenticating sync user..."
$authBody = @{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json
$auth = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $apiKey; Accept = "application/json" } `
    -ContentType "application/json; charset=utf-8" -Body $authBody
$token = $auth.access_token
$headers = @{
    apikey = $apiKey
    Authorization = "Bearer $token"
    "Accept-Profile" = "public"
    "Content-Profile" = "public"
}

$generatedAt = (Get-Date).ToUniversalTime().ToString("o")
# source وupdated_at لا يُرسلان: الدالة تضبطهما بنفسها داخل المعاملة، فإرسالهما
# يفتح باب جيل يحمل مصدراً مخالفاً لما طُلب استبداله.
$payload = @($rows | ForEach-Object {
    [PSCustomObject]@{
        supplier_key = $_.supplier_key
        supplier_name = $_.supplier_name
        amount_due = [Math]::Round($_.amount_due, 3)
        currency = "USD"
        due_date = $null
        strategic_weight = 1.0
        supply_risk = "normal"
        notes = "Ameen ac000 base-currency balance: Credit - Debit; last purchase $($_.last_purchase_date); synced $generatedAt"
    }
})

function Invoke-ReplaceGeneration {
    param([string]$Source, [AllowEmptyCollection()][object[]]$Rows = @(), [bool]$AllowEmpty)

    $body = ConvertTo-ReplacePayloadJson -Source $Source -Rows $Rows -AllowEmpty $AllowEmpty
    try {
        return Invoke-RestMethod -Method Post `
            -Uri "$supabaseUrl/rest/v1/rpc/$REPLACE_RPC" `
            -Headers $headers `
            -ContentType "application/json; charset=utf-8" `
            -TimeoutSec 120 `
            -Body ([Text.Encoding]::UTF8.GetBytes($body))
    } catch {
        $detail = $_.Exception.Message
        try {
            $stream = $_.Exception.Response.GetResponseStream()
            if ($stream) { $detail = (New-Object IO.StreamReader($stream)).ReadToEnd() }
        } catch { }
        if ($detail -match "PGRST202" -or $detail -match "Could not find the function") {
            throw "The atomic replacement function public.$REPLACE_RPC is missing on this project. Apply supabase/proposed/03-supplier-obligations-unique-key.sql before running this producer. Nothing was written."
        }
        throw "Atomic replacement failed for source '$Source': $detail"
    }
}

Write-Log "Replacing generation for $SOURCE with $($payload.Count) row(s) in a single atomic call."
$result = Invoke-ReplaceGeneration -Source $SOURCE -Rows $payload -AllowEmpty $plan.AllowEmpty
$storedCount = if ($result -is [array]) { $result[0].row_count } else { $result.row_count }
Write-Log "Atomic replacement committed: $storedCount row(s) now stored for $SOURCE."

# المصدر القديم يُصفَّر **بعد** نجاح الجيل الحالي وحده: لو فشل ما سبق لبقيت
# صفوفه في مكانها بدل أن يُترك الجدول بلا أي التزام.
Write-Log "Retiring legacy source $LEGACY_SOURCE."
Invoke-ReplaceGeneration -Source $LEGACY_SOURCE -Rows @() -AllowEmpty $true | Out-Null

$markerDir = Split-Path -Parent $MarkerPath
if (-not (Test-Path -LiteralPath $markerDir)) { New-Item -ItemType Directory -Force -Path $markerDir | Out-Null }
(Get-Date).ToUniversalTime().ToString("o") | Set-Content -LiteralPath $MarkerPath -Encoding UTF8
Write-Log "Supplier obligations upload completed successfully: $($payload.Count) suppliers."
