# ============================================================
# ameen-invoice-events-lib.ps1 — منطق «أحداث فواتير الأمين» (المرحلة 2، غير مفعَّل)
#
# دوال نقية بلا SQL ولا شبكة، يستدعيها tools/ameen-invoice-event-agent.ps1 ويختبرها
# tools/tests/Test-AmeenInvoiceEvents.ps1 تحت Windows PowerShell 5.1 وPowerShell 7.
#
# ما ثبت بفحص المرحلة 1 (قراءة فقط على AmnDb002، 2026-10-20) وتبني عليه هذه الدوال:
#   * log000.OperationType على فواتير BillType 1/3: 1 = إنشاء، 2 = حذف، 3 (+100 خلال
#     ثوانٍ) = تعديل. 9 و126 معناهما غير مؤكد — لا يُبنى عليهما شيء، فأي تغيير فعلي
#     يظهر في بصمة المحتوى أصلاً.
#   * bu000.GUID ثابت عند التعديل (التعديل في المكان)، فهو هوية الفاتورة الوحيدة.
#   * فاتورة لم تُعدَّل تحمل LastUpdateDate = 1980-01-01 لا NULL؛ لا يُعتمد عليه وحده.
#   * المرتجع (BillType 3) مستند مستقل: RefundedBillGUID فارغ في كل المرتجعات.
#   * الفواتير بلا اسم («مبيعات مركز» النقدية) كلها على صناديق لا على زبائن.
#
# الضمانات:
#   * لا كتابة على الأمين: كل SQL يمرّ عبر Assert-AmeenReadOnlySql قبل التنفيذ.
#   * لا تكرار: نسخة الفاتورة = بصمة SHA-256 لمحتواها القانوني؛ لا يُصدر حدث لنسخة
#     مطابقة لآخر نسخة صدرت، والخادم يرفض الحدث المكرر بمفتاحه.
#   * مفتاح الحدث = sha256(bill_guid|source_seq|kind|version_hash|source_event_at): GUID الفاتورة
#     وتسلسل متزايد لا بصمة المحتوى وحدها، فالعودة لمحتوى سابق (A ← B ← A) حدث جديد.
#   * الترتيب: source_seq يُمنح مرة واحدة لكل حدث ويُحفظ معه (ثابت عبر إعادة المحاولة)، ومتزايد
#     لكل فاتورة؛ الخادم يحدد الأحدث به وحده لا بوقت الأمين. الإرسال بترتيبه، وانقطاع الاتصال يوقف الدفعة.
#   * العزل (Dead Letter): الحدث المعطوب — يرفضه التحقق المحلي أو الخادم — يُنقل إلى deadletter\ مع
#     سببه ومعرّفه (بلا محتوى الفاتورة في السبب أو السجل)، وتكمل بقية الأحداث. الإصلاح عبر
#     Repair-AmeenDeadLetter بأحد وضعين: Resnapshot (لقطة جديدة من الأمين بتسلسل أحدث) أو Requeue
#     (الحدث نفسه بعد تصحيحه، بتسلسله الأصلي — والخادم يجعله stale إن سبقه أحدث، فلا يكتب فوقه).
# ============================================================

$script:AmeenInvoiceEventSchema = "ameen-invoice-event/v1"
$script:ZeroGuid = "00000000-0000-0000-0000-000000000000"
$script:Invariant = [Globalization.CultureInfo]::InvariantCulture

# ---------------------------------------------------------------- حارس القراءة فقط
function Assert-AmeenReadOnlySql {
    param([Parameter(Mandatory = $true)][string]$Sql)
    $s = ($Sql -replace '(?s)/\*.*?\*/', '') -replace '--[^\r\n]*', ''
    if ($s -notmatch '^\s*(WITH|SELECT)\b') { throw "AMEEN-READ-ONLY: refused non-SELECT statement" }
    $forbidden = '\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|NOLOCK|INTO|OPENROWSET|OPENQUERY|OPENDATASOURCE|SHUTDOWN|KILL)\b'
    if ($s -match $forbidden) { throw ("AMEEN-READ-ONLY: refused keyword " + $Matches[1].ToUpperInvariant()) }
    if ($s -match ';\s*\S') { throw "AMEEN-READ-ONLY: refused multiple statements" }
}

# ---------------------------------------------------------------- SQL (قراءة فقط)
function Format-AmeenSqlDate {
    param([Parameter(Mandatory = $true)][datetime]$Value)
    return $Value.ToString("yyyy-MM-ddTHH:mm:ss.fff", $script:Invariant)
}

function Get-AmeenInvoiceDetectionSql {
    # استعلاما الرصد التزايدي. العلامة المائية بتوقيت خادم الأمين المحلي (كما تُخزَّن LogTime).
    # التداخل 10 ثوانٍ يغطي معاملة بدأت قبل العلامة وثبتت بعدها؛ التكرار الناتج يُزال بالبصمة.
    param([Parameter(Mandatory = $true)][datetime]$Watermark, [int]$OverlapSeconds = 10)
    $wm = Format-AmeenSqlDate $Watermark.AddSeconds(-1 * $OverlapSeconds)
    return @{
        Log   = "SELECT l.RecGUID, l.OperationType, l.LogTime FROM dbo.log000 l WHERE l.LogTime > '$wm' AND l.TypeGUID IN (SELECT bt.GUID FROM dbo.bt000 bt WHERE bt.BillType IN (1,3)) OPTION (MAXDOP 1)"
        Bills = "SELECT u.GUID, u.CreateDate, u.LastUpdateDate FROM dbo.bu000 u JOIN dbo.bt000 bt ON bt.GUID = u.TypeGUID WHERE bt.BillType IN (1,3) AND (u.CreateDate > '$wm' OR u.LastUpdateDate > '$wm') OPTION (MAXDOP 1)"
    }
}

function Get-AmeenInvoiceFingerprintSql {
    # مطابقة دورية كاملة: بصمة رخيصة لكل فاتورة ضمن النافذة (تاريخ الفاتورة أو إنشاؤها أو تعديلها).
    param([int]$PeriodDays = 60)
    $hdr = "u.[Number], u.[Date], u.[IsPosted], u.[RecState], u.[Total], u.[TotalDisc], u.[TotalExtra], u.[ItemsDisc], u.[ItemsExtra], u.[BonusDisc], u.[FirstPay], u.[CustGUID], u.[CustAccGUID], u.[Cust_Name], u.[StoreGUID], u.[CurrencyGUID], u.[CurrencyVal], u.[PayType], u.[TypeGUID], u.[RefundedBillGUID], u.[VAT]"
    $lin = "bi.[GUID], bi.[Number], bi.[MatGUID], bi.[Qty], bi.[Qty2], bi.[Qty3], bi.[Price], bi.[Unity], bi.[StoreGUID], bi.[Discount], bi.[Extra], bi.[BonusQnt], bi.[VAT], bi.[CostGUID]"
    $d = [int]$PeriodDays
    return "SELECT u.GUID, BINARY_CHECKSUM($hdr) hh, l.lh, l.n FROM dbo.bu000 u JOIN dbo.bt000 bt ON bt.GUID = u.TypeGUID OUTER APPLY (SELECT CHECKSUM_AGG(BINARY_CHECKSUM($lin)) lh, COUNT(*) n FROM dbo.bi000 bi WHERE bi.ParentGUID = u.GUID) l WHERE bt.BillType IN (1,3) AND (u.Date >= DATEADD(day,-$d,CAST(GETDATE() AS date)) OR u.CreateDate >= DATEADD(day,-$d,GETDATE()) OR u.LastUpdateDate >= DATEADD(day,-$d,GETDATE())) OPTION (MAXDOP 1)"
}

function Get-AmeenInvoiceSnapshotSql {
    # لقطة كاملة لفاتورة واحدة: الرأس ثم الأسطر (استعلامان منفصلان، قراءة فقط).
    param([Parameter(Mandatory = $true)][string]$BillGuid)
    $g = ([guid]$BillGuid).ToString()
    return @{
        Header = "SELECT u.GUID, u.Number, u.Date, u.CreateDate, u.LastUpdateDate, u.TypeGUID, bt.BillType, u.IsPosted, u.RecState, u.PayType, u.CustGUID, u.CustAccGUID, u.Cust_Name, u.StoreGUID, u.CurrencyGUID, u.CurrencyVal, u.Total, u.TotalDisc, u.TotalExtra, u.ItemsDisc, u.ItemsExtra, u.BonusDisc, u.FirstPay, u.VAT, u.RefundedBillGUID FROM dbo.bu000 u JOIN dbo.bt000 bt ON bt.GUID = u.TypeGUID WHERE u.GUID = '$g'"
        Lines  = "SELECT bi.GUID, bi.Number, bi.MatGUID, bi.Qty, bi.Qty2, bi.Qty3, bi.Unity, bi.Price, bi.Discount, bi.Extra, bi.BonusQnt, bi.VAT, bi.StoreGUID, bi.CostGUID FROM dbo.bi000 bi WHERE bi.ParentGUID = '$g'"
    }
}

# ---------------------------------------------------------------- تطبيع القيم
function ConvertTo-AmeenGuidText {
    param($Value)
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    $t = ([string]$Value).Trim().ToLowerInvariant()
    if ($t -eq "" -or $t -eq $script:ZeroGuid) { return $null }
    return $t
}

function ConvertTo-AmeenNumber {
    param($Value)
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    return [double]$Value
}

function ConvertTo-AmeenUtcIso {
    # أوقات الأمين محلية بلا منطقة (datetime). تُحوَّل إلى UTC بمنطقة الجهاز.
    param($Value)
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    $d = [datetime]$Value
    if ($d.Kind -eq [DateTimeKind]::Unspecified) { $d = [datetime]::SpecifyKind($d, [DateTimeKind]::Local) }
    return $d.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", $script:Invariant)
}

function Test-AmeenRealUpdateDate {
    # LastUpdateDate = 1980-01-01 تعني «لم تُعدَّل» في الأمين.
    param($Value)
    if ($null -eq $Value -or $Value -is [DBNull]) { return $false }
    return ([datetime]$Value).Year -gt 1990
}

function ConvertTo-AmeenInvoiceSnapshot {
    # يحوّل صف الرأس وصفوف الأسطر (من DataTable أو كائنات مصطنعة في الاختبار) إلى لقطة قانونية.
    # لا تدخل الطوابع الزمنية (CreateDate/LastUpdateDate) في المحتوى: حفظ بلا تغيير لا يصنع نسخة.
    param([Parameter(Mandatory = $true)]$Header, $Lines)
    $lineList = New-Object System.Collections.Generic.List[object]
    foreach ($r in @($Lines)) {
        if ($null -eq $r) { continue }
        $lineList.Add([ordered]@{
            line_guid  = ConvertTo-AmeenGuidText $r.GUID
            number     = ConvertTo-AmeenNumber $r.Number
            item_guid  = ConvertTo-AmeenGuidText $r.MatGUID
            qty        = ConvertTo-AmeenNumber $r.Qty
            qty2       = ConvertTo-AmeenNumber $r.Qty2
            qty3       = ConvertTo-AmeenNumber $r.Qty3
            unity      = ConvertTo-AmeenNumber $r.Unity
            price      = ConvertTo-AmeenNumber $r.Price
            discount   = ConvertTo-AmeenNumber $r.Discount
            extra      = ConvertTo-AmeenNumber $r.Extra
            bonus_qty  = ConvertTo-AmeenNumber $r.BonusQnt
            vat        = ConvertTo-AmeenNumber $r.VAT
            store_guid = ConvertTo-AmeenGuidText $r.StoreGUID
            cost_guid  = ConvertTo-AmeenGuidText $r.CostGUID
        })
    }
    # ترتيب ثابت للأسطر: رقم السطر ثم معرّفه، فلا تتغيّر البصمة بترتيب قراءة SQL.
    $sorted = @($lineList | Sort-Object -Property @{ Expression = { if ($null -eq $_.number) { [double]::MaxValue } else { $_.number } } }, @{ Expression = { [string]$_.line_guid } })
    $name = $null
    if ($null -ne $Header.Cust_Name -and -not ($Header.Cust_Name -is [DBNull])) { $name = ([string]$Header.Cust_Name).Trim(); if ($name -eq "") { $name = $null } }
    $billType = [int]$Header.BillType
    return [ordered]@{
        bill_guid             = ConvertTo-AmeenGuidText $Header.GUID
        bill_type             = $billType
        is_return             = ($billType -eq 3)
        type_guid             = ConvertTo-AmeenGuidText $Header.TypeGUID
        number                = ConvertTo-AmeenNumber $Header.Number
        bill_date             = ([datetime]$Header.Date).ToString("yyyy-MM-dd", $script:Invariant)
        is_posted             = ([int]$Header.IsPosted -eq 1)
        rec_state             = ConvertTo-AmeenNumber $Header.RecState
        pay_type              = ConvertTo-AmeenNumber $Header.PayType
        customer_guid         = ConvertTo-AmeenGuidText $Header.CustGUID
        customer_account_guid = ConvertTo-AmeenGuidText $Header.CustAccGUID
        customer_name         = $name
        is_named              = ($null -ne $name)
        store_guid            = ConvertTo-AmeenGuidText $Header.StoreGUID
        currency_guid         = ConvertTo-AmeenGuidText $Header.CurrencyGUID
        currency_val          = ConvertTo-AmeenNumber $Header.CurrencyVal
        total                 = ConvertTo-AmeenNumber $Header.Total
        total_disc            = ConvertTo-AmeenNumber $Header.TotalDisc
        total_extra           = ConvertTo-AmeenNumber $Header.TotalExtra
        items_disc            = ConvertTo-AmeenNumber $Header.ItemsDisc
        items_extra           = ConvertTo-AmeenNumber $Header.ItemsExtra
        bonus_disc            = ConvertTo-AmeenNumber $Header.BonusDisc
        first_pay             = ConvertTo-AmeenNumber $Header.FirstPay
        vat                   = ConvertTo-AmeenNumber $Header.VAT
        refunded_bill_guid    = ConvertTo-AmeenGuidText $Header.RefundedBillGUID
        lines                 = $sorted
    }
}

# ---------------------------------------------------------------- JSON قانوني وبصمة
function ConvertTo-AmeenCanonicalJson {
    # JSON ثابت البايتات على 5.1 و7 وأي ثقافة: مفاتيح مرتبة، أرقام بالثقافة الثابتة "R"،
    # هروب صريح. لا يُستعمل ConvertTo-Json لأن تنسيقه يختلف بين الإصدارين.
    param($Value)
    if ($null -eq $Value -or $Value -is [DBNull]) { return "null" }
    if ($Value -is [bool]) { if ($Value) { return "true" } else { return "false" } }
    if ($Value -is [string]) {
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        foreach ($ch in $Value.ToCharArray()) {
            $code = [int]$ch
            if ($ch -eq '"') { [void]$sb.Append('\"') }
            elseif ($ch -eq '\') { [void]$sb.Append('\\') }
            elseif ($code -lt 0x20) { [void]$sb.Append('\u' + $code.ToString("x4", $script:Invariant)) }
            else { [void]$sb.Append($ch) }
        }
        [void]$sb.Append('"')
        return $sb.ToString()
    }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte]) { return ([long]$Value).ToString($script:Invariant) }
    if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) {
        $d = [double]$Value
        if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { throw "canonical json: non-finite number" }
        # تقريب لست خانات عشرية: يزيل ضجيج float ويجعل "R" متطابقاً بين .NET Framework و.NET Core
        # (الاختلاف بينهما محصور في قيم تحتاج 16–17 خانة معنوية).
        $d = [math]::Round($d, 6, [MidpointRounding]::AwayFromZero)
        if ($d -eq [math]::Floor($d) -and [math]::Abs($d) -lt 1e15) { return ([long]$d).ToString($script:Invariant) }
        return $d.ToString("R", $script:Invariant)
    }
    if ($Value -is [System.Collections.IDictionary]) {
        # ترتيب ترتيبي (Ordinal) لا ثقافي: الثقافي يختلف بين NLS في 5.1 وICU في 7.
        [string[]]$keys = @($Value.Keys | ForEach-Object { [string]$_ })
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        $parts = foreach ($k in $keys) { (ConvertTo-AmeenCanonicalJson $k) + ":" + (ConvertTo-AmeenCanonicalJson $Value[$k]) }
        return "{" + (@($parts) -join ",") + "}"
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = $p.Value }
        return ConvertTo-AmeenCanonicalJson $h
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $parts = foreach ($item in $Value) { ConvertTo-AmeenCanonicalJson $item }
        return "[" + (@($parts) -join ",") + "]"
    }
    throw ("canonical json: unsupported type " + $Value.GetType().FullName)
}

function Get-AmeenSha256Hex {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) } finally { $sha.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Get-AmeenInvoiceVersionHash {
    param([Parameter(Mandatory = $true)]$Snapshot)
    return Get-AmeenSha256Hex (ConvertTo-AmeenCanonicalJson $Snapshot)
}

# ---------------------------------------------------------------- الحالة
function Get-AmeenSeqSeed {
    # بذرة التسلسل من الساعة (ميلي ثانية UTC): حالة جديدة أو ضائعة تبدأ فوق كل تسلسل سابق،
    # فلا يتكرر (bill_guid, source_seq) أبداً ولا يُرفض حدث جديد كأنه قديم.
    param([datetime]$NowUtc = [datetime]::UtcNow)
    $epoch = New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc)
    return [long][math]::Floor(($NowUtc.ToUniversalTime() - $epoch).TotalMilliseconds)
}

function New-AmeenInvoiceState {
    param([datetime]$NowUtc = [datetime]::UtcNow)
    return @{ schema = "ameen-invoice-agent-state/v1"; last_seq = (Get-AmeenSeqSeed $NowUtc); watermark = $null; bills = @{}; send = @{ failures = 0; next_at = $null } }
}

function Get-AmeenInvoiceEventId {
    param([Parameter(Mandatory = $true)][string]$BillGuid, [Parameter(Mandatory = $true)][long]$Seq,
          [Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)][string]$VersionHash,
          [Parameter(Mandatory = $true)][string]$SourceEventAt)
    return Get-AmeenSha256Hex ("{0}|{1}|{2}|{3}|{4}" -f $BillGuid, $Seq.ToString($script:Invariant), $Kind, $VersionHash, $SourceEventAt)
}

function ConvertTo-AmeenHashtable {
    # ConvertFrom-Json في 5.1 لا يدعم -AsHashtable؛ تحويل عودي يدوي.
    param($Value)
    if ($null -eq $Value) { return $null }
    # PowerShell 7 يحوّل نصوص ISO إلى DateTime عند ConvertFrom-Json (و5.1 لا يفعل). كل أوقاتنا تُكتب
    # بصيغة واحدة yyyy-MM-ddTHH:mm:ss.fffZ، فنعيدها نصاً حرفياً كي يتطابق المفتاح على الإصدارين.
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", $script:Invariant) }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $h = @{}
        foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = ConvertTo-AmeenHashtable $p.Value }
        return $h
    }
    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        return ,@($Value | ForEach-Object { ConvertTo-AmeenHashtable $_ })
    }
    return $Value
}

# ---------------------------------------------------------------- محلّل التغييرات
function Resolve-AmeenInvoiceChanges {
    # المدخل: ملاحظات دورة رصد واحدة. كل ملاحظة:
    #   @{ guid; snapshot (لقطة أو $null إن لم تعد الفاتورة موجودة); ops = @(@{ op; at_utc }); detected_at_utc; source }
    # المخرج: أحداث مرتبة بتسلسل محلي متزايد، وتُحدَّث $State.bills و$State.last_seq في المكان.
    # قواعد عدم التكرار:
    #   * upsert يصدر فقط إن اختلفت بصمة المحتوى عن آخر ما صدر لهذا GUID.
    #   * delete يصدر فقط إن كانت الفاتورة غائبة فعلاً ولم يصدر لها delete سابق، وكان لها
    #     أثر معروف (نسخة صدرت سابقاً أو عملية حذف في السجل).
    param([Parameter(Mandatory = $true)][hashtable]$State, [Parameter(Mandatory = $true)]$Observations)
    $events = New-Object System.Collections.Generic.List[object]
    foreach ($o in @($Observations)) {
        if ($null -eq $o) { continue }
        $guid = ConvertTo-AmeenGuidText $o.guid
        if (-not $guid) { continue }
        $known = $null
        if ($State.bills.ContainsKey($guid)) { $known = $State.bills[$guid] }
        $ops = @($o.ops | Where-Object { $null -ne $_ })
        $opTimes = @($ops | ForEach-Object { [string]$_.at_utc } | Where-Object { $_ } | Sort-Object)
        $latestOp = $null; if ($opTimes.Count -gt 0) { $latestOp = $opTimes[$opTimes.Count - 1] }
        if ($null -ne $o.snapshot) {
            $version = Get-AmeenInvoiceVersionHash $o.snapshot
            if ($null -ne $known -and $known.v -eq $version) { $known.seen = $o.detected_at_utc; continue }
            # وقت المصدر: أحدث عملية في السجل، وإلا تعديل حقيقي، وإلا الإنشاء، وإلا وقت الرصد.
            $at = $latestOp
            if (-not $at -and $o.source_update_utc) { $at = [string]$o.source_update_utc }
            if (-not $at -and $o.source_create_utc) { $at = [string]$o.source_create_utc }
            if (-not $at) { $at = [string]$o.detected_at_utc }
            $State.last_seq = [long]$State.last_seq + 1
            $kind = "upsert"
            $eventId = Get-AmeenInvoiceEventId -BillGuid $guid -Seq ([long]$State.last_seq) -Kind $kind -VersionHash $version -SourceEventAt $at
            $events.Add([ordered]@{
                schema          = $script:AmeenInvoiceEventSchema
                event_id        = $eventId
                kind            = $kind
                bill_guid       = $guid
                version_hash    = $version
                source_event_at = $at
                source_seq      = [long]$State.last_seq
                detected_at     = [string]$o.detected_at_utc
                change          = $(if ($null -eq $known) { "created" } elseif ($known.v -eq "deleted") { "restored" } else { "updated" })
                bill            = $o.snapshot
            })
            $State.bills[$guid] = @{ v = $version; seen = $o.detected_at_utc; seq = [long]$State.last_seq }
        } else {
            $hasDeleteOp = @($ops | Where-Object { [int]$_.op -eq 2 }).Count -gt 0
            if ($null -ne $known -and $known.v -eq "deleted") { continue }
            if ($null -eq $known -and -not $hasDeleteOp) { continue }
            $at = $latestOp
            if (-not $at) { $at = [string]$o.detected_at_utc }
            $State.last_seq = [long]$State.last_seq + 1
            $kind = "delete"
            $eventId = Get-AmeenInvoiceEventId -BillGuid $guid -Seq ([long]$State.last_seq) -Kind $kind -VersionHash "deleted" -SourceEventAt $at
            $events.Add([ordered]@{
                schema          = $script:AmeenInvoiceEventSchema
                event_id        = $eventId
                kind            = $kind
                bill_guid       = $guid
                version_hash    = "deleted"
                source_event_at = $at
                source_seq      = [long]$State.last_seq
                detected_at     = [string]$o.detected_at_utc
                change          = "deleted"
            })
            $State.bills[$guid] = @{ v = "deleted"; seen = $o.detected_at_utc; seq = [long]$State.last_seq }
        }
    }
    return ,$events.ToArray()
}

# ---------------------------------------------------------------- صندوق الإرسال المحلي (Outbox)
# بنية المجلد:
#   <dir>\state.json              حالة الوكيل (آخر تسلسل، العلامة المائية، آخر نسخة لكل فاتورة، حالة الإرسال)
#   <dir>\pending\<seq:D12>.json  حدث واحد بانتظار التأكيد. الاسم يفرض الترتيب.
#   <dir>\acked.log               سطر لكل حدث أكّده الخادم (للتدقيق).
# الكتابة ذرّية: ملف مؤقت ثم نقل، فانقطاع الكهرباء لا يترك حدثاً نصف مكتوب.

function Write-AmeenAtomicFile {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content)
    $tmp = $Path + ".tmp-" + [guid]::NewGuid().ToString("N")
    [IO.File]::WriteAllText($tmp, $Content, (New-Object System.Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
}

function Initialize-AmeenInvoiceOutbox {
    param([Parameter(Mandatory = $true)][string]$Dir)
    foreach ($d in @($Dir, (Join-Path $Dir "pending"))) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
    # بقايا كتابة مقطوعة: الملف المؤقت لم يُنقل، فالحدث لم يُسجَّل أصلاً ولا يُرسل.
    Get-ChildItem -LiteralPath (Join-Path $Dir "pending") -Filter "*.tmp-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

function Read-AmeenInvoiceState {
    param([Parameter(Mandatory = $true)][string]$Dir)
    $p = Join-Path $Dir "state.json"
    if (Test-Path -LiteralPath $p) {
        $h = ConvertTo-AmeenHashtable (Get-Content -Raw -LiteralPath $p -Encoding UTF8 | ConvertFrom-Json)
        if ($h.schema -ne "ameen-invoice-agent-state/v1") { throw "unsupported agent state schema" }
    } else {
        $h = New-AmeenInvoiceState
    }
    if ($null -eq $h.bills) { $h.bills = @{} }
    if ($null -eq $h.send) { $h.send = @{ failures = 0; next_at = $null } }
    $h.last_seq = [long]$h.last_seq
    # التسلسل لا يتراجع أبداً: إن ضاعت الحالة وبقيت أحداث معلّقة، نبدأ بعد أكبرها.
    $maxPending = Get-AmeenOutboxMaxSeq $Dir
    if ($maxPending -gt $h.last_seq) { $h.last_seq = $maxPending }
    return $h
}

function Save-AmeenInvoiceState {
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State)
    Write-AmeenAtomicFile -Path (Join-Path $Dir "state.json") -Content (ConvertTo-AmeenCanonicalJson $State)
}

function Get-AmeenOutboxMaxSeq {
    param([Parameter(Mandatory = $true)][string]$Dir)
    $max = [long]0
    $pd = Join-Path $Dir "pending"
    if (Test-Path -LiteralPath $pd) {
        foreach ($f in Get-ChildItem -LiteralPath $pd -Filter "*.json") {
            $n = [long]0
            if ([long]::TryParse([IO.Path]::GetFileNameWithoutExtension($f.Name), [ref]$n) -and $n -gt $max) { $max = $n }
        }
    }
    return $max
}

function Add-AmeenOutboxEvents {
    # يُكتب كل حدث قبل حفظ الحالة: إن انقطع التيار بينهما يُعاد رصد الفاتورة ويصدر الحدث بتسلسل
    # أحدث؛ الخادم يجد النسخة نفسها فيعيد noop (أو stale إن سبقه الأحدث) — لا فقدان ولا صف مكرر.
    param([Parameter(Mandatory = $true)][string]$Dir, $Events)
    foreach ($e in @($Events)) {
        if ($null -eq $e) { continue }
        $name = ([long]$e.source_seq).ToString("D12", $script:Invariant) + ".json"
        Write-AmeenAtomicFile -Path (Join-Path (Join-Path $Dir "pending") $name) -Content (ConvertTo-AmeenCanonicalJson $e)
    }
}

function Get-AmeenOutboxPending {
    param([Parameter(Mandatory = $true)][string]$Dir, [int]$Max = 50)
    $pd = Join-Path $Dir "pending"
    $files = @(Get-ChildItem -LiteralPath $pd -Filter "*.json" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First $Max)
    $list = New-Object System.Collections.Generic.List[object]
    foreach ($f in $files) {
        $evt = ConvertTo-AmeenHashtable (Get-Content -Raw -LiteralPath $f.FullName -Encoding UTF8 | ConvertFrom-Json)
        $list.Add(@{ file = $f.FullName; event = $evt })
    }
    return ,$list.ToArray()
}

function Get-AmeenBackoffSeconds {
    param([int]$Failures)
    if ($Failures -le 0) { return 0 }
    $s = [math]::Pow(2, [math]::Min($Failures, 9))
    return [int][math]::Min(300, $s)
}

# ---------------------------------------------------------------- التحقق والعزل (Dead Letter)
function Test-AmeenInvoiceEvent {
    # نفس قواعد الخادم حدثاً حدثاً. يعيد $null للحدث السليم، وإلا @{ code; reason } بلا محتوى الفاتورة.
    param([Parameter(Mandatory = $true)]$Event, [datetime]$NowUtc = [datetime]::UtcNow)
    $bad = { param($c, $r) return @{ code = $c; reason = $r } }
    if (-not ($Event -is [System.Collections.IDictionary])) { return (& $bad "not_object" "event must be an object") }
    if ($Event.schema -ne $script:AmeenInvoiceEventSchema) { return (& $bad "schema" "unsupported event schema") }
    $seq = [long]0
    if (-not [long]::TryParse([string]$Event.source_seq, [ref]$seq) -or $seq -lt 1) { return (& $bad "seq" "source_seq must be a positive integer") }
    if ([string]$Event.event_id -notmatch '^[0-9a-f]{64}$') { return (& $bad "event_id" "event_id must be a sha256 hex") }
    if (@("upsert", "delete") -notcontains [string]$Event.kind) { return (& $bad "kind" "unsupported event kind") }
    $g = [string]$Event.bill_guid
    if ($g -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $g -eq $script:ZeroGuid) { return (& $bad "bill_guid" "bill_guid must be a lowercase non-zero uuid") }
    $h = [string]$Event.version_hash
    if (($Event.kind -eq "upsert" -and $h -notmatch '^[0-9a-f]{64}$') -or ($Event.kind -eq "delete" -and $h -ne "deleted")) { return (& $bad "version_hash" "version_hash does not match event kind") }
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    $at = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$Event.source_event_at, $script:Invariant, $styles, [ref]$at)) { return (& $bad "timestamp" "event timestamp is invalid") }
    if ($at -gt $NowUtc.AddMinutes(5)) { return (& $bad "future" "event timestamp is in the future") }
    if ($Event.detected_at) {
        $det = [datetime]::MinValue
        if (-not [datetime]::TryParse([string]$Event.detected_at, $script:Invariant, $styles, [ref]$det)) { return (& $bad "timestamp" "event timestamp is invalid") }
        if ($det -gt $NowUtc.AddMinutes(5)) { return (& $bad "future" "event timestamp is in the future") }
    }
    $expected = Get-AmeenInvoiceEventId -BillGuid $g -Seq $seq -Kind ([string]$Event.kind) -VersionHash $h -SourceEventAt ([string]$Event.source_event_at)
    if ($Event.event_id -ne $expected) { return (& $bad "event_id" "event_id does not match event content") }
    if ($Event.kind -eq "upsert") {
        $b = $Event.bill
        if (-not ($b -is [System.Collections.IDictionary]) -or [string]$b.bill_guid -ne $g -or @(1, 3) -notcontains [int]$b.bill_type -or $null -eq $b.lines) { return (& $bad "bill" "upsert needs a bill snapshot for the same bill_guid") }
        if ($b.bill_date -and [string]$b.bill_date -notmatch '^\d{4}-\d{2}-\d{2}$') { return (& $bad "bill" "bill_date must be YYYY-MM-DD") }
        if ([Text.Encoding]::UTF8.GetByteCount((ConvertTo-AmeenCanonicalJson $b)) -gt 262144) { return (& $bad "size" "bill snapshot too large") }
        if ((Get-AmeenInvoiceVersionHash $b) -ne $h) { return (& $bad "version_hash" "version_hash does not match bill content") }
    }
    return $null
}

function Move-AmeenEventToDeadLetter {
    # ينقل ملف الحدث إلى deadletter\ ويكتب بجانبه سبباً مختصراً. السبب والسجل بلا محتوى الفاتورة
    # (لا اسم زبون ولا مبالغ): المعرّف والتسلسل وGUID الفاتورة والنوع والرمز فقط.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$File, [Parameter(Mandatory = $true)]$Event,
          [Parameter(Mandatory = $true)][string]$Code, [Parameter(Mandatory = $true)][string]$Reason, [Parameter(Mandatory = $true)][string]$Source,
          [datetime]$NowUtc = [datetime]::UtcNow)
    $dl = Join-Path $Dir "deadletter"
    if (-not (Test-Path -LiteralPath $dl)) { New-Item -ItemType Directory -Path $dl -Force | Out-Null }
    $name = [IO.Path]::GetFileNameWithoutExtension($File)
    $safeReason = ($Reason -replace '[\r\n\t]', ' ')
    if ($safeReason.Length -gt 200) { $safeReason = $safeReason.Substring(0, 200) }
    $info = [ordered]@{
        event_id = [string]$Event.event_id; source_seq = [string]$Event.source_seq; bill_guid = [string]$Event.bill_guid
        kind = [string]$Event.kind; reason_code = $Code; reason = $safeReason; source = $Source
        at = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant)
    }
    Write-AmeenAtomicFile -Path (Join-Path $dl ($name + ".reason.json")) -Content (ConvertTo-AmeenCanonicalJson $info)
    Move-Item -LiteralPath $File -Destination (Join-Path $dl ($name + ".json")) -Force
    Add-Content -LiteralPath (Join-Path $Dir "deadletter.log") -Value ("{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}" -f $info.at, $info.source_seq, $info.event_id, $info.bill_guid, $info.kind, $Source, $Code) -Encoding UTF8
}

function Get-AmeenDeadLetters {
    param([Parameter(Mandatory = $true)][string]$Dir)
    # تُعاد العناصر عبر خط الأنابيب (لا مصفوفة ملفوفة) كي يعمل Where-Object عليها؛ المستدعي يلفّها بـ @().
    $dl = Join-Path $Dir "deadletter"
    $list = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $dl)) { return }
    foreach ($f in @(Get-ChildItem -LiteralPath $dl -Filter "*.reason.json" | Sort-Object Name)) {
        $info = ConvertTo-AmeenHashtable (Get-Content -Raw -LiteralPath $f.FullName -Encoding UTF8 | ConvertFrom-Json)
        $info.file = Join-Path $dl ($f.Name -replace '\.reason\.json$', '.json')
        $info.reason_file = $f.FullName
        $list.Add($info)
    }
    return $list.ToArray()
}

function Repair-AmeenDeadLetter {
    # طريقتان آمنتان لإصلاح حدث معزول دون فقدانه ودون كسر الترتيب:
    #   Resnapshot: يُعلَّم أن الفاتورة تحتاج لقطة جديدة؛ المطابقة التالية تقرأ حالتها الحالية من الأمين
    #               وتُصدر حدثاً بتسلسل أحدث (الحالة الحالية هي الحقيقة، لا المحتوى القديم المعطوب).
    #   Requeue:    الحدث نفسه بعد تصحيح ملفه يدوياً: تُعاد البصمة والمفتاح بتسلسله الأصلي، ويُتحقق منه،
    #               ثم يعود إلى pending\ في موضعه. إن سبقه حدث أحدث للفاتورة نفسها فالخادم يعدّه stale.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State,
          [Parameter(Mandatory = $true)][long]$Seq, [ValidateSet("Resnapshot", "Requeue")][string]$Mode = "Resnapshot",
          [datetime]$NowUtc = [datetime]::UtcNow)
    $item = @(Get-AmeenDeadLetters -Dir $Dir | Where-Object { [long]$_.source_seq -eq $Seq }) | Select-Object -First 1
    if ($null -eq $item) { throw "dead letter seq $Seq not found" }
    $resolved = Join-Path (Join-Path $Dir "deadletter") "resolved"
    if (-not (Test-Path -LiteralPath $resolved)) { New-Item -ItemType Directory -Path $resolved -Force | Out-Null }
    $stamp = $NowUtc.ToString("yyyyMMddTHHmmssZ", $script:Invariant)
    if ($Mode -eq "Resnapshot") {
        $State.bills[[string]$item.bill_guid] = @{ v = "resnapshot"; fp = $null; seen = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", $script:Invariant) }
    } else {
        $evt = ConvertTo-AmeenHashtable (Get-Content -Raw -LiteralPath $item.file -Encoding UTF8 | ConvertFrom-Json)
        if ($evt.kind -eq "upsert" -and $evt.bill -is [System.Collections.IDictionary]) { $evt.version_hash = Get-AmeenInvoiceVersionHash $evt.bill }
        $evt.source_seq = $Seq
        $evt.event_id = Get-AmeenInvoiceEventId -BillGuid ([string]$evt.bill_guid) -Seq $Seq -Kind ([string]$evt.kind) -VersionHash ([string]$evt.version_hash) -SourceEventAt ([string]$evt.source_event_at)
        $why = Test-AmeenInvoiceEvent -Event $evt -NowUtc $NowUtc
        if ($null -ne $why) { throw ("requeue refused (" + $why.code + "): " + $why.reason) }
        $target = Join-Path (Join-Path $Dir "pending") (([long]$Seq).ToString("D12", $script:Invariant) + ".json")
        if (Test-Path -LiteralPath $target) { throw "requeue refused: pending already has seq $Seq" }
        Write-AmeenAtomicFile -Path $target -Content (ConvertTo-AmeenCanonicalJson $evt)
    }
    $base = [IO.Path]::GetFileNameWithoutExtension($item.file)
    Move-Item -LiteralPath $item.file -Destination (Join-Path $resolved ("{0}.{1}.{2}.json" -f $base, $Mode.ToLowerInvariant(), $stamp)) -Force
    Move-Item -LiteralPath $item.reason_file -Destination (Join-Path $resolved ("{0}.{1}.{2}.reason.json" -f $base, $Mode.ToLowerInvariant(), $stamp)) -Force
    Add-Content -LiteralPath (Join-Path $Dir "deadletter.log") -Value ("{0}`t{1}`t{2}`t{3}`trepaired`t{4}" -f $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant), $Seq, $item.event_id, $item.bill_guid, $Mode) -Encoding UTF8
    return $Mode
}

function Send-AmeenInvoiceOutbox {
    # يرسل المعلّق بترتيب التسلسل. Transport: scriptblock يستقبل مصفوفة الأحداث ويعيد مصفوفة
    # @{ event_id; index; outcome; reason_code; reason }.
    #   applied|duplicate|stale|noop ⇒ استُلم ويُزال.   rejected ⇒ يُعزل في deadletter\ وتكمل البقية.
    # الحدث الذي يرفضه التحقق المحلي يُعزل قبل الإرسال ولا يحجز ما بعده.
    # فشل النقل (استثناء، رد ناقص، نتيجة غير معروفة) ⇒ لا يُحذف شيء، ويُؤجَّل الإرسال تراجعياً.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State,
          [Parameter(Mandatory = $true)][scriptblock]$Transport, [datetime]$NowUtc = [datetime]::UtcNow, [int]$BatchSize = 50)
    $result = @{ sent = 0; acked = 0; deadlettered = 0; skipped_backoff = $false; error = $null; outcomes = @{} }
    if ($State.send.next_at) {
        $next = [datetime]::Parse([string]$State.send.next_at, $script:Invariant, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($NowUtc -lt $next) { $result.skipped_backoff = $true; return $result }
    }
    $pending = Get-AmeenOutboxPending -Dir $Dir -Max $BatchSize
    if ($pending.Count -eq 0) { return $result }
    $valid = New-Object System.Collections.Generic.List[object]
    foreach ($p in $pending) {
        $why = Test-AmeenInvoiceEvent -Event $p.event -NowUtc $NowUtc
        if ($null -ne $why) {
            Move-AmeenEventToDeadLetter -Dir $Dir -File $p.file -Event $p.event -Code $why.code -Reason $why.reason -Source "local" -NowUtc $NowUtc
            $result.deadlettered++
            $result.outcomes[[string]$p.event.event_id] = "deadletter"
        } else { $valid.Add($p) }
    }
    if ($valid.Count -eq 0) { return $result }
    $events = @($valid | ForEach-Object { $_.event })
    $result.sent = $events.Count
    try {
        $responses = @(& $Transport $events)
        $byId = @{}
        foreach ($r in $responses) {
            if ($null -eq $r) { continue }
            $id = [string]$r.event_id
            if (-not $id -and $r.index) { $i = [int]$r.index - 1; if ($i -ge 0 -and $i -lt $valid.Count) { $id = [string]$valid[$i].event.event_id } }
            if ($id) { $byId[$id] = $r }
        }
        foreach ($p in $valid) {
            $id = [string]$p.event.event_id
            if (-not $byId.ContainsKey($id)) { throw "server response missing event $id" }
            if (@("applied", "duplicate", "stale", "noop", "rejected") -notcontains [string]$byId[$id].outcome) { throw ("unexpected outcome " + $byId[$id].outcome + " for " + $id) }
        }
        $ackLog = Join-Path $Dir "acked.log"
        foreach ($p in $valid) {
            $id = [string]$p.event.event_id
            $r = $byId[$id]
            if ([string]$r.outcome -eq "rejected") {
                $code = [string]$r.reason_code; if (-not $code) { $code = "server" }
                $reason = [string]$r.reason; if (-not $reason) { $reason = "rejected by server" }
                Move-AmeenEventToDeadLetter -Dir $Dir -File $p.file -Event $p.event -Code $code -Reason $reason -Source "server" -NowUtc $NowUtc
                $result.deadlettered++
            } else {
                Add-Content -LiteralPath $ackLog -Value ("{0}`t{1}`t{2}`t{3}`t{4}" -f $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant), $p.event.source_seq, $p.event.bill_guid, $p.event.kind, $r.outcome) -Encoding UTF8
                Remove-Item -LiteralPath $p.file -Force
                $result.acked++
            }
            $result.outcomes[$id] = [string]$r.outcome
        }
        $State.send.failures = 0; $State.send.next_at = $null
    } catch {
        $State.send.failures = [int]$State.send.failures + 1
        $State.send.next_at = $NowUtc.AddSeconds((Get-AmeenBackoffSeconds $State.send.failures)).ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant)
        $result.error = $_.Exception.Message
    }
    return $result
}
