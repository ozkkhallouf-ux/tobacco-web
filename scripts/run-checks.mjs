// ============================================================================
// منسِّق بوابة `npm run check`.
//
// يحلّ محلّ سلسلة «&&» التي كانت سطراً واحداً بطول 1736 حرفاً في package.json.
// دلالته مطابقة للسلسلة القديمة حرفاً بحرف:
//   • تسلسلي بحتاً — لا تنفيذ متوازٍ.
//   • fail-fast: يتوقف عند أول رمز خروج ≠ 0 ولا يشغّل ما بعده.
//   • رمز الخروج = رمز الفحص الفاشل نفسه (كما تفعل && في الصدفة).
//   • stdio: 'inherit' — stdout وstderr يمرّان كما هما بلا تخزين ولا إعادة
//     تنسيق. مهم: بعض الفحوص تكتب على stderr وهي *ناجحة* (رُصد 15 سطراً على
//     stderr في تشغيلة ناجحة كاملة)، فأي التقاط أو إعادة توجيه كان سيغيّر
//     السلوك المرصود.
//   • لا تمرير argv ولا تعديل env — الفحوص تُستدعى كما كانت: node <file>.
//
// قائمة الفحوص وترتيبها في scripts/checks.manifest.mjs، وهو مصدر الحقيقة.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHECKS } from './checks.manifest.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

for (const name of CHECKS) {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, name)], {
    stdio: 'inherit',
  });

  // فشل في إطلاق العملية نفسها (ملف مفقود، صلاحية، …)
  if (result.error) {
    console.error(`run-checks: تعذّر تشغيل ${name} — ${result.error.message}`);
    process.exit(1);
  }
  // أُنهي بإشارة (SIGKILL مثلاً): ليس رمز خروج، لكنه فشل قطعاً.
  if (result.signal) {
    console.error(`run-checks: ${name} أُنهي بالإشارة ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`run-checks: فشل ${name} (رمز الخروج ${result.status})`);
    process.exit(result.status);
  }
}

console.log(`run-checks: اجتاز ${CHECKS.length} فحصاً.`);
