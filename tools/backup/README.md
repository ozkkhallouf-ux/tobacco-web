# نسخ الأمين الاحتياطي المُتحقَّق — `ozk-ameen-backup.ps1`

بديل `tools\ozk-backup-external.ps1`، السكربت الذي عاش خارج Git على OZK2026 وسحبه `git stash -u` في 2026-09-01 (ما زال محفوظاً في `stash@{4}` هناك؛ **لا تحذف الـstashes**). منذ ذلك التاريخ لا نسخ خارج الجهاز. هذا الإصدار محفوظ في Git عمداً.

## السلوك

| الوضع | ما يحدث |
|---|---|
| بلا وسائط (**الافتراضي**) | DryRun: يطبع أوامر SQL والمسارات وحدود المساحة وقناة التنبيه فقط. لا SQL ولا ملفات ولا رسائل |
| `-Execute` | على `OZK2026` وحده، بالترتيب الموضّح أدناه |

ترتيب `-Execute`:

1. **قفل** `Global\OZK-Ameen-Verified-Backup`: إن كان تشغيل آخر جارياً ⇒ `skipped-concurrent` (خروج 3) بلا أي أثر.
2. **حارس مساحة محلي**: الفاضي على قرص `-LocalRoot` يجب أن يكون ≥ `-LocalMinFreeGB` (افتراضياً 20). وإلا فلا BACKUP أصلاً.
3. `BACKUP … WITH COPY_ONLY, CHECKSUM, NOINIT` ثم `RESTORE VERIFYONLY … WITH CHECKSUM` لكل قاعدة.
4. **ضغط مُتحقَّق**: `OZK-Ameen-<stamp>.zip` جديد، ثم إعادة فتحه وحساب SHA256 لكل مدخل ومطابقته مع SHA256 ملف `.bak` الأصلي. `-NoCompress` يعطّله.
5. **حارس مساحة خارجي**: الفاضي ≥ `-ExternalMinFreeGB` (افتراضياً 20) + حجم ما سيُنقل.
6. نسخ الـzip وmanifest.json إلى القرص الخارجي (أو ملفات `.bak` مع `-NoCompress`)، ثم إعادة SHA256 في الوجهة.
7. `status.json` + سجل شهري + **تنبيه**.

القواعد: قائمة ثابتة `AmnDb002`، `AmnDb001`، `AmnConfig` فقط. أي اسم آخر مرفوض.

## التنبيهات

- **Slack أولاً**: `chat.postMessage` إلى `#تنبيهات-ozk` (`-SlackChannel C0C1X2E58MT`)، بتوكن يُقرأ من متغيّر البيئة `SLACK_BOT_TOKEN` (العملية ثم المستخدم). التوكن لا يُكتب في الكود ولا في Git ولا في السجل ولا في status.json.
- **Telegram بديلاً**: إن لم يوجد توكن، أو رفض Slack، أو تعذّر الوصول، يُستعمل `-NotifyScript` (عادةً `tools\send-telegram-notification.ps1`).
- **⚠️ قيد مثبت (2026-10-14):** `slack.com` يرد بـ**HTTP 451** من OZK2026 لأن الخروج من سوريا (Starlink). فعلياً، التنبيه سيصل Telegram حتى يُحلّ مسار Slack (relay خارجي أو نفق VPN)، وذلك قرار منفصل.
- النجاح: رسالة مختصرة (الملف، الحجم، أول 12 حرفاً من SHA256، المساحة). الفشل: كل الأخطاء. `skipped-concurrent` لا يرسل شيئاً.

## ضمانات

- **لا حذف ولا استبدال**: كل تشغيل يكتب في مجلد جديد `C:\AmeenBackup\OZK\<yyyy>\<stamp>\` ويُرفض إن وُجد، وملف الـzip يُرفض إن وُجد، والنسخ للخارجي بـ`File.Copy(..., overwrite=false)`. لا `Remove-Item` في السكربتين (يفحصه الاختبار).
- **حارس SQL**: لا يمرّ إلا `BACKUP DATABASE [قاعدة مسموحة] … COPY_ONLY … CHECKSUM` و`RESTORE VERIFYONLY`. يُرفض `REPLACE` و`INIT` و`FORMAT` و`RESTORE DATABASE` و`DROP`/`ALTER` والأوامر المركّبة.
- **COPY_ONLY**: لا يغيّر تسلسل نسخ الأمين اليدوية.
- **السحابة معطّلة**: `-Cloud` يرمي خطأً حتى موافقة المالك.
- **مصادقة Windows** فقط (`Integrated Security`)؛ لا `.env` ولا كلمات مرور.

**تنبيه مساحة C:**: ملفات `.bak` الخام تبقى على C: (نحو 3.3 GB لكل تشغيل) لأن السكربت لا يحذف شيئاً. حارس المساحة يوقف النسخ ويُنبّه قبل الامتلاء. سياسة الاحتفاظ وحذف الملفات الخام بعد التحقق قرار منفصل (K1).

## القرص الخارجي

يُكتشف بملف علامة فارغ `OZK-BACKUP-DRIVE.marker` على جذر القرص، لا بحرفه. الوجهة `<قرص>:\OZK-Backups\<yyyy>\<stamp>\`. يمكن تمريره صراحةً بـ`-ExternalRoot`.

## الحالة والسجل

- `C:\ProgramData\OZK-TOBACCO\Backup\status.json`: نتيجة آخر تشغيل (`ok` / `local-only` / `failed`)، والمساحة، وقناة التنبيه.
- `C:\ProgramData\OZK-TOBACCO\Backup\logs\backup-<yyyy-MM>.log`.
- رموز الخروج: `0` نجاح كامل أو DryRun، `1` فشل، `2` نجاح محلي والقرص الخارجي غير موصول، `3` تُخطّي بسبب تشغيل متزامن.

**النسخة ناجحة فقط** إذا نجح `BACKUP WITH CHECKSUM` و`VERIFYONLY WITH CHECKSUM` لكل القواعد، وطابقت مدخلات الـzip بصمات الملفات، وطابق SHA256 في كل وجهة.

## المهمة اليومية — `register-ozk-ameen-backup-task.ps1`

| | |
|---|---|
| الافتراضي | DryRun: يطبع تعريف المهمة فقط |
| `-Apply` | على OZK2026 وحده: يسجّل مهمة **جديدة** `OZK Ameen Verified Backup` |
| التوقيت | يومياً 23:00 (`-At`) |
| الحساب | `OZK2026\LOQ` بنوع **S4U** (تعمل بلا تسجيل دخول وبلا تخزين كلمة مرور). LOQ هو الحساب الوحيد الذي له sysadmin على SQL؛ `SYSTEM` ليس login |
| التداخل | `MultipleInstances=IgnoreNew` + قفل السكربت |
| المهلة | ساعتان |
| المشغّل | `run-repo-task.ps1` من بوابة النشر إن وُجد، وإلا تشغيل السكربت مباشرة (البوابة غير مثبّتة على OZK2026 حالياً) |
| الأمان | يرفض إن وُجدت مهمة بنفس الاسم. لا يعدّل ولا يحذف أي مهمة موجودة (`OZK Ameen Full Backup` و`TOBACCO Ameen Backup Pull` قرار منفصل) |

يحتاج اختباراً يدوياً بعد التسجيل: هل تصل جلسة S4U إلى SQL والقرص الخارجي ومتغيّر بيئة المستخدم؟ إن لم تصل، يُستعمل `-LogonType Password` (يتأثر بتغيير كلمة مرور LOQ).

## خارج نطاق هذا الإصدار (كل بند بموافقة منفصلة)

- تسجيل المهمة فعلياً، وأول تشغيل بـ`-Execute`.
- مسار Slack من OZK2026 (محجوب حالياً).
- اختبار استعادة إلى قاعدة منفصلة.
- الطبقة السحابية المشفّرة وسياسة الاحتفاظ والحذف.
- تحديث مراقب `monitor-ameen-backup.ps1`، وتوقيت `TOBACCO Ameen Backup Pull` (23:00 أيضاً).

## الاختبار

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-OzkAmeenBackup.ps1
```

بلا SQL حقيقي وبلا Task Scheduler وبلا رسائل: كل الاستدعاءات بدائل وهمية في مجلد مؤقت. يعمل في وظيفة `ps51-compat` على Windows PowerShell 5.1.
