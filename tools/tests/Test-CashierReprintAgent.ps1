# اختبار العامل المحلي لإعادة طباعة الكاشير (printDispatch=agent) تحت Windows PowerShell 5.1 وPowerShell 7.
# بلا طابعة ولا أمين ولا ssh: الطباعة scriptblock وهمي أو Invoke-CashierReprint بجسر وهمي، والساعة
# ومالك الملف قابلان للحقن. يغطي: التذكرة الحصرية، المالك المسموح، الصيغة، مهلة الالتقاط، منع التكرار،
# الاستعادة بعد انقطاع الكهرباء (تذكرة في processing قبل الحجز وبعده)، وانتظار Serve ونتائجه.
# لا يرسل أي مهمة طباعة حقيقية في أي حالة.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolDir = Join-Path (Join-Path $repoRoot "tools") "cashier-reprint"
. (Join-Path $toolDir "cashier-reprint-lib.ps1")
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME = "TESTHOST" }

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }

$SVC = "S-1-5-21-1111111111-2222222222-3333333333-1001"
$OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002"
$RETAIL = "cc1097b1-662d-4d80-8e4e-3b493249591c"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("cashier-agent-test-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $tempRoot -Force)
$fakeBridge = Join-Path $tempRoot "fake-bridge.ps1"
[IO.File]::WriteAllText($fakeBridge, "param() 'fake'", (New-Object Text.UTF8Encoding($true)))
$fakeHash = Get-CashierFileSha256 $fakeBridge

function Write-ConfigFile($Values) {
    $path = Join-Path $tempRoot ("config-" + [guid]::NewGuid().ToString("N") + ".json")
    $base = [ordered]@{ mode = "local"; bridgeScriptPath = $fakeBridge; expectedBridgeSha256 = $fakeHash; printerName = "XPRINTER XP-T80Q 80MM"; bridgeTimeoutSeconds = 60 }
    foreach ($k in $Values.Keys) { $base[$k] = $Values[$k] }
    [IO.File]::WriteAllText($path, ([pscustomobject]$base | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    return $path
}
function New-AgentConfig([int]$Pickup = 20, [int]$ResultTimeout = 150) {
    return (Read-CashierReprintConfig (Write-ConfigFile @{ printDispatch = "agent"; agentRequesterSids = @($SVC); agentPickupSeconds = $Pickup; agentResultTimeoutSeconds = $ResultTimeout }))
}
function New-AgentRoot {
    $r = Join-Path $tempRoot ("root-" + [guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $r -Force)
    [void](Initialize-CashierAgentFolders $r)
    return $r
}
function Get-TicketPath([string]$Root, [string]$Id) { Join-Path (Get-CashierAgentPaths $Root).Inbox (([guid]$Id).ToString("N") + ".json") }
function Get-ResultCount([string]$Root) { @(Get-ChildItem -LiteralPath (Get-CashierAgentPaths $Root).Results -File -Filter "*.json").Count }

$script:prints = New-Object System.Collections.Generic.List[object]
$printStub = {
    param($n, $d, $id, $from)
    $script:prints.Add([pscustomobject]@{ Number = $n; Date = $d; RequestId = $id; From = $from })
    return [pscustomobject]@{ Status = "sent"; Message = "ok"; Confirmation = "spooler_completed" }
}
$ownerSvc = { param($p) $SVC }
$ownerOther = { param($p) $OTHER }

# طباعة حقيقية عبر Invoke-CashierReprint بجسر وهمي: الحجز والقفل والسجل كما في الإنتاج.
# بلا GetNewClosure: في Windows PowerShell 5.1 لا يرى الـclosure دوال المكتبة المحمّلة في نطاق السكربت،
# فتُمرَّر القيم عبر متغيرات نطاق السكربت.
$bridge = @{ Runs = 0 }
function New-RealPrint([string]$Root, $Config) {
    $script:realRoot = $Root; $script:realConfig = $Config
    return {
        param($n, $d, $id, $from)
        $result = Invoke-CashierReprint -Config $script:realConfig -Root $script:realRoot -Number $n -Date $d -RequestId $id -RequestedFrom $from `
            -Lookup { param($x) @([pscustomobject]@{ InvoiceGuid = "g1"; InvoiceNumber = $x; TypeGuid = $RETAIL; TypeName = "مبيعات مركز"; BillType = 1; InvoiceDate = "2026-10-24"; CreateDate = [datetime]"2026-10-24 10:00:00"; IsPosted = $true; RecordState = 0; Total = 1; CustomerName = "x" }) } `
            -BridgeCheck { param($a, $b) "hash" } `
            -Runner { param($a, $b, $e, $f) $script:bridge.Runs++; [pscustomobject]@{ ExitCode = 0; Output = "JobId : 9"; TimedOut = $false } } `
            -JobWatcher { param($a, $b) "spooler_completed" }
        return [pscustomobject]@{ Status = $result.Status; Message = $result.Message; Confirmation = [string]$result.Details.confirmation }
    }
}

try {
    # ── الإعداد ──────────────────────────────────────────────────────────────
    $cfg = New-AgentConfig
    Assert "إعداد العامل يُقرأ" ($cfg.printDispatch -eq "agent" -and @($cfg.agentRequesterSids).Count -eq 1 -and $cfg.agentRequesterSids[0] -eq $SVC)
    Assert "الإعداد الافتراضي direct" ((Read-CashierReprintConfig (Write-ConfigFile @{})).printDispatch -eq "direct")
    Assert "agent بلا agentRequesterSids مرفوض" (Throws { Read-CashierReprintConfig (Write-ConfigFile @{ printDispatch = "agent" }) })
    Assert "SID غير حساب محلي مرفوض (Everyone)" (Throws { Read-CashierReprintConfig (Write-ConfigFile @{ printDispatch = "agent"; agentRequesterSids = @("S-1-1-0") }) })
    Assert "قيمة printDispatch مجهولة مرفوضة" (Throws { Read-CashierReprintConfig (Write-ConfigFile @{ printDispatch = "ssh" }) })
    Assert "مهلة نتيجة أقصر من مهلة الالتقاط مرفوضة" (Throws { Read-CashierReprintConfig (Write-ConfigFile @{ printDispatch = "agent"; agentRequesterSids = @($SVC); agentPickupSeconds = 30; agentResultTimeoutSeconds = 20 }) })
    Assert "مهلة نتيجة أقصر من زمن الطباعة الكامل مرفوضة" (Throws { Read-CashierReprintConfig (Write-ConfigFile @{ printDispatch = "agent"; agentRequesterSids = @($SVC); bridgeTimeoutSeconds = 200; agentResultTimeoutSeconds = 150 }) })
    Assert "agent على جهاز بلا طابعة (remote) مرفوض" (Throws { Read-CashierReprintConfig (Write-ConfigFile @{ mode = "remote"; printDispatch = "agent"; agentRequesterSids = @($SVC); remoteHost = "h"; remoteUser = "u"; remoteExpectedHostName = "OZKUSER"; remoteKeyPath = "k"; remoteKnownHostsPath = "kh" }) })

    # ── التذكرة ──────────────────────────────────────────────────────────────
    $root = New-AgentRoot
    $id = [guid]::NewGuid().ToString()
    $createdAt = New-CashierAgentTicket $root 2682 "2026-10-24" $id "OZK2026"
    Assert "تذكرة أولى تُكتب وتعيد وقت إنشائها" ($createdAt -is [datetime] -and $createdAt -eq (Get-Item -LiteralPath (Get-TicketPath $root $id)).CreationTimeUtc)
    Assert "تذكرة ثانية بالمعرّف نفسه ⇒ null (حصرية)" ($null -eq (New-CashierAgentTicket $root 2682 "2026-10-24" $id "OZK2026"))
    $t = Read-CashierAgentTicket (Get-TicketPath $root $id)
    Assert "التذكرة تُقرأ بحقولها" ($t.RequestId -eq $id -and $t.InvoiceNumber -eq 2682 -and $t.InvoiceDate -eq "2026-10-24" -and $t.RequestedFrom -eq "OZK2026")
    Assert "تاريخ بصيغة خاطئة لا يُكتب" (Throws { New-CashierAgentTicket $root 1 "24-10-2026" ([guid]::NewGuid().ToString()) "OZK2026" })
    Assert "جهاز طالب بصيغة خاطئة لا يُكتب" (Throws { New-CashierAgentTicket $root 1 "2026-10-24" ([guid]::NewGuid().ToString()) "a;b" })
    foreach ($bad in @(
            '{"requestId":"ID","invoiceNumber":1,"invoiceDate":"2026-10-24","requestedFrom":"OZK2026","createdAt":"x","extra":1}',
            '{"requestId":"ID","invoiceNumber":"1; rm","invoiceDate":"2026-10-24","requestedFrom":"OZK2026","createdAt":"x"}',
            '{"requestId":"ID","invoiceNumber":1,"invoiceDate":"2026-10-24","requestedFrom":"OZK 2026","createdAt":"x"}',
            '{"requestId":"OTHER","invoiceNumber":1,"invoiceDate":"2026-10-24","requestedFrom":"OZK2026","createdAt":"x"}',
            'not json')) {
        $bid = [guid]::NewGuid().ToString()
        $p = Get-TicketPath $root $bid
        [IO.File]::WriteAllText($p, $bad.Replace("OTHER", [guid]::NewGuid().ToString()).Replace("ID", $bid))
        Assert "تذكرة مشوّهة مرفوضة: $($bad.Substring(0, [math]::Min(40, $bad.Length)))" (Throws { Read-CashierAgentTicket $p })
        Remove-Item -LiteralPath $p
    }
    $big = Get-TicketPath $root ([guid]::NewGuid().ToString())
    [IO.File]::WriteAllText($big, ("x" * 5000))
    Assert "تذكرة أكبر من الحد مرفوضة" (Throws { Read-CashierAgentTicket $big })
    Remove-Item -LiteralPath $big

    # ── دورة العامل: المسار السليم ───────────────────────────────────────────
    $script:prints.Clear()
    $handled = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc)
    Assert "العامل يطبع التذكرة مرة واحدة" ($handled.Count -eq 1 -and $handled[0].Status -eq "sent" -and $script:prints.Count -eq 1 -and $script:prints[0].Number -eq 2682 -and $script:prints[0].From -eq "OZK2026")
    Assert "التذكرة تُزال بعد المعالجة" (-not (Test-Path -LiteralPath (Get-TicketPath $root $id)) -and @(Get-ChildItem -LiteralPath (Get-CashierAgentPaths $root).Processing -File).Count -eq 0)
    $res = Read-CashierAgentResult $root $id
    Assert "النتيجة تُكتب وتُقرأ" ($null -ne $res -and $res.Status -eq "sent" -and $res.Confirmation -eq "spooler_completed")
    Assert "حالة الطلب من نتيجة العامل" ((Get-CashierRequestStatus $root $id).Status -eq "sent")
    $again = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc)
    Assert "دورة ثانية بلا تذاكر ⇒ لا طباعة" ($again.Count -eq 0 -and $script:prints.Count -eq 1)
    Assert "النتيجة لا تُستبدل" (-not (Write-CashierAgentResult $root $id ([pscustomobject]@{ Status = "failed"; Message = ""; Confirmation = "" })) -and (Read-CashierAgentResult $root $id).Status -eq "sent")

    # ── الرفض: مالك غير مسموح، تذكرة مشوّهة، امتداد آخر ──────────────────────
    $script:prints.Clear()
    $root = New-AgentRoot
    $idOther = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 10 "2026-10-24" $idOther "OZK2026")
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerOther)
    Assert "تذكرة يملكها حساب غير مسموح ⇒ rejected بلا طباعة" ($out[0].Status -eq "rejected" -and $out[0].Reason -eq "owner_not_allowed" -and $script:prints.Count -eq 0)
    Assert "نتيجة الرفض تُكتب" ((Read-CashierAgentResult $root $idOther).Status -eq "rejected")
    Assert "التذكرة المرفوضة تُنقل إلى rejected" (@(Get-ChildItem -LiteralPath (Get-CashierAgentPaths $root).Rejected -File).Count -eq 1)
    $idBad = [guid]::NewGuid().ToString()
    [IO.File]::WriteAllText((Get-TicketPath $root $idBad), '{"requestId":"' + $idBad + '","invoiceNumber":1}')
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc)
    Assert "تذكرة ناقصة الحقول ⇒ rejected/malformed بلا طباعة" ($out[0].Status -eq "rejected" -and $out[0].Reason -eq "malformed" -and $script:prints.Count -eq 0)
    [IO.File]::WriteAllText((Join-Path (Get-CashierAgentPaths $root).Inbox "evil.ps1"), "x")
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc)
    Assert "ملف بامتداد آخر في inbox يُبعد بلا تنفيذ" ($script:prints.Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path (Get-CashierAgentPaths $root).Inbox "evil.ps1")))
    $idErr = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 10 "2026-10-24" $idErr "OZK2026")
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner { param($p) throw "acl" })
    Assert "تعذّر قراءة المالك ⇒ rejected بلا طباعة" ($out[0].Status -eq "rejected" -and $script:prints.Count -eq 0)

    # ── لا تعديل للتذكرة بعد استلامها ────────────────────────────────────────
    # كاتب ما زال يمسك التذكرة (يسمح بالنقل) ⇒ لا يُفتح مقبض الاستلام ⇒ رفض بلا طباعة.
    $idBusy = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 13 "2026-10-24" $idBusy "OZK2026")
    $writer = New-Object IO.FileStream((Get-TicketPath $root $idBusy), [IO.FileMode]::Open, [IO.FileAccess]::Write, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc) } finally { $writer.Dispose() }
    Assert "تذكرة يمسكها كاتب عند الاستلام ⇒ rejected/ticket_busy بلا طباعة" ($out.Count -eq 1 -and $out[0].Reason -eq "ticket_busy" -and $script:prints.Count -eq 0)
    # مقبض الاستلام يمنع أي فتح للكتابة أو الحذف ما دام مفتوحاً، والقراءة من النسخة المقروءة نفسها.
    $idHold = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 14 "2026-10-24" $idHold "OZK2026")
    $hold = Open-CashierAgentTicketHold (Get-TicketPath $root $idHold)
    try {
        Assert "مقبض الاستلام يمنع الفتح للكتابة" (Throws { (New-Object IO.FileStream((Get-TicketPath $root $idHold), [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)).Dispose() })
        Assert "مقبض الاستلام يمنع الحذف" (Throws { [IO.File]::Delete((Get-TicketPath $root $idHold)) ; if (-not (Test-Path -LiteralPath (Get-TicketPath $root $idHold))) { throw "deleted" } })
        $t = Read-CashierAgentTicketStream $hold
        Assert "التذكرة تُقرأ من مقبض الاستلام" ($t.InvoiceNumber -eq 14 -and $t.RequestId -eq $idHold)
    } finally { $hold.Dispose() }
    # الطباعة من النسخة المقروءة: تعديل الملف في processing أثناء الطباعة لا يغيّر ما يُطبع.
    $script:tamperRoot = $root
    $tamperPrint = {
        param($n, $d, $id, $from)
        $f = Join-Path (Get-CashierAgentPaths $script:tamperRoot).Processing (([guid]$id).ToString("N") + ".json")
        [IO.File]::WriteAllText($f, '{"requestId":"' + $id + '","invoiceNumber":999,"invoiceDate":"2026-10-24","requestedFrom":"OZK2026","createdAt":"x"}')
        $script:prints.Add([pscustomobject]@{ Number = $n; Date = $d; RequestId = $id; From = $from })
        return [pscustomobject]@{ Status = "sent"; Message = "ok"; Confirmation = "spooler_completed" }
    }
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $tamperPrint -GetOwner $ownerSvc)
    Assert "تعديل التذكرة بعد قراءتها لا أثر له على الطباعة" ($script:prints.Count -eq 1 -and @($script:prints | Where-Object { $_.Number -eq 999 }).Count -eq 0 -and $script:prints[0].Number -eq 14)

    # ── مهلة الالتقاط وانحراف الساعة ─────────────────────────────────────────
    $root = New-AgentRoot
    $idOld = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 11 "2026-10-24" $idOld "OZK2026")
    $later = { [datetime]::UtcNow.AddSeconds(25) }
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc -Clock $later)
    Assert "تذكرة تجاوزت مهلة الالتقاط ⇒ expired بلا طباعة" ($out[0].Status -eq "expired" -and $script:prints.Count -eq 0)
    Assert "حالة الطلب المنتهي expired (لم يُطبع)" ((Get-CashierRequestStatus $root $idOld).Status -eq "expired")
    $idFuture = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 12 "2026-10-24" $idFuture "OZK2026")
    $earlier = { [datetime]::UtcNow.AddSeconds(-60) }
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc -Clock $earlier)
    Assert "ساعة متأخرة عن إنشاء التذكرة ⇒ rejected/clock_skew" ($out[0].Status -eq "rejected" -and $out[0].Reason -eq "clock_skew" -and $script:prints.Count -eq 0)

    # ── منع التكرار عبر الحجز الحقيقي ────────────────────────────────────────
    $root = New-AgentRoot
    $bridge.Runs = 0
    $real = New-RealPrint $root $cfg
    $idDup = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 2682 "2026-10-24" $idDup "OZK2026")
    $first = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $real -GetOwner $ownerSvc)
    [void](New-CashierAgentTicket $root 2682 "2026-10-24" $idDup "OZK2026")  # تذكرة مكررة تتجاوز فحص Serve
    $second = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $real -GetOwner $ownerSvc)
    Assert "المعرّف نفسه مرتين ⇒ طباعة واحدة، والثانية duplicate_request" ($first[0].Status -eq "sent" -and $second[0].Status -eq "duplicate_request" -and $bridge.Runs -eq 1)
    Assert "النتيجة الأولى تبقى sent" ((Read-CashierAgentResult $root $idDup).Status -eq "sent")
    $log = @(Read-CashierReprintLog $root | Where-Object { $_.event -eq "reprint_sent" })
    Assert "السجل يحفظ الجهاز الطالب الأصلي" ($log.Count -eq 1 -and $log[0].requestedFrom -eq "OZK2026")

    # ── الاستعادة بعد انقطاع الكهرباء ────────────────────────────────────────
    $root = New-AgentRoot
    $paths = Get-CashierAgentPaths $root
    $idA = [guid]::NewGuid().ToString(); $idB = [guid]::NewGuid().ToString(); $idC = [guid]::NewGuid().ToString()
    foreach ($x in @($idA, $idB, $idC)) {
        [void](New-CashierAgentTicket $root 2682 "2026-10-24" $x "OZK2026")
        [IO.File]::Move((Get-TicketPath $root $x), (Join-Path $paths.Processing (([guid]$x).ToString("N") + ".json")))
    }
    [void](Register-CashierReprintRequest $root $idB 2682 "2026-10-24")                       # حُجز ثم انقطع
    [void](Register-CashierReprintRequest $root $idC 2682 "2026-10-24")                       # طُبع ثم انقطع قبل النتيجة
    [void](Write-CashierReprintLog $root ([pscustomobject]@{ event = "reprint_sent"; requestId = $idC; confirmation = "spooler_completed" }))
    $idStale = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 2682 "2026-10-24" $idStale "OZK2026")               # بقيت في inbox حتى الإقلاع
    $bridge.Runs = 0
    $recovered = @(Restore-CashierAgentState $root)
    Assert "الاستعادة تحسم كل تذاكر processing" ($recovered.Count -eq 3 -and @(Get-ChildItem -LiteralPath $paths.Processing -File).Count -eq 0)
    Assert "انقطاع قبل الحجز ⇒ failed (لم يُطبع يقيناً)" ((Read-CashierAgentResult $root $idA).Status -eq "failed")
    Assert "انقطاع بعد الحجز وقبل النتيجة ⇒ uncertain" ((Read-CashierAgentResult $root $idB).Status -eq "uncertain")
    Assert "انقطاع بعد الطباعة ⇒ النتيجة من السجل (sent)" ((Read-CashierAgentResult $root $idC).Status -eq "sent")
    Assert "uncertain يُسجَّل في السجل" (@(Read-CashierReprintLog $root | Where-Object { $_.event -eq "reprint_uncertain" -and $_.requestId -eq $idB }).Count -eq 1)
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print (New-RealPrint $root $cfg) -GetOwner $ownerSvc -Clock { [datetime]::UtcNow.AddMinutes(10) })
    Assert "تذكرة inbox قديمة بعد الإقلاع ⇒ expired" ($out.Count -eq 1 -and $out[0].Status -eq "expired")
    Assert "لا طباعة إطلاقاً أثناء الاستعادة" ($bridge.Runs -eq 0)
    Assert "الاستعادة الثانية لا تفعل شيئاً" (@(Restore-CashierAgentState $root).Count -eq 0)

    # خطأ غير متوقع من الطباعة نفسها: الحكم من الحجز.
    $root = New-AgentRoot
    $idX = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 1 "2026-10-24" $idX "OZK2026")
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print { param($n, $d, $i, $f) throw "boom" } -GetOwner $ownerSvc)
    Assert "استثناء قبل الحجز ⇒ failed" ($out[0].Status -eq "failed")
    $idY = [guid]::NewGuid().ToString()
    [void](New-CashierAgentTicket $root 1 "2026-10-24" $idY "OZK2026")
    $script:rootY = $root
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print { param($n, $d, $i, $f) [void](Register-CashierReprintRequest $script:rootY $i $n $d); throw "boom" } -GetOwner $ownerSvc)
    Assert "استثناء بعد الحجز ⇒ uncertain" ($out[0].Status -eq "uncertain")

    # ── جهة Serve (حساب الخدمة) ──────────────────────────────────────────────
    $root = New-AgentRoot
    $idS = [guid]::NewGuid().ToString()
    $r = Submit-CashierAgentPrint -Config $cfg -Root $root -Number 2682 -Date "2026-10-24" -RequestId $idS -RequestedFrom "OZK2026" -Sleep { }
    Assert "بلا نبضة عامل ⇒ agent_unavailable ولا تذكرة" ($r.Status -eq "agent_unavailable" -and -not (Test-Path -LiteralPath (Get-TicketPath $root $idS)))
    Write-CashierAgentHeartbeat $root
    $r = Submit-CashierAgentPrint -Config $cfg -Root $root -Number 2682 -Date "2026-10-24" -RequestId $idS -RequestedFrom "OZK2026" -Clock { [datetime]::UtcNow.AddSeconds(60) } -Sleep { }
    Assert "نبضة قديمة ⇒ agent_unavailable" ($r.Status -eq "agent_unavailable")

    $script:prints.Clear()
    $script:agentRoot = $root; $script:agentCfg = $cfg
    $r = Submit-CashierAgentPrint -Config $cfg -Root $root -Number 2682 -Date "2026-10-24" -RequestId $idS -RequestedFrom "OZK2026" `
        -Sleep { [void](Invoke-CashierAgentPass -Config $script:agentCfg -Root $script:agentRoot -Print $script:printStub -GetOwner $script:ownerSvc) }
    Assert "Serve يكتب تذكرة والعامل يطبع ⇒ النتيجة تعود sent" ($r.Status -eq "sent" -and $r.Confirmation -eq "spooler_completed" -and $script:prints.Count -eq 1)
    $r = Submit-CashierAgentPrint -Config $cfg -Root $root -Number 2682 -Date "2026-10-24" -RequestId $idS -RequestedFrom "OZK2026" -Sleep { }
    Assert "المعرّف نفسه من جديد ⇒ duplicate_request بلا تذكرة" ($r.Status -eq "duplicate_request" -and $script:prints.Count -eq 1)

    $idE = [guid]::NewGuid().ToString()
    $script:tick = 0
    $clock = { [datetime]::UtcNow.AddSeconds($script:tick) }
    $r = Submit-CashierAgentPrint -Config $cfg -Root $root -Number 2682 -Date "2026-10-24" -RequestId $idE -RequestedFrom "OZK2026" -Clock $clock -Sleep { $script:tick += 5 }
    Assert "العامل لم يلتقط التذكرة ضمن المهلة ⇒ expired" ($r.Status -eq "expired" -and (Test-Path -LiteralPath (Get-TicketPath $root $idE)))
    $out = @(Invoke-CashierAgentPass -Config $cfg -Root $root -Print $printStub -GetOwner $ownerSvc -Clock { [datetime]::UtcNow.AddSeconds(30) })
    Assert "العامل حين يعود يرفض التذكرة نفسها ⇒ لا طباعة بعد إبلاغ expired" ($out[0].Status -eq "expired" -and $script:prints.Count -eq 1)

    $idP = [guid]::NewGuid().ToString()
    $script:tick = 0
    $script:pRoot = $root
    $claimOnly = {
        $script:tick += 10
        $p = Join-Path (Get-CashierAgentPaths $script:pRoot).Inbox ("*.json")
        foreach ($f in @(Get-ChildItem -Path $p -File)) { [IO.File]::Move($f.FullName, (Join-Path (Get-CashierAgentPaths $script:pRoot).Processing $f.Name)) }
    }
    $r = Submit-CashierAgentPrint -Config $cfg -Root $root -Number 2682 -Date "2026-10-24" -RequestId $idP -RequestedFrom "OZK2026" -Clock $clock -Sleep $claimOnly
    Assert "التقطها العامل ولم تصل النتيجة ⇒ in_progress (لا افتراض)" ($r.Status -eq "in_progress")
    Assert "حالة طلب في processing ⇒ in_progress" ((Get-CashierRequestStatus $root $idP).Status -eq "in_progress")
    Assert "حالة معرّف عشوائي ⇒ not_received" ((Get-CashierRequestStatus $root ([guid]::NewGuid().ToString())).Status -eq "not_received")

    # ── النسخة الواحدة من العامل (Mode Agent عبر سطر الأوامر) ───────────────
    $cliRoot = New-AgentRoot
    Copy-Item -LiteralPath (Write-ConfigFile @{ printDispatch = "agent"; agentRequesterSids = @($SVC) }) -Destination (Join-Path $cliRoot "config.json")
    $exe = "powershell.exe"
    if ($PSVersionTable.PSEdition -eq "Core") { $exe = (Get-Process -Id $PID).Path }
    $cli = Join-Path $toolDir "cashier-reprint.ps1"
    $json = (& $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $cli -Mode Agent -Once -Root $cliRoot | Select-Object -Last 1) | ConvertFrom-Json
    Assert "Mode Agent -Once يعمل ويكتب النبضة" ($json.Status -eq "ok" -and (Get-CashierAgentHeartbeatAge $cliRoot) -ge 0)
    # Mutex باسم Global\ آخر لا يعطّل العامل (قفله ملف داخل processing\ لا Mutex عام).
    $foreign = New-Object Threading.Mutex($false, "Global\OZK-CashierReprint-Agent")
    [void]$foreign.WaitOne(0)
    try {
        $json = (& $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $cli -Mode Agent -Once -Root $cliRoot | Select-Object -Last 1) | ConvertFrom-Json
        Assert "حجز Mutex العام القديم لا يعطّل العامل" ($json.Status -eq "ok")
    } finally { $foreign.ReleaseMutex(); $foreign.Dispose() }
    $agentLock = Open-CashierAgentLock $cliRoot
    try {
        Assert "قفل العامل في processing" ($null -ne $agentLock -and $agentLock.Name -eq (Get-CashierAgentPaths $cliRoot).Lock)
        Assert "القفل لا يُفتح مرتين" ($null -eq (Open-CashierAgentLock $cliRoot))
        $json = (& $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $cli -Mode Agent -Once -Root $cliRoot | Select-Object -Last 1) | ConvertFrom-Json
        Assert "نسخة ثانية من العامل ترفض العمل" ($json.Status -eq "agent_already_running")
    } finally { if ($null -ne $agentLock) { $agentLock.Dispose() } }
    Assert "الاستعادة تتجاهل ملف القفل" (@(Restore-CashierAgentState $cliRoot).Count -eq 0 -and (Test-Path -LiteralPath (Get-CashierAgentPaths $cliRoot).Lock))
    Copy-Item -Force -LiteralPath (Write-ConfigFile @{}) -Destination (Join-Path $cliRoot "config.json")
    $json = (& $exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $cli -Mode Agent -Once -Root $cliRoot | Select-Object -Last 1) | ConvertFrom-Json
    Assert "Mode Agent مع printDispatch=direct يُرفض" ($json.Status -eq "error")
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
# العامل في الاختبارات أعلاه يخرج بـ1 عن قصد (نسخة ثانية/إعداد مرفوض)، فيبقى $LASTEXITCODE=1 وتعدّه CI فشلاً.
exit 0
