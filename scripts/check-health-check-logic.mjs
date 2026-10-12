// اختبار انحدار لملاحظتَي Codex P1 على PR #135 (scripts/health-check.mjs).
//
// الملاحظتان:
//   P1-A: مسح التشغيلات الفاشلة كان مقيَّداً بـ--branch main، بينما الفحوص
//         الأساسية (check.yml، business-os-foundation.yml، Decision Engine Check)
//         من نوع pull_request فتُنسب تشغيلاتها لفرع الـPR — فلم يكن فشلها يظهر أبداً.
//   P1-B: إغلاق الحوادث كان يعامل *غياب* المشكلة كدليل تعافٍ. فأي فشل في استعلام
//         GitHub، أو تشغيل queued/in_progress يحجب آخر نتيجة مكتملة، كان يُغلق
//         حوادث ما تزال قائمة فعلاً.
//
// الاختبار يعمل على الدوال النقية بلا أي استدعاء لـgh أو للشبكة، ويشمل عقداً
// نصّياً يمنع عودة قيد الفرع.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'health-check.mjs');
const src = await readFile(SCRIPT, 'utf8');
const {
  classifyLatestRun, selectRecentFailures, decideIssuesToClose,
  parseWorkflowIncidentKey, isIncidentConclusion, isRecoveryConclusion, NON_INCIDENT_CONCLUSIONS,
  telegramDedupeKey, issueNumberFromUrl,
} = await import(pathToFileURL(SCRIPT).href);

const codeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ═══════════ P1-A: لا قيد فرع على مسح التشغيلات الفاشلة ═══════════

// المسح العام يجب ألا يمرّر --branch إطلاقاً، وإلا عاد العمى عن فروع الـPR.
const scanBlock = codeOnly.slice(
  codeOnly.indexOf('function checkRecentWorkflowFailures'),
  codeOnly.indexOf('function dedupeByKey'),
);
assert.ok(scanBlock.length > 0, 'تعذّر عزل كتلة checkRecentWorkflowFailures.');
assert.doesNotMatch(
  scanBlock,
  /"--branch"/,
  'عودة الثغرة P1-A: مسح التشغيلات الفاشلة قُيّد بفرع — الفحوص على فروع الـPR ستختفي من المراقبة.',
);
// ويجب أن يطلب headBranch كي تُنسب كل حادثة لفرعها.
assert.match(scanBlock, /headBranch/, 'المسح يجب أن يجلب headBranch لتمييز الحوادث حسب الفرع.');
// ولا يجوز تقييد المسح بـ--status failure: يفوّت startup_failure وstale وسواهما.
assert.doesNotMatch(
  scanBlock,
  /"--status", "failure"/,
  'عودة الثغرة: --status failure يفوّت النتائج النهائية غير الناجحة الأخرى (startup_failure/stale).',
);
assert.match(scanBlock, /"status,conclusion"|status,conclusion/, 'المسح يجب أن يجلب status وconclusion للتصنيف محلياً.');

// أما فحص سير عمل بعينه (توليد النشرات/النشر) فيبقى مقيَّداً بـmain عن قصد،
// لأن هذين يعملان على main فقط.
assert.match(
  codeOnly.slice(codeOnly.indexOf('function checkLatestWorkflowRun'), codeOnly.indexOf('const verdict')),
  /"--branch", "main"/,
  'فحص سير عمل بعينه يجب أن يبقى مقيَّداً بـmain (توليد النشرات والنشر يعملان على main).',
);

// سلوكياً: فشل على فرع PR يجب أن يُرصد، والمفتاح يميّز الفرع.
const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();
const R = (o) => ({ status: 'completed', conclusion: 'failure', ...o });
const runs = [
  R({ workflowName: 'فحص المشروع', headBranch: 'feat/x', url: 'u1', createdAt: iso(5), displayTitle: 'PR #999' }),
  R({ workflowName: 'Decision Engine Check', headBranch: 'feat/y', url: 'u2', createdAt: iso(10), displayTitle: 'PR #998' }),
  R({ workflowName: 'Codex Review Gate', headBranch: 'feat/z', url: 'u3', createdAt: iso(2), displayTitle: 'مستثنى' }),
  R({ workflowName: 'فحص المشروع', headBranch: 'feat/old', url: 'u4', createdAt: iso(500), displayTitle: 'قديم' }),
  R({ workflowName: 'Deploy TOBACCO Web', headBranch: 'main', url: 'u5', createdAt: iso(6), displayTitle: 'بدء فاشل', conclusion: 'startup_failure' }),
  R({ workflowName: 'نجاح', headBranch: 'main', url: 'u6', createdAt: iso(6), displayTitle: 'ناجح', conclusion: 'success' }),
  R({ workflowName: 'متخطّى', headBranch: 'main', url: 'u7', createdAt: iso(6), displayTitle: 'متخطّى', conclusion: 'skipped' }),
  R({ workflowName: 'جارٍ', headBranch: 'main', url: 'u8', createdAt: iso(6), displayTitle: 'جارٍ', status: 'in_progress', conclusion: null }),
];
const found = selectRecentFailures(runs, now - 40 * 60000);
assert.equal(found.length, 3, 'يجب رصد الفشلين على فرعَي الـPR + startup_failure، لا أكثر.');
assert.ok(found.some((p) => p.details.includes('u5')), 'startup_failure يجب أن يُرصد كعطل.');
assert.ok(!found.some((p) => p.details.includes('u6') || p.details.includes('u7')), 'success وskipped ليسا حادثة.');
assert.ok(!found.some((p) => p.details.includes('u8')), 'التشغيل غير المكتمل ليس حادثة.');
assert.ok(found.some((p) => p.key === 'workflow-failure-فحص المشروع@feat/x'), 'مفتاح الحادثة يجب أن يشمل الفرع.');
assert.ok(!found.some((p) => p.workflowName === 'Codex Review Gate'), 'Codex Review Gate يجب أن يبقى مستثنى.');
assert.ok(!found.some((p) => p.details.includes('قديم')), 'ما خرج عن نافذة المراقبة يجب أن يُستبعد.');

// ═══════════ تصنيف النتائج: قائمة سماح لا قائمة منع ═══════════
assert.deepEqual([...NON_INCIDENT_CONCLUSIONS].sort(), ['skipped', 'success'], 'غير الحادثة: success وskipped فقط (نفس قاعدة alert-on-automation-failure.yml).');
for (const c of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'neutral', null]) {
  assert.equal(isIncidentConclusion(c), true, `النتيجة "${c}" يجب أن تُعدّ عطلاً.`);
}
for (const c of ['success', 'skipped']) {
  assert.equal(isIncidentConclusion(c), false, `النتيجة "${c}" يجب ألا تُعدّ عطلاً.`);
}
// سلوكياً على classifyLatestRun: startup_failure يجب ألا يُصنَّف سليماً.
assert.equal(
  classifyLatestRun([{ status: 'completed', conclusion: 'startup_failure', url: 'u', createdAt: iso(2) }],
    { workflowName: 'W', key: 'deploy-failed', severity: 'عالٍ' }).problems.length,
  1,
  'عودة الثغرة: startup_failure كان يُصنَّف سليماً ويغلق عطلاً قائماً.',
);

// ═══════════ "ليست حادثة" ≠ "دليل تعافٍ" ═══════════
// pages.yml يتخطّى check وdeploy عند فشل توليد النشرات، فينتهي التشغيل بنتيجة
// skipped بلا أي نشر — فلا يجوز إغلاق حادثة النشر بناءً عليه.
assert.equal(isRecoveryConclusion('success'), true, 'النجاح الصريح هو دليل التعافي.');
assert.equal(isRecoveryConclusion('skipped'), false, 'عودة الثغرة: skipped ليس دليل تعافٍ — لم يُنشر شيء.');
for (const c of ['failure', 'cancelled', 'startup_failure', 'stale', null]) {
  assert.equal(isRecoveryConclusion(c), false, `"${c}" ليس دليل تعافٍ.`);
}
// وسلوكياً على classifyLatestRun: skipped = لا إنذار ولا إغلاق (مجهول).
const skipped = classifyLatestRun(
  [{ status: 'completed', conclusion: 'skipped', url: 'u', createdAt: iso(2) }],
  { workflowName: 'Deploy TOBACCO Web', key: 'deploy-failed', severity: 'عالٍ' },
);
assert.deepEqual(skipped.problems, [], 'skipped يجب ألا يُطلق إنذاراً.');
assert.deepEqual(skipped.healthy, [], 'عودة الثغرة: skipped كان يُغلق deploy-failed بلا نشر فعلي.');
assert.equal(skipped.unknown, true, 'skipped حالة مجهولة.');
// والتحقق الفعلي لحوادث سير العمل يشترط النجاح الصريح أيضاً.
assert.match(
  codeOnly.slice(codeOnly.indexOf('function verifyWorkflowIncidentResolved'), codeOnly.indexOf('function closeResolvedIssues')),
  /return isRecoveryConclusion\(lastCompleted\.conclusion\)/,
  'التحقق من حادثة سير عمل يجب أن يشترط نجاحاً صريحاً لا مجرد "ليست حادثة".',
);

// ═══════════ مفتاح تعافي الموقع يطابق مفتاح العطل ═══════════
// لو اختلف المفتاحان لبقي Issue العطل مفتوحاً للأبد، ثم كتم reportProblem كل
// انقطاع لاحق لأنه يجد Issue مفتوحاً بنفس المفتاح.
const siteBlock = codeOnly.slice(codeOnly.indexOf('async function checkSiteReachability'), codeOnly.indexOf('export const NON_INCIDENT_CONCLUSIONS'));
const siteFailKey = siteBlock.match(/key:\s*"(site-[a-z-]+)"/)?.[1];
const siteHealthyKey = siteBlock.match(/healthy\.push\("(site-[a-z-]+)"\)/)?.[1];
assert.ok(siteFailKey && siteHealthyKey, 'تعذّر استخراج مفتاحَي عطل/تعافي الموقع.');
assert.equal(siteHealthyKey, siteFailKey, `عودة الثغرة: مفتاح تعافي الموقع (${siteHealthyKey}) يجب أن يطابق مفتاح العطل (${siteFailKey}).`);

// ═══════════ P1-B: لا إغلاق بلا دليل إيجابي ═══════════

const meta = { workflowName: 'Deploy TOBACCO Web', key: 'deploy-failed', severity: 'عالٍ' };

// (1) تشغيل قيد التنفيذ يعلو فشلاً مكتملاً: يجب أن تبقى المشكلة مرصودة.
const masked = classifyLatestRun([
  { status: 'in_progress', conclusion: null, url: 'u', createdAt: iso(1) },
  { status: 'completed', conclusion: 'failure', url: 'u', createdAt: iso(30) },
], meta);
assert.equal(masked.problems.length, 1, 'تشغيل قيد التنفيذ يجب ألا يحجب آخر نتيجة مكتملة فاشلة.');
assert.deepEqual(masked.healthy, [], 'لا دليل سلامة ما دام آخر مكتمل فاشلاً.');

// (2) لا تشغيل مكتمل إطلاقاً → حالة مجهولة، لا سليمة.
const unknown = classifyLatestRun([{ status: 'queued', conclusion: null, url: 'u', createdAt: iso(1) }], meta);
assert.equal(unknown.unknown, true, 'غياب أي تشغيل مكتمل يجب أن يكون "مجهولاً".');
assert.deepEqual(unknown.problems, [], 'الحالة المجهولة ليست مشكلة بذاتها.');
assert.deepEqual(unknown.healthy, [], 'الحالة المجهولة ليست دليل سلامة.');

// (3) نجاح مكتمل = الدليل الإيجابي الوحيد.
const ok = classifyLatestRun([{ status: 'completed', conclusion: 'success', url: 'u', createdAt: iso(3) }], meta);
assert.deepEqual(ok.healthy, ['deploy-failed'], 'نجاح مكتمل يجب أن ينتج دليل سلامة.');
assert.deepEqual(ok.problems, [], 'نجاح مكتمل ليس مشكلة.');

// (4) جوهر P1-B: حادثة مفتوحة لا يجوز إغلاقها بلا دليل.
const openIssues = [
  { number: 11, body: '<!-- health:deploy-failed -->' },
  { number: 12, body: '<!-- health:workflow-failure-فحص المشروع@feat/x -->' },
  { number: 13, body: '<!-- health:site-down -->' },
  { number: 14, body: 'بلا علامة' },
];

// حالة الانقطاع: لا مشاكل مرصودة ولا أدلة سلامة (استعلام GitHub فشل).
assert.deepEqual(
  decideIssuesToClose({ openIssues, activeKeys: new Set(), healthyKeys: new Set() }),
  [],
  'عودة الثغرة P1-B: لا يجوز إغلاق أي حادثة لمجرد أن الفحص لم يرصد شيئاً.',
);

// دليل إيجابي على واحدة فقط → تُغلق وحدها.
assert.deepEqual(
  decideIssuesToClose({
    openIssues, activeKeys: new Set(), healthyKeys: new Set(['site-down']),
  }),
  [{ number: 13, key: 'site-down' }],
  'تُغلق الحادثة ذات الدليل الإيجابي وحدها.',
);

// ⚠️ الملاحظة الثالثة من Codex: مجرد غياب الحادثة عن نافذة المراقبة ليس تعافياً.
// لا يجوز إغلاق حادثة سير عمل إلا بتحقق فعلي يرصد نجاحاً مكتملاً.
assert.deepEqual(
  decideIssuesToClose({ openIssues, activeKeys: new Set(), healthyKeys: new Set(), verifyKey: () => false }),
  [],
  'عودة الثغرة: انقضاء نافذة LOOKBACK لا يعني تعافياً — بلا نجاح مرصود تبقى الحادثة مفتوحة.',
);
// وبتحقق ناجح تُغلق حادثة سير العمل وحدها.
assert.deepEqual(
  decideIssuesToClose({
    openIssues, activeKeys: new Set(), healthyKeys: new Set(),
    verifyKey: (k) => k === 'workflow-failure-فحص المشروع@feat/x',
  }),
  [{ number: 12, key: 'workflow-failure-فحص المشروع@feat/x' }],
  'التحقق الفعلي يُغلق الحادثة المعنية وحدها.',
);
// ولا يجوز أن يُستدعى verifyKey أصلاً حين يفشل المسح العام (scanOk=false).
const closeBlock = codeOnly.slice(codeOnly.indexOf('function closeResolvedIssues'), codeOnly.indexOf('async function main'));
assert.match(closeBlock, /verifyKey:\s*scanOk \? verifyWorkflowIncidentResolved : undefined/, 'التحقق يجب أن يُعطَّل حين يفشل المسح العام.');

// فكّ مفتاح الحادثة يجب أن يصمد لأسماء عربية وفروع فيها شرطات ونقاط
assert.deepEqual(parseWorkflowIncidentKey('workflow-failure-فحص المشروع@feat/x'), { workflowName: 'فحص المشروع', branch: 'feat/x' });
assert.deepEqual(parseWorkflowIncidentKey('workflow-failure-A@B@feat/y'), { workflowName: 'A@B', branch: 'feat/y' });
assert.equal(parseWorkflowIncidentKey('site-down'), null, 'مفتاح غير خاص بسير عمل يجب أن يرجع null.');

// والتحقق الفعلي يجب أن يشترط أحدث تشغيل *مكتمل* ناجح
const verifyBlock = codeOnly.slice(codeOnly.indexOf('function verifyWorkflowIncidentResolved'), codeOnly.indexOf('function closeResolvedIssues'));
assert.match(verifyBlock, /find\(\(r\) => r && r\.status === "completed"\)/, 'التحقق يجب أن يبحث عن أحدث تشغيل مكتمل.');
assert.match(verifyBlock, /return isRecoveryConclusion\(lastCompleted\.conclusion\)/, 'التحقق يجب أن يشترط نجاحاً صريحاً.');
assert.match(verifyBlock, /"--workflow", parsed\.workflowName/, 'التحقق يجب أن يستعلم عن نفس سير العمل.');
assert.match(verifyBlock, /"--branch", parsed\.branch/, 'التحقق يجب أن يستعلم عن نفس الفرع.');

// حادثة ما تزال نشطة لا تُغلق ولو ورد لها دليل سلامة متناقض.
assert.deepEqual(
  decideIssuesToClose({
    openIssues,
    activeKeys: new Set(['deploy-failed']),
    healthyKeys: new Set(['deploy-failed']),
  }),
  [],
  'المشكلة النشطة تتقدّم على أي دليل سلامة.',
);

// ═══════════ نموذج مرجعي: السلوك القديم كان يُغلق الجميع ═══════════
const legacyWouldClose = openIssues
  .filter((i) => /<!-- health:([^>]+) -->/.test(i.body || ''))
  .filter((i) => !new Set().has(i.body.match(/<!-- health:([^>]+) -->/)[1]));
assert.equal(
  legacyWouldClose.length, 3,
  'النموذج المرجعي للسلوك المعطوب يجب أن يُظهر إغلاق الحوادث الثلاث (وإلا فالاختبار لا يرصد شيئاً).',
);

// ═══════════ منع التكرار مرتبط بهوية الحادثة ═══════════
// انقطاع → تعافٍ → انقطاع جديد خلال نافذة p_dedupe_minutes (180 دقيقة) كان
// يعيد المفتاح نفسه فيكتم إشعار الانقطاع الجديد رغم إنشاء Issue جديد.
assert.equal(issueNumberFromUrl('https://github.com/o/r/issues/42'), 42, 'استخراج رقم الـIssue من الرابط.');
assert.equal(issueNumberFromUrl(''), null, 'رابط فارغ يعطي null.');
assert.equal(issueNumberFromUrl('https://github.com/o/r/pull/42'), null, 'رابط PR ليس Issue.');

const k1 = telegramDedupeKey('site-down', 41);
const k2 = telegramDedupeKey('site-down', 42);
assert.notEqual(k1, k2, 'عودة الثغرة: حادثتان مختلفتان (Issue مختلف) يجب ألا تتشاركا مفتاح منع التكرار.');
assert.equal(telegramDedupeKey('site-down', 42), k2, 'نفس الحادثة يجب أن تعطي المفتاح نفسه (منع التكرار يبقى فاعلاً).');
assert.ok(k2.includes('42'), 'المفتاح يجب أن يتضمن هوية الحادثة.');

// وبلا Issue: حزمة زمنية بالساعة — يصل التنبيه دون أن يتكرر كل 30 دقيقة.
const H = 60 * 60 * 1000;
const n1 = telegramDedupeKey('site-down', null, 5 * H + 60000);
const n2 = telegramDedupeKey('site-down', null, 5 * H + 120000);
const n3 = telegramDedupeKey('site-down', null, 6 * H + 60000);
assert.equal(n1, n2, 'ضمن الساعة نفسها يبقى المفتاح واحداً.');
assert.notEqual(n1, n3, 'ساعة جديدة تعطي مفتاحاً جديداً.');
assert.notEqual(n1, k2, 'مسار "بلا Issue" لا يتصادم مع مسار الـIssue.');

// ═══════════ فشل إنشاء Issue لا يُلغي قناة التنبيه المستقلة ═══════════
const reportBlock = codeOnly.slice(codeOnly.indexOf('async function reportProblem'), codeOnly.indexOf('export function parseWorkflowIncidentKey'));
assert.ok(reportBlock.length > 0, 'تعذّر عزل كتلة reportProblem.');
const catchIdx = reportBlock.indexOf('فشل إنشاء Issue');
assert.ok(catchIdx > 0, 'تعذّر إيجاد مسار فشل إنشاء الـIssue.');
const afterCatch = reportBlock.slice(catchIdx, catchIdx + 400);
assert.match(
  afterCatch,
  /await notifyTelegram\(problem, null\)/,
  'عودة الثغرة: فشل إنشاء Issue كان يُرجع قبل notifyTelegram فيبقى العطل بلا أي تنبيه.',
);

// ═══════════ انهيار المراقب نفسه يجب أن يكون مرئياً ═══════════
// كان المعالِج يفرض exitCode = 0 فيُبلَّغ التشغيل كناجح رغم غياب أي مراقبة،
// وalert-on-automation-failure.yml لم يكن يراقب هذا السير أصلاً.
const tail = src.slice(src.indexOf('const isDirectRun'));
assert.doesNotMatch(
  tail.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'),
  /process\.exitCode = 0/,
  'عودة الثغرة: انهيار المراقب يجب ألا يُبلَّغ كتشغيل ناجح.',
);
assert.match(tail, /process\.exitCode = 1/, 'انهيار المراقب يجب أن يُفشل التشغيل ليكون مرئياً.');
assert.match(tail, /notifyTelegram\(/, 'انهيار المراقب يجب أن يُرسل تنبيهاً احتياطياً عبر القناة المستقلة قبل الخروج.');
assert.match(tail, /health-check-crashed/, 'التنبيه الاحتياطي يجب أن يحمل مفتاحاً خاصاً بالانهيار.');

// ومَن يراقب المراقب: يجب أن يكون سير عمل health-check ضمن قائمة التنبيه.
const alertYml = await readFile(path.join(repoRoot, '.github', 'workflows', 'alert-on-automation-failure.yml'), 'utf8');
const healthYml = await readFile(path.join(repoRoot, '.github', 'workflows', 'health-check.yml'), 'utf8');
const healthName = healthYml.match(/^name:\s*(.+)$/m)?.[1].trim();
assert.ok(healthName, 'تعذّر استخراج اسم سير عمل health-check.');
assert.ok(
  new RegExp(`^\\s*-\\s*"${healthName}"\\s*$`, 'm').test(alertYml),
  `عودة الثغرة: سير عمل "${healthName}" يجب أن يكون مراقَباً في alert-on-automation-failure.yml وإلا مرّ انهياره بلا تنبيه.`,
);

// ═══════════ فشل القناتين معاً يجب أن يُفشل التشغيل ═══════════
// إن فشل إنشاء الـIssue وفشل استدعاء notify_telegram أيضاً، لم تصل الحادثة
// إلى أحد. كان التشغيل ينتهي بنجاح فيبقى العطل الإنتاجي في السجل وحده،
// وalert-on-automation-failure.yml لا يعمل إلا على تشغيل غير ناجح.
const notifyBlock = codeOnly.slice(codeOnly.indexOf('async function notifyTelegram'), codeOnly.indexOf('async function reportProblem'));
assert.match(notifyBlock, /return true;/, 'notifyTelegram يجب أن يُبلّغ عن نجاح التسليم.');
assert.match(notifyBlock, /return false;/, 'notifyTelegram يجب أن يُبلّغ عن فشل التسليم.');

const reportBlock2 = codeOnly.slice(codeOnly.indexOf('async function reportProblem'), codeOnly.indexOf('export function parseWorkflowIncidentKey'));
assert.match(reportBlock2, /const delivered = await notifyTelegram\(problem, null\)/, 'reportProblem يجب أن يقرأ نتيجة التنبيه الاحتياطي.');
assert.match(reportBlock2, /return delivered;/, 'reportProblem يجب أن يُمرّر فشل التسليم للأعلى.');

const mainBlock = codeOnly.slice(codeOnly.indexOf('async function main'), codeOnly.indexOf('const isDirectRun'));
assert.match(mainBlock, /if \(!delivered\) undelivered \+= 1;/, 'main يجب أن يحصي المشاكل غير المسلَّمة.');
assert.match(
  mainBlock,
  /if \(undelivered > 0\)[\s\S]{0,400}process\.exitCode = 1;/,
  'عودة الثغرة: فشل كل قنوات التبليغ يجب أن يُفشل التشغيل لا أن يمرّ بنجاح.',
);

// ═══════════ دورة حياة العطل غير الحرج (PR-B): RPC بإقرار صريح (public.health_lifecycle في proposed/13) ═══════════
{
  const H = await import(pathToFileURL(SCRIPT).href);
  const { IMMEDIATE_HEALTH_KEYS, processClosures, callLifecycle, detectLifecycleMode, resolveForClosure, confirmLegacyAbsence, lifecycleSwitchOff, LEGACY_CONFIRM_MIN_MS, LEGACY_CONFIRM_MAX_MS } = H;
  const ENV = { SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_KEY: 'k' };

  // الحرجان فقط فوريان، وتطابق التوجيه والـRPC في proposed/13 حرفياً (لا انجراف بين الطرفين)
  assert.deepEqual([...IMMEDIATE_HEALTH_KEYS], ['site-down', 'health-check-crashed']);
  const p13 = await readFile(path.join(repoRoot, 'supabase', 'proposed', '13-digest-routing-for-noncritical-alerts.sql'), 'utf8');
  assert.ok(p13.includes("^health-(site-down|health-check-crashed)"), 'قائمة الحرجين في health-check.mjs يجب أن تطابق توجيه 13');
  assert.ok(p13.includes("p_key in ('site-down', 'health-check-crashed')"), 'الـRPC ترفض الحرجين نفسيهما');
  assert.ok(p13.includes('create or replace function public.health_lifecycle('), 'الـRPC موجودة في 13');

  // مفتاح الإيقاف: طوارئ فقط (off)، أي قيمة أخرى = اكتشاف تلقائي
  assert.equal(lifecycleSwitchOff({}), false);
  for (const v of ['off', 'OFF', ' off ']) assert.equal(lifecycleSwitchOff({ HEALTH_LIFECYCLE_SIGNALS: v }), true, v);
  for (const v of ['on', 'yes', '', '0', 'false']) assert.equal(lifecycleSwitchOff({ HEALTH_LIFECYCLE_SIGNALS: v }), false, v);

  // fetch وهمي يسجّل الطلبات (لا شبكة)
  const mkFetch = (handler) => {
    const reqs = [];
    const fetchImpl = async (url, init) => {
      reqs.push({ url, init, body: JSON.parse(init.body) });
      return handler(reqs[reqs.length - 1]);
    };
    return { reqs, fetchImpl };
  };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const PGRST202 = { code: 'PGRST202', message: 'Could not find the function public.health_lifecycle' };

  // callLifecycle: الطلب إلى rpc/health_lifecycle فقط (لا notify_telegram) بهوية العملية كاملة
  {
    const f = mkFetch(() => reply(200, { ok: true, op: 'resolve', resolved: 1 }));
    const r = await callLifecycle('resolve', { key: 'deploy-failed', issue: 12 }, { env: ENV, fetchImpl: f.fetchImpl });
    assert.equal(r.kind, 'ok');
    assert.equal(f.reqs[0].url, 'https://db.example.test/rest/v1/rpc/health_lifecycle');
    assert.deepEqual(f.reqs[0].body, { p_op: 'resolve', p_key: 'deploy-failed', p_issue: 12, p_label: null });
    assert.equal(f.reqs[0].init.headers['Content-Profile'], 'public');
  }
  // أنواع الفشل ⇒ error/absent لا ok
  const outcomes = [
    ['PGRST202', () => reply(404, PGRST202), 'absent'],
    ['404 آخر (ليس PGRST202)', () => reply(404, { code: 'PGRST125' }), 'error'],
    ['404 بجسم غير JSON', () => reply(404, '<html>nginx</html>'), 'error'],
    ['500', () => reply(500, { message: 'boom' }), 'error'],
    ['503', () => reply(503, 'unavailable'), 'error'],
    ['401', () => reply(401, { message: 'bad key' }), 'error'],
    ['403', () => reply(403, { message: 'permission denied' }), 'error'],
    ['400 (خطأ صريح من الـRPC)', () => reply(400, { code: '22023', message: 'health_lifecycle: invalid key' }), 'error'],
    ['2xx بلا إقرار', () => reply(200, {}), 'error'],
    ['2xx ok=false', () => reply(200, { ok: false, op: 'resolve', resolved: 1 }), 'error'],
    ['2xx عملية مختلفة', () => reply(200, { ok: true, op: 'renew', renewed: 1, created: false }), 'error'],
    ['2xx بلا resolved', () => reply(200, { ok: true, op: 'resolve' }), 'error'],
    ['2xx null', () => reply(200, 'null'), 'error'],
  ];
  for (const [name, h, want] of outcomes) {
    const f = mkFetch(h);
    assert.equal((await callLifecycle('resolve', { key: 'k', issue: 1 }, { env: ENV, fetchImpl: f.fetchImpl })).kind, want, name);
  }
  assert.equal((await callLifecycle('resolve', { key: 'k', issue: 1 }, { env: ENV, fetchImpl: async () => { throw new Error('ECONNRESET'); } })).kind, 'error', 'شبكة');
  assert.equal((await callLifecycle('probe', {}, { env: {}, fetchImpl: async () => { throw new Error('must not call'); } })).kind, 'error', 'بلا أسرار');
  assert.equal((await callLifecycle('renew', { key: 'k', issue: 1 }, { env: ENV, fetchImpl: mkFetch(() => reply(200, { ok: true, op: 'renew', renewed: 0, created: true })).fetchImpl })).kind, 'ok');

  // detectLifecycleMode: ثلاث حالات + طوارئ
  const mode = async (h, env = ENV) => { const f = mkFetch(h); return { m: await detectLifecycleMode({ env, fetchImpl: f.fetchImpl }), f }; };
  assert.equal((await mode(() => reply(200, { ok: true, op: 'probe', v: 1, ready: true }))).m, 'ready');
  assert.equal((await mode(() => reply(200, { ok: true, op: 'probe', v: 1, ready: false }))).m, 'unknown', '13 موجود لكن التوجيه غير فعّال ⇒ لا افتراض');
  assert.equal((await mode(() => reply(404, PGRST202))).m, 'absent');
  // السرّ اختياري في الـworkflow: بدونه لا يصنع السكربت أي حدث ⇒ unconfigured (لا طلبات) وليس unknown (وإلا بقيت الـIssues مفتوحة للأبد)
  for (const env of [{}, { SUPABASE_URL: ENV.SUPABASE_URL }, { SUPABASE_SERVICE_KEY: 'k' }]) {
    const u = await mode(() => reply(200, { ok: true, op: 'probe', v: 1, ready: true }), env);
    assert.equal(u.m, 'unconfigured'); assert.equal(u.f.reqs.length, 0);
  }
  assert.equal((await mode(() => reply(200, {}), { HEALTH_LIFECYCLE_SIGNALS: 'off' })).m, 'off', 'الطوارئ تسبق unconfigured');
  assert.equal((await mode(() => reply(503, 'x'))).m, 'unknown');
  assert.equal((await mode(() => reply(401, 'x'))).m, 'unknown');
  assert.equal((await mode(() => { throw new Error('db down'); })).m, 'unknown', 'فشل اتصال قاعدة البيانات ⇒ غير معروف لا قديم');
  {
    const off = await mode(() => reply(200, { ok: true, op: 'probe', v: 1, ready: true }), { ...ENV, HEALTH_LIFECYCLE_SIGNALS: 'off' });
    assert.equal(off.m, 'off');
    assert.equal(off.f.reqs.length, 0, 'إيقاف الطوارئ: لا أي طلب لقاعدة البيانات');
  }

  // confirmLegacyAbsence: ملاحظتان منفصلتان زمنياً بتاريخ GitHub
  {
    const NOW = Date.parse('2026-10-12T12:00:00Z');
    const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
    const MARK = (t) => `<!-- health-probe-absent:${t} -->\nملاحظة`;
    const run = (comments, opts = {}) => {
      const posted = [];
      const ok = confirmLegacyAbsence(7, {
        readComments: opts.readThrows ? () => { throw new Error('gh'); } : () => comments,
        postComment: opts.postThrows ? () => { throw new Error('gh'); } : (n, b) => posted.push([n, b]),
        nowMs: NOW,
      });
      return { ok, posted };
    };
    let r = run([]);
    assert.equal(r.ok, false, 'أول ملاحظة لا تؤكّد');
    assert.equal(r.posted.length, 1);
    assert.equal(r.posted[0][0], 7);
    assert.match(r.posted[0][1], /^<!-- health-probe-absent:2026-10-12T12:00:00\.000Z -->/);
    r = run([{ body: MARK('x'), createdAt: iso(5 * 60 * 1000) }]);
    assert.deepEqual([r.ok, r.posted.length], [false, 0], 'أقل من 20 د ⇒ لا تأكيد ولا تكرار تعليق');
    r = run([{ body: MARK('x'), createdAt: iso(LEGACY_CONFIRM_MIN_MS - 1000) }]);
    assert.equal(r.ok, false);
    r = run([{ body: MARK('x'), createdAt: iso(LEGACY_CONFIRM_MIN_MS) }]);
    assert.deepEqual([r.ok, r.posted.length], [true, 0], 'مرّ 20 د ⇒ تأكيد');
    r = run([{ body: MARK('x'), createdAt: iso(LEGACY_CONFIRM_MAX_MS) }]);
    assert.equal(r.ok, true);
    r = run([{ body: MARK('x'), createdAt: iso(LEGACY_CONFIRM_MAX_MS + 1000) }]);
    assert.deepEqual([r.ok, r.posted.length], [false, 1], 'ملاحظة أقدم من 6 س لا تُعتمد وتُستبدل بجديدة');
    r = run([{ body: 'تعليق عادي', createdAt: iso(60 * 60 * 1000) }]);
    assert.deepEqual([r.ok, r.posted.length], [false, 1], 'تعليق بلا وسم لا يؤكّد');
    r = run([{ body: MARK('x'), createdAt: 'not-a-date' }]);
    assert.equal(r.ok, false);
    r = run([], { readThrows: true });
    assert.deepEqual([r.ok, r.posted.length], [false, 0], 'فشل gh ⇒ لا تأكيد');
    r = run([], { postThrows: true });
    assert.equal(r.ok, false);
    // الوسم لا يُصدَّق من نصّه: التاريخ المكتوب في الوسم لا يُستعمل
    r = run([{ body: MARK('2020-01-01T00:00:00Z'), createdAt: iso(1000) }]);
    assert.equal(r.ok, false, 'المرجع تاريخ GitHub لا نصّ الوسم');
  }

  // resolveForClosure: القرارات
  {
    const logs = [];
    const log = (m) => logs.push(m);
    const never = () => { throw new Error('must not be called'); };
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'off', call: never, confirm: never, log }), 'hold');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'unknown', call: never, confirm: never, log }), 'hold');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'absent', call: never, confirm: () => false, log }), 'hold');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'absent', call: never, confirm: () => true, log }), 'legacy');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'unconfigured', call: never, confirm: never, managed: () => false, log }), 'legacy', 'بلا أسرار ولم يُدَر قط ⇒ إغلاق قديم بلا RPC ولا تأكيد');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'unconfigured', call: never, confirm: never, managed: () => true, log }), 'hold', 'أُدير عبر 13 ثم فُقد المفتاح ⇒ لا إغلاق (لا حدث يتيم)');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'unconfigured', call: never, confirm: never, managed: () => { throw new Error('gh'); }, log }), 'hold', 'تعذّر فحص الوسم ⇒ محافظة');
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'unconfigured', call: never, confirm: never, log }), 'hold', 'الافتراضي محافظ');
    const calls = [];
    assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'ready', confirm: never, log, call: async (op, a) => { calls.push([op, a]); return { kind: 'ok', body: { ok: true, op: 'resolve', resolved: 1 } }; } }), 'resolved');
    assert.deepEqual(calls, [['resolve', { key: 'deploy-failed', issue: 5 }]]);
    for (const bad of [{ kind: 'error', detail: 'HTTP 500' }, { kind: 'absent' }]) {
      assert.equal(await resolveForClosure('deploy-failed', 5, { mode: 'ready', confirm: never, log, call: async () => bad }), 'hold', JSON.stringify(bad));
    }
    assert.ok(logs.length >= 5, 'كل تعليق حالة يُسجَّل بوضوح');
  }

  // قاعدة بيانات وهمية تطبّق دلالة الـRPC (مطابقة المفتاح+رقم الـIssue بالضبط) لاختبار التدفق كاملاً بلا Telegram
  const mkDb = (state) => {
    const events = new Set(state.events || []);
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(url);
      if (state.down) throw new Error('connection refused');
      if (state.lag) return reply(404, PGRST202);
      const b = JSON.parse(init.body);
      const ek = `health-${b.p_key}-issue-${b.p_issue}`;
      if (b.p_op === 'probe') return reply(200, { ok: true, op: 'probe', v: 1, ready: true });
      if (b.p_op === 'renew') { const had = events.has(ek); events.add(ek); return reply(200, { ok: true, op: 'renew', renewed: had ? 1 : 0, created: !had }); }
      const had = events.delete(ek);
      return reply(200, { ok: true, op: 'resolve', resolved: had ? 1 : 0 });
    };
    return { events, urls, fetchImpl, state };
  };
  const closeFlow = async (db, toClose, { env = ENV, confirm = () => false } = {}) => {
    const closed = [];
    const mode = await detectLifecycleMode({ env, fetchImpl: db.fetchImpl });
    const logs = [];
    const res = await processClosures(toClose, {
      resolveLifecycle: (key, number) => resolveForClosure(key, number, { mode, confirm, log: (m) => logs.push(m), call: (op, args) => callLifecycle(op, args, { env, fetchImpl: db.fetchImpl }) }),
      closeIssue: async (n) => { closed.push(n); return true; },
      log: (m) => logs.push(m),
    });
    return { res, closed, mode, logs };
  };

  // جاهز: يحلّ الحدث المطابق وحده (مفاتيح وأرقام مختلفة) ثم يغلق؛ التكرار idempotent
  {
    const db = mkDb({ events: ['health-deploy-failed-issue-5', 'health-deploy-failed-issue-6', 'health-price-generation-failed-issue-5'] });
    let f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }]);
    assert.deepEqual(f.closed, [5]);
    assert.deepEqual([...db.events].sort(), ['health-deploy-failed-issue-6', 'health-price-generation-failed-issue-5'], 'لا يُغلَق حدث بمفتاح أو رقم Issue آخر');
    f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }]);
    assert.deepEqual(f.closed, [5], 'تكرار الطلب لا يفشل (idempotent)');
    assert.equal(db.events.size, 2);
    assert.ok(db.urls.every((u) => u.endsWith('/rpc/health_lifecycle')), 'لا استدعاء لـnotify_telegram إطلاقاً');
  }
  // تأخّر schema cache (PGRST202 رغم تطبيق 13): لا إغلاق في الدورة الأولى ولا الثانية دون تأكيد، ثم يعود ready فيُحلّ الحدث
  {
    const db = mkDb({ events: ['health-deploy-failed-issue-5'], lag: true });
    let f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }], { confirm: () => false });
    assert.deepEqual([f.mode, f.closed], ['absent', []], 'غياب غير مؤكَّد ⇒ يبقى مفتوحاً');
    assert.equal(db.events.size, 1);
    delete db.state.lag;
    f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }]);
    assert.deepEqual([f.mode, f.closed], ['ready', [5]]);
    assert.equal(db.events.size, 0, 'لا حدث يتيم بعد الإغلاق');
  }
  // قديم مؤكَّد (13 غير مطبَّق): يُغلق بلا أي حلّ؛ لا RPC resolve
  {
    const db = mkDb({ lag: true });
    const f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }], { confirm: () => true });
    assert.deepEqual([f.mode, f.closed], ['absent', [5]]);
    assert.equal(db.urls.length, 1, 'probe فقط');
  }
  // فشل اتصال قاعدة البيانات: غير معروف ⇒ لا إغلاق ولا افتراض تعافٍ؛ يُعاد لاحقاً
  {
    const db = mkDb({ events: ['health-deploy-failed-issue-5'], down: true });
    let f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }, { number: 9, key: 'site-down' }]);
    assert.equal(f.mode, 'unknown');
    assert.deepEqual(f.closed, [9], 'الحرج بلا حدث يُغلق؛ غير الحرج يبقى');
    delete db.state.down;
    f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }]);
    assert.deepEqual(f.closed, [5], 'عودة الاتصال ⇒ يكتمل الإغلاق');
    assert.equal(db.events.size, 0);
  }
  // فشل resolve بعد probe ناجح (5xx): لا إغلاق
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const b = JSON.parse(init.body); calls.push(b.p_op);
      return b.p_op === 'probe' ? reply(200, { ok: true, op: 'probe', v: 1, ready: true }) : reply(500, { message: 'boom' });
    };
    const f = await closeFlow({ fetchImpl }, [{ number: 5, key: 'deploy-failed' }]);
    assert.deepEqual([f.mode, f.closed], ['ready', []]);
    assert.deepEqual(calls, ['probe', 'resolve']);
  }
  // إيقاف الطوارئ قبل 13 وبعده وعند فشل الاتصال: لا طلبات، لا إغلاق لغير الحرج، الحرج يُغلق
  for (const [name, st] of [['قبل 13', { lag: true }], ['بعد 13', { events: ['health-deploy-failed-issue-5'] }], ['اتصال معطّل', { down: true }]]) {
    const db = mkDb(st);
    const f = await closeFlow(db, [{ number: 5, key: 'deploy-failed' }, { number: 9, key: 'health-check-crashed' }], { env: { ...ENV, HEALTH_LIFECYCLE_SIGNALS: 'off' }, confirm: () => { throw new Error('no confirm in off'); } });
    assert.deepEqual([f.mode, f.closed, db.urls.length], ['off', [9], 0], name);
    assert.equal(db.events.size, st.events ? 1 : 0, `${name}: لا حدث يتيم ولا حلّ`);
  }
  // فشل الإغلاق لا يكسر بقية القائمة؛ وحرج بلا استدعاء lifecycle
  {
    const seen = [];
    const r = await processClosures(
      [{ number: 1, key: 'a' }, { number: 2, key: 'b' }, { number: 3, key: 'site-down' }],
      { resolveLifecycle: async (k, n) => { seen.push(`${k}#${n}`); return 'resolved'; }, closeIssue: async (n) => { if (n === 1) throw new Error('gh down'); return true; } },
    );
    assert.deepEqual(r.map((x) => x.closed), [false, true, true]);
    assert.deepEqual(seen, ['a#1', 'b#2'], 'الحرج لا يمرّ بالـRPC');
  }

  // عدم اعتبار الغياب/الفشل تعافياً: decideIssuesToClose هي الباب الوحيد؛ لا دليل ⇒ لا قائمة ⇒ لا حلّ
  const issues = [{ number: 5, body: '<!-- health:deploy-failed -->' }, { number: 6, body: '<!-- health:price-generation-failed -->' }];
  assert.deepEqual(decideIssuesToClose({ openIssues: issues, activeKeys: [], healthyKeys: [], verifyKey: undefined }), [], 'غياب النتيجة ليس تعافياً');
  assert.deepEqual(decideIssuesToClose({ openIssues: issues, activeKeys: [], healthyKeys: [], verifyKey: () => false }), [], 'تحقق فاشل/مجهول ليس تعافياً');
  assert.deepEqual(decideIssuesToClose({ openIssues: issues, activeKeys: ['deploy-failed'], healthyKeys: ['deploy-failed'], verifyKey: undefined }), [], 'عطل ما يزال قائماً لا يُغلق');
  assert.deepEqual(decideIssuesToClose({ openIssues: issues, activeKeys: [], healthyKeys: ['deploy-failed'] }).map((x) => x.number), [5], 'يُغلق المفتاح السليم فقط لا غيره');
}

// عقد نصّي: لا Telegram في دورة الحياة، التجديد غير الحرج عبر RPC فقط وبحالة ready، والإغلاق ينتظر
{
  const lifecycleCode = codeOnly.slice(codeOnly.indexOf('export const lifecycleSwitchOff'), codeOnly.indexOf('async function reportProblem'));
  assert.ok(!/notify_telegram|notifyTelegram|telegram_outbox/.test(lifecycleCode), 'عمليات دورة الحياة لا تمرّ بتيليغرام');
  assert.match(lifecycleCode, /rest\/v1\/rpc\/health_lifecycle/);
  const rb = codeOnly.slice(codeOnly.indexOf('async function reportProblem'), codeOnly.indexOf('export function parseWorkflowIncidentKey'));
  assert.match(rb, /isImmediateHealthKey\(problem\.key\)[\s\S]{0,200}getLifecycleMode\(\)\) === "ready"[\s\S]{0,200}callLifecycle\("renew"/, 'التجديد: غير حرج + ready + RPC');
  assert.ok(!/notifyTelegram\(problem, `https:\/\/github\.com\/\$\{REPO\}\/issues\/\$\{existing\.number\}`/.test(rb), 'لا إشعار تيليغرام عند التجديد');
  assert.ok(!/lifecycleSignalsEnabled|sendRecoverySignal|recoverySignalKey|renewalSignalKey/.test(codeOnly), 'لا بقايا مسار الإشارات عبر notify_telegram');
  assert.match(codeOnly, /await closeResolvedIssues\(\{/, 'main ينتظر الإغلاق');
  // وسم الإدارة: يُسجَّل بعد تجديد ناجح وبعد إنشاء Issue في حالة ready فقط، ويُقرأ عند فقدان الأسرار
  assert.match(codeOnly, /else markManaged\(existing\.number\)/, 'وسم بعد تجديد ناجح');
  assert.match(codeOnly, /getLifecycleMode\(\)\) === "ready"\) markManaged\(createdNumber\)/, 'وسم عند الإنشاء في ready');
  assert.match(codeOnly, /managed: isManagedIssue/, 'الإغلاق يقرأ وسم الإدارة');
  assert.match(codeOnly, /resolveLifecycle: async \(key, number\) => resolveForClosure\(/, 'الإغلاق يمرّ عبر حلّ الحدث بإقرار');
  // مفتاح الطوارئ يمرّ عبر نقطة واحدة (detectLifecycleMode) لا فحوص متفرقة
  assert.match(codeOnly, /if \(lifecycleSwitchOff\(env\)\) return "off";\s*if \(!env\.SUPABASE_URL \|\| !env\.SUPABASE_SERVICE_KEY\) return "unconfigured";\s*const r = await callLifecycle\("probe"/, 'off ثم unconfigured قبل أي طلب');
}

console.log('check-health-check-logic: OK — مسح بلا قيد فرع وبقائمة سماح، مفاتيح متطابقة، تمييز التعافي، منع تكرار بهوية الحادثة، انهيار المراقب مرئي، وفشل كل قنوات التبليغ يُفشل التشغيل.');
