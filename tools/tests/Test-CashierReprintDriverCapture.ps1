# التقاط مسار الطباعة عبر التعريف إلى ملف — على جهاز فيه تعريف "Xprinter XP-80" فقط، بلا ورق.
#
# لا يعمل في CI ولا يعمل بلا -Execute. يحتاج موافقة صريحة لكل تشغيل لأنه ينشئ مؤقتاً طابوراً ومنفذاً:
#   1) يحفظ لقطة طابور الكاشير (التعريف، المنفذ، نوع البيانات، BIDI، Attributes، PrintTicket، مفاتيح التسجيل).
#   2) ينشئ منفذ ملف محلياً وطابوراً مؤقتاً غير مشترك وغير افتراضي بالتعريف نفسه وإعدادات الكاشير وBIDI مطفأ.
#   3) قبل كل إرسال: الطابور المؤقت يشير إلى ملف الالتقاط وحده، لا USB ولا أي منفذ فعلي، وطابور الكاشير على USB003.
#   4) يرسل إيصالات اصطناعية (7 و45 سطراً) عبر [OzkDriverReceiptPrinter]::Print — الدالة نفسها التي يستعملها
#      مسار driver، بصف الحماية — إلى الطابور المؤقت، ثم يفك أوامر GS v 0 ويقارن بالمقارِن المشترك
#      (tools/tests/lib/OzkDriverCapture.psm1): محاذاة موثقة، صفر نقاط مفقودة أو زائدة، الارتفاع نفسه.
#      أي فشل ⇒ توقف فوراً بلا إرسال التالي. بعدها حالة تشخيصية واحدة بصف أبيض (لا تدخل في الحكم).
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

Import-Module (Join-Path (Join-Path $PSScriptRoot "lib") "OzkDriverCapture.psm1") -Force -DisableNameChecking
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
    # الإنتاج (Print = صف حبر) أولاً؛ أي فشل يوقف الإرسال. ثم صف أبيض للتشخيص وحده.
    $plan = @(
        [pscustomobject]@{ Lines = 7; Guard = "ink"; Verdict = $true },
        [pscustomobject]@{ Lines = 45; Guard = "ink"; Verdict = $true },
        [pscustomobject]@{ Lines = 7; Guard = "white"; Verdict = $false })
    foreach ($step in $plan) {
        if ($script:fail -gt 0) { Write-Host "STOP فشل تحقق سابق؛ لا إرسال لما بعده." -ForegroundColor Red; break }
        $n = $step.Lines; $tag = "$n سطراً، صف $($step.Guard)"
        $bmp = New-OzkReceiptBitmap -Receipt (New-Mock $n) -LogoPath $logo
        try { $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bmp, 190) } finally { $bmp.Dispose() }
        $image = & $module { param($p) ConvertFrom-OzkEscPosRaster $p } $payload
        Assert-Isolated
        if (Test-Path -LiteralPath $capPort) { Remove-Item -LiteralPath $capPort -Force }
        if ($step.Guard -eq "ink") {
            $jobId = [OzkDriverReceiptPrinter]::Print($capName, $image.Raster, $image.BytesPerRow, $image.Rows, $paper, 203, "OZK capture $n")
        } else {
            $jobId = [OzkDriverReceiptPrinter]::PrintWithGuard($capName, $image.Raster, $image.BytesPerRow, $image.Rows, $paper, 203, "OZK capture $n white", [OzkDriverReceiptPrinter]::GuardWhite)
        }
        $deadline = (Get-Date).AddSeconds(120); $last = -1; $stable = $false
        do {
            Start-Sleep -Seconds 2
            $size = if (Test-Path -LiteralPath $capPort) { (Get-Item -LiteralPath $capPort).Length } else { -1 }
            $stable = ($size -gt 0 -and $size -eq $last -and @(Get-PrintJob -PrinterName $capName).Count -eq 0); $last = $size
        } until ($stable -or (Get-Date) -gt $deadline)
        $prnPath = Join-Path $OutDir ("syn-{0}-{1}-driver.prn" -f $n, $step.Guard)
        if ($stable) { Move-Item -LiteralPath $capPort -Destination $prnPath -Force }
        [IO.File]::WriteAllBytes((Join-Path $OutDir ("syn-{0}-{1}-source.bin" -f $n, $step.Guard)), $image.Raster)
        if (-not $step.Verdict) {
            if (-not $stable) { Write-Host "INFO [$tag] لم يكتمل الالتقاط التشخيصي"; continue }
            $cmp = Compare-OzkDriverOutput (Split-OzkRasterRows $image.Raster) (Read-OzkDriverPrn ([IO.File]::ReadAllBytes($prnPath))).Rows
            Write-Host ("INFO [{0}] تشخيص (خارج الحكم): Pass={1} مفقود={2} زائد={3} أفضل محاذاة: مفقود={4} أول صف مفقود={5}" -f $tag, $cmp.Pass, $cmp.MissingDots, $cmp.ExtraDots, $cmp.BestMissingDots, $cmp.BestFirstMissingRow)
            continue
        }
        Assert "[$tag] مسار التعريف أعاد رقم مهمة ($jobId)" ($jobId -gt 0)
        Assert "[$tag] اكتمل الالتقاط إلى الملف ($size بايت)" $stable
        if (-not $stable) { continue }
        $prn = Read-OzkDriverPrn ([IO.File]::ReadAllBytes($prnPath))
        $cmp = Compare-OzkDriverOutput (Split-OzkRasterRows $image.Raster) $prn.Rows
        Assert "[$tag] عرض صورة التعريف 72 بايتاً = 576 نقطة (لا تحجيم أفقي)" ($prn.Width -eq 72)
        Assert "[$tag] كل نقاط المصدر موجودة بما فيها أول صف من الشعار: مفقود $($cmp.MissingDots) (أول حبر في المصدر $($cmp.SourceFirstInk))" ($cmp.MissingDots -eq 0 -and $cmp.SourceInk -gt 0)
        Assert "[$tag] لا حبر زائد (صف الحماية لم يُطبع، ولا هوامش): زائد $($cmp.ExtraDots)" ($cmp.ExtraDots -eq 0)
        Assert "[$tag] ارتفاع الحبر وعدد النقاط كما في المصدر ($($cmp.SourceInk) نقطة): $($cmp.Reason)" ($cmp.Pass)
        $bandSizes = @($prn.Bands | Group-Object | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ","
        $otherCmds = @($prn.Other.Keys | Sort-Object | ForEach-Object { "$_=$($prn.Other[$_])" }) -join " "
        Write-Host ("INFO [{0}] حِزَم GS v 0: {1}؛ أوامر أخرى (عدّ فقط): {2}؛ المحاذاة الموثقة {3}؛ أفضل محاذاة {4}" -f $tag, $bandSizes, $otherCmds, $cmp.Dy, $cmp.BestDy)
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
