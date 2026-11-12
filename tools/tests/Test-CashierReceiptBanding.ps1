# تقسيم صورة إيصال الكاشير إلى أوامر GS v 0 أصغر — تحت Windows PowerShell 5.1 وPowerShell 7، بلا طباعة.
#
# الدالة ConvertTo-OzkBandedRaster تُستخرج بمحلّل PowerShell من ملفات الرسّام الثلاثة (الحي المُصلَح،
# ونسخة أداة إعادة الطباعة، ورسّام المستودع) ويُتحقق أنها متطابقة فيها. ثم:
#   1) رؤوس الأوامر وطول كل حمولة: m=0، xL/xH = 72، yL/yH = min(الحِزمة، الباقي)، k = 72 × الصفوف.
#   2) صفوف البيانات بعد التقسيم = قبله بالبايت، والتهيئة والقص كما هما، ولا بايت زائد (لا أصفار ولا مزامنة).
#   3) 512 ⇒ نفس الحمولة الحالية بالبايت (السلوك القائم بلا تغيير).
#   4) نموذج طابعة ESC/POS (الأوامر الموثقة الموجودة في الحمولة فقط) لقياس أثر فقد بايتات أو انقطاع منتصف
#      حِزمة: كم بايتاً يُقرأ نصاً عشوائياً، ومتى تعود المزامنة. حدود النموذج مكتوبة أسفله.
#   5) على Windows: إيصالات حقيقية من الرسّام المُصلَح — الصفوف بعد التقسيم = صفوف 512.
# كل مقارنة تتحقق أن ما يُقارَن غير فارغ.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$renderers = @(
    (Join-Path $repoRoot "ozk-print-bridge/live-renderer/OzkReceiptRenderer.psm1"),
    (Join-Path $repoRoot "tools/cashier-reprint/static-bridge/ozk-print-bridge/OzkReceiptRenderer.psm1"),
    (Join-Path $repoRoot "ozk-print-bridge/OzkReceiptRenderer.psm1")
)

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }
function Same([byte[]]$A, [byte[]]$B) {
    if ($null -eq $A -or $null -eq $B -or $A.Length -ne $B.Length -or $A.Length -eq 0) { return $false }
    for ($i = 0; $i -lt $A.Length; $i++) { if ($A[$i] -ne $B[$i]) { return $false } }
    return $true
}

# ── الدالة نفسها في الملفات الثلاثة ─────────────────────────────────────────
$texts = @()
foreach ($path in $renderers) {
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq "ConvertTo-OzkBandedRaster" }, $true) | Select-Object -First 1
    if ($null -eq $fn) { throw "ConvertTo-OzkBandedRaster missing in $path" }
    $texts += ($fn.Extent.Text -replace "`r`n", "`n")
    $source = [IO.File]::ReadAllText($path) -replace "`r`n", "`n"
    $leaf = Split-Path -Leaf (Split-Path -Parent $path)
    Assert "[$leaf] الحِزمة الافتراضية 128 صفاً" ($source -match '(?m)^\$script:ReceiptBandRows = 128\s*$')
    Assert "[$leaf] مسار الإرسال يمر بالتقسيم" ($source -match 'ConvertTo-OzkBandedRaster \(\[OzkRawThermalPrinter\]::ToEscPosRaster\(\$bitmap, 190\)\) \$script:ReceiptBandRows')
    Assert "[$leaf] لا ToEscPosRaster يُرسل بلا تقسيم" (([regex]::Matches($source, 'ToEscPosRaster\(\$bitmap')).Count -eq 1)
}
Assert "الدالة متطابقة حرفياً في الملفات الثلاثة" (@($texts | Select-Object -Unique).Count -eq 1)
. ([scriptblock]::Create($texts[0]))

# ── مُرمِّز مرجعي بحِزَم 512 (نفس صيغة ToEscPosRaster) وفاكّ ──────────────────
$W = 72
function New-Raster([int]$Rows, [int]$Seed) {
    $rnd = New-Object Random $Seed
    $raster = New-Object byte[] ($Rows * $W)
    for ($i = 0; $i -lt $raster.Length; $i++) { if ($rnd.Next(100) -lt 22) { $raster[$i] = [byte]$rnd.Next(1, 256) } }
    return ,$raster
}
function New-Payload512([byte[]]$Raster, [int]$Band = 512) {
    $rows = $Raster.Length / $W
    $ms = New-Object IO.MemoryStream
    $ms.Write([byte[]](0x1B, 0x40, 0x1D, 0x4C, 0x00, 0x00, 0x1D, 0x57, 0x40, 0x02), 0, 10)
    for ($top = 0; $top -lt $rows; $top += $Band) {
        $n = [math]::Min($Band, $rows - $top)
        $ms.Write([byte[]](0x1D, 0x76, 0x30, 0x00, $W, 0, ($n -band 0xFF), ($n -shr 8)), 0, 8)
        $ms.Write($Raster, $top * $W, $n * $W)
    }
    $ms.Write([byte[]](0x1D, 0x56, 0x42, 0x00), 0, 4)
    return ,$ms.ToArray()
}
function Read-Bands([byte[]]$P) {
    $bands = New-Object System.Collections.Generic.List[object]
    $raster = New-Object IO.MemoryStream
    $i = 10
    while ($i + 4 -lt $P.Length -and $P[$i] -eq 0x1D -and $P[$i + 1] -eq 0x76) {
        $w = $P[$i + 4] + 256 * $P[$i + 5]; $h = $P[$i + 6] + 256 * $P[$i + 7]
        $bands.Add([pscustomobject]@{ Offset = $i; M = $P[$i + 3]; Mode = $P[$i + 2]; Width = $w; Rows = $h; DataBytes = [math]::Min($w * $h, $P.Length - $i - 8) })
        $raster.Write($P, $i + 8, $w * $h)
        $i += 8 + $w * $h
    }
    return [pscustomobject]@{ Bands = $bands.ToArray(); Raster = $raster.ToArray(); End = $i }
}

# ── 1–3) البنية والبايتات ────────────────────────────────────────────────────
$heights = @(1, 63, 64, 65, 127, 128, 129, 511, 512, 513, 1024, 1390, 2600, 4439)
foreach ($h in $heights) {
    $raster = New-Raster $h (1000 + $h)
    $p512 = New-Payload512 $raster
    Assert "[$h صفاً] 512 ⇒ الحمولة الحالية بالبايت" (Same (ConvertTo-OzkBandedRaster $p512 512) $p512)
    foreach ($band in @(64, 128, 256)) {
        $out = ConvertTo-OzkBandedRaster $p512 $band
        $read = Read-Bands $out
        $bands = @($read.Bands)
        $expectedBands = [int][math]::Ceiling($h / [double]$band)
        $headersOk = $true
        for ($b = 0; $b -lt $bands.Count; $b++) {
            $want = [math]::Min($band, $h - $b * $band)
            if ($bands[$b].Mode -ne 0x30 -or $bands[$b].M -ne 0 -or $bands[$b].Width -ne $W -or $bands[$b].Rows -ne $want -or $bands[$b].DataBytes -ne $W * $want) { $headersOk = $false }
        }
        Assert "[$h صفاً/$band] $expectedBands أمراً GS v 0 برؤوس صحيحة وk = 72×الصفوف" ($bands.Count -eq $expectedBands -and $headersOk)
        Assert "[$h صفاً/$band] صفوف البيانات = الأصل بالبايت ($($raster.Length) بايتاً)" (Same $read.Raster $raster)
        $prefixOk = Same ([byte[]]$out[0..9]) ([byte[]]$p512[0..9])
        $suffixOk = Same ([byte[]]$out[($out.Length - 4)..($out.Length - 1)]) ([byte[]](0x1D, 0x56, 0x42, 0x00))
        Assert "[$h صفاً/$band] نفس التهيئة ونفس القص، ولا بايت زائد" ($prefixOk -and $suffixOk -and $read.End -eq $out.Length - 4 -and $out.Length -eq (10 + 8 * $expectedBands + $raster.Length + 4))
    }
}
$big = New-Payload512 (New-Raster 2 7)
Assert "رفض: حمولة مبتورة" (Throws { ConvertTo-OzkBandedRaster ([byte[]]$big[0..($big.Length - 30)]) 128 })
Assert "رفض: تهيئة غير متوقعة" (Throws { $x = [byte[]]$big.Clone(); $x[1] = 0x41; ConvertTo-OzkBandedRaster $x 128 })
Assert "رفض: بلا أمر قص في النهاية" (Throws { ConvertTo-OzkBandedRaster ([byte[]]($big[0..($big.Length - 5)] + [byte[]](0x0A, 0x0A, 0x0A, 0x0A))) 128 })
Assert "رفض: عرض مختلف بين الحِزَم" (Throws { $x = [byte[]](New-Payload512 (New-Raster 600 3)); $x[10 + 8 + 512 * 72 + 4] = 71; ConvertTo-OzkBandedRaster $x 128 })
Assert "رفض: بايتات بين الحِزَم" (Throws { $r = New-Raster 3 9; $p = [byte[]](New-Payload512 $r 1); $q = [byte[]]($p[0..(10 + 8 + 72 - 1)] + [byte[]](0x00) + $p[(10 + 8 + 72)..($p.Length - 1)]); ConvertTo-OzkBandedRaster $q 128 })
Assert "رفض: حجم حِزمة خارج المدى" ((Throws { ConvertTo-OzkBandedRaster $big 0 }) -and (Throws { ConvertTo-OzkBandedRaster $big 5000 }))

# ── 4) نموذج طابعة ESC/POS لفقد البايتات والانقطاع ───────────────────────────
# الأوامر المعروفة فقط (موجودة فعلاً في الحمولة): ESC @، GS L، GS W، GS v 0، GS V 66 n. أي بايت آخر عند
# حدّ أمر: ≥ 0x20 حرف مطبوع (عشوائي)، 0x0A سطر ورق، ESC/GS مجهول = بايتان، وغير ذلك يُهمَل.
# حدود النموذج: لا يعرف ما تفعله برامج الطابعة الفعلية بأوامر مجهولة بطول آخر، ولا يحاكي امتلاء المخزن
# نفسه؛ يقيس فقط ما يُقرأ خطأً بعد فقد بايتات أو قطع، ومتى تعود المزامنة عند رأس أمر صالح.
function Invoke-PrinterModel([byte[]]$S) {
    $rows = New-Object System.Collections.Generic.List[byte[]]
    $garbage = 0; $feeds = 0; $cuts = 0; $pending = 0; $i = 0; $n = $S.Length
    while ($i -lt $n) {
        $b = $S[$i]
        if ($b -eq 0x1B) { $i += 2; continue }
        if ($b -eq 0x1D -and $i + 1 -lt $n) {
            $c = $S[$i + 1]
            if ($c -eq 0x4C -or $c -eq 0x57) { $i += 4; continue }
            if ($c -eq 0x56) { $cuts++; $i += 4; continue }
            if ($c -eq 0x76 -and $i + 7 -lt $n -and $S[$i + 2] -eq 0x30) {
                $w = $S[$i + 4] + 256 * $S[$i + 5]; $h = $S[$i + 6] + 256 * $S[$i + 7]; $k = $w * $h
                $avail = [math]::Min($k, $n - ($i + 8))
                if ($w -eq 72) {
                    for ($r = 0; ($r + 1) * 72 -le $avail; $r++) { $row = New-Object byte[] 72; [Buffer]::BlockCopy($S, $i + 8 + $r * 72, $row, 0, 72); $rows.Add($row) }
                } else { $garbage += $avail }
                if ($avail -lt $k) { $pending = $k - $avail }
                $i += 8 + $k; continue
            }
            $i += 2; continue
        }
        if ($b -eq 0x0A) { $feeds++ } elseif ($b -ge 0x20) { $garbage++ }
        $i++
    }
    return [pscustomobject]@{ Rows = $rows; Garbage = $garbage; Feeds = $feeds; Cuts = $cuts; Pending = $pending }
}
function Get-TailMatch($Rows, [byte[]]$Raster) {
    $total = $Raster.Length / 72; $m = 0
    for ($t = 1; $t -le [math]::Min($Rows.Count, $total); $t++) {
        $a = $Rows[$Rows.Count - $t]; $off = ($total - $t) * 72; $eq = $true
        for ($x = 0; $x -lt 72; $x++) { if ($a[$x] -ne $Raster[$off + $x]) { $eq = $false; break } }
        if (-not $eq) { break }; $m++
    }
    return $m
}

$rasterA = New-Raster 2600 42
$p512A = New-Payload512 $rasterA
$clean = Invoke-PrinterModel (ConvertTo-OzkBandedRaster $p512A 128)
Assert "النموذج: حمولة سليمة ⇒ 2600 صف مطابق، صفر عشوائي، قص واحد" ($clean.Rows.Count -eq 2600 -and (Get-TailMatch $clean.Rows $rasterA) -eq 2600 -and $clean.Garbage -eq 0 -and $clean.Feeds -eq 0 -and $clean.Cuts -eq 1)

$results = @{}
foreach ($band in @(512, 256, 128, 64)) {
    $p = ConvertTo-OzkBandedRaster $p512A $band
    $bandBytes = 8 + $band * 72
    foreach ($drop in @(1, 100, 4096)) {
        # فقد بايتات في منتصف الحِزمة الثانية — كما حدث فعلياً قرب الصف 1024 بحِزَم 512.
        $at = 10 + $bandBytes + 8 + [int]($band * 72 / 2)
        $damaged = [byte[]]($p[0..($at - 1)] + $p[($at + $drop)..($p.Length - 1)])
        $m = Invoke-PrinterModel $damaged
        $tail = Get-TailMatch $m.Rows $rasterA
        $results["$band/$drop"] = [pscustomobject]@{ Garbage = $m.Garbage + $m.Feeds; Tail = $tail; Cut = $m.Cuts }
        Write-Host ("SIM حِزمة {0} صفاً، فقد {1} بايتاً: نص عشوائي {2} بايتاً، أسطر ورق {3}، آخر {4} صفاً سليمة من 2600، قص={5}" -f $band, $drop, $m.Garbage, $m.Feeds, $tail, $m.Cuts)
    }
}
foreach ($drop in @(1, 100, 4096)) {
    Assert "النموذج/فقد ${drop}: الحِزَم الأصغر تقلّل النص العشوائي (128 < 512)" ($results["128/$drop"].Garbage -lt $results["512/$drop"].Garbage)
    Assert "النموذج/فقد ${drop}: بحِزَم 128 تعود المزامنة ويُطبع أغلب الذيل سليماً (≥ 2600 − 4×128)" ($results["128/$drop"].Tail -ge (2600 - 4 * 128))
}

# انقطاع منتصف حِزمة ثم مهمة الإيصال التالية: الطابعة تنتظر باقي البيانات فتبتلع بداية المهمة التالية.
$rasterB = New-Raster 1390 77
foreach ($band in @(512, 128, 64)) {
    $first = ConvertTo-OzkBandedRaster $p512A $band
    $second = ConvertTo-OzkBandedRaster (New-Payload512 $rasterB) $band
    $cutAt = 10 + (8 + $band * 72) + 8 + 1000
    $m = Invoke-PrinterModel ([byte[]]($first[0..($cutAt - 1)] + $second))
    $tail = Get-TailMatch $m.Rows $rasterB
    Write-Host ("SIM انقطاع عند {0} بحِزَم {1}: الإيصال التالي سليم في آخر {2} من 1390 صفاً، نص عشوائي {3}" -f $cutAt, $band, $tail, $m.Garbage)
    if ($band -eq 128) {
        Assert "النموذج/انقطاع: بحِزَم 128 يعود الإيصال التالي متزامناً قبل نهايته (≥ 1390 − 3×128 صفاً سليمة)" ($tail -ge (1390 - 3 * 128))
    }
}
Assert "النموذج: حجم أمر الحِزمة الافتراضية (8 + 128×72 = 9,224 بايتاً) أقل من سُبع مخزن 64 KB" ((8 + 128 * 72) * 7 -lt 65536)

# ── 5) إيصالات حقيقية من الرسّام المُصلَح (Windows) ────────────────────────────
if ($env:OS -eq "Windows_NT") {
    $module = Import-Module (Join-Path $repoRoot "ozk-print-bridge/live-renderer/OzkReceiptRenderer.psm1") -Force -DisableNameChecking -PassThru
    $logo = Join-Path $repoRoot "ozk-print-bridge/assets/ozk-receipt-horse-logo.png"
    foreach ($lines in @(7, 25, 60)) {
        $items = @(1..$lines | ForEach-Object { [pscustomobject]@{ Name = "صنف رقم $_"; Quantity = 2; UnitPrice = 77910; Total = 155820 } })
        $receipt = [pscustomobject]@{ MerchantName = "مركز أبو زياد"; Subtitle = "لتجارة التبغ"; CommercialRegister = "0310109105"; Phones = "0984000662"; CenterPhone = "0994092038"
            Address = "دوما"; InvoiceNumber = 2999; Date = "2026/11/12"; Time = "4:09 PM"; CustomerName = "-"; Description = "-"; Lines = $items; GrossTotal = 155820.0 * $lines
            Discount = 42.0; NetTotal = 155820.0 * $lines - 42; Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = 0.0; BalanceFound = $false; ItemCount = $lines
            TotalQuantity = 2.0 * $lines; SaleDescription = "صفة البيع"; CurrencyIso = "SYP" }
        $bmp = New-OzkReceiptBitmap -Receipt $receipt -LogoPath $logo
        try { $p512 = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190); $h = $bmp.Height } finally { $bmp.Dispose() }
        $banded = & $module { param($p, $b) ConvertTo-OzkBandedRaster $p $b } $p512 128
        $a = Read-Bands $p512; $b2 = Read-Bands $banded
        Assert "[$lines سطراً حقيقياً، $h صفاً] نفس صفوف الطابعة بعد التقسيم ($($a.Raster.Length) بايتاً)" ((Same $a.Raster $b2.Raster) -and $a.Raster.Length -eq $h * 72)
        Assert "[$lines سطراً حقيقياً] كل أمر ≤ 128 صفاً وعدد الأوامر $([math]::Ceiling($h / 128.0))" (@($b2.Bands | Where-Object { $_.Rows -gt 128 }).Count -eq 0 -and @($b2.Bands).Count -eq [math]::Ceiling($h / 128.0))
    }
} else {
    Write-Host "SKIP إيصالات حقيقية من الرسّام (GDI+ يحتاج Windows)"
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
