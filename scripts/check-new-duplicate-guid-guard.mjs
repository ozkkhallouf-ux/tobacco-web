// ============================================================================
// حارس السبب الجذري: منع إنشاء صف مكرر جديد في approved_price_items.
//
// العلّة التي يعالجها: هدف التعارض في الـupsert هو `item_key`، وهو سلسلة
// **مشتقّة** من اسم المادة عبر تطبيع قابل للتغيّر (همزة/تاء مربوطة/تشكيل).
// فحين يتغيّر ناتج التطبيع لصنف قائم — بتشديد قاعدة التطبيع أو بإعادة تسمية
// بطاقة في الأمين — لا يُحدَّث الصف القديم بل يُولد صف ثانٍ، ثم تختم مهمة أرقام
// الأصناف الصفّين بنفس `item_guid`. هكذا وُلدت الـ53 مجموعة القائمة (107 صفوف،
// منها 54 صفاً يتيماً — تشخيص قراءة فقط 2026-09-21).
//
// نطاق هذا الحارس: **الولادة وحدها**. لا يجمّد مجموعة قائمة، ولا يمنع إعادة
// تسعيرها، ولا يحذف شيئاً، ولا يختار canonical. القاعدة في
// src/price-guid-conflict.js.
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
// تحميل النواة النقية في sandbox (نفس نمط check-price-guid-conflict-guard.mjs)
// ---------------------------------------------------------------------------
const guardSource = readFileSync(new URL("../src/price-guid-conflict.js", import.meta.url), "utf8");

function loadGuard(source = guardSource) {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "price-guid-conflict.js" });
  return sandbox.window.priceGuidConflict;
}

const guard = loadGuard();
assert.ok(guard, "price-guid-conflict.js يجب أن يعرّف window.priceGuidConflict");
const { findNewDuplicateGuidRows, formatNewDuplicateMessage, normalizeIdentityName } = guard;

const GUID_LIVE = "9C345CF2-F949-4E6E-9E4E-38615CF5C886"; // اليغانس كوين ازرق (حقيقي)
const GUID_OTHER = "F6232066-579C-46FC-9892-B67145B04842"; // اليغانس طويل فضي (حقيقي)

function existingRow(itemKey, guid, itemName = itemKey) {
  return { item_key: itemKey, item_name: itemName, item_guid: guid };
}
/** حمولة الموقع لا تحمل item_guid إطلاقاً — راجع normalizeApprovedPriceInput. */
function incoming(itemKey, itemName = itemKey, extra = {}) {
  return { item_key: itemKey, item_name: itemName, ...extra };
}
function guidMap(rows) {
  return Object.fromEntries(rows.map((r) => [r.item_key, r.item_guid]));
}

// الحالة الحقيقية المصغّرة: مجموعة مكررة قائمة (مفتاحان، هوية واحدة) + مادة مفردة.
const TABLE = [
  existingRow("اليغانس كوين ازرق", GUID_LIVE, "اليغانس كوين أزرق"),
  existingRow("اليغانس كوين أزرق", GUID_LIVE, "اليغانس كوين أزرق"),
  existingRow("اليغانس طويل فضي", GUID_OTHER)
];
const GUIDS = guidMap(TABLE);

const find = (rows, table = TABLE, map = GUIDS) => findNewDuplicateGuidRows(rows, table, map);

// ---------------------------------------------------------------------------
// A) نفس item_key + نفس GUID ⇒ تحديث مسموح
// ---------------------------------------------------------------------------
test("A) مفتاح موجود = تحديث، لا يُرفض أبداً", () => {
  assert.equal(find([incoming("اليغانس طويل فضي")]).length, 0);
});

test("A2) مفتاح موجود داخل مجموعة مكررة = تحديث مسموح رغم وجود التوأم", () => {
  assert.equal(find([incoming("اليغانس كوين ازرق", "اليغانس كوين أزرق")]).length, 0);
});

test("A3) هوية صريحة مطابقة على مفتاح موجود لا تُرفض", () => {
  assert.equal(
    find([incoming("اليغانس كوين ازرق", "اليغانس كوين أزرق", { item_guid: GUID_LIVE })]).length,
    0
  );
});

// ---------------------------------------------------------------------------
// B) مفتاح جديد + GUID غير مستخدم ⇒ مسموح
// ---------------------------------------------------------------------------
test("B) مادة جديدة تماماً (اسم لا يطابق شيئاً) تمرّ", () => {
  assert.equal(find([incoming("مارلبورو ذهبي جديد")]).length, 0);
});

test("B2) مفتاح جديد بهوية صريحة غير مستخدمة يمرّ", () => {
  assert.equal(
    find([incoming("صنف جديد", "صنف جديد", { item_guid: "11111111-0000-0000-0000-000000000001" })]).length,
    0
  );
});

// ---------------------------------------------------------------------------
// C) مفتاح جديد + GUID موجود تحت مفتاح آخر ⇒ رفض
// ---------------------------------------------------------------------------
test("C) مفتاح جديد يحلّ لهوية مأهولة = يُرفض", () => {
  // «اليغانس كوين ازرقـ» بتشكيل/تطويل: تطبيعه يطابق صفاً قائماً ⇒ ولادة مكرر.
  const found = find([incoming("اليغانس كوين أَزرق")]);
  assert.equal(found.length, 1, "يجب أن يُرصد صف واحد");
  assert.equal(found[0].guid, GUID_LIVE);
  assert.equal(found[0].newKey, "اليغانس كوين أَزرق");
  assert.ok(found[0].existingKeys.includes("اليغانس كوين ازرق"), "يسمّي المفتاح القائم");
});

test("C2) الرسالة تتضمن الاسم والهوية والمفتاح الموجود والمفتاح الجديد", () => {
  const msg = formatNewDuplicateMessage(find([incoming("اليغانس كوين أَزرق", "اليغانس كوين أزرق")]));
  assert.ok(msg.includes("اليغانس كوين أزرق"), "اسم المادة");
  assert.ok(msg.includes(GUID_LIVE), "item_guid");
  assert.ok(msg.includes("اليغانس كوين ازرق"), "المفتاح الموجود");
  assert.ok(msg.includes("اليغانس كوين أَزرق"), "المفتاح الجديد");
  assert.ok(msg.includes("لم يُحفظ أي سعر"), "يصرّح أن شيئاً لم يُكتب");
});

test("C3) هوية صريحة مأهولة على مفتاح جديد = يُرفض أيضاً", () => {
  const found = find([incoming("أي اسم", "أي اسم", { item_guid: GUID_OTHER })]);
  assert.equal(found.length, 1);
  // Array.from: المصفوفة مولودة داخل الـsandbox فنموذجها الأولي غير نموذج المضيف.
  assert.deepEqual(Array.from(found[0].existingKeys), ["اليغانس طويل فضي"]);
});

test("C4) حمولة واحدة بمفتاحين جديدين لنفس البطاقة الخالية = تُرفض", () => {
  const table = [];
  const found = findNewDuplicateGuidRows(
    [
      incoming("صنف س", "صنف س", { item_guid: "22222222-0000-0000-0000-000000000002" }),
      incoming("صنف ص", "صنف ص", { item_guid: "22222222-0000-0000-0000-000000000002" })
    ],
    table,
    {}
  );
  assert.equal(found.length, 1, "الثاني هو الذي يُنشئ الازدواج");
  assert.equal(found[0].newKey, "صنف ص");
  assert.deepEqual(Array.from(found[0].existingKeys), ["صنف س"]);
});

// ---------------------------------------------------------------------------
// D) المجموعات الـ53 القائمة: إعادة تسعير المفاتيح الموجودة لا تُرفض
// ---------------------------------------------------------------------------
test("D) fanout إعادة التسعير على مجموعة مكررة قائمة يمرّ كاملاً", () => {
  // هذا ما يرسله src/app.js فعلياً: كل مفاتيح المجموعة في حمولة واحدة.
  const payload = [
    incoming("اليغانس كوين ازرق", "اليغانس كوين أزرق"),
    incoming("اليغانس كوين أزرق", "اليغانس كوين أزرق")
  ];
  assert.equal(find(payload).length, 0, "لا شيء يُنشأ — كلا المفتاحين موجود");
});

test("D2) مجموعة ثلاثية قائمة (حالة 15004) تُعاد تسعيرها بلا رفض", () => {
  const guid = "54FFC359-3CDC-44A7-836F-C053838B4C14";
  const name = "حمرة طويلة قديمة عراقية";
  const table = [
    existingRow("حمره طويله قديمه عراقيه", guid, name),
    existingRow("حمرة طويلة قديمة", guid, name),
    existingRow("حمره طويله قديمه", guid, name)
  ];
  const payload = table.map((r) => incoming(r.item_key, name));
  assert.equal(findNewDuplicateGuidRows(payload, table, guidMap(table)).length, 0);
});

test("D3) الحارس لا يرصد شيئاً على جدول مكرر ما لم يُنشأ مفتاح جديد", () => {
  assert.equal(find(TABLE.map((r) => incoming(r.item_key, r.item_name))).length, 0);
});

// ---------------------------------------------------------------------------
// E) لا كتابة جزئية عند الرفض
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

test("E) الرفض يسبق كل كتابة في upsertApprovedPriceItems", () => {
  const body = sliceFunction("upsertApprovedPriceItems");
  const guardAt = body.indexOf("assertNoNewDuplicateGuidRow(");
  assert.notEqual(guardAt, -1, "يجب أن يُستدعى حارس الازدواج الجديد");
  for (const writeCall of [".delete(", ".insert(", ".upsert("]) {
    const at = body.indexOf(writeCall);
    if (at === -1) continue;
    assert.ok(guardAt < at, `${writeCall} يقع قبل الحارس — كتابة محتملة قبل الفحص`);
  }
});

test("E2) التأكيد يرمي ولا يُعيد قراراً قابلاً للتجاهل", () => {
  const helper = clientSource.slice(
    clientSource.indexOf("function assertNoNewDuplicateGuidRow("),
    clientSource.indexOf("function missingSessionMessage(")
  );
  assert.match(helper, /throw new Error\(guard\.formatNewDuplicateMessage\(duplicates\)\)/);
  assert.doesNotMatch(helper, /return\s+(true|false|duplicates)/, "لا قرار يُتجاهل");
  assert.doesNotMatch(helper, /catch\s*\(/, "لا ابتلاع للاستثناء");
});

test("E3) غياب الوحدة يوقف الحفظ (fail-closed)", () => {
  const helper = clientSource.slice(
    clientSource.indexOf("function requirePriceGuidGuard("),
    clientSource.indexOf("function assertNoGuidPriceConflict(")
  );
  assert.match(helper, /typeof guard\.findNewDuplicateGuidRows !== "function"/, "غياب الدالة الجديدة يوقف الحفظ");
  assert.match(helper, /throw new Error/);
});

test("E4) الجلب يشمل item_name — بدونه تتعذّر مطابقة الهوية بالاسم", () => {
  const body = sliceFunction("upsertApprovedPriceItems");
  assert.match(body, /\.select\("item_key, item_name, item_number, item_code, item_guid/);
});

// ---------------------------------------------------------------------------
// F) هوية مفقودة/مجهولة لا تنتج إنذاراً كاذباً
// ---------------------------------------------------------------------------
test("F) صف قائم بلا هوية لا يحجز شيئاً", () => {
  const table = [existingRow("قديم بلا هوية", null), existingRow("قديم فارغ", "")];
  assert.equal(findNewDuplicateGuidRows([incoming("قديم بلا هويه")], table, guidMap(table)).length, 0);
});

test("F2) صف وارد لا تُحلّ هويته يمرّ", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(find([incoming("اسم لا يطابق شيئاً", "اسم لا يطابق شيئاً", { item_guid: value })]).length, 0);
  }
});

test("F3) التباس الهوية (اسم مطبّع واحد بهويتين) لا يمنع ولا يخمّن", () => {
  const table = [
    existingRow("غلواز كوين اصفر اس سبعه", "AAAA0001-0000-0000-0000-000000000001"),
    existingRow("غلواز كوين اصفر اس سبعة", "BBBB0002-0000-0000-0000-000000000002")
  ];
  assert.equal(findNewDuplicateGuidRows([incoming("غلواز كوين اصفر اس سبعهـ")], table, guidMap(table)).length, 0);
});

test("F4) مدخلات فارغة/مشوّهة لا ترمي", () => {
  assert.equal(findNewDuplicateGuidRows(null, null, null).length, 0);
  assert.equal(findNewDuplicateGuidRows([], [], {}).length, 0);
  assert.equal(findNewDuplicateGuidRows([{}], [{}], {}).length, 0);
  assert.equal(formatNewDuplicateMessage([]), "");
  assert.equal(formatNewDuplicateMessage(null), "");
});

test("F5) مقارنة الهوية بلا حساسية لحالة الأحرف", () => {
  const found = find([incoming("مفتاح جديد", "مفتاح جديد", { item_guid: GUID_OTHER.toLowerCase() })]);
  assert.equal(found.length, 1, "الهوية نفسها بحالة أحرف مختلفة تُرصد");
});

// ---------------------------------------------------------------------------
// تطابق التطبيع مع src/app.js — يمنع انحراف النسختين
// ---------------------------------------------------------------------------
test("تطبيع: النسخة في النواة تطابق normalizeItemName في src/app.js حرفياً", () => {
  const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const start = appSource.indexOf("function normalizeItemName(value) {");
  assert.notEqual(start, -1, "تعذّر عزل normalizeItemName من app.js");
  let depth = 0;
  let body = "";
  for (let i = appSource.indexOf("{", start); i < appSource.length; i++) {
    if (appSource[i] === "{") depth++;
    else if (appSource[i] === "}") {
      depth--;
      if (depth === 0) { body = appSource.slice(start, i + 1); break; }
    }
  }
  const box = { out: null };
  vm.createContext(box);
  vm.runInContext(`${body}; out = normalizeItemName;`, box);
  const appNormalize = box.out;

  const corpus = [
    "اليغانس كوين أزرق", "اليغانس كوين ازرق", "معسل الاسطورة علكة ونعنع",
    "معسل الاسطوره علكه ونعنع", "حمرة طويلة قديمة عراقية", "نخلة صلاحية شهر 10",
    "كابتن بلاك كوين ازرق", "كابتن بلاك كور ازرق جديد", "كابتن بلاك كوين اسود",
    "24007 - نخله صلاحيه شهر 10", "  فحم   الهيبة  ", "أَوريس شُوكولا",
    "1970 سليم أزرق", "تي اس أزرق", "", "   ", "مانشستر كوين طقة توت"
  ];
  for (const value of corpus) {
    assert.equal(
      normalizeIdentityName(value),
      appNormalize(value),
      `انحراف تطبيع على: "${value}"`
    );
  }
});

// ---------------------------------------------------------------------------
// G) حارس تعارض الأسعار (PR #256) لم يتغيّر
// ---------------------------------------------------------------------------
test("G) واجهة حارس #256 باقية كما هي ولم تُمَس قاعدته", () => {
  for (const fn of ["findGuidPriceConflicts", "buildScopedConflictState", "formatConflictMessage"]) {
    assert.equal(typeof guard[fn], "function", `${fn} يجب أن تبقى موجودة`);
  }
  assert.equal(guard.MANAGED_FIELDS.length, 3, "الحقول المُدارة تبقى ثلاثة");
  // القاعدة نفسها: قيمتان موجبتان مختلفتان = تعارض؛ صفر = غير مسعّر.
  assert.equal(
    guard.findGuidPriceConflicts([
      { item_key: "أ", item_guid: GUID_LIVE, unit2_price: 33, sale_price: 2 },
      { item_key: "ب", item_guid: GUID_LIVE, unit2_price: 31, sale_price: 2 }
    ]).length,
    1
  );
  assert.equal(
    guard.findGuidPriceConflicts([
      { item_key: "أ", item_guid: GUID_LIVE, unit2_price: 33, sale_price: 0 },
      { item_key: "ب", item_guid: GUID_LIVE, unit2_price: 33, sale_price: 2 }
    ]).length,
    0
  );
});

test("G2) الحارسان يُستدعيان كلاهما في upsert، والجديد أولاً", () => {
  const body = sliceFunction("upsertApprovedPriceItems");
  const dupAt = body.indexOf("assertNoNewDuplicateGuidRow(");
  const priceAt = body.indexOf("assertNoGuidPriceConflictForIncoming(");
  assert.notEqual(priceAt, -1, "حارس #256 ما زال مُستدعى");
  assert.ok(dupAt < priceAt, "حارس الازدواج يسبق حارس التعارض");
});

test("G3) replaceApprovedPriceItems لم يتغيّر سلوكه: بلا حارس الازدواج", () => {
  const body = sliceFunction("replaceApprovedPriceItems");
  assert.ok(
    !body.includes("assertNoNewDuplicateGuidRow("),
    "لا يُستدعى هنا عمداً — الحذف الشامل يجعل كل صف «جديد» ويشلّ حفظ الـ53"
  );
  assert.match(body, /assertNoGuidPriceConflict\(withUser\)/, "حارس #256 باقٍ كما هو");
  assert.ok(body.indexOf("assertNoGuidPriceConflict(withUser)") < body.indexOf(".delete("), "قبل الحذف");
});

// ---------------------------------------------------------------------------
// عقود: هذا الحارس لا يحذف ولا يرجّح ولا يعتمد updated_at
// ---------------------------------------------------------------------------
test("عقد: النواة لا تقرأ updated_at ولا تختار canonical", () => {
  const code = guardSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!code.includes("updated_at"), "الزمن لا يُقرأ إطلاقاً");
  assert.ok(!code.includes("approved_at"), "ولا تاريخ الاعتماد");
  assert.ok(!code.includes("fetch("), "بلا شبكة");
  assert.ok(!code.includes("document."), "بلا DOM");
});

test("عقد: لا مسار حذف ولا تجاوز في مسار الحفظ", () => {
  for (const forbidden of ["forceCreate", "allowDuplicateGuid", "ignoreDuplicate", "overrideDuplicate"]) {
    assert.ok(!clientSource.includes(forbidden), `ممنوع وجود ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// شاهد الطفرة: إزالة فحص الإنشاء يجب أن يُفشل الحالة C
// ---------------------------------------------------------------------------
test("شاهد الطفرة: تعطيل فحص «المفتاح جديد» يُسقط رصد الحالة C", () => {
  // الطفرة: اعتبار كل صف وارد «تحديثاً» — أي إسقاط شرط الإنشاء.
  const mutated = guardSource.replace(
    "if (!key || existingKeys.has(key)) continue;",
    "if (!key) continue;"
  );
  assert.notEqual(mutated, guardSource, "الطفرة لم تُطبَّق — تغيّر نص الشرط؟");
  const mutant = loadGuard(mutated);

  // الأصل يرصد الحالة C؛ الطافر — بإسقاط شرط الإنشاء — يرصد التحديث السليم أيضاً.
  assert.equal(find([incoming("اليغانس كوين أَزرق")]).length, 1, "الأصل يرصد C");
  assert.ok(
    mutant.findNewDuplicateGuidRows(
      [incoming("اليغانس كوين ازرق", "اليغانس كوين أزرق")],
      TABLE,
      GUIDS
    ).length > 0,
    "الطافر يرفض تحديثاً سليماً — الحالة A كانت ستفشل"
  );

  // طفرة ثانية: إسقاط شرط «الهوية مأهولة» ⇒ الحالة C لا تُرصد إطلاقاً.
  const mutated2 = guardSource.replace("if (owners.length) {", "if (false) {");
  assert.notEqual(mutated2, guardSource, "الطفرة الثانية لم تُطبَّق");
  assert.equal(
    loadGuard(mutated2).findNewDuplicateGuidRows([incoming("اليغانس كوين أَزرق")], TABLE, GUIDS).length,
    0,
    "بإزالة الفحص تمرّ الحالة C — الاختبار C كان سيفشل"
  );
});

console.log(`check-new-duplicate-guid-guard: اجتاز ${results.length} اختباراً.`);
for (const name of results) console.log(`  ✓ ${name}`);
