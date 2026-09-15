# تعاون Slack وGitHub والوكلاء

آخر تحديث: 2026-09-15

## الحالة الحالية

Slack مثبت على Mac Mini وهو مركز العمليات والإشعارات. التطبيقات الرسمية مربوطة مسبقاً: GitHub وCursor وCodex وClaude. المستودع لا يحتوي كود Slack ولا webhook ولا سر إشعار؛ الإعداد الخارجي (القنوات والاشتراكات) يُكمَّل لاحقاً ولا يُنفَّذ من هذا التقرير.

GitHub هو مصدر الحقيقة الوحيد للكود والفروع والـPR وفحوص CI والمراجعة وحالة الدمج.

المسار المعتمد:

```
عمر → Slack → Cursor / Codex / Claude → فرع GitHub → PR → CI + اختبارات → Codex Review Gate → إشعار الحالة في Slack → توقف بانتظار موافقة عمر → دمج / نشر
```

فحوص `main` المطلوبة حياً (ruleset `21808376` `main-protection-with-admin-bypass`): `Codex Review Gate`، `check`، `validate`، `critical-journeys`، `توافق Windows PowerShell 5.1`. حل محادثات المراجعة مطلوب. عدد المراجعات البشرية المطلوبة حالياً = 0. حساب Admin يستطيع تجاوز القواعد — **ممنوع استعمال التجاوز**. الدمج في `main` يطلق نشر GitHub Pages عبر `pages.yml`؛ لا دمج ولا نشر بدون أمر صريح من عمر.

تنبيهات فشل الأتمتة تبقى عبر Telegram (`alert-on-automation-failure.yml` → `notify_telegram`). Slack لا يستبدل هذا المسار ولا يُضاف له workflow webhook مخصص.

قفل التنسيق (`AI_ACTIVE_TASK.json` + `tools/ai-work-coordination.ps1`) ما زال الاستثناء التنظيمي الوحيد الذي يُنشر مباشرة على `main`. مالكو القفل: `Claude` و`Codex` و`Human` و`Cursor`. بروتوكول الحجز على `main` لم يتغيّر.

Mac Mini جهاز عميل Slack ومرافق محلية فقط؛ ليس هدف تشغيل جديد للمنتج ولا يوسّع دعم macOS خارج النطاق المبوَّب في `AGENTS.md`.

## المصدر الموثوق

- الكود والـPR وCI وcheck-run `Codex Review Gate` على GitHub.
- قواعد الحماية الحية على GitHub (ليست ملفاً في المستودع).
- هذا التقرير لمسار Slack/الوكلاء؛ `notifications-deployment.md` لـ Web Push وTelegram وPages.
- `AI_WORK_SYNC.md` لقفل المهام بين الوكلاء.

## نطاق الملفات

| الملف | الدور |
|---|---|
| `docs/ai/topics/collaboration-workflow.md` | هذا التقرير |
| `AI_WORK_SYNC.md` | أدوار الوكلاء وSlack وعدم الدمج |
| `AGENTS.md` | تعليمات المراجعة والتنسيق |
| `tools/ai-work-coordination.ps1` | مالكو القفل بما فيهم Cursor |
| `.github/pull_request_template.md` | قائمة سلامة قبل الدمج |

لا يُعدَّل من أجل هذا المسار: `codex-review-gate.yml`، `pages.yml`، تنبيهات Telegram، تكامل الأمين، rulesets، الأسرار.

## قيود ثابتة

- لا دفع مباشر إلى `main` إلا استثناء قفل/تسليم التنسيق القائم.
- لا إضعاف لحماية الفرع ولا استعمال admin bypass ولا دمج آلي ولا نشر آلي من الوكلاء.
- لا تعديل بيانات قاعدة الإنتاج. الأمين الحي للقراءة فقط.
- لا أسرار في Git أو Slack أو قوالب الـPR.
- Cursor ينفّذ على فرع ويفتح PR عند التكليف الصريح؛ لا يدمج ولا ينشر.
- Codex طبقة مراجعة مستقلة عبر البوابة الحالية على HEAD SHA الحي للـPR. `@Codex` في Slack للأسئلة/الرأي الثاني لا للتنفيذ إلا بطلب عمر.
- Claude Code وكيل ثانوي للتشخيص والرأي المستقل؛ جلسة ويب واحدة → PR واحد كحد أقصى؛ لا دمج.
- لا تثبيت Actions أو حزم طرف ثالث لمسار Slack. التكاملات الرسمية فقط.
- لا إنشاء سر `SLACK_WEBHOOK` من المستودع.

## فحوص إلزامية

`npm run check`، `git diff --check`، ومراجعة أن الـPR لا يلمس workflows الحماية أو النشر أو Telegram. الدمج ممنوع حتى يخضر CI وبوابة Codex على **HEAD الحالي** ويوافق عمر صراحة.

## الخطوة التالية

إعداد توجيه Slack (مرحلة B) بعد مراجعة هذا الـPR: إنشاء `#ozk-dev` و`#ozk-alerts` و`#ozk-decisions` إن لم توجدا، ثم `/github subscribe` و`@Cursor settings` للمستودع `ozkkhallouf-ux/tobacco-web`. لا يُنفَّذ ذلك من هذا الفرع.
