# ============================================================
# auto-sync-price-lists.ps1
# يبني price-data.json من الصفر:
#   المواد + الوحدات + المجموعات  ← الأمين (مستودعات)
#   الأسعار المعتمدة (USD)        ← Supabase (الموقع)
# ثم يرفع لـ GitHub → GitHub Actions يولّد النشرات
# ============================================================
# الاستخدام: .\tools\auto-sync-price-lists.ps1
# ============================================================

param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$EnvFile     = "$PSScriptRoot\.env",
    [string]$LogFile     = "$PSScriptRoot\logs\price-list-sync.log"
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# نفس تطبيع الاسم المستخدم في push-item-details.ps1 / ameen-sync-agent.ps1
# (item_key في approved_price_items هو اسم المادة الخام، غير متسق همزات/تاء مربوطة)
function Normalize-ItemName($Value) {
    $text = if ($null -ne $Value) { [string]$Value } else { "" }
    $text = $text.Trim()
    $text = [regex]::Replace($text, '^\d{2,}\s*-\s*', "")
    $text = $text.Replace("أ","ا").Replace("إ","ا").Replace("آ","ا").Replace("ى","ي").Replace("ة","ه")
    $text = [regex]::Replace($text, "[^\p{L}\p{N}]+", " ")
    $text = [regex]::Replace($text, "\s+", " ")
    return $text.Trim().ToLowerInvariant()
}

function Log($msg, $color = "White") {
    $line = "[$timestamp] $msg"
    Write-Host $line -ForegroundColor $color
    $logDir = Split-Path $LogFile -Parent
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $line | Add-Content $LogFile -Encoding UTF8
}

Log "═══ بناء نشرة الأسعار من الأمين + Supabase ═══" "Cyan"

# ── حارس الفرع: يرفض الكتابة إلا إذا كان main هو الفرع الحالي ──────────────
# حادثة 2026-08-31: هذا السكريبت كان يعمل commit/push مباشرة على أي فرع كان
# مفتوحاً محلياً وقت التشغيل (بلا أي فحص)، فكتب فوق PR #164 (feat/docker-dev-setup)
# بينما جلسة Claude Code كانت مفتوحة عليه وقت تشغيل المهمة المجدولة. الإصلاح:
# أوقف فوراً إذا لم يكن الفرع الحالي main تحديداً، ونبّه عبر تيليغرام كي لا يمر
# العطل صامتاً. لا تعبر هذا الفحص إلى أي عملية قراءة/كتابة ثقيلة قبله.
$currentBranch = "$(& git -C $ProjectRoot rev-parse --abbrev-ref HEAD 2>&1)".Trim()
if ($currentBranch -ne "main") {
    Log "رُفض: الفرع الحالي '$currentBranch' وليس main — لن يُكتب أو يُرفع شيء" "Red"
    $alertScript = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
    if (Test-Path $alertScript) {
        try {
            & $alertScript `
                -Message "🚨 auto-sync-price-lists توقف: الفرع الحالي في مجلد المزامنة هو '$currentBranch' وليس main. لم يُكتب أي شيء. حوّل المجلد إلى main أو استخدم worktree مستقل للأتمتة." `
                -EventType "windows" -DedupeKey "auto-sync-wrong-branch" -DedupeMinutes 60 2>&1 | Out-Null
        } catch {}
    }
    exit 1
}

# ── قراءة .env ───────────────────────────────────────────────────────────────
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $p = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($p[0].Trim(), $p[1].Trim())
    }
}

# ════════════════════════════════════════════════════════════════════════════
# 1. سحب المواد من الأمين
# ════════════════════════════════════════════════════════════════════════════
$connStr = $env:AMEEN_SQL_CONNECTION_STRING
if (-not $connStr) {
    Log "خطأ: AMEEN_SQL_CONNECTION_STRING غير موجود" "Red"
    Log "شغّل أولاً: .\tools\setup-ameen-sync-env.ps1" "Yellow"
    exit 1
}

Log "الاتصال بالأمين..." "Cyan"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
$conn.Open()

# ── اكتشاف الأعمدة المتاحة ────────────────────────────────────────────────
$discCmd = $conn.CreateCommand()
$discCmd.CommandText = @"
SELECT TABLE_NAME, COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME LIKE '%Material%'
  AND (COLUMN_NAME LIKE '%unit%'   OR COLUMN_NAME LIKE '%Unit%'
    OR COLUMN_NAME LIKE '%factor%' OR COLUMN_NAME LIKE '%Factor%'
    OR COLUMN_NAME LIKE '%group%'  OR COLUMN_NAME LIKE '%Group%'
    OR COLUMN_NAME LIKE '%categ%'  OR COLUMN_NAME LIKE '%Categ%'
    OR COLUMN_NAME LIKE '%class%'  OR COLUMN_NAME LIKE '%small%'
    OR COLUMN_NAME LIKE '%pack%')
ORDER BY TABLE_NAME, COLUMN_NAME
"@
$dr = $discCmd.ExecuteReader()
$colMap = @{}
while ($dr.Read()) {
    $t = "$($dr["TABLE_NAME"])"; $c = "$($dr["COLUMN_NAME"])"
    if (-not $colMap[$t]) { $colMap[$t] = @() }
    $colMap[$t] += $c
}
$dr.Close()

# ملاحظة (2026-08-29): MaterialCard000 غير موجود في AmnDb002 (تدوير سنة الأمين) — المصدر
# الحي الآن هو vwMaterials (نفس ما تستخدمه push-item-costs.ps1 وdiscover-order-limit.ps1).
$materialSource = "vwMaterials"
$matCols = if ($colMap[$materialSource]) { $colMap[$materialSource] } else { @() }
Log "أعمدة $materialSource : $($matCols -join ', ')" "Gray"

# ── اختيار أعمدة الوحدة والمجموعة ────────────────────────────────────────
$pick = {
    param([string[]]$list, [string[]]$candidates)
    $candidates | Where-Object { $list -contains $_ } | Select-Object -First 1
}

$factorCol = & $pick $matCols @("UnitFactor","ConversionFactor","PackSize","UnitsPerCarton","Qty2","Unit2Fact")
$unit1Col  = & $pick $matCols @("SmallUnitName","Unit1Name","UnitSmallName","SmallUnit","Unit1","UnitName","Unit","Unity")
$unit2Col  = & $pick $matCols @("BigUnitName","Unit2Name","UnitBigName","BigUnit","Unit2","UnitName2")
$groupCol  = & $pick $matCols @("GroupName","CategoryName","ClassName","Group","Category","Class")

Log ("عامل التحويل: " + $(if ($factorCol) {$factorCol} else {"(افتراضي 10)"})) "Gray"
Log ("وحدة أولى  : " + $(if ($unit1Col)  {$unit1Col}  else {"(غير موجود)"}))  "Gray"
Log ("وحدة ثانية : " + $(if ($unit2Col)  {$unit2Col}  else {"(افتراضي كرتونة)"})) "Gray"
Log ("مجموعة     : " + $(if ($groupCol)  {$groupCol}  else {"(أول كلمة من الاسم)"})) "Gray"

$fExpr  = if ($factorCol) { "COALESCE(m.$factorCol, 10)" }                        else { "10" }
$u1Expr = if ($unit1Col)  { "ISNULL(CAST(m.$unit1Col AS NVARCHAR(100)), '')" }    else { "''" }
$u2Expr = if ($unit2Col)  { "ISNULL(CAST(m.$unit2Col AS NVARCHAR(100)), '')" }    else { "'كرتونة'" }
$grExpr = if ($groupCol)  { "ISNULL(CAST(m.$groupCol AS NVARCHAR(200)), '')" }    else { "''" }

# ── استعلام المواد الكاملة ────────────────────────────────────────────────
$sql = @"
SELECT
    RTRIM(LTRIM(m.Name)) AS item_name,
    RTRIM(LTRIM(m.Code)) AS item_key,
    $fExpr               AS unit_factor,
    $u1Expr              AS unit1_name,
    $u2Expr              AS unit2_name,
    $grExpr              AS item_group
FROM $materialSource m
WHERE ISNULL(m.bHide, 0) = 0
  AND m.Code IS NOT NULL
  AND LEN(RTRIM(m.Name)) > 0
ORDER BY m.Name
"@

$cmd = $conn.CreateCommand()
$cmd.CommandText = $sql
$cmd.CommandTimeout = 60

$ameenItems = @()
$reader = $cmd.ExecuteReader()
while ($reader.Read()) {
    $grp = "$($reader["item_group"])".Trim()
    if ($grp -eq "") {
        # المجموعة = أول كلمة من اسم المادة
        $grp = "$($reader["item_name"])".Trim() -replace ' .*', ''
    }
    $ameenItems += [PSCustomObject]@{
        item_key    = "$($reader["item_key"])".Trim()
        item_name   = "$($reader["item_name"])".Trim()
        unit_factor = [int]$reader["unit_factor"]
        unit1_name  = "$($reader["unit1_name"])".Trim()
        unit2_name  = "$($reader["unit2_name"])".Trim()
        item_group  = $grp
    }
}
$reader.Close()
$conn.Close()

Log "✓ الأمين: $($ameenItems.Count) مادة نشطة" "Green"
if ($ameenItems.Count -eq 0) {
    Log "لا مواد — تحقق من الاتصال أو الـ schema" "Red"; exit 1
}

# ════════════════════════════════════════════════════════════════════════════
# 2. سحب الأسعار المعتمدة من Supabase
# ════════════════════════════════════════════════════════════════════════════
$supaUrl = if ($env:SUPABASE_URL) { $env:SUPABASE_URL } else { "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$apiKey  = if ($env:SUPABASE_SERVICE_KEY) { $env:SUPABASE_SERVICE_KEY } else { "sb_publishable_RkM_QDWxk8Yekqz9KBKXBw_Yl14zhSH" }

Log "سحب الأسعار من Supabase..." "Cyan"
$headers = @{
    "apikey"         = $apiKey
    "Authorization"  = "Bearer $apiKey"
    "Accept-Profile" = "public"
}

$supaMap = @{}
try {
    $rows = Invoke-RestMethod `
        -Uri "$supaUrl/rest/v1/approved_price_items?select=item_key,unit2_price&limit=5000" `
        -Headers $headers -Method GET -ErrorAction Stop
    foreach ($r in $rows) {
        if ($r.unit2_price -and [double]$r.unit2_price -gt 0) {
            # item_key في Supabase هو اسم المادة الخام (وليس كود الأمين) — المطابقة بالاسم المطبّع
            $nk = Normalize-ItemName $r.item_key
            if ($nk -and -not $supaMap.ContainsKey($nk)) {
                $supaMap[$nk] = [Math]::Round([double]$r.unit2_price, 2)
            }
        }
    }
    Log "✓ Supabase: $($supaMap.Count) سعر معتمد" "Green"
} catch {
    Log "تحذير Supabase: $_ — لن تظهر أسعار في النشرة بدون أسعار معتمدة" "Yellow"
}

# ════════════════════════════════════════════════════════════════════════════
# 3. بناء price-data.json (المواد التي عندها سعر معتمد فقط)
# ════════════════════════════════════════════════════════════════════════════
$priceData = [System.Collections.Generic.List[object]]::new()
$skipped   = 0

foreach ($item in $ameenItems) {
    $usd = $supaMap[(Normalize-ItemName $item.item_name)]
    if (-not $usd -or $usd -le 0) { $skipped++; continue }

    $u2 = if ($item.unit2_name -ne "") { $item.unit2_name } else { "كرتونة" }

    $entry = [ordered]@{
        name       = $item.item_name
        unit       = $u2
        usd        = $usd
        group      = $item.item_group
        unitFactor = $item.unit_factor
        item_key   = $item.item_key
    }
    if ($item.unit1_name -ne "") { $entry["unit1"] = $item.unit1_name }

    $priceData.Add([PSCustomObject]$entry)
}

Log "✓ بسعر معتمد: $($priceData.Count) مادة | بدون سعر (تخطّيت): $skipped" "Green"

if ($priceData.Count -eq 0) {
    Log "لا مواد للنشرة — اعتمد أسعار على الموقع أولاً" "Yellow"
    exit 0
}

# ════════════════════════════════════════════════════════════════════════════
# 4. حفظ price-data.json
# ════════════════════════════════════════════════════════════════════════════
$dataPath = Join-Path $ProjectRoot "scripts\price-data.json"
$newJson  = $priceData | ConvertTo-Json -Depth 5
$oldJson  = if (Test-Path $dataPath) { Get-Content $dataPath -Raw -Encoding UTF8 } else { "" }

if ($newJson.Trim() -eq $oldJson.Trim()) {
    Log "لا تغييرات في البيانات — لن يتم الرفع" "Yellow"
    exit 0
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($dataPath, $newJson, $utf8NoBom)
Log "✓ price-data.json محدَّث ($($priceData.Count) مادة)" "Green"

# ════════════════════════════════════════════════════════════════════════════
# 5. رفع لـ GitHub → يشغّل GitHub Actions تلقائياً
# ════════════════════════════════════════════════════════════════════════════
Log "رفع التغييرات لـ GitHub..." "Cyan"

# git يكتب نتيجة الرفع على **stderr حتى عند النجاح** («To https://…»، «main -> main»).
# ومع `$ErrorActionPreference = "Stop"` أعلى هذا الملف، يحوّل Windows PowerShell 5.1
# تلك الأسطر إلى NativeCommandError **منهٍ** — فيموت السكربت عند الرفع في كل مرة
# يكون فيها ما يُرفع: بلا سطر نجاح، وبلا سطر فشل، وبلا تنبيه، والكوميت قد صار
# محلياً فيتراكم بلا رفع.
#
# قياس على سجل الإنتاج (2026-08-29 → 2026-09-05): «رفع التغييرات لـ GitHub...»
# ظهر 11 مرة، بينما «✓ تم الرفع» و«═══ اكتمل ═══» لم يظهرا **ولا مرة واحدة**.
# أي أن مسار الرفع لم يكتمل قطّ، وبقي عطلاً غير مرئي لأن لا أحد كان يفحص رمز
# الخروج ولا يقرأ خرج git.
#
# الغلاف يخفض التفضيل لنداءات git وحدها ويحكم برمز الخروج — وهو المعيار الوحيد
# الموثوق لنجاح أمر native — ثم يعيد التفضيل كما كان.
function Invoke-SyncGit {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = & git -C $ProjectRoot @GitArgs 2>&1 | ForEach-Object { "$_" }
        return [pscustomobject]@{
            Code = $LASTEXITCODE
            Text = (($lines | Select-Object -Last 3) -join " | ")
        }
    } finally { $ErrorActionPreference = $previousErrorAction }
}

# فشل أي خطوة يُسجَّل بخرج git الحقيقي ويُنبَّه عنه ويُنهي التشغيل برمز غير صفري —
# بدل «نجاح» يُطبع بلا شرط.
function Stop-WithGitFailure([string]$Step, $Result) {
    Log "فشل $Step (رمز $($Result.Code)): $($Result.Text)" "Red"
    $alertScript = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
    if (-not (Test-Path $alertScript)) {
        Log "لم يصل تنبيه تيليغرام: $alertScript غير موجود" "DarkYellow"
        exit 1
    }

    # `send-telegram-notification.ps1` best-effort بتصميمه: يلتقط كل استثناءاته
    # ويطبع «TELEGRAM-NOTIFY FAILED» أو «SKIPPED» ثم **يخرج بصفر دائماً**. فلا
    # try/catch خارجي يراه، ولا رمز الخروج يدلّ عليه — وإرسال خرجه إلى Out-Null
    # يمحو إشارته الوحيدة. النتيجة: فشل git يُسجَّل، والتنبيه لا يصل، ولا أحد
    # يعلم. لذلك نلتقط خرجه ونطالبه بعلامة النجاح صراحةً.
    $alertOutput = ""
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $alertOutput = (& $alertScript `
            -Message "🚨 auto-sync-price-lists: فشل $Step عند رفع نشرة الأسعار (رمز $($Result.Code)). $($Result.Text)" `
            -EventType "windows" -DedupeKey "auto-sync-git-$Step" -DedupeMinutes 60 2>&1 |
            ForEach-Object { "$_" }) -join " | "
    } catch {
        $alertOutput = "استثناء: $($_.Exception.Message)"
    } finally { $ErrorActionPreference = $previousErrorAction }

    if ($alertOutput -notmatch 'TELEGRAM-NOTIFY OK') {
        # التنبيه يبقى best-effort فلا يكسر المزامنة، لكن عدم وصوله يُسجَّل.
        Log "لم يصل تنبيه تيليغرام: $alertOutput" "DarkYellow"
    }
    exit 1
}

$addResult = Invoke-SyncGit add "scripts/price-data.json"
if ($addResult.Code -ne 0) { Stop-WithGitFailure "add" $addResult }

$stagedResult = Invoke-SyncGit diff --staged --quiet
if ($stagedResult.Code -eq 0) { Log "لا تغييرات للرفع" "Yellow"; exit 0 }

$msg = "Auto: $($priceData.Count) items from Ameen+Supabase — $timestamp"
$commitResult = Invoke-SyncGit commit -m $msg
if ($commitResult.Code -ne 0) { Stop-WithGitFailure "commit" $commitResult }

$pushResult = Invoke-SyncGit push
if ($pushResult.Code -ne 0) { Stop-WithGitFailure "push" $pushResult }

Log "✓ تم الرفع — GitHub Actions يولّد النشرات" "Green"
Log "═══ اكتمل ═══" "Cyan"
