// ============================================================================
// يبني حزمة تثبيت مستقلة لأداة «OZK - طباعة فواتير A4» (tools/manual-a4-print).
//
// الحزمة تحفظ تخطيط المستودع النسبي نفسه، فيعمل invoice-html.js (القالب الرسمي
// لمراقب الطباعة التلقائية) بلا أي تعديل ويجد src/ozk-font.js وخطوط Cairo:
//
//   <out>/src/ozk-font.js
//   <out>/public/fonts/cairo/*
//   <out>/tools/ameen-autoprint/invoice-html.js + ameen-customer-balance-query.sql
//   <out>/tools/manual-a4-print/...         (+ node_modules بعد npm ci)
//   <out>/runtime/node.exe                  (اختياري: --node-exe)
//   <out>/tools/manual-a4-print/bin/SumatraPDF.exe (اختياري: --sumatra)
//
// الحزمة تُثبَّت خارج نسخة العمل في OZK2026 (C:\ProgramData\OZK\ManualA4Print\app)
// فلا تمسّ شجرة git هناك ولا مراقب الطباعة التلقائية.
//
//   node scripts/build-manual-a4-print-bundle.mjs --out <dir> [--node-exe p] [--sumatra p] [--skip-npm]
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const out = path.resolve(opt("--out") || "");
if (!opt("--out")) { console.error("الاستعمال: --out <dir>"); process.exit(1); }
if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`المجلد ليس فارغاً: ${out}`); process.exit(1); }

function copy(rel, dest) {
  const from = path.join(root, rel);
  const to = path.join(out, dest || rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

copy("src/ozk-font.js");
for (const f of fs.readdirSync(path.join(root, "public/fonts/cairo"))) copy(`public/fonts/cairo/${f}`);
copy("tools/ameen-autoprint/invoice-html.js");
copy("tools/ameen-autoprint/ameen-customer-balance-query.sql");
const app = "tools/manual-a4-print";
for (const f of ["server.js", "lib", "ui", "launch.ps1", "install.ps1", "set-sql-secret.ps1", "autoprint-mode.ps1",
  "package.json", "package-lock.json", "config.example.json", "README.md"]) copy(`${app}/${f}`);
fs.mkdirSync(path.join(out, app, "bin"), { recursive: true });

let sha = "unknown";
try { sha = execFileSync("git", ["-C", root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* خارج git */ }
fs.writeFileSync(path.join(out, app, "VERSION"), `${sha}\n`);

if (opt("--node-exe")) {
  fs.mkdirSync(path.join(out, "runtime"), { recursive: true });
  fs.copyFileSync(path.resolve(opt("--node-exe")), path.join(out, "runtime", "node.exe"));
}
if (opt("--sumatra")) {
  fs.copyFileSync(path.resolve(opt("--sumatra")), path.join(out, app, "bin", "SumatraPDF.exe"));
}

if (!args.includes("--skip-npm")) {
  execFileSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(out, app), stdio: "inherit" });
}

// تحقق: القالب في الحزمة يضمّن Cairo فعلاً (لا سقوط صامت إلى Tahoma).
const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const html = req(path.join(out, "tools/ameen-autoprint/invoice-html.js"))
  .buildInvoiceHtml({ number: 0, date: "", customer: "", total: 0, discount: 0, firstPay: 0, items: [] });
if (!/@font-face\{font-family:"Cairo"/.test(html)) { console.error("الحزمة لا تضمّن خط Cairo"); process.exit(1); }
console.log(`BUNDLE_OK: ${out} (version ${sha})`);
