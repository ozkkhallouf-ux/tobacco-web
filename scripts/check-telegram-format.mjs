// ============================================================================
// فحص التنسيق الموحّد لرسائل تيليغرام (src/telegram-format.js) ومستهلكيه.
// كل الأسماء والكميات مصطنعة؛ لا بيانات إنتاج، لا شبكة، لا إرسال.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

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
  for (const path of ["src/telegram-format.js", "src/stock-alert-priority.js", "supabase/functions/stock-priority-alert/index.ts", "scripts/stock-priority-alerts.mjs"]) {
    assert.doesNotMatch(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""), /parse_mode/, `${path}: الموزّع يرسل بلا parse_mode`);
  }
  assert.match(readFileSync("scripts/stock-priority-alerts.mjs", "utf8"), /import "\.\.\/src\/telegram-format\.js";\nimport "\.\.\/src\/stock-alert-priority\.js";/);
});

test("تنبيه فشل GitHub Actions: سطر لكل حقل، عنوان أولاً، والقيم الديناميكية في أسطر بتسمية عربية", () => {
  const wf = readFileSync(".github/workflows/alert-on-automation-failure.yml", "utf8");
  const fmt = wf.match(/MESSAGE=\$\(printf '([^']+)'/)[1];
  assert.equal(fmt.split("\\n")[0], "🚨 فشل أتمتة GitHub Actions");
  for (const label of ["سير العمل", "النتيجة", "الفرع", "المحاولة", "الرابط"]) assert.ok(fmt.includes(`\\n${label}: `), `${label} ناقص`);
});

console.log("check-telegram-format:");
console.log(results.join("\n"));
if (failed) {
  console.error(`❌ ${failed} فحصاً فشل.`);
  process.exit(1);
}
