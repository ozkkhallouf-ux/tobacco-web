import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CHECKS, EXCLUDED } from './checks.manifest.mjs';

// حارس بوابة `npm run check` نفسها.
//
// العطل الذي يمنعه: كانت السلسلة سطراً واحداً بطول 1736 حرفاً في package.json،
// فكل PR يضيف فحصاً يحرّر السطر ذاته ويتصادم مع كل PR آخر — ثلاث مرات خلال
// ساعتين على PR #158 وحده. والتعارض لا يزعج فحسب: GitHub لا يحسب merge-ref
// لفرع متعارض، فلا يعمل `check` ولا `validate` إطلاقاً — أي أن تصادم سطر واحد
// يُسكت إشارة CI كلها.
//
// ويمنع معه عطلاً ثانياً كُشف أثناء التحقيق: ثلاثة ملفات check*.mjs كانت على
// القرص ولا تعمل ضمن البوابة ولا يذكرها أحد. تبيّن أن لها workflow خاصاً
// (business-os-foundation.yml) — أي أن الاستثناء مقصود، لكنه كان غير مرئي.
// الآن كل ملف إمّا في CHECKS أو في EXCLUDED بسبب مكتوب.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = path.join(repoRoot, 'scripts');

// ---------------------------------------------------------------------------
// 1) لا تكرار، وكل مُدخَل موجود فعلاً على القرص
// ---------------------------------------------------------------------------
assert.equal(new Set(CHECKS).size, CHECKS.length,
  `checks.manifest.mjs: تكرار — ${CHECKS.filter((c, i) => CHECKS.indexOf(c) !== i)}`);

// «فحص» = check.mjs بالضبط أو check-*.mjs. checks.manifest.mjs ليس فحصاً
// رغم بادئته، فلا يدخل الجرد.
const onDisk = (await readdir(scriptsDir)).filter(
  (f) => f.endsWith('.mjs') && (f === 'check.mjs' || f.startsWith('check-')),
);
const diskSet = new Set(onDisk);

for (const name of CHECKS) {
  assert.ok(diskSet.has(name), `checks.manifest.mjs: يذكر ${name} وهو غير موجود في scripts/`);
}
for (const name of Object.keys(EXCLUDED)) {
  assert.ok(diskSet.has(name), `checks.manifest.mjs: استثناء ${name} لملف غير موجود — احذف الاستثناء`);
  assert.ok(!CHECKS.includes(name), `checks.manifest.mjs: ${name} مستثنى ومُدرج معاً`);
  assert.ok(String(EXCLUDED[name] ?? '').trim().length > 10,
    `checks.manifest.mjs: استثناء ${name} بلا سبب مكتوب — الاستثناء بلا تعليل هو العطل نفسه`);
}

// ---------------------------------------------------------------------------
// 2) لا فحص يتيم: كل ملف على القرص إمّا في البوابة أو مستثنى بسبب.
//    هذا ما يمنع تكرار «موجود ولا يعمل ولا أحد يدري».
// ---------------------------------------------------------------------------
const accounted = new Set([...CHECKS, ...Object.keys(EXCLUDED)]);
const orphans = onDisk.filter((f) => !accounted.has(f));
assert.deepEqual(orphans, [],
  `فحوص على القرص غير مذكورة لا في CHECKS ولا في EXCLUDED: ${orphans.join(', ')}`);

// ---------------------------------------------------------------------------
// 3) الترتيب: check.mjs أولاً دائماً، ثم البقية أبجدياً.
//    الأبجدية هي ما يجعل الإضافات تقع في مواضع متفرقة فتندمج تلقائياً.
// ---------------------------------------------------------------------------
assert.equal(CHECKS[0], 'check.mjs',
  `checks.manifest.mjs: check.mjs يجب أن يبقى الأول (فشله المبكر أرخص) — وجدت ${CHECKS[0]}`);
const rest = CHECKS.slice(1);
const sorted = [...rest].sort((a, b) => a.localeCompare(b, 'en'));
assert.deepEqual(rest, sorted,
  'checks.manifest.mjs: ما بعد check.mjs يجب أن يبقى مرتباً أبجدياً — الترتيب هو ما يخفض التعارض');

// ---------------------------------------------------------------------------
// 4) package.json لم يعد يحمل السلسلة المركزية المتنازع عليها
// ---------------------------------------------------------------------------
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
assert.equal(pkg.scripts.check, 'node scripts/run-checks.mjs',
  `package.json: scripts.check يجب أن يكون المنسِّق وحده — وجدت: ${pkg.scripts.check}`);
assert.doesNotMatch(pkg.scripts.check, /check-[a-z0-9-]+\.mjs/,
  'package.json: عادت أسماء الفحوص إلى scripts.check — هذه هي نقطة التعارض بعينها');

// اختصارات الراحة (check:bulletin وغيرها) مسموحة، لكن لا يجوز أن تُشغّل فحصاً
// خارج البوابة — وإلا صار فحص يعمل لأحدهم ولا يحرس main.
for (const [key, value] of Object.entries(pkg.scripts)) {
  if (key === 'check') continue;
  for (const m of String(value).matchAll(/scripts\/(check[a-z0-9.-]*\.mjs)/g)) {
    assert.ok(accounted.has(m[1]),
      `package.json: الاختصار "${key}" يشغّل ${m[1]} وهو ليس في CHECKS ولا في EXCLUDED`);
  }
}

// ---------------------------------------------------------------------------
// 5) المنسِّق يحافظ على دلالة السلسلة القديمة
// ---------------------------------------------------------------------------
// التأكيدات على الشيفرة وحدها: شرح المنسِّق يقتبس نفس العبارات، فمطابقة
// النص كاملاً كانت ستمرّ على تخريب يبقي التعليق ويغيّر السطر الفعلي.
const runnerRaw = await readFile(path.join(scriptsDir, 'run-checks.mjs'), 'utf8');
const runner = runnerRaw
  .split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .join('\n');
assert.match(runner, /stdio: 'inherit'/,
  'run-checks.mjs: stdio يجب أن يبقى inherit — بعض الفحوص تكتب على stderr وهي ناجحة');
assert.match(runner, /process\.exit\(result\.status\)/,
  'run-checks.mjs: يجب أن يعيد رمز خروج الفحص الفاشل نفسه، كما تفعل &&');
assert.match(runner, /spawnSync/,
  'run-checks.mjs: يجب أن يبقى تسلسلياً (spawnSync) — لا تنفيذ متوازٍ');
for (const forbidden of [/Promise\.all/, /\bspawn\(/, /execa/, /concurrently/]) {
  assert.doesNotMatch(runner, forbidden,
    'run-checks.mjs: ظهر تنفيذ متوازٍ/غير متزامن — يغيّر تشابك المخرجات ودلالة fail-fast');
}
assert.doesNotMatch(runner, /process\.env\s*\./,
  'run-checks.mjs: لا يجوز أن يعدّل env — الفحوص تُستدعى كما كانت');

console.log(
  `check chain manifest OK (${CHECKS.length} فحصاً في البوابة، ${Object.keys(EXCLUDED).length} استثناءات معللة، `
  + `check.mjs أولاً ثم أبجدي، package.json بلا سلسلة).`,
);
