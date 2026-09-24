# اختبار انحدار لعطل إنتاجي حيّ (2026-09-24، جهاز OZK2026):
#
# حارس المزامنة (ensure-ameen-sync.ps1) يعمل بحساب OZKSync، ومهمة «TOBACCO Ameen Read Worker»
# تعمل بحساب LOQ ولا تمنح OZKSync قراءتها. بعد إقلاع فشل فيه تسجيل دخول المهمة توقف العامل،
# فرجع schtasks /Query «ERROR: Access is denied.» برمز غير صفري، وقرأه الحارس «غير مسجّلة
# (schtasks proved missing)» — فلم يفتح حادثة ولم يحاول الاستعادة، وبقي يرسل التنبيه العام كل
# 5 دقائق، ولم يصل «عاد للعمل» بعد التشغيل اليدوي لأن الحادثة لم تُسجَّل أصلاً.
#
# الإصلاح: رفض الصلاحية ليس غياباً. يُمرَّر لمسار النبض والحادثة العادي (stuck ثم recovered)
# بلا أي محاولة تشغيل أو رفع صلاحيات من هذا الحساب؛ الاستعادة يتولاها محفّز التكرار في المهمة.
#
# الاختبار يستخرج قسم العامل فعلياً من المصدر (لا نسخة يدوية قد تنحرف) وينفّذه مع بدائل وهمية
# لـGet-ScheduledTask وschtasks.exe وStart/Stop-ScheduledTask وسكربت الإشعار. لا Task Scheduler
# حقيقي، لا اتصال بالأمين، لا Supabase، لا Telegram.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ensureSrc = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "tools\ensure-ameen-sync.ps1")

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
  if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
  else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$sectionMatch = [regex]::Match($ensureSrc, '(\$ameenWorkerTaskName = "TOBACCO Ameen Read Worker"[\s\S]*?)\n# ---------- 3\)')
Assert 'تم إيجاد قسم Read Worker في ensure-ameen-sync' $sectionMatch.Success
if (-not $sectionMatch.Success) { Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"; exit 1 }

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("worker-access-denied-" + [Guid]::NewGuid().ToString("N"))
$tempLogs = Join-Path $tempDir "logs"
New-Item -ItemType Directory -Path $tempLogs -Force | Out-Null
$fakeDedupeLog = Join-Path $tempDir "dedupe-keys.log"
@'
param([string]$Message,[string]$EventType,[string]$DedupeKey,[string]$DedupeMinutes)
Add-Content -LiteralPath $env:FAKE_DEDUPE_LOG -Value $DedupeKey
Write-Host "TELEGRAM-NOTIFY OK ($EventType)"
exit 0
'@ | Set-Content -LiteralPath (Join-Path $tempDir "send-telegram-notification.ps1") -Encoding utf8
$env:FAKE_DEDUPE_LOG = $fakeDedupeLog

$quotedTemp = "'" + ($tempDir -replace "'", "''") + "'"
$sectionBody = $sectionMatch.Groups[1].Value -replace '\$PSScriptRoot', $quotedTemp
$logDirectory = $tempLogs
$heartbeatFile = Join-Path $tempLogs "ameen-read-worker.heartbeat.json"
$stateFile = Join-Path $tempLogs "ameen-read-worker-incident-state.json"

# ---- بدائل وهمية ----
function Write-Log([string]$Line) { $script:logLines.Add($Line) }
function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName) }   # جلسة لا ترى المهمة
function Get-ScheduledTaskInfo { [CmdletBinding()] param([string]$TaskName) }
function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName) $script:startCalls++; throw "Access is denied." }
function Stop-ScheduledTask { [CmdletBinding()] param([string]$TaskName) $script:stopCalls++ }
function Start-Sleep { [CmdletBinding()] param($Seconds) }
function schtasks.exe {
  $script:schtasksCalls.Add(($args -join ' '))
  $global:LASTEXITCODE = $script:fakeSchtasksExit
  $script:fakeSchtasksOut
}

function Set-Heartbeat([double]$AgeMinutes) {
  # نفس اللحظة بإزاحة محلية صريحة لا بـZ: PowerShell 7 يحوّل نص ISO في JSON إلى DateTime ويُسقط
  # علامة UTC عند إعادته نصاً، فينحرف العمر بفارق المنطقة الزمنية. الإنتاج (5.1) لا يتأثر، والصيغة
  # بالإزاحة تُقرأ صحيحة على الإصدارين معاً.
  @{ timestampUtc = (Get-Date).AddMinutes(-$AgeMinutes).ToString("o"); pid = 1; status = "ok" } |
    ConvertTo-Json | Set-Content -LiteralPath $heartbeatFile -Encoding utf8
}
function Reset-Cycle {
  $script:logLines = New-Object System.Collections.Generic.List[string]
  $script:schtasksCalls = New-Object System.Collections.Generic.List[string]
  $script:startCalls = 0
  $script:stopCalls = 0
  $script:problems = New-Object System.Collections.Generic.List[string]
  Remove-Item -LiteralPath $fakeDedupeLog -ErrorAction SilentlyContinue
}
function Read-State { if (Test-Path -LiteralPath $stateFile) { Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json } else { [pscustomobject]@{ stuck = $false; degraded = $false; stuckIncidentId = $null } } }
function Get-Keys { if (Test-Path -LiteralPath $fakeDedupeLog) { @(Get-Content -LiteralPath $fakeDedupeLog) } else { @() } }

$isMainComputer = $true
$accessDeniedOut = "ERROR: Access is denied."

try {
  # ---- ١: رفض صلاحية + نبض قديم، بلا حادثة سابقة ----
  Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
  Set-Heartbeat 60
  Reset-Cycle
  $problems = $script:problems
  $script:fakeSchtasksExit = 1; $script:fakeSchtasksOut = $accessDeniedOut
  Invoke-Expression $sectionBody
  $log1 = $script:logLines -join "`n"
  $state1 = Read-State
  $keys1 = Get-Keys
  Assert '1) لا ادّعاء «غير مسجّلة» عند رفض الصلاحية (سجل)' ($log1 -notmatch 'not registered')
  Assert '1) لا ادّعاء «غير مسجّلة» عند رفض الصلاحية (المشاكل)' (-not (@($problems) -match 'غير مسجّلة'))
  Assert '1) يُسجَّل ACCESS DENIED صراحة' ($log1 -match 'ACCESS DENIED: this account cannot read')
  Assert '1) يدخل مسار STUCK العادي' ($log1 -match 'STUCK: ')
  Assert '1) المشكلة المجمّعة تذكر غياب الصلاحية' ((@($problems) -join ' ') -match 'لا صلاحية لهذا الحساب')
  Assert '1) الحادثة مسجّلة stuck=true بهوية' ([bool]$state1.stuck -and -not [string]::IsNullOrEmpty([string]$state1.stuckIncidentId))
  Assert '1) تنبيه الحادثة بمفتاح الهوية' ($keys1 -contains "ameen-read-worker-stuck:$([string]$state1.stuckIncidentId)")
  Assert '1) لا محاولة Start-ScheduledTask من حساب بلا صلاحية' ($script:startCalls -eq 0)
  Assert '1) لا Stop-ScheduledTask' ($script:stopCalls -eq 0)
  Assert '1) لا schtasks /Run — استعلام واحد فقط' (($script:schtasksCalls.Count -eq 1) -and ($script:schtasksCalls[0] -match '^/Query'))
  Assert '1) RECOVERY SKIPPED مسجّل' ($log1 -match 'RECOVERY SKIPPED')
  $incidentId = [string]$state1.stuckIncidentId

  # ---- ٢: الدورة التالية — ما زال رفض، ما زال نبض قديم: نفس الحادثة ولا تنبيه مكرر ----
  Set-Heartbeat 65
  Reset-Cycle
  $problems = $script:problems
  Invoke-Expression $sectionBody
  $state2 = Read-State
  Assert '2) استمرار نفس الحادثة (نفس الهوية)' ([string]$state2.stuckIncidentId -eq $incidentId)
  Assert '2) لا تنبيه حادثة مكرر بعد نجاح الأول' ((Get-Keys).Count -eq 0)

  # ---- ٣: العامل عاد (محفّز المهمة الذاتي) — نبض طازج والمهمة ما زالت غير مرئية ----
  Set-Heartbeat 0
  Reset-Cycle
  $problems = $script:problems
  Invoke-Expression $sectionBody
  $state3 = Read-State
  $keys3 = Get-Keys
  Assert '3) تنبيه «عاد للعمل» بهوية الحادثة نفسها' ($keys3 -contains "ameen-read-worker-recovered:$incidentId")
  Assert '3) الحادثة مُغلقة بعد التأكيد' ((-not [bool]$state3.stuck) -and (-not [bool]$state3.degraded))
  Assert '3) لا schtasks مع نبض طازج' ($script:schtasksCalls.Count -eq 0)
  Assert '3) لا مشاكل مسجّلة' ($problems.Count -eq 0)

  # ---- ٤: غياب حقيقي (رمز غير صفري بلا رفض صلاحية) — السلوك القديم محفوظ ----
  Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
  Set-Heartbeat 60
  Reset-Cycle
  $problems = $script:problems
  $script:fakeSchtasksExit = 1; $script:fakeSchtasksOut = "ERROR: The system cannot find the file specified."
  Invoke-Expression $sectionBody
  $log4 = $script:logLines -join "`n"
  Assert '4) الغياب الحقيقي ما زال يُبلَّغ «not registered»' ($log4 -match 'FAIL: task not registered \(schtasks proved missing\)')
  Assert '4) لا ACCESS DENIED في الغياب الحقيقي' ($log4 -notmatch 'ACCESS DENIED')

  # ---- ٥: موجودة لكن غير مرئية (schtasks ينجح) — محاولة /Run القديمة محفوظة ----
  Set-Heartbeat 60
  Reset-Cycle
  $problems = $script:problems
  $script:fakeSchtasksExit = 0; $script:fakeSchtasksOut = "TaskName Next Run Time Status"
  Invoke-Expression $sectionBody
  Assert '5) مسار schtasks /Run محفوظ للمهمة الموجودة غير المرئية' ((@($script:schtasksCalls) -match '^/Run').Count -gt 0)
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\FAKE_DEDUPE_LOG -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==================================="
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
Write-Host "==================================="
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
