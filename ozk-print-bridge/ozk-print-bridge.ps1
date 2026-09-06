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
$script:ReceiptModulePath = Join-Path $PSScriptRoot "ozk-print-bridge\OzkReceiptRenderer.psm1"
$script:ReceiptLogoPath = Join-Path $PSScriptRoot "ozk-print-bridge\assets\ozk-receipt-horse-logo.png"

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
        # Logging is best-effort and must never stop invoice detection or printing.
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

function Get-PostedInvoiceCandidates($Connection, [string[]]$TypeGuids, [datetime]$FromDate) {
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 10
    $typeSql = Add-TypeGuidParameters $command $TypeGuids
    [void]$command.Parameters.Add("@fromDate", [System.Data.SqlDbType]::DateTime)
    $command.Parameters["@fromDate"].Value = $FromDate
    $command.CommandText = @"
select top (256)
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
  and u.Date >= @fromDate
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

    $signatureSource = @($lines | ForEach-Object {
        "{0}|{1}|{2:R}|{3:R}|{4:R}" -f $_.LineGuid, $_.LineNumber, [double]$_.Qty, [double]$_.RawPrice, [double]$_.SelectedUnit
    }) -join "`n"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($signatureSource))
        $signature = -join ($hashBytes | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }

    return [pscustomobject]@{
        Header = $header
        Lines = $lines.ToArray()
        LineCount = $lines.Count
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

function Convert-SnapshotToReceipt($Connection, $Snapshot) {
    $header = $Snapshot.Header
    $balance = [pscustomobject]@{ Previous = 0.0; Current = 0.0; Found = $false }
    if (-not [string]::IsNullOrWhiteSpace($header.CustomerName)) {
        $balance = Get-InvoiceDocumentBalance $Connection ([guid]$header.InvoiceGuid)
    }
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
    # Strongest available content signature for "is this really the same sale?",
    # independent of GUID: document type, invoice number, invoice date, branch,
    # customer, final total, and line count. Deliberately NOT just number+type+date.
    $header = $Snapshot.Header
    $dateOnly = ([datetime]::Parse([string]$header.InvoiceDate)).ToString("yyyy-MM-dd")
    $branch = if ([string]::IsNullOrWhiteSpace($Candidate.BranchGuid)) { "" } else { $Candidate.BranchGuid }
    $customer = if ([string]::IsNullOrWhiteSpace($header.CustomerName)) { "" } else { $header.CustomerName.Trim().ToLowerInvariant() }
    $total = if ($null -eq $header.InvoiceTotal) { 0.0 } else { [math]::Round([double]$header.InvoiceTotal, 2) }
    $raw = "{0}|{1}|{2}|{3}|{4}|{5:F2}|{6}" -f `
        $header.TypeGuid, $header.InvoiceNumber, $dateOnly, $branch, $customer, $total, $Snapshot.LineCount
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))
        return -join ($bytes | ForEach-Object { $_.ToString("x2") })
    } finally {
        $sha.Dispose()
    }
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

$connectionInfo = $null
try {
    $connectionInfo = New-ReadOnlyConnection
    $connection = $connectionInfo.Connection
    $typeGuids = @(Get-TypeGuids)
    $fromDate = (Get-Date).Date.AddDays(-$LookbackDays)

    if ($Mode -eq "PreviewInvoice" -or $Mode -eq "PrintInvoice") {
        if ($InvoiceNumber -le 0) { throw "InvoiceNumber is required for manual preview or printing." }
        $invoiceTypeGuid = Get-InvoiceTypeGuid $InvoiceType
        $selected = Get-PostedInvoiceByNumber $connection $invoiceTypeGuid $InvoiceNumber $InvoiceDate
        if ($null -eq $selected) { throw "No posted invoice matched the selected type, number, and date." }
        $ready = Wait-InvoiceReady $connection ([guid]$selected.InvoiceGuid)
        if (-not $ready.Ready) { throw "The selected invoice is not stable yet. Try again shortly." }
        Import-Module $script:ReceiptModulePath -Force
        $receipt = Convert-SnapshotToReceipt $connection $ready.Snapshot
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

    $candidates = @(Get-PostedInvoiceCandidates $connection $typeGuids $fromDate)
    if ($Mode -eq "PreviewLatest") {
        $latest = $candidates | Select-Object -First 1
        if ($null -eq $latest) { throw "No posted POS invoice was found in the configured lookback window." }
        $ready = Wait-InvoiceReady $connection ([guid]$latest.InvoiceGuid)
        if (-not $ready.Ready) { throw "The latest posted invoice is not stable yet." }
        Import-Module $script:ReceiptModulePath -Force
        $receipt = Convert-SnapshotToReceipt $connection $ready.Snapshot
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
    while ($MaxPolls -eq 0 -or $pollCount -lt $MaxPolls) {
        $pollCount++
        $pollWatch = [Diagnostics.Stopwatch]::StartNew()
        $current = @(Get-PostedInvoiceCandidates $connection $typeGuids $fromDate)
        foreach ($candidate in @($current | Sort-Object InvoiceDate, InvoiceNumber)) {
            if ($state.seen.ContainsKey($candidate.InvoiceGuid)) { continue }
            $ready = Wait-InvoiceReady $connection ([guid]$candidate.InvoiceGuid)
            if (-not $ready.Ready) { continue }

            $now = Get-Date
            $fingerprint = Get-InvoiceFingerprint $candidate $ready.Snapshot
            Remove-StaleFingerprints $state.recentFingerprints $now $script:DuplicateFingerprintRetentionSeconds

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
            $event = Get-RedactedInvoiceEvent $candidate $ready $pollWatch.ElapsedMilliseconds
            $stateStatus = "observed_waiting_for_print_activation"
            if ($ConfirmPhysicalPrint) {
                Import-Module $script:ReceiptModulePath -Force
                $receipt = Convert-SnapshotToReceipt $connection $ready.Snapshot
                [void](Send-OzkReceiptToPrinter -Receipt $receipt -LogoPath $script:ReceiptLogoPath -PrinterName $PrinterName -ConfirmPhysicalPrint)
                $event.Renderer = "ozk_80mm_v1"
                $event.Printer = "submitted:$PrinterName"
                $stateStatus = "spooled"
            } else {
                $event.Renderer = "ozk_80mm_v1_ready"
                $event.Printer = "not_submitted"
            }
            $event
            Write-BridgeLog $event
            $state.seen[$candidate.InvoiceGuid] = [ordered]@{
                status = $stateStatus
                invoiceNumber = $candidate.InvoiceNumber
                observedAt = $event.DetectedAt
                lineCount = $event.LineCount
            }
            $state.recentFingerprints[$fingerprint] = [ordered]@{
                guid = $candidate.InvoiceGuid
                invoiceNumber = $candidate.InvoiceNumber
                printedAt = $now.ToUniversalTime().ToString("o")
            }
            Write-BridgeState $StatePath $state
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
