# تنظيف منفذ الالتقاط المؤقت (Remove-OzkCapturePort) — Windows PowerShell 5.1 وPowerShell 7، بلا Spooler ولا طابعات.
#
# في التقاط OZKUSER (2026-11-12 17:21 UTC) رُفض حذف المنفذ مباشرة بعد حذف الطابور ("port in use") وأُخفي الخطأ.
# الاعتماديات هنا وهمية تحاكي: تأخّر تحرير المنفذ، فشلاً دائماً، طابوراً ما زال يستعمله، حذفاً يدّعي النجاح
# والمنفذ باقٍ، ومنافذ ممنوعة (USB003، منفذ الكاشير، خارج مجلد الالتقاط، مراقب غير محلي). يثبت:
#   - لا حذف إطلاقاً لمنفذ ممنوع (الحراسة قبل أي محاولة).
#   - لا حذف لمنفذ يستعمله طابور؛ تُنتظر المهلة.
#   - المحاولات محدودة، وكل خطأ يُعاد (لا إخفاء)، والنجاح فقط حين يختفي المنفذ فعلاً.
#   - سكربت الالتقاط يستعمل هذه الدالة ويُظهر FAIL، ولا SilentlyContinue على أي حذف.

$ErrorActionPreference = "Stop"
Import-Module (Join-Path (Join-Path $PSScriptRoot "lib") "OzkDriverCapture.psm1") -Force -DisableNameChecking

$script:pass = 0
$script:fail = 0
function Assert($Name, [bool]$Condition) {
    if ($Condition) { $script:pass++; Write-Host "PASS $Name" }
    else { $script:fail++; Write-Host "FAIL $Name" -ForegroundColor Red }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("ozk-capture-cleanup-" + [guid]::NewGuid().ToString("N"))
$port = Join-Path $root "capture.prn"

# Spooler وهمي: المنفذ موجود، يستعمله طابور لعدد من الفحوص، والحذف يُرفض لعدد من المرات.
function New-Spooler([int]$BusyChecks = 0, [int]$RejectRemovals = 0, [bool]$SilentNoop = $false, [string]$Monitor = "Local Monitor", [bool]$Exists = $true) {
    $state = [pscustomobject]@{ Exists = $Exists; BusyChecks = $BusyChecks; RejectRemovals = $RejectRemovals; SilentNoop = $SilentNoop; Monitor = $Monitor
        RemoveCalls = 0; UserChecks = 0; Sleeps = New-Object System.Collections.Generic.List[int]; Removed = New-Object System.Collections.Generic.List[string] }
    $state | Add-Member -MemberType NoteProperty -Name GetPort -Value ({ param($n) if ($state.Exists) { [pscustomobject]@{ Name = $n; PortMonitor = $state.Monitor } } else { $null } }.GetNewClosure())
    $state | Add-Member -MemberType NoteProperty -Name GetUsers -Value ({ param($n) $state.UserChecks++; if ($state.BusyChecks -gt 0) { $state.BusyChecks--; @("OZK-Capture-DriverPath (FILE)") } else { @() } }.GetNewClosure())
    $state | Add-Member -MemberType NoteProperty -Name Remove -Value ({ param($n) $state.RemoveCalls++; $state.Removed.Add($n)
            if ($state.RejectRemovals -gt 0) { $state.RejectRemovals--; throw (New-Object System.InvalidOperationException "The specified port is in use by one or more printers.") }
            if (-not $state.SilentNoop) { $state.Exists = $false } }.GetNewClosure())
    $state | Add-Member -MemberType NoteProperty -Name Sleep -Value ({ param($s) $state.Sleeps.Add($s) }.GetNewClosure())
    return $state
}
function Invoke-Cleanup($Spooler, [string]$Name = $port, [string[]]$Protected = @("USB003"), [int]$Max = 6, [int]$Delay = 5) {
    return (Remove-OzkCapturePort -PortName $Name -CaptureRoot $root -ProtectedPorts $Protected -MaxAttempts $Max -DelaySeconds $Delay `
        -GetPort $Spooler.GetPort -GetPortUsers $Spooler.GetUsers -RemovePort $Spooler.Remove -Sleep $Spooler.Sleep)
}

# ── النجاح والتأخير ────────────────────────────────────────────────────────────
$s = New-Spooler
$r = Invoke-Cleanup $s
Assert "يُحذف من المحاولة الأولى بلا انتظار" ($r.Removed -and $r.Attempts -eq 1 -and $s.RemoveCalls -eq 1 -and $s.Sleeps.Count -eq 0 -and $r.Errors.Count -eq 0)
$s = New-Spooler -RejectRemovals 2
$r = Invoke-Cleanup $s
Assert "Spooler لم يحرّر المنفذ مرتين ثم حرّره ⇒ يُحذف في الثالثة، وانتظاران" ($r.Removed -and $r.Attempts -eq 3 -and $s.RemoveCalls -eq 3 -and $s.Sleeps.Count -eq 2 -and ($s.Sleeps -join ",") -eq "5,5")
Assert "خطأ «in use» في المحاولتين يُعاد ولا يُخفى" ($r.Errors.Count -eq 2 -and $r.Errors[0] -match "attempt 1: The specified port is in use" -and $r.Errors[1] -match "attempt 2:")
$s = New-Spooler -BusyChecks 2
$r = Invoke-Cleanup $s
Assert "طابور ما زال يستعمل المنفذ ⇒ لا حذف حتى يتحرر، ثم يُحذف" ($r.Removed -and $r.Attempts -eq 3 -and $s.RemoveCalls -eq 1 -and $r.Errors[0] -match "still used by queue")
$s = New-Spooler -Exists $false
$r = Invoke-Cleanup $s
Assert "المنفذ غير موجود أصلاً ⇒ ناجح بلا أي حذف" ($r.Removed -and $s.RemoveCalls -eq 0 -and $r.Attempts -eq 0)

# ── الفشل ظاهر ومحدود ──────────────────────────────────────────────────────────
$s = New-Spooler -RejectRemovals 100
$r = Invoke-Cleanup $s -Max 4 -Delay 3
Assert "رفض دائم ⇒ Removed=false بعد 4 محاولات بالضبط، و3 انتظارات (لا انتظار بعد الأخيرة)" (-not $r.Removed -and $r.Attempts -eq 4 -and $s.RemoveCalls -eq 4 -and ($s.Sleeps -join ",") -eq "3,3,3")
Assert "رفض دائم ⇒ 4 أخطاء معادة بنصّها" ($r.Errors.Count -eq 4 -and @($r.Errors | Where-Object { $_ -match "in use" }).Count -eq 4)
$s = New-Spooler -BusyChecks 100
$r = Invoke-Cleanup $s -Max 3
Assert "طابور يستعمله دائماً ⇒ لا محاولة حذف واحدة، وفشل ظاهر" (-not $r.Removed -and $s.RemoveCalls -eq 0 -and $r.Attempts -eq 3 -and $r.Errors.Count -eq 3)
$s = New-Spooler -SilentNoop $true
$r = Invoke-Cleanup $s -Max 2
Assert "حذف يدّعي النجاح والمنفذ باقٍ ⇒ ليس نجاحاً، ويُسجَّل" (-not $r.Removed -and $s.RemoveCalls -eq 2 -and $r.Errors[0] -match "still present")
Assert "عدد المحاولات خارج 1–20 مرفوض" ($(try { Invoke-Cleanup (New-Spooler) -Max 0; $false } catch { $true }) -and $(try { Invoke-Cleanup (New-Spooler) -Max 21; $false } catch { $true }))

# ── منافذ ممنوعة: لا محاولة حذف إطلاقاً ──────────────────────────────────────────
foreach ($case in @(
        @{ Name = "USB003"; Why = "USB003" },
        @{ Name = "USB001"; Why = "منفذ USB آخر" },
        @{ Name = "LPT1:"; Why = "منفذ فعلي" },
        @{ Name = "PORTPROMPT:"; Why = "منفذ نظام" },
        @{ Name = (Join-Path ([IO.Path]::GetTempPath()) "elsewhere.prn"); Why = "ملف خارج مجلد الالتقاط" },
        @{ Name = (Join-Path $root "capture.txt"); Why = "ليس .prn" },
        @{ Name = (Join-Path (Join-Path $root "..") "escape.prn"); Why = "خروج بـ.." })) {
    $s = New-Spooler
    $r = Invoke-Cleanup $s -Name $case.Name
    Assert "ممنوع ($($case.Why)) ⇒ رفض بلا حذف ولا فحص ($($r.Refused))" (-not $r.Removed -and $r.Refused -and $s.RemoveCalls -eq 0 -and $s.UserChecks -eq 0)
}
$s = New-Spooler
$r = Invoke-Cleanup $s -Protected @($port)
Assert "منفذ مسجّل لطابور الكاشير (ولو داخل المجلد) ⇒ رفض بلا حذف" (-not $r.Removed -and $r.Refused -match "protected" -and $s.RemoveCalls -eq 0)
$s = New-Spooler
$r = Invoke-Cleanup $s -Name "usb003" -Protected @()
Assert "USB003 محمي دائماً حتى بلا قائمة حماية وبأي حالة أحرف" (-not $r.Removed -and $r.Refused -and $s.RemoveCalls -eq 0)
$s = New-Spooler -Monitor "USB Monitor"
$r = Invoke-Cleanup $s
Assert "مراقب غير Local Monitor ⇒ رفض بلا حذف" (-not $r.Removed -and $r.Refused -match "monitor" -and $s.RemoveCalls -eq 0)
$s = New-Spooler
[void](Invoke-Cleanup $s)
Assert "الاسم المحذوف هو منفذ الالتقاط وحده" (($s.Removed | Select-Object -Unique) -join "|" -eq $port)

# ── سكربت الالتقاط يستعمل الدالة ولا يخفي أخطاء الحذف ──────────────────────────────
$capture = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "Test-CashierReprintDriverCapture.ps1"))
Assert "سكربت الالتقاط: المنفذ عبر Remove-OzkCapturePort مع حماية منفذ الكاشير" ($capture -match 'Remove-OzkCapturePort -PortName \$capPort -CaptureRoot \$OutDir -ProtectedPorts @\(\$cashierPort\)')
Assert "سكربت الالتقاط: لا Remove-PrinterPort مباشر ولا حذف بـSilentlyContinue" ($capture -notmatch 'Remove-PrinterPort' -and $capture -notmatch 'Remove-Printer[^\n]*SilentlyContinue')
Assert "سكربت الالتقاط: FAIL صريح لكل من الطابور والمنفذ" ($capture -match 'Assert "حُذف الطابور المؤقت' -and $capture -match 'Assert \("حُذف المنفذ المؤقت')
Assert "سكربت الالتقاط: المنفذ يُنظَّف حتى لو فشل إنشاء الطابور" ($capture -match '\$portCreated = \$true' -and $capture -match 'if \(\$portCreated\)')

Write-Host ""
Write-Host "$($script:pass) passed, $($script:fail) failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
