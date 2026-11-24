# أداء CI على GitHub Actions

## الحالة الحالية

- **المرحلتان 0 و1 (مدموجتان، #403 → `44dadd6`، 2026-10-31):** قياس زمن كل فحص داخل `npm run check`، ودعم `--shard k/n`، وكاش موثوق لتثبيت Playwright، وتشغيل PostgreSQL المثبّت مسبقاً بلا `apt-get`. أزالت ذيل 7–12 دقيقة في التثبيت، والوسيط بقي ~12 دقيقة.
- **المرحلة 2 (فرع `claude/ci-parallel-sharding`):** `check` و`validate` كلٌّ 4 shards متوازية بتقسيم موزون بأزمنة CI (`scripts/checks.weights.json`، ~171s لكل shard)، ووظيفة تجميع تحمل الاسم الإلزامي نفسه تتحقق من تقارير الـshards (`scripts/verify-check-shards.mjs`).
- **المرحلتان 3 و4 لم تبدأا** وتحتاجان موافقة عمر الصريحة: تقسيم وظيفة Windows (تصير المسار الحرج بعد المرحلة 2)، وconcurrency (بتدقيق مستقل لتفاعلها مع suite الـGate). وworkflow تسخين الكاش على main أيضاً بموافقة.
- **قياس ما قبل التعديل (20 تشغيلاً، 2026-10-25/26):** `check` وسيط 12.1m / p90 20.7m، `validate` 12.4m / 21.6m، `critical-journeys` 5.0m / 15.4m، Windows 7.5m / 8.2m. سبب p90: `playwright install --with-deps` استغرق 7.5–12 دقيقة في 15 من 60 وظيفة، كله في جلب خطوط apt من مرآة azure بسرعة ~38 kB/s؛ المتصفح نفسه ~5 ثوانٍ.

## المصدر الموثوق

- `scripts/run-checks.mjs` (المنسِّق) و`scripts/run-checks-shard.mjs` (منطق الوسائط والتقسيم والتحقق، دوال نقية).
- `scripts/checks.weights.json` — أوزان التقسيم (وسيط أزمنة `run-checks: ⏱` من سجلات CI). تحديثها يحسّن التوازن فقط.
- `scripts/verify-check-shards.mjs` — تحقق وظيفة التجميع من التقارير.
- `.github/actions/install-playwright-chromium/action.yml` — التثبيت المخزَّن مؤقتاً.
- الفحوص الإلزامية الخمسة في ruleset ‏`21808376`: `Codex Review Gate`، `check`، `validate`، `critical-journeys`، `توافق Windows PowerShell 5.1`. أسماؤها لا تتغيّر.

## نطاق الملفات

`scripts/run-checks.mjs`، `scripts/run-checks-shard.mjs`، `scripts/check-run-checks-shard.mjs`، `scripts/checks.manifest.mjs`، `scripts/checks.weights.json`، `scripts/verify-check-shards.mjs`، `.github/workflows/check.yml`، `.github/workflows/decision-engine-check.yml`، `.github/actions/install-playwright-chromium/`.

## القيود الثابتة

- بلا وسائط يبقى `npm run check` كما كان حرفياً: كل `CHECKS` بالترتيب، تسلسلي، fail-fast، رمز خروج الفحص الفاشل. الإضافة الوحيدة سطر زمن بعد كل فحص وجدول الأبطأ في النهاية.
- أي وسيط غير معروف يُرفض برمز 2 قبل تشغيل أي فحص؛ ولا shard فارغ (عدد الـshards ≤ عدد الفحوص).
- التقسيم round-robin بالموضع (بلا `--weights`) أو LPT موزون (مع `--weights`): كلاهما حتمي، متفرق، اتحاده = `CHECKS`، ويحفظ الترتيب داخل كل shard. فحص غائب عن ملف الأوزان يأخذ `defaultSeconds` ويبقى مغطّى.
- **الفحصان الإلزاميان `check` و`validate` وظيفتا تجميع**، معرّفهما بلا `name:` (السياق لم يتغيّر). كلٌّ منهما `if: always()` — وظيفة متخطّاة تُحسب ناجحة في الفحوص الإلزامية — ويفشل ما لم تكن `needs.<shard>.result == success`، ثم يعيد حساب التقسيم المتوقع من البيان ويطابق تقارير الـshards معه: كل فحص نُفِّذ ونجح مرة واحدة بالضبط. التقرير يُكتب فقط إن نجحت كل فحوص الـshard، ورفعه `if-no-files-found: error`.
- عدد الـshards مكتوب في ثلاثة مواضع لكل workflow (matrix، `--shard k/N`، `--total N`)؛ `check-run-checks-shard.mjs` يشترط تطابقها، ويمنع `continue-on-error`، ويشترط `fail-fast: false`.
- كل shard على عدّاء مستقل: لا Postgres ولا منافذ ولا ملفات مؤقتة مشتركة بين الـshards، وداخل الـshard التنفيذ تسلسلي كما كان. `pages.yml` يبقى يشغّل البوابة كاملة بلا تقسيم.
- الكاش يحمل متصفح Playwright العام وحزم `.deb` العامة فقط. الأمر المنفَّذ هو نفسه `npx playwright install --with-deps chromium`؛ apt لا يستعمل `.deb` من الكاش إلا إن طابقت بصمتها فهرس Packages الموقَّع. كاش PR معزول في نطاقه ولا يكتب في نطاق main.
- لا يُستعمل الكاش في أي workflow بـ`pull_request_target`، ولا تُلمس ملفات Codex Review Gate ولا `pages.yml` في هذه المراحل.
- PostgreSQL: `postgresql-16` مثبّت مسبقاً في `ubuntu-24.04`؛ `apt-get install` كان يضيف ثلاث حزم وصفية فقط (`16+257build1.1`). الخطوة تتحقق من الإصدار 16 وتوفّر `pgcrypto` و`dblink`، والتثبيت من apt يبقى احتياطاً إن غاب.

## الفحوص الإلزامية

- `node scripts/check-run-checks-shard.mjs` (يدخل `npm run check`) — عدم التكرار وعدم السقوط والسلوك الافتراضي، عبر المنطق وعبر المنسِّق الفعلي بـ`--list`.
- `node scripts/check-checks-manifest.mjs` — دلالة المنسِّق (تسلسلي، inherit، بلا env).
- التحقق النهائي على GitHub Actions الفعلي لا محلياً.

## الخطوة التالية

- المرحلة 3 (Windows) بموافقة: تصير المسار الحرج (~6–8 دقائق) بعد المرحلة 2.
- إعادة توليد `checks.weights.json` حين تتغيّر الأزمنة كثيراً (من سطور `run-checks: ⏱` في سجلات الـshards).
- بعد الدمج: كاش main لا يُكتب إلا من تشغيل على main؛ أول تشغيل لكل PR جديد يبقى Miss حتى يُضاف workflow تسخين على main (مقترح منفصل).
