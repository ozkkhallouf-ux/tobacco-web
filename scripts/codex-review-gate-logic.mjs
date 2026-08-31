// المنطق المرجعي (reference implementation) لقاعدة مطابقة مراجعة Codex في
// .github/workflows/codex-review-gate.yml — هذا الملف لا يُنفَّذ من الـworkflow نفسه
// (الـworkflow يبقى bash/jq خالص عمداً، بلا أي actions/checkout لكود الفرع، حفاظاً على
// نفس وضع التحصين الموثّق في codex-review-gate.yml). الغرض الوحيد من وجوده هنا هو توثيق
// القاعدة بشكل قابل للاختبار الآلي (انظر scripts/check-codex-review-gate-logic.mjs)،
// بحيث أي تعديل مستقبلي لمنطق الـjq في الـworkflow يجب أن يبقى مطابقاً لهذا العقد.
//
// ⚠️ إصلاح 2026-08-31 (إغلاق ثغرة إعادة ربط commit_id تلقائياً بعد rebase):
//   GET /pulls/{n}/comments (تعليقات المراجعة على أسطر كود محددة) يحمل حقلين:
//     - commit_id: يُعاد ربطه تلقائياً بواسطة GitHub بأي commit لاحق ما زال يحتوي نفس
//       السطر دون تغيير (rebase أو merge لا يمسّان تلك الأسطر) — هذا "دليل" زائف على
//       مراجعة حقيقية للـHEAD الحالي رغم أن Codex لم يرَ هذا الـHEAD إطلاقاً.
//     - original_commit_id: ثابت أبداً — قيمة الـcommit الذي أُنشئ عليه التعليق أصلاً،
//       ولا تتغيّر بعد الإنشاء مهما تحرك تاريخ الفرع لاحقاً.
//   الحل: تُستخدم original_commit_id حصراً لمطابقة تعليقات المراجعة (pulls/comments) —
//   وليس commit_id. مراجعات Formal Review (pulls/reviews) تبقى تُطابَق عبر commit_id لأن
//   حقلها ثابت عند الإرسال أصلاً (غير مرتبط بسطر كود متحرك)، فلا ثغرة إعادة ربط هناك.
//   تعليقات Issue Comment (issues/comments) تبقى تُطابَق عبر نص "Reviewed commit:" الحرفي
//   داخل الجسم — محتوى ثابت كتبه Codex فعلياً، غير خاضع لإعادة ربط GitHub أصلاً.

/**
 * @typedef {{ user?: { login?: string }, commit_id?: string, original_commit_id?: string, body?: string }} GhComment
 */

/**
 * يطابق منطق خطوة "فحص مراجعة Codex على الـHEAD الحالي" في codex-review-gate.yml حرفياً.
 * @param {{
 *   headSha: string,
 *   botLogin?: string,
 *   formalReviews?: GhComment[],
 *   reviewComments?: GhComment[],
 *   issueComments?: GhComment[],
 * }} input
 */
export function evaluateCodexReview({
  headSha,
  botLogin = 'chatgpt-codex-connector[bot]',
  formalReviews = [],
  reviewComments = [],
  issueComments = [],
}) {
  if (!headSha) throw new Error('headSha مطلوب');
  const headShaLc = headSha.toLowerCase();

  // pulls/{n}/reviews — commit_id ثابت عند الإرسال، غير خاضع لإعادة ربط GitHub.
  const formalReviewCount = formalReviews.filter(
    (r) => r?.user?.login === botLogin && r?.commit_id === headSha,
  ).length;

  // pulls/{n}/comments — original_commit_id فقط (وليس commit_id القابل لإعادة الربط).
  const matchingReviewComments = reviewComments.filter(
    (c) => c?.user?.login === botLogin && c?.original_commit_id === headSha,
  );
  const reviewCommentCount = matchingReviewComments.length;

  // issues/{n}/comments — مطابقة prefix حرفي لنص "Reviewed commit:" فقط، لا timestamps.
  const shortShaPattern = /Reviewed commit:\*\*\s*`([0-9a-fA-F]{7,40})`/g;
  const issueCommentMatch = issueComments.some((c) => {
    if (c?.user?.login !== botLogin) return false;
    const body = String(c.body || '');
    for (const match of body.matchAll(shortShaPattern)) {
      if (headShaLc.startsWith(match[1].toLowerCase())) return true;
    }
    return false;
  });

  // طبقة معلوماتية best-effort فقط (شارات P0/P1/P2/P3) — لا تؤثر على conclusion.
  const badgeSource = matchingReviewComments.map((c) => c.body || '').join('\n');
  const badgeCounts = {};
  for (const m of badgeSource.matchAll(/badge\/P([0-3])-/g)) {
    const key = `P${m[1]}`;
    badgeCounts[key] = (badgeCounts[key] || 0) + 1;
  }

  const reviewedCount = formalReviewCount + reviewCommentCount + (issueCommentMatch ? 1 : 0);
  const conclusion = reviewedCount > 0 ? 'success' : 'failure';
  const summary =
    conclusion === 'success'
      ? `تمت مراجعة ${botLogin} لأحدث commit (${headSha}).`
      : `لا توجد مراجعة من ${botLogin} على أحدث commit (${headSha}) بعد. انتظر المراجعة التلقائية، أو علّق @codex review، ثم أعد المحاولة.`;

  return {
    conclusion,
    summary,
    reviewedCount,
    formalReviewCount,
    reviewCommentCount,
    issueCommentMatch,
    badgeCounts,
  };
}

// ⚠️ إصلاح جوهري رابع بتاريخ 2026-08-31 (فصل concurrency group حسب نوع الحدث) — مُلغى
//   ومُستبدَل بالإصلاح السابع أدناه. تم إبقاء الشرح لسجل القرار فقط:
//   لوحظ حياً على PR #146 أن pull_request_target (فتح الـPR) وissue_comment
//   ("@codex review") كانا يقعان بنفس مجموعة concurrency (المفتاح يعتمد فقط على رقم
//   الـPR)، فيُلغي الأحدث الأقدم عبر cancel-in-progress: true رغم أنهما فحصان مستقلان
//   منطقياً. الحل وقتها كان إضافة github.event_name إلى مفتاح المجموعة. لكن هذا الفصل
//   بالذات هو ما فتح نافذة التشغيلات المتزامنة الفعلية التي كشفها Codex كـP1 (انظر
//   "إصلاح جوهري سابع" أدناه) — فصل concurrency وحده غير كافٍ لضمان عدم التراجع.

/**
 * يطابق تعبير `concurrency.group` في codex-review-gate.yml حرفياً (بعد الإصلاح السابع:
 * مجموعة واحدة لكل PR بصرف النظر عن نوع الحدث — الحماية من التراجع تعتمد الآن على
 * isStaleWrite/isStaleHead أدناه، وليس على فصل concurrency).
 * @param {{ prNumber: string | number }} input
 */
export function concurrencyGroup({ prNumber }) {
  if (!prNumber) throw new Error('prNumber مطلوب');
  return `codex-review-gate-${prNumber}`;
}

// ⚠️ إصلاح جوهري سابع بتاريخ 2026-08-31 (حارس تشغيل قديم صريح — race condition حقيقي
//   رصدها Codex كـP1 حي على PR #146، thread غير محلول وغير outdated): توحيد concurrency
//   وحده لا يضمن عدم التداخل (نافذة زمنية قصيرة بين إشارة الإلغاء واكتمال استدعاء API
//   جارٍ فعلاً)، لذا يُضاف حارس صريح لا يعتمد على ترتيب وصول/اكتمال الأحداث إطلاقاً:
//   كل تشغيل يحمل "generation" فريدة تصاعدية = run_id.run_attempt (GitHub يخصّص run_id
//   تصاعدياً وقت *إنشاء* التشغيل، لا علاقة له بترتيب الاكتمال). قبل أي كتابة نهائية،
//   يُقارَن مع الـgeneration المثبَّتة في external_id للـcheck-run الكانوني الموجود
//   حالياً — إن كانت أحدث أو مساوية، هذا التشغيل قديم/متأخر ويُمنع من الكتابة.

/**
 * يبني قيمة generation نصية من run_id + run_attempt، تُخزَّن لاحقاً في external_id
 * للـcheck-run الكانوني كحارس تشغيل قديم صريح.
 * @param {{ runId: string | number, runAttempt?: string | number }} input
 */
export function runGeneration({ runId, runAttempt = 1 }) {
  if (runId === undefined || runId === null || runId === '') throw new Error('runId مطلوب');
  return `${runId}.${runAttempt}`;
}

/**
 * مقارنة رقمية بين قيمتَي generation (كل منهما "runId.runAttempt") — موجب إن كانت a
 * أحدث من b، صفر إن تساوتا، سالب إن كانت a أقدم من b.
 * @param {string} a
 * @param {string} b
 */
function compareGenerations(a, b) {
  const [aRun, aAttempt] = String(a).split('.').map(Number);
  const [bRun, bAttempt] = String(b).split('.').map(Number);
  if (aRun !== bRun) return aRun - bRun;
  return (aAttempt || 0) - (bAttempt || 0);
}

/**
 * حارس تشغيل قديم صريح: هل يجب على تشغيل بـcandidateGeneration الامتناع عن الكتابة على
 * check-run الكانوني، لأن الموجود فعلاً (existingGeneration) أحدث أو مساوٍ له؟
 * بدون external_id مسجَّل بعد (أول كتابة على الإطلاق لهذا الـsha) ⇒ ليس قديماً.
 * @param {{ existingGeneration?: string | null, candidateGeneration: string }} input
 */
export function isStaleWrite({ existingGeneration, candidateGeneration }) {
  if (!candidateGeneration) throw new Error('candidateGeneration مطلوب');
  if (!existingGeneration) return false;
  return compareGenerations(existingGeneration, candidateGeneration) >= 0;
}

/**
 * حارس HEAD حالي: هل يجب على هذا التشغيل الامتناع عن الكتابة لأن الـPR تحرّك (push جديد)
 * أثناء تنفيذ هذا التشغيل تحديداً — أي أن capturedHeadSha لم يعد يطابق liveHeadSha؟
 * @param {{ capturedHeadSha: string, liveHeadSha: string }} input
 */
export function isStaleHead({ capturedHeadSha, liveHeadSha }) {
  if (!capturedHeadSha || !liveHeadSha) throw new Error('capturedHeadSha وliveHeadSha مطلوبان');
  return capturedHeadSha !== liveHeadSha;
}

// ⚠️ إصلاح جوهري ثامن بتاريخ 2026-08-31 (مصالحة بعد الكتابة — P1 حي رصده Codex على هذا
//   الفرع نفسه: "Make the stale-run guard atomic with publication"): isStaleWrite أعلاه
//   يمنع الكتابة *قبلها* بناءً على قراءة سابقة (lookup-then-write) — Checks API لا يوفّر
//   compare-and-swap ذرّياً، فتبقى نافذة نظرية: تشغيلان يقرآن external_id قبل أن يكتب
//   أيّهما (كلاهما يجتاز الحارس بنجاح)، ثم تصل كتابة الأقدم (generation أصغر) فعلياً على
//   شبكة GitHub بعد كتابة الأحدث، فتطمس نتيجة صحيحة بأخرى قديمة رغم اجتياز الحارس السابق.
//   الحل التكميلي: بعد كل كتابة، تحقّق فوري (GET) من أن ما استقر فعلياً على الـcheck-run
//   لا يزال generation هذا التشغيل (أو أحدث). إن ظهر أقدم، أعد الكتابة لاستعادة النتيجة
//   الصحيحة (self-heal) — بدل الاكتفاء بمنع الكتابة قبلها فقط.

/**
 * بعد كتابة generation (writtenGeneration) على check-run الكانوني، هل ما استقر فعلياً
 * حالياً هناك (observedGeneration، من GET فوري) أقدم منها — أي وقعت كتابة متأخرة من
 * تشغيل أقدم بعد كتابتنا مباشرة، فيجب إعادة الكتابة لاستعادة النتيجة الصحيحة؟
 * observedGeneration فارغة (فشل GET أو لم تُقرأ بعد) ⇒ لا مصالحة قسرية بلا دليل واضح.
 * observedGeneration مساوية أو أحدث من writtenGeneration ⇒ لا حاجة لمصالحة (كتابتنا
 * سليمة، أو كتابة أحدث شرعية سبقتنا وهذا متوقَّع وصحيح).
 * @param {{ writtenGeneration: string, observedGeneration?: string | null }} input
 */
export function needsWriteReconciliation({ writtenGeneration, observedGeneration }) {
  if (!writtenGeneration) throw new Error('writtenGeneration مطلوب');
  if (!observedGeneration) return false;
  return compareGenerations(writtenGeneration, observedGeneration) > 0;
}

// ⚠️ إصلاح جوهري خامس بتاريخ 2026-08-31 (Canonical Check Run واحد لكل PR+HEAD SHA):
//   الإصلاح الرابع (فصل concurrency group حسب نوع الحدث) أوقف الإلغاء الخاطئ، لكنه كشف
//   عن ثغرة أعمق رصدها Codex نفسه كـP1 حي على PR #146: كل تشغيل (pull_request_target عند
//   فتح الـPR، ثم issue_comment عند "@codex review") كان يُنشئ check-run **منفصلاً** جديداً
//   بنفس الاسم "Codex Review Gate" عبر POST /check-runs — فإذا اكتمل التشغيل الأول (الذي
//   لا توجد مراجعة بعد وقته، FAIL شرعي حينها) بعد اكتمال الثاني (الذي وجد مراجعة، PASS)،
//   يبقى كلا الـcheck-run موجودَين معاً على نفس head_sha، ويُقيّم rollup/ruleset الحالة
//   الإجمالية FAILURE — رغم أن الأحدث والأصح PASS. المشكلة الجذرية: عدة check-runs بنفس
//   الاسم لنفس sha، لا "آخرها يفوز".
//
//   الحل: مصدر الحقيقة الوحيد يصبح **check-run كانوني واحد** لكل زوج (PR, head_sha):
//     1. كل تشغيل يبحث أولاً (GET /commits/{sha}/check-runs?check_name=Codex Review Gate)
//        عن check-run موجود فعلاً على نفس head_sha بالضبط.
//     2. إن وُجد ⇒ PATCH لنفس الـid (تحديث في مكانه) — لا يُنشأ أبداً check-run ثانٍ بنفس
//        الاسم على نفس sha، فلا تراكم ولا تلوّث للـrollup مهما تعدّدت التشغيلات (فتح
//        الـPR، تعليق مراجعة، push، إلخ) على نفس الـHEAD.
//     3. إن لم يوجد (أول تشغيل لهذا الـsha تحديداً، أو sha جديد بعد push) ⇒ POST لإنشاء
//        check-run جديد بحالة `in_progress` (لا success ولا failure).
//     4. لا توجد مراجعة بعد ⇒ الحالة تبقى `in_progress` (pending) — **ليست** `failure`.
//        هذا يمنع الدمج بنفس فعالية الفشل الصريح (required status check غير success)، لكن
//        دون أي احتمال أن ينشر تشغيل قديم "فشلاً" ملوِّثاً لاحقاً — فما دام لا يوجد سوى
//        check-run واحد قابل للتحديث في مكانه، لا يوجد "قديم" يتنافس مع "جديد" إطلاقاً.
//     5. مراجعة صريحة على نفس الـHEAD ⇒ يُحدَّث نفس الـcheck-run الكانوني إلى
//        `completed`/`success`.
//     6. push جديد (HEAD SHA مختلف) ⇒ لا يوجد check-run بعد لهذا الـsha الجديد تحديداً
//        (حتى لو كان الـsha السابق success) ⇒ ينشأ check-run كانوني جديد بحالة `in_progress`
//        تلقائياً — لا حاجة لأي منطق خاص، لأن البحث دائماً يكون بـhead_sha الحالي حصراً.
//   مُختبَر بالكامل في scripts/check-codex-review-gate-logic.mjs (جزء من npm run check).

/**
 * @typedef {{ id: number, name?: string, head_sha?: string, external_id?: string }} GhCheckRun
 */

/**
 * يبحث عن check-run كانوني موجود فعلاً على نفس head_sha بالضبط (وبنفس الاسم)، ليُعاد
 * استخدام نفس id عبر PATCH بدلاً من إنشاء check-run ثانٍ (POST) بنفس الاسم على نفس sha.
 * إن تعدّدت (حالة تراكم قديمة من إصلاحات سابقة)، يُختار الأحدث (أكبر id) دائماً.
 * @param {{ checkRuns?: GhCheckRun[], headSha: string, name?: string }} input
 * @returns {number | null} الـid القابل لإعادة الاستخدام، أو null إن وجب إنشاء واحد جديد.
 */
export function selectCanonicalCheckRunId({ checkRuns = [], headSha, name = 'Codex Review Gate' }) {
  if (!headSha) throw new Error('headSha مطلوب');
  const matching = checkRuns.filter((cr) => cr?.name === name && cr?.head_sha === headSha);
  if (matching.length === 0) return null;
  return matching.reduce((latest, cr) => (cr.id > latest.id ? cr : latest)).id;
}

/**
 * يبني حمولة create-or-update لـcheck-run "Codex Review Gate" الكانوني، بالاعتماد حصراً
 * على نتيجة evaluateCodexReview أعلاه. لا success ولا failure طالما لا توجد مراجعة —
 * الحالة عندها in_progress (pending)، لا failure أبداً.
 * generation (إصلاح جوهري سابع): تُثبَّت في external_id لتكون حارساً لأي تشغيل لاحق عبر
 * isStaleWrite أعلاه — إلزامية هنا لضمان أن كل كتابة تحمل حارسها الخاص.
 * @param {{ headSha: string, reviewedCount: number, summary: string, badgesText?: string, existingId?: number | null, generation: string }} input
 */
export function buildCanonicalCheckRunPayload({
  headSha,
  reviewedCount,
  summary,
  badgesText = '',
  existingId = null,
  generation,
}) {
  if (!headSha) throw new Error('headSha مطلوب');
  if (!generation) throw new Error('generation مطلوب');
  const name = 'Codex Review Gate';
  const text =
    '### درجات الخطورة (best-effort، معلوماتي فقط — غير حاكم للدمج)\n```\n' +
    (badgesText || '(لا توجد شارات درجة خطورة ملحوظة على هذا الـHEAD)') +
    '\n```';

  const base = {
    method: existingId ? 'PATCH' : 'POST',
    url: existingId ? `check-runs/${existingId}` : 'check-runs',
    payload: {
      name,
      external_id: generation,
      output: { title: name, summary, text },
    },
  };

  if (!existingId) base.payload.head_sha = headSha; // POST يتطلب head_sha؛ PATCH لا يغيّره أبداً.

  if (reviewedCount > 0) {
    base.payload.status = 'completed';
    base.payload.conclusion = 'success';
  } else {
    base.payload.status = 'in_progress'; // pending — بلا conclusion إطلاقاً، ليس failure.
  }

  return base;
}

// ⚠️ إصلاح جوهري ثاني عشر بتاريخ 2026-08-31 (قفل ذرّي عبر git ref — يستبدل حلقة المصالحة
//   ذات نافذة الـ45 ثانية، الإصلاح الثامن/التاسع أعلاه): isStaleWrite/needsWriteReconciliation
//   أعلاه يعتمدان على lookup-then-write وGET بعدي — تخفيف احتمالي بنافذة زمنية، وليس
//   compare-and-swap ذرّياً حقيقياً (لا يوجد ذلك في Checks API إطلاقاً). الحل الجذري: مرجع
//   git مخصص لكل PR (refs/gate-lock/pr-<PR_NUMBER>) يشير دائماً إلى commit شجرته فارغة
//   (empty tree) ورسالته = generation حامل القفل الحالي. كل تشغيل يحاول تحديثه ذرّياً عبر
//   POST /git/refs (إنشاء أول مرة، يفشل 422 إن وُجد مسبقاً) أو PATCH .../git/refs/{ref} مع
//   force=false (يفشل 422 إلا إذا كان commit-نا امتداد fast-forward حرفي لما هو موجود فعلاً
//   الآن على الخادم) — وهذا الفشل يُنفَّذ ويُتحقَّق منه من طرف GitHub نفسه ذرّياً، لا تخمين
//   محلي. لا تحرير/TTL صريح: القفل مطالبة أحادية الاتجاه (monotonic) — تشغيل مُعطَّل/منتهي
//   المهلة يترك القفل عند generation قديمة فقط؛ أي تشغيل لاحق شرعي يحمل generation أعلى
//   دائماً (run_id تصاعدي من GitHub) فيتخطاه بنفس آلية fast-forward دون أي انتظار أو قفل
//   عالق دائم. لا concurrency group يُعاد استخدامها — القفل يُطبَّق فقط على خطوة الكتابة
//   الحسّاسة (publish)، لا على الـjob كله.

/**
 * اسم مرجع القفل الذرّي لهذا الـPR (بدون بادئة refs/) — يطابق LOCK_REF في codex-review-gate.yml.
 * @param {{ prNumber: string | number }} input
 */
export function lockRefName({ prNumber }) {
  if (!prNumber) throw new Error('prNumber مطلوب');
  return `gate-lock/pr-${prNumber}`;
}

/**
 * SHA الشجرة الفارغة الثابتة عالمياً في git — تُستخدم كـtree لكل commit قفل، لأن محتوى
 * القفل بذاته غير مهم؛ المهم فقط رسالته (generation) وسلسلة أسلافه (parents) للفوز بالسباق
 * عبر fast-forward حقيقي.
 */
export const GATE_LOCK_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * حارس أخذ القفل: هل يجب على تشغيل بـcandidateGeneration الامتناع عن محاولة أخذ القفل، لأن
 * القفل الحالي (currentLockGeneration، من رسالة commit مرجع القفل) يخصّ تشغيلاً أحدث أو
 * مساوياً بالفعل؟ يطابق حرفياً منطق التخطي في خطوة acquire_lock (نفس دلالات isStaleWrite:
 * >= تعني تخطٍّ). لا قفل موجود بعد (currentLockGeneration فارغة) ⇒ ليس قديماً، يمكن المحاولة.
 * @param {{ currentLockGeneration?: string | null, candidateGeneration: string }} input
 */
export function isLockStale({ currentLockGeneration, candidateGeneration }) {
  if (!candidateGeneration) throw new Error('candidateGeneration مطلوب');
  return isStaleWrite({ existingGeneration: currentLockGeneration, candidateGeneration });
}
