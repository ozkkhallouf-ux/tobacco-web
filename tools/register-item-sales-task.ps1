# ============================================================
# register-item-sales-task.ps1
# يسجّل مهمة مجدولة ترفع صافي مبيع كل صنف في آخر 30 يوماً (كل فواتير البيع
# والمرتجع، مع «مبيعات مركز» بلا اسم زبون) إلى Supabase — مصدر ترتيب أولوية
# تنبيه النفاد (docs/ai/topics/stock-priority-alerts.md).
# السكربت المُشغَّل يقرأ من الأمين فقط ويكتب في inventory_reports بمصدر
# ameen_item_sales وحده.
#
# الفاصل الافتراضي 30 دقيقة: التنبيه يرفض أي تقرير أقدم من 90 دقيقة.
# شغّله كمسؤول Administrator على الجهاز الذي يحوي ملف tools\.env وقاعدة الأمين
# ============================================================
param(
    [int]$IntervalMinutes = 30
)

$taskName = "TOBACCO Item Sales Push"
$scriptPath = "$PSScriptRoot\push-item-sales.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "لم أجد السكربت: $scriptPath"
}

# حارس: المهمة تُسجَّل بالمسار المطلق. تسجيلها من worktree مؤقّت ينتج مهمة تشير
# إلى مجلد يُحذف لاحقاً فتفشل بصمت. شغّل هذا من نسخة المستودع الأساسية فقط.
if ($scriptPath -like "*\.claude\worktrees\*") {
    throw "أنت داخل worktree مؤقّت. شغّل هذا السكربت من نسخة المستودع الأساسية."
}

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$trigger = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -Once -At (Get-Date)

$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)

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
Write-Host "تم تشغيل الرفعة الأولى الآن — راقب السجل: tools\logs\item-sales-push.log" -ForegroundColor Cyan
