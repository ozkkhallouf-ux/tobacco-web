# اختبار مراقب إيصالات الكاشير بعد الطباعة (tools/cashier-receipt-watch) تحت Windows PowerShell 5.1 وPowerShell 7.
# سيناريوهات مأخوذة من أنماط حقيقية مثبتة في سجل العمليات (أرقام وأسماء وهمية): تعديل بعد الطباعة،
# حذف ثم إعادة إدخال برقم جديد، إعادة استخدام الرقم. بلا أمين ولا تيليغرام ولا طابعة.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$watchDir = Join-Path (Join-Path $repoRoot "tools") "cashier-receipt-watch"
. (Join-Path $watchDir "cashier-receipt-watch-lib.ps1")
Import-Module (Join-Path (Join-Path $repoRoot "ozk-print-bridge") "OzkReceiptArchive.psm1") -Force -DisableNameChecking -Global
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME = "TESTHOST" }

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }

$RATE = 1.0 / 14700.0
$RETAIL = "cc1097b1-662d-4d80-8e4e-3b493249591c"
$ITEM_A = "a0000000-0000-0000-0000-00000000000a"
$ITEM_B = "b0000000-0000-0000-0000-00000000000b"
$ITEM_C = "c0000000-0000-0000-0000-00000000000c"
$SECRET_CUSTOMER = "زبون سري جداً"
$syria = [TimeZoneInfo]::CreateCustomTimeZone("SY", [TimeSpan]::FromHours(3), "SY", "SY")

function New-SnapshotLine([string]$Item, [string]$Name, [double]$Qty, [double]$Price) {
    return [pscustomobject]@{ LineGuid = [guid]::NewGuid().ToString(); LineNumber = 0; ItemGuid = $Item; ItemNumber = "1"; ItemName = $Name
        Qty = $Qty; Qty2 = 0; Qty3 = 0; SelectedUnit = 1; RawPrice = $Price; LineDiscount = 0.0; BonusDiscount = 0.0; LineExtra = 0.0
        Unit2Factor = 50; Unit3Factor = $null }
}
function New-PrintedInvoice([string]$Root, [string]$Guid, [int]$Number, [object[]]$Lines, [datetime]$PrintedUtc, [string]$Stage = "submitted", [int]$JobId = 63) {
    $total = 0.0; foreach ($l in $Lines) { $total += $l.Qty * $l.RawPrice }
    $header = [pscustomobject]@{ InvoiceGuid = $Guid; InvoiceNumber = $Number; TypeGuid = $RETAIL; InvoiceDate = $PrintedUtc.Date.ToString("o")
        CreateDate = $PrintedUtc.AddSeconds(-3).ToString("o"); LastUpdateDate = $null; CustomerName = $SECRET_CUSTOMER
        InvoiceTotal = $total; TotalDiscount = 0.0; TotalExtra = 0.0; FirstPayment = 0.0; CurrencyValue = $RATE; CurrencyIso = "SYP" }
    $printed = foreach ($l in $Lines) { [pscustomobject]@{ Name = $l.ItemName; Quantity = $l.Qty; UnitPrice = $l.RawPrice / $RATE; Total = $l.Qty * $l.RawPrice / $RATE } }
    $receipt = [pscustomobject]@{ InvoiceNumber = $Number; Lines = @($printed); GrossTotal = $total / $RATE; Discount = 0.0; TotalExtra = 0.0; NetTotal = $total / $RATE
        Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = 0.0; BalanceFound = $false; ItemCount = @($Lines).Count; TotalQuantity = 1.0; CurrencyIso = "SYP" }
    $content = New-OzkReceiptArchiveContent -PrintId ([guid]::NewGuid().ToString()) -Source "auto" -Header $header -Lines $Lines -Receipt $receipt -PrinterName "XPRINTER XP-T80Q 80MM" -PreparedAtUtc $PrintedUtc
    $saved = Save-OzkArchivedReceipt -Root $Root -Content $content -NowUtc $PrintedUtc
    if ($Stage) { [void](Add-OzkReceiptArchiveEvent -Root $Root -PrintId $saved.PrintId -Stage $Stage -InvoiceGuid $Guid -InvoiceNumber $Number -JobId $JobId -NowUtc $PrintedUtc.AddSeconds(1)) }
    return $saved
}
function New-Current([string]$Guid, [int]$Number, [object[]]$Lines, [double]$Rate = $RATE, [bool]$Posted = $true, [string]$Type = $RETAIL) {
    $total = 0.0; foreach ($l in $Lines) { $total += $l.Qty * $l.RawPrice }
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($l in $Lines) { $list.Add([pscustomobject]@{ itemGuid = $l.ItemGuid; itemName = $l.ItemName; qty = $l.Qty; selectedUnit = 1; unit2Factor = 50; unit3Factor = $null; rawPrice = $l.RawPrice }) }
    return [pscustomobject]@{ guid = $Guid; number = $Number; typeGuid = $Type; isPosted = $Posted; recordState = 0; total = $total; totalDiscount = 0.0; totalExtra = 0.0
        currencyValue = $Rate; currencyIso = "SYP"; lines = $list }
}
function Get-Prints([string]$Root) {
    return @(foreach ($s in @(Get-OzkReceiptPrintSummaries $Root)) { if (Test-OzkReceiptReachedSpooler $s) { [pscustomobject]@{ Summary = $s; Content = (Get-OzkArchivedReceiptContent $Root $s) } } })
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("receipt-watch-test-" + [guid]::NewGuid().ToString("N"))
try {
    $start = [datetime]"2026-11-12T08:00:00Z"
    $root = Join-Path $tempRoot "archive"
    $baseLines = @((New-SnapshotLine $ITEM_A "اوسكار سليم فضي" 3 5.3), (New-SnapshotLine $ITEM_B "غلواز كوين أحمر" 4 8.04))

    # 1) مطبوع قبل أول تشغيل للمراقب: لا تنبيه تاريخي أبداً.
    $gOld = "10000000-0000-0000-0000-000000000001"
    [void](New-PrintedInvoice $root $gOld 2900 $baseLines ([datetime]"2026-11-11T10:00:00Z"))
    # 2) لم تتغيّر.
    $gSame = "20000000-0000-0000-0000-000000000002"
    [void](New-PrintedInvoice $root $gSame 2990 $baseLines ([datetime]"2026-11-12T08:57:33Z"))
    # 3) عُدّلت بعد الطباعة: صنف مضاف، سعر وحدة، كمية (نمط #2980).
    $gEdit = "30000000-0000-0000-0000-000000000003"
    [void](New-PrintedInvoice $root $gEdit 2980 $baseLines ([datetime]"2026-11-12T09:00:00Z"))
    # 4) حُذفت ثم أُعيد إدخالها برقم جديد (نمط #2991 ← #2992).
    $gDel = "40000000-0000-0000-0000-000000000004"; $gNew = "50000000-0000-0000-0000-000000000005"
    [void](New-PrintedInvoice $root $gDel 2991 $baseLines ([datetime]"2026-11-12T09:49:28Z"))
    # 5) حُذفت وأُعيد استخدام رقمها لفاتورة مختلفة تماماً (نمط #2989).
    $gReuseOld = "60000000-0000-0000-0000-000000000006"; $gReuseNew = "70000000-0000-0000-0000-000000000007"
    [void](New-PrintedInvoice $root $gReuseOld 2989 @((New-SnapshotLine $ITEM_C "ماستر سليم أزرق" 2 7.0748299319727891)) ([datetime]"2026-11-12T08:10:00Z"))
    # 6) مُجهَّزة ولم تصل Windows (فشل قبل المهمة): ليست إيصالاً ورقياً.
    $gNoJob = "80000000-0000-0000-0000-000000000008"
    [void](New-PrintedInvoice $root $gNoJob 2993 $baseLines ([datetime]"2026-11-12T09:55:00Z") "submit_failed_no_job")
    # 7) تغيّر سعر الصرف والسعر الخام والمطبوع نفسه: ليس تغيّراً ظاهراً.
    $gRate = "90000000-0000-0000-0000-000000000009"
    [void](New-PrintedInvoice $root $gRate 2994 $baseLines ([datetime]"2026-11-12T09:56:00Z"))

    $rate2 = 1.0 / 14000.0
    $current = @{}
    $current[$gOld] = New-Current $gOld 2900 @((New-SnapshotLine $ITEM_A "x" 9 9.9))
    $current[$gSame] = New-Current $gSame 2990 $baseLines
    $current[$gEdit] = New-Current $gEdit 2980 @((New-SnapshotLine $ITEM_A "اوسكار سليم فضي" 5 5.3), (New-SnapshotLine $ITEM_B "غلواز كوين أحمر" 4 7.9), (New-SnapshotLine $ITEM_C "ماستر سليم أزرق" 1 7.0748299319727891))
    $current[$gNew] = New-Current $gNew 2992 @((New-SnapshotLine $ITEM_A "اوسكار سليم فضي" 3 5.3), (New-SnapshotLine $ITEM_B "غلواز كوين أحمر" 2 8.04), (New-SnapshotLine "d0000000-0000-0000-0000-00000000000d" "غلواز كوين أصفر" 4 8.04))
    $current[$gReuseNew] = New-Current $gReuseNew 2989 @((New-SnapshotLine $ITEM_A "اوسكار سليم فضي" 1 5.3))
    $current[$gRate] = New-Current $gRate 2994 @((New-SnapshotLine $ITEM_A "اوسكار سليم فضي" 3 (77910.0 / 14000.0)), (New-SnapshotLine $ITEM_B "غلواز كوين أحمر" 4 (118188.0 / 14000.0))) $rate2
    $logEvidence = @{ $gDel = [pscustomobject]@{ deletes = 1; edits = 0 }; $gReuseOld = [pscustomobject]@{ deletes = 1; edits = 0 } }
    $neighbours = @{
        $gDel = @([pscustomobject]@{ guid = $gNew; number = 2992 })
        $gReuseOld = @([pscustomobject]@{ guid = $gReuseNew; number = 2989 })
    }

    $prints = Get-Prints $root
    $findings = @(Get-CashierWatchFindings -Prints $prints -Current $current -LogEvidence $logEvidence -Neighbours $neighbours -WatchStartUtc $start)
    $byNumber = @{}; foreach ($f in $findings) { $byNumber[[int]$f.invoiceNumber] = $f }
    Assert "الكشف: لا شيء عمّا طُبع قبل بدء المراقب (#2900)" (-not $byNumber.ContainsKey(2900))
    Assert "الكشف: لا شيء عن فاتورة لم تتغيّر (#2990)" (-not $byNumber.ContainsKey(2990))
    Assert "الكشف: لا شيء عن إيصال لم يصل Windows (#2993)" (-not $byNumber.ContainsKey(2993))
    Assert "الكشف: سعر الصرف وحده بلا تغيّر مطبوع ⇒ لا تنبيه (#2994)" (-not $byNumber.ContainsKey(2994))
    Assert "الكشف: #2980 معدّلة" ($byNumber[2980].kind -eq "edited")
    $editKinds = @($byNumber[2980].changes | ForEach-Object { $_.kind })
    Assert "الكشف: #2980 صنف مضاف + كمية + سعر وحدة + صافي" ((@("item_added", "quantity", "unit_price", "net") | Where-Object { $editKinds -notcontains $_ }).Count -eq 0)
    Assert "الكشف: #2991 محذوفة بدليل السجل" ($byNumber[2991].kind -eq "deleted" -and $byNumber[2991].deletionLogged)
    Assert "الكشف: #2991 أُعيد إدخالها برقم #2992" ($byNumber[2991].reentry.number -eq 2992)
    Assert "الكشف: #2989 الرقم صار لفاتورة أخرى" (@($byNumber[2989].numberReusedBy).Count -eq 1 -and $byNumber[2989].numberReusedBy[0].guid -eq $gReuseNew)
    Assert "الكشف: #2989 لا تُعدّ إعادة إدخال (أصناف مختلفة)" ($null -eq $byNumber[2989].reentry)
    $current2 = @{}; foreach ($k in $current.Keys) { $current2[$k] = $current[$k] }; $current2.Remove($gReuseOld)
    $noLog = @(Get-CashierWatchFindings -Prints $prints -Current $current2 -LogEvidence @{} -Neighbours @{} -WatchStartUtc $start)
    Assert "الكشف: غياب بلا أثر في السجل ⇒ missing_unexplained لا «حذف» مفترض" ((@($noLog | Where-Object { $_.invoiceNumber -eq 2991 })[0]).kind -eq "missing_unexplained")
    $unposted = @{}; foreach ($k in $current.Keys) { $unposted[$k] = $current[$k] }
    $unposted[$gSame] = New-Current $gSame 2990 $baseLines $RATE $false
    Assert "الكشف: إلغاء الترحيل يُبلَّغ" (@(Get-CashierWatchFindings -Prints $prints -Current $unposted -LogEvidence @{} -WatchStartUtc $start | Where-Object { $_.invoiceNumber -eq 2990 -and $_.kind -eq "no_longer_cashier_posted" }).Count -eq 1)

    # ── رسالة التنبيه ──────────────────────────────────────────────────────
    $message = Format-CashierWatchAlert -Findings $findings -Zone $syria
    Assert "الرسالة: بلا اسم زبون" (-not $message.Contains($SECRET_CUSTOMER))
    Assert "الرسالة: الصافي قبل/بعد لـ#2980" ($message -match "#2980 — طُبعت 11-12 12:00 ثم عُدّلت" -and $message -match "الصافي: 706,482 ← ")
    Assert "الرسالة: سعر الوحدة 118,188 ← 116,130" ($message -match "118,188 ← 116,130")
    Assert "الرسالة: وقت الطباعة بتوقيت سوريا" ($message -match "#2991 — طُبعت 11-12 12:49")
    Assert "الرسالة: إعادة الإدخال #2992" ($message -match "#2992")
    Assert "الرسالة: تحذير الرقم المعاد استخدامه" ($message -match "الرقم #2989 صار لفاتورة أخرى")
    Assert "الرسالة: تصرّح بعدم الطباعة التلقائية" ($message -match "لا إعادة طباعة تلقائية")

    # ── منع التكرار والتجميع ───────────────────────────────────────────────
    $alerted = @{}
    $first = Select-CashierWatchAlerts $findings $alerted
    Assert "التكرار: كل الجديد مختار أول مرة" (@($first.Selected).Count -eq $findings.Count)
    foreach ($item in $first.Selected) { $alerted[[string]$item.Finding.invoiceGuid] = [ordered]@{ hash = $item.Hash } }
    Assert "التكرار: لا شيء ثانيةً لنفس الحال" (@((Select-CashierWatchAlerts $findings $alerted).Selected).Count -eq 0)
    $current[$gEdit] = New-Current $gEdit 2980 @((New-SnapshotLine $ITEM_A "اوسكار سليم فضي" 6 5.3))
    $again = @(Get-CashierWatchFindings -Prints $prints -Current $current -LogEvidence $logEvidence -Neighbours $neighbours -WatchStartUtc $start)
    $sel = Select-CashierWatchAlerts $again $alerted
    Assert "التكرار: تعديل جديد على الفاتورة نفسها يُبلَّغ وحده" (@($sel.Selected).Count -eq 1 -and $sel.Selected[0].Finding.invoiceNumber -eq 2980)
    $many = @(foreach ($i in 1..13) { [pscustomobject]@{ kind = "deleted"; invoiceGuid = [guid]::NewGuid().ToString(); invoiceNumber = 3000 + $i; printedAtUtc = "2026-11-12T09:00:00Z"
        printedNet = 1000; currencyIso = "SYP"; changes = @(); reentry = $null; numberReusedBy = @(); deletionLogged = $true } })
    $batch = Select-CashierWatchAlerts $many @{}
    Assert "التجميع: 10 في الرسالة والباقي للتالية" (@($batch.Selected).Count -eq 10 -and $batch.Remaining -eq 3)
    Assert "التجميع: الرسالة تذكر المؤجَّل" ((Format-CashierWatchAlert -Findings @($batch.Selected | ForEach-Object { $_.Finding }) -Zone $syria -Remaining $batch.Remaining) -match "و3 أخرى")

    # ── دليل Windows (ليس ورقياً) ──────────────────────────────────────────
    $summary = [pscustomobject]@{ jobId = 63 }
    $at = [datetime]"2026-11-12T09:52:11Z"
    $completions = @(
        [pscustomobject]@{ JobId = 63; Printer = "XPRINTER XP-T80Q 80MM"; AtUtc = [datetime]"2026-11-11T09:00:00Z" },
        [pscustomobject]@{ JobId = 63; Printer = "Xprinter XP-80"; AtUtc = [datetime]"2026-11-12T09:52:20Z" },
        [pscustomobject]@{ JobId = 63; Printer = "XPRINTER XP-T80Q 80MM"; AtUtc = [datetime]"2026-11-12T09:52:25Z" })
    $match = Find-CashierWatchSpoolerEvidence $summary $completions "XPRINTER XP-T80Q 80MM" $at
    Assert "Windows: يطابق رقم المهمة والطابعة والوقت معاً" ($null -ne $match -and $match.AtUtc -eq [datetime]"2026-11-12T09:52:25Z")
    Assert "Windows: رقم مهمة مكرر من يوم آخر لا يُعتمد" ($null -eq (Find-CashierWatchSpoolerEvidence $summary @($completions[0]) "XPRINTER XP-T80Q 80MM" $at))
    Assert "Windows: طابعة أخرى لا تُعتمد" ($null -eq (Find-CashierWatchSpoolerEvidence $summary @($completions[1]) "XPRINTER XP-T80Q 80MM" $at))

    # ── حارس القراءة فقط ───────────────────────────────────────────────────
    Assert "SQL: استعلام الحالية يمر بالحارس" (-not (Throws { Assert-CashierWatchSelectOnly (Get-CashierWatchCurrentSql 3) }))
    Assert "SQL: استعلام السجل يمر بالحارس" (-not (Throws { Assert-CashierWatchSelectOnly (Get-CashierWatchLogSql 2) }))
    Assert "SQL: استعلام الجيران يمر بالحارس" (-not (Throws { Assert-CashierWatchSelectOnly (Get-CashierWatchNeighbourSql) }))
    Assert "SQL: UPDATE مرفوض" (Throws { Assert-CashierWatchSelectOnly "select 1; update bu000 set Total = 0" })
    Assert "SQL: SELECT INTO مرفوض" (Throws { Assert-CashierWatchSelectOnly "select * into #x from bu000" })
    Assert "SQL: EXEC مرفوض" (Throws { Assert-CashierWatchSelectOnly "exec sp_who" })
    $libText = [IO.File]::ReadAllText((Join-Path $watchDir "cashier-receipt-watch-lib.ps1"))
    $cliText = [IO.File]::ReadAllText((Join-Path $watchDir "cashier-receipt-watch.ps1"))
    Assert "بنية: لا إعادة طباعة من المراقب" (-not ($libText + $cliText -match "Submit-OzkReceiptSpoolJob|Send-OzkReceiptToPrinter|PrintInvoice|cashier-reprint\.ps1"))
    Assert "بنية: لا يكتب paper_confirmed" (-not ($libText + $cliText -match '"paper_confirmed"'))

    # ── الحالة وتشغيل الأداة نفسها ─────────────────────────────────────────
    $statePath = Join-Path $tempRoot "watch\state.json"
    $state = New-CashierWatchState $start
    $state.alerted["x"] = [ordered]@{ hash = "abc"; kind = "edited"; number = 1; at = "2026-11-12T09:00:00Z" }
    Save-CashierWatchState $statePath $state
    $reloaded = Read-CashierWatchState $statePath ([datetime]::UtcNow)
    Assert "الحالة: تُقرأ كما حُفظت" (-not $reloaded.Initialized -and [string]$reloaded.State.alerted["x"].hash -eq "abc" -and $reloaded.State.watchStartUtc -eq $state.watchStartUtc)

    $psExe = (Get-Process -Id $PID).Path
    $freshRoot = Join-Path $tempRoot "fresh-archive"
    [void](New-PrintedInvoice $freshRoot $gEdit 2980 $baseLines ([datetime]::UtcNow.AddMinutes(-10)))
    $out1 = & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $watchDir "cashier-receipt-watch.ps1") -ArchiveRoot $freshRoot -NoTelegram 2>&1 | Out-String
    Assert "الأداة: أول تشغيل يسجّل نقطة البداية فقط" ($out1 -match '"Status":"initialized"' -and (Test-Path -LiteralPath (Join-Path $freshRoot "watch\state.json")))
    $out2 = & $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $watchDir "cashier-receipt-watch.ps1") -ArchiveRoot $freshRoot -NoTelegram -ConnectionEnvVar "OZK_TEST_NO_SUCH_VAR" 2>&1 | Out-String
    Assert "الأداة: إيصال أقدم من نقطة البداية لا يستدعي الأمين ولا ينبّه" ($out2 -match '"Status":"ok"' -and $out2 -match '"Compared":0' -and $out2 -match '"Alerted":0')
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
