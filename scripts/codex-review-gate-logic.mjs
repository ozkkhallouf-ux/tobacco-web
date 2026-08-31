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

// ⚠️ إصلاح جوهري رابع بتاريخ 2026-08-31 (فصل concurrency group حسب نوع الحدث):
//   لوحظ حياً على PR #146 أن pull_request_target (فتح الـPR) وissue_comment
//   ("@codex review") كانا يقعان بنفس مجموعة concurrency (المفتاح يعتمد فقط على رقم
//   الـPR)، فيُلغي الأحدث الأقدم عبر cancel-in-progress: true رغم أنهما فحصان مستقلان
//   منطقياً. الحل: يُضاف github.event_name إلى مفتاح المجموعة — كل فئة حدث بمجموعتها
//   الخاصة، بينما يبقى cancel-in-progress فعالاً *داخل* نفس فئة الحدث (تشغيلان متتاليان
//   من نفس النوع لا يزال أحدثهما يُلغي أقدمهما، فلا تتراكم تشغيلات قديمة بلا داعٍ).

/**
 * يطابق تعبير `concurrency.group` في codex-review-gate.yml حرفياً.
 * @param {{ prNumber: string | number, eventName: string }} input
 */
export function concurrencyGroup({ prNumber, eventName }) {
  if (!prNumber) throw new Error('prNumber مطلوب');
  if (!eventName) throw new Error('eventName مطلوب');
  return `codex-review-gate-${prNumber}-${eventName}`;
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
 * @typedef {{ id: number, name?: string, head_sha?: string }} GhCheckRun
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
 * @param {{ headSha: string, reviewedCount: number, summary: string, badgesText?: string, existingId?: number | null }} input
 */
export function buildCanonicalCheckRunPayload({ headSha, reviewedCount, summary, badgesText = '', existingId = null }) {
  if (!headSha) throw new Error('headSha مطلوب');
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
