# اختبار Codex P1 (PR #220، الجولة الثانية والجولة الجديدة فوقها): stuckAlerted
# بensure-ameen-sync.ps1 لا يُسجَّل إلا بعد نجاح فعلي من TELEGRAM-NOTIFY — بنفس معيار
# degradedAlerted تماماً (راجع Test-EnsureAmeenSyncDegradedAlert.ps1). قبل الإصلاح الأول
# كان stuck=true يُسجَّل بلا أي وعي بنجاح الإرسال، فتُحسب "تم التنبيه" رغم عدم الوصول ولا
# تُعاد المحاولة أبداً بالدورة التالية.
#
# الجولة الجديدة (Codex P1 لاحقة): مفتاح dedupe كان ثابتاً "ameen-read-worker-stuck" —
# فحادثة stuck ثانية تقع خلال أقل من نافذة الـdedupe (1440 دقيقة) من حادثة سابقة (حتى بعد
# تعافي العامل بينهما) كانت تصطدم بنفس المفتاح فيُسقطها notify_telegram_dispatch بصمت،
# ثم يُسجَّل stuckAlerted=true رغم عدم وصول التنبيه الجديد فعلياً. الإصلاح: هوية incident
# مستقلة (stuckIncidentId) بنفس مفهوم degradedIncidentId، تُلحَق بالمفتاح فتحصل كل حادثة
# stuck فعلية على نافذة dedupe مستقلة، وتُصفَّر عند العودة للعمل (فرع else الحالي أصلاً).
#
# الاختبار يستخرج جسم فرع if($workerStuck) فعلياً من مصدر ensure-ameen-sync.ps1 (لا نسخة
# يدوية منفصلة قد تنحرف عن الكود الحقيقي) وينفّذه بمتغيرات وهمية + سكريبت إشعار وهمي يُحاكي
# عقد send-telegram-notification.ps1 الفعلي: exit 0 دائماً (best-effort)، والنجاح يُميَّز فقط
# بنص الإخراج "TELEGRAM-NOTIFY OK". محاولة إعادة تشغيل المهمة المجدولة داخل الفرع تُترك كما
# هي (Get-ScheduledTask/Stop-ScheduledTask/Start-ScheduledTask) — تفشل بصمت لأن اسم المهمة
# الوهمي غير موجود فعلياً، ويُلتقط الفشل بـtry/catch الموجود أصلاً بالكود الحقيقي، فلا يؤثر
# على الاختبار. سكريبت الإشعار الوهمي يسجّل أيضاً DedupeKey الممرَّر لكل استدعاء في ملف
# سجل منفصل كي يتحقق الاختبار أن كل حادثة stuck فعلية تحصل على مفتاح مختلف.
#
# لا اتصال SQL بالأمين، لا نداء Supabase حقيقي، لا Telegram حقيقي، لا مهمة مجدولة حقيقية.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ensurePath = Join-Path $repoRoot "tools\ensure-ameen-sync.ps1"
$ensureSrc = Get-Content -Raw -LiteralPath $ensurePath

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
  if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
  else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$stuckBlockMatch = [regex]::Match($ensureSrc, '\}\s*if\s*\(\$workerStuck\)\s*\{([\s\S]*?)\n\s*\}\s*elseif\s*\(\$workerDegraded\)\s*\{')
Assert 'تم إيجاد جسم فرع if($workerStuck) بensure-ameen-sync' $stuckBlockMatch.Success
if (-not $stuckBlockMatch.Success) {
  Write-Host ""
  Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
  exit 1
}

$tempTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("stuck-alert-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempTestDir -Force | Out-Null
$fakeNotifyPath = Join-Path $tempTestDir "send-telegram-notification.ps1"
$fakeStatePath = Join-Path $tempTestDir "incident-state.json"
$dedupeKeyLogPath = Join-Path $tempTestDir "dedupe-keys.log"

@'
param([string]$Message,[string]$EventType,[string]$DedupeKey,[string]$DedupeMinutes)
Add-Content -LiteralPath $env:FAKE_NOTIFY_DEDUPE_LOG -Value $DedupeKey
if ($env:FAKE_NOTIFY_MODE -eq "OK") { Write-Host "TELEGRAM-NOTIFY OK ($EventType)" -ForegroundColor Green }
else { Write-Host "TELEGRAM-NOTIFY FAILED: simulated failure" -ForegroundColor Yellow }
exit 0
'@ | Set-Content -LiteralPath $fakeNotifyPath -Encoding utf8
$env:FAKE_NOTIFY_DEDUPE_LOG = $dedupeKeyLogPath

$quotedTempDir = "'" + ($tempTestDir -replace "'", "''") + "'"
$stuckBody = $stuckBlockMatch.Groups[1].Value -replace '\$PSScriptRoot', $quotedTempDir
function Write-Log([string]$Line) {}
$ameenWorkerTaskName = "TOBACCO Ameen Read Worker (test — لا وجود له فعلياً)"
$heartbeatAgeMinutes = 12
$problems = [System.Collections.Generic.List[string]]::new()

function Get-DedupeKeysSent {
  # @(...) إلزامي: Get-Content يُرجع نصاً منفرداً لا مصفوفة عند سطر واحد فقط، فيفشل .Count بصمت
  if (Test-Path -LiteralPath $dedupeKeyLogPath) { @(Get-Content -LiteralPath $dedupeKeyLogPath) }
  else { @() }
}
function Clear-DedupeKeysLog {
  Remove-Item -LiteralPath $dedupeKeyLogPath -ErrorAction SilentlyContinue
}

try {
  # (a) أول stuck => alert بمفتاح dedupe يحمل incident id جديد وغير فارغ
  $ameenWorkerIncidentStatePath = $fakeStatePath
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  Clear-DedupeKeysLog
  $prevStuckAlerted = $false
  $prevIncidentActive = $false
  $prevStuckIncidentId = $null
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $stuckBody
  $state1 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  $incidentId1 = [string]$state1.stuckIncidentId
  $keysSent1 = @(Get-DedupeKeysSent)
  Assert '(a) إرسال ناجح => stuckAlerted=true بالمتغير' ($stuckAlerted -eq $true)
  Assert '(a) إرسال ناجح => stuckAlerted=true بالحالة المحفوظة' ([bool]$state1.stuckAlerted -eq $true)
  Assert '(a) إرسال ناجح => المشكلة تُضاف للمجموع العام أيضاً' ($problems.Contains("Ameen Read Worker متوقفة/عالقة — آخر heartbeat منذ 12 دقيقة"))
  Assert '(a) الحالة المحفوظة تحمل stuckIncidentId غير فارغ' (-not [string]::IsNullOrEmpty($incidentId1))
  Assert '(a) مفتاح dedupe المُرسَل يحمل نفس stuckIncidentId' ($keysSent1.Count -eq 1 -and $keysSent1[0] -eq "ameen-read-worker-stuck:$incidentId1")

  # (b) استمرار نفس حادثة stuck (alerted سابقاً) => لا إرسال جديد غير مقصود، ونفس incident id
  $problems.Clear()
  Clear-DedupeKeysLog
  $prevStuckAlerted = $true
  $prevIncidentActive = $true
  $prevStuckIncidentId = $incidentId1
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $stuckBody
  $stateContinued = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '(b) استمرار نفس الحادثة => لا إرسال جديد (لا مفاتيح dedupe مُرسَلة)' ((Get-DedupeKeysSent).Count -eq 0)
  Assert '(b) استمرار نفس الحادثة => stuckIncidentId لم يتغيّر' ([string]$stateContinued.stuckIncidentId -eq $incidentId1)
  Assert '(b) استمرار نفس الحادثة => stuckAlerted يبقى true' ([bool]$stateContinued.stuckAlerted -eq $true)

  # (c) recovery: محاكاة فرع else (خارج نطاق استخراج هذا الاختبار) بكتابة نفس حالة التصفير
  # التي يكتبها الكود الحقيقي فعلياً عند العودة للعمل — بلا stuck ولا degraded ولا أي incident id.
  @{ stuck = $false; degraded = $false } | ConvertTo-Json | Set-Content -LiteralPath $fakeStatePath -Encoding utf8
  $recoveredState = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '(c) recovery => الحالة المحفوظة تصفّر stuck' ([bool]$recoveredState.stuck -eq $false)
  Assert '(c) recovery => لا يوجد stuckIncidentId متبقٍّ بعد العودة للعمل' ($null -eq $recoveredState.stuckIncidentId)

  # (d) stuck ثانٍ خلال أقل من نافذة الـdedupe (بعد recovery) => alert جديد بمفتاح مختلف عن (a)
  $problems.Clear()
  Clear-DedupeKeysLog
  $prevStuckAlerted = [bool]$recoveredState.stuckAlerted
  $prevIncidentActive = [bool]$recoveredState.stuck
  $prevStuckIncidentId = $null
  if ($recoveredState.PSObject.Properties.Name -contains 'stuckIncidentId') { $prevStuckIncidentId = [string]$recoveredState.stuckIncidentId }
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $stuckBody
  $state4 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  $incidentId2 = [string]$state4.stuckIncidentId
  $keysSent4 = @(Get-DedupeKeysSent)
  Assert '(d) حادثة stuck ثانية بعد recovery => stuckAlerted=true (تنبيه جديد فعلاً)' ($stuckAlerted -eq $true)
  Assert '(d) حادثة stuck ثانية => incident id جديد مختلف عن الحادثة الأولى' ($incidentId2 -ne $incidentId1 -and -not [string]::IsNullOrEmpty($incidentId2))
  Assert '(d) حادثة stuck ثانية => مفتاح dedupe مختلف عن مفتاح الحادثة الأولى' ($keysSent4.Count -eq 1 -and $keysSent4[0] -eq "ameen-read-worker-stuck:$incidentId2" -and $keysSent4[0] -ne $keysSent1[0])

  # (e) فشل الإرسال => لا mark alerted (تبقى قابلة لإعادة المحاولة)، ثم دورة لاحقة تنجح
  $problems.Clear()
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  Clear-DedupeKeysLog
  $prevStuckAlerted = $false
  $prevIncidentActive = $false
  $prevStuckIncidentId = $null
  $env:FAKE_NOTIFY_MODE = "FAIL"
  Invoke-Expression $stuckBody
  $state2 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '(e) إرسال فاشل => stuckAlerted=false بالمتغير (لا mark alerted رغم الفشل)' ($stuckAlerted -eq $false)
  Assert '(e) إرسال فاشل => stuckAlerted=false بالحالة المحفوظة' ([bool]$state2.stuckAlerted -eq $false)
  $incidentIdAfterFail = [string]$state2.stuckIncidentId

  # (e تابع) دورة لاحقة بعد الفشل (تقرأ الحالة المحفوظة: false، ونفس incident id لأن الحادثة
  # نفسها مستمرة) => يعيد المحاولة وينجح الآن بنفس مفتاح الحادثة — لا قفل دائم ولا مفتاح جديد
  # بلا داعٍ لمجرد إعادة المحاولة.
  Clear-DedupeKeysLog
  $prevStuckAlerted = [bool]$state2.stuckAlerted
  $prevIncidentActive = $true
  $prevStuckIncidentId = $incidentIdAfterFail
  Assert '(e) الدورة اللاحقة تقرأ prevStuckAlerted=false من حالة الفشل السابق (لا قفل دائم)' ($prevStuckAlerted -eq $false)
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $stuckBody
  $state3 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  $keysSentRetry = @(Get-DedupeKeysSent)
  Assert '(e) دورة لاحقة بعد الفشل + نجاح => يعيد المحاولة ويُسجَّل alerted الآن' ($stuckAlerted -eq $true -and [bool]$state3.stuckAlerted -eq $true)
  Assert '(e) إعادة المحاولة لنفس الحادثة => نفس incident id ونفس مفتاح dedupe (لا مفتاح جديد بلا داعٍ)' ([string]$state3.stuckIncidentId -eq $incidentIdAfterFail -and $keysSentRetry.Count -eq 1 -and $keysSentRetry[0] -eq "ameen-read-worker-stuck:$incidentIdAfterFail")
} finally {
  Remove-Item -LiteralPath $tempTestDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_NOTIFY_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_NOTIFY_DEDUPE_LOG -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==================================="
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
Write-Host "==================================="
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
