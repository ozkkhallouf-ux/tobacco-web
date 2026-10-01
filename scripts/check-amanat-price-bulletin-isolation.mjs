// ============================================================================
// فحص انحداري: كميات «مستودع الامانة» لا تتسرّب إلى نشرة الأسعار.
//
// قرار عمر (2026-10-01): محتويات مستودع الامانة (GUID CA3BACBB-…) منفصلة تماماً عن
// نشرة الأسعار. لا تدخل كمياته في مخزون النشرة ولا توفّر الأصناف ولا ترتيبها ولا
// تنبيهات النفاد، ولا تغيّر أسعارها. صنف موجود في الامانة وحدها غير متوفر في النشرة.
// صفحة الامانة (PR #293) للعرض والجرد المنفصل فقط.
//
// مسار مخزون النشرة الوحيد الذي يُفحص هنا من أوله لآخره:
//   tools/ameen-stock-query.sql (يستبعد الامانة منذ PR #292)
//     → ameen-sync-agent.ps1: Build-InventoryReport → Sync-PriceListStockOnFullUnitChange
//     → approved_price_items.stock_qty
//     → available_price_sync_feed (stock_qty > 0)
//     → scripts/generate-price-lists.mjs (شرط الجملة والمفرق)
// وتنبيهات النفاد/الانخفاض وأمر «شو ناقص» تقرأ approved_price_items نفسه.
//
// الحالات:
//   CASE 1: رئيسي 10 + امانة 25            ⇒ النشرة 10
//   CASE 2: رئيسي 0 + امانة 25             ⇒ غير متوفر في النشرة
//   CASE 3: رئيسي 12 + آخر 8 + امانة 30    ⇒ النشرة 20
// وحارس بنيوي يمنع أي كاتب أو قارئ لمخزون النشرة من قراءة تقارير المستودعات.
//
// كل الأسماء والكميات والمعرّفات مصطنعة، عدا GUID مستودع الامانة نفسه.
// Postgres: PGHOST إن ضُبط، وإلا `sudo -n -u postgres psql`. محلياً بلا Postgres
// يُتخطّى الجزء السلوكي برسالة صريحة؛ في CI غيابه فشل.
// ============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const AMANAT_GUID = "CA3BACBB-87FE-4826-B051-CAC335CDB670";
const TEST_DB = "ozk_amanat_price_bulletin_test";
// أي ذكر لتقارير المستودعات أو للامانة داخل مسار مخزون النشرة تسرّب محتمل
const WAREHOUSE_REF = /ameen_warehouse_stock|WarehouseStockReport|reconWarehouseStock|push-ameen-warehouse-stock|amanat|CA3BACBB|امانة|أمانة/i;

let failed = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${message}`);
  }
}
const read = (path) => readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

console.log("check-amanat-price-bulletin-isolation:");

// ── 1) استبعاد PR #292 باقٍ في مصدر النشرة الوحيد ───────────────────────────
const stockSql = read("tools/ameen-stock-query.sql");
check(stockSql.includes(`'${AMANAT_GUID}' as StoreGUID`),
  "ameen-stock-query.sql: استبعاد الامانة بالـGUID (PR #292) ما زال قائماً");

// ── 2) وكيل المزامنة: مخزون النشرة من ameen-stock-query.sql وحده ─────────────
const agent = read("tools/ameen-sync-agent.ps1");
check(/\[string\]\$StockQueryPath = "\.\\tools\\ameen-stock-query\.sql"/.test(agent),
  "ameen-sync-agent.ps1: مسار الاستعلام الافتراضي tools/ameen-stock-query.sql");
check(/\$query = Get-Content -Raw -LiteralPath \$StockQueryPath\n\s*\$rows = Invoke-SqlRows[^\n]*-Query \$query\n\s*\$report = Build-InventoryReport -Rows \$rows/.test(agent),
  "ameen-sync-agent.ps1: التقرير يُبنى من نتيجة ذلك الاستعلام مباشرة");
check(/Sync-PriceListStockOnFullUnitChange [^\n]*-Report \$report\b/.test(agent),
  "ameen-sync-agent.ps1: مزامنة مخزون النشرة تأخذ ذلك التقرير نفسه");
const syncFn = agent.match(/function Sync-PriceListStockOnFullUnitChange\([\s\S]*?\n\}\n/)?.[0] || "";
check(/foreach \(\$item in \$Report\.Items\)/.test(syncFn) && /\$newQty = To-Number \$entry\.Qty/.test(syncFn)
  && /Qty = \(To-Number \$item\.stockQty\)/.test(syncFn),
  "Sync-PriceListStockOnFullUnitChange: stock_qty = مجموع stockQty أصناف التقرير الرئيسي فقط");
check(/if \(\$qty -le 0\) \{\n\s*\$status = "out"/.test(agent),
  "Build-InventoryReport: الكمية الرئيسية 0 ⇒ الحالة out (غير متوفر)");
check(!WAREHOUSE_REF.test(agent), "ameen-sync-agent.ps1: لا يذكر تقارير المستودعات ولا الامانة إطلاقاً");

// كاتب stock_qty الوحيد بين سكربتات Windows، ولا SQL يكتب على approved_price_items
const psWriters = readdirSync("tools").filter((f) => f.endsWith(".ps1") && /stock_qty\s*=/.test(read(`tools/${f}`)));
check(psWriters.length === 1 && psWriters[0] === "ameen-sync-agent.ps1",
  `كاتب approved_price_items.stock_qty الوحيد في tools/ هو ameen-sync-agent.ps1 (${psWriters.join(", ")})`);
const sqlFiles = [
  ...readdirSync("supabase").filter((f) => f.endsWith(".sql")).map((f) => `supabase/${f}`),
  ...readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => `supabase/migrations/${f}`)
];
const sqlWriters = sqlFiles.filter((f) => /(update|insert into)\s+(public\.)?approved_price_items\b/i.test(read(f)));
check(sqlWriters.length === 0, `لا SQL في supabase/ يكتب على approved_price_items (${sqlWriters.join(", ")})`);

// ── 3) قرّاء مخزون النشرة والتنبيهات لا يقرؤون تقارير المستودعات ──────────────
for (const path of [
  "scripts/generate-price-lists.mjs",
  "tools/pull-approved-prices.ps1",
  "tools/sync-approved-prices-to-ameen.ps1",
  "supabase/available-price-sync-feed.sql",
  "supabase/approved-prices-table.sql",
  "supabase/migrations/20260929235655_price_feeds_security_invoker.sql",
  "supabase/telegram-notifications.sql",
  "supabase/bot-health-alerts.sql",
  "supabase/functions/telegram-webhook/index.ts"
]) {
  check(!WAREHOUSE_REF.test(read(path)), `${path}: لا يذكر تقارير المستودعات ولا الامانة`);
}
const feedWhere = /where coalesce\((prices|p)\.stock_qty, 0\) > 0/;
check(feedWhere.test(read("supabase/available-price-sync-feed.sql"))
  && feedWhere.test(read("supabase/migrations/20260929235655_price_feeds_security_invoker.sql")),
  "available_price_sync_feed (الملف المرجعي وهجرة الإنتاج): التوفر = approved_price_items.stock_qty > 0 فقط");
const generator = read("scripts/generate-price-lists.mjs");
const generatorSources = [...generator.matchAll(/\/rest\/v1\/(\w+)/g)].map((m) => m[1]).sort();
check(JSON.stringify(generatorSources) === JSON.stringify(["available_price_sync_feed", "bulletin_exchange_rate"]),
  `generate-price-lists.mjs: الأصناف ومخزونها من available_price_sync_feed وحده، وسعر الصرف من bulletin_exchange_rate (${generatorSources.join(", ")})`);

// ── 4) الواجهة: حفظ الأسعار من الجرد الحي، وتقارير المستودعات للعرض فقط ───────
const appJs = read("src/app.js");
const topLevel = new Map();
for (const m of appJs.matchAll(/^(?:async )?function (\w+)\([^)]*\) \{\n[\s\S]*?\n\}\n/gm)) topLevel.set(m[1], m[0]);
const writers = [...topLevel].filter(([, src]) => /upsertApprovedPriceItems|replaceApprovedPriceItems/.test(src)).map(([n]) => n);
check(writers.length >= 2 && writers.includes("savePricingItem") && writers.includes("importLivePriceList"),
  `استُخرجت دوال حفظ الأسعار (${writers.join(", ")})`);
for (const name of writers) {
  const src = topLevel.get(name);
  check(!WAREHOUSE_REF.test(src), `${name}: لا يقرأ تقارير المستودعات ولا الامانة`);
}
for (const name of ["savePricingItem", "importLivePriceList"]) {
  check(/const latest = latestStockReport\(\);/.test(topLevel.get(name) || ""),
    `${name}: stockQty من latestStockReport() (inventory_reports المستبعِد للامانة)`);
}
const READERS_ALLOWED = ["loadReconWarehouses", "loadReconWarehouseStock", "loadWarehouseDashboard", "loadAmanatWarehouseSheet"];
const readers = [...topLevel].filter(([, src]) => /getLatestWarehouseStockReport|listLatestWarehouseStockReports|listReconWarehouses\(/.test(src)).map(([n]) => n);
check(readers.length > 0 && readers.every((n) => READERS_ALLOWED.includes(n)),
  `قرّاء تقارير المستودعات محصورون بالجرد والعرض وصفحة الامانة (${readers.join(", ")})`);
for (const name of readers) {
  check(!/ApprovedPriceItems|approvedPriceItems|approved_price/.test(topLevel.get(name)),
    `${name}: لا يكتب ولا يعدّل أسعار النشرة أو مخزونها`);
}

// ── 5) سلوكي: الاستعلام الحقيقي → approved_price_items → الـfeed → شرط المولّد ─
const usdRule = generator.match(/usdItems = latestEligibleRows\(\(row\) => \{([\s\S]*?)\n  \}, BULLETIN_CONFLICT_OVERRIDES\)/)?.[1];
const sypRule = generator.match(/sypItems = latestEligibleRows\(\(row\) =>\n([\s\S]*?)\n  \)\.map\(mapRow\)/)?.[1];
check(Boolean(usdRule && sypRule), "استُخرج شرطا الجملة والمفرق من generate-price-lists.mjs");
// eslint-disable-next-line no-new-func
const usdEligible = usdRule ? new Function("row", usdRule) : () => false;
// eslint-disable-next-line no-new-func
const sypEligible = sypRule ? new Function("row", `return (${sypRule});`) : () => false;

function psql(args, options = {}) {
  const viaTcp = Boolean(process.env.PGHOST);
  const command = viaTcp ? "psql" : "sudo";
  const argv = viaTcp ? args : ["-n", "-u", "postgres", "psql", ...args];
  return spawnSync(command, argv, { encoding: "utf8", ...options });
}
const out = (r) => `${r.stdout || ""}${r.stderr || ""}`;
const admin = (sql) => psql(["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql]);
function query(sql, { header = false } = {}) {
  const r = psql(["-d", TEST_DB, "-X", "-q", "-A", ...(header ? [] : ["-t"]), "-F", "|", "-P", "footer=off", "-v", "ON_ERROR_STOP=1"], { input: sql });
  if (r.status !== 0) throw new Error(out(r));
  return r.stdout.trim().split("\n").filter(Boolean).map((line) => line.split("|"));
}
const toPg = (sql) => sql.replace(/\bnvarchar\b/gi, "varchar").replace(/\bisnull\(/gi, "coalesce(");

const MAIN = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const mat = (n) => `C0000000-0000-0000-0000-00000000000${n}`;
const FACTOR = 10; // كرتونة = 10 كروز

const probe = psql(["-d", "postgres", "-tAc", "select 1"]);
if (probe.status !== 0) {
  if (process.env.CI === "true" || process.env.PGHOST) {
    check(false, `Postgres غير متاح في CI — لا يُسمح بالتخطّي: ${out(probe).trim()}`);
  } else {
    console.log("  ⚠️ Postgres غير متاح محلياً — تُخطّي الجزء السلوكي (الحراس البنيوية فُحصت)");
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
    line(1, 10, MAIN);          // CASE 1
    line(1, 25, AMANAT_GUID);
    line(2, 25, AMANAT_GUID);   // CASE 2 (بطاقة المادة mt.Qty = 25 كي يثبت أنه لا يسقط إليها)
    line(3, 12, MAIN);          // CASE 3
    line(3, 8, OTHER);
    line(3, 30, AMANAT_GUID);
    const mats = [[1, 0], [2, 25], [3, 0]]
      .map(([n, cardQty]) => `('${mat(n)}', ${n}, 'مادة اختبار ${n}', 'كروز', 'كرتونة', ${FACTOR}, null, ${cardQty})`)
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
    // ناتج الاستعلام الحقيقي، بالأعمدة بأسمائها لا بمواضعها
    const [head, ...body] = query(toPg(stockSql), { header: true });
    const col = (name) => head.indexOf(name);
    const stockRows = body.map((r) => ({ name: r[col("item_name")], stockQty: Number(r[col("stock_qty")]) }));
    check(col("item_name") >= 0 && col("stock_qty") >= 0, "ameen-stock-query.sql يعيد العمودين item_name وstock_qty");
    check(stockRows.length === 3, `ameen-stock-query.sql أعاد المواد الثلاث (${stockRows.length})`);

    // approved_price_items كما يكتبها Sync-PriceListStockOnFullUnitChange:
    // stock_qty = Σ stockQty من التقرير، stock_status = out عند ≤ 0. السعر ثابت ولا يمسّه المخزون.
    query(`
      create table public.approved_price_sync_feed (item_key text, item_name text, unit1_name text, unit2_name text,
        unit2_factor numeric, unit2_price numeric, retail_carton_usd numeric, updated_at timestamptz, bulletin_note text);
      create table public.approved_price_items (item_key text primary key, stock_qty numeric, stock_status text,
        source_synced_at timestamptz, unit2_price numeric);
      insert into public.approved_price_sync_feed
        select name, name, 'كروز', 'كرتونة', ${FACTOR}, 100, 15, now(), ''
        from (values ${stockRows.map((r) => `('${r.name}')`).join(", ")}) v(name);
      insert into public.approved_price_items values
        ${stockRows.map((r) => `('${r.name}', ${r.stockQty}, '${r.stockQty <= 0 ? "out" : "active"}', now(), 100)`).join(",\n        ")};
    `);
    const viewSql = read("supabase/available-price-sync-feed.sql")
      .replace(/^grant [^;]*;$/gm, "")
      .replace(/^comment on view[\s\S]*?;$/gm, "");
    query(viewSql);
    const feed = new Map(query(`
      select item_key, unit2_factor, unit2_price, retail_carton_usd, stock_qty
      from public.available_price_sync_feed order by item_key;
    `).map((r) => [r[0], { item_key: r[0], unit2_factor: r[1], unit2_price: r[2], retail_carton_usd: r[3], stock_qty: r[4] }]));
    const items = query("select item_key, stock_qty, stock_status, unit2_price from public.approved_price_items order by item_key;")
      .map((r) => ({ key: r[0], stockQty: Number(r[1]), status: r[2], price: Number(r[3]) }));
    const item = (n) => items.find((r) => r.key === `مادة اختبار ${n}`);
    const row = (n) => feed.get(`مادة اختبار ${n}`);

    check(item(1)?.stockQty === 10, `CASE 1: مخزون النشرة 10 لا 35 (${item(1)?.stockQty})`);
    check(Boolean(row(1)) && usdEligible(row(1)) && sypEligible(row(1)),
      "CASE 1: متوفر في نشرتي الجملة والمفرق على أساس 10 وحدها");
    check(item(2)?.stockQty === 0 && item(2)?.status === "out", `CASE 2: مخزون النشرة 0 والحالة out (${item(2)?.stockQty}/${item(2)?.status})`);
    check(!row(2), "CASE 2: صنف الامانة وحدها غائب عن available_price_sync_feed");
    check(!usdEligible({ unit2_price: 100, unit2_factor: FACTOR, stock_qty: item(2)?.stockQty })
      && !sypEligible({ retail_carton_usd: 15, stock_qty: item(2)?.stockQty }),
      "CASE 2: غير متوفر في الجملة ولا المفرق حتى لو تجاوز الـfeed");
    check(item(3)?.stockQty === 20 && Number(row(3)?.stock_qty) === 20, `CASE 3: مخزون النشرة 12 + 8 = 20 لا 50 (${item(3)?.stockQty})`);
    check(items.every((r) => r.price === 100), "الأسعار كما هي: المخزون لا يغيّر أي سعر");
    check(![...feed.values()].some((r) => [25, 30, 35, 50].includes(Number(r.stock_qty))),
      "لا كمية امانة (25/30) ولا مجموع معها (35/50) داخل الـfeed");
  } catch (error) {
    check(false, `تنفيذ المسار السلوكي: ${error.message}`);
  } finally {
    admin(`drop database if exists ${TEST_DB}`);
  }
}

if (failed) {
  console.error(`check-amanat-price-bulletin-isolation: فشل ${failed}`);
  process.exit(1);
}
console.log("check-amanat-price-bulletin-isolation: نشرة الأسعار لا تحمل أي كمية من مستودع الامانة.");
