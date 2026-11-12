# فواتير الكاشير الطويلة: قصّ صامت عند 2600 نقطة في الرسّام الحي، وإصلاحه دون أي تغيير بصري (Windows فقط).
#
# المرجع: ozk-print-bridge/__golden__/OzkReceiptRenderer.live-f7806b56.psm1 (الحي حرفياً).
# المرشّح: ozk-print-bridge/live-renderer/OzkReceiptRenderer.psm1 (الحي + لوح بارتفاع المحتوى + رفض صريح).
# فواتير وهمية من 10 و20 و30 و40 و60 سطراً، فيها خصم وإضافة ودفعة ورصيد سابق وحالي وزبون. لا طباعة.
#
# ما يُثبَت:
#   1) 10 و20 سطراً: المرشّح = المرجع بكسلاً بكسلاً وبايتات ESC/POS (لا تغيير بصري).
#   2) المرجع يقصّ فعلاً: ارتفاعه 2600 مهما زادت الأسطر، وتذييله مفقود.
#   3) المرشّح: الارتفاع = ارتفاع 10 أسطر + (N−10) × ارتفاع السطر بالضبط (لا سطر مفقود ولا مكرر).
#   4) المرشّح: أول 2600 صف = صفوف المرجع حرفياً (الرسم نفسه، فقط لم يُقصّ).
#   5) المرشّح: آخر 150 صفاً (صفة البيع + «شكراً لتعاملكم معنا») = نهاية فاتورة 10 أسطر حرفياً.
#   6) المرشّح: إطار «صافي الفاتورة» موجود قرب النهاية، وحِزَم ESC/POS تغطي كل الصفوف وتنتهي بالقص.
#   7) أطول من الحد الآمن ⇒ رفض صريح لا قصّ صامت.
[CmdletBinding()]
param([string]$OutDir = "")

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bridgeDir = Join-Path $repoRoot "ozk-print-bridge"
$reference = Join-Path (Join-Path $bridgeDir "__golden__") "OzkReceiptRenderer.live-f7806b56.psm1"
$candidate = Join-Path (Join-Path $bridgeDir "live-renderer") "OzkReceiptRenderer.psm1"
$logo = Join-Path (Join-Path $bridgeDir "assets") "ozk-receipt-horse-logo.png"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$candidateText = [IO.File]::ReadAllText($candidate)
$referenceText = [IO.File]::ReadAllText($reference)
Assert "المرشّح: لا لوح ثابت 2600" ($candidateText -notmatch '\$canvasHeight = 2600')
Assert "المرشّح: رفض صريح بدل القص الصامت" ($candidateText -match 'refusing to print a truncated receipt')
# الرسم نفسه: كل ما بين بداية Invoke… الرسم ونهاية التذييل مطابق حرفياً للحي.
$drawStart = '$graphics.Clear([Drawing.Color]::White)'
$drawEnd = 'شكراً لتعاملكم معنا'
$refDraw = $referenceText.Substring($referenceText.IndexOf($drawStart), $referenceText.IndexOf($drawEnd) - $referenceText.IndexOf($drawStart))
$candDraw = $candidateText.Substring($candidateText.IndexOf($drawStart), $candidateText.IndexOf($drawEnd) - $candidateText.IndexOf($drawStart))
Assert "المرشّح: كود الرسم من المسح حتى التذييل مطابق للحي حرفياً" ($refDraw -eq $candDraw)

if ($env:OS -ne "Windows_NT") {
    Write-Host "SKIP الرسم والمقارنة بالبكسل (GDI+ وخط Tahoma يحتاجان Windows)"
    Write-Host ""; Write-Host "$($script:pass) passed, $($script:fail) failed"
    if ($script:fail -gt 0) { exit 1 }; exit 0
}

function New-LongReceipt([int]$Lines) {
    $items = @(1..$Lines | ForEach-Object { [ordered]@{ Name = ("صنف رقم {0}" -f $_); Quantity = ($_ % 3 + 1); UnitPrice = (60000 + $_ * 250); Total = ($_ % 3 + 1) * (60000 + $_ * 250) } })
    $gross = 0.0; $qty = 0.0; foreach ($i in $items) { $gross += [double]$i.Total; $qty += [double]$i.Quantity }
    return [ordered]@{
        Id = "lines-$Lines"; MerchantName = "مركز أبو زياد"; Subtitle = "لتجارة التبغ الدخان الوطني والمستورد"; CommercialRegister = "0310109105"
        Phones = "0984000662 - 0985000771"; CenterPhone = "0994092038"; Address = "دوما / ساحة الغنم"; InvoiceNumber = 3000 + $Lines
        Date = "2026/11/12"; Time = "12:52 PM"; CustomerName = "زبون اختبار"; Description = "-"; Lines = $items
        GrossTotal = $gross; Discount = 500.0; NetTotal = $gross - 500.0 + 250.0; Payment = 100000.0
        PreviousBalance = 2500000.0; CurrentBalance = 2500000.0 + $gross - 500.0 + 250.0 - 100000.0; BalanceFound = $true
        ItemCount = $Lines; TotalQuantity = $qty; SaleDescription = "صفة البيع من تاجر جملة الجملة إلى تاجر جملة ومفرق"; CurrencyIso = "SYP"
    }
}
$counts = @(10, 20, 30, 40, 60)
$set = @($counts | ForEach-Object { New-LongReceipt $_ }) + @(New-LongReceipt 300)

$work = Join-Path ([IO.Path]::GetTempPath()) ("receipt-long-" + [guid]::NewGuid().ToString("N"))
if (-not $OutDir) { $OutDir = Join-Path $work "png" }
[void](New-Item -ItemType Directory -Force -Path $work, $OutDir)
$receiptsPath = Join-Path $work "receipts.json"
[IO.File]::WriteAllText($receiptsPath, ($set | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($true)))

$helper = Join-Path $work "render.ps1"
[IO.File]::WriteAllText($helper, @'
param([string]$Renderer, [string]$Logo, [string]$Receipts, [string]$Out, [string]$Tag, [string]$Result)
$ErrorActionPreference = "Stop"
Import-Module $Renderer -Force -DisableNameChecking
function Sha([byte[]]$b, [int]$Offset = 0, [int]$Count = -1) {
    if ($Count -lt 0) { $Count = $b.Length - $Offset }
    $s = [Security.Cryptography.SHA256]::Create(); try { -join ($s.ComputeHash($b, $Offset, $Count) | ForEach-Object { $_.ToString("x2") }) } finally { $s.Dispose() }
}
$items = Get-Content -Raw -LiteralPath $Receipts -Encoding UTF8 | ConvertFrom-Json
$rows = foreach ($r in $items) {
    try { $bmp = New-OzkReceiptBitmap -Receipt $r -LogoPath $Logo }
    catch { [pscustomobject]@{ Id = $r.Id; Error = [string]$_.Exception.Message }; continue }
    try {
        $rect = New-Object Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
        $data = $bmp.LockBits($rect, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $stride = [math]::Abs($data.Stride)
        try { $raw = New-Object byte[] ($stride * $bmp.Height); [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length) } finally { $bmp.UnlockBits($data) }
        $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190)
        $bmp.Save((Join-Path $Out ("{0}-{1}.png" -f $r.Id, $Tag)), [Drawing.Imaging.ImageFormat]::Png)
        $h = $bmp.Height
        $top = [math]::Min($h, 2600)
        # إطار «صافي الفاتورة»: خط أسود بعرض الإيصال (x من 20 إلى 556) ضمن آخر 900 صف.
        $netBox = $false
        for ($y = [math]::Max(0, $h - 900); $y -lt $h -and -not $netBox; $y++) {
            $dark = 0
            for ($x = 22; $x -le 554; $x += 4) { $p = $y * $stride + $x * 3; if ((([int]$raw[$p] + $raw[$p + 1] + $raw[$p + 2]) / 3) -lt 100) { $dark++ } }
            if ($dark -ge 130) { $netBox = $true }
        }
        # حِزَم GS v 0: مجموع صفوفها = ارتفاع الصورة، والقص في النهاية.
        $i = 10; $bandRows = 0; $bandsOk = $true
        while ($i + 8 -le $payload.Length -and $payload[$i] -eq 0x1D -and $payload[$i + 1] -eq 0x76) {
            $w = $payload[$i + 4] + 256 * $payload[$i + 5]; $n = $payload[$i + 6] + 256 * $payload[$i + 7]
            $bandRows += $n; $i += 8 + $w * $n
        }
        $cutOk = ($i + 4 -eq $payload.Length -and $payload[$i] -eq 0x1D -and $payload[$i + 1] -eq 0x56)
        [pscustomobject]@{
            Id = $r.Id; Error = $null; Width = $bmp.Width; Height = $h
            PixelSha = (Sha $raw); PayloadSha = (Sha $payload)
            TopSha = (Sha $raw 0 ($stride * $top)); TopRows = $top
            FooterSha = (Sha $raw ($stride * ($h - 150)) ($stride * 150))
            NetBox = $netBox; BandRows = $bandRows; CutOk = $cutOk
        }
    } finally { $bmp.Dispose() }
}
[IO.File]::WriteAllText($Result, (@($rows) | ConvertTo-Json -Depth 3))
'@, (New-Object Text.UTF8Encoding($true)))

function Invoke-Render([string]$Renderer, [string]$Tag) {
    $result = Join-Path $work "$Tag.json"
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    & $ps -NoProfile -ExecutionPolicy Bypass -File $helper -Renderer $Renderer -Logo $logo -Receipts $receiptsPath -Out $OutDir -Tag $Tag -Result $result
    if ($LASTEXITCODE -ne 0) { throw "Renderer '$Tag' failed (exit $LASTEXITCODE)." }
    # إسناد قبل التكرار: في 5.1 يُخرج ConvertFrom-Json المصفوفة عنصراً واحداً في الأنبوب.
    $rows = Get-Content -Raw -LiteralPath $result | ConvertFrom-Json
    $map = @{}
    foreach ($row in $rows) { $map[[string]$row.Id] = $row }
    foreach ($r in $set) { if ($null -eq $map[[string]$r.Id]) { throw "Renderer '$Tag' produced no result for '$($r.Id)'; refusing a vacuous comparison." } }
    return $map
}

try {
    [void](Invoke-Render $reference "warmup")
    $ref = Invoke-Render $reference "live"
    $cand = Invoke-Render $candidate "fixed"

    foreach ($n in @(10, 20)) {
        $a = $ref["lines-$n"]; $b = $cand["lines-$n"]
        Assert "[$n سطراً] بلا تغيير بصري: الأبعاد والبكسلات وبايتات الطابعة مطابقة للحي" ($a.Height -eq $b.Height -and $a.PixelSha -eq $b.PixelSha -and $a.PayloadSha -eq $b.PayloadSha)
    }
    $h10 = [int]$ref["lines-10"].Height; $h20 = [int]$ref["lines-20"].Height
    $perLine = ($h20 - $h10) / 10.0
    Assert "ارتفاع السطر ثابت ($perLine نقطة)" ($perLine -gt 0 -and $perLine -eq [math]::Floor($perLine))
    Assert "الخلل الحي مثبت: 40 و60 سطراً تُقصّ عند 2600" ([int]$ref["lines-40"].Height -eq 2600 -and [int]$ref["lines-60"].Height -eq 2600)
    Assert "الخلل الحي مثبت: تذييل الفاتورة الطويلة مفقود في الحي" ($ref["lines-60"].FooterSha -ne $ref["lines-10"].FooterSha)
    foreach ($n in $counts) {
        $b = $cand["lines-$n"]; $a = $ref["lines-$n"]
        $expected = [int]($h10 + ($n - 10) * $perLine)
        Assert "[$n سطراً] الارتفاع الكامل $expected = 10 أسطر + ($n−10)×$perLine (لا سطر مفقود ولا قصّ)" ([int]$b.Height -eq $expected -and [int]$b.Height -le 15000)
        Assert "[$n سطراً] أول $($a.TopRows) صف مطابق للحي حرفياً" ($b.TopSha -eq $a.TopSha -or ([int]$a.Height -lt 2600 -and $a.PixelSha -eq $b.PixelSha))
        Assert "[$n سطراً] التذييل (صفة البيع + شكراً لتعاملكم معنا) كامل ومطابق" ($b.FooterSha -eq $ref["lines-10"].FooterSha)
        Assert "[$n سطراً] إطار صافي الفاتورة موجود قرب النهاية" ([bool]$b.NetBox)
        Assert "[$n سطراً] حِزَم ESC/POS تغطي كل الصفوف وتنتهي بالقص" ([int]$b.BandRows -eq [int]$b.Height -and [bool]$b.CutOk)
    }
    Assert "300 سطر: الحي يقصّ بصمت عند 2600" ([int]$ref["lines-300"].Height -eq 2600 -and -not $ref["lines-300"].Error)
    Assert "300 سطر: المرشّح يرفض صراحةً بدل القص" ([string]$cand["lines-300"].Error -match "refusing to print a truncated receipt")
    Write-Host "PNG للمراجعة: $OutDir"
} finally {
    if ($OutDir -notlike "$work*") { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
