<#
.SYNOPSIS
  اختبارات regression لمسار طباعة فواتير الكاشير (XPrinter) — بلا اتصال SQL،
  بلا Scheduled Task، بلا طباعة فعلية فيزيائية، وبلا تشغيل أي حلقة رئيسية.

.DESCRIPTION
  - Send-OzkReceiptToPrinter تُختبر عبر Import-Module الحقيقي لـ OzkReceiptRenderer.psm1
    (الملف آمن للاستيراد: لا اتصال SQL ولا طباعة عند وقت الـimport نفسه).
  - Get-InvoiceFingerprint و Remove-StaleFingerprints تُستخرجان نصياً من المصدر
    الفعلي الحالي لـ ozk-print-bridge.ps1 (الذي يحتوي كوداً غير آمن للتنفيذ
    المباشر على مستوى الوحدة: اتصال SQL وحلقة لا نهائية) وتُشغَّلان بمعزل تام،
    لتفادي اختبار نسخة مكرّرة قد تنحرف عن الأصل.
  - الفحوص البنيوية (regex) على مصدر ozk-print-bridge-watchdog.ps1 تتحقق من أن
    -IncludeWholesale معطّل افتراضياً وأنه لا يُمرَّر إلا صراحةً.

.NOTES
  تشغيل:
    powershell -NoProfile -ExecutionPolicy Bypass -File ozk-print-bridge\__tests__\cashier-regression.tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeDir = Split-Path -Parent $here

$script:passed = 0
$script:failed = 0

function Test-Case([string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        $script:passed++
        Write-Host "  OK  $Name"
    } catch {
        $script:failed++
        Write-Host "  FAIL $Name"
        Write-Host "        $($_.Exception.Message)"
    }
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws([scriptblock]$Body, [string]$Message) {
    $threw = $false
    try { & $Body } catch { $threw = $true }
    if (-not $threw) { throw "Assertion failed (expected throw): $Message" }
}

# ─── استخراج نصّي لدالة من مصدر ozk-print-bridge.ps1 (لا تنفيذ للملف كاملاً) ───
function Get-ExtractedFunctionText([string]$SourceText, [string]$Signature) {
    $startIdx = $SourceText.IndexOf($Signature)
    Assert-True ($startIdx -ge 0) "لم يُعثر على التوقيع: $Signature"
    $braceOpen = $SourceText.IndexOf("{", $startIdx)
    $endMarker = "`n}`n"
    $endIdx = $SourceText.IndexOf($endMarker, $braceOpen)
    Assert-True ($endIdx -ge 0) "تعذّر تحديد نهاية الدالة لـ: $Signature"
    return $SourceText.Substring($startIdx, ($endIdx + 2) - $startIdx)
}

$bridgeSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge.ps1") -Raw
$watchdogSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge-watchdog.ps1") -Raw

$fingerprintFnText = Get-ExtractedFunctionText $bridgeSrc "function Get-InvoiceFingerprint(`$Candidate, `$Snapshot) {"
$staleFnText = Get-ExtractedFunctionText $bridgeSrc "function Remove-StaleFingerprints(`$RecentFingerprints, [datetime]`$Now, [int]`$MaxAgeSeconds) {"

# ينفَّذ في نطاق منفصل عبر Invoke-Command داخل نفس الجلسة (لا new-runspace لازم) —
# مجرد تعريف الدالتين هنا فقط، بلا أي تعريفات/تنفيذ آخر من الملف الأصلي.
. ([scriptblock]::Create($fingerprintFnText))
. ([scriptblock]::Create($staleFnText))

Write-Host "== cashier-regression: Get-InvoiceFingerprint / Remove-StaleFingerprints (المصدر الفعلي الحالي) =="

function New-Snapshot([string]$TypeGuid, [string]$InvoiceNumber, [string]$InvoiceDate, [string]$CustomerName, [double]$InvoiceTotal, [int]$LineCount) {
    [pscustomobject]@{
        Header = [pscustomobject]@{
            TypeGuid      = $TypeGuid
            InvoiceNumber = $InvoiceNumber
            InvoiceDate   = $InvoiceDate
            CustomerName  = $CustomerName
            InvoiceTotal  = $InvoiceTotal
        }
        LineCount = $LineCount
    }
}

Test-Case "نفس محتوى الفاتورة (نفس الحقول) ينتج نفس البصمة" {
    $snap = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1500.5 3
    $cand = [pscustomobject]@{ BranchGuid = "BR-1" }
    $fp1 = Get-InvoiceFingerprint $cand $snap
    $fp2 = Get-InvoiceFingerprint $cand $snap
    Assert-True ($fp1 -eq $fp2) "نفس المدخلات يجب أن تنتج نفس البصمة"
}

Test-Case "بصمة الفاتورة لا تعتمد على GUID الفاتورة (لا يوجد InvoiceGuid ضمن مدخلات الحساب)" {
    $snap = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1500.5 3
    $cand1 = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "AAAA-1111" }
    $cand2 = [pscustomobject]@{ BranchGuid = "BR-1"; InvoiceGuid = "BBBB-2222" }
    $fp1 = Get-InvoiceFingerprint $cand1 $snap
    $fp2 = Get-InvoiceFingerprint $cand2 $snap
    Assert-True ($fp1 -eq $fp2) "GUID الفاتورة يجب ألا يؤثر على البصمة — المحتوى فقط هو المعيار"
}

Test-Case "اختلاف الإجمالي (Total) ينتج بصمة مختلفة" {
    $snapA = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1500.5 3
    $snapB = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1600.0 3
    $cand = [pscustomobject]@{ BranchGuid = "BR-1" }
    $fp1 = Get-InvoiceFingerprint $cand $snapA
    $fp2 = Get-InvoiceFingerprint $cand $snapB
    Assert-True ($fp1 -ne $fp2) "اختلاف الإجمالي يجب أن يغيّر البصمة"
}

Test-Case "اختلاف عدد السطور (LineCount) ينتج بصمة مختلفة" {
    $snapA = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1500.5 3
    $snapB = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1500.5 4
    $cand = [pscustomobject]@{ BranchGuid = "BR-1" }
    $fp1 = Get-InvoiceFingerprint $cand $snapA
    $fp2 = Get-InvoiceFingerprint $cand $snapB
    Assert-True ($fp1 -ne $fp2) "اختلاف عدد السطور يجب أن يغيّر البصمة"
}

Test-Case "فرق التاريخ فقط (بدون تغيير باقي الحقول) ينتج بصمة مختلفة" {
    $snapA = New-Snapshot "TYPE-A" "1001" "2026-01-05" "زبون تجريبي" 1500.5 3
    $snapB = New-Snapshot "TYPE-A" "1001" "2026-01-06" "زبون تجريبي" 1500.5 3
    $cand = [pscustomobject]@{ BranchGuid = "BR-1" }
    $fp1 = Get-InvoiceFingerprint $cand $snapA
    $fp2 = Get-InvoiceFingerprint $cand $snapB
    Assert-True ($fp1 -ne $fp2) "اختلاف التاريخ يجب أن يغيّر البصمة"
}

Test-Case "Remove-StaleFingerprints تحذف الإدخالات الأقدم من النافذة الزمنية فقط" {
    $now = [datetime]::UtcNow
    $recent = @{
        "fp-old" = [pscustomobject]@{ printedAt = $now.AddSeconds(-4000).ToString("o") }
        "fp-new" = [pscustomobject]@{ printedAt = $now.AddSeconds(-10).ToString("o") }
    }
    Remove-StaleFingerprints $recent $now 3600
    Assert-True (-not $recent.ContainsKey("fp-old")) "الإدخال القديم (أقدم من 3600 ثانية) يجب أن يُحذف"
    Assert-True ($recent.ContainsKey("fp-new")) "الإدخال الحديث يجب أن يبقى"
}

Test-Case "Remove-StaleFingerprints تحذف الإدخالات ذات تاريخ غير صالح (تعامل آمن مع بيانات تالفة)" {
    $now = [datetime]::UtcNow
    $recent = @{ "fp-bad" = [pscustomobject]@{ printedAt = "ليس تاريخاً صالحاً" } }
    Remove-StaleFingerprints $recent $now 3600
    Assert-True (-not $recent.ContainsKey("fp-bad")) "تاريخ تالف يجب أن يُعامل كمنتهي الصلاحية ويُحذف بأمان"
}

Write-Host "`n== cashier-regression: Send-OzkReceiptToPrinter (استيراد حقيقي لـ OzkReceiptRenderer.psm1) =="

Import-Module (Join-Path $bridgeDir "OzkReceiptRenderer.psm1") -Force

Test-Case "رفض الطباعة بلا -ConfirmPhysicalPrint حتى لو كان اسم الطابعة صحيحاً (قبل أي CIM/طباعة)" {
    Assert-Throws {
        Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath "C:\nonexistent.png" -PrinterName "XPRINTER XP-T80Q 80MM"
    } "يجب رفض الطباعة بدون -ConfirmPhysicalPrint"
}

Test-Case "رفض أي طابعة غير XPRINTER XP-T80Q 80MM حتى مع -ConfirmPhysicalPrint (لا fallback افتراضي/معاد توجيهه)" {
    Assert-Throws {
        Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath "C:\nonexistent.png" -PrinterName "Microsoft Print to PDF" -ConfirmPhysicalPrint
    } "يجب رفض أي طابعة غير XPRINTER XP-T80Q 80MM"
}

Test-Case "رفض تطابق بحالة أحرف مختلفة (case-sensitive) — لا تساهل في اسم الطابعة" {
    Assert-Throws {
        Send-OzkReceiptToPrinter -Receipt ([pscustomobject]@{}) -LogoPath "C:\nonexistent.png" -PrinterName "xprinter xp-t80q 80mm" -ConfirmPhysicalPrint
    } "المطابقة يجب أن تكون حساسة لحالة الأحرف (-cne)، فلا يُقبل اسم بحالة أحرف مختلفة"
}

Write-Host "`n== cashier-regression: فحوص بنيوية على المصدر الحالي (نصّية) =="

Test-Case "watchdog: اسم الطابعة الافتراضي للكاشير هو XPRINTER XP-T80Q 80MM" {
    Assert-True ($watchdogSrc -match '\[string\]\$PrinterName = "XPRINTER XP-T80Q 80MM"') "يجب أن يكون الافتراضي XPRINTER XP-T80Q 80MM"
}

Test-Case "watchdog: -IncludeWholesale معرّف كـ switch (معطّل افتراضياً ما لم يُمرَّر صراحةً)" {
    Assert-True ($watchdogSrc -match '\[switch\]\$IncludeWholesale') "يجب أن يكون IncludeWholesale من نوع switch لا قيمة افتراضية True"
}

Test-Case "watchdog: تمرير IncludeWholesale إلى bridgeParameters مشروط صراحةً بـ if (`$IncludeWholesale)" {
    Assert-True ($watchdogSrc -match 'if \(\$IncludeWholesale\) \{ \$bridgeParameters\.IncludeWholesale = \$true \}') "يجب أن يكون التمرير مشروطاً فقط، بلا تفعيل افتراضي"
}

Test-Case "watchdog: حارس صريح يرفض أي طابعة غير XPRINTER XP-T80Q 80MM (بلا fallback)" {
    Assert-True ($watchdogSrc -match '(?s)if \(\$PrinterName -cne "XPRINTER XP-T80Q 80MM"\)\s*\{\s*throw') "يجب وجود حارس case-sensitive صريح يرمي عند أي اسم مختلف"
}

# ─── استخراج نصّي لتعريف متغيّر على مستوى السكربت (سطر واحد أو مصفوفة) ───
function Get-ExtractedAssignmentText([string]$SourceText, [string]$VariableName) {
    $startIdx = $SourceText.IndexOf($VariableName + " = ")
    Assert-True ($startIdx -ge 0) "لم يُعثر على تعريف: $VariableName"
    $lineEnd = $SourceText.IndexOf("`n", $startIdx)
    $line = $SourceText.Substring($startIdx, $lineEnd - $startIdx)
    if ($line.TrimEnd().EndsWith("@(")) {
        $close = $SourceText.IndexOf("`n)", $startIdx)
        Assert-True ($close -ge 0) "تعذّر تحديد نهاية المصفوفة لـ: $VariableName"
        return $SourceText.Substring($startIdx, ($close + 2) - $startIdx)
    }
    return $line
}

$uiSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "ozk-print-bridge-ui.ps1") -Raw
$rendererSrc = Get-Content -LiteralPath (Join-Path $bridgeDir "OzkReceiptRenderer.psm1") -Raw

# مسارات المصدر مكتوبة بفواصل Windows (\). عند تشغيل الاختبارات على منصّة أخرى
# للتحقق من المنطق، تُطبَّع الفواصل فقط لغرض فحص الوجود — دون تغيير أي مصدر.
function ConvertTo-PlatformPath([string]$Path) {
    if ([IO.Path]::DirectorySeparatorChar -eq "\") { return $Path }
    return $Path.Replace("\", "/")
}

Write-Host "`n== P1-A: مسارات وحدة العرض والشعار تُحلّ نسبةً إلى مجلد الجسر =="

# تُقرأ المسارات من المصدر الفعلي لا من نسخة مكتوبة هنا، فأي عودة إلى الصيغة
# المعطوبة تنعكس مباشرةً على هذه الاختبارات.
. ([scriptblock]::Create(((Get-ExtractedAssignmentText $bridgeSrc '$script:ReceiptModulePath') -replace '\$PSScriptRoot', "'$bridgeDir'")))
. ([scriptblock]::Create(((Get-ExtractedAssignmentText $bridgeSrc '$script:ReceiptLogoPath') -replace '\$PSScriptRoot', "'$bridgeDir'")))

Test-Case "المسار المحسوب لوحدة OzkReceiptRenderer.psm1 موجود فعلاً على القرص" {
    Assert-True (Test-Path -LiteralPath (ConvertTo-PlatformPath $script:ReceiptModulePath) -PathType Leaf) "المسار المحسوب غير موجود: $script:ReceiptModulePath"
}

Test-Case "المسار المحسوب لشعار الإيصال موجود فعلاً على القرص" {
    Assert-True (Test-Path -LiteralPath (ConvertTo-PlatformPath $script:ReceiptLogoPath) -PathType Leaf) "المسار المحسوب غير موجود: $script:ReceiptLogoPath"
}

Test-Case "negative witness: الصيغة المعطوبة (بادئة ozk-print-bridge مكررة) تعطي مساراً غير موجود" {
    $doubleNestedModule = ConvertTo-PlatformPath (Join-Path $bridgeDir "ozk-print-bridge\OzkReceiptRenderer.psm1")
    $doubleNestedLogo = ConvertTo-PlatformPath (Join-Path $bridgeDir "ozk-print-bridge\assets\ozk-receipt-horse-logo.png")
    Assert-True (-not (Test-Path -LiteralPath $doubleNestedModule)) "التعشيش المزدوج يجب ألا يوجد — لو وُجد لفقد الاختبار قدرته على كشف العطل"
    Assert-True (-not (Test-Path -LiteralPath $doubleNestedLogo)) "التعشيش المزدوج للشعار يجب ألا يوجد"
}

Test-Case "negative witness: المصدر لا يحتوي أي Join-Path يعيد بادئة ozk-print-bridge على PSScriptRoot" {
    Assert-True ($bridgeSrc -notmatch 'Join-Path \$PSScriptRoot "ozk-print-bridge\\') "عودة البادئة المكررة إلى المصدر يجب أن تُفشل هذا الاختبار"
}

Write-Host "`n== P1-B: PrintBridge مسؤول عن الكاشير (Retail) فقط =="

. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:CashierInvoiceTypes')))
. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:RetailTypeGuid')))
. ([scriptblock]::Create((Get-ExtractedAssignmentText $bridgeSrc '$script:WholesaleTypeGuids')))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Assert-CashierInvoiceType([string]`$Name) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Assert-CashierTypeGuid([string]`$TypeGuid, [int]`$InvoiceNumber) {")))

Test-Case "Retail مسموح — لا يرمي" {
    Assert-CashierInvoiceType "Retail"
}

Test-Case "Wholesale مرفوض fail-closed" {
    Assert-Throws { Assert-CashierInvoiceType "Wholesale" } "يجب رفض Wholesale"
}

Test-Case "WholesaleSyp مرفوض fail-closed" {
    Assert-Throws { Assert-CashierInvoiceType "WholesaleSyp" } "يجب رفض WholesaleSyp"
}

Test-Case "أي نوع غير معروف مرفوض أيضاً (قائمة سماح لا قائمة منع)" {
    Assert-Throws { Assert-CashierInvoiceType "AnythingElse" } "الحارس يجب أن يكون allow-list"
}

Test-Case "رسالة الرفض تذكر صراحةً أن الجملة خارج مسؤولية جسر الكاشير" {
    $message = ""
    try { Assert-CashierInvoiceType "Wholesale" } catch { $message = [string]$_.Exception.Message }
    Assert-True ($message -match "(?i)wholesale") "الرسالة يجب أن تذكر wholesale"
    Assert-True ($message -match "(?i)cashier|Retail") "الرسالة يجب أن توضّح أن الجسر للكاشير فقط"
}

Test-Case "GUID الكاشير مقبول على مستوى المرشّح" {
    Assert-CashierTypeGuid $script:RetailTypeGuid 1001
}

Test-Case "كلا GUID الجملة مرفوضان على مستوى المرشّح (لا يصلان إلى أمر الطباعة)" {
    foreach ($guid in $script:WholesaleTypeGuids) {
        Assert-Throws { Assert-CashierTypeGuid $guid 1001 } "يجب رفض GUID الجملة: $guid"
    }
}

Test-Case "الحارس يُستدعى في وضعَي PreviewInvoice/PrintInvoice قبل أي استعلام" {
    Assert-True ($bridgeSrc -match '(?s)if \(\$Mode -eq "PreviewInvoice" -or \$Mode -eq "PrintInvoice"\) \{\s*\r?\n\s*Assert-CashierInvoiceType \$InvoiceType') "يجب أن يكون الحارس أول سطر في فرع الطباعة/المعاينة اليدوية"
}

Test-Case "استدعاء الحارس يسبق Get-InvoiceTypeGuid وGet-PostedInvoiceByNumber في المصدر" {
    $guardIdx = $bridgeSrc.IndexOf("Assert-CashierInvoiceType `$InvoiceType")
    $typeIdx = $bridgeSrc.IndexOf("Get-InvoiceTypeGuid `$InvoiceType")
    $queryIdx = $bridgeSrc.IndexOf("Get-PostedInvoiceByNumber `$connection")
    Assert-True ($guardIdx -ge 0 -and $typeIdx -ge 0 -and $queryIdx -ge 0) "يجب وجود المواضع الثلاثة"
    Assert-True ($guardIdx -lt $typeIdx) "الحارس يجب أن يسبق تحويل النوع إلى GUID"
    Assert-True ($guardIdx -lt $queryIdx) "الحارس يجب أن يسبق الاستعلام"
}

Test-Case "حارس بدء التشغيل يرفض تسليح الطباعة مع إدراج أنواع الجملة" {
    Assert-True ($bridgeSrc -match '(?s)if \(\$IncludeWholesale -and \$ConfirmPhysicalPrint\) \{\s*\r?\n\s*throw') "يجب رفض -IncludeWholesale مع -ConfirmPhysicalPrint عند بدء التشغيل"
}

Test-Case "في حلقة Observe: فحص GUID الكاشير يسبق استيراد وحدة العرض وأمر الإرسال" {
    $assertIdx = $bridgeSrc.IndexOf("Assert-CashierTypeGuid (")
    $sendIdx = $bridgeSrc.IndexOf("Send-OzkReceiptToPrinter -Receipt `$receipt -LogoPath `$script:ReceiptLogoPath -PrinterName `$PrinterName -ConfirmPhysicalPrint)")
    Assert-True ($assertIdx -ge 0) "يجب وجود فحص GUID داخل حلقة الرصد"
    Assert-True ($sendIdx -ge 0) "يجب وجود أمر الإرسال داخل حلقة الرصد"
    Assert-True ($assertIdx -lt $sendIdx) "الفحص يجب أن يسبق الإرسال إلى الطابعة"
}

Test-Case "UI: قائمة الأنواع تحتوي الكاشير فقط" {
    $adds = [regex]::Matches($uiSrc, '\$typeBox\.Items\.Add\(')
    Assert-True ($adds.Count -eq 1) "يجب أن يبقى خيار واحد فقط، وُجد: $($adds.Count)"
}

Test-Case "UI: خريطة الأنواع لا تحوي إلا Retail" {
    Assert-True ($uiSrc -match '\$typeMap = @\{\s*\r?\n\s*"[^"]+" = "Retail"\s*\r?\n\s*\}') "خريطة الأنواع يجب أن تقتصر على Retail"
}

Test-Case "negative witness: لا يرد ذكر Wholesale إطلاقاً في مصدر الواجهة" {
    Assert-True ($uiSrc -notmatch 'Wholesale') "إعادة أي مسار جملة إلى الواجهة يجب أن تُفشل هذا الاختبار"
}

Test-Case "UI: حارس صريح يرفض بناء أمر لغير Retail حتى لو أُعيد خيار للقائمة" {
    Assert-True ($uiSrc -match '(?s)if \(\$type -ne "Retail"\) \{\s*\r?\n\s*throw') "الواجهة يجب أن ترفض أي نوع غير Retail قبل بناء أمر الجسر"
}

Write-Host "`n== P1-C: ارتفاع الإيصال ديناميكي بحدّ أمان صريح (بلا قصّ صامت) =="

Test-Case "لم يعد هناك ارتفاع لوحة ثابت 2600" {
    Assert-True ($rendererSrc -notmatch '\$canvasHeight = 2600') "الارتفاع الثابت يجب أن يكون قد أُزيل"
}

Test-Case "negative witness: لا يوجد أي [math]::Min يحدّ الارتفاع النهائي (نمط القصّ القديم)" {
    Assert-True ($rendererSrc -notmatch '\[math\]::Min\(') "إعادة نمط Min للقصّ يجب أن تُفشل هذا الاختبار"
}

Test-Case "حدّ الأمان معرّف صراحةً وأكبر من الارتفاع الثابت القديم" {
    Assert-True ($rendererSrc -match '\$script:ReceiptMaxHeight = (\d+)') "يجب تعريف حدّ أمان للارتفاع"
    $limit = [int]$Matches[1]
    Assert-True ($limit -gt 2600) "الحد يجب أن يتجاوز 2600 وإلا بقيت الفواتير الطويلة مرفوضة كما كانت مقصوصة"
    Assert-True ($limit -le 50000) "الحد يجب أن يبقى محدوداً فعلاً (لا تخصيص ذاكرة مفتوح)"
}

Test-Case "تجاوز حدّ الأمان يفشل صراحةً بـthrow لا بقصّ" {
    Assert-True ($rendererSrc -match '(?s)if \(\$requiredHeight -gt \$script:ReceiptMaxHeight\) \{\s*\r?\n\s*throw') "يجب رمي خطأ صريح عند التجاوز"
}

Test-Case "القياس والرسم يستدعيان دالة التخطيط نفسها (مصدر واحد للحساب)" {
    $calls = [regex]::Matches($rendererSrc, 'Invoke-OzkReceiptDrawing ')
    Assert-True ($calls.Count -eq 2) "يجب استدعاء دالة الرسم مرتين بالضبط (قياس ثم رسم)، وُجد: $($calls.Count)"
}

Test-Case "ReceiptWidth وReceiptDpi لم يتغيّرا (لا إعادة تصميم)" {
    Assert-True ($rendererSrc -match '\$script:ReceiptWidth = 576') "عرض الإيصال يجب أن يبقى 576"
    Assert-True ($rendererSrc -match '\$script:ReceiptDpi = 203') "دقة الإيصال يجب أن تبقى 203"
}

Write-Host "`n== P1-C: تصيير فعلي (يتطلب System.Drawing — Windows) =="

$script:DrawingAvailable = $false
try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $probe = New-Object Drawing.Bitmap(4, 4)
    $probe.Dispose()
    $script:DrawingAvailable = $true
} catch {
    $script:DrawingAvailable = $false
}

function New-TestReceipt([int]$LineCount, [string]$NamePattern = "مادة تجريبية") {
    $lines = New-Object System.Collections.Generic.List[object]
    for ($i = 1; $i -le $LineCount; $i++) {
        $lines.Add([pscustomobject]@{
            Name = ("{0} {1}" -f $NamePattern, $i)
            Quantity = 2
            UnitPrice = 1500
            Total = 3000
        })
    }
    return [pscustomobject]@{
        MerchantName = "مؤسسة عزّوز خلوف"
        Subtitle = "لتجارة التبغ"
        CommercialRegister = "12345"
        Phones = "011-1111111"
        CenterPhone = "0999999999"
        Address = "دمشق"
        Date = "2026-09-09"
        Time = "12:30"
        CustomerName = "زبون تجريبي"
        Description = "مبيعات مركز"
        Lines = $lines.ToArray()
        GrossTotal = 3000 * $LineCount
        Discount = 0
        NetTotal = 3000 * $LineCount
        Payment = 0
        BalanceFound = $false
        PreviousBalance = 0
        CurrentBalance = 0
        ItemCount = $LineCount
        TotalQuantity = 2 * $LineCount
        SaleDescription = "بيع نقدي"
    }
}

function Test-RenderCase([string]$Name, [scriptblock]$Body) {
    if (-not $script:DrawingAvailable) {
        Write-Host "  SKIP $Name (System.Drawing غير متاح على هذه المنصّة — يُشغَّل على Windows)"
        return
    }
    Test-Case $Name $Body
}

$logoPath = Join-Path (Join-Path $bridgeDir "assets") "ozk-receipt-horse-logo.png"

Test-RenderCase "فاتورة قصيرة (بند واحد) تُصيَّر بارتفاع موجب وأقل من الحد" {
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 1) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Width -eq 576) "العرض يجب أن يبقى 576"
        Assert-True ($bitmap.Height -gt 0) "الارتفاع يجب أن يكون موجباً"
        Assert-True ($bitmap.Height -lt 2600) "فاتورة ببند واحد يجب أن تكون أقصر من اللوحة الثابتة القديمة"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "فاتورة طبيعية (10 بنود) تُصيَّر ضمن حدود معقولة" {
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 10) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Height -gt 0) "الارتفاع يجب أن يكون موجباً"
        Assert-True ($bitmap.Height -lt 2600) "عشرة بنود يجب أن تبقى ضمن الارتفاع القديم"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "الارتفاع ينمو مع عدد البنود (ليس ثابتاً)" {
    $small = New-OzkReceiptBitmap -Receipt (New-TestReceipt 1) -LogoPath $logoPath
    $large = New-OzkReceiptBitmap -Receipt (New-TestReceipt 20) -LogoPath $logoPath
    try {
        Assert-True ($large.Height -gt $small.Height) "الارتفاع يجب أن يزيد بزيادة البنود"
    } finally { $small.Dispose(); $large.Dispose() }
}

Test-RenderCase "فاتورة 40 بنداً بأسماء طويلة تلتفّ: الارتفاع يتجاوز 2600 بلا قصّ" {
    $longName = "مادة ذات اسم طويل جداً يجبر السطر على الالتفاف أكثر من مرة داخل عمود الاسم"
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 40 $longName) -LogoPath $logoPath
    try {
        Assert-True ($bitmap.Height -gt 2600) "الحالة الطويلة يجب أن تتجاوز 2600 بكسل — كانت تُقصّ سابقاً"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "الإجماليات والتذييل موجودة داخل الناتج (آخر الإيصال مرسوم لا مقطوع)" {
    $longName = "مادة ذات اسم طويل جداً يجبر السطر على الالتفاف أكثر من مرة داخل عمود الاسم"
    $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt 40 $longName) -LogoPath $logoPath
    try {
        # التذييل ("شكراً لتعاملكم معنا") آخر ما يُرسم؛ وجود بكسلات غير بيضاء في
        # الشريط الأخير يثبت أن نهاية الإيصال داخل الصورة لا خارجها.
        $inkFound = $false
        for ($y = [math]::Max(0, $bitmap.Height - 120); $y -lt $bitmap.Height -and -not $inkFound; $y++) {
            for ($x = 0; $x -lt $bitmap.Width; $x += 4) {
                if ($bitmap.GetPixel($x, $y).R -lt 128) { $inkFound = $true; break }
            }
        }
        Assert-True $inkFound "يجب وجود محتوى مرسوم في نهاية الإيصال (التذييل/الإجماليات)"
    } finally { $bitmap.Dispose() }
}

Test-RenderCase "تجاوز حدّ الأمان ينتج خطأ صريح لا فاتورة مقصوصة" {
    $limit = 0
    Assert-True ($rendererSrc -match '\$script:ReceiptMaxHeight = (\d+)') "يجب قراءة الحد من المصدر"
    $limit = [int]$Matches[1]
    # كل بند ≥ 54 بكسل، فعدد يتجاوز الحد يقيناً مهما كان الحساب الدقيق للترويسة.
    $explodingCount = [int]([math]::Ceiling($limit / 54.0)) + 50
    $message = ""
    try {
        $bitmap = New-OzkReceiptBitmap -Receipt (New-TestReceipt $explodingCount) -LogoPath $logoPath
        $bitmap.Dispose()
        throw "ASSERT-NO-THROW"
    } catch {
        $message = [string]$_.Exception.Message
    }
    Assert-True ($message -ne "ASSERT-NO-THROW") "تجاوز الحد يجب أن يفشل صراحةً لا أن ينجح بقصّ"
    Assert-True ($message -match "(?i)safety limit|exceeds") "رسالة الخطأ يجب أن توضّح تجاوز حدّ الأمان: $message"
}

Write-Host "`n== P1-E: لا إعادة طباعة آلية بعد نجاح الإرسال وفشل حفظ الحالة =="

# تُستخرج دوال الحالة الثلاث من المصدر الفعلي وتُشغَّل بمعزل عن الحلقة الرئيسية
# (التي تحتوي اتصال SQL وحلقة لا نهائية)، فنختبر آلة الحالة الحقيقية لا نسخة منها.
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function New-EmptyState {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Write-BridgeState([string]`$Path, `$State) {")))
. ([scriptblock]::Create((Get-ExtractedFunctionText $bridgeSrc "function Read-BridgeState([string]`$Path) {")))

$script:StateRoot = Join-Path ([IO.Path]::GetTempPath()) ("ozk-bridge-state-" + [guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $script:StateRoot -Force)

function New-StatePath { return Join-Path $script:StateRoot ((([guid]::NewGuid()).ToString("N")) + "\state.json") }

# يحاكي تسلسل الحلقة الفعلي لفاتورة واحدة، ويسمح بحقن فشل في مرحلة محددة.
#   FailAt = "before-send"  → عطل قبل كتابة علامة قيد الإرسال (تصيير/استيراد فشل)
#   FailAt = "persist"      → الإرسال نجح ثم فشل حفظ النتيجة النهائية
function Invoke-PrintIteration([string]$StatePath, [string]$Guid, [string]$FailAt = "") {
    $state = Read-BridgeState $StatePath
    if ($state.seen.ContainsKey($Guid)) { return "skipped" }

    if ($FailAt -eq "before-send") { throw "render failed before any send" }

    # علامة قيد الإرسال — تُكتب قبل الإرسال مباشرةً
    $state.seen[$Guid] = [ordered]@{ status = "print_in_flight"; invoiceNumber = 1001; observedAt = (Get-Date).ToUniversalTime().ToString("o"); lineCount = 3 }
    Write-BridgeState $StatePath $state

    $script:SendCount++          # ← هنا يقع الإرسال الفيزيائي فعلياً

    $state.seen[$Guid] = [ordered]@{ status = "spooled"; invoiceNumber = 1001; observedAt = (Get-Date).ToUniversalTime().ToString("o"); lineCount = 3 }
    if ($FailAt -eq "persist") { return "spooled-persist-failed" }
    Write-BridgeState $StatePath $state
    return "spooled"
}

Test-Case "1) فشل قبل الإرسال: لا أثر على القرص، وإعادة المحاولة لاحقاً مسموحة" {
    $path = New-StatePath
    $guid = "aaaa-1111"
    $script:SendCount = 0
    Assert-Throws { Invoke-PrintIteration $path $guid "before-send" } "يجب أن يرمي قبل الإرسال"
    Assert-True ($script:SendCount -eq 0) "لا يجوز أن يكون الإرسال قد وقع"
    $reloaded = Read-BridgeState $path
    Assert-True (-not $reloaded.seen.ContainsKey($guid)) "لا يجوز ترك أثر يمنع إعادة المحاولة"
    $result = Invoke-PrintIteration $path $guid
    Assert-True ($result -eq "spooled") "إعادة المحاولة يجب أن تنجح"
    Assert-True ($script:SendCount -eq 1) "الطباعة تقع مرة واحدة عند إعادة المحاولة"
}

Test-Case "2) نجاح الإرسال + نجاح الحفظ: طباعة واحدة، والتشغيل التالي يتخطاها" {
    $path = New-StatePath
    $guid = "bbbb-2222"
    $script:SendCount = 0
    Assert-True ((Invoke-PrintIteration $path $guid) -eq "spooled") "يجب أن ينجح"
    Assert-True ((Invoke-PrintIteration $path $guid) -eq "skipped") "التشغيل التالي يجب أن يتخطاها"
    Assert-True ($script:SendCount -eq 1) "الإرسال مرة واحدة فقط، وقع: $($script:SendCount)"
    $reloaded = Read-BridgeState $path
    Assert-True ([string]$reloaded.seen[$guid].status -eq "spooled") "الحالة المحفوظة يجب أن تكون spooled"
}

Test-Case "3) نجاح الإرسال + فشل الحفظ: لا نسخة ثانية بعد إعادة التشغيل (الثابتة الأساسية)" {
    $path = New-StatePath
    $guid = "cccc-3333"
    $script:SendCount = 0
    Assert-True ((Invoke-PrintIteration $path $guid "persist") -eq "spooled-persist-failed") "يجب أن يمثّل فشل الحفظ بعد الإرسال"
    Assert-True ($script:SendCount -eq 1) "الإرسال وقع مرة"
    # إعادة تشغيل: تُقرأ الحالة من القرص من جديد
    $reloaded = Read-BridgeState $path
    Assert-True ($reloaded.seen.ContainsKey($guid)) "علامة ما قبل الإرسال يجب أن تكون محفوظة على القرص"
    Assert-True ([string]$reloaded.seen[$guid].status -eq "print_in_flight") "الحالة المحفوظة يجب أن تكون print_in_flight"
    Assert-True ((Invoke-PrintIteration $path $guid) -eq "skipped") "إعادة التشغيل يجب ألا تعيد الطباعة"
    Assert-True ($script:SendCount -eq 1) "لا يجوز تجاوز إرسال واحد، وقع: $($script:SendCount)"
}

Test-Case "3ب) تكرار إعادة التشغيل لا يراكم نسخاً (العطل المستمر لا يصير حلقة طباعة)" {
    $path = New-StatePath
    $guid = "dddd-4444"
    $script:SendCount = 0
    [void](Invoke-PrintIteration $path $guid "persist")
    for ($i = 0; $i -lt 5; $i++) { [void](Invoke-PrintIteration $path $guid) }
    Assert-True ($script:SendCount -eq 1) "خمس إعادات تشغيل يجب ألا تنتج إلا إرسالاً واحداً، وقع: $($script:SendCount)"
}

Test-Case "4) فشل الحفظ بعد الإرسال لا يُسقط الجسر (يُسجَّل ويُواصل الرصد)" {
    Assert-True ($bridgeSrc -match '(?s)try \{\s*\r?\n\s*Write-BridgeState \$StatePath \$state\s*\r?\n\s*\} catch \{\s*\r?\n\s*if \(\$stateStatus -ne "spooled"\) \{ throw \}') "فشل الحفظ بعد الإرسال يجب أن يُلتقط، وأي فشل آخر يُعاد رميه"
    Assert-True ($bridgeSrc -match 'Event = "state_persist_failed_after_spool"') "يجب تسجيل الحدث بوضوح لا ابتلاعه"
}

Test-Case "5) الفاتورة العالقة من تشغيل سابق تُعلَن عند الإقلاع (لا تُبتلع صامتة)" {
    Assert-True ($bridgeSrc -match 'Event = "print_in_flight_carried_over"') "يجب الإعلان عن أي فاتورة بقيت قيد الإرسال"
    Assert-True ($bridgeSrc -match 'Remedy = "operator decides; manual reprint available via -Mode PrintInvoice"') "يجب توضيح المخرج اليدوي للمشغّل"
}

Test-Case "الترتيب في المصدر: علامة قيد الإرسال تُحفظ على القرص قبل أمر الإرسال" {
    $markerIdx = $bridgeSrc.IndexOf('status = "print_in_flight"')
    $writeIdx = $bridgeSrc.IndexOf("Write-BridgeState `$StatePath `$state", $markerIdx)
    $sendIdx = $bridgeSrc.IndexOf("Send-OzkReceiptToPrinter -Receipt `$receipt", $markerIdx)
    Assert-True ($markerIdx -ge 0 -and $writeIdx -ge 0 -and $sendIdx -ge 0) "يجب وجود المواضع الثلاثة"
    Assert-True ($writeIdx -lt $sendIdx) "الحفظ على القرص يجب أن يسبق الإرسال إلى الطابعة"
}

Test-Case "negative witness: بلا علامة ما قبل الإرسال تعود إعادة الطباعة بعد فشل الحفظ" {
    # محاكاة السلوك القديم: لا كتابة قبل الإرسال إطلاقاً
    $path = New-StatePath
    $guid = "eeee-5555"
    $sends = 0
    $state = Read-BridgeState $path
    if (-not $state.seen.ContainsKey($guid)) { $sends++ }   # الإرسال الأول
    # فشل الحفظ هنا: لا شيء يُكتب على القرص إطلاقاً
    $reloaded = Read-BridgeState $path
    if (-not $reloaded.seen.ContainsKey($guid)) { $sends++ }  # إعادة التشغيل تطبع ثانيةً
    Assert-True ($sends -eq 2) "السلوك القديم يجب أن ينتج نسختين — وهذا ما يمنعه الإصلاح"
}

Write-Host "`n$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
