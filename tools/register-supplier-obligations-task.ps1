#requires -Version 5.1
# ============================================================================
# تسجيل مهمة «التزامات الموردين» فقط. هذا السكريبت لا يشغّل المهمة ولا المنتج.
#
# سبب وجوده: تدقيق 2026-09-06 أثبت أن tools/push-supplier-obligations.ps1 مكتوب
# ومختبَر لكنه غير مجدول إطلاقاً — لا توجد بين 22 سكريبت register-* واحدة له،
# فبقي جدول supplier_obligations فارغاً منذ إنشائه.
#
# ما يغذّيه هذا الجدول هو **الالتزام المالي وحده**. أولوية الشراء من المورد
# تُحسب في لوحة القرار من نواقص أصنافه، ولا تعتمد على هذا الجدول إطلاقاً.
# ============================================================================
[CmdletBinding()]
param(
    # كل ساعتين: أرصدة الموردين تتغيّر بوتيرة الفواتير والدفعات لا بوتيرة البيع،
    # فلا داعي لإيقاع أسرع، والقراءة على الأمين تبقى خفيفة.
    [ValidateRange(1, 24)][int]$IntervalHours = 2,
    [ValidatePattern('^(?:[01]\d|2[0-3]):[0-5]\d$')][string]$StartAt = "00:23",
    [Switch]$ReplaceExisting
)

$ErrorActionPreference = "Stop"
$taskName = "TOBACCO Supplier Obligations Push"
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

$scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "push-supplier-obligations.ps1"))
$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Producer not found: $scriptPath" }
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { throw "Windows PowerShell 5.1 executable was not found." }
if ($scriptPath.Contains('"')) { throw "Producer path contains an unsupported quote character." }

$tokens = $null
$parserErrors = $null
[Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parserErrors) | Out-Null
if ($parserErrors.Count -ne 0) { throw "Supplier obligations producer failed PowerShell parser validation." }

# -AllowEmpty غائب عمداً: المهمة المجدولة لا تملك أبداً صلاحية تفريغ الجدول.
# مسح الالتزامات قرار يدوي صريح، لا أثر جانبي لتشغيل آلي.
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Apply -MinimumIntervalMinutes 60"
$action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument $arguments `
    -WorkingDirectory $repoRoot
$startAt = [datetime]::Today.Add([timespan]::ParseExact($StartAt, 'hh\:mm', $null))
if ($startAt -le (Get-Date)) { $startAt = $startAt.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $startAt
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $startAt `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
    -RepetitionDuration ([timespan]::MaxValue)).Repetition
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)
$taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId $requiredUserId `
    -LogonType Password `
    -RunLevel Highest
$taskDefinition = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $taskPrincipal `
    -Description "Reads supplier balances from Ameen (read-only) and publishes them to Supabase supplier_obligations. Financial obligation only; it never drives purchase priority."

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
Write-Host "Run a dry run first to review the numbers:  .\tools\push-supplier-obligations.ps1"
Write-Host "The task was not started by this registration script."
