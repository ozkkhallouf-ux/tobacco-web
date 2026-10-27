#Requires -Version 5.1
# ============================================================
# Test-AmeenInvoiceAgentMonitor.ps1
#
# يثبت سلوك tools\ameen-invoice-agent-monitor.ps1 بمحاكاة آمنة كاملة: سجل الوكيل ملف مؤقت يكتبه
# الاختبار بأسطر بالصيغة الحرفية للوكيل، والساعة ووجود العملية واسم الجهاز بدائل وهمية، وTelegram
# سكربت وهمي يسجّل المفاتيح والنصوص (ناجح أو فاشل). لا SQL ولا أمين ولا Supabase ولا رسائل حقيقية.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-AmeenInvoiceAgentMonitor.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose 'console encoding unchanged' }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$monPath = Join-Path (Join-Path $repoRoot 'tools') 'ameen-invoice-agent-monitor.ps1'

$failures = New-Object System.Collections.ArrayList
$script:passes = 0
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { $script:passes++; Write-Host "  ok  : $m" -ForegroundColor Green }
function Assert-True([bool]$Condition, [string]$Message) { if ($Condition) { Add-Pass $Message } else { Add-Failure $Message } }

. $monPath

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('ozk-agent-monitor-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $base | Out-Null

# ---------- البدائل الوهمية ----------
$script:ProcAlive = $true
$script:AgentProcessProbe = { return $script:ProcAlive }
$script:HostNameReader = { return 'OZK2026' }

$sentLog = Join-Path $base 'sent.log'        # كل محاولة ناجحة: المفتاح
$attemptLog = Join-Path $base 'attempts.log' # كل محاولة (ناجحة أو فاشلة): المفتاح
$msgDir = Join-Path $base 'messages'
New-Item -ItemType Directory -Force -Path $msgDir | Out-Null
$okNotify = Join-Path $base 'notify-ok.ps1'
$failNotify = Join-Path $base 'notify-fail.ps1'
[System.IO.File]::WriteAllText($okNotify, ('param([string]$Message,[string]$EventType,[string]$DedupeKey,[int]$DedupeMinutes) Add-Content -LiteralPath ''' + $attemptLog + ''' -Value $DedupeKey; Add-Content -LiteralPath ''' + $sentLog + ''' -Value ($EventType + ''|'' + $DedupeMinutes + ''|'' + $DedupeKey); [System.IO.File]::WriteAllText((Join-Path ''' + $msgDir + ''' ([guid]::NewGuid().ToString(''N'') + ''.txt'')), $Message, [System.Text.Encoding]::UTF8); Write-Host "TELEGRAM-NOTIFY OK ($EventType)"'), (New-Object System.Text.UTF8Encoding($true)))
[System.IO.File]::WriteAllText($failNotify, ('param([string]$Message,[string]$EventType,[string]$DedupeKey,[int]$DedupeMinutes) Add-Content -LiteralPath ''' + $attemptLog + ''' -Value $DedupeKey; Write-Host "TELEGRAM-NOTIFY FAILED: The remote name could not be resolved"; exit 0'), (New-Object System.Text.UTF8Encoding($true)))

function Get-Sent { if (Test-Path -LiteralPath $sentLog) { return ,@(Get-Content -LiteralPath $sentLog | ForEach-Object { ($_ -split '\|', 3)[2] }) } return ,@() }
function Get-Attempts { if (Test-Path -LiteralPath $attemptLog) { return ,@(Get-Content -LiteralPath $attemptLog) } return ,@() }
function Get-AllMessages { return ,@(Get-ChildItem -LiteralPath $msgDir -Filter '*.txt' | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8) }) }
function Reset-Notify { foreach ($f in @($sentLog, $attemptLog)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }; Get-ChildItem -LiteralPath $msgDir -Filter '*.txt' | Remove-Item -Force }

$T0 = [datetime]::new(2026, 10, 27, 9, 0, 0)
$Secret = 'Password=Sup3rS3cret!;User ID=tobacco_sync_service;Server=OZK-TOBACCO'

# بيئة جديدة: سجل وكيل ومجلد حالة منفصلان.
function New-Case([string]$Name) {
    Reset-Notify
    $script:ProcAlive = $true
    $dir = Join-Path $base $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return [pscustomobject]@{ log = (Join-Path $dir 'agent.log'); state = (Join-Path $dir 'state') }
}
# سطر بالصيغة الحرفية لـWrite-AgentLog في الوكيل (Add-Content -Encoding UTF8).
function Add-Log($Case, [double]$Minute, [string]$Message) {
    $line = '{0} {1}' -f $T0.AddMinutes($Minute).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture), $Message
    Add-Content -LiteralPath $Case.log -Value $line -Encoding UTF8
}
function Add-Start($Case, [double]$Minute) { Add-Log $Case $Minute 'بدء الوكيل: db=AmnDb002 outbox=C:\ProgramData\OZK-TOBACCO\ameen-invoice-events send=False last_seq=10 bills=2000' }
function Add-Perf($Case, [double]$Minute) { Add-Log $Case $Minute 'أداء: دورات=150 متوسط=60ms أقصى=110ms حفظ_كامل=0 حفظ_علامة=3 علامة_متعذرة=0 إيقاع=2ث' }
function Add-Down($Case, [double]$Minute) { Add-Log $Case $Minute ('DISCONNECTED: انقطع اتصال SQL أثناء الرصد (SqlException 10054): A transport-level error ' + $Secret + ' — لا تقدّم للعلامة المائية') }
function Add-Retry($Case, [double]$Minute, [int]$N) { Add-Log $Case $Minute ('RECONNECTING: محاولة {0} فشلت (SqlException 53)، التالية بعد 300 ث' -f $N) }
function Add-Up($Case, [double]$Minute) { Add-Log $Case $Minute 'RECOVERED: اتصال SQL عاد بعد 7 محاولة و1200 ث' }
function Invoke-Run($Case, [double]$Minute, [switch]$Fail, [switch]$EvaluateOnly, [int]$TailBytes = 4194304) {
    $notify = $okNotify; if ($Fail) { $notify = $failNotify }; if ($EvaluateOnly) { $notify = '' }
    return Invoke-AgentMonitor -AgentLogFile $Case.log -StateDir $Case.state -NotifyScript $notify -Now $T0.AddMinutes($Minute) -TailBytes $TailBytes
}

try {
    Write-Host '== 1) انقطاع أقل من 10 دقائق: لا تنبيه'
    $c = New-Case 'short'
    Add-Start $c 0; Add-Perf $c 5; Add-Down $c 10; Add-Retry $c 10.1 1; Add-Retry $c 12 2
    $r = Invoke-Run $c 15
    Assert-True ($r.alerts.Count -eq 0 -and $r.open) 'انقطاع مفتوح منذ 5 دقائق: لا تنبيه، والانقطاع مرئي'
    Add-Up $c 16; Add-Perf $c 21
    $r = Invoke-Run $c 23
    Assert-True ((Get-Sent).Count -eq 0 -and -not $r.open) 'عاد بعد 6 دقائق: لا تنبيه انقطاع ولا تعافٍ'

    Write-Host '== 2) انقطاع يتجاوز 10 دقائق: تنبيه واحد'
    $c = New-Case 'long'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 10.1 1; Add-Retry $c 15 2
    $r = Invoke-Run $c 15
    Assert-True ((Get-Sent).Count -eq 0) 'عند 5 دقائق: لا شيء بعد'
    Add-Retry $c 20 3
    $r = Invoke-Run $c 21
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 1 -and $sent[0] -eq 'invoice-agent:sql-down:20261027T091000') ('عند 11 دقيقة: تنبيه sql-down واحد بمفتاح بداية الانقطاع: ' + ($sent -join ','))
    Assert-True (@(Get-Content -LiteralPath $sentLog)[0] -like 'invoice_agent|1440|*') 'النوع invoice_agent ونافذة منع التكرار في الخادم 24 ساعة'
    $msg = (Get-AllMessages)[0]
    Assert-True ($msg -match 'منقطع منذ 11 دقيقة' -and $msg -match '2026-10-27 09:10' -and $msg -match 'OZK2026') 'النص: المدة ووقت البداية واسم الجهاز'
    Add-Retry $c 25 4
    [void](Invoke-Run $c 26); [void](Invoke-Run $c 31); [void](Invoke-Run $c 36)
    Assert-True ((Get-Sent).Count -eq 1) 'فحوص متتالية أثناء الانقطاع نفسه: لا تكرار'

    Write-Host '== 3) عودة الاتصال: تنبيه تعافٍ واحد بالمدة'
    Add-Up $c 40
    [void](Invoke-Run $c 42)
    Assert-True ((Get-Sent).Count -eq 1) 'خلال نافذة التأرجح (6 د): لا تنبيه عودة بعد'
    Add-Log $c 44 'إعادة الدورة بعد 2 ث (عودة متتالية رقم 1)'; Add-Perf $c 46
    $r = Invoke-Run $c 47
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 2 -and $sent[1] -eq 'invoice-agent:sql-up:20261027T091000') 'تنبيه sql-up واحد بمفتاح الحادثة نفسها'
    $msg = @(Get-AllMessages | Where-Object { $_ -match '🟢' })[0]
    Assert-True ($msg -match 'بعد انقطاع دام 30 دقيقة' -and $msg -match '09:10' -and $msg -match '09:40') 'نص التعافي يتضمن مدة الانقطاع وبدايته ونهايته'
    [void](Invoke-Run $c 52); [void](Invoke-Run $c 57)
    Assert-True ((Get-Sent).Count -eq 2) 'لا تكرار لتنبيه التعافي'

    Write-Host '== 4) انقطاع جديد بعد التعافي: حادثة جديدة بمفتاح جديد'
    Add-Down $c 60; Add-Retry $c 65 1
    [void](Invoke-Run $c 66)
    Assert-True ((Get-Sent).Count -eq 2) 'الانقطاع الجديد عند 6 دقائق: لا تنبيه'
    Add-Retry $c 70 2
    [void](Invoke-Run $c 71)
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 3 -and $sent[2] -eq 'invoice-agent:sql-down:20261027T100000') 'تنبيه sql-down جديد للحادثة الجديدة'
    Add-Up $c 75; Add-Perf $c 80
    [void](Invoke-Run $c 82)
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 4 -and $sent[3] -eq 'invoice-agent:sql-up:20261027T100000') 'وتعافٍ واحد لها'

    Write-Host '== 5) إعادة تشغيل المراقب أثناء الانقطاع'
    $c = New-Case 'restart'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 15 1; Add-Retry $c 20 2
    $r1 = Invoke-Run $c 21
    Assert-True ((Get-Sent).Count -eq 1) 'التشغيل الأول أرسل تنبيه الانقطاع'
    # كل فحص عملية مستقلة (مهمة كل 5 دقائق): «إعادة التشغيل» = استدعاء جديد يقرأ الحالة من القرص.
    $r2 = Invoke-Run $c 26
    Assert-True ((Get-Sent).Count -eq 1 -and $r2.alerts.Count -eq 0) 'استدعاء جديد بنفس مجلد الحالة: لا تكرار'
    $evalBefore = [System.IO.File]::ReadAllText((Join-Path $c.state 'monitor-state.json'))
    $re = Invoke-Run $c 27 -EvaluateOnly
    Assert-True ($re.evaluateOnly -and [System.IO.File]::ReadAllText((Join-Path $c.state 'monitor-state.json')) -eq $evalBefore) 'التقييم اليدوي بلا -NotifyScript لا يرسل ولا يغيّر الحالة'
    # فقدان ملف الحالة: المفتاح مشتق من السجل لا من وقت الفحص، فهو نفسه ⇒ الخادم يبتلعه خلال 24 ساعة.
    Add-Retry $c 25 3; Add-Retry $c 30 4
    Remove-Item -LiteralPath (Join-Path $c.state 'monitor-state.json') -Force
    $r3 = Invoke-Run $c 31 -EvaluateOnly
    Assert-True ($r3.alerts.Count -eq 1 -and $r3.alerts[0].key -eq $r1.alerts[0].key) 'بعد فقدان الحالة: المفتاح المعاد حسابه مطابق حرفياً (منع التكرار في الخادم يغطيه)'
    Set-Content -LiteralPath (Join-Path $c.state 'monitor-state.json') -Value '{ broken' -Encoding UTF8
    $r4 = Invoke-Run $c 32 -EvaluateOnly
    Assert-True ($r4.alerts.Count -eq 1 -and $r4.alerts[0].key -eq $r1.alerts[0].key) 'ملف حالة تالف لا يكسر المراقب، والمفتاح نفسه'

    Write-Host '== 6) توقف الوكيل نهائياً'
    $c = New-Case 'gaveup'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 10.1 1
    Add-Log $c 14 'GAVE_UP: تعذّر اتصال SQL بعد 3 محاولة — خروج برمز 6 (الأحداث والعلامة محفوظة كما هي)'
    $script:ProcAlive = $false
    $r = Invoke-Run $c 15
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 1 -and $sent[0] -eq 'invoice-agent:stopped:20261027T091400-gaveup') 'GAVE_UP: تنبيه توقف فوري واحد'
    $msg = (Get-AllMessages)[0]
    Assert-True ($msg -match 'GAVE_UP' -and $msg -match 'اتصال SQL كان منقطعاً منذ 2026-10-27 09:10') 'التنبيه يذكر السبب وانقطاع SQL المفتوح في رسالة واحدة'
    Assert-True ((Invoke-AgentMonitorMain @{ AgentLogFile = $c.log; StateDir = $c.state; NotifyScript = $okNotify; Now = $T0.AddMinutes(16) }) -eq 1) 'رمز الخروج 1 للوكيل المتوقف'
    [void](Invoke-Run $c 25); [void](Invoke-Run $c 40)
    Assert-True ((Get-Sent).Count -eq 1) 'لا تكرار للتوقف، ولا تنبيه sql-down منفصل والوكيل متوقف'
    # عودة الوكيل (المهمة أعادته): إقلاعه يمر بإعادة الاتصال ثم «بدء الوكيل».
    $script:ProcAlive = $true
    Add-Down $c 50; Add-Up $c 51; Add-Start $c 51
    $r = Invoke-Run $c 52
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 2 -and $sent[1] -eq 'invoice-agent:back:20261027T091400-gaveup') 'عودة الوكيل: تنبيه back واحد'
    $msg = @(Get-AllMessages | Where-Object { $_ -match '✅' })[0]
    Assert-True ($msg -match 'رجع شغّال' -and $msg -match 'وكيل أحداث الفواتير على OZK2026' -and $msg -match 'واتصال SQL عاد بعد انقطاع دام 41 دقيقة') 'عودة SQL مدمجة في رسالة العودة نفسها'
    Add-Perf $c 57
    [void](Invoke-Run $c 60); [void](Invoke-Run $c 70)
    Assert-True ((Get-Sent).Count -eq 2) 'لا sql-up منفصل بعد الدمج، ولا تكرار للعودة'

    $c = New-Case 'fatal'
    Add-Start $c 0; Add-Perf $c 5
    Add-Log $c 7 ('FATAL: خطأ غير متوقع أوقف الوكيل (SqlException 18456): Login failed. ' + $Secret)
    $script:ProcAlive = $false
    [void](Invoke-Run $c 8)
    $sent = Get-Sent; $msg = (Get-AllMessages)[0]
    Assert-True ($sent.Count -eq 1 -and $sent[0] -eq 'invoice-agent:stopped:20261027T090700-fatal' -and $msg -match 'FATAL: SqlException 18456') 'FATAL: تنبيه توقف فوري بنوع الخطأ فقط'

    $c = New-Case 'end'
    Add-Start $c 0; Add-Log $c 30 'انتهى الوكيل: last_seq=12 pending=0'
    $script:ProcAlive = $false
    [void](Invoke-Run $c 31)
    Assert-True ((Get-Sent).Count -eq 1 -and (Get-AllMessages)[0] -match 'انتهى تشغيله') 'انتهاء التشغيل: تنبيه توقف واضح'

    $c = New-Case 'silent'
    Add-Start $c 0; Add-Perf $c 5
    $script:ProcAlive = $false
    $r = Invoke-Run $c 7
    Assert-True ((Get-Sent).Count -eq 0 -and $r.status.status -eq 'suspect') 'اختفاء العملية بلا سطر نهاية: مشتبه في الفحص الأول، بلا تنبيه'
    $r = Invoke-Run $c 12
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 1 -and $sent[0] -eq 'invoice-agent:stopped:20261027T090500-silent' -and (Get-AllMessages)[0] -match 'عمليته غير موجودة') 'الفحص الثاني يؤكد: تنبيه توقف واحد'
    [void](Invoke-Run $c 17)
    Assert-True ((Get-Sent).Count -eq 1) 'لا تكرار'
    $script:ProcAlive = $true
    Add-Start $c 20
    [void](Invoke-Run $c 22)
    Assert-True ((Get-Sent).Count -eq 2 -and (Get-Sent)[1] -eq 'invoice-agent:back:20261027T090500-silent') 'عودته بعد الانهيار: تنبيه back واحد'

    $c = New-Case 'hung'
    Add-Start $c 0; Add-Perf $c 5
    $r = Invoke-Run $c 20
    Assert-True ($r.status.status -eq 'suspect' -and $r.status.reason -eq 'hung') 'عملية حيّة وسجل متوقف 15 دقيقة: مشتبه (تعلّق)'
    $r = Invoke-Run $c 25
    Assert-True ((Get-Sent).Count -eq 1 -and (Get-AllMessages)[0] -match 'سجله متوقف منذ 20 دقيقة') 'التعلّق المؤكد: تنبيه توقف'

    Write-Host '== 6ب) الاستيقاظ من الإسبات لا يولّد توقفاً وهمياً'
    $c = New-Case 'wake'
    Add-Start $c 0; Add-Perf $c 5
    # الجهاز نام ساعة: أول فحص بعد الاستيقاظ يرى سجلاً قديماً والعملية حيّة.
    $r = Invoke-Run $c 65
    Assert-True ($r.status.status -eq 'suspect' -and (Get-Sent).Count -eq 0) 'أول فحص بعد الاستيقاظ: مشتبه بلا تنبيه'
    Add-Down $c 65.2; Add-Up $c 65.5; Add-Perf $c 69
    $r = Invoke-Run $c 70
    Assert-True ($r.status.status -eq 'alive' -and (Get-Sent).Count -eq 0) 'الوكيل كتب بعد الاستيقاظ: حيّ، ولا توقف ولا عودة'

    Write-Host '== 7) فشل Telegram وإعادة المحاولة دون تكرار'
    $c = New-Case 'tgfail'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 15 1; Add-Retry $c 20 2
    $r = Invoke-Run $c 21 -Fail
    Assert-True ($r.failed -and (Get-Sent).Count -eq 0) 'الإرسال فشل: لا يُعلَّم مُرسلاً'
    $st = [System.IO.File]::ReadAllText((Join-Path $c.state 'monitor-state.json')) | ConvertFrom-Json
    Assert-True (@($st.sentKeys).Count -eq 0) 'الحالة لا تحمل مفتاحاً لم يصل'
    Add-Retry $c 25 3
    [void](Invoke-Run $c 26 -Fail)
    Add-Retry $c 30 4
    [void](Invoke-Run $c 31)
    $att = Get-Attempts
    Assert-True ((Get-Sent).Count -eq 1 -and @($att | Select-Object -Unique).Count -eq 1 -and $att.Count -eq 3) ('3 محاولات بالمفتاح نفسه، وصلت مرة واحدة: ' + ($att -join ','))
    [void](Invoke-Run $c 36)
    Assert-True ((Get-Sent).Count -eq 1) 'بعد الوصول: لا إعادة'
    # تنبيه لم يصل ثم عاد الاتصال قبل الفحص التالي: رسالة واحدة «انقطع ثم عاد»، لا «منقطع» متأخرة.
    $c = New-Case 'tgfail-then-up'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 20 1
    [void](Invoke-Run $c 21 -Fail)
    Add-Up $c 23; Add-Perf $c 28
    [void](Invoke-Run $c 30)
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 1 -and $sent[0] -eq 'invoice-agent:sql-up:20261027T091000' -and (Get-AllMessages)[0] -match 'انقطع اتصال SQL 13 دقيقة') 'تنبيه الانقطاع الضائع يُستبدل برسالة واحدة متسقة'
    # تنبيهان مستحقان والأول فقط وصل (Telegram سقط بينهما): الثاني وحده يُعاد.
    $c = New-Case 'partial'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 20 1
    Add-Log $c 21 'GAVE_UP: تعذّر اتصال SQL بعد 2 محاولة — خروج برمز 6 (الأحداث والعلامة محفوظة كما هي)'
    $script:ProcAlive = $false
    [void](Invoke-Run $c 22)
    $script:ProcAlive = $true
    Add-Start $c 30
    Add-Down $c 31; Add-Retry $c 45 1
    # back مستحق، وانقطاع جديد مفتوح 15 دقيقة ⇒ تنبيهان: sql-down ثم back.
    $r = Invoke-Run $c 46 -Fail
    [void](Invoke-Run $c 47)
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 3 -and ($sent | Select-Object -Unique).Count -eq 3) ('كل تنبيه وصل مرة واحدة فقط: ' + ($sent -join ','))

    Write-Host '== 8) اتصال يتأرجح: انقطاعات قصيرة متقاربة تُعدّ انقطاعاً واحداً'
    $c = New-Case 'flap'
    Add-Start $c 0
    foreach ($m in 10, 13, 16, 19) { Add-Down $c $m; Add-Up $c ($m + 0.5) }
    Add-Down $c 22
    $r = Invoke-Run $c 22.5
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 1 -and $sent[0] -eq 'invoice-agent:sql-down:20261027T091000' -and (Get-AllMessages)[0] -match 'منذ 12 دقيقة') 'تأرجح 12 دقيقة: تنبيه واحد من أول انقطاع'

    Write-Host '== 9) انقطاع فات المراقب كله'
    $c = New-Case 'late'
    Add-Start $c 0; Add-Down $c 10; Add-Up $c 30; Add-Perf $c 35
    [void](Invoke-Run $c 40)
    Assert-True ((Get-Sent).Count -eq 1 -and (Get-AllMessages)[0] -match 'لم يُرسل تنبيه الانقطاع في حينه') 'انقطاع 20 دقيقة انتهى قبل أي فحص: رسالة واحدة «انقطع ثم عاد»'
    $c = New-Case 'old'
    Add-Start $c 0; Add-Down $c 10; Add-Up $c 30; Add-Perf $c 200
    [void](Invoke-Run $c 201)
    Assert-True ((Get-Sent).Count -eq 0) 'انقطاع قديم (أكثر من ساعة) عند أول تشغيل: لا رسائل تاريخية'

    Write-Host '== 10) ذيل سجل مقصوص يُكمل الحادثة المحفوظة'
    $c = New-Case 'tail'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 20 1
    [void](Invoke-Run $c 21)
    for ($i = 0; $i -lt 400; $i++) { Add-Retry $c (21 + $i * 0.01) 2 }
    Add-Up $c 40; Add-Perf $c 45
    $r = Invoke-Run $c 47 -TailBytes 8000
    $sent = Get-Sent
    Assert-True ($sent.Count -eq 2 -and $sent[1] -eq 'invoice-agent:sql-up:20261027T091000' -and (Get-AllMessages | Where-Object { $_ -match '🟢' }) -match 'دام 30 دقيقة') 'بداية الانقطاع خارج الذيل: التعافي بالمعرّف والمدة الأصليين'

    Write-Host '== 11) مثيل ثانٍ مرفوض لا يُعدّ دليل حياة'
    $tl = Get-AgentTimeline @('2026-10-27 09:00:00 بدء الوكيل: db=AmnDb002', '2026-10-27 09:30:00 رفض: مثيل آخر من الوكيل يعمل على الصندوق نفسه (C:\x) — لا تشغيل متوازٍ.') $null 6
    Assert-True ($tl.lastLine -eq $T0 -and -not $tl.terminal) 'سطر «رفض: مثيل آخر» لا يحدّث آخر نشاط ولا يعني توقفاً'

    Write-Host '== 12) لا أسرار في أي تنبيه'
    # الرسائل تُمسح مع كل حالة جديدة؛ هنا تُولَّد الأنواع الأربعة دفعة واحدة بسجل مليء بالأسرار.
    $c = New-Case 'secrets'
    Add-Start $c 0; Add-Down $c 10; Add-Retry $c 21 1
    [void](Invoke-Run $c 21)
    Add-Up $c 30; Add-Perf $c 36
    [void](Invoke-Run $c 37)
    Add-Log $c 40 ('FATAL: خطأ غير متوقع أوقف الوكيل (InvalidOperationException): ' + $Secret)
    $script:ProcAlive = $false
    [void](Invoke-Run $c 41)
    $script:ProcAlive = $true
    Add-Start $c 50
    [void](Invoke-Run $c 51)
    $all = Get-AllMessages
    Assert-True ($all.Count -eq 4) ('أُرسلت الأنواع الأربعة: ' + $all.Count)
    $leak = @($all | Where-Object { $_ -match 'Password|Sup3r|tobacco_sync|Server=|User ID|transport-level|Login failed' })
    Assert-True ($leak.Count -eq 0) 'لا كلمة مرور ولا اسم حساب SQL ولا نص من رسائل السجل في أي تنبيه'
    $monSrc = [System.IO.File]::ReadAllText($monPath)
    Assert-True ($monSrc -notmatch 'EnvFile|Get-Content|GetEnvironmentVariable') 'المراقب لا يقرأ ملف الأسرار ولا متغيرات الاتصال'

    Write-Host '== 13) رموز الخروج وحارس الجهاز'
    $c = New-Case 'codes'
    Add-Start $c 0; Add-Perf $c 5
    Assert-True ((Invoke-AgentMonitorMain @{ AgentLogFile = $c.log; StateDir = $c.state; Now = $T0.AddMinutes(6) }) -eq 0) 'سليم ⇒ 0'
    Add-Down $c 7
    Assert-True ((Invoke-AgentMonitorMain @{ AgentLogFile = $c.log; StateDir = $c.state; Now = $T0.AddMinutes(8) }) -eq 2) 'انقطاع SQL مفتوح ⇒ 2'
    $script:HostNameReader = { return 'OZKUSER' }
    Reset-Notify
    Assert-True ((Invoke-AgentMonitorMain @{ AgentLogFile = $c.log; StateDir = $c.state; NotifyScript = $okNotify; Now = $T0.AddMinutes(30) }) -eq 3 -and (Get-Attempts).Count -eq 0) 'جهاز غير OZK2026 ⇒ 3 بلا أي إرسال'
    $script:HostNameReader = { return 'OZK2026' }
} catch {
    Add-Failure ('استثناء غير متوقع: ' + $_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
} finally {
    try { Remove-Item -LiteralPath $base -Recurse -Force } catch { Write-Verbose 'cleanup skipped' }
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host ("FAILED: {0} of {1}" -f $failures.Count, ($failures.Count + $script:passes)) -ForegroundColor Red
    exit 1
}
Write-Host ("PASSED: {0} assertions" -f $script:passes) -ForegroundColor Green
exit 0
