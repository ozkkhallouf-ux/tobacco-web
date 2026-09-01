# بيئة تطوير Docker — Mac وWindows

overlay تطوير فوق `docker-compose.yml` الأساسي (الملف المحلي الموافق عليه في
PR #164، غير مُعدَّل هنا). لا يعمل تلقائياً — يجب تمريره صراحةً في كل أمر.

بيئة تطوير Docker هذه مدعومة **رسمياً** على macOS وWindows معاً بقرار صريح من المالك
(2026-09-01) — الثالث من ثلاثة مرافق macOS المُبوَّبة المسموحة حصراً في `AGENTS.md`، إلى
جانب `com.ozk.local-site` وجسر أرشفة iCloud. الشرط الثابت لهذا الدعم: تبقى loopback-only
افتراضياً على النظامين، وأي فتح على LAN يمر حصراً عبر opt-in صريح منفصل (راجع القسم
أدناه) — لا استثناء لهذا الشرط بلا موافقة إضافية من المالك.

## التشغيل

نفس الأمر حرفياً على Mac (Terminal) وWindows (PowerShell أو Git Bash)، من جذر
المستودع:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

الموقع يفتح على `http://localhost:5173` — **على الاسترجاع (loopback) فقط
افتراضياً**، على Mac وWindows معاً؛ راجع قسم «الوصول من الشبكة (LAN)» أدناه.

الإيقاف:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

## التعديل الحي (بلا rebuild)

الموقع بلا bundler أصلاً — `serve.mjs` يقرأ كل ملف من القرص عند كل طلب. الـoverlay
يربط (`bind mount`) `src/`، `public/`، وملفات الجذر العامة من جهازك إلى داخل
الحاوية للقراءة فقط. عدّل أي ملف في `src/` أو `public/` على جهازك ثم حدّث
المتصفح — لا حاجة لإعادة بناء الصورة ولا لإعادة تشغيل الحاوية.

تعديل `scripts/serve.mjs` نفسه استثناء: يحتاج إعادة تشغيل الحاوية (لا rebuild)
كي يُحمَّل المنطق الجديد:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml restart
```

## تغيير المنفذ

منفذ المضيف المنشور فقط قابل للتغيير، عبر متغير بيئة `PORT` — نفس الاسم على
النظامين:

```bash
# Mac / Linux / Git Bash
PORT=5174 docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

```powershell
# Windows PowerShell
$env:PORT=5174
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

منفذ الحاوية الداخلي يبقى 5173 ثابتاً عمداً: HEALTHCHECK في الـDockerfile
مبني عليه تحديداً، وتغييره داخلياً خارج نطاق هذه المرحلة.

`docker-compose.dev.yml` يستبدل قائمة `ports` بالكامل (وسم `!override`) بدل
دمجها مع `docker-compose.yml` الأساسي — فتغيير `PORT` يستبدل المنفذ المنشور
فعلياً ولا يُبقي 5173 منشوراً بجانبه. بدون `!override`، قواعد دمج Compose
تعامل كل قيمة `published` مختلفة كإدخال إضافي منفصل (فريد بـ
`{ip, target, published, protocol}`)، فينتج منفذان معاً بالخطأ:
https://docs.docker.com/reference/compose-file/merge/#unique-resources

## الوصول من الشبكة (LAN) — اختياري وواعٍ فقط

المنفذ مربوط افتراضياً بـ `127.0.0.1` فقط — غير قابل للوصول من أي جهاز آخر
على نفس الشبكة (لا من iPhone عبر Wi-Fi ولا من أي جهاز آخر)، على Mac وWindows
معاً. هذا يحقق سياسة نطاق macOS في `AGENTS.md`: أي مسار شبكي جديد على macOS
يبقى loopback-only افتراضياً.

من يحتاج فعلاً فتح المنفذ على LAN (مثلاً اختبار الموقع من iPhone حقيقي عبر
Wi-Fi أثناء التطوير على **Windows**) يضيف overlay ثالثاً صراحةً:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  -f docker-compose.dev.lan.yml up -d --build
```

لا تُستخدم `docker-compose.dev.lan.yml` على Mac — تبقى مقتصرة على Windows عند
الحاجة الفعلية، اتساقاً مع أن أي توسّع شبكي لمرافق macOS يحتاج موافقة صريحة
إضافية تتجاوز حتى هذا الـopt-in (راجع `AGENTS.md`).

## ما الذي يبقى خارج الحاوية عمداً

- **الأسرار ومفاتيح Supabase الخاصة، `tools/.env`, Ameen SQL** — لا شيء منها
  يدخل الصورة أو الـoverlay. الواجهة تستعمل فقط مفتاح Supabase العام
  (`anon`/`publishableKey`) المكتوب أصلاً في `src/config.js`، ولا تحتاج أي
  env سرّي وقت التشغيل.
- **`tools/`** — سكربتات Windows/Ameen SQL، مستبعدة أصلاً في `.dockerignore`
  ولم تُمسّ هنا.
- **الاختبارات (`npm run check`)** — تعتمد Playwright + Chromium، وتبقى على
  المضيف كما كانت؛ لم تُضَف إلى أي صورة أو خدمة Docker في هذه المرحلة.

## التحقق السريع أن كل شيء سليم

استبدل `5173` بقيمة `PORT` إن غيّرتها. على Mac/Linux/Git Bash:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
```

على Windows PowerShell، `curl` غالباً alias لـ`Invoke-WebRequest` ولا يقبل
نفس الأعلام — استخدم بدلاً منه:

```powershell
(Invoke-WebRequest http://localhost:5173/ -UseBasicParsing).StatusCode
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
```

الأول يجب أن يعيد `200`، والثاني يجب أن يُظهر الحالة `healthy`.

للتأكد أن المنفذ غير مكشوف على LAN افتراضياً (استبدل بعنوان IP جهازك الفعلي
على الشبكة، من جهاز آخر على نفس الشبكة أو عبر `curl http://<LAN-IP>:5173/`
من نفس الجهاز):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml config
# يجب أن يظهر host_ip: 127.0.0.1 مع منفذ منشور واحد فقط
```
