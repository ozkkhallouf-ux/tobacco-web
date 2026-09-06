#requires -Version 5.1
# Registration only. This script never starts the task or the producer.
[CmdletBinding()]
param(
    # الإيقاع الساعي مقصود: بوابة حداثة المبيعات ترفض أي تشغيل يبعد أكثر من 75
    # دقيقة عن آخر مزامنة مبيعات، ومشغّل يومي واحد يعني أن أي رفض يجمّد اللقطة
    # 24 ساعة كاملة. الساعي يعيد المحاولة من تلقائه ويحدّ الضرر بساعة واحدة.
    [ValidateRange(1, 24)][int]$IntervalHours = 1,
    [ValidatePattern('^(?:[01]\d|2[0-3]):[0-5]\d$')][string]$StartAt = "00:07",
    [Switch]$ReplaceExisting
)

$ErrorActionPreference = "Stop"
$taskName = "TOBACCO Ameen Item Snapshot Refresh"
$requiredUserId = "OZK2026\LOQ"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$adminPrincipal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $adminPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this registration script from an elevated Windows PowerShell session."
}
if (-not $identity.Name.Equals($requiredUserId, [StringComparison]::OrdinalIgnoreCase)) {
    throw "This task must be registered from the OZK2026\LOQ Windows account."
}

$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    if (-not $ReplaceExisting) {
        throw "Scheduled task '$taskName' already exists. No changes were made. Re-run with -ReplaceExisting to explicitly replace it."
    }
    Write-Warning "ReplaceExisting was explicitly requested. The existing scheduled task '$taskName' will be replaced; it will not be started or stopped."
}

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$expectedRepoRoot = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE "Documents\OZK-TOBACCO\tobacco-web"))
if (-not $repoRoot.Equals($expectedRepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Registration is allowed only from the permanent production checkout: $expectedRepoRoot"
}

$scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "push-purchase-item-snapshot.ps1"))
$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Producer wrapper not found: $scriptPath" }
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { throw "Windows PowerShell 5.1 executable was not found." }
if ($scriptPath.Contains('"')) { throw "Producer path contains an unsupported quote character." }

$tokens = $null
$parserErrors = $null
[Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parserErrors) | Out-Null
if ($parserErrors.Count -ne 0) { throw "Snapshot producer wrapper failed PowerShell parser validation." }

$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Apply"
$action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument $arguments `
    -WorkingDirectory $repoRoot

# اسم مستقل عمداً عن $StartAt: أسماء المتغيرات في PowerShell غير حساسة لحالة
# الأحرف، فـ$startAt و$StartAt هما نفس المتغير فعلياً. إسناد كائن [datetime]
# لمتغير يحمل [ValidatePattern] الخاص بالسلسلة النصية يعيد تطبيق التحقق على
# القيمة الجديدة فيفشل بخطأ ValidatePattern غامض لا علاقة له بالسبب الحقيقي.
$firstRunAt = [datetime]::Today.Add([timespan]::ParseExact($StartAt, 'hh\:mm', $null))
if ($firstRunAt -le (Get-Date)) { $firstRunAt = $firstRunAt.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $firstRunAt
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $firstRunAt `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)).Repetition
# فراغ = تكرار بلا نهاية. TimeSpan::MaxValue يرفضه Task Scheduler عند التسجيل
# فتفشل المهمة بصمت ولا تُنشأ أصلاً — نفس السابقة في register-ameen-sync-watchdog.ps1
$trigger.Repetition.Duration = ""
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId $requiredUserId `
    -LogonType Password `
    -RunLevel Highest
$taskDefinition = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $taskPrincipal `
    -Description "Hourly Supabase-only refresh of ameen_item_snapshot from trusted sales_line_items. Failures raise a Telegram alert."

Write-Host "The task will run as $requiredUserId with LogonType Password."
Write-Host "Enter the Windows password when prompted. It is not written to disk or printed."
$securePassword = Read-Host -Prompt "Windows password for $requiredUserId" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    if ([string]::IsNullOrEmpty($plainPassword)) {
        throw "A Windows password is required to register this scheduled task."
    }

    $registrationParameters = @{
        TaskName    = $taskName
        InputObject = $taskDefinition
        User        = $requiredUserId
        Password    = $plainPassword
        ErrorAction = "Stop"
    }
    if (($null -ne $existingTask) -and $ReplaceExisting) {
        $registrationParameters["Force"] = $true
    }

    Register-ScheduledTask @registrationParameters | Out-Null
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    $plainPassword = $null
    if ($securePassword) { $securePassword.Dispose() }
}

Write-Host "Registered task: $taskName"
Write-Host "Schedule: every $IntervalHours hour(s), first run at $StartAt (local machine time)"
Write-Host "The task was not started by this registration script."
