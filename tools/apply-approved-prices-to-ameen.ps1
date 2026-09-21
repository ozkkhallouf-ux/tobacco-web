# ============================================================
# apply-approved-prices-to-ameen.ps1
# يطبّق الأسعار من CSV على قاعدة بيانات الأمين (mt000)
# - أسعار الجملة (دولار) → قائمة "جملة الجملة"
# - أسعار المفرق (دولار) → قائمة "كروزات مركز"
# المطابقة باسم المادة (mt000.Name)، والربط عبر
# MaterialPriceListItem000 (MaterialGUID + ParentGUID).
# ============================================================

param(
    [string]$CsvFile = "$PSScriptRoot\..\reports\prices\tobacco-approved-prices.csv",
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$LogFile = "$PSScriptRoot\logs\approved-prices-sync.log"
)

# قراءة الإعدادات
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

$connStr = $env:AMEEN_SQL_WRITE_CONNECTION_STRING
if (-not $connStr) {
    Write-Host "خطأ: AMEEN_SQL_WRITE_CONNECTION_STRING غير موجود في .env" -ForegroundColor Red
    Write-Host "أضف هذا السطر في tools\.env:" -ForegroundColor Yellow
    Write-Host "AMEEN_SQL_WRITE_CONNECTION_STRING=Server=localhost;Database=mt000;User Id=sa;Password=YOUR_PASSWORD;" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $CsvFile)) {
    Write-Host "ملف CSV غير موجود: $CsvFile" -ForegroundColor Red
    exit 1
}

# قوائم الأسعار (من تقرير الاستكشاف 2026-06-10) — يمكن تجاوزها من .env
$jumlaListGuid = $env:AMEEN_JUMLA_PRICELIST_GUID
if (-not $jumlaListGuid) { $jumlaListGuid = "41459845-f84b-4146-b3ec-8299b400792e" }   # جملة الجملة
$retailListGuid = $env:AMEEN_RETAIL_PRICELIST_GUID
if (-not $retailListGuid) { $retailListGuid = "938cd3b0-75fd-4533-bad8-0fe42e6f7215" } # كروزات مركز

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "[$timestamp] تطبيق الأسعار على الأمين..." -ForegroundColor Cyan

function Resolve-AmeenItemName($ItemName) {
    $trimmed = ([string]$ItemName).Trim()
    switch ($trimmed) {
        "كابتن بلاك كوين ازرق" { return "كابتن بلاك كور ازرق جديد" }
        "كابتن بلاك كوين اسود" { return "كابتن بلاك كور اسود جديد" }
        default { return $trimmed }
    }
}

# ---------------------------------------------------------------------------
# A-lite — الدفاع الثاني لهوية السعر (الأول في src/price-guid-conflict.js).
#
# يجمّع صفوف الـCSV حسب **بطاقة الأمين** لا حسب الاسم. سبب حلّ الهوية من
# mt000 بدل الـCSV: النافذة approved_price_sync_feed لا تكشف item_guid بعد،
# فلا سبيل لحمله في الملف اليوم. المطابقة هنا مطابقة الكاتب نفسها حرفياً
# (LTRIM/RTRIM تحت ترتيب Arabic_CI_AI) — فما يراه الحارس هو ما سيكتبه الكاتب.
#
# القاعدة (قرار المالك): تعارض ⟺ حقل مُدار واحد يحمل أكثر من قيمة موجبة
# مميّزة داخل صفوف نفس البطاقة. القيمة 0 = «غير مسعّر» ولا تعارض قيمة موجبة.
# لا ترجيح بـ updated_at ولا بالاسم ولا بالأعلى ولا بالأحدث.
# ---------------------------------------------------------------------------
function Get-AmeenGuidByName($conn, $names) {
    $map = @{}
    $list = @($names | Where-Object { $_ })
    if ($list.Count -eq 0) { return $map }
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 60
    $placeholders = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $list.Count; $i++) {
        $placeholders.Add("(@n$i)")
        [void]$cmd.Parameters.AddWithValue("@n$i", [string]$list[$i])
    }
    $cmd.CommandText = "SELECT v.n AS src_name, LOWER(CAST(m.GUID AS varchar(36))) AS guid FROM (VALUES $($placeholders -join ',')) AS v(n) JOIN dbo.mt000 m ON LTRIM(RTRIM(m.Name)) = LTRIM(RTRIM(v.n));"
    $reader = $cmd.ExecuteReader()
    try {
        while ($reader.Read()) { $map[[string]$reader.GetValue(0)] = [string]$reader.GetValue(1) }
    } finally { $reader.Close() }
    return $map
}

# يعيد مجموعة معرّفات البطاقات المتعارضة. صفر كتابة لكل معرّف فيها.
function Find-ConflictingGuids($rows, $guidByName, $toNum) {
    $conflicts = New-Object System.Collections.Generic.HashSet[string]
    $byGuid = @{}
    foreach ($row in $rows) {
        $resolved = Resolve-AmeenItemName $row.item_name
        $guid = $guidByName[$resolved]
        if (-not $guid) { continue }   # بلا بطاقة مطابقة: يلتقطه عدّاد not-in-ameen
        if (-not $byGuid.ContainsKey($guid)) { $byGuid[$guid] = New-Object System.Collections.Generic.List[object] }
        $byGuid[$guid].Add($row)
    }
    foreach ($guid in $byGuid.Keys) {
        $group = $byGuid[$guid]
        if ($group.Count -lt 2) { continue }   # صف واحد لا يعارض نفسه
        foreach ($field in @("unit2_price", "sale_price", "retail_carton_usd")) {
            $positives = @(
                $group | ForEach-Object {
                    if ($_.PSObject.Properties[$field]) { [math]::Round((& $toNum $_.$field), 4) } else { 0.0 }
                } | Where-Object { $_ -gt 0 } | Sort-Object -Unique
            )
            if ($positives.Count -gt 1) { [void]$conflicts.Add($guid); break }
        }
    }
    # الفاصلة الأحادية إلزامية: PowerShell يفكّك أي IEnumerable عند الإرجاع، فمجموعة
    # فارغة — وهي الحالة المستقرة المقصودة — كانت تعود $null فيرمي .Contains() ويُجهض
    # التطبيق بصفر تحديث. وبعنصر واحد كانت تنهار إلى [string] فتصير .Contains() مطابقةً
    # نصّية جزئية لا عضوية مجموعة (أسوأ: حجب صامت لبطاقة أخرى). أُثبت الأمران بـpwsh.
    # (Codex P1 على PR #256.)
    return ,$conflicts
}

# يحدّث سعر مادة في قائمة أسعار؛ وإن لم يكن لها سطر في القائمة يضيفه.
# يرجع عدد أسطر المادة في القائمة بعد التطبيق (0 = المادة غير موجودة في mt000).
function Apply-ListPrice($conn, $listGuid, $itemName, $unit1Price, $unit2Price) {
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = @"
UPDATE i SET i.Unit1Price = @Unit1Price, i.Unit2Price = @Unit2Price
FROM MaterialPriceListItem000 i
JOIN mt000 m ON m.GUID = i.MaterialGUID
WHERE i.ParentGUID = @ListGuid AND LTRIM(RTRIM(m.Name)) = LTRIM(RTRIM(@ItemName));
INSERT INTO MaterialPriceListItem000 (Number, GUID, MaterialGUID, Unit1Price, Unit2Price, Unit3Price, ParentGUID)
SELECT (SELECT ISNULL(MAX(Number), 0) + 1 FROM MaterialPriceListItem000),
       NEWID(), m.GUID, @Unit1Price, @Unit2Price, 0, @ListGuid
FROM mt000 m
WHERE LTRIM(RTRIM(m.Name)) = LTRIM(RTRIM(@ItemName))
  AND NOT EXISTS (
      SELECT 1 FROM MaterialPriceListItem000 x
      WHERE x.ParentGUID = @ListGuid AND x.MaterialGUID = m.GUID
  );
SELECT COUNT(*) FROM MaterialPriceListItem000 i
JOIN mt000 m ON m.GUID = i.MaterialGUID
WHERE i.ParentGUID = @ListGuid AND LTRIM(RTRIM(m.Name)) = LTRIM(RTRIM(@ItemName));
"@
    $cmd.Parameters.AddWithValue("@Unit1Price", [double]$unit1Price) | Out-Null
    $cmd.Parameters.AddWithValue("@Unit2Price", [double]$unit2Price) | Out-Null
    $cmd.Parameters.AddWithValue("@ListGuid", $listGuid) | Out-Null
    $cmd.Parameters.AddWithValue("@ItemName", $itemName) | Out-Null
    return [int]$cmd.ExecuteScalar()
}

try {
    $prices = Import-Csv -Path $CsvFile -Encoding UTF8
    $sourceCount = $prices.Count
    # الصفوف الخام قبل أي دمج: الدمج أدناه يجمّع بالاسم، والاسمان المتعارضان
    # متطابقان نصّياً — فلو فُحص التعارض بعده لاختفى أحد الطرفين ولما ظهر أبداً.
    $rawPrices = @($prices)
    $arabicCulture = [Globalization.CultureInfo]::GetCultureInfo("ar-SY")
    # سعر الجملة الصفري معناه «غير مسعّر» لا «سعره صفر». لذلك صفٌّ أحدث بسعر صفر
    # لا يحجب سعراً حقيقياً أقدم للمادة نفسها (يحدث مع مفاتيح مكررة بعد التطبيع).
    # نأخذ هوية الصف الأحدث، ونأخذ كل سعر من أحدث صفٍّ يحمل قيمة موجبة له.
    $toNum = {
        param($v)
        $d = 0.0
        if ([double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { $d } else { 0.0 }
    }
    $prices = @($prices | Group-Object { Resolve-AmeenItemName $_.item_name } | ForEach-Object {
        $ordered = @($_.Group | Sort-Object {
            try { [datetime]::Parse([string]$_.updated_at, $arabicCulture) }
            catch { [datetime]::MinValue }
        } -Descending)
        $row = $ordered[0].PSObject.Copy()

        $jumlaSource = $ordered | Where-Object { (& $toNum $_.unit2_price) -gt 0 } | Select-Object -First 1
        if ($jumlaSource) {
            $row.unit2_price = $jumlaSource.unit2_price
            $row.sale_price  = $jumlaSource.sale_price
            if ($row.PSObject.Properties["unit1_price"]) { $row.unit1_price = $jumlaSource.unit1_price }
        }

        $retailSource = $ordered | Where-Object {
            $_.PSObject.Properties["retail_carton_usd"] -and (& $toNum $_.retail_carton_usd) -gt 0
        } | Select-Object -First 1
        if ($retailSource -and $row.PSObject.Properties["retail_carton_usd"]) {
            $row.retail_carton_usd = $retailSource.retail_carton_usd
            if ($row.PSObject.Properties["retail_unit1_usd"]) { $row.retail_unit1_usd = $retailSource.retail_unit1_usd }
        }

        $row
    })
    Write-Host "تم قراءة $sourceCount سجل من CSV واعتماد أحدث سعر لـ $($prices.Count) مادة" -ForegroundColor Green

    # الاتصال بقاعدة بيانات الأمين
    Add-Type -AssemblyName "System.Data"
    $conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
    $conn.Open()

    # A-lite: يُحسب قبل الحلقة وعلى الصفوف الخام. الهوية من بطاقة الأمين نفسها.
    $distinctNames = @($rawPrices | ForEach-Object { Resolve-AmeenItemName $_.item_name } | Where-Object { $_ } | Sort-Object -Unique)
    $guidByName = Get-AmeenGuidByName $conn $distinctNames
    $conflictGuids = Find-ConflictingGuids $rawPrices $guidByName $toNum
    if ($conflictGuids.Count -gt 0) {
        Write-Host "تعارض هوية سعر على $($conflictGuids.Count) بطاقة — لن تُكتب أسعارها إطلاقاً:" -ForegroundColor Red
    }

    $jumlaApplied = 0
    $retailApplied = 0
    $skipped = 0
    $conflicted = 0
    $conflictNames = @()
    $notFound = @()

    foreach ($price in $prices) {
        $itemName = $price.item_name
        if (-not $itemName) { $skipped++; continue }
        $ameenItemName = Resolve-AmeenItemName $itemName

        # صفر كتابة لبطاقة متعارضة — في القائمتين معاً. لا اختيار ولا ترجيح.
        # بقية المواد السليمة تستمر طبيعياً بلا تأثر.
        $itemGuid = $guidByName[$ameenItemName]
        if ($itemGuid -and $conflictGuids.Contains($itemGuid)) {
            $conflicted++
            $conflictNames += $ameenItemName
            Write-Host "  ⛔ $ameenItemName — تعارض سعر على البطاقة نفسها، لم يُكتب شيء" -ForegroundColor Red
            continue
        }

        $jumlaCarton = 0.0; $jumlaUnit1 = 0.0
        if ($price.unit2_price) { $jumlaCarton = [double]$price.unit2_price }
        if ($price.sale_price)  { $jumlaUnit1  = [double]$price.sale_price }

        $retailCarton = 0.0; $retailUnit1 = 0.0
        if ($price.PSObject.Properties["retail_carton_usd"] -and $price.retail_carton_usd) { $retailCarton = [double]$price.retail_carton_usd }
        if ($price.PSObject.Properties["retail_unit1_usd"] -and $price.retail_unit1_usd)   { $retailUnit1  = [double]$price.retail_unit1_usd }

        $matched = $false

        # الجملة → قائمة "جملة الجملة"
        if ($jumlaCarton -gt 0) {
            $found = Apply-ListPrice $conn $jumlaListGuid $ameenItemName $jumlaUnit1 $jumlaCarton
            if ($found -gt 0) { $jumlaApplied++; $matched = $true }
        }

        # المفرق → قائمة "كروزات مركز"
        if ($retailCarton -gt 0) {
            $found = Apply-ListPrice $conn $retailListGuid $ameenItemName $retailUnit1 $retailCarton
            if ($found -gt 0) { $retailApplied++; $matched = $true }
        }

        if (-not $matched) {
            if ($jumlaCarton -gt 0 -or $retailCarton -gt 0) { $notFound += $ameenItemName } else { $skipped++ }
        }
    }

    $conn.Close()

    $msg = "[$timestamp] Applied: jumla=$jumlaApplied, retail=$retailApplied, skipped=$skipped, not-in-ameen=$($notFound.Count), conflict=$conflicted"
    # سطر آلي ASCII للمنسّق — لا يتأثر بترميز العربية داخل Task Scheduler.
    Write-Output "PRICE_APPLY jumla=$jumlaApplied retail=$retailApplied skipped=$skipped notfound=$($notFound.Count) conflict=$conflicted"
    Write-Host ""
    Write-Host "أسعار جملة طُبقت على قائمة (جملة الجملة): $jumlaApplied" -ForegroundColor Green
    Write-Host "أسعار مفرق طُبقت على قائمة (كروزات مركز): $retailApplied" -ForegroundColor Green
    if ($notFound.Count -gt 0) {
        Write-Host "مواد لم يُعثر عليها بالاسم في الأمين ($($notFound.Count)):" -ForegroundColor Yellow
        $notFound | Select-Object -First 20 | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    }
    $logDir = Split-Path $LogFile -Parent
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $msg | Add-Content $LogFile
    if ($notFound.Count -gt 0) { "  not found: $($notFound -join '; ')" | Add-Content $LogFile }
    if ($conflicted -gt 0) { "  conflict (zero writes): $($conflictNames -join '; ')" | Add-Content $LogFile }

    exit 0

} catch {
    $errMsg = "[$timestamp] AMEEN ERROR: $($_.Exception.Message)"
    Write-Host $errMsg -ForegroundColor Red
    $errMsg | Add-Content $LogFile
    exit 1
}
