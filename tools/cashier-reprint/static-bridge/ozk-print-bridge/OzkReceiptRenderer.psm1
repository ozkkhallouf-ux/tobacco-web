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

# Queue check through winspool. Win32_Printer (WMI/CIM) denies a non-admin network logon such as
# the ssh service account, while OpenPrinter/GetPrinter need only the print right Send already uses.
if (-not ("OzkThermalPrinterQueue" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OzkThermalPrinterQueue
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PRINTER_INFO_2
    {
        public string pServerName, pPrinterName, pShareName, pPortName, pDriverName, pComment, pLocation;
        public IntPtr pDevMode;
        public string pSepFile, pPrintProcessor, pDatatype, pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, cJobs, AveragePPM;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetPrinter(IntPtr printer, int level, IntPtr buffer, int size, out int needed);

    // [queue name as Windows reports it, PRINTER_INFO_2.Status]
    public static string[] Info(string printerName)
    {
        IntPtr printer;
        if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr buffer = IntPtr.Zero;
        try
        {
            int needed;
            GetPrinter(printer, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            buffer = Marshal.AllocHGlobal(needed);
            if (!GetPrinter(printer, 2, buffer, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(buffer, typeof(PRINTER_INFO_2));
            return new string[] { info.pPrinterName, info.Status.ToString() };
        }
        finally
        {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            ClosePrinter(printer);
        }
    }
}
"@
}

# PRINTER_STATUS bits that would leave a job waiting in the queue to print later on its own:
# paused, error, pending deletion, paper jam, paper out, offline, not available, user intervention, door open.
$script:PrinterBlockingStatusMask = 0x1 -bor 0x2 -bor 0x4 -bor 0x8 -bor 0x10 -bor 0x80 -bor 0x1000 -bor 0x100000 -bor 0x400000

# ── مسار اختياري: الطباعة عبر تعريف Windows للطابعة (Xprinter XP-80) بدل RAW ─────────────
# يُختار بمتغيّر البيئة OZK_RECEIPT_TRANSPORT=driver الذي تضبطه أداة إعادة الطباعة للعملية الفرعية وحدها.
# غيابه أو raw ⇒ مسار RAW كما هو بلا أي تغيير. أي قيمة أخرى ⇒ رفض قبل إنشاء أي مهمة.
# الصورة المُرسلة هي صفوف ESC/POS نفسها التي يرسلها RAW (ToEscPosRaster بعتبة 190)، كصورة 1bpp
# بمقياس 1:1 بنقاط الجهاز (StretchDIBits بلا تمديد). التعريف وحده يحوّلها إلى أوامر الطابعة؛ لا أمر
# ESC/POS يُكتب هنا يدوياً. كل فحص (الورق، الدقة، الهوامش، المساحة) يقع قبل StartDoc، فالرفض فيه
# يعني يقيناً أن لا مهمة أُنشئت. ما بعد StartDoc يُلغى بـAbortDoc ويُبلَّغ مع رقم المهمة (غير مؤكد).
if (-not ("OzkDriverReceiptPrinter" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OzkDriverReceiptPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DOCINFOW
    {
        public int cbSize;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszOutput;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszDatatype;
        public uint fwType;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PRINTER_INFO_2
    {
        public string pServerName, pPrinterName, pShareName, pPortName, pDriverName, pComment, pLocation;
        public IntPtr pDevMode;
        public string pSepFile, pPrintProcessor, pDatatype, pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, cJobs, AveragePPM;
    }

    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetPrinter(IntPtr printer, int level, IntPtr buffer, int size, out int needed);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "DocumentPropertiesW")]
    private static extern int DocumentProperties(IntPtr hwnd, IntPtr printer, string deviceName, IntPtr devModeOut, IntPtr devModeIn, int mode);
    [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "DeviceCapabilitiesW")]
    private static extern int DeviceCapabilities(string device, string port, ushort capability, IntPtr output, IntPtr devMode);
    [DllImport("gdi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateDCW")]
    private static extern IntPtr CreateDC(string driver, string device, string output, IntPtr devMode);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int GetDeviceCaps(IntPtr hdc, int index);
    [DllImport("gdi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "StartDocW")]
    private static extern int StartDoc(IntPtr hdc, ref DOCINFOW info);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int StartPage(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int EndPage(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int EndDoc(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int AbortDoc(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateDIBSection(IntPtr hdc, byte[] bitmapInfo, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")]
    private static extern bool GdiFlush();
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int StretchDIBits(IntPtr hdc, int xDest, int yDest, int destWidth, int destHeight, int xSrc, int ySrc, int srcWidth, int srcHeight, byte[] bits, byte[] bitmapInfo, uint usage, uint rop);

    private const int DM_OUT_BUFFER = 2, DM_IN_BUFFER = 8;
    private const int DM_ORIENTATION = 0x1, DM_PAPERSIZE = 0x2, DM_PAPERLENGTH = 0x4, DM_PAPERWIDTH = 0x8, DM_COPIES = 0x100;
    private const int DEVMODE_FIELDS = 72, DEVMODE_ORIENTATION = 76, DEVMODE_PAPERSIZE = 78, DEVMODE_COPIES = 86;
    private const ushort DC_PAPERS = 2, DC_PAPERNAMES = 16;
    private const int HORZRES = 8, VERTRES = 10, LOGPIXELSX = 88, LOGPIXELSY = 90, PHYSICALOFFSETX = 112, PHYSICALOFFSETY = 113;
    private const uint SRCCOPY = 0x00CC0020, DIB_RGB_COLORS = 0;

    // أقصى عمود حبر + 1 وأقصى صف حبر + 1 (بت 1 = أسود، الأعلى أولاً كما في GS v 0).
    public static int[] InkExtent(byte[] raster, int bytesPerRow, int rows)
    {
        if (raster == null || bytesPerRow <= 0 || rows <= 0 || raster.Length != bytesPerRow * rows) throw new ArgumentException("Raster size does not match its rows.");
        int maxX = 0, maxY = 0;
        for (int y = 0; y < rows; y++)
        {
            int o = y * bytesPerRow;
            for (int b = bytesPerRow - 1; b >= 0; b--)
            {
                byte v = raster[o + b];
                if (v == 0) continue;
                int bit = 7;
                while (((v >> (7 - bit)) & 1) == 0) bit--;
                int x = b * 8 + bit + 1;
                if (x > maxX) maxX = x;
                maxY = y + 1;
                break;
            }
        }
        return new int[] { maxX, maxY };
    }

    // null = الصفحة تحمل الصورة 1:1 بلا تحجيم ولا قص ولا هوامش؛ وإلا سبب الرفض.
    public static string CheckPage(int dpiX, int dpiY, int expectedDpi, int horzRes, int vertRes, int offsetX, int offsetY, int inkWidth, int inkHeight)
    {
        if (dpiX != expectedDpi || dpiY != expectedDpi) return "resolution " + dpiX + "x" + dpiY + " is not " + expectedDpi + "x" + expectedDpi + " dpi";
        if (offsetX != 0 || offsetY != 0) return "printable area starts at " + offsetX + "," + offsetY + " dots, not 0,0";
        if (inkWidth > horzRes) return "receipt ink is " + inkWidth + " dots wide but the page prints only " + horzRes;
        if (inkHeight > vertRes) return "receipt ink is " + inkHeight + " dots tall but the page prints only " + vertRes;
        return null;
    }

    // صورة 1bpp من الأعلى للأسفل: لوحة 0 = أبيض، 1 = أسود، فتبقى البتات نفسها بلا أي تحويل.
    public static byte[] MonochromeBitmapInfo(int widthDots, int rows)
    {
        byte[] info = new byte[40 + 8];
        BitConverter.GetBytes(40).CopyTo(info, 0);
        BitConverter.GetBytes(widthDots).CopyTo(info, 4);
        BitConverter.GetBytes(-rows).CopyTo(info, 8);
        BitConverter.GetBytes((short)1).CopyTo(info, 12);
        BitConverter.GetBytes((short)1).CopyTo(info, 14);
        BitConverter.GetBytes(((widthDots + 31) / 32) * 4 * rows).CopyTo(info, 20);
        BitConverter.GetBytes(2).CopyTo(info, 32);
        info[40] = 255; info[41] = 255; info[42] = 255; info[43] = 0;
        info[44] = 0; info[45] = 0; info[46] = 0; info[47] = 0;
        return info;
    }

    // للاختبار بلا طابعة: الاستدعاء نفسه (StretchDIBits بالترويسة نفسها 1:1) على صورة 1bpp في الذاكرة،
    // ثم تُقرأ البتات الناتجة. تطابقها مع المدخل يثبت أن الترويسة واللوحة والاتجاه لا تغيّر بتاً.
    public static byte[] RenderThroughGdi(byte[] raster, int bytesPerRow, int rows)
    {
        int widthDots = bytesPerRow * 8;
        if (bytesPerRow % 4 != 0 || raster == null || raster.Length != bytesPerRow * rows) throw new ArgumentException("Raster size does not match its rows.");
        byte[] info = MonochromeBitmapInfo(widthDots, rows);
        IntPtr hdc = CreateCompatibleDC(IntPtr.Zero);
        if (hdc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr bits;
        IntPtr dib = CreateDIBSection(hdc, info, DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
        if (dib == IntPtr.Zero) { DeleteDC(hdc); throw new Win32Exception(Marshal.GetLastWin32Error()); }
        IntPtr old = SelectObject(hdc, dib);
        try
        {
            int lines = StretchDIBits(hdc, 0, 0, widthDots, rows, 0, 0, widthDots, rows, raster, info, DIB_RGB_COLORS, SRCCOPY);
            if (lines != rows) throw new Win32Exception(Marshal.GetLastWin32Error(), "copied " + lines + " of " + rows + " rows");
            GdiFlush();
            byte[] result = new byte[raster.Length];
            Marshal.Copy(bits, result, 0, result.Length);
            return result;
        }
        finally
        {
            SelectObject(hdc, old);
            DeleteObject(dib);
            DeleteDC(hdc);
        }
    }

    private static string PortOf(IntPtr printer)
    {
        int needed;
        GetPrinter(printer, 2, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try
        {
            if (!GetPrinter(printer, 2, buffer, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(buffer, typeof(PRINTER_INFO_2));
            return info.pPortName;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static short FindPaper(string printerName, string port, string paperName)
    {
        int count = DeviceCapabilities(printerName, port, DC_PAPERNAMES, IntPtr.Zero, IntPtr.Zero);
        if (count <= 0) throw new InvalidOperationException("DeviceCapabilities failed for the paper list.");
        IntPtr names = Marshal.AllocHGlobal(count * 64 * 2);
        IntPtr ids = Marshal.AllocHGlobal(count * 2);
        try
        {
            if (DeviceCapabilities(printerName, port, DC_PAPERNAMES, names, IntPtr.Zero) != count ||
                DeviceCapabilities(printerName, port, DC_PAPERS, ids, IntPtr.Zero) != count)
                throw new InvalidOperationException("DeviceCapabilities failed for the paper list.");
            short found = 0; int matches = 0;
            for (int i = 0; i < count; i++)
            {
                string name = Marshal.PtrToStringUni(new IntPtr(names.ToInt64() + i * 128), 64);
                int nul = name.IndexOf('\0');
                if (nul >= 0) name = name.Substring(0, nul);
                if (name == paperName) { found = Marshal.ReadInt16(ids, i * 2); matches++; }
            }
            if (matches != 1) throw new InvalidOperationException("Driver paper not found or ambiguous: " + paperName);
            return found;
        }
        finally { Marshal.FreeHGlobal(names); Marshal.FreeHGlobal(ids); }
    }

    // يعيد رقم المهمة. كل استثناء قبل StartDoc = لا مهمة؛ بعده الرسالة تحمل "after job".
    public static int Print(string printerName, byte[] raster, int bytesPerRow, int rows, string paperName, int expectedDpi, string documentName)
    {
        int widthDots = bytesPerRow * 8;
        if (bytesPerRow % 4 != 0) throw new ArgumentException("Raster rows must be DWORD aligned.");
        int[] ink = InkExtent(raster, bytesPerRow, rows);
        IntPtr printer;
        if (!OpenPrinter(printerName, out printer, IntPtr.Zero)) throw new InvalidOperationException("OpenPrinter failed with Win32 error " + Marshal.GetLastWin32Error());
        IntPtr devMode = IntPtr.Zero;
        IntPtr hdc = IntPtr.Zero;
        try
        {
            string port = PortOf(printer);
            short paper = FindPaper(printerName, port, paperName);
            int size = DocumentProperties(IntPtr.Zero, printer, printerName, IntPtr.Zero, IntPtr.Zero, 0);
            if (size <= 0) throw new InvalidOperationException("DocumentProperties failed with Win32 error " + Marshal.GetLastWin32Error());
            devMode = Marshal.AllocHGlobal(size);
            if (DocumentProperties(IntPtr.Zero, printer, printerName, devMode, IntPtr.Zero, DM_OUT_BUFFER) < 0) throw new InvalidOperationException("DocumentProperties failed with Win32 error " + Marshal.GetLastWin32Error());
            // نسخة لهذه المهمة وحدها: الورق والاتجاه ونسخة واحدة. إعدادات الطابور نفسها لا تُمسّ.
            int fields = Marshal.ReadInt32(devMode, DEVMODE_FIELDS);
            fields = (fields | DM_ORIENTATION | DM_PAPERSIZE | DM_COPIES) & ~(DM_PAPERLENGTH | DM_PAPERWIDTH);
            Marshal.WriteInt32(devMode, DEVMODE_FIELDS, fields);
            Marshal.WriteInt16(devMode, DEVMODE_ORIENTATION, (short)1);
            Marshal.WriteInt16(devMode, DEVMODE_PAPERSIZE, paper);
            Marshal.WriteInt16(devMode, DEVMODE_COPIES, (short)1);
            if (DocumentProperties(IntPtr.Zero, printer, printerName, devMode, devMode, DM_IN_BUFFER | DM_OUT_BUFFER) < 0) throw new InvalidOperationException("DocumentProperties failed with Win32 error " + Marshal.GetLastWin32Error());
            if (Marshal.ReadInt16(devMode, DEVMODE_PAPERSIZE) != paper || Marshal.ReadInt16(devMode, DEVMODE_COPIES) != 1) throw new InvalidOperationException("Driver page refused: the driver did not accept paper " + paperName + " with one copy.");
            hdc = CreateDC("WINSPOOL", printerName, null, devMode);
            if (hdc == IntPtr.Zero) throw new InvalidOperationException("CreateDC failed with Win32 error " + Marshal.GetLastWin32Error());
            string refusal = CheckPage(GetDeviceCaps(hdc, LOGPIXELSX), GetDeviceCaps(hdc, LOGPIXELSY), expectedDpi, GetDeviceCaps(hdc, HORZRES), GetDeviceCaps(hdc, VERTRES),
                GetDeviceCaps(hdc, PHYSICALOFFSETX), GetDeviceCaps(hdc, PHYSICALOFFSETY), ink[0], ink[1]);
            if (refusal != null) throw new InvalidOperationException("Driver page refused: " + refusal);
            byte[] info = MonochromeBitmapInfo(widthDots, rows);
            DOCINFOW doc = new DOCINFOW { cbSize = Marshal.SizeOf(typeof(DOCINFOW)), lpszDocName = documentName, lpszOutput = null, lpszDatatype = null, fwType = 0 };
            int jobId = StartDoc(hdc, ref doc);
            if (jobId <= 0) throw new InvalidOperationException("StartDoc failed with Win32 error " + Marshal.GetLastWin32Error());
            string stage = "StartPage";
            try
            {
                if (StartPage(hdc) <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                stage = "StretchDIBits";
                int lines = StretchDIBits(hdc, 0, 0, widthDots, rows, 0, 0, widthDots, rows, raster, info, DIB_RGB_COLORS, SRCCOPY);
                if (lines != rows) throw new Win32Exception(Marshal.GetLastWin32Error(), "copied " + lines + " of " + rows + " rows");
                stage = "EndPage";
                if (EndPage(hdc) <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
                stage = "EndDoc";
                if (EndDoc(hdc) <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            catch (Exception error)
            {
                if (stage != "EndDoc") AbortDoc(hdc);
                throw new InvalidOperationException("Driver print failed after job " + jobId + " started (" + stage + "): " + error.Message, error);
            }
            return jobId;
        }
        finally
        {
            if (hdc != IntPtr.Zero) DeleteDC(hdc);
            if (devMode != IntPtr.Zero) Marshal.FreeHGlobal(devMode);
            ClosePrinter(printer);
        }
    }
}
"@
}

# اسم الورق في تعريف Xprinter XP-80 كما يعرضه (عرض طباعة 72 مم، طول 3276 مم). التعريف يقصّ الأبيض
# الزائد في آخر الصفحة، فالطول الكبير لا يهدر ورقاً (ثبت بالتقاط إلى ملف 2026-11-12). صورة أطول من
# مساحة الصفحة ⇒ رفض قبل المهمة، لا قص.
$script:ReceiptDriverPaperName = "80(72)mm x 3276mm"
$script:ReceiptDriverDocumentName = "OZK Cashier Receipt 80mm (driver)"

function Get-OzkReceiptTransport {
    $value = [string]$env:OZK_RECEIPT_TRANSPORT
    if ([string]::IsNullOrWhiteSpace($value) -or $value.Trim() -ieq "raw") { return "raw" }
    if ($value.Trim() -ieq "driver") { return "driver" }
    throw "Receipt transport not recognised: '$value' (expected raw or driver)."
}

# صفوف ESC/POS من مخرجات ToEscPosRaster كما هي (بلا تغيير بت): التهيئة، ثم حِزَم GS v 0 بعرض واحد، ثم القص.
function ConvertFrom-OzkEscPosRaster([byte[]]$Payload) {
    $prefix = [byte[]](0x1B, 0x40, 0x1D, 0x4C, 0x00, 0x00, 0x1D, 0x57, 0x40, 0x02)
    $suffix = [byte[]](0x1D, 0x56, 0x42, 0x00)
    if ($null -eq $Payload -or $Payload.Length -lt ($prefix.Length + 8 + $suffix.Length)) { throw "Receipt payload is too short to be a raster receipt." }
    for ($j = 0; $j -lt $prefix.Length; $j++) { if ($Payload[$j] -ne $prefix[$j]) { throw "Receipt payload does not start with the expected initialisation." } }
    for ($j = 0; $j -lt $suffix.Length; $j++) { if ($Payload[$Payload.Length - $suffix.Length + $j] -ne $suffix[$j]) { throw "Receipt payload does not end with the expected cut command." } }
    $end = $Payload.Length - $suffix.Length
    $stream = New-Object IO.MemoryStream
    $width = -1; $rows = 0; $i = $prefix.Length
    while ($i -lt $end) {
        if ($i + 8 -gt $end -or $Payload[$i] -ne 0x1D -or $Payload[$i + 1] -ne 0x76 -or $Payload[$i + 2] -ne 0x30 -or $Payload[$i + 3] -ne 0x00) {
            throw "Unexpected bytes at offset $i inside the raster section."
        }
        $w = [int]$Payload[$i + 4] + 256 * [int]$Payload[$i + 5]
        $h = [int]$Payload[$i + 6] + 256 * [int]$Payload[$i + 7]
        if ($w -le 0 -or $h -le 0) { throw "Empty raster block at offset $i." }
        if ($width -lt 0) { $width = $w } elseif ($w -ne $width) { throw "Raster blocks disagree on width." }
        if ($i + 8 + $w * $h -gt $end) { throw "Raster block at offset $i is truncated." }
        $stream.Write($Payload, $i + 8, $w * $h)
        $rows += $h
        $i += 8 + $w * $h
    }
    if ($rows -le 0) { throw "Receipt payload has no raster rows." }
    return [pscustomobject]@{ Raster = $stream.ToArray(); BytesPerRow = $width; Rows = $rows }
}

function Send-OzkReceiptViaDriver([byte[]]$Payload, [string]$PrinterName) {
    $image = ConvertFrom-OzkEscPosRaster $Payload
    return [OzkDriverReceiptPrinter]::Print($PrinterName, $image.Raster, $image.BytesPerRow, $image.Rows, $script:ReceiptDriverPaperName, $script:ReceiptDpi, $script:ReceiptDriverDocumentName)
}

$script:ReceiptWidth = 576
# كان اللوح ثابتاً 2600 نقطة فيُقصّ كل ما يُرسم تحته بصمت (فاتورة ~28 سطراً فأكثر تفقد إجماليها وتذييلها).
# اللوح الآن بارتفاع هذا الحدّ، والصورة تُقصّ إلى ارتفاع المحتوى الفعلي كما كانت؛ الرسم نفسه لم يتغيّر.
# 15000 نقطة ≈ 1.9 م ورق (~270 سطراً). محتوى أطول ⇒ رفض صريح، لا قصّ صامت.
$script:ReceiptMaxCanvasHeight = 15000
$script:ReceiptDpi = 203
$script:CashierPrinterName = "XPRINTER XP-T80Q 80MM"
$script:Invariant = [Globalization.CultureInfo]::InvariantCulture

# ── تقسيم صورة الإيصال إلى أوامر GS v 0 أصغر (بلا أي تغيير في البكسلات) ─────────
# GS v 0 m xL xH yL yH d1…dk، حيث k = (xL + xH×256) × (yL + yH×256) (مرجع Epson/Citizen ESC/POS).
# كان الإيصال يُرسل حِزَماً من 512 صفاً (36,864 بايتاً للأمر). مخزن استقبال XP-T80Q ‏64 KB (مواصفة
# البائع)، فحِزمتان متتاليتان (73,728 بايتاً) تتجاوزانه، والرموز العشوائية في حادثتَي 2992 و2999
# بدأت عند بداية الحِزمة الثالثة بالضبط. هنا تُعاد كتابة البايتات نفسها بأوامر أصغر:
# - نفس أمرَي التهيئة (ESC @، GS L، GS W) ونفس أمر القص (GS V 66 0) حرفياً.
# - نفس صفوف البيانات بالترتيب والبايت؛ الطابعة تتقدّم بعدد الصفوف المعلن فتتصل الحِزَم بلا فاصل.
# - لا بايتات صفرية ولا أوامر مزامنة إضافية.
# أي بنية غير متوقعة في المدخل ⇒ استثناء صريح، ولا إرسال.
$script:ReceiptBandRows = 128

function ConvertTo-OzkBandedRaster([byte[]]$Payload, [int]$BandRows) {
    if ($BandRows -lt 1 -or $BandRows -gt 2303) { throw "BandRows must be between 1 and 2303." }
    $prefix = [byte[]](0x1B, 0x40, 0x1D, 0x4C, 0x00, 0x00, 0x1D, 0x57, 0x40, 0x02)
    $suffix = [byte[]](0x1D, 0x56, 0x42, 0x00)
    if ($null -eq $Payload -or $Payload.Length -lt ($prefix.Length + 8 + $suffix.Length)) { throw "Receipt payload is too short to be a raster receipt." }
    for ($j = 0; $j -lt $prefix.Length; $j++) { if ($Payload[$j] -ne $prefix[$j]) { throw "Receipt payload does not start with the expected initialisation." } }
    for ($j = 0; $j -lt $suffix.Length; $j++) { if ($Payload[$Payload.Length - $suffix.Length + $j] -ne $suffix[$j]) { throw "Receipt payload does not end with the expected cut command." } }
    $end = $Payload.Length - $suffix.Length
    $width = -1
    $blocks = New-Object System.Collections.Generic.List[int[]]
    $rows = 0
    $i = $prefix.Length
    while ($i -lt $end) {
        if ($i + 8 -gt $end -or $Payload[$i] -ne 0x1D -or $Payload[$i + 1] -ne 0x76 -or $Payload[$i + 2] -ne 0x30 -or $Payload[$i + 3] -ne 0x00) {
            throw "Unexpected bytes at offset $i inside the raster section."
        }
        $w = [int]$Payload[$i + 4] + 256 * [int]$Payload[$i + 5]
        $h = [int]$Payload[$i + 6] + 256 * [int]$Payload[$i + 7]
        if ($w -le 0 -or $h -le 0) { throw "Empty raster block at offset $i." }
        if ($width -lt 0) { $width = $w } elseif ($w -ne $width) { throw "Raster blocks disagree on width." }
        $k = $w * $h
        if ($i + 8 + $k -gt $end) { throw "Raster block at offset $i is truncated." }
        $blocks.Add([int[]]@(($i + 8), $k))
        $rows += $h
        $i += 8 + $k
    }
    if ($rows -le 0) { throw "Receipt payload has no raster rows." }
    $raster = New-Object byte[] ($rows * $width)
    $at = 0
    foreach ($block in $blocks) { [Buffer]::BlockCopy($Payload, $block[0], $raster, $at, $block[1]); $at += $block[1] }
    $bandCount = [int][math]::Ceiling($rows / [double]$BandRows)
    $out = New-Object byte[] ($prefix.Length + $bandCount * 8 + $raster.Length + $suffix.Length)
    [Buffer]::BlockCopy($prefix, 0, $out, 0, $prefix.Length)
    $o = $prefix.Length
    $row = 0
    while ($row -lt $rows) {
        $n = [math]::Min($BandRows, $rows - $row)
        $out[$o] = 0x1D; $out[$o + 1] = 0x76; $out[$o + 2] = 0x30; $out[$o + 3] = 0x00
        $out[$o + 4] = [byte]($width -band 0xFF); $out[$o + 5] = [byte]($width -shr 8)
        $out[$o + 6] = [byte]($n -band 0xFF); $out[$o + 7] = [byte]($n -shr 8)
        [Buffer]::BlockCopy($raster, $row * $width, $out, $o + 8, $n * $width)
        $o += 8 + $n * $width
        $row += $n
    }
    [Buffer]::BlockCopy($suffix, 0, $out, $o, $suffix.Length)
    return ,$out
}

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

function Draw-OzkFittedNumber($Graphics, [string]$Text, $Font, [float]$X, [float]$Y, [float]$Width, [float]$Height) {
    # الأرقام لا يجوز أن تلتف على سطرين. العمود موسَّع ليسع المبالغ الواقعية،
    # وهذا حارس أخير: إن طال الرقم أكثر من العمود نصغّر خط هذه الخانة وحدها
    # درجةً درجة، دون المساس بخطوط بقية الفاتورة.
    $format = New-OzkTextFormat "Center" $false
    try {
        $probe = New-Object Drawing.SizeF([float]10000, $Height)
        if ($Graphics.MeasureString($Text, $Font, $probe, $format).Width -le $Width) {
            $Graphics.DrawString($Text, $Font, [Drawing.Brushes]::Black, (New-Object Drawing.RectangleF($X, $Y, $Width, $Height)), $format)
            return
        }
        $emSize = [float]$Font.Size
        while ($emSize -gt 12) {
            $emSize -= 1
            $candidate = New-Object Drawing.Font($Font.FontFamily, $emSize, $Font.Style, [Drawing.GraphicsUnit]::Pixel)
            try {
                if ($Graphics.MeasureString($Text, $candidate, $probe, $format).Width -le $Width) {
                    $Graphics.DrawString($Text, $candidate, [Drawing.Brushes]::Black, (New-Object Drawing.RectangleF($X, $Y, $Width, $Height)), $format)
                    return
                }
            } finally { $candidate.Dispose() }
        }
        $Graphics.DrawString($Text, $Font, [Drawing.Brushes]::Black, (New-Object Drawing.RectangleF($X, $Y, $Width, $Height)), $format)
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
    $canvasHeight = $script:ReceiptMaxCanvasHeight
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
        Draw-OzkText $graphics "الإجمالي" $tableBoldFont 20 $y 140 45 "Center" $true
        Draw-OzkText $graphics "سعر الفردي" $tableBoldFont 160 $y 140 45 "Center" $true
        Draw-OzkText $graphics "الكمية" $tableBoldFont 300 $y 68 45 "Center" $true
        Draw-OzkText $graphics "اسم المادة" $tableBoldFont 368 $y 188 45 "Center" $true
        $y += 49

        foreach ($line in @($Receipt.Lines)) {
            $rowHeight = [math]::Max(54, (Get-OzkLineHeight $graphics ([string]$line.Name) $tableNameFont 183))
            Draw-OzkFittedNumber $graphics (Format-OzkAmount $line.Total) $tableNumberFont 20 $y 140 $rowHeight
            Draw-OzkFittedNumber $graphics (Format-OzkAmount $line.UnitPrice) $tableNumberFont 160 $y 140 $rowHeight
            Draw-OzkFittedNumber $graphics (Format-OzkQuantity $line.Quantity) $tableNumberFont 300 $y 68 $rowHeight
            Draw-OzkText $graphics ([string]$line.Name) $tableNameFont 373 $y 183 $rowHeight "Right" $true
            $y += $rowHeight
            Draw-OzkDashedLine $graphics $y 20 556 ([Drawing.Color]::Gray)
            $y += 2
        }

        $graphics.DrawLine([Drawing.Pens]::Black, 20, $y + 2, 556, $y + 2)
        $y += 6
        # «الإضافات» — تسمية حقل الأمين نفسه: bu000.TotalExtra = Σ bi000.TotalExtraPercent.
        # لا يُحتسب هنا شيء: هذا هو الفارق القائم أصلاً بين صافي الأمين ومجموع البنود
        # بعد الحسم، ويُعرض حتى يطابق الإيصال فاتورة الأمين سطراً بسطر.
        # NetTotal لا يُمسّ، ولا يظهر السطر عندما تكون القيمة صفراً.
        $extraValue = if ($Receipt.PSObject.Properties["Extra"]) { [double]$Receipt.Extra }
                      else { [double]$Receipt.NetTotal - ([double]$Receipt.GrossTotal - [double]$Receipt.Discount) }
        $totals = @(
            @{ Label = "الإجمالي:"; Value = $Receipt.GrossTotal; Net = $false },
            @{ Label = "الخصومات:"; Value = $Receipt.Discount; Net = $false }
        )
        if ([math]::Abs($extraValue) -ge 0.005) {
            $totals += @{ Label = "الإضافات:"; Value = $extraValue; Net = $false }
        }
        $totals += @{ Label = "صافي الفاتورة:"; Value = $Receipt.NetTotal; Net = $true }
        $totals += @{ Label = "الدفعة:"; Value = $Receipt.Payment; Net = $false }
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

        if ([math]::Ceiling($y) -gt $canvasHeight) {
            throw (New-Object InvalidOperationException(("Receipt layout needs {0} px which exceeds the {1} px safety limit; refusing to print a truncated receipt." -f [math]::Ceiling($y), $canvasHeight)))
        }
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

# Runs before any job exists, so every failure here means nothing was printed.
function Assert-OzkPrinterQueueReady([string]$PrinterName) {
    try { $queue = [OzkThermalPrinterQueue]::Info($PrinterName) }
    catch {
        $inner = $_.Exception
        while ($null -ne $inner.InnerException) { $inner = $inner.InnerException }
        if ($inner -is [ComponentModel.Win32Exception] -and $inner.NativeErrorCode -eq 1801) { throw "Printer queue not found or ambiguous: $PrinterName" }
        throw ("OpenPrinter failed for {0}: {1}" -f $PrinterName, $inner.Message)
    }
    if ([string]$queue[0] -ne $PrinterName) { throw "Printer queue not found or ambiguous: $PrinterName" }
    $status = [uint32]$queue[1]
    if (($status -band $script:PrinterBlockingStatusMask) -ne 0) {
        throw ("Printer queue not ready: {0} (status 0x{1:X})" -f $PrinterName, $status)
    }
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
    $transport = Get-OzkReceiptTransport
    Assert-OzkPrinterQueueReady $PrinterName
    $bitmap = New-OzkReceiptBitmap -Receipt $Receipt -LogoPath $LogoPath
    try {
        if ($transport -eq "driver") {
            $jobId = Send-OzkReceiptViaDriver ([OzkRawThermalPrinter]::ToEscPosRaster($bitmap, 190)) $PrinterName
        } else {
            $payload = ConvertTo-OzkBandedRaster ([OzkRawThermalPrinter]::ToEscPosRaster($bitmap, 190)) $script:ReceiptBandRows
            $jobId = [OzkRawThermalPrinter]::Send($PrinterName, $payload, "OZK Cashier Receipt 80mm")
        }
    } finally {
        $bitmap.Dispose()
    }
    if ($transport -eq "driver") {
        # سطر تتحقق منه أداة إعادة الطباعة أن المسار المطلوب هو الذي نُفّذ فعلاً.
        Write-Host ("OzkReceiptTransport: driver (job {0})" -f $jobId)
        return [pscustomobject]@{ Submitted = $true; PrinterName = $PrinterName; JobId = $jobId; Transport = "Windows driver (GDI)"; SubmittedAt = (Get-Date).ToString("o") }
    }
    return [pscustomobject]@{ Submitted = $true; PrinterName = $PrinterName; JobId = $jobId; Transport = "RAW ESC/POS"; SubmittedAt = (Get-Date).ToString("o") }
}

Export-ModuleMember -Function New-OzkReceiptBitmap, Save-OzkReceiptPreview, Send-OzkReceiptToPrinter
