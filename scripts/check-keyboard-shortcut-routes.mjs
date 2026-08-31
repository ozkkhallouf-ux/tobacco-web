// كل مسار تصل إليه اختصارات Alt+رقم يجب أن يكون صفحة مسجّلة فعلاً.
//
// الخلفية: الكوميت 27bfbe2 حذف تبويب «الفواتير» غير المستخدم من التنقل ومن خريطة
// pages، لكنه أبقى `"6": "invoice"` في خريطة الاختصارات. الحارس canAccessRoute()
// لا يفحص allowedRoutes إطلاقاً، فكان Alt+6 يُسنِد state.route = "invoice" ثم يرمي
// `pages[state.route] is not a function` — الشاشة لا تتغيّر، ويبقى المسار مكسوراً
// حتى أول ضغطة تنقّل، فتفشل بصمت كل استدعاءات render() في هذه الأثناء.
//
// هذا الفحص يمنع تكرار نفس الصنف من الخطأ: أي اختصار يشير إلى صفحة غير موجودة
// يُسقط `npm run check` بدل أن يصل للإنتاج.

import { readFileSync } from "node:fs";

const appJs = readFileSync("src/app.js", "utf8");
let failed = false;

function fail(message) {
  console.error(message);
  failed = true;
}

// ── 1) استخراج العقود الثلاثة من app.js ────────────────────────────────────────

const routeMapMatch = appJs.match(/const routeMap = \{([^}]*)\};/);
if (!routeMapMatch) {
  fail("Keyboard shortcut routeMap not found in src/app.js — did the shortcut handler move?");
}

const allowedRoutesMatch = appJs.match(/const allowedRoutes = new Set\(\[([^\]]*)\]\)/);
if (!allowedRoutesMatch) {
  fail("allowedRoutes set not found in src/app.js.");
}

const pagesMatch = appJs.match(/\n  const pages = \{\n([\s\S]*?)\n  \};\n/);
if (!pagesMatch) {
  fail("pages map not found in src/app.js.");
}

if (failed) process.exit(1);

const shortcutRoutes = [...routeMapMatch[1].matchAll(/"(\d)":\s*"([A-Za-z]+)"/g)].map(([, key, route]) => ({ key, route }));
const allowedRoutes = new Set([...allowedRoutesMatch[1].matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));
// مفاتيح pages: إما `name,` (اختصار) أو `name: handler,`
const pageRoutes = new Set(
  pagesMatch[1]
    .split("\n")
    .map((line) => line.trim().match(/^([A-Za-z][A-Za-z0-9]*)\s*[,:]/))
    .filter(Boolean)
    .map((m) => m[1])
);

if (!shortcutRoutes.length) fail("routeMap parsed but no Alt+digit shortcuts were extracted.");
if (allowedRoutes.size < 5) fail(`allowedRoutes parsed but looks truncated (${allowedRoutes.size} entries).`);
if (pageRoutes.size < 5) fail(`pages map parsed but looks truncated (${pageRoutes.size} entries).`);

// ── 2) كل اختصار يشير إلى صفحة موجودة ومسموحة ─────────────────────────────────

for (const { key, route } of shortcutRoutes) {
  if (!pageRoutes.has(route)) {
    fail(`Alt+${key} points at route "${route}" which is not registered in the pages map — render() would throw "pages[state.route] is not a function".`);
  }
  if (!allowedRoutes.has(route)) {
    fail(`Alt+${key} points at route "${route}" which is missing from allowedRoutes, so ?route=${route} and the shortcut would disagree.`);
  }
}

// ── 3) شرط الجلسة داخل نفس المعالِج لا يذكر مسارات غير موجودة ────────────────
// (السطر: if ((target === "dashboard" || target === "purchases" || ...) && !state.session) return;)

const sessionGuard = appJs.match(/if \(\((target === "[^)]*)\) && !state\.session\) return;/);
if (!sessionGuard) {
  fail("Session guard for keyboard shortcuts not found in src/app.js.");
} else {
  const guarded = [...sessionGuard[1].matchAll(/target === "([A-Za-z]+)"/g)].map((m) => m[1]);
  const shortcutRouteNames = new Set(shortcutRoutes.map((s) => s.route));
  for (const route of guarded) {
    if (!shortcutRouteNames.has(route)) {
      fail(`Shortcut session guard mentions route "${route}" which no shortcut can reach any more — remove it.`);
    }
  }
}

// ── 4) لا بقايا من صفحة الفواتير المحذوفة ────────────────────────────────────

for (const leftover of ["function invoice()", "printInvoice", "generateInvoiceNumber", "sendInvoiceWhatsapp", "state.invRows", "state.invCustomer", "state.invNotes", "data-inv-field", "data-inv-remove"]) {
  if (appJs.includes(leftover)) {
    fail(`Dead invoice page leftover found in src/app.js: ${leftover}`);
  }
}

if (failed) {
  console.error("Keyboard shortcut route contract failed.");
  process.exit(1);
}

console.log(`Keyboard shortcut routes OK — ${shortcutRoutes.length} shortcuts, all registered in pages and allowedRoutes.`);
