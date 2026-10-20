# نبض مزامنة الأسعار (الموقع ← الأمين)

## الحالة الحالية

**المرحلة الأولى (Heartbeat): مفعَّلة على الإنتاج منذ 2026-10-18.**
- PR #332 مدموج (`c3962bef`).
- `proposed/16` مطبَّقة بالإصدار `20261018110041`.
- الملفات الثلاثة منشورة على OZK2026 بنشر محدود بموافقة المالك (الخيار B)، لأن بوابة النشر غير مثبَّتة. النسخة الاحتياطية في `C:\Users\LOQ\ozk-backups\price-heartbeat-20261018-141523`.
- أول نبضين: `task_probe` و`attempt applied`، وكلاهما بهوية المزامنة.

**المرحلة الثانية (شريط الحالة في صفحة الأسعار): منشورة منذ 2026-10-19** (PR #333، `8e5c08b2`).

**المرحلة الثالثة (مراقبة مستقلة وتنبيهات تيليغرام): `supabase/proposed/17` على فرع، غير مطبَّقة.** راجع قسمها أدناه.

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

### المرحلة الثانية — شريط الحالة في صفحة الأسعار (منشورة)

| الملف | الدور |
|---|---|
| `src/price-sync-status.js` | يقرأ `price_sync_heartbeats` بجلسة المستخدم، ويصنّفه بالمصنِّف، ويرسم الشريط أعلى `.newsletter-hub`. يلفّ `render` كما يفعل `decision-engine.js` |
| `src/app.js` (`savePricingItem`) | بعد الحفظ الفعلي: إن لم تكن الحالة HEALTHY يُلحق تحذير برسالة الحفظ (`warning`). لا منع للحفظ |
| `src/styles.css` | `.price-sync-status` بأربعة أصناف (`is-healthy`/`is-stale`/`is-failed`/`is-unknown`) للوضعين الداكن والفاتح، و`.message-panel.warning` |
| `index.html` و`public/service-worker.js` | تحميل `price-sync-health.js` قبل `app.js` و`price-sync-status.js` بعده، وتخزينهما في الكاش |
| `scripts/check-price-sync-status.mjs` | 23 فحصاً وظيفياً وأمنياً بلا متصفح، منها تهريب `<script>` بكل حالات الأحرف |
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

### المرحلة الثالثة — مراقبة مستقلة على Supabase وتنبيهات تيليغرام (proposed/17، غير مطبَّقة)

**التدقيق (2026-10-19، قراءة فقط):**
- الإرسال: `notify_telegram` ← `private.notify_telegram_dispatch` (بصمة `60bbae6f`) ← `telegram_outbox` ← cron `dispatch-telegram-outbox` كل دقيقة. منع التكرار بمفتاح ونافذة فقط، وغير ذرّي.
- مراقب قائم: cron `monitor-project-tasks` كل 5 د يشغّل `private.monitor_project_tasks()`.
  - المهمة `price-sync` تقرأ `ameen_price_sync_status` بحد 30 د.
  - يعيد التنبيه كل 60 د ما دام العطل قائماً.
  - يراقب أيضاً صحة كل مهام cron.
- تنبيهات Windows لمزامنة الأسعار تخرج من OZK2026 نفسه، فتتوقف بتوقفه:
  - `winfail:apply-to-ameen`
  - `price-sync:mismatch`
  - `price-sync:verify-failed`
- الحزم 12 و13 و15: غير مطبَّقة، ولا كائن منها في الإنتاج.

**التصميم:**
- `private.price_sync_monitor_tick()` يشغّله cron `price-sync-monitor` كل دقيقة على Supabase وحده. المصدر `price_sync_heartbeats`، والزمن من ساعة الخادم.
- **الأدلة:**
  - نجاح مثبت: `applied` أو `no_changes`، والدالة 16 لا تقبلهما بلا إثبات.
  - وصول حيّ: المثبت، و`applied_with_conflicts` (وصلت الأمين وطبّقت، لكن مع تعارض أو أصناف غير موجودة).
- **الحالات** (`private.price_sync_monitor_assess`):
  - DISABLED: أحدث فحص مهمة (≤ 45 د) يقول إنها معطّلة أو غير مسجّلة، **ولم يصل بعده وصول حيّ**.
    - وصول حيّ أحدث من الفحص يُسقطه فوراً، فلا انتظار للفحص التالي بعد إعادة التفعيل.
    - محاولة فاشلة بعده لا تُسقطه.
    - فحص «معطّلة» أحدث من آخر نجاح يغلب دائماً.
  - UNKNOWN: لا محاولات إطلاقاً.
  - STALE: لا وصول حيّ أكثر من 15 د ولا محاولة حديثة.
  - FAILED: لا وصول حيّ أكثر من 15 د مع محاولات حديثة، أو فشلان متتاليان.
  - **PARTIAL**: آخر وصول حيّ كان `applied_with_conflicts`.
    - مشكلة جزئية منفصلة عن الانقطاع الكلي.
    - **لا تُعلن HEALTHY أبداً**، وحادثتها بعد محاولتين جزئيتين متتاليتين.
  - HEALTHY: آخر وصول حيّ نجاح مثبت خلال 15 د.
- **الحوادث** (`private.price_sync_incidents`، النوعان `outage` و`partial`):
  - واحدة مفتوحة على الأكثر، وكل انتقال رسالة واحدة:
    - 🔴 انقطاع.
    - 🟠 تعارض.
    - 🟠 «عادت المزامنة جزئياً» (تُنهي الانقطاع وتعلن الجزئية معاً).
    - 🔴 جزئي ← انقطاع.
    - 🟢 تعافٍ.
  - مفتاح dedupe: `price-sync-outage|price-sync-partial:<incident_key UUID>:open|recovered`.
- **التعافي:** آخر محاولة نفسها نجاح مثبت خلال 15 د، ولا فحص «معطّلة» أحدث منها. رسالة واحدة فقط إن أُعلنت الحادثة.
- **منع ازدواج Windows/Supabase بلا تعديل Windows:** حادثة FAILED لها تنبيه Windows مطابق في `telegram_outbox` خلال آخر 30 د **ومنذ آخر وصول حيّ** (سلسلة الفشل الحالية وحدها، فانقطاع ثانٍ بعد تعافٍ قصير يُعلَن دائماً) تُعدّ مُعلنة به (`announced_by='windows'`)، فلا رسالة فتح ثانية، وتبقى رسالة التعافي.
  - الربط: `pull_failed`↔`winfail:pull-approved-prices`.
  - `ameen_unreachable`/`apply_failed`↔`winfail:apply-to-ameen`.
  - `verify_mismatch`↔`price-sync:mismatch*` (يشمل مفتاح 13 المنقّح).
  - `verify_failed`↔`price-sync:verify-failed`.
  - STALE/DISABLED/UNKNOWN لا تُمتص.
  - يُطفأ بـ`absorb_windows_minutes = 0`.
- **خط الأساس:** أول تشغيل صامت. عطل قائم (انقطاع أو جزئي) يُفتح صامتاً، ويُنبَّه عنه مرة واحدة إن بقي 30 د.
- **التزامن:** قفل استشاري، وقفل صف الحالة، والفهرس الفريد.
- **فشل الإرسال:** فشل إدراج الرسالة يُرجع الدورة كلها.
- **منع التكرار مع القديم:** الهجرة تعطّل صف `price-sync` القديم في `project_task_monitors`، وتغلق في المعاملة نفسها حادثته المفتوحة في `private.project_task_incidents` (12) وتعيد صف صحته سليماً. بلا ذلك يبقى قسم الأعطال المسائي (15) يعرضها للأبد (Codex P1).
- **التوافق مع 12/13/15:** أنواع الأحداث ومفاتيحها لا تقع تحت قواعد «الملخص»، ولا تُغيَّر أي دالة تثبّت تلك الحزم بصمتها.
- **الأمن:** كل شيء في `private` بلا منح.
- **الملفات:**
  - `supabase/proposed/17-price-sync-monitor.sql` + rollback
  - `supabase/tests/price-sync-monitor.sql`
  - `scripts/check-price-sync-monitor.mjs`:
    - عقود ساكنة.
    - 132 تأكيداً حياً.
    - تزامن حقيقي في 4 حالات: انقطاع، وأول تشغيل، وانقطاع ← جزئي، وتعافٍ.

**ترتيب التطبيق مع 12/13/15 — حارس 17 (قرار المالك 2026-10-20):** 17 لا يُطبَّق إلا بعد 12 ثم 13 ثم 15 فعلياً. الحارس في أول الملف يتحقق من الواقع الحي:
- **12:** `private.digest_bundle_snapshot` و`ops_events` و`project_task_incidents` موجودة، و`monitor_project_tasks` = md5 `fcaf57eb…`.
- **13:** `private.digest_routing_snapshot` موجودة، و`health_lifecycle` = `1cd6b62f…`، و`ops_event_route` = `7228700c…`.
  - بصمة الخطة المحلية `57298c1d…` قديمة، سبقت #331.
- **15:** `private.sync_outage_snapshot` موجودة، وجسم الإرسال = `c35b5c19…`، و`daily_open_faults_section` = `d5bb80ca…`، و`sync_outage_tick` = `91e6d4d8…`، ومهمة cron `sync-outage-tick` نشطة.
- **الترتيب:** أول `taken_at` في لقطة 12 ≤ 13 ≤ 15. التساوي مقبول لأن rev2 طبّق الثلاث في معاملة واحدة؛ الترتيب الصارم تثبته إصدارات سجل الهجرات.
- **سجل الهجرات (إلزامي):** `supabase_migrations.schema_migrations` يحمل أسماء rev2 الحرفية بمساواة تامة: `digest_only_bundle` (12) و`digest_routing_noncritical` (13) و`ameen_sync_outage_incident` (15). كلٌّ مرة واحدة، بإصدارات من 14 رقماً تصاعدية ومتفقة مع ترتيب اللقطات. أسماء rev1 (`digest_only_atomic_bundle`…) أو قريبة أو ناقصة أو مكررة أو بإصدارات معكوسة ⇒ رفض. العدد وحده لا يكفي.
- **الذرّية:** كل جملة تُنشئ شيئاً داخل كتلة `$install17$` لا تعمل إلا إن نجح الحارس في المعاملة نفسها. حارس فاشل لا يُنشئ جدولاً ولا دالة ولا مهمة cron، ولا يعطّل المراقب القديم، حتى عند التنفيذ أمراً بأمر.
- **البصمات** مأخوذة من ملفات 12/13/15 نفسها، والفحص يفشل إن انجرفت.
- **بعد 17:** عدد مهام cron = 18.
- **بعد 13:** يذهب فشل `cron:price-sync-monitor` نفسه إلى الملخص المسائي. اقتراح: استثناء فوري له في 13.
- **15 و17 معاً:** 15 قد تفتح «انقطاع مزامنة OZK2026» (60 د دوام) مع حادثة الأسعار عند إطفاء الجهاز، أي رسالتان بأثرين مختلفين.

**اختبارات الحارس** (`scripts/check-price-sync-monitor.mjs`)، 22 حالة كلٌّ في قاعدة مستقلة. كل رفض يُتحقَّق بعده أن لا جدول ولا دالة ولا cron أُنشئت وأن المراقب القديم ما زال مفعّلاً:
- لا حزمة.
- لقطة 12 بلا جسمها.
- 12 فقط.
- 12+13.
- **الثلاث بالترتيب وسجل rev2 الحرفي: يُطبَّق.**
- جسم إرسال 13 لا 15.
- 15 جزئية.
- قسم التقرير بجسم 12.
- بلا cron 15.
- بلا tick 15.
- دوال 13 بلا لقطتها.
- لقطات معكوسة.
- أسماء rev1 القديمة.
- اسم قريب لا حرفي.
- إصدارات معكوسة.
- إصدارات ليست 14 رقماً.
- اسم مكرر.
- سجل ناقص.
- بلا سجل.
- سجل صحيح ولقطات معكوسة.
- معرّفات أخرى بعدد صحيح.
- تنفيذ أمر بأمر.

اختبار تهريب التعبير النمطي يمنع عودة CodeQL `js/incomplete-sanitization`.

**التفعيل (بموافقة المالك):** دمج، ثم تطبيق 17 (ينشئ cron ويعطّل صف `price-sync` القديم)، ثم التحقق:
- أول دورة تعطي `baseline`.
- لا رسائل.
- `cron:price-sync-monitor` سليم.

**المخاطر المتبقية:**
- تكرار تنبيه Windows كل 60 د ما دام الفشل قائماً يبقى (خارج سيطرة Supabase بلا تعديل dispatch أو Windows).
- `notify_telegram` مفتوح لاستدعاء أي موظف (قائم قبل هذه المرحلة).
- شريط الموقع (المرحلة 2) يعرض `applied_with_conflicts` كـ«فشلت» لا «جزئي». غير كاذب، لكنه أقل دقة.

**مراحل لاحقة** (في `PRICE_SYNC_PROTECTION_PLAN_20261018.md` على ماك المالك):
- آلية pause/resume رسمية.
- فحص فواتير الأمين التي صدرت أثناء الانقطاع، عند الاستئناف.
