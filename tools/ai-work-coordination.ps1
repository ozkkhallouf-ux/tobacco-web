param(
    [ValidateSet('Status', 'Claim', 'Complete')]
    [string]$Action = 'Status',
    [ValidateSet('Claude', 'Codex', 'Human')]
    [string]$Owner,
    [string]$Task,
    [string[]]$Files = @(),
    [string]$Note = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $repo 'AI_ACTIVE_TASK.json'
$handoffPath = Join-Path $repo 'AI_HANDOFF.md'

function Read-Lock {
    Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $normalizedContent = $Content.Replace("`r`n", "`n").Replace("`r", "`n")
    [System.IO.File]::WriteAllText($Path, $normalizedContent, [System.Text.UTF8Encoding]::new($false))
}

function Save-Lock($Lock) {
    Write-Utf8NoBom $lockPath (($Lock | ConvertTo-Json -Depth 5) + "`n")
}

$lock = Read-Lock
$currentBranch = (git -C $repo branch --show-current).Trim()

if ($Action -eq 'Status') {
    $lock | ConvertTo-Json -Depth 5
    exit 0
}

if ($currentBranch -ne 'main') {
    throw "Claim and Complete must run on main so every device can see the shared lock. Current branch: $currentBranch"
}

if (-not $Owner -or -not $Task) {
    throw 'Claim and Complete require -Owner and -Task.'
}

$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

if ($Action -eq 'Claim') {
    if ($lock.status -eq 'active') {
        throw "Task is locked by $($lock.owner): $($lock.task). Wait for handoff."
    }

    $lock.status = 'active'
    $lock.owner = $Owner
    $lock.task = $Task
    $lock.branch = "task branch pending for: $Task"
    $lock.files = @($Files)
    $lock.startedAt = $now
    $lock.updatedAt = $now
    $lock.note = if ($Note) { $Note } else { 'Work in progress. Do not edit the reserved files.' }
    Save-Lock $lock

    Write-Output "Task claimed by $Owner. Commit and push the lock on main, then create a task branch."
    exit 0
}

if ($lock.status -ne 'active') {
    throw 'There is no active task to complete.'
}
if ($lock.owner -ne $Owner) {
    throw "The active task belongs to $($lock.owner), not $Owner."
}

$entry = @"
## $((Get-Date).ToString('yyyy-MM-dd')) - $Owner - $Task

- Status: completed
- Branch: $($lock.branch)
- Files: $(@($lock.files) -join ', ')
- Result: $(if ($Note) { $Note } else { 'Task completed and handed off.' })
- Handoff UTC: $now

"@
$handoff = Get-Content -LiteralPath $handoffPath -Raw -Encoding UTF8
$firstHistory = $handoff.IndexOf('## 20')
if ($firstHistory -lt 0) { $firstHistory = $handoff.Length }
$handoff = $handoff.Insert($firstHistory, $entry)
Write-Utf8NoBom $handoffPath $handoff

$lock.status = 'idle'
$lock.owner = $null
$lock.task = $null
$lock.branch = $null
$lock.files = @()
$lock.startedAt = $null
$lock.updatedAt = $now
$lock.note = 'No active task. Read AI_HANDOFF.md before starting work.'
Save-Lock $lock
Write-Output 'Task completed and handoff log updated.'
