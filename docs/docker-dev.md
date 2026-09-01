# بيئة تطوير Docker — Mac وWindows

overlay تطوير فوق `docker-compose.yml` الأساسي (الإنتاجي/الموافق عليه في PR #164،
غير مُعدَّل هنا). لا يعمل تلقائياً — يجب تمريره صراحةً في كل أمر.

## التشغيل

نفس الأمر حرفياً على Mac (Terminal) وWindows (PowerShell أو Git Bash)، من جذر
المستودع:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

الموقع يفتح على `http://localhost:5173`.

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

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
```

الأول يجب أن يعيد `200`، والثاني يجب أن يُظهر الحالة `healthy`.
