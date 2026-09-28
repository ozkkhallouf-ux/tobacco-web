#Requires -Version 5.1
# ============================================================
# notify.ps1 — تنبيه تيليغرام لبوابة النشر (نسخة مرجعية)
#
# نسخة مستقلة عن tools/send-telegram-notification.ps1 عمداً: البوابة لا تشغّل
# أي سكربت من المستودع، لأن السكربت الذي تحرسه يجب ألا يقدر على إسكات تنبيهاتها.
# يقرأ tools\.env من المستودع (بيانات فقط، غير متتبَّع) ويستدعي RPC
# notify_telegram. best-effort: لا يرمي استثناء أبداً.
# ============================================================
param(
    [Parameter(Mandatory = $true)][string]$Message,
    [string]$DedupeKey = 'deploy-gate',
    [int]$DedupeMinutes = 360,
    [string]$ConfigPath = ''
)

try {
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $PSScriptRoot 'gate-config.json' }
    $config = [System.IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json
    $envFile = Join-Path $config.repoPath 'tools\.env'
    $values = @{}
    if (Test-Path -LiteralPath $envFile) {
        Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*[^#].+=.+' } | ForEach-Object {
            $parts = $_ -split '=', 2
            $values[$parts[0].Trim()] = ($parts[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
        }
    }
    $url = [string]$values['SUPABASE_URL']
    if (-not $url) { $url = 'https://dyxbirfpxeocqffnfdeb.supabase.co' }
    $key = [string]$values['SUPABASE_SERVICE_KEY']
    if (-not $key) { Write-Host 'DEPLOY-GATE-NOTIFY SKIPPED: no service key'; exit 0 }
    $body = @{ p_event_type = 'windows'; p_message = $Message; p_dedupe_key = $DedupeKey; p_dedupe_minutes = $DedupeMinutes } | ConvertTo-Json
    $headers = @{ apikey = $key; Authorization = ('Bearer ' + $key); 'Content-Profile' = 'public'; 'Accept-Profile' = 'public' }
    Invoke-RestMethod -Method Post -Uri ($url.TrimEnd('/') + '/rest/v1/rpc/notify_telegram') -Headers $headers `
        -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 20 | Out-Null
} catch {
    Write-Host ('DEPLOY-GATE-NOTIFY FAILED: ' + $_.Exception.Message)
}
exit 0
