#Requires -Version 5.1
# ============================================================
# Test-OzkAmeenBackupMonitor.ps1
#
# يثبت سلوك tools\backup\ozk-ameen-backup-monitor.ps1 وسكربت تسجيل مهمته بلا أي
# مساس بالجهاز: status.json والملفات في مجلد مؤقت، وTask Scheduler ورقم القرص
# والمساحة والعلامة وTelegram بدائل وهمية. لا SQL ولا رسائل حقيقية.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-OzkAmeenBackupMonitor.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$monPath = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'backup' 'ozk-ameen-backup-monitor.ps1')
$regPath = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'backup' 'register-ozk-ameen-backup-monitor-task.ps1')

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }
function Assert-Throws([scriptblock]$Block, [string]$Message) { $t = $false; try { & $Block | Out-Null } catch { $t = $true }; Assert-True $t $Message }

. $monPath

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-monitor-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $base | Out-Null

# ---------- البدائل الوهمية ----------
$script:Task = [pscustomobject]@{ State = 'Ready'; LastRunTime = $null; LastTaskResult = 0 }
$script:TaskInfoReader = { param([string]$Name) return $script:Task }
$script:Serial = '34AD-2E92'
$script:VolumeSerialReader = { param([string]$Root) return $script:Serial }
$script:Free = [int64](200GB)
$script:FreeSpaceReader = { param([string]$Path) return $script:Free }
$script:Marker = $true
$script:MarkerChecker = { param([string]$Root) return $script:Marker }
$script:HostNameReader = { return 'OZK2026' }

$okNotify = Join-Path $base 'notify-ok.ps1'
$failNotify = Join-Path $base 'notify-fail.ps1'
$notifyLog = Join-Path $base 'notify.log'
[System.IO.File]::WriteAllText($okNotify, ('param([string]$Message,[string]$EventType,[string]$DedupeKey,[int]$DedupeMinutes) Add-Content -LiteralPath ''' + $notifyLog + ''' -Value $DedupeKey; Write-Host "TELEGRAM-NOTIFY OK ($EventType)"'))
[System.IO.File]::WriteAllText($failNotify, 'param([string]$Message,[string]$EventType,[string]$DedupeKey,[int]$DedupeMinutes) Write-Host "TELEGRAM-NOTIFY FAILED: The remote name could not be resolved"; exit 0')
function Get-NotifyCount { if (Test-Path -LiteralPath $notifyLog) { return @(Get-Content -LiteralPath $notifyLog).Count } return 0 }
function Reset-Notify { if (Test-Path -LiteralPath $notifyLog) { Remove-Item -LiteralPath $notifyLog -Force } }

function Get-TestSha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

# يبني status.json وملفاته كما يكتبها ozk-ameen-backup.ps1.
function New-Fixture([string]$Name, [datetime]$RunAt, [string]$Status = 'ok', [string]$External = 'ok', [string[]]$Dbs = @('AmnDb002', 'AmnDb001', 'AmnConfig'), [switch]$NoCompress) {
    $root = Join-Path $base $Name
    $stamp = $RunAt.ToString('yyyy-MM-dd_HHmmss')
    $state = Join-Path $root 'state'
    $runDir = Join-Path (Join-Path $root 'local') $stamp
    $extDir = Join-Path (Join-Path $root 'ext') $stamp
    New-Item -ItemType Directory -Force -Path $state, $runDir | Out-Null
    $zipName = 'OZK-Ameen-' + $stamp + '.zip'
    [System.IO.File]::WriteAllText((Join-Path $runDir $zipName), ('ZIP-' + $stamp))
    $zipSha = Get-TestSha (Join-Path $runDir $zipName)
    $files = @($Dbs | ForEach-Object {
        $fn = $_ + '_' + $stamp + '.bak'
        [System.IO.File]::WriteAllText((Join-Path $runDir $fn), ('RAW-' + $fn))
        [pscustomobject]@{ database = $_; file = $fn; bytes = 10; sha256 = (Get-TestSha (Join-Path $runDir $fn)); verified = 'RESTORE VERIFYONLY WITH CHECKSUM' } })
    $manifest = [ordered]@{ stamp = $stamp; files = $files; zip = [ordered]@{ zip = $zipName; sha256 = $zipSha } }
    [System.IO.File]::WriteAllText((Join-Path $runDir 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5))
    if ($External -eq 'ok') {
        New-Item -ItemType Directory -Force -Path $extDir | Out-Null
        [System.IO.File]::Copy((Join-Path $runDir $zipName), (Join-Path $extDir $zipName))
        [System.IO.File]::Copy((Join-Path $runDir 'manifest.json'), (Join-Path $extDir 'manifest.json'))
        if ($NoCompress) { foreach ($x in $files) { [System.IO.File]::Copy((Join-Path $runDir $x.file), (Join-Path $extDir $x.file)) } }
    }
    $st = [ordered]@{
        mode = 'execute'; host = 'OZK2026'; stamp = $stamp; runDir = $runDir; databases = $Dbs; files = $files; compressed = (-not $NoCompress)
        zip = $(if ($NoCompress) { $null } else { [ordered]@{ zip = $zipName; bytes = 10; sha256 = $zipSha } }); local = $(if ($Status -eq 'failed') { 'failed' } else { 'ok' }); external = $External
        externalDir = $(if ($External -eq 'ok') { $extDir } else { '' }); status = $Status; errors = $(if ($Status -eq 'failed') { @('AmnDb001: verify failed') } else { @() })
        notify = 'telegram'; finishedAt = $RunAt.AddMinutes(4).ToString('o')
    }
    [System.IO.File]::WriteAllText((Join-Path $state 'status.json'), ($st | ConvertTo-Json -Depth 6))
    return [pscustomobject]@{ State = $state; RunDir = $runDir; ExtDir = $extDir; Zip = $zipName; Stamp = $stamp }
}
function Set-TaskRan([datetime]$At, [string]$State = 'Ready') { $script:Task = [pscustomobject]@{ State = $State; LastRunTime = $At; LastTaskResult = 0 } }

$night = [datetime]'2026-10-15T23:00:00'
$check2330 = [datetime]'2026-10-15T23:30:00'
$check0800 = [datetime]'2026-10-16T08:00:00'

try {
    Write-Host '== 1) الموعد المتوقع للتشغيل =='
    Assert-True ((Get-OzkExpectedRun $check2330 '23:00') -eq $night) '23:30 ⇒ الموعد المتوقع اليوم 23:00'
    Assert-True ((Get-OzkExpectedRun $check0800 '23:00') -eq $night) '08:00 ⇒ الموعد المتوقع أمس 23:00'
    Assert-True ((Get-OzkExpectedRun ([datetime]'2026-10-15T22:59:00') '23:00') -eq $night.AddDays(-1)) '22:59 ⇒ موعد الأمس'
    Assert-Throws { Get-OzkExpectedRun $night '25:00' } 'وقت جدولة غير صالح مرفوض'

    Write-Host '== 2) نجاح كامل ⇒ SUCCESS، وتنبيه أول تشغيل فقط =='
    Reset-Notify
    $f = New-Fixture 'ok' $night
    Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'SUCCESS' -and @($r.health.reasons).Count -eq 0) 'كل الفحوص سليمة ⇒ SUCCESS'
    Assert-True ($r.alertReason -eq 'first-run' -and $r.delivery.delivered) 'أول تشغيل يرسل تنبيهاً ويصل'
    $r2 = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check0800
    Assert-True ($r2.level -eq 'SUCCESS' -and -not $r2.alertReason) 'SUCCESS متكرر ⇒ لا تنبيه'
    Assert-True ((Get-NotifyCount) -eq 1) 'تنبيه واحد فقط لسلسلة SUCCESS'
    Assert-True ((Invoke-OzkBackupMonitorMain @{ StateDir = $f.State; Now = $check0800 }) -eq 0) 'رمز الخروج 0 لـSUCCESS'

    Write-Host '== 3) فشل النسخ ⇒ FAILURE =='
    $f = New-Fixture 'failed' $night 'failed' 'skipped'
    Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'failed')) 'status=failed ⇒ FAILURE'
    Assert-True ((Invoke-OzkBackupMonitorMain @{ StateDir = $f.State; Now = $check2330 }) -eq 1) 'رمز الخروج 1 لـFAILURE'

    Write-Host '== 4) local-only ⇒ WARNING لا SUCCESS =='
    $f = New-Fixture 'localonly' $night 'local-only' 'missing'
    Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'WARNING') 'local-only ⇒ WARNING'
    Assert-True ((Invoke-OzkBackupMonitorMain @{ StateDir = $f.State; Now = $check2330 }) -eq 2) 'رمز الخروج 2 لـWARNING'

    Write-Host '== 5) غياب الفلاشة الآن / فلاشة خاطئة / علامة مفقودة =='
    $f = New-Fixture 'drive' $night
    Set-TaskRan $night
    $script:Serial = ''
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'WARNING' -and ((@($r.health.warnings) -join ' ') -match 'غير موصول')) 'الفلاشة مفصولة الآن ⇒ WARNING'
    $script:Serial = 'AAAA-BBBB'
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match '34AD-2E92')) 'رقم فلاشة خاطئ ⇒ FAILURE'
    $script:Serial = '34AD-2E92'; $script:Marker = $false
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'العلامة')) 'علامة مفقودة ⇒ FAILURE'
    $script:Marker = $true

    Write-Host '== 6) المهمة لم تعمل الليلة (فخّ الـ26 ساعة) =='
    $f = New-Fixture 'missed' $night.AddDays(-1)
    Set-TaskRan $night.AddDays(-1)
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'لم يعمل')) '23:30 ونسخة الأمس (24.5 ساعة < 26) ⇒ FAILURE لأن تشغيل الليلة لم يحدث'
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now ([datetime]'2026-10-15T23:10:00')
    Assert-True ($r.level -eq 'PENDING') '23:10 قبل مهلة البدء (15 دقيقة) ⇒ PENDING لا حكم'
    $f = New-Fixture 'stale' $night.AddDays(-2)
    Set-TaskRan $night.AddDays(-2)
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check0800
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'أقدم من 26')) 'نسخة قديمة (أكثر من 26 ساعة) ⇒ FAILURE'
    $f = New-Fixture 'ran-no-status' $night.AddDays(-1)
    Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'لم يُحدَّث')) 'المهمة عملت لكن status.json قديم ⇒ FAILURE'
    $script:Task = $null
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'غير مسجّلة')) 'مهمة النسخ غير مسجّلة ⇒ FAILURE'
    Set-TaskRan $night 'Disabled'
    $f = New-Fixture 'disabled' $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'معطّلة')) 'مهمة النسخ معطّلة ⇒ FAILURE'
    $empty = Join-Path $base 'no-status'; New-Item -ItemType Directory -Force -Path $empty | Out-Null
    Set-TaskRan $night.AddDays(-1)
    $r = Invoke-OzkBackupMonitor -StateDir $empty -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE') 'status.json غير موجود ⇒ FAILURE'

    Write-Host '== 7) استمرار النسخ مدة طويلة =='
    $f = New-Fixture 'running' $night.AddDays(-1)
    Set-TaskRan $night 'Running'
    Reset-Notify
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'PENDING' -and -not $r.alertReason -and (Get-NotifyCount) -eq 0) 'ما زال يعمل 23:30 ضمن المهلة ⇒ PENDING بلا تنبيه'
    Assert-True ((Invoke-OzkBackupMonitorMain @{ StateDir = $f.State; Now = $check2330 }) -eq 0) 'PENDING ⇒ خروج 0'
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now ([datetime]'2026-10-16T00:45:00')
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'المهلة')) 'ما زال يعمل بعد 90 دقيقة ⇒ FAILURE'
    $f = New-Fixture 'hang' $night.AddDays(-1)
    Set-TaskRan $night 'Running'
    Reset-Notify
    $null = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now ([datetime]'2026-10-16T00:45:00')
    Assert-True ($r.level -eq 'FAILURE' -and $r.alertReason -and $r.delivery.delivered) 'فحص 00:45 بعد PENDING 23:30 ونسخ عالق ⇒ FAILURE مُبلَّغ ليلاً'

    Write-Host '== 8) تلف ZIP أو عدم تطابق SHA256 أو manifest =='
    $f = New-Fixture 'zipD' $night; Set-TaskRan $night
    [System.IO.File]::AppendAllText((Join-Path $f.ExtDir $f.Zip), 'x')
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'الخارجي لا يطابق')) 'ZIP تالف على D: ⇒ FAILURE'
    $f = New-Fixture 'zipC' $night; Set-TaskRan $night
    [System.IO.File]::AppendAllText((Join-Path $f.RunDir $f.Zip), 'x')
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'C: لا يطابق')) 'ZIP تالف على C: ⇒ FAILURE'
    $f = New-Fixture 'zipGone' $night; Set-TaskRan $night
    [System.IO.File]::Move((Join-Path $f.ExtDir $f.Zip), (Join-Path $f.ExtDir 'renamed.bin'))
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'ZIP مفقود على القرص')) 'ZIP مفقود على D: ⇒ FAILURE'
    $f = New-Fixture 'manD' $night; Set-TaskRan $night
    [System.IO.File]::AppendAllText((Join-Path $f.ExtDir 'manifest.json'), ' ')
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'manifest.json على القرص الخارجي')) 'manifest على D: يختلف ⇒ FAILURE'
    $f = New-Fixture 'missingDb' $night 'ok' 'ok' @('AmnDb002', 'AmnConfig'); Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'AmnDb001')) 'قاعدة مفقودة من النسخة ⇒ FAILURE'

    Write-Host '== 8ب) -NoCompress: التحقق من الملفات الخام على C: وD: (Codex P1) =='
    $f = New-Fixture 'nocomp' $night -NoCompress; Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'WARNING' -and @($r.health.failures).Count -eq 0) 'بلا ضغط وملفات سليمة ⇒ WARNING فقط (غير مضغوطة)'
    $f = New-Fixture 'nocompC' $night -NoCompress; Set-TaskRan $night
    [System.IO.File]::Move((Join-Path $f.RunDir ('AmnDb001_' + $f.Stamp + '.bak')), (Join-Path $f.RunDir 'gone.bin'))
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'خام مفقود على C:')) 'بلا ضغط وملف خام مفقود على C: ⇒ FAILURE'
    $f = New-Fixture 'nocompD' $night -NoCompress; Set-TaskRan $night
    [System.IO.File]::AppendAllText((Join-Path $f.ExtDir ('AmnDb002_' + $f.Stamp + '.bak')), 'x')
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'لا يطابق على القرص الخارجي')) 'بلا ضغط وملف خام تالف على D: ⇒ FAILURE'
    $f = New-Fixture 'nocompC2' $night -NoCompress; Set-TaskRan $night
    [System.IO.File]::AppendAllText((Join-Path $f.RunDir ('AmnConfig_' + $f.Stamp + '.bak')), 'x')
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'لا يطابق على C:')) 'بلا ضغط وملف خام تالف على C: ⇒ FAILURE'

    Write-Host '== 8ج) compressed=true بلا بيانات ZIP ⇒ FAILURE (Codex P1) =='
    $f = New-Fixture 'nozipmeta' $night; Set-TaskRan $night
    $sp = Join-Path $f.State 'status.json'
    $obj = Get-Content -LiteralPath $sp -Raw -Encoding UTF8 | ConvertFrom-Json
    $obj.zip = $null
    [System.IO.File]::WriteAllText($sp, ($obj | ConvertTo-Json -Depth 6))
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'بلا بيانات ZIP')) 'مضغوطة بلا zip في status.json ⇒ FAILURE لا SUCCESS'
    $f = New-Fixture 'nozipsha' $night; Set-TaskRan $night
    $sp = Join-Path $f.State 'status.json'
    $obj = Get-Content -LiteralPath $sp -Raw -Encoding UTF8 | ConvertFrom-Json
    $obj.zip.sha256 = ''
    [System.IO.File]::WriteAllText($sp, ($obj | ConvertTo-Json -Depth 6))
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE') 'مضغوطة ببصمة ZIP فارغة ⇒ FAILURE'

    Write-Host '== 9) المساحة =='
    $f = New-Fixture 'space' $night; Set-TaskRan $night
    $script:Free = [int64](30GB)
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'WARNING') 'مساحة بين 20 و40 GB ⇒ WARNING'
    $script:Free = [int64](10GB)
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE') 'مساحة أقل من 20 GB ⇒ FAILURE'
    $script:Free = [int64](200GB)

    Write-Host '== 10) فشل Telegram ثم إعادة المحاولة =='
    $f = New-Fixture 'tg' $night 'failed' 'skipped'; Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $failNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and $r.delivery.delivered -eq $false) 'Telegram FAILED بخروج 0 ⇒ delivered=false'
    $st = Get-Content -LiteralPath (Join-Path $f.State 'monitor-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($st.pending -and $st.pending.delivered -eq $false -and $st.pending.attempts -eq 1 -and -not $st.lastAlertAt) 'الحادثة محفوظة كـpending بلا lastAlertAt'
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $failNotify -Now $check2330.AddMinutes(5)
    $st = Get-Content -LiteralPath (Join-Path $f.State 'monitor-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($r.alertReason -eq 'retry-undelivered' -and $st.pending.attempts -eq 2) 'الفحص التالي يعيد المحاولة (attempts=2)'
    Reset-Notify
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330.AddMinutes(10)
    $st = Get-Content -LiteralPath (Join-Path $f.State 'monitor-state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($r.alertReason -eq 'retry-undelivered' -and $r.delivery.delivered -and -not $st.pending -and $st.lastAlertAt) 'بعد عودة Telegram: يصل وتُمسح الحادثة'
    Assert-True ((Get-NotifyCount) -eq 1) 'رسالة واحدة وصلت'

    Write-Host '== 11) منع التكرار مع عدم كتم تغيّر الحالة أو الاستمرار الطويل =='
    $f = New-Fixture 'dedupe' $night 'failed' 'skipped'; Set-TaskRan $night
    Reset-Notify
    $null = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330.AddHours(1)
    Assert-True (-not $r.alertReason -and (Get-NotifyCount) -eq 1) 'نفس FAILURE بعد ساعة ⇒ لا تكرار'
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330.AddHours(13)
    Assert-True ($r.alertReason -eq 'still-failing' -and (Get-NotifyCount) -eq 2) 'FAILURE مستمر بعد 12 ساعة ⇒ تذكير'
    # تغيّر الأسباب مع بقاء FAILURE
    $script:Serial = 'AAAA-BBBB'
    $f2 = New-Fixture 'dedupe2' $night; Set-TaskRan $night
    Copy-Item -LiteralPath (Join-Path $f.State 'monitor-state.json') -Destination (Join-Path $f2.State 'monitor-state.json')
    $r = Invoke-OzkBackupMonitor -StateDir $f2.State -NotifyScript $okNotify -Now $check2330.AddHours(14)
    Assert-True ($r.level -eq 'FAILURE' -and $r.alertReason -eq 'reasons-changed') 'FAILURE بأسباب مختلفة ⇒ تنبيه'
    $script:Serial = '34AD-2E92'
    $r = Invoke-OzkBackupMonitor -StateDir $f2.State -NotifyScript $okNotify -Now $check2330.AddHours(15)
    Assert-True ($r.level -eq 'SUCCESS' -and $r.alertReason -eq 'level-changed') 'العودة إلى SUCCESS ⇒ تنبيه «عادت سليمة»'
    # PENDING لا يغيّر المستوى المحفوظ
    Set-TaskRan $night 'Running'
    $before = (Get-Content -LiteralPath (Join-Path $f2.State 'monitor-state.json') -Raw | ConvertFrom-Json).lastLevel
    $null = Invoke-OzkBackupMonitor -StateDir $f2.State -NotifyScript $okNotify -Now $check2330
    $after = (Get-Content -LiteralPath (Join-Path $f2.State 'monitor-state.json') -Raw | ConvertFrom-Json).lastLevel
    Assert-True ($before -eq $after) 'PENDING لا يغيّر آخر مستوى محفوظ'

    Write-Host '== 12) وضع التقييم فقط (بلا -NotifyScript) =='
    $f = New-Fixture 'evalonly' $night 'failed' 'skipped'; Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -Now $check2330
    Assert-True ($r.evaluateOnly -and $r.level -eq 'FAILURE' -and -not $r.delivery) 'بلا NotifyScript: تقييم فقط بلا إرسال'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $f.State 'monitor-state.json'))) 'بلا NotifyScript: لا تُكتب حالة التنبيهات'

    Write-Host '== 13) عطل في المراقب نفسه / جهاز خاطئ =='
    $script:HostNameReader = { return 'MacBook-Air-Omar' }
    $f = New-Fixture 'host' $night; Set-TaskRan $night
    $r = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE' -and ((@($r.health.failures) -join ' ') -match 'ليس')) 'جهاز غير OZK2026 ⇒ FAILURE مُبلَّغ'
    $script:HostNameReader = { return 'OZK2026' }
    $bad = New-Fixture 'badjson' $night; Set-TaskRan $night
    [System.IO.File]::WriteAllText((Join-Path $bad.State 'status.json'), '{ not json')
    $r = Invoke-OzkBackupMonitor -StateDir $bad.State -NotifyScript $okNotify -Now $check2330
    Assert-True ($r.level -eq 'FAILURE') 'status.json تالف ⇒ FAILURE'

    Write-Host '== 14) قراءة فقط: لا مساس بملفات النسخ =='
    $f = New-Fixture 'readonly' $night; Set-TaskRan $night
    $snap = @(Get-ChildItem -LiteralPath (Join-Path $base 'readonly') -Recurse -File | Where-Object { $_.Name -notmatch '^monitor-|\.log$' } | ForEach-Object { $_.FullName + '|' + (Get-TestSha $_.FullName) }) -join "`n"
    $null = Invoke-OzkBackupMonitor -StateDir $f.State -NotifyScript $okNotify -Now $check2330
    $snap2 = @(Get-ChildItem -LiteralPath (Join-Path $base 'readonly') -Recurse -File | Where-Object { $_.Name -notmatch '^monitor-|\.log$' } | ForEach-Object { $_.FullName + '|' + (Get-TestSha $_.FullName) }) -join "`n"
    Assert-True ($snap -eq $snap2) 'كل ملفات النسخ وstatus.json لم تتغيّر'
    foreach ($p in @($monPath, $regPath)) {
        $code = ((Get-Content -LiteralPath $p -Raw -Encoding UTF8) -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
        $leaf = Split-Path -Leaf $p
        Assert-True ($code -notmatch '(?i)Remove-Item|Move-Item|Copy-Item|\[System\.IO\.File\]::(Delete|Move|Copy)|Directory\]::Delete|Rename-Item') ($leaf + ': لا حذف ولا نقل ولا نسخ ملفات')
        Assert-True ($code -notmatch '(?i)SqlConnection|sqlcmd|Invoke-Sqlcmd|BACKUP\s+DATABASE|RESTORE\s+') ($leaf + ': لا SQL')
        Assert-True ($code -notmatch '(?i)Unregister-ScheduledTask|Set-ScheduledTask|Disable-ScheduledTask|Enable-ScheduledTask|Start-ScheduledTask') ($leaf + ': لا تعديل ولا تشغيل لمهام موجودة')
    }

    Write-Host '== 15) سكربت تسجيل مهمة المراقب =='
    . $regPath
    $script:RegCalls = 0
    $script:TaskRegistrar = { param($Spec) $script:RegCalls++ }
    $script:TaskExists = { param([string]$Name) return ($Name -eq 'TOBACCO Ameen Backup Monitor') }
    $script:Paths = @('C:\x\app\abc1234\tools\backup\ozk-ameen-backup-monitor.ps1', 'C:\x\app\abc1234/tools/backup/ozk-ameen-backup-monitor.ps1', 'C:\x\app\abc1234\install-manifest.json', 'C:\x\app\abc1234/install-manifest.json', 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\send-telegram-notification.ps1')
    $script:PathExists = { param([string]$Path) return ($script:Paths -contains $Path) }
    $script:HostNameReader = { return 'OZK2026' }
    $rr = Invoke-OzkRegisterMonitorTask -AppRoot 'C:\ProgramData\OZK-TOBACCO\Backup\app\abc1234'
    Assert-True ($rr.status -eq 'dry-run' -and $script:RegCalls -eq 0) 'DryRun افتراضي لا يسجّل'
    Assert-True ((@($rr.spec.At) -join ',') -eq '23:30,00:45,08:00' -and $rr.spec.LogonType -eq 'S4U' -and $rr.spec.UserId -eq 'OZK2026\LOQ') 'المواعيد 23:30 و00:45 و08:00 باسم LOQ بنوع S4U'
    # Codex P1: يجب أن يوجد فحص بعد نهاية المهلة الآمنة (23:00 + GraceMinutes) وقبل الصباح.
    $graceEnd = ([datetime]'2026-10-15T23:00:00').AddMinutes(90)
    $afterGrace = @($rr.spec.At | Where-Object { $t = [datetime]('2026-10-16T' + $_ + ':00'); $t -ge $graceEnd -and $t -lt [datetime]'2026-10-16T08:00:00' })
    Assert-True ($afterGrace.Count -ge 1) 'يوجد فحص بين نهاية المهلة الآمنة (00:30) والصباح'
    Assert-True ($rr.spec.Arguments -match 'app\\abc1234[\\/]tools[\\/]backup[\\/]ozk-ameen-backup-monitor\.ps1' -and $rr.spec.Arguments -match 'send-telegram-notification') 'الأمر يشغّل المراقب من مجلد الإصدار مع Telegram'
    Assert-Throws { Invoke-OzkRegisterMonitorTask -Apply } '-Apply بلا مجلد إصدار حقيقي مرفوض'
    Assert-Throws { Invoke-OzkRegisterMonitorTask -Apply -TaskName 'TOBACCO Ameen Backup Monitor' -AppRoot 'C:\x\app\abc1234' } 'لا تسجيل فوق مهمة قائمة'
    $script:HostNameReader = { return 'MacBook-Air-Omar' }
    Assert-Throws { Invoke-OzkRegisterMonitorTask -Apply -AppRoot 'C:\x\app\abc1234' } 'لا تسجيل على جهاز غير OZK2026'
    $script:HostNameReader = { return 'OZK2026' }
    Assert-Throws { Invoke-OzkRegisterMonitorTask -At @('24:00') -AppRoot 'C:\x\app\abc1234' } 'وقت غير صالح مرفوض'
    Assert-Throws { Invoke-OzkRegisterMonitorTask -Apply -AppRoot 'C:\x\app\typo999' } 'مجلد إصدار غير موجود (خطأ مطبعي) ⇒ رفض قبل التسجيل (Codex P1)'
    Assert-True ($script:RegCalls -eq 0) 'لا تسجيل عند مسار إصدار غير موجود'
    $saved = $script:Paths
    $script:Paths = @($saved | Where-Object { $_ -notmatch 'install-manifest' })
    Assert-Throws { Invoke-OzkRegisterMonitorTask -Apply -AppRoot 'C:\x\app\abc1234' } 'إصدار بلا install-manifest.json ⇒ رفض'
    $script:Paths = @($saved | Where-Object { $_ -notmatch 'send-telegram' })
    Assert-Throws { Invoke-OzkRegisterMonitorTask -Apply -AppRoot 'C:\x\app\abc1234' } 'سكربت Telegram مفقود ⇒ رفض'
    $script:Paths = $saved
    $rr = Invoke-OzkRegisterMonitorTask -Apply -AppRoot 'C:\x\app\abc1234'
    Assert-True ($rr.status -eq 'registered' -and $script:RegCalls -eq 1) '-Apply على OZK2026 بإصدار مثبّت يستدعي المسجّل مرة واحدة (بديل وهمي)'
} finally {
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("FAILED: {0} assertion(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Test-OzkAmeenBackupMonitor: all assertions passed' -ForegroundColor Green
exit 0
