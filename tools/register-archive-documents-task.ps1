# ============================================================
# register-archive-documents-task.ps1
# يسجّل مهمة مجدولة تشغّل archive-documents.ps1 كل 5 دقائق
# (أرشفة + طباعة تلقائية للوصولات والفواتير)
#
# المهمة تعمل كمستخدم LOQ (Password logon) لا كـ SYSTEM، كي تستطيع:
#   - الوصول للشبكة (Supabase + GitHub Pages)
#   - الوصول لسطح المكتب وملف .env
#   - الطباعة على الطابعات المحلية (XPRINTER, Canon)
#
# شغّله كمسؤول Administrator على اللابتوب الذي يحوي ملف tools\.env
# ============================================================
param(
    [int]$IntervalMinutes = 5,
    [string]$RequiredUserId = "OZK2026\LOQ"
)

$taskName  = "TOBACCO Documents Archive"
$scriptPath = "$PSScriptRoot\archive-documents.ps1"
$repoRoot  = Split-Path -Parent $PSScriptRoot

# التحقق من وجود المهمة مسبقاً
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    $existing = ($existingTask.Principal.UserId)
    Write-Host "مهمة موجودة مسبقاً ($existing) — ستُستبدل." -ForegroundColor Yellow
}

# طلب كلمة مرور المستخدم بشكل آمن (لا تُخزَّن في الكود أو الملفات)
$securePassword = Read-Host "أدخل كلمة مرور $RequiredUserId" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword   = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)

$action = New-ScheduledTaskAction `
    -Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -Once -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit    (New-TimeSpan -Minutes 15) `
    -RestartCount          2 `
    -RestartInterval       (New-TimeSpan -Minutes 3) `
    -MultipleInstances     IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName  $taskName `
    -Action    $action `
    -Trigger   $trigger `
    -Settings  $settings `
    -User      $RequiredUserId `
    -Password  $plainPassword `
    -RunLevel  Highest `
    -Force | Out-Null

# تنظيف كلمة المرور من الذاكرة فوراً
$plainPassword = $null

Write-Host "تم تسجيل '$taskName' كل $IntervalMinutes دقيقة (مستخدم: $RequiredUserId) ✓" -ForegroundColor Green

# تشغيل فوري أول مرة
Start-ScheduledTask -TaskName $taskName
Write-Host "بدأت الأرشفة الأولى الآن — راقب السجل: tools\logs\archive-documents.log" -ForegroundColor Cyan
