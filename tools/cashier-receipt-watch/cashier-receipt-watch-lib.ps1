# مراقب «إيصال الكاشير ≠ الفاتورة الحالية» — منطق نقي + استعلامات قراءة فقط.
#
# يقارن كل إيصال مؤرشف (OzkReceiptArchive) بحالة الفاتورة الحالية في الأمين بالـGUID،
# ويكشف: تعديلاً ظاهراً على الإيصال، أو حذفاً (بدليل log000)، أو إعادة إدخال محتملة،
# أو إعادة استخدام الرقم. لا يكتب في الأمين، ولا يعيد الطباعة أبداً، ولا يرسل تنبيهات
# عن إيصالات طُبعت قبل أول تشغيل له (watchStartUtc).

$script:WatchRetailTypeGuid = "cc1097b1-662d-4d80-8e4e-3b493249591c"
$script:WatchInvariant = [Globalization.CultureInfo]::InvariantCulture
# التغيّرات التي تظهر فعلاً على الإيصال الورقي. سعر الصرف وحده لا يُطبع.
$script:WatchVisibleKinds = @("item_added", "item_removed", "quantity", "unit_price", "discount", "extra", "net")
$script:WatchMaxAlertEntries = 10
$script:WatchReentryWindowMinutes = 30

function Import-CashierWatchArchiveModule([string]$RepoBridgeDir = "") {
    $candidates = @()
    if ($RepoBridgeDir) { $candidates += (Join-Path $RepoBridgeDir "OzkReceiptArchive.psm1") }
    $candidates += (Join-Path (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "ozk-print-bridge") "OzkReceiptArchive.psm1")
    $candidates += (Join-Path $PSScriptRoot "OzkReceiptArchive.psm1")
    foreach ($path in $candidates) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { Import-Module $path -Force -DisableNameChecking -Global; return $path }
    }
    throw "OzkReceiptArchive.psm1 not found."
}

# ── حارس القراءة فقط (نفس قاعدة أداة إعادة الطباعة) ─────────────────────────────
function Assert-CashierWatchSelectOnly([string]$Sql) {
    $text = [regex]::Replace($Sql, '(?s)/\*.*?\*/', ' ')
    $text = [regex]::Replace($text, '--[^\r\n]*', ' ')
    $text = $text.Trim()
    if ($text -notmatch '^(?i)select\s') { throw "Refused: watcher SQL must be a single SELECT." }
    if ($text.TrimEnd(';').Contains(';')) { throw "Refused: more than one SQL statement." }
    if ($text -match '(?i)\b(insert|update|delete|merge|drop|alter|create|truncate|exec|execute|grant|revoke|deny|into|openrowset|opendatasource|xp_|sp_)\b') {
        throw "Refused: watcher SQL contains a write or execute keyword."
    }
}

function New-CashierWatchInList([string]$Prefix, [int]$Count) {
    if ($Count -le 0) { throw "IN list needs at least one value." }
    return ((0..($Count - 1) | ForEach-Object { "@$Prefix$_" }) -join ", ")
}

function Get-CashierWatchCurrentSql([int]$Count) {
    $inList = New-CashierWatchInList "g" $Count
    return @"
select
    convert(varchar(36), u.GUID) as invoice_guid,
    u.Number as invoice_number,
    convert(varchar(36), u.TypeGUID) as type_guid,
    u.CreateDate as create_date,
    u.LastUpdateDate as last_update_date,
    u.IsPosted as is_posted,
    coalesce(u.RecState, 0) as record_state,
    u.Total as total,
    u.TotalDisc as total_discount,
    u.TotalExtra as total_extra,
    u.CurrencyVal as currency_value,
    my.CurrencyISO as currency_iso,
    convert(varchar(36), bi.MatGUID) as item_guid,
    mt.Name as item_name,
    bi.Qty as qty,
    bi.Unity as selected_unit,
    mt.Unit2Fact as unit2_factor,
    mt.Unit3Fact as unit3_factor,
    bi.Price as raw_price
from dbo.bu000 u
left join dbo.my000 my on my.GUID = u.CurrencyGUID
left join dbo.bi000 bi on bi.ParentGUID = u.GUID
left join dbo.mt000 mt on mt.GUID = bi.MatGUID
where u.GUID in ($inList)
order by u.GUID, bi.Number
"@
}

function Get-CashierWatchLogSql([int]$Count) {
    $inList = New-CashierWatchInList "g" $Count
    return @"
select
    convert(varchar(36), l.RecGUID) as rec_guid,
    l.OperationType as operation_type,
    count(*) as entries
from dbo.log000 l
where l.Operation = 1
  and l.OperationType in (2, 3)
  and l.RecGUID in ($inList)
group by l.RecGUID, l.OperationType
"@
}

# فواتير كاشير حالية قد تكون إعادة إدخال لفاتورة محذوفة: بنفس الرقم، أو أُنشئت قربها.
function Get-CashierWatchNeighbourSql {
    return @"
select
    convert(varchar(36), u.GUID) as invoice_guid,
    u.Number as invoice_number,
    u.CreateDate as create_date
from dbo.bu000 u
where u.TypeGUID = @retailType
  and u.IsPosted = 1
  and coalesce(u.RecState, 0) = 0
  and (u.Number = @number or u.CreateDate between @fromDate and @toDate)
"@
}

# ── قراءة الأمين ──────────────────────────────────────────────────────────────
function Open-CashierWatchConnection([string]$ConnectionString) {
    Add-Type -AssemblyName System.Data
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $ConnectionString
    if ($builder.UserID -and $builder.UserID -ieq "sa") { throw "Refused: the watcher never uses sa." }
    $builder["ApplicationIntent"] = "ReadOnly"
    $connection = New-Object System.Data.SqlClient.SqlConnection $builder.ConnectionString
    $connection.Open()
    $probe = $connection.CreateCommand()
    $probe.CommandText = "select is_srvrolemember('sysadmin') as a, is_rolemember('db_owner') as b, is_rolemember('db_datawriter') as c"
    $reader = $probe.ExecuteReader()
    try {
        [void]$reader.Read()
        if ([int]$reader["a"] -eq 1 -or [int]$reader["b"] -eq 1 -or [int]$reader["c"] -eq 1) {
            throw "Refused: the watcher account can write to Ameen; use a read-only (db_datareader) login."
        }
    } finally { $reader.Close() }
    return $connection
}

function Invoke-CashierWatchQuery($Connection, [string]$Sql, [hashtable]$Parameters) {
    Assert-CashierWatchSelectOnly $Sql
    $command = $Connection.CreateCommand()
    $command.CommandTimeout = 30
    $command.CommandText = $Sql
    foreach ($key in $Parameters.Keys) {
        $value = $Parameters[$key]
        if ($value -is [guid]) { [void]$command.Parameters.Add("@$key", [System.Data.SqlDbType]::UniqueIdentifier); $command.Parameters["@$key"].Value = $value }
        elseif ($value -is [datetime]) { [void]$command.Parameters.Add("@$key", [System.Data.SqlDbType]::DateTime); $command.Parameters["@$key"].Value = $value }
        elseif ($value -is [int]) { [void]$command.Parameters.Add("@$key", [System.Data.SqlDbType]::Int); $command.Parameters["@$key"].Value = $value }
        else { [void]$command.Parameters.AddWithValue("@$key", $value) }
    }
    $reader = $command.ExecuteReader()
    $rows = New-Object System.Collections.Generic.List[object]
    try {
        while ($reader.Read()) {
            $row = [ordered]@{}
            for ($i = 0; $i -lt $reader.FieldCount; $i++) {
                $v = $reader.GetValue($i)
                if ($v -is [DBNull]) { $v = $null }
                $row[$reader.GetName($i)] = $v
            }
            $rows.Add([pscustomobject]$row)
        }
    } finally { $reader.Close() }
    return $rows.ToArray()
}

function Invoke-CashierWatchBatched($Connection, [string[]]$Guids, [scriptblock]$SqlFor) {
    $all = New-Object System.Collections.Generic.List[object]
    $unique = @($Guids | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
    for ($i = 0; $i -lt $unique.Count; $i += 200) {
        $chunk = @($unique[$i..([math]::Min($i + 199, $unique.Count - 1))])
        $parameters = @{}
        for ($j = 0; $j -lt $chunk.Count; $j++) { $parameters["g$j"] = [guid]$chunk[$j] }
        foreach ($row in @(Invoke-CashierWatchQuery $Connection (& $SqlFor $chunk.Count) $parameters)) { $all.Add($row) }
    }
    return $all.ToArray()
}

# صفوف الأمين ⇒ فاتورة حالية لكل GUID (بنفس شكل مقارِن الأرشيف).
function ConvertTo-CashierWatchCurrentInvoices([object[]]$Rows) {
    $byGuid = @{}
    foreach ($row in @($Rows)) {
        if ($null -eq $row) { continue }
        $guid = ([string]$row.invoice_guid).ToLowerInvariant()
        if (-not $byGuid.ContainsKey($guid)) {
            $byGuid[$guid] = [pscustomobject]@{
                guid = $guid; number = [int]$row.invoice_number; typeGuid = ([string]$row.type_guid).ToLowerInvariant()
                createDate = $row.create_date; lastUpdateDate = $row.last_update_date
                isPosted = [bool]$row.is_posted; recordState = [int]$row.record_state
                total = $row.total; totalDiscount = $row.total_discount; totalExtra = $row.total_extra
                currencyValue = $row.currency_value; currencyIso = [string]$row.currency_iso
                lines = New-Object System.Collections.Generic.List[object]
            }
        }
        if ($null -ne $row.item_guid) {
            $byGuid[$guid].lines.Add([pscustomobject]@{
                itemGuid = ([string]$row.item_guid).ToLowerInvariant(); itemName = [string]$row.item_name; qty = $row.qty
                selectedUnit = $row.selected_unit; unit2Factor = $row.unit2_factor; unit3Factor = $row.unit3_factor; rawPrice = $row.raw_price
            })
        }
    }
    return $byGuid
}

function Get-CashierWatchComparable($Current) {
    return (New-OzkInvoiceComparable -CurrencyValue $Current.currencyValue -CurrencyIso $Current.currencyIso -Total $Current.total `
        -TotalDiscount $Current.totalDiscount -TotalExtra $Current.totalExtra -Lines @($Current.lines.ToArray()))
}

# ── أدلة Windows (ليست دليلاً ورقياً) ─────────────────────────────────────────
# حدث 307 في PrintService/Operational = «طُبع المستند» من وجهة نظر الطابور. يُطابَق
# برقم المهمة والطابعة وبوقت لا يسبق التسليم ولا يتأخر عنه أكثر من 30 دقيقة، لأن
# أرقام المهام تتكرر بين الأيام.
function Get-CashierWatchSpoolerCompletions([datetime]$SinceUtc) {
    $events = @()
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = "Microsoft-Windows-PrintService/Operational"; Id = 307; StartTime = $SinceUtc.ToLocalTime() } -ErrorAction Stop)
    } catch {
        return @()
    }
    return @(foreach ($event in $events) {
        try {
            [pscustomobject]@{ JobId = [int64]$event.Properties[0].Value; Printer = [string]$event.Properties[4].Value; AtUtc = $event.TimeCreated.ToUniversalTime() }
        } catch { }
    })
}

function Find-CashierWatchSpoolerEvidence($Summary, [object[]]$Completions, [string]$PrinterName, [datetime]$SubmittedAtUtc) {
    if ($null -eq $Summary.jobId) { return $null }
    foreach ($completion in @($Completions)) {
        if ([int64]$completion.JobId -ne [int64]$Summary.jobId) { continue }
        if ($PrinterName -and [string]$completion.Printer -ne $PrinterName) { continue }
        $delta = ($completion.AtUtc - $SubmittedAtUtc).TotalMinutes
        if ($delta -ge -1 -and $delta -le 30) { return $completion }
    }
    return $null
}

# ── الحالة ومنع التكرار ───────────────────────────────────────────────────────
function New-CashierWatchState([datetime]$NowUtc) {
    return [ordered]@{ schemaVersion = 1; watchStartUtc = $NowUtc.ToUniversalTime().ToString("o", $script:WatchInvariant); alerted = @{} }
}

function Read-CashierWatchState([string]$Path, [datetime]$NowUtc) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ State = (New-CashierWatchState $NowUtc); Initialized = $true } }
    $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $alerted = @{}
    if ($raw.PSObject.Properties["alerted"] -and $null -ne $raw.alerted) {
        foreach ($property in $raw.alerted.PSObject.Properties) { $alerted[$property.Name] = $property.Value }
    }
    $state = [ordered]@{ schemaVersion = 1; watchStartUtc = (ConvertTo-OzkUtcText $raw.watchStartUtc); alerted = $alerted }
    return [pscustomobject]@{ State = $state; Initialized = $false }
}

function Save-CashierWatchState([string]$Path, $State) {
    $directory = Split-Path -Parent $Path
    if ($directory) { [void](New-Item -ItemType Directory -Force -Path $directory) }
    $temp = $Path + ".tmp"
    [IO.File]::WriteAllText($temp, (ConvertTo-OzkCanonicalJson $State), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temp, $Path, [NullString]::Value) } else { [IO.File]::Move($temp, $Path) }
}

function Get-CashierWatchFindingHash($Finding) {
    $basis = [ordered]@{ kind = $Finding.kind; changes = @($Finding.changes); reentryGuid = $(if ($Finding.reentry) { $Finding.reentry.guid } else { $null }); reusedBy = @($Finding.numberReusedBy | ForEach-Object { $_.guid }) }
    return (Get-OzkTextSha256 (ConvertTo-OzkCanonicalJson $basis))
}

# ── الكشف ─────────────────────────────────────────────────────────────────────
# Prints: ملخصات الأرشيف مع المحتوى (printId → content). Current: فواتير الأمين الحالية
# بالـGUID. LogEvidence: GUID → {deletes, edits}. Neighbours: GUID محذوف → فواتير مرشحة.
function Get-CashierWatchFindings {
    param(
        [object[]]$Prints,
        [hashtable]$Current,
        [hashtable]$LogEvidence,
        [hashtable]$Neighbours = @{},
        [datetime]$WatchStartUtc
    )
    # آخر إيصال وصل Windows لكل GUID هو المرجع: ما بيد الزبون/المحاسب الآن.
    $latest = @{}
    foreach ($print in @($Prints)) {
        if (-not (Test-OzkReceiptReachedSpooler $print.Summary)) { continue }
        $preparedAt = [datetime]::Parse([string]$print.Summary.preparedAtUtc, $script:WatchInvariant, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        if ($preparedAt -lt $WatchStartUtc.ToUniversalTime()) { continue }
        $guid = ([string]$print.Summary.invoiceGuid).ToLowerInvariant()
        if (-not $latest.ContainsKey($guid) -or $preparedAt -gt $latest[$guid].PreparedAt) {
            $latest[$guid] = [pscustomobject]@{ Print = $print; PreparedAt = $preparedAt }
        }
    }
    $findings = New-Object System.Collections.Generic.List[object]
    foreach ($guid in @($latest.Keys)) {
        $entry = $latest[$guid]
        $content = $entry.Print.Content
        $number = [int]$content.invoice.number
        $printedCmp = Get-OzkArchivedComparable $content
        $evidence = $LogEvidence[$guid]
        $base = [ordered]@{
            invoiceGuid = $guid; invoiceNumber = $number; printId = [string]$entry.Print.Summary.printId
            printedAtUtc = $entry.PreparedAt.ToString("o", $script:WatchInvariant); printedNet = $printedCmp.net
            currencyIso = [string]$printedCmp.currencyIso; changes = @(); reentry = $null; numberReusedBy = @(); deletionLogged = $false
        }
        $currentInvoice = $Current[$guid]
        if ($null -ne $currentInvoice -and $currentInvoice.isPosted -and $currentInvoice.recordState -eq 0 -and $currentInvoice.typeGuid -eq $script:WatchRetailTypeGuid) {
            $changes = @(Compare-OzkInvoiceComparable $printedCmp (Get-CashierWatchComparable $currentInvoice) | Where-Object { $script:WatchVisibleKinds -contains $_.kind })
            if ($changes.Count -eq 0) { continue }
            $base.kind = "edited"; $base.changes = $changes; $base.currentNet = (Get-CashierWatchComparable $currentInvoice).net
            $findings.Add([pscustomobject]$base)
            continue
        }
        # غير موجودة كفاتورة كاشير مرحّلة الآن: محذوفة، أو غير مرحّلة، أو تغيّر نوعها.
        if ($null -ne $currentInvoice) {
            $base.kind = "no_longer_cashier_posted"
        } elseif ($null -ne $evidence -and [int]$evidence.deletes -gt 0) {
            $base.kind = "deleted"; $base.deletionLogged = $true
        } else {
            $base.kind = "missing_unexplained"
        }
        $candidates = @($Neighbours[$guid] | Where-Object { $null -ne $_ })
        $reused = @($candidates | Where-Object { [int]$_.number -eq $number -and $_.guid -ne $guid })
        $base.numberReusedBy = @($reused | ForEach-Object { [ordered]@{ guid = $_.guid; number = [int]$_.number } })
        $best = $null; $bestScore = 0.0
        $printedItems = @($printedCmp.items.Keys)
        foreach ($candidate in $candidates) {
            if ($candidate.guid -eq $guid -or $null -eq $Current[$candidate.guid]) { continue }
            $candidateCmp = Get-CashierWatchComparable $Current[$candidate.guid]
            $candidateItems = @($candidateCmp.items.Keys)
            $union = @($printedItems + $candidateItems | Select-Object -Unique).Count
            if ($union -eq 0) { continue }
            $score = @($printedItems | Where-Object { $candidateItems -contains $_ }).Count / [double]$union
            if ($score -ge 0.5 -and $score -gt $bestScore) { $best = $candidate; $bestScore = $score }
        }
        if ($null -ne $best) {
            $reentryChanges = @(Compare-OzkInvoiceComparable $printedCmp (Get-CashierWatchComparable $Current[$best.guid]) | Where-Object { $script:WatchVisibleKinds -contains $_.kind })
            $base.reentry = [ordered]@{ guid = $best.guid; number = [int]$best.number; overlap = [math]::Round($bestScore, 2); changes = $reentryChanges }
        }
        $findings.Add([pscustomobject]$base)
    }
    return @($findings.ToArray() | Sort-Object printedAtUtc)
}

# ── رسالة التنبيه (بلا أسماء زبائن) ──────────────────────────────────────────
function Format-CashierWatchAmount($Value) {
    return ([double]$Value).ToString("#,##0.##", $script:WatchInvariant)
}

function Format-CashierWatchLocalTime([string]$UtcText, [TimeZoneInfo]$Zone) {
    $utc = [datetime]::Parse($UtcText, $script:WatchInvariant, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
    return ([TimeZoneInfo]::ConvertTimeFromUtc($utc, $Zone)).ToString("MM-dd HH:mm", $script:WatchInvariant)
}

function Format-CashierWatchChangeSummary([object[]]$Changes) {
    $parts = New-Object System.Collections.Generic.List[string]
    $added = @($Changes | Where-Object { $_.kind -eq "item_added" }).Count
    $removed = @($Changes | Where-Object { $_.kind -eq "item_removed" }).Count
    $qty = @($Changes | Where-Object { $_.kind -eq "quantity" }).Count
    if ($added) { $parts.Add("أصناف مضافة: $added") }
    if ($removed) { $parts.Add("أصناف محذوفة: $removed") }
    if ($qty) { $parts.Add("كميات معدّلة: $qty") }
    foreach ($kind in @("discount", "extra")) {
        $c = @($Changes | Where-Object { $_.kind -eq $kind })[0]
        if ($c) { $label = if ($kind -eq "discount") { "الخصم" } else { "الإضافات" }; $parts.Add("${label}: $(Format-CashierWatchAmount $c.from) ← $(Format-CashierWatchAmount $c.to)") }
    }
    $lines = New-Object System.Collections.Generic.List[string]
    if ($parts.Count) { $lines.Add("  " + ($parts -join " · ")) }
    $prices = @($Changes | Where-Object { $_.kind -eq "unit_price" })
    foreach ($p in @($prices | Select-Object -First 2)) {
        $lines.Add("  سعر «$($p.item)»: $((@($p.from) | ForEach-Object { Format-CashierWatchAmount $_ }) -join '/') ← $((@($p.to) | ForEach-Object { Format-CashierWatchAmount $_ }) -join '/')")
    }
    if ($prices.Count -gt 2) { $lines.Add("  و$($prices.Count - 2) تغيّر سعر آخر") }
    return $lines.ToArray()
}

function Format-CashierWatchAlert([object[]]$Findings, [TimeZoneInfo]$Zone = [TimeZoneInfo]::Local, [int]$Remaining = 0) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("🧾 إيصالات كاشير لم تعد تطابق الأمين ($(@($Findings).Count + $Remaining))")
    foreach ($f in @($Findings)) {
        $when = Format-CashierWatchLocalTime $f.printedAtUtc $Zone
        $iso = if ($f.currencyIso) { " $($f.currencyIso)" } else { "" }
        switch ($f.kind) {
            "edited" {
                $net = @($f.changes | Where-Object { $_.kind -eq "net" })[0]
                $lines.Add("• #$($f.invoiceNumber) — طُبعت $when ثم عُدّلت")
                if ($net) {
                    $sign = if ([double]$net.delta -gt 0) { "+" } else { "" }
                    $lines.Add("  الصافي: $(Format-CashierWatchAmount $net.from) ← $(Format-CashierWatchAmount $net.to) ($sign$(Format-CashierWatchAmount $net.delta))$iso")
                }
                foreach ($l in (Format-CashierWatchChangeSummary $f.changes)) { $lines.Add($l) }
            }
            "deleted" {
                $lines.Add("• #$($f.invoiceNumber) — طُبعت $when ثم حُذفت من الأمين (مثبت في سجل العمليات)، صافيها المطبوع $(Format-CashierWatchAmount $f.printedNet)$iso")
            }
            "no_longer_cashier_posted" {
                $lines.Add("• #$($f.invoiceNumber) — طُبعت $when ولم تعد فاتورة كاشير مرحّلة (إلغاء ترحيل أو تغيير نوع)")
            }
            default {
                $lines.Add("• #$($f.invoiceNumber) — طُبعت $when ولم تعد موجودة في الأمين، ولا أثر لحذفها في سجل العمليات")
            }
        }
        if ($f.reentry) {
            $what = if (@($f.reentry.changes).Count) { " بتغييرات: " + ((@($f.reentry.changes) | ForEach-Object { $_.kind } | Select-Object -Unique) -join "، ") } else { " بنفس المحتوى" }
            $lines.Add("  أُعيد إدخالها غالباً برقم #$($f.reentry.number)$what")
        }
        if (@($f.numberReusedBy).Count) {
            $lines.Add("  ⚠️ الرقم #$($f.invoiceNumber) صار لفاتورة أخرى — لا تُعِد طباعته على أنه الإيصال القديم")
        }
    }
    if ($Remaining -gt 0) { $lines.Add("… و$Remaining أخرى في التنبيه التالي") }
    $lines.Add("الإيصال الورقي لا يمثّل الفاتورة الحالية. لا إعادة طباعة تلقائية.")
    return ($lines -join "`n")
}

# يختار ما يُبلَّغ عنه: الجديد أو المتغيّر منذ آخر تنبيه، بحدّ أقصى لكل رسالة.
function Select-CashierWatchAlerts([object[]]$Findings, [hashtable]$Alerted) {
    $fresh = @(foreach ($f in @($Findings)) {
        $hash = Get-CashierWatchFindingHash $f
        $previous = $Alerted[[string]$f.invoiceGuid]
        $previousHash = $null
        if ($null -ne $previous) { if ($previous -is [string]) { $previousHash = $previous } else { $previousHash = [string]$previous.hash } }
        if ($previousHash -ne $hash) { [pscustomobject]@{ Finding = $f; Hash = $hash } }
    })
    $selected = @($fresh | Select-Object -First $script:WatchMaxAlertEntries)
    return [pscustomobject]@{ Selected = $selected; Remaining = [math]::Max(0, $fresh.Count - $selected.Count) }
}
