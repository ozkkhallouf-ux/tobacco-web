# ============================================================
# archive-documents.ps1  (يعمل على اللابتوب)
# يراقب مستندات الموقع (shared_documents) ويحفظ كل وصل/فاتورة
# كملف PDF على سطح المكتب بمجلدين:
#   سطح المكتب\فواتير الزبائن
#   سطح المكتب\وصولات الاستلام
# اسم الملف: اسم الزبون - التاريخ.pdf
# ويطبع تلقائياً كل مستند على الطابعة المناسبة:
#   وصولات الاستلام  → XPRINTER XP-T80Q 80MM  (الكاشير)
#   فواتير الزبائن   → Canon                   (A4)
# ============================================================
# تشغيل مرة:               .\tools\archive-documents.ps1
# بدون طباعة تلقائية:      .\tools\archive-documents.ps1 -NoPrint
# جدولة كل 5 دقائق:        .\tools\register-archive-documents-task.ps1
# ============================================================
param(
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$StateFile = "$PSScriptRoot\logs\archived-docs.txt",
    [string]$LogFile = "$PSScriptRoot\logs\archive-documents.log",
    # اسم الطابعة الحرارية للوصولات — اتركه فارغاً لتعطيل الطباعة التلقائية لهذا النوع
    [string]$ReceiptPrinterName = "XPRINTER XP-T80Q 80MM",
    # اسم طابعة A4 للفواتير — اتركه فارغاً لتعطيل الطباعة التلقائية لهذا النوع
    [string]$InvoicePrinterName = "Canon",
    # تعطيل الطباعة التلقائية كلياً (يحفظ فقط)
    [switch]$NoPrint
)
$ErrorActionPreference = "Stop"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $p = $_ -split '=', 2
        [Environment]::SetEnvironmentVariable($p[0].Trim(), $p[1].Trim())
    }
}
function Get-Setting($n) {
    $v = [Environment]::GetEnvironmentVariable($n, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($n, "User") }
    return $v
}
function Write-Log($m) {
    $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $m
    Write-Host $line
    $d = Split-Path $LogFile -Parent
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

$SB = Get-Setting "TOBACCO_SUPABASE_URL"; if (-not $SB) { $SB = "https://dyxbirfpxeocqffnfdeb.supabase.co" }
$SB = $SB.TrimEnd("/")
$KEY = Get-Setting "TOBACCO_SUPABASE_PUBLIC_KEY"; if (-not $KEY) { $KEY = Get-Setting "SUPABASE_PUBLIC_KEY" }
$EMAIL = Get-Setting "TOBACCO_SYNC_EMAIL"
$PW = Get-Setting "TOBACCO_SYNC_PASSWORD"
# الرابط يُبنى من public_token لا من id: id مفتاح داخلي بـ40 بت، وقراءة الجدول
# بدور anon أُغلقت — فرابط ?id= لن يعمل للمستندات المنشأة بعد 2026-07-26.
$SITE = "https://fhwvtqdc2q-svg.github.io/tobacco-web/receipt.html?t="
if (-not $KEY -or -not $EMAIL -or -not $PW) { Write-Log "khata: nawaqis env (KEY/EMAIL/PW)."; exit 1 }

# --- ايجاد كروم ---
$chrome = $null
foreach ($p in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)) { if (Test-Path $p) { $chrome = $p; break } }
if (-not $chrome) { Write-Log "khata: lm ajid Chrome aw Edge."; exit 1 }
$chromeProfile = Join-Path $env:TEMP "ozk-chrome-prof"
Write-Log "browser: $chrome"

# --- مجلدات السطح ---
$desk = [Environment]::GetFolderPath("Desktop")
$folders = @{ invoice = (Join-Path $desk "فواتير الزبائن"); receipt = (Join-Path $desk "وصولات الاستلام") }
foreach ($f in $folders.Values) { if (-not (Test-Path $f)) { New-Item -ItemType Directory -Force -Path $f | Out-Null } }

# --- المعالَجة سابقاً ---
$done = @{}
if (Test-Path $StateFile) { Get-Content $StateFile | ForEach-Object { if ($_.Trim()) { $done[$_.Trim()] = $true } } }

# --- جلب المستندات ---
$login = (@{ email = $EMAIL; password = $PW } | ConvertTo-Json -Compress)
$sess = Invoke-RestMethod -Method Post -Uri "$SB/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $KEY } -ContentType "application/json; charset=utf-8" `
    -Body ([Text.Encoding]::UTF8.GetBytes($login))
$hdr = @{ apikey = $KEY; Authorization = "Bearer $($sess.access_token)"; "Accept-Profile" = "public" }
$docs = Invoke-RestMethod -Method Get -Uri "$SB/rest/v1/shared_documents?select=id,public_token,doc,created_at&order=created_at.asc" -Headers $hdr
Write-Log "wasal $($docs.Count) mustanad."

function Clean-Name($s) {
    $s = "$s"
    foreach ($c in [IO.Path]::GetInvalidFileNameChars()) { $s = $s.Replace($c, ' ') }
    return ($s -replace '\s+', ' ').Trim()
}

# تطبع ملف PDF على طابعة محددة بالاسم.
# تجرّب SumatraPDF أولاً (دقيق + يدعم الحرارية)، ثم تعود لـ PrintTo من Windows.
function Invoke-PrintDocument([string]$filePath, [string]$printerName) {
    if (-not $printerName) { return }
    if (-not (Test-Path -LiteralPath $filePath)) {
        Write-Log "tiba3a: al-malaf ghyr mwjwd — takhatti."
        return
    }
    $sumatra = @(
        "$env:LOCALAPPDATA\SumatraPDF\SumatraPDF.exe",
        "$env:ProgramFiles\SumatraPDF\SumatraPDF.exe",
        "${env:ProgramFiles(x86)}\SumatraPDF\SumatraPDF.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if ($sumatra) {
        Write-Log "tiba3a via SumatraPDF: '$printerName'"
        & $sumatra -print-to "$printerName" -silent "$filePath"
        return
    }

    # احتياط: PrintTo من Windows Shell (لا يحتاج أي برنامج إضافي)
    Write-Log "tiba3a via Windows Shell PrintTo: '$printerName'"
    try {
        $si = New-Object System.Diagnostics.ProcessStartInfo
        $si.FileName = $filePath
        $si.Verb = "PrintTo"
        $si.Arguments = "`"$printerName`""
        $si.UseShellExecute = $true
        $si.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $p = [System.Diagnostics.Process]::Start($si)
        if ($p) { [void]$p.WaitForExit(30000) }
    } catch {
        Write-Log "fashal tiba3a '$printerName': $($_.Exception.Message)"
    }
}

$new = 0
foreach ($d in $docs) {
    if ($done[$d.id]) { continue }
    $doc = $d.doc
    $type = if ("$($doc.t)" -eq "invoice") { "invoice" } else { "receipt" }
    $folder = $folders[$type]
    $name = Clean-Name $doc.name; if (-not $name) { $name = "بدون اسم" }
    $date = "$($doc.date)"; if (-not $date) { $date = (Get-Date).ToString("yyyy-MM-dd") }
    $base = "$name - $date"
    $out = Join-Path $folder ("$base.pdf")
    $i = 2
    while (Test-Path $out) { $out = Join-Path $folder ("$base ($i).pdf"); $i++ }
    # الفشل صريح كما في السكربتين الآخرين: رمز غائب يعني ‎?t=‎ فارغاً ورابطاً ميتاً
    $token = [string]$d.public_token
    if (-not $token) { Write-Log "takhatti: $($d.id) bila public_token"; continue }
    $url = $SITE + $token            # id يبقى للتتبّع المحلي فقط، لا للرابط
    $prof = Join-Path $env:TEMP ("ozk-prof-" + $d.id)
    # ملاحظة: أُزيل --virtual-time-budget لأنه يتدخل في تحميل الصفحات الحقيقية (fetch)
    # وأُضيف --run-all-compositor-stages-before-draw لضمان اكتمال الرسم قبل التصدير.
    $cargs = @(
        "--headless", "--disable-gpu", "--no-sandbox",
        "--user-data-dir=`"$prof`"",
        "--no-margins",
        "--run-all-compositor-stages-before-draw",
        "--print-to-pdf=`"$out`"",
        "--print-to-pdf-no-header",
        "`"$url`""
    )
    Start-Process -FilePath $chrome -ArgumentList $cargs -NoNewWindow -PassThru -Wait | Out-Null
    # فترة انتظار كافية لاكتمال كتابة الملف على القرص
    Start-Sleep -Milliseconds 1200
    try { Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue } catch {}
    # تحقق أن الملف وُجد وحجمه معقول (أكثر من 1KB — PDF فارغ يكون أصغر)
    $pdfOk = (Test-Path $out) -and ((Get-Item $out).Length -gt 1024)
    if ($pdfOk) {
        Add-Content -LiteralPath $StateFile -Value $d.id -Encoding UTF8
        $done[$d.id] = $true
        $new++
        Write-Log "hifz: [$type] $base"
        # طباعة تلقائية على الطابعة المناسبة لكل نوع
        if (-not $NoPrint) {
            if ($type -eq "receipt" -and $ReceiptPrinterName) {
                Invoke-PrintDocument $out $ReceiptPrinterName
            } elseif ($type -eq "invoice" -and $InvoicePrinterName) {
                Invoke-PrintDocument $out $InvoicePrinterName
            }
        }
    } else {
        Write-Log "fashal hifz: $($d.id) — al-PDF ghyr mwjwd aw sagher"
    }
}
Write-Log "thm hifz $new mustanad jadid. al-mojmal al-saabiq: $($done.Count - $new)."
exit 0
