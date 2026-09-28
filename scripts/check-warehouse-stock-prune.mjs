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
  "for update of r skip locked",
  "smart_inventory_sessions_source_report_id_fkey",
  "inventory_recon_sessions_source_report_id_fkey",
  "confdeltype in ('a', 'r')",
  "confdeltype in ('n', 'a', 'r')",
  "توقفت الهجرة: جدول public.inventory_recon_sessions غير موجود",
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
  "cascade guard deleted reports",
  "on delete cascade",
  "for key share",
  "the KEY SHARE row was deleted",
  "refusing: ameen_warehouse_stock_reports has the production shape",
  "refusing: smart_inventory_sessions has the production shape",
  "prune test refuses a non-loopback server",
  "ozk_prune_warehouse_stock_test",
]) {
  assert(sqlTest.includes(contract), `Warehouse prune SQL test missing: ${contract}`);
}

const PRUNE_DB = "ozk_prune_warehouse_stock_test";
const MISSING_RECON_DB = "ozk_prune_missing_recon_test";

function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  const command = viaTcp ? "psql" : "sudo";
  const argv = viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args];
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}

function commandOutput(result) {
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function adminSql(sql) {
  return psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]);
}

function dropDatabase(name) {
  return adminSql(`drop database if exists ${name}`);
}

function createDatabase(name) {
  return adminSql(`create database ${name}`);
}

function postgresProbe() {
  return psql(["-d", "postgres", "-tAc", "select 1"]);
}

function requirePostgres() {
  const probe = postgresProbe();
  if (probe.status === 0) return true;
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(commandOutput(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/prune-ameen-warehouse-stock-reports.sql");
    process.exit(1);
  }
  console.log("check-warehouse-stock-prune: static contracts passed; live SQL skipped (no local postgres).");
  return false;
}

function runPruneDatabase() {
  const drop = dropDatabase(PRUNE_DB);
  const create = createDatabase(PRUNE_DB);
  const exec = psql(["-d", PRUNE_DB, "-v", "ON_ERROR_STOP=1", "-f", testPath]);
  const output = `${commandOutput(drop)}${commandOutput(create)}${commandOutput(exec)}`;
  dropDatabase(PRUNE_DB);
  if (drop.status !== 0 || create.status !== 0 || exec.status !== 0 || !output.includes("PRUNE_TEST_OK")) {
    console.error(output);
    console.error("prune SQL test failed");
    process.exit(exec.status || 1);
  }
}

function runMissingReconDatabase() {
  const missingSql = [
    "create table public.ameen_warehouse_stock_reports (id uuid primary key, created_at timestamptz not null);",
    "create table public.smart_inventory_sessions (id uuid primary key, source_report_id uuid);",
    `\\i ${migrationPath}`,
  ].join("\n");
  dropDatabase(MISSING_RECON_DB);
  const missingCreate = createDatabase(MISSING_RECON_DB);
  const missingRun = psql(["-d", MISSING_RECON_DB, "-v", "ON_ERROR_STOP=1"], { input: missingSql });
  const missingOutput = `${commandOutput(missingCreate)}${commandOutput(missingRun)}`;
  dropDatabase(MISSING_RECON_DB);
  if (missingCreate.status !== 0 || missingRun.status === 0 || !missingOutput.includes("inventory_recon_sessions")) {
    console.error(missingOutput);
    console.error("migration must stop when inventory_recon_sessions is absent");
    process.exit(1);
  }
}

function runSql() {
  if (!requirePostgres()) return;
  runPruneDatabase();
  runMissingReconDatabase();
  console.log("check-warehouse-stock-prune: referenced reports survived a live SQL run, including the lock race and the cascade refusal.");
}

if (failed) process.exit(1);
runSql();
