import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// عطل إنتاجي حيّ (2026-08-31) — كان مضلّلاً لأن الدخول نفسه يبقى ناجحاً:
//
// جلسات موظفي الجرد تحمل دور قاعدة البيانات 'anon' عمداً (أقل امتياز ممكن، انظر
// migration 20260823084956)، وذلك الملف منح الدوال الست للـanon. لكن المخطط
// المرجعي supabase/smart-inventory.sql كان ينتهي بـ:
//     revoke all on function ...الدوال الست... from public,anon;
//     grant  execute on function ...              to authenticated;
// فمن أعاد تشغيل المخطط المرجعي على الإنتاج بعد ذلك التاريخ سحب الصلاحية من
// anon. النتيجة: تسجيل الدخول ينجح (Edge Function تُصادق بـservice_role)، ثم
// تموت صفحة الجرد الذكي عند أول RPC بـ
//     permission denied for function smart_inventory_available_warehouses
// وهو ما ثبت حياً بتوكن موظف جرد حقيقي.
//
// المخطط المرجعي والـmigration كانا يتناقضان مباشرةً، ولا شيء كان يمنع التناقض
// من العودة. هذا الفحص يمنعه من الطرفين، ويثبّت أيضاً أن أمان المنحة قائم على
// الحارس داخل الدالة لا على المنحة نفسها.

const SCHEMA = 'supabase/smart-inventory.sql';
const ISOLATION = 'supabase/migrations/20260823084956_smart_inventory_counter_isolation.sql';
const RESTORE = 'supabase/migrations/20260831134500_restore_counter_rpc_grants_to_anon.sql';

// الدوال الست التي تشكّل مسار العدّ الأعمى كاملاً — بدونها الصفحة لا تعمل إطلاقاً.
const COUNTER_RPCS = [
  'smart_inventory_available_warehouses',
  'smart_inventory_start_or_join',
  'smart_inventory_counter_session',
  'smart_inventory_claim_item',
  'smart_inventory_save_item',
  'smart_inventory_complete_session',
];
const OWNER_RPCS = [
  'smart_inventory_owner_dashboard',
  'smart_inventory_owner_report',
  'smart_inventory_owner_open_recount',
  'smart_inventory_owner_reopen_session',
  'smart_inventory_owner_correct_item',
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(repoRoot, rel), 'utf8');
const [schema, isolation, restore] = await Promise.all([SCHEMA, ISOLATION, RESTORE].map(read));

const stripComments = (text) =>
  text.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

// يفكّ كل عبارة grant/revoke على الدوال إلى (نوع, أسماء الدوال, الأدوار).
function privilegeStatements(sql) {
  return stripComments(sql)
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => /^(grant|revoke)\s+(execute|all)\b[\s\S]*\bon function\b/i.test(statement))
    .map((statement) => {
      const kind = /^grant/i.test(statement) ? 'grant' : 'revoke';
      const tail = statement.split(kind === 'grant' ? /\bto\b/i : /\bfrom\b/i).pop();
      return {
        kind,
        functions: new Set([...statement.matchAll(/public\.(smart_inventory_\w+)/g)].map((m) => m[1])),
        roles: new Set(tail.split(',').map((role) => role.trim().toLowerCase()).filter(Boolean)),
      };
    });
}

// الصلاحية الفعلية بعد تنفيذ الملف بالترتيب: آخر عبارة تمسّ (دالة، دور) هي الحاكمة.
function anonCanExecute(sql, fn) {
  let granted = false;
  for (const statement of privilegeStatements(sql)) {
    if (!statement.functions.has(fn)) continue;
    if (!statement.roles.has('anon')) continue;
    granted = statement.kind === 'grant';
  }
  return granted;
}

// ---------------------------------------------------------------------------
// ١) المخطط المرجعي: الدوال الست يجب أن تنتهي ممنوحة لـanon، لا مسحوبة منه.
//    هذا بالضبط ما انقلب على الإنتاج وأوقف الجرد.
// ---------------------------------------------------------------------------
for (const fn of COUNTER_RPCS) {
  assert.equal(
    anonCanExecute(schema, fn), true,
    `${SCHEMA}: ${fn} يجب أن تبقى ممنوحة لـanon — سحبها يوقف صفحة الجرد الذكي بينما يبقى الدخول ناجحاً`,
  );
  assert.equal(
    anonCanExecute(isolation, fn), true,
    `${ISOLATION}: ${fn} يجب أن تبقى ممنوحة لـanon`,
  );
  assert.equal(
    anonCanExecute(restore, fn), true,
    `${RESTORE}: ${fn} يجب أن تُستعاد منحتها لـanon`,
  );
}

// ---------------------------------------------------------------------------
// ٢) دوال المالك يجب ألا تصل دور موظف الجرد أبداً — لا توسيع صلاحيات بالخطأ.
// ---------------------------------------------------------------------------
for (const fn of OWNER_RPCS) {
  for (const [label, sql] of [[SCHEMA, schema], [RESTORE, restore]]) {
    assert.equal(
      anonCanExecute(sql, fn), false,
      `${label}: ${fn} دالة مالك — يجب ألا تكون قابلة للتنفيذ بدور موظف الجرد`,
    );
  }
}

// ---------------------------------------------------------------------------
// ٣) أمان المنحة قائم على الحارس داخل كل دالة، لا على المنحة. إن سقط الحارس
//    صار المنح لـanon ثغرة حقيقية — فهذا الفحص يسقط قبل أن يحدث ذلك.
// ---------------------------------------------------------------------------
function functionBody(sql, fn) {
  const start = sql.indexOf(`create or replace function public.${fn}`);
  assert.notEqual(start, -1, `${SCHEMA}: تعريف ${fn} مفقود`);
  const next = sql.indexOf('\ncreate or replace function', start + 10);
  return sql.slice(start, next === -1 ? sql.length : next);
}
for (const fn of COUNTER_RPCS) {
  const body = functionBody(schema, fn).replace(/\s+/g, ' ');
  assert.match(
    body, /public\.smart_inventory_is_counter\(\)/,
    `${SCHEMA}: ${fn} ممنوحة لـanon، فلا بد أن تحرس هويتها بـsmart_inventory_is_counter()`,
  );
  assert.match(
    body, /raise exception 'forbidden' using errcode='42501'/,
    `${SCHEMA}: ${fn} يجب أن ترفض غير المصرّح له صراحةً بـforbidden`,
  );
  assert.match(
    body, /security definer set search_path = ''/,
    `${SCHEMA}: ${fn} يجب أن تبقى security definer بمسار بحث مقفل`,
  );
}

// الحارس نفسه يجب أن يبقى مشترطاً الثلاثة معاً: الدور، وجلسة حيّة، وحساب مفعّل
// غير مقفول. إسقاط أيٍّ منها يحوّل منحة anon إلى باب مفتوح.
const counterGuard = functionBody(schema, 'smart_inventory_is_counter').replace(/\s+/g, ' ');
for (const [needle, why] of [
  ["app_metadata' ->> 'role','')) = 'inventory_counter'", 'الدور من app_metadata الذي لا يضبطه إلا service_role'],
  ['public.smart_inventory_has_live_session()', 'صفّ حيّ في auth.sessions — لا يكفي توكن غير ملغى'],
  ['a.user_id = auth.uid() and a.enabled', 'حساب موجود ومفعّل'],
  ['a.locked_until is null or a.locked_until <= now()', 'حساب غير مقفول'],
]) {
  assert.ok(
    counterGuard.includes(needle),
    `${SCHEMA}: smart_inventory_is_counter فقدت شرط ${why} — منحة anon تصير ثغرة`,
  );
}

console.log('check-smart-inventory-counter-grants: ok');
