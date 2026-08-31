// النموذج المرجعي لقرار قفل دخول موظفي الجرد.
//
// هذا نظير حرفي لدالة SQL النقية public.smart_inventory_auth_lock_state، وهو
// موجود ليكون سلوك القفل قابلاً للاختبار داخل `npm run check` بلا قاعدة بيانات.
// scripts/check-inventory-counter-lockout.mjs يربط الاثنين: يشغّل السيناريو
// الإنتاجي على هذا النموذج، ثم يثبّت فروع الـSQL حرفاً بحرف — فلا يتحرك أحدهما
// دون الآخر.
//
// العطل الذي يمنعه (إنتاج 2026-08-31): كانت المحاولة الفاشلة تُعيد ضبط
// locked_until = now() + ١٥ دقيقة بلا شرط، فمن يعيد المحاولة أثناء القفل
// يُجدّده إلى الأبد، ومن ينتظر ١٥ دقيقة يُقفل من أول خطأ لأن العدّاد لم يُصفَّر.

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

const MS_PER_MINUTE = 60_000;

/**
 * قرار القفل التالي بعد محاولة دخول فاشلة.
 * @param {number|null} failedAttempts العدّاد الحالي (NULL يُعامل صفراً)
 * @param {number|null} lockedUntil لحظة انتهاء القفل بالمللي ثانية، أو null
 * @param {number} now اللحظة المرجعية بالمللي ثانية — وسيط صريح ليكون الاختبار حتمياً
 * @returns {{failedAttempts: number, lockedUntil: number|null}}
 */
export function nextLockStateAfterFailure(failedAttempts, lockedUntil, now) {
  const current = failedAttempts ?? 0;

  // قفل سارٍ: لم تُفحص أي كلمة مرور، فلا يُعدّ هذا محاولة ولا يُمدَّد القفل.
  if (lockedUntil !== null && lockedUntil > now) {
    return { failedAttempts: current, lockedUntil };
  }
  // قفل منتهٍ: الانتظار يعيد الميزانية كاملة بدل أن يُعيد القفل من أول خطأ.
  if (lockedUntil !== null && lockedUntil <= now) {
    return { failedAttempts: 1, lockedUntil: null };
  }
  // بلا قفل: العدّاد يزيد، ويُقفل عند بلوغ الحد.
  const next = current + 1;
  return {
    failedAttempts: next,
    lockedUntil: next >= MAX_FAILED_ATTEMPTS ? now + LOCK_MINUTES * MS_PER_MINUTE : null,
  };
}

/** إعادة الضبط بعد دخول ناجح: لا عدّاد ولا قفل. */
export function lockStateAfterSuccess() {
  return { failedAttempts: 0, lockedUntil: null };
}
