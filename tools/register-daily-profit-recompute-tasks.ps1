# ============================================================
# register-daily-profit-recompute-tasks.ps1  (ASCII only: Windows PowerShell 5.1)
#
# PROPOSED, NOT REGISTERED. Run only with the owner's explicit approval, after
# Migration 31 is applied and this commit is deployed through the deploy gate.
#
# Registers two scheduled tasks that run tools/recompute-daily-profit.ps1
# through the deploy-gate launcher (run-repo-task.ps1):
#   TOBACCO Daily Profit Recompute 30d     every night, the 30 days before today
#   TOBACCO Daily Profit Recompute Year    once a week, the whole Ameen year
# Both read Ameen with SELECT only and write Supabase only through
# rpc/recompute_ameen_daily_profit (changed days only, created_at untouched).
# The current day stays with push-daily-profit.ps1 and is never recomputed here.
#
# Overlap: MultipleInstances=IgnoreNew per task, plus an exclusive lock file
# inside the script shared by both tasks (a second run exits with SKIP).
# Times avoid 23:00 (Ameen verified backup) and the 07:30 morning start.
#
# Remove:  Unregister-ScheduledTask -TaskName "TOBACCO Daily Profit Recompute 30d" -Confirm:$false
#          Unregister-ScheduledTask -TaskName "TOBACCO Daily Profit Recompute Year" -Confirm:$false
# ============================================================
param(
    [string]$NightlyAt = "02:40",
    [string]$WeeklyAt = "03:40",
    [ValidateSet("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")]
    [string]$WeeklyDay = "Friday",
    [int]$NightlyDays = 30,
    [string]$Launcher = "C:\ProgramData\OZK-TOBACCO\DeployGate\run-repo-task.ps1",
    [string]$UserId = "$env:USERDOMAIN\$env:USERNAME",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "recompute-daily-profit.ps1"
if (-not (Test-Path $scriptPath)) { throw "missing $scriptPath" }
if ($scriptPath -like "*\.claude\worktrees\*") { throw "run this from the main repository copy, not a temporary worktree." }
if (-not (Test-Path $Launcher)) { throw "deploy-gate launcher not found: $Launcher" }

$tasks = @(
    @{ Name = "TOBACCO Daily Profit Recompute 30d"; Args = "-Days $NightlyDays"; Trigger = (New-ScheduledTaskTrigger -Daily -At $NightlyAt); Limit = 20 },
    @{ Name = "TOBACCO Daily Profit Recompute Year"; Args = "-FullYear"; Trigger = (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $WeeklyDay -At $WeeklyAt); Limit = 45 }
)

foreach ($t in $tasks) {
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`" -Script `"tools/recompute-daily-profit.ps1`" $($t.Args)"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Minutes $t.Limit) `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable `
        -RestartCount 1 `
        -RestartInterval (New-TimeSpan -Minutes 15)
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited
    if ($WhatIf) {
        Write-Host ("WHATIF {0}: powershell.exe {1}" -f $t.Name, $arg)
        continue
    }
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $t.Trigger -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host ("Registered {0}" -f $t.Name)
}
