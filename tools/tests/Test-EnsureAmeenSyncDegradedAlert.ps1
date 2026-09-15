# اختبار Codex P1 (PR #220): degradedAlerted بensure-ameen-sync.ps1 لا يُسجَّل إلا بعد نجاح
# فعلي من TELEGRAM-NOTIFY. قبل الإصلاح كان degraded=true يُسجَّل حتى لو فشل الإرسال، فتُحسب
# "تم التنبيه" رغم عدم الوصول ولا تُعاد المحاولة أبداً بالدورة التالية.
#
# + اختبار Codex P1 (جولة جديدة): مفتاح dedupe الثابت "ameen-read-worker-degraded" كان
# يجعل notify_telegram_dispatch يُسقط بصمت تنبيه حادثة degraded ثانية تقع خلال أقل من 60
# دقيقة من تنبيه حادثة سابقة، حتى لو تعافت العملية فعلياً بينهما. الإصلاح: هوية incident
# مستقلة (degradedIncidentId) تُلحَق بمفتاح الـdedupe، فحادثة جديدة تحصل على مفتاح مختلف
# بينما استمرار نفس الحادثة يبقي نفس المفتاح.
#
# الاختبار يستخرج جسم فرع elseif($workerDegraded) فعلياً من مصدر ensure-ameen-sync.ps1
# (لا نسخة يدوية منفصلة قد تنحرف عن الكود الحقيقي) وينفّذه بمتغيرات وهمية + سكريبت إشعار
# وهمي يُحاكي عقد send-telegram-notification.ps1 الفعلي: exit 0 دائماً (best-effort)،
# والنجاح يُميَّز فقط بنص الإخراج "TELEGRAM-NOTIFY OK". السكريبت الوهمي يسجّل أيضاً
# DedupeKey الذي استُدعي به كي يتحقق الاختبار من هوية الحادثة فعلياً لا افتراضاً.
#
# لا اتصال SQL بالأمين، لا نداء Supabase حقيقي، لا Telegram حقيقي.

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

$degradedBlockMatch = [regex]::Match($ensureSrc, '\}\s*elseif\s*\(\$workerDegraded\)\s*\{([\s\S]*?)\n\s*\}\s*else\s*\{')
Assert 'تم إيجاد جسم فرع elseif($workerDegraded) بensure-ameen-sync' $degradedBlockMatch.Success
if (-not $degradedBlockMatch.Success) {
  Write-Host ""
  Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
  exit 1
}

$tempTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("degraded-alert-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempTestDir -Force | Out-Null
$fakeNotifyPath = Join-Path $tempTestDir "send-telegram-notification.ps1"
$fakeStatePath = Join-Path $tempTestDir "incident-state.json"
$fakeDedupeLogPath = Join-Path $tempTestDir "dedupe-keys.log"

@'
param([string]$Message,[string]$EventType,[string]$DedupeKey,[string]$DedupeMinutes)
Add-Content -LiteralPath $env:FAKE_DEDUPE_LOG -Value $DedupeKey
if ($env:FAKE_NOTIFY_MODE -eq "OK") { Write-Host "TELEGRAM-NOTIFY OK ($EventType)" -ForegroundColor Green }
else { Write-Host "TELEGRAM-NOTIFY FAILED: simulated failure" -ForegroundColor Yellow }
exit 0
'@ | Set-Content -LiteralPath $fakeNotifyPath -Encoding utf8

$quotedTempDir = "'" + ($tempTestDir -replace "'", "''") + "'"
$degradedBody = $degradedBlockMatch.Groups[1].Value -replace '\$PSScriptRoot', $quotedTempDir
function Write-Log([string]$Line) {}
$ameenWorkerTaskName = "TOBACCO Ameen Read Worker (test)"
$env:FAKE_DEDUPE_LOG = $fakeDedupeLogPath

try {
  # سيناريو ١: إرسال ناجح => mark alerted (حادثة أولى، لا حادثة سابقة)
  $ameenWorkerIncidentStatePath = $fakeStatePath
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $fakeDedupeLogPath -ErrorAction SilentlyContinue
  $prevDegradedAlerted = $false
  $prevDegradedActive = $false
  $prevDegradedIncidentId = $null
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $degradedBody
  $state1 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '1) degraded أول مرة => alert (degradedAlerted=true بالمتغير)' ($degradedAlerted -eq $true)
  Assert '1) degraded أول مرة => alert (degradedAlerted=true بالحالة المحفوظة)' ([bool]$state1.degradedAlerted -eq $true)
  Assert '1) الحالة المحفوظة تحمل هوية incident (degradedIncidentId غير فارغة)' (-not [string]::IsNullOrEmpty([string]$state1.degradedIncidentId))
  $incident1Id = [string]$state1.degradedIncidentId
  $dedupeKeys1 = @(Get-Content -LiteralPath $fakeDedupeLogPath)
  Assert '1) مفتاح الـdedupe يتضمن هوية الحادثة الأولى' ($dedupeKeys1[-1] -eq "ameen-read-worker-degraded:$incident1Id")

  # سيناريو ٢: إرسال فاشل => لا mark alerted (تبقى قابلة لإعادة المحاولة)، نفس هوية الحادثة
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $fakeDedupeLogPath -ErrorAction SilentlyContinue
  $prevDegradedAlerted = $false
  $prevDegradedActive = $false
  $prevDegradedIncidentId = $null
  $env:FAKE_NOTIFY_MODE = "FAIL"
  Invoke-Expression $degradedBody
  $state2 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '2) إرسال فاشل => degradedAlerted=false بالمتغير (لا mark alerted رغم الفشل)' ($degradedAlerted -eq $false)
  Assert '2) إرسال فاشل => degradedAlerted=false بالحالة المحفوظة' ([bool]$state2.degradedAlerted -eq $false)

  # سيناريو ٣: دورة لاحقة بعد الفشل (استمرار نفس الحادثة: prevDegradedActive=true من حالة
  # سيناريو ٢) => يعيد المحاولة وينجح الآن، بنفس هوية الحادثة (بلا duplicate غير مقصود)
  $prevDegradedAlerted = [bool]$state2.degradedAlerted
  $prevDegradedActive = $true
  $prevDegradedIncidentId = [string]$state2.degradedIncidentId
  Assert '3) الدورة اللاحقة تقرأ prevDegradedAlerted=false من حالة الفشل السابق (لا قفل دائم)' ($prevDegradedAlerted -eq $false)
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $degradedBody
  $state3 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '3) دورة لاحقة بعد الفشل + نجاح => يعيد المحاولة ويُسجَّل alerted الآن' ($degradedAlerted -eq $true -and [bool]$state3.degradedAlerted -eq $true)
  Assert '3) استمرار نفس الحادثة (بعد retry) يبقي نفس هوية incident — لا duplicate غير مقصود' ([string]$state3.degradedIncidentId -eq $prevDegradedIncidentId)

  # سيناريو ٤ (b): recovery — العطل انتهى؛ الحالة المحفوظة تصير {stuck:false; degraded:false}
  # بلا degradedIncidentId (هذا ما يكتبه الفرع else الحقيقي في ensure-ameen-sync.ps1 عند التعافي).
  $recoveredState = @{ stuck = $false; degraded = $false }
  $recoveredState | ConvertTo-Json | Set-Content -LiteralPath $fakeStatePath -Encoding utf8
  $stateRecovered = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '4) recovery => لا حادثة نشطة محفوظة (degraded=false)' ([bool]$stateRecovered.degraded -eq $false)
  Assert '4) recovery => لا هوية incident متبقية من الحادثة المنتهية' ($null -eq $stateRecovered.degradedIncidentId)

  # سيناريو ٥ (c): degraded ثانٍ خلال أقل من 60 دقيقة من تنبيه الحادثة الأولى — لكن بعد
  # recovery حقيقي (prevDegradedActive=false، لا هوية سابقة) => حادثة جديدة، هوية جديدة،
  # ومفتاح dedupe مختلف تماماً عن مفتاح الحادثة الأولى (لا إسقاط صامت في notify_telegram)
  Remove-Item -LiteralPath $fakeDedupeLogPath -ErrorAction SilentlyContinue
  $prevDegradedAlerted = $false
  $prevDegradedActive = $false
  $prevDegradedIncidentId = $null
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $degradedBody
  $state5 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  $incident2Id = [string]$state5.degradedIncidentId
  $dedupeKeys5 = @(Get-Content -LiteralPath $fakeDedupeLogPath)
  Assert '5) degraded ثانٍ (بعد recovery) خلال <60m => alert جديد يُرسَل فعلياً' ($degradedAlerted -eq $true)
  Assert '5) degraded ثانٍ (بعد recovery) => هوية incident مختلفة عن الحادثة الأولى' ($incident2Id -ne $incident1Id)
  Assert '5) degraded ثانٍ (بعد recovery) => مفتاح dedupe مختلف تماماً عن مفتاح الحادثة الأولى (لا تصادم مع نافذة 60 دقيقة)' ($dedupeKeys5[-1] -ne "ameen-read-worker-degraded:$incident1Id" -and $dedupeKeys5[-1] -eq "ameen-read-worker-degraded:$incident2Id")
} finally {
  Remove-Item -LiteralPath $tempTestDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_NOTIFY_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_DEDUPE_LOG -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==================================="
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
Write-Host "==================================="
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
