// ============================================================================
// فحص انحداري: صفحة/ورقة «مستودع الامانة» المستقلة داخل تقرير المخزون.
//
// قرار عمر (2026-10-01): مخزون الامانة منفصل 100% عن التقرير الرئيسي (PR #292
// يستبعده من ameen-stock-query.sql وpush-item-details.ps1)، ويُعرض فقط بصفحة PDF
// وورقة Excel مستقلتين باسم «مستودع الامانة»، مختاراً بالـGUID لا بالاسم.
//
// المسار الكامل الذي يُفحص هنا:
//   1) الاستعلامان الحقيقيان على Postgres فوق جداول dbo مصطنعة:
//      • tools/ameen-stock-query.sql            ← التقرير الرئيسي (inventory_reports)
//      • tools/push-ameen-warehouse-stock.ps1   ← تقرير كل مستودع (مصدر صفحة الامانة)
//   2) ناتجهما يمرّ على دوال الواجهة الحقيقية المستخرجة من src/app.js
//      (amanatWarehouseSheet وamanatSheetRows وinventoryWorkbookSheets
//      وamanatWarehousePageMarkup).
//
// الحالات الإلزامية:
//   CASE 1: رئيسي 10 + امانة 25            ⇒ الرئيسي 10، صفحة الامانة 25
//   CASE 2: رئيسي 0 + امانة 25             ⇒ الرئيسي 0،  صفحة الامانة 25
//   CASE 3: رئيسي 12 + آخر 8 + امانة 30    ⇒ الرئيسي 20، صفحة الامانة 30
// وحارس يمنع أي مسار رئيسي (إجمالي/بطاقات PDF/الورقة الرئيسية) من قراءة الامانة.
//
// كل الأسماء والكميات والمعرّفات مصطنعة، عدا GUID مستودع الامانة نفسه.
// Postgres: PGHOST إن ضُبط، وإلا `sudo -n -u postgres psql`. محلياً بلا Postgres
// تُفحص الدوال على بيانات مكافئة ويُتخطّى تنفيذ SQL برسالة صريحة؛ في CI غيابه فشل.
// ============================================================================
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const AMANAT_GUID = "CA3BACBB-87FE-4826-B051-CAC335CDB670";
const TEST_DB = "ozk_amanat_warehouse_page_test";

let failed = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${message}`);
  }
}

console.log("check-amanat-warehouse-page:");

const appJs = readFileSync("src/app.js", "utf8");
const stockSql = readFileSync("tools/ameen-stock-query.sql", "utf8").replace(/\r\n/g, "\n");
const warehousePs = readFileSync("tools/push-ameen-warehouse-stock.ps1", "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const warehouseSql = warehousePs.match(/\$sql = @'\n([\s\S]*?)\n'@/)?.[1] || "";
check(warehouseSql.includes("from dbo.st000 st"), "استُخرج استعلام push-ameen-warehouse-stock.ps1");

// ── دوال الواجهة الحقيقية ───────────────────────────────────────────────────
function grab(re, name) {
  const m = appJs.match(re);
  if (!m) {
    check(false, `تعذّر استخراج ${name} من src/app.js`);
    return "";
  }
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`), name);
const ENGINE = [
  grab(/const AMANAT_WAREHOUSE_GUID = "[^"]+";/, "AMANAT_WAREHOUSE_GUID"),
  grab(/const AMANAT_WAREHOUSE_TITLE = "[^"]+";/, "AMANAT_WAREHOUSE_TITLE"),
  grab(/const AMANAT_SHEET_HEADERS = \[[^\]]+\];/, "AMANAT_SHEET_HEADERS"),
  grab(/const PRIORITY_INVENTORY_GROUPS = \[[\s\S]*?\n\];/, "PRIORITY_INVENTORY_GROUPS"),
  grab(/const INVENTORY_GROUP_SEQUENCE = \[[\s\S]*?\n\];/, "INVENTORY_GROUP_SEQUENCE"),
  fnSrc("normalizeItemName"),
  fnSrc("inventoryGroupInfo"),
  fnSrc("isAmanatWarehouseKey"),
  fnSrc("amanatWarehouseSheet"),
  fnSrc("amanatSheetRows"),
  fnSrc("inventoryWorkbookSheets"),
  fnSrc("amanatWarehousePageMarkup"),
  fnSrc("pdfAr"),
  fnSrc("formatQtyCartons")
].join("\n");
if (failed) {
  console.error("check-amanat-warehouse-page: فشل الاستخراج");
  process.exit(1);
}
const sandbox = {
  escapeHtml: (v) => String(v == null ? "" : v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
  formatMoney: (v) => String(Number(v)),
  roundPrice: (v) => Math.round(Number(v) * 1000) / 1000,
  formatDateTime: (v) => String(v || ""),
  itemQty: (it) => Number(it?.stockQty || 0)
};
vm.createContext(sandbox);
vm.runInContext(`${ENGINE}
this.api = { isAmanatWarehouseKey, amanatWarehouseSheet, amanatSheetRows, inventoryWorkbookSheets, amanatWarehousePageMarkup, AMANAT_WAREHOUSE_TITLE };`, sandbox);
const api = sandbox.api;

// ── حارس بنيوي: لا مسار رئيسي يقرأ الامانة ──────────────────────────────────
check(api.isAmanatWarehouseKey(AMANAT_GUID.toLowerCase()) && !api.isAmanatWarehouseKey("مستودع الامانة"),
  "المطابقة بالـGUID (بلا حساسية لحالة الأحرف) لا بالاسم");
const pdfMarkupSrc = fnSrc("inventoryReportPdfMarkup");
const amanatRefs = pdfMarkupSrc.match(/amanat/gi) || [];
check(amanatRefs.length === 4 && /\$\{pagesMarkup\}\$\{amanatResult \? amanatWarehousePageMarkup\(amanatResult\) : ""\}<\/div>`;/.test(pdfMarkupSrc),
  "inventoryReportPdfMarkup: الامانة تُلحق بعد صفحات التقرير فقط، ولا تلمس البطاقات أو المجموعات أو الحالة");
check(/const allRaw = reportItems\(latestStockReport\(\)\);/.test(pdfMarkupSrc),
  "بطاقات PDF الرئيسية ما زالت محسوبة من inventory_reports وحده");
for (const name of ["latestStockReport", "reportItems", "liveAvailableItems", "ameen", "itemQty", "inventoryReportStatus"]) {
  const src = fnSrc(name);
  check(src && !/amanat|AMANAT|warehouseStockReport/i.test(src), `${name}: لا يقرأ تقارير المستودعات ولا الامانة`);
}
const callSites = appJs.match(/loadAmanatWarehouseSheet\(/g) || [];
check(callSites.length === 4, `loadAmanatWarehouseSheet: تعريف + 3 استدعاءات (PDF وورقتا Excel) فقط (${callSites.length})`);
for (const name of ["downloadLatestInventoryReport", "downloadFilteredInventoryReport"]) {
  const src = fnSrc(name);
  check(/writeInventoryWorkbook\(inventoryWorkbookSheets\(mainSheet, amanat\)/.test(src) && !/amanat[^)]*\]/.test(src.split("const mainSheet")[1]?.split("const amanat")[0] || "x"),
    `${name}: الورقة الرئيسية تُبنى من أصناف التقرير الرئيسي وحدها قبل جلب الامانة`);
}
check(!/stockQty|stock_qty/.test(fnSrc("amanatWarehouseSheet")),
  "amanatWarehouseSheet: لا تقرأ أي كمية من التقرير الرئيسي (المجموعة والوحدة فقط)");

// ── التحقق من الناتج: نفس الدوال على نتيجة الاستعلامين ──────────────────────
// mainRows: [{number, name, guid, stockQty}] من ameen-stock-query.sql
// warehouseRows: [{storeGuid, storeName, itemGuid, itemNumber, itemName, unit, qty}] من push-ameen-warehouse-stock.ps1
function verify(label, mainRows, warehouseRows) {
  const byNumber = new Map(mainRows.map((r) => [String(r.number), r]));
  const main = (n) => Number(byNumber.get(String(n))?.stockQty);
  check(main(1) === 10, `${label} CASE 1: التقرير الرئيسي = 10 لا 35 (${main(1)})`);
  check(main(2) === 0, `${label} CASE 2: التقرير الرئيسي = 0 لصنف الامانة وحدها (${main(2)})`);
  check(main(3) === 20, `${label} CASE 3: التقرير الرئيسي = 12 + 8 = 20 لا 50 (${main(3)})`);
  const mainTotal = mainRows.reduce((t, r) => t + Number(r.stockQty), 0);
  const mainAvailable = mainRows.filter((r) => Number(r.stockQty) > 0).length;
  check(mainTotal === 30, `${label}: إجمالي التقرير الرئيسي 30 بلا أي كمية امانة (${mainTotal})`);
  check(mainAvailable === 2, `${label}: الأصناف المتوفرة 2 (صنف الامانة وحدها غير متوفر) (${mainAvailable})`);

  // تقارير المستودعات بنفس الشكل الذي يرفعه push-ameen-warehouse-stock.ps1
  const reports = new Map();
  for (const r of warehouseRows) {
    if (!reports.has(r.storeGuid)) {
      reports.set(r.storeGuid, { summary: { source: "ameen_warehouse_stock", warehouseKey: r.storeGuid, warehouseName: r.storeName, generated_at: "2026-10-01T00:00:00Z" }, items: [] });
    }
    reports.get(r.storeGuid).items.push({ itemKey: r.itemName, itemGuid: r.itemGuid, itemNumber: r.itemNumber, itemName: r.itemName, unitName: r.unit, qty: Number(r.qty) });
  }
  const mainItems = mainRows.map((r) => ({ name: r.name, itemGuid: String(r.guid).toLowerCase(), groupName: "مجموعة اختبار", stockQty: Number(r.stockQty), unit2Name: "كرتونة", unit2Factor: 10 }));
  const sheet = api.amanatWarehouseSheet([...reports.values()], mainItems);
  const amanatQty = (n) => sheet?.items.find((it) => it.itemNumber === String(n))?.qty;
  check(Boolean(sheet), `${label}: تقرير الامانة اختير بالـGUID`);
  check(amanatQty(1) === 25, `${label} CASE 1: صفحة الامانة = 25 (${amanatQty(1)})`);
  check(amanatQty(2) === 25, `${label} CASE 2: صفحة الامانة = 25 (${amanatQty(2)})`);
  check(amanatQty(3) === 30, `${label} CASE 3: صفحة الامانة = 30 لا 50 (${amanatQty(3)})`);
  check(sheet?.items.length === 3, `${label}: صفحة الامانة لا تعرض إلا أصنافها (${sheet?.items.length})`);
  check(sheet?.items.every((it) => it.groupLabel === "مجموعة اختبار"), `${label}: المجموعة مأخوذة من التقرير الرئيسي بالـGUID`);
  // الامانة لا تعرض كمية المستودعات الأخرى أبداً
  check(!sheet?.items.some((it) => [10, 12, 8, 20, 35, 50, 55].includes(it.qty)), `${label}: لا كمية رئيسية أو مجموعة داخل صفحة الامانة`);

  // ورقتا Excel
  const mainSheet = { name: "live-inventory", rows: [["المادة", "الكمية"], ...mainRows.map((r) => [r.name, Number(r.stockQty)])] };
  const mainSnapshot = JSON.stringify(mainSheet);
  const sheets = api.inventoryWorkbookSheets(mainSheet, { sheet, error: "" });
  check(sheets.length === 2 && sheets[0] === mainSheet && JSON.stringify(sheets[0]) === mainSnapshot,
    `${label}: الورقة الرئيسية كما هي حرفياً بعد إضافة ورقة الامانة`);
  check(sheets[1].name === "مستودع الامانة", `${label}: ورقة مستقلة باسم «مستودع الامانة»`);
  const qtyCol = sheets[1].rows[0].indexOf("الكمية");
  const amanatSheetQty = (n) => sheets[1].rows.find((row) => row[0] === String(n))?.[qtyCol];
  check(amanatSheetQty(1) === 25 && amanatSheetQty(2) === 25 && amanatSheetQty(3) === 30,
    `${label}: ورقة Excel للامانة = 25/25/30`);
  const mainSheetTotal = sheets[0].rows.slice(1).reduce((t, row) => t + Number(row[1]), 0);
  check(mainSheetTotal === 30, `${label}: مجموع الورقة الرئيسية 30 بلا كمية امانة (${mainSheetTotal})`);

  // صفحة PDF
  const html = api.amanatWarehousePageMarkup({ sheet, error: "" });
  check(html.startsWith('<section class="inventory-page amanat-page">'), `${label}: قسم PDF مستقل يبدأ بصفحة جديدة`);
  check(/<h2>مستودع الامانة<\/h2>/.test(html), `${label}: عنوان «مستودع الامانة» أعلى الصفحة`);
  check(!/class="cards"|rcard/.test(html), `${label}: صفحة الامانة بلا بطاقات ملخص مشتركة`);
}

// حالات العرض الحدّية
const noReport = api.amanatSheetRows({ sheet: null, error: "" });
check(noReport.length === 1 && /لم يصل تقرير مستودع الامانة/.test(noReport[0][0]), "بلا تقرير امانة: رسالة صريحة لا صفر مخترع");
const empty = api.amanatWarehouseSheet([{ summary: { warehouseKey: AMANAT_GUID.toLowerCase(), warehouseName: "x" }, items: [{ itemName: "صنف", qty: 0 }] }], []);
check(empty && empty.items.length === 0 && /لا يوجد مخزون/.test(api.amanatSheetRows({ sheet: empty })[1][0]), "امانة فارغة: «لا يوجد مخزون» لا أسطر صفرية");
check(api.amanatWarehouseSheet([{ summary: { warehouseKey: "11111111-1111-1111-1111-111111111111", warehouseName: "مستودع الامانة" }, items: [{ itemName: "صنف", qty: 5 }] }], []) === null,
  "مستودع آخر يحمل الاسم نفسه لا يُعامل كامانة");

// ── Postgres ────────────────────────────────────────────────────────────────
function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  const command = viaTcp ? "psql" : "sudo";
  const argv = viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args];
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}
const out = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const admin = (sql) => psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]);
function query(sql) {
  const r = psql(["-d", TEST_DB, "-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1"], { input: sql });
  if (r.status !== 0) throw new Error(out(r));
  return r.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("|"));
}
const toPg = (sql) => sql.replace(/\bnvarchar\b/gi, "varchar").replace(/\bisnull\(/gi, "coalesce(");

const MAIN = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const mat = (n) => `C0000000-0000-0000-0000-00000000000${n}`;

const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    check(false, `Postgres غير متاح في CI — لا يُسمح بالتخطّي: ${out(probe).trim()}`);
  } else {
    console.log("  ⚠️ Postgres غير متاح محلياً — تُخطّي تنفيذ SQL، وتُفحص الدوال على بيانات مكافئة");
    verify("محاكاة", [
      { number: 1, name: "مادة اختبار 1", guid: mat(1), stockQty: 10 },
      { number: 2, name: "مادة اختبار 2", guid: mat(2), stockQty: 0 },
      { number: 3, name: "مادة اختبار 3", guid: mat(3), stockQty: 20 }
    ], [
      { storeGuid: AMANAT_GUID, storeName: "مستودع الامانة", itemGuid: mat(1), itemNumber: "1", itemName: "مادة اختبار 1", unit: "كروز", qty: 25 },
      { storeGuid: AMANAT_GUID, storeName: "مستودع الامانة", itemGuid: mat(2), itemNumber: "2", itemName: "مادة اختبار 2", unit: "كروز", qty: 25 },
      { storeGuid: AMANAT_GUID, storeName: "مستودع الامانة", itemGuid: mat(3), itemNumber: "3", itemName: "مادة اختبار 3", unit: "كروز", qty: 30 }
    ]);
  }
} else {
  runDbTests();
}

function runDbTests() {
  admin(`drop database if exists ${TEST_DB}`);
  const created = admin(`create database ${TEST_DB}`);
  if (created.status !== 0) {
    check(false, `إنشاء قاعدة الاختبار: ${out(created)}`);
    return;
  }
  try {
    const IN = "AAAAAAAA-0000-0000-0000-00000000000A";
    const bills = [];
    const lines = [];
    let billNo = 0;
    const line = (matN, qty, store) => {
      billNo += 1;
      const bill = `D0000000-0000-0000-0000-0000000000${String(billNo).padStart(2, "0")}`;
      bills.push(`('${bill}', '${IN}', '${store}')`);
      lines.push(`('${mat(matN)}', '${store}', '${bill}', ${qty})`);
    };
    // CASE 1
    line(1, 10, MAIN);
    line(1, 25, AMANAT_GUID);
    // CASE 2 (بطاقة المادة mt.Qty = 25 كي يثبت أنه لا يسقط إليها)
    line(2, 25, AMANAT_GUID);
    // CASE 3
    line(3, 12, MAIN);
    line(3, 8, OTHER);
    line(3, 30, AMANAT_GUID);
    const mats = [[1, 0], [2, 25], [3, 0]]
      .map(([n, cardQty]) => `('${mat(n)}', ${n}, 'مادة اختبار ${n}', 'كروز', 'كرتونة', 10, null, ${cardQty})`)
      .join(",\n");
    query(`
      create schema dbo;
      create table dbo.st000 (GUID text, Name text);
      create table dbo.gr000 (GUID text, Name text);
      create table dbo.mt000 (GUID text, Number int, Name text, Unity text, Unit2 text, Unit2Fact numeric, GroupGUID text, Qty numeric);
      create table dbo.bt000 (GUID text, bIsInput int, bIsOutput int);
      create table dbo.bu000 (GUID text, TypeGUID text, StoreGUID text);
      create table dbo.bi000 (MatGUID text, StoreGUID text, ParentGUID text, Qty numeric);
      insert into dbo.st000 values ('${MAIN}', 'مستودع اختبار رئيسي'), ('${OTHER}', 'مستودع اختبار ثان'), ('${AMANAT_GUID}', 'مستودع الامانة');
      insert into dbo.bt000 values ('${IN}', 1, 0);
      insert into dbo.mt000 values ${mats};
      insert into dbo.bu000 values ${bills.join(", ")};
      insert into dbo.bi000 values ${lines.join(", ")};
    `);
    const mainRows = query(toPg(stockSql)).map((r) => ({ number: r[0], name: r[1], guid: mat(Number(r[0])), stockQty: Number(r[4]) }));
    const warehouseRows = query(toPg(warehouseSql)).map((r) => ({
      storeGuid: r[0], storeName: r[1], itemGuid: r[2], itemNumber: r[3], itemName: r[4], unit: r[5], qty: Number(r[6])
    }));
    check(mainRows.length === 3, `ameen-stock-query.sql أعاد المواد الثلاث (${mainRows.length})`);
    check(warehouseRows.length === 9, `push-ameen-warehouse-stock.ps1 أعاد 3 مستودعات × 3 مواد (${warehouseRows.length})`);
    verify("SQL", mainRows, warehouseRows);
  } catch (error) {
    check(false, `تنفيذ الاستعلامين: ${error.message}`);
  } finally {
    admin(`drop database if exists ${TEST_DB}`);
  }
}

if (failed) {
  console.error(`check-amanat-warehouse-page: فشل ${failed}`);
  process.exit(1);
}
console.log("check-amanat-warehouse-page: صفحة مستودع الامانة مستقلة، والتقرير الرئيسي لا يحمل أي كمية منها.");
