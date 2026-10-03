// حارس انحراف الهجرات (تدقيق 2026-10-03، راجع supabase/superseded/README.md).
//
// ١) ملفات supabase/superseded/ خارج سلسلة Supabase CLI عن قصد، فلا يعود أيٌّ منها
//    إلى supabase/migrations/ — خصوصاً 20260902070000 الذي يمنح anon قراءة
//    approved_price_sync_feed فيكسر #291.
// ٢) لا هجرة فعّالة تمنح anon أو authenticated أي صلاحية على approved_price_sync_feed.
// ٣) الفهرس الفريد 20260921073000 يبقى في السلسلة الفعّالة.
// ٤) أرقام الإصدارات التي أعيدت تسميتها لتطابق الإنتاج لا ترجع لأرقامها القديمة.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const MIGRATIONS = "supabase/migrations";
const SUPERSEDED = "supabase/superseded";

const active = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
const activeVersions = new Set(active.map((f) => f.slice(0, 14)));

const parked = readdirSync(SUPERSEDED).filter((f) => f.endsWith(".sql"));
assert.ok(parked.includes("20260902070000_p2_security_definer_views_audit.sql"),
  "20260902070000 يبقى محفوظاً في supabase/superseded/ للتاريخ");
for (const f of parked) {
  assert.ok(!activeVersions.has(f.slice(0, 14)),
    `${f}: رقمه عاد إلى supabase/migrations/ — هذا الملف لا يُطبَّق أبداً`);
}
assert.match(readFileSync(`${SUPERSEDED}/20260902070000_p2_security_definer_views_audit.sql`, "utf8"),
  /لا تُشغَّل هذه الهجرة أبداً/, "تحذير 20260902070000 في رأس الملف");

const feedGrant = /grant\s+[^;]*\bon\s+(table\s+)?(public\.)?approved_price_sync_feed\b[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/i;
for (const f of active) {
  const sql = readFileSync(`${MIGRATIONS}/${f}`, "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, feedGrant, `${f}: يمنح anon/authenticated صلاحية على approved_price_sync_feed (يكسر #291)`);
}

for (const [oldV, newV] of [
  ["20260914120000", "20260914121528"],
  ["20260921120000", "20260921104828"],
  ["20260926140000", "20260926234241"],
  ["20260928140000", "20260928145121"],
]) {
  assert.ok(!activeVersions.has(oldV), `${oldV}: الرقم القديم عاد؛ الإنتاج يسجّل ${newV}`);
  assert.ok(activeVersions.has(newV), `${newV}: ملف الهجرة المسجّلة على الإنتاج مفقود`);
}
// الفهرس الفريد لهوية البطاقة خط الدفاع الأخير ضد تكرار item_guid (Codex P1 على #305):
// يبقى في السلسلة الفعّالة كي تحصل عليه أي قاعدة تُبنى من الهجرات، لا في الأرشيف.
const guidIndex = "20260921073000_approved_price_items_item_guid_unique.sql";
assert.ok(active.includes(guidIndex), `${guidIndex}: يجب أن يبقى في supabase/migrations/`);
assert.ok(!parked.includes(guidIndex), `${guidIndex}: لا نسخة منه في supabase/superseded/`);
assert.match(
  readFileSync(`${MIGRATIONS}/${guidIndex}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " "),
  /create unique index if not exists approved_price_items_item_guid_unique on public\.approved_price_items \(upper\(item_guid\)\) where item_guid is not null/i,
  `${guidIndex}: الفهرس الفريد على upper(item_guid) غير موجود`
);

assert.ok(existsSync(`${SUPERSEDED}/README.md`), "supabase/superseded/README.md موجود");

console.log("check-migration-drift-guard: OK");
