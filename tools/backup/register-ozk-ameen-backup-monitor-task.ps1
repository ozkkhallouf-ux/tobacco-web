#Requires -Version 5.1
# ============================================================
# register-ozk-ameen-backup-monitor-task.ps1 — إعداد مهمة مراقب النسخ الاحتياطي
#
# الوضع الافتراضي DryRun: يطبع تعريف المهمة فقط ولا يلمس Task Scheduler.
# التسجيل الفعلي يحتاج -Apply صراحةً، وعلى OZK2026 وحده، وبموافقة المالك.
#
# المهمة: «OZK Ameen Backup Health Monitor» يومياً 23:30 و00:45 و08:00، باسم OZK2026\LOQ
# بنوع S4U، وتشغيل واحد في كل لحظة (IgnoreNew)، ومهلة 15 دقيقة.
# 00:45 يقع بعد نهاية المهلة الآمنة للنسخ (23:00 + 90 دقيقة = 00:30): إن وجد فحص 23:30
# النسخ ما زال يعمل (PENDING)، يُحسم الحكم في 00:45 لا في الصباح.
#
# لا يعدّل ولا يحذف أي مهمة موجودة: إن وُجدت مهمة بنفس الاسم يرفض.
# لا يلمس «TOBACCO Ameen Backup Pull» ولا «TOBACCO Ameen Backup Monitor» (قرار منفصل).
# ============================================================
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$TaskName = 'OZK Ameen Backup Health Monitor',
    [string[]]$At = @('23:30', '00:45', '08:00'),
    [string]$UserId = 'OZK2026\LOQ',
    [ValidateSet('S4U', 'Password', 'Interactive')][string]$LogonType = 'S4U',
    [string]$AppRoot = 'C:\ProgramData\OZK-TOBACCO\Backup\app\CURRENT',
    [string]$NotifyScript = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\send-telegram-notification.ps1',
    [string]$ExpectedHost = 'OZK2026',
    [int]$TimeLimitMinutes = 15
)

$ErrorActionPreference = 'Stop'

$script:HostNameReader = { return $env:COMPUTERNAME }
$script:TaskExists = { param([string]$Name) return [bool](Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) }
$script:PathExists = { param([string]$Path) return (Test-Path -LiteralPath $Path -PathType Leaf) }
$script:TaskRegistrar = {
    param($Spec)
    $action = New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Arguments -WorkingDirectory $Spec.WorkingDirectory
    $triggers = @($Spec.At | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ })
    $principal = New-ScheduledTaskPrincipal -UserId $Spec.UserId -LogonType $Spec.LogonType -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $Spec.TimeLimitMinutes) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName $Spec.TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description $Spec.Description | Out-Null
}

function New-OzkMonitorTaskSpec {
    param([string]$TaskName, [string[]]$At, [string]$UserId, [string]$LogonType, [string]$AppRoot, [string]$NotifyScript, [int]$TimeLimitMinutes)
    foreach ($t in $At) { if ($t -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw ('وقت غير صالح: ' + $t) } }
    if (@($At).Count -lt 1) { throw 'لا مواعيد' }
    $script = [System.IO.Path]::Combine([System.IO.Path]::Combine([System.IO.Path]::Combine($AppRoot, 'tools'), 'backup'), 'ozk-ameen-backup-monitor.ps1')
    return [pscustomobject]@{
        TaskName          = $TaskName
        At                = @($At)
        UserId            = $UserId
        LogonType         = $LogonType
        Execute           = 'powershell.exe'
        Arguments         = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" -NotifyScript "' + $NotifyScript + '"')
        WorkingDirectory  = $AppRoot
        MultipleInstances = 'IgnoreNew'
        TimeLimitMinutes  = $TimeLimitMinutes
        Description       = 'OZK: مراقب قراءة فقط لنظام OZK Ameen Verified Backup (status.json + SHA256 على C: والقرص الخارجي + Task Scheduler). tools/backup/README.md'
    }
}

function Invoke-OzkRegisterMonitorTask {
    [CmdletBinding()]
    param(
        [switch]$Apply,
        [string]$TaskName = 'OZK Ameen Backup Health Monitor',
        [string[]]$At = @('23:30', '00:45', '08:00'),
        [string]$UserId = 'OZK2026\LOQ',
        [string]$LogonType = 'S4U',
        [string]$AppRoot = 'C:\ProgramData\OZK-TOBACCO\Backup\app\CURRENT',
        [string]$NotifyScript = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\send-telegram-notification.ps1',
        [string]$ExpectedHost = 'OZK2026',
        [int]$TimeLimitMinutes = 15
    )
    $spec = New-OzkMonitorTaskSpec -TaskName $TaskName -At $At -UserId $UserId -LogonType $LogonType -AppRoot $AppRoot -NotifyScript $NotifyScript -TimeLimitMinutes $TimeLimitMinutes
    Write-Host ('المهمة: ' + $spec.TaskName)
    Write-Host ('  يومياً ' + ($spec.At -join ' و') + ' · ' + $spec.UserId + ' · ' + $spec.LogonType + ' · IgnoreNew · مهلة ' + $spec.TimeLimitMinutes + ' دقيقة')
    Write-Host ('  ' + $spec.Execute + ' ' + $spec.Arguments)
    if (-not $Apply) {
        Write-Host '== DryRun (الافتراضي): لم يُسجَّل شيء في Task Scheduler =='
        return [pscustomobject]@{ status = 'dry-run'; spec = $spec }
    }
    $h = & $script:HostNameReader
    if ($h -ne $ExpectedHost) { throw ("الجهاز الحالي '{0}' ليس '{1}'. لا تسجيل." -f $h, $ExpectedHost) }
    if ($AppRoot -match 'CURRENT$') { throw 'مرّر -AppRoot لمجلد إصدار مثبّت فعلياً (مثل app\<commit>).' }
    # المهمة لا تُسجَّل إلا لإصدار مثبّت فعلاً: مسار خاطئ يعني مراقباً يفشل كل ليلة بصمت.
    $monScript = [System.IO.Path]::Combine([System.IO.Path]::Combine([System.IO.Path]::Combine($AppRoot, 'tools'), 'backup'), 'ozk-ameen-backup-monitor.ps1')
    $manifest = [System.IO.Path]::Combine($AppRoot, 'install-manifest.json')
    if (-not (& $script:PathExists $monScript)) { throw ('سكربت المراقب غير موجود في الإصدار: ' + $monScript) }
    if (-not (& $script:PathExists $manifest)) { throw ('install-manifest.json غير موجود في الإصدار: ' + $manifest) }
    if (-not (& $script:PathExists $NotifyScript)) { throw ('سكربت Telegram غير موجود: ' + $NotifyScript) }
    if (& $script:TaskExists $spec.TaskName) { throw ('مهمة بنفس الاسم موجودة، لن تُعدَّل: ' + $spec.TaskName) }
    & $script:TaskRegistrar $spec
    Write-Host ('سُجّلت المهمة: ' + $spec.TaskName)
    return [pscustomobject]@{ status = 'registered'; spec = $spec }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $r = Invoke-OzkRegisterMonitorTask -Apply:$Apply -TaskName $TaskName -At $At -UserId $UserId -LogonType $LogonType `
            -AppRoot $AppRoot -NotifyScript $NotifyScript -ExpectedHost $ExpectedHost -TimeLimitMinutes $TimeLimitMinutes
        if ($r.status -eq 'dry-run' -or $r.status -eq 'registered') { exit 0 }
        exit 1
    } catch {
        Write-Host ('FAIL: ' + $_.Exception.Message)
        exit 1
    }
}
