Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

if (-not ("OzkRawThermalPrinter" -as [type])) {
    Add-Type -ReferencedAssemblies @(
        [Drawing.Bitmap].Assembly.Location,
        [Drawing.Rectangle].Assembly.Location
    ) -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class OzkRawThermalPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DOC_INFO_1
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int StartDocPrinter(IntPtr printer, int level, ref DOC_INFO_1 docInfo);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

    public static byte[] ToEscPosRaster(Bitmap bitmap, byte threshold)
    {
        const int widthDots = 576;
        const int bytesPerRow = widthDots / 8;
        const int bandHeight = 512;
        if (bitmap.Width != widthDots) throw new ArgumentException("Receipt bitmap must be exactly 576 dots wide.");

        Rectangle bounds = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        BitmapData bits = bitmap.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            int stride = Math.Abs(bits.Stride);
            byte[] pixels = new byte[stride * bitmap.Height];
            Marshal.Copy(bits.Scan0, pixels, 0, pixels.Length);
            using (MemoryStream output = new MemoryStream())
            {
                output.WriteByte(0x1B); output.WriteByte(0x40); // ESC @ initialize
                output.WriteByte(0x1D); output.WriteByte(0x4C); output.WriteByte(0x00); output.WriteByte(0x00); // left margin 0
                output.WriteByte(0x1D); output.WriteByte(0x57); output.WriteByte(0x40); output.WriteByte(0x02); // width 576 dots

                for (int bandTop = 0; bandTop < bitmap.Height; bandTop += bandHeight)
                {
                    int rows = Math.Min(bandHeight, bitmap.Height - bandTop);
                    output.WriteByte(0x1D); output.WriteByte(0x76); output.WriteByte(0x30); output.WriteByte(0x00);
                    output.WriteByte((byte)(bytesPerRow & 0xFF)); output.WriteByte((byte)(bytesPerRow >> 8));
                    output.WriteByte((byte)(rows & 0xFF)); output.WriteByte((byte)(rows >> 8));
                    for (int y = 0; y < rows; y++)
                    {
                        int sourceY = bandTop + y;
                        int rowOffset = sourceY * stride;
                        for (int byteX = 0; byteX < bytesPerRow; byteX++)
                        {
                            byte packed = 0;
                            for (int bit = 0; bit < 8; bit++)
                            {
                                int x = byteX * 8 + bit;
                                int pixel = rowOffset + x * 3;
                                int luminance = (pixels[pixel] * 29 + pixels[pixel + 1] * 150 + pixels[pixel + 2] * 77) >> 8;
                                if (luminance < threshold) packed |= (byte)(0x80 >> bit);
                            }
                            output.WriteByte(packed);
                        }
                    }
                }
                output.WriteByte(0x1D); output.WriteByte(0x56); output.WriteByte(0x42); output.WriteByte(0x00); // feed to cutter + partial cut
                return output.ToArray();
            }
        }
        finally
        {
            bitmap.UnlockBits(bits);
        }
    }

    public static int Send(string printerName, byte[] payload, string documentName)
    {
        IntPtr printer;
        if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw new InvalidOperationException("OpenPrinter failed with Win32 error " + Marshal.GetLastWin32Error());
        bool documentStarted = false;
        bool pageStarted = false;
        try
        {
            DOC_INFO_1 info = new DOC_INFO_1 { pDocName = documentName, pOutputFile = null, pDataType = "RAW" };
            int jobId = StartDocPrinter(printer, 1, ref info);
            if (jobId <= 0) throw new InvalidOperationException("StartDocPrinter failed with Win32 error " + Marshal.GetLastWin32Error());
            documentStarted = true;
            if (!StartPagePrinter(printer)) throw new InvalidOperationException("StartPagePrinter failed with Win32 error " + Marshal.GetLastWin32Error());
            pageStarted = true;
            int written;
            if (!WritePrinter(printer, payload, payload.Length, out written)) throw new InvalidOperationException("WritePrinter failed with Win32 error " + Marshal.GetLastWin32Error());
            if (written != payload.Length) throw new IOException("Incomplete RAW printer write.");
            if (!EndPagePrinter(printer)) throw new InvalidOperationException("EndPagePrinter failed with Win32 error " + Marshal.GetLastWin32Error());
            pageStarted = false;
            if (!EndDocPrinter(printer)) throw new InvalidOperationException("EndDocPrinter failed with Win32 error " + Marshal.GetLastWin32Error());
            documentStarted = false;
            return jobId;
        }
        finally
        {
            if (pageStarted) EndPagePrinter(printer);
            if (documentStarted) EndDocPrinter(printer);
            ClosePrinter(printer);
        }
    }
}
"@
}

$script:ReceiptWidth = 576
$script:ReceiptDpi = 203
$script:CashierPrinterName = "XPRINTER XP-T80Q 80MM"
$script:Invariant = [Globalization.CultureInfo]::InvariantCulture

function New-OzkFont([float]$Size, [Drawing.FontStyle]$Style = [Drawing.FontStyle]::Regular) {
    return New-Object Drawing.Font("Tahoma", $Size, $Style, [Drawing.GraphicsUnit]::Pixel)
}

function New-OzkTextFormat([string]$Align = "Right", [bool]$Rtl = $true) {
    $format = New-Object Drawing.StringFormat
    $format.Trimming = [Drawing.StringTrimming]::Word
    $format.FormatFlags = [Drawing.StringFormatFlags]::LineLimit
    if ($Rtl) { $format.FormatFlags = $format.FormatFlags -bor [Drawing.StringFormatFlags]::DirectionRightToLeft }
    switch ($Align) {
        "Left" { $format.Alignment = [Drawing.StringAlignment]::Near }
        "Center" { $format.Alignment = [Drawing.StringAlignment]::Center }
        default { $format.Alignment = [Drawing.StringAlignment]::Near }
    }
    $format.LineAlignment = [Drawing.StringAlignment]::Center
    return $format
}

function Draw-OzkText($Graphics, [string]$Text, $Font, [float]$X, [float]$Y, [float]$Width, [float]$Height, [string]$Align = "Right", [bool]$Rtl = $true) {
    $format = New-OzkTextFormat $Align $Rtl
    try {
        $Graphics.DrawString($Text, $Font, [Drawing.Brushes]::Black, (New-Object Drawing.RectangleF($X, $Y, $Width, $Height)), $format)
    } finally {
        $format.Dispose()
    }
}

function Draw-OzkDashedLine($Graphics, [float]$Y, [float]$X1 = 20, [float]$X2 = 556, [Drawing.Color]$Color = [Drawing.Color]::Black) {
    $pen = New-Object Drawing.Pen($Color, 1)
    try {
        $pen.DashPattern = @(5.0, 3.0)
        $Graphics.DrawLine($pen, $X1, $Y, $X2, $Y)
    } finally {
        $pen.Dispose()
    }
}

function New-OzkRoundedPath([Drawing.RectangleF]$Rectangle, [float]$Radius) {
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
    $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Format-OzkAmount($Value) {
    if ($null -eq $Value) { return "0.00" }
    return ([double]$Value).ToString("#,##0.00", $script:Invariant)
}

function Format-OzkQuantity($Value) {
    if ($null -eq $Value) { return "0.0" }
    return ([double]$Value).ToString("#,##0.0#", $script:Invariant)
}

function Get-OzkLineHeight($Graphics, [string]$Name, $Font, [float]$Width) {
    $format = New-OzkTextFormat "Right" $true
    try {
        $size = $Graphics.MeasureString($Name, $Font, (New-Object Drawing.SizeF($Width, 300)), $format)
        return [math]::Max(43, [math]::Ceiling($size.Height + 12))
    } finally {
        $format.Dispose()
    }
}

function New-OzkReceiptBitmap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$LogoPath
    )

    if (-not (Test-Path -LiteralPath $LogoPath -PathType Leaf)) { throw "Receipt logo not found: $LogoPath" }
    $canvasHeight = 2600
    $bitmap = New-Object Drawing.Bitmap($script:ReceiptWidth, $canvasHeight, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $bitmap.SetResolution($script:ReceiptDpi, $script:ReceiptDpi)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $logo = $null
    $fonts = New-Object System.Collections.Generic.List[Drawing.Font]
    try {
        $graphics.Clear([Drawing.Color]::White)
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit

        $titleFont = New-OzkFont 54 ([Drawing.FontStyle]::Bold); $fonts.Add($titleFont)
        $subtitleFont = New-OzkFont 22; $fonts.Add($subtitleFont)
        $strongFont = New-OzkFont 22 ([Drawing.FontStyle]::Bold); $fonts.Add($strongFont)
        $registrationFont = New-OzkFont 20 ([Drawing.FontStyle]::Bold); $fonts.Add($registrationFont)
        $bodyFont = New-OzkFont 24; $fonts.Add($bodyFont)
        $bodyBoldFont = New-OzkFont 24 ([Drawing.FontStyle]::Bold); $fonts.Add($bodyBoldFont)
        $tableNameFont = New-OzkFont 21 ([Drawing.FontStyle]::Bold); $fonts.Add($tableNameFont)
        $tableNumberFont = New-OzkFont 19 ([Drawing.FontStyle]::Bold); $fonts.Add($tableNumberFont)
        $tableBoldFont = New-OzkFont 19 ([Drawing.FontStyle]::Bold); $fonts.Add($tableBoldFont)
        $totalFont = New-OzkFont 24 ([Drawing.FontStyle]::Bold); $fonts.Add($totalFont)
        $netFont = New-OzkFont 27 ([Drawing.FontStyle]::Bold); $fonts.Add($netFont)
        $saleFont = New-OzkFont 21 ([Drawing.FontStyle]::Bold); $fonts.Add($saleFont)
        $footerFont = New-OzkFont 22 ([Drawing.FontStyle]::Bold); $fonts.Add($footerFont)

        $logo = [Drawing.Image]::FromFile((Resolve-Path -LiteralPath $LogoPath).Path)
        $graphics.DrawImage($logo, (New-Object Drawing.RectangleF(22, 0, 150, 168)))
        Draw-OzkText $graphics ([string]$Receipt.MerchantName) $titleFont 170 0 386 75 "Center" $true
        Draw-OzkText $graphics ([string]$Receipt.Subtitle) $subtitleFont 170 72 386 39 "Center" $true
        Draw-OzkText $graphics "رقم السجل التجاري:" $strongFont 320 110 236 48 "Right" $true
        Draw-OzkText $graphics ([string]$Receipt.CommercialRegister) $registrationFont 170 110 150 48 "Center" $false
        Draw-OzkDashedLine $graphics 174

        $y = 180
        Draw-OzkText $graphics "☎" $strongFont 20 $y 45 43 "Center" $false
        Draw-OzkText $graphics ([string]$Receipt.Phones) $bodyFont 66 $y 310 43 "Left" $false
        Draw-OzkText $graphics "الهاتف:" $bodyFont 376 $y 180 43 "Right" $true
        $y += 44
        Draw-OzkText $graphics ([string]$Receipt.CenterPhone) $bodyFont 66 $y 310 43 "Left" $false
        Draw-OzkText $graphics "رقم المركز:" $bodyFont 376 $y 180 43 "Right" $true
        $y += 44
        Draw-OzkText $graphics "●" $bodyFont 20 $y 45 43 "Center" $false
        Draw-OzkText $graphics ([string]$Receipt.Address) $bodyFont 66 $y 310 43 "Left" $true
        $y += 49
        Draw-OzkDashedLine $graphics $y
        $y += 10

        Draw-OzkText $graphics ("التاريخ:  {0}" -f $Receipt.Date) $bodyFont 300 $y 256 45 "Right" $true
        Draw-OzkText $graphics "الوقت:" $bodyFont 190 $y 100 45 "Right" $true
        Draw-OzkText $graphics $Receipt.Time $bodyFont 20 $y 170 45 "Right" $false
        $y += 47
        Draw-OzkText $graphics ("العميل:  {0}" -f $Receipt.CustomerName) $bodyFont 20 $y 536 43 "Right" $true
        $y += 43
        Draw-OzkText $graphics ("البيان:  {0}" -f $Receipt.Description) $bodyFont 20 $y 536 43 "Right" $true
        $y += 49
        Draw-OzkDashedLine $graphics $y
        $y += 14

        $headerRect = New-Object Drawing.RectangleF(20, $y, 536, 45)
        $headerPath = New-OzkRoundedPath $headerRect 6
        $headerBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(218, 218, 218))
        $headerPen = New-Object Drawing.Pen([Drawing.Color]::Black, 1)
        try {
            $graphics.FillPath($headerBrush, $headerPath)
            $graphics.DrawPath($headerPen, $headerPath)
        } finally {
            $headerBrush.Dispose(); $headerPen.Dispose(); $headerPath.Dispose()
        }
        Draw-OzkText $graphics "الإجمالي" $tableBoldFont 20 $y 118 45 "Center" $true
        Draw-OzkText $graphics "سعر الفردي" $tableBoldFont 138 $y 122 45 "Center" $true
        Draw-OzkText $graphics "الكمية" $tableBoldFont 260 $y 82 45 "Center" $true
        Draw-OzkText $graphics "اسم المادة" $tableBoldFont 342 $y 214 45 "Center" $true
        $y += 49

        foreach ($line in @($Receipt.Lines)) {
            $rowHeight = [math]::Max(54, (Get-OzkLineHeight $graphics ([string]$line.Name) $tableNameFont 204))
            Draw-OzkText $graphics (Format-OzkAmount $line.Total) $tableNumberFont 20 $y 118 $rowHeight "Center" $false
            Draw-OzkText $graphics (Format-OzkAmount $line.UnitPrice) $tableNumberFont 138 $y 122 $rowHeight "Center" $false
            Draw-OzkText $graphics (Format-OzkQuantity $line.Quantity) $tableNumberFont 260 $y 82 $rowHeight "Center" $false
            Draw-OzkText $graphics ([string]$line.Name) $tableNameFont 347 $y 209 $rowHeight "Right" $true
            $y += $rowHeight
            Draw-OzkDashedLine $graphics $y 20 556 ([Drawing.Color]::Gray)
            $y += 2
        }

        $graphics.DrawLine([Drawing.Pens]::Black, 20, $y + 2, 556, $y + 2)
        $y += 6
        $totals = @(
            @{ Label = "الإجمالي:"; Value = $Receipt.GrossTotal; Net = $false },
            @{ Label = "الخصومات:"; Value = $Receipt.Discount; Net = $false },
            @{ Label = "صافي الفاتورة:"; Value = $Receipt.NetTotal; Net = $true },
            @{ Label = "الدفعة:"; Value = $Receipt.Payment; Net = $false }
        )
        # الرصيد يُطبع فقط إذا نجح العثور على مستند محاسبي حقيقي في Ameen لهذه
        # الفاتورة (BalanceFound = true). لا يجوز طباعة صفر أو رقم تقريبي كرصيد
        # حقيقي عندما تكون البيانات المحاسبية ناقصة أو غير موجودة.
        if ($Receipt.BalanceFound) {
            $totals += @{ Label = "الرصيد السابق:"; Value = $Receipt.PreviousBalance; Net = $false }
            $totals += @{ Label = "الرصيد الحالي:"; Value = $Receipt.CurrentBalance; Net = $false }
        }
        $totals += @{ Label = "عدد البنود:"; Value = $Receipt.ItemCount; Net = $false; Integer = $true }
        $totals += @{ Label = "الكمية:"; Value = $Receipt.TotalQuantity; Net = $false; Quantity = $true }
        foreach ($total in $totals) {
            if ($total.Net) {
                $netPen = New-Object Drawing.Pen([Drawing.Color]::Black, 2)
                try { $graphics.DrawRectangle($netPen, 20, $y, 536, 42) } finally { $netPen.Dispose() }
            }
            $font = if ($total.Net) { $netFont } else { $totalFont }
            $isInteger = $total.ContainsKey("Integer") -and [bool]$total.Integer
            $isQuantity = $total.ContainsKey("Quantity") -and [bool]$total.Quantity
            $valueText = if ($isInteger) { ([int]$total.Value).ToString($script:Invariant) } elseif ($isQuantity) { Format-OzkQuantity $total.Value } else { Format-OzkAmount $total.Value }
            Draw-OzkText $graphics ([string]$total.Label) $font 300 $y 256 42 "Right" $true
            Draw-OzkText $graphics $valueText $font 20 $y 260 42 "Left" $false
            $y += 43
            Draw-OzkDashedLine $graphics $y 20 556 ([Drawing.Color]::Gray)
        }

        $y += 16
        $saleRect = New-Object Drawing.RectangleF(22, $y, 532, 62)
        $salePath = New-OzkRoundedPath $saleRect 10
        $salePen = New-Object Drawing.Pen([Drawing.Color]::Black, 1.5)
        try {
            $graphics.DrawPath($salePen, $salePath)
        } finally {
            $salePen.Dispose(); $salePath.Dispose()
        }
        Draw-OzkText $graphics ([string]$Receipt.SaleDescription) $saleFont 32 $y 512 62 "Center" $true
        $y += 77
        Draw-OzkText $graphics "◆ ─────  شكراً لتعاملكم معنا  ───── ◆" $footerFont 20 $y 536 50 "Center" $true
        $y += 64

        $finalHeight = [math]::Min($canvasHeight, [math]::Ceiling($y))
        $cropped = New-Object Drawing.Bitmap($script:ReceiptWidth, $finalHeight, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
        $cropped.SetResolution($script:ReceiptDpi, $script:ReceiptDpi)
        $cropGraphics = [Drawing.Graphics]::FromImage($cropped)
        try {
            $cropGraphics.Clear([Drawing.Color]::White)
            $cropGraphics.DrawImageUnscaled($bitmap, 0, 0)
        } finally {
            $cropGraphics.Dispose()
        }
        return $cropped
    } finally {
        if ($null -ne $logo) { $logo.Dispose() }
        foreach ($font in $fonts) { $font.Dispose() }
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Save-OzkReceiptPreview {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$LogoPath,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $directory = [IO.Path]::GetDirectoryName($fullPath)
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [void](New-Item -ItemType Directory -Path $directory -Force) }
    $bitmap = New-OzkReceiptBitmap -Receipt $Receipt -LogoPath $LogoPath
    try {
        $bitmap.Save($fullPath, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }
    return $fullPath
}

function Send-OzkReceiptToPrinter {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$LogoPath,
        [Parameter(Mandatory = $true)][string]$PrinterName,
        [switch]$ConfirmPhysicalPrint
    )
    if (-not $ConfirmPhysicalPrint) { throw "Physical printing requires -ConfirmPhysicalPrint." }
    if ($PrinterName -cne $script:CashierPrinterName) {
        throw "Cashier receipts are restricted to '$($script:CashierPrinterName)'; refusing '$PrinterName'."
    }
    $installed = @(Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $PrinterName })
    if ($installed.Count -ne 1) { throw "Printer queue not found or ambiguous: $PrinterName" }
    $bitmap = New-OzkReceiptBitmap -Receipt $Receipt -LogoPath $LogoPath
    try {
        $payload = [OzkRawThermalPrinter]::ToEscPosRaster($bitmap, 190)
        $jobId = [OzkRawThermalPrinter]::Send($PrinterName, $payload, "OZK Cashier Receipt 80mm")
    } finally {
        $bitmap.Dispose()
    }
    return [pscustomobject]@{ Submitted = $true; PrinterName = $PrinterName; JobId = $jobId; Transport = "RAW ESC/POS"; SubmittedAt = (Get-Date).ToString("o") }
}

Export-ModuleMember -Function New-OzkReceiptBitmap, Save-OzkReceiptPreview, Send-OzkReceiptToPrinter
