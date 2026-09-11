[CmdletBinding()]
param(
    [string]$ExpectedHostName = "OZK2026",
    [string]$BridgeRoot = $PSScriptRoot,
    [string]$PrinterName = "XPRINTER XP-T80Q 80MM",
    [ValidateRange(100, 5000)]
    [int]$PollMilliseconds = 150,
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [Parameter(Mandatory = $true)]
    [string]$LogPath,
    [switch]$IncludeWholesale,
    [switch]$ConfirmPhysicalPrint
)

$ErrorActionPreference = "Stop"

if ($env:COMPUTERNAME -cne $ExpectedHostName) {
    throw "Refusing to run on '$env:COMPUTERNAME'; expected '$ExpectedHostName'."
}
if ($PrinterName -cne "XPRINTER XP-T80Q 80MM") {
    throw "Cashier receipts are restricted to XPRINTER XP-T80Q 80MM."
}
if (-not $ConfirmPhysicalPrint) {
    throw "The watchdog requires explicit physical-print confirmation."
}

$bridgeScript = Join-Path $BridgeRoot "ozk-print-bridge.ps1"
if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) {
    throw "Print Bridge script was not found."
}

function Write-WatchdogEvent([string]$EventName, [string]$Reason, [string]$ErrorType = "") {
    # Logging is best-effort: a locked events file, a missing/unwritable log
    # directory, or a full disk must never crash the watchdog. This function
    # is called from inside the bridge-restart catch block itself, so an
    # unhandled exception here would escape the outer try/catch and kill the
    # whole watchdog process (and with it the print-bridge restart loop) --
    # not just fail to log one event. Never rethrow, and never let the
    # fallback path itself recurse back into a failure.
    try {
        $entry = [ordered]@{
            Event = $EventName
            At = (Get-Date).ToUniversalTime().ToString("o")
            Reason = $Reason
            ErrorType = $ErrorType
            CustomerAndItemsRedacted = $true
        }
        $line = $entry | ConvertTo-Json -Compress
        $directory = Split-Path -Parent $LogPath
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $directory -Force)
        }
        [IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    } catch {
        try {
            Write-Warning "watchdog event logging failed for '$EventName' ($Reason): $($_.Exception.Message)"
        } catch {
        }
    }
}

# --- Single Instance Guard (defense-in-depth on top of Task Scheduler's
# MultipleInstances=IgnoreNew). Uses an OS-level named mutex rather than a
# lock file so a crashed/killed instance can never leave a stale lock behind
# (an abandoned mutex is still safely acquirable by the next process). If the
# mutex is already held, this instance logs a clear event and exits WITHOUT
# ever invoking the print bridge or touching Ameen/state/print logic. ---
$mutexName = "Global\OZK_PrintBridge_Watchdog_SingleInstance"
$mutexCreatedNew = $false
try {
    $singleInstanceMutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$mutexCreatedNew)
} catch {
    # Global\ namespace can be unavailable in some restricted contexts; fall back
    # to a session-local mutex rather than skipping the guard entirely.
    $mutexName = "Local\OZK_PrintBridge_Watchdog_SingleInstance"
    $singleInstanceMutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$mutexCreatedNew)
}

$acquiredMutex = $false
try {
    $acquiredMutex = $singleInstanceMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    # Previous holder terminated without releasing; ownership still transfers to us.
    $acquiredMutex = $true
}

if (-not $acquiredMutex) {
    Write-WatchdogEvent -EventName "watchdog_instance_already_running" -Reason "named_mutex_held_by_another_instance:$mutexName"
    exit 0
}

try {
    $bridgeParameters = @{
        Mode = "Observe"
        PollMilliseconds = $PollMilliseconds
        PrinterName = $PrinterName
        ConfirmPhysicalPrint = $true
        StatePath = $StatePath
        LogPath = $LogPath
    }
    if ($IncludeWholesale) { $bridgeParameters.IncludeWholesale = $true }

    while ($true) {
        try {
            & $bridgeScript @bridgeParameters
            Write-WatchdogEvent -EventName "watchdog_restart" -Reason "bridge_completed"
        } catch {
            Write-WatchdogEvent -EventName "watchdog_restart" -Reason "bridge_failed" -ErrorType $_.Exception.GetType().FullName
        }
        Start-Sleep -Seconds 1
    }
} finally {
    if ($acquiredMutex) {
        $singleInstanceMutex.ReleaseMutex()
    }
    $singleInstanceMutex.Dispose()
}
