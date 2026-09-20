# ============================================================
# verify-prices.ps1  (قراءة فقط — لا يعدّل شيئاً)
# تدقيق مزامنة الأسعار: يسحب أسعار الموقع (Supabase) ويقارنها سعراً سعراً
# مع قائمتي الأمين: «جملة الجملة» (الجملة) و«كروزات مركز» (المفرق).
# صفر فروق = كل أسعار الأمين مطابقة لأسعار الموقع.
# التشغيل:  .\tools\verify-prices.ps1
# ============================================================
param(
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$CsvFile = "$PSScriptRoot\..\reports\prices\tobacco-approved-prices.csv",
    [string]$ResultFile = ""
)

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}
$connStr = $env:AMEEN_SQL_CONNECTION_STRING
if (-not $connStr) { $connStr = $env:AMEEN_SQL_WRITE_CONNECTION_STRING }
if (-not $connStr) { Write-Host "خطأ: connection string غير موجود." -ForegroundColor Red; exit 1 }

$jumlaGuid = $env:AMEEN_JUMLA_PRICELIST_GUID
if (-not $jumlaGuid) { $jumlaGuid = "41459845-f84b-4146-b3ec-8299b400792e" }   # جملة الجملة
$retailGuid = $env:AMEEN_RETAIL_PRICELIST_GUID
if (-not $retailGuid) { $retailGuid = "938cd3b0-75fd-4533-bad8-0fe42e6f7215" } # كروزات مركز

Write-Host ""
Write-Host "========== تدقيق مزامنة الأسعار (الموقع مقابل الأمين) ==========" -ForegroundColor Cyan

function Normalize-PriceItemName($Value) {
    $text = ([string]$Value).Trim()
    $text = $text.Replace("أ", "ا").Replace("إ", "ا").Replace("آ", "ا").Replace("ى", "ي").Replace("ة", "ه")
    $text = [regex]::Replace($text, "[^\p{L}\p{N}]+", " ")
    $text = [regex]::Replace($text, "\s+", " ").Trim().ToLowerInvariant()
    switch ($text) {
        "كابتن بلاك كوين ازرق" { return "كابتن بلاك كور ازرق جديد" }
        "كابتن بلاك كوين اسود" { return "كابتن بلاك كور اسود جديد" }
        default { return $text }
    }
}

# (1) سحب أحدث أسعار الموقع
Write-Host "أسحب أحدث الأسعار من الموقع..." -ForegroundColor Yellow
try {
    & "$PSScriptRoot\pull-approved-prices.ps1" | Out-Null
} catch {
    Write-Host "تنبيه: تعذّر السحب الطازج — سأستعمل آخر ملف CSV موجود." -ForegroundColor Yellow
}
if (-not (Test-Path $CsvFile)) { Write-Host "خطأ: ملف الأسعار غير موجود: $CsvFile" -ForegroundColor Red; exit 1 }
$csv = Import-Csv -Path $CsvFile -Encoding UTF8
$sourceCount = $csv.Count
$arabicCulture = [Globalization.CultureInfo]::GetCultureInfo("ar-SY")
$csv = @($csv | Group-Object { Normalize-PriceItemName $_.item_name } | ForEach-Object {
    $_.Group | Sort-Object {
        try { [datetime]::Parse([string]$_.updated_at, $arabicCulture) }
        catch { [datetime]::MinValue }
    } -Descending | Select-Object -First 1
})
Write-Host ("أسعار الموقع: $sourceCount سجل، أحدث سعر معتمد لـ $($csv.Count) مادة")

# (2) أسعار الأمين من القائمتين
Add-Type -AssemblyName "System.Data"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
$conn.Open()
$cmd = $conn.CreateCommand()
$cmd.CommandText = @"
SELECT LTRIM(RTRIM(m.Name)) AS name,
       LOWER(CAST(i.ParentGUID AS varchar(36))) AS list_guid,
       CAST(COALESCE(i.Unit1Price,0) AS decimal(18,3)) AS u1,
       CAST(COALESCE(i.Unit2Price,0) AS decimal(18,3)) AS u2
FROM dbo.MaterialPriceListItem000 i
JOIN dbo.mt000 m ON m.GUID = i.MaterialGUID
WHERE i.ParentGUID IN (@j, @r)
"@
$cmd.Parameters.AddWithValue("@j", [guid]$jumlaGuid) | Out-Null
$cmd.Parameters.AddWithValue("@r", [guid]$retailGuid) | Out-Null
$jumla = @{}; $retail = @{}
$rd = $cmd.ExecuteReader()
while ($rd.Read()) {
    $n = Normalize-PriceItemName ([string]$rd.GetValue(0))
    $g = [string]$rd.GetValue(1)
    $entry = @{ u1 = [double]$rd.GetValue(2); u2 = [double]$rd.GetValue(3) }
    if ($g -eq $jumlaGuid.ToLower()) { $jumla[$n] = $entry } else { $retail[$n] = $entry }
}
$rd.Close(); $conn.Close()
Write-Host ("أسعار الأمين: جملة الجملة = " + $jumla.Count + " | كروزات مركز = " + $retail.Count)

# (3) المقارنة سعراً سعراً
$mismatch = 0; $missing = 0; $okJumla = 0; $okRetail = 0
function Check-Price($name, $label, $siteVal, $ameenVal) {
    if ([math]::Abs($siteVal - $ameenVal) -gt 0.011) {
        $script:mismatch++
        if ($script:mismatch -le 20) {
            Write-Host ("  ✗ {0} [{1}]: الموقع {2} | الأمين {3}" -f $name, $label, $siteVal, $ameenVal) -ForegroundColor Red
        }
        return $false
    }
    return $true
}
foreach ($row in $csv) {
    $name = ([string]$row.item_name).Trim()
    if (-not $name) { continue }
    $lookupName = Normalize-PriceItemName $name
    $u2site = 0.0; $u1site = 0.0; $rc = 0.0; $ru = 0.0
    if ($row.unit2_price) { $u2site = [double]$row.unit2_price }
    if ($row.sale_price)  { $u1site = [double]$row.sale_price }
    if ($row.PSObject.Properties["retail_carton_usd"] -and $row.retail_carton_usd) { $rc = [double]$row.retail_carton_usd }
    if ($row.PSObject.Properties["retail_unit1_usd"] -and $row.retail_unit1_usd)   { $ru = [double]$row.retail_unit1_usd }

    if ($u2site -gt 0) {
        if ($jumla.ContainsKey($lookupName)) {
            $a = $jumla[$lookupName]
            $ok = (Check-Price $name "جملة/كرتونة" $u2site $a.u2)
            if ($u1site -gt 0) { $ok = (Check-Price $name "جملة/كروز" $u1site $a.u1) -and $ok }
            if ($ok) { $okJumla++ }
        } else {
            $missing++
            if ($missing -le 10) { Write-Host ("  ⚠ {0}: مُسعّرة بالموقع (جملة) لكنها غير موجودة بقائمة الأمين" -f $name) -ForegroundColor Yellow }
        }
    }
    if ($rc -gt 0) {
        if ($retail.ContainsKey($lookupName)) {
            $a = $retail[$lookupName]
            $ok = (Check-Price $name "مفرق/كرتونة" $rc $a.u2)
            if ($ru -gt 0) { $ok = (Check-Price $name "مفرق/كروز" $ru $a.u1) -and $ok }
            if ($ok) { $okRetail++ }
        } else {
            $missing++
            if ($missing -le 10) { Write-Host ("  ⚠ {0}: مُسعّرة بالموقع (مفرق) لكنها غير موجودة بقائمة الأمين" -f $name) -ForegroundColor Yellow }
        }
    }
}

Write-Host ""
Write-Host ("مطابق: جملة = $okJumla مادة | مفرق = $okRetail مادة") -ForegroundColor Green
Write-Host ("أسعار مختلفة: $mismatch | مواد ناقصة من قوائم الأمين: $missing") -ForegroundColor $(if (($mismatch + $missing) -eq 0) { "Green" } else { "Yellow" })
# سطر آلي ASCII لسكربت المزامنة؛ لا يتأثر بترميز العربية داخل Task Scheduler.
$machineResult = "PRICE_VERIFY wholesale=$okJumla retail=$okRetail mismatches=$mismatch missing=$missing"
Write-Output $machineResult
if ($ResultFile) { [IO.File]::WriteAllText($ResultFile, $machineResult, [Text.Encoding]::ASCII) }
Write-Host ""
if ($mismatch -eq 0 -and $missing -eq 0) {
    Write-Host "================ مزامنة الأسعار سليمة: صفر فروق ✓✓ ================" -ForegroundColor Green
} elseif ($mismatch -eq 0) {
    Write-Host "الأسعار المشتركة كلها مطابقة ✓ — المواد الناقصة ستُضاف بمزامنة الأسعار القادمة (كل 5 دقائق) أو شغّل:" -ForegroundColor Yellow
    Write-Host "    .\tools\sync-approved-prices-to-ameen.ps1 -Apply"
} else {
    Write-Host "================ يوجد فروق أسعار — شغّل المزامنة أو أرسل الناتج لكلود ================" -ForegroundColor Red
    Write-Host "    .\tools\sync-approved-prices-to-ameen.ps1 -Apply"
}
