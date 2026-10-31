#Requires -Version 5.1
# ============================================================
# run-repo-task.ps1 — مشغّل موحّد لمهام المستودع (نسخة مرجعية)
#
# النسخة المعتمدة في C:\ProgramData\OZK-TOBACCO\DeployGate\. كل Scheduled
# Task تشغّل سكربتاً من المستودع تمرّ عبره بدل -File المباشر:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File
#     "C:\ProgramData\OZK-TOBACCO\DeployGate\run-repo-task.ps1"
#     -Script "tools/ameen-sync-agent.ps1" [وسائط السكربت...]
#
# يفعل ثلاثة أشياء قبل التشغيل:
#   1. deploying.flag حديثة  ⇒ تخطٍّ هادئ (exit 0) — البوابة تبدّل النسخة الآن.
#      علامة أقدم من flagTtlMinutes ⇒ القارئ يعمل مع تنبيه، والكاتب يبقى متوقفاً.
#   2. السكربت داخل المستودع فعلاً (لا مسارات خارجه ولا ..).
#   3. سكربتات الكتابة (writerScripts): بصمة SHA256 لكل ملف في القائمة يجب أن
#      تطابق writer-allowlist.json التي لا تُحدَّث إلا بنشر معتمد. عدم التطابق
#      ⇒ رفض (exit 1) مع تنبيه. تعديل ملف PS1 وحده لا يغيّر سلوك الكتابة.
# ============================================================
[CmdletBinding()]
param(
    [string]$Script = '',
    [string]$ConfigPath = '',
    [string]$PowerShellExe = '',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ScriptArgs
)

$ErrorActionPreference = 'Stop'

function Read-LauncherJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
}

# مسار السجل (الدفعة د0، 2026-10-31): المشغّل يعمل بحسابات المهام (LOQ وOZKSync)، ولها قراءة
# وتنفيذ فقط على مجلد البوابة، فلا تستطيع كتابة gateDir\launcher.log أصلاً. مع launcherLogDir يكتب
# في مجلد سجلات منفصل ملفاً شهرياً launcher-YYYY-MM.log: التدوير بالاسم، فلا حاجة لحذف أو إعادة
# تسمية. المجلد يُجهَّز مرة واحدة بحساب مدير (set-launcher-log-acl.ps1)، والمشغّل لا ينشئه أبداً كي
# لا يرث صلاحيات افتراضية. مجلد سجل هو مجلد البوابة أو داخله مرفوض: لا كتابة بجوار ملفات الحماية.
# بلا المفتاح يبقى المسار القديم gateDir\launcher.log كما كان. أي فشل ⇒ Write-Host، والمهمة تكمل.
function Get-LauncherLogPath($Config, [datetime]$Now = (Get-Date)) {
    $gateDir = [string]$Config.gateDir
    $dir = ''
    if ($Config.PSObject.Properties['launcherLogDir']) { $dir = [string]$Config.launcherLogDir }
    if ([string]::IsNullOrWhiteSpace($dir)) { return (Join-Path $gateDir 'launcher.log') }
    $sep = [IO.Path]::DirectorySeparatorChar
    $full = [System.IO.Path]::GetFullPath($dir).TrimEnd('\', '/')
    $gateFull = [System.IO.Path]::GetFullPath($gateDir).TrimEnd('\', '/')
    if ($full.Equals($gateFull, [StringComparison]::OrdinalIgnoreCase) -or $full.StartsWith($gateFull + $sep, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return (Join-Path $full ('launcher-' + $Now.ToString('yyyy-MM', [Globalization.CultureInfo]::InvariantCulture) + '.log'))
}

function Write-LauncherLog($Config, [string]$Message) {
    try {
        $path = Get-LauncherLogPath $Config
        if (-not $path) { Write-Host ('launcher log refused (launcherLogDir inside gateDir): ' + $Message); return }
        $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message
        [System.IO.File]::AppendAllText($path, $line + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    } catch { Write-Host $Message }
}

function Send-LauncherAlert([string]$Message, [string]$DedupeKey) {
    $notify = Join-Path $PSScriptRoot 'notify.ps1'
    if (Test-Path -LiteralPath $notify) {
        try { & $notify -Message $Message -DedupeKey $DedupeKey -ConfigPath $script:LauncherConfigPath | Out-Null }
        catch { Write-Verbose ('notify failed: ' + $_.Exception.Message) }
    }
}

function Invoke-RepoTask {
    param($Config, [string]$RelativeScript, [string[]]$Arguments, [string]$PsExe)

    $gateDir = [string]$Config.gateDir
    $rel = ($RelativeScript -replace '\\', '/').TrimStart('/')
    $repoFull = [System.IO.Path]::GetFullPath([string]$Config.repoPath).TrimEnd('\', '/')
    $scriptFull = [System.IO.Path]::GetFullPath((Join-Path $repoFull ($rel -replace '/', [IO.Path]::DirectorySeparatorChar)))
    if (-not $scriptFull.StartsWith($repoFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Write-LauncherLog $Config ('REFUSE outside repo: ' + $RelativeScript)
        return 2
    }
    if (-not (Test-Path -LiteralPath $scriptFull)) {
        Write-LauncherLog $Config ('REFUSE missing script: ' + $rel)
        Send-LauncherAlert ('مهمة Windows تشير إلى سكربت غير موجود: ' + $rel) ('launcher-missing-' + $rel)
        return 2
    }

    $writers = @($Config.writerScripts | ForEach-Object { ([string]$_ -replace '\\', '/').TrimStart('/') })
    # قائمة البصمات تضم أيضاً كل ملف كشفت البوابة قدرته على الكتابة (متغيّر اتصال الكتابة أو
    # تعليمات تعديل SQL) — فالسكربت «القارئ» الذي صار كاتباً يُعامَل كاتباً هنا أيضاً.
    $allow = Read-LauncherJson (Join-Path $gateDir 'writer-allowlist.json')
    $pinned = @()
    if ($allow -and $allow.files) { $pinned = @($allow.files.PSObject.Properties | ForEach-Object { $_.Name }) }
    $isWriter = ($writers -contains $rel) -or ($pinned -contains $rel)

    $flagPath = Join-Path $gateDir 'deploying.flag'
    if (Test-Path -LiteralPath $flagPath) {
        $ageMinutes = ((Get-Date) - (Get-Item -LiteralPath $flagPath).LastWriteTime).TotalMinutes
        if ($ageMinutes -lt [double]$Config.flagTtlMinutes) {
            Write-LauncherLog $Config ('SKIP deploy in progress: ' + $rel)
            return 0
        }
        if ($isWriter) {
            Write-LauncherLog $Config ('SKIP stale deploy flag, writer stays paused: ' + $rel)
            Send-LauncherAlert ('علامة نشر Windows عالقة منذ ' + [int]$ageMinutes + ' دقيقة — مهمة الكتابة متوقفة: ' + $rel) 'launcher-stale-flag-writer'
            return 0
        }
        Write-LauncherLog $Config ('RUN despite stale deploy flag (reader): ' + $rel)
        Send-LauncherAlert ('علامة نشر Windows عالقة منذ ' + [int]$ageMinutes + ' دقيقة — مهام القراءة عادت للعمل') 'launcher-stale-flag'
    }

    if ($isWriter) {
        if (-not $allow) {
            Write-LauncherLog $Config ('REFUSE writer without allowlist: ' + $rel)
            Send-LauncherAlert ('رُفض تشغيل سكربت كتابة بلا قائمة بصمات معتمدة: ' + $rel) 'launcher-writer-no-allowlist'
            return 1
        }
        foreach ($w in @(@($writers) + $pinned | Select-Object -Unique)) {
            $wFull = Join-Path $repoFull ($w -replace '/', [IO.Path]::DirectorySeparatorChar)
            $expected = [string]$allow.files.$w
            $actual = ''
            if (Test-Path -LiteralPath $wFull) { $actual = (Get-FileHash -LiteralPath $wFull -Algorithm SHA256).Hash.ToLowerInvariant() }
            if ($expected -ne $actual) {
                Write-LauncherLog $Config ('REFUSE writer hash mismatch: ' + $w + ' (running ' + $rel + ')')
                Send-LauncherAlert ('رُفض تشغيل مهمة كتابة: بصمة ' + $w + ' غير معتمدة') ('launcher-writer-hash-' + $w)
                return 1
            }
        }
    }

    if ([string]::IsNullOrWhiteSpace($PsExe)) {
        $PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    }
    $childArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $scriptFull) + @($Arguments | Where-Object { $_ -ne $null })
    # سطر RUN قبل التشغيل وسطر DONE بعده: يُثبتان كل دورة ناجحة في سجل المشغّل نفسه.
    # الوسائط لا تُكتب في السجل (قد تحمل مسارات أو قيماً لا تخص السجل)، عددها فقط.
    Write-LauncherLog $Config ('RUN ' + $rel + ' pid=' + $PID + ' writer=' + $isWriter + ' args=' + @($Arguments | Where-Object { $_ -ne $null }).Count)
    $started = Get-Date
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $PsExe @childArgs
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
    if ($null -eq $code) { $code = 0 }
    Write-LauncherLog $Config ('DONE ' + $rel + ' pid=' + $PID + ' exit=' + $code + ' seconds=' + [int]((Get-Date) - $started).TotalSeconds)
    return $code
}

if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($Script)) { Write-Host 'usage: run-repo-task.ps1 -Script tools/<name>.ps1 [args...]'; exit 2 }
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $PSScriptRoot 'gate-config.json' }
    $script:LauncherConfigPath = $ConfigPath
    $config = Read-LauncherJson $ConfigPath
    if (-not $config) { Write-Host ('launcher config not found: ' + $ConfigPath); exit 2 }
    exit (Invoke-RepoTask -Config $config -RelativeScript $Script -Arguments $ScriptArgs -PsExe $PowerShellExe)
}
