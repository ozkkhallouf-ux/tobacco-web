// ============================================================================
// فحص انحداري: **مستودع الامانة مستبعد من تقرير المخزون بالكامل.**
//
// قرار عمر (2026-09-30): أي كمية في مستودع الامانة غير موجودة بالنسبة لتقرير
// المخزون — لا تدخل كمية الصنف ولا الإجمالي ولا الأصناف المتوفرة ولا القيمة.
// المطابقة بـGUID المستودع في dbo.st000 (CA3BACBB-…) لا بالاسم.
//
// المسارات التي تقرأ مخزوناً مجمَّعاً من الأمين:
//   • tools/ameen-stock-query.sql — مصدر inventory_reports (تقرير المخزون)
//     وapproved_price_items.stock_qty (النشرة، «شو ناقص»، تنبيهات النفاد)،
//     ويقرؤه أيضاً ameen-read-gateway.ps1 وverify-all.ps1.
//   • tools/push-item-details.ps1 — توزيع الصنف على المستودعات و«مجموع
//     المستودعات» في بطاقة الصنف.
//
// الفحص **يشغّل نص الاستعلامين الحقيقيين** على Postgres (بعد تحويل nvarchar
// إلى varchar وisnull إلى coalesce) فوق جداول dbo مصطنعة بنفس الأعمدة. كل الأسماء
// والكميات والمعرّفات مصطنعة، عدا GUID مستودع الامانة المستبعد نفسه.
//
// Postgres: PGHOST إن ضُبط (validate/pages في CI)، وإلا `sudo -n -u postgres psql`
// (وظيفة check). محلياً بلا Postgres تُفحص العقود النصية ويُتخطّى التنفيذ برسالة
// صريحة؛ في CI غيابه فشل.
// ============================================================================
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const AMANAT_GUID = "CA3BACBB-87FE-4826-B051-CAC335CDB670";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const TEST_DB = "ozk_inventory_excluded_stores_test";

let failed = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${message}`);
  }
}

console.log("check-inventory-excluded-stores:");

const stockSql = readFileSync("tools/ameen-stock-query.sql", "utf8").replace(/\r\n/g, "\n");
const detailsPs = readFileSync("tools/push-item-details.ps1", "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const detailsSql = detailsPs.match(/\$sql = @'\n([\s\S]*?)\n'@/)?.[1] || "";

// ── العقود النصية ───────────────────────────────────────────────────────────
const excludedCte = `select '${AMANAT_GUID}' as StoreGUID`;
const effectiveStoreJoin = `on xs.StoreGUID = coalesce(nullif(bi.StoreGUID, '${EMPTY_GUID}'), u.StoreGUID)`;
for (const [label, sql] of [["ameen-stock-query.sql", stockSql], ["push-item-details.ps1", detailsSql]]) {
  check(sql.includes(excludedCte), `${label}: مستودع الامانة معرَّف بـGUID في excluded_stores`);
  check(sql.includes(effectiveStoreJoin), `${label}: المطابقة على المستودع الفعلي للسطر (bi000 ثم رأس الفاتورة)`);
  const exclusionBlock = sql.slice(sql.indexOf("with excluded_stores"), sql.indexOf("group by bi.MatGUID, bi.StoreGUID"));
  check(exclusionBlock.length > 0 && !/Name|امان/.test(exclusionBlock.replace("-- مستودع الامانة — dbo.st000.GUID", "")),
    `${label}: الاستبعاد لا يعتمد على اسم المستودع`);
}
check(
  /when xs\.StoreGUID is not null then 0\s*\n\s*when bt\.bIsInput = 1/.test(stockSql),
  "ameen-stock-query.sql: سطر الأمانة يُصفَّر قبل أعلام الإدخال/الإخراج (لا يُحذف، كي لا يسقط الصنف إلى mt.Qty)"
);
check(/where xs\.StoreGUID is null\s*\n\s*group by/.test(detailsSql), "push-item-details.ps1: صفوف الأمانة لا تصل توزيع المستودعات");

// ── التنفيذ على Postgres ─────────────────────────────────────────────────────
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
// T-SQL → Postgres: نوع nvarchar ودالة isnull بمعاملين (= coalesce). بقية النص
// يُنفَّذ كما هو حرفياً.
const toPg = (sql) => sql.replace(/\bnvarchar\b/gi, "varchar").replace(/\bisnull\(/gi, "coalesce(");

const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    check(false, `Postgres غير متاح في CI — لا يُسمح بالتخطّي: ${out(probe).trim()}`);
  } else {
    console.log("  ⚠️ Postgres غير متاح محلياً — تُخطّي تنفيذ الاستعلامين (العقود النصية فُحصت)");
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
    // مستودعات ومواد وفواتير مصطنعة. GUIDs نصية بأحرف كبيرة كما يكتبها الأمين.
    const MAIN = "11111111-1111-1111-1111-111111111111";
    const OTHER = "22222222-2222-2222-2222-222222222222";
    const IN = "AAAAAAAA-0000-0000-0000-00000000000A";
    const OUT = "BBBBBBBB-0000-0000-0000-00000000000B";
    const mat = (n) => `C0000000-0000-0000-0000-00000000000${n}`;
    const bill = (n) => `D0000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`;
    const lines = [];
    const bills = [];
    let billNo = 0;
    const line = (matN, type, qty, lineStore, headerStore = lineStore) => {
      billNo += 1;
      bills.push(`('${bill(billNo)}', '${type}', ${headerStore === null ? "null" : `'${headerStore}'`})`);
      lines.push(`('${mat(matN)}', ${lineStore === null ? "null" : `'${lineStore}'`}, '${bill(billNo)}', ${qty})`);
    };
    // 1: الرئيسي 10 + الأمانة 25 ⇒ 10 لا 35 (مثال عمر)
    line(1, IN, 10, MAIN);
    line(1, IN, 25, AMANAT_GUID);
    // 2: موجود في الأمانة وحدها (25)، وبطاقة المادة mt.Qty = 25 ⇒ صفر، غير متوفر
    line(2, IN, 25, AMANAT_GUID);
    // 3: مناقلة من الرئيسي إلى الأمانة: وارد 30، مناقلة خارجة 5 ⇒ 25
    line(3, IN, 30, MAIN);
    line(3, OUT, 5, MAIN);
    line(3, IN, 5, AMANAT_GUID);
    // 4: سطر بلا مستودع ورأس فاتورته الأمانة (7) + الرئيسي 3 ⇒ 3
    line(4, IN, 7, null, AMANAT_GUID);
    line(4, IN, 3, MAIN);
    // 5: سطر بمستودع فارغ (GUID صفري) ورأسه الأمانة (9) ⇒ صفر
    line(5, IN, 9, EMPTY_GUID, AMANAT_GUID);
    // 6: ضابط — سالب في مستودع وموجب في آخر، بلا أمانة ⇒ الصافي 3 كما كان
    line(6, OUT, 5, MAIN);
    line(6, IN, 8, OTHER);
    // 7: بلا أي حركة ⇒ يبقى على mt.Qty كما كان (4)
    // 8: سالب في الأمانة (−6) + الرئيسي 2 ⇒ 2 (السالب لا يُطرح أيضاً)
    line(8, OUT, 6, AMANAT_GUID);
    line(8, IN, 2, MAIN);

    const mats = [[1, 0], [2, 25], [3, 0], [4, 0], [5, 0], [6, 0], [7, 4], [8, 0]]
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
      insert into dbo.bt000 values ('${IN}', 1, 0), ('${OUT}', 0, 1);
      insert into dbo.mt000 values ${mats};
      insert into dbo.bu000 values ${bills.join(", ")};
      insert into dbo.bi000 values ${lines.join(", ")};
    `);

    // ── تقرير المخزون: الاستعلام الحقيقي ─────────────────────────────────────
    const rows = query(toPg(stockSql));
    const byNumber = new Map(rows.map((r) => [r[0], { stockQty: Number(r[4]), qtyNet: Number(r[5]), positive: Number(r[6]) }]));
    const q = (n) => byNumber.get(String(n));
    check(rows.length === 8, `الاستعلام أعاد كل المواد الثماني (${rows.length})`);
    check(q(1).stockQty === 10 && q(1).qtyNet === 10 && q(1).positive === 10,
      `رئيسي 10 + أمانة 25 ⇒ stock_qty 10 لا 35 (الناتج ${q(1).stockQty}/${q(1).qtyNet}/${q(1).positive})`);
    check(q(2).stockQty === 0 && q(2).positive === 0,
      `صنف في الأمانة وحدها ⇒ رصيده صفر، ولا يسقط إلى mt.Qty = 25 (الناتج ${q(2).stockQty})`);
    check(q(3).stockQty === 25, `مناقلة 5 إلى الأمانة تخرج من المخزون ⇒ 25 (الناتج ${q(3).stockQty})`);
    check(q(4).stockQty === 3, `سطر بلا مستودع ورأسه الأمانة مستبعد ⇒ 3 (الناتج ${q(4).stockQty})`);
    check(q(5).stockQty === 0, `سطر بمستودع صفري ورأسه الأمانة مستبعد ⇒ 0 (الناتج ${q(5).stockQty})`);
    check(q(6).stockQty === 3 && q(6).positive === 8, `ضابط بلا أمانة لم يتغيّر: صافي 3 وموجب 8 (الناتج ${q(6).stockQty}/${q(6).positive})`);
    check(q(7).stockQty === 4, `صنف بلا حركات يبقى على mt.Qty كما كان (الناتج ${q(7).stockQty})`);
    check(q(8).stockQty === 2, `سالب الأمانة لا يُطرح من المخزون ⇒ 2 (الناتج ${q(8).stockQty})`);

    // التجميعات التي يبنيها ameen-sync-agent.ps1 من هذا الناتج:
    // availableItems = عدد stockQty > 0، والإجمالي مجموع stockQty.
    const all = [...byNumber.values()];
    const total = all.reduce((t, r) => t + r.stockQty, 0);
    const available = all.filter((r) => r.stockQty > 0).length;
    const price = 2; // سعر وحدة اختباري موحّد: قيمة المخزون = الكمية × السعر
    check(total === 10 + 0 + 25 + 3 + 0 + 3 + 4 + 2, `إجمالي المخزون يستثني كل كمية الأمانة (${total} = 47)`);
    check(available === 6, `الأصناف المتوفرة لا تعدّ صنف الأمانة وحدها ولا صنف الصفري (${available} = 6)`);
    check(total * price === 94, `قيمة المخزون لا تحمل أي كمية أمانة (${total * price} = 94)`);

    // ── بطاقة الصنف: توزيع المستودعات ────────────────────────────────────────
    const detailRows = query(toPg(detailsSql));
    const storesOf = (n) => detailRows.filter((r) => r[0] === String(n) && r[3]).map((r) => [r[3], Number(r[4])]);
    const amanatShown = detailRows.some((r) => r[3] === "مستودع الامانة");
    check(!amanatShown, "بطاقة الصنف لا تعرض مستودع الامانة لأي صنف");
    const s1 = storesOf(1);
    check(s1.length === 1 && s1[0][1] === 10, `بطاقة الصنف 1: الرئيسي 10 وحده، مجموع المستودعات 10 (${JSON.stringify(s1)})`);
    check(storesOf(2).length === 0, "بطاقة صنف الأمانة وحدها: لا مخزون موزّع على المستودعات");
  } catch (error) {
    check(false, `تنفيذ الاستعلامين: ${error.message}`);
  } finally {
    admin(`drop database if exists ${TEST_DB}`);
  }
}

if (failed) {
  console.error(`check-inventory-excluded-stores: فشل ${failed}`);
  process.exit(1);
}
console.log("check-inventory-excluded-stores: مستودع الامانة مستبعد من تقرير المخزون وبطاقة الصنف.");
