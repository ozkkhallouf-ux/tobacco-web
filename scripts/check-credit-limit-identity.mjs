// ============================================================================
// فحص انحداري: **حد ائتمان يسقط عن صاحبه لمجرّد إعادة تسمية حسابه في الأمين.**
//
// العطل الذي يمنعه: كان الحد يُخزَّن ويُطابَق بمفتاح نصّي مشتقّ من اسم الزبون
// (`customer_key = normalizeItemName(name)`)، واسم الحساب في الأمين نصّ قابل
// للتعديل في أي لحظة. فإعادة تسمية واحدة تُغيّر المفتاح، فينفصل الحد عن صاحبه
// **صامتاً**: يظهر الزبون «بلا حد»، ويسقط عنه تصنيفا «تجاوز الحد» و«قريب من
// الحد»، فتُصرف له بضاعة فوق حده بلا أي تنبيه. وهو نفس العطل البنيوي المُثبت
// على الفواتير 2026-09-05 (راجع check-customer-invoice-identity.mjs).
//
// الفحص يشغّل **الدوال الحقيقية** المستخرجة من `src/app.js` و
// `src/supabase-client.js` و`src/business-snapshot.js` داخل vm — لا نسخاً
// مبسّطة ولا مطابقة نصّية.
// ============================================================================

import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const results = [];
let failed = 0;
function test(name, fn) {
  try { fn(); results.push(`  ✅ ${name}`); }
  catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error && error.message}`); }
}

function extract(file, patterns) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const out = [];
  for (const [name, pattern] of Object.entries(patterns)) {
    const found = source.match(pattern);
    if (!found) {
      failed += 1;
      results.push(`  ❌ استخراج ${name}\n     لم أجد التعريف في src/${file}`);
      continue;
    }
    out.push(found[0]);
  }
  return out.join("\n");
}

// ===== 1) مسار القراءة في الواجهة (src/app.js) =====

const appSource = extract("app.js", {
  normalizeItemName: /function normalizeItemName\(value\) \{[\s\S]*?\n\}\n/,
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  normGuid: /function normGuid\(value\) \{[\s\S]*?\n\}\n/,
  customerBalance: /function customerBalance\(item\) \{[\s\S]*?\n\}\n/,
  customerKey: /function customerKey\(item\) \{[\s\S]*?\n\}\n/,
  customerLimitMaps: /function customerLimitMaps\(\) \{[\s\S]*?\n\}\n/,
  customerLimitFor: /function customerLimitFor\(item, maps\) \{[\s\S]*?\n\}\n/,
  deriveCustomerStatus: /function deriveCustomerStatus\(balance, limit\) \{[\s\S]*?\n\}\n/,
  applyCustomerLimits: /function applyCustomerLimits\(items\) \{[\s\S]*?\n\}\n/
});

const appState = { customerCreditLimits: [] };
const appBox = { console, state: appState };
vm.createContext(appBox);
vm.runInContext(appSource, appBox);
const { applyCustomerLimits, normalizeItemName } = appBox;

// ===== البيانات: حساب واحد أُعيدت تسميته، ومعرّفه ثابت =====

const GUID = "500d8ef6-3563-48a3-b65b-713f0ee57e80";
const OLD_NAME = "لؤي زهية الضاحية";
const NEW_NAME = "لؤي خلوف المحترم / الضاحية";
const OLD_KEY = normalizeItemName(OLD_NAME);
const NEW_KEY = normalizeItemName(NEW_NAME);

// زبون آخر يحمل معرّفاً مختلفاً — يحرس ضد وراثة حدّ حسابٍ بالاسم.
const OTHER_GUID = "aaaaaaaa-0000-0000-0000-000000000001";

function balanceItem(name, guid, balance) {
  return { name, key: normalizeItemName(name), customerGuid: guid, balance, creditLimit: 0 };
}

function savedLimit(overrides) {
  return { id: "row-1", customerKey: OLD_KEY, customerGuid: GUID, customerName: OLD_NAME, creditLimit: 5000, notes: "حد متفق عليه", ...overrides };
}

// ---- الحالة المركزية: تغيّر الاسم، ثبت المعرّف ----

test("إعادة تسمية الحساب لا تُسقط الحد — المطابقة بالمعرّف", () => {
  appState.customerCreditLimits = [savedLimit()];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, GUID, 6000)]);
  assert.equal(row.internalCreditLimit, 5000, "الحد الداخلي سقط بعد إعادة التسمية");
  assert.equal(row.creditLimit, 5000);
  assert.equal(row.limitSource, "internal");
  assert.equal(row.internalLimitMatchedBy, "guid", "المطابقة لم تتم بالمعرّف");
  assert.equal(row.creditLimitNotes, "حد متفق عليه");
});

test("إعادة التسمية لا تُسقط تصنيف «تجاوز الحد»", () => {
  appState.customerCreditLimits = [savedLimit()];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, GUID, 6000)]);
  assert.equal(row.status, "over_limit", "الزبون المتجاوز ظهر بلا تجاوز بعد إعادة التسمية");
});

test("إعادة التسمية لا تُسقط تصنيف «قريب من الحد»", () => {
  appState.customerCreditLimits = [savedLimit()];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, GUID, 4700)]);
  assert.equal(row.status, "near_limit");
});

test("المتبقي من الحد يُحسب على الحد الصحيح بعد إعادة التسمية", () => {
  appState.customerCreditLimits = [savedLimit()];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, GUID, 2000)]);
  assert.equal(row.remainingLimit, 3000);
});

// ---- إثبات أن الفحص يفشل على السلوك القديم (المطابقة بالاسم وحده) ----

test("السلوك القديم يسقط فعلاً: المفتاح المحفوظ لا يطابق الاسم الجديد", () => {
  assert.notEqual(OLD_KEY, NEW_KEY, "الاسمان يجب أن ينتجا مفتاحين مختلفين وإلا لا يختبر الفحص شيئاً");
});

// ---- التوافق مع البيانات القائمة ----

test("سجل قديم بلا معرّف يبقى مربوطاً بالاسم", () => {
  appState.customerCreditLimits = [savedLimit({ customerGuid: "", customerKey: NEW_KEY })];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, GUID, 100)]);
  assert.equal(row.internalCreditLimit, 5000, "انكسر التوافق مع السجلات القديمة");
  assert.equal(row.internalLimitMatchedBy, "name");
});

test("تقرير أرصدة قديم بلا معرّف يبقى يعمل بالاسم", () => {
  appState.customerCreditLimits = [savedLimit({ customerKey: NEW_KEY })];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, "", 100)]);
  assert.equal(row.internalCreditLimit, 5000);
  assert.equal(row.internalLimitMatchedBy, "name");
});

test("مفتاح محفوظ غير مطبّع يبقى يطابق (ة مقابل ه)", () => {
  appState.customerCreditLimits = [savedLimit({ customerGuid: "", customerKey: "مركز شريفة اسعد شريفة" })];
  const [row] = applyCustomerLimits([balanceItem("مركز شريفه اسعد شريفه", "", 100)]);
  assert.equal(row.internalCreditLimit, 5000, "تراجع إصلاح التطبيع القديم");
});

// ---- الحراسة: لا يرث حسابٌ حدَّ حسابٍ آخر ----

test("حساب آخر يحمل الاسم نفسه لا يرث الحد", () => {
  appState.customerCreditLimits = [savedLimit({ customerKey: NEW_KEY })];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, OTHER_GUID, 9000)]);
  assert.equal(row.internalCreditLimit, 0, "حساب مختلف ورث حدّ حساب آخر بالاسم");
  assert.equal(row.limitSource, "none");
  assert.equal(row.status, "open_balance");
});

test("المعرّف الصفري يُعامل كغياب لا كمطابقة قطعية", () => {
  const zero = "00000000-0000-0000-0000-000000000000";
  appState.customerCreditLimits = [savedLimit({ customerGuid: zero, customerKey: "مفتاح-اخر" })];
  const [row] = applyCustomerLimits([balanceItem(NEW_NAME, zero, 100)]);
  assert.equal(row.internalCreditLimit, 0, "المعرّف الصفري طابق بين زبونين لا رابط بينهما");
});

test("حدّ الأمين يبقى احتياطاً حين لا يوجد حد داخلي", () => {
  appState.customerCreditLimits = [];
  const item = { ...balanceItem(NEW_NAME, GUID, 100), creditLimit: 800 };
  const [row] = applyCustomerLimits([item]);
  assert.equal(row.creditLimit, 800);
  assert.equal(row.limitSource, "ameen");
  assert.equal(row.internalLimitMatchedBy, "none");
});

// ===== 2) مسار الكتابة (src/supabase-client.js) =====

const clientSource = extract("supabase-client.js", {
  cleanText: /  function cleanText\(value, limit\) \{[\s\S]*?\n  \}\n/,
  parseNumber: /  function parseNumber\(value\) \{[\s\S]*?\n  \}\n/,
  ZERO_GUID_TEXT: /  const ZERO_GUID_TEXT = "00000000-0000-0000-0000-000000000000";/,
  GUID_SHAPE: /  const GUID_SHAPE = \/.*\/;/,
  normalizeGuid: /  function normalizeGuid\(value\) \{[\s\S]*?\n  \}\n/,
  normalizeDbCustomerLimit: /  function normalizeDbCustomerLimit\(row\) \{[\s\S]*?\n  \}\n/,
  normalizeCustomerLimitInput: /  function normalizeCustomerLimitInput\(input, userId = null\) \{[\s\S]*?\n  \}\n/,
  resolveCustomerLimitTarget: /  function resolveCustomerLimitTarget\(rows, payload\) \{[\s\S]*?\n  \}\n/
});

const clientBox = { console };
vm.createContext(clientBox);
vm.runInContext(clientSource, clientBox);
const { normalizeCustomerLimitInput, normalizeDbCustomerLimit, resolveCustomerLimitTarget } = clientBox;

test("الحفظ يرسل المعرّف إلى العمود الجديد", () => {
  const payload = normalizeCustomerLimitInput({ customerKey: NEW_KEY, customerGuid: GUID.toUpperCase(), customerName: NEW_NAME, creditLimit: "5,000" });
  assert.equal(payload.customer_guid, GUID, "المعرّف لم يُحفظ مطبّعاً بحالة صغيرة");
  assert.equal(payload.customer_key, NEW_KEY, "المفتاح النصّي يجب أن يبقى محفوظاً كاحتياط");
  assert.equal(payload.credit_limit, 5000);
});

test("المعرّف الصفري أو المشوّه لا يصل إلى قاعدة البيانات", () => {
  for (const bad of ["00000000-0000-0000-0000-000000000000", "", "  ", "not-a-guid", "500d8ef6"]) {
    const payload = normalizeCustomerLimitInput({ customerKey: NEW_KEY, customerGuid: bad, customerName: NEW_NAME, creditLimit: 1 });
    assert.equal(payload.customer_guid, null, `مرّر معرّفاً غير صالح: ${JSON.stringify(bad)}`);
  }
});

test("القراءة تُظهر المعرّف للواجهة", () => {
  const row = normalizeDbCustomerLimit({ id: "x", customer_key: NEW_KEY, customer_guid: GUID, customer_name: NEW_NAME, credit_limit: 5000, notes: "", updated_at: "2026-09-05T00:00:00Z" });
  assert.equal(row.customerGuid, GUID);
});

test("الحفظ يحدّث السجل المطابق بالمعرّف لا سجلاً يطابق الاسم", () => {
  const rows = [
    { id: "same-account", customer_key: OLD_KEY, customer_guid: GUID },
    { id: "other-account", customer_key: NEW_KEY, customer_guid: OTHER_GUID }
  ];
  const target = resolveCustomerLimitTarget(rows, { customer_key: NEW_KEY, customer_guid: GUID });
  assert.equal(target.mode, "update");
  assert.equal(target.row.id, "same-account", "كُتب الحد فوق سجل حساب آخر");
});

test("الحفظ يتبنّى سجلاً قديماً بلا معرّف فيثبّت هويته", () => {
  const rows = [{ id: "legacy", customer_key: NEW_KEY, customer_guid: null }];
  const target = resolveCustomerLimitTarget(rows, { customer_key: NEW_KEY, customer_guid: GUID });
  assert.equal(target.mode, "update");
  assert.equal(target.row.id, "legacy");
  assert.equal(target.adopt, true, "لم يُوسم التبنّي، فلن يُثبَّت المعرّف على السجل القديم");
});

test("الحفظ لا يتبنّى أبداً سجلاً يحمل معرّفاً مختلفاً", () => {
  const rows = [{ id: "other-account", customer_key: NEW_KEY, customer_guid: OTHER_GUID }];
  const target = resolveCustomerLimitTarget(rows, { customer_key: NEW_KEY, customer_guid: GUID });
  assert.equal(target.mode, "insert", "تبنّى سجل حساب آخر لمجرد تطابق الاسم");
});

test("الحفظ بلا معرّف يبقى على السلوك السابق: مطابقة بالمفتاح", () => {
  const rows = [{ id: "legacy", customer_key: NEW_KEY, customer_guid: null }];
  const target = resolveCustomerLimitTarget(rows, { customer_key: NEW_KEY, customer_guid: null });
  assert.equal(target.mode, "update");
  assert.equal(target.row.id, "legacy");
});

test("زبون جديد بلا سجل قائم يُدرَج", () => {
  const target = resolveCustomerLimitTarget([], { customer_key: NEW_KEY, customer_guid: GUID });
  assert.equal(target.mode, "insert");
  assert.equal(target.row, null);
});

// ===== 3) لوحة القيادة (src/business-snapshot.js) =====

const snapshotSource = extract("business-snapshot.js", {
  numberOrNull: /  const numberOrNull = \(value\) => \{[\s\S]*?\n  \};/,
  numberOrZero: /  const numberOrZero = .*;/,
  text: /  const text = \(value\) => String\(value \?\? ""\)\.trim\(\);/,
  iso: /  function iso\(value\) \{[\s\S]*?\n  \}\n/,
  DEFAULT_STALE_MINUTES: /  const DEFAULT_STALE_MINUTES = .*;/,
  freshness: /  function freshness\(asOf, staleMinutes = DEFAULT_STALE_MINUTES\) \{[\s\S]*?\n  \}\n/,
  meta: /  function meta\(source, asOf, completeness, note = null, staleMinutes = DEFAULT_STALE_MINUTES\) \{[\s\S]*?\n  \}\n/,
  customerKey: /  function customerKey\(row\) \{[\s\S]*?\n  \}\n/,
  customerName: /  function customerName\(row\) \{[\s\S]*?\n  \}\n/,
  customerBalance: /  function customerBalance\(row\) \{[\s\S]*?\n  \}\n/,
  ZERO_GUID: /  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  limitGuid: /  function limitGuid\(row\) \{[\s\S]*?\n  \}\n/,
  buildReceivables: /  function buildReceivables\(balanceReports, creditLimits\) \{[\s\S]*?\n  \}\n/
});

const snapBox = { console };
vm.createContext(snapBox);
vm.runInContext(snapshotSource, snapBox);
const { buildReceivables } = snapBox;

test("لوحة القيادة: الحد يبقى بعد إعادة التسمية", () => {
  const reports = [{ items: [balanceItem(NEW_NAME, GUID, 6000)] }];
  const limits = [{ customerKey: OLD_KEY, customerGuid: GUID, customerName: OLD_NAME, creditLimit: 5000 }];
  const out = buildReceivables(reports, limits);
  assert.equal(out.debtors[0].creditLimit, 5000);
  assert.equal(out.debtors[0].creditLimitSource, "approved");
  assert.equal(out.overLimitCount, 1, "سقط تنبيه التجاوز عن زبون متجاوز");
});

test("لوحة القيادة: لا وراثة حدّ بين حسابين يتطابق اسمهما", () => {
  const reports = [{ items: [balanceItem(NEW_NAME, OTHER_GUID, 6000)] }];
  const limits = [{ customerKey: NEW_KEY, customerGuid: GUID, customerName: NEW_NAME, creditLimit: 5000 }];
  const out = buildReceivables(reports, limits);
  assert.equal(out.debtors[0].creditLimitSource, "missing");
  assert.equal(out.overLimitCount, 0);
});

test("لوحة القيادة: سجل قديم بلا معرّف يبقى يعمل بالاسم", () => {
  const reports = [{ items: [balanceItem(NEW_NAME, GUID, 6000)] }];
  const limits = [{ customerKey: NEW_KEY, customerName: NEW_NAME, creditLimit: 5000 }];
  const out = buildReceivables(reports, limits);
  assert.equal(out.debtors[0].creditLimit, 5000);
});

// ===== 4) المخطط والهجرة =====

const migration = readFileSync(
  new URL("../supabase/migrations/20260905131500_credit_limits_customer_guid.sql", import.meta.url),
  "utf8"
);

test("الهجرة تضيف العمود وتفرض شكل المعرّف", () => {
  assert.match(migration, /add column if not exists customer_guid text/);
  assert.match(migration, /customer_credit_limits_customer_guid_shape/);
  assert.ok(migration.includes("customer_guid <> '00000000-0000-0000-0000-000000000000'"), "قيد المعرّف الصفري غائب");
});

test("الهجرة تفرض تفرّد المعرّف وتُبقي تفرّد المفتاح للسجلات القديمة", () => {
  assert.match(migration, /create unique index if not exists customer_credit_limits_customer_guid_key[\s\S]*?where customer_guid is not null/);
  assert.match(migration, /create unique index if not exists customer_credit_limits_customer_key_legacy_key[\s\S]*?where customer_guid is null/);
});

test("ردم الهجرة محروس بمرشّح واحد ومعرّف غير صفري", () => {
  assert.match(migration, /having count\(distinct report_guid\) = 1/);
  assert.ok(migration.includes("min(report_guid) <> '00000000-0000-0000-0000-000000000000'"), "الردم يقبل المعرّف الصفري");
});

// بعد الهجرة صار الفهرس على `customer_key` **جزئياً** (`where customer_guid is
// null`)، وPostgREST لا يستطيع استنتاج فهرس جزئي في ON CONFLICT. فأي upsert
// باقٍ على هذا الجدول يعني خطأ 42P10 عند أول حفظ.
test("لم يبقَ upsert على customer_key في جدول حدود الائتمان", () => {
  const client = readFileSync(new URL("../src/supabase-client.js", import.meta.url), "utf8");
  const block = client.slice(client.indexOf("async upsertCustomerCreditLimit"), client.indexOf("async getSyriaExchangeRate"));
  assert.ok(block.length > 0, "لم أجد كتلة حفظ الحد في supabase-client.js");
  assert.ok(!/\.upsert\(/.test(block), "ON CONFLICT لا يستنتج الفهرس الجزئي بعد الهجرة");
  assert.ok(/resolveCustomerLimitTarget\(/.test(block), "الحفظ لا يمرّ عبر قرار الهوية");
});

test("نموذج الحد في الواجهة يحمل المعرّف", () => {
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /data-form="customer-limit"[^>]*data-customer-guid=/, "النموذج لا يمرّر المعرّف، فالحفظ سيبقى بالاسم");
  assert.match(app, /customerGuid: customerGuidValue/, "الحفظ لا يرسل المعرّف");
});

console.log("فحص هوية حدود الائتمان (customerGuid)");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختبار`);
  process.exit(1);
}
console.log(`\n✅ ${results.length} اختباراً ناجحاً`);
