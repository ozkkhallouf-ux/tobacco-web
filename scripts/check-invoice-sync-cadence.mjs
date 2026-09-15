// ============================================================================
// يثبّت دورية رفع تفاصيل فواتير الزبائن إلى Supabase.
//
// لماذا وُجد هذا الفحص: القيمة انزلقت فعلاً من قبل. المستودع خفّض
// `register-customer-invoices-task.ps1` و`push-customer-invoices.ps1` من 60 إلى
// 15 دقيقة (commit 8d41709)، لكن ذلك المسار **متقاعد** — المهمة المستقلة
// «TOBACCO Customer Invoices Push» مُستبعَدة عمداً في ensure-ameen-sync.ps1 —
// فبقي الإنتاج على 60 دقيقة لأن القيمة النافذة هي الوسيط المُمرَّر داخل
// `ameen-sync-agent.ps1` وحده. النتيجة المقيسة على الإنتاج (2026-09-08): فاتورة
// أُدخلت الساعة ‎15:00Z ظهر قيدها في دفتر الحساب خلال دقيقة، بينما آخر لقطة
// فواتير كانت ‎14:51Z — فعجز الموقع عن إصدار مستندها وعرض تحذيراً للمستخدم.
//
// ما يحرسه: أن الوكيل الدائم (وهو المسار الإنتاجي الوحيد) يستدعي المُنتِج
// بدورية خمس دقائق تطابق نضارة `ameen_customer_movements` الذي تُطابَق الفواتير
// معه. تغيير الرقم قرار مقصود — عدّله هنا وهناك معاً.
// ============================================================================
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EXPECTED_MINUTES = 5;
const agent = await readFile('tools/ameen-sync-agent.ps1', 'utf8');
const watchdog = await readFile('tools/ensure-ameen-sync.ps1', 'utf8');

// المسار الإنتاجي الوحيد: استدعاء واحد لا أكثر، وإلا صار للدورية مصدرا حقيقة.
const invocations = [
  ...agent.matchAll(/push-customer-invoices\.ps1"\s+-MinimumIntervalMinutes\s+(\d+)/g),
];
assert.equal(
  invocations.length,
  1,
  `ameen-sync-agent.ps1 يجب أن يستدعي push-customer-invoices.ps1 مرة واحدة بدورية صريحة (وُجد ${invocations.length})`,
);

const minutes = Number(invocations[0][1]);
assert.equal(
  minutes,
  EXPECTED_MINUTES,
  `دورية رفع تفاصيل الفواتير يجب أن تبقى ${EXPECTED_MINUTES} دقائق (وُجدت ${minutes}). `
    + 'الرجوع إلى 60 يُعيد الفجوة التي تمنع إصدار مستند لفاتورة أُدخلت للتو.',
);

// الحارس الثاني: إن أُلغي تقاعد المهمة المستقلة صار للدورية مصدر ثانٍ صامت.
assert.match(
  watchdog,
  /\$retiredTasks\s*=\s*@\("TOBACCO Customer Invoices Push"\)/,
  'المهمة المستقلة «TOBACCO Customer Invoices Push» يجب أن تبقى متقاعدة — '
    + 'إحياؤها يخلق مصدر دورية ثانياً يتجاوز الوكيل.',
);

console.log(
  `Customer invoice sync cadence check passed (${EXPECTED_MINUTES} دقائق، استدعاء واحد، المهمة المستقلة متقاعدة).`,
);
