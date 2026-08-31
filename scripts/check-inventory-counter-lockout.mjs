import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  nextLockStateAfterFailure,
  lockStateAfterSuccess,
  MAX_FAILED_ATTEMPTS,
  LOCK_MINUTES,
} from './inventory-auth-lockout-logic.mjs';

// عطل إنتاجي حيّ (2026-08-31): موظفو الجرد عالقون على رسالة «بيانات الدخول غير
// صحيحة أو الحساب مقفل مؤقتاً. انتظر 15 دقيقة». سجلّ GoTrue أثبت أن الرفض كان
// invalid_credentials حقيقياً، لكن الرسالة وعدت بمخرج لم يكن موجوداً:
//
//   smart_inventory_auth_record كانت تنفّذ عند كل فشل، بلا شرط:
//     locked_until = case when failed_attempts+1 >= 5 then now()+interval '15 minutes' ...
//   وinventory-auth تستدعيها أيضاً على المسار الذي رفضه preflight أصلاً. فينتج:
//     (١) كل محاولة أثناء القفل تُجدّد ١٥ دقيقة كاملة ⇒ قفل بلا نهاية لمن يعيد
//         المحاولة، وهو السلوك الطبيعي لموظف يظن أن كلمته صحيحة.
//     (٢) بعد انتهاء القفل يبقى failed_attempts ≥ ٥ ⇒ أول خطأ واحد يُعيد القفل
//         فوراً بدل أن تعود الميزانية كاملة.
//   عملياً: قفل دائم بالاسم، وأي طرف يعرف اسم مستخدم موظف جرد يستطيع إبقاءه
//   خارج النظام بمحاولة خاطئة واحدة كل ١٥ دقيقة.
//
// هذا الفحص يمنع رجوع العطل من الطرفين: سلوكياً على النموذج المرجعي، وحرفياً
// على فروع الـSQL التي تنفّذ القرار فعلاً.

const SCHEMA = 'supabase/smart-inventory.sql';
const MIGRATION = 'supabase/migrations/20260831131500_inventory_auth_lockout_no_ratchet.sql';
const TRUTH_TABLE = 'supabase/tests/inventory-auth-lockout-truth-table.sql';
const CLIENT = 'src/supabase-client.js';
const EDGE = 'supabase/functions/inventory-auth/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(repoRoot, rel), 'utf8');
const [schema, migration, truth, client, edge] = await Promise.all(
  [SCHEMA, MIGRATION, TRUTH_TABLE, CLIENT, EDGE].map(read),
);

const codeOnly = (text) =>
  text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const squash = (text) => codeOnly(text).replace(/\s+/g, ' ');
const schemaCode = squash(schema);
const migrationCode = squash(migration);

const MINUTE = 60_000;
const T0 = Date.parse('2026-08-31T12:00:00Z');
const LOCK15 = T0 + 15 * MINUTE;

// ---------------------------------------------------------------------------
// ١) السلوك: السيناريو الإنتاجي كاملاً على النموذج المرجعي.
// ---------------------------------------------------------------------------
assert.equal(MAX_FAILED_ATTEMPTS, 5, 'حد القفل المتفق عليه هو خمس محاولات');
assert.equal(LOCK_MINUTES, 15, 'مدة القفل المعلنة للمستخدم هي خمس عشرة دقيقة');

// أربع محاولات خاطئة لا تقفل، والخامسة تقفل ١٥ دقيقة بالضبط.
let state = { failedAttempts: 0, lockedUntil: null };
for (let attempt = 1; attempt <= 4; attempt += 1) {
  state = nextLockStateAfterFailure(state.failedAttempts, state.lockedUntil, T0);
  assert.equal(state.failedAttempts, attempt, `المحاولة ${attempt} يجب أن تزيد العدّاد`);
  assert.equal(state.lockedUntil, null, `المحاولة ${attempt} يجب ألا تقفل الحساب`);
}
state = nextLockStateAfterFailure(state.failedAttempts, state.lockedUntil, T0);
assert.equal(state.failedAttempts, 5, 'المحاولة الخامسة تبلغ الحد');
assert.equal(state.lockedUntil, LOCK15, 'المحاولة الخامسة تقفل خمس عشرة دقيقة من لحظتها');

// جوهر العطل الأول: إعادة المحاولة أثناء القفل يجب ألا تُمدّده ولو مرة واحدة.
// خمس عشرة محاولة بفاصل دقيقة كانت سابقاً تدفع القفل إلى ما لا نهاية.
let locked = state;
for (let minute = 1; minute <= 14; minute += 1) {
  locked = nextLockStateAfterFailure(locked.failedAttempts, locked.lockedUntil, T0 + minute * MINUTE);
  assert.equal(locked.lockedUntil, LOCK15, `المحاولة عند الدقيقة ${minute} مدّدت القفل — عادت السقّاطة`);
  assert.equal(locked.failedAttempts, 5, `المحاولة عند الدقيقة ${minute} زادت العدّاد أثناء القفل`);
}
// أربع عشرة محاولة متتالية لم تُزحزح الموعد: القفل ينتهي في دقيقته المعلنة.
const atAnnouncedEnd = nextLockStateAfterFailure(locked.failedAttempts, locked.lockedUntil, LOCK15);
assert.equal(
  atAnnouncedEnd.lockedUntil, null,
  'القفل يجب أن ينتهي في موعده المعلن مهما تكرّرت المحاولات أثناءه',
);

// الحد بالضبط: المساواة تعني انتهاء القفل، لا استمراره.
const atExpiry = nextLockStateAfterFailure(5, LOCK15, LOCK15);
assert.equal(atExpiry.lockedUntil, null, 'locked_until == now يجب أن يُعدّ قفلاً منتهياً');
assert.equal(atExpiry.failedAttempts, 1, 'انتهاء القفل يُصفّر العدّاد ويبدأ نافذة جديدة');
assert.equal(
  nextLockStateAfterFailure(5, LOCK15, LOCK15 - 1000).lockedUntil, LOCK15,
  'القفل سارٍ حتى الثانية الأخيرة قبل موعده',
);

// جوهر العطل الثاني: بعد الانتظار المعلن، تعود ميزانية كاملة من خمس محاولات.
let afterWait = nextLockStateAfterFailure(9, LOCK15, LOCK15 + MINUTE);
assert.equal(afterWait.failedAttempts, 1, 'أول خطأ بعد الانتظار يبدأ من ١، لا من العدّاد القديم');
assert.equal(afterWait.lockedUntil, null, 'أول خطأ بعد الانتظار يجب ألا يُعيد القفل فوراً');
for (let attempt = 2; attempt <= 4; attempt += 1) {
  afterWait = nextLockStateAfterFailure(afterWait.failedAttempts, afterWait.lockedUntil, LOCK15 + MINUTE);
  assert.equal(afterWait.lockedUntil, null, `المحاولة ${attempt} بعد الانتظار قفلت قبل الأوان`);
}
afterWait = nextLockStateAfterFailure(afterWait.failedAttempts, afterWait.lockedUntil, LOCK15 + MINUTE);
assert.equal(afterWait.failedAttempts, 5, 'النافذة الجديدة تتسع لخمس محاولات كاملة');
assert.equal(afterWait.lockedUntil, LOCK15 + MINUTE + 15 * MINUTE, 'الخامسة بعد الانتظار تقفل من جديد');

// NULL في العدّاد يُعامل صفراً، والنجاح يُصفّر كل شيء.
assert.equal(nextLockStateAfterFailure(null, null, T0).failedAttempts, 1, 'NULL في العدّاد يُعامل صفراً');
assert.deepEqual(
  lockStateAfterSuccess(), { failedAttempts: 0, lockedUntil: null },
  'الدخول الناجح يمسح العدّاد والقفل معاً',
);

// ---------------------------------------------------------------------------
// ٢) الربط: فروع الـSQL التي تنفّذ القرار فعلاً، حرفاً بحرف في الملفين.
// ---------------------------------------------------------------------------
const BRANCHES = [
  "when p_locked_until is not null and p_locked_until > p_now then coalesce(p_failed_attempts, 0)",
  "when p_locked_until is not null and p_locked_until <= p_now then 1",
  "else coalesce(p_failed_attempts, 0) + 1",
  "when p_locked_until is not null and p_locked_until > p_now then p_locked_until",
  "when p_locked_until is not null and p_locked_until <= p_now then null",
  "when coalesce(p_failed_attempts, 0) + 1 >= 5 then p_now + interval '15 minutes'",
];
for (const branch of BRANCHES) {
  assert.ok(schemaCode.includes(branch), `${SCHEMA}: فرع القرار مفقود أو مُعدَّل — ${branch}`);
  assert.ok(migrationCode.includes(branch), `${MIGRATION}: فرع القرار مفقود أو مُعدَّل — ${branch}`);
}
for (const [label, code] of [[SCHEMA, schemaCode], [MIGRATION, migrationCode]]) {
  assert.match(
    code, /returns public\.inventory_auth_lock_state language sql immutable/,
    `${label}: قرار القفل يجب أن يبقى دالة نقية immutable كي يبقى قابلاً للاختبار حالةً حالة`,
  );
  assert.ok(
    code.includes('select public.smart_inventory_auth_lock_state(r.failed_attempts,r.locked_until')
      || code.includes('select public.smart_inventory_auth_lock_state(r.failed_attempts, r.locked_until'),
    `${label}: smart_inventory_auth_record يجب أن تمرّ عبر الدالة النقية لا أن تُكرّر المنطق`,
  );
}

// ---------------------------------------------------------------------------
// ٣) السقّاطة القديمة ممنوعة من العودة بأي تباعد مسافات.
// ---------------------------------------------------------------------------
for (const [label, code] of [[SCHEMA, schemaCode], [MIGRATION, migrationCode]]) {
  assert.doesNotMatch(
    code,
    /set failed_attempts\s*=\s*failed_attempts\s*\+\s*1/i,
    `${label}: عادت الزيادة غير المشروطة للعدّاد — ستُحسب المحاولات أثناء القفل من جديد`,
  );
  assert.doesNotMatch(
    code,
    /locked_until\s*=\s*case when failed_attempts\s*\+\s*1\s*>=\s*5 then now\(\)\s*\+\s*interval '15 minutes' else locked_until end/i,
    `${label}: عاد تجديد القفل غير المشروط — هذا بالضبط ما جعل الانتظار ١٥ دقيقة بلا فائدة`,
  );
}

// ---------------------------------------------------------------------------
// ٤) جدول الحقيقة موجود ويغطي الحالات الحدّية التي يسهل أن تنزلق.
// ---------------------------------------------------------------------------
assert.match(
  truth, /public\.smart_inventory_auth_lock_state\(/,
  `${TRUTH_TABLE}: جدول الحقيقة يجب أن يستدعي الدالة النقية نفسها`,
);
for (const marker of [
  "public.smart_inventory_auth_lock_state(5, lock15, t0 + interval '1 minute')",
  'public.smart_inventory_auth_lock_state(5, lock15, lock15)',
  'public.smart_inventory_auth_lock_state(4, null, t0)',
]) {
  assert.ok(truth.includes(marker), `${TRUTH_TABLE}: حالة حدّية مفقودة — ${marker}`);
}

// ---------------------------------------------------------------------------
// ٥) الرسالة المعروضة للموظف: ممنوع أن تعد بانتظار ١٥ دقيقة كمخرج وحيد، ويجب
//    أن تذكر احتمال الخطأ في البيانات أولاً — هذا ما ضلّل التشخيص أصلاً.
// ---------------------------------------------------------------------------
const message = client.match(/invalid_or_locked:\s*"([^"]+)"/);
assert.ok(message, `${CLIENT}: رسالة invalid_or_locked مفقودة`);
assert.doesNotMatch(
  message[1], /انتظر 15 دقيقة بعد المحاولات المتكررة/,
  `${CLIENT}: الرسالة القديمة تعد بمخرج لم يكن يعمل — يجب أن تشرح الشرط الحقيقي`,
);
assert.match(
  message[1], /غير صحيحة/,
  `${CLIENT}: الرسالة يجب أن تبدأ باحتمال خطأ اسم المستخدم أو كلمة المرور`,
);

// ---------------------------------------------------------------------------
// ٦) مسار الدخول نفسه يبقى مارّاً بالبوابة والتسجيل — لا التفاف على القفل.
// ---------------------------------------------------------------------------
assert.ok(
  edge.includes('smart_inventory_auth_preflight') && edge.includes('smart_inventory_auth_record'),
  `${EDGE}: دخول موظف الجرد يجب أن يبقى مارّاً ببوابة القفل وتسجيل المحاولات`,
);

console.log('check-inventory-counter-lockout: ok');
