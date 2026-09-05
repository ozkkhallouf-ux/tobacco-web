#Requires -Version 5.1
# ============================================================
# Test-DailyGitPullStaleLock.ps1
#
# اختبار انحدار سلوكي لعطل إنتاجي حقيقي (جهاز Windows، 2026-09-05):
# قفل تنسيق حُجز في 2026-08-31 بقي status=active بعد انتهاء مهمته، فمنع
# tools/daily-git-pull.ps1 من السحب ثلاثة أيام متتالية (09-02 و09-03
# و09-04، ثلاثة أسطر «SKIP: active AI task lock» في tools/logs).
#
# السبب الجذري ترتيبي لا منطقي: القفل كان يُقرأ من **نسخة العمل المحلية**
# قبل أي جلب، فقيمته هي حتماً قيمة آخر سحب ناجح. فمتى دخل قفل active ثم
# أُفلت على main، استحال على الجهاز رؤية الإفلات — الشيء الوحيد القادر
# على إحضاره هو السحب الذي تمنعه القيمة القديمة نفسها. حلقة مغلقة لا
# تُكسر إلا بتدخل يدوي، وقد لزم فعلاً `git merge origin/main` يدوي.
#
# الفحص الساكن لا يكفي هنا: العطل في **ترتيب** عمليتَي git لا في صيغة
# سطر. لذلك يبني هذا الاختبار مستودعَي git حقيقيَّين مؤقتَين (origin +
# نسخة محلية) بلا أي شبكة ولا بيانات إنتاج، ويشغّل السكربت الإنتاجي
# نفسه عليهما، ويحكم على السجل وعلى موضع الفرع فعلياً.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-DailyGitPullStaleLock.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
# ترميز الكونسول تجميلي فقط؛ فشله لا يبطل الاختبار — لكن لا يُبتلع صامتاً.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }
catch { Write-Verbose ("تعذّر ضبط ترميز الكونسول: " + $_.Exception.Message) }

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot 'tools\daily-git-pull.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Host "FAIL: cannot find $scriptPath" -ForegroundColor Red
    exit 1
}

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }

# git يكتب رسائل عادية على stderr، ومع ErrorActionPreference=Stop تتحول إلى
# أخطاء منهية في PowerShell 5.1 (لا في 7). كل نداءات git هنا تمرّ عبر هذا
# الغلاف الذي يخفض التفضيل مؤقتاً ويحكم برمز الخروج وحده.
function Invoke-Git {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & git @args 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
}

function New-Lock([string]$Status) {
    if ($Status -eq 'active') {
        return '{"schemaVersion":1,"status":"active","owner":"Claude","task":"t","branch":"b","files":[],"startedAt":"2026-08-31T23:08:18Z","updatedAt":"2026-08-31T23:08:18Z","pr":null,"note":"n"}'
    }
    return '{"schemaVersion":1,"status":"idle","owner":null,"task":null,"branch":null,"files":[],"startedAt":null,"updatedAt":"2026-09-05T12:20:09Z","pr":null,"note":"No active task."}'
}

# يبني: origin مجرّد + نسخة محلية، القفل فيهما بالحالة المطلوبة، ثم يضيف
# على origin كوميتاً جديداً (وقفلاً منشوراً بحالته النهائية) دون سحبه.
function New-Fixture([string]$LocalLock, [string]$PublishedLock) {
    $root   = Join-Path ([System.IO.Path]::GetTempPath()) ("dgp-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
    $origin = Join-Path $root 'origin.git'
    $work   = Join-Path $root 'seed'
    $local  = Join-Path $root 'local'
    New-Item -ItemType Directory -Force -Path $root | Out-Null

    Invoke-Git init --bare --initial-branch=main $origin
    Invoke-Git init --initial-branch=main $work
    Invoke-Git -C $work config user.email "t@t.t"
    Invoke-Git -C $work config user.name  "t"
    Set-Content -LiteralPath (Join-Path $work 'AI_ACTIVE_TASK.json') -Value (New-Lock $LocalLock) -Encoding UTF8
    # السكربت يشتقّ جذر المستودع من موضعه، فيُودَع **متعقَّباً** داخل المستودع
    # كما هو في الإنتاج؛ ونسخُه بعد الاستنساخ كان يجعل الشجرة متسخة فيتخطى
    # السكربت عند حارس الاتساخ قبل أن يبلغ منطق القفل أصلاً.
    New-Item -ItemType Directory -Force -Path (Join-Path $work 'tools') | Out-Null
    Copy-Item -LiteralPath $scriptPath -Destination (Join-Path $work 'tools\daily-git-pull.ps1') -Force
    # tools/logs مُستثنى في الإنتاج، والسكربت ينشئه قبل حارس الاتساخ.
    Set-Content -LiteralPath (Join-Path $work '.gitignore') -Value "tools/logs/" -Encoding UTF8
    Invoke-Git -C $work add -A
    Invoke-Git -C $work commit -m "seed"
    Invoke-Git -C $work remote add origin $origin
    Invoke-Git -C $work push -u origin main

    Invoke-Git clone $origin $local
    Invoke-Git -C $local config user.email "t@t.t"
    Invoke-Git -C $local config user.name  "t"

    # تقدُّم origin بكوميت جديد يحمل القفل المنشور بحالته النهائية.
    Set-Content -LiteralPath (Join-Path $work 'AI_ACTIVE_TASK.json') -Value (New-Lock $PublishedLock) -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $work 'newfile.txt') -Value "upstream" -Encoding UTF8
    Invoke-Git -C $work add -A
    Invoke-Git -C $work commit -m "upstream change"
    Invoke-Git -C $work push origin main

    return [pscustomobject]@{ Root = $root; Origin = $origin; Local = $local }
}

function Invoke-Script($fx) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fx.Local 'tools\daily-git-pull.ps1') 2>&1 | Out-Null }
    finally { $ErrorActionPreference = $old }
    $log = Join-Path $fx.Local 'tools\logs\daily-git-pull.log'
    if (Test-Path -LiteralPath $log) { return (Get-Content -LiteralPath $log -Raw) }
    return ''
}
function Head($path, $ref) { return ("$(& git -C $path rev-parse $ref 2>$null)").Trim() }

# ------------------------------------------------------------
# 1) العطل نفسه: قفل محلي قديم active بينما المنشور على main صار idle.
#    يجب أن يسحب — لا أن يبقى محبوساً خلف لقطة قديمة.
# ------------------------------------------------------------
Write-Host "1) stale local active lock + released lock on origin/main => must pull"
$fx = New-Fixture -LocalLock 'active' -PublishedLock 'idle'
try {
    $before = Head $fx.Local 'HEAD'
    $log    = Invoke-Script $fx
    $after  = Head $fx.Local 'HEAD'
    $remote = Head $fx.Local 'refs/remotes/origin/main'

    if ($log -match 'SKIP: active AI task lock') { Add-Failure "تخطّى بسبب قفل محلي قديم — العطل عاد" }
    elseif ($log -notmatch 'OK:')                { Add-Failure "لم يسجّل نجاحاً: $log" }
    else                                          { Add-Pass "سحب فعلاً رغم القفل المحلي القديم" }

    if ($after -eq $before) { Add-Failure "الفرع المحلي لم يتحرك" }
    elseif ($after -ne $remote) { Add-Failure "الفرع المحلي لا يطابق origin/main بعد السحب" }
    else { Add-Pass "الفرع المحلي صار على origin/main" }
} finally { Remove-Item -Recurse -Force $fx.Root -ErrorAction SilentlyContinue }

# ------------------------------------------------------------
# 2) منع التزامن الحقيقي سليم: قفل حيّ منشور على main => لا سحب.
#    لكن الجلب يجب أن يكون قد جرى، وإلا عادت الحلقة المغلقة.
# ------------------------------------------------------------
Write-Host "2) live published lock => must skip the rebase but still fetch"
$fx = New-Fixture -LocalLock 'idle' -PublishedLock 'active'
try {
    $before = Head $fx.Local 'HEAD'
    $log    = Invoke-Script $fx
    $after  = Head $fx.Local 'HEAD'
    $remote = Head $fx.Local 'refs/remotes/origin/main'

    if ($log -notmatch 'SKIP: active AI task lock') { Add-Failure "لم يحترم القفل الحيّ: $log" }
    else { Add-Pass "احترم القفل الحيّ ولم يسحب" }

    if ($after -ne $before) { Add-Failure "حرّك الفرع رغم القفل الحيّ" }
    else { Add-Pass "الفرع لم يتحرك" }

    # هذه هي النقطة الحاسمة: الجلب غير مشروط، فمرجع التتبّع تقدّم.
    if ($remote -eq $before) { Add-Failure "لم يجلب — أي أن قفلاً عالقاً سيحبس الجهاز مجدداً" }
    else { Add-Pass "الجلب جرى رغم القفل (لا حلقة مغلقة)" }
} finally { Remove-Item -Recurse -Force $fx.Root -ErrorAction SilentlyContinue }

# ------------------------------------------------------------
# 3) القفل الحيّ يُحترم حتى لو كانت النسخة المحلية تقول idle — الاتجاه
#    المعاكس من العطل نفسه (كان الجهاز يسحب وقفلٌ حيّ قائم على main).
# ------------------------------------------------------------
Write-Host "3) local says idle but published lock is active => must still skip"
$fx = New-Fixture -LocalLock 'idle' -PublishedLock 'active'
try {
    $log = Invoke-Script $fx
    if ($log -notmatch 'SKIP: active AI task lock') { Add-Failure "قرأ القفل من النسخة المحلية لا من المنشور: $log" }
    else { Add-Pass "المصدر هو القفل المنشور على origin/main" }
} finally { Remove-Item -Recurse -Force $fx.Root -ErrorAction SilentlyContinue }

# ------------------------------------------------------------
# 4) شجرة متسخة تبقى مانعة كما كانت — لا توسيع للنطاق.
# ------------------------------------------------------------
Write-Host "4) dirty working tree => must still skip (unchanged behaviour)"
$fx = New-Fixture -LocalLock 'idle' -PublishedLock 'idle'
try {
    Set-Content -LiteralPath (Join-Path $fx.Local 'dirty.txt') -Value "x" -Encoding UTF8
    Invoke-Git -C $fx.Local add -A
    $before = Head $fx.Local 'HEAD'
    $log    = Invoke-Script $fx
    $after  = Head $fx.Local 'HEAD'
    if ($log -notmatch 'SKIP: uncommitted changes present') { Add-Failure "لم يحترم الشجرة المتسخة: $log" }
    elseif ($after -ne $before) { Add-Failure "حرّك الفرع وشجرة العمل متسخة" }
    else { Add-Pass "الشجرة المتسخة ما زالت تمنع السحب" }
} finally { Remove-Item -Recurse -Force $fx.Root -ErrorAction SilentlyContinue }

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "FAILED: $($failures.Count)" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: daily-git-pull stale-lock regression" -ForegroundColor Green
exit 0
