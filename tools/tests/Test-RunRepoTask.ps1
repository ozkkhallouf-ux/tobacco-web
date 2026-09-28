#Requires -Version 5.1
# ============================================================
# Test-RunRepoTask.ps1
#
# اختبارات سلوكية للمشغّل الموحّد (tools/deploy-gate/run-repo-task.ps1):
# الإيقاف المؤقت أثناء النشر، عمر العلامة، حماية سكربتات الكتابة ببصمات
# معتمدة، ورفض المسارات خارج المستودع. بلا شبكة ولا مهام مجدولة حقيقية.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-RunRepoTask.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$launcher = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'run-repo-task.ps1')

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }
function Write-TestFile([string]$Path, [string]$Content) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

. $launcher
$script:Alerts = New-Object System.Collections.ArrayList
function Send-LauncherAlert([string]$Message, [string]$DedupeKey) { [void]$script:Alerts.Add($DedupeKey) }

# المشغّل الفعلي في الإنتاج هو powershell.exe 5.1؛ هنا نفس المضيف الذي يشغّل الاختبار.
$psExe = (Get-Process -Id $PID).Path

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-launcher-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$repo = Join-Path $base 'repo'
$gate = Join-Path $base 'gate'
New-Item -ItemType Directory -Force -Path $repo, $gate | Out-Null
$marker = Join-Path $base 'ran.txt'

$body = @'
param([string]$Tag = 'none')
[System.IO.File]::AppendAllText('MARKER', $Tag + "`n")
exit 3
'@
Write-TestFile (Join-Path $repo 'tools/reader.ps1') ($body -replace 'MARKER', ($marker -replace "'", "''"))
Write-TestFile (Join-Path $repo 'tools/writer.ps1') ($body -replace 'MARKER', ($marker -replace "'", "''"))
Write-TestFile (Join-Path $repo 'tools/writer-helper.ps1') "'helper'`n"
Write-TestFile (Join-Path $base 'outside.ps1') "exit 0`n"

$logs = Join-Path $base 'logs'
$config = [pscustomobject]@{
    repoPath = $repo; gateDir = $gate; logDir = $logs; flagTtlMinutes = 15
    writerScripts = @('tools/writer.ps1', 'tools/writer-helper.ps1')
}
$flag = Join-Path $gate 'deploying.flag'
$allowPath = Join-Path $gate 'writer-allowlist.json'

function Get-Runs { if (Test-Path -LiteralPath $marker) { return @([System.IO.File]::ReadAllLines($marker) | Where-Object { $_ }) } return @() }
function Save-Allowlist {
    $files = [ordered]@{}
    foreach ($w in $config.writerScripts) { $files[$w] = (Get-FileHash -LiteralPath (Join-Path $repo $w) -Algorithm SHA256).Hash.ToLowerInvariant() }
    [System.IO.File]::WriteAllText($allowPath, ([pscustomobject]@{ sha = 'test'; files = $files } | ConvertTo-Json -Depth 5))
}

try {
    Write-Host '== Normal run'
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/reader.ps1' -Arguments @('-Tag', 'r1') -PsExe $psExe
    Assert-True ($code -eq 3) 'exit code of the task is passed through'
    Assert-True ((Get-Runs) -contains 'r1') 'arguments reach the task script'
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools\reader.ps1' -Arguments @('-Tag', 'r2') -PsExe $psExe
    Assert-True ($code -eq 3 -and (Get-Runs) -contains 'r2') 'backslash relative paths are accepted'

    Write-Host '== Deploy flag'
    Write-TestFile $flag '{}'
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/reader.ps1' -Arguments @('-Tag', 'r3') -PsExe $psExe
    Assert-True ($code -eq 0 -and -not ((Get-Runs) -contains 'r3')) 'fresh deploy flag => task skipped quietly'
    (Get-Item -LiteralPath $flag).LastWriteTime = (Get-Date).AddMinutes(-30)
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/reader.ps1' -Arguments @('-Tag', 'r4') -PsExe $psExe
    Assert-True ($code -eq 3 -and (Get-Runs) -contains 'r4') 'stale flag => reader resumes'
    Assert-True ($script:Alerts -contains 'launcher-stale-flag') 'stale flag raises an alert'
    Save-Allowlist
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/writer.ps1' -Arguments @('-Tag', 'w1') -PsExe $psExe
    Assert-True ($code -eq 0 -and -not ((Get-Runs) -contains 'w1')) 'stale flag => writer stays paused'
    Remove-Item -LiteralPath $flag

    Write-Host '== Writer hash pinning'
    Remove-Item -LiteralPath $allowPath
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/writer.ps1' -Arguments @('-Tag', 'w2') -PsExe $psExe
    Assert-True ($code -eq 1 -and -not ((Get-Runs) -contains 'w2')) 'writer without allowlist refused'
    Save-Allowlist
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/writer.ps1' -Arguments @('-Tag', 'w3') -PsExe $psExe
    Assert-True ($code -eq 3 -and (Get-Runs) -contains 'w3') 'writer with approved hashes runs'
    Add-Content -LiteralPath (Join-Path $repo 'tools/writer-helper.ps1') -Value "'changed'"
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/writer.ps1' -Arguments @('-Tag', 'w4') -PsExe $psExe
    Assert-True ($code -eq 1 -and -not ((Get-Runs) -contains 'w4')) 'any changed writer-group file blocks the writer'
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/reader.ps1' -Arguments @('-Tag', 'r5') -PsExe $psExe
    Assert-True ($code -eq 3 -and (Get-Runs) -contains 'r5') 'readers are not blocked by writer hashes'

    Write-Host '== Detected writers (pinned by the gate, not in writerScripts)'
    Write-TestFile (Join-Path $repo 'tools/detected.ps1') ($body -replace 'MARKER', ($marker -replace "'", "''"))
    Save-Allowlist
    $allow = [System.IO.File]::ReadAllText($allowPath) | ConvertFrom-Json
    $allow.files | Add-Member -NotePropertyName 'tools/detected.ps1' -NotePropertyValue ((Get-FileHash -LiteralPath (Join-Path $repo 'tools/detected.ps1') -Algorithm SHA256).Hash.ToLowerInvariant())
    [System.IO.File]::WriteAllText($allowPath, ($allow | ConvertTo-Json -Depth 5))
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/detected.ps1' -Arguments @('-Tag', 'd1') -PsExe $psExe
    Assert-True ($code -eq 3 -and (Get-Runs) -contains 'd1') 'pinned detected writer with matching hash runs'
    Add-Content -LiteralPath (Join-Path $repo 'tools/detected.ps1') -Value "# tampered"
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/detected.ps1' -Arguments @('-Tag', 'd2') -PsExe $psExe
    Assert-True ($code -eq 1 -and -not ((Get-Runs) -contains 'd2')) 'pinned detected writer with changed content is refused'

    Write-Host '== Trust boundary: the launcher never writes into gateDir'
    Assert-True (Test-Path -LiteralPath (Join-Path $logs 'launcher.log')) 'launcher log is written to logDir'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $gate 'launcher.log'))) 'no launcher log inside gateDir (trust files only)'
    $gateFiles = @(Get-ChildItem -LiteralPath $gate -File | ForEach-Object { $_.Name } | Sort-Object)
    Assert-True (@($gateFiles | Where-Object { @('writer-allowlist.json', 'deploying.flag') -notcontains $_ }).Count -eq 0) 'gateDir holds only files the test itself placed there'

    Write-Host '== Path safety'
    $code = Invoke-RepoTask -Config $config -RelativeScript '../outside.ps1' -Arguments @() -PsExe $psExe
    Assert-True ($code -eq 2) 'script outside the repository refused'
    $code = Invoke-RepoTask -Config $config -RelativeScript 'tools/missing.ps1' -Arguments @() -PsExe $psExe
    Assert-True ($code -eq 2 -and ($script:Alerts -contains 'launcher-missing-tools/missing.ps1')) 'missing script refused with alert'
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message)
} finally {
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    Write-Host ("Run repo task: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Run repo task: all checks passed' -ForegroundColor Green
exit 0
