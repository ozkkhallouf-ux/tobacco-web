// ============================================================================
// فحص انحداري: **تغيير هوية البطاقة كان يمرّ بلا أثر في سجل التدقيق.**
//
// العطل الذي يمنعه: `public.write_business_audit_log()` تُعفي
// approved_price_items وحدها من التسجيل عند UPDATE ما لم تتغيّر إحدى خمس قيم
// سعرية. الإعفاء نفسه صحيح — مزامنة المخزون تكتب stock_qty وsource_synced_at
// كل دقيقة — لكن القائمة أغفلت item_key وitem_guid، وهما عمودا الهوية. فإعادة
// ربط صف ببطاقة أمين أخرى كانت أخطر تعديل ممكن على الجدول، وكانت التعديل
// الوحيد غير المرئي.
//
// قياس الإنتاج الذي أثبته (2026-09-21): 1139 حدث UPDATE مسجّلاً، منها صفر
// يختلف فيه item_key وصفر يختلف فيه item_guid — بينما جرت 18 هجرة مفتاح و10
// عمليات backfill للهوية.
//
// ماذا يفحص هذا الملف: لا يطابق نصاً. يستخرج **فرع الإعفاء** من الهجرة، يحلّل
// منه مجموعة الحقول المحروسة، ثم يُجري جدول سيناريوهات كاملاً عبر تنفيذٍ
// جافاسكريبتي لدلالة الفرع مبنيّ على تلك المجموعة المستخرجة. فحذف item_guid من
// الهجرة لا يُسقط تأكيداً واحداً بل يُسقط سيناريو C وD وH معاً.
//
// ويحرس أيضاً ما لا يجوز أن يتغيّر: نطاق الفرع (approved_price_items وحده)،
// وبنية الحمولة (سبعة أعمدة كما هي)، وتعبير entity_id، وسمات الدالة الأمنية.
// ============================================================================

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATION = 'supabase/migrations/20260921120000_business_audit_log_item_identity_changes.sql';
const SQL_TEST = 'supabase/tests/business-audit-item-identity.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = await readFile(path.join(repoRoot, MIGRATION), 'utf8');
const sqlTest = await readFile(path.join(repoRoot, SQL_TEST), 'utf8');

// التعليقات تشرح العطل وقد تذكر أسماء الحقول؛ التحليل يجري على الكود وحده.
const codeOnly = (text) =>
  text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
const code = codeOnly(migration);

const results = [];
let failed = 0;
function test(name, fn) {
  try {
    fn();
    results.push(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  ❌ ${name}\n     ${error && error.message}`);
  }
}


// ---------------------------------------------------------------------------
// 1) عزل فرع الإعفاء من الكود — لا regex على الملف كله.
// ---------------------------------------------------------------------------
// يُعزل الفرع بحدوده البنيوية (`if` … `end if;`) لا بنصّ شرطه الأول — وإلا
// كان إسقاطُ حارس الجدول يُخفي الفرع فيتحوّل أخطرُ انحدار إلى «لم أجد شيئاً».
const branchStart = code.search(/\bif\s+tg_/);
const branchEnd = code.indexOf('end if;', branchStart >= 0 ? branchStart : 0);
const branch = branchStart >= 0 && branchEnd > branchStart ? code.slice(branchStart, branchEnd) : '';

test('فرع الإعفاء موجود ومعزول', () => {
  assert.notEqual(branchStart, -1, `${MIGRATION}: لا فرع إعفاء في الدالة`);
  assert.ok(branchEnd > branchStart, `${MIGRATION}: فرع الإعفاء بلا end if`);
});

// المجموعة المستخرجة فعلياً من شروط `(a->'X') is not distinct from (b->'X')`.
const guarded = [...branch.matchAll(
  /\(\s*a\s*->\s*'([a-z0-9_]+)'\s*\)\s*is\s+not\s+distinct\s+from\s*\(\s*b\s*->\s*'\1'\s*\)/gi,
)].map((m) => m[1]);

// الحقول الخمسة القائمة قبل الإصلاح — لا يجوز أن يسقط أحدها بحجة التبسيط.
const PRE_EXISTING = ['sale_price', 'unit1_price', 'unit2_price', 'price_payload', 'notes'];
// عمودا الهوية — سبب وجود هذا الإصلاح.
const IDENTITY = ['item_key', 'item_guid'];

test('فرع الإعفاء محكوم بـapproved_price_items وحده (لا يتسرّب لجدول آخر)', () => {
  assert.match(
    branch, /tg_table_name\s*=\s*'approved_price_items'\s+and\s+tg_op\s*=\s*'UPDATE'/,
    'الفرع لم يعد محصوراً بالجدول والعملية — الجداول الأخرى ستتأثر',
  );
});

test('الحقول الخمسة القائمة ما تزال محروسة (لا انحدار على السلوك السابق)', () => {
  for (const field of PRE_EXISTING) {
    assert.ok(guarded.includes(field), `سقط حقل محروس من فرع الإعفاء: ${field}`);
  }
});

test('عمودا الهوية item_key وitem_guid دخلا فرع الإعفاء', () => {
  for (const field of IDENTITY) {
    assert.ok(guarded.includes(field), `عمود الهوية غير محروس: ${field} — تغييره سيمرّ صامتاً`);
  }
});

test('لا حقل زائد تسلّل إلى فرع الإعفاء', () => {
  const expected = new Set([...PRE_EXISTING, ...IDENTITY]);
  const extra = guarded.filter((f) => !expected.has(f));
  assert.deepEqual(extra, [], `حقول غير متوقَّعة في فرع الإعفاء: ${extra.join(', ')}`);
  assert.equal(guarded.length, expected.size, `تكرار في شروط الفرع: ${guarded.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 2) جدول السيناريوهات — يُنفَّذ عبر دلالة الفرع المبنيّة من المجموعة المستخرجة.
//    `skips` يعني: الحدث لا يُسجَّل.
// ---------------------------------------------------------------------------
const skips = (table, op, before, after) => {
  if (table !== 'approved_price_items' || op !== 'UPDATE') return false;
  // `is not distinct from` على القيمة الخام: null يساوي null، والمقارنة حسّاسة للحالة.
  return guarded.every((f) => Object.is(before[f] ?? null, after[f] ?? null));
};

const ROW = {
  sale_price: 10, unit1_price: 10, unit2_price: 100, price_payload: null, notes: null,
  item_key: 'k-a', item_guid: 'AAAAAAAA-0000-0000-0000-000000000001',
  stock_qty: 5, source_synced_at: 't0', updated_at: 't0', item_name: 'A',
};
const withChange = (patch) => ({ ...ROW, ...patch });

const SCENARIOS = [
  ['A  تعديل سعر فقط يُسجَّل', ROW, withChange({ sale_price: 11 }), false],
  ['E  مزامنة المخزون وحدها لا تُسجَّل', ROW, withChange({ stock_qty: 99, source_synced_at: 't1', updated_at: 't1' }), true],
  ['E2 إسناد الهوية لنفسها لا يُسجَّل', ROW, withChange({}), true],
  ['B  تغيير item_key وحده يُسجَّل', ROW, withChange({ item_key: 'k-a-renamed' }), false],
  ['C  تغيير item_guid وحده يُسجَّل', ROW, withChange({ item_guid: 'AAAAAAAA-0000-0000-0000-00000000000F' }), false],
  ['D  تغيير الاثنين معاً يُسجَّل', ROW, withChange({ item_key: 'k2', item_guid: 'BBBBBBBB-0000-0000-0000-000000000002' }), false],
  ['H1 NULL ← GUID يُسجَّل', withChange({ item_guid: null }), withChange({ item_guid: 'BBBBBBBB-0000-0000-0000-000000000002' }), false],
  ['H2 GUID ← NULL يُسجَّل', ROW, withChange({ item_guid: null }), false],
  ['I  تغيير حالة الأحرف وحده يُسجَّل (دلالة القيمة الخام)', ROW, withChange({ item_guid: 'aaaaaaaa-0000-0000-0000-000000000001' }), false],
  ['K  تغيير item_name وحده يبقى بلا تسجيل (خارج النطاق)', ROW, withChange({ item_name: 'A-renamed' }), true],
];

for (const [name, before, after, expectSkip] of SCENARIOS) {
  test(name, () => {
    assert.equal(
      skips('approved_price_items', 'UPDATE', before, after), expectSkip,
      expectSkip ? 'الحدث سجّل ضجيجاً لا يجب تسجيله' : 'الحدث مرّ صامتاً وكان يجب تسجيله',
    );
  });
}

test('INSERT وDELETE لا يمرّان بفرع الإعفاء إطلاقاً', () => {
  assert.equal(skips('approved_price_items', 'INSERT', {}, ROW), false, 'INSERT صار قابلاً للإعفاء');
  assert.equal(skips('approved_price_items', 'DELETE', ROW, {}), false, 'DELETE صار قابلاً للإعفاء');
});

test('الجداول الأخرى الحاملة لنفس الـtrigger لا يمسّها الإعفاء', () => {
  for (const table of ['customer_credit_limits', 'payment_records', 'purchase_invoices']) {
    assert.equal(
      skips(table, 'UPDATE', ROW, withChange({})), false,
      `${table}: صار UPDATE بلا تغيير معفى — توسيع غير مقصود لدلالة التدقيق`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3) التوافق الرجعي: الحمولة وبنية الكتابة كما هي حرفياً.
// ---------------------------------------------------------------------------
test('الحمولة لقطتان كاملتان للصف — لا حقول مُنتقاة', () => {
  assert.match(code, /b\s*:=\s*case when tg_op='INSERT' then null else to_jsonb\(old\) end;/, 'before_data لم يعد لقطة كاملة');
  assert.match(code, /a\s*:=\s*case when tg_op='DELETE' then null else to_jsonb\(new\) end;/, 'after_data لم يعد لقطة كاملة');
});

test('أعمدة الكتابة في business_audit_log لم تتغيّر (سبعة، بنفس الترتيب)', () => {
  const m = code.match(/insert into public\.business_audit_log\(([^)]*)\)/);
  assert.ok(m, 'عبارة الإدراج في business_audit_log غير موجودة');
  assert.deepEqual(
    m[1].split(',').map((s) => s.trim()),
    ['actor_id', 'actor_email', 'entity_table', 'entity_id', 'action', 'before_data', 'after_data'],
    'تغيّرت أعمدة سجل التدقيق — كسر توافق رجعي',
  );
});

test('تعبير entity_id لم يتغيّر', () => {
  assert.match(
    code,
    /eid\s*:=\s*coalesce\(a->>'id',b->>'id',a->>'customer_key',b->>'customer_key',a->>'item_key',b->>'item_key'\);/,
    'تغيّر اشتقاق entity_id — القراءات التاريخية تنكسر',
  );
});

test('سمات الدالة الأمنية محفوظة ولا grant جديد', () => {
  assert.match(code, /create or replace function public\.write_business_audit_log\(\)/, 'ليست create or replace على نفس الاسم');
  assert.match(code, /security definer/i, 'سقطت security definer');
  assert.match(code, /set search_path to 'public'/i, "سقط search_path المثبّت");
  assert.doesNotMatch(code, /\bgrant\b/i, 'grant داخل هجرة دالة SECURITY DEFINER — توسيع سطح بلا سبب');
  assert.doesNotMatch(code, /\balter function\b/i, 'alter function قد يغيّر المالك أو الصلاحيات');
});

test('الهجرة لا تكتب في أي صف عمل ولا تختلق أحداثاً تاريخية', () => {
  for (const forbidden of [/\bupdate\s+public\./i, /\bdelete\s+from\s+public\./i, /\btruncate\b/i, /\bdrop\s+(table|index)\b/i]) {
    assert.doesNotMatch(code, forbidden, `الهجرة تعدّل بيانات: ${forbidden}`);
  }
  const inserts = [...code.matchAll(/insert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
  assert.deepEqual(
    inserts, ['public.business_audit_log'],
    'الهجرة تُدرج صفوفاً خارج جسم الدالة — لا backfill ولا أحداث بأثر رجعي',
  );
});

// ---------------------------------------------------------------------------
// 4) الاختبار السلوكي الحيّ موجود، آمن، ويغطّي السيناريوهات.
// ---------------------------------------------------------------------------
test('اختبار SQL الحيّ يعمل على جدول مؤقت ويُلغي معاملته', () => {
  assert.match(sqlTest, /create temp table approved_price_items \(like public\.approved_price_items/, 'لا يبني جدولاً مؤقتاً — قد يلمس الإنتاج');
  assert.doesNotMatch(
    codeOnly(sqlTest), /(update|delete from|insert into)\s+public\.approved_price_items/i,
    'اختبار SQL يكتب في جدول الإنتاج',
  );
  const testCode = codeOnly(sqlTest);
  const raises = (testCode.match(/raise exception/g) || []).length;
  const blocks = (testCode.match(/^do \$/gm) || []).length;
  assert.equal(raises, blocks, `كل كتلة اختبار يجب أن تنتهي بـraise ليُلغى أثرها — ${raises} raise مقابل ${blocks} كتلة`);
});

test('اختبار SQL الحيّ يغطّي كل سيناريوهات الهوية', () => {
  for (const marker of ['F  INSERT', 'A  price-only', 'E  stock/sync-only', 'E2 self-assign',
    'B  item_key-only', 'C  item_guid-only', 'D  key+guid one statement', 'G  DELETE',
    'H1 NULL -> GUID', 'H2 GUID -> NULL', 'I  casing-only guid', 'SCOPE no-op UPDATE']) {
    assert.ok(sqlTest.includes(marker), `سيناريو ناقص من اختبار SQL: ${marker}`);
  }
});

console.log('فحص تسجيل تغييرات هوية البطاقة في سجل التدقيق:');
console.log(results.join('\n'));
if (failed > 0) {
  console.error(`\n❌ ${failed} فحص فاشل`);
  process.exit(1);
}
console.log(`\n✅ ${results.length} فحصاً ناجحاً`);
