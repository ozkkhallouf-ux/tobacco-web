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

نسخة الأرشيف وحدها تحمل عمودَي «سعر الوحدة» و«الإجمالي» (`lib/line-prices.js`): قيمة السطر
`Price × Qty ÷ معامل(Unity)` بعملة الفاتورة (القاعدة المعتمدة من #276)، ولا تُعرض إلا إذا طابق
مجموع الأسطر إجمالي الفاتورة بفرق تقريب ≤ 0.005. وإلا يُطبع القالب كما كان مع حدث
`line_prices_skipped` في السجل (رقم الفاتورة والسبب فقط). الطباعة التلقائية واليدوية A4 بلا تغيير.

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

## التشغيل المجدول (مقترح، غير مسجَّل)

`run-scheduled.ps1` غلاف لمهمة Windows: كل تشغيل دورة واحدة `node worker.js --once` ثم خروج،
والمهمة تكرّره كل دقيقة. لا حلقة مستمرة.

- **نسخة واحدة:** Mutex عام، فوقه قفل المنفذ داخل العامل. تشغيل ثانٍ أثناء الأول يخرج بـ10.
- **الوضع محصور:** يرفض أي وضع ليس ضمن `-AllowedModes`، وخروجه 12. الافتراضي `dry-run` وحده.
- **المهلة:** `-TimeoutSeconds`، الافتراضي 600. الدورة التي تتجاوزها تُقتل مع شجرتها (node وEdge)، وخروجها 11.
- **الإيقاف الآمن:** ملف `%ProgramData%\OZK\DriveArchive\STOP` يمنع أي دورة جديدة، وخروجه 13. لا يقطع الدورة الجارية.
- **السجل:** `data\logs\scheduled-run.log`، سطر JSON لكل تشغيل.
  - يُنقَّح من أي سر قبل الكتابة.
  - يُدوَّر عند 1MB، ويُحتفظ بخمسة ملفات.
- **الحالة:** `scheduled-run.state.json` يحفظ آخر نجاح وعدد الإخفاقات المتتالية. عند الإخفاق الخامس يُسجَّل `failure_streak`.
- **رموز الخروج:**
  - 0 نجاح.
  - 1 فشل العامل.
  - 2 انتهت التجربة المحصورة.
  - 3 دورة ناقصة (فشل الرصد، أو Drive غير متصل).
  - 5 إيقاف أمني (needs_reauth، أو حساب غير معتمد، أو مجلد مشترك).

القالب المقترح للمراجعة وحدها: `scheduled-task/OZK-DriveArchive-DryRun.task.xml`.
- معطَّل حتى لو استُورد.
- S4U بحساب LOQ، بلا كلمة مرور مخزّنة.
- IgnoreNew، وأولوية منخفضة، و`-AllowedModes dry-run`.
- لا سكربت في المستودع يسجّله، والتسجيل قرار منفصل للمالك.

الاختبار: `__tests__/Test-RunScheduled.ps1` بعامل وهمي (`fake-worker.js`). يعمل تحت PowerShell 5.1 في CI، وتحت pwsh عبر سكربت الفحص.

## الاختبارات

`node scripts/check-drive-invoice-archive.mjs` من جذر المستودع: حراسات ثابتة + 28 اختبار عامل (أمين وDrive وEdge وهمية،
وPDF حقيقي بالخط الرسمي) + 3 اختبارات لدالة Edge الحقيقية (Node ≥ 22) + الهجرة 22 على PostgreSQL محلي.
