# نبضة مزامنة الأسعار (الموقع → الأمين)

## الحالة المثبتة (2026-10-18)

- **المرحلة 1 (Heartbeat):** الكود والاختبارات على فرع مستقل في Draft PR. **غير مطبَّقة**:
  - SQL 16 لم يُطبَّق على Supabase.
  - السكربتات لم تصل OZK2026.
  - لا تغيير على الأمين ولا على أي مهمة Windows.
- **المرحلة 2 (شريط صفحة الأسعار):** تصميم فقط، في القسم الأخير من هذا الملف.
- **المراحل 3–5** (تنبيه Telegram، الحارس، تقرير الفجوة): خارج هذا العمل، وتُبنى على النبضة.
- الخطة العامة: `/mnt/project-files/ameen-cogs-fix/price-sync-protection-plan-2026-10-18.md`.

## لماذا

في 2026-10-18 عُطّلت «TOBACCO Approved Prices Pull» من 10:17 إلى 11:33 دمشق للصيانة. خلال التوقف:
- عُدّلت 24 سعراً في الموقع.
- أصدر الكاشير 4 فواتير بلائحة الأمين القديمة.

لم يظهر أي تحذير. السبب أن `inventory_reports/ameen_price_sync_status` لا يُنشر إلا بعد سحب وتطبيق ناجحين. فالفشل والتعطيل لا يتركان أثراً، ويبقى آخر «ok» بلا تمييز.

## كيف تعمل النبضة

```
sync-approved-prices-to-ameen.ps1 -Apply   (كل 5 دقائق)
  ├─ pull   → PRICE_PULL count=N max_updated_at=ISO      (سطر آلي جديد)
  ├─ apply  → PRICE_APPLY jumla retail skipped notfound conflict (موجود)
  ├─ verify → PRICE_VERIFY wholesale retail mismatches missing  (موجود)
  └─ publish-price-sync-heartbeat.ps1 → rpc/record_price_sync_heartbeat → public.price_sync_heartbeat
```

- **محاولة واحدة = صف واحد**، أياً كانت النتيجة:

  | الحالة (`status`) | متى | رمز خروج المهمة (لم يتغير) |
  |---|---|---|
  | `ok` | تطبيق + تحقق مطابق | 0 |
  | `mismatch` | التحقق وجد فروقاً أو نواقص | 2 |
  | `pull_failed` | تعذّر السحب من Supabase | 1 |
  | `apply_failed` | تعذّر التطبيق أو الاتصال بالأمين | 1 |
  | `verify_failed` | نتيجة التحقق لا تُقرأ | 3 |
  | `disabled` / `paused` | يبلّغ بها طرف خارجي: `publish-price-sync-heartbeat.ps1 -Status disabled -Message "..."` | — |

- **المعاينة بلا `-Apply` لا تنشر نبضة**، لأنها لا تكتب في الأمين.
- **الحالة القديمة `ameen_price_sync_status` تبقى كما هي**، وكذلك المراقب `monitor_project_tasks` وتنبيهات `winfail:*` و`price-sync:*`.
- **الدالة تحسب على ساعة الخادم وتحمل من الصف السابق**:
  - `last_success_at`: آخر نجاح مثبت، أي `ok` وصفر تعارض.
  - `last_applied_at` و`applied_feed_max_updated_at`: آخر تطبيق، ولو مع تعارض.
  - `last_failure_at` و`last_failure_status`: آخر فشل.
  - `ameen_connected_at`: آخر وقت تأكدنا فيه من الاتصال بالأمين، أي تطبيق ناجح أو تحقق مقروء.
  - `new_prices`: `false` حين يكون أحدث `updated_at` في الأسعار المسحوبة هو نفسه منذ آخر تطبيق، فتكون المهمة تعمل ولا جديد.
  - `previous_status` و`gap_minutes`: أساس إشارة «عادت المزامنة».
- **الأمان** (نفس قرار heartbeat خليل، Codex P1):
  - جدول مخصّص، بلا trigger ولا Telegram.
  - الكتابة عبر الدالة وحدها، لهوية المزامنة `9724dbe4…`.
  - القراءة لـ`is_staff()` ولـservice_role.
  - احتفاظ 14 يوماً.
- **القراءة لا تحتاج أي صلاحية على الأمين.** الموقع والدوال تقرأ Supabase فقط. أما «الاتصال بالأمين» فيُثبت من سكربت Windows نفسه: التطبيق بحساب الكتابة الحالي، والتحقق بحساب القراءة `AMEEN_SQL_CONNECTION_STRING`.

## تصنيف الحالة (`src/price-sync-health.js`)

| الحالة | الشرط، بالترتيب |
|---|---|
| `UNKNOWN` | لا صف، أو حالة مجهولة، أو `created_at` لا يُقرأ، أو أبعد من 5 دقائق في المستقبل |
| `DISABLED` | آخر صف `disabled` أو `paused` |
| `STALE` | آخر صف أقدم من 15 دقيقة (3 دورات)، **حتى لو كان `ok`** |
| `FAILED` | آخر صف حديث وحالته فشل، أو `ok` مع `conflict_count > 0` |
| `HEALTHY` | آخر صف حديث `ok` بلا تعارض (`reason = no_new_prices` إن لم يصل جديد) |

- `pendingEdits`: يمرّر المستهلك أحدث `approved_price_items.updated_at`. إن كان أحدث من `applied_feed_max_updated_at` بأكثر من دقيقة، فهناك تعديل لم يدخل أي تطبيق.
- `describePriceSyncHealth` يعطي النص الموحّد بتوقيت دمشق:
  - `✅ آخر وصول للأمين: 11:34`
  - `⚠️ المزامنة متوقفة منذ 10:17`
  - `❌ فشل آخر اتصال بالأمين`
  - `⛔ مهمة مزامنة الأسعار معطّلة منذ …`
  - `❔ حالة مزامنة الأسعار غير معروفة`
- **حدّ معروف:** حتى المرحلة 4 لا شيء يبلّغ عن `Disabled` في Task Scheduler. لذلك تظهر المهمة المعطّلة `STALE` بعد 15 دقيقة، لا `DISABLED`. هذا صادق (نعرف أنها لا تعمل، لا لماذا)، لكنه لا يسمّي السبب.

## الفحوص

- `scripts/check-price-sync-heartbeat.mjs`، ضمن `npm run check`:
  - سيناريوهات المصنّف: تعمل بلا جديد، متوقفة، نجاح قديم، فشل اتصال، تعارض، استئناف، تعطيل، غياب البيانات، توقيت دمشق.
  - عقود ساكنة.
  - تشغيل حي لـ`supabase/tests/price-sync-heartbeat.sql` على Postgres مؤقت. يغطي: الصلاحيات، والحمل من الصف السابق، والتعارض، والتعطيل، والاستئناف، والاحتفاظ، والتراجع.
- `tools/tests/Test-PriceSyncHeartbeat.ps1` في وظيفة PowerShell 5.1 بـ`check.yml`:
  - ينفّذ المنسّق والناشر الحقيقيين ببدائل وهمية.
  - يثبت نبضة لكل نتيجة.
  - يثبت أن رموز الخروج كما هي.
  - يثبت أن فشل النبضة لا يغيّر نتيجة المهمة.

## خطوات التفعيل (كلها بموافقة عمر، ولا شيء منها مُنفَّذ)

1. دمج الـPR. لا أثر إنتاجي، لأن الـSQL في `supabase/proposed/` لا يُطبَّق آلياً.
2. تطبيق `supabase/proposed/16-price-sync-heartbeat.sql` على Supabase من الـMac. يرفض التنفيذ إن غابت `is_staff()`.
   - التحقق: `select to_regprocedure('public.record_price_sync_heartbeat(jsonb)')`.
3. نشر السكربتات إلى OZK2026 عبر بوابة `windows-production`. `sync-approved-prices-to-ameen.ps1` سكربت كاتب، فيحتاج موافقة الكتابة في `windows-release.yml`.
   - **لا تغيير على المهمة المجدولة:** نفس الاسم والأمر والإيقاع.
   - لو وصلت السكربتات قبل الخطوة 2، يطبع الناشر `PRICE-SYNC-HEARTBEAT FAILED` كل دورة ولا يتغير شيء آخر.
4. المراقبة: بعد دورتين، `select status, created_at, last_success_at, new_prices from public.price_sync_heartbeat order by created_at desc limit 3`.
5. **التراجع:**
   - `16-price-sync-heartbeat-rollback.sql`.
   - السكربتات القديمة عبر البوابة، أو تُترك، فالفشل best-effort.

---

## تصميم المرحلة 2: شريط حالة المزامنة في صفحة الأسعار (لم يُنفَّذ)

- **المكان:** داخل `pricing()` في `src/app.js`، بين `newsletter-hero` و`newsletter-steps`.
  - سطر واحد بعرض البطاقة.
  - `role="status"` و`aria-live="polite"`.
  - RTL، والأيقونة في البداية.
  - يلتف على الهاتف بلا تمرير أفقي.
  - ألوان من متغيرات الثيم الموجودة: نجاح، تحذير، خطر، خافت. لا هوية بصرية جديدة.
- **المحتوى:** `title` و`detail` من `describePriceSyncHealth` كما هما، ليتطابق الموقع وTelegram:

  | الحالة | المثال |
  |---|---|
  | HEALTHY | ✅ آخر وصول للأمين: 11:34 |
  | STALE | ⚠️ المزامنة متوقفة منذ 10:17 + «آخر وصول للأمين: 10:15» + سطر التعديلات المعلّقة إن وُجد |
  | FAILED | ❌ فشل آخر اتصال بالأمين + آخر محاولة + آخر وصول |
  | DISABLED | ⛔/⏸ مع السبب المكتوب |
  | UNKNOWN | ❔ حالة مزامنة الأسعار غير معروفة |

- **البيانات:**
  - دالة قراءة جديدة في `src/supabase-client.js`: `price_sync_heartbeat?select=*&order=created_at.desc&limit=1` مع `Accept-Profile: public`.
  - أحدث `updated_at` من `state` الحالي لأسعار الموقع، فلا طلب إضافي.
  - قبل تطبيق SQL 16، ترجع القراءة 404/PGRST205. عندها **يختفي الشريط** ولا يظهر خطأ.
- **التحديث:**
  - عند فتح الصفحة.
  - كل 60 ثانية ما دامت مرئية، ويتوقف عند `visibilitychange` إلى مخفية.
  - بعد كل حفظ سعر.
- **عند الحفظ والحالة STALE أو FAILED أو DISABLED:**
  - تأكيد داخل الصفحة، لا `window.confirm`: «المزامنة مع الأمين متوقفة منذ … — التعديل لن يصل للكاشير حتى تعود».
  - زرّان: «حفظ على أي حال» و«إلغاء».
  - التأكيد مرة لكل دفعة، بما فيها `savePendingPricingEdits`.
  - **لا منع للحفظ.**
- **الملفات المتوقعة:**
  - `src/app.js`: إضافة فقط، ولا تغيير لمنطق الحفظ نفسه.
  - `src/supabase-client.js` و`src/styles.css`.
  - `index.html`: وسم `<script src="src/price-sync-health.js?v=tobacco-N">`. أصل جديد يحتاج المعامل يدوياً مرة واحدة (CLAUDE.md القاعدة 1).
  - قائمة كاش `public/service-worker.js` إن كانت تعدّد الأصول.
- **الاختبارات:**
  - فحص ساكن يربط الشريط بالمصنّف.
  - مسار Playwright في `check-critical-journeys` بصفوف مصطنعة للحالات الخمس، على عرض الهاتف والحاسوب، في الثيمين.
