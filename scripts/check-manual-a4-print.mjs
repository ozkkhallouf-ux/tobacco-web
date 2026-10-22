// ============================================================================
// بوابة أداة «OZK - طباعة فواتير A4» اليدوية (tools/manual-a4-print):
//   1. اختبارات الوحدة والتكامل (__tests__/manual-print.test.mjs).
//   2. حراسات ثابتة: لا مساس بمراقب الطباعة التلقائية ولا بجسر الكاشير، والكاشير
//      محجوب، والوضع الافتراضي dryRun، والخادم على 127.0.0.1 وحده.
// ============================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "tools", "manual-a4-print");
const read = (rel) => fs.readFileSync(path.join(dir, rel), "utf8");

const server = read("server.js");
assert.match(server, /server\.listen\(cfg\.port, "127\.0\.0\.1"/, "الخادم يجب أن يستمع على 127.0.0.1 فقط");
assert.match(server, /dryRun: true,/, "الوضع الافتراضي يجب أن يكون dryRun");
assert.doesNotMatch(server, /writeFileSync\([^)]*last-printed|stateFilePath/, "ممنوع الكتابة على ملف حالة المراقب التلقائي");
assert.doesNotMatch(server, /ozk-print-bridge|XPRINTER/i, "الأداة لا تلمس جسر الكاشير ولا طابعته");
assert.match(read("lib/invoice-model.js"), /cc1097b1-662d-4d80-8e4e-3b493249591c/, "GUID الكاشير يجب أن يبقى محجوباً");
for (const ps of ["launch.ps1", "install.ps1", "set-sql-secret.ps1", "autoprint-mode.ps1"]) {
  const t = read(ps);
  assert.doesNotMatch(t, /Print ?Bridge.*(Disable|Stop|Unregister)|XPRINTER/i, `${ps} لا يلمس جسر الكاشير`);
}
const mode = read("autoprint-mode.ps1");
assert.match(mode, /\$Task = 'OZK-AmeenAutoPrint'/, "التبديل محصور بمهمة Canon وحدها");
assert.match(mode, /AcceptBacklog/, "الاسترجاع يشترط إقراراً صريحاً بدفعة اللحاق");
assert.match(mode, /SkipBacklog/, "الاسترجاع يتيح التخطّي عبر دورة الترحيل");
assert.match(mode, /WatcherPids\) \{ throw/, "لا تعديل على ملف الحالة والمراقب يعمل");
assert.match(read("set-sql-secret.ps1"), /-ieq 'sa'/, "حفظ السر يرفض حساب sa");

const result = spawnSync(process.execPath, [path.join(dir, "__tests__", "manual-print.test.mjs")], { stdio: "inherit" });
if (result.error) { console.error(`check-manual-a4-print: ${result.error.message}`); process.exit(1); }
if (result.signal) { console.error(`check-manual-a4-print: أُنهي بالإشارة ${result.signal}`); process.exit(1); }
process.exit(result.status);
