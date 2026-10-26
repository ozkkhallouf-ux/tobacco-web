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
        expectedRendererSha256 = ([string]$raw.expectedRendererSha256).Trim().ToLowerInvariant()
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
        bridgeSqlSource = "user-env"
        enforceProtectedPaths = $false
        printDispatch = "direct"
        agentRequesterSids = @()
        agentPickupSeconds = 20
        agentResultTimeoutSeconds = 150
        agentHeartbeatMaxAgeSeconds = 30
    }
    foreach ($name in @("bridgeTimeoutSeconds", "recentReprintWarningSeconds", "newInvoiceWarningSeconds", "jobWatchSeconds", "remotePort", "remoteTimeoutSeconds",
            "agentPickupSeconds", "agentResultTimeoutSeconds", "agentHeartbeatMaxAgeSeconds")) {
        if ($null -ne $raw.PSObject.Properties[$name]) { $config[$name] = [int]$raw.$name }
    }
    foreach ($name in @("remoteHost", "remoteUser", "remoteKeyPath", "remoteKnownHostsPath", "remoteExpectedHostName")) {
        if ($null -ne $raw.PSObject.Properties[$name]) { $config[$name] = [Environment]::ExpandEnvironmentVariables([string]$raw.$name) }
    }
    if ($null -ne $raw.PSObject.Properties["bridgeSqlSource"]) { $config.bridgeSqlSource = ([string]$raw.bridgeSqlSource).Trim().ToLowerInvariant() }
    if ($config.bridgeSqlSource -ne "user-env" -and $config.bridgeSqlSource -ne "tool-secret") {
        throw "الإعداد bridgeSqlSource يجب أن يكون user-env أو tool-secret."
    }
    if ($null -ne $raw.PSObject.Properties["enforceProtectedPaths"]) {
        if ($raw.enforceProtectedPaths -isnot [bool]) { throw "الإعداد enforceProtectedPaths يجب أن يكون true أو false." }
        $config.enforceProtectedPaths = [bool]$raw.enforceProtectedPaths
    }
    if ($null -ne $raw.PSObject.Properties["printDispatch"]) { $config.printDispatch = ([string]$raw.printDispatch).Trim().ToLowerInvariant() }
    if ($config.printDispatch -ne "direct" -and $config.printDispatch -ne "agent") { throw "الإعداد printDispatch يجب أن يكون direct أو agent." }
    if ($null -ne $raw.PSObject.Properties["agentRequesterSids"]) {
        $config.agentRequesterSids = @(@($raw.agentRequesterSids) | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
    }
    foreach ($sid in $config.agentRequesterSids) {
        if ($sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$') { throw "الإعداد agentRequesterSids يقبل معرّفات حسابات محلية فقط (S-1-5-21-…): $sid" }
    }
    if ($config.printDispatch -eq "agent") {
        if ($mode -ne "local") { throw "printDispatch=agent يعمل على جهاز الطابعة فقط (mode=local)." }
        if ($config.agentRequesterSids.Count -eq 0) { throw "printDispatch=agent يتطلب agentRequesterSids (حساب الخدمة الذي يقدّم الطلبات)." }
        if ($config.agentPickupSeconds -lt 5 -or $config.agentPickupSeconds -gt 120) { throw "agentPickupSeconds خارج المدى 5–120." }
        if ($config.agentHeartbeatMaxAgeSeconds -lt 10 -or $config.agentHeartbeatMaxAgeSeconds -gt 300) { throw "agentHeartbeatMaxAgeSeconds خارج المدى 10–300." }
        if ($config.agentResultTimeoutSeconds -le $config.agentPickupSeconds -or $config.agentResultTimeoutSeconds -gt 600) {
            throw "agentResultTimeoutSeconds يجب أن يزيد على agentPickupSeconds ولا يتجاوز 600."
        }
        # Serve ينتظر طباعة كاملة: التقاط + تشغيل الجسر + مراقبة الطابور، وإلا أبلغ in_progress عن طلب سليم.
        if ($config.agentResultTimeoutSeconds -lt ($config.agentPickupSeconds + $config.bridgeTimeoutSeconds + $config.jobWatchSeconds)) {
            throw "agentResultTimeoutSeconds يجب ألا يقل عن agentPickupSeconds + bridgeTimeoutSeconds + jobWatchSeconds."
        }
    }
    if ($config.printerName -cne $script:CashierPrinterName) {
        throw "طابعة الكاشير الوحيدة المسموحة هي '$($script:CashierPrinterName)'."
    }
    if ($mode -eq "local") {
        # المسار قد يحمل %LOCALAPPDATA% (التثبيت الحالي: الجسر داخل ملف المستخدم نفسه)، لكنه يُفكّ
        # لحساب من يشغّل الأداة. حساب خدمة يحتاج مساراً مطلقاً ثابتاً (config.service.example.json).
        $config.bridgeScriptPath = [Environment]::ExpandEnvironmentVariables($config.bridgeScriptPath)
        if ([string]::IsNullOrWhiteSpace($config.bridgeScriptPath)) { throw "الإعداد bridgeScriptPath فارغ." }
        if ($config.bridgeScriptPath.Contains("%")) { throw "الإعداد bridgeScriptPath يحوي متغيراً غير معرَّف لهذا الحساب: $($config.bridgeScriptPath)" }
        if (-not [IO.Path]::IsPathRooted($config.bridgeScriptPath) -or $config.bridgeScriptPath.StartsWith("\\") -or
            [IO.Path]::GetExtension($config.bridgeScriptPath) -ine ".ps1") {
            throw "الإعداد bridgeScriptPath يجب أن يكون مساراً محلياً مطلقاً لملف .ps1: $($config.bridgeScriptPath)"
        }
        if ($config.expectedBridgeSha256 -notmatch '^[0-9a-f]{64}$') { throw "الإعداد expectedBridgeSha256 ليس بصمة SHA256 صحيحة." }
        if ($config.expectedRendererSha256 -ne "" -and $config.expectedRendererSha256 -notmatch '^[0-9a-f]{64}$') { throw "الإعداد expectedRendererSha256 ليس بصمة SHA256 صحيحة." }
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

# سلسلة اتصال الجسر حين bridgeSqlSource=tool-secret: من سرّ الأداة نفسه (لا سرّ جديد)، وبالقيود نفسها.
function Get-CashierBridgeSqlConnectionString([string]$Secret) {
    Add-Type -AssemblyName System.Data
    if ([string]::IsNullOrWhiteSpace($Secret)) { throw "سرّ اتصال القراءة فارغ." }
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $Secret
    if (-not $builder.UserID) { throw "مرفوض: سلسلة اتصال الجسر بلا User Id." }
    if ($builder.UserID -ieq "sa") { throw "مرفوض: حساب sa لا يُستعمل لإعادة الطباعة." }
    $builder["ApplicationIntent"] = "ReadOnly"
    return $builder.ConnectionString
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

# ملف رسم الإيصال الذي يستورده الجسر من مجلده. بصمته اختيارية (expectedRendererSha256)، وحين
# تُضبط تصير شرطاً للطباعة مثل بصمة الجسر: نسخة الجسر الثابتة لحساب الخدمة تحتاج renderer بلا CIM.
function Get-CashierRendererPath($Config) {
    return (Join-Path (Split-Path -Parent $Config.bridgeScriptPath) "ozk-print-bridge\OzkReceiptRenderer.psm1")
}

function Assert-CashierRendererPinned($Config) {
    if ([string]::IsNullOrEmpty($Config.expectedRendererSha256)) { return "" }
    $path = Get-CashierRendererPath $Config
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "ملف رسم الإيصال للجسر غير موجود على هذا الجهاز: $path" }
    $actual = Get-CashierFileSha256 $path
    if ($actual -ne $Config.expectedRendererSha256) {
        throw "نسخة رسم الإيصال على هذا الجهاز تغيّرت (البصمة $($actual.Substring(0,12))…) ولم تُعتمد لإعادة الطباعة. لن تُطبع أي فاتورة."
    }
    return $actual
}

# ── الملفات التي تُنفَّذ: لا كتابة عليها لغير المدراء والنظام وصاحب التشغيل ────────
# إن استطاع مستخدم عادي تعديل سكربت أو إعداد يشغّله حساب أعلى (المدير عبر ssh اليوم) فهذا
# طريق رفع صلاحيات. الفحص يشمل البرنامج والإعداد والسرّ والجسر وملفات الكود بجانبه، ولا يشمل
# مجلدات البيانات (logs وrequests وlocks) لأنها لا تُنفَّذ.
$script:CashierWriteRightsMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
$script:CashierCodeExtensions = @(".ps1", ".psm1", ".psd1", ".dll", ".exe", ".cs", ".cmd", ".bat", ".vbs", ".js")

function Get-CashierTrustedSids {
    $sids = New-Object System.Collections.Generic.List[string]
    foreach ($s in @("S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")) { $sids.Add($s) }
    try { $sids.Add([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) } catch { $null = $_ }
    return $sids.ToArray()
}

function Test-CashierWriteRiskAce([string]$Sid, [int64]$Rights, [string]$Type, [bool]$InheritOnly, [string[]]$TrustedSids) {
    if ($Type -ne "Allow" -or $InheritOnly) { return $false }
    if ($TrustedSids -contains $Sid) { return $false }
    return (($Rights -band $script:CashierWriteRightsMask) -ne 0)
}

function Get-CashierProtectedPaths($Config, [string]$Root) {
    $paths = New-Object System.Collections.Generic.List[string]
    $app = Join-Path $Root "app"
    foreach ($p in @($Root, $app, (Join-Path $Root "config.json"), (Join-Path $Root "sql.secret"))) { $paths.Add($p) }
    if (Test-Path -LiteralPath $app -PathType Container) {
        foreach ($f in @(Get-ChildItem -LiteralPath $app -File -ErrorAction SilentlyContinue)) { $paths.Add($f.FullName) }
    }
    if ($Config.mode -eq "local" -and -not [string]::IsNullOrWhiteSpace($Config.bridgeScriptPath)) {
        $bridgeDir = Split-Path -Parent $Config.bridgeScriptPath
        $paths.Add($Config.bridgeScriptPath)
        $paths.Add($bridgeDir)
        if (Test-Path -LiteralPath $bridgeDir -PathType Container) {
            foreach ($f in @(Get-ChildItem -LiteralPath $bridgeDir -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $script:CashierCodeExtensions -contains $_.Extension.ToLowerInvariant() })) {
                $paths.Add($f.FullName)
            }
            foreach ($d in @(Get-ChildItem -LiteralPath $bridgeDir -Directory -Recurse -ErrorAction SilentlyContinue)) { $paths.Add($d.FullName) }
        }
    }
    return @($paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -Unique)
}

# يعيد سطراً لكل صلاحية كتابة خطرة: «المسار: المعرّف (الصلاحية)». القائمة الفارغة = سليم.
function Get-CashierPathWriteRisks([string[]]$Paths, [string[]]$TrustedSids = (Get-CashierTrustedSids), [scriptblock]$GetAcl = { param($p) Get-Acl -LiteralPath $p }) {
    $risks = New-Object System.Collections.Generic.List[string]
    foreach ($path in $Paths) {
        try { $acl = & $GetAcl $path }
        catch { $risks.Add("${path}: تعذّرت قراءة الصلاحيات"); continue }
        try {
            $owner = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
        } catch { $owner = [string]$acl.Owner }
        if ($TrustedSids -notcontains $owner) { $risks.Add("${path}: المالك $($acl.Owner)") }
        foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
            $inheritOnly = ([int]$rule.PropagationFlags -band 2) -ne 0
            if (Test-CashierWriteRiskAce ([string]$rule.IdentityReference.Value) ([int64]$rule.FileSystemRights) ([string]$rule.AccessControlType) $inheritOnly $TrustedSids) {
                $name = [string]$rule.IdentityReference.Value
                try { $name = $rule.IdentityReference.Translate([Security.Principal.NTAccount]).Value } catch { $null = $_ }
                $risks.Add("${path}: $name ($($rule.FileSystemRights))")
            }
        }
    }
    return $risks.ToArray()
}

function Assert-CashierProtectedPaths($Config, [string]$Root, [scriptblock]$GetAcl = { param($p) Get-Acl -LiteralPath $p }) {
    $risks = @(Get-CashierPathWriteRisks (Get-CashierProtectedPaths $Config $Root) (Get-CashierTrustedSids) $GetAcl)
    if ($risks.Count -gt 0) {
        throw "ملفات البرنامج أو الجسر قابلة للكتابة من حساب غير موثوق، فلن تُطبع أي فاتورة: $($risks[0])"
    }
}

# شرط الطباعة: بصمة الجسر دائماً، وبصمة الـrenderer حين تُضبط، وحماية الملفات المنفَّذة حين enforceProtectedPaths=true.
function Assert-CashierBridgeReady($Config, [string]$Root) {
    $hash = Assert-CashierBridgePinned $Config
    [void](Assert-CashierRendererPinned $Config)
    if ($Config.enforceProtectedPaths) { Assert-CashierProtectedPaths $Config $Root }
    return $hash
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
    "Printer queue not found", "Printer queue not ready", "OpenPrinter failed", "StartDocPrinter failed", "Cashier receipts are restricted",
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

# SqlConnectionString غير فارغ ⇒ يُمرَّر للجسر متغيّر Process اسمه AMEEN_SQL_CONNECTION_STRING للعملية
# الفرعية وحدها (لا يُكتب على القرص ولا في الوسائط). الجسر يقدّم متغيّر User إن وُجد، فلا يتغيّر
# سلوك حساب له متغيّره الخاص. فارغ ⇒ لا تغيير إطلاقاً عن السلوك السابق.
function New-CashierBridgeStartInfo($Config, [int]$Number, [string]$Date, [string]$SqlConnectionString = "") {
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
    if (-not [string]::IsNullOrEmpty($SqlConnectionString)) { $info.EnvironmentVariables["AMEEN_SQL_CONNECTION_STRING"] = $SqlConnectionString }
    return $info
}

function Invoke-CashierBridgeProcess($Config, [int]$Number, [string]$Date, [string]$SqlConnectionString = "") {
    $info = New-CashierBridgeStartInfo $Config $Number $Date $SqlConnectionString
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

# ── طابور Windows عبر winspool مباشرة ─────────────────────────────────────────
# حساب الخدمة يدخل عبر ssh دخول شبكة (LogonType 3)، وWMI/CIM يرفض هذا الدخول لغير المدراء
# (Get-Printer وGet-PrintJob ⇒ Access denied). winspool يعمل بصلاحية الطباعة نفسها التي يطبع بها الجسر.
$script:CashierSpoolSource = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OzkCashierSpool {
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetPrinter(IntPtr handle, int level, IntPtr buffer, int size, out int needed);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetJob(IntPtr handle, int jobId, int level, IntPtr buffer, int size, out int needed);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PRINTER_INFO_2 {
        public string pServerName, pPrinterName, pShareName, pPortName, pDriverName, pComment, pLocation;
        public IntPtr pDevMode;
        public string pSepFile, pPrintProcessor, pDatatype, pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, cJobs, AveragePPM;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEMTIME { public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct JOB_INFO_1 {
        public uint JobId;
        public string pPrinterName, pMachineName, pUserName, pDocument, pDatatype, pStatus;
        public uint Status, Priority, Position, TotalPages, PagesPrinted;
        public SYSTEMTIME Submitted;
    }

    static IntPtr Open(string name) {
        IntPtr handle;
        if (!OpenPrinter(name, out handle, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return handle;
    }

    // [PortName, Status]
    public static string[] PrinterInfo(string name) {
        IntPtr handle = Open(name);
        IntPtr buffer = IntPtr.Zero;
        try {
            int needed;
            GetPrinter(handle, 2, IntPtr.Zero, 0, out needed);
            if (needed <= 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            buffer = Marshal.AllocHGlobal(needed);
            if (!GetPrinter(handle, 2, buffer, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(buffer, typeof(PRINTER_INFO_2));
            return new string[] { info.pPortName, info.Status.ToString() };
        } finally {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            ClosePrinter(handle);
        }
    }

    // -1: المهمة لم تعد في الطابور (ERROR_INVALID_PARAMETER). غير ذلك: بتات JOB_STATUS.
    public static long JobStatus(string name, int jobId) {
        IntPtr handle = Open(name);
        IntPtr buffer = IntPtr.Zero;
        try {
            int needed;
            if (!GetJob(handle, jobId, 1, IntPtr.Zero, 0, out needed)) {
                int error = Marshal.GetLastWin32Error();
                if (error == 87) return -1;
                if (error != 122 || needed <= 0) throw new Win32Exception(error);
            }
            buffer = Marshal.AllocHGlobal(needed);
            if (!GetJob(handle, jobId, 1, buffer, needed, out needed)) {
                int error = Marshal.GetLastWin32Error();
                if (error == 87) return -1;
                throw new Win32Exception(error);
            }
            JOB_INFO_1 job = (JOB_INFO_1)Marshal.PtrToStructure(buffer, typeof(JOB_INFO_1));
            return job.Status;
        } finally {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
            ClosePrinter(handle);
        }
    }
}
"@

function Initialize-CashierSpool {
    if (-not ("OzkCashierSpool" -as [type])) { Add-Type -TypeDefinition $script:CashierSpoolSource }
}

function Get-CashierPrinterInfo([string]$Name) {
    Initialize-CashierSpool
    $info = [OzkCashierSpool]::PrinterInfo($Name)
    $status = [uint32]$info[1]
    $text = "Normal"
    if ($status -ne 0) { $text = "0x{0:X}" -f $status }
    return [pscustomobject]@{ PortName = [string]$info[0]; Status = $status; StatusText = $text }
}

function Get-CashierSpoolJobStatus([string]$PrinterName, [int]$JobId) {
    Initialize-CashierSpool
    return [int64][OzkCashierSpool]::JobStatus($PrinterName, $JobId)
}

# ── تأكيد ما بعد الإرسال: ما يمكن إثباته من طابور Windows فقط ───────────────────
# spooler_completed: المهمة غادرت الطابور بلا خطأ (سلّمها Windows للطابعة؛ ليس دليلاً ورقياً).
# printer_error: المهمة عالقة بحالة خطأ (ورق، غطاء، انقطاع USB…).
# queued: ما زالت في الطابور عند انتهاء المراقبة.
# unknown: تعذّرت قراءة الطابور.
# بتات JOB_STATUS: ERROR 0x2، OFFLINE 0x20، PAPEROUT 0x40، BLOCKED_DEVQ 0x200، USER_INTERVENTION 0x400.
$script:CashierJobErrorBits = 0x2 -bor 0x20 -bor 0x40 -bor 0x200 -bor 0x400

function Watch-CashierPrintJob($Config, [int]$JobId, [scriptblock]$GetStatus = { param($p, $j) Get-CashierSpoolJobStatus $p $j }) {
    $deadline = (Get-Date).AddSeconds([math]::Max(1, $Config.jobWatchSeconds))
    try {
        while ($true) {
            $status = [int64](& $GetStatus $script:CashierPrinterName $JobId)
            if ($status -lt 0) { return "spooler_completed" }
            if (($status -band $script:CashierJobErrorBits) -ne 0) { return "printer_error" }
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
        [scriptblock]$BridgeCheck = { param($c, $r) Assert-CashierBridgeReady $c $r },
        [scriptblock]$BridgeSql = { param($c) "" },
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

    try { $bridgeHash = & $BridgeCheck $Config $Root }
    catch { return (Complete "blocked" ([string]$_.Exception.Message) @{ reason = "bridge_not_pinned" }) }

    try { $bridgeSqlText = [string](& $BridgeSql $Config) }
    catch { return (Complete "blocked" "تعذّر تجهيز اتصال القراءة للجسر على هذا الجهاز، فلم تُطبع أي فاتورة." @{ reason = "bridge_sql_unavailable"; errorType = $_.Exception.GetType().FullName }) }

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
        $run = & $Runner $Config $Number $invoice.InvoiceDate $bridgeSqlText
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

# ── العامل المحلي (printDispatch=agent) ───────────────────────────────────────
# حساب الخدمة يدخل عبر ssh دخول شبكة (LogonType 3) بلا Administrators ولا INTERACTIVE. مهامه تُقبل
# في الطابور وتصل بياناتها كاملة، ثم تعلق «Error, Printing» عند إخراجها إلى منفذ USB003 (C5b وC5c)،
# بينما كل مهمة لهوية تفاعلية تُطبع (الجسر التلقائي، والواجهة). لذلك لا يطبع Serve بنفسه في هذا الوضع:
# يكتب «تذكرة» في inbox، والعامل — مهمة مجدولة بهوية تفاعلية محدودة على جهاز الطابعة، مثل الجسر
# التلقائي — يلتقطها ويطبع عبر Invoke-CashierReprint نفسه (حجز المعرّف، القفل، الحسم، السجل).
#
# ضمانات لا تُكسر:
#   - التذكرة تُنشأ حصرياً (CreateNew): المعرّف نفسه لا يدخل مرتين، وحجز requests\ يبقى خط الدفاع الثاني.
#   - العامل يقبل تذكرة يملكها حساب من agentRequesterSids فقط، بصيغة ضيقة وحجم محدود.
#   - مهلة الالتقاط: تذكرة أقدم من agentPickupSeconds تُرفض بعد نقلها إلى processing\ (النقل ذرّي)،
#     فإن رآها Serve ما زالت في inbox بعد المهلة وهامشها، فهي لن تُطبع يقيناً. بعد انقطاع الكهرباء
#     لا تُطبع تذكرة قديمة أبداً.
#   - تذكرة وُجدت في processing\ عند بدء العامل (انقطع أثناءها) لا تُعاد: تُحسم من السجل وحجز requests\.
$script:CashierAgentTicketMaxBytes = 4096
$script:CashierAgentPickupMarginSeconds = 3

function Get-CashierAgentPaths([string]$Root) {
    $base = Join-Path $Root "agent"
    return [pscustomobject]@{
        Base = $base
        Inbox = Join-Path $base "inbox"
        Processing = Join-Path $base "processing"
        Results = Join-Path $base "results"
        Rejected = Join-Path $base "rejected"
        Heartbeat = Join-Path $base "heartbeat"
    }
}

function Initialize-CashierAgentFolders([string]$Root) {
    $paths = Get-CashierAgentPaths $Root
    foreach ($dir in @($paths.Base, $paths.Inbox, $paths.Processing, $paths.Results, $paths.Rejected)) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    }
    return $paths
}

function ConvertTo-CashierAgentId([string]$RequestId) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($RequestId, [ref]$parsed) -or $parsed -eq [guid]::Empty) { throw "معرّف الطلب غير صالح." }
    return $parsed
}

# يكتب التذكرة حصرياً. false ⇒ تذكرة بالمعرّف نفسه موجودة (لا تُكتب ثانية).
function New-CashierAgentTicket([string]$Root, [int]$Number, [string]$Date, [string]$RequestId, [string]$RequestedFrom, [datetime]$NowUtc = [datetime]::UtcNow) {
    $id = ConvertTo-CashierAgentId $RequestId
    if ($Number -le 0) { throw "رقم الفاتورة غير صالح." }
    if ($Date -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "تاريخ الفاتورة غير صالح." }
    if ($RequestedFrom -notmatch '^[A-Za-z0-9-]{1,15}$') { throw "اسم الجهاز الطالب غير صالح." }
    $inbox = (Get-CashierAgentPaths $Root).Inbox
    $path = Join-Path $inbox ($id.ToString("N") + ".json")
    try {
        $stream = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch [IO.IOException] {
        return $false
    }
    try {
        $body = [pscustomobject]@{ requestId = $id.ToString(); invoiceNumber = $Number; invoiceDate = $Date; requestedFrom = $RequestedFrom; createdAt = $NowUtc.ToString("o") } | ConvertTo-Json -Compress
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($body)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
    return $true
}

# يقرأ التذكرة ويتحقق من صيغتها كاملة؛ أي انحراف ⇒ استثناء (تُرفض ولا تُطبع).
function Read-CashierAgentTicket([string]$Path) {
    $info = Get-Item -LiteralPath $Path
    if ($info.Length -le 0 -or $info.Length -gt $script:CashierAgentTicketMaxBytes) { throw "حجم التذكرة غير مقبول." }
    $text = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false)))
    $raw = $text | ConvertFrom-Json
    $names = @($raw.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
    if (($names -join ",") -ne "createdAt,invoiceDate,invoiceNumber,requestedFrom,requestId") { throw "حقول التذكرة غير مطابقة." }
    $id = ConvertTo-CashierAgentId ([string]$raw.requestId)
    if ($id.ToString("N") + ".json" -ne $info.Name) { throw "اسم التذكرة لا يطابق معرّفها." }
    if ([string]$raw.invoiceNumber -notmatch '^\d{1,9}$' -or [int]$raw.invoiceNumber -le 0) { throw "رقم الفاتورة في التذكرة غير صالح." }
    if ([string]$raw.invoiceDate -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "تاريخ الفاتورة في التذكرة غير صالح." }
    if ([string]$raw.requestedFrom -notmatch '^[A-Za-z0-9-]{1,15}$') { throw "الجهاز الطالب في التذكرة غير صالح." }
    return [pscustomobject]@{ RequestId = $id.ToString(); InvoiceNumber = [int]$raw.invoiceNumber; InvoiceDate = [string]$raw.invoiceDate; RequestedFrom = [string]$raw.requestedFrom }
}

function Get-CashierFileOwnerSid([string]$Path) {
    $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier])
    return ([string]$owner.Value).ToUpperInvariant()
}

# النتيجة تُكتب مرة واحدة (ملف مؤقت ثم نقل)؛ نتيجة موجودة لا تُستبدل.
function Write-CashierAgentResult([string]$Root, [string]$RequestId, $Result) {
    $id = ConvertTo-CashierAgentId $RequestId
    $dir = (Get-CashierAgentPaths $Root).Results
    $final = Join-Path $dir ($id.ToString("N") + ".json")
    if (Test-Path -LiteralPath $final) { return $false }
    $tmp = Join-Path $dir ($id.ToString("N") + "." + [guid]::NewGuid().ToString("N") + ".tmp")
    $body = [pscustomobject]@{
        requestId = $id.ToString(); status = [string]$Result.Status; message = [string]$Result.Message
        confirmation = [string]$Result.Confirmation; at = [datetime]::UtcNow.ToString("o"); agentHost = $env:COMPUTERNAME
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding($false)))
    try { [IO.File]::Move($tmp, $final) }
    catch [IO.IOException] { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; return $false }
    return $true
}

function Read-CashierAgentResult([string]$Root, [string]$RequestId) {
    $id = ConvertTo-CashierAgentId $RequestId
    $path = Join-Path (Get-CashierAgentPaths $Root).Results ($id.ToString("N") + ".json")
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try { $raw = [IO.File]::ReadAllText($path, (New-Object Text.UTF8Encoding($false))) | ConvertFrom-Json }
    catch { return $null }
    return [pscustomobject]@{ Status = [string]$raw.status; Message = [string]$raw.message; Confirmation = [string]$raw.confirmation; At = [string]$raw.at }
}

function Write-CashierAgentHeartbeat([string]$Root) {
    $path = (Get-CashierAgentPaths $Root).Heartbeat
    [IO.File]::WriteAllText($path, [datetime]::UtcNow.ToString("o"), (New-Object Text.UTF8Encoding($false)))
}

# عمر آخر نبضة بالثواني، أو -1 إن لم يعمل العامل قط.
function Get-CashierAgentHeartbeatAge([string]$Root, [datetime]$NowUtc = [datetime]::UtcNow) {
    $path = (Get-CashierAgentPaths $Root).Heartbeat
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return -1 }
    return [int]($NowUtc - (Get-Item -LiteralPath $path).LastWriteTimeUtc).TotalSeconds
}

function Move-CashierAgentTicketToRejected([string]$Root, [string]$Path) {
    $target = Join-Path (Get-CashierAgentPaths $Root).Rejected ([IO.Path]::GetFileNameWithoutExtension($Path) + "." + [datetime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ") + ".json")
    try { [IO.File]::Move($Path, $target) } catch { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
}

$script:CashierAgentMessages = @{
    expired = "انتهت مهلة التقاط الطلب قبل أن يستلمه عامل الطباعة على جهاز الطابعة، فلم يُطبع شيء. يمكنك الضغط على «طباعة» من جديد."
    rejected = "رفض عامل الطباعة الطلب (صيغة أو مصدر غير مقبول)، فلم يُطبع شيء."
    interrupted_before_print = "انقطع عامل الطباعة قبل بدء الطباعة، فلم يُطبع شيء. يمكنك الضغط على «طباعة» من جديد."
    interrupted_uncertain = "انقطع عامل الطباعة أثناء الطلب، ولا يمكن تأكيد خروج الورقة. افحص الطابعة قبل أي محاولة جديدة."
}

# يعالج تذكرة واحدة من inbox: نقل ذرّي إلى processing، ثم الفحوص، ثم طباعة واحدة عبر $Print، ثم نتيجة.
# $Print: scriptblock يأخذ (number, date, requestId, requestedFrom) ويعيد {Status, Message, Confirmation}.
function Invoke-CashierAgentTicket {
    param(
        $Config,
        [string]$Root,
        [string]$TicketPath,
        [scriptblock]$Print,
        [scriptblock]$GetOwner = { param($p) Get-CashierFileOwnerSid $p },
        [scriptblock]$Clock = { [datetime]::UtcNow }
    )
    $paths = Get-CashierAgentPaths $Root
    $name = [IO.Path]::GetFileName($TicketPath)
    $claimed = Join-Path $paths.Processing $name
    try { [IO.File]::Move($TicketPath, $claimed) }
    catch { return $null }  # سبقه غيره أو اختفت التذكرة: لا شيء يُفعل

    $created = (Get-Item -LiteralPath $claimed).CreationTimeUtc
    $written = (Get-Item -LiteralPath $claimed).LastWriteTimeUtc
    $now = [datetime](& $Clock)
    $requestId = $null
    try { $requestId = (ConvertTo-CashierAgentId ([IO.Path]::GetFileNameWithoutExtension($name))).ToString() } catch { $requestId = $null }

    function Reject([string]$Status, [string]$Reason) {
        [void](Write-CashierReprintLog $Root ([pscustomobject]@{ event = "agent_$Status"; requestId = $requestId; reason = $Reason }))
        if ($null -ne $requestId) {
            [void](Write-CashierAgentResult $Root $requestId ([pscustomobject]@{ Status = $Status; Message = $script:CashierAgentMessages[$Status]; Confirmation = "" }))
        }
        Move-CashierAgentTicketToRejected $Root $claimed
        return [pscustomobject]@{ Status = $Status; Reason = $Reason; RequestId = $requestId }
    }

    # المهلة أولاً: بعد انقطاع الكهرباء أو توقف العامل لا تُطبع تذكرة قديمة مهما كان مصدرها.
    $ageCreated = ($now - $created).TotalSeconds
    $ageWritten = ($now - $written).TotalSeconds
    if ($ageCreated -gt $Config.agentPickupSeconds -or $ageWritten -gt $Config.agentPickupSeconds) { return (Reject "expired" "pickup_timeout") }
    if ($ageCreated -lt -5 -or $ageWritten -lt -5) { return (Reject "rejected" "clock_skew") }
    try { $owner = [string](& $GetOwner $claimed) } catch { $owner = "" }
    if (@($Config.agentRequesterSids) -notcontains $owner.ToUpperInvariant()) { return (Reject "rejected" "owner_not_allowed") }
    try { $ticket = Read-CashierAgentTicket $claimed } catch { return (Reject "rejected" "malformed") }

    try {
        $result = & $Print $ticket.InvoiceNumber $ticket.InvoiceDate $ticket.RequestId $ticket.RequestedFrom
    } catch {
        # خطأ غير متوقع خارج Invoke-CashierReprint: الحكم من الحجز والسجل، لا افتراض.
        $state = Get-CashierRequestStatus $Root $ticket.RequestId -IgnoreAgentTickets
        if ($state.Status -eq "not_received") { $result = [pscustomobject]@{ Status = "failed"; Message = $script:CashierAgentMessages.interrupted_before_print; Confirmation = "" } }
        else { $result = [pscustomobject]@{ Status = "uncertain"; Message = $script:CashierAgentMessages.interrupted_uncertain; Confirmation = "" } }
    }
    [void](Write-CashierAgentResult $Root $ticket.RequestId $result)
    Remove-Item -LiteralPath $claimed -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Status = [string]$result.Status; Reason = ""; RequestId = $ticket.RequestId }
}

# عند بدء العامل: ما بقي في processing\ انقطع أثناء معالجته ⇒ يُحسم ولا يُعاد أبداً.
function Restore-CashierAgentState([string]$Root) {
    $paths = Initialize-CashierAgentFolders $Root
    $recovered = New-Object System.Collections.Generic.List[object]
    foreach ($file in @(Get-ChildItem -LiteralPath $paths.Processing -File -Filter "*.json" -ErrorAction SilentlyContinue)) {
        $requestId = $null
        try { $requestId = (ConvertTo-CashierAgentId $file.BaseName).ToString() } catch { $requestId = $null }
        if ($null -ne $requestId -and $null -eq (Read-CashierAgentResult $Root $requestId)) {
            $state = Get-CashierRequestStatus $Root $requestId -IgnoreAgentTickets
            if ($state.Status -eq "not_received") {
                $result = [pscustomobject]@{ Status = "failed"; Message = $script:CashierAgentMessages.interrupted_before_print; Confirmation = "" }
            } elseif ($state.Status -eq "in_progress") {
                $result = [pscustomobject]@{ Status = "uncertain"; Message = $script:CashierAgentMessages.interrupted_uncertain; Confirmation = "" }
                [void](Write-CashierReprintLog $Root ([pscustomobject]@{ event = "reprint_uncertain"; requestId = $requestId; reason = "agent_interrupted" }))
            } else {
                $result = [pscustomobject]@{ Status = $state.Status; Message = "انقطع عامل الطباعة بعد انتهاء الطلب. الحالة المسجّلة: $($state.Status)."; Confirmation = $state.Confirmation }
            }
            [void](Write-CashierAgentResult $Root $requestId $result)
        }
        [void](Write-CashierReprintLog $Root ([pscustomobject]@{ event = "agent_recovered"; requestId = $requestId }))
        Move-CashierAgentTicketToRejected $Root $file.FullName
        $recovered.Add($requestId)
    }
    return $recovered.ToArray()
}

# دورة واحدة: كل تذاكر inbox بترتيب إنشائها، واحدة تلو الأخرى.
function Invoke-CashierAgentPass {
    param(
        $Config,
        [string]$Root,
        [scriptblock]$Print,
        [scriptblock]$GetOwner = { param($p) Get-CashierFileOwnerSid $p },
        [scriptblock]$Clock = { [datetime]::UtcNow }
    )
    $paths = Get-CashierAgentPaths $Root
    $handled = New-Object System.Collections.Generic.List[object]
    $tickets = @(Get-ChildItem -LiteralPath $paths.Inbox -File -ErrorAction SilentlyContinue | Sort-Object CreationTimeUtc)
    foreach ($ticket in $tickets) {
        if ($ticket.Extension -ine ".json") { Move-CashierAgentTicketToRejected $Root $ticket.FullName; continue }
        $outcome = Invoke-CashierAgentTicket -Config $Config -Root $Root -TicketPath $ticket.FullName -Print $Print -GetOwner $GetOwner -Clock $Clock
        if ($null -ne $outcome) { $handled.Add($outcome) }
    }
    return $handled.ToArray()
}

# جهة Serve (حساب الخدمة): تذكرة واحدة ثم انتظار النتيجة. لا طباعة هنا إطلاقاً.
function Submit-CashierAgentPrint {
    param(
        $Config,
        [string]$Root,
        [int]$Number,
        [string]$Date,
        [string]$RequestId,
        [string]$RequestedFrom,
        [scriptblock]$Clock = { [datetime]::UtcNow },
        [scriptblock]$Sleep = { Start-Sleep -Milliseconds 500 }
    )
    $id = (ConvertTo-CashierAgentId $RequestId).ToString()
    $age = Get-CashierAgentHeartbeatAge $Root ([datetime](& $Clock))
    if ($age -lt 0 -or $age -gt $Config.agentHeartbeatMaxAgeSeconds) {
        return [pscustomobject]@{ Status = "agent_unavailable"; Message = "عامل الطباعة لا يعمل الآن على $($env:COMPUTERNAME) (جلسة الكاشير غير مفتوحة؟). لم يُرسل أي طلب ولم يُطبع شيء."; Confirmation = "" }
    }
    if ((Get-CashierRequestStatus $Root $id).Status -ne "not_received") {
        return [pscustomobject]@{ Status = "duplicate_request"; Message = "هذا الطلب وصل سابقاً. لم تُرسل طباعة ثانية."; Confirmation = "" }
    }
    $start = [datetime](& $Clock)
    if (-not (New-CashierAgentTicket $Root $Number $Date $id $RequestedFrom $start)) {
        return [pscustomobject]@{ Status = "duplicate_request"; Message = "هذا الطلب وصل سابقاً. لم تُرسل طباعة ثانية."; Confirmation = "" }
    }
    $paths = Get-CashierAgentPaths $Root
    $ticketPath = Join-Path $paths.Inbox (([guid]$id).ToString("N") + ".json")
    $created = (Get-Item -LiteralPath $ticketPath).CreationTimeUtc
    $pickupDeadline = $created.AddSeconds($Config.agentPickupSeconds + $script:CashierAgentPickupMarginSeconds)
    $resultDeadline = $start.AddSeconds($Config.agentResultTimeoutSeconds)
    while ($true) {
        $result = Read-CashierAgentResult $Root $id
        if ($null -ne $result) { return [pscustomobject]@{ Status = $result.Status; Message = $result.Message; Confirmation = $result.Confirmation } }
        $now = [datetime](& $Clock)
        if ((Test-Path -LiteralPath $ticketPath -PathType Leaf) -and $now -gt $pickupDeadline) {
            # العامل يرفض أي تذكرة تجاوزت المهلة بعد التقاطها، فهذه لن تُطبع يقيناً.
            return [pscustomobject]@{ Status = "expired"; Message = $script:CashierAgentMessages.expired; Confirmation = "" }
        }
        if ($now -gt $resultDeadline) {
            return [pscustomobject]@{ Status = "in_progress"; Message = "استلم عامل الطباعة الطلب ولم تصل نتيجته بعد. لا تعد الطلب قبل فحص الطابعة."; Confirmation = "" }
        }
        & $Sleep
    }
}

# ── حالة طلب سابق (قراءة السجل فقط، بلا أي طباعة) ─────────────────────────────
# not_received: لم يُسجَّل الطلب على جهاز الطابعة إطلاقاً ⇒ لم يُطبع يقيناً (الحجز يسبق الطباعة).
# in_progress: سُجّل ولم تصل نتيجته بعد (يعمل الآن أو انقطع أثناء التنفيذ) ⇒ غير مؤكد.
# غير ذلك: آخر حالة نهائية مسجّلة لهذا المعرّف، أو نتيجة العامل المحلي إن وُجدت.
# تذكرة العامل في inbox\ أو processing\ ⇒ in_progress (وصل الطلب). IgnoreAgentTickets للعامل نفسه
# حين يحسم تذكرة انقطعت: يسأل «هل حُجز المعرّف وبدأت الطباعة؟» لا «هل وصلت التذكرة؟».
function Get-CashierRequestStatus([string]$Root, [string]$RequestId, [switch]$IgnoreAgentTickets) {
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($RequestId, [ref]$parsed)) { throw "معرّف الطلب غير صالح." }
    $requestFile = Join-Path (Join-Path $Root "requests") ($parsed.ToString("N") + ".json")
    $id = $parsed.ToString()
    if (-not $IgnoreAgentTickets) {
        $agentResult = Read-CashierAgentResult $Root $id
        if ($null -ne $agentResult) {
            return [pscustomobject]@{ Status = $agentResult.Status; Confirmation = $agentResult.Confirmation; At = $agentResult.At; Host = $env:COMPUTERNAME }
        }
    }
    $final = @(Read-CashierReprintLog $Root | Where-Object { $_.requestId -eq $id -and ([string]$_.event).StartsWith("reprint_") -and $_.event -ne "reprint_duplicate_request" })
    if ($final.Count -gt 0) {
        $last = $final[$final.Count - 1]
        return [pscustomobject]@{ Status = ([string]$last.event).Replace("reprint_", ""); Confirmation = [string]$last.confirmation; At = [string]$last.at; Host = [string]$last.host }
    }
    if (Test-Path -LiteralPath $requestFile -PathType Leaf) {
        return [pscustomobject]@{ Status = "in_progress"; Confirmation = ""; At = ""; Host = $env:COMPUTERNAME }
    }
    if (-not $IgnoreAgentTickets) {
        $agent = Get-CashierAgentPaths $Root
        foreach ($dir in @($agent.Inbox, $agent.Processing)) {
            if (Test-Path -LiteralPath (Join-Path $dir ($parsed.ToString("N") + ".json")) -PathType Leaf) {
                return [pscustomobject]@{ Status = "in_progress"; Confirmation = ""; At = ""; Host = $env:COMPUTERNAME }
            }
        }
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
# عميل OpenSSH: ميزة Windows المدمجة أولاً، ثم تثبيت OpenSSH المستقل (OZK2026 عليه هذا وحده).
function Find-CashierSshClient([string[]]$Candidates = @(
        (Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe"),
        (Join-Path $env:ProgramFiles "OpenSSH\ssh.exe"))) {
    foreach ($path in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
    }
    throw "عميل OpenSSH غير موجود على هذا الجهاز."
}

# يشغّل برنامجاً ومخرجاته إلى ملفات مؤقتة لا إلى pipe، ومدخله ملف فارغ (EOF فوري).
# OpenSSH 10.0p2 على OZK2026 لا ينتهي ما دام stdout مُحوَّلاً إلى pipe من .NET، فينتظر كل طلب
# حتى المهلة (180 ثانية) مع أن الرد وصل؛ مع الملفات ينتهي خلال ثانية تقريباً.
function Invoke-CashierFileRedirectedProcess([string]$FilePath, [string]$Arguments, [int]$TimeoutSeconds) {
    $base = Join-Path ([IO.Path]::GetTempPath()) ("ozk-cashier-" + [guid]::NewGuid().ToString("N"))
    $inFile = "$base.in"; $outFile = "$base.out"; $errFile = "$base.err"
    [IO.File]::WriteAllBytes($inFile, [byte[]]@())
    try {
        $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -PassThru `
            -RedirectStandardInput $inFile -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $null = $process.Handle  # يحفظ المقبض كي يبقى ExitCode متاحاً بعد الخروج
        $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        if ($timedOut) { try { $process.Kill() } catch { $null = $_ }; [void]$process.WaitForExit(5000) }
        $exitCode = -1
        if (-not $timedOut) { $exitCode = $process.ExitCode }
        $stdout = ""; $stderr = ""
        if (Test-Path -LiteralPath $outFile) { $stdout = [IO.File]::ReadAllText($outFile) }
        if (Test-Path -LiteralPath $errFile) { $stderr = [IO.File]::ReadAllText($errFile) }
        return [pscustomobject]@{ ExitCode = $exitCode; Output = $stdout; Error = $stderr; TimedOut = $timedOut }
    } finally {
        foreach ($f in @($inFile, $outFile, $errFile)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-CashierRemoteCommand($Config, [string]$Command) {
    $ssh = Find-CashierSshClient
    $arguments = @(
        "-n", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no",
        "-o", ('UserKnownHostsFile="{0}"' -f $Config.remoteKnownHostsPath), "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
        "-i", ('"{0}"' -f $Config.remoteKeyPath), "-p", [string]$Config.remotePort,
        ("{0}@{1}" -f $Config.remoteUser, $Config.remoteHost), ('"{0}"' -f $Command)
    )
    return (Invoke-CashierFileRedirectedProcess $ssh ($arguments -join " ") $Config.remoteTimeoutSeconds)
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
