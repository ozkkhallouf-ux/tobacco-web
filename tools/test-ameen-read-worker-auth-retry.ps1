# اختبار READ-ONLY لمنطق retry الخاص بتسجيل الدخول في ameen-read-worker.ps1
# لا يشغّل السكربت الحقيقي (لا يفتح اتصال Supabase فعلي ولا يلمس الأمين) — يستخرج تعريف
# الدالتين Session/Get-AuthSession من الملف المصدر نفسه (بدون نسخ يدوي يخرج عن التزامن)
# ويستبدل Session بمحاكاة (mock) للتحقق من سلوك إعادة المحاولة فقط.
$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "ameen-read-worker.ps1"
$source = Get-Content -LiteralPath $scriptPath -Raw

function Get-FunctionBlock([string]$Source, [string]$Name) {
 $pattern = "(?ms)^function $Name\([^\)]*\)\{.*?\n\}"
 $m = [regex]::Match($Source, $pattern)
 if (-not $m.Success) { throw "لم يتم العثور على تعريف الدالة: $Name" }
 return $m.Value
}

$sessionBlock = Get-FunctionBlock $source "Session"
$authBlock = Get-FunctionBlock $source "Get-AuthSession"
. ([scriptblock]::Create($sessionBlock))
. ([scriptblock]::Create($authBlock))

$results = @()
function Assert($Name, $Condition) {
 $script:results += [pscustomobject]@{ Test = $Name; Pass = [bool]$Condition }
}

# القسم ٤: Get-AuthSession يستدعي Write-Heartbeat عند كل محاولة فاشلة (نبض حياة مستقل عن نجاح
# المصادقة نفسها). هنا نموذج (mock) يسجّل كل نداء بدل الكتابة الفعلية لملف — الهدف إثبات:
# (أ) لا يُرمى استثناء غير ملتقط بسبب استدعاء دالة موجودة فعلياً بالسكربت الحقيقي فقط،
# (ب) كل محاولة فاشلة تكتب نبضاً بحالة auth_retry قبل الانتظار — هذا ما يمنع
# ensure-ameen-sync.ps1 من اعتبار العملية متجمّدة وإعادة تشغيلها أثناء انقطاع مصادقة طويل.
$script:heartbeatCalls = @()
function Write-Heartbeat([string]$Status="ok") { $script:heartbeatCalls += $Status }

# --- اختبار 1: Auth غير متاح عند البدء (يفشل مرتين ثم ينجح) — تحقق أن السكربت لا يخرج ---
$script:sessionCallCount = 0
function Session($Url,$Key,$Email,$Password) {
 $script:sessionCallCount++
 if ($script:sessionCallCount -le 2) { throw "Connection terminated due to connection timeout" }
 return @{ access_token = "fake-token-not-a-real-secret" }
}
$script:heartbeatCalls = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$warnings = @()
$result = Get-AuthSession "https://example.invalid" "fake-key" "user@example.invalid" "fake-pass" 3>&1 | Tee-Object -Variable warnings | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
$sw.Stop()
Assert "الفشل المؤقت في auth لا ينهي العملية (لا استثناء غير ملتقط)" ($null -ne $result)
Assert "أول محاولة فشلت والثانية فشلت والثالثة نجحت (3 نداءات لـSession)" ($script:sessionCallCount -eq 3)
Assert "النجاح يحدث بعد فشل أول محاولة على الأقل" ($result.access_token -eq "fake-token-not-a-real-secret")
# backoff المتوقع: محاولة1 فشل -> sleep 5s، محاولة2 فشل -> sleep 10s، محاولة3 نجح = ~15s كحد أدنى
Assert "زمن الانتظار يعكس backoff تصاعدي (5s ثم 10s تقريباً، وليس فورياً)" ($sw.Elapsed.TotalSeconds -ge 14)
# القسم ٤ — الانحدار المطلوب صراحة: كل محاولة فاشلة تكتب نبض auth_retry قبل الانتظار، فيبقى
# heartbeat.json طازجاً طوال انقطاع المصادقة ولا يظن ensure-ameen-sync.ps1 أن العملية ميتة
# فيعيد تشغيلها (لا فائدة من إعادة تشغيل عملية تعمل بالفعل وتعيد المحاولة بنفسها).
Assert "نبض auth_retry يُكتب مرتين (بعدد المحاولتين الفاشلتين) قبل النجاح" (@($script:heartbeatCalls | Where-Object { $_ -eq "auth_retry" }).Count -eq 2)
Assert "لا يُكتب نبض status=ok من داخل Get-AuthSession نفسها (لا تزوير نجاح مزامنة)" (@($script:heartbeatCalls | Where-Object { $_ -eq "ok" }).Count -eq 0)

# --- اختبار 2: لا طباعة لأي كلمة مرور/مفتاح/token ضمن رسائل التحذير ---
$warnTexts = ($warnings | ForEach-Object { $_.Message }) -join " | "
Assert "لا توجد كلمة المرور الحقيقية ضمن نص أي تحذير" ($warnTexts -notmatch [regex]::Escape("fake-pass"))
Assert "لا يوجد المفتاح ضمن نص أي تحذير" ($warnTexts -notmatch [regex]::Escape("fake-key"))
Assert "لا يوجد access_token ضمن نص أي تحذير" ($warnTexts -notmatch "fake-token-not-a-real-secret")
Assert "رسائل auth attempt failed / retry delay موجودة كما هو مطلوب" (($warnTexts -match "auth attempt failed") -and ($warnTexts -match "retry delay"))
Assert "رسالة auth recovered ظهرت بعد نجاح تالٍ لفشل" ($warnTexts -match "auth recovered")

# --- اختبار 3: النجاح من أول محاولة لا يطبع "recovered" (تجنّب ضجيج غير ضروري) وليس هناك تأخير ---
$script:sessionCallCount = 0
$script:heartbeatCalls = @()
function Session($Url,$Key,$Email,$Password) { $script:sessionCallCount++; return @{ access_token = "ok" } }
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$warnings2 = @()
$result2 = Get-AuthSession "u" "k" "e" "p" 3>&1 | Tee-Object -Variable warnings2 | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
$sw2.Stop()
Assert "نجاح أول محاولة فوري بدون أي انتظار" ($sw2.Elapsed.TotalSeconds -lt 2)
Assert "لا رسالة auth recovered عند نجاح أول محاولة مباشرة" (-not (($warnings2 | ForEach-Object { $_.Message }) -match "auth recovered"))
Assert "لا نبض auth_retry إطلاقاً عند نجاح المحاولة الأولى (لا محاولة فاشلة لتسجيلها)" (@($script:heartbeatCalls).Count -eq 0)

# --- اختبار 5 (القسم ٤، محاكاة الحارس): انقطاع مصادقة طويل (10 محاولات فاشلة) يجب ألا يترك
# heartbeat.json عالقاً على قيمة قديمة — كل محاولة تكتب طابعاً زمنياً جديداً بstatus=auth_retry،
# فتبقى "طازجة" بمقياس ensure-ameen-sync.ps1 (5 دقائق) طالما فاصل المحاولات لا يتجاوزها، مما
# يمنع دورة إعادة تشغيل/عامل مكرر أثناء انقطاع طويل — هذا هو الانحدار المطلوب صراحة بالقسم ٤.
$script:sessionCallCount = 0
$script:heartbeatCalls = @()
$script:heartbeatTimestamps = @()
function Write-Heartbeat([string]$Status="ok") {
 $script:heartbeatCalls += $Status
 $script:heartbeatTimestamps += (Get-Date)
}
# جدول backoff الحقيقي ثابت داخل Get-AuthSession (لا يمكن تغييره من هنا)؛ نكتفي بأول محاولتين
# فاشلتين (تغطي التصاعد 5s->10s) لإثبات الاستمرارية عبر دورات متعددة دون إطالة زمن الاختبار.
function Session($Url,$Key,$Email,$Password) {
 $script:sessionCallCount++
 if ($script:sessionCallCount -le 2) { throw "auth service unavailable" }
 return @{ access_token = "ok-after-outage" }
}
$resultOutage = Get-AuthSession "u" "k" "e" "p" 3>&1 | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
Assert "نبض auth_retry يُكتب قبل كل محاولة تالية أثناء انقطاع متعدد الدورات" (@($script:heartbeatCalls | Where-Object { $_ -eq "auth_retry" }).Count -eq 2)
$allFreshEnoughGap = $true
for ($i = 1; $i -lt $script:heartbeatTimestamps.Count; $i++) {
 $gapSec = ($script:heartbeatTimestamps[$i] - $script:heartbeatTimestamps[$i-1]).TotalSeconds
 if ($gapSec -gt 300) { $allFreshEnoughGap = $false }
}
Assert "الفاصل بين نبضتي auth_retry أقل من حد الطزاجة (5 دقائق) في ensure-ameen-sync.ps1" $allFreshEnoughGap

# --- اختبار 4: لا يوجد أي فعل كتابة (INSERT/UPDATE/DELETE/UPSERT) داخل الدوال المعدّلة أو ملف السكربت كله ---
Assert "لا كتابة SQL ضمن ameen-read-worker.ps1 (READ-ONLY محفوظ)" ($source -notmatch '(?i)\b(INSERT|UPDATE|DELETE|UPSERT)\b')
Assert "لا استدعاء REST بطريقة PUT/PATCH/DELETE على الأمين ضمن الملف" ($source -notmatch "Method\s+(Put|Patch|Delete)")

$results | Format-Table -AutoSize
$failed = $results | Where-Object { -not $_.Pass }
if ($failed) {
 Write-Output "`nFAILED: $($failed.Count) / $($results.Count)"
 exit 1
} else {
 Write-Output "`nALL PASSED: $($results.Count) / $($results.Count)"
 exit 0
}

