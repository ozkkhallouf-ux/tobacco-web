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
const { classifyLatestRun, selectRecentFailures, decideIssuesToClose } = await import(SCRIPT);

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
const runs = [
  { workflowName: 'فحص المشروع', headBranch: 'feat/x', url: 'u1', createdAt: iso(5), displayTitle: 'PR #999' },
  { workflowName: 'Decision Engine Check', headBranch: 'feat/y', url: 'u2', createdAt: iso(10), displayTitle: 'PR #998' },
  { workflowName: 'Codex Review Gate', headBranch: 'feat/z', url: 'u3', createdAt: iso(2), displayTitle: 'مستثنى' },
  { workflowName: 'فحص المشروع', headBranch: 'feat/old', url: 'u4', createdAt: iso(500), displayTitle: 'قديم' },
];
const found = selectRecentFailures(runs, now - 40 * 60000);
assert.equal(found.length, 2, 'يجب رصد الفشلين الحديثين على فرعَي الـPR فقط.');
assert.ok(found.some((p) => p.key === 'workflow-failure-فحص المشروع@feat/x'), 'مفتاح الحادثة يجب أن يشمل الفرع.');
assert.ok(!found.some((p) => p.workflowName === 'Codex Review Gate'), 'Codex Review Gate يجب أن يبقى مستثنى.');
assert.ok(!found.some((p) => p.details.includes('قديم')), 'ما خرج عن نافذة المراقبة يجب أن يُستبعد.');

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
  { number: 13, body: '<!-- health:site-unreachable -->' },
  { number: 14, body: 'بلا علامة' },
];

// حالة الانقطاع: لا مشاكل مرصودة ولا أدلة سلامة (استعلام GitHub فشل).
assert.deepEqual(
  decideIssuesToClose({ openIssues, activeKeys: new Set(), healthyKeys: new Set(), healthyPrefixes: [] }),
  [],
  'عودة الثغرة P1-B: لا يجوز إغلاق أي حادثة لمجرد أن الفحص لم يرصد شيئاً.',
);

// دليل إيجابي على واحدة فقط → تُغلق وحدها.
assert.deepEqual(
  decideIssuesToClose({
    openIssues, activeKeys: new Set(), healthyKeys: new Set(['site-unreachable']), healthyPrefixes: [],
  }),
  [{ number: 13, key: 'site-unreachable' }],
  'تُغلق الحادثة ذات الدليل الإيجابي وحدها.',
);

// مسح ناجح لم يجد الحادثة → دليل كافٍ لإغلاق workflow-failure-* فقط.
assert.deepEqual(
  decideIssuesToClose({
    openIssues, activeKeys: new Set(), healthyKeys: new Set(), healthyPrefixes: ['workflow-failure-'],
  }),
  [{ number: 12, key: 'workflow-failure-فحص المشروع@feat/x' }],
  'المسح الناجح يُغلق حوادث التشغيلات الفاشلة وحدها، لا حوادث النشر أو الموقع.',
);

// حادثة ما تزال نشطة لا تُغلق ولو ورد لها دليل سلامة متناقض.
assert.deepEqual(
  decideIssuesToClose({
    openIssues,
    activeKeys: new Set(['deploy-failed']),
    healthyKeys: new Set(['deploy-failed']),
    healthyPrefixes: [],
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

console.log('check-health-check-logic: OK — لا قيد فرع على المسح العام، ولا إغلاق حادثة بلا دليل إيجابي.');
