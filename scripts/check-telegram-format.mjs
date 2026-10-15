// ============================================================================
// فحص التنسيق الموحّد لرسائل تيليغرام (src/telegram-format.js) ومستهلكيه.
// كل الأسماء والكميات مصطنعة؛ لا بيانات إنتاج، لا شبكة، لا إرسال.
// ============================================================================
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/telegram-format.js";
import "../src/stock-alert-priority.js";
import { sampleInput } from "./telegram-alert-samples.mjs";

const f = globalThis.ozkTelegramFormat;
const engine = globalThis.ozkStockAlertPriority;
assert.ok(f, "src/telegram-format.js لم يعرّف ozkTelegramFormat");

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error?.stack || error}`); }
}

const RLM = "\u200F";
const LRI = "\u2066";
const FSI = "\u2068";
const PDI = "\u2069";
// بلا العلم g: يُستعمل مع .test() وحده، والعلم g يجعل lastIndex حالة بين الاستدعاءات.
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

// عزل متوازن: كل LRI/FSI يُغلق بـPDI في السطر نفسه.
function assertBalancedIsolates(message) {
  for (const line of message.split("\n")) {
    let depth = 0;
    for (const ch of line) {
      if (ch === LRI || ch === FSI) depth += 1;
      if (ch === PDI) { depth -= 1; assert.ok(depth >= 0, `PDI بلا فاتح: ${JSON.stringify(line)}`); }
    }
    assert.equal(depth, 0, `عزل غير مغلق: ${JSON.stringify(line)}`);
  }
}

test("العربية: كل سطر يبدأ بـRLM فيبقى اتجاهه من اليمين حتى لو بدأ باسم لاتيني", () => {
  const line = f.line(`🔴 ${f.name("Marlboro Gold 20s")}`);
  assert.equal(line, `${RLM}🔴 ${FSI}Marlboro Gold 20s${PDI}`);
  assert.equal(f.line(""), "", "السطر الفارغ لا يحمل علامة");
  assert.equal(f.field("الحالة", "نافد"), `${RLM}الحالة: نافد`);
});

test("الأرقام: إنجليزية بفواصل آلاف ومعزولة LTR، والكسور بلا أصفار زائدة", () => {
  assert.equal(f.num(1234567.25, 2), `${LRI}1,234,567.25${PDI}`);
  assert.equal(f.num(1.2), `${LRI}1.2${PDI}`);
  assert.equal(f.num(3.0), `${LRI}3${PDI}`);
  assert.equal(f.num(0.04), `${LRI}0${PDI}`);
  assert.equal(f.num("12.5"), `${LRI}12.5${PDI}`);
  assert.equal(f.num(NaN), `${LRI}—${PDI}`);
  assert.equal(f.num(null), `${LRI}0${PDI}`);
  assert.ok(!/[٠-٩]/u.test(f.num(9876543.21, 2)), "لا أرقام هندية");
});

test("القيم السالبة: الإشارة قبل الرقم داخل العزل (لا تنقلب إلى 5-)، و-0 تُعرض 0", () => {
  assert.equal(f.num(-5, 0), `${LRI}-5${PDI}`);
  assert.equal(f.num(-1234.5), `${LRI}-1,234.5${PDI}`);
  assert.equal(f.num(-0.01), `${LRI}0${PDI}`);
  assert.equal(f.num(-0), `${LRI}0${PDI}`);
});

test("أحرف HTML الخاصة تبقى نصاً حرفياً بلا تهريب ولا تفسير (لا parse_mode)", () => {
  const raw = `كليوباترا <b>سوبر</b> & "كينغ" 'L&M' <script>x</script> &amp;`;
  assert.equal(f.clean(raw), raw);
  assert.equal(f.name(raw), `${FSI}${raw}${PDI}`, "لا تحويل & إلى &amp; — التهريب المزدوج يظهر للمستخدم");
});

test("حقن الاتجاه والأسطر: محارف RLO/LRE/RLM وأسطر جديدة داخل اسم تُحذف فلا تكسر البطاقة", () => {
  const evil = "صنف\u202E عكسي\u202C\nسطر جديد\r\n\u2069هروب\u2066\u200E\t مسافات   كثيرة\u2028";
  const cleaned = f.clean(evil);
  assert.equal(cleaned, "صنف عكسي سطر جديد هروب مسافات كثيرة");
  assert.ok(!BIDI_RE.test(cleaned));
  assert.ok(!f.name(evil).includes("\n"));
  assertBalancedIsolates(f.name(evil));
});

test("الأسماء الطويلة تُقصّ عند MAX_NAME_CHARS بعلامة … دون شطر محرف مركّب", () => {
  const long = "🟢".repeat(200);
  const cleaned = f.clean(long);
  assert.equal(Array.from(cleaned).length, f.MAX_NAME_CHARS);
  assert.ok(cleaned.endsWith("…"));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(cleaned), "لا نصف زوج بديل");
  assert.equal(f.name(""), `${FSI}—${PDI}`);
  assert.equal(f.name(null), `${FSI}—${PDI}`);
});

test("التقسيم: رسائل مرقّمة تحت الحد، لا تُشطر كتلة، والمقدمة أولاً والخاتمة أخيراً", () => {
  const blocks = Array.from({ length: 120 }, (_, i) => [f.line(`🔴 ${f.name(`صنف ${i + 1} Mixed Name`)}`), f.field("الرصيد", f.num(-i, 0))]);
  const parts = f.composeMessages({ title: "⚠️ عنوان", intro: [f.line("مقدمة")], blocks, footer: [f.line("خاتمة")], maxChars: 600 });
  assert.ok(parts.length > 3);
  parts.forEach((part, i) => {
    assert.ok(part.length <= 600, `الجزء ${i + 1} طوله ${part.length}`);
    assert.ok(part.startsWith(`${RLM}⚠️ عنوان (${i + 1}/${parts.length})\n`));
    assert.equal(part.includes("مقدمة"), i === 0);
    assert.equal(part.includes("خاتمة"), i === parts.length - 1);
    assertBalancedIsolates(part);
  });
  const seen = parts.flatMap((part) => part.split(`\n${RLM}${f.SEPARATOR}\n`).slice(1))
    .filter((block) => block.includes("🔴"))
    .map((block) => block.split("\n"));
  assert.equal(seen.length, 120, "كل كتلة ظهرت مرة واحدة كاملة");
  assert.ok(seen.every((block) => block.length === 2));
});

test("التقسيم: رسالة قصيرة واحدة بلا ترقيم، وبلا كتل تبقى المقدمة والخاتمة", () => {
  const [one, ...rest] = f.composeMessages({ title: "عنوان", intro: [f.line("أ")], footer: [f.line("ب")] });
  assert.equal(rest.length, 0);
  assert.equal(one, `${RLM}عنوان\n${RLM}أ\n${RLM}${f.SEPARATOR}\n${RLM}ب`);
});

test("التقسيم: كتلة أكبر من الحد وحدها تُرسل منفردة مقصوصة بعلامة ولا تتجاوز الحد", () => {
  const huge = [Array.from({ length: 100 }, (_, i) => f.line(`سطر ${i}`))];
  const parts = f.composeMessages({ title: "عنوان", blocks: [[f.line("صغيرة")], ...huge, [f.line("بعدها")]], maxChars: 400 });
  assert.ok(parts.every((part) => part.length <= 400));
  assert.ok(parts.some((part) => part.endsWith(`${RLM}…`)));
  assert.ok(parts.some((part) => part.includes("صغيرة")) && parts.some((part) => part.includes("بعدها")));
});

test("الحد الافتراضي تحت قصّ notify_telegram (3900) وحد تيليغرام (4096)", () => {
  assert.ok(f.DEFAULT_MAX_CHARS <= 3900 - 100);
  assert.ok(engine.CONFIG.maxMessageChars <= f.DEFAULT_MAX_CHARS);
  const sql = readFileSync("supabase/telegram-notifications.sql", "utf8");
  assert.match(sql, /left\(p_message, 3900\)/);
});

test("تنبيه النفاد: أسماء مختلطة وسالبة وHTML في بطاقات كاملة متوازنة العزل", () => {
  const r = engine.buildStockAlerts(sampleInput());
  assert.equal(r.status, "alert");
  const message = r.messages[0].message;
  assertBalancedIsolates(message);
  for (const line of message.split("\n")) assert.ok(line.startsWith(RLM));
  const plain = f.stripBidi(message);
  assert.ok(plain.includes("🔴 كليوباترا <سوبر> & كينغ\nالحالة: نافد\n"), "اسم بأحرف HTML يظهر حرفياً");
  assert.ok(plain.includes("الرصيد: -5 كروز\nيعادل: -0.1 كرتونة\nيكفي: 0 يوم"), "الرصيد السالب كما هو، بلا تغيير في الحساب");
  assert.ok(plain.includes("🟠 ونستون أزرق — 100mm\nالحالة: قريب من النفاد\n"));
  assert.ok(message.includes(`الرصيد: ${LRI}-5${PDI} كروز`));
});

test("تنبيه النفاد الطويل: عدة رسائل مرقمة، كل بطاقة كاملة في رسالة واحدة، والترتيب بالأولوية", () => {
  const r = engine.buildStockAlerts(sampleInput({ long: true }));
  assert.ok(r.messages.length > 1);
  const ranks = [];
  r.messages.forEach((m, i) => {
    assert.ok(m.message.length <= engine.CONFIG.maxMessageChars);
    assertBalancedIsolates(m.message);
    const plain = f.stripBidi(m.message);
    assert.ok(plain.startsWith(`⚠️ أصناف مهمة قاربت النفاد (${i + 1}/${r.messages.length})\n`));
    for (const block of plain.split(`\n${f.SEPARATOR}\n`).slice(1)) {
      if (!/^[🔴🟠] /u.test(block)) continue;
      const lines = block.split("\n");
      assert.deepEqual(lines.slice(1).map((l) => l.split(":")[0]), ["الحالة", "الأولوية", "الرصيد", "يعادل", "يكفي"]);
      ranks.push(Number(lines[2].match(/^الأولوية: (\d+) من /)[1]));
    }
  });
  assert.deepEqual(ranks, Array.from({ length: r.alerts.length }, (_, i) => i + 1));
});

test("التنسيق لا يغيّر الحسابات: حالات الأصناف وأولوياتها وأيام تغطيتها من المحرك كما هي", () => {
  const r = engine.buildStockAlerts(sampleInput());
  const plain = f.stripBidi(r.messages[0].message);
  for (const alert of r.alerts) {
    assert.ok(plain.includes(`الأولوية: ${alert.priorityRank} من ${alert.priorityTotal}`));
    assert.ok(plain.includes(`الحالة: ${alert.status === "out" ? "نافد" : "قريب من النفاد"}`));
    if (alert.status === "low") assert.ok(plain.includes(`يكفي: ${engine.formatNumber(alert.coverageDays)} يوم`));
  }
});

test("صنف بلا معامل وحدة ثانية: لا سطر «يعادل» والرصيد بخانة عشرية", () => {
  const input = sampleInput();
  for (const row of [...input.stockReport.items, ...input.salesReport.items]) row.unit2Factor = null;
  input.stockReport.items[1].stockQty = 12.5;
  const r = engine.buildStockAlerts(input);
  const plain = f.stripBidi(r.messages[0].message);
  assert.ok(!plain.includes("يعادل"));
  assert.ok(plain.includes("الرصيد: 12.5 كروز"));
});

test("غياب المنسِّق خطأ صريح لا رسالة بتنسيق آخر", () => {
  const saved = globalThis.ozkTelegramFormat;
  try {
    delete globalThis.ozkTelegramFormat;
    assert.throws(() => engine.buildStockAlerts(sampleInput()), /telegram_format_unavailable/);
  } finally {
    globalThis.ozkTelegramFormat = saved;
  }
});

test("نسخة الخادم من المنسِّق تطابق src بايتاً ببايت، ولا parse_mode في أي مسار", () => {
  assert.equal(readFileSync("supabase/functions/_shared/telegram-format.js", "utf8"), readFileSync("src/telegram-format.js", "utf8"),
    "شغّل: cp src/telegram-format.js supabase/functions/_shared/");
  for (const path of ["src/telegram-format.js", "src/stock-alert-priority.js", "supabase/functions/stock-priority-alert/index.ts", "scripts/stock-priority-alerts.mjs", "supabase/functions/customer-inactivity-alert/index.ts"]) {
    assert.doesNotMatch(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""), /parse_mode/, `${path}: الموزّع يرسل بلا parse_mode`);
  }
  assert.match(readFileSync("scripts/stock-priority-alerts.mjs", "utf8"), /import "\.\.\/src\/telegram-format\.js";\nimport "\.\.\/src\/stock-alert-priority\.js";/);
});

// ── المرحلة A: العملة والوقت والأهمية والتقريب والقصّ الآمن ─────────────────

test("التقريب بعيداً عن الصفر عند النصف وبالتمثيل العشري (يطابق round() في Postgres)", () => {
  assert.equal(f.num(-2.25), `${LRI}-2.3${PDI}`, "Math.round كان يعطي -2.2");
  assert.equal(f.num(2.25), `${LRI}2.3${PDI}`);
  assert.equal(f.num(1.005, 2), `${LRI}1.01${PDI}`, "الفاصلة العائمة كانت تعطي 1");
  assert.equal(f.num(0.15), `${LRI}0.2${PDI}`);
  assert.equal(f.num(-0.05), `${LRI}-0.1${PDI}`);
  assert.equal(f.num(-0.04), `${LRI}0${PDI}`, "لا «-0»");
  assert.equal(f.num(1e-7, 2), `${LRI}0${PDI}`, "الأس العلمي لا يكسر التقريب");
  assert.equal(f.num(2.5, 0), `${LRI}3${PDI}`);
  assert.equal(f.num(-2.5, 0), `${LRI}-3${PDI}`);
  assert.equal(f.num(1234567890123.456, 2), `${LRI}1,234,567,890,123.46${PDI}`, "لا ### للمبالغ الكبيرة");
});

test("العملة: الرقم معزولاً ثم الرمز بعده، والسالب لا ينقلب، والرموز المعروفة موحّدة", () => {
  assert.equal(f.money(1234.5), `${LRI}1,234.5${PDI} $`);
  assert.equal(f.money(-350000, "SYP", 0), `${LRI}-350,000${PDI} ل.س`);
  assert.equal(f.money(12.75, "usd"), `${LRI}12.75${PDI} $`);
  assert.equal(f.money(2.5, "ل.س"), `${LRI}2.5${PDI} ل.س`);
  assert.equal(f.money(10, "EUR‮"), `${LRI}10${PDI} EUR`, "رمز مجهول يُنظَّف ويُعرض كما هو");
  assert.equal(f.money(10, ""), `${LRI}10${PDI}`);
  assert.equal(f.money("x"), `${LRI}—${PDI} $`);
  assert.equal(f.stripBidi(f.line(`الرصيد: ${f.money(-1250.5)}`)), "الرصيد: -1,250.5 $");
});

test("الوقت بتوقيت دمشق ومعزول LTR كي لا ينقلب «التاريخ الوقت»", () => {
  assert.equal(f.time("2026-10-14T20:00:00Z"), `${LRI}2026-10-14 23:00${PDI} (دمشق)`);
  assert.equal(f.time(new Date("2026-01-01T21:30:00Z")), `${LRI}2026-01-02 00:30${PDI} (دمشق)`, "منتصف الليل وتجاوز اليوم");
  assert.equal(f.time(Date.UTC(2026, 6, 1, 5, 0)), `${LRI}2026-07-01 08:00${PDI} (دمشق)`, "ms رقمية؛ دمشق UTC+3 صيفاً وشتاءً");
  assert.equal(f.time("2026-10-14T20:00:00Z", { withZone: false }), `${LRI}2026-10-14 23:00${PDI}`);
  assert.equal(f.time("2026-10-14T22:30:00Z", { dateOnly: true }), `${LRI}2026-10-15${PDI}`);
  for (const bad of [null, undefined, "", "غير تاريخ", NaN]) assert.equal(f.time(bad), `${LRI}—${PDI}`);
  assert.equal(f.TIME_ZONE, "Asia/Damascus");
});

test("مستوى الأهمية: رمز + تسمية عربية من المفتاح أو التسمية، والمجهول نص منظّف", () => {
  assert.equal(f.severity("critical"), "🔴 حرج");
  assert.equal(f.severity("حرج"), "🔴 حرج");
  assert.equal(f.severity("عالٍ"), "🟠 عالٍ");
  assert.equal(f.severity("عالي"), "🟠 عالٍ");
  assert.equal(f.severity("متوسط"), "🟡 متوسط");
  assert.equal(f.severity("منخفض"), "🔵 منخفض");
  assert.equal(f.severity("ok"), "🟢 سليم");
  assert.equal(f.severity("info"), "ℹ️ معلومة");
  assert.equal(f.severity("طارئ‮"), "طارئ");
  assert.equal(f.severity(null), "—");
  assert.ok(Object.isFrozen(f.SEVERITY) && Object.isFrozen(f.SEVERITY.critical));
});

test("name: حد قصّ اختياري أطول للعناوين، والافتراضي 120 كما هو", () => {
  const long = "أ".repeat(200);
  assert.equal(Array.from(f.stripBidi(f.name(long))).length, f.MAX_NAME_CHARS);
  assert.equal(Array.from(f.stripBidi(f.name(long, "—", 300))).length, 200);
  assert.equal(Array.from(f.stripBidi(f.name("ب".repeat(400), "—", 300))).length, 300);
});

test("التقسيم الآمن: كتلة ضخمة تُقصّ بأسطر كاملة، وسطر واحد ضخم بلا عزل مفتوح ولا نصف محرف", () => {
  const manyLines = [Array.from({ length: 200 }, (_, i) => f.field(`بند ${i}`, f.num(-i * 1000.5)))];
  const parts = f.composeMessages({ title: "عنوان", blocks: manyLines, maxChars: 500 });
  for (const part of parts) {
    assert.ok(part.length <= 500);
    assertBalancedIsolates(part);
    for (const l of part.split("\n")) assert.ok(l.startsWith(RLM), `سطر بلا RLM: ${JSON.stringify(l)}`);
  }
  const oneLine = [[f.line(`🔴 ${f.name("🟢".repeat(110))} ${f.num(-5)} ${"x".repeat(900)}`)]];
  const [cut] = f.composeMessages({ title: "عنوان", blocks: oneLine, maxChars: 300 });
  assert.ok(cut.length <= 300);
  assertBalancedIsolates(cut);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(cut), "لا نصف زوج بديل");
  assert.ok(cut.endsWith(`${RLM}…`));
});

test("المنسِّق لا يحوي parse_mode ولا وسوم HTML في المخرجات", () => {
  const sample = [f.money(-1, "SYP"), f.time("2026-10-14T20:00:00Z"), f.severity("حرج"), f.name("<b>x</b>")].join(" ");
  assert.ok(sample.includes("<b>x</b>"), "النص الحرفي يبقى حرفياً");
  assert.doesNotMatch(readFileSync("src/telegram-format.js", "utf8").replace(/^\s*\/\/.*$/gm, ""), /parse_mode/);
});

// ── فحص صحة الموقع (scripts/health-check.mjs) ───────────────────────────────

const { buildHealthTelegramMessage, telegramDedupeKey } = await import("./health-check.mjs");
const AT = new Date("2026-10-14T20:00:00Z");

test("فحص الصحة: عنوان ثابت، وقت دمشق، أهمية برمز، فاصل، المشكلة معزولة والرابط آخر سطره", () => {
  const message = buildHealthTelegramMessage(
    { key: "site-down", title: "الموقع لا يستجيب (https://example.test/)", severity: "حرج" },
    "https://github.com/example/repo/issues/41", AT);
  assertBalancedIsolates(message);
  for (const l of message.split("\n")) assert.ok(l.startsWith(RLM));
  assert.equal(f.stripBidi(message), [
    "🩺 مشكلة اكتشفتها المراقبة الآلية",
    "الوقت: 2026-10-14 23:00 (دمشق)",
    "الخطورة: 🔴 حرج",
    f.SEPARATOR,
    "المشكلة: الموقع لا يستجيب (https://example.test/)",
    "الرابط: https://github.com/example/repo/issues/41"
  ].join("\n"));
  assert.ok(message.endsWith("https://github.com/example/repo/issues/41"), "لا محرف خفي بعد الرابط فيبقى قابلاً للنقر");
  assert.ok(message.includes(`${FSI}الموقع لا يستجيب (https://example.test/)${PDI}`));
});

test("فحص الصحة: بلا Issue، وأهمية مجهولة، وعنوان بحقن اتجاه وأسطر، وعنوان طويل", () => {
  const noIssue = f.stripBidi(buildHealthTelegramMessage({ title: "انهار الفحص", severity: "عالٍ" }, null, AT));
  assert.ok(noIssue.endsWith("الرابط: تعذّر إنشاء Issue، راجع سجل health-check.yml"));
  assert.ok(noIssue.includes("الخطورة: 🟠 عالٍ"));
  const evil = buildHealthTelegramMessage({ title: "سير ‮عمل\nسطر \"CI\" على الفرع \"main\"", severity: "غريب" }, "https://x.test/issues/1", AT);
  assertBalancedIsolates(evil);
  assert.equal(evil.split("\n").length, 6, "لا أسطر محقونة");
  assert.ok(f.stripBidi(evil).includes("المشكلة: سير عمل سطر \"CI\" على الفرع \"main\""));
  assert.ok(f.stripBidi(evil).includes("الخطورة: غريب"));
  const long = buildHealthTelegramMessage({ title: "ت".repeat(500), severity: "متوسط" }, null, AT);
  assert.ok(long.length < f.DEFAULT_MAX_CHARS);
  assert.ok(f.stripBidi(long).includes(`${"ت".repeat(299)}…`));
});

test("فحص الصحة: مفاتيح منع التكرار ونوع الحدث ونافذته بلا تغيير", () => {
  assert.equal(telegramDedupeKey("site-down", 42), "health-site-down-issue-42");
  assert.equal(telegramDedupeKey("site-down", null, 5 * 3600000 + 1), "health-site-down-noissue-5");
  const src = readFileSync("scripts/health-check.mjs", "utf8");
  assert.match(src, /p_event_type: "health_check"/);
  assert.match(src, /p_dedupe_key: telegramDedupeKey\(problem\.key, issueNumber\)/);
  assert.match(src, /async function notifyTelegram\(problem, issueUrl, dedupeMinutes = 180\)/);
  assert.match(src, /import "\.\.\/src\/telegram-format\.js";/);
  assert.match(src, /catch \(err\) \{\n\s*\/\/ التنسيق لا يجوز أن يُسقط التنبيه نفسه/, "تعذّر التنسيق يرسل نصاً احتياطياً بدل إسقاط التنبيه");
});

// ── تنبيه فشل GitHub Actions: تنفيذ خطوة الـworkflow فعلياً مع curl وهمي ─────

const wfText = readFileSync(".github/workflows/alert-on-automation-failure.yml", "utf8");
const runStart = wfText.indexOf("        run: |\n");
const runScript = wfText.slice(runStart + "        run: |\n".length)
  .split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
const haveTools = ["bash", "jq"].every((bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0);

function runAlertStep(env, { breakFormatting = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gha-alert-"));
  const capture = join(dir, "payload.json");
  writeFileSync(join(dir, "curl"), `#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -d) printf '%s' "$2" > "${capture}"; shift;; -o) echo '""' > "$2"; shift;; esac; shift; done\nprintf 204\n`, { mode: 0o755 });
  if (breakFormatting) {
    const realJq = spawnSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(dir, "jq"), `#!/bin/bash\nif [ "$1" = "-nr" ]; then exit 3; fi\nexec "${realJq}" "$@"\n`, { mode: 0o755 });
  }
  writeFileSync(join(dir, "run.sh"), runScript);
  const result = spawnSync("bash", ["-e", join(dir, "run.sh")], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "fake-key", RUN_URL: "https://github.com/example/repo/actions/runs/1", BRANCH: "main", RUN_ATTEMPT: "2", CONCLUSION: "failure", WF_NAME: "Deploy TOBACCO Web", ...env }
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(readFileSync(capture, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return payload;
}

test("فشل GitHub Actions: الرسالة الفعلية من خطوة الـworkflow بالتنسيق الموحّد", () => {
  if (!haveTools) { assert.ok(!process.env.CI, "bash/jq مطلوبان في CI"); return; }
  const payload = runAlertStep({});
  const message = payload.p_message;
  assertBalancedIsolates(message);
  for (const l of message.split("\n")) assert.ok(l.startsWith(RLM), `سطر بلا RLM: ${JSON.stringify(l)}`);
  const plain = f.stripBidi(message).split("\n");
  assert.equal(plain[0], "🚨 فشل أتمتة");
  assert.match(plain[1], /^الوقت: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(دمشق\)$/);
  assert.deepEqual(plain.slice(2), ["المنصة: GitHub Actions", f.SEPARATOR, "سير العمل: Deploy TOBACCO Web", "النتيجة: فشل", "الفرع: main", "المحاولة: 2", "الرابط: https://github.com/example/repo/actions/runs/1"]);
  assert.ok(message.includes(`${FSI}Deploy TOBACCO Web${PDI}`) && message.includes(`المحاولة: ${LRI}2${PDI}`));
  assert.ok(message.endsWith("https://github.com/example/repo/actions/runs/1"));
});

test("فشل GitHub Actions: كل نتيجة معروفة معرّبة، والمجهولة معزولة كما هي", () => {
  if (!haveTools) return;
  const expected = { failure: "فشل", timed_out: "تجاوز المهلة", cancelled: "أُلغي", startup_failure: "تعذّر بدء التشغيل", action_required: "ينتظر إجراءً يدوياً", neutral: "انتهى بلا نتيجة", stale: "تقادم قبل الاكتمال" };
  for (const [conclusion, label] of Object.entries(expected)) {
    assert.ok(f.stripBidi(runAlertStep({ CONCLUSION: conclusion }).p_message).includes(`\nالنتيجة: ${label}\n`), conclusion);
  }
  assert.ok(runAlertStep({ CONCLUSION: "brand_new" }).p_message.includes(`النتيجة: ${FSI}brand_new${PDI}`));
});

test("فشل GitHub Actions: اسم بحقن اتجاه وأسطر لا يكسر الرسالة، ومفتاح منع التكرار والنافذة كما هما", () => {
  if (!haveTools) return;
  const name = "سير ‮عمل\nخبيث";
  const payload = runAlertStep({ WF_NAME: name });
  assert.equal(payload.p_event_type, "github_actions_failure");
  assert.equal(payload.p_dedupe_key, `gha-fail:${name}`, "المفتاح من الاسم الخام كما كان");
  assert.equal(payload.p_dedupe_minutes, 60);
  assertBalancedIsolates(payload.p_message);
  assert.equal(payload.p_message.split("\n").length, 9);
  assert.ok(f.stripBidi(payload.p_message).includes("سير العمل: سير عمل خبيث"));
});

test("فشل GitHub Actions: تعذّر التنسيق يرسل نصاً احتياطياً بالمعلومات ذاتها بدل إسقاط التنبيه", () => {
  if (!haveTools) return;
  const payload = runAlertStep({ CONCLUSION: "timed_out" }, { breakFormatting: true });
  assert.equal(payload.p_message, "🚨 فشل أتمتة\nسير العمل: Deploy TOBACCO Web\nالنتيجة: timed_out\nالفرع: main\nالمحاولة: 2\nالرابط: https://github.com/example/repo/actions/runs/1");
  assert.equal(payload.p_dedupe_key, "gha-fail:Deploy TOBACCO Web");
});

console.log("check-telegram-format:");
console.log(results.join("\n"));
if (failed) {
  console.error(`❌ ${failed} فحصاً فشل.`);
  process.exit(1);
}
