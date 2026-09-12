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

# --- اختبار 1: Auth غير متاح عند البدء (يفشل مرتين ثم ينجح) — تحقق أن السكربت لا يخرج ---
$script:sessionCallCount = 0
function Session($Url,$Key,$Email,$Password) {
 $script:sessionCallCount++
 if ($script:sessionCallCount -le 2) { throw "Connection terminated due to connection timeout" }
 return @{ access_token = "fake-token-not-a-real-secret" }
}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$warnings = @()
$result = Get-AuthSession "https://example.invalid" "fake-key" "user@example.invalid" "fake-pass" 3>&1 | Tee-Object -Variable warnings | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
$sw.Stop()
Assert "الفشل المؤقت في auth لا ينهي العملية (لا استثناء غير ملتقط)" ($null -ne $result)
Assert "أول محاولة فشلت والثانية فشلت والثالثة نجحت (3 نداءات لـSession)" ($script:sessionCallCount -eq 3)
Assert "النجاح يحدث بعد فشل أول محاولة على الأقل" ($result.access_token -eq "fake-token-not-a-real-secret")
# backoff المتوقع: محاولة1 فشل -> sleep 5s، محاولة2 فشل -> sleep 10s، محاولة3 نجح = ~15s كحد أدنى
Assert "زمن الانتظار يعكس backoff تصاعدي (5s ثم 10s تقريباً، وليس فورياً)" ($sw.Elapsed.TotalSeconds -ge 14)

# --- اختبار 2: لا طباعة لأي كلمة مرور/مفتاح/token ضمن رسائل التحذير ---
$warnTexts = ($warnings | ForEach-Object { $_.Message }) -join " | "
Assert "لا توجد كلمة المرور الحقيقية ضمن نص أي تحذير" ($warnTexts -notmatch [regex]::Escape("fake-pass"))
Assert "لا يوجد المفتاح ضمن نص أي تحذير" ($warnTexts -notmatch [regex]::Escape("fake-key"))
Assert "لا يوجد access_token ضمن نص أي تحذير" ($warnTexts -notmatch "fake-token-not-a-real-secret")
Assert "رسائل auth attempt failed / retry delay موجودة كما هو مطلوب" (($warnTexts -match "auth attempt failed") -and ($warnTexts -match "retry delay"))
Assert "رسالة auth recovered ظهرت بعد نجاح تالٍ لفشل" ($warnTexts -match "auth recovered")

# --- اختبار 3: النجاح من أول محاولة لا يطبع "recovered" (تجنّب ضجيج غير ضروري) وليس هناك تأخير ---
$script:sessionCallCount = 0
function Session($Url,$Key,$Email,$Password) { $script:sessionCallCount++; return @{ access_token = "ok" } }
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$warnings2 = @()
$result2 = Get-AuthSession "u" "k" "e" "p" 3>&1 | Tee-Object -Variable warnings2 | Where-Object { $_ -isnot [System.Management.Automation.WarningRecord] }
$sw2.Stop()
Assert "نجاح أول محاولة فوري بدون أي انتظار" ($sw2.Elapsed.TotalSeconds -lt 2)
Assert "لا رسالة auth recovered عند نجاح أول محاولة مباشرة" (-not (($warnings2 | ForEach-Object { $_.Message }) -match "auth recovered"))

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

