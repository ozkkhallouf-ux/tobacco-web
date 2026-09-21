// ============================================================================
// حارس عقد هوية السعر — B (نقطة الحفظ) + A-lite (نقطة الكتابة إلى الأمين).
//
// العطل الذي يمنعه: بطاقة أمين واحدة قد يشير إليها أكثر من item_key في
// approved_price_items (مفاتيح موروثة سبقت التطبيع الحالي). حين تختلف أسعارها
// كان الفائز يُحسم بفارق أجزاء من الثانية في updated_at، فتتغيّر أسعار حقيقية
// بصمت عند أي إعادة حفظ تقلب الترتيب (رُصد فرق 6.5% على «فحم إيكو نارة أحمر»).
//
// القاعدة المعتمدة (قرار المالك، لا اجتهاد):
//   تعارض ⟺ حقل سعري مُدار واحد يحمل أكثر من قيمة موجبة مميّزة داخل صفوف
//   نفس item_guid. القيمة 0 = «غير مسعّر» ولا تعارض قيمة موجبة.
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const results = [];
function test(name, fn) {
  fn();
  results.push(name);
}

// ---------------------------------------------------------------------------
// تحميل النواة النقية في sandbox (نفس نمط invRecCalc في scripts/check.mjs)
// ---------------------------------------------------------------------------
const guardSource = readFileSync(new URL("../src/price-guid-conflict.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(guardSource, sandbox, { filename: "price-guid-conflict.js" });
const guard = sandbox.window.priceGuidConflict;
// الكود وحده بلا تعليقات: التعليقات تشرح لماذا لا نستعمل updated_at، فلا
// يجوز أن يُفشِل ذكرُها الشارح تأكيدات «لا يُقرأ إطلاقاً» أدناه.
const guardCode = guardSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
assert.ok(guard, "price-guid-conflict.js يجب أن يعرّف window.priceGuidConflict");
const { findGuidPriceConflicts, formatConflictMessage } = guard;

const GUID_A = "A4EAA24F-89CF-4E3A-8B3A-D82039AE9DFB";
const GUID_B = "E91B49C6-3AC3-4622-B44D-65DF2F05EB94";

/** صف مختصر: retail يُكتب في price_payload.retail.price كما في قاعدة البيانات. */
function row(itemKey, guid, { wholesale = 0, unit1 = 0, retail = 0, ...rest } = {}) {
  return {
    item_key: itemKey,
    item_name: itemKey,
    item_guid: guid,
    unit2_price: wholesale,
    sale_price: unit1,
    price_payload: retail ? { retail: { price: retail } } : {},
    ...rest
  };
}

// ---------------------------------------------------------------------------
// ١) تعارض = أكثر من قيمة موجبة مميّزة فقط
// ---------------------------------------------------------------------------
test("1) قيمتان موجبتان مختلفتان لنفس الحقل = تعارض", () => {
  const conflicts = findGuidPriceConflicts([
    row("نارة", GUID_A, { wholesale: 33, unit1: 2.063 }),
    row("ناره", GUID_A, { wholesale: 31, unit1: 1.938 })
  ]);
  assert.equal(conflicts.length, 2, "الكرتونة والكروز كلاهما متعارض");
  assert.deepEqual(Array.from(conflicts, (c) => c.field).sort(), ["wholesaleCarton", "wholesaleUnit1"]);
  assert.equal(conflicts[0].guid, GUID_A);
});

test("1ب) قيمتان موجبتان متساويتان = لا تعارض", () => {
  assert.equal(
    findGuidPriceConflicts([
      row("أ", GUID_A, { wholesale: 96, unit1: 8 }),
      row("ب", GUID_A, { wholesale: 96, unit1: 8 })
    ]).length,
    0
  );
});

// ---------------------------------------------------------------------------
// ٢) 0 + موجب = لا تعارض  (الصفر = «غير مسعّر»، لا رأي)
// ---------------------------------------------------------------------------
test("2) صفر مقابل قيمة موجبة = لا تعارض", () => {
  const conflicts = findGuidPriceConflicts([
    row("نخلة صلاحية شهر 1", GUID_A, { wholesale: 385, unit1: 15.4, retail: 0 }),
    row("نخله صلاحيه شهر 1", GUID_A, { wholesale: 385, unit1: 15.4, retail: 325 })
  ]);
  assert.equal(conflicts.length, 0, "الصفر لا يعارض 325 — وإلا انكسرت مادة تُسعَّر بشكل صحيح");
});

test("2ب) قيم سالبة أو غير رقمية تُعامل معاملة الصفر", () => {
  assert.equal(
    findGuidPriceConflicts([
      row("أ", GUID_A, { wholesale: 96 }),
      { ...row("ب", GUID_A, {}), unit2_price: -5 },
      { ...row("ج", GUID_A, {}), unit2_price: "abc" },
      { ...row("د", GUID_A, {}), unit2_price: null }
    ]).length,
    0
  );
});

// ---------------------------------------------------------------------------
// ٣) 96 و96.00 قيمة واحدة
// ---------------------------------------------------------------------------
test("3) 96 و96.00 و'96.0000' = قيمة واحدة، لا تعارض", () => {
  assert.equal(
    findGuidPriceConflicts([
      row("أ", GUID_A, { wholesale: 96 }),
      row("ب", GUID_A, { wholesale: 96.0 }),
      row("ج", GUID_A, { wholesale: "96.0000" })
    ]).length,
    0
  );
});

// ---------------------------------------------------------------------------
// ٤) و٥) حقول خارج النطاق المُدار لا تُنشئ تعارضاً
// ---------------------------------------------------------------------------
test("4) اختلاف notes وحده = لا تعارض", () => {
  assert.equal(
    findGuidPriceConflicts([
      { ...row("أ", GUID_A, { wholesale: 96 }), notes: "ملاحظة" },
      { ...row("ب", GUID_A, { wholesale: 96 }), notes: "أخرى" }
    ]).length,
    0
  );
});

test("5) اختلاف unit2_factor وحده = لا تعارض", () => {
  assert.equal(
    findGuidPriceConflicts([
      { ...row("أ", GUID_A, { wholesale: 96 }), unit2_factor: 12 },
      { ...row("ب", GUID_A, { wholesale: 96 }), unit2_factor: 24 }
    ]).length,
    0
  );
});

test("5ب) الحقول المُدارة ثلاثة بالضبط", () => {
  assert.deepEqual(
    Array.from(guard.MANAGED_FIELDS, (f) => f.key),
    ["wholesaleCarton", "wholesaleUnit1", "retailCarton"]
  );
});

// ---------------------------------------------------------------------------
// ٦) تركيبة تحاكي الحالة الحية: 53 مكررة متطابقة تمرّ + الخمس تُكتشف
// ---------------------------------------------------------------------------
test("6) 53 بطاقة مكررة بقيم متوافقة تمرّ كلها", () => {
  const rows = [];
  for (let i = 0; i < 53; i++) {
    const g = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    rows.push(row(`مادة-${i}-أ`, g, { wholesale: 100 + i, unit1: 5, retail: 100 + i }));
    rows.push(row(`مادة-${i}-ب`, g, { wholesale: 100 + i, unit1: 5, retail: 100 + i }));
  }
  assert.equal(findGuidPriceConflicts(rows).length, 0, "التكرار وحده ليس عطلاً");
});

test("7) الحالات الخمس المعروفة تُكتشف، وحالتا نخلة لا تُحجبان", () => {
  const five = [
    ["06C55573", { retail: 295 }, { retail: 300 }],
    ["48EC400B", { retail: 95 }, { retail: 96 }],
    ["EEBC5CD4", { retail: 95 }, { retail: 96 }],
    ["A4EAA24F", { wholesale: 33, retail: 32 }, { wholesale: 31, retail: 0 }],
    ["E91B49C6", { wholesale: 170, retail: 170 }, { wholesale: 169, retail: 0 }]
  ];
  const rows = [];
  for (const [g, a, b] of five) {
    rows.push(row(`${g}-أ`, g, a), row(`${g}-ب`, g, b));
  }
  // حالتا نخلة: الجملة متطابقة والمفرق 0 مقابل 325
  rows.push(row("نخلة1-أ", "009039E5", { wholesale: 385, unit1: 15.4, retail: 0 }));
  rows.push(row("نخلة1-ب", "009039E5", { wholesale: 385, unit1: 15.4, retail: 325 }));
  rows.push(row("نخلة10-أ", "BE910FA5", { wholesale: 325, unit1: 13, retail: 0 }));
  rows.push(row("نخلة10-ب", "BE910FA5", { wholesale: 325, unit1: 13, retail: 325 }));

  const conflictedGuids = new Set(findGuidPriceConflicts(rows).map((c) => c.guid));
  assert.equal(conflictedGuids.size, 5, "خمس بطاقات متعارضة بالضبط — لا سادسة");
  for (const [g] of five) assert.ok(conflictedGuids.has(g), `${g} يجب أن يُكتشف`);
  assert.ok(!conflictedGuids.has("009039E5"), "نخلة شهر 1 ليست تعارضاً");
  assert.ok(!conflictedGuids.has("BE910FA5"), "نخلة شهر 10 ليست تعارضاً");
});

// ---------------------------------------------------------------------------
// ٨) بلا item_guid لا تجميع (لا إيجابية كاذبة ولا انكسار للأصناف الجديدة)
// ---------------------------------------------------------------------------
test("8) صفوف بلا item_guid لا تُجمَّع ولا تُنشئ تعارضاً", () => {
  assert.equal(
    findGuidPriceConflicts([
      row("أ", null, { wholesale: 96 }),
      row("ب", "", { wholesale: 95 }),
      row("ج", undefined, { wholesale: 94 })
    ]).length,
    0
  );
});

test("8ب) الهوية تُقارن بعد التطبيع (حالة الأحرف والمسافات)", () => {
  const conflicts = findGuidPriceConflicts([
    row("أ", GUID_B.toLowerCase(), { wholesale: 170 }),
    row("ب", `  ${GUID_B}  `, { wholesale: 169 })
  ]);
  assert.equal(conflicts.length, 1, "نفس المعرّف بحالة أحرف مختلفة = مجموعة واحدة");
});

// ---------------------------------------------------------------------------
// ١١) updated_at لا أثر له إطلاقاً
// ---------------------------------------------------------------------------
test("11) قلب updated_at لا يغيّر النتيجة", () => {
  const a = row("نارة", GUID_A, { wholesale: 33 });
  const b = row("ناره", GUID_A, { wholesale: 31 });
  const forward = findGuidPriceConflicts([
    { ...a, updated_at: "2026-07-26T17:59:15.816Z" },
    { ...b, updated_at: "2026-07-26T17:59:15.050Z" }
  ]);
  const reversed = findGuidPriceConflicts([
    { ...a, updated_at: "2020-01-01T00:00:00.000Z" },
    { ...b, updated_at: "2099-01-01T00:00:00.000Z" }
  ]);
  assert.deepEqual(
    Array.from(forward, (c) => c.field),
    Array.from(reversed, (c) => c.field),
    "الزمن لا يدخل القرار"
  );
  assert.equal(forward.length, 1);
});

test("11ب) الرسالة تعرض الهوية والمفاتيح والقيم المتعارضة", () => {
  const message = formatConflictMessage(
    findGuidPriceConflicts([
      row("فحم ايكو نارة احمر", GUID_A, { wholesale: 33 }),
      row("فحم ايكو ناره احمر", GUID_A, { wholesale: 31 })
    ])
  );
  for (const needle of [GUID_A, "فحم ايكو نارة احمر", "فحم ايكو ناره احمر", "33", "31", "لم يُحفظ"]) {
    assert.ok(message.includes(needle), `الرسالة يجب أن تتضمن «${needle}»`);
  }
  assert.equal(formatConflictMessage([]), "", "بلا تعارض لا رسالة");
});

// ---------------------------------------------------------------------------
// ٩) B: الرفض يسبق أي كتابة في مساري الحفظ معاً
// ---------------------------------------------------------------------------
const clientSource = readFileSync(new URL("../src/supabase-client.js", import.meta.url), "utf8");

function sliceFunction(name) {
  const start = clientSource.indexOf(`async ${name}(items) {`);
  assert.notEqual(start, -1, `تعذّر عزل ${name}()`);
  let depth = 0;
  for (let i = clientSource.indexOf("{", start); i < clientSource.length; i++) {
    if (clientSource[i] === "{") depth++;
    else if (clientSource[i] === "}") {
      depth--;
      if (depth === 0) return clientSource.slice(start, i + 1);
    }
  }
  throw new Error(`أقواس غير متوازنة في ${name}()`);
}

for (const fnName of ["upsertApprovedPriceItems", "replaceApprovedPriceItems"]) {
  test(`9) ${fnName}: الحارس يُستدعى قبل أي delete/insert/upsert`, () => {
    const body = sliceFunction(fnName);
    const guardAt = body.indexOf("assertNoGuidPriceConflict(");
    assert.notEqual(guardAt, -1, `${fnName} يجب أن يستدعي assertNoGuidPriceConflict`);
    for (const writeCall of [".delete(", ".insert(", ".upsert("]) {
      const at = body.indexOf(writeCall);
      if (at === -1) continue;
      assert.ok(
        guardAt < at,
        `${fnName}: ${writeCall} يقع قبل الحارس — أي كتابة محتملة قبل الفحص`
      );
    }
  });
}

test("9ب) الحارس يرمي عند التعارض ولا يُرجع قيمة (لا حفظ جزئي)", () => {
  const helper = clientSource.slice(
    clientSource.indexOf("function assertNoGuidPriceConflict("),
    clientSource.indexOf("function missingSessionMessage(")
  );
  assert.match(helper, /throw new Error\(guard\.formatConflictMessage\(conflicts\)\)/, "التعارض يرمي استثناءً");
  assert.match(helper, /if \(!guard \|\| typeof guard\.findGuidPriceConflicts !== "function"\)/, "غياب الوحدة يوقف الحفظ");
  assert.doesNotMatch(helper, /return\s+(true|false|conflicts)/, "لا يُعيد قراراً يمكن تجاهله");
});

test("9ج) لا override ولا force ولا تطبيق جماعي في مسار الحفظ", () => {
  for (const forbidden of ["forceSave", "force_save", "applyToAllRows", "overrideConflict", "ignoreConflict"]) {
    assert.ok(!clientSource.includes(forbidden), `ممنوع وجود ${forbidden} في مسار الحفظ`);
  }
});

test("9د) upsert يوقف الحفظ إن تعذّرت قراءة الأسعار الحالية", () => {
  const body = sliceFunction("upsertApprovedPriceItems");
  assert.match(body, /item_guid, unit2_price, sale_price, price_payload/, "الجلب يشمل الهوية والحقول المُدارة");
  assert.match(body, /if \(!existingAll\) \{[\s\S]{0,200}throw new Error/, "فشل القراءة يوقف الحفظ بدل المضي على العمياء");
  assert.match(body, /mergedState/, "الفحص على الحالة المدموجة لا على الحمولة وحدها");
});

// ---------------------------------------------------------------------------
// ١٠) و١٢) A-lite في المطبِّق
// ---------------------------------------------------------------------------
const applySource = readFileSync(
  new URL("../tools/apply-approved-prices-to-ameen.ps1", import.meta.url),
  "utf8"
);

test("10) A-lite: صفر كتابة للبطاقة المتعارضة — continue قبل أي Apply-ListPrice", () => {
  const conflictAt = applySource.indexOf("$conflictGuids.Contains($itemGuid)");
  assert.notEqual(conflictAt, -1, "يجب فحص مجموعة التعارض داخل الحلقة");
  const branch = applySource.slice(conflictAt, conflictAt + 400);
  assert.match(branch, /continue/, "الفرع يجب أن ينهي معالجة الصنف فوراً");
  const firstApply = applySource.indexOf("Apply-ListPrice $conn");
  assert.ok(conflictAt < firstApply, "فحص التعارض يسبق أول استدعاء كتابة");
  assert.doesNotMatch(branch, /Apply-ListPrice/, "لا كتابة داخل فرع التعارض");
});

test("10ب) الكشف يقع قبل الحلقة وعلى الصفوف الخام قبل الدمج بالاسم", () => {
  const rawAt = applySource.indexOf("$rawPrices = @($prices)");
  const dedupAt = applySource.indexOf("Group-Object { Resolve-AmeenItemName");
  const findAt = applySource.indexOf("Find-ConflictingGuids $rawPrices");
  const loopAt = applySource.indexOf("foreach ($price in $prices)");
  assert.ok(rawAt !== -1 && findAt !== -1 && loopAt !== -1, "العناصر الثلاثة موجودة");
  assert.ok(rawAt < dedupAt, "الصفوف الخام تُلتقط قبل الدمج بالاسم");
  assert.ok(findAt < loopAt, "التعارض يُحسب قبل حلقة الكتابة");
  assert.match(applySource, /Find-ConflictingGuids \$rawPrices/, "الفحص على الصفوف الخام لا المدموجة");
});

test("10ج) قاعدة التعارض في A-lite: قيم موجبة فقط، والحقول الثلاثة المُدارة", () => {
  const fn = applySource.slice(
    applySource.indexOf("function Find-ConflictingGuids"),
    applySource.indexOf("# يحدّث سعر مادة في قائمة أسعار")
  );
  assert.match(fn, /"unit2_price", "sale_price", "retail_carton_usd"/, "الحقول المُدارة الثلاثة");
  assert.match(fn, /Where-Object \{ \$_ -gt 0 \}/, "القيم الموجبة وحدها تدخل المقارنة");
  assert.match(fn, /\$positives\.Count -gt 1/, "أكثر من قيمة موجبة مميّزة = تعارض");
  assert.match(fn, /if \(\$group\.Count -lt 2\) \{ continue \}/, "صف واحد لا يعارض نفسه");
  assert.doesNotMatch(fn, /updated_at/, "لا ترجيح زمني في قرار التعارض");
  assert.doesNotMatch(fn, /Sort-Object .*Descending/, "لا ترتيب لاختيار فائز");
});

test("12) بقية المواد تستمر: التخطّي يخص الصنف وحده لا الدفعة", () => {
  const loopStart = applySource.indexOf("foreach ($price in $prices)");
  const loopBody = applySource.slice(loopStart, applySource.indexOf("$conn.Close()"));
  assert.match(loopBody, /continue/, "التخطّي بـ continue لا بـ break/return");
  assert.ok(!/\bbreak\b/.test(loopBody), "لا break — لا توقف للدفعة كلها");
  assert.ok(!/\bexit\b/.test(loopBody), "لا exit داخل الحلقة");
});

test("12ب) التعارض يظهر في المخرَج الآلي والسجل", () => {
  assert.match(applySource, /PRICE_APPLY jumla=\$jumlaApplied retail=\$retailApplied skipped=\$skipped notfound=\$\(\$notFound\.Count\) conflict=\$conflicted/, "سطر آلي يحمل conflict");
  assert.match(applySource, /conflict \(zero writes\)/, "السجل يوثّق البطاقات المتعارضة");
});

// ---------------------------------------------------------------------------
// عقود لا تُمَس في هذا الـPR
// ---------------------------------------------------------------------------
test("عقد: هذا الـPR لا يغيّر قواعد التقريب ولا unit2_factor ولا تعريف الأسعار", () => {
  const fn = applySource.slice(
    applySource.indexOf("function Find-ConflictingGuids"),
    applySource.indexOf("# يحدّث سعر مادة في قائمة أسعار")
  );
  assert.doesNotMatch(fn, /unit2_factor\s*=/, "لا يكتب unit2_factor");
  assert.doesNotMatch(guardCode, /\/\s*unit2_factor|unit2_factor\s*\*/, "النواة لا تشتقّ سعراً من العامل");
  assert.doesNotMatch(guardCode, /toFixed|Math\.floor|Math\.ceil/, "لا تقريب جديد — round4 للمقارنة فقط");
});

test("عقد: النواة لا تختار ولا تعدّل أي صف", () => {
  assert.doesNotMatch(guardCode, /updated_at/, "الزمن لا يُقرأ إطلاقاً");
  assert.doesNotMatch(guardCode, /sort\(\s*\(a,\s*b\)\s*=>\s*b\./, "لا ترتيب تنازلي لاختيار فائز");
  assert.ok(!guardCode.includes("fetch("), "بلا شبكة");
  assert.ok(!guardCode.includes("document."), "بلا DOM");
});

console.log(`check-price-guid-conflict-guard: اجتاز ${results.length} اختباراً.`);
for (const name of results) console.log(`  ✓ ${name}`);
