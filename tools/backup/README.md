# نسخ الأمين الاحتياطي المُتحقَّق — `ozk-ameen-backup.ps1`

بديل `tools\ozk-backup-external.ps1`، السكربت الذي عاش خارج Git على OZK2026 وسحبه `git stash -u` في 2026-09-01 (ما زال محفوظاً في `stash@{4}` هناك؛ **لا تحذف الـstashes**). منذ ذلك التاريخ لا نسخ خارج الجهاز. هذا الإصدار محفوظ في Git عمداً.

## السلوك

| الوضع | ما يحدث |
|---|---|
| بلا وسائط (**الافتراضي**) | DryRun: يطبع أوامر SQL والمسارات فقط. لا اتصال SQL ولا كتابة ملفات |
| `-Execute` | على `OZK2026` وحده: `BACKUP … WITH COPY_ONLY, CHECKSUM, NOINIT` ثم `RESTORE VERIFYONLY … WITH CHECKSUM` لكل قاعدة، ثم SHA256 في `manifest.json`، ثم النسخ للقرص الخارجي مع إعادة حساب SHA256 في الوجهة |

القواعد: قائمة ثابتة `AmnDb002`، `AmnDb001`، `AmnConfig` فقط. أي اسم آخر مرفوض.

## ضمانات

- **لا حذف ولا استبدال**: كل تشغيل يكتب في مجلد جديد `C:\AmeenBackup\OZK\<yyyy>\<stamp>\`، ويُرفض إن وُجد. النسخ للخارجي بـ`File.Copy(..., overwrite=false)`. لا `Remove-Item` في السكربت (يفحصه الاختبار).
- **حارس SQL**: لا يمرّ إلا `BACKUP DATABASE [قاعدة مسموحة] … COPY_ONLY … CHECKSUM` و`RESTORE VERIFYONLY`. ويُرفض `REPLACE` و`INIT` و`FORMAT` و`RESTORE DATABASE` و`DROP`/`ALTER` والأوامر المركّبة.
- **COPY_ONLY**: لا يغيّر تسلسل نسخ الأمين اليدوية.
- **السحابة معطّلة**: `-Cloud` يرمي خطأً حتى موافقة المالك.
- **مصادقة Windows** فقط (`Integrated Security`)؛ لا `.env` ولا كلمات مرور.

## القرص الخارجي

يُكتشف بملف علامة فارغ `OZK-BACKUP-DRIVE.marker` على جذر القرص، لا بحرفه. الوجهة `<قرص>:\OZK-Backups\<yyyy>\<stamp>\`. يمكن تمريره صراحةً بـ`-ExternalRoot`.

## الحالة والسجل

- `C:\ProgramData\OZK-TOBACCO\Backup\status.json`: نتيجة آخر تشغيل (`ok` / `local-only` / `failed`).
- `C:\ProgramData\OZK-TOBACCO\Backup\logs\backup-<yyyy-MM>.log`.
- رموز الخروج: `0` نجاح كامل أو DryRun، `1` فشل، `2` نجاح محلي والقرص الخارجي غير موصول.

**النسخة ناجحة فقط** إذا نجح `BACKUP WITH CHECKSUM` و`VERIFYONLY WITH CHECKSUM` لكل القواعد، وطابق SHA256 في كل وجهة.

## خارج نطاق هذا الإصدار (كل بند بموافقة منفصلة)

- ربط مهمة `OZK Ameen Full Backup` بهذا السكربت (لم تُعدَّل أي مهمة).
- أول تشغيل فعلي بـ`-Execute`.
- اختبار استعادة إلى قاعدة منفصلة.
- الطبقة السحابية المشفّرة وسياسة الاحتفاظ والحذف.
- تحديث مراقب `monitor-ameen-backup.ps1`.

## الاختبار

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\tests\Test-OzkAmeenBackup.ps1
```

بلا SQL حقيقي: كل الاستدعاءات بدائل وهمية في مجلد مؤقت. يعمل في وظيفة `ps51-compat` على Windows PowerShell 5.1.
