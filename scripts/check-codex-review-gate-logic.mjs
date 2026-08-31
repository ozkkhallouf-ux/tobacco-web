import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  evaluateCodexReview,
  concurrencyGroup,
  selectCanonicalCheckRunId,
  buildCanonicalCheckRunPayload,
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

// 3) فحص مفتاح concurrency — إصلاح 2026-08-31 (PR #146: pull_request_target وissue_comment
//    كانا يلغيان بعضهما لأن المفتاح لم يفصل حسب نوع الحدث).
assert.match(
  yml,
  /group:\s*codex-review-gate-\$\{\{[\s\S]{0,200}\}\}-\$\{\{\s*github\.event_name\s*\}\}/,
  'مفتاح concurrency group يجب أن يتضمن github.event_name لفصل فئات الأحداث',
);
assert.match(yml, /cancel-in-progress:\s*true/, 'cancel-in-progress يجب أن يبقى true (داخل نفس فئة الحدث)');

// سيناريو (ج): pull_request_target ثم pull_request_review مباشرة على نفس الـPR ⇒
// يجب ألا يقع الاثنان بنفس مجموعة concurrency (فلا يُلغي أحدهما الآخر).
const prNumber = 146;
const groupOpened = concurrencyGroup({ prNumber, eventName: 'pull_request_target' });
const groupReview = concurrencyGroup({ prNumber, eventName: 'pull_request_review' });
const groupIssueComment = concurrencyGroup({ prNumber, eventName: 'issue_comment' });
assert.notEqual(
  groupOpened,
  groupReview,
  'pull_request_target وpull_request_review يجب ألا يشتركا بنفس مجموعة concurrency',
);
assert.notEqual(
  groupOpened,
  groupIssueComment,
  'pull_request_target وissue_comment (السباق الحقيقي المرصود على PR #146) يجب ألا يشتركا بنفس مجموعة concurrency',
);

// سيناريو (د): تشغيلان متتاليان من نفس فئة الحدث لنفس الـPR ⇒ نفس مجموعة concurrency،
// أي أن الأحدث لا يزال يُلغي الأقدم منها (cancel-in-progress: true يبقى فعالاً هنا).
const groupSecondOpenedRun = concurrencyGroup({ prNumber, eventName: 'pull_request_target' });
assert.equal(
  groupOpened,
  groupSecondOpenedRun,
  'تشغيلان من نفس فئة الحدث لنفس الـPR يجب أن يشتركا بنفس مجموعة concurrency (يُلغي الأحدث الأقدم)',
);
const groupSecondIssueCommentRun = concurrencyGroup({ prNumber, eventName: 'issue_comment' });
assert.equal(
  groupIssueComment,
  groupSecondIssueCommentRun,
  'تشغيلان من issue_comment لنفس الـPR يجب أن يشتركا بنفس المجموعة (لا تراكم تشغيلات قديمة)',
);

// 4) فحص العقد الثابت على نص الـworkflow لإصلاح Canonical Check Run (2026-08-31):
//    يبحث كل تشغيل عن check-run موجود على نفس head_sha بالضبط قبل الإنشاء، ولا يوجد أي
//    مسار conclusion=failure عند غياب المراجعة — pending (in_progress) فقط.
assert.match(
  yml,
  /repos\/\$REPO\/commits\/\$HEAD_SHA\/check-runs[\s\S]{0,80}check_name="\$NAME"/,
  'يجب البحث عن check-run كانوني موجود على نفس head_sha قبل أي POST جديد',
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
});
assert.equal(stalePayload.payload.status, 'in_progress', 'rebase بدون تغيير الأسطر + review قديم ⇒ in_progress (BLOCKED)، ليس success');

// (د) review صريح على HEAD الحالي ⇒ PASS (completed/success).
const freshPayload = buildCanonicalCheckRunPayload({
  headSha: NEW_SHA,
  reviewedCount: freshReviewResult.reviewedCount,
  summary: freshReviewResult.summary,
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
  buildCanonicalCheckRunPayload({ headSha: SHA_NEW, reviewedCount: 0, summary: 'pending' }).payload.status,
  'in_progress',
  'push جديد بعد PASS سابق ⇒ الـsha الجديد يبدأ in_progress (BLOCKED) من جديد، لا يرث success القديم',
);

console.log('codex-review-gate-logic.mjs contract + regression checks passed.');
