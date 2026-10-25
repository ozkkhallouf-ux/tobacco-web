// ============================================================================
// بوابة أرشفة فواتير الجملة على Google Drive (tools/drive-invoice-archive):
//   1. حراسات ثابتة: الأمين قراءة فقط، لا مشاركة ولا حذف في Drive، المستلم المالك وحده،
//      الحساب المعتمد وحده، الافتراضي dry-run، والعامل غير مفعَّل (لا مهمة تشغّله).
//   2. اختبارات العامل (أمين وDrive وEdge وهمية) واختبار دالة Edge الحقيقية (Node ≥ 22).
//   3. الهجرة المقترحة 22 والتراجع على PostgreSQL محلي مؤقت إن وُجد (إلزامي في CI).
// ============================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolRel = "tools/drive-invoice-archive";
const dir = path.join(root, toolRel);
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ── ١) حراسات ثابتة ──────────────────────────────────────────────────────────
const drive = read(`${toolRel}/lib/drive.js`);
assert.doesNotMatch(drive.replace(/^\s*\/\/.*$/gm, ""), /permissions/i, "Drive: لا استدعاء لمسار permissions (لا مشاركة)");
assert.doesNotMatch(drive, /method:\s*"(DELETE|PATCH|PUT)"|api\("(DELETE|PATCH|PUT)"/, "Drive: لا حذف ولا تعديل ملف موجود");
assert.doesNotMatch(drive, /\/trash|"trashed":\s*true|emptyTrash/, "Drive: لا نقل إلى السلة");
assert.match(drive, /const SCOPE = "https:\/\/www\.googleapis\.com\/auth\/drive\.file";/, "Drive: النطاق drive.file وحده");
assert.match(drive, /if \(email !== expected\)/, "Drive: التحقق من هوية الحساب قبل الكتابة");
assert.match(drive, /NOT_PRIVATE/, "Drive: إيقاف عند مجلد مشترك");

const config = read(`${toolRel}/lib/config.js`);
assert.match(config, /const APPROVED_ACCOUNT = "ozkkhallouf@gmail\.com";/, "الحساب المعتمد الوحيد");
assert.match(config, /mode: "dry-run",/, "الافتراضي dry-run");
assert.doesNotMatch(read(`${toolRel}/config.example.json`), /"mode":\s*"(drive|live)"/, "مثال الإعداد لا يفعّل الرفع");

const shared = read("supabase/functions/_shared/document-archive.js");
assert.match(shared, /const FORBIDDEN_FIELDS = \["chat_id", "chatId", "to", "recipient", "phone"\];/, "لا مستلم من الطلب");
const edgeFn = read("supabase/functions/document-archive-notify/index.ts");
assert.match(edgeFn, /doc\.append\("chat_id", chat\);/, "المستلم من bot_config وحده");
assert.doesNotMatch(edgeFn.replace(/^\s*\/\/.*$/gm, ""), /fields\.chat_id|parse_mode|protect_content/, "لا مستلم من الطلب ولا parse_mode");
assert.match(edgeFn, /timingSafeEqualText\(req\.headers\.get\("x-ozk-archive-secret"\), ARCHIVE_SECRET\)/, "سرّ الدالة إلزامي");
assert.match(read("supabase/config.toml"), /\[functions\.document-archive-notify\]\r?\nverify_jwt = false/, "verify_jwt=false صريح");

// الأمين قراءة فقط: أنماط الكتابة نفسها التي تفحصها بوابة نشر Windows.
const gate = JSON.parse(read("tools/deploy-gate/gate-config.example.json"));
const codeFiles = [];
const walk = (rel) => {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) { if (!["node_modules", "__tests__", "data"].includes(e.name)) walk(r); continue; }
    if (/\.(js|mjs|cjs|sql|ps1)$/.test(e.name)) codeFiles.push(r);
  }
};
walk(toolRel);
for (const rel of codeFiles) {
  const text = read(rel);
  for (const pattern of gate.writeScan.patterns) {
    assert.doesNotMatch(text, new RegExp(pattern, "i"), `${rel}: نمط كتابة على الأمين (${pattern})`);
  }
  assert.doesNotMatch(text, /with\s*\(\s*nolock/i, `${rel}: لا NOLOCK`);
  assert.doesNotMatch(text, /ozk-print-bridge|XPRINTER|SumatraPDF|-print-to/i, `${rel}: لا مساس بالطباعة`);
}
assert.match(read(`${toolRel}/set-secret.ps1`), /-ieq 'sa'/, "حفظ السر يرفض حساب sa");

// puppeteer-core يُحمَّل من مجلد العامل نفسه: محوّل أداة الطباعة يحلّه من مجلدها هي،
// فيفشل كل PDF على تثبيت فيه تبعيات العامل وحده (Codex P1 على #359).
for (const rel of codeFiles) {
  for (const m of read(rel).matchAll(/createRenderer[^=\n]*\}\s*=\s*require\(([^)]*)\)/g)) {
    assert.match(m[1], /^"\.\/lib\/renderer"$/, `${rel}: المحوّل من lib/renderer.js لا من أداة الطباعة`);
  }
}
assert.match(read(`${toolRel}/lib/renderer.js`), /require\("puppeteer-core"\)/, "المحوّل يحمّل puppeteer-core من مجلد العامل");
assert.match(read(`${toolRel}/package.json`), /"puppeteer-core":/, "puppeteer-core تبعية للعامل");

// غير مفعَّل: لا مهمة مجدولة ولا workflow يشغّل العامل.
const runners = [];
const scan = (rel) => {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) { if (!["node_modules", ".git", "drive-invoice-archive"].includes(e.name)) scan(r); continue; }
    if (!/\.(ps1|psm1|cmd|bat|vbs|json|yml|yaml|js|mjs)$/.test(e.name) || /^scripts\/check[^/]*\.mjs$/.test(r)) continue;
    if (/drive-invoice-archive/.test(read(r))) runners.push(r);
  }
};
for (const rel of ["tools", ".github"]) if (fs.existsSync(path.join(root, rel))) scan(rel);
assert.deepEqual(runners, [], `العامل غير مفعَّل: لا يجوز أن يستدعيه ملف (${runners.join(", ")})`);

// الهجرة: المالك وحده يقرأ، ولا شيء لـanon، والكتابة لـservice_role.
const migration = read("supabase/proposed/22-document-archive.sql");
for (const t of ["document_archive_items", "document_archive_heartbeat", "document_archive_retry_requests"]) {
  assert.match(migration, new RegExp(`alter table public\\.${t} enable row level security;`), `RLS على ${t}`);
}
assert.equal((migration.match(/using \(public\.is_owner\(\)\)/g) || []).length, 3, "سياسات القراءة للمالك وحده");
assert.doesNotMatch(migration, /grant [^;]* to [^;]*\banon\b/i, "لا صلاحية لـanon");
assert.doesNotMatch(migration, /for (insert|update|delete|all) to authenticated/i, "لا سياسة كتابة للمستخدمين");
assert.doesNotMatch(migration, /\bcron\.schedule|on delete cascade/i, "لا حذف تلقائي لسجل الأرشيف");
console.log("  ✓ حراسات ثابتة: قراءة فقط، بلا مشاركة ولا حذف، المالك وحده، الحساب المعتمد، غير مفعَّل");

// ── ٢) الاختبارات ────────────────────────────────────────────────────────────
for (const t of ["drive-archive.test.mjs", "edge-function.test.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(dir, "__tests__", t)], { stdio: "inherit" });
  if (r.error || r.signal || r.status !== 0) {
    console.error(`check-drive-invoice-archive: فشل ${t}`);
    process.exit(r.status || 1);
  }
}

// ── ٣) الهجرة على PostgreSQL محلي ────────────────────────────────────────────
const DB = "ozk_document_archive_test";
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1"]);
if (!LOCAL_HOSTS.has(String(process.env.PGHOST || "").trim().toLowerCase())) {
  console.error("check-drive-invoice-archive: refusing non-local PGHOST");
  process.exit(1);
}
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  return spawnSync(viaTcp ? "psql" : "sudo", viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args], { encoding: "utf8", ...options });
}
const output = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    console.error(output(probe) || "psql is not available");
    console.error("CI must execute supabase/tests/document-archive.sql");
    process.exit(1);
  }
  console.log("  - SQL حي: متخطى (لا PostgreSQL محلي)");
} else {
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const create = psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `create database ${DB}`]);
  const testSql = read("supabase/tests/document-archive.sql");
  const bundled = testSql.replace("\\i :migration", () => migration)
    .replace("\\i :rollback", () => read("supabase/proposed/22-document-archive-rollback.sql"));
  const run = psql(["-d", DB, "-X", "-v", "ON_ERROR_STOP=1"], { input: bundled });
  psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists ${DB}`]);
  const text = `${output(create)}${output(run)}`;
  const passes = (text.match(/PASS /g) || []).length;
  if (create.status !== 0 || run.status !== 0 || !text.includes("DOCUMENT_ARCHIVE_OK") || /TEST FAIL/.test(text)) {
    console.error(text);
    console.error("check-drive-invoice-archive: live SQL test failed");
    process.exit(run.status || 1);
  }
  assert.ok(passes >= 25, `عدد تأكيدات SQL (${passes}) أقل من المتوقع`);
  console.log(`  ✓ الهجرة 22 والتراجع على PostgreSQL محلي: ${passes} تأكيداً`);
}
console.log("check-drive-invoice-archive: OK");
