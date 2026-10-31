#Requires -Version 5.1
# ============================================================
# Test-LauncherLogAcl.ps1
#
# يثبت تصميم صلاحيات سجل المشغّل (tools/deploy-gate/set-launcher-log-acl.ps1، الدفعة د0):
#   1. البنية: قائمة محمية، SYSTEM/Administrators تحكم كامل، وحساب التشغيل بلا حذف ولا تغيير
#      صلاحيات ولا امتلاك ولا إنشاء مجلدات، وOWNER RIGHTS يلغي WRITE_DAC الضمني للمالك.
#   2. السلوك بحساب محلي مؤقت غير مدير (CI على Windows، بصلاحية مدير للعدّاء):
#      المشغّل الحقيقي run-repo-task.ps1 يكتب سجله الشهري وينشئ ملف الشهر التالي،
#      ويُرفض: حذف السجل، وإعادة تسميته، وتغيير صلاحياته، وإنشاء مجلد داخله، والكتابة على
#      gate-config.json وrun-repo-task.ps1 وwriter-allowlist.json وstate.json، وإنشاء ملف في
#      مجلد البوابة. الحساب يُحذف في النهاية.
# لا يمسّ أي مسار حقيقي على الجهاز: كل شيء في مجلد مؤقت.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-LauncherLogAcl.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$aclScript = Join-Path $repoRoot 'tools\deploy-gate\set-launcher-log-acl.ps1'
$launcherSrc = Join-Path $repoRoot 'tools\deploy-gate\run-repo-task.ps1'

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }

. $aclScript

$FSR = [System.Security.AccessControl.FileSystemRights]
function Test-HasAny($Rights, $Mask) { return ((([int]$Rights) -band ([int]$Mask)) -ne 0) }

$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-logacl-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$userName = 'ozklog' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$userCreated = $false

try {
    Write-Host '== ACL design (structure)'
    $writerSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
    $sec = New-LauncherLogDirectorySecurity @($writerSid)
    $rules = @($sec.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    Assert-True ($sec.AreAccessRulesProtected) 'the log dir ACL is protected (no inheritance from ProgramData)'
    Assert-True ($sec.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-544') 'owner is BUILTIN\Administrators'
    foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') {
        Assert-True (@($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.FileSystemRights -eq $FSR::FullControl }).Count -eq 1) ($sid + ' has full control')
    }
    $writerRules = @($rules | Where-Object { $_.IdentityReference.Value -eq $writerSid.Value })
    Assert-True ($writerRules.Count -eq 2) 'the task account has exactly two rules (dir, files)'
    Assert-True (@($writerRules | Where-Object { Test-HasAny $_.FileSystemRights $script:LogForbiddenRights }).Count -eq 0) 'no delete, no permission change, no take ownership, no subdirectory for the task account'
    Assert-True (@($writerRules | Where-Object { $_.AccessControlType -ne 'Allow' }).Count -eq 0) 'allow rules only'
    $dirRule = @($writerRules | Where-Object { $_.InheritanceFlags -eq 'None' })
    $fileRule = @($writerRules | Where-Object { $_.InheritanceFlags -eq 'ObjectInherit' -and $_.PropagationFlags -eq 'InheritOnly' })
    Assert-True ($dirRule.Count -eq 1 -and (Test-HasAny $dirRule[0].FileSystemRights $FSR::CreateFiles)) 'directory rule: create files in this folder only'
    Assert-True ($fileRule.Count -eq 1 -and (Test-HasAny $fileRule[0].FileSystemRights $FSR::AppendData) -and (Test-HasAny $fileRule[0].FileSystemRights $FSR::WriteData)) 'file rule: write and append, inherited by files only'
    $ownerRule = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-3-4' })
    Assert-True ($ownerRule.Count -eq 1 -and -not (Test-HasAny $ownerRule[0].FileSystemRights ($FSR::ChangePermissions -bor $FSR::TakeOwnership -bor $FSR::Delete))) 'OWNER RIGHTS removes the implicit WRITE_DAC of the file creator'

    $gateT = Join-Path $base 'gate'
    $threw = @()
    foreach ($bad in @($gateT, (Join-Path $gateT 'logs'), $base)) {
        try { [void](Assert-LogDirOutsideGate $bad $gateT); $threw += $false } catch { $threw += $true }
    }
    Assert-True (@($threw | Where-Object { -not $_ }).Count -eq 0) 'log dir equal to, inside, or above the gate dir is refused'
    Assert-True ((Invoke-LauncherLogAcl -Dir (Join-Path $base 'plan-only') -Gate $gateT -WriterNames @('S-1-5-32-545')) -eq 'PLAN' -and -not (Test-Path -LiteralPath (Join-Path $base 'plan-only'))) 'without -Apply nothing is created or changed'

    Write-Host '== Behaviour as a non-admin task account'
    if (-not $isAdmin) {
        if ($env:CI) { Add-Failure 'behaviour test needs an Administrator runner in CI' }
        else { Write-Host '  skip: not Administrator (the behaviour test runs in CI)' -ForegroundColor Yellow }
    } else {
        # مجلد بوابة مؤقت بصلاحيات مطابقة للجهاز: محمي، SYSTEM/Administrators تحكم كامل، وحساب التشغيل قراءة وتنفيذ.
        $logDir = Join-Path $base 'logs\run-repo-task'
        $resultDir = Join-Path $base 'result'
        New-Item -ItemType Directory -Force -Path $gateT, $resultDir, (Split-Path -Parent $logDir) | Out-Null
        foreach ($f in 'gate-config.json', 'writer-allowlist.json', 'state.json') { [System.IO.File]::WriteAllText((Join-Path $gateT $f), '{}') }
        Copy-Item -LiteralPath $launcherSrc -Destination (Join-Path $gateT 'run-repo-task.ps1')

        $chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
        $bytes = New-Object byte[] 28
        $rng.GetBytes($bytes)
        $plain = 'Aa1!' + (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] }))
        $secure = ConvertTo-SecureString $plain -AsPlainText -Force
        $plain = $null
        New-LocalUser -Name $userName -Password $secure -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description 'OZK launcher log ACL test (temporary)' | Out-Null
        $userCreated = $true
        Add-LocalGroupMember -Group (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1] -Member $userName -ErrorAction SilentlyContinue
        $userSid = (New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $userName)).Translate([System.Security.Principal.SecurityIdentifier])

        $gs = New-Object System.Security.AccessControl.DirectorySecurity
        $gs.SetAccessRuleProtection($true, $false)
        $both = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        foreach ($sid in 'S-1-5-18', 'S-1-5-32-544') { $gs.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), $FSR::FullControl, $both, 'None', 'Allow'))) }
        $gs.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $FSR::ReadAndExecute, $both, 'None', 'Allow')))
        Set-Acl -LiteralPath $gateT -AclObject $gs
        foreach ($f in @(Get-ChildItem -LiteralPath $gateT -File)) {
            $fs = Get-Acl -LiteralPath $f.FullName
            $fs.SetAccessRuleProtection($false, $false)
            foreach ($r in @($fs.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { [void]$fs.RemoveAccessRule($r) }
            Set-Acl -LiteralPath $f.FullName -AclObject $fs
        }
        $rs = Get-Acl -LiteralPath $resultDir
        $rs.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $FSR::Modify, $both, 'None', 'Allow')))
        Set-Acl -LiteralPath $resultDir -AclObject $rs

        Assert-True ((Invoke-LauncherLogAcl -Dir $logDir -Gate $gateT -WriterNames @($userSid.Value) -DoApply) -eq 'APPLIED') 'the provisioning script applies the ACL as Administrator'

        $probe = @'
param([string]$GateDir, [string]$LogDir, [string]$Out)
$ErrorActionPreference = 'Stop'
$results = New-Object System.Collections.ArrayList
function Try-Op([string]$Name, [scriptblock]$Op) {
    try { & $Op; [void]$results.Add($Name + '=OK') }
    catch [System.UnauthorizedAccessException] { [void]$results.Add($Name + '=DENIED') }
    catch { if ($_.Exception.ToString() -match 'denied|UnauthorizedAccess|PrivilegeNotHeld|not authorized|0x80070005') { [void]$results.Add($Name + '=DENIED') } else { [void]$results.Add($Name + '=ERR ' + $_.Exception.GetType().Name + ': ' + $_.Exception.Message) } }
}
. (Join-Path $GateDir 'run-repo-task.ps1')
$cfg = [pscustomobject]@{ gateDir = $GateDir; launcherLogDir = $LogDir }
$month = Get-LauncherLogPath $cfg
Try-Op 'launcher-log-create' { Write-LauncherLog $cfg 'probe line 1'; if (-not (Test-Path -LiteralPath $month)) { throw 'log not written' } }
Try-Op 'launcher-log-append' { Write-LauncherLog $cfg 'probe line 2'; if (@([System.IO.File]::ReadAllLines($month)).Count -lt 2) { throw 'line not appended' } }
$next = Get-LauncherLogPath $cfg ((Get-Date).AddMonths(1))
Try-Op 'launcher-log-next-month' { Write-LauncherLog $cfg 'probe next'; [System.IO.File]::AppendAllText($next, "next`r`n") }
Try-Op 'log-delete' { [System.IO.File]::Delete($month); if (Test-Path -LiteralPath $month) { throw 'still there' } }
Try-Op 'log-rename' { [System.IO.File]::Move($month, ($month + '.old')) }
Try-Op 'log-acl-change' { $a = Get-Acl -LiteralPath $month; $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow'))); Set-Acl -LiteralPath $month -AclObject $a }
Try-Op 'log-subdir-create' { [void][System.IO.Directory]::CreateDirectory((Join-Path $LogDir 'sub')) }
Try-Op 'gate-config-write' { [System.IO.File]::AppendAllText((Join-Path $GateDir 'gate-config.json'), ' ') }
Try-Op 'gate-launcher-write' { [System.IO.File]::AppendAllText((Join-Path $GateDir 'run-repo-task.ps1'), '#') }
Try-Op 'gate-allowlist-write' { [System.IO.File]::WriteAllText((Join-Path $GateDir 'writer-allowlist.json'), '{"files":{}}') }
Try-Op 'gate-state-write' { [System.IO.File]::WriteAllText((Join-Path $GateDir 'state.json'), '{}') }
Try-Op 'gate-new-file' { [System.IO.File]::WriteAllText((Join-Path $GateDir 'launcher.log'), 'x') }
Try-Op 'gate-acl-change' { $a = Get-Acl -LiteralPath $GateDir; $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow'))); Set-Acl -LiteralPath $GateDir -AclObject $a }
[System.IO.File]::WriteAllLines($Out, [string[]]$results)
'@
        $probePath = Join-Path $resultDir 'probe.ps1'
        [System.IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($true)))
        $outPath = Join-Path $resultDir 'probe-result.txt'
        $cred = New-Object System.Management.Automation.PSCredential(($env:COMPUTERNAME + '\' + $userName), $secure)
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $probePath + '" -GateDir "' + $gateT + '" -LogDir "' + $logDir + '" -Out "' + $outPath + '"'
        $proc = Start-Process -FilePath $psExe -ArgumentList $argLine -Credential $cred -WorkingDirectory $resultDir -WindowStyle Hidden -Wait -PassThru
        Assert-True (Test-Path -LiteralPath $outPath) ('the probe ran as the temporary non-admin account (exit ' + $proc.ExitCode + ')')
        $res = @{}
        if (Test-Path -LiteralPath $outPath) {
            foreach ($l in [System.IO.File]::ReadAllLines($outPath)) { $k, $v = $l -split '=', 2; $res[$k] = $v; Write-Host ('    ' + $l) }
        }
        foreach ($k in 'launcher-log-create', 'launcher-log-append', 'launcher-log-next-month') { Assert-True ($res[$k] -eq 'OK') ('task account can: ' + $k) }
        foreach ($k in 'log-delete', 'log-rename', 'log-acl-change', 'log-subdir-create', 'gate-config-write', 'gate-launcher-write', 'gate-allowlist-write', 'gate-state-write', 'gate-new-file', 'gate-acl-change') {
            Assert-True ($res[$k] -eq 'DENIED') ('task account is denied: ' + $k)
        }
        Assert-True (([System.IO.File]::ReadAllText((Join-Path $gateT 'gate-config.json'))) -eq '{}' -and -not (Test-Path -LiteralPath (Join-Path $gateT 'launcher.log'))) 'gate files are unchanged after the probe'
        $month = Get-ChildItem -LiteralPath $logDir -Filter 'launcher-*.log' | Sort-Object Name | Select-Object -First 1
        Assert-True ($null -ne $month -and ([System.IO.File]::ReadAllText($month.FullName)) -like '*probe line 2*') 'the monthly log kept its lines (not deleted or renamed)'
    }
} catch {
    Add-Failure ('unexpected error: ' + $_.Exception.Message)
} finally {
    if ($userCreated) {
        try { Remove-LocalUser -Name $userName } catch { Add-Failure ('could not remove the temporary account: ' + $_.Exception.Message) }
    }
    if (Test-Path -LiteralPath $base) {
        try { & takeown.exe /F $base /R /D Y 2>&1 | Out-Null } catch { Write-Verbose 'takeown failed' }
        try { & icacls.exe $base /reset /T /C /Q 2>&1 | Out-Null } catch { Write-Verbose 'icacls reset failed' }
        Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failures.Count -gt 0) {
    Write-Host ("Launcher log ACL: {0} failure(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Launcher log ACL: all checks passed' -ForegroundColor Green
exit 0
