# إعادة طباعة فاتورة كاشير — سطر الأوامر الذي تستدعيه الواجهة. يكتب نتيجة JSON واحدة (ASCII) على stdout.
#
#   -Mode Resolve -InvoiceNumber 1234 [-InvoiceDate 2026-10-24]       قراءة فقط: حسم الرقم، بلا طباعة
#   -Mode Print   -InvoiceNumber 1234 -InvoiceDate ... -RequestId <guid>   طلب طباعة نسخة واحدة
#   -Mode Status  -RequestId <guid>                                    حالة طلب سابق، بلا طباعة
#   -Mode Health                                                       فحص الإعداد والمسار، بلا طباعة
#   -Mode Serve                                                        على جهاز الطابعة فقط: يُشغَّل كأمر
#        مفروض لمفتاح ssh المقيَّد، ويقرأ الطلب من SSH_ORIGINAL_COMMAND بصيغة ضيقة.
#        مع printDispatch=agent لا يطبع: يكتب تذكرة للعامل المحلي وينتظر نتيجتها.
#   -Mode Agent [-Once]                                                على جهاز الطابعة فقط: العامل المحلي
#        (مهمة مجدولة بهوية الكاشير التفاعلية) يلتقط تذاكر Serve ويطبع كل واحدة مرة واحدة.
#
# config.json: mode=local (جهاز الطابعة: OZKUSER) أو mode=remote (جهاز بلا طابعة: OZK2026، يرسل
# الطلب عبر ssh إلى OZKUSER). لا يلمس جسر الطباعة التلقائية ولا state.json ولا مهمته.
[CmdletBinding()]
param(
    [ValidateSet("Resolve", "Print", "Status", "Health", "Serve", "Agent")]
    [string]$Mode = "Health",
    [int]$InvoiceNumber = 0,
    [string]$InvoiceDate = "",
    [string]$RequestId = "",
    [string]$Root = "",
    [switch]$Once
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "cashier-reprint-lib.ps1")

function Out-Result($Object, [int]$Code = 0) {
    $Object | Add-Member -NotePropertyName Host -NotePropertyValue $env:COMPUTERNAME -Force
    [Console]::Out.WriteLine((ConvertTo-CashierAsciiJson $Object))
    exit $Code
}

function Get-LocalResolveResult($Config, [string]$CashierRoot, [scriptblock]$Lookup, [int]$Number, [string]$Date) {
    try { $rows = @(& $Lookup $Number) }
    catch {
        return [pscustomobject]@{ Status = "connection_failed"; Message = "تعذّر الاتصال بقاعدة الأمين أو قراءتها من $($env:COMPUTERNAME). لم يُطبع شيء. تحقق من الشبكة ثم أعد المحاولة." }
    }
    $resolved = Resolve-CashierInvoice $rows $Number $Date
    $result = [ordered]@{ Status = $resolved.Status; Message = $resolved.Message }
    if ($resolved.Status -eq "ok") {
        $inv = $resolved.Invoice
        $age = $null
        if ($null -ne $inv.CreateDate) { $age = [int]((Get-Date) - $inv.CreateDate).TotalSeconds }
        $result.Invoice = [ordered]@{ Number = $inv.InvoiceNumber; Date = $inv.InvoiceDate; Total = $inv.Total; Customer = $inv.CustomerName; AgeSeconds = $age }
        $last = Get-CashierLastReprint $CashierRoot $inv.InvoiceGuid
        if ($null -ne $last) { $result.LastReprintAt = [string]$last.at; $result.LastReprintFrom = [string]$last.requestedFrom }
        $result.NewInvoiceWarningSeconds = $Config.newInvoiceWarningSeconds
    }
    if ($resolved.Status -eq "ambiguous") { $result.Dates = @($resolved.Choices | ForEach-Object { $_.InvoiceDate }) }
    return [pscustomobject]$result
}

function Invoke-LocalPrint($Config, [string]$CashierRoot, [scriptblock]$Lookup, [int]$Number, [string]$Date, [string]$Id, [string]$From) {
    # tool-secret: اتصال القراءة للجسر من sql.secret نفسه، لحساب خدمة بلا متغيّر AMEEN_SQL_CONNECTION_STRING.
    $secretFile = Join-Path $CashierRoot "sql.secret"
    $bridgeSql = { param($c) "" }
    if ($Config.bridgeSqlSource -eq "tool-secret") { $bridgeSql = { param($c) Get-CashierBridgeSqlConnectionString (Read-CashierSqlSecret $secretFile) }.GetNewClosure() }
    $result = Invoke-CashierReprint -Config $Config -Root $CashierRoot -Number $Number -Date $Date -RequestId $Id -RequestedFrom $From `
        -Lookup $Lookup -BridgeSql $bridgeSql -Runner { param($c, $n, $d, $s) Invoke-CashierBridgeProcess $c $n $d $s }
    return [pscustomobject]@{ Status = $result.Status; Message = $result.Message; Confirmation = [string]$result.Details.confirmation }
}

function Get-StatusResult([string]$CashierRoot, [string]$Id) {
    $s = Get-CashierRequestStatus $CashierRoot $Id
    return [pscustomobject]@{ Status = $s.Status; Confirmation = $s.Confirmation; At = $s.At; Message = "" }
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

    if ($Mode -eq "Serve") {
        if ($config.mode -ne "local") { throw "وضع Serve يعمل على جهاز الطابعة فقط (mode=local)." }
        $request = ConvertFrom-CashierRemoteCommand ([string]$env:SSH_ORIGINAL_COMMAND)
        switch ($request.Verb) {
            "resolve" { $r = Get-LocalResolveResult $config $Root $lookup $request.Number $request.Date; Out-Result $r $(if ($r.Status -eq "ok") { 0 } else { 1 }) }
            "print" {
                if ($config.printDispatch -eq "agent") { $r = Submit-CashierAgentPrint -Config $config -Root $Root -Number $request.Number -Date $request.Date -RequestId $request.RequestId -RequestedFrom $request.From }
                else { $r = Invoke-LocalPrint $config $Root $lookup $request.Number $request.Date $request.RequestId $request.From }
                Out-Result $r $(if ($r.Status -eq "sent") { 0 } else { 1 })
            }
            "status" { Out-Result (Get-StatusResult $Root $request.RequestId) 0 }
        }
    }

    if ($Mode -eq "Agent") {
        if ($config.mode -ne "local" -or $config.printDispatch -ne "agent") { throw "وضع Agent يتطلب mode=local وprintDispatch=agent." }
        # نسخة واحدة فقط من العامل على الجهاز: نسخة ثانية تخرج فوراً بلا أي معالجة.
        $mutex = New-Object Threading.Mutex($false, "Global\OZK-CashierReprint-Agent")
        $owned = $false
        try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { Out-Result ([pscustomobject]@{ Status = "agent_already_running"; Message = "" }) 1 }
        try {
            $paths = Initialize-CashierAgentFolders $Root
            Write-CashierAgentHeartbeat $Root
            $recovered = @(Restore-CashierAgentState $Root)
            $print = { param($n, $d, $id, $from) Invoke-LocalPrint $config $Root $lookup $n $d $id $from }
            $handled = 0
            while ($true) {
                Write-CashierAgentHeartbeat $Root
                $handled += @(Invoke-CashierAgentPass -Config $config -Root $Root -Print $print).Count
                if ($Once) { break }
                Start-Sleep -Milliseconds 1000
            }
            Out-Result ([pscustomobject]@{ Status = "ok"; Handled = $handled; Recovered = $recovered.Count; Inbox = $paths.Inbox }) 0
        } finally {
            $mutex.ReleaseMutex()
            $mutex.Dispose()
        }
    }

    if ($Mode -eq "Health") {
        $checks = [ordered]@{ Mode = $config.mode; User = $env:USERNAME }
        if ($config.mode -eq "local") {
            try { $checks.BridgeSha256 = Assert-CashierBridgePinned $config; $checks.Bridge = "ok" } catch { $checks.Bridge = [string]$_.Exception.Message }
            if ($config.expectedRendererSha256 -ne "") {
                try { $checks.RendererSha256 = Assert-CashierRendererPinned $config; $checks.Renderer = "ok" } catch { $checks.Renderer = [string]$_.Exception.Message }
            }
            try {
                $printer = Get-CashierPrinterInfo $config.printerName
                $checks.Printer = "ok"; $checks.PrinterPort = $printer.PortName; $checks.PrinterStatus = $printer.StatusText
            } catch { $checks.Printer = "غير موجودة: $($config.printerName)" }
            try { $connection = Open-CashierReadOnlyConnection (Read-CashierSqlSecret $secretPath); $connection.Dispose(); $checks.Sql = "ok" }
            catch { $checks.Sql = [string]$_.Exception.Message }
            # مصدر اتصال الجسر: متغيّر User للحساب الحالي (السلوك الأصلي) أو سرّ الأداة.
            $checks.BridgeSqlSource = $config.bridgeSqlSource
            if ($config.bridgeSqlSource -eq "tool-secret") {
                try { [void](Get-CashierBridgeSqlConnectionString (Read-CashierSqlSecret $secretPath)); $checks.BridgeSql = "ok" }
                catch { $checks.BridgeSql = [string]$_.Exception.Message }
            } elseif ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable("AMEEN_SQL_CONNECTION_STRING", "User"))) {
                $checks.BridgeSql = "متغيّر AMEEN_SQL_CONNECTION_STRING غير موجود لحساب $($env:USERNAME)"
            } else { $checks.BridgeSql = "ok" }
            # كتابة غير موثوقة على ما يُنفَّذ: تُعرض دائماً، وتمنع الطباعة حين enforceProtectedPaths=true.
            $checks.EnforceProtectedPaths = $config.enforceProtectedPaths
            try {
                $risks = @(Get-CashierPathWriteRisks (Get-CashierProtectedPaths $config $Root))
                if ($risks.Count -eq 0) { $checks.ProtectedPaths = "ok" } else { $checks.ProtectedPaths = @($risks | Select-Object -First 10) }
            } catch { $checks.ProtectedPaths = @([string]$_.Exception.Message) }
            $healthy = ($checks.Bridge -eq "ok" -and $checks.Printer -eq "ok" -and $checks.Sql -eq "ok")
            if ($config.bridgeSqlSource -eq "tool-secret" -and $checks.BridgeSql -ne "ok") { $healthy = $false }
            if ($config.enforceProtectedPaths -and $checks.ProtectedPaths -ne "ok") { $healthy = $false }
            if ($config.expectedRendererSha256 -ne "" -and $checks.Renderer -ne "ok") { $healthy = $false }
            $checks.PrintDispatch = $config.printDispatch
            if ($config.printDispatch -eq "agent") {
                $age = Get-CashierAgentHeartbeatAge $Root
                $checks.AgentHeartbeatAgeSeconds = $age
                if ($age -ge 0 -and $age -le $config.agentHeartbeatMaxAgeSeconds) { $checks.Agent = "ok" } else { $checks.Agent = "عامل الطباعة لا يعمل" }
                if ($checks.Agent -ne "ok") { $healthy = $false }
            }
        } else {
            # فحص بعيد بلا طباعة: حالة معرّف عشوائي جديد يجب أن تكون not_received من جهاز الطابعة المتوقع.
            try {
                $probe = Invoke-CashierRemoteCommand $config ("status " + [guid]::NewGuid().ToString())
                $reply = Get-CashierRemoteJson $probe.Output
                if ($null -ne $reply -and $reply.Status -eq "not_received" -and $reply.Host -eq $config.remoteExpectedHostName) { $checks.Remote = "ok" }
                else { $checks.Remote = "رد غير متوقع (exit $($probe.ExitCode))" }
            } catch { $checks.Remote = [string]$_.Exception.Message }
            $healthy = ($checks.Remote -eq "ok")
        }
        $checks.Status = "unhealthy"
        if ($healthy) { $checks.Status = "ok" }
        Out-Result ([pscustomobject]$checks) $(if ($healthy) { 0 } else { 1 })
    }

    if ($Mode -eq "Status") {
        if ($config.mode -eq "local") { Out-Result (Get-StatusResult $Root $RequestId) 0 }
        $probe = Invoke-CashierRemoteCommand $config ("status " + ([guid]$RequestId).ToString())
        $reply = Get-CashierRemoteJson $probe.Output
        if ($null -eq $reply) { Out-Result ([pscustomobject]@{ Status = "unknown"; Message = "تعذّر الاتصال بجهاز الطابعة." }) 1 }
        Out-Result $reply 0
    }

    if ($Mode -eq "Resolve") {
        if ($config.mode -eq "local") {
            $r = Get-LocalResolveResult $config $Root $lookup $InvoiceNumber $InvoiceDate
            Out-Result $r $(if ($r.Status -eq "ok") { 0 } else { 1 })
        }
        if ($InvoiceNumber -le 0) { Out-Result ([pscustomobject]@{ Status = "invalid_input"; Message = "أدخل رقم فاتورة صحيحاً." }) 1 }
        $command = "resolve $InvoiceNumber"
        if ($InvoiceDate) { $command += " $InvoiceDate" }
        try { $run = Invoke-CashierRemoteCommand $config $command } catch { $run = $null }
        $reply = $null
        if ($null -ne $run) { $reply = Get-CashierRemoteJson $run.Output }
        if ($null -eq $reply -or ($reply.Host -and $reply.Host -ne $config.remoteExpectedHostName)) {
            Out-Result ([pscustomobject]@{ Status = "remote_unreachable"; Message = "تعذّر الاتصال بجهاز الطابعة $($config.remoteExpectedHostName). لم يُرسل أي طلب طباعة." }) 1
        }
        Out-Result $reply $(if ($reply.Status -eq "ok") { 0 } else { 1 })
    }

    # Print
    if ([string]::IsNullOrWhiteSpace($RequestId)) { throw "الطباعة تتطلب -RequestId." }
    if ($config.mode -eq "local") {
        $r = Invoke-LocalPrint $config $Root $lookup $InvoiceNumber $InvoiceDate $RequestId $env:COMPUTERNAME
        Out-Result $r $(if ($r.Status -eq "sent") { 0 } else { 1 })
    }
    $r = Invoke-CashierRemotePrint -Config $config -Root $Root -Number $InvoiceNumber -Date $InvoiceDate -RequestId $RequestId
    Out-Result $r $(if ($r.Status -eq "sent") { 0 } else { 1 })
} catch {
    Out-Result ([pscustomobject]@{ Status = "error"; Message = [string]$_.Exception.Message }) 1
}
