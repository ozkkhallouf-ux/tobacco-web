# ============================================================
# register-item-numbers-task.ps1
# يسجّل مهمة Windows مجدولة تُشغّل pull-item-numbers.ps1: يملأ/يحدّث
# item_number وitem_code وitem_guid في approved_price_items من الأمين.
#
# لم تكن هذه المهمة مجدولة سابقاً (كانت تُشغَّل يدوياً فقط)، وهذا أحد أسباب
# عدم وجود item_guid لبعض الأصناف (مادة جديدة تُضاف في الأمين لن يظهر لها
# GUID في الموقع حتى تشغيل يدوي). الفاصل الافتراضي 6 ساعات لأن أرقام وأكواد
# ومعرّفات الأصناف تتغيّر نادراً (فقط عند إضافة/تعديل بطاقة في الأمين).
#
# السكربت المُشغَّل يقرأ من الأمين فقط ويحدّث ثلاثة أعمدة في approved_price_items
# فقط (item_number, item_code, item_guid) — لا يمسّ الأسعار ولا المخزون.
#
# التشغيل:  .\tools\register-item-numbers-task.ps1
#           .\tools\register-item-numbers-task.ps1 -IntervalMinutes 60
# الإلغاء:  Unregister-ScheduledTask -TaskName "TOBACCO Item Numbers Pull" -Confirm:$false
# ============================================================

param(
    [int]$IntervalMinutes = 360
)

$taskName = "TOBACCO Item Numbers Pull"
$scriptPath = "$PSScriptRoot\pull-item-numbers.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "لم أجد السكربت: $scriptPath"
}

# حارس: المهمة تُسجَّل بالمسار المطلق. تسجيلها من worktree مؤقّت ينتج مهمة تشير
# إلى مجلد يُحذف لاحقاً فتفشل بصمت. شغّل هذا من نسخة المستودع الأساسية فقط.
if ($scriptPath -like "*\.claude\worktrees\*") {
    throw "أنت داخل worktree مؤقّت. شغّل هذا السكربت من نسخة المستودع الأساسية: C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web"
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -Once -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -StartWhenAvailable

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host "تم تسجيل المهمة المجدولة: '$taskName' كل $IntervalMinutes دقيقة" -ForegroundColor Green
Write-Host "المسار: $scriptPath" -ForegroundColor Cyan
Write-Host "للإلغاء: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false" -ForegroundColor DarkGray
