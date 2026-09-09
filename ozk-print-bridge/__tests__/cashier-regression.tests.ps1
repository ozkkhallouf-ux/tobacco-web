<#
.SYNOPSIS
  اختبارات regression لمسار طباعة فواتير الكاشير (XPrinter) — بلا اتصال SQL،
  بلا Scheduled Task، بلا طباعة فعلية فيزيائية، وبلا تشغيل أي حلقة رئيسية.

.DESCRIPTION
  - Send-OzkReceiptToPrinter تُختبر عبر Import-Module الحقيقي لـ OzkReceiptRenderer.psm1
    (الملف آمن للاستيراد: لا اتصال SQL ولا طباعة عند وقت الـimport نفسه).
  - Get-InvoiceFingerprint و Remove-StaleFingerprints تُستخرجان نصياً من المصدر
    الفعلي الحالي لـ ozk-print-bridge.ps1 (الذي يحتوي كوداً غير آمن للتنفيذ
    المباشر على مستوى الوحدة: اتصال SQL وحلقة لا نهائية) وتُشغَّلان بمعزل تام،
    لتفادي اختبار نسخة مكرّرة قد تنحرف عن الأصل.
  - الفحوص البنيوية (regex) على مصدر ozk-print-bridge-watchdog.ps1 تتحقق من أن
    -IncludeWholesale معطّل افتراضياً وأنه لا يُمرَّر إلا صراحةً.

.NOTES
  تشغيل:
    powershell -NoProfile -ExecutionPolicy Bypass -File ozk-print-bridge\__tests__\cashier-regression.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeDir = Split-Path -Parent $here

$script:passed = 0
$script:failed = 0

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "  OK  $Name"
    } catch {
        $script:failed++
        Write-Host "  FAIL $Name"
        Write-Host "        $($_.Exception.Message)"
    }
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws([scriptblock]$Body, [string]$Message) {
    $threw = $false
    try { & $Body } catch { $threw = $true }
    if (-not $threw) { throw "Assertion failed (expected throw): $Message" }
}

# ─── استخراج نصّي لدالة من مصدر ozk-print-bridge.ps1 (لا تنفيذ للملف كاملاً) ───
function Get-ExtractedFunctionText([string]$SourceText, [string]$Signature) {
    $startIdx = $SourceText.IndexOf($Signature)
    Assert-True ($startIdx -ge 0) "لم يُعثر على التوقيع: $Signature"
    $braceOpen = $SourceText.IndexOf("{", $startIdx)
    $endMarker = "`n}`n"
    $endIdx = $SourceText.IndexOf($endMarker, $braceOpen)
    Assert-True ($endIdx -ge 0) "تعذّر تحديد نهاية الدالة لـ: $Signature"
    return $SourceText.Substring($startIdx, ($endIdx + 2) - $startIdx)
}

$bridgeSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge.ps1") -Raw
$watchdogSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge-watchdog.ps1") -Raw

$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture

# تُستخرج كل دوال التمثيل القانوني من المصدر الفعلي، فما يُختبر هنا هو العقد
# نفسه الذي يعمل في الإنتاج لا نسخة موازية منه.
foreach ($signature in @(
    "function Format-CanonicalValue(`$Value) {",
    "function Get-CanonicalLineText(`$Line, [bool]`$IncludeRecordIdentity) {",
    "function Get-CanonicalReceiptText(`$Header, `$Lines, [bool]`$IncludeRecordIdentity, [string]`$BranchGuid = `"`") {",
    "function Get-CanonicalHash([string]`$Text) {",
    "function Get-InvoiceFingerprint(`$Candidate, `$Snapshot) {",
    "function Remove-StaleFingerprints(`$RecentFingerprints, [datetime]`$Now, [int]`$MaxAgeSeconds) {"
)) {
    . ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc $signature)))
}

Write-Host "== cashier-regression: التمثيل القانوني لمحتوى الإيصال (المصدر الفعلي) =="

function New-TestLine {
    param(
        [string]$ItemGuid = "M-1", [string]$ItemName = "مادة أ",
        [double]$Qty = 2, [double]$RawPrice = 500,
        [string]$LineGuid = "L-1", [int]$LineNumber = 1,
        [double]$SelectedUnit = 1, [double]$Unit2Factor = 0
    )
    [pscustomobject]@{
        LineGuid = $LineGuid; LineNumber = $LineNumber
        ItemGuid = $ItemGuid; ItemName = $ItemName
        Qty = $Qty; SelectedUnit = $SelectedUnit; Unit2Factor = $Unit2Factor; RawPrice = $RawPrice
    }
}

function New-Snapshot {
    param(
        [string]$TypeGuid = "TYPE-A", [int]$InvoiceNumber = 1001,
        [string]$InvoiceDate = "2026-01-05T00:00:00.0000000Z",
        [string]$CreateDate = "2026-01-05T10:00:00.0000000Z",
        [string]$CustomerName = "زبون تجريبي",
        [double]$InvoiceTotal = 1500.5, [double]$TotalDiscount = 0,
        [double]$TotalExtra = 0, [double]$FirstPayment = 0,
        [double]$CurrencyValue = 1, [string]$CurrencyIso = "USD",
        [string]$InvoiceGuid = "INV-1", [bool]$IsPosted = $true, [int]$RecordState = 0,
        $Lines = $null
    )
    if ($null -eq $Lines) {
        $Lines = @(
            (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 2 -RawPrice 500   -LineGuid "L-1" -LineNumber 1),
            (New-TestLine -ItemGuid "M-2" -ItemName "مادة ب" -Qty 1 -RawPrice 500.5 -LineGuid "L-2" -LineNumber 2)
        )
    }
    [pscustomobject]@{
        Header = [pscustomobject]@{
            InvoiceGuid = $InvoiceGuid; TypeGuid = $TypeGuid; InvoiceNumber = $InvoiceNumber
            InvoiceDate = $InvoiceDate; CreateDate = $CreateDate; CustomerName = $CustomerName
            InvoiceTotal = $InvoiceTotal; TotalDiscount = $TotalDiscount; TotalExtra = $TotalExtra
            FirstPayment = $FirstPayment; CurrencyValue = $CurrencyValue; CurrencyIso = $CurrencyIso
            IsPosted = $IsPosted; RecordState = $RecordState
        }
        Lines = @($Lines)
        LineCount = @($Lines).Count
    }
}

function Get-ReadinessSignature($Snapshot) {
    return Get-CanonicalHash (Get-CanonicalReceiptText $Snapshot.Header $Snapshot.Lines $true)
}

$script:Cand = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "INV-1" }

Test-Case "التمثيل القانوني لا يعتمد على الثقافة المحلية (أرقام بثقافة ثابتة)" {
    Assert-True ($bridgeSrc -match '\$script:InvariantCulture = \[Globalization\.CultureInfo\]::InvariantCulture') "يجب تثبيت الثقافة"
    Assert-True ($bridgeSrc -match 'ToString\("R", \$script:InvariantCulture\)') "تنسيق الأرقام يجب أن يكون بثقافة ثابتة"
    $saved = [Threading.Thread]::CurrentThread.CurrentCulture
    try {
        [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo("de-DE")
        $a = Format-CanonicalValue 1500.5
        [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
        $b = Format-CanonicalValue 1500.5
        Assert-True ($a -eq $b) "الفاصلة العشرية الألمانية يجب ألا تغيّر التمثيل: [$a] مقابل [$b]"
        Assert-True ($a -eq "1500.5") "يجب أن يكون التمثيل بنقطة عشرية: [$a]"
    } finally {
        [Threading.Thread]::CurrentThread.CurrentCulture = $saved
    }
}

Write-Host "`n== P1-G: توقيع الاستقرار يغطي كل ما يُطبع لا الأسطر وحدها =="

# كل حقل هنا يقرأه Convert-SnapshotToReceipt ويظهر على الورق. تغيّره بين
# لقطتَي Wait-InvoiceReady يعني أن الترحيل لم ينتهِ، فيجب ألا تُعتبر مستقرة.
$headerWitnesses = @(
    @{ Name = "CustomerName";  Args = @{ CustomerName  = "زبون آخر" } },
    @{ Name = "InvoiceTotal";  Args = @{ InvoiceTotal  = 1600.0 } },
    @{ Name = "TotalDiscount"; Args = @{ TotalDiscount = 25.0 } },
    @{ Name = "TotalExtra";    Args = @{ TotalExtra    = 10.0 } },
    @{ Name = "FirstPayment";  Args = @{ FirstPayment  = 300.0 } },
    @{ Name = "CurrencyValue"; Args = @{ CurrencyValue = 14050.0 } },
    @{ Name = "CurrencyIso";   Args = @{ CurrencyIso   = "SYP" } },
    @{ Name = "CreateDate";    Args = @{ CreateDate    = "2026-01-05T11:30:00.0000000Z" } },
    @{ Name = "InvoiceDate";   Args = @{ InvoiceDate   = "2026-01-06T00:00:00.0000000Z" } },
    @{ Name = "InvoiceNumber"; Args = @{ InvoiceNumber = 1002 } },
    @{ Name = "IsPosted";      Args = @{ IsPosted      = $false } },
    @{ Name = "RecordState";   Args = @{ RecordState   = 1 } }
)

foreach ($witness in $headerWitnesses) {
    $witnessName = $witness.Name
    $witnessArgs = $witness.Args
    Test-Case "توقيع الاستقرار يلتقط تغيّر $witnessName بين اللقطتين" {
        $a = New-Snapshot
        $b = New-Snapshot @witnessArgs
        Assert-True ((Get-ReadinessSignature $a) -ne (Get-ReadinessSignature $b)) "تغيّر $witnessName يجب أن يجعل اللقطتين غير مستقرتين"
    }
}

Test-Case "توقيع الاستقرار يلتقط تغيّر محتوى سطر (اسم المادة)" {
    $a = New-Snapshot
    $b = New-Snapshot -Lines @(
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة مختلفة" -Qty 2 -RawPrice 500 -LineGuid "L-1" -LineNumber 1),
        (New-TestLine -ItemGuid "M-2" -ItemName "مادة ب" -Qty 1 -RawPrice 500.5 -LineGuid "L-2" -LineNumber 2)
    )
    Assert-True ((Get-ReadinessSignature $a) -ne (Get-ReadinessSignature $b)) "تغيّر اسم المادة يجب أن يكسر الاستقرار"
}

Test-Case "توقيع الاستقرار يلتقط تبديل ترتيب الأسطر (الترتيب مطبوع)" {
    $a = New-Snapshot
    $b = New-Snapshot -Lines @(
        (New-TestLine -ItemGuid "M-2" -ItemName "مادة ب" -Qty 1 -RawPrice 500.5 -LineGuid "L-2" -LineNumber 2),
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 2 -RawPrice 500   -LineGuid "L-1" -LineNumber 1)
    )
    Assert-True ((Get-ReadinessSignature $a) -ne (Get-ReadinessSignature $b)) "تبديل الترتيب يجب أن يكسر الاستقرار"
}

Test-Case "لقطتان متطابقتان فعلاً → مستقرة (لا حساسية زائفة)" {
    $a = New-Snapshot
    $b = New-Snapshot
    Assert-True ((Get-ReadinessSignature $a) -eq (Get-ReadinessSignature $b)) "لقطتان متطابقتان يجب أن تعطيا التوقيع نفسه"
}

Test-Case "negative witness: توقيع مبني على الأسطر وحدها يفوّت كل حقول الترويسة" {
    # النسخة القديمة: هاش لحقول الأسطر فقط. كل شواهد الترويسة تمرّ عليها.
    $legacy = {
        param($Snapshot)
        $src = @($Snapshot.Lines | ForEach-Object {
            "{0}|{1}|{2}|{3}|{4}" -f $_.LineGuid, $_.LineNumber, $_.Qty, $_.RawPrice, $_.SelectedUnit
        }) -join "`n"
        return Get-CanonicalHash $src
    }
    $a = New-Snapshot
    $missed = 0
    foreach ($witness in $headerWitnesses) {
        $b = New-Snapshot @($witness.Args)[0]
        if ((& $legacy $a) -eq (& $legacy $b)) { $missed++ }
    }
    Assert-True ($missed -eq $headerWitnesses.Count) "التوقيع القديم يجب أن يفوّت كل الحقول الـ$($headerWitnesses.Count)، فوّت: $missed"
    foreach ($witness in $headerWitnesses) {
        $b = New-Snapshot @($witness.Args)[0]
        Assert-True ((Get-ReadinessSignature $a) -ne (Get-ReadinessSignature $b)) "التوقيع الحالي يجب أن يلتقط $($witness.Name)"
    }
}

Write-Host "`n== P1-H: بصمة التكرار تعتمد المحتوى المطبوع لا الإجمالي وعدد الأسطر =="

Test-Case "A) نفس المحتوى تماماً → نفس البصمة (قمع التكرار يبقى عاملاً)" {
    $a = New-Snapshot -InvoiceGuid "AAAA-1111"
    $b = New-Snapshot -InvoiceGuid "BBBB-2222"
    $candA = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "AAAA-1111" }
    $candB = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "BBBB-2222" }
    Assert-True ((Get-InvoiceFingerprint $candA $a) -eq (Get-InvoiceFingerprint $candB $b)) "إعادة حفظ نفس البيعة يجب أن تعطي البصمة نفسها"
}

Test-Case "بصمة التكرار لا تعتمد على GUID الفاتورة ولا GUID الأسطر ولا CreateDate" {
    $a = New-Snapshot -InvoiceGuid "AAAA-1111" -CreateDate "2026-01-05T10:00:00.0000000Z" -Lines @(
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 2 -RawPrice 500 -LineGuid "L-OLD-1" -LineNumber 1))
    $b = New-Snapshot -InvoiceGuid "BBBB-2222" -CreateDate "2026-01-05T10:00:41.0000000Z" -Lines @(
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 2 -RawPrice 500 -LineGuid "L-NEW-9" -LineNumber 7))
    $candA = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "AAAA-1111" }
    $candB = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "BBBB-2222" }
    Assert-True ((Get-InvoiceFingerprint $candA $a) -eq (Get-InvoiceFingerprint $candB $b)) "ما يُولَّد عند إعادة الحفظ يجب ألا يدخل في البصمة"
}

Test-Case "B) نفس الإجمالي وعدد الأسطر لكن المادة تغيّرت → بصمة مختلفة" {
    $a = New-Snapshot -Lines @(
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 1 -RawPrice 1000 -LineGuid "L-1" -LineNumber 1))
    $b = New-Snapshot -Lines @(
        (New-TestLine -ItemGuid "M-9" -ItemName "مادة مختلفة" -Qty 1 -RawPrice 1000 -LineGuid "L-1" -LineNumber 1))
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand $b)) "تبديل المادة بأخرى بنفس السعر يجب ألا يُقمع"
}

Test-Case "C) نفس الإجمالي وعدد الأسطر لكن الكمية والسعر تبادلا → بصمة مختلفة" {
    $a = New-Snapshot -Lines @(
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 2 -RawPrice 500 -LineGuid "L-1" -LineNumber 1))
    $b = New-Snapshot -Lines @(
        (New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 5 -RawPrice 200 -LineGuid "L-1" -LineNumber 1))
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand $b)) "تبادل الكمية والسعر مع ثبات الحاصل يجب ألا يُقمع"
}

Test-Case "D) تغيّر اسم الزبون → بصمة مختلفة" {
    $a = New-Snapshot
    $b = New-Snapshot -CustomerName "زبون آخر"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand $b)) "اسم الزبون مطبوع فيجب أن يدخل في البصمة"
}

Test-Case "E) تغيّر العملة (سعر الصرف أو ISO) → بصمة مختلفة" {
    $a = New-Snapshot
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand (New-Snapshot -CurrencyValue 14050.0))) "سعر الصرف يقسم كل مبلغ مطبوع"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand (New-Snapshot -CurrencyIso "SYP"))) "ISO العملة يرافق الأرقام المعروضة"
}

Test-Case "الخصم والدفعة والإضافات تدخل في البصمة (كلها مطبوعة)" {
    $a = New-Snapshot
    foreach ($variant in @(@{TotalDiscount=25.0}, @{FirstPayment=300.0}, @{TotalExtra=10.0})) {
        $b = New-Snapshot @variant
        Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand $b)) "تغيّر $($variant.Keys) يجب أن يغيّر البصمة"
    }
}

Test-Case "F) نفس المحتوى بعد إعادة التشغيل → البصمة نفسها (حتمية عبر العمليات)" {
    $a = New-Snapshot
    $first = Get-InvoiceFingerprint $script:Cand $a

    # تُحسب البصمة في عملية pwsh جديدة تماماً من نفس المصدر ونفس المدخلات.
    # أي اعتماد على حالة العملية أو ترتيب تعداد أو ثقافة محلية سيظهر هنا.
    $runner = Join-Path ([IO.Path]::GetTempPath()) ("ozk-fp-" + [guid]::NewGuid().ToString("N") + ".ps1")
    $snapshotJson = $a | ConvertTo-Json -Depth 8 -Compress
    $payload = @'
param([string]$BridgePath, [string]$SnapshotJson)
$ErrorActionPreference = "Stop"
$bridgeSrc = Get-Content -Raw -LiteralPath $BridgePath
function Get-Fn([string]$Signature) {
    $s = $bridgeSrc.IndexOf($Signature)
    $b = $bridgeSrc.IndexOf("{", $s)
    $e = $bridgeSrc.IndexOf("`n}`n", $b)
    return $bridgeSrc.Substring($s, ($e + 2) - $s)
}
$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture
foreach ($signature in @(
    'function Format-CanonicalValue($Value) {',
    'function Get-CanonicalLineText($Line, [bool]$IncludeRecordIdentity) {',
    'function Get-CanonicalReceiptText($Header, $Lines, [bool]$IncludeRecordIdentity, [string]$BranchGuid = "") {',
    'function Get-CanonicalHash([string]$Text) {',
    'function Get-InvoiceFingerprint($Candidate, $Snapshot) {'
)) { . ([scriptblock]::Create((Get-Fn $signature))) }
$snapshot = $SnapshotJson | ConvertFrom-Json
Get-InvoiceFingerprint ([pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "INV-1" }) $snapshot
'@
    try {
        Set-Content -LiteralPath $runner -Value $payload -Encoding utf8
        $bridgePath = Join-Path $bridgeDir "ozk-print-bridge.ps1"
        $second = (& pwsh -NoProfile -File $runner $bridgePath $snapshotJson) 2>&1
        Assert-True ($first -eq ([string]$second).Trim()) "البصمة يجب أن تتطابق عبر عملية جديدة: [$first] مقابل [$second]"
    } finally {
        if (Test-Path -LiteralPath $runner) { Remove-Item -LiteralPath $runner -Force }
    }
}

Test-Case "G) لا انحدار في التكرار الطبيعي: اختلاف الفرع أو النوع أو الرقم يغيّر البصمة" {
    $a = New-Snapshot
    $candOther = [pscustomobject]@{ BranchGuid = "BR-2"; InvoiceGuid = "INV-1" }
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $candOther $a)) "الفرع يجب أن يميّز"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand (New-Snapshot -TypeGuid "TYPE-B"))) "النوع يجب أن يميّز"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand (New-Snapshot -InvoiceNumber 1002))) "رقم الفاتورة يجب أن يميّز"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand (New-Snapshot -InvoiceDate "2026-01-06T00:00:00.0000000Z"))) "التاريخ يجب أن يميّز"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand (New-Snapshot -Lines @((New-TestLine))))) "عدد الأسطر يجب أن يميّز"
}

Test-Case "negative witness: بصمة الإجمالي+العدد وحدهما تقمع فاتورة مصحَّحة" {
    # النسخة القديمة: النوع|الرقم|التاريخ|الفرع|الزبون|الإجمالي|عدد الأسطر
    $legacy = {
        param($Cand, $Snapshot)
        $h = $Snapshot.Header
        $d = ([datetime]::Parse([string]$h.InvoiceDate)).ToString("yyyy-MM-dd")
        $raw = "{0}|{1}|{2}|{3}|{4}|{5:F2}|{6}" -f $h.TypeGuid, $h.InvoiceNumber, $d, $Cand.BranchGuid, $h.CustomerName, [double]$h.InvoiceTotal, $Snapshot.LineCount
        return Get-CanonicalHash $raw
    }
    $a = New-Snapshot -Lines @((New-TestLine -ItemGuid "M-1" -ItemName "مادة أ" -Qty 1 -RawPrice 1000 -LineGuid "L-1" -LineNumber 1))
    $b = New-Snapshot -Lines @((New-TestLine -ItemGuid "M-9" -ItemName "مادة مختلفة" -Qty 1 -RawPrice 1000 -LineGuid "L-1" -LineNumber 1))
    Assert-True ((& $legacy $script:Cand $a) -eq (& $legacy $script:Cand $b)) "البصمة القديمة يجب أن تعتبرهما متطابقتين — وهذا هو العطل"
    Assert-True ((Get-InvoiceFingerprint $script:Cand $a) -ne (Get-InvoiceFingerprint $script:Cand $b)) "البصمة الحالية يجب أن تميّزهما"
}

Write-Host "`n== cashier-regression: Remove-StaleFingerprints =="

Test-Case "Remove-StaleFingerprints تحذف الإدخالات الأقدم من النافذة الزمنية فقط" {
    $now = [datetime]::UtcNow
    $recent = @{
        "fp-old" = [pscustomobject]@{ printedAt = $now.AddSeconds(-4000).ToString("o") }
        "fp-new" = [pscustomobject]@{ printedAt = $now.AddSeconds(-10).ToString("o") }
    }
    Remove-StaleFingerprints $recent $now 3600
    Assert-True (-not $recent.ContainsKey("fp-old")) "الإدخال القديم (أقدم من 3600 ثانية) يجب أن يُحذف"
    Assert-True ($recent.ContainsKey("fp-new")) "الإدخال الحديث يجب أن يبقى"
}

Test-Case "Remove-StaleFingerprints تحذف الإدخالات ذات تاريخ غير صالح (تعامل آمن مع بيانات تالفة)" {
    $now = [datetime]::UtcNow
    $recent = @{ "fp-bad" = [pscustomobject]@{ printedAt = "ليس تاريخاً صالحاً" } }
    Remove-StaleFingerprints $recent $now 3600
    Assert-True (-not $recent.ContainsKey("fp-bad")) "تاريخ تالف يجب أن يُعامل كمنتهي الصلاحية ويُحذف بأمان"
}

Write-Host "`n== cashier-regression: Send-OzkReceiptToPrinter (استيراد حقيقي لـ OzkReceiptRenderer.psm1) =="

Import-Module (Join-Path $bridgeDir "OzkReceiptRenderer.psm1") -Force

Test-Case "رفض الطباعة بلا -ConfirmPhysicalPrint حتى لو كان اسم الطابعة صحيحاً (قبل أي CIM/طباعة)" {
    Assert-Throws {
        Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath "C:\nonexistent.png" -PrinterName "XPRINTER XP-T80Q 80MM"
    } "يجب رفض الطباعة بدون -ConfirmPhysicalPrint"
}

Test-Case "رفض أي طابعة غير XPRINTER XP-T80Q 80MM حتى مع -ConfirmPhysicalPrint (لا fallback افتراضي/معاد توجيهه)" {
    Assert-Throws {
        Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath "C:\nonexistent.png" -PrinterName "Microsoft Print to PDF" -ConfirmPhysicalPrint
    } "يجب رفض أي طابعة غير XPRINTER XP-T80Q 80MM"
}

Test-Case "رفض تطابق بحالة أحرف مختلفة (case-sensitive) — لا تساهل في اسم الطابعة" {
    Assert-Throws {
        Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath "C:\nonexistent.png" -PrinterName "xprinter xp-t80q 80mm" -ConfirmPhysicalPrint
    } "المطابقة يجب أن تكون حساسة لحالة الأحرف (-cne)، فلا يُقبل اسم بحالة أحرف مختلفة"
}

Write-Host "`n== cashier-regression: فحوص بنيوية على المصدر الحالي (نصّية) =="

Test-Case "watchdog: اسم الطابعة الافتراضي للكاشير هو XPRINTER XP-T80Q 80MM" {
    Assert-True ($watchdogSrc -match '\[string\]\$PrinterName = "XPRINTER XP-T80Q 80MM"') "يجب أن يكون الافتراضي XPRINTER XP-T80Q 80MM"
}

Test-Case "watchdog: -IncludeWholesale معرّف كـ switch (معطّل افتراضياً ما لم يُمرَّر صراحةً)" {
    Assert-True ($watchdogSrc -match '\[switch\]\$IncludeWholesale') "يجب أن يكون IncludeWholesale من نوع switch لا قيمة افتراضية True"
}

Test-Case "watchdog: تمرير IncludeWholesale إلى bridgeParameters مشروط صراحةً بـ if (`$IncludeWholesale)" {
    Assert-True ($watchdogSrc -match 'if \(\$IncludeWholesale\) \{ \$bridgeParameters\.IncludeWholesale = \$true \}') "يجب أن يكون التمرير مشروطاً فقط، بلا تفعيل افتراضي"
}

Test-Case "watchdog: حارس صريح يرفض أي طابعة غير XPRINTER XP-T80Q 80MM (بلا fallback)" {
    Assert-True ($watchdogSrc -match '(?s)if \(\$PrinterName -cne "XPRINTER XP-T80Q 80MM"\)\s*\{\s*throw') "يجب وجود حارس case-sensitive صريح يرمي عند أي اسم مختلف"
}

# ─── استخراج نصّي لتعريف متغيّر على مستوى السكربت (سطر واحد أو مصفوفة) ───
function Get-ExtractedAssignmentText([string]$SourceText, [string]$VariableName) {
    $startIdx = $SourceText.IndexOf($VariableName + " = ")
    Assert-True ($startIdx -ge 0) "لم يُعثر على تعريف: $VariableName"
    $lineEnd = $SourceText.IndexOf("`n", $startIdx)
    $line = $SourceText.Substring($startIdx, $lineEnd - $startIdx)
    if ($line.TrimEnd().EndsWith("@(")) {
        $close = $SourceText.IndexOf("`n)", $startIdx)
        Assert-True ($close -ge 0) "تعذّر تحديد نهاية المصفوفة لـ: $VariableName"
        return $SourceText.Substring($startIdx, ($close + 2) - $startIdx)
    }
    return $line
}

$uiSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge-ui.ps1") -Raw
$rendererSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "OzkReceiptRenderer.psm1") -Raw

# مسارات المصدر مكتوبة بفواصل Windows (\). عند تشغيل الاختبارات على منصّة أخرى
# للتحقق من المنطق، تُطبَّع الفواصل فقط لغرض فحص الوجود — دون تغيير أي مصدر.
function ConvertTo-PlatformPath([string]$Path) {
    if ([IO.Path]::DirectorySeparatorChar -eq "\") { return $Path }
    return $Path.Replace("\", "/")
}

Write-Host "`n== P1-A: مسارات وحدة العرض والشعار تُحلّ نسبةً إلى مجلد الجسر =="

# تُقرأ المسارات من المصدر الفعلي لا من نسخة مكتوبة هنا، فأي عودة إلى الصيغة
# المعطوبة تنعكس مباشرةً على هذه الاختبارات.
. ([scriptblock]::Create(((Get-ExtractedAssignmentText $bridgeSrc '$script:ReceiptModulePath') -replace '\$PSScriptRoot', "'$bridgeDir'")))
. ([scriptblock]::Create(((Get-ExtractedAssignmentText $bridgeSrc '$script:ReceiptLogoPath') -replace '\$PSScriptRoot', "'$bridgeDir'")))

Test-Case "المسار المحسوب لوحدة OzkReceiptRenderer.psm1 موجود فعلاً على القرص" {
    Assert-True (Test-Path -LiteralPath (ConvertTo-PlatformPath $script:ReceiptModulePath) -PathType Leaf) "المسار المحسوب غير موجود: $script:ReceiptModulePath"
}

Test-Case "المسار المحسوب لشعار الإيصال موجود فعلاً على القرص" {
    Assert-True (Test-Path -LiteralPath (ConvertTo-PlatformPath $script:ReceiptLogoPath) -PathType Leaf) "المسار المحسوب غير موجود: $script:ReceiptLogoPath"
}

Test-Case "negative witness: الصيغة المعطوبة (بادئة ozk-print-bridge مكررة) تعطي مساراً غير موجود" {
    $doubleNestedModule = ConvertTo-PlatformPath (Join-Path $bridgeDir "ozk-print-bridge\OzkReceiptRenderer.psm1")
    $doubleNestedLogo = ConvertTo-PlatformPath (Join-Path $bridgeDir "ozk-print-bridge\assets\ozk-receipt-horse-logo.png")
    Assert-True (-not (Test-Path -LiteralPath $doubleNestedModule)) "التعشيش المزدوج يجب ألا يوجد — لو وُجد لفقد الاختبار قدرته على كشف العطل"
    Assert-True (-not (Test-Path -LiteralPath $doubleNestedLogo)) "التعشيش المزدوج للشعار يجب ألا يوجد"
}

Test-Case "negative witness: المصدر لا يحتوي أي Join-Path يعيد بادئة ozk-print-bridge على PSScriptRoot" {
    Assert-True ($bridgeSrc -notmatch 'Join-Path \$PSScriptRoot "ozk-print-bridge\\') "عودة البادئة المكررة إلى المصدر يجب أن تُفشل هذا الاختبار"
}

Write-Host "`n== P1-B: PrintBridge مسؤول عن الكاشير (Retail) فقط =="

. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:CashierInvoiceTypes')))
. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:RetailTypeGuid')))
. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:WholesaleTypeGuids')))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Assert-CashierInvoiceType([string]`$Name) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Assert-CashierTypeGuid([string]`$TypeGuid, [int]`$InvoiceNumber) {")))

Test-Case "Retail مسموح — لا يرمي" {
    Assert-CashierInvoiceType "Retail"
}

Test-Case "Wholesale مرفوض fail-closed" {
    Assert-Throws { Assert-CashierInvoiceType "Wholesale" } "يجب رفض Wholesale"
}

Test-Case "WholesaleSyp مرفوض fail-closed" {
    Assert-Throws { Assert-CashierInvoiceType "WholesaleSyp" } "يجب رفض WholesaleSyp"
}

Test-Case "أي نوع غير معروف مرفوض أيضاً (قائمة سماح لا قائمة منع)" {
    Assert-Throws { Assert-CashierInvoiceType "AnythingElse" } "الحارس يجب أن يكون allow-list"
}

Test-Case "رسالة الرفض تذكر صراحةً أن الجملة خارج مسؤولية جسر الكاشير" {
    $message = ""
    try { Assert-CashierInvoiceType "Wholesale" } catch { $message = [string]$_.Exception.Message }
    Assert-True ($message -match "(?i)wholesale") "الرسالة يجب أن تذكر wholesale"
    Assert-True ($message -match "(?i)cashier|Retail") "الرسالة يجب أن توضّح أن الجسر للكاشير فقط"
}

Test-Case "GUID الكاشير مقبول على مستوى المرشّح" {
    Assert-CashierTypeGuid $script:RetailTypeGuid 1001
}

Test-Case "كلا GUID الجملة مرفوضان على مستوى المرشّح (لا يصلان إلى أمر الطباعة)" {
    foreach ($guid in $script:WholesaleTypeGuids) {
        Assert-Throws { Assert-CashierTypeGuid $guid 1001 } "يجب رفض GUID الجملة: $guid"
    }
}

Test-Case "الحارس يُستدعى في وضعَي PreviewInvoice/PrintInvoice قبل أي استعلام" {
    Assert-True ($bridgeSrc -match '(?s)if \(\$Mode -eq "PreviewInvoice" -or \$Mode -eq "PrintInvoice"\) \{\s*\r?\n\s*Assert-CashierInvoiceType \$InvoiceType') "يجب أن يكون الحارس أول سطر في فرع الطباعة/المعاينة اليدوية"
}

Test-Case "استدعاء الحارس يسبق Get-InvoiceTypeGuid وGet-PostedInvoiceByNumber في المصدر" {
    $guardIdx = $bridgeSrc.IndexOf("Assert-CashierInvoiceType `$InvoiceType")
    $typeIdx = $bridgeSrc.IndexOf("Get-InvoiceTypeGuid `$InvoiceType")
    $queryIdx = $bridgeSrc.IndexOf("Get-PostedInvoiceByNumber `$connection")
    Assert-True ($guardIdx -ge 0 -and $typeIdx -ge 0 -and $queryIdx -ge 0) "يجب وجود المواضع الثلاثة"
    Assert-True ($guardIdx -lt $typeIdx) "الحارس يجب أن يسبق تحويل النوع إلى GUID"
    Assert-True ($guardIdx -lt $queryIdx) "الحارس يجب أن يسبق الاستعلام"
}

Test-Case "حارس بدء التشغيل يرفض تسليح الطباعة مع إدراج أنواع الجملة" {
    Assert-True ($bridgeSrc -match '(?s)if \(\$IncludeWholesale -and \$ConfirmPhysicalPrint\) \{\s*\r?\n\s*throw') "يجب رفض -IncludeWholesale مع -ConfirmPhysicalPrint عند بدء التشغيل"
}

Test-Case "في حلقة Observe: فحص GUID الكاشير يسبق استيراد وحدة العرض وأمر الإرسال" {
    $assertIdx = $bridgeSrc.IndexOf("Assert-CashierTypeGuid (")
    $sendIdx = $bridgeSrc.IndexOf("Submit-OzkReceiptSpoolJob -Job `$spoolJob -ConfirmPhysicalPrint")
    Assert-True ($assertIdx -ge 0) "يجب وجود فحص GUID داخل حلقة الرصد"
    Assert-True ($sendIdx -ge 0) "يجب وجود أمر الإرسال داخل حلقة الرصد"
    Assert-True ($assertIdx -lt $sendIdx) "الفحص يجب أن يسبق الإرسال إلى الطابعة"
}

Test-Case "UI: قائمة الأنواع تحتوي الكاشير فقط" {
    $adds = [regex]::Matches($uiSrc, '\$typeBox\.Items\.Add\(')
    Assert-True ($adds.Count -eq 1) "يجب أن يبقى خيار واحد فقط، وُجد: $($adds.Count)"
}

Test-Case "UI: خريطة الأنواع لا تحوي إلا Retail" {
    Assert-True ($uiSrc -match '\$typeMap = @\{\s*\r?\n\s*"[^"]+" = "Retail"\s*\r?\n\s*\}') "خريطة الأنواع يجب أن تقتصر على Retail"
}

Test-Case "negative witness: لا يرد ذكر Wholesale إطلاقاً في مصدر الواجهة" {
    Assert-True ($uiSrc -notmatch 'Wholesale') "إعادة أي مسار جملة إلى الواجهة يجب أن تُفشل هذا الاختبار"
}

Test-Case "UI: حارس صريح يرفض بناء أمر لغير Retail حتى لو أُعيد خيار للقائمة" {
    Assert-True ($uiSrc -match '(?s)if \(\$type -ne "Retail"\) \{\s*\r?\n\s*throw') "الواجهة يجب أن ترفض أي نوع غير Retail قبل بناء أمر الجسر"
}

Write-Host "`n== P1-C: ارتفاع الإيصال ديناميكي بحدّ أمان صريح (بلا قصّ صامت) =="

Test-Case "لم يعد هناك ارتفاع لوحة ثابت 2600" {
    Assert-True ($rendererSrc -notmatch '\$canvasHeight = 2600') "الارتفاع الثابت يجب أن يكون قد أُزيل"
}

Test-Case "negative witness: لا يوجد أي [math]::Min يحدّ الارتفاع النهائي (نمط القصّ القديم)" {
    Assert-True ($rendererSrc -notmatch '\[math\]::Min\(') "إعادة نمط Min للقصّ يجب أن تُفشل هذا الاختبار"
}

Test-Case "حدّ الأمان معرّف صراحةً وأكبر من الارتفاع الثابت القديم" {
    Assert-True ($rendererSrc -match '\$script:ReceiptMaxHeight = (\d+)') "يجب تعريف حدّ أمان للارتفاع"
    $limit = [int]$Matches[1]
    Assert-True ($limit -gt 2600) "الحد يجب أن يتجاوز 2600 وإلا بقيت الفواتير الطويلة مرفوضة كما كانت مقصوصة"
    Assert-True ($limit -le 50000) "الحد يجب أن يبقى محدوداً فعلاً (لا تخصيص ذاكرة مفتوح)"
}

Test-Case "تجاوز حدّ الأمان يفشل صراحةً بـthrow لا بقصّ" {
    Assert-True ($rendererSrc -match '(?s)if \(\$requiredHeight -gt \$script:ReceiptMaxHeight\) \{\s*\r?\n\s*throw') "يجب رمي خطأ صريح عند التجاوز"
}

Test-Case "القياس والرسم يستدعيان دالة التخطيط نفسها (مصدر واحد للحساب)" {
    $calls = [regex]::Matches($rendererSrc, 'Invoke-OzkReceiptDrawing ')
    Assert-True ($calls.Count -eq 2) "يجب استدعاء دالة الرسم مرتين بالضبط (قياس ثم رسم)، وُجد: $($calls.Count)"
}

Test-Case "ReceiptWidth وReceiptDpi لم يتغيّرا (لا إعادة تصميم)" {
    Assert-True ($rendererSrc -match '\$script:ReceiptWidth = 576') "عرض الإيصال يجب أن يبقى 576"
    Assert-True ($rendererSrc -match '\$script:ReceiptDpi = 203') "دقة الإيصال يجب أن تبقى 203"
}

Write-Host "`n== P1-C: تصيير فعلي (يتطلب System.Drawing — Windows) =="

$script:DrawingAvailable = $false
try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $probe = New-Object Drawing.Bitmap(4, 4)
    $probe.Dispose()
    $script:DrawingAvailable = $true
} catch {
    $script:DrawingAvailable = $false
}

function New-TestReceipt([int]$LineCount, [string]$NamePattern = "مادة تجريبية") {
    $lines = New-Object System.Collections.Generic.List[object]
    for ($i = 1; $i -le $LineCount; $i++) {
        $lines.Add([pscustomobject]@{
            Name = ("{0} {1}" -f $NamePattern, $i)
            Quantity = 2
            UnitPrice = 1500
            Total = 3000
        })
    }
    return [pscustomobject]@{
        MerchantName = "مؤسسة عزّوز خلوف"
        Subtitle = "لتجارة التبغ"
        CommercialRegister = "12345"
        Phones = "011-1111111"
        CenterPhone = "0999999999"
        Address = "دمشق"
        Date = "2026-09-09"
        Time = "12:30"
        CustomerName = "زبون تجريبي"
        Description = "مبيعات مركز"
        Lines = $lines.ToArray()
        GrossTotal = 3000 * $LineCount
        Discount = 0
        NetTotal = 3000 * $LineCount
        Payment = 0
        BalanceFound = $false
        PreviousBalance = 0
        CurrentBalance = 0
        ItemCount = $LineCount
        TotalQuantity = 2 * $LineCount
        SaleDescription = "بيع نقدي"
    }
}

function Test-RenderCase([string]$Name, [scriptblock]$Body) {
    if (-not $script:DrawingAvailable) {
        Write-Host "  SKIP $Name (System.Drawing غير متاح على هذه المنصّة — يُشغَّل على Windows)"
        return
    }
    Test-Case $Name $Body
}

$logoPath = Join-Path (Join-Path $bridgeDir "assets") "ozk-receipt-horse-logo.png"

Test-RenderCase "فاتورة قصيرة (بند واحد) تُصيَّر بارتفاع موجب وأقل من الحد" {
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 1) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Width -eq 576) "العرض يجب أن يبقى 576"
        Assert-True ($bitmap.Height -gt 0) "الارتفاع يجب أن يكون موجباً"
        Assert-True ($bitmap.Height -lt 2600) "فاتورة ببند واحد يجب أن تكون أقصر من اللوحة الثابتة القديمة"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "فاتورة طبيعية (10 بنود) تُصيَّر ضمن حدود معقولة" {
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 10) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Height -gt 0) "الارتفاع يجب أن يكون موجباً"
        Assert-True ($bitmap.Height -lt 2600) "عشرة بنود يجب أن تبقى ضمن الارتفاع القديم"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "الارتفاع ينمو مع عدد البنود (ليس ثابتاً)" {
    $small = New-OzkReceiptBitmap -Receipt (New-TestReceipt 1) -LogoPath $logoPath
    $large = New-OzkReceiptBitmap -Receipt (New-TestReceipt 20) -LogoPath $logoPath
    try {
        Assert-True ($large.Height -gt $small.Height) "الارتفاع يجب أن يزيد بزيادة البنود"
    } finally { $small.Dispose(); $large.Dispose() }
}

Test-RenderCase "فاتورة 40 بنداً بأسماء طويلة تلتفّ: الارتفاع يتجاوز 2600 بلا قصّ" {
    $longName = "مادة ذات اسم طويل جداً يجبر السطر على الالتفاف أكثر من مرة داخل عمود الاسم"
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 40 $longName) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Height -gt 2600) "الحالة الطويلة يجب أن تتجاوز 2600 بكسل — كانت تُقصّ سابقاً"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "الإجماليات والتذييل موجودة داخل الناتج (آخر الإيصال مرسوم لا مقطوع)" {
    $longName = "مادة ذات اسم طويل جداً يجبر السطر على الالتفاف أكثر من مرة داخل عمود الاسم"
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 40 $longName) -LogoPath $logoPath
    try {
        # التذييل ("شكراً لتعاملكم معنا") آخر ما يُرسم؛ وجود بكسلات غير بيضاء في
        # الشريط الأخير يثبت أن نهاية الإيصال داخل الصورة لا خارجها.
        $inkFound = $false
        for ($y = [math]::Max(0, $bitmap.Height - 120); $y -lt $bitmap.Height -and -not $inkFound; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x += 4) {
                if ($bitmap.GetPixel($x, $y).R -lt 128) { $inkFound = $true; break }
            }
        }
        Assert-True $inkFound "يجب وجود محتوى مرسوم في نهاية الإيصال (التذييل/الإجماليات)"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "تجاوز حدّ الأمان ينتج خطأ صريح لا فاتورة مقصوصة" {
    $limit = 0
    Assert-True ($rendererSrc -match '\$script:ReceiptMaxHeight = (\d+)') "يجب قراءة الحد من المصدر"
    $limit = [int]$Matches[1]
    # كل بند ≥ 54 بكسل، فعدد يتجاوز الحد يقيناً مهما كان الحساب الدقيق للترويسة.
    $explodingCount = [int]([math]::Ceiling($limit / 54.0)) + 50
    $message = ""
    try {
        $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt $explodingCount) -LogoPath $logoPath
        $bitmap.Dispose()
        throw "ASSERT-NO-THROW"
    } catch {
        $message = [string]$_.Exception.Message
    }
    Assert-True ($message -ne "ASSERT-NO-THROW") "تجاوز الحد يجب أن يفشل صراحةً لا أن ينجح بقصّ"
    Assert-True ($message -match "(?i)safety limit|exceeds") "رسالة الخطأ يجب أن توضّح تجاوز حدّ الأمان: $message"
}

Write-Host "`n== P1-E: لا إعادة طباعة آلية بعد نجاح الإرسال وفشل حفظ الحالة =="

# تُستخرج دوال الحالة الثلاث من المصدر الفعلي وتُشغَّل بمعزل عن الحلقة الرئيسية
# (التي تحتوي اتصال SQL وحلقة لا نهائية)، فنختبر آلة الحالة الحقيقية لا نسخة منها.
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function New-EmptyState {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Write-BridgeState([string]`$Path, `$State) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Read-BridgeState([string]`$Path) {")))

$script:StateRoot = Join-Path ([IO.Path]::GetTempPath()) ("ozk-bridge-state-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $script:StateRoot -Force)

function New-StatePath { return Join-Path $script:StateRoot ((([guid]::NewGuid()).ToString("N")) + "\state.json") }

# يحاكي تسلسل الحلقة الفعلي لفاتورة واحدة، ويسمح بحقن فشل في مرحلة محددة.
#   FailAt = "before-send"  → عطل قبل كتابة علامة قيد الإرسال (تصيير/استيراد فشل)
#   FailAt = "persist"      → الإرسال نجح ثم فشل حفظ النتيجة النهائية
function Invoke-PrintIteration([string]$StatePath, [string]$Guid, [string]$FailAt = "") {
    $state = Read-BridgeState $StatePath
    if ($state.seen.ContainsKey($Guid)) { return "skipped" }

    if ($FailAt -eq "before-send") { throw "render failed before any send" }

    # علامة قيد الإرسال — تُكتب قبل الإرسال مباشرةً
    $state.seen[$Guid] = [ordered]@{ status = "print_in_flight"; invoiceNumber = 1001; observedAt = (Get-Date).ToUniversalTime().ToString("o"); lineCount = 3 }
    Write-BridgeState $StatePath $state

    $script:SendCount++          # ← هنا يقع الإرسال الفيزيائي فعلياً

    $state.seen[$Guid] = [ordered]@{ status = "spooled"; invoiceNumber = 1001; observedAt = (Get-Date).ToUniversalTime().ToString("o"); lineCount = 3 }
    if ($FailAt -eq "persist") { return "spooled-persist-failed" }
    Write-BridgeState $StatePath $state
    return "spooled"
}

Test-Case "1) فشل قبل الإرسال: لا أثر على القرص، وإعادة المحاولة لاحقاً مسموحة" {
    $path = New-StatePath
    $guid = "aaaa-1111"
    $script:SendCount = 0
    Assert-Throws { Invoke-PrintIteration $path $guid "before-send" } "يجب أن يرمي قبل الإرسال"
    Assert-True ($script:SendCount -eq 0) "لا يجوز أن يكون الإرسال قد وقع"
    $reloaded = Read-BridgeState $path
    Assert-True (-not $reloaded.seen.ContainsKey($guid)) "لا يجوز ترك أثر يمنع إعادة المحاولة"
    $result = Invoke-PrintIteration $path $guid
    Assert-True ($result -eq "spooled") "إعادة المحاولة يجب أن تنجح"
    Assert-True ($script:SendCount -eq 1) "الطباعة تقع مرة واحدة عند إعادة المحاولة"
}

Test-Case "2) نجاح الإرسال + نجاح الحفظ: طباعة واحدة، والتشغيل التالي يتخطاها" {
    $path = New-StatePath
    $guid = "bbbb-2222"
    $script:SendCount = 0
    Assert-True ((Invoke-PrintIteration $path $guid) -eq "spooled") "يجب أن ينجح"
    Assert-True ((Invoke-PrintIteration $path $guid) -eq "skipped") "التشغيل التالي يجب أن يتخطاها"
    Assert-True ($script:SendCount -eq 1) "الإرسال مرة واحدة فقط، وقع: $($script:SendCount)"
    $reloaded = Read-BridgeState $path
    Assert-True ([string]$reloaded.seen[$guid].status -eq "spooled") "الحالة المحفوظة يجب أن تكون spooled"
}

Test-Case "3) نجاح الإرسال + فشل الحفظ: لا نسخة ثانية بعد إعادة التشغيل (الثابتة الأساسية)" {
    $path = New-StatePath
    $guid = "cccc-3333"
    $script:SendCount = 0
    Assert-True ((Invoke-PrintIteration $path $guid "persist") -eq "spooled-persist-failed") "يجب أن يمثّل فشل الحفظ بعد الإرسال"
    Assert-True ($script:SendCount -eq 1) "الإرسال وقع مرة"
    # إعادة تشغيل: تُقرأ الحالة من القرص من جديد
    $reloaded = Read-BridgeState $path
    Assert-True ($reloaded.seen.ContainsKey($guid)) "علامة ما قبل الإرسال يجب أن تكون محفوظة على القرص"
    Assert-True ([string]$reloaded.seen[$guid].status -eq "print_in_flight") "الحالة المحفوظة يجب أن تكون print_in_flight"
    Assert-True ((Invoke-PrintIteration $path $guid) -eq "skipped") "إعادة التشغيل يجب ألا تعيد الطباعة"
    Assert-True ($script:SendCount -eq 1) "لا يجوز تجاوز إرسال واحد، وقع: $($script:SendCount)"
}

Test-Case "3ب) تكرار إعادة التشغيل لا يراكم نسخاً (العطل المستمر لا يصير حلقة طباعة)" {
    $path = New-StatePath
    $guid = "dddd-4444"
    $script:SendCount = 0
    [void](Invoke-PrintIteration $path $guid "persist")
    for ($i = 0; $i -lt 5; $i++) { [void](Invoke-PrintIteration $path $guid) }
    Assert-True ($script:SendCount -eq 1) "خمس إعادات تشغيل يجب ألا تنتج إلا إرسالاً واحداً، وقع: $($script:SendCount)"
}

Test-Case "4) فشل الحفظ بعد الإرسال لا يُسقط الجسر (يُسجَّل ويُواصل الرصد)" {
    Assert-True ($bridgeSrc -match '(?s)try \{\s*\r?\n\s*Write-BridgeState \$StatePath \$state\s*\r?\n\s*\} catch \{\s*\r?\n\s*if \(\$stateStatus -ne "spooled"\) \{ throw \}') "فشل الحفظ بعد الإرسال يجب أن يُلتقط، وأي فشل آخر يُعاد رميه"
    Assert-True ($bridgeSrc -match 'Event = "state_persist_failed_after_spool"') "يجب تسجيل الحدث بوضوح لا ابتلاعه"
}

Test-Case "5) الفاتورة العالقة من تشغيل سابق تُعلَن عند الإقلاع (لا تُبتلع صامتة)" {
    Assert-True ($bridgeSrc -match 'Event = "print_in_flight_carried_over"') "يجب الإعلان عن أي فاتورة بقيت قيد الإرسال"
    Assert-True ($bridgeSrc -match 'Remedy = "operator decides; manual reprint available via -Mode PrintInvoice"') "يجب توضيح المخرج اليدوي للمشغّل"
}

Test-Case "الترتيب في المصدر: علامة قيد الإرسال تُحفظ على القرص قبل أمر الإرسال" {
    $markerIdx = $bridgeSrc.IndexOf('status = "print_in_flight"')
    $writeIdx = $bridgeSrc.IndexOf("Write-BridgeState `$StatePath `$state", $markerIdx)
    $sendIdx = $bridgeSrc.IndexOf("Submit-OzkReceiptSpoolJob -Job `$spoolJob", $markerIdx)
    Assert-True ($markerIdx -ge 0 -and $writeIdx -ge 0 -and $sendIdx -ge 0) "يجب وجود المواضع الثلاثة"
    Assert-True ($writeIdx -lt $sendIdx) "الحفظ على القرص يجب أن يسبق الإرسال إلى الطابعة"
}

Test-Case "negative witness: بلا علامة ما قبل الإرسال تعود إعادة الطباعة بعد فشل الحفظ" {
    # محاكاة السلوك القديم: لا كتابة قبل الإرسال إطلاقاً
    $path = New-StatePath
    $guid = "eeee-5555"
    $sends = 0
    $state = Read-BridgeState $path
    if (-not $state.seen.ContainsKey($guid)) { $sends++ }   # الإرسال الأول
    # فشل الحفظ هنا: لا شيء يُكتب على القرص إطلاقاً
    $reloaded = Read-BridgeState $path
    if (-not $reloaded.seen.ContainsKey($guid)) { $sends++ }  # إعادة التشغيل تطبع ثانيةً
    Assert-True ($sends -eq 2) "السلوك القديم يجب أن ينتج نسختين — وهذا ما يمنعه الإصلاح"
}

Write-Host "`n== P1-F: حدود التسليم — الفشل المؤكَّد قبل التسليم يبقى قابلاً لإعادة المحاولة =="

. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Test-PreSubmissionFailure(`$ErrorRecord) {")))

# النوع الحقيقي من وحدة العرض (استُوردت أعلاه)، فالتصنيف يُختبر على العقد الفعلي.
Test-Case "نوع OzkSpoolNotSubmittedException معرَّف فعلاً في وحدة العرض" {
    Assert-True ($null -ne ("OzkSpoolNotSubmittedException" -as [type])) "يجب أن تعرّف الوحدة نوع الفشل قبل التسليم"
}

Test-Case "التصنيف: فشل ما قبل التسليم يُميَّز بوضوح" {
    $record = [System.Management.Automation.ErrorRecord]::new(
        (New-Object OzkSpoolNotSubmittedException("OpenPrinter failed with Win32 error 1801")), "spool", "NotSpecified", $null)
    Assert-True (Test-PreSubmissionFailure $record) "OpenPrinter/StartDocPrinter يجب أن يُصنَّف كفشل قبل التسليم"
}

Test-Case "التصنيف: أي فشل آخر يبقى غامضاً (لا يُفترض عدم الطباعة)" {
    $record = [System.Management.Automation.ErrorRecord]::new(
        (New-Object System.IO.IOException("Incomplete RAW printer write.")), "spool", "NotSpecified", $null)
    Assert-True (-not (Test-PreSubmissionFailure $record)) "فشل الكتابة بعد بدء المهمة يجب أن يبقى غامضاً"
    $record2 = [System.Management.Automation.ErrorRecord]::new(
        (New-Object InvalidOperationException("WritePrinter failed with Win32 error 6")), "spool", "NotSpecified", $null)
    Assert-True (-not (Test-PreSubmissionFailure $record2)) "أي InvalidOperationException بعد القبول يبقى غامضاً"
}

Test-Case "التصنيف يفحص InnerException أيضاً (التغليف لا يُخفي الحقيقة)" {
    $inner = New-Object OzkSpoolNotSubmittedException("OpenPrinter failed")
    $outer = New-Object System.Management.Automation.MethodInvocationException("wrapped", $inner)
    $record = [System.Management.Automation.ErrorRecord]::new($outer, "spool", "NotSpecified", $null)
    Assert-True (Test-PreSubmissionFailure $record) "الاستثناء المغلَّف يجب أن يُصنَّف بصح"
}

# محاكاة تسلسل الحلقة كاملاً بحدود التسليم الجديدة، مع حقن الفشل في كل مرحلة.
#   FailAt = "prepare-*"   → فشل أثناء التحضير: لا علامة أصلاً
#   FailAt = "pre-submit"  → فشل مؤكَّد داخل التسليم قبل قبول أي مهمة
#   FailAt = "ambiguous"   → فشل داخل التسليم بعد احتمال القبول
#   FailAt = "persist"     → التسليم نجح ثم فشل حفظ النتيجة
function Invoke-BoundedPrintIteration([string]$StatePath, [string]$Guid, [string]$FailAt = "") {
    $state = Read-BridgeState $StatePath
    if ($state.seen.ContainsKey($Guid)) { return "skipped" }

    # 1) التحضير — قبل أي علامة
    if ($FailAt -like "prepare-*") { throw "$FailAt failed before any marker" }

    # 2) العلامة
    $state.seen[$Guid] = [ordered]@{ status = "print_in_flight"; invoiceNumber = 1001; observedAt = (Get-Date).ToUniversalTime().ToString("o"); lineCount = 2 }
    Write-BridgeState $StatePath $state

    # 3) التسليم
    try {
        if ($FailAt -eq "pre-submit") { throw (New-Object OzkSpoolNotSubmittedException("OpenPrinter failed with Win32 error 1801")) }
        if ($FailAt -eq "ambiguous") { throw (New-Object System.IO.IOException("Incomplete RAW printer write.")) }
        $script:SendCount++
    } catch {
        if (Test-PreSubmissionFailure $_) {
            [void]$state.seen.Remove($Guid)
            Write-BridgeState $StatePath $state
            return "pre-submission-rolled-back"
        }
        return "ambiguous-marker-kept"
    }

    $state.seen[$Guid] = [ordered]@{ status = "spooled"; invoiceNumber = 1001; observedAt = (Get-Date).ToUniversalTime().ToString("o"); lineCount = 2 }
    if ($FailAt -eq "persist") { return "spooled-persist-failed" }
    Write-BridgeState $StatePath $state
    return "spooled"
}

foreach ($stage in @("prepare-render", "prepare-printer-validation", "prepare-cim-lookup")) {
    $stageName = $stage
    Test-Case "فشل التحضير ($stageName) → لا علامة على القرص، وإعادة المحاولة تنجح" {
        $path = New-StatePath; $guid = "prep-$stageName"; $script:SendCount = 0
        Assert-Throws { Invoke-BoundedPrintIteration $path $guid $stageName } "يجب أن يرمي أثناء التحضير"
        Assert-True ($script:SendCount -eq 0) "لا يجوز أن يقع تسليم"
        $reloaded = Read-BridgeState $path
        Assert-True (-not $reloaded.seen.ContainsKey($guid)) "لا يجوز ترك علامة تمنع إعادة المحاولة"
        Assert-True ((Invoke-BoundedPrintIteration $path $guid) -eq "spooled") "إعادة المحاولة يجب أن تنجح"
        Assert-True ($script:SendCount -eq 1) "تسليم واحد بعد إعادة المحاولة"
    }
}

Test-Case "فشل OpenPrinter (مؤكَّد قبل التسليم) → تراجع عن العلامة وإعادة المحاولة مسموحة" {
    $path = New-StatePath; $guid = "openprinter-1"; $script:SendCount = 0
    Assert-True ((Invoke-BoundedPrintIteration $path $guid "pre-submit") -eq "pre-submission-rolled-back") "يجب التراجع عن العلامة"
    Assert-True ($script:SendCount -eq 0) "لا تسليم وقع"
    $reloaded = Read-BridgeState $path
    Assert-True (-not $reloaded.seen.ContainsKey($guid)) "العلامة يجب أن تكون قد أُزيلت من القرص"
    Assert-True ((Invoke-BoundedPrintIteration $path $guid) -eq "spooled") "poll لاحق يجب أن يطبعها"
    Assert-True ($script:SendCount -eq 1) "طباعة واحدة بعد التعافي"
}

Test-Case "فشل StartDocPrinter (مؤكَّد قبل قبول المهمة) → قابل لإعادة المحاولة أيضاً" {
    $path = New-StatePath; $guid = "startdoc-1"; $script:SendCount = 0
    # نفس النوع الذي ترميه وحدة العرض عند فشل StartDocPrinter
    Assert-True ((Invoke-BoundedPrintIteration $path $guid "pre-submit") -eq "pre-submission-rolled-back") "يجب التراجع"
    Assert-True ((Read-BridgeState $path).seen.ContainsKey($guid) -eq $false) "لا أثر متبقٍ"
}

Test-Case "فشل في المنطقة الغامضة (بعد احتمال قبول المهمة) → العلامة تبقى، لا تكرار آلي" {
    $path = New-StatePath; $guid = "ambiguous-1"; $script:SendCount = 0
    Assert-True ((Invoke-BoundedPrintIteration $path $guid "ambiguous") -eq "ambiguous-marker-kept") "يجب الإبقاء على العلامة"
    $reloaded = Read-BridgeState $path
    Assert-True ($reloaded.seen.ContainsKey($guid)) "العلامة يجب أن تبقى محفوظة"
    Assert-True ([string]$reloaded.seen[$guid].status -eq "print_in_flight") "الحالة يجب أن تبقى print_in_flight"
    Assert-True ((Invoke-BoundedPrintIteration $path $guid) -eq "skipped") "إعادة التشغيل يجب ألا تعيد الطباعة"
    Assert-True ($script:SendCount -eq 0) "لم يُحتسب تسليم ناجح، ومع ذلك لا تكرار"
}

Test-Case "لا فقدان صامت: كل فشل مؤكَّد قبل التسليم يُسجَّل بحدث صريح" {
    Assert-True ($bridgeSrc -match 'Event = "pre_submission_failure_retryable"') "يجب تسجيل الفشل القابل لإعادة المحاولة"
    Assert-True ($bridgeSrc -match 'MarkerRolledBack = \$rolledBack') "يجب توثيق نجاح/فشل التراجع عن العلامة"
}

Test-Case "الترتيب في المصدر: التحضير يسبق العلامة، والعلامة تسبق التسليم" {
    $prepareIdx = $bridgeSrc.IndexOf("New-OzkReceiptSpoolJob -Receipt `$receipt")
    $markerIdx = $bridgeSrc.IndexOf('status = "print_in_flight"')
    $writeIdx = $bridgeSrc.IndexOf("Write-BridgeState `$StatePath `$state", $markerIdx)
    $submitIdx = $bridgeSrc.IndexOf("Submit-OzkReceiptSpoolJob -Job `$spoolJob")
    Assert-True ($prepareIdx -ge 0 -and $markerIdx -ge 0 -and $writeIdx -ge 0 -and $submitIdx -ge 0) "يجب وجود المواضع الأربعة"
    Assert-True ($prepareIdx -lt $markerIdx) "التحضير يجب أن يسبق العلامة"
    Assert-True ($writeIdx -lt $submitIdx) "حفظ العلامة يجب أن يسبق التسليم"
}

Test-Case "دلالات صريحة: النجاح يعني القبول في الطابور لا خروج الورق" {
    Assert-True ($bridgeSrc -match 'submitted_to_spooler:') "الحدث يجب أن يقول إنه تسليم للطابور"
    Assert-True ($rendererSrc -match 'لا يوجد أي إثبات على خروج الورق') "الوحدة يجب أن توثّق حدود الضمان"
}

Test-Case "negative witness: بلا تمييز الفشل قبل التسليم تُقمع فاتورة لم تُطبع أصلاً" {
    # السلوك السابق: العلامة تُحفظ ثم أي فشل يُبقيها، فتُقمع الفاتورة نهائياً.
    $path = New-StatePath; $guid = "nw-presubmit"
    $state = Read-BridgeState $path
    $state.seen[$guid] = [ordered]@{ status = "print_in_flight"; invoiceNumber = 1001 }
    Write-BridgeState $path $state          # علامة بلا تراجع
    $reloaded = Read-BridgeState $path
    Assert-True ($reloaded.seen.ContainsKey($guid)) "بلا تراجع تبقى العلامة"
    Assert-True ((Invoke-BoundedPrintIteration $path $guid) -eq "skipped") "فتُقمع الفاتورة نهائياً — وهذا ما يمنعه الإصلاح"
}

Test-Case "وحدة العرض: التحضير منفصل عن التسليم فعلياً" {
    Assert-True ($rendererSrc -match 'function New-OzkReceiptSpoolJob') "يجب وجود دالة تحضير مستقلة"
    Assert-True ($rendererSrc -match 'function Submit-OzkReceiptSpoolJob') "يجب وجود دالة تسليم مستقلة"
    # كل ما يمكن أن يفشل بلا مهمة طباعة يقع في التحضير
    $prepareText = Get-ExtractedFunctionText $rendererSrc "function New-OzkReceiptSpoolJob {"
    Assert-True ($prepareText -match 'Get-CimInstance Win32_Printer') "فحص الطابور في التحضير"
    Assert-True ($prepareText -match 'New-OzkReceiptBitmap') "التصيير في التحضير"
    Assert-True ($prepareText -match 'ToEscPosRaster') "بناء ESC/POS في التحضير"
    $submitText = Get-ExtractedFunctionText $rendererSrc "function Submit-OzkReceiptSpoolJob {"
    Assert-True ($submitText -notmatch 'New-OzkReceiptBitmap|Get-CimInstance|ToEscPosRaster') "التسليم يجب ألا يحوي أي عمل تحضيري"
    Assert-True ($submitText -match '\[OzkRawThermalPrinter\]::Send') "التسليم يستدعي التسليم الخام فقط"
}

Test-Case "وحدة العرض: الفشل قبل قبول المهمة يرمي النوع المميِّز" {
    Assert-True ($rendererSrc -match 'if \(!OpenPrinter\(printerName, out printer, IntPtr\.Zero\)\) throw new OzkSpoolNotSubmittedException') "OpenPrinter يجب أن يرمي النوع المميِّز"
    Assert-True ($rendererSrc -match 'if \(jobId <= 0\) throw new OzkSpoolNotSubmittedException') "StartDocPrinter يجب أن يرمي النوع المميِّز"
    Assert-True ($rendererSrc -match 'WritePrinter failed with Win32 error " \+ Marshal\.GetLastWin32Error\(\)\);') "WritePrinter يجب أن يبقى استثناءً غامضاً"
}

Write-Host "`n== P1-I: ترقيم صفحات المرشّحين (لا فاتورة تبقى خارج المتناول) =="

. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:CandidatePageSize')))
. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:MaxCandidatePagesPerPoll')))
. ([scriptblock]::Create((Get-ExtractedFunctionText  $bridgeSrc "function Get-PostedInvoiceCandidateSet(`$Connection, [string[]]`$TypeGuids, [datetime]`$FromDate, `$ResumeCursor, [int]`$MaxPages) {")))

# ── قاعدة بيانات وهمية: مجموعة مرشّحين مرتّبة أحدثُ أولاً ──────────────────
# تُحاكي دلالات الاستعلام الحقيقية: seek صارم على الثلاثي (Date, Number, GUID)
# بترتيب تنازلي، وسقف صفحة. لا اتصال SQL ولا طباعة.
function New-FakeCandidate([datetime]$Date, [int]$Number, [string]$Guid) {
    [pscustomobject]@{
        InvoiceGuid = $Guid; InvoiceNumber = $Number
        InvoiceDateRaw = $Date; InvoiceDate = $Date.ToString("o")
        TypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"; TypeName = "مبيعات مركز"
        BranchGuid = "br-1"; IsPosted = $true; RecordState = 0; SourceId = 0
    }
}

function New-FakeUniverse([int]$Count, [switch]$AllSameDateAndNumber) {
    $base = [datetime]::Parse("2026-01-05T00:00:00", $script:InvariantCulture)
    $rows = New-Object System.Collections.Generic.List[object]
    for ($i = 0; $i -lt $Count; $i++) {
        if ($AllSameDateAndNumber) {
            # كل الفواتير بنفس التاريخ والرقم: الـGUID وحده يفصل بينها.
            $rows.Add((New-FakeCandidate $base 5000 ("g{0:d5}" -f ($Count - $i))))
        } else {
            $rows.Add((New-FakeCandidate ($base.AddSeconds(-$i)) (10000 - $i) ("g{0:d5}" -f ($Count - $i))))
        }
    }
    # ترتيب تنازلي: Date desc, Number desc, Guid desc — نفس ORDER BY الحقيقي.
    return @($rows | Sort-Object -Property @{E={$_.InvoiceDateRaw};D=$true}, @{E={$_.InvoiceNumber};D=$true}, @{E={$_.InvoiceGuid};D=$true})
}

$script:FakeUniverse = @()
$script:FakePageCalls = 0

# تحلّ محل الاستعلام الحقيقي داخل Get-PostedInvoiceCandidateSet المستخرَجة.
function Get-PostedInvoiceCandidatePage($Connection, [string[]]$TypeGuids, [datetime]$FromDate, $After) {
    $script:FakePageCalls++
    $rows = @($script:FakeUniverse)
    if ($null -ne $After) {
        $rows = @($rows | Where-Object {
            ($_.InvoiceDateRaw -lt $After.InvoiceDateRaw) -or
            ($_.InvoiceDateRaw -eq $After.InvoiceDateRaw -and $_.InvoiceNumber -lt $After.InvoiceNumber) -or
            ($_.InvoiceDateRaw -eq $After.InvoiceDateRaw -and $_.InvoiceNumber -eq $After.InvoiceNumber -and $_.InvoiceGuid -lt $After.InvoiceGuid)
        })
    }
    return @($rows | Select-Object -First $script:CandidatePageSize)
}

# يُصرّف النافذة كاملةً عبر نبضات متتالية، تماماً كما تفعل حلقة الرصد.
function Invoke-DrainAcrossPolls([int]$MaxPages, [int]$MaxPolls = 200) {
    $cursor = $null
    $reached = New-Object System.Collections.Generic.HashSet[string]
    $polls = 0
    do {
        $polls++
        $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $cursor $MaxPages
        foreach ($c in @($set.Candidates)) { [void]$reached.Add($c.InvoiceGuid) }
        $cursor = $set.NextCursor
    } while ($null -ne $cursor -and $polls -lt $MaxPolls)
    return [pscustomobject]@{ Reached = $reached; Polls = $polls; Cursor = $cursor }
}

Test-Case "أقل من حجم الصفحة (100) → صفحة واحدة وسلوك طبيعي" {
    $script:FakeUniverse = New-FakeUniverse 100; $script:FakePageCalls = 0
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    Assert-True (@($set.Candidates).Count -eq 100) "يجب جلب المئة كلها"
    Assert-True ($set.Exhausted) "يجب أن تُعتبر النافذة منتهية"
    Assert-True ($null -eq $set.NextCursor) "لا مؤشر متبقٍ"
    Assert-True ($script:FakePageCalls -eq 1) "صفحة واحدة تكفي، جرى: $($script:FakePageCalls)"
}

Test-Case "بالضبط حجم الصفحة (256) → تُجلب كلها وتُكتشف النهاية بصفحة ثانية فارغة" {
    $script:FakeUniverse = New-FakeUniverse $script:CandidatePageSize
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    Assert-True (@($set.Candidates).Count -eq $script:CandidatePageSize) "يجب جلب الـ256"
    Assert-True ($set.Exhausted) "يجب أن تنتهي النافذة"
}

Test-Case "257 مرشّحاً → الترقيم يصل إلى العنصر رقم 257" {
    $script:FakeUniverse = New-FakeUniverse 257
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    Assert-True (@($set.Candidates).Count -eq 257) "يجب جلب الـ257 كلها، جُلب: $(@($set.Candidates).Count)"
    Assert-True ($set.Exhausted) "يجب أن تنتهي"
}

Test-Case "600 مرشّح → كلها يمكن الوصول إليها" {
    $script:FakeUniverse = New-FakeUniverse 600
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    Assert-True (@($set.Candidates).Count -eq 600) "يجب جلب الستمئة، جُلب: $(@($set.Candidates).Count)"
    $reached = New-Object System.Collections.Generic.HashSet[string]
    foreach ($c in @($set.Candidates)) { [void]$reached.Add($c.InvoiceGuid) }
    Assert-True ($reached.Count -eq 600) "لا تكرار: عدد الـGUIDات الفريدة يجب أن يساوي 600"
}

Test-Case "أول 256 كلها seen → الوصول إلى #257 وما بعدها (جوهر العطل)" {
    $script:FakeUniverse = New-FakeUniverse 600
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    $all = @($set.Candidates)
    # يحاكي الترشيح الذي يقع بعد الجلب في الحلقة
    $seen = New-Object System.Collections.Generic.HashSet[string]
    foreach ($c in $all[0..255]) { [void]$seen.Add($c.InvoiceGuid) }
    $fresh = @($all | Where-Object { -not $seen.Contains($_.InvoiceGuid) })
    Assert-True ($fresh.Count -eq 344) "يجب أن يبقى 344 مرشّحاً جديداً بعد استبعاد أول 256، وُجد: $($fresh.Count)"
    Assert-True ($fresh[0].InvoiceGuid -eq $all[256].InvoiceGuid) "أول جديد يجب أن يكون العنصر رقم 257"
}

Test-Case "تساوي التاريخ والرقم لكل الفواتير → الـGUID يمنع القفز والتكرار" {
    $script:FakeUniverse = New-FakeUniverse 600 -AllSameDateAndNumber
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    $all = @($set.Candidates)
    Assert-True ($all.Count -eq 600) "يجب جلب الستمئة رغم تساوي التاريخ والرقم، جُلب: $($all.Count)"
    $unique = New-Object System.Collections.Generic.HashSet[string]
    foreach ($c in $all) { [void]$unique.Add($c.InvoiceGuid) }
    Assert-True ($unique.Count -eq 600) "لا تكرار ولا قفز: الفريد يجب أن يساوي 600، وُجد: $($unique.Count)"
}

Test-Case "الترتيب الأحدث أولاً محفوظ" {
    $script:FakeUniverse = New-FakeUniverse 600
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    $all = @($set.Candidates)
    for ($i = 1; $i -lt $all.Count; $i++) {
        $prev = $all[$i - 1]; $cur = $all[$i]
        $ordered = ($prev.InvoiceDateRaw -gt $cur.InvoiceDateRaw) -or
                   ($prev.InvoiceDateRaw -eq $cur.InvoiceDateRaw -and $prev.InvoiceNumber -gt $cur.InvoiceNumber) -or
                   ($prev.InvoiceDateRaw -eq $cur.InvoiceDateRaw -and $prev.InvoiceNumber -eq $cur.InvoiceNumber -and $prev.InvoiceGuid -gt $cur.InvoiceGuid)
        Assert-True $ordered "الترتيب التنازلي يجب أن يبقى محفوظاً عند الموضع $i"
    }
}

Test-Case "سقف الصفحات يوقف النبضة، والنبضة التالية تستأنف من المؤشر (لا تجويع)" {
    $script:FakeUniverse = New-FakeUniverse 1200
    # سقف صفحتين لكل نبضة: 512 مرشّحاً على الأكثر
    $set = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null 2
    Assert-True (-not $set.Exhausted) "النافذة يجب ألا تنتهي عند السقف"
    Assert-True ($null -ne $set.NextCursor) "يجب إعادة مؤشر للاستئناف"
    Assert-True ($set.PagesFetched -eq 2) "يجب احترام سقف الصفحتين، جُلب: $($set.PagesFetched)"
    $drain = Invoke-DrainAcrossPolls 2
    Assert-True ($drain.Reached.Count -eq 1200) "التصريف عبر النبضات يجب أن يبلغ الـ1200 كلها، بلغ: $($drain.Reached.Count)"
    Assert-True ($null -eq $drain.Cursor) "المؤشر يجب أن يُصفَّر عند نفاد النافذة"
    Assert-True ($drain.Polls -lt 20) "يجب أن ينتهي بعدد نبضات معقول، استغرق: $($drain.Polls)"
}

Test-Case "التصريف ينتهي ولا يدور بلا تقدّم (لا busy loop)" {
    $script:FakeUniverse = New-FakeUniverse 1200
    $drain = Invoke-DrainAcrossPolls 2 30
    Assert-True ($drain.Polls -lt 30) "يجب أن ينتهي قبل سقف النبضات، استغرق: $($drain.Polls)"
    Assert-True ($null -eq $drain.Cursor) "يجب أن ينتهي بمؤشر مُصفَّر"
}

Test-Case "الصفحة الأولى تُجلب من الأحدث في كل نبضة (الفواتير الجديدة لا يؤخّرها التصريف)" {
    $script:FakeUniverse = New-FakeUniverse 1200
    $set1 = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null 2
    $newest = @($script:FakeUniverse)[0].InvoiceGuid
    # نبضة تالية أثناء التصريف: يجب أن تحتوي الأحدث رغم وجود مؤشر
    $set2 = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $set1.NextCursor 2
    $guids = @($set2.Candidates | ForEach-Object { $_.InvoiceGuid })
    Assert-True ($guids -contains $newest) "الأحدث يجب أن يظهر في كل نبضة حتى أثناء التصريف"
}

Test-Case "فشل صفحة عابر → يخرج بأمان والنبضة اللاحقة تعيد المحاولة" {
    $script:FakeUniverse = New-FakeUniverse 600
    $script:FailNextPage = $true
    function Get-PostedInvoiceCandidatePage($Connection, [string[]]$TypeGuids, [datetime]$FromDate, $After) {
        if ($script:FailNextPage) { $script:FailNextPage = $false; throw "transient query failure" }
        $rows = @($script:FakeUniverse)
        if ($null -ne $After) {
            $rows = @($rows | Where-Object {
                ($_.InvoiceDateRaw -lt $After.InvoiceDateRaw) -or
                ($_.InvoiceDateRaw -eq $After.InvoiceDateRaw -and $_.InvoiceNumber -lt $After.InvoiceNumber) -or
                ($_.InvoiceDateRaw -eq $After.InvoiceDateRaw -and $_.InvoiceNumber -eq $After.InvoiceNumber -and $_.InvoiceGuid -lt $After.InvoiceGuid)
            })
        }
        return @($rows | Select-Object -First $script:CandidatePageSize)
    }
    Assert-Throws { Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll } "الفشل العابر يجب أن يخرج لا أن يُبتلع"
    $retry = Get-PostedInvoiceCandidateSet $null @() ([datetime]::MinValue) $null $script:MaxCandidatePagesPerPoll
    Assert-True (@($retry.Candidates).Count -eq 600) "إعادة المحاولة يجب أن تنجح كاملةً، جُلب: $(@($retry.Candidates).Count)"
}

Test-Case "negative witness: TOP(256) بلا ترقيم لا يصل إلى ما بعد الصفحة الأولى إطلاقاً" {
    $script:FakeUniverse = New-FakeUniverse 600
    # السلوك القديم: استعلام واحد بلا مؤشر، والترشيح بـseen بعد الجلب.
    $legacyFetch = { return @(@($script:FakeUniverse) | Select-Object -First $script:CandidatePageSize) }
    $seen = New-Object System.Collections.Generic.HashSet[string]
    $reachedLegacy = New-Object System.Collections.Generic.HashSet[string]
    for ($poll = 0; $poll -lt 10; $poll++) {
        foreach ($c in (& $legacyFetch)) {
            if ($seen.Contains($c.InvoiceGuid)) { continue }
            [void]$seen.Add($c.InvoiceGuid); [void]$reachedLegacy.Add($c.InvoiceGuid)
        }
    }
    Assert-True ($reachedLegacy.Count -eq $script:CandidatePageSize) "السلوك القديم يجب أن يعلق عند 256 مهما تكررت النبضات، بلغ: $($reachedLegacy.Count)"
    # الإصلاح الحالي يبلغ الستمئة
    $drain = Invoke-DrainAcrossPolls $script:MaxCandidatePagesPerPoll
    Assert-True ($drain.Reached.Count -eq 600) "الترقيم الحالي يجب أن يبلغ الستمئة، بلغ: $($drain.Reached.Count)"
}

Test-Case "المصدر: شرط seek يستعمل الثلاثي الكامل بمقارنة صارمة" {
    Assert-True ($bridgeSrc -match 'u\.Date < @afterDate') "يجب مقارنة التاريخ"
    Assert-True ($bridgeSrc -match 'u\.Date = @afterDate and u\.Number < @afterNumber') "يجب فكّ التعادل بالرقم"
    Assert-True ($bridgeSrc -match 'u\.Date = @afterDate and u\.Number = @afterNumber and u\.GUID < @afterGuid') "يجب فكّ التعادل النهائي بالـGUID"
    Assert-True ($bridgeSrc -match 'order by u\.Date desc, u\.Number desc, u\.GUID desc') "الترتيب يجب أن يبقى كما كان"
}

Test-Case "المصدر: خط الأساس يغطي النافذة كاملةً لا صفحة واحدة" {
    Assert-True ($bridgeSrc -match '\$candidates = @\(\(Get-PostedInvoiceCandidateSet \$connection \$typeGuids \$fromDate \$null \$script:MaxCandidatePagesForBaseline\)\.Candidates\)') "خط الأساس يجب أن يستعمل التصريف الكامل"
}

Test-Case "المصدر: بلوغ السقف يُسجَّل صراحةً لا صامتاً" {
    Assert-True ($bridgeSrc -match 'Event = "candidate_drain_paused"') "يجب تسجيل توقّف التصريف عند السقف"
}

Write-Host "`n== P1-J: المولّد يُنتج VBS صالحاً فعلاً (اختبار على الناتج لا على المصدر) =="

# مفسّر مصغّر لتعبير VBScript: سلاسل حرفية (""" للاقتباس المحرّف) ومعرّفات
# موصولة بـ&، وهو شكل التعبير الذي يبنيه المولّد. يرمي عند أي صياغة يرفضها
# مفسّر VBScript فعلاً — سلسلة غير مغلقة، رمز خارج سلسلة، أو عامل ناقص.
function ConvertFrom-VbsExpression([string]$Expression, [hashtable]$Variables) {
    $i = 0
    $n = $Expression.Length
    $builder = New-Object System.Text.StringBuilder
    $expectOperand = $true
    while ($true) {
        while ($i -lt $n -and $Expression[$i] -eq ' ') { $i++ }
        if ($i -ge $n) { break }
        if ($expectOperand) {
            if ($Expression[$i] -eq '"') {
                $i++
                $closed = $false
                while ($i -lt $n) {
                    if ($Expression[$i] -eq '"') {
                        if (($i + 1) -lt $n -and $Expression[$i + 1] -eq '"') {
                            [void]$builder.Append('"'); $i += 2; continue
                        }
                        $i++; $closed = $true; break
                    }
                    [void]$builder.Append($Expression[$i]); $i++
                }
                if (-not $closed) { throw "VBS syntax error: unterminated string literal" }
            } elseif ($Expression[$i] -match '[A-Za-z_]') {
                $start = $i
                while ($i -lt $n -and $Expression[$i] -match '[A-Za-z0-9_]') { $i++ }
                $name = $Expression.Substring($start, $i - $start)
                if (-not $Variables.ContainsKey($name)) { throw "VBS syntax error: unknown identifier '$name'" }
                [void]$builder.Append([string]$Variables[$name])
            } else {
                throw "VBS syntax error: unexpected token '$($Expression[$i])' at $i"
            }
            $expectOperand = $false
        } else {
            if ($Expression[$i] -eq '&') { $i++; $expectOperand = $true }
            else {
                $tailText = $Expression.Substring($i, [math]::Min(14, $n - $i))
                throw "VBS syntax error: missing '&' before '$tailText'"
            }
        }
    }
    if ($expectOperand) { throw "VBS syntax error: expression ends with a dangling operator" }
    return $builder.ToString()
}

Test-Case "المفسّر المصغّر يميّز الصيغة المعطوبة عن الصحيحة" {
    # علامتان: سلسلة فارغة ثم مسار خارج أي سلسلة — ترفضها VBScript
    Assert-Throws { ConvertFrom-VbsExpression '""C:\Windows\powershell.exe"" -NoProfile' @{} } "الصيغة بعلامتين يجب أن تُرفض"
    # ثلاث علامات: فتح + اقتباس محرّف — هي الصيغة الصحيحة
    $value = ConvertFrom-VbsExpression '"""C:\Windows\powershell.exe"" -NoProfile"' @{}
    Assert-True ($value -eq '"C:\Windows\powershell.exe" -NoProfile') "الصيغة بثلاث علامات يجب أن تعطي مساراً مُقتبساً، أعطت: [$value]"
}

# يُشغَّل المولّد الحقيقي إلى مسار مؤقت خارج المستودع. لا Scheduled Task ولا
# تثبيت ولا طباعة — السكربت نفسه يوثّق أنه يطبع ملفاً فقط.
$script:GeneratedCmdExpression = $null
$script:GeneratorError = $null
try {
    $generatorPath = Join-Path (Join-Path $bridgeDir "install") "New-OzkPrintBridgeTaskWrapper.ps1"
    $generatedPath = Join-Path ([IO.Path]::GetTempPath()) ("ozk-wrapper-" + [guid]::NewGuid().ToString("N") + ".vbs")
    try {
        & $generatorPath -OutputPath $generatedPath | Out-Null
        $generatedText = Get-Content -LiteralPath $generatedPath -Raw -Encoding Unicode
        $cmdLine = @($generatedText -split "`r?`n" | Where-Object { $_ -like 'cmd = *' })[0]
        if ([string]::IsNullOrWhiteSpace($cmdLine)) { throw "لم يُعثر على سطر cmd في الناتج" }
        $script:GeneratedCmdExpression = $cmdLine.Substring("cmd = ".Length)
    } finally {
        if (Test-Path -LiteralPath $generatedPath) { Remove-Item -LiteralPath $generatedPath -Force }
    }
} catch {
    $script:GeneratorError = [string]$_.Exception.Message
}

$script:FakeBridgeRoot = 'C:\Users\Tester\AppData\Local\OZK-TOBACCO\PrintBridge'

Test-Case "المولّد يُنتج ملفاً فيه سطر cmd" {
    Assert-True ($null -eq $script:GeneratorError) "تعذّر توليد الـwrapper: $($script:GeneratorError)"
    Assert-True (-not [string]::IsNullOrWhiteSpace($script:GeneratedCmdExpression)) "يجب استخراج تعبير cmd"
}

Test-Case "سطر cmd المولَّد صالح نحوياً كتعبير VBScript" {
    $value = ConvertFrom-VbsExpression $script:GeneratedCmdExpression @{ bridgeRoot = $script:FakeBridgeRoot }
    Assert-True (-not [string]::IsNullOrWhiteSpace($value)) "يجب أن ينتج قيمة"
}

Test-Case "قيمة cmd تبدأ بمسار powershell.exe محاطاً باقتباسين" {
    $value = ConvertFrom-VbsExpression $script:GeneratedCmdExpression @{ bridgeRoot = $script:FakeBridgeRoot }
    $expected = '"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"'
    Assert-True ($value.StartsWith($expected)) "يجب أن تبدأ القيمة بـ$expected — بدأت بـ: [$($value.Substring(0, [math]::Min(70, $value.Length)))]"
}

Test-Case "مسار -File مُقتبس بشكل صحيح مع bridgeRoot الفعلي" {
    $value = ConvertFrom-VbsExpression $script:GeneratedCmdExpression @{ bridgeRoot = $script:FakeBridgeRoot }
    Assert-True ($value -like "*-File `"$($script:FakeBridgeRoot)\ozk-print-bridge-watchdog.ps1`"*") "مسار الـwatchdog يجب أن يكون مُقتبساً وموصولاً بـbridgeRoot"
}

Test-Case "بقية الوسائط مُقتبسة ومحفوظة كما هي (بلا تغيير في السلوك)" {
    $value = ConvertFrom-VbsExpression $script:GeneratedCmdExpression @{ bridgeRoot = $script:FakeBridgeRoot }
    Assert-True ($value -like "*-BridgeRoot `"$($script:FakeBridgeRoot)`"*") "-BridgeRoot يجب أن يكون مُقتبساً"
    Assert-True ($value -like '*-PrinterName "XPRINTER XP-T80Q 80MM"*') "-PrinterName يجب أن يبقى كما هو ومُقتبساً"
    Assert-True ($value -like "*-StatePath `"$($script:FakeBridgeRoot)\state.json`"*") "-StatePath يجب أن يكون مُقتبساً"
    Assert-True ($value -like "*-LogPath `"$($script:FakeBridgeRoot)\logs\events.jsonl`"*") "-LogPath يجب أن يكون مُقتبساً"
    Assert-True ($value -like '*-NoProfile*' -and $value -like '*-NonInteractive*' -and $value -like '*-ExecutionPolicy Bypass*') "وسائط PowerShell يجب أن تبقى"
    Assert-True ($value -like '*-ConfirmPhysicalPrint*') "-ConfirmPhysicalPrint يجب أن يبقى ممرَّراً"
}

Test-Case "الكاشير فقط: لا -IncludeWholesale في الأمر المولَّد" {
    $value = ConvertFrom-VbsExpression $script:GeneratedCmdExpression @{ bridgeRoot = $script:FakeBridgeRoot }
    Assert-True ($value -notlike '*-IncludeWholesale*') "لا يجوز تمرير -IncludeWholesale في wrapper الكاشير"
}

Test-Case "لا اقتباس ناقص ولا زائد في القيمة النهائية" {
    $value = ConvertFrom-VbsExpression $script:GeneratedCmdExpression @{ bridgeRoot = $script:FakeBridgeRoot }
    $quoteCount = ([regex]::Matches($value, '"')).Count
    Assert-True (($quoteCount % 2) -eq 0) "عدد الاقتباسات في القيمة النهائية يجب أن يكون زوجياً، وُجد: $quoteCount"
    Assert-True ($quoteCount -eq 12) "يجب وجود ستة وسائط مُقتبسة (12 اقتباساً): exe و-File و-BridgeRoot و-PrinterName و-StatePath و-LogPath — وُجد: $quoteCount"
}

Write-Host "`n$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
