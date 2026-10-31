// إعادة العد الجماعية بكل المستودعات: عقود ثابتة + تشغيل حي للهجرة على قاعدة Postgres مؤقتة.
// على CI (أو مع PGHOST) غياب Postgres فشل، ومحلياً بلا Postgres تُكتفى العقود الثابتة.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

let failed = false;
function assert(condition, message) { if (!condition) { failed = true; console.error(message); } }

const migrationPath = "supabase/migrations/20261031190000_smart_inventory_owner_bulk_recount.sql";
const testPath = "supabase/tests/smart-inventory-bulk-recount.sql";
const migration = readFileSync(migrationPath, "utf8");
const reference = readFileSync("supabase/smart-inventory.sql", "utf8");
const client = readFileSync("src/supabase-client.js", "utf8");
const ui = readFileSync("src/smart-inventory.js", "utf8");
const sqlTest = readFileSync(testPath, "utf8");
const code = migration.replace(/--.*$/gm, "");

for (const contract of [
  "security definer set search_path = ''",
  "if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'",
  "length(v_reason)<3",
  "coalesce(nullif(i.item_guid,''),i.item_key)=any(v_refs)",
  "i.count_state<>'uncounted' and not i.recount_requested",
  "recount_requested=true",
  "claimed_by=null",
  "'recount_opened'",
  "'session_reopened'",
  "status='in_progress'",
  "order by s.id for update",
]) assert(code.includes(contract), `Bulk recount migration missing: ${contract}`);

// العد الأعمى يبقى: لا مسح لهوية الجارد الأصلي ولا لكمياته ولا حذف محاولات.
const updates = [...code.matchAll(/\bupdate\s+public\.\w+[^;]*?\bset\b([\s\S]*?)(?:\bwhere\b|\bfrom\b)/gi)].map((m) => m[1]).join("\n");
assert(updates.length > 0 && !/\b(counted_by|counted_by_display_name|count_state|unit1_qty|unit2_qty|actual_qty_unit1|damaged_unit1_qty)\s*=/i.test(updates) && !/delete\s+from/i.test(code),
  "Bulk recount must not reset the count, the original counter, or delete attempts.");
// لا كتابة إلا على جداول الجرد الذكي.
for (const match of code.matchAll(/\b(?:update|insert\s+into)\s+public\.(\w+)/gi))
  assert(["smart_inventory_items", "smart_inventory_sessions", "smart_inventory_audit_log"].includes(match[1]),
    `Bulk recount writes an unexpected table: ${match[1]}`);
assert(/revoke all on function public\.smart_inventory_owner_day_items\(date\),\s*public\.smart_inventory_owner_bulk_recount\(date,text\[\],text\) from public,anon;/.test(code),
  "New owner RPCs must be revoked from PUBLIC and anon.");
assert(/grant execute on function public\.smart_inventory_owner_day_items\(date\),\s*public\.smart_inventory_owner_bulk_recount\(date,text\[\],text\) to authenticated;/.test(code),
  "New owner RPCs are granted to authenticated only.");
assert(!/to\s+anon/i.test(code), "Bulk recount migration must never grant anything to anon.");
assert(reference.includes("create or replace function public.smart_inventory_owner_bulk_recount")
  && reference.includes("public.smart_inventory_owner_day_items(date),public.smart_inventory_owner_bulk_recount(date,text[],text)\nfrom public,anon;"),
  "supabase/smart-inventory.sql must carry the bulk recount functions and keep them out of anon.");
assert(client.includes('inventoryRpc("smart_inventory_owner_bulk_recount"') && client.includes('inventoryRpc("smart_inventory_owner_day_items"'),
  "Client must call the bulk recount RPCs through inventoryRpc.");
for (const contract of ["data-smart-bulk-search", "data-smart-bulk-pick", "data-smart-bulk-apply", "data-smart-bulk-reason", "renderBulkResults"])
  assert(ui.includes(contract), `Bulk recount owner UI missing: ${contract}`);
assert(/getSmartInventoryOwnerDayItems\(\)\.catch\(/.test(ui), "Dashboard must still load when the bulk recount RPC is not deployed yet.");
assert(sqlTest.includes("ozk_bulk_recount_test") && sqlTest.includes("BULK_RECOUNT_TEST_OK"), "Bulk recount SQL test guard missing.");

if (failed) process.exit(1);

const DB = "ozk_bulk_recount_test";
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  return spawnSync(viaTcp ? "psql" : "sudo", viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args], { encoding: "utf8", ...options });
}
const out = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const admin = (sql) => psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]);

const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(out(probe) || "psql is not available");
    console.error(`CI must execute ${testPath}`);
    process.exit(1);
  }
  console.log("check-smart-inventory-bulk-recount: static contracts passed; live SQL skipped (no local postgres).");
  process.exit(0);
}
admin(`drop database if exists ${DB}`);
const create = admin(`create database ${DB}`);
const run = psql(["-d", DB, "-v", "ON_ERROR_STOP=1", "-qtA", "-f", testPath]);
admin(`drop database if exists ${DB}`);
if (create.status !== 0 || run.status !== 0 || !out(run).includes("BULK_RECOUNT_TEST_OK")) {
  console.error(out(create) + out(run));
  console.error("bulk recount SQL test failed");
  process.exit(run.status || 1);
}
console.log("check-smart-inventory-bulk-recount: blind recount opened in every warehouse of the day, closed sessions reopened, nothing else touched.");
