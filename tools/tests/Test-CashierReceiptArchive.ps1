# اختبار أرشيف إيصالات الكاشير (ozk-print-bridge/OzkReceiptArchive.psm1) تحت Windows PowerShell 5.1 وPowerShell 7.
# بيانات وهمية بالكامل: لا أمين ولا طابعة ولا System.Drawing. كل الملفات في مجلد مؤقت يُحذف.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path (Join-Path $repoRoot "ozk-print-bridge") "OzkReceiptArchive.psm1") -Force -DisableNameChecking
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME = "TESTHOST" }

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }

$RATE = 1.0 / 14700.0
function New-Header([string]$Guid = "af3031d6-6fe8-4dee-8359-cc3730b00568", [int]$Number = 2992) {
    return [pscustomobject]@{
        InvoiceGuid = $Guid; InvoiceNumber = $Number; TypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"; TypeName = "retail"
        InvoiceDate = "2026-11-12T00:00:00.0000000Z"; CreateDate = "2026-11-12T09:52:08.0000000Z"; LastUpdateDate = $null
        CustomerName = "زبون سري"; InvoiceTotal = 107.00965986394556; TotalDiscount = 0.0028571428571428571; TotalExtra = 0.0
        FirstPayment = 0.0; CurrencyValue = $RATE; CurrencyIso = "SYP"; IsPosted = $true; RecordState = 0
    }
}
function New-Line([int]$N, [string]$Item, [string]$Name, [double]$Qty, [double]$Price, [double]$Unity = 1, [double]$F2 = 50) {
    return [pscustomobject]@{
        LineGuid = [guid]::NewGuid().ToString(); LineNumber = $N; ItemGuid = $Item; ItemNumber = "$N"; ItemName = $Name
        Qty = $Qty; Qty2 = 0; Qty3 = 0; SelectedUnit = $Unity; RawPrice = $Price; LineDiscount = 0.0; BonusDiscount = 0.0; LineExtra = 0.0
        Unit1Name = "pk"; Unit2Name = "ctn"; Unit2Factor = $F2; Unit3Name = ""; Unit3Factor = $null
    }
}
$ITEM_A = "a3646565-0000-0000-0000-000000000001"
$ITEM_B = "b0000000-0000-0000-0000-000000000002"
function New-Lines { return @((New-Line 0 $ITEM_A "اوسكار سليم فضي" 3 5.3), (New-Line 1 $ITEM_B "غلواز كوين أصفر" 4 8.04)) }
function New-Receipt($Header, $Lines) {
    $printed = foreach ($l in $Lines) {
        $q = [double]$l.Qty; if ([int]$l.SelectedUnit -eq 2) { $q = $q / [double]$l.Unit2Factor }
        $u = [double]$l.RawPrice / [double]$Header.CurrencyValue
        [pscustomobject]@{ Name = $l.ItemName; Quantity = $q; UnitPrice = $u; Total = $q * $u }
    }
    $gross = [double]$Header.InvoiceTotal / [double]$Header.CurrencyValue
    $disc = [double]$Header.TotalDiscount / [double]$Header.CurrencyValue
    return [pscustomobject]@{
        InvoiceNumber = $Header.InvoiceNumber; Lines = @($printed); GrossTotal = $gross; Discount = $disc; TotalExtra = 0.0
        NetTotal = $gross - $disc; Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = 0.0; BalanceFound = $false
        ItemCount = @($Lines).Count; TotalQuantity = 7.0; CurrencyIso = "SYP"
    }
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("receipt-archive-test-" + [guid]::NewGuid().ToString("N"))
try {
    # ── JSON قانوني ثابت ────────────────────────────────────────────────────
    $a = ConvertTo-OzkCanonicalJson ([ordered]@{ b = 1; a = "ك"; c = @(5.3, 2.0, $null, $true) })
    $b = ConvertTo-OzkCanonicalJson @{ c = @(5.3, 2, $null, $true); a = "ك"; b = 1.0 }
    Assert "JSON قانوني: نفس البايتات بغض النظر عن ترتيب المفاتيح ونوع الرقم" ($a -eq $b)
    Assert "JSON قانوني: ASCII خالص (العربية \uXXXX)" ($a -match '\\u0643' -and -not ($a -match '[^\x20-\x7e]'))
    $back = ($a | ConvertFrom-Json)
    Assert "JSON قانوني: G17 يعود إلى نفس الـdouble" ([double]$back.c[0] -eq 5.3)
    Assert "JSON قانوني: يرفض NaN" (Throws { ConvertTo-OzkCanonicalJson ([double]::NaN) })

    # ── محتوى الإيصال المؤرشف ───────────────────────────────────────────────
    $header = New-Header
    $lines = New-Lines
    $receipt = New-Receipt $header $lines
    $payload = [byte[]](0x1B, 0x40, 0x1D, 0x56, 0x42, 0x00)
    $printId = [guid]::NewGuid().ToString()
    $content = New-OzkReceiptArchiveContent -PrintId $printId -Source "auto" -Header $header -Lines $lines -Receipt $receipt `
        -PrinterName "XPRINTER XP-T80Q 80MM" -SnapshotSignature "sig" -Payload $payload -PreparedAtUtc ([datetime]"2026-11-12T09:52:11Z")
    Assert "المحتوى: GUID الفاتورة بحروف صغيرة" ($content.invoice.guid -eq "af3031d6-6fe8-4dee-8359-cc3730b00568")
    Assert "المحتوى: سعر الصرف 14700" ([math]::Round([double]$content.invoice.ratePerBase, 6) -eq 14700)
    Assert "المحتوى: سعر الوحدة المطبوع 77,910" ([math]::Round([double]$content.lines[0].printedUnitPrice, 2) -eq 77910)
    Assert "المحتوى: الصافي المطبوع 1,573,000" ([math]::Round([double]$content.printed.net, 2) -eq 1573000)
    Assert "المحتوى: بصمة الحمولة ESC/POS" ($content.payloadSha256 -eq (Get-OzkSha256Hex $payload))
    Assert "المحتوى: يرفض GUID فاسداً" (Throws { $h = New-Header "not-a-guid"; New-OzkReceiptArchiveContent -PrintId $printId -Source auto -Header $h -Lines $lines -Receipt $receipt })

    # ── الحفظ والمراحل ──────────────────────────────────────────────────────
    $saved = Save-OzkArchivedReceipt -Root $tempRoot -Content $content -NowUtc ([datetime]"2026-11-12T09:52:11Z")
    Assert "الحفظ: الملف موجود" (Test-Path -LiteralPath $saved.Path)
    Assert "الحفظ: بصمة الملف = بصمة prepared" ((Get-OzkSha256Hex ([IO.File]::ReadAllBytes($saved.Path))) -eq $saved.ContentSha256)
    Assert "الحفظ: لا استبدال لنسخة قائمة بنفس printId" (Throws { Save-OzkArchivedReceipt -Root $tempRoot -Content $content })
    [void](Add-OzkReceiptArchiveEvent -Root $tempRoot -PrintId $printId -Stage "submitted" -InvoiceGuid $content.invoice.guid -InvoiceNumber 2992 -JobId 63 -NowUtc ([datetime]"2026-11-12T09:52:12Z"))
    Assert "المراحل: مرحلة مجهولة مرفوضة" (Throws { Add-OzkReceiptArchiveEvent -Root $tempRoot -PrintId $printId -Stage "printed" })
    Assert "المراحل: paper_confirmed بلا دليل مستقل مرفوضة" (Throws { Add-OzkReceiptArchiveEvent -Root $tempRoot -PrintId $printId -Stage "paper_confirmed" })
    [void](Add-OzkReceiptArchiveEvent -Root $tempRoot -PrintId $printId -Stage "windows_completed" -InvoiceGuid $content.invoice.guid -InvoiceNumber 2992 -JobId 63 -Evidence "PrintService/Operational 307")
    $summaries = @(Get-OzkReceiptPrintSummaries $tempRoot)
    Assert "الملخص: طباعة واحدة" ($summaries.Count -eq 1)
    Assert "الملخص: المراحل كما سُجّلت دون استنتاج ورقي" ((@($summaries[0].stages) -join ",") -eq "prepared,submitted,windows_completed")
    Assert "الملخص: رقم مهمة Windows" ($summaries[0].jobId -eq 63)
    Assert "الملخص: وصلت إلى Windows" (Test-OzkReceiptReachedSpooler $summaries[0])
    $integrity = Test-OzkReceiptArchiveIntegrity $tempRoot
    Assert "السلامة: سلسلة البصمات سليمة" ($integrity.Ok -and $integrity.Events -eq 3)

    # إيصال مُجهَّز لم يُسلَّم (فشل قبل إنشاء أي مهمة) لا يُعدّ مطبوعاً.
    $content2 = New-OzkReceiptArchiveContent -PrintId ([guid]::NewGuid().ToString()) -Source "manual" -Header (New-Header) -Lines $lines -Receipt $receipt
    $saved2 = Save-OzkArchivedReceipt -Root $tempRoot -Content $content2
    [void](Add-OzkReceiptArchiveEvent -Root $tempRoot -PrintId $saved2.PrintId -Stage "submit_failed_no_job" -InvoiceGuid $content2.invoice.guid -InvoiceNumber 2992)
    $s2 = @(Get-OzkReceiptPrintSummaries $tempRoot) | Where-Object { $_.printId -eq $saved2.PrintId }
    Assert "الملخص: فشل قبل المهمة ⇒ لم يصل Windows" (-not (Test-OzkReceiptReachedSpooler $s2))

    # ── كشف العبث ───────────────────────────────────────────────────────────
    $original = [IO.File]::ReadAllBytes($saved.Path)
    [IO.File]::WriteAllBytes($saved.Path, [Text.Encoding]::ASCII.GetBytes(([Text.Encoding]::ASCII.GetString($original)).Replace("77910", "70000")))
    $sum1 = @(Get-OzkReceiptPrintSummaries $tempRoot) | Where-Object { $_.printId -eq $printId }
    Assert "العبث: تعديل نسخة الإيصال يُكشف عند القراءة" (Throws { Get-OzkArchivedReceiptContent $tempRoot $sum1 })
    Assert "العبث: فحص السلامة يفشل" (-not (Test-OzkReceiptArchiveIntegrity $tempRoot).Ok)
    [IO.File]::WriteAllBytes($saved.Path, $original)
    $eventsFile = @(Get-ChildItem -LiteralPath $tempRoot -Filter "events-*.jsonl")[0].FullName
    $eventLines = [IO.File]::ReadAllLines($eventsFile)
    [IO.File]::WriteAllLines($eventsFile, @($eventLines[0], $eventLines[2], $eventLines[1]) + @($eventLines | Select-Object -Skip 3))
    Assert "العبث: إعادة ترتيب السجل تكسر السلسلة" (-not (Test-OzkReceiptArchiveIntegrity $tempRoot).Ok)
    [IO.File]::WriteAllLines($eventsFile, $eventLines)
    Assert "العبث: بعد الاسترجاع السلامة تعود" ((Test-OzkReceiptArchiveIntegrity $tempRoot).Ok)

    # ── المقارِن المستقل عن الرسم ───────────────────────────────────────────
    $readBack = Get-OzkArchivedReceiptContent $tempRoot $sum1
    $printedCmp = Get-OzkArchivedComparable $readBack
    function To-Rows($Lines) { foreach ($l in $Lines) { [pscustomobject]@{ itemGuid = $l.ItemGuid; itemName = $l.ItemName; qty = $l.Qty; selectedUnit = $l.SelectedUnit; unit2Factor = $l.Unit2Factor; unit3Factor = $null; rawPrice = $l.RawPrice } } }
    $same = New-OzkInvoiceComparable -CurrencyValue $RATE -CurrencyIso SYP -Total $header.InvoiceTotal -TotalDiscount $header.TotalDiscount -TotalExtra 0 -Lines @(To-Rows $lines)
    Assert "المقارنة: نفس الفاتورة ⇒ لا تغيّر" (@(Compare-OzkInvoiceComparable $printedCmp $same).Count -eq 0)

    # نفس المبلغ المطبوع بسعر صرف وسعر خام مختلفين ⇒ لا تغيّر ظاهر (تجنّب الإنذار الكاذب).
    $rate2 = 1.0 / 14000.0
    $linesSameSyp = @((New-Line 0 $ITEM_A "اوسكار سليم فضي" 3 (77910.0 / 14000.0)), (New-Line 1 $ITEM_B "غلواز كوين أصفر" 4 (118188.0 / 14000.0)))
    $sameSyp = New-OzkInvoiceComparable -CurrencyValue $rate2 -CurrencyIso SYP -Total (1573042.0 / 14000.0) -TotalDiscount (42.0 / 14000.0) -TotalExtra 0 -Lines @(To-Rows $linesSameSyp)
    $kinds = @(Compare-OzkInvoiceComparable $printedCmp $sameSyp | ForEach-Object { $_.kind })
    Assert "المقارنة: تغيّر سعر الصرف وحده مع ثبات المطبوع ⇒ يُبلَّغ عن سعر الصرف فقط" (($kinds -join ",") -eq "exchange_rate")

    # تعديل حقيقي: سعر وحدة + صنف مضاف + كمية ⇒ كلها تظهر، والصافي يتغيّر.
    $edited = @((New-Line 0 $ITEM_A "اوسكار سليم فضي" 5 5.3), (New-Line 1 $ITEM_B "غلواز كوين أصفر" 4 7.9), (New-Line 2 "c0000000-0000-0000-0000-000000000003" "ماستر سليم أزرق" 1 7.0748299319727891))
    $editedTotal = (5 * 5.3) + (4 * 7.9) + 7.0748299319727891
    $editedCmp = New-OzkInvoiceComparable -CurrencyValue $RATE -CurrencyIso SYP -Total $editedTotal -TotalDiscount $header.TotalDiscount -TotalExtra 0 -Lines @(To-Rows $edited)
    $changes = @(Compare-OzkInvoiceComparable $printedCmp $editedCmp)
    $kinds = @($changes | ForEach-Object { $_.kind })
    Assert "المقارنة: صنف مضاف" ($kinds -contains "item_added")
    Assert "المقارنة: كمية" ($kinds -contains "quantity")
    Assert "المقارنة: سعر وحدة 118,188 ← 116,130" ((@($changes | Where-Object { $_.kind -eq "unit_price" })[0].to[0]) -eq 116130)
    Assert "المقارنة: الصافي" ($kinds -contains "net")

    # الوحدة الثانية: الكمية بالكرتونة كما تُطبع.
    Assert "الكمية: Unity=2 ⇒ Qty ÷ Unit2Fact" ((ConvertTo-OzkSelectedQuantity 100 2 50 $null) -eq 2)
    Assert "الكمية: Unity=2 بلا عامل ⇒ null لا تخمين" ($null -eq (ConvertTo-OzkSelectedQuantity 100 2 0 $null))

    # ── التزامن: كاتبان معاً لا يكسران السلسلة ──────────────────────────────
    $root2 = Join-Path $tempRoot "concurrent"
    $module = Join-Path (Join-Path $repoRoot "ozk-print-bridge") "OzkReceiptArchive.psm1"
    $jobs = foreach ($w in 1..3) {
        Start-Job -ArgumentList $module, $root2, $w -ScriptBlock {
            param($m, $r, $w)
            Import-Module $m -Force -DisableNameChecking
            foreach ($i in 1..15) { [void](Add-OzkReceiptArchiveEvent -Root $r -PrintId ([guid]::NewGuid().ToString()) -Stage "submitted" -InvoiceGuid ([guid]::NewGuid().ToString()) -InvoiceNumber ($w * 100 + $i) -JobId $i) }
        }
    }
    $jobs | Wait-Job -Timeout 120 | Out-Null
    $jobs | Receive-Job -ErrorAction SilentlyContinue | Out-Null
    $jobs | Remove-Job -Force
    $integrity2 = Test-OzkReceiptArchiveIntegrity $root2
    $chainOk = $true
    foreach ($p in @($integrity2.Problems)) { if ($p -match "chain broken") { $chainOk = $false } }
    Assert "التزامن: 45 سطراً بسلسلة سليمة" ($integrity2.Events -eq 45 -and $chainOk)
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
