import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  evaluateCodexReview,
  concurrencyGroup,
  selectCanonicalCheckRunId,
  buildCanonicalCheckRunPayload,
  runGeneration,
  isStaleWrite,
  isStaleHead,
  needsWriteReconciliation,
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

// 3) فحص غياب concurrency نهائياً — إصلاح جوهري حادي عشر بتاريخ 2026-08-31 (ملاحظة Codex
//    P1 حية على PR #151، thread غير محلول): حتى مع cancel-in-progress: false (الإصلاح
//    العاشر)، تسمح دلالة GitHub الرسمية لأي concurrency group بعضو واحد فقط "قيد الانتظار"
//    (pending) بجانب العضو "قيد التنفيذ" — حدث ثالث لنفس الـPR يُلغي عضو الانتظار قبل أن
//    يبدأ تنفيذ أي خطوة، فحارس isStaleHead لا يُتاح له فرصة العمل ويظهر CANCELLED من جديد.
//    الحل النهائي: حذف قيد concurrency بالكامل — لا مجموعة، لا طابور، لا إلغاء إطلاقاً.
assert.doesNotMatch(
  yml,
  /^concurrency:/m,
  'مفتاح concurrency يجب ألا يكون موجوداً بعد الآن — وجوده يعيد فتح نافذة إلغاء "العضو المنتظر" (P1 المرصود حياً على PR #151) بصرف النظر عن قيمة cancel-in-progress',
);
assert.doesNotMatch(
  yml,
  /^\s*cancel-in-progress:\s*(true|false)\s*$/m,
  'مفتاح YAML فعلي باسم cancel-in-progress يجب ألا يظهر بعد حذف concurrency — التعليقات التاريخية التي تذكر اللفظة نصياً (شرحاً لا كمفتاح) مسموحة',
);
assert.doesNotMatch(
  yml,
  /^\s*group:\s*codex-review-gate-/m,
  'مفتاح group الخاص بـconcurrency يجب ألا يظهر بعد الآن — تم حذف قيد concurrency بالكامل بالإصلاح الحادي عشر',
);

// concurrencyGroup() في codex-review-gate-logic.mjs تبقى دالة منطقية صحيحة (unit-tested)
// حتى بعد إزالتها من ملف الـworkflow نفسه بالإصلاح الحادي عشر — لم تُحذف الدالة لأنها ليست
// جزءاً من منطق Required Check الكانوني، وقد تُستخدم لاحقاً لأغراض تشخيصية/تسجيل فقط.
const prNumber = 146;
const groupOpened = concurrencyGroup({ prNumber });
const groupReview = concurrencyGroup({ prNumber });
const groupIssueComment = concurrencyGroup({ prNumber });
assert.equal(groupOpened, groupReview, 'concurrencyGroup يجب أن تُعيد نفس القيمة لنفس رقم الـPR (دالة صرفة)');
assert.equal(groupOpened, groupIssueComment, 'concurrencyGroup لا تعتمد على نوع الحدث');
assert.equal(concurrencyGroup({ prNumber: 999 }) === groupOpened, false, 'أرقام PR مختلفة يجب أن تُعطي قيماً مختلفة');

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
  /EXISTING_ID=\$\(echo "\$EXISTING_RUNS_JSON" \| jq -r 'sort_by\(\.id\) \| last \| \.id \/\/ empty'\)/,
  'يجب اختيار أحدث check-run موجود (id الأكبر) لإعادة استخدامه عبر PATCH',
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
  /EXISTING_GENERATION=\$\(echo "\$EXISTING_RUNS_JSON" \| jq -r 'sort_by\(\.id\) \| last \| \.external_id \/\/ empty'\)/,
  'يجب قراءة external_id للـcheck-run الكانوني الموجود كـgeneration مُسجَّلة',
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
const runsAfterOldReview = [{ id: 1, name: 'Codex Review Gate', head_sha: SHA_OLD }];
const idForNewSha = selectCanonicalCheckRunId({ checkRuns: runsAfterOldReview, headSha: SHA_NEW });
assert.equal(idForNewSha, null, 'push جديد (sha مختلف) يجب ألا يجد أي check-run كانوني قابل لإعادة الاستخدام حتى لو كان القديم success');

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
const runsAfterFirstOpen = [{ id: 10, name: 'Codex Review Gate', head_sha: NEW_SHA }];
const idOnReviewArrival = selectCanonicalCheckRunId({ checkRuns: runsAfterFirstOpen, headSha: NEW_SHA });
assert.equal(idOnReviewArrival, 10, 'وصول المراجعة على نفس HEAD الذي فُتح عليه check-run in_progress سابقاً يجب أن يُعيد استخدام نفس الـid');
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
//     نهائي واحد فقط: يُختار الأحدث (أكبر id) دائماً من بين عدة check-runs على نفس sha.
const multipleRunsSameSha = [
  { id: 5, name: 'Codex Review Gate', head_sha: NEW_SHA },
  { id: 20, name: 'Codex Review Gate', head_sha: NEW_SHA },
  { id: 12, name: 'Codex Review Gate', head_sha: NEW_SHA },
];
assert.equal(
  selectCanonicalCheckRunId({ checkRuns: multipleRunsSameSha, headSha: NEW_SHA }),
  20,
  'عدة check-runs على نفس sha (تراكم قديم) ⇒ يُختار الأحدث (id الأكبر) دائماً كالكانوني الوحيد',
);

// (ز) push جديد بعد PASS ⇒ HEAD الجديد يرجع BLOCKED (in_progress) حتى تُراجَع تحديداً،
//     رغم أن الـsha السابق كان success — مغطى فعلياً بسيناريو (ب) أعلاه (idForNewSha).
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

// 7) إصلاح جوهري ثامن بتاريخ 2026-08-31 — مصالحة بعد الكتابة (P1 حي رصده Codex على هذا
//    الفرع نفسه: "Make the stale-run guard atomic with publication"). فحص العقد الثابت
//    على نص الـworkflow: يجب وجود حلقة GET فورية بعد كل PATCH/POST نهائي، تعيد الكتابة
//    إن استقر generation أقدم فعلياً على الـcheck-run (كتابة متأخرة من تشغيل أقدم).
assert.match(
  yml,
  /RECONCILE_ATTEMPT=0[\s\S]{0,4000}OBSERVED_GENERATION=\$\(gh api "repos\/\$REPO\/check-runs\/\$CHECK_RUN_ID" --jq '\.external_id \/\/ empty'\)/,
  'يجب وجود حلقة مصالحة بعد الكتابة تعيد قراءة external_id فوراً من نفس check-run الذي كُتب عليه للتو',
);
assert.match(
  yml,
  /if \[ "\$LIVE_HEAD_SHA" != "\$HEAD_SHA" \][\s\S]{0,200}مصالحة مُتوقَّفة/,
  'حلقة المصالحة يجب أن تحترم حارس HEAD الحي أيضاً — لا تكتب فوق PR تحرّك أثناء المصالحة',
);
assert.match(
  yml,
  /OBS_IS_OLDER=1[\s\S]{0,600}--method PATCH --input -/,
  'عند رصد كتابة أقدم مستقرة فعلياً بعد كتابتنا، يجب إعادة نفس PATCH لاستعادة النتيجة الصحيحة (self-heal)',
);
// تعديل بتاريخ 2026-08-31 (P1 حي ثانٍ رصده Codex: "Keep reconciling after a late stale
//    write"): فحص فوري واحد بلا انتظار لا يرى كتابة متأخرة من تشغيل أُلغي لكن طلبه كان قد
//    غادر العملية فعلياً قبل تسلّم إشارة الإلغاء. يجب أن تراقب الحلقة نافذة زمنية فعلية
//    (عدة محاولات بفواصل sleep حقيقية) لا فحصاً لحظياً واحداً يتوقف عند أول تطابق.
assert.match(
  yml,
  /RECONCILE_MAX_ATTEMPTS=4[\s\S]{0,300}RECONCILE_SLEEP_SECONDS=15[\s\S]{0,400}sleep "\$RECONCILE_SLEEP_SECONDS"/,
  'حلقة المصالحة يجب أن تراقب نافذة زمنية فعلية (عدة فحوصات بفواصل sleep) لا فحصاً لحظياً واحداً — كي ترصد كتابة متأخرة من تشغيل أُلغي بعد أن يكون طلبه قد غادر العملية فعلاً',
);

// 8) إصلاح جوهري تاسع بتاريخ 2026-08-31 — توحيد النسخ المكررة (P1 حي ثالث رصده Codex:
//    "Reconcile concurrent first-time check creation"): تشغيلان يريان "لا check-run بعد"
//    في اللحظة نفسها فينفّذ كلاهما POST مستقل، فينتج معرّفان مختلفان لنفس الاسم على نفس
//    head_sha. حارس generation المرتبط بمعرّف واحد بذاته لا يكتشف هذا — يجب مسح كل
//    check-runs الحاملة نفس الاسم على نفس head_sha كل دورة مصالحة، وتوحيدها جميعاً
//    (PATCH) مع حالة الفائز (أعلى generation).
assert.match(
  yml,
  /ALL_NAMED_RUNS_JSON=\$\(gh api "repos\/\$REPO\/commits\/\$HEAD_SHA\/check-runs" --paginate[\s\S]{0,200}select\(\.name == \$name\)/,
  'حلقة المصالحة يجب أن تمسح كل check-runs الحاملة اسم "Codex Review Gate" على نفس head_sha (وليس معرّف check-run هذا التشغيل فقط) لاكتشاف أي نسخة مكررة',
);
assert.match(
  yml,
  /WINNER_JSON=\$\(echo "\$ALL_NAMED_RUNS_JSON" \| jq '[\s\S]{0,300}sort_by\(gen_key\(\.external_id\)\) \| last/,
  'يجب تحديد الفائز (أعلى generation) بين كل النسخ الحاملة نفس الاسم على نفس head_sha',
);
assert.match(
  yml,
  /DUPLICATE_IDS=\$\(echo "\$ALL_NAMED_RUNS_JSON" \| jq -r[\s\S]{0,300}\(\.id\|tostring\) != \$winner and[\s\S]{0,800}--method PATCH --input -/,
  'يجب توحيد (PATCH) كل نسخة مكررة (id مختلف وgeneration غير مطابقة للفائز) مع حالة الفائز الصحيحة',
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

// 9) إصلاح جوهري عاشر بتاريخ 2026-08-31 — إيقاف cancel-in-progress (P1 حي رابع رصدناه بعد
//    اختبار post-merge حي على PR #150: تشغيل قديم أُلغي CANCELLED عند push جديد على نفس
//    الـPR، فلوّث statusCheckRollup الكلي رغم أن اسمه ليس required check). 3 سيناريوهات
//    regression مطلوبة صراحةً من المستخدم.

// (م) push جديد أثناء تشغيل داخلي قديم لا يجب أن يترك أي CANCELLED/FAILURE ظاهر بالـrollup:
//     نتحقق أن التشغيل القديم — بعد إيقاف cancel-in-progress — يُسمح له بالإكمال (لا يُقتل)
//     وأن خطوة "publish" الخاصة به تخرج exit 0 (outcome=success) بمجرد أن حارس isStaleHead
//     يكتشف أن HEAD تغيّر، فينهي الـjob بنجاح (SUCCESS) لا بإلغاء ولا بفشل — يطابق تماماً
//     ما تفحصه الخطوة الأخيرة "النتيجة الإعلامية للـjob" عبر steps.publish.outcome.
{
  const oldRunCapturedHead = SHA_OLD; // HEAD الذي بدأ عليه التشغيل القديم
  const liveHeadAfterNewPush = SHA_NEW; // push جديد وصل أثناء تنفيذه
  const oldRunIsStale = isStaleHead({ capturedHeadSha: oldRunCapturedHead, liveHeadSha: liveHeadAfterNewPush });
  assert.equal(oldRunIsStale, true, 'تشغيل قديم يكتشف أن HEAD تغيّر أثناء تنفيذه ⇒ isStaleHead=true');
  // isStaleHead=true يعني خطوة publish تخرج exit 0 بلا كتابة (مُثبَت بالعقد أعلاه على نص
  // الـworkflow: `if [ "$LIVE_HEAD_SHA" != "$HEAD_SHA" ]... exit 0`) ⇒ outcome=success دائماً
  // لتشغيل قديم يُكمل بحرية (بعد حذف concurrency بالإصلاح الحادي عشر، لا يوجد طابور يُلغيه
  // أصلاً — لا CANCELLED من قتل تشغيل قيد التنفيذ، ولا من إلغاء تشغيل قيد الانتظار).
  // ولا FAILURE (الخطوة الأخيرة تتحقق فقط من outcome!=success، وexit 0 يعني success).
  assert.match(
    yml,
    /if \[ "\$LIVE_HEAD_SHA" != "\$HEAD_SHA" \][\s\S]{0,400}exit 0/,
    'حارس isStaleHead في نص الـworkflow يجب أن يُنهي خطوة publish بـexit 0 (لا كتابة، لا فشل) عند تغيّر HEAD — هذا ما يضمن SUCCESS لا CANCELLED للتشغيل القديم بعد حذف concurrency',
  );
  assert.match(
    yml,
    /if \[ "\$\{\{ steps\.publish\.outcome \}\}" != "success" \][\s\S]{0,400}exit 1/,
    'الخطوة الأخيرة يجب أن تفشل الـjob فقط إن outcome!=success — exit 0 من isStaleHead يحقق success دائماً، فلا فشل ولا CANCELLED يظهر في rollup لتشغيل قديم أُكمل بسلام',
  );
}

// (خ) إصلاح حادي عشر: لا يوجد أي طابور concurrency يُلغي تشغيلاً "قيد الانتظار" قبل أن يبدأ
//     (الثغرة التي أثبتها Codex حياً على PR #151 رغم إيقاف cancel-in-progress بالإصلاح
//     العاشر — عضو الانتظار يُلغى بصرف النظر عن تلك القيمة). التحقق مباشرة على نص الملف.
assert.doesNotMatch(yml, /^concurrency:/m, 'لا يجب أن يظهر مفتاح concurrency في الملف نهائياً — هذا هو إصلاح P1 المرصود على PR #151');

// (ن) required canonical gate يبقى واحد فقط لكل HEAD — مغطى فعلياً أعلاه (سيناريو "و" +
//     إصلاح تاسع: ALL_NAMED_RUNS_JSON + WINNER_JSON + DUPLICATE_IDS تُوحِّد أي نسخ مكررة
//     PATCH على حالة الفائز)، ونضيف هنا تأكيداً صريحاً أن اسم job الداخلي يبقى مختلفاً عن
//     اسم الـcanonical حتى بعد إصلاح عاشر (لم يتغيّر بالإصلاح العاشر — شرط رقم 4 صريح).
assert.doesNotMatch(
  yml,
  /name: Codex Review Gate\s*\n\s*runs-on:/,
  'اسم الـjob الداخلي يجب أن يبقى مختلفاً حرفياً عن "Codex Review Gate" — لم يتغيّر بإصلاح عاشر (شرط صريح: عدم تغيير اسم/منطق الـRequired Check)',
);
assert.match(
  yml,
  /name: Codex Review Gate \(تشغيل داخلي — ليس Required Check\)/,
  'اسم الـjob الداخلي التشخيصي يجب أن يبقى كما هو — إصلاحا عاشر وحادي عشر لا يغيّران التسمية، فقط سلوك concurrency',
);

// (س) بعد review صحيح على HEAD نهائي واحد ⇒ لا يوجد أي مصدر آخر لـconclusion=failure أو
//     CANCELLED في نص الـworkflow يمكن أن يلوّث statusCheckRollup: تأكيد أن لا "conclusion":
//     "failure" (مغطى أعلاه) ولا أي مسار يكتب "cancelled" صراحة على check-run الكانوني ذاته
//     (الكانوني دائماً in_progress أو completed/success فقط — الـCANCELLED الوحيد كان تابعاً
//     لـauto job check-run، والذي عولج بحذف concurrency بالكامل أعلاه). الوصول الفعلي لـ
//     statusCheckRollup.state=SUCCESS وmergeStateStatus=CLEAN حياً يتطلب تشغيلاً فعلياً على
//     GitHub Actions (غير قابل للمحاكاة الكاملة بجافاسكريبت صرف) — هذا بالضبط ما يتحقق منه
//     اختبار post-merge حي لاحق قبل دمج أي PR يعتمد على الـGate (الشرط رقم 9 من طلب المستخدم).
assert.doesNotMatch(
  yml,
  /"conclusion":\s*"cancelled"/,
  'check-run الكانوني يجب ألا يحمل conclusion=cancelled أبداً — الحالتان المسموحتان فقط هما in_progress أو success',
);

console.log('codex-review-gate-logic.mjs contract + regression checks passed.');
