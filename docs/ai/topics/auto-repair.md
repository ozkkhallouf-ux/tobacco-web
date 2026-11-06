# OZK Auto-Repair — إصلاح أعطال CI بمسودة PR (معطّل افتراضياً)

## الحالة الحالية
- **المرحلة 0 (2026-11-06):** البنية فقط. `.github/workflows/ozk-autorepair.yml` + الحارس `.github/autorepair/guard.mjs` واختباره.
- **الوضع الفعلي: off.** متغيّر المستودع `OZK_AUTOREPAIR_MODE` غير مُعرَّف ⇒ كل الـjobs تُتخطّى، لا Claude، لا صلاحيات مستعملة، لا كتابة.
- لا سرّ Claude، ولا متغيّر، ولا بيئة `autorepair-propose` على GitHub حتى الآن — كلها قرارات منفصلة للمالك.
- مُختبَر محلياً قبل الإضافة: Claude Code 2.1.319 أصلح خطأً اصطناعياً (≈$0.03–0.05/تشغيل)، ورفض حقن تعليمات من السجل؛ الحارس صدّ 24/24 محاولة تجاوز؛ فشل المصادقة/الميزانية/CI يتوقف بلا patch ولا PR.

## المصدر الموثوق
- GitHub نفسه: الحدث `workflow_run` على «فحص المشروع» (لا يعتمد على الماك أو n8n).
- سجل CI والـpatch **غير موثوقين**؛ الحارس يُحمَّل من الفرع الافتراضي لا من الشجرة المعدّلة.

## نطاق الملفات
| الملف | الدور |
|---|---|
| `.github/workflows/ozk-autorepair.yml` | gate (actions:read) → analyze (contents/actions:read، Claude بلا shell) → propose (خلف بيئة بموافقة يدوية) |
| `.github/autorepair/guard.mjs` | حارس allowlist: تعديل ملفات قائمة في `src/**/*.js|css` فقط، عدا `config.js` و`supabase-client.js` و`ameen-live-client.js` و`error-monitoring.js` |
| `.github/autorepair/test-guard.mjs` | 24 محاولة تجاوز — يدوي: `node .github/autorepair/test-guard.mjs` (غير مربوط بـCI عمداً) |

## القيود الثابتة
- لا دمج ولا auto-merge ولا نشر ولا migration من هذا المسار أبداً؛ أقصى ناتج **Draft PR** بعد موافقة المالك.
- ممنوع على الـpatch: `supabase/**`, `.github/**`, `tools/**` (ومنها `*.ps1`), `scripts/**`, الاختبارات، `package*.json`, `index.html`, `service-worker.js`، وأي إضافة/حذف/نقل/symlink/تنفيذ/ثنائي.
- الحارس قبل الاختبارات دائماً، وأي استثناء فيه = رفض.
- لا تحليل لتشغيلات forks، ولا لفروع `autorepair/*` أو `windows-production`، ولا لإعادات التشغيل أو تشغيلات البوت.
- السقوف: 3 تشغيلات/يوم، محاولتان لكل commit، `--max-turns 15`، `--max-budget-usd 1` (يُفحص بعد الدور فقد يتجاوزه بدور واحد).

## الفحوص الإلزامية
- `node .github/autorepair/test-guard.mjs` ⇒ 24/24 عند تعديل الحارس.
- `npm run check` (لا يتأثر بهذه الملفات).
- قبل أي تفعيل: مراجعة الصلاحيات في الـworkflow، وأن الـactions مثبّتة بـSHA.

## الخطوة التالية
بموافقة منفصلة لكل خطوة: (1) اختيار الفوترة وإضافة سرّ واحد (`CLAUDE_CODE_OAUTH_TOKEN` اشتراك، أو `ANTHROPIC_API_KEY` API)، (2) `OZK_AUTOREPAIR_MODE=shadow` لأسبوعين، (3) بيئة `autorepair-propose` بمراجع إلزامي، (4) مراجعة قواعد الحماية، (5) `propose`.
عائق معروف لـpropose: الـPR الذي يدفعه `GITHUB_TOKEN` لا يشغّل CI (سلوك GitHub) — يلزم GitHub App token.
**التراجع:** حذف المتغيّر (⇒ off) أو Disable workflow؛ أو revert لهذا الـPR (لا يمس أي ملف آخر).
