# اختبار Codex P1 (PR #220، الجولة الثانية): stuckAlerted بensure-ameen-sync.ps1 لا يُسجَّل
# إلا بعد نجاح فعلي من TELEGRAM-NOTIFY — بنفس معيار degradedAlerted تماماً (راجع
# Test-EnsureAmeenSyncDegradedAlert.ps1). قبل الإصلاح كان stuck=true يُسجَّل بلا أي وعي
# بنجاح الإرسال، فتُحسب "تم التنبيه" رغم عدم الوصول ولا تُعاد المحاولة أبداً بالدورة التالية.
#
# الاختبار يستخرج جسم فرع if($workerStuck) فعلياً من مصدر ensure-ameen-sync.ps1 (لا نسخة
# يدوية منفصلة قد تنحرف عن الكود الحقيقي) وينفّذه بمتغيرات وهمية + سكريبت إشعار وهمي يُحاكي
# عقد send-telegram-notification.ps1 الفعلي: exit 0 دائماً (best-effort)، والنجاح يُميَّز فقط
# بنص الإخراج "TELEGRAM-NOTIFY OK". محاولة إعادة تشغيل المهمة المجدولة داخل الفرع تُترك كما
# هي (Get-ScheduledTask/Stop-ScheduledTask/Start-ScheduledTask) — تفشل بصمت لأن اسم المهمة
# الوهمي غير موجود فعلياً، ويُلتقط الفشل بـtry/catch الموجود أصلاً بالكود الحقيقي، فلا يؤثر
# على الاختبار.
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

@'
param([string]$Message,[string]$EventType,[string]$DedupeKey,[string]$DedupeMinutes)
if ($env:FAKE_NOTIFY_MODE -eq "OK") { Write-Host "TELEGRAM-NOTIFY OK ($EventType)" -ForegroundColor Green }
else { Write-Host "TELEGRAM-NOTIFY FAILED: simulated failure" -ForegroundColor Yellow }
exit 0
'@ | Set-Content -LiteralPath $fakeNotifyPath -Encoding utf8

$quotedTempDir = "'" + ($tempTestDir -replace "'", "''") + "'"
$stuckBody = $stuckBlockMatch.Groups[1].Value -replace '\$PSScriptRoot', $quotedTempDir
function Write-Log([string]$Line) {}
$ameenWorkerTaskName = "TOBACCO Ameen Read Worker (test — لا وجود له فعلياً)"
$heartbeatAgeMinutes = 12
$problems = [System.Collections.Generic.List[string]]::new()

try {
  # سيناريو ١: إرسال ناجح => mark alerted
  $ameenWorkerIncidentStatePath = $fakeStatePath
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  $prevStuckAlerted = $false
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $stuckBody
  $state1 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '1) إرسال ناجح => stuckAlerted=true بالمتغير' ($stuckAlerted -eq $true)
  Assert '1) إرسال ناجح => stuckAlerted=true بالحالة المحفوظة' ([bool]$state1.stuckAlerted -eq $true)
  Assert '1) إرسال ناجح => المشكلة تُضاف للمجموع العام أيضاً' ($problems.Contains("Ameen Read Worker متوقفة/عالقة — آخر heartbeat منذ 12 دقيقة"))

  # سيناريو ٢: إرسال فاشل => لا mark alerted (تبقى قابلة لإعادة المحاولة)
  $problems.Clear()
  Remove-Item -LiteralPath $fakeStatePath -ErrorAction SilentlyContinue
  $prevStuckAlerted = $false
  $env:FAKE_NOTIFY_MODE = "FAIL"
  Invoke-Expression $stuckBody
  $state2 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '2) إرسال فاشل => stuckAlerted=false بالمتغير (لا mark alerted رغم الفشل)' ($stuckAlerted -eq $false)
  Assert '2) إرسال فاشل => stuckAlerted=false بالحالة المحفوظة' ([bool]$state2.stuckAlerted -eq $false)

  # سيناريو ٣: دورة لاحقة بعد الفشل (تقرأ الحالة المحفوظة من سيناريو ٢: false) => يعيد
  # المحاولة وينجح الآن — لا قفل دائم على الإرسال بمجرد استمرار الحالة العالقة.
  $prevStuckAlerted = [bool]$state2.stuckAlerted
  Assert '3) الدورة اللاحقة تقرأ prevStuckAlerted=false من حالة الفشل السابق (لا قفل دائم)' ($prevStuckAlerted -eq $false)
  $env:FAKE_NOTIFY_MODE = "OK"
  Invoke-Expression $stuckBody
  $state3 = Get-Content -Raw -LiteralPath $fakeStatePath | ConvertFrom-Json
  Assert '3) دورة لاحقة بعد الفشل + نجاح => يعيد المحاولة ويُسجَّل alerted الآن' ($stuckAlerted -eq $true -and [bool]$state3.stuckAlerted -eq $true)
} finally {
  Remove-Item -LiteralPath $tempTestDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_NOTIFY_MODE -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==================================="
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
Write-Host "==================================="
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
