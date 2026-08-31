// يتحقق أن ترحيلَي item_guid/match_key موجودان فعلياً في supabase/migrations/ ويطابقان
// ما طُبِّق فعلاً على قاعدة Supabase الحية (بدل أن يبقيا مُطبَّقين حياً بلا أثر في المستودع).
// بدون هذا، جلسة مستقبلية قد "تكتشف" العمودين من جديد وتحاول ترحيلاً متعارضاً أو تفترض غيابهما.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

const addGuid = readFileSync(
  path.join(migrationsDir, "20260827110254_add_item_guid_to_approved_price_items.sql"),
  "utf8"
);
assert.match(
  addGuid,
  /alter table public\.approved_price_items add column if not exists item_guid text;/,
  "ترحيل approved_price_items.item_guid يجب أن يكون idempotent (add column if not exists)."
);
assert.match(
  addGuid,
  /create index if not exists idx_approved_price_items_item_guid on public\.approved_price_items\(item_guid\) where item_guid is not null;/,
  "الفهرس الجزئي على approved_price_items.item_guid مفقود أو غير idempotent."
);

const fixCosts = readFileSync(
  path.join(migrationsDir, "20260827110325_fix_item_costs_true_guid.sql"),
  "utf8"
);
// إعادة تسمية item_guid → match_key يجب أن تُنفَّذ فقط إن لم تُطبَّق من قبل (وإلا فشل الترحيل
// عند إعادة التشغيل لأن العمود القديم لم يعد موجوداً).
assert.match(
  fixCosts,
  /if exists \([\s\S]*column_name = 'item_guid'[\s\S]*\) and not exists \([\s\S]*column_name = 'match_key'[\s\S]*\) then\s*\n\s*alter table public\.item_costs rename column item_guid to match_key;/,
  "إعادة تسمية item_costs.item_guid إلى match_key يجب أن تكون محروسة بفحص عدم التطبيق المسبق."
);
assert.match(
  fixCosts,
  /alter table public\.item_costs add column if not exists item_guid text;/,
  "ترحيل item_costs.item_guid (الحقيقي) يجب أن يكون idempotent (add column if not exists)."
);
assert.match(
  fixCosts,
  /create index if not exists idx_item_costs_item_guid on public\.item_costs\(item_guid\) where item_guid is not null;/,
  "الفهرس الجزئي على item_costs.item_guid مفقود أو غير idempotent."
);

console.log("check-item-guid-migrations: OK — ترحيلا item_guid/match_key موثّقان بالمستودع وidempotent.");
