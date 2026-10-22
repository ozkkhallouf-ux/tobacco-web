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
# حدّ جسم طلب الإرسال بالبايتات (UTF-8): أدنى بهامش واسع من حدّ الخادم 4194304 لـ pg_column_size(jsonb)،
# لأن تمثيل jsonb قد يكبر عن النص قليلاً.
$script:AmeenMaxBatchBytes = 2621440
# نص لا يحتاج هروباً (لا علامة اقتباس ولا شرطة مائلة ولا محرف تحكم) يُنسخ كما هو في JSON القانوني.
$script:AmeenJsonNeedsEscape = New-Object System.Text.RegularExpressions.Regex('[\x00-\x1f"\\]', [System.Text.RegularExpressions.RegexOptions]::Compiled)
# الحفظ الكامل الدوري لملف الحالة حتى بلا تغيير جوهري (يثبّت «seen» وما شابه). ما عداه يُحفظ عند التغيّر فقط.
$script:AmeenStateFullSaveMinutes = 10
# محاولات استبدال الملف في الكتابة الذرّية (تراجع 25←50←100←200 ms بين المحاولات).
$script:AmeenAtomicReplaceAttempts = 5

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
        # المسار السريع (أداء، 2026-10-22): أغلب النصوص (GUID، بصمات، أوقات، أسماء) لا تحتاج هروباً،
        # والمرور عليها محرفاً محرفاً كان يكلّف ثوانيَ لكل حفظ للحالة على 5.1. الناتج مطابق بايتاً ببايت.
        if (-not $script:AmeenJsonNeedsEscape.IsMatch($Value)) { return '"' + $Value + '"' }
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
    # ملف مؤقت يُكتب كاملاً ويُدفع إلى القرص (Flush(true)) ثم يحلّ محل الأصل دفعة واحدة: انقطاع الكهرباء
    # يترك إمّا النسخة القديمة كاملة وإمّا الجديدة كاملة، وبقايا .tmp-* تُزال عند البدء.
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Content)
    $tmp = $Path + ".tmp-" + [guid]::NewGuid().ToString("N")
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Content)
    $fs = New-Object System.IO.FileStream($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
    # الاستبدال قد يُرفض لحظياً إن فتح برنامج آخر الأصل (مكافح الفيروسات أو الفهرسة على Windows) —
    # ثبت فعلياً على OZK2026 مع الحفظ كل ثانيتين. إعادة محاولة قصيرة متصاعدة (~0.4 ث)، ثم رمي بلا بقايا.
    for ($attempt = 1; ; $attempt++) {
        try {
            if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
            return
        } catch {
            if ($attempt -ge $script:AmeenAtomicReplaceAttempts) {
                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                throw
            }
            Start-Sleep -Milliseconds (25 * [int][math]::Pow(2, $attempt - 1))
        }
    }
}

function Enter-AmeenOutboxLock {
    # قفل مثيل واحد لكل مجلد صندوق (Codex P1 على da7413e8): مثيلان على المجلد نفسه قد يقرآن التسلسل N
    # فيخصّص كلٌّ منهما N+1 ويكتب فوق ملف الآخر وتتسابق كتابة الحالة. القفل ملف agent.lock مفتوح حصرياً
    # (FileShare.None) طوال عمر العملية؛ يحرّره نظام التشغيل تلقائياً عند خروجها ولو انهارت، فلا قفل عالق.
    # يعيد مقبض القفل، أو $null إن كان مثيل آخر يملكه.
    param([Parameter(Mandatory = $true)][string]$Dir)
    if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
    $p = Join-Path $Dir "agent.lock"
    try { $fs = [IO.File]::Open($p, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) } catch { return $null }
    try {
        $info = [Text.Encoding]::UTF8.GetBytes(("pid={0} host={1} since={2}" -f $PID, [Environment]::MachineName, [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant)))
        $fs.SetLength(0); $fs.Write($info, 0, $info.Length); $fs.Flush()
    } catch {
        # معلومات القفل (pid والوقت) للتشخيص فقط؛ القفل نفسه مأخوذ بفتح الملف حصرياً، فلا يُفشل التشغيل.
        Write-Verbose ("agent.lock info not written: " + $_.Exception.GetType().Name)
    }
    return $fs
}

function Exit-AmeenOutboxLock {
    param($Lock)
    if ($null -ne $Lock) { $Lock.Dispose() }
}

function Test-AmeenSendActivated {
    # مفتاح الإرسال: يُطلب -Send ويوجد <Dir>\send-enabled.flag بمحتوى enabled-by-owner. يُعاد فحصه قبل كل
    # دفعة (Codex P1 على 51783c90): حذف الملف هو خطوة الإيقاف الموثّقة، فيجب أن يوقف الإرسال في الدورة
    # التالية لا عند إعادة تشغيل العملية. أي خطأ في القراءة = إيقاف (fail closed).
    param([Parameter(Mandatory = $true)][string]$Dir, [switch]$SendRequested)
    if (-not $SendRequested) { return $false }
    $flag = Join-Path $Dir "send-enabled.flag"
    try {
        if (-not (Test-Path -LiteralPath $flag)) { return $false }
        return ((Get-Content -Raw -LiteralPath $flag -ErrorAction Stop).Trim() -eq "enabled-by-owner")
    } catch { return $false }
}

function Initialize-AmeenInvoiceOutbox {
    param([Parameter(Mandatory = $true)][string]$Dir)
    foreach ($d in @($Dir, (Join-Path $Dir "pending"))) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
    # بقايا كتابة مقطوعة: الملف المؤقت لم يُنقل، فالحدث لم يُسجَّل أصلاً ولا يُرسل. وكذلك بقايا حفظ الحالة
    # أو العلامة المائية: الأصل باقٍ كاملاً لأن الاستبدال لم يقع.
    Get-ChildItem -LiteralPath (Join-Path $Dir "pending") -Filter "*.tmp-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    foreach ($f in @("state.json.tmp-*", "watermark.json.tmp-*")) { Get-ChildItem -LiteralPath $Dir -Filter $f -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }
}

function Read-AmeenJsonFileSafe {
    # قراءة وتحليل ملف JSON واحد بلا رمي: { ok; value } أو { ok = $false; error } — الخطأ نوعه فقط،
    # لا محتوى الملف (قد يحوي بيانات فاتورة).
    param([Parameter(Mandatory = $true)][string]$Path)
    $raw = $null
    try {
        $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return @{ ok = $false; error = "empty file"; raw = $raw } }
        $obj = $raw | ConvertFrom-Json -ErrorAction Stop
        return @{ ok = $true; value = (ConvertTo-AmeenHashtable $obj); raw = $raw }
    } catch {
        return @{ ok = $false; error = ("unreadable json (" + $_.Exception.GetType().Name + ")"); raw = $raw }
    }
}

function Get-AmeenSafeEventIds {
    # معرّفات آمنة من نص ملف تالف — أنماط ثابتة الشكل فقط (sha256، GUID، أرقام)، لا أي نص حر.
    param([AllowNull()][string]$Raw, [string]$FileName)
    $ids = @{ event_id = ""; bill_guid = ""; source_seq = ""; kind = "" }
    $n = [long]0
    if ([long]::TryParse([IO.Path]::GetFileNameWithoutExtension([string]$FileName), [ref]$n)) { $ids.source_seq = $n.ToString($script:Invariant) }
    if ($Raw) {
        if ($Raw -match '"event_id"\s*:\s*"([0-9a-f]{64})"') { $ids.event_id = $Matches[1] }
        if ($Raw -match '"bill_guid"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"') { $ids.bill_guid = $Matches[1] }
        if ($Raw -match '"kind"\s*:\s*"(upsert|delete)"') { $ids.kind = $Matches[1] }
    }
    return $ids
}

function Read-AmeenInvoiceState {
    param([Parameter(Mandatory = $true)][string]$Dir)
    $p = Join-Path $Dir "state.json"
    $h = $null
    if (Test-Path -LiteralPath $p) {
        $read = Read-AmeenJsonFileSafe -Path $p
        if ($read.ok -and $read.value -is [System.Collections.IDictionary] -and $read.value.schema -eq "ameen-invoice-agent-state/v1") {
            $h = $read.value
            # العلامة المائية بتوقيت خادم الأمين المحلي بلا منطقة؛ PowerShell 7 يحوّلها عند القراءة إلى UTC
            # بلاحقة Z فتنزاح وتفشل ParseExact في الوكيل. تُؤخذ حرفياً من نص الملف على الإصدارين.
            $h.watermark = Get-AmeenRawWatermark $read.raw
        } else {
            # حالة تالفة لا توقف الوكيل: تُنقل جانباً كما هي (لا حذف) ونبدأ حالة جديدة. التسلسل يبدأ من
            # الساعة وفوق كل معلّق، والنسخ المعروفة تُعاد معرفتها بالمطابقة (الخادم يعيد noop للمطابق).
            $aside = Join-Path $Dir ("state.corrupt-" + [datetime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ", $script:Invariant) + ".json")
            Move-Item -LiteralPath $p -Destination $aside -Force
        }
    }
    if ($null -eq $h) { $h = New-AmeenInvoiceState }
    if ($null -eq $h.bills) { $h.bills = @{} }
    if ($null -eq $h.send) { $h.send = @{ failures = 0; next_at = $null } }
    $h.last_seq = [long]$h.last_seq
    # العلامة المائية تُحفظ كل دورة في ملف صغير مستقل، والحالة الكاملة عند تغيّرها فقط. تُعتمد الأحدث منهما
    # فقط إن كُتبت لنفس نسخة الحالة (state_seq = last_seq المحفوظ): ملف الحالة يُحفظ دائماً قبل العلامة،
    # فتطابق التسلسل يعني أن كل ما رُصد حتى تلك العلامة محفوظ. أي شك (تالف، تسلسل مختلف) ⇒ تُتجاهل
    # ونرصد من علامة الحالة الأقدم — إعادة رصد آمنة لا تكرر حدثاً لأن النسخ المعروفة لا تُصدر ثانية.
    $wmPath = Join-Path $Dir "watermark.json"
    if ($h.watermark -and (Test-Path -LiteralPath $wmPath)) {
        $wm = Read-AmeenJsonFileSafe -Path $wmPath
        $wmText = $null; if ($wm.ok) { $wmText = Get-AmeenRawWatermark $wm.raw }
        if ($wmText -and $wm.value -is [System.Collections.IDictionary] -and $wm.value.schema -eq "ameen-invoice-agent-watermark/v1" -and
            [long]$wm.value.state_seq -eq [long]$h.last_seq -and [string]::CompareOrdinal($wmText, [string]$h.watermark) -gt 0) {
            $h.watermark = $wmText
        }
    }
    # التسلسل لا يتراجع أبداً: إن ضاعت الحالة وبقيت أحداث معلّقة، نبدأ بعد أكبرها.
    $maxPending = Get-AmeenOutboxMaxSeq $Dir
    if ($maxPending -gt $h.last_seq) { $h.last_seq = $maxPending }
    return $h
}

function Get-AmeenRawWatermark {
    # «watermark» حرفياً من نص JSON بصيغة yyyy-MM-ddTHH:mm:ss.fff (توقيت الأمين المحلي)، وإلا $null.
    param([AllowNull()][string]$Raw)
    if ($Raw -and $Raw -match '"watermark"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})"') { return $Matches[1] }
    return $null
}

function Save-AmeenInvoiceState {
    # الحفظ الكامل: الحالة أولاً ثم العلامة المائية المطابقة لها (الترتيب شرط لصحة Read-AmeenInvoiceState).
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State)
    Write-AmeenAtomicFile -Path (Join-Path $Dir "state.json") -Content (ConvertTo-AmeenCanonicalJson $State)
    [void](Save-AmeenInvoiceWatermark -Dir $Dir -State $State)
}

function Save-AmeenInvoiceWatermark {
    # حفظ خفيف لكل دورة بلا تغيير جوهري: العلامة المائية وحدها مع تسلسل الحالة التي تنتمي إليها.
    # فشله لا يوقف الوكيل: العلامة تحسين فقط (فقدها = إعادة رصد آمنة)، والدورة التالية تكتبها مجدداً.
    # يعيد $true عند النجاح و$false عند الفشل.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State)
    if (-not $State.watermark) { return $true }
    $wm = @{ schema = "ameen-invoice-agent-watermark/v1"; watermark = [string]$State.watermark; state_seq = [long]$State.last_seq }
    try {
        Write-AmeenAtomicFile -Path (Join-Path $Dir "watermark.json") -Content (ConvertTo-AmeenCanonicalJson $wm)
        return $true
    } catch {
        Write-Verbose ("watermark.json not saved: " + $_.Exception.GetType().Name)
        return $false
    }
}

function Get-AmeenStateSaveMode {
    # «full» حين تغيّر شيء جوهري (حدث جديد، بصمة مطابقة، إزالة فاتورة، إرسال) أو مضت الفترة الدورية؛
    # وإلا «watermark»: لا يُعاد كتابة ملف الحالة كله في كل دورة رصد.
    param([bool]$Dirty, [datetime]$LastFullSaveUtc, [datetime]$NowUtc = [datetime]::UtcNow, [int]$FullSaveMinutes = $script:AmeenStateFullSaveMinutes)
    if ($Dirty) { return "full" }
    if (($NowUtc - $LastFullSaveUtc).TotalMinutes -ge $FullSaveMinutes) { return "full" }
    return "watermark"
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

function Get-AmeenOutboxBatch {
    # أول $Max ملفاً معلّقاً بترتيب الاسم (= التسلسل). كل ملف يُقرأ ويُحلَّل منفرداً: الملف التالف أو
    # المقطوع يُعزل في deadletter\ (سبب + اسم الملف + معرّفات آمنة، بلا محتواه) ولا يوقف بقية الملفات.
    # لا يُحذف شيء: العزل نقلٌ للملف كما هو بعد كتابة سببه؛ إن تعذّر النقل يبقى مكانه ويُتخطى.
    param([Parameter(Mandatory = $true)][string]$Dir, [int]$Max = 50, [datetime]$NowUtc = [datetime]::UtcNow)
    $pd = Join-Path $Dir "pending"
    $files = @(Get-ChildItem -LiteralPath $pd -Filter "*.json" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First $Max)
    $list = New-Object System.Collections.Generic.List[object]
    $isolated = 0; $skipped = 0
    foreach ($f in $files) {
        $read = Read-AmeenJsonFileSafe -Path $f.FullName
        if ($read.ok -and $read.value -is [System.Collections.IDictionary]) { $list.Add(@{ file = $f.FullName; event = $read.value }); continue }
        $why = $read.error; if ($read.ok) { $why = "event must be an object" }
        try {
            Move-AmeenEventToDeadLetter -Dir $Dir -File $f.FullName -InvoiceEvent $null -SafeIds (Get-AmeenSafeEventIds -Raw $read.raw -FileName $f.Name) -Code "unreadable_json" -Reason $why -Source "local" -NowUtc $NowUtc
            $isolated++
        } catch { $skipped++ }
    }
    return @{ items = $list.ToArray(); isolated = $isolated; skipped = $skipped }
}

function Get-AmeenOutboxPending {
    # العناصر تُعاد عبر خط الأنابيب (لا مصفوفة ملفوفة) كي يرى Where-Object كل حدث على حدة؛
    # المستدعي يلفّ النتيجة بـ @() قبل .Count أو الفهرسة.
    param([Parameter(Mandatory = $true)][string]$Dir, [int]$Max = 50)
    return (Get-AmeenOutboxBatch -Dir $Dir -Max $Max).items
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
    param([Parameter(Mandatory = $true)]$InvoiceEvent, [datetime]$NowUtc = [datetime]::UtcNow)
    $bad = { param($c, $r) return @{ code = $c; reason = $r } }
    if (-not ($InvoiceEvent -is [System.Collections.IDictionary])) { return (& $bad "not_object" "event must be an object") }
    if ($InvoiceEvent.schema -ne $script:AmeenInvoiceEventSchema) { return (& $bad "schema" "unsupported event schema") }
    $seq = [long]0
    if (-not [long]::TryParse([string]$InvoiceEvent.source_seq, [ref]$seq) -or $seq -lt 1) { return (& $bad "seq" "source_seq must be a positive integer") }
    if ([string]$InvoiceEvent.event_id -notmatch '^[0-9a-f]{64}$') { return (& $bad "event_id" "event_id must be a sha256 hex") }
    if (@("upsert", "delete") -notcontains [string]$InvoiceEvent.kind) { return (& $bad "kind" "unsupported event kind") }
    $g = [string]$InvoiceEvent.bill_guid
    if ($g -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or $g -eq $script:ZeroGuid) { return (& $bad "bill_guid" "bill_guid must be a lowercase non-zero uuid") }
    $h = [string]$InvoiceEvent.version_hash
    if (($InvoiceEvent.kind -eq "upsert" -and $h -notmatch '^[0-9a-f]{64}$') -or ($InvoiceEvent.kind -eq "delete" -and $h -ne "deleted")) { return (& $bad "version_hash" "version_hash does not match event kind") }
    $styles = [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal
    $at = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$InvoiceEvent.source_event_at, $script:Invariant, $styles, [ref]$at)) { return (& $bad "timestamp" "event timestamp is invalid") }
    if ($at -gt $NowUtc.AddMinutes(5)) { return (& $bad "future" "event timestamp is in the future") }
    if ($InvoiceEvent.detected_at) {
        $det = [datetime]::MinValue
        if (-not [datetime]::TryParse([string]$InvoiceEvent.detected_at, $script:Invariant, $styles, [ref]$det)) { return (& $bad "timestamp" "event timestamp is invalid") }
        if ($det -gt $NowUtc.AddMinutes(5)) { return (& $bad "future" "event timestamp is in the future") }
    }
    $expected = Get-AmeenInvoiceEventId -BillGuid $g -Seq $seq -Kind ([string]$InvoiceEvent.kind) -VersionHash $h -SourceEventAt ([string]$InvoiceEvent.source_event_at)
    if ($InvoiceEvent.event_id -ne $expected) { return (& $bad "event_id" "event_id does not match event content") }
    if ($InvoiceEvent.kind -eq "upsert") {
        $b = $InvoiceEvent.bill
        # تحويل آمن (Codex P1 على 7dbd9915): نص غير رقمي أو رقم خارج Int32 كان يرمي هنا فيُسقط الوكيل.
        $bt = 0
        $btOk = ($b -is [System.Collections.IDictionary]) -and [int]::TryParse([string]$b.bill_type, [Globalization.NumberStyles]::Integer, $script:Invariant, [ref]$bt)
        if (-not $btOk -or [string]$b.bill_guid -ne $g -or @(1, 3) -notcontains $bt -or $null -eq $b.lines) { return (& $bad "bill" "upsert needs a bill snapshot for the same bill_guid") }
        if ($b.bill_date -and [string]$b.bill_date -notmatch '^\d{4}-\d{2}-\d{2}$') { return (& $bad "bill" "bill_date must be YYYY-MM-DD") }
        if ([Text.Encoding]::UTF8.GetByteCount((ConvertTo-AmeenCanonicalJson $b)) -gt 262144) { return (& $bad "size" "bill snapshot too large") }
        if ((Get-AmeenInvoiceVersionHash $b) -ne $h) { return (& $bad "version_hash" "version_hash does not match bill content") }
    }
    return $null
}

function Move-AmeenEventToDeadLetter {
    # ينقل ملف الحدث إلى deadletter\ ويكتب بجانبه سبباً مختصراً. السبب والسجل بلا محتوى الفاتورة
    # (لا اسم زبون ولا مبالغ): المعرّف والتسلسل وGUID الفاتورة والنوع والرمز واسم الملف فقط.
    # الترتيب: السبب أولاً ثم نقل الملف (rename) — فالملف لا يغيب أبداً قبل أن يُحفظ في العزل،
    # ولا يُكتب فوق ملف معزول سابق بالاسم نفسه.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][string]$File, [AllowNull()]$InvoiceEvent,
          [hashtable]$SafeIds, [Parameter(Mandatory = $true)][string]$Code, [Parameter(Mandatory = $true)][string]$Reason,
          [Parameter(Mandatory = $true)][string]$Source, [datetime]$NowUtc = [datetime]::UtcNow)
    $dl = Join-Path $Dir "deadletter"
    if (-not (Test-Path -LiteralPath $dl)) { New-Item -ItemType Directory -Path $dl -Force | Out-Null }
    $name = [IO.Path]::GetFileNameWithoutExtension($File)
    if ((Test-Path -LiteralPath (Join-Path $dl ($name + ".json"))) -or (Test-Path -LiteralPath (Join-Path $dl ($name + ".reason.json")))) {
        $name = $name + ".dup-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    }
    $safeReason = ($Reason -replace '[\r\n\t]', ' ')
    if ($safeReason.Length -gt 200) { $safeReason = $safeReason.Substring(0, 200) }
    $ids = @{ event_id = ""; source_seq = ""; bill_guid = ""; kind = "" }
    if ($InvoiceEvent -is [System.Collections.IDictionary]) {
        $ids = @{ event_id = [string]$InvoiceEvent.event_id; source_seq = [string]$InvoiceEvent.source_seq; bill_guid = [string]$InvoiceEvent.bill_guid; kind = [string]$InvoiceEvent.kind }
    } elseif ($null -ne $SafeIds) { $ids = $SafeIds }
    $info = [ordered]@{
        event_id = [string]$ids.event_id; source_seq = [string]$ids.source_seq; bill_guid = [string]$ids.bill_guid
        kind = [string]$ids.kind; reason_code = $Code; reason = $safeReason; source = $Source
        file_name = [IO.Path]::GetFileName($File); status = "isolated"
        at = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant)
    }
    Write-AmeenAtomicFile -Path (Join-Path $dl ($name + ".reason.json")) -Content (ConvertTo-AmeenCanonicalJson $info)
    Move-Item -LiteralPath $File -Destination (Join-Path $dl ($name + ".json"))
    Add-Content -LiteralPath (Join-Path $Dir "deadletter.log") -Value ("{0}`t{1}`t{2}`t{3}`t{4}`t{5}`t{6}`t{7}" -f $info.at, $info.source_seq, $info.event_id, $info.bill_guid, $info.kind, $Source, $Code, $info.file_name) -Encoding UTF8
}

function Get-AmeenDeadLetters {
    param([Parameter(Mandatory = $true)][string]$Dir)
    # تُعاد العناصر عبر خط الأنابيب (لا مصفوفة ملفوفة) كي يعمل Where-Object عليها؛ المستدعي يلفّها بـ @().
    $dl = Join-Path $Dir "deadletter"
    $list = New-Object System.Collections.Generic.List[object]
    if (-not (Test-Path -LiteralPath $dl)) { return }
    foreach ($f in @(Get-ChildItem -LiteralPath $dl -Filter "*.reason.json" | Sort-Object Name)) {
        $read = Read-AmeenJsonFileSafe -Path $f.FullName
        if (-not $read.ok -or -not ($read.value -is [System.Collections.IDictionary])) { continue }
        $info = $read.value
        $info.file = Join-Path $dl ($f.Name -replace '\.reason\.json$', '.json')
        $info.reason_file = $f.FullName
        $list.Add($info)
    }
    return $list.ToArray()
}

function Complete-AmeenDeadLetter {
    # ينقل الحدث المعزول وسببه إلى deadletter\resolved\ (للتدقيق) بعد اكتمال إصلاحه فعلاً.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)]$Item, [Parameter(Mandatory = $true)][string]$Mode,
          [string]$Note = "", [datetime]$NowUtc = [datetime]::UtcNow)
    $resolved = Join-Path (Join-Path $Dir "deadletter") "resolved"
    if (-not (Test-Path -LiteralPath $resolved)) { New-Item -ItemType Directory -Path $resolved -Force | Out-Null }
    $stamp = $NowUtc.ToString("yyyyMMddTHHmmssZ", $script:Invariant)
    $base = [IO.Path]::GetFileNameWithoutExtension([string]$Item.file)
    if (Test-Path -LiteralPath $Item.file) { Move-Item -LiteralPath $Item.file -Destination (Join-Path $resolved ("{0}.{1}.{2}.json" -f $base, $Mode.ToLowerInvariant(), $stamp)) -Force }
    if (Test-Path -LiteralPath $Item.reason_file) { Move-Item -LiteralPath $Item.reason_file -Destination (Join-Path $resolved ("{0}.{1}.{2}.reason.json" -f $base, $Mode.ToLowerInvariant(), $stamp)) -Force }
    Add-Content -LiteralPath (Join-Path $Dir "deadletter.log") -Value ("{0}`t{1}`t{2}`t{3}`trepaired`t{4}`t{5}" -f $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant), $Item.source_seq, $Item.event_id, $Item.bill_guid, $Mode, $Note) -Encoding UTF8
}

function Update-AmeenDeadLetterReason {
    param([Parameter(Mandatory = $true)]$Item, [Parameter(Mandatory = $true)][hashtable]$Changes)
    $read = Read-AmeenJsonFileSafe -Path $Item.reason_file
    $info = @{}; if ($read.ok -and $read.value -is [System.Collections.IDictionary]) { $info = $read.value }
    foreach ($k in $Changes.Keys) { $info[$k] = $Changes[$k] }
    $info.Remove("file"); $info.Remove("reason_file")
    Write-AmeenAtomicFile -Path $Item.reason_file -Content (ConvertTo-AmeenCanonicalJson $info)
}

function Repair-AmeenDeadLetter {
    # طريقتان آمنتان لإصلاح حدث معزول دون فقدانه ودون كسر الترتيب:
    #   Resnapshot: يُضاف طلب دائم إلى طابور اللقطات (status = resnapshot_pending في ملف السبب نفسه،
    #               فلا يضيع ولو ضاعت state.json). الوكيل يقرأ الفاتورة مباشرة بالـGUID من الأمين — أيّاً
    #               كان تاريخها، لا ضمن نافذة المطابقة — ويُصدر حدثاً بتسلسل أحدث. الطلب لا يُغلق إلا
    #               بعد كتابة الحدث الجديد في الصندوق (Invoke-AmeenResnapshotQueue).
    #   Requeue:    الحدث نفسه بعد تصحيح ملفه يدوياً: تُعاد البصمة والمفتاح بتسلسله الأصلي، ويُتحقق منه،
    #               ثم يعود إلى pending\ في موضعه. إن سبقه حدث أحدث للفاتورة نفسها فالخادم يعدّه stale.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State,
          [Parameter(Mandatory = $true)][long]$Seq, [ValidateSet("Resnapshot", "Requeue")][string]$Mode = "Resnapshot",
          [datetime]$NowUtc = [datetime]::UtcNow)
    $item = @(Get-AmeenDeadLetters -Dir $Dir | Where-Object { [string]$_.source_seq -eq ([string]$Seq) }) | Select-Object -First 1
    if ($null -eq $item) { throw "dead letter seq $Seq not found" }
    if ($Mode -eq "Resnapshot") {
        if ([string]$item.bill_guid -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            throw "resnapshot refused: bill_guid unknown for this dead letter (fix the file, then use Requeue)"
        }
        if ([string]$item.status -eq "resnapshot_pending") { return "ResnapshotQueued" }
        Update-AmeenDeadLetterReason -Item $item -Changes @{
            status = "resnapshot_pending"; requested_at = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant)
            after_seq = ([long]$State.last_seq).ToString($script:Invariant); attempts = 0; last_error = ""; last_attempt_at = ""
        }
        Add-Content -LiteralPath (Join-Path $Dir "deadletter.log") -Value ("{0}`t{1}`t{2}`t{3}`tresnapshot-queued" -f $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant), $item.source_seq, $item.event_id, $item.bill_guid) -Encoding UTF8
        return "ResnapshotQueued"
    }
    $read = Read-AmeenJsonFileSafe -Path $item.file
    if (-not $read.ok -or -not ($read.value -is [System.Collections.IDictionary])) { throw ("requeue refused: dead letter file is still unreadable (" + $read.error + ")") }
    $evt = $read.value
    if ($evt.kind -eq "upsert" -and $evt.bill -is [System.Collections.IDictionary]) { $evt.version_hash = Get-AmeenInvoiceVersionHash $evt.bill }
    $evt.source_seq = $Seq
    $evt.event_id = Get-AmeenInvoiceEventId -BillGuid ([string]$evt.bill_guid) -Seq $Seq -Kind ([string]$evt.kind) -VersionHash ([string]$evt.version_hash) -SourceEventAt ([string]$evt.source_event_at)
    $why = Test-AmeenInvoiceEvent -InvoiceEvent $evt -NowUtc $NowUtc
    if ($null -ne $why) { throw ("requeue refused (" + $why.code + "): " + $why.reason) }
    $target = Join-Path (Join-Path $Dir "pending") (([long]$Seq).ToString("D12", $script:Invariant) + ".json")
    if (Test-Path -LiteralPath $target) { throw "requeue refused: pending already has seq $Seq" }
    Write-AmeenAtomicFile -Path $target -Content (ConvertTo-AmeenCanonicalJson $evt)
    Complete-AmeenDeadLetter -Dir $Dir -Item $item -Mode "Requeue" -NowUtc $NowUtc
    return "Requeue"
}

function Invoke-AmeenResnapshotQueue {
    # يعالج طلبات Resnapshot الدائمة. Reader: scriptblock يستقبل GUID ويعيد
    #   @{ status = 'found'|'missing'|'error'; observation = <ملاحظة كما في Resolve>; error = <رمز بلا محتوى> }
    # ويقرأ الفاتورة مباشرة بمعرّفها من الأمين (قراءة فقط) بغض النظر عن تاريخها.
    # القواعد:
    #   * الطلب لا يُغلق إلا بعد كتابة حدثه الجديد في pending\ وحفظ الحالة (والحدث تسلسله أحدث من كل سابق).
    #   * found ⇒ upsert بالمحتوى الحالي، missing ⇒ delete (الفاتورة لم تعد موجودة في الأمين).
    #   * error ⇒ الطلب يبقى، attempts++ وسبب مختصر، وإعادة المحاولة بعد MinRetrySeconds.
    #   * لا تكرار: إن كان للطلب حدث مسجَّل (emitted_seq) أو وُجد في pending\ حدث للفاتورة نفسها بتسلسل
    #     بعد الطلب (انقطاع بين الكتابة والإغلاق)، يُغلق الطلب بلا حدث جديد.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State,
          [Parameter(Mandatory = $true)][scriptblock]$Reader, [datetime]$NowUtc = [datetime]::UtcNow, [int]$MinRetrySeconds = 60)
    $summary = @{ emitted = 0; completed = 0; failed = 0; waiting = 0; events = @() }
    $requests = @(Get-AmeenDeadLetters -Dir $Dir | Where-Object { [string]$_.status -eq "resnapshot_pending" -or [string]$_.status -eq "resnapshot_emitted" })
    foreach ($req in $requests) {
        $guid = [string]$req.bill_guid
        $after = [long]0; [void][long]::TryParse([string]$req.after_seq, [ref]$after)
        if ([string]$req.status -eq "resnapshot_emitted" -and $req.emitted_seq) {
            Complete-AmeenDeadLetter -Dir $Dir -Item $req -Mode "Resnapshot" -Note ("new_seq=" + $req.emitted_seq) -NowUtc $NowUtc
            $summary.completed++; continue
        }
        $already = @(Get-AmeenOutboxPending -Dir $Dir -Max 100000 | Where-Object { [string]$_.event.bill_guid -eq $guid -and [long]$_.event.source_seq -gt $after }) | Select-Object -First 1
        if ($null -ne $already) {
            Update-AmeenDeadLetterReason -Item $req -Changes @{ status = "resnapshot_emitted"; emitted_seq = ([long]$already.event.source_seq).ToString($script:Invariant); emitted_event_id = [string]$already.event.event_id }
            Complete-AmeenDeadLetter -Dir $Dir -Item $req -Mode "Resnapshot" -Note ("new_seq=" + $already.event.source_seq) -NowUtc $NowUtc
            $summary.completed++; continue
        }
        if ($req.last_attempt_at) {
            $last = [datetime]::Parse([string]$req.last_attempt_at, $script:Invariant, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
            if (($NowUtc - $last).TotalSeconds -lt $MinRetrySeconds) { $summary.waiting++; continue }
        }
        $res = $null
        try { $res = & $Reader $guid } catch { $res = @{ status = "error"; error = ("reader failed (" + $_.Exception.GetType().Name + ")") } }
        if ($null -eq $res -or @("found", "missing") -notcontains [string]$res.status) {
            $err = "reader error"; if ($null -ne $res -and $res.error) { $err = ([string]$res.error -replace '[\r\n\t]', ' ') }
            if ($err.Length -gt 120) { $err = $err.Substring(0, 120) }
            Update-AmeenDeadLetterReason -Item $req -Changes @{ attempts = ([int]$req.attempts + 1); last_error = $err; last_attempt_at = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant) }
            $summary.failed++; continue
        }
        $obs = $res.observation
        if ($null -eq $obs) { $obs = @{ guid = $guid; snapshot = $null; ops = @(); detected_at_utc = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", $script:Invariant) } }
        if ([string]$res.status -eq "missing") { $obs.snapshot = $null }
        # يُفرض الإصدار: الحالة الحالية في الأمين هي ما يجب أن يصل، ولو طابقت آخر نسخة معروفة محلياً.
        $State.bills[$guid] = @{ v = "resnapshot"; fp = $null; seen = [string]$obs.detected_at_utc }
        $events = Resolve-AmeenInvoiceChanges -State $State -Observations @($obs)
        if ($events.Count -ne 1) {
            Update-AmeenDeadLetterReason -Item $req -Changes @{ attempts = ([int]$req.attempts + 1); last_error = "no event produced"; last_attempt_at = $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant) }
            $summary.failed++; continue
        }
        # ترتيب يحمي من الانقطاع: الحدث في الصندوق ← الحالة ← تسجيل emitted في الطلب ← الإغلاق.
        Add-AmeenOutboxEvents -Dir $Dir -Events $events
        Save-AmeenInvoiceState -Dir $Dir -State $State
        Update-AmeenDeadLetterReason -Item $req -Changes @{ status = "resnapshot_emitted"; emitted_seq = ([long]$events[0].source_seq).ToString($script:Invariant); emitted_event_id = [string]$events[0].event_id }
        Complete-AmeenDeadLetter -Dir $Dir -Item $req -Mode "Resnapshot" -Note ("new_seq=" + $events[0].source_seq) -NowUtc $NowUtc
        $summary.emitted++; $summary.completed++
        $summary.events += $events[0]
    }
    return $summary
}

function Invoke-AmeenRpc {
    # استدعاء RPC عبر PostgREST. عند فشل HTTP يُرمى استثناء برسالة موحّدة فيها الحالة ورمز الخطأ ورسالته من
    # جسم الاستجابة (Codex P1 على 7dbd9915): في Windows PowerShell 5.1 تكون Exception.Message عامة
    # «(400) Bad Request» بينما «events payload too large» في الجسم، فلا يراها منطق تنصيف الدفعة.
    # من الجسم يؤخذ code وmessage فقط (نصوص أخطاء الخادم المعروفة)، بلا details/hint، وبحد 300 حرف.
    param([Parameter(Mandatory = $true)][string]$Url, [Parameter(Mandatory = $true)][hashtable]$Headers,
          [Parameter(Mandatory = $true)][byte[]]$Body, [int]$TimeoutSec = 30)
    try {
        return Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $Body -TimeoutSec $TimeoutSec
    } catch {
        $status = ""
        $resp = $_.Exception.Response
        if ($null -ne $resp) { try { $status = [string][int]$resp.StatusCode } catch { $status = "" } }
        $raw = ""
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $raw = [string]$_.ErrorDetails.Message }
        elseif ($resp -is [System.Net.HttpWebResponse]) {
            try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $raw = $sr.ReadToEnd(); $sr.Dispose() } catch { $raw = "" }
        }
        $pgCode = ""; $pgMsg = ""
        try {
            $j = $raw | ConvertFrom-Json -ErrorAction Stop
            if ($j.code) { $pgCode = [string]$j.code }
            if ($j.message) { $pgMsg = [string]$j.message }
        } catch { $pgMsg = "" }
        if (-not $pgMsg) { $pgMsg = $_.Exception.Message }
        $msg = ("HTTP {0} {1}: {2}" -f $status, $pgCode, ($pgMsg -replace '[\r\n\t]', ' ')).Trim()
        if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
        throw $msg
    }
}

function Send-AmeenInvoiceOutbox {
    # يرسل المعلّق بترتيب التسلسل. Transport: scriptblock يستقبل مصفوفة الأحداث ويعيد مصفوفة
    # @{ event_id; index; outcome; reason_code; reason }.
    #   applied|duplicate|stale|noop ⇒ استُلم ويُزال.   rejected ⇒ يُعزل في deadletter\ وتكمل البقية.
    # الحدث الذي يرفضه التحقق المحلي يُعزل قبل الإرسال ولا يحجز ما بعده.
    # فشل النقل (استثناء، رد ناقص، نتيجة غير معروفة) ⇒ لا يُحذف شيء، ويُؤجَّل الإرسال تراجعياً.
    param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(Mandatory = $true)][hashtable]$State,
          [Parameter(Mandatory = $true)][scriptblock]$Transport, [datetime]$NowUtc = [datetime]::UtcNow, [int]$BatchSize = 50,
          [int]$MaxBatchBytes = $script:AmeenMaxBatchBytes)
    $result = @{ sent = 0; acked = 0; deadlettered = 0; skipped_backoff = $false; error = $null; outcomes = @{}; request_bytes = 0; deferred = 0 }
    if ($State.send.next_at) {
        $next = [datetime]::Parse([string]$State.send.next_at, $script:Invariant, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
        if ($NowUtc -lt $next) { $result.skipped_backoff = $true; return $result }
    }
    $batch = Get-AmeenOutboxBatch -Dir $Dir -Max $BatchSize -NowUtc $NowUtc
    $result.deadlettered += [int]$batch.isolated
    $pending = $batch.items
    if ($pending.Count -eq 0) { return $result }
    $valid = New-Object System.Collections.Generic.List[object]
    foreach ($p in $pending) {
        # أي استثناء غير متوقع أثناء التحقق يعزل الحدث نفسه ولا يُسقط الوكيل أو يحجز ما بعده.
        try { $why = Test-AmeenInvoiceEvent -InvoiceEvent $p.event -NowUtc $NowUtc }
        catch { $why = @{ code = "invalid"; reason = ("event could not be validated (" + $_.Exception.GetType().Name + ")") } }
        if ($null -ne $why) {
            Move-AmeenEventToDeadLetter -Dir $Dir -File $p.file -InvoiceEvent $p.event -Code $why.code -Reason $why.reason -Source "local" -NowUtc $NowUtc
            $result.deadlettered++
            $result.outcomes[[string]$p.event.event_id] = "deadletter"
        } else { $valid.Add($p) }
    }
    if ($valid.Count -eq 0) { return $result }
    # حدّ الطلب بالبايتات لا بالعدد وحده (Codex P1 على da7413e8): الخادم يرفض الطلب كله فوق 4MB، وفاتورة
    # سليمة واحدة قد تبلغ 256KB، فقد تتجاوز 50 فاتورة كبيرة الحدّ فيعيد الوكيل إرسال الدفعة نفسها بلا نهاية.
    # الدفعة = أطول بادئة بترتيب التسلسل لا يتجاوز جسمها MaxBatchBytes (والحدث الأول دائماً، فلا توقف).
    # وإن رفض الخادم الطلب لحجمه رغم ذلك، يُنصَّف سقف العدد في المحاولة التالية حتى حدث واحد.
    $cap = $valid.Count
    if ($State.send.batch_cap) { $cap = [math]::Max(1, [math]::Min($cap, [int]$State.send.batch_cap)) }
    $overhead = [Text.Encoding]::UTF8.GetByteCount('{"p_events":[]}')
    $take = New-Object System.Collections.Generic.List[object]
    $bytes = $overhead
    foreach ($p in $valid) {
        if ($take.Count -ge $cap) { break }
        $size = [Text.Encoding]::UTF8.GetByteCount((ConvertTo-AmeenCanonicalJson $p.event))
        $add = $size; if ($take.Count -gt 0) { $add++ }
        if ($take.Count -gt 0 -and ($bytes + $add) -gt $MaxBatchBytes) { break }
        $take.Add($p); $bytes += $add
    }
    $result.deferred = $valid.Count - $take.Count
    $valid = $take
    $events = @($valid | ForEach-Object { $_.event })
    $result.sent = $events.Count
    $result.request_bytes = $bytes
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
                Move-AmeenEventToDeadLetter -Dir $Dir -File $p.file -InvoiceEvent $p.event -Code $code -Reason $reason -Source "server" -NowUtc $NowUtc
                $result.deadlettered++
            } else {
                Add-Content -LiteralPath $ackLog -Value ("{0}`t{1}`t{2}`t{3}`t{4}" -f $NowUtc.ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant), $p.event.source_seq, $p.event.bill_guid, $p.event.kind, $r.outcome) -Encoding UTF8
                Remove-Item -LiteralPath $p.file -Force
                $result.acked++
            }
            $result.outcomes[$id] = [string]$r.outcome
        }
        $State.send.failures = 0; $State.send.next_at = $null; $State.send.batch_cap = $null
    } catch {
        if ($_.Exception.Message -match '(?i)payload too large|too many events|request entity too large|\b413\b') {
            $State.send.batch_cap = [math]::Max(1, [int][math]::Floor($events.Count / 2))
        }
        $State.send.failures = [int]$State.send.failures + 1
        $State.send.next_at = $NowUtc.AddSeconds((Get-AmeenBackoffSeconds $State.send.failures)).ToString("yyyy-MM-ddTHH:mm:ssZ", $script:Invariant)
        $result.error = $_.Exception.Message
    }
    return $result
}
