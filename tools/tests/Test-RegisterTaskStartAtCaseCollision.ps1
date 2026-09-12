#Requires -Version 5.1
# ============================================================
# Test-RegisterTaskStartAtCaseCollision.ps1
#
# اختبار انحدار لعطل HOST verification حقيقي على جهاز LOQ (2026-09-06):
#
#   .\tools\register-purchase-item-snapshot-task.ps1 -ReplaceExisting
#
# فشل بالخطأ:
#   The variable cannot be validated because the value 09/06/2026 00:07:00
#   is not a valid value for the StartAt variable.
#
# السبب الجذري: أسماء المتغيرات في PowerShell غير حساسة لحالة الأحرف.
# البارامتر [ValidatePattern('...')][string]$StartAt والمتغير المحلي
# $startAt هما نفس المتغير فعلياً. حساب موعد أول تشغيل كان يُسنَد إلى
# $startAt (= $StartAt)، فيعاد تطبيق ValidatePattern الخاص بالسلسلة النصية
# على قيمة [datetime] الجديدة فيفشل بخطأ ValidationMetadataException لا
# علاقة له بالسبب الحقيقي. الإصلاح: تسمية المتغير المحلي $firstRunAt.
#
# الفحص الساكن وحده لا يكفي هنا (regex لا يفرّق بين $startAt و$StartAt لأن
# PowerShell نفسه لا يفرّق). هذا الاختبار يستخرج فعلياً بارامترات وأسطر بناء
# الـtrigger من كل سكربت تسجيل إنتاجي وينفّذها تحت PowerShell حقيقي، مع
# اختبار سلبي يثبت أن الشكل المعطوب (قبل الإصلاح) يسقط هنا فعلاً.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-RegisterTaskStartAtCaseCollision.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }

$targets = @(
    [pscustomobject]@{ Label = 'purchase item snapshot'; Path = Join-Path $repoRoot 'tools\register-purchase-item-snapshot-task.ps1' },
    [pscustomobject]@{ Label = 'supplier obligations';   Path = Join-Path $repoRoot 'tools\register-supplier-obligations-task.ps1' }
)

foreach ($target in $targets) {
    Write-Host "== $($target.Label): $($target.Path)"
    if (-not (Test-Path -LiteralPath $target.Path)) {
        Add-Failure "cannot find $($target.Path)"
        continue
    }
    $text = Get-Content -LiteralPath $target.Path -Raw -Encoding UTF8

    # ------------------------------------------------------------
    # 1) استخرج البارامترات الحقيقية (IntervalHours الافتراضي وValidatePattern
    #    الخاص بـStartAt والقيمة الافتراضية) من الملف الإنتاجي نفسه، بلا
    #    كتابة يدوية موازية قد تنحرف عن الأصل.
    # ------------------------------------------------------------
    $intervalMatch = [regex]::Match($text, '\[ValidateRange\(1,\s*24\)\]\[int\]\$IntervalHours\s*=\s*(\d+)')
    $patternMatch  = [regex]::Match($text, '\[ValidatePattern\(''([^'']+)''\)\]\[string\]\$StartAt\s*=\s*"([0-9:]+)"')
    if (-not $intervalMatch.Success -or -not $patternMatch.Success) {
        Add-Failure "could not extract StartAt/IntervalHours parameter declaration from production script"
        continue
    }
    $defaultIntervalHours = [int]$intervalMatch.Groups[1].Value
    $validatePattern      = $patternMatch.Groups[1].Value
    $defaultStartAt       = $patternMatch.Groups[2].Value

    # ------------------------------------------------------------
    # 2) استخرج أسطر بناء الـtrigger فعلياً - من حساب موعد أول تشغيل حتى
    #    تحديد مدة التكرار - كما هي حرفياً من السكربت الإنتاجي.
    # ------------------------------------------------------------
    $blockMatch = [regex]::Match(
        $text,
        '(?ms)^\$firstRunAt\s*=.*?\$trigger\.Repetition\.Duration\s*=\s*""\s*$'
    )
    if (-not $blockMatch.Success) {
        Add-Failure "could not locate the trigger-build block ($firstRunAt ... Repetition.Duration) in production script - has it regressed to the old \$startAt name?"
        continue
    }
    $fixedBlock = $blockMatch.Value

    # ------------------------------------------------------------
    # 3) نفّذ فعلياً: دالة بنفس شكل البارامترات الحقيقي (ValidatePattern +
    #    ValidateRange مستخرَجان من الملف)، تُشغِّل داخلها كتلة بناء الـtrigger
    #    المستخرَجة حرفياً من الإنتاج.
    # ------------------------------------------------------------
    $funcName = "Test-TriggerBuild_$([guid]::NewGuid().ToString('N'))"
    $funcSource = @"
function $funcName {
    param(
        [ValidateRange(1, 24)][int]`$IntervalHours = $defaultIntervalHours,
        [ValidatePattern('$validatePattern')][string]`$StartAt = "$defaultStartAt",
        [Parameter(Mandatory)][string]`$BlockSource
    )
    Invoke-Expression `$BlockSource
    return `$trigger
}
"@
    Invoke-Expression $funcSource

    try {
        $trigger = & $funcName -IntervalHours $defaultIntervalHours -StartAt $defaultStartAt -BlockSource $fixedBlock
        if ($null -eq $trigger -or $null -eq $trigger.Repetition -or $null -eq $trigger.Repetition.Interval) {
            Add-Failure "[$($target.Label)] trigger built but Repetition.Interval is missing"
        } else {
            Add-Pass "[$($target.Label)] fixed trigger-build block executed with default StartAt/IntervalHours without ValidatePattern failure"
        }
    } catch {
        Add-Failure "[$($target.Label)] fixed trigger-build block threw $($_.Exception.GetType().Name): $($_.Exception.Message)"
    } finally {
        Remove-Item "function:\$funcName" -ErrorAction SilentlyContinue
    }

    # ------------------------------------------------------------
    # 4) اختبار سلبي: أعِد حقن الشكل المعطوب (\$startAt بدل \$firstRunAt -
    #    نفس الاسم فعلياً بحكم عدم حساسية PowerShell لحالة الأحرف مع
    #    \$StartAt) وتأكّد أن نفس الآلية تسقط بخطأ ValidationMetadataException
    #    - بدون هذا لا معنى لنجاح الفحص أعلاه.
    # ------------------------------------------------------------
    $buggyBlock = $fixedBlock -replace '\$firstRunAt', '$startAt'
    if ($buggyBlock -eq $fixedBlock) {
        Add-Failure "[$($target.Label)] negative self-test setup failed - no \$firstRunAt occurrence to rename back to \$startAt"
        continue
    }
    $funcName2 = "Test-TriggerBuild_$([guid]::NewGuid().ToString('N'))"
    $funcSource2 = @"
function $funcName2 {
    param(
        [ValidateRange(1, 24)][int]`$IntervalHours = $defaultIntervalHours,
        [ValidatePattern('$validatePattern')][string]`$StartAt = "$defaultStartAt",
        [Parameter(Mandatory)][string]`$BlockSource
    )
    Invoke-Expression `$BlockSource
    return `$trigger
}
"@
    Invoke-Expression $funcSource2
    $negativeCaught = $false
    try {
        & $funcName2 -IntervalHours $defaultIntervalHours -StartAt $defaultStartAt -BlockSource $buggyBlock | Out-Null
    } catch [System.Management.Automation.ValidationMetadataException] {
        $negativeCaught = $true
    } catch {
        # أي استثناء آخر لا يثبت أن الاختبار يمسك السبب الجذري الصحيح
        $negativeCaught = $false
    } finally {
        Remove-Item "function:\$funcName2" -ErrorAction SilentlyContinue
    }
    if ($negativeCaught) {
        Add-Pass "[$($target.Label)] pre-fix `$startAt/`$StartAt collision still throws ValidationMetadataException here - this test has teeth"
    } else {
        Add-Failure "[$($target.Label)] the pre-fix `$startAt collision did NOT reproduce ValidationMetadataException - this harness would not catch the regression"
    }
}

# ------------------------------------------------------------
Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host ("RESULT: FAILED - " + $failures.Count + " problem(s)") -ForegroundColor Red
    exit 1
}
Write-Host "RESULT: PASSED" -ForegroundColor Green
exit 0
