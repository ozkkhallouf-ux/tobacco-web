# ============================================================
# register-item-costs-task.ps1
# يسجّل مهمة Windows مجدولة ترفع "متوسط التكلفة" (AvgPrice) من الأمين إلى
# Supabase (جدول item_costs، للمدير فقط) — هذا هو السبب الجذري لتجمّد
# القيمة القديمة سابقاً: push-item-costs.ps1 كان موجوداً بلا أي جدولة تُشغّله.
#
# السكربت المُشغَّل يقرأ من الأمين فقط ويكتب في item_costs وحده — لا يمسّ
# الأسعار المعتمدة ولا المخزون ولا أي مزامنة أخرى.
#
# الفاصل الافتراضي 15 دقيقة: متوسط التكلفة يتغيّر مع كل فاتورة شراء، فيجب أن
# يبقى قريباً من اللحظي بدون إثقال الأمين.
#
# التشغيل:  .\tools\register-item-costs-task.ps1
#           .\tools\register-item-costs-task.ps1 -IntervalMinutes 30
# الإلغاء:  Unregister-ScheduledTask -TaskName "TOBACCO Item Costs Push" -Confirm:$false
# ============================================================

param(
    [int]$IntervalMinutes = 15
)

$taskName = "TOBACCO Item Costs Push"
$scriptPath = "$PSScriptRoot\push-item-costs.ps1"

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

# مهلة 10 دقائق: قراءة كل المواد من vwMaterials قد تبطئ عند انشغال الخادم.
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
