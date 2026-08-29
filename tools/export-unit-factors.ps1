# ============================================================
# export-unit-factors.ps1
# يستخرج عوامل التحويل واسم الوحدة الأولى من قاعدة الأمين
# ويحدّث scripts/price-data.json
# ============================================================
# الاستخدام: .\tools\export-unit-factors.ps1
# بعده: npm run generate  (على السيرفر السحابي)
# ============================================================

param(
    [string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = "Stop"

# ── اتصال ────────────────────────────────────────────────────────────────────
$connStr = $env:AMEEN_SQL_CONNECTION_STRING
if (-not $connStr) {
    Write-Host "خطأ: متغير AMEEN_SQL_CONNECTION_STRING غير موجود." -ForegroundColor Red
    Write-Host "شغّل أولاً: .\tools\setup-ameen-sync-env.ps1" -ForegroundColor Yellow
    exit 1
}

$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
$conn.Open()

# ── اكتشاف أسماء أعمدة الوحدة الأولى ────────────────────────────────────────
Write-Host "جارٍ اكتشاف أعمدة الوحدات في قاعدة الأمين..." -ForegroundColor Cyan

$discoverSql = @"
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME LIKE 'MaterialCard%'
  AND (
        COLUMN_NAME LIKE '%unit%'
     OR COLUMN_NAME LIKE '%Unit%'
     OR COLUMN_NAME LIKE '%factor%'
     OR COLUMN_NAME LIKE '%Factor%'
     OR COLUMN_NAME LIKE '%pack%'
     OR COLUMN_NAME LIKE '%Pack%'
     OR COLUMN_NAME LIKE '%qty%'
     OR COLUMN_NAME LIKE '%small%'
     OR COLUMN_NAME LIKE '%Small%'
     OR COLUMN_NAME LIKE '%base%'
  )
ORDER BY TABLE_NAME, COLUMN_NAME
"@

$cmd2 = $conn.CreateCommand()
$cmd2.CommandText = $discoverSql
$r2 = $cmd2.ExecuteReader()
$cols = @()
while ($r2.Read()) { $cols += $r2["COLUMN_NAME"] }
$r2.Close()

Write-Host "أعمدة وُجدت: $($cols -join ', ')" -ForegroundColor Gray

# تحديد عمود الوحدة الأولى — بالترتيب التنازلي من الأكثر شيوعاً
$unit1Candidates = @(
    "SmallUnitName","Unit1Name","UnitSmallName","BaseUnitName",
    "SmallUnit","Unit1","UnitSmall","BaseUnit",
    "UnitName","Unit"
)
$unit1Col = $unit1Candidates | Where-Object { $cols -contains $_ } | Select-Object -First 1
if (-not $unit1Col) { $unit1Col = $null }

# تحديد عمود عامل التحويل
$factorCandidates = @(
    "UnitFactor","ConversionFactor","PackSize","UnitsPerCarton",
    "Qty","Factor","UnitQty"
)
$factorCol = $factorCandidates | Where-Object { $cols -contains $_ } | Select-Object -First 1
if (-not $factorCol) { $factorCol = $null }

Write-Host "عمود الوحدة الأولى: $unit1Col" -ForegroundColor $(if ($unit1Col) {"Green"} else {"Yellow"})
Write-Host "عمود العامل       : $factorCol" -ForegroundColor $(if ($factorCol) {"Green"} else {"Yellow"})

# ── استعلام البيانات ──────────────────────────────────────────────────────────
$factorExpr  = if ($factorCol)  { "m.$factorCol" }  else { "NULL" }
$unit1Expr   = if ($unit1Col)   { "m.$unit1Col" }   else { "NULL" }

$query = @"
SELECT
    m.Name        AS item_name,
    m.Code        AS item_key,
    COALESCE($factorExpr, 10) AS unit_factor,
    ISNULL($unit1Expr, '')    AS unit1_name
FROM MaterialCard000 m
WHERE m.IsActive = 1
   OR m.Active   = 1
   OR m.Deleted  = 0
ORDER BY m.Name
"@

Write-Host "جارٍ جلب البيانات..." -ForegroundColor Cyan

$cmd = $conn.CreateCommand()
$cmd.CommandText = $query
$cmd.CommandTimeout = 60

$rows = @()
try {
    $reader = $cmd.ExecuteReader()
    while ($reader.Read()) {
        $rows += [PSCustomObject]@{
            item_key    = "$($reader["item_key"])".Trim()
            unit_factor = [int]$reader["unit_factor"]
            unit1_name  = "$($reader["unit1_name"])".Trim()
        }
    }
    $reader.Close()
} catch {
    Write-Host "خطأ في الاستعلام: $_" -ForegroundColor Red
    $conn.Close()
    exit 1
}
$conn.Close()

Write-Host "✓ استُخرج $($rows.Count) مادة" -ForegroundColor Green

# ── تحديث price-data.json ─────────────────────────────────────────────────────
$dataPath = Join-Path $ProjectRoot "scripts\price-data.json"
if (-not (Test-Path $dataPath)) {
    Write-Host "خطأ: $dataPath غير موجود." -ForegroundColor Red
    exit 1
}

$priceData = Get-Content $dataPath -Raw | ConvertFrom-Json

# بناء خريطة بحث سريعة بـ item_key
$factorMap = @{}
foreach ($row in $rows) {
    $factorMap[$row.item_key] = $row
}

$updated = 0
foreach ($item in $priceData) {
    $key = $item.item_key
    if ($key -and $factorMap.ContainsKey($key)) {
        $r = $factorMap[$key]
        $item.unitFactor = $r.unit_factor
        if ($r.unit1_name -ne "") {
            $item | Add-Member -NotePropertyName "unit1" -NotePropertyValue $r.unit1_name -Force
        }
        $updated++
    }
}

$newJson = $priceData | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($dataPath, $newJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "✓ تم تحديث $updated مادة في price-data.json" -ForegroundColor Green

Write-Host ""
Write-Host "الخطوة التالية — شغّل على السيرفر السحابي:" -ForegroundColor Yellow
Write-Host "  npm run generate" -ForegroundColor White
Write-Host ""

# ── ملخص عينة ────────────────────────────────────────────────────────────────
Write-Host "عينة من النتائج:" -ForegroundColor Cyan
$priceData | Select-Object -First 8 | ForEach-Object {
    $u1 = if ($_.unit1) { $_.unit1 } else { "-" }
    Write-Host ("  {0,-30} unit1={1,-10} factor={2}" -f $_.name, $u1, $_.unitFactor)
}
