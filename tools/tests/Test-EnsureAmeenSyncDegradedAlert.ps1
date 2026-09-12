# اختبار Codex P1 (PR #220): degradedAlerted بensure-ameen-sync.ps1 لا يُسجَّل إلا بعد نجاح
# فعلي من TELEGRAM-NOTIFY. قبل الإصلاح كان degraded=true يُسجَّل حتى لو فشل الإرسال، فتُحسب
# "تم التنبيه" رغم عدم الوصول ولا تُعاد المحاولة أبداً بالدورة التالية.
#
# الاختبار يستخرج جسم فرع elseif($workerDegraded) فعلياً من مصدر ensure-ameen-sync.ps1
# (لا نسخة يدوية منفصلة قد تنحرف عن الكود الحقيقي) وينفّذه بمتغيرات وهمية + سكريبت إشعار
# وهمي يُحاكي عقد send-telegram-notification.ps1 الفعلي: exit 0 دائماً (best-effort)،
# والنجاح يُميَّز فقط بنص الإخراج "TELEGRAM-NOTIFY OK".
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

@'
param([string]$Message,[string]$EventType,[string]$DedupeKey,[string]$DedupeMinutes)
if ($env:FAKE_NOTIFY_MODE -eq "OK") { Write-Host "TELEGRAM-NOTIFY OK ($EventType)" -ForegroundColor Green }
else { Write-Host "TELEGRAM-NOTIFY FAILED: simulated failure" -ForegroundColor Yellow }
exit 0
'@ | Set-Content -LiteralPath $fakeNotifyPath -Encoding utf8

$quotedTempDir = "'" + ($tempTestDir -replace "'", "''") + "'"
$degradedBody = $degradedBlockMatch.Groups[1].Value -replace '\$PSScriptRoot', $quotedTempDir
function Write-Log([string]$Line) {}
$ameenWorkerTaskName = "TOBACCO Ameen Read Worker (test)"

try {
  # سيناريو ١: إرسال ناجح => mark alerted
  $ameenWorkerIncidentStatePath = $fakeStatePath
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  $prevDegradedAlerted = $false
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $degradedBody
  $state1 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '1) إرسال ناجح => degradedAlerted=true بالمتغير' ($degradedAlerted -eq $true)
  Assert '1) إرسال ناجح => degradedAlerted=true بالحالة المحفوظة' ([bool]$state1.degradedAlerted -eq $true)

  # سيناريو ٢: إرسال فاشل => لا mark alerted (تبقى قابلة لإعادة المحاولة)
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  $prevDegradedAlerted = $false
  $env:FAKE_NOTIFY_MODE = "FAIL"
  Invoke-Expression $degradedBody
  $state2 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '2) إرسال فاشل => degradedAlerted=false بالمتغير (لا mark alerted رغم الفشل)' ($degradedAlerted -eq $false)
  Assert '2) إرسال فاشل => degradedAlerted=false بالحالة المحفوظة' ([bool]$state2.degradedAlerted -eq $false)

  # سيناريو ٣: دورة لاحقة بعد الفشل (تقرأ الحالة المحفوظة من سيناريو ٢: false) => يعيد المحاولة وينجح الآن
  $prevDegradedAlerted = [bool]$state2.degradedAlerted
  Assert '3) الدورة اللاحقة تقرأ prevDegradedAlerted=false من حالة الفشل السابق (لا قفل دائم)' ($prevDegradedAlerted -eq $false)
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $degradedBody
  $state3 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '3) دورة لاحقة بعد الفشل + نجاح => يعيد المحاولة ويُسجَّل alerted الآن' ($degradedAlerted -eq $true -and [bool]$state3.degradedAlerted -eq $true)
} finally {
  Remove-Item -LiteralPath $tempTestDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_NOTIFY_MODE -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==================================="
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
Write-Host "==================================="
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
