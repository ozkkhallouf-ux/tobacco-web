# ============================================================
# push-expense-entries.ps1
# يقرأ حركة مصاريف الصرف (قيود en000 على حسابات المصاريف بشجرة
# الحسابات ac000) من الأمين آخر N يوم، ويرفعها لجدول expense_entries
# بـSupabase. هاد الجدول هو مصدر قسم "دفعات الصرف" بالتقرير المسائي.
#
# اكتُشف حساب "المصاريف" الرئيسي وحساباته الفرعية عبر
# discover-ameen-expense-accounts.ps1 (GUID: 6AE0066F-D39E-4805-83D5-
# B8DA92F7D7F1) — يشمل: مصاريف أبو زياد، تأسيس، سيارة محمد ابراهيم،
# طعام، متفرقة. (مصاريف نقل المشتريات مستثناة عمداً — تحت حساب "صافي
# تكلفة المبيعات" مش حساب مصاريف تشغيلية عام.)
#
# كل تشغيلة: تمسح صفوف نفس نافذة الأيام وترفعها من جديد (idempotent).
#
# تجربة بدون رفع:  .\tools\push-expense-entries.ps1 -DryRun
# تشغيل فعلي:      .\tools\push-expense-entries.ps1
# نافذة أطول:      .\tools\push-expense-entries.ps1 -Days 14
#
# ⚠️ -DryRun (2026-08-31): بعد قراءة الأمين وطباعة أول 10 صفوف، يُجري
# فحص Supabase قراءة فقط (مصادقة حقيقية بنفس TOBACCO_SYNC_EMAIL/PASSWORD
# ثم GET واحد بحد صف واحد) للتأكد أن الرابط والمفتاح والمصادقة صحيحة —
# بلا أي INSERT/UPDATE/DELETE إطلاقاً. يفشل بوضوح (exit 1 + إشعار
# تيليغرام) لو فشلت المصادقة أو الاتصال، فلا تُخفى مشاكل الإعداد خلف
# "نجاح" DryRun ظاهري. اكتُشفت الحاجة لهذا أثناء تحقق حي عبر SSH: كان
# -DryRun يخرج قبل الوصول لسطر مصادقة Supabase إطلاقاً فلا يختبرها مطلقاً.
# ============================================================
param(
    [switch]$DryRun,
    [int]$Days = 7,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\expense-entries-push.log"
)

$ErrorActionPreference = "Stop"

# ترميز الإخراج UTF-8 صراحةً — بدونه، النص العربي (Write-Host/Format-Table)
# يظهر كعلامات استفهام في بعض جلسات PowerShell غير التفاعلية (مثل SSH بدون
# محطة UTF-8 افتراضية). ملفوف بـtry لأن تعيين Console.OutputEncoding قد يرمي
# استثناءً حين لا توجد محطة فعلية (إخراج مُعاد توجيهه بالكامل لملف مثلاً).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

function Write-Log($msg) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    $dir = Split-Path $LogFile -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Notify-Failure($Message) {
    try {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message $Message -EventType "sync_failure" -DedupeKey "winfail:push-expense-entries" -DedupeMinutes 60 `
            -EnvFile $EnvFile
    } catch { }
}

# مصادقة Supabase بنفس بيانات حساب المزامنة — يرمي استثناء واضحاً لو فشلت
# المصادقة أو لم يُرجَع access_token صالح، بدل الفشل الصامت أو المتابعة
# بتوكن فارغ. مستخدَمة في مسار -DryRun (فحص قراءة فقط) وفي الرفع الفعلي.
function Get-SupabaseAuthToken {
    param(
        [Parameter(Mandatory)] [string]$SupabaseUrl,
        [Parameter(Mandatory)] [string]$ApiKey,
        [Parameter(Mandatory)] [string]$Email,
        [Parameter(Mandatory)] [string]$Password
    )
    $authBody = @{ email = $Email; password = $Password } | ConvertTo-Json
    $auth = Invoke-RestMethod -Method Post -Uri "$SupabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $ApiKey; Accept = "application/json" } `
        -ContentType "application/json; charset=utf-8" -Body $authBody
    if (-not $auth.access_token) {
        throw "Supabase Auth لم يُرجع access_token صالحاً — تحقق من TOBACCO_SYNC_EMAIL/TOBACCO_SYNC_PASSWORD."
    }
    return $auth.access_token
}

$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "khata: AMEEN_SQL_CONNECTION_STRING ghyr mwjwd."; exit 1 }
if (-not $supabaseUrl -or -not $apiKey -or -not $syncEmail -or -not $syncPassword) {
    Write-Log "khata: e3dadat Supabase (URL/KEY/SYNC_EMAIL/SYNC_PASSWORD) na2sa."
    exit 1
}

# حساب "المصاريف" الرئيسي — مؤكّد عبر discover-ameen-expense-accounts.ps1
$EXPENSE_PARENT_GUID = "6AE0066F-D39E-4805-83D5-B8DA92F7D7F1"

$sql = @"
SELECT
  CAST(en.Date AS date) AS entry_date,
  a.Name               AS account_name,
  en.Debit             AS amount,
  en.Notes             AS notes
FROM en000 en
JOIN ac000 a ON a.GUID = en.AccountGUID
WHERE a.ParentGUID = '$EXPENSE_PARENT_GUID'
  AND en.Debit > 0
  AND en.Date >= DATEADD(day, -$Days, CAST(GETDATE() AS date))
ORDER BY en.Date DESC
"@

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Log "bd2 sahb haraket masareef akher $Days yom..."

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 120
    $reader = $cmd.ExecuteReader()

    $rows = @()
    while ($reader.Read()) {
        $rows += [PSCustomObject]@{
            entry_date   = ([datetime]$reader['entry_date']).ToString("yyyy-MM-dd")
            account_name = "$($reader['account_name'])"
            amount       = [double]$reader['amount']
            notes        = if ($reader['notes'] -is [DBNull]) { $null } else { "$($reader['notes'])" }
        }
    }
    $reader.Close()
    $conn.Close()

    Write-Log "t2ra2 $($rows.Count) satr masareef."

    if ($rows.Count -eq 0) {
        Write-Log "ma fi satr — khoroj bidoon rafe3."
        exit 0
    }

    if ($DryRun) {
        Write-Host "=== DRY RUN — أول 10 سطور ===" -ForegroundColor Yellow
        $rows | Select-Object -First 10 | Format-Table -AutoSize

        # فحص Supabase قراءة فقط: مصادقة حقيقية ثم GET وحيد بحد صف واحد.
        # لا INSERT ولا UPDATE ولا DELETE في هذا الفرع إطلاقاً — أي فشل هنا
        # (رابط/مفتاح/مصادقة خاطئة) يوقف السكريبت بـexit 1 وإشعار تيليغرام،
        # لا يُكتم أبداً.
        Write-Log "DryRun: فحص مصادقة واتصال Supabase (قراءة فقط)..."
        try {
            $probeToken = Get-SupabaseAuthToken -SupabaseUrl $supabaseUrl -ApiKey $apiKey -Email $syncEmail -Password $syncPassword
            $probeHdr = @{ apikey = $apiKey; Authorization = "Bearer $probeToken"; "Accept-Profile" = "public" }
            Invoke-RestMethod -Method Get `
                -Uri "$supabaseUrl/rest/v1/expense_entries?select=id&limit=1" `
                -Headers $probeHdr | Out-Null
            Write-Log "DryRun: فحص Supabase ناجح — المصادقة والقراءة (owner) تعملان."
        } catch {
            $probeErrMsg = "DryRun: فشل فحص مصادقة/اتصال Supabase — $($_.Exception.Message)"
            Write-Log $probeErrMsg
            Notify-Failure "🚨 فشل فحص DryRun لمصادقة Supabase (push-expense-entries)`n$($_.Exception.Message)"
            exit 1
        }

        Write-Log "DryRun: ma tem raf3 shi (test faqat)."
        exit 0
    }

    $token = Get-SupabaseAuthToken -SupabaseUrl $supabaseUrl -ApiKey $apiKey -Email $syncEmail -Password $syncPassword
    $hdr = @{ apikey = $apiKey; Authorization = "Bearer $token"; "Accept-Profile" = "public"; "Content-Profile" = "public" }

    $cutoff = (Get-Date).AddDays(-$Days).ToString("yyyy-MM-dd")
    Invoke-RestMethod -Method Delete -Uri "$supabaseUrl/rest/v1/expense_entries?entry_date=gte.$cutoff" `
        -Headers ($hdr + @{ Prefer = "return=minimal" }) | Out-Null
    Write-Log "tem masah al-sofoof al-qadima (>= $cutoff)."

    $batchSize = 500
    for ($i = 0; $i -lt $rows.Count; $i += $batchSize) {
        $batch = $rows[$i..([Math]::Min($i + $batchSize - 1, $rows.Count - 1))]
        $body = $batch | ConvertTo-Json -Depth 3
        Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/expense_entries" `
            -Headers ($hdr + @{ Prefer = "return=minimal" }) `
            -ContentType "application/json; charset=utf-8" -Body $body | Out-Null
    }

    Write-Log "tem raf3 $($rows.Count) satr b-najah ✓"
    exit 0

} catch {
    $errMsg = "[$timestamp] ERROR: $($_.Exception.Message)"
    Write-Log $errMsg
    Notify-Failure "🚨 فشل رفع حركة المصاريف (push-expense-entries)`n$($_.Exception.Message)"
    exit 1
}
