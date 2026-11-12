# أرشيف إيصالات الكاشير الثابت (OZK Receipt Archive)
#
# لكل إيصال يُرسَل إلى طابعة الكاشير نسخة ثابتة لا تُعدَّل، تُكتب **قبل** التسليم:
#   receipts\<yyyy-MM>\<invoiceGuid>\<printId>.json   ← محتوى الإيصال بصيغة JSON قانونية (ASCII)
#   events-<yyyy-MM>.jsonl                             ← سجل مراحل متسلسل بسلسلة بصمات SHA-256
#
# المفتاح دائماً GUID الفاتورة لا رقمها: الأمين يعيد استخدام الرقم بعد حذف الفاتورة.
#
# مراحل السجل (لا يُستنتج أحدها من غيره):
#   prepared             الإيصال جُهِّز وحُفظ في الأرشيف، ولم يُسلَّم بعد
#   submitted            أعاد Windows رقم مهمة طباعة (StartDocPrinter) وكُتبت البايتات
#   submit_failed_no_job فشل مثبت قبل إنشاء أي مهمة: الورق يقيناً لم يخرج
#   submit_uncertain     فشل بعد بدء المهمة أو مجهول: لا يُعرف إن خرج الورق
#   windows_completed    دليل من Windows أن المهمة غادرت الطابور بلا خطأ — ليس دليلاً ورقياً
#   windows_error        دليل من Windows على خطأ في المهمة
#   paper_confirmed      خروج الورق مؤكد بدليل مستقل صريح (إنسان أو حسّاس) — لا يُكتب آلياً أبداً
#
# الوحدة لا تتصل بالأمين ولا بالطابعة ولا تستورد System.Drawing.

$script:ArchiveSchema = 1
$script:Invariant = [Globalization.CultureInfo]::InvariantCulture
$script:ArchiveStages = @(
    "prepared", "submitted", "submit_failed_no_job", "submit_uncertain",
    "windows_completed", "windows_error", "paper_confirmed"
)
$script:LockTimeoutMilliseconds = 10000

function Get-OzkReceiptArchiveDefaultRoot {
    return (Join-Path ([Environment]::GetFolderPath("CommonApplicationData")) "OZK-TOBACCO\ReceiptArchive")
}

# ── JSON قانوني ثابت البايتات ─────────────────────────────────────────────────
# مفاتيح مرتبة ترتيباً ترتيبياً (ordinal)، أرقام G17 (تعاد قراءتها إلى نفس الـdouble
# بالضبط على .NET Framework و.NET Core)، نص غير ASCII يُكتب \uXXXX. فالملف ASCII
# خالص وبصمته لا تتغيّر بتغيّر الترميز أو نسخة PowerShell.
function ConvertTo-OzkCanonicalJsonString([string]$Text) {
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq '"') { [void]$builder.Append('\"') }
        elseif ($ch -eq '\') { [void]$builder.Append('\\') }
        elseif ($code -lt 0x20 -or $code -gt 0x7e) { [void]$builder.Append(('\u{0:x4}' -f $code)) }
        else { [void]$builder.Append($ch) }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-OzkCanonicalNumber($Value) {
    $double = [double]$Value
    if ([double]::IsNaN($double) -or [double]::IsInfinity($double)) { throw "Canonical JSON refuses NaN/Infinity." }
    if ($double -eq [math]::Floor($double) -and [math]::Abs($double) -lt 1e15) {
        return ([int64]$double).ToString($script:Invariant)
    }
    return $double.ToString("G17", $script:Invariant)
}

function ConvertTo-OzkCanonicalJson($Value) {
    if ($null -eq $Value) { return "null" }
    if ($Value -is [bool]) { if ($Value) { return "true" } else { return "false" } }
    if ($Value -is [string]) { return (ConvertTo-OzkCanonicalJsonString $Value) }
    if ($Value -is [char]) { return (ConvertTo-OzkCanonicalJsonString ([string]$Value)) }
    if ($Value -is [guid]) { return (ConvertTo-OzkCanonicalJsonString $Value.ToString().ToLowerInvariant()) }
    if ($Value -is [datetime]) { return (ConvertTo-OzkCanonicalJsonString $Value.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ", $script:Invariant)) }
    if ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or
        $Value -is [uint16] -or $Value -is [uint32] -or $Value -is [uint64] -or $Value -is [sbyte]) {
        return ([int64]$Value).ToString($script:Invariant)
    }
    if ($Value -is [double] -or $Value -is [single] -or $Value -is [decimal]) { return (ConvertTo-OzkCanonicalNumber $Value) }
    if ($Value -is [Collections.IDictionary]) {
        $keys = @($Value.Keys | ForEach-Object { [string]$_ })
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        $parts = foreach ($key in $keys) { (ConvertTo-OzkCanonicalJsonString $key) + ":" + (ConvertTo-OzkCanonicalJson $Value[$key]) }
        return "{" + (@($parts) -join ",") + "}"
    }
    if ($Value -is [Management.Automation.PSCustomObject]) {
        $map = @{}
        foreach ($property in $Value.PSObject.Properties) { $map[$property.Name] = $property.Value }
        return (ConvertTo-OzkCanonicalJson $map)
    }
    if ($Value -is [Collections.IEnumerable]) {
        $items = foreach ($item in $Value) { ConvertTo-OzkCanonicalJson $item }
        return "[" + (@($items) -join ",") + "]"
    }
    throw "Canonical JSON: unsupported type $($Value.GetType().FullName)."
}

function Get-OzkSha256Hex([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (-join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") })) } finally { $sha.Dispose() }
}

function Get-OzkTextSha256([string]$Text) {
    return (Get-OzkSha256Hex ([Text.Encoding]::ASCII.GetBytes($Text)))
}

function ConvertTo-OzkUtcText($Value) {
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString("o", $script:Invariant) }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $parsed = [datetime]::Parse($text, $script:Invariant, [Globalization.DateTimeStyles]::RoundtripKind)
    return $parsed.ToUniversalTime().ToString("o", $script:Invariant)
}

function ConvertTo-OzkNullableDouble($Value) {
    if ($null -eq $Value -or $Value -is [DBNull]) { return $null }
    return [double]$Value
}

# ── التحويل الموحد إلى أرقام الإيصال ──────────────────────────────────────────
# نفس منطق Convert-SnapshotToReceipt في الجسر حرفياً: الكمية بالوحدة المختارة
# (Qty ÷ Unit2Fact/Unit3Fact)، والمبلغ بعملة الفاتورة (القيمة ÷ CurrencyVal).
# يُستعمل لمقارنة الأرشيف بالأمين من مصدر خام واحد، بلا اعتماد على الرسم.
function ConvertTo-OzkInvoiceAmount($Value, $CurrencyValue) {
    if ($null -eq $Value) { return 0.0 }
    $rate = 0.0
    if ($null -ne $CurrencyValue) { $rate = [double]$CurrencyValue }
    if ($rate -gt 0) { return ([double]$Value / $rate) }
    return [double]$Value
}

function ConvertTo-OzkSelectedQuantity($Qty, $SelectedUnit, $Unit2Factor, $Unit3Factor) {
    $quantity = 0.0
    if ($null -ne $Qty) { $quantity = [double]$Qty }
    $unit = 1
    if ($null -ne $SelectedUnit) { $unit = [int][double]$SelectedUnit }
    if ($unit -eq 2) {
        if ($null -eq $Unit2Factor -or [double]$Unit2Factor -le 0) { return $null }
        return ($quantity / [double]$Unit2Factor)
    }
    if ($unit -eq 3) {
        if ($null -eq $Unit3Factor -or [double]$Unit3Factor -le 0) { return $null }
        return ($quantity / [double]$Unit3Factor)
    }
    return $quantity
}

# مقارِن مستقل عن الرسم: لكل مادة (GUID) مجموع الكمية بالوحدة المختارة ومجموعة
# أسعار الوحدة بعملة الفاتورة (مقرّبة لخانتين كما تُطبع)، ثم الخصم والإضافة والصافي.
function New-OzkInvoiceComparable {
    param(
        $CurrencyValue,
        [string]$CurrencyIso = "",
        $Total,
        $TotalDiscount,
        $TotalExtra,
        [object[]]$Lines = @()
    )
    $items = @{}
    foreach ($line in @($Lines)) {
        if ($null -eq $line) { continue }
        $itemGuid = ([string]$line.itemGuid).ToLowerInvariant()
        if (-not $items.ContainsKey($itemGuid)) {
            $items[$itemGuid] = [ordered]@{ name = [string]$line.itemName; quantity = 0.0; unitPrices = @() }
        }
        $quantity = ConvertTo-OzkSelectedQuantity $line.qty $line.selectedUnit $line.unit2Factor $line.unit3Factor
        if ($null -eq $quantity) { $quantity = [double]$line.qty }
        $items[$itemGuid].quantity = [math]::Round([double]$items[$itemGuid].quantity + $quantity, 6)
        $price = [math]::Round((ConvertTo-OzkInvoiceAmount $line.rawPrice $CurrencyValue), 2)
        if (@($items[$itemGuid].unitPrices) -notcontains $price) { $items[$itemGuid].unitPrices = @($items[$itemGuid].unitPrices) + $price }
    }
    foreach ($key in @($items.Keys)) { $items[$key].unitPrices = @($items[$key].unitPrices | Sort-Object) }
    $gross = ConvertTo-OzkInvoiceAmount $Total $CurrencyValue
    $discount = ConvertTo-OzkInvoiceAmount $TotalDiscount $CurrencyValue
    $extra = ConvertTo-OzkInvoiceAmount $TotalExtra $CurrencyValue
    $rate = $null
    if ($null -ne $CurrencyValue -and [double]$CurrencyValue -gt 0) { $rate = [math]::Round(1.0 / [double]$CurrencyValue, 4) }
    return [ordered]@{
        currencyIso = $CurrencyIso
        ratePerBase = $rate
        items = $items
        gross = [math]::Round($gross, 2)
        discount = [math]::Round($discount, 2)
        extra = [math]::Round($extra, 2)
        net = [math]::Round($gross - $discount + $extra, 2)
        lineCount = @($Lines | Where-Object { $null -ne $_ }).Count
    }
}

# التغيّرات الظاهرة على الإيصال بين نسختين. لا يُعدّ تغيّراً ما لا يظهر مطبوعاً
# (مثلاً سعر خام بالدولار تغيّر مع سعر الصرف بحيث بقي المبلغ المطبوع نفسه).
function Compare-OzkInvoiceComparable($Printed, $Current) {
    $changes = New-Object System.Collections.Generic.List[object]
    $printedKeys = @($Printed.items.Keys)
    $currentKeys = @($Current.items.Keys)
    foreach ($key in $currentKeys) {
        if ($printedKeys -notcontains $key) {
            $changes.Add([ordered]@{ kind = "item_added"; item = [string]$Current.items[$key].name; quantity = $Current.items[$key].quantity })
        }
    }
    foreach ($key in $printedKeys) {
        if ($currentKeys -notcontains $key) {
            $changes.Add([ordered]@{ kind = "item_removed"; item = [string]$Printed.items[$key].name; quantity = $Printed.items[$key].quantity })
            continue
        }
        $before = $Printed.items[$key]; $after = $Current.items[$key]
        if ([math]::Abs([double]$before.quantity - [double]$after.quantity) -gt 1e-6) {
            $changes.Add([ordered]@{ kind = "quantity"; item = [string]$after.name; from = $before.quantity; to = $after.quantity })
        }
        $beforePrices = (@($before.unitPrices) | ForEach-Object { ConvertTo-OzkCanonicalNumber $_ }) -join ","
        $afterPrices = (@($after.unitPrices) | ForEach-Object { ConvertTo-OzkCanonicalNumber $_ }) -join ","
        if ($beforePrices -ne $afterPrices) {
            $changes.Add([ordered]@{ kind = "unit_price"; item = [string]$after.name; from = @($before.unitPrices); to = @($after.unitPrices) })
        }
    }
    if ([math]::Abs([double]$Printed.discount - [double]$Current.discount) -ge 0.01) {
        $changes.Add([ordered]@{ kind = "discount"; from = $Printed.discount; to = $Current.discount })
    }
    if ([math]::Abs([double]$Printed.extra - [double]$Current.extra) -ge 0.01) {
        $changes.Add([ordered]@{ kind = "extra"; from = $Printed.extra; to = $Current.extra })
    }
    if ($null -ne $Printed.ratePerBase -and $null -ne $Current.ratePerBase -and
        [math]::Abs([double]$Printed.ratePerBase - [double]$Current.ratePerBase) -ge 0.5) {
        $changes.Add([ordered]@{ kind = "exchange_rate"; from = $Printed.ratePerBase; to = $Current.ratePerBase })
    }
    if ([math]::Abs([double]$Printed.net - [double]$Current.net) -ge 0.01) {
        $changes.Add([ordered]@{ kind = "net"; from = $Printed.net; to = $Current.net; delta = [math]::Round([double]$Current.net - [double]$Printed.net, 2) })
    }
    return $changes.ToArray()
}

# ── بناء محتوى الإيصال المؤرشف ───────────────────────────────────────────────
# Header/Lines: لقطة الجسر الخام من الأمين (نفس كائنات Get-InvoiceSnapshot).
# Receipt: ما سيُرسم ويُطبع (Convert-SnapshotToReceipt). Balance: الرصيد المطبوع.
function New-OzkReceiptArchiveContent {
    param(
        [Parameter(Mandatory = $true)][string]$PrintId,
        [Parameter(Mandatory = $true)][ValidateSet("auto", "manual")][string]$Source,
        [Parameter(Mandatory = $true)]$Header,
        [Parameter(Mandatory = $true)][object[]]$Lines,
        [Parameter(Mandatory = $true)]$Receipt,
        [string]$PrinterName = "",
        [string]$SnapshotSignature = "",
        [byte[]]$Payload = $null,
        [string]$RendererSha256 = "",
        [string]$BridgeSha256 = "",
        [datetime]$PreparedAtUtc = [datetime]::UtcNow
    )
    if ([string]::IsNullOrWhiteSpace([string]$Header.InvoiceGuid)) { throw "Archive refuses a receipt without an invoice GUID." }
    $parsedGuid = [guid]::Empty
    if (-not [guid]::TryParse([string]$Header.InvoiceGuid, [ref]$parsedGuid)) { throw "Archive refuses an invalid invoice GUID." }
    $receiptLines = @($Receipt.Lines)
    $archivedLines = New-Object System.Collections.Generic.List[object]
    $index = 0
    foreach ($line in @($Lines)) {
        $printedLine = $null
        if ($index -lt $receiptLines.Count) { $printedLine = $receiptLines[$index] }
        $archivedLines.Add([ordered]@{
            lineGuid = ([string]$line.LineGuid).ToLowerInvariant()
            lineNumber = $line.LineNumber
            itemGuid = ([string]$line.ItemGuid).ToLowerInvariant()
            itemNumber = [string]$line.ItemNumber
            itemName = [string]$line.ItemName
            qty = ConvertTo-OzkNullableDouble $line.Qty
            selectedUnit = ConvertTo-OzkNullableDouble $line.SelectedUnit
            unit2Factor = ConvertTo-OzkNullableDouble $line.Unit2Factor
            unit3Factor = ConvertTo-OzkNullableDouble $(if ($line.PSObject.Properties["Unit3Factor"]) { $line.Unit3Factor } else { $null })
            rawPrice = ConvertTo-OzkNullableDouble $line.RawPrice
            lineDiscount = ConvertTo-OzkNullableDouble $line.LineDiscount
            bonusDiscount = ConvertTo-OzkNullableDouble $line.BonusDiscount
            lineExtra = ConvertTo-OzkNullableDouble $line.LineExtra
            printedQuantity = $(if ($null -ne $printedLine) { [double]$printedLine.Quantity } else { $null })
            printedUnitPrice = $(if ($null -ne $printedLine) { [double]$printedLine.UnitPrice } else { $null })
            printedTotal = $(if ($null -ne $printedLine) { [double]$printedLine.Total } else { $null })
        })
        $index++
    }
    $lastUpdate = $null
    if ($Header.PSObject.Properties["LastUpdateDate"]) { $lastUpdate = ConvertTo-OzkUtcText $Header.LastUpdateDate }
    $rate = $null
    if ($null -ne $Header.CurrencyValue -and [double]$Header.CurrencyValue -gt 0) { $rate = 1.0 / [double]$Header.CurrencyValue }
    $payloadSha = $null
    if ($null -ne $Payload) { $payloadSha = Get-OzkSha256Hex $Payload }
    $extra = $null
    if ($Receipt.PSObject.Properties["TotalExtra"]) { $extra = [double]$Receipt.TotalExtra }
    return [ordered]@{
        schema = $script:ArchiveSchema
        printId = $PrintId.ToLowerInvariant()
        source = $Source
        preparedAtUtc = $PreparedAtUtc.ToUniversalTime().ToString("o", $script:Invariant)
        machine = [string]$env:COMPUTERNAME
        printer = $PrinterName
        bridgeSha256 = $BridgeSha256
        rendererSha256 = $RendererSha256
        snapshotSignature = $SnapshotSignature
        payloadSha256 = $payloadSha
        invoice = [ordered]@{
            guid = $parsedGuid.ToString().ToLowerInvariant()
            number = [int]$Header.InvoiceNumber
            typeGuid = ([string]$Header.TypeGuid).ToLowerInvariant()
            invoiceDate = [string]$Header.InvoiceDate
            createDate = [string]$Header.CreateDate
            lastUpdateDate = $lastUpdate
            # اسم الزبون يبقى في الأرشيف المحلي لأنه مطبوع فعلاً؛ لا يخرج أبداً في التنبيهات.
            customerName = [string]$Header.CustomerName
            currencyIso = [string]$Header.CurrencyIso
            currencyValue = ConvertTo-OzkNullableDouble $Header.CurrencyValue
            ratePerBase = $rate
            total = ConvertTo-OzkNullableDouble $Header.InvoiceTotal
            totalDiscount = ConvertTo-OzkNullableDouble $Header.TotalDiscount
            totalExtra = ConvertTo-OzkNullableDouble $Header.TotalExtra
            firstPayment = ConvertTo-OzkNullableDouble $Header.FirstPayment
        }
        lines = $archivedLines.ToArray()
        printed = [ordered]@{
            invoiceNumber = $(if ($Receipt.PSObject.Properties["InvoiceNumber"]) { [int]$Receipt.InvoiceNumber } else { [int]$Header.InvoiceNumber })
            gross = [double]$Receipt.GrossTotal
            discount = [double]$Receipt.Discount
            extra = $extra
            net = [double]$Receipt.NetTotal
            payment = [double]$Receipt.Payment
            balanceFound = [bool]$Receipt.BalanceFound
            previousBalance = $(if ([bool]$Receipt.BalanceFound) { [double]$Receipt.PreviousBalance } else { $null })
            currentBalance = $(if ([bool]$Receipt.BalanceFound) { [double]$Receipt.CurrentBalance } else { $null })
            itemCount = [int]$Receipt.ItemCount
            totalQuantity = [double]$Receipt.TotalQuantity
            currencyIso = [string]$Receipt.CurrencyIso
        }
    }
}

function Get-OzkArchivedComparable($Content) {
    $lines = foreach ($line in @($Content.lines)) {
        [pscustomobject]@{
            itemGuid = $line.itemGuid; itemName = $line.itemName; qty = $line.qty
            selectedUnit = $line.selectedUnit; unit2Factor = $line.unit2Factor; unit3Factor = $line.unit3Factor; rawPrice = $line.rawPrice
        }
    }
    return (New-OzkInvoiceComparable -CurrencyValue $Content.invoice.currencyValue -CurrencyIso $Content.invoice.currencyIso `
        -Total $Content.invoice.total -TotalDiscount $Content.invoice.totalDiscount -TotalExtra $Content.invoice.totalExtra -Lines @($lines))
}

# ── صلاحيات الأرشيف (Windows فقط؛ خطوة تثبيت لا يستدعيها الجسر تلقائياً) ─────────
# الكاتب (حساب الجسر) يستطيع: إنشاء ملفات ومجلدات جديدة، والإلحاق بالملفات، والقراءة.
# لا يستطيع: الكتابة فوق محتوى قائم، ولا حذف أو إعادة تسمية أي ملف. القرّاء (Users، ومنهم
# حساب خدمة إعادة الطباعة): قراءة فقط. locks\ وwatch\ وحدهما قابلان للتعديل للكاتب.
# حدود الحماية: SYSTEM والمدراء بصلاحية مرفوعة (elevated) يستطيعون كل شيء، ومالك الملف يملك
# WRITE_DAC ضمنياً فيستطيع تغيير الـACL عمداً. سلسلة البصمات تكشف التعديل الجزئي، أما إعادة
# كتابة السلسلة كاملة بيد مدير فلا يكشفها إلا مرساة خارجية (بصمة رأس السلسلة خارج الجهاز).
function Set-OzkReceiptArchiveAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$WriterAccount,
        [string]$ReaderSid = "S-1-5-32-545"
    )
    Initialize-OzkReceiptArchive $Root
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $Root "watch"))
    $R = [Security.AccessControl.FileSystemRights]
    $I = [Security.AccessControl.InheritanceFlags]
    $P = [Security.AccessControl.PropagationFlags]
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $writer = (New-Object Security.Principal.NTAccount($WriterAccount)).Translate([Security.Principal.SecurityIdentifier])
    $system = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
    $admins = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
    $readers = New-Object Security.Principal.SecurityIdentifier($ReaderSid)
    $both = $I::ContainerInherit -bor $I::ObjectInherit

    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, $R::FullControl, $both, $P::None, $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($admins, $R::FullControl, $both, $P::None, $allow)))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($readers, $R::ReadAndExecute, $both, $P::None, $allow)))
    # المجلدات: قراءة + إنشاء ملف + إنشاء مجلد (CreateFiles/CreateDirectories)، بلا حذف.
    $folderRights = $R::ReadAndExecute -bor $R::CreateFiles -bor $R::CreateDirectories
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($writer, $folderRights, $I::ContainerInherit, $P::None, $allow)))
    # الملفات: قراءة + إلحاق فقط. لا WriteData (كتابة فوق)، لا Delete، لا WriteAttributes.
    $fileRights = $R::Read -bor $R::AppendData -bor $R::Synchronize
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($writer, $fileRights, $I::ObjectInherit, $P::InheritOnly, $allow)))
    Set-Acl -LiteralPath $Root -AclObject $acl

    foreach ($name in @("locks", "watch")) {
        $path = Join-Path $Root $name
        $sub = Get-Acl -LiteralPath $path
        $sub.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($writer, $R::Modify, $both, $P::None, $allow)))
        Set-Acl -LiteralPath $path -AclObject $sub
    }
}

# تقرير مقروء عن صلاحيات الأرشيف الفعلية — للمراجعة والاختبار، بلا تعديل.
function Get-OzkReceiptArchiveAclReport([string]$Root) {
    $acl = Get-Acl -LiteralPath $Root
    return [pscustomobject]@{
        Protected = $acl.AreAccessRulesProtected
        Rules = @($acl.Access | ForEach-Object {
            [pscustomobject]@{
                Sid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
                Rights = [string]$_.FileSystemRights; RightsValue = [int64]$_.FileSystemRights; Inheritance = [string]$_.InheritanceFlags; Propagation = [string]$_.PropagationFlags
                Type = [string]$_.AccessControlType; Inherited = $_.IsInherited
            }
        })
    }
}

# ── تخزين وقفل وسلسلة ────────────────────────────────────────────────────────
function Initialize-OzkReceiptArchive([string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Root)) { throw "Archive root is required." }
    [void](New-Item -ItemType Directory -Force -Path $Root)
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $Root "receipts"))
    [void](New-Item -ItemType Directory -Force -Path (Join-Path $Root "locks"))
}

# ملف جديد يُفتح بحق الإلحاق وحده حيث يتاح (.NET Framework = Windows PowerShell 5.1): يعمل
# تحت ACL الإلحاق فقط (Set-OzkReceiptArchiveAcl) الذي يمنع الكتابة فوق أي ملف أو حذفه.
# لا ملف مؤقت ولا إعادة تسمية: الإعادة تحتاج حق حذف. كتابة جزئية عند انقطاع مفاجئ تُكشف
# بالبصمة، ولا تُعدّ النسخة مؤرشفة إلا بسطر prepared الذي يُكتب بعدها.
function Open-OzkAppendOnlyStream([string]$Path, [IO.FileMode]$Mode) {
    $rights = [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Synchronize
    $ctor = [IO.FileStream].GetConstructor(@([string], [IO.FileMode], [Security.AccessControl.FileSystemRights], [IO.FileShare], [int], [IO.FileOptions]))
    if ($null -ne $ctor) {
        return $ctor.Invoke(@($Path, $Mode, $rights, [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough))
    }
    return [IO.File]::Open($Path, $Mode, [IO.FileAccess]::Write, [IO.FileShare]::Read)
}

function Enter-OzkReceiptArchiveLock([string]$Root) {
    $path = Join-Path (Join-Path $Root "locks") "archive.lock"
    $deadline = [datetime]::UtcNow.AddMilliseconds($script:LockTimeoutMilliseconds)
    while ($true) {
        try {
            return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        } catch [IO.IOException] {
            if ([datetime]::UtcNow -ge $deadline) { throw "Receipt archive is locked by another writer (timeout)." }
            Start-Sleep -Milliseconds 25
        }
    }
}

function Get-OzkReceiptArchiveEventFiles([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Filter "events-*.jsonl" -File | Sort-Object Name)
}

function Read-OzkLastNonEmptyLine([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $length = $stream.Length
        if ($length -eq 0) { return $null }
        $window = [int][math]::Min($length, 262144)
        [void]$stream.Seek(-$window, [IO.SeekOrigin]::End)
        $buffer = New-Object byte[] $window
        $read = 0
        while ($read -lt $window) { $n = $stream.Read($buffer, $read, $window - $read); if ($n -le 0) { break }; $read += $n }
        $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $read)
        $lines = @($text -split "`n" | Where-Object { $_.Trim().Length -gt 0 })
        if ($lines.Count -eq 0) { return $null }
        return $lines[$lines.Count - 1].TrimEnd("`r")
    } finally {
        $stream.Dispose()
    }
}

function Get-OzkReceiptArchiveChainHead([string]$Root) {
    $files = @(Get-OzkReceiptArchiveEventFiles $Root)
    for ($i = $files.Count - 1; $i -ge 0; $i--) {
        $last = Read-OzkLastNonEmptyLine $files[$i].FullName
        if ($null -ne $last) { return (Get-OzkTextSha256 $last) }
    }
    return ("0" * 64)
}

function Add-OzkReceiptArchiveEventUnlocked([string]$Root, $Event, [datetime]$NowUtc) {
    $record = [ordered]@{}
    foreach ($key in $Event.Keys) { $record[$key] = $Event[$key] }
    $record["schema"] = $script:ArchiveSchema
    $record["at"] = $NowUtc.ToUniversalTime().ToString("o", $script:Invariant)
    $record["prev"] = Get-OzkReceiptArchiveChainHead $Root
    $line = ConvertTo-OzkCanonicalJson $record
    $path = Join-Path $Root ("events-{0}.jsonl" -f $NowUtc.ToUniversalTime().ToString("yyyy-MM", $script:Invariant))
    $bytes = [Text.Encoding]::ASCII.GetBytes($line + "`n")
    $stream = Open-OzkAppendOnlyStream $path ([IO.FileMode]::Append)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    return [pscustomobject]@{ Line = $line; Sha256 = (Get-OzkTextSha256 $line); Path = $path }
}

function Assert-OzkReceiptArchiveStage([string]$Stage, $Evidence) {
    if ($script:ArchiveStages -notcontains $Stage) { throw "Unknown receipt archive stage '$Stage'." }
    if ($Stage -eq "paper_confirmed" -and [string]::IsNullOrWhiteSpace([string]$Evidence)) {
        throw "paper_confirmed requires explicit independent evidence; Windows spooler success is not paper evidence."
    }
}

# يحفظ نسخة الإيصال الثابتة (لا تُستبدل أبداً) ثم يسجّل مرحلة prepared — كلاهما
# تحت القفل نفسه. أي فشل يرمي استثناءً قبل أي طباعة، فالمستدعي يمتنع عن التسليم.
function Save-OzkArchivedReceipt {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)]$Content,
        [datetime]$NowUtc = [datetime]::UtcNow
    )
    Initialize-OzkReceiptArchive $Root
    $json = ConvertTo-OzkCanonicalJson $Content
    $contentSha = Get-OzkTextSha256 $json
    $month = ([datetime]::Parse([string]$Content.preparedAtUtc, $script:Invariant, [Globalization.DateTimeStyles]::RoundtripKind)).ToUniversalTime().ToString("yyyy-MM", $script:Invariant)
    $directory = Join-Path (Join-Path (Join-Path $Root "receipts") $month) ([string]$Content.invoice.guid)
    [void](New-Item -ItemType Directory -Force -Path $directory)
    $finalPath = Join-Path $directory (([string]$Content.printId) + ".json")
    $lock = Enter-OzkReceiptArchiveLock $Root
    try {
        if (Test-Path -LiteralPath $finalPath) { throw "Archived receipt already exists for printId $($Content.printId); refusing to overwrite." }
        $bytes = [Text.Encoding]::ASCII.GetBytes($json)
        $stream = Open-OzkAppendOnlyStream $finalPath ([IO.FileMode]::CreateNew)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        $event = Add-OzkReceiptArchiveEventUnlocked $Root ([ordered]@{
            stage = "prepared"
            printId = [string]$Content.printId
            invoiceGuid = [string]$Content.invoice.guid
            invoiceNumber = [int]$Content.invoice.number
            invoiceDate = [string]$Content.invoice.invoiceDate
            source = [string]$Content.source
            contentSha256 = $contentSha
            payloadSha256 = $Content.payloadSha256
            receiptPath = $finalPath.Substring($Root.Length).TrimStart('\', '/')
            printedNet = $Content.printed.net
        }) $NowUtc
        return [pscustomobject]@{ PrintId = [string]$Content.printId; ContentSha256 = $contentSha; Path = $finalPath; EventSha256 = $event.Sha256 }
    } finally {
        $lock.Dispose()
    }
}

function Add-OzkReceiptArchiveEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$PrintId,
        [Parameter(Mandatory = $true)][string]$Stage,
        [string]$InvoiceGuid = "",
        [int]$InvoiceNumber = 0,
        $JobId = $null,
        [string]$Evidence = "",
        [string]$Detail = "",
        [datetime]$NowUtc = [datetime]::UtcNow
    )
    Assert-OzkReceiptArchiveStage $Stage $Evidence
    Initialize-OzkReceiptArchive $Root
    $event = [ordered]@{ stage = $Stage; printId = $PrintId.ToLowerInvariant(); invoiceGuid = $InvoiceGuid.ToLowerInvariant(); invoiceNumber = $InvoiceNumber }
    if ($null -ne $JobId) { $event["jobId"] = [int64]$JobId }
    if ($Evidence) { $event["evidence"] = $Evidence }
    if ($Detail) { $event["detail"] = $Detail }
    $lock = Enter-OzkReceiptArchiveLock $Root
    try { return (Add-OzkReceiptArchiveEventUnlocked $Root $event $NowUtc) } finally { $lock.Dispose() }
}

function Get-OzkReceiptArchiveEvents([string]$Root) {
    $events = New-Object System.Collections.Generic.List[object]
    foreach ($file in @(Get-OzkReceiptArchiveEventFiles $Root)) {
        foreach ($line in [IO.File]::ReadAllLines($file.FullName, [Text.Encoding]::ASCII)) {
            if ($line.Trim().Length -eq 0) { continue }
            $parsed = $line | ConvertFrom-Json
            $parsed | Add-Member -NotePropertyName "_line" -NotePropertyValue $line -Force
            $events.Add($parsed)
        }
    }
    return $events.ToArray()
}

# ملخص لكل طباعة: آخر مرحلة معروفة من كل نوع، بلا استنتاج مرحلة من أخرى.
function Get-OzkReceiptPrintSummaries([string]$Root) {
    $byId = [ordered]@{}
    foreach ($event in @(Get-OzkReceiptArchiveEvents $Root)) {
        $id = [string]$event.printId
        if (-not $byId.Contains($id)) {
            $byId[$id] = [ordered]@{ printId = $id; invoiceGuid = $null; invoiceNumber = $null; invoiceDate = $null; source = $null
                preparedAtUtc = $null; contentSha256 = $null; receiptPath = $null; printedNet = $null; jobId = $null; stages = @() }
        }
        $entry = $byId[$id]
        if ($event.stage -eq "prepared") {
            $entry.invoiceGuid = [string]$event.invoiceGuid; $entry.invoiceNumber = [int]$event.invoiceNumber
            $entry.invoiceDate = [string]$event.invoiceDate; $entry.source = [string]$event.source
            $entry.preparedAtUtc = ConvertTo-OzkUtcText $event.at; $entry.contentSha256 = [string]$event.contentSha256
            $entry.receiptPath = [string]$event.receiptPath; $entry.printedNet = $event.printedNet
        }
        if ($event.PSObject.Properties["jobId"] -and $null -ne $event.jobId) { $entry.jobId = [int64]$event.jobId }
        if (@($entry.stages) -notcontains [string]$event.stage) { $entry.stages = @($entry.stages) + [string]$event.stage }
    }
    return @($byId.Values | ForEach-Object { [pscustomobject]$_ })
}

# هل وصل الإيصال إلى Windows فعلاً؟ (submitted أو أبعد). prepared وحده = لم يُطبع.
function Test-OzkReceiptReachedSpooler($Summary) {
    $stages = @($Summary.stages)
    return ($stages -contains "submitted" -or $stages -contains "submit_uncertain" -or $stages -contains "windows_completed" -or $stages -contains "windows_error" -or $stages -contains "paper_confirmed")
}

function Get-OzkArchivedReceiptContent([string]$Root, $Summary) {
    if ([string]::IsNullOrWhiteSpace([string]$Summary.receiptPath)) { throw "Archived receipt path is missing for printId $($Summary.printId)." }
    $path = Join-Path $Root ([string]$Summary.receiptPath)
    $bytes = [IO.File]::ReadAllBytes($path)
    $sha = Get-OzkSha256Hex $bytes
    if ($sha -ne [string]$Summary.contentSha256) { throw "Archived receipt $($Summary.printId) failed its SHA-256 check (tampered or corrupt)." }
    return ([Text.Encoding]::ASCII.GetString($bytes) | ConvertFrom-Json)
}

# فحص السلامة: كل سطر يحمل بصمة سابقه، وكل نسخة إيصال تطابق بصمة prepared.
function Test-OzkReceiptArchiveIntegrity([string]$Root) {
    $problems = New-Object System.Collections.Generic.List[string]
    $previous = ("0" * 64)
    $count = 0
    foreach ($file in @(Get-OzkReceiptArchiveEventFiles $Root)) {
        $lineNumber = 0
        foreach ($line in [IO.File]::ReadAllLines($file.FullName, [Text.Encoding]::ASCII)) {
            $lineNumber++
            if ($line.Trim().Length -eq 0) { continue }
            $count++
            $parsed = $null
            try { $parsed = $line | ConvertFrom-Json } catch { $problems.Add("$($file.Name):$lineNumber unreadable"); $previous = Get-OzkTextSha256 $line; continue }
            if ([string]$parsed.prev -ne $previous) { $problems.Add("$($file.Name):$lineNumber chain broken") }
            $previous = Get-OzkTextSha256 $line
        }
    }
    foreach ($summary in @(Get-OzkReceiptPrintSummaries $Root)) {
        if (@($summary.stages) -notcontains "prepared") { $problems.Add("printId $($summary.printId) has events but no prepared record"); continue }
        try { [void](Get-OzkArchivedReceiptContent $Root $summary) } catch { $problems.Add([string]$_.Exception.Message) }
    }
    return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Events = $count; Problems = $problems.ToArray() }
}

Export-ModuleMember -Function Get-OzkReceiptArchiveDefaultRoot, ConvertTo-OzkCanonicalJson, Get-OzkSha256Hex, Get-OzkTextSha256,
    ConvertTo-OzkUtcText, ConvertTo-OzkInvoiceAmount, ConvertTo-OzkSelectedQuantity, New-OzkInvoiceComparable, Compare-OzkInvoiceComparable,
    New-OzkReceiptArchiveContent, Get-OzkArchivedComparable, Initialize-OzkReceiptArchive, Save-OzkArchivedReceipt, Add-OzkReceiptArchiveEvent,
    Get-OzkReceiptArchiveEvents, Get-OzkReceiptPrintSummaries, Test-OzkReceiptReachedSpooler, Get-OzkArchivedReceiptContent,
    Test-OzkReceiptArchiveIntegrity, Set-OzkReceiptArchiveAcl, Get-OzkReceiptArchiveAclReport
