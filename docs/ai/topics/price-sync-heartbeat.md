# نبض مزامنة الأسعار (الموقع ← الأمين)

## الحالة الحالية

**المرحلة الأولى (Heartbeat): مفعَّلة على الإنتاج منذ 2026-10-18.**
- PR #332 مدموج (`c3962bef`).
- `proposed/16` مطبَّقة بالإصدار `20261018110041`.
- الملفات الثلاثة منشورة على OZK2026 بنشر محدود بموافقة المالك (الخيار B)، لأن بوابة النشر غير مثبَّتة. النسخة الاحتياطية في `C:\Users\LOQ\ozk-backups\price-heartbeat-20261018-141523`.
- أول نبضين: `task_probe` و`attempt applied`، وكلاهما بهوية المزامنة.

**المرحلة الثانية (شريط الحالة في صفحة الأسعار): على فرع، غير منشورة.** راجع قسمها أدناه.

**قرار المالك 2026-10-18 (الخيار B، ومراجعة Codex P1):** النبض في جدول مستقل `public.price_sync_heartbeats`، لا في `inventory_reports`. السبب: `inventory_reports` يقبل الإدراج من أي موظف، فيمكن تزوير HEALTHY. وعليه trigger «تقرير الجرد اليومي» الذي كان سيُطلق إشعاراً كاذباً مع أول نبض كل يوم.

### لماذا
حادثة 2026-10-18:
- مهمة «TOBACCO Approved Prices Pull» عُطّلت للصيانة من 07:33 إلى 11:33.
- بقي آخر صف `ok` في `ameen_price_sync_status` يتقادم بصمت.
- عُدّلت 24 سعراً في الموقع بين 10:39 و10:47 لم تصل إلى الأمين.
- صدرت 4 فواتير بالأسعار القديمة، والفرق الصافي +3.10$ (ملاحظة تدقيقية فقط).

قبل هذه المرحلة كانت هناك ثلاث ثغرات:
- لا شيء يميّز «المهمة معطّلة» عن «لا جديد».
- لا يُنشر شيء عند فشل السحب أو التطبيق.
- مراقب Supabase لا يقرأ قيمة `status`.

### ماذا أضافت المرحلة الأولى

| الملف | الدور |
|---|---|
| `tools/publish-price-sync-heartbeat.ps1` | ناشر جديد بنمطين. `-Mode Attempt` يكتب نتيجة كل تشغيل. `-Mode TaskProbe` يكتب حالة المهمة المجدولة. يقرأ Task Scheduler فقط، ولا يتصل بالأمين، ويخرج دائماً بصفر |
| `tools/sync-approved-prices-to-ameen.ps1` | ينشر نبض `Attempt` في **كل** مسار خروج. رموز الخروج (1/0/1/2/3) و`ameen_price_sync_status` وتنبيهات تيليغرام القديمة **بلا تغيير** |
| `tools/ensure-ameen-sync.ps1` (Sync Watchdog) | كتلة best-effort جديدة (3ج) تنشر `TaskProbe`. لا تضيف مشكلة، ولا تغيّر رمز الخروج، ولا ترسل تنبيهاً |
| `supabase/proposed/16-price-sync-heartbeats.sql` (+ rollback) | الجدول المستقل ودالة الكتابة الوحيدة `record_price_sync_heartbeat(jsonb)`. **غير مطبَّق** |
| `supabase/tests/price-sync-heartbeats-security.sql` + `scripts/check-price-sync-heartbeats-security.mjs` | اختبار أمني حي على PostgreSQL في CI (62 تأكيداً، وحارس يرفض أي خادم غير محلي): منع التزوير، رفض النجاح بلا إثبات، الصلاحيات، والتراجع |
| `src/price-sync-health.js` | مصنِّف نقي: يأخذ صفوف النبض ويعيد الحالة الخماسية والتوقيتات والأعداد ووصفاً عربياً. يُعرَّف كـ `globalThis.ozkPriceSyncHealth`، ويحمّله `index.html` منذ المرحلة الثانية |
| `scripts/check-price-sync-health.mjs` | 35 فحصاً للمصنِّف، وحرّاس على السكربتات (لا SQL، رموز خروج ثابتة، BOM) |
| `tools/tests/Test-PriceSyncHeartbeat.ps1` | 31 فحصاً للناشر تحت PowerShell 5.1، بوضع `-DryRun` |
| `tools/tests/Test-PriceSyncOrchestratorHeartbeat.ps1` | 14 فحصاً للمنسِّق الحقيقي مع بدائل وهمية، لكل مسار خروج |

## المصدر الموثوق

### عقد البيانات
- صفوف `public.price_sync_heartbeats` (`supabase/proposed/16`): `received_at` بساعة الخادم، `writer_id`، `kind`، `host`، `occurred_at`، `outcome`، و`summary` بمخطط `price-sync-heartbeat/v1`.
- الناشر يرسل `POST /rest/v1/rpc/record_price_sync_heartbeat` بجسم `{ "p_summary": … }`.

### الأمن (منع تزوير HEALTHY)
- **لا كتابة مباشرة لأي دور:** `revoke all` من `public` و`anon` و`authenticated` و`service_role`. RLS مفعّلة ومفروضة، وبلا أي سياسة INSERT أو UPDATE أو DELETE.
- **الكتابة الوحيدة** عبر `record_price_sync_heartbeat`:
  - SECURITY DEFINER بمسار بحث فارغ `search_path = ''` وأسماء مؤهَّلة.
  - تقبل **هوية المزامنة المعتمدة وحدها**: `auth.uid()` = حساب المزامنة `9724dbe4-…` الذي يكتب `ameen_price_sync_status` وتدقيق خليل.
  - لا احتياط بمفتاح `service_role` (أقل الصلاحيات). والناشر لم يعد يقرأ `SUPABASE_SERVICE_KEY`.
  - أي موظف أو مالك أو مستخدم آخر، أو توكن بلا هوية، يُرفض بـ`42501`. `anon` و`service_role` لا يملكان EXECUTE.
- **آخر نجاح وآخر اتصال بالأمين يحسبهما الخادم:**
  - العمودان `last_success_at` و`last_ameen_contact_at` على ساعة الخادم.
  - يُحملان من صف المحاولة السابق تحت `pg_advisory_xact_lock`.
  - ادعاء العميل `last_success_at` في الحمولة لا يُقدّم شيئاً، والمصنِّف يقدّم العمودين على ذاكرة الناشر.
- **النجاح يحتاج إثباتاً على الخادم:** `applied` أو `no_changes` يُرفض (`22023`) ما لم يحمل كل ما يلي:
  - `ameen_contact_at`
  - `verify.mismatches = 0` و`verify.missing = 0` كأرقام JSON
  - `applied_wholesale ≥ 1`
  - تعارضاً وأصنافاً مفقودة صفراً أو null
- **الناشر يطبّق الشرط نفسه قبل الإرسال:** «نجاح» بلا إثبات يُرسل `verify_failed` صريحاً، ولا يغيّر آخر نجاح محلي. والمنسِّق لا يعلن `applied` بلا سطر `PRICE_APPLY` مقروء.
- **المصنِّف يطبّق الشرط نفسه مرة ثالثة:** صف «نجاح» بلا إثبات = `FAILED (unproven_success)`.
- **الحداثة من ساعة الخادم:** المصنِّف يعتمد `received_at`. طوابع العميل للعرض فقط، وتُرفض على الخادم إن تقدّمت أكثر من 5 د. `last_success_at` المعلن لا يتقدّم على زمن صفه.
- **القراءة:** `is_staff()` فقط. مستخدم غير موظف يرى صفر صفوف، و`anon` مرفوض.
- **حدود أخرى:** الحمولة ≤ 16KB، والاحتفاظ 30 يوماً داخل دالة الكتابة. لا cron ولا تنبيه.

**`kind = "attempt"`:**

| الحقل | المعنى |
|---|---|
| `attempt_started_at` / `attempt_finished_at` | آخر محاولة مزامنة |
| `outcome` | `applied` (وصلت أسعار جديدة وتحقق منها الفحص)، `no_changes` (نجاح مثبت والبصمة السعرية مطابقة لآخر نجاح)، `pull_failed`، `ameen_unreachable`، `apply_failed`، `verify_failed`، `verify_mismatch`، `applied_with_conflicts`، `preview_only` (المهمة مسجّلة بلا `-Apply`) |
| `stage_failed` | `pull` / `connect` / `apply` / `verify` |
| `ameen_contact_at` | آخر وقت ثبت فيه الاتصال بالأمين: إما سطر `PRICE_APPLY`، أي كُتب في الأمين، أو قراءة الفحص للقائمتين |
| `sent_count` | عدد الأسعار المسحوبة من الموقع (صفوف CSV) |
| `applied_wholesale` / `applied_retail` | ما طُبّق على «جملة الجملة» و«كروزات مركز» |
| `not_in_ameen` / `conflict_count` / `skipped` | من سطر `PRICE_APPLY` |
| `verify.{wholesale_matched, retail_matched, mismatches, missing}` | الفحص المستقل بعد الكتابة |
| `prices_fingerprint` / `prices_changed` | SHA-256 لأسعار CSV بلا `updated_at`، لأن `updated_at` يتغيّر مع المخزون أيضاً |
| `last_success_at` / `last_failure_at` | من ذاكرة الناشر المحلية `tools/logs/price-sync-heartbeat-state.json` (لا تتقدّم على `received_at`) |
| `task` | حالة المهمة لحظة التشغيل |

العدد غير المعروف يُكتب `null` لا صفراً.

**`kind = "task_probe"`:**
- الحقول: `probed_at` و`task.{exists, enabled, state, last_run_time, last_result, next_run_time}`.
- يُنشر فوراً إن كانت المهمة معطّلة أو مفقودة، وإلا مرة كل 30 دقيقة.

### الحالات الخمس
يحسبها المصنِّف `classifyPriceSyncHealth(rows, { now })`، والعتبات في `THRESHOLDS`:

| الحالة | الشرط |
|---|---|
| `DISABLED` | فحص مهمة حديث (≤ 45 د) يقول إنها معطّلة أو غير مسجّلة. **يتقدّم على كل شيء**، حتى على نجاح قبل دقيقتين |
| `UNKNOWN` | لا صفوف (`no_data`)، أو صفوف تالفة أو بمخطط آخر (`unreadable_data`)، أو فحص مهمة بلا أي محاولة (`no_attempts`)، أو طابع زمني مستقبلي بأكثر من 5 د (`future_timestamp`)، أو نتيجة غير معروفة (`unknown_outcome`) |
| `STALE` | آخر محاولة أقدم من 15 د، أي 3 دورات. **آخر نجاح قديم ليس دليلاً على أن المزامنة تعمل الآن** |
| `HEALTHY` | آخر محاولة حديثة و`outcome ∈ {applied, no_changes}`. إن سبقها فشل أو فجوة أطول من 15 د يُضاف `resumedAfter` (استئناف) |
| `FAILED` | آخر محاولة حديثة ونتيجتها من قائمة الفشل، ومنها التعارض و`preview_only` و`unproven_success` |

التمييز المطلوب:

| ما نريد معرفته | كيف نعرفه |
|---|---|
| نجاح تشغيل المهمة | وجود محاولة حديثة. `task.last_result` وحده لا يكفي (`docs/ai/topics/ameen-sync.md`) |
| نجاح الاتصال بالأمين | `ameen_contact_at` |
| وصول الأسعار فعلياً | `outcome=applied` بإثبات تفرضه الدالة والمصنِّف معاً |
| لا أسعار جديدة | `outcome=no_changes` |
| فشل المزامنة | `FAILED` مع السبب |
| تعطيل المهمة | `DISABLED` |

التوقيت يُعرض بتوقيت دمشق عبر `formatDamascusTime`.

## نطاق الملفات
الملفات في الجدول أعلاه، وأيضاً `scripts/checks.manifest.mjs` و`scripts/check-powershell-51-encoding.mjs` و`.github/workflows/check.yml` (وظيفة ps51-compat).

## القيود الثابتة
- لا اتصال بقاعدة الأمين في الناشر ولا في المصنِّف. قراءة الحالة لا تحتاج أي صلاحية على AmnDb002.
- النبض best-effort: لا يغيّر رموز خروج المنسِّق ولا تنبيهاته، ولا يكسر Sync Watchdog.
- `ameen_price_sync_status` القديم باقٍ كما هو، لأن البوت (`فحص الأسعار`) ومراقب `price-sync` يقرآنه.
  - لم نكتب صفوف الفشل في المصدر القديم عمداً: مراقب Supabase يفحص الحداثة لا القيمة، فصف «error» حديث كان سيُخفي العطل عنه.
- لا رفع يدوي للأسعار، ولا تشغيل أو تعطيل لمهام Windows من هذه الأدوات. الناشر يستعمل `Get-ScheduledTask` قراءةً فقط.
- السكربتات الثلاثة تُنشر على OZK2026 **فقط** عبر بوابة `windows-production` بموافقة المالك (`docs/ai/topics/windows-deploy-gate.md`).

## الفحوص الإلزامية
- `npm run check`، ويشمل `check-price-sync-health.mjs` و`check-price-sync-heartbeats-security.mjs` وحارس BOM. الأخير يحتاج PostgreSQL محلياً، وهو إلزامي في CI.
- وظيفة ps51-compat: `Test-PriceSyncHeartbeat.ps1` و`Test-PriceSyncOrchestratorHeartbeat.ps1`.
- بعد النشر على Windows: دليل حي.
  - صف `price_sync_heartbeats` جديد كل 5 دقائق، ومعه `outcome` وأعداد مطابقة لسطر `Applied:` في `approved-prices-sync.log`.
  - صف `task_probe` كل 30 دقيقة.

## الخطوة التالية

### خطوات تفعيل المرحلة الأولى (كلها بموافقة المالك)
1. مراجعة Codex نظيفة على HEAD، وCI أخضر، ثم دمج PR إلى `main`. الدمج ينشر الموقع، ولا أثر ظاهر لأن الملف الجديد غير محمَّل.
1ب. تطبيق `supabase/proposed/16-price-sync-heartbeats.sql` على الإنتاج بموافقة منفصلة، **قبل** نشر سكربتات Windows. حتى ذلك الحين يكتب الناشر `PRICE-SYNC-HEARTBEAT FAILED`، وهو best-effort ولا يكسر المزامنة.
2. تقديم `windows-production` عبر `.github/workflows/windows-release.yml` بموافقة. السكربتات المتأثرة:
   - `tools/sync-approved-prices-to-ameen.ps1`
   - `tools/ensure-ameen-sync.ps1`
   - `tools/publish-price-sync-heartbeat.ps1` (جديد)
3. لا تعديل على تعريف أي مهمة مجدولة: «TOBACCO Approved Prices Pull» و«TOBACCO Sync Watchdog» تستدعيان السكربتين نفسيهما.
4. التحقق الحي: صفوف جديدة في `price_sync_heartbeats` و`writer_id` = حساب المزامنة، ثم `classifyPriceSyncHealth` على آخر 20 صفاً يعطي `HEALTHY`.
5. لا migration غير proposed/16، ولا Edge Function، ولا تغيير على `HEALTH_LIFECYCLE_MODE` أو الحزم 12 و13 و15.

### المرحلة الثانية — شريط الحالة في صفحة الأسعار (منفَّذة على فرع، غير منشورة)

| الملف | الدور |
|---|---|
| `src/price-sync-status.js` | يقرأ `price_sync_heartbeats` بجلسة المستخدم، ويصنّفه بالمصنِّف، ويرسم الشريط أعلى `.newsletter-hub`. يلفّ `render` كما يفعل `decision-engine.js` |
| `src/app.js` (`savePricingItem`) | بعد الحفظ الفعلي: إن لم تكن الحالة HEALTHY يُلحق تحذير برسالة الحفظ (`warning`). لا منع للحفظ |
| `src/styles.css` | `.price-sync-status` بأربعة أصناف (`is-healthy`/`is-stale`/`is-failed`/`is-unknown`) للوضعين الداكن والفاتح، و`.message-panel.warning` |
| `index.html` و`public/service-worker.js` | تحميل `price-sync-health.js` قبل `app.js` و`price-sync-status.js` بعده، وتخزينهما في الكاش |
| `scripts/check-price-sync-status.mjs` | 20 فحصاً وظيفياً وأمنياً بلا متصفح |
| `scripts/check-price-sync-status-ui.mjs` | Playwright على الصفحة الحقيقية: 1280 و390، داكن وفاتح (40 تأكيداً) |

**القراءة:**
- `client.from("price_sync_heartbeats").select("received_at,kind,outcome,summary,last_success_at,last_ameen_contact_at").order("received_at", desc).limit(20)`.
- **لا `writer_id` ولا `host`** في الطلب ولا في العرض. قراءة فقط: لا insert/update/delete/rpc.
- RLS تحكم القراءة: الموظفون فقط. غير الموظف يرى صفر صفوف ⇒ UNKNOWN.
- كل 60 ثانية والصفحة ظاهرة على مسار `pricing`، وعند العودة للتبويب، وعند عودة الشبكة. يُستبدل الشريط وحده في مكانه بلا `render` كامل.
- أي فشل (بلا عميل، أو بلا جلسة، أو خطأ صلاحية أو شبكة) ⇒ UNKNOWN بنص «تعذّر قراءة حالة المزامنة»، بلا `console.error`. لا أخضر افتراضي.

**العرض:**
- العنوان: «مزامنة الأسعار مع الأمين: سليمة / متوقفة / فشلت / معطّلة / غير معروفة»، ثم نص `describePriceSyncHealth`.
- الحقائق بتوقيت دمشق:
  - آخر نجاح مثبت.
  - آخر محاولة.
  - المطبَّق (جملة/مفرق).
  - التعارضات وغير الموجود بالأمين.
  - آخر فشل وسببه ووقته.
- «لم تصل للأمين» يُعرض **فقط** إن أثبته الفحص المستقل (`mismatches + missing > 0`).
- HEALTHY لا يأتي من نجاح قديم: آخر محاولة أقدم من 15 د ⇒ STALE.

**عند حفظ سعر والحالة ليست HEALTHY** (أو لم تُقرأ بعد): رسالة الحفظ تصبح تحذيراً، مثل «⚠️ المزامنة متوقفة منذ HH:MM — هذا السعر لن يصل للأمين حتى تعود المزامنة.». لا نافذة تأكيد ولا منع، لأن الحفظ الجماعي قبل النشرة يحفظ عدة أسعار متتالية.

**مراحل لاحقة** (في `PRICE_SYNC_PROTECTION_PLAN_20261018.md` على ماك المالك):
- تنبيهات فورية: تحتاج استثناء من توجيه الحزمة 13.
- آلية pause/resume رسمية.
- فحص فواتير الأمين التي صدرت أثناء الانقطاع، عند الاستئناف.
