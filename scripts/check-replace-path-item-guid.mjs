// ============================================================================
// فحص انحداري: **مسار استبدال لائحة الأسعار كان يولّد صفاً بلا هوية بطاقة.**
//
// العطل الذي يمنعه: `importLivePriceList()` يطابق ملف الأسعار مع الجرد الحي،
// وكل مادة مطابَقة لها `stockItem` قادم من `liveAvailableItems()` يحمل
// `itemGuid` موثوقاً (يكتبه `tools/ameen-sync-agent.ps1`). لكن حمولة
// `approvedItems` لم تكن تحمل هذه الهوية، و`normalizeApprovedPriceInput()` لا
// تعرفها أصلاً، فوصلت إلى `replaceApprovedPriceItems()` بلا هوية. هناك يُعاد
// ربط الهوية من `guidByKey` المبنيّة من صفوف الجدول قبل الحذف — وهي تعمل
// للمفاتيح القائمة وحدها. أي مفتاح **جديد** (مادة تُسعَّر لأول مرة، أو بطاقة
// أُعيدت تسميتها في الأمين فتغيّر مفتاحها المطبّع) كان يُدرَج بـ
// `item_guid = NULL`.
//
// لماذا هذا خطر: صفّ بلا هوية لا يطابقه `push-item-costs.ps1` (مطابقة متوسط
// التكلفة بالـGUID)، ولا يستطيع حارس منع الازدواج (src/price-guid-conflict.js)
// ربطه ببطاقته حتى تختمه مهمة أرقام الأصناف — وهي تعمل كل ٦ ساعات وقد تتعطّل
// أياماً. وخلال تلك النافذة تعود بالضبط ولادةُ الصف المكرر التي عالجها #257.
//
// الفحص يشغّل **الكود الحقيقي**: `importLivePriceList()` و
// `replaceApprovedPriceItems()` و`upsertApprovedPriceItems()` مستخرجة من
// `src/app.js` و`src/supabase-client.js` وتُنفَّذ داخل vm فوق عميل Supabase
// مزيّف يلتقط الحمولة. لا مطابقة نصّية ولا نسخ مبسّطة.
//
// لا يكتب شيئاً في أي قاعدة: العميل مزيّف بالكامل.
// ============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const results = [];
let failed = 0;
// عدّاء واعٍ بالـasync: فحص غير منتظَر يمرّ صامتاً وهو أسوأ من غيابه.
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  ❌ ${name}\n     ${error && error.message}`);
  }
}

const APP_SOURCE = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const CLIENT_SOURCE = readFileSync(new URL("../src/supabase-client.js", import.meta.url), "utf8");
const GUARD_SOURCE = readFileSync(new URL("../src/price-guid-conflict.js", import.meta.url), "utf8");

// GUIDات حقيقية من الجدول (قراءة فقط، لا تحمل بيانات حساسة).
const GUID_LIVE = "9C345CF2-F949-4E6E-9E4E-38615CF5C886";
const GUID_OTHER = "F6232066-579C-46FC-9892-B67145B04842";

// ---------------------------------------------------------------------------
// استخراج الدوال الحقيقية بأقواس متوازنة (لا regex كسول على أجسام طويلة)
// ---------------------------------------------------------------------------
function sliceBalanced(source, startNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `تعذّر عزل ${label}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`أقواس غير متوازنة في ${label}`);
}

const APP_FUNCTIONS = [
  "function normalizeItemName(value) {",
  "function normalizeNumericText(value, options = {}) {",
  "function toNumber(value) {",
  "function roundPrice(value) {",
  "function toPositivePrice(value) {",
  "function samePrice(left, right) {",
  "function uuidOrNull(value) {",
  "function firstPositivePrice(rawRow, priceColumns, unit) {",
  "function normalizePriceForItem(rawRow, priceColumns, unit2Factor) {",
  "function correctedPriceRow(rawRow, priceColumns, normalizedPrice) {",
  "function reportSyncedAt(report) {",
  "function itemQty(item) {",
  "function itemUnit1Name(item) {",
  "function itemUnit2Name(item) {",
  "function itemUnit2Factor(item) {",
  "async function importLivePriceList(form) {"
];

// دوال app.js كلها بمستوى أعلى، فحدّها `\n}` بعمود صفر — أدقّ من عدّ الأقواس
// الذي تخدعه القوالب النصّية و`{n,m}` داخل الـregex.
function sliceTopLevel(source, startNeedle, label) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `تعذّر عزل ${label}`);
  const end = source.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `تعذّر إيجاد نهاية ${label}`);
  return source.slice(start, end + 2);
}

function appPipelineSource(source = APP_SOURCE) {
  return APP_FUNCTIONS.map((needle) => sliceTopLevel(source, needle, needle)).join("\n\n");
}

// ---------------------------------------------------------------------------
// عميل Supabase مزيّف: يلتقط كل كتابة ولا ينفّذ أياً منها
// ---------------------------------------------------------------------------
function makeFakeSupabase({ existingRows = [], failFetch = false } = {}) {
  const captured = { inserted: null, upserted: null, deleted: 0, order: [] };

  class Query {
    constructor(table, op) {
      this.table = table;
      this.op = op;
      this.rows = null;
    }
    select() {
      if (this.op === "insert" || this.op === "upsert") {
        return Promise.resolve({
          data: (this.rows || []).map((row, index) => ({ ...row, id: `fake-${index}` })),
          error: null
        });
      }
      return this;
    }
    limit() {
      return Promise.resolve(
        failFetch ? { data: null, error: { message: "fetch failed" } } : { data: existingRows, error: null }
      );
    }
    neq() {
      captured.deleted += 1;
      captured.order.push("delete");
      return Promise.resolve({ error: null });
    }
    then(resolve, reject) {
      return Promise.resolve(
        failFetch ? { data: null, error: { message: "fetch failed" } } : { data: existingRows, error: null }
      ).then(resolve, reject);
    }
  }

  const client = {
    auth: {
      async getSession() {
        return { data: { session: { access_token: "t", user: { id: "user-1", email: "o@x" } } }, error: null };
      },
      async getUser() {
        return { data: { user: { id: "user-1", email: "o@x" } }, error: null };
      },
      onAuthStateChange() {
        return { data: { subscription: { unsubscribe() {} } } };
      }
    },
    from(table) {
      return {
        select: (...args) => new Query(table, "select").select(...args),
        delete: () => new Query(table, "delete"),
        insert: (rows) => {
          captured.inserted = rows;
          captured.order.push("insert");
          const q = new Query(table, "insert");
          q.rows = rows;
          return q;
        },
        upsert: (rows) => {
          captured.upserted = rows;
          captured.order.push("upsert");
          const q = new Query(table, "upsert");
          q.rows = rows;
          return q;
        }
      };
    }
  };

  return { client, captured };
}

// ---------------------------------------------------------------------------
// بناء `window.tobaccoData` الحقيقي فوق العميل المزيّف
// ---------------------------------------------------------------------------
function buildDataStore(fake, clientSource = CLIENT_SOURCE) {
  const store = new Map();
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    setTimeout,
    clearTimeout,
    fetch: async () => {
      throw new Error("لا شبكة في الفحص");
    }
  };
  sandbox.window = {
    appConfig: { supabase: { url: "https://fake.supabase.co", publishableKey: "sb_publishable_fake" } },
    supabase: { createClient: () => fake.client },
    location: { href: "https://example.test/", origin: "https://example.test", pathname: "/" },
    localStorage: sandbox.localStorage,
    addEventListener() {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GUARD_SOURCE, sandbox, { filename: "price-guid-conflict.js" });
  vm.runInContext(clientSource, sandbox, { filename: "supabase-client.js" });
  const service = sandbox.window.tobaccoData;
  assert.ok(service, "supabase-client.js يجب أن يعرّف window.tobaccoData");
  assert.equal(service.mode, "supabase", "العميل المزيّف يجب أن يُفعّل وضع supabase");
  return service;
}

// ---------------------------------------------------------------------------
// تشغيل المسار الكامل: importLivePriceList → replaceApprovedPriceItems → insert
// ---------------------------------------------------------------------------
async function runImport({
  stockItems,
  priceRows,
  existingRows = [],
  appSource = APP_SOURCE,
  clientSource = CLIENT_SOURCE
}) {
  const fake = makeFakeSupabase({ existingRows });
  const dataStore = buildDataStore(fake, clientSource);

  const notices = [];
  const sandbox = {
    console,
    dataStore,
    state: {},
    setNotice: (kind, message) => notices.push({ kind, message }),
    render: () => {},
    safeErrorMessage: (error) => String((error && error.message) || error),
    latestStockReport: () => ({ id: "3f0d5f3c-1c2b-4a77-9d51-5f4a1c2b3d44", created_at: "2026-09-20T10:00:00Z" }),
    liveAvailableItems: () => stockItems,
    writePriceExportWorkbook: () => {},
    assertExcelSupport: () => {},
    todayIsoDate: () => "2026-09-21",
    parsePriceWorkbook: async () => ({
      sheetName: "prices",
      headers: ["المادة", "سعر الكرتونة"],
      priceColumns: [{ index: 1, unit: "unit2" }],
      rows: priceRows
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(appPipelineSource(appSource), sandbox, { filename: "app-pipeline.js" });

  const form = { elements: { livePrice: { files: [{ name: "prices.xlsx" }] } } };
  await sandbox.importLivePriceList(form);
  // importLivePriceList يبتلع كل خطأ في إشعار. بلا هذا الفحص كان عطل في
  // السقالة نفسها سيمرّ كـ«لم تصل الهوية» — تشخيص خاطئ.
  const errors = notices.filter((n) => !/تم تنزيل لائحة البيع النهائية/.test(n.message));
  assert.deepEqual(errors, [], `المسار انتهى بخطأ: ${JSON.stringify(errors)}`);
  return { captured: fake.captured, notices, dataStore, fake };
}

/** حمولة مصغّرة لكنها واقعية: مادة واحدة بسعر كرتونة صالح. */
function priceRow(key, name, cartonPrice) {
  return { key, name, hasPrice: true, raw: [name, cartonPrice] };
}
function stockItem(key, name, guid, extra = {}) {
  return {
    key,
    name,
    itemGuid: guid,
    stockQty: 12,
    status: "active",
    unit1Name: "علبة",
    unit2Name: "كرتونة",
    unit2Factor: 50,
    ...extra
  };
}
function existingRow(itemKey, guid, extra = {}) {
  return {
    item_key: itemKey,
    item_name: itemKey,
    item_number: null,
    item_code: null,
    item_guid: guid,
    unit2_price: 0,
    sale_price: 0,
    price_payload: {},
    ...extra
  };
}

// ===========================================================================
// A) إثبات العطل: بحذف السطر المضاف وحده تعود الهوية NULL
// ===========================================================================
// مطفرة مصدرية (mutation test): تُزيل تمرير الهوية من `importLivePriceList`
// وتعيد تشغيل نفس المسار. هذا يثبت أن السطر المضاف هو ما يصلح العطل فعلاً،
// ولا يعتمد على تاريخ git فيبقى صالحاً بعد الدمج.
const GUID_PASS_LINE = /\n\s*itemGuid: ambiguousKeys\.has\(row\.key\) \? "" : stockItem\?\.itemGuid \|\| "",/;

const preFixAppSource = APP_SOURCE.replace(GUID_PASS_LINE, "\n");

const SCENARIO_NEW_KEY = {
  // مفتاح **غير موجود** في الجدول: هذا بالضبط الصف الذي كان يولد بلا هوية.
  stockItems: [stockItem("مالبورو احمر", "مالبورو أحمر", GUID_LIVE)],
  priceRows: [priceRow("مالبورو احمر", "مالبورو أحمر", 250)],
  existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)]
};

const preFix = await runImport({ ...SCENARIO_NEW_KEY, appSource: preFixAppSource });
const postFix = await runImport(SCENARIO_NEW_KEY);

await test("A) قبل الإصلاح: الهوية الموثوقة تُفقد ويُدرَج الصف بـ item_guid = NULL", () => {
  assert.notEqual(
    preFixAppSource,
    APP_SOURCE,
    "لم تُزل سطر تمرير الهوية — تحقّق من نمط GUID_PASS_LINE بعد أي إعادة صياغة"
  );
  assert.ok(preFix.captured.inserted, "المسار قبل الإصلاح يجب أن يصل إلى insert");
  assert.equal(preFix.captured.inserted.length, 1);
  assert.equal(
    preFix.captured.inserted[0].item_guid,
    null,
    "قبل الإصلاح كان الصف الجديد يُدرَج بهوية NULL — هذا هو العطل"
  );
});

// ===========================================================================
// B) بعد الإصلاح: الهوية الموثوقة تصل حتى حمولة القاعدة
// ===========================================================================
await test("B) الهوية الموثوقة من الجرد الحي تصل إلى حمولة insert", () => {
  assert.ok(postFix.captured.inserted, "المسار يجب أن يصل إلى insert");
  assert.equal(postFix.captured.inserted.length, 1);
  assert.equal(
    postFix.captured.inserted[0].item_guid,
    GUID_LIVE,
    "الهوية الموثوقة من stockItem يجب أن تُكتب مع الصف الجديد"
  );
  assert.equal(postFix.captured.inserted[0].item_key, "مالبورو احمر");
});

await test("B2) normalizeApprovedPriceInput يحافظ على الهوية ولا يخترعها", () => {
  const body = sliceBalanced(
    CLIENT_SOURCE,
    "function normalizeApprovedPriceInput(input, userId = null) {",
    "normalizeApprovedPriceInput"
  );
  assert.match(body, /item_guid/, "يجب أن تنقل الهوية الواردة إلى الحمولة");
  assert.doesNotMatch(
    body,
    /normalizeItemName|itemName.*=>.*guid/i,
    "ممنوع اشتقاق هوية من الاسم — الهوية تُنقل أو تُترك"
  );
});

await test("B3) الهوية تُحذف من الحمولة حين لا تصل هوية موثوقة (لا مفتاح فارغ)", async () => {
  const noGuid = await runImport({
    stockItems: [stockItem("مالبورو احمر", "مالبورو أحمر", "")],
    priceRows: [priceRow("مالبورو احمر", "مالبورو أحمر", 250)],
    existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)]
  });
  assert.equal(noGuid.captured.inserted[0].item_guid, null, "بلا هوية موثوقة ولا محفوظة ⇒ NULL كما كان");
});

// ===========================================================================
// C) حالة أحرف الـGUID لا تغيّر الهوية
// ===========================================================================
await test("C1) الهوية المحفوظة تتقدّم على الموثوقة، واختلاف الحالة وحده ليس تعارضاً", async () => {
  const run = await runImport({
    stockItems: [stockItem("اليغانس طويل فضي", "اليغانس طويل فضي", GUID_OTHER.toLowerCase())],
    priceRows: [priceRow("اليغانس طويل فضي", "اليغانس طويل فضي", 300)],
    existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)]
  });
  assert.equal(
    run.captured.inserted[0].item_guid,
    GUID_OTHER,
    "هوية الصف القائم مرجع لا يُدهَس — حتى لو وصلت بحالة أحرف أخرى"
  );
});

await test("C2) ازدواج هوية داخل الحمولة يُكتشف بصرف النظر عن حالة الأحرف — وقبل أي حذف", async () => {
  let thrown = null;
  const fake = makeFakeSupabase({ existingRows: [] });
  const dataStore = buildDataStore(fake);
  try {
    await dataStore.replaceApprovedPriceItems([
      { itemKey: "أ", itemName: "أ", itemGuid: GUID_LIVE, unit2Price: 100, unit2Factor: 50 },
      { itemKey: "ب", itemName: "ب", itemGuid: GUID_LIVE.toLowerCase(), unit2Price: 200, unit2Factor: 50 }
    ]);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "صفّان بنفس الهوية يجب أن يوقفا الحفظ (القيد الفريد على upper(item_guid))");
  assert.equal(fake.captured.deleted, 0, "لا حذف قبل الرفض — اللائحة القائمة تبقى سليمة");
  assert.equal(fake.captured.inserted, null, "ولا إدراج");
});

// ===========================================================================
// D) لا تغيير في الأسعار ولا في أي حقل آخر
// ===========================================================================
await test("D) الحمولة مطابقة حقلاً بحقل مع/بدون الهوية (عدا item_guid)", () => {
  // الكائنان من realmين مختلفين (vm)، فالمقارنة الصارمة تفشل على النموذج
  // الأولي لا على المحتوى — نقارن التمثيل النصّي المرتّب.
  const strip = (row) => {
    const { item_guid, approved_at, updated_at, ...rest } = row;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  assert.equal(
    strip(postFix.captured.inserted[0]),
    strip(preFix.captured.inserted[0]),
    "تمرير الهوية لا يجوز أن يغيّر سعراً ولا عامل تحويل ولا مفتاحاً ولا حمولة سعر"
  );
  const row = postFix.captured.inserted[0];
  assert.equal(row.unit2_price, 250, "سعر الكرتونة كما هو");
  assert.equal(row.unit2_factor, 50, "عامل التحويل كما هو");
  assert.equal(row.sale_price, 5, "سعر الوحدة الأولى = 250 ÷ 50 كما كان");
  assert.equal(row.unit1_price, 5);
});

await test("D2) مفتاح المادة لم يتغيّر تطبيعه", () => {
  assert.equal(postFix.captured.inserted[0].item_key, preFix.captured.inserted[0].item_key);
});

// ===========================================================================
// E) الاستيراد لا يستطيع إنشاء صف لمادة حيّة معروفة بهوية NULL
// ===========================================================================
await test("E) كل صف لمادة حيّة تحمل هوية يخرج بهوية غير فارغة", async () => {
  const run = await runImport({
    stockItems: [
      stockItem("مالبورو احمر", "مالبورو أحمر", GUID_LIVE),
      stockItem("اليغانس طويل فضي", "اليغانس طويل فضي", GUID_OTHER)
    ],
    priceRows: [
      priceRow("مالبورو احمر", "مالبورو أحمر", 250),
      priceRow("اليغانس طويل فضي", "اليغانس طويل فضي", 300)
    ],
    existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)]
  });
  assert.equal(run.captured.inserted.length, 2);
  for (const row of run.captured.inserted) {
    assert.ok(
      row.item_guid && String(row.item_guid).trim(),
      `الصف ${row.item_key} خرج بهوية فارغة رغم أن مادته حيّة ولها بطاقة`
    );
  }
});

await test("E2) فشل قراءة الصفوف الحالية يوقف الحفظ قبل الحذف (سلوك #257 لم يتغيّر)", async () => {
  const fake = makeFakeSupabase({ failFetch: true });
  const dataStore = buildDataStore(fake);
  await assert.rejects(
    () =>
      dataStore.replaceApprovedPriceItems([
        { itemKey: "أ", itemName: "أ", itemGuid: GUID_LIVE, unit2Price: 100, unit2Factor: 50 }
      ]),
    /تعذّر تحضير الحفظ الآمن/
  );
  assert.equal(fake.captured.deleted, 0, "لا حذف أعمى");
});

// ===========================================================================
// G) مفتاح يتصادم عليه أكثر من بطاقة حيّة: لا هوية تُخمَّن (Codex P1 على #259)
// ===========================================================================
// بطاقتان بأسماء مختلفة تتطابقان بعد التطبيع ⇒ الـMap يحتفظ بآخرهما صامتاً.
// إسناد هوية تلك البطاقة لسطر قد يخصّ الأخرى يكسر مطابقة متوسط التكلفة
// ويُسند الصف لبطاقة ليست له. الهوية المخمَّنة أسوأ من غيابها.
const AMBIGUOUS = {
  stockItems: [
    stockItem("كابتن بلاك كور", "كابتن بلاك كوين", GUID_LIVE),
    stockItem("كابتن بلاك كور", "كابتن بلاك كور", GUID_OTHER)
  ],
  priceRows: [priceRow("كابتن بلاك كور", "كابتن بلاك كور", 250)],
  existingRows: []
};

const ambiguous = await runImport(AMBIGUOUS);

await test("G1) تصادم بطاقتين على مفتاح واحد ⇒ الصف يُحفظ بلا هوية لا بهوية مخمَّنة", () => {
  assert.equal(ambiguous.captured.inserted.length, 1);
  assert.equal(
    ambiguous.captured.inserted[0].item_guid,
    null,
    "عند التصادم لا تُمرَّر أي هوية — لا الأولى ولا الأخيرة"
  );
});

await test("G2) والتصادم لا يمرّ صامتاً: المستخدم يُنبَّه بالعدد", () => {
  const texts = ambiguous.notices.map((n) => n.message).join(" ");
  assert.match(texts, /أكثر من بطاقة في الأمين/, "لا بدّ من تنبيه صريح");
  assert.match(texts, /1 مادة/, "مع عدد المواد المتصادمة");
});

await test("G3) صفّان لنفس البطاقة (هوية واحدة) ليسا تصادماً — الهوية تمرّ", async () => {
  const run = await runImport({
    stockItems: [
      stockItem("مالبورو احمر", "مالبورو أحمر", GUID_LIVE),
      stockItem("مالبورو احمر", "مالبورو أحمر", GUID_LIVE.toLowerCase())
    ],
    priceRows: [priceRow("مالبورو احمر", "مالبورو أحمر", 250)],
    existingRows: []
  });
  assert.ok(run.captured.inserted[0].item_guid, "تكرار البطاقة نفسها لا يمنع هويتها");
});

// ===========================================================================
// F) لا انحدار في upsert ولا في حرّاس #257
// ===========================================================================
await test("F1) upsert: الهوية المحفوظة تتقدّم على الموثوقة (لم يتغيّر)", async () => {
  const fake = makeFakeSupabase({ existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)] });
  const dataStore = buildDataStore(fake);
  await dataStore.upsertApprovedPriceItems([
    {
      itemKey: "اليغانس طويل فضي",
      itemName: "اليغانس طويل فضي",
      itemGuid: GUID_OTHER,
      unit2Price: 300,
      unit2Factor: 50
    }
  ]);
  assert.equal(fake.captured.upserted[0].item_guid, GUID_OTHER);
});

await test("F2) upsert: حارس منع الصف المكرر الجديد ما زال يرفض قبل أي كتابة", async () => {
  const fake = makeFakeSupabase({ existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)] });
  const dataStore = buildDataStore(fake);
  await assert.rejects(
    () =>
      dataStore.upsertApprovedPriceItems([
        {
          itemKey: "اليغانس طويل فضي جديد",
          itemName: "اليغانس طويل فضي جديد",
          itemGuid: GUID_OTHER,
          unit2Price: 300,
          unit2Factor: 50
        }
      ]),
    /صفاً مكرراً جديداً/
  );
  assert.equal(fake.captured.upserted, null, "لا كتابة عند الرفض");
});

await test("F3) upsert: إعادة إسناد هوية صفٍّ قائم ما زالت مرفوضة", async () => {
  const fake = makeFakeSupabase({ existingRows: [existingRow("اليغانس طويل فضي", GUID_OTHER)] });
  const dataStore = buildDataStore(fake);
  await assert.rejects(
    () =>
      dataStore.upsertApprovedPriceItems([
        {
          itemKey: "اليغانس طويل فضي",
          itemName: "اليغانس طويل فضي",
          itemGuid: GUID_LIVE,
          unit2Price: 300,
          unit2Factor: 50
        }
      ]),
    /هوية بطاقة تخالف هويتها المحفوظة/
  );
  assert.equal(fake.captured.upserted, null);
});

await test("F4) replace ما زال لا يستدعي حارس الصف المكرر الجديد (دلالة delete-then-insert)", () => {
  const body = sliceBalanced(CLIENT_SOURCE, "async replaceApprovedPriceItems(items) {", "replaceApprovedPriceItems");
  assert.ok(
    !body.includes("assertNoNewDuplicateGuidRow("),
    "مسار الاستبدال يحذف الجدول كله ثم يعيده، فحالة ما قبل الحفظ ليست مرجع ملكية فيه"
  );
  assert.match(body, /assertNoGuidPriceConflict\(withUser\)/, "حارس تعارض السعر ما زال مستدعى");
});

await test("F5) كل كتابة في مسار الاستبدال تقع بعد كل الحرّاس", () => {
  const body = sliceBalanced(CLIENT_SOURCE, "async replaceApprovedPriceItems(items) {", "replaceApprovedPriceItems");
  const lastGuardAt = Math.max(
    body.indexOf("assertNoGuidPriceConflict(withUser)"),
    body.indexOf("assertNoDuplicateGuidInPayload(")
  );
  assert.ok(lastGuardAt > 0, "يجب وجود الحارسين");
  for (const writeCall of [".delete(", ".insert("]) {
    assert.ok(body.indexOf(writeCall) > lastGuardAt, `${writeCall} يجب أن تقع بعد الحرّاس`);
  }
});

// ---------------------------------------------------------------------------
console.log("check-replace-path-item-guid:");
for (const line of results) console.log(line);
if (failed) {
  console.error(`\nفشل ${failed} من ${results.length}.`);
  process.exit(1);
}
console.log(`\nOK — ${results.length} فحصاً: الهوية الموثوقة تعبر مسار الاستبدال كاملاً.`);
