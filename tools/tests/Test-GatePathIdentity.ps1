#Requires -Version 5.1
# ============================================================
# Test-GatePathIdentity.ps1
#
# Codex P1 (#285): قرار REPO/NOT_REPO يعتمد هوية المسار في نظام الملفات، لا نصّه. هذا الاختبار ينشئ
# fixtures حقيقية داخل مجلد مؤقت فقط (junctions، وsymlinks إن أمكن، واسم 8.3 إن كان مفعّلاً على الوحدة)
# ويشغّل المحلّل الحقيقي (CreateFileW + GetFinalPathNameByHandleW) عبر Resolve-TaskReach.
# لا يمسّ أي مسار إنتاجي، ويزيل كل الروابط ثم المجلد المؤقت في النهاية.
#
# يعمل على Windows فقط (CI: توافق Windows PowerShell 5.1). حالة لا تسمح بها البيئة (symlink بلا
# صلاحية، أو 8.3 معطّل) تُطبع SKIP صريحاً مع السبب، لا PASS. منطقها مغطّى نموذجياً في
# Test-GateIdentityPreflight.ps1.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-GatePathIdentity.ps1
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
$skips = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Add-Skip([string]$m) { [void]$skips.Add($m); Write-Host "  SKIP: $m" -ForegroundColor Yellow }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    Write-Host 'SKIP: Test-GatePathIdentity requires Windows (real junctions + GetFinalPathNameByHandleW); it runs in the Windows PowerShell 5.1 CI job.' -ForegroundColor Yellow
    exit 0
}

. $preflight
# fixtures المؤقتة ينشئها مستخدم الاختبار نفسه (مالكها): يُعدّ ضمن ثقة إدارة النظام هنا كي يقيس الاختبار هوية
# المسار وحدها. فحص ثقة الأغلفة يعمل مع ذلك بـGet-Acl الحقيقي على هذه الملفات والمجلدات فوقها.
$testUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Get-PreflightAdminMembers { return @($testUserSid) }
$base = Join-Path ([IO.Path]::GetTempPath()) ('ozk-fsid-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$links = New-Object System.Collections.ArrayList
function New-TestDir([string]$Path) { [void](New-Item -ItemType Directory -Force -Path $Path); return $Path }
function New-TestFile([string]$Path, [string]$Text) { [void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path)); [IO.File]::WriteAllText($Path, $Text); return $Path }
function New-TestJunction([string]$Link, [string]$Target) { [void](New-Item -ItemType Junction -Path $Link -Target $Target); [void]$links.Add($Link); return $Link }
function Act([string]$E, [string]$A = '', [string]$W = '') { return [pscustomobject]@{ execute = $E; arguments = $A; workingDirectory = $W } }
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

try {
    # fixtures: مستودع حقيقي باسم طويل (ليحمل اسماً 8.3)، ومجلد خارجي، وروابط.
    $repo = New-TestDir (Join-Path $base 'tobacco-web-repository-root')
    [void](New-TestFile (Join-Path $repo 'tools\job.ps1') 'Write-Output repo-job')
    [void](New-TestFile (Join-Path $repo 'tools\b.cmd') '@echo repo-b')
    [void](New-TestFile (Join-Path $repo 'scripts\serve.mjs') 'console.log(1)')
    $outside = New-TestDir (Join-Path $base 'outside')
    [void](New-TestFile (Join-Path $outside 'x.ps1') 'Get-Date')
    $repo2 = New-TestDir (Join-Path $base 'tobacco-web-repository-root2')
    [void](New-TestFile (Join-Path $repo2 'tools\job.ps1') 'Get-Date')
    $runner = New-TestJunction (Join-Path $base 'runner') $repo
    $hop2 = New-TestJunction (Join-Path $base 'hop2') $repo
    $hop1 = New-TestJunction (Join-Path $base 'hop1') $hop2
    $elsewhere = New-TestJunction (Join-Path $base 'elsewhere') $outside
    $gone = New-TestDir (Join-Path $base 'gone')
    $broken = New-TestJunction (Join-Path $base 'broken') $gone
    [IO.Directory]::Delete($gone)
    [void](New-TestFile (Join-Path $outside 'a.cmd') ('call "' + $runner + '\tools\b.cmd"'))

    $cfg = [IO.File]::ReadAllText($exampleConfig) | ConvertFrom-Json
    $cfg.repoPath = $repo
    $cfg.trust.repositoryRoots = @()
    function Reach($Action, $Config = $cfg) { return (Resolve-TaskReach $Config @($Action) 'OZK2026\OZKSync') }

    Write-Host '== Native resolver'
    $r = Resolve-PreflightFinalPath (Join-Path $runner 'tools\job.ps1')
    Assert-True ($r.status -eq 'OK' -and (ConvertTo-CanonicalTracePath $r.path) -eq (ConvertTo-CanonicalTracePath (Resolve-PreflightFinalPath (Join-Path $repo 'tools\job.ps1')).path)) 'junction path resolves to the same final path as the real repo file'
    $r = Resolve-PreflightFinalPath (Join-Path $runner 'tools\not-yet.ps1')
    Assert-True ($r.status -eq 'MISSING' -and (ConvertTo-CanonicalTracePath $r.path).EndsWith('tobacco-web-repository-root\tools\not-yet.ps1')) 'missing file under a junction => MISSING with the final ancestor path'
    Assert-True ((Resolve-PreflightFinalPath (Join-Path $broken 'x.ps1')).status -eq 'ERROR') 'broken junction => ERROR (not MISSING, not OK)'

    Write-Host '== Real junctions decide containment'
    Assert-True ((Reach (Act $ps ('-File "' + $runner + '\tools\job.ps1"'))).status -eq 'REPO') 'A: junction -> repo + powershell -File runner\tools\job.ps1 => REPO'
    Assert-True ((Reach (Act 'node.exe' ('"' + $runner + '\scripts\serve.mjs"'))).status -eq 'REPO') 'B: junction -> repo + node runner\scripts\serve.mjs => REPO'
    Assert-True ((Reach (Act 'node.exe' 'scripts\serve.mjs' $runner)).status -eq 'REPO') 'C: WorkingDirectory junction -> repo + relative scripts\serve.mjs => REPO'
    Assert-True ((Reach (Act 'cmd.exe' ('/c "' + $outside + '\a.cmd"'))).status -eq 'REPO') 'D: wrapper outside the repo -> target through a junction into the repo => REPO'
    $cfgJ = $cfg | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $cfgJ.repoPath = $runner
    Assert-True ((Reach (Act $ps ('-File "' + $repo + '\tools\job.ps1"')) $cfgJ).status -eq 'REPO') 'G: repository root configured through a junction is canonicalized (real path => REPO)'
    $x = Reach (Act $ps ('-File "' + $elsewhere + '\x.ps1"'))
    Assert-True ($x.status -eq 'NOT_REPO') ('H: junction to an unrelated directory (resolved) => NOT_REPO (got ' + $x.status + ')')
    Assert-True ((Reach (Act $ps ('-File "' + $broken + '\x.ps1"'))).status -eq 'UNKNOWN') 'I: broken junction / unresolved reparse target => UNKNOWN'
    Assert-True ((Reach (Act $ps ('-File "' + $outside + '\missing.ps1"'))).status -eq 'UNKNOWN') 'K: missing target relevant to classification => UNKNOWN'
    $x = Reach (Act $ps ('-File "' + $repo2 + '\tools\job.ps1"'))
    Assert-True ($x.status -eq 'NOT_REPO') ('L: prefix collision (repository-root2 vs repository-root) => NOT_REPO (got ' + $x.status + ')')
    Assert-True ((Reach (Act $ps ('-File "' + $runner.ToUpperInvariant() + '\TOOLS\JOB.PS1"'))).status -eq 'REPO') 'M: case variation of the same path => REPO'
    Assert-True ((Reach (Act $ps ('-File "' + $hop1 + '\tools\job.ps1"'))).status -eq 'REPO') 'N: nested junction chain (hop1 -> hop2 -> repo) => REPO'
    Write-Host '  note: J (access denied during resolution) cannot be created here without changing ACLs; it is covered by the model test in Test-GateIdentityPreflight.ps1'

    Write-Host '== Bare executable names through the real search order (controlled PATH, real ACLs)'
    # PATH مضبوط بمجلدات حقيقية (fixtures في TEMP) مع System32/Windows الحقيقيين؛ الحل والـACL حقيقيان، ولا شيء يُنفَّذ.
    $binA = New-TestDir (Join-Path $base 'binA')
    $binB = New-TestDir (Join-Path $base 'binB')
    [void](New-TestFile (Join-Path $binB 'node.exe') 'not executed')
    $winDir = $env:SystemRoot
    $script:TestSysPath = ($winDir + '\System32;' + $winDir + ';' + $winDir + '\System32\WindowsPowerShell\v1.0;' + $binA + ';' + $binB + ';')
    function Get-PreflightSystemPath { return $script:TestSysPath }
    function Get-PreflightUserPath([string]$Sid) { return '' }
    function BareReach([string]$Exe, [string]$ArgText) { return (Resolve-TaskReach $cfg @((Act $Exe $ArgText)) 'SYSTEM') }
    $x = BareReach 'node.exe' '-v'
    Assert-True ($x.status -eq 'UNKNOWN' -and $x.why -like 'node invocation without a static target*') ('bare node.exe resolves uniquely to the trusted ' + $binB + '\node.exe (got ' + $x.status + ': ' + $x.why + ')')
    $x = BareReach 'cmd.exe' '/c echo ok'
    Assert-True ($x.status -eq 'NOT_REPO') ('bare cmd.exe resolves to the real System32 cmd.exe and passes the real ACL trust check (got ' + $x.status + ': ' + $x.why + ')')
    $x = BareReach 'powershell.exe' ('-NoProfile -File "' + $outside + '\x.ps1"')
    Assert-True ($x.status -eq 'NOT_REPO') ('bare powershell.exe resolves through PATH to the real WindowsPowerShell\v1.0 (got ' + $x.status + ': ' + $x.why + ')')
    $x = BareReach 'wscript.exe' '//B'
    Assert-True ($x.status -eq 'UNKNOWN' -and $x.why -like '*without a script target*') ('bare wscript.exe resolves to the real System32 wscript.exe (got ' + $x.status + ': ' + $x.why + ')')
    $script:TestSysPath = ($winDir + '\System32;' + $winDir + ';tools\bin;' + $binB)
    Assert-True ((BareReach 'node.exe' '-v').why -like '*relative entry*') 'relative PATH entry => UNKNOWN'
    $script:TestSysPath = ($winDir + '\System32;' + $winDir + ';' + $binA)
    Assert-True ((BareReach 'node.exe' '-v').why -like '*not found on the provable search path*') 'bare node.exe not on the search path => UNKNOWN'

    Write-Host '== Symbolic links (need SeCreateSymbolicLinkPrivilege or Developer Mode)'
    $dirLink = Join-Path $base 'symdir'
    $fileLink = Join-Path $base 'symjob.ps1'
    $symOk = $true
    try { [void](New-Item -ItemType SymbolicLink -Path $dirLink -Target $repo); [void]$links.Add($dirLink) } catch { $symOk = $false; Add-Skip ('E: directory symlink not creatable in this environment: ' + $_.Exception.Message) }
    if ($symOk) { Assert-True ((Reach (Act $ps ('-File "' + $dirLink + '\tools\job.ps1"'))).status -eq 'REPO') 'E: directory symlink -> repo => REPO' }
    $symOk = $true
    try { [void](New-Item -ItemType SymbolicLink -Path $fileLink -Target (Join-Path $repo 'tools\job.ps1')); [void]$links.Add($fileLink) } catch { $symOk = $false; Add-Skip ('E: file symlink not creatable in this environment: ' + $_.Exception.Message) }
    if ($symOk) { Assert-True ((Reach (Act $ps ('-File "' + $fileLink + '"'))).status -eq 'REPO') 'E: file symlink -> repo script => REPO' }

    Write-Host '== 8.3 short-name alias'
    $short = ''
    try { $short = [string](New-Object -ComObject Scripting.FileSystemObject).GetFolder($repo).ShortPath } catch { $short = '' }
    if (-not $short -or (Split-Path -Leaf $short) -ieq (Split-Path -Leaf $repo)) { Add-Skip ('F: 8.3 short names are not available for ' + $repo + ' on this volume (ShortPath=' + $short + ')') }
    else { Assert-True ((Reach (Act $ps ('-File "' + $short + '\tools\job.ps1"'))).status -eq 'REPO') ('F: 8.3 short-name alias ' + $short + ' => REPO') }
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
} finally {
    # الروابط أولاً (rmdir يزيل junction/symlink المجلد دون لمس الهدف)، ثم المجلد المؤقت.
    for ($i = $links.Count - 1; $i -ge 0; $i--) {
        $l = [string]$links[$i]
        try { if ((Get-Item -LiteralPath $l -Force -ErrorAction Stop).PSIsContainer) { [IO.Directory]::Delete($l) } else { [IO.File]::Delete($l) } } catch { Write-Verbose ('link cleanup: ' + $l) }
    }
    try { if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force } } catch { Write-Host ('  cleanup warning: ' + $_.Exception.Message) }
}

foreach ($s in $skips) { Write-Host ('SKIPPED (environment): ' + $s) -ForegroundColor Yellow }
if ($failures.Count -gt 0) {
    Write-Host ("Gate path identity: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host ('Gate path identity: all checks passed (' + $skips.Count + ' environment skip(s))') -ForegroundColor Green
exit 0
