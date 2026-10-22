# تبديل الطباعة التلقائية لفواتير Canon (المهمة OZK-AmeenAutoPrint وحدها).
# لا يلمس OZK Print Bridge ولا طابعة الكاشير 80mm ولا أي مهمة أخرى.
#
#   -Status   قراءة فقط: حالة المهمة والعملية
#   -Disable  إيقاف المهمة وتعطيلها بعد نسخ تعريفها XML (يحتاج موافقة عمر)
#   -Restore -SkipBacklog    إعادة التفعيل بلا طباعة المتراكم (الموصى به)
#   -Restore -AcceptBacklog  إعادة التفعيل مع طباعة كل المتراكم
#
# تنبيه الاسترجاع: المراقب يلحق بكل فاتورة جملة لم يطبعها خلال آخر 7 أيام
# (WATCH_LOOKBACK_DAYS). فكل فاتورة صدرت أثناء التعطيل — ومنها ما طُبع يدوياً —
# ستُطبع تلقائياً دفعة واحدة. لذلك يشترط الاسترجاع اختياراً صريحاً:
#   -SkipBacklog: يُعلَّم ملف الحالة schemaVersion = 1 (بعد نسخه احتياطياً)، فيشغّل
#     المراقب دورة الترحيل الموجودة فيه (adoptBaseline): كل فاتورة داخل النافذة
#     تُعدّ مطبوعة بلا ورقة، وتُسرد أرقامها في autoprint.log للمراجعة.
#   -AcceptBacklog: تشغيل على الحالة كما هي، فيُطبع المتراكم.
param([switch]$Status, [switch]$Disable, [switch]$Restore, [switch]$AcceptBacklog, [switch]$SkipBacklog,
    [string]$StatePath = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\ameen-autoprint\last-printed.json')
$ErrorActionPreference = 'Stop'
$Task = 'OZK-AmeenAutoPrint'
$Backup = Join-Path $env:ProgramData 'OZK\ManualA4Print\autoprint-task-backup'

if (@($Status, $Disable, $Restore | Where-Object { $_ }).Count -ne 1) { throw 'اختر واحداً: -Status أو -Disable أو -Restore' }
if ($env:COMPUTERNAME -ne 'OZK2026') { throw "هذا السكربت لـOZK2026 فقط (الجهاز الحالي $env:COMPUTERNAME)" }

function Get-State {
    $t = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
    if (-not $t) { throw "المهمة $Task غير موجودة" }
    $i = Get-ScheduledTaskInfo -TaskName $Task
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ameen-autoprint\\watcher\.js' })
    [pscustomobject]@{
        Task = $Task; State = [string]$t.State; Enabled = $t.Settings.Enabled
        LastRun = $i.LastRunTime; LastResult = $i.LastTaskResult
        WatcherPids = ($procs.ProcessId -join ',')
    }
}

if ($Status) { Get-State | Format-List; return }

if ($Disable) {
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Export-ScheduledTask -TaskName $Task | Set-Content -Encoding Unicode (Join-Path $Backup "$Task-$stamp.xml")
    'BEFORE:'; Get-State | Format-List
    Stop-ScheduledTask -TaskName $Task
    Disable-ScheduledTask -TaskName $Task | Out-Null
    # المهمة تشغّل run-watcher.bat الذي يشغّل node؛ إيقاف المهمة قد يترك node حياً.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ameen-autoprint\\watcher\.js' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Start-Sleep -Seconds 2
    'AFTER:'; Get-State | Format-List
    "BACKUP: $Backup\$Task-$stamp.xml"
    return
}

if ($Restore) {
    if ([int][bool]$AcceptBacklog + [int][bool]$SkipBacklog -ne 1) {
        throw 'اختر -SkipBacklog (بلا طباعة المتراكم) أو -AcceptBacklog (طباعة كل فواتير التعطيل حتى 7 أيام).'
    }
    $state = Get-State
    if ($state.WatcherPids) { throw "المراقب يعمل (PID $($state.WatcherPids)) — لا تعديل على ملف الحالة أثناء عمله." }
    if ($SkipBacklog) {
        if (-not (Test-Path $StatePath)) { throw "ملف الحالة غير موجود: $StatePath" }
        New-Item -ItemType Directory -Force -Path $Backup | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -LiteralPath $StatePath -Destination (Join-Path $Backup "last-printed-$stamp.json")
        $json = Get-Content -Raw -Encoding UTF8 $StatePath | ConvertFrom-Json
        $json.schemaVersion = 1
        # كتابة ذرّية: ملف مؤقت ثم استبدال، بلا BOM (المراقب يقرأ JSON.parse مباشرة).
        $tmp = "$StatePath.tmp"
        [IO.File]::WriteAllText($tmp, ($json | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item -Force $tmp $StatePath
        "STATE_MARKED_LEGACY: $StatePath (backup $Backup\last-printed-$stamp.json)"
    }
    'BEFORE:'; Get-State | Format-List
    Enable-ScheduledTask -TaskName $Task | Out-Null
    Start-ScheduledTask -TaskName $Task
    Start-Sleep -Seconds 5
    'AFTER:'; Get-State | Format-List
}
