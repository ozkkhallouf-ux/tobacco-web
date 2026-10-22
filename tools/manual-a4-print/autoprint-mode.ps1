# تبديل الطباعة التلقائية لفواتير Canon (المهمة OZK-AmeenAutoPrint وحدها).
# لا يلمس OZK Print Bridge ولا طابعة الكاشير 80mm ولا أي مهمة أخرى.
#
#   -Status   قراءة فقط: حالة المهمة والعملية
#   -Disable  إيقاف المهمة وتعطيلها بعد نسخ تعريفها XML (يحتاج موافقة عمر)
#   -Restore -AcceptBacklog  إعادة تفعيل المهمة وتشغيلها — يعيد الوضع القديم كما كان
#
# تنبيه الاسترجاع: المراقب يلحق بكل فاتورة جملة لم يطبعها خلال آخر 7 أيام
# (WATCH_LOOKBACK_DAYS). فكل فاتورة صدرت أثناء التعطيل — ومنها ما طُبع يدوياً —
# ستُطبع تلقائياً دفعة واحدة عند الاسترجاع. لذلك يشترط -AcceptBacklog صراحة.
param([switch]$Status, [switch]$Disable, [switch]$Restore, [switch]$AcceptBacklog)
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
    if (-not $AcceptBacklog) {
        throw 'الاسترجاع سيطبع تلقائياً كل فواتير الجملة منذ التعطيل (حتى 7 أيام). أعد التشغيل مع -AcceptBacklog بعد التأكد.'
    }
    'BEFORE:'; Get-State | Format-List
    Enable-ScheduledTask -TaskName $Task | Out-Null
    Start-ScheduledTask -TaskName $Task
    Start-Sleep -Seconds 5
    'AFTER:'; Get-State | Format-List
}
