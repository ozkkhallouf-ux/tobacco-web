# بيئة supabase-ops: حماية مفتاح Supabase في GitHub Actions (2026-10-21)

## المشكلة

`SUPABASE_SERVICE_ROLE_KEY`، ومعه `GENERATE_TOKEN` و`ROLLBAR_POST_CLIENT_ITEM_TOKEN`، معرّف **على
مستوى المستودع**. سرّ المستودع يقرأه أي workflow على أي فرع، فأي جهة تستطيع دفع فرع تستطيع قراءته.
تكفي workflow بـ`on: push`، أو نسخة معدّلة من `health-check.yml` تُشغَّل يدوياً من الفرع.

## مستعملو المفتاح على main

| workflow | job | المُطلق | الاستعمال |
|---|---|---|---|
| `health-check.yml` | `health-check` | schedule (كل 30 دقيقة) + يدوي | `rpc/notify_telegram` و`rpc/health_lifecycle` |
| `stock-priority-alerts.yml` | `stock-priority-alerts` | يدوي فقط (احتياط، آخر تشغيل 2026-10-03) | قراءة `inventory_reports` و`bot_config` + `rpc/notify_telegram` |
| `alert-on-automation-failure.yml` | `notify` | workflow_run (نسخة main دائماً) | `rpc/notify_telegram` |

- `GENERATE_TOKEN`: لا يستعمله أي workflow على main.
- `ROLLBAR_POST_CLIENT_ITEM_TOKEN`: توكن «post_client_item» عميل بطبيعته، يُضمَّن في JS المتصفح، و`pages.yml` يعمل في بيئة `github-pages` المحصورة بـmain.

## الحماية

- **البيئة `supabase-ops`** (أُنشئت 2026-10-21):
  - سياسة فروع مخصّصة: `main` فقط.
  - `can_admins_bypass: false`.
  - **بلا مراجع مطلوب**، كي تعمل الدورات المجدولة والآلية بلا موافقة يدوية.
- **الـjobs الثلاثة** تعلن `environment: supabase-ops` وشرط `github.ref == 'refs/heads/main'` (تشغيل من فرع آخر يُتخطّى بدل أن يفشل فيطلق تنبيه فشل الأتمتة).
- **التشغيل من غير main** (workflow_dispatch من فرع آخر، أو كود فرع) يُرفض من GitHub قبل بدء الـjob، فلا يصل إلى سرّ البيئة.
- **لا كود PR يصل إلى السرّ:** الثلاثة لا تُطلق بـpull_request ولا pull_request_target ولا push، و`workflow_run` وschedule يشغّلان نسخة main.
- **الحارس:** `scripts/check-supabase-ops-environment.mjs` ضمن `npm run check`.
- ملاحظة: كل تشغيل لـjob يعلن بيئة يُنشئ سجل Deployment في `supabase-ops`، أي ضجيج إداري فقط. بوابة Windows تفلتر على `windows-production`.

## الترتيب الآمن للانتقال (بلا فجوة تشغيلية)

قاعدة GitHub: **سرّ البيئة يتقدّم على سرّ المستودع بنفس الاسم، وسرّ المستودع يبقى متاحاً لـjob البيئة إن
لم يوجد في البيئة.**

1. **دمج الـPR أولاً.** الـjobs تعمل من main داخل البيئة، وتستعمل سرّ المستودع الحالي. لا تغيير في السلوك.
2. **مراقبة دورة أو دورتين** لـ`health-check` (مجدول)، والتأكد من نجاحها داخل البيئة.
3. **وضع المفتاح في البيئة** (`gh secret set SUPABASE_SERVICE_ROLE_KEY --env supabase-ops`)، يُفضَّل بمفتاح `sb_secret_` جديد مخصّص (أدناه).
   القيمة الحالية لا تُقرأ من GitHub، فيلزم إدخال قيمة يملكها المالك.
4. **دورة ناجحة بسرّ البيئة.**
5. **حذف سرّ المستودع** `SUPABASE_SERVICE_ROLE_KEY`. بعدها لا يقرؤه أي فرع. ثم `GENERATE_TOKEN` بعد التأكد أنه غير مستعمل.

**التراجع:**
- في الخطوتين 1 و2: revert للـPR.
- في الخطوتين 3 و4: حذف سرّ البيئة، فيعود الـjob لسرّ المستودع.
- بعد الخطوة 5: إعادة سرّ المستودع، بقيمة يملكها المالك.

## مفتاح Supabase مستقل لـGitHub Actions (خطة، لم يُنفَّذ)

### التوافق
- مفاتيح `sb_secret_…` الجديدة تعطي صلاحية service role نفسها، أي تتجاوز RLS.
- **لا تُقيَّد بجداول أو دوال**، ففائدتها **الاستقلال**: إبطال هذا المفتاح وحده دون مسّ OZK2026 أو Edge Functions. لا تقلّل الصلاحية.
- **مؤكَّد من توثيق Supabase:** المفتاح الجديد ليس JWT، فيُرفض في `Authorization: Bearer` بـ«Invalid JWT».
  - لذلك تبني `scripts/supabase-service-headers.mjs` الترويسات: JWT القديم في `apikey` و`Authorization` كما كان،
    و`sb_…` في `apikey` وحدها. يستعملها health-check (notify_telegram وhealth_lifecycle) وstock-priority-alerts،
    وalert-on-automation-failure يطبّق القاعدة نفسها في bash.
  - التحويل لا يحتاج أي تعديل كود؛ الحارس يثبت السلوكين بلا شبكة.

### مَن يعتمد على المفتاح القديم (legacy service_role JWT)
- Edge Functions (يُحقن تلقائياً).
- pg_cron/الدوال التي تستدعي الـfunctions.
- أي سكربت على OZK2026 يستعمل service key في `tools/.env`.
- GitHub Actions اليوم.

**لا يُدوَّر الـJWT القديم:** تدويره يعني تدوير JWT secret للمشروع كله، فيتعطّل كل ما سبق.

### الخطوات (كل خطوة بموافقة منفصلة)
1. **إنشاء المفتاح (المالك):** من Supabase Dashboard ← API Keys، مفتاح `sb_secret_` باسم `github-actions`. لا يمسّ أي مفتاح آخر.
2. **اختبار آمن بقراءة فقط،** من جهاز المالك أو workflow يدوي على main بلا إرسال:
   - `GET /rest/v1/bot_config?select=key&limit=1` بـ`apikey` وحدها (لا `Authorization`).
3. **تعديل الترويسة:** منجز في هذا الـPR (`supabase-service-headers.mjs`).
4. **وضعه سرّ بيئة** في `supabase-ops`، وهو الخطوة 3 في الترتيب أعلاه، ثم مراقبة دورة كاملة.
5. **حذف سرّ المستودع القديم.** الـJWT القديم يبقى صالحاً للـEdge Functions وOZK2026، فلا تعطّل.
6. **التراجع:** حذف سرّ البيئة (فيعود سرّ المستودع إن كان باقياً)، أو إبطال المفتاح الجديد وحده من Dashboard.
7. **لاحقاً (مسار مستقل):** نقل OZK2026 وEdge Functions إلى مفاتيح جديدة مستقلة، ثم تعطيل legacy keys بعد التحقق الكامل.
