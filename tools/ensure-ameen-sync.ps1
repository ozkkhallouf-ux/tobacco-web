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
# Fallback: the real sync host is the computer where the TOBACCO tasks are registered locally,
# even if its name differs from $MainComputerName (old name). Without this the watchdog skips
# task health checks on the machine that actually runs them.
if (-not $isMainComputer) {
  $hasLocalSyncTasks = [bool](Get-ScheduledTask -TaskName "TOBACCO Ameen Sync" -ErrorAction SilentlyContinue)
  if ($hasLocalSyncTasks) {
    $isMainComputer = $true
    Write-Log "INFO: local TOBACCO tasks found on $($env:COMPUTERNAME) - treating this computer as the sync host"
  }
}

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

# ---------- 2ب) TOBACCO Ameen Read Worker — فحص heartbeat (267009 وحدها لا تكفي) ----------
# العامل حلقة while($true) طويلة العمر — Task Scheduler يريها "Running" دائماً حتى لو تجمّدت
# فعلياً (تعليق شبكي بلا timeout قبل هذا الإصلاح). المقياس الموثوق الوحيد هو heartbeat محلي
# يكتبه العامل نفسه بعد كل دورة poll/idle ناجحة (انظر ameen-read-worker.ps1).
$ameenWorkerTaskName = "TOBACCO Ameen Read Worker"
$ameenWorkerHeartbeatPath = Join-Path $PSScriptRoot "logs\ameen-read-worker.heartbeat.json"
$ameenWorkerIncidentStatePath = Join-Path $logDirectory "ameen-read-worker-incident-state.json"
# 5 دقائق: دورة العامل الطبيعية ثوانٍ معدودة (PollSeconds افتراضي 3، وسقف Timeout لكل نداء شبكة 30 ثانية
# بحد أقصى)، فخمس دقائق تعطي هامشاً كبيراً (عشرات أضعاف الدورة الطبيعية) ضد أي تعثّر عابر، وبنفس الوقت
# أقصر من أي فاصل تشغيل معقول لهذا الحارس فلا تفوت حادثة كاملة.
$ameenWorkerStaleThresholdMinutes = 5

if ($isMainComputer) {
  $workerTask = Get-ScheduledTask -TaskName $ameenWorkerTaskName -ErrorAction SilentlyContinue
  if (-not $workerTask) {
    # احتياط: البحث بالاسم المباشر يفشل أحياناً في جلسة المُجدوِل غير التفاعلية، فنمر على القائمة الكاملة.
    $workerTask = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq $ameenWorkerTaskName } | Select-Object -First 1
  }
  $workerInfo = $null
  if ($workerTask) {
    $workerInfo = $workerTask | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    if (-not $workerInfo) { $workerInfo = Get-ScheduledTaskInfo -TaskName $ameenWorkerTaskName -ErrorAction SilentlyContinue }
  }

  # جلسة المُجدوِل غير التفاعلية لا ترى أحياناً كل المهام المسجّلة، فلا نعتبر غياب كائن المهمة
  # دليل عطل ما دام العامل يكتب نبضه. النبض هو المصدر الموثوق لصحة العامل.
  $heartbeatFreshEarly = $false
  if (Test-Path -LiteralPath $ameenWorkerHeartbeatPath) {
    try {
      $hbEarly = Get-Content -LiteralPath $ameenWorkerHeartbeatPath -Raw | ConvertFrom-Json
      $hbEarlyTime = [datetime]::Parse([string]$hbEarly.timestampUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
      $hbEarlyAge = [math]::Round(((Get-Date).ToUniversalTime() - $hbEarlyTime.ToUniversalTime()).TotalMinutes, 1)
      $heartbeatFreshEarly = ($hbEarlyAge -le $ameenWorkerStaleThresholdMinutes)
      if ((-not $workerTask) -and $heartbeatFreshEarly) { Write-Log ("INFO: worker task not visible in this session but heartbeat is fresh (" + $hbEarlyAge + " min) - treated as healthy") }
    } catch { }
  }

  if ((-not $workerTask) -and (-not $heartbeatFreshEarly)) {
    $problems.Add("المهمة «$ameenWorkerTaskName» غير مسجّلة أو متوقفة (لا نبض)")
    $diagAll = @(Get-ScheduledTask -ErrorAction SilentlyContinue); $diagNames = @($diagAll | Where-Object { $_.TaskName -like "TOBACCO *" } | ForEach-Object { $_.TaskName }); Write-Log ("FAIL: task not registered — [" + $ameenWorkerTaskName + "] | enumerated=" + $diagAll.Count + " | tobacco=" + ($diagNames -join ", "))
  } else {
    $heartbeatAgeMinutes = $null
    if (Test-Path -LiteralPath $ameenWorkerHeartbeatPath) {
      try {
        $hb = Get-Content -LiteralPath $ameenWorkerHeartbeatPath -Raw | ConvertFrom-Json
        $hbTime = [datetime]::Parse([string]$hb.timestampUtc, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
        $heartbeatAgeMinutes = [math]::Round(((Get-Date).ToUniversalTime() - $hbTime.ToUniversalTime()).TotalMinutes, 1)
      } catch {
        Write-Log "WARN: could not parse Ameen worker heartbeat — $($_.Exception.Message)"
      }
    }

    # عالقة = المهمة تظهر Running لكن heartbeat غائب أو أقدم من الحد المسموح
    $workerNotRunning = ($workerTask -and ([string]$workerTask.State -ne "Running"))
    $workerStuck = $workerNotRunning -or
                   (($null -eq $heartbeatAgeMinutes) -or ($heartbeatAgeMinutes -gt $ameenWorkerStaleThresholdMinutes))

    $prevIncidentActive = $false
    if (Test-Path -LiteralPath $ameenWorkerIncidentStatePath) {
      try { $prevIncidentActive = [bool]((Get-Content -LiteralPath $ameenWorkerIncidentStatePath -Raw | ConvertFrom-Json).stuck) } catch {}
    }

    if ($workerStuck) {
      $ageText = if ($null -eq $heartbeatAgeMinutes) { "heartbeat غير موجود" } else { "آخر heartbeat منذ $heartbeatAgeMinutes دقيقة" }
      Write-Log "STUCK: $ameenWorkerTaskName ($ageText)"

      if (-not $prevIncidentActive) {
        # حادثة جديدة فقط — تنبيه واحد، لا يتكرر كل تشغيل للحارس طالما الحادثة مستمرة
        $stuckMsg = "🚨 توقف/تعليق Ameen Read Worker — $ageText."
        $notifyPathWorker = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
        if (Test-Path -LiteralPath $notifyPathWorker) {
          $stuckNotifyOutput = & $notifyPathWorker -Message $stuckMsg -EventType "windows" -DedupeKey "ameen-read-worker-stuck" -DedupeMinutes 1440 2>&1 6>&1
          Write-Log ("ALERT sent for Ameen worker stuck incident — " + (($stuckNotifyOutput | Out-String).Trim() -replace "\s+", " "))
        }
      }

      # استعادة محددة لهذه المهمة فقط: لا kill عام لعمليات powershell، لا إعادة تشغيل لأي مهمة أخرى
      try {
        if ([string](Get-ScheduledTask -TaskName $ameenWorkerTaskName -ErrorAction SilentlyContinue).State -eq "Running") { Stop-ScheduledTask -TaskName $ameenWorkerTaskName -ErrorAction Stop }
        $waitDeadline = (Get-Date).AddSeconds(30)
        do {
          Start-Sleep -Seconds 2
          $stillRunning = ([string](Get-ScheduledTask -TaskName $ameenWorkerTaskName -ErrorAction SilentlyContinue).State) -eq "Running"
        } while ($stillRunning -and (Get-Date) -lt $waitDeadline)

        Start-ScheduledTask -TaskName $ameenWorkerTaskName -ErrorAction Stop
        Write-Log "RECOVERY ATTEMPT: restarted $ameenWorkerTaskName"
      } catch {
        Write-Log "FAIL: could not restart $ameenWorkerTaskName — $($_.Exception.Message)"
      }

      @{ stuck = $true; since = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $ameenWorkerIncidentStatePath -Encoding utf8
    } else {
      if ($prevIncidentActive) {
        # عاد للعمل بعد حادثة — تنبيه واحد فقط عند لحظة العودة
        $recoverMsg = "✅ عاد Ameen Read Worker للعمل."
        $notifyPathWorker = Join-Path $PSScriptRoot "send-telegram-notification.ps1"
        if (Test-Path -LiteralPath $notifyPathWorker) {
          $recoverNotifyOutput = & $notifyPathWorker -Message $recoverMsg -EventType "windows" -DedupeKey "ameen-read-worker-recovered" -DedupeMinutes 60 2>&1 6>&1
          Write-Log ("RECOVERY CONFIRMED for Ameen worker — " + (($recoverNotifyOutput | Out-String).Trim() -replace "\s+", " "))
        }
      }
      @{ stuck = $false } | ConvertTo-Json | Set-Content -LiteralPath $ameenWorkerIncidentStatePath -Encoding utf8
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
    $_.TaskName -ne "TOBACCO Sync Watchdog" -and
    $_.TaskName -ne "TOBACCO Local Web Server" -and   # مهمة خادم دائمة الحياة: تُفحص بالمنفذ لا بـ LastTaskResult
    $_.TaskName -ne $ameenWorkerTaskName   # يُفحص بفحص heartbeat مخصص أدقّ بالقسم ٢ب أعلاه — LastTaskResult=267009 وحده لا يكفي لمهمة تعمل بحلقة while($true)
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

# ---------- 3ب) سيرفر الموقع المحلي ----------
# مهمة «TOBACCO Local Web Server» تُبقي عملية node حيّة، فكل تشغيل جديد كل 5 دقائق يُرفض
# بالرمز 0x800710E0 لأن نسخة تعمل أصلاً — وهذه صحة لا عطل. المؤشر الحقيقي هو المنفذ.
if ($isMainComputer) {
  $localWebServerPort = 5173
  $localServerListening = Get-NetTCPConnection -LocalPort $localWebServerPort -State Listen -ErrorAction SilentlyContinue
  if (-not $localServerListening) {
    $problems.Add("سيرفر الموقع المحلي لا يستمع على المنفذ $localWebServerPort")
    Write-Log "FAIL: local web server not listening on port $localWebServerPort"
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
  $notifyOutput = & $notifyPath -Message $message -EventType "windows" -DedupeKey "ameen-sync-watchdog" -DedupeMinutes 60 2>&1 6>&1
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
