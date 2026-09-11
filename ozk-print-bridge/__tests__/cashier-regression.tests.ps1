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
# يتحمّل LF وCRLF معاً: checkout حقيقي على ويندوز مع core.autocrlf=true يعطي
# \r\n، وأي checkout آخر (لينكس أو .gitattributes مختلف) قد يعطي \n فقط. لا
# نفترض أياً منهما — نطابق \r?\n صراحة بدل marker حرفي بنهاية سطر واحدة.
function Get-ExtractedFunctionText([string]$SourceText, [string]$Signature) {
    $startIdx = $SourceText.IndexOf($Signature)
    Assert-True ($startIdx -ge 0) "لم يُعثر على التوقيع: $Signature"
    $braceOpen = $SourceText.IndexOf("{", $startIdx)
    $endMatch = [regex]::Match($SourceText.Substring($braceOpen), "\r?\n\}\r?\n")
    Assert-True $endMatch.Success "تعذّر تحديد نهاية الدالة لـ: $Signature"
    $endIdx = $braceOpen + $endMatch.Index
    $closingBraceIdx = $SourceText.IndexOf("}", $endIdx)
    return $SourceText.Substring($startIdx, ($closingBraceIdx + 1) - $startIdx)
}

$bridgeSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge.ps1") -Raw
$watchdogSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge-watchdog.ps1") -Raw

$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture

# تُستخرج كل دوال التمثيل القانوني من المصدر الفعلي، فما يُختبر هنا هو العقد
# نفسه الذي يعمل في الإنتاج لا نسخة موازية منه.
foreach ($signature in @(
    "function Format-CanonicalValue(`$Value) {",
    "function Get-CanonicalLineText(`$Line, [bool]`$IncludeRecordIdentity) {",
    "function Get-CanonicalReceiptText(`$Header, `$Lines, [bool]`$IncludeRecordIdentity, [string]`$BranchGuid = `"`", `$Balance = `$null) {",
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
    $m = [regex]::Match($bridgeSrc.Substring($b), "\r?\n\}\r?\n")
    $e = $b + $m.Index
    $c = $bridgeSrc.IndexOf("}", $e)
    return $bridgeSrc.Substring($s, ($c + 1) - $s)
}
$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture
foreach ($signature in @(
    'function Format-CanonicalValue($Value) {',
    'function Get-CanonicalLineText($Line, [bool]$IncludeRecordIdentity) {',
    'function Get-CanonicalReceiptText($Header, $Lines, [bool]$IncludeRecordIdentity, [string]$BranchGuid = "", $Balance = $null) {',
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

function New-TestReceipt([int]$LineCount, [string]$NamePattern = "مادة تجريبية", [int]$InvoiceNumber = 1001) {
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
        InvoiceNumber = $InvoiceNumber
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

Write-Host "`n== P1-K: فاتورة متعذّرة التصيير تُعزل ولا تحجب الطابور =="

. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Test-PermanentInvoiceFailure(`$ErrorRecord) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Get-QuarantineDecision(`$State, [string]`$InvoiceGuid, [string]`$Fingerprint) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Add-QuarantineEntry(`$State, `$Candidate, [string]`$Fingerprint, `$ErrorRecord) {")))

function New-ErrorRecordOf($Exception) {
    return [System.Management.Automation.ErrorRecord]::new($Exception, "test", "NotSpecified", $null)
}

Test-Case "التصنيف: تعذّر التصيير الحتمي يُميَّز" {
    $record = New-ErrorRecordOf (New-Object OzkReceiptUnrenderableException("Receipt layout needs 21000 px which exceeds the 15000 px safety limit"))
    Assert-True (Test-PermanentInvoiceFailure $record) "تجاوز حدّ الارتفاع يجب أن يُصنَّف حتمياً"
}

Test-Case "التصنيف: الأعطال العابرة تبقى غير حتمية (الافتراض الآمن إعادة المحاولة)" {
    foreach ($ex in @(
        (New-Object OzkSpoolNotSubmittedException("OpenPrinter failed with Win32 error 1801")),
        (New-Object System.IO.IOException("transient I/O")),
        (New-Object InvalidOperationException("Printer queue not found or ambiguous: XPRINTER XP-T80Q 80MM"))
    )) {
        Assert-True (-not (Test-PermanentInvoiceFailure (New-ErrorRecordOf $ex))) "يجب ألا يُصنَّف حتمياً: $($ex.GetType().Name)"
    }
}

Test-Case "التصنيف يفحص InnerException" {
    $inner = New-Object OzkReceiptUnrenderableException("too tall")
    $outer = New-Object System.Management.Automation.MethodInvocationException("wrapped", $inner)
    Assert-True (Test-PermanentInvoiceFailure (New-ErrorRecordOf $outer)) "الاستثناء المغلَّف يجب أن يُصنَّف حتمياً"
}

# ── محاكاة نبضة كاملة على طابور من ثلاث فواتير ────────────────────────────
# تستعمل دوال العزل والحالة الحقيقية المستخرَجة من المصدر. لا SQL ولا طباعة.
function New-QueueCandidate([string]$Guid, [int]$Number, [string]$Fingerprint) {
    [pscustomobject]@{ InvoiceGuid = $Guid; InvoiceNumber = $Number; Fingerprint = $Fingerprint }
}

# $Behaviour: guid -> "ok" | "permanent" | "transient"
function Invoke-QueuePoll([string]$StatePath, $Queue, [hashtable]$Behaviour, [switch]$LegacyNoQuarantine) {
    $state = Read-BridgeState $StatePath
    $printed = New-Object System.Collections.Generic.List[string]
    $escaped = $null
    foreach ($candidate in $Queue) {
        if ($state.seen.ContainsKey($candidate.InvoiceGuid)) { continue }

        if (-not $LegacyNoQuarantine) {
            $decision = Get-QuarantineDecision $state $candidate.InvoiceGuid $candidate.Fingerprint
            if ($decision -eq "skip") { continue }
            if ($decision -eq "reevaluate") { [void]$state.quarantined.Remove($candidate.InvoiceGuid) }
        }

        $mode = if ($Behaviour.ContainsKey($candidate.InvoiceGuid)) { [string]$Behaviour[$candidate.InvoiceGuid] } else { "ok" }
        $prepareError = $null
        if ($mode -eq "permanent") { $prepareError = New-ErrorRecordOf (New-Object OzkReceiptUnrenderableException("receipt exceeds renderer safety height")) }
        elseif ($mode -eq "transient") { $prepareError = New-ErrorRecordOf (New-Object System.IO.IOException("printer queue temporarily unavailable")) }

        if ($null -ne $prepareError) {
            if ($LegacyNoQuarantine) {
                # السلوك القديم: الاستثناء يخرج من الحلقة فيموت الجسر
                $escaped = $prepareError
                break
            }
            if (-not (Test-PermanentInvoiceFailure $prepareError)) {
                $escaped = $prepareError    # العابر يخرج كما كان — لا عزل
                break
            }
            Add-QuarantineEntry $state $candidate $candidate.Fingerprint $prepareError
            Write-BridgeState $StatePath $state
            continue
        }

        $state.seen[$candidate.InvoiceGuid] = [ordered]@{ status = "spooled"; invoiceNumber = $candidate.InvoiceNumber }
        Write-BridgeState $StatePath $state
        $printed.Add($candidate.InvoiceGuid)
    }
    return [pscustomobject]@{ Printed = $printed.ToArray(); Escaped = $escaped; State = (Read-BridgeState $StatePath) }
}

$script:QueueABC = @(
    (New-QueueCandidate "aaaa-1111" 1001 "fp-A-v1"),
    (New-QueueCandidate "bbbb-2222" 1002 "fp-B"),
    (New-QueueCandidate "cccc-3333" 1003 "fp-C")
)

Test-Case "1) السلوك القديم: A الحتمية تُسقط النبضة ولا تصل B/C إطلاقاً" {
    $path = New-StatePath
    $result = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" } -LegacyNoQuarantine
    Assert-True ($result.Printed.Count -eq 0) "لا يجوز أن تُطبع أي فاتورة في السلوك القديم، طُبع: $($result.Printed.Count)"
    Assert-True ($null -ne $result.Escaped) "الاستثناء يجب أن يخرج من الحلقة"
    # وتكرار النبضات لا يغيّر شيئاً: A بلا علامة فتُقابَل أولاً كل مرة
    for ($i = 0; $i -lt 5; $i++) { [void](Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" } -LegacyNoQuarantine) }
    $reloaded = Read-BridgeState $path
    Assert-True ($reloaded.seen.Count -eq 0) "خمس إعادات تشغيل يجب ألا تطبع شيئاً — هذا هو الحجب"
}

Test-Case "1ب) بعد الإصلاح: A تُعزل وتُطبع B و C في النبضة نفسها" {
    $path = New-StatePath
    $result = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" }
    Assert-True ($null -eq $result.Escaped) "لا يجوز أن يخرج استثناء ويُسقط الطابور"
    Assert-True ($result.Printed.Count -eq 2) "يجب طباعة فاتورتين، طُبع: $($result.Printed.Count)"
    Assert-True ($result.Printed -contains "bbbb-2222" -and $result.Printed -contains "cccc-3333") "B و C يجب أن تُطبعا"
    Assert-True ($result.State.quarantined.ContainsKey("aaaa-1111")) "A يجب أن تُعزل"
    Assert-True (-not $result.State.seen.ContainsKey("aaaa-1111")) "A يجب ألا تُعتبر مطبوعة إطلاقاً"
}

Test-Case "لا تُخفى كمطبوعة: العزل منفصل عن seen وفيه سبب وفئة" {
    $path = New-StatePath
    $result = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" }
    $entry = $result.State.quarantined["aaaa-1111"]
    Assert-True ([string]$entry.category -eq "permanent_render_failure") "يجب تسجيل الفئة"
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$entry.reason)) "يجب تسجيل السبب"
    Assert-True ([string]$entry.fingerprint -eq "fp-A-v1") "يجب تخزين بصمة المحتوى الفاشل"
    Assert-True ([int]$entry.invoiceNumber -eq 1001) "يجب تسجيل رقم الفاتورة"
}

Test-Case "2) نبضات لاحقة بنفس البصمة: تُتخطّى بلا حلقة ولا حجب" {
    $path = New-StatePath
    [void](Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" })
    for ($i = 0; $i -lt 5; $i++) {
        $again = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" }
        Assert-True ($null -eq $again.Escaped) "لا يجوز أن تُسقط النبضة"
        Assert-True ($again.Printed.Count -eq 0) "B و C مطبوعتان سابقاً فلا تُعادان"
    }
    $final = Read-BridgeState $path
    Assert-True ($final.quarantined.ContainsKey("aaaa-1111")) "تبقى معزولة"
    Assert-True (-not $final.seen.ContainsKey("aaaa-1111")) "وتبقى غير مطبوعة"
    Assert-True ($final.seen.Count -eq 2) "B و C فقط هما المطبوعتان"
}

Test-Case "3) نفس GUID ببصمة جديدة: يُعاد تقييمها وتُطبع مرة واحدة" {
    $path = New-StatePath
    [void](Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" })
    Assert-True ((Read-BridgeState $path).quarantined.ContainsKey("aaaa-1111")) "معزولة أولاً"
    # عُدّلت الفاتورة: بصمة جديدة ومحتوى صار قابلاً للتصيير
    $editedQueue = @(
        (New-QueueCandidate "aaaa-1111" 1001 "fp-A-v2"),
        (New-QueueCandidate "bbbb-2222" 1002 "fp-B"),
        (New-QueueCandidate "cccc-3333" 1003 "fp-C")
    )
    $after = Invoke-QueuePoll $path $editedQueue @{}
    Assert-True ($after.Printed -contains "aaaa-1111") "يجب أن تُطبع بعد التعديل"
    Assert-True (-not $after.State.quarantined.ContainsKey("aaaa-1111")) "يجب رفع العزل"
    $again = Invoke-QueuePoll $path $editedQueue @{}
    Assert-True ($again.Printed.Count -eq 0) "ولا تُطبع مرة ثانية"
}

Test-Case "4) الفشل العابر قبل التسليم لا يُعزَل ويبقى قابلاً لإعادة المحاولة" {
    $path = New-StatePath
    $result = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "transient" }
    Assert-True ($null -ne $result.Escaped) "العابر يجب أن يخرج كما كان (دلالات P1-F بلا تغيير)"
    Assert-True (-not $result.State.quarantined.ContainsKey("aaaa-1111")) "لا يجوز عزل الفشل العابر"
    Assert-True (-not $result.State.seen.ContainsKey("aaaa-1111")) "ولا اعتبارها مطبوعة"
    # عند زوال العطل تُطبع طبيعياً
    $recovered = Invoke-QueuePoll $path $script:QueueABC @{}
    Assert-True ($recovered.Printed -contains "aaaa-1111") "بعد زوال العطل العابر يجب أن تُطبع"
}

Test-Case "5) النجاح الطبيعي بلا تغيير" {
    $path = New-StatePath
    $result = Invoke-QueuePoll $path $script:QueueABC @{}
    Assert-True ($result.Printed.Count -eq 3) "الثلاث يجب أن تُطبع، طُبع: $($result.Printed.Count)"
    Assert-True ($result.State.quarantined.Count -eq 0) "لا عزل بلا سبب"
    $again = Invoke-QueuePoll $path $script:QueueABC @{}
    Assert-True ($again.Printed.Count -eq 0) "ولا إعادة طباعة"
}

Test-Case "6) دلالات ما بعد التسليم لم تتغيّر (العلامة والغموض كما هما)" {
    Assert-True ($bridgeSrc -match 'status = "print_in_flight"') "علامة قيد الإرسال باقية"
    Assert-True ($bridgeSrc -match 'Event = "state_persist_failed_after_spool"') "معالجة فشل الحفظ بعد التسليم باقية"
    Assert-True ($bridgeSrc -match 'Event = "pre_submission_failure_retryable"') "تراجع الفشل قبل التسليم باقٍ"
    # العزل يقع قبل العلامة، فلا يمسّ منطقة الغموض إطلاقاً
    $quarantineIdx = $bridgeSrc.IndexOf("Add-QuarantineEntry `$state `$candidate")
    $markerIdx = $bridgeSrc.IndexOf('status = "print_in_flight"')
    Assert-True ($quarantineIdx -ge 0 -and $markerIdx -ge 0) "يجب وجود الموضعين"
    Assert-True ($quarantineIdx -lt $markerIdx) "العزل يجب أن يقع قبل علامة قيد الإرسال"
}

Test-Case "7) العزل يبقى بعد إعادة التشغيل (يُقرأ من القرص)" {
    $path = New-StatePath
    [void](Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" })
    # إعادة تشغيل = قراءة جديدة من الملف
    $reloaded = Read-BridgeState $path
    Assert-True ($reloaded.quarantined.ContainsKey("aaaa-1111")) "العزل يجب أن يُقرأ بعد إعادة التشغيل"
    Assert-True ([string]$reloaded.quarantined["aaaa-1111"].fingerprint -eq "fp-A-v1") "البصمة يجب أن تبقى محفوظة"
    $afterRestart = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" }
    Assert-True ($null -eq $afterRestart.Escaped) "بعد إعادة التشغيل لا يجوز أن تُسقط الفاتورة نفسها الطابور"
}

Test-Case "8) حالة عزل تالفة/ناقصة: تُعاد المحاولة بأمان بلا انهيار" {
    $path = New-StatePath
    $state = Read-BridgeState $path
    $state.quarantined["dddd-4444"] = [ordered]@{ invoiceNumber = 1009 }   # بلا بصمة
    Write-BridgeState $path $state
    $reloaded = Read-BridgeState $path
    $decision = Get-QuarantineDecision $reloaded "dddd-4444" "fp-anything"
    Assert-True ($decision -eq "reevaluate") "الحالة الناقصة يجب أن تُعاد لا أن تُخفي الفاتورة، النتيجة: $decision"
    $decisionNull = Get-QuarantineDecision $reloaded "not-there" "fp-x"
    Assert-True ($decisionNull -eq "proceed") "غير المعزولة يجب أن تمرّ"
}

Test-Case "9) ملف حالة بلا حقل quarantined إطلاقاً (توافق خلفي)" {
    $path = New-StatePath
    $state = Read-BridgeState $path
    $state.seen["zzzz-9999"] = [ordered]@{ status = "spooled"; invoiceNumber = 1 }
    $state.Remove("quarantined")
    Write-BridgeState $path $state
    $reloaded = Read-BridgeState $path
    Assert-True ($null -ne $reloaded.quarantined) "يجب أن يبدأ بعزل فارغ لا null"
    Assert-True ((Get-QuarantineDecision $reloaded "any-guid" "fp") -eq "proceed") "ولا يسقط"
}

Test-Case "المعزولات تُعلَن عند الإقلاع (أثر واضح للمراجعة اليدوية)" {
    Assert-True ($bridgeSrc -match 'Event = "quarantined_invoice_carried_over"') "يجب إعلان كل فاتورة معزولة عند الإقلاع"
    Assert-True ($bridgeSrc -match 'Remedy = "not printed and not marked printed') "يجب توضيح أنها غير مطبوعة وطريق المعالجة"
    Assert-True ($bridgeSrc -match 'Event = "quarantine_released"') "يجب تسجيل رفع العزل عند تغيّر المحتوى"
}

Test-Case "negative witness: بلا عزل يعود الاستثناء ليحجب الطابور" {
    $path = New-StatePath
    $withQuarantine = Invoke-QueuePoll $path $script:QueueABC @{ "aaaa-1111" = "permanent" }
    $path2 = New-StatePath
    $withoutQuarantine = Invoke-QueuePoll $path2 $script:QueueABC @{ "aaaa-1111" = "permanent" } -LegacyNoQuarantine
    Assert-True ($withQuarantine.Printed.Count -eq 2) "مع العزل تُطبع فاتورتان"
    Assert-True ($withoutQuarantine.Printed.Count -eq 0) "بلا عزل لا تُطبع أي فاتورة — وهذا هو العطل"
}

Test-Case "المصدر: التحضير محاط بمعالجة تعزل الحتمي وتمرّر العابر" {
    Assert-True ($bridgeSrc -match '(?s)\$spoolJob = New-OzkReceiptSpoolJob[^\r\n]*\r?\n\s*\} catch \{\s*\r?\n\s*if \(-not \(Test-PermanentInvoiceFailure \$_\)\) \{ throw \}') "الفشل غير الحتمي يجب أن يُعاد رميه كما كان"
    Assert-True ($bridgeSrc -match 'Event = "permanent_render_failure"') "يجب تسجيل الفشل الحتمي بحدث صريح"
}

Write-Host "`n== P1-L: الرصيد المحاسبي جزء من فحص الاستقرار =="

. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Wait-InvoiceReady(`$Connection, [guid]`$InvoiceGuid) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Convert-ToReceiptAmount(`$Header, `$Value) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Convert-SnapshotToReceipt(`$Snapshot) {")))

function New-TestBalance([bool]$Found, [double]$Previous = 0, [double]$Current = 0) {
    return [pscustomobject]@{ Previous = $Previous; Current = $Current; Found = $Found }
}

# التوقيع كما تحسبه اللقطة الحقيقية: نفس الاستدعاء الموجود في Get-InvoiceSnapshot
function Get-SnapshotSignatureWithBalance($Snapshot, $Balance) {
    return Get-CanonicalHash (Get-CanonicalReceiptText $Snapshot.Header $Snapshot.Lines $true "" $Balance)
}

function New-SnapshotWithBalance($Balance) {
    $snap = New-Snapshot
    $snap | Add-Member -NotePropertyName Balance -NotePropertyValue $Balance -Force
    $snap | Add-Member -NotePropertyName Signature -NotePropertyValue (Get-SnapshotSignatureWithBalance $snap $Balance) -Force
    return $snap
}

# محاكاة Wait-InvoiceReady الحقيقية: لقطتان متتاليتان ومقارنة التوقيع.
# $Sequence هي قائمة اللقطات التي تُعيدها القراءات المتتالية.
$script:SnapshotQueue = $null
$script:SnapshotReads = 0
function Get-InvoiceSnapshot($Connection, [guid]$InvoiceGuid) {
    $index = [math]::Min($script:SnapshotReads, $script:SnapshotQueue.Count - 1)
    $script:SnapshotReads++
    return $script:SnapshotQueue[$index]
}
$StabilityMilliseconds = 1

function Invoke-ReadinessOn($Sequence) {
    $script:SnapshotQueue = @($Sequence)
    $script:SnapshotReads = 0
    return Wait-InvoiceReady $null ([guid]::NewGuid())
}

Test-Case "1) الفاتورة مستقرة والرصيد مستقر → ready" {
    $balance = New-TestBalance $true 1000 2500
    $a = New-SnapshotWithBalance $balance
    $b = New-SnapshotWithBalance $balance
    $result = Invoke-ReadinessOn @($a, $b)
    Assert-True $result.Ready "يجب أن تُعتبر جاهزة"
}

Test-Case "2) الفاتورة مستقرة والرصيد يتغيّر → not ready (جوهر العطل)" {
    $a = New-SnapshotWithBalance (New-TestBalance $true 1000 2500)
    $b = New-SnapshotWithBalance (New-TestBalance $true 1000 3900)
    # نفس بيانات الفاتورة تماماً — الفرق في الرصيد وحده
    Assert-True ($a.Header.InvoiceTotal -eq $b.Header.InvoiceTotal) "بيانات الفاتورة يجب أن تكون متطابقة"
    Assert-True ($a.LineCount -eq $b.LineCount) "عدد الأسطر متطابق"
    $result = Invoke-ReadinessOn @($a, $b)
    Assert-True (-not $result.Ready) "تغيّر الرصيد يجب أن يمنع الجاهزية"
}

Test-Case "2ب) بعد استقرار الرصيد تُعتبر جاهزة (إعادة المحاولة تنجح)" {
    $stable = New-TestBalance $true 1000 3900
    $result = Invoke-ReadinessOn @((New-SnapshotWithBalance $stable), (New-SnapshotWithBalance $stable))
    Assert-True $result.Ready "بعد استقرار الرصيد يجب أن تُعتبر جاهزة"
}

Test-Case "3) BalanceFound=false في القراءتين → ready (لا نشترط وجود الرصيد)" {
    $none = New-TestBalance $false
    $result = Invoke-ReadinessOn @((New-SnapshotWithBalance $none), (New-SnapshotWithBalance $none))
    Assert-True $result.Ready "غياب المستند المحاسبي لا يمنع الطباعة ما دام مستقراً"
}

Test-Case "4) Found: false ثم true → not ready" {
    $result = Invoke-ReadinessOn @(
        (New-SnapshotWithBalance (New-TestBalance $false)),
        (New-SnapshotWithBalance (New-TestBalance $true 0 500)))
    Assert-True (-not $result.Ready) "ظهور المستند بين القراءتين يعني أن الترحيل جارٍ"
}

Test-Case "5) Found: true ثم false → not ready" {
    $result = Invoke-ReadinessOn @(
        (New-SnapshotWithBalance (New-TestBalance $true 0 500)),
        (New-SnapshotWithBalance (New-TestBalance $false)))
    Assert-True (-not $result.Ready) "اختفاء المستند بين القراءتين يعني أن الترحيل جارٍ"
}

Test-Case "تغيّر الرصيد السابق وحده يكفي لمنع الجاهزية" {
    $result = Invoke-ReadinessOn @(
        (New-SnapshotWithBalance (New-TestBalance $true 1000 2500)),
        (New-SnapshotWithBalance (New-TestBalance $true 1750 2500)))
    Assert-True (-not $result.Ready) "الرصيد السابق مطبوع فيجب أن يدخل في الاستقرار"
}

Test-Case "6) الرصيد يتذبذب ثم يستقر → القيمة المطبوعة هي الأخيرة المستقرة" {
    $settled = New-TestBalance $true 1000 4200
    $result = Invoke-ReadinessOn @((New-SnapshotWithBalance $settled), (New-SnapshotWithBalance $settled))
    Assert-True $result.Ready "يجب أن تستقر"
    $receipt = Convert-SnapshotToReceipt $result.Snapshot
    Assert-True ($receipt.BalanceFound) "يجب أن يظهر الرصيد"
    Assert-True ($receipt.PreviousBalance -eq 1000) "الرصيد السابق يجب أن يكون القيمة المستقرة، وُجد: $($receipt.PreviousBalance)"
    Assert-True ($receipt.CurrentBalance -eq 4200) "الرصيد الحالي يجب أن يكون القيمة المستقرة، وُجد: $($receipt.CurrentBalance)"
}

Test-Case "7) تغيّر بيانات الفاتورة والرصيد ثابت → يبقى not ready كما كان" {
    $balance = New-TestBalance $true 1000 2500
    $a = New-Snapshot
    $a | Add-Member -NotePropertyName Balance -NotePropertyValue $balance -Force
    $a | Add-Member -NotePropertyName Signature -NotePropertyValue (Get-SnapshotSignatureWithBalance $a $balance) -Force
    $b = New-Snapshot -CustomerName "زبون مختلف"
    $b | Add-Member -NotePropertyName Balance -NotePropertyValue $balance -Force
    $b | Add-Member -NotePropertyName Signature -NotePropertyValue (Get-SnapshotSignatureWithBalance $b $balance) -Force
    $result = Invoke-ReadinessOn @($a, $b)
    Assert-True (-not $result.Ready) "تغيّر بيانات الفاتورة يجب أن يبقى مانعاً للجاهزية"
}

Test-Case "8) «ما استقرّ هو ما يُطبع»: لا استعلام رصيد بعد اكتمال الاستقرار" {
    # Convert-SnapshotToReceipt لم تعد تأخذ اتصالاً أصلاً، فلا سبيل لاستعلام جديد.
    Assert-True ($bridgeSrc -match 'function Convert-SnapshotToReceipt\(\$Snapshot\)') "يجب ألا تأخذ الدالة اتصالاً"
    Assert-True ($bridgeSrc -notmatch 'Convert-SnapshotToReceipt \$connection') "لا يجوز تمرير اتصال في أي موضع استدعاء"
    # ولا يرد استعلام الرصيد إلا داخل اللقطة
    $balanceCalls = [regex]::Matches($bridgeSrc, '\$balance = Get-InvoiceDocumentBalance')
    Assert-True ($balanceCalls.Count -eq 1) "يجب أن يُستدعى استعلام الرصيد من موضع واحد فقط (داخل اللقطة)، وُجد: $($balanceCalls.Count)"
    $snapshotText = Get-ExtractedFunctionText $bridgeSrc "function Get-InvoiceSnapshot(`$Connection, [guid]`$InvoiceGuid) {"
    Assert-True ($snapshotText -match 'Get-InvoiceDocumentBalance') "الاستدعاء يجب أن يكون داخل Get-InvoiceSnapshot"
    $convertText = Get-ExtractedFunctionText $bridgeSrc "function Convert-SnapshotToReceipt(`$Snapshot) {"
    Assert-True ($convertText -notmatch 'Get-InvoiceDocumentBalance') "لا يجوز استعلام الرصيد أثناء بناء الإيصال"
    Assert-True ($convertText -match '\$Snapshot\.Balance') "يجب أن يستهلك الرصيد المُثبَّت من اللقطة"
}

Test-Case "الرصيد يُقرأ مرة واحدة لكل لقطة (لا مضاعفة استعلامات)" {
    $snapshotText = Get-ExtractedFunctionText $bridgeSrc "function Get-InvoiceSnapshot(`$Connection, [guid]`$InvoiceGuid) {"
    $calls = [regex]::Matches($snapshotText, 'Get-InvoiceDocumentBalance')
    Assert-True ($calls.Count -eq 1) "استدعاء واحد داخل اللقطة، وُجد: $($calls.Count)"
    Assert-True ($snapshotText -match 'if \(-not \[string\]::IsNullOrWhiteSpace\(\$header\.CustomerName\)\)') "الشرط الأصلي (لا رصيد بلا اسم زبون) يجب أن يبقى"
}

Test-Case "9) فشل عابر في استعلام الرصيد → يخرج بأمان بلا طباعة" {
    $script:BalanceShouldFail = $true
    function Get-InvoiceDocumentBalance($Connection, [guid]$InvoiceGuid) {
        if ($script:BalanceShouldFail) { throw "transient ledger query failure" }
        return New-TestBalance $true 1000 2500
    }
    # اللقطة الحقيقية تستدعي الرصيد، ففشله يخرج ولا ينتج إيصالاً
    Assert-Throws { Get-InvoiceDocumentBalance $null ([guid]::NewGuid()) } "الفشل العابر يجب أن يخرج"
    $script:BalanceShouldFail = $false
    $recovered = Get-InvoiceDocumentBalance $null ([guid]::NewGuid())
    Assert-True ($recovered.Found) "بعد زوال العطل يجب أن ينجح"
}

Test-Case "10) دلالات الطباعة الناجحة لم تتغيّر" {
    Assert-True ($bridgeSrc -match 'status = "print_in_flight"') "علامة قيد الإرسال باقية"
    Assert-True ($bridgeSrc -match 'Event = "permanent_render_failure"') "عزل الفشل الحتمي باقٍ"
    Assert-True ($bridgeSrc -match 'submitted_to_spooler:') "دلالة التسليم للطابور باقية"
    # بصمة كشف التكرار لم يدخلها الرصيد: تصف البيعة لا حالة الحساب
    $fingerprintText = Get-ExtractedFunctionText $bridgeSrc "function Get-InvoiceFingerprint(`$Candidate, `$Snapshot) {"
    Assert-True ($fingerprintText -notmatch 'Balance') "الرصيد يجب ألا يدخل في بصمة التكرار"
}

Test-Case "negative witness: إخراج الرصيد من التوقيع يعيد اعتبار الفاتورة مستقرة خطأً" {
    # التوقيع القديم: بلا رصيد إطلاقاً
    $a = New-Snapshot; $b = New-Snapshot
    $legacyA = Get-CanonicalHash (Get-CanonicalReceiptText $a.Header $a.Lines $true)
    $legacyB = Get-CanonicalHash (Get-CanonicalReceiptText $b.Header $b.Lines $true)
    Assert-True ($legacyA -eq $legacyB) "التوقيع القديم لا يرى الرصيد أصلاً"
    # التوقيع الحالي يفرّق بين رصيدين مختلفين لنفس الفاتورة
    $withA = Get-SnapshotSignatureWithBalance $a (New-TestBalance $true 1000 2500)
    $withB = Get-SnapshotSignatureWithBalance $b (New-TestBalance $true 1000 3900)
    Assert-True ($withA -ne $withB) "التوقيع الحالي يجب أن يلتقط تغيّر الرصيد"
    Assert-True ($legacyA -ne $withA) "ضمّ الرصيد يجب أن يغيّر التوقيع فعلاً"
}

Write-Host "`n== P1-N: رقم الفاتورة يظهر على الإيصال المطبوع =="

Test-Case "1) InvoiceNumber ينتقل من رأس اللقطة إلى الإيصال" {
    $receipt = Convert-SnapshotToReceipt (New-Snapshot -InvoiceNumber 4321)
    Assert-True ($receipt.InvoiceNumber -eq 4321) "الإيصال يجب أن يحمل رقم الفاتورة من الرأس، وُجد: $($receipt.InvoiceNumber)"
}

Test-Case "2) المُصيِّر يرسم رقم الفاتورة فعلاً، ومرة واحدة غير مشروطة" {
    $drawText = Get-ExtractedFunctionText $rendererSrc "function Invoke-OzkReceiptDrawing(`$Graphics, `$Receipt, `$Logo) {"
    $calls = [regex]::Matches($drawText, '\$Receipt\.InvoiceNumber')
    Assert-True ($calls.Count -ge 1) "يجب أن يقرأ المُصيِّر Receipt.InvoiceNumber فعلاً"
    Assert-True ($drawText -match 'رقم الفاتورة:\s*\{0\}.*-f \$Receipt\.InvoiceNumber') "يجب رسم نص عربي واضح لرقم الفاتورة"
    # يقع الرسم قبل حلقة البنود (foreach)، فلا يتوقف على عددها ولا يختفي بطول الفاتورة
    $numberIdx = $drawText.IndexOf('$Receipt.InvoiceNumber')
    $loopIdx = $drawText.IndexOf('foreach')
    Assert-True ($loopIdx -lt 0 -or $numberIdx -lt $loopIdx) "رسم رقم الفاتورة يجب أن يسبق أي حلقة على البنود لا أن يعتمد عليها"
}

Test-Case "3) الرقم المعروض هو رقم الفاتورة الفعلي لا رقم مُشتق" {
    $receipt = Convert-SnapshotToReceipt (New-Snapshot -InvoiceNumber 9999)
    Assert-True ($receipt.InvoiceNumber -eq 9999) "يجب أن يطابق رقم الفاتورة الحقيقي حرفياً"
    Assert-True ($receipt.InvoiceNumber -ne $receipt.ItemCount) "يجب ألا يكون الرقم مشتقاً من عدد البنود"
    Assert-True ($receipt.InvoiceNumber -ne $receipt.LineCount) "يجب ألا يكون الرقم مشتقاً من عدد أسطر اللقطة"
}

Test-Case "4) فاتورتان مختلفتا الرقم تنتجان قيمتين مختلفتين على الإيصال" {
    $r1 = Convert-SnapshotToReceipt (New-Snapshot -InvoiceNumber 100)
    $r2 = Convert-SnapshotToReceipt (New-Snapshot -InvoiceNumber 200)
    Assert-True ($r1.InvoiceNumber -ne $r2.InvoiceNumber) "رقمان مختلفان في اللقطة يجب أن يبقيا مختلفين على الإيصال"
    Assert-True ($r1.InvoiceNumber -eq 100 -and $r2.InvoiceNumber -eq 200) "يجب أن يطابق كل إيصال رقم فاتورته هو، وُجد: $($r1.InvoiceNumber) / $($r2.InvoiceNumber)"
}

Test-RenderCase "5) لا اختفاء لرقم الفاتورة على فاتورة طويلة (40 بند تتجاوز الالتفاف)" {
    $longName = "مادة ذات اسم طويل جداً يجبر السطر على الالتفاف أكثر من مرة داخل عمود الاسم"
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 40 $longName 5555) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Height -gt 0) "يجب أن تُصيَّر الفاتورة الطويلة بلا استثناء رغم وجود رقم الفاتورة"
    } finally { $bitmap.Dispose() }
}

Test-Case "6) لا تغيّر على الحقول الراسخة الأخرى (العميل والبيان والتاريخ والوقت)" {
    $receipt = Convert-SnapshotToReceipt (New-Snapshot -InvoiceNumber 777 -CustomerName "زبون ثابت")
    Assert-True ($receipt.CustomerName -eq "زبون ثابت") "اسم الزبون يجب ألا يتأثر بإضافة رقم الفاتورة"
    Assert-True (-not [string]::IsNullOrEmpty($receipt.Date)) "التاريخ يجب أن يبقى موجوداً كما كان"
    Assert-True (-not [string]::IsNullOrEmpty($receipt.Time)) "الوقت يجب أن يبقى موجوداً كما كان"
    Assert-True ($receipt.Description -eq "-") "البيان يجب ألا يتأثر"
    $drawText = Get-ExtractedFunctionText $rendererSrc "function Invoke-OzkReceiptDrawing(`$Graphics, `$Receipt, `$Logo) {"
    Assert-True ($drawText -match 'العميل:\s*\{0\}.*-f \$Receipt\.CustomerName') "سطر العميل يجب أن يبقى كما هو"
    Assert-True ($drawText -match 'البيان:\s*\{0\}.*-f \$Receipt\.Description') "سطر البيان يجب أن يبقى كما هو"
}

Test-Case "وحدة العرض: New-OzkReceiptSpoolJob يفشل مغلقاً بلا رقم فاتورة صالح" {
    $prepareText = Get-ExtractedFunctionText $rendererSrc "function New-OzkReceiptSpoolJob {"
    Assert-True ($prepareText -match 'InvoiceNumber') "يجب أن يتحقق التحضير من رقم الفاتورة قبل أي عمل آخر"
    Assert-True ($prepareText -match 'throw') "غياب/بطلان الرقم يجب أن يرمي استثناءً صريحاً لا أن يمرّ بصمت"
    # الفحص يجب أن يسبق فحص الطابعة والتصيير — فشل مبكر قبل أي عمل
    $guardIdx = $prepareText.IndexOf('InvoiceNumber')
    $cimIdx = $prepareText.IndexOf('Get-CimInstance')
    Assert-True ($guardIdx -ge 0 -and $cimIdx -ge 0 -and $guardIdx -lt $cimIdx) "فحص رقم الفاتورة يجب أن يسبق فحص الطابعة"
}

Test-RenderCase "negative witness: إيصال بلا InvoiceNumber (السلوك القديم) يفشل تحت المُصيِّر الحالي" {
    $legacy = New-TestReceipt 1
    $legacy.PSObject.Properties.Remove("InvoiceNumber")
    Assert-Throws { $b = New-OzkReceiptBitmap -Receipt $legacy -LogoPath $logoPath; $b.Dispose() } "غياب رقم الفاتورة يجب أن يفشل صراحةً تحت الوضع الصارم — هذا ما كان يسمح بطباعة إيصال بلا رقم (P1-N)"
}

Write-Host "`n== P1-M: تأكيد الالتزام (committed confirmation) قبل الطباعة =="

# الدالة المستخرجة هنا حقيقية من المصدر الفعلي. نستبدل فقط ما تتصل به فعلياً
# بقاعدة البيانات (اتصال جديد + قراءة اللقطة الملتزمة) بمزيّفَين نتحكم بهما،
# تماماً كما فُعل أعلاه مع Get-InvoiceSnapshot لاختبار Wait-InvoiceReady.
. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:CommittedConfirmationLockTimeoutMilliseconds')))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Confirm-InvoiceCommitted([guid]`$InvoiceGuid, `$ExpectedSnapshot) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Get-CommittedConfirmationDeferredEvent([string]`$InvoiceGuid, [int]`$InvoiceNumber, `$Confirmation) {")))

$script:ConnectionShouldFail = $false
$script:ConnectionOpened = 0
function New-CommittedConfirmationConnection {
    $script:ConnectionOpened++
    if ($script:ConnectionShouldFail) { throw "simulated: committed confirmation connection failed" }
    $conn = [pscustomobject]@{ State = "Open" }
    $conn | Add-Member -MemberType ScriptMethod -Name Close -Value { $this.State = "Closed" } -Force
    return $conn
}

$script:CommittedReadShouldFail = $false
$script:CommittedReadException = "simulated: lock request time out period exceeded"
$script:CommittedSnapshotToReturn = $null
$script:CommittedReadCalls = 0
function Get-InvoiceSnapshot($Connection, [guid]$InvoiceGuid) {
    $script:CommittedReadCalls++
    if ($script:CommittedReadShouldFail) { throw $script:CommittedReadException }
    return $script:CommittedSnapshotToReturn
}

function Reset-CommittedConfirmationStubs {
    $script:ConnectionShouldFail = $false
    $script:ConnectionOpened = 0
    $script:CommittedReadShouldFail = $false
    $script:CommittedReadException = "simulated: lock request time out period exceeded"
    $script:CommittedSnapshotToReturn = $null
    $script:CommittedReadCalls = 0
}

Test-Case "1) قذرة مستقرة مطابقة + ملتزمة مطابقة → يُسمح بالطباعة" {
    Reset-CommittedConfirmationStubs
    $balance = New-TestBalance $true 1000 2500
    $dirty = New-SnapshotWithBalance $balance
    $script:CommittedSnapshotToReturn = New-SnapshotWithBalance $balance
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True $result.Confirmed "التطابق الكامل يجب أن يسمح بالطباعة"
    Assert-True ($result.Snapshot.Signature -eq $script:CommittedSnapshotToReturn.Signature) "يجب إعادة اللقطة الملتزمة نفسها"
}

Test-Case "2) قذرة مستقرة + ملتزمة مختلفة → لا طباعة، إعادة محاولة" {
    Reset-CommittedConfirmationStubs
    $dirty = New-SnapshotWithBalance (New-TestBalance $true 1000 2500)
    $script:CommittedSnapshotToReturn = New-SnapshotWithBalance (New-TestBalance $true 1000 3900)
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $result.Confirmed) "عدم التطابق يجب أن يمنع الطباعة"
    Assert-True ($result.Reason -eq "signature_mismatch") "السبب يجب أن يكون عدم تطابق التوقيع، وُجد: $($result.Reason)"
}

Test-Case "3) قراءة التأكيد تُصادف مهلة قفل (lock timeout) → لا طباعة، إعادة محاولة لاحقة" {
    Reset-CommittedConfirmationStubs
    $script:CommittedReadShouldFail = $true
    $dirty = New-SnapshotWithBalance (New-TestBalance $true 1000 2500)
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $result.Confirmed) "مهلة القفل ليست فشلاً دائماً"
    Assert-True ($result.Reason -eq "confirmation_read_failed") "يجب تصنيفها كتأجيل قابل لإعادة المحاولة، وُجد: $($result.Reason)"
    $deferredEvent = Get-CommittedConfirmationDeferredEvent "guid-1" 100 $result
    Assert-True ($deferredEvent.Event -eq "committed_confirmation_deferred") "يجب تسجيل حدث التأجيل الصريح"
}

Test-Case "4) خطأ SQL عابر عند فتح اتصال التأكيد → لا طباعة، إعادة محاولة لاحقة" {
    Reset-CommittedConfirmationStubs
    $script:ConnectionShouldFail = $true
    $dirty = New-SnapshotWithBalance (New-TestBalance $true 1000 2500)
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $result.Confirmed) "فشل فتح اتصال التأكيد ليس فشلاً دائماً"
    Assert-True ($result.Reason -eq "confirmation_connection_failed") "وُجد: $($result.Reason)"
    Assert-True ($script:CommittedReadCalls -eq 0) "لا قراءة يجب أن تقع إن تعذّر فتح الاتصال أصلاً"
}

Test-Case "5) اللقطة القذرة تتغيّر قبل الجاهزية → سلوك Wait-InvoiceReady كما كان بلا تغيير" {
    # Wait-InvoiceReady نفسها يجب أن تبقى استقراراً مزدوجاً بحتاً على الاتصال
    # القذر القائم، بلا أي إشارة إلى التأكيد الملتزم أو اتصال جديد بداخلها.
    $waitText = Get-ExtractedFunctionText $bridgeSrc "function Wait-InvoiceReady(`$Connection, [guid]`$InvoiceGuid) {"
    Assert-True ($waitText -notmatch 'Confirm-InvoiceCommitted') "يجب ألا يُستدعى التأكيد الملتزم من داخل فحص الاستقرار القذر"
    Assert-True ($waitText -notmatch 'New-CommittedConfirmationConnection') "يجب ألا يفتح فحص الاستقرار القذر أي اتصال جديد"
    Assert-True ($waitText -match '\$first\.Signature -eq \$second\.Signature') "الاستقرار المزدوج الأصلي يجب أن يبقى كما هو"
}

Test-Case "6) اللقطة الملتزمة تتذبذب ثم تستقر → يُطبع المحتوى الملتزم الأخير فقط" {
    Reset-CommittedConfirmationStubs
    $dirty = New-SnapshotWithBalance (New-TestBalance $true 1000 4200)
    $script:CommittedSnapshotToReturn = New-SnapshotWithBalance (New-TestBalance $true 1000 3900)
    $first = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $first.Confirmed) "المحاولة الأولى (لم تستقر الملتزمة بعد) يجب ألا تُطبع"
    $settled = New-SnapshotWithBalance (New-TestBalance $true 1000 4200)
    $script:CommittedSnapshotToReturn = $settled
    $second = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True $second.Confirmed "بعد استقرار الملتزمة يجب أن تُقبل"
    $receipt = Convert-SnapshotToReceipt $second.Snapshot
    Assert-True ($receipt.CurrentBalance -eq 4200) "القيمة المطبوعة يجب أن تكون الملتزمة المستقرة الأخيرة، وُجد: $($receipt.CurrentBalance)"
}

Test-Case "7) الرصيد المحاسبي يختلف بين القذرة والملتزمة → لا طباعة" {
    Reset-CommittedConfirmationStubs
    $dirty = New-SnapshotWithBalance (New-TestBalance $true 1000 2500)
    $script:CommittedSnapshotToReturn = New-SnapshotWithBalance (New-TestBalance $true 1750 2500)
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $result.Confirmed) "اختلاف الرصيد السابق وحده كافٍ لمنع الطباعة"
}

Test-Case "8) أسطر الفاتورة تختلف بين القذرة والملتزمة → لا طباعة" {
    Reset-CommittedConfirmationStubs
    $balance = New-TestBalance $true 1000 2500
    $dirty = New-SnapshotWithBalance $balance
    $committed = New-Snapshot -Lines @(New-TestLine -ItemGuid "M-9" -ItemName "مادة أخرى" -Qty 3 -RawPrice 750 -LineGuid "L-9" -LineNumber 1)
    $committed | Add-Member -NotePropertyName Balance -NotePropertyValue $balance -Force
    $committed | Add-Member -NotePropertyName Signature -NotePropertyValue (Get-SnapshotSignatureWithBalance $committed $balance) -Force
    $script:CommittedSnapshotToReturn = $committed
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $result.Confirmed) "اختلاف الأسطر يجب أن يمنع الطباعة"
}

Test-Case "9) رقم الفاتورة يختلف بين القذرة والملتزمة → لا طباعة" {
    Reset-CommittedConfirmationStubs
    $balance = New-TestBalance $true 1000 2500
    $dirty = New-SnapshotWithBalance $balance
    $committed = New-Snapshot -InvoiceNumber 9999
    $committed | Add-Member -NotePropertyName Balance -NotePropertyValue $balance -Force
    $committed | Add-Member -NotePropertyName Signature -NotePropertyValue (Get-SnapshotSignatureWithBalance $committed $balance) -Force
    $script:CommittedSnapshotToReturn = $committed
    $result = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $result.Confirmed) "اختلاف رقم الفاتورة يجب أن يمنع الطباعة"
}

Test-Case "10) بعد نجاح التأكيد لا تُقرأ الفاتورة ثانيةً قبل التصيير" {
    # في كلا مساري الطباعة الحقيقيين يجب أن تُبنى الفاتورة من $confirmation.Snapshot
    # لا من $ready.Snapshot، ولا يجوز أي استدعاء Get-InvoiceSnapshot إضافي بينهما.
    $manualCalls = [regex]::Matches($bridgeSrc, 'Convert-SnapshotToReceipt \$confirmation\.Snapshot')
    Assert-True ($manualCalls.Count -eq 2) "يجب أن يبني كلا مساري الطباعة الحقيقيين (اليدوي والآلي) الإيصال من لقطة التأكيد، وُجد: $($manualCalls.Count)"
    Assert-True ($bridgeSrc -notmatch 'if \(\$ConfirmPhysicalPrint\) \{[^}]*Convert-SnapshotToReceipt \$ready\.Snapshot') "المسار الآلي يجب ألا يبني الإيصال من اللقطة القذرة بعد إضافة التأكيد"
}

Test-Case "11) فشل تأكيد الالتزام لا يمسّ حالة seen على الإطلاق" {
    # الاستدعاء يجب أن يسبق أي تعديل على state.seen، وعند الفشل continue فوراً.
    $confirmIdx = $bridgeSrc.IndexOf('$confirmation = Confirm-InvoiceCommitted ([guid]$candidate.InvoiceGuid)')
    Assert-True ($confirmIdx -ge 0) "يجب أن يُستدعى التأكيد من الحلقة الآلية"
    $continueIdx = $bridgeSrc.IndexOf("continue", $confirmIdx)
    $seenAssignIdx = $bridgeSrc.IndexOf('$state.seen[$candidate.InvoiceGuid] = [ordered]@{`n                status = "print_in_flight"', $confirmIdx)
    if ($seenAssignIdx -lt 0) {
        $seenAssignIdx = $bridgeSrc.IndexOf('status = "print_in_flight"', $confirmIdx)
    }
    Assert-True ($continueIdx -ge 0 -and $continueIdx -lt $seenAssignIdx) "فشل التأكيد يجب أن يُنهي هذه الفاتورة (continue) قبل أي علامة print_in_flight"
}

Test-Case "12) دلالات P1-E/F/K القائمة لم تتغيّر" {
    Assert-True ($bridgeSrc -match 'status = "print_in_flight"') "علامة قيد الإرسال باقية"
    Assert-True ($bridgeSrc -match 'Event = "duplicate_suppressed"') "قمع التكرار باقٍ"
    Assert-True ($bridgeSrc -match 'Event = "permanent_render_failure"') "عزل الفشل الحتمي باقٍ"
    Assert-True ($bridgeSrc -match 'submitted_to_spooler:') "دلالة التسليم للطابور باقية"
    Assert-True ($bridgeSrc -match '\$second\.Header\.IsPosted') "شرط الترحيل داخل Wait-InvoiceReady باقٍ"
}

Test-Case "negative witness: بلا تأكيد الالتزام كانت اللقطة القذرة المستقرة تُعتبر كافية للطباعة" {
    # هذا بالضبط ما كانت تفعله شفرة ما قبل P1-M: قبول اللقطة القذرة فور استقرارها
    # بلا أي قراءة READ COMMITTED تالية للتحقق من الالتزام الفعلي.
    function Confirm-InvoiceCommitted-Legacy([guid]$InvoiceGuid, $ExpectedSnapshot) {
        return [pscustomobject]@{ Confirmed = $true; Snapshot = $ExpectedSnapshot; Reason = "legacy_no_confirmation" }
    }
    $dirty = New-SnapshotWithBalance (New-TestBalance $true 1000 2500)
    $legacyResult = Confirm-InvoiceCommitted-Legacy ([guid]::NewGuid()) $dirty
    Assert-True $legacyResult.Confirmed "توثيقاً للعطل: السلوك القديم يوافق دائماً بلا أي قراءة تحقق فعلية"

    Reset-CommittedConfirmationStubs
    $script:CommittedSnapshotToReturn = New-SnapshotWithBalance (New-TestBalance $true 1000 9999)
    $actual = Confirm-InvoiceCommitted ([guid]::NewGuid()) $dirty
    Assert-True (-not $actual.Confirmed) "الدالة الحالية المستخرجة من المصدر الفعلي يجب أن ترفض هذه الحالة بعينها — هذا ما كان P1-M يسدّه"
}

Write-Host "`n$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
