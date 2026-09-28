import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

let failed = false;
function assert(condition, message) {
  if (!condition) {
    failed = true;
    console.error(message);
  }
}

const migrationPath = "supabase/migrations/20260928140000_prune_ameen_warehouse_stock_reports.sql";
const testPath = "supabase/tests/prune-ameen-warehouse-stock-reports.sql";
const migration = readFileSync(migrationPath, "utf8");
const sqlTest = readFileSync(testPath, "utf8");
const code = migration.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

for (const contract of [
  "security definer",
  "set search_path = ''",
  "9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3",
  "set_config('row_security', 'off', true)",
  "least(p_before, pg_catalog.now() - interval '2 days')",
  "p_limit > 40",
  "smart_inventory_sessions",
  "inventory_recon_sessions",
  "unexpected foreign key",
  "revoke all on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) from public, anon, authenticated",
  "grant execute on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) to authenticated",
]) {
  assert(migration.includes(contract), `Warehouse prune migration missing: ${contract}`);
}

assert(/not exists\s*\(\s*select 1\s+from public\.smart_inventory_sessions/i.test(code), "Prune must skip smart_inventory_sessions references.");
assert(/not exists\s*\(\s*select 1\s+from public\.inventory_recon_sessions/i.test(code), "Prune must skip inventory_recon_sessions references.");
assert(!/on delete cascade/i.test(code), "Prune migration must not add ON DELETE CASCADE.");
assert(!/\balter\s+table\b/i.test(code), "Prune migration must not alter tables or foreign keys.");
assert(!/\b(update|insert\s+into|delete\s+from)\s+public\.smart_inventory_/i.test(code), "Prune migration must not write smart_inventory tables.");
assert(!/\b(update|insert\s+into|delete\s+from)\s+public\.inventory_recon_sessions/i.test(code), "Prune migration must not write inventory_recon_sessions.");
assert(/\bdelete\s+from\s+public\.ameen_warehouse_stock_reports\b/i.test(code), "Prune migration must delete only from ameen_warehouse_stock_reports.");

for (const contract of [
  "PRUNE_TEST_OK",
  "a smart inventory source report was deleted",
  "sync writer only",
  "force row level security",
  "foreign_key_violation",
  "unexpected foreign key",
  "refusing: ameen_warehouse_stock_reports has the production shape",
  "refusing: smart_inventory_sessions has the production shape",
]) {
  assert(sqlTest.includes(contract), `Warehouse prune SQL test missing: ${contract}`);
}

function runSql() {
  const probe = spawnSync("sudo", ["-n", "-u", "postgres", "psql", "-d", "postgres", "-tAc", "select 1"], { encoding: "utf8" });
  if (probe.status !== 0) {
    if (process.env.CI === "true") {
      console.error(probe.stderr || probe.stdout || "psql is not available");
      console.error("CI must execute supabase/tests/prune-ameen-warehouse-stock-reports.sql");
      process.exit(1);
    }
    console.log("check-warehouse-stock-prune: static contracts passed; live SQL skipped (no local postgres).");
    return;
  }

  const db = "ozk_prune_warehouse_stock_test";
  const drop = spawnSync("sudo", ["-n", "-u", "postgres", "psql", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${db}`], { encoding: "utf8" });
  const create = spawnSync("sudo", ["-n", "-u", "postgres", "psql", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${db}`], { encoding: "utf8" });
  const exec = spawnSync("sudo", ["-n", "-u", "postgres", "psql", "-d", db, "-v", "ON_ERROR_STOP=1", "-f", testPath], { encoding: "utf8" });
  spawnSync("sudo", ["-n", "-u", "postgres", "psql", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${db}`], { encoding: "utf8" });
  const output = `${drop.stdout || ""}${drop.stderr || ""}${create.stdout || ""}${create.stderr || ""}${exec.stdout || ""}${exec.stderr || ""}`;
  if (drop.status !== 0 || create.status !== 0 || exec.status !== 0 || !output.includes("PRUNE_TEST_OK")) {
    console.error(output);
    console.error("prune SQL test failed");
    process.exit(exec.status || 1);
  }
  console.log("check-warehouse-stock-prune: referenced reports survived a live SQL run.");
}

if (failed) process.exit(1);
runSql();
