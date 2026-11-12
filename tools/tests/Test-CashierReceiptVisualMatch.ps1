# اختبار التطابق البصري لتصميم إيصال الكاشير 80mm قبل أي ترقية لجسر OZKUSER (Windows فقط: GDI+).
#
# المرجع: ozk-print-bridge/__golden__/OzkReceiptRenderer.live-f7806b56.psm1 (بايتات الرسّام الحي حرفياً).
# المرشّح: افتراضياً رسّام أداة إعادة الطباعة الثابت (static-bridge، يُرسل حالياً للطابعة نفسها).
# كل رسّام يعمل في عملية powershell.exe مستقلة (لا تتصادم أنواع Add-Type)، ويرسم مجموعة إيصالات وهمية
# ثابتة. المقارنة: الأبعاد، وبصمة البكسلات الخام 24bpp، وبصمة بايتات ESC/POS (ما يصل الطابعة فعلاً).
# لا طباعة إطلاقاً. PNG لكل إيصال يُحفظ في -OutDir للمراجعة البشرية.
#
#   powershell -File tools\tests\Test-CashierReceiptVisualMatch.ps1 [-Candidate <psm1>] [-OutDir <dir>]
[CmdletBinding()]
param(
    [string]$Candidate = "",
    [string]$OutDir = "",
    # للتوثيق فقط: يُظهر الفرق مع رسّام المستودع الرئيسي دون أن يُفشل الاختبار.
    [switch]$ReportMainRenderer
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bridgeDir = Join-Path $repoRoot "ozk-print-bridge"
$reference = Join-Path (Join-Path $bridgeDir "__golden__") "OzkReceiptRenderer.live-f7806b56.psm1"
$referenceSha = "f7806b562637e3c1e4b825e6dc4906c71f481a26eeffc2753f3fac81053f1aee"
if (-not $Candidate) { $Candidate = Join-Path $repoRoot "tools\cashier-reprint\static-bridge\ozk-print-bridge\OzkReceiptRenderer.psm1" }
$logo = Join-Path (Join-Path $bridgeDir "assets") "ozk-receipt-horse-logo.png"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Get-Sha([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($sha.ComputeHash([IO.File]::ReadAllBytes($Path)) | ForEach-Object { $_.ToString("x2") })) } finally { $sha.Dispose() }
}

Assert "المرجع: بايتات الرسّام الحي f7806b56 كما هي" ((Get-Sha $reference) -eq $referenceSha)
if ($env:OS -ne "Windows_NT") {
    Write-Host "SKIP الرسم والمقارنة بالبكسل (GDI+ وخط Tahoma يحتاجان Windows)"
    Write-Host ""; Write-Host "$($script:pass) passed, $($script:fail) failed"
    if ($script:fail -gt 0) { exit 1 }; exit 0
}

# ── مجموعة إيصالات وهمية ثابتة تغطي حدود التخطيط ──────────────────────────────
function New-MockReceipt([string]$Id, [object[]]$Lines, [hashtable]$Over = @{}) {
    $gross = 0.0; $qty = 0.0
    foreach ($l in $Lines) { $gross += [double]$l.Total; $qty += [double]$l.Quantity }
    $r = [ordered]@{
        Id = $Id; MerchantName = "مركز أبو زياد"; Subtitle = "لتجارة التبغ الدخان الوطني والمستورد"; CommercialRegister = "0310109105"
        Phones = "0984000662 - 0985000771"; CenterPhone = "0994092038"; Address = "دوما / ساحة الغنم"; InvoiceNumber = 2992
        Date = "2026/11/12"; Time = "12:52 PM"; CustomerName = "-"; Description = "-"; Lines = @($Lines)
        GrossTotal = $gross; Discount = 0.0; NetTotal = $gross; Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = 0.0; BalanceFound = $false
        ItemCount = @($Lines).Count; TotalQuantity = $qty; SaleDescription = "صفة البيع من تاجر جملة الجملة إلى تاجر جملة ومفرق"; CurrencyIso = "SYP"
    }
    foreach ($k in $Over.Keys) { $r[$k] = $Over[$k] }
    return $r
}
function L([string]$Name, [double]$Q, [double]$U) { return [ordered]@{ Name = $Name; Quantity = $Q; UnitPrice = $U; Total = $Q * $U } }
$set = @(
    (New-MockReceipt "inv2992-like" @((L "اوسكار سليم فضي" 3 77910), (L "اختمار سليم فضي" 3 91728), (L "غلواز كوين أحمر" 2 118188), (L "غلواز كوين أصفر" 4 118188),
        (L "كينغ دوم سليم" 2 73500), (L "ماستر سليم فضي" 1 104000), (L "ماستر سليم أزرق" 1 104000)) @{ Discount = 42.0; NetTotal = 1573000.0 }),
    (New-MockReceipt "extra-rounding" @((L "حمرا طويلة جديدة" 1 80262), (L "كينغ دوم كوين أبيض" 2 83202)) @{ NetTotal = 247566.0 + 434.0 }),
    (New-MockReceipt "large-amounts" @((L "كرتونة ماستر" 150 121500), (L "كرتونة كينغ دوم" 40 73500)) @{ Discount = 70.0; NetTotal = 21165000.0 - 70.0 }),
    (New-MockReceipt "long-names" @((L "اسم مادة طويل جداً جداً يلتف على أكثر من سطر في عمود اسم المادة على الإيصال" 2.5 66500), (L "صنف قصير" 0.5 5000))),
    (New-MockReceipt "customer-balance" @((L "ماستر قصير أزرق" 1 98784)) @{ CustomerName = "زبون اختبار باسم طويل نسبياً"; BalanceFound = $true; PreviousBalance = 1250000.0; CurrentBalance = 1348784.0; Payment = 0.0 }),
    (New-MockReceipt "thirty-lines" @(1..30 | ForEach-Object { L ("صنف رقم $_") ($_ % 4 + 1) (60000 + $_ * 1250) })),
    (New-MockReceipt "single-line" @((L "كينغ دوم سليم" 1 73500)))
)

$work = Join-Path ([IO.Path]::GetTempPath()) ("receipt-visual-" + [guid]::NewGuid().ToString("N"))
if (-not $OutDir) { $OutDir = Join-Path $work "png" }
[void](New-Item -ItemType Directory -Force -Path $work, $OutDir)
$receiptsPath = Join-Path $work "receipts.json"
[IO.File]::WriteAllText($receiptsPath, ($set | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($true)))

$helper = Join-Path $work "render.ps1"
[IO.File]::WriteAllText($helper, @'
param([string]$Renderer, [string]$Logo, [string]$Receipts, [string]$Out, [string]$Tag, [string]$Result)
$ErrorActionPreference = "Stop"
Import-Module $Renderer -Force -DisableNameChecking
function Sha([byte[]]$b) { $s = [Security.Cryptography.SHA256]::Create(); try { -join ($s.ComputeHash($b) | ForEach-Object { $_.ToString("x2") }) } finally { $s.Dispose() } }
$items = Get-Content -Raw -LiteralPath $Receipts -Encoding UTF8 | ConvertFrom-Json
$rows = foreach ($r in $items) {
    $bmp = New-OzkReceiptBitmap -Receipt $r -LogoPath $Logo
    try {
        $rect = New-Object Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
        $data = $bmp.LockBits($rect, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        try { $raw = New-Object byte[] ([math]::Abs($data.Stride) * $bmp.Height); [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length) } finally { $bmp.UnlockBits($data) }
        $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190)
        [IO.File]::WriteAllBytes((Join-Path $Out ("{0}-{1}.escpos" -f $r.Id, $Tag)), $payload)
        $bmp.Save((Join-Path $Out ("{0}-{1}.png" -f $r.Id, $Tag)), [Drawing.Imaging.ImageFormat]::Png)
        [pscustomobject]@{ Id = $r.Id; Width = $bmp.Width; Height = $bmp.Height; PixelSha = (Sha $raw); PayloadSha = (Sha $payload); PayloadBytes = $payload.Length }
    } finally { $bmp.Dispose() }
}
[IO.File]::WriteAllText($Result, (@($rows) | ConvertTo-Json -Depth 3))
'@, (New-Object Text.UTF8Encoding($true)))

# تشخيص الفرق على مستوى ما يصل الطابعة (نقطة سوداء/بيضاء): عدد النقاط المختلفة وصفوفها الأولى والأخيرة.
function Get-EscPosDiff([string]$IdA, [string]$TagA, [string]$TagB) {
    $a = [IO.File]::ReadAllBytes((Join-Path $OutDir ("{0}-{1}.escpos" -f $IdA, $TagA)))
    $b = [IO.File]::ReadAllBytes((Join-Path $OutDir ("{0}-{1}.escpos" -f $IdA, $TagB)))
    if ($a.Length -ne $b.Length) { return "lengths differ ($($a.Length) vs $($b.Length))" }
    $dots = 0; $firstRow = -1; $lastRow = -1
    for ($i = 0; $i -lt $a.Length; $i++) {
        $x = $a[$i] -bxor $b[$i]
        if ($x -ne 0) {
            while ($x -ne 0) { $dots += ($x -band 1); $x = $x -shr 1 }
            $row = [int][math]::Floor($i / 72.0)
            if ($firstRow -lt 0) { $firstRow = $row }; $lastRow = $row
        }
    }
    return "differing dots=$dots, approx rows $firstRow..$lastRow (of 72-byte rows incl. band headers)"
}

function Invoke-Render([string]$Renderer, [string]$Tag) {
    $result = Join-Path $work "$Tag.json"
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    & $ps -NoProfile -ExecutionPolicy Bypass -File $helper -Renderer $Renderer -Logo $logo -Receipts $receiptsPath -Out $OutDir -Tag $Tag -Result $result
    if ($LASTEXITCODE -ne 0) { throw "Renderer '$Tag' failed (exit $LASTEXITCODE)." }
    # PowerShell 5.1: ConvertFrom-Json يُخرج المصفوفة كعنصر واحد في الأنبوب، فـ@(... | ConvertFrom-Json)
    # يلفّها ويصير المفتاح الوحيد كل المعرّفات معاً — وتنجح المقارنة فارغةً (null = null). تُسند أولاً.
    $rows = Get-Content -Raw -LiteralPath $result | ConvertFrom-Json
    $map = @{}
    foreach ($row in $rows) { $map[[string]$row.Id] = $row }
    foreach ($r in $set) {
        $row = $map[[string]$r.Id]
        if ($null -eq $row -or [string]::IsNullOrEmpty([string]$row.PixelSha) -or [string]::IsNullOrEmpty([string]$row.PayloadSha) -or [int]$row.Height -le 0) {
            throw "Renderer '$Tag' produced no result for receipt '$($r.Id)'; refusing a vacuous comparison."
        }
    }
    return $map
}

try {
    # إحماء يُهمَل: أول رسم على جهاز جديد (ذاكرة الخطوط وGDI+ باردة) يختلف ببضع نقاط عن كل رسم بعده —
    # ثبت على Windows CI: 2–19 نقطة من نحو 800 ألف، وتطابقت كل الرسوم اللاحقة حرفياً. المقارنة تبقى
    # تطابقاً تاماً بلا هامش تسامح؛ الإحماء يزيل أثر البرودة لا أي فرق تصميم.
    [void](Invoke-Render $reference "warmup")
    $ref = Invoke-Render $reference "live"
    $refAgain = Invoke-Render $reference "live-again"
    Assert "عدم الفراغ: كل إيصال له نتيجة رسم فعلية ($($set.Count))" ($ref.Count -eq $set.Count -and $refAgain.Count -eq $set.Count)
    $unstable = @($set | Where-Object { $ref[$_.Id].PayloadSha -ne $refAgain[$_.Id].PayloadSha })
    foreach ($u in $unstable) { Write-Host ("DIAG حتمية [{0}]: {1}" -f $u.Id, (Get-EscPosDiff $u.Id "live" "live-again")) }
    Assert "الحتمية: المرجع يعطي بايتات الطابعة نفسها في تشغيلين" ($unstable.Count -eq 0)
    $cand = Invoke-Render $Candidate "candidate"
    foreach ($r in $set) {
        $a = $ref[$r.Id]; $b = $cand[$r.Id]
        Assert "تطابق [$($r.Id)]: الأبعاد $($a.Width)x$($a.Height)" ($a.Width -eq $b.Width -and $a.Height -eq $b.Height)
        Assert "تطابق [$($r.Id)]: البكسلات" ($a.PixelSha -eq $b.PixelSha)
        Assert "تطابق [$($r.Id)]: بايتات ESC/POS للطابعة" ($a.PayloadSha -eq $b.PayloadSha)
        if ($a.PayloadSha -ne $b.PayloadSha) { Write-Host ("DIAG تطابق [{0}]: {1}" -f $r.Id, (Get-EscPosDiff $r.Id "live" "candidate")) }
    }
    if ($ReportMainRenderer) {
        $main = Invoke-Render (Join-Path $bridgeDir "OzkReceiptRenderer.psm1") "repo-main"
        $diff = @($set | Where-Object { [string]$ref[$_.Id].PixelSha -ne [string]$main[$_.Id].PixelSha }).Count
        Write-Host "INFO رسّام المستودع الرئيسي يختلف عن التصميم الحي في $diff من $($set.Count) إيصالات — لا يُنشر قبل رسّام موحّد يطابق."
    }
    Write-Host "PNG للمراجعة: $OutDir"
} finally {
    if ($OutDir -notlike "$work*") { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
