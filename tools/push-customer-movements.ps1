# ============================================================
# push-customer-movements.ps1
# يرفع حركات حساب كل زبون (آخر 92 يومًا) + رصيد أول المدة
# إلى Supabase (inventory_reports / source=ameen_customer_movements)
# ليستخدمها كشف الحساب الرسمي في الموقع.
# ============================================================
param(
    [int]$PeriodDays = 92,
    [int]$MaxMovementsPerCustomer = 300,
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\customer-movements-push.log"
)

$ErrorActionPreference = "Stop"

# قراءة الإعدادات من .env ثم من متغيرات المستخدم
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

$connStr = Get-Setting "AMEEN_SQL_WRITE_CONNECTION_STRING"
if (-not $connStr) { $connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING" }
$supabaseUrl = Get-Setting "TOBACCO_SUPABASE_URL"
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$supabaseUrl = $supabaseUrl.TrimEnd("/")
$apiKey = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"
if (-not $apiKey) { $apiKey = Get-Setting "SUPABASE_PUBLIC_KEY" }
$syncEmail = Get-Setting "TOBACCO_SYNC_EMAIL"
$syncPassword = Get-Setting "TOBACCO_SYNC_PASSWORD"

if (-not $connStr) { Write-Log "خطأ: AMEEN_SQL_WRITE_CONNECTION_STRING غير موجود."; exit 1 }
if (-not $apiKey) { Write-Log "خطأ: TOBACCO_SUPABASE_PUBLIC_KEY غير موجود."; exit 1 }
if (-not $syncEmail -or -not $syncPassword) { Write-Log "خطأ: TOBACCO_SYNC_EMAIL / TOBACCO_SYNC_PASSWORD غير موجودين."; exit 1 }

$fromDate = (Get-Date).Date.AddDays(-$PeriodDays)
$fromIso = $fromDate.ToString("yyyy-MM-dd")

try {
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # (1) رصيد أول المدة لكل زبون (مجموع القيود قبل بداية الفترة)
    $openings = @{}
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
SELECT LTRIM(RTRIM(cu.CustomerName)) AS name,
       CAST(SUM(COALESCE(en.Debit,0) - COALESCE(en.Credit,0)) AS decimal(18,3)) AS opening
FROM dbo.en000 en
JOIN dbo.cu000 cu ON cu.AccountGUID = en.AccountGUID
WHERE en.Date < @fromDate
  AND cu.CustomerName IS NOT NULL AND LTRIM(RTRIM(cu.CustomerName)) <> ''
  AND (cu.bHide IS NULL OR cu.bHide = 0)
GROUP BY LTRIM(RTRIM(cu.CustomerName))
"@
    $cmd.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null
    $r = $cmd.ExecuteReader()
    while ($r.Read()) { $openings[[string]$r.GetValue(0)] = [double]$r.GetValue(1) }
    $r.Close()

    # (2) حركات الفترة لكل زبون
    $movements = @{}
    $cmd = $conn.CreateCommand()
    # الرصيد المتحرك يُحسب بدالة نافذة على كل قيود الحساب. ترتيب كشف الأمين داخل اليوم:
    # القيد الافتتاحي ← الفواتير (مدين) ← السندات (دائن)، وداخل كل مجموعة بوقت إنشاء
    # سند القيد (ce000.CreateDate) ثم رقمه — تحقق على كشفَي حسن عباس وشريفة (13 رصيداً).
    # (وقت الإنشاء وحده لا يكفي: الأمين يعرض فاتورة اليوم قبل سنداته ولو أُنشئت بعدها.)
    $cmd.CommandText = @"
WITH led AS (
    SELECT LTRIM(RTRIM(cu.CustomerName)) AS name,
           en.AccountGUID AS acct, CAST(en.ParentGUID AS varchar(40)) AS parent,
           COALESCE(CASE WHEN ce.Date >= '2000-01-01' THEN ce.Date END, en.Date) AS dt, en.Number AS num,
           CASE WHEN COALESCE(en.Notes,'') LIKE N'%افتتاح%' THEN 0 ELSE 1 END AS isopen,
           CASE WHEN COALESCE(en.Credit,0) > 0 THEN 1 ELSE 0 END AS iscredit,
           COALESCE(ce.CreateDate, en.Date) AS sortdt,
           COALESCE(ce.Number, 0) AS cenum,
           CAST(COALESCE(en.Debit,0)  AS decimal(18,3)) AS debit,
           CAST(COALESCE(en.Credit,0) AS decimal(18,3)) AS credit,
           LEFT(COALESCE(en.Notes,''), 70) AS notes,
           -- معرّف الفاتورة المولِّدة للقيد: BiGUID قد يشير لرأس الفاتورة مباشرة أو لسطرها
           -- (فنصعد للرأس عبر bi000.ParentGUID) — لربط قطعي بين القيد والفاتورة في الموقع.
           COALESCE(LOWER(CAST(COALESCE(bib.ParentGUID, en.BiGUID) AS varchar(40))), '') AS bill_guid,
           CAST(SUM(COALESCE(en.Debit,0) - COALESCE(en.Credit,0))
                OVER (PARTITION BY en.AccountGUID
                      ORDER BY COALESCE(CASE WHEN ce.Date >= '2000-01-01' THEN ce.Date END, en.Date),
                               CASE WHEN COALESCE(en.Notes,'') LIKE N'%افتتاح%' THEN 0 ELSE 1 END,
                               CASE WHEN COALESCE(en.Credit,0) > 0 THEN 1 ELSE 0 END,
                               COALESCE(ce.CreateDate, en.Date),
                               COALESCE(ce.Number, 0),
                               en.Number
                      ROWS UNBOUNDED PRECEDING) AS decimal(18,3)) AS balance,
           -- الرصيد الزمني الحقيقي: نفس الترتيب لكن **بلا** قاعدة «المدين قبل الدائن» (iscredit).
           -- يعكس رصيد الحساب لحظة إنشاء القيد فعلياً (بوقت ce.CreateDate)، فيصلح لمستند
           -- الفاتورة/السند المُرسَل للزبون (لا يتضخّم إن جاءت دفعة بين فاتورتَي نفس اليوم).
           -- كشف الحساب يبقى على balance (ترتيب الأمين). راجع push ↔ src/app.js (مستندات فقط).
           CAST(SUM(COALESCE(en.Debit,0) - COALESCE(en.Credit,0))
                OVER (PARTITION BY en.AccountGUID
                      ORDER BY COALESCE(CASE WHEN ce.Date >= '2000-01-01' THEN ce.Date END, en.Date),
                               CASE WHEN COALESCE(en.Notes,'') LIKE N'%افتتاح%' THEN 0 ELSE 1 END,
                               COALESCE(ce.CreateDate, en.Date),
                               COALESCE(ce.Number, 0),
                               en.Number
                      ROWS UNBOUNDED PRECEDING) AS decimal(18,3)) AS balanceChrono
    FROM dbo.en000 en
    JOIN dbo.cu000 cu ON cu.AccountGUID = en.AccountGUID
    LEFT JOIN dbo.ce000 ce ON ce.GUID = en.ParentGUID
    LEFT JOIN dbo.bi000 bib ON bib.GUID = en.BiGUID
    WHERE (COALESCE(en.Debit,0) > 0 OR COALESCE(en.Credit,0) > 0)
      AND cu.CustomerName IS NOT NULL AND LTRIM(RTRIM(cu.CustomerName)) <> ''
      AND (cu.bHide IS NULL OR cu.bHide = 0)
)
SELECT name, dt, debit, credit, notes, bill_guid, balance, balanceChrono,
       -- رصيد المستند بعد/قبل **سند القيد كاملاً** (نجمع أسطر نفس السند ParentGUID على حساب
       -- الزبون بالترتيب الزمني): كي يشمل قيد الخصم المرافق للفاتورة بنفس السند فلا يتضخّم
       -- رصيدها الجديد. للفاتورة المفردة السطر يساوي balanceChrono تماماً. الحارس يحمي من
       -- تجميع قيود بلا سند (ParentGUID صفري/فارغ) خطأً.
       CASE WHEN parent IS NOT NULL AND parent <> '00000000-0000-0000-0000-000000000000'
            THEN LAST_VALUE(balanceChrono) OVER (PARTITION BY acct, parent
                   ORDER BY dt, isopen, sortdt, cenum, num
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
            ELSE balanceChrono END AS docNew,
       CASE WHEN parent IS NOT NULL AND parent <> '00000000-0000-0000-0000-000000000000'
            THEN FIRST_VALUE(balanceChrono - (debit - credit)) OVER (PARTITION BY acct, parent
                   ORDER BY dt, isopen, sortdt, cenum, num
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
            ELSE balanceChrono - (debit - credit) END AS docPrev
FROM led
WHERE dt >= @fromDate
ORDER BY name, dt, isopen, iscredit, sortdt, cenum, num
"@
    $cmd.Parameters.AddWithValue("@fromDate", $fromDate) | Out-Null
    $r = $cmd.ExecuteReader()
    while ($r.Read()) {
        $name = [string]$r.GetValue(0)
        if (-not $movements.ContainsKey($name)) { $movements[$name] = New-Object System.Collections.Generic.List[object] }
        $movements[$name].Add(@{
            date     = ([datetime]$r.GetValue(1)).ToString("yyyy-MM-dd")
            debit    = [double]$r.GetValue(2)
            credit   = [double]$r.GetValue(3)
            notes    = [string]$r.GetValue(4)
            billGuid = [string]$r.GetValue(5)
            balance  = [double]$r.GetValue(6)
            balanceChrono = [double]$r.GetValue(7)
            docNew   = [double]$r.GetValue(8)
            docPrev  = [double]$r.GetValue(9)
        })
    }
    $r.Close()
    $conn.Close()

    # (3) بناء عناصر التقرير
    # ملاحظة PowerShell 5.1: لا تغلّف List بـ @() — ترمي "Argument types do not match".
    # استخدم .ToArray() بدلًا منها.
    $nameSet = @{}
    foreach ($k in @($openings.Keys)) { $nameSet[$k] = $true }
    foreach ($k in @($movements.Keys)) { $nameSet[$k] = $true }
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($name in @($nameSet.Keys)) {
        $opening = 0.0
        if ($openings.ContainsKey($name)) { $opening = $openings[$name] }
        # نجبره مصفوفة دائماً (@(...)): زبون بحركة واحدة كان يصبح كائناً مفرداً فيكسر الفهرسة والرفع.
        $list = @()
        if ($movements.ContainsKey($name)) { $list = @($movements[$name].ToArray()) }
        if ($opening -eq 0 -and $list.Count -eq 0) { continue }

        $truncated = $false
        if ($list.Count -gt $MaxMovementsPerCustomer) {
            $list = @($list | Select-Object -Last $MaxMovementsPerCustomer)
            $truncated = $true
        }
        $closing = $opening
        foreach ($m in $list) { $closing += ($m.debit - $m.credit) }
        # الرصيد المتحرك المُخزَّن هو الأدقّ: نشتقّ منه الافتتاحي (رصيد أول المعروض) والختامي،
        # فيصحّ حتى عند اقتطاع الحركات القديمة أو وجود قيود افتتاحية.
        if ($list.Count -gt 0) {
            if ($list[0].ContainsKey('balance'))  { $opening = [double]$list[0].balance - ([double]$list[0].debit - [double]$list[0].credit) }
            if ($list[-1].ContainsKey('balance')) { $closing = [double]$list[-1].balance }
        }

        $items.Add(@{
            name           = $name
            openingBalance = [math]::Round($opening, 3)
            closingBalance = [math]::Round($closing, 3)
            movements      = $list
            truncated      = $truncated
        })
    }

    Write-Log "تم تجهيز حركات $($items.Count) زبون (من $fromIso)"

    # (4) تسجيل الدخول إلى Supabase
    $loginBody = (@{ email = $syncEmail; password = $syncPassword } | ConvertTo-Json -Compress)
    # -TimeoutSec 30: يمنع تعليق العملية للأبد عند تعثر شبكي (نفس القيمة المستخدمة بالنداءات الأخرى بهذا الملف)
    $session = Invoke-RestMethod -Method Post -Uri "$supabaseUrl/auth/v1/token?grant_type=password" `
        -Headers @{ apikey = $apiKey } -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($loginBody)) -TimeoutSec 30

    # معرّف المستخدم: من user.id إن وُجد، وإلا من حقل sub داخل توكن JWT (موثوق لأن الدخول نجح).
    $createdBy = $null
    if ($session.user -and $session.user.id) { $createdBy = $session.user.id }
    if (-not $createdBy -and $session.access_token) {
        $seg = $session.access_token.Split('.')[1].Replace('-','+').Replace('_','/')
        switch ($seg.Length % 4) { 2 { $seg += '==' } 3 { $seg += '=' } 1 { $seg += '===' } }
        try { $createdBy = ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($seg)) | ConvertFrom-Json).sub } catch {}
    }

    $authHeaders = @{
        apikey            = $apiKey
        Authorization     = "Bearer $($session.access_token)"
        Prefer            = "return=minimal"
        "Accept-Profile"  = "public"
        "Content-Profile" = "public"
    }

    # (5) رفع التقرير
    $payload = @{
        source      = "ameen_customer_movements"
        report_date = (Get-Date).ToString("yyyy-MM-dd")
        created_by  = $createdBy
        summary     = @{
            periodDays  = $PeriodDays
            fromDate    = $fromIso
            customers   = $items.Count
            syncedAt    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
        }
        items       = $items
    }
    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    Write-Log ("حجم البيانات: {0:N0} حرف" -f $json.Length)
    Invoke-RestMethod -Method Post -Uri "$supabaseUrl/rest/v1/inventory_reports" `
        -Headers $authHeaders -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 30 | Out-Null

    Write-Log "تم رفع تقرير الحركات بنجاح ✓"

    # (6) حذف التقارير القديمة (أقدم من يومين) لتوفير المساحة
    $cutoff = (Get-Date).ToUniversalTime().AddDays(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
    try {
        Invoke-RestMethod -Method Delete `
            -Uri "$supabaseUrl/rest/v1/inventory_reports?source=eq.ameen_customer_movements&created_at=lt.$cutoff" `
            -Headers $authHeaders -TimeoutSec 30 | Out-Null
    } catch { Write-Log "تنبيه: تعذّر حذف التقارير القديمة: $($_.Exception.Message)" }

    exit 0
} catch {
    Write-Log "خطأ (سطر $($_.InvocationInfo.ScriptLineNumber)): $($_.Exception.Message)"
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { Write-Log ("رد الخادم: " + $_.ErrorDetails.Message) }
    if ($_.Exception.InnerException) { Write-Log ("تفصيل: " + $_.Exception.InnerException.Message) }
    exit 1
}
