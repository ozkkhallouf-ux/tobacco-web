import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// عطل إنتاجي حيّ (2026-08-31): مهمة "TOBACCO Expense Entries Push" كانت غير
// مسجّلة إطلاقاً على OZK2026 بين 12 و25 آب، فتوقف خط المصاريف ١٩ يوماً بلا
// إنذار واحد. مراقب Windows (tools/ensure-ameen-sync.ps1) يكتشف المهام
// الموجودة فقط، فمهمة محذوفة غير مرئية له أصلاً — والطبقة الوحيدة القادرة
// على كشف ذلك هي صف في private.project_task_monitors يراقب البيانات نفسها.
//
// هذا الفحص يمنع تكرار العمى نفسه: لو حُذف صف مراقبة أو خُفِّضت حساسيته أو
// انقطع الرابط بين سكربت الرفع والجدول الذي يراقبه، يسقط CI بدل أن يمرّ
// التغيير بصمت ونكتشفه بعد أسابيع من التقارير الصفرية.
const MONITOR_SQL = 'supabase/project-task-health-monitor.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = await readFile(path.join(repoRoot, MONITOR_SQL), 'utf8');

// ---------------------------------------------------------------------------
// 1) قائمة الأعمدة يجب أن تبقى كما هي — لو أُعيد ترتيبها فالتفكيك أدناه
//    سيُسند القيم لأعمدة خاطئة ويمرّ الفحص كاذباً.
// ---------------------------------------------------------------------------
const COLUMNS = ['task_key', 'task_label', 'report_source', 'max_age_minutes', 'enabled', 'source_table'];
const insertHeader = new RegExp(
  `insert into private\\.project_task_monitors\\(${COLUMNS.join(',')}\\) values`,
  'i',
);
assert.match(
  sql,
  insertHeader,
  `${MONITOR_SQL}: قائمة أعمدة insert تغيّرت — حدّث COLUMNS في هذا الفحص قبل أي شيء آخر`,
);

// ---------------------------------------------------------------------------
// 2) تفكيك صفوف المراقبة. التعليقات داخل قائمة values موثّقة بكثافة في هذا
//    الملف (وهي مقصودة)، فتُجرَّد أسطر "--" قبل المطابقة.
// ---------------------------------------------------------------------------
const valuesBlock = sql.slice(
  sql.search(insertHeader),
  sql.search(/on conflict\(task_key\)/i),
);
const codeOnly = valuesBlock
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const rows = [...codeOnly.matchAll(/\('([^']*)','([^']*)','([^']*)',(\d+),(true|false),'([^']*)'\)/g)].map(
  (m) => ({
    task_key: m[1],
    task_label: m[2],
    report_source: m[3],
    max_age_minutes: Number(m[4]),
    enabled: m[5] === 'true',
    source_table: m[6],
  }),
);

// عدد الصفوف المفكَّكة يجب أن يساوي عدد الفواصل الحقيقية + 1، وإلا فصف ما
// بصيغة لم يلتقطها التعبير أعلاه (مثلاً قيمة تحوي فاصلة عليا) ومرّ بصمت.
const tupleCount = (codeOnly.match(/\(\s*'/g) ?? []).length;
assert.equal(
  rows.length,
  tupleCount,
  `${MONITOR_SQL}: فُكِّك ${rows.length} صفاً من أصل ${tupleCount} — صيغة صف لم يلتقطها الفحص`,
);
assert.ok(rows.length > 0, `${MONITOR_SQL}: لم يُقرأ أي صف مراقبة`);

const byKey = new Map(rows.map((row) => [row.task_key, row]));

// ---------------------------------------------------------------------------
// 3) لا خط مراقَب يختفي بصمت. حذف أي مفتاح من هنا يجب أن يكون قراراً معلناً
//    يمرّ بمراجعة، لا سطراً يسقط في rebase.
// ---------------------------------------------------------------------------
const REQUIRED_TASK_KEYS = [
  'ameen-main',
  'customer-balances',
  'customer-movements',
  'customer-invoices',
  'daily-profit',
  'price-sync',
  'invoice-series',
  'item-details',
  'khalil-audit',
  'expense-entries',
];
for (const key of REQUIRED_TASK_KEYS) {
  assert.ok(byKey.has(key), `${MONITOR_SQL}: صف المراقبة "${key}" مفقود — لا تُحذف خطاً من المراقبة بلا قرار صريح`);
  assert.equal(byKey.get(key).enabled, true, `${MONITOR_SQL}: صف المراقبة "${key}" معطّل (enabled=false)`);
}

// ---------------------------------------------------------------------------
// 4) قيود الجدول نفسها، مطبَّقة قبل الوصول للإنتاج: report_source فريد
//    (unique في DDL) وmax_age_minutes داخل مدى check constraint.
// ---------------------------------------------------------------------------
const seenKeys = new Set();
const seenSources = new Set();
for (const row of rows) {
  assert.ok(!seenKeys.has(row.task_key), `${MONITOR_SQL}: task_key مكرر — ${row.task_key}`);
  seenKeys.add(row.task_key);
  assert.ok(
    !seenSources.has(row.report_source),
    `${MONITOR_SQL}: report_source مكرر — "${row.report_source}" يخرق قيد unique ويُفشل الملف كاملاً عند التطبيق`,
  );
  seenSources.add(row.report_source);
  assert.ok(
    row.max_age_minutes >= 5 && row.max_age_minutes <= 10080,
    `${MONITOR_SQL}: max_age_minutes خارج مدى check constraint (5..10080) — ${row.task_key}=${row.max_age_minutes}`,
  );
  // source_table يُمرَّر إلى format('%I') داخل monitor_project_tasks، فيجب أن
  // يبقى معرّفاً بسيطاً لا تعبيراً.
  assert.match(
    row.source_table,
    /^[a-z_][a-z0-9_]*$/,
    `${MONITOR_SQL}: source_table ليس معرّفاً بسيطاً — ${row.task_key}="${row.source_table}"`,
  );
}

// ---------------------------------------------------------------------------
// 5) صف المصاريف بقيمه المثبتة. المهمة تعمل كل ٣٠ دقيقة (PT30M)، و90 = ٣
//    أضعاف الدورة: تتحمّل تشغيلتين فائتتين على جهاز محمول يُطفأ ساعات، وهي
//    نفس عتبة customer-invoices المثبتة في التصميم. خفضها يعني إنذارات
//    كاذبة، ورفعها يعني عودة العمى الذي أخفى العطل ١٩ يوماً.
// ---------------------------------------------------------------------------
const expense = byKey.get('expense-entries');
assert.equal(expense.report_source, 'expense_entries', `${MONITOR_SQL}: report_source لصف المصاريف تغيّر`);
assert.equal(expense.source_table, 'expense_entries', `${MONITOR_SQL}: source_table لصف المصاريف تغيّر`);
assert.equal(
  expense.max_age_minutes,
  90,
  `${MONITOR_SQL}: عتبة المصاريف يجب أن تبقى 90 دقيقة (٣ × دورة PT30M) — أي تغيير يحتاج قراراً موثّقاً`,
);

// ---------------------------------------------------------------------------
// 6) الرابط بين سكربت الرفع والجدول المراقَب. لو غيّر أحدهم وجهة الكتابة في
//    السكربت وترك صف المراقبة على جدول لم يعد يُكتب فيه، يصبح المراقب أخضر
//    على جدول ميت — وهو أسوأ من غياب المراقبة لأنه يطمئن كذباً.
// ---------------------------------------------------------------------------
const pushScript = await readFile(path.join(repoRoot, 'tools', 'push-expense-entries.ps1'), 'utf8');
assert.match(
  pushScript,
  new RegExp(`rest/v1/${expense.source_table}\\b`),
  `tools/push-expense-entries.ps1: لم يعد يكتب في ${expense.source_table} الذي يراقبه صف "expense-entries"`,
);

// ---------------------------------------------------------------------------
// 7) الآلية التي يعتمد عليها صف المصاريف يجب أن تبقى قائمة: قراءة
//    max(created_at) من جدول مخصّص لكل صف source_table != inventory_reports.
// ---------------------------------------------------------------------------
assert.match(
  sql,
  /execute format\('select max\(created_at\) from public\.%I', cfg\.source_table\) into last_at;/,
  `${MONITOR_SQL}: مسار الجدول المخصّص في monitor_project_tasks اختفى — صفوف source_table المخصّصة تصبح بلا قراءة`,
);
assert.match(
  sql,
  /select max\(created_at\) into last_at from public\.inventory_reports where source=cfg\.report_source;/,
  `${MONITOR_SQL}: مسار inventory_reports الافتراضي اختفى — بقية الصفوف تصبح بلا قراءة`,
);

// ---------------------------------------------------------------------------
// 8) منطق check_status الخاص بخليل لا يُمَس. expense_entries جدول بيانات بلا
//    عمود status، فلو شمله هذا التحديث يوماً لصار المراقب يقرأ عموداً غير
//    موجود ويسقط بخطأ في كل دورة.
// ---------------------------------------------------------------------------
const checkStatusUpdates = [
  ...sql.matchAll(/update private\.project_task_monitors set check_status=(true|false) where task_key='([^']*)'/g),
];
assert.equal(checkStatusUpdates.length, 1, `${MONITOR_SQL}: عدد تحديثات check_status تغيّر — المتوقع واحد فقط`);
assert.equal(checkStatusUpdates[0][1], 'true');
assert.equal(
  checkStatusUpdates[0][2],
  'khalil-audit',
  `${MONITOR_SQL}: check_status مخصّص لصف خليل وحده — الجداول بلا عمود status تسقط المراقب`,
);

// ---------------------------------------------------------------------------
// 9) إعادة التشغيل يجب أن تُقارِب فعلاً: on conflict يحدّث كل عمود مُدرَج عدا
//    المفتاح، وإلا صار تعديل عتبة في الملف بلا أثر على الإنتاج بعد أول تطبيق.
// ---------------------------------------------------------------------------
// القصّ عند الفاصلة المنقوطة لا بعدد أحرف ثابت: خارج العبارة تعليقات عربية
// مطوّلة، وأي نافذة تقديرية قد تلتقط نصاً منها وتمرّ كاذبة.
const onConflictStart = sql.search(/on conflict\(task_key\) do update set/i);
const onConflict = sql.slice(onConflictStart, sql.indexOf(';', onConflictStart));
for (const column of COLUMNS.filter((c) => c !== 'task_key')) {
  assert.match(
    onConflict,
    new RegExp(`${column}=excluded\\.${column}`),
    `${MONITOR_SQL}: on conflict لا يحدّث ${column} — تعديل الملف لن ينعكس على صف موجود`,
  );
}

console.log(`Project task monitor coverage checks passed (${rows.length} صفاً، منها expense-entries عند ${expense.max_age_minutes} دقيقة).`);
