# بوابة نشر Windows (OZK2026)

## الحالة الحالية

- **2026-09-28 — المرحلة 0 (منفّذة على الجهاز بموافقة المالك):** عُطّلت مهمة
  «TOBACCO Daily Git Pull». لم يعد الدمج إلى `main` يصل تلقائياً إلى OZK2026.
  الجهاز متجمّد على `1812c08` إلى أن تُفعَّل البوابة. التعطيل لم يغيّر الـTrigger
  ولا الـAction، والرجوع عنه يكون بـ `Enable-ScheduledTask -TaskName 'TOBACCO Daily Git Pull'`.
- **المرحلة 1 (هذا التقرير):** الكود المرجعي للبوابة، والـworkflow، والاختبارات،
  والتوثيق، داخل المستودع فقط. لم يُثبَّت شيء على OZK2026 بعد، ولم يُنشأ فرع
  `windows-production` ولا Environment ولا Ruleset. كل ذلك خطوات مالك لاحقة.
- **2026-10-20 — تدقيق قراءة فقط على OZK2026:** الجهاز **ليس** على `1812c08`. الـreflog يُظهر
  دمجاً يدوياً بعد التعطيل (09-28 الساعة 18:48، ثم 10-01)، فهو على `main@1843024`، بينما `windows-production` على
  `88ae841`، أي **متأخر عن الجهاز بـ39 commit**. التبديل إليه كما هو رجوع صامت بالإنتاج.
  الملفات الثلاثة لنبض مزامنة الأسعار منسوخة يدوياً (10-18)، ومطابقة بايتاً لـmain. البوابة غير مثبّتة.
  أُصلحت في المرجع ست ثغرات كشفها التدقيق (القسم «حمايات تدقيق 2026-10-20» أدناه). لم يُثبَّت شيء على الجهاز.
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
    - مخصّص فقط للمهام المعلنة في `mainDependentTasks`. **القائمة فارغة منذ 2026-10-25**:
      مزامنة النشرات `OZK-PriceListSync` متقاعدة (معطّلة منذ 2026-09-07، والنشرات من
      `generate-price-lists.yml`)، فانتقلت إلى `retiredMainTasks`.
    - `retiredMainTasks` استثناء محصور بهذه المهمة وحدها (`check-windows-deploy-gate.mjs`
      يفرض ذلك): لا تُطلب لها worktree، لكن الفحص يحجب إن كانت مفعّلة أو غير مرئية. البوابة
      لا تعدّل تعريفها ولا تحذفها. حذف المهمة من Windows لاحقاً يستلزم إزالتها من القائمة.
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

## حمايات تدقيق 2026-10-20

| # | الثغرة | الإصلاح |
|---|---|---|
| a | `scripts/serve.mjs` ليس الخادم المحلي الحي. المهمة `TOBACCO Local Web Server` تشغّل `ProgramData\LocalWebServer\server.mjs`، وجذره المستودع | `liveServedFromRepo`: التدقيق يسجّل `live_served_changed`. لا إعادة تشغيل (الملفات تُقرأ لكل طلب) |
| b | AutoPrint مشغّله Logon لا ONSTART | وصف `runner` الصحيح مع `taskName` |
| c | مهمتا النسخ الاحتياطي تمرّران `tools/send-telegram-notification.ps1` من المستودع | ضمن `pauseTasks`. ولأن كودهما مثبّت خارج المستودع، فهما في `routingExempt` ويخضعان لـ`startGuardSeconds` |
| d | `tobacco-web-main` على الجهاز HEAD منفصل على `3c122d1` | الفحص المسبق يسمّيه «detached HEAD» ويحجب (fail-closed). إصلاحه خطوة مالك |
| e | المهام غير الموجَّهة لا ترى `deploying.flag`، فتبدأ بين فحص الخمول والتبديل | Deploy يتوقف (STOP) ما دامت أي مهمة مفعّلة غير موجَّهة عبر `run-repo-task.ps1`، وDryRun يحذّر فقط. المعفاة يُرفض التبديل إن اقترب موعدها. وكل الشروط يُعاد فحصها بعد الانتظار مباشرة: HEAD، الشجرة، `index.lock` وأمثاله، والمواعيد |
| f | Read Worker غير مرئي لـOZKSync، والفحص القديم كان يعدّ المهمة غير المرئية «متوقفة» | أي مهمة من `pauseTasks` أو `longRunningComponents[].taskName` لا يراها حساب البوابة = STOP. شغّل البوابة كـSYSTEM |

حمايات إضافية:
- **لا إصدار أقدم من الجهاز:** `deviceBaselineSha` (اليوم `1843024`) يجب أن يحويه كل هدف. يفرضه
  `windows-release-verify.mjs` قبل الموافقة، و`windows-release-apply.mjs` قبل الدفع، والبوابة قبل التبديل.
  و`Initialize` يرفض فرعاً متأخراً عن الجهاز («behind the device») بدل التبديل إليه.
- **سكربت تشغّله مهمة:** إصدار يحذف سكربتاً موجوداً في HEAD = STOP. سكربت مفقود أصلاً (Invoice
  Watcher → `tools/watch-customer-invoices.ps1` الذي لم يُدمج قط) = تحذير مسجَّل فقط.
- **قفل حصري** (`Enter-GateLock`، ‏`FileShare None`): أي نسخة ثانية تخرج فوراً دون أي مساس.
- **نسخة احتياطية + SHA256** في `backups\<id>\`:
  - قبل أي إيقاف أو تبديل: نسخة من كل ملف متغيّر مع `preSha256` والـblob المتوقَّع، وتُتحقَّق النسخة نفسها.
  - فشل النسخ = FAIL بلا أي تغيير.
  - بعد التبديل: كل ملف يطابق blob الهدف (`git hash-object`)، ويُسجَّل `postSha256`.
  - عدم التطابق = FAIL، والعلم يبقى، والحالة لا تتقدّم.
- **`inflight.json` و`-Mode Recover`:**
  - تبديل انقطع في منتصفه (HEAD لم يتقدّم والشجرة متّسخة) يمنع أي نشر لاحق.
  - `Recover` يعيد كل ملف من النسخة مع التحقق من SHA256، وينقل الملفات التي أضافها التبديل الناقص إلى `quarantine` بلا حذف.
  - ثم يشترط شجرة نظيفة، ولا يستعمل أي أمر git كاتب.
  - إذا كان HEAD قد تقدّم = مراجعة يدوية.
- **التراجع يُسجَّل أيضاً (Codex P1 على #337):** يُكتب `inflight.json` بـ`mode: "Rollback"` قبل `reset --keep`،
  ومعه from وto والنسخة الاحتياطية والفرع و`pendingRestart`. `Recover` يتصرّف حسب الحالة:
  - HEAD على from: يتراجع عن التراجع الناقص من النسخة.
  - HEAD على to: يكمله فقط إذا طابق كل ملف blob الهدف والشجرة نظيفة، ثم يسجّل `ROLLED_BACK_PINNED`.
  - غير ذلك: STOP.
  - رفض git النظيف (لم يُكتب شيء) يزيل السجل والعلم.
- **التراجع يخضع لحارس المهام نفسه (Codex P1 الثاني على #337):**
  - مهمة غير مرئية أو غير موجَّهة = STOP قبل أي نسخ أو `reset --keep`.
  - بعد الانتظار تُعاد كل الفحوص: الظهور، المواعيد القريبة، عملية git جارية، HEAD، الشجرة.
  - `Wait-TasksIdle` الحقيقي يعدّ المهمة غير المرئية «مشغولة» لا خاملة.
  - أي مهمة من `pauseTasks` حالتها Running عند إعادة الفحص (بدأت بعد انتهاء الانتظار) تمنع التبديل،
    حتى لو كان موعدها التالي بعيداً. الثمن SKIP عابر أحياناً مع مهام الدقيقة الواحدة، ويُعاد في الدورة التالية.
- **سجل العملية يُزال آخراً:** إنهاء النشر والتراجع (عادياً أو من Recover) يكتب البصمات ثم الحالة ثم يزيل العلم،
  ثم ينسخ `inflight.json` إلى النسخة الاحتياطية ويزيله. توقّف في أي نقطة قبل ذلك يُبقي السجل،
  فيكمل `Recover` التالي العمل من جديد.
  - نشر حرّك HEAD ثم توقف قبل تسجيل الحالة: يكمله `Recover` (تُسجَّل الحالة والبصمات و`pendingRestart`)
    فقط إن طابق كل ملف blob الهدف والشجرة نظيفة، دون إعادة كتابة أي ملف. وإلا مراجعة يدوية.
- **Recover يخضع لحارس المهام نفسه (Codex P1 على #337):**
  - قبل إعادة كتابة أي ملف: مهمة غير مرئية أو غير موجَّهة = STOP.
  - ثم يُضمن قيام العلم، وانتظار الخمول، وإعادة الفحص (Running، المواعيد القريبة، عملية git، HEAD).
  - أي فشل = SKIP دون أي مساس.
- **فهرس git:**
  - يُنسخ `.git\index` إلى النسخة الاحتياطية (`git-index` مع `indexSha256`) قبل كل تبديل.
  - تبديل انقطع بعد كتابة الفهرس وقبل تحريك HEAD يُستعاد كاملاً: الفهرس أولاً (بعد التحقق من بصمته)، ثم الملفات.
  - نسخة فهرس معدّلة = STOP.
- **Recover بلا تخمين:**
  - يتوقف (STOP) دون أي مساس إذا كان `inflight.json` تالفاً أو فارغاً أو بنمط مجهول أو SHA غير صالح، أو كانت نسخته خارج `backups`، أو لا يطابق الـmanifest، أو كانت نسخة احتياطية معدّلة.
  - السجل المفقود مع علم قائم أو شجرة متّسخة = STOP.
  - بعد استعادة ناجحة يُنقل السجل إلى `inflight.recovered.json` داخل النسخة، فتكرار `Recover` يعطي NOOP دون أي تغيير.

**قبل Initialize على الجهاز (خطوة مالك):** إعادة تأسيس تجعل HEAD يساوي `windows-production`، مع شجرة نظيفة.
تُطبَّق الملفات الثلاثة المنشورة يدوياً عبر الـindex فقط بعد التحقق أن blob كل منها يطابق الهدف، ثم `merge --ff-only`.
اختُبر هذا بمحاكاة على نسخة: لم يتغيّر أي بايت ولا mtime في الملفات التشغيلية.

## هوية الإصدار: GitHub App «OZK Windows Release» (2026-10-21)

| العنصر | القيمة |
|---|---|
| التطبيق | `OZK Windows Release`، App ID `5412959`، خاص، مثبّت على `tobacco-web` وحده (التثبيت `173807509`) |
| صلاحيات التطبيق | Contents RW وWorkflows RW وMetadata R، ولا شيء غيرها. Workflows لازمة لأن الإصدارات تقدّم commits تعدّل `.github/workflows` |
| الأسرار | `RELEASE_APP_ID` و`RELEASE_APP_PRIVATE_KEY` في بيئة `windows-production` وحدها |
| الإعداد | `releaseApp` في `gate-config.example.json`: المعرّفان والصلاحيتان، ويُرفض أي اختلاف |

### مسار الإصدار في `windows-release.yml`

1. **التشغيل:** `workflow_dispatch` فقط، وكل job بشرط `github.ref == 'refs/heads/main'`. لا يعمل بسبب PR أو دمج، ولا يشغّل كود فرع غير مدموج.
2. **job الفحص:** بلا أي سرّ.
3. **job الإصدار:**
   - لا يبدأ إلا بعد موافقة المالك في بيئة `windows-production`، وهذه لا تقبل إلا `main`.
   - كل checkout بـ`persist-credentials: false`.
   - صلاحية `GITHUB_TOKEN` فيه `contents: read` و`deployments: write` فقط.
4. **الأسرار:** في خطوة واحدة (`windows-release-apply.mjs`)، والتوكن يُنشأ داخل `ctx.push` وحده، أي:
   - بعد إعادة التحقق كاملاً: الـSHA، وmain، و`deviceBaselineSha`، وموافقة الكتابة، وCI، وموضع الفرع.
   - التحقق أن التثبيت هو `173807509` للتطبيق `5412959` على هذا المستودع.
   - توكن مقيّد بـ`tobacco-web` وبـ`contents:write` و`workflows:write`، ورفضه إن أعاد GitHub أوسع من ذلك.
   - `::add-mask::` للـJWT والتوكن والترويسة.
   - دفع `‹SHA›:refs/heads/windows-production` بترويسة لا URL، وبلا force ولا «+».
   - رسالة خطأ git بلا اعتماد.
   - إبطال التوكن فوراً (`DELETE /installation/token`)، نجح الدفع أو فشل.
5. **تسجيل الـDeployment:** يبقى بـ`GITHUB_TOKEN`، و`deploymentCreator` كما هو.

**الحارس:** `scripts/check-windows-release-app-token.mjs` ضمن `npm run check`.
**الخطوة التالية (موافقة منفصلة):** Ruleset ثانٍ يمنع تحديث `windows-production` إلا للتطبيق `5412959`
(Integration bypass)، وتبقى القاعدة الحالية (منع الحذف وforce) بلا أي استثناء.

## الدفعة د0 (2026-10-31): وكيل الفواتير ومراقبه، وسجل المشغّل

في المستودع فقط. نسخ الإعداد إلى ProgramData وتجهيز مجلد السجل خطوتان إداريتان، كلٌّ بموافقة مستقلة.

- **«TOBACCO Ameen Invoice Agent» في `longRunningComponents`** (ملفّا الوكيل ومكتبته):
  - الوكيل عملية واحدة طويلة، تحمّل `ameen-invoice-events-lib.ps1` مرة واحدة عند البدء.
  - نشرٌ يغيّر أحدهما يسجّل `DEPLOYED_PENDING_RESTART`، ولا يعيد تشغيل شيء.
  - البوابة لا تلمس وسائط المهمة ولا `-Send` ولا `-StrictEnvFile` ولا ملف الاتصال. هذه قرارات مالك خارجها.
- **«TOBACCO Ameen Invoice Agent Monitor» في `pauseTasks`**، وهو غير معفى من التوجيه لأن كوده من المستودع:
  - ما دام غير موجّه عبر `run-repo-task.ps1`، فهو المهمة غير الموجّهة رقم 16، وDeploy يتوقف عليه (STOP).
  - توجيهه دفعة لاحقة بموافقة.
- **سجل المشغّل:**
  - حسابا المهام LOQ وOZKSync لهما قراءة وتنفيذ فقط على مجلد البوابة، فلا يُكتب `gateDir\launcher.log` اليوم (يُستعمل Write-Host بدلاً منه).
  - صار المفتاح `launcherLogDir` يحدد مجلداً منفصلاً هو `C:\ProgramData\OZK-TOBACCO\logs\run-repo-task`.
  - الملف شهري `launcher-YYYY-MM.log`، والتدوير بالاسم: لا حذف ولا إعادة تسمية.
  - المشغّل لا ينشئ المجلد، ويرفض مجلداً هو مجلد البوابة أو داخله.
- **`set-launcher-log-acl.ps1`** يجهّز المجلد بحساب مدير، وبلا `-Apply` يطبع الخطة فقط. الصلاحيات التي يضعها:
  - قائمة محمية، والمالك Administrators.
  - للحسابين على المجلد: عرض وإنشاء ملفات فقط.
  - للحسابين على الملفات: قراءة وكتابة وإلحاق.
  - بلا حذف، ولا تغيير صلاحيات، ولا امتلاك، ولا مجلدات فرعية.
  - `OWNER RIGHTS` (S-1-3-4) يلغي `WRITE_DAC` الضمني لمنشئ الملف.
  - لا يمسّ مجلد البوابة.
- **حد معروف:** LOQ عضو في Administrators. الحماية تفترض أن المهام تعمل بـ`RunLevel Limited`.

## الفحوص الإلزامية

- `npm run check`، ويشمل `check-windows-deploy-gate.mjs`.
- على Windows PowerShell 5.1، ثلاثة اختبارات:
  - `tools/tests/Test-DeployGate.ps1`
  - `tools/tests/Test-RunRepoTask.ps1`
  - `tools/tests/Test-LauncherLogAcl.ps1`: حساب محلي مؤقت غير مدير يكتب السجل عبر المشغّل الحقيقي، ويُرفض تعديله لملفات البوابة. يحتاج مديراً.
- يشغّلها عدّاء `ps51-compat` في `check.yml`.

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
   `PREFLIGHT PASS`. منذ 2026-10-25 لا مهمة تحتاج main؛ `OZK-PriceListSync` متقاعدة ويجب أن
   تبقى معطّلة، ولا مهمة تعمل من `mainWorktree.path`. إن أُعيدت مهمة تحتاج main يوماً:
   1. إنشاء clone مستقل موثوق لـmain في `mainWorktree.path` (لا worktree للمستودع التشغيلي
      نفسه: git يمنع فرعاً واحداً في worktreeين).
   2. التحقق أنه على `main`، وأن الـremote هو المستودع الرسمي.
   3. إعلانها في `mainDependentTasks` (بمراجعة)، ونقلها إليه صراحةً، واختبارها.
4. تبديل الفرع المحلي بلا تغيير ملفات: `git switch -c windows-production --track origin/windows-production`
   عندما يكون HEAD مساوياً له. ثم `deploy-gate.ps1 -Mode Initialize`، الذي يعيد الفحص ويرفض
   التسجيل إذا لم ينجح.
5. توجيه المهام إلى `run-repo-task.ps1` واحدة واحدة، والكاتب في النهاية.
6. مهمة «TOBACCO Windows Deploy Gate» كل 10 دقائق، بوضع `-Mode DryRun` يوماً كاملاً، ثم Deploy.
7. تمارين:
   - إصدار توثيقي.
   - إصدار PS1 قراءة.
   - إصدار كاتب بموافقة صريحة.
   - رجوع في نسخة تدريب.
8. إلغاء `tools/daily-git-pull.ps1` في المستودع، وإبقاء المهمة معطّلة.
9. تحسين منفصل: `StartWhenAvailable`، وتنبيهات «نشر معلّق» و«بوابة صامتة».
