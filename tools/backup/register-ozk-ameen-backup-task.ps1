#Requires -Version 5.1
# ============================================================
# register-ozk-ameen-backup-task.ps1 — إعداد مهمة النسخ اليومي المُتحقَّق
#
# الوضع الافتراضي DryRun: يطبع تعريف المهمة فقط ولا يلمس Task Scheduler.
# التسجيل الفعلي يحتاج -Apply صراحةً، وعلى OZK2026 وحده، وبموافقة المالك.
#
# المهمة: "OZK Ameen Verified Backup" يومياً 23:00 باسم OZK2026\LOQ، بنوع
# تسجيل S4U (تعمل والمستخدم غير مسجّل الدخول، بلا تخزين كلمة مرور)، وتشغيل
# واحد فقط في كل لحظة (MultipleInstances=IgnoreNew)، ومهلة ساعتين.
#
# لا يعدّل ولا يحذف أي مهمة موجودة: إن وُجدت مهمة بنفس الاسم يرفض.
# لا يلمس "OZK Ameen Full Backup" ولا "TOBACCO Ameen Backup Pull" (قرار منفصل).
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\register-ozk-ameen-backup-task.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\register-ozk-ameen-backup-task.ps1 -Apply
# ============================================================
[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$TaskName = 'OZK Ameen Verified Backup',
    [string]$At = '23:00',
    [string]$UserId = 'OZK2026\LOQ',
    [ValidateSet('S4U', 'Password', 'Interactive')][string]$LogonType = 'S4U',
    [string]$RepoRoot = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web',
    [string]$Launcher = 'C:\ProgramData\OZK-TOBACCO\DeployGate\run-repo-task.ps1',
    [string]$NotifyScript = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\send-telegram-notification.ps1',
    [string]$ExpectedHost = 'OZK2026',
    [int]$TimeLimitHours = 2
)

$ErrorActionPreference = 'Stop'

# ---------- نقاط حقن للاختبارات ----------
$script:HostNameReader = { return $env:COMPUTERNAME }
$script:TaskExists = { param([string]$Name) return [bool](Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) }
$script:PathExists = { param([string]$Path) return (Test-Path -LiteralPath $Path) }
$script:TaskRegistrar = {
    param($Spec)
    $action = New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Arguments -WorkingDirectory $Spec.WorkingDirectory
    $trigger = New-ScheduledTaskTrigger -Daily -At $Spec.At
    $principal = New-ScheduledTaskPrincipal -UserId $Spec.UserId -LogonType $Spec.LogonType -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours $Spec.TimeLimitHours) -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
    Register-ScheduledTask -TaskName $Spec.TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $Spec.Description | Out-Null
}

# يبني تعريف المهمة كبيانات صرفة (قابلة للاختبار بلا Task Scheduler).
function New-OzkBackupTaskSpec {
    param(
        [string]$TaskName, [string]$At, [string]$UserId, [string]$LogonType, [string]$RepoRoot,
        [string]$Launcher, [bool]$UseLauncher, [string]$NotifyScript, [int]$TimeLimitHours
    )
    if ($At -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw ('وقت غير صالح: ' + $At) }
    $backupArgs = '-Execute -NotifyScript "' + $NotifyScript + '"'
    if ($UseLauncher) {
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $Launcher + '" -Script "tools/backup/ozk-ameen-backup.ps1" ' + $backupArgs
    } else {
        $script = [System.IO.Path]::Combine([System.IO.Path]::Combine([System.IO.Path]::Combine($RepoRoot, 'tools'), 'backup'), 'ozk-ameen-backup.ps1')
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '" ' + $backupArgs
    }
    return [pscustomobject]@{
        TaskName          = $TaskName
        At                = $At
        UserId            = $UserId
        LogonType         = $LogonType
        Execute           = 'powershell.exe'
        Arguments         = $arguments
        WorkingDirectory  = $RepoRoot
        MultipleInstances = 'IgnoreNew'
        TimeLimitHours    = $TimeLimitHours
        UsesLauncher      = $UseLauncher
        Description       = 'OZK: نسخ احتياطي يومي مُتحقَّق للأمين (COPY_ONLY + CHECKSUM + VERIFYONLY + SHA256) إلى C: والقرص الخارجي. tools/backup/README.md'
    }
}

function Invoke-OzkRegisterBackupTask {
    [CmdletBinding()]
    param(
        [switch]$Apply,
        [string]$TaskName = 'OZK Ameen Verified Backup',
        [string]$At = '23:00',
        [string]$UserId = 'OZK2026\LOQ',
        [string]$LogonType = 'S4U',
        [string]$RepoRoot = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web',
        [string]$Launcher = 'C:\ProgramData\OZK-TOBACCO\DeployGate\run-repo-task.ps1',
        [string]$NotifyScript = 'C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\send-telegram-notification.ps1',
        [string]$ExpectedHost = 'OZK2026',
        [int]$TimeLimitHours = 2
    )
    $useLauncher = [bool](& $script:PathExists $Launcher)
    $spec = New-OzkBackupTaskSpec -TaskName $TaskName -At $At -UserId $UserId -LogonType $LogonType -RepoRoot $RepoRoot `
        -Launcher $Launcher -UseLauncher $useLauncher -NotifyScript $NotifyScript -TimeLimitHours $TimeLimitHours

    Write-Host ('المهمة: ' + $spec.TaskName)
    Write-Host ('  يومياً ' + $spec.At + ' · ' + $spec.UserId + ' · ' + $spec.LogonType + ' · MultipleInstances=' + $spec.MultipleInstances + ' · مهلة ' + $spec.TimeLimitHours + 'h')
    Write-Host ('  ' + $spec.Execute + ' ' + $spec.Arguments)
    if (-not $useLauncher) { Write-Host '  ملاحظة: مشغّل بوابة النشر غير موجود على هذا الجهاز؛ التعريف يشغّل السكربت مباشرة.' }

    if (-not $Apply) {
        Write-Host '== DryRun (الافتراضي): لم يُسجَّل شيء في Task Scheduler =='
        return [pscustomobject]@{ status = 'dry-run'; spec = $spec }
    }
    $hostName = & $script:HostNameReader
    if ($hostName -ne $ExpectedHost) { throw ("الجهاز الحالي '{0}' ليس '{1}'. لا تسجيل." -f $hostName, $ExpectedHost) }
    if (& $script:TaskExists $spec.TaskName) { throw ('مهمة بنفس الاسم موجودة، لن تُعدَّل: ' + $spec.TaskName) }
    & $script:TaskRegistrar $spec
    Write-Host ('سُجّلت المهمة: ' + $spec.TaskName)
    return [pscustomobject]@{ status = 'registered'; spec = $spec }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $r = Invoke-OzkRegisterBackupTask -Apply:$Apply -TaskName $TaskName -At $At -UserId $UserId -LogonType $LogonType `
            -RepoRoot $RepoRoot -Launcher $Launcher -NotifyScript $NotifyScript -ExpectedHost $ExpectedHost -TimeLimitHours $TimeLimitHours
        if ($r.status -eq 'dry-run' -or $r.status -eq 'registered') { exit 0 }
        exit 1
    } catch {
        Write-Host ('FAIL: ' + $_.Exception.Message)
        exit 1
    }
}
