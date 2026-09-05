# ============================================================
# discover-ameen-purchase-schema.ps1  (READ ONLY -- SELECT queries only)
#
# Goal: rediscover the Ameen schema needed later for purchase-invoice sync
# and item-snapshot work (branch purchase-invoices-ameen-v2), with every
# supplementary query that was needed to reach the findings embedded here
# so the whole discovery is reproducible from this one file.
#
# Hard rules enforced by this script:
#  - Never reads tools\.env. The SQL connection string comes ONLY from the
#    pre-set process/user environment variable AMEEN_SQL_CONNECTION_STRING.
#    The script exits with code 1 if that variable is not set.
#  - No INSERT/UPDATE/DELETE/MERGE against real tables, no write stored
#    procedures, no dynamic SQL (sp_executesql) and no table variables used
#    to accumulate scan results -- every query below is a single static
#    SELECT against tables already confirmed to exist.
#  - Purchase-invoice filtering never uses bt000.bIsInput = 1 alone, because
#    that flag is also set on sales-RETURN bill types (BillType = 3). Every
#    purchase-invoice query below filters on the exact confirmed purchase
#    TypeGUID ('91377a56-ebfc-48c0-b79e-72063e1d7e3a') instead.
#  - Sales/customer-side filtering never uses bt000.bIsOutput = 1 alone,
#    because that flag is also set on the purchase-RETURN bill type
#    (BillType = 2). The customer-account comparison below filters on
#    bt000.BillType = 1 (the confirmed real sales-invoice type) instead.
#  - No SELECT * anywhere -- every query lists only the columns needed.
#  - Never prints supplier/customer names or other personal data. Supplier
#    identity is pseudonymized (Supplier-1, Supplier-2, ...) via DENSE_RANK
#    over the account GUID. Aggregates use COUNT/MIN/MAX/AVG, not raw rows,
#    wherever raw rows could carry personal data. No free-text field content
#    is ever printed, not even masked -- only non-null counts and lengths.
#  - Purchase-return invoices are excluded from the price-basis comparison
#    query (SECTION 11) because zero real purchase-return rows currently
#    exist in this database (confirmed by SECTION 7) -- there is no real
#    sample to validate that logic against yet.
#  - SECTION 11 (price basis) filters on bu.TypeGUID = the confirmed purchase
#    GUID AND bu.IsPosted = 1 (unposted/draft bills never enter the Total
#    reconciliation), and groups every invoice by bu.GUID together with
#    Number (never Number alone, which is not guaranteed globally unique).
#    Its general conclusion is drawn from a full-population aggregate query
#    (match counts + average percent difference across ALL posted purchase
#    invoices), not from the TOP-20 preview query, which is kept only as a
#    human-readable sample. It also compares bu.Total against discount/
#    extra/VAT-adjusted candidate formulas (bi000.Discount/Extra/VAT, with
#    the IsDiscountValue/IsExtraValue flag distribution reported alongside
#    as a caveat), and separately checks bi.Unity against
#    mt000.Unit2Fact/Unit3Fact to see whether Price is a per-selected-unit
#    price and UnitCostPrice a base-unit-converted price. SECTION 11 answers
#    a READING question only (which field/formula matches bu.Total). It does
#    not conclude which field must be WRITTEN when creating a new purchase
#    invoice -- that remains open pending a manual match against a known
#    real invoice.
#  - This script is part of a documentation/discovery-only step. It is not
#    scheduled and must be run manually by the user on the LOQ machine.
#
# ASCII-only source to avoid PowerShell 5.1 encoding issues.
# ============================================================
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# Confirmed real TypeGUIDs (from a full bt000 dump, SECTION 1 below).
$PURCHASE_TYPE_GUID = '91377a56-ebfc-48c0-b79e-72063e1d7e3a'
$PURCHASE_RETURN_TYPE_GUID = 'c9aca8fe-f50e-46eb-91ac-29ee32acbb3e'

function Get-Setting($Name) {
    $v = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not $v) { $v = [Environment]::GetEnvironmentVariable($Name, "User") }
    return $v
}

# Connection string comes ONLY from a pre-set environment variable.
# tools\.env is never read by this script.
$connStr = Get-Setting "AMEEN_SQL_CONNECTION_STRING"
if (-not $connStr) {
    Write-Host "ERROR: AMEEN_SQL_CONNECTION_STRING is not set in the process or user environment."
    Write-Host "Set it first (see tools\setup-ameen-sync-env.ps1) then re-run this script."
    exit 1
}

Add-Type -AssemblyName "System.Data"
$conn = New-Object System.Data.SqlClient.SqlConnection($connStr)
try {
    $conn.Open()
} catch {
    Write-Host ("FAILED TO OPEN CONNECTION: " + $_.Exception.Message)
    exit 1
} finally {
    if ($conn.State -ne [System.Data.ConnectionState]::Open) { $conn.Dispose() }
}

function Run($title, $sql) {
    Write-Host ""
    Write-Host "==================== $title ===================="
    $reader = $null
    try {
        $cmd = $conn.CreateCommand()
        $cmd.CommandText = $sql
        $cmd.CommandTimeout = 90
        $reader = $cmd.ExecuteReader()
        $cols = @()
        for ($i = 0; $i -lt $reader.FieldCount; $i++) { $cols += $reader.GetName($i) }
        Write-Host ("[" + ($cols -join " | ") + "]")
        $n = 0
        while ($reader.Read()) {
            $vals = @()
            for ($i = 0; $i -lt $reader.FieldCount; $i++) { $vals += [string]$reader.GetValue($i) }
            Write-Host ($vals -join " | ")
            $n++
        }
        Write-Host "(rows: $n)"
    } catch {
        Write-Host ("FAILED: " + $_.Exception.Message)
        throw
    } finally {
        if ($reader -and -not $reader.IsClosed) { $reader.Close() }
    }
}

try {
    # ------------------------------------------------------------
    # SECTION 1 - bill type master (confirms TypeGUID for purchase / purchase
    # return; do not hardcode assumptions, always re-check live).
    # ------------------------------------------------------------
    Run "bt000 BILL TYPES" "
    SELECT GUID, BillType, Name, bIsInput, bIsOutput
    FROM dbo.bt000
    ORDER BY BillType"

    # ------------------------------------------------------------
    # SECTION 2 - table schemas (metadata only, no data rows here)
    # ------------------------------------------------------------
    Run "bu000 COLUMNS (bill header)" "
    SELECT c.name AS col, t.name AS type
    FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.bu000')
    ORDER BY c.column_id"

    Run "bi000 COLUMNS (bill lines - confirmed via bi000.ParentGUID = bu000.GUID)" "
    SELECT c.name AS col, t.name AS type
    FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.bi000')
    ORDER BY c.column_id"

    Run "mt000 COLUMNS (material master)" "
    SELECT c.name AS col, t.name AS type
    FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.mt000')
    ORDER BY c.column_id"

    Run "ac000 COLUMNS (chart of accounts - suppliers and customers both live here)" "
    SELECT c.name AS col, t.name AS type
    FROM sys.columns c JOIN sys.types t ON c.user_type_id = t.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.ac000')
    ORDER BY c.column_id"

    # ------------------------------------------------------------
    # SECTION 3 - purchase invoice header sample (bu000.Date is the real
    # column; NOT Date_). Filtered on the exact confirmed purchase TypeGUID,
    # NOT bt000.bIsInput = 1 (which also matches sales-return bill types).
    # Supplier identity is pseudonymized via DENSE_RANK over CustAccGUID so
    # no real name is ever printed.
    # ------------------------------------------------------------
    Run "SAMPLE PURCHASE INVOICE HEADERS (TOP 10, supplier pseudonymized)" "
    SELECT TOP 10
        bu.Number,
        bu.Date,
        'Supplier-' + CAST(DENSE_RANK() OVER (ORDER BY bu.CustAccGUID) AS varchar(10)) AS SupplierPseudo,
        bu.CurrencyGUID,
        bu.PayType,
        bu.FirstPay,
        bu.Total,
        bu.TotalPurchaseVal
    FROM dbo.bu000 bu
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID'
    ORDER BY bu.Date DESC, bu.Number DESC"

    # ------------------------------------------------------------
    # SECTION 4 - line items for one real purchase invoice, joined via the
    # confirmed FK bi000.ParentGUID = bu000.GUID (bd000 does not exist in this
    # database; bdp000 is an unrelated classification/cost-center table - both
    # removed from this script entirely).
    # ------------------------------------------------------------
    Run "SAMPLE PURCHASE INVOICE LINES (latest purchase invoice, via bi000.ParentGUID)" "
    DECLARE @g uniqueidentifier = (
        SELECT TOP 1 bu.GUID FROM dbo.bu000 bu
        WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID'
        ORDER BY bu.Date DESC, bu.Number DESC
    );
    SELECT
        bi.Number,
        bi.Qty,
        bi.Unity,
        bi.Price,
        bi.PurchaseVal,
        bi.UnitCostPrice,
        bi.Discount,
        bi.VAT,
        mt.Code AS MaterialCode
    FROM dbo.bi000 bi
    LEFT JOIN dbo.mt000 mt ON mt.GUID = bi.MatGUID
    WHERE bi.ParentGUID = @g
    ORDER BY bi.Number"

    # ------------------------------------------------------------
    # SECTION 5 - CLOSED ITEM: reference currency table for CurrencyGUID.
    # The my000 table was already established as the currency master in a
    # prior run of this script (dynamic read-only scan, no longer needed now
    # that the table is known). This is a single direct SELECT, no dynamic
    # SQL, no table-variable accumulation.
    # ------------------------------------------------------------
    Run "my000 CONFIRMATION (currency master - resolve purchase-invoice CurrencyGUID)" "
    SELECT my.CurrencyISO, my.LatinName, my.GUID
    FROM dbo.my000 my
    WHERE my.GUID = (
        SELECT TOP 1 bu.CurrencyGUID FROM dbo.bu000 bu
        WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.CurrencyGUID IS NOT NULL
        ORDER BY bu.Date DESC
    )"

    # ------------------------------------------------------------
    # SECTION 6 - OPEN ITEM: PayType / FirstPay semantics. Distribution only;
    # this remains UNRESOLVED until manually cross-checked against one known
    # cash invoice and one known credit invoice in the Ameen UI itself - no
    # lookup/enum table for PayType was found, so the distribution alone is
    # not proof of meaning.
    # ------------------------------------------------------------
    Run "PayType / FirstPay DISTRIBUTION across purchase invoices (still unresolved - see note above)" "
    SELECT bu.PayType, bu.FirstPay, COUNT(*) AS InvoiceCount
    FROM dbo.bu000 bu
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID'
    GROUP BY bu.PayType, bu.FirstPay
    ORDER BY bu.PayType, bu.FirstPay"

    Run "TABLES LIKE %pay% (lookup/enum candidates for PayType - none conclusive so far)" "
    SELECT name FROM sys.tables WHERE name LIKE '%pay%' ORDER BY name"

    # ------------------------------------------------------------
    # SECTION 7 - OPEN ITEM: real purchase-return invoice test
    # (TypeGUID = c9aca8fe-f50e-46eb-91ac-29ee32acbb3e), including
    # RefundedBillGUID behavior and bi000 line structure for returns.
    # Zero real rows currently exist (confirmed below) - this is why
    # SECTION 11's price-basis comparison excludes purchase returns.
    # ------------------------------------------------------------
    Run "SAMPLE PURCHASE RETURN HEADERS (TOP 5, supplier pseudonymized)" "
    SELECT TOP 5
        bu.Number,
        bu.Date,
        'Supplier-' + CAST(DENSE_RANK() OVER (ORDER BY bu.CustAccGUID) AS varchar(10)) AS SupplierPseudo,
        bu.RefundedBillGUID,
        bu.Total,
        bu.TotalPurchaseVal
    FROM dbo.bu000 bu
    WHERE bu.TypeGUID = '$PURCHASE_RETURN_TYPE_GUID'
    ORDER BY bu.Date DESC, bu.Number DESC"

    Run "SAMPLE PURCHASE RETURN LINES (latest return invoice, via bi000.ParentGUID)" "
    DECLARE @g uniqueidentifier = (
        SELECT TOP 1 GUID FROM dbo.bu000
        WHERE TypeGUID = '$PURCHASE_RETURN_TYPE_GUID'
        ORDER BY Date DESC, Number DESC
    );
    SELECT
        bi.Number,
        bi.Qty,
        bi.Unity,
        bi.Price,
        bi.PurchaseVal,
        mt.Code AS MaterialCode
    FROM dbo.bi000 bi
    LEFT JOIN dbo.mt000 mt ON mt.GUID = bi.MatGUID
    WHERE bi.ParentGUID = @g
    ORDER BY bi.Number"

    Run "DOES RefundedBillGUID resolve back to a real purchase invoice header?" "
    SELECT COUNT(*) AS ReturnsWithResolvableOriginal
    FROM dbo.bu000 ret
    JOIN dbo.bu000 orig ON orig.GUID = ret.RefundedBillGUID
    WHERE ret.TypeGUID = '$PURCHASE_RETURN_TYPE_GUID'"

    # ------------------------------------------------------------
    # SECTION 8 - CLOSED ITEM: TextFld1..4 actual usage. Aggregate stats only
    # (non-null count, min/max length) -- no masked sample, no raw content,
    # since these free-text fields could carry personal or business-
    # sensitive notes.
    # ------------------------------------------------------------
    Run "TextFld1..4 USAGE STATS on purchase invoices" "
    SELECT
        COUNT(*) AS TotalInvoices,
        COUNT(bu.TextFld1) AS TextFld1_NonNull, MAX(LEN(bu.TextFld1)) AS TextFld1_MaxLen,
        COUNT(bu.TextFld2) AS TextFld2_NonNull, MAX(LEN(bu.TextFld2)) AS TextFld2_MaxLen,
        COUNT(bu.TextFld3) AS TextFld3_NonNull, MAX(LEN(bu.TextFld3)) AS TextFld3_MaxLen,
        COUNT(bu.TextFld4) AS TextFld4_NonNull, MAX(LEN(bu.TextFld4)) AS TextFld4_MaxLen
    FROM dbo.bu000 bu
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID'"

    # ------------------------------------------------------------
    # SECTION 9 - CLOSED ITEM: TotalPurchaseVal (header) and PurchaseVal
    # (line) actual population -- aggregate stats to see whether they are
    # populated at save time or only later (e.g. at posting/costing time).
    # ------------------------------------------------------------
    Run "bu000.TotalPurchaseVal STATS on purchase invoices" "
    SELECT
        COUNT(*) AS TotalInvoices,
        COUNT(NULLIF(bu.TotalPurchaseVal, 0)) AS NonZeroCount,
        MIN(bu.TotalPurchaseVal) AS MinVal,
        MAX(bu.TotalPurchaseVal) AS MaxVal,
        AVG(bu.TotalPurchaseVal) AS AvgVal
    FROM dbo.bu000 bu
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID'"

    Run "bi000.PurchaseVal STATS on purchase invoice lines" "
    SELECT
        COUNT(*) AS TotalLines,
        COUNT(NULLIF(bi.PurchaseVal, 0)) AS NonZeroCount,
        MIN(bi.PurchaseVal) AS MinVal,
        MAX(bi.PurchaseVal) AS MaxVal,
        AVG(bi.PurchaseVal) AS AvgVal
    FROM dbo.bi000 bi
    JOIN dbo.bu000 bu ON bu.GUID = bi.ParentGUID
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID'"

    # ------------------------------------------------------------
    # SECTION 10 - CLOSED ITEM: ac000.Type semantics. Compare the Type
    # value(s) seen on confirmed purchase-invoice supplier accounts against
    # the Type value(s) seen on confirmed sales-invoice (customer) accounts.
    # Purchase side filters on the exact purchase TypeGUID (not bIsInput=1,
    # which also matches sales-return types). Sales side filters on
    # bt000.BillType = 1 (the confirmed real sales-invoice type), not
    # bIsOutput=1 (which also matches the purchase-return type). No names
    # printed -- only Type and counts.
    # ------------------------------------------------------------
    Run "ac000.Type DISTRIBUTION for PURCHASE-invoice counterparty accounts (suppliers)" "
    SELECT ac.Type, COUNT(DISTINCT ac.GUID) AS DistinctAccounts
    FROM dbo.ac000 ac
    WHERE ac.GUID IN (
        SELECT DISTINCT bu.CustAccGUID
        FROM dbo.bu000 bu
        WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.CustAccGUID IS NOT NULL
    )
    GROUP BY ac.Type
    ORDER BY ac.Type"

    Run "ac000.Type DISTRIBUTION for SALES-invoice counterparty accounts (customers, BillType=1 confirmed sales types only)" "
    SELECT ac.Type, COUNT(DISTINCT ac.GUID) AS DistinctAccounts
    FROM dbo.ac000 ac
    WHERE ac.GUID IN (
        SELECT DISTINCT bu.CustAccGUID
        FROM dbo.bu000 bu
        JOIN dbo.bt000 bt ON bt.GUID = bu.TypeGUID
        WHERE bt.BillType = 1 AND bu.CustAccGUID IS NOT NULL
    )
    GROUP BY ac.Type
    ORDER BY ac.Type"

    # ------------------------------------------------------------
    # SECTION 11 - real purchase-price basis (round 5: posted-only, GUID-based
    # grouping, full-population stats, discount/extra/VAT-aware formulas, and
    # a Unity vs mt000.Unit2Fact/Unit3Fact conversion check). This section
    # only reconciles which line field/formula matches the header Total for
    # READING purposes. It does NOT decide which field must be WRITTEN when
    # creating a new invoice -- that is a separate, still-open question (see
    # the closing note below and the report). Every invoice is grouped by
    # bu.GUID (not Number alone, which is not guaranteed globally unique) and
    # filtered on bu.IsPosted = 1 so unposted/draft bills cannot skew Total
    # reconciliation. Purchase returns stay excluded (SECTION 7: zero rows).
    # Confirmed bi000 columns used below (from SECTION 2's live dump):
    # Discount, Extra, VAT, IsDiscountValue, IsExtraValue.
    # ------------------------------------------------------------
    Run "PURCHASE INVOICE TOTAL vs SUM(Qty*Price) and SUM(Qty*UnitCostPrice) - PREVIEW ONLY (TOP 20 latest posted, by bu.GUID+Number)" "
    SELECT TOP 20
        bu.GUID AS InvGUID,
        bu.Number AS InvNumber,
        bu.Total AS HeaderTotal,
        SUM(bi.Qty * bi.Price) AS SumQtyPrice,
        SUM(bi.Qty * bi.UnitCostPrice) AS SumQtyUnitCostPrice,
        COUNT(DISTINCT bi.Unity) AS DistinctUnityValuesOnInvoice
    FROM dbo.bu000 bu
    JOIN dbo.bi000 bi ON bi.ParentGUID = bu.GUID
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.IsPosted = 1
    GROUP BY bu.GUID, bu.Number, bu.Total
    ORDER BY bu.Number DESC"

    Run "PURCHASE INVOICE TOTAL MATCH STATS - FULL POPULATION (ALL posted invoices, not just TOP 20)" "
    WITH InvSums AS (
        SELECT
            bu.GUID,
            bu.Number,
            bu.Total,
            SUM(bi.Qty * bi.Price) AS SumQtyPrice,
            SUM(bi.Qty * bi.UnitCostPrice) AS SumQtyUnitCostPrice,
            SUM(bi.Qty * bi.Price - ISNULL(bi.Discount, 0) + ISNULL(bi.Extra, 0) + ISNULL(bi.VAT, 0)) AS SumQtyPriceDiscExtraVat,
            SUM(bi.Qty * bi.UnitCostPrice - ISNULL(bi.Discount, 0) + ISNULL(bi.Extra, 0) + ISNULL(bi.VAT, 0)) AS SumQtyCostDiscExtraVat
        FROM dbo.bu000 bu
        JOIN dbo.bi000 bi ON bi.ParentGUID = bu.GUID
        WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.IsPosted = 1
        GROUP BY bu.GUID, bu.Number, bu.Total
    )
    SELECT
        COUNT(*) AS TotalPostedInvoices,
        SUM(CASE WHEN ABS(Total - SumQtyPrice) <= 0.01 THEN 1 ELSE 0 END) AS MatchCount_QtyPrice,
        SUM(CASE WHEN ABS(Total - SumQtyUnitCostPrice) <= 0.01 THEN 1 ELSE 0 END) AS MatchCount_QtyUnitCostPrice,
        SUM(CASE WHEN ABS(Total - SumQtyPriceDiscExtraVat) <= 0.01 THEN 1 ELSE 0 END) AS MatchCount_QtyPriceDiscExtraVat,
        SUM(CASE WHEN ABS(Total - SumQtyCostDiscExtraVat) <= 0.01 THEN 1 ELSE 0 END) AS MatchCount_QtyCostDiscExtraVat,
        AVG(CASE WHEN Total <> 0 THEN ABS(Total - SumQtyPrice) / ABS(Total) END) AS AvgPctDiff_QtyPrice,
        AVG(CASE WHEN Total <> 0 THEN ABS(Total - SumQtyUnitCostPrice) / ABS(Total) END) AS AvgPctDiff_QtyUnitCostPrice,
        AVG(CASE WHEN Total <> 0 THEN ABS(Total - SumQtyPriceDiscExtraVat) / ABS(Total) END) AS AvgPctDiff_QtyPriceDiscExtraVat,
        AVG(CASE WHEN Total <> 0 THEN ABS(Total - SumQtyCostDiscExtraVat) / ABS(Total) END) AS AvgPctDiff_QtyCostDiscExtraVat
    FROM InvSums"

    Run "PURCHASE INVOICE LINES BY Unity - SUM(Qty*Price) vs SUM(Qty*UnitCostPrice) per Unity value (posted only)" "
    SELECT
        bi.Unity,
        COUNT(*) AS LineCount,
        SUM(bi.Qty * bi.Price) AS SumQtyPrice,
        SUM(bi.Qty * bi.UnitCostPrice) AS SumQtyUnitCostPrice
    FROM dbo.bi000 bi
    JOIN dbo.bu000 bu ON bu.GUID = bi.ParentGUID
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.IsPosted = 1
    GROUP BY bi.Unity
    ORDER BY bi.Unity"

    Run "bi000 Discount/Extra VALUE-vs-PERCENT FLAG DISTRIBUTION (posted purchase lines only) - caveat for the formulas above" "
    SELECT
        ISNULL(bi.IsDiscountValue, 0) AS IsDiscountValue,
        ISNULL(bi.IsExtraValue, 0) AS IsExtraValue,
        COUNT(*) AS LineCount
    FROM dbo.bi000 bi
    JOIN dbo.bu000 bu ON bu.GUID = bi.ParentGUID
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.IsPosted = 1
    GROUP BY bi.IsDiscountValue, bi.IsExtraValue
    ORDER BY IsDiscountValue, IsExtraValue"

    # Read-only check: is Price the price of the line's chosen Unity, and
    # UnitCostPrice that price already converted to the material's base unit
    # via mt000.Unit2Fact/Unit3Fact? Aggregated only (avg ratio per Unity),
    # no per-line rows, no material names.
    Run "bi.Unity vs mt000.Unit2Fact/Unit3Fact - is Price per-Unity and UnitCostPrice per-base-unit? (posted purchase lines only)" "
    SELECT
        bi.Unity,
        COUNT(*) AS LineCount,
        AVG(mt.Unit2Fact) AS AvgUnit2Fact,
        AVG(mt.Unit3Fact) AS AvgUnit3Fact,
        AVG(CASE WHEN bi.UnitCostPrice <> 0 THEN bi.Price / bi.UnitCostPrice END) AS AvgPriceOverUnitCostPrice,
        AVG(CASE WHEN bi.Price <> 0 THEN bi.UnitCostPrice / bi.Price END) AS AvgUnitCostPriceOverPrice
    FROM dbo.bi000 bi
    JOIN dbo.bu000 bu ON bu.GUID = bi.ParentGUID
    LEFT JOIN dbo.mt000 mt ON mt.GUID = bi.MatGUID
    WHERE bu.TypeGUID = '$PURCHASE_TYPE_GUID' AND bu.IsPosted = 1
    GROUP BY bi.Unity
    ORDER BY bi.Unity"

    Write-Host ""
    Write-Host "==================== DONE (read only, no writes) ===================="
    Write-Host "Note: this script makes no final naming assumptions. Review the actual"
    Write-Host "output before writing any real query into push-purchase-item-snapshot.ps1"
    Write-Host "or sync-purchase-invoices-to-ameen.ps1."
    Write-Host "SECTION 11 only answers which field/formula matches bu.Total for READING."
    Write-Host "It does NOT decide which field to WRITE when creating a new purchase"
    Write-Host "invoice -- that still needs a manual match against one known real invoice"
    Write-Host "before any sync script writes cost/price fields."
} catch {
    Write-Host ("SCRIPT FAILED: " + $_.Exception.Message)
    exit 1
} finally {
    if ($conn.State -eq [System.Data.ConnectionState]::Open) { $conn.Close() }
    $conn.Dispose()
}
