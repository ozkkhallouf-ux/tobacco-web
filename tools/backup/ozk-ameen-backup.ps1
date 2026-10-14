#Requires -Version 5.1
# ============================================================
# ozk-ameen-backup.ps1 — نسخة احتياطية مُتحقَّقة لقواعد الأمين على OZK2026
#
# يحلّ محل tools\ozk-backup-external.ps1 الذي عاش خارج Git وضاع في
# 2026-09-01 (سحبه `git stash -u` من مجلد العمل)، فتوقفت النسخ الخارجية
# والسحابية منذ 2026-08-31. هذا الإصدار محفوظ في Git عمداً.
#
# الوضع الافتراضي DryRun: يطبع الخطة فقط، بلا أي اتصال SQL وبلا أي ملف.
# التنفيذ الفعلي يحتاج -Execute صراحةً، وعلى الجهاز OZK2026 وحده.
#
# ما يفعله عند -Execute:
#   1) BACKUP DATABASE ... WITH COPY_ONLY, CHECKSUM, NOINIT لكل قاعدة من
#      القائمة الثابتة (AmnDb002, AmnDb001, AmnConfig) إلى ملف جديد بمجلد
#      جديد. COPY_ONLY لا يغيّر تسلسل نسخ الأمين اليدوية.
#   2) RESTORE VERIFYONLY ... WITH CHECKSUM لكل ملف.
#   3) SHA256 لكل ملف في manifest.json.
#   4) نسخ المجلد إلى القرص الخارجي (إن وُجد ملف العلامة على جذره)، ثم إعادة
#      حساب SHA256 في الوجهة ومقارنته بالأصل.
#   5) status.json + سجل شهري + تنبيه Telegram (best-effort).
#
# ما لا يفعله إطلاقاً:
#   - لا يحذف ولا يستبدل أي ملف نسخ (لا Remove-Item، والنسخ يرفض وجهة موجودة).
#   - لا RESTORE DATABASE، ولا REPLACE، ولا أي تعديل على القواعد أو إعدادات SQL.
#   - لا رفع للسحابة (-Cloud مرفوض في هذا الإصدار).
#   - لا يلمس المهام المجدولة.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\ozk-ameen-backup.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\backup\ozk-ameen-backup.ps1 -Execute
#
# رموز الخروج: 0 نجاح كامل (أو DryRun) · 1 فشل · 2 نجاح محلي والقرص الخارجي غير موصول.
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
    [switch]$Cloud
)

$ErrorActionPreference = 'Stop'

# القائمة الثابتة الوحيدة المسموح بها. أي اسم آخر (حتى AmnDb002_TEST) مرفوض.
$script:AllowedDatabases = @('AmnDb002', 'AmnDb001', 'AmnConfig')
# ملف على جذر القرص الخارجي يميّزه. حرف القرص يتغيّر، العلامة لا.
$script:ExternalMarker = 'OZK-BACKUP-DRIVE.marker'
$script:ExternalFolder = 'OZK-Backups'

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

function New-OzkRunLayout([string]$LocalRoot, [datetime]$Now) {
    $stamp = $Now.ToString('yyyy-MM-dd_HHmmss')
    $runDir = Join-OzkPath (Join-OzkPath $LocalRoot $Now.ToString('yyyy')) $stamp
    return [pscustomobject]@{ Stamp = $stamp; RunDir = $runDir }
}

function Write-OzkLog([string]$StateDir, [string]$Message) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if (-not $StateDir) { return }
    $logDir = Join-OzkPath $StateDir 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    Add-Content -LiteralPath (Join-OzkPath $logDir ('backup-' + (Get-Date -Format 'yyyy-MM') + '.log')) -Value $line -Encoding UTF8
}

function Send-OzkNotify([string]$NotifyScript, [string]$Message, [string]$Key, [int]$Minutes) {
    if (-not $NotifyScript -or -not (Test-Path -LiteralPath $NotifyScript)) { return }
    try {
        & $NotifyScript -Message $Message -EventType 'windows' -DedupeKey $Key -DedupeMinutes $Minutes | Out-Null
    } catch {
        Write-Verbose 'notify failed (best-effort)'
    }
}

function Write-OzkJson([string]$Path, $Object) {
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json = $Object | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

# ينسخ مجلد التشغيل إلى وجهة جديدة ثم يقارن SHA256 لكل ملف مع manifest.
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
        [switch]$Cloud,
        [datetime]$Now = (Get-Date)
    )

    if ($Cloud) { throw 'النسخ السحابي غير مفعّل في هذا الإصدار ويحتاج موافقة المالك (U1).' }
    Assert-OzkBackupDatabases $Databases
    $script:InstanceName = $Instance
    $layout = New-OzkRunLayout $LocalRoot $Now

    $result = [ordered]@{
        mode          = $(if ($Execute) { 'execute' } else { 'dry-run' })
        host          = (& $script:HostNameReader)
        stamp         = $layout.Stamp
        runDir        = $layout.RunDir
        databases     = @($Databases)
        files         = @()
        local         = 'pending'
        external      = 'pending'
        externalDir   = ''
        cloud         = 'disabled'
        status        = 'pending'
        errors        = @()
        finishedAt    = ''
    }

    if (-not $Execute) {
        Write-Host '== DryRun (الافتراضي): لا اتصال SQL ولا كتابة ملفات =='
        Write-Host ('الجهاز المطلوب للتنفيذ: {0} · الحالي: {1}' -f $ExpectedHost, $result.host)
        Write-Host ('مجلد التشغيل الجديد: ' + $layout.RunDir)
        foreach ($db in $Databases) {
            $file = Join-OzkPath $layout.RunDir ('{0}_{1}.bak' -f $db, $layout.Stamp)
            Write-Host ('  ' + (New-OzkBackupStatement $db $file $layout.Stamp))
            Write-Host ('  ' + (New-OzkVerifyStatement $file))
        }
        Write-Host ('القرص الخارجي: ' + $(if ($ExternalRoot) { $ExternalRoot } else { 'بحث عن ' + $script:ExternalMarker }))
        Write-Host 'السحابة: معطّلة'
        $result.local = 'skipped'
        $result.external = 'skipped'
        $result.status = 'dry-run'
        return [pscustomobject]$result
    }

    if ($result.host -ne $ExpectedHost) {
        throw ("الجهاز الحالي '{0}' ليس '{1}'. لا تنفيذ." -f $result.host, $ExpectedHost)
    }
    if (Test-Path -LiteralPath $layout.RunDir) {
        throw ('مجلد التشغيل موجود مسبقاً، لن يُستبدل شيء: ' + $layout.RunDir)
    }
    New-Item -ItemType Directory -Force -Path $layout.RunDir | Out-Null
    Write-OzkLog $StateDir ('RUN start ' + $layout.Stamp + ' -> ' + $layout.RunDir)

    $errors = New-Object System.Collections.ArrayList
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

    $manifest = [ordered]@{
        host      = $result.host
        instance  = $Instance
        stamp     = $layout.Stamp
        createdAt = $Now.ToString('o')
        copyOnly  = $true
        checksum  = $true
        files     = @($files)
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
            $destDir = Join-OzkPath (Join-OzkPath (Join-OzkPath $ext $script:ExternalFolder) $Now.ToString('yyyy')) $layout.Stamp
            $result.externalDir = $destDir
            try {
                Copy-OzkRunVerified $layout.RunDir $destDir @($files)
                $result.external = 'ok'
                Write-OzkLog $StateDir ('EXTERNAL ok -> ' + $destDir + ' (SHA256 matched)')
            } catch {
                $result.external = 'failed'
                [void]$errors.Add('external: ' + $_.Exception.Message)
                Write-OzkLog $StateDir ('EXTERNAL FAIL: ' + $_.Exception.Message)
            }
        }
    }

    $result.errors = @($errors)
    if ($result.local -ne 'ok' -or $result.external -eq 'failed') {
        $result.status = 'failed'
    } elseif ($result.external -eq 'missing') {
        $result.status = 'local-only'
    } else {
        $result.status = 'ok'
    }
    $result.finishedAt = (Get-Date).ToString('o')
    Write-OzkJson (Join-OzkPath $StateDir 'status.json') $result
    Write-OzkLog $StateDir ('RUN ' + $result.status + ' ' + $layout.Stamp)

    if ($result.status -eq 'failed') {
        Send-OzkNotify $NotifyScript ('فشل النسخ الاحتياطي للأمين: ' + ($errors -join ' | ')) 'ozk-ameen-backup-fail' 180
    } elseif ($result.status -eq 'local-only') {
        Send-OzkNotify $NotifyScript 'النسخة الاحتياطية محفوظة على C فقط: القرص الخارجي غير موصول' 'ozk-ameen-backup-no-external' 1440
    }
    return [pscustomobject]$result
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $r = Invoke-OzkAmeenBackup -Execute:$Execute -Databases $Databases -Instance $Instance -LocalRoot $LocalRoot `
            -ExternalRoot $ExternalRoot -StateDir $StateDir -ExpectedHost $ExpectedHost -NotifyScript $NotifyScript -Cloud:$Cloud
        switch ($r.status) {
            'dry-run' { exit 0 }
            'ok' { exit 0 }
            'local-only' { exit 2 }
            default { exit 1 }
        }
    } catch {
        Write-Host ('FAIL: ' + $_.Exception.Message)
        exit 1
    }
}
