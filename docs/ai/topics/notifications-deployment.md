# تقرير موضوع الإشعارات والنشر

آخر تحديث: 2026-09-15 (Sentry)

## مراقبة أخطاء الواجهة (Sentry) — 2026-09-15

المراقب الأساسي للمتصفح: محمّل Sentry CDN لمشروع `OZK TOBACCO / javascript` على `ozk-tobacco-ck.sentry.io`، مع تهيئة `window.sentryOnLoad` من `src/error-monitoring.js` (تنقية PII، تعطيل خارج الإنتاج، وإبقاء Replay مقنّعاً). مسار Rollbar يبقى احتياطاً فقط عند غياب `meta[name=ozk-sentry]`. لا تُضاف عناوين CDN إلى `ASSETS`. راجع ملاحظات الإعداد في متجر المشروع إن وُجدت.

### إصلاح 2026-09-15 — SW لا يعترض CDN ولا يرتدّ HTML خارجه

`public/service-worker.js` كان يعترض كل GET بما فيه `js.sentry-cdn.com`؛ عند فشل الشبكة (وكيل الفحوص أو offline) كان `offlineFallback` يعيد `index.html` فيُرفض السكربت بخطأ MIME ويفشل `critical-journeys` (مسار Service Worker). الآن: لا اعتراض لطلبات خارج الأصل، والارتداد الخارجي يعيد `Response.error()` بدل HTML.

## الحالة الحالية

يوجد Web Push وTelegram Edge Functions وGitHub Pages. آخر توثيق سابق أكد إشعار iPhone فعلياً بعد إصلاح الأيقونة، لكن أي حالة حية جديدة تحتاج اختباراً جديداً. نشر النشرات يعتمد workflow منفصلاً عن نشر الموقع.

## إصلاح 2026-09-15 — اكتمال قائمة ASSETS في الـService Worker

`index.html` كان يحمّل `src/number-normalizer.js` و`src/command-center-hotfix.js` بلا إدراجهما في `ASSETS` داخل `public/service-worker.js`. بعد تفعيل SW جديد يُمسح الكاش القديم ويُملأ من القائمة فقط؛ في وضع offline يرتدّ الطلب الغائب إلى `index.html` فيُقدَّم HTML مكان سكربت → `SyntaxError`. أُضيفا للقائمة، وأُضيف حارس في `scripts/check-service-worker-update-cycle.mjs` يفرض أن كل `src`/`href` محلي تحت `src/` أو `public/` في `index.html` موجود في `ASSETS`. غلاف الجذر `service-worker.js` يبقى استيراداً فقط بلا تكرار.

## إصلاحات 2026-09-14 (مراجعة أمنية شاملة، فرع `fix/ameen-worker-recovery-and-pgcron-monitor`)

1. **`.github/workflows/pages.yml` — نشر ملفات عامة فقط.** أُضيفت خطوة `Stage public-only site`
   تنسخ إلى `_site/` فقط الملفات التي يحتاجها الموقع الحيّ (`index.html`, `service-worker.js`,
   `404.html`, `privacy-policy.html`, `terms-of-use.html`, `receipt.html`, `robots.txt`,
   `sitemap.xml`, `src/`, `public/`) وترفع `_site` بدل جذر المستودع. قبل الإصلاح كان
   `upload-pages-artifact` يرفع المستودع كاملاً — توثيق AI الداخلي وسكريبتات `tools/*.ps1`
   الكاشفة لبنية SQL Server وملفات `supabase/migrations` كانت تُخدَّم علناً؛ مؤكَّد حياً وقتها
   بطلبات curl مباشرة رجعت 200 لملفات مثل `AI_WORK_SYNC.md`.
2. **`public/service-worker.js` — منع تسريب استجابات cross-origin إلى Cache Storage.**
   معالج `fetch` كان يخزّن أي استجابة GET ناجحة بلا فحص أصل أو مسار، بما فيها طلبات REST
   لـ`supabase.co` (بيانات عملاء/أرصدة/أسعار حساسة تمرّ كـGET) — تبقى على جهاز العميل بلا
   مسح عند تسجيل الخروج. أُضيف قيد same-origin + `STATIC_ASSET_PATH` قبل `cache.put` (نفس
   القيد المستخدم أصلاً في `offlineFallback`، لكن هنا قبل التخزين لا داخل مسار fallback وحده).
3. **صلاحيات `smart_inventory_*` — انحراف حي في Supabase (تغيير قاعدة بيانات، ليس ملف
   مستودع).** رغم أن `supabase/smart-inventory.sql` يتتبَّع `revoke ... from public,anon`،
   استعلام مباشر على `information_schema.routine_privileges` أظهر أن دور `anon` يملك فعلياً
   EXECUTE على 11 دالة من دوال smart_inventory. نُفِّذ migration
   `fix_smart_inventory_anon_grant_drift` (revoke من public/anon ثم grant لـ authenticated
   فقط) بعد موافقة صريحة منفصلة من المستخدم، وتحقّق لاحق بنفس الاستعلام رجع نتيجة فارغة
   (لا صلاحيات anon متبقية).

**مؤجَّل من نفس المراجعة:** فحوص صحة pg_cron في CI (`scripts/check-cron-job-health-classifier.mjs`)
static-only — تطابق نص SQL بالـregex ولا تنفّذ شيئاً على قاعدة حية. بناء فحص حي حقيقي
يتطلب حاوية Postgres في CI بمخطط `pg_cron` مُحاكى (غير متوفر بصور Postgres الاعتيادية) —
خارج نطاق "أصغر تعديل ممكن"؛ يحتاج مهمة منفصلة مستقبلاً.

## المصدر الموثوق

الكود المرجعي في المستودع، الإصدارات المنشورة في Supabase/GitHub، ثم دليل endpoint أو الجهاز الفعلي. سجل outbox وحده لا يثبت ظهور إشعار على شاشة iPhone.

## أساس تيليغرام في سلسلة المهاجرات النشطة (PR #228، 2026-09-15)

`supabase/telegram-notifications.sql` يبقى المرجع التشغيلي الكامل (خارج المهاجرات).
لإعادة تشغيل نظيفة لسلسلة `supabase/migrations/` دون تشغيل ذلك الملف يدوياً، يوفّر
`20260830141802_khalil_audit_log.sql` على مسار القاعدة الفارغة فقط أساس الإدراج:
`telegram_outbox` + `notify_telegram(text,text,text,int)` (+ `reply_markup`) مستخرجاً
من المرجع — بلا dispatch/cron/triggers المجالات. الإنتاج يتخطّى الملف لأن الإصدار
مسجَّل أصلاً.

## نطاق الملفات

`src/web-push.js`, `public/service-worker.js`, `public/manifest.webmanifest`, `supabase/functions/web-push/`, `supabase/functions/telegram-webhook/`, `supabase/*notifications.sql`, `.github/workflows/`.

## قيود ثابتة

- لا أسرار في المتصفح أو Git؛ Telegram token في Vault.
- Edge Function المنشورة والنسخة المرجعية في المستودع تتغيران معاً.
- تغيير ملفات الواجهة المنشورة يحتاج رفع `CACHE_NAME`، أما تغيير الوثائق فقط فلا يحتاجه.
- workflow توليد النشرات لا يستخدم `[skip ci]` عند دفع الملفات التي يجب أن تطلق Pages.

## فحوص إلزامية

`npm.cmd run check`، نجاح CI، فحص الرابط أو إصدار الدالة الحي، واختبار جهاز فعلي عندما يكون الادعاء متعلقاً بظهور إشعار أو كاش PWA.

## الخطوة التالية

بعد كل نشر، دوّن هنا الإصدار أو PR ووسيلة التحقق الحي، ولا تسجل payload يحتوي بيانات زبون.
