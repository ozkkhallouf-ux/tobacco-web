// ============================================================
// wholesale-regression.test.mjs
// اختبارات regression لمسار طباعة فواتير الجملة (watcher.js).
//
// لا اتصال SQL حقيقي، لا Puppeteer، لا طباعة فعلية، ولا استدعاء main().
// getCustomerBalance تُستخرج نصياً من المصدر الفعلي الحالي وتُشغَّل بمعزل
// (pool/sql وهميان) — لتفادي اختبار نسخة مكرّرة قد تنحرف عن الأصل بمرور الوقت.
//
// تشغيل: node tools/ameen-autoprint/__tests__/wholesale-regression.test.mjs
// ============================================================
"use strict";

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOPRINT_DIR = path.join(__dirname, "..");
const watcherSrc = fs.readFileSync(path.join(AUTOPRINT_DIR, "watcher.js"), "utf8");
const invoiceHtmlSrc = fs.readFileSync(path.join(AUTOPRINT_DIR, "invoice-html.js"), "utf8");
const configSrc = fs.readFileSync(path.join(AUTOPRINT_DIR, "config.js"), "utf8");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ─── استخراج getCustomerBalance من المصدر الحالي فعلياً (لا نسخة يدوية) ───
function extractFunctionSource(src, signature) {
  const startIdx = src.indexOf(signature);
  assert.ok(startIdx !== -1, `لم يُعثر على التوقيع: ${signature}`);
  const braceOpen = src.indexOf("{", startIdx);
  // إنهاء الدالة عند أول "}" بمفرده في بداية السطر (عمود 0) بعد بداية الدالة —
  // مطابق لتنسيق watcher.js حيث الدوال على مستوى الوحدة غير مُسندة داخل كتلة.
  const endMarker = "\n}\n";
  const endIdx = src.indexOf(endMarker, braceOpen);
  assert.ok(endIdx !== -1, `تعذّر تحديد نهاية الدالة لـ: ${signature}`);
  return src.slice(startIdx, endIdx + 2); // شامل "\n}"
}

const getCustomerBalanceSrc = extractFunctionSource(
  watcherSrc,
  "async function getCustomerBalance(pool, invoiceGuid)"
);

// نبني الدالة الحقيقية داخل Function عادية (غير async) تُعيدها كقيمة،
// مع حقن sql/CUSTOMER_BALANCE_QUERY كمتغيرات حرة في نطاقها (نفس الأسماء
// المستخدمة في المصدر الأصلي) — بلا تنفيذ لأي شيء آخر من watcher.js.
function makeGetCustomerBalance() {
  const factory = new Function(
    "sql",
    "CUSTOMER_BALANCE_QUERY",
    `${getCustomerBalanceSrc}\nreturn getCustomerBalance;`
  );
  const sql = { UniqueIdentifier: "uniqueidentifier" };
  const CUSTOMER_BALANCE_QUERY = "-- test double, never executed against a real DB --";
  return factory(sql, CUSTOMER_BALANCE_QUERY);
}

function fakePool(row) {
  return {
    request() {
      return {
        input() {
          return this;
        },
        async query() {
          return { recordset: row === undefined ? [] : [row] };
        },
      };
    },
  };
}

const getCustomerBalance = makeGetCustomerBalance();

console.log("== wholesale-regression: getCustomerBalance (المصدر الفعلي الحالي) ==");

await test("رقم موجب حقيقي يُقبل كما هو", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: 1500.5, account_guid: "G1" }), "inv-1");
  assert.equal(r.current, 1500.5);
  assert.equal(r.accountGuid, "G1");
});

await test("رقم سالب حقيقي يُقبل كما هو (رصيد دائن ممكن منطقياً)", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: -250, account_guid: "G2" }), "inv-2");
  assert.equal(r.current, -250);
});

await test("الصفر الحقيقي (0) يبقى قيمة صالحة ولا يُعامَل كـ'غير متاح'", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: 0, account_guid: "G3" }), "inv-3");
  assert.notEqual(r, null);
  assert.equal(r.current, 0);
});

await test("null ⇒ غير متاح (null)", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: null, account_guid: "G4" }), "inv-4");
  assert.equal(r, null);
});

await test("undefined ⇒ غير متاح (null)", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: undefined, account_guid: "G5" }), "inv-5");
  assert.equal(r, null);
});

await test("NaN ⇒ غير متاح (null) — لا يُمرَّر كرصيد ملفّق", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: NaN, account_guid: "G6" }), "inv-6");
  assert.equal(r, null);
});

await test("Infinity ⇒ غير متاح (null)", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: Infinity, account_guid: "G7" }), "inv-7");
  assert.equal(r, null);
});

await test("-Infinity ⇒ غير متاح (null)", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: -Infinity, account_guid: "G8" }), "inv-8");
  assert.equal(r, null);
});

await test("سلسلة نصية غير رقمية ⇒ غير متاح (null)", async () => {
  const r = await getCustomerBalance(fakePool({ document_current: "غير رقم", account_guid: "G9" }), "inv-9");
  assert.equal(r, null);
});

await test("لا صفوف من SQL ⇒ null (لا رصيد ملفّق)", async () => {
  const r = await getCustomerBalance(fakePool(undefined), "inv-10");
  assert.equal(r, null);
});

await test("هوية الرصيد هي AccountGUID وليست اسم الزبون (لا يوجد customer_name في الإرجاع)", async () => {
  const r = await getCustomerBalance(
    fakePool({ document_current: 10, account_guid: "ACCOUNT-GUID-123", customer_name: "زبون تجريبي" }),
    "inv-11"
  );
  assert.equal(r.accountGuid, "ACCOUNT-GUID-123");
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "customerName"));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "customer"));
});

await test("استثناء أثناء الاستعلام ⇒ null، لا رمي (poll() يستمر بأمان)", async () => {
  const throwingPool = {
    request() {
      return {
        input() {
          return this;
        },
        async query() {
          throw new Error("محاكاة انقطاع اتصال");
        },
      };
    },
  };
  const r = await getCustomerBalance(throwingPool, "inv-12");
  assert.equal(r, null);
});

console.log("\n== wholesale-regression: فحوص بنيوية على المصدر الحالي (نصّية) ==");

await test("watcher.js: الحارس Number.isFinite موجود قبل إرجاع الرصيد", () => {
  assert.ok(/if \(!Number\.isFinite\(current\)\) return null;/.test(watcherSrc));
});

await test("watcher.js: dedup الجملة يعتمد على GUID الفاتورة (state.printedGuids[inv.guid])، لا اسم الزبون", () => {
  assert.ok(/state\.printedGuids\[inv\.guid\]/.test(watcherSrc));
  // لا يوجد أي مفتاح dedup مبني على اسم الزبون
  assert.ok(!/printedGuids\[inv\.customer\]/.test(watcherSrc));
});

await test("watcher.js: لا يوجد أي معامل أو منطق -IncludeWholesale (هذه الأداة جملة فقط، بلا افتراضي مختلط)", () => {
  assert.ok(!/IncludeWholesale/.test(watcherSrc));
});

await test("watcher.js: BalanceFound=false لا يرافقها رقم رصيد ملفّق (customerBalance=null عند balance=null)", () => {
  assert.ok(/inv\.customerBalanceFound = balance !== null;/.test(watcherSrc));
  assert.ok(/inv\.customerBalance = balance \? balance\.current : null;/.test(watcherSrc));
});

await test("watcher.js: حراسة صريحة ضد استخدام GUID مبيعات الكاشير خطأً (assertWholesaleConfig)", () => {
  assert.ok(/CASHIER_RETAIL_TYPE_GUID/.test(watcherSrc));
  assert.ok(/assertWholesaleConfig/.test(watcherSrc));
});

await test("watcher.js: حراسة الطابعة الفيزيائية ترفض منافذ RDP المعاد توجيهها (/^TS\\d/)", () => {
  assert.ok(/\/\^TS\\d\/i\.test\(port\)/.test(watcherSrc));
});

await test("config.js: الطابعة الفيزيائية للجملة هي Canon G3410 WiFi فقط", () => {
  assert.ok(/printerName:\s*"Canon G3410 WiFi"/.test(configSrc));
});

await test("invoice-html.js: رقم السجل التجاري 0310109105 موجود", () => {
  assert.ok(invoiceHtmlSrc.includes("0310109105"));
});

await test("invoice-html.js: صفة البيع موجودة", () => {
  assert.ok(invoiceHtmlSrc.includes("صفة البيع"));
});

await test("invoice-html.js: عدم توفّر الرصيد يُعرض كـ'غير متاح' فقط عند customerBalanceFound=false، وليس صفراً ملفّقاً", () => {
  assert.ok(/inv\.customerBalanceFound[\s\S]{0,400}غير متاح/.test(invoiceHtmlSrc));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
