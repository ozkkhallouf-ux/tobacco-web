# تكامل الأرشيف مع جسر الكاشير وتوافق ترقية جسر OZKUSER (تحت Windows PowerShell 5.1 وPowerShell 7).
# دوال الجسر تُستخرج من المصدر الحقيقي بمحلّل PowerShell وتُشغَّل معزولة: بلا SQL ولا طابعة ولا
# حلقة رصد ولا System.Drawing. state.json بشكل الملف الحي على OZKUSER (schemaVersion 1، بلا
# baselineInitialized ولا quarantined) ببيانات وهمية.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bridgeDir = Join-Path $repoRoot "ozk-print-bridge"
$bridgePath = Join-Path $bridgeDir "ozk-print-bridge.ps1"
$watchLib = Join-Path (Join-Path (Join-Path $repoRoot "tools") "cashier-reprint") "cashier-reprint-lib.ps1"
Import-Module (Join-Path $bridgeDir "OzkReceiptArchive.psm1") -Force -DisableNameChecking -Global
. $watchLib
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME = "TESTHOST" }

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }

# أنواع الاستثناءات نفسها التي تعرّفها وحدة الرسم (بلا System.Drawing هنا).
# على Windows تأتي من Add-Type؛ هنا صنفا PowerShell بالاسم نفسه (Test-PreSubmissionFailure يطابق بالاسم)،
# فيعملان أيضاً حيث لا مترجم C# (PowerShell على macOS).
foreach ($typeName in @("OzkSpoolNotSubmittedException", "OzkReceiptUnrenderableException")) {
    if (-not ($typeName -as [type])) {
        Invoke-Expression ("class $typeName : System.Exception { $typeName([string]`$m) : base(`$m) { } }")
    }
}

$bridgeText = [IO.File]::ReadAllText($bridgePath)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($bridgePath, [ref]$tokens, [ref]$errors)
Assert "الجسر: يُحلَّل بلا أخطاء" (@($errors).Count -eq 0)
$functions = @{}
foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @("New-EmptyState", "Read-BridgeState", "Should-SkipSeenInvoice", "Test-PreSubmissionFailure", "Assert-ExpectedInvoiceGuid",
        "Get-BridgeSubmissionFailureStage", "Format-CanonicalValue", "Get-CanonicalLineText", "Get-CanonicalReceiptText", "Get-CanonicalHash",
        "Convert-ToReceiptAmount", "Convert-SnapshotToReceipt", "Get-BridgeFileSha256", "Save-BridgeReceiptArchive", "Add-BridgeArchiveStage")) {
    if (-not $functions.ContainsKey($name)) { throw "Bridge function $name not found." }
    . ([scriptblock]::Create($functions[$name]))
}
$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture
function Write-BridgeLog($EventObject) { $script:bridgeLog += @($EventObject) }
$script:bridgeLog = @()

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("receipt-bridge-test-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Force -Path $tempRoot)
try {
    # ── state.json بشكل OZKUSER الحي ──────────────────────────────────────
    $statePath = Join-Path $tempRoot "state.json"
    $live = @'
{"schemaVersion":1,"database":"AmnDb002","updatedAt":"2026-11-12T09:52:12.0000000Z",
 "seen":{"AF3031D6-6FE8-4DEE-8359-CC3730B00568":{"status":"spooled","invoiceNumber":2992,"observedAt":"2026-11-12T09:52:10.2635545Z","lineCount":7},
         "ca8a3401-9282-4531-82d1-a85d069179f6":{"status":"spooled","invoiceNumber":2991,"observedAt":"2026-11-12T09:49:28.5273686Z","lineCount":7},
         "11111111-2222-3333-4444-555555555555":{"status":"baseline","invoiceNumber":1001,"observedAt":"2026-08-18T18:00:00Z","lineCount":2},
         "66666666-7777-8888-9999-000000000000":{"status":"duplicate_suppressed","invoiceNumber":2860,"observedAt":"2026-11-03T14:38:20Z","lineCount":14}},
 "recentFingerprints":{"26c43dddd59c15efdc6500416c343c379ccbf6e5ef717692a20354c667019311":{"guid":"af3031d6-6fe8-4dee-8359-cc3730b00568","invoiceNumber":2992,"printedAt":"2026-11-12T09:52:10.2559553Z"}}}
'@
    [IO.File]::WriteAllText($statePath, $live, (New-Object Text.UTF8Encoding($false)))
    $state = Read-BridgeState $statePath
    Assert "state.json الحي: يُقرأ بلا ترحيل" ($null -ne $state)
    Assert "state.json الحي: غياب baselineInitialized ⇒ مهيّأ (لا طباعة انفجارية للقديم)" ($state.baselineInitialized -eq $true)
    Assert "state.json الحي: كل الفواتير المرئية محفوظة بمفاتيح صغيرة" ($state.seen.Count -eq 4 -and $state.seen.ContainsKey("af3031d6-6fe8-4dee-8359-cc3730b00568"))
    Assert "state.json الحي: بصمات منع التكرار محفوظة" ($state.recentFingerprints.Count -eq 1)
    Assert "state.json الحي: عزل فارغ" ($state.quarantined.Count -eq 0)
    $skipAll = $true
    foreach ($key in @($state.seen.Keys)) { if (-not (Should-SkipSeenInvoice $state.seen[$key] $true)) { $skipAll = $false } }
    Assert "منع التكرار: لا إعادة طباعة لأي فاتورة spooled/baseline/duplicate_suppressed" $skipAll
    Assert "منع التكرار: فاتورة جديدة غير مرئية تُطبع" (-not (Should-SkipSeenInvoice $null $true))

    # ── ثبات الرأس والأسطر قبل الطباعة ────────────────────────────────────
    function New-Header { [pscustomobject]@{ InvoiceGuid = "af3031d6-6fe8-4dee-8359-cc3730b00568"; InvoiceNumber = 2992; TypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"
        InvoiceDate = "2026-11-12T00:00:00Z"; CreateDate = "2026-11-12T09:52:08Z"; LastUpdateDate = $null; CustomerName = ""; IsPosted = $true; RecordState = 0
        InvoiceTotal = 107.00965986394556; TotalDiscount = 0.0028571428571428571; TotalExtra = 0.0; FirstPayment = 0.0; CurrencyValue = (1.0 / 14700.0); CurrencyIso = "SYP" } }
    function New-Line([double]$Qty, [double]$Price, [double]$Unity = 1, $F2 = 50, [string]$Item = "a3646565-0000-0000-0000-000000000001") {
        [pscustomobject]@{ LineGuid = "l1"; LineNumber = 0; ItemGuid = $Item; ItemNumber = "1"; ItemName = "اوسكار سليم فضي"; Qty = $Qty; Qty2 = 0; Qty3 = 0
            SelectedUnit = $Unity; RawPrice = $Price; LineDiscount = 0.0; BonusDiscount = 0.0; LineExtra = 0.0; Unit2Factor = $F2; Unit3Factor = $null } }
    $lines = @(New-Line 3 5.3)
    $balance = [pscustomobject]@{ Found = $false; Previous = 0.0; Current = 0.0 }
    $base = Get-CanonicalReceiptText (New-Header) $lines $true "" $balance
    foreach ($field in @("CurrencyValue", "InvoiceTotal", "TotalDiscount", "TotalExtra", "FirstPayment", "CustomerName")) {
        $h = New-Header
        if ($field -eq "CustomerName") { $h.CustomerName = "x" } else { $h.$field = [double]$h.$field + 0.001 }
        Assert "ثبات الرأس: تغيّر $field يكسر بصمة الاستقرار (نسخة المستودع)" ((Get-CanonicalReceiptText $h $lines $true "" $balance) -ne $base)
    }
    $hUpd = New-Header; $hUpd.LastUpdateDate = "2026-11-12T10:00:00Z"
    Assert "ثبات الرأس: LastUpdateDate (للأرشيف) خارج البصمة فلا يؤخر الطباعة" ((Get-CanonicalReceiptText $hUpd $lines $true "" $balance) -eq $base)
    $b2 = [pscustomobject]@{ Found = $true; Previous = 10.0; Current = 20.0 }
    Assert "ثبات الرأس: الرصيد ضمن البصمة" ((Get-CanonicalReceiptText (New-Header) $lines $true "" $b2) -ne $base)

    # ── ثبات أسعار الفاتورة (نسخة المستودع، بيانات #2992) ─────────────────
    $snapshot = [pscustomobject]@{ Header = (New-Header); Lines = @((New-Line 3 5.3), (New-Line 4 8.04 1 50 "b0000000-0000-0000-0000-000000000002")); LineCount = 2; Balance = $balance; Signature = "sig" }
    $receipt = Convert-SnapshotToReceipt $snapshot
    Assert "الأسعار: 5.30$ × 14,700 = 77,910" ([math]::Round($receipt.Lines[0].UnitPrice, 2) -eq 77910)
    Assert "الأسعار: 8.04$ × 14,700 = 118,188" ([math]::Round($receipt.Lines[1].UnitPrice, 2) -eq 118188)
    Assert "الأسعار: الخصم 42" ([math]::Round($receipt.Discount, 2) -eq 42)
    $u2 = Convert-SnapshotToReceipt ([pscustomobject]@{ Header = (New-Header); Lines = @(New-Line 100 50.0 2 50); LineCount = 1; Balance = $balance; Signature = "s" })
    Assert "الأسعار: Unity=2 ⇒ الكمية 2 كرتونة" ($u2.Lines[0].Quantity -eq 2)
    Assert "الأسعار: Unity=2 بلا عامل ⇒ رفض لا تخمين" (Throws { Convert-SnapshotToReceipt ([pscustomobject]@{ Header = (New-Header); Lines = @(New-Line 100 50.0 2 0); LineCount = 1; Balance = $balance; Signature = "s" }) })

    # ── تثبيت GUID ونتيجة التسليم ─────────────────────────────────────────
    Assert "GUID: بلا تثبيت ⇒ يمر" (-not (Throws { Assert-ExpectedInvoiceGuid "" "af3031d6-6fe8-4dee-8359-cc3730b00568" 2992 }))
    Assert "GUID: مطابق ⇒ يمر" (-not (Throws { Assert-ExpectedInvoiceGuid "AF3031D6-6FE8-4DEE-8359-CC3730B00568" "af3031d6-6fe8-4dee-8359-cc3730b00568" 2992 }))
    Assert "GUID: رقم صار لفاتورة أخرى ⇒ رفض قبل أي تصيير" (Throws { Assert-ExpectedInvoiceGuid "ca8a3401-9282-4531-82d1-a85d069179f6" "af3031d6-6fe8-4dee-8359-cc3730b00568" 2992 })
    $noJob = $null; try { throw (New-Object OzkSpoolNotSubmittedException "OpenPrinter failed") } catch { $noJob = $_ }
    $other = $null; try { throw (New-Object InvalidOperationException "WritePrinter failed") } catch { $other = $_ }
    Assert "التسليم: فشل قبل المهمة ⇒ submit_failed_no_job" ((Get-BridgeSubmissionFailureStage $noJob) -eq "submit_failed_no_job")
    Assert "التسليم: فشل بعد بدء المهمة ⇒ submit_uncertain" ((Get-BridgeSubmissionFailureStage $other) -eq "submit_uncertain")

    # ── الأرشيف من دوال الجسر نفسها ──────────────────────────────────────
    $ReceiptArchiveRoot = Join-Path $tempRoot "archive"
    $ReceiptArchiveMode = "Required"
    $PrinterName = "XPRINTER XP-T80Q 80MM"
    $script:ReceiptModulePath = Join-Path $bridgeDir "OzkReceiptRenderer.psm1"
    $job = [pscustomobject]@{ Payload = [byte[]](0x1B, 0x40, 0x1D, 0x56, 0x42, 0x00); PrinterName = $PrinterName }
    $archive = Save-BridgeReceiptArchive "auto" $snapshot $receipt $job
    Add-BridgeArchiveStage $archive "submitted" 63
    $summaries = @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot)
    Assert "الأرشيف: prepared ثم submitted برقم مهمة Windows" ($summaries.Count -eq 1 -and (@($summaries[0].stages) -join ",") -eq "prepared,submitted" -and $summaries[0].jobId -eq 63)
    $content = Get-OzkArchivedReceiptContent $ReceiptArchiveRoot $summaries[0]
    Assert "الأرشيف: يطابق ما يُطبع (77,910 وصافي 1,573,000)" ([math]::Round([double]$content.lines[0].printedUnitPrice, 2) -eq 77910 -and [math]::Round([double]$content.printed.net, 2) -eq 1573000)
    Assert "الأرشيف: بصمة الحمولة المرسلة للطابعة" ($content.payloadSha256 -eq (Get-OzkSha256Hex $job.Payload))
    Assert "الأرشيف: بصمة الرسّام الفعلي" ($content.rendererSha256 -eq (Get-OzkSha256Hex ([IO.File]::ReadAllBytes($script:ReceiptModulePath))))
    $ReceiptArchiveMode = "Off"
    Assert "الأرشيف: الوضع Off لا يكتب شيئاً" ($null -eq (Save-BridgeReceiptArchive "auto" $snapshot $receipt $job))
    $ReceiptArchiveMode = "Required"
    $ReceiptArchiveRoot = Join-Path $tempRoot "not-a-dir.txt"
    [IO.File]::WriteAllText($ReceiptArchiveRoot, "x")
    Assert "الأرشيف: فشل الحفظ يرمي (فلا طباعة بلا نسخة)" (Throws { Save-BridgeReceiptArchive "manual" $snapshot $receipt $job })
    $script:bridgeLog = @()
    Add-BridgeArchiveStage ([pscustomobject]@{ PrintId = [guid]::NewGuid().ToString(); InvoiceGuid = "af3031d6-6fe8-4dee-8359-cc3730b00568"; InvoiceNumber = 2992 }) "submitted" 64
    Assert "الأرشيف: فشل تسجيل المرحلة بعد الطباعة لا يُسقط الجسر بل يُسجَّل" (@($script:bridgeLog | Where-Object { $_.Event -eq "receipt_archive_stage_failed" }).Count -eq 1)

    # ── ترتيب المسارين في المصدر: الأرشيف قبل العلامة والتسليم ─────────────
    $manualStart = $bridgeText.IndexOf('if ($Mode -eq "PreviewInvoice" -or $Mode -eq "PrintInvoice")')
    $manualText = $bridgeText.Substring($manualStart, $bridgeText.IndexOf('if ($Mode -eq "Benchmark")') - $manualStart)
    $order = @('Assert-ExpectedInvoiceGuid', 'Wait-InvoiceReady', 'New-OzkReceiptSpoolJob', 'Save-BridgeReceiptArchive "manual"', 'status = "print_in_flight"', 'Submit-OzkReceiptSpoolJob', 'Add-BridgeArchiveStage $manualArchive "submitted"') | ForEach-Object { $manualText.IndexOf($_) }
    Assert "يدوي: GUID ثم الاستقرار ثم الرسم ثم الأرشيف ثم العلامة ثم التسليم ثم submitted" ((@($order | Where-Object { $_ -lt 0 }).Count -eq 0) -and ((0..($order.Count - 2) | Where-Object { $order[$_] -ge $order[$_ + 1] }).Count -eq 0))
    $autoStart = $bridgeText.IndexOf('$spoolJob = New-OzkReceiptSpoolJob')
    $autoText = $bridgeText.Substring($autoStart)
    $order2 = @('Save-BridgeReceiptArchive "auto"', 'status = "print_in_flight"', 'Submit-OzkReceiptSpoolJob', 'Add-BridgeArchiveStage $autoArchive "submitted"') | ForEach-Object { $autoText.IndexOf($_) }
    Assert "آلي: الأرشيف ثم العلامة ثم التسليم ثم submitted" ((@($order2 | Where-Object { $_ -lt 0 }).Count -eq 0) -and ((0..($order2.Count - 2) | Where-Object { $order2[$_] -ge $order2[$_ + 1] }).Count -eq 0))
    $autoCatch = $autoText.Substring($autoText.IndexOf('Save-BridgeReceiptArchive "auto"'), $autoText.IndexOf('status = "print_in_flight"') - $autoText.IndexOf('Save-BridgeReceiptArchive "auto"'))
    Assert "آلي: فشل الأرشيف ⇒ continue بلا علامة ولا طباعة" ($autoCatch -match 'continue' -and $autoCatch -notmatch 'Merge-BridgeStateForWrite|Submit-OzkReceiptSpoolJob')
    Assert "الجسر: الوضع الافتراضي Required" ($bridgeText -match '\[string\]\$ReceiptArchiveMode = "Required"')
    Assert "الجسر: لا يكتب windows_completed ولا paper_confirmed" ($bridgeText -notmatch '"windows_completed"|"paper_confirmed"')
    Assert "الجسر: لا إعادة طباعة عند التعديل (لا استدعاء للمراقب)" ($bridgeText -notmatch 'cashier-receipt-watch')

    # ── أداة إعادة الطباعة: قراءة الأرشيف وتمييز النسخة التاريخية ──────────
    $root2 = Join-Path $tempRoot "archive2"
    $ReceiptArchiveRoot = $root2
    $current = [pscustomobject]@{ InvoiceGuid = "af3031d6-6fe8-4dee-8359-cc3730b00568"; InvoiceNumber = 2992; Total = 107.00965986394556; TotalDiscount = 0.0028571428571428571; TotalExtra = 0.0; CurrencyValue = (1.0 / 14700.0) }
    $none = Get-CashierArchiveInsight $root2 $current
    Assert "إعادة الطباعة: بلا أرشيف ⇒ لا طباعات سابقة ولا حكم" ($none.PriorPrints -eq 0 -and $null -eq $none.ChangedSincePrint)
    $a1 = Save-BridgeReceiptArchive "auto" $snapshot $receipt $job; Add-BridgeArchiveStage $a1 "submitted" 63
    $insight = Get-CashierArchiveInsight $root2 $current
    Assert "إعادة الطباعة: نفس الفاتورة بلا تعديل" ($insight.PriorPrints -eq 1 -and $insight.ChangedSincePrint -eq $false)
    $edited = [pscustomobject]@{ InvoiceGuid = $current.InvoiceGuid; InvoiceNumber = 2992; Total = 120.0; TotalDiscount = $current.TotalDiscount; TotalExtra = 0.0; CurrencyValue = $current.CurrencyValue }
    Assert "إعادة الطباعة: عُدّلت بعد الطباعة ⇒ تحذير" ((Get-CashierArchiveInsight $root2 $edited).ChangedSincePrint -eq $true)
    $other = [pscustomobject]@{ InvoiceGuid = "70000000-0000-0000-0000-000000000007"; InvoiceNumber = 2992; Total = 5.0; TotalDiscount = 0.0; TotalExtra = 0.0; CurrencyValue = $current.CurrencyValue }
    $reuse = Get-CashierArchiveInsight $root2 $other
    Assert "إعادة الطباعة: رقم أعيد استخدامه ⇒ النسخة السابقة لفاتورة أخرى ظاهرة" ($reuse.PriorPrints -eq 0 -and @($reuse.NumberReusedFrom).Count -eq 1 -and $reuse.NumberReusedFrom[0].InvoiceGuidSuffix -eq "30b00568")
    $prints = @(Read-CashierArchivePrints $root2)
    $hist = Format-CashierHistoricalReceipt (Read-CashierArchivedReceipt $root2 $prints[0]) $prints[0]
    Assert "النسخة التاريخية: موسومة صراحة ولا تمثّل الحالية" ($hist -match "^==== نسخة تاريخية — لا تمثّل الفاتورة الحالية ====" -and $hist -match "للعرض فقط")
    Assert "النسخة التاريخية: أسعارها كما طُبعت" ($hist -match "77,910.00")
    $path = Join-Path $root2 $prints[0].ReceiptPath
    $bytes = [IO.File]::ReadAllBytes($path); $bytes[10] = [byte](([int]$bytes[10] + 1) % 128); [IO.File]::WriteAllBytes($path, $bytes)
    Assert "النسخة التاريخية: نسخة معبوث بها لا تُعرض" (Throws { Read-CashierArchivedReceipt $root2 $prints[0] })
    Assert "إعادة الطباعة: عبث بالأرشيف ⇒ تحذير بصمة" ((Get-CashierArchiveInsight $root2 $current).ArchiveIntegrityFailed -eq $true)

    # تثبيت GUID في وسائط الجسر: فقط حين يُفعَّل صراحة بعد الترقية (الجسر القديم يرفض الوسيط).
    $cfg = [pscustomobject]@{ bridgeScriptPath = "C:\x\ozk-print-bridge.ps1"; bridgePinsInvoiceGuid = $false }
    if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { $env:SystemRoot = [IO.Path]::GetTempPath() }
    Assert "إعادة الطباعة: بلا تفعيل ⇒ لا -ExpectedInvoiceGuid" ((New-CashierBridgeStartInfo $cfg 2992 "2026-11-12" "" "af3031d6-6fe8-4dee-8359-cc3730b00568").Arguments -notmatch "ExpectedInvoiceGuid")
    $cfg.bridgePinsInvoiceGuid = $true
    Assert "إعادة الطباعة: مع التفعيل ⇒ GUID المحسوم يُمرَّر" ((New-CashierBridgeStartInfo $cfg 2992 "2026-11-12" "" "af3031d6-6fe8-4dee-8359-cc3730b00568").Arguments -match "-ExpectedInvoiceGuid af3031d6-6fe8-4dee-8359-cc3730b00568")
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
