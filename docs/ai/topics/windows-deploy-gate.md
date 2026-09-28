# بوابة نشر Windows (OZK2026)

## الحالة الحالية

- **2026-09-28 — المرحلة 0 (منفّذة على الجهاز بموافقة المالك):** عُطّلت مهمة
  «TOBACCO Daily Git Pull». لم يعد الدمج إلى `main` يصل تلقائياً إلى OZK2026.
  الجهاز متجمّد على `1812c08` إلى أن تُفعَّل البوابة. التعطيل لم يغيّر الـTrigger
  ولا الـAction، والرجوع عنه يكون بـ `Enable-ScheduledTask -TaskName 'TOBACCO Daily Git Pull'`.
- **المرحلة 1 (هذا التقرير):** الكود المرجعي للبوابة، والـworkflow، والاختبارات،
  والتوثيق، داخل المستودع فقط. لم يُثبَّت شيء على OZK2026 بعد، ولم يُنشأ فرع
  `windows-production` ولا Environment ولا Ruleset. كل ذلك خطوات مالك لاحقة.
- السبب: `tools/daily-git-pull.ps1` كان يسحب `main` بـ`pull --rebase` كل يوم 07:30
  بلا أي موافقة ولا فحص CI. فدمجُ #279 فعّل `accountClasses:v1` على الجهاز قبل
  أمر المالك.

## المصدر الموثوق

| العنصر | المكان |
|---|---|
| مرجع نشر Windows | فرع `windows-production` على GitHub. يتقدّم Fast-Forward فقط |
| الموافقة | GitHub Deployment في بيئة `windows-production`، حمولته `kind: "ozk-windows-release"` ونفس الـSHA |
| البوابة المعتمدة | `C:\ProgramData\OZK-TOBACCO\DeployGate\` (كتابة لـAdministrators/SYSTEM فقط) |
| الحالة والتدقيق | `state.json`، `audit.jsonl`، `writer-allowlist.json`، `deploying.flag` في المجلد نفسه |
| النسخة المرجعية | `tools/deploy-gate/` للمراجعة والاختبار فقط. الدمج لا يغيّر النسخة المثبّتة |

## نطاق الملفات

- `.github/workflows/windows-release.yml`: تشغيل يدوي (`workflow_dispatch`) مع SHA، ثم
  فحص، ثم موافقة البيئة، ثم دفع Fast-Forward إلى `windows-production` بلا `--force`،
  ثم تسجيل Deployment.
- `scripts/windows-release-verify.mjs`: فحوص ما قبل الموافقة. يتحقق أن الـSHA على
  `main`، وأن التقدّم Fast-Forward، وأن CI أخضر على نفس SHA الدمج، ويصنّف الملفات
  المتغيّرة ويحدد سكربتات الكتابة بينها.
- `tools/deploy-gate/deploy-gate.ps1`: البوابة. أوضاعها Deploy وDryRun وInitialize
  وRollback وUnpin.
- `tools/deploy-gate/run-repo-task.ps1`: المشغّل الموحّد لكل مهمة تشغّل سكربتاً من
  المستودع. يطبّق عَلَم الإيقاف وبصمات سكربتات الكتابة.
- `tools/deploy-gate/notify.ps1`: تنبيه تيليغرام مستقل، لا يشغّل أي سكربت من المستودع.
- `tools/deploy-gate/gate-config.example.json`: الإعداد المرجعي، وفيه `writerScripts`
  و`pauseTasks` والفحوص المطلوبة.
- الاختبارات:
  - `tools/tests/Test-DeployGate.ps1` و`tools/tests/Test-RunRepoTask.ps1` على PowerShell 5.1 في CI.
  - `scripts/check-windows-deploy-gate.mjs` ضمن `npm run check`.

## القيود الثابتة

1. الدمج إلى `main` ينشر الويب وحده (`pages.yml`). لا مسار آلي من `main` إلى OZK2026.
2. التحديث على الجهاز `git merge --ff-only` فقط. ممنوع `pull` و`rebase` و`reset --hard`.
   الرجوع الطارئ اليدوي وحده يستعمل `reset --keep`، ولا يعمل تلقائياً أبداً.
3. قبل أي تحديث يجب أن تنجح كل هذه الفحوص:
   - اسم الجهاز صحيح.
   - الفرع `windows-production`.
   - `HEAD` يساوي آخر SHA منشور (أي انحراف = STOP).
   - الشجرة نظيفة.
   - الهدف يحوي `HEAD` (Fast-Forward).
   - الهدف على `main`.
   - لا قفل `AI_ACTIVE_TASK.json` نشط، لا على الهدف ولا على main.
   - CI أخضر على نفس الـSHA: `Deploy TOBACCO Web` و`دخان ما بعد النشر`، وفحوص الـPR
     المطلوبة الخمسة على رأس الـPR الذي أنتج commit الدمج.
   - **أحدث تشغيل وحده يحكم** لكل workflow وكل فحص (Codex P1 #1). نجاح قديم لا يغطّي
     إعادة تشغيل أحدث فشلت أو أُلغيت أو انتهت مهلتها أو ما زالت جارية. الترتيب بوقت
     البدء، ثم بالمعرّف. وقت فارغ (`started_at` null في queued/in_progress من GitHub)
     يُعدّ أحدث فيُغلق الباب حتى يكتمل التشغيل.
   - Deployment ناجح بحمولة الإصدار.
4. GitHub ينشئ Deployment تلقائياً لكل job يعلن `environment`، على `github.sha`.
   هذا لا يُعدّ موافقة: البوابة تشترط `payload.kind` و`payload.sha`.
5. سكربتات الكتابة تُحدَّد بطريقتين (Codex P1 #2):
   - القائمة الثابتة `writerScripts`: مسار كتابة الأسعار إلى الأمين كاملاً، وكتّاب الأمين
     غير المجدولين.
   - كشف نصي متحفّظ `writeScan`: أي ملف متغيّر تحت `tools/` أو `scripts/` (عدا الاختبارات)
     يُعامَل كاتباً إذا احتوى محتواه الجديد أياً من:
     - متغيّر اتصال الكتابة `AMEEN_SQL_WRITE_CONNECTION_STRING`.
     - تعليمات تعديل SQL: INSERT، UPDATE…SET، DELETE، MERGE، TRUNCATE، DDL، EXEC sp_.
     - `ExecuteNonQuery` أو `SqlBulkCopy` أو `BEGIN TRAN` أو `Invoke-Sqlcmd` أو `sqlcmd`.
   - تعذّر قراءة الملف يعني أنه يُعامَل كاتباً (fail-closed).
   - الملفات القادرة على الكتابة في الشجرة كلها تدخل قائمة البصمات المحمية
     (`writer-allowlist.json`)، والمشغّل يفرضها عليها.
   - الكشف النصي **دفاع إضافي لا بديل** عن فصل صلاحيات SQL. `AMEEN_SQL_CONNECTION_STRING`
     نفسه يشير اليوم إلى حساب يملك الكتابة، فسكربت يكتب عبره بصياغة لا تطابق الأنماط لا
     يُكشف. الحل الجذري حساب قراءة فقط للقرّاء، وهو خطوة مستقلة بموافقة المالك.
   - تغيير أيٍّ منها يتطلب `write_scripts_approved=true`، وأن تطابق الـblobs المعتمدة
     في الحمولة الملفات الفعلية.
   - المشغّل يرفض تشغيل كاتب إذا لم تطابق بصمة أي ملف من المجموعة
     `writer-allowlist.json`.
   - هذه القائمة لا تُحدَّث إلا بنشر معتمد.
   - الموافقة مرتبطة بمحتوى الملف (blob). عند اللحاق بعدة إصدارات دفعة واحدة، يُقبل
     الـblob إذا اعتمده صراحةً الإصدار الهدف أو أي إصدار ناجح سابق بموافقة كتابة.
6. عَلَم `deploying.flag`:
   - المهام تتخطى دورتها ما دام العلم قائماً.
   - بعد `flagTtlMinutes` تعود مهام القراءة للعمل مع تنبيه، ويبقى الكاتب متوقفاً.
7. العمليات الطويلة (`longRunningComponents`، Codex P1 #3) لها خريطة تبعيات صريحة، والفحص
   الساكن يتأكد أنها تغطي الاستدعاءات الفعلية. العمليات الثلاث:
   - Ameen Read Worker: `ameen-read-worker.ps1` و`ameen-read-gateway.ps1` واستعلاما المخزون والأرصدة.
   - OZK-AmeenAutoPrint: `watcher.js` و`config.js` و`invoice-html.js` واستعلاماه و`package.json`
     و`start.bat`. ملف `run-watcher.bat` غير متتبَّع على الجهاز.
   - `scripts/serve.mjs`.

   إذا مسّ الإصدار أياً من هذه الملفات:
   - تُنشر الملفات بالطريقة المعتادة.
   - تُسجَّل الحالة `DEPLOYED_PENDING_RESTART`، لا `OK`، مع أسماء العمليات، في `state.json`
     و`audit.jsonl`.
   - يُرسل تنبيه يسمّيها، ثم تذكير في كل دورة NOOP.
   - القائمة تتراكم حتى يؤكّد المالك إعادة التشغيل يدوياً:
     `deploy-gate.ps1 -Mode AckRestart -Components "<الاسم>"`.

   البوابة **لا تعيد تشغيل أي مهمة ولا توقف أي عملية أبداً**، ولا توسّع صلاحيات OZKSync.
8. البوابة المثبّتة لا تُحدَّث من المستودع. تحديثها خطوة إدارية منفصلة بموافقة.
9. ثغرة معروفة خارج نطاق البوابة: كل السكربتات تتصل بحساب SQL يملك صلاحية كتابة.
   الحماية الأقوى هي حساب قراءة فقط للقرّاء، وهي خطوة مستقلة تحتاج موافقة على
   خادم الأمين.

## الفحوص الإلزامية

- `npm run check`، ويشمل `check-windows-deploy-gate.mjs`.
- `tools/tests/Test-DeployGate.ps1` و`tools/tests/Test-RunRepoTask.ps1` على Windows
  PowerShell 5.1. يشغّلهما عدّاء `ps51-compat` في `check.yml`، ويعملان محلياً أيضاً بـ`pwsh`.

## الخطوة التالية (كل خطوة بموافقة المالك)

1. GitHub:
   - Environment «windows-production» بمراجع مطلوب هو المالك.
   - فرع `windows-production` على `1812c08`، أي الـSHA المنشور حالياً على الجهاز.
   - Ruleset للفرع: منع force والحذف، والتحديث من Actions فقط.
   - عند تعديل rulesets يجب إرسال القواعد كاملة، لأن PUT يستبدلها كلها.
2. OZK2026 (مدير):
   - نسخ `tools/deploy-gate/*` إلى `C:\ProgramData\OZK-TOBACCO\DeployGate\`.
   - صلاحيات: OZKSync قراءة وتنفيذ فقط.
   - `gate-config.json` من المثال.
3. تبديل الفرع المحلي بلا تغيير ملفات: `git switch -c windows-production --track origin/windows-production`
   عندما يكون HEAD مساوياً له. ثم `deploy-gate.ps1 -Mode Initialize`.
4. توجيه المهام إلى `run-repo-task.ps1` واحدة واحدة، والكاتب في النهاية.
5. مهمة «TOBACCO Windows Deploy Gate» كل 10 دقائق، بوضع `-Mode DryRun` يوماً كاملاً، ثم Deploy.
6. تمارين:
   - إصدار توثيقي.
   - إصدار PS1 قراءة.
   - إصدار كاتب بموافقة صريحة.
   - رجوع في نسخة تدريب.
7. إلغاء `tools/daily-git-pull.ps1` في المستودع، وإبقاء المهمة معطّلة.
8. تحسين منفصل: `StartWhenAvailable`، وتنبيهات «نشر معلّق» و«بوابة صامتة».
