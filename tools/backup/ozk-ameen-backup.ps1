#Requires -Version 5.1
# ============================================================
# ozk-ameen-backup.ps1 — نسخة احتياطية مُتحقَّقة لقواعد الأمين على OZK2026
#
# يحلّ محل tools\ozk-backup-external.ps1 الذي عاش خارج Git وضاع في
# 2026-09-01 (سحبه `git stash -u` من مجلد العمل)، فتوقفت النسخ الخارجية
# والسحابية منذ 2026-08-31. هذا الإصدار محفوظ في Git عمداً.
#
# الوضع الافتراضي DryRun: يطبع الخطة فقط، بلا أي اتصال SQL وبلا أي ملف وبلا
# أي رسالة. التنفيذ الفعلي يحتاج -Execute صراحةً، وعلى الجهاز OZK2026 وحده.
#
# ما يفعله عند -Execute:
#   0) قفل Mutex عام: تشغيل ثانٍ متزامن يُتخطّى ولا يلمس شيئاً.
#   1) حارس مساحة على القرص المحلي قبل أي نسخ.
#   2) BACKUP DATABASE ... WITH COPY_ONLY, CHECKSUM, NOINIT لكل قاعدة من
#      القائمة الثابتة (AmnDb002, AmnDb001, AmnConfig) إلى ملف جديد بمجلد
#      جديد. COPY_ONLY لا يغيّر تسلسل نسخ الأمين اليدوية.
#   3) RESTORE VERIFYONLY ... WITH CHECKSUM لكل ملف.
#   4) ضغط الملفات في zip واحد جديد، ثم إعادة فتحه وحساب SHA256 لكل مدخل
#      ومطابقته مع SHA256 الملف الأصلي (أقوى من CRC).
#   5) حارس مساحة على القرص الخارجي، ثم نسخ الـzip وmanifest.json إليه وإعادة
#      حساب SHA256 في الوجهة.
#   6) status.json + سجل شهري + تنبيه Slack (#تنبيهات-ozk)، وTelegram بديلاً
#      إن تعذّر Slack.
#
# ما لا يفعله إطلاقاً:
#   - لا يحذف ولا يستبدل أي ملف نسخ (لا Remove-Item، والنسخ يرفض وجهة موجودة).
#   - لا RESTORE DATABASE، ولا REPLACE، ولا أي تعديل على القواعد أو إعدادات SQL.
#   - لا رفع للسحابة (-Cloud مرفوض في هذا الإصدار).
#   - لا يلمس المهام المجدولة (راجع register-ozk-ameen-backup-task.ps1).
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\ozk-ameen-backup.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\ozk-ameen-backup.ps1 -Execute
#
# رموز الخروج: 0 نجاح كامل (أو DryRun) · 1 فشل · 2 نجاح محلي والقرص الخارجي
# غير موصول · 3 تُخطّي لأن تشغيلاً آخر جارٍ.
# ============================================================
[CmdletBinding()]
param(
    [switch]$Execute,
    [string[]]$Databases = @('AmnDb002', 'AmnDb001', 'AmnConfig'),
    [string]$Instance = '.\SQLEXPRESS',
    [string]$LocalRoot = 'C:\AmeenBackup\OZK',
    [string]$ExternalRoot = '',
    [string]$StateDir = 'C:\ProgramData\OZK-TOBACCO\Backup',
    [string]$ExpectedHost = 'OZK2026',
    [string]$NotifyScript = '',
    [int]$LocalMinFreeGB = 20,
    [int]$ExternalMinFreeGB = 20,
    [switch]$NoCompress,
    [string]$SlackChannel = 'C0C1X2E58MT',
    [string]$SlackTokenEnvVar = 'SLACK_BOT_TOKEN',
    [switch]$NoSlack,
    [switch]$Cloud
)

$ErrorActionPreference = 'Stop'

# القائمة الثابتة الوحيدة المسموح بها. أي اسم آخر (حتى AmnDb002_TEST) مرفوض.
$script:AllowedDatabases = @('AmnDb002', 'AmnDb001', 'AmnConfig')
# ملف على جذر القرص الخارجي يميّزه. حرف القرص يتغيّر، العلامة لا.
$script:ExternalMarker = 'OZK-BACKUP-DRIVE.marker'
$script:ExternalFolder = 'OZK-Backups'
$script:LockName = 'Global\OZK-Ameen-Verified-Backup'

# ---------- نقاط حقن للاختبارات ----------

# ينفّذ أمر SQL على master بمصادقة Windows (لا كلمات مرور ولا .env).
$script:SqlInvoker = {
    param([string]$Query, [int]$TimeoutSeconds)
    $cn = New-Object System.Data.SqlClient.SqlConnection ("Server={0};Database=master;Integrated Security=True;TrustServerCertificate=True" -f $script:InstanceName)
    $cn.Open()
    try {
        $cmd = $cn.CreateCommand()
        $cmd.CommandText = $Query
        $cmd.CommandTimeout = $TimeoutSeconds
        [void]$cmd.ExecuteNonQuery()
    } finally {
        $cn.Close()
    }
}

# ينسخ ملفاً دون استبدال: يرمي إن كانت الوجهة موجودة.
$script:FileCopier = {
    param([string]$Source, [string]$Destination)
    [System.IO.File]::Copy($Source, $Destination, $false)
}

# يقرأ اسم الجهاز.
$script:HostNameReader = { return $env:COMPUTERNAME }

# يبحث عن جذر القرص الخارجي بالعلامة.
$script:ExternalRootFinder = {
    foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
        try {
            if (-not $drive.IsReady) { continue }
            if ($drive.Name -like 'C:*') { continue }
            if (Test-Path -LiteralPath (Join-OzkPath $drive.RootDirectory.FullName $script:ExternalMarker) -PathType Leaf) {
                return $drive.RootDirectory.FullName
            }
        } catch {
            Write-Verbose ("drive skipped: " + $drive.Name)
        }
    }
    return ''
}

# المساحة الحرة بالبايت للقرص الذي يحمل المسار (حتى لو لم يُنشأ المسار بعد).
$script:FreeSpaceReader = {
    param([string]$Path)
    $root = [System.IO.Path]::GetPathRoot($Path)
    return [int64](New-Object System.IO.DriveInfo($root)).AvailableFreeSpace
}

# يحاول أخذ القفل العام. يعيد كائن القفل أو $null إن كان مأخوذاً.
$script:LockAcquirer = {
    $m = New-Object System.Threading.Mutex($false, $script:LockName)
    $got = $false
    try { $got = $m.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $got = $true }
    if (-not $got) { $m.Dispose(); return $null }
    return $m
}
$script:LockReleaser = {
    param($Lock)
    if ($Lock) { try { $Lock.ReleaseMutex() } finally { $Lock.Dispose() } }
}

# يرسل طلب POST بجسم JSON ويعيد الرد ككائن. لا يطبع الترويسات أبداً.
$script:HttpPoster = {
    param([string]$Uri, [hashtable]$Headers, [string]$JsonBody)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
    return Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 20
}

# يقرأ توكن Slack من متغيّر بيئة (العملية ثم المستخدم). لا يُطبع ولا يُكتب.
$script:SecretReader = {
    param([string]$Name)
    $v = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, 'User') }
    return $v
}

# يكتب JSON إلى ملف (manifest.json وstatus.json).
$script:JsonWriter = {
    param([string]$Path, $Object)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = $Object | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------- دوال صرفة ----------

# Join-Path يتحقق من وجود حرف القرص؛ Combine لا، فيعمل DryRun على أي جهاز.
function Join-OzkPath([string]$Parent, [string]$Child) {
    return [System.IO.Path]::Combine($Parent, $Child)
}

function Assert-OzkBackupDatabases([string[]]$Names) {
    if (-not $Names -or $Names.Count -eq 0) { throw 'لا توجد قواعد محددة للنسخ.' }
    foreach ($n in $Names) {
        if ($script:AllowedDatabases -cnotcontains $n) {
            throw ("قاعدة غير مسموح بها: '{0}'. المسموح فقط: {1}" -f $n, ($script:AllowedDatabases -join ', '))
        }
    }
}

function ConvertTo-OzkSqlLiteral([string]$Value) {
    return $Value.Replace("'", "''")
}

function New-OzkBackupStatement([string]$Database, [string]$File, [string]$Stamp) {
    Assert-OzkBackupDatabases @($Database)
    return ("BACKUP DATABASE [{0}] TO DISK = N'{1}' WITH COPY_ONLY, CHECKSUM, NOINIT, NAME = N'OZK {0} {2}'" -f $Database, (ConvertTo-OzkSqlLiteral $File), (ConvertTo-OzkSqlLiteral $Stamp))
}

function New-OzkVerifyStatement([string]$File) {
    return ("RESTORE VERIFYONLY FROM DISK = N'{0}' WITH CHECKSUM" -f (ConvertTo-OzkSqlLiteral $File))
}

# حارس أخير قبل أي اتصال SQL: لا يمرّ إلا BACKUP DATABASE ... COPY_ONLY وRESTORE VERIFYONLY.
function Assert-OzkSafeSql([string]$Query) {
    $q = $Query.Trim()
    $isBackup = $q -match '^BACKUP\s+DATABASE\s+\[(AmnDb002|AmnDb001|AmnConfig)\]\s+TO\s+DISK\s*=' -and $q -match '\bCOPY_ONLY\b' -and $q -match '\bCHECKSUM\b'
    $isVerify = $q -match '^RESTORE\s+VERIFYONLY\s+FROM\s+DISK\s*='
    if (-not ($isBackup -or $isVerify)) { throw ('أمر SQL غير مسموح: ' + $q) }
    # \bINIT\b لا يطابق NOINIT (لا حدّ كلمة داخلها)، فـNOINIT يمرّ وINIT/FORMAT يُرفضان.
    if ($q -match '\b(REPLACE|INIT|FORMAT|DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|TRUNCATE|EXEC|EXECUTE|SHUTDOWN|RECONFIGURE)\b') {
        throw ('أمر SQL يحوي كلمة ممنوعة: ' + $q)
    }
    if ($q -match ';') { throw ('أمر SQL مركّب غير مسموح: ' + $q) }
}

function Invoke-OzkSql([string]$Query, [int]$TimeoutSeconds = 3600) {
    Assert-OzkSafeSql $Query
    & $script:SqlInvoker $Query $TimeoutSeconds
}

function Get-OzkSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-OzkStreamSha256([System.IO.Stream]$Stream) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Stream)
    } finally {
        $sha.Dispose()
    }
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
}

function New-OzkRunLayout([string]$LocalRoot, [datetime]$Now) {
    $stamp = $Now.ToString('yyyy-MM-dd_HHmmss')
    $runDir = Join-OzkPath (Join-OzkPath $LocalRoot $Now.ToString('yyyy')) $stamp
    return [pscustomobject]@{ Stamp = $stamp; RunDir = $runDir; ZipName = ('OZK-Ameen-' + $stamp + '.zip') }
}

# هل المساحة الحرة على قرص المسار تكفي؟ تعيد كائناً يشرح القرار.
function Test-OzkFreeSpace([string]$Path, [int]$MinFreeGB, [int64]$NeededBytes = 0) {
    $free = [int64](& $script:FreeSpaceReader $Path)
    $required = [int64]$MinFreeGB * 1GB + $NeededBytes
    return [pscustomobject]@{
        Path      = $Path
        FreeBytes = $free
        Required  = $required
        FreeGB    = [math]::Round($free / 1GB, 1)
        Ok        = ($free -ge $required)
    }
}

# يضغط الملفات في zip جديد ثم يعيد فتحه ويطابق SHA256 كل مدخل مع الأصل.
function New-OzkVerifiedZip([string]$ZipPath, $Files, [string]$SourceDir) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $ZipPath) { throw ('ملف الضغط موجود مسبقاً، لن يُستبدل: ' + $ZipPath) }
    $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($f in $Files) {
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-OzkPath $SourceDir $f.file), $f.file, [System.IO.Compression.CompressionLevel]::Optimal)
        }
    } finally {
        $zip.Dispose()
    }
    $mismatch = New-Object System.Collections.ArrayList
    $read = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        foreach ($f in $Files) {
            $entry = $read.GetEntry($f.file)
            if (-not $entry) { [void]$mismatch.Add($f.file); continue }
            $s = $entry.Open()
            try { $h = Get-OzkStreamSha256 $s } finally { $s.Dispose() }
            if ($h -ne $f.sha256) { [void]$mismatch.Add($f.file) }
        }
    } finally {
        $read.Dispose()
    }
    if ($mismatch.Count -gt 0) { throw ('محتوى الضغط لا يطابق الأصل: ' + ($mismatch -join ', ')) }
    return [pscustomobject]@{ zip = (Split-Path -Leaf $ZipPath); bytes = (Get-Item -LiteralPath $ZipPath).Length; sha256 = (Get-OzkSha256 $ZipPath) }
}

function Write-OzkLog([string]$StateDir, [string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if (-not $StateDir) { return }
    # best-effort: فشل كتابة السجل لا يوقف النسخ ولا يكتم التنبيه.
    try {
        $logDir = Join-OzkPath $StateDir 'logs'
        if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        Add-Content -LiteralPath (Join-OzkPath $logDir ('backup-' + (Get-Date -Format 'yyyy-MM') + '.log')) -Value $line -Encoding UTF8
    } catch {
        Write-Host ('LOG WRITE FAIL: ' + $_.Exception.Message)
    }
}

function Write-OzkJson([string]$Path, $Object) {
    & $script:JsonWriter $Path $Object
}

# ---------- التنبيهات ----------

function Format-OzkAlert($Result) {
    $icon = switch ($Result.status) {
        'ok' { '✅' }
        'local-only' { '⚠️' }
        'skipped-concurrent' { 'ℹ️' }
        default { '🚨' }
    }
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add(('{0} نسخ الأمين الاحتياطي {1}: {2}' -f $icon, $Result.stamp, $Result.status))
    if ($Result.zip) { [void]$lines.Add(('الملف: {0} ({1} MB) · SHA256 {2}' -f $Result.zip.zip, [math]::Round($Result.zip.bytes / 1MB, 1), $Result.zip.sha256.Substring(0, 12))) }
    [void]$lines.Add(('محلي: {0} · خارجي: {1}' -f $Result.local, $Result.external))
    if ($Result.space) {
        foreach ($s in $Result.space) { [void]$lines.Add(('مساحة {0}: {1} GB متاحة' -f $s.Path, $s.FreeGB)) }
    }
    foreach ($e in @($Result.errors)) { [void]$lines.Add(('خطأ: ' + $e)) }
    return ($lines -join "`n")
}

# Slack أولاً، وTelegram بديلاً. يعيد اسم القناة التي وصلت أو 'none'.
function Send-OzkAlert([string]$Text, [string]$Key, [int]$DedupeMinutes, [string]$SlackChannel, [string]$SlackTokenEnvVar, [switch]$NoSlack, [string]$NotifyScript) {
    if (-not $NoSlack) {
        $token = & $script:SecretReader $SlackTokenEnvVar
        if ($token) {
            try {
                $body = @{ channel = $SlackChannel; text = $Text; unfurl_links = $false } | ConvertTo-Json -Compress
                $r = & $script:HttpPoster 'https://slack.com/api/chat.postMessage' @{ Authorization = ('Bearer ' + $token) } $body
                if ($r -and $r.ok) { return 'slack' }
                Write-Verbose ('slack rejected: ' + $(if ($r) { $r.error } else { 'no response' }))
            } catch {
                # مثلاً HTTP 451 من سوريا. لا يُطبع التوكن ولا الترويسات.
                Write-Verbose ('slack failed: ' + $_.Exception.Message)
            }
        }
    }
    if ($NotifyScript -and (Test-Path -LiteralPath $NotifyScript)) {
        try {
            & $NotifyScript -Message $Text -EventType 'windows' -DedupeKey $Key -DedupeMinutes $DedupeMinutes | Out-Null
            return 'telegram'
        } catch {
            Write-Verbose 'telegram failed (best-effort)'
        }
    }
    return 'none'
}

# ---------- النسخ إلى الخارجي ----------

# ينسخ الملفات المحددة إلى وجهة جديدة ثم يقارن SHA256 لكل ملف.
function Copy-OzkRunVerified([string]$RunDir, [string]$DestinationDir, $Files) {
    if (Test-Path -LiteralPath $DestinationDir) {
        throw ('الوجهة موجودة مسبقاً، لن يُستبدل شيء: ' + $DestinationDir)
    }
    New-Item -ItemType Directory -Force -Path $DestinationDir | Out-Null
    $mismatch = New-Object System.Collections.ArrayList
    foreach ($f in $Files) {
        $src = Join-OzkPath $RunDir $f.file
        $dst = Join-OzkPath $DestinationDir $f.file
        & $script:FileCopier $src $dst
        $h = Get-OzkSha256 $dst
        if ($h -ne $f.sha256) { [void]$mismatch.Add($f.file) }
    }
    $manifestSrc = Join-OzkPath $RunDir 'manifest.json'
    & $script:FileCopier $manifestSrc (Join-OzkPath $DestinationDir 'manifest.json')
    if ($mismatch.Count -gt 0) {
        throw ('SHA256 لا يطابق الأصل بعد النقل: ' + ($mismatch -join ', '))
    }
}

# ---------- الإنهاء: الحالة والتنبيه دائماً ----------

# يُنهي التشغيل: يحسب الحالة، ويكتب status.json، ويرسل التنبيه، ويسجّل.
# كل خطوة best-effort مستقلة: فشل كتابة status.json لا يمنع التنبيه، وفشل
# التنبيه لا يمنع السجل، ولا شيء هنا يرمي استثناءً.
function Complete-OzkRun($Result, $Errors, [bool]$ForceFailed, [string]$StateDir, [string]$SlackChannel, [string]$SlackTokenEnvVar, [bool]$NoSlack, [string]$NotifyScript) {
    if ($ForceFailed -or $Result.local -ne 'ok' -or $Result.external -eq 'failed') {
        $Result.status = 'failed'
        if ($Result.local -eq 'pending') { $Result.local = 'failed' }
        if ($Result.external -eq 'pending') { $Result.external = 'skipped' }
    } elseif ($Result.external -eq 'missing') {
        $Result.status = 'local-only'
    } else {
        $Result.status = 'ok'
    }
    $Result.finishedAt = (Get-Date).ToString('o')
    $Result.errors = @($Errors)

    try {
        Write-OzkJson (Join-OzkPath $StateDir 'status.json') $Result
    } catch {
        [void]$Errors.Add('status.json: ' + $_.Exception.Message)
        $Result.errors = @($Errors)
        $Result.status = 'failed'
        Write-Host ('STATUS WRITE FAIL: ' + $_.Exception.Message)
    }

    $text = $null
    try {
        $text = Format-OzkAlert ([pscustomobject]$Result)
    } catch {
        $text = ('🚨 نسخ الأمين الاحتياطي {0}: {1} — {2}' -f $Result.stamp, $Result.status, (@($Errors) -join ' | '))
    }
    $key = 'ozk-ameen-backup-' + $Result.status
    $minutes = $(if ($Result.status -eq 'ok') { 600 } elseif ($Result.status -eq 'local-only') { 1440 } else { 180 })
    try {
        $Result.notify = Send-OzkAlert $text $key $minutes $SlackChannel $SlackTokenEnvVar -NoSlack:$NoSlack $NotifyScript
    } catch {
        $Result.notify = 'none'
        Write-Host ('ALERT FAIL: ' + $_.Exception.Message)
    }
    Write-OzkLog $StateDir ('RUN ' + $Result.status + ' ' + $Result.stamp + ' notify=' + $Result.notify)
}

# ---------- التشغيل ----------

function Invoke-OzkAmeenBackup {
    [CmdletBinding()]
    param(
        [switch]$Execute,
        [string[]]$Databases = @('AmnDb002', 'AmnDb001', 'AmnConfig'),
        [string]$Instance = '.\SQLEXPRESS',
        [string]$LocalRoot = 'C:\AmeenBackup\OZK',
        [string]$ExternalRoot = '',
        [string]$StateDir = 'C:\ProgramData\OZK-TOBACCO\Backup',
        [string]$ExpectedHost = 'OZK2026',
        [string]$NotifyScript = '',
        [int]$LocalMinFreeGB = 20,
        [int]$ExternalMinFreeGB = 20,
        [switch]$NoCompress,
        [string]$SlackChannel = 'C0C1X2E58MT',
        [string]$SlackTokenEnvVar = 'SLACK_BOT_TOKEN',
        [switch]$NoSlack,
        [switch]$Cloud,
        [datetime]$Now = (Get-Date)
    )

    if ($Cloud) { throw 'النسخ السحابي غير مفعّل في هذا الإصدار ويحتاج موافقة المالك (U1).' }
    Assert-OzkBackupDatabases $Databases
    $script:InstanceName = $Instance
    $layout = New-OzkRunLayout $LocalRoot $Now

    $result = [ordered]@{
        mode        = $(if ($Execute) { 'execute' } else { 'dry-run' })
        host        = (& $script:HostNameReader)
        stamp       = $layout.Stamp
        runDir      = $layout.RunDir
        databases   = @($Databases)
        files       = @()
        compressed  = (-not $NoCompress)
        zip         = $null
        local       = 'pending'
        external    = 'pending'
        externalDir = ''
        cloud       = 'disabled'
        space       = @()
        notify      = 'none'
        status      = 'pending'
        errors      = @()
        finishedAt  = ''
    }

    if (-not $Execute) {
        Write-Host '== DryRun (الافتراضي): لا اتصال SQL ولا كتابة ملفات ولا رسائل =='
        Write-Host ('الجهاز المطلوب للتنفيذ: {0} · الحالي: {1}' -f $ExpectedHost, $result.host)
        Write-Host ('مجلد التشغيل الجديد: ' + $layout.RunDir)
        foreach ($db in $Databases) {
            $file = Join-OzkPath $layout.RunDir ('{0}_{1}.bak' -f $db, $layout.Stamp)
            Write-Host ('  ' + (New-OzkBackupStatement $db $file $layout.Stamp))
            Write-Host ('  ' + (New-OzkVerifyStatement $file))
        }
        if (-not $NoCompress) { Write-Host ('الضغط: ' + $layout.ZipName + ' مع مطابقة SHA256 لكل مدخل') } else { Write-Host 'الضغط: معطّل (-NoCompress)' }
        Write-Host ('حارس المساحة: محلي ≥ {0} GB، خارجي ≥ {1} GB + حجم الملف' -f $LocalMinFreeGB, $ExternalMinFreeGB)
        Write-Host ('القرص الخارجي: ' + $(if ($ExternalRoot) { $ExternalRoot } else { 'بحث عن ' + $script:ExternalMarker }))
        Write-Host ('التنبيه: ' + $(if ($NoSlack) { 'Telegram فقط' } else { 'Slack ' + $SlackChannel + ' ثم Telegram بديلاً' }) + ' (لا إرسال في DryRun)')
        Write-Host ('القفل: ' + $script:LockName)
        Write-Host 'السحابة: معطّلة'
        $result.local = 'skipped'
        $result.external = 'skipped'
        $result.status = 'dry-run'
        return [pscustomobject]$result
    }

    if ($result.host -ne $ExpectedHost) {
        throw ("الجهاز الحالي '{0}' ليس '{1}'. لا تنفيذ." -f $result.host, $ExpectedHost)
    }

    $lock = & $script:LockAcquirer
    if (-not $lock) {
        $result.local = 'skipped'
        $result.external = 'skipped'
        $result.status = 'skipped-concurrent'
        $result.finishedAt = (Get-Date).ToString('o')
        Write-Host 'SKIP: تشغيل آخر للنسخ جارٍ الآن (القفل مأخوذ). لم يُلمس شيء.'
        return [pscustomobject]$result
    }

    $errors = New-Object System.Collections.ArrayList
    try {
        $localSpace = Test-OzkFreeSpace $LocalRoot $LocalMinFreeGB
        $result.space = @($localSpace)
        if (-not $localSpace.Ok) {
            [void]$errors.Add(('مساحة محلية غير كافية: {0} GB متاحة، المطلوب ≥ {1} GB' -f $localSpace.FreeGB, $LocalMinFreeGB))
            $result.local = 'failed'
            $result.external = 'skipped'
        } elseif (Test-Path -LiteralPath $layout.RunDir) {
            throw ('مجلد التشغيل موجود مسبقاً، لن يُستبدل شيء: ' + $layout.RunDir)
        } else {
            New-Item -ItemType Directory -Force -Path $layout.RunDir | Out-Null
            Write-OzkLog $StateDir ('RUN start ' + $layout.Stamp + ' -> ' + $layout.RunDir)

            $files = New-Object System.Collections.ArrayList
            foreach ($db in $Databases) {
                $fileName = '{0}_{1}.bak' -f $db, $layout.Stamp
                $file = Join-OzkPath $layout.RunDir $fileName
                try {
                    if (Test-Path -LiteralPath $file) { throw ('الملف موجود مسبقاً: ' + $file) }
                    Invoke-OzkSql (New-OzkBackupStatement $db $file $layout.Stamp)
                    Invoke-OzkSql (New-OzkVerifyStatement $file)
                    $entry = [ordered]@{
                        database = $db
                        file     = $fileName
                        bytes    = (Get-Item -LiteralPath $file).Length
                        sha256   = (Get-OzkSha256 $file)
                        verified = 'RESTORE VERIFYONLY WITH CHECKSUM'
                    }
                    [void]$files.Add([pscustomobject]$entry)
                    Write-OzkLog $StateDir ('BACKUP ok {0} {1} bytes verified' -f $db, $entry.bytes)
                } catch {
                    [void]$errors.Add(('{0}: {1}' -f $db, $_.Exception.Message))
                    Write-OzkLog $StateDir ('BACKUP FAIL {0}: {1}' -f $db, $_.Exception.Message)
                }
            }
            $result.files = @($files)

            $transfer = @($files)
            if ($errors.Count -eq 0 -and $files.Count -eq $Databases.Count -and -not $NoCompress) {
                try {
                    $z = New-OzkVerifiedZip (Join-OzkPath $layout.RunDir $layout.ZipName) @($files) $layout.RunDir
                    $result.zip = $z
                    $transfer = @([pscustomobject]@{ file = $z.zip; sha256 = $z.sha256 })
                    Write-OzkLog $StateDir ('ZIP ok {0} {1} bytes, entries match SHA256' -f $z.zip, $z.bytes)
                } catch {
                    [void]$errors.Add('zip: ' + $_.Exception.Message)
                    Write-OzkLog $StateDir ('ZIP FAIL: ' + $_.Exception.Message)
                }
            }

            $manifest = [ordered]@{
                host      = $result.host
                instance  = $Instance
                stamp     = $layout.Stamp
                createdAt = $Now.ToString('o')
                copyOnly  = $true
                checksum  = $true
                files     = @($files)
                zip       = $result.zip
            }
            Write-OzkJson (Join-OzkPath $layout.RunDir 'manifest.json') $manifest

            if ($errors.Count -gt 0 -or $files.Count -ne $Databases.Count) {
                $result.local = 'failed'
                $result.external = 'skipped'
            } else {
                $result.local = 'ok'
                $ext = $ExternalRoot
                if (-not $ext) { $ext = & $script:ExternalRootFinder }
                if (-not $ext) {
                    $result.external = 'missing'
                    Write-OzkLog $StateDir 'EXTERNAL missing: لا يوجد قرص خارجي يحمل العلامة'
                } else {
                    $needed = [int64]0
                    foreach ($t in $transfer) { $needed += (Get-Item -LiteralPath (Join-OzkPath $layout.RunDir $t.file)).Length }
                    $extSpace = Test-OzkFreeSpace $ext $ExternalMinFreeGB $needed
                    $result.space = @($localSpace, $extSpace)
                    if (-not $extSpace.Ok) {
                        $result.external = 'failed'
                        [void]$errors.Add(('مساحة القرص الخارجي غير كافية: {0} GB متاحة، المطلوب ≥ {1} GB + {2} MB' -f $extSpace.FreeGB, $ExternalMinFreeGB, [math]::Round($needed / 1MB, 1)))
                        Write-OzkLog $StateDir 'EXTERNAL FAIL: مساحة غير كافية'
                    } else {
                        $destDir = Join-OzkPath (Join-OzkPath (Join-OzkPath $ext $script:ExternalFolder) $Now.ToString('yyyy')) $layout.Stamp
                        $result.externalDir = $destDir
                        try {
                            Copy-OzkRunVerified $layout.RunDir $destDir $transfer
                            $result.external = 'ok'
                            Write-OzkLog $StateDir ('EXTERNAL ok -> ' + $destDir + ' (SHA256 matched)')
                        } catch {
                            $result.external = 'failed'
                            [void]$errors.Add('external: ' + $_.Exception.Message)
                            Write-OzkLog $StateDir ('EXTERNAL FAIL: ' + $_.Exception.Message)
                        }
                    }
                }
            }
        }

        Complete-OzkRun $result $errors $false $StateDir $SlackChannel $SlackTokenEnvVar ([bool]$NoSlack) $NotifyScript
    } catch {
        # أي استثناء غير متوقع (فحص المساحة، إنشاء المجلد، manifest.json، ...) يصبح
        # نتيجة failed مع status.json وتنبيه، بدل أن يقفز صامتاً إلى المستوى الأعلى.
        [void]$errors.Add('unexpected: ' + $_.Exception.Message)
        Write-Host ('UNEXPECTED: ' + $_.Exception.Message)
        Complete-OzkRun $result $errors $true $StateDir $SlackChannel $SlackTokenEnvVar ([bool]$NoSlack) $NotifyScript
    } finally {
        try { & $script:LockReleaser $lock } catch { Write-Host ('LOCK RELEASE FAIL: ' + $_.Exception.Message) }
    }
    return [pscustomobject]$result
}

# نقطة الدخول: تعيد رمز الخروج. أي فشل قبل القفل (الجهاز، القواعد، -Cloud) مع
# -Execute يُرسل تنبيهاً best-effort بدل أن ينتهي بطباعة FAIL وحدها.
function Invoke-OzkBackupMain {
    param([hashtable]$Arguments)
    $isExecute = [bool]$Arguments['Execute']
    try {
        $r = Invoke-OzkAmeenBackup @Arguments
        switch ($r.status) {
            'dry-run' { return 0 }
            'ok' { return 0 }
            'local-only' { return 2 }
            'skipped-concurrent' { return 3 }
            default { return 1 }
        }
    } catch {
        Write-Host ('FAIL: ' + $_.Exception.Message)
        if ($isExecute) {
            try {
                $text = '🚨 نسخ الأمين الاحتياطي لم يبدأ: ' + $_.Exception.Message
                $channel = $Arguments['SlackChannel']; if (-not $channel) { $channel = 'C0C1X2E58MT' }
                $tokenVar = $Arguments['SlackTokenEnvVar']; if (-not $tokenVar) { $tokenVar = 'SLACK_BOT_TOKEN' }
                [void](Send-OzkAlert $text 'ozk-ameen-backup-precheck-failed' 180 $channel $tokenVar -NoSlack:([bool]$Arguments['NoSlack']) ([string]$Arguments['NotifyScript']))
            } catch {
                Write-Host ('ALERT FAIL: ' + $_.Exception.Message)
            }
        }
        return 1
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $code = Invoke-OzkBackupMain @{
        Execute = [bool]$Execute; Databases = $Databases; Instance = $Instance; LocalRoot = $LocalRoot
        ExternalRoot = $ExternalRoot; StateDir = $StateDir; ExpectedHost = $ExpectedHost; NotifyScript = $NotifyScript
        LocalMinFreeGB = $LocalMinFreeGB; ExternalMinFreeGB = $ExternalMinFreeGB; NoCompress = [bool]$NoCompress
        SlackChannel = $SlackChannel; SlackTokenEnvVar = $SlackTokenEnvVar; NoSlack = [bool]$NoSlack; Cloud = [bool]$Cloud
    }
    exit $code
}
