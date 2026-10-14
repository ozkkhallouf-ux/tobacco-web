#Requires -Version 5.1
# ============================================================
# Test-OzkAmeenBackup.ps1
#
# يثبت سلوك tools\backup\ozk-ameen-backup.ps1 بلا SQL حقيقي وبلا أي مساس بالجهاز:
# كل الملفات في مجلد مؤقت، واستدعاء SQL ونسخ الملفات واسم الجهاز والقرص الخارجي
# كلها بدائل وهمية. لا يتصل بأي خادم ولا يقرأ .env.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-OzkAmeenBackup.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'backup' 'ozk-ameen-backup.ps1')

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }
function Assert-Throws([scriptblock]$Block, [string]$Message) {
    $threw = $false
    try { & $Block | Out-Null } catch { $threw = $true }
    Assert-True $threw $Message
}

. $scriptPath

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-backup-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $base | Out-Null

# ---------- البدائل الوهمية ----------
$script:SqlLog = New-Object System.Collections.ArrayList
$script:FailVerifyFor = ''
$script:SqlInvoker = {
    param([string]$Query, [int]$TimeoutSeconds)
    [void]$script:SqlLog.Add($Query)
    if ($Query -match "^BACKUP DATABASE \[(\w+)\] TO DISK = N'([^']+)'") {
        $path = $Matches[2]
        if (Test-Path -LiteralPath $path) { throw 'mock: backup target exists' }
        $bytes = New-Object byte[] 4096
        (New-Object System.Random).NextBytes($bytes)
        [System.IO.File]::WriteAllBytes($path, $bytes)
        return
    }
    if ($Query -match "^RESTORE VERIFYONLY FROM DISK = N'([^']+)'") {
        if ($script:FailVerifyFor -and $Matches[1] -like ('*' + $script:FailVerifyFor + '*')) { throw 'mock: verify failed' }
        return
    }
    throw ('mock: unexpected SQL ' + $Query)
}
$script:HostNameReader = { return 'OZK2026' }
$script:ExternalRootFinder = { return '' }
$script:RealCopier = $script:FileCopier

function New-TestRoots([string]$Name) {
    $r = Join-Path $base $Name
    $o = [pscustomobject]@{
        Local    = Join-Path $r 'local'
        External = Join-Path $r 'external'
        State    = Join-Path $r 'state'
    }
    New-Item -ItemType Directory -Force -Path $o.External | Out-Null
    return $o
}
function Get-FileCount([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return 0 }
    return @(Get-ChildItem -LiteralPath $Dir -Recurse -File).Count
}
$fixedNow = [datetime]'2026-10-14T22:30:00'

try {
    Write-Host '== 1) DryRun هو الافتراضي ولا يكتب شيئاً =='
    $t = New-TestRoots 'dry'
    $script:SqlLog.Clear()
    $r = Invoke-OzkAmeenBackup -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'dry-run') 'الحالة dry-run بلا -Execute'
    Assert-True ($script:SqlLog.Count -eq 0) 'صفر استدعاءات SQL في DryRun'
    Assert-True (-not (Test-Path -LiteralPath $t.Local)) 'لا مجلد محلي في DryRun'
    Assert-True (-not (Test-Path -LiteralPath $t.State)) 'لا status.json ولا سجل في DryRun'
    Assert-True ((Get-FileCount $t.External) -eq 0) 'لا ملفات على القرص الخارجي في DryRun'

    Write-Host '== 2) القائمة الثابتة للقواعد =='
    Assert-Throws { Assert-OzkBackupDatabases @('AmnDb002_TEST') } 'AmnDb002_TEST مرفوضة'
    Assert-Throws { Assert-OzkBackupDatabases @('master') } 'master مرفوضة'
    Assert-Throws { Assert-OzkBackupDatabases @('amndb002') } 'المطابقة حساسة لحالة الأحرف'
    Assert-Throws { Invoke-OzkAmeenBackup -Databases @('AmnDb003') -LocalRoot $t.Local -StateDir $t.State } 'تشغيل بقاعدة خارج القائمة مرفوض'

    Write-Host '== 3) صيغة الأوامر: COPY_ONLY وCHECKSUM وNOINIT =='
    $b = New-OzkBackupStatement 'AmnDb002' 'C:\x\AmnDb002_s.bak' 's'
    Assert-True ($b -match '\bCOPY_ONLY\b') 'BACKUP يحمل COPY_ONLY'
    Assert-True ($b -match '\bCHECKSUM\b') 'BACKUP يحمل CHECKSUM'
    Assert-True ($b -match '\bNOINIT\b') 'BACKUP يحمل NOINIT'
    Assert-True ($b -notmatch '\bINIT\b' -and $b -notmatch '\bFORMAT\b') 'BACKUP بلا INIT ولا FORMAT'
    $v = New-OzkVerifyStatement 'C:\x\AmnDb002_s.bak'
    Assert-True ($v -match '^RESTORE VERIFYONLY FROM DISK' -and $v -match 'WITH CHECKSUM$') 'VERIFYONLY مع CHECKSUM'
    $q = New-OzkVerifyStatement "C:\x\it's.bak"
    Assert-True ($q -match "it''s") 'الفاصلة العليا في المسار مُهرَّبة'

    Write-Host '== 4) حارس SQL يرفض كل ما سوى النسخ والتحقق =='
    Assert-Throws { Assert-OzkSafeSql "RESTORE DATABASE [AmnDb002] FROM DISK = N'x' WITH REPLACE" } 'RESTORE DATABASE مرفوض'
    Assert-Throws { Assert-OzkSafeSql "BACKUP DATABASE [AmnDb002] TO DISK = N'x' WITH CHECKSUM, INIT" } 'BACKUP بلا COPY_ONLY مرفوض'
    Assert-Throws { Assert-OzkSafeSql "BACKUP DATABASE [AmnDb002] TO DISK = N'x' WITH COPY_ONLY, CHECKSUM, FORMAT" } 'FORMAT مرفوض'
    Assert-Throws { Assert-OzkSafeSql "BACKUP DATABASE [AmnDb002] TO DISK = N'x' WITH COPY_ONLY, CHECKSUM, INIT" } 'INIT مرفوض'
    Assert-Throws { Assert-OzkSafeSql "BACKUP DATABASE [master] TO DISK = N'x' WITH COPY_ONLY, CHECKSUM" } 'قاعدة خارج القائمة في BACKUP مرفوضة'
    Assert-Throws { Assert-OzkSafeSql "RESTORE VERIFYONLY FROM DISK = N'x'; DROP DATABASE [AmnDb002]" } 'الأوامر المركّبة مرفوضة'
    Assert-Throws { Assert-OzkSafeSql 'ALTER DATABASE [AmnDb002] SET RECOVERY FULL' } 'ALTER DATABASE مرفوض'
    $okBackup = $true
    try { Assert-OzkSafeSql $b; Assert-OzkSafeSql $v } catch { $okBackup = $false }
    Assert-True $okBackup 'الأمران المولَّدان يمرّان الحارس'

    Write-Host '== 5) تنفيذ كامل بالبدائل: محلي + خارجي + SHA256 =='
    $t = New-TestRoots 'full'
    $script:SqlLog.Clear()
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'ok') ('الحالة ok (الفعلية: ' + $r.status + ')')
    Assert-True (@($r.files).Count -eq 3) 'ثلاث قواعد منسوخة'
    $backups = @($script:SqlLog | Where-Object { $_ -like 'BACKUP*' })
    $verifies = @($script:SqlLog | Where-Object { $_ -like 'RESTORE VERIFYONLY*' })
    Assert-True ($backups.Count -eq 3 -and $verifies.Count -eq 3) 'نسخة وتحقق لكل قاعدة'
    $names = @($r.files | ForEach-Object { $_.database })
    Assert-True (($names -join ',') -eq 'AmnDb002,AmnDb001,AmnConfig') 'القواعد الثلاث بالترتيب'
    $manifestPath = Join-Path $r.runDir 'manifest.json'
    Assert-True (Test-Path -LiteralPath $manifestPath) 'manifest.json موجود'
    $m = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $allMatch = $true
    foreach ($f in $m.files) {
        if ((Get-OzkSha256 (Join-Path $r.runDir $f.file)) -ne $f.sha256) { $allMatch = $false }
        if ((Get-OzkSha256 (Join-Path $r.externalDir $f.file)) -ne $f.sha256) { $allMatch = $false }
    }
    Assert-True $allMatch 'SHA256 في المحلي والخارجي يطابق manifest'
    Assert-True (Test-Path -LiteralPath (Join-Path $t.State 'status.json')) 'status.json مكتوب'

    Write-Host '== 6) لا استبدال: وجهة خارجية موجودة تُرفض ولا يتغيّر محتواها =='
    $t = New-TestRoots 'noover'
    $existing = Join-Path (Join-Path (Join-Path (Join-Path $t.External 'OZK-Backups') '2026') '2026-10-14_223000') 'AmnDb002_2026-10-14_223000.bak'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $existing) | Out-Null
    [System.IO.File]::WriteAllText($existing, 'ORIGINAL')
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'failed' -and $r.external -eq 'failed') 'الحالة failed عند وجود الوجهة'
    Assert-True ([System.IO.File]::ReadAllText($existing) -eq 'ORIGINAL') 'الملف الموجود لم يُمسّ'
    $again = $null
    try { $again = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow } catch { $again = 'threw' }
    Assert-True ($again -eq 'threw') 'إعادة التشغيل بنفس الطابع الزمني ترفض مجلد التشغيل الموجود'

    Write-Host '== 7) اختلاف SHA256 بعد النقل = فشل =='
    $t = New-TestRoots 'sha'
    $script:FileCopier = {
        param([string]$Source, [string]$Destination)
        [System.IO.File]::Copy($Source, $Destination, $false)
        if ($Destination -like '*.bak') { [System.IO.File]::AppendAllText($Destination, 'x') }
    }
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'failed' -and $r.external -eq 'failed') 'تلف النقل يُكتشف ويُعلَن فشلاً'
    Assert-True ((@($r.errors) -join ' ') -match 'SHA256') 'الخطأ يذكر SHA256'
    $script:FileCopier = $script:RealCopier

    Write-Host '== 8) فشل VERIFYONLY = فشل محلي ولا نقل خارجي =='
    $t = New-TestRoots 'verify'
    $script:FailVerifyFor = 'AmnDb001'
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    $script:FailVerifyFor = ''
    Assert-True ($r.status -eq 'failed' -and $r.local -eq 'failed') 'فشل التحقق يُفشل التشغيل'
    Assert-True ($r.external -eq 'skipped' -and (Get-FileCount $t.External) -eq 0) 'لا شيء يُنقل للخارجي بعد فشل التحقق'

    Write-Host '== 9) القرص الخارجي غير موصول = local-only =='
    $t = New-TestRoots 'noext'
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'local-only' -and $r.external -eq 'missing') 'الحالة local-only بلا قرص خارجي'

    Write-Host '== 10) حارس الجهاز والسحابة =='
    $t = New-TestRoots 'host'
    $script:HostNameReader = { return 'MacBook-Air-Omar' }
    Assert-Throws { Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -StateDir $t.State -Now $fixedNow } 'التنفيذ على جهاز غير OZK2026 مرفوض'
    Assert-True (-not (Test-Path -LiteralPath $t.Local)) 'لا ملفات عند رفض الجهاز'
    $script:HostNameReader = { return 'OZK2026' }
    Assert-Throws { Invoke-OzkAmeenBackup -Cloud -LocalRoot $t.Local -StateDir $t.State } '-Cloud مرفوض في هذا الإصدار'

    Write-Host '== 11) فحص ساكن: لا حذف ولا استبدال في السكربت =='
    $src = Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8
    $code = ($src -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    Assert-True ($code -notmatch '(?i)Remove-Item|\bdel\b|rmdir|\[System\.IO\.File\]::Delete|Directory\]::Delete') 'لا أوامر حذف في كود السكربت'
    Assert-True ($code -notmatch '(?i)Copy-Item[^\r\n]*-Force|Move-Item') 'لا Copy-Item -Force ولا Move-Item'
    Assert-True ($code -match '\[System\.IO\.File\]::Copy\(\$Source, \$Destination, \$false\)') 'النسخ الافتراضي يرفض الاستبدال (overwrite=false)'
    Assert-True ($code -notmatch '(?i)RESTORE\s+DATABASE') 'لا RESTORE DATABASE في كود السكربت'
} finally {
    $script:FileCopier = $script:RealCopier
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("FAILED: {0} assertion(s)" -f $failures.Count) -ForegroundColor Red
    exit 1
}
Write-Host 'Test-OzkAmeenBackup: all assertions passed' -ForegroundColor Green
exit 0
