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
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'health-check.mjs');
const src = await readFile(SCRIPT, 'utf8');
const {
  classifyLatestRun, selectRecentFailures, decideIssuesToClose,
  parseWorkflowIncidentKey, isIncidentConclusion, NON_INCIDENT_CONCLUSIONS,
} = await import(SCRIPT);

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
assert.match(verifyBlock, /return !isIncidentConclusion\(lastCompleted\.conclusion\)/, 'التحقق يجب أن يشترط نتيجة غير حادثة.');
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

console.log('check-health-check-logic: OK — مسح بلا قيد فرع وبقائمة سماح، مفاتيح متطابقة، ولا إغلاق حادثة بلا نجاح مرصود.');
