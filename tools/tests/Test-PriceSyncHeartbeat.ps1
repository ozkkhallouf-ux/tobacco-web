#Requires -Version 5.1
# ============================================================
# Test-PriceSyncHeartbeat.ps1
#
# اختبار سلوكي لنبضة مزامنة الأسعار (supabase/proposed/16-price-sync-heartbeat.sql).
# حادثة 2026-10-18: توقفت مهمة الأسعار 76 دقيقة ولم يُكتب أي أثر، لأن الحالة
# كانت تُنشر بعد النجاح وحده. هنا نتحقق أن كل محاولة بـ-Apply تنشر نبضة
# بحالتها الصحيحة، وأن رموز خروج المهمة لم تتغير.
#
# ينفّذ tools/sync-approved-prices-to-ameen.ps1 الحقيقي وtools/publish-price-sync-heartbeat.ps1
# الحقيقي في مجلد مؤقت، مع بدائل مزيفة للسحب والتطبيق والتحقق وTelegram.
# بلا شبكة، بلا Supabase، بلا الأمين.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-PriceSyncHeartbeat.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 }
catch { Write-Verbose ("تعذّر ضبط ترميز الكونسول: " + $_.Exception.Message) }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolsDir = Join-Path $repoRoot 'tools'
$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }
function Check([bool]$condition, [string]$m) { if ($condition) { Add-Pass $m } else { Add-Failure $m } }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("psh-" + [guid]::NewGuid().ToString('N').Substring(0, 10))
$fakeTools = Join-Path $tmp 'tools'
New-Item -ItemType Directory -Force -Path $fakeTools | Out-Null
$utf8Bom = New-Object Text.UTF8Encoding($true)
function Write-Script([string]$name, [string]$text) {
    [IO.File]::WriteAllText((Join-Path $fakeTools $name), $text, $utf8Bom)
}

Copy-Item -LiteralPath (Join-Path $toolsDir 'sync-approved-prices-to-ameen.ps1') -Destination $fakeTools
# الناشر الحقيقي، مع ملف الالتقاط مأخوذاً من متغير بيئة الاختبار بدل الشبكة.
$publisher = Get-Content -LiteralPath (Join-Path $toolsDir 'publish-price-sync-heartbeat.ps1') -Raw -Encoding UTF8
$capturePattern = '[string]$CaptureFile = ""'
if (-not $publisher.Contains($capturePattern)) { Add-Failure 'الناشر لم يعد يحمل -CaptureFile — تغيّرت بنيته فسقط الاختبار'; exit 1 }
Write-Script 'publish-price-sync-heartbeat.ps1' ($publisher.Replace($capturePattern, '[string]$CaptureFile = $env:FAKE_HEARTBEAT_FILE'))

Write-Script 'pull-approved-prices.ps1' @'
param($EnvFile, $OutputCsv, $LogFile)
Add-Content -LiteralPath $env:FAKE_CALLS -Value 'pull'
if ($env:FAKE_PULL_EXIT -eq '1') { exit 1 }
Write-Output "PRICE_PULL count=321 max_updated_at=$env:FAKE_FEED_MAX"
exit 0
'@
Write-Script 'apply-approved-prices-to-ameen.ps1' @'
param($CsvFile, $EnvFile, $LogFile)
Add-Content -LiteralPath $env:FAKE_CALLS -Value 'apply'
if ($env:FAKE_APPLY_EXIT -eq '1') { exit 1 }
Write-Output "PRICE_APPLY jumla=321 retail=317 skipped=0 notfound=1 conflict=$env:FAKE_CONFLICT"
exit 0
'@
Write-Script 'verify-prices.ps1' @'
param($ResultFile)
Add-Content -LiteralPath $env:FAKE_CALLS -Value 'verify'
$line = switch ($env:FAKE_VERIFY) {
    'ok' { 'PRICE_VERIFY wholesale=321 retail=317 mismatches=0 missing=0' }
    'mismatch' { 'PRICE_VERIFY wholesale=318 retail=317 mismatches=3 missing=1' }
    default { 'garbage' }
}
[IO.File]::WriteAllText($ResultFile, $line, [Text.Encoding]::ASCII)
'@
Write-Script 'publish-price-sync-status.ps1' @'
param($Status, $WholesaleMatched, $RetailMatched, $MismatchCount, $MissingCount, $Message)
Add-Content -LiteralPath $env:FAKE_CALLS -Value "status:$Status"
exit 0
'@
Write-Script 'send-telegram-notification.ps1' @'
param($Message, $EventType, $DedupeKey, $DedupeMinutes, $EnvFile)
Add-Content -LiteralPath $env:FAKE_CALLS -Value "telegram:$DedupeKey"
'@

$psExe = (Get-Process -Id $PID).Path
function Invoke-Sync([hashtable]$fake, [switch]$Preview) {
    $calls = Join-Path $tmp ("calls-" + [guid]::NewGuid().ToString('N') + '.txt')
    $capture = Join-Path $tmp ("hb-" + [guid]::NewGuid().ToString('N') + '.json')
    New-Item -ItemType File -Path $calls | Out-Null
    $env:FAKE_CALLS = $calls
    $env:FAKE_HEARTBEAT_FILE = if ($fake.ContainsKey('HeartbeatFile')) { $fake.HeartbeatFile } else { $capture }
    $env:FAKE_PULL_EXIT = [string]$fake.PullExit
    $env:FAKE_APPLY_EXIT = [string]$fake.ApplyExit
    $env:FAKE_CONFLICT = if ($fake.ContainsKey('Conflict')) { [string]$fake.Conflict } else { '0' }
    $env:FAKE_VERIFY = if ($fake.ContainsKey('Verify')) { $fake.Verify } else { 'ok' }
    $env:FAKE_FEED_MAX = if ($fake.ContainsKey('FeedMax')) { $fake.FeedMax } else { '2026-10-18T07:46:00.0000000Z' }
    $script = Join-Path $fakeTools 'sync-approved-prices-to-ameen.ps1'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-EnvFile', (Join-Path $tmp 'none.env'))
    if (-not $Preview) { $argList += '-Apply' }
    $output = & $psExe @argList 2>&1 | Out-String
    $exit = $LASTEXITCODE
    $heartbeat = $null
    $raw = ''
    if (Test-Path -LiteralPath $capture) {
        $raw = Get-Content -LiteralPath $capture -Raw -Encoding UTF8
        $heartbeat = ($raw | ConvertFrom-Json).p_heartbeat
    }
    return @{ Exit = $exit; Calls = @(Get-Content -LiteralPath $calls); Heartbeat = $heartbeat; Raw = $raw; Output = $output }
}

try {
    Write-Host "-- 1) المهمة تعمل ولا توجد أسعار جديدة: نبضة ok بأرقام التطبيق والتحقق"
    $r = Invoke-Sync @{}
    Check ($r.Exit -eq 0) "رمز الخروج 0 (كان: $($r.Exit))"
    Check ($r.Heartbeat.status -eq 'ok' -and $r.Heartbeat.stage -eq 'done') 'status=ok وstage=done'
    Check ($r.Heartbeat.applied -eq $true -and $r.Heartbeat.ameen_connected -eq $true) 'applied وameen_connected صحيحان'
    Check ($r.Heartbeat.pulled_count -eq 321 -and $r.Heartbeat.feed_max_updated_at -eq '2026-10-18T07:46:00.0000000Z') 'عدد المسحوب وأحدث updated_at من سطر PRICE_PULL'
    Check ($r.Heartbeat.applied_wholesale -eq 321 -and $r.Heartbeat.applied_retail -eq 317 -and $r.Heartbeat.not_found_count -eq 1) 'أرقام PRICE_APPLY'
    Check ($r.Heartbeat.verified_wholesale -eq 321 -and $r.Heartbeat.mismatch_count -eq 0) 'أرقام PRICE_VERIFY'
    # النص الخام: PowerShell 7 يحوّل التواريخ عند ConvertFrom-Json فلا نقارن بعده.
    Check ($r.Raw -match '"attempt_started_at":"\d{4}-\d\d-\d\dT[^"]*Z"' -and $r.Raw -match '"feed_max_updated_at":"2026-10-18T07:46:00.0000000Z"') 'الأوقات بصيغة ISO UTC'
    Check (($r.Calls -join ',') -eq 'pull,apply,verify,status:ok') "الترتيب والحالة القديمة كما هي ($($r.Calls -join ','))"
    Check ($r.Output -match 'PRICE_APPLY jumla=321') 'سطر PRICE_APPLY ما زال يظهر في خرج المهمة'

    Write-Host "-- 2) فشل السحب: نبضة pull_failed، بلا تطبيق، رمز 1"
    $r = Invoke-Sync @{ PullExit = 1 }
    Check ($r.Exit -eq 1) "رمز الخروج 1 (كان: $($r.Exit))"
    Check ($r.Heartbeat.status -eq 'pull_failed' -and $r.Heartbeat.stage -eq 'pull') 'status=pull_failed'
    Check ($r.Heartbeat.applied -eq $false -and $r.Heartbeat.ameen_connected -eq $false) 'لا تطبيق ولا اتصال مدّعى'
    Check (-not ($r.Calls -contains 'apply')) 'لم يُستدعَ التطبيق'

    Write-Host "-- 3) فشل الاتصال بالأمين: نبضة apply_failed، تنبيه winfail كما كان، رمز 1"
    $r = Invoke-Sync @{ ApplyExit = 1 }
    Check ($r.Exit -eq 1) "رمز الخروج 1 (كان: $($r.Exit))"
    Check ($r.Heartbeat.status -eq 'apply_failed' -and $r.Heartbeat.ameen_connected -eq $false) 'status=apply_failed بلا اتصال'
    Check ($r.Heartbeat.pulled_count -eq 321) 'عدد المسحوب محفوظ رغم الفشل'
    Check ($r.Calls -contains 'telegram:winfail:apply-to-ameen') 'تنبيه الفشل القديم لم يتغير'
    Check (-not ($r.Calls -contains 'verify')) 'لا تحقق بعد فشل التطبيق'

    Write-Host "-- 4) تعارض أسعار: تطبيق وتحقق ناجحان مع conflict=2"
    $r = Invoke-Sync @{ Conflict = 2 }
    Check ($r.Exit -eq 0) "رمز الخروج 0 كما كان (كان: $($r.Exit))"
    Check ($r.Heartbeat.status -eq 'ok' -and $r.Heartbeat.conflict_count -eq 2) 'النبضة تحمل conflict_count=2'

    Write-Host "-- 5) فروق بعد التطبيق: نبضة mismatch، رمز 2"
    $r = Invoke-Sync @{ Verify = 'mismatch' }
    Check ($r.Exit -eq 2) "رمز الخروج 2 (كان: $($r.Exit))"
    Check ($r.Heartbeat.status -eq 'mismatch' -and $r.Heartbeat.mismatch_count -eq 3 -and $r.Heartbeat.missing_count -eq 1) 'status=mismatch بالأرقام'
    Check ($r.Calls -contains 'status:mismatch' -and $r.Calls -contains 'telegram:price-sync:mismatch') 'الحالة والتنبيه القديمان'

    Write-Host "-- 6) تحقق لا يُقرأ: نبضة verify_failed، رمز 3"
    $r = Invoke-Sync @{ Verify = 'garbage' }
    Check ($r.Exit -eq 3) "رمز الخروج 3 (كان: $($r.Exit))"
    Check ($r.Heartbeat.status -eq 'verify_failed' -and $r.Heartbeat.applied -eq $true) 'status=verify_failed بعد تطبيق ناجح'
    Check ($r.Calls -contains 'status:error') 'الحالة القديمة error كما كانت'

    Write-Host "-- 7) المعاينة بلا -Apply: لا نبضة"
    $r = Invoke-Sync @{} -Preview
    Check ($r.Exit -eq 0 -and $null -eq $r.Heartbeat) 'لا نبضة في المعاينة'
    Check (-not ($r.Calls -contains 'apply')) 'المعاينة لا تطبّق'

    Write-Host "-- 8) فشل نشر النبضة لا يغيّر نتيجة المهمة"
    $r = Invoke-Sync @{ HeartbeatFile = (Join-Path $tmp 'missing-dir\hb.json') }
    Check ($r.Exit -eq 0) "رمز الخروج 0 رغم فشل النبضة (كان: $($r.Exit))"
    Check ($r.Output -match 'PRICE-SYNC-HEARTBEAT FAILED') 'الفشل مكتوب في الخرج'

    Write-Host "-- 9) أحدث updated_at غائب: لا قيمة مخترعة"
    $r = Invoke-Sync @{ FeedMax = 'none' }
    Check ($r.Heartbeat.status -eq 'ok' -and [string]$r.Heartbeat.feed_max_updated_at -eq '') 'feed_max_updated_at فارغ'

    Write-Host "-- 10) الناشر يرفض حالة غير معروفة ويقبل disabled من طرف خارجي"
    $capture = Join-Path $tmp 'external.json'
    $real = Join-Path $toolsDir 'publish-price-sync-heartbeat.ps1'
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $real -Status disabled -Message 'معطّلة للصيانة' -CaptureFile $capture | Out-Null
    $external = (Get-Content -LiteralPath $capture -Raw -Encoding UTF8 | ConvertFrom-Json).p_heartbeat
    Check ($LASTEXITCODE -eq 0 -and $external.status -eq 'disabled' -and $external.stage -eq 'external') 'disabled بمرحلة external'
    Check ($external.message -eq 'معطّلة للصيانة') 'الرسالة العربية محفوظة بـUTF-8'
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $real -Status bogus -CaptureFile (Join-Path $tmp 'bogus.json') 2>&1 | Out-Null
    Check ($LASTEXITCODE -ne 0 -and -not (Test-Path -LiteralPath (Join-Path $tmp 'bogus.json'))) 'حالة غير معروفة مرفوضة بلا كتابة'

    Write-Host "-- 11) سطر PRICE_PULL الحقيقي: نص ISO وDateTime وقيمة فارغة"
    $pullSource = Get-Content -LiteralPath (Join-Path $toolsDir 'pull-approved-prices.ps1') -Raw -Encoding UTF8
    $block = [regex]::Match($pullSource, '(?s)\$feedMax = \$null.*?Write-Output "PRICE_PULL[^\r\n]*')
    if (-not $block.Success) {
        Add-Failure 'تعذّر استخراج حساب PRICE_PULL من pull-approved-prices.ps1'
    } else {
        $response = @(
            [pscustomobject]@{ updated_at = '2026-10-18T07:39:13.123+00:00' },
            [pscustomobject]@{ updated_at = [datetime]::SpecifyKind([datetime]'2026-10-18 07:47:55', 'Utc') },
            [pscustomobject]@{ updated_at = '' },
            [pscustomobject]@{ updated_at = 'not a date' }
        )
        $line = & ([scriptblock]::Create($block.Value))
        Check ($line -eq 'PRICE_PULL count=4 max_updated_at=2026-10-18T07:47:55.0000000Z') "أحدث وقت بين الصيغتين ($line)"
        $response = @([pscustomobject]@{ updated_at = $null })
        $line = & ([scriptblock]::Create($block.Value))
        Check ($line -eq 'PRICE_PULL count=1 max_updated_at=none') "بلا تواريخ: none ($line)"
    }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($name in 'FAKE_CALLS', 'FAKE_HEARTBEAT_FILE', 'FAKE_PULL_EXIT', 'FAKE_APPLY_EXIT', 'FAKE_CONFLICT', 'FAKE_VERIFY', 'FAKE_FEED_MAX') {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "FAILED: $($failures.Count) check(s)" -ForegroundColor Red
    exit 1
}
Write-Host "PASS: price sync heartbeat" -ForegroundColor Green
exit 0
