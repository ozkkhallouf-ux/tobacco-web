// ============================================================================
// ترميز سكربتات Windows PowerShell 5.1 — عطل التقطه CI فعلاً (2026-09-14).
//
// Windows PowerShell 5.1 لا يفترض UTF-8. حين يقرأ ملف .ps1 بلا علامة ترتيب
// بايتات (BOM) يفسّره بترميز صفحة النظام (ANSI/Windows-1252)، فتتحوّل الحروف
// العربية إلى تسلسلات مثل `Ù^A`. وتلك التسلسلات تحمل محارف يقرأها المحلّل
// اقتباساً أو قوساً، فينكسر التحليل بأخطاء لا علاقة لظاهرها بالسبب:
//   Missing closing ')' in expression.
//
// وقع ذلك حرفياً على tools/tests/Test-SupplierObligationsReplacement.ps1 في
// وظيفة ps51-compat: الملف صحيح تماماً، وسقط لأنه بلا BOM وحده. والخطر أكبر
// على المنتجات المجدولة: powershell.exe يشغّلها على جهاز LOQ بنفس المنطق.
//
// PowerShell 7 يفترض UTF-8 افتراضياً، فالعطل لا يظهر محلياً على macOS/pwsh
// إطلاقاً — ولا يلتقطه أي عدّاء ubuntu. لذلك القائمة صريحة هنا.
//
// المدى مقصود ومحدود: هذه القائمة تضم السكربتات التي تُنفَّذ فعلاً تحت
// PowerShell 5.1 — اختبارات وظيفة ps51-compat، والمنتجات وسكربتات التسجيل التي
// تشغّلها مهام Windows المجدولة. المستودع يحوي عشرات ملفات .ps1 الأخرى بعربية
// وبلا BOM (أدوات discover-* الاستكشافية مثلاً)؛ إصلاحها الشامل قرار منفصل، ولا
// يُدَّعى هنا أنه تمّ.
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";

// كل مسار هنا يُنفَّذ تحت Windows PowerShell 5.1: إما عبر وظيفة ps51-compat في
// .github/workflows/check.yml، أو عبر powershell.exe من Task Scheduler.
const EXECUTED_UNDER_PS51 = [
  // اختبارات وظيفة ps51-compat
  "tools/tests/Test-KhalilAuditPs51Compat.ps1",
  "tools/tests/Test-DailyGitPullStaleLock.ps1",
  "tools/tests/Test-AutoSyncGitPushFailure.ps1",
  "tools/tests/Test-RegisterTaskStartAtCaseCollision.ps1",
  "tools/tests/Test-SupplierObligationsReplacement.ps1",
  "tools/tests/Test-SnapshotProducerNativeStderr.ps1",
  // منتجات وسكربتات تسجيل تشغّلها مهام Windows المجدولة
  "tools/push-supplier-obligations.ps1",
  "tools/push-purchase-item-snapshot.ps1",
  "tools/register-supplier-obligations-task.ps1",
  "tools/register-purchase-item-snapshot-task.ps1",
  "tools/auto-sync-price-lists.ps1",
  "tools/ameen-sync-agent.ps1",
];

const ARABIC = /[؀-ۿ]/;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let passed = 0;
let checkedWithArabic = 0;

for (const relative of EXECUTED_UNDER_PS51) {
  const url = new URL(`../${relative}`, import.meta.url);
  assert.ok(fs.existsSync(url),
    `${relative} مُدرج كمنفَّذ تحت 5.1 لكنه غير موجود — حدّث القائمة أو أعد الملف`);

  const bytes = fs.readFileSync(url);
  const text = bytes.toString("utf8");
  if (!ARABIC.test(text)) {
    // بلا عربية لا يضرّ غياب BOM: ASCII يُقرأ نفسه في كل ترميز.
    passed += 1;
    continue;
  }
  checkedWithArabic += 1;
  assert.ok(bytes.subarray(0, 3).equals(BOM),
    `${relative} يحوي عربية بلا BOM — سيقرأه PowerShell 5.1 بترميز ANSI ` +
    `فتتشوّه الحروف وقد ينكسر التحليل. أضف BOM بترميز UTF-8.`);
  passed += 1;
}

// شاهد سالب: لو لم يكن أي ملف في القائمة يحوي عربية لكان الفحص يمرّ بلا أن
// يفحص شيئاً، فيصبح خضاره بلا معنى.
assert.ok(checkedWithArabic >= 6,
  `الفحص لم يجد إلا ${checkedWithArabic} ملفاً بعربية — القائمة على الأرجح انحرفت عن الواقع`);

console.log(`  ✓ ${checkedWithArabic} سكربت 5.1 بعربية تحمل BOM (من ${passed} مفحوصاً)`);
console.log("check-powershell-51-encoding: اجتاز الفحص.");
