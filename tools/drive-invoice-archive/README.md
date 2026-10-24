# عامل أرشفة فواتير الجملة على Google Drive (OZK2026)

> **غير مفعَّل.** لا مهمة مجدولة ولا workflow يشغّله (يفرض ذلك `scripts/check-drive-invoice-archive.mjs`).
> كل خطوة تفعيل أدناه بموافقة صريحة من المالك. المرجع: `docs/ai/topics/drive-invoice-archive.md`.

## ما يفعله

```
الأمين AmnDb002 (قراءة فقط)
   │ كل 30ث: فواتير جملة مرحَّلة تغيّرت (CreateDate/LastUpdateDate) + مطابقة شاملة كل 30د
   ▼
worker.js  ── PDF بالقالب الرسمي A4 (tools/ameen-autoprint/invoice-html.js + خط Cairo) عبر Edge
   │ طابور دائم على القرص: rendered → uploaded → notified
   ▼
Google Drive (ozkkhallouf@gmail.com وحده، نطاق drive.file)
   OZK Tobacco Archive / فواتير مبيعات الجملة / 2026 / 11 / <الزبون [guid8]> / فاتورة جملة - رقم N - YYYY-MM-DD - guid8.pdf
   ▼
Edge Function document-archive-notify  ── sendDocument إلى bot_config.owner_chat_id وحده (PDF + رابط Drive الخاص)
```

- الفاتورة تُؤرشف بعد ثباتها 180 ثانية بلا تعديل. تعديلها بعد الأرشفة ينشئ «نسخة 2» بجانب الأولى، ولا يُستبدل ولا يُحذف شيء.
- التكرار ممنوع: هوية المهمة `sha256(نوع|GUID|بصمة المحتوى|النسخة)`، والملف يحمل `appProperties.ozkJobId`،
  فإعادة التشغيل بعد انقطاع تجد الملف المرفوع ولا ترفعه ثانية. إعادة محاولة تيليغرام لا تعيد الرفع.
- الهوية تُفحص قبل كل رفع (كل 5 دقائق على الأكثر): حساب آخر ⇒ توقف `IDENTITY_MISMATCH`. أي مجلد في مسار الوجهة (الجذر أو النوع أو السنة أو الشهر أو الزبون) صار مشتركاً ⇒ توقف `NOT_PRIVATE` قبل إرسال المحتوى، والمجلدات المخبّأة تُفحص من جديد في كل رفع.
- العامل لا يستدعي مسار المشاركة في Drive ولا يحذف ولا يعدّل ملفاً.
- الفوترة لا تتأثر إطلاقاً: العامل يقرأ فقط، وأي عطل في Drive أو الإنترنت أو تيليغرام يبقي المهمة في الطابور.

## الأوضاع (`config.json`)

| `mode` | ما يجري |
|---|---|
| `dry-run` (الافتراضي) | كشف + PDF محلي في `data\pdf\` فقط. لا Drive ولا تيليغرام |
| `drive` | + رفع إلى Drive. بلا تيليغرام |
| `live` | + إشعار تيليغرام للمالك (يتطلب `edgeUrl` وسرّ `notify`) |

`archiveFrom` إلزامي: لا يُؤرشف ما قبله (لا أرشفة رجعية جماعية بالخطأ).

## الأسرار (خارج Git، DPAPI على الجهاز)

في `%ProgramData%\OZK\DriveArchive\<name>.secret`، تُكتب بـ`set-secret.ps1` فقط وتُقرأ لمستخدم المهمة وحده:

| الاسم | المحتوى | كيف |
|---|---|---|
| `sql` | سلسلة اتصال قراءة (يُرفض `sa`، ويُفرض `ApplicationIntent=ReadOnly`) | `Get-Content conn.txt \| powershell -File set-secret.ps1 -Name sql -User loq` |
| `google-oauth` | client_id/secret + refresh_token + الحساب | **المالك بنفسه:** `node authorize.js --client client_secret_….json --user loq` |
| `notify` | سرّ مشترك مع دالة Edge (≥ 32 حرفاً) | `set-secret.ps1 -Name notify` ثم `DOCUMENT_ARCHIVE_SECRET` في أسرار الدالة |

`authorize.js` يفتح المتصفح على حساب Google، ويتحقق أن الحساب المصادق هو `ozkkhallouf@gmail.com`؛
أي حساب آخر ⇒ يُلغى التوكن فوراً ولا يُحفظ شيء. لا يطبع أي توكن.

## الأوامر

```
node worker.js --health     فحص الجاهزية (الأمين، الهوية في Drive، خصوصية الجذر، Edge) بلا رفع ولا إرسال
node worker.js --once       دورة واحدة ثم خروج
node worker.js              حلقة دائمة (للمهمة المجدولة بعد الموافقة)
node worker.js --status     ملخص الطابور المحلي
node worker.js --retry failed | <jobId>
```

البيانات: `%ProgramData%\OZK\DriveArchive\data\` (`jobs\` و`pdf\` و`state.json` و`logs\` JSONL بلا أسرار).

## الاختبارات

`node scripts/check-drive-invoice-archive.mjs` من جذر المستودع: حراسات ثابتة + 28 اختبار عامل (أمين وDrive وEdge وهمية،
وPDF حقيقي بالخط الرسمي) + 3 اختبارات لدالة Edge الحقيقية (Node ≥ 22) + الهجرة 22 على PostgreSQL محلي.
