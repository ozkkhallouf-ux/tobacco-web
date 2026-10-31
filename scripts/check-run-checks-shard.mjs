import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHECKS } from './checks.manifest.mjs';
import {
  buildShardReport, parseRunChecksArgs, parseShardSpec, parseWeights, partition, selectShard,
  verifyShardReports, weightOf,
} from './run-checks-shard.mjs';

// حارس تقسيم بوابة `npm run check` إلى shards.
//
// ما يحميه: التقسيم وسيلة لتسريع CI بتوزيع الفحوص على وظائف متوازية، وخطره
// الوحيد الحقيقي صامت — فحص يسقط بين shardين فلا يعمل في أيٍّ منهما، أو يعمل
// مرتين، أو وسيط مكتوب خطأً يُتجاهل فتصير الإشارة خضراء على جزء لا على الكل.
// هنا يُثبت كل ذلك على البيان الحقيقي، ثم عبر المنسِّق الفعلي بـ--list (الذي
// لا يشغّل أي فحص، فلا تكرار ذاتي لهذا الفحص).
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scriptsDir, 'run-checks.mjs');
let assertions = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); assertions += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); assertions += 1; };

// ---------------------------------------------------------------------------
// 1) السلوك الافتراضي لم يتغيّر: بلا وسائط = CHECKS كاملة بترتيبها
// ---------------------------------------------------------------------------
eq(parseRunChecksArgs([]), { shard: null, list: false, weights: null, report: null }, 'بلا وسائط: لا shard ولا list');
eq(selectShard(CHECKS, null), CHECKS, 'بلا shard: كل الفحوص بترتيب البيان');
ok(selectShard(CHECKS, null) !== CHECKS, 'selectShard يعيد نسخة لا مرجع البيان نفسه');

// ---------------------------------------------------------------------------
// 2) الصيغ المقبولة والمرفوضة
// ---------------------------------------------------------------------------
eq(parseRunChecksArgs(['--shard', '2/4']).shard, { index: 2, total: 4 }, '--shard 2/4');
eq(parseRunChecksArgs(['--shard=3/5']).shard, { index: 3, total: 5 }, '--shard=3/5');
eq(parseRunChecksArgs(['--list', '--shard', '1/1']), { shard: { index: 1, total: 1 }, list: true, weights: null, report: null }, '--list مع --shard');
eq(parseRunChecksArgs(['--shard', '2/4', '--weights', 'w.json', '--report=r.json']),
  { shard: { index: 2, total: 4 }, list: false, weights: 'w.json', report: 'r.json' }, '--weights و--report');
for (const bad of ['0/4', '5/4', '1/0', 'a/b', '1.5/2', '2', '/4', '01/4', '1/04', '-1/4', ' 1/4', '1/4 ', '', undefined]) {
  assert.throws(() => parseShardSpec(bad), undefined, `صيغة مرفوضة: "${bad}"`);
  assertions += 1;
}
for (const badArgv of [['--shards', '1/4'], ['--shard'], ['--shard', '1/4', '--shard', '2/4'], ['1/4'], ['--LIST'], ['-s', '1/4'],
  ['--weights', 'w.json'], ['--report', 'r.json'], ['--shard', '1/4', '--weights'], ['--shard', '1/4', '--report', '--list'],
  ['--shard', '1/4', '--weights', 'a', '--weights', 'b'], ['--shard', '1/4', '--report=']]) {
  assert.throws(() => parseRunChecksArgs(badArgv), undefined, `وسائط مرفوضة: ${JSON.stringify(badArgv)}`);
  assertions += 1;
}
assert.throws(() => selectShard(CHECKS, { index: 1, total: CHECKS.length + 1 }), /أكبر من عدد الفحوص/,
  'لا shard فارغ: عدد الـshards لا يتجاوز عدد الفحوص');
assertions += 1;

// ---------------------------------------------------------------------------
// 3) لكل n: متفرقة، اتحادها = CHECKS، ترتيب البيان محفوظ، توازن العدد، حتمية
// ---------------------------------------------------------------------------
for (let total = 1; total <= 16; total += 1) {
  const shards = Array.from({ length: total }, (_, k) => selectShard(CHECKS, { index: k + 1, total }));
  const flat = shards.flat();
  eq(flat.length, CHECKS.length, `n=${total}: لا سقوط ولا تكرار في العدد`);
  eq(new Set(flat).size, CHECKS.length, `n=${total}: لا فحص في shardين`);
  eq([...flat].sort(), [...CHECKS].sort(), `n=${total}: الاتحاد = CHECKS بالضبط`);
  for (const [k, shard] of shards.entries()) {
    const positions = shard.map((name) => CHECKS.indexOf(name));
    eq(positions, [...positions].sort((a, b) => a - b), `n=${total} shard ${k + 1}: ترتيب البيان محفوظ`);
    ok(shard.length > 0, `n=${total} shard ${k + 1}: ليس فارغاً`);
    eq(selectShard(CHECKS, { index: k + 1, total }), shard, `n=${total} shard ${k + 1}: حتمي`);
  }
  const sizes = shards.map((s) => s.length);
  ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${total}: الأحجام متوازنة (${sizes})`);
}
eq(selectShard(CHECKS, { index: 1, total: 1 }), CHECKS, '1/1 = البوابة كاملة');
ok(selectShard(CHECKS, { index: 1, total: 4 })[0] === 'check.mjs', 'check.mjs يبقى أول shard الأول');

// ---------------------------------------------------------------------------
// 4) المنسِّق الفعلي: --list يطابق المنطق، والوسيط الخاطئ يُرفض قبل أي تشغيل
// ---------------------------------------------------------------------------
const list = (...args) => spawnSync(process.execPath, [runner, '--list', ...args], { encoding: 'utf8' });
const lines = (out) => out.split('\n').filter(Boolean);

const all = list();
eq(all.status, 0, `run-checks --list: رمز خروج 0 (${all.stderr})`);
eq(lines(all.stdout), CHECKS, 'run-checks --list = CHECKS بترتيبها (السلوك الافتراضي)');

for (const total of [2, 4, 6]) {
  const union = [];
  for (let index = 1; index <= total; index += 1) {
    const r = list('--shard', `${index}/${total}`);
    eq(r.status, 0, `run-checks --list --shard ${index}/${total}: رمز خروج 0`);
    eq(lines(r.stdout), selectShard(CHECKS, { index, total }), `run-checks --shard ${index}/${total} يطابق selectShard`);
    union.push(...lines(r.stdout));
  }
  eq([...union].sort(), [...CHECKS].sort(), `run-checks n=${total}: اتحاد المخرجات الفعلية = CHECKS`);
}

for (const bad of [['--shards', '1/4'], ['--shard', '5/4'], ['--shard', String(CHECKS.length + 1) + '/' + String(CHECKS.length + 1)]]) {
  const r = list(...bad);
  eq(r.status, 2, `run-checks --list ${bad.join(' ')}: رمز خروج 2`);
  eq(r.stdout, '', `run-checks --list ${bad.join(' ')}: لا يطبع ولا يختار أي فحص`);
}

// ---------------------------------------------------------------------------
// 4ب) التقسيم الموزون (LPT) بالأوزان الفعلية: نفس ضمانات التغطية، وتوازن الزمن
// ---------------------------------------------------------------------------
const weightsPath = path.join(scriptsDir, 'checks.weights.json');
const weights = parseWeights(readFileSync(weightsPath, 'utf8'));
const loadOf = (shard) => shard.reduce((sum, name) => sum + weightOf(weights, name), 0);
const maxWeight = Math.max(...CHECKS.map((n) => weightOf(weights, n)));
const sumWeight = CHECKS.reduce((a, n) => a + weightOf(weights, n), 0);
for (let total = 1; total <= 16; total += 1) {
  const shards = partition(CHECKS, total, weights);
  const flat = shards.flat();
  eq(flat.length, CHECKS.length, `موزون n=${total}: لا سقوط ولا تكرار في العدد`);
  eq(new Set(flat).size, CHECKS.length, `موزون n=${total}: لا فحص في shardين`);
  eq([...flat].sort(), [...CHECKS].sort(), `موزون n=${total}: الاتحاد = CHECKS بالضبط`);
  for (const [k, shard] of shards.entries()) {
    const positions = shard.map((name) => CHECKS.indexOf(name));
    eq(positions, [...positions].sort((a, b) => a - b), `موزون n=${total} shard ${k + 1}: ترتيب البيان محفوظ`);
    ok(shard.length > 0, `موزون n=${total} shard ${k + 1}: ليس فارغاً`);
    eq(selectShard(CHECKS, { index: k + 1, total }, weights), shard, `موزون n=${total} shard ${k + 1}: حتمي`);
  }
  // حدّ LPT: أثقل shard لا يتجاوز المتوسط + أثقل فحص منفرد.
  ok(Math.max(...shards.map(loadOf)) <= sumWeight / total + maxWeight + 1e-9, `موزون n=${total}: ضمن حدّ LPT`);
}
eq(partition(CHECKS, 1, weights)[0], CHECKS, 'موزون 1/1 = البوابة كاملة بترتيبها');
// فحص جديد غائب عن ملف الأوزان يأخذ defaultSeconds ويبقى مغطّى.
const withNew = [...CHECKS, 'check-zz-new-unweighted.mjs'];
eq(partition(withNew, 4, weights).flat().sort(), [...withNew].sort(), 'فحص بلا وزن: مغطّى بالوزن الافتراضي');
eq(weightOf(weights, 'check-zz-new-unweighted.mjs'), weights.defaultSeconds, 'فحص بلا وزن: defaultSeconds');
for (const bad of [{}, { version: 2, defaultSeconds: 1, seconds: {} }, { version: 1, seconds: {} },
  { version: 1, defaultSeconds: -1, seconds: {} }, { version: 1, defaultSeconds: 1, seconds: { a: 'x' } },
  { version: 1, defaultSeconds: 1, seconds: { a: Number.NaN } }, { version: 1, defaultSeconds: 1, seconds: null }]) {
  assert.throws(() => parseWeights(bad), undefined, `ملف أوزان مرفوض: ${JSON.stringify(bad)}`);
  assertions += 1;
}
assert.throws(() => partition(['a.mjs', 'b.mjs'], 2, parseWeights({ version: 1, defaultSeconds: 0, seconds: {} })), /فارغاً/,
  'أوزان صفرية تترك shard فارغاً: مرفوضة');
assertions += 1;

// ---------------------------------------------------------------------------
// 4ج) تحقق التجميع: التقارير الصحيحة تمرّ، وكل انحراف يُرفض
// ---------------------------------------------------------------------------
const TOTAL = 4;
const goodReports = () => partition(CHECKS, TOTAL, weights).map((executed, k) =>
  buildShardReport({ checks: CHECKS, shard: { index: k + 1, total: TOTAL }, weights, executed }));
eq(verifyShardReports({ reports: goodReports(), checks: CHECKS, total: TOTAL, weights }).executed, CHECKS.length,
  'التقارير الأربعة الصحيحة: كل الفحوص مرة واحدة');
const mutate = (fn) => { const r = goodReports(); fn(r); return r; };
const badCases = {
  'shard ناقص (لم يُنفَّذ أو لم يرفع تقريره)': mutate((r) => r.pop()),
  'تقرير زائد': mutate((r) => r.push(r[0])),
  'رقم shard مكرر': mutate((r) => { r[1] = { ...r[1], shard: { index: 1, total: TOTAL } }; }),
  'shard لم ينجح': mutate((r) => { r[2].passed = false; }),
  'عدد shards مختلف': mutate((r) => { r[0].shard.total = 5; }),
  'فحص ساقط من shard': mutate((r) => { r[3].executed.pop(); }),
  'فحص زائد في shard': mutate((r) => { r[3].executed.push(r[0].executed[0]); }),
  'فحص منقول بين shardين': mutate((r) => { r[0].executed.push(r[1].executed.shift()); }),
  'ترتيب مختلف': mutate((r) => { r[1].executed.reverse(); }),
  'استراتيجية مختلفة': mutate((r) => { r[0].strategy = 'round-robin'; }),
  'بيان بحجم مختلف': mutate((r) => { r[0].manifestSize = CHECKS.length - 1; }),
  'إصدار مختلف': mutate((r) => { r[0].version = 99; }),
  'تقرير فارغ': mutate((r) => { r[0] = null; }),
  'executed ليس قائمة': mutate((r) => { r[0].executed = 'all'; }),
};
for (const [label, reports] of Object.entries(badCases)) {
  assert.throws(() => verifyShardReports({ reports, checks: CHECKS, total: TOTAL, weights }), undefined, `التجميع يرفض: ${label}`);
  assertions += 1;
}
assert.throws(() => verifyShardReports({ reports: goodReports(), checks: CHECKS, total: TOTAL, weights: null }), undefined,
  'التجميع يرفض: تقارير موزونة تُتحقَّق بلا أوزان');
assertions += 1;

// ---------------------------------------------------------------------------
// 4د) المنسِّق وأداة التحقق الفعليان: --weights و--report و verify-check-shards
// ---------------------------------------------------------------------------
{
  const union = [];
  for (let index = 1; index <= TOTAL; index += 1) {
    const r = list('--shard', `${index}/${TOTAL}`, '--weights', weightsPath);
    eq(r.status, 0, `run-checks --list --shard ${index}/${TOTAL} --weights: رمز خروج 0 (${r.stderr})`);
    eq(lines(r.stdout), partition(CHECKS, TOTAL, weights)[index - 1], `run-checks موزون ${index}/${TOTAL} يطابق partition`);
    union.push(...lines(r.stdout));
  }
  eq([...union].sort(), [...CHECKS].sort(), 'run-checks موزون: اتحاد المخرجات الفعلية = CHECKS');
  for (const bad of [['--weights', weightsPath], ['--report', 'x.json'], ['--shard', '1/4', '--weights', path.join(scriptsDir, 'no-such-weights.json')]]) {
    const r = list(...bad);
    eq(r.status, 2, `run-checks --list ${bad.join(' ')}: رمز خروج 2`);
    eq(r.stdout, '', `run-checks --list ${bad.join(' ')}: لا يختار أي فحص`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'run-checks-shard-'));
  try {
    // shard يحوي check.mjs وحده (الأول دائماً، ~0.2s): تشغيل حقيقي يكتب تقريراً.
    const reportPath = path.join(tmp, 'single.json');
    const real = spawnSync(process.execPath, [runner, '--shard', `1/${CHECKS.length}`, '--report', reportPath], { encoding: 'utf8' });
    eq(real.status, 0, `تشغيل حقيقي لـshard من فحص واحد: رمز خروج 0 (${real.stderr})`);
    const single = JSON.parse(readFileSync(reportPath, 'utf8'));
    eq(single.executed, ['check.mjs'], 'التقرير الحقيقي يسجّل ما نُفِّذ فعلاً');
    eq([single.passed, single.strategy, single.manifestSize, single.shard], [true, 'round-robin', CHECKS.length, { index: 1, total: CHECKS.length }],
      'التقرير الحقيقي: ناجح، الاستراتيجية، حجم البيان، رقم الـshard');

    const verifier = path.join(scriptsDir, 'verify-check-shards.mjs');
    const verify = (dir, ...extra) => spawnSync(process.execPath, [verifier, '--dir', dir, '--total', String(TOTAL), '--weights', weightsPath, ...extra], { encoding: 'utf8' });
    const writeAll = (dir, reports) => {
      mkdirSync(dir, { recursive: true });
      reports.forEach((r, k) => writeFileSync(path.join(dir, `check-shard-${k + 1}.json`), JSON.stringify(r)));
    };
    writeAll(path.join(tmp, 'good'), goodReports());
    const okRun = verify(path.join(tmp, 'good'));
    eq(okRun.status, 0, `verify-check-shards: التقارير الصحيحة تمرّ (${okRun.stderr})`);
    ok(okRun.stdout.includes(`${CHECKS.length} من ${CHECKS.length}`), 'verify-check-shards يطبع العدد المنفَّذ');
    writeAll(path.join(tmp, 'missing'), goodReports().slice(0, 3));
    eq(verify(path.join(tmp, 'missing')).status, 1, 'verify-check-shards: shard ناقص ⇒ رمز خروج 1');
    writeAll(path.join(tmp, 'dropped'), mutate((r) => { r[2].executed.shift(); }));
    eq(verify(path.join(tmp, 'dropped')).status, 1, 'verify-check-shards: فحص ساقط ⇒ رمز خروج 1');
    writeAll(path.join(tmp, 'garbage'), goodReports());
    writeFileSync(path.join(tmp, 'garbage', 'check-shard-1.json'), '{not json');
    eq(verify(path.join(tmp, 'garbage')).status, 1, 'verify-check-shards: JSON تالف ⇒ رمز خروج 1');
    mkdirSync(path.join(tmp, 'empty'));
    eq(verify(path.join(tmp, 'empty')).status, 1, 'verify-check-shards: لا تقارير ⇒ رمز خروج 1');
    eq(verify(path.join(tmp, 'good'), '--bogus', 'x').status, 1, 'verify-check-shards: وسيط غير معروف ⇒ رمز خروج 1');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5) المنسِّق يحلّل الوسائط ويختار قبل الحلقة، ويقيس كل فحص
// ---------------------------------------------------------------------------
const code = (await readFile(runner, 'utf8')).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
ok(code.indexOf('parseRunChecksArgs(') < code.indexOf('for (const name of selected)'), 'الوسائط تُحلَّل قبل تشغيل أي فحص');
ok(/for \(const name of selected\)/.test(code), 'الحلقة على المختار لا على CHECKS مباشرة');
ok(/process\.exit\(2\)/.test(code), 'الوسيط الخاطئ يخرج برمز 2');
ok(/performance\.now\(\)/.test(code) && /timings\.push/.test(code), 'زمن كل فحص يُقاس ويُسجَّل');
ok(code.lastIndexOf('writeFileSync(options.report') > code.indexOf('for (const name of selected)'),
  'التقرير يُكتب بعد الحلقة فقط — فحص فاشل يخرج قبله فلا تقرير');

// ---------------------------------------------------------------------------
// 6) الـworkflows: الفحصان الإلزاميان `check` و`validate` وظيفتا تجميع لا تمرّران نتيجة ناقصة
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(scriptsDir, '..');
for (const [file, job] of [['check.yml', 'check'], ['decision-engine-check.yml', 'validate']]) {
  const wf = readFileSync(path.join(repoRoot, '.github', 'workflows', file), 'utf8');
  const where = `${file} (${job})`;
  const block = (id) => {
    const m = new RegExp(`\n  ${id}:\n([\\s\\S]*?)(?=\n  [a-z0-9-]+:\n|$)`).exec(wf);
    assert.ok(m, `${where}: الوظيفة ${id} غير موجودة`);
    return m[1];
  };
  const agg = block(job);
  const shards = block(`${job}-shard`);
  // اسم السياق الإلزامي = معرّف الوظيفة؛ name: كان سيغيّره ويكسر الـruleset بصمت.
  ok(!/^    name:/m.test(agg), `${where}: التجميع بلا name: — السياق الإلزامي يبقى "${job}"`);
  ok(/^    if: \$\{\{ always\(\) \}\}$/m.test(agg), `${where}: التجميع if: always() — المتخطّاة تُحسب ناجحة`);
  ok(new RegExp(`^    needs: \\[${job}-shard\\]$`, 'm').test(agg), `${where}: التجميع ينتظر الـshards`);
  ok(new RegExp(`SHARDS_RESULT: \\$\\{\\{ needs\\.${job}-shard\\.result \\}\\}`).test(agg)
    && /if \[ "\$SHARDS_RESULT" != "success" \]; then[\s\S]*?exit 1/.test(agg), `${where}: يفشل ما لم تكن النتيجة success`);
  ok(agg.indexOf('Require every shard to succeed') < agg.indexOf('verify-check-shards.mjs'), `${where}: شرط النجاح أول خطوة`);
  ok(!/continue-on-error/.test(agg + shards), `${where}: لا continue-on-error في التجميع ولا الـshards`);
  ok(/^      fail-fast: false$/m.test(shards), `${where}: fail-fast: false — كل الـshards تكمل`);
  ok(!/^    if:/m.test(shards), `${where}: لا if: على وظيفة الـshards — تخطّيها يجب أن يمرّ عبر فشل التجميع لا عبر شرط`);
  ok(/if-no-files-found: error/.test(shards), `${where}: رفع التقرير يفشل إن غاب`);
  const matrix = /^        shard: \[([0-9, ]+)\]$/m.exec(shards);
  ok(matrix, `${where}: matrix الـshards`);
  const ids = matrix[1].split(',').map((x) => Number(x.trim()));
  const n = ids.length;
  eq(ids, Array.from({ length: n }, (_, i) => i + 1), `${where}: الـshards 1..${n} بلا ثغرة ولا تكرار`);
  ok(new RegExp(`npm run check -- --shard "\\$SHARD/${n}" --weights scripts/checks\\.weights\\.json --report `).test(shards),
    `${where}: كل shard يشغّل --shard k/${n} بالأوزان ويكتب تقريره`);
  ok(new RegExp(`verify-check-shards\\.mjs --dir "[^"]+" --total ${n} --weights scripts/checks\\.weights\\.json`).test(agg),
    `${where}: التجميع يتحقق من ${n} تقارير بالأوزان نفسها`);
  ok(n <= CHECKS.length && n > 1, `${where}: عدد shards معقول (${n})`);
}

console.log(`check-run-checks-shard: ${assertions} تأكيداً — التقسيم حتمي متفرق شامل، والافتراضي = البوابة كاملة.`);
