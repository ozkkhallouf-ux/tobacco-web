// فحص ربط المنفذ في overlay تطوير Docker (`docker-compose.dev.yml` +
// `docker-compose.dev.lan.yml`).
//
// أُضيف بعد ملاحظتَي Codex P1 على PR #174:
//   P1-1: HOST=0.0.0.0 + منفذ منشور بلا host_ip يفتح خادم التطوير على شبكة
//         LAN افتراضياً على macOS — يخالف سياسة نطاق macOS في AGENTS.md التي
//         تشترط أن يبقى أي مسار شبكي جديد loopback-only افتراضياً.
//   P1-2: تغيير PORT كان يُضيف مَنفذاً منشوراً جديداً بجانب 5173 الموروث من
//         docker-compose.yml الأساسي بدل استبداله — بسبب قواعد دمج Compose
//         (unique بـ{ip, target, published, protocol}؛ راجع
//         https://docs.docker.com/reference/compose-file/merge/#unique-resources).
//
// المبدأ المفحوص هنا ثابت نصياً (بلا Docker CLI، ليعمل في أي بيئة CI):
// docker-compose.dev.yml يجب أن يستبدل قائمة ports بالكامل (!override) بمنفذ
// وحيد مربوط صراحة بـ127.0.0.1، وdocker-compose.dev.lan.yml (opt-in منفصل
// وصريح فقط) هو الموضع الوحيد المسموح فيه بربط كل الواجهات. تحقّق التشغيل
// الفعلي (`docker compose config` + حاوية تعمل فعلياً، للمنفذ الافتراضي وPORT
// بديل، مع تأكيد رفض الوصول من LAN افتراضياً وقبوله بعد opt-in) نُفِّذ يدوياً
// خارج هذا الفحص، ويُوثَّق في PR #174.

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

// نزيل التعليقات قبل الفحص كي لا تُطابق الأنماط داخل شرح نصي بالخطأ.
function stripComments(src) {
  return src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
}

const base = readFileSync("docker-compose.yml", "utf8");
const devRaw = readFileSync("docker-compose.dev.yml", "utf8");
const lanRaw = readFileSync("docker-compose.dev.lan.yml", "utf8");
const dev = stripComments(devRaw);
const lan = stripComments(lanRaw);

test("docker-compose.yml الأساسي لم يتغيّر منفذه (5173:5173 بلا host_ip)", () => {
  assert.match(base, /ports:\s*\n\s*-\s*"5173:5173"/, "المنفذ الأساسي يجب أن يبقى كما هو");
});

test("overlay التطوير الافتراضي يستبدل ports كاملة (!override) لا يدمجها", () => {
  assert.match(dev, /ports:\s*!override\s*\n\s*-\s*"127\.0\.0\.1:\$\{PORT:-5173\}:5173"/,
    "docker-compose.dev.yml يجب أن يحوي ports: !override بمنفذ 127.0.0.1 وحيد");
  // مفتاح ports يظهر مرة واحدة فقط في الملف كله (لا كتلة منفذ إضافية بجانبها).
  assert.equal((dev.match(/^\s*ports:/gm) || []).length, 1,
    "يجب أن يوجد مفتاح ports واحد فقط في overlay التطوير");
});

test("overlay التطوير الافتراضي لا يربط 0.0.0.0 صراحةً في ports", () => {
  // HOST=0.0.0.0 في environment مقصود (ربط داخل الحاوية، موثّق) ومختلف عن
  // ربط منفذ المضيف؛ الفحص هنا يخص سطر ports تحديداً لا environment.
  const portsBlock = dev.match(/ports:\s*!override\s*\n(\s*-.*\n?)+/)?.[0] || "";
  assert.ok(!/0\.0\.0\.0/.test(portsBlock), "منفذ overlay التطوير الافتراضي لا يجوز أن يربط 0.0.0.0");
  assert.match(portsBlock, /127\.0\.0\.1/, "منفذ overlay التطوير الافتراضي يجب أن يُقيَّد بـ127.0.0.1");
});

test("LAN opt-in منفصل تماماً في ملف مستقل غير مُحمَّل تلقائياً", () => {
  assert.match(lan, /ports:\s*!override\s*\n\s*-\s*"\$\{PORT:-5173\}:5173"/,
    "docker-compose.dev.lan.yml يجب أن يستبدل ports بمنفذ بلا host_ip (كل الواجهات)");
  assert.ok(!/127\.0\.0\.1/.test(lan.match(/ports:[\s\S]*/)?.[0] || ""),
    "ملف LAN opt-in لا يجوز أن يقيّد بـ127.0.0.1 — فهو المخصص لفتح LAN عمداً");
});

test("توثيق macOS: كل ذكر لملف LAN opt-in يوضّح أنه استثناء مقصود لا افتراضي", () => {
  assert.match(devRaw, /opt-in/, "تعليق overlay التطوير يجب أن يشرح أن LAN اختياري وواعٍ");
  assert.match(lanRaw, /AGENTS\.md/, "ملف LAN opt-in يجب أن يشير لسياسة نطاق macOS");
});

console.log("فحص ربط منفذ overlay تطوير Docker:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص ربط منفذ overlay تطوير Docker نجحت.");
