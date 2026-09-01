import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  evaluateCodexReview,
  reconcileCanonicalCheckRuns,
  buildCanonicalCheckRunPayload,
  runGeneration,
  isStaleWrite,
  isStaleHead,
  needsWriteReconciliation,
  isAncestorWithMergesOnly,
} from './codex-review-gate-logic.mjs';

// Contract + regression checks for .github/workflows/codex-review-gate.yml —
// إصلاح 2026-08-31 لثغرة إعادة ربط commit_id تلقائياً بعد rebase (اكتُشفت بعد دمج PR
// #139: الـGate مرّ PASS بالاعتماد على تعليق مراجعة قديم "بدا" وكأنه على HEAD الدمج، فقط
// لأن GitHub أعاد ربط commit_id بالـcommit الجديد لأن سطر الكود لم يتغيّر).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yamlPath = path.join(repoRoot, '.github', 'workflows', 'codex-review-gate.yml');
const yml = await readFile(yamlPath, 'utf8');

// 1) فحص العقد الثابت على نص الـworkflow نفسه: مطابقة pulls/comments يجب أن تعتمد على
//    original_commit_id (الحقل الثابت أبداً)، ويُمنع تماماً استخدام commit_id القابل
//    لإعادة الربط التلقائي لهذا الغرض تحديداً — حتى لا يعود أحد لاستخدامه سهواً مستقبلاً.
assert.match(
  yml,
  /REVIEW_COMMENT_COUNT=\$\(echo "\$COMMENTS_JSON" \| jq[\s\S]{0,200}\.original_commit_id == \$sha/,
  'REVIEW_COMMENT_COUNT يجب أن يطابق original_commit_id (الحقل الثابت)، لا commit_id',
);
assert.doesNotMatch(
  yml,
  /REVIEW_COMMENT_COUNT=\$\(echo "\$COMMENTS_JSON" \| jq --arg sha "\$HEAD_SHA" --arg bot "\$CODEX_BOT_LOGIN" \\\s*\n\s*'\[\.\[\] \| select\(\.user\.login == \$bot and \.commit_id == \$sha\)\]/,
  'REVIEW_COMMENT_COUNT يجب ألا يستخدم .commit_id — هذا بالضبط الثغرة التي أُصلحت في PR #139 اللاحق',
);

// formal reviews (pulls/reviews) تبقى تُطابَق عبر commit_id عمداً — حقل ثابت عند الإرسال،
// غير مرتبط بسطر كود متحرك، فلا ثغرة إعادة ربط هناك.
assert.match(
  yml,
  /FORMAL_REVIEW_COUNT=\$\(echo "\$REVIEWS_JSON" \| jq[\s\S]{0,200}\.commit_id == \$sha/,
  'FORMAL_REVIEW_COUNT يجب أن يبقى يطابق commit_id على pulls/reviews (حقل ثابت هناك، لا ثغرة)',
);

// 2) فحص المنطق فعلياً عبر السيناريوهين المطلوبين، باستخدام إعادة التطبيق المرجعية
//    في codex-review-gate-logic.mjs (الموثَّقة بأنها تطابق منطق الـjq في الـworkflow حرفياً).
const BOT = 'chatgpt-codex-connector[bot]';
const OLD_SHA = 'a'.repeat(40); // الـcommit الأصلي الذي راجعه Codex أولاً
const NEW_SHA = 'b'.repeat(40); // الـHEAD بعد rebase/merge لاحق لم يغيّر سطر الكود المراجَع

// سيناريو (أ): مراجعة قديمة + rebase بدون تغيير السطر ⇒ يجب أن تفشل الـGate.
// نحاكي هنا بالضبط ما رصدناه حياً بعد دمج PR #139: GitHub أعاد ربط commit_id بالـHEAD
// الجديد تلقائياً (لأن السطر لم يتغيّر)، لكن original_commit_id ظل يشير للـcommit الأصلي
// القديم فعلياً، وتعليق "Reviewed commit" النصي (إن وُجد) ما زال يذكر الـsha القديم فقط.
const staleReviewResult = evaluateCodexReview({
  headSha: NEW_SHA,
  botLogin: BOT,
  formalReviews: [],
  reviewComments: [
    {
      user: { login: BOT },
      original_commit_id: OLD_SHA, // ثابت — لم يتغيّر رغم إعادة الربط أدناه
      commit_id: NEW_SHA, // GitHub أعاد ربطه تلقائياً — هذه بالضبط الثغرة المُغلَقة
      body: '### مراجعة Codex\n![badge](https://img.shields.io/badge/P1-orange)',
    },
  ],
  issueComments: [
    {
      user: { login: BOT },
      body: `**Reviewed commit:** \`${OLD_SHA.slice(0, 10)}\``, // يذكر الـsha القديم فقط
    },
  ],
});
assert.equal(
  staleReviewResult.conclusion,
  'failure',
  'مراجعة قديمة + rebase بدون تغيير السطر يجب أن تُنتج FAIL — commit_id المُعاد ربطه لا يكفي',
);
assert.equal(staleReviewResult.reviewCommentCount, 0, 'يجب ألا تُحتسَب مطابقة عبر commit_id المُعاد ربطه');
assert.equal(staleReviewResult.issueCommentMatch, false, 'تعليق Issue القديم يذكر sha لا يطابق HEAD الجديد');

// سيناريو (ب): مراجعة جديدة فعلية على الـHEAD الحالي ⇒ يجب أن تنجح الـGate.
const freshReviewResult = evaluateCodexReview({
  headSha: NEW_SHA,
  botLogin: BOT,
  formalReviews: [],
  reviewComments: [
    {
      user: { login: BOT },
      original_commit_id: NEW_SHA, // مراجعة أُنشئت فعلياً على الـHEAD الحالي
      commit_id: NEW_SHA,
      body: '### مراجعة Codex\n![badge](https://img.shields.io/badge/P1-orange)',
    },
  ],
  issueComments: [
    {
      user: { login: BOT },
      body: `**Reviewed commit:** \`${NEW_SHA.slice(0, 10)}\``,
    },
  ],
});
assert.equal(freshReviewResult.conclusion, 'success', 'مراجعة جديدة فعلية على HEAD الحالي يجب أن تُنتج PASS');
assert.equal(freshReviewResult.reviewCommentCount, 1, 'يجب احتساب المطابقة عبر original_commit_id');
assert.equal(freshReviewResult.issueCommentMatch, true, 'تعليق Issue الجديد يذكر sha الحالي بوضوح');

// سيناريو إضافي: formal review (pulls/reviews) يبقى يُطابَق عبر commit_id عادي — يجب ألا
// يتأثر بإصلاح original_commit_id (الخاص فقط بـpulls/comments).
const formalReviewResult = evaluateCodexReview({
  headSha: NEW_SHA,
  botLogin: BOT,
  formalReviews: [{ user: { login: BOT }, commit_id: NEW_SHA }],
  reviewComments: [],
  issueComments: [],
});
assert.equal(formalReviewResult.conclusion, 'success', 'formal review بـcommit_id مطابق للـHEAD يجب أن يمر');

// 3) لا كتلة concurrency إطلاقاً — وهذا هو جوهر هذا الإصلاح.
//
//    الخلفية المقيسة (2026-08-31، آخر 100 تشغيل): 32٪ من التشغيلات كانت تُلغى، و90٪ من
//    الإلغاءات المنسوبة كانت على *نفس* الـSHA (رشقة أحداث Codex). الـcheck-run التلقائي
//    للـjob ينتهي عندها بـcancelled، وهو ليس required فلا يمنع الدمج — لكنه يُنزل
//    mergeStateStatus إلى UNSTABLE لأن الحالة تُحسب من كل check-runs على الـcommit.
//
//    يُمنع هنا أي شكل من أشكال العودة: لا `concurrency:` ولا `cancel-in-progress` في
//    الشيفرة الفعلية. تعليقات سجل القرار مسموحة (تُجرَّد قبل الفحص) — وإلا لمنعنا توثيق
//    سبب القرار داخل الملف نفسه.
const ymlCode = yml
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

assert.doesNotMatch(
  ymlCode,
  /^\s*concurrency:/m,
  'يجب ألا تعود كتلة concurrency: إلغاء التشغيلات هو ما كان يُنتج CANCELLED ويلوّث mergeStateStatus',
);
assert.doesNotMatch(
  ymlCode,
  /cancel-in-progress/,
  'يجب ألا يعود cancel-in-progress بأي قيمة — حتى false لا يحمي التشغيل المطرود وهو في الطابور',
);
assert.doesNotMatch(
  ymlCode,
  /^\s*group:\s*codex-review-gate/m,
  'يجب ألا يعود مفتاح concurrency group بأي صيغة، بما فيها المفتاح المرتبط بالـSHA (قِيس أنه يُصلح ~10٪ فقط)',
);

// 3-ب) الصلاحيات تبقى الدنيا. هذا سير عمل pull_request_target — ينفَّذ في سياق المستودع
//      الأساسي بأسراره — فأي ترقية كتابة فيه ثمنها أمني حقيقي. تحديداً: لا contents: write
//      لصناعة قفل يدوي عبر refs. الحماية من السباق منطقية (isStaleWrite/isStaleHead) لا
//      قائمة على قفل.
// المطابقة على الكتلة كاملة حتى السطر الفارغ، لا على بدايتها: تعبير ينتهي بـ$ تحت /m
// يقف عند نهاية السطر، فكان سطر صلاحية مضاف بعده يمرّ بلا التقاط (طفرة مرصودة).
const permissionsBlock = (() => {
  const m = yml.match(/^permissions:\n(?:[ \t]+.*\n)+/m);
  assert.ok(m, 'كتلة permissions مفقودة من الـworkflow');
  return m[0].trimEnd();
})();
assert.equal(
  permissionsBlock,
  'permissions:\n  contents: read\n  pull-requests: read\n  checks: write',
  `كتلة permissions تغيّرت — يجب أن تبقى الدنيا بالضبط بلا زيادة ولا نقصان. وُجد:\n${permissionsBlock}`,
);
assert.doesNotMatch(
  ymlCode,
  /contents:\s*write/,
  'ممنوع contents: write على سير عمل pull_request_target — قرار صريح: لا قفل عبر refs ولا commits قفل آلية',
);
assert.doesNotMatch(
  ymlCode,
  /refs\/gate-lock|gate-lock/,
  'ممنوع أي قفل يدوي عبر refs — الحماية من السباق رتيبة ومنطقية، لا قائمة على mutex مصنوع يدوياً',
);

// 4) فحص العقد الثابت على نص الـworkflow لإصلاح Canonical Check Run (2026-08-31):
//    يبحث كل تشغيل عن check-run موجود على نفس head_sha بالضبط قبل الإنشاء، ولا يوجد أي
//    مسار conclusion=failure عند غياب المراجعة — pending (in_progress) فقط.
assert.match(
  yml,
  /repos\/\$REPO\/commits\/\$HEAD_SHA\/check-runs[\s\S]{0,120}select\(\.name == \$name\)/,
  'يجب البحث عن check-run كانوني موجود على نفس head_sha قبل أي POST جديد (تصفية بـjq لا بـ-f check_name، لتفادي خلل gh api 404 المكتشف حياً)',
);
assert.doesNotMatch(
  yml,
  /-f check_name="\$NAME"/,
  'يُمنع استخدام `-f check_name` هنا — ثبت أنه يُنتج 404 خاطئاً من gh api مع --paginate وقيمة تحوي مسافة (مرصود حياً على PR #146)',
);
assert.doesNotMatch(
  yml,
  /name: Codex Review Gate\s*\n\s*runs-on:/,
  'اسم الـjob يجب ألا يكون حرفياً "Codex Review Gate" — يتصادم مع الـcheck-run الكانوني والـrequired check في الـruleset (مرصود حياً)',
);
assert.match(
  yml,
  /EXISTING_ID=\$\(echo "\$WINNER_JSON" \| jq -r '\.id \/\/ empty'\)/,
  'يجب اختيار الفائز (أحدث generation، لا id فقط) من WINNER_JSON لإعادة استخدامه عبر PATCH',
);
assert.match(
  yml,
  /gh api "repos\/\$REPO\/check-runs\/\$EXISTING_ID" --method PATCH/,
  'وجود check-run سابق على نفس head_sha يجب أن يُحدَّث عبر PATCH لا POST جديد',
);
assert.match(
  yml,
  /STATUS_FIELDS='"status":"in_progress"'/,
  'غياب المراجعة يجب أن يُنتج status=in_progress فقط — بلا conclusion وبلا failure',
);
assert.doesNotMatch(
  yml,
  /"conclusion":"failure"/,
  'يُمنع نهائياً نشر conclusion=failure على check-run الكانوني — هذا بالضبط ما يلوّث rollup إذا نشره تشغيل قديم بعد تشغيل أحدث ناجح',
);

// 4-ب) فحص العقد الثابت لإصلاح جوهري سابع (حارس تشغيل قديم صريح): إعادة قراءة HEAD الحيّ
//    قبل الكتابة، ومقارنة generation المخزَّنة في external_id قبل أي PATCH/POST نهائي.
assert.match(
  yml,
  /generation=\$\{\{\s*github\.run_id\s*\}\}\.\$\{\{\s*github\.run_attempt\s*\}\}/,
  'يجب التقاط generation = github.run_id.github.run_attempt عند بداية التشغيل',
);
assert.match(
  yml,
  /LIVE_HEAD_SHA=\$\(gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER" --jq '\.head\.sha'\)/,
  'يجب إعادة قراءة head.sha الحيّ للـPR مباشرة قبل أي كتابة نهائية على check-run الكانوني',
);
assert.match(
  yml,
  /if \[ "\$LIVE_HEAD_SHA" != "\$HEAD_SHA" \][\s\S]{0,400}exit 0/,
  'إن تغيّر HEAD أثناء هذا التشغيل تحديداً، يجب الخروج بلا أي كتابة (exit 0)، لا فشل ولا كتابة',
);
assert.match(
  yml,
  /EXISTING_GENERATION=\$\(echo "\$WINNER_JSON" \| jq -r '\.external_id \/\/ empty'\)/,
  'يجب قراءة external_id للفائز (WINNER_JSON) كـgeneration مُسجَّلة',
);
assert.match(
  yml,
  /IS_STALE=1[\s\S]{0,400}exit 0/,
  'يجب وجود حارس تشغيل قديم صريح (IS_STALE) يخرج بلا كتابة (exit 0) دون الاعتماد على ترتيب وصول الأحداث',
);
assert.match(
  yml,
  /external_id:\s*\$generation/,
  'كل PATCH/POST نهائي يجب أن يثبّت generation الحالية في external_id (تراكمية عبر التشغيلات اللاحقة)',
);

// 5) فحص منطق اختيار/بناء check-run الكانوني فعلياً — سيناريوهات (أ)-(ز) المطلوبة.
const SHA_OLD = 'c'.repeat(40); // HEAD قديم راجعه Codex سابقاً
const SHA_NEW = 'd'.repeat(40); // HEAD جديد بعد push لاحق — لم يُراجَع بعد

// (أ) فتح PR بلا مراجعة ⇒ BLOCKED / check in_progress (لا check-run موجود بعد لهذا الـsha).
const openedNoReview = evaluateCodexReview({ headSha: SHA_NEW });
assert.equal(openedNoReview.conclusion, 'failure', 'فتح PR بلا مراجعة: evaluateCodexReview لا يزال يُرجع failure منطقياً (تصنيف داخلي)');
const openedPayload = buildCanonicalCheckRunPayload({
  headSha: SHA_NEW,
  reviewedCount: openedNoReview.reviewedCount,
  summary: openedNoReview.summary,
  generation: runGeneration({ runId: 1000, runAttempt: 1 }),
});
assert.equal(openedPayload.payload.status, 'in_progress', 'فتح PR بلا مراجعة ⇒ check-run الكانوني in_progress (pending)، لا failure');
assert.equal(openedPayload.payload.conclusion, undefined, 'in_progress يجب ألا يحمل حقل conclusion إطلاقاً');
assert.equal(openedPayload.method, 'POST', 'أول تشغيل لهذا الـsha ⇒ إنشاء (POST) لا تحديث');

// (ب) review قديم على HEAD سابق (SHA_OLD) ثم push جديد (SHA_NEW) ⇒ لا يُعاد استخدام
//     check-run الـSHA_OLD الناجح؛ يُنشأ كانوني جديد بحالة in_progress للـsha الجديد.
const runsAfterOldReview = [
  { id: 1, name: 'Codex Review Gate', head_sha: SHA_OLD, external_id: runGeneration({ runId: 100, runAttempt: 1 }) },
];
const reconcileForNewSha = reconcileCanonicalCheckRuns({ checkRuns: runsAfterOldReview, headSha: SHA_NEW });
assert.equal(reconcileForNewSha.winnerId, null, 'push جديد (sha مختلف) يجب ألا يجد أي check-run كانوني قابل لإعادة الاستخدام حتى لو كان القديم success');
assert.deepEqual(reconcileForNewSha.duplicateIds, [], 'لا نسخ مكررة إن لم يوجد أي check-run على الـsha الجديد أصلاً');

// (ج) rebase بدون تغيير الأسطر + review قديم (original_commit_id لا يطابق) ⇒ BLOCKED.
//     مغطى فعلياً بسيناريو staleReviewResult أعلاه (conclusion=failure ⇒ reviewedCount=0
//     ⇒ buildCanonicalCheckRunPayload يُنتج in_progress، ليس success).
const stalePayload = buildCanonicalCheckRunPayload({
  headSha: NEW_SHA,
  reviewedCount: staleReviewResult.reviewedCount,
  summary: staleReviewResult.summary,
  generation: runGeneration({ runId: 1000, runAttempt: 1 }),
});
assert.equal(stalePayload.payload.status, 'in_progress', 'rebase بدون تغيير الأسطر + review قديم ⇒ in_progress (BLOCKED)، ليس success');

// (د) review صريح على HEAD الحالي ⇒ PASS (completed/success).
const freshPayload = buildCanonicalCheckRunPayload({
  headSha: NEW_SHA,
  reviewedCount: freshReviewResult.reviewedCount,
  summary: freshReviewResult.summary,
  generation: runGeneration({ runId: 1001, runAttempt: 1 }),
});
assert.equal(freshPayload.payload.status, 'completed', 'مراجعة صريحة على HEAD الحالي ⇒ completed');
assert.equal(freshPayload.payload.conclusion, 'success', 'مراجعة صريحة على HEAD الحالي ⇒ conclusion=success');

// (هـ) pull_request_target ثم review مباشرة على نفس HEAD ⇒ لا يوجد failure قديم يلوّث
//      rollup: التشغيل الأول ينشئ check-run in_progress (id=10)؛ التشغيل الثاني (بعد وصول
//      المراجعة) يجب أن يجد نفس الـid ويحدّثه (PATCH)، لا ينشئ ثانياً.
const runsAfterFirstOpen = [
  { id: 10, name: 'Codex Review Gate', head_sha: NEW_SHA, external_id: runGeneration({ runId: 100, runAttempt: 1 }) },
];
const reconcileOnReviewArrival = reconcileCanonicalCheckRuns({ checkRuns: runsAfterFirstOpen, headSha: NEW_SHA });
const idOnReviewArrival = reconcileOnReviewArrival.winnerId;
assert.equal(idOnReviewArrival, 10, 'وصول المراجعة على نفس HEAD الذي فُتح عليه check-run in_progress سابقاً يجب أن يُعيد استخدام نفس الـid');
assert.deepEqual(reconcileOnReviewArrival.duplicateIds, [], 'نسخة وحيدة ⇒ لا نسخ مكررة للتوحيد');
const secondPayload = buildCanonicalCheckRunPayload({
  headSha: NEW_SHA,
  reviewedCount: 1,
  summary: 'reviewed',
  existingId: idOnReviewArrival,
  generation: runGeneration({ runId: 1002, runAttempt: 1 }),
});
assert.equal(secondPayload.method, 'PATCH', 'يجب PATCH لنفس id الموجود، لا POST جديد بنفس الاسم على نفس sha');
assert.equal(secondPayload.url, 'check-runs/10', 'PATCH يجب أن يستهدف نفس id الموجود بالضبط');
assert.equal(secondPayload.payload.head_sha, undefined, 'PATCH لا يعيد إرسال head_sha إطلاقاً — id وحده يحدد الهدف');

// (و) عدة triggers لنفس HEAD (تراكم قديم افتراضي من قبل هذا الإصلاح) ⇒ يوجد canonical
//     نهائي واحد فقط: يُختار الفائز بالـgeneration (external_id) لا بالـid — id الأكبر لا
//     يضمن أنه الأحدث فعلياً (إصلاح جوهري عاشر). البقية تُصنَّف نسخاً مكررة للتوحيد.
const multipleRunsSameSha = [
  { id: 5, name: 'Codex Review Gate', head_sha: NEW_SHA, external_id: runGeneration({ runId: 200, runAttempt: 1 }) },
  { id: 20, name: 'Codex Review Gate', head_sha: NEW_SHA, external_id: runGeneration({ runId: 100, runAttempt: 1 }) }, // id أكبر لكن generation أقدم
  { id: 12, name: 'Codex Review Gate', head_sha: NEW_SHA, external_id: runGeneration({ runId: 300, runAttempt: 1 }) }, // الفائز الفعلي
];
const reconcileMultiple = reconcileCanonicalCheckRuns({ checkRuns: multipleRunsSameSha, headSha: NEW_SHA });
assert.equal(
  reconcileMultiple.winnerId,
  12,
  'عدة check-runs على نفس sha ⇒ يُختار الفائز بأحدث generation (300.1)، وليس id الأكبر (20 بـgeneration أقدم)',
);
assert.deepEqual(
  reconcileMultiple.duplicateIds.sort((a, b) => a - b),
  [5, 20],
  'كل النسخ عدا الفائز تُصنَّف نسخاً مكررة يجب توحيدها',
);

// (ز) push جديد بعد PASS ⇒ HEAD الجديد يرجع BLOCKED (in_progress) حتى تُراجَع تحديداً،
//     رغم أن الـsha السابق كان success — مغطى فعلياً بسيناريو (ب) أعلاه (reconcileForNewSha).
assert.equal(
  buildCanonicalCheckRunPayload({
    headSha: SHA_NEW,
    reviewedCount: 0,
    summary: 'pending',
    generation: runGeneration({ runId: 1003, runAttempt: 1 }),
  }).payload.status,
  'in_progress',
  'push جديد بعد PASS سابق ⇒ الـsha الجديد يبدأ in_progress (BLOCKED) من جديد، لا يرث success القديم',
);

// 6) إصلاح جوهري سابع بتاريخ 2026-08-31 — الحارس الصريح: 4 سيناريوهات regression مطلوبة
//    صراحة من المستخدم (race condition رصدها Codex كـP1 حي على PR #146).

// (ح) pull_request_target وreview يصلان معاً على نفس HEAD ⇒ النتيجة النهائية الصحيحة لا
//     تتراجع: تشغيل target يبدأ أولاً (generation أقدم، لا مراجعة بعد) وينشئ in_progress؛
//     تشغيل review يصل بعده مباشرة (generation أحدث، وجد مراجعة) ويكتب success. النتيجة
//     النهائية success — بصرف النظر عن كونهما "معاً" لأن الحارس يعتمد على generation لا
//     على التوقيت.
{
  const genTarget = runGeneration({ runId: 2000, runAttempt: 1 });
  const genReview = runGeneration({ runId: 2001, runAttempt: 1 });
  // تشغيل target يكتب أولاً — لا يوجد generation مسجّلة بعد ⇒ ليس قديماً.
  assert.equal(isStaleWrite({ existingGeneration: null, candidateGeneration: genTarget }), false, 'أول كتابة على الإطلاق ليست قديمة أبداً');
  // تشغيل review يكتب بعده — target قد سجّل generation أقدم من review ⇒ ليس قديماً، يُسمح له بالكتابة.
  assert.equal(
    isStaleWrite({ existingGeneration: genTarget, candidateGeneration: genReview }),
    false,
    'تشغيل review (generation أحدث) يجب أن يُسمح له بالكتابة فوق target (generation أقدم)',
  );
}

// (ط) run قديم يتأخر وينتهي بعد run أحدث ⇒ لا يستطيع الكتابة فوقه (المطالبة الأساسية
//     لهذا الإصلاح، مطابقة تماماً لسيناريو السباق الذي رصده Codex كـP1 على PR #146).
{
  const genOld = runGeneration({ runId: 3000, runAttempt: 1 }); // بدأ أولاً، لكنه بطيء
  const genNew = runGeneration({ runId: 3001, runAttempt: 1 }); // بدأ لاحقاً، لكنه أسرع فكتب أولاً
  // الأحدث (genNew) يكتب أولاً ويسجّل generation ـه.
  assert.equal(isStaleWrite({ existingGeneration: null, candidateGeneration: genNew }), false, 'التشغيل الأحدث يكتب أولاً بلا عائق');
  // الأقدم (genOld) يصل متأخراً بعد ذلك، existingGeneration الآن genNew (أحدث من candidateGeneration=genOld).
  assert.equal(
    isStaleWrite({ existingGeneration: genNew, candidateGeneration: genOld }),
    true,
    'run قديم (generation أقدم) يتأخر وينتهي بعد run أحدث ⇒ يُمنع من الكتابة فوقه — هذا بالضبط الـP1 المُصلَح',
  );
}

// (ي) push جديد يغيّر HEAD ⇒ أي run قديم للـHEAD السابق لا يلمس check الـHEAD الجديد.
{
  const capturedHeadSha = SHA_OLD;
  const liveHeadSha = SHA_NEW; // push وصل أثناء تنفيذ التشغيل القديم فتغيّر HEAD الحيّ للـPR
  assert.equal(
    isStaleHead({ capturedHeadSha, liveHeadSha }),
    true,
    'HEAD تغيّر أثناء تنفيذ هذا التشغيل تحديداً ⇒ يجب اعتباره stale head، فيمتنع عن الكتابة',
  );
  assert.equal(
    isStaleHead({ capturedHeadSha: SHA_NEW, liveHeadSha: SHA_NEW }),
    false,
    'HEAD لم يتغيّر ⇒ ليس stale head، يُسمح بالكتابة',
  );
}

// (ك) عدة triggers لنفس HEAD ⇒ يبقى check-run واحد canonical والنتيجة monotonic: سلسلة من
//     4 تشغيلات (target, review_comment ×2, issue_comment) تصل بترتيب اكتمال عشوائي (وليس
//     ترتيب بدء)، ويجب أن تستقر النتيجة النهائية عند أحدث generation فقط دون أي تراجع
//     مؤقت في المنتصف يُنشر فعلياً (كل كتابة تُحكَّم بـisStaleWrite قبلها).
{
  const generations = [
    runGeneration({ runId: 4000, runAttempt: 1 }), // target — أقدم
    runGeneration({ runId: 4003, runAttempt: 1 }), // issue_comment — الأحدث فعلياً
    runGeneration({ runId: 4001, runAttempt: 1 }), // review_comment #1
    runGeneration({ runId: 4002, runAttempt: 1 }), // review_comment #2
  ];
  // نحاكي وصول الكتابات بهذا الترتيب العشوائي بالضبط، ونطبّق الحارس قبل كل كتابة.
  let currentGeneration = null; // generation آخر كتابة نجحت فعلياً
  let writesApplied = 0;
  for (const candidate of generations) {
    if (isStaleWrite({ existingGeneration: currentGeneration, candidateGeneration: candidate })) continue;
    currentGeneration = candidate;
    writesApplied += 1;
  }
  // العشوائية في ترتيب الاكتمال تعني أن ليست كل كتابة تُطبَّق (2 و3 أقدم من max سبقهما 4003)،
  // لكن النتيجة النهائية يجب أن تستقر عند أحدث generation دائماً — monotonic بامتياز.
  assert.equal(currentGeneration, runGeneration({ runId: 4003, runAttempt: 1 }), 'عدة triggers لنفس HEAD ⇒ النتيجة النهائية يجب أن تستقر عند أحدث generation دائماً، بصرف النظر عن ترتيب الاكتمال');
  assert.ok(writesApplied >= 1 && writesApplied <= generations.length, 'يجب أن يُطبَّق check-run كانوني واحد نهائي فقط يعكس أحدث generation');
}

// 7) إصلاح جوهري عاشر بتاريخ 2026-09-01 — إعادة تصميم event-driven (تُلغي وتستبدل حلقة
//    المصالحة الزمنية للإصلاحين الثامن والتاسع): فحص العقد الثابت على نص الـworkflow يثبت
//    أن المصالحة بعد الكتابة صارت فحصاً واحداً فقط (GET واحد) بلا حلقة وبلا sleep، وأن
//    توحيد النسخ المكررة صار مروراً واحداً فقط (بلا حلقة) مباشرة بعد الكتابة.
assert.match(
  yml,
  /OBSERVED_GENERATION=\$\(gh api "repos\/\$REPO\/check-runs\/\$CHECK_RUN_ID" --jq '\.external_id \/\/ empty'\)/,
  'يجب وجود فحص GET واحد بعد الكتابة يعيد قراءة external_id فوراً من نفس check-run الذي كُتب عليه للتو',
);
assert.match(
  yml,
  /OBS_IS_OLDER=1[\s\S]{0,600}--method PATCH --input -/,
  'عند رصد كتابة أقدم مستقرة فعلياً بعد كتابتنا، يجب إعادة نفس PATCH مرة واحدة فقط لاستعادة النتيجة الصحيحة (self-heal)',
);
// ⚠️ إصلاح جوهري عاشر (بتكليف صريح من المستخدم 2026-09-01): يُمنع نهائياً أي عودة لحلقة
//    مصالحة زمنية (sleep/polling/نافذة محاولات) — الأمان الرتيب يأتي من isStaleWrite +
//    isStaleHead، لا من مراقبة نافذة زمنية أطول. تصحيح كتابة متأخرة يحصل عند أول تشغيل
//    لاحق غير قديم فقط، لا "حتماً فوراً" داخل نفس التشغيل.
assert.doesNotMatch(
  yml,
  /RECONCILE_MAX_ATTEMPTS|RECONCILE_SLEEP_SECONDS|RECONCILE_ATTEMPT=0/,
  'يُمنع عودة أي متغيرات حلقة مصالحة زمنية (RECONCILE_MAX_ATTEMPTS/RECONCILE_SLEEP_SECONDS/RECONCILE_ATTEMPT) — التصميم event-driven الآن، فحص واحد بلا حلقة',
);
assert.doesNotMatch(
  yml,
  /^\s*sleep\s/m,
  'يُمنع استخدام sleep بأي صورة في هذا الـworkflow — لا انتظار زمني إطلاقاً بعد إعادة التصميم event-driven',
);
// ملاحظة: `while IFS= read -r ...` قائم فعلاً في السكربت (مرور واحد لا حلقة عبر قائمة
// أسطر ثابتة الطول — SHORT_SHA وDUP_ID) وهو أمر مشروع تماماً؛ الممنوع هو حلقة *زمنية*
// (retry بفواصل sleep)، لا أي "while" بأي صورة — لذلك لا فحص عام يمنع "while" هنا.

// 8) إصلاح جوهري عاشر بتاريخ 2026-09-01 — توحيد النسخ المكررة بمرور واحد بلا حلقة (يخلف
//    الإصلاح التاسع الذي كان يكرر التوحيد كل دورة من حلقة زمنية): مسح واحد لكل check-runs
//    الحاملة نفس الاسم على نفس head_sha *قبل* الكتابة (ALL_NAMED_RUNS_JSON)، اختيار الفائز
//    بالـgeneration (لا بالـid) عبر WINNER_JSON، ثم بعد كتابتنا نحن — توحيد كل نسخة مكررة
//    (DUPLICATE_IDS، مستثنياً CHECK_RUN_ID الذي كتبناه للتو) بـPATCH واحد لكل منها بنتيجتنا
//    نحن حصراً (PAYLOAD المحسوب فعلياً من REVIEWED_COUNT هذا التشغيل) — لا حلقة، لا نسخة
//    مكررة أخرى تُقرأ نتيجتها، فلا حالة غير مؤكدة تتحول success عبر هذه الآلية أبداً.
assert.match(
  yml,
  /ALL_NAMED_RUNS_JSON=\$\(gh api "repos\/\$REPO\/commits\/\$HEAD_SHA\/check-runs" --paginate[\s\S]{0,250}select\(\.name == \$name\)/,
  'يجب مسح كل check-runs الحاملة اسم "Codex Review Gate" على نفس head_sha مرة واحدة قبل الكتابة لخدمة اختيار الفائز وكشف النسخ المكررة معاً',
);
assert.match(
  yml,
  /WINNER_JSON=\$\(echo "\$ALL_NAMED_RUNS_JSON" \| jq '[\s\S]{0,300}sort_by\(gen_key\(\.external_id\), \.id\) \| last/,
  'يجب تحديد الفائز بأحدث generation (لا id فقط) بين كل النسخ الحاملة نفس الاسم على نفس head_sha',
);
assert.match(
  yml,
  /DUPLICATE_IDS=\$\(echo "\$ALL_NAMED_RUNS_JSON" \| jq -r --arg self "\$CHECK_RUN_ID"[\s\S]{0,300}\(\.id\|tostring\) != \$self[\s\S]{0,600}--method PATCH --input -/,
  'يجب توحيد (PATCH مرة واحدة لكل نسخة، بلا حلقة زمنية) كل نسخة مكررة عدا ما كتبناه نحن للتو، بنتيجتنا نحن حصراً',
);
assert.doesNotMatch(
  yml,
  /RECONCILE_ATTEMPT/,
  'توحيد النسخ المكررة يجب ألا يتكرر داخل حلقة محاولات — مرة واحدة فقط بعد كل كتابة',
);

// سيناريو (ل): كتابة أحدث generation تلتها كتابة متأخرة من تشغيل أقدم (رصدتها المصالحة
//    عبر GET فوري) ⇒ يجب أن تُطلب مصالحة (إعادة PATCH). العكس (لا كتابة أقدم استقرت، أو
//    استقرت نفس الكتابة، أو حتى أحدث منها شرعياً) ⇒ لا حاجة لمصالحة.
{
  const genOlder = runGeneration({ runId: 5000, runAttempt: 1 });
  const genWritten = runGeneration({ runId: 5001, runAttempt: 1 }); // ما كتبه هذا التشغيل تحديداً
  const genEvenNewer = runGeneration({ runId: 5002, runAttempt: 1 });

  assert.equal(
    needsWriteReconciliation({ writtenGeneration: genWritten, observedGeneration: genOlder }),
    true,
    'كتابة متأخرة من تشغيل أقدم استقرت فعلياً بعد كتابتنا ⇒ يجب طلب مصالحة (إعادة كتابة النتيجة الصحيحة)',
  );
  assert.equal(
    needsWriteReconciliation({ writtenGeneration: genWritten, observedGeneration: genWritten }),
    false,
    'ما استقر يطابق ما كتبناه بالضبط ⇒ لا حاجة لمصالحة',
  );
  assert.equal(
    needsWriteReconciliation({ writtenGeneration: genWritten, observedGeneration: genEvenNewer }),
    false,
    'ما استقر أحدث شرعاً مما كتبناه (تشغيل آخر أحدث كتب بعدنا بحق) ⇒ لا مصالحة، هذا صحيح ومتوقَّع',
  );
  assert.equal(
    needsWriteReconciliation({ writtenGeneration: genWritten, observedGeneration: null }),
    false,
    'فشل GET أو غياب قيمة ملحوظة ⇒ لا مصالحة قسرية بلا دليل واضح',
  );
}

// ---------------------------------------------------------------------------
// 9) جدول ترتيب صريح — بديل concurrency.
//
//    بعد إزالة concurrency صارت التشغيلات المتوازية ممكنة فعلاً: قِيس أن 17 من 79 زوجاً
//    متتالياً لنفس الفرع (22٪) ستتداخل زمنياً (متوسط التشغيل 65 ثانية). الضامن الوحيد
//    لعدم التراجع هو الحراس الرتيبة، فتُختبر هنا كجدول ترتيب لا كحالات متفرقة.
//
//    العمود الحاسم هو الأخير: هل يُسمح للكاتب بالكتابة؟ ولا يعتمد أيٌّ من ذلك على ترتيب
//    الاكتمال — generation تُخصَّص وقت *إنشاء* التشغيل، فترتيبها ثابت مهما تأخر أحدهما.
const ORDERING_TABLE = [
  // A يبدأ → B يبدأ → B يكتب → A ينتهي  ⇒  A ممنوع (المطالبة الصريحة)
  { name: 'A يبدأ · B يبدأ · B يكتب · A ينتهي ⇒ A لا يكتب',
    existing: { runId: 5001, runAttempt: 1 }, candidate: { runId: 5000, runAttempt: 1 }, stale: true },
  // نفس الترتيب بالعكس: B هو الكاتب الأحدث فوق نتيجة A الأقدم ⇒ مسموح
  { name: 'A كتب أولاً · B أحدث يكتب فوقه ⇒ B يكتب',
    existing: { runId: 5000, runAttempt: 1 }, candidate: { runId: 5001, runAttempt: 1 }, stale: false },
  // أول كتابة على الإطلاق — لا شيء مسجَّل
  { name: 'لا نتيجة مسجَّلة ⇒ الكاتب يكتب',
    existing: null, candidate: { runId: 5000, runAttempt: 1 }, stale: false },
  // نفس التشغيل يُعاد تشغيله (attempt أعلى) ⇒ الأحدث يكتب
  { name: 'إعادة تشغيل نفس الـrun (attempt أعلى) ⇒ يكتب',
    existing: { runId: 5000, runAttempt: 1 }, candidate: { runId: 5000, runAttempt: 2 }, stale: false },
  // محاولة أقدم من نفس التشغيل تصل متأخرة ⇒ ممنوعة
  { name: 'attempt أقدم من نفس الـrun يصل متأخراً ⇒ لا يكتب',
    existing: { runId: 5000, runAttempt: 2 }, candidate: { runId: 5000, runAttempt: 1 }, stale: true },
  // نفس الـgeneration بالضبط — كتابة مكرّرة من نفس التشغيل ⇒ تُمنع (لا فائدة، وتفتح نافذة دهس)
  { name: 'نفس الـgeneration بالضبط ⇒ لا يكتب (كتابة مكرّرة)',
    existing: { runId: 5000, runAttempt: 1 }, candidate: { runId: 5000, runAttempt: 1 }, stale: true },
];

for (const row of ORDERING_TABLE) {
  const existingGeneration = row.existing ? runGeneration(row.existing) : null;
  const candidateGeneration = runGeneration(row.candidate);
  assert.equal(
    isStaleWrite({ existingGeneration, candidateGeneration }),
    row.stale,
    `جدول الترتيب — ${row.name} (existing=${existingGeneration} candidate=${candidateGeneration})`,
  );
}
assert.ok(ORDERING_TABLE.length >= 6, `جدول الترتيب ${ORDERING_TABLE.length} صفوف — حُذف صف؟`);

// 9-ب) حارس HEAD مستقل تماماً عن الترتيب: تشغيل بدأ على HEAD قديم ممنوع من الكتابة على
//      الـcommit الجديد مهما كانت generation ـه — حتى لو كان الأحدث.
{
  const OLD = 'a'.repeat(40);
  const NEW = 'b'.repeat(40);
  assert.equal(isStaleHead({ capturedHeadSha: OLD, liveHeadSha: NEW }), true,
    'HEAD تغيّر أثناء التشغيل ⇒ ممنوع من الكتابة، بصرف النظر عن generation');
  assert.equal(isStaleHead({ capturedHeadSha: NEW, liveHeadSha: NEW }), false,
    'HEAD لم يتغيّر ⇒ مسموح');
  // الحارسان مستقلان: generation أحدث لا تُلغي حارس HEAD
  const genNewest = runGeneration({ runId: 9999, runAttempt: 9 });
  assert.equal(isStaleWrite({ existingGeneration: null, candidateGeneration: genNewest }), false,
    'generation أحدث تمرّ من حارس الكتابة…');
  assert.equal(isStaleHead({ capturedHeadSha: OLD, liveHeadSha: NEW }), true,
    '…لكن حارس HEAD يمنعها رغم ذلك — الحارسان تراكميان لا بديلان');
}

// فحص العقد الثابت على الـworkflow: يجب وجود الـancestor-merge-only fallback.
assert.match(
  yml,
  /gh api "repos\/\$REPO\/compare\/\$\{SHORT_SHA_LC\}/,
  'يجب وجود استدعاء compare endpoint لفحص سلفية الـsha المراجَع مقارنة بالـHEAD الحالي',
);
assert.match(
  yml,
  /select\(\(\.parents \| length\) < 2\)/,
  'يجب حساب عدد commits غير الدمج (parents < 2) للتحقق من أن الفارق merge-only',
);
assert.match(
  yml,
  /CMP_STATUS.*=.*"ahead".*&&.*NON_MERGE.*-eq.*0|CMP_STATUS.*=.*ahead.*NON_MERGE.*-eq.*0/,
  'يجب اشتراط status=ahead وNON_MERGE=0 معاً للقبول بالسلفية كمراجعة صالحة',
);

// اختبارات isAncestorWithMergesOnly — 4 سيناريوهات:
assert.equal(
  isAncestorWithMergesOnly({ compareStatus: 'ahead', nonMergeCount: 0 }),
  true,
  'سلف مع merge commits فحسب ⇒ المراجعة صالحة (النموذج: PR #168)',
);
assert.equal(
  isAncestorWithMergesOnly({ compareStatus: 'ahead', nonMergeCount: 1 }),
  false,
  'وجود commit كود غير دمج بعد المراجعة ⇒ المراجعة غير صالحة',
);
assert.equal(
  isAncestorWithMergesOnly({ compareStatus: 'diverged', nonMergeCount: 0 }),
  false,
  'مسارات متشعبة (diverged) ⇒ لا مطابقة بغض النظر عن nonMergeCount',
);
assert.equal(
  isAncestorWithMergesOnly({ compareStatus: 'identical', nonMergeCount: 0 }),
  false,
  'identical ⇒ false (تُغطّى بالـprefix match السابق، ليس هذا الفحص)',
);

// 10) إصلاح جوهري عاشر — سيناريوهان صريحان من طلب المستخدم (2026-09-01) لم يكونا مُسمَّيين
//     بذاتهما في أي سيناريو سابق، رغم أن الحراس الأساسية (buildCanonicalCheckRunPayload
//     وreconcileCanonicalCheckRuns) كانت تضمنهما ضمنياً بالفعل:

// (10-أ) "تشغيل مُلغى لا يجوز أن ينشر نجاحاً جزئياً/مزيَّفاً": سواء أُلغي التشغيل قبل
//     publish أو أثناءه، أي كتابة فعلية تصدر عنه تمر حتماً عبر buildCanonicalCheckRunPayload
//     — وهي بدورها لا تشتق success إلا من reviewedCount الفعلي المُتحقَّق منه على HEAD، لا
//     من مجرد وصول التشغيل إلى خطوة الكتابة. تشغيل أُلغي قبل أن تصله مراجعة حقيقية (أو
//     أُلغي في منتصف عمل غير مكتمل) لا يملك reviewedCount > 0 إطلاقاً، فمهما كانت
//     generation ـه (حتى لو كانت الأحدث على الإطلاق) فالنتيجة تبقى in_progress بلا
//     conclusion — لا يوجد مسار برمجي واحد يُنتج success بدون reviewedCount > 0 فعلي.
const cancelledRunPayload = buildCanonicalCheckRunPayload({
  headSha: NEW_SHA,
  reviewedCount: 0, // تشغيل أُلغي قبل وصول مراجعة حقيقية — لا دليل مراجعة متحقَّق
  summary: 'cancelled-before-review',
  generation: runGeneration({ runId: 999999, runAttempt: 9 }), // أحدث generation ممكنة تخيّلياً
});
assert.equal(
  cancelledRunPayload.payload.status,
  'in_progress',
  'تشغيل مُلغى بلا reviewedCount > 0 يجب ألا يُنتج أبداً حالة completed حتى لو كانت generation ـه الأحدث',
);
assert.equal(
  cancelledRunPayload.payload.conclusion,
  undefined,
  'تشغيل مُلغى بلا مراجعة متحقَّقة يجب ألا يحمل حقل conclusion إطلاقاً — لا success جزئي أو مزيَّف',
);

// (10-ب) "in_progress أحدث لا يُعتبر أبداً دليلاً على نجاح مراجعة Codex": فوز تشغيل ما
//     بالمصالحة (reconcileCanonicalCheckRuns يختاره كـwinner لأن generation ـه الأحدث) لا
//     علاقة له إطلاقاً بحالة النجاح/الفشل — اختيار الفائز واشتقاق success مصدران مستقلان
//     تماماً بالتصميم. حتى لو "فاز" تشغيل بالمصالحة كونه الأحدث، طالما لم يُراجَع HEAD
//     فعلياً (reviewedCount=0) تبقى نتيجته in_progress — فوزه بالمصالحة لا يُحوَّل أبداً إلى
//     دليل ضمني على نجاح مراجعة لم تحدث.
const runsWithNewerInProgress = [
  { id: 1, name: 'Codex Review Gate', head_sha: NEW_SHA, external_id: runGeneration({ runId: 100, runAttempt: 1 }) }, // أقدم
  { id: 2, name: 'Codex Review Gate', head_sha: NEW_SHA, external_id: runGeneration({ runId: 500, runAttempt: 1 }) }, // الأحدث — لكنه سيبقى in_progress بلا مراجعة
];
const reconcileNewerInProgress = reconcileCanonicalCheckRuns({ checkRuns: runsWithNewerInProgress, headSha: NEW_SHA });
assert.equal(
  reconcileNewerInProgress.winnerId,
  2,
  'الفائز بالمصالحة يُحدَّد بأحدث generation فقط — بصرف النظر عن أي حالة مراجعة',
);
const payloadForNewerWinner = buildCanonicalCheckRunPayload({
  headSha: NEW_SHA,
  reviewedCount: 0, // الفائز بالمصالحة نفسه لم تصله مراجعة حقيقية بعد
  summary: 'winner-still-unreviewed',
  existingId: reconcileNewerInProgress.winnerId,
  generation: runGeneration({ runId: 500, runAttempt: 2 }),
});
assert.equal(
  payloadForNewerWinner.payload.status,
  'in_progress',
  'الفوز بالمصالحة (أحدث generation) لا يُحوَّل أبداً إلى success بحد ذاته — النجاح يُشتق حصراً من reviewedCount > 0 الفعلي على HEAD الحالي',
);
assert.equal(
  payloadForNewerWinner.payload.conclusion,
  undefined,
  'in_progress أحدث حتى بعد فوزه بالمصالحة يبقى بلا conclusion — لا يُعامَل أبداً كدليل نجاح مراجعة',
);

console.log('codex-review-gate-logic.mjs contract + regression checks passed.');
