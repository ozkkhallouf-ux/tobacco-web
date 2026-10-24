# اختبار «إعادة طباعة فاتورة كاشير» (tools/cashier-reprint) تحت Windows PowerShell 5.1 وPowerShell 7.
# بلا اتصال بالأمين ولا طابعة حقيقية: صفوف الأمين مصطنعة، والجسر دالة وهمية (وعلى Windows
# سكربت جسر وهمي حقيقي يُشغَّل بـpowershell.exe للتحقق من الوسائط). كل الملفات في مجلد مؤقت.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolDir = Join-Path $repoRoot "tools\cashier-reprint"
if (-not (Test-Path -LiteralPath $toolDir)) { $toolDir = Join-Path $repoRoot "tools/cashier-reprint" }
. (Join-Path $toolDir "cashier-reprint-lib.ps1")

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }

$RETAIL = "cc1097b1-662d-4d80-8e4e-3b493249591c"
$WHOLESALE = "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4"
function New-Row([string]$Guid, [int]$Number, [string]$Date, [string]$Type = $RETAIL, [bool]$Posted = $true, [int]$RecState = 0, [string]$TypeName = "مبيعات مركز") {
    return [pscustomobject]@{
        InvoiceGuid = $Guid; InvoiceNumber = $Number; TypeGuid = $Type; TypeName = $TypeName; BillType = 1
        InvoiceDate = $Date; CreateDate = [datetime]"$Date 10:00:00"; IsPosted = $Posted; RecordState = $RecState
        Total = 12.5; CustomerName = "زبون تجريبي سري"
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("cashier-reprint-test-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $tempRoot -Force)
$fakeBridge = Join-Path $tempRoot "fake-bridge.ps1"
$okOutput = "`r`nEvent           : manual_reprint_submitted`r`nInvoiceNumber   : 501`r`nPrinter         : XPRINTER XP-T80Q 80MM`r`nJobId           : 77`r`n"
[IO.File]::WriteAllText($fakeBridge, "param() 'fake'", (New-Object Text.UTF8Encoding($true)))
$fakeHash = Get-CashierFileSha256 $fakeBridge

function New-TestConfig([string]$Bridge = $fakeBridge, [string]$Hash = $fakeHash) {
    $path = Join-Path $tempRoot ("config-" + [guid]::NewGuid().ToString("N") + ".json")
    $json = [pscustomobject]@{ bridgeScriptPath = $Bridge; expectedBridgeSha256 = $Hash; printerName = "XPRINTER XP-T80Q 80MM"; bridgeTimeoutSeconds = 60 } | ConvertTo-Json
    [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
    return (Read-CashierReprintConfig $path)
}
function New-Root { $r = Join-Path $tempRoot ("root-" + [guid]::NewGuid().ToString("N")); [void](New-Item -ItemType Directory -Path $r -Force); return $r }

$script:runs = New-Object System.Collections.Generic.List[object]
function New-Runner([int]$ExitCode = 0, [string]$Output = $okOutput, [bool]$TimedOut = $false) {
    $e = $ExitCode; $o = $Output; $t = $TimedOut; $list = $script:runs
    return { param($c, $n, $d) $list.Add([pscustomobject]@{ Number = $n; Date = $d }); return [pscustomobject]@{ ExitCode = $e; Output = $o; TimedOut = $t } }.GetNewClosure()
}
function Invoke-Test($Rows, [int]$Number, [string]$Date = "", [string]$RequestId = ([guid]::NewGuid().ToString()), $Runner = (New-Runner), $Root = (New-Root), $Config = (New-TestConfig)) {
    $r = $Rows
    return (Invoke-CashierReprint -Config $Config -Root $Root -Number $Number -Date $Date -RequestId $RequestId -Lookup { param($n) return $r }.GetNewClosure() -Runner $Runner)
}

try {
    # ── الحسم ─────────────────────────────────────────────────────────────────
    $new = @(New-Row "a1" 501 "2026-10-24")
    $res = Resolve-CashierInvoice $new 501
    Assert "فاتورة جديدة واحدة ⇒ ok" ($res.Status -eq "ok" -and $res.Invoice.InvoiceGuid -eq "a1")

    $edited = @((New-Row "old1" 502 "2026-10-24" $RETAIL $true 1), (New-Row "new1" 502 "2026-10-24"))
    $res = Resolve-CashierInvoice $edited 502
    Assert "فاتورة معدّلة: النسخة المحذوفة تُستبعد والمرحّلة الحالية تُطبع" ($res.Status -eq "ok" -and $res.Invoice.InvoiceGuid -eq "new1")

    $old = @(New-Row "o1" 77 "2025-01-15")
    $res = Resolve-CashierInvoice $old 77
    Assert "فاتورة قديمة ⇒ ok بتاريخها الأصلي" ($res.Status -eq "ok" -and $res.Invoice.InvoiceDate -eq "2025-01-15")

    Assert "رقم غير موجود ⇒ not_found" ((Resolve-CashierInvoice @() 999).Status -eq "not_found")
    Assert "رقم صفر ⇒ invalid_input" ((Resolve-CashierInvoice @() 0).Status -eq "invalid_input")

    $twoDates = @((New-Row "d1" 600 "2026-10-24"), (New-Row "d2" 600 "2025-03-01"))
    $res = Resolve-CashierInvoice $twoDates 600
    Assert "الرقم نفسه بتاريخين ⇒ ambiguous مع التاريخين" ($res.Status -eq "ambiguous" -and @($res.Choices).Count -eq 2)
    $res = Resolve-CashierInvoice $twoDates 600 "2025-03-01"
    Assert "الملتبس مع تحديد التاريخ ⇒ ok للفاتورة الصحيحة" ($res.Status -eq "ok" -and $res.Invoice.InvoiceGuid -eq "d2")
    Assert "تاريخ لا يطابق ⇒ not_found" ((Resolve-CashierInvoice $twoDates 600 "2026-01-01").Status -eq "not_found")

    $sameDay = @((New-Row "s1" 601 "2026-10-24"), (New-Row "s2" 601 "2026-10-24"))
    $res = Resolve-CashierInvoice $sameDay 601
    Assert "تكرار بالرقم والتاريخ ⇒ ambiguous بلا خيارات (لا طباعة)" ($res.Status -eq "ambiguous" -and @($res.Choices).Count -eq 0)

    $wholesale = @(New-Row "w1" 700 "2026-10-24" $WHOLESALE $true 0 "مبيعات")
    $res = Resolve-CashierInvoice $wholesale 700
    Assert "رقم فاتورة جملة ⇒ not_cashier" ($res.Status -eq "not_cashier" -and $res.Message -match "مبيعات")
    $mixed = @((New-Row "w2" 701 "2026-10-24" $WHOLESALE $true 0 "مبيعات"), (New-Row "r2" 701 "2026-10-24"))
    Assert "رقم مشترك بين جملة وكاشير ⇒ الكاشير وحده" ((Resolve-CashierInvoice $mixed 701).Invoice.InvoiceGuid -eq "r2")
    Assert "فاتورة كاشير غير مرحّلة ⇒ not_posted" ((Resolve-CashierInvoice @(New-Row "u1" 702 "2026-10-24" $RETAIL $false) 702).Status -eq "not_posted")

    # ── الطباعة ───────────────────────────────────────────────────────────────
    $script:runs.Clear()
    $root = New-Root
    $out = Invoke-Test $new 501 -Root $root
    Assert "طباعة فاتورة جديدة ⇒ printed" ($out.Status -eq "printed" -and $script:runs.Count -eq 1)
    Assert "الجسر يُستدعى بتاريخ الفاتورة المحسوم" ($script:runs[0].Date -eq "2026-10-24" -and $script:runs[0].Number -eq 501)

    $script:runs.Clear()
    $rid = [guid]::NewGuid().ToString()
    $root = New-Root
    $first = Invoke-Test $new 501 -RequestId $rid -Root $root
    $retry = Invoke-Test $new 501 -RequestId $rid -Root $root
    Assert "إعادة محاولة تقنية بنفس المعرّف ⇒ duplicate_request بلا طباعة ثانية" ($first.Status -eq "printed" -and $retry.Status -eq "duplicate_request" -and $script:runs.Count -eq 1)
    $again = Invoke-Test $new 501 -Root $root
    Assert "طلب صريح جديد لفاتورة طُبعت ⇒ يُطبع (منع التكرار الآلي لا يمنعه)" ($again.Status -eq "printed" -and $script:runs.Count -eq 2)
    $last = Get-CashierLastReprint $root "a1"
    Assert "آخر طباعة يدوية تُقرأ من السجل للتنبيه" ($null -ne $last -and $last.host -eq $env:COMPUTERNAME)

    $script:runs.Clear()
    $out = Invoke-Test $edited 502
    Assert "فاتورة معدّلة تُطبع ببياناتها الحالية" ($out.Status -eq "printed" -and $out.Details.invoiceGuid -eq "new1")
    $out = Invoke-Test $old 77
    Assert "فاتورة قديمة تُطبع" ($out.Status -eq "printed" -and $script:runs[1].Date -eq "2025-01-15")

    $script:runs.Clear()
    foreach ($case in @(@{ Rows = @(); N = 999; S = "not_found" }, @{ Rows = $twoDates; N = 600; S = "ambiguous" }, @{ Rows = $sameDay; N = 601; S = "ambiguous" }, @{ Rows = $wholesale; N = 700; S = "not_cashier" })) {
        $out = Invoke-Test $case.Rows $case.N
        Assert "حالة $($case.S) للرقم $($case.N) ⇒ لا طباعة" ($out.Status -eq $case.S)
    }
    Assert "لا استدعاء للجسر في كل حالات الرفض" ($script:runs.Count -eq 0)

    $root = New-Root
    $out = Invoke-CashierReprint -Config (New-TestConfig) -Root $root -Number 501 -RequestId ([guid]::NewGuid().ToString()) `
        -Lookup { param($n) throw (New-Object System.InvalidOperationException "A network-related error occurred") } -Runner (New-Runner)
    Assert "فشل الاتصال بالأمين ⇒ connection_failed بلا طباعة" ($out.Status -eq "connection_failed" -and $script:runs.Count -eq 0)

    $out = Invoke-Test $new 501 -Runner (New-Runner 1 "Printer queue not found or ambiguous: XPRINTER XP-T80Q 80MM")
    Assert "الطابعة غير موجودة ⇒ failed (لم تخرج ورقة)" ($out.Status -eq "failed")
    $out = Invoke-Test $new 501 -Runner (New-Runner 1 "Exception calling: A network-related or instance-specific error occurred")
    Assert "فشل اتصال الجسر بالأمين ⇒ failed" ($out.Status -eq "failed")
    $out = Invoke-Test $new 501 -Runner (New-Runner 1 "WritePrinter failed with Win32 error 1784")
    Assert "فشل بعد بدء المهمة ⇒ uncertain" ($out.Status -eq "uncertain")
    $out = Invoke-Test $new 501 -Runner (New-Runner -1 "" $true)
    Assert "انتهاء المهلة ⇒ uncertain" ($out.Status -eq "uncertain")
    $out = Invoke-Test $new 501 -Runner (New-Runner 0 "done")
    Assert "نجاح بلا رقم مهمة ⇒ uncertain لا printed" ($out.Status -eq "uncertain")

    $script:runs.Clear()
    $out = Invoke-Test $new 501 -Config (New-TestConfig $fakeBridge ("0" * 64))
    Assert "نسخة جسر غير معتمدة ⇒ blocked بلا طباعة" ($out.Status -eq "blocked" -and $script:runs.Count -eq 0)
    $out = Invoke-Test $new 501 -Config (New-TestConfig (Join-Path $tempRoot "missing.ps1") $fakeHash)
    Assert "جسر غير موجود ⇒ blocked" ($out.Status -eq "blocked")

    $root = New-Root
    $lock = Enter-CashierInvoiceLock $root "a1"
    $out = Invoke-Test $new 501 -Root $root
    $lock.Dispose()
    Assert "طلب متزامن لنفس الفاتورة ⇒ busy" ($out.Status -eq "busy" -and $script:runs.Count -eq 0)
    $out = Invoke-Test $new 501 -Root $root
    Assert "بعد تحرير القفل ⇒ يُطبع" ($out.Status -eq "printed")

    Assert "معرّف طلب غير صالح ⇒ خطأ" (Throws { Invoke-Test $new 501 -RequestId "not-a-guid" })

    # ── السجل ────────────────────────────────────────────────────────────────
    $entries = @(Read-CashierReprintLog $root)
    $printed = @($entries | Where-Object { $_.event -eq "reprint_printed" })
    Assert "السجل يحفظ الرقم والتاريخ والجهاز والمستخدم والوقت ومعرّف الطلب" ($printed.Count -eq 1 -and $printed[0].invoiceNumber -eq 501 -and $printed[0].invoiceDate -eq "2026-10-24" -and $printed[0].host -eq $env:COMPUTERNAME -and $printed[0].at -and $printed[0].requestId -and $printed[0].jobId -eq 77)
    Assert "السجل يحفظ المحاولات المرفوضة أيضاً" (@($entries | Where-Object { $_.event -eq "reprint_busy" }).Count -eq 1)
    $logText = [IO.File]::ReadAllText((Join-Path $root "logs\manual-reprints.jsonl".Replace("\", [IO.Path]::DirectorySeparatorChar)))
    Assert "السجل بلا اسم زبون ولا مبالغ" ($logText -notmatch "زبون تجريبي سري" -and $logText -notmatch "12\.5")

    # ── الحراس ───────────────────────────────────────────────────────────────
    Assert "استعلام البحث يمر بحارس القراءة" (-not (Throws { Assert-CashierSelectOnly $script:CashierInvoiceLookupSql }))
    Assert "استعلام فحص الحساب يمر بحارس القراءة" (-not (Throws { Assert-CashierSelectOnly $script:CashierPrincipalProbeSql }))
    Assert "UPDATE مرفوض" (Throws { Assert-CashierSelectOnly "update dbo.bu000 set Number = 1" })
    Assert "عبارتان مرفوضتان" (Throws { Assert-CashierSelectOnly "select 1; delete from dbo.bu000" })
    Assert "select into مرفوض" (Throws { Assert-CashierSelectOnly "select * into x from dbo.bu000" })
    Assert "exec مرفوض" (Throws { Assert-CashierSelectOnly "select 1 exec sp_who" })
    Assert "طابعة غير XPRINTER مرفوضة في الإعداد" (Throws {
        $p = Join-Path $tempRoot "bad.json"
        [IO.File]::WriteAllText($p, '{"bridgeScriptPath":"x","expectedBridgeSha256":"' + $fakeHash + '","printerName":"Canon G3410 (auto)"}')
        Read-CashierReprintConfig $p
    })
    $o = Get-CashierBridgeOutcome 0 $okOutput $false
    Assert "قراءة JobId من خرج الجسر" ($o.Outcome -eq "printed" -and $o.JobId -eq 77)

    $libText = [IO.File]::ReadAllText((Join-Path $toolDir "cashier-reprint-lib.ps1"))
    $code = ($libText -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    Assert "الأداة لا تمرّر -StatePath ولا تلمس state.json" ($code -notmatch 'StatePath' -and $code -notmatch 'state\.json')
    Assert "الأداة تستدعي الجسر بوضع PrintInvoice ونوع Retail حصراً" ($code -match '"-Mode", "PrintInvoice"' -and $code -match '"-InvoiceType", "Retail"' -and $code -notmatch 'Observe' -and $code -notmatch 'IncludeWholesale')

    # ── تشغيل حقيقي لسكربت جسر وهمي (Windows فقط) ──────────────────────────────
    if ($env:OS -eq "Windows_NT") {
        $argsFile = Join-Path $tempRoot "bridge-args.txt"
        $bridge2 = Join-Path $tempRoot "fake-bridge-2.ps1"
        $body = 'param([string]$Mode,[string]$InvoiceType,[int]$InvoiceNumber,[string]$InvoiceDate,[string]$PrinterName,[switch]$ConfirmPhysicalPrint)' + "`r`n" +
            ('Set-Content -LiteralPath "{0}" -Value ("$Mode|$InvoiceType|$InvoiceNumber|$InvoiceDate|$PrinterName|$ConfirmPhysicalPrint")' -f $argsFile) + "`r`n" +
            '[pscustomobject]@{ Event = "manual_reprint_submitted"; InvoiceNumber = $InvoiceNumber; InvoiceDate = $InvoiceDate; InvoiceType = $InvoiceType; Printer = $PrinterName; JobId = 91; At = "x"; CustomerAndItemsRedacted = $true }'
        [IO.File]::WriteAllText($bridge2, $body, (New-Object Text.UTF8Encoding($true)))
        $cfg2 = New-TestConfig $bridge2 (Get-CashierFileSha256 $bridge2)
        $out = Invoke-CashierReprint -Config $cfg2 -Root (New-Root) -Number 501 -RequestId ([guid]::NewGuid().ToString()) `
            -Lookup { param($n) return @(New-Row "a1" 501 "2026-10-24") } -Runner { param($c, $n, $d) Invoke-CashierBridgeProcess $c $n $d }
        $seen = (Get-Content -LiteralPath $argsFile -Raw).Trim()
        Assert "جسر حقيقي: الوسائط PrintInvoice|Retail|الرقم|التاريخ|XPRINTER|تأكيد" ($seen -eq "PrintInvoice|Retail|501|2026-10-24|XPRINTER XP-T80Q 80MM|True")
        Assert "جسر حقيقي: النتيجة printed برقم المهمة" ($out.Status -eq "printed" -and $out.Details.jobId -eq 91)
    } else {
        Write-Host "SKIP تشغيل الجسر الوهمي الحقيقي (يحتاج Windows)"
    }
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
