import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHECKS } from './checks.manifest.mjs';
import { parseRunChecksArgs, parseShardSpec, selectShard } from './run-checks-shard.mjs';

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
eq(parseRunChecksArgs([]), { shard: null, list: false }, 'بلا وسائط: لا shard ولا list');
eq(selectShard(CHECKS, null), CHECKS, 'بلا shard: كل الفحوص بترتيب البيان');
ok(selectShard(CHECKS, null) !== CHECKS, 'selectShard يعيد نسخة لا مرجع البيان نفسه');

// ---------------------------------------------------------------------------
// 2) الصيغ المقبولة والمرفوضة
// ---------------------------------------------------------------------------
eq(parseRunChecksArgs(['--shard', '2/4']).shard, { index: 2, total: 4 }, '--shard 2/4');
eq(parseRunChecksArgs(['--shard=3/5']).shard, { index: 3, total: 5 }, '--shard=3/5');
eq(parseRunChecksArgs(['--list', '--shard', '1/1']), { shard: { index: 1, total: 1 }, list: true }, '--list مع --shard');
for (const bad of ['0/4', '5/4', '1/0', 'a/b', '1.5/2', '2', '/4', '01/4', '1/04', '-1/4', ' 1/4', '1/4 ', '', undefined]) {
  assert.throws(() => parseShardSpec(bad), undefined, `صيغة مرفوضة: "${bad}"`);
  assertions += 1;
}
for (const badArgv of [['--shards', '1/4'], ['--shard'], ['--shard', '1/4', '--shard', '2/4'], ['1/4'], ['--LIST'], ['-s', '1/4']]) {
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
// 5) المنسِّق يحلّل الوسائط ويختار قبل الحلقة، ويقيس كل فحص
// ---------------------------------------------------------------------------
const code = (await readFile(runner, 'utf8')).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
ok(code.indexOf('parseRunChecksArgs(') < code.indexOf('for (const name of selected)'), 'الوسائط تُحلَّل قبل تشغيل أي فحص');
ok(/for \(const name of selected\)/.test(code), 'الحلقة على المختار لا على CHECKS مباشرة');
ok(/process\.exit\(2\)/.test(code), 'الوسيط الخاطئ يخرج برمز 2');
ok(/performance\.now\(\)/.test(code) && /timings\.push/.test(code), 'زمن كل فحص يُقاس ويُسجَّل');

console.log(`check-run-checks-shard: ${assertions} تأكيداً — التقسيم حتمي متفرق شامل، والافتراضي = البوابة كاملة.`);
