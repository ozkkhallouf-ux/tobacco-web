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

Write-Host "`n$($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
