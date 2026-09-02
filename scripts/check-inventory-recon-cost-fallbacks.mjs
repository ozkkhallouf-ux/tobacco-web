// اختبار انحدار لملاحظة Codex P1 على PR #126.
//
// الخلفية: ترحيل 20260827110325_fix_item_costs_true_guid.sql أعاد تسمية
// item_costs.item_guid إلى match_key (GUID أو كود أو اسم — non-null دائماً)
// وأضاف عموداً جديداً item_guid يحمل GUID الأمين الحقيقي فقط أو NULL. أي مستهلك
// بقي يستعلم item_guid لمطابقة كود أو اسم صار يطابق عموداً لا يحوي أياً منهما،
// فيرجع لا شيء بصمت. هذا ما حصل في inventory_recon_create_session_with_lines:
// كل صنف بلا GUID أمين حقيقي كان يُدرَج بـunit_cost وcurrency فارغَين فتفسد
// قيمة التسوية دون أي خطأ ظاهر.
//
// هذا الفحص يحرس ثلاثة أشياء معاً:
//   1) عقد نصّي على SQL: الرجوع بالكود/الاسم على match_key لا على item_guid.
//   2) عدم انحراف الملف الأساسي عن الترحيل (نفس درس ملاحظة P1 على PR #140).
//   3) نموذج سلوكي حتمي يعيد تنفيذ أولوية المطابقة ويثبت أن صنفاً بلا GUID
//      حقيقي يحصل على تكلفته — ولو أُعيد الخطأ لفشل هذا الجزء وحده.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_FILE = 'inventory-reconciliation-table.sql';
const MIGRATION_FILE = '20260831051500_fix_inventory_recon_match_key_fallbacks.sql';

const canonical = await readFile(path.join(repoRoot, 'supabase', CANONICAL_FILE), 'utf8');
const migration = await readFile(path.join(repoRoot, 'supabase', 'migrations', 'superseded', MIGRATION_FILE), 'utf8');

// نُسقط تعليقات السطر الكامل قبل أي فحص على SQL حيّ، لأن رؤوس الملفات هنا
// تقتبس الصيغة المعطوبة القديمة حرفياً للتوثيق (نفس عُرف check-expense-entries-security).
const codeOnly = (sql) =>
  sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

// ---------- 1) استخراج الدالة من الملفين ----------
const START = 'create or replace function inventory_recon_create_session_with_lines(';
const extractFn = (sql, label) => {
  const s = sql.indexOf(START);
  assert.ok(s >= 0, `${label}: تعريف inventory_recon_create_session_with_lines مفقود`);
  const e = sql.indexOf('\n$$;\n', s);
  assert.ok(e >= 0, `${label}: نهاية تعريف الدالة مفقودة`);
  return sql.slice(s, e + '\n$$;\n'.length);
};
const fnCanonical = extractFn(canonical, CANONICAL_FILE);
const fnMigration = extractFn(migration, MIGRATION_FILE);

// ---------- 2) لا انحراف بين الملف الأساسي والترحيل ----------
// لو صُحّح أحدهما ونُسي الآخر لعادت الثغرة حيّة على قاعدة البيانات الفعلية
// (الترحيل هو ما يُنشر) أو لعادت عند إعادة تطبيق المخطط الأساسي.
assert.equal(
  fnMigration.trimEnd(),
  fnCanonical.trimEnd(),
  `انحراف بين ${CANONICAL_FILE} و${MIGRATION_FILE}: نص inventory_recon_create_session_with_lines يجب أن يكون متطابقاً حرفياً في الملفين.`,
);

// ---------- 3) عقد مسارات المطابقة على SQL الحيّ ----------
for (const [label, fnSql] of [[CANONICAL_FILE, codeOnly(fnCanonical)], [MIGRATION_FILE, codeOnly(fnMigration)]]) {
  // البحث المباشر بالـGUID يبقى على العمود الحقيقي item_guid.
  assert.match(
    fnSql,
    /where ic1\.item_guid = nullif\(trim\(coalesce\(it ->> 'itemGuid', it ->> 'item_guid', ''\)\), ''\)/,
    `${label}: البحث المباشر بالـGUID يجب أن يبقى على item_costs.item_guid.`,
  );
  // الرجوع بالكود وبالاسم يجب أن يكون على match_key.
  assert.match(
    fnSql,
    /ic3\.match_key = nullif\(trim\(coalesce\(it ->> 'itemNumber', it ->> 'item_number', ''\)\), ''\)/,
    `${label}: الرجوع بالكود يجب أن يستعلم match_key (item_guid لا يحوي أكواداً بعد ترحيل 20260827110325).`,
  );
  assert.match(
    fnSql,
    /lower\(trim\(ic4\.item_name\)\) = lower\(nullif\(trim\(coalesce\(it ->> 'itemName', it ->> 'item_name', ''\)\), ''\)\)/,
    `${label}: الرجوع بالاسم يجب أن يستعلم العمود المخصَّص item_name — match_key يحمل كود الأمين للصفوف بلا GUID فلا يلتقط الاسم.`,
  );
  // ولا يجوز أن يعود الرجوع بالاسم إلى match_key: كود الأمين (Code) ورقم التقرير
  // (mt.Number) حقلان مختلفان، فالصفوف المحفوظة بالكود تفلت من كل المسارات.
  assert.doesNotMatch(
    fnSql,
    /lower\(trim\(ic\d\.match_key\)\)\s*=\s*lower/,
    `${label}: عودة الثغرة — الرجوع بالاسم على match_key يفوّت كل صف كُتب بكود الأمين.`,
  );
  // بحث GUID احتياطي على match_key يغطي الصفوف السابقة لتشغيل push التالي.
  assert.match(
    fnSql,
    /ic2\.match_key = nullif\(trim\(coalesce\(it ->> 'itemGuid', it ->> 'item_guid', ''\)\), ''\)/,
    `${label}: يجب وجود رجوع GUID على match_key للصفوف التي لم يُملأ فيها item_guid بعد.`,
  );

  // الحارس الجوهري: لا يجوز إطلاقاً مطابقة رقم أو اسم صنف على العمود item_guid.
  assert.doesNotMatch(
    fnSql,
    /item_guid\s*=\s*nullif\(trim\(coalesce\(it ->> 'itemNumber'/,
    `${label}: عودة الثغرة — مطابقة رقم الصنف على item_guid لا تطابق شيئاً بعد الترحيل.`,
  );
  assert.doesNotMatch(
    fnSql,
    /lower\(trim\(ic\d\.item_guid\)\)\s*=\s*lower/,
    `${label}: عودة الثغرة — مطابقة اسم الصنف على item_guid لا تطابق شيئاً بعد الترحيل.`,
  );

  // ترتيب الأولوية النهائي يجب أن يضم المسارات الأربعة بالترتيب الصحيح.
  assert.match(
    fnSql,
    /coalesce\(ic_by_guid\.avg_cost, ic_by_legacy_guid\.avg_cost, ic_by_number\.avg_cost, ic_by_name\.avg_cost\)/,
    `${label}: أولوية اختيار التكلفة يجب أن تكون GUID ثم match_key(GUID) ثم الكود ثم الاسم.`,
  );
  assert.match(
    fnSql,
    /coalesce\(ic_by_guid\.currency, ic_by_legacy_guid\.currency, ic_by_number\.currency, ic_by_name\.currency\)/,
    `${label}: أولوية اختيار العملة يجب أن تطابق أولوية التكلفة تماماً.`,
  );
}

// ---------- 4) نموذج سلوكي حتمي لأولوية المطابقة ----------
// يعيد تنفيذ سلسلة المسارات الأربعة على بيانات item_costs مصغّرة. الغرض إثبات
// السلوك لا مجرد شكل النص: لو رجع أي مسار إلى العمود الخطأ لفشل هنا صراحةً.
const norm = (v) => (typeof v === 'string' ? v.trim() : '') || null;
const lower = (v) => (v === null ? null : v.toLowerCase());

function resolveCost(rows, item, { numberFallbackColumn = 'match_key', nameFallbackColumn = 'item_name' } = {}) {
  const guid = norm(item.itemGuid);
  const number = norm(item.itemNumber);
  const name = norm(item.itemName);
  const pick = (fn) => rows.find(fn) || null;

  const byGuid = guid === null ? null : pick((r) => norm(r.item_guid) === guid);
  if (byGuid) return byGuid;
  const byLegacyGuid = guid === null ? null : pick((r) => norm(r.match_key) === guid);
  if (byLegacyGuid) return byLegacyGuid;
  const byNumber = number === null ? null : pick((r) => norm(r[numberFallbackColumn]) === number);
  if (byNumber) return byNumber;
  const byName = name === null ? null : pick((r) => lower(norm(r[nameFallbackColumn])) === lower(name));
  return byName;
}

// item_costs كما يكتبه push-item-costs.ps1 بعد الترحيل.
const rows = [
  { match_key: 'GUID-AAA', item_guid: 'GUID-AAA', item_name: 'دخان أ', avg_cost: 10, currency: '$' },
  { match_key: 'CODE-777', item_guid: null,       item_name: 'دخان ب', avg_cost: 20, currency: '$' },
  { match_key: 'دخان ج',   item_guid: null,       item_name: 'دخان ج', avg_cost: 30, currency: '$' },
  // الحالة التي رصدها Codex: view التكلفة أعطى Code بلا GUID فحُفظ في match_key،
  // بينما تقرير المخزون يرسل mt.Number المختلف — لا GUID ولا رقم يطابق هذا الصف.
  { match_key: 'CODE-ABC', item_guid: null,       item_name: 'دخان هـ', avg_cost: 50, currency: '$' },
  { match_key: 'GUID-LEG', item_guid: null,       item_name: 'دخان د', avg_cost: 40, currency: '$' },
];

// الحالة التي كسرها الترحيل: صنف بلا GUID أمين حقيقي، يُطابَق بالكود.
assert.equal(
  resolveCost(rows, { itemGuid: null, itemNumber: 'CODE-777', itemName: 'دخان ب' })?.avg_cost,
  20,
  'صنف بلا GUID أمين حقيقي يجب أن يأخذ تكلفته عبر الرجوع بالكود على match_key.',
);
// والحالة الثانية: يُطابَق بالاسم.
assert.equal(
  resolveCost(rows, { itemGuid: null, itemNumber: null, itemName: '  دخان ج  ' })?.avg_cost,
  30,
  'صنف بلا GUID وبلا كود يجب أن يأخذ تكلفته عبر الرجوع بالاسم على match_key (متسامح مع الفراغات/حالة الأحرف).',
);
// المسار المباشر يبقى الأعلى أولوية حتى لو اختلف الاسم المخزَّن عن اسم التقرير.
assert.equal(
  resolveCost(rows, { itemGuid: 'GUID-AAA', itemNumber: 'CODE-777', itemName: 'اسم مختلف تماماً' })?.avg_cost,
  10,
  'مطابقة item_guid المباشرة يجب أن تتقدّم على كل رجوع آخر.',
);
// صف قديم لم يُملأ فيه item_guid بعد: الـGUID ما يزال في match_key.
assert.equal(
  resolveCost(rows, { itemGuid: 'GUID-LEG', itemNumber: null, itemName: 'دخان د' })?.avg_cost,
  40,
  'صف كُتب قبل تشغيل push التالي يجب أن يُطابَق بالـGUID عبر match_key.',
);
// صنف مجهول تماماً يبقى بلا تكلفة (NULL) ولا يُصفَّر.
assert.equal(
  resolveCost(rows, { itemGuid: 'GUID-ZZZ', itemNumber: 'CODE-000', itemName: 'غير موجود' }),
  null,
  'صنف بلا أي مطابقة يجب أن يبقى بتكلفة NULL، لا صفراً.',
);
// اسم فارغ يجب ألا يطابق أي صف (وإلا التقط أول صف عشوائياً بتكلفة خاطئة).
assert.equal(
  resolveCost([{ match_key: '   ', item_guid: null, item_name: '', avg_cost: 99, currency: '$' }],
    { itemGuid: null, itemNumber: null, itemName: '   ' }),
  null,
  'اسم صنف فارغ يجب ألا يطابق أي صف في item_costs.',
);

// الحالة التي رصدها Codex في مراجعته الثانية: صف محفوظ بكود الأمين ورقم تقرير
// مختلف — يجب أن يُنقذه الرجوع بالاسم على العمود المخصَّص item_name.
assert.equal(
  resolveCost(rows, { itemGuid: null, itemNumber: 'NUM-999', itemName: 'دخان هـ' })?.avg_cost,
  50,
  'صف محفوظ بكود الأمين ورقم تقرير مختلف يجب أن يُطابَق بالاسم على item_name.',
);
// وبالسلوك السابق (الرجوع بالاسم على match_key) يفقد هذا الصف تكلفته تماماً.
assert.equal(
  resolveCost(rows, { itemGuid: null, itemNumber: 'NUM-999', itemName: 'دخان هـ' }, { nameFallbackColumn: 'match_key' }),
  null,
  'النموذج المرجعي: الرجوع بالاسم على match_key يفوّت الصفوف المحفوظة بكود الأمين.',
);

// إثبات أن هذا الفحص يرصد الانحدار فعلاً: بالسلوك المعطوب (الرجوع على item_guid)
// يفقد الصنف بلا GUID حقيقي تكلفته تماماً — وهي الثغرة التي رصدها Codex.
const broken = resolveCost(rows, { itemGuid: null, itemNumber: 'CODE-777', itemName: 'دخان ب' }, {
  numberFallbackColumn: 'item_guid',
  nameFallbackColumn: 'item_guid',
});
assert.equal(broken, null, 'النموذج المرجعي للسلوك المعطوب يجب أن يُظهر فقدان التكلفة (وإلا فالفحص لا يرصد شيئاً).');

console.log('check-inventory-recon-cost-fallbacks: OK — GUID على item_guid، الكود على match_key، الاسم على item_name، لا انحراف بين المخطط والترحيل، وأولوية المطابقة مثبتة سلوكياً.');
