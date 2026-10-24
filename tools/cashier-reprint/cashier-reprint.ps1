# إعادة طباعة فاتورة كاشير — سطر الأوامر الذي تستدعيه الواجهة. يكتب نتيجة JSON واحدة على stdout.
#
#   -Mode Resolve -InvoiceNumber 1234 [-InvoiceDate 2026-10-24]   قراءة فقط: حسم الرقم، بلا طباعة
#   -Mode Print   -InvoiceNumber 1234 [-InvoiceDate ...] -RequestId <guid>   طباعة نسخة واحدة على XPRINTER
#   -Mode Health                                                   فحص الإعداد والجسر والطابعة والاتصال، بلا طباعة
#
# لا يلمس جسر الطباعة التلقائية ولا state.json ولا مهمته؛ راجع cashier-reprint-lib.ps1.
[CmdletBinding()]
param(
    [ValidateSet("Resolve", "Print", "Health")]
    [string]$Mode = "Health",
    [int]$InvoiceNumber = 0,
    [string]$InvoiceDate = "",
    [string]$RequestId = "",
    [string]$Root = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot "cashier-reprint-lib.ps1")

function Out-Result($Object, [int]$Code = 0) {
    Write-Output ($Object | ConvertTo-Json -Compress -Depth 6)
    exit $Code
}

try {
    if ([string]::IsNullOrWhiteSpace($Root)) { $Root = Get-CashierDefaultRoot }
    $config = Read-CashierReprintConfig (Join-Path $Root "config.json")
    if (-not [string]::IsNullOrWhiteSpace($InvoiceDate) -and $InvoiceDate -notmatch '^\d{4}-\d{2}-\d{2}$') {
        Out-Result ([pscustomobject]@{ Status = "invalid_input"; Message = "صيغة التاريخ يجب أن تكون yyyy-MM-dd." }) 2
    }
    $secretPath = Join-Path $Root "sql.secret"
    $lookup = {
        param([int]$Number)
        $connection = Open-CashierReadOnlyConnection (Read-CashierSqlSecret $secretPath)
        try { return (Invoke-CashierInvoiceLookup $connection $Number) }
        finally { $connection.Dispose() }
    }

    if ($Mode -eq "Health") {
        $checks = [ordered]@{ host = $env:COMPUTERNAME; user = $env:USERNAME }
        try { $checks.bridgeSha256 = Assert-CashierBridgePinned $config; $checks.bridge = "ok" } catch { $checks.bridge = [string]$_.Exception.Message }
        try {
            $printer = @(Get-Printer -Name $config.printerName -ErrorAction Stop)
            $checks.printer = "ok"; $checks.printerPort = [string]$printer[0].PortName; $checks.printerStatus = [string]$printer[0].PrinterStatus
        } catch { $checks.printer = "غير موجودة: $($config.printerName)" }
        try {
            $connection = Open-CashierReadOnlyConnection (Read-CashierSqlSecret $secretPath)
            $connection.Dispose(); $checks.sql = "ok"
        } catch { $checks.sql = [string]$_.Exception.Message }
        $healthy = ($checks.bridge -eq "ok" -and $checks.printer -eq "ok" -and $checks.sql -eq "ok")
        $checks.Status = if ($healthy) { "ok" } else { "unhealthy" }
        Out-Result ([pscustomobject]$checks) $(if ($healthy) { 0 } else { 1 })
    }

    if ($Mode -eq "Resolve") {
        try { $rows = @(& $lookup $InvoiceNumber) }
        catch {
            Out-Result ([pscustomobject]@{ Status = "connection_failed"; Message = "تعذّر الاتصال بقاعدة الأمين أو قراءتها. تحقق من الشبكة ثم أعد المحاولة." }) 1
        }
        $resolved = Resolve-CashierInvoice $rows $InvoiceNumber $InvoiceDate
        $result = [ordered]@{ Status = $resolved.Status; Message = $resolved.Message }
        if ($resolved.Status -eq "ok") {
            $inv = $resolved.Invoice
            $result.Invoice = [ordered]@{
                Number = $inv.InvoiceNumber; Date = $inv.InvoiceDate; Total = $inv.Total; Customer = $inv.CustomerName
                AgeSeconds = $(if ($null -ne $inv.CreateDate) { [int]((Get-Date) - $inv.CreateDate).TotalSeconds } else { $null })
            }
            $last = Get-CashierLastReprint $Root $inv.InvoiceGuid
            if ($null -ne $last) { $result.LastReprintAt = [string]$last.at; $result.LastReprintHost = [string]$last.host }
            $result.NewInvoiceWarningSeconds = $config.newInvoiceWarningSeconds
        }
        if ($resolved.Status -eq "ambiguous") {
            $result.Dates = @($resolved.Choices | ForEach-Object { $_.InvoiceDate })
        }
        Out-Result ([pscustomobject]$result) $(if ($resolved.Status -eq "ok") { 0 } else { 1 })
    }

    # Print
    if ([string]::IsNullOrWhiteSpace($RequestId)) { throw "الطباعة تتطلب -RequestId." }
    $result = Invoke-CashierReprint -Config $config -Root $Root -Number $InvoiceNumber -Date $InvoiceDate -RequestId $RequestId `
        -Lookup $lookup -Runner { param($c, $n, $d) Invoke-CashierBridgeProcess $c $n $d }
    Out-Result ([pscustomobject]@{ Status = $result.Status; Message = $result.Message }) $(if ($result.Status -eq "printed") { 0 } else { 1 })
} catch {
    Out-Result ([pscustomobject]@{ Status = "error"; Message = [string]$_.Exception.Message }) 1
}
