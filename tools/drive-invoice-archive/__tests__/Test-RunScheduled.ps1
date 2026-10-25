# اختبار غلاف التشغيل المجدول run-scheduled.ps1 تحت Windows PowerShell 5.1 (وPowerShell 7).
# بلا أمين ولا Drive ولا Supabase ولا Telegram: worker.js عامل وهمي (fake-worker.js) يشغّله
# node حقيقي، وكل الملفات والقفل في مجلد مؤقت باسم فريد. لا يسجّل أي مهمة مجدولة.

$ErrorActionPreference = 'Stop'
$toolDir = Split-Path -Parent $PSScriptRoot
$wrapper = Join-Path $toolDir 'run-scheduled.ps1'
$fakeWorker = Join-Path $PSScriptRoot 'fake-worker.js'
$psExe = (Get-Process -Id $PID).Path
$node = (Get-Command node -ErrorAction Stop).Source

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('drive-archive-run-test-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $tempRoot -Force)
$mutexName = 'Global\OZK-DriveArchive-Test-' + [guid]::NewGuid().ToString('N')

function New-Env([string]$Mode = 'dry-run', [switch]$NoConfig) {
    $root = Join-Path $tempRoot ([guid]::NewGuid().ToString('N'))
    $workerDir = Join-Path $root 'app'
    $logDir = Join-Path $root 'logs'
    [void](New-Item -ItemType Directory -Path $workerDir -Force)
    Copy-Item -LiteralPath $fakeWorker -Destination (Join-Path $workerDir 'worker.js')
    if (-not $NoConfig) {
        $cfg = '{ "mode": "' + $Mode + '", "archiveFrom": "2026-11-01", "edgeUrl": "" }'
        # BOM عمداً: Notepad على Windows يحفظ به، والغلاف يجب أن يقرأه.
        [IO.File]::WriteAllText((Join-Path $workerDir 'config.json'), $cfg, (New-Object Text.UTF8Encoding($true)))
    }
    return [pscustomobject]@{ Root = $root; WorkerDir = $workerDir; LogDir = $logDir; Stop = (Join-Path $root 'STOP'); Runs = (Join-Path $root 'runs.txt') }
}

function Get-WrapperArgs($E, [int]$Timeout = 60, [string[]]$Allowed = @('dry-run'), [string]$Node = $node) {
    return @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $wrapper,
        '-WorkerDir', $E.WorkerDir, '-NodePath', $Node, '-LogDir', $E.LogDir, '-StopFile', $E.Stop,
        '-MutexName', $mutexName, '-TimeoutSeconds', "$Timeout", '-AllowedModes', ($Allowed -join ','))
}

# على 5.1 مع Stop يصبح أي stderr من عملية native خطأً منهياً؛ رمز الخروج وحده هو الحكم.
function Invoke-Ps([string[]]$ArgList) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $null = & $psExe @ArgList 2>&1 } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}

# غلاف في الخلفية بسطر أوامر مقتبس صراحة: Start-Process على 5.1 يضم مصفوفة الوسائط بلا اقتباس،
# فلم تصل -WorkerDir إلى الغلاف على عدّاء Windows (CI على 1363b25).
function Start-WrapperProcess($E) {
    $quoted = @(Get-WrapperArgs $E | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' })
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = $quoted -join ' '
    $psi.UseShellExecute = $false
    $p = [Diagnostics.Process]::Start($psi)
    $null = $p.Handle
    return $p
}

function Invoke-Wrapper($E, [string]$FakeMode = 'ok', [int]$Timeout = 60, [string[]]$Allowed = @('dry-run'), [string]$Node = $node) {
    $env:FAKE_WORKER_MODE = $FakeMode
    $env:FAKE_WORKER_RUNS = $E.Runs
    return (Invoke-Ps (Get-WrapperArgs $E $Timeout $Allowed $Node))
}

function Get-Log($E) {
    $f = Join-Path $E.LogDir 'scheduled-run.log'
    if (Test-Path -LiteralPath $f) { return [IO.File]::ReadAllText($f) }
    return ''
}
function Get-State($E) {
    $f = Join-Path $E.LogDir 'scheduled-run.state.json'
    if (-not (Test-Path -LiteralPath $f)) { return $null }
    return ([IO.File]::ReadAllText($f) | ConvertFrom-Json)
}
function Get-RunCount($E) {
    if (-not (Test-Path -LiteralPath $E.Runs)) { return 0 }
    return @([IO.File]::ReadAllLines($E.Runs) | Where-Object { $_ }).Count
}
function Wait-For([scriptblock]$Condition, [int]$Seconds = 20) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) { if (& $Condition) { return $true }; Start-Sleep -Milliseconds 200 }
    return $false
}
function Test-ProcessAlive([int]$ProcessId) {
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

try {
    # ── النجاح ────────────────────────────────────────────────────────────────
    $e = New-Env
    $code = Invoke-Wrapper $e 'ok'
    $log = Get-Log $e
    Assert 'دورة ناجحة ⇒ 0' ($code -eq 0)
    Assert 'العامل شُغّل مرة واحدة بـ--once' ((Get-RunCount $e) -eq 1 -and ([IO.File]::ReadAllText($e.Runs) -match '--once'))
    Assert 'السجل: run_start وrun_end بالنتيجة ok' ($log -match '"event":"run_start"' -and $log -match '"outcome":"ok"')
    Assert 'الحالة: lastSuccessAt وصفر إخفاقات' ((Get-State $e).consecutiveFailures -eq 0 -and (Get-State $e).lastSuccessAt)
    Assert 'لا ملفات مخرجات مؤقتة باقية' (@(Get-ChildItem -LiteralPath $e.LogDir -Filter '*.tmp').Count -eq 0)

    # ── الوضع محصور بـdry-run افتراضياً ───────────────────────────────────────
    foreach ($m in @('drive', 'live')) {
        $e = New-Env $m
        $code = Invoke-Wrapper $e 'ok'
        Assert "config بوضع $m مع السماح الافتراضي ⇒ 12 بلا تشغيل العامل" ($code -eq 12 -and (Get-RunCount $e) -eq 0)
        Assert "سبب الرفض مسجّل ($m)" ((Get-Log $e) -match 'preflight_failed')
    }
    $e = New-Env 'drive'
    Assert 'drive مسموح صراحة بالوسيطة ⇒ يعمل' ((Invoke-Wrapper $e 'ok' 60 @('dry-run', 'drive')) -eq 0 -and (Get-RunCount $e) -eq 1)

    # ── العامل يقرأ الإعداد المفحوص نفسه (Codex P1) ──────────────────────────
    $liveCfg = Join-Path $tempRoot 'inherited-live.json'
    [IO.File]::WriteAllText($liveCfg, '{ "mode": "live", "archiveFrom": "2026-11-01", "edgeUrl": "https://x" }')
    $e = New-Env
    $env:OZK_DRIVE_ARCHIVE_CONFIG = $liveCfg
    try { $code = Invoke-Wrapper $e 'ok' } finally { Remove-Item Env:\OZK_DRIVE_ARCHIVE_CONFIG -ErrorAction SilentlyContinue }
    Assert 'OZK_DRIVE_ARCHIVE_CONFIG موروث يشير إلى live ⇒ العامل يقرأ dry-run المفحوص' ($code -eq 0 -and ([IO.File]::ReadAllText($e.Runs) -match 'mode=dry-run') -and ([IO.File]::ReadAllText($e.Runs) -notmatch 'mode=live'))
    $e = New-Env 'live'
    $dryCfg = Join-Path $e.Root 'dry.json'
    [IO.File]::WriteAllText($dryCfg, '{ "mode": "dry-run", "archiveFrom": "2026-11-01" }')
    $env:FAKE_WORKER_MODE = 'ok'
    $env:FAKE_WORKER_RUNS = $e.Runs
    $code = Invoke-Ps ((Get-WrapperArgs $e) + @('-ConfigPath', $dryCfg))
    Assert '-ConfigPath لملف dry-run وconfig.json المجاور live ⇒ العامل يقرأ dry-run' ($code -eq 0 -and ([IO.File]::ReadAllText($e.Runs) -match 'mode=dry-run'))
    Assert 'لا لقطة إعداد باقية بعد التشغيل' (@(Get-ChildItem -LiteralPath $e.LogDir -Filter 'run-*.config.json').Count -eq 0)

    # ── الفحص المسبق ──────────────────────────────────────────────────────────
    $e = New-Env -NoConfig
    Assert 'config.json مفقود ⇒ 12 بلا تشغيل' ((Invoke-Wrapper $e 'ok') -eq 12 -and (Get-RunCount $e) -eq 0)
    $e = New-Env
    Assert 'node مفقود ⇒ 12' ((Invoke-Wrapper $e 'ok' 60 @('dry-run') (Join-Path $tempRoot 'no-node.exe')) -eq 12 -and (Get-RunCount $e) -eq 0)
    $e = New-Env
    Remove-Item -LiteralPath (Join-Path $e.WorkerDir 'worker.js')
    Assert 'worker.js مفقود ⇒ 12' ((Invoke-Wrapper $e 'ok') -eq 12)

    # ── الإيقاف الآمن ─────────────────────────────────────────────────────────
    $e = New-Env
    [IO.File]::WriteAllText($e.Stop, 'stop')
    $code = Invoke-Wrapper $e 'ok'
    Assert 'ملف STOP ⇒ 13 بلا تشغيل العامل' ($code -eq 13 -and (Get-RunCount $e) -eq 0)
    Assert 'الإيقاف المطلوب لا يُعدّ إخفاقاً' ((Get-State $e).consecutiveFailures -eq 0)
    Remove-Item -LiteralPath $e.Stop
    Assert 'حذف STOP ⇒ يعود التشغيل' ((Invoke-Wrapper $e 'ok') -eq 0 -and (Get-RunCount $e) -eq 1)

    # ── التزامن ───────────────────────────────────────────────────────────────
    $e = New-Env
    $env:FAKE_WORKER_MODE = 'sleep'
    $env:FAKE_WORKER_SLEEP_MS = '5000'
    $env:FAKE_WORKER_RUNS = $e.Runs
    $first = Start-WrapperProcess $e
    $started = Wait-For { (Get-RunCount $e) -ge 1 }
    if (-not $started) { Write-Host ('DIAG args: ' + $first.StartInfo.Arguments) }
    Assert 'التشغيل الأول بدأ' $started
    $second = Invoke-Wrapper $e 'ok'
    Assert 'تشغيل ثانٍ أثناء الأول ⇒ 10 بلا تشغيل عامل ثانٍ' ($second -eq 10 -and (Get-RunCount $e) -eq 1)
    $first.WaitForExit()
    Assert 'الأول أكمل بنجاح ⇒ 0' ($first.ExitCode -eq 0)
    Assert '«نسخة أخرى تعمل» لا يُعدّ إخفاقاً' ((Get-State $e).consecutiveFailures -eq 0)
    Assert 'بعد انتهاء الأول يُقبل تشغيل جديد' ((Invoke-Wrapper $e 'ok') -eq 0 -and (Get-RunCount $e) -eq 2)

    # موت الغلاف قسرياً وهو يحمل القفل: القفل لا يبقى محجوزاً.
    $e = New-Env
    $env:FAKE_WORKER_MODE = 'sleep'
    $env:FAKE_WORKER_SLEEP_MS = '30000'
    $env:FAKE_WORKER_RUNS = $e.Runs
    $victim = Start-WrapperProcess $e
    [void](Wait-For { (Get-RunCount $e) -ge 1 })
    $workerPid = [int](([IO.File]::ReadAllLines($e.Runs)[0] -split ' ')[0])
    Stop-Process -Id $victim.Id -Force
    [void]$victim.WaitForExit(10000)
    Stop-Process -Id $workerPid -Force -ErrorAction SilentlyContinue
    $code = Invoke-Wrapper $e 'ok'
    Assert 'بعد قتل الغلاف الحامل للقفل يُستلم القفل ⇒ 0' ($code -eq 0)
    Remove-Item Env:\FAKE_WORKER_SLEEP_MS

    # ── المهلة ────────────────────────────────────────────────────────────────
    $e = New-Env
    $childPidFile = Join-Path $e.Root 'child.pid'
    $env:FAKE_WORKER_CHILD_PID = $childPidFile
    $t0 = Get-Date
    $code = Invoke-Wrapper $e 'hang' 30
    $elapsed = ((Get-Date) - $t0).TotalSeconds
    Remove-Item Env:\FAKE_WORKER_CHILD_PID
    Assert 'دورة معلّقة ⇒ 11 بعد المهلة' ($code -eq 11 -and $elapsed -ge 29 -and $elapsed -lt 90)
    $workerPid = [int](([IO.File]::ReadAllLines($e.Runs)[0] -split ' ')[0])
    $childPid = [int]([IO.File]::ReadAllText($childPidFile))
    Assert 'العامل المعلّق قُتل' ((Wait-For { -not (Test-ProcessAlive $workerPid) } 15))
    Assert 'العملية الحفيدة (Edge) قُتلت مع الشجرة' ((Wait-For { -not (Test-ProcessAlive $childPid) } 15))
    Assert 'السجل: timeout_killed' ((Get-Log $e) -match 'timeout_killed')
    Assert 'المهلة تُعدّ إخفاقاً' ((Get-State $e).consecutiveFailures -eq 1)
    Assert 'القفل تحرّر بعد المهلة' ((Invoke-Wrapper $e 'ok') -eq 0)

    # ── فشل الاتصال ومسارات الأخطاء ───────────────────────────────────────────
    $e = New-Env
    $code = Invoke-Wrapper $e 'detect_failed'
    Assert 'فشل SQL (detect=null) ⇒ 3 ومسجّل' ($code -eq 3 -and (Get-Log $e) -match 'detect_failed')
    $e = New-Env 'drive'
    $code = Invoke-Wrapper $e 'drive_offline' 60 @('dry-run', 'drive')
    Assert 'Drive غير متصل ⇒ 3' ($code -eq 3 -and (Get-Log $e) -match 'drive_disconnected')
    $e = New-Env 'drive'
    Assert 'needs_reauth ⇒ 5 (إيقاف أمني)' ((Invoke-Wrapper $e 'needs_reauth' 60 @('dry-run', 'drive')) -eq 5)
    $e = New-Env 'drive'
    Assert 'مجلد صار مشتركاً أثناء الطابور ⇒ 5' ((Invoke-Wrapper $e 'not_private_midway' 60 @('dry-run', 'drive')) -eq 5)
    $e = New-Env
    Assert 'انتهاء التجربة المحصورة ⇒ 2' ((Invoke-Wrapper $e 'pilot_expired') -eq 2)
    $e = New-Env
    $code = Invoke-Wrapper $e 'pilot_expired_startup'
    Assert 'انتهاء التجربة قبل الإقلاع (رسالة validate العربية) ⇒ 2 لا 1' ($code -eq 2 -and (Get-Log $e) -match 'pilot_expired')
    $e = New-Env
    Assert 'عامل بلا مخرجات ⇒ 1' ((Invoke-Wrapper $e 'no_output') -eq 1)

    $e = New-Env
    $code = Invoke-Wrapper $e 'crash'
    $log = Get-Log $e
    Assert 'انهيار العامل ⇒ 1 وworker_failed' ($code -eq 1 -and $log -match 'worker_failed')
    Assert 'السجل لا يحوي كلمة المرور ولا Bearer' ($log -notmatch 'hunter2' -and $log -notmatch 'abc\.def\.ghi')
    Assert 'السجل يحفظ سبب الخطأ منقّحاً' ($log -match 'Failed to connect' -and $log -match 'password=\*\*\*')

    $e = New-Env
    [void](Invoke-Wrapper $e 'leak')
    $log = Get-Log $e
    Assert 'رموز OAuth في مخرجات العامل لا تصل السجل' ($log -notmatch '1//0gFAKE' -and $log -notmatch 'ya29\.FAKE')

    # ── عدّ الإخفاقات المتتالية ───────────────────────────────────────────────
    $e = New-Env
    for ($i = 0; $i -lt 5; $i++) { [void](Invoke-Wrapper $e 'crash') }
    Assert 'خمسة إخفاقات متتالية ⇒ failure_streak' ((Get-State $e).consecutiveFailures -eq 5 -and (Get-Log $e) -match 'failure_streak')
    [void](Invoke-Wrapper $e 'ok')
    Assert 'نجاح بعدها يصفّر العدّاد' ((Get-State $e).consecutiveFailures -eq 0)

    $e = New-Env
    [void](New-Item -ItemType Directory -Path $e.LogDir -Force)
    [IO.File]::WriteAllText((Join-Path $e.LogDir 'scheduled-run.state.json'), '{ broken')
    $code = Invoke-Wrapper $e 'ok'
    Assert 'ملف حالة تالف ⇒ يُعاد بناؤه بلا توقف (state_reset)' ($code -eq 0 -and (Get-Log $e) -match 'state_reset' -and (Get-State $e).consecutiveFailures -eq 0)

    # ── تدوير السجل ───────────────────────────────────────────────────────────
    $e = New-Env
    [void](New-Item -ItemType Directory -Path $e.LogDir -Force)
    $logFile = Join-Path $e.LogDir 'scheduled-run.log'
    [IO.File]::WriteAllText($logFile, ('x' * 70000))
    $env:FAKE_WORKER_MODE = 'ok'
    $env:FAKE_WORKER_RUNS = $e.Runs
    $a = (Get-WrapperArgs $e) + @('-MaxLogBytes', '65536', '-MaxLogFiles', '2')
    [void](Invoke-Ps $a)
    Assert 'سجل تجاوز الحد يُدوَّر إلى .1' ((Test-Path -LiteralPath "$logFile.1") -and (Get-Item -LiteralPath $logFile).Length -lt 65536)
    [IO.File]::WriteAllText($logFile, ('y' * 70000))
    [void](Invoke-Ps $a)
    [IO.File]::WriteAllText($logFile, ('z' * 70000))
    [void](Invoke-Ps $a)
    Assert 'عدد الملفات المدوَّرة لا يتجاوز الحد' ((Test-Path -LiteralPath "$logFile.2") -and -not (Test-Path -LiteralPath "$logFile.3"))
} finally {
    Remove-Item Env:\FAKE_WORKER_MODE, Env:\FAKE_WORKER_RUNS -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "run-scheduled: $script:pass PASS, $script:fail FAIL"
if ($script:fail -gt 0) { exit 1 }
exit 0
