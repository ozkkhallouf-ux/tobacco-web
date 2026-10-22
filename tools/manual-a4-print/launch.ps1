# OZK - طباعة فواتير A4: يشغّل الخادم المحلي (إن لم يكن يعمل) ثم يفتح الواجهة.
# يُستدعى من اختصار سطح المكتب. لا يكتب شيئاً في الأمين.
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataRoot = Join-Path $env:ProgramData 'OZK\ManualA4Print'
$SecretFile = Join-Path $DataRoot 'sql.secret'
$UserData = Join-Path $env:LOCALAPPDATA 'OZK\ManualA4Print'
$KeyFile = Join-Path $UserData 'session.key'

function Show-Error([string]$Text) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'OZK - طباعة فواتير A4', 'OK', 'Error',
        'Button1', [System.Windows.Forms.MessageBoxOptions]::RtlReading)
}

function Test-Server([int]$Port) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/ping" -UseBasicParsing -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch { return $false }
}

try {
    $port = 47616
    $cfgFile = Join-Path $AppDir 'config.json'
    if (Test-Path $cfgFile) {
        $cfg = Get-Content -Raw -Encoding UTF8 $cfgFile | ConvertFrom-Json
        if ($cfg.port) { $port = [int]$cfg.port }
    }

    if (-not (Test-Server $port)) {
        # سرّ اتصال القراءة: DPAPI على مستوى الجهاز + ACL يقصر قراءته على المستخدم
        # والمدراء (set-sql-secret.ps1). بلا ملف ⇒ متغير البيئة الحالي.
        if (Test-Path $SecretFile) {
            Add-Type -AssemblyName System.Security
            $enc = [IO.File]::ReadAllBytes($SecretFile)
            $plain = [Security.Cryptography.ProtectedData]::Unprotect($enc, [Text.Encoding]::UTF8.GetBytes('OZK-ManualA4Print'),
                [Security.Cryptography.DataProtectionScope]::LocalMachine)
            $env:OZK_MANUAL_PRINT_SQL = [Text.Encoding]::UTF8.GetString($plain)
        }
        $node = Join-Path $AppDir '..\..\runtime\node.exe'
        if (-not (Test-Path $node)) {
            $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
            if (-not $cmd) { throw 'لم يُعثر على Node.js (runtime\node.exe أو node في PATH).' }
            $node = $cmd.Source
        }
        New-Item -ItemType Directory -Force -Path $UserData | Out-Null
        # مفتاح جلسة سابقة (خادم توقف) لا يصلح للخادم الجديد.
        Remove-Item -LiteralPath $KeyFile -ErrorAction SilentlyContinue
        Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $AppDir -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $UserData 'server.out.log') -RedirectStandardError (Join-Path $UserData 'server.err.log')
        Remove-Item Env:\OZK_MANUAL_PRINT_SQL -ErrorAction SilentlyContinue
        $deadline = (Get-Date).AddSeconds(20)
        while (-not (Test-Server $port)) {
            if ((Get-Date) -gt $deadline) {
                $errLog = Join-Path $UserData 'server.err.log'
                $err = if (Test-Path $errLog) { (Get-Content -Tail 5 -Encoding UTF8 $errLog) -join "`n" } else { '' }
                throw "تعذّر تشغيل خادم الطباعة.`n$err"
            }
            Start-Sleep -Milliseconds 400
        }
    }

    # مفتاح الجلسة يكتبه الخادم في مجلد المستخدم؛ يُمرَّر مرة واحدة ويتحوّل إلى كوكي.
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Path $KeyFile)) {
        if ((Get-Date) -gt $deadline) { throw 'لم يُنشئ الخادم مفتاح الجلسة.' }
        Start-Sleep -Milliseconds 200
    }
    $key = (Get-Content -Raw -Encoding UTF8 $KeyFile).Trim()
    $url = "http://127.0.0.1:$port/?k=$key"
    $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($edge) { Start-Process -FilePath $edge -ArgumentList @("--app=$url", '--window-size=1280,860') }
    else { Start-Process $url }
} catch {
    Show-Error ("تعذّر فتح أداة الطباعة:`n" + $_.Exception.Message)
    exit 1
}
