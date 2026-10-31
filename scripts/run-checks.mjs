// ============================================================================
// منسِّق بوابة `npm run check`.
//
// يحلّ محلّ سلسلة «&&» التي كانت سطراً واحداً بطول 1736 حرفاً في package.json.
// دلالته مطابقة للسلسلة القديمة حرفاً بحرف:
//   • تسلسلي بحتاً — لا تنفيذ متوازٍ.
//   • fail-fast: يتوقف عند أول رمز خروج ≠ 0 ولا يشغّل ما بعده.
//   • رمز الخروج = رمز الفحص الفاشل نفسه (كما تفعل && في الصدفة).
//   • stdio: 'inherit' — خرج كل فحص يُمرَّر مباشرة إلى الطرفية بلا تخزين ولا
//     إعادة تنسيق: بثّ حيّ لا يتأخر حتى نهاية الفحص، ووراثة كاملة لسلوك
//     stdout/stderr لكل فحص مهما تغيّر مستقبلاً. أي التقاط (stdio:'pipe')
//     كان سيُدخل تخزيناً ويجعل المنسِّق مسؤولاً عن إعادة الإخراج.
//
//   ملاحظة صدق: المخرجات الكلية ليست مطابقة حرفياً للسلسلة القديمة — خرج كل
//   فحص يمرّ دون تغيير، لكن المنسِّق يضيف سطر زمن بعد كل فحص، وجدول الأبطأ
//   وسطر خلاصة في النهاية (عند الفشل على stderr مع اسم الفحص ورمز خروجه).
//   • لا تمرير argv ولا تعديل env — الفحوص تُستدعى كما كانت: node <file>.
//
// الوسائط (للمنسِّق نفسه، لا تُمرَّر لأي فحص):
//   بلا وسائط       → كل CHECKS بترتيب البيان (السلوك الافتراضي، لم يتغيّر).
//   --shard k/n     → الجزء k من n بتقسيم حتمي (scripts/run-checks-shard.mjs).
//   --list          → يطبع أسماء الفحوص المختارة سطراً سطراً ولا يشغّل شيئاً.
//   أي وسيط آخر يُرفض برمز خروج 2 قبل تشغيل أي فحص.
//
// قائمة الفحوص وترتيبها في scripts/checks.manifest.mjs، وهو مصدر الحقيقة.
// ============================================================================
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHECKS } from './checks.manifest.mjs';
import { formatSeconds, parseRunChecksArgs, selectShard } from './run-checks-shard.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

let options;
let selected;
try {
  options = parseRunChecksArgs(process.argv.slice(2));
  selected = selectShard(CHECKS, options.shard);
} catch (error) {
  console.error(`run-checks: ${error.message}`);
  process.exit(2);
}

if (options.list) {
  for (const name of selected) console.log(name);
  process.exit(0);
}

const scope = options.shard
  ? ` (shard ${options.shard.index}/${options.shard.total}: ${selected.length} من ${CHECKS.length})`
  : '';
const timings = [];
const startedAll = performance.now();

function printTimings() {
  const total = performance.now() - startedAll;
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 15);
  console.log(`run-checks: الأزمنة — المجموع ${formatSeconds(total)} لـ${timings.length} فحصاً${scope}. الأبطأ:`);
  for (const { name, ms } of slowest) console.log(`run-checks:   ${formatSeconds(ms).padStart(7)}  ${name}`);
}

for (const name of selected) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [path.join(scriptsDir, name)], {
    stdio: 'inherit',
  });
  const ms = performance.now() - started;
  timings.push({ name, ms });
  console.log(`run-checks: ⏱ ${formatSeconds(ms)} ${name}`);

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
    printTimings();
    console.error(`run-checks: فشل ${name} (رمز الخروج ${result.status})`);
    process.exit(result.status);
  }
}

printTimings();
console.log(`run-checks: اجتاز ${selected.length} فحصاً${scope}.`);
