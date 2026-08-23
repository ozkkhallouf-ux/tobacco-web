# يتأكد أن سلسلة مزامنة الأمين → Supabase حيّة، ويعالج التوقف تلقائياً.
# يفحص أمرين:
#   1) الوصول الشبكي لقاعدة الأمين — SQL يعمل على جهاز آخر (OZK-TOBACCO) لا على هذا الجهاز،
#      فالفحص هو فتح المنفذ 1433 عبر الشبكة لا حالة خدمة محلية.
#   2) مهام المزامنة الحرجة — يعيد تشغيل ما تأخّر أو فشل منها.
# يرسل تنبيه تيليغرام واحداً مجمّعاً إذا بقي شيء معطّلاً بعد المحاولة (مرة كل ساعة).
# تشغّله مهمة «TOBACCO Sync Watchdog» كل 5 دقائق (سجّلها عبر register-ameen-sync-watchdog.ps1).
param(
  [string]$SqlHost = "OZK-TOBACCO",
  [int]$SqlPort = 1433,
  [string]$MainComputerName = "OZK-TOBACCO"
)

$ErrorActionPreference = "Continue"

$logDirectory = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path -LiteralPath $logDirectory)) {
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}
$logPath = Join-Path $logDirectory "ameen-sync-watchdog.log"

function Write-Log([string]$Line) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $logPath -Value "$stamp $Line"
}

# أقصى عمر مسموح لكل مهمة بالدقائق — ضعف دورتها تقريباً مع هامش
$criticalTasks = @(
  @{ Name = "TOBACCO Ameen Sync";              MaxAgeMinutes = 10 },
  @{ Name = "TOBACCO Invoice Series Push";     MaxAgeMinutes = 20 },
  @{ Name = "TOBACCO Approved Prices Pull";    MaxAgeMinutes = 20 },
  @{ Name = "TOBACCO Customer Movements Push"; MaxAgeMinutes = 20 }
)

# رموز Task Scheduler التي نحتاج تمييزها — لا نعتبرها كلها نجاحاً:
#   0x00000000 نجاح فعلي
#   0x00041301 قيد التشغيل الآن — سليم فقط إن كان انطلق حديثاً، وعالق إن طال
#   0x00041303 لم تعمل بعد — عطل بالنسبة لمهمة دورتها دقائق
$RESULT_SUCCESS = 0
$RESULT_RUNNING = 267009
$RESULT_NEVER_RAN = 267011

# LastRunTime يعود بقيمة حارسة قديمة جداً حين لم تعمل المهمة قط
$neverRanBefore = (Get-Date).AddYears(-1)

function Get-TaskRunAge($Info) {
  if (-not $Info.LastRunTime -or $Info.LastRunTime -lt $neverRanBefore) { return $null }
  return [math]::Round(((Get-Date) - $Info.LastRunTime).TotalMinutes, 1)
}

$problems = New-Object System.Collections.Generic.List[string]

# ---------- 1) الوصول لقاعدة الأمين عبر الشبكة ----------
# محاولتان بفاصل قصير — كي لا يطلق تعثّر شبكي عابر إنذاراً.
$sqlReachable = $false
foreach ($attempt in 1..2) {
  $probe = Test-NetConnection -ComputerName $SqlHost -Port $SqlPort -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
  if ($probe -and $probe.TcpTestSucceeded) {
    $sqlReachable = $true
    break
  }
  if ($attempt -eq 1) { Start-Sleep -Seconds 10 }
}
if (-not $sqlReachable) {
  $problems.Add("تعذّر الوصول لقاعدة الأمين على $SqlHost منفذ $SqlPort — تأكد أن جهاز الأمين يعمل وأنه على نفس الشبكة")
  Write-Log "FAIL: SQL host $SqlHost`:$SqlPort unreachable (2 attempts)"
}

# ---------- 2) مهام المزامنة ----------
$restarted = New-Object System.Collections.Generic.List[hashtable]

$isMainComputer = [string]::Equals(
  [string]$env:COMPUTERNAME,
  [string]$MainComputerName,
  [StringComparison]::OrdinalIgnoreCase
)

if (-not $isMainComputer) {
  Write-Log "INFO: secondary computer $($env:COMPUTERNAME) — remote SQL reachability only; local scheduled tasks belong to $MainComputerName and are not inspected here"
}

foreach ($entry in $(if ($isMainComputer) { $criticalTasks } else { @() })) {
  $name = $entry.Name
  $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
  if (-not $info) {
    $problems.Add("المهمة «$name» غير مسجّلة")
    Write-Log "FAIL: task not registered — $name"
    continue
  }

  $ageMinutes = Get-TaskRunAge $info
  $isStale = ($null -eq $ageMinutes) -or ($ageMinutes -gt $entry.MaxAgeMinutes)

  # مهمة عالقة قيد التشغيل: إعادة التشغيل لا تنفع (MultipleInstances = IgnoreNew)،
  # فنبلّغ عنها مباشرة بدل محاولة عبثية.
  if ($info.LastTaskResult -eq $RESULT_RUNNING -and $isStale) {
    $since = if ($null -eq $ageMinutes) { "وقت غير معروف" } else { "$ageMinutes دقيقة" }
    $problems.Add("«$name» عالقة قيد التشغيل منذ $since — أنهِ العملية يدوياً")
    Write-Log "FAIL: $name hung in running state ($since)"
    continue
  }

  $reasons = New-Object System.Collections.Generic.List[string]
  if ($null -eq $ageMinutes) {
    $reasons.Add("لم تعمل قط")
  } elseif ($ageMinutes -gt $entry.MaxAgeMinutes) {
    $reasons.Add("تأخّرت $ageMinutes دقيقة")
  }
  if ($info.LastTaskResult -eq $RESULT_NEVER_RAN) {
    $reasons.Add("لم تُنفَّذ بعد (0x00041303)")
  } elseif ($info.LastTaskResult -ne $RESULT_SUCCESS -and $info.LastTaskResult -ne $RESULT_RUNNING) {
    $code = "0x{0:X8}" -f $info.LastTaskResult
    $reasons.Add("آخر نتيجة $code")
  }

  if ($reasons.Count -eq 0) { continue }

  $why = ($reasons -join "، ")
  Write-Log "task needs revival — $name ($why)"
  $attemptedAt = Get-Date
  try {
    Start-ScheduledTask -TaskName $name -ErrorAction Stop
    $restarted.Add(@{ Name = $name; At = $attemptedAt })
  } catch {
    $problems.Add("«$name» ($why) وتعذّر تشغيلها: $($_.Exception.Message)")
    Write-Log "FAIL: could not start $name — $($_.Exception.Message)"
  }
}

# تحقق فعلي بعد المحاولة — لا نكتفي بإطلاق المهمة.
# الشرط: تشغيل جديد فعلاً (LastRunTime بعد لحظة الطلب) ونتيجته نجاح أو ما زال جارياً.
if ($restarted.Count -gt 0) {
  Start-Sleep -Seconds 30
  foreach ($item in $restarted) {
    $name = $item.Name
    $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
    $ranAfterRequest = $info -and $info.LastRunTime -and $info.LastRunTime -ge $item.At.AddSeconds(-5)
    $resultOk = $info -and ($info.LastTaskResult -eq $RESULT_SUCCESS -or $info.LastTaskResult -eq $RESULT_RUNNING)

    if ($ranAfterRequest -and $resultOk) {
      Write-Log "task revived — $name"
      continue
    }

    if (-not $info) {
      $problems.Add("«$name» أُعيد تشغيلها وتعذّر قراءة حالتها بعدها")
      Write-Log "FAIL: $name unreadable after restart"
    } elseif (-not $ranAfterRequest) {
      $problems.Add("«$name» طُلب تشغيلها ولم تنطلق فعلياً")
      Write-Log "FAIL: $name did not actually start after request"
    } else {
      $code = "0x{0:X8}" -f $info.LastTaskResult
      $problems.Add("«$name» أُعيد تشغيلها وما زالت تفشل ($code)")
      Write-Log "FAIL: $name still failing after restart ($code)"
    }
  }
}

# ---------- 3) كل مهام المشروع المسجّلة ----------
# نراقب تلقائياً أي مهمة TOBACCO موجودة على الجهاز الرئيسي حتى لا تحتاج
# إضافة اسمها يدوياً عند توسع المشروع. المهمة القديمة لفواتير الزبائن
# متقاعدة عمداً لأن رفعها أصبح جزءاً من TOBACCO Ameen Sync.
if ($isMainComputer) {
  $retiredTasks = @("TOBACCO Customer Invoices Push")
  $criticalNames = @($criticalTasks | ForEach-Object { [string]$_.Name })

  $projectTasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -like "TOBACCO *" -and
    $_.TaskName -notin $retiredTasks -and
    $_.TaskName -ne "TOBACCO Sync Watchdog"
  })

  foreach ($task in $projectTasks) {
    $name = [string]$task.TaskName
    if ($name -in $criticalNames) { continue }

    if ([string]$task.State -eq "Disabled") {
      $problems.Add("«$name» معطّلة في Windows Task Scheduler")
      Write-Log "FAIL: discovered project task disabled — $name"
      continue
    }

    $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
    if (-not $info) {
      $problems.Add("«$name» مسجّلة لكن تعذّرت قراءة حالتها")
      Write-Log "FAIL: discovered project task unreadable — $name"
      continue
    }

    if ($info.LastTaskResult -ne $RESULT_SUCCESS -and
        $info.LastTaskResult -ne $RESULT_RUNNING -and
        $info.LastTaskResult -ne $RESULT_NEVER_RAN) {
      $code = "0x{0:X8}" -f $info.LastTaskResult
      $age = Get-TaskRunAge $info
      $since = if ($null -eq $age) { "وقت غير معروف" } else { "منذ $age دقيقة" }
      $problems.Add("«$name» فشلت — آخر نتيجة $code، آخر تشغيل $since")
      Write-Log "FAIL: discovered project task failed — $name ($code, $since)"
    }
  }
}

# ---------- 4) التنبيه ----------
if ($problems.Count -eq 0) {
  exit 0
}

$message = "🚨 مزامنة الأمين متعثّرة على جهاز Windows:" + [Environment]::NewLine + (($problems | ForEach-Object { "• $_" }) -join [Environment]::NewLine)

# send-telegram-notification.ps1 لا يرمي استثناء ولا يعيد رمز خروج غير الصفر بالتصميم،
# فالدليل الوحيد على الإرسال هو نصّ مخرجاته — لا نسجّل «أُرسل» إلا إن رأيناه.
$notifySucceeded = $false
$notifyPath = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
if (Test-Path -LiteralPath $notifyPath) {
  $notifyOutput = & $notifyPath -Message $message -EventType "windows" -DedupeKey "ameen-sync-watchdog" -DedupeMinutes 60 2>&1
  $notifyText = ($notifyOutput | Out-String)
  if ($notifyText -match "TELEGRAM-NOTIFY OK") {
    $notifySucceeded = $true
  } else {
    Write-Log ("FAIL: telegram notify did not confirm — " + ($notifyText.Trim() -replace "\s+", " "))
  }
} else {
  Write-Log "FAIL: send-telegram-notification.ps1 not found at $notifyPath"
}

if ($notifySucceeded) {
  Write-Log "ALERT sent with $($problems.Count) problem(s)"
} else {
  Write-Log "ALERT NOT sent (delivery unconfirmed) with $($problems.Count) problem(s)"
}

exit 1
