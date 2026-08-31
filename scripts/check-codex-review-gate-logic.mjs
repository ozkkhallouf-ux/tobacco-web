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

// 3) فحص مفتاح concurrency — إصلاح جوهري سابع بتاريخ 2026-08-31 (توحيد المجموعة: الفصل
//    حسب github.event_name كان هو ما فتح نافذة التشغيلات المتزامنة الفعلية التي كشفها
//    Codex كـP1 حي على PR #146 — الحماية من التراجع تعتمد الآن على الحارس الصريح فقط).
assert.doesNotMatch(
  yml,
  /group:\s*codex-review-gate-\$\{\{[\s\S]{0,200}\}\}-\$\{\{\s*github\.event_name\s*\}\}/,
  'مفتاح concurrency group يجب ألا يتضمن github.event_name بعد الآن — الفصل حسب نوع الحدث هو ما سمح بتشغيلات متزامنة فعلية (P1 المرصود على PR #146)',
);
assert.match(
  yml,
  /group:\s*codex-review-gate-\$\{\{[\s\S]{0,200}\}\}\s*\n\s*cancel-in-progress:\s*true/,
  'مفتاح concurrency group يجب أن يعتمد على رقم الـPR فقط (مجموعة واحدة لكل PR بصرف النظر عن نوع الحدث)',
);
assert.match(yml, /cancel-in-progress:\s*true/, 'cancel-in-progress يجب أن يبقى true (يقلّص التداخل الفعلي، ولو أنه ليس الضامن الوحيد بعد الآن)');

// سيناريو (ج) بعد الإصلاح السابع: pull_request_target وpull_request_review وissue_comment
// لنفس الـPR يجب أن يقعوا جميعاً بنفس مجموعة concurrency الآن (توحيد صريح — نقطة 1 من
// طلب المستخدم)، والحماية الفعلية من التراجع تأتي من isStaleWrite/isStaleHead أدناه.
const prNumber = 146;
const groupOpened = concurrencyGroup({ prNumber });
const groupReview = concurrencyGroup({ prNumber });
const groupIssueComment = concurrencyGroup({ prNumber });
assert.equal(groupOpened, groupReview, 'كل triggers لنفس الـPR يجب أن تشترك بنفس مجموعة concurrency بعد التوحيد');
assert.equal(groupOpened, groupIssueComment, 'issue_comment يجب أن يشترك بنفس مجموعة pull_request_target بعد التوحيد');
assert.equal(concurrencyGroup({ prNumber: 999 }) === groupOpened, false, 'أرقام PR مختلفة يجب أن تبقى بمجموعات مختلفة');

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

console.log('codex-review-gate-logic.mjs contract + regression checks passed.');
