# تقرير موضوع الإشعارات والنشر

آخر تحديث: 2026-08-23

## الحالة الحالية

يوجد Web Push وTelegram Edge Functions وGitHub Pages. آخر توثيق سابق أكد إشعار iPhone فعلياً بعد إصلاح الأيقونة، لكن أي حالة حية جديدة تحتاج اختباراً جديداً. نشر النشرات يعتمد workflow منفصلاً عن نشر الموقع.

## المصدر الموثوق

الكود المرجعي في المستودع، الإصدارات المنشورة في Supabase/GitHub، ثم دليل endpoint أو الجهاز الفعلي. سجل outbox وحده لا يثبت ظهور إشعار على شاشة iPhone.

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
