# مقارنة مخرجات تعريف الطابعة (ملف PRN) بصورة الإيصال المصدر — للاختبارات وحدها، بلا طباعة.
#
# معيار النجاح (Compare-OzkDriverOutput): محاذاة موثقة واحدة بلا بحث — الإزاحة الرأسية = أول صف حبر في
# المخرجات − أول صف حبر في المصدر، ولا إزاحة أفقية إطلاقاً. ثم:
#   - كل صف بعرض المصدر نفسه (72 بايتاً = 576 نقطة): لا تحجيم أفقي.
#   - صفر نقاط مفقودة (أسود في المصدر، أبيض في المخرجات) وصفر نقاط زائدة، في كل الصفوف بما فيها
#     ما يقع خارج نطاق المصدر.
#   - عدد نقاط الحبر متساوٍ وغير صفري، وارتفاع الحبر (أول صف إلى آخر صف) متساوٍ: لا قص ولا تحجيم رأسي.
# إن سقط أول صف حبر من المخرجات تختلّ المحاذاة الموثقة فيفشل الحكم حتماً. البحث عن أفضل محاذاة
# (Best*) للتشخيص فقط، ولا يدخل في الحكم.
Set-StrictMode -Version 2.0

$script:Pop = New-Object int[] 256
for ($i = 0; $i -lt 256; $i++) { $c = 0; $v = $i; while ($v) { $c += $v -band 1; $v = $v -shr 1 }; $script:Pop[$i] = $c }

function Split-OzkRasterRows([byte[]]$Raster, [int]$BytesPerRow = 72) {
    if ($null -eq $Raster -or $BytesPerRow -le 0 -or ($Raster.Length % $BytesPerRow) -ne 0) { throw "Raster size is not a whole number of rows." }
    $rows = New-Object System.Collections.Generic.List[byte[]]
    for ($o = 0; $o -lt $Raster.Length; $o += $BytesPerRow) { $r = New-Object byte[] $BytesPerRow; [Buffer]::BlockCopy($Raster, $o, $r, 0, $BytesPerRow); $rows.Add($r) }
    return ,$rows
}

# أوامر GS v 0 في ملف التعريف بالترتيب؛ الباقي يُعدّ فقط ولا يُفسَّر.
function Read-OzkDriverPrn([byte[]]$Bytes) {
    $rows = New-Object System.Collections.Generic.List[byte[]]
    $bands = New-Object System.Collections.Generic.List[int]
    $other = @{}; $width = -1; $i = 0
    while ($i -lt $Bytes.Length) {
        if ($Bytes[$i] -eq 0x1D -and $i + 7 -lt $Bytes.Length -and $Bytes[$i + 1] -eq 0x76 -and $Bytes[$i + 2] -eq 0x30) {
            $w = [int]$Bytes[$i + 4] + 256 * [int]$Bytes[$i + 5]; $h = [int]$Bytes[$i + 6] + 256 * [int]$Bytes[$i + 7]
            if ($width -lt 0) { $width = $w } elseif ($w -ne $width) { $width = -2 }
            if ($i + 8 + $w * $h -gt $Bytes.Length) { throw "PRN raster block at offset $i is truncated." }
            for ($y = 0; $y -lt $h; $y++) { $r = New-Object byte[] $w; [Buffer]::BlockCopy($Bytes, $i + 8 + $y * $w, $r, 0, $w); $rows.Add($r) }
            $bands.Add($h); $i += 8 + $w * $h; continue
        }
        if (($Bytes[$i] -eq 0x1B -or $Bytes[$i] -eq 0x1D) -and $i + 1 -lt $Bytes.Length) { $k = "{0:X2} {1:X2}" -f $Bytes[$i], $Bytes[$i + 1]; $other[$k] = 1 + [int]$other[$k] }
        $i++
    }
    return [pscustomobject]@{ Rows = $rows; Bands = $bands; Width = $width; Other = $other }
}

function Get-OzkRowInk([byte[]]$Row) { $n = 0; foreach ($b in $Row) { $n += $script:Pop[$b] }; return $n }
function Test-OzkRowBlank([byte[]]$Row) { foreach ($b in $Row) { if ($b -ne 0) { return $false } }; return $true }
function Get-OzkInkSpan($Rows) {
    $first = -1; $last = -1
    for ($y = 0; $y -lt $Rows.Count; $y++) { if (-not (Test-OzkRowBlank $Rows[$y])) { if ($first -lt 0) { $first = $y }; $last = $y } }
    return @($first, $last)
}

# نموذج سلوك تعريف Xprinter XP-80 المستنتج من ثلاث التقاطات حقيقية (تطابقها بالبايت، والاختبار يعيد التحقق):
# يحذف الصفوف البيضاء أعلى الصفحة ومعها أول صف فيه حبر، ويقصّ الأبيض أسفلها، ولا يمسّ ما بينهما.
function Invoke-OzkXprinterDriverModel($Rows) {
    $span = Get-OzkInkSpan $Rows
    $out = New-Object System.Collections.Generic.List[byte[]]
    if ($span[0] -lt 0) { return ,$out }
    for ($y = $span[0] + 1; $y -le $span[1]; $y++) { $out.Add($Rows[$y]) }
    return ,$out
}

function Compare-OzkDriverOutput($SourceRows, $DriverRows, [int]$BytesPerRow = 72, [int]$SearchRange = 40) {
    $r = [ordered]@{ Pass = $false; Reason = ""; SourceInk = 0; DriverInk = 0; MissingDots = -1; ExtraDots = -1; Dy = $null
        SourceFirstInk = -1; SourceLastInk = -1; DriverFirstInk = -1; DriverLastInk = -1; FirstMissingRow = -1
        BestDy = $null; BestMissingDots = -1; BestExtraDots = -1; BestFirstMissingRow = -1 }
    foreach ($row in $SourceRows) { if ($row.Length -ne $BytesPerRow) { $r.Reason = "source row width"; return [pscustomobject]$r } }
    foreach ($row in $DriverRows) { if ($row.Length -ne $BytesPerRow) { $r.Reason = "driver row width $($row.Length) bytes, expected $BytesPerRow (scaling)"; return [pscustomobject]$r } }
    foreach ($row in $SourceRows) { $r.SourceInk += Get-OzkRowInk $row }
    foreach ($row in $DriverRows) { $r.DriverInk += Get-OzkRowInk $row }
    $s = Get-OzkInkSpan $SourceRows; $d = Get-OzkInkSpan $DriverRows
    $r.SourceFirstInk = $s[0]; $r.SourceLastInk = $s[1]; $r.DriverFirstInk = $d[0]; $r.DriverLastInk = $d[1]
    if ($r.SourceInk -eq 0) { $r.Reason = "source has no ink (nothing to compare)"; return [pscustomobject]$r }
    if ($r.DriverInk -eq 0) { $r.Reason = "driver output has no ink"; return [pscustomobject]$r }
    $srcKeys = @($SourceRows | ForEach-Object { [Convert]::ToBase64String($_) })
    $drvKeys = @($DriverRows | ForEach-Object { [Convert]::ToBase64String($_) })
    $blankKey = [Convert]::ToBase64String((New-Object byte[] $BytesPerRow))

    $measure = {
        param([int]$Dy)
        $missing = 0; $extra = 0; $firstMissing = -1
        for ($y = 0; $y -lt $srcKeys.Count; $y++) {
            $yy = $y + $Dy
            $dk = if ($yy -ge 0 -and $yy -lt $drvKeys.Count) { $drvKeys[$yy] } else { $blankKey }
            if ($srcKeys[$y] -eq $dk) { continue }
            $sr = $SourceRows[$y]
            $dr = if ($yy -ge 0 -and $yy -lt $drvKeys.Count) { $DriverRows[$yy] } else { New-Object byte[] $BytesPerRow }
            for ($x = 0; $x -lt $BytesPerRow; $x++) {
                $m = $script:Pop[($sr[$x] -band (-bnot $dr[$x])) -band 0xFF]; $e = $script:Pop[($dr[$x] -band (-bnot $sr[$x])) -band 0xFF]
                if ($m -and $firstMissing -lt 0) { $firstMissing = $y }
                $missing += $m; $extra += $e
            }
        }
        for ($yy = 0; $yy -lt $drvKeys.Count; $yy++) {
            $y = $yy - $Dy
            if (($y -lt 0 -or $y -ge $srcKeys.Count) -and $drvKeys[$yy] -ne $blankKey) { $extra += Get-OzkRowInk $DriverRows[$yy] }
        }
        return @($missing, $extra, $firstMissing)
    }

    # الحكم: المحاذاة الموثقة وحدها.
    $r.Dy = $d[0] - $s[0]
    $m = & $measure $r.Dy
    $r.MissingDots = $m[0]; $r.ExtraDots = $m[1]; $r.FirstMissingRow = $m[2]
    # تشخيص فقط: أقل صفوف مختلفة ضمن مدى محدود.
    $best = $null
    for ($dy = $r.Dy - $SearchRange; $dy -le $r.Dy + $SearchRange; $dy++) {
        $diff = 0
        for ($y = 0; $y -lt $srcKeys.Count; $y++) { $yy = $y + $dy; $dk = if ($yy -ge 0 -and $yy -lt $drvKeys.Count) { $drvKeys[$yy] } else { $blankKey }; if ($srcKeys[$y] -ne $dk) { $diff++ } }
        if ($null -eq $best -or $diff -lt $best[0]) { $best = @($diff, $dy) }
    }
    $bm = & $measure $best[1]
    $r.BestDy = $best[1]; $r.BestMissingDots = $bm[0]; $r.BestExtraDots = $bm[1]; $r.BestFirstMissingRow = $bm[2]

    $heightSame = (($s[1] - $s[0]) -eq ($d[1] - $d[0]))
    if ($r.MissingDots -ne 0) { $r.Reason = "$($r.MissingDots) source dots missing (first at source row $($r.FirstMissingRow))" }
    elseif ($r.ExtraDots -ne 0) { $r.Reason = "$($r.ExtraDots) extra dots not in the source" }
    elseif (-not $heightSame) { $r.Reason = "ink height differs" }
    elseif ($r.SourceInk -ne $r.DriverInk) { $r.Reason = "ink totals differ" }
    else { $r.Pass = $true; $r.Reason = "identical" }
    return [pscustomobject]$r
}

# ── تنظيف منفذ الالتقاط المؤقت ──────────────────────────────────────────────────
# حذف المنفذ مباشرة بعد حذف الطابور قد يُرفض لأن Spooler لم يحرّره بعد ("port in use")، وكان
# الخطأ يُخفى. هنا: حراسة قبل أي حذف، ثم محاولات محدودة، وتحقق من الاختفاء بعد كل حذف، وكل خطأ يُعاد.
# الحراسة (أي خرق ⇒ رفض بلا أي محاولة حذف):
#   - الاسم مسار ملف .prn داخل مجلد الالتقاط المحدد، لا يبدأ باسم منفذ فعلي (USB/LPT/COM/…).
#   - ليس ضمن المنافذ المحمية (منفذ طابور الكاشير وUSB003 دائماً).
#   - مراقبه Local Monitor.
# قبل كل محاولة: المنفذ غير مستعمل من أي طابور؛ إن كان مستعملاً تُنتظر المهلة ولا يُحذف.
# الاعتماديات قابلة للاستبدال كي تُختبر سيناريوهات التأخير والفشل بلا Spooler.
function Remove-OzkCapturePort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PortName,
        [Parameter(Mandatory = $true)][string]$CaptureRoot,
        [string[]]$ProtectedPorts = @(),
        [ValidateRange(1, 20)][int]$MaxAttempts = 6,
        [ValidateRange(0, 60)][int]$DelaySeconds = 5,
        [scriptblock]$GetPort = { param($n) Get-PrinterPort -Name $n -ErrorAction SilentlyContinue },
        [scriptblock]$GetPortUsers = { param($n) @(Get-Printer | Where-Object PortName -eq $n | ForEach-Object Name) },
        [scriptblock]$RemovePort = { param($n) Remove-PrinterPort -Name $n -ErrorAction Stop },
        [scriptblock]$Sleep = { param($s) Start-Sleep -Seconds $s }
    )
    $result = [ordered]@{ Removed = $false; Refused = ""; Attempts = 0; Errors = New-Object System.Collections.Generic.List[string] }
    $protected = @($ProtectedPorts + "USB003" | Where-Object { $_ } | ForEach-Object { $_.Trim() })
    $root = [IO.Path]::GetFullPath($CaptureRoot.TrimEnd('\', '/')) + [IO.Path]::DirectorySeparatorChar
    $full = ""
    try { $full = [IO.Path]::GetFullPath($PortName) } catch { $full = "" }
    if ($PortName -match '^(USB|LPT|COM|DOT4|WSD|IP_|TS|FILE:|PORTPROMPT|nul)') { $result.Refused = "port name looks physical or system: $PortName" }
    elseif ($protected | Where-Object { $_ -ieq $PortName }) { $result.Refused = "port is protected (cashier queue): $PortName" }
    elseif (-not $full -or -not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($full) -ine ".prn") { $result.Refused = "port is not a .prn file inside the capture folder: $PortName" }
    if ($result.Refused) { return [pscustomobject]$result }
    $port = & $GetPort $PortName
    if ($null -eq $port) { $result.Removed = $true; return [pscustomobject]$result }
    if ([string]$port.PortMonitor -notmatch 'Local') { $result.Refused = "port monitor is '$($port.PortMonitor)', not Local Monitor"; return [pscustomobject]$result }
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        $result.Attempts = $i
        $users = @(& $GetPortUsers $PortName | Where-Object { $_ })
        if ($users.Count -gt 0) {
            $result.Errors.Add("attempt ${i}: still used by queue(s) $($users -join ', '); not removed")
        } else {
            try { & $RemovePort $PortName } catch { $result.Errors.Add("attempt ${i}: $($_.Exception.Message)") }
            if ($null -eq (& $GetPort $PortName)) { $result.Removed = $true; break }
            if ($result.Errors.Count -lt $i) { $result.Errors.Add("attempt ${i}: removal reported success but the port is still present") }
        }
        if ($i -lt $MaxAttempts) { & $Sleep $DelaySeconds }
    }
    return [pscustomobject]$result
}

Export-ModuleMember -Function Split-OzkRasterRows, Read-OzkDriverPrn, Get-OzkRowInk, Get-OzkInkSpan, Invoke-OzkXprinterDriverModel, Compare-OzkDriverOutput, Remove-OzkCapturePort
