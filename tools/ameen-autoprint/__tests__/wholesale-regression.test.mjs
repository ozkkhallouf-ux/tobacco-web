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
  assert.ok(/if \(printerGate\.ready\(\)\) \{[\s\S]{0,200}await poll\(pool, state/.test(watcherSrc));
});

await test("watcher.js: poll لا يطبع فاتورة قبل التحقق من الجاهزية، والفاتورة تبقى غير مُعلَّمة", () => {
  assert.ok(/if \(!printerGate\.ready\(\)\) \{[^}]*break; \}[\s\S]{0,1200}await printInvoice\(inv\);/.test(watcherSrc));
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

await test("watcher.js: catch حلقة poll() يعيد رمي أخطاء الإعداد القاطعة، ويستخدم describeError الآمن لغير ذلك", () => {
  assert.ok(/if \(err && \(err\.fatalPrinterConfig \|\| err\.fatalPersist\)\) throw err;\s*\n\s*console\.error\(`خطأ: \$\{describeError\(err\)\}`\);/.test(watcherSrc));
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
    "persistState",
    "advanceWatchFromDate",
    "localDateStr",
    "migrationAdoptCutoff",
    `${groupIntoInvoicesSrc}\n${pollSrc}\nreturn poll;`
  );
  const sql = { UniqueIdentifier: "uniqueidentifier", NVarChar: "nvarchar" };
  const config = { wholesaleTypeGuid: "wt-guid" };
  const printerGate = { ready: () => true };
  const pruneOldGuids = () => {};
  const saveState = () => {};
  const persistState = () => true;
  // هذه الاختبارات تثبّت النافذة عمداً كي تقيس سلوك الطباعة وحده؛ تقدّم النافذة
  // نفسه له اختباراته المستقلة أدناه (قسم «نافذة المراقبة»).
  const advanceWatchFromDate = () => null;
  const localDateStr = (ms) => new Date(ms).toISOString().slice(0, 10);
  const migrationAdoptCutoff = () => "9999-12-31";
  return factory(
    sql, "test-config" && config, "-- test double --", printerGate,
    gcb, pi, pruneOldGuids, saveState, persistState, advanceWatchFromDate,
    localDateStr, migrationAdoptCutoff
  );
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

console.log("\n== wholesale-regression: نافذة المراقبة — عطل إعادة طباعة الفواتير القديمة ==");

// العطل: watchFromDate كانت تُضبط مرة واحدة يوم التثبيت ولا تتقدّم أبداً، فنافذة
// الاستعلام تكبر بلا حد بينما ذاكرة الـdedup محدودة بسبعة أيام. فما إن تُحذف علامة
// فاتورة (pruneOldGuids) حتى يعيدها الاستعلام كأنها جديدة فتُطبع ثانية — وتأخذ
// ختماً زمنياً جديداً فتتكرر الدورة بلا نهاية. والأسوأ أن إعادة الطباعة نفسها
// ترفع changed فتُشغّل prune من جديد، فيتحوّل الأمر إلى شلّال ورق.
//
// هذه الاختبارات تُشغّل الدوال الحقيقية المستخرَجة من watcher.js بساعة مزيّفة،
// بلا SQL ولا Puppeteer ولا طباعة فعلية.

const localDateStrSrc = extractFunctionSource(watcherSrc, "function localDateStr(ms)");
const advanceSrc = extractFunctionSource(watcherSrc, "function advanceWatchFromDate(state, nowMs");
const pruneSrc = extractFunctionSource(watcherSrc, "function pruneOldGuids(state)");

// الرقمان يُقرآن من المصدر الفعلي لا يُعاد كتابتهما، كي يفشل الاختبار إن غُيّرا.
function readConst(name) {
  const m = watcherSrc.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(m, `لم أجد الثابت ${name} في watcher.js`);
  // يقبل 7 و30_000 و10 * 60 * 1000 — وتُرفض أي صيغة غير حسابية بحتة كي لا
  // يتحوّل قارئ الثوابت إلى تنفيذ تعبير عشوائي من المصدر.
  const expr = m[1].trim();
  assert.ok(/^[\d_\s*+]+$/.test(expr), `صيغة الثابت ${name} غير حسابية بحتة: ${expr}`);
  const value = Number(new Function(`return (${expr});`)());
  assert.ok(Number.isFinite(value), `تعذّر تقييم الثابت ${name}`);
  return value;
}
const WATCH_LOOKBACK_DAYS = readConst("WATCH_LOOKBACK_DAYS");
const PRINTED_RETENTION_DAYS = readConst("PRINTED_RETENTION_DAYS");
const DAY = 24 * 60 * 60 * 1000;

// ساعة مزيّفة كاملة: new Date(ms) وnew Date() وDate.now() كلها تحترم NOW.
let NOW = Date.parse("2026-01-01T09:00:00Z");
class FakeDate extends Date {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}

function makeWindowHarness(gate, extras = {}) {
  const printed = [];
  const printerGate = gate || { ready: () => true };
  const persistState = extras.persistState || (() => true);
  const body = [
    `const WATCH_LOOKBACK_DAYS = ${WATCH_LOOKBACK_DAYS};`,
    `const PRINTED_RETENTION_DAYS = ${PRINTED_RETENTION_DAYS};`,
    "const STATE_SCHEMA_VERSION = 2;",
    `const WINDOW_SAFETY_MARGIN_DAYS = ${readConst("WINDOW_SAFETY_MARGIN_DAYS")};`,
    "const DAY_MS = 24 * 60 * 60 * 1000;",
    localDateStrSrc,
    advanceSrc,
    pruneSrc,
    groupIntoInvoicesSrc,
    pollSrc,
    "return { poll, advanceWatchFromDate, localDateStr };",
  ].join("\n");
  const api = new Function(
    "sql", "config", "SALES_QUERY", "printerGate",
    "getCustomerBalance", "printInvoice", "persistState", "Date", "console",
    body
  )(
    { UniqueIdentifier: "u", NVarChar: "n" },
    { wholesaleTypeGuid: "wt-guid", stateFilePath: extras.stateFilePath || "X" },
    "-- test double --",
    printerGate,
    async () => ({ accountGuid: "G1", current: 100 }),
    async (inv) => { printed.push(inv.number); },
    persistState,
    FakeDate,
    { log: extras.log || (() => {}), error: extras.error || (() => {}) },
  );
  return { ...api, printed };
}

// الاستعلام الحقيقي يفلتر بـ `CAST(u.Date AS date) >= @watchFrom`؛ هنا تُمرَّر
// الصفوف مباشرة فنحاكي الفلتر نفسه كي يبقى السيناريو أميناً للـSQL.
function rowsVisibleTo(ledger, state) {
  return ledger.filter((r) => r.invoice_date >= state.watchFromDate);
}

await test("الثابتان: نافذة الاستعلام أقصر من ذاكرة الـdedup (شرط عدم تكرار الطباعة)", () => {
  assert.ok(
    PRINTED_RETENTION_DAYS >= WATCH_LOOKBACK_DAYS + 3,
    `PRINTED_RETENTION_DAYS (${PRINTED_RETENTION_DAYS}) يجب أن تتجاوز `
    + `WATCH_LOOKBACK_DAYS (${WATCH_LOOKBACK_DAYS}) بثلاثة أيام على الأقل`
  );
});

await test("watcher.js: حارس assertDedupWindowInvariant موجود ويُستدعى في main()", () => {
  assert.ok(/function assertDedupWindowInvariant\(\)/.test(watcherSrc), "الدالة غير موجودة");
  assert.ok(/assertWholesaleConfig\(\);\s*\n\s*assertDedupWindowInvariant\(\);/.test(watcherSrc),
    "لا تُستدعى عند الإقلاع بجانب assertWholesaleConfig");
});

await test("advanceWatchFromDate: تتقدّم مع مرور الأيام ولا تبقى مجمّدة على يوم التثبيت", () => {
  const { advanceWatchFromDate, localDateStr } = makeWindowHarness();
  const state = { watchFromDate: "2026-01-01", printedGuids: {} };
  NOW = Date.parse("2026-06-01T09:00:00Z");
  const moved = advanceWatchFromDate(state);
  assert.equal(moved && moved.previous, "2026-01-01", "لم تُعِد التاريخ السابق عند التقدّم");
  assert.equal(state.watchFromDate, localDateStr(NOW - WATCH_LOOKBACK_DAYS * DAY));
  assert.equal(moved.abandonedFrom, null, "لا متأخّرات في التشغيل الطبيعي");
});

await test("advanceWatchFromDate: لا تتراجع أبداً إلى الوراء", () => {
  const { advanceWatchFromDate } = makeWindowHarness();
  NOW = Date.parse("2026-06-01T09:00:00Z");
  const state = { watchFromDate: "2026-12-31", printedGuids: {} };
  assert.equal(advanceWatchFromDate(state), null, "أبلغت عن تغيير رغم عدم وجوده");
  assert.equal(state.watchFromDate, "2026-12-31", "تراجعت النافذة إلى الوراء");
});

await test("advanceWatchFromDate: تبقي نافذة اللحاق (أمس/اليوم) مفتوحة ولا تقفز إلى اليوم", () => {
  const { advanceWatchFromDate } = makeWindowHarness();
  NOW = Date.parse("2026-06-10T09:00:00Z");
  const state = { watchFromDate: "2026-01-01", printedGuids: {} };
  advanceWatchFromDate(state);
  const lag = Math.round((Date.parse(`${"2026-06-10"}T00:00:00Z`) - Date.parse(`${state.watchFromDate}T00:00:00Z`)) / DAY);
  assert.equal(lag, WATCH_LOOKBACK_DAYS, "نافذة اللحاق لا تساوي WATCH_LOOKBACK_DAYS");
});

await test("localDateStr: تاريخ محلّي لا UTC (يطابق u.Date وGETDATE() في الأمين)", () => {
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(watcherSrc),
    "ما زال يُستخدم توقيت UTC لحساب تاريخ النافذة");
  const { localDateStr } = makeWindowHarness();
  const t = Date.parse("2026-03-05T12:00:00Z");
  const d = new Date(t);
  assert.equal(localDateStr(t),
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
});

await test("انحدار العطل: 90 يوماً متتالياً ⇒ صفر إعادة طباعة وصفر فاتورة ضائعة", async () => {
  const { poll, printed } = makeWindowHarness();
  const T0 = Date.parse("2026-01-01T09:00:00Z");
  const state = { watchFromDate: "2026-01-01", printedGuids: {} };
  const ledger = [];
  let seq = 1000;

  for (let day = 0; day < 90; day++) {
    NOW = T0 + day * DAY;
    const dateStr = new Date(NOW).toISOString().slice(0, 10);
    for (let k = 0; k < 8; k++) {
      ledger.push(fakeSalesRow({
        invoice_guid: `g-${seq}`, invoice_number: String(seq), invoice_date: dateStr,
      }));
      seq++;
    }
    // ثلاث دورات في اليوم: prune يجري بعد الطباعة، والدورة التالية هي التي كانت
    // تكشف العطل (تعيد الفواتير التي حُذفت علاماتها).
    for (let cycle = 0; cycle < 3; cycle++) {
      await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
    }
  }

  const counts = {};
  for (const n of printed) counts[n] = (counts[n] || 0) + 1;
  const reprinted = Object.entries(counts).filter(([, c]) => c > 1);
  assert.equal(reprinted.length, 0,
    `أُعيدت طباعة ${reprinted.length} فاتورة قديمة — العطل عاد: ${reprinted.slice(0, 5).map(([n, c]) => `#${n}×${c}`).join(", ")}`);
  assert.equal(printed.length, ledger.length,
    `عدد الأوراق (${printed.length}) لا يساوي عدد الفواتير (${ledger.length})`);
  assert.equal(Object.keys(counts).length, ledger.length, "فواتير لم تُطبع إطلاقاً");
});

await test("انحدار العطل: هدوء طويل ثم فاتورة واحدة ⇒ لا انفجار ورق في الدورة التالية", async () => {
  const { poll, printed } = makeWindowHarness();
  const T0 = Date.parse("2026-01-01T09:00:00Z");
  const state = { watchFromDate: "2026-01-01", printedGuids: {} };
  const ledger = [];
  let seq = 7000;

  for (let day = 0; day < 30; day++) {
    NOW = T0 + day * DAY;
    const dateStr = new Date(NOW).toISOString().slice(0, 10);
    for (let k = 0; k < 8; k++) {
      ledger.push(fakeSalesRow({ invoice_guid: `q-${seq}`, invoice_number: String(seq), invoice_date: dateStr }));
      seq++;
    }
    await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  }
  const afterWork = printed.length;

  // عشرة أيام بلا أي فاتورة جديدة
  for (let day = 30; day < 40; day++) {
    NOW = T0 + day * DAY;
    await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  }
  assert.equal(printed.length - afterWork, 0, "طُبع ورق أثناء أيام بلا فواتير جديدة");

  // فاتورة واحدة جديدة تُشغّل prune — هنا كان الانفجار يحدث
  NOW = T0 + 40 * DAY;
  ledger.push(fakeSalesRow({
    invoice_guid: `q-${seq}`, invoice_number: String(seq),
    invoice_date: new Date(NOW).toISOString().slice(0, 10),
  }));
  const before = printed.length;
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length - before, 1, "الدورة التي تطبع الفاتورة الجديدة طبعت أكثر من ورقة");
  const mid = printed.length;
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length - mid, 0, "انفجار ورق في الدورة التالية لـprune — العطل عاد");
});

await test("ملف الحالة لا يتضخّم بلا حد رغم تقدّم النافذة", async () => {
  const { poll } = makeWindowHarness();
  const T0 = Date.parse("2026-01-01T09:00:00Z");
  const state = { watchFromDate: "2026-01-01", printedGuids: {} };
  const ledger = [];
  let seq = 9000;
  for (let day = 0; day < 120; day++) {
    NOW = T0 + day * DAY;
    const dateStr = new Date(NOW).toISOString().slice(0, 10);
    for (let k = 0; k < 8; k++) {
      ledger.push(fakeSalesRow({ invoice_guid: `z-${seq}`, invoice_number: String(seq), invoice_date: dateStr }));
      seq++;
    }
    await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  }
  const kept = Object.keys(state.printedGuids).length;
  assert.ok(kept <= 8 * (PRINTED_RETENTION_DAYS + 2),
    `ملف الحالة يحتفظ بـ${kept} علامة — أكثر من نافذة الاحتفاظ`);
  assert.ok(kept < ledger.length, "لم يُحذف أي شيء — prune لا يعمل");
});

console.log("\n== wholesale-regression: ملف الحالة — كتابة ذرّية وقراءة متحقّقة ==");

await test("saveState: كتابة ذرّية (ملف مؤقّت ثم rename) لا writeFileSync مباشرة على ملف الحالة", () => {
  const saveSrc = extractFunctionSource(watcherSrc, "function saveState(state)");
  assert.ok(/renameSync/.test(saveSrc), "لا يوجد rename ذرّي — ملف مبتور يعني إعادة طباعة فواتير اليوم");
  assert.ok(/\.tmp/.test(saveSrc), "لا يُكتب إلى ملف مؤقّت أولاً");
  assert.ok(!/writeFileSync\(\s*config\.stateFilePath/.test(saveSrc), "ما زال يكتب مباشرة على ملف الحالة");
});

await test("loadState: ملف تالف ≠ أول تشغيل صامت (يُسجَّل تحذير صريح)", () => {
  const loadSrc = extractFunctionSource(watcherSrc, "function loadState()");
  assert.ok(/console\.error/.test(loadSrc), "ملف الحالة التالف يمرّ صامتاً");
  assert.ok(/printedGuids/.test(loadSrc) && /watchFromDate/.test(loadSrc),
    "لا تحقّق من بنية الملف قبل قبوله");
});

await test("انقطاع الطابعة أياماً: الفواتير تُطبع عند العودة ولا تُسقط بصمت", async () => {
  // نافذة ضيّقة (يومان) كانت تُسقط كل فاتورة تعطّلت الطابعة أكثر من يومين
  // بعدها — تراجع عن السلوك القديم الذي كان يطبعها ولو متأخّرة. اللحاق أسبوع.
  let printerUp = true;
  const { poll, printed } = makeWindowHarness({ ready: () => printerUp });
  const T0 = Date.parse("2026-01-01T09:00:00Z");
  const state = { watchFromDate: "2026-01-01", printedGuids: {} };
  const ledger = [];
  let seq = 4000;
  const addDay = (dayIdx) => {
    NOW = T0 + dayIdx * DAY;
    const dateStr = new Date(NOW).toISOString().slice(0, 10);
    for (let k = 0; k < 3; k++) {
      ledger.push(fakeSalesRow({ invoice_guid: `o-${seq}`, invoice_number: String(seq), invoice_date: dateStr }));
      seq++;
    }
  };

  addDay(0);
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 3, "اليوم الطبيعي لم يُطبع كاملاً");

  // الطابعة تسقط خمسة أيام والفواتير تتراكم
  printerUp = false;
  for (let d = 1; d <= 5; d++) {
    addDay(d);
    await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  }
  assert.equal(printed.length, 3, "طُبع ورق أثناء تعطّل الطابعة");

  // الطابعة تعود باليوم السادس
  printerUp = true;
  addDay(6);
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);

  assert.equal(printed.length, ledger.length,
    `فواتير سقطت بصمت: طُبعت ${printed.length} من ${ledger.length} بعد عودة الطابعة`);
  const counts = {};
  for (const n of printed) counts[n] = (counts[n] || 0) + 1;
  assert.equal(Object.entries(counts).filter(([, c]) => c > 1).length, 0, "اللحاق أعاد طباعة فواتير");
});

await test("الثابتان: اللحاق أسبوع على الأقل كي يحتمل انقطاعاً واقعياً للطابعة", () => {
  assert.ok(WATCH_LOOKBACK_DAYS >= 7,
    `WATCH_LOOKBACK_DAYS = ${WATCH_LOOKBACK_DAYS} — أقل من أسبوع يُسقط فواتير بصمت بعد انقطاع`);
});

await test("ترحيل الحالة القديمة: دورة الترحيل لا تطبع ورقة واحدة وتتبنّى القائم", async () => {
  // إعادة بناء حالة الجهاز الحقيقية يوم 2026-09-16 كما وصفها المستخدم:
  // النسخة القديمة جمّدت النافذة على يوم التثبيت وحذفت علامات 09-09 (7 أيام)،
  // فطُبعت فواتير 9 أيلول من جديد. لو فُتحت النافذة الجديدة (7 أيام) على حالة
  // كهذه بلا ترحيل، لأعادت طباعتها دفعة أخيرة بعد النشر.
  const { poll, printed } = makeWindowHarness();
  NOW = Date.parse("2026-09-16T09:00:00Z");
  const ledger = [];
  let seq = 700;
  for (let d = 9; d <= 16; d++) {
    const dateStr = `2026-09-${String(d).padStart(2, "0")}`;
    for (let k = 0; k < 4; k++) {
      ledger.push(fakeSalesRow({ invoice_guid: `m-${seq}`, invoice_number: String(seq), invoice_date: dateStr }));
      seq++;
    }
  }
  // حالة قديمة: نافذة مجمّدة، وعلامات آخر 6 أيام فقط (09-09 مفقودة كما حدث فعلاً)
  const state = {
    watchFromDate: "2026-03-01",
    processedThrough: "2026-09-16",
    printedGuids: Object.fromEntries(
      ledger.filter((r) => r.invoice_date > "2026-09-09").map((r) => [r.invoice_guid, NOW - DAY])
    ),
  };
  const missingBefore = ledger.filter((r) => !state.printedGuids[r.invoice_guid]).length;
  assert.equal(missingBefore, 4, "تهيئة الاختبار: يجب أن تكون فواتير 09-09 وحدها بلا علامة");

  // ما يفعله main() على حالة قديمة
  state.schemaVersion = 2;
  state.adoptBaseline = true;

  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 0,
    `دورة الترحيل طبعت ${printed.length} ورقة — يجب أن تكون صفراً`);
  assert.ok(!state.adoptBaseline, "لم تُستهلك راية الترحيل فستتكرّر كل دورة");
  for (const r of ledger) {
    assert.ok(state.printedGuids[r.invoice_guid], `لم تُتبنَّ الفاتورة ${r.invoice_number}`);
  }

  // دورة تالية: لا شيء يُطبع
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 0, "طُبعت فواتير قديمة بعد الترحيل");

  // فاتورة جديدة فعلاً ⇒ تُطبع وحدها
  ledger.push(fakeSalesRow({ invoice_guid: "m-new", invoice_number: "9999", invoice_date: "2026-09-16" }));
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.deepEqual(printed, ["9999"], "الفاتورة الجديدة وحدها يجب أن تُطبع");
});

await test("بلا ترحيل، نفس الحالة كانت ستُعيد طباعة فواتير 9 أيلول (شاهد سالب)", async () => {
  const { poll, printed } = makeWindowHarness();
  NOW = Date.parse("2026-09-16T09:00:00Z");
  const ledger = [];
  let seq = 800;
  for (let d = 9; d <= 16; d++) {
    const dateStr = `2026-09-${String(d).padStart(2, "0")}`;
    for (let k = 0; k < 4; k++) {
      ledger.push(fakeSalesRow({ invoice_guid: `n-${seq}`, invoice_number: String(seq), invoice_date: dateStr }));
      seq++;
    }
  }
  const state = {
    schemaVersion: 2,   // كأن الترحيل لم يُطبَّق
    watchFromDate: "2026-03-01",
    printedGuids: Object.fromEntries(
      ledger.filter((r) => r.invoice_date > "2026-09-09").map((r) => [r.invoice_guid, NOW - DAY])
    ),
  };
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 4,
    "الشاهد السالب فقد معناه: بلا ترحيل يجب أن تُطبع فواتير 09-09 الأربع");
});

await test("watcher.js: الحالة الجديدة تُوسم بنسخة البنية، والقديمة تُوسم للترحيل", () => {
  assert.ok(/const STATE_SCHEMA_VERSION = \d+;/.test(watcherSrc), "لا ثابت لنسخة البنية");
  assert.ok(/schemaVersion: STATE_SCHEMA_VERSION/.test(watcherSrc), "أول تشغيل لا يوسم النسخة");
  assert.ok(/Number\(state\.schemaVersion \|\| 1\) < STATE_SCHEMA_VERSION/.test(watcherSrc),
    "لا كشف للحالة القديمة");
  assert.ok(/state\.adoptBaseline = true;/.test(watcherSrc), "لا وسم للترحيل");
  // الترحيل يجب أن يسبق أي طباعة داخل poll
  const adoptIdx = watcherSrc.indexOf("if (state.adoptBaseline)");
  const printIdx = watcherSrc.indexOf("await printInvoice(inv);");
  assert.ok(adoptIdx > 0 && adoptIdx < printIdx, "دورة الترحيل لا تسبق الطباعة");
});

await test("انقطاع أطول من نافذة اللحاق: المتأخّرات تبقى مرئية وتُطبع (ملاحظة Codex P1)", async () => {
  // النافذة كانت تتقدّم بمجرّد مرور الوقت، فانقطاعٌ أطول من اللحاق يُخرج
  // المتأخّرات من الاستعلام نهائياً. الآن الحدّ لا يتجاوز آخر يوم فُحص فعلاً.
  let printerUp = true;
  const { poll, printed } = makeWindowHarness({ ready: () => printerUp });
  const T0 = Date.parse("2026-01-01T09:00:00Z");
  const state = { watchFromDate: "2026-01-01", processedThrough: "2026-01-01", printedGuids: {} };
  const ledger = [];
  let seq = 6000;
  const addDay = (d) => {
    NOW = T0 + d * DAY;
    const ds = new Date(NOW).toISOString().slice(0, 10);
    ledger.push(fakeSalesRow({ invoice_guid: `L-${seq}`, invoice_number: String(seq), invoice_date: ds }));
    seq++;
  };

  addDay(0);
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 1);

  // الطابعة تسقط 12 يوماً — أطول من WATCH_LOOKBACK_DAYS (7)
  printerUp = false;
  for (let d = 1; d <= 12; d++) {
    addDay(d);
    await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  }
  assert.equal(printed.length, 1, "طُبع ورق أثناء الانقطاع");

  printerUp = true;
  addDay(13);
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);

  assert.equal(printed.length, ledger.length,
    `سقطت متأخّرات بصمت: طُبعت ${printed.length} من ${ledger.length} بعد انقطاع 12 يوماً`);
});

await test("انقطاع يتجاوز أقصى نافذة آمنة: يُقصّ الحدّ لكن بتحذير صريح لا بصمت", () => {
  const { advanceWatchFromDate } = makeWindowHarness();
  const retention = readConst("PRINTED_RETENTION_DAYS");
  const margin = readConst("WINDOW_SAFETY_MARGIN_DAYS");
  NOW = Date.parse("2026-06-01T09:00:00Z");
  // مفحوص حتى تاريخ أقدم بكثير من أقصى نافذة
  const state = { watchFromDate: "2026-01-01", processedThrough: "2026-01-05", printedGuids: {} };
  const moved = advanceWatchFromDate(state);
  assert.ok(moved, "لم تتقدّم النافذة");
  assert.equal(moved.abandonedFrom, "2026-01-05",
    "لم تُسمَّ الأيام المتخلّى عنها — الإسقاط يمرّ بصمت");
  const hardFloorMs = NOW - (retention - margin) * DAY;
  assert.equal(state.watchFromDate, new Date(hardFloorMs).toISOString().slice(0, 10),
    "الحدّ لم يُقصّ إلى أقصى نافذة آمنة");
  // وحارس نصّي: التحذير يُطبع فعلاً
  assert.ok(/abandonedFrom[\s\S]{0,400}console\.error/.test(watcherSrc),
    "لا تحذير مطبوع عند التخلّي عن أيام");
});

await test("الترحيل: صفر طباعة، وكل فاتورة بلا علامة تُعَدّ مطبوعة مسبقاً", async () => {
  // بلا تخمين: لا يمكن بنيوياً تمييز «طُبعت وحُذفت علامتها» من «لم تُطبع» —
  // فالضمانة هي صفر إعادة طباعة، والحماية من الفقدان هي السرد الصريح.
  const logged = [];
  const { poll, printed } = makeWindowHarness(undefined, { log: (m) => logged.push(m) });
  NOW = Date.parse("2026-09-16T09:00:00Z");
  const ledger = [];
  let seq = 700;
  for (let d = 9; d <= 16; d++) {
    const ds = `2026-09-${String(d).padStart(2, "0")}`;
    ledger.push(fakeSalesRow({ invoice_guid: `A-${seq}`, invoice_number: String(seq), invoice_date: ds }));
    seq++;
  }
  const state = {
    watchFromDate: "2026-03-01", schemaVersion: 2, adoptBaseline: true,
    printedGuids: Object.fromEntries(
      ledger.filter((r) => r.invoice_date >= "2026-09-12")
        .map((r) => [r.invoice_guid, Date.parse(`${r.invoice_date}T12:00:00Z`)])
    ),
  };

  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 0, "دورة الترحيل طبعت ورقاً");
  for (const r of ledger) {
    assert.ok(state.printedGuids[r.invoice_guid], `بقيت الفاتورة ${r.invoice_number} بلا علامة`);
  }
  assert.ok(!state.adoptBaseline, "لم تُستهلك راية الترحيل");

  // والسرد الصريح هو ما يمنع الفقدان الصامت: أرقام وتواريخ الفواتير المتبنّاة.
  const listing = logged.join("\n");
  for (const d of ["09", "10", "11"]) {
    assert.ok(listing.includes(`(2026-09-${d})`),
      `فاتورة ${d} أيلول تُبنّيت بلا سرد صريح — فقدان صامت`);
  }
  assert.ok(/القائمة الكاملة/.test(listing), "لا تعليمة تحقّق في السجل");
});

await test("حالة الجهاز الحقيقية 16 أيلول: صفر إعادة طباعة، والجديدة وحدها تُطبع", async () => {
  const { poll, printed } = makeWindowHarness();
  NOW = Date.parse("2026-09-16T09:00:00Z");
  const ledger = [];
  let seq = 900;
  for (let d = 9; d <= 16; d++) {
    const ds = `2026-09-${String(d).padStart(2, "0")}`;
    for (let k = 0; k < 4; k++) {
      ledger.push(fakeSalesRow({ invoice_guid: `R-${seq}`, invoice_number: String(seq), invoice_date: ds }));
      seq++;
    }
  }
  // علامات 10→16 موجودة، وعلامات 9 أيلول حُذفت بحكم الاحتفاظ — وهي التي طُبعت اليوم
  const state = {
    watchFromDate: "2026-03-01", schemaVersion: 2, adoptBaseline: true,
    printedGuids: Object.fromEntries(
      ledger.filter((r) => r.invoice_date > "2026-09-09")
        .map((r) => [r.invoice_guid, Date.parse(`${r.invoice_date}T12:00:00Z`)])
    ),
  };

  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 0,
    `أُعيدت طباعة ${printed.length} فاتورة من 9 أيلول — نفس شكوى المستخدم`);

  NOW = Date.parse("2026-09-16T11:00:00Z");
  ledger.push(fakeSalesRow({ invoice_guid: "R-NEW", invoice_number: "9999", invoice_date: "2026-09-16" }));
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.deepEqual(printed, ["9999"], "الفاتورة الجديدة وحدها يجب أن تُطبع");
});

await test("الترحيل: فشل الحفظ يُبقي الراية، يُرجع التبنّيات، ولا يطبع شيئاً", async () => {
  let persistOk = false;
  const { poll, printed } = makeWindowHarness(undefined, { persistState: () => persistOk });
  NOW = Date.parse("2026-09-16T09:00:00Z");
  const ledger = [
    fakeSalesRow({ invoice_guid: "P-1", invoice_number: "401", invoice_date: "2026-09-09" }),
    fakeSalesRow({ invoice_guid: "P-2", invoice_number: "402", invoice_date: "2026-09-16" }),
  ];
  const state = { watchFromDate: "2026-03-01", schemaVersion: 2, adoptBaseline: true, printedGuids: {} };

  await assert.rejects(
    () => poll(fakePollPool(rowsVisibleTo(ledger, state)), state),
    (err) => Boolean(err && err.fatalPersist && /رفض قاطع/.test(err.message)),
  );
  assert.equal(printed.length, 0, "طُبع ورق بعد فشل حفظ الترحيل");
  assert.ok(state.adoptBaseline, "رُفعت الراية رغم فشل الحفظ");
  assert.ok(!state.printedGuids["P-1"] && !state.printedGuids["P-2"],
    "بقيت تبنّيات في الذاكرة بلا مقابل على القرص");

  persistOk = true;
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.equal(printed.length, 0, "دورة الترحيل الناجحة طبعت ورقاً");
  assert.ok(!state.adoptBaseline, "لم تُستهلك الراية بعد نجاح الحفظ");

  NOW = Date.parse("2026-09-16T11:00:00Z");
  ledger.push(fakeSalesRow({ invoice_guid: "P-3", invoice_number: "403", invoice_date: "2026-09-16" }));
  await poll(fakePollPool(rowsVisibleTo(ledger, state)), state);
  assert.deepEqual(printed, ["403"], "الفاتورة الجديدة بعد الترحيل لم تُطبع وحدها");
});

await test("watcher.js: فشل حفظ الترحيل مُجهِض ولا يُبتلع في حلقة الاستعلام", () => {
  assert.ok(/err\.fatalPersist = true;/.test(watcherSrc), "لا علامة إجهاض على فشل حفظ الترحيل");
  assert.ok(/fatalPrinterConfig \|\| err\.fatalPersist/.test(watcherSrc),
    "حلقة الاستعلام تبتلع فشل حفظ الترحيل");
});

await test("watcher.js: لا تخمين في الترحيل — لا حدّ ولا دليل نشاط ولا أختام", () => {
  assert.ok(!/migrationAdoptCutoff/.test(watcherSrc), "ما زالت دالة الحدّ موجودة");
  assert.ok(!/legacyWasActiveOn/.test(watcherSrc), "ما زال دليل نشاط اليوم موجوداً");
  assert.ok(!/LEGACY_RETENTION_DAYS/.test(watcherSrc), "ما زال ثابت احتفاظ النسخة القديمة موجوداً");
  const pollSrcNow = extractFunctionSource(watcherSrc, "async function poll(pool, state)");
  assert.ok(/القائمة الكاملة/.test(pollSrcNow), "لا سرد صريح للفواتير المتبنّاة");
});

console.log("\n== wholesale-regression: قفل النسخة الواحدة — مملوك لنظام التشغيل ==");

// النسخة الملفّية (PID + نبضة + بيات) أنتجت خمس ملاحظات P1 متتابعة من أصل واحد:
// ملف JSON لا يصلح mutex. الحجز على منفذ محلّي يملكه النظام: يضمن نسخة واحدة،
// ويحرّره هو عند موت العملية — فلا PID ولا نبضة ولا قفل متروك ولا سباق.
import netMod from "node:net";

const socketLockSrcs = [
  extractFunctionSource(watcherSrc, "function lockHeldError(message)"),
  extractFunctionSource(watcherSrc, "function singleInstancePort()"),
  extractFunctionSource(watcherSrc, "function acquireSingleInstanceLock()"),
].join("\n");

function makeSocketLockApi(port) {
  return new Function("net", "config",
    `${socketLockSrcs}\nreturn { acquireSingleInstanceLock, singleInstancePort };`
  )(netMod, { singleInstancePort: port });
}

let testPortSeq = 49230;
const nextTestPort = () => testPortSeq++;

await test("القفل: نسخة واحدة تحجز المنفذ", async () => {
  const port = nextTestPort();
  const lock = await makeSocketLockApi(port).acquireSingleInstanceLock();
  try {
    assert.equal(lock.port, port);
  } finally { lock.release(); }
});

await test("القفل: النسخة الثانية ترفض الإقلاع (fatalLockHeld) والمنفذ محجوز", async () => {
  const port = nextTestPort();
  const first = await makeSocketLockApi(port).acquireSingleInstanceLock();
  try {
    await assert.rejects(
      () => makeSocketLockApi(port).acquireSingleInstanceLock(),
      (err) => {
        assert.equal(err.fatalLockHeld, true, "لم تُعلَّم fatalLockHeld");
        assert.ok(/طباعة الفاتورة مرتين/.test(err.message), "الرسالة لا تشرح الخطر");
        assert.ok(/singleInstancePort/.test(err.message), "الرسالة لا تذكر موضع التغيير");
        return true;
      }
    );
  } finally { first.release(); }
});

await test("القفل: النظام يحرّره عند الإغلاق فتُقلع نسخة تالية", async () => {
  const port = nextTestPort();
  const first = await makeSocketLockApi(port).acquireSingleInstanceLock();
  first.release();
  // لا قفل متروك ولا تنظيف يدوي — وهذا كل الفرق عن النسخة الملفّية
  const second = await makeSocketLockApi(port).acquireSingleInstanceLock();
  try {
    assert.equal(second.port, port);
  } finally { second.release(); }
});

await test("القفل: منفذ غير صالح في config.js يُرفض برسالة واضحة", async () => {
  for (const bad of [0, 80, 70000, "abc", null]) {
    await assert.rejects(
      () => makeSocketLockApi(bad).acquireSingleInstanceLock(),
      (err) => Boolean(err && /singleInstancePort/.test(err.message)),
      `المنفذ غير الصالح ${bad} لم يُرفض`
    );
  }
});

await test("config.js: singleInstancePort مضبوط ومعقول", () => {
  const m = configSrc.match(/singleInstancePort:\s*(\d+)/);
  assert.ok(m, "singleInstancePort غير مضبوط في config.js");
  const port = Number(m[1]);
  assert.ok(port >= 1024 && port <= 65535, `منفذ غير صالح: ${port}`);
});

await test("watcher.js: لا بقايا من القفل الملفّي (PID/نبضة/بيات/استيلاء)", () => {
  // إعادة أيٍّ منها تُعيد صنف السباقات الذي أُزيل بالكامل.
  for (const gone of [
    "lockFilePath", "lockPayload", "publishLockExclusive", "writeLockAtomic",
    "makeLockHandle", "processAlive", "LOCK_STALE_MS", "LOCK_BEAT_MIN_INTERVAL_MS",
    "LOCK_UNREADABLE_RETRIES", "lockOwnedByUs", "isLost", "stillOwned",
  ]) {
    assert.ok(!watcherSrc.includes(gone), `ما زال ${gone} موجوداً — بقايا القفل الملفّي`);
  }
  assert.ok(/require\("net"\)/.test(watcherSrc), "net غير مستورد");
  assert.ok(/server\.listen\(port, "127\.0\.0\.1"\)/.test(watcherSrc),
    "الحجز ليس على 127.0.0.1");
  assert.ok(/server\.unref\(\)/.test(watcherSrc), "الحجز يمنع خروج العملية");
});

await test("watcher.js: القفل يُستحوذ قبل فحص الطابعة والاتصال بـSQL ويُحرَّر عند الخروج", () => {
  const mainSrc = extractFunctionSource(watcherSrc, "async function main()");
  const lockIdx = mainSrc.indexOf("await acquireSingleInstanceLock()");
  const sqlIdx = mainSrc.indexOf("new sql.ConnectionPool(sqlCfg).connect()");
  assert.ok(lockIdx > 0 && lockIdx < sqlIdx, "القفل يُستحوذ بعد الاتصال بـSQL لا قبله");
  assert.ok(/process\.on\("exit", \(\) => lock\.release\(\)\)/.test(mainSrc), "لا تحرير عند الخروج");
  assert.ok(/assertDedupWindowInvariant\(\);[\s\S]{0,400}?acquireSingleInstanceLock\(\)/.test(watcherSrc),
    "القفل لا يُستحوذ مبكراً عند الإقلاع");
});

await test("watcher.js: poll لم يعد يحتاج نبضة ولا فحص ملكية (الحجز يكفي)", () => {
  const pollSrcNow = extractFunctionSource(watcherSrc, "async function poll(pool, state)");
  assert.ok(!/hooks/.test(pollSrcNow), "ما زال poll يتلقّى خطّافات قفل");
  assert.ok(!/beat\(/.test(pollSrcNow), "ما زالت هناك نبضة داخل الدورة");
});

await test("watcher.js: fatalLockHeld يخرج برسالة مفهومة لا كـ'خطأ فادح' غامض", () => {
  assert.ok(/err\.fatalLockHeld[\s\S]{0,200}process\.exit\(2\)/.test(watcherSrc),
    "الخروج عند القفل المحجوز غير مميَّز");
});

console.log("\n== wholesale-regression: فشل حفظ الحالة — لا يمرّ صامتاً ==");

await test("persistState: فشل الحفظ يُسجَّل كعطل حرج ولا يُرمى (الطباعة نجحت فعلاً)", () => {
  const src = extractFunctionSource(watcherSrc, "function persistState(state)");
  assert.ok(/console\.error/.test(src), "فشل الحفظ يمرّ صامتاً");
  assert.ok(/عطل حرج/.test(src), "الرسالة لا تُصنّف العطل كحرج");
  assert.ok(/فستُطبع من جديد|ستُطبع من جديد/.test(src), "الرسالة لا تشرح أثر الفشل (إعادة طباعة)");

  let calls = 0;
  const persistState = new Function("saveState", "console", "config", "describeError",
    `${src}\nreturn persistState;`)(
    () => { throw new Error("EACCES: permission denied"); },
    { error: () => { calls++; } },
    { stateFilePath: "X" },
    (e) => e.message,
  );
  // لا يرمي مهما فشل الحفظ، ويُسجّل العطل فعلاً
  assert.equal(persistState({ printedGuids: {} }), false, "أرجعت نجاحاً رغم فشل الحفظ");
  assert.equal(calls, 1, "لم يُسجَّل العطل الحرج في السجل");
});

await test("watcher.js: كل مسارات حفظ الحالة تمرّ من persistState لا من saveState مباشرة", () => {
  // saveState يُعرَّف مرة ويُستدعى مرة واحدة فقط — من داخل persistState.
  const directCalls = (watcherSrc.match(/(?<!function )\bsaveState\(state\)/g) || []).length;
  assert.equal(directCalls, 1,
    `saveState(state) يُستدعى مباشرة ${directCalls} مرة — يجب أن تمرّ كلها من persistState`);
  assert.ok(/persistState\(state\);/.test(watcherSrc), "persistState غير مستخدمة");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
