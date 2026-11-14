# صف الحماية في مسار الطباعة عبر تعريف Xprinter — Windows PowerShell 5.1 وPowerShell 7، بلا طباعة.
#
# السبب (من التقاطات حقيقية في tools/tests/fixtures/xprinter-driver-capture): التعريف يحذف الصفوف البيضاء
# أعلى الصفحة ومعها أول صف فيه حبر (4 نقاط من رأس الشعار). يثبت هذا الاختبار:
#   1) النموذج يعيد إنتاج صفوف ملفَي التعريف الحقيقيين من مصدرهما بالبايت (ليس افتراضاً).
#   2) المقارِن يرفض الالتقاط الحقيقي بلا حماية، ويحدد النقاط الأربع المفقودة وصفّها.
#   3) المقارِن لا ينجح وهمياً: نقطة مفقودة أو زائدة، صف مفقود أو مكرر، إزاحة أفقية، تحجيم العرض،
#      قص الأسفل، مصدر فارغ أو مخرجات فارغة ⇒ فشل.
#   4) على Windows (دوال الإنتاج نفسها): صف أبيض لا يكفي حسب النموذج (يبقى الفقد)، وصف الحبر يجعل
#      المخرجات = المصدر نقطةً نقطةً لإيصالات 7 و45 و60 سطراً وللالتقاطين الحقيقيين، دون تغيير ارتفاع
#      الحبر؛ وصف الحماية لا يمسّ صفوف الصورة، وStretchDIBits 1:1 لا يغيّر بتاً بعد إضافته.
# النموذج يتنبأ ولا يثبت: الإثبات الوحيد هو الالتقاط إلى ملف على الجهاز (Test-CashierReprintDriverCapture.ps1).

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path (Join-Path $PSScriptRoot "lib") "OzkDriverCapture.psm1") -Force -DisableNameChecking
$fixtures = Join-Path (Join-Path $PSScriptRoot "fixtures") "xprinter-driver-capture"
$renderer = Join-Path (Join-Path (Join-Path (Join-Path (Join-Path $repoRoot "tools") "cashier-reprint") "static-bridge") "ozk-print-bridge") "OzkReceiptRenderer.psm1"
$logo = Join-Path (Join-Path (Join-Path $repoRoot "ozk-print-bridge") "assets") "ozk-receipt-horse-logo.png"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Throws([scriptblock]$Block) { try { & $Block; return $false } catch { return $true } }
function Same-Rows($A, $B) {
    if ($null -eq $A -or $null -eq $B -or $A.Count -ne $B.Count -or $A.Count -eq 0) { return $false }
    for ($i = 0; $i -lt $A.Count; $i++) { if ([Convert]::ToBase64String($A[$i]) -ne [Convert]::ToBase64String($B[$i])) { return $false } }
    return $true
}
function Copy-Rows($Rows) { $l = New-Object System.Collections.Generic.List[byte[]]; foreach ($r in $Rows) { $l.Add([byte[]]$r.Clone()) }; return ,$l }
function Trim-Blank($Rows) { $span = Get-OzkInkSpan $Rows; $l = New-Object System.Collections.Generic.List[byte[]]; for ($y = $span[0]; $y -le $span[1]; $y++) { $l.Add($Rows[$y]) }; return ,$l }

# ── 1 و2) الالتقاطان الحقيقيان ────────────────────────────────────────────────
$cases = @()
foreach ($name in "printdocument-7", "stretchdibits-7") {
    $src = Split-OzkRasterRows ([IO.File]::ReadAllBytes((Join-Path $fixtures "$name-source.bin")))
    $prn = Read-OzkDriverPrn ([IO.File]::ReadAllBytes((Join-Path $fixtures "$name-driver.prn")))
    $cases += [pscustomobject]@{ Name = $name; Source = $src; Prn = $prn }
    $span = Get-OzkInkSpan $src
    Assert "[$name] المصدر غير فارغ ($($src.Count) صفاً، أول حبر $($span[0]) بـ$(Get-OzkRowInk $src[$span[0]]) نقاط)" ($src.Count -gt 1000 -and $span[0] -ge 0)
    Assert "[$name] ملف التعريف: صور 72 بايتاً، $($prn.Rows.Count) صفاً" ($prn.Width -eq 72 -and $prn.Rows.Count -gt 1000)
    Assert "[$name] النموذج (حذف الأبيض العلوي + أول صف حبر) = صفوف التعريف الحقيقية بالبايت" (Same-Rows (Invoke-OzkXprinterDriverModel $src) $prn.Rows)
    $cmp = Compare-OzkDriverOutput $src $prn.Rows
    Assert "[$name] المقارِن يرفض الالتقاط الحقيقي بلا حماية ($($cmp.Reason))" (-not $cmp.Pass -and $cmp.MissingDots -gt 0)
    Assert "[$name] تشخيص: أفضل محاذاة تفقد 4 نقاط بالضبط، أولها صف أول حبر ($($cmp.BestFirstMissingRow))، بلا زائد" ($cmp.BestMissingDots -eq 4 -and $cmp.BestExtraDots -eq 0 -and $cmp.BestFirstMissingRow -eq $span[0])
}

# ── 3) لا نجاح وهمي ────────────────────────────────────────────────────────────
$src = $cases[1].Source
$ideal = Trim-Blank $src
$ok = Compare-OzkDriverOutput $src $ideal
Assert "مقارِن: مخرجات مثالية (المصدر بلا أبيض حوله) ⇒ نجاح، 0 مفقود 0 زائد ($($ok.SourceInk) نقطة)" ($ok.Pass -and $ok.MissingDots -eq 0 -and $ok.ExtraDots -eq 0 -and $ok.SourceInk -gt 10000)
$mid = [int]($ideal.Count / 2); while ((Get-OzkRowInk $ideal[$mid]) -eq 0) { $mid++ }
$col = 0; while ($ideal[$mid][$col] -eq 0) { $col++ }
$bit = 0x80; while (($ideal[$mid][$col] -band $bit) -eq 0) { $bit = $bit -shr 1 }
$lose = Copy-Rows $ideal; $lose[$mid][$col] = [byte]($lose[$mid][$col] -band (-bnot $bit) -band 0xFF)
$c = Compare-OzkDriverOutput $src $lose
Assert "مقارِن: نقطة واحدة مفقودة وسط الإيصال ⇒ فشل (مفقود 1)" (-not $c.Pass -and $c.MissingDots -eq 1)
$add = Copy-Rows $ideal; $add[$mid][71] = [byte]($add[$mid][71] -bor 0x01)
if ($ideal[$mid][71] -band 0x01) { $add[$mid][70] = [byte]($add[$mid][70] -bor 0x01) }
$c = Compare-OzkDriverOutput $src $add
Assert "مقارِن: نقطة زائدة ⇒ فشل (زائد 1)" (-not $c.Pass -and $c.ExtraDots -eq 1 -and $c.MissingDots -eq 0)
$cut = Copy-Rows $ideal; $cut.RemoveAt($cut.Count - 1)
Assert "مقارِن: قص آخر صف حبر (التذييل) ⇒ فشل" (-not (Compare-OzkDriverOutput $src $cut).Pass)
$dup = Copy-Rows $ideal; $dup.Insert($mid, [byte[]]$ideal[$mid].Clone())
Assert "مقارِن: صف مكرر (تحجيم رأسي) ⇒ فشل" (-not (Compare-OzkDriverOutput $src $dup).Pass)
$gap = Copy-Rows $ideal; $gap.RemoveAt($mid)
Assert "مقارِن: صف داخلي مفقود ⇒ فشل" (-not (Compare-OzkDriverOutput $src $gap).Pass)
$shift = New-Object System.Collections.Generic.List[byte[]]
foreach ($r in $ideal) { $n = New-Object byte[] 72; $carry = 0; for ($x = 0; $x -lt 72; $x++) { $n[$x] = [byte]((($r[$x] -shr 1) -bor $carry) -band 0xFF); $carry = ($r[$x] -band 1) * 0x80 }; $shift.Add($n) }
Assert "مقارِن: إزاحة أفقية نقطة واحدة ⇒ فشل (لا بحث أفقي)" (-not (Compare-OzkDriverOutput $src $shift).Pass)
$narrow = New-Object System.Collections.Generic.List[byte[]]; foreach ($r in $ideal) { $n = New-Object byte[] 71; [Buffer]::BlockCopy($r, 0, $n, 0, 71); $narrow.Add($n) }
$c = Compare-OzkDriverOutput $src $narrow
Assert "مقارِن: عرض 71 بايتاً (تحجيم أفقي) ⇒ فشل ($($c.Reason))" (-not $c.Pass -and $c.Reason -match "scaling")
$top = Copy-Rows $ideal; $top.RemoveAt(0)
Assert "مقارِن: أول صف حبر مفقود (العطل نفسه) ⇒ فشل رغم أن الباقي مطابق" (-not (Compare-OzkDriverOutput $src $top).Pass)
$blankSrc = New-Object System.Collections.Generic.List[byte[]]; 1..10 | ForEach-Object { $blankSrc.Add((New-Object byte[] 72)) }
Assert "مقارِن: مصدر بلا حبر ⇒ فشل (لا مقارنة فارغة)" (-not (Compare-OzkDriverOutput $blankSrc $blankSrc).Pass)
Assert "مقارِن: مخرجات بلا حبر ⇒ فشل" (-not (Compare-OzkDriverOutput $src $blankSrc).Pass)
$extraRow = Copy-Rows $ideal; $mark = New-Object byte[] 72; $mark[0] = 0xFF; $extraRow.Insert(0, $mark); $extraRow.Insert(1, (New-Object byte[] 72))
Assert "مقارِن: صف الحماية مطبوعاً فوق الصورة ⇒ فشل (حبر زائد)" (-not (Compare-OzkDriverOutput $src $extraRow).Pass)

# ── 4) دوال الإنتاج (Windows) ──────────────────────────────────────────────────
if ($env:OS -ne "Windows_NT") {
    Write-Host "SKIP صف الحماية بدوال الإنتاج (Add-Type وGDI على Windows فقط)"
} else {
    $module = Import-Module $renderer -Force -DisableNameChecking -PassThru
    $T = [OzkDriverReceiptPrinter]
    function Join-Rows($Rows) { $ms = New-Object IO.MemoryStream; foreach ($r in $Rows) { $ms.Write($r, 0, $r.Length) }; return ,$ms.ToArray() }
    function Guarded($Rows, [int]$Kind) { $flat = Join-Rows $Rows; return (Split-OzkRasterRows ($T::WithGuardRow($flat, 72, $Rows.Count, $Kind))) }
    Assert "الإنتاج يستعمل صف الحبر: Print يمرّر GuardInk" ([IO.File]::ReadAllText($renderer) -match 'return PrintWithGuard\(printerName, raster, bytesPerRow, rows, paperName, expectedDpi, documentName, GuardInk\);')
    $flat = Join-Rows $src
    $plain = $T::WithGuardRow($flat, 72, $src.Count, $T::GuardNone)
    Assert "WithGuardRow(None) ⇒ الصفوف نفسها بلا صف إضافي" ($plain.Length -eq $flat.Length -and [Convert]::ToBase64String($plain) -eq [Convert]::ToBase64String($flat))
    $w = Split-OzkRasterRows ($T::WithGuardRow($flat, 72, $src.Count, $T::GuardWhite))
    $k = Split-OzkRasterRows ($T::WithGuardRow($flat, 72, $src.Count, $T::GuardInk))
    $restW = New-Object System.Collections.Generic.List[byte[]]; for ($i = 1; $i -lt $w.Count; $i++) { $restW.Add($w[$i]) }
    $restK = New-Object System.Collections.Generic.List[byte[]]; for ($i = 1; $i -lt $k.Count; $i++) { $restK.Add($k[$i]) }
    Assert "صف أبيض: صف واحد فارغ ثم الصورة بلا أي تغيير" ($w.Count -eq $src.Count + 1 -and (Get-OzkRowInk $w[0]) -eq 0 -and (Same-Rows $restW $src))
    Assert "صف حبر: 8 نقاط في أقصى اليسار فقط ثم الصورة بلا أي تغيير" ($k.Count -eq $src.Count + 1 -and $k[0][0] -eq 0xFF -and (Get-OzkRowInk $k[0]) -eq 8 -and (Same-Rows $restK $src))
    Assert "نوع حماية مجهول ⇒ رفض" (Throws { $T::WithGuardRow($flat, 72, $src.Count, 7) })
    $gdi = $T::RenderThroughGdi(($T::WithGuardRow($flat, 72, $src.Count, $T::GuardInk)), 72, $src.Count + 1)
    Assert "StretchDIBits 1:1 على الصورة مع صف الحماية لا يغيّر بتاً" ([Convert]::ToBase64String($gdi) -eq [Convert]::ToBase64String((Join-Rows $k)))
    $span = Get-OzkInkSpan $src
    $ext = $T::InkExtent(($T::WithGuardRow($flat, 72, $src.Count, $T::GuardInk)), 72, $src.Count + 1)
    Assert "فحص الصفحة يحسب صف الحماية: ارتفاع الحبر = آخر صف + 2" ($ext[1] -eq $span[1] + 2)

    function Check-Guards([string]$Name, $Rows) {
        $none = Compare-OzkDriverOutput $Rows (Invoke-OzkXprinterDriverModel $Rows)
        $white = Compare-OzkDriverOutput $Rows (Invoke-OzkXprinterDriverModel (Guarded $Rows $T::GuardWhite))
        $ink = Compare-OzkDriverOutput $Rows (Invoke-OzkXprinterDriverModel (Guarded $Rows $T::GuardInk))
        Assert "[$Name] بلا حماية ⇒ النموذج يفقد أول صف حبر ($($none.BestMissingDots) نقاط)" (-not $none.Pass -and $none.BestMissingDots -gt 0)
        Assert "[$Name] صف أبيض ⇒ الفقد نفسه حسب النموذج (الفرضية الثانية لا تكفي)" (-not $white.Pass -and $white.BestMissingDots -eq $none.BestMissingDots)
        Assert "[$Name] صف حبر ⇒ كل نقاط المصدر بلا زائد، والارتفاع نفسه ($($ink.Reason))" ($ink.Pass -and $ink.MissingDots -eq 0 -and $ink.ExtraDots -eq 0 -and $ink.SourceInk -eq $ink.DriverInk -and $ink.SourceInk -gt 0)
    }
    foreach ($case in $cases) { Check-Guards $case.Name $case.Source }
    function New-Mock([int]$Lines) {
        $items = @(1..$Lines | ForEach-Object { [ordered]@{ Name = ("صنف اختبار {0}" -f $_); Quantity = ($_ % 3 + 1); UnitPrice = (10000 + $_ * 100); Total = ($_ % 3 + 1) * (10000 + $_ * 100) } })
        $gross = 0.0; $qty = 0.0; foreach ($i in $items) { $gross += [double]$i.Total; $qty += [double]$i.Quantity }
        return [pscustomobject][ordered]@{
            Id = "syn-$Lines"; MerchantName = "مركز اختبار"; Subtitle = "اختبار"; CommercialRegister = "0000000000"; Phones = "0900000000"; CenterPhone = "0900000000"
            Address = "عنوان اختبار"; InvoiceNumber = 9000 + $Lines; Date = "2026/11/12"; Time = "12:00 PM"; CustomerName = "زبون اختبار"; Description = "-"; Lines = $items
            GrossTotal = $gross; Discount = 0.0; NetTotal = $gross; Payment = 0.0; PreviousBalance = 0.0; CurrentBalance = $gross; BalanceFound = $true
            ItemCount = $Lines; TotalQuantity = $qty; SaleDescription = "اختبار"; CurrencyIso = "SYP"
        }
    }
    $warm = New-OzkReceiptBitmap -Receipt (New-Mock 3) -LogoPath $logo; $warm.Dispose()
    foreach ($n in 7, 45, 60) {
        $bmp = New-OzkReceiptBitmap -Receipt (New-Mock $n) -LogoPath $logo
        try { $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190) } finally { $bmp.Dispose() }
        $image = & $module { param($p) ConvertFrom-OzkEscPosRaster $p } $payload
        Check-Guards "$n سطراً" (Split-OzkRasterRows $image.Raster)
    }
    # صورة حبرها يبدأ في الصف الأول تماماً (بلا أبيض علوي).
    $edge = Copy-Rows (Trim-Blank $src)
    Check-Guards "حبر من الصف 0" $edge
}

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
