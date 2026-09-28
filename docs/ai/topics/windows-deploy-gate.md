# بوابة نشر Windows (OZK2026)

## الحالة الحالية

- **2026-09-28 — المرحلة 0 (منفّذة على الجهاز بموافقة المالك):** عُطّلت مهمة
  «TOBACCO Daily Git Pull». لم يعد الدمج إلى `main` يصل تلقائياً إلى OZK2026.
  الجهاز متجمّد على `1812c08` إلى أن تُفعَّل البوابة. التعطيل لم يغيّر الـTrigger
  ولا الـAction، والرجوع عنه يكون بـ `Enable-ScheduledTask -TaskName 'TOBACCO Daily Git Pull'`.
- **المرحلة 1 (PR #281، مدموج في `24dc586`):** الكود المرجعي للبوابة، والـworkflow، والاختبارات،
  والتوثيق، داخل المستودع فقط.
- **إعداد GitHub (2026-09-28، بأمر المالك):**
  - فرع `windows-production` على `88ae841`.
  - Ruleset «windows-production-integrity».
  - Environment «windows-production» (راجع «حماية فرع windows-production» أدناه).
- **التركيب على OZK2026 أوقفه المالك (2026-09-28):**
  - لم يُثبَّت شيء في ProgramData.
  - لم تُحوَّل أي مهمة، ولم تُغيَّر أي أغلفة vbs أو صلاحيات.
  - «TOBACCO Daily Git Pull» ما زالت معطّلة.
- **لا نشر إنتاجي فوري:** أول نشر حقيقي على Windows يسبقه تشغيل البوابة بوضع
  `-Mode DryRun` مدة **24 ساعة كاملة**.
- السبب: `tools/daily-git-pull.ps1` كان يسحب `main` بـ`pull --rebase` كل يوم 07:30
  بلا أي موافقة ولا فحص CI. فدمجُ #279 فعّل `accountClasses:v1` على الجهاز قبل
  أمر المالك.

## خط الأساس (baseline)

- **خط أساس نشر Windows: `88ae841c6696bef2cbe75579039b215396972a6e`.** هذا الـSHA المسجّل على
  OZK2026، وعليه أُنشئ `windows-production`.
- **تحديث من خارج البوابة، مرصود ومصدره غير متحقَّق:**
  - الجهاز انتقل من `1812c08` إلى `88ae841` بـ`pull origin main: Fast-forward` يدوي، الساعة
    18:48:57 بتوقيت الجهاز (15:48:57Z) في 2026-09-28.
  - حدث ذلك بعد تعطيل «TOBACCO Daily Git Pull» (آخر تشغيل لها 07:30)، فلم تفعله المهمة.
  - لم يُتحقَّق من هوية من نفّذه ولا من موافقة المالك عليه، فلا يُعدّ نشراً مصرّحاً.
  - سُجّل كما هو، ولم يُرجَع عنه.
  - أوصل إلى الجهاز تغييرات #282: `tools/push-ameen-warehouse-stock.ps1` و
    `tools/ameen-warehouse-stock-retention.ps1`.

## حماية فرع windows-production

- **مفعَّل:** Ruleset «windows-production-integrity» بلا أي استثناء:
  - منع force push (`non_fast_forward`).
  - منع الحذف (`deletion`).
- **غير ممكن بالتصميم الموثّق:** «التحديث عبر workflow الإصدار وحده». GitHub رفض Ruleset
  «Restrict updates» مع استثناء تطبيق GitHub Actions، لأن المستودع شخصي وليس منظمة
  («Actor GitHub Actions integration must be part of the ruleset source or owner organization»).
  لذلك أي حساب بصلاحية كتابة يستطيع اليوم تقديم الفرع Fast-Forward.
- **ما يبقى حامياً:** البوابة على الجهاز لا تطبّق أي SHA ما لم يتحقق الشرطان معاً:
  - له GitHub Deployment ناجح في بيئة `windows-production`، بحمولة الإصدار نفسها
    (`kind: ozk-windows-release` ونفس الـSHA)، أنشأه الـworkflow بعد موافقة المالك.
  - CI أخضر على نفس الـSHA.

  فدفعٌ يدوي إلى الفرع لا يصل إلى الجهاز.
- **Environment «windows-production»:**
  - المراجع المطلوب ozkkhallouf-ux.
  - `prevent_self_review` معطّل.
  - يقبل التشغيل من فرع `main` وحده.
- **تحصين لاحق (غير منفّذ، لا مفاتيح ولا أسرار الآن):** تقييد كاتب الفرع، مثلاً Deploy Key
  بصلاحية كتابة سرّه داخل الـEnvironment وحده، مع Ruleset «Restrict updates» يستثني
  الـDeploy Keys. هذا يحتاج PR يعدّل الـworkflow.

## حدود الثقة لهوية البوابة (تصميم للتركيب القادم، غير مثبَّت)

- **المشكلة المكتشفة:**
  - البوابة تكتب ملفات الثقة: `state.json`، `audit.jsonl`، `writer-allowlist.json`،
    `deploying.flag`.
  - لو عملت بحساب OZKSync وكانت ملفاتها قابلة للكتابة له، فالمهام المحمية نفسها (وأغلبها
    OZKSync) تستطيع تعديل قائمة البصمات أو الحالة، فتُلغى حماية الكتّاب بصمت.
- **التصميم المقترح** (مسجّل في `trust` داخل `gate-config.example.json`):
  - مهمة «TOBACCO Windows Deploy Gate» تعمل بحساب **SYSTEM**.
  - `C:\ProgramData\OZK-TOBACCO\DeployGate` كتابته لـ **SYSTEM وAdministrators فقط**، وOZKSync
    وLOQ قراءة وتنفيذ.
  - المشغّل `run-repo-task.ps1` يعمل بحسابات المهام ولا يكتب في مجلد البوابة أبداً؛ سجله
    الوحيد في `logDir` منفصل (`C:\ProgramData\OZK-TOBACCO\DeployGateLogs`).
  - لا توسيع لصلاحيات OZKSync.
- **الإثبات الساكن** (`check-windows-deploy-gate.mjs`):
  - المشغّل لا يكتب إلا في `logDir`.
  - كل ملفات الثقة تحت `gateDir`.
  - البوابة لا تكتب داخل المستودع إلا عبر git.
  - `logDir` خارج `gateDir`.
- **لم يُنفَّذ منه شيء:** لا أغلفة vbs، ولا مهام، ولا صلاحيات.

## مزامنة نشرات الأسعار (OZK-PriceListSync)

- على OZK2026 المهمة **معطّلة** (Disabled منذ 2026-09-07). تشير إلى worktree قديم
  `tobacco-web-main-sync`، وهو detached HEAD لا على main.
- `migration-preflight.ps1` يقرأ حالتها الفعلية من Task Scheduler:
  - **Disabled** تعني `OUT_OF_SCOPE_DISABLED`، ولا تحجب ترحيل البوابة.
  - أي حالة أخرى (Ready، Running، وغيرها)، أو حالة غير مرئية، تعيدها إلى كل الشروط (fail-closed):
    checkout مستقل معتمد على main بالـremote الرسمي، وإلا BLOCK.
- لا تُفعَّل المهمة، ولا يُنشأ clone أو worktree الآن، ولا push إلى main من checkout النشرات.

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
   هدف الرجوع يجب أن يكون الإصدار السابق لنشر ناجح مسجَّل في `audit.jsonl`، أي بنتيجة `OK` أو
   `DEPLOYED_PENDING_RESTART` (Codex P1 #6). أي نتيجة أخرى (STOP، SKIP، FAIL، DRYRUN، غير معروفة) أو
   سطر تالف لا يُحتسب. بعد الرجوع يبقى الجهاز مثبّتاً (`ROLLED_BACK_PINNED`)، ولا إعادة تشغيل تلقائية.
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
10. **تسجيل الإصدار قابل للاستكمال** (Codex P1 #4، `scripts/windows-release-apply.mjs`):
    - إذا نجح دفع `windows-production` ثم فشل أو أُلغي تسجيل الـDeployment، فإعادة التشغيل
      (الوظيفة الفاشلة أو التشغيل كاملاً) تجد الفرع يساوي الهدف بالضبط، فتتخطى الدفع وتكمل
      التسجيل فقط، دون تكرار السجل.
    - يسبق ذلك دائماً إعادة التحقق من الـSHA، وmain، وCI، وموافقة الكتابة، وموافقة البيئة التي
      يطلبها GitHub من جديد عند كل إعادة.
    - في إعادة التشغيل الكاملة، الأساس هو آخر إصدار مسجَّل ناجح قبل الهدف. إذا لم يوجد، يُرفض
      التشغيل ويوجَّه إلى «Re-run failed jobs».
    - أي موضع آخر للفرع (أحدث، أو غير مرتبط، أو متأخر، أو ليس Fast-Forward) = رفض. لا force،
      لا reset، لا rebase.
11. **worktree الـmain المخصّص** (`mainWorktree`، Codex P1 #5):
    - مخصّص فقط للمهام المعلنة في `mainDependentTasks`، واليوم هي مزامنة النشرات وحدها
      (`allowedScripts`).
    - ليس مساراً لتحديث سكربتات Windows التشغيلية: البوابة لا تلمسه، والمشغّل يرفض أي سكربت
      خارج المستودع التشغيلي.
    - الفحص يحجب:
      - أي مهمة أخرى أو سكربت آخر يعمل منه.
      - مهمة غير مرئية للحساب الحالي.
      - worktree بفرع أو remote أو مسار خاطئ.
    - حارس main في `tools/auto-sync-price-lists.ps1` يبقى كما هو ولا يُخفَّف.
12. ثغرة معروفة خارج نطاق البوابة: كل السكربتات تتصل بحساب SQL يملك صلاحية كتابة.
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
3. **قبل تبديل الفرع** (Codex P1 #5): `migration-preflight.ps1` بحساب مدير يجب أن يعطي
   `PREFLIGHT PASS`.
   - ما دامت `OZK-PriceListSync` معطّلة، فهي `OUT_OF_SCOPE_DISABLED` ولا تحجب.
   - قبل تفعيلها في أي وقت، يلزم الترتيب التالي:
     1. checkout مستقل موثوق لـmain في `mainWorktree.path`
        (`C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web-main`). يُفضَّل clone بـ`.git` خاص،
        لأن worktree لا يأخذ main ما دام المستودع التشغيلي عليه.
     2. التحقق أنه على `main`، وأن الـremote هو المستودع الرسمي.
     3. نقل المهمة إليه صراحةً.
     4. اختبارها بموافقة المالك، لأنها تدفع إلى main.
     5. `PREFLIGHT PASS`.
4. تبديل الفرع المحلي بلا تغيير ملفات: `git switch -c windows-production --track origin/windows-production`
   عندما يكون HEAD مساوياً له. ثم `deploy-gate.ps1 -Mode Initialize`، الذي يعيد الفحص ويرفض
   التسجيل إذا لم ينجح.
5. توجيه المهام إلى `run-repo-task.ps1` واحدة واحدة، والكاتب في النهاية.
6. مهمة «TOBACCO Windows Deploy Gate» (SYSTEM) كل 10 دقائق، بوضع `-Mode DryRun` **24 ساعة كاملة**
   قبل أول نشر حقيقي. لا نشر إنتاجي فوري، ثم Deploy بموافقة المالك.
7. تمارين:
   - إصدار توثيقي.
   - إصدار PS1 قراءة.
   - إصدار كاتب بموافقة صريحة.
   - رجوع في نسخة تدريب.
8. إلغاء `tools/daily-git-pull.ps1` في المستودع، وإبقاء المهمة معطّلة.
9. تحسين منفصل: `StartWhenAvailable`، وتنبيهات «نشر معلّق» و«بوابة صامتة».
