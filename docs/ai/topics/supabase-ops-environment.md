# حماية مفتاح Supabase في GitHub Actions (بيئة `supabase-ops`)

## الحالة الحالية

- `SUPABASE_SERVICE_ROLE_KEY` سرّ على **مستوى المستودع**. أي جهة تستطيع دفع فرع (المالك، أو
  تطبيق بصلاحية كتابة) تستطيع قراءته بـworkflow على فرعها، لأن أسرار المستودع لا تُقيَّد بفرع.
- ثلاثة jobs فقط تحتاجه، وكلها صارت خلف `environment: supabase-ops` وشرط
  `github.ref == 'refs/heads/main'`:

| الـworkflow | الـjob | الزناد | الاستعمال |
|---|---|---|---|
| `health-check.yml` | `health-check` | جدولة كل 30 دقيقة + يدوي | `notify_telegram` و`health_lifecycle` |
| `stock-priority-alerts.yml` | `stock-priority-alerts` | يدوي احتياطي (الجدولة في pg_cron) | قراءة `inventory_reports`/`bot_config` و`notify_telegram` |
| `alert-on-automation-failure.yml` | `notify` | `workflow_run` (يعمل بنسخة main دائماً) | `notify_telegram` |

- الحماية الفعلية **لا تكتمل** إلا بعد نقل السرّ إلى البيئة وحذف نسخة المستودع (الترتيب أدناه).
  قبل ذلك يبقى السرّ قابلاً للقراءة من أي فرع كما كان.
- لا `deployment: false`: لم يثبت بعد أن سياسة فروع البيئة تبقى مطبَّقة معه، فكل تشغيل
  ينشئ سجل deployment في `supabase-ops` (ضجيج مقبول مقابل ضمان السياسة).

## المصدر الموثوق

- إعداد البيئة على GitHub: `supabase-ops`، فروع النشر = `main` وحده، بلا مراجعين (كي لا تتوقف
  الجدولة)، `can_admins_bypass=false`.
- `scripts/supabase-service-headers.mjs`: المفتاح القديم (JWT) في `apikey` و`Authorization`،
  ومفتاح `sb_secret_` في `apikey` وحده (المنصة ترفض `sb_secret_` في Bearer بـ«Invalid JWT»).

## نطاق الملفات

`.github/workflows/{health-check,stock-priority-alerts,alert-on-automation-failure}.yml`،
`scripts/supabase-service-headers.mjs`، `scripts/health-check.mjs`، `scripts/stock-priority-alerts.mjs`،
`scripts/check-supabase-ops-environment.mjs`.

## القيود الثابتة

1. **البيئة توجد قبل الدمج.** job يشير لبيئة غير موجودة يُنشئها GitHub تلقائياً **بلا أي حماية**.
2. **لا يُحذف سرّ المستودع قبل نجاح تشغيلات حقيقية من البيئة.** سرّ البيئة يتقدّم على سرّ
   المستودع بالاسم نفسه، وغيابه يعيد القراءة إلى سرّ المستودع، فالترتيب أدناه بلا فجوة.
3. لا مراجعين على `supabase-ops`: health-check يعمل كل 30 دقيقة ولا ينتظر موافقة.
4. لا `pull_request`/`pull_request_target`/`push` في هذه الـworkflows، ولا سرّ داخل `run:`.
5. المفتاح نفسه موجود في `tools/.env` على OZK2026 وفي أسرار Edge Functions؛ **لا تدوير** له
   من هنا. Actions تنتقل إلى مفتاح `sb_secret_` مستقل بدل ذلك.
6. المفاتيح القديمة (`anon`/`service_role`) تعمل حتى نهاية 2026 وفق توثيق Supabase؛ OZK2026
   والدوال تحتاج خطة انتقال منفصلة قبل ذلك.

## الترتيب الآمن للنقل (كل خطوة بموافقة عمر)

1. إنشاء `supabase-ops` (main فقط، بلا مراجعين، بلا bypass) والتحقق منها.
2. دمج هذا الـPR. التشغيلات تقرأ سرّ المستودع (لا سرّ في البيئة بعد) فلا انقطاع.
3. التحقق: تشغيل health-check المجدول التالي ينجح ويظهر deployment في `supabase-ops`.
4. وضع `SUPABASE_SERVICE_ROLE_KEY` في البيئة (القيمة نفسها مؤقتاً، أو مفتاح `sb_secret_` الجديد).
5. التحقق: تشغيلتا health-check مجدولتان ناجحتان + `notify_telegram` يقبل (لا HTTP ≥ 300).
6. حذف `SUPABASE_SERVICE_ROLE_KEY` من أسرار المستودع. ثم تشغيل مجدول ناجح ثالث.

**التراجع:** قبل الخطوة 6 يكفي حذف سرّ البيئة (تعود القراءة لسرّ المستودع). بعدها: إعادة السرّ
إلى المستودع، أو revert لهذا الـPR (يُرجع الـjobs بلا بيئة). مفتاح `sb_secret_` يُعطَّل وحده من
لوحة Supabase دون مساس بـOZK2026 أو الدوال.

## مفتاح `sb_secret_` المستقل لـActions

- الصلاحية: مثل `service_role` تماماً (يتجاوز RLS)، **ليس محدوداً**. ميزته أنه يُلغى ويُدوَّر
  وحده، فتسرّبه من Actions لا يفرض تدوير مفتاح OZK2026 والدوال.
- التوافق: الكود هنا يرسله في `apikey` وحده تلقائياً. Node وcurl لا يحملان User-Agent متصفح،
  فلا يقع عليهما رفض «401 من المتصفح».
- الاختبار الآمن قبل التحويل: من الـMac (السحابة لا تصل supabase.co) طلب قراءة واحد
  `GET /rest/v1/bot_config?key=eq.low_stock_threshold&select=value` بالمفتاح في `apikey` وحده،
  ثم `POST /rest/v1/rpc/health_lifecycle` بـ`p_op=probe` (لا يرسل تيليغرام). لا `notify_telegram` تجريبياً.
- بعد التحويل: المفتاح القديم يبقى كما هو لـOZK2026 والدوال، ويختفي من GitHub كلياً.

## الفحوص الإلزامية

`node scripts/check-supabase-ops-environment.mjs` (ضمن `npm run check`)، و`check-alert-on-automation-failure.mjs`
و`check-health-check-logic.mjs` و`check-stock-alert-priority.mjs`.

## الخطوة التالية

موافقة عمر على إنشاء البيئة ثم الدمج ثم نقل السرّ بالترتيب أعلاه.
أسرار أخرى: `GENERATE_TOKEN` غير مستعمل في أي workflow (يُحذف بموافقة)، و`ROLLBAR_POST_CLIENT_ITEM_TOKEN`
رمز عميل يُحقن في `index.html` المنشور علناً أصلاً (نقله لبيئة `github-pages` اختياري).
