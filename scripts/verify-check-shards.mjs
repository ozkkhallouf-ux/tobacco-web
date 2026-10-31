// ============================================================================
// تحقق وظيفة التجميع في CI من تقارير shards بوابة `npm run check`.
//
//   node scripts/verify-check-shards.mjs --dir <مجلد التقارير> --total <n> [--weights <ملف>]
//
// يقرأ كل *.json في المجلد (تقرير لكل shard ناجح، يكتبه run-checks.mjs --report)،
// ويعيد حساب التقسيم المتوقع من checks.manifest.mjs في هذا الـcommit، ثم يرفض
// إن نقص تقرير، أو تكرر shard، أو سقط فحص، أو نُفِّذ فحص مرتين، أو اختلف المنفَّذ
// عن المتوقع. رمز الخروج 1 عند أي انحراف — فلا تمرّ الوظيفة الإلزامية على تغطية
// ناقصة حتى لو أبلغت كل الوظائف «نجاحاً».
//
// الاسم لا يبدأ بـcheck- عمداً: ليس فحصاً في البوابة بل أداة CI؛ منطقه في
// run-checks-shard.mjs ومختبَر في check-run-checks-shard.mjs.
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CHECKS } from './checks.manifest.mjs';
import { parseWeights, verifyShardReports } from './run-checks-shard.mjs';

function parseArgs(argv) {
  const out = { dir: null, total: null, weights: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--dir', '--total', '--weights'].includes(flag) || value === undefined) {
      throw new Error(`وسيط غير معروف أو بلا قيمة: "${flag}" — المسموح: --dir و--total و--weights`);
    }
    out[flag.slice(2)] = value;
    i += 1;
  }
  if (!out.dir || !out.total) throw new Error('--dir و--total إلزاميان');
  if (!/^[1-9]\d*$/.test(out.total)) throw new Error(`--total عدد صحيح موجب — وجدت "${out.total}"`);
  return { ...out, total: Number(out.total) };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const weights = args.weights ? parseWeights(readFileSync(args.weights, 'utf8')) : null;
  const files = readdirSync(args.dir).filter((f) => f.endsWith('.json')).sort();
  const reports = files.map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(args.dir, f), 'utf8'));
    } catch (error) {
      throw new Error(`${f}: JSON غير صالح — ${error.message}`);
    }
  });
  const summary = verifyShardReports({ reports, checks: CHECKS, total: args.total, weights });
  console.log(`verify-check-shards: ${summary.executed} من ${CHECKS.length} فحصاً نُفِّذت ونجحت مرة واحدة بالضبط `
    + `عبر ${args.total} shards (${summary.perShard.join(' + ')}).`);
} catch (error) {
  console.error(`verify-check-shards: ✗ ${error.message}`);
  process.exit(1);
}
