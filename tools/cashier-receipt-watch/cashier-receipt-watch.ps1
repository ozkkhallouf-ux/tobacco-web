# مراقب إيصالات الكاشير بعد الطباعة — تمريرة واحدة لكل تشغيل (للتسجيل لاحقاً كمهمة كل 5 دقائق بموافقة).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\cashier-receipt-watch\cashier-receipt-watch.ps1 -DryRun
#
# - يقرأ الأرشيف الثابت (OzkReceiptArchive) ويقارن كل إيصال وصل Windows بحالة فاتورته الحالية في
#   الأمين بالـGUID (SELECT فقط بحساب لا يملك صلاحية كتابة).
# - يسجّل دليل Windows (حدث PrintService 307) كمرحلة windows_completed — ليس دليلاً ورقياً.
# - يرسل تنبيهاً مجمّعاً واحداً عبر tools\send-telegram-notification.ps1، بلا أسماء زبائن، ولا يكرر
#   التنبيه نفسه. أول تشغيل يسجّل نقطة البداية فقط: لا تنبيهات عن إيصالات أقدم منه.
# - لا يعيد الطباعة أبداً.
[CmdletBinding()]
param(
    [string]$ArchiveRoot = "",
    [string]$StatePath = "",
    [ValidateRange(1, 720)]
    [int]$LookbackHours = 72,
    [string]$ConnectionEnvVar = "AMEEN_SQL_CONNECTION_STRING",
    [string]$PrinterName = "XPRINTER XP-T80Q 80MM",
    [string]$TelegramScript = "",
    [switch]$NoTelegram,
    # لا كتابة إطلاقاً (لا حالة ولا مراحل ولا تيليغرام): يطبع ما كان سيُرسَل.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cashier-receipt-watch-lib.ps1")
[void](Import-CashierWatchArchiveModule)

if ([string]::IsNullOrWhiteSpace($ArchiveRoot)) { $ArchiveRoot = Get-OzkReceiptArchiveDefaultRoot }
if ([string]::IsNullOrWhiteSpace($StatePath)) { $StatePath = Join-Path (Join-Path $ArchiveRoot "watch") "state.json" }
if ([string]::IsNullOrWhiteSpace($TelegramScript)) { $TelegramScript = Join-Path (Split-Path -Parent $PSScriptRoot) "send-telegram-notification.ps1" }

$nowUtc = [datetime]::UtcNow
$loaded = Read-CashierWatchState $StatePath $nowUtc
$state = $loaded.State
if ($loaded.Initialized) {
    if (-not $DryRun) { Save-CashierWatchState $StatePath $state }
    [pscustomobject]@{ Status = "initialized"; WatchStartUtc = $state.watchStartUtc; Note = "no alerts for receipts printed before this point" } | ConvertTo-Json -Compress
    exit 0
}

$watchStart = [datetime]::Parse([string]$state.watchStartUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
$windowStart = $nowUtc.AddHours(-$LookbackHours)
if ($watchStart -gt $windowStart) { $windowStart = $watchStart }

$summaries = @(Get-OzkReceiptPrintSummaries $ArchiveRoot | Where-Object {
    $_.preparedAtUtc -and ([datetime]::Parse([string]$_.preparedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() -ge $windowStart)
})

# 1) دليل Windows على مغادرة المهمة الطابور (لا يُكتب paper_confirmed أبداً).
$evidenceAdded = 0
$pending = @($summaries | Where-Object { @($_.stages) -contains "submitted" -and @($_.stages) -notcontains "windows_completed" })
if ($pending.Count) {
    $completions = @(Get-CashierWatchSpoolerCompletions $windowStart)
    foreach ($summary in $pending) {
        $submittedAt = [datetime]::Parse([string]$summary.preparedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        $match = Find-CashierWatchSpoolerEvidence $summary $completions $PrinterName $submittedAt
        if ($null -ne $match -and -not $DryRun) {
            [void](Add-OzkReceiptArchiveEvent -Root $ArchiveRoot -PrintId $summary.printId -Stage "windows_completed" -InvoiceGuid $summary.invoiceGuid `
                -InvoiceNumber $summary.invoiceNumber -JobId $summary.jobId -Evidence ("PrintService/Operational 307 at " + $match.AtUtc.ToString("o")))
            $evidenceAdded++
        }
    }
}

# 2) المحتوى المؤرشف (مع فحص البصمة) لكل إيصال وصل Windows.
$prints = New-Object System.Collections.Generic.List[object]
$integrityFailures = New-Object System.Collections.Generic.List[object]
foreach ($summary in @($summaries | Where-Object { Test-OzkReceiptReachedSpooler $_ })) {
    try { $prints.Add([pscustomobject]@{ Summary = $summary; Content = (Get-OzkArchivedReceiptContent $ArchiveRoot $summary) }) }
    catch { $integrityFailures.Add($summary) }
}

$findings = @()
if ($prints.Count) {
    $connectionString = [Environment]::GetEnvironmentVariable($ConnectionEnvVar, "User")
    if ([string]::IsNullOrWhiteSpace($connectionString)) { $connectionString = [Environment]::GetEnvironmentVariable($ConnectionEnvVar, "Process") }
    if ([string]::IsNullOrWhiteSpace($connectionString)) { throw "Missing read-only connection string in $ConnectionEnvVar." }
    $connection = Open-CashierWatchConnection $connectionString
    try {
        $guids = @($prints | ForEach-Object { [string]$_.Summary.invoiceGuid } | Select-Object -Unique)
        $current = ConvertTo-CashierWatchCurrentInvoices (Invoke-CashierWatchBatched $connection $guids { param($n) Get-CashierWatchCurrentSql $n })
        $missing = @($guids | Where-Object { $null -eq $current[$_] -or -not $current[$_].isPosted -or $current[$_].recordState -ne 0 -or $current[$_].typeGuid -ne $script:WatchRetailTypeGuid })
        $logEvidence = @{}
        $neighbours = @{}
        if ($missing.Count) {
            foreach ($row in @(Invoke-CashierWatchBatched $connection $missing { param($n) Get-CashierWatchLogSql $n })) {
                $key = ([string]$row.rec_guid).ToLowerInvariant()
                if (-not $logEvidence.ContainsKey($key)) { $logEvidence[$key] = [pscustomobject]@{ deletes = 0; edits = 0 } }
                if ([int]$row.operation_type -eq 2) { $logEvidence[$key].deletes = [int]$row.entries } else { $logEvidence[$key].edits = [int]$row.entries }
            }
            $neighbourGuids = New-Object System.Collections.Generic.List[string]
            foreach ($guid in $missing) {
                $content = @($prints | Where-Object { $_.Summary.invoiceGuid -eq $guid })[0].Content
                $created = [datetime]::Parse([string]$content.invoice.createDate, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
                $rows = @(Invoke-CashierWatchQuery $connection (Get-CashierWatchNeighbourSql) @{
                    retailType = [guid]$script:WatchRetailTypeGuid; number = [int]$content.invoice.number
                    fromDate = $created.AddMinutes(-$script:WatchReentryWindowMinutes); toDate = [datetime]::Now.AddMinutes(1)
                })
                $neighbours[$guid] = @($rows | ForEach-Object { [pscustomobject]@{ guid = ([string]$_.invoice_guid).ToLowerInvariant(); number = [int]$_.invoice_number } })
                foreach ($n in $neighbours[$guid]) { if ($null -eq $current[$n.guid]) { $neighbourGuids.Add($n.guid) } }
            }
            if ($neighbourGuids.Count) {
                $extra = ConvertTo-CashierWatchCurrentInvoices (Invoke-CashierWatchBatched $connection @($neighbourGuids) { param($n) Get-CashierWatchCurrentSql $n })
                foreach ($key in $extra.Keys) { $current[$key] = $extra[$key] }
            }
        }
        $findings = @(Get-CashierWatchFindings -Prints $prints.ToArray() -Current $current -LogEvidence $logEvidence -Neighbours $neighbours -WatchStartUtc $watchStart)
    } finally {
        $connection.Dispose()
    }
}

$selection = Select-CashierWatchAlerts $findings $state.alerted
$message = $null
if (@($selection.Selected).Count -or $integrityFailures.Count) {
    $message = Format-CashierWatchAlert -Findings @($selection.Selected | ForEach-Object { $_.Finding }) -Remaining $selection.Remaining
    $newIntegrity = @($integrityFailures | Where-Object { -not $state.alerted.ContainsKey("integrity:" + $_.printId) })
    if ($newIntegrity.Count) {
        $message += "`n⚠️ $($newIntegrity.Count) نسخة إيصال مؤرشفة فشلت فحص البصمة SHA-256 (عبث أو تلف) — راجع الأرشيف."
    }
}

$sent = $false
if ($message -and -not $DryRun) {
    if (-not $NoTelegram) {
        $dedupe = "cashier-postprint-" + (Get-OzkTextSha256 (ConvertTo-OzkCanonicalJson @($selection.Selected | ForEach-Object { $_.Hash })))
        & $TelegramScript -Message $message -EventType "cashier_receipt_changed" -DedupeKey $dedupe -DedupeMinutes 1440 | Out-Null
        $sent = $true
    }
    foreach ($item in @($selection.Selected)) {
        $state.alerted[[string]$item.Finding.invoiceGuid] = [ordered]@{ hash = $item.Hash; kind = $item.Finding.kind; number = [int]$item.Finding.invoiceNumber; at = $nowUtc.ToString("o") }
    }
    foreach ($summary in $integrityFailures) { $state.alerted["integrity:" + $summary.printId] = [ordered]@{ hash = "integrity"; at = $nowUtc.ToString("o") } }
}
if (-not $DryRun) { Save-CashierWatchState $StatePath $state }

if ($DryRun -and $message) { Write-Output $message }
[pscustomobject]@{
    Status = "ok"; DryRun = [bool]$DryRun; Receipts = $summaries.Count; Compared = $prints.Count; Findings = @($findings).Count
    Alerted = @($selection.Selected).Count; Deferred = $selection.Remaining; IntegrityFailures = $integrityFailures.Count
    SpoolerEvidenceAdded = $evidenceAdded; TelegramSent = $sent
} | ConvertTo-Json -Compress
