# مسار إعادة طباعة إيصال الكاشير عبر تعريف Windows (printTransport=driver) — Windows PowerShell 5.1 وPowerShell 7.
# بلا طباعة ورقية وبلا طابعة الكاشير. يثبت:
#   1) مسار RAW لم يتغيّر: الرسّام الجديد = رسّام main (b2865472) + كتلة مسار التعريف + أسطر التفرّع المعدودة فقط.
#   2) الإعداد: raw افتراضي؛ driver يتطلب جهاز الطابعة وبصمة رسّام؛ قيمة مجهولة مرفوضة.
#   3) الأداة تمرّر OZK_RECEIPT_TRANSPORT للعملية الفرعية وحدها، وتزيل الموروث منه في raw.
#   4) رسّام قديم لا يدعم المسار + driver ⇒ blocked بلا تشغيل الجسر (لا طباعة RAW صامتة).
#   5) النتائج: نجاح مع تأكيد المسار، نجاح بلا تأكيد (تنبيه بلا إعادة إرسال)، رفض قبل المهمة ⇒ failed،
#      فشل بعد بدء المهمة أو مهلة ⇒ uncertain. الجسر يُستدعى مرة واحدة في كل حالة، والمعرّف المكرر مرفوض.
#   6) على Windows: صفوف التعريف = صفوف RAW بالبت لإيصالات 7 و45 و60 سطراً؛ استدعاء GDI نفسه (StretchDIBits
#      بالترويسة نفسها 1:1) لا يغيّر بتاً؛ فحص الصفحة يرفض الدقة/الإزاحة/القص؛ وتعريف حقيقي غير Xprinter
#      (Microsoft Print to PDF إن وُجد) يرفض قبل إنشاء أي مهمة.
# كل مقارنة تتحقق أن ما يُقارَن غير فارغ.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolDir = Join-Path (Join-Path $repoRoot "tools") "cashier-reprint"
. (Join-Path $toolDir "cashier-reprint-lib.ps1")
$renderer = Join-Path (Join-Path (Join-Path $toolDir "static-bridge") "ozk-print-bridge") "OzkReceiptRenderer.psm1"
$goldenDir = Join-Path (Join-Path $repoRoot "ozk-print-bridge") "__golden__"
$golden = Join-Path $goldenDir "OzkReceiptRenderer.reprint-b2865472.psm1"
$liveGolden = Join-Path $goldenDir "OzkReceiptRenderer.live-f7806b56.psm1"
$logo = Join-Path (Join-Path (Join-Path $repoRoot "ozk-print-bridge") "assets") "ozk-receipt-horse-logo.png"
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME = "TESTHOST" }
if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { $env:SystemRoot = [IO.Path]::GetTempPath() }

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }
function ErrorOf([scriptblock]$Block) { try { & $Block; return "" } catch { return [string]$_.Exception.Message } }
function Same([byte[]]$A, [byte[]]$B) {
    if ($null -eq $A -or $null -eq $B -or $A.Length -ne $B.Length -or $A.Length -eq 0) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
    return $true
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("reprint-driver-test-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $tempRoot -Force)
$savedTransport = $env:OZK_RECEIPT_TRANSPORT
try {
    # ── 1) مسار RAW لم يتغيّر ──────────────────────────────────────────────────
    Assert "المرجع: رسّام main بالبايت (b2865472)" ((Get-CashierFileSha256 $golden) -eq "b2865472b19f747d9f811733b0072a3af324af5dd393d2becc3ed5c05ff50d11")
    $newText = ([IO.File]::ReadAllText($renderer) -replace "`r`n", "`n").TrimStart([char]0xFEFF)
    $oldText = ([IO.File]::ReadAllText($golden) -replace "`r`n", "`n").TrimStart([char]0xFEFF)
    $blockStart = $newText.IndexOf("# ── مسار اختياري: الطباعة عبر تعريف Windows")
    $blockEnd = $newText.IndexOf("`n`$script:ReceiptWidth = 576")
    Assert "كتلة مسار التعريف موجودة قبل ثوابت الرسم" ($blockStart -gt 0 -and $blockEnd -gt $blockStart)
    $outside = $newText.Substring(0, $blockStart) + $newText.Substring($blockEnd)
    $pool = @{}
    foreach ($l in ($oldText -split "`n")) { $k = $l.Trim(); if ($pool.ContainsKey($k)) { $pool[$k]++ } else { $pool[$k] = 1 } }
    $added = New-Object System.Collections.Generic.List[string]
    foreach ($l in ($outside -split "`n")) { $k = $l.Trim(); if ($pool.ContainsKey($k) -and $pool[$k] -gt 0) { $pool[$k]-- } else { $added.Add($k) } }
    $removed = @($pool.Keys | Where-Object { $pool[$_] -gt 0 -and $_ -ne "" })
    $allowedAdded = @(
        '$transport = Get-OzkReceiptTransport',
        'if ($transport -eq "driver") {',
        '$jobId = Send-OzkReceiptViaDriver ([OzkRawThermalPrinter]::ToEscPosRaster($bitmap, 190)) $PrinterName',
        '} else {', '}', '',
        'Write-Host ("OzkReceiptTransport: driver (job {0})" -f $jobId)',
        'return [pscustomobject]@{ Submitted = $true; PrinterName = $PrinterName; JobId = $jobId; Transport = "Windows driver (GDI)"; SubmittedAt = (Get-Date).ToString("o") }')
    $unexpected = @($added | Where-Object { -not $_.StartsWith("#") -and $allowedAdded -notcontains $_ })
    foreach ($u in $unexpected) { Write-Host "DIFF+ $u" }
    foreach ($u in $removed) { Write-Host "DIFF- $u" }
    Assert "لا سطر محذوف من رسّام main (المسافات البادئة فقط تغيّرت داخل التفرّع)" ($removed.Count -eq 0)
    Assert "كل سطر مضاف خارج الكتلة من أسطر التفرّع المعدودة ($($added.Count) سطراً)" ($unexpected.Count -eq 0 -and $added.Count -gt 0)
    $ast = [Management.Automation.Language.Parser]::ParseInput($newText, [ref]$null, [ref]$null)
    $send = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "Send-OzkReceiptToPrinter" }, $true) | Select-Object -First 1
    $branch = $send.FindAll({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq '$transport -eq "driver"' -and $null -ne $n.ElseClause }, $true) | Select-Object -First 1
    $rawStatements = @($branch.ElseClause.Statements | ForEach-Object { $_.Extent.Text })
    Assert "فرع RAW = سطرا main حرفياً (التقسيم 128 ثم Send RAW)" ($rawStatements.Count -eq 2 -and
        $rawStatements[0] -eq '$payload = ConvertTo-OzkBandedRaster ([OzkRawThermalPrinter]::ToEscPosRaster($bitmap, 190)) $script:ReceiptBandRows' -and
        $rawStatements[1] -eq '$jobId = [OzkRawThermalPrinter]::Send($PrinterName, $payload, "OZK Cashier Receipt 80mm")')
    Assert "اختيار المسار قبل فحص الطابور والرسم (قيمة مجهولة تُرفض قبل أي مهمة)" ($newText.IndexOf('$transport = Get-OzkReceiptTransport') -lt $newText.IndexOf('Assert-OzkPrinterQueueReady $PrinterName' + "`n" + '    $bitmap'))
    $block = $newText.Substring($blockStart, $blockEnd - $blockStart)
    Assert "الكتلة لا تُرسل بايتات للطابعة: لا WritePrinter ولا نوع بيانات RAW" ($block -cnotmatch 'WritePrinter|"RAW"')
    Assert "الصفحة 1:1: StretchDIBits بالأبعاد نفسها مصدراً وهدفاً" ($block -match 'StretchDIBits\(hdc, 0, 0, widthDots, rows, 0, 0, widthDots, rows')
    Assert "الإعداد المؤقت للمهمة وحدها: لا SetPrinter ولا تعديل لإعدادات الطابور" ($block -notmatch 'SetPrinter|DM_UPDATE|DocumentPropertiesW.*DM_UPDATE')
    Assert "الدوال المصدَّرة كما هي" ($newText -match '(?m)^Export-ModuleMember -Function New-OzkReceiptBitmap, Save-OzkReceiptPreview, Send-OzkReceiptToPrinter\s*$')

    # ── 2) الإعداد ─────────────────────────────────────────────────────────────
    $bridgeDir = Join-Path $tempRoot "bridge"
    [void](New-Item -ItemType Directory -Path (Join-Path $bridgeDir "ozk-print-bridge") -Force)
    $fakeBridge = Join-Path $bridgeDir "ozk-print-bridge.ps1"
    [IO.File]::WriteAllText($fakeBridge, "param() 'fake'", (New-Object Text.UTF8Encoding($true)))
    $fakeHash = Get-CashierFileSha256 $fakeBridge
    $rendererCopy = Join-Path (Join-Path $bridgeDir "ozk-print-bridge") "OzkReceiptRenderer.psm1"
    function New-Config([hashtable]$Extra) {
        $o = [ordered]@{ bridgeScriptPath = $fakeBridge; expectedBridgeSha256 = $fakeHash; printerName = "XPRINTER XP-T80Q 80MM"; bridgeTimeoutSeconds = 60 }
        foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
        $path = Join-Path $tempRoot ("cfg-" + [guid]::NewGuid().ToString("N") + ".json")
        [IO.File]::WriteAllText($path, (([pscustomobject]$o) | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        return (Read-CashierReprintConfig $path)
    }
    $pin = "1" * 64
    Assert "إعداد بلا printTransport ⇒ raw (السلوك الحالي)" ((New-Config @{}).printTransport -eq "raw")
    Assert "printTransport='Driver ' يُطبَّع إلى driver" ((New-Config @{ printTransport = "Driver "; expectedRendererSha256 = $pin }).printTransport -eq "driver")
    Assert "printTransport=driver بلا بصمة رسّام ⇒ رفض الإعداد" (Throws { New-Config @{ printTransport = "driver" } })
    Assert "printTransport بقيمة مجهولة ⇒ رفض الإعداد" (Throws { New-Config @{ printTransport = "pdf" } })
    $remoteMsg = ErrorOf { New-Config @{ mode = "remote"; printTransport = "driver"; expectedRendererSha256 = $pin; remoteHost = "h"; remoteUser = "u"; remoteExpectedHostName = "OZKUSER"; remoteKeyPath = "k"; remoteKnownHostsPath = "kh" } }
    Assert "printTransport=driver في الوضع البعيد ⇒ رفض (يُضبط على جهاز الطابعة)" ($remoteMsg -match "mode=local")

    # ── 3) المتغيّر للعملية الفرعية وحدها ──────────────────────────────────────
    $env:OZK_RECEIPT_TRANSPORT = "driver"
    $rawInfo = New-CashierBridgeStartInfo (New-Config @{}) 501 "2026-11-12"
    Assert "raw: يُزال OZK_RECEIPT_TRANSPORT الموروث من العملية الأم" (-not $rawInfo.EnvironmentVariables.ContainsKey("OZK_RECEIPT_TRANSPORT"))
    Remove-Item Env:\OZK_RECEIPT_TRANSPORT
    $drvInfo = New-CashierBridgeStartInfo (New-Config @{ printTransport = "driver"; expectedRendererSha256 = $pin }) 501 "2026-11-12"
    Assert "driver: OZK_RECEIPT_TRANSPORT=driver للعملية الفرعية" ($drvInfo.EnvironmentVariables["OZK_RECEIPT_TRANSPORT"] -eq "driver")
    Assert "driver: لا يُضبط في العملية الأم" ([string]::IsNullOrEmpty($env:OZK_RECEIPT_TRANSPORT))
    Assert "driver: وسائط الجسر كما هي (PrintInvoice، الطابعة، التأكيد)" ($drvInfo.Arguments -eq $rawInfo.Arguments -and $drvInfo.Arguments -match "-Mode PrintInvoice" -and $drvInfo.Arguments -match "-ConfirmPhysicalPrint")

    # ── 4) رسّام لا يدعم المسار ⇒ blocked بلا تشغيل الجسر ──────────────────────
    $root = Join-Path $tempRoot "root-old"; [void](New-Item -ItemType Directory -Path $root -Force)
    Copy-Item -LiteralPath $liveGolden -Destination $rendererCopy -Force
    $oldPinned = New-Config @{ printTransport = "driver"; expectedRendererSha256 = (Get-CashierFileSha256 $rendererCopy) }
    Assert "رسّام قديم مثبّت + driver ⇒ فحص الدعم يرفض" (Throws { Assert-CashierRendererSupportsTransport $oldPinned })
    $script:calls = 0
    $countingRunner = { param($c, $n, $d) $script:calls++; [pscustomobject]@{ ExitCode = 0; Output = "JobId : 9"; TimedOut = $false } }
    $row = [pscustomobject]@{ InvoiceGuid = "0f8fad5b-d9cb-469f-a165-70867728950e"; InvoiceNumber = 501; TypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"; TypeName = "مبيعات مركز"; BillType = 1
        InvoiceDate = "2026-11-12"; CreateDate = [datetime]"2026-11-12 10:00:00"; IsPosted = $true; RecordState = 0; Total = 12.5; CustomerName = "زبون تجريبي سري" }
    $out = Invoke-CashierReprint -Config $oldPinned -Root $root -Number 501 -RequestId ([guid]::NewGuid().ToString()) -Lookup { param($n) @($row) } -Runner $countingRunner -JobWatcher { param($c, $j) "spooler_completed" }
    Assert "رسّام قديم + driver ⇒ blocked ولم يُشغَّل الجسر" ($out.Status -eq "blocked" -and $script:calls -eq 0)
    Copy-Item -LiteralPath $renderer -Destination $rendererCopy -Force
    $newPinned = New-Config @{ printTransport = "driver"; expectedRendererSha256 = (Get-CashierFileSha256 $rendererCopy) }
    Assert "الرسّام الجديد مثبّت + driver ⇒ فحص الجاهزية يمر" (-not (Throws { [void](Assert-CashierBridgeReady $newPinned $root) }))
    Assert "raw لا يفحص دعم المسار (الرسّام القديم يبقى صالحاً)" (-not (Throws { Assert-CashierRendererSupportsTransport (New-Config @{}) }))

    # ── 5) النتائج بلا إعادة إرسال ──────────────────────────────────────────────
    $okOutput = "`r`nEvent           : manual_reprint_submitted`r`nInvoiceNumber   : 501`r`nJobId           : 77`r`n"
    function Run-Case($Config, [int]$Exit, [string]$Output, [bool]$TimedOut = $false, [string]$RequestId = ([guid]::NewGuid().ToString()), [string]$CaseRoot = "") {
        if (-not $CaseRoot) { $CaseRoot = Join-Path $tempRoot ("root-" + [guid]::NewGuid().ToString("N")); [void](New-Item -ItemType Directory -Path $CaseRoot -Force) }
        # GetNewClosure ينشئ نطاق script خاصاً، فالعدّاد قائمة ملتقطة لا متغيّر $script:.
        $calls = New-Object System.Collections.Generic.List[int]
        $e = $Exit; $o = $Output; $t = $TimedOut
        $runner = { param($c, $n, $d) $calls.Add($n); [pscustomobject]@{ ExitCode = $e; Output = $o; TimedOut = $t } }.GetNewClosure()
        $result = Invoke-CashierReprint -Config $Config -Root $CaseRoot -Number 501 -RequestId $RequestId -Lookup { param($n) @($row) } -BridgeCheck { param($c, $r) "hash" } -Runner $runner -JobWatcher { param($c, $j) "spooler_completed" }
        return [pscustomobject]@{ Result = $result; Calls = $calls.Count; Root = $CaseRoot }
    }
    $driverCfg = New-Config @{ printTransport = "driver"; expectedRendererSha256 = $pin }
    $c = Run-Case $driverCfg 0 ($okOutput + "OzkReceiptTransport: driver (job 77)`r`n")
    Assert "driver: نجاح مؤكد ⇒ sent، transport=driver، transportVerified، استدعاء واحد" ($c.Result.Status -eq "sent" -and $c.Result.Details.transport -eq "driver" -and $c.Result.Details.transportVerified -eq $true -and $c.Result.Details.jobId -eq 77 -and $c.Calls -eq 1)
    $c = Run-Case $driverCfg 0 $okOutput
    Assert "driver: رقم مهمة بلا تأكيد المسار ⇒ sent مع تنبيه، بلا إعادة إرسال" ($c.Result.Status -eq "sent" -and $c.Result.Details.transportVerified -eq $false -and $c.Result.Message -match "تنبيه" -and $c.Calls -eq 1)
    foreach ($msg in @("Driver paper not found or ambiguous: 80(72)mm x 3276mm", "Driver page refused: resolution 180x180 is not 203x203 dpi",
            "Driver page refused: receipt ink is 3600 dots tall but the page prints only 3000", "CreateDC failed with Win32 error 1801",
            "StartDoc failed with Win32 error 5", "Receipt transport not recognised: 'pdf' (expected raw or driver).", "DocumentProperties failed with Win32 error 87")) {
        $c = Run-Case $driverCfg 1 ("Exception: " + $msg)
        Assert "رفض قبل المهمة ⇒ failed (إعادة آمنة)، استدعاء واحد: $($msg.Substring(0, [math]::Min(40, $msg.Length)))" ($c.Result.Status -eq "failed" -and $c.Calls -eq 1)
    }
    $c = Run-Case $driverCfg 1 "Exception: Driver print failed after job 12 started (EndPage): The device is not connected"
    Assert "فشل بعد بدء المهمة ⇒ uncertain (افحص قبل الإعادة)، استدعاء واحد" ($c.Result.Status -eq "uncertain" -and $c.Calls -eq 1)
    $c = Run-Case $driverCfg 1 "Exception: Driver print failed after job 13 started (EndDoc): The printer is out of paper"
    Assert "فشل عند EndDoc ⇒ uncertain، استدعاء واحد" ($c.Result.Status -eq "uncertain" -and $c.Calls -eq 1)
    $c = Run-Case $driverCfg -1 "" $true
    Assert "انقطاع/مهلة ⇒ uncertain، استدعاء واحد" ($c.Result.Status -eq "uncertain" -and $c.Calls -eq 1)
    $c = Run-Case $driverCfg 1 "OpenPrinter failed with Win32 error 1801"
    Assert "الطابعة غير موجودة ⇒ failed، استدعاء واحد" ($c.Result.Status -eq "failed" -and $c.Calls -eq 1)
    $rid = [guid]::NewGuid().ToString()
    $first = Run-Case $driverCfg 0 ($okOutput + "OzkReceiptTransport: driver (job 77)") $false $rid
    $again = Run-Case $driverCfg 0 ($okOutput + "OzkReceiptTransport: driver (job 78)") $false $rid $first.Root
    Assert "المعرّف نفسه مرة ثانية ⇒ duplicate_request بلا تشغيل الجسر" ($first.Result.Status -eq "sent" -and $again.Result.Status -eq "duplicate_request" -and $again.Calls -eq 0)
    $c = Run-Case (New-Config @{}) 0 $okOutput
    Assert "raw: transport=raw ولا حقل transportVerified (سلوك السجل كما كان)" ($c.Result.Status -eq "sent" -and $c.Result.Details.transport -eq "raw" -and -not $c.Result.Details.PSObject.Properties["transportVerified"])
    $logText = [IO.File]::ReadAllText((Join-Path (Join-Path $first.Root "logs") "manual-reprints.jsonl"))
    Assert "السجل يحمل transport ولا يحمل اسم الزبون" ($logText -match '"transport":\s*"driver"' -and $logText -notmatch "زبون تجريبي سري")

    # ── 6) على Windows: الرسّام نفسه ──────────────────────────────────────────
    if ($env:OS -ne "Windows_NT") {
        Write-Host "SKIP الرسم وGDI والتعريف الحقيقي (Windows فقط)"
    } else {
        $module = Import-Module $renderer -Force -DisableNameChecking -PassThru
        $inModule = { param([scriptblock]$Block) & $module $Block }
        foreach ($case in @(@{ v = $null; e = "raw" }, @{ v = "raw"; e = "raw" }, @{ v = " DRIVER "; e = "driver" })) {
            if ($null -eq $case.v) { Remove-Item Env:\OZK_RECEIPT_TRANSPORT -ErrorAction SilentlyContinue } else { $env:OZK_RECEIPT_TRANSPORT = $case.v }
            Assert "OZK_RECEIPT_TRANSPORT='$($case.v)' ⇒ $($case.e)" ((& $module { Get-OzkReceiptTransport }) -eq $case.e)
        }
        $env:OZK_RECEIPT_TRANSPORT = "pdf"
        $bad = ErrorOf { & $module { Get-OzkReceiptTransport } }
        Assert "قيمة مجهولة ⇒ استثناء يُصنَّف not_printed" ($bad -match "Receipt transport not recognised" -and (Get-CashierBridgeOutcome 1 $bad $false).Outcome -eq "not_printed")
        $badSend = ErrorOf { Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath $logo -PrinterName "XPRINTER XP-T80Q 80MM" -ConfirmPhysicalPrint }
        Assert "Send مع قيمة مجهولة ⇒ يرفض قبل فحص الطابور والرسم" ($badSend -match "Receipt transport not recognised")
        Remove-Item Env:\OZK_RECEIPT_TRANSPORT

        function New-Mock([int]$Lines) {
            $items = @(1..$Lines | ForEach-Object { [ordered]@{ Name = ("صنف اختبار {0}" -f $_); Quantity = ($_ % 3 + 1); UnitPrice = (10000 + $_ * 100); Total = ($_ % 3 + 1) * (10000 + $_ * 100) } })
            $gross = 0.0; $qty = 0.0; foreach ($i in $items) { $gross += [double]$i.Total; $qty += [double]$i.Quantity }
            return [pscustomobject][ordered]@{
                Id = "syn-$Lines"; MerchantName = "مركز اختبار"; Subtitle = "اختبار"; CommercialRegister = "0000000000"; Phones = "0900000000"; CenterPhone = "0900000000"
                Address = "عنوان اختبار"; InvoiceNumber = 9000 + $Lines; Date = "2026/11/12"; Time = "12:00 PM"; CustomerName = "زبون اختبار"; Description = "-"; Lines = $items
                GrossTotal = $gross; Discount = 500.0; NetTotal = $gross - 500.0; Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = $gross - 500.0; BalanceFound = $true
                ItemCount = $Lines; TotalQuantity = $qty; SaleDescription = "اختبار"; CurrencyIso = "SYP"
            }
        }
        $warm = New-OzkReceiptBitmap -Receipt (New-Mock 3) -LogoPath $logo; $warm.Dispose()
        foreach ($n in 7, 45, 60) {
            $bmp = New-OzkReceiptBitmap -Receipt (New-Mock $n) -LogoPath $logo
            try {
                $height = $bmp.Height
                $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190)
            } finally { $bmp.Dispose() }
            $image = & $module { param($p) ConvertFrom-OzkEscPosRaster $p } $payload
            $banded = & $module { param($p) ConvertTo-OzkBandedRaster $p 128 } $payload
            # صفوف RAW كما تصل الطابعة: بيانات أوامر GS v 0 بعد التقسيم 128.
            $rawRows = New-Object IO.MemoryStream; $i = 10
            while ($i -lt $banded.Length - 4) { $w = $banded[$i + 4] + 256 * $banded[$i + 5]; $h = $banded[$i + 6] + 256 * $banded[$i + 7]; $rawRows.Write($banded, $i + 8, $w * $h); $i += 8 + $w * $h }
            $ink = [OzkDriverReceiptPrinter]::InkExtent($image.Raster, $image.BytesPerRow, $image.Rows)
            Assert "[$n سطراً] صفوف التعريف = ارتفاع الصورة ($height) وعرض 72 بايتاً" ($image.Rows -eq $height -and $image.BytesPerRow -eq 72 -and $height -gt 0)
            Assert "[$n سطراً] صفوف التعريف = صفوف RAW بالبت ($($image.Raster.Length) بايت)" (Same $image.Raster $rawRows.ToArray())
            $gdi = [OzkDriverReceiptPrinter]::RenderThroughGdi($image.Raster, $image.BytesPerRow, $image.Rows)
            Assert "[$n سطراً] StretchDIBits 1:1 بالترويسة نفسها لا يغيّر بتاً" (Same $gdi $image.Raster)
            Assert "[$n سطراً] الحبر داخل 576 نقطة وحتى آخر الصورة تقريباً (التذييل غير مقصوص)" ($ink[0] -gt 500 -and $ink[0] -le 576 -and $ink[1] -gt ($height - 80) -and $ink[1] -le $height)
            Assert "[$n سطراً] صفحة Xprinter 203dpi بطول 3276 مم (26,200 نقطة) تحمل الإيصال بلا رفض" ($null -eq [OzkDriverReceiptPrinter]::CheckPage(203, 203, 203, 576, 26200, 0, 0, $ink[0], $ink[1]))
            Assert "[$n سطراً] صفحة أقصر من الحبر بنقطة ⇒ رفض (لا قص)" ($null -ne [OzkDriverReceiptPrinter]::CheckPage(203, 203, 203, 576, $ink[1] - 1, 0, 0, $ink[0], $ink[1]))
        }
        # InkExtent على حالات حدّية
        $blank = New-Object byte[] (72 * 10)
        Assert "InkExtent: صفحة بيضاء ⇒ 0,0" ((([OzkDriverReceiptPrinter]::InkExtent($blank, 72, 10)) -join ",") -eq "0,0")
        $one = New-Object byte[] (72 * 10); $one[0] = 0x80
        Assert "InkExtent: نقطة (0,0) ⇒ 1,1" ((([OzkDriverReceiptPrinter]::InkExtent($one, 72, 10)) -join ",") -eq "1,1")
        $edge = New-Object byte[] (72 * 10); $edge[9 * 72 + 71] = 0x01
        Assert "InkExtent: نقطة (575,9) ⇒ 576,10" ((([OzkDriverReceiptPrinter]::InkExtent($edge, 72, 10)) -join ",") -eq "576,10")
        $mid = New-Object byte[] (72 * 10); $mid[3 * 72 + 10] = 0x10
        Assert "InkExtent: نقطة (83,3) ⇒ 84,4" ((([OzkDriverReceiptPrinter]::InkExtent($mid, 72, 10)) -join ",") -eq "84,4")
        Assert "InkExtent: حجم لا يطابق الصفوف ⇒ رفض" (Throws { [OzkDriverReceiptPrinter]::InkExtent($blank, 72, 11) })
        # CheckPage: كل سبب رفض
        Assert "CheckPage: دقة 180 ⇒ رفض (تحجيم)" ([string]([OzkDriverReceiptPrinter]::CheckPage(180, 180, 203, 576, 26200, 0, 0, 560, 1000)) -match "resolution")
        Assert "CheckPage: دقة غير متساوية 203x406 ⇒ رفض" ([string]([OzkDriverReceiptPrinter]::CheckPage(203, 406, 203, 576, 26200, 0, 0, 560, 1000)) -match "resolution")
        Assert "CheckPage: إزاحة أفقية 8 ⇒ رفض (هامش إضافي)" ([string]([OzkDriverReceiptPrinter]::CheckPage(203, 203, 203, 576, 26200, 8, 0, 560, 1000)) -match "printable area")
        Assert "CheckPage: إزاحة رأسية 1 ⇒ رفض" ([string]([OzkDriverReceiptPrinter]::CheckPage(203, 203, 203, 576, 26200, 0, 1, 560, 1000)) -match "printable area")
        Assert "CheckPage: عرض طباعة 512 < حبر 560 ⇒ رفض (قص)" ([string]([OzkDriverReceiptPrinter]::CheckPage(203, 203, 203, 512, 26200, 0, 0, 560, 1000)) -match "wide")
        Assert "CheckPage: عرض 575 وحبر 557 ⇒ قبول (لا حبر يُقص)" ($null -eq [OzkDriverReceiptPrinter]::CheckPage(203, 203, 203, 575, 26200, 0, 0, 557, 1000))
        # ترويسة الصورة
        $info = [OzkDriverReceiptPrinter]::MonochromeBitmapInfo(576, 3556)
        Assert "ترويسة 1bpp: 576 عرضاً، ‎-3556 (من الأعلى)، بت واحد، لونان: أبيض ثم أسود" ($info.Length -eq 48 -and [BitConverter]::ToInt32($info, 4) -eq 576 -and [BitConverter]::ToInt32($info, 8) -eq -3556 -and
            [BitConverter]::ToInt16($info, 14) -eq 1 -and [BitConverter]::ToInt32($info, 32) -eq 2 -and $info[40] -eq 255 -and $info[41] -eq 255 -and $info[42] -eq 255 -and $info[44] -eq 0 -and $info[45] -eq 0 -and $info[46] -eq 0)

        # طابعة غير موجودة ⇒ رفض قبل أي مهمة
        $small = New-Object byte[] (72 * 24); $small[0] = 0xFF
        $missing = ErrorOf { [OzkDriverReceiptPrinter]::Print("OZK-NO-SUCH-PRINTER-" + [guid]::NewGuid().ToString("N"), $small, 72, 24, "80(72)mm x 3276mm", 203, "OZK test") }
        Assert "طابعة غير موجودة ⇒ OpenPrinter failed ⇒ not_printed" ($missing -match "OpenPrinter failed" -and (Get-CashierBridgeOutcome 1 $missing $false).Outcome -eq "not_printed")
        Assert "Send-OzkReceiptToPrinter يبقى مقيّداً بطابعة الكاشير في مسار التعريف" ((ErrorOf { $env:OZK_RECEIPT_TRANSPORT = "driver"; try { Send-OzkReceiptToPrinter -Receipt (New-Mock 3) -LogoPath $logo -PrinterName "Microsoft Print to PDF" -ConfirmPhysicalPrint } finally { Remove-Item Env:\OZK_RECEIPT_TRANSPORT } }) -match "restricted")

        # تعريف حقيقي غير Xprinter: الرفض يقع قبل StartDoc فلا مهمة ولا ملف.
        $pdf = "Microsoft Print to PDF"
        $hasPdf = $false
        try { [void]([OzkThermalPrinterQueue]::Info($pdf)); $hasPdf = $true } catch { $hasPdf = $false }
        if (-not $hasPdf) {
            Write-Host "SKIP رفض تعريف حقيقي: '$pdf' غير مثبّت على هذا الجهاز (لا تُحسب نجاحاً)"
        } else {
            $jobsBefore = @(Get-PrintJob -PrinterName $pdf -ErrorAction SilentlyContinue).Count
            $noPaper = ErrorOf { [OzkDriverReceiptPrinter]::Print($pdf, $small, 72, 24, "80(72)mm x 3276mm", 203, "OZK test") }
            Assert "تعريف بلا ورق Xprinter ⇒ Driver paper not found ⇒ not_printed" ($noPaper -match "Driver paper not found" -and (Get-CashierBridgeOutcome 1 $noPaper $false).Outcome -eq "not_printed")
            $wrongDpi = ErrorOf { [OzkDriverReceiptPrinter]::Print($pdf, $small, 72, 24, "A4", 203, "OZK test") }
            Assert "تعريف بدقة غير 203 ⇒ Driver page refused قبل StartDoc ⇒ not_printed ($wrongDpi)" ($wrongDpi -match "Driver page refused: resolution" -and (Get-CashierBridgeOutcome 1 $wrongDpi $false).Outcome -eq "not_printed")
            Start-Sleep -Milliseconds 500
            Assert "لا مهمة أُنشئت على '$pdf' في الحالتين" (@(Get-PrintJob -PrinterName $pdf -ErrorAction SilentlyContinue).Count -eq $jobsBefore)
        }
    }
} finally {
    if ($null -eq $savedTransport) { Remove-Item Env:\OZK_RECEIPT_TRANSPORT -ErrorAction SilentlyContinue } else { $env:OZK_RECEIPT_TRANSPORT = $savedTransport }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
