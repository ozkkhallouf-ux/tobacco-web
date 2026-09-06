// حارس عقد خط مزامنة حركة المصاريف.
//
// القاعدة التي يحرسها: **ما يُختم بعلامة اكتمال يجب أن يكون قد جرى فعلاً**.
// المنتِج يحدّث نافذة قصيرة (7 أيام افتراضاً) ويترك ما قبلها؛ فما لم يُسجَّل
// حدّ ما جرى تحديثه صراحةً، يجمع المساعدُ كلَّ ما يجده ويعرضه بوصفه «إجمالي»
// — وهو رقم قد يُسقط تاريخاً أو يحمل قيوداً بائدة. (ملاحظة Codex على PR #205.)
//
// الملفان محروسان نصّياً لا تشغيلياً: PowerShell وSQL لا يعملان في هذه البيئة
// (Windows + Supabase)، فالعقد يُثبَّت بالقراءة كما في حارس المبيعات.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [producer, sql, assistant] = await Promise.all([
  readFile(path.join(repoRoot, 'tools', 'push-expense-entries.ps1'), 'utf8'),
  readFile(path.join(repoRoot, 'supabase', 'expense-entries-atomic-refresh.sql'), 'utf8'),
  readFile(path.join(repoRoot, 'supabase', 'functions', 'financial-assistant', 'index.ts'), 'utf8'),
]);

// ── المنتِج: قراءة الأمين تبقى SELECT فقط ───────────────────────────────────
const ameenSql = producer.match(/\$sql\s*=\s*@"([\s\S]*?)"@/)?.[1];
assert.ok(ameenSql, 'Ameen SQL here-string must exist');
const ameenSqlWithoutComments = ameenSql.replace(/--.*$/gm, ' ');
assert.match(ameenSqlWithoutComments, /^\s*SELECT\b/i);
assert.doesNotMatch(
  ameenSqlWithoutComments,
  /\b(insert|update|delete|merge|drop|alter|create|truncate|exec(?:ute)?|grant|revoke|deny|backup|restore|dbcc|kill|use)\b/i,
  'Ameen SQL must remain SELECT-only',
);

// حدّا الاستعلام هما حدّا النافذة المُختمة. بلا الحدّ الأعلى يمكن أن يُرفع قيد
// بتاريخ مستقبلي خارج [windowStart, windowEnd] فترفضه الـRPC ويسقط الخط كله.
assert.match(ameenSql, /en\.Date >= DATEADD\(day, -\$Days, CAST\(GETDATE\(\) AS date\)\)/i);
assert.match(ameenSql, /en\.Date <= CAST\(GETDATE\(\) AS date\)/i);
assert.match(producer, /\[ValidateRange\(1, 31\)\]\[int\]\$Days = 7/);
assert.match(producer, /\$windowStart = \(Get-Date\)\.AddDays\(-\$Days\)\.ToString\("yyyy-MM-dd"\)/);
assert.match(producer, /\$windowEnd\s*= \(Get-Date\)\.ToString\("yyyy-MM-dd"\)/);

// ── المنتِج: الاستبدال ذرّي، بلا مسار كتابة مباشر ولا خروج مبكر ─────────────
// مُنتهٍ بعلامة الاقتباس عمداً: بلا التثبيت، اسمٌ مُصحَّف مثل
// `...window_v2` كان يمرّ لأن التعبير يطابق جزءاً من الاسم.
assert.match(producer, /rest\/v1\/rpc\/replace_expense_entries_window"/);
assert.match(producer, /p_window_start\s*=\s*\$windowStart/);
assert.match(producer, /p_window_end\s*=\s*\$windowEnd/);
assert.match(producer, /p_rows\s*=\s*@\(\$rows\)/);
assert.doesNotMatch(producer, /-Method\s+Delete/i, 'الحذف المباشر استُبدل بالاستبدال الذرّي');
assert.doesNotMatch(
  producer,
  /-Uri "\$supabaseUrl\/rest\/v1\/expense_entries\?"?[^"]*"\s*`?\s*\n?\s*-Headers \(\$hdr \+ @\{ Prefer/i,
  'لا كتابة مباشرة على الجدول خارج الـRPC',
);
assert.doesNotMatch(producer, /\$batchSize/i, 'الدفعات المتتابعة تناقض الذرّية');
// الخروج المبكر عند صفر صفوف كان يترك صفوف النافذة القديمة قائمة بلا ختم.
assert.doesNotMatch(producer, /ma fi satr — khoroj bidoon rafe3/);
assert.doesNotMatch(producer, /if \(\$rows\.Count -eq 0\) \{\s*\n\s*Write-Log[^\n]*\n\s*exit 0/);
// التحقق من نتيجة الـRPC — بلا هذا يمرّ استبدال ناقص كأنه ناجح.
assert.match(producer, /resultRow\.row_count\s*-ne\s*\$rows\.Count/i);
assert.match(producer, /atomic_expense_refresh_verification_failed/);
assert.match(producer, /sync_run_id/);
assert.match(producer, /completed_at/);

// ── القاعدة: الـRPC يُثبِّت الترتيب ويُحكم الصلاحية ─────────────────────────
const rpc = sql.match(
  /create or replace function public\.replace_expense_entries_window\([\s\S]*?\n\$\$;/i,
)?.[0];
assert.ok(rpc, 'atomic replacement RPC must exist');
assert.match(rpc, /security invoker/i);
assert.doesNotMatch(rpc, /security definer/i, 'SECURITY DEFINER يتجاوز RLS — ممنوع هنا');
assert.match(rpc, /set search_path = ''/i);
assert.match(rpc, /set statement_timeout = '15s'/i);
assert.doesNotMatch(rpc, /\btruncate\b/i);
assert.match(rpc, /if not \(select public\.expense_entries_is_sync_writer\(\)\) then/i);
assert.match(rpc, /raise exception 'sync writer required'/i);
assert.match(rpc, /replacement window exceeds 31 days/i);
assert.match(rpc, /pg_advisory_xact_lock/i);
assert.match(rpc, /create temporary table staged_expense_entries on commit drop as/i);
assert.match(rpc, /entry_date is outside replacement window/i);
assert.match(rpc, /get diagnostics v_inserted = row_count/i);
assert.match(rpc, /if v_inserted <> v_count then\s+raise exception 'inserted row count mismatch'/i);

// الحمولة الفارغة مقبولة عمداً — عكس نظيرها في المبيعات. رفضها يعيد إنتاج
// العطل: نافذة مُفرَّغة في الأمين تبقى صفوفها ظاهرة في Supabase بلا ختم.
assert.match(rpc, /jsonb_typeof\(p_rows\) <> 'array'/i);
assert.doesNotMatch(rpc, /jsonb_array_length\(p_rows\) = 0/, 'النافذة الفارغة حالة مشروعة');

// الترتيب: تجهيز ← تحقق ← حذف ← إدراج ← ختم. أي انزياح يكسر الذرّية معنىً.
const stagePosition = rpc.search(/create temporary table staged_expense_entries/i);
const validationPosition = rpc.search(/entry_date is outside replacement window/i);
const deletePosition = rpc.search(/delete from public\.expense_entries e/i);
const insertPosition = rpc.search(/insert into public\.expense_entries\s*\(/i);
const metadataPosition = rpc.search(/insert into public\.expense_entries_sync_state/i);
assert.ok(stagePosition >= 0 && stagePosition < validationPosition);
assert.ok(validationPosition < deletePosition, 'all validation must finish before DELETE');
assert.ok(deletePosition < insertPosition && insertPosition < metadataPosition);

// ── هوية كاتب المزامنة مُفوَّضة لا مكرَّرة ──────────────────────────────────
// تكرار المعرّف حرفياً يخلق مصدرَي حقيقة: تغيير حساب المزامنة يُحدَّث في ملف
// ويُنسى في الآخر، فيبقى باب مفتوح لحساب لم يعد معتمَداً — بصمت.
const writer = sql.match(
  /create or replace function public\.expense_entries_is_sync_writer\(\)[\s\S]*?\$\$;/i,
)?.[0];
assert.ok(writer, 'sync writer delegate must exist');
assert.match(writer, /select \(select public\.sales_line_items_is_sync_writer\(\)\)/i);
assert.doesNotMatch(writer, /auth\.uid\(\)\s*=\s*'[0-9a-f-]{36}'/i, 'لا تكرار لمعرّف الحساب');

// ── الجدول: قراءة للجميع، كتابة لكاتب المزامنة وحده ────────────────────────
assert.match(sql, /create table if not exists public\.expense_entries_sync_state/i);
assert.match(sql, /source = 'ameen_expense_entries'/);
assert.match(sql, /window_end >= window_start/);
assert.match(sql, /row_count >= 0/);
assert.match(sql, /alter table public\.expense_entries_sync_state enable row level security/i);
assert.match(sql, /revoke all on table public\.expense_entries_sync_state\s*\n\s*from public, anon, authenticated/i);
for (const op of ['insert', 'update']) {
  const policy = sql.match(
    new RegExp(`create policy "sync writer can ${op} expense entry sync state"[\\s\\S]*?;`, 'i'),
  )?.[0];
  assert.ok(policy, `${op} policy must exist`);
  assert.match(policy, /public\.expense_entries_is_sync_writer\(\)/i);
}

// ── المساعد: يقرأ الختم ويحذّر خارجه ───────────────────────────────────────
assert.match(assistant, /"expense_entries_sync_state"/, 'الجدول يجب أن يكون ضمن READABLE_TABLES');
assert.match(assistant, /expenseSyncWindow = \(\) => syncWindow\("expense_entries_sync_state", "ameen_expense_entries"\)/);
// فرع الأرقام وفرع الصفر كلاهما — النفي القاطع خارج النافذة كالرقم تماماً.
const expenseTool = assistant.match(/id: "expenses",[\s\S]*?\n  \},\n/)?.[0];
assert.ok(expenseTool, 'expenses tool must exist');
assert.equal(
  (expenseTool.match(/coverageWarning\(ctx\.period, await expenseSyncWindow\(\), EXPENSE_COVERAGE\)/g) ?? []).length,
  2,
  'تحذير النافذة يلزم فرع الأرقام وفرع الصفر معاً',
);

console.log('Expense entries atomic pipeline contract checks passed.');
