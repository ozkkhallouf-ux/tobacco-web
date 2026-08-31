#Requires -Version 5.1
# ============================================================
# Test-KhalilAuditPs51Compat.ps1
#
# اختبار انحدار لعطل إنتاجي حقيقي (2026-08-31، من 00:14 حتى 05:10 محلي):
# مهمة "TOBACCO Khalil Audit Sync" تشغّل push-khalil-audit-log.ps1 عبر
# powershell.exe، أي Windows PowerShell 5.1. كان موضعا استدعاء
# Set-OverlapFloor يمرّران الوسيط الثاني بالشكل:
#
#     Set-OverlapFloor $t ([Nullable[guid]](if ($g) { [guid]$g } else { $null })) $c
#
# واستعمال if كتعبير داخل أقواس ميزة PowerShell 7. في 5.1 يُحلَّل الملف
# بلا أي خطأ (Parser::ParseFile يعطي صفر أخطاء)، ثم وقت التنفيذ يُحَلّ if
# كاسم أمر فيُرمى CommandNotFoundException — فيسقط السكربت قبل
# Send-Heartbeat، ويتجمّد النبض، ولا يتقدّم overlap floor أبداً.
#
# ولهذا الفحص الساكن وحده لا يكفي: هذا الاختبار ينفّذ فعلياً أسطر
# استدعاء Set-OverlapFloor المستخرَجة من السكربت الإنتاجي نفسه، تحت
# Windows PowerShell 5.1 حصراً، مع دالة بديلة تلتقط الوسائط بلا أي شبكة.
#
# التشغيل:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-KhalilAuditPs51Compat.ps1
# ============================================================
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ------------------------------------------------------------
# 0) لا معنى لنجاح هذا الاختبار على PowerShell 7 — الصيغة المعطوبة تعمل
#    هناك بلا مشكلة. يجب أن يعمل على 5.1 حصراً وإلا فهو طمأنينة كاذبة.
# ------------------------------------------------------------
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSEdition -ne 'Desktop') {
    Write-Host "FAIL: must run under Windows PowerShell 5.1 (Desktop). Got $($PSVersionTable.PSVersion) / $($PSVersionTable.PSEdition)." -ForegroundColor Red
    Write-Host "      Use powershell.exe, not pwsh.exe - passing on 7 proves nothing." -ForegroundColor Yellow
    exit 1
}

$repoRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot 'tools\push-khalil-audit-log.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    Write-Host "FAIL: cannot find $scriptPath" -ForegroundColor Red
    exit 1
}
$lines = Get-Content -LiteralPath $scriptPath -Encoding UTF8

$failures = New-Object System.Collections.ArrayList
function Add-Failure([string]$m) { [void]$failures.Add($m); Write-Host "  FAIL: $m" -ForegroundColor Red }
function Add-Pass([string]$m) { Write-Host "  ok  : $m" -ForegroundColor Green }

# ------------------------------------------------------------
# 1) حارس ساكن: لا if/switch/foreach/while كتعبير داخل أقواس وسيط في أي
#    موضع من السكربت الإنتاجي (أسطر التعليق مستثناة).
# ------------------------------------------------------------
Write-Host "1) static guard - no statement-as-expression inside argument parentheses"
# (?<![@$]) يستثني @( و $( لأن كليهما يقبل جملة كاملة داخله في 5.1 بشكل
# مشروع تماماً؛ المرفوض هو قوس التجميع العادي وحده — بما في ذلك الحالة
# التي يسبق فيها cast قوسَ الجملة، مثل ([Nullable[guid]](if ...)) حيث
# يكون القوس الداخلي مسبوقاً بـ ] لا بـ @ أو $.
$badPattern = '(?<![@$])\(\s*(?:if|switch|foreach|while)\s*\('
$staticHits = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    $text = $lines[$i]
    if ($text -match '^\s*#') { continue }
    if ($text -match $badPattern) { $staticHits += ("line " + ($i + 1) + ": " + $text.Trim()) }
}
if ($staticHits.Count -gt 0) {
    foreach ($h in $staticHits) { Add-Failure "statement-as-expression in argument position - $h" }
} else {
    Add-Pass "no statement-as-expression found in argument position"
}

# ------------------------------------------------------------
# 2) الاختبار الحيّ: استخرج من الملف الإنتاجي كل أسطر استدعاء
#    Set-OverlapFloor وأي إسناد يسبقها ويُغذّيها، ثم نفّذها فعلياً.
# ------------------------------------------------------------
Write-Host "2) live execution of the real Set-OverlapFloor call sites under PS 5.1"
$callLines = @()
for ($i = 0; $i -lt $lines.Count; $i++) {
    $text = $lines[$i]
    if ($text -match '^\s*#') { continue }
    if ($text -match '^\s*\$cursorFloorGuid\s*=' -or $text -match '^\s*Set-OverlapFloor\s') {
        $callLines += [pscustomobject]@{ Number = $i + 1; Text = $text.Trim() }
    }
}
$invocationCount = @($callLines | Where-Object { $_.Text -match '^Set-OverlapFloor\s' }).Count
if ($invocationCount -lt 2) {
    Add-Failure "expected at least 2 Set-OverlapFloor call sites in the production script, found $invocationCount"
} else {
    Add-Pass "found $invocationCount Set-OverlapFloor call site(s) to execute"
}

# دالة بديلة بنفس توقيع الدالة الحقيقية — تلتقط الوسائط ولا تلمس الشبكة.
$script:captured = New-Object System.Collections.ArrayList
function Set-OverlapFloor([datetime]$FloorTime, [Nullable[guid]]$FloorGuid = $null, [Nullable[datetime]]$DmvCap) {
    [void]$script:captured.Add([pscustomobject]@{ FloorTime = $FloorTime; FloorGuid = $FloorGuid; DmvCap = $DmvCap })
}

$knownGuid = 'b0e842c3-ff3f-461d-9cef-78bd86d31f3c'
$scenarios = @(
    [pscustomobject]@{ Name = 'cursorGuid present'; CursorGuid = $knownGuid; ExpectGuid = $knownGuid },
    [pscustomobject]@{ Name = 'cursorGuid null';    CursorGuid = $null;      ExpectGuid = $null }
)

foreach ($sc in $scenarios) {
    $cursorTime        = [datetime]'2026-08-30T22:23:31.923'
    $dmvCapForThisRun  = [datetime]'2026-08-30T22:20:00.000'
    $overlapMaxLogTime = [datetime]'2026-08-30T22:22:00.000'
    $overlapMaxGuid    = $knownGuid
    $cursorGuid        = $sc.CursorGuid
    $script:captured.Clear()
    $before = $failures.Count

    foreach ($cl in $callLines) {
        try {
            Invoke-Expression $cl.Text
        } catch {
            Add-Failure ("[" + $sc.Name + "] line " + $cl.Number + " threw " + $_.Exception.GetType().Name + ": " + $_.Exception.Message)
        }
    }

    if ($script:captured.Count -ne $invocationCount) {
        Add-Failure ("[" + $sc.Name + "] expected $invocationCount captured call(s), got " + $script:captured.Count)
        continue
    }

    # لا يكفي ألا ترمي: الاستدعاءات المعتمدة على cursorGuid يجب أن تمرّر
    # الـGUID المتوقّع (أو null) وأن تُمرّر DmvCap كما هي.
    $cursorDriven = @($script:captured | Where-Object { $_.FloorTime -eq $cursorTime })
    if ($cursorDriven.Count -lt 1) {
        Add-Failure ("[" + $sc.Name + "] no call carried the cursor timestamp")
        continue
    }
    foreach ($c in $cursorDriven) {
        $got = if ($null -eq $c.FloorGuid) { $null } else { $c.FloorGuid.ToString() }
        if ($got -ne $sc.ExpectGuid) {
            Add-Failure ("[" + $sc.Name + "] expected FloorGuid '" + $sc.ExpectGuid + "', got '" + $got + "'")
        }
        if ($c.DmvCap -ne $dmvCapForThisRun) {
            Add-Failure ("[" + $sc.Name + "] DmvCap was not forwarded (got '" + $c.DmvCap + "')")
        }
    }
    if ($failures.Count -eq $before) {
        Add-Pass ("[" + $sc.Name + "] all $invocationCount call site(s) executed; FloorGuid + DmvCap forwarded correctly")
    }
}

# ------------------------------------------------------------
# 3) اختبار سلبي: أعِد حقن الصيغة المعطوبة وتأكّد أن الاختبار يسقط فعلاً
#    عندها. بدونه قد يبقى الاختبار أخضر دائماً بلا أي معنى.
# ------------------------------------------------------------
Write-Host "3) negative self-test - the broken PS7-only form must still fail here"
$brokenLine = 'Set-OverlapFloor $cursorTime ([Nullable[guid]](if ($cursorGuid) { [guid]$cursorGuid } else { $null })) $dmvCapForThisRun'
$cursorTime       = [datetime]'2026-08-30T22:23:31.923'
$dmvCapForThisRun = [datetime]'2026-08-30T22:20:00.000'
$cursorGuid       = $knownGuid
$negativeCaught   = $false
try {
    Invoke-Expression $brokenLine
} catch [System.Management.Automation.CommandNotFoundException] {
    $negativeCaught = $true
} catch {
    $negativeCaught = $false
}
if ($negativeCaught) {
    Add-Pass "the pre-fix form still throws CommandNotFoundException on 5.1 - this test has teeth"
} else {
    Add-Failure "the pre-fix broken form did NOT fail - this harness would not catch a regression"
}

# ------------------------------------------------------------
Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host ("RESULT: FAILED - " + $failures.Count + " problem(s) on PowerShell " + $PSVersionTable.PSVersion) -ForegroundColor Red
    exit 1
}
Write-Host ("RESULT: PASSED on Windows PowerShell " + $PSVersionTable.PSVersion) -ForegroundColor Green
exit 0
