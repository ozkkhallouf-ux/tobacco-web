# أداء CI على GitHub Actions

## الحالة الحالية

- **المرحلتان 0 و1 (فرع `claude/ci-perf`، 2026-10-26):** قياس زمن كل فحص داخل `npm run check`، ودعم `--shard k/n` بتقسيم حتمي (غير مستعمل في CI بعد)، وكاش موثوق لتثبيت Playwright، وتشغيل PostgreSQL المثبّت مسبقاً على العدّاء بلا `apt-get`.
- **المراحل 2–4 لم تبدأ** وتحتاج موافقة عمر الصريحة: تقسيم `check`/`validate` إلى shards مع وظائف تجميع بالأسماء نفسها، تقسيم وظيفة Windows، وconcurrency (بتدقيق مستقل لتفاعلها مع suite الـGate).
- **قياس ما قبل التعديل (20 تشغيلاً، 2026-10-25/26):** `check` وسيط 12.1m / p90 20.7m، `validate` 12.4m / 21.6m، `critical-journeys` 5.0m / 15.4m، Windows 7.5m / 8.2m. سبب p90: `playwright install --with-deps` استغرق 7.5–12 دقيقة في 15 من 60 وظيفة، كله في جلب خطوط apt من مرآة azure بسرعة ~38 kB/s؛ المتصفح نفسه ~5 ثوانٍ.

## المصدر الموثوق

- `scripts/run-checks.mjs` (المنسِّق) و`scripts/run-checks-shard.mjs` (منطق الوسائط والتقسيم، دوال نقية).
- `.github/actions/install-playwright-chromium/action.yml` — التثبيت المخزَّن مؤقتاً.
- الفحوص الإلزامية الخمسة في ruleset ‏`21808376`: `Codex Review Gate`، `check`، `validate`، `critical-journeys`، `توافق Windows PowerShell 5.1`. أسماؤها لا تتغيّر.

## نطاق الملفات

`scripts/run-checks.mjs`، `scripts/run-checks-shard.mjs`، `scripts/check-run-checks-shard.mjs`، `scripts/checks.manifest.mjs`، `.github/workflows/check.yml`، `.github/workflows/decision-engine-check.yml`، `.github/actions/install-playwright-chromium/`.

## القيود الثابتة

- بلا وسائط يبقى `npm run check` كما كان حرفياً: كل `CHECKS` بالترتيب، تسلسلي، fail-fast، رمز خروج الفحص الفاشل. الإضافة الوحيدة سطر زمن بعد كل فحص وجدول الأبطأ في النهاية.
- أي وسيط غير معروف يُرفض برمز 2 قبل تشغيل أي فحص؛ ولا shard فارغ (عدد الـshards ≤ عدد الفحوص).
- التقسيم round-robin بالموضع في البيان: متفرق، واتحاده = `CHECKS`، ويحفظ الترتيب.
- الكاش يحمل متصفح Playwright العام وحزم `.deb` العامة فقط. الأمر المنفَّذ هو نفسه `npx playwright install --with-deps chromium`؛ apt لا يستعمل `.deb` من الكاش إلا إن طابقت بصمتها فهرس Packages الموقَّع. كاش PR معزول في نطاقه ولا يكتب في نطاق main.
- لا يُستعمل الكاش في أي workflow بـ`pull_request_target`، ولا تُلمس ملفات Codex Review Gate ولا `pages.yml` في هذه المراحل.
- PostgreSQL: `postgresql-16` مثبّت مسبقاً في `ubuntu-24.04`؛ `apt-get install` كان يضيف ثلاث حزم وصفية فقط (`16+257build1.1`). الخطوة تتحقق من الإصدار 16 وتوفّر `pgcrypto` و`dblink`، والتثبيت من apt يبقى احتياطاً إن غاب.

## الفحوص الإلزامية

- `node scripts/check-run-checks-shard.mjs` (يدخل `npm run check`) — عدم التكرار وعدم السقوط والسلوك الافتراضي، عبر المنطق وعبر المنسِّق الفعلي بـ`--list`.
- `node scripts/check-checks-manifest.mjs` — دلالة المنسِّق (تسلسلي، inherit، بلا env).
- التحقق النهائي على GitHub Actions الفعلي لا محلياً.

## الخطوة التالية

- أوزان الفحوص من سطور `run-checks: ⏱` في سجلات CI لموازنة الـshards في المرحلة 2.
- بعد الدمج: كاش main لا يُكتب إلا من تشغيل على main؛ أول تشغيل لكل PR جديد يبقى Miss حتى يُضاف workflow تسخين على main (مقترح منفصل).
