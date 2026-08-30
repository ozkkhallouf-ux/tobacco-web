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
