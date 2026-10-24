# أرشفة فواتير الجملة على Google Drive + إشعار تيليغرام

## الحالة الحالية

مبنية ومختبرة على الفرع، **غير مفعَّلة**: الهجرة 22 غير مطبّقة، ودالة Edge غير منشورة، والعامل غير مثبّت على OZK2026،
و`appConfig.documentArchive.driveUi=false`. تحلّ محلّ واجهة iCloud (قرار المالك 2026-10-24) التي أُخفيت بالمفتاح
`documentArchive.icloudUi=false` وبقي كودها وجسرها للتراجع (`icloud-archive.md`).

المرحلة 1: فواتير مبيعات الجملة. المرحلة 2 (لم تُبنَ): سندات القبض والدفعات من py000/et000.

## المصدر الموثوق

- **الحساب الوحيد:** `ozkkhallouf@gmail.com` مالك الأرشيف، ثابت في `tools/drive-invoice-archive/lib/config.js` (`APPROVED_ACCOUNT`).
  `ozkkh27@gmail.com` غير مخوّل؛ لا مشاركة معه ولا مع غيره. الملفات خاصة، ولا رابط عام.
- **الفاتورة:** الأمين `bu000` قراءة فقط، المرحَّلة، بأنواع الجملة المعتمدة (الكاشير `cc1097b1…` مستبعد)، هوية الزبون `cu000.GUID`.
- **PDF:** قالب A4 الرسمي `tools/ameen-autoprint/invoice-html.js` بخط Cairo المضمَّن عبر puppeteer-core وEdge على الجهاز —
  ليس قالب الموقع `src/documents/invoice/ozk-invoice.js`.
- **المستلم:** `bot_config.owner_chat_id` تقرؤه دالة Edge بنفسها؛ أي حقل مستلم في الطلب يُرفض. لا إرسال للزبائن إطلاقاً.
- **الحالة في الموقع:** مرآة يرسلها العامل إلى `document_archive_heartbeat` و`document_archive_items` (قراءة للمالك وحده بـRLS).

## نطاق الملفات

| الملف | الدور |
|---|---|
| `tools/drive-invoice-archive/` | العامل، المصادقة `authorize.js`، الأسرار `set-secret.ps1`، الاختبارات، `README.md` |
| `supabase/functions/document-archive-notify/index.ts` | `/notify` (sendDocument للمالك + تسجيل message_id) و`/report` (المرآة + طلبات إعادة المحاولة) |
| `supabase/functions/_shared/document-archive.js` | التحقق من الحقول والرابط وPDF ونص الإشعار (مشترك مع اختبارات العامل) |
| `supabase/config.toml` | `verify_jwt = false` للدالة (المصادقة بسرّ `x-ozk-archive-secret`) |
| `supabase/proposed/22-document-archive*.sql` | الجداول الثلاثة وRLS والدوال، والتراجع |
| `supabase/tests/document-archive.sql` | 23 تأكيداً على PostgreSQL محلي |
| `src/drive-archive-status.js` | شارة المالك ولوحتها: الحالة، آخر نجاح، المعلّق والفاشل، إعادة المحاولة، روابط Drive وبحث برقم الفاتورة |
| `src/icloud-archive.js` | `uiHidden()`: إخفاء الشارة والتنبيهات بالمفتاح فقط |
| `src/config.js` | `documentArchive: { icloudUi, driveUi }` |
| `scripts/check-drive-invoice-archive.mjs`، `scripts/check-document-archive-ui.mjs` | البوابتان |

`src/app.js` لم يُلمس: رابط Drive داخل تفاصيل الفاتورة مؤجّل (تعارض مع #357)، والبديل البحث برقم الفاتورة في لوحة الشارة.

## القيود الثابتة

- الأمين قراءة فقط (حساب ليس `sa`، `ApplicationIntent=ReadOnly`، `assertReadOnlySql` على كل استعلام، وبوابة الأنماط نفسها لبوابة نشر Windows).
- Drive: نطاق `drive.file` وحده؛ لا مسار permissions ولا حذف ولا PATCH ولا سلة. هوية الحساب تُفحص قبل الرفع؛ جذر مشترك ⇒ توقف.
- لا استبدال صامت: تعديل فاتورة مؤرشفة ⇒ نسخة جديدة بجانب القديمة (`- نسخة 2`). ملف تالف (md5 مختلف) يبقى ويُرفع بديل بجانبه.
- لا إشعار نجاح قبل تأكيد الرفع (md5 والحجم). تيليغرام «مرة على الأقل»: يضيّق التكرار فحص `job_id` في Supabase قبل الإرسال،
  ويبقى احتمال رسالة مكررة إن ضاع ردّ تيليغرام بعد الإرسال وقبل التسجيل.
- العامل في الخلفية على OZK2026، لا في المتصفح؛ لا يوقف فوترة ولا طباعة (الكاشير 80mm والجسر لا يُلمسان).
- الأسرار خارج Git (DPAPI)، والسجلات منقّحة (`lib/redact.js`).

## الفحوص الإلزامية

- `node scripts/check-drive-invoice-archive.mjs` (يشمل SQL حياً، إلزامي في CI).
- `node scripts/check-document-archive-ui.mjs` (Playwright).
- اختبارات Edge الحقيقية تُتخطّى على Node < 22 (CI على 20)؛ شغّلها محلياً بـNode 22 بعد أي تعديل على الدالة.

## الخطوة التالية (كلها بموافقة المالك)

1. المالك: مشروع Google Cloud، تفعيل Drive API، شاشة موافقة **In production** (وإلا تنتهي صلاحية refresh token بعد 7 أيام)،
   عميل OAuth من نوع Desktop app.
2. تطبيق الهجرة 22 ونشر `document-archive-notify` من الـMac مع `DOCUMENT_ARCHIVE_SECRET`.
3. تثبيت العامل على OZK2026 (`npm ci` في المجلد) وحفظ سرّي `sql` و`notify`، ثم المالك يشغّل `authorize.js` بنفسه.
4. `--health` ثم `dry-run` ثم `drive` ثم `live`، كل مرحلة بموافقة، ثم `driveUi=true`.
