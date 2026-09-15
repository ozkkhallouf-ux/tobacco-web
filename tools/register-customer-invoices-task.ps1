# ============================================================
# register-customer-invoices-task.ps1
# يسجّل مهمة مجدولة ترفع فواتير الزبائن كل ربع ساعة إلى Supabase
# (نفس آلية حركات الزبائن — ليظهر "عرض فواتير الزبون" في الموقع)
# شغّله كمسؤول Administrator على اللابتوب الذي يحوي ملف tools\.env وقاعدة الأمين
# ============================================================
param(
    # كان 60. تفاصيل الفواتير كانت تتأخّر ساعةً كاملة خلف دفتر الحساب (يُرفع كل
    # دقيقة)، فتظهر الفاتورة الجديدة كحركة بلا تفاصيل ويفشل تصديرها PDF.
    [int]$IntervalMinutes = 15
)

$taskName = "TOBACCO Customer Invoices Push"
$scriptPath = "$PSScriptRoot\push-customer-invoices.ps1"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -Once -At (Get-Date)

# -StartWhenAvailable: بدونه لا يعوّض Windows أي تشغيل فات (الجهاز نائم أو مطفأ)،
# فيبقى التقرير على آخر نسخة قبل الإطفاء حتى الموعد التالي. قياس 2026-09-05 على
# بيانات الإنتاج: 7 رفعات فقط خلال 24 ساعة بمتوسط فجوة 235 دقيقة رغم جدولة الساعة.
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 3) `
    -StartWhenAvailable

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Force

Write-Host "تم تسجيل المهمة المجدولة: '$taskName' كل $IntervalMinutes دقيقة ✓" -ForegroundColor Green

# تشغيل فوري أول مرة
Start-ScheduledTask -TaskName $taskName
Write-Host "تم تشغيل الرفعة الأولى الآن — راقب السجل: tools\logs\customer-invoices-push.log" -ForegroundColor Cyan
