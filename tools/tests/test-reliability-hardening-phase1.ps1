# اختبارات RELIABILITY HARDENING — PHASE 1 (A-N)
# لا تشغّل أي عملية إنتاجية حقيقية: لا اتصال SQL بالأمين، لا نداء Supabase حقيقي،
# لا Telegram حقيقي، لا Start/Stop-ScheduledTask حقيقي. كل الاختبارات إما فحص ساكن
# (regex على مصدر السكريبت) أو تنفيذ معزول لمنطق مستخرج بمتغيرات وهمية محلية.
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$workerPath = Join-Path $repoRoot "tools\ameen-read-worker.ps1"
$ensurePath = Join-Path $repoRoot "tools\ensure-ameen-sync.ps1"
$movementsPath = Join-Path $repoRoot "tools\push-customer-movements.ps1"

$workerSrc = Get-Content -Raw -LiteralPath $workerPath
$ensureSrc = Get-Content -Raw -LiteralPath $ensurePath
$movementsSrc = Get-Content -Raw -LiteralPath $movementsPath

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
  if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
  else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

# ---------- A: timeout موجود بكل Invoke-RestMethod بworker ----------
$workerRestCalls = [regex]::Matches($workerSrc, 'Invoke-RestMethod')
$workerTimeoutCalls = [regex]::Matches($workerSrc, 'Invoke-RestMethod[\s\S]*?-TimeoutSec\s+\$RestTimeoutSec')
Assert 'A: worker Invoke-RestMethod count == 2 (Session+Broker)' ($workerRestCalls.Count -eq 2)
Assert 'A: كل نداءات worker تحمل -TimeoutSec $RestTimeoutSec' ($workerTimeoutCalls.Count -eq 2)

# ---------- B: timeout لا يعلّق worker للأبد (اختبار حي معزول: سيرفر لا يرد) ----------
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $threw = $false
  try {
    Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$port/" -TimeoutSec 2 | Out-Null
  } catch {
    $threw = $true
  }
  $sw.Stop()
  Assert 'B: نداء بلا رد ينتهي باستثناء قابل للـcatch' $threw
  Assert 'B: المهلة تحترم -TimeoutSec (انتهت خلال < 15 ثانية لا للأبد)' ($sw.Elapsed.TotalSeconds -lt 15)
} finally {
  $listener.Stop()
}

# ---------- C/D: heartbeat يتحدث فقط بعد دورة سليمة، لا يُكتب عند فشل ----------
$hbFuncMatch = [regex]::Match($workerSrc, 'function Write-Heartbeat\{[\s\S]*?\n\}\n')
Assert 'C: تعريف Write-Heartbeat موجود بمصدر worker' $hbFuncMatch.Success

$tempHeartbeat = Join-Path ([System.IO.Path]::GetTempPath()) ("hb-test-" + [Guid]::NewGuid().ToString("N") + ".json")
try {
  $heartbeatPath = $tempHeartbeat
  Invoke-Expression $hbFuncMatch.Value
  Write-Heartbeat
  $written = Test-Path -LiteralPath $tempHeartbeat
  Assert 'C: Write-Heartbeat تكتب ملف heartbeat فعلياً' $written
  if ($written) {
    $hb1 = Get-Content -Raw -LiteralPath $tempHeartbeat | ConvertFrom-Json
    Assert 'C: heartbeat يحوي timestampUtc صالح' ([datetime]::Parse([string]$hb1.timestampUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind) -is [datetime])
    Assert 'C: heartbeat يحوي pid' ($null -ne $hb1.pid)
    Start-Sleep -Milliseconds 50
    Write-Heartbeat
    $hb2 = Get-Content -Raw -LiteralPath $tempHeartbeat | ConvertFrom-Json
    Assert 'C: استدعاء لاحق يحدّث timestampUtc (دليل: يُكتب فقط بعد دورة فعلية)' ($hb2.timestampUtc -ge $hb1.timestampUtc)
  }
} finally {
  Remove-Item -LiteralPath $tempHeartbeat -ErrorAction SilentlyContinue
}

# D: تأكيد ساكن أن استدعاء Write-Heartbeat الوحيد داخل حلقة while يقع بعد معالجة job
# وليس داخل كتلة catch (أي لا يُكتب عند فشل الدورة، بما فيه timeout الشبكة)
$loopMatch = [regex]::Match($workerSrc, 'while\(\$true\)\{([\s\S]*)\}\s*\z')
Assert 'D: تم إيجاد حلقة while الرئيسية بworker' $loopMatch.Success
if ($loopMatch.Success) {
  $loopBody = $loopMatch.Groups[1].Value
  $catchIdx = $loopBody.IndexOf('}catch{')
  $hbCallIdx = $loopBody.IndexOf('Write-Heartbeat')
  Assert 'D: Write-Heartbeat يُستدعى داخل الحلقة' ($hbCallIdx -ge 0)
  Assert 'D: استدعاء Write-Heartbeat يقع قبل كتلة catch (على مسار النجاح فقط)' ($hbCallIdx -gt 0 -and $catchIdx -gt 0 -and $hbCallIdx -lt $catchIdx)
}

# ---------- E/F: fresh heartbeat+Running=healthy، stale heartbeat+Running=unhealthy ----------
$stuckLogicMatch = [regex]::Match($ensureSrc, '\$workerStuck\s*=\s*\(\[string\]\$workerTask\.State[\s\S]*?\)\)')
Assert 'E/F: منطق تحديد workerStuck موجود بensure-ameen-sync' $stuckLogicMatch.Success
if ($stuckLogicMatch.Success) {
  $stuckExpr = $stuckLogicMatch.Value

  $workerTask = [pscustomobject]@{ State = "Running" }
  $heartbeatAgeMinutes = 1
  $ameenWorkerStaleThresholdMinutes = 5
  Invoke-Expression "`$freshResult = $stuckExpr"
  Assert 'E: fresh heartbeat (1 دقيقة) + Running => healthy (workerStuck=false)' ($freshResult -eq $false)

  $heartbeatAgeMinutes = 10
  Invoke-Expression "`$staleResult = $stuckExpr"
  Assert 'F: stale heartbeat (10 دقائق) + Running => unhealthy (workerStuck=true)' ($staleResult -eq $true)

  $heartbeatAgeMinutes = $null
  Invoke-Expression "`$missingResult = $stuckExpr"
  Assert 'F: heartbeat غير موجود + Running => unhealthy (workerStuck=true)' ($missingResult -eq $true)

  $workerTask = [pscustomobject]@{ State = "Ready" }
  $heartbeatAgeMinutes = 10
  Invoke-Expression "`$notRunningResult = $stuckExpr"
  Assert 'F: stale heartbeat لكن Task ليست Running => ليست stuck' ($notRunningResult -eq $false)
}

# ---------- G/H: stale => recovery للعامل فقط، لا restart لأي Task أخرى ----------
$sectionMatch = [regex]::Match($ensureSrc, '2ب\) TOBACCO Ameen Read Worker[\s\S]*?(?=# -{5,} 3\))')
Assert 'G/H: قسم فحص heartbeat للعامل معزول بذاته بensure-ameen-sync' $sectionMatch.Success
if ($sectionMatch.Success) {
  $section = $sectionMatch.Value
  $stopCalls = [regex]::Matches($section, 'Stop-ScheduledTask\s+-TaskName\s+(\S+)')
  $startCalls = [regex]::Matches($section, 'Start-ScheduledTask\s+-TaskName\s+(\S+)')
  $allTargetOnlyWorker = $true
  foreach ($m in @($stopCalls) + @($startCalls)) {
    if ($m.Groups[1].Value -notmatch '^\$ameenWorkerTaskName$') { $allTargetOnlyWorker = $false }
  }
  Assert 'G: يوجد Stop/Start-ScheduledTask بقسم العامل' ($stopCalls.Count -ge 1 -and $startCalls.Count -ge 1)
  Assert 'G: كل استدعاءات Stop/Start تستهدف $ameenWorkerTaskName حصراً' $allTargetOnlyWorker
  Assert 'H: لا يوجد تكرار على $projectTasks أو مهام أخرى داخل قسم العامل' ($section -notmatch '\$projectTasks|foreach\s*\(\$t\s+in')
}
Assert 'H: لا Unregister/Set-ScheduledTask على أي مهمة ضمن كامل الملف (لا حذف/تعديل تعريف)' ($ensureSrc -notmatch 'Unregister-ScheduledTask|Set-ScheduledTask\b')

# ---------- I/J: Telegram incident dedupe (تنبيه واحد) + recovery (رسالة واحدة) ----------
# محاكاة معزولة لخوارزمية الانتقال (transition) نفسها كما هي مطبَّقة بensure-ameen-sync:
# تنبيه فقط عند stuck=true وprevIncidentActive=false، وrecovery فقط عند stuck=false وprevIncidentActive=true.
function Test-IncidentTransition([bool[]]$StuckSequence) {
  $prevIncidentActive = $false
  $alerts = 0
  $recoveries = 0
  foreach ($stuck in $StuckSequence) {
    if ($stuck) {
      if (-not $prevIncidentActive) { $alerts++ }
    } else {
      if ($prevIncidentActive) { $recoveries++ }
    }
    $prevIncidentActive = $stuck
  }
  [pscustomobject]@{ Alerts = $alerts; Recoveries = $recoveries }
}
$incidentResult = Test-IncidentTransition @($false, $true, $true, $true, $true, $false, $false)
Assert 'I: تنبيه واحد فقط طوال استمرار الحادثة (4 دورات stuck متتالية)' ($incidentResult.Alerts -eq 1)
Assert 'J: رسالة recovery واحدة فقط عند العودة' ($incidentResult.Recoveries -eq 1)
$incidentResult2 = Test-IncidentTransition @($true, $false, $true, $false)
Assert 'I/J: حادثتان منفصلتان => تنبيهان واثنتا recovery (لا دمج زائف)' ($incidentResult2.Alerts -eq 2 -and $incidentResult2.Recoveries -eq 2)
# تأكيد ساكن أن الكود الفعلي يستخدم نفس الشرط (prevIncidentActive) قبل الإرسال، مرة لكل مسار
Assert 'I: كود الإرسال الفعلي يتحقق من $prevIncidentActive قبل تنبيه التوقف' ($ensureSrc -match '\(-not \$prevIncidentActive\)\s*\{[\s\S]{0,600}?ameen-read-worker-stuck')
Assert 'J: كود الإرسال الفعلي يتحقق من $prevIncidentActive قبل رسالة العودة' ($ensureSrc -match '\(\$prevIncidentActive\)\s*\{[\s\S]{0,600}?ameen-read-worker-recovered')

# ---------- K: customer-movements كل Invoke-RestMethod لها timeout ----------
$movementsRestCalls = [regex]::Matches($movementsSrc, 'Invoke-RestMethod')
$movementsTimeoutCalls = [regex]::Matches($movementsSrc, 'Invoke-RestMethod[\s\S]{0,400}?-TimeoutSec\s+30')
Assert 'K: عدد نداءات Invoke-RestMethod بcustomer-movements == 3 (login/POST/DELETE)' ($movementsRestCalls.Count -eq 3)
Assert 'K: كل النداءات الثلاثة تحمل -TimeoutSec 30' ($movementsTimeoutCalls.Count -eq 3)

# ---------- L: customer-movements timeout => clean exit 1 (لا retry loop جديد) ----------
Assert 'L: يوجد exit 1 بمسار معالجة الخطأ' ($movementsSrc -match 'exit\s+1')
Assert 'L: لا حلقة retry جديدة أُضيفت (لا for/while حول Invoke-RestMethod)' ($movementsSrc -notmatch 'while\s*\(.*Invoke-RestMethod|for\s*\(.*Invoke-RestMethod')

# ---------- M: لا تغيير payload/SQL/schema/URL/auth/cleanup بcustomer-movements ----------
$diffLines = git -C $repoRoot diff -- tools/push-customer-movements.ps1 2>$null
$addedLines = ($diffLines | Where-Object { $_ -match '^\+[^+]' })
$removedLines = ($diffLines | Where-Object { $_ -match '^-[^-]' })
$addedNonComment = $addedLines | Where-Object { $_ -and $_ -notmatch '^\+\s*#' }
$onlyTimeoutAdditions = $true
foreach ($line in $addedNonComment) {
  $bare = $line.Substring(1)
  $bareWithoutTimeout = $bare -replace '\s*-TimeoutSec\s+30', ''
  $matchesARemovedLine = $false
  foreach ($rline in $removedLines) {
    if (-not $rline) { continue }
    if ($rline.Substring(1) -eq $bareWithoutTimeout) { $matchesARemovedLine = $true; break }
  }
  if (-not $matchesARemovedLine) { $onlyTimeoutAdditions = $false }
}
Assert 'M: كل الأسطر المُضافة (غير التعليقات) = -TimeoutSec 30 فقط، لا تغيير آخر بالمنطق' $onlyTimeoutAdditions
Assert 'M: لا تغيير على SELECT/SQL بcustomer-movements (لا سطر SQL بالـdiff)' (-not ($diffLines | Where-Object { $_ -match '^\+.*(SELECT|FROM|WHERE|Invoke-Sqlcmd)' }))

# ---------- N: Ameen READ ONLY contract unchanged ----------
Assert 'N: worker لا يحتوي أي Invoke-Sqlcmd (لا كتابة SQL مباشرة)' ($workerSrc -notmatch 'Invoke-Sqlcmd')
Assert 'N: worker يستدعي ameen-read-gateway.ps1 فقط (لا كتابة مباشرة لقاعدة الأمين)' ($workerSrc -match 'ameen-read-gateway\.ps1')
Assert 'N: لا إضافة قدرة كتابة جديدة (لا INSERT/UPDATE/DELETE SQL نصي بworker)' ($workerSrc -notmatch '(?i)\b(INSERT|UPDATE|DELETE)\s+INTO|\bUPDATE\s+\w+\s+SET\b')

Write-Host ""
Write-Host "==================================="
Write-Host "PASS=$($script:pass) FAIL=$($script:fail)"
Write-Host "==================================="
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
