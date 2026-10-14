# تنسيق تنبيهات تيليغرام الموحّد (ozk_remind_bot)

طلب المالك (2026-10-14): تنبيهات واضحة على شاشات الهواتف، عربية RTL بأرقام إنجليزية
وأسماء أصناف مختلطة، بلا تداخل نصوص، بطاقة لكل صنف، وتقسيم الرسائل الطويلة دون قطع
بيانات أي صنف — **دون تغيير أي حساب أو أولوية أو حد تنبيه**.

## مسار الإرسال (كما هو، لم يتغيّر)

```
مصدر الرسالة ← notify_telegram(event, text, dedupe_key, minutes[, reply_markup])
            ← telegram_outbox (left(text, 3900))
            ← dispatch_telegram_outbox() كل دقيقة ← sendMessage {chat_id, text[, reply_markup]}
```

`dispatch_telegram_outbox()` لا يرسل `parse_mode` (`supabase/telegram-notifications.sql`،
والنسخة الحية في `supabase/migrations/20260914121528_telegram_delivery_confirmation_retry.sql`).
كل التنبيهات اليوم **نص عادي**.

## القرار: نص عادي آمن، لا HTML parse_mode

| | HTML parse_mode | نص عادي + عزل الاتجاه (المعتمد) |
|---|---|---|
| تغيير الإنتاج | عمود/وسيط جديد في `telegram_outbox` وتعديل الموزّع ⇒ هجرة على الإنتاج | لا شيء خارج الدوال/السكربتات المعنية |
| القصّ عند 3900 | قد يقصّ وسماً من منتصفه ⇒ تيليغرام يرفض الرسالة كاملة (تنبيه حرج يضيع) | القصّ يُبقي نصاً مقروءاً |
| أحرف `< > &` في الأسماء | تهريب إلزامي لكل قيمة ديناميكية، ونسيان واحد = رسالة مرفوضة | تظهر حرفياً ولا تُفسَّر |

تيليغرام يقبل النص بلا تفسير حين يغيب `parse_mode`، فلا خطر حقن تنسيق. الوضوح يأتي من
البنية (عنوان، سطر لكل حقل، فواصل، إيموجي الحالة) لا من الخط العريض.

## المنسِّق: `src/telegram-format.js`

منطق نقي (IIFE ← `globalThis.ozkTelegramFormat`)، ونسخته
`supabase/functions/_shared/telegram-format.js` مطابقة بايتاً ببايت.

| الدالة | العمل |
|---|---|
| `line(text)` | يبدأ السطر بـRLM (U+200F) ⇒ اتجاهه من اليمين ولو بدأ باسم لاتيني |
| `field(label, value)` | `RLM + "التسمية: القيمة"` |
| `name(value)` | اسم ديناميكي داخل FSI…PDI (U+2068/U+2069) بعد `clean` |
| `num(value, digits)` | أرقام إنجليزية بفواصل آلاف داخل LRI…PDI (U+2066/U+2069) ⇒ `-5` لا تنقلب `5-` |
| `clean(value)` | يحذف محارف التحكم والاتجاه الواردة (RLO/LRE/RLM/العزل) والأسطر، ويقصّ عند 120 محرفاً بـ`…` |
| `composeMessages({title, intro, blocks, footer, maxChars})` | يجمع الكتل في رسائل ≤ 3500، **لا يشطر كتلة**، يرقّم `(1/3)` عند التعدد، المقدمة في الأولى والخاتمة في الأخيرة |
| `stripBidi(text)` | للفحوص والمعاينة فقط |

حدود: `maxMessageChars = 3500` (وحدات UTF-16) تحت قصّ `notify_telegram` (3900 محرف) وحد
تيليغرام (4096). كتلة أكبر من الحد وحدها (غير ممكنة مع أسماء مقصوصة عند 120) تُرسل
منفردة مقصوصة بعلامة `…` بدل أن يرفضها تيليغرام.

## ما طُبّق في هذه المرحلة

### 1) تنبيه النفاد حسب أولوية المبيعات (`src/stock-alert-priority.js`)

التصنيف كما هو حرفياً في `classifyItem`: 🔴 **نافد** = الرصيد ≤ 0، و🟠 **قريب من النفاد** =
يكفي ≤ `lowCoverageDays` (3) أيام أو الرصيد ≤ `low_stock_threshold`. الترتيب بالأولوية كما
هو. منع التكرار (`dedupeKey` من بصمة الأصناف وحالاتها) لم يتغيّر.

```
⚠️ أصناف مهمة قاربت النفاد (1/2)
العدد: 40 من 40 صنفاً مهماً
🔴 نافد: 20  ·  🟠 قريب: 20
الترتيب حسب الأولوية (صافي مبيع آخر 30 يوماً)
┈┈┈┈┈┈┈┈┈┈┈┈
🔴 Marlboro Gold 20s
الحالة: نافد
الأولوية: 1 من 40
الرصيد: 0 كروز
يعادل: 0 كرتونة
يكفي: 0 يوم
┈┈┈┈┈┈┈┈┈┈┈┈
🟠 ونستون أزرق — 100mm
...
```

سطر «يعادل» يظهر فقط حين `unit2Factor > 1`؛ وبدونه الرصيد بخانة عشرية. رسالة التقادم
بالبنية نفسها (`⏳ تنبيهات النفاد متوقفة` ← السبب ← سطر لكل مصدر ← فاصل ← الخاتمة).

المستهلكون الثلاثة يحمّلون المنسِّق قبل المحرك: `scripts/stock-priority-alerts.mjs`،
`supabase/functions/stock-priority-alert/index.ts`، `scripts/telegram-alert-samples.mjs`.
غيابه يرمي `telegram_format_unavailable` (يسجّله مراقب pg_cron فشلاً) بدل رسالة بتنسيق آخر.

### 2) تنبيه فشل GitHub Actions (`.github/workflows/alert-on-automation-failure.yml`)

عنوان `🚨 فشل أتمتة GitHub Actions` ثم سطر لكل حقل يبدأ بتسمية عربية (سير العمل، النتيجة،
الفرع، المحاولة، الرابط). bash بلا منسِّق JS، فالبداية العربية لكل سطر تكفي للاتجاه.

## جرد مصادر الرسائل (تدقيق 2026-10-14، قراءة فقط)

كل ما يلي يمرّ بـ`notify_telegram` إلا ردود البوت التفاعلية.

| المصدر | الملف المرجعي | النوع | الحالة |
|---|---|---|---|
| تنبيه النفاد حسب الأولوية + التقادم | `src/stock-alert-priority.js` | JS (pg_cron ← Edge) | **موحّد** |
| فشل GitHub Actions | `.github/workflows/alert-on-automation-failure.yml` | bash | **موحّد** |
| غياب الزبائن المهمين | `src/customer-intelligence.js` (`buildInactivityAlert`) | JS (Edge، dry-run) | مرحلة 2 |
| طلب واتساب/طلب عميل/دفعة/أسعار/مادة جديدة/حد ائتمان/مخاطر ائتمان/مبيعات/حركة/جرد/مستندات/تكاليف | `supabase/telegram-notifications.sql` (triggers) | SQL | مرحلة 2 (هجرة) |
| التقرير الصباحي والمسائي وأقسامه | `supabase/telegram-notifications.sql`، `supabase/telegram-daily-cash-report.sql`، هجرة `20260926234241_…` | SQL | مرحلة 2 (هجرة) |
| مراقبة المهام وpg_cron | `supabase/project-task-health-monitor.sql`، `supabase/proposed/*` | SQL | مرحلة 2 (هجرة) |
| مراقبة تنبيهات النفاد | `supabase/migrations/20261003113851_stock_priority_alert_cron.sql` | SQL | مرحلة 2 (هجرة) |
| الجرد الذكي | `supabase/smart-inventory.sql` | SQL | مرحلة 2 (هجرة) |
| سجل خليل | هجرات `khalil_*` | SQL | مرحلة 2 (هجرة) |
| فحص الصحة | `scripts/health-check.mjs` (`.github/workflows/health-check.yml`) | JS | مرحلة 2 |
| أعطال Windows | `tools/send-telegram-notification.ps1` (≈19 سكربتاً يستدعيه)، `tools/deploy-gate/notify.ps1` | PowerShell | مرحلة 2 (نشر Windows عبر البوابة) |
| ردود أوامر البوت | `supabase/functions/telegram-webhook/index.ts` | Edge (sendMessage مباشر) | ردود لا تنبيهات؛ خارج النطاق |
| ozk-uptime | `workers/uptime` | — | DRY_RUN بلا مرسِل |

تعديل أي نص SQL يحتاج هجرة تُطبَّق على الإنتاج، وسكربتات Windows لا تصل الجهاز إلا بإصدار
`windows-production` — لذلك أُجّلت بقرار نطاق، ولا تُطبَّق بلا موافقة عمر.

## الفحوص والمعاينة

- `scripts/check-telegram-format.mjs`: العربية وRLM، الأرقام الإنجليزية، السالب، الأسماء
  المختلطة وأحرف HTML حرفياً، حقن محارف الاتجاه والأسطر، القصّ، التقسيم دون شطر كتلة والترقيم،
  توازن العزل، ثبات الحسابات، تطابق نسخة `_shared`، وغياب `parse_mode`.
- `scripts/check-stock-alert-priority.mjs`: محدَّث لبنية البطاقة.
- معاينة محلية بلا شبكة ولا إرسال: `node scripts/telegram-alert-samples.mjs [--long|--stale]`.

## النشر (بموافقة عمر وحدها)

لا هجرة. بعد الدمج: نشر الدالة `stock-priority-alert` (تحمل `_shared/telegram-format.js`).
حتى ذلك الحين تبقى الدالة المنشورة على التنسيق القديم. بصمة منع التكرار لم تتغيّر، لكن عدد
الأجزاء قد يتغيّر لنفس المجموعة (البطاقة أطول من السطر) فيُعاد إرسالها مرة واحدة بعد النشر.
