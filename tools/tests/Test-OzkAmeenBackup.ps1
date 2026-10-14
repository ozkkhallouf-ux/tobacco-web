#Requires -Version 5.1
# ============================================================
# Test-OzkAmeenBackup.ps1
#
# يثبت سلوك tools\backup\ozk-ameen-backup.ps1 وtools\backup\register-ozk-ameen-backup-task.ps1
# بلا SQL حقيقي وبلا أي مساس بالجهاز: كل الملفات في مجلد مؤقت، واستدعاء SQL ونسخ
# الملفات واسم الجهاز والقرص الخارجي والمساحة والقفل وSlack وTask Scheduler كلها
# بدائل وهمية. لا يتصل بأي خادم ولا يقرأ .env ولا يرسل أي رسالة.
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
$registerPath = Join-Path (Join-Path $repoRoot 'tools') (Join-Path 'backup' 'register-ozk-ameen-backup-task.ps1')

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
        # محتوى قابل للضغط (تكرار) كي يثبت الاختبار أن الضغط يقلّص الحجم.
        $text = ('OZK-AMEEN-BACKUP-' + $Matches[1] + '-') * 4096
        [System.IO.File]::WriteAllText($path, $text)
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
$script:FreeBytes = @{}
$script:FreeSpaceReader = {
    param([string]$Path)
    foreach ($k in $script:FreeBytes.Keys) { if ($Path -like ($k + '*')) { return [int64]$script:FreeBytes[$k] } }
    return [int64](500GB)
}
$script:LockHeld = $false
$script:LockReleased = 0
$script:LockAcquirer = { if ($script:LockHeld) { return $null }; return 'mock-lock' }
$script:LockReleaser = { param($Lock) if ($Lock) { $script:LockReleased++ } }
$script:Secrets = @{}
$script:SecretReader = { param([string]$Name) return $script:Secrets[$Name] }
$script:SlackPosts = New-Object System.Collections.ArrayList
$script:SlackMode = 'ok'
$script:HttpPoster = {
    param([string]$Uri, [hashtable]$Headers, [string]$JsonBody)
    [void]$script:SlackPosts.Add([pscustomobject]@{ Uri = $Uri; Auth = $Headers['Authorization']; Body = $JsonBody })
    if ($script:SlackMode -eq 'http451') { throw 'The remote server returned an error: (451) Unavailable For Legal Reasons.' }
    if ($script:SlackMode -eq 'not_in_channel') { return [pscustomobject]@{ ok = $false; error = 'not_in_channel' } }
    return [pscustomobject]@{ ok = $true }
}

$notifyLog = Join-Path $base 'telegram-calls.txt'
$fakeNotify = Join-Path $base 'fake-notify.ps1'
# البديل الوهمي يحاكي عقد send-telegram-notification.ps1: يطبع «TELEGRAM-NOTIFY OK» عند الوصول.
[System.IO.File]::WriteAllText($fakeNotify, ('param([string]$Message,[string]$EventType,[string]$DedupeKey,[int]$DedupeMinutes) Add-Content -LiteralPath ''' + $notifyLog + ''' -Value $DedupeKey; Write-Host "TELEGRAM-NOTIFY OK ($EventType)"'))

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
$fixedNow = [datetime]'2026-10-14T23:00:00'
$stamp = '2026-10-14_230000'

try {
    Write-Host '== 1) DryRun هو الافتراضي ولا يكتب ولا يرسل شيئاً =='
    $t = New-TestRoots 'dry'
    $script:SqlLog.Clear(); $script:SlackPosts.Clear()
    $script:Secrets['SLACK_BOT_TOKEN'] = 'xoxb-test-not-real'
    $r = Invoke-OzkAmeenBackup -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    Assert-True ($r.status -eq 'dry-run') 'الحالة dry-run بلا -Execute'
    Assert-True ($script:SqlLog.Count -eq 0) 'صفر استدعاءات SQL في DryRun'
    Assert-True ($script:SlackPosts.Count -eq 0) 'صفر رسائل Slack في DryRun'
    Assert-True (-not (Test-Path -LiteralPath $notifyLog)) 'صفر رسائل Telegram في DryRun'
    Assert-True (-not (Test-Path -LiteralPath $t.Local)) 'لا مجلد محلي في DryRun'
    Assert-True (-not (Test-Path -LiteralPath $t.State)) 'لا status.json ولا سجل في DryRun'
    Assert-True ((Get-FileCount $t.External) -eq 0) 'لا ملفات على القرص الخارجي في DryRun'
    $script:Secrets.Clear()

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

    Write-Host '== 5) تنفيذ كامل: ضغط مُتحقَّق + نقل zip للخارجي + SHA256 =='
    $t = New-TestRoots 'full'
    $script:SqlLog.Clear()
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'ok') ('الحالة ok (الفعلية: ' + $r.status + ')')
    Assert-True (@($r.files).Count -eq 3) 'ثلاث قواعد منسوخة'
    $backups = @($script:SqlLog | Where-Object { $_ -like 'BACKUP*' })
    $verifies = @($script:SqlLog | Where-Object { $_ -like 'RESTORE VERIFYONLY*' })
    Assert-True ($backups.Count -eq 3 -and $verifies.Count -eq 3) 'نسخة وتحقق لكل قاعدة'
    $names = @($r.files | ForEach-Object { $_.database })
    Assert-True (($names -join ',') -eq 'AmnDb002,AmnDb001,AmnConfig') 'القواعد الثلاث بالترتيب'
    Assert-True ($r.zip -and $r.zip.zip -eq ('OZK-Ameen-' + $stamp + '.zip')) 'ملف zip باسم التشغيل'
    $rawBytes = 0; foreach ($f in $r.files) { $rawBytes += $f.bytes }
    Assert-True ($r.zip.bytes -lt $rawBytes) 'الضغط يقلّص الحجم'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zr = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $r.runDir $r.zip.zip))
    $entriesOk = $true
    try {
        foreach ($f in $r.files) {
            $e = $zr.GetEntry($f.file)
            if (-not $e) { $entriesOk = $false; continue }
            $s = $e.Open(); try { if ((Get-OzkStreamSha256 $s) -ne $f.sha256) { $entriesOk = $false } } finally { $s.Dispose() }
        }
    } finally { $zr.Dispose() }
    Assert-True $entriesOk 'كل مدخل في zip يطابق SHA256 الملف الأصلي'
    $extFiles = @(Get-ChildItem -LiteralPath $r.externalDir -File | ForEach-Object { $_.Name } | Sort-Object)
    $expectedExt = (@($r.zip.zip, 'manifest.json') | Sort-Object) -join ','
    Assert-True (($extFiles -join ',') -eq $expectedExt) 'الخارجي يستقبل zip وmanifest فقط'
    Assert-True ((Get-OzkSha256 (Join-Path $r.externalDir $r.zip.zip)) -eq $r.zip.sha256) 'SHA256 للـzip في الخارجي يطابق الأصل'
    $m = Get-Content -LiteralPath (Join-Path $r.runDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($m.zip.sha256 -eq $r.zip.sha256 -and @($m.files).Count -eq 3) 'manifest يحمل بصمات الملفات والـzip'
    Assert-True (Test-Path -LiteralPath (Join-Path $t.State 'status.json')) 'status.json مكتوب'
    Assert-True ($script:LockReleased -ge 1) 'القفل يُحرَّر بعد التشغيل'

    Write-Host '== 6) -NoCompress: نقل ملفات .bak مع SHA256 =='
    $t = New-TestRoots 'nocomp'
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -NoCompress -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    $allMatch = ($r.status -eq 'ok') -and (-not $r.zip)
    foreach ($f in $r.files) { if ((Get-OzkSha256 (Join-Path $r.externalDir $f.file)) -ne $f.sha256) { $allMatch = $false } }
    Assert-True $allMatch 'بلا ضغط: كل .bak في الخارجي يطابق SHA256'

    Write-Host '== 7) لا استبدال: وجهة خارجية موجودة تُرفض ولا يتغيّر محتواها =='
    $t = New-TestRoots 'noover'
    $existing = Join-Path (Join-Path (Join-Path (Join-Path $t.External 'OZK-Backups') '2026') $stamp) ('OZK-Ameen-' + $stamp + '.zip')
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $existing) | Out-Null
    [System.IO.File]::WriteAllText($existing, 'ORIGINAL')
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'failed' -and $r.external -eq 'failed') 'الحالة failed عند وجود الوجهة'
    Assert-True ([System.IO.File]::ReadAllText($existing) -eq 'ORIGINAL') 'الملف الموجود لم يُمسّ'
    $again = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($again.status -eq 'failed' -and ((@($again.errors) -join ' ') -match 'مجلد التشغيل موجود')) 'إعادة التشغيل بنفس الطابع الزمني ترفض مجلد التشغيل الموجود (failed لا استثناء صامت)'
    Assert-Throws { New-OzkVerifiedZip $existing @() $t.Local } 'إنشاء zip فوق ملف موجود مرفوض'

    Write-Host '== 8) اختلاف SHA256 بعد النقل = فشل =='
    $t = New-TestRoots 'sha'
    $script:FileCopier = {
        param([string]$Source, [string]$Destination)
        [System.IO.File]::Copy($Source, $Destination, $false)
        if ($Destination -like '*.zip') { [System.IO.File]::AppendAllText($Destination, 'x') }
    }
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'failed' -and $r.external -eq 'failed') 'تلف النقل يُكتشف ويُعلَن فشلاً'
    Assert-True ((@($r.errors) -join ' ') -match 'SHA256') 'الخطأ يذكر SHA256'
    $script:FileCopier = $script:RealCopier

    Write-Host '== 9) فشل VERIFYONLY = فشل محلي ولا ضغط ولا نقل =='
    $t = New-TestRoots 'verify'
    $script:FailVerifyFor = 'AmnDb001'
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    $script:FailVerifyFor = ''
    Assert-True ($r.status -eq 'failed' -and $r.local -eq 'failed') 'فشل التحقق يُفشل التشغيل'
    Assert-True (-not $r.zip) 'لا zip بعد فشل التحقق'
    Assert-True ($r.external -eq 'skipped' -and (Get-FileCount $t.External) -eq 0) 'لا شيء يُنقل للخارجي بعد فشل التحقق'

    Write-Host '== 10) القرص الخارجي غير موصول = local-only =='
    $t = New-TestRoots 'noext'
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -StateDir $t.State -Now $fixedNow
    Assert-True ($r.status -eq 'local-only' -and $r.external -eq 'missing') 'الحالة local-only بلا قرص خارجي'

    Write-Host '== 11) حارس المساحة المحلي: لا نسخ إطلاقاً =='
    $t = New-TestRoots 'lowlocal'
    $script:SqlLog.Clear()
    $script:FreeBytes[$t.Local] = 5GB
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    $script:FreeBytes.Clear()
    Assert-True ($r.status -eq 'failed' -and $r.local -eq 'failed') 'مساحة محلية أقل من الحد = فشل'
    Assert-True ($script:SqlLog.Count -eq 0) 'لا BACKUP عند نقص المساحة المحلية'
    Assert-True (-not (Test-Path -LiteralPath $t.Local)) 'لا مجلد تشغيل عند نقص المساحة'
    Assert-True ((@($r.errors) -join ' ') -match 'مساحة محلية') 'الخطأ يذكر المساحة المحلية'

    Write-Host '== 12) حارس المساحة الخارجي: لا كتابة على الخارجي =='
    $t = New-TestRoots 'lowext'
    $script:FreeBytes[$t.External] = 19GB
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -Now $fixedNow
    $script:FreeBytes.Clear()
    Assert-True ($r.status -eq 'failed' -and $r.external -eq 'failed' -and $r.local -eq 'ok') 'مساحة خارجية أقل من الحد = فشل الخارجي، والمحلي محفوظ'
    Assert-True ((Get-FileCount $t.External) -eq 0) 'لا ملفات على الخارجي عند نقص المساحة'

    Write-Host '== 13) منع التداخل: القفل مأخوذ = تخطٍّ بلا أي أثر =='
    $t = New-TestRoots 'locked'
    $script:SqlLog.Clear(); $script:SlackPosts.Clear()
    $script:LockHeld = $true
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    $script:LockHeld = $false
    Assert-True ($r.status -eq 'skipped-concurrent') 'الحالة skipped-concurrent'
    Assert-True ($script:SqlLog.Count -eq 0 -and -not (Test-Path -LiteralPath $t.Local) -and -not (Test-Path -LiteralPath $t.State)) 'لا SQL ولا ملفات ولا حالة عند التداخل'
    $mutexOk = $true
    try {
        $m1 = New-Object System.Threading.Mutex($false, ('Global\OZK-Test-' + [guid]::NewGuid().ToString('N')))
        $mutexOk = $m1.WaitOne(0); $m1.ReleaseMutex(); $m1.Dispose()
    } catch { $mutexOk = $false }
    Assert-True $mutexOk 'Mutex عام مُسمّى يعمل على هذا PowerShell'

    Write-Host '== 14) Slack: رسالة واحدة للقناة الصحيحة بلا كشف التوكن =='
    $t = New-TestRoots 'slack'
    $script:SlackPosts.Clear(); $script:SlackMode = 'ok'
    $script:Secrets['SLACK_BOT_TOKEN'] = 'xoxb-test-not-real'
    if (Test-Path -LiteralPath $notifyLog) { Remove-Item -LiteralPath $notifyLog -Force }
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    Assert-True ($r.notify -eq 'slack' -and $script:SlackPosts.Count -eq 1) 'رسالة Slack واحدة عند النجاح'
    $post = $script:SlackPosts[0]
    $bodyObj = $post.Body | ConvertFrom-Json
    Assert-True ($post.Uri -eq 'https://slack.com/api/chat.postMessage' -and $bodyObj.channel -eq 'C0C1X2E58MT') 'chat.postMessage إلى #تنبيهات-ozk'
    Assert-True ($bodyObj.text -match $stamp -and $bodyObj.text -match 'ok') 'نص الرسالة يحمل الطابع والحالة'
    Assert-True ($post.Body -notmatch 'xoxb') 'التوكن ليس في جسم الرسالة'
    $statusRaw = [System.IO.File]::ReadAllText((Join-Path $t.State 'status.json'))
    $logRaw = (Get-ChildItem -LiteralPath (Join-Path $t.State 'logs') -File | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join ''
    Assert-True ($statusRaw -notmatch 'xoxb' -and $logRaw -notmatch 'xoxb') 'التوكن ليس في status.json ولا في السجل'
    Assert-True (-not (Test-Path -LiteralPath $notifyLog)) 'لا Telegram حين ينجح Slack'

    Write-Host '== 15) Slack محجوب (451) أو البوت خارج القناة = Telegram بديلاً =='
    foreach ($mode in @('http451', 'not_in_channel')) {
        $t = New-TestRoots ('slack-' + $mode)
        $script:SlackMode = $mode
        if (Test-Path -LiteralPath $notifyLog) { Remove-Item -LiteralPath $notifyLog -Force }
        $script:FailVerifyFor = 'AmnConfig'
        $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
        $script:FailVerifyFor = ''
        $keys = @(); if (Test-Path -LiteralPath $notifyLog) { $keys = @(Get-Content -LiteralPath $notifyLog) }
        Assert-True ($r.status -eq 'failed' -and $r.notify -eq 'telegram' -and ($keys -contains 'ozk-ameen-backup-failed')) ('Slack ' + $mode + ' ⇒ تنبيه الفشل يصل Telegram')
    }
    $script:SlackMode = 'ok'

    Write-Host '== 16) بلا توكن Slack = Telegram مباشرة، وبلا أي قناة = none بلا انهيار =='
    $script:Secrets.Clear(); $script:SlackPosts.Clear()
    $t = New-TestRoots 'notoken'
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    Assert-True ($r.notify -eq 'telegram' -and $script:SlackPosts.Count -eq 0) 'بلا توكن: لا محاولة Slack، وTelegram يُستعمل'
    $t = New-TestRoots 'nochannel'
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -StateDir $t.State -Now $fixedNow
    Assert-True ($r.notify -eq 'none' -and $r.status -eq 'local-only') 'بلا قنوات تنبيه: النسخ يكتمل والحالة تُسجَّل'

    Write-Host '== 17) حارس الجهاز والسحابة =='
    $t = New-TestRoots 'host'
    $script:HostNameReader = { return 'MacBook-Air-Omar' }
    Assert-Throws { Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -StateDir $t.State -Now $fixedNow } 'التنفيذ على جهاز غير OZK2026 مرفوض'
    Assert-True (-not (Test-Path -LiteralPath $t.Local)) 'لا ملفات عند رفض الجهاز'
    $script:HostNameReader = { return 'OZK2026' }
    Assert-Throws { Invoke-OzkAmeenBackup -Cloud -LocalRoot $t.Local -StateDir $t.State } '-Cloud مرفوض في هذا الإصدار'

    Write-Host '== 17ب) لا فشل صامت: كل عطل غير متوقع = failed + تنبيه Telegram + خروج 1 =='
    $script:Secrets.Clear()
    function Get-TelegramKeys { if (Test-Path -LiteralPath $notifyLog) { return @(Get-Content -LiteralPath $notifyLog) } return @() }
    function Reset-Telegram { if (Test-Path -LiteralPath $notifyLog) { Remove-Item -LiteralPath $notifyLog -Force } }
    $realJsonWriter = $script:JsonWriter
    $realSpace = $script:FreeSpaceReader

    # (أ) فشل قارئ المساحة نفسه (استثناء، لا نقص مساحة)
    $t = New-TestRoots 'fault-space'
    Reset-Telegram; $script:SqlLog.Clear()
    $script:FreeSpaceReader = { param([string]$Path) throw 'mock: DriveInfo failed' }
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    $script:FreeSpaceReader = $realSpace
    Assert-True ($r.status -eq 'failed' -and ((@($r.errors) -join ' ') -match 'DriveInfo failed')) 'فشل فحص المساحة ⇒ failed مع الخطأ'
    Assert-True ($r.notify -eq 'telegram' -and ((Get-TelegramKeys) -contains 'ozk-ameen-backup-failed')) 'فشل فحص المساحة ⇒ تنبيه Telegram'
    Assert-True ($script:SqlLog.Count -eq 0) 'فشل فحص المساحة ⇒ لا BACKUP'
    Assert-True (Test-Path -LiteralPath (Join-Path $t.State 'status.json')) 'فشل فحص المساحة ⇒ status.json مكتوب'
    Assert-True ($script:LockReleased -ge 1) 'القفل يُحرَّر بعد العطل'

    # (ب) فشل كتابة manifest.json
    $t = New-TestRoots 'fault-manifest'
    Reset-Telegram
    $script:JsonWriter = { param([string]$Path, $Object) if ($Path -like '*manifest.json') { throw 'mock: disk full writing manifest' }; & $realJsonWriter $Path $Object }
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    $script:JsonWriter = $realJsonWriter
    Assert-True ($r.status -eq 'failed' -and ((@($r.errors) -join ' ') -match 'manifest')) 'فشل manifest.json ⇒ failed مع الخطأ'
    Assert-True ($r.notify -eq 'telegram' -and ((Get-TelegramKeys) -contains 'ozk-ameen-backup-failed')) 'فشل manifest.json ⇒ تنبيه Telegram'
    Assert-True ((Get-FileCount $t.External) -eq 0) 'فشل manifest.json ⇒ لا نقل للخارجي'

    # (ج) فشل كتابة status.json بعد نسخ ناجح
    $t = New-TestRoots 'fault-status'
    Reset-Telegram
    $script:JsonWriter = { param([string]$Path, $Object) if ($Path -like '*status.json') { throw 'mock: access denied status.json' }; & $realJsonWriter $Path $Object }
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $t.State -NotifyScript $fakeNotify -Now $fixedNow
    $script:JsonWriter = $realJsonWriter
    Assert-True ($r.status -eq 'failed' -and ((@($r.errors) -join ' ') -match 'status\.json')) 'فشل status.json ⇒ failed (المراقبة عمياء)'
    Assert-True ($r.notify -eq 'telegram' -and ((Get-TelegramKeys) -contains 'ozk-ameen-backup-failed')) 'فشل status.json ⇒ تنبيه Telegram رغم ذلك'
    Assert-True ($r.external -eq 'ok') 'فشل status.json لا يُلغي نسخة خارجية ناجحة'

    # (د) مجلد الحالة والسجل غير قابل للكتابة إطلاقاً (مسار ملف لا مجلد)
    $t = New-TestRoots 'fault-statedir'
    Reset-Telegram
    $blocker = Join-Path $base 'state-is-a-file'
    [System.IO.File]::WriteAllText($blocker, 'x')
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -ExternalRoot $t.External -StateDir $blocker -NotifyScript $fakeNotify -Now $fixedNow
    Assert-True ($r.status -eq 'failed' -and $r.notify -eq 'telegram' -and ((Get-TelegramKeys) -contains 'ozk-ameen-backup-failed')) 'السجل وstatus.json غير قابلين للكتابة ⇒ failed + Telegram'

    # (هـ) فشل التنبيه نفسه لا يكسر الإرجاع
    $t = New-TestRoots 'fault-alert'
    $badNotify = Join-Path $base 'bad-notify.ps1'
    [System.IO.File]::WriteAllText($badNotify, 'throw "mock: telegram down"')
    $script:FreeSpaceReader = { param([string]$Path) throw 'mock: DriveInfo failed' }
    $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -StateDir $t.State -NotifyScript $badNotify -Now $fixedNow
    $script:FreeSpaceReader = $realSpace
    Assert-True ($r.status -eq 'failed' -and $r.notify -eq 'none') 'فشل Telegram نفسه ⇒ النتيجة failed تُعاد بلا انهيار'

    # (و) Telegram لا يؤكّد (SKIPPED/FAILED بخروج 0) ⇒ لا يُسجَّل وصولاً كاذباً
    foreach ($kind in @('SKIPPED: authentication failed', 'FAILED: The remote name could not be resolved')) {
        $t = New-TestRoots ('tg-' + $kind.Substring(0, 6))
        $quiet = Join-Path $base ('quiet-notify-' + $kind.Substring(0, 6) + '.ps1')
        [System.IO.File]::WriteAllText($quiet, ('param([string]$Message,[string]$EventType,[string]$DedupeKey,[int]$DedupeMinutes) Write-Host "TELEGRAM-NOTIFY ' + $kind + '"; exit 0'))
        $script:FailVerifyFor = 'AmnDb002'
        $r = Invoke-OzkAmeenBackup -Execute -NoSlack -LocalRoot $t.Local -StateDir $t.State -NotifyScript $quiet -Now $fixedNow
        $script:FailVerifyFor = ''
        Assert-True ($r.status -eq 'failed' -and $r.notify -eq 'none') ('Telegram ' + $kind.Substring(0, 7) + ' بخروج 0 ⇒ notify=none لا telegram')
        $logRaw = (Get-ChildItem -LiteralPath (Join-Path $t.State 'logs') -File | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join ''
        Assert-True ($logRaw -match 'notify=none' -and $logRaw -notmatch 'notify=telegram') 'السجل لا يدّعي وصول التنبيه'
    }
    # (ز) Slack محجوب + Telegram لا يؤكّد ⇒ none
    $t = New-TestRoots 'tg-slack-both'
    $script:Secrets['SLACK_BOT_TOKEN'] = 'xoxb-test-not-real'; $script:SlackMode = 'http451'
    $r = Invoke-OzkAmeenBackup -Execute -LocalRoot $t.Local -StateDir $t.State -NotifyScript (Join-Path $base 'quiet-notify-SKIPPE.ps1') -Now $fixedNow
    $script:Secrets.Clear(); $script:SlackMode = 'ok'
    Assert-True ($r.notify -eq 'none') 'Slack 451 + Telegram SKIPPED ⇒ notify=none'

    Write-Host '== 17ج) رمز الخروج من نقطة الدخول =='
    $base17 = Join-Path $base 'main'
    $a = @{ Execute = $true; LocalRoot = (Join-Path $base17 'l1'); StateDir = (Join-Path $base17 's1'); NotifyScript = $fakeNotify; NoSlack = $true }
    $script:FreeSpaceReader = { param([string]$Path) throw 'mock: DriveInfo failed' }
    Reset-Telegram
    $code = Invoke-OzkBackupMain $a
    $script:FreeSpaceReader = $realSpace
    Assert-True ($code -eq 1 -and ((Get-TelegramKeys) -contains 'ozk-ameen-backup-failed')) 'عطل داخلي ⇒ خروج 1 مع تنبيه'
    $a = @{ Execute = $true; LocalRoot = (Join-Path $base17 'l2'); StateDir = (Join-Path $base17 's2'); NotifyScript = $fakeNotify; NoSlack = $true }
    $code = Invoke-OzkBackupMain $a
    Assert-True ($code -eq 2) 'نجاح محلي بلا خارجي ⇒ خروج 2'
    $script:LockHeld = $true
    $code = Invoke-OzkBackupMain @{ Execute = $true; LocalRoot = (Join-Path $base17 'l3'); StateDir = (Join-Path $base17 's3'); NoSlack = $true }
    $script:LockHeld = $false
    Assert-True ($code -eq 3) 'تداخل ⇒ خروج 3'
    Reset-Telegram
    $script:HostNameReader = { return 'MacBook-Air-Omar' }
    $code = Invoke-OzkBackupMain @{ Execute = $true; LocalRoot = (Join-Path $base17 'l4'); StateDir = (Join-Path $base17 's4'); NotifyScript = $fakeNotify; NoSlack = $true }
    $script:HostNameReader = { return 'OZK2026' }
    Assert-True ($code -eq 1 -and ((Get-TelegramKeys) -contains 'ozk-ameen-backup-precheck-failed')) 'رفض الجهاز مع -Execute ⇒ خروج 1 وتنبيه precheck'
    Reset-Telegram
    $code = Invoke-OzkBackupMain @{ Execute = $false; Databases = @('master'); NotifyScript = $fakeNotify; NoSlack = $true }
    Assert-True ($code -eq 1 -and (Get-TelegramKeys).Count -eq 0) 'خطأ إعداد في DryRun ⇒ خروج 1 بلا أي رسالة'
    $code = Invoke-OzkBackupMain @{ LocalRoot = (Join-Path $base17 'l5'); StateDir = (Join-Path $base17 's5') }
    Assert-True ($code -eq 0) 'DryRun ⇒ خروج 0'

    Write-Host '== 18) فحص ساكن: لا حذف ولا استبدال ولا كشف أسرار في السكربتين =='
    foreach ($p in @($scriptPath, $registerPath)) {
        $src = Get-Content -LiteralPath $p -Raw -Encoding UTF8
        $code = ($src -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
        $leaf = Split-Path -Leaf $p
        Assert-True ($code -notmatch '(?i)Remove-Item|\bdel\b|rmdir|\[System\.IO\.File\]::Delete|Directory\]::Delete|Unregister-ScheduledTask|Set-ScheduledTask|Disable-ScheduledTask') ($leaf + ': لا حذف ولا تعديل مهام موجودة')
        Assert-True ($code -notmatch '(?i)Copy-Item[^\r\n]*-Force|Move-Item') ($leaf + ': لا Copy-Item -Force ولا Move-Item')
        Assert-True ($code -notmatch '(?i)RESTORE\s+DATABASE') ($leaf + ': لا RESTORE DATABASE')
        Assert-True ($code -notmatch 'xox[bpa]-[A-Za-z0-9]') ($leaf + ': لا توكن Slack مكتوب')
        Assert-True ($code -notmatch '(?i)Write-(Host|Output|OzkLog)[^\r\n]*\$token') ($leaf + ': التوكن لا يُطبع')
    }
    $code = (Get-Content -LiteralPath $scriptPath -Raw -Encoding UTF8)
    Assert-True ($code -match '\[System\.IO\.File\]::Copy\(\$Source, \$Destination, \$false\)') 'النسخ الافتراضي يرفض الاستبدال (overwrite=false)'

    Write-Host '== 19) سكربت إعداد المهمة: DryRun افتراضي ولا تعديل لمهام موجودة =='
    . $registerPath
    $script:RegCalls = 0
    $script:TaskRegistrar = { param($Spec) $script:RegCalls++ }
    $script:ExistingTasks = @('OZK Ameen Full Backup')
    $script:TaskExists = { param([string]$Name) return ($script:ExistingTasks -contains $Name) }
    $script:PathExists = { param([string]$Path) return $false }
    $script:HostNameReader = { return 'OZK2026' }
    $rr = Invoke-OzkRegisterBackupTask
    Assert-True ($rr.status -eq 'dry-run' -and $script:RegCalls -eq 0) 'DryRun لا يسجّل شيئاً'
    $sp = $rr.spec
    Assert-True ($sp.TaskName -eq 'OZK Ameen Verified Backup' -and $sp.At -eq '23:00') 'المهمة الجديدة يومياً 23:00 باسم مستقل'
    Assert-True ($sp.UserId -eq 'OZK2026\LOQ' -and $sp.LogonType -eq 'S4U') 'باسم LOQ وبنوع S4U (لا Interactive)'
    Assert-True ($sp.MultipleInstances -eq 'IgnoreNew' -and $sp.TimeLimitHours -eq 2) 'تشغيل واحد في كل لحظة ومهلة ساعتين'
    Assert-True ($sp.Arguments -match 'ozk-ameen-backup\.ps1' -and $sp.Arguments -match '-Execute' -and $sp.Arguments -notmatch '-Cloud') 'الأمر يشغّل السكربت بـ-Execute وبلا -Cloud'
    Assert-True (-not $sp.UsesLauncher) 'بلا مشغّل البوابة حين لا يوجد'
    $script:PathExists = { param([string]$Path) return $true }
    $rr = Invoke-OzkRegisterBackupTask
    Assert-True ($rr.spec.UsesLauncher -and $rr.spec.Arguments -match 'run-repo-task\.ps1' -and $rr.spec.Arguments -match '-Script "tools/backup/ozk-ameen-backup\.ps1"') 'عبر run-repo-task.ps1 حين يوجد'
    Assert-Throws { Invoke-OzkRegisterBackupTask -Apply -TaskName 'OZK Ameen Full Backup' } 'رفض التسجيل فوق مهمة موجودة'
    Assert-True ($script:RegCalls -eq 0) 'لم تُسجَّل أي مهمة عند الرفض'
    $script:HostNameReader = { return 'MacBook-Air-Omar' }
    Assert-Throws { Invoke-OzkRegisterBackupTask -Apply } 'رفض التسجيل على جهاز غير OZK2026'
    $script:HostNameReader = { return 'OZK2026' }
    Assert-Throws { Invoke-OzkRegisterBackupTask -At '25:00' } 'وقت غير صالح مرفوض'
    $rr = Invoke-OzkRegisterBackupTask -Apply
    Assert-True ($rr.status -eq 'registered' -and $script:RegCalls -eq 1) 'التسجيل مع -Apply على OZK2026 يستدعي المسجّل مرة واحدة (بديل وهمي)'
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
