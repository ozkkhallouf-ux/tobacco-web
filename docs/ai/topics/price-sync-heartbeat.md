# نبض مزامنة الأسعار (الموقع ← الأمين)

## الحالة الحالية

**المرحلة الأولى (Heartbeat): مكتوبة ومختبرة على فرع، وغير منشورة.** لم يُعدَّل الإنتاج، ولم تُنشر على OZK2026.

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
| `src/price-sync-health.js` | مصنِّف نقي: يأخذ صفوف النبض ويعيد الحالة الخماسية والتوقيتات والأعداد ووصفاً عربياً. يُعرَّف كـ `globalThis.ozkPriceSyncHealth`، وغير محمَّل في `index.html` بعد (المرحلة الثانية) |
| `scripts/check-price-sync-health.mjs` | 26 فحصاً للمصنِّف، وحرّاس على السكربتات (لا SQL، رموز خروج ثابتة، BOM) |
| `tools/tests/Test-PriceSyncHeartbeat.ps1` | 28 فحصاً للناشر تحت PowerShell 5.1، بوضع `-DryRun` |
| `tools/tests/Test-PriceSyncOrchestratorHeartbeat.ps1` | 14 فحصاً للمنسِّق الحقيقي مع بدائل وهمية، لكل مسار خروج |

## المصدر الموثوق

### عقد البيانات
- صفوف `inventory_reports` بالمصدر `ameen_price_sync_heartbeat`، بمخطط `summary.schema = "price-sync-heartbeat/v1"`.
- `report_date` بتوقيت دمشق (UTC+3).
- لا جدول جديد ولا migration، فـ`inventory_reports` بلا قيد على `source`.
- القراءة لـ`is_staff()` حسب RLS الحالية، والكتابة بحساب المزامنة نفسه الذي يكتب `ameen_price_sync_status`.

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
| `last_success_at` / `last_failure_at` | من ذاكرة الناشر المحلية `tools/logs/price-sync-heartbeat-state.json` |
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
| `FAILED` | آخر محاولة حديثة ونتيجتها من قائمة الفشل، ومنها التعارض و`preview_only` |

التمييز المطلوب:

| ما نريد معرفته | كيف نعرفه |
|---|---|
| نجاح تشغيل المهمة | وجود محاولة حديثة. `task.last_result` وحده لا يكفي (`docs/ai/topics/ameen-sync.md`) |
| نجاح الاتصال بالأمين | `ameen_contact_at` |
| وصول الأسعار فعلياً | `outcome=applied` (فحص بلا فروق) |
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
- `npm run check`، ويشمل `check-price-sync-health.mjs` وحارس BOM.
- وظيفة ps51-compat: `Test-PriceSyncHeartbeat.ps1` و`Test-PriceSyncOrchestratorHeartbeat.ps1`.
- بعد النشر على Windows: دليل حي.
  - صف `ameen_price_sync_heartbeat` جديد كل 5 دقائق، ومعه `outcome` وأعداد مطابقة لسطر `Applied:` في `approved-prices-sync.log`.
  - صف `task_probe` كل 30 دقيقة.

## الخطوة التالية

### خطوات تفعيل المرحلة الأولى (كلها بموافقة المالك)
1. مراجعة Codex نظيفة على HEAD، وCI أخضر، ثم دمج PR إلى `main`. الدمج ينشر الموقع، ولا أثر ظاهر لأن الملف الجديد غير محمَّل.
2. تقديم `windows-production` عبر `.github/workflows/windows-release.yml` بموافقة. السكربتات المتأثرة:
   - `tools/sync-approved-prices-to-ameen.ps1`
   - `tools/ensure-ameen-sync.ps1`
   - `tools/publish-price-sync-heartbeat.ps1` (جديد)
3. لا تعديل على تعريف أي مهمة مجدولة: «TOBACCO Approved Prices Pull» و«TOBACCO Sync Watchdog» تستدعيان السكربتين نفسيهما.
4. التحقق الحي: صفوف المصدر الجديد في `inventory_reports`، ثم `classifyPriceSyncHealth` على آخر 20 صفاً يعطي `HEALTHY`.
5. لا migration، ولا Edge Function، ولا تغيير على `HEALTH_LIFECYCLE_MODE` أو الحزم 12 و13 و15.

### تصميم المرحلة الثانية — شريط الحالة في صفحة الأسعار (غير منفَّذ)

**المكان والتحميل:**
- أعلى شاشة التسعير في `src/app.js`، فوق جدول الأسعار، على عرض كامل.
- `index.html` يحمّل `src/price-sync-health.js` مع `?v=tobacco-N`، لأنه أصل جديد.

**القراءة:**
- طلب REST واحد للقراءة فقط: `inventory_reports?source=eq.ameen_price_sync_heartbeat&select=created_at,summary&order=created_at.desc&limit=20` مع `Accept-Profile: public`.
- كل 60 ثانية والصفحة ظاهرة، وعند العودة للتبويب.
- لا يُقرأ أي شيء من الأمين.

**العرض:** ناتج `describePriceSyncHealth`.

| الحالة | المثال | اللون |
|---|---|---|
| HEALTHY | ✅ آخر وصول للأمين: 11:34 (وتحته «لا أسعار جديدة منذ آخر مزامنة» أو «عادت المزامنة بعد انقطاع 240 دقيقة») | أخضر |
| STALE | ⚠️ المزامنة متوقفة منذ 10:17 | أصفر |
| FAILED | ❌ فشل آخر اتصال بالأمين / طُبّقت الأسعار مع تعارض في 2 صنف | أحمر |
| DISABLED | ⛔ مهمة مزامنة الأسعار معطّلة — آخر وصول للأمين: 10:17 | أحمر |
| UNKNOWN | ❔ حالة مزامنة الأسعار غير معروفة | رمادي |

**عند حفظ سعر والحالة ليست HEALTHY:**
- نافذة تأكيد: «المزامنة متوقفة منذ HH:MM — هذا السعر لن يصل للأمين حتى تعود. متابعة؟».
- ثم toast فيه التحذير. لا منع للحفظ.

**العرض المرئي:**
- RTL، ونص واضح على iPhone، والوضعان الفاتح والداكن.
- عند فشل طلب القراءة نفسه: حالة UNKNOWN بنص «تعذّر قراءة حالة المزامنة» (لا أخضر افتراضي).

**الفحوص:**
- اختبار لربط الحالة بالشريط، وحارس على أن الطلب قراءة فقط.
- فحص بصري للوضعين الفاتح والداكن.
- `check-critical-journeys` لصفحة الأسعار.

**مراحل لاحقة** (في `PRICE_SYNC_PROTECTION_PLAN_20261018.md` على ماك المالك):
- تنبيهات فورية: تحتاج استثناء من توجيه الحزمة 13.
- آلية pause/resume رسمية.
- فحص فواتير الأمين التي صدرت أثناء الانقطاع، عند الاستئناف.
