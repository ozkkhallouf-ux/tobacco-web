# التقاط مسار الطباعة عبر التعريف إلى ملف — على جهاز فيه تعريف "Xprinter XP-80" فقط، بلا ورق.
#
# لا يعمل في CI ولا يعمل بلا -Execute. يحتاج موافقة صريحة لكل تشغيل لأنه ينشئ مؤقتاً طابوراً ومنفذاً:
#   1) يحفظ لقطة طابور الكاشير (التعريف، المنفذ، نوع البيانات، BIDI، Attributes، PrintTicket، مفاتيح التسجيل).
#   2) ينشئ منفذ ملف محلياً وطابوراً مؤقتاً غير مشترك وغير افتراضي بالتعريف نفسه وإعدادات الكاشير وBIDI مطفأ.
#   3) قبل كل إرسال: الطابور المؤقت يشير إلى ملف الالتقاط وحده، لا USB ولا أي منفذ فعلي، وطابور الكاشير على USB003.
#   4) يرسل إيصالات اصطناعية (7 و45 سطراً) عبر [OzkDriverReceiptPrinter]::Print — الدالة نفسها التي يستعملها
#      مسار driver — إلى الطابور المؤقت، ثم يفك أوامر GS v 0 في الملف ويقارن البكسلات بصورة OZK.
#   5) يحذف الطابور والمنفذ بعد التأكد من خلوهما، ويتحقق أن لقطة طابور الكاشير لم تتغيّر.
# الملف يسجّل البايتات لا التوقيت: لا يثبت شيئاً عن سرعة الإرسال إلى الطابعة.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File Test-CashierReprintDriverCapture.ps1 -Execute [-OutDir <dir>]
[CmdletBinding()]
param([switch]$Execute, [string]$OutDir = "", [string]$Renderer = "")

$ErrorActionPreference = "Stop"
if (-not $Execute) { Write-Host "SKIP التقاط التعريف: يحتاج -Execute وموافقة صريحة (ينشئ طابوراً مؤقتاً بمنفذ ملف)."; exit 0 }
if ($env:OS -ne "Windows_NT") { throw "Windows only." }
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Renderer) { $Renderer = Join-Path $repoRoot "tools\cashier-reprint\static-bridge\ozk-print-bridge\OzkReceiptRenderer.psm1" }
$logo = Join-Path $repoRoot "ozk-print-bridge\assets\ozk-receipt-horse-logo.png"
if (-not $OutDir) { $OutDir = Join-Path $env:ProgramData ("OZK\Capture\driver-path-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")) }
$cashier = "XPRINTER XP-T80Q 80MM"
$driverName = "Xprinter XP-80"
$capName = "OZK-Capture-DriverPath (FILE)"
$capPort = Join-Path $OutDir "capture.prn"

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}
function Sha([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
function Get-CashierSnapshot {
    $p = Get-Printer -Name $cashier
    $ticket = [Text.Encoding]::UTF8.GetBytes((Get-PrintConfiguration -PrinterName $cashier).PrintTicketXML)
    $sha = [Security.Cryptography.SHA256]::Create()
    $reg = Join-Path $OutDir ("queue-" + [guid]::NewGuid().ToString("N") + ".reg")
    & reg.exe export "HKLM\SYSTEM\CurrentControlSet\Control\Print\Printers\$cashier" $reg /y | Out-Null
    $regSha = Sha $reg; Remove-Item -LiteralPath $reg
    return [ordered]@{
        Driver = $p.DriverName; Port = $p.PortName; Datatype = $p.Datatype; Processor = $p.PrintProcessor; Shared = $p.Shared
        Bidi = (Get-CimInstance Win32_Printer -Filter "Name='$cashier'").EnableBIDI
        Attributes = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers\$cashier").Attributes
        Ticket = ([BitConverter]::ToString($sha.ComputeHash($ticket))); Registry = $regSha
        Default = [string](Get-CimInstance Win32_Printer | Where-Object Default).Name
    }
}
function Assert-Isolated {
    $cp = @(Get-Printer | Where-Object Name -eq $capName)
    if ($cp.Count -ne 1) { throw "STOP: temp queue missing or ambiguous." }
    if ($cp[0].PortName -ne $capPort) { throw "STOP: temp queue port is '$($cp[0].PortName)'." }
    if ($cp[0].PortName -match '^(USB|LPT|COM|DOT4|WSD|IP_|TS)') { throw "STOP: temp port looks physical." }
    if ((Get-PrinterPort -Name $capPort).PortMonitor -notmatch 'Local') { throw "STOP: temp port is not a local file port." }
    if ($cp[0].Shared) { throw "STOP: temp queue is shared." }
    if (@(Get-Printer | Where-Object PortName -eq $capPort).Count -ne 1) { throw "STOP: another queue uses the capture port." }
    if ((Get-Printer -Name $cashier).PortName -ne "USB003") { throw "STOP: cashier queue port changed." }
}
# أوامر الملف: يفك GS v 0 بالترتيب ويعدّ الباقي (لا يفسّرها ولا يفترض توقيتاً).
function Read-Prn([byte[]]$B) {
    $rows = New-Object System.Collections.Generic.List[byte[]]
    $bands = New-Object System.Collections.Generic.List[int]
    $other = @{}; $width = -1; $i = 0
    while ($i -lt $B.Length) {
        if ($B[$i] -eq 0x1D -and $i + 7 -lt $B.Length -and $B[$i + 1] -eq 0x76 -and $B[$i + 2] -eq 0x30) {
            $w = [int]$B[$i + 4] + 256 * [int]$B[$i + 5]; $h = [int]$B[$i + 6] + 256 * [int]$B[$i + 7]
            if ($width -lt 0) { $width = $w } elseif ($w -ne $width) { throw "PRN raster width changes: $width -> $w" }
            for ($y = 0; $y -lt $h; $y++) { $r = New-Object byte[] $w; [Buffer]::BlockCopy($B, $i + 8 + $y * $w, $r, 0, $w); $rows.Add($r) }
            $bands.Add($h); $i += 8 + $w * $h; continue
        }
        if ($B[$i] -eq 0x1B -or $B[$i] -eq 0x1D) { $k = "{0:X2} {1:X2}" -f $B[$i], $B[$i + 1]; $other[$k] = 1 + [int]$other[$k] }
        $i++
    }
    return [pscustomobject]@{ Rows = $rows; Bands = $bands; Width = $width; Other = $other }
}

$before = $null; $created = $false
try {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "STOP: needs an elevated session to add a temporary queue." }
    if (-not (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue)) { throw "STOP: driver '$driverName' is not installed." }
    if (Get-Printer -Name $capName -ErrorAction SilentlyContinue) { throw "STOP: '$capName' already exists." }
    [void](New-Item -ItemType Directory -Force -Path $OutDir)
    if (Get-PrinterPort -Name $capPort -ErrorAction SilentlyContinue) { throw "STOP: port '$capPort' already exists." }
    $before = Get-CashierSnapshot
    Add-PrinterPort -Name $capPort
    Add-Printer -Name $capName -DriverName $driverName -PortName $capPort
    $created = $true
    Set-PrintConfiguration -PrinterName $capName -PrintTicketXML (Get-PrintConfiguration -PrinterName $cashier).PrintTicketXML
    $w = Get-CimInstance Win32_Printer -Filter "Name='$capName'"
    if ($w.EnableBIDI) { $w.EnableBIDI = $false; Set-CimInstance -InputObject $w }
    Assert-Isolated
    Assert "الطابور المؤقت معزول: منفذ ملف محلي، غير مشترك، التعريف '$driverName'" ($true)

    $module = Import-Module $Renderer -Force -DisableNameChecking -PassThru
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
    $paper = & $module { $script:ReceiptDriverPaperName }
    foreach ($n in 7, 45) {
        $bmp = New-OzkReceiptBitmap -Receipt (New-Mock $n) -LogoPath $logo
        try { $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190) } finally { $bmp.Dispose() }
        $image = & $module { param($p) ConvertFrom-OzkEscPosRaster $p } $payload
        $ink = [OzkDriverReceiptPrinter]::InkExtent($image.Raster, $image.BytesPerRow, $image.Rows)
        Assert-Isolated
        if (Test-Path -LiteralPath $capPort) { Remove-Item -LiteralPath $capPort -Force }
        $jobId = [OzkDriverReceiptPrinter]::Print($capName, $image.Raster, $image.BytesPerRow, $image.Rows, $paper, 203, "OZK capture $n")
        Assert "[$n سطراً] مسار التعريف أعاد رقم مهمة ($jobId)" ($jobId -gt 0)
        $deadline = (Get-Date).AddSeconds(120); $last = -1; $stable = $false
        do {
            Start-Sleep -Seconds 2
            $size = if (Test-Path -LiteralPath $capPort) { (Get-Item -LiteralPath $capPort).Length } else { -1 }
            $stable = ($size -gt 0 -and $size -eq $last -and @(Get-PrintJob -PrinterName $capName).Count -eq 0); $last = $size
        } until ($stable -or (Get-Date) -gt $deadline)
        Assert "[$n سطراً] اكتمل الالتقاط إلى الملف ($size بايت)" $stable
        if (-not $stable) { continue }
        $prnPath = Join-Path $OutDir "syn-$n-driver.prn"
        Move-Item -LiteralPath $capPort -Destination $prnPath -Force
        [IO.File]::WriteAllBytes((Join-Path $OutDir "syn-$n-ozk-raster.bin"), $image.Raster)
        $prn = Read-Prn ([IO.File]::ReadAllBytes($prnPath))
        Assert "[$n سطراً] عرض صورة التعريف 72 بايتاً = 576 نقطة (لا تحجيم أفقي)" ($prn.Width -eq 72)
        # محاذاة رأسية فقط (التعريف يقصّ الأبيض أعلى وأسفل)، ثم مقارنة كل صف من صفوف المصدر.
        $src = New-Object System.Collections.Generic.List[string]
        for ($y = 0; $y -lt $image.Rows; $y++) { $src.Add([BitConverter]::ToString($image.Raster, $y * 72, 72)) }
        $drv = @($prn.Rows | ForEach-Object { [BitConverter]::ToString($_) })
        $blank = [BitConverter]::ToString((New-Object byte[] 72))
        $firstInk = 0; while ($firstInk -lt $src.Count -and $src[$firstInk] -eq $blank) { $firstInk++ }
        $drvFirst = 0; while ($drvFirst -lt $drv.Count -and $drv[$drvFirst] -eq $blank) { $drvFirst++ }
        $dy = $drvFirst - $firstInk
        $diffRows = 0; $missingRows = 0
        for ($y = 0; $y -lt $src.Count; $y++) {
            $yy = $y + $dy
            if ($yy -lt 0 -or $yy -ge $drv.Count) { if ($src[$y] -ne $blank) { $missingRows++ } }
            elseif ($src[$y] -ne $drv[$yy]) { $diffRows++ }
        }
        $extraInk = 0
        for ($yy = 0; $yy -lt $drv.Count; $yy++) { $y = $yy - $dy; if (($y -lt 0 -or $y -ge $src.Count) -and $drv[$yy] -ne $blank) { $extraInk++ } }
        Assert "[$n سطراً] كل صفوف الحبر موجودة (لا قص للإجمالي أو التذييل): مفقود $missingRows" ($missingRows -eq 0 -and $ink[1] -gt 0)
        Assert "[$n سطراً] مطابقة بالبكسل لصورة OZK: صفوف مختلفة $diffRows من $($src.Count)" ($diffRows -eq 0 -and $src.Count -gt 0)
        Assert "[$n سطراً] لا حبر إضافي خارج الصورة (لا هوامش أو إطارات): $extraInk" ($extraInk -eq 0)
        $bandSizes = @($prn.Bands | Group-Object | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ","
        $otherCmds = @($prn.Other.Keys | Sort-Object | ForEach-Object { "$_=$($prn.Other[$_])" }) -join " "
        Write-Host ("INFO [{0} سطراً] حِزَم GS v 0: {1}؛ أوامر أخرى (عدّ فقط): {2}؛ إزاحة رأسية {3}" -f $n, $bandSizes, $otherCmds, $dy)
    }
} finally {
    if ($created) {
        $jobs = @(Get-PrintJob -PrinterName $capName -ErrorAction SilentlyContinue)
        if ($jobs.Count -eq 0) {
            Remove-Printer -Name $capName -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
            Remove-PrinterPort -Name $capPort -ErrorAction SilentlyContinue
        } else { Write-Host "WARN الطابور المؤقت ما زال فيه $($jobs.Count) مهمة؛ لم يُحذف. احذفه يدوياً بعد فحصه." -ForegroundColor Yellow }
        Assert "حُذف الطابور والمنفذ المؤقتان" (-not (Get-Printer -Name $capName -ErrorAction SilentlyContinue) -and -not (Get-PrinterPort -Name $capPort -ErrorAction SilentlyContinue))
    }
    if ($null -ne $before) {
        $after = Get-CashierSnapshot
        $changed = @($before.Keys | Where-Object { [string]$before[$_] -ne [string]$after[$_] })
        Assert "طابور الكاشير لم يتغيّر (التعريف، المنفذ، BIDI، Attributes، PrintTicket، التسجيل، الافتراضي): $($changed -join ',')" ($changed.Count -eq 0)
    }
}
Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed (الأدلة: $OutDir)"
if ($script:fail -gt 0) { exit 1 }
exit 0
