#Requires -Version 5.1
# ============================================================
# Test-AutoSyncGitPushFailure.ps1
#
# اختبار انحدار سلوكي لعطل إنتاجي حقيقي (جهاز Windows، 2026-08-29 → 2026-09-05):
# tools/auto-sync-price-lists.ps1 كان ينادي git هكذا:
#
#     & git -C $ProjectRoot push 2>&1 | Out-Null
#     Log "✓ تم الرفع — GitHub Actions يولّد النشرات"
#
# بلا فحص رمز خروج، وبسطر نجاح غير مشروط. والأخطر أن git يكتب نتيجة الرفع على
# **stderr حتى عند النجاح**، ومع $ErrorActionPreference = "Stop" أعلى الملف
# يحوّل Windows PowerShell 5.1 تلك الأسطر إلى NativeCommandError **منهٍ** —
# فيموت السكربت عند الرفع في كل مرة يكون فيها ما يُرفع: بلا سطر نجاح ولا سطر
# فشل ولا تنبيه، والكوميت قد صار محلياً فيتراكم بلا رفع.
#
# دليل الإنتاج: «رفع التغييرات لـ GitHub...» ظهر 11 مرة في السجل، بينما
# «✓ تم الرفع» و«═══ اكتمل ═══» لم يظهرا ولا مرة واحدة.
#
# الفحص الساكن لا يكفي: السلوك يعتمد على تفاعل stderr مع ErrorActionPreference
# في 5.1 تحديداً (يمرّ بلا مشكلة على 7). لذلك ينفّذ هذا الاختبار **الدوال
# الحقيقية المستخرَجة من السكربت الإنتاجي** على مستودع git مؤقّت بلا شبكة.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-AutoSyncGitPushFailure.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
# ترميز الكونسول تجميلي فقط؛ فشله لا يبطل الاختبار — لكن لا يُبتلع صامتاً.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }
catch { Write-Verbose ("تعذّر ضبط ترميز الكونسول: " + $_.Exception.Message) }

if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') {
    Write-Host "FAIL: must run under Windows PowerShell 5.1 (Desktop). Got $($PSVersionTable.PSVersion) / $($PSVersionTable.PSEdition)." -ForegroundColor Red
    Write-Host "      الصيغة المعطوبة تمرّ بلا مشكلة على 7، فاختبارها هناك لا يثبت شيئاً." -ForegroundColor Yellow
    exit 1
}

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot 'tools\auto-sync-price-lists.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { Write-Host "FAIL: cannot find $scriptPath" -ForegroundColor Red; exit 1 }
$src = Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }

# ------------------------------------------------------------
# استخراج غلاف git الحقيقي من السكربت الإنتاجي
# ------------------------------------------------------------
$m = [regex]::Match($src, '(?s)function Invoke-SyncGit \{.*?\n\}')
if (-not $m.Success) { Add-Failure "تعذّر استخراج Invoke-SyncGit — تغيّرت بنيته فسقط الحارس"; Write-Host ""; exit 1 }
$wrapper = $m.Value

# مستودع مؤقّت بلا أي شبكة أو بيانات إنتاج
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("asg-" + [guid]::NewGuid().ToString('N').Substring(0,10))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
    & git init --initial-branch=main $tmp 2>&1 | Out-Null
    & git -C $tmp config user.email "t@t.t" 2>&1 | Out-Null
    & git -C $tmp config user.name  "t"     2>&1 | Out-Null
    Set-Content -LiteralPath (Join-Path $tmp 'f.txt') -Value "x" -Encoding UTF8
    & git -C $tmp add -A 2>&1 | Out-Null
    & git -C $tmp commit -m seed 2>&1 | Out-Null
} finally { $ErrorActionPreference = $prev }

$ProjectRoot = $tmp
. ([scriptblock]::Create($wrapper))

try {
    # --------------------------------------------------------
    # 1) الحالة التي كانت تقتل السكربت: git يكتب على stderr تحت Stop.
    #    الغلاف يجب أن يعود بنتيجة لا أن يرمي.
    # --------------------------------------------------------
    Write-Host "1) git writing to stderr must not throw under ErrorActionPreference=Stop"
    $threw = $false
    try { $r = Invoke-SyncGit push } catch { $threw = $true; $err = $_.FullyQualifiedErrorId }
    if ($threw) { Add-Failure "الغلاف رمى ($err) — العطل الأصلي عاد: السكربت يموت عند الرفع" }
    else { Add-Pass "لم يرمِ — التنفيذ يكمل ويُحكَم برمز الخروج" }

    # --------------------------------------------------------
    # 2) فشل الرفع يجب أن يظهر برمز خروج غير صفري وبنصّ خرج git الحقيقي،
    #    لا أن يُبتلع. (لا remote في المستودع المؤقّت ⇒ الرفع يفشل حتماً.)
    # --------------------------------------------------------
    Write-Host "2) a failing push must surface a nonzero code and git's real output"
    if ($null -eq $r) { Add-Failure "لا نتيجة من الغلاف" }
    else {
        if ($r.Code -eq 0) { Add-Failure "رمز الخروج 0 لرفع فاشل — الفشل ما زال مبتلعاً" }
        else { Add-Pass "رمز خروج غير صفري ($($r.Code))" }
        if ([string]::IsNullOrWhiteSpace($r.Text)) { Add-Failure "خرج git مفقود — لا شيء يُسجَّل ولا يُنبَّه عنه" }
        else { Add-Pass "خرج git محفوظ للتسجيل والتنبيه" }
    }

    # --------------------------------------------------------
    # 3) النجاح يجب أن يُميَّز عن الفشل برمز الخروج (لا بافتراض).
    # --------------------------------------------------------
    Write-Host "3) a succeeding git command must report code 0"
    $ok = Invoke-SyncGit status --porcelain
    if ($ok.Code -ne 0) { Add-Failure "أمر ناجح أعاد رمزاً غير صفري ($($ok.Code))" }
    else { Add-Pass "الأمر الناجح يعيد 0" }

    # --------------------------------------------------------
    # 4) سطر النجاح ممنوع أن يكون غير مشروط في السكربت الإنتاجي: يجب أن
    #    يسبقه فحصُ رمز خروج الرفع. هذا هو جوهر العطل: «✓ تم الرفع» كان
    #    يُطبع بلا شرط بعد نداء push غير مفحوص.
    # --------------------------------------------------------
    Write-Host "4) the production success line must be guarded by a push exit-code check"
    # البحث عن سطر النجاح يبدأ **بعد** الرفع عمداً: السكربت يحوي قبل ذلك
    # «لن يتم الرفع» في مسار «لا تغييرات»، وهي تحوي «تم الرفع» كسلسلة فرعية
    # فتُطابَق خطأً وتُنتج مدى سالباً.
    $pushIdx = $src.IndexOf('Invoke-SyncGit push')
    $okIdx   = if ($pushIdx -ge 0) { $src.IndexOf('تم الرفع', $pushIdx) } else { -1 }
    if ($pushIdx -lt 0 -or $okIdx -lt 0) { Add-Failure "تعذّر تحديد موضع الرفع أو سطر النجاح" }
    else {
        $between = $src.Substring($pushIdx, $okIdx - $pushIdx)
        if ($between -notmatch 'Code\s*-ne\s*0') { Add-Failure "لا فحص لرمز خروج الرفع قبل سطر النجاح" }
        else { Add-Pass "سطر النجاح مشروط بنجاح الرفع فعلاً" }
    }
    if ($src -match '&\s*git\s+-C\s+\$ProjectRoot\s+push\s+2>&1\s*\|\s*Out-Null') {
        Add-Failure "ما زال هناك نداء push يبتلع خرجه بـOut-Null بلا فحص"
    } else { Add-Pass "لا نداء push يبتلع خرجه" }
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ""
if ($failures.Count -gt 0) { Write-Host "FAILED: $($failures.Count)" -ForegroundColor Red; exit 1 }
Write-Host "PASS: auto-sync git push failure visibility" -ForegroundColor Green
exit 0
