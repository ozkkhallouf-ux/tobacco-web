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

// ملاحظة Codex P1 على PR #208: فشل الاستعلام نفسه (SQL/اتصال/timeout) لا يجوز
// أن يُبتلع ويتحول إلى null/"غير متاح" — يجب أن يُميَّز عن "لا نتيجة" وينتشر،
// فيلتقطه poll() (لا يطبع، لا يُعلِّم، يعيد المحاولة في الدورة التالية).
await test("استثناء تقني أثناء الاستعلام ⇒ يُرمى (لا يتحول إلى null/'غير متاح' صامتاً)", async () => {
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
  await assert.rejects(
    () => getCustomerBalance(throwingPool, "inv-12"),
    /محاكاة انقطاع اتصال/
  );
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
  // بعد إصلاح العملة صار الرصيد يُقسم على معامل الصرف قبل العرض، لكن الفرع
  // السالب يبقى null حرفياً — لا صفر ولا رقم ملفّق. نثبّت المعنى لا الصياغة.
  assert.ok(/inv\.customerBalance = balance \? [^:]*balance\.current[^:]* : null;/.test(watcherSrc));
  assert.ok(!/inv\.customerBalance = balance \?[^;]*: 0;/.test(watcherSrc));
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

console.log("\n== wholesale-regression: بوّابة جاهزية الطابعة (إصلاح P1 على PR #208) ==");

// probePhysicalPrinter وcreatePrinterGate تُستخرجان من المصدر الفعلي وتُشغَّلان
// بحقن spawnSync/config/الساعة — بلا Windows وبلا طابعة وبلا أي طباعة حقيقية.
const probeSrc = extractFunctionSource(watcherSrc, "function probePhysicalPrinter()");
const gateSrc = extractFunctionSource(watcherSrc, "function createPrinterGate(deps)");
const printerConfigErrorSrc = extractFunctionSource(watcherSrc, "function printerConfigError(message)");

const PRINTER_NAME = "Canon G3410 WiFi";

function makeProbe(spawnResult) {
  const factory = new Function(
    "spawnSync",
    "config",
    `${printerConfigErrorSrc}\n${probeSrc}\nreturn probePhysicalPrinter;`
  );
  const spawnSync = () => spawnResult;
  return factory(spawnSync, { printerName: PRINTER_NAME });
}

function makeGate(deps) {
  const factory = new Function(
    "config",
    "PRINTER_RETRY_MIN_MS",
    "PRINTER_RETRY_MAX_MS",
    "PRINTER_READY_TTL_MS",
    "probePhysicalPrinter",
    `${gateSrc}\nreturn createPrinterGate;`
  );
  const noopProbe = () => ({ ready: true, reason: "" });
  return factory({ printerName: PRINTER_NAME }, 15000, 300000, 30000, noopProbe)(deps);
}

const silentLog = { log() {}, warn() {} };

// ── تصنيف العطل: اسم غير موجود (إعداد دائم) مقابل WorkOffline (عابر) ──
await test("probe: NOT_FOUND ⇒ خطأ إعداد دائم يرمي ولا يتحول إلى retry صامت", () => {
  const probe = makeProbe({ status: 0, stdout: "NOT_FOUND" });
  let thrown = null;
  try { probe(); } catch (e) { thrown = e; }
  assert.ok(thrown, "كان يجب أن يرمي على اسم طابعة غير موجود");
  assert.equal(thrown.fatalPrinterConfig, true);
  assert.ok(/غير موجودة في Windows/.test(thrown.message));
});

await test("probe: WorkOffline=true ⇒ عابر (لا يرمي) مع سبب واضح", () => {
  const probe = makeProbe({ status: 0, stdout: `FOUND|USB001|True|Idle` });
  const r = probe();
  assert.equal(r.ready, false);
  assert.ok(/Work Offline/.test(r.reason));
});

await test("probe: منفذ RDP معاد توجيهه ⇒ خطأ إعداد دائم يرمي", () => {
  const probe = makeProbe({ status: 0, stdout: `FOUND|TS001|False|Idle` });
  let thrown = null;
  try { probe(); } catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.equal(thrown.fatalPrinterConfig, true);
});

await test("probe: فشل PowerShell نفسه ⇒ عابر لا قاتل (خدمة CIM قد لا تكون جاهزة عند الإقلاع)", () => {
  const probe = makeProbe({ status: 1, stdout: "" });
  const r = probe();
  assert.equal(r.ready, false);
});

await test("probe: طابعة موجودة ومتصلة ⇒ ready", () => {
  const probe = makeProbe({ status: 0, stdout: `FOUND|USB001|False|Idle` });
  assert.deepEqual(probe(), { ready: true, reason: "" });
});

// ── سيناريو Codex: الطابعة غير جاهزة عند الإقلاع ──
await test("offline عند الإقلاع: البوّابة تُعيد false ولا ترمي (المراقب يبقى حياً)", () => {
  let t = 0;
  const gate = makeGate({
    probe: () => ({ ready: false, reason: "غير متصلة (Work Offline)" }),
    now: () => t,
    log: silentLog,
  });
  assert.equal(gate.ready(), false);
  assert.equal(gate.isOffline(), true);
});

await test("لا طباعة أثناء offline: البوّابة تبقى false عبر دورات متتالية", () => {
  let t = 0;
  const gate = makeGate({
    probe: () => ({ ready: false, reason: "غير متصلة" }),
    now: () => t,
    log: silentLog,
  });
  for (let i = 0; i < 20; i++) {
    assert.equal(gate.ready(), false, `الدورة ${i} سمحت بالطباعة أثناء العطل`);
    t += 5000;
  }
});

await test("لا busy-loop: عدد الفحوص الفعلية أقل بكثير من عدد الدورات", () => {
  let t = 0;
  let probes = 0;
  const gate = makeGate({
    probe: () => { probes++; return { ready: false, reason: "غير متصلة" }; },
    now: () => t,
    log: silentLog,
  });
  // 120 دورة × 5 ثوانٍ = 10 دقائق
  for (let i = 0; i < 120; i++) { gate.ready(); t += 5000; }
  assert.ok(probes <= 8, `عدد الفحوص ${probes} كبير — يوحي بـbusy-loop`);
});

await test("التراجع محدود بسقف: الفاصل لا يتجاوز 5 دقائق مهما طال العطل", () => {
  let t = 0;
  const stamps = [];
  const gate = makeGate({
    probe: () => { stamps.push(t); return { ready: false, reason: "غير متصلة" }; },
    now: () => t,
    log: silentLog,
  });
  for (let i = 0; i < 2000; i++) { gate.ready(); t += 5000; }
  const gaps = stamps.slice(1).map((v, i) => v - stamps[i]);
  assert.ok(gaps.length > 3, "لم تُسجَّل فواصل كافية");
  assert.ok(Math.max(...gaps) <= 300000, `فاصل ${Math.max(...gaps)} تجاوز السقف`);
});

await test("بلا log spam: تحذير واحد لكل نوبة عطل لا واحد لكل دورة", () => {
  let t = 0;
  let warns = 0;
  const gate = makeGate({
    probe: () => ({ ready: false, reason: "غير متصلة" }),
    now: () => t,
    log: { log() {}, warn() { warns++; } },
  });
  for (let i = 0; i < 120; i++) { gate.ready(); t += 5000; }
  assert.equal(warns, 1, `عدد التحذيرات ${warns} — يجب أن يكون واحداً لنوبة بسبب واحد`);
});

// ── الاستئناف التلقائي بعد عودة الطابعة ──
await test("بعد عودة الطابعة: البوّابة تسمح بالمعالجة تلقائياً بلا تدخل", () => {
  let t = 0;
  let online = false;
  const gate = makeGate({
    probe: () => (online ? { ready: true, reason: "" } : { ready: false, reason: "غير متصلة" }),
    now: () => t,
    log: silentLog,
  });
  assert.equal(gate.ready(), false);
  online = true;
  t += 15000; // انقضاء أول فاصل إعادة محاولة
  assert.equal(gate.ready(), true, "لم تستأنف رغم عودة الطابعة");
  assert.equal(gate.isOffline(), false);
});

await test("العودة تُسجَّل مرة واحدة صراحةً", () => {
  let t = 0;
  let online = false;
  let logs = 0;
  const gate = makeGate({
    probe: () => (online ? { ready: true, reason: "" } : { ready: false, reason: "غير متصلة" }),
    now: () => t,
    log: { log() { logs++; }, warn() {} },
  });
  gate.ready();
  online = true;
  t += 15000;
  gate.ready();
  assert.equal(logs, 1);
});

await test("خطأ الإعداد الدائم يمرّ عبر البوّابة ولا يُبتلع كعطل عابر", () => {
  let t = 0;
  const gate = makeGate({
    probe: () => { const e = new Error("اسم خاطئ"); e.fatalPrinterConfig = true; throw e; },
    now: () => t,
    log: silentLog,
  });
  let thrown = null;
  try { gate.ready(); } catch (e) { thrown = e; }
  assert.ok(thrown && thrown.fatalPrinterConfig === true);
});

// ── لا fallback إلى أي طابعة أخرى ──
await test("watcher.js: لا سقوط إلى الطابعة الافتراضية أو أي طابعة بديلة", () => {
  assert.ok(!/DefaultPrinter|Get-WmiObject .*Default|-Default\b/.test(watcherSrc));
  // كل مسارات الطباعة تستهدف config.printerName حصراً
  const printerRefs = watcherSrc.match(/-print-to "\$\{[^}]+\}"|ArgumentList '\$\{[^}]+\}'/g) || [];
  assert.ok(printerRefs.length >= 1, "لم يُعثر على أي مسار طباعة");
  assert.ok(/const printer = config\.printerName;/.test(watcherSrc));
});

await test("watcher.js: الحلقة الرئيسية لا تستعلم ولا تطبع ما لم تُصرّح البوّابة", () => {
  assert.ok(/if \(printerGate\.ready\(\)\) \{[\s\S]{0,200}await poll\(pool, state\);/.test(watcherSrc));
});

await test("watcher.js: poll لا يطبع فاتورة قبل التحقق من الجاهزية، والفاتورة تبقى غير مُعلَّمة", () => {
  assert.ok(/if \(!printerGate\.ready\(\)\) break;[\s\S]{0,600}await printInvoice\(inv\);/.test(watcherSrc));
  // العلامة تُكتب بعد الطباعة فقط — dedup بلا تغيير
  assert.ok(/await printInvoice\(inv\);\s*\n\s*state\.printedGuids\[inv\.guid\] = Date\.now\(\);/.test(watcherSrc));
});

await test("watcher.js: لم يعد الإقلاع ينهي العملية عند عطل عابر (لا assert قاتل)", () => {
  assert.ok(!/assertPhysicalPrinterReady/.test(watcherSrc));
  assert.ok(/printerGate\.ready\(\);/.test(watcherSrc));
});

console.log("\n== wholesale-regression: describeError — DeepScan INSUFFICIENT_NULL_CHECK (حلقة الاستعلام الرئيسية) ==");

// describeError تُستخرج من المصدر الفعلي وتُشغَّل بمعزل — لا نسخة يدوية قد تنحرف.
const describeErrorSrc = extractFunctionSource(watcherSrc, "function describeError(err)");
const describeError = new Function(`${describeErrorSrc}\nreturn describeError;`)();

await test("describeError: كائن Error عادي ⇒ رسالته كما هي", () => {
  assert.equal(describeError(new Error("x")), "x");
});

await test("describeError: null ⇒ نص آمن بلا رمي", () => {
  assert.equal(describeError(null), "null");
});

await test("describeError: undefined ⇒ نص آمن بلا رمي", () => {
  assert.equal(describeError(undefined), "undefined");
});

await test("describeError: سلسلة نصية مرمية مباشرة ⇒ تُعاد كما هي", () => {
  assert.equal(describeError("string error"), "string error");
});

await test("describeError: رقم مرمى مباشرة ⇒ نص آمن", () => {
  assert.equal(describeError(123), "123");
});

await test("describeError: كائن عادي فارغ بلا message ⇒ نص آمن بلا رمي", () => {
  assert.equal(describeError({}), "{}");
});

await test("describeError: كائن يحمل خصائص دائرية (JSON.stringify يفشل) ⇒ نص آمن بلا رمي", () => {
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => describeError(circular));
});

await test("watcher.js: catch حلقة poll() يعيد رمي fatalPrinterConfig فقط، ويستخدم describeError الآمن لغير ذلك", () => {
  assert.ok(/if \(err && err\.fatalPrinterConfig\) throw err;\s*\n\s*console\.error\(`خطأ: \$\{describeError\(err\)\}`\);/.test(watcherSrc));
  // لا رجوع إلى err.message المباشر غير المحروس داخل هذه الكتلة (سبب DeepScan INSUFFICIENT_NULL_CHECK الأصلي)
});

await test("سيناريو متكامل: throw Object.assign(new Error('fatal'), {fatalPrinterConfig:true}) يُعاد رميه كما هو (لا يُبتلع)", () => {
  const err = Object.assign(new Error("fatal"), { fatalPrinterConfig: true });
  function simulateCatch(e) {
    if (e && e.fatalPrinterConfig) throw e;
    return describeError(e);
  }
  let thrown = null;
  try { simulateCatch(err); } catch (e) { thrown = e; }
  assert.equal(thrown, err);
});

await test("سيناريو متكامل: كل حالات throw غير fatalPrinterConfig تُسجَّل بأمان ولا تُميت الحلقة", () => {
  function simulateCatch(e) {
    if (e && e.fatalPrinterConfig) throw e;
    return describeError(e);
  }
  const cases = [new Error("x"), null, undefined, "string error", 123, {}];
  for (const c of cases) {
    assert.doesNotThrow(() => simulateCatch(c), `رمت الحلقة على: ${String(c)}`);
  }
});

console.log("\n== wholesale-regression: poll() — فشل استعلام رصيد الزبون (إصلاح P1 على PR #208) ==");

// poll() وgroupIntoInvoices تُستخرجان من المصدر الفعلي وتُشغَّلان بمعزل —
// بحقن pool/config/printerGate/getCustomerBalance/printInvoice/pruneOldGuids/
// saveState وهمية. لا SQL حقيقي ولا Puppeteer ولا طباعة فعلية.
const pollSrc = extractFunctionSource(watcherSrc, "async function poll(pool, state)");
const groupIntoInvoicesSrc = extractFunctionSource(watcherSrc, "function groupIntoInvoices(rows)");

function makePoll({ getCustomerBalance: gcb, printInvoice: pi }) {
  const factory = new Function(
    "sql",
    "config",
    "SALES_QUERY",
    "printerGate",
    "getCustomerBalance",
    "printInvoice",
    "pruneOldGuids",
    "saveState",
    `${groupIntoInvoicesSrc}\n${pollSrc}\nreturn poll;`
  );
  const sql = { UniqueIdentifier: "uniqueidentifier", NVarChar: "nvarchar" };
  const config = { wholesaleTypeGuid: "wt-guid" };
  const printerGate = { ready: () => true };
  const pruneOldGuids = () => {};
  const saveState = () => {};
  return factory(sql, config, "-- test double --", printerGate, gcb, pi, pruneOldGuids, saveState);
}

function fakeSalesRow(overrides = {}) {
  return {
    invoice_guid: "inv-guid-1",
    invoice_number: "1001",
    invoice_date: "2026-09-01",
    customer_name: "زبون تجريبي",
    total: 100,
    discount: 0,
    first_pay: 0,
    currency_val: 1,
    currency_iso: "USD",
    item_name: "صنف",
    unit_name: "قطعة",
    display_qty: 1,
    ...overrides,
  };
}

function fakePollPool(rows) {
  return {
    request() {
      return {
        input() { return this; },
        async query() { return { recordset: rows }; },
      };
    },
  };
}

await test("poll(): استعلام رصيد ناجح مع رصيد موجود ⇒ يُطبع ويُعلَّم (السلوك الحالي)", async () => {
  const printed = [];
  const poll = makePoll({
    getCustomerBalance: async () => ({ accountGuid: "G1", current: 500 }),
    printInvoice: async (inv) => { printed.push(inv); },
  });
  const state = { printedGuids: {}, watchFromDate: "2026-01-01" };
  await poll(fakePollPool([fakeSalesRow()]), state);
  assert.equal(printed.length, 1);
  assert.equal(printed[0].customerBalanceFound, true);
  assert.equal(printed[0].customerBalance, 500);
  assert.ok(state.printedGuids["inv-guid-1"], "لم تُعلَّم الفاتورة بعد الطباعة");
});

await test("poll(): استعلام ناجح بلا نتيجة ⇒ يُطبع بـ'غير متاح' حسب العقد الحالي (لا رمي)", async () => {
  const printed = [];
  const poll = makePoll({
    getCustomerBalance: async () => null, // لا صفوف — نتيجة عمل صحيحة، ليست فشلاً
    printInvoice: async (inv) => { printed.push(inv); },
  });
  const state = { printedGuids: {}, watchFromDate: "2026-01-01" };
  await poll(fakePollPool([fakeSalesRow()]), state);
  assert.equal(printed.length, 1);
  assert.equal(printed[0].customerBalanceFound, false);
  assert.equal(printed[0].customerBalance, null);
  assert.ok(state.printedGuids["inv-guid-1"], "لم تُعلَّم الفاتورة رغم نجاح الطباعة");
});

await test("poll(): فشل تقني عابر في استعلام الرصيد ⇒ لا طباعة، لا printedGuid، تُعاد المحاولة لاحقاً", async () => {
  const printed = [];
  const poll = makePoll({
    getCustomerBalance: async () => { throw new Error("محاكاة timeout"); },
    printInvoice: async (inv) => { printed.push(inv); },
  });
  const state = { printedGuids: {}, watchFromDate: "2026-01-01" };
  await poll(fakePollPool([fakeSalesRow()]), state);
  assert.equal(printed.length, 0, "طُبعت الفاتورة رغم فشل استعلام الرصيد تقنياً");
  assert.ok(!state.printedGuids["inv-guid-1"], "عُلِّمت الفاتورة كمطبوعة رغم عدم طباعتها فعلياً");
});

await test("poll(): إعادة المحاولة اللاحقة بعد فشل عابر تنجح وتطبع الفاتورة مرة واحدة فقط", async () => {
  const printed = [];
  const state = { printedGuids: {}, watchFromDate: "2026-01-01" };
  const rows = [fakeSalesRow()];

  // الدورة الأولى: فشل تقني في استعلام الرصيد — لا طباعة، لا تعليم.
  const failingPoll = makePoll({
    getCustomerBalance: async () => { throw new Error("محاكاة انقطاع مؤقت"); },
    printInvoice: async (inv) => { printed.push(inv); },
  });
  await failingPoll(fakePollPool(rows), state);
  assert.equal(printed.length, 0);
  assert.ok(!state.printedGuids["inv-guid-1"]);

  // الدورة التالية (نفس state — dedup بلا تغيير): الاستعلام نجح هذه المرة.
  const succeedingPoll = makePoll({
    getCustomerBalance: async () => ({ accountGuid: "G1", current: 500 }),
    printInvoice: async (inv) => { printed.push(inv); },
  });
  await succeedingPoll(fakePollPool(rows), state);
  assert.equal(printed.length, 1, "لم تُطبع الفاتورة بعد نجاح إعادة المحاولة");
  assert.ok(state.printedGuids["inv-guid-1"]);

  // دورة ثالثة إضافية بعد أن صارت مُعلَّمة: لا طباعة مكرّرة (dedup).
  const thirdPoll = makePoll({
    getCustomerBalance: async () => ({ accountGuid: "G1", current: 500 }),
    printInvoice: async (inv) => { printed.push(inv); },
  });
  await thirdPoll(fakePollPool(rows), state);
  assert.equal(printed.length, 1, "طُبعت الفاتورة مرة ثانية — تكرار طباعة (duplicate print)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
