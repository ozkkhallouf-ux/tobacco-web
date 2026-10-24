# إعادة طباعة فاتورة كاشير يدوياً — المنطق المشترك بين الواجهة وسطر الأوامر والاختبارات.
#
# الحدود (لا تُكسر):
#   - لا كتابة على الأمين: كل استعلام يمرّ بـAssert-CashierSelectOnly قبل الإرسال.
#   - لا مساس بجسر الطباعة التلقائية: لا قراءة ولا كتابة لـstate.json، ولا لمهمته ولا لملفاته.
#     الطباعة نفسها تتم باستدعاء الجسر المثبّت على الجهاز بوضعه اليدوي القائم
#     `-Mode PrintInvoice -InvoiceType Retail`، فيخرج الإيصال بتنسيق الطباعة التلقائية حرفياً.
#     ونسخة الجسر مثبّتة ببصمة SHA256 في الإعداد: نسخة غير معروفة ⇒ لا طباعة.
#   - فواتير «مبيعات مركز» (الكاشير) وحدها. فاتورة جملة لا تصل إلى الحرارية أبداً.
#   - لا بيانات زبائن ولا أصناف في السجل.
#
# متوافق مع Windows PowerShell 5.1 (هو ما يشغّله powershell.exe على الأجهزة).

$script:CashierRetailTypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"
$script:CashierPrinterName = "XPRINTER XP-T80Q 80MM"

function Get-CashierDefaultRoot {
    $programData = [Environment]::GetFolderPath("CommonApplicationData")
    if ([string]::IsNullOrWhiteSpace($programData)) { throw "تعذّر تحديد مجلد ProgramData." }
    return (Join-Path $programData "OZK\CashierReprint")
}

function Read-CashierReprintConfig([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "ملف الإعداد غير موجود: $Path" }
    $raw = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
    $mode = "local"
    if ($null -ne $raw.PSObject.Properties["mode"]) { $mode = ([string]$raw.mode).Trim().ToLowerInvariant() }
    if ($mode -ne "local" -and $mode -ne "remote") { throw "الإعداد mode يجب أن يكون local أو remote." }
    $config = [ordered]@{
        mode = $mode
        bridgeScriptPath = [string]$raw.bridgeScriptPath
        expectedBridgeSha256 = ([string]$raw.expectedBridgeSha256).Trim().ToLowerInvariant()
        printerName = [string]$raw.printerName
        bridgeTimeoutSeconds = 120
        recentReprintWarningSeconds = 120
        newInvoiceWarningSeconds = 120
        jobWatchSeconds = 20
        remoteHost = ""
        remoteUser = ""
        remotePort = 22
        remoteKeyPath = ""
        remoteKnownHostsPath = ""
        remoteTimeoutSeconds = 180
        remoteExpectedHostName = ""
    }
    foreach ($name in @("bridgeTimeoutSeconds", "recentReprintWarningSeconds", "newInvoiceWarningSeconds", "jobWatchSeconds", "remotePort", "remoteTimeoutSeconds")) {
        if ($null -ne $raw.PSObject.Properties[$name]) { $config[$name] = [int]$raw.$name }
    }
    foreach ($name in @("remoteHost", "remoteUser", "remoteKeyPath", "remoteKnownHostsPath", "remoteExpectedHostName")) {
        if ($null -ne $raw.PSObject.Properties[$name]) { $config[$name] = [Environment]::ExpandEnvironmentVariables([string]$raw.$name) }
    }
    if ($config.printerName -cne $script:CashierPrinterName) {
        throw "طابعة الكاشير الوحيدة المسموحة هي '$($script:CashierPrinterName)'."
    }
    if ($mode -eq "local") {
        # المسار قد يحمل %LOCALAPPDATA% لأن الجسر مثبّت داخل ملف المستخدم نفسه.
        $config.bridgeScriptPath = [Environment]::ExpandEnvironmentVariables($config.bridgeScriptPath)
        if ([string]::IsNullOrWhiteSpace($config.bridgeScriptPath)) { throw "الإعداد bridgeScriptPath فارغ." }
        if ($config.expectedBridgeSha256 -notmatch '^[0-9a-f]{64}$') { throw "الإعداد expectedBridgeSha256 ليس بصمة SHA256 صحيحة." }
        if ($config.bridgeTimeoutSeconds -lt 30 -or $config.bridgeTimeoutSeconds -gt 600) { throw "bridgeTimeoutSeconds خارج المدى 30–600." }
    } else {
        if ($config.remoteHost -notmatch '^[A-Za-z0-9.-]{1,253}$') { throw "الإعداد remoteHost غير صالح." }
        if ($config.remoteUser -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "الإعداد remoteUser غير صالح." }
        if ($config.remoteExpectedHostName -notmatch '^[A-Za-z0-9-]{1,15}$') { throw "الإعداد remoteExpectedHostName مطلوب (اسم جهاز الطابعة)." }
        if ([string]::IsNullOrWhiteSpace($config.remoteKeyPath) -or [string]::IsNullOrWhiteSpace($config.remoteKnownHostsPath)) {
            throw "الوضع البعيد يتطلب remoteKeyPath وremoteKnownHostsPath (مفتاح مقيَّد وبصمة الجهاز المعروفة)."
        }
        if ($config.remoteTimeoutSeconds -lt 30 -or $config.remoteTimeoutSeconds -gt 600) { throw "remoteTimeoutSeconds خارج المدى 30–600." }
    }
    return [pscustomobject]$config
}

# ── حارس القراءة فقط ────────────────────────────────────────────────────────────
function Assert-CashierSelectOnly([string]$Sql) {
    $text = [regex]::Replace($Sql, '(?s)/\*.*?\*/', ' ')
    $text = [regex]::Replace($text, '--[^\r\n]*', ' ')
    $text = $text.Trim()
    if ($text -notmatch '^(?i)select\s') { throw "مرفوض: الاستعلام ليس SELECT." }
    if ($text.TrimEnd(';').Contains(';')) { throw "مرفوض: أكثر من عبارة SQL." }
    if ($text -match '(?i)\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|into|openrowset|opendatasource|xp_|sp_)\b') {
        throw "مرفوض: الاستعلام يحوي كلمة كتابة أو تنفيذ."
    }
}

$script:CashierInvoiceLookupSql = @"
select top (50)
    convert(varchar(36), u.GUID) as invoice_guid,
    u.Number as invoice_number,
    convert(varchar(36), u.TypeGUID) as type_guid,
    bt.Name as type_name,
    bt.BillType as bill_type,
    convert(char(10), u.Date, 23) as invoice_date,
    u.CreateDate as create_date,
    u.IsPosted as is_posted,
    coalesce(u.RecState, 0) as record_state,
    u.Total as total,
    u.Cust_Name as customer_name
from dbo.bu000 u
join dbo.bt000 bt on bt.GUID = u.TypeGUID
where u.Number = @number
order by u.Date desc, u.CreateDate desc, u.GUID desc
"@

$script:CashierPrincipalProbeSql = @"
select
    db_name() as database_name,
    original_login() as login_name,
    is_srvrolemember('sysadmin') as is_sysadmin,
    is_rolemember('db_owner') as is_db_owner,
    is_rolemember('db_datawriter') as is_data_writer
"@

function Read-CashierSqlSecret([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "سرّ اتصال القراءة غير محفوظ على هذا الجهاز ($Path)." }
    Add-Type -AssemblyName System.Security
    $bytes = [IO.File]::ReadAllBytes($Path)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, [Text.Encoding]::UTF8.GetBytes("OZK-CashierReprint"),
        [Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [Text.Encoding]::UTF8.GetString($plain)
}

function Open-CashierReadOnlyConnection([string]$ConnectionString) {
    Add-Type -AssemblyName System.Data
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $ConnectionString
    if ($builder.UserID -ieq "sa") { throw "مرفوض: حساب sa لا يُستعمل لإعادة الطباعة." }
    $builder["Application Name"] = "OZK Cashier Reprint"
    $builder["ApplicationIntent"] = "ReadOnly"
    $builder["Enlist"] = $false
    $builder["Connect Timeout"] = 8
    $connection = New-Object System.Data.SqlClient.SqlConnection $builder.ConnectionString
    try {
        $connection.Open()
        Assert-CashierSelectOnly $script:CashierPrincipalProbeSql
        $command = $connection.CreateCommand()
        $command.CommandTimeout = 10
        $command.CommandText = $script:CashierPrincipalProbeSql
        $reader = $command.ExecuteReader()
        try {
            if (-not $reader.Read()) { throw "فحص حساب SQL لم يُرجع نتيجة." }
            $database = [string]$reader["database_name"]
            $writer = ([int]$reader["is_sysadmin"] -eq 1) -or ([int]$reader["is_db_owner"] -eq 1) -or ([int]$reader["is_data_writer"] -eq 1)
        } finally { $reader.Close() }
        if ($database -ne "AmnDb002") { throw "مرفوض: قاعدة البيانات '$database' وليست AmnDb002." }
        if ($writer) { throw "مرفوض: حساب SQL له صلاحية كتابة عامة (sysadmin/db_owner/db_datawriter)." }
        return $connection
    } catch {
        try { $connection.Dispose() } catch { $null = $_ }
        throw
    }
}

function Invoke-CashierInvoiceLookup($Connection, [int]$Number) {
    Assert-CashierSelectOnly $script:CashierInvoiceLookupSql
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 15
    $command.CommandText = $script:CashierInvoiceLookupSql
    [void]$command.Parameters.Add("@number", [System.Data.SqlDbType]::Int)
    $command.Parameters["@number"].Value = $Number
    $rows = New-Object System.Collections.Generic.List[object]
    $reader = $command.ExecuteReader()
    try {
        while ($reader.Read()) {
            $total = $null
            if (-not ($reader["total"] -is [DBNull])) { $total = [double]$reader["total"] }
            $created = $null
            if (-not ($reader["create_date"] -is [DBNull])) { $created = [datetime]$reader["create_date"] }
            $rows.Add([pscustomobject]@{
                InvoiceGuid = ([string]$reader["invoice_guid"]).ToLowerInvariant()
                InvoiceNumber = [int]$reader["invoice_number"]
                TypeGuid = ([string]$reader["type_guid"]).ToLowerInvariant()
                TypeName = [string]$reader["type_name"]
                BillType = [int]$reader["bill_type"]
                InvoiceDate = ([string]$reader["invoice_date"]).Trim()
                CreateDate = $created
                IsPosted = [bool]$reader["is_posted"]
                RecordState = [int]$reader["record_state"]
                Total = $total
                CustomerName = [string]$reader["customer_name"]
            })
        }
    } finally { $reader.Close() }
    return $rows.ToArray()
}

# ── حسم الرقم: لا طباعة إلا لفاتورة كاشير واحدة مرحّلة غير محذوفة ─────────────
# Status: ok | not_found | ambiguous | not_cashier | not_posted | invalid_input
function Resolve-CashierInvoice($Rows, [int]$Number, [string]$Date = "") {
    if ($Number -le 0) {
        return [pscustomobject]@{ Status = "invalid_input"; Message = "أدخل رقم فاتورة صحيحاً."; Invoice = $null; Choices = @() }
    }
    $all = @($Rows | Where-Object { $_.InvoiceNumber -eq $Number })
    if (-not [string]::IsNullOrWhiteSpace($Date)) {
        $all = @($all | Where-Object { $_.InvoiceDate -eq $Date })
    }
    $retail = @($all | Where-Object { $_.TypeGuid -eq $script:CashierRetailTypeGuid })
    $printable = @($retail | Where-Object { $_.BillType -eq 1 -and $_.IsPosted -and $_.RecordState -eq 0 })
    $dateText = ""
    if (-not [string]::IsNullOrWhiteSpace($Date)) { $dateText = " بتاريخ $Date" }

    if ($printable.Count -eq 1) {
        return [pscustomobject]@{ Status = "ok"; Message = ""; Invoice = $printable[0]; Choices = @() }
    }
    if ($printable.Count -gt 1) {
        $dates = @($printable | ForEach-Object { $_.InvoiceDate } | Select-Object -Unique)
        if ($dates.Count -eq $printable.Count) {
            return [pscustomobject]@{
                Status = "ambiguous"
                Message = "يوجد أكثر من فاتورة كاشير بالرقم $Number (بتواريخ: $($dates -join '، ')). اختر التاريخ الصحيح."
                Invoice = $null; Choices = $printable
            }
        }
        # تكرار بالرقم والتاريخ معاً: لا يمكن الحسم، والجسر نفسه يرفض هذه الحالة.
        return [pscustomobject]@{
            Status = "ambiguous"
            Message = "يوجد أكثر من فاتورة كاشير بالرقم $Number$dateText وبالتاريخ نفسه. لن تُطبع أي فاتورة؛ راجع الأمين."
            Invoice = $null; Choices = @()
        }
    }
    if ($retail.Count -gt 0) {
        return [pscustomobject]@{
            Status = "not_posted"
            Message = "فاتورة الكاشير رقم $Number$dateText موجودة لكنها غير مرحّلة أو محذوفة، فلا تُطبع."
            Invoice = $null; Choices = @()
        }
    }
    if ($all.Count -gt 0) {
        $names = @($all | ForEach-Object { $_.TypeName } | Select-Object -Unique)
        return [pscustomobject]@{
            Status = "not_cashier"
            Message = "الرقم $Number$dateText يخص فاتورة من نوع «$($names -join '»، «')» وليست فاتورة كاشير «مبيعات مركز». لا تُطبع على الطابعة الحرارية."
            Invoice = $null; Choices = @()
        }
    }
    return [pscustomobject]@{ Status = "not_found"; Message = "لا توجد فاتورة بالرقم $Number$dateText في الأمين."; Invoice = $null; Choices = @() }
}

# ── بصمة الجسر المثبّت ────────────────────────────────────────────────────────
function Get-CashierFileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-CashierBridgePinned($Config) {
    if (-not (Test-Path -LiteralPath $Config.bridgeScriptPath -PathType Leaf)) {
        throw "جسر الطباعة غير موجود على هذا الجهاز: $($Config.bridgeScriptPath)"
    }
    $actual = Get-CashierFileSha256 $Config.bridgeScriptPath
    if ($actual -ne $Config.expectedBridgeSha256) {
        throw "نسخة جسر الطباعة على هذا الجهاز تغيّرت (البصمة $($actual.Substring(0,12))…) ولم تُعتمد لإعادة الطباعة. لن تُطبع أي فاتورة."
    }
    return $actual
}

# ── السجل والطلبات ───────────────────────────────────────────────────────────
function Write-CashierReprintLog([string]$Root, $Entry) {
    try {
        $dir = Join-Path $Root "logs"
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        $record = [ordered]@{
            at = (Get-Date).ToUniversalTime().ToString("o")
            host = $env:COMPUTERNAME
            user = $env:USERNAME
        }
        foreach ($property in $Entry.PSObject.Properties) { $record[$property.Name] = $property.Value }
        $line = ([pscustomobject]$record) | ConvertTo-Json -Compress -Depth 5
        [IO.File]::AppendAllText((Join-Path $dir "manual-reprints.jsonl"), $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
        return $true
    } catch {
        return $false
    }
}

function Read-CashierReprintLog([string]$Root) {
    $path = Join-Path (Join-Path $Root "logs") "manual-reprints.jsonl"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @() }
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($line in [IO.File]::ReadAllLines($path, (New-Object Text.UTF8Encoding($false)))) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $items.Add(($line | ConvertFrom-Json)) } catch { $null = $_ }
    }
    return $items.ToArray()
}

# آخر طباعة يدوية ناجحة لنفس الفاتورة على هذا الجهاز (للتنبيه فقط، لا للمنع).
function Get-CashierLastReprint([string]$Root, [string]$InvoiceGuid) {
    $hits = @(Read-CashierReprintLog $Root | Where-Object { $_.event -eq "reprint_sent" -and $_.invoiceGuid -eq $InvoiceGuid })
    if ($hits.Count -eq 0) { return $null }
    return $hits[$hits.Count - 1]
}

# حجز معرّف الطلب بملف ينشأ حصرياً: إعادة المحاولة التقنية بالمعرّف نفسه تُرفض،
# وكل ضغطة «طباعة» صريحة جديدة تحمل معرّفاً جديداً فتمرّ.
function Register-CashierReprintRequest([string]$Root, [string]$RequestId, [int]$Number, [string]$Date) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($RequestId, [ref]$parsed) -or $parsed -eq [guid]::Empty) { throw "معرّف الطلب غير صالح." }
    $dir = Join-Path $Root "requests"
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    $path = Join-Path $dir ($parsed.ToString("N") + ".json")
    try {
        $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch [IO.IOException] {
        return $false
    }
    try {
        $body = ([pscustomobject]@{ requestId = $parsed.ToString(); invoiceNumber = $Number; invoiceDate = $Date; host = $env:COMPUTERNAME; at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json -Compress)
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($body)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    return $true
}

# قفل الفاتورة أثناء الإرسال: طلبان متزامنان لفاتورة واحدة ⇒ الثاني يُرفض.
function Enter-CashierInvoiceLock([string]$Root, [string]$InvoiceGuid) {
    $dir = Join-Path $Root "locks"
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    $path = Join-Path $dir ($InvoiceGuid.ToLowerInvariant() + ".lock")
    try {
        return (New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 1, [IO.FileOptions]::DeleteOnClose))
    } catch [IO.IOException] {
        return $null
    }
}

# ── تصنيف نتيجة الجسر ──────────────────────────────────────────────────────────
# printed: الجسر أنهى بنجاح وأعاد رقم مهمة طباعة.
# not_printed: الخطأ يقع يقيناً قبل إنشاء مهمة الطباعة (SQL، الحسم، الاستقرار، فتح الطابعة).
# uncertain: الخطأ بعد بدء المهمة أو مجهول أو انتهت المهلة — قد تكون الورقة خرجت.
$script:CashierPreSpoolErrorPatterns = @(
    "No posted invoice matched", "More than one posted invoice", "is not stable yet", "InvoiceNumber is required",
    "Missing required environment variable", "refuses database", "requires a db_datareader", "refuses a SQL principal",
    "Printer queue not found", "OpenPrinter failed", "StartDocPrinter failed", "Cashier receipts are restricted",
    "Receipt logo not found", "must be exactly 576 dots", "requires -ConfirmPhysicalPrint",
    "network-related", "Login failed", "Cannot open database", "Connection Timeout Expired", "server was not found",
    "transport-level error", "A connection was successfully established"
)

function Get-CashierBridgeOutcome([int]$ExitCode, [string]$Output, [bool]$TimedOut) {
    if ($TimedOut) {
        return [pscustomobject]@{ Outcome = "uncertain"; JobId = $null; Reason = "timeout" }
    }
    if ($ExitCode -eq 0) {
        $match = [regex]::Match($Output, '(?m)^\s*JobId\s*:\s*(\d+)')
        if ($match.Success) { return [pscustomobject]@{ Outcome = "printed"; JobId = [int]$match.Groups[1].Value; Reason = "" } }
        return [pscustomobject]@{ Outcome = "uncertain"; JobId = $null; Reason = "exit0_without_job" }
    }
    foreach ($pattern in $script:CashierPreSpoolErrorPatterns) {
        if ($Output.IndexOf($pattern, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [pscustomobject]@{ Outcome = "not_printed"; JobId = $null; Reason = $pattern }
        }
    }
    return [pscustomobject]@{ Outcome = "uncertain"; JobId = $null; Reason = "unclassified_error" }
}

function Invoke-CashierBridgeProcess($Config, [int]$Number, [string]$Date) {
    $powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $arguments = @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", ('"{0}"' -f $Config.bridgeScriptPath),
        "-Mode", "PrintInvoice",
        "-InvoiceType", "Retail",
        "-InvoiceNumber", [string]$Number,
        "-InvoiceDate", $Date,
        "-PrinterName", ('"{0}"' -f $script:CashierPrinterName),
        "-ConfirmPhysicalPrint"
    )
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $powershellPath
    $info.Arguments = ($arguments -join " ")
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($Config.bridgeTimeoutSeconds * 1000)
    if ($timedOut) {
        try { $process.Kill() } catch { $null = $_ }
        [void]$process.WaitForExit(5000)
    }
    $exitCode = -1
    if (-not $timedOut) { $exitCode = $process.ExitCode }
    $output = ""
    try { $output = $stdoutTask.Result + [Environment]::NewLine + $stderrTask.Result } catch { $null = $_ }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output; TimedOut = $timedOut }
}

# ── تأكيد ما بعد الإرسال: ما يمكن إثباته من طابور Windows فقط ───────────────────
# spooler_completed: المهمة غادرت الطابور بلا خطأ (سلّمها Windows للطابعة؛ ليس دليلاً ورقياً).
# printer_error: المهمة عالقة بحالة خطأ (ورق، غطاء، انقطاع USB…).
# queued: ما زالت في الطابور عند انتهاء المراقبة.
# unknown: تعذّرت قراءة الطابور.
function Watch-CashierPrintJob($Config, [int]$JobId) {
    $deadline = (Get-Date).AddSeconds([math]::Max(1, $Config.jobWatchSeconds))
    try {
        while ($true) {
            $job = @(Get-PrintJob -PrinterName $script:CashierPrinterName -ErrorAction Stop | Where-Object { $_.Id -eq $JobId })
            if ($job.Count -eq 0) { return "spooler_completed" }
            $state = [string]$job[0].JobStatus
            if ($state -match '(?i)error|offline|paperout|blocked|usersintervention') { return "printer_error" }
            if ((Get-Date) -ge $deadline) { return "queued" }
            Start-Sleep -Milliseconds 500
        }
    } catch {
        return "unknown"
    }
}

# ── تدفق الطباعة الكامل ────────────────────────────────────────────────────────
# $Lookup: scriptblock يأخذ رقم الفاتورة ويعيد صفوف الأمين (حقيقي أو وهمي في الاختبار).
# $Runner: scriptblock يأخذ (config, number, date) ويعيد {ExitCode, Output, TimedOut}.
function Invoke-CashierReprint {
    param(
        $Config,
        [string]$Root,
        [int]$Number,
        [string]$Date = "",
        [string]$RequestId,
        [scriptblock]$Lookup,
        [scriptblock]$Runner,
        [scriptblock]$BridgeCheck = { param($c) Assert-CashierBridgePinned $c },
        [scriptblock]$JobWatcher = { param($c, $j) Watch-CashierPrintJob $c $j },
        [string]$RequestedFrom = $env:COMPUTERNAME
    )
    $base = [ordered]@{ requestId = $RequestId; requestedFrom = $RequestedFrom; invoiceNumber = $Number; invoiceDate = $Date }

    function Complete([string]$Status, [string]$Message, $Extra) {
        $entry = [ordered]@{ event = "reprint_$Status" }
        foreach ($k in $base.Keys) { $entry[$k] = $base[$k] }
        if ($null -ne $Extra) { foreach ($k in $Extra.Keys) { $entry[$k] = $Extra[$k] } }
        [void](Write-CashierReprintLog $Root ([pscustomobject]$entry))
        return [pscustomobject]@{ Status = $Status; Message = $Message; Details = [pscustomobject]$entry }
    }

    if (-not (Register-CashierReprintRequest $Root $RequestId $Number $Date)) {
        return (Complete "duplicate_request" "هذا الطلب نُفّذ سابقاً (إعادة محاولة تقنية). لم تُرسل طباعة ثانية. لطباعة نسخة جديدة اضغط «طباعة» من جديد." $null)
    }

    try { $bridgeHash = & $BridgeCheck $Config }
    catch { return (Complete "blocked" ([string]$_.Exception.Message) @{ reason = "bridge_not_pinned" }) }

    try { $rows = @(& $Lookup $Number) }
    catch { return (Complete "connection_failed" "تعذّر الاتصال بقاعدة الأمين أو قراءتها. لم تُطبع أي فاتورة. تحقق من الشبكة ثم أعد المحاولة." @{ errorType = $_.Exception.GetType().FullName }) }

    $resolved = Resolve-CashierInvoice $rows $Number $Date
    if ($resolved.Status -ne "ok") {
        return (Complete $resolved.Status $resolved.Message $null)
    }
    $invoice = $resolved.Invoice
    $base.invoiceDate = $invoice.InvoiceDate
    $base.invoiceGuid = $invoice.InvoiceGuid

    $lock = Enter-CashierInvoiceLock $Root $invoice.InvoiceGuid
    if ($null -eq $lock) {
        return (Complete "busy" "هذه الفاتورة قيد الطباعة الآن من طلب آخر. انتظر انتهاءه." $null)
    }
    try {
        $run = & $Runner $Config $Number $invoice.InvoiceDate
        $outcome = Get-CashierBridgeOutcome $run.ExitCode $run.Output $run.TimedOut
        $extra = @{ bridgeSha256 = $bridgeHash; exitCode = $run.ExitCode; reason = $outcome.Reason; printer = $script:CashierPrinterName }
        if ($outcome.Outcome -eq "printed") {
            $extra.jobId = $outcome.JobId
            $confirmation = [string](& $JobWatcher $Config $outcome.JobId)
            $extra.confirmation = $confirmation
            $head = "أُرسلت الفاتورة رقم $Number ($($invoice.InvoiceDate)) إلى طابعة الكاشير على $($env:COMPUTERNAME)."
            switch ($confirmation) {
                "spooler_completed" { $tail = "سلّمها Windows للطابعة. تأكد من خروج الورقة." }
                "printer_error" { $tail = "لكن الطابعة أبلغت عن خطأ (ورق أو غطاء أو اتصال). افحصها قبل أي محاولة جديدة." }
                "queued" { $tail = "ما زالت في طابور الطابعة؛ قد تتأخر. لا تُعد الطلب قبل فحص الطابعة." }
                default { $tail = "تعذّر التحقق من طابور الطابعة؛ تأكد من خروج الورقة." }
            }
            return (Complete "sent" "$head $tail" $extra)
        }
        if ($outcome.Outcome -eq "not_printed") {
            return (Complete "failed" "تعذّرت الطباعة ولم تُرسل أي ورقة ($($outcome.Reason)). يمكنك إعادة المحاولة بأمان." $extra)
        }
        return (Complete "uncertain" "لم يتأكد خروج الورقة (قد تكون طُبعت). افحص الطابعة قبل أي محاولة جديدة." $extra)
    } finally {
        $lock.Dispose()
    }
}

# ── حالة طلب سابق (قراءة السجل فقط، بلا أي طباعة) ─────────────────────────────
# not_received: لم يُسجَّل الطلب على جهاز الطابعة إطلاقاً ⇒ لم يُطبع يقيناً (الحجز يسبق الطباعة).
# in_progress: سُجّل ولم تصل نتيجته بعد (يعمل الآن أو انقطع أثناء التنفيذ) ⇒ غير مؤكد.
# غير ذلك: آخر حالة نهائية مسجّلة لهذا المعرّف.
function Get-CashierRequestStatus([string]$Root, [string]$RequestId) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($RequestId, [ref]$parsed)) { throw "معرّف الطلب غير صالح." }
    $requestFile = Join-Path (Join-Path $Root "requests") ($parsed.ToString("N") + ".json")
    $id = $parsed.ToString()
    $final = @(Read-CashierReprintLog $Root | Where-Object { $_.requestId -eq $id -and $_.event -ne "reprint_duplicate_request" })
    if ($final.Count -gt 0) {
        $last = $final[$final.Count - 1]
        return [pscustomobject]@{ Status = ([string]$last.event).Replace("reprint_", ""); Confirmation = [string]$last.confirmation; At = [string]$last.at; Host = [string]$last.host }
    }
    if (Test-Path -LiteralPath $requestFile -PathType Leaf) {
        return [pscustomobject]@{ Status = "in_progress"; Confirmation = ""; At = ""; Host = $env:COMPUTERNAME }
    }
    return [pscustomobject]@{ Status = "not_received"; Confirmation = ""; At = ""; Host = $env:COMPUTERNAME }
}

# ── JSON بأحرف ASCII فقط: يعبر ssh وأي صفحة ترميز دون تشويه العربية ────────────
function ConvertTo-CashierAsciiJson($Object) {
    $json = $Object | ConvertTo-Json -Compress -Depth 6
    $builder = New-Object Text.StringBuilder
    foreach ($ch in $json.ToCharArray()) {
        if ([int]$ch -gt 126) { [void]$builder.AppendFormat("\u{0:x4}", [int]$ch) } else { [void]$builder.Append($ch) }
    }
    return $builder.ToString()
}

# ── الأمر البعيد: صيغة ضيقة جداً، وكل ما عداها مرفوض ──────────────────────────
#   resolve <number> [<yyyy-MM-dd>]
#   print <number> <yyyy-MM-dd> <request-guid> <requester-host>
#   status <request-guid>
function ConvertFrom-CashierRemoteCommand([string]$Text) {
    $t = ([string]$Text).Trim()
    $m = [regex]::Match($t, '^resolve (\d{1,9})(?: (\d{4}-\d{2}-\d{2}))?$')
    if ($m.Success) { return [pscustomobject]@{ Verb = "resolve"; Number = [int]$m.Groups[1].Value; Date = $m.Groups[2].Value; RequestId = ""; From = "" } }
    $m = [regex]::Match($t, '^print (\d{1,9}) (\d{4}-\d{2}-\d{2}) ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}) ([A-Za-z0-9-]{1,15})$')
    if ($m.Success) { return [pscustomobject]@{ Verb = "print"; Number = [int]$m.Groups[1].Value; Date = $m.Groups[2].Value; RequestId = $m.Groups[3].Value; From = $m.Groups[4].Value } }
    $m = [regex]::Match($t, '^status ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')
    if ($m.Success) { return [pscustomobject]@{ Verb = "status"; Number = 0; Date = ""; RequestId = $m.Groups[1].Value; From = "" } }
    throw "أمر بعيد مرفوض."
}

# يشغّل ssh بمفتاح مقيَّد وبصمة جهاز معروفة (StrictHostKeyChecking=yes)، بلا كلمات سر (BatchMode).
# النتيجة: {ExitCode, Output, TimedOut, Transport}. Transport=failed حين لم يُنشأ الاتصال أصلاً.
function Invoke-CashierRemoteCommand($Config, [string]$Command) {
    $ssh = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"
    if (-not (Test-Path -LiteralPath $ssh -PathType Leaf)) { throw "عميل OpenSSH غير موجود على هذا الجهاز." }
    $arguments = @(
        "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no",
        "-o", ('UserKnownHostsFile="{0}"' -f $Config.remoteKnownHostsPath), "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
        "-i", ('"{0}"' -f $Config.remoteKeyPath), "-p", [string]$Config.remotePort,
        ("{0}@{1}" -f $Config.remoteUser, $Config.remoteHost), ('"{0}"' -f $Command)
    )
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $ssh
    $info.Arguments = ($arguments -join " ")
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($info)
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $timedOut = -not $process.WaitForExit($Config.remoteTimeoutSeconds * 1000)
    if ($timedOut) { try { $process.Kill() } catch { $null = $_ }; [void]$process.WaitForExit(5000) }
    $exitCode = -1
    if (-not $timedOut) { $exitCode = $process.ExitCode }
    $stdout = ""; $stderr = ""
    try { $stdout = $stdoutTask.Result; $stderr = $stderrTask.Result } catch { $null = $_ }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $stdout; Error = $stderr; TimedOut = $timedOut }
}

function Get-CashierRemoteJson([string]$Output) {
    $line = @(([string]$Output) -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if ($line.Count -eq 0) { return $null }
    try { return ($line[0] | ConvertFrom-Json) } catch { return $null }
}

# طلب طباعة من جهاز بلا طابعة إلى جهاز الطابعة. لا إعادة طباعة تلقائية أبداً:
# عند انقطاع النتيجة يُسأل جهاز الطابعة عن حالة المعرّف نفسه (قراءة فقط)، والمعرّف المكرر
# يُرفض هناك، فلا تخرج ورقتان لطلب واحد مهما تكررت المحاولة.
function Invoke-CashierRemotePrint {
    param($Config, [string]$Root, [int]$Number, [string]$Date, [string]$RequestId, [scriptblock]$Transport = { param($c, $cmd) Invoke-CashierRemoteCommand $c $cmd })
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($RequestId, [ref]$parsed) -or $parsed -eq [guid]::Empty) { throw "معرّف الطلب غير صالح." }
    if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "الطلب البعيد يتطلب تاريخ الفاتورة المحسوم." }
    $id = $parsed.ToString()
    $command = "print $Number $Date $id $($env:COMPUTERNAME)"
    $log = [ordered]@{ requestId = $id; invoiceNumber = $Number; invoiceDate = $Date; target = $Config.remoteExpectedHostName }

    function Finish([string]$Status, [string]$Message, [string]$Confirmation = "") {
        $entry = [ordered]@{ event = "remote_$Status" }
        foreach ($k in $log.Keys) { $entry[$k] = $log[$k] }
        if ($Confirmation) { $entry.confirmation = $Confirmation }
        [void](Write-CashierReprintLog $Root ([pscustomobject]$entry))
        return [pscustomobject]@{ Status = $Status; Message = $Message }
    }

    $sendError = $null
    try { $run = & $Transport $Config $command } catch { $sendError = $_; $run = $null }
    $reply = $null
    if ($null -ne $run) { $reply = Get-CashierRemoteJson $run.Output }
    if ($null -ne $reply -and $reply.Host -and $reply.Host -ne $Config.remoteExpectedHostName) {
        return (Finish "wrong_host" "ردّ جهاز غير متوقع ($($reply.Host)) بدل $($Config.remoteExpectedHostName). لن يُعتمد الرد.")
    }
    if ($null -ne $reply -and $reply.Status) {
        return (Finish ([string]$reply.Status) ([string]$reply.Message) ([string]$reply.Confirmation))
    }

    # لا رد مفهوم: لا افتراض نجاح ولا فشل. نسأل عن المعرّف نفسه.
    $status = $null
    try {
        $probe = & $Transport $Config "status $id"
        $status = Get-CashierRemoteJson $probe.Output
    } catch { $status = $null }
    if ($null -eq $status -or -not $status.Status -or ($status.Host -and $status.Host -ne $Config.remoteExpectedHostName)) {
        return (Finish "unknown" "تعذّر الاتصال بجهاز الطابعة $($Config.remoteExpectedHostName)، ولا يمكن تأكيد هل وصل الطلب. لا تعد الطلب قبل فحص الطابعة أو حالة الطلب لاحقاً.")
    }
    switch ([string]$status.Status) {
        "not_received" { return (Finish "not_received" "لم يصل الطلب إلى جهاز الطابعة، فلم يُطبع شيء. يمكنك الضغط على «طباعة» من جديد.") }
        "in_progress" { return (Finish "unknown" "وصل الطلب إلى جهاز الطابعة ولم تُعرف نتيجته بعد. لا تعد الطلب قبل فحص الطابعة.") }
        default { return (Finish ([string]$status.Status) "انقطع الاتصال أثناء الطلب. الحالة المسجّلة على جهاز الطابعة: $($status.Status)." ([string]$status.Confirmation)) }
    }
}
