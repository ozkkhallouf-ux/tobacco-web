[CmdletBinding()]
param(
    [ValidateSet("Probe", "Benchmark", "Observe", "PreviewLatest", "PreviewInvoice", "PrintInvoice")]
    [string]$Mode = "Probe",

    [ValidateRange(0, 2147483647)]
    [int]$InvoiceNumber = 0,

    [datetime]$InvoiceDate = (Get-Date).Date,

    [ValidateSet("Retail", "Wholesale", "WholesaleSyp")]
    [string]$InvoiceType = "Retail",

    [ValidateRange(75, 5000)]
    [int]$PollMilliseconds = 150,

    [ValidateRange(20, 1000)]
    [int]$StabilityMilliseconds = 50,

    [ValidateRange(1, 7)]
    [int]$LookbackDays = 2,

    [ValidateRange(5, 500)]
    [int]$BenchmarkIterations = 50,

    [ValidateRange(0, 1000000)]
    [int]$MaxPolls = 0,

    [switch]$IncludeWholesale,

    [string]$PrinterName = "XPRINTER XP-T80Q 80MM",

    [string]$PreviewPath = (Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "OZK-TOBACCO\PrintBridge\latest-preview.png"),

    [switch]$ConfirmPhysicalPrint,

    [string]$StatePath = (Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "OZK-TOBACCO\PrintBridge\state.json"),

    [string]$LogPath = (Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "OZK-TOBACCO\PrintBridge\logs\events.jsonl")
)

$ErrorActionPreference = "Stop"
$script:RetailTypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"
$script:WholesaleTypeGuids = @(
    "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4",
    "4a827bee-6ae1-4474-802b-970068872fcc"
)
# --- Cashier-only responsibility boundary (P1-B) --------------------------------
# طباعة فواتير الجملة يملكها مراقب ameen-autoprint في المستودع (PR #208)، وهو
# يوجّهها إلى طابعة الفواتير الخاصة بها. هذا الجسر مسؤول عن الكاشير (Retail)
# فقط، ولا يملك أي مسار صالح لطباعة فاتورة جملة: طابعته الوحيدة هي الحرارية
# 80mm، وإرسال فاتورة جملة إليها عطل تجاري لا مجرد خطأ تنسيق. لذلك يُرفض النوع
# صراحةً قبل أي استعلام أو تصيير أو أمر طباعة — بلا fallback وبلا إعادة توجيه.
$script:CashierInvoiceTypes = @("Retail")

function Test-PermanentInvoiceFailure($ErrorRecord) {
    # صحيحة فقط للفشل الذي تحدّده محتويات الفاتورة وحدها، فتكراره مضمون ما دام
    # المحتوى ثابتاً — كتجاوز حدّ ارتفاع الإيصال. مصدرها الوحيد النوع المميِّز
    # OzkReceiptUnrenderableException. كل ما عداه يُعامل كعابر ويبقى قابلاً
    # لإعادة المحاولة: الافتراض الآمن هو المحاولة ثانيةً لا العزل.
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception.GetType().Name -eq "OzkReceiptUnrenderableException") { return $true }
        $exception = $exception.InnerException
    }
    return $false
}

# --- عزل الفواتير المتعذّر تصييرها -------------------------------------------
# طابور الطباعة يعالج الأقدم أولاً، فلو رمت فاتورة واحدة رمياً حتمياً قبل التسليم
# خرج الاستثناء من الحلقة، فيموت الجسر ويعيده الـwatchdog فيلقى الفاتورة نفسها
# أولاً ويفشل ثانيةً — بلا نهاية، وكل الإيصالات اللاحقة محجوبة.
#
# العزل منفصل تماماً عن seen: الفاتورة المعزولة ليست مطبوعة ولا يُدّعى ذلك، وهي
# تبقى مرئية في state.json وتُعلَن عند كل إقلاع لتُراجَع يدوياً.
#
# ليس عزلاً أبدياً: تُخزَّن بصمة محتوى الفاتورة معه. فإن تغيّر المحتوى تغيّرت
# البصمة وأُعيد تقييمها من جديد — نستعمل البصمة نفسها المستعملة لكشف التكرار،
# فلا منطق موازٍ قد ينحرف عنها.
function Get-QuarantineDecision($State, [string]$InvoiceGuid, [string]$Fingerprint) {
    if ($null -eq $State.quarantined -or -not $State.quarantined.ContainsKey($InvoiceGuid)) { return "proceed" }
    $entry = $State.quarantined[$InvoiceGuid]
    $storedFingerprint = ""
    if ($null -ne $entry) {
        # حالة تالفة أو قديمة بلا بصمة: تُعامل كتغيّر محتوى فتُعاد المحاولة،
        # ولا تُسقط الطابور ولا تُخفي الفاتورة صامتةً.
        try { $storedFingerprint = [string]$entry.fingerprint } catch { $storedFingerprint = "" }
    }
    if ([string]::IsNullOrWhiteSpace($storedFingerprint)) { return "reevaluate" }
    if ($storedFingerprint -eq $Fingerprint) { return "skip" }
    return "reevaluate"
}

function Add-QuarantineEntry($State, $Candidate, [string]$Fingerprint, $ErrorRecord) {
    if ($null -eq $State.quarantined) { $State.quarantined = @{} }
    $State.quarantined[$Candidate.InvoiceGuid] = [ordered]@{
        fingerprint = $Fingerprint
        invoiceNumber = $Candidate.InvoiceNumber
        category = "permanent_render_failure"
        errorType = $ErrorRecord.Exception.GetType().FullName
        reason = [string]$ErrorRecord.Exception.Message
        quarantinedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
}

function Test-PreSubmissionFailure($ErrorRecord) {
    # صحيحة فقط للفشل المثبت أنه وقع قبل قبول spooler ويندوز لأي مهمة طباعة.
    # مصدرها الوحيد OzkSpoolNotSubmittedException التي ترميها وحدة العرض عند
    # فشل OpenPrinter أو StartDocPrinter. أي فشل آخر بعد تلك النقطة يبقى غامضاً
    # ويُعامل على أنه ربما طُبع.
    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception.GetType().Name -eq "OzkSpoolNotSubmittedException") { return $true }
        $exception = $exception.InnerException
    }
    return $false
}

function Assert-CashierTypeGuid([string]$TypeGuid, [int]$InvoiceNumber) {
    if ([string]$TypeGuid -ne $script:RetailTypeGuid) {
        throw "Refusing to print invoice $InvoiceNumber : its type GUID '$TypeGuid' is not the cashier (Retail) type. Wholesale invoices are owned by the Ameen wholesale autoprint watcher and must never reach the cashier thermal printer."
    }
}

function Assert-CashierInvoiceType([string]$Name) {
    if ($script:CashierInvoiceTypes -notcontains $Name) {
        throw "OZK Print Bridge prints cashier (Retail) invoices only. Invoice type '$Name' is a wholesale type owned by the Ameen wholesale autoprint watcher; the cashier thermal printer must never receive it. Refusing before any query, render, or print."
    }
}

$script:ReceiptModulePath = Join-Path $PSScriptRoot "OzkReceiptRenderer.psm1"
$script:ReceiptLogoPath = Join-Path $PSScriptRoot "assets\ozk-receipt-horse-logo.png"

# --- Secondary duplicate-invoice safety net (Observe mode only) -----------------
# Ameen can save the SAME cashier sale twice within a few seconds and create a
# second bu000 row with a DIFFERENT GUID but identical Number/Type/Date/content.
# The primary dedup below (by GUID) treats that as a brand-new invoice and would
# print it again. This secondary layer compares a content fingerprint of every
# newly-detected GUID against fingerprints printed in the last N seconds and
# skips the print (never touches Ameen, never deletes/changes any record or
# GUID) when it looks like the same sale re-saved. Adjust the window here only.
$script:DuplicateFingerprintWindowSeconds = 60
# How long a fingerprint is kept in state.json before being pruned as stale.
# Kept well above the detection window so a bridge restart mid-window still
# has the fingerprint available; has no effect on the 60s suppression rule.
$script:DuplicateFingerprintRetentionSeconds = 3600

function Get-RequiredUserSetting([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable($Name, "User")
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required environment variable: $Name"
    }
    return $value
}

function Write-BridgeLog($EventObject) {
    try {
        $fullPath = [IO.Path]::GetFullPath($LogPath)
        $directory = [IO.Path]::GetDirectoryName($fullPath)
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $directory -Force)
        }
        $line = $EventObject | ConvertTo-Json -Compress -Depth 8
        [IO.File]::AppendAllText($fullPath, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    } catch {
        # التسجيل best-effort ولا يجوز أن يوقف كشف الفواتير أو طباعتها. لا نستعمل
        # Write-Error هنا: مع ErrorActionPreference=Stop يتحوّل إلى خطأ منهٍ فيُسقط
        # الجسر — وهو بالضبط ما يمنعه هذا الحارس. التجاهل مقصود، وهذا السطر يوثّقه.
        $null = $_
    }
}

function Convert-ToUtcText($Value) {
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    return ([datetime]$Value).ToUniversalTime().ToString("o")
}

function Convert-ToNullableDouble($Value) {
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    return [double]$Value
}

function Convert-ToNullableInt($Value) {
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    return [int]$Value
}

function New-ReadOnlyConnection {
    Add-Type -AssemblyName System.Data
    $source = Get-RequiredUserSetting "AMEEN_SQL_CONNECTION_STRING"
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $source
    $builder["Application Name"] = "OZK Print Bridge"
    $builder["ApplicationIntent"] = "ReadOnly"
    $builder["Enlist"] = $false
    $builder["Connect Timeout"] = [math]::Min([math]::Max($builder.ConnectTimeout, 3), 10)

    $connection = New-Object System.Data.SqlClient.SqlConnection $builder.ConnectionString
    $connection.Open()

    # Al-Ameen may briefly hold write locks while posting a bill. Reading uncommitted
    # prevents the 150ms detector from waiting behind those locks; the mandatory
    # double snapshot below still prevents printing a partially written invoice.
    $sessionCommand = $connection.CreateCommand()
    $sessionCommand.CommandTimeout = 3
    $sessionCommand.CommandText = "set transaction isolation level read uncommitted; set lock_timeout 1000;"
    [void]$sessionCommand.ExecuteNonQuery()

    $command = $connection.CreateCommand()
    $command.CommandTimeout = 15
    $command.CommandText = @"
select
    db_name() as database_name,
    original_login() as login_name,
    is_rolemember('db_datareader') as is_data_reader,
    is_rolemember('db_datawriter') as is_data_writer,
    is_rolemember('db_owner') as is_db_owner,
    has_perms_by_name(db_name(), 'DATABASE', 'INSERT') as can_insert_database,
    has_perms_by_name(db_name(), 'DATABASE', 'UPDATE') as can_update_database,
    has_perms_by_name(db_name(), 'DATABASE', 'DELETE') as can_delete_database,
    has_perms_by_name(db_name(), 'DATABASE', 'CREATE TABLE') as can_create_table,
    has_perms_by_name(db_name(), 'DATABASE', 'EXECUTE') as can_execute_database,
    has_perms_by_name('dbo.bu000', 'OBJECT', 'INSERT') as can_insert_bu000,
    has_perms_by_name('dbo.bu000', 'OBJECT', 'UPDATE') as can_update_bu000,
    has_perms_by_name('dbo.bu000', 'OBJECT', 'DELETE') as can_delete_bu000,
    has_perms_by_name('dbo.bi000', 'OBJECT', 'INSERT') as can_insert_bi000,
    has_perms_by_name('dbo.bi000', 'OBJECT', 'UPDATE') as can_update_bi000,
    has_perms_by_name('dbo.bi000', 'OBJECT', 'DELETE') as can_delete_bi000;
"@
    $reader = $command.ExecuteReader()
    try {
        if (-not $reader.Read()) { throw "Ameen permission probe returned no result." }
        $database = [string]$reader["database_name"]
        $login = [string]$reader["login_name"]
        $readerRole = [int]$reader["is_data_reader"]
        $writeChecks = @(
            "is_data_writer", "is_db_owner", "can_insert_database", "can_update_database",
            "can_delete_database", "can_create_table", "can_execute_database",
            "can_insert_bu000", "can_update_bu000", "can_delete_bu000",
            "can_insert_bi000", "can_update_bi000", "can_delete_bi000"
        )
        $writeAllowed = @($writeChecks | Where-Object { [int]$reader[$_] -eq 1 })
    } finally {
        $reader.Close()
    }

    if ($database -ne "AmnDb002") {
        $connection.Close()
        throw "OZK Print Bridge refuses database '$database'; expected AmnDb002."
    }
    if ($readerRole -ne 1) {
        $connection.Close()
        throw "OZK Print Bridge requires a db_datareader account."
    }
    if ($writeAllowed.Count -ne 0) {
        $connection.Close()
        throw "OZK Print Bridge refuses a SQL principal with write permissions: $($writeAllowed -join ', ')."
    }

    return [pscustomobject]@{
        Connection = $connection
        Database = $database
        Login = $login
    }
}

# ── تمثيل قانوني موحّد لمحتوى الإيصال ───────────────────────────────────────
# مصدر واحد يغذّي استعمالين لهما عقدان مختلفان عمداً:
#
#  • توقيع الاستقرار (Wait-InvoiceReady): يقارن لقطتين لنفس الفاتورة بفارق
#    عشرات الأجزاء من الثانية، والاتصال READ UNCOMMITTED عمداً. فيجب أن يغطي
#    كل قيمة تُطبع فعلاً — ترويسةً وأسطراً — لا الأسطر وحدها، وإلا اعتُبرت
#    الفاتورة مستقرة بينما اسم الزبون أو الإجمالي أو الخصم أو الدفعة أو سعر
#    الصرف ما زال قيد الكتابة. يشمل هوية السجل (GUID، CreateDate، أرقام
#    الأسطر) لأن أي تبدّل فيها بين اللقطتين يعني أن الترحيل لم ينتهِ.
#
#  • بصمة التكرار (Get-InvoiceFingerprint): تقارن سجلَّين مختلفَي GUID لتحديد
#    ما إذا كانا نفس البيعة المحفوظة مرتين. فتستبعد كل ما يُولَّد من جديد عند
#    إعادة الحفظ (GUID الفاتورة، GUID الأسطر، أرقامها، CreateDate) وتعتمد
#    المحتوى المطبوع نفسه. الاعتماد على الإجمالي وعدد الأسطر وحدهما كان يقمع
#    فاتورةً مصحَّحة بمواد مختلفة تصادف تساوي إجماليها وعدد أسطرها.
#
# الحقول المشمولة هي بالضبط ما يقرأه Convert-SnapshotToReceipt ويرسمه
# OzkReceiptRenderer — لا حقل زائد لتوسيع الهاش بلا أثر على الورق.
$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture

function Format-CanonicalValue($Value) {
    if ($null -eq $Value -or $Value -is [DBNull]) { return "" }
    if ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single] -or
        $Value -is [int] -or $Value -is [long] -or $Value -is [short]) {
        # "R" بثقافة ثابتة: لا فاصلة عشرية محلية ولا تقريب يخفي فرقاً حقيقياً.
        return ([double]$Value).ToString("R", $script:InvariantCulture)
    }
    if ($Value -is [bool]) { return $(if ($Value) { "true" } else { "false" }) }
    return ([string]$Value).Trim()
}

function Get-CanonicalLineText($Line, [bool]$IncludeRecordIdentity) {
    $parts = New-Object System.Collections.Generic.List[string]
    if ($IncludeRecordIdentity) {
        $parts.Add((Format-CanonicalValue $Line.LineGuid))
        $parts.Add((Format-CanonicalValue $Line.LineNumber))
    }
    # المادة وكميتها ووحدتها وسعرها: كل هذه تظهر على الإيصال.
    $parts.Add((Format-CanonicalValue $Line.ItemGuid))
    $parts.Add((Format-CanonicalValue $Line.ItemName))
    $parts.Add((Format-CanonicalValue $Line.Qty))
    $parts.Add((Format-CanonicalValue $Line.SelectedUnit))
    $parts.Add((Format-CanonicalValue $Line.Unit2Factor))
    $parts.Add((Format-CanonicalValue $Line.RawPrice))
    return ($parts -join "|")
}

function Get-CanonicalReceiptText($Header, $Lines, [bool]$IncludeRecordIdentity, [string]$BranchGuid = "", $Balance = $null) {
    $head = New-Object System.Collections.Generic.List[string]
    if ($IncludeRecordIdentity) {
        $head.Add((Format-CanonicalValue $Header.InvoiceGuid))
        $head.Add((Format-CanonicalValue $Header.CreateDate))
        $head.Add((Format-CanonicalValue $Header.InvoiceDate))
        $head.Add((Format-CanonicalValue $Header.IsPosted))
        $head.Add((Format-CanonicalValue $Header.RecordState))
        # الرصيدان مطبوعان أيضاً، ومصدرهما مستند محاسبي منفصل (en000/ce000) يُقرأ
        # بنفس اتصال READ UNCOMMITTED. فلو بقي خارج التوقيع لأمكن أن يُقرأ مستند
        # جزئي غير فارغ فيُطبع رصيد نصف مكتوب وتُعلَّم الفاتورة مطبوعة نهائياً.
        # يدخل في مسار الاستقرار وحده: بصمة كشف التكرار تصف البيعة لا حالة الحساب.
        if ($null -eq $Balance) {
            $head.Add("balance:none")
        } else {
            $head.Add("balance:" + (Format-CanonicalValue $Balance.Found))
            $head.Add((Format-CanonicalValue $Balance.Previous))
            $head.Add((Format-CanonicalValue $Balance.Current))
        }
    } else {
        $head.Add((Format-CanonicalValue $BranchGuid))
        $parsedDate = [datetime]::Parse([string]$Header.InvoiceDate, $script:InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        $head.Add($parsedDate.ToString("yyyy-MM-dd", $script:InvariantCulture))
    }
    $head.Add((Format-CanonicalValue $Header.TypeGuid))
    $head.Add((Format-CanonicalValue $Header.InvoiceNumber))
    $head.Add((Format-CanonicalValue $Header.CustomerName))
    $head.Add((Format-CanonicalValue $Header.InvoiceTotal))
    $head.Add((Format-CanonicalValue $Header.TotalDiscount))
    $head.Add((Format-CanonicalValue $Header.TotalExtra))
    $head.Add((Format-CanonicalValue $Header.FirstPayment))
    # سعر الصرف يقسم كل مبلغ على الإيصال، وISO يرافق الأرقام المعروضة.
    $head.Add((Format-CanonicalValue $Header.CurrencyValue))
    $head.Add((Format-CanonicalValue $Header.CurrencyIso))

    $lineTexts = @(foreach ($line in @($Lines)) { Get-CanonicalLineText $line $IncludeRecordIdentity })
    # الترتيب جزء من العقد: الأسطر تُطبع بترتيب الاستعلام، فتبديلها تغيّر مرئي.
    return (($head -join "|") + "`n" + ($lineTexts -join "`n") + "`n#" + (@($Lines).Count))
}

function Get-CanonicalHash([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
        return -join ($bytes | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
}

function Get-TypeGuids {
    $values = New-Object System.Collections.Generic.List[string]
    $values.Add($script:RetailTypeGuid)
    if ($IncludeWholesale) {
        foreach ($guid in $script:WholesaleTypeGuids) { $values.Add($guid) }
    }
    return $values.ToArray()
}

function Get-InvoiceTypeGuid([string]$Name) {
    switch ($Name) {
        "Retail" { return $script:RetailTypeGuid }
        "Wholesale" { return $script:WholesaleTypeGuids[0] }
        "WholesaleSyp" { return $script:WholesaleTypeGuids[1] }
        default { throw "Unsupported invoice type: $Name" }
    }
}

function Add-TypeGuidParameters($Command, [string[]]$TypeGuids) {
    $placeholders = New-Object System.Collections.Generic.List[string]
    for ($index = 0; $index -lt $TypeGuids.Count; $index++) {
        $name = "@type$index"
        [void]$Command.Parameters.Add($name, [System.Data.SqlDbType]::UniqueIdentifier)
        $Command.Parameters[$name].Value = [guid]$TypeGuids[$index]
        $placeholders.Add($name)
    }
    return ($placeholders -join ",")
}

# حجم الصفحة الواحدة. الترتيب أحدثُ أولاً كما كان، ومفتاح الترقيم هو الثلاثي
# (Date, Number, GUID) نفسه المستعمل في ORDER BY — فلا سطر يُقفز ولا يتكرر حتى
# عند تساوي التاريخ والرقم بين عدة فواتير.
$script:CandidatePageSize = 256
# سقف الصفحات في النبضة الواحدة: يمنع أن تستغرق نبضة واحدة تصريف متراكم ضخم.
# لا يسبب تجويعاً لأن التصريف يُستأنف من موضعه في النبضة التالية عبر المؤشر.
$script:MaxCandidatePagesPerPoll = 8
# عند تهيئة خط الأساس نحتاج تغطية النافذة كاملةً وإلا طُبع تاريخ قديم لاحقاً.
$script:MaxCandidatePagesForBaseline = 4096

function Get-PostedInvoiceCandidatePage($Connection, [string[]]$TypeGuids, [datetime]$FromDate, $After) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 10
    $typeSql = Add-TypeGuidParameters $command $TypeGuids
    [void]$command.Parameters.Add("@fromDate", [System.Data.SqlDbType]::DateTime)
    $command.Parameters["@fromDate"].Value = $FromDate

    # شرط seek: يبدأ حصراً بعد آخر ثلاثي من الصفحة السابقة، بنفس اتجاه الترتيب.
    $seekSql = ""
    if ($null -ne $After) {
        [void]$command.Parameters.Add("@afterDate", [System.Data.SqlDbType]::DateTime)
        $command.Parameters["@afterDate"].Value = $After.InvoiceDateRaw
        [void]$command.Parameters.Add("@afterNumber", [System.Data.SqlDbType]::Int)
        $command.Parameters["@afterNumber"].Value = [int]$After.InvoiceNumber
        [void]$command.Parameters.Add("@afterGuid", [System.Data.SqlDbType]::UniqueIdentifier)
        $command.Parameters["@afterGuid"].Value = [guid]$After.InvoiceGuid
        $seekSql = @"
  and (u.Date < @afterDate
       or (u.Date = @afterDate and u.Number < @afterNumber)
       or (u.Date = @afterDate and u.Number = @afterNumber and u.GUID < @afterGuid))
"@
    }

    $command.CommandText = @"
select top ($script:CandidatePageSize)
    convert(varchar(36), u.GUID) as invoice_guid,
    u.Number as invoice_number,
    convert(varchar(36), u.TypeGUID) as type_guid,
    bt.Name as type_name,
    u.Date as invoice_date,
    u.CreateDate as create_date,
    u.IsPosted as is_posted,
    u.RecState as record_state,
    convert(varchar(36), u.Branch) as branch_guid,
    coalesce(u.SourceId, 0) as source_id
from dbo.bu000 u
join dbo.bt000 bt on bt.GUID = u.TypeGUID
where u.TypeGUID in ($typeSql)
  and bt.BillType = 1
  and u.IsPosted = 1
  and coalesce(u.RecState, 0) = 0
  and u.Date >= @fromDate$seekSql
order by u.Date desc, u.Number desc, u.GUID desc;
"@

    $rows = New-Object System.Collections.Generic.List[object]
    $reader = $command.ExecuteReader()
    try {
        while ($reader.Read()) {
            $rows.Add([pscustomobject]@{
                InvoiceGuid = ([string]$reader["invoice_guid"]).ToLowerInvariant()
                InvoiceNumber = [int]$reader["invoice_number"]
                TypeGuid = ([string]$reader["type_guid"]).ToLowerInvariant()
                TypeName = [string]$reader["type_name"]
                InvoiceDate = Convert-ToUtcText $reader["invoice_date"]
                # القيمة الخام كما هي في العمود — هي مفتاح الترقيم. النسخة النصية
                # أعلاه محوّلة إلى UTC فلا تصلح للمقارنة مع u.Date مباشرةً.
                InvoiceDateRaw = if ($reader["invoice_date"] -is [DBNull]) { $null } else { [datetime]$reader["invoice_date"] }
                CreateDate = Convert-ToUtcText $reader["create_date"]
                IsPosted = [bool]$reader["is_posted"]
                RecordState = Convert-ToNullableInt $reader["record_state"]
                BranchGuid = if ($reader["branch_guid"] -is [DBNull]) { $null } else { ([string]$reader["branch_guid"]).ToLowerInvariant() }
                SourceId = [int]$reader["source_id"]
            })
        }
    } finally {
        $reader.Close()
    }
    return $rows.ToArray()
}

# الصفحة الأولى وحدها — يستعملها قياس الأداء الذي يقيس زمن استعلام واحد.
function Get-PostedInvoiceCandidates($Connection, [string[]]$TypeGuids, [datetime]$FromDate) {
    return Get-PostedInvoiceCandidatePage $Connection $TypeGuids $FromDate $null
}

# يجمع مرشّحي النافذة عبر صفحات seek متتالية.
#
# لماذا: الاستعلام كان يعيد أحدث 256 فقط، والترشيح بـseen يقع بعد الجلب. فلو
# تراكمت أكثر من 256 فاتورة داخل النافذة — بعد انقطاع مثلاً — عادت كل نبضة
# بالـ256 نفسها ولم تصل الأقدم أبداً، فتُفقد نهائياً.
#
# لماذا لا تجويع: الصفحة الأولى تُجلب من الأحدث في كل نبضة (فالفواتير الجديدة
# تُطبع فوراً ولا يؤخّرها تصريف متراكم)، ثم يُستأنف التصريف من المؤشر المحفوظ
# بين النبضات. وعند نفاد النافذة يُصفَّر المؤشر فتعود النبضة التالية إلى المشي
# التسلسلي الكامل — فكل سطر داخل النافذة يُزار حتماً خلال عدد محدود من النبضات.
#
# لماذا لا تكرار: مفتاح الـseek هو الثلاثي الكامل، والصفحة التالية تبدأ حصراً
# بعد آخر ثلاثي (مقارنة صارمة)، ويُحرس فوق ذلك بمجموعة GUIDات داخل النبضة.
#
# لماذا لا حلقة لا نهائية: كل دورة إما تنفد الصفحة (أقصر من الحجم) أو يتقدّم
# المؤشر تقدّماً صارماً نحو الأقدم داخل مجموعة منتهية، فوق سقف صفحات صريح.
function Get-PostedInvoiceCandidateSet($Connection, [string[]]$TypeGuids, [datetime]$FromDate, $ResumeCursor, [int]$MaxPages) {
    $collected = New-Object System.Collections.Generic.List[object]
    $seenGuids = New-Object System.Collections.Generic.HashSet[string]

    $firstPage = @(Get-PostedInvoiceCandidatePage $Connection $TypeGuids $FromDate $null)
    foreach ($row in $firstPage) { if ($seenGuids.Add($row.InvoiceGuid)) { $collected.Add($row) } }

    $exhausted = $firstPage.Count -lt $script:CandidatePageSize
    $cursor = if ($firstPage.Count -gt 0) { $firstPage[$firstPage.Count - 1] } else { $null }
    # استئناف التصريف من حيث توقّفت النبضة السابقة إن كانت قد بلغت السقف.
    if (-not $exhausted -and $null -ne $ResumeCursor) { $cursor = $ResumeCursor }

    $pagesFetched = 1
    while (-not $exhausted -and $pagesFetched -lt $MaxPages -and $null -ne $cursor) {
        $page = @(Get-PostedInvoiceCandidatePage $Connection $TypeGuids $FromDate $cursor)
        $pagesFetched++
        if ($page.Count -eq 0) { $exhausted = $true; break }
        foreach ($row in $page) { if ($seenGuids.Add($row.InvoiceGuid)) { $collected.Add($row) } }
        if ($page.Count -lt $script:CandidatePageSize) { $exhausted = $true }
        else { $cursor = $page[$page.Count - 1] }
    }

    return [pscustomobject]@{
        Candidates = $collected.ToArray()
        NextCursor = if ($exhausted) { $null } else { $cursor }
        Exhausted = $exhausted
        PagesFetched = $pagesFetched
    }
}

function Get-PostedInvoiceByNumber($Connection, [string]$TypeGuid, [int]$Number, [datetime]$Date) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 10
    [void]$command.Parameters.Add("@typeGuid", [System.Data.SqlDbType]::UniqueIdentifier)
    $command.Parameters["@typeGuid"].Value = [guid]$TypeGuid
    [void]$command.Parameters.Add("@number", [System.Data.SqlDbType]::Int)
    $command.Parameters["@number"].Value = $Number
    [void]$command.Parameters.Add("@date", [System.Data.SqlDbType]::Date)
    $command.Parameters["@date"].Value = $Date.Date
    $command.CommandText = @"
select top (2)
    convert(varchar(36), u.GUID) as invoice_guid,
    u.Number as invoice_number,
    convert(varchar(36), u.TypeGUID) as type_guid,
    bt.Name as type_name,
    u.Date as invoice_date,
    u.CreateDate as create_date,
    u.IsPosted as is_posted,
    u.RecState as record_state,
    convert(varchar(36), u.Branch) as branch_guid,
    coalesce(u.SourceId, 0) as source_id
from dbo.bu000 u
join dbo.bt000 bt on bt.GUID = u.TypeGUID
where u.TypeGUID = @typeGuid
  and u.Number = @number
  and cast(u.Date as date) = @date
  and bt.BillType = 1
  and u.IsPosted = 1
  and coalesce(u.RecState, 0) = 0
order by u.CreateDate desc, u.GUID desc;
"@
    $rows = New-Object System.Collections.Generic.List[object]
    $reader = $command.ExecuteReader()
    try {
        while ($reader.Read()) {
            $rows.Add([pscustomobject]@{
                InvoiceGuid = ([string]$reader["invoice_guid"]).ToLowerInvariant()
                InvoiceNumber = [int]$reader["invoice_number"]
                TypeGuid = ([string]$reader["type_guid"]).ToLowerInvariant()
                TypeName = [string]$reader["type_name"]
                InvoiceDate = Convert-ToUtcText $reader["invoice_date"]
                CreateDate = Convert-ToUtcText $reader["create_date"]
                IsPosted = [bool]$reader["is_posted"]
                RecordState = Convert-ToNullableInt $reader["record_state"]
                BranchGuid = if ($reader["branch_guid"] -is [DBNull]) { $null } else { ([string]$reader["branch_guid"]).ToLowerInvariant() }
                SourceId = [int]$reader["source_id"]
            })
        }
    } finally {
        $reader.Close()
    }
    if ($rows.Count -eq 0) { return $null }
    if ($rows.Count -gt 1) { throw "More than one posted invoice matched the selected type, number, and date." }
    return $rows[0]
}

function Get-InvoiceSnapshot($Connection, [guid]$InvoiceGuid) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 10
    [void]$command.Parameters.Add("@invoiceGuid", [System.Data.SqlDbType]::UniqueIdentifier)
    $command.Parameters["@invoiceGuid"].Value = $InvoiceGuid
    $command.CommandText = @"
select
    convert(varchar(36), u.GUID) as invoice_guid,
    u.Number as invoice_number,
    convert(varchar(36), u.TypeGUID) as type_guid,
    bt.Name as type_name,
    u.Date as invoice_date,
    u.CreateDate as create_date,
    u.Cust_Name as customer_name,
    u.Total as invoice_total,
    u.PayType as pay_type,
    u.FirstPay as first_payment,
    u.TotalDisc as total_discount,
    u.TotalExtra as total_extra,
    u.CurrencyVal as currency_value,
    convert(varchar(36), u.CurrencyGUID) as currency_guid,
    my.CurrencyISO as currency_iso,
    u.IsPosted as is_posted,
    u.RecState as record_state,
    convert(varchar(36), bi.GUID) as line_guid,
    bi.Number as line_number,
    convert(varchar(36), bi.MatGUID) as item_guid,
    mt.Number as item_number,
    mt.Name as item_name,
    bi.Qty as qty,
    bi.Qty2 as qty2,
    bi.Qty3 as qty3,
    bi.Unity as selected_unit,
    bi.Price as raw_price,
    bi.Discount as line_discount,
    bi.BonusDisc as bonus_discount,
    bi.Extra as line_extra,
    mt.Unity as unit1_name,
    mt.Unit2 as unit2_name,
    mt.Unit2Fact as unit2_factor
from dbo.bu000 u
join dbo.bt000 bt on bt.GUID = u.TypeGUID
left join dbo.my000 my on my.GUID = u.CurrencyGUID
left join dbo.bi000 bi on bi.ParentGUID = u.GUID
left join dbo.mt000 mt on mt.GUID = bi.MatGUID
where u.GUID = @invoiceGuid
  and bt.BillType = 1
  and u.IsPosted = 1
  and coalesce(u.RecState, 0) = 0
order by bi.Number, bi.GUID;
"@

    $reader = $command.ExecuteReader()
    $header = $null
    $lines = New-Object System.Collections.Generic.List[object]
    try {
        while ($reader.Read()) {
            if ($null -eq $header) {
                $header = [pscustomobject]@{
                    InvoiceGuid = ([string]$reader["invoice_guid"]).ToLowerInvariant()
                    InvoiceNumber = [int]$reader["invoice_number"]
                    TypeGuid = ([string]$reader["type_guid"]).ToLowerInvariant()
                    TypeName = [string]$reader["type_name"]
                    InvoiceDate = Convert-ToUtcText $reader["invoice_date"]
                    CreateDate = Convert-ToUtcText $reader["create_date"]
                    CustomerName = if ($reader["customer_name"] -is [DBNull]) { "" } else { [string]$reader["customer_name"] }
                    InvoiceTotal = Convert-ToNullableDouble $reader["invoice_total"]
                    PayType = Convert-ToNullableInt $reader["pay_type"]
                    FirstPayment = Convert-ToNullableDouble $reader["first_payment"]
                    TotalDiscount = Convert-ToNullableDouble $reader["total_discount"]
                    TotalExtra = Convert-ToNullableDouble $reader["total_extra"]
                    CurrencyValue = Convert-ToNullableDouble $reader["currency_value"]
                    CurrencyGuid = if ($reader["currency_guid"] -is [DBNull]) { $null } else { ([string]$reader["currency_guid"]).ToLowerInvariant() }
                    CurrencyIso = if ($reader["currency_iso"] -is [DBNull]) { "" } else { [string]$reader["currency_iso"] }
                    IsPosted = [bool]$reader["is_posted"]
                    RecordState = Convert-ToNullableInt $reader["record_state"]
                }
            }
            if (-not ($reader["line_guid"] -is [DBNull])) {
                $lines.Add([pscustomobject]@{
                    LineGuid = ([string]$reader["line_guid"]).ToLowerInvariant()
                    LineNumber = Convert-ToNullableInt $reader["line_number"]
                    ItemGuid = if ($reader["item_guid"] -is [DBNull]) { $null } else { ([string]$reader["item_guid"]).ToLowerInvariant() }
                    ItemNumber = if ($reader["item_number"] -is [DBNull]) { $null } else { [string]$reader["item_number"] }
                    ItemName = if ($reader["item_name"] -is [DBNull]) { "" } else { [string]$reader["item_name"] }
                    Qty = Convert-ToNullableDouble $reader["qty"]
                    Qty2 = Convert-ToNullableDouble $reader["qty2"]
                    Qty3 = Convert-ToNullableDouble $reader["qty3"]
                    SelectedUnit = Convert-ToNullableDouble $reader["selected_unit"]
                    RawPrice = Convert-ToNullableDouble $reader["raw_price"]
                    LineDiscount = Convert-ToNullableDouble $reader["line_discount"]
                    BonusDiscount = Convert-ToNullableDouble $reader["bonus_discount"]
                    LineExtra = Convert-ToNullableDouble $reader["line_extra"]
                    Unit1Name = if ($reader["unit1_name"] -is [DBNull]) { "" } else { [string]$reader["unit1_name"] }
                    Unit2Name = if ($reader["unit2_name"] -is [DBNull]) { "" } else { [string]$reader["unit2_name"] }
                    Unit2Factor = Convert-ToNullableDouble $reader["unit2_factor"]
                })
            }
        }
    } finally {
        $reader.Close()
    }
    if ($null -eq $header) { return $null }

    # الرصيد يُقرأ هنا مرة واحدة لكل لقطة — لا مرة إضافية بعد الاستقرار. بذلك
    # تكون القيمة التي شاركت في آخر لقطة مستقرة هي نفسها القيمة التي تُطبع.
    # الشرط كما كان: لا رصيد بلا اسم زبون.
    $balance = [pscustomobject]@{ Previous = 0.0; Current = 0.0; Found = $false }
    if (-not [string]::IsNullOrWhiteSpace($header.CustomerName)) {
        $balance = Get-InvoiceDocumentBalance $Connection ([guid]$header.InvoiceGuid)
    }

    # يشمل الترويسة المطبوعة كاملةً لا الأسطر وحدها: الاتصال READ UNCOMMITTED،
    # فتغيّر اسم الزبون أو الإجمالي أو الخصم أو الدفعة أو سعر الصرف أو الرصيد بين
    # اللقطتين كان يمرّ سابقاً بلا أثر على التوقيع فتُطبع فاتورة بأرقام نصف مكتوبة.
    $signature = Get-CanonicalHash (Get-CanonicalReceiptText $header $lines $true "" $balance)

    return [pscustomobject]@{
        Header = $header
        Lines = $lines.ToArray()
        LineCount = $lines.Count
        Balance = $balance
        Signature = $signature
    }
}

function Get-InvoiceDocumentBalance($Connection, [guid]$InvoiceGuid) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 15
    [void]$command.Parameters.Add("@invoiceGuid", [System.Data.SqlDbType]::UniqueIdentifier)
    $command.Parameters["@invoiceGuid"].Value = $InvoiceGuid
    $command.CommandText = @"
;with invoice_document as (
    select top (1) en.ParentGUID as parent_guid
    from dbo.en000 en
    left join dbo.bi000 bib on bib.GUID = en.BiGUID
    where coalesce(bib.ParentGUID, en.BiGUID) = @invoiceGuid
      and en.ParentGUID is not null
      and en.ParentGUID <> '00000000-0000-0000-0000-000000000000'
      and (coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0)
    order by en.Number, en.GUID
), target as (
    select top (1) en.AccountGUID as account_guid, en.ParentGUID as parent_guid
    from dbo.en000 en
    join invoice_document doc on doc.parent_guid = en.ParentGUID
    join dbo.cu000 cu on cu.AccountGUID = en.AccountGUID
    where coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0
    order by en.Number, en.GUID
), ledger as (
    select en.AccountGUID as account_guid,
           en.ParentGUID as parent_guid,
           coalesce(case when ce.Date >= '2000-01-01' then ce.Date end, en.Date) as entry_date,
           case when coalesce(en.Notes, '') like N'%افتتاح%' then 0 else 1 end as is_opening,
           coalesce(ce.CreateDate, en.Date) as sort_date,
           coalesce(ce.Number, 0) as voucher_number,
           en.Number as entry_number,
           cast(coalesce(en.Debit, 0) - coalesce(en.Credit, 0) as decimal(28, 6)) as movement,
           cast(sum(coalesce(en.Debit, 0) - coalesce(en.Credit, 0)) over (
               partition by en.AccountGUID
               order by coalesce(case when ce.Date >= '2000-01-01' then ce.Date end, en.Date),
                        case when coalesce(en.Notes, '') like N'%افتتاح%' then 0 else 1 end,
                        coalesce(ce.CreateDate, en.Date), coalesce(ce.Number, 0), en.Number
               rows unbounded preceding) as decimal(28, 6)) as balance_chrono
    from dbo.en000 en
    left join dbo.ce000 ce on ce.GUID = en.ParentGUID
    join target t on t.account_guid = en.AccountGUID
    where coalesce(en.Debit, 0) <> 0 or coalesce(en.Credit, 0) <> 0
), document_rows as (
    select l.*,
           first_value(l.balance_chrono - l.movement) over (
               partition by l.account_guid, l.parent_guid
               order by l.entry_date, l.is_opening, l.sort_date, l.voucher_number, l.entry_number
               rows between unbounded preceding and unbounded following) as document_previous,
           last_value(l.balance_chrono) over (
               partition by l.account_guid, l.parent_guid
               order by l.entry_date, l.is_opening, l.sort_date, l.voucher_number, l.entry_number
               rows between unbounded preceding and unbounded following) as document_current
    from ledger l
)
select top (1) d.document_previous, d.document_current
from document_rows d
join target t on t.account_guid = d.account_guid and t.parent_guid = d.parent_guid;
"@
    $reader = $command.ExecuteReader()
    try {
        if (-not $reader.Read()) {
            return [pscustomobject]@{ Previous = 0.0; Current = 0.0; Found = $false }
        }
        return [pscustomobject]@{
            Previous = Convert-ToNullableDouble $reader["document_previous"]
            Current = Convert-ToNullableDouble $reader["document_current"]
            Found = $true
        }
    } finally {
        $reader.Close()
    }
}

function Convert-ToReceiptAmount($Header, $Value) {
    if ($null -eq $Value) { return 0.0 }
    $rate = [double]$Header.CurrencyValue
    if ($rate -gt 0) { return [double]$Value / $rate }
    return [double]$Value
}

# لا تأخذ اتصالاً عمداً: أي استعلام هنا يقع بعد اكتمال فحص الاستقرار، فيمكن أن
# يعيد قيمة غير التي ثُبِّتت. الرصيد يأتي من اللقطة المستقرة نفسها لا من قراءة
# جديدة — «ما استقرّ هو ما يُطبع».
function Convert-SnapshotToReceipt($Snapshot) {
    $header = $Snapshot.Header
    $balance = if ($null -ne $Snapshot.Balance) { $Snapshot.Balance }
               else { [pscustomobject]@{ Previous = 0.0; Current = 0.0; Found = $false } }
    $receiptLines = New-Object System.Collections.Generic.List[object]
    $totalQuantity = 0.0
    foreach ($line in @($Snapshot.Lines)) {
        $quantity = [double]$line.Qty
        if ([int]$line.SelectedUnit -eq 2 -and [double]$line.Unit2Factor -gt 0) {
            $quantity = $quantity / [double]$line.Unit2Factor
        }
        $unitPrice = Convert-ToReceiptAmount $header $line.RawPrice
        $totalQuantity += $quantity
        $receiptLines.Add([pscustomobject]@{
            Name = [string]$line.ItemName
            Quantity = $quantity
            UnitPrice = $unitPrice
            Total = $quantity * $unitPrice
        })
    }

    $invoiceDate = [datetime]::Parse([string]$header.InvoiceDate).ToLocalTime()
    $createDate = [datetime]::Parse([string]$header.CreateDate).ToLocalTime()
    $discount = Convert-ToReceiptAmount $header $header.TotalDiscount
    $gross = Convert-ToReceiptAmount $header $header.InvoiceTotal
    $extra = Convert-ToReceiptAmount $header $header.TotalExtra
    return [pscustomobject]@{
        MerchantName = "مركز أبو زياد"
        Subtitle = "لتجارة التبغ الدخان الوطني والمستورد"
        CommercialRegister = "0310109105"
        Phones = "0984000662 - 0985000771"
        CenterPhone = "0994092038"
        Address = "دوما / ساحة الغنم"
        Date = $invoiceDate.ToString("yyyy/M/d")
        Time = $createDate.ToString("h:mm tt", [Globalization.CultureInfo]::GetCultureInfo("en-US"))
        CustomerName = if ([string]::IsNullOrWhiteSpace($header.CustomerName)) { "-" } else { $header.CustomerName.Trim() }
        Description = "-"
        Lines = $receiptLines.ToArray()
        GrossTotal = $gross
        Discount = $discount
        NetTotal = $gross - $discount + $extra
        Payment = Convert-ToReceiptAmount $header $header.FirstPayment
        # Ledger calculations stay in Al-Ameen's base currency. The receipt is
        # customer-facing, so display both balances in the invoice currency,
        # using the exact CurrencyVal stored on this invoice.
        PreviousBalance = Convert-ToReceiptAmount $header $balance.Previous
        CurrentBalance = Convert-ToReceiptAmount $header $balance.Current
        ItemCount = $Snapshot.LineCount
        TotalQuantity = $totalQuantity
        SaleDescription = "صفة البيع من تاجر جملة الجملة إلى تاجر جملة ومفرق"
        CurrencyIso = [string]$header.CurrencyIso
        BalanceFound = $balance.Found
    }
}

function Wait-InvoiceReady($Connection, [guid]$InvoiceGuid) {
    $started = [Diagnostics.Stopwatch]::StartNew()
    $first = Get-InvoiceSnapshot $Connection $InvoiceGuid
    if ($null -eq $first -or $first.LineCount -eq 0) {
        return [pscustomobject]@{ Ready = $false; Snapshot = $first; ReadyMilliseconds = $started.ElapsedMilliseconds }
    }
    Start-Sleep -Milliseconds $StabilityMilliseconds
    $second = Get-InvoiceSnapshot $Connection $InvoiceGuid
    $ready = $null -ne $second -and
        $second.LineCount -gt 0 -and
        $first.LineCount -eq $second.LineCount -and
        $first.Signature -eq $second.Signature -and
        $second.Header.IsPosted -and
        $second.Header.RecordState -eq 0
    return [pscustomobject]@{
        Ready = $ready
        Snapshot = $second
        ReadyMilliseconds = $started.ElapsedMilliseconds
    }
}

function New-EmptyState {
    return [ordered]@{
        schemaVersion = 1
        database = "AmnDb002"
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        seen = @{}
        # Fingerprint -> {guid, invoiceNumber, printedAt}. Secondary dedup layer
        # only; never used to look up or change anything in Ameen itself.
        recentFingerprints = @{}
        # GUID -> {fingerprint, invoiceNumber, category, reason, quarantinedAt}.
        # فواتير تعذّر تصييرها تعذّراً حتمياً. منفصلة عن seen عمداً: ليست مطبوعة.
        quarantined = @{}
    }
}

function Read-BridgeState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return New-EmptyState }
    $parsed = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([int]$parsed.schemaVersion -ne 1 -or [string]$parsed.database -ne "AmnDb002") {
        throw "Unsupported OZK Print Bridge state file."
    }
    $state = New-EmptyState
    foreach ($property in $parsed.seen.psobject.Properties) {
        $state.seen[$property.Name.ToLowerInvariant()] = $property.Value
    }
    # Older state files (before this fix) won't have this property yet.
    if ($null -ne $parsed.PSObject.Properties['recentFingerprints']) {
        foreach ($property in $parsed.recentFingerprints.psobject.Properties) {
            $state.recentFingerprints[$property.Name] = $property.Value
        }
    }
    # ملفات حالة أقدم من العزل لا تحوي هذا الحقل، وملف تالف قد يحويه بشكل غير
    # متوقّع. في الحالتين نبدأ بعزل فارغ بدل إسقاط الجسر — أسوأ ما يحدث حينها
    # إعادة تقييم فاتورة معزولة مرة واحدة، وهو أسلم من توقّف الطابور.
    if ($null -ne $parsed.PSObject.Properties['quarantined']) {
        try {
            foreach ($property in $parsed.quarantined.psobject.Properties) {
                $state.quarantined[$property.Name.ToLowerInvariant()] = $property.Value
            }
        } catch {
            $state.quarantined = @{}
        }
    }
    return $state
}

function Write-BridgeState([string]$Path, $State) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $directory = [IO.Path]::GetDirectoryName($fullPath)
    if ([string]::IsNullOrWhiteSpace($directory)) { throw "StatePath must include a directory." }
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }
    $State.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    $json = $State | ConvertTo-Json -Depth 8
    $temporaryPath = Join-Path $directory ("state-{0}.tmp" -f [guid]::NewGuid().ToString("N"))
    $backupPath = Join-Path $directory ("state-{0}.bak" -f [guid]::NewGuid().ToString("N"))
    [IO.File]::WriteAllText($temporaryPath, $json, (New-Object Text.UTF8Encoding($false)))
    try {
        if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
            [IO.File]::Replace($temporaryPath, $fullPath, $backupPath, $true)
        } else {
            [IO.File]::Move($temporaryPath, $fullPath)
        }
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function Get-InvoiceFingerprint($Candidate, $Snapshot) {
    # «هل هذه نفس البيعة فعلاً؟» — مستقلة عن GUID الفاتورة وعن GUIDات الأسطر
    # وأرقامها وCreateDate، لأنها كلها تُولَّد من جديد عند إعادة الحفظ. وتعتمد
    # على المحتوى المطبوع كاملاً: النوع والرقم والتاريخ والفرع والزبون
    # والإجماليات والدفعة والعملة، وكل سطر بمادته وكميته ووحدته وسعره وترتيبه.
    # الاكتفاء بالإجمالي وعدد الأسطر كان يقمع فاتورة مصحَّحة بمواد مختلفة
    # تصادف تساوي إجماليها وعدد أسطرها مع الأصل.
    $branch = if ([string]::IsNullOrWhiteSpace($Candidate.BranchGuid)) { "" } else { [string]$Candidate.BranchGuid }
    return Get-CanonicalHash (Get-CanonicalReceiptText $Snapshot.Header $Snapshot.Lines $false $branch)
}

function Remove-StaleFingerprints($RecentFingerprints, [datetime]$Now, [int]$MaxAgeSeconds) {
    $staleKeys = @($RecentFingerprints.Keys | Where-Object {
        $entry = $RecentFingerprints[$_]
        try {
            $printedAt = [datetime]::Parse([string]$entry.printedAt).ToUniversalTime()
            ($Now.ToUniversalTime() - $printedAt).TotalSeconds -gt $MaxAgeSeconds
        } catch {
            $true
        }
    })
    foreach ($key in $staleKeys) { $RecentFingerprints.Remove($key) }
}

function Get-RedactedInvoiceEvent($Candidate, $ReadyResult, [long]$DetectionMilliseconds) {
    $suffix = if ($Candidate.InvoiceGuid.Length -ge 8) { $Candidate.InvoiceGuid.Substring($Candidate.InvoiceGuid.Length - 8) } else { $Candidate.InvoiceGuid }
    return [pscustomobject]@{
        Event = "invoice_ready"
        InvoiceIdSuffix = $suffix
        InvoiceNumber = $Candidate.InvoiceNumber
        TypeName = $Candidate.TypeName
        CreateDate = $Candidate.CreateDate
        DetectedAt = (Get-Date).ToUniversalTime().ToString("o")
        DetectionMilliseconds = $DetectionMilliseconds
        StabilityMilliseconds = $ReadyResult.ReadyMilliseconds
        LineCount = $ReadyResult.Snapshot.LineCount
        Renderer = "not_configured"
        Printer = "not_configured"
    }
}

# لا يجوز أبداً تسليح الطباعة الفيزيائية بينما أنواع الجملة مُدرَجة في الرصد:
# ذلك المزيج هو المسار الوحيد الذي كان يمكن أن يوصل فاتورة جملة إلى الحرارية.
# يُرفض عند بدء التشغيل قبل أي اتصال بقاعدة البيانات — لا يقتصر على واجهة الـUI.
if ($IncludeWholesale -and $ConfirmPhysicalPrint) {
    throw "OZK Print Bridge refuses to arm physical printing while wholesale invoice types are included (-IncludeWholesale with -ConfirmPhysicalPrint). Wholesale printing is owned by the Ameen wholesale autoprint watcher; the cashier thermal printer must never receive a wholesale invoice."
}

$connectionInfo = $null
try {
    $connectionInfo = New-ReadOnlyConnection
    $connection = $connectionInfo.Connection
    $typeGuids = @(Get-TypeGuids)
    $fromDate = (Get-Date).Date.AddDays(-$LookbackDays)

    if ($Mode -eq "PreviewInvoice" -or $Mode -eq "PrintInvoice") {
        Assert-CashierInvoiceType $InvoiceType
        if ($InvoiceNumber -le 0) { throw "InvoiceNumber is required for manual preview or printing." }
        $invoiceTypeGuid = Get-InvoiceTypeGuid $InvoiceType
        $selected = Get-PostedInvoiceByNumber $connection $invoiceTypeGuid $InvoiceNumber $InvoiceDate
        if ($null -eq $selected) { throw "No posted invoice matched the selected type, number, and date." }
        $ready = Wait-InvoiceReady $connection ([guid]$selected.InvoiceGuid)
        if (-not $ready.Ready) { throw "The selected invoice is not stable yet. Try again shortly." }
        Import-Module $script:ReceiptModulePath -Force
        $receipt = Convert-SnapshotToReceipt $ready.Snapshot
        if ($Mode -eq "PreviewInvoice") {
            $savedPath = Save-OzkReceiptPreview -Receipt $receipt -LogoPath $script:ReceiptLogoPath -Path $PreviewPath
            [pscustomobject]@{
                Mode = "PreviewInvoice"
                InvoiceNumber = $InvoiceNumber
                InvoiceDate = $InvoiceDate.ToString("yyyy-MM-dd")
                InvoiceType = $InvoiceType
                PreviewPath = $savedPath
                PhysicalPrintSubmitted = $false
                ReadOnlyVerified = $true
            }
        } else {
            if (-not $ConfirmPhysicalPrint) { throw "Manual physical printing requires -ConfirmPhysicalPrint." }
            $printResult = Send-OzkReceiptToPrinter -Receipt $receipt -LogoPath $script:ReceiptLogoPath -PrinterName $PrinterName -ConfirmPhysicalPrint
            $manualEvent = [pscustomobject]@{
                Event = "manual_reprint_submitted"
                InvoiceNumber = $InvoiceNumber
                InvoiceDate = $InvoiceDate.ToString("yyyy-MM-dd")
                InvoiceType = $InvoiceType
                Printer = $PrinterName
                JobId = $printResult.JobId
                At = (Get-Date).ToUniversalTime().ToString("o")
                CustomerAndItemsRedacted = $true
            }
            Write-BridgeLog $manualEvent
            $manualEvent
        }
        exit 0
    }

    if ($Mode -eq "Benchmark") {
        $timings = New-Object System.Collections.Generic.List[double]
        $candidateCount = 0
        for ($iteration = 0; $iteration -lt $BenchmarkIterations; $iteration++) {
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $rows = @(Get-PostedInvoiceCandidates $connection $typeGuids $fromDate)
            $watch.Stop()
            $candidateCount = $rows.Count
            $timings.Add($watch.Elapsed.TotalMilliseconds)
        }
        $sorted = @($timings | Sort-Object)
        $p50 = $sorted[[math]::Min($sorted.Count - 1, [math]::Floor($sorted.Count * 0.50))]
        $p95 = $sorted[[math]::Min($sorted.Count - 1, [math]::Floor($sorted.Count * 0.95))]
        [pscustomobject]@{
            Mode = "Benchmark"
            Database = $connectionInfo.Database
            Login = $connectionInfo.Login
            ReadOnlyVerified = $true
            Iterations = $BenchmarkIterations
            CandidateCount = $candidateCount
            PollMilliseconds = $PollMilliseconds
            MedianQueryMilliseconds = [math]::Round($p50, 2)
            P95QueryMilliseconds = [math]::Round($p95, 2)
            MaxQueryMilliseconds = [math]::Round(($sorted | Measure-Object -Maximum).Maximum, 2)
        }
        exit 0
    }

    # خط الأساس وPreviewLatest يحتاجان النافذة كاملة: لو اقتصر خط الأساس على
    # أحدث صفحة لصارت الفواتير الأقدم «غير مرئية» عند التهيئة ثم طُبعت لاحقاً
    # بعد أن صار الترقيم قادراً على الوصول إليها.
    $candidates = @((Get-PostedInvoiceCandidateSet $connection $typeGuids $fromDate $null $script:MaxCandidatePagesForBaseline).Candidates)
    if ($Mode -eq "PreviewLatest") {
        $latest = $candidates | Select-Object -First 1
        if ($null -eq $latest) { throw "No posted POS invoice was found in the configured lookback window." }
        $ready = Wait-InvoiceReady $connection ([guid]$latest.InvoiceGuid)
        if (-not $ready.Ready) { throw "The latest posted invoice is not stable yet." }
        Import-Module $script:ReceiptModulePath -Force
        $receipt = Convert-SnapshotToReceipt $ready.Snapshot
        $savedPath = Save-OzkReceiptPreview -Receipt $receipt -LogoPath $script:ReceiptLogoPath -Path $PreviewPath
        [pscustomobject]@{
            Mode = "PreviewLatest"
            Database = $connectionInfo.Database
            ReadOnlyVerified = $true
            InvoiceNumber = $latest.InvoiceNumber
            LineCount = $ready.Snapshot.LineCount
            CurrencyIso = $receipt.CurrencyIso
            DocumentBalanceFound = $receipt.BalanceFound
            PreviewPath = $savedPath
            PhysicalPrintSubmitted = $false
            CustomerAndItemsRedacted = $true
        }
        exit 0
    }

    if ($Mode -eq "Probe") {
        $latest = $candidates | Select-Object -First 1
        if ($null -eq $latest) {
            [pscustomobject]@{ Mode = "Probe"; Database = $connectionInfo.Database; ReadOnlyVerified = $true; Found = $false }
            exit 0
        }
        $ready = Wait-InvoiceReady $connection ([guid]$latest.InvoiceGuid)
        [pscustomobject]@{
            Mode = "Probe"
            Database = $connectionInfo.Database
            Login = $connectionInfo.Login
            ReadOnlyVerified = $true
            Found = $true
            InvoiceNumber = $latest.InvoiceNumber
            TypeName = $latest.TypeName
            Posted = $latest.IsPosted
            RecordState = $latest.RecordState
            LineCount = if ($null -eq $ready.Snapshot) { 0 } else { $ready.Snapshot.LineCount }
            Stable = $ready.Ready
            SnapshotMilliseconds = $ready.ReadyMilliseconds
            CustomerAndItemsRedacted = $true
            Renderer = "not_configured"
            Printer = "not_configured"
        }
        exit 0
    }

    $stateExisted = Test-Path -LiteralPath $StatePath -PathType Leaf
    $state = Read-BridgeState $StatePath

    # فاتورة بقيت print_in_flight من تشغيل سابق تعني: أُرسلت إلى الطابعة ثم تعذّر
    # حفظ نتيجة الإرسال. لا يعيد الجسر طباعتها آلياً (ذلك هو الغرض من العلامة)،
    # لكنه لا يبتلعها صامتاً أيضاً — تُسجَّل عند كل إقلاع ليقرّر المشغّل، وإعادة
    # الطباعة اليدوية عبر -Mode PrintInvoice تبقى متاحة له.
    foreach ($entry in @($state.quarantined.GetEnumerator())) {
        Write-BridgeLog ([pscustomobject]@{
            Event = "quarantined_invoice_carried_over"
            invoice_guid = $entry.Key
            invoice_number = $entry.Value.invoiceNumber
            category = $entry.Value.category
            reason = $entry.Value.reason
            At = (Get-Date).ToUniversalTime().ToString("o")
            Remedy = "not printed and not marked printed; edit the invoice or raise the renderer limit, then it is re-evaluated automatically"
            CustomerAndItemsRedacted = $true
        })
    }

    foreach ($entry in @($state.seen.GetEnumerator())) {
        if ([string]$entry.Value.status -eq "print_in_flight") {
            Write-BridgeLog ([pscustomobject]@{
                Event = "print_in_flight_carried_over"
                invoice_guid = $entry.Key
                invoice_number = $entry.Value.invoiceNumber
                At = (Get-Date).ToUniversalTime().ToString("o")
                Reason = "spooled_but_result_not_persisted; automatic reprint suppressed"
                Remedy = "operator decides; manual reprint available via -Mode PrintInvoice"
                CustomerAndItemsRedacted = $true
            })
        }
    }
    if (-not $stateExisted) {
        foreach ($candidate in $candidates) {
            $state.seen[$candidate.InvoiceGuid] = [ordered]@{
                status = "baseline"
                invoiceNumber = $candidate.InvoiceNumber
                observedAt = (Get-Date).ToUniversalTime().ToString("o")
            }
        }
        Write-BridgeState $StatePath $state
        $baselineEvent = [pscustomobject]@{
            Event = "baseline_initialized"
            SeenCount = $state.seen.Count
            HistoricalPrintingPrevented = $true
            StatePath = [IO.Path]::GetFullPath($StatePath)
        }
        $baselineEvent
        Write-BridgeLog $baselineEvent
    }

    $pollCount = 0
    # مؤشر التصريف يعيش في الذاكرة عبر النبضات. لا داعي لحفظه على القرص: بعد
    # إعادة التشغيل تبدأ المسيرة من الأحدث من جديد وتمرّ على النافذة كاملةً،
    # وهو سلوك صحيح لا يفقد شيئاً — فقط يعيد عملاً رخيصاً.
    $drainCursor = $null
    while ($MaxPolls -eq 0 -or $pollCount -lt $MaxPolls) {
        $pollCount++
        $pollWatch = [Diagnostics.Stopwatch]::StartNew()
        $candidateSet = Get-PostedInvoiceCandidateSet $connection $typeGuids $fromDate $drainCursor $script:MaxCandidatePagesPerPoll
        $drainCursor = $candidateSet.NextCursor
        if (-not $candidateSet.Exhausted) {
            # بلغت النبضة سقف الصفحات ولم تنفد النافذة: تُسجَّل الحالة صراحةً،
            # وتُكمل النبضة التالية من المؤشر نفسه بدل أن تعيد الأحدث إلى ما لا نهاية.
            Write-BridgeLog ([pscustomobject]@{
                Event = "candidate_drain_paused"
                pages_fetched = $candidateSet.PagesFetched
                candidates_collected = @($candidateSet.Candidates).Count
                At = (Get-Date).ToUniversalTime().ToString("o")
                Reason = "page_cap_reached; next poll resumes from the same cursor"
                CustomerAndItemsRedacted = $true
            })
        }
        $current = @($candidateSet.Candidates)
        foreach ($candidate in @($current | Sort-Object InvoiceDate, InvoiceNumber)) {
            if ($state.seen.ContainsKey($candidate.InvoiceGuid)) { continue }
            $ready = Wait-InvoiceReady $connection ([guid]$candidate.InvoiceGuid)
            if (-not $ready.Ready) { continue }

            $now = Get-Date
            $fingerprint = Get-InvoiceFingerprint $candidate $ready.Snapshot
            Remove-StaleFingerprints $state.recentFingerprints $now $script:DuplicateFingerprintRetentionSeconds

            # الفاتورة المعزولة تُتخطّى بلا ضجيج ما دام محتواها كما هو. أثرها
            # الدائم في state.json، ويُعلَن عند كل إقلاع — فلا تضيع صامتة.
            $quarantineDecision = Get-QuarantineDecision $state $candidate.InvoiceGuid $fingerprint
            if ($quarantineDecision -eq "skip") { continue }
            if ($quarantineDecision -eq "reevaluate") {
                # تغيّر محتوى الفاتورة (أو حالة عزل تالفة): تستحق محاولة جديدة.
                [void]$state.quarantined.Remove($candidate.InvoiceGuid)
                Write-BridgeLog ([pscustomobject]@{
                    Event = "quarantine_released"
                    invoice_guid = $candidate.InvoiceGuid
                    invoice_number = $candidate.InvoiceNumber
                    At = (Get-Date).ToUniversalTime().ToString("o")
                    Reason = "invoice_content_changed_or_state_incomplete; re-evaluating"
                    CustomerAndItemsRedacted = $true
                })
                Write-BridgeState $StatePath $state
            }

            $duplicateMatch = $null
            if ($state.recentFingerprints.ContainsKey($fingerprint)) {
                $priorEntry = $state.recentFingerprints[$fingerprint]
                if ([string]$priorEntry.guid -ne $candidate.InvoiceGuid) {
                    $priorPrintedAt = [datetime]::Parse([string]$priorEntry.printedAt).ToUniversalTime()
                    $secondsDiff = ($now.ToUniversalTime() - $priorPrintedAt).TotalSeconds
                    if ($secondsDiff -ge 0 -and $secondsDiff -le $script:DuplicateFingerprintWindowSeconds) {
                        $duplicateMatch = [pscustomobject]@{ PriorEntry = $priorEntry; SecondsDiff = $secondsDiff }
                    }
                }
            }

            if ($null -ne $duplicateMatch) {
                # Same content signature, different GUID, seen moments ago: most likely
                # the cashier saved/printed the same sale twice in Ameen. Skip the print
                # only — Ameen itself, its GUIDs, and its records are never touched.
                $dupEvent = [pscustomobject]@{
                    Event = "duplicate_suppressed"
                    current_guid = $candidate.InvoiceGuid
                    original_guid = [string]$duplicateMatch.PriorEntry.guid
                    invoice_number = $candidate.InvoiceNumber
                    invoice_type = $candidate.TypeName
                    fingerprint = $fingerprint
                    time_difference_seconds = [math]::Round($duplicateMatch.SecondsDiff, 3)
                    reason = "matching_type_number_date_branch_customer_total_linecount_within_window"
                }
                Write-BridgeLog $dupEvent
                $state.seen[$candidate.InvoiceGuid] = [ordered]@{
                    status = "duplicate_suppressed"
                    invoiceNumber = $candidate.InvoiceNumber
                    observedAt = $now.ToUniversalTime().ToString("o")
                    lineCount = $ready.Snapshot.LineCount
                }
                Write-BridgeState $StatePath $state
                continue
            }

            $pollWatch.Stop()
            $invoiceEvent = Get-RedactedInvoiceEvent $candidate $ready $pollWatch.ElapsedMilliseconds
            $stateStatus = "observed_waiting_for_print_activation"
            if ($ConfirmPhysicalPrint) {
                # طبقة دفاع ثانية: حتى لو وصل مرشّح غير كاشير إلى هنا رغم حارس
                # بدء التشغيل، يُرفض قبل أي تصيير أو إرسال — بلا استثناء صامت.
                Assert-CashierTypeGuid ([string]$candidate.TypeGuid) ([int]$candidate.InvoiceNumber)
                Import-Module $script:ReceiptModulePath -Force
                $receipt = Convert-SnapshotToReceipt $ready.Snapshot

                # 1) كل ما يمكن أن يفشل بلا إنشاء أي مهمة طباعة يقع هنا، قبل أي
                #    علامة: التحقق من الطابعة، وجود الطابور، التصيير، بناء ESC/POS.
                #    فشل أي منها لا يترك أثراً، فإعادة المحاولة تبقى مضمونة.
                # الفشل الحتمي هنا (كتجاوز حدّ ارتفاع الإيصال) يتكرر حتماً ما دام
                # المحتوى ثابتاً؛ فلو خرج من الحلقة لأسقط الجسر وأعاده الـwatchdog
                # على الفاتورة نفسها بلا نهاية، فتُحجب كل الإيصالات اللاحقة. تُعزل
                # هذه الفاتورة وحدها ويستمر الطابور. أما الفشل العابر (طابعة غير
                # متاحة، خطأ CIM أو إدخال/إخراج) فيخرج كما كان — لا عزل له.
                $spoolJob = $null
                try {
                    $spoolJob = New-OzkReceiptSpoolJob -Receipt $receipt -LogoPath $script:ReceiptLogoPath -PrinterName $PrinterName
                } catch {
                    if (-not (Test-PermanentInvoiceFailure $_)) { throw }
                    Add-QuarantineEntry $state $candidate $fingerprint $_
                    Write-BridgeLog ([pscustomobject]@{
                        Event = "permanent_render_failure"
                        invoice_guid = $candidate.InvoiceGuid
                        invoice_number = $candidate.InvoiceNumber
                        category = "permanent_render_failure"
                        fingerprint = $fingerprint
                        ErrorType = $_.Exception.GetType().FullName
                        Message = [string]$_.Exception.Message
                        At = (Get-Date).ToUniversalTime().ToString("o")
                        Consequence = "invoice quarantined, not printed and not marked printed; queue continues"
                        CustomerAndItemsRedacted = $true
                    })
                    Write-BridgeState $StatePath $state
                    continue
                }

                # 2) من هنا فصاعداً قد تصير النتيجة غامضة، فتُحفظ العلامة على القرص
                #    قبل التسليم. بدونها كان فشلُ حفظِ الحالة بعد نجاح التسليم يقتل
                #    الجسر، فيعيده الـwatchdog بعد ثانية ويقرأ حالةً لا تحوي هذه
                #    الفاتورة فيطبعها ثانيةً — بلا نهاية إن كان العطل مستمراً.
                $state.seen[$candidate.InvoiceGuid] = [ordered]@{
                    status = "print_in_flight"
                    invoiceNumber = $candidate.InvoiceNumber
                    observedAt = $now.ToUniversalTime().ToString("o")
                    lineCount = $ready.Snapshot.LineCount
                }
                Write-BridgeState $StatePath $state

                # 3) التسليم وحده. فشلٌ مثبتٌ أنه قبل قبول أي مهمة (OpenPrinter أو
                #    StartDocPrinter) يعني يقيناً أن الورق لم يخرج، فنتراجع عن
                #    العلامة كي لا تُقمع فاتورة كاشير لم تُطبع أصلاً. أي فشل آخر
                #    يبقى غامضاً فتبقى العلامة ويُمنع التكرار الآلي.
                try {
                    [void](Submit-OzkReceiptSpoolJob -Job $spoolJob -ConfirmPhysicalPrint)
                } catch {
                    if (Test-PreSubmissionFailure $_) {
                        [void]$state.seen.Remove($candidate.InvoiceGuid)
                        $rolledBack = $true
                        try {
                            Write-BridgeState $StatePath $state
                        } catch {
                            $rolledBack = $false
                        }
                        Write-BridgeLog ([pscustomobject]@{
                            Event = "pre_submission_failure_retryable"
                            invoice_number = $candidate.InvoiceNumber
                            invoice_guid = $candidate.InvoiceGuid
                            At = (Get-Date).ToUniversalTime().ToString("o")
                            MarkerRolledBack = $rolledBack
                            Consequence = if ($rolledBack) { "no_print_job_was_created; will retry on a later poll" }
                                          else { "no_print_job_was_created; marker rollback failed - manual reprint may be required" }
                            CustomerAndItemsRedacted = $true
                        })
                    }
                    throw
                }
                $invoiceEvent.Renderer = "ozk_80mm_v1"
                # الدلالة الدقيقة: قُبلت المهمة في طابور الطباعة. لا إثبات على خروج الورق.
                $invoiceEvent.Printer = "submitted_to_spooler:$PrinterName"
                $stateStatus = "spooled"
            } else {
                $invoiceEvent.Renderer = "ozk_80mm_v1_ready"
                $invoiceEvent.Printer = "not_submitted"
            }
            $invoiceEvent
            Write-BridgeLog $invoiceEvent
            $state.seen[$candidate.InvoiceGuid] = [ordered]@{
                status = $stateStatus
                invoiceNumber = $candidate.InvoiceNumber
                observedAt = $invoiceEvent.DetectedAt
                lineCount = $invoiceEvent.LineCount
            }
            $state.recentFingerprints[$fingerprint] = [ordered]@{
                guid = $candidate.InvoiceGuid
                invoiceNumber = $candidate.InvoiceNumber
                printedAt = $now.ToUniversalTime().ToString("o")
            }
            try {
                Write-BridgeState $StatePath $state
            } catch {
                if ($stateStatus -ne "spooled") { throw }
                # الإيصال خرج فعلاً إلى الطابعة، وعلامة print_in_flight محفوظة على
                # القرص من قبل الإرسال. إسقاطُ الجسر هنا لا يفيد: الحالة في الذاكرة
                # تمنع التكرار في هذا التشغيل، والعلامة تمنعه بعد إعادة التشغيل.
                # نسجّل العطل بوضوح ونواصل الرصد بدل ترك الكاشير بلا طباعة.
                Write-BridgeLog ([pscustomobject]@{
                    Event = "state_persist_failed_after_spool"
                    invoice_number = $candidate.InvoiceNumber
                    invoice_guid = $candidate.InvoiceGuid
                    At = (Get-Date).ToUniversalTime().ToString("o")
                    ErrorType = $_.Exception.GetType().FullName
                    Message = [string]$_.Exception.Message
                    Consequence = "receipt_printed_once; on-disk marker prevents automatic reprint"
                    CustomerAndItemsRedacted = $true
                })
            }
        }
        if ($pollWatch.IsRunning) { $pollWatch.Stop() }
        Start-Sleep -Milliseconds $PollMilliseconds
    }
} catch {
    Write-BridgeLog ([pscustomobject]@{
        Event = "bridge_error"
        At = (Get-Date).ToUniversalTime().ToString("o")
        ErrorType = $_.Exception.GetType().FullName
        Message = [string]$_.Exception.Message
        CustomerAndItemsRedacted = $true
    })
    throw
} finally {
    if ($null -ne $connectionInfo -and $connectionInfo.Connection.State -eq "Open") {
        $connectionInfo.Connection.Close()
    }
}
