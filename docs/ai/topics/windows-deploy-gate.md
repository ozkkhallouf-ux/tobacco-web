# بوابة نشر Windows (OZK2026)

## الحالة الحالية

- **2026-09-28 — المرحلة 0 (منفّذة على الجهاز بموافقة المالك):** عُطّلت مهمة
  «TOBACCO Daily Git Pull». لم يعد الدمج إلى `main` يصل تلقائياً إلى OZK2026.
  خط الأساس الحالي على الجهاز `88ae841`. هذا خط أساس مرصود: وصله الجهاز بسحب يدوي خارج
  البوابة، راجع «خط الأساس» أدناه. ويبقى عليه حتى تُفعَّل البوابة. التعطيل لم يغيّر الـTrigger
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
  - عند الفحص كانت الشجرة نظيفة، ولم يكن #281 (`24dc586`) على الجهاز.
  - `88ae841` هو **خط أساس مرصود حالياً**، وليس نشراً تاريخياً معتمداً عبر البوابة. لا يوجد له
    Deployment في بيئة `windows-production`.
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
- **هذه القاعدة ليست ضماناً كافياً وحدها.** البوابة تبقى fail-closed، ولا تطبّق SHA لمجرد
  وجوده على `windows-production`. تحتاج دائماً:
  - Deployment معتمداً للـSHA الهدف نفسه بالضبط.
  - تحققاً من CI على الـSHA.
  - تحققاً من الموافقة (الحمولة ومُنشئ الـworkflow).
  - بقية الشروط: Fast-Forward، على main، شجرة نظيفة، لا انحراف، لا قفل AI، وموافقة الكتّاب.
- **ممنوع في هذه المرحلة:** إنشاء Deploy Key، أو أسرار، أو GitHub App، أو PAT، أو Ruleset، أو
  Environment جديد.
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
- **SYSTEM ليست حدود ثقة (Codex P1 على #285).** لا تصلح أيٌّ من هذه الهويات للبوابة:
  - **SYSTEM:** كود المستودع يعمل بها اليوم. `OZK-AmeenAutoPrint` يشغّل
    `tools/ameen-autoprint/run-watcher.bat` من المستودع بحساب SYSTEM (`install-service.bat`).
  - **LOQ:** عضو Administrators، ويشغّل مهام من المستودع (Read Worker، Khalil Audit، وغيرها).
  - **OZKSync:** يشغّل أغلب مهام المستودع.
  - **Administrators:** SYSTEM وAdministrators يستطيعان تجاوز ACL أو الاستيلاء على الملفات.
- **التصميم المقترح — Dedicated Gate Identity** (مسجّل في `trust` داخل `gate-config.example.json`):
  - حساب محلي مخصّص (`OZK-DeployGate`، **لم يُنشأ**). وظيفته الوحيدة البوابة وحالة الثقة التي
    تحتاجها.
  - لا يشغّل أي كود من tobacco-web أو أي مستودع آخر: لا Ameen Read Worker، ولا AutoPrint، ولا
    `serve.mjs`، ولا سكربتات sync/push/price.
  - مهمة «TOBACCO Windows Deploy Gate» هي المهمة الوحيدة بهذه الهوية، ولا تشغّل إلا سكربتات
    البوابة من `gateDir`.
  - ملفات الثقة، وهي البوابة التنفيذية، والإعداد، والبصمات، وحالة الإصدار المعتمد، والتدقيق،
    قابلة للكتابة **للهوية المخصّصة وحدها**، مع الحد الأدنى الضروري لنظام Windows.
  - هويات repo workloads (OZKSync وLOQ وSYSTEM) قراءة فقط.
  - لا يُعتمد على «Administrators فقط» كحاجز.
  - المشغّل `run-repo-task.ps1` يعمل بحسابات المهام ولا يكتب في مجلد البوابة أبداً؛ سجله
    الوحيد في `logDir` منفصل (`C:\ProgramData\OZK-TOBACCO\DeployGateLogs`).
  - لا توسيع لصلاحيات OZKSync، ولا تغيير لحسابات المهام الحالية.
- **حدود هذه الحماية:** المدير المحلي (Local Administrator) يبقى قادراً تقنياً على تجاوز ACL
  والاستيلاء على الملفات. الهدف فصل نطاقات ثقة الأتمتة، ومنع كود المستودع من تعديل ثقة
  البوابة تلقائياً. ليست حماية من مدير بشري خبيث.
- **حارس التثبيت** (`Invoke-GateIdentityPreflight` ضمن `Invoke-InstallPreflight`، ويستدعيه
  `-Mode Initialize`) يحجب التثبيت (fail-closed) إذا:
  - كانت هوية البوابة SYSTEM، أو OZKSync، أو LOQ، أو Administrators، أو أي صيغة لها (SID،
    بادئة الجهاز).
  - كانت كتابة ملفات الثقة لغير الهوية المخصّصة.
  - استُعملت الهوية المخصّصة لأي مهمة أو خدمة أخرى.
  - كانت مهمة البوابة تشغّل شيئاً خارج `gateDir`.
  - كان repo workload يعمل بهوية مسموح لها بكتابة ملفات الثقة.
  - كانت هوية مهمة غير مقروءة، أو لم تكن المهام مرئية.

  على التخطيط الحالي لـOZK2026 يثبت الحارس أن SYSTEM غير صالحة.
- **الغلاف المفقود أو غير المقروء أو الفارغ = UNKNOWN (Codex P1):**
  - كل غلاف يشير إليه مسار تشغيل تلقائي (مهمة، أو خدمة، أو Startup/Run)، وعلى امتداد السلسلة كلها:
    - مفقود، أو مجلد في مكان الملف ⇒ UNKNOWN، لأنه قد يظهر لاحقاً ويشغّل كود مستودع.
    - فشل القراءة: رفض وصول، أو خطأ قراءة، أو اختفاء أثناء الفحص ⇒ UNKNOWN.
    - ملف موجود بطول صفر ⇒ UNKNOWN أيضاً، لأنه لا يثبت ما سيشغّله. يُسجَّل بسبب مستقل عن فشل القراءة،
      و`Read-PreflightWrapperText` لا يحوّل الفشل أبداً إلى نص فارغ صالح.
  - مع هوية ذات صلاحية ⇒ حجب.
  - مهمة البوابة الوحيدة المتحقَّق منها حرفياً لا تُصنَّف بالوصول: سكربتها في `gateDir` يعمل على المستودع
    بالتصميم، وتحميه ACL ملفات الثقة.
- **ACL المجلد الأب المباشر (Codex P1):**
  - حدود الثقة تشمل المجلد الأب المباشر لـ`gateDir`، ويُحسب من المسار لا بقيمة ثابتة (حالياً
    `C:\ProgramData\OZK-TOBACCO`)، إضافة إلى `gateDir` وملفات الثقة.
  - أي principal غير هوية البوابة يملك على الأب واحداً مما يلي ⇒ حجب:
    - حذف أو إعادة تسمية الأبناء (`DeleteSubdirectoriesAndFiles`).
    - إنشاء بديل (`CreateDirectories`/`CreateFiles`/`Write`).
    - `Delete`، أو `Modify`/`FullControl`، أو `ChangePermissions`/`TakeOwnership`، أو GENERIC_WRITE/ALL.
  - صريحاً كان أو موروثاً.
  - مالك الأب يجب أن يكون هوية البوابة، لأن للمالك WRITE_DAC ضمنياً.
  - تعذّر قراءة ACL الأب، أو ACE غير قابل للتفسير أو للحل إلى SID ⇒ حجب.
  - سلامة ACL داخل `gateDir` لا تكفي إذا كان الأب يسمح بالاستبدال.
  - نتيجة التصميم: الأب يجب أن يكون تحت سيطرة هوية البوابة حصراً، فيُنقل ما لا يخصّ البوابة (مثل
    `TaskWrappers`) أو يوضع `gateDir` تحت أب مخصّص. يُحسم ذلك في مرحلة bootstrap.
  - **سلسلة الأسلاف حتى مرسى الثقة (Codex P1):**
    - السلسلة المحمية: `gateDir`، ثم الأب المباشر (كلاهما حصري للبوابة)، ثم كل سلف أعلى حتى
      `trust.trustAnchor` شاملاً (حالياً `C:\ProgramData`؛ ليس جذر القرص).
    - على الأسلاف لا تُشترط الحصرية، بل تُحلَّل **قدرة الاستبدال الفعلية** وفق دلالات ACL في Windows:
      - حذف أو إعادة تسمية ابن: `DeleteSubdirectoriesAndFiles` على المستوى، أو `Delete` على المستوى نفسه
        (فيُزاح ويُنشأ بديل مكانه).
      - السيطرة: `ChangePermissions` (WRITE_DAC)، أو `TakeOwnership` (WRITE_OWNER)، أو GENERIC_ALL،
        أو الملكية (للمالك WRITE_DAC ضمنياً).
      - ما لا يُعد قدرة استبدال: الإنشاء وحده (`CreateDirectories`/`CreateFiles`/`WriteData`
        أو GENERIC_WRITE) و`WriteAttributes`، لأنها لا تستبدل مجلداً قائماً غير فارغ.
      - ACE بعلَم InheritOnly لا تنطبق على المستوى نفسه؛ أبناؤه مستويات تُقرأ ACL الفعلية لكل منها.
      - Deny لا يُحتسب حماية (تحفّظاً)، والمجموعات لا تُفكّك: أي SID غير موثوق بقدرة استبدال ⇒ حجب.
    - **ثقة إدارة النظام** مقابل **ثقة repo workloads المؤتمتة**:
      - على الأسلاف تُعد SYSTEM وAdministrators وTrustedInstaller وأعضاء Administrators المحليون (بالـSID)
        ثقة إدارة نظام، فلا يحجب وجودهم على ProgramData بحد ذاته.
      - هذا مشروط بالحارس المستقل: أي repo workload مؤتمت بإحدى هذه الهويات يحجب Initialize. إذاً
        لا يوجد كود مستودع مؤتمت يستطيع استغلال تلك الصلاحيات.
      - عضوية Administrators غير محسومة (أو عضو لا يُحلّ) ⇒ لا يُعتمد أحد بالعضوية.
      - لا يُدّعى أي حماية من مدير محلي بشري خبيث.
    - أي ACL لازمة لا تُقرأ أو لا تُفسَّر، أو مالك لا يُحلّ، أو ACE قادرة على الاستبدال بهوية لا تُحلّ ⇒ حجب.
      غياب `trustAnchor`، أو مرسى ليس سلفاً فوق الأب المباشر، أو مرسى يساوي الأب ⇒ حجب.
    - المرسى نفسه يديره النظام: إزاحته تتطلب حقوقاً على أبيه (`C:\`) لا يملكها افتراضياً إلا حسابات إدارة
      النظام. هذا حدّ موثّق، لا فحص.
  - **توصية bootstrap: أب مخصّص للبوابة.**
    - الأب المباشر يبقى حصرياً للبوابة (قرار سابق)، و`C:\ProgramData\OZK-TOBACCO` يحوي `TaskWrappers`
      وملفات تشغيلية أخرى، فلا يستوفي ذلك دون نقلها.
    - الأفضل أن تنشئ مرحلة bootstrap أباً مخصّصاً لا يحوي أي workload آخر، مثلاً
      `C:\ProgramData\OZK-DeployGate\gate`، بحيث:
      - `gateDir` والأب المخصّص حصريان للبوابة.
      - `C:\ProgramData` مرسى الثقة، ويُحلَّل بقدرة الاستبدال.
    - لم يتغيّر المسار الحي، ولم تُنقل `TaskWrappers`، ولم تُعدَّل ProgramData. تغيير `gateDir` في الإعداد قرار
      bootstrap بموافقة المالك.
  - لا يُدّعى أي حماية من مدير محلي بشري خبيث.
- **مهام بـGroupId ونوع الـprincipal (Codex P1):**
  - الجرد يسجّل لكل مهمة نوع الـprincipal صراحة من تعريفها:
    - `USER`: فيها UserId وحده.
    - `GROUP`: فيها GroupId وحده.
    - `UNKNOWN`: فيها الاثنان، أو لا شيء، أو LogonType=Group مع UserId، أو السجل بلا نوع.
  - ويسجّل RunLevel: `LeastPrivilege` أو `HighestAvailable` أو `UNKNOWN`.
  - SID المجموعة ليس هوية التنفيذ: المهمة تعمل ضمن جلسة أي عضو، وقد يكون مديراً، مرفوعاً مع
    `HighestAvailable`. لا يُختار عضو افتراضي، ولا يُحكم بامتياز المجموعة نفسها (Users أو
    Administrators أو محلية أو مجال).
  - القاعدة:
    - GROUP + REPO ⇒ حجب، وGROUP + UNKNOWN ⇒ حجب، حتى مع `LeastPrivilege`. `HighestAvailable` يُذكر
      صراحة في السبب.
    - GROUP + NOT_REPO ⇒ لا حجب بهذه القاعدة وحدها.
    - GROUP مع RunLevel غير مقروء ⇒ حجب (fail-closed).
  - نوع principal غير محسوم + REPO/UNKNOWN ⇒ حجب.
  - USER بلا تغيير: SYSTEM والمدراء وأعضاء Administrators مميّزون، وغيرهم حسب القواعد القائمة. RunLevel
    لا يرفع مستخدماً غير مدير.
  - مهمة البوابة: هوية USER المخصّصة حصراً، وGroupId أو نوع غير محسوم ⇒ حجب.
  - التدقيق: كل عنصر مُجرَد يُعاد في `workloads`، ويُسجَّل في `preflight_workloads` بسجل Initialize ويُطبع
    `AUDIT` من سطر الأوامر: النوع، وUserId/GroupId، والـSID، وRunLevel، وREPO/NOT_REPO/UNKNOWN، والنتيجة
    وسببها. بلا أسرار.
- **آلة حالات التثبيت والنشر (Codex P1):**
  1. **BOOTSTRAP** (مرحلة منفصلة بموافقة المالك، لم تُنفَّذ):
     - تنشئ المتطلبات: الحساب المخصّص، و`gateDir` بـACL صريحة، ومهمة البوابة.
     - تسجّل المهمة **Disabled**، والـAction = المفسّر المعتمد + `-File <gateDir>\deploy-gate.ps1 -Mode DryRun` حرفياً.
     - لا نشر إنتاجي.
  2. **INITIALIZE** (`-Mode Initialize`): يتحقق fail-closed من كل المتطلبات، ولا ينجح إلا بمهمة بوابة
     واحدة **Disabled** بـ`-Mode DryRun` حرفياً ومرة واحدة.
     - `-Mode Deploy` ⇒ حجب.
     - غياب `-Mode` ⇒ حجب، لأن قيمة السكربت الافتراضية Deploy.
     - مهمة Enabled أو Running ⇒ حجب.
     - حالة غير مقروءة، أو Mode مكرر ⇒ حجب.
  3. **DRYRUN**: بعد نجاح Initialize فقط تُفعَّل المهمة على `-Mode DryRun`.
     - كل تشغيل DryRun يُسجَّل في `audit.jsonl` (ومنه NOOP) كدليل.
     - الـ24 ساعة لا تكفي زمنياً وحدها. المطلوب تشغيلات DryRun ناجحة (`DRYRUN`/`NOOP`) متصلة تغطي
       النافذة كلها، بفجوة لا تتجاوز `dryRunSoak.maxGapMinutes` (30).
     - لا تشغيل آخر ولا نتيجة أخرى داخل النافذة. `dryRunSoak.hours` لا يقل عن 24 مهما ضُبط.
  4. **DEPLOY**: لا يصبح مسموحاً بنجاح Initialize.
     - `-Mode Deploy` يتوقف (STOP مع تنبيه) ما لم يوجد ملف الثقة `deploy-transition.json`:
       - `kind = ozk-deploy-transition`، و`approvedBy`، و`soakStartUtc`/`soakEndUtc`.
       - يثبت سجل التدقيق النافذة الكاملة بعد Initialize ناجح، ولا تنتهي النافذة في المستقبل.
     - **حالة الانتقال: غير منفَّذ.** إنشاء `deploy-transition.json` (بعد مراجعة المالك لنافذة الـDryRun)
       وتبديل Action المهمة إلى Deploy خطوة المرحلة التالية. هذا الـPR لا ينشئهما، فـDeploy محجوب
       fail-closed.
- **جرد Startup/Logon (Codex P1):**
  - الجرد لا يقتصر على المهام والخدمات: مجلد Startup العام، وHKLM Run/RunOnce (و`WOW6432Node`)،
    ومجلد Startup ومفاتيح HKU Run/RunOnce لكل ملف تعريف مستخدم (`S-1-5-21-*`).
  - تُصنَّف العناصر بالنموذج الثلاثي نفسه: حقول منظّمة، `.lnk` بهدفه ووسائطه ومجلد عمله، وتتبّع الأغلفة،
    وfail-closed للبيئة، وتطبيع المسارات.
  - الهوية التي يعمل تحتها العنصر فعلياً:
    - مصادر الجهاز تعمل عند دخول أي مستخدم، ومنهم المدراء ⇒ تُعامل كـAdministrators.
    - مصادر المستخدم تعمل بـSID ذلك المستخدم، وتُقيَّم عضويته في Administrators بالـSID.
  - مصدر لا يُقرأ يعني UNKNOWN، مع هوية ذات صلاحية ⇒ حجب:
    - مجلد أو اختصار لا يُقرأ.
    - ملف يُفتح عبر ارتباط نوع.
    - hive مستخدم غير محمّل: لا نحمّله لأن ذلك تعديل.
  - تعذّر الجرد كله ⇒ حجب. غلاف فيه مرجع سكربت نسبي (مثل `node scripts/serve.mjs` بلا مجلد عمل
    مثبت) ⇒ UNKNOWN.
  - الحالة المعروفة: LOQ logon ← `OZK-Tobacco-Server.vbs` ← `node scripts/serve.mjs` ← repo workload، وLOQ
    عضو Administrators ⇒ **Initialize BLOCKED**، حتى بعد نقل كل المهام.
  - متطلب تشغيلي للمرحلة التالية: ملفات تعريف المدراء وهوية البوابة التي لا يُقرأ hive الخاص بها تحجب.
    يجب أن يُحسم مسار موثوق لجرد Run/RunOnce الخاصة بهم (دون تحميل hive من هذا الفحص)، أو إزالة
    الحاجة إليه، قبل Initialize.
- **تصنيف ثلاثي الحالة لحقول الـAction (Codex P1):**
  - كل مهمة وخدمة تُصنَّف: `REPO` أو `NOT_REPO` أو `UNKNOWN`. الأولوية: REPO ثم UNKNOWN ثم NOT_REPO.
  - UNKNOWN لا يسقط أبداً إلى NOT_REPO. مع هوية ذات صلاحية (SYSTEM، Administrators، عضو فيها،
    هوية مجهولة) ⇒ حجب.
  - حقول الـAction (`Execute` و`Arguments` و`WorkingDirectory`) تُحلَّل منفصلة ولا تُدمج في سطر واحد:
    - البرنامج لا يبتلع الوسائط ولا مجلد العمل.
    - مجلد العمل مطلق فقط، وإن كان داخل المستودع ⇒ REPO.
    - الهدف النسبي يُحلّ بالنسبة لمجلد العمل ثم يُطبَّع؛ بلا مجلد عمل ⇒ UNKNOWN.
  - أوامر لا يمكن إثبات هدفها ساكناً ⇒ UNKNOWN:
    - PowerShell `-EncodedCommand` (و`-e`/`-ec`/`-enc`)، و`-Command` غير الثابت، و`-Command -`،
      والوسيط الموضعي غير الثابت، والمعامل غير المعروف أو الملتبس.
    - `cmd` بلا `/c`، أو مع `if`/`for`/كتل/`^`، أو مقطع لا يُحلَّل.
    - `wscript`/`cscript` بلا سكربت، ومفسّر (node/python/...) بشيفرة مضمّنة أو بلا هدف ثابت.
    - اقتباس مكسور أو ملتبس، ومراجع بيئة غير محلولة، وCOM handler غير محلول، ومهمة بلا Actions.
    - داخل الأغلفة: حمولة مشفّرة، أو `FromBase64String`، أو `Invoke-Expression`/`iex`.
  - التحليل ساكن للقراءة فقط؛ لا يُشغَّل أي أمر أو غلاف.
- **Initialize يتطلب مهمة بوابة واحدة بالضبط (Codex P1):**
  - صفر مهام ⇒ حجب. أكثر من مهمة بالاسم نفسه ⇒ حجب.
  - المهمة الوحيدة يجب أن تكون في `trust.gateTaskPath` (`\`)، بهوية تُحلّ إلى SID البوابة، وبـAction
    حرفي عبر `Test-ExactGateAction` (مجلد عمل فارغ أو `gateDir`، ولا COM handler).
  - هوية غير مقروءة، أو Action غير مقروء، أو هوية خاطئة، أو Action خاطئ ⇒ حجب.
  - أي مهمة أخرى تشبه البوابة (اسماً، أو تشغّل `deploy-gate.ps1`، أو تمسّ `gateDir`) ⇒ حجب.
  - التخطيط الحالي على OZK2026 يبقى BLOCKED حتى مرحلة التثبيت المنفصلة.
- **مراجع البيئة داخل الأغلفة تُغلق الفحص (Codex P1):**
  - `Expand-TraceText` يُطبَّق بالتساوي على Action المهمة وعلى جسم كل غلاف في السلسلة (حتى 3 مستويات).
  - الصيغ المغطاة:
    - CMD: `%VAR%` و`!VAR!`.
    - PowerShell: `$env:VAR` و`${env:VAR}` و`[Environment]::GetEnvironmentVariable`.
    - VBS: `.Environment(...)`.
  - أسماء البيئة تُطابق بلا حساسية لحالة الأحرف.
  - يُحلّ فقط ما يمكن إثباته ساكناً:
    - متغيّرات ملف تعريف هوية المهمة.
    - متغيّرات النظام القياسية.
    - `%~dp0` و`$PSScriptRoot`، وكلاهما مجلد الغلاف نفسه.
  - الناتج يُطبَّع (`..` و`.`) قبل فحص الجذور. إن وصل إلى المستودع يُطبَّق حارس الصلاحيات.
  - أي مرجع غير محلول يعني undetermined، ولا يُعامل أبداً على أنه «ليس مستودعاً». مع هوية ذات صلاحية ⇒ حجب.
  - التحليل ساكن للقراءة فقط؛ لا يُشغَّل أي غلاف.
- **المقارنة بالـSID لا بالاسم (Codex P1):**
  - كل قرار ثقة يحلّ الأسماء إلى SID قبل المقارنة:
    - هوية البوابة، والهويات المرفوضة، وكتّاب ملفات الثقة.
    - هويات المهام والخدمات، وأعضاء Administrators.
    - مالك الـACL وACEs، التي تُقرأ بالـSID مباشرة عبر `GetOwner` و`GetAccessRules` مع `SecurityIdentifier`.
  - لذلك `OZK2026\OZK-DeployGate` و`DOMAIN\OZK-DeployGate` حسابان مختلفان إذا اختلف الـSID،
    والحساب نفسه بصيغ مختلفة (SID، حالة أحرف، `.\name`) حساب واحد.
  - هوية البوابة يجب أن تكون مؤهَّلة (`MACHINE\name`) أو SID؛ الاسم المجرّد مرفوض.
  - أي principal يلزم قرار الأمان ولا يُحلّ إلى SID ⇒ حجب، ومنه: عضو Administrators غير محلول، أو
    مجموعة متداخلة داخل Administrators.
- **فحوص تثبيت إضافية (Codex P1، جميعها fail-closed):**
  - **جرد الخدمات:** `Get-CimInstance Win32_Service -ErrorAction Stop`. أي استثناء (WMI/CIM، رفض
    وصول، RPC) أو قائمة فارغة يعني حجباً، فالقائمة الفارغة ليست دليلاً على غياب الخدمات.
  - **Action مهمة البوابة حرفياً:**
    - Action واحد فقط.
    - المفسّر `trust.gateInterpreter`، أي Windows PowerShell 5.1 بالمسار الكامل.
    - مفاتيح محددة فقط: `-NoProfile`، `-NonInteractive`، `-NoLogo`، `-ExecutionPolicy`، `-WindowStyle Hidden`.
    - ثم `-File <gateDir>\deploy-gate.ps1` بمسار مطلق قانوني. لا `..`، ولا متغيرات بيئة، ولا
      مسار نسبي.
    - ثم `-Mode Deploy|DryRun` فقط.
    - يُرفض: `-Command`، `-EncodedCommand`، الاختصارات، أغلفة cmd/bat، ملف تنفيذي آخر، سكربت آخر،
      وسائط إضافية، وأي سطر لا يمكن تفسيره بلا لبس.
  - **ACL الفعلية لا الإعداد المعلن** (`Test-GateTrustAcl`، يقرأ بـ`Get-Acl` قراءة فقط):
    - تُفحص `gateDir` وكل ملف ثقة موجود، والملفات التنفيذية والإعداد إلزامية الوجود.
    - الشروط: المالك هو الهوية المخصّصة، ولا ACE من نوع Allow يمنح أي حق كتابة لغيرها، صريحاً
      كان أو موروثاً.
    - حقوق الكتابة المقصودة: WriteData/CreateFiles، AppendData، Write*Attributes،
      DeleteSubdirectoriesAndFiles، Delete، ChangePermissions، TakeOwnership، Modify،
      FullControl، GENERIC_WRITE، GENERIC_ALL.
    - لا يُعدّ Users، ولا OZKSync، ولا LOQ، ولا SYSTEM، ولا Administrators كاتباً مسموحاً.
    - يعني حجباً: فشل `Get-Acl`، أو حقوق لا تُفسَّر، أو نوع ACE غير معروف، أو هوية أو SID غير
      محلولَين مع حق كتابة، أو غياب ملف إلزامي.
    - لا تُحتسب ACEs من نوع Deny منحاً، ولا تُعدّ مُلغية لـAllow (تحفّظاً).
    - هذا الفحص يثبت أن ACL لا تمنح أتمتة المستودع كتابة مباشرة. لا يدّعي منع مدير بشري من
      الاستيلاء.
  - **مكان المهمة لا يمنح استثناء:**
    - يُجرد كل Scheduled Task بلا ترشيح حسب `TaskPath`، ومنها `\Microsoft\`.
    - مهمة تشغّل كود مستودع أو تصل إليه تُفحص كاملاً أياً كان مكانها، سواء كان الوصول مباشراً،
      أو عبر سلسلة أغلفة vbs/cmd/bat/ps1 حتى 3 مستويات، أو عبر مجلد عمل داخل المستودع، أو عبر
      مسار بمتغيّر بيئة.
    - متغيّرات المستخدم تُوسَّع بملف تعريف هوية المهمة نفسها، ومتغيّرات النظام بقيمها القياسية.
    - مهام Windows الأصلية التي لا تصل إلى أي مستودع تُتجاهل لهذا الحارس، ولا تُحجب لمجرد
      وجودها أو صلاحيتها.
    - مهمة ذات صلاحية (أو بهوية غير معروفة) لا يمكن إثبات أنها لا تصل إلى المستودع تعني حجباً
      (fail-closed): غلاف موجود لا يُقرأ، أو عمق أكبر من 3، أو متغيّر بيئة غير معروف.
- **شرط تثبيت إلزامي — ACL صريحة قبل Initialize:**
  - التثبيت المستقبلي يجب أن ينشئ `gateDir` وملفات الثقة بـACL **صريحة** تحقق العقد: الهوية
    المخصّصة مالكة وكاتبة وحيدة.
  - يعطّل الوراثة من ProgramData (أو يزيل ما يرثه)، ثم يشغّل `Initialize`.
  - إذا بقيت ACL موروثة من ProgramData تمنح SYSTEM، أو Administrators، أو CREATOR OWNER، أو
    أي principal آخر قدرة كتابة، يبقى `Initialize` **BLOCKED**.
  - لا يُخفَّف فحص ACL كي ينجح التثبيت، ولا تُنفَّذ أي تغييرات ACL في هذه المرحلة.
- **شرط تثبيت إضافي (قرار المالك 2026-09-28): لا يجوز لأي repo workload مؤتمت أن يعمل بحساب
  SYSTEM أو Local Administrator.**
  - أي مهمة أو خدمة تشغّل ملفاً تنفيذياً أو سكربتاً من المستودع التشغيلي، أو من جذور
    `trust.repositoryRoots`، بإحدى هذه الهويات تحجب `Initialize` والتثبيت (fail-closed)، بغض
    النظر عن قائمة كتّاب ملفات الثقة:
    - SYSTEM (`LocalSystem`، `S-1-5-18`).
    - مجموعة Administrators.
    - حساب عضو في Administrators المحلية.
    - هوية البوابة المخصّصة نفسها.
  - السبب: هذه الهويات تتجاوز ACL وتستولي على ملفات الثقة تقنياً، حتى لو لم تكن مدرجة ككاتب.
  - تعذّر تحديد عضوية Administrators، أو تعذّر جرد المهام والخدمات، يعني حجباً.
  - مهمة ذات صلاحية عالية لا تشغّل كوداً من أي مستودع (مثل Backup Monitor من ProgramData) لا
    تُحجب لكونها ذات صلاحية فقط.
- **النتيجة على تخطيط OZK2026 الحالي: التثبيت BLOCKED.** المهام الحاجبة:
  - `OZK-AmeenAutoPrint` ← SYSTEM ← كود المستودع (`run-watcher.bat`).
  - مهام المستودع التي تعمل بحساب LOQ، وهو عضو Administrators: Ameen Read Worker، Khalil
    Audit Sync، Item Costs Push، Item Numbers Pull، Sales Line Items Push، Ameen Item Snapshot
    Refresh، Documents Archive.
- **مرحلة لاحقة قبل التثبيت (لم تُنفَّذ):** migration منفصلة تنقل المهام الحالية ذات الصلاحيات
  العالية إلى هويات خدمة بأقل صلاحية (least-privilege)، ثم إعادة الفحص حتى يعطي PASS.
  لا نقل لـAutoPrint، ولا تغيير لـLOQ أو للمهام الآن.
- المدير البشري المحلي يبقى قادراً على تجاوز ACL، وهذا تهديد خارج هدف هذه الحماية. الهدف ألا
  يملك أي كود مستودع مؤتمت صلاحية تتجاوز حدود ثقة البوابة.
- **الإثبات الساكن** (`check-windows-deploy-gate.mjs`):
  - المشغّل لا يكتب إلا في `logDir`.
  - كل ملفات الثقة تحت `gateDir`.
  - البوابة لا تكتب داخل المستودع إلا عبر git.
  - `logDir` خارج `gateDir`.
- **لم يُنفَّذ منه شيء:** لا أغلفة vbs، ولا مهام، ولا صلاحيات.

## #282 وانحراف رقم نسخة الـmigration في Supabase

- **#282 SUPABASE MIGRATION: PRESENT.** التحقق قراءة فقط، في 2026-09-28:
  - `public.prune_ameen_warehouse_stock_reports(timestamptz, integer)` موجودة، وترجع integer.
  - SECURITY DEFINER.
  - EXECUTE لـ`authenticated` لا لـ`anon`.
  - التعريف الحي يطابق #282، بما فيه `FOR UPDATE SKIP LOCKED` وحارسا المفتاحين الأجنبيين بالاسم.
- **CONTENT MATCH: YES.**
- **VERSION ID DRIFT:**
  - المستودع `20260928140000`.
  - الحي `20260928145121`، مسجّل باسم `prune_ameen_warehouse_stock_reports`.
- **ACTION TAKEN: NONE، ولا إجراء مطلوب.** اختلاف رقم النسخة وحده لا يبرر إعادة تطبيق
  الـmigration ولا تعديل Supabase، ما دام المحتوى الحي المطلوب موجوداً ومطابقاً.

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
| البوابة المعتمدة | `C:\ProgramData\OZK-TOBACCO\DeployGate\` (كتابة لهوية البوابة المخصّصة وحدها) |
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
   - فرع `windows-production` على خط الأساس `88ae841` (أُنشئ 2026-09-28).
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
4. **مرحلة bootstrap/install منفصلة ومحكومة (Codex P1 — قبل Initialize، بموافقة المالك):**
   - تنشئ المتطلبات التي يتحقق منها Initialize ولا تنشئ غيرها:
     1. الحساب المحلي المخصّص `OZK2026\OZK-DeployGate` (ليس عضواً في Administrators).
     2. `gateDir` وملفات الثقة بـACL صريحة (راجع «ACL صريحة قبل Initialize»).
     3. مهمة «TOBACCO Windows Deploy Gate» واحدة في `\` **معطّلة (Disabled)**، بالهوية المخصّصة
        وبالـAction الحرفي: المفسّر المعتمد + `-File <gateDir>\deploy-gate.ps1 -Mode DryRun`.
        لا غلاف، ولا Action إضافي، ومجلد عمل فارغ أو `gateDir`.
   - لا تُشغّل المهمة في هذه المرحلة، ولا تُنفَّذ على Windows ضمن هذا الـPR.
5. تبديل الفرع المحلي بلا تغيير ملفات: `git switch -c windows-production --track origin/windows-production`
   عندما يكون HEAD مساوياً له. ثم `deploy-gate.ps1 -Mode Initialize`:
   - يعيد الفحص الكامل ويرفض التسجيل إذا لم ينجح.
   - لا ينجح إلا بوجود **مهمة بوابة واحدة بالضبط** مسجّلة ومقروءة ومطابقة للعقد.
   - لا تناقض دائري: المهمة تُسجَّل معطّلة في bootstrap، ثم يتحقق منها Initialize (fail-closed)،
     ولا تُفعَّل إلا بعده.
6. توجيه المهام إلى `run-repo-task.ps1` واحدة واحدة، والكاتب في النهاية.
7. تفعيل مهمة «TOBACCO Windows Deploy Gate» المسجّلة في bootstrap (الهوية المخصّصة، لا SYSTEM) كل
   10 دقائق، بوضع `-Mode DryRun` **24 ساعة كاملة** قبل أول نشر حقيقي. لا نشر إنتاجي فوري.
   Deploy لا يُسمح إلا بانتقال منفصل مثبت (راجع «آلة حالات التثبيت والنشر» أدناه).
8. تمارين:
   - إصدار توثيقي.
   - إصدار PS1 قراءة.
   - إصدار كاتب بموافقة صريحة.
   - رجوع في نسخة تدريب.
9. إلغاء `tools/daily-git-pull.ps1` في المستودع، وإبقاء المهمة معطّلة.
10. تحسين منفصل: `StartWhenAvailable`، وتنبيهات «نشر معلّق» و«بوابة صامتة».
