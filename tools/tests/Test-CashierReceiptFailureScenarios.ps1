# سيناريوهات الأعطال لأرشيف إيصالات الكاشير — بلا طباعة (تحت Windows PowerShell 5.1 وPowerShell 7).
# الحالة والأرشيف ودوال الجسر حقيقية (مستخرجة من ozk-print-bridge.ps1 بمحلّل PowerShell)، والتسليم
# للطابعة دالة وهمية تعدّ «الأوراق». تسلسل المسار الآلي هنا هو نفسه المثبت ترتيبه نصياً في
# Test-CashierReceiptBridgeIntegration.ps1: أرشيف ← علامة print_in_flight ← تسليم ← submitted ← spooled.
# «إعادة التشغيل» = قراءة state.json من القرص من جديد كما يفعل الجسر عند الإقلاع.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bridgeDir = Join-Path $repoRoot "ozk-print-bridge"
$bridgePath = Join-Path $bridgeDir "ozk-print-bridge.ps1"
Import-Module (Join-Path $bridgeDir "OzkReceiptArchive.psm1") -Force -DisableNameChecking -Global
. (Join-Path (Join-Path (Join-Path $repoRoot "tools") "cashier-receipt-watch") "cashier-receipt-watch-lib.ps1")
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { $env:COMPUTERNAME = "TESTHOST" }

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

foreach ($typeName in @("OzkSpoolNotSubmittedException", "OzkReceiptUnrenderableException")) {
    if (-not ($typeName -as [type])) { Invoke-Expression ("class $typeName : System.Exception { $typeName([string]`$m) : base(`$m) { } }") }
}
$ast = [Management.Automation.Language.Parser]::ParseFile($bridgePath, [ref]$null, [ref]$null)
$functions = @{}
foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $functions[$f.Name] = $f.Extent.Text }
foreach ($name in @("New-EmptyState", "Read-BridgeState", "Write-BridgeState", "Merge-BridgeStateForWrite", "Persist-RetryablePrintRollback",
        "Should-SkipSeenInvoice", "Test-PreSubmissionFailure", "Get-BridgeSubmissionFailureStage", "Get-BridgeFileSha256",
        "Save-BridgeReceiptArchive", "Add-BridgeArchiveStage")) {
    if (-not $functions.ContainsKey($name)) { throw "Bridge function $name not found." }
    . ([scriptblock]::Create($functions[$name]))
}
function Write-BridgeLog($EventObject) { }
$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture
$PrinterName = "XPRINTER XP-T80Q 80MM"
$ReceiptArchiveMode = "Required"
$script:ReceiptModulePath = Join-Path $bridgeDir "OzkReceiptRenderer.psm1"

$RATE = 1.0 / 14700.0
function New-Snapshot([string]$Guid, [int]$Number) {
    $header = [pscustomobject]@{ InvoiceGuid = $Guid; InvoiceNumber = $Number; TypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"; InvoiceDate = "2026-11-12T00:00:00Z"
        CreateDate = "2026-11-12T09:52:08Z"; LastUpdateDate = $null; CustomerName = ""; InvoiceTotal = 15.9; TotalDiscount = 0.0; TotalExtra = 0.0; FirstPayment = 0.0
        CurrencyValue = $RATE; CurrencyIso = "SYP"; IsPosted = $true; RecordState = 0 }
    $line = [pscustomobject]@{ LineGuid = "l"; LineNumber = 0; ItemGuid = "a0000000-0000-0000-0000-00000000000a"; ItemNumber = "1"; ItemName = "صنف"; Qty = 3.0
        Qty2 = 0; Qty3 = 0; SelectedUnit = 1; RawPrice = 5.3; LineDiscount = 0.0; BonusDiscount = 0.0; LineExtra = 0.0; Unit2Factor = 50; Unit3Factor = $null }
    $receipt = [pscustomobject]@{ InvoiceNumber = $Number; Lines = @([pscustomobject]@{ Name = "صنف"; Quantity = 3.0; UnitPrice = 77910.0; Total = 233730.0 })
        GrossTotal = 233730.0; Discount = 0.0; TotalExtra = 0.0; NetTotal = 233730.0; Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = 0.0; BalanceFound = $false
        ItemCount = 1; TotalQuantity = 3.0; CurrencyIso = "SYP" }
    return [pscustomobject]@{ Snapshot = [pscustomobject]@{ Header = $header; Lines = @($line); LineCount = 1; Balance = $null; Signature = "sig" }; Receipt = $receipt }
}

# المسار الآلي بالترتيب الحقيقي، مع نقاط انقطاع مُحقنة. Submit: "ok" | "no_job" | "uncertain".
$script:sheets = 0
function Invoke-AutoPass([string]$StatePath, [string]$Guid, [int]$Number, [string]$CrashAt = "", [string]$Submit = "ok") {
    $state = Read-BridgeState $StatePath
    if (Should-SkipSeenInvoice $state.seen[$Guid] $true) { return "skipped" }
    $data = New-Snapshot $Guid $Number
    $job = [pscustomobject]@{ Payload = [byte[]](0x1B, 0x40); PrinterName = $PrinterName }
    $archive = $null
    try { $archive = Save-BridgeReceiptArchive "auto" $data.Snapshot $data.Receipt $job } catch { return "deferred_archive_failed" }
    if ($CrashAt -eq "after_archive") { throw "simulated power loss" }
    $state.seen[$Guid] = [ordered]@{ status = "print_in_flight"; invoiceNumber = $Number; observedAt = [datetime]::UtcNow.ToString("o"); lineCount = 1 }
    Merge-BridgeStateForWrite $StatePath $state
    if ($CrashAt -eq "after_marker") { throw "simulated power loss" }
    $result = $null
    try {
        switch ($Submit) {
            "no_job" { throw (New-Object OzkSpoolNotSubmittedException "OpenPrinter failed") }
            "uncertain" { $script:sheets++; throw (New-Object InvalidOperationException "WritePrinter failed mid-job") }
            default { $script:sheets++; $result = [pscustomobject]@{ JobId = 60 + $script:sheets } }
        }
    } catch {
        Add-BridgeArchiveStage $archive (Get-BridgeSubmissionFailureStage $_) $null ([string]$_.Exception.GetType().Name)
        if (Test-PreSubmissionFailure $_) {
            $rollback = Persist-RetryablePrintRollback $StatePath $state $Guid
            if (-not $rollback.Success) { throw $rollback.Error }
            return "failed_no_job_retryable"
        }
        return "uncertain_marker_kept"
    }
    if ($CrashAt -eq "after_submit") { throw "simulated power loss" }
    Add-BridgeArchiveStage $archive "submitted" $result.JobId
    $state.seen[$Guid] = [ordered]@{ status = "spooled"; invoiceNumber = $Number; observedAt = [datetime]::UtcNow.ToString("o"); lineCount = 1 }
    Merge-BridgeStateForWrite $StatePath $state
    return "spooled"
}
function Invoke-Pass([string]$StatePath, [string]$Guid, [int]$Number, [string]$CrashAt = "", [string]$Submit = "ok") {
    try { return (Invoke-AutoPass $StatePath $Guid $Number $CrashAt $Submit) } catch { if ([string]$_.Exception.Message -eq "simulated power loss") { return "crashed" } throw }
}
function Get-Stages([string]$Root, [string]$Guid) {
    return @(Get-OzkReceiptPrintSummaries $Root | Where-Object { $_.invoiceGuid -eq $Guid } | ForEach-Object { (@($_.stages) -join ">") })
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("receipt-failure-test-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Force -Path $tempRoot)
try {
    $later = [datetime]::UtcNow.AddMinutes(30)
    $epoch = [datetime]::UtcNow.AddHours(-1)

    # 1) تعذّر كتابة الأرشيف ⇒ لا علامة ولا ورق، ثم بعد إصلاح المسار ورقة واحدة فقط.
    $script:sheets = 0
    $state1 = Join-Path $tempRoot "s1\state.json"
    $ReceiptArchiveRoot = Join-Path $tempRoot "blocked.txt"; [IO.File]::WriteAllText($ReceiptArchiveRoot, "not a folder")
    $r1 = Invoke-Pass $state1 "10000000-0000-0000-0000-000000000001" 3001
    $r2 = Invoke-Pass $state1 "10000000-0000-0000-0000-000000000001" 3001
    Assert "أرشيف معطّل: الطباعة تُؤجَّل بلا ورق" ($r1 -eq "deferred_archive_failed" -and $r2 -eq "deferred_archive_failed" -and $script:sheets -eq 0)
    Assert "أرشيف معطّل: لا علامة في state.json (تُعاد لاحقاً)" (-not (Test-Path -LiteralPath $state1) -or -not (Read-BridgeState $state1).seen.ContainsKey("10000000-0000-0000-0000-000000000001"))
    $ReceiptArchiveRoot = Join-Path $tempRoot "a1"
    $r3 = Invoke-Pass $state1 "10000000-0000-0000-0000-000000000001" 3001
    $r4 = Invoke-Pass $state1 "10000000-0000-0000-0000-000000000001" 3001
    Assert "أرشيف معطّل ثم أُصلح: ورقة واحدة، والتشغيل التالي يتخطّاها" ($r3 -eq "spooled" -and $r4 -eq "skipped" -and $script:sheets -eq 1)

    # 2) انقطاع بين الأرشفة والعلامة ⇒ بعد الإقلاع تُطبع مرة واحدة؛ النسخة اليتيمة لا تُبلَّغ.
    $script:sheets = 0
    $ReceiptArchiveRoot = Join-Path $tempRoot "a2"; $state2 = Join-Path $tempRoot "s2\state.json"
    $g2 = "20000000-0000-0000-0000-000000000002"
    $c = Invoke-Pass $state2 $g2 3002 "after_archive"
    $p1 = Invoke-Pass $state2 $g2 3002
    $p2 = Invoke-Pass $state2 $g2 3002
    Assert "انقطاع قبل العلامة: ورقة واحدة بعد الإقلاع" ($c -eq "crashed" -and $p1 -eq "spooled" -and $p2 -eq "skipped" -and $script:sheets -eq 1)
    Assert "انقطاع قبل العلامة: الأرشيف = نسخة يتيمة + نسخة مطبوعة" ((@(Get-Stages $ReceiptArchiveRoot $g2) | Sort-Object) -join "|" -eq "prepared|prepared>submitted")
    Assert "انقطاع قبل العلامة: لا تنبيه «نتيجة مجهولة» لأن الفاتورة طُبعت بعدها" (@(Get-CashierWatchUnknownOutcomes @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot) $later $epoch).Count -eq 0)

    # 3) انقطاع بعد العلامة وقبل التسليم ⇒ لا طباعة تلقائية أبداً (لا تكرار)، والمراقب يكشفها.
    $script:sheets = 0
    $ReceiptArchiveRoot = Join-Path $tempRoot "a3"; $state3 = Join-Path $tempRoot "s3\state.json"
    $g3 = "30000000-0000-0000-0000-000000000003"
    $c = Invoke-Pass $state3 $g3 3003 "after_marker"
    $p = @(1..3 | ForEach-Object { Invoke-Pass $state3 $g3 3003 })
    Assert "انقطاع بعد العلامة: صفر ورق في كل إقلاع لاحق" ($c -eq "crashed" -and (@($p | Select-Object -Unique) -join ",") -eq "skipped" -and $script:sheets -eq 0)
    $unknown = @(Get-CashierWatchUnknownOutcomes @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot) $later $epoch)
    Assert "انقطاع بعد العلامة: المراقب يُبلغ «نتيجة مجهولة» لهذه الطباعة" ($unknown.Count -eq 1 -and $unknown[0].invoiceNumber -eq 3003)
    Assert "انقطاع بعد العلامة: لا تنبيه قبل مرور 10 دقائق" (@(Get-CashierWatchUnknownOutcomes @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot) ([datetime]::UtcNow) $epoch).Count -eq 0)

    # 4) فشل مثبت قبل إنشاء المهمة ⇒ تراجع العلامة، والمحاولة التالية ورقة واحدة.
    $script:sheets = 0
    $ReceiptArchiveRoot = Join-Path $tempRoot "a4"; $state4 = Join-Path $tempRoot "s4\state.json"
    $g4 = "40000000-0000-0000-0000-000000000004"
    $f = Invoke-Pass $state4 $g4 3004 "" "no_job"
    $ok = Invoke-Pass $state4 $g4 3004
    $again = Invoke-Pass $state4 $g4 3004
    Assert "فشل قبل المهمة: يُعاد مرة واحدة فقط" ($f -eq "failed_no_job_retryable" -and $ok -eq "spooled" -and $again -eq "skipped" -and $script:sheets -eq 1)
    Assert "فشل قبل المهمة: المراحل مسجّلة كما وقعت" ((@(Get-Stages $ReceiptArchiveRoot $g4) | Sort-Object) -join "|" -eq "prepared>submit_failed_no_job|prepared>submitted")
    Assert "فشل قبل المهمة: لا «نتيجة مجهولة»" (@(Get-CashierWatchUnknownOutcomes @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot) $later $epoch).Count -eq 0)

    # 5) فشل غامض بعد بدء المهمة ⇒ العلامة تبقى، فلا ورقة ثانية بعد أي إقلاع.
    $script:sheets = 0
    $ReceiptArchiveRoot = Join-Path $tempRoot "a5"; $state5 = Join-Path $tempRoot "s5\state.json"
    $g5 = "50000000-0000-0000-0000-000000000005"
    $u = Invoke-Pass $state5 $g5 3005 "" "uncertain"
    $p = @(1..3 | ForEach-Object { Invoke-Pass $state5 $g5 3005 })
    Assert "فشل غامض: ورقة واحدة على الأكثر مهما تكرر الإقلاع" ($u -eq "uncertain_marker_kept" -and (@($p | Select-Object -Unique) -join ",") -eq "skipped" -and $script:sheets -eq 1)
    Assert "فشل غامض: مرحلة submit_uncertain تُعدّ وصولاً لـWindows (مقارنة بعد الطباعة)" (Test-OzkReceiptReachedSpooler @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot)[0])

    # 6) انقطاع بعد التسليم وقبل تسجيله ⇒ لا ورقة ثانية، والمراقب يطلب التحقق.
    $script:sheets = 0
    $ReceiptArchiveRoot = Join-Path $tempRoot "a6"; $state6 = Join-Path $tempRoot "s6\state.json"
    $g6 = "60000000-0000-0000-0000-000000000006"
    $c = Invoke-Pass $state6 $g6 3006 "after_submit"
    $p = Invoke-Pass $state6 $g6 3006
    Assert "انقطاع بعد التسليم: ورقة واحدة فقط" ($c -eq "crashed" -and $p -eq "skipped" -and $script:sheets -eq 1)
    Assert "انقطاع بعد التسليم: «نتيجة مجهولة» تطلب التحقق" (@(Get-CashierWatchUnknownOutcomes @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot) $later $epoch).Count -eq 1)

    # 7) نجاح ثم إقلاعات متكررة ⇒ ورقة واحدة وسلسلة البصمات سليمة في كل الأرشيفات.
    $script:sheets = 0
    $ReceiptArchiveRoot = Join-Path $tempRoot "a7"; $state7 = Join-Path $tempRoot "s7\state.json"
    $g7 = "70000000-0000-0000-0000-000000000007"
    $p = @(1..5 | ForEach-Object { Invoke-Pass $state7 $g7 3007 })
    Assert "إقلاعات متكررة: ورقة واحدة" ($p[0] -eq "spooled" -and @($p | Where-Object { $_ -eq "skipped" }).Count -eq 4 -and $script:sheets -eq 1)
    $allOk = $true
    foreach ($n in 2..7) { if (-not (Test-OzkReceiptArchiveIntegrity (Join-Path $tempRoot "a$n")).Ok) { $allOk = $false } }
    Assert "كل الأرشيفات بعد الانقطاعات: سلسلة وبصمات سليمة" $allOk

    # 8) تنبيه «النتيجة المجهولة» لا يتكرر، ولا يتناوب مع تنبيه آخر للفاتورة نفسها.
    $ReceiptArchiveRoot = Join-Path $tempRoot "a3"
    $findings = @(Get-CashierWatchUnknownOutcomes @(Get-OzkReceiptPrintSummaries $ReceiptArchiveRoot) $later $epoch)
    $edited = [pscustomobject]@{ kind = "edited"; invoiceGuid = $g3; invoiceNumber = 3003; printId = "x"; printedAtUtc = $later.ToString("o"); printedNet = 1; currencyIso = "SYP"
        changes = @([ordered]@{ kind = "net"; from = 1; to = 2; delta = 1 }); reentry = $null; numberReusedBy = @(); deletionLogged = $false }
    $alerted = @{}
    $first = Select-CashierWatchAlerts (@($findings) + $edited) $alerted
    foreach ($item in $first.Selected) { $alerted[(Get-CashierWatchAlertKey $item.Finding)] = [ordered]@{ hash = $item.Hash } }
    Assert "تكرار: الحالان مختاران مرة واحدة" (@($first.Selected).Count -eq 2)
    Assert "تكرار: لا شيء في التشغيل التالي ولا تناوب" (@((Select-CashierWatchAlerts (@($findings) + $edited) $alerted).Selected).Count -eq 0)
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
