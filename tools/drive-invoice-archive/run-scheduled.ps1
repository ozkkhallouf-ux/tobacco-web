# غلاف التشغيل المجدول لعامل أرشفة فواتير الجملة (OZK2026، Windows PowerShell 5.1).
#
# غير مسجَّل في أي مهمة. قالب المهمة المقترح للمراجعة وحدها في scheduled-task\.
# كل تشغيل = دورة واحدة `node worker.js --once` ثم خروج. المهمة تكرّر التشغيل كل دقيقة.
# لا يُستعمل التشغيل المستمر (worker.js بلا --once) لأنه لم يُختبر حياً.
#
# ضمانات الغلاف:
# - نسخة واحدة: Mutex باسم عام، والحالة المهجورة بعد موت العملية تُستلم. فوقه قفل
#   المنفذ 47617 داخل العامل نفسه.
# - الوضع محصور: يرفض التشغيل إن لم يكن mode في config.json ضمن -AllowedModes
#   (الافتراضي dry-run وحده). فلا يتسع الغلاف إلى drive/live بتعديل config وحده؛
#   يلزم تغيير وسيطة المهمة أيضاً، وهو قرار منفصل للمالك.
# - إيقاف آمن: وجود ملف STOP يمنع أي دورة جديدة ولا يقطع دورة جارية.
# - مهلة: دورة تتجاوز -TimeoutSeconds تُقتل مع شجرتها (node وEdge). هذا آمن، لأن
#   الكتابة على القرص ذرّية والرفع يُكشف تكراره بـozkJobId.
# - سجل محدود: سطر JSON لكل تشغيل، مع تدوير بالحجم، وتنقيح أي نمط سرّ قبل الكتابة.
#   مخرجات العامل تُختصر ولا تُنسخ كاملة.
# - حالة: scheduled-run.state.json يحفظ آخر نجاح وعدد الإخفاقات المتتالية، لتنبيه
#   النبض لاحقاً.
#
# رموز الخروج:
#   0  نجاح
#   1  فشل العامل
#   2  انتهت التجربة المحصورة (Fail Closed)
#   3  دورة ناقصة: فشل الرصد أو Drive غير متاح
#   5  إيقاف أمني: needs_reauth أو identity_mismatch أو not_private
#   10 نسخة أخرى تعمل
#   11 تجاوز المهلة وقُتلت الدورة
#   12 فشل الفحص المسبق: config أو node أو وضع غير مسموح
#   13 الإيقاف مطلوب بملف STOP
param(
    [string]$WorkerDir = $PSScriptRoot,
    [string]$NodePath = '',
    [string]$ConfigPath = '',
    [string[]]$AllowedModes = @('dry-run'),
    [ValidateRange(30, 3600)][int]$TimeoutSeconds = 600,
    [string]$LogDir = '',
    [string]$StopFile = '',
    [string]$MutexName = 'Global\OZK-DriveArchive-ScheduledRun',
    [ValidateRange(65536, 104857600)][int]$MaxLogBytes = 1048576,
    [ValidateRange(1, 20)][int]$MaxLogFiles = 5,
    [ValidateRange(1, 1000)][int]$FailureStreakAlert = 5
)
$ErrorActionPreference = 'Stop'

$programData = $env:ProgramData
if (-not $programData) { $programData = Join-Path ([IO.Path]::GetTempPath()) 'ozk-programdata' }
$baseDir = Join-Path $programData 'OZK\DriveArchive'
if (-not $ConfigPath) { $ConfigPath = Join-Path $WorkerDir 'config.json' }
# من Task Scheduler تصل القائمة نصاً واحداً «dry-run,drive».
$AllowedModes = @($AllowedModes | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if (-not $StopFile) { $StopFile = Join-Path $baseDir 'STOP' }

function Get-RedactedText([string]$Text, [int]$Max = 2000) {
    if ($null -eq $Text) { return '' }
    $t = $Text
    $t = [regex]::Replace($t, '(?i)\bBearer\s+[^\s"'',;]+', 'Bearer ***')
    $t = [regex]::Replace($t, '(?i)("?(?:password|pwd|secret|token|access_token|refresh_token|client_secret|apikey|api_key|authorization|x-ozk-archive-secret)"?\s*[:=]\s*)("[^"]*"|[^\s;,]+)', '$1***')
    $t = [regex]::Replace($t, 'ya29\.[0-9A-Za-z_\-\.]+', '***')
    $t = [regex]::Replace($t, '1//[0-9A-Za-z_\-]{20,}', '***')
    $t = ($t -replace '[\r\n]+', ' ').Trim()
    if ($t.Length -gt $Max) { $t = $t.Substring(0, $Max) + '…' }
    return $t
}

function Invoke-LogRotation([string]$File) {
    if (-not (Test-Path -LiteralPath $File)) { return }
    if ((Get-Item -LiteralPath $File).Length -lt $MaxLogBytes) { return }
    $oldest = "$File.$MaxLogFiles"
    if (Test-Path -LiteralPath $oldest) { Remove-Item -LiteralPath $oldest -Force }
    for ($i = $MaxLogFiles - 1; $i -ge 1; $i--) {
        $src = "$File.$i"
        if (Test-Path -LiteralPath $src) { Move-Item -LiteralPath $src -Destination "$File.$($i + 1)" -Force }
    }
    Move-Item -LiteralPath $File -Destination "$File.1" -Force
}

$script:logFile = $null
function Write-RunLog([string]$EventName, [hashtable]$Fields = @{}) {
    $entry = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); event = $EventName; pid = $PID }
    foreach ($k in $Fields.Keys) { $entry[$k] = $Fields[$k] }
    $line = Get-RedactedText (($entry | ConvertTo-Json -Compress -Depth 4)) 4000
    if (-not $script:logFile) { Write-Output $line; return }
    try {
        Invoke-LogRotation $script:logFile
        [IO.File]::AppendAllText($script:logFile, $line + "`r`n", (New-Object Text.UTF8Encoding($false)))
    } catch {
        # السجل لا يوقف التشغيل
        Write-Output $line
    }
}

function Read-JsonFile([string]$Path) {
    $text = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return ($text | ConvertFrom-Json)
}

function Save-RunState([string]$Path, [int]$ExitCode, [string]$Outcome) {
    $state = [ordered]@{ lastRunAt = $null; lastExitCode = $null; lastOutcome = ''; lastSuccessAt = $null; consecutiveFailures = 0 }
    if (Test-Path -LiteralPath $Path) {
        try {
            $old = Read-JsonFile $Path
            foreach ($k in @('lastSuccessAt', 'consecutiveFailures')) { if ($null -ne $old.$k) { $state[$k] = $old.$k } }
        } catch { }
    }
    $now = (Get-Date).ToUniversalTime().ToString('o')
    $state.lastRunAt = $now
    $state.lastExitCode = $ExitCode
    $state.lastOutcome = $Outcome
    # «نسخة أخرى تعمل» و«إيقاف مطلوب» ليسا إخفاقاً للعامل.
    if ($ExitCode -eq 0) { $state.lastSuccessAt = $now; $state.consecutiveFailures = 0 }
    elseif ($ExitCode -ne 10 -and $ExitCode -ne 13) { $state.consecutiveFailures = [int]$state.consecutiveFailures + 1 }
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, ($state | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
    return $state
}

function Stop-ProcessTree([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { return }
    $onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    if ($onWindows) {
        $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
        & $taskkill /PID $Process.Id /T /F 2>&1 | Out-Null
    } elseif ($PSVersionTable.PSVersion.Major -ge 7) {
        $Process.Kill($true)
    } else {
        $Process.Kill()
    }
    [void]$Process.WaitForExit(15000)
}

# يصنّف الدورة من سطر JSON الأخير الذي يطبعه `worker.js --once`.
function Get-CycleOutcome([string]$Stdout) {
    $last = $null
    foreach ($l in ($Stdout -split "`r?`n")) { if ($l.Trim().StartsWith('{')) { $last = $l.Trim() } }
    if (-not $last) { return @{ code = 1; outcome = 'no_cycle_output'; reasons = @() } }
    try { $r = $last | ConvertFrom-Json } catch { return @{ code = 1; outcome = 'unparsable_cycle_output'; reasons = @() } }
    if ($r.pilotExpired -eq $true) { return @{ code = 2; outcome = 'pilot_expired'; reasons = @('pilot_expired') } }
    $reasons = @()
    $security = @('needs_reauth', 'identity_mismatch', 'not_private')
    $driveState = [string]$r.driveState
    # driveState يُضبط أيضاً حين ينقطع الرفع في منتصف الطابور، لا عند الفحص الأول وحده.
    if ($security -contains $driveState) { return @{ code = 5; outcome = 'security_stop'; reasons = @("drive_$driveState") } }
    if ($null -ne $r.upload -and ($null -ne $r.upload.blocked -or $driveState -eq 'disconnected')) { $reasons += "drive_$driveState" }
    if ($null -eq $r.detect) { $reasons += 'detect_failed' }
    if ($reasons.Count) { return @{ code = 3; outcome = 'degraded'; reasons = $reasons } }
    $summary = [ordered]@{}
    if ($r.detect) { $summary.rows = $r.detect.rows; $summary.created = $r.detect.created; $summary.reconcile = $r.detect.reconcile }
    if ($r.upload) { $summary.uploaded = $r.upload.uploaded }
    if ($r.notify) { $summary.notified = $r.notify.notified }
    return @{ code = 0; outcome = 'ok'; reasons = @(); summary = $summary }
}

$script:exitCode = 12
$script:outcome = 'preflight_failed'

function Invoke-ScheduledRun {
    $mutex = $null
    $acquired = $false
    $statePath = $null
    $c = $null
    try {
        # ── الفحص المسبق (قبل القفل كي لا يحجز تشغيلٌ معطوب القفلَ) ─────────
        if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'config.json غير موجود' }
        $cfg = Read-JsonFile $ConfigPath
        $mode = if ($cfg.mode) { [string]$cfg.mode } else { 'dry-run' }
        $dataDir = if ($cfg.dataDir) { [string]$cfg.dataDir } else { Join-Path $baseDir 'data' }
        $logDirEff = if ($LogDir) { $LogDir } else { Join-Path $dataDir 'logs' }
        if (-not (Test-Path -LiteralPath $logDirEff)) { New-Item -ItemType Directory -Force -Path $logDirEff | Out-Null }
        $script:logFile = Join-Path $logDirEff 'scheduled-run.log'
        $statePath = Join-Path $logDirEff 'scheduled-run.state.json'

        foreach ($m in $AllowedModes) { if (@('dry-run', 'drive', 'live') -notcontains $m) { throw "وضع غير معروف في -AllowedModes: $m" } }
        if ($AllowedModes -notcontains $mode) { throw "الوضع $mode غير مسموح لهذا التشغيل (المسموح: $($AllowedModes -join ','))" }
        $worker = Join-Path $WorkerDir 'worker.js'
        if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'worker.js غير موجود' }
        $node = $NodePath
        if (-not $node) {
            $cmd = Get-Command node -ErrorAction SilentlyContinue
            if ($cmd) { $node = $cmd.Source }
            elseif ($env:ProgramFiles) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
        }
        if (-not $node -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'node غير موجود' }

        if (Test-Path -LiteralPath $StopFile) {
            $script:exitCode = 13; $script:outcome = 'stop_requested'
            Write-RunLog 'stop_requested'
            return
        }

        # ── القفل ────────────────────────────────────────────────────────────
        $mutex = New-Object Threading.Mutex($false, $MutexName)
        try { $acquired = $mutex.WaitOne(0) }
        catch [Threading.AbandonedMutexException] { $acquired = $true; Write-RunLog 'mutex_abandoned_recovered' }
        if (-not $acquired) {
            $script:exitCode = 10; $script:outcome = 'already_running'
            Write-RunLog 'already_running'
            return
        }

        # ── الدورة ───────────────────────────────────────────────────────────
        # من هنا أي استثناء غير متوقع خطأ في الغلاف لا في الفحص المسبق.
        $script:exitCode = 1; $script:outcome = 'wrapper_error'
        $runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
        $outFile = Join-Path $logDirEff "run-$runId.out.tmp"
        $errFile = Join-Path $logDirEff "run-$runId.err.tmp"
        $started = Get-Date
        Write-RunLog 'run_start' @{ runId = $runId; mode = $mode; timeoutSeconds = $TimeoutSeconds }
        try {
            $proc = Start-Process -FilePath $node -ArgumentList @("`"$worker`"", '--once') -WorkingDirectory $WorkerDir `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow -PassThru
            $null = $proc.Handle # يحفظ رمز الخروج على 5.1
            if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
                Stop-ProcessTree $proc
                $script:exitCode = 11; $script:outcome = 'timeout'
                Write-RunLog 'timeout_killed' @{ runId = $runId; seconds = $TimeoutSeconds }
            } else {
                $proc.WaitForExit()
                $workerExit = $proc.ExitCode
                $stdout = if (Test-Path -LiteralPath $outFile) { [IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8) } else { '' }
                $stderr = if (Test-Path -LiteralPath $errFile) { [IO.File]::ReadAllText($errFile, [Text.Encoding]::UTF8) } else { '' }
                # انتهاء التجربة قبل الإقلاع يرفضه validate() برمز 1 ورسالة عربية (المخرجات تُقرأ UTF-8)؛
                # وأثناء التشغيل يخرج العامل بـ2. كلاهما Fail Closed لا عطل.
                if ($workerExit -eq 2 -or ($workerExit -eq 1 -and $stderr -match 'انتهت التجربة المحصورة')) {
                    $script:exitCode = 2; $script:outcome = 'pilot_expired'
                } elseif ($workerExit -ne 0) {
                    $script:exitCode = 1; $script:outcome = 'worker_failed'
                    Write-RunLog 'worker_failed' @{ runId = $runId; workerExit = $workerExit; error = (Get-RedactedText $stderr 500) }
                } else {
                    $c = Get-CycleOutcome $stdout
                    $script:exitCode = $c.code; $script:outcome = $c.outcome
                    if ($c.reasons.Count) { Write-RunLog 'cycle_issue' @{ runId = $runId; outcome = $c.outcome; reasons = ($c.reasons -join ',') } }
                }
            }
        } finally {
            foreach ($f in @($outFile, $errFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue } }
        }
        $fields = @{ runId = $runId; outcome = $script:outcome; exitCode = $script:exitCode; durationMs = [int]((Get-Date) - $started).TotalMilliseconds }
        if ($c -and $c.summary) { $fields.summary = $c.summary }
        Write-RunLog 'run_end' $fields
    } catch {
        if ($script:exitCode -eq 12) { $script:outcome = 'preflight_failed' }
        else { $script:exitCode = 1; $script:outcome = 'wrapper_error' }
        Write-RunLog $script:outcome @{ error = (Get-RedactedText $_.Exception.Message 300) }
    } finally {
        if ($acquired) { try { $mutex.ReleaseMutex() } catch { } }
        if ($mutex) { $mutex.Dispose() }
        if ($statePath) {
            try {
                $st = Save-RunState $statePath $script:exitCode $script:outcome
                if (@(0, 10, 13) -notcontains $script:exitCode -and [int]$st.consecutiveFailures -ge $FailureStreakAlert) {
                    Write-RunLog 'failure_streak' @{ consecutiveFailures = $st.consecutiveFailures; lastSuccessAt = $st.lastSuccessAt }
                }
            } catch { }
        }
    }
}

Invoke-ScheduledRun
exit $script:exitCode
