#Requires -Version 5.1
# ============================================================================
# Test-SupplierObligationsReplacement.ps1
#
# يثبّت عقد استبدال التزامات الموردين بعد إلغاء مسار delete-then-insert.
#
# الخلفية (ملاحظتا Codex P1 على PR #204):
#   1) المسار القديم كان يحذف كل صفوف المصدر ثم يُدخل البديل. بين العمليتين
#      نافذة يكون فيها الجدول فارغاً، وأي انقطاع داخلها يترك الالتزامات
#      المالية ممسوحة. جدولة ذلك الكاتب كل ساعتين كانت تضاعف التعرّض.
#   2) الحارس القديم كان يرفض الحمولة الفارغة رفضاً مطلقاً ما لم يُمرَّر
#      -AllowEmpty، والمهمة المجدولة لا تمرّره. فحين يسدّد آخر مورد كان كل
#      تشغيل لاحق يُجهض، وتبقى أرصدة موجبة قديمة معروضة إلى الأبد — أي دَين
#      على من سدّد فعلاً.
#
# الاختبار لا يكتب نسخة موازية من المنطق: يستخرج الدالتين النقيتين من الملف
# الإنتاجي نفسه وينفّذهما، على نهج tools/tests/Test-RegisterTaskStartAtCaseCollision.ps1.
#
# حدود المدى (مُعلَنة عمداً): الشقّ الذي يحذف صفّ المورد الذي سدّد يعيش في دالة
# قاعدة البيانات replace_supplier_obligations، ولا يمكن تنفيذه بلا Postgres.
# هذا الملف يثبت أن المنتج يُسقط ذلك المورد من الحمولة؛ وبنية الحذف في الدالة
# يثبتها scripts/check-decision-pipeline-safety.mjs على نص الترحيلة.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-SupplierObligationsReplacement.ps1
# ============================================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$producerPath = Join-Path $repoRoot 'tools\push-supplier-obligations.ps1'
if (-not (Test-Path -LiteralPath $producerPath)) {
    $producerPath = Join-Path $repoRoot 'tools/push-supplier-obligations.ps1'
}

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }

if (-not (Test-Path -LiteralPath $producerPath)) {
    Write-Host "FAIL: cannot find the producer at $producerPath" -ForegroundColor Red
    exit 1
}
$producerText = Get-Content -LiteralPath $producerPath -Raw -Encoding UTF8

# ------------------------------------------------------------------
# استخرج الدالتين النقيتين من الملف الإنتاجي ونفّذهما هنا. أي انحراف في
# الأسماء يُسقط الاختبار فوراً بدل أن يختبر نسخة قديمة.
# ------------------------------------------------------------------
foreach ($fn in @('Get-SupplierObligationsPlan', 'ConvertTo-ReplacePayloadJson')) {
    $match = [regex]::Match($producerText, "(?ms)^function\s+$([regex]::Escape($fn))\s*\{.*?^\}")
    if (-not $match.Success) {
        Write-Host "FAIL: could not extract $fn from the producer" -ForegroundColor Red
        exit 1
    }
    . ([scriptblock]::Create($match.Value))
    Add-Pass "extracted $fn from the production script"
}

function New-SupplierRow([string]$Key, [string]$Name, [double]$AmountDue) {
    [PSCustomObject]@{
        supplier_key       = $Key
        supplier_name      = $Name
        debit_total        = 0.0
        credit_total       = $AmountDue
        amount_due         = [Math]::Max(0, $AmountDue)
        last_purchase_date = '2026-09-01'
    }
}
function Get-Payable($AllRows) { return @($AllRows | Where-Object { $_.amount_due -gt 0 }) }

# ==================================================================
# الحارس: قراءة فارغة تماماً = استعلام مشبوه، لا حقيقة محاسبية.
# ==================================================================
Write-Host "== guard: a completely empty read never touches Supabase"
$plan = Get-SupplierObligationsPlan -AllRows @() -PayableRows @()
if ($plan.Action -ne 'abort') { Add-Failure "an empty source read must abort, got '$($plan.Action)'" }
else { Add-Pass "empty source read aborts" }
if ($plan.AllowEmpty) { Add-Failure "an aborted plan must never authorize an empty replacement" }
else { Add-Pass "aborted plan does not authorize emptying" }

# ==================================================================
# السيناريو 1: التزامات موجبة طبيعية.
# ==================================================================
Write-Host "== scenario 1: normal positive obligations"
$all1 = @(
    (New-SupplierRow 'g-1' 'مورد أ' 1500.5),
    (New-SupplierRow 'g-2' 'مورد ب' 320.0),
    (New-SupplierRow 'g-3' 'مورد مسدَّد' 0.0)
)
$pay1 = Get-Payable $all1
$plan1 = Get-SupplierObligationsPlan -AllRows $all1 -PayableRows $pay1
if ($plan1.Action -ne 'replace') { Add-Failure "scenario 1 must replace, got '$($plan1.Action)'" }
else { Add-Pass "scenario 1 replaces the generation" }
if ($plan1.AllowEmpty) { Add-Failure "scenario 1 has payable rows; it must NOT authorize an empty replacement" }
else { Add-Pass "scenario 1 does not authorize emptying" }

$json1 = ConvertTo-ReplacePayloadJson -Source 'ameen_ac000_credit_minus_debit' -Rows $pay1 -AllowEmpty $plan1.AllowEmpty
if ($json1 -notmatch '"p_allow_empty":false') { Add-Failure "scenario 1 payload must send p_allow_empty:false" }
else { Add-Pass "scenario 1 sends p_allow_empty:false" }
$parsed1 = $json1 | ConvertFrom-Json
if (@($parsed1.p_rows).Count -ne 2) { Add-Failure "scenario 1 must send exactly the 2 payable suppliers, got $(@($parsed1.p_rows).Count)" }
else { Add-Pass "scenario 1 sends exactly the 2 payable suppliers" }

# ==================================================================
# السيناريو 2: مورد سدّد ⇒ يسقط من الحمولة، فتحذفه الدالة من الجدول.
# ==================================================================
Write-Host "== scenario 2: a supplier settles and must lose its stored row"
$all2 = @(
    (New-SupplierRow 'g-1' 'مورد أ' 1500.5),
    (New-SupplierRow 'g-2' 'مورد ب سدّد' 0.0)
)
$pay2 = Get-Payable $all2
$plan2 = Get-SupplierObligationsPlan -AllRows $all2 -PayableRows $pay2
if ($plan2.AllowEmpty) { Add-Failure "scenario 2 still has a payable supplier; emptying must not be authorized" }
else { Add-Pass "scenario 2 does not authorize emptying" }
$parsed2 = ($(ConvertTo-ReplacePayloadJson -Source 'ameen_ac000_credit_minus_debit' -Rows $pay2 -AllowEmpty $plan2.AllowEmpty) | ConvertFrom-Json)
$keys2 = @($parsed2.p_rows | ForEach-Object { $_.supplier_key })
if ($keys2 -contains 'g-2') { Add-Failure "the settled supplier g-2 must not appear in the replacement payload" }
else { Add-Pass "settled supplier is absent from the payload (the RPC deletes its stored row)" }
if ($keys2 -notcontains 'g-1') { Add-Failure "the still-payable supplier g-1 must remain in the payload" }
else { Add-Pass "still-payable supplier remains in the payload" }

# الشقّ الحاسم في PS 5.1: مصفوفة أحادية العنصر يجب أن تبقى مصفوفة في JSON،
# وإلا رفضتها jsonb_typeof(p_rows) = 'array' وفشل الاستبدال كاملاً.
if ($(ConvertTo-ReplacePayloadJson -Source 's' -Rows $pay2 -AllowEmpty $false) -notmatch '"p_rows":\[') {
    Add-Failure "a single-row payload must still serialize as a JSON array on Windows PowerShell 5.1"
} else { Add-Pass "single-row payload serializes as a JSON array (PS 5.1 unwrap trap covered)" }

# ==================================================================
# السيناريو 3: كل الموردين صفر ⇒ تفريغ مأذون لأن القراءة نفسها تحقَّقت.
# ==================================================================
Write-Host "== scenario 3: every supplier is settled -> authorized empty replacement"
$all3 = @(
    (New-SupplierRow 'g-1' 'مورد أ' 0.0),
    (New-SupplierRow 'g-2' 'مورد ب' 0.0),
    (New-SupplierRow 'g-3' 'مورد ج' 0.0)
)
$pay3 = Get-Payable $all3
$plan3 = Get-SupplierObligationsPlan -AllRows $all3 -PayableRows $pay3
if ($plan3.Action -ne 'replace') { Add-Failure "scenario 3 must publish the terminal generation, got '$($plan3.Action)'" }
else { Add-Pass "scenario 3 publishes the verified terminal generation" }
if (-not $plan3.AllowEmpty) { Add-Failure "scenario 3 must authorize the empty replacement; refusing it keeps debt on suppliers that already paid" }
else { Add-Pass "scenario 3 authorizes the empty replacement" }
$json3 = ConvertTo-ReplacePayloadJson -Source 'ameen_ac000_credit_minus_debit' -Rows $pay3 -AllowEmpty $plan3.AllowEmpty
if ($json3 -notmatch '"p_rows":\[\]') { Add-Failure "scenario 3 must send an empty JSON array" }
else { Add-Pass "scenario 3 sends an empty JSON array" }
if ($json3 -notmatch '"p_allow_empty":true') { Add-Failure "scenario 3 must send p_allow_empty:true" }
else { Add-Pass "scenario 3 sends p_allow_empty:true" }

# ==================================================================
# العقد النصّي على الملف الإنتاجي: لا حذف منفصل ولا تقسيم دفعات.
# ==================================================================
Write-Host "== producer contract: one atomic call, no standalone delete"
if ($producerText -match '(?i)-Method\s+Delete') { Add-Failure "the producer still issues a standalone REST DELETE" }
else { Add-Pass "no standalone REST DELETE remains" }
if ($producerText -match '\$batchSize') { Add-Failure "the producer still batches the payload, which breaks atomicity" }
else { Add-Pass "the payload is sent in a single call" }
if ($producerText -notmatch 'rest/v1/rpc/\$REPLACE_RPC') { Add-Failure "the producer does not call the replacement RPC" }
else { Add-Pass "the producer publishes through the replacement RPC" }

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "FAILED: $($failures.Count) assertion(s)." -ForegroundColor Red
    exit 1
}
Write-Host "PASSED: supplier obligations replacement contract holds." -ForegroundColor Green
exit 0
