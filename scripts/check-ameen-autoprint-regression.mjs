// ============================================================================
// يُشغّل مجموعة اختبارات الانحدار الخاصة بمراقب طباعة الجملة (ameen-autoprint)
// ضمن بوابة `npm run check` — بدلاً من بقائها معزولة تُشغَّل يدوياً فقط.
//
// السبب: ملف الاختبار tools/ameen-autoprint/__tests__/wholesale-regression.test.mjs
// ليس check-*.mjs داخل scripts/، فلا يمكن إدراج مساره مباشرة في CHECKS —
// run-checks.mjs يحلّ كل اسم بـ path.join(scriptsDir, name)، وcheck-checks-
// manifest.mjs يفرض أن يكون كل عنصر ملف check.mjs/check-*.mjs فعلياً داخل
// scripts/. هذا الملف غلاف رقيق يُشغّل الاختبار الحقيقي عبر spawnSync وينقل
// كود خروجه كما هو — بلا تكرار منطق، وبلا تعديل على ملف الاختبار نفسه.
// ============================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.join(
  scriptsDir, "..", "tools", "ameen-autoprint", "__tests__", "wholesale-regression.test.mjs"
);

const result = spawnSync(process.execPath, [testFile], { stdio: "inherit" });

if (result.error) {
  console.error(`check-ameen-autoprint-regression: تعذّر التشغيل — ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`check-ameen-autoprint-regression: أُنهي بالإشارة ${result.signal}`);
  process.exit(1);
}
process.exit(result.status);
