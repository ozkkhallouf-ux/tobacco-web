# Windows Deployment Gate — نسخة مرجعية

المرجع الكامل: [`docs/ai/topics/windows-deploy-gate.md`](../../docs/ai/topics/windows-deploy-gate.md).

هذه الملفات **لا تعمل من هنا**. النسخة المعتمدة تُنسخ يدوياً، بموافقة المالك، إلى
`C:\ProgramData\OZK-TOBACCO\DeployGate\` مع صلاحيات تمنع حساب المهام من تعديلها، حتى
لا يستطيع دمجٌ عادي إلى المستودع تغيير البوابة التي تتحكم بنشره. تعمل البوابة بهوية مخصّصة (`trust.gateAccount`) لا تشغّل أي كود من أي مستودع، لا SYSTEM ولا OZKSync ولا LOQ ولا Administrators.

| الملف | الدور |
|---|---|
| `deploy-gate.ps1` | يحدّث المستودع على OZK2026 إلى `origin/windows-production` بـ`merge --ff-only` بعد كل الفحوص. أوضاعه: `Deploy` و`DryRun` و`Initialize` و`Rollback -To <sha>` و`Unpin` |
| `run-repo-task.ps1` | مشغّل موحّد لكل Scheduled Task تشغّل سكربتاً من المستودع. يتخطى أثناء النشر، ويتحقق من بصمات سكربتات الكتابة |
| `notify.ps1` | تنبيه تيليغرام مستقل عن سكربتات المستودع |
| `migration-preflight.ps1` | فحص قراءة فقط قبل تحويل المستودع التشغيلي إلى `windows-production`: المهام التي تحتاج main يجب أن تعمل من worktree مخصّص صحيح. يستدعيه `-Mode Initialize` أيضاً |
| `gate-config.example.json` | الإعداد المرجعي: المسارات، الفحوص المطلوبة، `pauseTasks`، `writerScripts` |

## التشغيل على الجهاز (بعد التثبيت)

```powershell
# فحص كل الشروط وتسجيل القرار بلا أي تغيير
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\OZK-TOBACCO\DeployGate\deploy-gate.ps1 -Mode DryRun

# رجوع طارئ يدوي إلى SHA سبق نشره (مسجَّل في audit.jsonl)، ثم تثبيت الحالة
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\OZK-TOBACCO\DeployGate\deploy-gate.ps1 -Mode Rollback -To <sha>

# بعد أن يعيد المالك تشغيل عملية طويلة يدوياً (البوابة لا تعيد تشغيل شيئاً بنفسها)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\OZK-TOBACCO\DeployGate\deploy-gate.ps1 -Mode AckRestart -Components "TOBACCO Ameen Read Worker"

# فك التثبيت بعد نشر إصدار مصحَّح على windows-production
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\OZK-TOBACCO\DeployGate\deploy-gate.ps1 -Mode Unpin
```

صيغة Action المهمة بعد التوجيه إلى المشغّل:

```text
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\ProgramData\OZK-TOBACCO\DeployGate\run-repo-task.ps1" -Script "tools/ameen-sync-agent.ps1" <وسائط السكربت>
```

## الاختبار

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-DeployGate.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-RunRepoTask.ps1
```
