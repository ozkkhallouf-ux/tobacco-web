// ============================================================================
// حارس فصل حسابَي الأمين: أي نص اتصال يختاره كل مسار قراءة.
//
// الخلفية: `AMEEN_SQL_CONNECTION_STRING` يُفترض أنه حساب القراءة المخصص
// (tobacco_sync_reader: db_datareader فقط، بلا أي صلاحية server-level)، و
// `AMEEN_SQL_WRITE_CONNECTION_STRING` هو حساب الكتابة (tobacco_sync_service،
// يملك GRANT INSERT/UPDATE على dbo.MaterialPriceListItem000 و
// VIEW SERVER STATE). أربعة سكربتات قراءة محضة كانت تجرّب متغيّر الكتابة
// أولاً، فتبقى على حساب قادر على الكتابة بلا حاجة — يُفرغ الفصل من معناه
// بصمت. هذا الفحص يثبّت الاتجاه الصحيح لكل مسار حتى لا يعود الانجراف.
//
// وهو أيضاً الحارس الوحيد للاستثناء المقصود في push-khalil-audit-log.ps1:
// مسار قراءة محض يستعمل عمداً نص اتصال الكتابة لأن استعلام الـDMV فيه
// (sys.dm_tran_*) يتطلب VIEW SERVER STATE، وحساب القراءة بلا صلاحيات
// server-level بقرار صريح. بلا هذا الفحص كانت مراجعة لاحقة ستعيده إلى
// متغيّر القراءة ظنّاً أنه سهو، فيتجمّد حدّ الـoverlap بصمت.
// ============================================================================
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READ_VAR = 'AMEEN_SQL_CONNECTION_STRING';
const WRITE_VAR = 'AMEEN_SQL_WRITE_CONNECTION_STRING';

async function readScript(name) {
  const source = await readFile(path.join(repoRoot, 'tools', name), 'utf8');
  // splitlines يحافظ على الأسطر كما هي؛ بعض الملفات CRLF وبعضها LF.
  return source.split(/\r?\n/);
}

/** فهرس أول سطر (غير تعليق) يُسنِد $connStr من المتغيّر المطلوب. */
function findAssignment(lines, varName) {
  return lines.findIndex(
    (line) =>
      !line.trimStart().startsWith('#') &&
      /\$connStr\s*=/.test(line) &&
      line.includes(varName) &&
      // "AMEEN_SQL_CONNECTION_STRING" سلسلة فرعية من اسم متغيّر الكتابة،
      // فالمطابقة على الاسم وحده تلتبس. نشترط ألّا يسبقه "WRITE_" إلا إذا
      // كان هو المطلوب فعلاً.
      (varName === WRITE_VAR ? true : !line.includes(WRITE_VAR)),
  );
}

// ----------------------------------------------------------------------------
// ١) مسارات القراءة المحضة: READ أولاً، WRITE احتياطاً فقط.
// ----------------------------------------------------------------------------
const READ_FIRST_SCRIPTS = [
  'push-customer-invoices.ps1',
  'push-customer-movements.ps1',
  'push-daily-expenses.ps1',
  'verify-prices.ps1',
];

for (const name of READ_FIRST_SCRIPTS) {
  const lines = await readScript(name);
  const readAt = findAssignment(lines, READ_VAR);
  const writeAt = findAssignment(lines, WRITE_VAR);

  assert.notEqual(readAt, -1, `${name}: must assign $connStr from ${READ_VAR}`);
  assert.notEqual(
    writeAt,
    -1,
    `${name}: must keep ${WRITE_VAR} as a fallback so the script still runs if only the write var is configured`,
  );
  assert.ok(
    readAt < writeAt,
    `${name}: ${READ_VAR} must be tried BEFORE ${WRITE_VAR} (line ${readAt + 1} vs ${writeAt + 1}) — a pure read path must not hold a write-capable connection`,
  );
  assert.match(
    lines[writeAt],
    /if\s*\(\s*-not\s+\$connStr\s*\)/,
    `${name}: the ${WRITE_VAR} line must be the guarded fallback, not an unconditional reassignment`,
  );

  // لا يكتب إلى الأمين — هذا ما يجعل تفضيل حساب القراءة صحيحاً أصلاً.
  const sql = lines.filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(
    sql,
    /\b(INSERT\s+INTO|MERGE\s+INTO|DELETE\s+FROM)\s+(\[?dbo\]?\.)?\[?[A-Za-z_]/i,
    `${name}: must remain a pure read path against Ameen (no INSERT/MERGE/DELETE)`,
  );
}

// ----------------------------------------------------------------------------
// ٢) الاستثناء المقصود: push-khalil-audit-log.ps1 مثبَّت على حساب الكتابة.
// ----------------------------------------------------------------------------
const KHALIL = 'push-khalil-audit-log.ps1';
const khalilLines = await readScript(KHALIL);
const khalilWriteAt = findAssignment(khalilLines, WRITE_VAR);
const khalilReadAt = findAssignment(khalilLines, READ_VAR);

assert.notEqual(
  khalilWriteAt,
  -1,
  `${KHALIL}: must assign $connStr from ${WRITE_VAR} — its sys.dm_tran_* query needs VIEW SERVER STATE, which the read-only account deliberately lacks`,
);
assert.equal(
  khalilReadAt,
  -1,
  `${KHALIL}: must NOT fall back to ${READ_VAR}; falling back would silently freeze the overlap floor (fail-closed) and grow the log000 rescan range without bound`,
);

// التعليق التفسيري شرط: بدونه ستُعيد أول مراجعة لاحقة هذا السطر إلى متغيّر
// القراءة ظنّاً أنه سهو — وهو بالضبط العطل الذي يحرسه هذا الفحص.
const khalilSource = khalilLines.join('\n');
assert.match(
  khalilSource,
  /VIEW SERVER STATE/,
  `${KHALIL}: must carry a comment naming VIEW SERVER STATE as the reason for using the write connection`,
);
assert.match(
  khalilSource,
  /sys\.dm_tran_active_transactions/,
  `${KHALIL}: the exception comment must name the DMV that forces this choice`,
);
assert.match(
  khalilSource,
  /check-ameen-read-connection-preference\.mjs/,
  `${KHALIL}: the exception comment must point at this check, so whoever changes the line finds the guard`,
);

// التعليق يجب أن يسبق الإسناد مباشرةً لا أن يقبع في مكان آخر من الملف.
const commentStart = khalilLines.findIndex((line) => line.includes('VIEW SERVER STATE'));
assert.ok(
  commentStart !== -1 && commentStart < khalilWriteAt && khalilWriteAt - commentStart <= 20,
  `${KHALIL}: the VIEW SERVER STATE explanation must sit immediately above the $connStr assignment (comment at line ${commentStart + 1}, assignment at line ${khalilWriteAt + 1})`,
);

// ----------------------------------------------------------------------------
// ٣) مسار الكتابة الوحيد إلى الأمين يبقى معزولاً على متغيّر الكتابة وحده.
// ----------------------------------------------------------------------------
const applyLines = await readScript('apply-approved-prices-to-ameen.ps1');
assert.notEqual(
  findAssignment(applyLines, WRITE_VAR),
  -1,
  `apply-approved-prices-to-ameen.ps1: the only Ameen write path must use ${WRITE_VAR}`,
);
assert.equal(
  findAssignment(applyLines, READ_VAR),
  -1,
  `apply-approved-prices-to-ameen.ps1: must never fall back to ${READ_VAR} — the read-only account cannot write, and a fallback would turn a config slip into a silent no-op sync`,
);

console.log(
  `ameen read/write connection preference checks passed (${READ_FIRST_SCRIPTS.length} read-first scripts, 1 documented exception, 1 isolated write path).`,
);
