// ============================================================================
// فحص انحداري: **فاتورة ظاهرة في قائمة الفواتير ومفقودة من كشف الحساب أو من PDF.**
//
// العطل الحقيقي الذي يمنعه (مُثبت على بيانات الإنتاج، 2026-09-05):
//   • الساعة 10:26 أُعيدت تسمية الحساب `500d8ef6-3563-48a3-b65b-713f0ee57e80`
//     في الأمين من «لؤي زهية الضاحية» إلى «لؤي خلوف المحترم / الضاحية».
//   • تقرير الأرصدة (مزامنة كل دقيقة) وتقرير الحركات حملا الاسم الجديد فوراً،
//     بينما بقي تقرير الفواتير (مزامنته كانت كل ساعة) على الاسم القديم حتى 10:53.
//   • النتيجة خلال تلك النافذة: الفاتورة 4670$ ظاهرة في قائمة الفواتير (تمرّ على
//     كل المجموعات بلا مطابقة اسم)، ومفقودة من «كشف حساب زبون» ومن زر «فاتورة
//     PDF» (كلاهما كان يطابق بالاسم وحده).
//
// الفحص يشغّل **الدوال الحقيقية** المستخرجة من `src/app.js` داخل vm — لا نسخة
// مبسّطة ولا مطابقة نصية — على تركيبة بيانات تعيد إنتاج النافذة نفسها.
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

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

const PATTERNS = {
  ZERO_GUID: /const ZERO_GUID = "00000000-0000-0000-0000-000000000000";/,
  normalizeItemName: /function normalizeItemName\(value\) \{[\s\S]*?\n\}\n/,
  smartNameMatch: /function smartNameMatch\(list, getName, name\) \{[\s\S]*?\n\}\n/,
  normGuid: /function normGuid\(value\) \{[\s\S]*?\n\}\n/,
  customerIdentity: /function customerIdentity\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  customerInvoiceEntries: /function customerInvoiceEntries\(\) \{[\s\S]*?\n\}\n/,
  invoiceIdentityCacheVar: /let _invoiceIdentityCache = null;/,
  invoiceIdentityCache: /function invoiceIdentityCache\(\) \{[\s\S]*?\n\}\n/,
  orphanInvoiceEntries: /function orphanInvoiceEntries\(\) \{[\s\S]*?\n\}\n/,
  invoiceIdentityWarning: /function invoiceIdentityWarning\(\) \{[\s\S]*?\n\}\n/,
  customerInvoiceEntryFor: /function customerInvoiceEntryFor\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  customerInvoicesFor: /function customerInvoicesFor\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  invoiceByGuid: /function invoiceByGuid\(guid\) \{[\s\S]*?\n\}\n/,
  invoiceSyncLagMinutes: /function invoiceSyncLagMinutes\(\) \{[\s\S]*?\n\}\n/,
  customerInvoicesStatus: /function customerInvoicesStatus\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  customerInvoicesEmptyText: /function customerInvoicesEmptyText\(nameOrItem\) \{[\s\S]*?\n\}\n/,
  customerFullMovements: /function customerFullMovements\(item\) \{[\s\S]*?\n\}\n/,
  reportSyncedAt: /function reportSyncedAt\(report\) \{[\s\S]*?\n\}\n/,
  latestCustomerBalanceItems: /function latestCustomerBalanceItems\(\) \{[\s\S]*?\n\}\n/,
  salesHistoryInvoices: /function salesHistoryInvoices\(\) \{[\s\S]*?\n\}\n/
};

const source = [];
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const found = appJs.match(pattern);
  if (!found) {
    failed += 1;
    results.push(`  ❌ استخراج ${name}\n     لم أجد التعريف في src/app.js`);
    continue;
  }
  source.push(found[0]);
}

const state = {
  customerInvoicesReport: null,
  customerMovementsReport: null,
  customerBalanceReports: []
};
const sandbox = {
  console,
  state,
  // حدود الائتمان لا تخصّ هذا الفحص — تمرير بلا تعديل.
  applyCustomerLimits: (items) => items
};
vm.createContext(sandbox);
vm.runInContext(source.join("\n"), sandbox);
const {
  customerInvoicesFor, customerInvoicesStatus, customerInvoicesEmptyText,
  invoiceByGuid, salesHistoryInvoices, invoiceSyncLagMinutes, invoiceIdentityWarning
} = sandbox;

// ===== البيانات: نسخة مصغّرة أمينة لشكل تقارير الإنتاج وقت العطل =====

const CUST_GUID = "500d8ef6-3563-48a3-b65b-713f0ee57e80";
const OLD_NAME = "لؤي زهية الضاحية";
const NEW_NAME = "لؤي خلوف المحترم / الضاحية";
const INV_GUID = "50a17f10-c36d-4030-9afb-660cc92ea1b7";

const invoice4670 = {
  number: "634", date: "2026-09-05", guid: INV_GUID,
  total: 4670, discount: 0, payment: 0, isReturn: false,
  lines: [{ material: "دخان", qty: 10, price: 467, lineTotal: 4670, unit1: "علبة", unit2: "كرتونة" }]
};
const invoice13460 = {
  number: "614", date: "2026-09-03", guid: "5af2efa5-cf31-4f7e-a2ec-bdbc7efb1bc2",
  total: 13460, discount: 0, payment: 0, isReturn: false,
  lines: [{ material: "دخان", qty: 30, price: 448.67, lineTotal: 13460, unit1: "علبة", unit2: "كرتونة" }]
};
// فاتورة قديمة بقيت في الأمين تحت **نصّ الاسم القديم** على رأسها بعد إعادة
// التسمية — الحالة الحيّة في تقرير الإنتاج 2026-09-05 10:53 (الفاتورة 584).
const invoice1020 = {
  number: "584", date: "2026-09-01", guid: "8ca5210f-6e16-4e54-9990-816110a2fc25",
  total: 1020, discount: 0, payment: 0, isReturn: false,
  lines: [{ material: "دخان", qty: 2, price: 510, lineTotal: 1020, unit1: "علبة", unit2: "كرتونة" }]
};
// زبون آخر لا علاقة له — يحرس ضد تبنٍّ عشوائي للفواتير اليتيمة.
const decoyInvoice = {
  number: "550", date: "2026-08-27", guid: "46cf6c59-159a-4f95-896d-e35dc38767cc",
  total: 4660.5, discount: 0, payment: 0, isReturn: false, lines: []
};

const ledgerMovements = [
  { date: "2026-09-01", debit: 1020, credit: 0, billGuid: "00000000-0000-0000-0000-000000000000", balance: 1020, balanceChrono: 1020, docNew: 1020, docPrev: 0 },
  { date: "2026-09-01", debit: 0, credit: 1020, billGuid: "00000000-0000-0000-0000-000000000000", balance: 0, balanceChrono: 0, docNew: 0, docPrev: 1020 },
  { date: "2026-09-03", debit: 13460, credit: 0, billGuid: "00000000-0000-0000-0000-000000000000", balance: 13460, balanceChrono: 3460, docNew: 3460, docPrev: -10000 },
  { date: "2026-09-03", debit: 0, credit: 10000, billGuid: "00000000-0000-0000-0000-000000000000", balance: 3460, balanceChrono: -10000, docNew: -10000, docPrev: 0 },
  { date: "2026-09-05", debit: 4670, credit: 0, billGuid: "00000000-0000-0000-0000-000000000000", balance: 8130, balanceChrono: 8130, docNew: 8130, docPrev: 3460 }
];

function balancesReport(name, syncedAt) {
  return {
    summary: { syncedAt },
    items: [
      { name, key: "لؤي خلوف المحترم الضاحيه", customerGuid: CUST_GUID, balance: 8130 },
      { name: "مركز زينو كفر بطنا", key: "مركز زينو كفر بطنا", customerGuid: "aaaaaaaa-0000-0000-0000-000000000001", balance: 4660.5 },
      { name: "مركز لؤي زملكا", key: "مركز لؤي زملكا", customerGuid: "aaaaaaaa-0000-0000-0000-000000000002", balance: 0 }
    ]
  };
}

function movementsReport(name) {
  return {
    summary: { syncedAt: "2026-09-05T10:56:00.000Z" },
    items: [
      { name, customerGuid: CUST_GUID, movements: ledgerMovements, openingBalance: 0, closingBalance: 8130 },
      { name: "مركز زينو كفر بطنا", customerGuid: "aaaaaaaa-0000-0000-0000-000000000001",
        movements: [{ date: "2026-08-27", debit: 4660.5, credit: 0, billGuid: "00000000-0000-0000-0000-000000000000", balance: 4660.5, balanceChrono: 4660.5 }],
        openingBalance: 0, closingBalance: 4660.5 }
    ]
  };
}

// تقرير الفواتير بلا معرّف زبون — وهو حال الإنتاج قبل تحديث push-customer-invoices.ps1.
function invoicesReportByName(customerName, syncedAt) {
  return {
    summary: { periodDays: 60, syncedAt },
    items: [
      { name: customerName, invoices: [invoice4670, invoice13460], truncated: false },
      { name: "مركز زينو كفر بطنا", invoices: [decoyInvoice], truncated: false }
    ]
  };
}

// تقرير الفواتير بعد تحديث المزامنة — يحمل معرّف الحساب.
function invoicesReportByGuid(customerName, syncedAt) {
  const report = invoicesReportByName(customerName, syncedAt);
  report.items[0].customerGuid = CUST_GUID;
  report.items[1].customerGuid = "aaaaaaaa-0000-0000-0000-000000000001";
  return report;
}

const selected = () => state.customerBalanceReports[0].items[0];

// ===== 1) نافذة إعادة التسمية: الاسم القديم في الفواتير، الجديد في الأرصدة =====

function enterRenameWindow() {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T10:58:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = invoicesReportByName(OLD_NAME, "2026-09-05T09:53:00.000Z");
}

test("قائمة الفواتير تعرض الفاتورة 4670 أثناء نافذة إعادة التسمية", () => {
  enterRenameWindow();
  const listed = salesHistoryInvoices().find((inv) => inv.guid === INV_GUID);
  assert.ok(listed, "الفاتورة 4670 غائبة عن قائمة الفواتير — العطل انقلب");
  assert.equal(listed.total, 4670);
});

// أثناء النافذة وبلا معرّف، لا سبيل **صحيحاً** لربط الفاتورة بالزبون. المطلوب
// إذن ليس إظهارها بالتخمين بل ألّا تغيب صامتةً: رسالة تشرح، وتحذير يسمّي
// المجموعة اليتيمة. الحلّ الحقيقي في المصدر (تجميع المزامنة بالمعرّف).
test("نافذة إعادة التسمية: لا تخمين، ولا صمت", () => {
  enterRenameWindow();
  const invoices = customerInvoicesFor(selected());
  assert.equal(invoices.length, 0, "نُسبت فواتير بالتخمين");
  const warn = invoiceIdentityWarning();
  assert.ok(warn && warn.includes(OLD_NAME), `الغياب مرّ بلا تفسير: ${warn}`);
  const text = customerInvoicesEmptyText(selected());
  assert.ok(text && text.length > 0, "رسالة الغياب فارغة");
});

test("زر PDF يجد الفاتورة بمعرّفها بغضّ النظر عن اسم الزبون", () => {
  enterRenameWindow();
  const found = invoiceByGuid(INV_GUID);
  assert.ok(found, "البحث بمعرّف الفاتورة فشل");
  assert.equal(found.invoice.total, 4670);
  assert.equal(found.invoice.lines.length, 1, "الفاتورة المصدَّرة يجب أن تحمل أصنافها");
});

test("لا تُسحب فواتير زبون آخر إلى هذا الزبون", () => {
  enterRenameWindow();
  const invoices = customerInvoicesFor(selected());
  assert.ok(
    !invoices.some((inv) => inv.guid === decoyInvoice.guid),
    "فاتورة زبون آخر نُسبت لهذا الزبون"
  );
});

test("زر PDF يظل يجد الفاتورة بمعرّفها حتى داخل مجموعة يتيمة", () => {
  splitReportState();
  const found = invoiceByGuid(invoice1020.guid);
  assert.ok(found, "البحث بمعرّف الفاتورة فشل داخل مجموعة يتيمة");
  assert.equal(found.invoice.total, 1020);
  assert.equal(found.entry.name, OLD_NAME, "المجموعة المُعادة ليست اليتيمة");
});

// ===== 1b) الانشطار على اسمين: لا تخمين، ولا صمت =====
//
// حالة الإنتاج القائمة: نصّ الاسم على رأس الفاتورة يُحدَّث لبعض الفواتير دون بعض،
// فتبقى فاتورة قديمة تحت الاسم القديم. **لا تُنسب** لأحد بلا معرّف — نسبتها
// بمطابقة الدفتر (تاريخ+مبلغ) كانت ملاحظة P1 من Codex، وثبتت صحتها بالقياس على
// الإنتاج: 12 من 864 زوج (تاريخ، مبلغ مدين) يتشاركه أكثر من زبون. والبديل عن
// التخمين ليس الصمت، بل تحذير صريح لا ينسب شيئاً لأحد.

function splitReportState() {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = {
    summary: { periodDays: 60, syncedAt: "2026-09-05T10:53:00.000Z" },
    items: [
      { name: NEW_NAME, invoices: [invoice4670, invoice13460], truncated: false },
      { name: OLD_NAME, invoices: [invoice1020], truncated: false },
      { name: "مركز زينو كفر بطنا", invoices: [decoyInvoice], truncated: false }
    ]
  };
}

test("فاتورة تحت اسم قديم لا تُنسب لأي زبون بلا معرّف (P1)", () => {
  splitReportState();
  const invoices = customerInvoicesFor(selected());
  assert.ok(
    !invoices.some((inv) => inv.guid === invoice1020.guid),
    "نُسبت فاتورة إلى زبون بالتخمين — هذا ما منعته ملاحظة P1"
  );
  assert.equal(invoices.length, 2, "مجموعة الهوية وحدها لا غير");
});

test("الانشطار لا يمرّ صامتاً: تحذير صريح بلا نسبة لأحد", () => {
  splitReportState();
  const warn = invoiceIdentityWarning();
  assert.ok(warn, "لا تحذير رغم وجود مجموعة يتيمة — هذا فشل صامت");
  assert.ok(warn.includes(OLD_NAME), `التحذير لا يسمّي المجموعة اليتيمة: ${warn}`);
  assert.ok(
    !warn.includes(NEW_NAME),
    `التحذير ينسب المجموعة إلى زبون بعينه — ممنوع: ${warn}`
  );
});

test("لا تحذير حين يحمل التقرير معرّف الحساب (الحلّ الجذري وصل)", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = invoicesReportByGuid(NEW_NAME, "2026-09-05T10:59:00.000Z");
  assert.equal(invoiceIdentityWarning(), "");
});

test("لا تحذير حين لا توجد مجموعات يتيمة", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = invoicesReportByName(NEW_NAME, "2026-09-05T10:59:00.000Z");
  assert.equal(invoiceIdentityWarning(), "");
});

test("دفتر زبون آخر يطابق صدفةً لا يجرّ إليه الفاتورة", () => {
  // الحالة التي وصفتها P1 بالضبط: دفتر المالك الحقيقي غائب عن اللقطة (تأخّر
  // مزامنة الحركات أو اقتطاعها)، وزبون آخر يحمل قيداً بنفس التاريخ والمبلغ.
  state.customerBalanceReports = [{
    summary: { syncedAt: "2026-09-05T11:00:00.000Z" },
    items: [
      { name: NEW_NAME, key: "a", customerGuid: CUST_GUID, balance: 1020 },
      { name: "زبون مصادفة", key: "b", customerGuid: "bbbbbbbb-0000-0000-0000-000000000003", balance: 1020 }
    ]
  }];
  state.customerMovementsReport = {
    summary: { syncedAt: "2026-09-05T10:56:00.000Z" },
    items: [
      // المالك الحقيقي غائب عمداً
      { name: "زبون مصادفة", customerGuid: "bbbbbbbb-0000-0000-0000-000000000003",
        movements: [{ date: "2026-09-01", debit: 1020, credit: 0, balance: 1020, balanceChrono: 1020 }] }
    ]
  };
  state.customerInvoicesReport = {
    summary: { periodDays: 60, syncedAt: "2026-09-05T10:53:00.000Z" },
    items: [{ name: OLD_NAME, invoices: [invoice1020], truncated: false }]
  };
  const victim = state.customerBalanceReports[0].items[1];
  assert.equal(
    customerInvoicesFor(victim).length, 0,
    "فاتورة زبون آخر ظهرت في كشف زبون المصادفة — وهذا عين ما حذّرت منه P1"
  );
});

// ===== 2) بعد وصول مزامنة تحمل المعرّف: الربط بالمعرّف لا بالاسم =====

test("المعرّف يُقدَّم على الاسم: اسم قديم في التقرير والمعرّف صحيح", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = invoicesReportByGuid(OLD_NAME, "2026-09-05T10:59:00.000Z");
  const invoices = customerInvoicesFor(selected());
  assert.equal(invoices.length, 2);
  assert.ok(invoices.some((inv) => inv.guid === INV_GUID));
});

test("الاسم وحده يكفي حين يتطابق الاسمان (تقارير قديمة بلا معرّف)", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = invoicesReportByName(NEW_NAME, "2026-09-05T10:59:00.000Z");
  const invoices = customerInvoicesFor(selected());
  assert.equal(invoices.length, 2, "الفواتير القديمة يجب أن تبقى تعمل");
});

test("تمرير الاسم نصّاً يبقى مدعوماً (توافق مع المسارات القديمة)", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = invoicesReportByName(NEW_NAME, "2026-09-05T10:59:00.000Z");
  const invoices = customerInvoicesFor(NEW_NAME);
  assert.equal(invoices.length, 2, "المطابقة بالاسم النصّي انكسرت");
  assert.ok(invoices.some((inv) => inv.guid === INV_GUID));
});

// ===== 3) لا فشل صامت: تأخّر المزامنة يُقال صراحةً =====

test("فاتورة لم تدخل مزامنة التفاصيل بعد ⇒ رسالة تأخّر لا «لا توجد فواتير»", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T10:58:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  // التقرير وصل لكنه أقدم بساعة ولا يحوي هذا الزبون إطلاقاً.
  state.customerInvoicesReport = {
    summary: { periodDays: 60, syncedAt: "2026-09-05T09:53:00.000Z" },
    items: [{ name: "زبون آخر تماماً", invoices: [], truncated: false }]
  };
  const status = customerInvoicesStatus(selected());
  assert.equal(status.status, "stale");
  assert.equal(status.lag, 65, "فارق المزامنة يجب أن يُحسب بالدقائق فعلياً");
  const text = customerInvoicesEmptyText(selected());
  assert.ok(text.includes("65"), `الرسالة لا تذكر مقدار التأخّر: ${text}`);
  assert.ok(!text.includes("لا توجد فواتير"), `الرسالة تخفي سبب الغياب: ${text}`);
});

test("مزامنة حديثة وزبون بلا فواتير ⇒ الرسالة الصريحة الصحيحة", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = {
    summary: { periodDays: 60, syncedAt: "2026-09-05T11:00:00.000Z" },
    items: [{ name: "زبون آخر تماماً", invoices: [], truncated: false }]
  };
  const status = customerInvoicesStatus(selected());
  assert.equal(status.status, "none_in_window");
  assert.ok(customerInvoicesEmptyText(selected()).includes("60 يوماً"));
});

test("لا تقرير فواتير إطلاقاً ⇒ رسالة «لم تصل المزامنة»", () => {
  state.customerBalanceReports = [balancesReport(NEW_NAME, "2026-09-05T11:00:00.000Z")];
  state.customerMovementsReport = movementsReport(NEW_NAME);
  state.customerInvoicesReport = null;
  assert.equal(customerInvoicesStatus(selected()).status, "no_report");
  assert.ok(customerInvoicesEmptyText(selected()).includes("لم تصل"));
});

// ===== 4) حراسة المعرّف الصفري =====

test("المعرّف الصفري لا يُعامل معرّفاً صالحاً", () => {
  enterRenameWindow();
  assert.equal(invoiceByGuid("00000000-0000-0000-0000-000000000000"), null);
  assert.equal(invoiceByGuid(""), null);
  assert.equal(invoiceByGuid(null), null);
});

test("فارق المزامنة لا يُختلق حين يتعذّر حسابه", () => {
  state.customerBalanceReports = [];
  state.customerMovementsReport = null;
  state.customerInvoicesReport = invoicesReportByName(NEW_NAME, "2026-09-05T09:53:00.000Z");
  assert.equal(invoiceSyncLagMinutes(), null);
});

// ===== النتيجة =====

console.log("فحص هوية فواتير الزبائن:");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n❌ فشل ${failed} اختباراً.`);
  process.exit(1);
}
console.log(`\n✅ اجتاز ${results.length} اختباراً.`);
