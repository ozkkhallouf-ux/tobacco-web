#Requires -Version 5.1
# ============================================================
# Test-MigrationPreflight.ps1
#
# Codex P1 #5: tools/auto-sync-price-lists.ps1 يرفض العمل على غير main، فتحويل
# المستودع التشغيلي إلى windows-production يوقف مهمة OZK-PriceListSync. الفحص
# (tools/deploy-gate/migration-preflight.ps1) يحجب التحويل حتى تعمل كل مهمة تحتاج
# main من worktree مخصّص صحيح. منذ 2026-10-25 المزامنة متقاعدة (retiredMainTasks):
# الفحص يشترط بقاءها معطّلة، والـworktree يبقى ممنوعاً على كل المهام. الاختبار يبني مستودعاً تشغيلياً وworktree لـmain بـgit
# حقيقي، ويستبدل قراءة المهام المجدولة فقط.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-MigrationPreflight.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$preflight = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'migration-preflight.ps1')
$exampleConfig = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'deploy-gate' 'gate-config.example.json')

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }

function Invoke-TestGit([string]$Dir, [string[]]$GitArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git -C $Dir -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false @GitArgs 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    if ($code -ne 0) { throw ('git ' + ($GitArgs -join ' ') + ' failed: ' + ($out -join ' ')) }
    return ((@($out) -join "`n").Trim())
}
function Write-TestFile([string]$Path, [string]$Content) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

. $preflight

# المهام المجدولة الوهمية: اسم ⇒ نص الـAction.
$script:Tasks = @{}
function Get-PreflightTaskNames { return @($script:Tasks.Keys) }
function Get-PreflightTaskActionText([string]$TaskName) { if ($script:Tasks.ContainsKey($TaskName)) { return $script:Tasks[$TaskName] } return $null }
# حالة المهمة الوهمية: من $script:States إن وُجدت، وإلا 'Ready' لكل مهمة مسجّلة.
$script:States = @{}
function Get-PreflightTaskState([string]$TaskName) {
    if ($script:States.ContainsKey($TaskName)) { return $script:States[$TaskName] }
    if ($script:Tasks.ContainsKey($TaskName)) { return 'Ready' }
    return $null
}

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-preflight-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $base | Out-Null
$official = 'https://github.com/ozkkhallouf-ux/tobacco-web.git'

try {
    # مستودع تشغيلي على windows-production + worktree مخصّص لـmain بالـremote الرسمي
    $origin = Join-Path $base 'origin.git'
    $repo = Join-Path $base 'tobacco-web'
    $mainWt = Join-Path $base 'tobacco-web-main'
    Invoke-TestGit $base @('init', '-q', '--bare', $origin) | Out-Null
    Invoke-TestGit $base @('clone', '-q', $origin, $repo) | Out-Null
    Invoke-TestGit $repo @('checkout', '-q', '-b', 'main') | Out-Null
    Write-TestFile (Join-Path $repo 'tools/auto-sync-price-lists.ps1') "'price sync'`n"
    Write-TestFile (Join-Path $repo 'tools/other.ps1') "'other'`n"
    Invoke-TestGit $repo @('add', '-A') | Out-Null
    Invoke-TestGit $repo @('commit', '-q', '-m', 'init') | Out-Null
    Invoke-TestGit $repo @('push', '-q', 'origin', 'main') | Out-Null
    Invoke-TestGit $repo @('checkout', '-q', '-b', 'windows-production') | Out-Null
    Invoke-TestGit $repo @('remote', 'set-url', 'origin', $official) | Out-Null
    Invoke-TestGit $repo @('worktree', 'add', '-q', $mainWt, 'main') | Out-Null

    $config = [System.IO.File]::ReadAllText($exampleConfig) | ConvertFrom-Json
    $config.repoPath = $repo
    $config.mainWorktree.path = $mainWt
    # آلية mainDependentTasks نفسها تُختبر بمهمة معلنة صراحةً (الإعداد الفعلي فارغ منذ تقاعد
    # مزامنة النشرات؛ القسم الأخير يختبره كما هو).
    $config.mainDependentTasks = @([pscustomobject]@{ task = 'OZK-PriceListSync'; script = 'tools/auto-sync-price-lists.ps1'; reason = 'fixture' })
    $config.retiredMainTasks = @()
    $sep = [IO.Path]::DirectorySeparatorChar
    $inRepo = (Join-Path $repo 'tools') + $sep + 'auto-sync-price-lists.ps1'
    $inMain = (Join-Path $mainWt 'tools') + $sep + 'auto-sync-price-lists.ps1'
    $ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    function Get-Verdict($Report, [string]$Task) { return @($Report.results | Where-Object { $_.task -eq $Task })[0] }

    Write-Host '== main-dependent task still on the operational repo'
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $inRepo + '"') }
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*operational repository*') 'price-list sync on the operational repo => migration BLOCKED'
    $wrapper = Join-Path $base 'ozk-pricelistsync-hidden.vbs'
    Write-TestFile $wrapper ('Set shell = CreateObject("WScript.Shell")' + "`n" + 'shell.Run """' + $ps + '"" -File ""' + $inRepo + '""", 0, True' + "`n")
    $script:Tasks = @{ 'OZK-PriceListSync' = ('wscript.exe "' + $wrapper + '"') }
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok) 'wrapper (vbs) indirection is followed: still BLOCKED'

    Write-Host '== moved to the dedicated main worktree'
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $inMain + '"'); 'TOBACCO Ameen Sync' = ($ps + ' -File "' + ((Join-Path $repo 'tools') + $sep + 'other.ps1') + '"') }
    $r = Invoke-MigrationPreflight $config
    Assert-True ($r.ok -and (Get-Verdict $r 'OZK-PriceListSync').verdict -eq 'PASS') 'price-list sync on the correct main worktree => preflight PASS'
    Write-TestFile $wrapper ('shell.Run """' + $ps + '"" -File ""' + $inMain + '""", 0, True' + "`n")
    $script:Tasks = @{ 'OZK-PriceListSync' = ('wscript.exe "' + $wrapper + '"') }
    $r = Invoke-MigrationPreflight $config
    Assert-True ($r.ok) 'wrapper pointing at the main worktree => PASS'

    Write-Host '== wrong worktree / branch / remote'
    $other = Join-Path $base 'somewhere-else'
    Invoke-TestGit $base @('clone', '-q', $origin, $other) | Out-Null
    Invoke-TestGit $other @('remote', 'set-url', 'origin', $official) | Out-Null
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + ((Join-Path $other 'tools') + $sep + 'auto-sync-price-lists.ps1') + '"') }
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*unapproved worktree*') 'task on an unconfigured worktree => BLOCK'
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $inMain + '"') }
    Invoke-TestGit $mainWt @('checkout', '-q', '-b', 'feature/x') | Out-Null
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*not ''main''*') 'main worktree on the wrong branch => BLOCK'
    # الحالة الفعلية على OZK2026 (تدقيق 2026-10-20): tobacco-web-main HEAD منفصل على commit قديم.
    Invoke-TestGit $mainWt @('checkout', '-q', '--detach', 'main') | Out-Null
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*detached HEAD at*') 'main worktree on a detached HEAD => BLOCK and named as detached'
    Invoke-TestGit $mainWt @('checkout', '-q', 'main') | Out-Null
    Invoke-TestGit $repo @('remote', 'set-url', 'origin', 'https://github.com/someone-else/tobacco-web.git') | Out-Null
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*remote*') 'main worktree with the wrong remote => BLOCK'
    Invoke-TestGit $repo @('remote', 'set-url', 'origin', 'git@github.com:ozkkhallouf-ux/tobacco-web.git') | Out-Null
    $r = Invoke-MigrationPreflight $config
    Assert-True ($r.ok) 'the official remote over SSH is accepted'
    $saved = $config.mainWorktree.path
    $config.mainWorktree.path = $repo
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok) 'the operational repo itself cannot be the main worktree'
    $config.mainWorktree.path = $saved

    Write-Host '== the main worktree is not a back door'
    $script:Tasks = @{
        'OZK-PriceListSync' = ($ps + ' -File "' + $inMain + '"')
        'TOBACCO Ameen Sync' = ($ps + ' -File "' + ((Join-Path $mainWt 'tools') + $sep + 'other.ps1') + '"')
    }
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'TOBACCO Ameen Sync').reason -like '*outside its allow-list*') 'an operational task running from the main worktree => BLOCK'

    Write-Host '== invisible task fails closed'
    $script:Tasks = @{}
    $r = Invoke-MigrationPreflight $config
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*not visible*') 'task not visible to this account => BLOCK (run as administrator)'

    Write-Host '== retired price-list sync (the shipped config, as on OZK2026)'
    # tobacco-web-main HEAD منفصل ولا مهمة تستعمله؛ OZK-PriceListSync معطّلة على worktree آخر.
    $real = [System.IO.File]::ReadAllText($exampleConfig) | ConvertFrom-Json
    $real.repoPath = $repo
    $real.mainWorktree.path = $mainWt
    Invoke-TestGit $mainWt @('checkout', '-q', '--detach', 'main') | Out-Null
    $syncWt = (Join-Path $other 'tools') + $sep + 'auto-sync-price-lists.ps1'
    $opTask = $ps + ' -File "' + ((Join-Path $repo 'tools') + $sep + 'other.ps1') + '"'
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $syncWt + '"'); 'TOBACCO Ameen Sync' = $opTask }
    $script:States = @{ 'OZK-PriceListSync' = 'Disabled' }
    $r = Invoke-MigrationPreflight $real
    Assert-True ($r.ok -and (Get-Verdict $r 'OZK-PriceListSync').verdict -eq 'PASS') 'retired task Disabled on its own worktree, main worktree detached and unused => PASS'
    $script:States = @{ 'OZK-PriceListSync' = 'Ready' }
    $r = Invoke-MigrationPreflight $real
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*retired main task is enabled*') 'retired task re-enabled => BLOCK'
    $script:States = @{ 'OZK-PriceListSync' = 'Running' }
    $r = Invoke-MigrationPreflight $real
    Assert-True (-not $r.ok) 'retired task running => BLOCK'
    $script:Tasks = @{ 'TOBACCO Ameen Sync' = $opTask }
    $script:States = @{}
    $r = Invoke-MigrationPreflight $real
    Assert-True (-not $r.ok -and (Get-Verdict $r 'OZK-PriceListSync').reason -like '*retired task not visible*') 'retired task not visible => BLOCK (fail closed)'
    # إزالة الاعتماد لا تفتح باباً خلفياً: لا مهمة (ولا المتقاعدة نفسها) تعمل من worktree الـmain.
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $inMain + '"'); 'TOBACCO Ameen Sync' = $opTask }
    $script:States = @{ 'OZK-PriceListSync' = 'Disabled' }
    $r = Invoke-MigrationPreflight $real
    Assert-True (-not $r.ok -and @($r.results | Where-Object { $_.task -eq 'OZK-PriceListSync' -and $_.reason -like '*outside its allow-list*' }).Count -eq 1) 'retired task pointed at the main worktree => BLOCK (no back door)'
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $syncWt + '"'); 'TOBACCO Ameen Sync' = ($ps + ' -File "' + ((Join-Path $mainWt 'tools') + $sep + 'other.ps1') + '"') }
    $r = Invoke-MigrationPreflight $real
    Assert-True (-not $r.ok -and (Get-Verdict $r 'TOBACCO Ameen Sync').reason -like '*outside its allow-list*') 'operational task running from the main worktree => BLOCK'
    $script:Tasks = @{ 'OZK-PriceListSync' = ($ps + ' -File "' + $syncWt + '"'); 'TOBACCO Ameen Sync' = $opTask }
    $both = [System.IO.File]::ReadAllText($exampleConfig) | ConvertFrom-Json
    $both.repoPath = $repo
    $both.mainWorktree.path = $mainWt
    $both.mainDependentTasks = @($both.retiredMainTasks)
    $r = Invoke-MigrationPreflight $both
    Assert-True (-not $r.ok -and @($r.results | Where-Object { $_.reason -eq 'declared both main-dependent and retired' }).Count -eq 1) 'a task declared both main-dependent and retired => BLOCK'
    $script:States = @{}

    Write-Host '== price-list sync contract unchanged'
    $sync = [System.IO.File]::ReadAllText((Join-Path (Join-Path $repoRoot 'tools') 'auto-sync-price-lists.ps1'))
    Assert-True ($sync -match 'rev-parse --abbrev-ref HEAD' -and $sync -match '-ne "main"') 'auto-sync-price-lists.ps1 still refuses to run off main (guard not weakened)'
    Assert-True (@($real.mainDependentTasks | Where-Object { $null -ne $_ }).Count -eq 0) 'no task is declared main-dependent'
    Assert-True (@($real.retiredMainTasks).Count -eq 1 -and $real.retiredMainTasks[0].task -eq 'OZK-PriceListSync' -and $real.retiredMainTasks[0].script -eq 'tools/auto-sync-price-lists.ps1') 'only the price-list sync is retired'
    Assert-True (@($real.mainWorktree.allowedScripts).Count -eq 1 -and $real.mainWorktree.allowedScripts[0] -eq 'tools/auto-sync-price-lists.ps1') 'main worktree allow-list holds only the price-list sync'
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
} finally {
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    Write-Host ("Migration preflight: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Migration preflight: all checks passed' -ForegroundColor Green
exit 0
