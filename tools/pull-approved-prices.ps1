# ============================================================
# pull-approved-prices.ps1
# يسحب الأسعار المعتمدة من Supabase ويحفظها في CSV
# ============================================================

param(
    [string]$EnvFile = "$PSScriptRoot\.env",
    [string]$OutputCsv = "$PSScriptRoot\..\reports\prices\tobacco-approved-prices.csv",
    [string]$LogFile = "$PSScriptRoot\logs\approved-prices-sync.log"
)

# قراءة الإعدادات
$envPath = $EnvFile
if (Test-Path $envPath) {
    Get-Content $envPath | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
        $parts = $_ -split '=', 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim())
    }
}

$supabaseUrl = $env:SUPABASE_URL
if (-not $supabaseUrl) { $supabaseUrl = "https://dyxbirfpxeocqffnfdeb.supabase.co" }

# القراءة عبر نافذة approved_price_sync_feed (أسعار فقط، بدون مخزون) — يكفي المفتاح العام
$apiKey = $env:SUPABASE_SERVICE_KEY
if (-not $apiKey) {
    $apiKey = "sb_publishable_RkM_QDWxk8Yekqz9KBKXBw_Yl14zhSH"
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "[$timestamp] سحب الأسعار من Supabase..." -ForegroundColor Cyan

try {
    $headers = @{
        "apikey"          = $apiKey
        "Authorization"   = "Bearer $apiKey"
        "Accept-Profile"  = "public"
    }

    $url = "$supabaseUrl/rest/v1/approved_price_sync_feed?select=item_key,item_name,sale_price,unit1_price,unit1_name,unit2_name,unit2_factor,unit2_price,retail_carton_usd,updated_at&order=item_name.asc&limit=5000"

    $response = Invoke-RestMethod -Uri $url -Headers $headers -Method GET -TimeoutSec 30 -ErrorAction Stop

    if (-not $response -or $response.Count -eq 0) {
        Write-Host "لا توجد أسعار في Supabase!" -ForegroundColor Red
        exit 1
    }

    Write-Host "تم سحب $($response.Count) سعر بنجاح ✓" -ForegroundColor Green

    # إنشاء المجلد إذا لم يكن موجوداً
    $csvDir = Split-Path $OutputCsv -Parent
    if (-not (Test-Path $csvDir)) { New-Item -ItemType Directory -Path $csvDir -Force | Out-Null }

    # سعر المفرق اليدوي يأتي بسعر الكرتونة بالدولار (retail_carton_usd)
    # نحسب منه سعر الكروز (الوحدة الأولى) = سعر الكرتونة ÷ عدد الكروز
    $rows = $response | ForEach-Object {
        $retailCarton = 0.0
        if ($_.retail_carton_usd) { $retailCarton = [double]$_.retail_carton_usd }
        $factor = [double]($_.unit2_factor)
        if (-not ($factor -gt 0)) { $factor = 1 }
        $retailUnit1 = if ($retailCarton -gt 0) { [math]::Round($retailCarton / $factor, 2) } else { 0 }
        [PSCustomObject]@{
            item_key          = $_.item_key
            item_name         = $_.item_name
            sale_price        = $_.sale_price
            unit1_price       = $_.unit1_price
            unit1_name        = $_.unit1_name
            unit2_name        = $_.unit2_name
            unit2_factor      = $_.unit2_factor
            unit2_price       = $_.unit2_price
            retail_carton_usd = $retailCarton
            retail_unit1_usd  = $retailUnit1
            updated_at        = $_.updated_at
        }
    }

    # حفظ CSV
    $rows | Export-Csv -Path $OutputCsv -NoTypeInformation -Encoding UTF8

    $retailCount = @($rows | Where-Object { [double]$_.retail_unit1_usd -gt 0 }).Count
    Write-Host "منها $retailCount صنف له سعر مفرق يدوي" -ForegroundColor Cyan

    Write-Host "تم الحفظ في: $OutputCsv" -ForegroundColor Green

    # تسجيل في السجل
    $logDir = Split-Path $LogFile -Parent
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    "[$timestamp] Pulled $($response.Count) approved prices → $OutputCsv" | Add-Content $LogFile

    Write-Host "Pulled $($response.Count) approved prices from Supabase ✓" -ForegroundColor Green
    exit 0

} catch {
    $errMsg = "[$timestamp] ERROR: $($_.Exception.Message)"
    Write-Host $errMsg -ForegroundColor Red
    if (Test-Path (Split-Path $LogFile -Parent)) { $errMsg | Add-Content $LogFile }
    # إشعار تيليغرام عند الفشل (مرة كل ساعة كحد أقصى لنفس العطل)
    try {
        & "$PSScriptRoot\send-telegram-notification.ps1" `
            -Message "🚨 فشل سحب الأسعار من Supabase (pull-approved-prices)`n$($_.Exception.Message)" `
            -EventType "sync_failure" -DedupeKey "winfail:pull-approved-prices" -DedupeMinutes 60 `
            -EnvFile $EnvFile
    } catch { }
    exit 1
}
