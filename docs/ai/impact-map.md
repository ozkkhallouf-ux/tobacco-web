# خريطة التأثير والفحص

استخدم هذا الجدول قبل تعديل أي ملف. إذا شملت المهمة أكثر من مجال، طبّق فحوص كل المجالات المشمولة.

| المجال | ملفات نموذجية | مخاطر الارتباط | الحد الأدنى للتحقق |
|---|---|---|---|
| المبيعات | `src/app.js`, `src/number-normalizer.js`, `tools/push-sales-line-items.ps1`, `supabase/sales-line-items-atomic-refresh.sql` | الفاتورة، المخزون، الرصيد، الطباعة | `npm.cmd run check` + اختبار فاتورة وحساب مستقل عند تغيير الحسابات |
| النشرات | `src/app.js`, `src/price-list-template.js`, `scripts/generate-*`, `scripts/exchange-rate.json`, `public/downloads/` | السعر، الصرف، الثيم، الكاش، PDF | فحص المشروع + التوليد + مطابقة الأسعار + فحص بصري للفاتح والداكن عند تغير الشكل |
| المخزون | `src/business-snapshot.js`, `src/inventory-recon-calc.js`, `tools/ameen-sync-agent.ps1` | النشرات، الشراء، التنبيهات | فحص المشروع + مقارنة مستقلة مع حركات الأمين |
| الأرصدة | `src/app.js`, `tools/ameen-customer-balances-query.sql`, `tools/push-ameen-account-balances.ps1` | كشف الحساب، الفاتورة، الائتمان | فحص المشروع + مقارنة رصيد وحركات مع `ac000` |
| المشتريات | `src/purchase-*`, `tools/pull-purchase-invoices-from-ameen.ps1`, `supabase/purchase-*` | التكلفة، المخزون، المورد، كتابة الأمين | فحص المشروع؛ لا كتابة فعلية للأمين بلا إذن صريح |
| مزامنة الأمين | `tools/ameen-*`, `tools/push-*`, `tools/register-*` | كل التقارير المحاسبية وجدولة Windows | فحص السكربت + مهمة الجدولة + دليل حديث خاص بالعملية؛ نجاح المجدول وحده لا يكفي |
| الطباعة | منطق PDF/الفاتورة في `src/`، وجسر الطباعة المركزي خارج هذا المستودع | طابعة خاطئة، تكرار وصل، عملة/رصيد | PDF بصري أو ورقة فعلية حسب نوع المهمة؛ لا ادعاء نجاح طابعة بلا خروج ورق |
| الإشعارات والنشر | `src/web-push.js`, `supabase/functions/`, `.github/workflows/`, `public/service-worker.js` | أسرار، RLS، كاش قديم، وصول عام | فحص المشروع + CI + endpoint/URL حي؛ ظهور الإشعار على الجهاز يحتاج تأكيداً فعلياً |

## فحوص مشتركة لكل مهمة

1. `git diff --check`.
2. `npm.cmd run check`.
3. مراجعة أن diff يخص الملفات المحجوزة فقط.
4. رفع `CACHE_NAME` فقط عند تغيير ملفات منشورة ستصل للمستخدمين.
5. تحديث تقرير الموضوع بالحالة المثبتة قبل التسليم.
