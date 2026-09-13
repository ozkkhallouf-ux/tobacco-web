# اختبار READ-ONLY لمنطق retry الخاص بتسجيل الدخول في ameen-read-worker.ps1
# لا يشغّل السكربت الحقيقي (لا يفتح اتصال Supabase فعلي ولا يلمس الأمين) — يستخرج تعريف
# الدالتين Session/Get-AuthSession من الملف المصدر نفسه (بدون نسخ يدوي يخرج عن التزامن)
# ويستبدل Session وGet-AmeenCredentials بمحاكاة (mock) للتحقق من سلوك إعادة المحاولة فقط.
#
# Codex P1 (جولة رابعة): Get-AuthSession لم يعد يستقبل بيانات الاعتماد كمعاملات ثابتة —
# يستدعي Get-AmeenCredentials من جديد في بداية كل محاولة، فتُلتقط أي قيمة مصحَّحة/مدوَّرة
# فوراً دون إعادة تشغيل العملية يدوياً. الاختبارات هنا تحاكي Get-AmeenCredentials بدالة
# قابلة للتغيّر بين النداءات (تماماً كما تُحاكى Session وWrite-Heartbeat) للتحقق من:
# (1) بيانات بدء تشغيل خاطئة تدخل retry، (2) تصحيح البيانات أثناء retry يُلتقط بالمحاولة
# التالية وينجح بلا إعادة تشغيل، (3) بيانات لا تتغير تستمر بـretry/backoff بلا انحدار،
# (4) لا تسريب لأي سر ضمن warnings مهما كانت القيم المستخدمة.
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

# Get-AmeenCredentials نفسها غير مستخرَجة من المصدر عمداً — Get-AuthSession (المستخرَجة أعلاه)
# تستدعيها بالاسم فقط، فيكفي تعريف محاكاة بنفس الاسم في هذا النطاق ليُحلّها PowerShell ديناميكياً
# بالضبط كما تُحاكى Write-Heartbeat أدناه دون الحاجة لاستخراجها هي الأخرى.

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

# --- اختبار 1: بيانات اعتماد خاطئة عند البدء (تفشل مرتين ثم تنجح) — تحقق أن السكربت لا يخرج ---
$script:sessionCallCount = 0
$script:credCallCount1 = 0
function Get-AmeenCredentials() {
 $script:credCallCount1++
 [pscustomobject]@{ Url = "https://example.invalid"; Key = "fake-key"; Email = "user@example.invalid"; Password = "fake-pass" }
}
function Session($Url,$Key,$Email,$Password) {
 $script:sessionCallCount++
 if ($script:sessionCallCount -le 2) { throw "Connection terminated due to connection timeout" }
 return @{ access_token = "fake-token-not-a-real-secret" }
}
$script:heartbeatCalls = @()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$warnings = @()
$result = Get-AuthSession 3>&1 | Tee-Object -Variable warnings | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
$sw.Stop()
Assert "الفشل المؤقت في auth لا ينهي العملية (لا استثناء غير ملتقط)" ($null -ne $result)
Assert "أول محاولة فشلت والثانية فشلت والثالثة نجحت (3 نداءات لـSession)" ($script:sessionCallCount -eq 3)
Assert "النجاح يحدث بعد فشل أول محاولة على الأقل" ($result.Session.access_token -eq "fake-token-not-a-real-secret")
Assert "Url/Key المُرجَعان من Get-AuthSession مطابقان لآخر بيانات اعتماد قُرئت" (($result.Url -eq "https://example.invalid") -and ($result.Key -eq "fake-key"))
# بيانات الاعتماد تُقرأ من جديد في بداية كل محاولة (وليس مرة واحدة قبل الحلقة) — 3 محاولات = 3 قراءات.
Assert "بيانات الاعتماد أُعيدت قراءتها في كل محاولة (3 نداءات لـGet-AmeenCredentials بعدد محاولات Session)" ($script:credCallCount1 -eq 3)
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
function Get-AmeenCredentials() { [pscustomobject]@{ Url = "u"; Key = "k"; Email = "e"; Password = "p" } }
function Session($Url,$Key,$Email,$Password) { $script:sessionCallCount++; return @{ access_token = "ok" } }
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$warnings2 = @()
$result2 = Get-AuthSession 3>&1 | Tee-Object -Variable warnings2 | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
$sw2.Stop()
Assert "نجاح أول محاولة فوري بدون أي انتظار" ($sw2.Elapsed.TotalSeconds -lt 2)
Assert "لا رسالة auth recovered عند نجاح أول محاولة مباشرة" (-not (($warnings2 | ForEach-Object { $_.Message }) -match "auth recovered"))
Assert "لا نبض auth_retry إطلاقاً عند نجاح المحاولة الأولى (لا محاولة فاشلة لتسجيلها)" (@($script:heartbeatCalls).Count -eq 0)

# --- اختبار 4 (سيناريو Codex P1 — جوهر الإصلاح): بيانات الاعتماد خاطئة عند البدء، تُصحَّح
# أثناء انقطاع المصادقة (محاكاة تدوير كلمة السر بمتغير بيئة خارجي بينما العامل داخل حلقة
# retry)، والمحاولة التالية تلتقط القيمة الجديدة وتنجح بلا أي إعادة تشغيل يدوية للعملية. ---
$script:credCallCount4 = 0
$script:passwordsSeenBySession = @()
function Get-AmeenCredentials() {
 $script:credCallCount4++
 # أول محاولتين: بيانات قديمة خاطئة. من الثالثة فصاعداً: بيانات "مصحَّحة" — تحاكي تدوير
 # TOBACCO_SYNC_PASSWORD في البيئة أثناء أن العامل لا يزال داخل حلقة retry نفسها.
 if ($script:credCallCount4 -le 2) {
  [pscustomobject]@{ Url = "https://example.invalid"; Key = "old-key"; Email = "user@example.invalid"; Password = "old-wrong-pass" }
 } else {
  [pscustomobject]@{ Url = "https://example.invalid"; Key = "new-key"; Email = "user@example.invalid"; Password = "new-correct-pass" }
 }
}
function Session($Url,$Key,$Email,$Password) {
 $script:passwordsSeenBySession += $Password
 if ($Password -ne "new-correct-pass") { throw "Invalid login credentials" }
 return @{ access_token = "token-after-credential-fix" }
}
$script:heartbeatCalls = @()
$warnings4 = @()
$result4 = Get-AuthSession 3>&1 | Tee-Object -Variable warnings4 | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
Assert "بعد تصحيح بيانات الاعتماد أثناء retry، المحاولة التالية تلتقطها وتنجح بلا restart" ($result4.Session.access_token -eq "token-after-credential-fix")
Assert "Url/Key المُرجَعان يعكسان بيانات الاعتماد الجديدة (مصحَّحة) لا القديمة" (($result4.Url -eq "https://example.invalid") -and ($result4.Key -eq "new-key"))
Assert "أول محاولتين استُدعيتا بكلمة السر القديمة الخاطئة والثالثة بالجديدة الصحيحة (لا تخزين مؤقت لبيانات قديمة)" (
 ($script:passwordsSeenBySession.Count -eq 3) -and
 ($script:passwordsSeenBySession[0] -eq "old-wrong-pass") -and
 ($script:passwordsSeenBySession[1] -eq "old-wrong-pass") -and
 ($script:passwordsSeenBySession[2] -eq "new-correct-pass")
)
$warnTexts4 = ($warnings4 | ForEach-Object { $_.Message }) -join " | "
Assert "لا تسريب لكلمة السر القديمة أو الجديدة ضمن أي رسالة تحذير" (($warnTexts4 -notmatch [regex]::Escape("old-wrong-pass")) -and ($warnTexts4 -notmatch [regex]::Escape("new-correct-pass")))
Assert "لا تسريب للمفتاح الجديد ضمن أي رسالة تحذير" ($warnTexts4 -notmatch [regex]::Escape("new-key"))

# --- اختبار 5 (لا انحدار — بيانات الاعتماد تبقى خاطئة باستمرار): انقطاع مصادقة طويل (10
# محاولات فاشلة) بلا أي تصحيح خارجي يجب أن يستمر بـretry/backoff العادي دون أي حلقة إعادة
# تشغيل عدوانية، ودون أن يترك heartbeat.json عالقاً على قيمة قديمة — كل محاولة تكتب طابعاً
# زمنياً جديداً بـstatus=auth_retry فتبقى "طازجة" بمقياس ensure-ameen-sync.ps1 (5 دقائق). ---
$script:sessionCallCount = 0
$script:heartbeatCalls = @()
$script:heartbeatTimestamps = @()
$script:credCallCount5 = 0
function Write-Heartbeat([string]$Status="ok") {
 $script:heartbeatCalls += $Status
 $script:heartbeatTimestamps += (Get-Date)
}
function Get-AmeenCredentials() {
 $script:credCallCount5++
 # نفس بيانات الاعتماد الخاطئة في كل نداء — لا تصحيح خارجي في هذا السيناريو.
 [pscustomobject]@{ Url = "u"; Key = "k"; Email = "e"; Password = "p" }
}
# جدول backoff الحقيقي ثابت داخل Get-AuthSession (لا يمكن تغييره من هنا)؛ نكتفي بأول محاولتين
# فاشلتين (تغطي التصاعد 5s->10s) لإثبات الاستمرارية عبر دورات متعددة دون إطالة زمن الاختبار.
function Session($Url,$Key,$Email,$Password) {
 $script:sessionCallCount++
 if ($script:sessionCallCount -le 2) { throw "auth service unavailable" }
 return @{ access_token = "ok-after-outage" }
}
$resultOutage = Get-AuthSession 3>&1 | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
Assert "نبض auth_retry يُكتب قبل كل محاولة تالية أثناء انقطاع متعدد الدورات" (@($script:heartbeatCalls | Where-Object { $_ -eq "auth_retry" }).Count -eq 2)
Assert "بيانات الاعتماد غير المتغيّرة لا تُوقف إعادة المحاولة (بلا انحدار) — 3 قراءات لـ3 محاولات" ($script:credCallCount5 -eq 3)
$allFreshEnoughGap = $true
for ($i = 1; $i -lt $script:heartbeatTimestamps.Count; $i++) {
 $gapSec = ($script:heartbeatTimestamps[$i] - $script:heartbeatTimestamps[$i-1]).TotalSeconds
 if ($gapSec -gt 300) { $allFreshEnoughGap = $false }
}
Assert "الفاصل بين نبضتي auth_retry أقل من حد الطزاجة (5 دقائق) في ensure-ameen-sync.ps1" $allFreshEnoughGap

# --- اختبار 6: لا يوجد أي فعل كتابة (INSERT/UPDATE/DELETE/UPSERT) داخل الملف كله (READ-ONLY محفوظ) ---
Assert "لا كتابة SQL ضمن ameen-read-worker.ps1 (READ-ONLY محفوظ)" ($source -notmatch '(?i)\b(INSERT|UPDATE|DELETE|UPSERT)\b')
Assert "لا استدعاء REST بطريقة PUT/PATCH/DELETE على الأمين ضمن الملف" ($source -notmatch "Method\s+(Put|Patch|Delete)")

# --- اختبار 7: عزل الإصلاح — Get-AmeenCredentials تقرأ فقط أربعة متغيرات بيانات الاعتماد
# (لا تعيد تحميل أي إعداد آخر مثل RestTimeoutSec أو مسار heartbeat) ---
# ملاحظة: Get-AmeenCredentials مكتوبة بالكامل على سطر واحد (بلا \n قبل الـ"}" الختامية)،
# فـGet-FunctionBlock (المصمَّمة لدوال متعددة الأسطر) لا تناسبها — تُستخرج هنا بمطابقة السطر
# نفسه فقط عبر $ (نهاية السطر) بدل \n} كي لا تلتقط محتوى الدوال التالية في الملف خطأً.
$credBlockMatch = [regex]::Match($source, "(?m)^function Get-AmeenCredentials\([^\)]*\)\{.*\}$")
if (-not $credBlockMatch.Success) { throw "لم يتم العثور على تعريف الدالة: Get-AmeenCredentials" }
$credBlock = $credBlockMatch.Value
Assert "Get-AmeenCredentials تقرأ بيانات الاعتماد الأربعة فقط عبر Require-Env" (
 ($credBlock -match "TOBACCO_SUPABASE_URL") -and
 ($credBlock -match "TOBACCO_SUPABASE_PUBLIC_KEY") -and
 ($credBlock -match "TOBACCO_SYNC_EMAIL") -and
 ($credBlock -match "TOBACCO_SYNC_PASSWORD") -and
 (@([regex]::Matches($credBlock, "Require-Env")).Count -eq 4)
)
Assert "Get-AmeenCredentials لا تلمس RestTimeoutSec أو heartbeatPath (فصل إعادة تحميل الاعتماد عن باقي الإعدادات)" (
 ($credBlock -notmatch "RestTimeoutSec") -and ($credBlock -notmatch "heartbeatPath")
)

$results | Format-Table -AutoSize
$failed = $results | Where-Object { -not $_.Pass }
if ($failed) {
 Write-Output "`nFAILED: $($failed.Count) / $($results.Count)"
 exit 1
} else {
 Write-Output "`nALL PASSED: $($results.Count) / $($results.Count)"
 exit 0
}
